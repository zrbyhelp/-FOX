// Parameter-driven deformers for the puppet, organised like a Cubism model's deformer tree:
//
//   Root (translate / squash / rotate about the feet)
//   └ Body field (lean + skew + breath about the hips, fading out towards the feet; sit)
//     ├ Legs (squash / splay; tops glued to the body field)
//     ├ Tail (5-link skinned chain: swing + physics)
//     ├ Arms (3-bone skinned chains, split at the elbow for draw-order switching)
//     ├ Scarf, ScarfFlap (2-bone chain pendulum)
//     └ Head rotation (ParamAngleZ about the neck)
//       ├ Head warp (pseudo-3D turn: spherical displacement field, ParamAngleX/Y)
//       ├ Face parts (same field with a depth boost = parallax; blink / smile / mouth / brows)
//       └ Ears (2-bone chains + physics, counter-parallax)
//
// All coordinates are model units from rig.json (x = fox's left = screen right, y up).
import {
  DEG, aff, affMul, affRotate, affScale, affTranslate, affApplyX, affApplyY, smooth, smoothstep, clamp, lerp,
} from './math2d.js';

/** name: [min, max, default]. Angles in degrees. */
export const PARAMS = {
  ParamAngleX: [-30, 30, 0], // head turn, + = towards screen right
  ParamAngleY: [-30, 30, 0], // + = look up
  ParamAngleZ: [-30, 30, 0], // head tilt, CCW (+ = top of the head to screen left)
  ParamEyeLOpen: [0, 1, 1],
  ParamEyeROpen: [0, 1, 1],
  ParamEyeSmile: [0, 1, 0], // ^^ eyes
  ParamEyeBallX: [-1, 1, 0],
  ParamEyeBallY: [-1, 1, 0],
  ParamBrowL: [0, 1, 0], // worried brow shown (fox's left = screen right)
  ParamBrowR: [0, 1, 0],
  ParamBrowY: [-1, 1, 0],
  ParamMouthOpen: [0, 1, 0],
  ParamBodyAngleX: [-10, 10, 0], // body turn (skew), + = towards screen right
  ParamBodyAngleZ: [-10, 10, 0], // body lean, CCW
  ParamBreath: [0, 1, 0],
  // arms: + = raise outwards / up for a hanging arm, - = swing in towards the chest
  ParamArmLA: [-180, 180, 0], // upper arm (shoulder)
  ParamArmLB: [-180, 180, 0], // forearm (elbow)
  ParamArmLC: [-90, 90, 0], // paw (wrist)
  ParamArmLOrder: [0, 2, 0], // arm draw order: 0 rest, 1 over the flap / keyboard (under the scarf), 2 over the face
  ParamArmRA: [-180, 180, 0],
  ParamArmRB: [-180, 180, 0],
  ParamArmRC: [-90, 90, 0],
  ParamArmROrder: [0, 2, 0],
  ParamTailSwing: [-60, 60, 20], // + = tail swings out to screen right (its natural side)
  ParamEarL: [-40, 40, 0], // + = ear rotates outwards / back
  ParamEarR: [-40, 40, 0],
  ParamFlap: [-40, 40, 0],
  ParamSit: [0, 1, 0],
  ParamRootX: [-3, 3, 0],
  ParamRootY: [-1, 2, 0],
  ParamRootRot: [-30, 30, 0],
  ParamSquash: [-1, 1, 0], // + = stretch (taller), - = squash
  ParamScale: [0, 1.5, 1], // pop-in
  // physics outputs (written by physics.js)
  PhysEarL: [-90, 90, 0],
  PhysEarR: [-90, 90, 0],
  PhysEarLTip: [-90, 90, 0],
  PhysEarRTip: [-90, 90, 0],
  PhysFlap: [-90, 90, 0],
  PhysTail0: [-90, 90, 0],
  PhysTail1: [-90, 90, 0],
  PhysTail2: [-90, 90, 0],
  PhysTail3: [-90, 90, 0],
  PhysTail4: [-90, 90, 0],
};

export function defaultParams() {
  const p = {};
  for (const [k, v] of Object.entries(PARAMS)) p[k] = v[2];
  return p;
}

export function clampParams(p) {
  for (const [k, v] of Object.entries(PARAMS)) p[k] = clamp(p[k], v[0], v[1]);
  return p;
}

// ---- tuning ---------------------------------------------------------------------------------

const HEAD_TURN = 0.05; // model units the face centre shifts at |AngleX| = 30
const HEAD_NOD = 0.036; // ... at |AngleY| = 30
const ARM_SPLIT = 0.82; // front part of an arm = within this x upper-arm length of the elbow, or beyond it
const HEAD_GLOBAL = 0.16; // share of the shift that moves the whole head (silhouette included)
const FACE_DEPTH = {
  Nose: 1.4, MouthSmile: 1.22, MouthOpen: 1.22,
  Eye_L: 1.04, Eye_R: 1.04, EyeHappy_L: 1.04, EyeHappy_R: 1.04, EyeSleep_L: 1.04, EyeSleep_R: 1.04,
  Brow_L: 0.96, Brow_R: 0.96,
};

