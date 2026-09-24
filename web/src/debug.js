// window.__fox: deterministic posing for screenshots (scripts/snap.mjs) and hooks for the
// Playwright interaction test (scripts/interact.mjs).
import * as THREE from 'three';

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
  const { stage, fox, logo, animator, procedural, interaction, rng } = app;
  const v = new THREE.Vector3();

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
    get clips() { return fox.clips; },
    clipInfo: () => fox.clips.map((name) => ({ name, ...fox.meta[name] })),
    get state() { return animator.state; },
    get clip() { return animator.clip; },
    info: () => ({
      state: animator.state,
      clip: animator.clip,
      phase: animator.phase,
      logo: logo.state,
      logoSource: logo.source,
      earEnergy: procedural.earEnergy,
      lookWeight: procedural.look.w.x,
      layers: { ...animator.layers },
    }),
    resolve: (name) => animator.resolve(name),

    /** Freeze on {clip, t} with camera preset `cam`; resolves after one rendered frame. */
    async pose({ clip = 'Idle', t = 0, cam = 'ref34', seed = 1, logo: logoState = 'idle' } = {}) {
      app.stopLoop();
      rng.seed(seed);
      interaction.cancelPending();
      app.finishIntro();
      animator.pose(clip, t);
      procedural.reset();
      procedural.enabled = false;
      logo.pose(logoState);
      app.dozeFx.clear();
      stage.setView(cam);
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
      const p = worldOf(part);
      if (!p) return null;
      p.project(stage.camera);
      const r = stage.renderer.domElement.getBoundingClientRect();
      return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
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

    /** Internals (scene, materials, ...) for interactive calibration from the console. */
    _app: app,
  };
}
