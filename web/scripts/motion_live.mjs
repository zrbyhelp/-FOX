// Live twitch check: plays every clip in the real page (rAF loop, procedural layers on) and
// samples every bone's world rotation at a fixed 60 Hz step, before (clip pose) and after the
// procedural layers. Flags spikes and attributes them to clip bodies, clip transitions or the
// web-side procedural layer.
//
//   node scripts/motion_live.mjs                          # fox.glb via a temporary vite server
//   node scripts/motion_live.mjs --query model=dev/m1.glb
//   node scripts/motion_live.mjs --only Jump,Exit/Enter --json out.json   (Exit/Enter = wave + pop away, pop in + wave)
//
// A spike is a frame-to-frame rotation above 25 deg/frame, or a change of angular velocity
// above 12 deg/frame^2 (both at 60 Hz). Exit code is always 0 (this is a report, not a gate).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '..');
const spec = JSON.parse(fs.readFileSync(path.resolve(webDir, '../spec.json'), 'utf8'));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1]; };
const query = opt('--query', '');
const only = opt('--only', '')?.split(',').filter(Boolean);
const jsonOut = opt('--json', null);
let base = opt('--url', null);
const LIMITS = { change: 25, jump: 12, posChange: 0.05, posJump: 0.02 };

let server = null;
if (!base) {
  const port = 5300 + Math.floor(Math.random() * 400);
  server = spawn(process.execPath, [path.join(webDir, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort'], { cwd: webDir, stdio: 'ignore', env: { ...process.env, FOX_NO_HMR: '1' } });
  base = `http://localhost:${port}/`;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const sep = base.includes('?') ? '&' : '?';
await page.goto(`${base}${sep}quality=low&noui=1${query ? '&' + query : ''}`);
await page.waitForFunction(() => window.__foxReady === true, null, { timeout: 180000 });
const clips = await page.evaluate(() => window.__fox.clips);
const has = (c) => clips.includes(c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const info = () => page.evaluate(() => window.__fox.info());
async function waitFor(pred, timeout = 20000) {
  const t0 = Date.now();
  let i;
  while (Date.now() - t0 < timeout) {
    i = await info();
    if (pred(i)) return i;
    await sleep(150);
  }
  return i;
}
const waitIdle = (t = 25000) => waitFor((i) => i.state === 'Idle' && i.clip === 'Idle' && !i.fading, t);
const trigger = (n) => page.evaluate((x) => window.__fox.trigger(x), n);

// ---- in-page recorder ----------------------------------------------------------------------
const expressionBones = spec.bones.filter((b) => b.kind === 'expression').map((b) => b.name);
await page.evaluate(({ expressionBones, LIMITS }) => {
  const F = window.__fox;
  const app = F._app;
  const { names, parents } = F.boneInfo();
  const n = names.length;
  const skip = names.map((nm) => expressionBones.includes(nm));
  const rootIdx = names.indexOf('root');
  const tipIdx = names.indexOf('tail_6');
  const D = 180 / Math.PI;

  // quaternion helpers on flat arrays [x, y, z, w]
  const mulConj = (a, ai, b, bi, out) => { // out = a * conj(b)
    const ax = a[ai], ay = a[ai + 1], az = a[ai + 2], aw = a[ai + 3];
    const bx = -b[bi], by = -b[bi + 1], bz = -b[bi + 2], bw = b[bi + 3];
    out[0] = aw * bx + ax * bw + ay * bz - az * by;
    out[1] = aw * by - ax * bz + ay * bw + az * bx;
    out[2] = aw * bz + ax * by - ay * bx + az * bw;
    out[3] = aw * bw - ax * bx - ay * by - az * bz;
  };
  const conjMul = (a, ai, b, bi, out) => { // out = conj(a) * b
    const ax = -a[ai], ay = -a[ai + 1], az = -a[ai + 2], aw = a[ai + 3];
    const bx = b[bi], by = b[bi + 1], bz = b[bi + 2], bw = b[bi + 3];
    out[0] = aw * bx + ax * bw + ay * bz - az * by;
    out[1] = aw * by - ax * bz + ay * bw + az * bx;
    out[2] = aw * bz + ax * by - ay * bx + az * bw;
    out[3] = aw * bw - ax * bx - ay * by - az * bz;
  };
  const rotvec = (q, out, oi) => { // degrees
    let [x, y, z, w] = q;
    if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
    const s = Math.sqrt(Math.max(0, 1 - w * w));
    const ang = 2 * Math.acos(Math.min(1, w)) * D;
    if (s < 1e-7) { out[oi] = out[oi + 1] = out[oi + 2] = 0; return; }
    out[oi] = (x / s) * ang; out[oi + 1] = (y / s) * ang; out[oi + 2] = (z / s) * ang;
  };

  const mk = () => ({
    world: new Float32Array(n * 4), local: new Float32Array(n * 4),
    pWorld: new Float32Array(n * 4), pLocal: new Float32Array(n * 4),
    wW: new Float32Array(n * 3), wL: new Float32Array(n * 3), pwW: new Float32Array(n * 3), pwL: new Float32Array(n * 3),
    pos: [0, 0, 0], ppos: [0, 0, 0], vel: [0, 0, 0], pvel: [0, 0, 0], frames: 0,
  });
  const S = { mixer: mk(), final: mk() };
  const tmp = [0, 0, 0, 0];
  const rec = window.__motion = {
    seg: null, t: 0, events: [], segs: {}, lastAction: null, sinceChange: 99, shownFor: 99, hiddenRecent: false, rawStep: null, dropped: 0,
  };

  function sample(s) {
    F.boneQuats(s.world);
    for (let i = 0; i < n; i++) {
      const p = parents[i];
      if (p < 0) { s.local.set(s.world.subarray(i * 4, i * 4 + 4), i * 4); continue; }
      conjMul(s.world, p * 4, s.world, i * 4, tmp);
      s.local.set(tmp, i * 4);
    }
    const rp = F.bonePos('root');
    s.pos[0] = rp[0]; s.pos[1] = rp[1]; s.pos[2] = rp[2];
  }

  /** Metrics of this step vs the previous one: per bone {change, jump} world + local. */
  function measure(s) {
    const m = { change: new Float32Array(n), jump: new Float32Array(n), lchange: new Float32Array(n), ljump: new Float32Array(n), pos: 0, posJump: 0 };
    for (let i = 0; i < n; i++) {
      mulConj(s.world, i * 4, s.pWorld, i * 4, tmp);
      rotvec(tmp, s.wW, i * 3);
      mulConj(s.local, i * 4, s.pLocal, i * 4, tmp);
      rotvec(tmp, s.wL, i * 3);
      const c = Math.hypot(s.wW[i * 3], s.wW[i * 3 + 1], s.wW[i * 3 + 2]);
      const lc = Math.hypot(s.wL[i * 3], s.wL[i * 3 + 1], s.wL[i * 3 + 2]);
      m.change[i] = c;
      m.lchange[i] = lc;
      if (s.frames >= 2) {
        m.jump[i] = Math.hypot(s.wW[i * 3] - s.pwW[i * 3], s.wW[i * 3 + 1] - s.pwW[i * 3 + 1], s.wW[i * 3 + 2] - s.pwW[i * 3 + 2]);
        m.ljump[i] = Math.hypot(s.wL[i * 3] - s.pwL[i * 3], s.wL[i * 3 + 1] - s.pwL[i * 3 + 1], s.wL[i * 3 + 2] - s.pwL[i * 3 + 2]);
      }
    }
    for (let k = 0; k < 3; k++) s.vel[k] = s.pos[k] - s.ppos[k];
    m.pos = Math.hypot(...s.vel);
    if (s.frames >= 2) m.posJump = Math.hypot(s.vel[0] - s.pvel[0], s.vel[1] - s.pvel[1], s.vel[2] - s.pvel[2]);
    return m;
  }

  function roll(s) {
    s.pWorld.set(s.world); s.pLocal.set(s.local); s.pwW.set(s.wW); s.pwL.set(s.wL);
    s.ppos = [...s.pos]; s.pvel = [...s.vel]; s.frames++;
  }

  function segStats(name) {
    return rec.segs[name] ??= { steps: 0, mixer: { change: [0, ''], jump: [0, ''] }, final: { change: [0, ''], jump: [0, ''] }, counts: {}, tailDev: 0, tailDevSum: 0 };
  }

  function top(arr, k = 3, limit = 0) {
    const idx = [];
    for (let i = 0; i < n; i++) if (!skip[i] && arr[i] > limit) idx.push(i);
    return idx.sort((a, b) => arr[b] - arr[a]).slice(0, k).map((i) => [names[i], +arr[i].toFixed(1)]);
  }

  F.onStep((phase, dt) => {
    if (!rec.seg) return;
    const s = phase === 'mixer' ? S.mixer : S.final;
    sample(s);
    const a = app.animator;
    if (phase === 'mixer') {
      rec.t += dt;
      const act = a.cur?.action ?? null;
      rec.sinceChange = act === rec.lastAction ? rec.sinceChange + 1 : 0;
      rec.lastAction = act;
      const vis = app.fox.root.visible;
      rec.shownFor = vis ? (rec.shownFor ?? 99) + 1 : 0;
      rec.hiddenRecent = rec.shownFor <= 2; // hidden now, or just shown (pose snapped while hidden)
    }
    if (s.frames === 0) { roll(s); return; }
    const m = measure(s);
    const st = segStats(rec.seg);
    if (phase === 'final') {
      st.steps++;
      if (tipIdx >= 0) { // how far the procedural layer moves the tail tip off the clip pose
        const a = S.mixer.world, b = S.final.world, o = tipIdx * 4;
        const dot = Math.min(1, Math.abs(a[o] * b[o] + a[o + 1] * b[o + 1] + a[o + 2] * b[o + 2] + a[o + 3] * b[o + 3]));
        const dev = 2 * Math.acos(dot) * D;
        st.tailDev = Math.max(st.tailDev, +dev.toFixed(1));
        st.tailDevSum += dev;
      }
    }
    let worstC = 0, worstCB = '', worstJ = 0, worstJB = '';
    for (let i = 0; i < n; i++) {
      if (skip[i]) continue;
      if (m.change[i] > worstC) { worstC = m.change[i]; worstCB = names[i]; }
      if (m.jump[i] > worstJ) { worstJ = m.jump[i]; worstJB = names[i]; }
    }
    const ss = st[phase];
    if (worstC > ss.change[0]) ss.change = [+worstC.toFixed(1), worstCB];
    if (worstJ > ss.jump[0]) ss.jump = [+worstJ.toFixed(1), worstJB];

    const spikeBones = [];
    for (let i = 0; i < n; i++) if (!skip[i] && (m.change[i] > LIMITS.change || m.jump[i] > LIMITS.jump)) spikeBones.push(i);
    const posSpike = rootIdx >= 0 && (m.pos > LIMITS.posChange || m.posJump > LIMITS.posJump);
    if (phase === 'mixer') rec.rawStep = { spikeBones: new Set(spikeBones), posSpike, m };
    if (spikeBones.length || posSpike) {
      const raw = rec.rawStep;
      let category;
      if (rec.hiddenRecent) category = 'hidden';
      else if (phase === 'final' && raw && !spikeBones.some((i) => raw.spikeBones.has(i) || raw.m.jump[i] > LIMITS.jump * 0.6) && !(posSpike && raw.posSpike)) category = 'procedural';
      else if (phase === 'final') category = null; // already reported from the clip pose
      else if (a.fade || rec.sinceChange <= 2) category = 'transition';
      else category = 'clip';
      if (category) {
        st.counts[category] = (st.counts[category] || 0) + 1;
        if (rec.events.length < 4000) {
          rec.events.push({
            seg: rec.seg, phase, category, t: +rec.t.toFixed(3), clip: a.clip, intent: a.intent, state: a.state,
            clipTime: +(a.cur?.action.time ?? 0).toFixed(3), fading: !!a.fade, sinceChange: rec.sinceChange,
            change: top(m.change, 3, LIMITS.change), jump: top(m.jump, 3, LIMITS.jump),
            originJump: top(m.ljump, 2, 4), originChange: top(m.lchange, 2, 8),
            pos: posSpike ? [+m.pos.toFixed(3), +m.posJump.toFixed(3)] : null,
          });
        } else rec.dropped++;
      }
    }
    roll(s);
  });
}, { expressionBones, LIMITS });

await page.evaluate(() => { window.__fox.setMaxDelta(0.6); window.__fox.setFixedStep(1 / 60); });
const frameMs = await page.evaluate(() => new Promise((res) => {
  let n = 0;
  const t0 = performance.now();
  const f = () => { n++; if (performance.now() - t0 > 1500) res((performance.now() - t0) / n); else requestAnimationFrame(f); };
  requestAnimationFrame(f);
}));
console.log(`clips: ${clips.join(', ')}\nframe time: ${frameMs.toFixed(0)} ms (sampled at a fixed 60 Hz step)`);
await page.mouse.move(5, 5);
await waitIdle(30000);
const seg = (name) => page.evaluate((s) => { window.__motion.seg = s; }, name);

// ---- scenario ---------------------------------------------------------------------------------
const plan = [];
const add = (name, fn) => { if (!only?.length || only.includes(name)) plan.push([name, fn]); };
for (const c of ['Wave', 'Happy', 'Heart', 'Shrug', 'Present', 'Reach', 'Jump', 'Dance', 'LookBack', 'Idle_LookAround']) {
  add(c, async () => { await trigger(c); await sleep(400); await waitIdle(); });
}
add('Sit_Think', async () => {
  await trigger('Sit');
  await waitFor((i) => i.clip === 'Sit_Think' || i.clip === 'Sit_Doze', 12000);
  await sleep(2500);
  await trigger('Wake');
  await waitIdle();
});
add('Sit_Doze', async () => {
  await trigger('Doze');
  await waitFor((i) => i.clip === 'Sit_Doze', 12000);
  await sleep(2500);
  await trigger('Wake');
  await waitIdle();
});
add('Pet', async () => {
  await trigger('Pet');
  await sleep(2500);
  await trigger('PetEnd');
  await waitIdle();
});
add('Type', async () => {
  await trigger('Type'); // 3 s demo of simulated keystrokes
  await waitFor((i) => i.typing, 5000);
  await waitFor((i) => !i.typing, 15000);
  await waitIdle();
});
add('Exit/Enter', async () => {
  await trigger('Exit');
  await waitFor((i) => i.state === 'Away', 15000);
  await sleep(500);
  await trigger('Enter');
  await waitIdle();
});
add('LookAt', async () => {
  // pointer sweeps, then the logo takes over the target, then the pointer leaves
  const logo = await page.evaluate(() => window.__fox.screenPos('logo'));
  for (const [x, y] of [[700, 120], [120, 140], [650, 420], [400, 80]]) { await page.mouse.move(x, y, { steps: 6 }); await sleep(400); }
  await page.mouse.move(logo.x, logo.y, { steps: 6 });
  await sleep(1500);
  await page.mouse.move(760, 580, { steps: 4 });
  await page.mouse.move(5, 5);
  await sleep(1500);
  await waitIdle();
});
add('TailDrag', async () => {
  const p = await page.evaluate(() => window.__fox.screenPos('tail'));
  await page.mouse.move(p.x, p.y);
  await sleep(300);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(p.x - 12 * k, p.y - 6 * k, { steps: 2 });
  await sleep(400);
  await page.mouse.up();
  await page.mouse.move(5, 5);
  await sleep(1000);
  await waitIdle();
});

for (const [name, fn] of plan) {
  await seg(name);
  const t0 = Date.now();
  await fn();
  await seg(null);
  console.log(`  ${name}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
const rec = await page.evaluate(() => window.__motion);
await page.evaluate(() => window.__fox.onStep(null));

// ---- report -----------------------------------------------------------------------------------
console.log(`\nLimits: ${LIMITS.change} deg/frame, ${LIMITS.jump} deg/frame^2 (60 Hz). "clip pose" = after the mixer, "final" = after procedural layers.\n`);
console.log('| segment | steps | clip pose: max deg/frame | max jump | final: max deg/frame | max jump | tail_6 procedural offset max / mean deg | spikes clip / transition / procedural / hidden |');
console.log('|---|---|---|---|---|---|---|---|');
for (const [name, s] of Object.entries(rec.segs)) {
  const f = (x) => `${x[0]} ${x[1]}`;
  const c = s.counts;
  console.log(`| ${name} | ${s.steps} | ${f(s.mixer.change)} | ${f(s.mixer.jump)} | ${f(s.final.change)} | ${f(s.final.jump)} | ${s.tailDev} / ${(s.tailDevSum / Math.max(1, s.steps)).toFixed(1)} | ${c.clip || 0} / ${c.transition || 0} / ${c.procedural || 0} / ${c.hidden || 0} |`);
}

function group(events) {
  // merge consecutive steps of the same clip / category into runs
  const runs = [];
  for (const e of events) {
    const bones = [...e.jump, ...e.change].map((b) => b[0]);
    const origin = (e.originJump[0] || e.originChange[0] || [''])[0];
    const last = runs[runs.length - 1];
    if (last && last.category === e.category && last.clip === e.clip && last.seg === e.seg && e.t - last.t1 < 0.05) {
      last.t1 = e.t;
      last.ct1 = e.clipTime;
      last.n++;
      for (const b of bones) last.bones.add(b);
      if (origin) last.origins.add(origin);
      last.peakJ = Math.max(last.peakJ, e.jump[0]?.[1] ?? 0);
      last.peakC = Math.max(last.peakC, e.change[0]?.[1] ?? 0);
      if (e.pos) last.pos = e.pos;
    } else {
      runs.push({
        seg: e.seg, category: e.category, clip: e.clip, intent: e.intent, t0: e.t, t1: e.t, ct0: e.clipTime, ct1: e.clipTime, n: 1,
        bones: new Set(bones), origins: new Set(origin ? [origin] : []), peakJ: e.jump[0]?.[1] ?? 0, peakC: e.change[0]?.[1] ?? 0,
        fading: e.fading, pos: e.pos,
      });
    }
  }
  return runs;
}
const runs = group(rec.events);
for (const cat of ['clip', 'transition', 'procedural', 'hidden']) {
  const rs = runs.filter((r) => r.category === cat);
  const title = { clip: 'Clip-body spikes (model side)', transition: 'Transition spikes (crossfade / clip start)', procedural: 'Procedural-layer spikes (web side)', hidden: 'While hidden (not visible, ignored)' }[cat];
  console.log(`\n${title}: ${rs.length}`);
  for (const r of rs.slice(0, 40)) {
    console.log(`  [${r.seg}] clip ${r.clip} t=${r.ct0.toFixed(2)}${r.ct1 !== r.ct0 ? '-' + r.ct1.toFixed(2) : ''}s (${r.n} steps) peak ${r.peakC} deg/frame, jump ${r.peakJ}; bones ${[...r.bones].slice(0, 6).join(' ')}; origin ${[...r.origins].slice(0, 4).join(' ') || '-'}${r.pos ? `; root pos ${r.pos.join('/')}` : ''}`);
  }
}
if (rec.dropped) console.log(`(${rec.dropped} events not stored)`);
if (errors.length) console.log('\npage errors:', errors.slice(0, 5).join(' | '));
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ limits: LIMITS, clips, segs: rec.segs, runs: runs.map((r) => ({ ...r, bones: [...r.bones], origins: [...r.origins] })) }, null, 1));

await browser.close();
server?.kill();
