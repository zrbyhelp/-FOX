// Offline layer renderer for the Live2D-style puppet: renders every mesh of fox_layers.glb
// (a front "puppet" pose exported by tools/fox_build/layers.py) alone, orthographic and head-on,
// with the same materials and lights as the 3D scene. Driven by web/scripts/render_layers.mjs.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { makeLoader } from '../fox.js';
import { createMaterialLibrary } from '../materials.js';

const PX_PER_UNIT = 1400; // 1 unit = fox height to the ear tips
const MARGIN = 0.012; // units of transparent border around each layer

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.setClearColor(0x000000, 0);
document.body.append(renderer.domElement);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.62;
pmrem.dispose();
// Same rig as web/src/scene.js (shadows off: each layer is rendered alone).
const key = new THREE.DirectionalLight(0xfff0e0, 2.1);
key.position.set(-1.1, 5.2, 2.2);
key.target.position.set(-0.1, 0.3, 0);
const fill = new THREE.DirectionalLight(0xf2f0ff, 0.5);
fill.position.set(2.2, 1.2, 1.6);
const rim = new THREE.DirectionalLight(0xffffff, 1.1);
rim.position.set(0.6, 1.9, -2.6);
scene.add(key, key.target, fill, rim);

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
camera.position.set(0, 0.5, 5);
camera.lookAt(0, 0.5, 0);

const params = new URLSearchParams(location.search);
const materials = createMaterialLibrary({ anisotropy: 8 });
const gltf = await makeLoader().loadAsync('./models/' + (params.get('model') || 'fox_layers.glb'));
const root = gltf.scene;
scene.add(root);
root.updateMatrixWorld(true);

const meshes = {};
root.traverse((o) => {
  if (!o.isMesh) return;
  const geo = o.geometry;
  if (geo.attributes._ao) {
    geo.setAttribute('furAO', geo.attributes._ao);
    geo.deleteAttribute('_ao');
  }
  // static meshes: the rest position is the position (drives the fur grain)
  geo.setAttribute('restPos', geo.attributes.position.clone());
  const mat = materials.get(o.material?.name || '', geo);
  if (mat) o.material = mat;
  // multi-material meshes come in as a Group of primitives named after the object
  const layer = (o.parent && o.parent !== root && !o.parent.isScene ? o.parent.name : o.name).replace(/_\d+$/, '');
  (meshes[layer] ||= []).push(o);
});

function bbox(list) {
  const b = new THREE.Box3();
  for (const m of list) b.expandByObject(m);
  return b;
}

function renderLayer(name) {
  const list = name ? meshes[name] : Object.values(meshes).flat();
  for (const [n, ms] of Object.entries(meshes)) for (const m of ms) m.visible = !name || n === name;
  const b = bbox(list);
  const x0 = b.min.x - MARGIN, x1 = b.max.x + MARGIN, y0 = b.min.y - MARGIN, y1 = b.max.y + MARGIN;
  const w = Math.ceil((x1 - x0) * PX_PER_UNIT), h = Math.ceil((y1 - y0) * PX_PER_UNIT);
  renderer.setSize(w, h, false);
  Object.assign(camera, { left: x0, right: x0 + w / PX_PER_UNIT, bottom: y0, top: y0 + h / PX_PER_UNIT });
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  return { name, x0, y0, w: w / PX_PER_UNIT, h: h / PX_PER_UNIT, px: [w, h], dataUrl: renderer.domElement.toDataURL('image/png') };
}

window.__layerNames = Object.keys(meshes);
window.__renderLayer = (name) => renderLayer(name);
window.__renderAll = () => renderLayer(null);
window.__pxPerUnit = PX_PER_UNIT;
window.__layersReady = true;
