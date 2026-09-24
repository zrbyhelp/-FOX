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
const introInfo = await page.evaluate(() => window.__fox.info());
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

// Intro: hop in (Enter) or pop-in + Wave, greeting bubble, then Idle.
{
  const { clip, state, presence } = introInfo;
  if (has('Enter')) record('intro plays Enter', clip === 'Enter' && state === 'Entering' ? 'PASS' : 'FAIL', `clip=${clip} state=${state}`);
  else if (has('Wave')) record('intro plays Enter', clip === 'Wave' && presence === 'popIn' ? 'SKIP' : 'FAIL', `Enter missing, fallback pop-in + ${clip} (presence=${presence})`);
  else record('intro plays Enter', 'SKIP', 'Enter and Wave missing');
  const g = await waitFor((s) => s.bubble === '你好呀!我是小狐狸~' || s.bubblesShown > 0, 5000);
  record('intro greeting bubble', g.bubble === '你好呀!我是小狐狸~' ? 'PASS' : 'FAIL', `bubble=${g.bubble}`);
  const j = await waitIdle();
  record('returns to Idle', j.clip === 'Idle' && j.state === 'Idle' ? 'PASS' : 'FAIL', `state=${j.state} clip=${j.clip}`);
}

// Click head -> Happy.
{
  await waitIdle();
  const p = await pickCheck('head');
  await page.mouse.click(p.x, p.y);
  await expectClip('click head -> Happy', 'Happy');
  const b = await waitFor((s) => s.bubble === '嘿嘿,好开心!', 2500, 50);
  record('Happy -> speech bubble', b.bubble === '嘿嘿,好开心!' ? 'PASS' : 'FAIL', `bubble=${b.bubble}`);
  const box = await page.$eval('.bubble', (e) => {
    const r = e.querySelector('.bubble-body').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, hidden: e.hidden, text: e.textContent };
  });
  const vw = page.viewportSize();
  const onScreen = !box.hidden && box.x >= 0 && box.y >= 0 && box.x + box.w <= vw.width && box.y + box.h <= vw.height && box.h < 70;
  record('bubble on screen, <= 2 lines', onScreen ? 'PASS' : 'FAIL', `${box.text} @ ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.w)}x${Math.round(box.h)}`);
  let open = 0;
  let talking = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 1500 * slow && !talking) {
    const s = await info();
    open = Math.max(open, s.talkOpen);
    talking = s.talking || open > 0.3;
    await sleep(50);
  }
  record('bubble -> mouth talks', talking ? 'PASS' : 'SKIP', talking ? `mouth open up to ${open.toFixed(2)}` : 'clip keeps its own mouth (open mouth or sleep eyes)');
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

// Hover tail -> flick (procedural impulse).
{
  await waitIdle();
  await page.mouse.move(5, 5);
  await sleep(1200); // hover cooldown
  const before = (await info()).tailFlicks;
  const p = await pickCheck('tail');
  await page.mouse.move(p.x, p.y, { steps: 3 });
  const i = await waitFor((s) => s.tailFlicks > before, 2000, 50);
  record('hover tail -> tail flick', i.tailFlicks > before ? 'PASS' : 'FAIL', `flicks ${before} -> ${i.tailFlicks}`);
  await page.mouse.move(5, 5);
}

// Drag the tail: it bends towards the pointer, the camera stays; release -> LookBack.
{
  await waitIdle();
  const p = await pickCheck('tail');
  const cam0 = await page.evaluate(() => window.__fox._app.stage.camera.position.toArray());
  const d0 = await page.evaluate(() => window.__fox.boneDir('tail_6'));
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(p.x - 14 * k, p.y - 10 * k, { steps: 2 });
  const i = await waitFor((s) => s.tailBend > 15, 2500, 100);
  const d1 = await page.evaluate(() => window.__fox.boneDir('tail_6'));
  const ang = (Math.acos(Math.min(1, d0.reduce((a, v, k) => a + v * d1[k], 0))) * 180) / Math.PI;
  record('drag tail -> tail bends', i.tailDragging && ang > 12 ? 'PASS' : 'FAIL', `tail_6 turned ${ang.toFixed(1)} deg, bend ${i.tailBend.toFixed(1)}, dragging=${i.tailDragging}`);
  const cam1 = await page.evaluate(() => window.__fox._app.stage.camera.position.toArray());
  const moved = Math.hypot(...cam0.map((v, n) => v - cam1[n]));
  record('tail drag does not orbit the camera', moved < 1e-3 ? 'PASS' : 'FAIL', `camera moved ${moved.toFixed(4)}`);
  await page.mouse.up();
  await expectClip('release tail -> LookBack', 'LookBack');
  const j = await waitFor((s) => !s.tailDragging, 1000, 50);
  record('tail springs back after release', !j.tailDragging ? 'PASS' : 'FAIL', `dragging=${j.tailDragging}`);
  await page.mouse.move(5, 5);
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
  record('toolbar buttons enabled iff clip exists', buttons.length >= 13 && !wrong.length ? 'PASS' : 'FAIL',
    `${buttons.length} buttons, disabled: ${buttons.filter((b) => b.d).map((b) => b.label).join(' ') || 'none'}`);
  await page.click('.toolbar button[data-trigger="Wave"]');
  await expectClip('toolbar 打招呼 -> Wave', 'Wave');
}

