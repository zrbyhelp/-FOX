// Speech bubble logic: one line at a time next to the fox's head. say() queues, with a per-line
// cooldown so repeated actions do not spam; the newest line cuts the current one short. Every
// frame the bubble picks the side of the head with room (beside it at ear height, or above it),
// out of the logo's way and above the toolbar, and hands that screen box to its view:
//   - 3D mode: Bubble3D (bubble3d.js), a puffy cream pillow living in the scene;
//   - 2D mode (setSource with the puppet's anchors): DomBubbleView below, a rounded cream DOM
//     bubble with a little tail pointing at the head (the 2D look is frozen).
// A visually hidden live region reads the current line to screen readers in both modes.
import * as THREE from 'three';

const EDGE = 10; // px kept free along the viewport edges
const OUT_TIME = 0.22; // s, pop-out (must match the CSS bubble-out animation)
const HEAD_RADIUS = 0.25; // world units, roughly the head's silhouette radius

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _r = new THREE.Vector3();

/**
 * The flat DOM bubble (2D mode). View interface shared with Bubble3D:
 *   layout            placement tuning for Bubble.place()
 *   show(text, a)     a new line pops in (a = head anchor)
 *   size(anchor)      { w, h, tail } CSS px of the body (+ room the tail needs below it)
 *   place(box, a, bounds)  box { x, y, w, h, side } in client px, a = head anchor,
 *                     bounds { vw, vh, edge }: the free viewport (above the toolbar)
 *   update(dt, a)     per-frame animation
 *   leave() / hide()  pop out / gone now
 *   screenRect()      { x, y, w, h, lines, visible } in client px
 */
export class DomBubbleView {
  constructor() {
    this.layout = { out: 0.78, up: 0.5, top: 1.45, gap: 8, lean: 0.25 };
    this.el = document.createElement('div');
    this.el.className = 'bubble';
    this.el.setAttribute('aria-hidden', 'true'); // Bubble's live region speaks the line
    this.el.hidden = true;
    this.pop = document.createElement('div');
    this.pop.className = 'bubble-pop';
    this.body = document.createElement('div');
    this.body.className = 'bubble-body';
    this.tail = document.createElement('span');
    this.tail.className = 'bubble-tail';
    this.pop.append(this.body, this.tail);
    this.el.append(this.pop);
    document.body.append(this.el);
    this.dims = { w: 0, h: 0, tail: 0 };
  }

  show(text) {
    this.body.textContent = text;
    this.el.hidden = false;
    this.el.classList.remove('out');
    // restart the pop-in animation
    this.pop.style.animation = 'none';
    void this.pop.offsetWidth;
    this.pop.style.animation = '';
    this.dims = { w: this.pop.offsetWidth, h: this.pop.offsetHeight, tail: 0 };
  }

  size() {
    return this.dims;
  }

  leave() {
    this.el.classList.add('out');
  }

  hide() {
    this.el.hidden = true;
    this.el.classList.remove('out');
  }

  update() {}

  place({ x, y, w, h, side }, a) {
    this.el.dataset.side = side;
    // Point the tail at the head even when the bubble had to be pushed back on screen.
    if (side === 'top') {
      this.el.style.setProperty('--tail-x', `${THREE.MathUtils.clamp(a.x - x, 18, w - 18)}px`);
    } else {
      this.el.style.setProperty('--tail-y', `${THREE.MathUtils.clamp(a.y - a.r * 0.35 - y, 16, h - 16)}px`);
    }
    this.el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  }

  screenRect() {
    const r = this.body.getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(this.body).lineHeight) || 21;
    return { x: r.x, y: r.y, w: r.width, h: r.height, lines: Math.max(1, Math.round((this.body.clientHeight - 19) / lh)), visible: !this.el.hidden };
  }
}

