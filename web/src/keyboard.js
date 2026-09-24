// The floating "magic" keyboard the fox types on (built procedurally from spec.keyboard) and the
// controller that listens to the user's real keyboard (plus the toolbar demo for touch devices).
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { createBlobShadow } from './scene.js';
import { PALETTE } from './materials.js';

// 4 rows x 13.5 key units, seen from the typist (the fox). A key is a code, a list of codes
// (the first is the key's own, the rest land on it approximately) or {codes, w, accent}.
const ROWS = [
  [['Digit1', 'Backquote', 'Escape'], 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal',
    { codes: ['Backspace', 'Delete', 'Insert'], w: 1.5, accent: true }],
  [{ codes: ['Tab'], w: 1.5 }, 'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft', ['BracketRight', 'Backslash']],
  [{ codes: ['CapsLock'], w: 1.5 }, 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', ['Semicolon', 'Quote'],
    { codes: ['Enter', 'NumpadEnter'], w: 2, accent: true }],
  [{ codes: ['ShiftLeft'], w: 1.5 }, 'KeyZ', 'KeyX', 'KeyC', 'KeyV', { codes: ['Space'], w: 4 }, 'KeyB', 'KeyN', ['KeyM', 'Comma', 'Period', 'Slash'],
    { codes: ['ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'], w: 1, accent: true }],
];
const UNITS = 13.5;

const COLORS = {
  base: '#F6E5D1',
  cap: '#FFF7EE',
  accent: PALETTE.logoStar,
  pressed: '#FFC49A',
  sparkles: ['#FFB27A', '#F58D4E', '#FFE3B8', '#FFFFFF'],
};

const POP_IN = 0.42;
const POP_OUT = 0.3;
const MIN_PRESS = 0.075; // s a key stays down at least (visible even for very short taps)
const DESIGN_W = 0.34; // width the cap / margin / effect sizes below were drawn for (scaled from it)

const easeOutBack = (x, s = 1.9) => 1 + (s + 1) * (x - 1) ** 3 + s * (x - 1) ** 2;
const easeInBack = (x, s = 1.7) => (s + 1) * x ** 3 - s * x ** 2;
const easeOutCubic = (x) => 1 - (1 - x) ** 3;

function starTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.85)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  // concave 4-point star (same family as the logo star)
  g.beginPath();
  const r = 30;
  const k = 5;
  g.moveTo(32, 32 - r);
  g.quadraticCurveTo(32 + k, 32 - k, 32 + r, 32);
  g.quadraticCurveTo(32 + k, 32 + k, 32, 32 + r);
  g.quadraticCurveTo(32 - k, 32 + k, 32 - r, 32);
  g.quadraticCurveTo(32 - k, 32 - k, 32, 32 - r);
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Little twinkling stars for the pop in / out. */
class Sparkles {
  constructor(parent, count = 30) {
    const tex = starTexture();
    this.pool = [];
    for (let i = 0; i < count; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
      s.name = 'Sparkle';
      s.visible = false;
      s.userData = { life: -1, vel: new THREE.Vector3(), dur: 1, size: 0.02, spin: 0 };
      parent.add(s);
      this.pool.push(s);
    }
  }

  spawn(pos, vel, { size = 0.02, dur = 0.8, rng = Math.random } = {}) {
    const s = this.pool.find((p) => p.userData.life < 0);
    if (!s) return;
    const u = s.userData;
    s.position.copy(pos);
    u.vel.copy(vel);
    u.life = 0;
    u.dur = dur;
    u.size = size;
    u.spin = (rng() - 0.5) * 6;
    s.material.color.set(COLORS.sparkles[Math.floor(rng() * COLORS.sparkles.length)]);
    s.material.rotation = rng() * Math.PI;
    s.visible = true;
  }

  get active() {
    return this.pool.some((p) => p.userData.life >= 0);
  }

  update(dt) {
    for (const s of this.pool) {
      const u = s.userData;
      if (u.life < 0) continue;
      u.life += dt / u.dur;
      if (u.life >= 1) { u.life = -1; s.visible = false; continue; }
      s.position.addScaledVector(u.vel, dt);
      u.vel.multiplyScalar(Math.exp(-2.5 * dt));
      u.vel.y += 0.05 * dt;
      const l = u.life;
      const twinkle = 0.75 + 0.25 * Math.sin(l * 26);
      const sc = u.size * Math.sin(Math.PI * Math.min(1, l * 1.15)) * twinkle;
      s.scale.set(sc, sc, sc);
      s.material.rotation += u.spin * dt;
      s.material.opacity = Math.min(1, (1 - l) * 2.2);
    }
  }