// ---- skinned chains ---------------------------------------------------------------------------

/**
 * A polyline of joints = n bones, optionally preceded by an "anchor" (the parent, identity).
 * Every vertex is bound to at most two neighbouring bones by its arc-length coordinate along
 * the chain, blended smoothly across each joint (2D linear blend skinning).
 */
class Chain {
  constructor(joints, { anchor = null, blend = 0.04 } = {}) {
    this.J = joints.map((p) => [p[0], p[1]]);
    this.n = this.J.length - 1;
    this.len = [];
    this.dir = [];
    this.S = [0];
    for (let i = 0; i < this.n; i++) {
      const dx = this.J[i + 1][0] - this.J[i][0];
      const dy = this.J[i + 1][1] - this.J[i][1];
      const l = Math.hypot(dx, dy) || 1e-6;
      this.len.push(l);
      this.dir.push([dx / l, dy / l]);
      this.S.push(this.S[i] + l);
    }
    this.h = [0];
    for (let j = 1; j < this.n; j++) this.h.push(Math.min(blend, 0.45 * Math.min(this.len[j - 1], this.len[j])));
    this.anchor = anchor;
    this.M = Array.from({ length: this.n + 1 }, () => aff());
    this.theta = new Float64Array(this.n + 1); // cumulative angle of each M entry
    this.jp = this.J.map((p) => [p[0], p[1]]); // posed joints
    this._r = aff();
  }

  /**
   * Arc-length coordinate of a rest point: projections onto every segment, blended by a
   * soft-min of their distances so the coordinate is continuous in the inner corner of bends.
   */
  param(x, y) {
    const SOFT = 0.012;
    let dmin = Infinity;
    const ds = [];
    const ss = [];
    for (let i = 0; i < this.n; i++) {
      const [jx, jy] = this.J[i];
      const [dx, dy] = this.dir[i];
      const t = (x - jx) * dx + (y - jy) * dy;
      const tc = clamp(t, 0, this.len[i]);
      const d = Math.hypot(x - jx - dx * tc, y - jy - dy * tc);
      const tt = (i === 0 && t < 0) || (i === this.n - 1 && t > this.len[i]) ? t : tc;
      ds.push(d);
      ss.push(this.S[i] + tt);
      if (d < dmin) dmin = d;
    }
    let sw = 0;
    let s = 0;
    for (let i = 0; i < this.n; i++) {
      const w = Math.exp(-(ds[i] - dmin) / SOFT);
      sw += w;
      s += ss[i] * w;
    }
    return s / sw;
  }

  /** Bone pair (0 = anchor, k = bone k-1) and blend weight for arc length s. */
  weightsAt(s) {
    const n = this.n;
    if (this.anchor && s < this.anchor[1]) {
      if (s <= this.anchor[0]) return [0, 0, 0];
      return [0, 1, smooth((s - this.anchor[0]) / (this.anchor[1] - this.anchor[0]))];
    }
    let k = 0;
    while (k < n - 1 && s >= this.S[k + 1]) k++;
    if (k >= 1 && s < this.S[k] + this.h[k]) {
      const h = this.h[k];
      return [k, k + 1, smooth((s - (this.S[k] - h)) / (2 * h))];
    }
    if (k + 1 <= n - 1 && s > this.S[k + 1] - this.h[k + 1]) {
      const h = this.h[k + 1];
      return [k + 1, k + 2, smooth((s - (this.S[k + 1] - h)) / (2 * h))];
    }
    return [k + 1, k + 1, 0];
  }

  bind(rest) {
    const count = rest.length / 2;
    const a = new Uint8Array(count);
    const b = new Uint8Array(count);
    const t = new Float32Array(count);
    const s = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      s[i] = this.param(rest[i * 2], rest[i * 2 + 1]);
      const [ia, ib, w] = this.weightsAt(s[i]);
      a[i] = ia;
      b[i] = ib;
      t[i] = w;
    }
    return { a, b, t, s };
  }

  /** Relative bone rotations (radians, CCW) -> bone matrices. */
  pose(angles) {
    const M = this.M;
    aff(M[0]);
    let cum = 0;
    this.theta[0] = 0;
    for (let k = 0; k < this.n; k++) {
      cum += angles[k] || 0;
      this.theta[k + 1] = cum;
      const [jx, jy] = this.J[k];
      let px = jx;
      let py = jy;
      if (k > 0) {
        px = affApplyX(M[k], jx, jy);
        py = affApplyY(M[k], jx, jy);
      }
      this.jp[k][0] = px;
      this.jp[k][1] = py;
      // T(p') R(cum) T(-J)
      affRotate(M[k + 1], cum, jx, jy);
      M[k + 1][4] += px - jx;
      M[k + 1][5] += py - jy;
    }
    const last = this.J[this.n];
    this.jp[this.n][0] = affApplyX(M[this.n], last[0], last[1]);
    this.jp[this.n][1] = affApplyY(M[this.n], last[0], last[1]);
  }
}

