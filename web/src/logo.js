// Brand logo: 4 cream rounded cubes (diamond) + orange 4-point star.
// Loads logo.glb when present, otherwise builds an equivalent procedural logo with the same
// node names (spec.logo.pieces). Handles idle float, hover glow, the "activated" orbit (ref 5)
// and its presence: it pops in and away together with the fox (main.js) and is hidden (not
// drawn, not pickable) while the fox is away.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { createBlobShadow } from './scene.js';

const CUBE = 0.072; // cube edge
const GAP = 0.08; // diamond centre -> cube centre
const STAR_HOME = [0.106, 0.108, 0.0];
const ORBIT_R = 0.14; // cube orbit radius when active
const T_IN = 0.7;
const T_HOLD = 2.6;
const T_OUT = 1.0;
const POP_IN = 0.6; // s, springy scale-in (after the caller's delay), unwinding a small turn
const POP_OUT = 0.45; // s, anticipation + shrink with a little hop and spin

const smooth = (x) => x * x * (3 - 2 * x);
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const easeOutBack = (x, s = 1.9) => 1 + (s + 1) * (x - 1) ** 3 + s * (x - 1) ** 2;
const easeInBack = (x, s = 1.7) => (s + 1) * x ** 3 - s * x ** 2;
const easeOutCubic = (x) => 1 - (1 - x) ** 3;

function starShape(r = 0.058, inner = 0.012) {
  // Concave 4-point star: tips on the axes, sides pulled towards the centre.
  const s = new THREE.Shape();
  const tips = [[0, r], [r, 0], [0, -r], [-r, 0]];
  s.moveTo(...tips[0]);
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = tips[i];
    const [bx, by] = tips[(i + 1) % 4];
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const k = inner / Math.hypot(mx, my);
    s.quadraticCurveTo(mx * k, my * k, bx, by);
  }
  return s;
}

function buildProcedural(materials) {
  const group = new THREE.Group();
  const cubeGeo = new RoundedBoxGeometry(CUBE, CUBE, CUBE, 4, CUBE * 0.2);
  const cubeMat = materials.get('LogoCube');
  const layout = { Cube_Top: [0, GAP], Cube_Left: [-GAP, 0], Cube_Right: [GAP, 0], Cube_Bottom: [0, -GAP] };
  for (const [name, [x, y]] of Object.entries(layout)) {
    const m = new THREE.Mesh(cubeGeo, cubeMat);
    m.name = name;
    m.position.set(x, y, 0);
    group.add(m);
  }
  const starGeo = new THREE.ExtrudeGeometry(starShape(), {
    depth: 0.014, bevelEnabled: true, bevelThickness: 0.009, bevelSize: 0.007, bevelSegments: 5, curveSegments: 12,
  });
  starGeo.center();
  const star = new THREE.Mesh(starGeo, materials.get('LogoStar'));
  star.name = 'Star';
  star.position.set(...STAR_HOME);
  group.add(star);
  return group;
}

export async function loadLogo({ url, loader, materials }) {
  if (url) {
    try {
      const res = await fetch(url);
      const buf = res.ok ? await res.arrayBuffer() : null;
      // Vite's dev server answers a missing file with index.html, so check the binary glTF magic.
      const isGlb = buf && buf.byteLength > 12 && new TextDecoder().decode(new Uint8Array(buf, 0, 4)) === 'glTF';
      if (!isGlb) throw new Error('no logo.glb');
      const gltf = await loader.parseAsync(buf, url.replace(/[^/]*$/, ''));
      const g = gltf.scene;
      g.traverse((o) => {
        if (!o.isMesh) return;
        const m = materials.get(o.material?.name || '', o.geometry);
        if (m) o.material = m;
      });
      return { object: g, source: 'glb' };
    } catch {
      // missing or broken logo.glb -> procedural fallback
    }
  }
  return { object: buildProcedural(materials), source: 'procedural' };
}

