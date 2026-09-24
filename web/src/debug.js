// window.__fox: deterministic posing for screenshots (scripts/snap.mjs) and hooks for the
// Playwright interaction test (scripts/interact.mjs).
import * as THREE from 'three';

const _s = new THREE.Vector3();

/** Small deterministic PRNG (mulberry32). */
export function makeRng(seed = 1) {
  let s = seed >>> 0;
  const rng = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.seed = (v) => { s = v >>> 0; };
  return rng;
}

export function installDebug(app) {
  const { stage, fox, logo, animator, procedural, interaction, rng, bubble, keyboard, typing, heartFx } = app;
  const v = new THREE.Vector3();
  const boneNames = Object.keys(fox.bones);
  const boneList = boneNames.map((n) => fox.bones[n]);
  const parentIndex = boneList.map((b) => boneList.indexOf(b.parent));
  const _q = new THREE.Quaternion();

  function worldOf(part) {
    const c = interaction.colliders[part];
    if (c) return c.getWorldPosition(v);
    if (part === 'logo') return logo.worldPosition(null, v);
    if (logo.pieces[part]) return logo.worldPosition(part, v);
    const bone = fox.bones[part];
    if (bone) return bone.getWorldPosition(v);
    return null;
  }

  window.__fox = {
    /** 3D / 2D switch (resolves with the mode shown); live2d: the 2D app once created. */
    setMode: (m) => app.setMode(m),
    get mode() { return app.mode; },
    get live2d() { return app.live2d; },
    get clips() { return fox.clips; },
    clipInfo: () => fox.clips.map((name) => ({ name, ...fox.meta[name] })),
    get state() { return animator.state; },
    get clip() { return animator.clip; },
    info: () => ({
      state: animator.state,
      clip: animator.clip,
      intent: animator.intent,
      phase: animator.phase,
      fading: !!animator.fade,
      presence: animator.presence.mode,
      foxVisible: fox.root.visible && fox.root.scale.x > 0.01,
      foxScale: fox.root.scale.x,
      shadowVisible: !!app.foxShadow?.visible,
      logo: logo.state,
      logoSource: logo.source,
      earFlicks: procedural.flicks,
      tailFlicks: procedural.tailFlicks,
      tailDragging: procedural.tailDragging,
      tailBend: procedural.tailBend,
      tailTipOffset: procedural.tailTipOffset,
      lookWeight: procedural.look.w.x,
      talking: procedural.talkEnv.x > 0.5,
      talkOpen: procedural.talkOpen,
      bubble: bubble?.text ?? null,
      bubblesShown: bubble?.shown ?? 0,
      typing: !!typing?.active,
      typingDemo: !!typing?.demoActive,
      keystrokes: typing?.keystrokes ?? 0,
      keyboard: keyboard ? keyboard.mode : null,
      keyboardScale: keyboard?.scale ?? 0,
      keysDown: keyboard?.pressedCount ?? 0,
      keyPresses: keyboard?.presses ?? 0,
      heart: !!heartFx?.visible,
      heartsShown: heartFx?.shown ?? 0,
      nods: procedural.nods,
      layers: { ...animator.layers },
    }),
    resolve: (name) => animator.resolve(name),

    /** Freeze on {clip, t} with camera preset `cam`; resolves after one rendered frame. */
    async pose({ clip = 'Idle', t = 0, cam = 'ref34', seed = 1, logo: logoState = 'idle' } = {}) {
      app.stopLoop();
      rng.seed(seed);
      interaction.cancelPending();
      app.finishIntro();
      procedural.reset(); // back to the clip pose before switching clips
      procedural.enabled = false;
      animator.pose(clip, t);
      logo.pose(logoState);
      app.dozeFx.clear();
      stage.setView(cam, { fit: false }); // exact spec camera for reference comparisons
      fox.root.updateMatrixWorld(true);
      app.updateShadows();
      stage.render();
      await new Promise((r) => requestAnimationFrame(r));
      return true;
    },

    resume() {
      procedural.reset();
      procedural.enabled = true;
      animator.resume();
      logo.pose('idle');
      app.startLoop();
    },

    /** CSS-pixel position of a collider, bone or logo piece (for Playwright clicks). */
    screenPos(part) {
      fox.root.updateMatrixWorld(true);
      const r = stage.renderer.domElement.getBoundingClientRect();
      const toScreen = (p) => {
        p.project(stage.camera);
        return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
      };
      if (part === 'tail') {
        // the tail proxy that is actually visible (not behind the body) from this camera
        for (const c of interaction.tailColliders) {
          const s = toScreen(c.getWorldPosition(v));
          if (interaction.pick(s.x, s.y) === 'tail') return s;
        }
      }
      const p = worldOf(part);
      return p ? toScreen(p) : null;
    },

    /** Allow bigger per-frame steps so slow software rendering still runs at wall-clock speed. */
    setMaxDelta: (sec) => app.setMaxDelta(sec),

    /** Which pickable part is under client point (x, y), or null. */
    pickAt: (x, y) => interaction.pick(x, y),

    setIdleTimeouts(sitMs, dozeMs) {
      animator.auto = true;
      animator.setIdleTimeouts(sitMs / 1000, dozeMs / 1000);
    },

    trigger: (name) => interaction.trigger(name),

    /** Simulate one keystroke (KeyboardEvent.code) on the typing controller. */
    typeKey: (code = 'KeyA') => typing.tap(code),

    /** Unit direction (world) of a bone's +Y axis, e.g. boneDir('tail_6'). */
    boneDir(name) {
      const b = fox.bones[name];
      if (!b) return null;
      fox.root.updateMatrixWorld(true);
      return new THREE.Vector3(0, 1, 0).applyQuaternion(b.getWorldQuaternion(_q)).toArray();
    },

    /** Bone names, parent indices and kinds, in the order boneQuats() writes them. */
    boneInfo: () => ({ names: boneNames, parents: parentIndex }),

    /**
     * World quaternions (x, y, z, w per bone, boneInfo() order) of every bone, written into
     * `out` (Float32Array, optional). Call from a step hook for per-frame sampling.
     */
    boneQuats(out = new Float32Array(boneList.length * 4)) {
      for (let i = 0; i < boneList.length; i++) {
        boneList[i].matrixWorld.decompose(v, _q, _s);
        out[i * 4] = _q.x; out[i * 4 + 1] = _q.y; out[i * 4 + 2] = _q.z; out[i * 4 + 3] = _q.w;
      }
      return out;
    },

    /** World position of a bone (root motion checks). */
    bonePos(name) {
      const b = fox.bones[name];
      return b ? b.getWorldPosition(new THREE.Vector3()).toArray() : null;
    },

    /**
     * Per-step hooks for motion analysis: fn(phase, dt) with phase 'mixer' (clip pose, after the
     * mixer) or 'final' (after procedural layers). Pass null to remove.
     */
    onStep(fn) {
      app.hooks.afterMixer = fn ? (dt) => fn('mixer', dt) : null;
      app.hooks.afterStep = fn ? (dt) => fn('final', dt) : null;
    },

    /** Advance in fixed steps (e.g. 1/60) regardless of the real frame rate; 0 = real time. */
    setFixedStep: (sec) => app.setFixedStep(sec),

    /** Internals (scene, materials, ...) for interactive calibration from the console. */
    _app: app,
  };
}
