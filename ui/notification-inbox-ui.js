const node = (tag, className, text) => {
  const element = document.createElement(tag); element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

const styles = `
.notification-inbox-dialog{width:min(780px,calc(100vw - 32px));height:min(760px,calc(100dvh - 32px));padding:0;border:1px solid var(--color-composer-ring);border-radius:16px;background:var(--color-raised);color:var(--color-ink);overflow:hidden;box-shadow:var(--shadow-lg)}
.notification-inbox-dialog::backdrop{background:rgb(18 16 14 / .35)}.notification-inbox-shell{display:grid;grid-template-rows:auto auto minmax(0,1fr);height:100%}
.notification-inbox-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid var(--color-composer-ring)}.notification-inbox-head h2{margin:0;font-size:18px}.notification-inbox-actions{display:flex;gap:8px}
.notification-inbox-dialog button{font:inherit;min-height:34px;padding:0 12px;border:1px solid var(--color-composer-ring);border-radius:10px;background:var(--color-raised);color:inherit;cursor:pointer}.notification-inbox-dialog button:hover{background:var(--color-raised-hover)}.notification-inbox-dialog button:disabled{opacity:.55;cursor:default}
.notification-inbox-dialog button:focus-visible,.notification-inbox-item.is-clickable:focus-visible{outline:2px solid var(--color-focus);outline-offset:2px}
.notification-inbox-tools{display:flex;align-items:center;gap:10px;padding:12px 20px;border-bottom:1px solid var(--color-composer-ring)}
.notification-inbox-seg{display:inline-flex;padding:3px;gap:2px;border:1px solid var(--color-hairline);border-radius:10px;background:var(--color-inset)}
.notification-inbox-dialog .notification-inbox-seg button{min-height:28px;padding:0 14px;border:0;border-radius:7px;background:transparent;color:var(--color-ink-secondary)}
.notification-inbox-dialog .notification-inbox-seg button:hover{background:var(--color-menu-hover);color:var(--color-ink)}
.notification-inbox-dialog .notification-inbox-seg button[aria-pressed=true]{background:var(--color-raised);color:var(--color-ink);font-weight:600;box-shadow:var(--shadow-sm, 0 1px 2px rgb(0 0 0 / .12))}
.notification-inbox-dialog .notification-inbox-refresh{display:inline-grid;place-items:center;width:32px;min-height:32px;padding:0;border-color:transparent;background:transparent;color:var(--color-ink-secondary);font-size:16px;line-height:1}
.notification-inbox-dialog .notification-inbox-refresh:hover{background:var(--color-menu-hover);color:var(--color-ink)}
.notification-inbox-refresh.is-spinning span{display:inline-block;animation:notification-inbox-spin .8s linear infinite}@keyframes notification-inbox-spin{to{transform:rotate(360deg)}}
.notification-inbox-count{margin-left:auto;font-size:12px;color:var(--color-ink-secondary)}
.notification-inbox-content{overflow:auto;padding:12px 20px 20px}.notification-inbox-status{margin:0 0 10px;font-size:12px;color:var(--color-ink-secondary)}.notification-inbox-status:empty{display:none}.notification-inbox-note{margin:0 0 14px;font-size:12px;color:var(--color-ink-tertiary)}
.notification-inbox-empty{padding:36px 8px;text-align:center;color:var(--color-ink-tertiary);font-size:13px}.notification-inbox-list{display:grid;gap:10px}
.notification-inbox-item{display:grid;gap:7px;padding:14px;border:1px solid var(--color-composer-ring);border-radius:12px;background:var(--color-app);transition:border-color .15s,background .15s}.notification-inbox-item.is-unread{border-color:var(--color-accent-border)}
.notification-inbox-item.is-clickable{cursor:pointer}.notification-inbox-item.is-clickable:hover{background:var(--color-raised-hover);border-color:var(--color-accent)}
.notification-inbox-jump{font-size:11px;color:var(--color-accent-text, var(--color-accent))}
.notification-inbox-item-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.notification-inbox-item-head h3{margin:0;font-size:14px}.notification-inbox-unread{flex:none;padding:1px 7px;border-radius:999px;background:var(--color-accent);color:var(--color-accent-ink);font-size:11px}
.notification-inbox-meta{display:flex;flex-wrap:wrap;gap:5px 12px;font-size:11px;color:var(--color-ink-secondary);overflow-wrap:anywhere}.notification-inbox-summary{margin:0;font-size:13px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}.notification-inbox-detail{margin:0;font-size:12px;color:var(--color-ink-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.notification-inbox-item-foot{display:flex;align-items:center;justify-content:space-between;gap:10px}.notification-inbox-item-foot:empty{display:none}.notification-inbox-waiting{font-size:11px;color:var(--color-warning)}.notification-inbox-waiting.is-resolved{color:var(--color-ink-tertiary)}.notification-inbox-read{flex:none;margin-left:auto}
@media(max-width:620px){.notification-inbox-head,.notification-inbox-tools,.notification-inbox-content{padding-left:14px;padding-right:14px}.notification-inbox-item-foot{align-items:flex-start;flex-direction:column}.notification-inbox-read{align-self:flex-end}}
`;
const categoryLabels = { completed: '任务完成', partial: '部分交付', failed: '执行失败', resource: '等待资源', takeover: '需要接管', 'proactive-reminder': '主动提醒' };
const relativeTime = value => {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return '';
  const diff = Date.now() - time;
  if (diff < 0) return new Date(time).toLocaleString();
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)} 天前`;
  return new Date(time).toLocaleString();
};

export function bindNotificationInbox({ api }) {
  const existing = document.getElementById('notificationInboxDialog');
  if (existing) return { open: () => existing.showModal(), refresh: () => existing.dispatchEvent(new Event('refresh')) };
  const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
  const trigger = document.getElementById('sharedNotificationsBtn');
  const dialog = node('dialog', 'notification-inbox-dialog'); dialog.id = 'notificationInboxDialog'; dialog.setAttribute('aria-label', '通知收件箱');
  dialog.innerHTML = `<div class="notification-inbox-shell"><header class="notification-inbox-head"><h2>通知</h2><div class="notification-inbox-actions"><button type="button" data-read-all>全部已读</button><button type="button" data-close>关闭</button></div></header>
    <div class="notification-inbox-tools"><div class="notification-inbox-seg" role="group" aria-label="筛选通知"><button type="button" data-filter="all" aria-pressed="true">全部</button><button type="button" data-filter="unread" aria-pressed="false">未读</button></div><button type="button" class="notification-inbox-refresh" data-refresh aria-label="刷新通知" title="刷新通知"><span aria-hidden="true">↻</span></button><span class="notification-inbox-count"></span></div>
    <div class="notification-inbox-content"><p class="notification-inbox-note">保留最近 500 条真实任务通知。免打扰不影响留档，这里不会重播系统通知。点击卡片可直达对应委托。</p><p class="notification-inbox-status" role="status"></p><div class="notification-inbox-list"></div></div></div>`;
  document.body.append(dialog);
  const list = dialog.querySelector('.notification-inbox-list'), status = dialog.querySelector('.notification-inbox-status'), note = dialog.querySelector('.notification-inbox-note');
  const countLabel = dialog.querySelector('.notification-inbox-count'), readAll = dialog.querySelector('[data-read-all]'), refreshBtn = dialog.querySelector('[data-refresh]');
  let rows = [], filter = 'all', version = 0, countVersion = 0, unreadCount = 0;
  const groupNames = new Map(), botNames = new Map();
  const badge = document.getElementById('notificationUnreadBadge');
  const setUnread = value => {
    unreadCount = Math.max(0, Number(value) || 0);
    if (badge) { badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount); badge.hidden = unreadCount === 0; }
    if (trigger) {
      trigger.setAttribute('aria-label', unreadCount ? `通知，${unreadCount} 条未读` : '通知');
      trigger.title = unreadCount ? `通知 · ${unreadCount} 条未读` : '通知';
    }
    countLabel.textContent = unreadCount ? `${unreadCount} 条未读` : '没有未读';
    readAll.disabled = unreadCount === 0;
  };
  const refreshCount = async () => {
    const ticket = ++countVersion;
    try {
      const data = await api('/api/native/notifications/unread-count');
      if (ticket === countVersion) setUnread(data.unreadCount);
    } catch { /* The next visible refresh retries without task or Chat side effects. */ }
  };
  // 只读拉取茶会与伙伴名字，用于把原始 ID 换成可读名称；失败时静默不显示。
  const loadNames = async () => {
    try {
      const data = await api('/api/dimension/groups');
      for (const group of Array.isArray(data?.groups) ? data.groups : []) if (group?.id && group.name) groupNames.set(group.id, group.name);
      for (const bot of Array.isArray(data?.bots) ? data.bots : []) if (bot?.id && bot.name) botNames.set(bot.id, bot.name);
    } catch { /* 名称只是锦上添花 */ }
  };
  const fullTime = value => { const time = new Date(value); return Number.isNaN(time.getTime()) ? '' : time.toLocaleString(); };
  const targetOf = row => {
    const runId = String(row.runId || '');
    if (runId.startsWith('rule:')) {
      const button = document.getElementById('sharedProactiveRemindersBtn');
      return button ? { label: '查看提醒规则 →', go: () => button.click() } : null;
    }
    if (!runId || (!row.botId && !row.groupId)) return null;
    return {
      label: '前往对应委托 →',
      go: () => window.dispatchEvent(new CustomEvent('dimension-global-search-open', { detail: { kind: 'work', runId, botId: row.botId || '', groupId: row.groupId || '' } })),
    };
  };
  const markRead = async row => {
    const result = await api('/api/native/notifications/read', { method: 'POST', body: JSON.stringify({ id: row.id }) });
    const current = rows.find(value => value.id === row.id); if (current) current.read = true;
    setUnread(result.unreadCount);
  };
  const activate = (row, target) => {
    if (!row.read) void markRead(row).catch(() => {});
    dialog.close();
    try { target.go(); } catch (error) { window.__dimensionToast?.(error.message || '无法打开对应内容。', { level: 'error' }); }
  };
  const paint = () => {
    const visible = rows.filter(row => filter === 'all' || !row.read);
    list.replaceChildren();
    for (const row of visible) {
      const target = targetOf(row);
      const item = node('article', `notification-inbox-item${row.read ? '' : ' is-unread'}${target ? ' is-clickable' : ''}`);
      item.dataset.notificationId = row.id;
      const category = categoryLabels[row.kind] || '任务通知';
      const title = String(row.title || '').trim() || category;
      const head = node('div', 'notification-inbox-item-head'); head.append(node('h3', '', title));
      if (!row.read) head.append(node('span', 'notification-inbox-unread', '未读'));
      item.append(head);
      const meta = node('div', 'notification-inbox-meta');
      if (title !== category) meta.append(node('span', '', category));
      const botName = row.botName || botNames.get(row.botId) || '';
      if (botName) meta.append(node('span', '', `伙伴：${botName}`));
      const groupName = row.groupName || groupNames.get(row.groupId) || '';
      if (groupName) meta.append(node('span', '', `茶会：${groupName}`));
      const rel = relativeTime(row.time);
      if (rel) { const time = node('time', '', rel); time.title = fullTime(row.time); time.dateTime = String(row.time || ''); meta.append(time); }
      if (meta.childNodes.length) item.append(meta);
      const summary = row.summary || row.detail || '';
      if (summary && summary !== title) item.append(node('p', 'notification-inbox-summary', summary));
      if (row.detail && row.detail !== row.summary && row.detail !== title) item.append(node('p', 'notification-inbox-detail', row.detail));
      const foot = node('div', 'notification-inbox-item-foot');
      if (row.waiting) foot.append(node('span', 'notification-inbox-waiting', '等待中'));
      else if (row.resolvedAt) foot.append(node('span', 'notification-inbox-waiting is-resolved', '等待已解除'));
      if (target) foot.append(node('span', 'notification-inbox-jump', target.label));
      if (!row.read) {
        const button = node('button', 'notification-inbox-read', '标记已读'); button.type = 'button';
        button.onclick = async event => {
          event.stopPropagation();
          button.disabled = true;
          try { await markRead(row); paint(); status.textContent = '已标记为已读。'; }
          catch (error) { status.textContent = error.message || '标记已读失败，请重试。'; button.disabled = false; }
        };
        button.addEventListener('keydown', event => event.stopPropagation());
        foot.append(button);
      }
      item.append(foot);
      if (target) {
        item.tabIndex = 0;
        item.setAttribute('aria-label', `${title}，${target.label.replace(' →', '')}`);
        item.addEventListener('click', event => { if (event.target.closest('button,a')) return; activate(row, target); });
        item.addEventListener('keydown', event => {
          if (event.target !== item) return;
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(row, target); }
        });
      }
      list.append(item);
    }
    if (!visible.length) list.append(node('p', 'notification-inbox-empty', rows.length ? '✦ 未读通知都处理完啦。' : '✦ 还没有任务通知，伙伴们完成委托后会在这里报到。'));
  };
  const load = async () => {
    const ticket = ++version; status.textContent = '正在读取通知…'; refreshBtn.classList.add('is-spinning');
    try {
      const [data] = await Promise.all([api('/api/native/notifications'), loadNames()]);
      if (ticket !== version) return;
      rows = Array.isArray(data.items) ? data.items : [];
      note.textContent = `保留最近 ${data.limit ?? 500} 条真实任务通知。免打扰不影响留档，这里不会重播系统通知。点击卡片可直达对应委托。`;
      setUnread(data.unreadCount); paint(); status.textContent = rows.length ? `共 ${data.total ?? rows.length} 条。` : '';
    } catch (error) { if (ticket === version) status.textContent = error.message || '通知读取失败，请重试。'; }
    finally { if (ticket === version) refreshBtn.classList.remove('is-spinning'); }
  };
  const open = () => { if (!dialog.open) dialog.showModal(); void load(); };
  trigger?.addEventListener('click', open);
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  refreshBtn.onclick = () => void load();
  dialog.addEventListener('refresh', () => void load());
  for (const button of dialog.querySelectorAll('[data-filter]')) button.onclick = () => {
    filter = button.dataset.filter;
    for (const current of dialog.querySelectorAll('[data-filter]')) current.setAttribute('aria-pressed', String(current === button));
    paint();
  };
  readAll.onclick = async () => {
    readAll.disabled = true;
    try {
      const result = await api('/api/native/notifications/read-all', { method: 'POST', body: '{}' });
      for (const row of rows) row.read = true;
      setUnread(result.unreadCount); paint(); status.textContent = '全部通知已标记为已读。';
    } catch (error) { status.textContent = error.message || '全部已读失败，请重试。'; readAll.disabled = false; }
  };
  dialog.addEventListener('close', () => { version++; refreshBtn.classList.remove('is-spinning'); });
  const timer = setInterval(() => { if (!document.hidden) void refreshCount(); }, 15000);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  setUnread(0); void refreshCount();
  return { open, refresh: load, refreshCount };
}
