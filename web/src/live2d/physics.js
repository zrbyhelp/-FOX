// Live2D-style secondary motion: damped angular followers ("pendulums") for the ears, the
// scarf flap and a 5-link tail chain. Inputs are weighted sums of puppet parameters (head /
// body angles, root motion), outputs are extra rotations (degrees, CCW positive) written back
// into the parameter table as Phys* entries. Fixed 120 Hz substeps, reset() on tab switches.
import { clamp } from './math2d.js';

const STEP = 1 / 120;
const MAX_STEPS = 24; // at most 0.2 s of simulation per frame

/** Damped spring follower: x'' = -k (x - target) - c x'  (c from the damping ratio). */
class Follower {
  constructor(freqHz, zeta) {
    this.set(freqHz, zeta);
    this.x = 0;
    this.v = 0;
  }

  set(freqHz, zeta) {
    const w = 2 * Math.PI * freqHz;
    this.k = w * w;
    this.c = 2 * zeta * w;
  }

  step(target, h) {
    this.v += (-this.k * (this.x - target) - this.c * this.v) * h;
    this.x += this.v * h;
  }

  reset(x) {
    this.x = x;
    this.v = 0;
  }
}

const ROOT_DRAG = 160; // deg of lag input per model unit of root travel
const TAIL_GAIN = [0.3, 0.5, 0.7, 0.88, 1.0]; // share of the tail angle each link takes

export class Physics {
  constructor() {
    this.ear = { L: new Follower(2.6, 0.22), R: new Follower(2.6, 0.22) };
    this.earTip = { L: new Follower(3.4, 0.25), R: new Follower(3.4, 0.25) };
    this.flap = new Follower(1.5, 0.12);
    this.tail = TAIL_GAIN.map((_, i) => new Follower(2.4 - i * 0.28, 0.3));
    this.acc = 0;
    this.primed = false;
    this.impulses = [];
    // tail drag override: absolute tail angle (deg) the user is pulling to, or null
    this.tailHold = null;
    this.tailHoldW = 0;
  }

  inputs(p) {
    const rootX = p.ParamRootX;
    const rootY = p.ParamRootY;
    const headZ = p.ParamAngleZ + p.ParamBodyAngleZ + p.ParamRootRot;
    const headX = p.ParamAngleX;
    return {
      earL: headZ - headX * 0.3 - rootX * ROOT_DRAG + rootY * 90 + p.ParamBodyAngleX * 0.6,
      earR: headZ - headX * 0.3 - rootX * ROOT_DRAG - rootY * 90 + p.ParamBodyAngleX * 0.6,
      // hanging: lags the other way round when the body moves
      flap: p.ParamBodyAngleZ + p.ParamRootRot + p.ParamAngleZ * 0.15 + rootX * ROOT_DRAG * 0.8 + p.ParamBodyAngleX * 0.8,
      // tail swing is in "towards +x" degrees; CCW math angles inside
      tail: -p.ParamTailSwing + p.ParamBodyAngleZ * 0.6 + p.ParamRootRot * 0.5 - rootX * ROOT_DRAG * 0.7 - p.ParamBodyAngleX * 1.2,
    };
  }

  reset(p) {
    const inp = this.inputs(p);
    this.ear.L.reset(inp.earL);
    this.ear.R.reset(inp.earR);
    this.earTip.L.reset(0);
    this.earTip.R.reset(0);
    this.flap.reset(inp.flap);
    for (const f of this.tail) f.reset(inp.tail);
    this.acc = 0;
    this.impulses.length = 0;
    this.primed = true;
    this.write(p, inp);
  }

  /** Kick an ear (flick): degrees per second added to its velocity. */
  kickEar(side, amount) {
    this.ear[side].v += amount;
    this.earTip[side].v += amount * 1.4;
  }

  kickTail(amount) {
    this.tail[0].v += amount;
  }

  step(p, dt) {
    const inp = this.inputs(p);
    if (!this.primed) this.reset(p);
    this.acc = Math.min(this.acc + dt, STEP * MAX_STEPS);
    // interpolate the inputs across the substeps (they were sampled once per frame)
    const prev = this.prevInp || inp;
    const n = Math.floor(this.acc / STEP);
    for (let i = 1; i <= n; i++) {
      const a = i / n;
      const L = prev.earL + (inp.earL - prev.earL) * a;
      const R = prev.earR + (inp.earR - prev.earR) * a;
      this.ear.L.step(L, STEP);
      this.ear.R.step(R, STEP);
      this.earTip.L.step(this.ear.L.x - L, STEP);
      this.earTip.R.step(this.ear.R.x - R, STEP);
      this.flap.step(prev.flap + (inp.flap - prev.flap) * a, STEP);
      let target = prev.tail + (inp.tail - prev.tail) * a;
      // dragging: pull towards the held swing angle (same frame as ParamTailSwing)
      if (this.tailHold != null) target += (-this.tailHold + (inp.tail + p.ParamTailSwing) - target) * this.tailHoldW;
      for (const f of this.tail) {
        f.step(target, STEP);
        target = f.x;
      }
    }
    this.acc -= n * STEP;
    this.prevInp = inp;
    this.write(p, inp);
  }

  write(p, inp) {
    const lim = (x, m) => clamp(x, -m, m);
    // ears: lag relative to the head (CCW deg); tips lag a little more
    p.PhysEarL = lim(this.ear.L.x - inp.earL, 40);
    p.PhysEarR = lim(this.ear.R.x - inp.earR, 40);
    p.PhysEarLTip = lim(this.earTip.L.x * 0.6, 30);
    p.PhysEarRTip = lim(this.earTip.R.x * 0.6, 30);
    // flap: relative to the scarf, mostly hanging straight down
    p.PhysFlap = lim(this.flap.x - inp.flap - 0.75 * (p.ParamBodyAngleZ + p.ParamRootRot), 50);
    // tail: CCW rotation of each link in body space (steady state = -ParamTailSwing * gain);
    // the frame terms (body angle, root drag) only show up as lag while they change
    const frame = inp.tail + p.ParamTailSwing;
    for (let i = 0; i < this.tail.length; i++) p[`PhysTail${i}`] = lim((this.tail[i].x - frame) * TAIL_GAIN[i], 80);
  }
}
