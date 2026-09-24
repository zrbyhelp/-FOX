/**
 * Live2D-style 2D fox (小狐狸 2D 版) — the layered puppet counterpart of the 3D viewer.
 *
 * Technique: the art is a stack of pre-rendered layers (public/live2d/layers.json + layers/*.png,
 * pivots in rig.json). Each layer is a textured grid mesh deformed on the CPU every frame by
 * Cubism-style parameters (ParamAngleX/Y/Z, eye open/smile, mouth, breath, body angle, arm
 * bones, tail, ears ... see rig.js PARAMS), with pendulum physics for the ears, scarf flap and
 * tail (physics.js), keyframed motions with fades (motions.js) and the same behaviour state
 * machine as the 3D animator (controller.js).
 *
 * ---------------------------------------------------------------------------------------------
 * API
 *
 *   import { createLive2DApp } from './live2d/app.js';
 *   const app = await createLive2DApp({ container, spec, insetBottom });
 *
 * Options
 *   container    HTMLElement the canvas is appended to (absolute, fills it; the container gets
 *                position:relative if it is static; document.body -> position:fixed canvas).
 *   spec         spec.json object (optional; only clip names / logo pieces are read).
 *   insetBottom  CSS px at the bottom covered by a toolbar (the puppet + logo are fitted above).
 *   base         URL prefix of layers.json / rig.json (default './live2d/').
 *   keyboard     listen to window keydown for the typing behaviour (default true). Set false
 *                when the host page forwards keys itself with app.typeKey(code).
 *   background   draw the page's radial gradient + ground shadow in the canvas (default true;
 *                false = transparent canvas over the host's own background).
 *   intro        pop in + wave on every start() (default true), like the 3D fox's page load
 *                and its 回来; 'Exit' waves goodbye and pops away, the logo goes with it.
 *   seed         RNG seed (deterministic behaviour for tests).
 *   debug        preserveDrawingBuffer (screenshots) + window.__live2d = app.
 *
 * Returned object
 *   start()               show the canvas, attach listeners, run the frame loop (idempotent).
 *   stop()                pause: stop the loop, detach every listener, hide the canvas.
 *                         start()/stop() can be called any number of times (3D/2D switch).
 *   dispose()             stop() + free every GPU resource + remove the canvas. Final.
 *   request(name)         same names as the 3D UI: 'Wave' 'Happy' 'Heart' 'Present' 'Reach'
 *                         'Shrug' 'Jump' 'Sit_Think' 'Sit_Doze' 'Pet' 'LookBack' 'Enter' 'Exit'
 *                         'Type' 'StandUp' 'Idle', plus the 3D trigger aliases 'Sit' 'Doze'
 *                         'Wake' 'PetEnd' 'logo' and the parts 'head' 'body' 'tail' 'ear_L'
 *                         'ear_R'. 'Type' runs a short simulated typing demo (touch devices).
 *                         Returns the clip that will play (after fallbacks) or null.
 *   has(name)             true when request(name) is supported.
 *   state                 'Idle' | 'OneShot' | 'Sitting' | 'Petting' | 'Typing' | 'Entering' |
 *                         'Exiting' | 'Away'
 *   clip                  current motion name ('Idle' when only the idle layer plays).
 *   setLookEnabled(bool)  head / eyes follow the pointer (toolbar 跟随鼠标).
 *   setTalking(bool)      talk (calm eased mouth, ParamMouthOpen) while a speech bubble is shown.
 *   setInsetBottom(px)    refit above a toolbar of that height.
 *   onEvent(cb)           cb(event); returns an unsubscribe function. Events:
 *                           { type: 'clip', name, intent }  a motion started (bubbles)
 *                           { type: 'state', from, to }     state machine transition
 *                           { type: 'part', part }          a part was clicked
 *                           { type: 'typing', active }      keyboard shown / hidden
 *                           { type: 'heart' }               heart popped
 *   typeKey(code)         one simulated keystroke (KeyboardEvent.code), e.g. forwarded keys.
 *   resize()              refit to the container (also automatic via ResizeObserver). Wide
 *                         views put the logo beside the fox (3D framing); portrait views float
 *                         it up-left above the head so the fox can be larger.
 *   debug                 test hooks: freeze(), advance(sec), trace(sec, names), pose(name, t),
 *                         info(), setIdleTimeouts(sit, doze), partAt(x, y), clientPos(part), params.
 * ---------------------------------------------------------------------------------------------
 */
import { Puppet, CONTENT_BOX, CONTENT_BOX_PORTRAIT } from './puppet.js';
import { Rig, defaultParams, clampParams } from './rig.js';
import { Physics } from './physics.js';
import { MOTIONS, MotionPlayer, applyIdle } from './motions.js';
import { Controller, POP_IN, POP_OUT } from './controller.js';
import { Logo2D, HeartFx, DozeFx, Keyboard2D, LOGO_POS, LOGO_POS_PORTRAIT } from './props.js';
import { Critical, makeRng, clamp, softClamp, smooth, easeOutBack, affApplyX, affApplyY, affAngle } from './math2d.js';
import { TalkRhythm } from '../talk.js';

