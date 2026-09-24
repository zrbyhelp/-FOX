// Playwright test of the 3D <-> 2D (Live2D-style) switch on the main page.
//
//   node scripts/mode_test.mjs [--query model=dev/m1.glb] [--url http://localhost:5173/]
//
// Checks: the page load pops the 3D fox in (+ Wave) with its logo; the toolbar switch shows the
// 2D puppet (popping in + waving the same way, the logo with it) and pauses the 3D scene; toolbar
// buttons, speech bubbles, the follow toggle and the keyboard drive the 2D fox; 离场 / 回来 take
// the 2D logo along; 跳舞 dances in 2D even when the 3D model has no Dance clip (and the button
// follows the mode); ?mode=2d starts in 2D; switching back resumes the 3D fox; no console errors.
// Screenshots -> ../build/snaps/mode/ (+ the 2D dance on the main page -> ../build/snaps/dance/).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '..');
const outDir = path.resolve(webDir, '../build/snaps/mode');
const danceDir = path.resolve(webDir, '../build/snaps/dance');
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(danceDir, { recursive: true });
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
    try { if ((await fetch(base)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(extra = '') {
  const page = await browser.newPage({ viewport: { width: 1100, height: 720 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  const q = ['quality=low', query, extra].filter(Boolean).join('&');
  await page.goto(`${base}?${q}`);
  await page.waitForFunction(() => window.__foxReady === true, null, { timeout: 180000 });
  return { page, errors };
}

const waitFor = (page, fn, arg, ms = 20000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);

try {
  // ---- switch from 3D ----------------------------------------------------------------------
  const { page, errors } = await open();
  record('starts in 3D', (await page.evaluate(() => window.__fox.mode)) === '3d');
  const intro = await page.evaluate(() => window.__fox.info());
  record('3D page load pops in + waves, logo with it', intro.state === 'Entering' && intro.presence === 'popIn' && intro.intent === 'Intro' && intro.clip !== 'Enter' && intro.logoPresence === 'in',
    `${intro.state}/${intro.clip}/${intro.intent} presence=${intro.presence} logo=${intro.logoPresence}`);
  const has3dDance = await page.evaluate(() => window.__fox.clips.includes('Dance'));
  const danceBtn = () => page.evaluate(() => {
    const b = document.querySelector('button[data-trigger="Dance"]');
    return b ? { label: b.textContent.trim(), disabled: b.disabled } : null;
  });
  const d3 = await danceBtn();
  record('3D: 跳舞 button, disabled iff the model has no Dance clip', d3 && d3.label === '跳舞' && d3.disabled === !has3dDance, `${JSON.stringify(d3)}, 3D model Dance=${has3dDance}`);
  const seg2d = page.locator('.mode-switch .seg[data-mode="2d"]');
  record('switch present', (await seg2d.count()) === 1);
  await seg2d.click();
  const shown = await waitFor(page, () => window.__fox.mode === '2d' && window.__fox.live2d?.state);
  record('2D shown after click', shown);
  const start2d = await page.evaluate(() => window.__fox.live2d.debug.info());
  record('2D start pops in + waves, logo with it', start2d.state === 'Entering' && start2d.clip === 'Wave' && start2d.intent === 'Intro' && ['in', 'shown'].includes(start2d.logoPresence),
    `${start2d.state}/${start2d.clip}/${start2d.intent} presence=${start2d.presence} logo=${start2d.logoPresence}`);
  await page.waitForFunction(() => window.__fox.live2d.state !== 'Entering', null, { timeout: 30000 }).catch(() => {});
  const vis = await page.evaluate(() => ({
    canvas3d: getComputedStyle(document.getElementById('stage')).visibility,
    stage2d: !document.querySelector('.stage2d').hidden,
    checked: document.querySelector('.mode-switch .seg[data-mode="2d"]').getAttribute('aria-checked'),
    url: location.search,
  }));
  record('3D canvas hidden, 2D stage visible', vis.canvas3d === 'hidden' && vis.stage2d, JSON.stringify(vis));
  record('switch state + URL', vis.checked === 'true' && vis.url.includes('mode=2d'));
  await sleep(1500);
  await page.screenshot({ path: path.join(outDir, '2d_after_switch.png') });

  // toolbar -> 2D fox, with the shared bubble
  await page.locator('button[data-trigger="Happy"]').click();
  const happy = await waitFor(page, () => window.__fox.live2d.clip === 'Happy');
  record('toolbar 开心 plays Happy in 2D', happy, await page.evaluate(() => window.__fox.live2d.clip));
  const bubble = await waitFor(page, () => {
    const b = document.querySelector('.bubble');
    return b && !b.hidden && b.textContent.includes('好开心');
  });
  record('speech bubble in 2D', bubble);
  const bubblePos = await page.evaluate(() => {
    const r = document.querySelector('.bubble-pop').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight };
  });
  record('bubble on screen', bubblePos.x >= 0 && bubblePos.y >= 0 && bubblePos.x + bubblePos.w <= bubblePos.vw && bubblePos.y + bubblePos.h <= bubblePos.vh, JSON.stringify(bubblePos));
  const active = await waitFor(page, () => document.querySelector('button[data-trigger="Happy"]').classList.contains('is-active'));
  record('toolbar highlights the 2D action', active);
  await sleep(600);
  await page.screenshot({ path: path.join(outDir, '2d_happy_bubble.png') });

  // toolbar 跳舞 -> the 2D Dance (enabled in 2D whatever the 3D model has), shared bubble,
  // highlighted; the rest of it in fixed steps -> back to Idle
  await page.waitForFunction(() => window.__fox.live2d.state === 'Idle', null, { timeout: 30000 }).catch(() => {});
  const d2 = await danceBtn();
  record('2D: 跳舞 enabled', d2 && !d2.disabled, JSON.stringify(d2));
  await page.locator('button[data-trigger="Dance"]').click();
  const dance = await waitFor(page, () => window.__fox.live2d.clip === 'Dance' && window.__fox.live2d.state === 'OneShot');
  record('toolbar 跳舞 plays Dance in 2D', dance, await page.evaluate(() => `${window.__fox.live2d.state}/${window.__fox.live2d.clip}`));
  const danceBubble = await waitFor(page, () => {
    const b = document.querySelector('.bubble');
    return b && !b.hidden && b.textContent.includes('一起跳舞吧~♪');
  });
  const danceActive = await waitFor(page, () => document.querySelector('button[data-trigger="Dance"]').classList.contains('is-active'));
  record('2D Dance: bubble 一起跳舞吧~♪ + 跳舞 highlighted', danceBubble && danceActive, `bubble=${danceBubble} active=${danceActive}`);
  const groove = await page.evaluate(() => {
    const d = window.__fox.live2d.debug;
    d.freeze(true);
    const t = d.player.current?.t ?? 0;
    if (t < 1.3) d.advance(1.3 - t); // mid-groove, the right paw up
    return { t, notes: d.info().notesShown };
  });
  await page.screenshot({ path: path.join(danceDir, '2d_dance_main_page.png') });
  const done = await page.evaluate(() => {
    const d = window.__fox.live2d.debug;
    const i = d.advance(5.2);
    d.freeze(false);
    return { state: i.state, clip: i.clip, notes: i.notesShown };
  });
  record('2D Dance -> back to Idle, notes popped', done.state === 'Idle' && done.clip === 'Idle' && done.notes >= 7, `${done.state}/${done.clip}, ${done.notes} notes (started ${groove.t.toFixed(2)} s in)`);
  const unlit = await waitFor(page, () => !document.querySelector('button[data-trigger="Dance"]').classList.contains('is-active'));
  record('跳舞 highlight cleared after the dance', unlit);

  // keyboard -> 2D typing (the 3D typing controller is paused)
  await page.waitForFunction(() => window.__fox.live2d.state === 'Idle', null, { timeout: 30000 }).catch(() => {});
  await page.mouse.click(5, 5);
  for (const k of ['KeyH', 'KeyE', 'KeyL', 'KeyL', 'KeyO']) {
    await page.keyboard.press(k);
    await sleep(120);
  }
  const typing2d = await waitFor(page, () => window.__fox.live2d.state === 'Typing');
  const typing3d = await page.evaluate(() => window.__fox.info().state);
  record('keys type in 2D only', typing2d && typing3d !== 'Typing', `2D ${await page.evaluate(() => window.__fox.live2d.state)} / 3D ${typing3d}`);
  await page.screenshot({ path: path.join(outDir, '2d_typing.png') });

  // presence button -> Exit / Enter in 2D
  await page.waitForFunction(() => window.__fox.live2d.state !== 'Typing', null, { timeout: 30000 }).catch(() => {});
  await page.locator('button[data-trigger="Presence"]').click();
  const leaving = await page.evaluate(() => { const i = window.__fox.live2d.debug.info(); return `${i.state}/${i.clip}/${i.intent}`; });
  record('离场 in 2D waves goodbye', leaving === 'Exiting/Wave/Exit', leaving);
  const away = await waitFor(page, () => window.__fox.live2d.state === 'Away', null, 30000);
  const awayInfo = await page.evaluate(() => window.__fox.live2d.debug.info());
  record('离场 -> Away in 2D, logo gone too', away && awayInfo.hidden && awayInfo.logoPresence === 'hidden' && !awayInfo.logoVisible, `${awayInfo.state} hidden=${awayInfo.hidden} logo=${awayInfo.logoPresence}`);
  await page.screenshot({ path: path.join(outDir, '2d_away.png') });
  const label = await page.locator('button[data-trigger="Presence"] .label').textContent();
  record('presence button reads 回来', label === '回来', label);
  await page.locator('button[data-trigger="Presence"]').click();
  const enter2d = await page.evaluate(() => window.__fox.live2d.debug.info());
  record('回来 -> pop in + Wave in 2D, logo with it', enter2d.state === 'Entering' && enter2d.clip === 'Wave' && enter2d.intent === 'Enter' && enter2d.presence === 'popIn' && enter2d.logoPresence === 'in',
    `${enter2d.state}/${enter2d.clip}/${enter2d.intent} presence=${enter2d.presence} logo=${enter2d.logoPresence}`);
  const back = await waitFor(page, () => ['Idle', 'OneShot'].includes(window.__fox.live2d.state) && window.__fox.live2d.debug.info().logoPresence === 'shown', null, 30000);
  record('回来 -> settles in 2D, logo back', back, await page.evaluate(() => window.__fox.live2d.state));

  // back to 3D
  await page.locator('.mode-switch .seg[data-mode="3d"]').click();
  const back3d = await waitFor(page, () => window.__fox.mode === '3d');
  const vis3 = await page.evaluate(() => ({
    canvas3d: getComputedStyle(document.getElementById('stage')).visibility,
    stage2d: !document.querySelector('.stage2d').hidden,
    url: location.search,
  }));
  record('back to 3D', back3d && vis3.canvas3d === 'visible' && !vis3.stage2d && !vis3.url.includes('mode=2d'), JSON.stringify(vis3));
  const t0 = await page.evaluate(() => window.__fox.info().time ?? performance.now());
  await sleep(1500);
  const loop = await page.evaluate(() => window.__fox.info());
  record('3D loop resumed', !!loop && loop.state !== undefined, `${loop.state}/${loop.clip}`);
  await page.locator('button[data-trigger="Heart"]').click();
  const heart3d = await waitFor(page, () => window.__fox.info().clip === 'Heart' || window.__fox.info().intent === 'Heart', null, 30000);
  record('toolbar drives 3D again', heart3d);
  const d3b = await danceBtn();
  record('back in 3D: 跳舞 follows the 3D model again', d3b && d3b.disabled === !has3dDance, `${JSON.stringify(d3b)}, 3D model Dance=${has3dDance}`);
  await sleep(1200);
  await page.screenshot({ path: path.join(outDir, '3d_after_switch_back.png') });
  record('no console errors (switch page)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.close();

  // ---- ?mode=2d start -----------------------------------------------------------------------
  const p2 = await open('mode=2d');
  record('?mode=2d starts in 2D', (await p2.page.evaluate(() => window.__fox.mode)) === '2d');
  const s2 = await p2.page.evaluate(() => window.__fox.live2d.debug.info());
  record('?mode=2d start pops in + waves', s2.state === 'Entering' && s2.clip === 'Wave' && s2.intent === 'Intro', `${s2.state}/${s2.clip}/${s2.intent} presence=${s2.presence}`);
  await sleep(2000);
  await p2.page.screenshot({ path: path.join(outDir, '2d_start.png') });
  record('no console errors (?mode=2d)', p2.errors.length === 0, p2.errors.slice(0, 3).join(' | '));
  await p2.page.close();
} finally {
  await browser.close();
  server?.kill();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} checks pass`);
process.exit(failed ? 1 : 0);
