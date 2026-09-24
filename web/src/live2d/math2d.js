// Small 2D math kit for the Live2D-style puppet: affine transforms, easing, springs and
// monotone cubic keyframe interpolation. Everything is plain numbers / typed arrays so the
// per-frame deformation stays allocation free.

export const DEG = Math.PI / 180;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
export const smoothstep = (a, b, x) => smooth((x - a) / (b - a));
export const easeOutBack = (x, s = 1.7) => 1 + (s + 1) * (x - 1) ** 3 + s * (x - 1) ** 2;
export const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
export const easeOutCubic = (x) => 1 - (1 - x) ** 3;
export const easeInCubic = (x) => x * x * x;
/** Soft clamp to (-1, 1): linear near 0, saturating smoothly. */
export const softClamp = (x) => x / Math.sqrt(1 + x * x);

// ---- affine transforms --------------------------------------------------------------------
// A transform is a Float64Array(6) [a, b, c, d, tx, ty]:  x' = a x + c y + tx,  y' = b x + d y + ty

export function aff(out = new Float64Array(6)) {
  out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 1; out[4] = 0; out[5] = 0;
  return out;
}

export function affCopy(out, m) {
  for (let i = 0; i < 6; i++) out[i] = m[i];
  return out;
}

/** out = m * n (apply n first, then m). `out` may alias m or n. */
export function affMul(out, m, n) {
  const a = m[0] * n[0] + m[2] * n[1];
  const b = m[1] * n[0] + m[3] * n[1];
  const c = m[0] * n[2] + m[2] * n[3];
  const d = m[1] * n[2] + m[3] * n[3];
  const tx = m[0] * n[4] + m[2] * n[5] + m[4];
  const ty = m[1] * n[4] + m[3] * n[5] + m[5];
  out[0] = a; out[1] = b; out[2] = c; out[3] = d; out[4] = tx; out[5] = ty;
  return out;
}

/** Rotation by `ang` (radians, CCW) about (px, py). */
export function affRotate(out, ang, px = 0, py = 0) {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  out[0] = c; out[1] = s; out[2] = -s; out[3] = c;
  out[4] = px - c * px + s * py;
  out[5] = py - s * px - c * py;
  return out;
}

/** Scale (sx, sy) about (px, py). */
export function affScale(out, sx, sy, px = 0, py = 0) {
  out[0] = sx; out[1] = 0; out[2] = 0; out[3] = sy;
  out[4] = px - sx * px;
  out[5] = py - sy * py;
  return out;
}

export function affTranslate(out, tx, ty) {
  out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 1; out[4] = tx; out[5] = ty;
  return out;
}

export function affApplyX(m, x, y) { return m[0] * x + m[2] * y + m[4]; }
export function affApplyY(m, x, y) { return m[1] * x + m[3] * y + m[5]; }

export function affInvert(out, m) {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  const tx = -(a * m[4] + c * m[5]);
  const ty = -(b * m[4] + d * m[5]);
  out[0] = a; out[1] = b; out[2] = c; out[3] = d; out[4] = tx; out[5] = ty;
  return out;
}

/** Rotation angle of the transform's x axis (radians). */
export const affAngle = (m) => Math.atan2(m[1], m[0]);

// ---- springs --------------------------------------------------------------------------------

/**
 * Critically damped follower (no overshoot): x chases `target` with angular frequency `omega`.
 * Exact integration, so it is stable for any dt.
 */
export class Critical {
  constructor(x = 0, omega = 8) {
    this.x = x;
    this.v = 0;
    this.omega = omega;
  }

  step(target, dt, omega = this.omega) {
    const w = omega;
    const e = Math.exp(-w * dt);
    const d = this.x - target;
    const tmp = (this.v + w * d) * dt;
    this.x = target + (d + tmp) * e;
    this.v = (this.v - w * tmp) * e;
    return this.x;
  }

  reset(x = 0) {
    this.x = x;
    this.v = 0;
  }
}

// ---- keyframe curves ----------------------------------------------------------------------

/**
 * Keyframes [[t, v], ...] (t ascending) -> sampler using monotone cubic Hermite interpolation
 * (Fritsch-Carlson): flows through intermediate keys, never overshoots, zero slope at local
 * extremes and at the ends. A key may carry a third element: 'step' (hold until the next key)
 * or 'lin' (linear to the next key).
 */
export function makeCurve(keys) {
  const n = keys.length;
  const t = keys.map((k) => k[0]);
  const v = keys.map((k) => k[1]);
  const mode = keys.map((k) => k[2] || 'cubic');
  const m = new Array(n).fill(0);
  if (n > 2) {
    const d = [];
    for (let i = 0; i < n - 1; i++) d.push((v[i + 1] - v[i]) / Math.max(1e-6, t[i + 1] - t[i]));
    for (let i = 1; i < n - 1; i++) {
      if (d[i - 1] * d[i] <= 0) m[i] = 0;
      else {
        // weighted harmonic mean (keeps monotonicity with uneven key spacing)
        const h0 = t[i] - t[i - 1];
        const h1 = t[i + 1] - t[i];
        const w1 = 2 * h1 + h0;
        const w2 = h1 + 2 * h0;
        m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
      }
    }
  }
  const end = t[n - 1];
  function sample(time) {
    if (n === 0) return 0;
    if (time <= t[0]) return v[0];
    if (time >= end) return v[n - 1];
    let i = 0;
    // keys are few (< 20): linear scan is fine
    while (i < n - 2 && time >= t[i + 1]) i++;
    const h = t[i + 1] - t[i];
    const s = (time - t[i]) / h;
    if (mode[i] === 'step') return v[i];
    if (mode[i] === 'lin') return v[i] + (v[i + 1] - v[i]) * s;
    const s2 = s * s;
    const s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * v[i] + (s3 - 2 * s2 + s) * h * m[i] + (-2 * s3 + 3 * s2) * v[i + 1] + (s3 - s2) * h * m[i + 1];
  }
  sample.end = end;
  return sample;
}

/** Deterministic PRNG (mulberry32) with reseed. */
export function makeRng(seed = 1) {
  let s = seed >>> 0;
  const rng = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  rng.seed = (v) => { s = v >>> 0; };
  return rng;
}