/**
 * Where the visible part of an ear meets the top of the head (the inner-top contact point).
 * Rotating the ear about it keeps that junction closed, so no background shows between the ear
 * and the crown. Found from the layers' alpha maps; null if the layers do not touch.
 */
function findEarHinge(ear, head) {
  if (!ear || !head) return null;
  const opaque = (L, x, y) => {
    const d = L.def;
    const A = L.alpha;
    const u = (x - d.x0) / d.w;
    const v = (y - d.y0) / d.h;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return false;
    return A.a[Math.floor((1 - v) * A.h) * A.w + Math.floor(u * A.w)] > 128;
  };
  const d = ear.def;
  const A = ear.alpha;
  const px = d.w / A.w;
  const pts = [];
  for (let j = 0; j < A.h; j++) {
    for (let i = 0; i < A.w; i++) {
      if (A.a[j * A.w + i] <= 128) continue;
      const x = d.x0 + (i + 0.5) * px;
      const y = d.y0 + d.h - (j + 0.5) * (d.h / A.h);
      if (opaque(head, x, y)) continue;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) if (opaque(head, x + dx * px, y + dy * px)) { near = true; break; }
      if (near) pts.push([x, y]);
    }
  }
  if (!pts.length) return null;
  const ymax = Math.max(...pts.map((p) => p[1]));
  const top = pts.filter((p) => p[1] > ymax - 0.03);
  top.sort((a, b) => Math.abs(a[0]) - Math.abs(b[0]));
  return [top[0][0], top[0][1]];
}

// ---- rig --------------------------------------------------------------------------------------

export class Rig {
  constructor(puppet) {
    this.puppet = puppet;
    const R = puppet.rig;
    const P = R.pivots || {};
    const C = R.chains || {};
    const pv = (name, d) => (P[name] ? [P[name][0], P[name][1]] : d);
    this.pv = pv;
    this.hips = pv('hips', [0, 0.17]);
    this.neck = pv('head', [0, 0.47]);
    this.headCenter = R.head_center ? [...R.head_center] : [0, 0.63];
    // face sphere: centred a little below head_center (the features sit low on the face)
    this.face = { cx: this.headCenter[0], cy: this.headCenter[1] - 0.03, rx: 0.33, ry: 0.29 };

    // transforms rebuilt every frame
    this.T = {
      root: aff(), lean: aff(), body: aff(), head: aff(), headLocal: aff(), arm: aff(), tmp: aff(), tmp2: aff(), tmp3: aff(),
    };
    this.chains = {};
    this.binds = {};

    const L = puppet.byName;
    const mk = (key, joints, opts) => {
      if (!joints || joints.length < 2) return null;
      this.chains[key] = new Chain(joints, opts);
      return this.chains[key];
    };
    // arms: shoulder -> elbow -> wrist -> tip, anchored to the body before the shoulder
    for (const s of ['L', 'R']) {
      const ch = mk(`arm_${s}`, C[`arm_${s}`], { anchor: [-0.035, 0.004], blend: 0.03 });
      const layer = L[`Arm_${s}`];
      if (ch && layer) {
        const bind = (this.binds[layer.name] = ch.bind(layer.rest));
        // draw-order split: the shoulder cap stays tucked under the scarf, the rest of the arm
        // can be brought forward. The boundary is an arc centred on the elbow, so wherever it
        // shows it reads as the rounded top of the arm rather than a straight cut.
        const [ex, ey] = ch.J[1];
        const R = ch.len[0] * ARM_SPLIT;
        const front = new Float32Array(bind.s.length);
        const rest = layer.rest;
        for (let i = 0; i < front.length; i++) {
          const d = Math.hypot(rest[i * 2] - ex, rest[i * 2 + 1] - ey);
          const inCircle = clamp((R - d) / 0.032 + 0.5, 0, 1);
          const past = clamp((bind.s[i] - ch.S[1]) / 0.032 + 0.5, 0, 1);
          front[i] = Math.max(inCircle, past);
        }
        puppet.splitLayer(layer.name, front);
      }
      const ear = mk(`ear_${s}`, C[`ear_${s}`], { anchor: [-0.06, 0.0], blend: 0.045 });
      if (ear && L[`Ear_${s}`]) this.binds[`Ear_${s}`] = ear.bind(L[`Ear_${s}`].rest);
      this.earHinge = this.earHinge || {};
      this.earHinge[s] = findEarHinge(L[`Ear_${s}`], L.Head) || pv(`ear_${s}`, [(s === 'L' ? 1 : -1) * 0.17, 0.79]);
    }
    // tail: skip the short first link that dips into the body
    const tailJ = C.tail && C.tail.length > 3 ? C.tail.slice(1) : C.tail;
    const tail = mk('tail', tailJ, { blend: 0.05 });
    if (tail && L.Tail) this.binds.Tail = tail.bind(L.Tail.rest);
    const flap = mk('flap', C.flap, { anchor: [-0.03, 0.01], blend: 0.03 });
    if (flap && L.ScarfFlap) this.binds.ScarfFlap = flap.bind(L.ScarfFlap.rest);

    for (const layer of puppet.layers) layer.pickable = true;
    this.angles = new Float64Array(8);
  }