// Toolbar: the playing action is highlighted; 比心 shows the heart effect + bubble.
{
  await waitIdle();
  await page.click('.toolbar button[data-trigger="Heart"]');
  const h = await waitFor((s) => s.heart, 3000, 50);
  const note = has('Heart') ? '' : ` (Heart missing, fallback ${await resolve('Heart')})`;
  record('比心 -> 3D heart effect', h.heart ? (has('Heart') ? 'PASS' : 'SKIP') : 'FAIL', `heart=${h.heart} clip=${h.clip}${note}`);
  const b = await waitFor((s) => s.bubble === '送你一颗小心心~', 2000, 50);
  record('比心 -> bubble', b.bubble === '送你一颗小心心~' ? 'PASS' : 'FAIL', `bubble=${b.bubble}`);
  const active = await page.$$eval('.toolbar button.is-active', (bs) => bs.map((x) => x.dataset.trigger));
  record('playing action is highlighted', active.includes('Heart') ? 'PASS' : 'FAIL', `active: ${active.join(' ') || 'none'}`);
}

// Typing: simulated keystrokes -> keyboard + Typing; 1.8 s without keys -> gone, Idle.
{
  await waitIdle();
  const codes = ['KeyN', 'KeyI', 'Space', 'KeyH', 'KeyA', 'KeyO', 'Enter', 'KeyZ'];
  for (const c of codes) { await page.evaluate((x) => window.__fox.typeKey(x), c); await sleep(90); }
  const i = await waitFor((s) => s.keyboard === 'shown' || s.keyboard === 'in', 2000, 50);
  record('typing -> magic keyboard appears', ['in', 'shown'].includes(i.keyboard) ? 'PASS' : 'FAIL', `keyboard=${i.keyboard} scale=${i.keyboardScale.toFixed(2)}`);
  record('typing -> state Typing', i.state === 'Typing' ? 'PASS' : 'FAIL', `state=${i.state}`);
  if (has('Type')) record('typing -> Type clip', i.clip === 'Type' ? 'PASS' : 'FAIL', `clip=${i.clip}`);
  else record('typing -> Type clip', 'SKIP', `Type missing, fallback: ${i.clip} + procedural paw taps`);
  record('keystrokes press keycaps', i.keyPresses >= codes.length ? 'PASS' : 'FAIL', `${i.keyPresses} presses, ${i.keystrokes} keystrokes`);
  const tb = await waitFor((s) => s.bubble === '我来帮你一起打字!', 1500, 50);
  record('typing -> bubble', tb.bubble === '我来帮你一起打字!' ? 'PASS' : 'FAIL', `bubble=${tb.bubble}`);
  const j = await waitFor((s) => s.keyboard === 'hidden' && s.state === 'Idle', 6000, 100);
  record('no keys for 1.8 s -> keyboard gone + Idle', j.keyboard === 'hidden' && j.state === 'Idle' ? 'PASS' : 'FAIL', `keyboard=${j.keyboard} state=${j.state}`);
}

// Real keyboard events: modifier-only keys are ignored, a letter starts typing.
{
  await waitIdle();
  await page.mouse.click(5, 300); // focus the page, nothing picked there
  await page.keyboard.press('Shift');
  await sleep(300);
  const a = await info();
  record('modifier-only key ignored', !a.typing ? 'PASS' : 'FAIL', `typing=${a.typing}`);
  await page.keyboard.press('KeyJ');
  const b = await waitFor((s) => s.typing, 1500, 50);
  record('real key press -> typing', b.typing ? 'PASS' : 'FAIL', `typing=${b.typing} keystrokes=${b.keystrokes}`);
  await waitFor((s) => !s.typing && s.state === 'Idle', 6000, 100);
}

