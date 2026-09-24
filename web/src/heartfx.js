// 比心 effect: a plump glossy pink 3D heart pops out between the paws while the Heart clip plays,
// bobs and drifts up, then pops away; tiny hearts float up around it.
import * as THREE from 'three';

const SPAWN_AT = 0.45; // s into the clip
const END_AT = 2.1; // s into the clip: pop away
const OUT = 0.28; // s pop-away
const SIZE = 0.1; // heart width (fox height = 1)
const RISE = 0.12;
const FORWARD = 0.07; // in front of the chest

const easeOutBack = (x, s = 2.2) => 1 + (s + 1) * (x - 1) ** 3 + s * (x - 1) ** 2;

function heartShape() {
  // Symmetric plump heart, 1 unit wide, tip at the bottom.
  const s = new THREE.Shape();
  s.moveTo(0, -0.42);
  s.bezierCurveTo(0.14, -0.3, 0.5, -0.1, 0.5, 0.15);
  s.bezierCurveTo(0.5, 0.4, 0.24, 0.5, 0, 0.27);
  s.bezierCurveTo(-0.24, 0.5, -0.5, 0.4, -0.5, 0.15);
  s.bezierCurveTo(-0.5, -0.1, -0.14, -0.3, 0, -0.42);
  return s;
}

function heartTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.translate(32, 34);
  g.scale(52, -52);
  const path = new Path2D();
  const pts = heartShape().getPoints(24);
  pts.forEach((p, i) => (i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y)));
  path.closePath();
  const grad = g.createLinearGradient(0, 0.5, 0, -0.45);
  grad.addColorStop(0, '#FFB3C3');
  grad.addColorStop(1, '#FF6F8E');
  g.fillStyle = grad;
  g.fill(path);
  g.lineWidth = 0.07;
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.stroke(path);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class HeartFx {
  constructor(scene, fox, { reducedMotion = false, rng = Math.random } = {}) {
    this.fox = fox;
    this.reducedMotion = reducedMotion;
    this.rng = rng;

    const geo = new THREE.ExtrudeGeometry(heartShape(), {
      depth: 0.12, bevelEnabled: true, bevelThickness: 0.16, bevelSize: 0.11, bevelSegments: 10, curveSegments: 28,
    });
    geo.center();
    geo.scale(SIZE, SIZE, SIZE);
    geo.computeVertexNormals();
    const mat = new THREE.MeshPhysicalMaterial({
      color: '#FF7F9A', roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08, sheen: 0.4, sheenColor: new THREE.Color('#FFD6E0'),
      emissive: '#FF5C7F', emissiveIntensity: 0.08, transparent: true,
    });
    this.heart = new THREE.Mesh(geo, mat);
    this.heart.name = 'HeartFx';
    this.heart.castShadow = true;
    // lighter highlight on the upper-left lobe
    const hl = new THREE.Mesh(
      new THREE.SphereGeometry(SIZE * 0.1, 16, 12),
      new THREE.MeshBasicMaterial({ color: '#FFE4EB', transparent: true, opacity: 0.85, toneMapped: false }),
    );
    hl.scale.set(1.25, 0.8, 0.35);
    hl.rotation.z = 0.6;
    hl.position.set(-SIZE * 0.2, SIZE * 0.14, SIZE * 0.14);
    this.heart.add(hl);
    this.highlight = hl;
    this.group = new THREE.Group();
    this.group.add(this.heart);
    this.group.visible = false;
    scene.add(this.group);

    const tex = heartTexture();
    this.particles = [];
    for (let i = 0; i < 6; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
      s.name = 'HeartParticle';
      s.visible = false;
      s.userData = { life: -1, vel: new THREE.Vector3(), delay: 0, size: 0.03, sway: 0 };
      scene.add(s);
      this.particles.push(s);
    }

    this.pending = null; // { action } waiting for SPAWN_AT
    this.t = -1; // time since spawn, -1 = idle
    this.origin = new THREE.Vector3();
    this.shown = 0; // hearts shown (tests)
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
  }

  get visible() {
    return this.group.visible;
  }

  /** The Heart clip just started (animator 'clip' event). */
  start(action) {
    this.pending = { action };
  }

  clear() {
    this.pending = null;
    this.t = -1;
    this.group.visible = false;
    for (const p of this.particles) { p.userData.life = -1; p.visible = false; }
  }

  spawn() {
    const { paw_L: l, paw_R: r, chest, root } = this.fox.bones;
    if (l && r) this.origin.copy(l.getWorldPosition(this._v)).add(r.getWorldPosition(this._v2)).multiplyScalar(0.5);
    else (chest || this.fox.root).getWorldPosition(this.origin);
    const fwd = this._v.set(0, 0, 1);
    if (root) fwd.applyQuaternion(root.getWorldQuaternion(new THREE.Quaternion()));
    this.origin.addScaledVector(fwd.setY(0).normalize(), FORWARD);
    this.origin.y += 0.02;
    this.t = 0;
    this.group.visible = true;
    this.shown++;
    if (!this.reducedMotion) {
      this.particles.forEach((p, i) => {
        const u = p.userData;
        u.life = 0;
        u.delay = 0.25 + i * 0.18 + this.rng() * 0.1;
        u.size = 0.022 + this.rng() * 0.016;
        u.sway = this.rng() * Math.PI * 2;
        u.vel.set((this.rng() - 0.5) * 0.08, 0.1 + this.rng() * 0.07, (this.rng() - 0.5) * 0.04);
        p.position.copy(this.origin).add(this._v2.set((this.rng() - 0.5) * 0.08, (this.rng() - 0.3) * 0.05, 0));
        p.visible = false;
      });
    }
  }

  update(dt, camera, currentAction) {
    if (this.pending) {
      const a = this.pending.action;
      if (a !== currentAction || !a.isScheduled()) this.pending = null; // interrupted before the paws met
      else if (a.time >= SPAWN_AT) {
        this.pending = null;
        this.endAt = END_AT - a.time;
        this.spawn();
      }
    }
    if (this.t >= 0) {
      this.t += dt;
      const t = this.t;
      const life = Math.max(0.6, this.endAt ?? END_AT - SPAWN_AT);
      let s;
      if (t < life) s = this.reducedMotion ? Math.min(1, t / 0.2) : easeOutBack(Math.min(1, t / 0.45));
      else {
        const x = Math.min(1, (t - life) / OUT);
        s = (1 + 0.25 * Math.sin(Math.PI * Math.min(1, x * 1.6))) * (1 - x);
        this.heart.material.opacity = 1 - x * x;
        if (x >= 1) {
          this.t = -1;
          this.group.visible = false;
          this.heart.material.opacity = 1;
        }
      }
      if (this.t >= 0) {
        const rise = RISE * (1 - Math.exp(-t * 1.6));
        this.group.position.copy(this.origin);
        this.group.position.y += rise + 0.008 * Math.sin(t * 5.5);
        // face the camera (yaw only) with a gentle wobble
        const dx = camera.position.x - this.group.position.x;
        const dz = camera.position.z - this.group.position.z;
        this.group.rotation.set(0, Math.atan2(dx, dz) + 0.22 * Math.sin(t * 3.1), 0.08 * Math.sin(t * 4.3));
        const beat = 1 + 0.05 * Math.max(0, Math.sin(t * 9)) * (t < life ? 1 : 0);
        this.group.scale.setScalar(Math.max(0.001, s * beat));
      }
    }
    for (const p of this.particles) {
      const u = p.userData;
      if (u.life < 0) continue;
      u.life += dt;
      const l = u.life - u.delay;
      if (l < 0) continue;
      const dur = 1.3;
      if (l >= dur) { u.life = -1; p.visible = false; continue; }
      p.visible = true;
      p.position.addScaledVector(u.vel, dt);
      p.position.x += 0.02 * Math.cos(u.sway + l * 4) * dt;
      const k = l / dur;
      const sc = u.size * Math.min(1, k * 5);
      p.scale.set(sc, sc, sc);
      p.material.opacity = Math.min(1, (1 - k) * 2);
    }
  }
}
