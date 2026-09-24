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
import { Animator } from './animator.js';
import { Procedural } from './procedural.js';
import { Interaction } from './interaction.js';
import { createUI, createLoader } from './ui.js';
import { installDebug, makeRng } from './debug.js';

const params = new URLSearchParams(location.search);
const debug = params.get('debug') === '1';
const noUI = params.get('noui') === '1';
const quality = params.get('quality') === 'low' ? 'low' : 'high';
const modelFile = params.get('model') || 'fox.glb';
const clipsFile = modelFile === 'fox.glb' ? 'clips.json' : modelFile.replace(/\.glb$/, '.clips.json');

const easeOutBack = (x, s = 1.7) => 1 + (s + 1) * (x - 1) ** 3 + s * (x - 1) ** 2;

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
  const layout = () => {
    stage.resize();
    stage.setInsetBottom(ui ? ui.height() + 8 : 0);
    if (!userMoved) stage.setView(stage.viewName);
  };
  window.addEventListener('resize', layout);
  layout();

  // ---- per-frame ----------------------------------------------------------------------------
  const intro = { t: 0, done: false };
  const hipsBone = fox.bones.hips || fox.root;
  const v = new THREE.Vector3();

  function updateShadows() {
    const s = fox.root.scale.y;
    hipsBone.getWorldPosition(v);
    const dy = (v.y - fox.restHipsY * s) / Math.max(s, 1e-3); // + when jumping, - when sitting
    foxShadow.position.set(v.x, 0.002, v.z);
    foxShadow.scale.setScalar(THREE.MathUtils.clamp(1 - dy * 1.6, 0.45, 1.2) * s);
    foxShadow.material.opacity = foxShadow.userData.baseOpacity * THREE.MathUtils.clamp(1 - dy * 2.2, 0.3, 1.15) * Math.min(1, s);
  }

  function updateIntro(dt) {
    if (intro.done) return;
    intro.t += dt;
    const s = Math.min(1, intro.t / 0.8);
    fox.root.scale.setScalar(Math.max(0.001, easeOutBack(s)));
    if (s >= 1) intro.done = true;
  }

  function step(dt) {
    procedural.restore();
    updateIntro(dt);
    animator.update(dt);
    fox.root.updateMatrixWorld(true);
    logo.update(dt);
    interaction.update(dt);
    procedural.update(dt, animator.layers);
    dozeFx.setActive(animator.state === 'Sitting' && animator.clip === 'Sit_Doze');
    dozeFx.update(dt);
    updateShadows();
  }

  const timer = new THREE.Timer();
  timer.connect(document);
  let running = false;
  let maxDelta = 0.1; // s; long frames slow the animation down instead of jumping
  function frame() {
    if (!running) return;
    requestAnimationFrame(frame);
    timer.update(); // performance.now(): monotonic, unlike the rAF timestamp vs. timer.reset()
    step(THREE.MathUtils.clamp(timer.getDelta(), 0, maxDelta));
    controls.update();
    renderer.render(scene, camera);
  }

  const app = {
    stage, fox, logo, animator, procedural, interaction, rng, dozeFx, updateShadows, materials, step,
    startLoop() {
      if (running) return;
      running = true;
      timer.reset();
      requestAnimationFrame(frame);
    },
    stopLoop() { running = false; },
    setMaxDelta(s) { maxDelta = s; },
    finishIntro() {
      intro.done = true;
      fox.root.scale.setScalar(1);
    },
  };

  // ---- warm-up: compile every program (incl. shadow + sprite) before the first real frame ----
  fox.root.scale.setScalar(0.001);
  logo.startPop(0.35);
  logo.update(0);
  await renderer.compileAsync(scene, camera);
  renderer.render(scene, camera);
  dozeFx.clear();

  animator.toIdle(0);
  animator.request('Wave'); // pop-in greeting
  app.startLoop();
  installDebug(app);
  loaderUI?.done();
  window.__foxReady = true;
}

main();