  // ---- per-frame transforms ---------------------------------------------------------------

  computeTransforms(p) {
    const T = this.T;
    const [hx, hy] = this.hips;
    // root: pop scale + squash/stretch about the feet, rotation, translation
    const sq = p.ParamSquash;
    const sc = p.ParamScale;
    affScale(T.root, sc * (1 - 0.07 * sq), sc * (1 + 0.1 * sq), 0, 0);
    affMul(T.root, affRotate(T.tmp, p.ParamRootRot * DEG, 0, 0), T.root);
    affMul(T.root, affTranslate(T.tmp, p.ParamRootX, p.ParamRootY), T.root);

    // lean (about the hips): breath scale, body turn skew, body lean rotation
    const br = p.ParamBreath;
    affScale(T.lean, 1 + 0.008 * br, 1 + 0.016 * br, hx, hy);
    const skew = (p.ParamBodyAngleX / 10) * 0.075;
    // x' = x + skew * (y - hy), with a slight compression of the far side
    const sk = T.tmp;
    sk[0] = 1 - Math.abs(skew) * 0.25; sk[1] = 0; sk[2] = skew; sk[3] = 1; sk[4] = -skew * hy; sk[5] = 0;
    affMul(T.lean, sk, T.lean);
    affMul(T.lean, affRotate(T.tmp, p.ParamBodyAngleZ * DEG, hx, hy), T.lean);

    this.sitY = -0.066 * p.ParamSit;
    // body (children): root * sit * lean
    affMul(T.body, affTranslate(T.tmp, 0, this.sitY), T.lean);
    affMul(T.body, T.root, T.body);

    // head: rotation about the neck + a small lift when looking up
    const [nx, ny] = this.neck;
    affRotate(T.headLocal, p.ParamAngleZ * DEG, nx, ny);
    T.headLocal[5] += (p.ParamAngleY / 30) * 0.004;
    affMul(T.head, T.body, T.headLocal);

    // arms: shoulders rise a little with the breath
    affMul(T.arm, T.body, affTranslate(T.tmp, 0, 0.005 * br));

    // head warp amounts
    this.shiftX = (p.ParamAngleX / 30) * HEAD_TURN;
    this.shiftY = (p.ParamAngleY / 30) * HEAD_NOD;
  }

  /** Did this layer's inputs change since its last deformation? */
  changed(L, vals) {
    let s = L.sig;
    if (!s || s.length !== vals.length) {
      L.sig = Float64Array.from(vals);
      return true;
    }
    let diff = false;
    for (let i = 0; i < vals.length; i++) {
      if (Math.abs(s[i] - vals[i]) > 1e-7) { diff = true; s[i] = vals[i]; }
    }
    return diff;
  }

  // ---- fields ---------------------------------------------------------------------------------

  /** Head turn displacement field; writes into out[0..1]. */
  warp(x, y, depth, out) {
    const f = this.face;
    const u = (x - f.cx) / f.rx;
    const v = (y - f.cy) / f.ry;
    const r2 = u * u + v * v;
    let k = r2 < 1 ? 1 - r2 : 0;
    k = k * (1 - HEAD_GLOBAL) * depth + HEAD_GLOBAL;
    out[0] = x + this.shiftX * k;
    out[1] = y + this.shiftY * k;
    return out;
  }

  /** Body field (without root): lean fades out towards the feet, sit lowers the upper body. */
  bodyField(x, y, p, out) {
    const T = this.T;
    const w = smoothstep(0.02, 0.22, y);
    const lx = affApplyX(T.lean, x, y);
    const ly = affApplyY(T.lean, x, y);
    let ox = x + (lx - x) * w;
    let oy = y + (ly - y) * w;
    const sit = p.ParamSit;
    if (sit > 0) {
      // the belly settles onto the floor: bottom stays, top comes down, bottom widens
      oy += this.sitY * smoothstep(0.0, 0.26, y);
      ox *= 1 + 0.07 * sit * (1 - smoothstep(0.04, 0.3, y));
    }
    out[0] = ox;
    out[1] = oy;
    return out;
  }

