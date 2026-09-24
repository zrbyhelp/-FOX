// Behaviour state machine for the 2D puppet, mirroring the 3D Animator (animator.js) so the
// shared UI can drive either mode with the same names:
//   Idle / OneShot / Sitting (phase down -> think -> doze, up) / Petting / Typing /
//   Entering / Exiting / Away
// Motions come from motions.js and are blended by the MotionPlayer; "Idle" means no one-shot
// track is playing (only the idle base, plus the occasional Idle_LookAround).
// Presence is the 3D fox's: pop in out of thin air + Wave (start, 回来), Wave goodbye + pop away
// (离场); `presence` {mode, t} drives the puppet's ParamScale and the logo (app.js).
import { MOTIONS } from './motions.js';

const FADE = 0.3;
const FADE_IDLE = 0.4;
export const POP_IN = 0.8; // s, scale 0 -> 1 with a springy overshoot (easeOutBack)
export const POP_OUT = 0.6; // s, a little anticipation, then scale -> 0 (easeInBack)

// Graceful substitutes (same table as the 3D animator; every motion exists here, but keeping it
// makes has()/resolve() behave identically).
const FALLBACK = {
  Happy: ['Wave'],
  Heart: ['Happy', 'Wave'],
  Present: ['Wave'],
  Reach: ['Present', 'Wave'],
  Shrug: ['Wave'],
  Jump: ['Happy', 'Wave'],
  LookBack: ['Wave'],
};

export class Controller {
  constructor({ player, rng = Math.random }) {
    this.player = player;
    this.rng = rng;
    this.listeners = new Set();
    this._state = 'Idle';
    this.phase = null; // Sitting: 'down' | 'think' | 'doze' | 'up'
    this.sitLoop = null;
    this.pendingWake = false;
    this.cur = { name: 'Idle', intent: 'Idle', track: null };
    this.queued = null;
    this.pendingPresence = null; // 'enter' | 'exit'
    this.typingWanted = false;
    this.typeRate = 1;
    this.auto = true;
    this.sitAfter = 15;
    this.dozeAfter = 30;
    this.idleTime = 0;
    this.lookAroundIn = this.nextLookAround();
    this.hidden = false; // Away: fox not drawn
    this.presence = { mode: 'shown', t: 0 }; // shown | popIn | popOut | hidden
    this.enterWaits = null; // Entering: 'clip' (the Wave) | 'pop' (the scale pop)
    this.exitStep = null; // Exiting: 'wave' | 'pop'
    player.on((type, tr, data) => {
      if (type === 'end' && tr === this.cur.track) this.onFinished();
      if (type === 'event') this.emit('motionEvent', { name: data.name, clip: tr.name });
    });
  }

