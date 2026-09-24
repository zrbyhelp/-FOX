// Procedural layer applied after mixer.update(): look-at, blink, ear twitch, tail and scarf springs.
// All offsets are applied as world-space rotations about each bone's pivot, so bone roll in the
// rig does not matter, and bones are restored to their rest pose before the mixer runs, so
// nothing accumulates even for bones a clip does not key.
import * as THREE from 'three';

const DEG = Math.PI / 180;
const YAW_MAX = 50 * DEG;
const PITCH_MAX = 25 * DEG;
const SUBSTEP = 1 / 120;
const TAIL = ['tail_2', 'tail_3', 'tail_4', 'tail_5', 'tail_6'];
const TAIL_SHARE = [0.12, 0.17, 0.21, 0.24, 0.26];

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qc = new THREE.Quaternion(); // character (root) world rotation, valid for one update()
const _qi = new THREE.Quaternion();
const _up = new THREE.Vector3();
const _axis = new THREE.Vector3();

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

const _rp = new THREE.Quaternion();
const _rpi = new THREE.Quaternion();

const _dq = new THREE.Quaternion();

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

export class Procedural {
  constructor(fox, { rng = Math.random } = {}) {
    this.b = fox.bones;
    this.rng = rng;
    this.enabled = true; // false in debug poses
    this.randomness = true; // blink / ear twitch timers

    // Everything we touch, with its rest transform (captured before any animation ran).
    const names = ['neck', 'head', 'ear_L', 'ear_R', 'eyeOpen_L', 'eyeOpen_R', 'scarfFlap_1', 'scarfFlap_2', ...TAIL];
    this.rest = names.filter((n) => this.b[n]).map((n) => ({
      bone: this.b[n], q: this.b[n].quaternion.clone(), s: this.b[n].scale.clone(), p: this.b[n].position.clone(),
    }));

    this.target = null; // Vector3 or null
    this.look = { yaw: { x: 0, v: 0 }, pitch: { x: 0, v: 0 }, w: { x: 0, v: 0 } };

    this.blinkIn = 2 + rng() * 3;
    this.blinkT = -1;
    this.blinkDouble = false;

    this.ears = { L: [new Spring(22, 0.22), new Spring(18, 0.3)], R: [new Spring(22, 0.22), new Spring(18, 0.3)] };
    this.earIn = 3 + rng() * 5;

    this.tail = { yaw: new Spring(7, 0.35), pitch: new Spring(7, 0.4) };
    this.flap = { swing: new Spring(10, 0.25), side: new Spring(9, 0.3) };
    this.acc = 0;
    this.time = 0;
    this.prev = null; // previous hips/chest state for velocity estimates

    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.reset(); });
  }

  /** Put touched bones back to rest before the mixer writes this frame's pose. */
  restore() {
    for (const r of this.rest) {
      r.bone.quaternion.copy(r.q);
      r.bone.scale.copy(r.s);
      r.bone.position.copy(r.p);
    }
  }

  reset() {
    this.acc = 0;
    this.prev = null;
    for (const s of [...this.ears.L, ...this.ears.R, this.tail.yaw, this.tail.pitch, this.flap.swing, this.flap.side]) s.reset();
    this.look.w.x = this.look.w.v = 0;
    this.blinkT = -1;
  }

  setTarget(v) {
    this.target = v ? (this.target || new THREE.Vector3()).copy(v) : null;
  }

  flickEar(side) {
    const e = this.ears[side];
    if (!e) return;
    e[0].v += 9 + this.rng() * 3;
    e[1].v += 5;
  }

  get earEnergy() {
    return Math.abs(this.ears.L[0].x) + Math.abs(this.ears.R[0].x) + Math.abs(this.ears.L[0].v) + Math.abs(this.ears.R[0].v);
  }

  update(dt, layers) {
    if (!this.enabled) return;
    dt = Math.min(dt, 0.1);
    this.time += dt;
    const { head, root } = this.b;
    const charRoot = root || head?.parent;
    if (!head || !charRoot) return;
    const charQ = charRoot.getWorldQuaternion(_qc);
    _up.set(0, 1, 0).applyQuaternion(charQ);

    this.updateLook(dt, layers.lookAt, charQ);
    this.updateBlink(dt, layers.blink);
    this.updateSprings(dt, layers.springs, charQ);
  }

  // ---- look-at ------------------------------------------------------------------------------

  updateLook(dt, weight, charQ) {
    const { head, neck } = this.b;
    const L = this.look;
    const active = !!this.target;
    critDamp(L.w, active ? weight : 0, 6, dt);
    const invChar = _qi.copy(charQ).invert();
    const eye = head.localToWorld(_v.set(0, 0.15, 0.05));
    if (active) {
      const d = _v2.copy(this.target).sub(eye).applyQuaternion(invChar);
      const yaw = THREE.MathUtils.clamp(Math.atan2(d.x, d.z), -YAW_MAX, YAW_MAX);
      const pitch = THREE.MathUtils.clamp(Math.atan2(d.y, Math.hypot(d.x, d.z)), -PITCH_MAX, PITCH_MAX);
      critDamp(L.yaw, yaw, 9, dt);
      critDamp(L.pitch, pitch, 9, dt);
    }
    const w = L.w.x;
    if (w < 1e-3) return;

    // Current animated head direction in the character frame.
    head.getWorldQuaternion(_q);
    const f = _v2.set(0, 0, 1).applyQuaternion(_q).applyQuaternion(invChar);
    const curYaw = Math.atan2(f.x, f.z);
    const curPitch = Math.atan2(f.y, Math.hypot(f.x, f.z));
    const dYaw = THREE.MathUtils.clamp(L.yaw.x - curYaw, -70 * DEG, 70 * DEG) * w;
    const dPitch = THREE.MathUtils.clamp(L.pitch.x - curPitch, -40 * DEG, 40 * DEG) * w;

    for (const [bone, share] of [[neck, 0.35], [head, neck ? 0.65 : 1]]) {
      if (!bone) continue;
      // yaw about the character's up axis, pitch about the head's current horizontal right axis
      const fwd = _v.set(0, 0, 1).applyQuaternion(head.getWorldQuaternion(_q2));
      _axis.crossVectors(fwd, _up);
      if (_axis.lengthSq() < 1e-6) continue;
      _axis.normalize();
      _q.setFromAxisAngle(_up, dYaw * share);
      _q2.setFromAxisAngle(_axis, dPitch * share);
      rotateWorld(bone, _q.multiply(_q2));
    }
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

  // ---- springs (ears, tail, scarf) -------------------------------------------------------------

  updateSprings(dt, weight, charQ) {
    const { hips, chest, head } = this.b;
    // Drivers, all measured on the final (animated + looked-at) pose.
    const now = {
      hipsQ: (hips || head).getWorldQuaternion(new THREE.Quaternion()),
      headQ: head.getWorldQuaternion(new THREE.Quaternion()),
      hipsPos: (hips || head).getWorldPosition(new THREE.Vector3()),
      chestPos: (chest || head).getWorldPosition(new THREE.Vector3()),
    };
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
    }
    this.prev = now;
    const yawRate = hipsW.dot(_up);
    const rise = hipsVel.y;

    // Ears lag head roll (flick in/out) and nods (fold back/forward).
    const headFwd = _v.set(0, 0, 1).applyQuaternion(now.headQ);
    const headRight = _v2.set(1, 0, 0).applyQuaternion(now.headQ);
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
    // Tail lags behind hip rotation and sideways hip motion (+x hips -> tip swings to -x).
    this.tail.yaw.target = clampRate(-0.18 * yawRate + 0.8 * hipsVel.x, 0.5) + 0.04 * Math.sin(this.time * 1.3) * (this.randomness ? 1 : 0);
    this.tail.pitch.target = clampRate(-0.35 * rise, 0.4); // rising body -> tail lags down
    this.flap.swing.target = THREE.MathUtils.clamp(-0.6 * vel.z + 0.8 * Math.max(0, -rise * 0.3), -0.1, 0.6);
    this.flap.side.target = clampRate(-0.5 * vel.x - 0.1 * yawRate, 0.4);

    this.acc = Math.min(this.acc + dt, 0.1);
    const springs = [...this.ears.L, ...this.ears.R, this.tail.yaw, this.tail.pitch, this.flap.swing, this.flap.side];
    while (this.acc >= SUBSTEP) {
      for (const s of springs) s.step(SUBSTEP);
      this.acc -= SUBSTEP;
    }

    this.applyEars();
    if (weight <= 1e-3) return;
    this.applyTail(weight, charQ);
    this.applyFlap(weight);
  }

  applyEars() {
    const head = this.b.head;
    head.getWorldQuaternion(_q);
    const fwd = _v.set(0, 0, 1).applyQuaternion(_q);
    const right = _v2.set(1, 0, 0).applyQuaternion(_q);
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

  applyTail(weight, charQ) {
    const yaw = this.tail.yaw.x * weight;
    const pitch = this.tail.pitch.x * weight;
    if (Math.abs(yaw) + Math.abs(pitch) < 1e-5) return;
    const right = _v2.set(1, 0, 0).applyQuaternion(charQ);
    TAIL.forEach((n, i) => {
      const bone = this.b[n];
      if (!bone) return;
      _q.setFromAxisAngle(_up, yaw * TAIL_SHARE[i]);
      _q2.setFromAxisAngle(right, pitch * TAIL_SHARE[i]);
      rotateWorld(bone, _q.multiply(_q2));
    });
  }

  applyFlap(weight) {
    const chest = this.b.chest;
    if (!chest) return;
    chest.getWorldQuaternion(_q);
    const right = _v.set(1, 0, 0).applyQuaternion(_q);
    const fwd = _v2.set(0, 0, 1).applyQuaternion(_q);
    for (const [n, share] of [['scarfFlap_1', 0.6], ['scarfFlap_2', 0.4]]) {
      const bone = this.b[n];
      if (!bone) continue;
      // positive swing lifts the flap away from the chest (about -right)
      _q.setFromAxisAngle(right, -this.flap.swing.x * share * weight);
      _q2.setFromAxisAngle(fwd, this.flap.side.x * share * weight);
      rotateWorld(bone, _q.multiply(_q2));
    }
  }
}