const CLICK_DELAY = 250; // ms to wait for a possible double-click
const PET_DISTANCE = 12; // px of pointer travel on the head before it counts as petting
const TAIL_DISTANCE = 6;
const POINTER_IDLE = 5; // s without pointer movement before the look-at target is dropped
const TYPE_IDLE = 1.8; // s without keys before the keyboard goes away
const LOGO_IN_DELAY = 0.15; // s the logo pops in after the fox
const LOGO_OUT_DELAY = 0.06; // s the logo pops away after the fox
const EXPR_OMEGA = 6; // expression params ease (critically damped): a layer swap takes >= ~0.3 s
const easeInBack = (x, s = 1.7) => (s + 1) * x ** 3 - s * x ** 2;

const CLIPS = ['Wave', 'Happy', 'Heart', 'Present', 'Reach', 'Shrug', 'Jump', 'Sit_Think', 'Sit_Doze', 'Pet', 'LookBack', 'Enter', 'Exit', 'Type', 'StandUp', 'Idle', 'SitDown', 'Idle_LookAround'];
const ALIASES = ['Sit', 'Doze', 'Wake', 'PetEnd', 'logo', 'head', 'body', 'tail', 'ear_L', 'ear_R'];
const SUPPORTED = new Set([...CLIPS, ...ALIASES]);

const PART_OF = {
  Head: 'head', Nose: 'head', Eye_L: 'head', Eye_R: 'head', EyeHappy_L: 'head', EyeHappy_R: 'head', EyeSleep_L: 'head',
  EyeSleep_R: 'head', Brow_L: 'head', Brow_R: 'head', MouthSmile: 'head', MouthOpen: 'head',
  Ear_L: 'ear_L', Ear_R: 'ear_R', Tail: 'tail',
};

const MODIFIERS = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock', 'Fn', 'ContextMenu']);
const DEMO_TEXT = 'hello fox ';

