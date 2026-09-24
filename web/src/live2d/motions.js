// Motions for the puppet, in the spirit of Cubism motion3.json: per-parameter keyframe curves
// (monotone cubic, see math2d.makeCurve) plus an optional procedural overlay (oscillations such
// as waving, wagging, typing), timed events, and fade in / out. The MotionPlayer blends tracks
// over the idle base: a parameter a motion does not touch keeps the idle value, so breathing and
// sway continue underneath every one-shot.
import { makeCurve, smooth, smoothstep, clamp } from './math2d.js';

const TAU = Math.PI * 2;

// Arm poses [upper, forearm, paw] (degrees, + = raise outwards / up) and their draw order
// (0 rest, 1 over the flap / keyboard, 2 over the face).
export const ARM = {
  rest: [[0, 0, 0], 0],
  chest: [[-36, -54, -10], 1],
  heart: [[-30, -66, -20], 1],
  waveUp: [[84, 58, 12], 2],
  present: [[60, 30, 22], 0],
  reach: [[62, 50, 16], 2],
  shrug: [[35, 70, 22], 0],
  chin: [[-10, -158, -12], 2],
  cheek: [[-16, -150, -24], 2],
  type: [[-25, -35, -15], 1],
  jump: [[48, 22, 0], 0],
  balance: [[18, 10, 0], 0],
  crouch: [[-8, -12, 0], 0],
  tail: [[12, 12, 0], 0],
};

/**
 * Arm keys [[t, pose]] -> curves for ParamArm{S}A/B/C + a stepped draw-order curve. The order
 * steps up shortly after an arm starts moving and steps down just before it arrives.
 */
function armCurves(side, keys, out) {
  const P = (k) => (typeof k === 'string' ? ARM[k] : [k, 0]);
  const comps = ['A', 'B', 'C'];
  for (let c = 0; c < 3; c++) out[`ParamArm${side}${comps[c]}`] = keys.map(([t, k]) => [t, P(k)[0][c]]);
  const ord = [];
  for (let i = 0; i < keys.length; i++) {
    const [t, k] = keys[i];
    const o = P(k)[1];
    if (i === 0) { ord.push([t, o, 'step']); continue; }
    const [t0, k0] = keys[i - 1];
    const o0 = P(k0)[1];
    if (o === o0) continue;
    const ts = o > o0 ? t0 + 0.15 * (t - t0) : t - 0.08 * (t - t0);
    ord.push([ts, o, 'step']);
  }
  ord.push([keys[keys.length - 1][0] + 1e-3, P(keys[keys.length - 1][1])[1], 'step']);
  out[`ParamArm${side}Order`] = ord;
}

/** Build a motion from a readable description. */
function motion(name, d) {
  const keys = { ...(d.curves || {}) };
  if (d.arms) for (const [side, k] of Object.entries(d.arms)) armCurves(side, k, keys);
  const curves = {};
  for (const [param, k] of Object.entries(keys)) curves[param] = makeCurve(k);
  return {
    name,
    duration: d.duration,
    loop: !!d.loop,
    fadeIn: d.fadeIn ?? 0.3,
    fadeOut: d.fadeOut ?? 0.35,
    curves,
    proc: d.proc || null,
    events: (d.events || []).slice().sort((a, b) => a[0] - b[0]),
    lookAt: d.lookAt ?? 0.5, // pointer look-at weight while this motion plays
    blink: d.blink ?? true,
    priority: d.priority ?? 1,
    interruptible: d.interruptible ?? true,
    lookAtLogo: !!d.lookAtLogo,
  };
}

// small helpers for procedural overlays
const env = (t, a, b, c, d) => smoothstep(a, b, t) * (1 - smoothstep(c, d, t));
const hop = (s) => (s <= 0 || s >= 1 ? 0 : 4 * s * (1 - s)); // unit parabola

function waveArm(v, t, t0, t1, side = 'L', rate = 2.6) {
  const e = env(t, t0 - 0.1, t0 + 0.15, t1 - 0.2, t1 + 0.05);
  const ph = TAU * rate * (t - t0);
  v[`ParamArm${side}B`] += e * 22 * Math.sin(ph);
  v[`ParamArm${side}C`] += e * 16 * Math.sin(ph - 0.9);
  v.ParamAngleZ = (v.ParamAngleZ ?? 0) + e * 1.2 * Math.sin(ph - 0.4);
}

