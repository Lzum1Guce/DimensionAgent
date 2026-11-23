// Dual-Pane Split Popover Picker for Work Execution Engines & Models (API + Native Subscription)

const FAVORITES_STORAGE_KEY = 'dimension.workCliPicker.favorites.v1';

const HARNESS_CATALOG = [
  { id: 'auto', label: '自动调度', shortLabel: '自动', selectableModels: true },
  { id: 'hermes', label: 'Hermes', shortLabel: 'Hermes', selectableModels: true },
  { id: 'deepseek-harness', label: 'DeepSeek Harness', shortLabel: 'DeepSeek', selectableModels: true },
  { id: 'kimi-code', label: 'Kimi Code', shortLabel: 'Kimi Code', selectableModels: true },
  { id: 'claude-code', label: 'Claude Code', shortLabel: 'Claude Code', selectableModels: true },
  { id: 'codex', label: 'Codex', shortLabel: 'Codex', selectableModels: true },
  { id: 'opencode', label: 'OpenCode', shortLabel: 'OpenCode', selectableModels: true },
  { id: 'qwen-code', label: 'Qwen Code', shortLabel: 'Qwen Code', selectableModels: true },
  { id: 'gemini-cli', label: 'Gemini CLI', shortLabel: 'Gemini', selectableModels: true },
  { id: 'builtin', label: '内置轻量', shortLabel: '内置轻量', selectableModels: false },
];

const EFFORT_CYCLE = ['', 'low', 'medium', 'high'];

// Fallback install guidance for engines the backend did not describe.
const INSTALL_GUIDE = {
  'claude-code': { command: 'npm install -g @anthropic-ai/claude-code' },
  codex: { command: 'npm install -g @openai/codex' },
  opencode: { command: 'npm install -g opencode-ai' },
  'qwen-code': { command: 'npm install -g @qwen-code/qwen-code' },
  'gemini-cli': { command: 'npm install -g @google/gemini-cli' },
  'kimi-code': { note: '请参考 Kimi Code 官方文档完成安装，并确认命令行可直接运行。' },
  'deepseek-harness': { note: '请安装 DeepSeek Harness 桌面端或运行 npm install -g @deepseek-ai/dsh。' },
  hermes: { note: '请参考 Hermes 官方文档完成安装，并确认命令行可直接运行。' },
};
const EFFORT_BADGE = {
  low: 'LOW',
  medium: 'MED',
  high: 'HIGH',
};
const EFFORT_LABEL = {
  low: 'Low',
  medium: 'Med',
  high: 'High',
};

function readFavorites() {
  try {
    const raw = JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY) || '[]');
    if (Array.isArray(raw)) return new Set(raw.map(String));
  } catch {}
  return new Set();
}

function saveFavorites(set) {
  try {
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify([...set]));
  } catch {}
}

function svgStar(filled) {
  if (filled) {
    return `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.6l1.92 3.89 4.3.62-3.11 3.03.73 4.28L8 11.4l-3.84 2.02.73-4.28L1.78 6.11l4.3-.62L8 1.6z"/></svg>`;
  }
  return `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.8l1.85 3.75 4.15.6-3 2.92.71 4.13L8 11.25 4.29 13.2 5 9.07 2 6.15l4.15-.6L8 1.8z"/></svg>`;
}

function svgCheck() {
  return `<svg class="hcp-icon-check" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.2 8.3 6.4 11.4 12.8 4.6"/></svg>`;
}

function svgChevronDownSmall() {
  return `<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.2 6.2 8 10l3.8-3.8"/></svg>`;
}

function svgRefresh() {
  return `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.2 8a5.2 5.2 0 1 1-1.35-3.5"/><path d="M13.4 2.8v2.6h-2.6"/></svg>`;
}

function svgPlus() {
  return `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>`;
}

function svgGear() {
  return `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="2.1"/><path d="M8 1.9v1.5M8 12.6v1.5M1.9 8h1.5M12.6 8h1.5M3.7 3.7l1.05 1.05M11.25 11.25l1.05 1.05M12.3 3.7l-1.05 1.05M4.75 11.25 3.7 12.3"/></svg>`;
}

function inferDefaultEffortBadge(modelName) {
  const low = String(modelName || '').toLowerCase();
  if (/flash|mini|lite|haiku|turbo|fast/.test(low)) return 'LOW';
  if (/opus|pro|reasoner|r1|o1|o3|thinking|max/.test(low)) return 'HIGH';
  return '';
}

function prettifyModelShort(modelId) {
  const raw = String(modelId || '').trim();
  if (!raw) return '';
  const slashIdx = raw.lastIndexOf('/');
  return slashIdx >= 0 ? raw.slice(slashIdx + 1) : raw;
}