function isEditable(el) {
  if (!el) return false;
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

export async function createLive2DApp({
  container, spec = null, insetBottom = 0, base = './live2d/', keyboard: listenKeys = true, background = true,
  intro = true, seed, debug = false,
} = {}) {
  if (!container) throw new Error('createLive2DApp: container is required');
  const rng = makeRng(seed ?? Math.floor(Math.random() * 2 ** 32));
  const puppet = new Puppet({ container, base, background, insetBottom, preserveDrawingBuffer: debug });
  const canvas = puppet.canvas;
  if (container === document.body) canvas.style.position = 'fixed';
  else if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  canvas.style.display = 'none';
  container.append(canvas);
  try {
    await puppet.load();
  } catch (err) {
    puppet.dispose(); // no WebGL context / canvas left behind
    throw err;
  }

  const rig = new Rig(puppet);
  const physics = new Physics();
  const player = new MotionPlayer();
  const controller = new Controller({ player, rng });
  const logo = new Logo2D(puppet, { pieces: spec?.logo?.pieces });
  const hearts = new HeartFx(puppet);
  const doze = new DozeFx(puppet);
  const keyboard = new Keyboard2D(puppet, { order: (puppet.byName.ScarfFlap?.baseOrder ?? 160) + 3 });

  const defaults = defaultParams();
  const p = defaultParams();
  const overrides = {}; // debug: params pinned after everything else

  // ---- events -----------------------------------------------------------------------------
  const listeners = new Set();
  const emit = (ev) => { for (const fn of listeners) { try { fn(ev); } catch (err) { console.error(err); } } };
  controller.on((type, d) => {
    if (type === 'clip') emit({ type: 'clip', name: d.clip, intent: d.intent });
    else if (type === 'state') emit({ type: 'state', from: d.from, to: d.to });
    else if (type === 'motionEvent') onMotionEvent(d.name);
    else if (type === 'presence') {
      // the logo arrives a beat after the fox and leaves just after it; hidden while away
      if (d.mode === 'popIn') logo.popIn(LOGO_IN_DELAY);
      else if (d.mode === 'popOut') logo.popOut(LOGO_OUT_DELAY);
      else logo.setShown(d.mode === 'shown');
    }
  });

  // ---- runtime state ------------------------------------------------------------------------
  const S = {
    time: 0,
    running: false,
    frozen: false,
    raf: 0,
    lastT: 0,
    disposed: false,
    lookEnabled: true,
    pointer: null, // {x, y, type} client px
    pointerAt: -Infinity,
    model: { x: 0, y: 0 },
    down: null,
    pending: null,
    hoverLogo: false,
    hoverDirty: false,
    logoFocusUntil: 0,
    lastPresent: -Infinity,
    touchHoverUntil: 0,
    glowUntil: 0,
    look: { x: new Critical(0, 6), y: new Critical(0, 6), ex: new Critical(0, 14), ey: new Critical(0, 14), w: new Critical(0, 5) },
    pet: { z: new Critical(0, 9), x: new Critical(0, 9) },
    tailHoldW: new Critical(0, 14),
    blink: { in: 2.5 + rng() * 3.5, t: -1, double: false },
    // eased expression params (the motions' eye-smile / brow / mouth swaps never snap)
    expr: { ParamEyeSmile: new Critical(0, EXPR_OMEGA), ParamBrowL: new Critical(0, EXPR_OMEGA), ParamBrowR: new Critical(0, EXPR_OMEGA), ParamMouthOpen: new Critical(0, EXPR_OMEGA) },
    earFlick: { L: -1, R: -1, amp: { L: 1, R: 1 } },
    earTwitchIn: 5 + rng() * 5,
    nodT: -1,
    tap: { L: -1, R: -1 },
    flicks: 0,
    wasHidden: false,
    talking: false,
    talkEnv: new Critical(0, 9),
    talk: new TalkRhythm(rng),
    typing: { active: false, lastKeyAt: -Infinity, stamps: [], keystrokes: 0, demoUntil: 0, demoNext: 0, demoIndex: 0 },
  };

  // ---- behaviours shared by clicks, the toolbar and request() -------------------------------

  function flickEar(side) {
    const s = side === 'ear_L' || side === 'L' ? 'L' : 'R';
    S.earFlick[s] = 0;
    S.earFlick.amp[s] = 1;
    physics.kickEar(s, (s === 'L' ? -1 : 1) * 260);
    S.flicks++;
  }

  function presentLogo() {
    S.logoFocusUntil = Math.max(S.logoFocusUntil, S.time + 3);
    if (controller.state === 'Idle' && S.time - S.lastPresent > 5) {
      S.lastPresent = S.time;
      controller.request('Present');
    }
  }

  function trigger(name) {
    const c = controller;
    switch (name) {
      case 'head': return c.request('Happy');
      case 'ear_L': case 'ear_R':
        c.poke();
        flickEar(name);
        return name;
      case 'body': return c.request(rng() < 0.5 ? 'Wave' : 'Shrug');
      case 'tail': return c.request('LookBack');
      case 'logo':
        if (!logo.shown) return null;
        logo.activate();
        S.logoFocusUntil = S.time + 4.5;
        return c.request('Reach');
      case 'Present':
        S.logoFocusUntil = S.time + 3.5;
        S.glowUntil = S.time + 1.5;
        return c.request('Present');
      case 'Reach': return trigger('logo');
      case 'Sit': return c.sit() ? 'SitDown' : null;
      case 'Doze': return c.sit({ doze: true }) ? 'Sit_Doze' : null;
      case 'Pet': return c.startPet() ? 'Pet' : null;
      case 'PetEnd': return c.endPet();
      case 'Wake': c.poke(false); return c.wake('Wave');
      case 'Type': return typingDemo(3) ? 'Type' : null;
      default: return c.request(name);
    }
  }

  function onMotionEvent(name) {
    if (name === 'heart') {
      const a = rig.point('pawL');
      const b = rig.point('pawR');
      hearts.pop((a[0] + b[0]) / 2, Math.max(a[1], b[1]) + 0.07, rng);
      emit({ type: 'heart' });
    } else if (name === 'logo') {
      logo.activate();
      S.logoFocusUntil = Math.max(S.logoFocusUntil, S.time + 3);
    } else if (name === 'logoGlow') {
      S.glowUntil = S.time + 1.6;
      S.logoFocusUntil = Math.max(S.logoFocusUntil, S.time + 2.5);
    }
  }

  // ---- typing (same behaviour as the 3D TypingController) -----------------------------------

  function typingStart() {
    const s = controller.startTyping();
    if (!s) return false;
    const T = S.typing;
    T.active = true;
    T.keystrokes = 0;
    keyboard.show();
    emit({ type: 'typing', active: true });
    return true;
  }

  function typingStop() {
    const T = S.typing;
    if (!T.active) return;
    T.active = false;
    T.demoUntil = 0;
    T.stamps.length = 0;
    keyboard.hide();
    controller.stopTyping();
    controller.setTypeRate(1);
    emit({ type: 'typing', active: false });
  }

  function typeKey(code, { repeat = false } = {}) {
    if (S.disposed) return false;
    const T = S.typing;
    if (!T.active && !typingStart()) return false;
    T.lastKeyAt = S.time;
    if (repeat) return true;
    const c = controller;
    if (c.busyPresence) return false;
    if (c.state === 'Idle' || c.state === 'Sitting') c.startTyping();
    else if (c.state !== 'Typing') c.typingWanted = true;
    T.keystrokes++;
    const side = keyboard.press(code || 'Unidentified');
    S.nodT = 0;
    S.tap[side] = 0;
    T.stamps.push(S.time);
    while (T.stamps.length && S.time - T.stamps[0] > 1.5) T.stamps.shift();
    return true;
  }

  function typingDemo(seconds = 3) {
    if (controller.busyPresence) return false;
    const T = S.typing;
    T.demoUntil = S.time + seconds;
    T.demoNext = S.time;
    return true;
  }

  function typingUpdate() {
    const T = S.typing;
    if (S.time < T.demoUntil && S.time >= T.demoNext) {
      const ch = DEMO_TEXT[T.demoIndex++ % DEMO_TEXT.length];
      if (!typeKey(codeFor(ch))) T.demoUntil = 0;
      T.demoNext = S.time + 0.08 + rng() * 0.12;
    }
    if (!T.active) return;
    if (controller.busyPresence) typingStop();
    else if (S.time - T.lastKeyAt > TYPE_IDLE) typingStop();
    else {
      const rate = T.stamps.length / 1.5;
      const idle = S.time - T.lastKeyAt;
      controller.setTypeRate(idle > 0.6 ? 0.6 : 0.75 + rate / 8);
    }
  }

  // ---- pointer --------------------------------------------------------------------------------

  function pick(clientX, clientY) {
    const m = puppet.toModel(clientX, clientY);
    if (!controller.hidden && puppet.root.visible) {
      const L = puppet.pickLayer(m.x, m.y);
      if (L) return PART_OF[L.name] || 'body';
    }
    if (logo.hit(m.x, m.y)) return 'logo';
    return null;
  }

  function cancelPending() {
    if (S.pending) clearTimeout(S.pending.timer);
    S.pending = null;
  }

  function onDown(e) {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    onMove(e);
    const part = pick(e.clientX, e.clientY);
    if (!part) return;
    e.preventDefault();
    canvas.setPointerCapture?.(e.pointerId);
    S.down = { part, x: e.clientX, y: e.clientY, travel: 0, id: e.pointerId, type: e.pointerType, petting: false, tail: false };
  }

  function onMove(e) {
    if (!e.isPrimary) return;
    const prev = S.pointer;
    S.pointer = { x: e.clientX, y: e.clientY, type: e.pointerType };
    S.pointerAt = S.time;
    S.hoverDirty = true;
    if (controller.state !== 'Sitting' && e.pointerType === 'mouse' && e.target === canvas) controller.poke(false);
    const d = S.down;
    if (!d || d.id !== e.pointerId || !prev) return;
    d.travel += Math.hypot(e.clientX - prev.x, e.clientY - prev.y);
    if (!d.petting && d.part === 'head' && d.travel > PET_DISTANCE) {
      d.petting = controller.startPet();
      cancelPending();
    }
    if (!d.tail && d.part === 'tail' && d.travel > TAIL_DISTANCE) {
      d.tail = true;
      cancelPending();
      controller.poke();
    }
  }

  function onUp(e, cancelled = false) {
    const d = S.down;
    if (!d || d.id !== e.pointerId) return;
    S.down = null;
    canvas.releasePointerCapture?.(e.pointerId);
    if (d.petting) {
      controller.endPet();
      return;
    }
    if (d.tail) {
      physics.tailHold = null;
      physics.kickTail(rng() < 0.5 ? -120 : 120);
      return;
    }
    if (cancelled || d.travel > PET_DISTANCE) return;
    emit({ type: 'part', part: d.part });
    if (d.part === 'logo') clickLogo(d.type);
    else clickFox(d.part);
  }

  function clickFox(part) {
    if (controller.state === 'Sitting') {
      cancelPending();
      controller.poke(true);
      return;
    }
    controller.poke(false);
    if (S.pending) {
      cancelPending();
      controller.request('Jump');
      return;
    }
    S.pending = { timer: setTimeout(() => { S.pending = null; if (S.running) trigger(part); }, CLICK_DELAY) };
  }

  function clickLogo(pointerType) {
    if (controller.state === 'Sitting') {
      logo.activate();
      controller.poke(true);
      return;
    }
    if (pointerType !== 'mouse' && S.time > S.touchHoverUntil) {
      S.touchHoverUntil = S.glowUntil = S.time + 3;
      presentLogo();
      return;
    }
    trigger('logo');
  }

  function onKeyDown(e) {
    if (isEditable(e.target) || isEditable(document.activeElement)) return;
    if (MODIFIERS.has(e.code) || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Tab' || e.code === 'Escape' || /^F\d+$/.test(e.code)) return;
    if ((e.code === 'Enter' || e.code === 'Space' || e.code === 'NumpadEnter') && isControl(document.activeElement)) return;
    typeKey(e.code || e.key || 'Unidentified', { repeat: e.repeat });
  }

  function onVisibility() {
    if (document.visibilityState === 'visible') {
      S.lastT = performance.now();
      physics.reset(p);
    }
  }

  const onPointerOut = (e) => { if (!e.relatedTarget) S.pointer = null; };
  const onCancel = (e) => onUp(e, true);
  const onBlur = () => { S.pointer = null; };
  const bindings = [
    [canvas, 'pointerdown', onDown, undefined],
    [window, 'pointermove', onMove, { passive: true }],
    [window, 'pointerup', onUp, undefined],
    [window, 'pointercancel', onCancel, undefined],
    [window, 'pointerout', onPointerOut, undefined],
    [window, 'blur', onBlur, undefined],
    [document, 'visibilitychange', onVisibility, undefined],
    [window, 'resize', () => resize(), undefined],
  ];
  if (listenKeys) bindings.push([window, 'keydown', onKeyDown, undefined]);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;

  // ---- per-frame --------------------------------------------------------------------------------

  const head = [0, 0];
  const tmp = [0, 0];

  function interactionUpdate() {
    const ptr = S.pointer;
    if (S.hoverLogo && !logo.shown) { // the logo left with the fox
      S.hoverLogo = false;
      S.hoverDirty = true;
    }
    if (S.hoverDirty && !S.down) {
      S.hoverDirty = false;
      const part = ptr && ptr.type === 'mouse' ? pick(ptr.x, ptr.y) : null;
      const onLogo = part === 'logo';
      if (onLogo && !S.hoverLogo) presentLogo();
      S.hoverLogo = onLogo;
      canvas.style.cursor = part ? (part === 'tail' || part === 'head' ? 'grab' : 'pointer') : '';
    }
    if (S.down && (S.down.petting || S.down.tail)) canvas.style.cursor = 'grabbing';
    logo.setHover(S.hoverLogo || S.time < S.glowUntil);
  }

  function lookTarget() {
    const ptr = S.pointer;
    if (logo.shown && (S.hoverLogo || logo.isActive || S.time < S.logoFocusUntil || controller.lookAtLogo)) return logo.starPosition(tmp);
    if (ptr && S.lookEnabled && S.time - S.pointerAt < POINTER_IDLE) {
      const m = puppet.toModel(ptr.x, ptr.y, S.model);
      tmp[0] = m.x;
      tmp[1] = m.y;
      return tmp;
    }
    return null;
  }

  function overlays(dt, mix) {
    const c = controller;
    // look-at (critically damped)
    rig.point('headCenter', head);
    const tgt = lookTarget();
    let tx = 0, ty = 0, ex = 0, ey = 0;
    if (tgt) {
      const dx = tgt[0] - head[0];
      const dy = tgt[1] - head[1] + 0.05;
      tx = 30 * softClamp(dx / 0.5);
      ty = 26 * softClamp(dy / 0.45);
      ex = softClamp(dx / 0.3);
      ey = softClamp(dy / 0.3);
    }
    const L = S.look;
    const wTarget = tgt ? mix.lookAt : 0;
    L.w.step(wTarget, dt);
    L.x.step(tx, dt);
    L.y.step(ty, dt);
    L.ex.step(ex, dt);
    L.ey.step(ey, dt);
    const w = clamp(L.w.x, 0, 1);
    p.ParamAngleX += L.x.x * w;
    p.ParamAngleY += L.y.x * w;
    p.ParamAngleZ += -L.x.x * 0.12 * w;
    p.ParamBodyAngleX += (L.x.x / 30) * 3.5 * w;
    p.ParamEyeBallX += L.ex.x * w * 0.8;
    p.ParamEyeBallY += L.ey.x * w * 0.8;

    // petting: the head leans after the stroking hand
    const d = S.down;
    let pz = 0, px = 0;
    if (d && d.petting && S.pointer) {
      const k = 1 / puppet.view.scale;
      const dxm = (S.pointer.x - d.x) * k;
      const dym = (S.pointer.y - d.y) * k;
      pz = clamp(-dxm * 70, -12, 12);
      px = clamp(dxm * 50, -10, 10) + 0 * dym;
    }
    S.pet.z.step(pz, dt);
    S.pet.x.step(px, dt);
    p.ParamAngleZ += S.pet.z.x;
    p.ParamAngleX += S.pet.x.x;

    // tail drag: pull the tail chain towards the pointer
    if (d && d.tail && S.pointer) {
      const m = puppet.toModel(S.pointer.x, S.pointer.y, S.model);
      const root = rig.point('tailRoot', tmp);
      const ch = rig.chains.tail;
      const rest = ch ? Math.atan2(ch.J[ch.n][1] - ch.J[0][1], ch.J[ch.n][0] - ch.J[0][0]) : Math.PI / 2;
      const body = affAngle(rig.T.body);
      const ang = Math.atan2(m.y - root[1], m.x - root[0]) - body;
      let diff = ang - rest;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      physics.tailHold = clamp((-diff * 180) / Math.PI / 0.72, -75, 75);
      S.tailHoldW.step(1, dt);
    } else {
      S.tailHoldW.step(0, dt);
    }
    physics.tailHoldW = clamp(S.tailHoldW.x, 0, 1);

    // expressions: the motions' eye-smile / brow / mouth changes ease in and out (a step or a
    // short fade in a motion would swap the eye / mouth layers in a few frames)
    for (const k in S.expr) p[k] = S.expr[k].step(p[k], dt);

    // blink: 0.2 s, eased close (0.08 s), a short hold, eased open
    const B = S.blink;
    if (mix.blink > 0.5) {
      B.in -= dt;
      if (B.in <= 0 && B.t < 0) {
        B.t = 0;
        B.double = rng() < 0.2;
        B.in = 2.5 + rng() * 3.5;
      }
    }
    let open = 1;
    if (B.t >= 0) {
      B.t += dt;
      const dur = 0.2;
      const total = B.double ? dur * 2 + 0.1 : dur;
      if (B.t >= total) B.t = -1;
      else {
        let t = B.t;
        if (B.double && t > dur) t = Math.max(0, t - dur - 0.1);
        const close = t < 0.08 ? t / 0.08 : t < 0.1 ? 1 : 1 - (t - 0.1) / 0.1;
        open = 1 - smooth(clamp(close, 0, 1));
      }
    }
    const bw = clamp(mix.blink, 0, 1);
    p.ParamEyeLOpen *= 1 + (open - 1) * bw;
    p.ParamEyeROpen *= 1 + (open - 1) * bw;

    // ear flicks (click) and idle twitches
    if (c.state === 'Idle' && c.clip === 'Idle') {
      S.earTwitchIn -= dt;
      if (S.earTwitchIn <= 0) {
        S.earTwitchIn = 5 + rng() * 6;
        const s = rng() < 0.5 ? 'L' : 'R';
        S.earFlick[s] = 0;
        S.earFlick.amp[s] = 0.45;
        physics.kickEar(s, (s === 'L' ? -1 : 1) * 110);
      }
    }
    for (const s of ['L', 'R']) {
      if (S.earFlick[s] < 0) continue;
      S.earFlick[s] += dt;
      const u = S.earFlick[s] / 0.42;
      if (u >= 1) { S.earFlick[s] = -1; continue; }
      p[`ParamEar${s}`] += S.earFlick.amp[s] * 22 * Math.sin(Math.PI * u) * (1 - u * 0.3);
    }

    // typing: a little nod per key, the key's paw dips
    if (S.nodT >= 0) {
      S.nodT += dt;
      if (S.nodT > 0.24) S.nodT = -1;
      else p.ParamAngleY -= 2.5 * Math.sin((Math.PI * S.nodT) / 0.24);
    }
    for (const s of ['L', 'R']) {
      if (S.tap[s] < 0) continue;
      S.tap[s] += dt;
      if (S.tap[s] > 0.16) { S.tap[s] = -1; continue; }
      if (c.state === 'Typing') p[`ParamArm${s}C`] -= 10 * Math.sin((Math.PI * S.tap[s]) / 0.16);
    }

    // talking (speech bubble shown by the host): calm eased syllables, closed rests (talk.js)
    const env = S.talkEnv.step(S.talking && !c.hidden ? 1 : 0, dt);
    if (env > 0.01) p.ParamMouthOpen = Math.max(p.ParamMouthOpen, env * 0.8 * S.talk.step(dt));
    else if (!S.talking) S.talk.reset(); // the next bubble starts a fresh phrase

    // presence: pop in out of thin air / pop away (the 3D fox's curves)
    const pr = c.presence;
    if (pr.mode === 'popIn') p.ParamScale = Math.max(0.001, easeOutBack(Math.min(1, pr.t / POP_IN)));
    else if (pr.mode === 'popOut') p.ParamScale = Math.max(0.001, 1 - easeInBack(Math.min(1, pr.t / POP_OUT)));
    else if (pr.mode === 'hidden') p.ParamScale = 0.001;
    for (const k in overrides) p[k] = overrides[k];
  }

  function updateShadow() {
    const sh = puppet.shadow;
    const vis = !controller.hidden;
    sh.visible = vis;
    if (!vis) return;
    const y = Math.max(0, p.ParamRootY);
    const k = clamp(1 - y * 1.6, 0.45, 1.2) * (1 + 0.1 * p.ParamSit) * Math.min(1, p.ParamScale);
    sh.position.set(p.ParamRootX, 0.004, 0);
    sh.scale.set(0.58 * k, 0.085 * k, 1);
    sh.material.uniforms.opacity.value = sh.userData.baseOpacity * clamp(1 - y * 2.2, 0.3, 1.1) * Math.min(1, p.ParamScale);
  }

  const kbAnchor = [0, 0, 0];
  function step(dt) {
    S.time += dt;
    controller.update(dt);
    player.update(dt);
    typingUpdate();
    interactionUpdate();
    for (const k in defaults) p[k] = defaults[k];
    const sitting = controller.state === 'Sitting';
    applyIdle(S.time, p, sitting ? 0.5 : 1);
    const mix = player.apply(p);
    overlays(dt, mix);
    clampParams(p);
    // hidden (Away) -> the root jumps off / on screen: never let the pendulums see that
    if (controller.hidden || S.wasHidden) physics.reset(p);
    else physics.step(p, dt);
    S.wasHidden = controller.hidden;
    rig.update(p);
    puppet.root.visible = !controller.hidden;

    logo.update(dt);
    const T = rig.T.body;
    kbAnchor[0] = affApplyX(T, 0, 0.19);
    kbAnchor[1] = affApplyY(T, 0, 0.19);
    kbAnchor[2] = affAngle(T);
    keyboard.update(dt, kbAnchor);
    hearts.update(dt);
    doze.setActive(sitting && controller.clip === 'Sit_Doze' && !controller.hidden);
    doze.update(dt, rig.point('headTop', tmp));
    updateShadow();
  }

  function frame(now) {
    if (!S.running) return;
    S.raf = requestAnimationFrame(frame);
    if (S.frozen) return;
    const dt = clamp((now - S.lastT) / 1000, 0, 0.1);
    S.lastT = now;
    step(dt);
    puppet.render();
  }

  /** Landscape: logo beside the fox (like the 3D framing). Portrait: logo up-left above the head. */
  function layout() {
    puppet.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); // monitor changes
    const portrait = puppet.aspect() < 0.78;
    Object.assign(puppet.box, portrait ? CONTENT_BOX_PORTRAIT : CONTENT_BOX);
    logo.pos[0] = (portrait ? LOGO_POS_PORTRAIT : LOGO_POS)[0];
    logo.pos[1] = (portrait ? LOGO_POS_PORTRAIT : LOGO_POS)[1];
  }

  function resize() {
    if (S.disposed) return;
    layout();
    puppet.resize();
    if (!S.running) return;
    puppet.render();
  }

  function resetBehaviour() {
    cancelPending();
    S.down = null;
    typingStop();
    keyboard.mode = 'hidden';
    keyboard.scale = 0;
    hearts.clear();
    doze.clear();
    doze.setActive(false);
    player.clear();
    controller.queued = null;
    controller.pendingPresence = null;
    controller.typingWanted = false;
    controller.hidden = false;
    controller.phase = null;
    controller.exitStep = null;
    controller.enterWaits = null;
    controller.toIdle(0);
    controller.setPresence('shown');
    controller.idleTime = 0;
    physics.tailHold = null;
    for (const k in S.expr) S.expr[k].reset(defaults[k]);
    S.talkEnv.reset(0);
    S.talk.reset();
  }

  // ---- API ------------------------------------------------------------------------------------

  const api = {
    start() {
      if (S.running || S.disposed) return;
      S.running = true;
      for (const [t, type, fn, opt] of bindings) t.addEventListener(type, fn, opt);
      ro?.observe(container);
      canvas.style.display = 'block';
      layout();
      puppet.resize();
      resetBehaviour();
      if (intro) controller.enter({ intro: true }); // pops in + waves, the logo a beat later
      // settle the rig + physics on the first frame's params
      step(0);
      physics.reset(p);
      puppet.render();
      S.lastT = performance.now();
      S.raf = requestAnimationFrame(frame);
    },

    stop() {
      if (!S.running) return;
      S.running = false;
      cancelAnimationFrame(S.raf);
      for (const [t, type, fn, opt] of bindings) t.removeEventListener(type, fn, opt);
      ro?.disconnect();
      cancelPending();
      if (S.down) {
        try { canvas.releasePointerCapture?.(S.down.id); } catch { /* already released */ }
        S.down = null;
      }
      S.pointer = null;
      S.hoverLogo = false;
      canvas.style.cursor = '';
      if (S.typing.active) typingStop();
      canvas.style.display = 'none';
    },

    dispose() {
      if (S.disposed) return;
      api.stop();
      S.disposed = true;
      listeners.clear();
      logo.dispose();
      hearts.dispose();
      doze.dispose();
      keyboard.dispose();
      puppet.dispose();
      if (debug && window.__live2d === api) delete window.__live2d;
    },

    request(name) {
      if (S.disposed || !SUPPORTED.has(name)) return null;
      return trigger(name);
    },

    has: (name) => SUPPORTED.has(name),
    get state() { return controller.state; },
    get clip() { return controller.clip; },
    get running() { return S.running; },
    setLookEnabled(on) { S.lookEnabled = !!on; },
    setTalking(on) { S.talking = !!on; },
    /**
     * Client-px anchors for host overlays (the shared speech bubble): the posed head centre with
     * its silhouette radius, and the logo's box. Cheap (no hit-testing), call every frame.
     */
    anchors() {
      const h = rig.point('headCenter', [0, 0]);
      const c = puppet.toClient(h[0], h[1]);
      const e = puppet.toClient(h[0] + 0.3, h[1]);
      const r = Math.max(12, Math.abs(e.x - c.x));
      const onScreen = !controller.hidden && c.x > -r * 0.3 && c.x < window.innerWidth + r * 0.3 && c.y > -r && c.y < window.innerHeight;
      const lc = puppet.toClient(logo.center[0], logo.center[1]);
      const le = puppet.toClient(logo.center[0] + 0.22, logo.center[1]);
      const lr = Math.abs(le.x - lc.x);
      return { head: { x: c.x, y: c.y, r, onScreen }, logo: { x: lc.x - lr, y: lc.y - lr, w: 2 * lr, h: 2 * lr } };
    },
    setInsetBottom(px) {
      puppet.insetBottom = Math.max(0, px || 0);
      resize();
    },
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    typeKey(code) {
      const ok = typeKey(code);
      return ok;
    },
    resize,
    canvas,

    debug: {
      params: p,
      overrides,
      controller,
      player,
      rig,
      puppet,
      physics,
      logo,
      /** Stop advancing with requestAnimationFrame (listeners stay attached). */
      freeze(on = true) { S.frozen = on; S.lastT = performance.now(); },
      /** Deterministic fixed-step simulation, then one render. */
      advance(sec, fps = 60) {
        const n = Math.max(1, Math.round(sec * fps));
        for (let i = 0; i < n; i++) step(1 / fps);
        puppet.render();
        return api.debug.info();
      },
      /** Like advance() but samples params after every step: { name: [values] }. */
      trace(sec, names, fps = 60) {
        const out = Object.fromEntries(names.map((n) => [n, []]));
        const n = Math.max(1, Math.round(sec * fps));
        for (let i = 0; i < n; i++) {
          step(1 / fps);
          for (const k of names) out[k].push(p[k]);
        }
        puppet.render();
        return out;
      },
      /** Reset, start `name` (request semantics) and simulate `t` seconds. */
      pose(name, t = 1, { seed: s = 1 } = {}) {
        rng.seed(s);
        resetBehaviour();
        logo.pose('idle');
        S.blink.t = -1;
        S.blink.in = 2.6 + rng() * 2;
        physics.reset(p);
        step(1 / 60);
        const clip = name && name !== 'Idle' ? trigger(name) : 'Idle';
        api.debug.advance(t);
        return clip;
      },
      setIdleTimeouts(sit, dozeAfter) { controller.setIdleTimeouts(sit, dozeAfter); },
      /** CPU cost of the simulation + deformation (no rendering): ms per step. */
      bench(n = 240) {
        const t0 = performance.now();
        for (let i = 0; i < n; i++) step(1 / 60);
        const cpu = (performance.now() - t0) / n;
        const t1 = performance.now();
        puppet.render();
        puppet.renderer.getContext().finish();
        return { stepMs: cpu, renderMs: performance.now() - t1, drawCalls: puppet.renderer.info.render.calls };
      },
      set auto(v) { controller.auto = v; },
      get auto() { return controller.auto; },
      partAt(x, y) { return pick(x, y); },
      /** Client px of a spot that hits `part` (scans the view), or null. */
      clientPos(part) {
        const r = canvas.getBoundingClientRect();
        const hits = [];
        const n = 72;
        for (let j = 1; j < n; j++) {
          for (let i = 1; i < n; i++) {
            const x = r.left + (i / n) * r.width;
            const y = r.top + (j / n) * r.height;
            if (pick(x, y) === part) hits.push([x, y]);
          }
        }
        if (!hits.length) return null;
        // the hit closest to the centroid (robust for concave shapes)
        const cx = hits.reduce((s, h) => s + h[0], 0) / hits.length;
        const cy = hits.reduce((s, h) => s + h[1], 0) / hits.length;
        hits.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
        return { x: hits[0][0], y: hits[0][1], count: hits.length };
      },
      info() {
        return {
          state: controller.state,
          clip: controller.clip,
          intent: controller.intent,
          phase: controller.phase,
          hidden: controller.hidden,
          running: S.running,
          presence: controller.presence.mode,
          scale: p.ParamScale,
          logo: logo.state,
          logoPresence: logo.presence,
          logoVisible: logo.visible && logo.popS > 0.01,
          logoScale: logo.popS,
          typing: S.typing.active,
          keyboard: keyboard.mode,
          keyboardWidth: keyboard.mesh.scale.x * keyboard.mesh.geometry.parameters?.width,
          keyArea: keyboard.keyArea(),
          paws: [rig.point('pawL', [0, 0]), rig.point('pawR', [0, 0])],
          keystrokes: S.typing.keystrokes,
          heartsShown: hearts.shown,
          heartActive: hearts.active,
          dozeZ: doze.active,
          earFlicks: S.flicks,
          tracks: player.tracks.map((t) => `${t.name}:${t.w.toFixed(2)}`),
          time: S.time,
          params: { ...p },
        };
      },
    },
  };

  if (debug) window.__live2d = api;
  return api;
}

export { MOTIONS };
