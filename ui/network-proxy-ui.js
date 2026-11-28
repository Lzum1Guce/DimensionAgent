const MODE_OPTIONS = [
  {
    id: 'auto',
    label: '自动代理',
    badge: '推荐',
    desc: '自动读取 Windows 系统代理、环境变量，并在系统代理关闭（如 TUN 模式）时自动探测本机活跃代理端口，统一分发给模型接口、本机 CLI 与 WSL 沙盒。',
  },
  {
    id: 'global',
    label: '全局代理',
    badge: '',
    desc: '全软件强制走全局代理：留空地址时将自动识别本机活跃可用代理（支持 v2rayN / Clash / Mihomo 等），也可手动填写或点选下方已识别地址。',
  },
  {
    id: 'none',
    label: '无代理',
    badge: '',
    desc: '强制全软件直连，主动忽略电脑系统代理、本机代理探测与子进程环境变量。',
  },
];

const SOURCE_LABELS = {
  'windows-system': 'Windows 系统代理',
  'windows-registry': 'Windows 注册表代理',
  'windows-pac': 'Windows PAC 自动配置脚本',
  environment: '系统环境变量',
  'local-probe': '本机活跃代理（自动识别）',
  none: '未检测到可用代理',
};

function ensureProxyStyles() {
  if (document.getElementById('dimension-network-proxy-styles')) return;
  const style = document.createElement('style');
  style.id = 'dimension-network-proxy-styles';
  style.textContent = `
    .np-root { display: flex; flex-direction: column; gap: 14px; font-size: 13px; color: var(--text, #1f2328); }
    .np-card { border: 1px solid var(--border, rgba(0,0,0,.1)); border-radius: 12px; padding: 14px 16px; background: var(--surface-2, rgba(0,0,0,.02)); display: flex; flex-direction: column; gap: 10px; }
    .np-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .np-title { font-weight: 600; font-size: 13.5px; display: inline-flex; align-items: center; gap: 6px; }
    .np-badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--accent-soft, rgba(196,98,63,.12)); color: var(--accent, #c4623f); font-weight: 500; }
    .np-badge.is-idle { background: rgba(127,127,127,.14); color: var(--muted, #6b7280); }
    .np-sys-grid { display: grid; grid-template-columns: 96px 1fr; gap: 6px 10px; font-size: 12.5px; }
    .np-sys-k { color: var(--muted, #6b7280); }
    .np-sys-v { word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    .np-sys-v.is-prose { font-family: inherit; font-size: 12.5px; }
    .np-modes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .np-mode-btn { text-align: left; border: 1px solid var(--border, rgba(0,0,0,.12)); border-radius: 10px; padding: 10px 11px; background: var(--surface, #fff); color: inherit; cursor: pointer; transition: border-color .15s, background .15s, box-shadow .15s; display: flex; flex-direction: column; gap: 4px; }
    .np-mode-btn:hover { border-color: var(--accent, #c4623f); }
    .np-mode-btn.is-active { border-color: var(--accent, #c4623f); background: var(--accent-soft, rgba(196,98,63,.08)); box-shadow: 0 0 0 1px var(--accent, #c4623f) inset; }
    .np-mode-name { font-weight: 600; font-size: 13px; display: flex; align-items: center; gap: 6px; }
    .np-mode-tag { font-size: 10.5px; padding: 1px 6px; border-radius: 999px; background: var(--accent, #c4623f); color: #fff; font-weight: 500; }
    .np-mode-desc { font-size: 12px; color: var(--muted, #6b7280); line-height: 1.5; margin: 0; }
    .np-field { display: flex; flex-direction: column; gap: 6px; }
    .np-field label { font-size: 12.5px; font-weight: 500; }
    .np-input-row { display: flex; gap: 8px; align-items: center; }
    .np-input { flex: 1; min-width: 0; border: 1px solid var(--border, rgba(0,0,0,.15)); border-radius: 8px; padding: 7px 10px; font-size: 12.5px; background: var(--surface, #fff); color: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .np-input:focus { outline: none; border-color: var(--accent, #c4623f); }
    .np-btn { border: 1px solid var(--border, rgba(0,0,0,.16)); border-radius: 8px; padding: 6px 12px; font-size: 12.5px; background: var(--surface, #fff); color: inherit; cursor: pointer; white-space: nowrap; }
    .np-btn:hover:not(:disabled) { border-color: var(--accent, #c4623f); color: var(--accent, #c4623f); }
    .np-btn.is-primary { background: var(--accent, #c4623f); border-color: var(--accent, #c4623f); color: #fff; font-weight: 500; }
    .np-btn.is-primary:hover:not(:disabled) { filter: brightness(1.06); color: #fff; }
    .np-btn:disabled { opacity: .55; cursor: not-allowed; }
    .np-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .np-status { font-size: 12px; color: var(--muted, #6b7280); min-height: 18px; }
    .np-status.is-error { color: #cf3636; }
    .np-status.is-ok { color: #2b7a4b; }
    .np-hint { font-size: 12px; color: var(--muted, #6b7280); line-height: 1.55; margin: 0; }
    .np-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
    .np-chip { border: 1px solid var(--border, rgba(0,0,0,.15)); border-radius: 999px; padding: 3px 10px; font-size: 11.5px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--surface, #fff); color: inherit; cursor: pointer; }
    .np-chip:hover { border-color: var(--accent, #c4623f); color: var(--accent, #c4623f); }
    .np-chip.is-active { border-color: var(--accent, #c4623f); background: var(--accent-soft, rgba(196,98,63,.1)); color: var(--accent, #c4623f); font-weight: 600; }
  `;
  document.head.appendChild(style);
}

