// Batch screenshots of the fox viewer via headless Chromium (SwiftShader WebGL).
//
//   node scripts/snap.mjs                      # preset "refs"
//   node scripts/snap.mjs refs turntable tail  # several presets
//   node scripts/snap.mjs --shots shots.json   # custom [{name, clip, t, cam}]
//   node scripts/snap.mjs --out ../build/snaps --size 800
//   node scripts/snap.mjs refs --query model=dev/m1.glb --out ../build/snaps/m1
//
// All shots are taken in ONE page load (shader compile under SwiftShader is slow).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '..');
const spec = JSON.parse(fs.readFileSync(path.resolve(webDir, '../spec.json'), 'utf8'));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const outDir = path.resolve(webDir, opt('--out', '../build/snaps'));
const size = Number(opt('--size', '800'));
const shotsFile = opt('--shots', null);
const url = opt('--url', null);
const query = opt('--query', ''); // e.g. "model=dev/m1.glb"
const presets = args.length ? args : ['refs'];

const refTimes = { Happy: 1.0, Wave: 0.9, Present: 1.2, Sit_Think: 1.0, Reach: 1.2, Shrug: 1.0, Heart: 1.2, Sit_Doze: 1.0 };
const refNum = { Happy: 1, Wave: 2, Present: 3, Sit_Think: 4, Reach: 5, Shrug: 6, Heart: 7, Sit_Doze: 8 };

function preset(name, clips) {
  switch (name) {
    case 'refs':
      return Object.entries(refTimes).map(([clip, t]) => ({ name: `ref${refNum[clip]}_${clip}`, clip, t, cam: 'ref34' }));
    case 'turntable':
      return ['ref34', 'front', 'side', 'back34', 'top'].map((cam) => ({ name: `turn_${cam}`, clip: 'Idle', t: 0, cam }));
    case 'tail':
      return ['ref34', 'side', 'top', 'back34'].map((cam) => ({ name: `tail_${cam}`, clip: 'Idle', t: 0, cam }));
    case 'face':
      return ['Idle', 'Happy', 'Wave', 'Shrug', 'Sit_Doze'].map((clip) => ({ name: `face_${clip}`, clip, t: refTimes[clip] ?? 0.5, cam: 'closeup' }));
    case 'extremes': {
      const out = [];
      for (const clip of clips) for (const t of [0.25, 0.5, 0.75]) for (const cam of ['ref34', 'side', 'back34'])
        out.push({ name: `x_${clip}_${Math.round(t * 100)}_${cam}`, clip, tNorm: t, cam });
      return out;
    }
    case 'strips': {
      const out = [];
      for (const clip of clips) for (let i = 0; i < 8; i++) out.push({ name: `s_${clip}_${i}`, clip, tNorm: i / 8, cam: 'ref34' });
      return out;
    }
    default:
      throw new Error('unknown preset ' + name);
  }
}

let server = null;
let base = url;
if (!base) {
  const port = 5300 + Math.floor(Math.random() * 400);
  server = spawn('npx', ['vite', '--port', String(port), '--strictPort'], { cwd: webDir, stdio: 'ignore' });
  base = `http://localhost:${port}/`;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) logs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
const sep = base.includes('?') ? '&' : '?';
await page.goto(`${base}${sep}debug=1&noui=1${query ? '&' + query : ''}`);
await page.waitForFunction(() => window.__foxReady === true, null, { timeout: 180000 });
const clipInfo = await page.evaluate(() => window.__fox.clipInfo ? window.__fox.clipInfo() : window.__fox.clips.map((n) => ({ name: n, duration: 1 })));
const clips = clipInfo.map((c) => c.name);
const dur = Object.fromEntries(clipInfo.map((c) => [c.name, c.duration]));

let shots = [];
if (shotsFile) shots = JSON.parse(fs.readFileSync(shotsFile, 'utf8'));
else for (const p of presets) shots.push(...preset(p, clips));

fs.mkdirSync(outDir, { recursive: true });
const done = [];
for (const s of shots) {
  if (s.clip && !clips.includes(s.clip)) { logs.push(`skip ${s.name}: clip ${s.clip} missing`); continue; }
  const t = s.tNorm != null ? s.tNorm * (dur[s.clip] ?? 1) : s.t ?? 0;
  await page.evaluate((o) => window.__fox.pose(o), { clip: s.clip, t, cam: s.cam, seed: 1, logo: s.logo });
  const file = path.join(outDir, `${s.name}.png`);
  await page.screenshot({ path: file });
  done.push(file);
}
console.log(JSON.stringify({ outDir, count: done.length, clips, logs }, null, 1));
await browser.close();
server?.kill();
