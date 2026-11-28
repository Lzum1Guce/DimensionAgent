import { apiEffortLevels, arrangeModels, effortLevels, modelChoice } from './model-catalog-view.js';
import { cliOptions } from './cli-engine-catalog.js';

// Dual-Pane Split Popover Picker for Work Execution Engines & Models (API + Native Subscription)

const FAVORITES_STORAGE_KEY = 'dimension.workCliPicker.favorites.v1';

const SHORT_LABELS = { antigravity: 'Antigravity', 'deepseek-harness': 'DeepSeek', 'gemini-cli': 'Gemini' };
const HARNESS_CATALOG = [
  { id: 'auto', label: '自动调度', shortLabel: '自动' },
  ...cliOptions(['antigravity', 'hermes', 'deepseek-harness', 'kimi-code', 'claude-code', 'codex', 'opencode', 'qwen-code', 'gemini-cli'])
    .map(engine => ({ ...engine, shortLabel: SHORT_LABELS[engine.id] || engine.label })),
  { id: 'builtin', label: '内置轻量', shortLabel: '内置轻量' },
];

// Fallback install guidance for engines the backend did not describe.
const INSTALL_GUIDE = {
  antigravity: {
    command: 'irm https://antigravity.google/cli/install.ps1 | iex',
    note: '在 PowerShell 运行上方官方命令安装 agy，并在终端执行一次 agy 完成登录即可。',
  },
  'claude-code': { command: 'npm install -g @anthropic-ai/claude-code' },
  codex: { command: 'npm install -g @openai/codex' },
  opencode: { command: 'npm install -g opencode-ai' },
  'qwen-code': { command: 'npm install -g @qwen-code/qwen-code' },
  'gemini-cli': { command: 'npm install -g @google/gemini-cli' },
  'kimi-code': { note: '请参考 Kimi Code 官方文档完成安装，并确认命令行可直接运行。' },
  'deepseek-harness': { note: '请安装 DeepSeek Harness 桌面端或运行 npm install -g @deepseek-ai/dsh。' },
  hermes: { note: '请参考 Hermes 官方文档完成安装，并确认命令行可直接运行。' },
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

  wrap.append(triggerBtn);

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
  let leadPaneSource = '';  // '' (follow saved) | 'api' | 'cli'
  let searchQuery = '';
  let refreshing = false;

  const getSettings = () => opts.getSettings?.() || {};
  const getProviderGroups = () => opts.getProviderGroups?.() || [];

  const getWorkLeadConfig = settings => {
    const wl = settings?.workLead && typeof settings.workLead === 'object' ? settings.workLead : {};
    const isCli = wl.mode === 'cli' && wl.engineId && wl.engineId !== 'auto' && wl.engineId !== 'builtin';
    return {
      mode: isCli ? 'cli' : 'api',
      engineId: isCli ? String(wl.engineId) : '',
      providerId: isCli ? String(wl.providerId || '') : '',
      model: isCli ? String(wl.model || '') : '',
      reasoningEffort: isCli ? String(wl.reasoningEffort || '') : '',
    };
  };

  const formatWorkLeadSummary = (settings, harnesses) => {
    const wl = getWorkLeadConfig(settings);
    if (wl.mode === 'cli') {
      const meta = HARNESS_CATALOG.find(x => x.id === wl.engineId);
      const desc = (harnesses || []).find(h => h.id === wl.engineId);
      const engLabel = meta ? meta.shortLabel : wl.engineId;
      const mLabel = prettifyModelShort(wl.model || desc?.nativeDefaultModel || '');
      return mLabel ? `${engLabel} · ${mLabel}` : `${engLabel} · 原生订阅`;
    }
    const lead = opts.getLeadSelection?.();
    return prettifyModelShort(lead?.model || '');
  };

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
    leadPaneSource = '';
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
    if ((!Array.isArray(settings.harnesses) || !settings.harnesses.length) && !refreshing && opts.onRefresh) {
      refreshing = true;
      refreshBtn.disabled = true;
      Promise.resolve(opts.onRefresh({ silent: true })).finally(() => {
        refreshing = false;
        refreshBtn.disabled = false;
        syncTriggerSummary();
        if (!popover.hidden) {
          renderSplitView();
          placePopover();
        }
      });
    }
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
      const leadSummary = formatWorkLeadSummary(settings, harnesses);
      triggerLabel.textContent = leadSummary ? `内置轻量 · ${leadSummary}` : '内置轻量';
      return;
    }

    const cfg = getEngineConfig(settings, activeEng);
    const effectiveSrc = targetDesc?.supportsCustomModel === false
      ? 'native'
      : (cfg.modelSource || settings.cliModelSource || 'work');
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
    const workerLabel = subLabel ? `${baseName} · ${subLabel}` : baseName;
    const leadSummary = opts.onSelectLeadModel ? formatWorkLeadSummary(settings, harnesses) : '';
    const leadCompact = leadSummary ? leadSummary.split(' · ')[0] : '';
    triggerLabel.textContent = leadCompact ? `${leadCompact} → ${workerLabel}` : workerLabel;
    triggerBtn.title = leadSummary
      ? `接待指挥（谈需求/验收）：${leadSummary} → 实干执行 CLI：${workerLabel}`
      : `实干执行 CLI：${workerLabel}`;

  };

  const renderModelItemRow = ({
    favKey,
    displayName,
    tooltip,
    isSelected,
    effortValue,
    onSelect,
    modelId, scope, engine,
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
    if (modelId) {
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.onkeydown = event => {
        if (event.target === row && ['Enter', ' '].includes(event.key)) {
          event.preventDefault();
          row.click();
        }
      };
      modelChoice(row, {id:modelId, scope, engine, levels:engine ? effortLevels(engine) : apiEffortLevels(modelId), effort:effortValue,
        selected:isSelected, favorite:isFav, apply:onSelect});
    }
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
    const canSandboxInstall = Boolean(opts.onOpenCliSandboxSettings) && descriptor?.sandboxInstallable !== false;
    desc.textContent = canSandboxInstall
      ? '推荐直接在设置中一键下载到隔离沙盒（Bubblewrap），仅可见当前项目目录、免污染宿主机。'
      : '请在本机终端运行下方官方安装命令并完成一次登录，随后点击「刷新列表」即可自动接入。';
    card.append(title, desc);
    if (canSandboxInstall) {
      const goBtn = document.createElement('button');
      goBtn.type = 'button';
      goBtn.className = 'cs-cli-btn is-primary hcp-go-sandbox-btn';
      goBtn.textContent = `前往设置下载 ${engineItem.label} 到沙盒`;
      goBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        closePopover();
        opts.onOpenCliSandboxSettings();
      });
      card.append(goBtn);
    }
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

    // Role Lead / Built-in lightweight model picker (supports both Dimension API & local installed Code CLIs!)
    if (engineItem.id === '__lead__' || engineItem.id === 'builtin') {
      const leadSel = opts.getLeadSelection?.() || {};
      const wl = getWorkLeadConfig(settings);
      const effectiveLeadSrc = leadPaneSource || wl.mode;
      const showCliMode = effectiveLeadSrc === 'cli';

      const statusBox = document.createElement('div');
      statusBox.className = 'hcp-right-status';
      statusBox.innerHTML = `<span class="hcp-status-dot is-ready"></span><span class="hcp-status-text"></span>`;
      statusBox.lastElementChild.textContent = engineItem.id === '__lead__'
        ? (showCliMode ? '接待谈需求并指挥实干 CLI · 本机 CLI' : '负责谈需求、派单给 CLI 实干并验收')
        : '直接由下方模型执行（不使用 CLI）';

      const leadSwitch = document.createElement('div');
      leadSwitch.className = 'hcp-source-seg';
      const btnLeadApi = document.createElement('button');
      btnLeadApi.type = 'button';
      btnLeadApi.className = `hcp-source-pill${!showCliMode ? ' is-active' : ''}`;
      btnLeadApi.textContent = '维度 API';
      btnLeadApi.onclick = ev => {
        ev.stopPropagation();
        leadPaneSource = 'api';
        renderSplitView();
      };
      const btnLeadCli = document.createElement('button');
      btnLeadCli.type = 'button';
      btnLeadCli.className = `hcp-source-pill${showCliMode ? ' is-active' : ''}`;
      btnLeadCli.textContent = '本机 Code CLI';
      btnLeadCli.onclick = ev => {
        ev.stopPropagation();
        leadPaneSource = 'cli';
        renderSplitView();
      };
      leadSwitch.append(btnLeadApi, btnLeadCli);
      if (typeof opts.onOpenCliReceptionModal === 'function') {
        const btnLeadSettings = document.createElement('button');
        btnLeadSettings.type = 'button';
        btnLeadSettings.className = 'hcp-lead-settings-btn';
        btnLeadSettings.title = '查看全部可用本机 CLI 模型并统一设置接待模型';
        btnLeadSettings.innerHTML = `${svgGear()}<span>设置</span>`;
        btnLeadSettings.onclick = ev => {
          ev.stopPropagation();
          closePopover();
          opts.onOpenCliReceptionModal();
        };
        rightHeader.append(statusBox, leadSwitch, btnLeadSettings);
      } else {
        rightHeader.append(statusBox, leadSwitch);
      }

      if (showCliMode) {
        const cliEngines = HARNESS_CATALOG.filter(x => x.id !== 'auto' && x.id !== 'builtin');
        const installedClis = cliEngines.filter(it => harnesses.find(h => h.id === it.id)?.installed);
        const missingClis = cliEngines.filter(it => !harnesses.find(h => h.id === it.id)?.installed);
        let renderedCount = 0;

        for (const cliItem of installedClis) {
          const desc = harnesses.find(h => h.id === cliItem.id);
          const defModel = desc?.nativeDefaultModel || '';
          const nativeGroups = Array.isArray(desc?.nativeModelGroups) ? desc.nativeModelGroups : [];
          const engineMatch = !queryLower || cliItem.label.toLowerCase().includes(queryLower) || cliItem.id.toLowerCase().includes(queryLower);

          const matchedEntries = [];
          if (engineMatch || '默认原生订阅 default auto'.includes(queryLower) || defModel.toLowerCase().includes(queryLower)) {
            matchedEntries.push({
              isDefault: true,
              providerArg: '',
              modelId: '',
              displayName: defModel ? `默认订阅（${prettifyModelShort(defModel)}）` : '默认原生订阅模型',
              tooltip: `${cliItem.label} · 使用本机官方 CLI 默认登录配置`,
            });
          }
          const seenModels = new Set();
          for (const grp of nativeGroups) {
            const provArg = String(grp.providerArg || '').trim();
            for (const m of (grp.models || [])) {
              const mid = String(m || '').trim();
              if (!mid) continue;
              const dedupKey = `${provArg}:${mid}`;
              if (seenModels.has(dedupKey)) continue;
              if (!engineMatch && !mid.toLowerCase().includes(queryLower) && !String(grp.title || grp.groupTitle || '').toLowerCase().includes(queryLower)) {
                continue;
              }
              seenModels.add(dedupKey);
              matchedEntries.push({
                isDefault: false,
                providerArg: provArg,
                modelId: mid,
                displayName: prettifyModelShort(mid),
                tooltip: `${cliItem.label} / ${provArg ? `${provArg} / ` : ''}${mid}`,
              });
            }
          }
          if (!matchedEntries.length) continue;
          renderedCount += matchedEntries.length;

          const hdr = document.createElement('div');
          hdr.className = 'hcp-provider-header';
          hdr.textContent = `${cliItem.label.toUpperCase()} · 原生订阅`;
          rightList.append(hdr);

          for (const entry of matchedEntries) {
            const isCur = wl.mode === 'cli' && wl.engineId === cliItem.id &&
              (entry.isDefault ? !wl.model : (wl.model === entry.modelId && (!entry.providerArg || wl.providerId === entry.providerArg)));
            const selectLeadCli = nextEffort => {
              const payload = {
                workLead: {
                  mode: 'cli',
                  engineId: cliItem.id,
                  providerId: entry.providerArg,
                  model: entry.modelId,
                  reasoningEffort: nextEffort ?? (isCur ? wl.reasoningEffort : ''),
                },
              };
              if (engineItem.id === 'builtin' && activeEng !== 'builtin') {
                payload.cliEngine = 'builtin';
              }
              leadPaneSource = 'cli';
              emitChange(payload);
            };
            rightList.append(renderModelItemRow({
              modelId:entry.modelId, engine:cliItem.id, scope:JSON.stringify(['cli', cliItem.id, entry.providerArg]),
              favKey: entry.isDefault ? '' : `lead-cli:${cliItem.id}:${entry.providerArg}:${entry.modelId}`,
              displayName: entry.displayName,
              tooltip: entry.tooltip,
              isSelected: isCur,
              effortValue: isCur ? wl.reasoningEffort : '',
              onSelect: effort => {
                selectLeadCli(effort);
                closePopover();
              },
            }));
          }
        }

        if (!renderedCount) {
          const empty = document.createElement('div');
          empty.className = 'hcp-empty-card';
          empty.textContent = installedClis.length
            ? '没有匹配的本机 Code CLI 模型'
            : '本机尚未探测到已安装的官方 Code CLI，可先安装 Claude Code / Codex / Kimi Code / Hermes 等，或切回「维度 API」。';
          rightList.append(empty);
        } else if (missingClis.length && !queryLower) {
          const note = document.createElement('div');
          note.className = 'hcp-empty-card';
          note.style.marginTop = '8px';
          note.style.padding = '8px 10px';
          note.textContent = `未安装引擎：${missingClis.map(x => x.label).join('、')}（安装后点击下方「刷新列表」即可选用）`;
          rightList.append(note);
        }
        return;
      }

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
          const isCur = wl.mode === 'api' && leadSel.providerId === provId && leadSel.model === modelId;
          rightList.append(renderModelItemRow({
            modelId, scope:JSON.stringify(['api', provId]),
            favKey: `model:${provId}:${modelId}`,
            displayName: prettifyModelShort(modelId),
            tooltip: `${provId} / ${modelId}`,
            isSelected: isCur,
            effortValue: isCur ? leadSel.reasoningEffort : '',
            onSelect: (effort = '') => {
              const patch = {};
              if (wl.mode !== 'api') patch.workLead = { mode: 'api' };
              if (engineItem.id === 'builtin' && activeEng !== 'builtin') patch.cliEngine = 'builtin';
              if (Object.keys(patch).length) emitChange(patch);
              leadPaneSource = 'api';
              opts.onSelectLeadModel?.({ providerId: provId, model: modelId, reasoningEffort:effort });
              closePopover();
            },
          }));
        }
      }
      if (!count) {
        const empty = document.createElement('div');
        empty.className = 'hcp-empty-card';
        empty.textContent = '暂无可用 API 模型，可点击右上角「本机 Code CLI」直接选用已安装的官方 CLI，或点击下方「添加模型」。';
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
    const nativeOnly = effectiveDesc?.supportsCustomModel === false;
    const isNative = nativeOnly || cfg.modelSource === 'native';

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
      if (nativeOnly) return;
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

    if (nativeOnly) {
      srcSwitch.append(btnNativeSrc);
    } else {
      srcSwitch.append(btnApiSrc, btnNativeSrc);
    }
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
            modelId:mId, scope:JSON.stringify(['cli', effectiveDesc?.id || engineItem.id, provArg]), engine:effectiveDesc?.id || engineItem.id,
            displayName: prettifyModelShort(mId),
            tooltip: mId,
            isSelected: isCurrent,
            effortValue: isCurrent ? cfg.reasoningEffort : '',
            onSelect: (effort = cfg.reasoningEffort) => {
              emitChange({
                cliEngine: engineItem.id,
                cliModelSource: 'native',
                cliEngineConfig: {
                  engineId: engineItem.id,
                  modelSource: 'native',
                  providerId: provArg,
                  model: mId,
                  reasoningEffort: effort,
                },
              });
              closePopover();
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
            modelId:f.modelId, scope:JSON.stringify(['api', f.provId]), engine:effectiveDesc?.id || engineItem.id,
            displayName: prettifyModelShort(f.modelId),
            tooltip: `${f.provTitle} / ${f.modelId}`,
            isSelected: isCur,
            effortValue: isCur ? cfg.reasoningEffort : '',
            onSelect: (effort = cfg.reasoningEffort) => {
              emitChange({
                cliEngine: engineItem.id,
                cliModelSource: 'work',
                cliEngineConfig: {
                  engineId: engineItem.id,
                  modelSource: 'work',
                  providerId: f.provId,
                  model: f.modelId,
                  reasoningEffort: effort,
                },
              });
              closePopover();
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
          modelId, scope:JSON.stringify(['api', provId]), engine:effectiveDesc?.id || engineItem.id,
          displayName: prettifyModelShort(modelId),
          tooltip: `${provId} / ${modelId}`,
          isSelected: isCurrentModel,
          effortValue: isCurrentModel ? cfg.reasoningEffort : '',
          onSelect: (effort = cfg.reasoningEffort) => {
            emitChange({
              cliEngine: engineItem.id,
              cliModelSource: 'work',
              cliEngineConfig: {
                engineId: engineItem.id,
                modelSource: 'work',
                providerId: provId,
                model: modelId,
                reasoningEffort: effort,
              },
            });
            closePopover();
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

    // Top unified Role Lead Model slot (Commander: discusses requirements, dispatches CLI, reviews delivery)
    const leadSel = opts.getLeadSelection?.();
    if (opts.onSelectLeadModel) {
      const leadTitle = document.createElement('div');
      leadTitle.className = 'hcp-rail-title';
      leadTitle.textContent = '接待指挥（谈需求 / 验收）';
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
      mTxt.textContent = '接待与指挥';
      const sTxt = document.createElement('small');
      sTxt.className = 'hcp-eng-sub';
      sTxt.textContent = formatWorkLeadSummary(settings, harnesses) || '选择模型';
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
    railTitle.textContent = '实干 CLI（写代码 / 跑命令）';
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
          const itemDesc = harnesses.find(h => h.id === item.id);
          const defaultSrc = itemDesc?.supportsCustomModel === false ? 'native' : (cfg.modelSource || 'work');
          emitChange({
            cliEngine: item.id,
            ...(item.id !== 'builtin' ? { cliModelSource: defaultSrc } : {}),
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
      const desc = harnesses.find(h => h.id === it.id);
      const modeHint = desc?.executionMode === 'sandbox'
        ? '沙盒隔离'
        : (desc?.executionMode === 'host' ? '宿主机' : '');
      appendEngineBtn(it, { isReady: true, subHint: modeHint });
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
    arrangeModels(rightList, {search:Boolean(queryLower)});
  };

  triggerBtn.addEventListener('click', ev => {
    ev.stopPropagation();
    togglePopover();
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
