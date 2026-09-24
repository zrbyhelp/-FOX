// The 3D speech bubble (3D mode): a puffy cream "gummy" pillow living in the scene next to the
// fox's head. A rounded-rectangle extrusion with a big round bevel (soft bulging rim, real
// thickness), velvet sheen like the fox, lit by the stage lights and casting a light soft shadow;
// a small bevelled tail at the bottom corner nearest the fox points at its head; the line is
// printed on the front face. It always faces the camera, follows the head on a spring, pops in
// with an underdamped bounce (+ a little wobble), shrinks and fades out, and floats gently while
// up. The depth buffer is cleared just before it draws, so the fox or the logo never hide it.
//
// Rendering only: Bubble (bubble.js) decides what is said and when, picks the side of the head
// and hands this view a screen box every frame (the DOM bubble of 2D mode shares that logic).
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// The page's CJK font stack (style.css).
export const FONT_STACK = "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', system-ui, sans-serif";
const FONT_WEIGHT = 500;
const INK = '#6b3b22';
const CREAM = '#fffaf4';

// Sizes in world units (the fox is ~1 tall, its head ~0.62 wide).
const EM = 0.036; // font size: one line with its padding is ~0.11 tall
const LINE_H = 1.4; // line height (em)
const TRACK = 0.02; // letter spacing (em)
const PAD_X = 1.05; // text to the silhouette (em)
const PAD_Y = 0.82;
const MAX_EM = 12.5; // wrap width, as the DOM bubble (max-width: 12.5em; 11.5em on phones)
const MAX_EM_NARROW = 11.5;
const MAX_LINES = 2;
const RADIUS = 0.046; // corner radius of the silhouette
const WALL = 0.012; // straight part of the side wall
const BEVEL_T = 0.026; // bevel depth on each face ...
const BEVEL_S = 0.028; // ... and width in the plane (~45% of the thickness): a wide round rim
const THICK = WALL + 2 * BEVEL_T;
const WIDTH_STEP = 0.01; // geometry cache buckets
// Tail: pointing down from its pivot (inside the body, PIVOT_UP above the bottom edge), its tip
// bent a little towards the head. As thick as the body with its front face a hair behind the
// body's: the flat front flows on into the tail, only its sides crease into the rim.
const TAIL = { base: 0.1, tip: 0.032, len: 0.05, up: 0.03, wall: WALL, bevelT: BEVEL_T, bevelS: 0.0145, sink: 0.0015, bend: 0.012 };
const TAIL_INSET = RADIUS + 0.022; // tail base from the body's end: on the straight bottom edge
const PIVOT_UP = 0.024;
const TAIL_ROOM = 0.03; // how far the tail hangs below the body (layout)
const YAW = 0.17; // rad: turned a little towards the fox, so its thickness shows
// Placement / motion
const PULL = 0.26; // in front of the head, towards the camera
const MIN_FONT_PX = 15; // grow when the text would be smaller than this on screen (phones)
const MAX_BOOST = 2.2;
const FOLLOW = { w: 10, z: 0.72 }; // spring following the head (slight lag)
const FOLLOW_REDUCED = { w: 16, z: 1 };
const POP = { w: 15, z: 0.5 }; // underdamped pop-in: ~15% overshoot
const OUT_TIME = 0.22;
const FADE_IN = 0.2; // reduced motion
const BOB = 0.0032; // float amplitude (world units)

const easeInQuad = (x) => x * x;

// ---------------------------------------------------------------------------------------------
// Text: measure / wrap like the DOM bubble (CJK breaks anywhere, Latin words kept whole, no
// closing punctuation at a line start), at most two lines, balanced; a coverage texture.

let _ctx = null;
const ctx2d = () => (_ctx ??= document.createElement('canvas').getContext('2d'));
const fontAt = (px) => `${FONT_WEIGHT} ${px}px ${FONT_STACK}`;

function setFont(g, px) {
  g.font = fontAt(px);
  if ('letterSpacing' in g) g.letterSpacing = `${(TRACK * px).toFixed(2)}px`;
}