export class Logo {
  constructor(object, { spec, source, reducedMotion = false }) {
    this.source = source;
    this.reducedMotion = reducedMotion;
    this.anchor = new THREE.Group(); // spec position/scale + facing
    this.anchor.name = 'Logo';
    this.float = new THREE.Group(); // bob + hover lift
    this.anchor.add(this.float);
    this.float.add(object);

    const g = spec.logo.gltf;
    this.anchor.position.fromArray(g.position);
    this.anchor.scale.setScalar(g.scale ?? 1);
    // Face the ref34 camera, turned a little further so the cubes show a side face.
    const cam = spec.cameras.ref34.position;
    this.anchor.rotation.y = Math.atan2(cam[0] - g.position[0], cam[2] - g.position[2]) - 0.2;

    this.pieces = {};
    for (const name of spec.logo.pieces) {
      const o = object.getObjectByName(name);
      if (!o) continue;
      this.pieces[name] = {
        obj: o,
        home: o.position.clone(),
        homeQ: o.quaternion.clone(),
        angle: Math.atan2(o.position.y, o.position.x),
        phase: Object.keys(this.pieces).length * 1.37,
      };
    }
    this.materials = new Set();
    object.traverse((m) => { if (m.isMesh) this.materials.add(m.material); });

    // Invisible pick proxy for hover/click (layer 1, like the fox colliders).
    this.proxy = new THREE.Mesh(new THREE.SphereGeometry(0.19, 16, 12), new THREE.MeshBasicMaterial({ visible: false }));
    this.proxy.name = 'collider_logo';
    this.proxy.position.set(0.02, 0.02, 0);
    this.proxy.layers.set(1);
    this.float.add(this.proxy);

    this.shadow = createBlobShadow({ radius: 0.2, opacity: 0.16 });

    this.time = 0;
    this.hover = 0;
    this.hoverTarget = 0;
    this.phase = 0; // orbit angle while active
    this.mode = 'idle'; // idle | activating | active | settling
    this.modeT = 0;
    this.act = 0; // 0 = default layout, 1 = ref-5 layout
    this.presence = 'shown'; // shown | in | out | hidden
    this.popT = 0; // s into the current pop (negative = still waiting for its delay)
    this.scale = 1; // pop scale
    this.spin = 0; // extra turn about the vertical while popping
    this.hop = 0; // extra lift while popping away
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
  }

  addTo(scene) {
    scene.add(this.anchor, this.shadow);
  }

  get state() {
    return this.mode;
  }

  get isActive() {
    return this.mode !== 'idle';
  }

  /** Drawn (possibly still popping in or away). */
  get visible() {
    return this.presence !== 'hidden';
  }

  /** Out or on its way in: hover, clicks and look-at apply. */
  get shown() {
    return this.presence === 'shown' || this.presence === 'in';
  }

  setHover(on) {
    this.hoverTarget = on ? 1 : 0;
  }

  activate() {
    if (this.mode === 'active') this.modeT = 0; // extend the hold
    else if (this.mode !== 'activating') {
      // resume from the current blend so re-activating mid-settle is smooth
      this.mode = 'activating';
      this.modeT = this.act * T_IN;
    }
  }

  /** Pop in from nothing after `delay` s (with the fox's entrance). */
  popIn(delay = 0) {
    this.presence = 'in';
    this.popT = -delay;
    this.anchor.visible = this.shadow.visible = true;
  }

  /** Pop away after `delay` s (with the fox's exit), then hidden. */
  popOut(delay = 0) {
    if (this.presence === 'hidden' || this.presence === 'out') return;
    this.presence = 'out';
    this.popT = -delay;
    this.hoverTarget = 0;
  }

  /** Snap to shown / hidden (no animation). Showing leaves a pop-in that is under way alone. */
  setShown(on) {
    if (on) {
      if (this.presence === 'shown' || this.presence === 'in') return;
      this.presence = 'shown';
      this.anchor.visible = this.shadow.visible = true;
    } else {
      this.presence = 'hidden';
      this.anchor.visible = this.shadow.visible = false;
      // comes back calm: no orbit, no glow left over from before it left
      this.mode = 'idle';
      this.act = 0;
      this.phase = 0;
      this.hover = this.hoverTarget = 0;
    }
  }

  worldPosition(name, target = new THREE.Vector3()) {
    const p = name && this.pieces[name];
    return (p ? p.obj : this.float).getWorldPosition(target);
  }

  update(dt) {
    this.time += dt;
    this.modeT += dt;
    this.updatePresence(dt);
    this.hover += (this.hoverTarget - this.hover) * (1 - Math.exp(-dt * 10));

    switch (this.mode) {
      case 'activating':
        this.act = smooth(Math.min(1, this.modeT / T_IN));
        this.phase += dt * 2.4 * this.act;
        if (this.modeT >= T_IN) { this.mode = 'active'; this.modeT = 0; }
        break;
      case 'active':
        this.act = 1;
        this.phase += dt * 2.4;
        if (this.modeT >= T_HOLD) {
          this.mode = 'settling';
          this.modeT = 0;
          this.settleFrom = this.phase;
          this.settleTo = Math.ceil(this.phase / (Math.PI * 2) + 0.15) * Math.PI * 2;
        }
        break;
      case 'settling': {
        const s = Math.min(1, this.modeT / T_OUT);
        this.act = 1 - easeInOut(s);
        this.phase = this.settleFrom + (this.settleTo - this.settleFrom) * easeInOut(s);
        if (s >= 1) { this.mode = 'idle'; this.phase = 0; this.act = 0; }
        break;
      }
      default:
        this.act = 0;
    }
    this.applyLayout();
  }

