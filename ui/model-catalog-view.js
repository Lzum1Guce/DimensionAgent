const LEVELS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const LABELS = ['默认', '低', '中', '高', '超高', '最高'];
const HIDDEN = 'dimension.hiddenModelFamilies.v1';
const metadata = new WeakMap();

export function apiEffortLevels(id) {
  return /(?:^|\/)(?:gpt-5(?:[.\-]|$)|o[134](?:-|$))/i.test(id) && !/chat-latest/i.test(id)
    ? LEVELS.slice(0, 4) : [];
}

export function effortLevels(engine) {
  if (engine === 'antigravity') return LEVELS;
  if (engine === 'codex') return LEVELS.slice(0, 5);
  if (['hermes', 'deepseek-harness'].includes(engine)) return LEVELS.slice(0, 4);
  return [];
}

export function effortSlider(levels, value, onChange) {
  const label = document.createElement('label');
  label.className = 'model-effort-slider';
  const range = document.createElement('input');
  range.type = 'range';
  range.setAttribute('aria-label', '思考等级');
  range.min = '0';
  range.max = String(levels.length - 1);
  range.value = String(Math.max(0, levels.indexOf(value)));
  const output = document.createElement('output');
  const update = () => {
    const text = LABELS[LEVELS.indexOf(levels[Number(range.value)])];
    output.textContent = text;
    range.setAttribute('aria-valuetext', text);
  };
  range.oninput = update;
  range.onchange = () => { update(); onChange(levels[Number(range.value)]); };
  update();
  const heading = document.createElement('span');
  heading.className = 'model-effort-heading';
  heading.append('思考等级', output);
  const rail = document.createElement('span');
  rail.className = 'model-effort-rail';
  const ticks = document.createElement('span');
  ticks.className = 'model-effort-ticks';
  ticks.setAttribute('aria-hidden', 'true');
  for (const level of levels) ticks.append(document.createElement('i'));
  rail.append(ticks, range);
  label.append(heading, rail);
  return label;
}

export function modelChoice(element, config) {
  element.dataset.modelChoice = "";
  metadata.set(element, config);
  return element;
}

function button(text, action) {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = text;
  el.onclick = event => { event.stopPropagation(); action(); };
  return el;
}

function storedHidden() {
  try { return new Set(JSON.parse(localStorage.getItem(HIDDEN)) || []); }
  catch { return new Set(); }
}

// Compare numeric revisions within a family. Unrelated families retain provider order.
function recentFirst(groups) {
  const families = new Map();
  for (const group of groups) {
    const family = group.base.toLowerCase().replace(/\d+(?:[.-]\d+)*/g, '#');
    if (!families.has(family)) families.set(family, []);
    families.get(family).push(group);
  }
  for (const rows of families.values()) rows.sort((a,b) => b.base.localeCompare(a.base, 'en', {numeric:true}));
  const result = [];
  let active = [...families.values()];
  for (let i = 0; active.length; ++i) {
    for (const rows of active) result.push(rows[i]);
    active = active.filter(rows => rows.length > i + 1);
  }
  return result;
}

