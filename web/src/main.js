// Bootstrap: load everything, warm up shaders, run the frame loop.
//
// URL parameters: ?model=dev/m1.glb  ?quality=low  ?noui=1  ?debug=1 (freeze auto behaviours,
// preserve drawing buffer)  ?logo=procedural (ignore logo.glb)
import * as THREE from 'three';
import spec from '../../spec.json';
import { createStage, createBlobShadow } from './scene.js';
import { createMaterialLibrary } from './materials.js';
import { loadFox, makeLoader, DozeFx } from './fox.js';
import { loadLogo, Logo } from './logo.js';
import { Animator, POP_IN, FADE_OUT } from './animator.js';
import { Procedural } from './procedural.js';
import { Interaction } from './interaction.js';
import { Bubble } from './bubble.js';
import { MagicKeyboard, TypingController } from './keyboard.js';
import { HeartFx } from './heartfx.js';
import { createUI, createLoader } from './ui.js';
import { installDebug, makeRng } from './debug.js';

const params = new URLSearchParams(location.search);
const debug = params.get('debug') === '1';
const noUI = params.get('noui') === '1';
const quality = params.get('quality') === 'low' ? 'low' : 'high';
const modelFile = params.get('model') || 'fox.glb';
const clipsFile = modelFile === 'fox.glb' ? 'clips.json' : modelFile.replace(/\.glb$/, '.clips.json');
const reducedMotion = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const easeOutBack = (x, s = 1.7) => 1 + (s + 1) * (x - 1) ** 3 + s * (x - 1) ** 2;
const easeInBack = (x, s = 1.7) => (s + 1) * x ** 3 - s * x ** 2;

// Speech bubble lines, keyed by the action the clip was played for (animator intent).
const LINES = {
  Intro: { text: '你好呀!我是小狐狸~', maxWait: 4 },
  Enter: { text: '我回来啦!', maxWait: 4 },
  Exit: { text: '拜拜~下次见!' },
  Happy: { text: '嘿嘿,好开心!' },
  Heart: { text: '送你一颗小心心~' },
  Shrug: { text: '唔…这个嘛…' },
  Wave: { text: '嗨~', queue: false },
  Present: { text: '看!这是我们的 Logo' },
  Reach: { text: '我够得到吗?' },
  Jump: { text: '跳~!' },
  LookBack: { text: '我的尾巴好看吗?' },
  Pet: { text: '好舒服呀~', cooldown: 12 },
  Sit_Think: { text: '让我想想…', cooldown: 20 },
  Sit_Doze: { text: 'Zzz…', cooldown: 20 },
  StandUp: { text: '我醒啦!' },
};