function talk(v, t, t0, t1, amount = 0.3) {
  const e = env(t, t0, t0 + 0.15, t1 - 0.2, t1);
  v.ParamMouthOpen = clamp((v.ParamMouthOpen ?? 0) + e * amount * (0.5 + 0.5 * Math.sin(TAU * 3.1 * t) * Math.sin(TAU * 1.3 * t + 1)), 0, 1);
}

/** Hop travel for Enter / Exit: `n` hops from x0 to x1 over [t0, t1]. */
function hops(v, t, t0, t1, x0, x1, n = 3, height = 0.06) {
  const s = clamp((t - t0) / (t1 - t0), 0, 1);
  const k = s * n;
  const i = Math.min(n - 1, Math.floor(k));
  const f = k - i;
  // each hop moves an equal share; ease within the hop so the fox lands, then pushes off
  const moved = (i + smooth(f)) / n;
  v.ParamRootX = x0 + (x1 - x0) * moved;
  const air = t > t0 && t < t1 ? hop(f) : 0;
  v.ParamRootY = air * height;
  // squash on the ground, stretch in the air
  const ground = t > t0 && t < t1 ? Math.exp(-((f < 0.5 ? f : 1 - f) ** 2) / 0.006) : 0;
  v.ParamSquash = (air > 0.15 ? 0.25 * air : 0) - 0.45 * ground * (t < t1 ? 1 : 0);
  v.ParamRootRot = (x1 > x0 ? -1 : 1) * 4 * Math.sin(Math.PI * f) * (t > t0 && t < t1 ? 1 : 0);
}

export const MOTIONS = {};
const def = (name, d) => { MOTIONS[name] = motion(name, d); };

// ---- one-shots ----------------------------------------------------------------------------

def('Idle_LookAround', {
  duration: 3.6, fadeIn: 0.5, fadeOut: 0.6, lookAt: 0,
  curves: {
    ParamAngleX: [[0, 0], [0.7, 20], [1.5, 19], [2.2, -17], [2.9, -16], [3.6, 0]],
    ParamAngleY: [[0, 0], [0.7, 4], [1.5, 6], [2.2, -2], [2.9, 0], [3.6, 0]],
    ParamEyeBallX: [[0, 0], [0.45, 0.85], [1.5, 0.8], [1.85, -0.85], [2.9, -0.8], [3.6, 0]],
    ParamBodyAngleX: [[0, 0], [0.8, 4], [1.5, 4], [2.3, -3.5], [2.9, -3], [3.6, 0]],
  },
});

def('Wave', {
  duration: 2.6, lookAt: 0.6,
  arms: {
    L: [[0, 'rest'], [0.45, 'waveUp'], [2.05, 'waveUp'], [2.6, 'rest']],
    R: [[0, 'rest'], [0.5, 'chest'], [2.05, 'chest'], [2.6, 'rest']],
  },
  curves: {
    ParamAngleZ: [[0, 0], [0.5, 4], [2.0, 3], [2.6, 0]],
    ParamAngleX: [[0, 0], [0.5, 5], [2.1, 4], [2.6, 0]],
    ParamBodyAngleZ: [[0, 0], [0.5, -2.5], [2.1, -2], [2.6, 0]],
    ParamMouthOpen: [[0, 0], [0.35, 0.75], [1.9, 0.7], [2.3, 0]],
    ParamEyeSmile: [[0, 0], [0.4, 0.25], [2.0, 0.25], [2.5, 0]],
    ParamTailSwing: [[0, 22], [0.4, 28], [2.2, 28], [2.6, 22]],
  },
  proc(t, v) {
    waveArm(v, t, 0.45, 2.05, 'L');
    talk(v, t, 0.35, 1.9, 0.25);
    v.ParamTailSwing += env(t, 0.3, 0.6, 1.9, 2.3) * 12 * Math.sin(TAU * 1.7 * t);
  },
});