export class Bubble {
  /**
   * @param {object} o
   * @param {THREE.Camera} o.camera
   * @param {HTMLCanvasElement} o.canvas
   * @param {THREE.Object3D} o.head   head bone
   * @param {(v: THREE.Vector3) => THREE.Vector3 | null} [o.logoCenter]
   * @param {() => number} [o.insetBottom]  px covered by the toolbar
   * @param {object} [o.view3d]  the 3D bubble (Bubble3D) used while anchored to the 3D head;
   *                             without one the DOM bubble is used in both modes
   */
  constructor({ camera, canvas, head, logoCenter = null, insetBottom = () => 0, view3d = null }) {
    Object.assign(this, { camera, canvas, head, logoCenter, insetBottom, view3d });
    this.dom = new DomBubbleView();
    this.view = view3d || this.dom;
    // screen readers: the current line (the bubbles themselves are aria-hidden / on the canvas)
    this.live = document.createElement('div');
    this.live.className = 'sr-only';
    this.live.setAttribute('role', 'status');
    this.live.setAttribute('aria-live', 'polite');
    document.body.append(this.live);

    this.time = 0;
    this.queue = [];
    this.current = null; // { text, duration, state: 'wait' | 'in' | 'out', since, until }
    this.lastSaid = new Map();
    this.side = 'right';
    this.enabled = true;
    this.offscreenFor = 0;
    this.shown = 0; // bubbles shown so far (tests)
    this.source = null; // 2D mode: { anchor(), logoRect() } in client px instead of the 3D head
  }

  /** Anchor the bubble to another fox (the 2D puppet), or back to the 3D head with null. */
  setSource(source) {
    this.source = source;
    const view = source || !this.view3d ? this.dom : this.view3d;
    if (view !== this.view) {
      // the other fox's stage is hidden now: drop its bubble at once
      this.queue.length = 0;
      if (this.current && this.current.state !== 'wait') this.view.hide();
      this.current = null;
      this.live.textContent = '';
      this.view = view;
    } else this.clear();
  }

  /**
   * Queue a line. Options: duration (s, default from the text length), cooldown (s before the
   * same line may show again), maxWait (s it may wait in the queue), queue (false = drop the
   * line if another bubble is up). Returns true when the line was accepted.
   */
  say(text, { duration, cooldown = 6, maxWait = 2, queue = true } = {}) {
    if (!text || !this.enabled) return false;
    const last = this.lastSaid.get(text);
    if (last != null && this.time - last < cooldown) return false;
    const busy = !!this.current && this.current.state !== 'out';
    if (busy && !queue) return false;
    if ((busy && this.current.text === text) || this.queue.some((q) => q.text === text)) return false;
    this.lastSaid.set(text, this.time);
    const chars = [...text].length;
    this.queue.push({ text, duration: duration ?? THREE.MathUtils.clamp(1.3 + 0.14 * chars, 1.8, 4), at: this.time, maxWait });
    if (this.queue.length > 3) this.queue.shift();
    // The newest line matters most: the current bubble gets a short minimum, then hands over.
    const c = this.current;
    if (c && c.state === 'in') c.until = Math.min(c.until, Math.max(this.time, c.since + 0.9));
    return true;
  }

  /** Drop everything (the fox left). */
  clear() {
    this.queue.length = 0;
    if (this.current && this.current.state !== 'out') this.leave();
  }

  /** True while a bubble is up: the fox moves its mouth. */
  get talking() {
    return !!this.current && this.current.state === 'in';
  }

  get text() {
    return this.current && this.current.state !== 'wait' ? this.current.text : null;
  }

  /** Where the bubble is on screen (client px, full size), with its number of text lines. */
  screenRect() {
    return this.current && this.current.state !== 'wait' ? this.view.screenRect() : null;
  }

  leave() {
    const c = this.current;
    if (!c) return;
    if (c.state === 'wait') {
      this.current = null;
      return;
    }
    c.state = 'out';
    c.since = this.time;
    this.view.leave();
  }

  update(dt) {
    this.time += dt;
    let c = this.current;
    if (c && c.state === 'out' && this.time - c.since >= OUT_TIME) {
      this.view.hide();
      this.current = c = null;
    }
    if (!c) {
      while (this.queue.length && this.time - this.queue[0].at > this.queue[0].maxWait) this.queue.shift();
      const next = this.queue.shift();
      if (!next) return;
      c = this.current = { ...next, state: 'wait', since: this.time, until: 0 };
    }

    const a = this.anchor();
    if (c.state === 'wait') {
      if (!a.onScreen) {
        if (this.time - c.since > c.maxWait + 1) this.current = null;
        return;
      }
      this.show(c, a);
    }
    if (c.state === 'in') {
      this.offscreenFor = a.onScreen ? 0 : this.offscreenFor + dt;
      if (this.time >= c.until || this.offscreenFor > 0.35) this.leave();
    }
    this.place(a);
    this.view.update(dt, a);
  }