  clear() {
    for (const s of this.pool) { s.userData.life = -1; s.visible = false; }
  }
}

/** Label that floats up from a pressed key (visible from the front, where the caps are not). */
function glyphFor(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return { Enter: '↵', NumpadEnter: '↵', Backspace: '←', Delete: '←', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']' }[code] || null;
}

class Glyphs {
  constructor(parent, count = 10) {
    this.cache = new Map();
    this.pool = [];
    for (let i = 0; i < count; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, opacity: 0 }));
      s.name = 'KeyGlyph';
      s.visible = false;
      s.userData = { life: -1, vel: new THREE.Vector3() };
      parent.add(s);
      this.pool.push(s);
    }
  }

  texture(ch) {
    if (this.cache.has(ch)) return this.cache.get(ch);
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.font = '700 44px "Baloo 2", "Arial Rounded MT Bold", "PingFang SC", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = 9;
    g.strokeStyle = '#ffffff';
    g.strokeText(ch, 32, 35);
    g.fillStyle = '#e8743c';
    g.fillText(ch, 32, 35);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.cache.set(ch, tex);
    return tex;
  }

  spawn(ch, pos, rng, toward, size = 0.05) {
    const s = this.pool.find((p) => p.userData.life < 0) || this.pool.reduce((a, b) => (a.userData.life > b.userData.life ? a : b));
    s.material.map = this.texture(ch);
    s.material.needsUpdate = true;
    s.position.copy(pos).addScaledVector(toward, 0.06); // in front of the paws
    s.userData.life = 0;
    s.userData.size = size;
    s.userData.vel.set((rng() - 0.5) * 0.06, 0.17 + rng() * 0.05, 0).addScaledVector(toward, 0.04);
    s.visible = true;
  }

  update(dt) {
    for (const s of this.pool) {
      const u = s.userData;
      if (u.life < 0) continue;
      u.life += dt / 0.85;
      if (u.life >= 1) { u.life = -1; s.visible = false; continue; }
      s.position.addScaledVector(u.vel, dt);
      u.vel.multiplyScalar(Math.exp(-1.5 * dt));
      const l = u.life;
      const sc = u.size * Math.min(1, l * 6) * (1 - 0.3 * l);
      s.scale.set(sc, sc, sc);
      s.material.opacity = Math.min(1, (1 - l) * 2.5);
    }
  }

  clear() {
    for (const s of this.pool) { s.userData.life = -1; s.visible = false; }
  }
}

export class MagicKeyboard {
  constructor({ spec, scene, rng = Math.random, reducedMotion = false }) {
    const k = spec.keyboard?.gltf || { position: [0, 0.222, 0.29], size: [0.48, 0.034, 0.18], tiltDeg: -12 };
    this.rng = rng;
    this.reducedMotion = reducedMotion;
    const [W, H, D] = k.size;
    this.size = { W, H, D };
    this.k = W / DESIGN_W; // detail scale: caps, gaps, sparkles and letters grow with the keyboard
    this.home = new THREE.Vector3().fromArray(k.position);

    this.group = new THREE.Group(); // position + float
    this.group.name = 'MagicKeyboard';
    this.group.position.copy(this.home);
    this.tilt = new THREE.Group(); // spec tilt + pop wobble
    this.tilt.rotation.x = THREE.MathUtils.degToRad(k.tiltDeg ?? 0);
    this.group.add(this.tilt);
    this.body = new THREE.Group(); // pop scale
    this.tilt.add(this.body);

    // Base: rounded cream slab like the logo cubes.
    const baseMat = new THREE.MeshPhysicalMaterial({
      color: COLORS.base, roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.3,
      specularIntensity: 0.4, sheen: 0.3, sheenRoughness: 0.6, sheenColor: new THREE.Color(0xffffff),
    });
    const base = new THREE.Mesh(new RoundedBoxGeometry(W, H, D, 4, Math.min(H * 0.48, 0.013 * this.k)), baseMat);
    base.name = 'KeyboardBase';
    base.castShadow = true;
    base.receiveShadow = true;
    this.body.add(base);

    // Orange star emblem on the viewer-facing edge.
    const star = new THREE.Mesh(
      new THREE.ExtrudeGeometry(starShape(H * 0.36), { depth: 0.002, bevelEnabled: true, bevelThickness: 0.0015, bevelSize: 0.0012, bevelSegments: 2, curveSegments: 8 }),
      new THREE.MeshPhysicalMaterial({ color: PALETTE.logoStar, roughness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.15 }),
    );
    star.name = 'KeyboardStar';
    star.geometry.center();
    star.position.set(0, 0, D / 2 + 0.0005);
    this.body.add(star);

    this.buildKeys(W, H, D);

    this.shadow = createBlobShadow({ radius: Math.max(W, D) * 0.62, opacity: 0.16 });
    this.shadow.scale.z = D / W + 0.35;
    this.sparkles = new Sparkles(scene);
    this.glyphs = new Glyphs(scene);
    this.viewDir = new THREE.Vector3(0, 0, 1);

    scene.add(this.group, this.shadow);
    this.mode = 'hidden'; // hidden | in | shown | out
    this.t = 0;
    this.scale = 0;
    this.time = 0;
    this.presses = 0;
    this.group.visible = false;
    this.shadow.visible = false;
  }

