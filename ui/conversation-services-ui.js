const labels = { prepared: '准备中', queued: '排队中', running: '调用模型中', committing: '保存结果中', stopping: '正在停止', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '上次运行已中断' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const requestId = () => globalThis.crypto.randomUUID();
const jobUrl = (botId, jobId) => `/api/dimension/conversation-jobs/${encodeURIComponent(jobId)}?botId=${encodeURIComponent(botId)}`;
const sourceUrl = (botId, jobId) => `/api/dimension/conversation-jobs/${encodeURIComponent(jobId)}/source?botId=${encodeURIComponent(botId)}`;

export async function showContextHistory({ api, showModal, escapeHtml: esc, botId, botName, isCurrent, onSettings }) {
  let data = await api(`/api/dimension/bots/${encodeURIComponent(botId)}/context`);
  if (!isCurrent()) return;
  showModal(`<div class="modal-head"><h2>上下文与历史 · ${esc(botName)}</h2><button type="button" class="icon-btn" data-close>关闭</button></div>
    <div class="modal-body"><p id="historyStats"></p><p class="muted" id="historyEstimate"></p>
    <p class="muted">单次模型窗口与已保存历史分别管理；调整窗口不会删除历史。</p>
    <button type="button" class="text-btn" id="historySettings">设置各功能上限</button>
    <p>手动摘要会先备份完整来源，再概括较早的记录。提交后，模型参考摘要和最近 20 条；原文仍可查询和导出，摘要不会成为已确认记忆。</p>
    <button type="button" class="send-btn" id="compactBtn">手动归档老对话</button>
    <button type="button" class="text-btn" id="cancelCompact" hidden>取消本次摘要</button>
    <a id="compactSource" hidden download>下载本次完整来源备份</a>
    <p id="contextMsg" role="status" aria-live="polite"></p><pre id="summaryPreview" style="white-space:pre-wrap" hidden></pre></div>`);
  const root = document.getElementById('modal'), start = document.getElementById('compactBtn');
  const cancel = document.getElementById('cancelCompact'), message = document.getElementById('contextMsg');
  const source = document.getElementById('compactSource'), preview = document.getElementById('summaryPreview');
  const current = () => isCurrent() && start.isConnected && !root.hidden;
  let active = data.summaryJob, pendingRequest, polling = false, submitting = false;
  const render = () => {
    if (!current()) return;
    document.getElementById('historyStats').textContent = `完整历史 ${data.messages.toLocaleString()} 条 · 正文 ${data.unicodeScalars ?? '未知'} 个 Unicode 码点 · 粗估 ${data.estTokens.toLocaleString()} tokens。`;
    document.getElementById('historyEstimate').textContent = `${data.estimateMethod || '估算方法未提供'}。当前单聊窗口 ${data.maxTokens.toLocaleString()}。`;
    const live = active && !active.terminal;
    start.disabled = submitting || live; cancel.hidden = !live;
    source.hidden = !active?.sourceDigest;
    if (active?.sourceDigest) source.href = sourceUrl(botId, active.id);
    message.textContent = active ? `${labels[active.status] || active.status} · 模型请求 ${active.modelCalls || 0} 次。${active.error || active.note || ''}` : '尚未手动摘要归档。';
    preview.hidden = !active?.reply;
    preview.textContent = active?.reply || '';
  };
  const poll = async () => {
    if (polling) return; polling = true;
    try {
      while (current() && active && !active.terminal) {
        await delay(500); if (!current()) break;
        active = await api(jobUrl(botId, active.id)); render();
      }
      if (current() && active?.terminal) { data = await api(`/api/dimension/bots/${encodeURIComponent(botId)}/context`); render(); }
    } catch (error) { if (current()) message.textContent = `状态读取失败：${error.message}。任务可能仍在后台，可重新打开面板查看。`; }
    finally { polling = false; }
  };
  start.addEventListener('click', async () => {
    if (submitting || !current()) return;
    submitting = true; pendingRequest ||= requestId(); render();
    try {
      const result = await api(`/api/dimension/bots/${encodeURIComponent(botId)}/compact`, { method: 'POST', body: JSON.stringify({ requestId: pendingRequest }) });
      if (!current()) return; active = result; pendingRequest = undefined; render(); void poll();
    } catch (error) { if (current()) message.textContent = `未确认开始：${error.message}。重试会沿用同一请求编号。`; }
    finally { submitting = false; if (current()) start.disabled = Boolean(active && !active.terminal); }
  });
  cancel.addEventListener('click', async () => {
    if (!active || !current()) return; cancel.disabled = true;
    try {
      active = await api(`/api/dimension/conversation-jobs/${encodeURIComponent(active.id)}/cancel`, { method: 'POST', body: JSON.stringify({ botId }) });
      if (current()) { render(); void poll(); }
    } catch (error) { if (current()) message.textContent = error.message; }
    finally { if (current()) cancel.disabled = false; }
  });
  document.getElementById('historySettings').addEventListener('click', onSettings);
  render(); if (active && !active.terminal) void poll();
}

export async function showIndependentSpace({ api, showModal, escapeHtml: esc, botId, botName, isCurrent }) {
  let data = await api(`/api/dimension/space?botId=${encodeURIComponent(botId)}`);
  if (!isCurrent()) return;
  let selected = data.minibots[0]?.id;
  const turns = new Map(), cursors = new Map(), busy = new Set(), pollers = new Map(), drafts = new Map();
  const pendingMessages = new Map(), pendingSettings = new Map(), settingBusy = new Set();
  let combinedPoller = false, analysisBusy = false, learningBusy = false, pendingAnalysis;
  const roleBusy = id => busy.has(id) || [...pollers.values()].includes(id);
  showModal(`<div class="modal-head"><h2>思考 · ${esc(botName)}</h2><button type="button" class="icon-btn" data-close>关闭</button></div>
    <div class="space-shell"><aside class="space-list" id="spaceList"></aside><section class="space-main">
    <div id="coreMindBannerHost"></div>
    <div class="task-pane" id="spaceTask"></div><p id="spaceMsg" role="status" aria-live="polite"></p>
    <div class="mini-chat"><button type="button" class="text-btn" id="miniEarlier" hidden>加载更早会话</button>
    <div class="mini-log" id="miniLog" aria-live="polite"></div><form id="miniForm" class="composer-row">
    <textarea id="miniInput" rows="2" aria-label="思考追问" placeholder="围绕当前思考追问…"></textarea>
    <button type="submit" class="send-btn" id="miniSendBtn">发送</button></form></div></section></div>`, true);
  void import('./living-memory-ui.js').then(({ mountCoreMindOverview }) =>
    mountCoreMindOverview({ api, host: document.getElementById('coreMindBannerHost'), botId })
  ).catch(() => {});
  const root = document.getElementById('modal'), list = document.getElementById('spaceList'), task = document.getElementById('spaceTask');
  const log = document.getElementById('miniLog'), input = document.getElementById('miniInput'), send = document.getElementById('miniSendBtn');
  const earlier = document.getElementById('miniEarlier'), message = document.getElementById('spaceMsg');
  const current = () => isCurrent() && list.isConnected && !root.hidden;
  const chosen = id => data.minibots.find(row => row.id === id);
  const pollCombined = async original => {
    if (!original || original.terminal || combinedPoller) return;
    combinedPoller = true; let job = original;
    try {
      while (current() && job && !job.terminal) {
        await delay(400); if (!current()) return;
        job = await api(jobUrl(botId, job.id)); data.latestJob = job; renderTask();
      }
      if (current()) { data = await api(`/api/dimension/space?botId=${encodeURIComponent(botId)}`); renderTask(); }
    } catch (error) { if (current()) message.textContent = `轮次状态读取失败：${error.message}`; }
    finally { combinedPoller = false; if (current()) renderTask(); }
  };
  const analyzeLatest = async () => {
    if (analysisBusy || !current()) return;
    analysisBusy = true; pendingAnalysis ||= requestId(); renderTask();
    try {
      const job = await api('/api/dimension/space/analyze', { method: 'POST', body: JSON.stringify({ botId, requestId: pendingAnalysis }) });
      if (!current()) return;
      pendingAnalysis = undefined; data.latestJob = job; renderTask(); void pollCombined(job);
    } catch (error) { if (current()) message.textContent = `分析未获确认：${error.message}。重试沿用同一请求编号。`; }
    finally { analysisBusy = false; if (current()) renderTask(); }
  };
  const proposeLearning = async () => {
    const round = data.latestRound;
    if (learningBusy || !round?.summary || !current()) return;
    learningBusy = true; renderTask();
    try {
      const questions = (round.openQuestions || []).map(item => `待确认：${item}`).join('\n');
      await api('/api/dimension/skill-library', { method: 'POST', body: JSON.stringify({
        action: 'create', topic: `space-${round.id.slice(4, 20)}`, title: `${botName}空间复盘 · 消息 ${round.sourceMessageId}`,
        keywords: ['思考', botName, '复盘'], origin: `思考轮次 ${round.id}；来源私聊消息 ${round.sourceMessageId}`,
        body: `${round.summary}\n${questions}\n适用条件：仅作为该 Bot 的复盘候选，需用原对话和实际案例人工验证，不能直接视为用户事实或已生效技能。`
      }) });
      if (current()) message.textContent = '已创建经验候选，默认未启用；请到公共区“经验候选”中验证。';
    } catch (error) { if (current()) message.textContent = `候选提交失败：${error.message}`; }
    finally { learningBusy = false; if (current()) renderTask(); }
  };
  const drawChat = () => {
    if (!current()) return;
    const rows = turns.get(selected) || [];
    log.innerHTML = rows.map(row => `<div class="bubble user">${esc(row.user)}</div>${row.assistant
      ? `<div class="bubble assistant">${esc(row.assistant)}<p class="muted">${row.calledModel ? '实际模型回复' : '本地状态回复 · 未调用模型'}</p></div>`
      : `<p class="muted">${esc(row.error || labels[row.status] || row.status)}</p>`}`).join('') || '<p class="muted">这里还没有独立会话。</p>';
    earlier.hidden = !cursors.get(selected)?.hasMore;
    send.disabled = roleBusy(selected) || !input.value.trim();
    log.scrollTop = log.scrollHeight;
  };
  const fetchHistory = async (id, before) => {
    const result = await api(`/api/dimension/minibots/${encodeURIComponent(id)}/chat?botId=${encodeURIComponent(botId)}${before ? '&before=' + encodeURIComponent(before) : ''}`);
    if (!current()) return;
    turns.set(id, before ? [...result.turns, ...(turns.get(id) || [])] : result.turns);
    cursors.set(id, { hasMore: result.hasMore, before: result.before }); if (selected === id) drawChat();
  };
  const sourceInfo = source => !source ? '' : source.kind === 'native-store-statistics'
    ? `<p class="muted">来源：本 Bot 的完整私聊统计，最新消息 ${esc(source.lastMessageId)}。</p>`
    : source.jobId ? `<a href="${esc(sourceUrl(botId, source.jobId))}" download>下载该次实际资料快照</a>` : '';
  const poll = async (id, job) => {
    if (!job || job.terminal || pollers.has(job.id)) return;
    pollers.set(job.id, id); if (id === selected) { drawChat(); renderTask(); }
    try {
      while (current() && !job.terminal) {
        await delay(500); if (!current()) return;
        job = await api(jobUrl(botId, job.id));
        if (selected === id) message.textContent = `${labels[job.status] || job.status} · 实际模型请求 ${job.modelCalls || 0} 次。`;
      }
      if (current()) {
        data = await api(`/api/dimension/space?botId=${encodeURIComponent(botId)}`);
        await fetchHistory(id); if (selected === id) { renderTask(); message.textContent = job.error || '本次任务已结束。'; }
      }
    } catch (error) { if (current() && selected === id) message.textContent = error.message; }
    finally { pollers.delete(job.id); if (current() && id === selected) { drawChat(); renderTask(); } }
  };
  const setThinking = async (id, enabled) => {
    if (settingBusy.has(id)) return;
    settingBusy.add(id);
    const prior = pendingSettings.get(id);
    const pending = prior?.thinkWithModel === enabled ? prior : { thinkWithModel: enabled, requestId: requestId() };
    pendingSettings.set(id, pending); if (selected === id) renderTask();
    try {
      const result = await api(`/api/dimension/minibots/${encodeURIComponent(id)}/think`, { method: 'POST', body: JSON.stringify({ botId, ...pending }) });
      if (!current()) return;
      pendingSettings.delete(id);
      chosen(id).thinkWithModel = result.thinkWithModel;
      if (selected === id) { renderTask(); message.textContent = enabled ? '已启用；本次分析按真实来源调用模型。' : '已关闭推理，活动请求已收到停止要求。'; }
      if (result.job) { chosen(id).job = result.job; void poll(id, result.job); }
    } catch (error) {
      if (!current()) return;
      try { data = await api(`/api/dimension/space?botId=${encodeURIComponent(botId)}`); } catch {}
      if (current() && selected === id) { renderTask(); message.textContent = error.message; }
    } finally { settingBusy.delete(id); if (current() && selected === id) renderTask(); }
  };
  const renderTask = () => {
    const bot = chosen(selected); if (!bot || !current()) return;
    const round = data.latestRound, live = data.latestJob;
    const enabledCount = data.minibots.filter(item => item.thinkWithModel).length;
    const roundLabel = live && round && live.id !== round.id ? '上一有效轮次' : '本轮';
    const statusLabels = { completed: '本轮已分析', cached: '沿用旧结果', disabled: '未运行', failed: '失败', running: '分析中', committing: '保存中' };
    const kindLabels = { fact: '事实', hypothesis: '推测', suggestion: '建议', question: '待确认', observation: '经历' };
    const calledModules = data.minibots.filter(item => item.calledModel).map(item => item.name);
    const kindCounts = { fact: 0, suggestion: 0, hypothesis: 0, question: 0 };
    for (const item of data.minibots) {
      const m = round?.modules?.[item.id];
      if (m && m.kind && kindCounts[m.kind] !== undefined) kindCounts[m.kind]++;
    }
    const digestBar = round ? `<p class="muted">本轮输出分布：事实 ${kindCounts.fact} · 建议 ${kindCounts.suggestion} · 推测 ${kindCounts.hypothesis} · 待确认分歧 ${kindCounts.question + (round.openQuestions?.length || 0)}${calledModules.length ? ` · 本轮更新模块：${esc(calledModules.join('、'))}` : ' · 本轮未调用辅助模型（日常短寒暄自动静默或模块未开启）'}</p>` : '';
    task.innerHTML = `<section class="space-round-card"><h3>思考轮次与重点汇总</h3>
      <p class="muted">13 个稳定模块按需参与；日常短寒暄自动免调模型，复杂对话最多 1 次辅助调用。打开和切换面板不会调用模型。</p>
      ${live ? `<p class="muted">当前轮次：${esc(labels[live.status] || live.status)} · 实际模型请求 ${live.modelCalls || 0} 次${live.note ? ` · ${esc(live.note)}` : ''}${live.error ? ` · ${esc(live.error)}` : ''}</p>` : ''}
      ${round ? `<p><strong>${roundLabel} · 来源消息 ${esc(round.sourceMessageId)}</strong></p><p>${esc(round.summary)}</p>
      ${digestBar}
      <p class="muted">有效轮次模型请求 ${round.modelCalls || 0} 次 · ${round.completedAtMs ? `完成于 ${new Date(Number(round.completedAtMs)).toLocaleString()}` : '时间未知'}</p>
      ${(round.openQuestions || []).map(item => `<p class="space-question">待确认：${esc(item)}</p>`).join('')}
      <button type="button" class="text-btn" id="spaceLearn" ${learningBusy ? 'disabled' : ''}>${learningBusy ? '正在提交…' : '提交为经验候选（不启用）'}</button>` : '<p class="muted">还没有思考结果。</p>'}
      <button type="button" class="text-btn" id="miniAnalyze" ${analysisBusy || !enabledCount ? 'disabled' : ''}>${analysisBusy ? '正在提交…' : enabledCount ? '用最新私聊再分析' : '先启用至少一个模块'}</button></section>
      <h3>${esc(bot.name)}</h3><p class="muted">稳定 ID：${esc(bot.id)} · ${esc(bot.region)} · ${esc(bot.duty)}</p>
      <p class="muted">模块状态：${statusLabels[bot.analysisStatus] || bot.analysisStatus} · ${bot.calledModel ? '本轮确实调用模型' : '本轮未调用模型'}</p>
      <label class="switch"><input type="checkbox" id="thinkSwitch" ${bot.thinkWithModel ? 'checked' : ''} ${settingBusy.has(selected) ? 'disabled' : ''}>参与后续思考</label>
      <p class="muted">开关按 Bot 和模块分别保存。关闭时展示旧结果或“未运行”，不会暗中调用模型，也不会安排 Work。</p>
      ${(bot.findings || []).map(item => `<article class="task-card"><strong>${kindLabels[item.kind] || '模型分析 · 待核实'}</strong><p>${esc(item.summary)}</p>${sourceInfo(item.source)}</article>`).join('') || '<p class="muted">没有可呈现的来源资料或模型分析。</p>'}
      ${(bot.trace || []).map(item => `<p class="muted">${esc(item.message)}</p>`).join('')}`;
    const id = selected;
    document.getElementById('thinkSwitch').addEventListener('change', event => void setThinking(id, event.target.checked));
    document.getElementById('miniAnalyze').addEventListener('click', () => void analyzeLatest());
    document.getElementById('spaceLearn')?.addEventListener('click', () => void proposeLearning());
    for (const button of list.querySelectorAll('[data-mini]')) button.classList.toggle('active', button.dataset.mini === selected);
  };
  const select = async id => {
    drafts.set(selected, input.value); selected = id; input.value = drafts.get(id) || ''; message.textContent = '';
    renderTask(); drawChat();
    try { await fetchHistory(id); if (current()) void poll(id, chosen(id).job); }
    catch (error) { if (current() && selected === id) message.textContent = error.message; }
  };
  list.innerHTML = data.minibots.map(bot => `<button type="button" class="space-bot" data-mini="${esc(bot.id)}"><strong>${esc(bot.name)}</strong><span>${esc(bot.duty)}</span></button>`).join('');
  for (const button of list.querySelectorAll('[data-mini]')) button.addEventListener('click', () => void select(button.dataset.mini));
  input.addEventListener('input', drawChat);
  earlier.addEventListener('click', async () => {
    const id = selected; earlier.disabled = true;
    try { await fetchHistory(id, cursors.get(id)?.before); }
    catch (error) { if (current()) message.textContent = error.message; }
    finally { if (current()) earlier.disabled = false; }
  });
  document.getElementById('miniForm').addEventListener('submit', async event => {
    event.preventDefault(); const id = selected, text = input.value.trim();
    if (!text || roleBusy(id) || !current()) return;
    const prior = pendingMessages.get(id);
    const pending = prior?.text === text ? prior : { text, requestId: requestId() };
    pendingMessages.set(id, pending); busy.add(id); drawChat();
    try {
      const job = await api(`/api/dimension/minibots/${encodeURIComponent(id)}/chat`, { method: 'POST', body: JSON.stringify({ botId, ...pending }) });
      if (!current()) return;
      pendingMessages.delete(id);
      if (id === selected && input.value.trim() === text) input.value = '';
      drafts.set(id, ''); await fetchHistory(id); chosen(id).job = job;
      busy.delete(id); if (!job.terminal) void poll(id, job);
    } catch (error) { if (current() && selected === id) message.textContent = `发送或刷新未获确认：${error.message}。相同文字的未确认请求会沿用同一编号重试。`; }
    finally { busy.delete(id); if (current() && selected === id) drawChat(); }
  });
  if (selected) await select(selected);
  if (data.latestJob && !data.latestJob.terminal) void pollCombined(data.latestJob);
}
