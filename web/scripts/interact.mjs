// Playwright interaction test for the fox page (headless Chromium, SwiftShader WebGL).
//
//   node scripts/interact.mjs                          # fox.glb via a temporary vite server
//   node scripts/interact.mjs --query model=dev/m1.glb
//   node scripts/interact.mjs --url http://localhost:5173/
//
// Clips missing from the loaded model are reported as SKIP (with the fallback that played),
// never as FAIL. Exits non-zero if any check FAILs.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1]; };
const query = opt('--query', '');
let base = opt('--url', null);

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
const page = await browser.newPage({ viewport: { width: 960, height: 680 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

const sep = base.includes('?') ? '&' : '?';
await page.goto(`${base}${sep}quality=low${query ? '&' + query : ''}`);
await page.waitForFunction(() => window.__foxReady === true, null, { timeout: 180000 });
const introClip = await page.evaluate(() => window.__fox.clip);
// Software GL renders at ~1-3 fps: let each frame advance by its real duration so clips play at
// wall-clock speed, and stretch timeouts further if frames are slower than that.
await page.evaluate(() => window.__fox.setMaxDelta(0.6));
const frameMs = await page.evaluate(() => new Promise((res) => {
  let n = 0;
  const t0 = performance.now();
  const f = () => { n++; if (performance.now() - t0 > 2000) res((performance.now() - t0) / n); else requestAnimationFrame(f); };
  requestAnimationFrame(f);
}));
const slow = Math.max(1, frameMs / 600);

// ---- helpers ------------------------------------------------------------------------------
const results = [];
const record = (name, status, detail = '') => {
  results.push({ name, status, detail });
  console.log(`${status.padEnd(4)} ${name}${detail ? ' - ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const info = () => page.evaluate(() => window.__fox.info());
const clips = await page.evaluate(() => window.__fox.clips);
const has = (c) => clips.includes(c);
const resolve = (c) => page.evaluate((n) => window.__fox.resolve(n), c);
const pos = (part) => page.evaluate((p) => window.__fox.screenPos(p), part);

async function waitFor(pred, timeout = 8000, step = 100) {
  timeout *= slow;
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await info();
    if (pred(last)) return last;
    await sleep(step);
  }
  return last;
}
const waitIdle = (timeout = 20000) => waitFor((i) => i.state === 'Idle' && i.clip === 'Idle', timeout);

/** Check that `clip` (or its fallback) starts; SKIP when the model lacks `clip`. */
async function expectClip(name, clip, timeout = 3000) {
  const expected = await resolve(clip);
  const i = await waitFor((s) => s.clip === expected || (s.clip === clip && has(clip)), timeout);
  if (has(clip)) {
    record(name, i.clip === clip ? 'PASS' : 'FAIL', `clip=${i.clip} state=${i.state}`);
  } else if (expected && i.clip === expected) {
    record(name, 'SKIP', `${clip} missing, fallback ${expected} played`);
  } else if (!expected) {
    record(name, 'SKIP', `${clip} missing, no fallback (clip=${i.clip})`);
  } else {
    record(name, 'FAIL', `${clip} missing, expected fallback ${expected}, got ${i.clip}`);
  }
  return i;
}

async function pickCheck(part) {
  const p = await pos(part);
  const hit = p && (await page.evaluate(({ x, y }) => window.__fox.pickAt(x, y), p));
  if (hit !== part) record(`pick ${part}`, 'FAIL', `screenPos(${part}) picks ${hit}`);
  return p;
}

// ---- tests --------------------------------------------------------------------------------
const logoSource = (await info()).logoSource;
console.log(`clips: ${clips.join(', ')}\nlogo: ${logoSource}\nframe time: ${frameMs.toFixed(0)} ms`);
await page.mouse.move(5, 5); // park the pointer away from the fox

// Intro: pop-in + Wave, then Idle.
{
  if (has('Wave')) record('intro plays Wave', introClip === 'Wave' ? 'PASS' : 'FAIL', `clip=${introClip}`);
  else record('intro plays Wave', 'SKIP', 'Wave missing');
  const j = await waitIdle();
  record('returns to Idle', j.clip === 'Idle' && j.state === 'Idle' ? 'PASS' : 'FAIL', `state=${j.state} clip=${j.clip}`);
}

// Click head -> Happy.
{
  await waitIdle();
  const p = await pickCheck('head');
  await page.mouse.click(p.x, p.y);
  await expectClip('click head -> Happy', 'Happy');
}

// Double-click -> Jump (not Happy).
{
  await waitIdle();
  const p = await pos('body');
  await page.mouse.dblclick(p.x, p.y);
  await expectClip('double-click -> Jump', 'Jump');
}

// Click ear -> ear flick (procedural spring impulse, after the double-click window).
{
  await waitIdle();
  const before = (await info()).earFlicks;
  const p = await pickCheck('ear_L');
  await page.mouse.click(p.x, p.y);
  const i = await waitFor((s) => s.earFlicks > before, 2000, 50);
  record('click ear -> ear flick', i.earFlicks > before ? 'PASS' : 'FAIL', `flicks ${before} -> ${i.earFlicks}, clip=${i.clip}`);
}

// Click body -> Wave or Shrug.
{
  await waitIdle();
  const p = await pickCheck('body');
  await page.mouse.click(p.x, p.y);
  const i = await waitFor((s) => s.clip !== 'Idle', 3000);
  const ok = ['Wave', 'Shrug'].includes(i.clip);
  record('click body -> Wave|Shrug', ok ? 'PASS' : 'FAIL', `clip=${i.clip}${has('Shrug') ? '' : ' (Shrug missing)'}`);
}

// Click tail -> LookBack.
{
  await waitIdle();
  const p = await pickCheck('tail');
  await page.mouse.click(p.x, p.y);
  await expectClip('click tail -> LookBack', 'LookBack');
}

// Drag on head -> Pet; release -> Heart.
{
  await waitIdle();
  const p = await pos('head');
  const cam0 = await page.evaluate(() => window.__fox._app.stage.camera.position.toArray());
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  for (let k = 1; k <= 12; k++) await page.mouse.move(p.x + 35 * Math.sin(k * 0.8), p.y + 6 * Math.cos(k), { steps: 2 });
  const i = await info();
  record('drag head -> Petting state', i.state === 'Petting' ? 'PASS' : 'FAIL', `state=${i.state}`);
  if (has('Pet')) record('drag head -> Pet clip', i.clip === 'Pet' ? 'PASS' : 'FAIL', `clip=${i.clip}`);
  else record('drag head -> Pet clip', 'SKIP', `Pet missing (clip=${i.clip})`);
  const cam1 = await page.evaluate(() => window.__fox._app.stage.camera.position.toArray());
  const moved = Math.hypot(...cam0.map((v, n) => v - cam1[n]));
  record('petting does not orbit the camera', moved < 1e-3 ? 'PASS' : 'FAIL', `camera moved ${moved.toFixed(4)}`);
  await page.mouse.up();
  await expectClip('release -> Heart', 'Heart');
}

// Hover logo -> Present + look at the logo.
{
  await waitIdle();
  const p = await pickCheck('logo');
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await expectClip('hover logo -> Present', 'Present');
  const i = await waitFor((s) => s.lookWeight > 0.2, 2500);
  record('hover logo -> look-at active', i.lookWeight > 0.2 ? 'PASS' : 'FAIL', `lookWeight=${i.lookWeight.toFixed(2)}`);
}

// Click logo -> logo activates + Reach, then settles back.
{
  await waitIdle();
  const p = await pos('logo');
  await page.mouse.click(p.x, p.y);
  const i = await waitFor((s) => s.logo === 'activating' || s.logo === 'active', 2000);
  record('click logo -> logo active', ['activating', 'active'].includes(i.logo) ? 'PASS' : 'FAIL', `logo=${i.logo}`);
  await expectClip('click logo -> Reach', 'Reach');
  const j = await waitFor((s) => s.logo === 'idle', 15000, 250);
  record('logo settles back', j.logo === 'idle' ? 'PASS' : 'FAIL', `logo=${j.logo}`);
}

// Idle -> Sit_Think -> Sit_Doze; click -> StandUp.
{
  await page.mouse.move(5, 5);
  await waitIdle();
  const canSit = has('Sit_Think') || has('Sit_Doze');
  if (!canSit) {
    for (const n of ['idle -> Sit_Think', 'idle longer -> Sit_Doze', 'click while sitting -> StandUp']) record(n, 'SKIP', 'sit clips missing');
    await page.evaluate(() => window.__fox.setIdleTimeouts(1500, 3000));
    await sleep(2500);
    const i = await info();
    record('no sit without clips', i.state !== 'Sitting' ? 'PASS' : 'FAIL', `state=${i.state}`);
    await page.evaluate(() => window.__fox.setIdleTimeouts(15000, 30000));
  } else {
    await page.evaluate(() => window.__fox.setIdleTimeouts(1500, 4500));
    let i = await waitFor((s) => s.clip === 'Sit_Think' || s.clip === 'Sit_Doze', 15000);
    record('idle -> Sit_Think', has('Sit_Think') ? (i.clip === 'Sit_Think' ? 'PASS' : 'FAIL') : 'SKIP', `clip=${i.clip}`);
    i = await waitFor((s) => s.clip === 'Sit_Doze', 15000);
    record('idle longer -> Sit_Doze', has('Sit_Doze') ? (i.clip === 'Sit_Doze' ? 'PASS' : 'FAIL') : 'SKIP', `clip=${i.clip}`);
    const p = await pos('body');
    await page.mouse.click(p.x, p.y);
    i = await waitFor((s) => s.clip === 'StandUp' || s.state !== 'Sitting', 3000);
    if (has('StandUp')) record('click while sitting -> StandUp', i.clip === 'StandUp' ? 'PASS' : 'FAIL', `clip=${i.clip}`);
    else record('click while sitting -> StandUp', 'SKIP', `StandUp missing (clip=${i.clip})`);
    i = await waitFor((s) => s.clip === 'Wave', 10000);
    record('... then Wave', i.clip === 'Wave' ? 'PASS' : 'FAIL', `clip=${i.clip}`);
    await page.evaluate(() => window.__fox.setIdleTimeouts(15000, 30000));
  }
}

// Toolbar: missing clips disabled; 打招呼 plays Wave.
{
  await waitIdle();
  const buttons = await page.$$eval('.toolbar button[data-trigger]', (bs) => bs.map((b) => ({ t: b.dataset.trigger, d: b.disabled, label: b.textContent })));
  const needs = { Wave: 'Wave', Happy: 'Happy', Heart: 'Heart', Shrug: 'Shrug', Present: 'Present', Reach: 'Reach', Jump: 'Jump', Sit: 'Sit_Think', Doze: 'Sit_Doze' };
  const wrong = buttons.filter((b) => needs[b.t] && b.d === has(needs[b.t]));
  record('toolbar buttons enabled iff clip exists', buttons.length >= 11 && !wrong.length ? 'PASS' : 'FAIL',
    `${buttons.length} buttons, disabled: ${buttons.filter((b) => b.d).map((b) => b.label).join(' ') || 'none'}`);
  await page.click('.toolbar button[data-trigger="Wave"]');
  await expectClip('toolbar 打招呼 -> Wave', 'Wave');
}

// Dragging empty space orbits the camera.
{
  const { width } = page.viewportSize();
  const [x, y] = [width - 60, 120];
  const empty = await page.evaluate(([px, py]) => window.__fox.pickAt(px, py), [x, y]);
  if (empty) record('empty-space probe', 'FAIL', `(${x},${y}) hits ${empty}`);
  const cam0 = await page.evaluate(() => window.__fox._app.stage.camera.position.toArray());
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 100, y + 20, { steps: 8 });
  await page.mouse.up();
  await sleep(300);
  const cam1 = await page.evaluate(() => window.__fox._app.stage.camera.position.toArray());
  const moved = Math.hypot(...cam0.map((v, n) => v - cam1[n]));
  record('drag empty space -> orbit', moved > 0.05 ? 'PASS' : 'FAIL', `camera moved ${moved.toFixed(3)}`);
}

record('no console errors / page errors', errors.length ? 'FAIL' : 'PASS', errors.slice(0, 3).join(' | '));

// ---- report -------------------------------------------------------------------------------
const w = Math.max(...results.map((r) => r.name.length));
console.log('\n| # | check' + ' '.repeat(w - 5) + ' | result | detail');
console.log('|---|' + '-'.repeat(w + 2) + '|--------|-------');
results.forEach((r, n) => console.log(`| ${String(n + 1).padStart(2)} | ${r.name.padEnd(w)} | ${r.status.padEnd(6)} | ${r.detail}`));
const fails = results.filter((r) => r.status === 'FAIL').length;
const skips = results.filter((r) => r.status === 'SKIP').length;
console.log(`\n${results.length - fails - skips} passed, ${skips} skipped, ${fails} failed`);

await browser.close();
server?.kill();
process.exit(fails ? 1 : 0);