  buildKeys(W, H, D) {
    const k = this.k;
    const mx = 0.012 * k;
    const mz = 0.011 * k;
    const u = (W - 2 * mx) / UNITS;
    const pitch = (D - 2 * mz) / ROWS.length;
    const gap = 0.0042 * k;
    const capH = 0.0085 * Math.min(k, H / 0.028);
    const y = H / 2 + capH / 2 - 0.38 * capH; // caps sit in the top plate
    this.capTop = y + capH / 2;
    this.pressDepth = 0.42 * capH;
    this.rowZ = (r) => D / 2 - mz - pitch * (r + 0.5);
    this.keys = [];
    this.byCode = new Map();
    const geos = new Map();
    const geoFor = (w) => {
      if (!geos.has(w)) geos.set(w, new RoundedBoxGeometry(w * u - gap, capH, pitch - gap, 2, 0.0034 * k));
      return geos.get(w);
    };
    ROWS.forEach((row, r) => {
      // row 0 (digits) is farthest from the fox (+z), the typist's left is +x
      const z = this.rowZ(r);
      let x = W / 2 - mx;
      for (const item of row) {
        const key = typeof item === 'string' ? { codes: [item] } : Array.isArray(item) ? { codes: item } : { ...item };
        key.w = key.w ?? 1;
        key.pos = new THREE.Vector3(x - (key.w * u) / 2, y, z);
        key.row = r;
        key.press = 0;
        key.downUntil = 0;
        key.held = false;
        key.color = new THREE.Color(key.accent ? COLORS.accent : COLORS.cap);
        x -= key.w * u;
        for (const c of key.codes) this.byCode.set(c, key);
        this.keys.push(key);
      }
    });
    // One instanced mesh per key width.
    const capMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.36, clearcoat: 0.45, clearcoatRoughness: 0.25, specularIntensity: 0.45 });
    const widths = [...new Set(this.keys.map((k) => k.w))];
    this.capMeshes = [];
    const m = new THREE.Matrix4();
    for (const w of widths) {
      const keys = this.keys.filter((k) => k.w === w);
      const mesh = new THREE.InstancedMesh(geoFor(w), capMat, keys.length);
      mesh.name = `Keycaps_${w}u`;
      keys.forEach((k, i) => {
        k.mesh = mesh;
        k.index = i;
        mesh.setMatrixAt(i, m.makeTranslation(k.pos));
        mesh.setColorAt(i, k.color);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
      mesh.receiveShadow = true;
      this.body.add(mesh);
      this.capMeshes.push(mesh);
    }
    this._m = m;
    this._c = new THREE.Color();
    this._pressedColor = new THREE.Color(COLORS.pressed);
  }

  /** Key for a KeyboardEvent.code (unknown codes land on a stable pseudo-random key). */
  keyFor(code) {
    const k = this.byCode.get(code);
    if (k) return k;
    let h = 0;
    for (const ch of String(code)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const letters = this.keys.filter((key) => key.w === 1 && key.row > 0);
    return letters[h % letters.length];
  }

  get visible() {
    return this.mode !== 'hidden';
  }

  /** Fully out (not popping in / out). */
  get shown() {
    return this.mode === 'shown' || this.mode === 'in';
  }

  show() {
    if (this.mode === 'in' || this.mode === 'shown') return;
    // resume from the current scale if it was shrinking
    this.t = this.mode === 'out' ? (1 - this.scale) * POP_IN * 0.5 : 0;
    this.mode = 'in';
    this.group.visible = this.shadow.visible = true;
    this.burst(this.reducedMotion ? 6 : 16);
  }

  hide() {
    if (this.mode === 'hidden' || this.mode === 'out') return;
    this.mode = 'out';
    this.t = 0;
    this.burst(this.reducedMotion ? 5 : 12);
    for (const k of this.keys) k.held = false;
  }

  /** Press a key (keydown). Returns the key's side for the fox: 'L' (its left, +x) or 'R'. */
  press(code) {
    const k = this.keyFor(code);
    k.held = true;
    k.downUntil = this.time + MIN_PRESS;
    this.presses++;
    if (!this.reducedMotion && this.shown) {
      const p = this.body.localToWorld(k.pos.clone());
      p.y += 0.012;
      const ch = glyphFor(code);
      if (ch) this.glyphs.spawn(ch, p, this.rng, this.viewDir, 0.05 * Math.min(1.3, this.k));
      else this.sparkles.spawn(p, new THREE.Vector3((this.rng() - 0.5) * 0.08, 0.12 + this.rng() * 0.06, 0.03), { size: 0.014 * Math.sqrt(this.k), dur: 0.6, rng: this.rng });
    }
    return k.pos.x >= 0 ? 'L' : 'R';
  }

  release(code) {
    const k = this.byCode.get(code) || this.keyFor(code);
    if (k) k.held = false;
  }

  releaseAll() {
    for (const k of this.keys) k.held = false;
  }

  /** All keycaps back up, original colours. */
  resetCaps() {
    for (const k of this.keys) {
      k.press = 0;
      k.downUntil = 0;
      k.mesh.setMatrixAt(k.index, this._m.makeTranslation(k.pos));
      k.mesh.setColorAt(k.index, k.color);
    }
    for (const m of this.capMeshes) {
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor.needsUpdate = true;
    }
  }

  /** Keys currently (visibly) pressed. */
  get pressedCount() {
    return this.keys.filter((k) => k.press > 0.3).length;
  }

  worldCenter(v = new THREE.Vector3()) {
    return this.group.getWorldPosition(v);
  }

  /**
   * Where a paw taps (the keyboard's parent space, at rest: no float, no pop): the top of the
   * row nearest the fox (the short arms reach it comfortably), under its left ('L', +x) or
   * right paw. Aimed at by the typing fallback.
   */
  tapPoint(side, out = new THREE.Vector3()) {
    const x = (side === 'L' ? 1 : -1) * this.size.W * 0.35;
    out.set(x, this.capTop, this.rowZ(ROWS.length - 1)).applyAxisAngle(new THREE.Vector3(1, 0, 0), this.tilt.rotation.x);
    return out.add(this.home);
  }

  burst(n) {
    const { W, D } = this.size;
    const c = this.home;
    const sz = Math.sqrt(this.k); // bigger keyboard: a wider ring of slightly bigger stars
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + this.rng() * 0.4;
      const p = new THREE.Vector3(c.x + Math.cos(a) * W * 0.55, c.y + (this.rng() - 0.3) * 0.05, c.z + Math.sin(a) * D * 0.7);
      const v = new THREE.Vector3(Math.cos(a) * 0.22 * sz, 0.1 + this.rng() * 0.2, Math.sin(a) * 0.16 * sz);
      this.sparkles.spawn(p, v, { size: (0.016 + this.rng() * 0.016) * sz, dur: 0.55 + this.rng() * 0.4, rng: this.rng });
    }
  }

  /** Horizontal direction from the keyboard towards the camera (glyphs float that way). */
  setViewer(camera) {
    this.viewDir.set(camera.position.x - this.home.x, 0, camera.position.z - this.home.z).normalize();
  }

  update(dt) {
    this.time += dt;
    this.sparkles.update(dt);
    this.glyphs.update(dt);
    if (this.mode === 'hidden') return;
    this.t += dt;
    let s = 1;
    if (this.mode === 'in') {
      const x = Math.min(1, this.t / POP_IN);
      s = this.reducedMotion ? easeOutCubic(x) : easeOutBack(x);
      if (x >= 1) this.mode = 'shown';
    } else if (this.mode === 'out') {
      const x = Math.min(1, this.t / POP_OUT);
      s = 1 - (this.reducedMotion ? x : easeInBack(x));
      if (x >= 1) {
        this.mode = 'hidden';
        this.group.visible = this.shadow.visible = false;
        this.releaseAll();
        this.resetCaps();
        this.scale = 0;
        return;
      }
    }
    this.scale = s;
    this.body.scale.setScalar(Math.max(0.001, s));
    // pop-in wobble: mostly a roll; the yaw stays small so the wide keyboard's back corners never
    // swing into the fox's belly
    const wob = this.mode === 'in' && !this.reducedMotion ? (1 - Math.min(1, this.t / POP_IN)) : 0;
    this.body.rotation.set(0, 0.07 * wob * Math.sin(this.t * 14), 0.12 * wob * Math.cos(this.t * 11));
    this.group.position.copy(this.home);
    this.group.position.y += 0.0025 * Math.sin(this.time * 2.2);
    this.shadow.position.set(this.home.x, 0.002, this.home.z);
    this.shadow.scale.x = Math.max(0.001, s);
    this.shadow.material.opacity = this.shadow.userData.baseOpacity * Math.min(1, Math.max(0, s));

    // keycaps
    for (const k of this.keys) {
      const down = k.held || this.time < k.downUntil;
      const target = down ? 1 : 0;
      if (target === 0 && k.press === 0) continue;
      k.press = down ? Math.min(1, k.press + dt / 0.03) : Math.max(0, k.press - dt / 0.09);
      this._m.makeTranslation(k.pos.x, k.pos.y - this.pressDepth * k.press, k.pos.z);
      k.mesh.setMatrixAt(k.index, this._m);
      k.mesh.setColorAt(k.index, this._c.copy(k.color).lerp(this._pressedColor, 0.75 * k.press * (k.accent ? 0.4 : 1)));
      k.mesh.instanceMatrix.needsUpdate = true;
      k.mesh.instanceColor.needsUpdate = true;
    }
  }
}

