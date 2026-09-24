// Bottom toolbar (Chinese labels), hint text and loading indicator.

const ACTIONS = [
  { label: '打招呼', trigger: 'Wave', needs: ['Wave'] },
  { label: '开心', trigger: 'Happy', needs: ['Happy'] },
  { label: '比心', trigger: 'Heart', needs: ['Heart'] },
  { label: '摊手', trigger: 'Shrug', needs: ['Shrug'] },
  { label: '指向Logo', trigger: 'Present', needs: ['Present'] },
  { label: '够Logo', trigger: 'Reach', needs: ['Reach'] },
  { label: '跳跃', trigger: 'Jump', needs: ['Jump'] },
  { label: '坐下', trigger: 'Sit', needs: ['Sit_Think'] },
  { label: '打盹', trigger: 'Doze', needs: ['Sit_Doze'] },
];

function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const c of children) e.append(c);
  return e;
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
 * @returns {{ height: () => number }}
 */
export function createUI({ trigger, has, onFollow, onResetView }) {
  const buttons = ACTIONS.map((a) => {
    const ok = a.needs.every(has);
    const b = el('button', { type: 'button', className: 'pill', textContent: a.label, disabled: !ok });
    b.dataset.trigger = a.trigger;
    if (!ok) b.title = '当前模型没有这个动作';
    b.addEventListener('click', () => trigger(a.trigger));
    return b;
  });

  const follow = el('button', { type: 'button', className: 'pill toggle', textContent: '跟随鼠标' });
  follow.dataset.trigger = 'follow';
  follow.setAttribute('aria-pressed', 'true');
  follow.addEventListener('click', () => {
    const on = follow.getAttribute('aria-pressed') !== 'true';
    follow.setAttribute('aria-pressed', String(on));
    onFollow(on);
  });

  const reset = el('button', { type: 'button', className: 'pill ghost', textContent: '重置视角' });
  reset.dataset.trigger = 'resetView';
  reset.addEventListener('click', onResetView);

  const bar = el('div', { className: 'toolbar', role: 'toolbar', ariaLabel: '小狐狸动作' }, [
    el('div', { className: 'group' }, buttons),
    el('span', { className: 'sep', ariaHidden: 'true' }),
    el('div', { className: 'group' }, [follow, reset]),
  ]);
  const hint = el('p', { className: 'hint', textContent: '拖动旋转视角 · 点我互动 · 摸摸头' });
  const dock = el('div', { className: 'dock' }, [hint, el('div', { className: 'bar-wrap' }, [bar])]);
  document.body.append(dock);

  return { height: () => dock.getBoundingClientRect().height };
}