def('Happy', {
  duration: 2.4,
  arms: {
    L: [[0, 'rest'], [0.35, 'chest'], [1.95, 'chest'], [2.4, 'rest']],
    R: [[0, 'rest'], [0.35, 'chest'], [1.95, 'chest'], [2.4, 'rest']],
  },
  curves: {
    ParamEyeSmile: [[0, 0], [0.3, 1], [2.0, 1], [2.4, 0]],
    ParamAngleZ: [[0, 0], [0.35, 6], [0.75, -4.5], [1.15, 5], [1.55, -3], [1.95, 2], [2.4, 0]],
    ParamBodyAngleZ: [[0, 0], [0.4, 3], [0.8, -2.5], [1.2, 2.5], [1.6, -1.5], [2.4, 0]],
    ParamAngleY: [[0, 0], [0.35, 6], [2.0, 4], [2.4, 0]],
    ParamMouthOpen: [[0, 0], [0.3, 0.3], [1.9, 0.3], [2.3, 0]],
    ParamEarL: [[0, 0], [0.35, 8], [2.0, 8], [2.4, 0]],
    ParamEarR: [[0, 0], [0.35, 8], [2.0, 8], [2.4, 0]],
  },
  proc(t, v) {
    // two little bounces
    const s1 = (t - 0.4) / 0.42;
    const s2 = (t - 0.95) / 0.42;
    v.ParamRootY = 0.03 * (hop(s1) + hop(s2));
    const land = (s) => Math.exp(-((s - 1) ** 2) / 0.012) + Math.exp(-(s ** 2) / 0.012);
    v.ParamSquash = 0.22 * (hop(s1) + hop(s2)) - 0.3 * Math.min(1, land(s1) + land(s2));
    v.ParamTailSwing = 22 + env(t, 0.2, 0.5, 1.9, 2.3) * 24 * Math.sin(TAU * 3 * t);
  },
});

def('Heart', {
  duration: 2.8,
  arms: {
    L: [[0, 'rest'], [0.45, 'heart'], [2.25, 'heart'], [2.8, 'rest']],
    R: [[0, 'rest'], [0.45, 'heart'], [2.25, 'heart'], [2.8, 'rest']],
  },
  curves: {
    ParamEyeSmile: [[0, 0], [0.4, 1], [2.3, 1], [2.75, 0]],
    ParamAngleZ: [[0, 0], [0.5, 6], [1.4, 4.5], [2.2, 5], [2.8, 0]],
    ParamBodyAngleZ: [[0, 0], [0.5, 2.5], [2.2, 2], [2.8, 0]],
    ParamAngleY: [[0, 0], [0.5, 5], [2.2, 3], [2.8, 0]],
    ParamSquash: [[0, 0], [0.45, -0.18], [0.62, 0.14], [0.85, 0], [2.8, 0]],
    ParamEarL: [[0, 0], [0.5, 10], [2.2, 10], [2.8, 0]],
    ParamEarR: [[0, 0], [0.5, 10], [2.2, 10], [2.8, 0]],
  },
  proc(t, v) {
    v.ParamTailSwing = 22 + env(t, 0.4, 0.7, 2.2, 2.6) * 16 * Math.sin(TAU * 2.2 * t);
  },
  events: [[0.55, 'heart']],
});

def('Present', {
  duration: 2.7, lookAt: 0, lookAtLogo: true,
  arms: {
    R: [[0, 'rest'], [0.5, 'present'], [2.1, 'present'], [2.7, 'rest']],
    L: [[0, 'rest'], [0.55, 'chest'], [2.1, 'chest'], [2.7, 'rest']],
  },
  curves: {
    ParamAngleX: [[0, 0], [0.5, -20], [2.1, -18], [2.7, 0]],
    ParamAngleZ: [[0, 0], [0.5, 5], [2.1, 4], [2.7, 0]],
    ParamAngleY: [[0, 0], [0.5, 3], [2.1, 3], [2.7, 0]],
    ParamEyeBallX: [[0, 0], [0.4, -0.8], [2.1, -0.8], [2.7, 0]],
    ParamBodyAngleX: [[0, 0], [0.5, -5], [2.1, -4], [2.7, 0]],
    ParamBodyAngleZ: [[0, 0], [0.5, 2], [2.1, 2], [2.7, 0]],
    ParamEyeSmile: [[0, 0], [0.5, 0.2], [2.1, 0.2], [2.7, 0]],
  },
  proc(t, v) {
    const e = env(t, 0.5, 0.7, 1.9, 2.1);
    v.ParamArmRC += e * 7 * Math.sin(TAU * 1.2 * (t - 0.5));
    v.ParamArmRA += e * 3 * Math.sin(TAU * 1.2 * (t - 0.5) + 0.6);
  },
  events: [[0.25, 'logoGlow']],
});