  // ---- update -----------------------------------------------------------------------------

  update(p) {
    this.computeTransforms(p);
    const pup = this.puppet;
    for (const L of pup.layers) {
      // expression layers set their own opacity and skip the vertex work while hidden
      const fn = this[`deform_${L.name}`] || this.deformByGroup(L);
      if (fn.call(this, L, p)) pup.commit(L);
    }
    this.updateOrders(p);
  }

  deformByGroup(L) {
    // unknown layer (art re-rendered with new parts): rigid with the head or the body
    const cy = L.def.y0 + L.def.h / 2;
    return cy > this.neck[1] ? this.deformRigidHead : this.deformRigidBody;
  }

  writeAffine(L, m) {
    const r = L.rest;
    const o = L.pos;
    for (let i = 0, n = r.length / 2; i < n; i++) {
      const x = r[i * 2];
      const y = r[i * 2 + 1];
      o[i * 3] = m[0] * x + m[2] * y + m[4];
      o[i * 3 + 1] = m[1] * x + m[3] * y + m[5];
    }
  }

  deformRigidBody(L) {
    if (!this.changed(L, this.T.body)) return false;
    this.writeAffine(L, this.T.body);
    return true;
  }

  deformRigidHead(L) {
    if (!this.changed(L, this.T.head)) return false;
    this.writeAffine(L, this.T.head);
    return true;
  }

  // body ----------------------------------------------------------------------------------------

  deform_Body(L, p) {
    const T = this.T;
    if (!this.changed(L, [...T.root, ...T.lean, p.ParamSit])) return false;
    const r = L.rest;
    const o = L.pos;
    const q = [0, 0];
    for (let i = 0, n = r.length / 2; i < n; i++) {
      this.bodyField(r[i * 2], r[i * 2 + 1], p, q);
      o[i * 3] = affApplyX(T.root, q[0], q[1]);
      o[i * 3 + 1] = affApplyY(T.root, q[0], q[1]);
    }
    return true;
  }

  deform_Scarf(L) {
    return this.deformRigidBody(L);
  }

  legs(L, p, side) {
    const T = this.T;
    if (!this.changed(L, [...T.root, ...T.lean, p.ParamSit])) return false;
    const sit = p.ParamSit;
    const lx = side * 0.078;
    const r = L.rest;
    const o = L.pos;
    const q = [0, 0];
    const sy = 1 - 0.46 * sit;
    const sx = 1 + 0.12 * sit;
    for (let i = 0, n = r.length / 2; i < n; i++) {
      const x = r[i * 2];
      const y = r[i * 2 + 1];
      let ax = lx + (x - lx) * sx + side * 0.024 * sit;
      let ay = y * sy;
      const wt = smoothstep(0.09, 0.23, y);
      if (wt > 0) {
        this.bodyField(x, y, p, q);
        ax += (q[0] - ax) * wt;
        ay += (q[1] - ay) * wt;
      }
      o[i * 3] = affApplyX(T.root, ax, ay);
      o[i * 3 + 1] = affApplyY(T.root, ax, ay);
    }
    return true;
  }

  deform_Leg_L(L, p) { return this.legs(L, p, 1); }
  deform_Leg_R(L, p) { return this.legs(L, p, -1); }

  /**
   * Skin with rotation interpolation: across a joint the vertex rotates about that joint by the
   * blended angle (radius preserved), so bends stay round instead of collapsing like LBS.
   * `sitField` lowers the result by the sit field (tail: its bottom stays on the floor).
   */
  skin(L, chain, bind, post, sitField = false) {
    const M = chain.M;
    const th = chain.theta;
    const J = chain.J;
    const jp = chain.jp;
    const r = L.rest;
    const o = L.pos;
    const { a, b, t } = bind;
    const sitY = sitField ? this.sitY : 0;
    for (let i = 0, n = r.length / 2; i < n; i++) {
      const x = r[i * 2];
      const y = r[i * 2 + 1];
      const ia = a[i];
      const w = t[i];
      let px;
      let py;
      if (w > 0) {
        const ang = th[ia] + (th[b[i]] - th[ia]) * w;
        const c = Math.cos(ang);
        const sn = Math.sin(ang);
        const jx = J[ia][0];
        const jy = J[ia][1];
        const qx = ia === 0 ? jx : jp[ia][0];
        const qy = ia === 0 ? jy : jp[ia][1];
        px = qx + c * (x - jx) - sn * (y - jy);
        py = qy + sn * (x - jx) + c * (y - jy);
      } else {
        const ma = M[ia];
        px = ma[0] * x + ma[2] * y + ma[4];
        py = ma[1] * x + ma[3] * y + ma[5];
      }
      if (sitY) py += sitY * (smoothstep(0.0, 0.26, y) - 1);
      o[i * 3] = post[0] * px + post[2] * py + post[4];
      o[i * 3 + 1] = post[1] * px + post[3] * py + post[5];
    }
  }