  // ---- events -----------------------------------------------------------------------------

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, detail) {
    for (const fn of this.listeners) fn(type, detail);
  }

  get stateName() { return this._state; }

  set stateName(v) {
    if (v === this._state) return;
    const from = this._state;
    this._state = v;
    this.emit('state', { from, to: v });
  }

  get state() { return this._state; }
  get clip() { return this.cur.name; }
  get intent() { return this.cur.intent; }

  get busyPresence() {
    return this._state === 'Away' || this._state === 'Exiting' || this._state === 'Entering';
  }

  get lookAtLogo() {
    return !!MOTIONS[this.cur.name]?.lookAtLogo;
  }

  has(name) {
    return !!(name && MOTIONS[name]);
  }

  resolve(name) {
    if (!name) return null;
    for (const n of [name, ...(FALLBACK[name] || [])]) if (this.has(n)) return n;
    return null;
  }

  nextLookAround() {
    return 6 + this.rng() * 6;
  }

  // ---- playback -----------------------------------------------------------------------------

  play(name, fade = FADE, intent = name) {
    const m = MOTIONS[name];
    const speed = name === 'Type' ? this.typeRate : 1;
    const track = this.player.play(m, { fade, intent, speed });
    this.cur = { name, intent, track };
    this.emit('clip', { clip: name, intent });
    return name;
  }

  toIdle(fade = FADE_IDLE) {
    this.stateName = 'Idle';
    this.phase = null;
    this.lookAroundIn = this.nextLookAround();
    this.player.stopAll(fade);
    this.cur = { name: 'Idle', intent: 'Idle', track: null };
    this.emit('clip', { clip: 'Idle', intent: 'Idle' });
  }

  settle(fade = FADE_IDLE) {
    if (this.typingWanted) this.enterTyping(fade);
    else this.toIdle(fade);
  }

  canInterrupt(name) {
    const tr = this.cur.track;
    if (!tr || tr.ended || tr.fadingOut) return true;
    const cm = MOTIONS[this.cur.name];
    if (!cm || cm.loop || cm.interruptible) return true;
    return (MOTIONS[name]?.priority ?? 0) > cm.priority;
  }

  // ---- requests (same semantics as Animator.request) -------------------------------------------

  request(name) {
    switch (name) {
      case 'Enter': return this.enter();
      case 'Exit': return this.exit();
      case 'Type': return null; // typing is driven by keystrokes (app.typeKey / demo)
    }
    if (this._state === 'Away' || this._state === 'Exiting') return null;
    this.poke(false);
    const clip = name === 'Idle' || name === 'SitDown' || name === 'StandUp' ? name : this.resolve(name);
    if (!clip) return null;
    switch (clip) {
      case 'Idle': if (this._state !== 'Sitting' && this._state !== 'Entering') this.toIdle(); return clip;
      case 'SitDown': case 'Sit_Think': return this.sit() ? clip : null;
      case 'Sit_Doze': return this.sit({ doze: true }) ? clip : null;
      case 'StandUp': return this.wake('Wave') && clip;
      case 'Pet': return this.startPet() ? clip : null;
    }
    if (this._state === 'Sitting') return this.wake(clip, name);
    if (this._state === 'Petting') return null;
    if (this._state === 'Entering' || !this.canInterrupt(clip)) {
      if (!this.queued || MOTIONS[clip].priority >= MOTIONS[this.queued.clip].priority) this.queued = { clip, intent: name };
      return clip;
    }
    this.queued = null;
    this.stateName = 'OneShot';
    this.play(clip, FADE, name);
    return clip;
  }

  sit({ doze = false } = {}) {
    this.poke(false);
    if (this.busyPresence) return false;
    const loop = doze ? 'Sit_Doze' : 'Sit_Think';
    if (this._state === 'Sitting') {
      if (this.phase === 'think' || this.phase === 'doze') {
        this.phase = loop === 'Sit_Doze' ? 'doze' : 'think';
        if (this.clip !== loop) this.play(loop, 0.8);
      } else if (this.phase === 'down') {
        this.sitLoop = loop;
      } else return false;
      return true;
    }
    if (this._state === 'Petting' || !this.canInterrupt('SitDown')) return false;
    this.typingWanted = false;
    this.stateName = 'Sitting';
    this.sitLoop = loop;
    this.queued = null;
    this.phase = 'down';
    this.play('SitDown', FADE);
    return true;
  }

  wake(next = 'Wave', intent = next) {
    if (this._state !== 'Sitting') return null;
    const clip = this.resolve(next);
    this.queued = clip ? { clip, intent } : null;
    if (this.phase === 'up') return clip || 'StandUp';
    if (this.phase === 'down') {
      this.pendingWake = true;
      return clip || 'StandUp';
    }
    this.phase = 'up';
    this.play('StandUp', FADE);
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
    if (this.busyPresence) return false;
    if (this._state === 'Sitting') { this.wake('Wave'); return false; }
    if ((this._state === 'OneShot' || this._state === 'Typing') && !this.canInterrupt('Pet')) return false;
    if (this._state === 'Petting') return true;
    this.stateName = 'Petting';
    this.queued = null;
    this.play('Pet', 0.3);
    return true;
  }

  endPet() {
    if (this._state !== 'Petting') return null;
    this.stateName = 'Idle';
    const clip = this.request('Heart');
    if (!clip) this.settle();
    return clip;
  }

  // ---- typing -------------------------------------------------------------------------------

  startTyping() {
    if (this.busyPresence || this._state === 'Petting') return null;
    this.typingWanted = true;
    this.idleTime = 0;
    switch (this._state) {
      case 'Typing': return 'typing';
      case 'Sitting':
        this.wake(null);
        return 'pending';
      default:
        if (!this.canInterrupt('Type')) return 'pending';
        this.enterTyping(FADE);
        return 'typing';
    }
  }

  enterTyping(fade = FADE) {
    this.stateName = 'Typing';
    this.phase = null;
    this.queued = null;
    this.idleTime = 0;
    if (this.clip !== 'Type') this.play('Type', fade);
    this.applyTypeRate();
  }

  stopTyping() {
    this.typingWanted = false;
    if (this._state !== 'Typing') return;
    this.toIdle(0.45);
  }

  setTypeRate(r) {
    this.typeRate = Math.min(1.6, Math.max(0.6, r));
    this.applyTypeRate();
  }

  applyTypeRate() {
    if (this.cur.name === 'Type' && this.cur.track) this.cur.track.speed = this.typeRate;
  }

  // ---- presence -------------------------------------------------------------------------------

  setPresence(mode) {
    this.presence = { mode, t: 0 };
    this.emit('presence', { mode });
  }

  /** Pop in out of thin air, then Wave. `intro` = first appearance (start()). */
  enter({ intro = false } = {}) {
    if (this._state === 'Exiting') { this.pendingPresence = 'enter'; return 'Enter'; }
    if (this._state === 'Entering') { this.pendingPresence = null; return 'Enter'; }
    if (this._state !== 'Away' && !intro) return null;
    this.pendingPresence = null;
    this.typingWanted = false;
    this.queued = null;
    this.phase = null;
    this.idleTime = 0;
    this.hidden = false;
    this.exitStep = null;
    this.stateName = 'Entering';
    this.player.clear(); // hidden before: nothing to blend from
    this.setPresence('popIn');
    this.play('Wave', FADE, intro ? 'Intro' : 'Enter');
    this.enterWaits = 'clip';
    return 'Enter';
  }

  /** Wave goodbye, then pop away (the mirror of enter()), then Away. */
  exit() {
    if (this._state === 'Away') return null;
    if (this._state === 'Exiting') { this.pendingPresence = null; return 'Exit'; }
    this.typingWanted = false;
    if (this._state === 'Sitting') {
      this.pendingPresence = 'exit';
      this.wake(null);
      return 'Exit';
    }
    if (this._state === 'Entering' || !this.canInterrupt('Wave')) {
      this.pendingPresence = 'exit';
      return 'Exit';
    }
    this.pendingPresence = null;
    this.queued = null;
    this.phase = null;
    this.stateName = 'Exiting';
    this.exitStep = 'wave';
    this.play('Wave', FADE, 'Exit');
    return 'Exit';
  }

  startPopOut() {
    this.exitStep = 'pop';
    this.setPresence('popOut');
    this.player.stopAll(FADE_IDLE); // keep breathing on the idle base while shrinking
    this.cur = { name: 'Idle', intent: 'Idle', track: null };
    this.emit('clip', { clip: 'Idle', intent: 'Idle' });
  }

  goAway() {
    this.stateName = 'Away';
    this.hidden = true;
    this.exitStep = null;
    this.queued = null;
    this.player.clear();
    this.setPresence('hidden');
    this.cur = { name: 'Idle', intent: 'Away', track: null };
    this.emit('clip', { clip: 'Idle', intent: 'Away' });
    if (this.pendingPresence === 'enter') this.enter();
    this.pendingPresence = null;
  }

  stepPresence(dt) {
    const p = this.presence;
    p.t += dt;
    if (p.mode === 'popIn' && p.t >= POP_IN) {
      this.setPresence('shown');
      if (this._state === 'Entering' && this.enterWaits === 'pop') this.finishEnter();
    } else if (p.mode === 'popOut' && p.t >= POP_OUT) this.goAway();
  }

  // ---- misc -----------------------------------------------------------------------------------

  poke(wake = true) {
    this.idleTime = 0;
    if (wake && this._state === 'Sitting') this.wake('Wave');
  }

  setIdleTimeouts(sitSec, dozeSec) {
    this.sitAfter = sitSec;
    this.dozeAfter = Math.max(dozeSec, sitSec + 0.1);
    this.idleTime = 0;
  }

  /** The current one-shot reports its end (a fade-length early). */
  onFinished() {
    const name = this.cur.name;
    switch (this._state) {
      case 'Sitting':
        if (name === 'SitDown') {
          this.phase = this.sitLoop === 'Sit_Doze' ? 'doze' : 'think';
          this.play(this.sitLoop, 0.6);
          if (this.pendingWake) { this.pendingWake = false; this.wake(this.queued?.clip ?? null, this.queued?.intent); }
        } else if (name === 'StandUp') this.afterStandUp(FADE);
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
      case 'Typing':
        return;
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
    if (name === 'Idle_LookAround') {
      this.player.stopAll(0.6);
      this.cur = { name: 'Idle', intent: 'Idle', track: null };
      return;
    }
    if (this._state === 'OneShot' || this._state === 'Idle') this.settle();
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

  update(dt) {
    this.idleTime += dt;
    this.stepPresence(dt);
    if (!this.auto) return;
    if (this._state === 'Idle') {
      if (this.idleTime >= this.sitAfter) {
        this.sit();
        this.idleTime = this.sitAfter;
        return;
      }
      if (this.cur.name === 'Idle') {
        this.lookAroundIn -= dt;
        if (this.lookAroundIn <= 0) {
          this.lookAroundIn = this.nextLookAround();
          this.play('Idle_LookAround', 0.5);
        }
      }
    } else if (this._state === 'Sitting' && this.phase === 'think' && this.idleTime >= this.dozeAfter) {
      this.phase = 'doze';
      this.play('Sit_Doze', 0.9);
    }
  }
}