def('Reach', {
  duration: 2.9, lookAt: 0, lookAtLogo: true,
  arms: {
    R: [[0, 'rest'], [0.55, 'reach'], [2.15, 'reach'], [2.9, 'rest']],
    L: [[0, 'rest'], [0.55, 'balance'], [2.15, 'balance'], [2.9, 'rest']],
  },
  curves: {
    ParamRootY: [[0, 0], [0.25, 0], [0.55, 0.022], [2.1, 0.022], [2.5, 0], [2.9, 0]],
    ParamSquash: [[0, 0], [0.25, -0.2], [0.55, 0.3], [2.05, 0.26], [2.45, -0.12], [2.9, 0]],
    ParamAngleY: [[0, 0], [0.5, 16], [2.1, 14], [2.9, 0]],
    ParamAngleX: [[0, 0], [0.5, -16], [2.1, -14], [2.9, 0]],
    ParamEyeBallX: [[0, 0], [0.4, -0.7], [2.1, -0.7], [2.8, 0]],
    ParamEyeBallY: [[0, 0], [0.4, 0.7], [2.1, 0.7], [2.8, 0]],
    ParamBodyAngleZ: [[0, 0], [0.55, 4.5], [2.1, 4], [2.9, 0]],
    ParamMouthOpen: [[0, 0], [0.5, 0.35], [2.0, 0.35], [2.5, 0]],
    ParamEarL: [[0, 0], [0.5, -6], [2.1, -6], [2.9, 0]],
    ParamEarR: [[0, 0], [0.5, -6], [2.1, -6], [2.9, 0]],
  },
  proc(t, v) {
    const e = env(t, 0.55, 0.8, 1.9, 2.15);
    v.ParamArmRA += e * 5 * Math.sin(TAU * 1.6 * (t - 0.55));
    v.ParamArmRC += e * 9 * Math.sin(TAU * 1.6 * (t - 0.55) - 0.8);
  },
  events: [[0.5, 'logo']],
});

def('Shrug', {
  duration: 2.4,
  arms: {
    L: [[0, 'rest'], [0.45, 'shrug'], [1.9, 'shrug'], [2.4, 'rest']],
    R: [[0, 'rest'], [0.45, 'shrug'], [1.9, 'shrug'], [2.4, 'rest']],
  },
  curves: {
    ParamBrowL: [[0, 0], [0.3, 1], [2.0, 1], [2.4, 0]],
    ParamBrowR: [[0, 0], [0.3, 1], [2.0, 1], [2.4, 0]],
    ParamBrowY: [[0, 0], [0.45, 0.5], [1.9, 0.4], [2.4, 0]],
    ParamAngleZ: [[0, 0], [0.45, 6], [1.9, 5], [2.4, 0]],
    ParamAngleY: [[0, 0], [0.45, 4], [1.9, 3], [2.4, 0]],
    ParamEyeBallX: [[0, 0], [0.4, 0.5], [1.9, 0.5], [2.4, 0]],
    ParamEyeBallY: [[0, 0], [0.4, 0.4], [1.9, 0.4], [2.4, 0]],
    ParamBodyAngleZ: [[0, 0], [0.45, 2], [1.9, 2], [2.4, 0]],
    ParamSquash: [[0, 0], [0.4, 0.15], [0.7, -0.08], [1.0, 0.04], [1.9, 0], [2.4, 0]],
    ParamMouthOpen: [[0, 0], [0.45, 0.12], [1.9, 0.12], [2.4, 0]],
  },
});

