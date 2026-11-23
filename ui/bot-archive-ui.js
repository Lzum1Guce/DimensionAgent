// A Bot archive is data only. Import previews show counts, never package text.
const fields = [
  { key: 'name', label: '名称', hint: 'Bot 的显示名称', unit: '项' },
  { key: 'id', label: 'Bot ID', hint: '便于在导入时保留原 ID', unit: '项' },
  { key: 'persona', label: '自我', hint: '这个 Bot 的特质与自我说明', unit: '项' },
  { key: 'chatHistory', label: 'Chat 会话', hint: '这个 Bot 的私聊消息', unit: '条' },
  { key: 'workHistory', label: 'Work 会话', hint: '这个 Bot 的私聊消息文字', unit: '条' },
  { key: 'longTermMemory', label: '长期记忆', hint: '长期笔记与经验候选', unit: '条' },
  { key: 'relations', label: '人物关系', hint: '与用户及其他人物的关系记录', unit: '项' },
  { key: 'midTermMemory', label: '中期记忆', hint: '带有效期的记忆记录', unit: '条' },
  { key: 'avatar', label: '头像', hint: '将图片保存在同一份归档中', unit: '张' },
];
const defaultExportFields = ['name', 'persona', 'longTermMemory', 'relations', 'midTermMemory'];
const limits = { maxPackageBytes: 16 * 1024 * 1024 - 8192, maxBodyBytes: 16 * 1024 * 1024, maxAvatarBytes: 8 * 1024 * 1024 };
const bytesLabel = bytes => {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return '大小未知';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MiB';
};
const encoder = new TextEncoder();
const selectionKey = values => fields.filter(field => values.includes(field.key)).map(field => field.key).join(',');
const validFields = values => Array.isArray(values) && values.length === new Set(values).size && values.every(key => fields.some(field => field.key === key));
const exactBytesLabel = bytes => bytesLabel(bytes) + '（' + bytes.toLocaleString() + ' 字节）';
const serviceError = (result, httpStatus) => {
  const messages = {
    bot_archive_avatar_missing: '这个 Bot 没有头像，请取消“头像”后重新导出。',
    bot_archive_text_size: '所选文字与会话超过容量上限，请减少导出项目。',
    bot_archive_history_count: '所选会话记录过多，请减少导出项目。',
    bot_archive_avatar_size: '归档中的头像超过允许大小，请换用较小的头像后重新导出。',
    bot_archive_package_size: '归档超过容量上限，请减少导出项目后重试。',
    bot_archive_body_size: '归档超过可接收大小，请减少导出项目后重试。',
    bot_archive_stage_capacity: '打开的归档预览过多，请先关闭其他预览后重试。',
    bot_archive_stage_missing: '这次预览已失效，请重新预览所选内容。',
    bot_archive_stage_expired: '这次预览已过期，请重新预览所选内容。',
    bot_archive_stage_blocked: '请先选择导入内容并解决预览中的冲突。',
    bot_archive_checksum: '归档校验失败，文件可能不完整或已被修改，请重新导出。',
    bot_archive_format: '这不是当前版本支持的 Bot 归档，请选择导出的 Bot JSON 文件。',
    bot_archive_field_absent: '归档未包含所选内容，请重新选择并预览。',
    bot_archive_preserve_id: '保留原 ID 需要选择归档中的 Bot ID，请重新预览。',
    bot_archive_avatar_target_exists: '目标头像已发生变化，请重新预览后再确认。',
  };
  if (messages[result?.code]) return messages[result.code];
  if (httpStatus === 413) return '归档超过允许大小，请减少导出内容后重试。';
  if (httpStatus === 429) return '归档服务正忙，请稍后重试。';
  if (httpStatus === 409) return '资料已发生变化或存在冲突，请重新预览后再确认。';
  if (httpStatus === 404 || httpStatus === 410) return '归档对象或预览已失效，请重新打开后重试。';
  if (httpStatus >= 400 && httpStatus < 500) return '归档格式或内容无效，请选择完整的 Bot 归档文件后重试。';
  return '归档服务暂时无法完成操作，请稍后重试。';
};

