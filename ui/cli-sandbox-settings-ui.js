const CLI_META = {
  antigravity: {
    label: 'Antigravity (agy)',
    desc: 'Google 官方 Antigravity 终端代理 · 支持沙盒一键下载与宿主机安装，无头流式调度多模型',
    pkg: 'antigravity.google/cli/install.sh',
  },
  'claude-code': {
    label: 'Claude Code',
    desc: 'Anthropic 官方编码代理 CLI · 支持维度 API 与 Claude 订阅',
    pkg: '@anthropic-ai/claude-code',
  },
  codex: {
    label: 'Codex',
    desc: 'OpenAI 官方编码代理 CLI · 支持维度 API 与 ChatGPT 订阅',
    pkg: '@openai/codex',
  },
  'gemini-cli': {
    label: 'Gemini CLI',
    desc: 'Google 官方 Gemini 终端代理 · 支持 Google 账号与 API',
    pkg: '@google/gemini-cli',
  },
  'qwen-code': {
    label: 'Qwen Code',
    desc: '通义千问官方编码 CLI · 支持维度 API 与 Qwen OAuth',
    pkg: '@qwen-code/qwen-code',
  },
  opencode: {
    label: 'OpenCode',
    desc: '开源多供应商编码 CLI · 支持灵活模型路由',
    pkg: 'opencode-ai',
  },
  'kimi-code': {
    label: 'Kimi Code',
    desc: 'Moonshot 官方编码 CLI · 支持维度 API 与 Kimi 订阅',
    pkg: '@moonshot-ai/kimi-code',
  },
  'deepseek-harness': {
    label: 'DeepSeek Harness',
    desc: 'DeepSeek 官方编码 CLI (@deepseek-ai/dsh)',
    pkg: '@deepseek-ai/dsh',
  },
  hermes: {
    label: 'Hermes',
    desc: 'Nous Research 开源编码代理（首次拉取完整运行环境，耗时约 1-3 分钟）',
    pkg: 'hermes-agent.nousresearch.com/install.sh',
  },
};

const CLI_ORDER = [
  'antigravity',
  'claude-code',
  'codex',
  'gemini-cli',
  'qwen-code',
  'opencode',
  'kimi-code',
  'deepseek-harness',
  'hermes',
];

const POLICY_OPTIONS = [
  {
    id: 'sandbox_first',
    label: '沙盒优先（推荐）',
    hint: '已装进沙盒的 CLI 全部关在 Bubblewrap 内核沙盒中运行，仅可见当前项目目录（宿主机其他盘符完全不可见）；沙盒未装时平滑兼容宿主机已装 CLI。',
  },
  {
    id: 'sandbox_only',
    label: '仅限沙盒',
    hint: '最高隔离级别：严禁调用 Windows 宿主机 CLI，只允许已下载到隔离沙盒内的 CLI 接取工坊任务。',
  },
  {
    id: 'host_prefer',
    label: '宿主机优先',
    hint: '兼容需要调用 Windows 本机工具链的工程，优先使用宿主机 CLI，宿主机未装时使用沙盒 CLI。',
  },
];

const REGISTRY_OPTIONS = [
  { id: 'npmmirror', label: '国内镜像 (npmmirror)' },
  { id: 'official', label: 'npm 官方源' },
];