def('Jump', {
  duration: 1.35, lookAt: 0.3, priority: 3, interruptible: false,
  arms: {
    L: [[0, 'rest'], [0.18, 'crouch'], [0.4, 'jump'], [0.85, 'jump'], [1.05, 'crouch'], [1.35, 'rest']],
    R: [[0, 'rest'], [0.18, 'crouch'], [0.4, 'jump'], [0.85, 'jump'], [1.05, 'crouch'], [1.35, 'rest']],
  },
  curves: {
    ParamEyeSmile: [[0, 0], [0.3, 0.8], [0.9, 0.8], [1.25, 0]],
    ParamMouthOpen: [[0, 0], [0.3, 0.7], [0.9, 0.4], [1.2, 0]],
    ParamAngleY: [[0, 0], [0.18, -8], [0.45, 10], [0.9, -4], [1.35, 0]],
    ParamEarL: [[0, 0], [0.2, -8], [0.5, 10], [1.0, 0]],
    ParamEarR: [[0, 0], [0.2, -8], [0.5, 10], [1.0, 0]],
  },
  proc(t, v) {
    const t0 = 0.22;
    const t1 = 0.92;
    const s = (t - t0) / (t1 - t0);
    v.ParamRootY = 0.13 * hop(s);
    // anticipation squash, launch stretch, landing squash, settle
    const pre = Math.exp(-((t - 0.17) ** 2) / 0.004);
    const land = Math.exp(-((t - 0.97) ** 2) / 0.004);
    const air = s > 0 && s < 1 ? 0.5 * (1 - hop(s)) * (s < 0.5 ? 1 : 0.6) : 0;
    v.ParamSquash = -0.55 * pre - 0.5 * land + air + 0.08 * Math.exp(-((t - 1.12) ** 2) / 0.004);
  },
});

def('LookBack', {
  duration: 2.7, lookAt: 0,
  arms: { L: [[0, 'rest'], [0.5, 'tail'], [2.1, 'tail'], [2.7, 'rest']] },
  curves: {
    ParamAngleX: [[0, 0], [0.5, 28], [2.0, 26], [2.7, 0]],
    ParamBodyAngleX: [[0, 0], [0.5, 8], [2.0, 7], [2.7, 0]],
    ParamAngleY: [[0, 0], [0.5, -10], [2.0, -8], [2.7, 0]],
    ParamAngleZ: [[0, 0], [0.5, -6], [2.0, -5], [2.7, 0]],
    ParamEyeBallX: [[0, 0], [0.4, 1], [2.1, 1], [2.7, 0]],
    ParamEyeBallY: [[0, 0], [0.4, -0.5], [2.1, -0.5], [2.7, 0]],
    ParamTailSwing: [[0, 22], [0.45, 55], [0.85, 0], [1.25, 50], [1.65, 8], [2.05, 40], [2.7, 22]],
    ParamEyeSmile: [[0, 0], [1.2, 0], [1.6, 0.6], [2.2, 0.6], [2.7, 0]],
  },
});

def('Pet', {
  duration: 3.2, loop: true, lookAt: 0, fadeIn: 0.3,
  arms: {
    L: [[0, 'chest'], [3.2, 'chest']],
    R: [[0, 'chest'], [3.2, 'chest']],
  },
  curves: {
    ParamEyeSmile: [[0, 1], [3.2, 1]],
    ParamEarL: [[0, 15], [3.2, 15]],
    ParamEarR: [[0, 15], [3.2, 15]],
    ParamMouthOpen: [[0, 0.15], [3.2, 0.15]],
    ParamAngleY: [[0, -4], [3.2, -4]],
  },
  proc(t, v) {
    v.ParamTailSwing = 22 + 26 * Math.sin(TAU * 3.2 * t);
    v.ParamAngleZ = 6 * Math.sin((TAU * t) / 1.6);
    v.ParamBodyAngleZ = 2.5 * Math.sin((TAU * t) / 1.6 - 0.5);
    v.ParamSquash = -0.06 + 0.05 * Math.sin((TAU * t) / 0.8);
  },
});

// ---- sitting ------------------------------------------------------------------------------

def('SitDown', {
  duration: 1.0, fadeIn: 0.25, fadeOut: 0.5, interruptible: false, priority: 2,
  curves: {
    ParamSit: [[0, 0], [0.8, 1], [1.0, 1]],
    ParamSquash: [[0, 0], [0.3, -0.12], [0.75, -0.18], [1.0, 0]],
    ParamAngleY: [[0, 0], [0.5, -6], [1.0, 0]],
    ParamTailSwing: [[0, 22], [0.8, 36], [1.0, 36]],
  },
  arms: {
    L: [[0, 'rest'], [0.5, 'crouch'], [1.0, 'rest']],
    R: [[0, 'rest'], [0.5, 'crouch'], [1.0, 'rest']],
  },
});

