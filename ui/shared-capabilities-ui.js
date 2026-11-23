const node = (tag, className, text) => {
  const el = document.createElement(tag); el.className = className;
  if (text !== undefined) el.textContent = text; return el;
};

export function bindSharedCapabilities({ api }) {
  const dialog = node('dialog', 'capability-dialog');
  dialog.innerHTML = `<header><h2>公共能力</h2><button type="button" class="cap-close" aria-label="关闭">关闭</button></header>
    <nav><button type="button" data-tab="skills">Skill</button><button type="button" data-tab="plugins">插件</button><button type="button" data-tab="studio">工位装备与能力卡</button></nav>
    <p class="cap-description"></p><p class="cap-status" role="status"></p>
    <section class="cap-skills"><div class="cap-actions"><button type="button" class="cap-new">新增 Skill</button><label class="cap-import-label">导入 .md<input class="cap-import" type="file" accept=".md,.txt" hidden></label></div>
      <div class="cap-skill-layout"><div class="cap-list" aria-label="共享 Skill 列表"></div>
      <form class="cap-skill-form" hidden><label>名称<input name="title" maxlength="100" required></label><label>关键词<input name="keywords" placeholder="例如：网页，测试，Chrome" required></label><label>内容<textarea name="body" rows="12" maxlength="60000" required></textarea></label><div class="cap-actions"><button type="submit">保存 Skill</button><button type="button" class="cap-delete">删除</button></div></form></div></section>
    <section class="cap-plugins" hidden><div class="cap-market-host" hidden></div><div class="cap-legacy-plugins"><form class="cap-plugin-form"><label>本地插件目录<input name="path" placeholder="填写包含 package.json 的插件目录" required></label><button type="submit">安装插件</button></form><div class="cap-plugin-list"></div></div></section>
    <section class="cap-studio" hidden></section>`;
  document.body.append(dialog);
  const el = selector => dialog.querySelector(selector), form = el('.cap-skill-form');
  let tab = 'skills', rows = [], selected = null, version = 0, editorVersion = 0;
  let market = null, marketLoading = null;
  let studioPanel = null, studioLoading = null;
  const ensureStudio = async () => {
    if (studioPanel) return studioPanel;
    if (studioLoading) return studioLoading;
    studioLoading = (async () => {
      try {
        const { bindStudioWorkstations } = await import('./studio-workstations-ui.js');
        studioPanel = bindStudioWorkstations({ api, host: el('.cap-studio') });
        return studioPanel;
      } catch { return null; }
      finally { studioLoading = null; }
    })();
    return studioLoading;
  };
  const ensureMarket = async () => {
    if (market) return market;
    if (marketLoading) return marketLoading;
    marketLoading = (async () => {
      try {
        // Old backends deliberately keep their existing local-plugin interface.
        // An unavailable optional endpoint must not replace it with an error.
        const feature = await api('/api/dimension/plugin-market');
        if (feature?.available !== true || feature.hostReady === false) return null;
        const { bindPluginMarket } = await import('./plugin-market-ui.js');
        market = bindPluginMarket({ api, host: el('.cap-market-host'), onChanged: () => {
          window.dispatchEvent(new CustomEvent('dimension-plugins-changed'));
        } });
        return market;
      } catch { return null; }
      finally { marketLoading = null; }
    })();
    return marketLoading;
  };
  const drafts = new Map(), saving = new Set(), deleting = new Set();
  const status = text => { el('.cap-status').textContent = text; };
  const values = () => ({ title: form.elements.title.value, keywords: form.elements.keywords.value.split(/[,，\s]+/).filter(Boolean), body: form.elements.body.value });
  const capture = () => {
    const draft = drafts.get(selected); if (!draft || form.hidden) return;
    const value = values();
    if (JSON.stringify(value) !== JSON.stringify({ title: draft.title, keywords: draft.keywords, body: draft.body })) Object.assign(draft, value, { dirty: true, revision: draft.revision + 1 });
  };
  const syncEditor = () => {
    form.querySelector('[type=submit]').disabled = saving.has(selected) || deleting.has(selected);
    el('.cap-delete').hidden = !rows.some(row => row.topic === selected);
    el('.cap-delete').disabled = saving.has(selected) || deleting.has(selected);
    for (const field of form.querySelectorAll('input,textarea')) field.disabled = deleting.has(selected);
  };
  const edit = row => {
    capture(); editorVersion++;
    selected = row?.topic || 'skill-' + crypto.randomUUID().slice(0, 12);
    if (!drafts.has(selected) || (!drafts.get(selected).dirty && !saving.has(selected))) drafts.set(selected, { topic: selected, title: row?.title || '', keywords: row?.keywords || [], body: row?.body || '', dirty: !row?.topic, revision: 0 });
    const draft = drafts.get(selected); form.hidden = false;
    form.elements.title.value = draft.title; form.elements.keywords.value = draft.keywords.join('，'); form.elements.body.value = draft.body;
    syncEditor(); renderSkills(); status(draft.dirty ? '草稿已保留，保存后所有 Bot 可用。' : '');
  };
  const renderSkills = () => {
    const items = new Map(rows.map(row => [row.topic, row]));
    for (const [topic, draft] of drafts) if (draft.dirty || saving.has(topic) || !items.has(topic)) items.set(topic, draft);
    el('.cap-list').replaceChildren(...[...items.values()].map(row => {
      const button = node('button', 'cap-skill-item', (row.title || '未命名 Skill') + (row.dirty ? ' · 未保存' : '')); button.type = 'button'; button.dataset.topic = row.topic;
      button.append(node('small', '', row.keywords.join(' · '))); button.onclick = () => edit(row); button.classList.toggle('active', selected === row.topic); return button;
    }));
    if (!items.size) el('.cap-list').append(node('p', '', '还没有共享 Skill，可以新增或导入。'));
  };
  const renderPlugins = plugins => {
    const states = { loaded: '已加载', disabled: '未启用', failed: '加载失败', 'pending-restart': '等待重启', removed: '卸载后等待重启', idle: '已安装' };
    el('.cap-plugin-list').replaceChildren(...plugins.map(plugin => {
      const card = node('article', 'cap-plugin');
      card.append(node('strong', '', plugin.label || plugin.metadata?.displayName || plugin.name), node('small', '', `${plugin.builtin ? '内置 · ' : ''}${states[plugin.state] || plugin.state || ''}${plugin.version ? ' · ' + plugin.version : ''}`));
      if (plugin.description) card.append(node('p', '', plugin.description));
      if (plugin.reason) card.append(node('p', 'cap-plugin-error', plugin.reason));
      if (plugin.optional) {
        card.dataset.pluginId = plugin.id;
        const toggle = node('button', 'cap-plugin-toggle', plugin.enabled ? '停用' : '启用'); toggle.type = 'button';
        toggle.setAttribute('aria-pressed', String(plugin.enabled === true));
        toggle.onclick = async () => {
          toggle.disabled = true;
          try {
            const data = await api(`/api/dimension/plugins/${encodeURIComponent(plugin.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !plugin.enabled }) });
            window.dispatchEvent(new CustomEvent('dimension-plugins-changed', { detail: data.plugins }));
            await load(); status(plugin.enabled ? '插件已停用。' : '插件已启用。');
          } catch (error) { status(error.message); } finally { toggle.disabled = false; }
        };
        card.append(toggle);
      }
      if (!plugin.builtin && plugin.state !== 'removed') {
        const remove = node('button', '', '卸载'); remove.type = 'button';
        remove.onclick = async () => {
          const ok = window.__dimensionConfirm
            ? await window.__dimensionConfirm({ title: '卸载插件', message: `卸载插件「${plugin.name}」？`, confirmLabel: '卸载', danger: true })
            : window.confirm(`卸载插件「${plugin.name}」？`);
          if (!ok) return;
          remove.disabled = true;
          try { await api('/api/extensions/uninstall', { method: 'POST', body: JSON.stringify({ name: plugin.name }) }); await load(); status('已卸载，重启应用后生效。'); }
          catch (error) { status(error.message); } finally { remove.disabled = false; }
        }; card.append(remove);
      }
      return card;
    }));
    if (!plugins.length) el('.cap-plugin-list').append(node('p', '', '还没有安装插件。'));
  };
  async function load() {
    const ticket = ++version, current = tab; status('正在加载…');
    try {
      let data;
      if (current === 'studio') {
        const panel = await ensureStudio();
        if (ticket !== version || !dialog.open || tab !== current) return;
        status('');
        if (panel) await panel.refresh();
        else status('工位装备与能力卡模块加载失败，请刷新重试。');
        return;
      }
      if (current === 'skills') data = await api('/api/dimension/skills');
      else {
        const enhanced = await ensureMarket();
        if (ticket !== version || !dialog.open || tab !== current) return;
        el('.cap-market-host').hidden = !enhanced;
        el('.cap-legacy-plugins').hidden = Boolean(enhanced);
        if (enhanced) {
          el('.cap-description').textContent = '安装、登录与启用分离；插件可授权给共享 Work 或具体 Bot。';
          status(''); await enhanced.open(); return;
        }
        const results = await Promise.allSettled([api('/api/extensions'), api('/api/dimension/plugins')]);
        if (results.every(result => result.status === 'rejected')) throw results[0].reason;
        data = { extensions: results.flatMap(result => result.status === 'fulfilled' ? result.value.plugins || result.value.extensions || [] : []) };
      }
      if (ticket !== version || !dialog.open) return;
      if (current === 'skills') { rows = data.skills || []; renderSkills(); syncEditor(); }
      else renderPlugins(data.extensions || []);
      status('');
    } catch (error) { if (ticket === version) status(error.message); }
  }
  const open = next => {
    capture(); editorVersion++;
    market?.close();
    tab = next;
    el('.cap-skills').hidden = tab !== 'skills';
    el('.cap-plugins').hidden = tab !== 'plugins';
    el('.cap-studio').hidden = tab !== 'studio';
    el('.cap-description').textContent = tab === 'skills'
      ? '所有 Bot 共用的工作 Skill，按关键词检索并用于相关任务。'
      : tab === 'studio'
        ? '管理外部订阅 CLI / 无头软件工位底座，并为各 Bot 配置工种能力卡与群聊派单账本。'
        : '选择需要的内置插件，即时启用或停用；也可安装本地插件。';
    for (const button of dialog.querySelectorAll('[data-tab]')) button.setAttribute('aria-pressed', String(button.dataset.tab === tab));
    if (!dialog.open) dialog.showModal(); void load();
  };
  for (const button of dialog.querySelectorAll('[data-tab]')) button.onclick = () => open(button.dataset.tab);
  el('.cap-close').onclick = () => dialog.close(); dialog.onclose = () => { if (dialog.open) return; capture(); version++; editorVersion++; market?.close(); };
  form.oninput = () => { capture(); renderSkills(); };
  el('.cap-new').onclick = () => { edit(null); form.elements.title.focus(); };
  el('.cap-import').onchange = async event => {
    const file = event.target.files[0]; if (!file) return;
    const ticket = editorVersion;
    try {
      if (file.size > 180000) throw new Error('Skill 文件过大，请控制在 60000 字以内');
      const text = await file.text(), lines = text.replace(/\r/g, '').split('\n');
      const titled = /^#\s+/.test(lines[0]), keyed = /^关键词[:：]/.test(lines[1] || '');
      const topic = 'skill-' + crypto.randomUUID().slice(0, 12);
      const draft = { topic, title: titled ? lines[0].replace(/^#\s+/, '') : file.name.replace(/\.(md|txt)$/i, ''),
        keywords: keyed ? lines[1].replace(/^关键词[:：]/, '').split(/[,，\s]+/).filter(Boolean) : [], body: lines.slice(keyed ? 2 : titled ? 1 : 0).join('\n').trim(), dirty: true, revision: 0 };
      drafts.set(topic, draft); renderSkills();
      if (ticket === editorVersion && dialog.open) { edit(draft); status('已导入，填写关键词后保存。'); }
    } catch (error) { status(error.message); } finally { event.target.value = ''; }
  };
  form.onsubmit = async event => {
    event.preventDefault(); capture();
    const topic = selected, draft = drafts.get(topic), ticket = editorVersion;
    if (!draft || saving.has(topic) || deleting.has(topic)) return;
    const revision = draft.revision, snapshot = values(); saving.add(topic); syncEditor();
    const current = () => dialog.open && tab === 'skills' && selected === topic && editorVersion === ticket;
    try {
      await api(`/api/dimension/skills/${encodeURIComponent(topic)}`, { method: 'PUT', body: JSON.stringify(snapshot) });
      capture(); if (draft.revision === revision) draft.dirty = false;
      rows = [...rows.filter(row => row.topic !== topic), { topic, ...snapshot }];
      renderSkills();
      if (current()) status(draft.dirty ? '已保存提交的版本；后续修改仍保留在草稿中。' : '已保存，所有 Bot 的后续工作均可检索。');
    } catch (error) { if (current()) status(error.message); }
    finally { saving.delete(topic); syncEditor(); }
  };
  el('.cap-delete').onclick = async () => {
    if (!selected) return;
    const ok = window.__dimensionConfirm
      ? await window.__dimensionConfirm({ title: '删除共享 Skill', message: '删除这个共享 Skill？删除后无法恢复。', confirmLabel: '删除', danger: true })
      : window.confirm('删除这个共享 Skill？');
    if (!ok) return;
    const topic = selected, ticket = editorVersion; deleting.add(topic); syncEditor();
    try {
      await api(`/api/dimension/skills/${encodeURIComponent(topic)}`, { method: 'DELETE' });
      drafts.delete(topic); rows = rows.filter(row => row.topic !== topic); renderSkills();
      if (selected === topic) { selected = null; form.hidden = true; }
    } catch (error) { if (selected === topic && ticket === editorVersion) status(error.message); }
    finally { deleting.delete(topic); syncEditor(); }
  };
  el('.cap-plugin-form').onsubmit = async event => {
    event.preventDefault(); const button = event.target.querySelector('button'), path = event.target.elements.path.value.trim(); button.disabled = true;
    try {
      status('正在检查插件…'); await api('/api/extensions/check', { method: 'POST', body: JSON.stringify({ target: { path } }) });
      status('正在安装插件…'); await api('/api/extensions/install', { method: 'POST', body: JSON.stringify({ path }) });
      await load(); status('安装完成，重启应用后生效。');
    } catch (error) { status(error.message); } finally { button.disabled = false; }
  };
  document.getElementById('sharedSkillsBtn')?.addEventListener('click', () => open('skills'));
  document.getElementById('sharedPluginsBtn')?.addEventListener('click', () => open('plugins'));
  document.getElementById('sharedStudioWorkstationsBtn')?.addEventListener('click', () => open('studio'));
  void import('./capability-status-ui.js').then(({ bindCapabilityStatus }) => bindCapabilityStatus({ api })).catch(() => {
    const trigger = document.getElementById('sharedCapabilityStatusBtn');
    if (trigger) { trigger.disabled = true; trigger.title = '能力状态模块暂时无法加载，请刷新后重试'; }
  });
  void import('./global-search-ui.js').then(({ bindGlobalSearch }) => bindGlobalSearch({ api })).catch(() => {
    const trigger = document.getElementById('sharedGlobalSearchBtn');
    if (trigger) { trigger.disabled = true; trigger.title = '全局搜索模块暂时无法加载，请刷新后重试'; }
  });
  void import('./notification-inbox-ui.js').then(({ bindNotificationInbox }) => bindNotificationInbox({ api })).catch(() => {
    const trigger = document.getElementById('sharedNotificationsBtn');
    if (trigger) { trigger.disabled = true; trigger.title = '通知模块暂时无法加载，请刷新后重试'; }
  });
  void import('./attachment-library-ui.js').then(({ bindAttachmentLibrary }) => bindAttachmentLibrary({ api })).catch(() => {
    const trigger = document.getElementById('sharedAttachmentLibraryBtn');
    if (trigger) { trigger.disabled = true; trigger.title = '附件资料库暂时无法加载，请刷新后重试'; }
  });
  void import('./skill-learning-ui.js').then(({ bindSkillLearning }) => bindSkillLearning({ api })).catch(() => {
    const trigger = document.getElementById('sharedSkillLearningBtn');
    if (trigger) { trigger.disabled = true; trigger.title = '经验候选模块暂时无法加载，请刷新后重试'; }
  });
}
