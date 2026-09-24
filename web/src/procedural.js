// Procedural layer applied after mixer.update(): look-at, blink, talking mouth, ear twitch,
// tail chain physics (with drag / flick), scarf springs, typing paws and keystroke nods.
//
// All offsets are applied as world-space rotations about each bone's pivot, so bone roll in the
// rig does not matter. The mixer only writes a bone when its animated value CHANGES, so before
// adding offsets we snapshot the animated values and put exactly those back before the next
// mixer update (never the rest pose: that would erase poses a clip is holding still). Nothing
// here ever accumulates from frame to frame.
import * as THREE from 'three';

const DEG = Math.PI / 180;
const YAW_MAX = 50 * DEG;
const PITCH_MAX = 25 * DEG;
const SUBSTEP = 1 / 120;
const MAX_STEPS = 12; // at most 0.1 s of physics per frame

// ---- tail chain -------------------------------------------------------------------------------
// tail_1 (base, stiff) .. tail_6 (tip, compliant). Each link has an angular deviation from the
// direction the clip gives it (a rotation vector kept perpendicular to the link, so lengths are
// exact and nothing twists). A link is sprung to its PARENT's deviation, so a disturbance at the
// base travels down the chain and whips the tip. The only drivers are the inertial (fictitious)
// forces of the hips frame - its linear and angular acceleration - so the clip's own tail
// animation is reproduced exactly while the body is still, and every hop, turn or landing adds
// follow-through on top. Gravity-free. Drag / idle sway are targets for the same springs.
const TAIL = ['tail_1', 'tail_2', 'tail_3', 'tail_4', 'tail_5', 'tail_6'];
const TAIL_OMEGA = [30, 24, 19, 15, 12, 10]; // rad/s natural frequency per joint
const TAIL_ZETA = [0.8, 0.6, 0.48, 0.4, 0.34, 0.3]; // damping ratio per joint
const TAIL_SOFT = [7, 10, 13, 16, 19, 22].map((d) => d * DEG); // soft bend limit per joint
const TAIL_HARD = 2.2; // x soft limit: fail-safe clamp for very long frames
const TAIL_INERTIA = 0.2; // gain on the inertial drive
const TAIL_DRIVE_HZ = 6; // low-pass on the hips' acceleration (keyframe kinks are not impacts)
const DRAG_SHARE = [0.04, 0.1, 0.16, 0.2, 0.23, 0.27]; // bend distribution while the tail is dragged
const DRAG_MAX = 60 * DEG;
const DRAG_GAIN = 1.6;
const FLICK = [0, 1.2, 2.6, 4, 5.2, 6.2]; // rad/s angular kick per link (hover flick)
const SWAY_AMP = [0.8, 1.3, 1.8, 2.3, 2.7, 3.1].map((d) => d * DEG); // idle travelling wave

// Typing fallback (no Type clip): lift the forearms towards the keyboard and tap.
const ARM_LIFT = { upperArm: -16 * DEG, forearm: -34 * DEG, paw: 14 * DEG };
const TAP = { forearm: 22 * DEG, paw: -12 * DEG };

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qc = new THREE.Quaternion(); // character (root) world rotation, valid for one update()
const _qi = new THREE.Quaternion();
const _up = new THREE.Vector3(); // character up axis, valid for one update()
const _axis = new THREE.Vector3();
const _rp = new THREE.Quaternion();
const _rpi = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

const smoothstep = (a, b, x) => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Exact critically damped step of x towards target (state {x, v}). */
function critDamp(s, target, omega, dt) {
  const d = s.x - target;
  const tmp = (s.v + omega * d) * dt;
  const e = Math.exp(-omega * dt);
  s.v = (s.v - omega * tmp) * e;
  s.x = target + (d + tmp) * e;
}

/** Damped 1D spring, integrated with fixed substeps (semi-implicit Euler). */
class Spring {
  constructor(omega, zeta) {
    this.omega = omega;
    this.zeta = zeta;
    this.x = 0;
    this.v = 0;
    this.target = 0;
  }
  step(h) {
    const a = this.omega * this.omega * (this.target - this.x) - 2 * this.zeta * this.omega * this.v;
    this.v += a * h;
    this.x += this.v * h;
  }
  reset() { this.x = this.v = this.target = 0; }
}

/** World angular velocity (axis * rad/s) between two world rotations. */
function angularVelocity(qPrev, qNow, dt, out) {
  _dq.copy(qPrev).invert().premultiply(qNow);
  if (_dq.w < 0) _dq.set(-_dq.x, -_dq.y, -_dq.z, -_dq.w); // shortest arc
  const s = Math.sqrt(Math.max(0, 1 - _dq.w * _dq.w));
  if (s < 1e-6) return out.set(0, 0, 0);
  const ang = 2 * Math.acos(Math.min(1, _dq.w));
  return out.set(_dq.x / s, _dq.y / s, _dq.z / s).multiplyScalar(ang / dt);
}

