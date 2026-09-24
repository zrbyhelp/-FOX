// Bottom toolbar (Chinese labels, grouped, inline SVG icons), hint text and loading indicator.

// 24x24 stroke icons (currentColor), drawn for this toolbar.
const ICONS = {
  wave: '<path d="M8 13V7.5a1.75 1.75 0 0 1 3.5 0V11"/><path d="M11.5 10.5V5.8a1.75 1.75 0 0 1 3.5 0v5"/><path d="M15 10.8V7.5a1.75 1.75 0 0 1 3.5 0v6.6a6.9 6.9 0 0 1-6.9 6.9h-.9a6.4 6.4 0 0 1-5.3-2.8l-2.6-3.9a1.7 1.7 0 0 1 2.8-2L8 14"/><path d="M3.6 7.2a4.8 4.8 0 0 1 1.9-3.1"/>',
  happy: '<circle cx="12" cy="12" r="9"/><path d="M7.8 10.2 9.3 8.7l1.5 1.5"/><path d="M13.2 10.2l1.5-1.5 1.5 1.5"/><path d="M8.2 14a4.4 4.4 0 0 0 7.6 0"/>',
  heart: '<path d="M12 20.2S4.2 15.6 4.2 9.6A4.1 4.1 0 0 1 12 7.3a4.1 4.1 0 0 1 7.8 2.3c0 6-7.8 10.6-7.8 10.6z"/>',
  shrug: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.6 2.3c-.7.3-1.2 1-1.2 1.8v.3"/><path d="M12 17.2h.01"/>',
  jump: '<path d="M12 15V4.5"/><path d="M8 8.3l4-3.8 4 3.8"/><path d="M5 19.5c2.4-1.6 4.7-1.6 7 0s4.6 1.6 7 0"/>',
  point: '<path d="M3.5 12h10"/><path d="M10 8l4 4-4 4"/><path d="M18.8 8.2c.3 2.5.8 3.2 2.7 3.8-1.9.6-2.4 1.3-2.7 3.8-.3-2.5-.8-3.2-2.7-3.8 1.9-.6 2.4-1.3 2.7-3.8z"/>',
  star: '<path d="M12 3c.6 5 1.9 6.3 7 7-5.1.7-6.4 2-7 7-.6-5-1.9-6.3-7-7 5.1-.7 6.4-2 7-7z"/><path d="M12 20.5v.5"/>',
  sit: '<path d="M7 3.5v10.5"/><path d="M7 11.5h10v2.5H7"/><path d="M8.5 14v6.5"/><path d="M15.5 14v6.5"/>',
  moon: '<path d="M19.5 14.6A7.8 7.8 0 1 1 9.4 4.5a6.2 6.2 0 0 0 10.1 10.1z"/><path d="M15 3.8h3.2L15 7.2h3.2"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="3"/><path d="M6.5 10h.01M9.8 10h.01M13.1 10h.01M16.4 10h.01M7.5 14h9"/>',
  exit: '<path d="M10 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20H10"/><path d="M15 8l4 4-4 4"/><path d="M19 12H9"/>',
  enter: '<path d="M14 4h3.5A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5H14"/><path d="M10 8l4 4-4 4"/><path d="M14 12H4"/>',
  eye: '<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>',
  reset: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/>',
};

const icon = (name) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

const GROUPS = [
  {
    name: '动作',
    items: [
      { id: 'Wave', label: '打招呼', icon: 'wave', tip: '挥挥手,打个招呼', needs: ['Wave'] },
      { id: 'Happy', label: '开心', icon: 'happy', tip: '眯眼笑,开心一下', needs: ['Happy'] },
      { id: 'Heart', label: '比心', icon: 'heart', tip: '用爪爪比个心', needs: ['Heart'] },
      { id: 'Shrug', label: '摊手', icon: 'shrug', tip: '摊摊手:唔…这个嘛', needs: ['Shrug'] },
      { id: 'Jump', label: '跳跃', icon: 'jump', tip: '原地蹦一下(也可以双击小狐狸)', needs: ['Jump'] },
    ],
  },
  {
    name: 'Logo',
    items: [
      { id: 'Present', label: '指向Logo', icon: 'point', tip: '看向并指向 Logo', needs: ['Present'] },
      { id: 'Reach', label: '够Logo', icon: 'star', tip: '踮起脚去够 Logo,Logo 会转起来', needs: ['Reach'] },
    ],
  },
  {
    name: '休息',
    items: [
      { id: 'Sit', label: '坐下', icon: 'sit', tip: '坐下来托腮想一想', needs: ['Sit_Think'] },
      { id: 'Doze', label: '打盹', icon: 'moon', tip: '坐着打个盹', needs: ['Sit_Doze'] },
    ],
  },
  {
    name: '新',
    badge: true,
    items: [
      { id: 'TypeDemo', label: '打字', icon: 'keyboard', tip: '陪你打字:直接敲键盘,或点这里看 3 秒演示', toggle: true },
      { id: 'Presence', label: '离场', icon: 'exit', tip: '挥手告别,离开画面' },
    ],
  },
];