  deform_Tail(L, p) {
    const ch = this.chains.tail;
    const bind = this.binds.Tail;
    if (!ch || !bind) return this.deformRigidBody(L);
    const ang = this.angles;
    let prev = 0;
    for (let i = 0; i < ch.n; i++) {
      const abs = (p[`PhysTail${Math.min(i, 4)}`] || 0) * DEG;
      ang[i] = abs - prev;
      prev = abs;
    }
    if (!this.changed(L, [...this.T.body, ...ang.subarray(0, ch.n), this.sitY])) return false;
    ch.pose(ang);
    this.skin(L, ch, bind, this.T.body, true);
    return true;
  }

  arm(L, p, s) {
    const ch = this.chains[`arm_${s}`];
    const bind = this.binds[L.name];
    if (!ch || !bind) return this.deformRigidBody(L);
    const side = s === 'L' ? 1 : -1;
    const ang = this.angles;
    ang[0] = side * p[`ParamArm${s}A`] * DEG;
    ang[1] = side * p[`ParamArm${s}B`] * DEG;
    ang[2] = side * p[`ParamArm${s}C`] * DEG;
    if (!this.changed(L, [...this.T.arm, ang[0], ang[1], ang[2]])) return false;
    ch.pose(ang);
    this.skin(L, ch, bind, this.T.arm);
    return true;
  }

  deform_Arm_L(L, p) { return this.arm(L, p, 'L'); }
  deform_Arm_R(L, p) { return this.arm(L, p, 'R'); }

  deform_ScarfFlap(L, p) {
    const ch = this.chains.flap;
    const bind = this.binds.ScarfFlap;
    if (!ch || !bind) return this.deformRigidBody(L);
    const a = (p.ParamFlap + p.PhysFlap) * DEG;
    const ang = this.angles;
    ang[0] = a * 0.7;
    ang[1] = a * 0.45;
    if (!this.changed(L, [...this.T.body, ang[0], ang[1]])) return false;
    ch.pose(ang);
    this.skin(L, ch, bind, this.T.body);
    return true;
  }

  // head -------------------------------------------------------------------------------------

  deform_Head(L) {
    const T = this.T;
    if (!this.changed(L, [...T.head, this.shiftX, this.shiftY])) return false;
    const r = L.rest;
    const o = L.pos;
    const q = [0, 0];
    for (let i = 0, n = r.length / 2; i < n; i++) {
      this.warp(r[i * 2], r[i * 2 + 1], 1, q);
      o[i * 3] = affApplyX(T.head, q[0], q[1]);
      o[i * 3 + 1] = affApplyY(T.head, q[0], q[1]);
    }
    return true;
  }

  ear(L, p, s) {
    const ch = this.chains[`ear_${s}`];
    const bind = this.binds[L.name];
    const side = s === 'L' ? 1 : -1;
    const T = this.T;
    // the ears ride on the top of the head (which barely moves in the turn field), drifting a
    // touch against the turn; the far ear narrows a little
    const ax = p.ParamAngleX / 30;
    const post = T.tmp2;
    const piv = this.pv(`ear_${s}`, [side * 0.17, 0.79]);
    const far = Math.max(0, -side * ax);
    affScale(post, 1 - 0.16 * far + 0.04 * Math.max(0, side * ax), 1 - 0.03 * far, piv[0], piv[1]);
    post[4] += this.shiftX * (HEAD_GLOBAL - 0.05);
    post[5] += this.shiftY * (HEAD_GLOBAL - 0.08);
    affMul(post, T.head, post);
    if (!ch || !bind) {
      if (!this.changed(L, post)) return false;
      this.writeAffine(L, post);
      return true;
    }
    // the whole ear swings about the crown junction; the chain only bends the tip after it
    const base = (-side * p[`ParamEar${s}`] + p[`PhysEar${s}`]) * DEG;
    const hinge = this.earHinge[s];
    affMul(post, post, affRotate(T.tmp3, base, hinge[0], hinge[1]));
    const ang = this.angles;
    ang[0] = 0;
    ang[1] = (-side * p[`ParamEar${s}`] * 0.4 + p[`PhysEar${s}Tip`]) * DEG;
    if (!this.changed(L, [...post, ang[1]])) return false;
    ch.pose(ang);
    this.skin(L, ch, bind, post);
    return true;
  }

