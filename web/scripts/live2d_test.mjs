// Playwright test for the Live2D-style 2D fox (live2d.html, src/live2d/app.js) in headless
// Chromium (SwiftShader WebGL, like snap.mjs).
//
//   node scripts/live2d_test.mjs                    # starts its own Vite dev server
//   node scripts/live2d_test.mjs --out ../build/snaps/live2d --url http://localhost:5173/
//
// 1. loads the page and checks there are no console errors / warnings; the start pops in + waves
// 2. poses every motion (deterministic fixed-step simulation) and screenshots a mid-frame;
//    离场 / 回来 pop away / in with the logo; calm talking mouth, eased expressions; the bigger
//    keyboard under the typing paws
// 3. real-time pointer tests: click head -> Happy, drag head -> Pet -> Heart on release,
//    hover logo -> Present, click logo -> Reach + logo activation, double-click -> Jump,
//    click tail -> LookBack, click ear -> ear flick, drag tail, typing keys -> Typing + keyboard
//    (hidden again after 1.8 s)
// 4. idle timers (shortened with the debug override): Idle -> Sitting/Sit_Think -> Sit_Doze
// 5. start/stop x3 and create/dispose x3 with no errors
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const outDir = path.resolve(webDir, opt('--out', '../build/snaps/live2d'));
const url = opt('--url', null);
const W = Number(opt('--width', '1000'));
const H = Number(opt('--height', '760'));

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
}

let server = null;
let base = url;
if (!base) {
  const port = 5300 + Math.floor(Math.random() * 400);
  server = spawn(process.execPath, [path.join(webDir, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort'], {
    cwd: webDir, stdio: 'ignore', env: { ...process.env, FOX_NO_HMR: '1' },
  });
  base = `http://localhost:${port}/`;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(base); if (r.ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) logs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));

const shots = [];
fs.mkdirSync(outDir, { recursive: true });
async function shot(name) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  shots.push(file);
}
const info = () => page.evaluate(() => { const i = window.__live2d.debug.info(); for (const k of ['params', 'keyArea', 'paws']) delete i[k]; return i; });
const waitFor = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 50 }).then(() => true, () => false);

