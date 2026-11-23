// A view of the server's current request estimate, not a tokenizer or a billing
// counter. Keep one scoped request in flight; never reuse another Bot's result.
export function bindContextUsage({ api, getScope, onSettings } = {}) {
  const button = document.getElementById('contextUsageBtn');
  const value = document.getElementById('contextUsageValue');
  const progress = document.getElementById('contextUsageProgress');
  if (!button || !value || !progress) return { refresh: async () => {}, clear() {}, destroy() {} };
  if (typeof api !== 'function' || typeof getScope !== 'function')
    throw new TypeError('Context usage requires api and getScope callbacks');

  const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
  let ticket = 0, currentKey = '', request, pollTimer, requestTimer, destroyed = false;
  const scopeOf = () => {
    let scope;
    try { scope = getScope(); } catch { return null; }
    if (!scope || scope.active === false || !['work', 'chat'].includes(scope.mode)) return null;
    const botId = typeof scope.botId === 'string' ? scope.botId : '';
    const groupId = typeof scope.groupId === 'string' ? scope.groupId : '';
    if (!botId && !groupId) return null;
    return { mode: scope.mode, botId, groupId, botName: typeof scope.botName === 'string' ? scope.botName : '' };
  };
  const keyOf = scope => scope ? JSON.stringify([scope.mode, scope.botId, scope.groupId]) : '';
  const heading = (scope, botId = '', reportedName = '') => {
    if (!scope) return '';
    const id = botId || scope.botId;
    const name = reportedName || (scope.botName && id === scope.botId ? scope.botName : id);
    return `${scope.mode === 'work' ? 'Work' : 'Chat'}${name ? ` · Bot：${name}` : ' · 当前群'}\n`;
  };
  const unknown = (reason, scope = null, compacting = false) => {
    value.textContent = '—';
    progress.setAttribute('stroke-dasharray', '0 100');
    button.dataset.state = 'unknown';
    button.dataset.compacting = String(compacting);
    button.removeAttribute('aria-busy');
    button.title = heading(scope) + reason + (compacting ? '\n正在压缩上下文，等待用量更新。' : '') + '\n点击打开上下文设置。';
    button.setAttribute('aria-label', '上下文用量未知。' + button.title);
  };
  const invalidate = () => {
    ++ticket;
    clearTimeout(pollTimer); clearTimeout(requestTimer);
    pollTimer = requestTimer = undefined;
    request?.controller.abort(); request = undefined;
  };
  const schedule = () => {
    clearTimeout(pollTimer);
    if (!destroyed && !document.hidden && scopeOf()) pollTimer = setTimeout(() => { void refresh(); }, 4000);
  };
  const paint = (data, scope) => {
    const valid = data?.available === true && Number.isFinite(data.inputTokens) && data.inputTokens >= 0 &&
      Number.isFinite(data.contextWindow) && data.contextWindow > 0 && Number.isFinite(data.percent) && data.percent >= 0 &&
      typeof data.botId === 'string' && data.botId.length > 0 && (!scope.botId || data.botId === scope.botId);
    if (!valid) {
      const reason = typeof data?.reason === 'string' && data.reason.length <= 240 && data.reason.trim()
        ? data.reason : '当前会话暂无可用的上下文记录。';
      unknown(data?.available === true ? '上下文用量暂不可用，等待有效的当前会话数据。' : reason,
        scope, data?.compacting === true);
      return;
    }
    const percent = Math.round(data.percent);
    value.textContent = percent >= 1000 ? '>999%' : `${percent}%`;
    const filled = Math.min(100, data.percent);
    progress.setAttribute('stroke-dasharray', `${filled} ${100 - filled}`);
    button.dataset.state = 'available';
    button.dataset.compacting = String(data.compacting === true);
    button.removeAttribute('aria-busy');
    const estimated = data.estimated !== false;
    const name = typeof data.botName === 'string' ? data.botName : '';
    const lines = [heading(scope, data.botId, name).trimEnd(),
      `${estimated ? '估算已用' : '已用'} ${number.format(data.inputTokens)} / 实际窗口 ${number.format(data.contextWindow)} tokens（${number.format(percent)}%）`,
      data.compacting === true ? '正在压缩上下文，完整记录仍保留。' : '当前未在压缩上下文。'];
    if (typeof data.updatedAt === 'string' || typeof data.updatedAt === 'number') {
      const date = new Date(data.updatedAt);
      if (Number.isFinite(date.getTime())) lines.push('更新于 ' + date.toLocaleTimeString('zh-CN'));
    }
    lines.push('点击打开上下文设置。');
    button.title = lines.join('\n');
    button.setAttribute('aria-label', `上下文${estimated ? '估算' : ''}占用 ${number.format(percent)}%。${button.title}`);
  };

  async function refresh() {
    if (destroyed) return;
    const scope = scopeOf(), key = keyOf(scope);
    if (key !== currentKey) {
      invalidate(); currentKey = key;
      unknown(scope ? '正在读取当前会话的上下文用量…' : '先选择一个 Bot 或群，再查看上下文占用。', scope);
    }
    if (!scope || document.hidden) {
      invalidate();
      if (!scope) unknown('先选择一个 Bot 或群，再查看上下文占用。');
      return;
    }
    if (request) return request.promise;
    clearTimeout(pollTimer);
    const generation = ++ticket, controller = new AbortController();
    const query = new URLSearchParams({ mode: scope.mode });
    if (scope.botId) query.set('botId', scope.botId);
    if (scope.groupId) query.set('groupId', scope.groupId);
    button.setAttribute('aria-busy', 'true');
    requestTimer = setTimeout(() => controller.abort(), 10000);
    const pending = { controller, promise: null };
    request = pending;
    pending.promise = (async () => {
      try {
        const data = await api('/api/dimension/context-usage?' + query, { signal: controller.signal });
        if (destroyed || generation !== ticket || controller.signal.aborted || document.hidden) return;
        if (keyOf(scopeOf()) !== key) { void refresh(); return; }
        paint(data, scope);
      } catch (error) {
        if (destroyed || generation !== ticket || document.hidden) return;
        if (keyOf(scopeOf()) !== key) { void refresh(); return; }
        unknown(controller.signal.aborted ? '读取上下文用量超时，稍后自动重试。' : '上下文用量暂不可用，稍后自动重试。', scope);
      } finally {
        if (generation === ticket) {
          clearTimeout(requestTimer); requestTimer = undefined;
          request = undefined; button.removeAttribute('aria-busy'); schedule();
        }
      }
    })();
    return pending.promise;
  }
  function clear() {
    invalidate(); currentKey = '';
    unknown('先选择一个 Bot 或群，再查看上下文占用。');
  }
  const settings = () => {
    if (typeof onSettings === 'function') onSettings();
    else document.getElementById('contextLimitsBtn')?.click();
  };
  const visibility = () => {
    if (document.hidden) { invalidate(); button.removeAttribute('aria-busy'); }
    else void refresh();
  };
  button.addEventListener('click', settings);
  document.addEventListener('visibilitychange', visibility);
  unknown('先选择一个 Bot 或群，再查看上下文占用。');
  void refresh();
  return { refresh, clear, destroy() {
    if (destroyed) return;
    destroyed = true; clear();
    button.removeEventListener('click', settings);
    document.removeEventListener('visibilitychange', visibility);
  } };
}