/** Rotate `bone` by the world-space rotation `qWorld` about its own pivot. */
function rotateWorld(bone, qWorld) {
  bone.parent.getWorldQuaternion(_rp);
  _rpi.copy(_rp).invert();
  // local' = (parent^-1 * R * parent) * local
  bone.quaternion.premultiply(_rpi.multiply(qWorld).multiply(_rp));
  bone.updateMatrixWorld(true);
}

/** Position / rotation of an object in the fox's model space, with finite-difference motion. */
class Kinematics {
  constructor() {
    this.valid = false;
    this.pos = new THREE.Vector3();
    this.q = new THREE.Quaternion();
    this.vel = new THREE.Vector3();
    this.omega = new THREE.Vector3();
    this.acc = new THREE.Vector3();
    this.alpha = new THREE.Vector3();
    this.frames = 0;
    this._p = new THREE.Vector3();
    this._w = new THREE.Vector3();
    this._vq = new THREE.Quaternion();
  }
  reset() { this.valid = false; }
  /** Returns false (and zero motion) on the first frame and after a teleport. */
  update(obj, modelInv, dt) {
    _m.multiplyMatrices(modelInv, obj.matrixWorld).decompose(this._p, this._vq, _s);
    if (!this.valid || dt < 1e-5 || this._p.distanceTo(this.pos) > 0.3) {
      this.valid = true;
      this.frames = 0;
      this.pos.copy(this._p);
      this.q.copy(this._vq);
      this.vel.set(0, 0, 0);
      this.omega.set(0, 0, 0);
      this.acc.set(0, 0, 0);
      this.alpha.set(0, 0, 0);
      return false;
    }
    const vel = _v3.copy(this._p).sub(this.pos).divideScalar(dt);
    const w = angularVelocity(this.q, this._vq, dt, this._w);
    if (this.frames > 0) {
      this.acc.copy(vel).sub(this.vel).divideScalar(dt).clampLength(0, 25);
      this.alpha.copy(w).sub(this.omega).divideScalar(dt).clampLength(0, 120);
    }
    this.frames++;
    this.vel.copy(vel);
    this.omega.copy(w);
    this.pos.copy(this._p);
    this.q.copy(this._vq);
    return true;
  }
}

