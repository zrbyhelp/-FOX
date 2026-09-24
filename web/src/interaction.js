// Pointer interaction: bone-attached proxy colliders, clicks, petting, tail drag / hover flick,
// logo hover/click, look-at targets, and the shared trigger() used by the toolbar and the debug API.
import * as THREE from 'three';

const PICK_LAYER = 1;
const CLICK_DELAY = 250; // ms to wait for a possible double-click
const PET_DISTANCE = 12; // px of pointer travel on the head before it counts as petting
const DRAG_DISTANCE = 6; // px of pointer travel on the tail before it counts as a drag
const TAIL_FLICK_COOLDOWN = 1; // s between hover flicks
const POINTER_IDLE = 5; // s without pointer movement before the look-at target is dropped

export class Interaction {
  constructor({ canvas, stage, fox, logo, animator, procedural, spec, rng = Math.random }) {
    Object.assign(this, { canvas, stage, fox, logo, animator, procedural, rng });
    this.camera = stage.camera;
    this.controls = stage.controls;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.layers.set(PICK_LAYER);
    this.ndc = new THREE.Vector2();

    this.colliders = {};
    for (const [part, c] of Object.entries(spec.colliders)) {
      if (part.startsWith('_')) continue;
      const bone = fox.bones[c.bone];
      if (!bone) continue;
      const m = new THREE.Mesh(new THREE.SphereGeometry(c.radius, 16, 12), new THREE.MeshBasicMaterial({ visible: false }));
      m.name = `collider_${part}`;
      m.userData.part = part;
      m.position.fromArray(c.offset);
      m.layers.set(PICK_LAYER);
      bone.add(m);
      this.colliders[part] = m;
    }
    // The tail is long and curls behind the body: besides spec's collider (on tail_3), cover the
    // rest of the chain so whatever part of the tail is visible can be clicked, hovered, dragged.
    this.tailColliders = [];
    for (const [name, r] of [['tail_6', 0.085], ['tail_5', 0.1], ['tail_4', 0.11], ['tail_2', 0.1]]) {
      const bone = fox.bones[name];
      const child = bone?.children.find((c) => c.isBone);
      if (!bone || !spec.colliders.tail) continue;
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), new THREE.MeshBasicMaterial({ visible: false }));
      m.name = `collider_tail_${name}`;
      m.userData.part = 'tail';
      m.position.set(0, (child ? child.position.length() : 0.1) * 0.5, 0); // middle of the link
      m.layers.set(PICK_LAYER);
      bone.add(m);
      this.tailColliders.push(m);
    }
    if (this.colliders.tail) this.tailColliders.push(this.colliders.tail);
    this.foxPickables = [...Object.values(this.colliders), ...this.tailColliders.filter((m) => m !== this.colliders.tail)];
    this.pickables = [...this.foxPickables, logo.proxy];

    this.pointer = null; // last pointer {x, y, type} in client px
    this.pointerAt = -Infinity; // time of last pointer movement (s)
    this.down = null; // active press on the fox/logo
    this.pending = null; // single-click waiting for a possible double-click
    this.hoverLogo = false;
    this.logoFocusUntil = 0; // look at the logo until this time
    this.lastPresent = -Infinity;
    this.touchHoverUntil = 0; // touch: a second tap before this time activates the logo
    this.glowUntil = 0; // logo hover glow without a mouse hover
    this.time = 0;
    this.lookVec = new THREE.Vector3();
    this.hoverDirty = false;
    this.followPointer = true; // toolbar toggle 跟随鼠标
    this.paused = false; // fox away (the logo left with it): nothing reacts
    this.typing = null; // TypingController (set by main.js)
    this.hoverPart = null;
    this.lastTailFlick = -Infinity;
    this.hitPoint = new THREE.Vector3();
    this.dragPlane = new THREE.Plane();
    this.dragDelta = new THREE.Vector3();

    // Capture phase on the parent: runs before OrbitControls' own canvas listener, so a press
    // on the fox or logo never starts an orbit.
    canvas.parentElement.addEventListener('pointerdown', (e) => this.onDown(e), { capture: true });
    window.addEventListener('pointermove', (e) => this.onMove(e), { passive: true });
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('pointercancel', (e) => this.onUp(e, true));
    window.addEventListener('pointerout', (e) => { if (!e.relatedTarget) this.pointer = null; });
    this.controls.addEventListener('start', () => this.animator.poke(false));
  }

  // ---- picking --------------------------------------------------------------------------------

  pick(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    // the logo only while it is out (it pops in and away with the fox, hidden while away)
    const logoOn = this.logo.shown;
    const targets = this.paused ? (logoOn ? [this.logo.proxy] : []) : logoOn ? this.pickables : this.foxPickables;
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    if (!hit) return null;
    this.hitPoint.copy(hit.point);
    return hit.object === this.logo.proxy ? 'logo' : hit.object.userData.part;
  }

  // ---- pointer events -------------------------------------------------------------------------

  onDown(e) {
    if (e.target !== this.canvas || !e.isPrimary) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return; // right/middle click: not a poke
    this.onMove(e);
    const part = this.pick(e.clientX, e.clientY);
    if (!part) return; // empty space -> OrbitControls rotates the view
    e.stopPropagation();
    e.preventDefault();
    this.controls.enabled = false;
    this.canvas.setPointerCapture?.(e.pointerId);
    this.down = { part, x: e.clientX, y: e.clientY, travel: 0, id: e.pointerId, type: e.pointerType, petting: false, dragging: false, grab: this.hitPoint.clone() };
  }

  onMove(e) {
    if (!e.isPrimary) return;
    const prev = this.pointer;
    this.pointer = { x: e.clientX, y: e.clientY, type: e.pointerType };
    this.pointerAt = this.time;
    this.hoverDirty = true;
    if (this.animator.state !== 'Sitting' && e.pointerType === 'mouse' && e.target === this.canvas) this.animator.poke(false);
    const d = this.down;
    if (!d || d.id !== e.pointerId || !prev) return;
    d.travel += Math.hypot(e.clientX - prev.x, e.clientY - prev.y);
    if (!d.petting && d.part === 'head' && d.travel > PET_DISTANCE) {
      d.petting = this.animator.startPet();
      this.cancelPending();
    }
    if (d.part === 'tail') {
      if (!d.dragging && d.travel > DRAG_DISTANCE) {
        d.dragging = true;
        this.cancelPending();
        this.animator.poke(false);
        // drag on a camera-facing plane through the grabbed point
        this.dragPlane.setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(this.dragDelta), d.grab);
        this.canvas.style.cursor = 'grabbing';
      }
      if (d.dragging) this.dragTail(e.clientX, e.clientY, d);
    }
  }

  /** Bend the tail towards the pointer (displacement of the grab point on the drag plane). */
  dragTail(x, y, d) {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const p = this.raycaster.ray.intersectPlane(this.dragPlane, this.dragDelta);
    if (p) this.procedural.dragTail(p.sub(d.grab));
  }

  onUp(e, cancelled = false) {
    const d = this.down;
    if (!d || d.id !== e.pointerId) return;
    this.down = null;
    this.controls.enabled = true;
    if (d.petting) {
      this.animator.endPet();
      return;
    }
    if (d.dragging) {
      // let go: the tail springs back (with overshoot) and the fox looks round at it
      this.procedural.dragTail(null);
      this.canvas.style.cursor = '';
      this.hoverDirty = true;
      if (!cancelled) this.trigger('tail');
      return;
    }
    if (cancelled || d.travel > PET_DISTANCE) return;
    if (d.part === 'logo') this.clickLogo(d.type);
    else this.clickFox(d.part);
  }

  cancelPending() {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }

  clickFox(part) {
    if (this.paused) return;
    if (this.animator.state === 'Sitting') {
      this.cancelPending();
      this.animator.poke(true); // stand up, then wave
      return;
    }
    this.animator.poke(false);
    if (this.pending) {
      this.cancelPending();
      this.animator.request('Jump');
      return;
    }
    this.pending = { timer: setTimeout(() => { this.pending = null; this.trigger(part); }, CLICK_DELAY) };
  }

  clickLogo(pointerType) {
    if (this.animator.state === 'Sitting') {
      this.logo.activate();
      this.animator.poke(true);
      return;
    }
    // Touch has no hover: the first tap presents the logo, a second tap activates it.
    if (pointerType !== 'mouse' && this.time > this.touchHoverUntil) {
      this.touchHoverUntil = this.glowUntil = this.time + 3;
      this.presentLogo();
      return;
    }
    this.trigger('logo');
  }

  presentLogo() {
    this.logoFocusUntil = Math.max(this.logoFocusUntil, this.time + 3);
    if (this.animator.state === 'Idle' && this.time - this.lastPresent > 5) {
      this.lastPresent = this.time;
      this.animator.request('Present');
    }
  }

  /** Named behaviours shared by clicks, the toolbar and window.__fox.trigger(). */
  trigger(name) {
    const a = this.animator;
    switch (name) {
      case 'head': return a.request('Happy');
      case 'ear_L': case 'ear_R':
        a.poke();
        this.procedural.flickEar(name.slice(-1));
        return name;
      case 'body': return a.request(this.rng() < 0.5 ? 'Wave' : 'Shrug');
      case 'tail': return a.request('LookBack');
      case 'logo':
        if (!this.logo.shown) return null;
        this.logo.activate();
        this.logoFocusUntil = this.time + 4.5;
        return a.request('Reach');
      case 'Present':
        this.logoFocusUntil = this.time + 3.5;
        this.glowUntil = this.time + 1.5;
        return a.request('Present');
      case 'Reach': return this.trigger('logo');
      case 'Sit': return a.sit() ? 'SitDown' : null;
      case 'Doze': return a.sit({ doze: true }) ? 'Sit_Doze' : null;
      case 'Pet': return a.startPet() ? 'Pet' : null;
      case 'PetEnd': return a.endPet();
      case 'Wake': a.poke(false); return a.wake('Wave');
      case 'Enter': return a.enter();
      case 'Exit': return a.exit();
      case 'Presence': return a.stateName === 'Away' || a.stateName === 'Exiting' ? a.enter() : a.exit();
      case 'Type': return this.typing?.demo(3) ? 'Type' : null;
      case 'TypeDemo': return this.typing?.toggleDemo() ? 'Type' : null;
      default: return a.request(name);
    }
  }

  // ---- per frame ------------------------------------------------------------------------------

  update(dt) {
    this.time += dt;
    const p = this.pointer;

    // The logo left (or is leaving): drop its hover, re-pick what is under the pointer.
    if (this.hoverLogo && !this.logo.shown) {
      this.hoverLogo = false;
      this.hoverDirty = true;
    }

    // Hover (mouse only, not while pressing).
    if (this.hoverDirty && !this.down) {
      this.hoverDirty = false;
      const part = p && p.type === 'mouse' ? this.pick(p.x, p.y) : null;
      const onLogo = part === 'logo';
      if (onLogo && !this.hoverLogo) this.presentLogo();
      this.hoverLogo = onLogo;
      if (part === 'tail' && this.hoverPart !== 'tail' && this.time - this.lastTailFlick > TAIL_FLICK_COOLDOWN) {
        this.lastTailFlick = this.time;
        this.procedural.flickTail();
      }
      this.hoverPart = part;
      this.canvas.style.cursor = part === 'tail' ? 'grab' : part ? 'pointer' : '';
    }
    this.logo.setHover(this.hoverLogo || this.time < this.glowUntil);

    // Look-at target: the logo while it is the focus, the keyboard while typing, else the pointer.
    const kb = this.typing?.active && this.typing.keyboard.shown;
    if (this.paused) {
      this.procedural.setTarget(null);
    } else if (this.logo.shown && (this.hoverLogo || this.logo.isActive || this.time < this.logoFocusUntil || this.animator.lookAtLogo)) {
      this.procedural.setTarget(this.logo.worldPosition('Star', this.lookVec));
    } else if (kb) {
      this.procedural.setTarget(this.typing.keyboard.worldCenter(this.lookVec));
    } else if (p && this.followPointer && this.time - this.pointerAt < POINTER_IDLE) {
      this.procedural.setTarget(this.pointerTarget(p));
    } else {
      this.procedural.setTarget(null);
    }
  }

  /** Point on a camera-facing plane just in front of the fox's face, under the pointer. */
  pointerTarget(p) {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((p.x - r.left) / r.width) * 2 - 1, -((p.y - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const face = this.fox.bones.head.localToWorld(this.procedural.eyeLocal.clone());
    const toCam = this.camera.position.clone().sub(face).normalize();
    const planePoint = face.addScaledVector(toCam, 0.7);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(toCam, planePoint);
    return this.raycaster.ray.intersectPlane(plane, this.lookVec) || planePoint;
  }
}