/** Width of a line in em. */
function measure(text) {
  const g = ctx2d();
  setFont(g, 100);
  return g.measureText(text).width / 100;
}

const NO_START = /^[\s、。，．,.!！?？:：;；~～…‥)）\]】」』》〉♪♫”’'"]/u;
const NO_END = /[(（[【「『《〈“‘]$/u;

let _seg;
/** Break units: words where the browser can segment Chinese (wraps between words), else characters. */
function tokenize(text) {
  _seg ??= typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('zh', { granularity: 'word' }) : null;
  if (_seg) return [..._seg.segment(text)].map((x) => x.segment);
  return text.match(/[A-Za-z0-9]+(?:['’.\-][A-Za-z0-9]+)*|\s+|[\s\S]/gu) || [];
}

function ellipsize(text, maxEm) {
  let chars = [...text];
  while (chars.length > 1 && measure(chars.join('') + '…') > maxEm) chars.pop();
  return chars.join('').trimEnd() + '…';
}

/** Lines of `text` for a bubble at most `maxEm` wide. */
export function wrapText(text, maxEm = MAX_EM) {
  const whole = text.trim();
  if (measure(whole) <= maxEm) return [whole];
  const toks = tokenize(whole);
  const join = (a, b) => toks.slice(a, b).join('').trim();
  // two lines as even as possible (a slightly longer first line reads best)
  let best = null;
  for (let i = 1; i < toks.length; i++) {
    if (NO_START.test(toks[i]) && !/^\s/.test(toks[i])) continue;
    if (NO_END.test(toks[i - 1])) continue;
    const a = join(0, i);
    const b = join(i);
    if (!a || !b) continue;
    const wa = measure(a);
    const wb = measure(b);
    if (wa > maxEm || wb > maxEm) continue;
    const score = Math.max(wa, wb) + (wb > wa ? 0.2 : 0);
    if (!best || score < best.score) best = { score, lines: [a, b] };
  }
  if (best) return best.lines;
  // too long for two lines: fill the first, cut the second with an ellipsis (line-clamp)
  const chars = [...whole];
  let n = 1;
  while (n < chars.length && measure(chars.slice(0, n + 1).join('')) <= maxEm) n++;
  while (n > 1 && NO_START.test(chars[n])) n--;
  const first = chars.slice(0, n).join('').trim();
  const rest = chars.slice(n).join('').trim();
  const lines = [first, measure(rest) <= maxEm ? rest : ellipsize(rest, maxEm)];
  return lines.slice(0, MAX_LINES);
}

/** White-on-black coverage of the lines (used as an alpha map: the ink colour stays exact). */
function textTexture(lines, emPx) {
  const pad = Math.ceil(emPx * 0.25);
  const widthEm = Math.max(...lines.map(measure));
  const lineH = LINE_H * emPx;
  const c = document.createElement('canvas');
  c.width = Math.ceil(widthEm * emPx) + 2 * pad;
  c.height = Math.ceil(lines.length * lineH) + 2 * pad;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  setFont(g, emPx);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const track = TRACK * emPx; // letter spacing trails the last glyph: centre without it
  lines.forEach((l, i) => g.fillText(l, c.width / 2 + track / 2, pad + (i + 0.5) * lineH + emPx * 0.02));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace; // coverage, not colour
  tex.anisotropy = 4;
  return { tex, w: (c.width / emPx) * EM, h: (c.height / emPx) * EM };
}

// ---------------------------------------------------------------------------------------------
// Geometry: silhouettes extruded with a big round bevel (bevelOffset = -bevelSize keeps the side
// wall on the silhouette), welded so the rim shades smoothly.

function roundedRect(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + h - r);
  s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
  s.lineTo(x + r, y + h);
  s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + r);
  s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

function puffy(shape, { wall, bevelT, bevelS, curveSegments = 10, bevelSegments = 8 }) {
  const ext = new THREE.ExtrudeGeometry(shape, {
    depth: wall, steps: 1, curveSegments, bevelEnabled: true, bevelSegments,
    bevelThickness: bevelT, bevelSize: bevelS, bevelOffset: -bevelS,
  });
  ext.deleteAttribute('normal');
  ext.deleteAttribute('uv');
  const geo = mergeVertices(ext, 1e-7);
  ext.dispose();
  geo.clearGroups();
  geo.translate(0, 0, -wall / 2); // centred on z = 0
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Tapered horn pointing down (-y) from the pivot, its round tip bent towards -x. */
function tailShape() {
  const { base, tip, len, up, bend } = TAIL;
  const p0 = new THREE.Vector2(0, up);
  const p2 = new THREE.Vector2(-bend, -(PIVOT_UP + len) + tip / 2);
  const p1 = new THREE.Vector2(bend * 0.35, (p0.y + p2.y) / 2);
  const curve = new THREE.QuadraticBezierCurve(p0, p1, p2);
  const left = [];
  const right = [];
  const N = 18;
  let n = new THREE.Vector2();
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const c = curve.getPoint(u);
    const d = curve.getTangent(u);
    n = new THREE.Vector2(-d.y, d.x); // left of the direction of travel
    const w = THREE.MathUtils.lerp(base, tip, Math.pow(u, 1.3)) / 2; // flared where it leaves the body
    left.push(c.clone().addScaledVector(n, w));
    right.push(c.clone().addScaledVector(n, -w));
  }
  // round tip: from the left side through the point to the right side
  const a0 = Math.atan2(n.y, n.x);
  const tipPts = [];
  for (let k = 1; k < 12; k++) {
    const a = a0 - (Math.PI * k) / 12;
    tipPts.push(new THREE.Vector2(p2.x + Math.cos(a) * (tip / 2), p2.y + Math.sin(a) * (tip / 2)));
  }
  // rounded base (hidden in the body's flat face whatever the tail's angle)
  const basePts = [];
  for (let k = 1; k < 8; k++) {
    const t = k / 8;
    basePts.push(new THREE.Vector2(THREE.MathUtils.lerp(right[0].x, left[0].x, t), up + Math.sin(Math.PI * t) * base * 0.22));
  }
  return { shape: new THREE.Shape([...left, ...tipPts, ...right.reverse(), ...basePts]), tipCentre: p2 };
}

// ---------------------------------------------------------------------------------------------

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _turn = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();

export class Bubble3D {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {THREE.PerspectiveCamera} o.camera
   * @param {HTMLCanvasElement} o.canvas
   * @param {boolean} [o.reducedMotion]  fade only: no pop, wobble or float
   */
  constructor({ scene, camera, canvas, reducedMotion = false }) {
    Object.assign(this, { camera, canvas, reducedMotion });
    // Bubble.place() tuning: beside the head at ear height (out, up: head radii), above it (top)
    this.layout = { out: 1.08, up: 0.6, top: 1.5, gap: 4, lean: 0.25 };

    this.bodyMat = new THREE.MeshPhysicalMaterial({
      name: 'SpeechBubble',
      color: CREAM,
      roughness: 0.86,
      metalness: 0,
      sheen: 0.85, // velvet, like the fox (no fur grain)
      sheenRoughness: 0.45,
      sheenColor: new THREE.Color('#ffdcc2'), // a whisper of warm orange on the rim
      specularIntensity: 0.2,
      envMapIntensity: 0.72, // less flat ambient: the lights model the rim light / dark
      emissive: new THREE.Color(CREAM),
      emissiveIntensity: 0.06,
      transparent: true, // fades out
    });
    this.textMat = new THREE.MeshBasicMaterial({
      name: 'SpeechBubbleText',
      color: INK,
      transparent: true,
      depthWrite: false,
      toneMapped: false, // exact ink colour
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });

    const { shape, tipCentre } = tailShape();
    this.tailTip = tipCentre;
    this.tailBend = Math.atan2(tipCentre.x, -tipCentre.y); // direction of the tip at rest (rad)
    this.geoCache = new Map();
    this.tailGeo = puffy(shape, { wall: TAIL.wall, bevelT: TAIL.bevelT, bevelS: TAIL.bevelS, curveSegments: 1 });

    this.root = new THREE.Group();
    this.root.name = 'SpeechBubble';
    this.root.visible = false;
    this.inner = new THREE.Group(); // offset so root's origin (the pop pivot) sits at the tail
    this.root.add(this.inner);
    this.body = new THREE.Mesh(this.bodyGeometry(0.3, 1), this.bodyMat);
    this.body.name = 'SpeechBubbleBody';
    this.tail = new THREE.Mesh(this.tailGeo, this.bodyMat);
    this.tail.name = 'SpeechBubbleTail';
    this.text = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.textMat);
    this.text.name = 'SpeechBubbleText';
    this.text.position.z = THICK / 2 + 0.0006;
    this.body.castShadow = this.tail.castShadow = true;
    this.body.receiveShadow = this.tail.receiveShadow = this.text.receiveShadow = false;
    // drawn last and on top: clear the depth buffer just before the body (then body, tail, text
    // depth-test only against each other)
    this.body.renderOrder = 30;
    this.tail.renderOrder = 31;
    this.text.renderOrder = 32;
    this.body.onBeforeRender = (renderer) => renderer.clearDepth();
    for (const m of [this.body, this.tail, this.text]) {
      m.frustumCulled = false;
      this.inner.add(m);
    }
    scene.add(this.root);

    this.state = 'hidden'; // 'in' | 'out' | 'hidden'
    this.t = 0; // s since shown
    this.outT = 0;
    this.pop = { s: 0, v: 0 };
    this.pos = new THREE.Vector3(); // body centre (world), on a spring towards target
    this.vel = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.centre = new THREE.Vector3(); // body centre as drawn
    this.fresh = true;
    this.boost = 1; // world scale that keeps the text readable (phones, zoomed out)
    this.ppu = 500; // CSS px per world unit at the bubble
    this.side = 'right';
    this.dims = { W: 0.3, H: 0.11, lines: 1 };
    this.pivot = new THREE.Vector2(); // pop pivot (body coords)
    this.tailX = 0;
    this.tailXGoal = 0;
    this.tailFlip = 1;
    this.aim = -0.9; // tail rotation (rad, 0 = straight down)
    this.aimGoal = -0.9;
    this.mouth = { x: 0, y: 0 }; // px the tail points at
    this.bounds = { vw: 1, vh: 1, edge: 10 };
    this.rect = null; // full-size screen rect (client px)
    this.textTex = null;
  }

  /** Body geometry for a width / line count (cached per width bucket). */
  bodyGeometry(W, lines) {
    const key = `${W.toFixed(2)}|${lines}`;
    let geo = this.geoCache.get(key);
    if (geo) {
      this.geoCache.delete(key); // most recently used last
    } else {
      const H = lines * LINE_H * EM + 2 * PAD_Y * EM;
      geo = puffy(roundedRect(W, H, Math.min(RADIUS, H / 2)), { wall: WALL, bevelT: BEVEL_T, bevelS: BEVEL_S });
      geo.userData = { W, H, lines };
    }
    this.geoCache.set(key, geo);
    for (const [k, g] of this.geoCache) {
      if (this.geoCache.size <= 8) break;
      if (g === geo || g === this.body?.geometry) continue;
      g.dispose();
      this.geoCache.delete(k);
    }
    return geo;
  }

  /** CSS px per world unit at `depth` in front of the camera. */
  pxPerUnit(depth) {
    const h = this.canvas.getBoundingClientRect().height || window.innerHeight;
    return h / (2 * Math.max(depth, 0.05) * Math.tan(THREE.MathUtils.degToRad(this.camera.getEffectiveFOV()) / 2));
  }

  /** Distance along the view axis from the camera to the bubble plane beside the head. */
  depthFor(world) {
    this.camera.getWorldDirection(_fwd);
    const d = _a.copy(world).sub(this.camera.position).dot(_fwd);
    return Math.max(d - PULL, d * 0.6);
  }

  /** CSS px per world unit at the bubble plane beside the head (anchor `a`). */
  sample(a) {
    if (a?.world) this.ppu = this.pxPerUnit(this.depthFor(a.world));
  }

  /** World scale that keeps the text at least MIN_FONT_PX on screen. */
  boostGoal() {
    return THREE.MathUtils.clamp(MIN_FONT_PX / (EM * this.ppu), 1, MAX_BOOST);
  }

  setText(text) {
    const narrow = window.innerWidth <= 480;
    const lines = wrapText(text, narrow ? MAX_EM_NARROW : MAX_EM);
    const widthEm = Math.max(...lines.map(measure));
    const W = Math.ceil((widthEm + 2 * PAD_X) * EM / WIDTH_STEP - 1e-6) * WIDTH_STEP;
    const geo = this.bodyGeometry(W, lines.length);
    this.body.geometry = geo;
    this.dims = geo.userData;
    // 2-2.5x the on-screen pixel density (mipmapped): crisp, no shimmer while it scales
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const emPx = THREE.MathUtils.clamp(Math.round(EM * this.boost * this.ppu * dpr * 2.3), 36, 128);
    const t = textTexture(lines, emPx);
    this.textTex?.dispose();
    this.textTex = t.tex;
    this.textMat.alphaMap = t.tex;
    this.textMat.needsUpdate = true;
    this.text.scale.set(t.w, t.h, 1);
    this.text.position.y = 0;
  }

  /** Make every program compile during the page warm-up (tiny and hidden from view). */
  warm(on) {
    if (on) {
      this.setText('…');
      this.root.visible = true;
      this.root.scale.setScalar(1e-4);
      this.root.position.set(0, 0.5, 0);
      this.setOpacity(1);
    } else {
      this.root.visible = false;
      this.state = 'hidden';
    }
  }

  show(text, a) {
    this.sample(a);
    this.boost = this.boostGoal();
    this.setText(text);
    this.state = 'in';
    this.t = 0;
    this.outT = 0;
    this.pop.s = this.reducedMotion ? 1 : 0;
    this.pop.v = 0;
    this.fresh = true;
    this.root.visible = true;
    this.setOpacity(this.reducedMotion ? 0 : 1);
  }

  leave() {
    if (this.state !== 'in') return;
    this.state = 'out';
    this.outT = 0;
  }

  hide() {
    this.state = 'hidden';
    this.root.visible = false;
    this.rect = null;
  }

  size(a) {
    this.sample(a);
    const k = this.boost * this.ppu;
    return { w: this.dims.W * k, h: this.dims.H * k, tail: TAIL_ROOM * k };
  }

  /** Pop pivot and tail placement for a side. */
  setSide(side) {
    const { W, H } = this.dims;
    const inset = Math.min(TAIL_INSET, W / 2);
    this.side = side;
    const x = side === 'left' ? W / 2 - inset : side === 'right' ? -W / 2 + inset : THREE.MathUtils.clamp(this.headLocalX(), -W / 2 + inset, W / 2 - inset);
    this.pivot.set(x, -H / 2 + PIVOT_UP);
    this.tailX = this.tailXGoal = x;
    this.inner.position.set(-x, -this.pivot.y, 0);
    this.aim = this.aimGoal;
  }

  /** Head x in body coordinates (for a tail above the head). */
  headLocalX() {
    const k = this.boost * this.ppu;
    return this.box ? (this.mouth.x - (this.box.x + this.box.w / 2)) / k : 0;
  }

  place(box, a, bounds) {
    this.box = box;
    this.bounds = bounds;
    // the tail points between the head centre and the mouth
    this.mouth = { x: a.x, y: a.y + a.r * 0.3 };
    // target: the box centre, on a plane in front of the head
    const rect = this.canvas.getBoundingClientRect();
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const depth = this.depthFor(a.world);
    _a.set(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1, 0.5).unproject(this.camera);
    const dir = _a.sub(this.camera.position).normalize();
    this.camera.getWorldDirection(_fwd);
    this.target.copy(this.camera.position).addScaledVector(dir, depth / Math.max(1e-3, dir.dot(_fwd)));
    if (this.fresh) {
      this.pos.copy(this.target);
      this.vel.set(0, 0, 0);
      this.setSide(box.side);
      this.fresh = false;
    } else if (box.side !== this.side) {
      // hop to the other side of the head with a small re-pop instead of flying across it
      this.pos.copy(this.target);
      this.vel.set(0, 0, 0);
      this.setSide(box.side);
      if (!this.reducedMotion && this.state === 'in') this.pop.s = Math.min(this.pop.s, 0.6);
    }
    if (box.side === 'top') {
      const inset = Math.min(TAIL_INSET, this.dims.W / 2);
      this.tailXGoal = THREE.MathUtils.clamp(this.headLocalX(), -this.dims.W / 2 + inset, this.dims.W / 2 - inset);
    }
  }

  setOpacity(o) {
    this.bodyMat.opacity = o;
    this.textMat.opacity = o;
    this.body.castShadow = this.tail.castShadow = o > 0.35;
  }

  update(dt, a) {
    if (this.state === 'hidden') return;
    this.t += dt;
    this.sample(a);
    this.boost += (this.boostGoal() - this.boost) * (1 - Math.exp(-dt * 6));
    const reduced = this.reducedMotion;

    // springs (sub-stepped: software GL may hand us 0.5 s frames)
    const f = reduced ? FOLLOW_REDUCED : FOLLOW;
    for (let left = dt; left > 1e-6;) {
      const h = Math.min(left, 1 / 120);
      left -= h;
      _b.copy(this.target).sub(this.pos).multiplyScalar(f.w * f.w).addScaledVector(this.vel, -2 * f.z * f.w);
      this.vel.addScaledVector(_b, h);
      this.pos.addScaledVector(this.vel, h);
      if (!reduced) {
        const acc = POP.w * POP.w * (1 - this.pop.s) - 2 * POP.z * POP.w * this.pop.v;
        this.pop.v += acc * h;
        this.pop.s += this.pop.v * h;
      }
    }

    let scale = this.pop.s;
    let opacity = 1;
    let rise = 0;
    if (reduced) {
      scale = 1;
      opacity = Math.min(1, this.t / FADE_IN);
    }
    if (this.state === 'out') {
      this.outT += dt;
      const u = Math.min(1, this.outT / OUT_TIME);
      opacity *= 1 - u;
      if (!reduced) {
        scale *= 1 - 0.25 * easeInQuad(u);
        rise = 0.014 * u;
      }
    }
    this.setOpacity(opacity);

    // orientation: face the camera (text upright on screen), wobble while popping, gentle float
    const sideSign = this.side === 'left' ? -1 : this.side === 'right' ? 1 : 0;
    let roll = 0;
    let bob = 0;
    if (!reduced) {
      roll = -0.2 * (1 - this.pop.s) * sideSign + 0.012 * Math.sin((this.t * 2 * Math.PI) / 3.4 + 0.7);
      bob = BOB * Math.sin((this.t * 2 * Math.PI) / 2.6);
    }
    const k = this.boost;
    // turned a little towards the fox (beside it: yaw; above it: pitch), then the roll
    const pitch = this.side === 'top' ? YAW * 0.6 : 0;
    _q.copy(this.camera.quaternion).multiply(_turn.setFromEuler(_euler.set(pitch, -YAW * sideSign, roll, 'YXZ')));
    _right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    _up.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    this.centre.copy(this.pos).addScaledVector(_up, (bob + rise) * k);

    // tail: slide (above the head) and turn towards the mouth, within a natural range
    this.tailX += (this.tailXGoal - this.tailX) * (1 - Math.exp(-dt * 10));
    this.compose(_q, k, scale);
    this.tail.getWorldPosition(_c).project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    const px = r.left + ((_c.x + 1) / 2) * r.width;
    const py = r.top + ((1 - _c.y) / 2) * r.height;
    const flip = this.side === 'left' ? -1 : this.side === 'right' ? 1 : this.mouth.x < px ? 1 : -1;
    const range = this.side === 'right' ? [-0.9, -0.2] : this.side === 'left' ? [0.2, 0.9] : [-0.6, 0.6];
    const want = THREE.MathUtils.clamp(Math.atan2(this.mouth.x - px, this.mouth.y - py), range[0], range[1]);
    this.aimGoal = want - flip * this.tailBend; // the tip leans by tailBend already
    this.aim += (this.aimGoal - this.aim) * (1 - Math.exp(-dt * 12));
    this.tailFlip = flip;

    // keep the whole bubble (at full size) inside the viewport, above the toolbar
    const rect = this.fullRect(_q, k);
    const { vw, vh, edge } = this.bounds;
    let dx = 0;
    let dy = 0;
    if (rect.x < edge) dx = edge - rect.x;
    else if (rect.x + rect.w > vw - edge) dx = Math.max(edge - rect.x, vw - edge - (rect.x + rect.w));
    if (rect.y < edge) dy = edge - rect.y;
    else if (rect.y + rect.h > vh - edge) dy = Math.max(edge - rect.y, vh - edge - (rect.y + rect.h));
    if (dx || dy) {
      const ppu = this.pxPerUnit(_a.copy(this.centre).sub(this.camera.position).dot(this.camera.getWorldDirection(_fwd)));
      this.centre.addScaledVector(_right, dx / ppu).addScaledVector(_up, -dy / ppu);
      rect.x += dx;
      rect.y += dy;
    }
    this.rect = rect;
    this.compose(_q, k, scale);
  }

  /** Root / tail transforms for the current state. */
  compose(q, k, scale) {
    this.root.quaternion.copy(q);
    // the pop pivot stays where it is at full size: the bubble grows out of its tail
    this.root.position.set(this.pivot.x * k, this.pivot.y * k, 0).applyQuaternion(q).add(this.centre);
    this.root.scale.setScalar(Math.max(1e-4, k * scale));
    this.inner.position.set(-this.pivot.x, -this.pivot.y, 0);
    this.tail.position.set(this.tailX, this.pivot.y, -TAIL.sink);
    this.tail.rotation.set(0, 0, this.aim);
    this.tail.scale.set(this.tailFlip, 1, 1);
    this.root.updateMatrixWorld(true);
  }

  /** Screen rect (client px) of the bubble at full size: body, tail tip and thickness. */
  fullRect(q, k) {
    const { W, H } = this.dims;
    // tail tip in body coordinates
    const tc = this.tailTip;
    const c = Math.cos(this.aim);
    const s = Math.sin(this.aim);
    const tx = this.tailX + (tc.x * this.tailFlip) * c - tc.y * s;
    const ty = this.pivot.y + (tc.x * this.tailFlip) * s + tc.y * c;
    const tr = TAIL.tip / 2;
    const x0 = Math.min(-W / 2, tx - tr);
    const x1 = Math.max(W / 2, tx + tr);
    const y0 = Math.min(-H / 2, ty - tr);
    const y1 = H / 2;
    // body coords -> world: centre + q * (k * p)
    _m.compose(this.centre, q, _s.setScalar(k));
    const r = this.canvas.getBoundingClientRect();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < 8; i++) {
      _c.set(i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? THICK / 2 : -THICK / 2).applyMatrix4(_m).project(this.camera);
      const x = r.left + ((_c.x + 1) / 2) * r.width;
      const y = r.top + ((1 - _c.y) / 2) * r.height;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  /** Projected screen rect {x, y, w, h} (client px, full size) and the number of text lines. */
  screenRect() {
    if (!this.rect) return null;
    return { ...this.rect, lines: this.dims.lines, visible: this.root.visible, scale: this.root.scale.x / this.boost };
  }

  dispose() {
    this.root.removeFromParent();
    for (const g of this.geoCache.values()) g.dispose();
    this.geoCache.clear();
    this.tailGeo.dispose();
    this.text.geometry.dispose();
    this.textTex?.dispose();
    this.bodyMat.dispose();
    this.textMat.dispose();
  }
}
