import { arrangeModels, effortLevels, modelChoice } from './model-catalog-view.js';
/**
 * DimensionAgent · 接待模型「本机 CLI」设置弹窗与通用判断工具 (ESM)
 * - 零 Emoji / 极简单色线性 SVG / 严格 CSP 合规
 * - 统一服务于 Chat 主底栏模型菜单、像素剧院/沉浸舞台模型浮窗、Work 接待模型与游乐场接待模型
 */

import { cliEngineDisplayName, cliOptions } from './cli-engine-catalog.js';
export { cliEngineDisplayName };

const CLI_ENGINE_META = cliOptions([
  'antigravity', 'hermes', 'kimi-code', 'deepseek-harness', 'claude-code', 'codex', 'opencode', 'qwen-code', 'gemini-cli',
]);

export function isCliSelection(sel) {
  if (!sel || typeof sel !== 'object') return false;
  if (sel.mode === 'cli') return true;
  if (typeof sel.providerId === 'string' && sel.providerId.startsWith('cli:')) return true;
  if (sel.engineId && sel.engineId !== 'auto' && sel.engineId !== 'builtin') return true;
  return false;
}

export function extractCliEngineId(sel) {
  if (!sel || typeof sel !== 'object') return '';
  if (sel.engineId) return String(sel.engineId);
  if (typeof sel.providerId === 'string' && sel.providerId.startsWith('cli:')) {
    return sel.providerId.slice(4);
  }
  return '';
}

export function shortModelName(modelId) {
  const s = String(modelId || '').trim();
  if (!s) return '';
  const slash = s.lastIndexOf('/');
  return slash >= 0 ? s.slice(slash + 1) : s;
}

export function formatCliSelectionLabel(sel) {
  if (!isCliSelection(sel)) return '';
  const eng = extractCliEngineId(sel);
  const engName = cliEngineDisplayName(eng);
  const m = shortModelName(sel.model || '');
  return m ? `CLI · ${engName} / ${m}` : `CLI · ${engName}（默认订阅）`;
}

export function cliGearSvg(size = 13) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.5M8 12.7v1.5M1.8 8h1.5M12.7 8h1.5M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3 3.6 12.4"/></svg>`;
}

export function cliTerminalSvg(size = 15) {
  return `<svg class="model-menu-cli-icon" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.75" y="2.5" width="12.5" height="11" rx="2.2"/><path d="M4.6 6.2 6.8 8 4.6 9.8M8.2 9.8h3.2"/></svg>`;
}

function svgRefresh() {
  return `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.2 8a5.2 5.2 0 1 1-1.35-3.5"/><path d="M13.4 2.8v2.6h-2.6"/></svg>`;
}

function svgCheck() {
  return `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.2 8.3 6.4 11.4 12.8 4.6"/></svg>`;
}

let cachedHarnesses = [];
let dialogEl = null;

export function getCachedCliHarnesses() {
  return cachedHarnesses;
}

export async function fetchCliHarnesses(api, { refresh = false } = {}) {
  const data = await api(`/api/dimension/cli-sandbox/status${refresh ? '?refresh=1' : ''}`);
  const list = Array.isArray(data?.harnesses) ? data.harnesses : [];
  if (list.length) cachedHarnesses = list;
  return list;
}

