// Standalone page for the 2D fox (live2d.html): a minimal toolbar of its own for testing.
// URL parameters: ?debug=1 (window.__live2d, deterministic seed, preserveDrawingBuffer)
//                 ?noui=1  ?seed=N
import spec from '../../../spec.json';
import { createLive2DApp } from './app.js';

const params = new URLSearchParams(location.search);
const debug = params.get('debug') === '1';
const noUI = params.get('noui') === '1';

const ACTIONS = [
  ['打招呼', 'Wave'], ['开心', 'Happy'], ['比心', 'Heart'], ['摊手', 'Shrug'], ['指向Logo', 'Present'], ['够Logo', 'Reach'],
  ['跳跃', 'Jump'], ['坐下', 'Sit'], ['打盹', 'Doze'], ['回头', 'LookBack'], ['打字', 'Type'], ['离开', 'Exit'], ['回来', 'Enter'],
];

function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const c of children) e.append(c);
  return e;
}

function buildUI(app) {
  const buttons = ACTIONS.map(([label, name]) => {
    const b = el('button', { type: 'button', className: 'pill', textContent: label, disabled: !app.has(name) });
    b.dataset.trigger = name;
    b.addEventListener('click', () => app.request(name));
    return b;
  });
  const follow = el('button', { type: 'button', className: 'pill', textContent: '跟随鼠标' });
  follow.dataset.trigger = 'follow';
  follow.setAttribute('aria-pressed', 'true');
  follow.addEventListener('click', () => {
    const on = follow.getAttribute('aria-pressed') !== 'true';
    follow.setAttribute('aria-pressed', String(on));
    app.setLookEnabled(on);
  });
  const bar = el('div', { className: 'toolbar', role: 'toolbar', ariaLabel: '小狐狸动作' }, [...buttons, el('span', { className: 'sep' }), follow]);
  const hint = el('p', { className: 'hint', textContent: '点我互动 · 摸摸头 · 拖拖尾巴 · 敲键盘一起打字' });
  const dock = el('div', { className: 'dock' }, [hint, el('div', { className: 'bar-wrap' }, [bar])]);
  document.body.append(dock);
  return dock;
}

async function main() {
  const container = document.getElementById('stage2d');
  const app = await createLive2DApp({
    container,
    spec,
    debug,
    seed: debug ? Number(params.get('seed') || 1) : undefined,
  });
  let dock = null;
  if (!noUI) dock = buildUI(app);
  const layout = () => app.setInsetBottom(dock ? dock.getBoundingClientRect().height + 8 : 0);
  window.addEventListener('resize', layout);
  layout();
  app.start();
  document.querySelector('.loader')?.classList.add('hidden');
  if (debug) window.__createLive2DApp = createLive2DApp;
  window.__live2dReady = true;
}

main().catch((err) => {
  console.error(err);
  const l = document.querySelector('.loader');
  if (l) l.textContent = '无法启动 2D 小狐狸';
});
