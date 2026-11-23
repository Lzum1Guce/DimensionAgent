// DimensionAgent's original UI for the optional local plugin compatibility host.
// Catalog metadata is rendered as text; package execution stays in the host.
const element = (tag, className = '', text) => {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const list = value => Array.isArray(value) ? value : [];
const description = value => typeof value === 'string' ? value
  : value && typeof value === 'object' ? [value['zh-CN'], value.zh, value.en, ...Object.values(value)].find(item => typeof item === 'string') || '' : '';
const manifestOf = value => value?.manifest || value || {};
const identifier = source => source.id || source.sourceId;
const sourceLabel = source => description(source?.name || source?.label || source?.title) || source?.url || source?.kind || '来源未注明';
const sourceText = source => typeof source === 'string' ? source : source?.url || source?.registry || source?.path || (source?.type === 'local-directory' ? '本地目录' : source?.kind || source?.type || '来源未注明');
const versionOf = value => String(value?.version || value?.defaultVersion || value?.latest || value?.['dist-tags']?.latest || '');
const reasonsOf = value => list(value?.reasons).map(reason => typeof reason === 'string' ? reason : reason.message || reason.code || '').filter(Boolean);

function compatibility(value, inspected = false) {
  const data = value?.classification || value?.runtimeCompatibility || {};
  if (data.supported === false || ['unsupported', 'needs-adapter', 'blocked'].includes(data.status) || data.kind === 'unsupported') {
    return { label: '需要适配', tone: 'adapter', reasons: reasonsOf(data), supported: false };
  }
  if (inspected && data.supported === true) {
    return { label: data.kind === 'skills' ? '支持 Skill' : data.kind === 'mcp' ? '支持 MCP' : data.kind === 'mcp-and-skills' ? '支持 MCP 与 Skill' : '检查通过', tone: 'supported', reasons: reasonsOf(data), supported: true };
  }
  return { label: '待检查', tone: 'pending', reasons: reasonsOf(data), supported: false };
}

export function bindPluginMarket({ api, host, onChanged = () => {} }) {
  if (!document.querySelector('link[data-plugin-market-style]')) {
    const stylesheet = document.createElement('link'); stylesheet.rel = 'stylesheet';
    stylesheet.href = new URL('./plugin-market-ui.css?v=1fe0a8da0e', import.meta.url).href;
    stylesheet.dataset.pluginMarketStyle = '1'; document.head.append(stylesheet);
  }
  host.classList.add('plugin-market');
  host.innerHTML = `<div class="pm-heading"><div><h3>插件与能力</h3><p>安装、登录和启用互不等同。新安装保持停用；启用前核对权限，并选择共享 Work 或具体 Bot。</p></div><button type="button" class="pm-refresh">刷新</button></div>
    <nav class="pm-tabs" aria-label="插件市场"><button type="button" data-market-tab="discover" aria-pressed="true">发现</button><button type="button" data-market-tab="installed" aria-pressed="false">已安装</button><button type="button" data-market-tab="harness" aria-pressed="false">外部工具</button><button type="button" data-market-tab="compatibility" aria-pressed="false">兼容说明</button></nav>
    <p class="pm-status" role="status" aria-live="polite"></p>
    <section class="pm-discover"><div class="pm-search"><label>搜索插件<input type="search" class="pm-query" placeholder="名称或说明" autocomplete="off"></label><label>索引源<select class="pm-source-filter" aria-label="筛选索引源"></select></label></div>
      <details class="pm-sources"><summary>管理索引源 <span class="pm-source-count"></span></summary><p>当前没有预设的官方市场地址。索引源使用 DeepSeek Harness format 1 格式。</p><form class="pm-source-form"><label>索引地址<input name="url" type="url" placeholder="https://example.com/plugins/index.json" required></label><button type="submit">添加索引</button></form><div class="pm-source-list"></div></details>
      <details class="pm-local"><summary>检查本地插件目录</summary><form class="pm-local-form"><label>插件目录<input name="path" placeholder="包含 package.json 的本地目录" required></label><button type="submit">检查目录</button></form><p>本阶段支持目录导入。ZIP 文件需先解压为目录。</p></details>
      <p class="pm-results-note"></p><div class="pm-catalog" aria-label="插件搜索结果"></div><button type="button" class="pm-more" hidden>加载更多</button></section>
    <section class="pm-installed" hidden aria-label="已安装能力"></section>
    <section class="pm-harness" aria-label="外部工具服务" hidden></section>
    <section class="pm-compatibility" hidden><h4>哪些能力可以使用</h4><dl><dt>MCP 配置包</dt><dd>经检查后导入 MCP 服务配置，安装时保持停用。启用后由本机兼容服务连接对应工具。</dd><dt>Skill</dt><dd>经检查后导入 Skill 文件。启停状态决定后续任务是否可以使用。</dd><dt>登录与启用</dt><dd>需要账号的插件先完成登录，再单独授权启用。退出登录会撤销启用范围；无需登录的插件不伪造账号状态。</dd><dt>权限与旧任务</dt><dd>权限增加后必须重新确认。旧 Work 保留原权限和工具快照，不会自动获得新增能力；需要新权限时请新建任务。</dd><dt>卸载与数据</dt><dd>卸载立即撤销适配和调用授权，但不删除插件数据。删除数据是卸载后的独立操作。</dd><dt>依赖 Cordis 或 DeepSeek Harness 界面的插件</dt><dd>显示“需要适配”，保留版本、来源与原因，不能当作可用能力启用。</dd><dt>版本与来源</dt><dd>索引中的条目先标为“待检查”。检查结果只对应你选择的具体版本，换版本后需要重新检查。</dd></dl><p>兼容服务用于连接插件能力，DimensionAgent 的任务与数据仍由原生后端管理。</p></section>
    <section class="pm-inspector" hidden aria-label="插件版本检查"></section>`;
  const find = selector => host.querySelector(selector);
  let active = false, tab = 'discover', generation = 0, searchVersion = 0, detailVersion = 0, sources = [], plugins = [];
  let inspection = null, selected = null, searchTimer, pages = new Map(), bots = [], retainedData = [], botsPromise = null;
  const busy = new Set();
  const syncActions = () => {
    for (const button of host.querySelectorAll('[data-pm-operation]')) {
      const cardBusy = button.closest('.pm-card')?.dataset.pmBusy === '1';
      button.disabled = cardBusy || button.dataset.pmBlocked === '1' || busy.has(button.dataset.pmOperation);
    }
  };
  const status = text => { if (active) find('.pm-status').textContent = text; };
  const request = async (action, args = {}) => {
    const result = await api('/api/dimension/plugin-market', { method: 'POST', body: JSON.stringify({ action, ...args }) });
    if (result?.ok === false) throw new Error(result.error?.message || '操作未完成，请重试。');
    return result;
  };
  const action = (label, key, operation, disabled = false) => {
    const button = element('button', '', label); button.type = 'button'; button.disabled = disabled || busy.has(key);
    button.dataset.pmOperation = key; button.dataset.pmBlocked = disabled ? '1' : '0';
    button.onclick = async () => {
      const card = button.closest('.pm-card');
      if (busy.has(key) || card?.dataset.pmBusy === '1') return;
      busy.add(key); if (card) card.dataset.pmBusy = '1'; syncActions();
      try { await operation(); } catch (error) { status(error.message); }
      finally { busy.delete(key); if (card) delete card.dataset.pmBusy; syncActions(); }
    };
    return button;
  };
  const badge = state => element('span', `pm-badge pm-${state.tone}`, state.label);
  const reasonList = (parent, reasons) => {
    if (!reasons.length) return;
    const ul = element('ul', 'pm-reasons');
    for (const reason of reasons) ul.append(element('li', '', reason));
    parent.append(ul);
  };
  const confirmRemoval = (container, label, operation) => {
    if (container.querySelector('.pm-confirm')) return;
    const confirmation = element('div', 'pm-confirm'); confirmation.append(element('span', '', label));
    confirmation.append(action('确认移除', 'remove:' + label, async () => { await operation(); confirmation.remove(); }));
    const cancel = element('button', '', '取消'); cancel.type = 'button'; cancel.onclick = () => confirmation.remove();
    confirmation.append(cancel); container.append(confirmation);
  };
  const metadata = (parent, entries) => {
    const dl = element('dl', 'pm-metadata');
    for (const [label, value] of entries) { dl.append(element('dt', '', label), element('dd', '', String(value || '未注明'))); }
    parent.append(dl);
  };

  function renderSources() {
    find('.pm-source-count').textContent = `(${sources.length})`;
    const filter = find('.pm-source-filter'), previous = filter.value;
    filter.replaceChildren(new Option('全部来源', ''));
    for (const source of sources) filter.add(new Option(sourceLabel(source), identifier(source)));
    if (sources.some(source => identifier(source) === previous)) filter.value = previous;
    find('.pm-source-list').replaceChildren(...sources.map(source => {
      const row = element('article', 'pm-source'); row.dataset.sourceId = identifier(source);
      const text = element('div'); text.append(element('strong', '', sourceLabel(source)), element('small', '', source.url || source.path || source.kind || '本机来源'));
      row.append(text, action('移除来源', 'source:' + identifier(source), async () => {
        confirmRemoval(row, '移除此索引源？已安装的能力会保留。', async () => {
          await request('source.remove', { sourceId: identifier(source) }); await refreshSources(); await search(); status('索引源已移除。');
        });
      }));
      return row;
    }));
    if (!sources.length) find('.pm-sources').open = true;
  }
  async function refreshSources() {
    const data = await request('source.list'); sources = list(data.sources); renderSources();
  }

  function renderCatalog(items, append = false) {
    const cards = items.map(item => {
      const card = element('article', 'pm-card'); card.dataset.packageName = item.name;
      const top = element('div', 'pm-card-title'); top.append(element('strong', '', description(item.displayName || item.title) || item.name), badge(compatibility(item)));
      card.append(top, element('p', '', description(item.description)), element('small', '', [versionOf(item) ? `版本 ${versionOf(item)}` : '查看可选版本', `License: ${description(item.license) || '未注明'}`, sourceLabel(item._source)].join(' · ')));
      reasonList(card, compatibility(item).reasons);
      card.append(action('查看版本', 'details:' + item.sourceId + ':' + item.name, () => showPackage(item)));
      return card;
    });
    if (append) find('.pm-catalog').append(...cards); else find('.pm-catalog').replaceChildren(...cards);
  }
  async function search(append = false) {
    const ticket = ++searchVersion, current = generation;
    const chosen = find('.pm-source-filter').value, query = find('.pm-query').value.trim();
    const targets = sources.filter(source => (!chosen || identifier(source) === chosen) && (!append || pages.get(identifier(source)) != null));
    if (!append) pages = new Map();
    if (!targets.length) {
      if (!append) renderCatalog([]);
      find('.pm-more').hidden = true;
      find('.pm-results-note').textContent = sources.length ? '没有匹配的索引源。' : '还没有索引源。添加索引地址，或检查本地插件目录。';
      return;
    }
    find('.pm-results-note').textContent = '正在读取插件…';
    const results = await Promise.allSettled(targets.map(async source => {
      const data = await request('market.list', { sourceId: identifier(source), query, offset: append ? pages.get(identifier(source)) : 0, limit: 25 });
      return { source, data };
    }));
    if (!active || current !== generation || ticket !== searchVersion) return;
    const items = [], failures = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') { failures.push(`${sourceLabel(targets[i])}：${result.reason.message}`); continue; }
      const { source, data } = result.value;
      pages.set(identifier(source), data.nextOffset ?? null);
      items.push(...list(data.items).map(item => ({ ...item, sourceId: identifier(source), _source: source })));
    }
    renderCatalog(items, append);
    find('.pm-more').hidden = ![...pages.values()].some(value => value != null);
    const count = find('.pm-catalog').children.length;
    find('.pm-results-note').textContent = count ? `已显示 ${count} 个插件` : failures.length ? '暂时无法读取索引源。' : '没有匹配的插件，试试其他关键词。';
    status(failures.join('\n'));
  }

  function showInspector(title) {
    const panel = find('.pm-inspector'); panel.hidden = false; panel.replaceChildren();
    const header = element('div', 'pm-detail-heading');
    header.append(element('h4', '', title));
    const close = element('button', 'pm-detail-close', '收起'); close.type = 'button'; close.onclick = () => { detailVersion++; inspection = null; panel.hidden = true; };
    header.append(close); panel.append(header); panel.scrollIntoView({ block: 'nearest' });
    return panel;
  }
  async function showPackage(item) {
    selected = item; inspection = null;
    const ticket = ++detailVersion, panel = showInspector(description(item.displayName || item.title) || item.name);
    panel.append(element('p', '', description(item.description)));
    metadata(panel, [['包名', item.name], ['License', item.license], ['索引源', item._source?.url || sourceLabel(item._source)]]);
    const versions = element('select', 'pm-version'); versions.setAttribute('aria-label', '选择精确版本');
    const label = element('label', '', '精确版本'); label.append(versions); panel.append(label);
    let versionOffset = 0;
    const moreVersions = action('加载更多版本', 'versions', () => loadVersions(versionOffset)); moreVersions.className = 'pm-more-versions'; moreVersions.hidden = true; panel.append(moreVersions);
    panel.append(element('div', 'pm-inspection-result'));
    const check = action('检查此版本', 'inspect', async () => {
      const version = versions.value;
      if (!version) return;
      inspection = null; find('.pm-inspection-result')?.replaceChildren();
      status(`正在检查 ${item.name} ${version}…`);
      const data = await request('package.inspect', { sourceId: item.sourceId, name: item.name, version });
      if (!active || ticket !== detailVersion || versions.value !== version) return;
      if (data.inspection?.manifest?.name !== item.name || data.inspection?.manifest?.version !== version) throw new Error('检查结果与所选包名或版本不一致，请重新检查。');
      inspection = data.inspection; renderInspection(inspection); status('版本检查完成。');
    });
    check.className = 'pm-inspect-button'; check.disabled = true; check.dataset.pmBlocked = '1'; panel.append(check);
    versions.onchange = () => { inspection = null; find('.pm-inspection-result')?.replaceChildren(); };
    async function loadVersions(offset = 0) {
      const data = await request('market.versions', { sourceId: item.sourceId, name: item.name, offset, limit: 50 });
      if (!active || ticket !== detailVersion) return;
      const choices = list(data.versions).map(version => typeof version === 'string' ? version : version.version).filter(Boolean);
      if (!offset && !choices.length && versionOf(item)) choices.push(versionOf(item));
      const existing = new Set([...versions.options].map(option => option.value));
      for (const version of [...new Set(choices)]) if (!existing.has(version)) versions.add(new Option(version, version));
      if (!offset && choices.includes(versionOf(item))) versions.value = versionOf(item);
      versionOffset = data.nextOffset ?? null; moreVersions.hidden = versionOffset == null;
      check.dataset.pmBlocked = versions.value ? '0' : '1'; check.disabled = !versions.value || busy.has('inspect');
      if (!versions.options.length) status('此条目没有提供可检查的具体版本。');
    }
    try { await loadVersions(); } catch (error) { if (ticket === detailVersion) status(error.message); }
  }
  async function chooseAdaptationBot(result, container) {
    if (container.querySelector('.pm-adaptation-choice')) return;
    const planId = result.planId, current = generation, detail = detailVersion;
    const choice = element('section', 'pm-adaptation-choice');
    choice.setAttribute('aria-label', '选择负责适配的 Bot');
    choice.append(element('h4', '', '由哪个 Bot 适配并安装？'));
    choice.append(element('p', '', '会为所选 Bot 新建 Work 任务，保留此版本的原包、来源与许可证。适配通过后安装为停用；功能是否可用需由实际测试证明。'));
    const label = element('label', '', '负责 Bot'), select = element('select', 'pm-adaptation-bot');
    select.setAttribute('aria-label', '负责适配的 Bot'); select.disabled = true; label.append(select);
    const note = element('p', 'pm-adaptation-status', '正在读取 Work Bot…'); note.setAttribute('role', 'status');
    const controls = element('div', 'pm-card-actions');
    const requestId = crypto.randomUUID();
    let submitted = false, finished = false;
    const start = action('创建适配任务', 'adaptation:' + planId, async () => {
      if (finished || inspection?.planId !== planId || detailVersion !== detail) throw new Error('所选版本已变化，请重新检查后创建适配任务。');
      const botId = select.value;
      if (!botId) throw new Error('请选择负责适配的 Bot。');
      submitted = true; select.disabled = true; cancel.disabled = true; note.textContent = '正在准备原包并创建 Work 任务…';
      try {
        const response = await request('adaptation.start', { planId, botId, requestId });
        const runId = response.run?.id || response.run?.runId;
        if (!runId || response.run?.botId !== botId) throw new Error('适配任务响应不完整。可重试此请求，避免重复创建。');
        finished = true; start.dataset.pmBlocked = '1';
        const target = { botId, runId };
        window.dispatchEvent(new CustomEvent('dimension-plugin-adaptation-created', { detail: target }));
        if (!active || current !== generation || detail !== detailVersion || inspection?.planId !== planId) return;
        const state = response.run.status;
        note.textContent = ['failed', 'cancelled', 'interrupted'].includes(state)
          ? '任务已建立，当前' + { failed: '执行失败', cancelled: '已取消', interrupted: '已中断' }[state] + '。请在 Work 查看原因。'
          : '已为 ' + (select.selectedOptions[0]?.textContent || '所选 Bot') + ' 创建适配任务' + (state === 'queued' ? '，正在排队。' : '。');
        const open = element('button', 'pm-adaptation-open', '查看 Work 任务'); open.type = 'button';
        open.onclick = () => window.dispatchEvent(new CustomEvent('dimension-open-plugin-adaptation', { detail: target }));
        controls.replaceChildren(open);
        status('适配任务已创建；结果和实际测试证据会保存在该 Work 任务。');
      } catch (error) {
        note.textContent = error.message; throw error;
      } finally {
        submitted = false;
        if (!finished) { select.disabled = false; cancel.disabled = false; }
      }
    }, true);
    start.classList.add('pm-adaptation-start');
    const cancel = element('button', 'pm-adaptation-cancel', '取消'); cancel.type = 'button';
    cancel.onclick = () => { if (!submitted) choice.remove(); };
    controls.append(start, cancel); choice.append(label, note, controls); container.append(choice);
    try {
      const data = await request('adaptation.bots');
      if (!active || current !== generation || detail !== detailVersion || inspection?.planId !== planId || !choice.isConnected) return;
      select.replaceChildren(new Option('请选择 Bot', ''));
      for (const bot of list(data.bots)) if (bot.id) select.add(new Option(bot.name || bot.id, bot.id));
      select.disabled = select.options.length <= 1;
      note.textContent = select.disabled ? '没有可用的 Work Bot。请先将 Bot 加入 Work，再重新打开选择。' : '所选 Bot 已有任务时，本次任务会排队。';
      select.onchange = () => { start.dataset.pmBlocked = select.value ? '0' : '1'; syncActions(); };
      select.focus();
    } catch (error) { if (choice.isConnected) note.textContent = error.message; }
  }

  function renderInspection(result) {
    if (!result) throw new Error('检查结果不完整，请重新检查。');
    const panel = find('.pm-inspector'), manifest = manifestOf(result), state = compatibility(result, true);
    let content = panel.querySelector('.pm-inspection-result');
    if (!content) { content = element('div', 'pm-inspection-result'); panel.append(content); }
    content.replaceChildren(badge(state));
    metadata(content, [['检查版本', `${manifest.name || selected?.name || ''} ${manifest.version || ''}`], ['License', manifest.license], ['来源', sourceText(result.source)]]);
    reasonList(content, state.reasons);
    if (list(result.mcpServers).length) content.append(element('p', '', `包含 ${result.mcpServers.length} 个 MCP 服务配置。`));
    if (list(result.skills).length) content.append(element('p', '', `包含 ${result.skills.length} 个 Skill。`));
    reasonList(content, list(result.warnings).map(warning => typeof warning === 'string' ? warning : warning.message || ''));
    const install = action(`安装 ${manifest.version || '此版本'}`, 'install', async () => {
      const planId = result.planId;
      if (!planId || inspection?.planId !== planId) throw new Error('请重新检查要安装的版本。');
      status('正在安装已检查的版本…');
      await request('package.install', { planId });
      inspection = null; panel.hidden = true; await loadInstalled(); switchTab('installed');
      status('已安装，当前未启用。'); onChanged();
    }, !state.supported || !result.planId);
    install.className = 'pm-install';
    const installActions = element('div', 'pm-card-actions'); installActions.append(install);
    if (!state.supported) {
      const adapt = action('适配并安装', 'adapt-choose:' + result.planId, () => chooseAdaptationBot(result, content), !result.planId);
      adapt.classList.add('pm-adapt-install'); installActions.append(adapt);
    }
    content.append(installActions);
    if (!state.supported) content.append(element('p', 'pm-detail-note', '此包需要适配。可指定 Bot 处理此精确版本；原功能缺口会保留在任务中，未经适配不会直接启用。'));
    content.scrollIntoView({ block: 'nearest' });
  }
  async function inspectLocal(path) {
    const ticket = ++detailVersion; selected = null; inspection = null;
    const panel = showInspector('检查本地目录'); panel.append(element('p', '', path));
    status('正在读取本地插件清单…');
    const data = await request('package.inspect', { path });
    if (!active || ticket !== detailVersion) return;
    inspection = data.inspection; renderInspection(inspection); status('本地检查完成。');
  }
  async function loadInstalled() {
    const current = generation;
    if (!botsPromise) botsPromise = request('adaptation.bots').catch(() => ({ bots: [] }));
    const [data, botData] = await Promise.all([request('plugin.list'), botsPromise]);
    if (!active || current !== generation) return;
    plugins = list(data.plugins); bots = list(botData.bots); retainedData = list(data.retainedData);
    const installedRoot = find('.pm-installed');
    installedRoot.replaceChildren(...plugins.map(plugin => {
      const manifest = manifestOf(plugin), id = plugin.id || plugin.pluginId, state = compatibility(plugin, true);
      const auth = plugin.auth || { state: 'not-required' }, scopes = list(plugin.scopes), permissions = list(plugin.permissions);
      const authLabels = { 'not-required': '无需登录', connected: '已登录', 'logged-out': '未登录', required: '需要登录', expired: '登录已过期' };
      const authBlocked = !['not-required', 'connected'].includes(auth.state);
      const card = element('article', 'pm-card pm-installed-card'); card.dataset.pluginId = id;
      const heading = element('div', 'pm-card-title'); heading.append(element('strong', '', plugin.label || manifest.name));
      const states = element('div', 'pm-state-badges');
      states.append(badge({ label: '已安装', tone: 'supported' }), badge({ label: authLabels[auth.state] || '登录状态未知', tone: authBlocked ? 'adapter' : 'pending' }));
      states.append(badge({ label: plugin.permissionReconfirmationRequired ? '待重新授权' : plugin.enabled ? '已启用' : '未启用', tone: plugin.enabled ? 'supported' : 'pending' }));
      heading.append(states); card.append(heading, element('small', '', `版本 ${manifest.version || plugin.version || '未注明'} · License: ${manifest.license || plugin.license || '未注明'}`));
      if (plugin.source) card.append(element('small', '', `来源：${sourceText(plugin.source)}`));
      if (plugin.adaptation) card.append(element('p', 'pm-detail-note', '此为适配包。兼容检查只代表可安装；原插件功能是否可用，请核对适配 Work 任务中的实际测试证据。'));
      if (state.tone === 'adapter') card.append(badge(state));
      if (manifest.description) card.append(element('p', '', description(manifest.description)));
      reasonList(card, state.reasons);

      const permissionDetails = element('details', 'pm-permissions'), permissionSummary = element('summary', '', `权限（${permissions.length}）`);
      permissionDetails.append(permissionSummary);
      reasonList(permissionDetails, permissions.map(permission => {
        if (typeof permission === 'string') return permission;
        return permission.label && permission.label !== permission.id ? `${permission.label}（${permission.id}）` : permission.label || permission.id;
      }));
      if (plugin.permissionReconfirmationRequired) permissionDetails.open = true;
      card.append(permissionDetails);
      if (plugin.permissionReconfirmationRequired) card.append(element('p', 'pm-permission-warning', '权限已变化，所有启用范围已撤销。必须重新核对完整清单；旧 Work 不会自动扩权。'));

      if (scopes.length) {
        const scopeList = element('div', 'pm-scope-list');
        for (const scope of scopes) {
          const row = element('div', 'pm-scope-row'), bot = bots.find(item => item.id === scope.botId);
          const label = scope.type === 'shared' ? '共享 Work' : scope.type === 'run' ? `单个 Work：${scope.runId}` : `Bot：${bot?.name || scope.botId}`;
          row.append(element('span', '', label));
          row.append(action('停用此范围', `scope:${id}:${scope.type}:${scope.botId || ''}:${scope.runId || ''}`, async () => {
            await request('plugin.disable', { pluginId: id, scope: { type: scope.type, botId: scope.botId, runId: scope.runId } });
            await loadInstalled(); onChanged(); status('此启用范围已停用，后续调用会被拒绝。');
          }));
          scopeList.append(row);
        }
        card.append(scopeList);
      }

      const scopeLabel = element('label', 'pm-scope-choice', '新启用范围');
      const scopeSelect = element('select', 'pm-scope-select'); scopeSelect.setAttribute('aria-label', '选择插件启用范围');
      scopeSelect.add(new Option('共享 Work（按任务权限快照）', 'shared'));
      for (const bot of bots) if (bot.id) scopeSelect.add(new Option(`仅 Bot：${bot.name || bot.id}`, `bot:${bot.id}`));
      scopeLabel.append(scopeSelect);
      const enableForScope = async () => {
        const choice = scopeSelect.value, scope = choice === 'shared' ? { type: 'shared' } : { type: 'bot', botId: choice.slice(4) };
        await request('plugin.enable', { pluginId: id, scope, permissionFingerprint: plugin.permissionFingerprint, approvedPermissions: permissions.map(permission => permission.id || permission) });
        await loadInstalled(); onChanged(); status('权限与启用范围已保存；旧任务不会自动扩权。');
      };
      const controls = element('div', 'pm-card-actions');
      controls.append(action(plugin.enabled ? '全部停用' : plugin.permissionReconfirmationRequired ? '重新核对并启用' : '启用', 'toggle:' + id, async () => {
        if (plugin.enabled) {
          await request('plugin.disable', { pluginId: id }); await loadInstalled(); onChanged(); status('全部范围已停用，后续调用会被拒绝。'); return;
        }
        if (card.querySelector('.pm-reconfirm')) { card.querySelector('.pm-reconfirm').remove(); return; }
        // 首次启用与权限变更后的重新启用都走同一确认流程：核对插件、范围与完整权限清单后才调用 enableForScope。
        const reconfirming = Boolean(plugin.permissionReconfirmationRequired);
        const panel = element('div', 'pm-reconfirm');
        panel.append(element('p', '', reconfirming
          ? '确认已阅读上方完整权限清单，并明确允许所选范围使用这些权限。'
          : '首次启用前请核对以下信息，确认后才会授予这些权限。'));
        const scopeText = () => scopeSelect.selectedOptions[0]?.textContent || '未选择';
        const scopeNote = element('span', '', scopeText());
        const syncScopeNote = () => { scopeNote.textContent = scopeText(); };
        scopeSelect.addEventListener('change', syncScopeNote);
        metadata(panel, [['插件', `${plugin.label || manifest.name || id}${manifest.version ? ` ${manifest.version}` : ''}`], ['启用范围', '']]);
        panel.querySelector('.pm-metadata dd:last-of-type')?.replaceChildren(scopeNote);
        panel.append(element('p', '', permissions.length ? `所需权限（${permissions.length}）：` : '此插件未声明额外权限。'));
        reasonList(panel, permissions.map(permission => {
          if (typeof permission === 'string') return permission;
          return permission.label && permission.label !== permission.id ? `${permission.label}（${permission.id}）` : permission.label || permission.id;
        }));
        const check = element('input'); check.type = 'checkbox'; check.id = `reconfirm-${id}`;
        const checkLabel = element('label', '', '我确认本次权限与启用范围'); checkLabel.htmlFor = check.id; checkLabel.prepend(check);
        const confirm = action('确认权限并启用', `reconfirm:${id}`, async () => {
          if (!check.checked) throw new Error('请先勾选权限确认。');
          await enableForScope();
          scopeSelect.removeEventListener('change', syncScopeNote);
        });
        const cancel = element('button', '', '取消'); cancel.type = 'button';
        cancel.onclick = () => { scopeSelect.removeEventListener('change', syncScopeNote); panel.remove(); };
        panel.append(checkLabel, confirm, cancel); card.append(panel); panel.scrollIntoView({ block: 'nearest' });
      }, state.tone === 'adapter' || authBlocked));
      controls.append(action('连接自检', 'test-conn:' + id, async () => {
        status(`正在执行 ${manifest.name || id} 的最小连接测试…`);
        const res = await request('plugin.test_connection', { pluginId: id });
        const diag = res.diagnosis || {};
        let diagNote = card.querySelector('.pm-conn-diag');
        if (!diagNote) { diagNote = element('p', 'pm-detail-note pm-conn-diag'); card.append(diagNote); }
        diagNote.textContent = `[连接诊断 · ${diag.state || 'unknown'}] ${diag.summary || '已完成检查'}`;
        status(diag.summary || '最小连接测试完成。');
      }));
      controls.append(action('卸载', 'remove:' + id, async () => {
        confirmRemoval(card, `卸载 ${manifest.name} ${manifest.version || ''}？将撤销适配与调用授权，但保留插件数据。`, async () => {
          await request('plugin.remove', { pluginId: id }); await loadInstalled(); onChanged(); status('插件已卸载并撤权；数据仍保留，可在下方单独删除。');
        });
      }));
      if (plugin.enabled) controls.append(action('添加启用范围', 'add-scope:' + id, enableForScope, authBlocked));
      if (auth.canLogin && authBlocked) controls.append(action('登录', 'login:' + id, async () => {
        await request('auth.login', { pluginId: id }); await loadInstalled(); onChanged(); status('登录已完成；插件仍保持停用，请单独选择范围启用。');
      }));
      if (auth.state === 'connected' && auth.canLogout) controls.append(action('退出登录', 'logout:' + id, async () => {
        await request('auth.logout', { pluginId: id }); await loadInstalled(); onChanged(); status('已退出登录并撤销启用范围。');
      }));
      card.append(scopeLabel, controls); return card;
    }));
    if (!plugins.length) installedRoot.append(element('p', 'pm-empty', '还没有通过此市场安装能力。可以在“发现”中添加索引或检查本地目录。'));
    if (retainedData.length) {
      const retained = element('section', 'pm-retained-data'); retained.append(element('h4', '', '已卸载但保留的数据'), element('p', '', '卸载不会删除这些数据。只有下面的明确操作才会删除，且不会影响其他插件。'));
      for (const item of retainedData) {
        const row = element('article', 'pm-retained-row'); row.append(element('span', '', `${item.name || item.pluginId} ${item.version || ''}`));
        row.append(action('删除数据', 'delete-data:' + item.pluginId, async () => {
          confirmRemoval(row, '永久删除此插件保留的数据？此操作不用于卸载插件。', async () => {
            await request('plugin.data.delete', { pluginId: item.pluginId }); await loadInstalled(); status('保留数据已删除。');
          });
        })); retained.append(row);
      }
      installedRoot.append(retained);
    }
  }
  let harnessTicket = 0;
  async function loadHarness() {
    const ticket = ++harnessTicket;
    const root = find('.pm-harness');
    root.textContent = '正在查找已配置的外部工具…';
    const data = await request('harness.list');
    if (!active || ticket !== harnessTicket || tab !== 'harness') return;
    root.replaceChildren();
    for (const spec of data.servers || []) {
      const card = element('article', 'pm-card');
      const note = element('p', 'pm-detail-note');
      const key = 'dimension.mcp.check.' + JSON.stringify([spec.sourceHarness, spec.serverName]);
      let last;
      try { last = JSON.parse(localStorage.getItem(key)); } catch {}
      const paint = () => {
        const catalog = { connected: '可读取', failed: '连接失败' };
        const target = { connected: '已连接', failed: '连接失败' };
        note.textContent = ['已发现', spec.configurationError, '上次目录检测：' + (catalog[last?.catalogStatus] || '未验证'),
          '上次目标软件检测：' + (target[last?.targetStatus] || '未验证'), last?.error,
          last?.checkedAt && new Date(last.checkedAt).toLocaleString()].filter(Boolean).join(' · ');
      };
      paint();
      card.append(element('strong', '', spec.serverName), element('p', 'pm-detail-note', '配置来源 · ' + spec.sourceHarness), note,
        action('测试连接', 'harness:' + spec.serverName, async () => {
          const result = await request('harness.probe', { serverName: spec.serverName });
          last = result.status;
          try { localStorage.setItem(key, JSON.stringify(last)); } catch {}
          spec.configurationError = last.configurationError;
          paint();
        }));
      root.append(card);
    }
    if (!root.childElementCount) root.textContent = '没有发现已启用的外部工具服务。';
  }

  function switchTab(next) {
    tab = next; find('.pm-harness').hidden = tab !== 'harness'; find('.pm-discover').hidden = tab !== 'discover'; find('.pm-installed').hidden = tab !== 'installed'; find('.pm-compatibility').hidden = tab !== 'compatibility';
    if (tab !== 'discover') { find('.pm-inspector').hidden = true; inspection = null; detailVersion++; }
    for (const button of host.querySelectorAll('[data-market-tab]')) button.setAttribute('aria-pressed', String(button.dataset.marketTab === tab));
  }
  for (const button of host.querySelectorAll('[data-market-tab]')) button.onclick = () => { switchTab(button.dataset.marketTab); if (tab === 'harness') void loadHarness().catch(error => status(error.message)); if (tab === 'installed') void loadInstalled().catch(error => status(error.message)); };
  find('.pm-source-form').onsubmit = async event => {
    event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button'); if (button.disabled) return;
    button.disabled = true;
    try { await request('source.add', { url: form.elements.url.value.trim() }); form.reset(); await refreshSources(); find('.pm-sources').open = false; await search(); status('索引源已添加。'); }
    catch (error) { status(error.message); } finally { button.disabled = false; }
  };
  find('.pm-local-form').onsubmit = async event => {
    event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button'); if (button.disabled) return;
    button.disabled = true;
    try { await inspectLocal(form.elements.path.value.trim()); } catch (error) { status(error.message); } finally { button.disabled = false; }
  };
  find('.pm-query').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { void search().catch(error => status(error.message)); }, 220); };
  find('.pm-source-filter').onchange = () => { void search().catch(error => status(error.message)); };
  find('.pm-more').onclick = () => { void search(true).catch(error => status(error.message)); };
  find('.pm-refresh').onclick = () => { void refresh().catch(error => status(error.message)); };
  async function refresh() {
    botsPromise = null;
    if (tab === 'harness') { status(''); await loadHarness(); return; }
    status('正在读取插件与索引源…');
    await refreshSources();
    await Promise.all([search(), loadInstalled()]);
    if (active && !find('.pm-status').textContent.includes('：')) status('');
  }
  return {
    async open() { active = true; generation++; try { await refresh(); } catch (error) { status(error.message); } },
    close() { active = false; generation++; searchVersion++; detailVersion++; clearTimeout(searchTimer); },
  };
}