async function main() {
  const loaderUI = noUI ? null : createLoader();
  const canvas = document.getElementById('stage');
  const rng = makeRng(debug ? 1 : Math.floor(Math.random() * 2 ** 32));
  const stage = createStage(canvas, { spec, quality, debug });
  const { renderer, scene, camera, controls } = stage;
  const materials = createMaterialLibrary({ anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()) });
  const gltfLoader = makeLoader();

  let fox;
  let logoRes;
  try {
    [fox, logoRes] = await Promise.all([
      loadFox({ url: `./models/${modelFile}`, clipsUrl: `./models/${clipsFile}`, spec, materials }),
      loadLogo({ url: params.get('logo') === 'procedural' ? null : './models/logo.glb', loader: gltfLoader, materials }),
    ]);
  } catch (err) {
    loaderUI?.fail('模型加载失败');
    throw err;
  }

  scene.add(fox.root);
  const logo = new Logo(logoRes.object, { spec, source: logoRes.source });
  logo.addTo(scene);
  const foxShadow = createBlobShadow({ radius: 0.34, opacity: 0.5 });
  scene.add(foxShadow);
  const dozeFx = new DozeFx(scene, fox.bones.head);

  const animator = new Animator(fox, { rng });
  const procedural = new Procedural(fox, { rng });
  const interaction = new Interaction({ canvas, stage, fox, logo, animator, procedural, spec, rng });
  const keyboard = new MagicKeyboard({ spec, scene, rng, reducedMotion });
  const heartFx = new HeartFx(scene, fox, { reducedMotion, rng });
  if (debug) {
    animator.auto = false;
    procedural.randomness = false;
  }

  // ---- UI & view ----------------------------------------------------------------------------
  let userMoved = false;
  controls.addEventListener('start', () => { userMoved = true; });
  let ui = null;
  if (!noUI) {
    ui = createUI({
      trigger: (name) => interaction.trigger(name),
      has: (name) => animator.has(name),
      onFollow: (on) => { interaction.followPointer = on; },
      onResetView: () => { userMoved = false; stage.setView('ref34'); },
    });
  }
  const insetBottom = () => (ui ? ui.height() + 8 : 0);
  const bubble = new Bubble({
    camera, canvas, head: fox.bones.head,
    logoCenter: (v) => logo.worldPosition(null, v),
    insetBottom,
  });
  if (noUI) bubble.enabled = false;
  const typing = new TypingController({ keyboard, animator, procedural, bubble, rng });
  interaction.typing = typing;

  const layout = () => {
    stage.resize();
    stage.setInsetBottom(insetBottom());
    if (!userMoved) stage.setView(stage.viewName);
  };
  window.addEventListener('resize', layout);
  layout();

  // Speech bubbles + heart effect hooked to what the fox does.
  animator.on((type, d) => {
    if (type === 'clip') {
      const line = LINES[d.intent];
      if (line) bubble.say(line.text, line);
      if (d.intent === 'Heart' && animator.cur) heartFx.start(animator.cur.action);
    } else if (type === 'state' && d.to === 'Away') {
      bubble.clear();
      heartFx.clear();
    }
  });

  // ---- per-frame ----------------------------------------------------------------------------
  const hipsBone = fox.bones.hips || fox.root;
  const v = new THREE.Vector3();

  function updateShadows() {
    const s = fox.root.scale.y;
    hipsBone.getWorldPosition(v);
    const dy = (v.y - fox.restHipsY * s) / Math.max(s, 1e-3); // + when jumping, - when sitting
    foxShadow.position.set(v.x, 0.002, v.z);
    foxShadow.scale.setScalar(THREE.MathUtils.clamp(1 - dy * 1.6, 0.45, 1.2) * s);
    foxShadow.material.opacity = foxShadow.userData.baseOpacity * THREE.MathUtils.clamp(1 - dy * 2.2, 0.3, 1.15) * Math.min(1, s);
    foxShadow.visible = fox.root.visible;
  }

  /** Fox scale / visibility from the animator's presence (pop-in, shrink-away, hidden). */
  function applyPresence() {
    const p = animator.presence;
    let s = 1;
    if (p.mode === 'popIn') {
      const x = Math.min(1, p.t / POP_IN);
      s = reducedMotion ? x : easeOutBack(x);
    } else if (p.mode === 'fadeOut') {
      const x = Math.min(1, p.t / FADE_OUT);
      s = 1 - (reducedMotion ? x : easeInBack(x));
    } else if (p.mode === 'hidden') s = 0;
    fox.root.scale.setScalar(Math.max(0.001, s));
    fox.root.visible = p.mode !== 'hidden';
  }

  const hooks = { afterMixer: null, afterStep: null };

  function step(dt) {
    procedural.restore();
    animator.update(dt);
    applyPresence();
    fox.root.updateMatrixWorld(true);
    hooks.afterMixer?.(dt);
    logo.update(dt);
    const away = animator.state === 'Away';
    interaction.paused = away;
    procedural.paused = away;
    keyboard.setViewer(camera);
    typing.update(dt);
    interaction.update(dt);
    procedural.talk = bubble.talking;
    procedural.update(dt, animator.layers);
    heartFx.update(dt, camera, animator.cur?.action);
    dozeFx.setActive(animator.state === 'Sitting' && animator.clip === 'Sit_Doze');
    dozeFx.update(dt);
    updateShadows();
    hooks.afterStep?.(dt);
  }

  /** DOM work after the camera settled for this frame. */
  function post(dt) {
    bubble.update(dt);
    ui?.update({
      state: animator.state, clip: animator.clip, intent: animator.intent, phase: animator.phase,
      typing: typing.active, demo: typing.demoActive,
    });
  }

  const timer = new THREE.Timer();
  timer.connect(document);
  let running = false;
  let maxDelta = 0.1; // s; long frames slow the animation down instead of jumping
  let fixedStep = 0; // > 0: advance in fixed steps (motion analysis at a steady 60 Hz)
  let acc = 0;
  function frame() {
    if (!running) return;
    requestAnimationFrame(frame);
    timer.update(); // performance.now(): monotonic, unlike the rAF timestamp vs. timer.reset()
    const dt = THREE.MathUtils.clamp(timer.getDelta(), 0, maxDelta);
    if (fixedStep > 0) {
      acc += dt;
      for (let n = 0; acc >= fixedStep && n < 240; n++) {
        step(fixedStep);
        acc -= fixedStep;
      }
    } else step(dt);
    controls.update();
    post(dt);
    renderer.render(scene, camera);
  }

  const app = {
    stage, fox, logo, animator, procedural, interaction, rng, dozeFx, updateShadows, materials, step,
    bubble, keyboard, typing, heartFx, hooks, foxShadow,
    startLoop() {
      if (running) return;
      running = true;
      timer.reset();
      requestAnimationFrame(frame);
    },
    stopLoop() { running = false; },
    setMaxDelta(s) { maxDelta = s; },
    setFixedStep(s) { fixedStep = s; acc = 0; },
    finishIntro() {
      animator.presence = { mode: 'shown', t: 0 };
      applyPresence();
    },
  };

  // ---- warm-up: compile every program (incl. shadow + sprite) before the first real frame ----
  fox.root.scale.setScalar(0.001);
  logo.startPop(0.35);
  logo.update(0);
  keyboard.group.visible = keyboard.shadow.visible = true;
  heartFx.group.visible = true;
  await renderer.compileAsync(scene, camera);
  renderer.render(scene, camera);
  keyboard.group.visible = keyboard.shadow.visible = false;
  heartFx.group.visible = false;
  dozeFx.clear();

  animator.toIdle(0);
  animator.enter({ intro: true }); // hop in (Enter clip) or pop in + Wave
  applyPresence();
  app.startLoop();
  installDebug(app);
  loaderUI?.done();
  window.__foxReady = true;
}

main().catch((err) => {
  console.error(err);
  const el = document.querySelector('.loader');
  if (el) {
    el.textContent = '无法启动 3D:浏览器不支持 WebGL,或模型加载失败';
    el.classList.remove('hidden');
    el.classList.add('error');
  }
});
