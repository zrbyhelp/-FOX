// Renderer, camera, lights, ground, environment and orbit controls.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const MARGIN = 0.9; // fraction of the usable viewport the content may fill when refitting

export function createStage(canvas, { spec, quality = 'high', debug = false }) {
  const low = quality === 'low';
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true, // background is a CSS gradient
    preserveDrawingBuffer: debug, // screenshots of posed frames
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, low ? 1.5 : 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;

  const scene = new THREE.Scene();
  function buildEnvironment() {
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
  }
  buildEnvironment();
  scene.environmentIntensity = 0.62;
  canvas.addEventListener('webglcontextrestored', buildEnvironment); // GPU reset loses the env map

  // Key: upper-left front, warm, soft shadows.
  const key = new THREE.DirectionalLight(0xfff0e0, 2.1);
  key.position.set(-1.1, 5.2, 2.2); // high key: short, soft shadow like the reference renders
  key.target.position.set(-0.1, 0.3, 0);
  key.castShadow = true;
  const sm = low ? 1024 : 2048;
  key.shadow.mapSize.set(sm, sm);
  Object.assign(key.shadow.camera, { left: -0.9, right: 0.9, top: 0.9, bottom: -0.9, near: 1, far: 9 });
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.015;
  key.shadow.radius = low ? 10 : 18;
  key.shadow.blurSamples = low ? 12 : 20;
  key.shadow.intensity = 0.6;
  scene.add(key, key.target);

  const fill = new THREE.DirectionalLight(0xf2f0ff, 0.5); // cool fill from the right
  fill.position.set(2.2, 1.2, 1.6);
  const rim = new THREE.DirectionalLight(0xffffff, 1.1); // back rim for the velvet silhouette
  rim.position.set(0.6, 1.9, -2.6);
  // warm bounce from the floor / the body below: keeps the chin, the underside of the paws and
  // the lower belly light and creamy (the art has no grey crescents under the head)
  const bounce = new THREE.DirectionalLight(0xffeedd, 0.55);
  bounce.position.set(0.3, -1.2, 2.0);
  scene.add(fill, rim, bounce);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(14, 14).rotateX(-Math.PI / 2),
    new THREE.ShadowMaterial({ color: 0x4a3a33, opacity: 0.22 }),
  );
  ground.receiveShadow = true;
  ground.name = 'Ground';
  scene.add(ground);

  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 60);
  const controls = new OrbitControls(camera, canvas);
  Object.assign(controls, {
    enableDamping: true,
    dampingFactor: 0.08,
    enablePan: false,
    minDistance: 1.2,
    maxDistance: 6,
    minPolarAngle: 0.18,
    maxPolarAngle: Math.PI / 2 - 0.06, // never below the ground
    rotateSpeed: 0.7,
    zoomSpeed: 0.8,
  });

  // World boxes that should stay in frame: the fox (with tail) and the logo on its right.
  const lp = new THREE.Vector3().fromArray(spec.logo.gltf.position);
  const content = [
    new THREE.Box3(new THREE.Vector3(-0.32, 0, -0.45), new THREE.Vector3(0.45, 1.02, 0.3)),
    new THREE.Box3().setFromCenterAndSize(lp, new THREE.Vector3(0.44, 0.44, 0.2)),
  ];
  let insetBottom = 0; // CSS px covered by the toolbar
  let shift = { x: 0, y: 0 }; // view offset (fractions of the canvas size) centring the content
  let viewName = 'ref34';

  function size() {
    return { w: canvas.clientWidth || window.innerWidth, h: canvas.clientHeight || window.innerHeight };
  }

  function applyOffset() {
    const { w, h } = size();
    if (shift.x || shift.y) camera.setViewOffset(w, h, shift.x * w, shift.y * h, w, h);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }

  const _p = new THREE.Vector3();
  function projectedContent() {
    camera.updateMatrixWorld();
    const b = new THREE.Box2();
    for (const c of content) {
      for (let i = 0; i < 8; i++) {
        _p.set(i & 1 ? c.max.x : c.min.x, i & 2 ? c.max.y : c.min.y, i & 4 ? c.max.z : c.min.z);
        _p.project(camera);
        b.expandByPoint(_p);
      }
    }
    return b;
  }

  /**
   * Place the camera at a spec preset. With `fit`, if the content does not fit the viewport
   * above the toolbar (e.g. portrait phones), pull the camera back along the preset direction
   * and recentre with a view offset; otherwise (and always without `fit`) the preset is exact.
   */
  function setView(name = 'ref34', { fit: fitContent = true } = {}) {
    const c = spec.cameras[name] || spec.cameras.ref34;
    viewName = spec.cameras[name] ? name : 'ref34';
    const { w, h } = size();
    const usable = Math.max(1, h - insetBottom) / h; // usable fraction of the height
    const target = new THREE.Vector3().fromArray(c.target);
    const offset = new THREE.Vector3().fromArray(c.position).sub(target);
    camera.fov = c.fov;
    camera.aspect = w / h;
    shift = { x: 0, y: 0 };
    applyOffset();

    let k = 1;
    let box;
    for (let i = 0; i < 4; i++) {
      camera.position.copy(target).addScaledVector(offset, k);
      camera.lookAt(target);
      box = projectedContent();
      const over = Math.max((box.max.x - box.min.x) / (2 * MARGIN), (box.max.y - box.min.y) / (2 * usable * MARGIN));
      if (!fitContent || (i === 0 && over <= 1)) break;
      k *= over; // projected size scales ~1/distance
    }
    if (fitContent && (k > 1 || insetBottom > 0)) {
      const cx = (box.min.x + box.max.x) / 2;
      const cy = (box.min.y + box.max.y) / 2;
      shift = { x: k > 1 ? cx / 2 : 0, y: (1 - cy) / 2 - usable / 2 };
    }
    controls.target.copy(target);
    controls.maxDistance = Math.max(6, offset.length() * k * 1.3);
    applyOffset();
    controls.update();
  }

  function resize() {
    const { w, h } = size();
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    applyOffset();
  }

  function setInsetBottom(px) {
    insetBottom = px;
    applyOffset();
  }

  resize();
  setView('ref34');

  return {
    renderer, scene, camera, controls, ground,
    lights: { key, fill, rim },
    setView, resize, setInsetBottom,
    get viewName() { return viewName; },
    render() { renderer.render(scene, camera); },
  };
}

// Soft radial contact shadow (a textured quad lying on the ground).
let blobTexture = null;
export function createBlobShadow({ radius = 0.3, opacity = 0.35, color = '#4a3a33' } = {}) {
  if (!blobTexture) {
    // Gaussian falloff in the green channel (alphaMap reads .g), exactly 0 at the rim.
    const n = 128;
    const data = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const r = Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2);
        const v = r >= 1 ? 0 : Math.exp(-4.5 * r * r) * (1 - r * r);
        data.set([255, v * 255, 255, 255], (y * n + x) * 4);
      }
    }
    blobTexture = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
    blobTexture.magFilter = THREE.LinearFilter;
    blobTexture.minFilter = THREE.LinearMipmapLinearFilter;
    blobTexture.generateMipmaps = true;
    blobTexture.needsUpdate = true;
  }
  const mat = new THREE.MeshBasicMaterial({
    color, alphaMap: blobTexture, transparent: true, opacity, depthWrite: false, toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2).rotateX(-Math.PI / 2), mat);
  mesh.name = 'BlobShadow';
  mesh.position.y = 0.002;
  mesh.renderOrder = 1;
  mesh.userData.baseOpacity = opacity;
  return mesh;
}
