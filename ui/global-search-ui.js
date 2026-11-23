const node = (tag, className, text) => {
  const element = document.createElement(tag); element.className = className;
  if (text !== undefined) element.textContent = text; return element;
};
const styles = `
.global-search-dialog{width:min(820px,calc(100vw - 32px));height:min(720px,calc(100dvh - 32px));padding:0;border:1px solid var(--color-composer-ring);border-radius:16px;background:var(--color-raised);color:var(--color-ink);overflow:hidden;box-shadow:var(--shadow-lg)}
.global-search-dialog::backdrop{background:rgb(18 16 14 / .35)}.global-search-shell{display:grid;grid-template-rows:auto auto minmax(0,1fr);height:100%}
.global-search-head{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--color-composer-ring)}.global-search-head h2{margin:0;font-size:18px}
.global-search-dialog button,.global-search-dialog input,.global-search-dialog select{font:inherit}.global-search-close{min-height:34px;padding:0 12px;border:1px solid var(--color-composer-ring);border-radius:10px;background:var(--color-raised);color:inherit;cursor:pointer}
.global-search-form{display:grid;grid-template-columns:minmax(0,1fr) 150px auto;gap:8px;padding:14px 20px;border-bottom:1px solid var(--color-composer-ring)}
.global-search-input,.global-search-type{height:38px;padding:0 11px;border:1px solid var(--color-composer-ring);border-radius:10px;background:var(--color-app);color:inherit}.global-search-input:focus-visible,.global-search-type:focus-visible{outline:2px solid var(--color-focus);outline-offset:1px}
.global-search-submit{border:0;border-radius:10px;background:var(--color-accent);color:var(--color-accent-ink);padding:0 16px;cursor:pointer}.global-search-submit:disabled{opacity:.6;cursor:default}
.global-search-results{overflow:auto;padding:12px 20px 20px}.global-search-status{margin:0 0 10px;font-size:12px;color:var(--color-ink-secondary)}
.global-search-hint{margin:0 0 10px;font-size:11px;color:var(--color-ink-tertiary)}.global-search-hint kbd{display:inline-block;min-width:16px;padding:0 4px;border:1px solid var(--color-hairline);border-radius:4px;background:var(--color-inset);font:inherit;font-size:10px;text-align:center}
.global-search-empty{padding:36px 8px;text-align:center;color:var(--color-ink-tertiary);font-size:13px}
.global-search-group{margin:0 0 14px}.global-search-group-title{display:flex;align-items:center;gap:6px;margin:0 0 6px;padding:0 2px;font-size:12px;font-weight:600;color:var(--color-ink-secondary)}.global-search-group-count{padding:0 6px;border-radius:999px;background:var(--color-inset);font-weight:500;font-size:11px;color:var(--color-ink-tertiary)}
.global-search-row{display:grid;width:100%;box-sizing:border-box;gap:5px;margin:0 0 8px;padding:12px 14px;text-align:left;border:1px solid var(--color-composer-ring);border-radius:12px;background:var(--color-app);color:inherit;cursor:pointer}
.global-search-row:hover{background:var(--color-raised-hover)}.global-search-row.is-active{border-color:var(--color-accent);background:var(--color-menu-hover);box-shadow:0 0 0 1px var(--color-accent) inset}
.global-search-meta{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center;font-size:11px;color:var(--color-ink-secondary)}.global-search-kind{padding:1px 6px;border-radius:6px;background:var(--color-control)}.global-search-time{margin-left:auto;color:var(--color-ink-tertiary)}
.global-search-title{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.global-search-snippet{font-size:12px;line-height:1.55;color:var(--color-ink-secondary);white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.global-search-snippet mark{background:var(--color-warning);color:var(--color-app);border-radius:2px;padding:0 1px}
.search-target-flash{outline:3px solid var(--color-accent)!important;outline-offset:3px;transition:outline-color .2s}.search-target-flash-in{animation:search-target-fade 2.4s ease-out}@keyframes search-target-fade{0%,65%{outline-color:var(--color-accent)}100%{outline-color:transparent}}
@media(max-width:620px){.global-search-form{grid-template-columns:1fr 110px}.global-search-submit{grid-column:1/-1;height:36px}.global-search-head,.global-search-form,.global-search-results{padding-left:14px;padding-right:14px}}
`;
const labels = { bot: '伙伴', group: '茶会', message: '会话', memory: '长期记忆', mid_memory: '中期记忆', work: '委托', artifact: '成果文件' };
const groupOrder = ['identity', 'conversation', 'work', 'artifact', 'memory'];
const groupLabels = { identity: '伙伴与茶会', conversation: '会话消息', work: '委托任务', artifact: '成果文件', memory: '记忆', other: '其他' };
const statusLabels = {
  completed: '已完成', partial: '部分交付', failed: '执行失败', running: '进行中', queued: '排队中', pending: '待处理', waiting: '等待中',
  cancelled: '已取消', canceled: '已取消', stopped: '已停止', interrupted: '已中断', active: '生效中', archived: '已归档', deleted: '已删除',
};
const readableStatus = value => {
  const text = String(value || '').trim(); if (!text) return '';
  if (statusLabels[text]) return statusLabels[text];
  return /^[\w\-.:]+$/.test(text) ? '' : text; // 未知的英文内部值不直接展示
};
const parseTime = row => {
  if (Number(row.timestamp) > 0) { const n = Number(row.timestamp); return n < 1e12 ? n * 1000 : n; }
  if (row.time) { const t = new Date(row.time).getTime(); if (Number.isFinite(t)) return t; }
  if (row.updatedAt) { const t = new Date(row.updatedAt).getTime(); if (Number.isFinite(t)) return t; }
  return 0;
};
const relativeTime = ms => {
  if (!ms) return '';
  const diff = Date.now() - ms, minute = 60000, hour = 3600000, day = 86400000;
  if (diff < 0) return new Date(ms).toLocaleString();
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return new Date(ms).toLocaleDateString();
};
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const splitTerms = query => [...new Set(String(query || '').split(/\s+/).map(item => item.trim()).filter(Boolean))].sort((a, b) => b.length - a.length).slice(0, 8);

