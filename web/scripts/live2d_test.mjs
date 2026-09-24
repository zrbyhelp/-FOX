// Playwright test for the Live2D-style 2D fox (live2d.html, src/live2d/app.js) in headless
// Chromium (SwiftShader WebGL, like snap.mjs).
//
//   node scripts/live2d_test.mjs                    # starts its own Vite dev server
//   node scripts/live2d_test.mjs --out ../build/snaps/live2d --url http://localhost:5173/
//
// 1. loads the page and checks there are no console errors / warnings
// 2. poses every motion (deterministic fixed-step simulation) and screenshots a mid-frame
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
const info = () => page.evaluate(() => { const i = window.__live2d.debug.info(); delete i.params; return i; });
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
    ['Exit', 2.2, 'Exiting', 'Exit'],
  ];
  for (const [clip, t, state, expect] of motions) {
    const r = await page.evaluate(([c, tt]) => { const d = window.__live2d.debug; d.pose(c, tt); const i = d.info(); return { state: i.state, clip: i.clip, heart: i.heartsShown, keyboard: i.keyboard, z: i.dozeZ, logo: i.logo }; }, [clip, t]);
    let ok = r.state === state && r.clip === expect;
    if (clip === 'Heart') ok = ok && r.heart > 0;
    if (clip === 'Type') ok = ok && r.keyboard !== 'hidden';
    if (clip === 'Sit_Doze') ok = ok && r.z;
    if (clip === 'Reach') ok = ok && r.logo !== 'idle';
    check(`motion ${clip} @${t}s`, ok, r);
    await shot(`motion_${clip}`);
  }
  // Enter: exit first (fox hidden = Away), then hop back in
  {
    const r = await page.evaluate(() => {
      const d = window.__live2d.debug;
      d.pose('Exit', 3.1);
      const away = d.info();
      window.__live2d.request('Enter');
      d.advance(0.8);
      const mid = d.info();
      return { away: away.state, hidden: away.hidden, mid: mid.state, clip: mid.clip };
    });
    check('Exit -> Away (hidden)', r.away === 'Away' && r.hidden, r);
    check('Enter hops back in', r.mid === 'Entering' && r.clip === 'Enter', r);
    await shot('motion_Enter');
    const done = await page.evaluate(() => { window.__live2d.debug.advance(3); return window.__live2d.debug.info().state; });
    check('Enter settles to Idle', done === 'Idle', done);
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