export function bindCliSandboxSettings({ api, host, onHarnessesChanged } = {}) {
  if (!host) return { load() {}, pausePolling() {} };

  let state = {
    loading: false,
    environment: null,
    executionPolicy: 'sandbox_first',
    registry: 'npmmirror',
    keepAliveEnabled: true,
    autoWarmOnStart: true,
    windowsAutoStart: false,
    keepAliveStatus: null,
    activeJob: null,
    harnesses: [],
    notice: '',
    noticeIsError: false,
  };
  let pollTimer = null;
  let lastFinishedTaskId = '';
  let confirmingUninstallId = '';

  const root = document.createElement('div');
  root.className = 'cs-cli-sandbox';
  host.replaceChildren(root);

  let visible = false;
  let statusRevision = 0;
  const stopPolling = () => {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  };

  const schedulePoll = () => {
    stopPolling();
    if (!visible || state.activeJob?.status !== 'running') return;
    pollTimer = setTimeout(() => {
      void fetchStatus({ silent: true, refresh: false, pollOnly: true });
    }, 800);
  };

  const setNotice = (text, isError = false) => {
    state.notice = text || '';
    state.noticeIsError = Boolean(isError);
  };

  const fetchStatus = async ({ silent = false, refresh = false, pollOnly = false } = {}) => {
    if (!api) return;
    const revision = ++statusRevision;
    if (!silent) {
      state.loading = true;
      render();
    }
    try {
      const qs = pollOnly ? '?poll=1' : (refresh ? '?refresh=1' : '');
      const data = await api(`/api/dimension/cli-sandbox/status${qs}`);
      if (!visible || revision !== statusRevision) return;
      const prevStatus = state.activeJob?.status;
      if (data?.environment) state.environment = data.environment;
      if (data?.executionPolicy) state.executionPolicy = data.executionPolicy;
      if (data?.registry) state.registry = data.registry;
      if (typeof data?.keepAliveEnabled === 'boolean') state.keepAliveEnabled = data.keepAliveEnabled;
      if (typeof data?.autoWarmOnStart === 'boolean') state.autoWarmOnStart = data.autoWarmOnStart;
      if (typeof data?.windowsAutoStart === 'boolean') state.windowsAutoStart = data.windowsAutoStart;
      if (data?.keepAliveStatus) state.keepAliveStatus = data.keepAliveStatus;
      state.activeJob = data?.activeJob || null;
      if (Array.isArray(data?.harnesses)) state.harnesses = data.harnesses;
      state.loading = false;

      if (
        prevStatus === 'running' &&
        state.activeJob &&
        state.activeJob.status !== 'running' &&
        state.activeJob.taskId &&
        state.activeJob.taskId !== lastFinishedTaskId
      ) {
        lastFinishedTaskId = state.activeJob.taskId;
        if (state.activeJob.status === 'done') {
          const meta = CLI_META[state.activeJob.engineId];
          const label = meta ? meta.label : state.activeJob.engineId;
          setNotice(
            state.activeJob.action === 'uninstall'
              ? `已从隔离沙盒卸载 ${label}`
              : `${label} 已就绪${state.activeJob.version ? ` (v${state.activeJob.version})` : ''}，将在 Bubblewrap 沙盒内隔离工作`,
            false
          );
        } else if (state.activeJob.status === 'cancelled') {
          setNotice('已取消当前沙盒 CLI 操作', false);
        } else if (state.activeJob.status === 'error') {
          setNotice(state.activeJob.error || '沙盒 CLI 操作失败', true);
        }
        onHarnessesChanged?.(state.harnesses);
      }

      render();
      if (state.activeJob?.status === 'running') {
        schedulePoll();
      } else {
        stopPolling();
      }
    } catch (err) {
      if (!visible || revision !== statusRevision) return;
      state.loading = false;
      setNotice(`获取沙盒状态失败：${err?.message || err}`, true);
      render();
      stopPolling();
    }
  };

  const savePolicySettings = async (patch) => {
    if (!api) return;
    setNotice('正在保存隔离策略…', false);
    render();
    try {
      const data = await api('/api/dimension/cli-sandbox/settings', {
        method: 'PUT',
        body: JSON.stringify(patch),
      });
      if (data?.executionPolicy) state.executionPolicy = data.executionPolicy;
      if (data?.registry) state.registry = data.registry;
      if (typeof data?.keepAliveEnabled === 'boolean') state.keepAliveEnabled = data.keepAliveEnabled;
      if (typeof data?.autoWarmOnStart === 'boolean') state.autoWarmOnStart = data.autoWarmOnStart;
      if (typeof data?.windowsAutoStart === 'boolean') state.windowsAutoStart = data.windowsAutoStart;
      if (data?.keepAliveStatus) state.keepAliveStatus = data.keepAliveStatus;
      if (Array.isArray(data?.harnesses)) {
        state.harnesses = data.harnesses;
        onHarnessesChanged?.(state.harnesses);
      }
      setNotice('CLI 与常驻设置已保存并立即生效', false);
      render();
    } catch (err) {
      setNotice(`保存失败：${err?.message || err}`, true);
      render();
    }
  };

  const controlKeepAlive = async (action = 'start') => {
    if (!api) return;
    setNotice(action === 'stop' ? '正在停止沙盒常驻保活…' : '正在启动并预热沙盒常驻守护…', false);
    render();
    try {
      const data = await api('/api/dimension/cli-sandbox/keepalive', {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      if (data?.keepAliveStatus) state.keepAliveStatus = data.keepAliveStatus;
      setNotice(data?.keepAliveStatus?.detail || (action === 'stop' ? '已停止常驻保活' : '常驻保活已启动'), !data?.ok);
      render();
    } catch (err) {
      setNotice(`常驻控制失败：${err?.message || err}`, true);
      render();
    }
  };

  const startInstallOrUpdate = async (engineId, action = 'install') => {
    if (!api) return;
    confirmingUninstallId = '';
    setNotice('', false);
    try {
      const data = await api('/api/dimension/cli-sandbox/install', {
        method: 'POST',
        body: JSON.stringify({ engineId, action, registry: state.registry }),
      });
      state.activeJob = data?.activeJob || null;
      render();
      schedulePoll();
    } catch (err) {
      setNotice(err?.message || '无法启动沙盒下载任务', true);
      render();
    }
  };

  const startUninstall = async (engineId) => {
    if (!api) return;
    confirmingUninstallId = '';
    setNotice('', false);
    try {
      const data = await api('/api/dimension/cli-sandbox/uninstall', {
        method: 'POST',
        body: JSON.stringify({ engineId, clearCredentials: false }),
      });
      state.activeJob = data?.activeJob || null;
      render();
      schedulePoll();
    } catch (err) {
      setNotice(err?.message || '卸载失败', true);
      render();
    }
  };

  const cancelActiveJob = async () => {
    if (!api) return;
    try {
      await api('/api/dimension/cli-sandbox/cancel', { method: 'POST', body: '{}' });
      setNotice('正在停止当前任务…', false);
      render();
    } catch (err) {
      setNotice(err?.message || '取消失败', true);
      render();
    }
  };

  const launchLogin = async (engineId, scope = 'auto') => {
    if (!api) return;
    setNotice('', false);
    try {
      const data = await api('/api/dimension/cli-sandbox/login', {
        method: 'POST',
        body: JSON.stringify({ engineId, scope }),
      });
      setNotice(data?.message || '已打开官方登录终端，请完成登入后点击「刷新探测」。', false);
      render();
    } catch (err) {
      setNotice(err?.message || '无法打开登录终端', true);
      render();
    }
  };

  const render = () => {
    root.replaceChildren();

    const env = state.environment;
    const isJobRunning = state.activeJob?.status === 'running';
    const sandboxReady = Boolean(env?.ready);

    // 1. Environment & Isolation Policy Card
    const topCard = document.createElement('div');
    topCard.className = 'cs-cli-card';

    const envRow = document.createElement('div');
    envRow.className = 'cs-cli-env-head';

    const envBadgeWrap = document.createElement('div');
    envBadgeWrap.className = 'cs-cli-env-status';
    const dot = document.createElement('span');
    dot.className = `cs-cli-dot ${sandboxReady ? 'is-ok' : 'is-warn'}`;
    const envTxt = document.createElement('span');
    envTxt.className = 'cs-cli-env-text';
    envTxt.textContent = state.loading && !env
      ? '正在探测 Bubblewrap 隔离沙盒…'
      : (env?.detail || '隔离沙盒尚未检测');
    envBadgeWrap.append(dot, envTxt);

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'cs-cli-btn is-ghost';
    refreshBtn.textContent = state.loading ? '刷新中…' : '刷新探测';
    refreshBtn.disabled = state.loading;
    refreshBtn.onclick = () => void fetchStatus({ silent: false, refresh: true });

    envRow.append(envBadgeWrap, refreshBtn);
    topCard.append(envRow);

    // Execution policy selector
    const polBlock = document.createElement('div');
    polBlock.className = 'cs-cli-control-block';
    const polLabel = document.createElement('div');
    polLabel.className = 'cs-cli-control-label';
    polLabel.textContent = 'CLI 运行隔离策略';
    const polPills = document.createElement('div');
    polPills.className = 'cs-cli-seg';
    polPills.setAttribute('role', 'radiogroup');
    for (const opt of POLICY_OPTIONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const active = state.executionPolicy === opt.id;
      btn.className = `cs-cli-seg-pill${active ? ' is-active' : ''}`;
      btn.dataset.policy = opt.id;
      btn.setAttribute('aria-checked', active ? 'true' : 'false');
      btn.textContent = opt.label;
      btn.onclick = () => {
        if (state.executionPolicy === opt.id) return;
        void savePolicySettings({ executionPolicy: opt.id });
      };
      polPills.append(btn);
    }
    const activePol = POLICY_OPTIONS.find((x) => x.id === state.executionPolicy) || POLICY_OPTIONS[0];
    const polHint = document.createElement('p');
    polHint.className = 'cs-note cs-cli-hint';
    polHint.textContent = activePol.hint;
    polBlock.append(polLabel, polPills, polHint);
    topCard.append(polBlock);

    // Registry selector
    const regRow = document.createElement('div');
    regRow.className = 'cs-cli-inline-row';
    const regLabel = document.createElement('span');
    regLabel.className = 'cs-cli-control-label';
    regLabel.textContent = 'npm 下载源';
    const regPills = document.createElement('div');
    regPills.className = 'cs-cli-seg';
    for (const rOpt of REGISTRY_OPTIONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const active = state.registry === rOpt.id;
      btn.className = `cs-cli-seg-pill${active ? ' is-active' : ''}`;
      btn.dataset.registry = rOpt.id;
      btn.setAttribute('aria-checked', active ? 'true' : 'false');
      btn.textContent = rOpt.label;
      btn.onclick = () => {
        if (state.registry === rOpt.id) return;
        void savePolicySettings({ registry: rOpt.id });
      };
      regPills.append(btn);
    }
    regRow.append(regLabel, regPills);
    topCard.append(regRow);

    root.append(topCard);

    // 1b. Resident Startup (Keep-Alive & Windows Auto-Start) & CLI Readiness Card
    const kaCard = document.createElement('div');
    kaCard.className = 'cs-cli-card cs-cli-keepalive-card';
    const kaRunning = Boolean(state.keepAliveStatus?.running);
    const installedCount = (state.harnesses || []).filter((h) => h.sandboxInstalled || h.hostInstalled).length;
    const loggedInCount = (state.harnesses || []).filter((h) => h.id !== 'antigravity' && (h.sandboxNativeConfigured || h.hostNativeConfigured || h.nativeConfigured)).length;

    const kaHead = document.createElement('div');
    kaHead.className = 'cs-cli-env-head';
    const kaTitleWrap = document.createElement('div');
    kaTitleWrap.className = 'cs-cli-env-status';
    const kaDot = document.createElement('span');
    kaDot.className = `cs-cli-dot ${kaRunning ? 'is-ok' : 'is-warn'}`;
    const kaTxt = document.createElement('span');
    kaTxt.className = 'cs-cli-env-text';
    const upSec = Math.max(0, Math.round(Number(state.keepAliveStatus?.uptimeSec || 0)));
    const upLabel = upSec >= 60 ? `${Math.floor(upSec / 60)} 分 ${upSec % 60} 秒` : `${upSec} 秒`;
    kaTxt.textContent = kaRunning
      ? `常驻启动运行中 · 沙盒已保持唤醒 ${upLabel}`
      : (state.keepAliveStatus?.detail || '常驻启动未运行（开启后可保证 Agent 与蓝图随时调用各 CLI）');
    kaTitleWrap.append(kaDot, kaTxt);

    const kaHeadRight = document.createElement('div');
    kaHeadRight.className = 'cs-cli-item-actions';
    const summaryPill = document.createElement('span');
    summaryPill.className = 'cs-cli-summary-pill';
    summaryPill.textContent = `已装 ${installedCount}/${CLI_ORDER.length} · 已登入 ${loggedInCount}`;

    const kaActionBtn = document.createElement('button');
    kaActionBtn.type = 'button';
    kaActionBtn.className = `cs-cli-btn ${kaRunning ? 'is-ghost' : 'is-primary'}`;
    kaActionBtn.textContent = kaRunning ? '停止常驻' : '立即常驻启动';
    kaActionBtn.disabled = !sandboxReady && !kaRunning;
    kaActionBtn.onclick = () => void controlKeepAlive(kaRunning ? 'stop' : 'start');

    kaHeadRight.append(summaryPill, kaActionBtn);
    kaHead.append(kaTitleWrap, kaHeadRight);
    kaCard.append(kaHead);

    const makeToggleRow = (idKey, title, desc, checked, onChange) => {
      const rowEl = document.createElement('label');
      rowEl.className = 'cs-cli-toggle-row';
      rowEl.dataset.settingKey = idKey;
      const txtWrap = document.createElement('div');
      txtWrap.className = 'cs-cli-toggle-copy';
      const t = document.createElement('div');
      t.className = 'cs-cli-control-label';
      t.textContent = title;
      const d = document.createElement('div');
      d.className = 'cs-cli-item-desc';
      d.textContent = desc;
      txtWrap.append(t, d);

      const sw = document.createElement('span');
      sw.className = `cs-cli-switch${checked ? ' is-on' : ''}`;
      const inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.checked = Boolean(checked);
      inp.onchange = () => onChange(inp.checked);
      const knob = document.createElement('span');
      knob.className = 'cs-cli-switch-knob';
      sw.append(inp, knob);

      rowEl.append(txtWrap, sw);
      return rowEl;
    };

    kaCard.append(
      makeToggleRow(
        'keepAliveEnabled',
        '沙盒后台常驻保活（推荐开启）',
        '保持隔离沙盒持续待命不自动休眠，确保 Agent 与 DimensionImage 随时秒调各个 CLI 与模型。',
        state.keepAliveEnabled,
        (val) => void savePolicySettings({ keepAliveEnabled: val })
      ),
      makeToggleRow(
        'autoWarmOnStart',
        '应用启动时自动预热 CLI 与登入态',
        '每次打开软件自动检测全部已安装 CLI 和账号登入状态，减少首次派发任务的等待时间。',
        state.autoWarmOnStart,
        (val) => void savePolicySettings({ autoWarmOnStart: val })
      ),
      makeToggleRow(
        'windowsAutoStart',
        '随 Windows 开机常驻启动',
        '登录电脑时自动在后台拉起 DimensionAgent 与沙盒守护，保证日常定时任务与 CLI 随叫随到。',
        state.windowsAutoStart,
        (val) => void savePolicySettings({ windowsAutoStart: val })
      )
    );
    root.append(kaCard);

    if (state.notice) {
      const noticeEl = document.createElement('div');
      noticeEl.className = `cs-cli-notice${state.noticeIsError ? ' is-error' : ''}`;
      noticeEl.setAttribute('role', 'status');
      noticeEl.textContent = state.notice;
      root.append(noticeEl);
    }

    // 2. Active Job Progress & Live Log Panel
    const job = state.activeJob;
    if (job && job.status && job.status !== 'idle') {
      const jobCard = document.createElement('div');
      jobCard.className = `cs-cli-job-card is-${job.status}`;

      const jHead = document.createElement('div');
      jHead.className = 'cs-cli-job-head';
      const meta = CLI_META[job.engineId];
      const name = meta ? meta.label : job.engineId;
      const actLabel = job.action === 'uninstall' ? '卸载' : (job.action === 'update' ? '更新' : '下载安装');
      const statusText = job.status === 'running'
        ? `正在沙盒内${actLabel} ${name}…`
        : job.status === 'done'
        ? `${name} ${actLabel}完成${job.version ? ` (v${job.version})` : ''}`
        : job.status === 'cancelled'
        ? `已取消 ${name} 的${actLabel}`
        : `${name} ${actLabel}失败`;

      const titleSpan = document.createElement('span');
      titleSpan.className = 'cs-cli-job-title';
      titleSpan.textContent = statusText;
      jHead.append(titleSpan);

      if (job.status === 'running') {
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'cs-cli-btn is-danger-ghost';
        cancelBtn.textContent = '取消';
        cancelBtn.onclick = () => void cancelActiveJob();
        jHead.append(cancelBtn);
      }
      jobCard.append(jHead);

      const logs = Array.isArray(job.logs) ? job.logs : [];
      if (logs.length) {
        const logBox = document.createElement('pre');
        logBox.className = 'cs-cli-log-box thin-scroll';
        logBox.textContent = logs.slice(-24).join('\n');
        jobCard.append(logBox);
        requestAnimationFrame(() => {
          logBox.scrollTop = logBox.scrollHeight;
        });
      }
      root.append(jobCard);
    }

    // 3. Official Code CLI List
    const listWrap = document.createElement('div');
    listWrap.className = 'cs-cli-list';

    const byId = new Map((state.harnesses || []).map((h) => [h.id, h]));
    for (const id of CLI_ORDER) {
      const meta = CLI_META[id];
      const desc = byId.get(id) || {};
      const sbInstalled = Boolean(desc.sandboxInstalled);
      const sbVer = String(desc.sandboxVersion || '');
      const sbAuth = Boolean(desc.sandboxNativeConfigured);
      const hostInstalled = Boolean(desc.hostInstalled);
      const hostAuth = Boolean(desc.hostNativeConfigured);
      const anyAuth = sbAuth || hostAuth || Boolean(desc.nativeConfigured);
      const isThisRunning = isJobRunning && job?.engineId === id;

      const row = document.createElement('div');
      row.className = `cs-cli-item${sbInstalled ? ' is-sandbox-ready' : ''}`;
      row.dataset.engineId = id;

      const info = document.createElement('div');
      info.className = 'cs-cli-item-info';

      const titleLine = document.createElement('div');
      titleLine.className = 'cs-cli-item-title-line';
      const strong = document.createElement('strong');
      strong.className = 'cs-cli-item-name';
      strong.textContent = meta.label;
      titleLine.append(strong);

      if (sbInstalled) {
        const b = document.createElement('span');
        b.className = 'cs-cli-badge is-sandbox';
        b.textContent = `沙盒已装${sbVer ? ` v${sbVer}` : ''}`;
        titleLine.append(b);
      } else {
        const b = document.createElement('span');
        b.className = 'cs-cli-badge is-missing';
        b.textContent = '沙盒未装';
        titleLine.append(b);
      }

      if (hostInstalled) {
        const hb = document.createElement('span');
        hb.className = 'cs-cli-badge is-host';
        hb.textContent = '宿主机已装';
        titleLine.append(hb);
      }

      if (sbInstalled || hostInstalled) {
        const authB = document.createElement('span');
        authB.className = `cs-cli-badge ${anyAuth ? 'is-auth' : 'is-unauth'}`;
        authB.textContent = id === 'antigravity' ? (anyAuth ? '发现配置 · 登录待验证' : '登录待验证') : anyAuth ? '✓ 已登入' : '未登入（可点右侧登入）';
        titleLine.append(authB);
      }

      const descEl = document.createElement('div');
      descEl.className = 'cs-cli-item-desc';
      descEl.textContent = meta.desc;

      const pkgEl = document.createElement('code');
      pkgEl.className = 'cs-cli-item-pkg';
      pkgEl.textContent = desc.sandboxInstallPackage || meta.pkg;

      info.append(titleLine, descEl, pkgEl);

      const actions = document.createElement('div');
      actions.className = 'cs-cli-item-actions';

      if (isThisRunning) {
        const busyTag = document.createElement('span');
        busyTag.className = 'cs-cli-busy-tag';
        busyTag.textContent = job.action === 'uninstall' ? '卸载中…' : '下载中…';
        actions.append(busyTag);
      } else if (sbInstalled) {
        if (confirmingUninstallId === id) {
          const confirmBtn = document.createElement('button');
          confirmBtn.type = 'button';
          confirmBtn.className = 'cs-cli-btn is-danger';
          confirmBtn.textContent = '确认卸载';
          confirmBtn.disabled = isJobRunning;
          confirmBtn.onclick = () => void startUninstall(id);

          const abortBtn = document.createElement('button');
          abortBtn.type = 'button';
          abortBtn.className = 'cs-cli-btn is-ghost';
          abortBtn.textContent = '取消';
          abortBtn.onclick = () => {
            confirmingUninstallId = '';
            render();
          };
          actions.append(confirmBtn, abortBtn);
        } else {
          const loginBtn = document.createElement('button');
          loginBtn.type = 'button';
          loginBtn.className = `cs-cli-btn ${sbAuth ? 'is-ghost' : 'is-primary'}`;
          loginBtn.textContent = sbAuth ? '重新登入' : '登入账号';
          loginBtn.title = '打开沙盒独立官方登录终端（授权后 Agent 与 DimensionImage 即可直接调用其原生模型）';
          loginBtn.disabled = isJobRunning || !sandboxReady;
          loginBtn.onclick = () => void launchLogin(id, 'sandbox');

          const updBtn = document.createElement('button');
          updBtn.type = 'button';
          updBtn.className = 'cs-cli-btn is-ghost';
          updBtn.textContent = '更新';
          updBtn.disabled = isJobRunning || !sandboxReady;
          updBtn.onclick = () => void startInstallOrUpdate(id, 'update');

          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'cs-cli-btn is-danger-ghost';
          delBtn.textContent = '卸载';
          delBtn.disabled = isJobRunning || !sandboxReady;
          delBtn.onclick = () => {
            confirmingUninstallId = id;
            render();
          };
          actions.append(loginBtn, updBtn, delBtn);
        }
      } else {
        if (hostInstalled) {
          const hostLoginBtn = document.createElement('button');
          hostLoginBtn.type = 'button';
          hostLoginBtn.className = `cs-cli-btn ${hostAuth ? 'is-ghost' : 'is-login-accent'}`;
          hostLoginBtn.textContent = hostAuth ? '重新登入' : '宿主机登入';
          hostLoginBtn.title = '打开宿主机官方登录终端完成账号授权';
          hostLoginBtn.disabled = isJobRunning;
          hostLoginBtn.onclick = () => void launchLogin(id, 'host');
          actions.append(hostLoginBtn);
        }
        const dlBtn = document.createElement('button');
        dlBtn.type = 'button';
        dlBtn.className = 'cs-cli-btn is-primary';
        dlBtn.textContent = '下载到沙盒';
        dlBtn.disabled = isJobRunning || !sandboxReady;
        if (!sandboxReady) dlBtn.title = '请先确保隔离沙盒（WSL dimension-sandbox）已就绪';
        dlBtn.onclick = () => void startInstallOrUpdate(id, 'install');
        actions.append(dlBtn);
      }

      row.append(info, actions);
      listWrap.append(row);
    }

    root.append(listWrap);

    const footerNote = document.createElement('p');
    footerNote.className = 'cs-note cs-cli-footer-note';
    footerNote.textContent =
      '所有官方 CLI 均在点击后从官方源实时下载至隔离沙盒 /opt/dimension-tools（只读挂载）。运行时经 Bubblewrap (--unshare-all --cap-drop ALL) 仅挂载当前项目为 /workspace，宿主机其他盘符与环境变量完全不可见；维度 API 模式下载即用免登录，官方订阅模式可点击「登录账号」在引擎隔离目录中自主授权。';
    root.append(footerNote);
  };

  render();

  return {
    load(opts = {}) {
      visible = true;
      return fetchStatus({ silent: false, refresh: Boolean(opts.refresh) });
    },
    pausePolling() {
      visible = false;
      ++statusRevision;
      stopPolling();
    },
  };
}