export function bindGlobalSearch({ api }) {
  if (document.getElementById('globalSearchDialog')) return;
  const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
  const dialog = node('dialog', 'global-search-dialog'); dialog.id = 'globalSearchDialog'; dialog.setAttribute('aria-label', '全局搜索');
  dialog.innerHTML = `<div class="global-search-shell"><header class="global-search-head"><h2>全局搜索</h2><button type="button" class="global-search-close">关闭</button></header>
    <form class="global-search-form"><input class="global-search-input" maxlength="160" placeholder="搜索会话、记忆、委托和成果（空格分隔多个关键词）" aria-label="搜索内容" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="globalSearchListbox" autocomplete="off"><select class="global-search-type" aria-label="结果类型"><option value="all">全部类型</option><option value="identity">伙伴与茶会</option><option value="conversation">会话消息</option><option value="work">委托任务</option><option value="artifact">成果文件</option><option value="memory">记忆</option></select><button class="global-search-submit" type="submit">搜索</button></form>
    <div class="global-search-results"><p class="global-search-status" role="status">输入关键词即可自动搜索。Ctrl / ⌘ + K 可随时打开。</p><p class="global-search-hint"><kbd>↑</kbd> <kbd>↓</kbd> 选择结果 · <kbd>Enter</kbd> 打开 · <kbd>Esc</kbd> 关闭</p><div class="global-search-list" id="globalSearchListbox" role="listbox" aria-label="搜索结果"></div></div></div>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form'), input = dialog.querySelector('.global-search-input'), type = dialog.querySelector('.global-search-type'), list = dialog.querySelector('.global-search-list'), status = dialog.querySelector('.global-search-status'), submit = dialog.querySelector('.global-search-submit');
  const idleText = '输入关键词即可自动搜索。Ctrl / ⌘ + K 可随时打开。';
  let version = 0, controller, rows = [], options = [], activeIndex = -1, debounceTimer = 0, lastQuery = '', truncatedNote = '';
  const category = row => ['bot', 'group'].includes(row.kind) ? 'identity' : row.kind === 'message' ? 'conversation' : ['memory', 'mid_memory'].includes(row.kind) ? 'memory' : (groupLabels[row.kind] ? row.kind : 'other');
  const snippet = (text, query) => {
    const host = node('div', 'global-search-snippet'); let value = String(text || '');
    const terms = splitTerms(query);
    if (!terms.length) { host.textContent = value; return host; }
    const pattern = new RegExp(terms.map(escapeRegExp).join('|'), 'giu');
    if (value.length > 240) {
      pattern.lastIndex = 0; const first = pattern.exec(value); const start = first ? Math.max(0, first.index - 60) : 0;
      if (start > 0) value = '…' + value.slice(start);
    }
    pattern.lastIndex = 0; let offset = 0, count = 0, match;
    while ((match = pattern.exec(value)) && count < 40) {
      if (!match[0]) { pattern.lastIndex++; continue; }
      host.append(document.createTextNode(value.slice(offset, match.index)), node('mark', '', match[0]));
      offset = match.index + match[0].length; count++;
    }
    host.append(document.createTextNode(value.slice(offset))); return host;
  };
  const setActive = (index, scroll = true) => {
    if (!options.length) { activeIndex = -1; input.removeAttribute('aria-activedescendant'); return; }
    activeIndex = Math.max(-1, Math.min(options.length - 1, index));
    options.forEach((option, i) => { const on = i === activeIndex; option.classList.toggle('is-active', on); option.setAttribute('aria-selected', String(on)); });
    if (activeIndex < 0) { input.removeAttribute('aria-activedescendant'); return; }
    const current = options[activeIndex]; input.setAttribute('aria-activedescendant', current.id);
    if (scroll) current.scrollIntoView({ block: 'nearest' });
  };
  const openRow = row => { window.dispatchEvent(new CustomEvent('dimension-global-search-open', { detail: row })); dialog.close(); };
  const paint = () => {
    const query = lastQuery, selected = type.value, visible = rows.filter(row => selected === 'all' || category(row) === selected);
    list.replaceChildren(); options = []; activeIndex = -1; input.removeAttribute('aria-activedescendant');
    const buckets = new Map();
    for (const row of visible) { const key = category(row); if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(row); }
    const keys = [...buckets.keys()].sort((a, b) => (groupOrder.indexOf(a) + 1 || 99) - (groupOrder.indexOf(b) + 1 || 99));
    for (const key of keys) {
      const group = node('div', 'global-search-group'); group.setAttribute('role', 'group');
      const headingId = `globalSearchGroup-${key}`;
      const heading = node('div', 'global-search-group-title'); heading.id = headingId; heading.setAttribute('role', 'presentation');
      heading.append(node('span', '', groupLabels[key] || groupLabels.other), node('span', 'global-search-group-count', String(buckets.get(key).length)));
      group.setAttribute('aria-labelledby', headingId); group.append(heading);
      for (const row of buckets.get(key)) {
        const option = node('div', 'global-search-row'); option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false');
        option.id = `globalSearchOption-${options.length}`; option.tabIndex = -1;
        const meta = node('div', 'global-search-meta'); meta.append(node('span', 'global-search-kind', labels[row.kind] || '结果'));
        const state = readableStatus(row.state), runStatus = readableStatus(row.status);
        if (state) meta.append(node('span', '', state)); if (runStatus && runStatus !== state) meta.append(node('span', '', runStatus));
        const when = relativeTime(parseTime(row));
        if (when) { const time = node('time', 'global-search-time', when); const ms = parseTime(row); time.dateTime = new Date(ms).toISOString(); time.title = new Date(ms).toLocaleString(); meta.append(time); }
        option.append(meta);
        const title = row.kind === 'bot' || row.kind === 'group' ? (row.title || row.text) : row.title || row.botName || row.groupName;
        option.append(node('div', 'global-search-title', title || '未命名结果'));
        const scopeName = row.groupId ? (row.groupName || (row.kind === 'work' || row.kind === 'artifact' ? '' : row.title)) : row.botId ? (row.botName || (row.kind === 'work' || row.kind === 'artifact' ? '' : row.title)) : '';
        const scope = scopeName ? `${row.groupId ? '茶会' : '伙伴'}：${scopeName}` : '';
        if (scope && row.kind !== 'bot' && row.kind !== 'group' && scopeName !== title) option.append(node('div', 'global-search-meta', scope));
        option.append(snippet(row.text || row.artifact, query));
        const index = options.length;
        option.addEventListener('mousedown', event => event.preventDefault()); // 保持输入框焦点
        option.addEventListener('mousemove', () => { if (activeIndex !== index) setActive(index, false); });
        option.onclick = () => openRow(row);
        options.push(option); group.append(option);
      }
      list.append(group);
    }
    input.setAttribute('aria-expanded', String(options.length > 0));
    if (!visible.length) list.append(node('p', 'global-search-empty', rows.length ? '当前类型没有匹配结果。' : '✦ 没有找到匹配内容，换个关键词试试？'));
    status.textContent = (rows.length ? `找到 ${rows.length} 条结果${visible.length !== rows.length ? `，当前类型显示 ${visible.length} 条` : ''}。` : '没有找到匹配内容。') + truncatedNote;
  };
  const clearResults = () => {
    version++; controller?.abort(); rows = []; options = []; lastQuery = ''; truncatedNote = ''; activeIndex = -1;
    list.replaceChildren(); input.removeAttribute('aria-activedescendant'); input.setAttribute('aria-expanded', 'false');
    submit.disabled = false; status.textContent = idleText;
  };
  const search = async () => {
    clearTimeout(debounceTimer);
    const query = input.value.trim(); if (!query) { clearResults(); input.focus(); return; }
    const ticket = ++version; controller?.abort(); controller = new AbortController(); submit.disabled = true; status.textContent = '正在搜索…';
    try {
      const data = await api('/api/dimension/search?' + new URLSearchParams({ q: query, limit: '50' }), { signal: controller.signal });
      if (ticket !== version) return;
      rows = Array.isArray(data.results) ? data.results : []; lastQuery = query;
      truncatedNote = data.workTruncated ? ' 委托仅扫描最近 1000 条任务，较早成果可能未覆盖。' : '';
      paint();
    } catch (error) { if (ticket === version && error.name !== 'AbortError') status.textContent = error.message || '搜索失败，请重试。'; }
    finally { if (ticket === version) submit.disabled = false; }
  };
  const scheduleSearch = () => {
    clearTimeout(debounceTimer);
    if (!input.value.trim()) { clearResults(); return; }
    debounceTimer = setTimeout(() => { void search(); }, 200);
  };
  input.addEventListener('input', event => {
    if (event.isComposing) return;
    scheduleSearch();
  });
  input.addEventListener('compositionend', scheduleSearch);
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown') { if (!options.length) return; event.preventDefault(); setActive(activeIndex < options.length - 1 ? activeIndex + 1 : 0); }
    else if (event.key === 'ArrowUp') { if (!options.length) return; event.preventDefault(); setActive(activeIndex > 0 ? activeIndex - 1 : options.length - 1); }
    else if ((event.key === 'Home' || event.key === 'End') && activeIndex >= 0 && options.length) { event.preventDefault(); setActive(event.key === 'Home' ? 0 : options.length - 1); }
    else if (event.key === 'Enter') {
      // 已用方向键选中结果且关键词未变：打开结果；否则立即搜索（由 submit 处理）
      if (activeIndex >= 0 && options[activeIndex] && input.value.trim() === lastQuery) { event.preventDefault(); options[activeIndex].click(); }
    }
  });
  form.onsubmit = event => { event.preventDefault(); void search(); }; type.onchange = paint;
  const open = () => { if (!dialog.open) dialog.showModal(); input.focus(); input.select(); };
  dialog.querySelector('.global-search-close').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { clearTimeout(debounceTimer); version++; controller?.abort(); submit.disabled = false; });
  document.getElementById('sharedGlobalSearchBtn')?.addEventListener('click', open);
  document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') { event.preventDefault(); open(); } });
  window.__dimensionOpenGlobalSearch = open;
}