function starShape(r) {
  const s = new THREE.Shape();
  const tips = [[0, r], [r, 0], [0, -r], [-r, 0]];
  s.moveTo(...tips[0]);
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = tips[i];
    const [bx, by] = tips[(i + 1) % 4];
    s.quadraticCurveTo(((ax + bx) / 2) * 0.28, ((ay + by) / 2) * 0.28, bx, by);
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// Typing controller

const IDLE_AFTER = 1.8; // s without keys before the keyboard goes away
const MODIFIERS = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight', 'Fn', 'FnLock', 'CapsLock', 'NumLock', 'ScrollLock', 'ContextMenu']);
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'OS', 'Fn', 'FnLock', 'Hyper', 'Super', 'CapsLock', 'NumLock', 'ScrollLock', 'AltGraph']);
const DEMO_TEXT = 'ni hao xiao hu li wo lai bang ni da zi ';
const TYPING_LINES = ['噼里啪啦…', '打字好快呀!'];

function isEditable(el) {
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el.isContentEditable;
}

function isControl(el) {
  return !!el && (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute?.('role') === 'button');
}

function codeFor(ch) {
  if (ch === ' ') return 'Space';
  if (/[a-z]/i.test(ch)) return `Key${ch.toUpperCase()}`;
  if (/[0-9]/.test(ch)) return `Digit${ch}`;
  return 'Period';
}

