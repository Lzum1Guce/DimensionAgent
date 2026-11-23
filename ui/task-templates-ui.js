const node = (tag, className, text) => {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

const requestFor = (cache, key) => {
  if (!cache.has(key)) cache.set(key, crypto.randomUUID());
  return cache.get(key);
};

export function bindTaskTemplates({ api, getTargets }) {
  const dialog = node('dialog', 'capability-dialog task-template-dialog');
  dialog.setAttribute('aria-labelledby', 'taskTemplateTitle');
  dialog.innerHTML = `<header><h2 id="taskTemplateTitle">任务模板</h2><button type="button" class="task-template-close" aria-label="关闭">关闭</button></header>
    <p class="cap-description">保存可复用的 Work 流程。模板不包含上次审批、密钥、工具授权、任务编号或运行状态；保存和编辑不会创建任务。</p>
    <p class="cap-status" role="status" aria-live="polite"></p>
    <div class="task-template-toolbar"><button type="button" class="task-template-new">新建模板</button></div>
    <div class="task-template-layout">
      <section class="task-template-list" aria-label="已保存的任务模板"></section>
      <form class="task-template-editor" hidden>
        <h3 class="task-template-editor-title">新建模板</h3>
        <label>名称<input name="name" maxlength="240" required placeholder="例如：发布前检查"></label>
        <label>说明<textarea name="description" rows="3" maxlength="4000" placeholder="这个流程适用于什么情况"></textarea></label>
        <label>适用范围<select name="scope" required><option value="private">Bot 私聊</option><option value="group">群</option></select></label>
        <label>任务正文 / 步骤<textarea name="body" rows="12" maxlength="65536" required placeholder="步骤一：……&#10;步骤二：……"></textarea></label>
        <div class="cap-actions"><button type="submit" class="task-template-save">保存模板</button><button type="button" class="task-template-delete" hidden>删除</button></div>
      </form>
    </div>
    <form class="task-template-use" hidden>
      <h3>用于新任务</h3>
      <p class="task-template-use-name"></p>
      <label class="task-template-group-field">目标群<select name="groupId"></select></label>
      <label>目标 Bot<select name="botId" required></select></label>
      <p class="task-template-target" role="status"></p>
      <pre class="task-template-preview"></pre>
      <p class="task-template-use-note">点击“用于新任务”后才提交；会创建排队的新 Work，不会补充或恢复历史任务。</p>
      <div class="cap-actions"><button type="submit" class="task-template-use-submit">用于新任务</button><button type="button" class="task-template-use-cancel">取消</button></div>
    </form>`;
  document.body.append(dialog);

  const $ = selector => dialog.querySelector(selector);
  const list = $('.task-template-list'), editor = $('.task-template-editor'), useForm = $('.task-template-use');
  const status = text => { $('.cap-status').textContent = text; };
  const scopeName = scope => scope === 'group' ? '群' : 'Bot 私聊';
  const requestIds = new Map();
  let rows = [], selectedId = null, useTemplate = null, loadVersion = 0, saving = false, deleting = false, submitting = false;

  const currentTemplate = () => rows.find(row => row.id === selectedId) || null;
  const formValue = () => ({
    name: editor.elements.name.value,
    description: editor.elements.description.value,
    scope: editor.elements.scope.value,
    body: editor.elements.body.value,
  });

  const syncBusy = () => {
    editor.querySelectorAll('input,textarea,select,button').forEach(field => { field.disabled = saving || deleting; });
    $('.task-template-new').disabled = saving || deleting;
    useForm.querySelectorAll('select,button').forEach(field => { field.disabled = submitting; });
  };

  const closeUse = () => {
    useTemplate = null;
    useForm.hidden = true;
    useForm.reset();
  };

  const edit = row => {
    closeUse();
    selectedId = row?.id || null;
    editor.hidden = false;
    $('.task-template-editor-title').textContent = row ? '编辑模板' : '新建模板';
    editor.elements.name.value = row?.name || '';
    editor.elements.description.value = row?.description || '';
    editor.elements.scope.value = row?.scope || 'private';
    editor.elements.body.value = row?.body || '';
    $('.task-template-delete').hidden = !row;
    renderList();
    status(row ? '编辑只影响之后的手动复用，不修改历史任务。' : '填写流程后保存；保存本身不会创建任务。');
  };

  const openUse = row => {
    useTemplate = row;
    useForm.hidden = false;
    $('.task-template-use-name').textContent = `${row.name} · 适用范围：${scopeName(row.scope)}`;
    $('.task-template-preview').textContent = row.body;
    const targets = getTargets() || { bots: [], groups: [] };
    const bots = (targets.bots || []).filter(bot => bot && (bot.work === true || bot.inWork === true));
    const groups = (targets.groups || []).filter(group => group && (group.inWork === true || group.work === true));
    const groupSelect = useForm.elements.groupId;
    $('.task-template-group-field').hidden = row.scope !== 'group';
    groupSelect.required = row.scope === 'group';
    groupSelect.replaceChildren(...groups.map(group => {
      const option = node('option', '', `${group.name || group.id}（${group.id}）`);
      option.value = group.id;
      return option;
    }));
    if (targets.activeGroupId && groups.some(group => group.id === targets.activeGroupId)) groupSelect.value = targets.activeGroupId;

    const refreshBots = () => {
      const group = groups.find(item => item.id === groupSelect.value);
      const eligible = row.scope === 'group' ? bots.filter(bot => group?.members?.includes(bot.id)) : bots;
      const previous = useForm.elements.botId.value;
      useForm.elements.botId.replaceChildren(...eligible.map(bot => {
        const option = node('option', '', `${bot.name || bot.id}（${bot.id}）`);
        option.value = bot.id;
        return option;
      }));
      const preferred = eligible.some(bot => bot.id === previous) ? previous : targets.activeBotId;
      if (eligible.some(bot => bot.id === preferred)) useForm.elements.botId.value = preferred;
      const selectedBot = eligible.find(bot => bot.id === useForm.elements.botId.value);
      $('.task-template-target').textContent = row.scope === 'group'
        ? `范围：群；目标群：${group?.name || '未选择'}；执行 Bot：${selectedBot?.name || '未选择'}`
        : `范围：Bot 私聊；目标 Bot：${selectedBot?.name || '未选择'}`;
    };
    groupSelect.onchange = refreshBots;
    useForm.elements.botId.onchange = refreshBots;
    refreshBots();
    syncBusy();
    status('请核对目标与范围。此时尚未提交任务。');
    useForm.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  function renderList() {
    const cards = rows.map(row => {
      const card = node('article', 'task-template-card');
      card.classList.toggle('active', row.id === selectedId);
      const editButton = node('button', 'task-template-card-edit', row.name);
      editButton.type = 'button';
      editButton.onclick = () => edit(row);
      card.append(editButton, node('small', '', `${scopeName(row.scope)} · 版本 ${row.revision}`));
      if (row.description) card.append(node('p', '', row.description));
      const useButton = node('button', 'task-template-use-open', '用于新任务');
      useButton.type = 'button';
      useButton.dataset.templateId = row.id;
      useButton.onclick = () => openUse(row);
      card.append(useButton);
      return card;
    });
    list.replaceChildren(...cards);
    if (!rows.length) list.append(node('p', 'task-template-empty', '还没有任务模板。保存后，只有手动点击“用于新任务”才会创建 Work。'));
  }

  async function load() {
    const ticket = ++loadVersion;
    status('正在加载模板…');
    try {
      const result = await api('/api/dimension/work/templates');
      if (ticket !== loadVersion || !dialog.open) return;
      rows = Array.isArray(result.templates) ? result.templates : [];
      if (selectedId && !rows.some(row => row.id === selectedId)) { selectedId = null; editor.hidden = true; }
      if (useTemplate) {
        const current = rows.find(row => row.id === useTemplate.id);
        if (!current) closeUse();
      }
      renderList();
      status('模板已加载。读取、保存、编辑和删除均不会创建任务。');
    } catch (error) {
      if (ticket === loadVersion) status(error.message);
    }
  }

  editor.onsubmit = async event => {
    event.preventDefault();
    if (saving || deleting) return;
    const before = currentTemplate(), value = formValue();
    const signature = JSON.stringify({ id: before?.id || '', revision: before?.revision || 0, ...value });
    const requestId = requestFor(requestIds, 'save:' + signature);
    saving = true; syncBusy(); status('正在保存模板；不会创建任务…');
    try {
      const payload = { ...value, requestId, ...(before ? { revision: before.revision } : {}) };
      const result = await api(before ? '/api/dimension/work/templates/' + encodeURIComponent(before.id) : '/api/dimension/work/templates', {
        method: before ? 'PATCH' : 'POST', body: JSON.stringify(payload),
      });
      const saved = result.template;
      rows = [...rows.filter(row => row.id !== saved.id), saved];
      selectedId = saved.id;
      requestIds.delete('save:' + signature);
      closeUse(); // Do not let a stale preview submit a different saved revision.
      renderList();
      $('.task-template-delete').hidden = false;
      $('.task-template-editor-title').textContent = '编辑模板';
      status(result.duplicate ? '已确认此前的保存结果，没有重复创建模板或任务。' : '模板已保存，未创建任务。');
    } catch (error) { status(error.message + '；可使用相同内容重试。'); }
    finally { saving = false; syncBusy(); }
  };

  $('.task-template-delete').onclick = async () => {
    const row = currentTemplate();
    if (!row || saving || deleting) return;
    const ok = window.__dimensionConfirm
      ? await window.__dimensionConfirm({ title: '删除任务模板', message: `删除模板“${row.name}”？历史任务不受影响。`, confirmLabel: '删除模板', danger: true })
      : window.confirm(`删除模板“${row.name}”？历史任务不受影响。`);
    if (!ok) return;
    const key = `delete:${row.id}:${row.revision}`, requestId = requestFor(requestIds, key);
    deleting = true; syncBusy(); status('正在删除模板；历史任务不受影响…');
    try {
      await api('/api/dimension/work/templates/' + encodeURIComponent(row.id), {
        method: 'DELETE', body: JSON.stringify({ revision: row.revision, requestId }),
      });
      rows = rows.filter(item => item.id !== row.id);
      requestIds.delete(key);
      selectedId = null; editor.hidden = true; closeUse(); renderList();
      status('模板已删除；历史任务保持不变。');
    } catch (error) { status(error.message); }
    finally { deleting = false; syncBusy(); }
  };

  useForm.onsubmit = async event => {
    event.preventDefault();
    if (!useTemplate || submitting) return;
    const botId = useForm.elements.botId.value, groupId = useTemplate.scope === 'group' ? useForm.elements.groupId.value : '';
    if (!botId || (useTemplate.scope === 'group' && !groupId)) { status('请选择有效的目标 Bot 和群。'); return; }
    const key = `use:${useTemplate.id}:${useTemplate.revision}:${botId}:${groupId}`;
    const requestId = requestFor(requestIds, key);
    submitting = true; syncBusy(); status('正在手动提交一个新 Work…');
    try {
      const result = await api('/api/dimension/work/templates/' + encodeURIComponent(useTemplate.id) + '/use', {
        method: 'POST', body: JSON.stringify({ botId, ...(groupId ? { groupId } : {}), requestId }),
      });
      const target = result.target;
      const destination = target.scope === 'group' ? `${target.groupName} / ${target.botName}` : target.botName;
      status(result.duplicate
        ? `已确认原任务 ${result.run.id}，目标：${destination}；没有重复执行。`
        : `已创建新任务 ${result.run.id}，目标：${destination}，范围：${scopeName(target.scope)}。`);
    } catch (error) { status(error.message + '；重试会沿用本次请求编号，避免重复执行。'); }
    finally { submitting = false; syncBusy(); }
  };

  $('.task-template-new').onclick = () => edit(null);
  $('.task-template-use-cancel').onclick = closeUse;
  $('.task-template-close').onclick = () => dialog.close();
  dialog.onclose = () => { loadVersion++; closeUse(); };
  document.getElementById('sharedTaskTemplatesBtn')?.addEventListener('click', () => {
    if (!dialog.open) dialog.showModal();
    renderList();
    void load();
  });
}
