// AnimationMixer state machine: Idle / OneShot / Sitting / Petting.
// Crossfades are driven here (not with mixer fades) so the weights always sum to 1 and the
// bind pose never leaks in, even when a fade is interrupted by another one.
import * as THREE from 'three';

// Graceful substitutes when the model lacks a clip.
const FALLBACK = {
  Happy: ['Wave'],
  Heart: ['Happy', 'Wave'],
  Present: ['Wave'],
  Reach: ['Present', 'Wave'],
  Shrug: ['Wave'],
  Jump: ['Happy', 'Wave'],
  LookBack: ['Wave'],
};

const FADE = 0.3;

const audible = (a) => (a.isScheduled() ? a.getEffectiveWeight() : 0);

export class Animator {
  constructor(fox, { rng = Math.random } = {}) {
    this.fox = fox;
    this.mixer = fox.mixer;
    this.meta = fox.meta;
    this.rng = rng;

    this.stateName = 'Idle';
    this.phase = null; // Sitting: 'down' | 'think' | 'doze' | 'up'
    this.sitLoop = null; // loop to settle into after SitDown
    this.pendingWake = false; // woken during SitDown: stand up once seated
    this.cur = null; // { name, action }
    this.queued = null; // one-shot waiting for a non-interruptible clip to end
    this.fade = null;
    this.posing = false;
    this.auto = true; // idle look-around + sitting timers
    this.sitAfter = 15;
    this.dozeAfter = 30;
    this.idleTime = 0;
    this.lookAroundIn = this.nextLookAround();
    this.layers = { lookAt: 1, blink: 1, springs: 1 };

    // 'finished' fires inside mixer.update(); handle it afterwards so the mixer's action list is
    // never modified mid-iteration.
    this.finished = [];
    this.mixer.addEventListener('finished', (e) => this.finished.push(e.action));
  }

  // ---- queries --------------------------------------------------------------------------

  has(name) {
    return !!this.fox.actions[name];
  }

  /** First available of name + its fallbacks, or null. */
  resolve(name) {
    for (const n of [name, ...(FALLBACK[name] || [])]) if (this.has(n)) return n;
    return null;
  }

  get state() {
    return this.posing ? 'Pose' : this.stateName;
  }

  get clip() {
    return this.cur?.name ?? null;
  }

  /** Does the current clip want the head turned towards the logo? */
  get lookAtLogo() {
    return !!(this.cur && this.meta[this.cur.name].lookAtLogo);
  }

  get canSit() {
    return this.has('Sit_Think') || this.has('Sit_Doze');
  }

  nextLookAround() {
    return 6 + this.rng() * 6;
  }

  // ---- low level playback -----------------------------------------------------------------

  pickAction(name) {
    // Use whichever of the pair is quieter, so restarting a clip crossfades into its twin.
    const [a, b] = this.fox.actions[name];
    return audible(a) <= audible(b) ? a : b;
  }

