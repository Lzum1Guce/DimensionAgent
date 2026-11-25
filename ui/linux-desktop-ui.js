/** Shared software library; each bot has a separate live desktop and browser profile.
 * Supports both embedded Work Browser tab mode and pop-out modal dialog mode.
 */
export function bindLinuxDesktop({ api, getBotId, getBots, onWorkspace, onRequestEmbed, onRequestCloseEmbed } = {}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'linux-desktop-dialog';
  document.body.appendChild(dialog);

  const surface = document.createElement('div');
  surface.className = 'ld-surface';
  surface.innerHTML = `<header class="ld-head"><strong>Linux 工作桌面</strong><select class="ld-bot" aria-label="查看哪个 Bot 的桌面"></select><button type="button" class="ld-popout" title="在独立大窗与侧栏标签页之间切换">独立大窗</button><button type="button" class="ld-close" aria-label="关闭桌面预览">关闭预览</button></header>
    <section class="ld-toolbar"><select class="ld-app" aria-label="公共软件"></select><button type="button" class="ld-launch">启动软件</button><button type="button" class="ld-control">接管键鼠</button><button type="button" class="ld-stop">关闭桌面</button><span class="ld-state"></span></section>
    <div class="ld-meta-row"><div class="ld-workspace"></div><label class="ld-notice ld-network-wrap"><input type="checkbox" class="ld-network"> 允许当前 Bot 联网</label></div>
    <p class="ld-notice ld-hint">软件由所有 Bot 共用，桌面、登录状态和工作区各自独立。可以直接让 Bot 安装软件，安装后自动加入公共清单。</p>
    <div class="ld-screen-wrap"><img class="ld-screen" alt="Bot 的 Linux 桌面" tabindex="0" draggable="false" hidden><div class="ld-empty">启动公共软件后，这里显示该 Bot 的独立桌面。</div></div>
    <div class="ld-input"><textarea class="ld-text" rows="1" placeholder="接管后，可在这里输入中文或长文本，再粘贴到远程软件" aria-label="远程输入文本"></textarea><button type="button" class="ld-paste">粘贴到桌面</button><button type="button" class="ld-enter">Enter</button></div>
    <details class="ld-library"><summary>公共软件设置 · 所有 Bot 可调用</summary><p>登记已安装在 Linux 中的软件。Chrome 已预设；新增软件时填写程序路径。</p><div class="ld-software-rows"></div><div class="ld-software-add"><input class="ld-new-name" placeholder="软件名称" aria-label="软件名称"><input class="ld-new-path" placeholder="/usr/bin/软件程序" aria-label="Linux 程序路径"><button type="button" class="ld-add">添加公共软件</button></div></details>
    <div class="ld-installations" role="status" hidden></div><div class="ld-error" role="status"></div>`;
  dialog.appendChild(surface);

  const el = (selector) => surface.querySelector(selector);
  let mode = 'closed'; // 'closed' | 'embedded' | 'dialog'
  let embedHost = null;
  let botId = '', apps = [], frame = null, human = false, running = false, busy = false, timer = null, generation = 0, pending = 0, refreshing = false;
  let queue = Promise.resolve();
  let streaming = false, previewAvailable = false, desktopId = null;
  const controlledBots = new Set();

  const url = (part = '', target = botId) => target.startsWith('app:')
    ? `/api/dimension/app-bridge/apps/${encodeURIComponent(target.slice(4))}/desktop${part}`
    : `/api/dimension/work/desktops/${encodeURIComponent(target)}${part}`;

  const isActive = () => {
    if (mode === 'dialog') return dialog.open;
    if (mode === 'embedded') return Boolean(embedHost && embedHost.isConnected && !embedHost.hidden);
    return false;
  };
  const current = (target, version) => isActive() && target === botId && version === generation;
  const error = (e) => { el('.ld-error').textContent = e?.message || String(e || ''); };

  const syncModeChrome = () => {
    const isEmb = mode === 'embedded';
    surface.classList.toggle('is-embedded', isEmb);
    const popBtn = el('.ld-popout');
    const closeBtn = el('.ld-close');
    if (popBtn) {
      const canToggle = Boolean(onRequestEmbed) && !botId.startsWith('app:');
      popBtn.hidden = !canToggle;
      popBtn.textContent = isEmb ? '独立大窗' : '回到侧栏';
      popBtn.title = isEmb ? '弹出独立大窗查看（适合高分辨率精细操作）' : '切回右侧 Work 内置浏览器标签页';
    }
    if (closeBtn) {
      closeBtn.hidden = isEmb && !onRequestCloseEmbed;
      closeBtn.textContent = isEmb ? '切回默认页' : '关闭预览';
    }
  };

  const controls = () => {
    el('.ld-bot').disabled = busy;
    el('.ld-control').textContent = human ? (botId.startsWith('app:') ? '恢复自动操作' : '交还给 Bot') : '接管键鼠';
    el('.ld-control').disabled = !running || busy;
    el('.ld-stop').disabled = !running || busy;
    el('.ld-launch').disabled = busy || !apps.length;
    el('.ld-paste').disabled = !human || busy;
    el('.ld-enter').disabled = !human || busy;
    el('.ld-screen').classList.toggle('is-controlled', human);
    el('.ld-state').textContent = (!running ? '桌面未启动' : human ? '你正在接管 · 自动操作已暂停' : '自动控制 · 当前为观看模式') + (streaming ? ' · 30 帧预览' : '');
    syncModeChrome();
  };

  // Input remains ordered; the continuous preview uses a separate connection.
  const enqueue = (job) => {
    const result = queue.then(job);
    queue = result.catch(() => {});
    return result;
  };
  const run = (job, background = false) => {
    const target = botId, version = generation;
    if (background) refreshing = true;
    else { pending++; busy = true; controls(); }
    return enqueue(async () => {
      try {
        if (current(target, version)) await job(target, version);
      } catch (e) { if (current(target, version)) error(e); }
      finally { if (background) refreshing = false; else { pending--; busy = pending > 0; controls(); } }
    });
  };
  const clearFrame = () => {
    frame = null; down = null; streaming = false;
    el('.ld-screen').hidden = true; el('.ld-screen').removeAttribute('src'); el('.ld-empty').hidden = false;
  };
  const resetView = () => {
    clearFrame(); human = false; running = false; previewAvailable = false; desktopId = null;
    el('.ld-workspace').textContent = ''; el('.ld-text').value = ''; error(''); controls();
  };
  const rememberControl = (target, data) => {
    if (data.humanControl) controlledBots.add(target); else controlledBots.delete(target);
  };
  const renderApps = () => {
    const selected = el('.ld-app').value;
    el('.ld-app').replaceChildren(...apps.map((app) => new Option(app.name, app.id)));
    if (apps.some((a) => a.id === selected)) el('.ld-app').value = selected;
    el('.ld-software-rows').replaceChildren(...apps.map((app) => {
      const row = document.createElement('div'); row.className = 'ld-software-row';
      const name = document.createElement('strong'); name.textContent = app.name;
      const path = document.createElement('span'); path.textContent = app.executable;
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '从公共清单移除';
      remove.onclick = async () => {
        try { apps = (await api('/api/dimension/work/software', { method: 'PUT', body: JSON.stringify({ apps: apps.filter((a) => a.id !== app.id) }) })).apps; renderApps(); }
        catch (e) { error(e); }
      };
      row.append(name, path, remove); return row;
    }));
    controls();
  };
  const startStream = () => {
    if (streaming || !previewAvailable || !running || !isActive() || document.hidden) return;
    streaming = true;
    el('.ld-screen').src = url('/stream') + `?view=${generation}&t=${Date.now()}`;
    el('.ld-screen').hidden = false; el('.ld-empty').hidden = true;
    controls();
  };
  const showFrame = (data) => {
    if (!data.observationId) return;
    frame = { ...frame, ...data }; human = Boolean(data.humanControl); running = true;
    const img = el('.ld-screen'), source = `data:image/png;base64,${data.png}`;
    if (data.png && !streaming && img.src !== source) img.src = source;
    img.hidden = false;
    el('.ld-empty').hidden = true;
    startStream(); controls();
  };
  const capture = async (target, version) => {
    const data = await api(url('/action', target), { method: 'POST', body: JSON.stringify({ action: { op: 'observe' } }) });
    rememberControl(target, data);
    if (current(target, version)) showFrame(data);
  };
  const action = (payload, before = () => {}) => {
    bufferedInput = null;
    return run(async (target, version) => {
      before();
      if (payload.op === 'launch') controlledBots.add(target);
      const data = await api(url('/action', target), { method: 'POST', body: JSON.stringify({ action: { ...payload, observationId: frame?.observationId }, fastInput: streaming }) });
      rememberControl(target, data);
      if (current(target, version)) { showFrame(data); error(''); }
    });
  };
  let bufferedInput = null;
  const input = payload => {
    const old = bufferedInput;
    if (old && old.generation === generation && old.payload.op === payload.op) {
      if (payload.op === 'type' && old.payload.text.length + payload.text.length <= 10000) { old.payload.text += payload.text; return; }
      if (payload.op === 'scroll' && Math.sign(old.payload.amount) === Math.sign(payload.amount)) {
        old.payload.amount = Math.max(-10, Math.min(10, old.payload.amount + payload.amount));
        old.payload.x = payload.x; old.payload.y = payload.y; return;
      }
    }
    const item = { payload, generation };
    void action(payload, () => { if (bufferedInput === item) bufferedInput = null; });
    bufferedInput = item;
  };
  const refresh = () => run(async (target, version) => {
    const data = await api(url('', target));
    if (!current(target, version)) return;
    rememberControl(target, data);
    human = data.humanControl; running = data.running;
    previewAvailable = data.previewFps === 30;
    if (desktopId !== data.desktopId) { clearFrame(); desktopId = data.desktopId; }
    if (frame && data.observationId) frame.observationId = data.observationId;
    el('.ld-network').checked = data.networkAccess !== false;
    el('.ld-workspace').textContent = `工作区：${data.workspace}`;
    if (!target.startsWith('app:')) onWorkspace?.(target, data.workspace);
    if (JSON.stringify(apps) !== JSON.stringify(data.apps)) { apps = data.apps; renderApps(); }
    const installs = Array.isArray(data.installations) ? data.installations : [];
    el('.ld-installations').hidden = !installs.length;
    el('.ld-installations').replaceChildren(...installs.map(item => {
      const row = document.createElement('p');
      const status = { installing: '安装中', installed: '安装已验证', failed: '安装失败', 'needs-review': '需要核对' }[item.status] || item.status;
      row.textContent = `${item.name} · ${status}：${item.detail || ''}`;
      return row;
    }));
    if (running) {
      if (!frame || !previewAvailable) await capture(target, version);
      else startStream();
    } else clearFrame();
    controls();
  }, true);
  const release = async (target) => {
    if (!controlledBots.has(target)) return;
    await api(url('/control', target), { method: 'POST', body: JSON.stringify({ human: false }) });
    controlledBots.delete(target);
  };

  const stopSession = ({ keepControl = false } = {}) => {
    const previous = botId;
    generation++;
    clearInterval(timer);
    timer = null;
    resetView();
    if (!keepControl && previous) {
      void enqueue(() => release(previous)).catch(() => {});
    }
  };

  const prepareTarget = (library, targetBotId) => {
    botId = targetBotId || getBotId();
    const application = botId.startsWith('app:');
    dialog.classList.toggle('is-application', application);
    surface.classList.toggle('is-application', application);
    el('.ld-head strong').textContent = application ? '公共应用桌面' : 'Linux 工作桌面';
    el('.ld-empty').textContent = application ? '打开应用后，在这里完成登录；关闭预览会自动交还键鼠。' : '启动公共软件后，这里显示该 Bot 的独立桌面。';
    el('.ld-screen').alt = application ? '公共应用的 Linux 桌面' : 'Bot 的 Linux 桌面';
    const bots = application ? [{ id: botId, name: botId.slice(4) }] : getBots().filter((b) => b.id && !b.id.startsWith('mini:'));
    el('.ld-bot').replaceChildren(...bots.map((b) => new Option(b.name || b.id, b.id)));
    el('.ld-bot').value = botId;
    if (!el('.ld-bot').value) botId = el('.ld-bot').value = bots[0]?.id || '';
    el('.ld-library').open = Boolean(library);
  };

  const startPolling = async (version) => {
    await refresh();
    if (current(botId, version)) {
      clearInterval(timer);
      timer = setInterval(() => { if (!busy && !refreshing && isActive()) void refresh(); }, 1500);
    }
  };

  const openModal = async (library = false, targetBotId = '') => {
    if (mode === 'embedded') {
      stopSession({ keepControl: true });
      mode = 'closed';
      embedHost = null;
    }
    if (dialog.open) return;
    if (surface.parentElement !== dialog) dialog.appendChild(surface);
    generation++;
    mode = 'dialog';
    prepareTarget(library, targetBotId);
    resetView();
    dialog.showModal();
    const version = generation;
    await startPolling(version);
  };

  const attachEmbedded = async (container, { library = false, targetBotId = '' } = {}) => {
    if (!container) return;
    if (dialog.open) {
      mode = 'closed';
      dialog.close();
    }
    const desiredBot = targetBotId || getBotId();
    if (mode === 'embedded' && embedHost === container && surface.parentElement === container && botId === desiredBot && isActive()) {
      if (library) el('.ld-library').open = true;
      startStream();
      void refresh();
      return;
    }
    stopSession({ keepControl: false });
    embedHost = container;
    if (surface.parentElement !== container) {
      container.replaceChildren(surface);
    }
    generation++;
    mode = 'embedded';
    prepareTarget(library, desiredBot);
    resetView();
    const version = generation;
    await startPolling(version);
  };

  const detachEmbedded = () => {
    if (mode !== 'embedded') return;
    mode = 'closed';
    embedHost = null;
    stopSession({ keepControl: false });
  };

  const open = async (library = false, targetBotId = '') => {
    const resolved = targetBotId || '';
    const isApp = resolved.startsWith('app:');
    if (!isApp && onRequestEmbed && onRequestEmbed({ library: Boolean(library), targetBotId: resolved })) {
      return;
    }
    await openModal(library, resolved);
  };

  el('.ld-bot').onchange = async () => {
    if (busy) { el('.ld-bot').value = botId; return; }
    const previous = botId;
    generation++; botId = el('.ld-bot').value; resetView();
    try { await enqueue(() => release(previous)); await refresh(); } catch (e) { error(e); }
  };
  el('.ld-popout').onclick = () => {
    const activeBot = botId;
    const libOpen = el('.ld-library').open;
    if (mode === 'embedded') {
      void openModal(libOpen, activeBot);
    } else if (onRequestEmbed) {
      const keepBot = activeBot;
      mode = 'closed';
      dialog.close();
      onRequestEmbed({ library: libOpen, targetBotId: keepBot });
    }
  };
  el('.ld-close').onclick = () => {
    if (mode === 'embedded') {
      detachEmbedded();
      onRequestCloseEmbed?.();
    } else {
      dialog.close();
    }
  };
  dialog.addEventListener('close', () => {
    if (mode === 'dialog') {
      mode = 'closed';
      stopSession({ keepControl: false });
    }
  });
  el('.ld-launch').onclick = () => action({ op: 'launch', appId: el('.ld-app').value });
  el('.ld-network').onchange = () => run(async (target, version) => {
    await api('/api/dimension/work/settings', { method: 'PATCH', body: JSON.stringify({ botId: target, networkAccess: el('.ld-network').checked }) });
    if (current(target, version)) { running = false; human = false; clearFrame(); error('联网设置已生效；可重新启动软件。'); }
  });
  el('.ld-control').onclick = () => run(async (target, version) => {
    if (!human) controlledBots.add(target);
    const data = await api(url('/control', target), { method: 'POST', body: JSON.stringify({ human: !human }) });
    rememberControl(target, data);
    if (current(target, version)) { human = data.humanControl; controls(); await capture(target, version); }
  });
  el('.ld-stop').onclick = () => run(async (target, version) => {
    await api(url('/stop', target), { method: 'POST', body: '{}' });
    controlledBots.delete(target);
    if (current(target, version)) { running = false; human = false; clearFrame(); controls(); }
  });
  el('.ld-add').onclick = async () => {
    try {
      const name = el('.ld-new-name').value.trim(), executable = el('.ld-new-path').value.trim();
      if (!name || !executable) throw new Error('请填写软件名称和 Linux 程序路径');
      const id = `app-${crypto.randomUUID().slice(0, 8)}`;
      apps = (await api('/api/dimension/work/software', { method: 'PUT', body: JSON.stringify({ apps: [...apps, { id, name, executable, args: [] }] }) })).apps;
      el('.ld-new-name').value = ''; el('.ld-new-path').value = ''; renderApps(); error('');
    } catch (e) { error(e); }
  };
  el('.ld-paste').onclick = () => action({ op: 'type', text: el('.ld-text').value });
  el('.ld-enter').onclick = () => action({ op: 'press', key: 'Return' });

  const image = el('.ld-screen');
  image.onerror = () => {
    if (!isActive() || !streaming) return;
    streaming = false; controls();
    // The status timer reconnects a failed stream without adding a second input queue.
  };
  document.addEventListener('visibilitychange', () => {
    if (!isActive()) return;
    if (document.hidden && streaming) { streaming = false; image.removeAttribute('src'); controls(); }
    else if (!document.hidden) { startStream(); void refresh(); }
  });
  const point = (event) => {
    const box = image.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1279, Math.floor((event.clientX - box.left) * 1280 / box.width))), y: Math.max(0, Math.min(799, Math.floor((event.clientY - box.top) * 800 / box.height))) };
  };
  let down = null;
  image.oncontextmenu = (e) => e.preventDefault();
  image.onpointerdown = (e) => { if (!human) return; e.preventDefault(); image.focus(); down = { ...point(e), button: e.button === 2 ? 3 : 1 }; image.setPointerCapture(e.pointerId); };
  image.onpointerup = (e) => {
    if (!human || !down) return;
    const start = down, end = point(e); down = null;
    const drag = Math.abs(start.x - end.x) + Math.abs(start.y - end.y) > 5;
    input(drag ? { op: 'drag', ...start, toX: end.x, toY: end.y } : { op: 'click', ...end, button: start.button });
  };
  image.addEventListener('wheel', (e) => { if (!human || !e.deltaY) return; e.preventDefault(); input({ op: 'scroll', ...point(e), amount: e.deltaY > 0 ? 3 : -3 }); }, { passive: false });
  dialog.addEventListener('cancel', (e) => {
    if (human && document.activeElement === image) {
      e.preventDefault();
    }
  });
  image.onkeydown = (e) => {
    if (!human || e.isComposing || ['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    e.preventDefault();
    const aliases = { Enter: 'Return', Backspace: 'BackSpace', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', ' ': 'space', Escape: 'Escape', Delete: 'Delete', Tab: 'Tab' };
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) input({ op: 'type', text: e.key });
    else {
      const key = [e.ctrlKey ? 'ctrl' : '', e.altKey ? 'alt' : '', e.shiftKey ? 'shift' : '', aliases[e.key] || e.key].filter(Boolean).join('+');
      input({ op: 'press', key });
    }
  };

  document.getElementById('linuxDesktopBtn')?.addEventListener('click', () => { void open(false, ''); });
  document.getElementById('sharedSoftwareBtn')?.addEventListener('click', () => { void openModal(true, ''); });
  window.addEventListener('dimension-open-desktop', event => { void open(false, event.detail?.botId || ''); });
  window.addEventListener('dimension-open-app-desktop', event => {
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(event.detail?.appId || '') || dialog.open) return;
    void openModal(false, 'app:' + event.detail.appId).then(() => action({ op: 'launch' }));
  });

  return { open, openModal, attachEmbedded, detachEmbedded, isEmbedded: () => mode === 'embedded' };
}
