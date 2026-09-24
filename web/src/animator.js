// AnimationMixer state machine: Idle / OneShot / Sitting / Petting / Typing / Entering / Exiting / Away.
// Crossfades are driven here (not with mixer fades) so the weights always sum to 1 and the
// bind pose never leaks in, even when a fade is interrupted by another one.
//
// Presence (visible / popping in / popping away / hidden) is owned here too. The fox always
// arrives the same way (page load, 回来, 2D start): it pops in out of thin air and waves; it
// leaves as the mirror image: waves goodbye, then pops away. Enter / Exit clips, if a model still
// has them, are never played. main.js turns `presence` into the fox's scale and visibility and
// sends the logo along ('presence' events).
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
const FADE_IDLE = 0.35;
const FADE_PET = 0.45;
export const POP_IN = 0.8; // s, entrance: scale 0 -> 1 with a springy overshoot (easeOutBack)
export const POP_OUT = 0.6; // s, exit: a little anticipation, then scale -> 0 (easeInBack)

const audible = (a) => (a.isScheduled() ? a.getEffectiveWeight() : 0);
const smooth = (x) => x * x * (3 - 2 * x);

export class Animator {
  constructor(fox, { rng = Math.random } = {}) {
    this.fox = fox;
    this.mixer = fox.mixer;
    this.meta = fox.meta;
    this.rng = rng;
    this.listeners = new Set();

    this._state = 'Idle';
    this.phase = null; // Sitting: 'down' | 'think' | 'doze' | 'up'
    this.sitLoop = null; // loop to settle into after SitDown
    this.pendingWake = false; // woken during SitDown: stand up once seated
    this.cur = null; // { name, action, intent }
    this.queued = null; // one-shot waiting for a non-interruptible clip to end
    this.fade = null;
    this.posing = false;
    this.auto = true; // idle look-around + sitting timers
    this.sitAfter = 15;
    this.dozeAfter = 30;
    this.idleTime = 0;
    this.lookAroundIn = this.nextLookAround();
    this.layers = { lookAt: 1, blink: 1, springs: 1 };

    this.presence = { mode: 'shown', t: 0 }; // shown | popIn | popOut | hidden
    this.pendingPresence = null; // 'enter' | 'exit' requested while the other one is playing
    this.exitStep = null; // Exiting: 'wave' | 'pop'
    this.typingWanted = false; // the keyboard is out: type whenever the fox is free
    this.typeRate = 1;

    // 'finished' fires inside mixer.update(); handle it afterwards so the mixer's action list is
    // never modified mid-iteration.
    this.finished = [];
    this.mixer.addEventListener('finished', (e) => this.finished.push(e.action));
  }

  // ---- events -----------------------------------------------------------------------------