  show(c, a) {
    c.state = 'in';
    c.since = this.time;
    c.until = this.time + c.duration;
    this.view.show(c.text, a);
    this.live.textContent = c.text;
    this.offscreenFor = 0;
    this.shown++;
  }

  /** Head centre and silhouette radius in CSS px (+ the world centre in 3D). */
  anchor() {
    if (this.source) return this.source.anchor();
    const rect = this.canvas.getBoundingClientRect();
    const toScreen = (p) => ({ x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height });
    const head = this.head;
    head.localToWorld(_v.set(0, 0.14, 0));
    const world = _v.clone();
    this.camera.updateMatrixWorld();
    _r.setFromMatrixColumn(this.camera.matrixWorld, 0).multiplyScalar(HEAD_RADIUS);
    const edge = _v2.copy(_v).add(_r).project(this.camera);
    const centre = _v.project(this.camera);
    const c = toScreen(centre);
    const e = toScreen(edge);
    const r = Math.max(12, Math.hypot(e.x - c.x, e.y - c.y));
    const onScreen = centre.z < 1 && c.x > -r * 0.3 && c.x < window.innerWidth + r * 0.3 && c.y > -r && c.y < window.innerHeight;
    return { x: c.x, y: c.y, r, onScreen, world };
  }

  logoRect() {
    if (this.source) return this.source.logoRect?.() ?? null;
    if (!this.logoCenter) return null;
    const p = this.logoCenter(_v);
    if (!p) return null;
    const rect = this.canvas.getBoundingClientRect();
    _r.setFromMatrixColumn(this.camera.matrixWorld, 0).multiplyScalar(0.22);
    const e = _v2.copy(p).add(_r).project(this.camera);
    const c = p.project(this.camera);
    const cx = rect.left + ((c.x + 1) / 2) * rect.width;
    const cy = rect.top + ((1 - c.y) / 2) * rect.height;
    const r = Math.abs(((e.x - c.x) / 2) * rect.width);
    return { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r };
  }

  place(a) {
    const { w, h, tail = 0 } = this.view.size(a);
    const L = this.view.layout;
    const vw = window.innerWidth;
    const vh = window.innerHeight - this.insetBottom();
    const logo = this.logoRect();
    const layouts = {
      // beside the head at ear height, tail pointing back at the head
      right: () => ({ x: a.x + a.r * L.out + L.gap, y: a.y - a.r * L.up - h / 2 }),
      left: () => ({ x: a.x - a.r * L.out - L.gap - w, y: a.y - a.r * L.up - h / 2 }),
      // above the ears, tail pointing down
      top: () => ({ x: a.x - w / 2 + a.r * L.lean, y: a.y - a.r * L.top - L.gap - h - tail }),
    };
    const hh = h + tail; // the tail hangs below the body
    const fits = (p) => p.x >= EDGE && p.y >= EDGE && p.x + w <= vw - EDGE && p.y + hh <= vh - EDGE
      && !(logo && p.x < logo.x + logo.w && p.x + w > logo.x && p.y < logo.y + logo.h && p.y + hh > logo.y);
    let side = this.side;
    let p = layouts[side]();
    if (!fits(p)) {
      const found = ['right', 'top', 'left'].find((s) => fits(layouts[s]()));
      side = found || (a.x < vw / 2 ? 'right' : 'left');
      p = layouts[side]();
    }
    this.side = side;
    p.x = THREE.MathUtils.clamp(p.x, EDGE, Math.max(EDGE, vw - EDGE - w));
    p.y = THREE.MathUtils.clamp(p.y, EDGE, Math.max(EDGE, vh - EDGE - hh));
    this.view.place({ x: p.x, y: p.y, w, h, side }, a, { vw, vh, edge: EDGE });
  }
}
