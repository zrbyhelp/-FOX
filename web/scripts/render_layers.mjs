// Renders the Live2D-style layer art: web/public/models/fox_layers.glb -> web/public/live2d/
//   layers/<Name>.png + layers.json (placement in model units) + composite.png
// Run after `python tools/build.py --layers`.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '..');
const outDir = path.join(webDir, 'public', 'live2d');
const rig = JSON.parse(fs.readFileSync(path.join(outDir, 'rig.json'), 'utf8'));

const port = 5700 + Math.floor(Math.random() * 200);
const server = spawn(process.execPath, [path.join(webDir, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort'],
  { cwd: webDir, stdio: 'ignore', env: { ...process.env, FOX_NO_HMR: '1' } });
const base = `http://localhost:${port}/`;
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(base)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 250));
}
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 400, height: 400 }, deviceScaleFactor: 1 });
  const logs = [];
  page.on('pageerror', (e) => logs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
  await page.goto(`${base}layers.html`);
  await page.waitForFunction(() => window.__layersReady === true, null, { timeout: 180000 });
  const names = await page.evaluate(() => window.__layerNames);
  const missing = rig.order.filter((n) => !names.includes(n));
  if (missing.length) throw new Error('missing layers: ' + missing.join(', '));
  fs.mkdirSync(path.join(outDir, 'layers'), { recursive: true });
  const layers = [];
  for (const name of rig.order) {
    const r = await page.evaluate((n) => window.__renderLayer(n), name);
    fs.writeFileSync(path.join(outDir, 'layers', `${name}.png`), Buffer.from(r.dataUrl.split(',')[1], 'base64'));
    layers.push({ name, file: `layers/${name}.png`, x0: r.x0, y0: r.y0, w: r.w, h: r.h, px: r.px });
  }
  const all = await page.evaluate(() => window.__renderAll());
  fs.writeFileSync(path.join(outDir, 'composite.png'), Buffer.from(all.dataUrl.split(',')[1], 'base64'));
  const pxPerUnit = await page.evaluate(() => window.__pxPerUnit);
  fs.writeFileSync(path.join(outDir, 'layers.json'), JSON.stringify({ pxPerUnit, layers, composite: { x0: all.x0, y0: all.y0, w: all.w, h: all.h } }, null, 1));
  console.log(JSON.stringify({ layers: layers.length, errors: logs }));
} finally {
  await browser.close();
  server.kill();
}
