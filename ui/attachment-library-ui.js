const node = (tag, className, text) => { const el = document.createElement(tag); el.className = className; if (text !== undefined) el.textContent = text; return el; };
const styles = `
.attachment-library-dialog{width:min(920px,calc(100vw - 32px));height:min(740px,calc(100dvh - 32px));padding:0;border:1px solid var(--color-composer-ring);border-radius:16px;background:var(--color-raised);color:var(--color-ink);overflow:hidden;box-shadow:var(--shadow-lg)}.attachment-library-dialog::backdrop{background:rgb(18 16 14 / .35)}
.attachment-library-shell{display:grid;grid-template-rows:auto auto minmax(0,1fr);height:100%}.attachment-library-head{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--color-composer-ring)}.attachment-library-head h2{margin:0;font-size:18px}
.attachment-library-toolbar{display:grid;grid-template-columns:minmax(0,1fr) 160px auto;gap:8px;padding:12px 20px;border-bottom:1px solid var(--color-composer-ring)}.attachment-library-toolbar input,.attachment-library-toolbar select{height:36px;padding:0 10px;border:1px solid var(--color-composer-ring);border-radius:10px;background:var(--color-app);color:inherit;font:inherit}
.attachment-library-dialog button{min-height:32px;padding:0 10px;border:1px solid var(--color-composer-ring);border-radius:9px;background:var(--color-raised);color:inherit;font:inherit;cursor:pointer}.attachment-library-dialog button:hover{background:var(--color-raised-hover)}.attachment-library-dialog button:disabled{opacity:.55;cursor:default}.attachment-library-dialog a{color:var(--color-accent-text, var(--color-accent));text-decoration:none;font-size:12px}
.attachment-library-dialog button:focus-visible,.attachment-library-dialog a:focus-visible,.attachment-library-toolbar input:focus-visible,.attachment-library-toolbar select:focus-visible{outline:2px solid var(--color-focus);outline-offset:1px}
.attachment-library-body{overflow:auto;padding:12px 20px 20px}.attachment-library-status{margin:0 0 10px;font-size:12px;color:var(--color-ink-secondary)}.attachment-library-note{margin:0 0 12px;font-size:11px;color:var(--color-ink-tertiary)}
.attachment-library-item{display:grid;grid-template-columns:minmax(0,1fr);gap:6px 12px;margin-bottom:9px;padding:12px 14px;border:1px solid var(--color-composer-ring);border-radius:12px;background:var(--color-app)}
.attachment-library-item.has-thumb{grid-template-columns:64px minmax(0,1fr)}.attachment-library-main{display:grid;gap:6px;min-width:0}
.attachment-library-thumb{display:block;width:64px;height:64px;border:1px solid var(--color-hairline);border-radius:10px;background:var(--color-inset);overflow:hidden}.attachment-library-thumb img{display:block;width:100%;height:100%;object-fit:cover}
.attachment-library-item-head{display:flex;align-items:center;gap:8px;min-width:0}.attachment-library-name{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.attachment-library-source{flex:none;padding:1px 6px;border-radius:6px;background:var(--color-control);font-size:11px;color:var(--color-ink-secondary)}
.attachment-library-meta,.attachment-library-path{font-size:11px;color:var(--color-ink-secondary);overflow-wrap:anywhere}.attachment-library-path{color:var(--color-ink-tertiary)}.attachment-library-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.attachment-library-unavailable{color:var(--color-danger);font-size:11px}
@media(max-width:650px){.attachment-library-toolbar{grid-template-columns:1fr 120px}.attachment-library-toolbar button{grid-column:1/-1}.attachment-library-head,.attachment-library-toolbar,.attachment-library-body{padding-left:14px;padding-right:14px}}
`;
const sourceLabels = { incoming: '项目收件夹', 'work-artifact': '委托成果' };
const scopeLabels = { 'Bot 项目 incoming': '伙伴项目收件夹', '任务成果': '委托成果' };
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif']);
const formatBytes = value => {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
};
const extensionOf = row => {
  const explicit = String(row.extension || '').toLowerCase();
  if (explicit) return explicit.startsWith('.') ? explicit : `.${explicit}`;
  const match = /\.[^./\\]+$/.exec(String(row.name || row.path || ''));
  return match ? match[0].toLowerCase() : '';
};
export function bindAttachmentLibrary({ api }) {
  if (document.getElementById('attachmentLibraryDialog')) return;
  const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
  const dialog = node('dialog', 'attachment-library-dialog'); dialog.id = 'attachmentLibraryDialog'; dialog.setAttribute('aria-label', '附件资料库');
  dialog.innerHTML = `<div class="attachment-library-shell"><header class="attachment-library-head"><h2>附件资料库</h2><button type="button" data-close>关闭</button></header>
    <div class="attachment-library-toolbar"><input type="search" maxlength="160" placeholder="按文件名、路径、委托或伙伴筛选" aria-label="筛选附件"><select aria-label="附件来源"><option value="all">全部来源</option><option value="incoming">伙伴项目收件夹</option><option value="work-artifact">委托成果</option></select><button type="button" data-refresh>刷新</button></div>
    <div class="attachment-library-body"><p class="attachment-library-status" role="status">打开后读取附件来源。</p><p class="attachment-library-note">只展示已有委托成果和各伙伴当前项目收件夹里的文件。复制路径后可在原权限范围内复用；不会自动共享给其他伙伴。</p><div class="attachment-library-list"></div></div></div>`;
  document.body.append(dialog);
  const input = dialog.querySelector('input'), select = dialog.querySelector('select'), list = dialog.querySelector('.attachment-library-list'), status = dialog.querySelector('.attachment-library-status'), refresh = dialog.querySelector('[data-refresh]');
  let rows = [], version = 0, truncatedNote = '';
  const safeHref = (raw) => {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (s.startsWith('/') && !s.startsWith('//')) return s;
    try {
      const u = new URL(s);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    } catch {}
    return '';
  };
  const paint = () => {
    const query = input.value.trim().toLocaleLowerCase(), source = select.value;
    const visible = rows.filter(row => (source === 'all' || row.source === source) && (!query || `${row.name} ${row.path} ${row.task} ${row.botName} ${row.groupName}`.toLocaleLowerCase().includes(query)));
    list.replaceChildren();
    for (const row of visible) {
      const item = node('article', 'attachment-library-item'), main = node('div', 'attachment-library-main'), head = node('div', 'attachment-library-item-head');
      const validUrl = safeHref(row.url);
      if (row.available && validUrl && imageExtensions.has(extensionOf(row))) {
        const thumb = node('a', 'attachment-library-thumb'); thumb.href = validUrl; thumb.target = '_blank'; thumb.rel = 'noopener noreferrer'; thumb.title = `查看「${row.name || '图片'}」`;
        const image = node('img', ''); image.src = validUrl; image.alt = row.name || '图片附件'; image.loading = 'lazy'; image.decoding = 'async';
        image.onerror = () => { thumb.remove(); item.classList.remove('has-thumb'); };
        thumb.append(image); item.append(thumb); item.classList.add('has-thumb');
      }
      head.append(node('span', 'attachment-library-name', row.name || '未命名附件'), node('span', 'attachment-library-source', sourceLabels[row.source] || '附件')); main.append(head);
      const ownerName = row.groupId ? row.groupName : row.botName;
      const metaParts = [];
      if (ownerName) metaParts.push(`${row.groupId ? '茶会' : '伙伴'}：${ownerName}`);
      const scope = scopeLabels[row.scope] || (row.scope && !/[a-z]{3,}/i.test(row.scope) ? row.scope : '');
      if (scope && scope !== sourceLabels[row.source]) metaParts.push(scope);
      const size = formatBytes(row.bytes); if (size) metaParts.push(size);
      if (metaParts.length) main.append(node('div', 'attachment-library-meta', metaParts.join(' · ')));
      if (row.task) main.append(node('div', 'attachment-library-meta', `委托：${row.task}`));
      if (row.path) main.append(node('div', 'attachment-library-path', row.path));
      const actions = node('div', 'attachment-library-actions');
      if (row.available && validUrl) {
        const open = node('a', '', '打开'); open.href = validUrl; open.target = '_blank'; open.rel = 'noopener noreferrer'; actions.append(open);
        const download = node('a', '', '下载'); download.href = validUrl + (validUrl.includes('?') ? '&' : '?') + 'download=1'; download.setAttribute('download', row.name || 'attachment'); actions.append(download);
      } else actions.append(node('span', 'attachment-library-unavailable', row.reason || '文件不可用'));
      const copy = node('button', '', '复制路径'); copy.type = 'button'; copy.onclick = async () => { try { await navigator.clipboard.writeText(row.path || ''); status.textContent = `已复制：${row.name}`; } catch { status.textContent = '无法写入剪贴板，请手动选择路径。'; } }; actions.append(copy);
      if (row.runId && (row.botId || row.groupId)) { const task = node('button', '', '查看原委托'); task.type = 'button'; task.onclick = () => { window.dispatchEvent(new CustomEvent('dimension-global-search-open', { detail: { kind: 'work', runId: row.runId, botId: row.botId, groupId: row.groupId } })); dialog.close(); }; actions.append(task); }
      main.append(actions); item.append(main); list.append(item);
    }
    if (!visible.length) list.append(node('p', 'attachment-library-status', rows.length ? '当前筛选下没有附件。' : '✦ 还没有可展示的附件。'));
    status.textContent = `显示 ${visible.length} / ${rows.length} 个附件。${truncatedNote}`;
  };
  const load = async () => {
    const ticket = ++version; refresh.disabled = true; status.textContent = '正在读取附件来源…';
    try { const data = await api('/api/dimension/attachments?limit=200'); if (ticket !== version) return; rows = Array.isArray(data.items) ? data.items : []; truncatedNote = data.truncated ? ' 结果已达到扫描上限。' : ''; paint(); }
    catch (error) { if (ticket === version) status.textContent = error.message || '附件读取失败。'; }
    finally { if (ticket === version) refresh.disabled = false; }
  };
  const open = () => { if (!dialog.open) dialog.showModal(); void load(); };
  input.oninput = paint; select.onchange = paint; refresh.onclick = () => void load();
  for (const button of dialog.querySelectorAll('[data-close]')) button.onclick = () => dialog.close();
  dialog.addEventListener('close', () => { version++; refresh.disabled = false; });
  document.getElementById('sharedAttachmentLibraryBtn')?.addEventListener('click', open);
}