export class Procedural {
  constructor(fox, { rng = Math.random } = {}) {
    this.fox = fox;
    this.b = fox.bones;
    this.rng = rng;
    this.enabled = true; // false in debug poses
    this.paused = false; // true while the fox is away (hidden)
    this.randomness = true; // blink / ear twitch timers

    // Everything we touch, with its rest transform (captured before any animation ran).
    const names = [
      'neck', 'head', 'ear_L', 'ear_R', 'eyeOpen_L', 'eyeOpen_R', 'mouthOpen', 'mouthSmile', 'scarfFlap_1', 'scarfFlap_2',
      'upperArm_L', 'upperArm_R', 'forearm_L', 'forearm_R', 'paw_L', 'paw_R', ...TAIL,
    ];
    this.rest = names.filter((n) => this.b[n]).map((n) => ({
      bone: this.b[n], q: this.b[n].quaternion.clone(), s: this.b[n].scale.clone(), p: this.b[n].position.clone(),
    }));

    // Bone-local directions that point character-forward (+Z) and character-left (+X) in the
    // rest pose, and the eye point, so nothing below depends on how bones are rolled in the rig.
    this.axes = {};
    for (const n of ['head', 'chest']) {
      const bone = this.b[n];
      if (!bone) continue;
      const inv = bone.getWorldQuaternion(new THREE.Quaternion()).invert();
      this.axes[n] = { fwd: new THREE.Vector3(0, 0, 1).applyQuaternion(inv), side: new THREE.Vector3(1, 0, 0).applyQuaternion(inv) };
    }
    const head = this.b.head;
    this.eyeLocal = head ? head.worldToLocal(head.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.15, 0.05))) : null;

    this.target = null; // Vector3 or null
    this.look = { yaw: { x: 0, v: 0 }, pitch: { x: 0, v: 0 }, w: { x: 0, v: 0 } };
    this.lookActive = false;

    this.blinkIn = 2 + rng() * 3;
    this.blinkT = -1;
    this.blinkDouble = false;

    // Talking (speech bubble): mouthOpen / mouthSmile toggled in a syllable rhythm.
    this.talk = false;
    this.talkEnv = { x: 0, v: 0 };
    this.syl = { t: 0, dur: 0.14, open: 0.55 };
    this.talkOpen = 0; // current mouth-open amount (for tests)

    this.ears = { L: [new Spring(22, 0.22), new Spring(18, 0.3)], R: [new Spring(22, 0.22), new Spring(18, 0.3)] };
    this.earIn = 3 + rng() * 5;
    this.flicks = 0; // explicit ear flicks (clicks), for tests

    this.flap = { swing: new Spring(10, 0.25), side: new Spring(9, 0.3) };
    this.nodSpring = new Spring(24, 0.5);
    this.taps = { L: new Spring(32, 0.45), R: new Spring(32, 0.45) };
    this.typing = false; // typing without a Type clip: lift + tap the paws procedurally
    this.typeArm = { x: 0, v: 0 };
    this.nods = 0;
    this.acc = 0;
    this.time = 0;
    this.prev = null; // previous head/chest transforms for velocity estimates

    this.initTail();

    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.reset(); });
  }

  // ---- bookkeeping ------------------------------------------------------------------------

  /** Snapshot the mixer's output for every bone we are about to offset. */
  capture() {
    for (const r of this.rest) {
      if (!r.anim) r.anim = { q: new THREE.Quaternion(), s: new THREE.Vector3(), p: new THREE.Vector3() };
      r.anim.q.copy(r.bone.quaternion);
      r.anim.s.copy(r.bone.scale);
      r.anim.p.copy(r.bone.position);
      r.captured = true;
    }
  }

  /** Undo last frame's offsets (back to the animated pose) before the mixer runs again. */
  restore() {
    for (const r of this.rest) {
      if (!r.captured) continue;
      r.bone.quaternion.copy(r.anim.q);
      r.bone.scale.copy(r.anim.s);
      r.bone.position.copy(r.anim.p);
      r.captured = false;
    }
  }

  reset() {
    this.restore(); // never leave offsets on bones the mixer might not rewrite
    this.acc = 0;
    this.prev = null;
    for (const s of [...this.ears.L, ...this.ears.R, this.flap.swing, this.flap.side, this.nodSpring, this.taps.L, this.taps.R]) s.reset();
    this.look.w.x = this.look.w.v = 0;
    this.lookActive = false;
    this.blinkT = -1;
    this.talkEnv.x = this.talkEnv.v = 0;
    this.resetTail();
  }

  setTarget(v) {
    this.target = v ? (this.target || new THREE.Vector3()).copy(v) : null;
  }

  flickEar(side) {
    const e = this.ears[side];
    if (!e) return;
    e[0].v += 9 + this.rng() * 3;
    e[1].v += 5;
    this.flicks++;
  }

  /** Small head nod (one keystroke). */
  nod(strength = 1) {
    this.nodSpring.v += 2.4 * strength;
    this.nods++;
  }

  /** Tap one paw down (typing fallback only). */
  tapPaw(side) {
    const s = this.taps[side];
    if (s) s.v += 20;
  }

  update(dt, layers) {
    if (!this.enabled) return;
    if (this.paused) {
      if (!this.wasPaused) this.reset(); // nothing left talking / swinging while away
      this.wasPaused = true;
      return;
    }
    if (this.wasPaused) {
      this.wasPaused = false;
      this.reset();
    }
    this.capture();
    dt = Math.min(dt, 0.1);
    this.time += dt;
    const { head, root } = this.b;
    const charRoot = root || head?.parent;
    if (!head || !charRoot) return;
    const charQ = charRoot.getWorldQuaternion(_qc);
    _up.set(0, 1, 0).applyQuaternion(charQ);

    this.acc = Math.min(this.acc + dt, MAX_STEPS * SUBSTEP);
    const steps = Math.floor(this.acc / SUBSTEP + 1e-9);
    this.acc -= steps * SUBSTEP;

    this.updateLook(dt, layers.lookAt, charQ);
    this.updateNod(steps);
    this.updateBlink(dt, layers.blink);
    this.updateTalk(dt);
    this.updateTypingArms(dt, steps, charQ);
    this.updateSprings(dt, steps, layers.springs, charQ);
  }

  // ---- look-at ------------------------------------------------------------------------------

  updateLook(dt, weight, charQ) {
    const { head, neck } = this.b;
    const L = this.look;
    const active = !!this.target;
    const invChar = _qi.copy(charQ).invert();

    // Current animated head direction in the character frame.
    const hf = this.axes.head.fwd;
    head.getWorldQuaternion(_q);
    const f = _v2.copy(hf).applyQuaternion(_q).applyQuaternion(invChar);
    const curYaw = Math.atan2(f.x, f.z);
    const curPitch = Math.atan2(f.y, Math.hypot(f.x, f.z));

    // A new target after a pause starts from where the head already looks, never from a stale
    // angle (that would swing the head across on the first frames).
    if (active && !this.lookActive && L.w.x < 0.05) {
      L.yaw.x = curYaw;
      L.pitch.x = curPitch;
      L.yaw.v = L.pitch.v = 0;
    }
    this.lookActive = active;

    critDamp(L.w, active ? weight : 0, 6, dt);
    const eye = head.localToWorld(_v.copy(this.eyeLocal));
    if (active) {
      const d = _v2.copy(this.target).sub(eye).applyQuaternion(invChar);
      const yaw = THREE.MathUtils.clamp(Math.atan2(d.x, d.z), -YAW_MAX, YAW_MAX);
      const pitch = THREE.MathUtils.clamp(Math.atan2(d.y, Math.hypot(d.x, d.z)), -PITCH_MAX, PITCH_MAX);
      critDamp(L.yaw, yaw, 9, dt);
      critDamp(L.pitch, pitch, 9, dt);
    }
    const w = L.w.x;
    if (w < 1e-3) return;

    const dYaw = THREE.MathUtils.clamp(L.yaw.x - curYaw, -70 * DEG, 70 * DEG) * w;
    const dPitch = THREE.MathUtils.clamp(L.pitch.x - curPitch, -40 * DEG, 40 * DEG) * w;

    for (const [bone, share] of [[neck, 0.35], [head, neck ? 0.65 : 1]]) {
      if (!bone) continue;
      // yaw about the character's up axis, pitch about the head's current horizontal right axis
      const fwd = _v.copy(hf).applyQuaternion(head.getWorldQuaternion(_q2));
      _axis.crossVectors(fwd, _up);
      if (_axis.lengthSq() < 1e-6) continue;
      _axis.normalize();
      _q.setFromAxisAngle(_up, dYaw * share);
      _q2.setFromAxisAngle(_axis, dPitch * share);
      rotateWorld(bone, _q.multiply(_q2));
    }
  }

  /** Keystroke nods: a quick dip of the head, on top of the look-at. */
  updateNod(steps) {
    const s = this.nodSpring;
    for (let i = 0; i < steps; i++) s.step(SUBSTEP);
    const head = this.b.head;
    if (!head || Math.abs(s.x) < 1e-4) return;
    const fwd = _v.copy(this.axes.head.fwd).applyQuaternion(head.getWorldQuaternion(_q2));
    _axis.crossVectors(fwd, _up);
    if (_axis.lengthSq() < 1e-6) return;
    _axis.normalize();
    rotateWorld(head, _q.setFromAxisAngle(_axis, -THREE.MathUtils.clamp(s.x, -0.25, 0.25)));
  }

  // ---- blink ----------------------------------------------------------------------------------

  updateBlink(dt, weight) {
    const eyes = [this.b.eyeOpen_L, this.b.eyeOpen_R].filter(Boolean);
    if (!eyes.length) return;
    if (this.randomness) {
      this.blinkIn -= dt;
      if (this.blinkIn <= 0 && this.blinkT < 0) {
        this.blinkT = 0;
        this.blinkDouble = this.rng() < 0.2;
        this.blinkIn = 2 + this.rng() * 3;
      }
    }
    if (this.blinkT < 0) return;
    this.blinkT += dt;
    const dur = 0.12;
    const total = this.blinkDouble ? dur * 2 + 0.08 : dur;
    if (this.blinkT >= total) { this.blinkT = -1; return; }
    let t = this.blinkT;
    if (this.blinkDouble && t > dur) t = Math.max(0, t - dur - 0.08);
    const s = Math.min(1, t / dur);
    // quick close (40%), slower open
    const closed = s < 0.4 ? s / 0.4 : 1 - (s - 0.4) / 0.6;
    const k = 1 - 0.9 * closed * weight;
    for (const e of eyes) {
      if (e.scale.y > 0.5) { // only while the open eyes are the visible set
        e.scale.y *= k;
        e.updateMatrixWorld(true);
      }
    }
  }

  // ---- talking mouth ------------------------------------------------------------------------

  /**
   * While a speech bubble is up, alternate mouthOpen / mouthSmile (spec.expressions: hidden =
   * uniform scale 0.001, visible = 1) in a ~7 Hz syllable rhythm with eased edges. Skipped when
   * the clip already shows the open mouth or the sleeping eyes.
   */
  updateTalk(dt) {
    const { mouthOpen: mo, mouthSmile: ms, eyeSleep_L: sleep } = this.b;
    if (!mo || !ms) return;
    const clipOpen = mo.scale.x > 0.5;
    const asleep = !!sleep && sleep.scale.x > 0.5;
    const want = this.talk && !clipOpen && !asleep && ms.scale.x > 0.5;
    critDamp(this.talkEnv, want ? 1 : 0, want ? 18 : 26, dt);
    const env = this.talkEnv.x;
    if (env < 0.01 || clipOpen || asleep) {
      this.talkOpen = 0;
      return;
    }
    const y = this.syl;
    y.t += dt;
    while (y.t >= y.dur) {
      y.t -= y.dur;
      y.dur = 1 / (6 + 2.2 * this.rng()); // ~7 syllables per second
      y.open = 0.45 + 0.25 * this.rng();
    }
    const u = y.t / y.dur;
    // open for the first `open` fraction of the syllable, with eased edges (~20 ms)
    const edge = Math.min(0.2, 0.025 / y.dur);
    const o = env * smoothstep(0, edge, u) * (1 - smoothstep(y.open - edge, y.open, u));
    this.talkOpen = o;
    const H = 0.001;
    mo.scale.setScalar(H + (1 - H) * o);
    ms.scale.setScalar(H + (1 - H) * (1 - o));
    mo.updateMatrixWorld(true);
    ms.updateMatrixWorld(true);
  }

  // ---- typing fallback paws ------------------------------------------------------------------

  updateTypingArms(dt, steps, charQ) {
    const T = this.taps;
    for (let i = 0; i < steps; i++) { T.L.step(SUBSTEP); T.R.step(SUBSTEP); }
    critDamp(this.typeArm, this.typing ? 1 : 0, 7, dt);
    const w = this.typeArm.x;
    if (w < 1e-3) return;
    const right = _v3.set(1, 0, 0).applyQuaternion(charQ);
    for (const side of ['L', 'R']) {
      const tap = THREE.MathUtils.clamp(T[side].x, -0.3, 1.2);
      for (const [part, lift, tapAmt] of [['upperArm', ARM_LIFT.upperArm, 0], ['forearm', ARM_LIFT.forearm, TAP.forearm], ['paw', ARM_LIFT.paw, TAP.paw]]) {
        const bone = this.b[`${part}_${side}`];
        if (!bone) continue;
        rotateWorld(bone, _q.setFromAxisAngle(right, w * (lift + tap * tapAmt)));
      }
    }
  }

  // ---- springs (ears, tail, scarf) -------------------------------------------------------------

  updateSprings(dt, steps, weight, charQ) {
    const { chest, head } = this.b;
    // Drivers, all measured on the final (animated + looked-at) pose.
    const now = this._now || (this._now = {
      headQ: new THREE.Quaternion(), chestPos: new THREE.Vector3(), hipsPos: new THREE.Vector3(), hipsQ: new THREE.Quaternion(),
    });
    const hips = this.b.hips || head;
    head.getWorldQuaternion(now.headQ);
    (chest || head).getWorldPosition(now.chestPos);
    hips.getWorldPosition(now.hipsPos);
    hips.getWorldQuaternion(now.hipsQ);
    const hipsW = new THREE.Vector3(); // angular velocities (world)
    const headW = new THREE.Vector3();
    const vel = new THREE.Vector3(); // chest velocity, character frame
    const hipsVel = new THREE.Vector3(); // hips velocity, character frame
    if (this.prev && dt > 1e-4) {
      angularVelocity(this.prev.hipsQ, now.hipsQ, dt, hipsW);
      angularVelocity(this.prev.headQ, now.headQ, dt, headW);
      _qi.copy(charQ).invert();
      vel.copy(now.chestPos).sub(this.prev.chestPos).divideScalar(dt).applyQuaternion(_qi);
      hipsVel.copy(now.hipsPos).sub(this.prev.hipsPos).divideScalar(dt).applyQuaternion(_qi);
      if (vel.length() > 20) vel.set(0, 0, 0); // teleport (clip snap), not motion
      if (hipsVel.length() > 20) hipsVel.set(0, 0, 0);
    }
    if (!this.prev) this.prev = { headQ: new THREE.Quaternion(), chestPos: new THREE.Vector3(), hipsPos: new THREE.Vector3(), hipsQ: new THREE.Quaternion() };
    this.prev.headQ.copy(now.headQ);
    this.prev.chestPos.copy(now.chestPos);
    this.prev.hipsPos.copy(now.hipsPos);
    this.prev.hipsQ.copy(now.hipsQ);
    const yawRate = hipsW.dot(_up);
    const rise = hipsVel.y;

    // Ears lag head roll (flick in/out) and nods (fold back/forward).
    const headFwd = _v.copy(this.axes.head.fwd).applyQuaternion(now.headQ);
    const headRight = _v2.copy(this.axes.head.side).applyQuaternion(now.headQ);
    const roll = THREE.MathUtils.clamp(headW.dot(headFwd) * 0.14, -0.6, 0.6);
    const nod = THREE.MathUtils.clamp(headW.dot(headRight) * 0.2, -0.6, 0.6);
    this.ears.L[0].target = roll;
    this.ears.R[0].target = -roll;
    this.ears.L[1].target = this.ears.R[1].target = nod;

    // Random ear twitches.
    if (this.randomness) {
      this.earIn -= dt;
      if (this.earIn <= 0) {
        this.earIn = 3 + this.rng() * 6;
        const e = this.ears[this.rng() < 0.5 ? 'L' : 'R'];
        e[0].v += 3 + this.rng() * 3;
      }
    }

    const clampRate = (x, m) => THREE.MathUtils.clamp(x, -m, m);
    this.flap.swing.target = THREE.MathUtils.clamp(-0.6 * vel.z + 0.8 * Math.max(0, -rise * 0.3), -0.1, 0.6);
    this.flap.side.target = clampRate(-0.5 * vel.x - 0.1 * yawRate, 0.4);

    const springs = [...this.ears.L, ...this.ears.R, this.flap.swing, this.flap.side];
    for (let i = 0; i < steps; i++) for (const s of springs) s.step(SUBSTEP);

    this.applyEars();
    this.updateTail(dt, steps, weight);
    if (weight <= 1e-3) return;
    this.applyFlap(weight);
  }

  applyEars() {
    const head = this.b.head;
    head.getWorldQuaternion(_q);
    const fwd = _v.copy(this.axes.head.fwd).applyQuaternion(_q);
    const right = _v2.copy(this.axes.head.side).applyQuaternion(_q);
    for (const [side, sign] of [['L', -1], ['R', 1]]) {
      const bone = this.b[`ear_${side}`];
      if (!bone) continue;
      const [flick, back] = this.ears[side];
      if (Math.abs(flick.x) + Math.abs(back.x) < 1e-4) continue;
      _q.setFromAxisAngle(fwd, sign * 0.35 * flick.x);
      _q2.setFromAxisAngle(right, -0.25 * back.x);
      rotateWorld(bone, _q.multiply(_q2));
    }
  }

  applyFlap(weight) {
    const chest = this.b.chest;
    if (!chest) return;
    chest.getWorldQuaternion(_q);
    const right = _v.copy(this.axes.chest.side).applyQuaternion(_q);
    const fwd = _v2.copy(this.axes.chest.fwd).applyQuaternion(_q);
    for (const [n, share] of [['scarfFlap_1', 0.6], ['scarfFlap_2', 0.4]]) {
      const bone = this.b[n];
      if (!bone) continue;
      // positive swing lifts the flap away from the chest (about -right)
      _q.setFromAxisAngle(right, -this.flap.swing.x * share * weight);
      _q2.setFromAxisAngle(fwd, this.flap.side.x * share * weight);
      rotateWorld(bone, _q.multiply(_q2));
    }
  }

  // ---- tail chain ------------------------------------------------------------------------------

  initTail() {
    const bones = [];
    for (const n of TAIL) {
      const b = this.b[n];
      if (!b || (bones.length && b.parent !== bones[bones.length - 1])) break;
      bones.push(b);
    }
    this.tailBones = bones.length >= 2 ? bones : [];
    const n = this.tailBones.length;
    this.tailFrame = n ? bones[0].parent : null; // the hips: the frame the chain is simulated in
    this.tailLen = this.tailBones.map((b, i) => (i < n - 1 ? bones[i + 1].position.length() : bones[i].position.length()));
    const vecs = () => Array.from({ length: n }, () => new THREE.Vector3());
    this.tail = {
      phi: vecs(), w: vecs(), // simulated link deviation (rotation vector) / its rate, frame coords
      tips: vecs(), heads: vecs(), dirs: vecs(), // animated chain (frame coords)
      psi: vecs(), // target deviation per link (drag + sway)
      P: Array.from({ length: n + 1 }, () => new THREE.Vector3()), // bend scratch
      tau: vecs(), // inertial drive per link (angular acceleration)
      aF: new THREE.Vector3(), alphaF: new THREE.Vector3(), // low-passed drive (frame coords)
      kin: new Kinematics(),
      modelInv: new THREE.Matrix4(),
    };
    // Drag: rotation vector (frame coords, axis * angle), smoothed towards `want`.
    this.drag = { active: false, want: new THREE.Vector3(), rot: [0, 1, 2].map(() => ({ x: 0, v: 0 })), rotVec: new THREE.Vector3() };
    this.tailFlicks = 0;
    this.tailSway = 1; // 0..1 weight of the idle travelling wave
  }

  resetTail() {
    const T = this.tail;
    if (!T) return;
    for (const a of [T.phi, T.w]) for (const x of a) x.set(0, 0, 0);
    T.aF.set(0, 0, 0);
    T.alphaF.set(0, 0, 0);
    T.kin.reset();
    for (const r of this.drag.rot) r.x = r.v = 0;
    this.drag.active = false;
    this.drag.want.set(0, 0, 0);
  }

  /**
   * Drag the tail: `worldDelta` = pointer displacement (world units, on a camera-facing plane
   * through the grab point) since the press, or null to let go. The tail bends so its tip
   * follows the pointer, spread along the chain (more near the tip), clamped to +-60 degrees.
   */
  dragTail(worldDelta) {
    const n = this.tailBones.length;
    if (!n) return;
    if (!worldDelta) {
      this.drag.active = false;
      this.drag.want.set(0, 0, 0);
      return;
    }
    this.drag.active = true;
    const F = this.tailFrame;
    const base = this.tailBones[0].getWorldPosition(_v);
    const tip = this.tailBones[n - 1].localToWorld(_v2.set(0, this.tailLen[n - 1], 0));
    const from = tip.sub(base); // base -> tip
    const to = _v3.copy(from).add(worldDelta);
    const angle = Math.min(DRAG_MAX, from.angleTo(to) * DRAG_GAIN);
    _axis.crossVectors(from, to);
    if (_axis.lengthSq() < 1e-10 || angle < 1e-4) {
      this.drag.want.set(0, 0, 0);
      return;
    }
    // world axis -> frame coords
    F.getWorldQuaternion(_q).invert();
    this.drag.want.copy(_axis.normalize().applyQuaternion(_q)).multiplyScalar(angle);
  }

  get tailDragging() {
    return this.drag.active;
  }

  /** Quick sideways flick of the tail (hover), `sign` = +1 / -1 (fox's left / right). */
  flickTail(sign = this.rng() < 0.5 ? -1 : 1) {
    const T = this.tail;
    if (!this.tailBones.length) return;
    // a quick yaw about the hips' up axis (projected off each link in the next update)
    for (let i = 0; i < T.w.length; i++) T.w[i].y += sign * FLICK[i];
    this.tailFlicks++;
  }

  /** Largest angle (deg) between a tail link's final and animated direction (debug / tests). */
  get tailBend() {
    return this._tailBend || 0;
  }

  updateTail(dt, steps, weight) {
    const bones = this.tailBones;
    const n = bones.length;
    if (!n) return;
    const T = this.tail;
    const F = this.tailFrame;

    // 1. Animated chain in the frame's coordinates (from the local transforms, no matrices).
    let q = _q.identity();
    T.heads[0].copy(bones[0].position);
    for (let i = 0; i < n; i++) {
      q = q.multiply(bones[i].quaternion);
      if (i < n - 1) T.heads[i + 1].copy(bones[i + 1].position).applyQuaternion(q).add(T.heads[i]);
      if (i < n - 1) T.tips[i].copy(T.heads[i + 1]);
      else T.tips[i].copy(Y).multiplyScalar(this.tailLen[i]).applyQuaternion(q).add(T.heads[i]);
      T.dirs[i].copy(T.tips[i]).sub(T.heads[i]).normalize();
    }

    // 2. Target deviation per link: drag bend + idle travelling wave.
    const D = this.drag;
    for (let k = 0; k < 3; k++) critDamp(D.rot[k], D.want.getComponent(k), D.active ? 16 : 30, dt);
    D.rotVec.set(D.rot[0].x, D.rot[1].x, D.rot[2].x);
    const dragAngle = D.rotVec.length();
    const dragAxis = dragAngle > 1e-5 ? _v2.copy(D.rotVec).divideScalar(dragAngle) : null;
    const sway = this.randomness ? this.tailSway * weight : 0;
    const P = T.P;
    P[0].copy(T.heads[0]);
    for (let i = 0; i < n; i++) P[i + 1].copy(T.tips[i]);
    for (let j = 0; j < n; j++) {
      const swayAngle = sway * SWAY_AMP[j] * (0.75 * Math.sin(this.time * 2.1 - 0.55 * j) + 0.25 * Math.sin(this.time * 3.7 - 0.8 * j + 1.3));
      _q2.setFromAxisAngle(Y, swayAngle); // frame (hips) up = character up
      if (dragAxis) _q2.premultiply(_dq.setFromAxisAngle(dragAxis, dragAngle * DRAG_SHARE[j]));
      for (let m = j + 1; m <= n; m++) P[m].sub(P[j]).applyQuaternion(_q2).add(P[j]);
    }
    for (let i = 0; i < n; i++) {
      const to = _v.copy(P[i + 1]).sub(P[i]).normalize();
      const ang = T.dirs[i].angleTo(to);
      if (ang < 1e-6) T.psi[i].set(0, 0, 0);
      else T.psi[i].crossVectors(T.dirs[i], to).setLength(ang);
    }

    // 3. Inertial drive from the hips frame's motion (model space, so the root scale pop and
    //    shrink never read as motion), low-passed. Angular acceleration of each link from the
    //    fictitious acceleration f = -a - alpha x r at its tip: (dir x f) / length.
    T.modelInv.copy(this.fox.root.matrixWorld).invert();
    const moving = T.kin.update(F, T.modelInv, dt);
    if (!moving && T.kin.frames === 0) this.resetTailMotion();
    _qi.copy(T.kin.q).invert();
    const lp = 1 - Math.exp(-2 * Math.PI * TAIL_DRIVE_HZ * dt);
    T.aF.lerp(_v.copy(T.kin.acc).applyQuaternion(_qi), lp);
    T.alphaF.lerp(_v.copy(T.kin.alpha).applyQuaternion(_qi), lp);
    for (let i = 0; i < n; i++) {
      const f = _v.crossVectors(T.alphaF, T.tips[i]).add(T.aF).multiplyScalar(-TAIL_INERTIA);
      T.tau[i].crossVectors(T.dirs[i], f).divideScalar(this.tailLen[i]);
    }

    // 4. Integrate (fixed substeps, semi-implicit Euler), base first so each link follows its
    //    parent's updated deviation.
    const rel = _v2;
    const relW = _v3;
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < n; i++) {
        const dir = T.dirs[i];
        const w0 = TAIL_OMEGA[i];
        rel.copy(T.phi[i]).sub(T.psi[i]);
        relW.copy(T.w[i]);
        if (i > 0) {
          rel.sub(T.phi[i - 1]).add(T.psi[i - 1]);
          relW.sub(T.w[i - 1]);
        }
        // soft joint limit: past it the joint stiffens (up to x9) and damps harder, so big
        // whips are caught smoothly instead of hitting a wall (a velocity jerk)
        const soft = TAIL_SOFT[i];
        const over = Math.min(1, Math.max(0, rel.length() - soft) / soft);
        const k = w0 * w0 * (1 + 8 * over);
        const c = 2 * TAIL_ZETA[i] * w0 * (1 + 2 * over);
        T.w[i].addScaledVector(rel, -k * SUBSTEP).addScaledVector(relW, -c * SUBSTEP).addScaledVector(T.tau[i], SUBSTEP);
        T.w[i].addScaledVector(dir, -T.w[i].dot(dir)); // bend only, no twist
        T.phi[i].addScaledVector(T.w[i], SUBSTEP);
        T.phi[i].addScaledVector(dir, -T.phi[i].dot(dir));
        // fail-safe (very long frames only)
        rel.copy(T.phi[i]).sub(T.psi[i]);
        if (i > 0) rel.sub(T.phi[i - 1]).add(T.psi[i - 1]);
        const len = rel.length();
        const hard = soft * TAIL_HARD;
        if (len > hard) T.phi[i].addScaledVector(rel, hard / len - 1);
      }
    }

    // 5. Aim each bone along its deviated direction, base first.
    let maxBend = 0;
    for (let i = 0; i < n; i++) {
      const bone = bones[i];
      // deviation actually shown: drag/sway fully, the dynamic part scaled by the layer weight
      const phi = _v.copy(T.phi[i]).sub(T.psi[i]).multiplyScalar(weight).add(T.psi[i]);
      const ang = phi.length();
      maxBend = Math.max(maxBend, ang);
      const want = _v2.copy(T.dirs[i]);
      if (ang > 1e-6) want.applyAxisAngle(phi.divideScalar(ang), ang);
      want.transformDirection(F.matrixWorld); // frame -> world (normalised)
      const headW = bone.getWorldPosition(_v3);
      const cur = i < n - 1 ? bones[i + 1].getWorldPosition(_v).sub(headW) : _v.copy(Y).applyQuaternion(bone.getWorldQuaternion(_q2));
      if (cur.lengthSq() < 1e-12) continue;
      cur.normalize();
      if (cur.angleTo(want) < 1e-5) continue;
      rotateWorld(bone, _q.setFromUnitVectors(cur, want));
    }
    this._tailBend = maxBend / DEG;
    // tip direction now vs. where the clip alone puts it (world), for tests
    const last = bones[n - 1];
    const animTip = _v.copy(T.dirs[n - 1]).transformDirection(F.matrixWorld);
    this._tipOffset = animTip.angleTo(_v2.copy(Y).applyQuaternion(last.getWorldQuaternion(_q2))) / DEG;
  }

  /** Angle (deg) between tail_6's final world direction and its clip-only direction. */
  get tailTipOffset() {
    return this._tipOffset || 0;
  }

  resetTailMotion() {
    const T = this.tail;
    for (const a of [T.phi, T.w]) for (const x of a) x.set(0, 0, 0);
    T.aF.set(0, 0, 0);
    T.alphaF.set(0, 0, 0);
  }
}