def('StandUp', {
  duration: 0.9, fadeIn: 0.4, fadeOut: 0.4, interruptible: false, priority: 2,
  curves: {
    ParamSit: [[0, 1], [0.7, 0]],
    ParamSquash: [[0, 0], [0.3, -0.1], [0.6, 0.12], [0.9, 0]],
    ParamAngleY: [[0, 0], [0.3, 6], [0.9, 0]],
    ParamTailSwing: [[0, 36], [0.7, 22]],
    ParamEyeLOpen: [[0, 1], [0.9, 1]],
    ParamEyeROpen: [[0, 1], [0.9, 1]],
  },
  arms: {
    L: [[0, 'rest'], [0.9, 'rest']],
    R: [[0, 'rest'], [0.9, 'rest']],
  },
});

def('Sit_Think', {
  duration: 6, loop: true, fadeIn: 0.7, lookAt: 0.25,
  arms: {
    R: [[0, 'chin'], [6, 'chin']],
    L: [[0, 'chest'], [6, 'chest']],
  },
  curves: {
    ParamSit: [[0, 1], [6, 1]],
    ParamBrowL: [[0, 1], [6, 1]],
    ParamTailSwing: [[0, 36], [6, 36]],
  },
  proc(t, v) {
    const ph = (TAU * t) / 6;
    v.ParamAngleZ = 5 + 1.5 * Math.sin(ph);
    v.ParamAngleX = -6 + 5 * Math.sin(ph + 0.8);
    v.ParamAngleY = 7 + 2 * Math.sin(ph * 2);
    v.ParamEyeBallX = 0.45 * Math.sin(ph + 0.3);
    v.ParamEyeBallY = 0.55;
    v.ParamArmRC += 4 * Math.sin(ph * 2);
    v.ParamTailSwing += 6 * Math.sin(ph * 1.5);
    v.ParamBrowY = 0.3 + 0.2 * Math.sin(ph);
  },
});

def('Sit_Doze', {
  duration: 5, loop: true, fadeIn: 0.9, lookAt: 0, blink: false,
  arms: {
    R: [[0, 'cheek'], [5, 'cheek']],
    L: [[0, 'chest'], [5, 'chest']],
  },
  curves: {
    ParamSit: [[0, 1], [5, 1]],
    ParamEyeLOpen: [[0, 0], [5, 0]],
    ParamEyeROpen: [[0, 0], [5, 0]],
    ParamTailSwing: [[0, 44], [5, 44]],
    ParamEarL: [[0, 10], [5, 10]],
    ParamEarR: [[0, 10], [5, 10]],
  },
  proc(t, v) {
    const ph = (TAU * t) / 5;
    v.ParamBreath = 0.5 + 0.5 * Math.sin(ph);
    v.ParamAngleY = -15 + 3 * Math.sin(ph - 0.6);
    v.ParamAngleZ = 6 + 1.5 * Math.sin(ph);
    v.ParamAngleX = -4;
    v.ParamBodyAngleZ = 1.5 * Math.sin(ph);
    v.ParamMouthOpen = 0.08 + 0.06 * Math.sin(ph);
  },
});

// ---- presence -----------------------------------------------------------------------------

const ENTER_X = 1.35; // model units right of the rest position: off screen at any aspect

def('Enter', {
  duration: 3.1, fadeIn: 0, lookAt: 0, priority: 2, interruptible: false,
  arms: {
    L: [[0, 'rest'], [1.55, 'rest'], [1.95, 'waveUp'], [2.65, 'waveUp'], [3.1, 'rest']],
    R: [[0, 'rest'], [1.55, 'rest'], [1.95, 'chest'], [2.65, 'chest'], [3.1, 'rest']],
  },
  curves: {
    ParamAngleX: [[0, -14], [1.4, -12], [1.8, 4], [2.7, 4], [3.1, 0]],
    ParamBodyAngleX: [[0, -4], [1.4, -4], [1.8, 0]],
    ParamEyeSmile: [[0, 0.5], [1.4, 0.5], [1.8, 0.2], [2.8, 0.2], [3.1, 0]],
    ParamMouthOpen: [[0, 0.3], [1.5, 0.3], [1.9, 0.7], [2.6, 0.6], [3.0, 0]],
    ParamAngleZ: [[0, 0], [1.6, 0], [2.0, -6], [2.7, -5], [3.1, 0]],
  },
  proc(t, v) {
    hops(v, t, 0, 1.5, ENTER_X, 0, 4, 0.055);
    waveArm(v, t, 1.95, 2.65, 'L', 2.8);
    v.ParamTailSwing = 22 + 10 * Math.sin(TAU * 2 * t);
  },
});