export function createWorkCliPicker(opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'hcp-trigger-group';

  const triggerBtn = document.createElement('button');
  triggerBtn.type = 'button';
  triggerBtn.id = 'workCliPickerTrigger';
  triggerBtn.className = 'hcp-trigger-btn';
  triggerBtn.setAttribute('aria-haspopup', 'dialog');
  triggerBtn.setAttribute('aria-expanded', 'false');

  const triggerLabel = document.createElement('span');
  triggerLabel.className = 'hcp-trigger-label';
  triggerLabel.textContent = '自动';

  const triggerCaret = document.createElement('span');
  triggerCaret.className = 'hcp-trigger-caret';
  triggerCaret.innerHTML = svgChevronDownSmall();
  triggerBtn.append(triggerLabel, triggerCaret);

  const effortQuickBtn = document.createElement('button');
  effortQuickBtn.type = 'button';
  effortQuickBtn.className = 'hcp-effort-quick';
  effortQuickBtn.title = '点击切换推理强度 (Auto / Low / Med / High)';
  effortQuickBtn.hidden = true;

  wrap.append(triggerBtn, effortQuickBtn);

  // Floating Dual-Pane Popover Panel
  const popover = document.createElement('div');
  popover.id = 'workCliPopover';
  popover.className = 'hcp-popover is-split-pane';
  popover.hidden = true;
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', '选择执行引擎与模型');

  // Top Search Bar
  const searchWrap = document.createElement('div');
  searchWrap.className = 'hcp-search-bar';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'hcp-search-input';
  searchInput.placeholder = '搜索模型或引擎…';
  searchInput.autocomplete = 'off';
  searchInput.spellcheck = false;
  searchWrap.append(searchInput);

  // Split Body: Left Engine Rail + Right Model Pane
  const splitBody = document.createElement('div');
  splitBody.className = 'hcp-split-body';

  const leftRail = document.createElement('aside');
  leftRail.className = 'hcp-left-rail thin-scroll';

  const rightPane = document.createElement('section');
  rightPane.className = 'hcp-right-pane';
  const rightHeader = document.createElement('div');
  rightHeader.className = 'hcp-right-head';
  const rightList = document.createElement('div');
  rightList.className = 'hcp-right-list thin-scroll';
  rightPane.append(rightHeader, rightList);

  splitBody.append(leftRail, rightPane);

  // Compact Single-Row Footer Toolbar
  const footer = document.createElement('div');
  footer.className = 'hcp-footer is-compact-row';

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'hcp-footer-action';
  refreshBtn.innerHTML = `${svgRefresh()}<span>刷新列表</span>`;

  const addModelBtn = document.createElement('button');
  addModelBtn.type = 'button';
  addModelBtn.className = 'hcp-footer-action';
  addModelBtn.innerHTML = `${svgPlus()}<span>添加模型</span>`;

  const editModelBtn = document.createElement('button');
  editModelBtn.type = 'button';
  editModelBtn.className = 'hcp-footer-action';
  editModelBtn.innerHTML = `${svgGear()}<span>管理模型</span>`;

  footer.append(refreshBtn, addModelBtn, editModelBtn);
  popover.append(searchWrap, splitBody, footer);
  document.body.append(popover);

  let favorites = readFavorites();
  let focusedEngineId = ''; // Left rail highlighted engine
  let searchQuery = '';
  let refreshing = false;

  const getSettings = () => opts.getSettings?.() || {};
  const getProviderGroups = () => opts.getProviderGroups?.() || [];

  const getEngineConfig = (settings, engineId) => {
    const map = settings.cliEngineConfigs && typeof settings.cliEngineConfigs === 'object'
      ? settings.cliEngineConfigs
      : {};
    const specific = map[engineId] && typeof map[engineId] === 'object' ? map[engineId] : {};
    return {
      modelSource: specific.modelSource || (engineId === settings.cliEngine ? (settings.cliModelSource || 'work') : 'work'),
      providerId: specific.providerId || '',
      model: specific.model || '',
      reasoningEffort: specific.reasoningEffort || '',
    };
  };

  const resolveAutoTarget = harnesses => {
    const installed = (harnesses || []).find(h => h.installed);
    return installed ? installed.id : 'hermes';
  };

  const placePopover = () => {
    if (popover.hidden || !triggerBtn.isConnected) return;
    const rect = triggerBtn.getBoundingClientRect();
    const width = Math.min(568, window.innerWidth - 24);
    popover.style.width = `${width}px`;
    const popH = Math.min(popover.offsetHeight || 420, window.innerHeight - 24);
    let left = rect.left;
    if (left + width > window.innerWidth - 12) {
      left = Math.max(12, window.innerWidth - width - 12);
    }
    let top = rect.top - popH - 8;
    if (top < 12) {
      top = Math.min(window.innerHeight - popH - 12, rect.bottom + 8);
    }
    popover.style.left = `${Math.round(Math.max(12, left))}px`;
    popover.style.top = `${Math.round(Math.max(12, top))}px`;
  };

  const closePopover = () => {
    if (popover.hidden) return;
    popover.hidden = true;
    triggerBtn.setAttribute('aria-expanded', 'false');
    triggerBtn.classList.remove('is-open');
  };

  const openPopover = () => {
    const settings = getSettings();
    focusedEngineId = settings.cliEngine || 'auto';
    searchQuery = '';
    searchInput.value = '';
    renderSplitView();
    popover.hidden = false;
    triggerBtn.setAttribute('aria-expanded', 'true');
    triggerBtn.classList.add('is-open');
    placePopover();
    requestAnimationFrame(() => {
      placePopover();
      searchInput.focus({ preventScroll: true });
    });
  };

  const togglePopover = () => {
    if (popover.hidden) openPopover();
    else closePopover();
  };

  const emitChange = payload => {
    opts.onChange?.(payload);
  };

  const syncTriggerSummary = () => {
    const settings = getSettings();
    const harnesses = Array.isArray(settings.harnesses) ? settings.harnesses : [];
    const activeEng = settings.cliEngine || 'auto';
    const metaItem = HARNESS_CATALOG.find(x => x.id === activeEng) || HARNESS_CATALOG[0];
    const autoTargetId = resolveAutoTarget(harnesses);
    const autoTargetMeta = HARNESS_CATALOG.find(x => x.id === autoTargetId);
    const targetDesc = harnesses.find(h => h.id === (activeEng === 'auto' ? autoTargetId : activeEng));

    if (activeEng === 'builtin') {
      const lead = opts.getLeadSelection?.();
      const leadShort = prettifyModelShort(lead?.model || '');
      triggerLabel.textContent = leadShort ? `内置轻量 · ${leadShort}` : '内置轻量';
      effortQuickBtn.hidden = true;
      return;
    }

    const cfg = getEngineConfig(settings, activeEng);
    const effectiveSrc = cfg.modelSource || settings.cliModelSource || 'work';
    const baseName = activeEng === 'auto'
      ? `自动 (${autoTargetMeta ? autoTargetMeta.shortLabel : 'Hermes'})`
      : metaItem.shortLabel;

    let subLabel = '';
    if (effectiveSrc === 'native') {
      if (cfg.model) {
        subLabel = prettifyModelShort(cfg.model);
      } else if (targetDesc?.nativeDefaultModel) {
        subLabel = prettifyModelShort(targetDesc.nativeDefaultModel);
      } else {
        subLabel = '原生订阅';
      }
    } else if (cfg.model) {
      subLabel = prettifyModelShort(cfg.model);
    }
    triggerLabel.textContent = subLabel ? `${baseName} · ${subLabel}` : baseName;

    const eff = cfg.reasoningEffort || '';
    effortQuickBtn.hidden = false;
    effortQuickBtn.textContent = EFFORT_LABEL[eff] || 'Auto';
    effortQuickBtn.dataset.effort = eff || 'auto';
  };

  const renderModelItemRow = ({
    favKey,
    displayName,
    tooltip,
    isSelected,
    effortValue,
    onSelect,
    onCycleEffort,
  }) => {
    const isFav = Boolean(favKey && favorites.has(favKey));
    const row = document.createElement('div');
    row.className = `hcp-model-row${isSelected ? ' is-selected' : ''}`;

    if (favKey) {
      const starBtn = document.createElement('button');
      starBtn.type = 'button';
      starBtn.className = `hcp-star-btn${isFav ? ' is-fav' : ''}`;
      starBtn.innerHTML = svgStar(isFav);
      starBtn.title = isFav ? '取消收藏' : '收藏常用模型';
      starBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        if (favorites.has(favKey)) favorites.delete(favKey);
        else favorites.add(favKey);
        saveFavorites(favorites);
        renderSplitView();
      });
      row.append(starBtn);
    }

    const nameEl = document.createElement('span');
    nameEl.className = 'hcp-model-name';
    nameEl.textContent = displayName;
    if (tooltip) nameEl.title = tooltip;
    row.append(nameEl);

    const rightBox = document.createElement('span');
    rightBox.className = 'hcp-row-right';

    const badgeText = EFFORT_BADGE[effortValue] || inferDefaultEffortBadge(displayName);
    if (badgeText && onCycleEffort) {
      const effBtn = document.createElement('button');
      effBtn.type = 'button';
      effBtn.className = `hcp-tier-badge is-clickable${effortValue ? ' is-explicit' : ''}`;
      effBtn.textContent = badgeText;
      effBtn.title = '点击切换推理强度 (LOW / MED / HIGH)';
      effBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        onCycleEffort();
      });
      rightBox.append(effBtn);
    }

    if (isSelected) {
      const chk = document.createElement('span');
      chk.innerHTML = svgCheck();
      rightBox.append(chk.firstElementChild);
    }

    row.append(rightBox);
    row.addEventListener('click', ev => {
      ev.stopPropagation();
      onSelect();
    });
    return row;
  };

  const renderInstallGuide = (engineItem, descriptor) => {
    const card = document.createElement('div');
    card.className = 'hcp-empty-card hcp-install-guide';
    const title = document.createElement('div');
    title.className = 'hcp-install-title';
    title.textContent = `这位伙伴还没来到工坊：${engineItem.label}`;
    const desc = document.createElement('div');
    desc.className = 'hcp-install-desc';
    desc.textContent = '本机未检测到该引擎，暂时无法接取委托。安装后点击下方「刷新列表」即可切换使用。';
    card.append(title, desc);
    const hint = String(descriptor?.installHint || descriptor?.installCommand || INSTALL_GUIDE[engineItem.id]?.command || '').trim();
    if (hint) {
      const code = document.createElement('code');
      code.className = 'hcp-install-cmd';
      code.textContent = hint;
      code.title = '点击复制';
      code.style.cursor = 'copy';
      code.addEventListener('click', ev => {
        ev.stopPropagation();
        navigator.clipboard?.writeText(hint).then(() => {
          code.dataset.copied = 'true';
          setTimeout(() => { delete code.dataset.copied; }, 1200);
        }).catch(() => {});
      });
      card.append(code);
    }
    const note = String(descriptor?.installNote || INSTALL_GUIDE[engineItem.id]?.note || '').trim();
    if (note) {
      const n = document.createElement('div');
      n.className = 'hcp-install-desc';
      n.textContent = note;
      card.append(n);
    }
    return card;
  };

  const renderRightModelPane = (engineItem, descriptor, settings, harnesses, queryLower) => {
    rightHeader.replaceChildren();
    rightList.replaceChildren();

    const activeEng = settings.cliEngine || 'auto';

    // Role Lead / Built-in lightweight model picker (unified here so bottom bar needs zero duplicate model dropdown!)
    if (engineItem.id === '__lead__' || engineItem.id === 'builtin') {
      const leadSel = opts.getLeadSelection?.() || {};
      const statusBox = document.createElement('div');
      statusBox.className = 'hcp-right-status';
      statusBox.innerHTML = `<span class="hcp-status-dot is-ready"></span><span class="hcp-status-text"></span>`;
      statusBox.lastElementChild.textContent = engineItem.id === '__lead__'
        ? '负责接单对话、统筹拆解与汇报总结'
        : '不调外部引擎，直接由以下模型完成任务';
      rightHeader.append(statusBox);

      const providerGroups = getProviderGroups();
      let count = 0;
      for (const group of providerGroups) {
        const provId = String(group.providerId || '').trim();
        const provTitle = String(group.title || provId).toUpperCase();
        const models = (group.models || []).filter(m =>
          !queryLower || String(m).toLowerCase().includes(queryLower) || provTitle.toLowerCase().includes(queryLower)
        );
        if (!models.length) continue;
        count += models.length;
        const hdr = document.createElement('div');
        hdr.className = 'hcp-provider-header';
        hdr.textContent = provTitle;
        rightList.append(hdr);
        for (const modelId of models) {
          const isCur = leadSel.providerId === provId && leadSel.model === modelId;
          rightList.append(renderModelItemRow({
            favKey: `model:${provId}:${modelId}`,
            displayName: prettifyModelShort(modelId),
            tooltip: `${provId} / ${modelId}`,
            isSelected: isCur,
            effortValue: '',
            onSelect: () => {
              if (engineItem.id === 'builtin' && activeEng !== 'builtin') {
                emitChange({ cliEngine: 'builtin' });
              }
              opts.onSelectLeadModel?.({ providerId: provId, model: modelId });
              closePopover();
            },
          }));
        }
      }
      if (!count) {
        const empty = document.createElement('div');
        empty.className = 'hcp-empty-card';
        empty.textContent = '暂无可用 API 模型，请点击下方「添加模型」配置密钥。';
        rightList.append(empty);
      }
      return;
    }

    const autoTargetId = resolveAutoTarget(harnesses);

    // Uninstalled engine: show info + install guide only. Never switch to it,
    // otherwise the next commission is doomed to fail at launch.
    if (engineItem.id !== 'auto' && !descriptor?.installed) {
      const statusBox = document.createElement('div');
      statusBox.className = 'hcp-right-status';
      statusBox.innerHTML = `<span class="hcp-status-dot is-missing"></span><span class="hcp-status-text"></span>`;
      statusBox.lastElementChild.textContent = `${engineItem.label} · 未安装`;
      rightHeader.append(statusBox);
      rightList.append(renderInstallGuide(engineItem, descriptor));
      return;
    }

    const effectiveDesc = engineItem.id === 'auto'
      ? (harnesses.find(h => h.id === autoTargetId) || descriptor)
      : descriptor;

    const cfg = getEngineConfig(settings, engineItem.id);
    const isNative = cfg.modelSource === 'native';

    // Right Header: Clean status indicator (left) + [维度 API | 原生订阅] pills (right)
    const statusBox = document.createElement('div');
    statusBox.className = 'hcp-right-status';
    const ready = engineItem.id === 'auto' ? Boolean(effectiveDesc?.installed) : Boolean(descriptor?.installed);
    const dotClass = ready ? 'is-ready' : 'is-missing';
    let statusText = '';
    if (engineItem.id === 'auto') {
      statusText = effectiveDesc?.installed ? `自动优选 · ${effectiveDesc.name}` : '自动匹配就绪引擎';
    } else if (isNative) {
      statusText = descriptor?.nativeStatusLabel || (ready ? '已就绪' : '未安装');
    } else {
      statusText = ready ? `${engineItem.label} · 已就绪` : `${engineItem.label} · 未安装`;
    }
    statusBox.innerHTML = `<span class="hcp-status-dot ${dotClass}"></span><span class="hcp-status-text"></span>`;
    statusBox.lastElementChild.textContent = statusText;

    const srcSwitch = document.createElement('div');
    srcSwitch.className = 'hcp-source-seg';

    const btnApiSrc = document.createElement('button');
    btnApiSrc.type = 'button';
    btnApiSrc.className = `hcp-source-pill${!isNative ? ' is-active' : ''}`;
    btnApiSrc.textContent = '维度 API';

    const btnNativeSrc = document.createElement('button');
    btnNativeSrc.type = 'button';
    btnNativeSrc.className = `hcp-source-pill${isNative ? ' is-active' : ''}`;
    btnNativeSrc.textContent = '原生订阅';

    btnApiSrc.onclick = ev => {
      ev.stopPropagation();
      const prevWorkModel = cfg.modelSource === 'work' ? cfg.model : '';
      const prevWorkProv = cfg.modelSource === 'work' ? cfg.providerId : '';
      emitChange({
        cliEngine: engineItem.id,
        cliModelSource: 'work',
        cliEngineConfig: {
          engineId: engineItem.id,
          modelSource: 'work',
          providerId: prevWorkProv,
          model: prevWorkModel,
          reasoningEffort: cfg.reasoningEffort,
        },
      });
    };

    btnNativeSrc.onclick = ev => {
      ev.stopPropagation();
      const prevNativeModel = cfg.modelSource === 'native' ? cfg.model : '';
      const prevNativeProv = cfg.modelSource === 'native' ? cfg.providerId : '';
      emitChange({
        cliEngine: engineItem.id,
        cliModelSource: 'native',
        cliEngineConfig: {
          engineId: engineItem.id,
          modelSource: 'native',
          providerId: prevNativeProv,
          model: prevNativeModel,
          reasoningEffort: cfg.reasoningEffort,
        },
      });
    };

    srcSwitch.append(btnApiSrc, btnNativeSrc);
    rightHeader.append(statusBox, srcSwitch);

    // =====================================================================
    // Mode A: Native Subscription Models (discovered from CLI config + catalog)
    // =====================================================================
    if (isNative) {
      const nativeGroups = Array.isArray(effectiveDesc?.nativeModelGroups) ? effectiveDesc.nativeModelGroups : [];
      const defModel = effectiveDesc?.nativeDefaultModel || '';
      const isEngineActive = activeEng === engineItem.id;
      const isDefaultNativeSelected = isEngineActive && !cfg.model;

      if (!queryLower || '默认订阅模型 default auto 原生'.includes(queryLower) || defModel.toLowerCase().includes(queryLower)) {
        const defRow = document.createElement('div');
        defRow.className = `hcp-model-row${isDefaultNativeSelected ? ' is-selected' : ''}`;
        const defName = document.createElement('span');
        defName.className = 'hcp-model-name';
        defName.textContent = defModel ? `默认订阅模型 (${prettifyModelShort(defModel)})` : '默认订阅模型';
        const defRight = document.createElement('span');
        defRight.className = 'hcp-row-right';
        const badge = document.createElement('span');
        badge.className = 'hcp-tier-badge';
        badge.textContent = '默认';
        defRight.append(badge);
        if (isDefaultNativeSelected) {
          const chk = document.createElement('span');
          chk.innerHTML = svgCheck();
          defRight.append(chk.firstElementChild);
        }
        defRow.append(defName, defRight);
        defRow.onclick = () => {
          emitChange({
            cliEngine: engineItem.id,
            cliModelSource: 'native',
            cliEngineConfig: {
              engineId: engineItem.id,
              modelSource: 'native',
              providerId: '',
              model: '',
              reasoningEffort: cfg.reasoningEffort,
            },
          });
          closePopover();
        };
        rightList.append(defRow);
      }

      // Render Favorite Native Models at top if any
      let renderedCount = 0;
      for (const grp of nativeGroups) {
        const grpTitle = String(grp.title || '原生模型');
        const provArg = String(grp.providerArg || '');
        const models = Array.isArray(grp.models) ? grp.models : [];
        const filtered = queryLower
          ? models.filter(m => String(m).toLowerCase().includes(queryLower) || grpTitle.toLowerCase().includes(queryLower))
          : models;
        if (!filtered.length) continue;
        renderedCount += filtered.length;

        const hdr = document.createElement('div');
        hdr.className = 'hcp-provider-header';
        hdr.textContent = grpTitle;
        rightList.append(hdr);

        for (const mId of filtered) {
          const isCurrent = isEngineActive && cfg.model === mId && (cfg.providerId || '') === provArg;
          const favKey = `native:${effectiveDesc?.id || engineItem.id}:${provArg}:${mId}`;
          rightList.append(renderModelItemRow({
            favKey,
            displayName: prettifyModelShort(mId),
            tooltip: mId,
            isSelected: isCurrent,
            effortValue: isCurrent ? cfg.reasoningEffort : '',
            onSelect: () => {
              emitChange({
                cliEngine: engineItem.id,
                cliModelSource: 'native',
                cliEngineConfig: {
                  engineId: engineItem.id,
                  modelSource: 'native',
                  providerId: provArg,
                  model: mId,
                  reasoningEffort: cfg.reasoningEffort,
                },
              });
              closePopover();
            },
            onCycleEffort: () => {
              const curIdx = EFFORT_CYCLE.indexOf(cfg.reasoningEffort || '');
              const nextEff = EFFORT_CYCLE[(curIdx + 1) % EFFORT_CYCLE.length];
              emitChange({
                cliEngine: engineItem.id,
                cliModelSource: 'native',
                cliEngineConfig: {
                  engineId: engineItem.id,
                  modelSource: 'native',
                  providerId: provArg,
                  model: mId,
                  reasoningEffort: nextEff,
                },
              });
            },
          }));
        }
      }

      if (renderedCount === 0 && queryLower) {
        const empty = document.createElement('div');
        empty.className = 'hcp-empty-card';
        empty.textContent = '没有匹配的原生模型';
        rightList.append(empty);
      }
      return;
    }

    // =====================================================================
    // Mode B: Dimension API Models (grouped by configured providers)
    // =====================================================================
    const isEngineActive = activeEng === engineItem.id;
    const isAutoRoute = isEngineActive && (!cfg.providerId || !cfg.model);

    if (!queryLower || '自动匹配 默认 auto'.includes(queryLower)) {
      const autoRow = document.createElement('div');
      autoRow.className = `hcp-model-row${isAutoRoute ? ' is-selected' : ''}`;
      const rName = document.createElement('span');
      rName.className = 'hcp-model-name';
      rName.textContent = '自动匹配';
      const rRight = document.createElement('span');
      rRight.className = 'hcp-row-right';
      const badge = document.createElement('span');
      badge.className = 'hcp-tier-badge';
      badge.textContent = 'AUTO';
      rRight.append(badge);
      if (isAutoRoute) {
        const chk = document.createElement('span');
        chk.innerHTML = svgCheck();
        rRight.append(chk.firstElementChild);
      }
      autoRow.append(rName, rRight);
      autoRow.onclick = () => {
        emitChange({
          cliEngine: engineItem.id,
          cliModelSource: 'work',
          cliEngineConfig: {
            engineId: engineItem.id,
            modelSource: 'work',
            providerId: '',
            model: '',
            reasoningEffort: cfg.reasoningEffort,
          },
        });
        closePopover();
      };
      rightList.append(autoRow);
    }

    const providerGroups = getProviderGroups();
    let anyModelRendered = false;

    // Favorites section at top when not searching
    if (!queryLower) {
      const favItems = [];
      for (const group of providerGroups) {
        const provId = String(group.providerId || '').trim();
        for (const modelId of (group.models || [])) {
          if (favorites.has(`model:${provId}:${modelId}`)) {
            favItems.push({ provId, provTitle: group.title || provId, modelId });
          }
        }
      }
      if (favItems.length) {
        const favHdr = document.createElement('div');
        favHdr.className = 'hcp-provider-header';
        favHdr.textContent = '常用收藏';
        rightList.append(favHdr);
        for (const f of favItems) {
          const isCur = isEngineActive && cfg.providerId === f.provId && cfg.model === f.modelId;
          rightList.append(renderModelItemRow({
            favKey: `model:${f.provId}:${f.modelId}`,
            displayName: prettifyModelShort(f.modelId),
            tooltip: `${f.provTitle} / ${f.modelId}`,
            isSelected: isCur,
            effortValue: isCur ? cfg.reasoningEffort : '',
            onSelect: () => {
              emitChange({
                cliEngine: engineItem.id,
                cliModelSource: 'work',
                cliEngineConfig: {
                  engineId: engineItem.id,
                  modelSource: 'work',
                  providerId: f.provId,
                  model: f.modelId,
                  reasoningEffort: cfg.reasoningEffort,
                },
              });
              closePopover();
            },
            onCycleEffort: () => {
              const curIdx = EFFORT_CYCLE.indexOf(cfg.reasoningEffort || '');
              const nextEff = EFFORT_CYCLE[(curIdx + 1) % EFFORT_CYCLE.length];
              emitChange({
                cliEngine: engineItem.id,
                cliModelSource: 'work',
                cliEngineConfig: {
                  engineId: engineItem.id,
                  modelSource: 'work',
                  providerId: f.provId,
                  model: f.modelId,
                  reasoningEffort: nextEff,
                },
              });
            },
          }));
        }
      }
    }

    for (const group of providerGroups) {
      const provId = String(group.providerId || '').trim();
      const provTitle = String(group.title || provId).toUpperCase();
      const models = Array.isArray(group.models) ? group.models : [];
      const filteredModels = queryLower
        ? models.filter(m =>
            String(m).toLowerCase().includes(queryLower) ||
            provTitle.toLowerCase().includes(queryLower))
        : models;

      if (!filteredModels.length) continue;
      anyModelRendered = true;

      const groupHeader = document.createElement('div');
      groupHeader.className = 'hcp-provider-header';
      groupHeader.textContent = provTitle;
      rightList.append(groupHeader);

      for (const modelId of filteredModels) {
        const favKey = `model:${provId}:${modelId}`;
        const isCurrentModel = isEngineActive && cfg.providerId === provId && cfg.model === modelId;
        rightList.append(renderModelItemRow({
          favKey,
          displayName: prettifyModelShort(modelId),
          tooltip: `${provId} / ${modelId}`,
          isSelected: isCurrentModel,
          effortValue: isCurrentModel ? cfg.reasoningEffort : '',
          onSelect: () => {
            emitChange({
              cliEngine: engineItem.id,
              cliModelSource: 'work',
              cliEngineConfig: {
                engineId: engineItem.id,
                modelSource: 'work',
                providerId: provId,
                model: modelId,
                reasoningEffort: cfg.reasoningEffort,
              },
            });
            closePopover();
          },
          onCycleEffort: () => {
            const curIdx = EFFORT_CYCLE.indexOf(cfg.reasoningEffort || '');
            const nextEff = EFFORT_CYCLE[(curIdx + 1) % EFFORT_CYCLE.length];
            emitChange({
              cliEngine: engineItem.id,
              cliModelSource: 'work',
              cliEngineConfig: {
                engineId: engineItem.id,
                modelSource: 'work',
                providerId: provId,
                model: modelId,
                reasoningEffort: nextEff,
              },
            });
          },
        }));
      }
    }

    if (!anyModelRendered) {
      const empty = document.createElement('div');
      empty.className = 'hcp-empty-card';
      empty.textContent = queryLower
        ? '没有匹配的 API 模型'
        : '尚未添加 API 模型，可点击下方「添加模型」或切至右上角「原生订阅」直接使用本机 CLI。';
      rightList.append(empty);
    }
  };

  const renderSplitView = () => {
    const settings = getSettings();
    const harnesses = Array.isArray(settings.harnesses) ? settings.harnesses : [];
    const activeEng = settings.cliEngine || 'auto';
    const queryLower = searchQuery.trim().toLowerCase();

    if (!focusedEngineId || (focusedEngineId !== '__lead__' && !HARNESS_CATALOG.some(x => x.id === focusedEngineId))) {
      focusedEngineId = activeEng;
    }

    // Sort engines cleanly: [auto] -> [installed ready engines] -> [builtin] -> [uninstalled muted engines]
    const autoItem = HARNESS_CATALOG.find(x => x.id === 'auto');
    const builtinItem = HARNESS_CATALOG.find(x => x.id === 'builtin');
    const cliItems = HARNESS_CATALOG.filter(x => x.id !== 'auto' && x.id !== 'builtin');
    const readyClis = cliItems.filter(it => harnesses.find(h => h.id === it.id)?.installed);
    const missingClis = cliItems.filter(it => !harnesses.find(h => h.id === it.id)?.installed);

    leftRail.replaceChildren();
    const progressLabel = document.createElement('label');
    const progressToggle = document.createElement('input');
    progressToggle.type = 'checkbox';
    progressToggle.checked = settings.roleProgress === true;
    progressLabel.title = '仅用于此角色的单人 Work，开启后 CLI 会参考角色口吻播报进度。';
    progressToggle.onchange = () => emitChange({ roleProgress: progressToggle.checked });
    progressLabel.append(progressToggle, '角色化进度播报');
    leftRail.append(progressLabel);

    // Top unified Role Lead Model slot (replaces separate duplicate #modelTrigger in Work mode!)
    const leadSel = opts.getLeadSelection?.();
    if (opts.onSelectLeadModel) {
      const leadTitle = document.createElement('div');
      leadTitle.className = 'hcp-rail-title';
      leadTitle.textContent = '角色统筹';
      leftRail.append(leadTitle);

      const leadBtn = document.createElement('button');
      leadBtn.type = 'button';
      leadBtn.className = `hcp-engine-btn${focusedEngineId === '__lead__' ? ' is-focused' : ''}`;
      const dot = document.createElement('span');
      dot.className = 'hcp-eng-dot is-ready';
      const lWrap = document.createElement('span');
      lWrap.className = 'hcp-eng-labels';
      const mTxt = document.createElement('span');
      mTxt.className = 'hcp-eng-name';
      mTxt.textContent = '接待与调度';
      const sTxt = document.createElement('small');
      sTxt.className = 'hcp-eng-sub';
      sTxt.textContent = prettifyModelShort(leadSel?.model || '选择模型');
      lWrap.append(mTxt, sTxt);
      leadBtn.append(dot, lWrap);
      leadBtn.onclick = ev => {
        ev.stopPropagation();
        focusedEngineId = '__lead__';
        renderSplitView();
      };
      leftRail.append(leadBtn);
    }

    const railTitle = document.createElement('div');
    railTitle.className = opts.onSelectLeadModel ? 'hcp-rail-divider' : 'hcp-rail-title';
    railTitle.textContent = '执行引擎';
    leftRail.append(railTitle);

    const autoTargetId = resolveAutoTarget(harnesses);
    const autoTargetMeta = HARNESS_CATALOG.find(x => x.id === autoTargetId);

    const appendEngineBtn = (item, { isReady = true, isMuted = false, subHint = '' } = {}) => {
      if (queryLower) {
        const matchSelf = item.label.toLowerCase().includes(queryLower) || item.id.toLowerCase().includes(queryLower);
        // Keep focused engine visible while filtering right-pane models
        if (!matchSelf && item.id !== focusedEngineId) {
          // Also check if any native model of this engine matches searchQuery!
          const desc = harnesses.find(h => h.id === item.id);
          const matchNative = (desc?.nativeModelGroups || []).some(g =>
            (g.models || []).some(m => String(m).toLowerCase().includes(queryLower))
          );
          if (!matchNative && item.id !== activeEng) return;
        }
      }

      const btn = document.createElement('button');
      btn.type = 'button';
      const isFocused = focusedEngineId === item.id;
      const isActive = activeEng === item.id;
      btn.className = `hcp-engine-btn${isFocused ? ' is-focused' : ''}${isActive ? ' is-active' : ''}${isMuted ? ' is-muted' : ''}`;

      const dot = document.createElement('span');
      dot.className = `hcp-eng-dot ${isReady ? 'is-ready' : 'is-missing'}`;

      const labelWrap = document.createElement('span');
      labelWrap.className = 'hcp-eng-labels';
      const mainTxt = document.createElement('span');
      mainTxt.className = 'hcp-eng-name';
      mainTxt.textContent = item.label;
      labelWrap.append(mainTxt);
      if (subHint) {
        const subTxt = document.createElement('small');
        subTxt.className = 'hcp-eng-sub';
        subTxt.textContent = subHint;
        labelWrap.append(subTxt);
      }

      btn.append(dot, labelWrap);
      if (isActive) {
        const chk = document.createElement('span');
        chk.innerHTML = svgCheck();
        btn.append(chk.firstElementChild);
      }

      btn.onclick = ev => {
        ev.stopPropagation();
        focusedEngineId = item.id;
        // Uninstalled engines are browse-only: the right pane shows install
        // guidance, the active engine stays unchanged.
        if (isReady && activeEng !== item.id) {
          const cfg = getEngineConfig(settings, item.id);
          emitChange({
            cliEngine: item.id,
            ...(item.id !== 'builtin' ? { cliModelSource: cfg.modelSource || 'work' } : {}),
          });
        }
        renderSplitView();
      };
      leftRail.append(btn);
    };

    if (autoItem) {
      appendEngineBtn(autoItem, {
        isReady: true,
        subHint: autoTargetMeta ? autoTargetMeta.shortLabel : '',
      });
    }
    for (const it of readyClis) {
      appendEngineBtn(it, { isReady: true });
    }
    if (builtinItem) {
      appendEngineBtn(builtinItem, { isReady: true });
    }
    if (missingClis.length) {
      const missHdr = document.createElement('div');
      missHdr.className = 'hcp-rail-divider';
      missHdr.textContent = '未安装';
      leftRail.append(missHdr);
      for (const it of missingClis) {
        appendEngineBtn(it, { isReady: false, isMuted: true, subHint: '未安装 · 查看安装指引' });
      }
    }

    const focusedMeta = focusedEngineId === '__lead__'
      ? { id: '__lead__', label: '接待与调度', shortLabel: '统筹' }
      : (HARNESS_CATALOG.find(x => x.id === focusedEngineId) || HARNESS_CATALOG[0]);
    const focusedDesc = harnesses.find(h => h.id === focusedMeta.id);
    renderRightModelPane(focusedMeta, focusedDesc, settings, harnesses, queryLower);
  };

  triggerBtn.addEventListener('click', ev => {
    ev.stopPropagation();
    togglePopover();
  });

  effortQuickBtn.addEventListener('click', ev => {
    ev.stopPropagation();
    const settings = getSettings();
    const activeEng = settings.cliEngine || 'auto';
    if (activeEng === 'builtin') return;
    const cfg = getEngineConfig(settings, activeEng);
    const idx = EFFORT_CYCLE.indexOf(cfg.reasoningEffort || '');
    const nextEff = EFFORT_CYCLE[(idx + 1) % EFFORT_CYCLE.length];
    emitChange({
      cliEngine: activeEng,
      cliModelSource: cfg.modelSource || 'work',
      cliEngineConfig: {
        engineId: activeEng,
        modelSource: cfg.modelSource || 'work',
        providerId: cfg.providerId,
        model: cfg.model,
        reasoningEffort: nextEff,
      },
    });
  });

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value || '';
    renderSplitView();
    placePopover();
  });

  refreshBtn.addEventListener('click', async ev => {
    ev.stopPropagation();
    if (refreshing) return;
    refreshing = true;
    refreshBtn.disabled = true;
    const span = refreshBtn.querySelector('span');
    if (span) span.textContent = '刷新中…';
    try {
      await opts.onRefresh?.();
    } finally {
      refreshing = false;
      refreshBtn.disabled = false;
      if (span) span.textContent = '刷新列表';
      if (!popover.hidden) {
        renderSplitView();
        placePopover();
      }
    }
  });

  addModelBtn.addEventListener('click', ev => {
    ev.stopPropagation();
    closePopover();
    opts.onAddCustomModel?.();
  });

  editModelBtn.addEventListener('click', ev => {
    ev.stopPropagation();
    closePopover();
    opts.onEditModels?.();
  });

  document.addEventListener('pointerdown', ev => {
    if (popover.hidden) return;
    const t = ev.target;
    if (popover.contains(t) || wrap.contains(t)) return;
    closePopover();
  });

  // Capture phase on window so the dock / app-level Esc handlers never see
  // the key when it was meant to dismiss this popover.
  window.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && !popover.hidden) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      ev.stopPropagation();
      closePopover();
    }
  }, true);

  window.addEventListener('resize', () => {
    if (!popover.hidden) placePopover();
  });

  return {
    node: wrap,
    close: closePopover,
    sync() {
      syncTriggerSummary();
      if (!popover.hidden) {
        renderSplitView();
        placePopover();
      }
    },
  };
}