  /**
   * fn(type, detail): 'clip' {clip, intent} whenever a clip starts; 'state' {from, to};
   * 'presence' {mode} when the fox starts popping in / away, is shown or hidden.
   */
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, detail) {
    for (const fn of this.listeners) fn(type, detail);
  }

  get stateName() {
    return this._state;
  }

  set stateName(v) {
    if (v === this._state) return;
    const from = this._state;
    this._state = v;
    this.emit('state', { from, to: v });
  }

  // ---- queries --------------------------------------------------------------------------

  has(name) {
    return !!(name && this.fox.actions[name]);
  }

  /** First available of name + its fallbacks, or null. */
  resolve(name) {
    if (!name) return null;
    for (const n of [name, ...(FALLBACK[name] || [])]) if (this.has(n)) return n;
    return null;
  }

  get state() {
    return this.posing ? 'Pose' : this.stateName;
  }

  get clip() {
    return this.cur?.name ?? null;
  }

  /** What the current clip was played for (the requested name before fallback). */
  get intent() {
    return this.cur?.intent ?? null;
  }

  /** Away, leaving or arriving: no user actions, no typing. */
  get busyPresence() {
    return this.stateName === 'Away' || this.stateName === 'Exiting' || this.stateName === 'Entering';
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

  play(name, fade = FADE, intent = name) {
    const meta = this.meta[name];
    const action = this.pickAction(name);
    const from = [];
    for (const pair of Object.values(this.fox.actions)) {
      for (const a of pair) {
        if (a === action) continue;
        const w = audible(a);
        if (w > 0) from.push({ action: a, w });
        else if (a.isScheduled()) a.stop();
      }
    }
    action.reset();
    action.setLoop(meta.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = !meta.loop;
    action.setEffectiveTimeScale(1);
    const total = from.reduce((s, e) => s + e.w, 0);
    if (fade > 0 && from.length && total > 1e-6) {
      for (const e of from) e.w /= total; // keep the sum at exactly 1 during the fade
      action.setEffectiveWeight(0);
      this.fade = { t: 0, dur: fade, from, to: action };
    } else {
      for (const f of from) f.action.stop();
      action.setEffectiveWeight(1);
      this.fade = null;
    }
    action.play();
    this.cur = { name, action, intent, early: false };
    this.emit('clip', { clip: name, intent });
    return name;
  }

  stepFade(dt) {
    const f = this.fade;
    if (!f) return;
    f.t += dt;
    const lin = Math.min(1, f.t / f.dur);
    // Smoothstep weights: the blend starts and ends with zero weight velocity, so a transition
    // never adds a kink to the joint velocities.
    const s = smooth(lin);
    for (const e of f.from) e.action.setEffectiveWeight(e.w * (1 - s));
    f.to.setEffectiveWeight(s);
    if (lin >= 1) {
      for (const e of f.from) e.action.stop();
      this.fade = null;
    }
  }

  // ---- state transitions ------------------------------------------------------------------

  idleClip() {
    return this.has('Idle') ? 'Idle' : Object.keys(this.fox.actions).find((n) => this.meta[n].loop);
  }

  toIdle(fade = FADE_IDLE) {
    this.stateName = 'Idle';
    this.phase = null;
    this.lookAroundIn = this.nextLookAround();
    const idle = this.idleClip();
    if (idle) this.play(idle, fade);
  }

  /** Where a finished one-shot goes: back to typing if the keyboard is out, else Idle. */
  settle(fade = FADE_IDLE) {
    if (this.typingWanted) this.enterTyping(fade);
    else this.toIdle(fade);
  }

  /** Can `name` start now, or must it wait for the current clip? */
  canInterrupt(name) {
    if (!this.cur || !this.cur.action.isRunning()) return true; // finished (clamped) clips yield
    if (this.cur.early) return true; // already fading out at its end
    const cm = this.meta[this.cur.name];
    if (cm.loop || cm.interruptible) return true;
    return (this.meta[name]?.priority ?? 0) > cm.priority;
  }

  /**
   * Play a one-shot clip (Wave, Happy, ...). While sitting the fox first stands up and then
   * plays `name`. Returns the clip actually used (after fallback) or null.
   */
  request(name, fade = FADE) {
    if (this.posing) return null;
    switch (name) {
      case 'Enter': return this.enter();
      case 'Exit': return this.exit();
      case 'Type': return null; // typing is driven by the keyboard controller (keyboard.js)
    }
    if (this.stateName === 'Away' || this.stateName === 'Exiting') return null;
    this.poke(false);
    const clip = this.resolve(name);
    if (!clip) return null;
    // Clips owned by a state go through that state's transition (loops never "finish").
    switch (clip) {
      case 'Idle': if (this.stateName !== 'Sitting' && this.stateName !== 'Entering') this.toIdle(); return clip;
      case 'SitDown': case 'Sit_Think': return this.sit() ? clip : null;
      case 'Sit_Doze': return this.sit({ doze: true }) ? clip : null;
      case 'StandUp': return this.wake('Wave') && clip;
      case 'Pet': return this.startPet() ? clip : null;
    }
    if (this.stateName === 'Sitting') return this.wake(clip, name);
    if (this.stateName === 'Petting') return null;
    if (this.stateName === 'Entering' || !this.canInterrupt(clip)) {
      if (!this.queued || this.meta[clip].priority >= this.meta[this.queued.clip].priority) this.queued = { clip, intent: name };
      return clip;
    }
    this.queued = null;
    this.stateName = 'OneShot';
    this.play(clip, fade, name);
    return clip;
  }

  /** Sit down (then think, or doze straight away). */
  sit({ doze = false } = {}) {
    this.poke(false);
    if (!this.canSit || this.posing || this.busyPresence) return false;
    const loop = doze && this.has('Sit_Doze') ? 'Sit_Doze' : this.has('Sit_Think') ? 'Sit_Think' : 'Sit_Doze';
    if (this.stateName === 'Sitting') {
      if (this.phase === 'think' || this.phase === 'doze') {
        this.phase = loop === 'Sit_Doze' ? 'doze' : 'think';
        if (this.clip !== loop) this.play(loop, 0.6);
      } else if (this.phase === 'down') {
        this.sitLoop = loop;
      } else {
        return false; // standing up: let it finish, the idle timer will sit again
      }
      return true;
    }
    if (this.stateName === 'Petting' || !this.canInterrupt('SitDown')) return false;
    this.typingWanted = false;
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

  /** Stand up from sitting, then play `next` (default Wave; null = nothing / typing). */
  wake(next = 'Wave', intent = next) {
    if (this.stateName !== 'Sitting') return null;
    const clip = this.resolve(next);
    this.queued = clip ? { clip, intent } : null;
    if (this.phase === 'up') return clip || 'StandUp';
    if (this.phase === 'down') {
      this.pendingWake = true; // let SitDown finish first
      return clip || 'StandUp';
    }
    this.phase = 'up';
    if (this.has('StandUp')) this.play('StandUp', FADE);
    else this.afterStandUp(0.6);
    return clip || 'StandUp';
  }

  afterStandUp(fade) {
    const next = this.queued;
    this.queued = null;
    this.idleTime = 0;
    this.phase = null;
    if (this.pendingPresence === 'exit') {
      this.stateName = 'Idle';
      this.exit();
    } else if (next) {
      this.stateName = 'OneShot';
      this.play(next.clip, fade, next.intent);
    } else this.settle(fade);
  }

  startPet() {
    this.poke(false);
    if (this.posing || this.busyPresence) return false;
    if (this.stateName === 'Sitting') { this.wake('Wave'); return false; }
    if ((this.stateName === 'OneShot' || this.stateName === 'Typing') && !this.canInterrupt('Pet')) return false; // e.g. mid-Jump
    if (this.stateName === 'Petting') return true;
    this.stateName = 'Petting';
    this.queued = null;
    if (this.has('Pet')) this.play('Pet', FADE_PET); // the Pet wag is fast: blend in and out slowly
    return true;
  }

  endPet() {
    if (this.stateName !== 'Petting') return null;
    this.stateName = 'Idle';
    const clip = this.request('Heart', FADE_PET);
    if (!clip) this.settle(FADE_PET);
    return clip;
  }

  // ---- typing -----------------------------------------------------------------------------

  /**
   * The user typed a key. Returns 'typing' (in the Typing state), 'pending' (typing once the
   * current non-interruptible clip / StandUp is over) or null (away, arriving, leaving, petted).
   */
  startTyping() {
    if (this.posing || this.busyPresence || this.stateName === 'Petting') return null;
    this.typingWanted = true;
    this.idleTime = 0;
    switch (this.stateName) {
      case 'Typing': return 'typing';
      case 'Sitting':
        this.wake(null); // StandUp, then afterStandUp() settles into typing
        return 'pending';
      default:
        if (!this.canInterrupt('Type')) return 'pending'; // e.g. mid-Jump: type when it lands
        this.enterTyping(FADE);
        return 'typing';
    }
  }

  enterTyping(fade = FADE) {
    this.stateName = 'Typing';
    this.phase = null;
    this.queued = null;
    this.idleTime = 0;
    if (this.has('Type')) {
      if (this.clip !== 'Type') this.play('Type', fade);
      this.applyTypeRate();
    } else if (!this.cur || this.meta[this.cur.name].loop === false && !this.cur.action.isRunning()) {
      // Fallback (no Type clip): keep whatever is playing; the procedural layer bobs the paws.
      const idle = this.idleClip();
      if (idle) this.play(idle, fade, 'Type');
    } else {
      this.emit('clip', { clip: this.clip, intent: 'Type' });
    }
  }

  /** Keys stopped: back to Idle (the keyboard controller hides the keyboard). */
  stopTyping() {
    this.typingWanted = false;
    if (this.stateName !== 'Typing') return;
    if (!this.has('Type') && this.clip === this.idleClip()) {
      this.stateName = 'Idle'; // fallback was already on the idle loop: nothing to blend
      this.lookAroundIn = this.nextLookAround();
    } else this.toIdle(0.45);
  }

  /** Typing speed factor (keys per second / nominal): the Type loop plays faster or slower. */
  setTypeRate(r) {
    this.typeRate = THREE.MathUtils.clamp(r, 0.6, 1.6);
    this.applyTypeRate();
  }

  applyTypeRate() {
    if (this.cur?.name === 'Type') this.cur.action.setEffectiveTimeScale(this.typeRate);
  }

  // ---- entrance / exit --------------------------------------------------------------------

  setPresence(mode) {
    this.presence = { mode, t: 0 };
    this.emit('presence', { mode });
  }

  /** Pop in out of thin air, then Wave. `intro` = first appearance (page load). */
  enter({ intro = false } = {}) {
    if (this.posing) return null;
    if (this.stateName === 'Exiting') { this.pendingPresence = 'enter'; return 'Enter'; }
    if (this.stateName === 'Entering') { this.pendingPresence = null; return 'Enter'; }
    if (this.stateName !== 'Away' && !intro) return null;
    const intent = intro ? 'Intro' : 'Enter';
    this.pendingPresence = null;
    this.typingWanted = false;
    this.queued = null;
    this.phase = null;
    this.idleTime = 0;
    this.stateName = 'Entering';
    this.setPresence('popIn');
    const idle = this.idleClip();
    const wave = this.has('Wave');
    if (idle) this.play(idle, 0, wave ? idle : intent); // hidden before: nothing to blend from
    if (wave) {
      this.play('Wave', FADE, intent);
      this.enterWaits = 'clip';
    } else this.enterWaits = 'pop';
    return 'Enter';
  }

  /** Wave goodbye, then pop away (the mirror of enter()), then Away. */
  exit() {
    if (this.posing || this.stateName === 'Away') return null;
    if (this.stateName === 'Exiting') { this.pendingPresence = null; return 'Exit'; }
    this.typingWanted = false;
    if (this.stateName === 'Sitting') {
      this.pendingPresence = 'exit';
      this.wake(null);
      return 'Exit';
    }
    if (this.stateName === 'Entering' || !this.canInterrupt('Wave')) {
      this.pendingPresence = 'exit'; // e.g. mid-Jump: leave when it lands
      return 'Exit';
    }
    this.pendingPresence = null;
    this.queued = null;
    this.phase = null;
    this.stateName = 'Exiting';
    if (this.has('Wave')) {
      this.exitStep = 'wave';
      this.play('Wave', FADE, 'Exit');
    } else this.startPopOut();
    return 'Exit';
  }

  startPopOut() {
    this.exitStep = 'pop';
    this.setPresence('popOut');
    const idle = this.idleClip();
    if (idle && this.clip !== idle) this.play(idle, FADE_IDLE); // keep breathing while shrinking
  }

  goAway() {
    this.stateName = 'Away';
    this.exitStep = null;
    this.setPresence('hidden');
    this.queued = null;
    const idle = this.idleClip();
    if (idle) this.play(idle, 0, 'Away'); // hidden: park on the idle loop, no blend needed
    if (this.pendingPresence === 'enter') this.enter();
    this.pendingPresence = null;
  }

  stepPresence(dt) {
    const p = this.presence;
    p.t += dt;
    if (p.mode === 'popIn' && p.t >= POP_IN) {
      this.setPresence('shown');
      if (this.stateName === 'Entering' && this.enterWaits === 'pop') this.finishEnter();
    } else if (p.mode === 'popOut' && p.t >= POP_OUT) {
      this.goAway();
    }
  }

  finishEnter() {
    this.enterWaits = null;
    if (this.pendingPresence === 'exit') {
      this.stateName = 'Idle';
      this.exit();
      return;
    }
    if (this.queued) this.playQueued();
    else this.toIdle();
  }

  playQueued() {
    const q = this.queued;
    this.queued = null;
    this.stateName = 'OneShot';
    this.play(q.clip, FADE, q.intent);
  }

  // ---- misc ---------------------------------------------------------------------------------

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
    switch (this.stateName) {
      case 'Sitting':
        if (name === 'SitDown') {
          this.phase = this.sitLoop === 'Sit_Doze' ? 'doze' : 'think';
          this.play(this.sitLoop, FADE);
          if (this.pendingWake) { this.pendingWake = false; this.wake(this.queued?.clip ?? null, this.queued?.intent); }
        } else if (name === 'StandUp') {
          this.afterStandUp(FADE);
        }
        return;
      case 'Entering':
        if (this.presence.mode === 'popIn') this.enterWaits = 'pop'; // Wave done before the pop
        else this.finishEnter();
        return;
      case 'Exiting':
        if (this.exitStep === 'wave') this.startPopOut();
        return;
      case 'Away':
        return;
      case 'Typing': {
        // Fallback typing keeps the current clip: once a one-shot ends, idle along.
        const idle = this.idleClip();
        if (idle && name !== idle) this.play(idle, FADE_IDLE, 'Type');
        return;
      }
    }
    if (this.pendingPresence === 'exit') {
      this.stateName = 'Idle';
      this.exit();
      return;
    }
    if (this.queued) {
      this.playQueued();
      return;
    }
    if (this.stateName === 'OneShot' || this.stateName === 'Idle') this.settle();
  }

  /**
   * Start the next transition a fade-length before a one-shot ends, so the outgoing clip is
   * still moving while it blends out (no freeze on the clamped last frame, then a blend).
   */
  checkEarlyFinish() {
    const c = this.cur;
    if (!c || c.early || this.fade) return;
    const m = this.meta[c.name];
    if (m.loop || !c.action.isRunning()) return;
    const lead = Math.min(FADE_IDLE, m.duration * 0.2);
    if (c.action.time >= m.duration - lead) {
      c.early = true;
      this.onFinished(c.action);
    }
  }

  // ---- per frame --------------------------------------------------------------------------

  update(dt) {
    if (this.posing) return;
    this.stepPresence(dt);
    this.stepFade(dt);
    this.mixer.update(dt);
    while (this.finished.length) this.onFinished(this.finished.shift());
    this.checkEarlyFinish();
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
    this.setPresence('shown');
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
    this.cur = { name: clip, action, intent: clip, early: false };
    this.layers = { lookAt: 0, blink: 0, springs: 0 };
    return clip;
  }

  resume() {
    this.posing = false;
    this.mixer.stopAllAction();
    this.cur = null;
    this.queued = null;
    this.idleTime = 0;
    this.typingWanted = false;
    this.pendingPresence = null;
    this.exitStep = null;
    this.setPresence('shown');
    this.toIdle(0);
  }
}
