// v0 minimal viewer (to be replaced by the full app). Exposes window.__fox for snapshots.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import spec from '../../spec.json';

const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeceae9);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.6;
const key = new THREE.DirectionalLight(0xffffff, 2.0);
key.position.set(-1.5, 3, 2.5);
key.castShadow = true;
scene.add(key);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.ShadowMaterial({ opacity: 0.12 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.01, 50);
function setCam(name) {
  const c = spec.cameras[name] || spec.cameras.ref34;
  camera.fov = c.fov;
  camera.position.fromArray(c.position);
  camera.lookAt(new THREE.Vector3().fromArray(c.target));
  camera.updateProjectionMatrix();
}
setCam('ref34');

const params = new URLSearchParams(location.search);
const gltf = await new GLTFLoader().loadAsync('./models/' + (params.get('model') || 'fox.glb'));
const fox = gltf.scene;
fox.traverse((o) => {
  if (o.isMesh) { o.frustumCulled = false; o.castShadow = true; }
});
scene.add(fox);
const mixer = new THREE.AnimationMixer(fox);
const actions = Object.fromEntries(gltf.animations.map((c) => [c.name, mixer.clipAction(c)]));
let current = actions.Idle;
current?.play();

let running = true;
const clock = new THREE.Clock();
function frame() {
  if (!running) return;
  mixer.update(Math.min(clock.getDelta(), 0.05));
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

window.__fox = {
  clips: gltf.animations.map((c) => c.name),
  clipInfo: () => gltf.animations.map((c) => ({ name: c.name, duration: c.duration })),
  async pose({ clip = 'Idle', t = 0, cam = 'ref34' } = {}) {
    running = false;
    mixer.stopAllAction();
    const a = actions[clip];
    if (a) { a.reset().play(); mixer.setTime(t); }
    setCam(cam);
    renderer.render(scene, camera);
    return true;
  },
};
window.__foxReady = true;
