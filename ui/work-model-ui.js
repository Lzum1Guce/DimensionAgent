const tiers = [['simple', '简单任务', '提取、改格式、短翻译等'], ['standard', '默认模型', '群主分工、一般实现、整理资料和测试'], ['complex', '复杂任务', '架构、疑难排错、多成果整合；执行遇到困难时动态升级']];
const key = model => JSON.stringify([model.providerId, model.model]);

const poolKey = model => JSON.stringify([model.engineId || "", model.providerId, model.model]);

export function bindWorkModels({ api }) {
  const trigger = document.getElementById('sharedWorkModelsBtn');
  if (!trigger) return;
  const dialog = document.createElement('dialog'); dialog.className = 'work-model-dialog';
  dialog.innerHTML = `<header><h2>模型</h2><button type="button" class="wm-close">关闭</button></header>
    <p>Work 群任务会自动判断难度，按下方设置选模型。独立成员同时执行；同一成员排队，有依赖的任务等待前置成果。</p>
    <form><label class="wm-enable"><input type="checkbox" name="enabled">按难度选择模型</label>
    <div class="wm-tiers"></div><p>未指定时沿用成员模型。请求失败或连续验证失败时，只在已配置的更高档位内升级，每次任务最多两次。已启动的任务使用开始时的路线配置。</p>
    <fieldset><legend>群聊派单可选模型池</legend>
    <p>可混选 Work API 和本机 CLI 模型。CLI 使用自己的登录配置执行，账号权限以实际调用为准。留空时沿用难度档位。</p>
    <label>分配偏好 <select name="routingPreference"><option value="balanced">均衡</option><option value="economy">省费用</option><option value="quality">质量优先</option></select></label>
    <div class="wm-pool"></div>
    <details><summary>手动添加 CLI 型号</summary><p>目录缺少型号时，填入该 CLI 接受的模型 ID。</p>
    <select name="nativeEngine" aria-label="本机 CLI"></select>
    <input name="nativeModel" placeholder="模型 ID" aria-label="模型 ID">
    <input name="nativeProvider" placeholder="Hermes 提供方（可选）" aria-label="原生提供方">
    <button type="button" class="wm-add-native">加入模型池</button></details></fieldset>
    <p class="wm-status" role="status"></p><footer><button type="button" class="wm-refresh">刷新模型</button><button type="submit">保存</button></footer></form>`;
  const form = dialog.querySelector('form'), status = dialog.querySelector('.wm-status');
  for (const [id, title, hint] of tiers) {
    const label = document.createElement('label');
    const text = document.createElement('span'); text.textContent = title;
    const help = document.createElement('small'); help.textContent = hint;
    const select = document.createElement('select'); select.name = id; select.setAttribute('aria-label', title);
    label.append(text, help, select); dialog.querySelector('.wm-tiers').append(label);
  }
  document.body.append(dialog);
  let version = 0, models = [], busy = false, loaded = false;
  const lock = () => { for (const input of form.querySelectorAll('input,select,button')) input.disabled = busy || !loaded;
    dialog.querySelector('.wm-refresh').disabled = busy; };
  const poolList = dialog.querySelector('.wm-pool');
  const selectedPool = () => Array.from(poolList.querySelectorAll('input.wm-choice:checked'), input => {
    const [engineId, providerId, model] = JSON.parse(input.value);
    const row = input.closest('.wm-entry');
    const specialties = [...row.querySelectorAll('[data-specialty]:checked')].map(box => box.value);
    const costTier = row.querySelector('.wm-cost').value;
    return { ...(engineId ? {engineId} : {}), providerId, model, ...(input.dataset.custom ? {custom:true} : {}),
      ...(specialties.length ? {specialties} : {}), ...(costTier !== 'unknown' ? {costTier} : {}),
      ...(row.querySelector('.wm-manual').checked ? {manualOnly:true} : {}) };

  });
  let lastData;
  const paint = data => {
    lastData = data;
    form.elements.nativeEngine.replaceChildren(...(data.cliEngines || []).map(engine => new Option(engine.name, engine.id)));
    models = data.models || []; form.elements.enabled.checked = data.settings.enabled;
    const saved = data.settings.pool || [];
    form.elements.routingPreference.value = data.settings.routingPreference || "balanced";
    const checked = new Map(saved.map(item => [poolKey(item), item]));
    const options = new Map([...saved, ...models, ...(data.cliModels || [])].map(model => [poolKey(model), model]));
    poolList.replaceChildren();
    const groups = new Map();
    for (const [value, model] of options) {
      const group = model.engineId || 'Work API';
      if (!groups.has(group)) {
        const section = document.createElement('details');
        const title = document.createElement('summary');
        title.textContent = group;
        section.open = Array.from(options.values()).some(item => (item.engineId || 'Work API') === group && checked.has(poolKey(item)));
        section.append(title);
        groups.set(group, section);
        poolList.append(section);
      }
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = value;
      const profile = checked.get(value) || model;
      input.className = 'wm-choice';
      if (profile.custom) input.dataset.custom = "true";
      input.checked = checked.has(value);
      label.append(input, document.createTextNode(model.label || `${model.providerId} / ${model.model}`));
      const row = document.createElement('div');
      row.className = 'wm-entry';
      const profileBox = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = '专长与使用偏好';
      profileBox.append(summary);
      const checkbox = (title, value) => {
        const label = document.createElement('label'), box = document.createElement('input');
        box.type = 'checkbox'; box.checked = value; label.append(box, title); profileBox.append(label); return box;
      };
      for (const [id, title] of Object.entries({planning:'规划',frontend:'前端',backend:'后端',debugging:'调试',review:'审查',testing:'测试',routine:'例行任务'})) {
        const box = checkbox(title, profile.specialties?.includes(id)); box.dataset.specialty = id; box.value = id;
      }
      const cost = document.createElement('select'); cost.className = 'wm-cost';
      cost.setAttribute('aria-label','相对成本档');
      for (const [v,t] of Object.entries({unknown:'费用未知',low:'低成本',standard:'标准成本',high:'高成本'})) cost.add(new Option(t,v));
      cost.value = profile.costTier || 'unknown'; profileBox.append(cost);
      checkbox('仅手动选择', profile.manualOnly).className = 'wm-manual';
      profileBox.hidden = !input.checked; input.onchange = () => { profileBox.hidden = !input.checked; };
      row.append(label, profileBox);
      groups.get(group).append(row);
    }
    for (const [id] of tiers) {
      const select = form.elements[id], choice = data.settings.routes[id];
      select.replaceChildren(new Option('沿用成员模型', ''));
      for (const model of models) select.add(new Option(model.label || `${model.providerId} / ${model.model}`, key(model)));
      if (choice && !models.some(model => key(model) === key(choice))) select.add(new Option(`暂不可用：${choice.providerId} / ${choice.model}`, key(choice)));
      select.value = choice ? key(choice) : '';
    }
  };
  const draftSettings = () => ({
      enabled: form.elements.enabled.checked, routingPreference: form.elements.routingPreference.value, pool: selectedPool(),
      routes: Object.fromEntries(tiers.map(([id]) => {
        const value = form.elements[id].value;
        if (!value) return [id, null];
        const [providerId, model] = JSON.parse(value);
        return [id, { providerId, model }];
      }))
    });
  dialog.querySelector('.wm-add-native').onclick = () => {
    const engineId = form.elements.nativeEngine.value, model = form.elements.nativeModel.value.trim();
    const providerId = form.elements.nativeProvider.value.trim();
    const valid = id => /^[A-Za-z0-9._/@:+][A-Za-z0-9._/@:+-]{0,255}$/.test(id);
    if (!engineId || !valid(model) || (providerId && (engineId !== "hermes" || !valid(providerId)))) {
      status.textContent = '请选择本机 CLI 并检查型号及提供方 ID。'; return;
    }
    const settings = draftSettings(), choice = {engineId, providerId, model, custom:true};
    if (!settings.pool.some(item => poolKey(item) === poolKey(choice))) settings.pool.push(choice);
    paint({...lastData, settings});
    form.elements.nativeEngine.value = engineId;
    form.elements.nativeModel.value = '';
    status.textContent = '已加入待保存的模型池。';
  };
  const load = async refresh => {
    const keepEditing = refresh && loaded;
    const ticket = ++version; busy = !keepEditing; lock(); status.textContent = '正在读取可用模型…';
    try {
      const data = await api(`/api/dimension/work-models${refresh ? '?refresh=1' : ''}`);
      if (ticket !== version || !dialog.open) return;
      const editingEngine = keepEditing && form.elements.nativeEngine.value;
      paint(keepEditing ? { ...data, settings: draftSettings() } : data); loaded = true;
      if (editingEngine && data.cliEngines?.some(e => e.id === editingEngine)) form.elements.nativeEngine.value = editingEngine;
      const issues = (data.catalogs || []).filter(catalog => catalog.error);
      status.textContent = issues.length ? issues.slice(0, 3).map(catalog => `${catalog.providerId}：${catalog.error}`).join('；') :
        (models.length || data.cliModels?.length) ? (refresh ? '模型目录已刷新。' : '') : '请先在模型设置中连接一个可用模型。';
    } catch (error) { if (ticket === version) status.textContent = error.message; }
    finally { if (ticket === version) { busy = false; lock(); } }
  };
  trigger.addEventListener('click', () => { if (!dialog.open) { dialog.showModal(); void load(false); } });
  dialog.querySelector('.wm-close').onclick = () => dialog.close();
  dialog.onclose = () => { version++; busy = false; loaded = false; };
  dialog.querySelector('.wm-refresh').onclick = () => void load(true);
  form.onsubmit = async event => {
    event.preventDefault(); if (busy || !loaded) return;
    const routes = {};
    for (const [id] of tiers) {
      const value = form.elements[id].value;
      const choice = models.find(model => key(model) === value);
      if (value && !choice) { status.textContent = '请替换不可用模型，或选择沿用成员模型。'; return; }
      routes[id] = choice ? { providerId: choice.providerId, model: choice.model } : null;
    }
    const ticket = ++version; busy = true; lock(); status.textContent = '正在保存…';
    try {
      const data = await api('/api/dimension/work-models', { method: 'PUT', body: JSON.stringify({ ...draftSettings(), routes }) });
      if (ticket !== version || !dialog.open) return;
      paint(data); status.textContent = '已保存，后续群任务按此分配模型。';
    } catch (error) { if (ticket === version) status.textContent = error.message; }
    finally { if (ticket === version) { busy = false; lock(); } }
  };
}
