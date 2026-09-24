// Loads fox.glb, swaps materials, prepares actions and clip metadata.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

// Defaults used when clips.json lacks a field. Weights are 0..1 for the procedural layers;
// lookAtLogo makes the look-at target the logo while the clip plays.
const META_DEFAULTS = {
  Idle: { priority: 0 },
  Idle_LookAround: { priority: 1, lookAt: 0 },
  Wave: { priority: 2, lookAt: 0.4 },
  Happy: { priority: 2 },
  Heart: { priority: 2 },
  Present: { priority: 2, lookAtLogo: true },
  Reach: { priority: 3, lookAtLogo: true },
  Shrug: { priority: 2 },
  SitDown: { priority: 4, interruptible: false },
  Sit_Think: { priority: 1 },
  Sit_Doze: { priority: 1, lookAt: 0, blink: 0 },
  StandUp: { priority: 4, interruptible: false },
  Jump: { priority: 3, interruptible: false },
  Pet: { priority: 3 },
  LookBack: { priority: 2, lookAt: 0 },
  Enter: { priority: 5, interruptible: false, lookAt: 0.3 },
  Exit: { priority: 5, interruptible: false, lookAt: 0 },
  Type: { priority: 1, lookAt: 0.45 },
};

// Behaviour the web app relies on, whatever clips.json says (Jump carries root motion and must
// play to the end; typing and clicks never cut it off). Enter / Exit clips of older models are
// never played: the fox pops in and away instead (animator.js).
const META_FORCED = {
  Enter: { interruptible: false },
  Exit: { interruptible: false },
  Jump: { interruptible: false },
};

export function makeLoader() {
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
}

async function fetchJSON(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/**
 * Rest-pose (pre-skinning) positions in the model's own space, stored as `restPos`.
 * Computed on the CPU so quantised / meshopt-compressed positions still give one continuous,
 * correctly scaled noise domain across all parts.
 */
function addRestPositions(mesh, modelInverse) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const out = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  const toModel = new THREE.Matrix4().multiplyMatrices(modelInverse, mesh.matrixWorld);
  for (let i = 0; i < pos.count; i++) {
    mesh.getVertexPosition(i, v); // applies skinning with the current (rest) bone matrices
    v.applyMatrix4(toModel);
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  geo.setAttribute('restPos', new THREE.BufferAttribute(out, 3));
}

export async function loadFox({ url, clipsUrl, spec, materials }) {
  const gltf = await makeLoader().loadAsync(url);
  const root = gltf.scene;
  root.name = 'Fox';
  root.updateMatrixWorld(true);

  const bones = {};
  root.traverse((o) => { if (o.isBone) bones[o.name] = o; });

  // Actions are created for EVERY clip before any procedural code touches the bones, so the
  // mixer's bindings capture the true rest pose. Each clip also gets a "twin" action that shares
  // the tracks, so a clip can crossfade into a restart of itself.
  const mixer = new THREE.AnimationMixer(root);
  const actions = {};
  for (const clip of gltf.animations) {
    const twin = new THREE.AnimationClip(clip.name, clip.duration, clip.tracks, clip.blendMode);
    actions[clip.name] = [mixer.clipAction(clip), mixer.clipAction(twin)];
  }

  const modelInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const meshes = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    meshes.push(o);
    if (o.isSkinnedMesh) o.frustumCulled = false; // bones move far outside the bind-pose bounds
    o.castShadow = true;
    o.receiveShadow = true;
    const geo = o.geometry;
    if (geo.attributes._ao) {
      geo.setAttribute('furAO', geo.attributes._ao);
      geo.deleteAttribute('_ao');
    }
    const matName = o.material?.name || '';
    if (/^(Fur|Scarf)/.test(matName)) addRestPositions(o, modelInverse);
    const mat = materials.get(matName, geo);
    if (mat) {
      o.material.dispose();
      o.material = mat;
    }
  });

  const clipsJson = (clipsUrl && (await fetchJSON(clipsUrl))) || {};
  const specClips = Object.fromEntries(spec.clips.map((c) => [c.name, c]));
  const meta = {};
  for (const clip of gltf.animations) {
    const s = specClips[clip.name] || {};
    meta[clip.name] = {
      loop: s.loop ?? false,
      priority: 2,
      interruptible: true,
      refTime: null,
      lookAt: 1,
      blink: 1,
      springs: 1,
      lookAtLogo: false,
      ...META_DEFAULTS[clip.name],
      ...clipsJson[clip.name],
      ...META_FORCED[clip.name],
      duration: clip.duration,
    };
  }

  const hips = bones.hips || bones.root || root;
  const restHipsY = hips.getWorldPosition(new THREE.Vector3()).y;

  return { root, bones, mixer, actions, meta, meshes, clips: gltf.animations.map((c) => c.name), restHipsY };
}

// ---------------------------------------------------------------------------------------------
// Floating "Z" sprites while dozing.

const SPAWN_OFFSET = new THREE.Vector3(0.12, 0.42, 0.05); // from the head pivot, world axes

export class DozeFx {
  constructor(scene, headBone) {
    this.head = headBone;
    this.pool = [];
    this.active = false;
    this.timer = 0;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.font = '700 50px "Baloo 2", "Arial Rounded MT Bold", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 8;
    g.strokeStyle = '#ffffff';
    g.strokeText('Z', 32, 34);
    g.fillStyle = '#e8743c';
    g.fillText('Z', 32, 34);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    for (let i = 0; i < 4; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
      s.name = 'DozeZ';
      s.userData.life = -1;
      scene.add(s);
      this.pool.push(s);
    }
    this._v = new THREE.Vector3();
  }

  setActive(on) { this.active = on; }

  clear() {
    this.active = false;
    for (const s of this.pool) { s.userData.life = -1; s.visible = false; }
  }

  update(dt) {
    if (this.active) {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.timer = 1.1;
        const s = this.pool.find((p) => p.userData.life < 0);
        if (s) {
          this.head.getWorldPosition(this._v).add(SPAWN_OFFSET);
          s.position.copy(this._v);
          s.userData.origin = this._v.clone();
          s.userData.life = 0;
          s.visible = true;
        }
      }
    }
    for (const s of this.pool) {
      if (s.userData.life < 0) continue;
      const life = (s.userData.life += dt / 2.6);
      if (life >= 1) { s.userData.life = -1; s.visible = false; continue; }
      const o = s.userData.origin;
      s.position.set(o.x + 0.12 * life + 0.025 * Math.sin(life * 7), o.y + 0.28 * life, o.z);
      const sc = 0.045 + 0.06 * life;
      s.scale.set(sc, sc, sc);
      s.material.opacity = Math.min(1, life * 6) * (1 - life) * 1.1;
    }
  }
}
