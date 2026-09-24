// Speech rhythm shared by the 3D fox (procedural.js) and the 2D puppet (live2d/app.js). While a
// speech bubble is up the mouth opens and closes in calm syllables (~2.5 per second inside a
// phrase, ~2 on average), each one an eased bump (raised cosine: no jumps, zero speed at both
// ends) with a little random variation in length and height. Phrases of a few syllables are
// separated by a short closed rest. Plain numbers, no dependencies.

const RATE = [2.2, 2.8]; // syllables per second inside a phrase
const OPEN = [0.65, 0.85]; // share of a syllable the mouth is open (the rest stays closed)
const AMP = [0.65, 1]; // how far each syllable opens
const PHRASE = [3, 5]; // syllables per phrase
const REST = [0.28, 0.5]; // s, mouth closed between phrases

export class TalkRhythm {
  constructor(rng = Math.random) {
    this.rng = rng;
    this.reset();
  }

  /** Start a new phrase (called when a bubble shows up again). */
  reset() {
    this.t = 0;
    this.left = 0;
    this.seg = this.syllable();
  }

  range([a, b]) {
    return a + (b - a) * this.rng();
  }

  syllable() {
    if (this.left <= 0) this.left = Math.round(this.range(PHRASE));
    this.left--;
    return { dur: 1 / this.range(RATE), open: this.range(OPEN), amp: this.range(AMP) };
  }

  /** Advance by dt (s); returns the mouth opening 0..1. */
  step(dt) {
    this.t += dt;
    while (this.t >= this.seg.dur) {
      this.t -= this.seg.dur;
      // end of a phrase: a closed rest, then the next phrase
      this.seg = this.left <= 0 && this.seg.amp > 0 ? { dur: this.range(REST), open: 0, amp: 0 } : this.syllable();
    }
    const s = this.seg;
    if (!s.amp) return 0;
    const u = this.t / (s.dur * s.open);
    return u >= 1 ? 0 : s.amp * 0.5 * (1 - Math.cos(2 * Math.PI * u));
  }
}