def('Exit', {
  duration: 2.9, lookAt: 0, priority: 2, interruptible: false,
  arms: {
    L: [[0, 'rest'], [0.4, 'waveUp'], [1.1, 'waveUp'], [1.45, 'rest']],
    R: [[0, 'rest'], [0.4, 'chest'], [1.1, 'chest'], [1.45, 'rest']],
  },
  curves: {
    ParamAngleX: [[0, 0], [0.4, 4], [1.1, 4], [1.5, 14], [2.9, 14]],
    ParamBodyAngleX: [[0, 0], [1.2, 0], [1.5, 4], [2.9, 4]],
    ParamMouthOpen: [[0, 0], [0.3, 0.7], [1.0, 0.6], [1.3, 0.2], [2.9, 0.2]],
    ParamEyeSmile: [[0, 0], [0.3, 0.3], [1.1, 0.3], [1.5, 0.5], [2.9, 0.5]],
    ParamAngleZ: [[0, 0], [0.4, -6], [1.1, -5], [1.5, 0]],
  },
  proc(t, v) {
    waveArm(v, t, 0.4, 1.1, 'L', 2.8);
    hops(v, t, 1.45, 2.9, 0, ENTER_X, 4, 0.055);
    v.ParamTailSwing = 22 + 10 * Math.sin(TAU * 2 * t);
  },
});

// ---- typing -------------------------------------------------------------------------------

def('Type', {
  duration: 4, loop: true, fadeIn: 0.35, lookAt: 0.15,
  arms: {
    L: [[0, 'type'], [4, 'type']],
    R: [[0, 'type'], [4, 'type']],
  },
  curves: {
    ParamAngleY: [[0, -12], [4, -12]],
    ParamEyeBallY: [[0, -0.7], [4, -0.7]],
  },
  proc(t, v) {
    const ph = TAU * 2 * t; // 2 taps per second per paw at rate 1
    v.ParamArmLB += 7 * Math.sin(ph);
    v.ParamArmLC += 9 * Math.sin(ph - 0.7);
    v.ParamArmRB += 7 * Math.sin(ph + Math.PI);
    v.ParamArmRC += 9 * Math.sin(ph + Math.PI - 0.7);
    v.ParamAngleX = 4 * Math.sin((TAU * t) / 4);
    v.ParamEyeBallX = 0.3 * Math.sin((TAU * t) / 4);
    v.ParamAngleZ = 1.5 * Math.sin((TAU * t) / 2);
  },
});

// ---- idle base --------------------------------------------------------------------------------

/** Always-on idle layer (breathing, sway, slow tail) written straight into the params. */
export function applyIdle(t, p, k = 1) {
  const s = (period, phase = 0) => Math.sin((TAU * t) / period + phase);
  p.ParamBreath = 0.5 + 0.5 * s(3.4);
  p.ParamBodyAngleZ = 1.3 * s(6.1) * k;
  // a slight turn towards the logo (screen left), like the 3D ref34 framing
  p.ParamBodyAngleX = -1.5 + 1.2 * s(7.3, 1) * k;
  p.ParamAngleZ = 1.5 + 2.2 * s(5.3, 0.5) * k;
  p.ParamAngleX = -5 + 3 * s(8.9) * k;
  p.ParamAngleY = 2 * s(6.7, 2) * k;
  p.ParamTailSwing = 27 + 8 * s(3.1, 0.4) * k + 4 * s(1.9) * k;
  p.ParamArmLA = 2.5 * s(3.4, 0.4) * k;
  p.ParamArmRA = 2.5 * s(3.4, 0.7) * k;
  p.ParamArmLB = 2 * s(3.4, 1.2) * k;
  p.ParamArmRB = 2 * s(3.4, 1.5) * k;
}