export function arrangeModels(container, {search = false} = {}) {
  const groups = new Map();
  const candidates = Array.from(container.querySelectorAll('[data-model-choice]'),
    element => ({element, row:metadata.get(element)})).filter(item => item.row?.id);
  const tierPattern = /^(.*?)[-:](low|medium|high|xhigh|max)$/i;
  const tiersByBase = new Map();
  for (const {row} of candidates) {
    const match = tierPattern.exec(row.id);
    if (!match) continue;
    const key = JSON.stringify([row.scope, match[1]]);
    if (!tiersByBase.has(key)) tiersByBase.set(key, new Set());
    tiersByBase.get(key).add(match[2].toLowerCase());
  }
  for (const {element, row} of candidates) {
    let match = tierPattern.exec(row.id);
    // A standalone name such as qwen3-max can be a distinct product.
    if (match && row.engine !== 'antigravity' &&
        tiersByBase.get(JSON.stringify([row.scope, match[1]])).size < 2) match = null;
    const base = match ? match[1] : row.id;
    const key = JSON.stringify([row.scope, base]);
    let group = groups.get(key);
    if (!group) {
      group = {base, key, scope:row.scope, entries:[], element};
      groups.set(key, group);
    }
    group.entries.push({...row, element, tier:match?.[2].toLowerCase() || ''});
  }
  if (!groups.size) return;
  const hidden = storedHidden();
  let expanded = false;
  let editor;
  const controls = document.createElement('div');
  controls.className = 'model-list-controls';
  const manage = button('管理模型', () => { expanded = !expanded; update(); });
  controls.append(manage);
  container.append(controls);
  const scopes = new Map();
  for (const group of groups.values()) {
    if (!scopes.has(group.scope)) scopes.set(group.scope, []);
    scopes.get(group.scope).push(group);
    const current = group.entries.find(item => item.selected) || group.entries.find(item => !item.tier) || group.entries[0];
    const el = current.element;
    group.element = el;
    for (const item of group.entries) if (item !== current) item.element.remove();
    const encoded = group.entries.some(item => item.tier);
    if (encoded) {
      const label = el.querySelector('.hcp-model-name,.cli-rec-model-label,.model-option-name,.base-model-label');
      if (label) label.textContent = group.base;
    }
    const levels = encoded ? LEVELS.filter(level => group.entries.some(item => item.tier === level)) : current.levels || [];
    if (levels.length && current.apply) {
      el.addEventListener('click', event => {
        if (event.target.closest('.hcp-star-btn')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        editor?.remove();
        editor = document.createElement('div');
        editor.className = 'model-effort-editor';
        let level = encoded ? current.tier : (levels.includes(current.effort) ? current.effort : levels[0]);
        if (levels.length > 1) editor.append(effortSlider(levels, level, next => { level = next; }));
        else editor.append('思考等级 · ' + LABELS[LEVELS.indexOf(level)]);
        editor.append(button('应用', () => {
          const item = encoded ? group.entries.find(entry => entry.tier === level) : current;
          item.apply(encoded ? '' : level);
          editor?.remove();
        }));
        el.after(editor);
      }, true);
    }
    const toggle = button('', () => {
      if (hidden.has(group.key)) hidden.delete(group.key);
      else hidden.add(group.key);
      try { localStorage.setItem(HIDDEN, JSON.stringify([...hidden])); } catch {}
      update();
    });
    toggle.className = 'model-hide-toggle';
    toggle.setAttribute('aria-label', '切换显示 ' + group.base);
    group.toggle = toggle;
    el.after(toggle);
  }
  const sections = [...scopes.values()].map(recentFirst);
  // Rank within each contiguous provider section while retaining its heading.
  const owners = new Map();
  const ranks = new Map();
  const parents = new Set();
  for (const section of sections) {
    section.forEach((group, rank) => {
      owners.set(group.element, group);
      ranks.set(group, rank);
      parents.add(group.element.parentElement);
    });
  }
  for (const parent of parents) {
    const segments = [];
    let segment;
    for (const child of parent.children) {
      const group = owners.get(child);
      if (group) {
        if (!segment || group.scope !== segment[0].scope) {
          segment = [];
          segments.push(segment);
        }
        segment.push(group);
      } else if (!child.classList.contains('model-hide-toggle')) {
        segment = null;
      }
    }
    for (const rows of segments) {
      const marker = document.createComment('models');
      rows[0].element.before(marker);
      rows.sort((a, b) => ranks.get(a) - ranks.get(b));
      for (const group of rows) marker.before(group.element, group.toggle);
      marker.remove();
    }
  }
  function update() {
    editor?.remove();
    manage.textContent = expanded ? '完成管理' : '显示全部 / 隐藏';
    manage.setAttribute('aria-expanded', String(expanded));
    for (const section of sections) {
      let visible = 0;
      for (const group of section) {
        const manuallyHidden = hidden.has(group.key);
        const keep = group.entries.some(row => row.selected || row.favorite);
        const show = expanded || (!manuallyHidden && (search || visible < 4 || keep));
        if (!manuallyHidden && show) ++visible;
        group.element.hidden = !show;
        group.toggle.hidden = !expanded;
        group.toggle.textContent = manuallyHidden ? '恢复 ' + group.base : '隐藏 ' + group.base;
      }
    }
  }
  update();
}