// Animator state / intent -> the button whose action is playing.
function activeButton(s) {
  if (s.state === 'Exiting' || (s.state === 'Entering' && s.intent !== 'Intro')) return 'Presence';
  if (s.state === 'Typing' || s.typing) return 'TypeDemo';
  if (s.state === 'Sitting') return s.phase === 'doze' || s.clip === 'Sit_Doze' ? 'Doze' : 'Sit';
  if (s.state === 'OneShot') return s.intent;
  return null;
}

function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const c of children) e.append(c);
  return e;
}

function makeButton({ id, label, icon: ico, tip, className = 'pill' }) {
  const b = el('button', { type: 'button', className });
  b.dataset.trigger = id;
  b.innerHTML = `${icon(ico)}<span class="label"></span>`;
  b.querySelector('.label').textContent = label;
  if (tip) b.title = tip;
  return b;
}

/** Loading pill shown until the scene is ready. Returns { done(), fail(msg) }. */
export function createLoader() {
  const node = el('div', { className: 'loader', textContent: '小狐狸加载中…' });
  document.body.append(node);
  return {
    done() {
      node.classList.add('hidden');
      setTimeout(() => node.remove(), 600);
    },
    fail(msg) {
      node.classList.add('error');
      node.textContent = msg;
    },
  };
}

/**
 * @param {object} o
 * @param {(name:string)=>void} o.trigger
 * @param {(name:string)=>boolean} o.has
 * @param {(on:boolean)=>void} o.onFollow
 * @param {()=>void} o.onResetView
 * @returns {{ height: () => number, update: (s: object) => void }}
 */
export function createUI({ trigger, has, onFollow, onResetView }) {
  const buttons = new Map();
  const groups = GROUPS.map((g) => {
    const items = g.items.map((a) => {
      const b = makeButton(a);
      b.dataset.ok = String(!a.needs || a.needs.every(has));
      b.disabled = b.dataset.ok !== 'true';
      if (b.disabled) b.title = `${a.tip}(当前模型没有这个动作)`;
      if (a.toggle) b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => trigger(a.id));
      buttons.set(a.id, { b, a });
      return b;
    });
    const head = g.badge
      ? el('span', { className: 'gbadge', textContent: g.name, title: '新功能' })
      : el('span', { className: 'glabel', textContent: g.name });
    head.setAttribute('aria-hidden', 'true');
    const group = el('div', { className: 'group' }, [head, ...items]);
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', g.name === '新' ? '新功能' : g.name);
    return group;
  });

  const follow = makeButton({ id: 'follow', label: '跟随鼠标', icon: 'eye', tip: '头和视线跟随鼠标', className: 'pill toggle setting' });
  follow.setAttribute('aria-pressed', 'true');
  follow.setAttribute('aria-label', '跟随鼠标');
  follow.addEventListener('click', () => {
    const on = follow.getAttribute('aria-pressed') !== 'true';
    follow.setAttribute('aria-pressed', String(on));
    onFollow(on);
  });
  const reset = makeButton({ id: 'resetView', label: '重置视角', icon: 'reset', tip: '回到默认视角', className: 'pill ghost setting' });
  reset.setAttribute('aria-label', '重置视角');
  reset.addEventListener('click', onResetView);
  const settings = el('div', { className: 'group settings' }, [follow, reset]);
  settings.setAttribute('role', 'group');
  settings.setAttribute('aria-label', '设置');

  const parts = [];
  groups.forEach((g) => parts.push(g, el('span', { className: 'sep', ariaHidden: 'true' })));
  parts.push(settings);
  const bar = el('div', { className: 'toolbar', role: 'toolbar', ariaLabel: '小狐狸动作' }, parts);
  bar.setAttribute('aria-label', '小狐狸动作');
  const hint = el('p', { className: 'hint', textContent: '拖动旋转视角 · 点我互动 · 拖拖尾巴 · 敲键盘一起打字' });
  const dock = el('div', { className: 'dock' }, [hint, el('div', { className: 'bar-wrap' }, [bar])]);
  document.body.append(dock);

  // ---- live state ----
  let last = '';
  const presence = buttons.get('Presence').b;
  const typeBtn = buttons.get('TypeDemo').b;
  function update(s) {
    const away = s.state === 'Away' || s.state === 'Exiting';
    // The presence button names what is playing (离场 while leaving, 回来 while coming back),
    // otherwise what it will do.
    const back = s.state === 'Away' || (s.state === 'Entering' && s.intent !== 'Intro');
    const active = activeButton(s);
    const key = `${active}|${away}|${back}|${s.state}|${!!s.demo}|${!!s.typing}`;
    if (key === last) return;
    last = key;
    for (const [id, { b }] of buttons) {
      b.classList.toggle('is-active', id === active);
      if (id !== 'Presence') b.disabled = b.dataset.ok !== 'true' || away;
    }
    typeBtn.setAttribute('aria-pressed', String(!!(s.demo || s.typing)));
    presence.querySelector('.label').textContent = back ? '回来' : '离场';
    presence.querySelector('.ico').outerHTML = icon(back ? 'enter' : 'exit');
    presence.title = s.state === 'Away' ? '叫小狐狸回来' : s.state === 'Exiting' ? '正在离场…再点一下马上回来' : '挥手告别,离开画面';
    dock.classList.toggle('away', s.state === 'Away');
  }

  return { height: () => dock.getBoundingClientRect().height, update };
}