export function bindNetworkProxySettings({ api, host } = {}) {
  if (!host || !api) return { load() {} };
  ensureProxyStyles();

  const state = {
    loading: false,
    saving: false,
    dirty: false,
    settings: {
      mode: 'auto',
      proxyUrl: '',
      bypass: 'localhost,127.0.0.1,::1',
      applyToSandbox: true,
    },
    systemProxy: null,
    effective: null,
    notice: '',
    noticeKind: '',
  };

  const root = document.createElement('div');
  root.className = 'np-root';
  host.innerHTML = '';
  host.appendChild(root);

  const render = () => {
    const sys = state.systemProxy || {};
    const eff = state.effective || {};
    const curMode = state.settings.mode || 'auto';
    const busy = state.loading || state.saving;
    const activeOpt = MODE_OPTIONS.find((m) => m.id === curMode) || MODE_OPTIONS[0];

    root.innerHTML = '';

    // 1. Live OS Proxy Snapshot Card
    const sysCard = document.createElement('div');
    sysCard.className = 'np-card';

    const sysHead = document.createElement('div');
    sysHead.className = 'np-card-head';
    const sysTitle = document.createElement('span');
    sysTitle.className = 'np-title';
    sysTitle.textContent = '电脑系统代理状态';
    const sysBadge = document.createElement('span');
    sysBadge.className = `np-badge${eff.useProxy ? '' : ' is-idle'}`;
    sysBadge.textContent = eff.useProxy ? '已启用代理分发' : '当前直连';

    const headRight = document.createElement('div');
    headRight.style.display = 'inline-flex';
    headRight.style.alignItems = 'center';
    headRight.style.gap = '8px';
    headRight.append(sysBadge);

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'np-btn';
    refreshBtn.textContent = state.loading ? '读取中…' : '重新读取电脑代理';
    refreshBtn.disabled = state.loading || state.saving;
    refreshBtn.addEventListener('click', () => { void load(true); });
    headRight.append(refreshBtn);

    sysHead.append(sysTitle, headRight);
    sysCard.append(sysHead);

    const grid = document.createElement('div');
    grid.className = 'np-sys-grid';
    const addRow = (k, v, prose = false) => {
      const kd = document.createElement('div');
      kd.className = 'np-sys-k';
      kd.textContent = k;
      const vd = document.createElement('div');
      vd.className = prose ? 'np-sys-v is-prose' : 'np-sys-v';
      vd.textContent = v;
      grid.append(kd, vd);
    };
    addRow('识别来源', SOURCE_LABELS[sys.source] || '未检测到', true);
    addRow('识别代理地址', sys.proxyUrl || (sys.autoConfigUrl ? `PAC: ${sys.autoConfigUrl}` : '无'));
    addRow('当前软件生效', eff.summary || '正在读取…', true);
    if (eff.sandboxProxyUrl) {
      addRow('WSL 沙盒同步', eff.sandboxProxyUrl);
    }
    const detectedList = Array.isArray(sys.detectedLocalProxies) ? sys.detectedLocalProxies : [];
    if (detectedList.length) {
      const kd = document.createElement('div');
      kd.className = 'np-sys-k';
      kd.textContent = '本机可用代理';
      const chips = document.createElement('div');
      chips.className = 'np-chips';
      for (const candidateUrl of detectedList) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.disabled = busy;
        chip.className = `np-chip${eff.activeProxyUrl === candidateUrl ? ' is-active' : ''}`;
        chip.textContent = candidateUrl;
        chip.title = '点击立即使用该代理作为全局代理';
        chip.addEventListener('click', () => {
          if (state.saving) return;
          state.settings.mode = 'global';
          state.settings.proxyUrl = candidateUrl;
          void save();
        });
        chips.append(chip);
      }
      grid.append(kd, chips);
    }
    sysCard.append(grid);
    root.append(sysCard);

    // 2. Mode Selector + Global Form Card
    const cfgCard = document.createElement('div');
    cfgCard.className = 'np-card';

    const cfgHead = document.createElement('div');
    cfgHead.className = 'np-card-head';
    const cfgTitle = document.createElement('span');
    cfgTitle.className = 'np-title';
    cfgTitle.textContent = '代理分发模式';
    cfgHead.append(cfgTitle);
    cfgCard.append(cfgHead);

    const modesWrap = document.createElement('div');
    modesWrap.className = 'np-modes';
    modesWrap.setAttribute('role', 'radiogroup');
    modesWrap.setAttribute('aria-label', '代理分发模式');
    for (const opt of MODE_OPTIONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.disabled = busy;
      btn.className = `np-mode-btn${curMode === opt.id ? ' is-active' : ''}`;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', curMode === opt.id ? 'true' : 'false');
      const nameRow = document.createElement('span');
      nameRow.className = 'np-mode-name';
      nameRow.textContent = opt.label;
      if (opt.badge) {
        const tag = document.createElement('span');
        tag.className = 'np-mode-tag';
        tag.textContent = opt.badge;
        nameRow.append(tag);
      }
      btn.append(nameRow);
      btn.addEventListener('click', () => {
        if (state.saving) return;
        state.settings.mode = opt.id;
        state.notice = '';
        state.noticeKind = '';
        render();
        // Auto-save immediately on one-click switch (global with empty URL auto-detects active local proxy).
        void save();
      });
      modesWrap.append(btn);
    }
    cfgCard.append(modesWrap);

    const modeDesc = document.createElement('p');
    modeDesc.className = 'np-mode-desc';
    modeDesc.textContent = activeOpt.desc;
    cfgCard.append(modeDesc);

    // Global Proxy Address Input (visible in global mode)
    if (curMode === 'global') {
      const urlField = document.createElement('div');
      urlField.className = 'np-field';
      const urlLabel = document.createElement('label');
      urlLabel.setAttribute('for', 'npProxyUrlInput');
      urlLabel.textContent = '全局代理地址（留空则自动识别本机可用代理）';
      const urlRow = document.createElement('div');
      urlRow.className = 'np-input-row';
      const urlInput = document.createElement('input');
      urlInput.id = 'npProxyUrlInput';
      urlInput.type = 'text';
      urlInput.disabled = busy;
      urlInput.className = 'np-input';
      urlInput.placeholder = sys.proxyUrl
        ? `留空自动使用：${sys.proxyUrl}`
        : '留空自动识别，或手动填写如 http://127.0.0.1:10808';
      urlInput.value = state.settings.proxyUrl || '';
      urlInput.addEventListener('input', () => {
        state.settings.proxyUrl = urlInput.value;
        state.dirty = true;
      });
      urlInput.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); void save(); }
      });
      urlRow.append(urlInput);

      const autoDetectBtn = document.createElement('button');
      autoDetectBtn.type = 'button';
      autoDetectBtn.className = 'np-btn';
      autoDetectBtn.textContent = '自动识别可用代理';
      autoDetectBtn.disabled = state.loading || state.saving;
      autoDetectBtn.addEventListener('click', () => {
        state.settings.proxyUrl = '';
        urlInput.value = '';
        void save();
      });
      urlRow.append(autoDetectBtn);
      urlField.append(urlLabel, urlRow);
      cfgCard.append(urlField);
    }

    // Bypass & Sandbox Options (shown in auto & global modes)
    if (curMode !== 'none') {
      const bypassField = document.createElement('div');
      bypassField.className = 'np-field';
      const bypassLabel = document.createElement('label');
      bypassLabel.setAttribute('for', 'npBypassInput');
      bypassLabel.textContent = '不走代理的地址（绕过列表，逗号分隔）';
      const bypassInput = document.createElement('input');
      bypassInput.id = 'npBypassInput';
      bypassInput.type = 'text';
      bypassInput.disabled = busy;
      bypassInput.className = 'np-input';
      bypassInput.placeholder = 'localhost,127.0.0.1,::1,*.internal';
      bypassInput.value = state.settings.bypass || 'localhost,127.0.0.1,::1';
      bypassInput.addEventListener('input', () => {
        state.settings.bypass = bypassInput.value;
        state.dirty = true;
      });
      bypassField.append(bypassLabel, bypassInput);
      cfgCard.append(bypassField);

      const sbCheck = document.createElement('label');
      sbCheck.className = 'cs-check';
      const sbInput = document.createElement('input');
      sbInput.type = 'checkbox';
      sbInput.disabled = busy;
      sbInput.checked = state.settings.applyToSandbox !== false;
      sbInput.addEventListener('change', () => {
        state.settings.applyToSandbox = sbInput.checked;
        state.dirty = true;
      });
      sbCheck.append(sbInput, document.createTextNode(' 自动同步代理至 WSL 隔离沙盒与登录终端（本机 127.0.0.1 代理将通过内置透明隧道桥自动穿透 NAT，无需改动防火墙或重启 WSL）'));
      cfgCard.append(sbCheck);
    }

    const actions = document.createElement('div');
    actions.className = 'np-actions';

    const status = document.createElement('span');
    status.className = `np-status${state.noticeKind ? ` is-${state.noticeKind}` : ''}`;
    status.setAttribute('role', 'status');
    status.textContent = state.notice;

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'np-btn is-primary';
    saveBtn.textContent = state.saving ? '正在应用…' : '保存并立即生效';
    saveBtn.disabled = state.saving || state.loading;
    saveBtn.addEventListener('click', () => { void save(); });

    actions.append(status, saveBtn);
    cfgCard.append(actions);

    const footerHint = document.createElement('p');
    footerHint.className = 'np-hint';
    footerHint.textContent = '切换后会即时同步至全部模型 API 请求、联网核实、宿主机本机 CLI（含常驻池）、沙盒安装包下载及插件进程，无需重启客户端。';
    cfgCard.append(footerHint);

    root.append(cfgCard);
  };

  const load = async (announce = false) => {
    if (state.loading || state.saving) return;
    state.loading = true;
    if (announce) {
      state.notice = '正在重新读取电脑系统代理…';
      state.noticeKind = '';
    }
    render();
    try {
      const data = await api('/api/dimension/network-proxy');
      if (data?.settings && !state.dirty) {
        state.settings = {
          mode: data.settings.mode || 'auto',
          proxyUrl: data.settings.proxyUrl || '',
          bypass: data.settings.bypass || 'localhost,127.0.0.1,::1',
          applyToSandbox: data.settings.applyToSandbox !== false,
        };
      }
      state.systemProxy = data?.systemProxy || null;
      state.effective = data?.effective || null;
      if (announce) {
        state.notice = '已同步最新电脑系统代理状态。';
        state.noticeKind = 'ok';
      }
    } catch (err) {
      state.notice = err?.message || '读取代理设置失败';
      state.noticeKind = 'error';
    } finally {
      state.loading = false;
      render();
    }
  };

  const save = async () => {
    if (state.saving || state.loading) return;
    state.dirty = true;
    state.saving = true;
    state.notice = '正在应用全局代理设置…';
    state.noticeKind = '';
    render();
    try {
      const data = await api('/api/dimension/network-proxy', {
        method: 'PUT',
        body: JSON.stringify({
          mode: state.settings.mode,
          proxyUrl: (state.settings.proxyUrl || '').trim(),
          bypass: (state.settings.bypass || '').trim(),
          applyToSandbox: state.settings.applyToSandbox !== false,
        }),
      });
      if (data?.settings) {
        state.settings = {
          mode: data.settings.mode || state.settings.mode,
          proxyUrl: data.settings.proxyUrl || '',
          bypass: data.settings.bypass || 'localhost,127.0.0.1,::1',
          applyToSandbox: data.settings.applyToSandbox !== false,
        };
      }
      state.systemProxy = data?.systemProxy || state.systemProxy;
      state.dirty = false;
      state.effective = data?.effective || state.effective;
      state.notice = `已生效：${state.effective?.summary || '代理配置已更新'}`;
      state.noticeKind = 'ok';
    } catch (err) {
      state.notice = err?.message || '保存代理设置失败';
      state.noticeKind = 'error';
    } finally {
      state.saving = false;
      render();
    }
  };

  render();
  return { load };
}