export class TypingController {
  constructor({ keyboard, animator, procedural, bubble, rng = Math.random, target = window }) {
    Object.assign(this, { keyboard, animator, procedural, bubble, rng });
    this.active = false; // keyboard out, fox typing (or about to)
    this.time = 0;
    this.lastKeyAt = -Infinity;
    this.stamps = []; // recent keystroke times (typing speed)
    this.demoUntil = 0;
    this.demoNext = 0;
    this.demoIndex = 0;
    this.nextLineAt = 0;
    this.keystrokes = 0;
    this.listeners = new Set();
    this.enabled = true;
    target.addEventListener('keydown', (e) => this.onKeyDown(e));
    target.addEventListener('keyup', (e) => this.keyboard.release(e.code));
    target.addEventListener('blur', () => this.keyboard.releaseAll());
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this);
  }

  get demoActive() {
    return this.time < this.demoUntil;
  }

  onKeyDown(e) {
    if (!this.enabled) return; // 2D mode: the 2D fox listens to the keyboard itself
    if (isEditable(e.target) || isEditable(document.activeElement)) return;
    if (MODIFIERS.has(e.code) || MODIFIER_KEYS.has(e.key)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return; // shortcuts, not typing
    if (e.code === 'Tab' || e.code === 'Escape' || /^F\d+$/.test(e.code)) return; // focus navigation / system keys
    if ((e.code === 'Enter' || e.code === 'Space' || e.code === 'NumpadEnter') && isControl(document.activeElement)) return; // activating a button
    this.key(e.code || e.key || 'Unidentified', { repeat: e.repeat });
  }

  /** One keystroke (real or simulated). Returns false when the fox cannot type now. */
  key(code, { repeat = false } = {}) {
    if (!this.active && !this.start()) return false;
    this.lastKeyAt = this.time;
    if (repeat) return true; // held key: keep typing alive, no animation spam
    const a = this.animator;
    if (a.busyPresence) return false;
    // Resting (sat down / idled meanwhile): back to typing now. A one-shot the user asked for
    // during typing plays to the end first, then the fox goes back to typing.
    if (a.stateName === 'Idle' || a.stateName === 'Sitting') a.startTyping();
    else if (a.stateName !== 'Typing') a.typingWanted = true;
    this.keystrokes++;
    const side = this.keyboard.press(code);
    this.procedural.nod(0.6 + 0.5 * this.rng());
    if (!this.animator.has('Type')) this.procedural.tapPaw(side);
    this.stamps.push(this.time);
    while (this.stamps.length && this.time - this.stamps[0] > 1.5) this.stamps.shift();
    if (this.keystrokes > 6 && this.time >= this.nextLineAt && this.rng() < 0.12) {
      this.nextLineAt = this.time + 7;
      this.bubble.say(TYPING_LINES[Math.floor(this.rng() * TYPING_LINES.length)], { cooldown: 12, queue: false });
    }
    return true;
  }

  /** Simulated tap (tests, demo): keydown now, keyup a moment later. */
  tap(code) {
    const ok = this.key(code);
    setTimeout(() => this.keyboard.release(code), 60 + this.rng() * 60);
    return ok;
  }

  start() {
    const s = this.animator.startTyping();
    if (!s) return false;
    this.active = true;
    this.keystrokes = 0;
    this.nextLineAt = this.time + 3;
    this.keyboard.show();
    this.bubble.say('我来帮你一起打字!', { cooldown: 20, maxWait: 1.5 });
    this.emit();
    return true;
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.demoUntil = 0;
    this.stamps.length = 0;
    this.keyboard.hide();
    this.keyboard.releaseAll();
    this.animator.stopTyping();
    this.animator.setTypeRate(1);
    this.emit();
  }

  /** Toolbar 打字: a few seconds of simulated typing (for touch devices). */
  demo(seconds = 3) {
    if (this.animator.busyPresence || this.animator.posing) return false;
    this.demoUntil = this.time + seconds;
    this.demoNext = this.time;
    this.emit();
    return true;
  }

  toggleDemo() {
    if (this.demoActive || this.active) {
      this.stop();
      return false;
    }
    return this.demo(3);
  }

  update(dt) {
    this.time += dt;
    if (this.demoActive && this.time >= this.demoNext) {
      const ch = DEMO_TEXT[this.demoIndex++ % DEMO_TEXT.length];
      if (!this.tap(codeFor(ch))) this.demoUntil = 0;
      this.demoNext = this.time + 0.08 + this.rng() * 0.12;
    }
    if (this.active) {
      if (this.animator.busyPresence) this.stop();
      else if (this.time - this.lastKeyAt > IDLE_AFTER) this.stop();
      else {
        // typing speed -> Type clip playback rate (nominal ~6 keys/s)
        const rate = this.stamps.length / 1.5;
        const idle = this.time - this.lastKeyAt;
        this.animator.setTypeRate(idle > 0.6 ? 0.6 : 0.75 + rate / 8);
      }
    }
    this.procedural.typing = this.active && this.animator.stateName === 'Typing' && !this.animator.has('Type')
      && this.time - this.lastKeyAt < IDLE_AFTER - 0.3;
    this.keyboard.update(dt);
  }
}