  updatePresence(dt) {
    this.popT += dt;
    const rm = this.reducedMotion;
    this.spin = this.hop = 0;
    if (this.presence === 'in') {
      const x = Math.min(1, Math.max(0, this.popT / POP_IN));
      this.scale = this.popT <= 0 ? 0 : rm ? x : easeOutBack(x);
      if (!rm) this.spin = -1.4 * (1 - easeOutCubic(x)); // arrives turning back to face the camera
      if (x >= 1) this.presence = 'shown';
    } else if (this.presence === 'out') {
      const x = Math.min(1, Math.max(0, this.popT / POP_OUT));
      this.scale = 1 - (rm ? x : easeInBack(x));
      if (!rm) {
        this.spin = 2.4 * x * x;
        this.hop = 0.05 * Math.sin(Math.PI * 0.85 * x);
      }
      if (x >= 1) this.setShown(false);
    } else this.scale = this.presence === 'hidden' ? 0 : 1;
  }

  /** Deterministic still pose for screenshots. */
  pose(state = 'idle') {
    this.time = 0;
    this.hover = this.hoverTarget = 0;
    this.presence = 'shown';
    this.anchor.visible = this.shadow.visible = true;
    this.scale = 1;
    this.spin = this.hop = 0;
    this.mode = state === 'active' ? 'active' : 'idle';
    this.modeT = 0;
    this.act = state === 'active' ? 1 : 0;
    this.phase = state === 'active' ? 0.35 : 0;
    this.applyLayout();
  }

  applyLayout() {
    const t = this.time;
    const a = this.act;
    const h = this.hover;
    const popS = Math.max(0.001, this.scale);
    this.float.position.y = 0.012 * Math.sin(t * 1.1) + 0.022 * h + this.hop;
    this.float.rotation.y = 0.12 * Math.sin(t * 0.35) + this.spin;
    this.float.scale.setScalar(popS * (1 + 0.06 * h + 0.08 * a));

    for (const [name, p] of Object.entries(this.pieces)) {
      const bob = 0.006 * Math.sin(t * 1.7 + p.phase) * (1 - a);
      const o = p.obj;
      if (name === 'Star') {
        o.position.copy(p.home).multiplyScalar(1 - a);
        o.position.y += bob;
        o.position.z += 0.02 * a;
        this._e.set(0, 0.25 * Math.sin(t * 0.8 + p.phase) * (1 - a), 0.15 * Math.sin(t * 0.6) + this.phase * 0.5 * a);
        o.quaternion.copy(p.homeQ).multiply(this._q.setFromEuler(this._e));
        o.scale.setScalar(1 + 0.25 * a + 0.03 * Math.sin(t * 2.3));
      } else {
        const r = p.home.length() + (ORBIT_R - p.home.length()) * a;
        const ang = p.angle + this.phase * a + 0.25 * a;
        o.position.set(Math.cos(ang) * r, Math.sin(ang) * r, p.home.z + 0.03 * a * Math.sin(p.phase * 3));
        o.position.y += bob;
        const tumble = a * (0.6 + this.phase * 0.8);
        this._e.set(
          0.08 * Math.sin(t * 0.9 + p.phase) * (1 - a) + tumble * Math.sin(p.phase + 1),
          0.1 * Math.sin(t * 0.7 + p.phase) * (1 - a) + tumble * 0.7,
          tumble * Math.cos(p.phase),
        );
        o.quaternion.copy(p.homeQ).multiply(this._q.setFromEuler(this._e));
      }
    }

    for (const m of this.materials) {
      if ('emissiveIntensity' in m) m.emissiveIntensity = 0.28 * h + 0.18 * a;
    }

    // Soft ground shadow under the group; lighter and wider when lifted.
    const lift = this.float.position.y;
    this.shadow.position.set(this.anchor.position.x, 0.002, this.anchor.position.z);
    this.shadow.scale.setScalar((1 + lift * 2 + 0.2 * a) * Math.min(1, popS));
    this.shadow.material.opacity = this.shadow.userData.baseOpacity * (1 - lift * 3) * Math.min(1, popS);
  }
}