export function openCliReceptionModal({
  api,
  botId = '',
  botName = '',
  currentSelection = null,
  defaultSyncWorkLead = true,
  onSelectCli = null,
  onSwitchToApi = null,
  onOpenSandboxSettings = null,
} = {}) {
  if (dialogEl && dialogEl.isConnected) {
    dialogEl.close();
    dialogEl.remove();
  }

  const dialog = document.createElement('dialog');
  dialog.className = 'cli-rec-dialog';
  dialog.id = 'cliReceptionDialog';
  dialog.setAttribute('aria-label', '接待模型本机 CLI 设置');

  dialog.innerHTML = `
    <div class="cli-rec-head">
      <div class="cli-rec-head-left">
        <h2 class="cli-rec-title">接待模型 · 本机 CLI 设置</h2>
        <span class="cli-rec-bot-chip" data-role="bot-chip"></span>
      </div>
      <div class="cli-rec-head-actions">
        <button type="button" class="cli-rec-btn" data-role="refresh">${svgRefresh()}<span>刷新可用模型</span></button>
        <button type="button" class="cli-rec-btn" data-role="close">关闭</button>
      </div>
    </div>
    <div class="cli-rec-toolbar">
      <div class="cli-rec-cur-pill" data-role="current-pill"></div>
      <input type="search" class="cli-rec-search" data-role="search" placeholder="搜索可用模型或 CLI 引擎（如 neon / xhigh / claude / kimi）…" autocomplete="off" spellcheck="false">
    </div>
    <div class="cli-rec-body thin-scroll" data-role="body"></div>
    <div class="cli-rec-foot">
      <label class="cli-rec-sync-label">
        <input type="checkbox" data-role="sync-work" ${defaultSyncWorkLead ? 'checked' : ''}>
        <span>同步设为该角色在 Work 工坊的接待模型</span>
      </label>
      <p class="cli-rec-status" data-role="status" role="status"></p>
      <div class="cli-rec-head-actions">
        <button type="button" class="cli-rec-btn" data-role="use-api" hidden>切回维度 API</button>
      </div>
    </div>
  `;

  document.body.appendChild(dialog);
  dialogEl = dialog;

  const botChip = dialog.querySelector('[data-role="bot-chip"]');
  const curPill = dialog.querySelector('[data-role="current-pill"]');
  const searchInp = dialog.querySelector('[data-role="search"]');
  const bodyEl = dialog.querySelector('[data-role="body"]');
  const statusEl = dialog.querySelector('[data-role="status"]');
  const refreshBtn = dialog.querySelector('[data-role="refresh"]');
  const closeBtn = dialog.querySelector('[data-role="close"]');
  const syncWorkChk = dialog.querySelector('[data-role="sync-work"]');
  const useApiBtn = dialog.querySelector('[data-role="use-api"]');

  botChip.textContent = botName ? `当前角色：${botName}` : (botId ? `当前角色：${botId}` : '全局默认角色');
  if (!botId) {
    syncWorkChk.closest('label').hidden = true;
  }

  let harnesses = [...cachedHarnesses];
  let activeSel = currentSelection ? { ...currentSelection } : null;
  let busy = false;
  let ticket = 0;

  const updateCurrentPill = () => {
    curPill.replaceChildren();
    const dot = document.createElement('span');
    dot.className = 'cli-rec-dot';
    const txt = document.createElement('span');
    if (isCliSelection(activeSel)) {
      txt.innerHTML = `当前接待：<strong></strong>`;
      txt.querySelector('strong').textContent = formatCliSelectionLabel(activeSel);
      useApiBtn.hidden = typeof onSwitchToApi !== 'function';
    } else {
      const apiModel = activeSel?.model ? `${activeSel.providerId ? `${activeSel.providerId} / ` : ''}${activeSel.model}` : '未指定';
      txt.innerHTML = `当前接待：<strong></strong>`;
      txt.querySelector('strong').textContent = `维度 API（${apiModel}）`;
      useApiBtn.hidden = true;
    }
    curPill.append(dot, txt);
  };

  const pickCliModel = async ({ engineId, cliProvider = '', model = '', reasoningEffort = '' }) => {
    if (busy) return;
    busy = true;
    statusEl.textContent = '正在应用本机 CLI 接待模型…';
    const nextSel = {
      mode: 'cli',
      providerId: `cli:${engineId}`,
      engineId,
      cliProvider: String(cliProvider || ''),
      model: String(model || ''),
      reasoningEffort,
    };
    try {
      if (typeof onSelectCli === 'function') {
        await onSelectCli(nextSel, { syncWorkLead: Boolean(syncWorkChk.checked) });
      }
      activeSel = nextSel;
      updateCurrentPill();
      statusEl.textContent = `已切换接待模型为：${formatCliSelectionLabel(nextSel)}`;
      dialog.close();
    } catch (err) {
      statusEl.textContent = err?.message || '切换本机 CLI 接待模型失败';
    } finally {
      busy = false;
    }
  };

  const renderList = () => {
    bodyEl.replaceChildren();
    const q = searchInp.value.trim().toLowerCase();
    const installed = [];
    const missing = [];

    for (const meta of CLI_ENGINE_META) {
      const desc = harnesses.find((h) => h.id === meta.id);
      if (desc?.installed) installed.push({ meta, desc });
      else missing.push({ meta, desc });
    }
    for (const h of harnesses) {
      if (h.installed && !installed.some((x) => x.meta.id === h.id)) {
        installed.push({ meta: { id: h.id, label: h.name || h.id }, desc: h });
      }
    }

    if (!installed.length) {
      const empty = document.createElement('div');
      empty.className = 'cli-rec-empty';
      empty.textContent = '当前未探测到已安装的本机 Code CLI。你可以先安装 Hermes / Kimi Code / Claude Code / Codex / Gemini CLI 等引擎，安装完成后点击右上角「刷新可用模型」。';
      bodyEl.appendChild(empty);
    } else {
      let totalRenderedModels = 0;
      const curEng = extractCliEngineId(activeSel);
      const curModel = String(activeSel?.model || '');
      const curProv = String(activeSel?.cliProvider || activeSel?.providerId || '');

      for (const { meta, desc } of installed) {
        const engineMatch = !q || meta.label.toLowerCase().includes(q) || meta.id.toLowerCase().includes(q);
        const defModel = String(desc?.nativeDefaultModel || '');
        const groups = Array.isArray(desc?.nativeModelGroups) ? desc.nativeModelGroups : [];

        const sections = [];
        // 1. 默认订阅模型项
        if (engineMatch || '默认订阅 default 原生'.includes(q) || defModel.toLowerCase().includes(q)) {
          sections.push({
            title: '默认配置',
            items: [{
              isDefault: true,
              cliProvider: '',
              model: '',
              label: defModel ? `默认订阅模型 (${shortModelName(defModel)})` : '默认原生订阅模型',
              tooltip: `${meta.label} · 沿用本机 CLI 默认登录模型`,
            }],
          });
        }

        // 2. 各提供方探测到的全部可用模型
        const seen = new Set();
        for (const grp of groups) {
          const provArg = String(grp.providerArg || '').trim();
          const grpTitle = String(grp.title || grp.groupTitle || provArg || '可用模型').trim();
          const matched = [];
          for (const rawM of (grp.models || [])) {
            const mid = String(rawM || '').trim();
            if (!mid) continue;
            const dk = `${provArg}:${mid}`;
            if (seen.has(dk)) continue;
            if (!engineMatch && !mid.toLowerCase().includes(q) && !grpTitle.toLowerCase().includes(q)) {
              continue;
            }
            seen.add(dk);
            matched.push({
              isDefault: false,
              cliProvider: provArg,
              model: mid,
              label: shortModelName(mid),
              tooltip: `${meta.label}${provArg ? ` / ${provArg}` : ''} / ${mid}`,
            });
          }
          if (matched.length) {
            sections.push({ title: grpTitle, items: matched });
          }
        }

        if (!sections.length) continue;

        const card = document.createElement('section');
        card.className = 'cli-rec-engine-card';

        const head = document.createElement('div');
        head.className = 'cli-rec-engine-head';
        const nw = document.createElement('div');
        nw.className = 'cli-rec-engine-name-wrap';
        const d = document.createElement('span');
        d.className = 'cli-rec-dot';
        const nm = document.createElement('span');
        nm.className = 'cli-rec-engine-name';
        nm.textContent = meta.label;
        nw.append(d, nm);
        const st = document.createElement('span');
        st.className = 'cli-rec-engine-status';
        st.textContent = desc?.nativeStatusLabel || '已就绪';
        head.append(nw, st);
        card.appendChild(head);

        for (const sec of sections) {
          const gt = document.createElement('div');
          gt.className = 'cli-rec-group-title';
          gt.textContent = `${sec.title}（${sec.items.length}）`;
          card.appendChild(gt);

          const grid = document.createElement('div');
          grid.className = 'cli-rec-model-grid';

          for (const item of sec.items) {
            totalRenderedModels += 1;
            const isSelected = isCliSelection(activeSel)
              && curEng === meta.id
              && (item.isDefault
                ? !curModel
                : (curModel === item.model && (!item.cliProvider || curProv === item.cliProvider || curProv === `cli:${meta.id}`)));

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `cli-rec-model-btn${isSelected ? ' is-selected' : ''}`;
            btn.title = item.tooltip;

            const lbl = document.createElement('span');
            lbl.className = 'cli-rec-model-label';
            lbl.textContent = item.label;
            btn.appendChild(lbl);

            if (isSelected) {
              const chk = document.createElement('span');
              chk.innerHTML = svgCheck();
              btn.appendChild(chk.firstElementChild);
            } else if (item.isDefault) {
              const bdg = document.createElement('span');
              bdg.className = 'cli-rec-model-badge';
              bdg.textContent = '默认';
              btn.appendChild(bdg);
            }

            const apply = (effort = '') => pickCliModel({engineId:meta.id, cliProvider:item.cliProvider,
              model:item.model, reasoningEffort:effort});
            btn.onclick = () => void apply();
            if (!item.isDefault) modelChoice(btn, {scope:JSON.stringify(['cli',meta.id,item.cliProvider]), id:item.model, engine:meta.id,
              selected:isSelected, effort:isSelected ? activeSel.reasoningEffort : '', levels:effortLevels(meta.id), apply});
            grid.appendChild(btn);
          }
          card.appendChild(grid);
        }
        bodyEl.appendChild(card);
      }

      if (!totalRenderedModels) {
        const empty = document.createElement('div');
        empty.className = 'cli-rec-empty';
        empty.textContent = `没有匹配「${searchInp.value.trim()}」的可用 CLI 模型，你可以清空搜索或在下方手动输入模型 ID。`;
        bodyEl.appendChild(empty);
      }

      // 3. 手动指定 CLI 模型 ID（支持目录外模型）
      const manual = document.createElement('details');
      manual.className = 'cli-rec-manual';
      const sum = document.createElement('summary');
      sum.textContent = '手动指定本机 CLI 模型 ID（目录未列出时使用）';
      const row = document.createElement('div');
      row.className = 'cli-rec-manual-row';

      const engSel = document.createElement('select');
      engSel.setAttribute('aria-label', '选择本机 CLI 引擎');
      for (const { meta } of installed) {
        engSel.add(new Option(meta.label, meta.id));
      }
      if (isCliSelection(activeSel) && installed.some((x) => x.meta.id === curEng)) {
        engSel.value = curEng;
      }

      const modelInp = document.createElement('input');
      modelInp.type = 'text';
      modelInp.placeholder = '输入模型 ID（如 xai/grok-4 或 claude-sonnet-4-6）';
      modelInp.setAttribute('aria-label', '手动输入模型 ID');

      const provInp = document.createElement('input');
      provInp.type = 'text';
      provInp.placeholder = '原生提供方（Hermes 可选，如 openai-api）';
      provInp.setAttribute('aria-label', '原生提供方');

      const applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = 'cli-rec-btn is-primary';
      applyBtn.textContent = '立即使用';
      applyBtn.addEventListener('click', () => {
        const m = modelInp.value.trim();
        const p = provInp.value.trim();
        const valid = (v) => /^[A-Za-z0-9._/@:+][A-Za-z0-9._/@:+-]{0,255}$/.test(v);
        if (!m || !valid(m) || (p && !valid(p))) {
          statusEl.textContent = '请输入合法的模型 ID（仅支持字母、数字与 . _ / @ : + -）。';
          return;
        }
        void pickCliModel({ engineId: engSel.value, cliProvider: p, model: m });
      });

      row.append(engSel, modelInp, provInp, applyBtn);
      manual.append(sum, row);
      arrangeModels(bodyEl, {search:Boolean(q)});
      bodyEl.appendChild(manual);
    }

    if (missing.length && !q) {
      const miss = document.createElement('div');
      miss.className = 'cli-rec-missing-note';
      const txt = document.createElement('span');
      txt.textContent = `未安装引擎：${missing.map((x) => x.meta.label).join('、')}`;
      miss.appendChild(txt);
      if (typeof onOpenSandboxSettings === 'function') {
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'cli-rec-btn';
        go.textContent = '前往安装管理';
        go.addEventListener('click', () => {
          dialog.close();
          onOpenSandboxSettings();
        });
        miss.appendChild(go);
      }
      bodyEl.appendChild(miss);
    }
  };

  const loadHarnesses = async (refresh = false) => {
    const t = ++ticket;
    refreshBtn.disabled = true;
    statusEl.textContent = refresh ? '正在重新探测本机 CLI 与可用模型…' : '正在读取本机 CLI 可用模型…';
    try {
      harnesses = await fetchCliHarnesses(api, { refresh });
      if (t !== ticket || !dialog.open) return;
      renderList();
      const readyCount = harnesses.filter((h) => h.installed).length;
      const modelTotal = harnesses
        .filter((h) => h.installed)
        .reduce((acc, h) => acc + (h.nativeModelGroups || []).reduce((s, g) => s + (g.models?.length || 0), 0), 0);
      statusEl.textContent = readyCount
        ? `已检测到 ${readyCount} 个可用本机 CLI，共发现 ${modelTotal} 个目录模型（点击任意模型即可生效）。`
        : '尚未检测到已安装的本机 CLI。';
    } catch (err) {
      if (t === ticket) statusEl.textContent = err?.message || '读取本机 CLI 模型列表失败';
    } finally {
      if (t === ticket) refreshBtn.disabled = false;
    }
  };

  updateCurrentPill();
  if (harnesses.length) renderList();

  searchInp.addEventListener('input', renderList);
  refreshBtn.addEventListener('click', () => void loadHarnesses(true));
  closeBtn.addEventListener('click', () => dialog.close());
  useApiBtn.addEventListener('click', async () => {
    if (busy || typeof onSwitchToApi !== 'function') return;
    busy = true;
    statusEl.textContent = '正在切回维度 API…';
    try {
      if (await onSwitchToApi({ syncWorkLead: Boolean(syncWorkChk.checked) }) === false) {
        statusEl.textContent = '切换未完成，请检查 API 配置后重试。';
        return;
      }
      dialog.close();
    } catch (err) {
      statusEl.textContent = err?.message || '切回维度 API 失败';
    } finally {
      busy = false;
    }
  });
  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    ticket += 1;
    dialog.remove();
    if (dialogEl === dialog) dialogEl = null;
  });

  dialog.showModal();
  void loadHarnesses(false);
  return dialog;
}