  deform_Ear_L(L, p) { return this.ear(L, p, 'L'); }
  deform_Ear_R(L, p) { return this.ear(L, p, 'R'); }

  /**
   * Face part: local scale (sx, sy) about (px, py) + offset (ox, oy), then the head warp with
   * the part's depth, then the head transform.
   */
  facePart(L, depth, px, py, sx, sy, ox, oy) {
    const T = this.T;
    if (!this.changed(L, [...T.head, this.shiftX, this.shiftY, px, py, sx, sy, ox, oy])) return false;
    const r = L.rest;
    const o = L.pos;
    const q = [0, 0];
    // warp is evaluated at the part centre (rigid part, no smearing), plus its local derivative
    // for the far-side compression (handled by sx)
    this.warp(px, py, depth, q);
    const dx = q[0] - px + ox;
    const dy = q[1] - py + oy;
    for (let i = 0, n = r.length / 2; i < n; i++) {
      const x = px + (r[i * 2] - px) * sx + dx;
      const y = py + (r[i * 2 + 1] - py) * sy + dy;
      o[i * 3] = affApplyX(T.head, x, y);
      o[i * 3 + 1] = affApplyY(T.head, x, y);
    }
    return true;
  }

  /** Horizontal scale of a face part on side `side` for the current head turn. */
  turnScale(side, amount = 1) {
    const ax = this.shiftX / HEAD_TURN; // -1..1
    if (!side) return 1 - 0.07 * Math.abs(ax) * amount;
    return 1 - 0.2 * Math.max(0, -side * ax) * amount + 0.05 * Math.max(0, side * ax) * amount;
  }

  eye(L, p, s) {
    const side = s === 'L' ? 1 : -1;
    const piv = this.pv(`eyeOpen_${s}`, [side * 0.118, 0.59]);
    const open = p[`ParamEye${s}Open`];
    const smile = smoothstep(0, 0.75, p.ParamEyeSmile);
    const sy = lerp(0.1, 1, smooth(open)) * lerp(1, 0.35, smile);
    const vis = smoothstep(0.1, 0.32, open) * (1 - smoothstep(0.35, 0.75, p.ParamEyeSmile));
    this.puppet.setOpacity(L, vis);
    if (!L.visible) return false;
    const pivY = piv[1] - 0.012; // lids meet a little below the centre
    return this.facePart(L, FACE_DEPTH[L.name] ?? 1, piv[0], pivY, this.turnScale(side), sy,
      p.ParamEyeBallX * 0.009, p.ParamEyeBallY * 0.007);
  }

  deform_Eye_L(L, p) { return this.eye(L, p, 'L'); }
  deform_Eye_R(L, p) { return this.eye(L, p, 'R'); }

  eyeHappy(L, p, s) {
    const side = s === 'L' ? 1 : -1;
    const piv = this.pv(`eyeHappy_${s}`, [side * 0.118, 0.59]);
    const k = smoothstep(0.3, 0.85, p.ParamEyeSmile);
    this.puppet.setOpacity(L, k);
    if (!L.visible) return false;
    const cy = L.def.y0 + L.def.h / 2;
    return this.facePart(L, FACE_DEPTH[L.name] ?? 1, piv[0], cy, this.turnScale(side), lerp(0.4, 1, k), 0, (1 - k) * -0.004);
  }

  deform_EyeHappy_L(L, p) { return this.eyeHappy(L, p, 'L'); }
  deform_EyeHappy_R(L, p) { return this.eyeHappy(L, p, 'R'); }

  eyeSleep(L, p, s) {
    const side = s === 'L' ? 1 : -1;
    const piv = this.pv(`eyeSleep_${s}`, [side * 0.118, 0.59]);
    const open = p[`ParamEye${s}Open`];
    const k = (1 - smoothstep(0.08, 0.3, open)) * (1 - smoothstep(0.3, 0.7, p.ParamEyeSmile));
    this.puppet.setOpacity(L, k);
    if (!L.visible) return false;
    const cy = L.def.y0 + L.def.h / 2;
    return this.facePart(L, FACE_DEPTH[L.name] ?? 1, piv[0], cy, this.turnScale(side), lerp(0.5, 1, k), 0, 0);
  }

  deform_EyeSleep_L(L, p) { return this.eyeSleep(L, p, 'L'); }
  deform_EyeSleep_R(L, p) { return this.eyeSleep(L, p, 'R'); }

  brow(L, p, s) {
    const side = s === 'L' ? 1 : -1;
    const piv = this.pv(`brow_${s}`, [side * 0.12, 0.667]);
    const k = p[`ParamBrow${s}`];
    this.puppet.setOpacity(L, smoothstep(0.02, 0.6, k));
    if (!L.visible) return false;
    return this.facePart(L, FACE_DEPTH[L.name] ?? 1, piv[0], piv[1], this.turnScale(side), 1,
      0, p.ParamBrowY * 0.012 + (1 - smooth(k)) * 0.008);
  }

