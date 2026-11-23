// Original UI for the native conversation archive contract. File content is
// data only and is never rendered as HTML, evaluated, or sent to a model.
export function bindConversationArchives({ onRestored, onImportBot }) {
  const trigger = document.getElementById('conversationArchiveBtn');
  if (!trigger) return { setAvailable() {} };
  const dialog = document.createElement('dialog');
  dialog.id = 'conversationArchiveDialog';
  dialog.className = 'work-model-dialog archive-dialog';
  dialog.innerHTML = `<header><h2>归档</h2><button type="button" id="archiveClose">关闭</button></header>
    <section id="archiveBotSection" hidden><h3>单个 Bot</h3><p>选择归档中的资料、会话与记忆，导入为新的 Bot。也可以从 Bot 详情或角色库选择导出。</p><button type="button" id="archiveImportBot">导入 Bot 归档</button></section>
    <p>保存 Bot 人设、群资料、Chat / Work 消息和记忆。账号、模型配置、插件、附件及任务执行记录不在归档中。</p>
    <section><h3>导出全部</h3><p>保存当前会话数据。浏览器里的排序和隐藏偏好单独保留。</p>
      <button type="button" id="archiveExport">导出全部归档</button></section>
    <section><h3>从归档恢复</h3><p>用于将归档恢复到另一份数据中；暂不支持直接回退当前会话。选择文件后先预检，点击“恢复到当前数据”才会写入。</p>
      <label for="archiveImportInput">选择 DimensionAgent 导出的 JSON 文件</label>
      <input type="file" id="archiveImportInput" accept=".json,application/json">
      <label for="archiveConflictPolicy">已有资料</label><select id="archiveConflictPolicy">
        <option value="preserve-existing">保留当前资料和记忆</option><option value="reject-conflicts">有差异时停止恢复</option></select>
      <button type="button" id="archivePrepare" hidden>重新预检</button>
      <div id="archivePreview" hidden><h3>恢复预检</h3><p id="archiveSummary"></p><ul id="archiveIssues"></ul>
        <footer><button type="button" id="archiveCancel">取消预检</button><button type="button" id="archiveRestore">恢复到当前数据</button></footer></div></section>
    <p id="archiveStatus" role="status" aria-live="polite"></p>`;
  document.body.append(dialog);
  const el = id => dialog.querySelector('#' + id);
  let generation = 0, token = null, rawFile = '', fileName = '', plan = null;
  let busy = false, committing = false, ambiguous = false;
  const maxFileBytes = 4 * 1024 * 1024 - 4096;
  const current = ticket => ticket === generation && dialog.open;
  const status = text => { el('archiveStatus').textContent = text; };
  function controls() {
    const blocked = busy || ambiguous;
    for (const id of ['archiveExport', 'archiveImportInput', 'archiveConflictPolicy', 'archivePrepare', 'archiveImportBot']) el(id).disabled = blocked;
    el('archivePrepare').hidden = !rawFile;
    el('archivePreview').hidden = !plan;
    el('archiveCancel').disabled = blocked;
    el('archiveRestore').disabled = busy || !token || (!ambiguous && plan?.canCommit !== true);
    el('archiveRestore').textContent = ambiguous ? '核对恢复结果' : '恢复到当前数据';
  }
  async function request(url, body, method = 'POST', keepalive = false) {
    const response = await fetch(url, { method, headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body }), keepalive });
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch { throw new Error('服务响应不完整，请重试核对结果。'); }
    if (!response.ok) throw Object.assign(new Error(result.error || `请求失败（${response.status}）`), { status: response.status });
    return result;
  }
  async function discard(value, keepalive = false) {
    if (!value) return false;
    try {
      const result = await request(`/api/native/archive/stage/${encodeURIComponent(value)}`, undefined, 'DELETE', keepalive);
      return result.committed === true;
    } catch (error) {
      if (![404, 410].includes(error.status)) throw error;
      return false;
    }
  }
  function clearSelection() {
    token = null; rawFile = ''; fileName = ''; plan = null;
    el('archiveImportInput').value = '';
    el('archiveIssues').replaceChildren(); el('archiveSummary').textContent = '';
  }
  function showPlan(report) {
    const c = report.counts;
    el('archiveSummary').textContent = `${fileName}：将新增 ${c.botsCreated} 个 Bot、${c.groupsCreated} 个群、${c.messagesCreated} 条消息、${c.memoriesCreated} 条记忆。保留当前 ${c.botsPreserved} 个 Bot、${c.groupsPreserved} 个群及 ${c.memoriesPreserved} 条记忆；跳过 ${c.messagesReused + c.messagesTombstoned + c.memoriesReused + c.memoriesTombstoned} 条已处理记录。`;
    const names = {
      source_is_target: '这份归档来自当前应用的数据，不能重复恢复到这里。',
      bot_conflict: 'Bot 资料与当前数据不同', group_conflict: '群资料与当前数据不同',
      group_deleted: '群已被删除', group_member_conflict: '历史群成员不匹配',
      memory_conflict: '记忆与当前数据不同', source_record_changed: '相同来源的记录内容发生变化，不能作为增量同步恢复',
      group_metadata_missing: '缺少对应的群资料',
    };
    el('archiveIssues').replaceChildren();
    for (const issue of report.issues || []) {
      const row = document.createElement('li');
      row.textContent = names[issue.code] || `无法恢复此记录：${issue.code}`;
      el('archiveIssues').append(row);
    }
    if (report.issuesTruncated) {
      const row = document.createElement('li'); row.textContent = `共 ${report.issueCount} 项问题，列表仅显示一部分。`;
      el('archiveIssues').append(row);
    }
  }
  async function prepare(file) {
    if (busy || ambiguous) return;
    const ticket = ++generation;
    busy = true; controls(); status('正在校验归档并检查恢复内容…');
    const oldToken = token;
    try {
      await discard(oldToken);
      if (!current(ticket)) return;
      token = null; plan = null;
      if (file) {
        rawFile = ''; fileName = '';
        if (file.size > maxFileBytes) throw new Error('文件超过本版支持的 4 MiB 上限，未提交任何数据。');
        const bytes = await file.arrayBuffer();
        if (!current(ticket)) return;
        const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        rawFile = decoded; fileName = file.name;
      }
      if (!current(ticket) || !rawFile) return;
      const choice = el('archiveConflictPolicy').value;
      const policies = { bots: choice, memories: choice, groups: choice };
      // Preserve the exact input JSON, including duplicate members, so the
      // server's strict parser sees what the file actually contained.
      const result = await request('/api/native/archive/package/stage', `{"policies":${JSON.stringify(policies)},"package":${rawFile}}`);
      if (!current(ticket)) { await discard(result.token); return; }
      token = result.token; plan = result.report; showPlan(plan);
      status(plan.canCommit ? '预检完成，尚未写入。确认以上内容后可恢复。' : '归档存在冲突，未写入任何数据。');
    } catch (error) { if (current(ticket)) status(error.message); }
    finally { if (ticket === generation) { busy = false; controls(); } }
  }
  el('archiveExport').onclick = async () => {
    if (busy || ambiguous) return;
    const ticket = generation; busy = true; controls(); status('正在生成会话快照…');
    try {
      const response = await fetch('/api/native/archive/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!response.ok) { const error = await response.json(); throw new Error(error.error || '导出失败'); }
      const bytes = await response.arrayBuffer();
      if (!current(ticket)) return;
      const name = /filename="(DimensionAgent-conversations-[0-9]+\.json)"/.exec(response.headers.get('content-disposition') || '')?.[1] || 'DimensionAgent-conversations.json';
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = name;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      status('归档已生成，请在浏览器下载位置查看。');
    } catch (error) { if (current(ticket)) status(error.message); }
    finally { if (ticket === generation) { busy = false; controls(); } }
  };
  el('archiveImportInput').onchange = () => { const file = el('archiveImportInput').files[0]; if (file) void prepare(file); };
  el('archiveConflictPolicy').onchange = () => { if (rawFile) void prepare(); };
  el('archivePrepare').onclick = () => { void prepare(); };
  el('archiveCancel').onclick = async () => {
    if (busy || ambiguous) return;
    const ticket = ++generation;
    busy = true; controls();
    try {
      const committed = await discard(token);
      if (!current(ticket)) return;
      clearSelection();
      status(committed ? '该归档已经提交；取消预检不会撤销已恢复的数据。' : '已取消预检，未写入会话数据。');
      if (committed) await onRestored?.();
    }
    catch (error) { if (current(ticket)) status(`取消失败，可重试：${error.message}`); }
    finally { if (ticket === generation) { busy = false; controls(); } }
  };
  el('archiveRestore').onclick = async () => {
    if (busy || !token || (!ambiguous && !plan?.canCommit)) return;
    busy = true; committing = true; controls();
    status(ambiguous ? '正在核对上次恢复结果…' : '正在恢复，关闭此窗口不会撤销已经开始的提交。');
    const submittedToken = token;
    try {
      await request('/api/native/archive/commit', JSON.stringify({ token: submittedToken }));
      ambiguous = false; clearSelection();
      await discard(submittedToken).catch(() => {});
      status('恢复完成。会话和记忆已保存，现有资料按所选策略保留。');
      try { await onRestored?.(); } catch { status('恢复已完成，列表刷新失败；重新打开应用即可查看。'); }
    } catch (error) {
      if (error.status >= 400 && error.status < 500) {
        ambiguous = false; token = null; plan = null;
        await discard(submittedToken).catch(() => {});
        status(`恢复未提交或暂存已失效：${error.message}。请核对当前会话，再重新预检。`);
      } else {
        ambiguous = true;
        status('未收到明确的恢复结果。点击“核对恢复结果”查询同一次提交，避免重复操作。');
      }
    } finally { busy = false; committing = false; controls(); }
  };
  el('archiveClose').onclick = () => dialog.close();
  el('archiveImportBot').onclick = () => { if (!busy && !ambiguous) { dialog.close(); onImportBot?.(); } };
  dialog.addEventListener('close', () => {
    if (committing || ambiguous) return;
    const ticket = ++generation;
    const oldToken = token; clearSelection(); busy = false; controls();
    void discard(oldToken).then(async committed => {
      if (committed) {
        if (ticket === generation) status('该归档已经提交；关闭预检不会撤销已恢复的数据。');
        await onRestored?.();
      }
    }).catch(() => { if (ticket === generation) status('预检已关闭；服务暂未确认清理，暂存会自动过期。'); });
  });
  window.addEventListener('pagehide', () => {
    if (!committing && !ambiguous && token) void discard(token, true).catch(() => {});
  });
  trigger.onclick = () => { if (!dialog.open) { dialog.showModal(); controls(); } };
  controls();
  return {
    setAvailable: available => { trigger.hidden = available !== true; },
    setBotAvailable: available => { el('archiveBotSection').hidden = available !== true || typeof onImportBot !== 'function'; },
  };
}