export function bindBotArchives({ onImported } = {}) {
  const dialog = document.createElement('dialog');
  dialog.id = 'botArchiveDialog';
  dialog.className = 'work-model-dialog bot-archive-dialog';
  dialog.setAttribute('aria-labelledby', 'botArchiveTitle');
  dialog.innerHTML = [
    '<header><h2 id="botArchiveTitle">Bot 归档</h2><button type="button" id="botArchiveClose">关闭</button></header>',
    '<nav class="bot-archive-tabs" aria-label="归档操作"><button type="button" id="botArchiveExportTab" aria-pressed="true">导出 Bot</button><button type="button" id="botArchiveImportTab" aria-pressed="false">导入 Bot</button></nav>',
    '<section id="botArchiveExportPanel"><h3 id="botArchiveSource"></h3>',
    '<p>选择这次要保存的内容。</p><fieldset class="bot-archive-fieldset"><legend>导出内容</legend><div class="bot-archive-fields" id="botArchiveExportFields"></div></fieldset>',
    '<footer><span id="botArchiveExportSelection"></span><button type="button" class="bot-archive-primary" id="botArchiveExport">导出归档</button></footer>',
    '<p id="botArchiveExportResult" class="bot-archive-summary" hidden></p></section>',
    '<section id="botArchiveImportPanel" hidden><label class="bot-archive-file-label" for="botArchiveFile">选择 Bot 归档</label>',
    '<input type="file" id="botArchiveFile" accept=".json,application/json"><p id="botArchiveFileSummary" class="bot-archive-summary">选择文件后先查看内容数量，再勾选要导入的项目。</p>',
    '<div id="botArchiveImportChoices" hidden><div class="bot-archive-choice-heading"><h3>选择导入内容</h3><button type="button" id="botArchiveSelectAll">选中全部资料</button></div>',
    '<p>默认创建新 ID。保留原 Bot ID 需单独勾选。</p>',
    '<fieldset class="bot-archive-fieldset"><legend>归档中的内容</legend><div class="bot-archive-fields" id="botArchiveImportFields"></div></fieldset>',
    '<div class="bot-archive-preview-action"><span id="botArchiveSelectionSummary"></span><button type="button" id="botArchivePrepare">预览所选内容</button></div></div>',
    '<section id="botArchivePreview" class="bot-archive-preview" hidden><h3>导入预览</h3><p id="botArchiveTarget" class="bot-archive-summary"></p>',
    '<ul id="botArchiveCounts" class="bot-archive-counts"></ul><ul id="botArchiveConflicts" class="bot-archive-conflicts"></ul>',
    '<footer><button type="button" id="botArchiveCancel">取消预览</button><button type="button" class="bot-archive-primary" id="botArchiveCommit">确认导入</button></footer></section>',
    '<p id="botArchiveImportDone" class="bot-archive-summary" hidden></p></section>',
    '<p id="botArchiveLimits" class="bot-archive-limits">正在读取归档容量限制…</p>',
    '<p id="botArchiveStatus" class="bot-archive-status" role="status" aria-live="polite"></p>',
  ].join('');
  document.body.append(dialog);
  const el = id => dialog.querySelector('#' + id);
  const inputs = { export: new Map(), import: new Map() };
  let available = false, capabilitiesReady = false, mode = 'export', bot = null, generation = 0;
  let busy = false, committing = false, ambiguous = false, token = null;
  let rawFile = '', fileName = '', fileBytes = 0, inventory = null, plan = null, planKey = '';
  let afterCreated = null;
  const status = text => { el('botArchiveStatus').textContent = text; };
  const current = ticket => ticket === generation && dialog.open;
  const selected = kind => fields.filter(field => inputs[kind].get(field.key).checked).map(field => field.key);
  const matchesPlan = () => !!plan && planKey === selectionKey(selected('import'));

  for (const kind of ['export', 'import']) {
    const container = el(kind === 'export' ? 'botArchiveExportFields' : 'botArchiveImportFields');
    for (const field of fields) {
      const label = document.createElement('label'); label.className = 'bot-archive-choice';
      const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.field = field.key;
      input.id = 'botArchive-' + kind + '-' + field.key;
      const main = document.createElement('span'); main.className = 'bot-archive-choice-main';
      const title = document.createElement('strong');
      title.textContent = kind === 'import' && field.key === 'id' ? '保留原 Bot ID' : field.label;
      const hint = document.createElement('small');
      hint.textContent = kind === 'import' && field.key === 'id' ? '已有相同 ID 时会提示冲突' : field.hint;
      main.append(title, hint);
      if (kind === 'import') {
        const count = document.createElement('span'); count.className = 'bot-archive-field-count';
        count.dataset.countFor = field.key; main.append(count);
      }
      label.append(input, main); container.append(label); inputs[kind].set(field.key, input);
      input.addEventListener('change', () => {
        if (kind === 'export') el('botArchiveExportResult').hidden = true;
        else { el('botArchiveImportDone').hidden = true; renderPlan(); }
        controls();
      });
    }
  }

  function setMode(value) {
    mode = value;
    el('botArchiveExportPanel').hidden = mode !== 'export';
    el('botArchiveImportPanel').hidden = mode !== 'import';
    el('botArchiveExportTab').setAttribute('aria-pressed', String(mode === 'export'));
    el('botArchiveImportTab').setAttribute('aria-pressed', String(mode === 'import'));
    controls();
  }
  function controls() {
    const blocked = busy || ambiguous || !capabilitiesReady;
    el('botArchiveExportTab').disabled = blocked || !bot;
    el('botArchiveImportTab').disabled = blocked;
    el('botArchiveFile').disabled = blocked;
    el('botArchiveExport').disabled = blocked || !bot || !selected('export').length;
    el('botArchivePrepare').disabled = blocked || !rawFile || !selected('import').length;
    el('botArchiveSelectAll').disabled = blocked || !inventory;
    el('botArchiveCancel').disabled = blocked;
    el('botArchiveCommit').disabled = busy || !token || (!ambiguous && (!matchesPlan() || plan?.canCommit !== true));
    el('botArchiveCommit').textContent = ambiguous ? '核对导入结果' : '确认导入';
    for (const [key, input] of inputs.export) input.disabled = blocked;
    for (const [key, input] of inputs.import) input.disabled = blocked || !inventory?.availableFields.includes(key);
    el('botArchiveExportSelection').textContent = '已选 ' + selected('export').length + ' 项';
    const count = selected('import').length;
    el('botArchiveSelectionSummary').textContent = count ? '已选 ' + count + ' 项' + (matchesPlan() ? '' : '，请预览当前选择') : '请勾选要导入的内容';
  }
  function clearImport(resetFile = true) {
    token = null; rawFile = ''; fileName = ''; fileBytes = 0; inventory = null; plan = null; planKey = '';
    if (resetFile) el('botArchiveFile').value = '';
    for (const input of inputs.import.values()) input.checked = false;
    el('botArchiveImportChoices').hidden = true; el('botArchivePreview').hidden = true;
    el('botArchiveImportDone').hidden = true;
    el('botArchiveFileSummary').textContent = '选择文件后先查看内容数量，再勾选要导入的项目。';
    el('botArchiveCounts').replaceChildren(); el('botArchiveConflicts').replaceChildren();
  }
  async function request(route, body, method = 'POST', keepalive = false) {
    const response = await fetch(route, {
      method, headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body }), keepalive,
      ...(keepalive ? {} : { signal: AbortSignal.timeout(60000) }),
    });
    const text = await response.text(); let result;
    try { result = JSON.parse(text); } catch {}
    if (!response.ok) throw Object.assign(new Error(serviceError(result, response.status)), { status: response.status });
    if (!result || typeof result !== 'object') throw new Error('服务返回的内容不完整，请重试核对结果。');
    return result;
  }
  async function discard(value, keepalive = false) {
    if (!value) return;
    try { return (await request('/api/native/bot-archive/stage/' + encodeURIComponent(value), undefined, 'DELETE', keepalive)).committed === true; }
    catch (error) { if (![404, 410].includes(error.status)) throw error; }
  }
  async function readCapabilities(ticket) {
    const result = await request('/api/native/bot-archive/capabilities', undefined, 'GET');
    if (!validFields(result.fields) || result.fields.length !== fields.length || result.existingIdOverwrite !== false || result.defaultNewId !== true) {
      throw new Error('当前服务的归档规则不完整，请重新打开归档窗口。');
    }
    for (const key of ['maxPackageBytes', 'maxBodyBytes', 'maxAvatarBytes', 'maxTextBytes']) {
      if (!Number.isSafeInteger(result[key]) || result[key] <= 0) throw new Error('当前服务未提供有效的归档容量限制。');
    }
    if (!current(ticket)) return;
    Object.assign(limits, { maxPackageBytes: result.maxPackageBytes, maxBodyBytes: result.maxBodyBytes, maxAvatarBytes: result.maxAvatarBytes });
    el('botArchiveLimits').textContent = '归档上限 ' + exactBytesLabel(result.maxPackageBytes) + '；头像最多 ' + bytesLabel(result.maxAvatarBytes)
      + '，文字与会话最多 ' + bytesLabel(result.maxTextBytes) + '。内容较多时，请减少导出项目。任务交接可从任务卡单独导出。';
  }
  function checkedCounts(counts) {
    if (!counts || fields.some(field => !Number.isSafeInteger(counts[field.key]) || counts[field.key] < 0)) {
      throw new Error('归档数量信息不完整，暂不能继续。');
    }
    return counts;
  }
  function countsText(keys, counts) {
    return fields.filter(field => keys.includes(field.key)).map(field => {
      let text = field.label + ' ' + counts[field.key] + ' ' + field.unit;
      if (field.key === 'avatar' && counts.avatar && Number.isSafeInteger(counts.avatarBytes)) text += '（' + bytesLabel(counts.avatarBytes) + '）';
      return text;
    }).join(' · ');
  }
  function showInventory(report) {
    checkedCounts(report.counts); checkedCounts(report.selectedCounts);
    if (!validFields(report.availableFields)) throw new Error('归档包含当前版本不支持的内容。');
    inventory = report; el('botArchiveImportChoices').hidden = false;
    el('botArchiveFileSummary').textContent = fileName + ' · ' + exactBytesLabel(fileBytes);
    for (const field of fields) {
      const present = report.availableFields.includes(field.key);
      if (!present) inputs.import.get(field.key).checked = false;
      const count = dialog.querySelector('[data-count-for="' + field.key + '"]');
      count.textContent = present ? report.counts[field.key] + ' ' + field.unit : '归档未包含';
    }
  }
  function conflictText(conflict) {
    const code = String(conflict.code || '');
    if (/id.*conflict|conflict.*id|id.*exists/.test(code)) return '这个 Bot ID 已被使用。可取消“保留原 Bot ID”后重新预览。';
    if (/source|import.*changed|selection/.test(code)) return '此前的导入记录与归档不一致，请先核对已导入的 Bot。';
    if (/avatar/.test(code)) return '头像内容无法导入，请重新选择导出内容。';
    if (/mid_memory.*limit/.test(code)) return '中期记忆数量已达上限，请减少选择或整理当前记忆后重试。';
    if (/replay_incomplete/.test(code)) return '已导入的记录不完整，请先核对这个 Bot 后再试。';
    return '归档存在冲突，请核对所选内容后重新预览。';
  }
  function renderPlan() {
    const show = !!plan && (selected('import').length > 0 || ambiguous);
    el('botArchivePreview').hidden = !show;
    if (!show) return;
    const matching = matchesPlan();
    const target = plan.target || {};
    el('botArchiveTarget').textContent = !matching ? '选择已改变，请重新预览后确认。'
      : target.isNew === false ? '这份归档与选择已导入，将核对 Bot：' + String(target.id || '') + '。保留当前修改和删除。'
      : (target.preserveId ? '将创建 Bot，保留原 ID：' : target.newCopy ? '将创建独立的 Bot 副本，使用新 ID：' : '将创建 Bot，使用新 ID：') + String(target.id || '确认后生成');
    el('botArchiveCounts').replaceChildren(); el('botArchiveConflicts').replaceChildren();
    if (!matching) return;
    const selectedCounts = checkedCounts(plan.selectedCounts);
    for (const field of fields.filter(field => selected('import').includes(field.key))) {
      const row = document.createElement('li'); row.textContent = field.label + '：' + selectedCounts[field.key] + ' ' + field.unit;
      el('botArchiveCounts').append(row);
    }
    for (const conflict of plan.conflicts || []) {
      const row = document.createElement('li'); row.textContent = conflictText(conflict); el('botArchiveConflicts').append(row);
    }
  }
  async function prepare(file) {
    if (busy || ambiguous) return;
    const ticket = ++generation, oldToken = token;
    busy = true; token = null; plan = null; planKey = ''; controls(); renderPlan();
    status(file ? '正在读取归档内容数量…' : '正在核对所选内容与 ID…');
    try {
      await discard(oldToken);
      if (!current(ticket)) return;
      if (file) {
        clearImport(false);
        if (file.size > limits.maxBodyBytes) throw new Error('文件为 ' + exactBytesLabel(file.size) + '，超过可接收的 ' + bytesLabel(limits.maxBodyBytes) + ' 上限。请减少导出内容后重试。');
        const bytes = await file.arrayBuffer();
        if (!current(ticket)) return;
        try { rawFile = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { throw new Error('归档文件不是有效的 UTF-8 文字，请重新选择导出的 JSON 文件。'); }
        fileName = file.name; fileBytes = file.size;
      }
      const choices = file ? [] : selected('import');
      if (!rawFile) throw new Error('请先选择归档文件。');
      const body = '{"package":' + rawFile + ',"fields":' + JSON.stringify(choices) + ',"preserveId":' + choices.includes('id') + '}';
      if (encoder.encode(body).length > limits.maxBodyBytes) throw new Error('这份归档超过本次可接收大小，请减少导出内容后重试。');
      const result = await request('/api/native/bot-archive/stage', body);
      if (!current(ticket)) { await discard(result.token); return; }
      if (typeof result.token !== 'string' || !result.token || !validFields(result.report?.selectedFields) || selectionKey(result.report.selectedFields) !== selectionKey(choices)) {
        await discard(result.token); throw new Error('预览与所选内容不一致，请重新预览。');
      }
      token = result.token; showInventory(result.report); plan = result.report; planKey = selectionKey(choices);
      renderPlan();
      status(!choices.length ? '已读取数量，尚未导入。请勾选需要的内容。'
        : plan.canCommit ? '预览完成，确认后才会导入。' : '存在冲突，尚未导入。请查看预览提示。');
      if (choices.length) el('botArchivePreview').scrollIntoView({ block: 'nearest' });
    } catch (error) { if (current(ticket)) { if (file) el('botArchiveFile').value = ''; status(error.message || '归档读取失败，请重新选择。'); } }
    finally { if (ticket === generation) { busy = false; controls(); } }
  }
  async function exportBot() {
    if (busy || ambiguous || !bot) return;
    const ticket = generation, choices = selected('export');
    if (!choices.length) return;
    busy = true; controls(); status('正在生成所选内容的归档…');
    try {
      const response = await fetch('/api/native/bot-archive/export', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ botId: bot.id, fields: choices }), signal: AbortSignal.timeout(60000) });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(serviceError(result, response.status));
      }
      const bytes = await response.arrayBuffer();
      if (!current(ticket)) return;
      if (bytes.byteLength > limits.maxPackageBytes) throw new Error('生成的归档超过 ' + exactBytesLabel(limits.maxPackageBytes) + ' 上限，请减少选择后重试。');
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const counts = checkedCounts(value.counts);
      if (!validFields(value.fields) || selectionKey(value.fields) !== selectionKey(choices)) throw new Error('归档内容与选择不一致，未下载，请重试。');
      const disposition = response.headers.get('content-disposition') || '';
      const provided = /filename="([^"]+)"/i.exec(disposition)?.[1] || 'DimensionAgent-bot.json';
      const filename = provided.replace(/[\x00-\x1f\\/:*?"<>|]/g, '_').slice(0, 180);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = filename;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      el('botArchiveExportResult').textContent = exactBytesLabel(bytes.byteLength) + ' · ' + countsText(choices, counts);
      el('botArchiveExportResult').hidden = false;
      status('归档已生成，请在下载位置查看。');
    } catch (error) { if (current(ticket)) status(error.message || '导出失败，请重试。'); }
    finally { if (ticket === generation) { busy = false; controls(); } }
  }
  async function commit() {
    if (busy || !token || (!ambiguous && (!matchesPlan() || !plan?.canCommit))) return;
    busy = true; committing = true; controls();
    const submitted = token, summary = plan;
    status(ambiguous ? '正在核对上次导入结果…' : '正在导入，关闭窗口不会撤销已经开始的导入。');
    try {
      const result = await request('/api/native/bot-archive/commit', JSON.stringify({ token: submitted }));
      if (!result.bot?.id) throw new Error('服务未返回完整的导入结果。');
      ambiguous = false; clearImport();
      const imported = result.bots?.find(item => item.id === result.bot.id) || result.bot;
      el('botArchiveImportDone').textContent = (result.idempotent ? '已核对导入结果：' : '已导入：') + String(imported.name || 'Bot') + ' · ID ' + result.bot.id + '\n' + countsText(summary?.selectedFields || [], summary?.selectedCounts || {});
      el('botArchiveImportDone').hidden = false; status('导入完成，可在角色库中查看这个 Bot。');
      await discard(submitted).catch(() => {});
      try { await onImported?.(result); await afterCreated?.(result); }
      catch { status('Bot 已导入，列表暂未刷新。重新打开角色库即可查看。'); }
    } catch (error) {
      if (error.status >= 400 && error.status < 500) {
        ambiguous = false; token = null; plan = null; planKey = ''; renderPlan();
        await discard(submitted).catch(() => {});
        status('导入未完成或预览已失效：' + error.message + ' 请核对角色库后重新预览。');
      } else {
        ambiguous = true; status('未收到明确的导入结果。请点击“核对导入结果”，避免重复创建 Bot。');
      }
    } finally { busy = false; committing = false; controls(); }
  }
  async function cancelPreview() {
    if (busy || ambiguous) return;
    const ticket = ++generation, oldToken = token; busy = true; controls();
    try {
      const committed = await discard(oldToken);
      if (!current(ticket)) return;
      clearImport(); status(committed ? '这份归档已经导入，取消预览不会撤销结果。' : '已取消预览，未导入任何内容。');
      if (committed) await onImported?.();
    }
    catch (error) { if (current(ticket)) status('取消未完成，可重试：' + error.message); }
    finally { if (ticket === generation) { busy = false; controls(); } }
  }
  function open(value, selectedBot, callback) {
    if (!available) return;
    if (committing || ambiguous) { if (!dialog.open) dialog.showModal(); setMode('import'); return; }
    const ticket = ++generation, oldToken = token; clearImport(); busy = true; capabilitiesReady = false;
    void discard(oldToken).catch(() => {});
    bot = selectedBot || null; afterCreated = callback || null;
    for (const [key, input] of inputs.export) input.checked = defaultExportFields.includes(key);
    el('botArchiveSource').textContent = bot ? String(bot.name || bot.id) : '选择一个 Bot 后可导出';
    el('botArchiveExportResult').hidden = true; status('正在读取归档选项…');
    setMode(value);
    if (!dialog.open) dialog.showModal();
    void readCapabilities(ticket).then(() => {
      if (!current(ticket)) return;
      capabilitiesReady = true; status('');
    }).catch(error => { if (current(ticket)) status(error.message); })
      .finally(() => { if (ticket === generation) { busy = false; controls(); } });
  }
  el('botArchiveClose').onclick = () => dialog.close();
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  el('botArchiveExportTab').onclick = () => { if (!busy && !ambiguous && bot) { setMode('export'); status(''); } };
  el('botArchiveImportTab').onclick = () => { if (!busy && !ambiguous) { setMode('import'); status(''); } };
  el('botArchiveFile').onchange = () => { const file = el('botArchiveFile').files?.[0]; if (file) void prepare(file); };
  el('botArchivePrepare').onclick = () => { void prepare(); };
  el('botArchiveExport').onclick = () => { void exportBot(); };
  el('botArchiveCommit').onclick = () => { void commit(); };
  el('botArchiveCancel').onclick = () => { void cancelPreview(); };
  el('botArchiveSelectAll').onclick = () => {
    if (busy || ambiguous || !inventory) return;
    for (const [key, input] of inputs.import) if (key !== 'id') input.checked = inventory.availableFields.includes(key);
    renderPlan(); controls();
  };
  dialog.addEventListener('close', () => {
    if (committing || ambiguous) return;
    ++generation; const oldToken = token; clearImport(); busy = false; controls();
    void discard(oldToken).catch(() => { status('预览已关闭，暂存会自动过期。'); });
  });
  window.addEventListener('pagehide', () => { if (!committing && !ambiguous && token) void discard(token, true).catch(() => {}); });
  controls();
  return {
    get available() { return available; },
    openExport: selectedBot => open('export', selectedBot),
    openImport: options => open('import', null, options?.onCreated),
    setAvailable: value => {
      available = value === true;
      document.querySelectorAll('[data-bot-archive-entry]').forEach(entry => { entry.hidden = !available; });
    },
  };
}