  deform_Brow_L(L, p) { return this.brow(L, p, 'L'); }
  deform_Brow_R(L, p) { return this.brow(L, p, 'R'); }

  deform_Nose(L) {
    const d = L.def;
    return this.facePart(L, FACE_DEPTH.Nose, d.x0 + d.w / 2, d.y0 + d.h / 2, this.turnScale(0), 1, 0, 0);
  }

  deform_MouthSmile(L, p) {
    const o = p.ParamMouthOpen;
    this.puppet.setOpacity(L, 1 - smoothstep(0.18, 0.45, o));
    if (!L.visible) return false;
    const d = L.def;
    return this.facePart(L, FACE_DEPTH.MouthSmile, d.x0 + d.w / 2, d.y0 + d.h, this.turnScale(0, 1.3), 1 - 0.1 * o, 0, 0);
  }

  deform_MouthOpen(L, p) {
    const o = p.ParamMouthOpen;
    this.puppet.setOpacity(L, smoothstep(0.03, 0.28, o));
    if (!L.visible) return false;
    const d = L.def;
    return this.facePart(L, FACE_DEPTH.MouthOpen, d.x0 + d.w / 2, d.y0 + d.h, this.turnScale(0, 1.3) * lerp(0.75, 1, o),
      lerp(0.2, 1, smooth(o)), 0, 0);
  }

  // ---- draw order ------------------------------------------------------------------------------

  updateOrders(p) {
    const pup = this.puppet;
    const B = pup.byName;
    const front1 = (B.ScarfFlap?.baseOrder ?? 160) + 5; // above the flap + keyboard (+3), under the scarf
    const front2 = (pup.layers[pup.layers.length - 1]?.baseOrder ?? 300) + 5; // above every face part
    for (const s of ['L', 'R']) {
      const L = B[`Arm_${s}`];
      if (!L?.lower) continue;
      const lvl = Math.round(clamp(p[`ParamArm${s}Order`], 0, 2));
      const off = s === 'L' ? 0 : 1;
      L.lower.renderOrder = lvl === 0 ? L.baseOrder + 1 : lvl === 1 ? front1 + off : front2 + off;
    }
  }

  /** Posed position of a named chain joint / pivot in model space (for props & look-at). */
  point(name, out = [0, 0]) {
    const T = this.T;
    switch (name) {
      case 'headCenter': {
        const [x, y] = this.headCenter;
        out[0] = affApplyX(T.head, x + this.shiftX * 0.5, y + this.shiftY * 0.5);
        out[1] = affApplyY(T.head, x + this.shiftX * 0.5, y + this.shiftY * 0.5);
        return out;
      }
      case 'headTop': {
        const x = this.headCenter[0];
        const y = this.headCenter[1] + 0.24;
        out[0] = affApplyX(T.head, x, y);
        out[1] = affApplyY(T.head, x, y);
        return out;
      }
      case 'mouth': {
        const q = this.warp(0, 0.53, 1.2, [0, 0]);
        out[0] = affApplyX(T.head, q[0], q[1]);
        out[1] = affApplyY(T.head, q[0], q[1]);
        return out;
      }
      case 'chest': {
        const [x, y] = this.pv('chest', [0, 0.34]);
        out[0] = affApplyX(T.body, x, y - 0.06);
        out[1] = affApplyY(T.body, x, y - 0.06);
        return out;
      }
      case 'pawL': case 'pawR': {
        const ch = this.chains[`arm_${name.slice(-1)}`];
        if (!ch) return out;
        const j = ch.jp[2];
        const tip = ch.jp[3];
        const x = (j[0] + tip[0]) / 2;
        const y = (j[1] + tip[1]) / 2;
        out[0] = affApplyX(T.arm, x, y);
        out[1] = affApplyY(T.arm, x, y);
        return out;
      }
      case 'tailTip': {
        const ch = this.chains.tail;
        if (!ch) return out;
        const j = ch.jp[ch.n];
        out[0] = affApplyX(T.body, j[0], j[1]);
        out[1] = affApplyY(T.body, j[0], j[1]);
        return out;
      }
      case 'tailRoot': {
        const ch = this.chains.tail;
        const j = ch ? ch.J[0] : [0, 0.14];
        out[0] = affApplyX(T.body, j[0], j[1]);
        out[1] = affApplyY(T.body, j[0], j[1]);
        return out;
      }
      default: {
        const [x, y] = this.pv(name, [0, 0.5]);
        out[0] = affApplyX(T.body, x, y);
        out[1] = affApplyY(T.body, x, y);
        return out;
      }
    }
  }
}