try {
  // ---- 1. load ---------------------------------------------------------------------------------
  const t0 = Date.now();
  await page.goto(`${base}live2d.html?debug=1&seed=1`);
  const ready = await waitFor(() => window.__live2dReady === true, null, 180000);
  check('page loads (window.__live2dReady)', ready, `${Date.now() - t0} ms`);
  if (!ready) throw new Error('page did not load');
  const api = await page.evaluate(() => {
    const a = window.__live2d;
    return ['start', 'stop', 'dispose', 'request', 'has', 'setLookEnabled', 'setInsetBottom', 'onEvent', 'typeKey', 'resize']
      .filter((k) => typeof a[k] !== 'function');
  });
  check('API surface complete', api.length === 0, api.length ? `missing ${api}` : '');
  const hasAll = await page.evaluate(() => ['Wave', 'Happy', 'Heart', 'Present', 'Reach', 'Shrug', 'Jump', 'Sit_Think', 'Sit_Doze', 'Pet', 'LookBack', 'Enter', 'Exit', 'Type', 'StandUp']
    .filter((n) => !window.__live2d.has(n)));
  check('has() every spec clip', hasAll.length === 0, hasAll.join(','));
  const intro = await info();
  check('start pops in + waves, the logo with it', intro.state === 'Entering' && intro.clip === 'Wave' && intro.intent === 'Intro'
    && ['popIn', 'shown'].includes(intro.presence) && ['in', 'shown'].includes(intro.logoPresence), intro);
  await page.waitForTimeout(1500); // intro pop + wave running live
  await shot('00_intro_live');

  // performance (CPU simulation+deformation per step; one render under SwiftShader for reference)
  const perf = await page.evaluate(() => window.__live2d.debug.bench(240));
  check('CPU step < 4 ms (deform + physics + motions)', perf.stepMs < 4, perf);

  // ---- 2. motions ------------------------------------------------------------------------------
  await page.evaluate(() => window.__live2d.debug.freeze(true));
  const motions = [
    ['Idle', 1.5, 'Idle', 'Idle'],
    ['Wave', 1.2, 'OneShot', 'Wave'],
    ['Happy', 1.0, 'OneShot', 'Happy'],
    ['Heart', 1.1, 'OneShot', 'Heart'],
    ['Present', 1.3, 'OneShot', 'Present'],
    ['Reach', 1.4, 'OneShot', 'Reach'],
    ['Shrug', 1.1, 'OneShot', 'Shrug'],
    ['Jump', 0.57, 'OneShot', 'Jump'],
    ['LookBack', 1.3, 'OneShot', 'LookBack'],
    ['Pet', 1.0, 'Petting', 'Pet'],
    ['Sit_Think', 2.2, 'Sitting', 'Sit_Think'],
    ['Sit_Doze', 4.0, 'Sitting', 'Sit_Doze'],
    ['Type', 1.0, 'Typing', 'Type'],
    ['Exit', 1.2, 'Exiting', 'Wave'], // the goodbye wave
  ];
  for (const [clip, t, state, expect] of motions) {
    const r = await page.evaluate(([c, tt]) => {
      const d = window.__live2d.debug;
      d.pose(c, tt);
      const i = d.info();
      return { state: i.state, clip: i.clip, intent: i.intent, heart: i.heartsShown, keyboard: i.keyboard, z: i.dozeZ, logo: i.logo, kbw: i.keyboardWidth, keys: i.keyArea, paws: i.paws };
    }, [clip, t]);
    let ok = r.state === state && r.clip === expect;
    if (clip === 'Heart') ok = ok && r.heart > 0;
    if (clip === 'Type') ok = ok && r.keyboard !== 'hidden';
    if (clip === 'Sit_Doze') ok = ok && r.z;
    if (clip === 'Reach') ok = ok && r.logo !== 'idle';
    if (clip === 'Exit') ok = ok && r.intent === 'Exit';
    check(`motion ${clip} @${t}s`, ok, { state: r.state, clip: r.clip, intent: r.intent });
    if (clip === 'Type') {
      // the keyboard is ~1.4x the first design (0.46 wide) and both paws land on its keys
      const [x0, y0, x1, y1] = r.keys;
      const onKeys = r.paws.every(([x, y]) => x > x0 && x < x1 && y > y0 && y < y1);
      check('bigger 2D keyboard under the typing paws', r.kbw > 0.6 && onKeys, { width: +r.kbw.toFixed(3), keys: r.keys.map((v) => +v.toFixed(3)), paws: r.paws.map((q) => q.map((v) => +v.toFixed(3))) });
    }
    await shot(`motion_${clip}`);
  }
  // 离场: wave goodbye, then pop away (a little anticipation, then shrink) with the logo -> Away,
  // fox + logo hidden, the logo not clickable; 回来: pop in + Wave, the logo a beat later -> Idle
  {
    const logoAt = await page.evaluate(() => { const d = window.__live2d.debug; d.pose('Idle', 0.1); return d.clientPos('logo'); });
    const r = await page.evaluate(() => {
      const d = window.__live2d.debug;
      d.pose('Exit', 1.2);
      const tr = d.trace(1.8, ['ParamScale']).ParamScale; // the wave ends at ~2.25 s, 0.6 s pop
      const away = d.info();
      return { maxScale: Math.max(...tr), minScale: Math.min(...tr), away: { state: away.state, hidden: away.hidden, logo: away.logoPresence, logoVisible: away.logoVisible } };
    });
    check('Exit: goodbye wave, then pops away', r.away.state === 'Away' && r.away.hidden && r.maxScale > 1.005 && r.minScale < 0.01, r);
    check('logo pops away with the fox, hidden while away', r.away.logo === 'hidden' && !r.away.logoVisible, r.away);
    const hit = await page.evaluate(([x, y]) => window.__live2d.debug.partAt(x, y), [logoAt.x, logoAt.y]);
    check('away: logo not hoverable / clickable', hit === null, hit);
    await shot('motion_Away');
    const e = await page.evaluate(() => {
      const d = window.__live2d.debug;
      window.__live2d.request('Enter');
      const first = d.info();
      d.advance(0.4);
      const mid = d.info();
      return {
        first: { state: first.state, clip: first.clip, intent: first.intent, presence: first.presence },
        mid: { presence: mid.presence, scale: +mid.scale.toFixed(3), logo: mid.logoPresence, logoScale: +mid.logoScale.toFixed(3) },
      };
    });
    check('Enter pops in + waves (no hopping)', e.first.state === 'Entering' && e.first.clip === 'Wave' && e.first.intent === 'Enter' && e.first.presence === 'popIn', e.first);
    check('Enter: fox + logo mid-pop', e.mid.presence === 'popIn' && e.mid.scale > 0.3 && e.mid.scale < 1.2 && e.mid.logo === 'in' && e.mid.logoScale > 0.05, e.mid);
    await shot('motion_Enter_pop');
    const done = await page.evaluate(() => { const i = window.__live2d.debug.advance(3); return { state: i.state, logo: i.logoPresence, logoScale: i.logoScale }; });
    check('Enter settles to Idle, logo back', done.state === 'Idle' && done.logo === 'shown' && done.logoScale === 1, done);
  }
  // talking: calm eased syllables (~2-2.5 open / close per second, closed rests); eased eye smile
  {
    const r = await page.evaluate(() => {
      const d = window.__live2d.debug;
      d.pose('Idle', 0.2);
      window.__live2d.setTalking(true);
      const m = d.trace(6, ['ParamMouthOpen']).ParamMouthOpen;
      window.__live2d.setTalking(false);
      d.pose('Idle', 0.2);
      window.__live2d.request('Happy');
      const smile = d.trace(1.2, ['ParamEyeSmile']).ParamEyeSmile;
      return { m, smile };
    });
    const o = r.m.slice(30);
    let cycles = 0;
    let maxStep = 0;
    let run = 0;
    let rest = 0;
    for (let k = 1; k < o.length; k++) {
      if (o[k - 1] < 0.3 && o[k] >= 0.3) cycles++;
      maxStep = Math.max(maxStep, Math.abs(o[k] - o[k - 1]));
      run = o[k] < 0.03 ? run + 1 : 0;
      rest = Math.max(rest, run / 60);
    }
    const rate = cycles / (o.length / 60);
    check('talk: calm eased mouth (~2-2.5 Hz, rests)', rate >= 1.5 && rate <= 2.8 && maxStep < 0.2 && rest >= 0.25,
      { perSecond: +rate.toFixed(2), maxStepPerFrame: +maxStep.toFixed(3), longestRest: +rest.toFixed(2) });
    // the eye layers swap between smile 0.3 and 0.85: that must take >= 0.3 s
    const a = r.smile.findIndex((v) => v > 0.3);
    const b = r.smile.findIndex((v) => v > 0.85);
    check('eye smile swap eased >= 0.3 s', a >= 0 && b > a && (b - a) / 60 >= 0.3, { swapSeconds: +((b - a) / 60).toFixed(2) });
  }
  // StandUp from sitting, then the queued Wave
  {
    const r = await page.evaluate(() => {
      const d = window.__live2d.debug;
      d.pose('Sit_Think', 1.5);
      window.__live2d.request('StandUp');
      d.advance(0.45);
      const mid = d.info();
      d.advance(1.0);
      return { mid: mid.clip, after: d.info().clip };
    });
    check('StandUp then Wave', r.mid === 'StandUp' && r.after === 'Wave', r);
    await shot('motion_StandUp_Wave');
  }
  // head turn extremes (seams check) + logo active close-up
  await page.evaluate(() => { const d = window.__live2d.debug; d.pose('Idle', 0.2); Object.assign(d.overrides, { ParamAngleX: 30, ParamAngleY: 18 }); d.advance(0.1); });
  await shot('turn_right_up');
  await page.evaluate(() => { const d = window.__live2d.debug; Object.assign(d.overrides, { ParamAngleX: -30, ParamAngleY: -18 }); d.advance(0.1); });
  await shot('turn_left_down');
  await page.evaluate(() => { const d = window.__live2d.debug; for (const k in d.overrides) delete d.overrides[k]; d.pose('Reach', 1.6); });
  await shot('logo_active');

  // ---- 3. real-time interaction -----------------------------------------------------------------
  const reset = () => page.evaluate(() => { const d = window.__live2d.debug; d.pose('Idle', 0.05); d.freeze(false); });
  const pos = (part) => page.evaluate((p) => window.__live2d.debug.clientPos(p), part);
  await page.mouse.move(W - 5, 5);
  await reset();

  // hover logo -> Present
  {
    const logo = await pos('logo');
    await page.mouse.move(logo.x, logo.y, { steps: 3 });
    const ok = await waitFor(() => window.__live2d.clip === 'Present');
    check('hover logo -> Present', ok, await info());
    await page.mouse.move(W - 5, 5);
  }
  // click logo -> Reach + activation
  await reset();
  {
    const logo = await pos('logo');
    await page.mouse.click(logo.x, logo.y);
    const ok = await waitFor(() => window.__live2d.clip === 'Reach' && window.__live2d.debug.logo.state !== 'idle');
    check('click logo -> Reach + logo activated', ok, await info());
    await page.waitForTimeout(400);
    await shot('interact_logo_click');
    await page.mouse.move(W - 5, 5);
  }
  // click head -> Happy
  await reset();
  {
    const head = await pos('head');
    check('head hit area found', !!head, head);
    const partAt = await page.evaluate(([x, y]) => window.__live2d.debug.partAt(x, y), [head.x, head.y]);
    check('partAt(head) = head', partAt === 'head', partAt);
    await page.mouse.click(head.x, head.y);
    const ok = await waitFor(() => window.__live2d.clip === 'Happy');
    check('click head -> Happy', ok, await info());
    await page.waitForTimeout(500);
    await shot('interact_head_click');
  }
  // drag on the head -> Pet, release -> Heart
  await reset();
  {
    const head = await pos('head');
    await page.mouse.move(head.x, head.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(head.x + i * 7, head.y + (i % 2) * 4);
    const petting = await waitFor(() => window.__live2d.state === 'Petting' && window.__live2d.clip === 'Pet');
    check('drag head -> Petting / Pet', petting, await info());
    await page.waitForTimeout(600);
    await shot('interact_pet');
    await page.mouse.up();
    const heart = await waitFor(() => window.__live2d.clip === 'Heart');
    check('release after petting -> Heart', heart, await info());
    const pop = await waitFor(() => window.__live2d.debug.info().heartsShown > 0);
    check('heart sprite popped', pop);
    await page.waitForTimeout(300);
    await shot('interact_heart');
  }
  // double-click body -> Jump
  await reset();
  {
    const body = await pos('body');
    await page.mouse.dblclick(body.x, body.y);
    const ok = await waitFor(() => window.__live2d.clip === 'Jump');
    check('double-click -> Jump', ok, await info());
  }
  // click tail -> LookBack
  await reset();
  {
    const tail = await pos('tail');
    check('tail hit area found', !!tail, tail);
    if (tail) {
      await page.mouse.click(tail.x, tail.y);
      const ok = await waitFor(() => window.__live2d.clip === 'LookBack');
      check('click tail -> LookBack', ok, await info());
    }
  }
  // drag tail: the tail follows the pointer, springs back on release
  await reset();
  {
    const tail = await pos('tail');
    if (tail) {
      const before = await page.evaluate(() => window.__live2d.debug.params.PhysTail4);
      await page.mouse.move(tail.x, tail.y);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(tail.x + i * 12, tail.y + i * 6);
      // simulated time (software GL renders a few fps, so wall-clock waits barely advance it)
      await page.evaluate(() => window.__live2d.debug.advance(0.8));
      const held = await page.evaluate(() => window.__live2d.debug.params.PhysTail4);
      await shot('interact_tail_drag');
      await page.mouse.up();
      // springs back with overshoot (and the release plays LookBack's tail whip): sample for a
      // while and require it to come back closer to the rest angle than it was while held
      let after = held;
      for (let i = 0; i < 15; i++) {
        const v = await page.evaluate(() => {
          window.__live2d.debug.advance(0.2);
          return window.__live2d.debug.params.PhysTail4;
        });
        if (Math.abs(v - before) < Math.abs(after - before)) after = v;
      }
      check('drag tail bends it towards the pointer, then springs back', held < before - 8 && Math.abs(after - before) < Math.abs(held - before), { before, held, closestAfter: after });
    }
  }
  // click ear -> flick
  await reset();
  {
    const ear = await pos('ear_L');
    check('ear hit area found', !!ear, ear);
    if (ear) {
      const n0 = await page.evaluate(() => window.__live2d.debug.info().earFlicks);
      await page.mouse.click(ear.x, ear.y);
      const ok = await waitFor((n) => window.__live2d.debug.info().earFlicks > n, n0);
      check('click ear -> ear flick', ok);
    }
  }
  // typing
  await reset();
  {
    await page.mouse.move(W - 5, 5);
    for (const k of ['KeyH', 'KeyE', 'KeyL', 'KeyL', 'KeyO']) {
      await page.keyboard.press(k);
      await page.waitForTimeout(60);
    }
    const typing = await waitFor(() => window.__live2d.state === 'Typing' && window.__live2d.debug.info().keyboard !== 'hidden');
    check('keys -> Typing + keyboard shown', typing, await info());
    await page.waitForTimeout(400);
    await shot('interact_typing');
    const stopped = await waitFor(() => window.__live2d.debug.info().keyboard === 'hidden' && window.__live2d.state === 'Idle', null, 20000);
    check('keyboard hides after 1.8 s without keys', stopped, await info());
  }
  // click events + onEvent
  {
    const evs = await page.evaluate(() => new Promise((resolve) => {
      const got = [];
      const off = window.__live2d.onEvent((e) => got.push(e.type + ':' + (e.name || e.to || '')));
      window.__live2d.request('Shrug');
      setTimeout(() => { off(); resolve(got); }, 300);
    }));
    check('onEvent emits clip/state events', evs.includes('clip:Shrug') && evs.some((e) => e.startsWith('state:')), evs);
  }

  // ---- 4. idle timers -----------------------------------------------------------------------------
  {
    const r = await page.evaluate(() => {
      const d = window.__live2d.debug;
      d.freeze(true);
      d.pose('Idle', 0.05);
      d.setIdleTimeouts(1, 3.2);
      const seq = [];
      d.advance(1.3); seq.push(`${d.info().state}/${d.info().clip}`);
      d.advance(1.2); seq.push(`${d.info().state}/${d.info().clip}`);
      d.advance(1.5); seq.push(`${d.info().state}/${d.info().clip}/z=${d.info().dozeZ}`);
      return seq;
    });
    check('idle timer: sits down (think)', /^Sitting\/(SitDown|Sit_Think)/.test(r[0]) && r[1] === 'Sitting/Sit_Think', r);
    check('idle timer: dozes off', r[2].startsWith('Sitting/Sit_Doze') && r[2].endsWith('z=true'), r);
    await shot('idle_timer_doze');
    const woke = await page.evaluate(() => {
      const d = window.__live2d.debug;
      window.__live2d.request('Wave');
      d.advance(1.3);
      const i = d.info();
      d.setIdleTimeouts(15, 30);
      return `${i.state}/${i.clip}`;
    });
    check('request while dozing: stand up, then Wave', woke === 'OneShot/Wave', woke);
    await page.evaluate(() => window.__live2d.debug.freeze(false));
  }

  // ---- 5. start / stop / dispose cycles --------------------------------------------------------------
  {
    const r = await page.evaluate(async () => {
      const out = [];
      const a = window.__live2d;
      for (let i = 0; i < 3; i++) {
        a.stop();
        const stopped = !a.running && a.canvas.style.display === 'none';
        await new Promise((res) => setTimeout(res, 120));
        a.start();
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        out.push(stopped && a.running && a.canvas.style.display !== 'none');
      }
      return out;
    });
    check('start/stop x3', r.every(Boolean), r);
    const n = logs.length;
    const r2 = await page.evaluate(async () => {
      const container = document.getElementById('stage2d');
      window.__live2d.dispose();
      const counts = [];
      for (let i = 0; i < 3; i++) {
        const a = await window.__createLive2DApp({ container, debug: true, seed: 2 + i, insetBottom: 90 });
        a.start();
        await new Promise((res) => setTimeout(res, 250));
        a.request('Happy');
        a.stop();
        a.start();
        await new Promise((res) => setTimeout(res, 150));
        a.dispose();
        counts.push(container.querySelectorAll('canvas').length);
      }
      const fin = await window.__createLive2DApp({ container, debug: true, seed: 7, insetBottom: 90 });
      fin.start();
      window.__live2d = fin;
      return { counts, final: container.querySelectorAll('canvas').length };
    });
    check('create/start/stop/dispose x3 leaves no canvas behind', r2.counts.every((c) => c === 0) && r2.final === 1, r2);
    check('no errors during the cycles', logs.length === n, logs.slice(n));
    await page.waitForTimeout(1200);
    await shot('after_dispose_cycles');
  }
} catch (err) {
  check('test run', false, err.message);
}

check('no console errors / warnings', logs.length === 0, logs);
const failed = checks.filter((c) => !c.ok);
console.log(JSON.stringify({ outDir, screenshots: shots.map((s) => path.basename(s)), passed: checks.length - failed.length, failed: failed.length }, null, 1));
await browser.close();
server?.kill();
process.exit(failed.length ? 1 : 0);