  play(name, fade = FADE) {
    const meta = this.meta[name];
    const action = this.pickAction(name);
    action.reset();
    action.setLoop(meta.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = !meta.loop;
    action.setEffectiveTimeScale(1);

    const from = [];
    for (const pair of Object.values(this.fox.actions)) {
      for (const a of pair) {
        if (a === action) continue;
        const w = audible(a);
        if (w > 0) from.push({ action: a, w });
        else if (a.isScheduled()) a.stop();
      }
    }
    const total = from.reduce((s, e) => s + e.w, 0);
    for (const e of from) e.w /= total; // keep the sum at exactly 1 during the fade
    if (fade > 0 && from.length) {
      action.setEffectiveWeight(0);
      this.fade = { t: 0, dur: fade, from, to: action };
    } else {
      for (const f of from) f.action.stop();
      action.setEffectiveWeight(1);
      this.fade = null;
    }
    action.play();
    this.cur = { name, action };
    return name;
  }

  stepFade(dt) {
    const f = this.fade;
    if (!f) return;
    f.t += dt;
    const s = Math.min(1, f.t / f.dur);
    for (const e of f.from) e.action.setEffectiveWeight(e.w * (1 - s));
    f.to.setEffectiveWeight(s);
    if (s >= 1) {
      for (const e of f.from) e.action.stop();
      this.fade = null;
    }
  }

  // ---- state transitions ------------------------------------------------------------------

  toIdle(fade = 0.35) {
    this.stateName = 'Idle';
    this.phase = null;
    this.lookAroundIn = this.nextLookAround();
    const idle = this.has('Idle') ? 'Idle' : Object.keys(this.fox.actions).find((n) => this.meta[n].loop);
    if (idle) this.play(idle, fade);
  }

  /** Can `name` start now, or must it wait for the current clip? */
  canInterrupt(name) {
    if (!this.cur || !this.cur.action.isRunning()) return true; // finished (clamped) clips yield
    const cm = this.meta[this.cur.name];
    if (cm.loop || cm.interruptible) return true;
    return (this.meta[name]?.priority ?? 0) > cm.priority;
  }

  /**
   * Play a one-shot clip (Wave, Happy, ...). While sitting the fox first stands up and then
   * plays `name`. Returns the clip actually used (after fallback) or null.
   */
  request(name) {
    this.poke(false);
    const clip = this.resolve(name);
    if (!clip || this.posing) return null;
    // Clips owned by a state go through that state's transition (loops never "finish").
    switch (clip) {
      case 'Idle': if (this.stateName !== 'Sitting') this.toIdle(); return clip;
      case 'SitDown': case 'Sit_Think': return this.sit() ? clip : null;
      case 'Sit_Doze': return this.sit({ doze: true }) ? clip : null;
      case 'StandUp': return this.wake('Wave') && clip;
      case 'Pet': return this.startPet() ? clip : null;
    }
    if (this.stateName === 'Sitting') return this.wake(clip);
    if (this.stateName === 'Petting') return null;
    if (!this.canInterrupt(clip)) {
      if (!this.queued || this.meta[clip].priority >= this.meta[this.queued].priority) this.queued = clip;
      return clip;
    }
    this.queued = null;
    this.stateName = 'OneShot';
    this.play(clip, FADE);
    return clip;
  }

  /** Sit down (then think, or doze straight away). */
  sit({ doze = false } = {}) {
    this.poke(false);
    if (!this.canSit || this.posing) return false;
    const loop = doze && this.has('Sit_Doze') ? 'Sit_Doze' : this.has('Sit_Think') ? 'Sit_Think' : 'Sit_Doze';
    if (this.stateName === 'Sitting') {
      if (this.phase === 'think' || this.phase === 'doze') {
        this.phase = loop === 'Sit_Doze' ? 'doze' : 'think';
        if (this.clip !== loop) this.play(loop, 0.6);
      } else {
        this.sitLoop = loop;
      }
      return true;
    }
    if (this.stateName === 'Petting' || !this.canInterrupt('SitDown')) return false;
    this.stateName = 'Sitting';
    this.sitLoop = loop;
    this.queued = null;
    if (this.has('SitDown')) {
      this.phase = 'down';
      this.play('SitDown', FADE);
    } else {
      this.phase = loop === 'Sit_Doze' ? 'doze' : 'think';
      this.play(loop, 0.6);
    }
    return true;
  }

  /** Stand up from sitting, then play `next` (default Wave). */
  wake(next = 'Wave') {
    if (this.stateName !== 'Sitting') return null;
    this.queued = this.resolve(next);
    if (this.phase === 'up') return this.queued;
    if (this.phase === 'down') {
      this.pendingWake = true; // let SitDown finish first
      return this.queued;
    }
    this.phase = 'up';
    if (this.has('StandUp')) this.play('StandUp', FADE);
    else this.afterStandUp(0.6);
    return this.queued;
  }

  afterStandUp(fade) {
    const next = this.queued;
    this.queued = null;
    this.idleTime = 0;
    if (next) {
      this.stateName = 'OneShot';
      this.phase = null;
      this.play(next, fade);
    } else this.toIdle(fade);
  }

  startPet() {
    this.poke(false);
    if (this.posing) return false;
    if (this.stateName === 'Sitting') { this.wake('Wave'); return false; }
    if (this.stateName === 'Petting') return true;
    this.stateName = 'Petting';
    this.queued = null;
    if (this.has('Pet')) this.play('Pet', 0.25);
    return true;
  }

  endPet() {
    if (this.stateName !== 'Petting') return null;
    this.stateName = 'Idle';
    const clip = this.request('Heart');
    if (!clip) this.toIdle();
    return clip;
  }

  /** Note user activity. `wake` = also stand up if sitting. */
  poke(wake = true) {
    this.idleTime = 0;
    if (wake && this.stateName === 'Sitting') this.wake('Wave');
  }

  setIdleTimeouts(sitSec, dozeSec) {
    this.sitAfter = sitSec;
    this.dozeAfter = Math.max(dozeSec, sitSec + 0.1);
    this.idleTime = 0;
  }

  onFinished(action) {
    if (this.posing || !this.cur || action !== this.cur.action) return;
    const name = this.cur.name;
    if (this.stateName === 'Sitting') {
      if (name === 'SitDown') {
        this.phase = this.sitLoop === 'Sit_Doze' ? 'doze' : 'think';
        this.play(this.sitLoop, FADE);
        if (this.pendingWake) { this.pendingWake = false; this.wake(this.queued || 'Wave'); }
      } else if (name === 'StandUp') {
        this.afterStandUp(FADE);
      }
      return;
    }
    if (this.queued) {
      const q = this.queued;
      this.queued = null;
      this.stateName = 'OneShot';
      this.play(q, FADE);
      return;
    }
    if (this.stateName === 'OneShot' || this.stateName === 'Idle') this.toIdle();
  }

  // ---- per frame --------------------------------------------------------------------------

  update(dt) {
    if (this.posing) return;
    this.stepFade(dt);
    this.mixer.update(dt);
    while (this.finished.length) this.onFinished(this.finished.shift());
    this.idleTime += dt;
    if (this.auto) this.autoBehaviour(dt);
    this.updateLayers();
  }

  autoBehaviour(dt) {
    if (this.stateName === 'Idle') {
      if (this.idleTime >= this.sitAfter && this.canSit) {
        this.sit();
        this.idleTime = this.sitAfter; // sit() pokes; keep counting towards doze
        return;
      }
      if (this.clip === 'Idle' && this.has('Idle_LookAround')) {
        this.lookAroundIn -= dt;
        if (this.lookAroundIn <= 0) {
          this.lookAroundIn = this.nextLookAround();
          this.play('Idle_LookAround', 0.4); // stays in the Idle state, finishes back to Idle
        }
      }
    } else if (this.stateName === 'Sitting' && this.phase === 'think' && this.idleTime >= this.dozeAfter && this.has('Sit_Doze')) {
      this.phase = 'doze';
      this.play('Sit_Doze', 0.8);
    }
  }

  /** Procedural layer weights, blended across the audible actions. */
  updateLayers() {
    let sw = 0;
    const acc = { lookAt: 0, blink: 0, springs: 0 };
    for (const [name, pair] of Object.entries(this.fox.actions)) {
      for (const a of pair) {
        const w = audible(a);
        if (w <= 0) continue;
        const m = this.meta[name];
        sw += w;
        acc.lookAt += w * m.lookAt;
        acc.blink += w * m.blink;
        acc.springs += w * m.springs;
      }
    }
    if (sw > 0) for (const k in acc) this.layers[k] = acc[k] / sw;
  }

  // ---- debug ------------------------------------------------------------------------------

  /** Freeze on clip `name` at time t (seconds). */
  pose(name, t) {
    this.posing = true;
    this.fade = null;
    this.finished.length = 0;
    this.mixer.stopAllAction();
    const clip = this.has(name) ? name : 'Idle';
    if (!this.has(clip)) return null;
    const meta = this.meta[clip];
    const action = this.fox.actions[clip][0];
    action.reset();
    action.setLoop(meta.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = true;
    action.setEffectiveWeight(1);
    action.play();
    this.mixer.setTime(Math.min(t, Math.max(0, meta.duration - 1e-4)));
    this.cur = { name: clip, action };
    this.layers = { lookAt: 0, blink: 0, springs: 0 };
    return clip;
  }

  resume() {
    this.posing = false;
    this.mixer.stopAllAction();
    this.cur = null;
    this.queued = null;
    this.idleTime = 0;
    this.toIdle(0);
  }
}
