const node = (tag, className, text) => {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

const styles = `
.pr-dialog{width:min(940px,calc(100vw - 32px));max-height:min(840px,calc(100dvh - 32px));padding:0;border:1px solid var(--color-composer-ring);border-radius:16px;background:var(--color-raised);color:var(--color-ink);overflow:auto}
.pr-dialog::backdrop{background:rgb(18 16 14 / .38)}
.pr-head{position:sticky;top:0;z-index:3;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 22px;background:var(--color-raised);border-bottom:1px solid var(--color-composer-ring)}
.pr-head h2{margin:0;font-size:18px}.pr-head-actions,.pr-card-actions,.pr-form-actions{display:flex;flex-wrap:wrap;gap:8px}
.pr-dialog button{min-height:34px;padding:0 12px;border:1px solid var(--color-composer-ring);border-radius:10px;background:var(--color-raised);color:inherit;font:inherit;cursor:pointer}
.pr-dialog button:hover{background:var(--color-raised-hover)}.pr-dialog button:disabled{opacity:.55;cursor:default}.pr-primary{background:var(--color-control)!important}
.pr-body{padding:18px 22px 24px}.pr-boundary{margin:0 0 14px;padding:12px 14px;border-radius:10px;background:var(--color-app);font-size:12px;line-height:1.7;color:var(--color-ink-secondary)}
.pr-status{min-height:20px;margin:0 0 12px;font-size:13px;color:var(--color-ink-secondary)}.pr-list{display:grid;gap:12px}.pr-empty{margin:20px 0;text-align:center;color:var(--color-ink-tertiary)}
.pr-card{padding:15px;border:1px solid var(--color-composer-ring);border-radius:12px;background:var(--color-app)}
.pr-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.pr-card h3{margin:0;font-size:15px;overflow-wrap:anywhere}.pr-card p{margin:8px 0;font-size:12px;line-height:1.6;color:var(--color-ink-secondary);overflow-wrap:anywhere;white-space:pre-wrap}
.pr-pill{flex:none;padding:3px 9px;border-radius:999px;background:var(--color-control);font-size:11px;color:var(--color-ink-secondary)}.pr-pill[data-state=active]{color:var(--color-success)}
.pr-meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 16px;margin:12px 0;font-size:12px;color:var(--color-ink-secondary)}.pr-meta span{overflow-wrap:anywhere}
.pr-draft{padding:10px 12px;border-left:3px solid var(--color-composer-ring);background:var(--color-raised)}
.pr-form{margin:0 0 18px;padding:16px;border:1px solid var(--color-composer-ring);border-radius:12px;background:var(--color-app)}
.pr-form h3{margin:0 0 14px;font-size:15px}.pr-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.pr-form label{display:grid;gap:6px;font-size:12px;color:var(--color-ink-secondary)}
.pr-form label.pr-wide{grid-column:1/-1}.pr-form label.pr-check{display:flex;flex-direction:row;align-items:center;gap:8px}.pr-form label.pr-check input{width:auto}
.pr-form input,.pr-form select,.pr-form textarea{box-sizing:border-box;width:100%;padding:9px 10px;border:1px solid var(--color-composer-ring);border-radius:9px;background:var(--color-raised);color:var(--color-ink);font:inherit}
.pr-form textarea{resize:vertical;min-height:76px}.pr-form-note{grid-column:1/-1;margin:0;font-size:11px;color:var(--color-ink-tertiary)}.pr-form-actions{grid-column:1/-1;margin-top:4px}
@media(max-width:640px){.pr-head,.pr-body{padding-left:14px;padding-right:14px}.pr-form-grid,.pr-meta{grid-template-columns:1fr}.pr-form label.pr-wide,.pr-form-note,.pr-form-actions{grid-column:1}.pr-card-head{display:grid}}
`;

const eventLabels = { run_completed: '任务完成', run_partial: '部分交付', run_failed: '执行失败' };
const deliveryLabels = { notification: '本地通知（只提醒）', draft: '仅准备草稿', authorized_work: '按明确授权排队 Work（第3档）' };
const statusLabels = { active: '已启用', paused: '已暂停', completed: '已结束' };
const timeText = value => value > 0 ? new Date(value).toLocaleString() : '—';
const localInputTime = value => {
  if (!value) return '';
  const date = new Date(value - new Date(value).getTimezoneOffset() * 60000);
  return date.toISOString().slice(0, 16);
};

export function bindProactiveReminders({ api }) {
  const existing = document.getElementById('proactiveRemindersDialog');
  if (existing) return { open: () => existing.showModal(), close: () => existing.close(), refresh: () => existing.dispatchEvent(new Event('refresh')) };
  const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
  const dialog = node('dialog', 'pr-dialog'); dialog.id = 'proactiveRemindersDialog'; dialog.setAttribute('aria-label', '主动提醒与巡检规则');
  dialog.innerHTML = `<header class="pr-head"><h2>主动提醒与受控巡检</h2><div class="pr-head-actions"><button type="button" data-new class="pr-primary">新建规则</button><button type="button" data-refresh>刷新</button><button type="button" data-close>关闭</button></div></header>
    <div class="pr-body"><p class="pr-boundary">规则默认禁用，手动启用后生效。支持三档：只提醒、准备草稿、按明确授权提交排队 Work 任务（危险写操作仍受审批门禁保护，绝不擅自对外发送）。项目巡检与动态进度整理在「无实质新变化」时保持安静，不消耗预算、不打扰。</p><p class="pr-status" role="status"></p>
    <form class="pr-form" hidden><h3 data-form-title>新建主动规则</h3><div class="pr-form-grid">
      <label>名称<input name="name" maxlength="80" required placeholder="例如：巡检项目代码变动 / 定期整理进度"></label>
      <label>触发方式<select name="kind"><option value="interval">按时间间隔</option><option value="project_watch">检查指定项目目录变化（无变化静默）</option><option value="condition">条件事件出现后</option></select></label>
      <label data-interval>间隔（分钟）<input name="intervalMinutes" type="number" min="1" max="525600" step="1" value="60"></label>
      <label data-trigger-event hidden>触发事件<select name="eventType"><option value="run_completed">任务完成</option><option value="run_partial">部分交付</option><option value="run_failed">执行失败</option></select></label>
      <label data-project-path class="pr-wide" hidden>监控项目目录绝对路径<input name="projectPath" maxlength="1024" placeholder="例如：C:\\Projects\\MyApp（自动对比文件与 Git HEAD 指纹）"></label>
      <label>交付档位<select name="delivery"><option value="notification">1. 本地通知（只提醒）</option><option value="draft">2. 仅准备草稿</option><option value="authorized_work">3. 按明确授权排队 Work 任务（最多20次）</option></select></label>
      <label>最大触发预算<input name="budget" type="number" min="1" max="1000" step="1" value="3" required></label>
      <label>负责的伙伴（第3档必选；其余可不限）<select name="botId" data-directory="bots"><option value="">不限伙伴</option></select></label>
      <label>限定茶会（可选）<select name="groupId" data-directory="groups"><option value="">不限（含私聊）</option></select></label>
      <label class="pr-wide">限定委托编号（可选，高级）<input name="runId" maxlength="512" placeholder="留空＝匹配所有委托；只想盯某一单委托时，粘贴该委托的任务编号"></label>
      <label>结束时间（可与结束条件二选一）<input name="endAt" type="datetime-local"></label>
      <label>结束条件（可与结束时间二选一）<select name="endEventType"><option value="">不使用事件结束</option><option value="run_completed">任务完成</option><option value="run_partial">部分交付</option><option value="run_failed">执行失败</option></select></label>
      <label class="pr-wide pr-check"><input type="checkbox" name="dynamicSummary"> 附带真实 Work 进度动态整理（若进度与上次一致则自动保持安静）</label>
      <label class="pr-wide">通知／草稿／授权任务指令文案<textarea name="message" maxlength="2000" required placeholder="填写提醒文案，或第3档授权该 Bot 执行的明确检查目标。"></textarea></label>
      <p class="pr-form-note">电脑关机期间暂停运行；重开客户端合并过期轮次，绝不自动批量补跑危险操作。</p>
      <div class="pr-form-actions"><button type="submit" class="pr-primary" data-save>保存（默认禁用）</button><button type="submit" data-save-enable>保存并启用</button><button type="button" data-cancel>取消</button></div>
    </div></form><div class="pr-list"></div></div>`;
  document.body.append(dialog);
  const el = selector => dialog.querySelector(selector);
  const form = el('.pr-form'), list = el('.pr-list'), status = el('.pr-status');
  let rows = [], capabilities = null, editing = null, version = 0, busy = false, dirty = false;
  const say = text => { status.textContent = text; };
  const saveBtn = el('[data-save]'), saveEnableBtn = el('[data-save-enable]');
  // 伙伴 / 茶会名录（只读接口），用于下拉选择和把卡片上的 ID 换成名字。
  const botNames = new Map(), groupNames = new Map();
  let directoryState = 'idle';
  const fillSelect = (select, entries, emptyLabel) => {
    const current = select.value || select.dataset.pending || '';
    select.replaceChildren(new Option(emptyLabel, ''));
    for (const [id, name] of [...entries].sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'))) select.add(new Option(name, id));
    setSelectValue(select, current);
  };
  function setSelectValue(select, value) {
    const wanted = String(value || '');
    if (select.tagName !== 'SELECT') { select.value = wanted; return; }
    if (wanted && ![...select.options].some(option => option.value === wanted)) {
      const missing = select.dataset.directory === 'groups' ? '已不存在的茶会（保留原设置）' : '已不存在的伙伴（保留原设置）';
      select.add(new Option(directoryState === 'ready' ? missing : '正在读取名称…', wanted));
    }
    select.value = wanted; select.dataset.pending = '';
  }
  const degradeToInput = select => {
    const input = node('input', ''); input.name = select.name; input.maxLength = 512;
    input.placeholder = select.dataset.directory === 'groups' ? '名录读取失败：可粘贴茶会编号，留空＝不限' : '名录读取失败：可粘贴伙伴编号，第3档必填';
    input.value = select.value || select.dataset.pending || ''; select.replaceWith(input);
  };
  const loadDirectory = async () => {
    if (directoryState === 'ready' || directoryState === 'loading') return;
    directoryState = 'loading';
    try {
      const [botData, groupData] = await Promise.all([api('/api/dimension/bots/lookup'), api('/api/dimension/groups')]);
      for (const bot of Array.isArray(botData?.bots) ? botData.bots : []) if (bot?.id) botNames.set(bot.id, bot.name || '未命名伙伴');
      for (const bot of Array.isArray(groupData?.bots) ? groupData.bots : []) if (bot?.id && !botNames.has(bot.id)) botNames.set(bot.id, bot.name || '未命名伙伴');
      for (const group of Array.isArray(groupData?.groups) ? groupData.groups : []) if (group?.id) groupNames.set(group.id, group.name || '未命名茶会');
      directoryState = 'ready';
      if (form.elements.botId.tagName === 'SELECT') fillSelect(form.elements.botId, botNames, '不限伙伴');
      if (form.elements.groupId.tagName === 'SELECT') fillSelect(form.elements.groupId, groupNames, '不限（含私聊）');
      render();
    } catch {
      directoryState = 'failed';
      for (const select of form.querySelectorAll('select[data-directory]')) degradeToInput(select);
    }
  };
  const botLabel = id => botNames.get(id) || '';
  const groupLabel = id => groupNames.get(id) || '';
  const syncKind = () => {
    const kind = form.elements.kind.value;
    const periodic = kind === 'interval' || kind === 'project_watch';
    const isProject = kind === 'project_watch';
    el('[data-interval]').hidden = !periodic;
    el('[data-trigger-event]').hidden = periodic;
    el('[data-project-path]').hidden = !isProject;
    form.elements.intervalMinutes.required = periodic;
    form.elements.eventType.required = !periodic;
    form.elements.projectPath.required = isProject;
  };
  const reset = () => {
    editing = null; dirty = false; form.reset(); form.elements.intervalMinutes.value = 60; form.elements.budget.value = 3;
    form.elements.endAt.value = localInputTime(Date.now() + 24 * 3600000);
    form.elements.endEventType.value = ''; form.hidden = true; el('[data-form-title]').textContent = '新建主动规则';
    saveBtn.textContent = '保存（默认禁用）'; saveEnableBtn.hidden = false; saveEnableBtn.textContent = '保存并启用'; syncKind();
  };
  const payload = () => {
    const data = Object.fromEntries(new FormData(form).entries());
    const endAt = data.endAt ? new Date(data.endAt).getTime() : 0;
    if (!Number.isFinite(endAt) || (!endAt && !data.endEventType)) throw new Error('请明确结束时间或结束条件。');
    if (endAt && endAt <= Date.now() && !editing) throw new Error('结束时间必须晚于当前时间。');
    if (data.delivery === 'authorized_work' && !String(data.botId || '').trim()) throw new Error('第3档「按明确授权排队 Work」必须选择负责的伙伴。');
    const isProject = data.kind === 'project_watch';
    const scope = {
      source: isProject ? 'project' : 'scheduler',
      botId: String(data.botId || '').trim(),
      groupId: String(data.groupId || '').trim(),
      runId: String(data.runId || '').trim(),
    };
    if (isProject) scope.projectPath = String(data.projectPath || '').trim();
    const result = {
      name: data.name.trim(), kind: data.kind, message: data.message.trim(), delivery: data.delivery,
      budget: Number(data.budget), endAt, endEventType: data.endEventType, scope,
      dynamicSummary: Boolean(form.elements.dynamicSummary.checked),
    };
    if (data.kind === 'interval' || isProject) result.intervalMinutes = Number(data.intervalMinutes);
    else result.eventType = data.eventType;
    if (editing) result.revision = editing.revision;
    return result;
  };
  const scopeText = rule => {
    const scope = rule.scope || {};
    const who = [];
    if (scope.botId) who.push(botLabel(scope.botId) ? `伙伴「${botLabel(scope.botId)}」` : '指定伙伴');
    if (scope.groupId) who.push(groupLabel(scope.groupId) ? `茶会「${groupLabel(scope.groupId)}」` : '指定茶会');
    if (scope.runId) who.push('指定的一单委托');
    if (scope.source === 'project') {
      return `巡检项目目录：${scope.projectPath || '未填写'}${who.length ? ` · 由${who.join('、')}负责` : ''}`;
    }
    return who.length ? `只关注 ${who.join(' · ')} 的委托` : '关注所有伙伴与茶会的委托结束事件';
  };
  const endText = rule => {
    const parts = [];
    if (rule.endAt) parts.push(`时间 ${timeText(rule.endAt)}`);
    if (rule.endEventType) parts.push(`事件 ${eventLabels[rule.endEventType] || rule.endEventType}`);
    return parts.join('；') || '未设置';
  };
  const actionButton = (label, action, rule) => {
    const button = node('button', '', label); button.type = 'button'; button.dataset.action = action; button.dataset.ruleId = rule.id;
    button.disabled = busy; return button;
  };
  const render = () => {
    if (!rows.length) { list.replaceChildren(node('p', 'pr-empty', '还没有主动规则。新建后默认禁用。')); return; }
    list.replaceChildren(...rows.map(rule => {
      const card = node('article', 'pr-card'); card.dataset.ruleId = rule.id;
      const head = node('div', 'pr-card-head'); head.append(node('h3', '', rule.name));
      const pill = node('span', 'pr-pill', statusLabels[rule.status] || rule.status); pill.dataset.state = rule.status; head.append(pill); card.append(head);
      const periodic = rule.kind === 'interval' || rule.kind === 'project_watch';
      const kind = rule.kind === 'project_watch' ? `每 ${rule.intervalMinutes} 分钟巡检项目变化` : rule.kind === 'interval' ? `每 ${rule.intervalMinutes} 分钟` : `${eventLabels[rule.eventType] || rule.eventType}出现后`;
      const silentNote = rule.silentCheckCount ? ` · 无变化静默 ${rule.silentCheckCount} 次` : '';
      const meta = node('div', 'pr-meta');
      meta.append(
        node('span', '', `触发：${kind}${rule.dynamicSummary ? ' · 含动态进度整理' : ''}`),
        node('span', '', `档位：${deliveryLabels[rule.delivery] || rule.delivery}`),
        node('span', '', `预算：${rule.triggerCount}/${rule.budget} 次${rule.skippedCount ? ` · 免打扰丢弃 ${rule.skippedCount} 次` : ''}${silentNote}`),
        node('span', '', `下次：${periodic && rule.status === 'active' ? timeText(rule.nextTriggerAt) : '等待匹配事件 / 未启用'}`),
        node('span', '', `结束：${endText(rule)}`),
        node('span', '', `最近触发：${timeText(rule.lastTriggeredAt)}`),
      );
      card.append(meta, node('p', '', `范围：${scopeText(rule)}`), node('p', '', `文案／目标：${rule.message}`));
      if (rule.latestDraft) card.append(node('p', 'pr-draft', `仅草稿，未发送（${timeText(rule.latestDraft.preparedAt)}）：\n${rule.latestDraft.text}`));
      if (rule.lastReason) card.append(node('p', '', `状态说明：${rule.lastReason}`));
      const actions = node('div', 'pr-card-actions'); actions.append(actionButton('编辑', 'edit', rule));
      if (rule.status !== 'completed') actions.append(actionButton(rule.enabled ? '暂停' : '启用', rule.enabled ? 'pause' : 'resume', rule));
      actions.append(actionButton('删除', 'delete', rule)); card.append(actions);
      return card;
    }));
  };
  const load = async () => {
    const ticket = ++version; say('正在读取规则…');
    try {
      const data = await api('/api/native/proactive-reminders');
      if (ticket !== version) return;
      rows = Array.isArray(data.rules) ? data.rules : []; capabilities = data.capabilities || capabilities;
      render(); say(rows.length ? `${rows.length} 条规则；启用状态与档位已明确显示。` : '尚无规则，不会主动运行。');
    } catch (error) { if (ticket === version) say(error.message); }
  };
  const edit = rule => {
    editing = rule; dirty = false; form.hidden = false; el('[data-form-title]').textContent = '编辑主动规则';
    saveBtn.textContent = rule.enabled ? '保存修改（保持启用）' : '保存修改';
    saveEnableBtn.hidden = Boolean(rule.enabled) || rule.status === 'completed'; saveEnableBtn.textContent = '保存修改并启用';
    form.elements.name.value = rule.name; form.elements.kind.value = rule.kind; form.elements.message.value = rule.message;
    form.elements.delivery.value = rule.delivery; form.elements.budget.value = rule.budget;
    form.elements.intervalMinutes.value = rule.intervalMinutes || 60; form.elements.eventType.value = rule.eventType || 'run_completed';
    setSelectValue(form.elements.botId, rule.scope?.botId || ''); setSelectValue(form.elements.groupId, rule.scope?.groupId || ''); form.elements.runId.value = rule.scope?.runId || '';
    form.elements.projectPath.value = rule.scope?.projectPath || '';
    form.elements.dynamicSummary.checked = Boolean(rule.dynamicSummary);
    form.elements.endAt.value = localInputTime(rule.endAt); form.elements.endEventType.value = rule.endEventType || '';
    syncKind(); form.scrollIntoView({ block: 'start' }); form.elements.name.focus();
  };
  const mutate = async (rule, action) => {
    if (busy) return; busy = true; render();
    try {
      if (action === 'delete') {
        const ok = window.__dimensionConfirm
          ? await window.__dimensionConfirm({ title: '删除主动提醒规则', message: `删除规则「${rule.name}」？此操作只删除规则及其草稿。`, confirmLabel: '删除规则', danger: true })
          : window.confirm(`删除规则「${rule.name}」？此操作只删除规则及其草稿。`);
        if (!ok) return;
      }
      const path = `/api/native/proactive-reminders/${encodeURIComponent(rule.id)}${action === 'pause' || action === 'resume' ? '/' + action : ''}`;
      const options = action === 'delete' ? { method: 'DELETE', body: JSON.stringify({ revision: rule.revision }) }
        : { method: 'POST', body: JSON.stringify({ revision: rule.revision }) };
      const data = await api(path, options); rows = rows.map(row => row.id === rule.id ? data.rule : row).filter(Boolean);
      if (action === 'delete') rows = rows.filter(row => row.id !== rule.id);
      if (editing?.id === rule.id && action === 'delete') reset();
      say(action === 'delete' ? '规则已删除。' : action === 'pause' ? '规则已暂停，不补播暂停期间的事件。' : '规则已启用；巡检基线与间隔从当前时间起算。');
    } catch (error) { say(error.message); }
    finally { busy = false; render(); }
  };
  form.elements.kind.addEventListener('change', syncKind);
  form.addEventListener('input', () => { dirty = true; });
  form.addEventListener('change', () => { dirty = true; });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    const enableAfter = event.submitter === saveEnableBtn;
    let body; try { body = payload(); } catch (error) { say(error.message); return; }
    busy = true; say(editing ? '正在保存修改…' : enableAfter ? '正在创建并启用规则…' : '正在创建禁用规则…');
    try {
      const path = editing ? `/api/native/proactive-reminders/${encodeURIComponent(editing.id)}` : '/api/native/proactive-reminders';
      const data = await api(path, { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) });
      rows = Array.isArray(data.rules) ? data.rules : rows;
      let saved = data.rule || null;
      if (saved && !rows.some(row => row.id === saved.id)) rows = [saved, ...rows];
      let enabledNow = false, enableError = '';
      if (enableAfter && saved?.id && saved.enabled !== true) {
        try {
          const resumed = await api(`/api/native/proactive-reminders/${encodeURIComponent(saved.id)}/resume`, { method: 'POST', body: JSON.stringify({ revision: saved.revision }) });
          if (resumed?.rule) { saved = resumed.rule; rows = rows.map(row => row.id === saved.id ? saved : row); }
          enabledNow = true;
        } catch (error) { enableError = error.message || '启用失败'; }
      }
      const stillEnabled = saved?.enabled === true;
      reset(); render();
      if (enableError) say(`已保存，但启用失败：${enableError}。可在卡片上手动启用。`);
      else say(enabledNow ? '✦ 已保存并启用；巡检基线与间隔从当前时间起算。' : stillEnabled ? '已保存，规则仍保持启用。' : '已保存，规则保持禁用；核对范围与档位后可手动启用。');
      if (enableAfter && !saved?.id && !enableError) say('已保存，但未拿到规则信息，请在卡片上手动启用。');
      if (enableAfter && !saved?.id) void load();
    } catch (error) { say(error.message); }
    finally { busy = false; render(); }
  });
  el('[data-cancel]').onclick = reset;
  el('[data-new]').onclick = () => {
    if (!form.hidden && !editing && dirty) { form.elements.name.focus(); return; } // 保留未保存草稿
    reset(); form.hidden = false; form.elements.name.focus();
  };
  el('[data-refresh]').onclick = () => void load();
  el('[data-close]').onclick = () => dialog.close();
  list.addEventListener('click', event => {
    const button = event.target.closest('button[data-action]'); if (!button) return;
    const rule = rows.find(row => row.id === button.dataset.ruleId); if (!rule) return;
    if (button.dataset.action === 'edit') edit(rule); else void mutate(rule, button.dataset.action);
  });
  const open = () => {
    if (!dialog.open) dialog.showModal();
    void loadDirectory(); void load().then(() => { if (dirty && !form.hidden) say('✦ 已恢复上次未保存的草稿，可继续填写或点「取消」丢弃。'); });
  };
  dialog.addEventListener('refresh', () => void load());
  // 关闭时不清空表单：有未保存内容就保留为草稿，下次打开继续；没有改动才收起表单。
  dialog.addEventListener('close', () => { version++; if (!dirty) reset(); });
  const trigger = document.getElementById('sharedProactiveRemindersBtn'); if (trigger) trigger.onclick = open;
  reset();
  return { open, close: () => dialog.close(), refresh: load, capabilities: () => capabilities };
}