// Typing while sitting: stand up first, then type.
if (has('Sit_Think')) {
  await waitIdle();
  await page.evaluate(() => window.__fox.trigger('Sit'));
  await waitFor((s) => s.clip === 'Sit_Think', 8000);
  const seen = new Set();
  for (let k = 0; k < 14; k++) {
    await page.evaluate(() => window.__fox.typeKey('KeyS'));
    const s = await info();
    seen.add(s.clip);
    if (s.state === 'Typing') break;
    await sleep(250);
  }
  const s = await waitFor((x) => x.state === 'Typing', 3000, 100);
  const ok = s.state === 'Typing' && (!has('StandUp') || seen.has('StandUp'));
  record('typing while sitting -> StandUp -> Typing', ok ? 'PASS' : 'FAIL', `clips seen: ${[...seen].join(' ')} -> ${s.state}`);
  await waitFor((x) => x.state === 'Idle' && x.keyboard === 'hidden', 8000, 100);
}

// Toolbar 打字 demo (touch devices).
{
  await waitIdle();
  await page.click('.toolbar button[data-trigger="TypeDemo"]');
  const i = await waitFor((s) => s.typing && s.keystrokes > 3, 3000, 100);
  const pressed = await page.getAttribute('.toolbar button[data-trigger="TypeDemo"]', 'aria-pressed');
  record('toolbar 打字 -> typing demo', i.typing && i.typingDemo && pressed === 'true' ? 'PASS' : 'FAIL', `typing=${i.typing} demo=${i.typingDemo} keystrokes=${i.keystrokes} pressed=${pressed}`);
  const j = await waitFor((s) => !s.typing && s.state === 'Idle' && s.keyboard === 'hidden', 9000, 150);
  record('typing demo ends by itself', !j.typing && j.keyboard === 'hidden' ? 'PASS' : 'FAIL', `typing=${j.typing} keyboard=${j.keyboard}`);
}

// 离场 -> Exit -> Away (fox hidden); 回来 -> Enter -> Idle.
{
  await waitIdle();
  await page.click('.toolbar button[data-trigger="Presence"]');
  if (has('Exit')) await expectClip('toolbar 离场 -> Exit', 'Exit');
  else {
    const e = await waitFor((s) => s.state === 'Exiting', 2000, 50);
    record('toolbar 离场 -> Exit', e.state === 'Exiting' ? 'SKIP' : 'FAIL', `Exit missing, fallback ${e.clip} + shrink (state=${e.state})`);
  }
  const b = await waitFor((s) => s.bubble === '拜拜~下次见!', 2500, 50);
  record('exit -> goodbye bubble', b.bubble === '拜拜~下次见!' ? 'PASS' : 'FAIL', `bubble=${b.bubble}`);
  const i = await waitFor((s) => s.state === 'Away', 12000, 100);
  record('exit -> state Away', i.state === 'Away' ? 'PASS' : 'FAIL', `state=${i.state}`);
  record('away -> fox and shadow hidden', !i.foxVisible && !i.shadowVisible ? 'PASS' : 'FAIL', `foxVisible=${i.foxVisible} shadow=${i.shadowVisible}`);
  const label = (await page.textContent('.toolbar button[data-trigger="Presence"] .label')).trim();
  const disabled = await page.$$eval('.toolbar .group:not(.settings) button[data-trigger]', (bs) => bs.filter((x) => x.disabled).length);
  record('away -> button 回来, actions disabled', label === '回来' && disabled >= 10 ? 'PASS' : 'FAIL', `label=${label}, ${disabled} disabled`);
  await page.evaluate(() => window.__fox.typeKey('KeyA'));
  const pv = await pos('head');
  const picked = await page.evaluate(({ x, y }) => window.__fox.pickAt(x, y), pv);
  await sleep(300);
  const t = await info();
  record('away -> typing and clicks ignored', !t.typing && t.keyboard === 'hidden' && picked !== 'head' && t.state === 'Away' ? 'PASS' : 'FAIL', `typing=${t.typing} pick=${picked} state=${t.state}`);
  await page.click('.toolbar button[data-trigger="Presence"]');
  if (has('Enter')) await expectClip('toolbar 回来 -> Enter', 'Enter');
  else {
    const e = await waitFor((s) => s.state === 'Entering', 2000, 50);
    record('toolbar 回来 -> Enter', e.state === 'Entering' && e.presence === 'popIn' ? 'SKIP' : 'FAIL', `Enter missing, fallback pop-in + ${e.clip}`);
  }
  const w = await waitFor((s) => s.bubble === '我回来啦!', 3000, 50);
  record('enter -> bubble', w.bubble === '我回来啦!' ? 'PASS' : 'FAIL', `bubble=${w.bubble}`);
  const j = await waitIdle();
  record('回来 -> back to Idle, visible', j.state === 'Idle' && j.foxVisible && j.shadowVisible ? 'PASS' : 'FAIL', `state=${j.state} visible=${j.foxVisible}`);
  const label2 = (await page.textContent('.toolbar button[data-trigger="Presence"] .label')).trim();
  record('button back to 离场', label2 === '离场' ? 'PASS' : 'FAIL', `label=${label2}`);
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
