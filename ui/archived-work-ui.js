// Imported Work messages are a read-only archive, separate from runnable tasks.
export function bindArchivedWork() {
  const dialog = document.createElement('dialog');
  dialog.id = 'archivedWorkDialog'; dialog.className = 'work-model-dialog archived-work-dialog';
  dialog.setAttribute('aria-labelledby', 'archivedWorkTitle');
  dialog.innerHTML = '<header><h2 id="archivedWorkTitle">历程</h2><button type="button" id="archivedWorkClose">关闭</button></header>'
    + '<p id="archivedWorkBot"></p><p class="archived-work-explanation">从归档导入的 Work 会话文字，仅供查看。这里保留原要求、补充要求与回复，不会启动或续接任务。</p>'
    + '<button type="button" id="archivedWorkMore" hidden>加载更早的记录</button><div id="archivedWorkMessages" class="archived-work-messages"></div>'
    + '<p id="archivedWorkStatus" role="status" aria-live="polite"></p>';
  document.body.append(dialog);
  const el = id => dialog.querySelector('#' + id);
  let generation = 0, bot = null, before = null, busy = false, hasMore = false;
  const seen = new Set();
  function controls() { el('archivedWorkMore').hidden = !hasMore; el('archivedWorkMore').disabled = busy; }
  function row(message) {
    const item = document.createElement('article'); item.className = 'archived-work-message'; item.dataset.messageId = message.messageId;
    const header = document.createElement('header'), author = document.createElement('strong'), time = document.createElement('time');
    author.textContent = message.actor === 'user' ? '用户' : message.actor === 'system' ? '系统' : String(bot.name || 'Bot');
    const milliseconds = Number(message.createdAtMs), date = new Date(milliseconds);
    time.textContent = Number.isSafeInteger(milliseconds) && !Number.isNaN(date.getTime()) ? date.toLocaleString() : '时间未提供';
    header.append(author, time);
    const content = document.createElement('p'); content.textContent = message.text;
    item.append(header, content); return item;
  }
  async function load(older = false) {
    if (busy || !bot || (older && !hasMore)) return;
    const ticket = generation, cursor = older ? before : null;
    busy = true; controls(); el('archivedWorkStatus').textContent = '正在读取已归档会话…';
    try {
      const response = await fetch('/api/dimension/bots/' + encodeURIComponent(bot.id) + '/history?mode=work&limit=40'
        + (cursor ? '&before=' + encodeURIComponent(cursor) : ''), { signal: AbortSignal.timeout(30000) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || '暂时无法读取归档会话。');
      if (ticket !== generation || !dialog.open) return;
      if (!Array.isArray(value.messages) || value.messages.some(item => item.archived !== true || item.mode !== 'work'
        || typeof item.messageId !== 'string' || typeof item.text !== 'string')) throw new Error('归档会话信息不完整，请重新打开。');
      const messages = value.messages.filter(item => !seen.has(item.messageId));
      for (const item of messages) seen.add(item.messageId);
      const fragment = document.createDocumentFragment(); messages.forEach(item => fragment.append(row(item)));
      const previousHeight = dialog.scrollHeight, previousTop = dialog.scrollTop;
      el('archivedWorkMessages').prepend(fragment);
      if (older) dialog.scrollTop = previousTop + dialog.scrollHeight - previousHeight;
      before = typeof value.before === 'string' ? value.before : null;
      hasMore = value.hasMore === true && !!before && messages.length > 0;
      el('archivedWorkStatus').textContent = seen.size ? '已显示 ' + seen.size + ' 条记录' + (hasMore ? '，可加载更早的内容。' : '，已全部加载。') : '这个 Bot 尚无已导入的 Work 会话。';
    } catch (error) { if (ticket === generation && dialog.open) el('archivedWorkStatus').textContent = error.message || '读取失败，请重新打开。'; }
    finally { if (ticket === generation) { busy = false; controls(); } }
  }
  el('archivedWorkClose').onclick = () => dialog.close();
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  el('archivedWorkMore').onclick = () => { void load(true); };
  dialog.addEventListener('close', () => { ++generation; busy = false; });
  return { open(selectedBot) {
    ++generation; bot = selectedBot; before = null; busy = false; hasMore = false; seen.clear();
    el('archivedWorkBot').textContent = String(bot.name || bot.id);
    el('archivedWorkMessages').replaceChildren(); el('archivedWorkStatus').textContent = '';
    controls(); if (!dialog.open) dialog.showModal(); void load();
  } };
}