// ---- player -------------------------------------------------------------------------------------

/** Evaluate a motion at time t into `out` (plain object of param -> value). */
export function evaluate(m, t, out = {}) {
  for (const k in out) delete out[k];
  for (const [param, c] of Object.entries(m.curves)) out[param] = c(t);
  if (m.proc) {
    // procedural overlays add onto curve values; missing params start from 0
    const v = new Proxy(out, { get: (o, k) => (k in o ? o[k] : 0) });
    m.proc(t, v);
  }
  return out;
}

/**
 * Tracks with smoothstep fades. Newer tracks are applied on top of older ones; a track fading
 * out keeps playing (so it never freezes on its last frame while it blends away).
 */
export class MotionPlayer {
  constructor() {
    this.tracks = [];
    this.listeners = new Set();
    this.speed = 1;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, track, data) {
    for (const fn of this.listeners) fn(type, track, data);
  }

  /** Start `m` (a motion object), fading everything else out over `fade` seconds. */
  play(m, { fade = m.fadeIn, intent = m.name, speed = 1 } = {}) {
    for (const tr of this.tracks) this.fadeTrack(tr, 0, fade);
    const tr = {
      m, name: m.name, intent, t: 0, speed, w: fade > 0 ? 0 : 1, fade: null, ended: false, evCursor: 0, values: {},
      fadingOut: false,
    };
    if (fade > 0) this.fadeTrack(tr, 1, fade);
    this.tracks.push(tr);
    return tr;
  }

  fadeTrack(tr, to, dur) {
    if (to === 0) tr.fadingOut = true;
    if (dur <= 0) {
      tr.w = to;
      tr.fade = null;
      return;
    }
    tr.fade = { from: tr.w, to, t: 0, dur };
  }

  stopAll(fade = 0.35) {
    for (const tr of this.tracks) this.fadeTrack(tr, 0, fade);
  }

  clear() {
    this.tracks.length = 0;
  }

  /** The newest track that is not fading out. */
  get current() {
    for (let i = this.tracks.length - 1; i >= 0; i--) if (!this.tracks[i].fadingOut) return this.tracks[i];
    return null;
  }

  update(dt) {
    for (const tr of this.tracks) {
      const m = tr.m;
      const prevT = tr.t;
      tr.t += dt * tr.speed * this.speed;
      // events (loops wrap)
      if (m.events.length && !tr.fadingOut) {
        const d = m.duration;
        const a = m.loop ? prevT % d : prevT;
        let b = m.loop ? tr.t % d : tr.t;
        if (m.loop && b < a) b += d;
        for (const [et, name, data] of m.events) {
          for (const off of m.loop ? [0, d] : [0]) {
            const tt = et + off;
            if ((tt > a || (prevT === 0 && tt === 0)) && tt <= b) this.emit('event', tr, { name, data });
          }
        }
      }
      if (tr.fade) {
        tr.fade.t += dt;
        const s = smooth(Math.min(1, tr.fade.t / tr.fade.dur));
        tr.w = tr.fade.from + (tr.fade.to - tr.fade.from) * s;
        if (tr.fade.t >= tr.fade.dur) tr.fade = null;
      }
      // one-shot about to end: report it a fade-length early so the next motion blends in
      // while this one is still moving
      if (!m.loop && !tr.ended && !tr.fadingOut && tr.t >= m.duration - m.fadeOut) {
        tr.ended = true;
        this.emit('end', tr);
      }
    }
    this.tracks = this.tracks.filter((tr) => !(tr.fadingOut && !tr.fade && tr.w <= 1e-4));
  }

  /** Blend all tracks over the params (already holding the idle base). */
  apply(p) {
    let lookAt = 1;
    let blink = 1;
    for (const tr of this.tracks) {
      const m = tr.m;
      const t = m.loop ? tr.t % m.duration : Math.min(tr.t, m.duration);
      const v = evaluate(m, t, tr.values);
      const w = tr.w;
      if (w <= 0) continue;
      for (const k in v) if (k in p) p[k] += (v[k] - p[k]) * w;
      lookAt += (m.lookAt - lookAt) * w;
      blink += ((m.blink ? 1 : 0) - blink) * w;
    }
    return { lookAt, blink };
  }
}
