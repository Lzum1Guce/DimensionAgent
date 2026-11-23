// Right-side Work Studio Panel:
// 1. Overview Card (1:1 Clean Floating Rounded Card with 3 collapsible sections: 进度 / 产物 / 上传文件)
// 2. Live Canvas (HTML / SVG hot-reload + Desktop/Mobile viewport toggle + Dev Server localhost preview + Time-Machine v1/v2 rollback)
// 3. File Diff Restore & Sandbox Sync + Group Member Thought Inspector
import { createChangeDiff } from './change-diff-ui.js';
import { copyMessageText, messageActionNotice } from './message-context-ui.js';
import { renderRichMessage } from './markdown-lite.js';

const DOCK_WIDTH_KEY = 'dimension-work-dock-width';

const el = (tag, className = '', text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp', '.svg']);
const SVG_EXTS = new Set(['.svg']);
const HTML_EXTS = new Set(['.html', '.htm']);
const MD_EXTS = new Set(['.md', '.markdown']);
const CODE_EXTS = new Set([
  '.html', '.htm', '.svg', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.json', '.py', '.cpp', '.hpp', '.c', '.h', '.rs', '.go', '.java', '.ps1', '.sh',
  '.bat', '.cmd', '.patch', '.diff', '.yaml', '.yml', '.toml', '.sql', '.xml',
]);

const TRI_ICONS = {
  chev: '<svg class="work-tri-chev" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 6.25 3.5 3.5 3.5-3.5"/></svg>',
  code: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="m5.2 5.2-3 2.8 3 2.8M10.8 5.2l3 2.8-3 2.8M9.1 3.5 6.9 12.5"/></svg>',
  doc: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M4.25 2.25h5.2L12.75 5.5v8.25a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1v-10.5a1 1 0 0 1 1-1Z"/><path d="M9.25 2.4v3.2h3.2M5.75 8.5h4.5M5.75 11h3"/></svg>',
  folder: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M2.25 4.5A1.5 1.5 0 0 1 3.75 3h2.6a1.5 1.5 0 0 1 1.15.54l.9 1.08h3.85a1.5 1.5 0 0 1 1.5 1.5v5.63a1 1 0 0 1-1.5 1.5h-8.5a1.5 1.5 0 0 1-1.5-1.5V4.5Z"/></svg>',
  image: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.6"/><circle cx="5.75" cy="6.25" r="1.05"/><path d="m2.75 11.5 3.1-3.1a.9.9 0 0 1 1.25 0l2.1 2.1 1.4-1.4a.9.9 0 0 1 1.25 0l1.65 1.65"/></svg>',
  globe: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.75"/><path d="M2.5 8h11M8 2.25c1.6 1.6 2.4 3.5 2.4 5.75S9.6 12.15 8 13.75c-1.6-1.6-2.4-3.5-2.4-5.75S6.4 3.85 8 2.25Z"/></svg>',
};

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function appendCacheBust(rawUrl, token) {
  if (!rawUrl) return '';
  const sep = rawUrl.includes('?') ? '&' : '?';
  return `${rawUrl}${sep}_t=${encodeURIComponent(String(token))}`;
}

function extractPortLabel(url) {
  try {
    const u = new URL(url);
    return u.port ? `:${u.port}` : u.host;
  } catch {
    return url;
  }
}

/** 不可逆操作的危险确认：优先使用应用内对话框，不存在时退回 window.confirm。 */
async function confirmDangerAction({ title, message, confirmLabel }) {
  if (window.__dimensionConfirm) {
    return Boolean(await window.__dimensionConfirm({ title, message, confirmLabel, danger: true }));
  }
  return window.confirm(`${title}\n\n${message}`);
}

function cleanStemLabel(filename) {
  const s = String(filename || '').trim();
  if (!s) return '未命名产物';
  const dot = s.lastIndexOf('.');
  return dot > 0 ? s.slice(0, dot) : s;
}

function upperExtBadge(file) {
  const raw = String(file?.extension || '').replace(/^\./, '').trim();
  if (raw) return raw.toUpperCase();
  const m = String(file?.name || '').match(/\.([^.]+)$/);
  return m ? m[1].toUpperCase() : 'FILE';
}

function wrapSvgAsHtmlDoc(svgSource) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:transparent;overflow:auto;}
    svg{max-width:96vw;max-height:94vh;width:auto;height:auto;}
  </style></head><body>${svgSource}</body></html>`;
}

export function createWorkArtifactsDock({ api, onVisibilityChange, onLayoutChange, onCheckpointRestored, onManualRefresh, onPickProjectCwd } = {}) {
  const host = document.getElementById('workDock');
  if (!host) {
    return {
      isOpen: () => false, openArtifacts: () => {}, openOverview: () => {}, openInspector: () => {},
      updateArtifacts: () => {}, updateOverview: () => {}, updateInspector: () => {},
      registerDevServerUrl: () => {}, openDevServerUrl: () => {},
      close: () => {}, clear: () => {},
    };
  }

  let activeTab = 'overview'; // 'overview' | 'artifacts' | 'inspector'
  let viewMode = 'preview'; // 'preview' | 'source' | 'changes' | 'sandbox' | 'devserver'
  let viewportMode = 'desktop'; // 'desktop' | 'mobile'
  let currentRunId = '';
  let files = [];
  let fileChanges = [];
  let sandboxCheckouts = [];
  let checkpoints = [];
  let progressSteps = [];
  let uploadedItems = [];
  let expandEarlierSteps = false;
  let activeCheckpointId = '';
  let devServerUrl = '';
  let selectedFileUrl = '';
  let showByproducts = false;
  let inspectorData = null;
  let previewSessionId = '';
  let webviewListener = null;
  let refreshWarning = '';
  let sourceCache = new Map();
  let checkpointFileCache = new Map();
  let manualRefreshTick = 0;
  let lastRenderedSignature = '';

  // Read saved width (compact 380px default for Overview card, auto-expands nicely for Canvas)
  let dockWidth = 440;
  try {
    const saved = Number(localStorage.getItem(DOCK_WIDTH_KEY));
    if (Number.isFinite(saved) && saved >= 320 && saved <= 960) dockWidth = saved;
  } catch {}

  host.innerHTML = '';
  const resizer = el('div', 'work-dock-resizer');
  resizer.setAttribute('aria-hidden', 'true');
  const chromeSpacer = el('div', 'work-dock-keyrow');
  chromeSpacer.setAttribute('aria-hidden', 'true');

  const header = el('header', 'work-dock-head');
  const tabBar = el('div', 'work-dock-tabs');
  const ovTabBtn = el('button', 'work-dock-tab is-active', '任务概览');
  ovTabBtn.type = 'button';
  const artTabBtn = el('button', 'work-dock-tab', '实时画布');
  artTabBtn.type = 'button';
  const inspTabBtn = el('button', 'work-dock-tab', '成员思路');
  inspTabBtn.type = 'button';
  inspTabBtn.hidden = true;
  tabBar.append(ovTabBtn, artTabBtn, inspTabBtn);

  const closeBtn = el('button', 'work-dock-close', '收起');
  closeBtn.type = 'button';
  closeBtn.title = '收起右侧面板 (Esc)';
  closeBtn.setAttribute('aria-label', '收起右侧面板');
  header.append(tabBar, closeBtn);

  // 1. Overview Pane: Clean Floating Rounded Card (进度 / 产物 / 上传文件)
  const ovPane = el('div', 'work-dock-pane is-overview thin-scroll');

  // 2. Live Canvas & Artifacts Pane
  const artPane = el('div', 'work-dock-pane is-artifacts');
  artPane.hidden = true;
  const selectorBar = el('div', 'work-dock-selector');
  const checkpointStrip = el('div', 'work-dock-checkpoints');
  checkpointStrip.hidden = true;
  const actionStrip = el('div', 'work-dock-actions');
  const stage = el('div', 'work-dock-stage thin-scroll');
  artPane.append(selectorBar, checkpointStrip, actionStrip, stage);

  // 3. Inspector Pane (Read-only member live thought & tool stream)
  const inspPane = el('div', 'work-dock-pane is-inspector');
  inspPane.hidden = true;
  const inspHero = el('div', 'work-inspector-hero');
  const inspNote = el('div', 'work-inspector-note', '只读成员思路视图 · 如需调整方向，请在左侧主窗口直接说明');
  const inspBody = el('div', 'work-inspector-host thin-scroll');
  inspPane.append(inspHero, inspNote, inspBody);

  host.append(resizer, chromeSpacer, header, ovPane, artPane, inspPane);

  const notifyVisibility = open => {
    onVisibilityChange?.(open);
    onLayoutChange?.(open);
  };

  const cleanupPreviewHost = () => {
    if (webviewListener) {
      window.chrome?.webview?.removeEventListener('message', webviewListener);
      webviewListener = null;
    }
    if (previewSessionId) {
      try { window.chrome?.webview?.postMessage({ source: 'dimension-preview', action: 'close', id: previewSessionId, url: '' }); } catch {}
      previewSessionId = '';
    }
  };

  const syncWidthVar = () => {
    const workspace = document.getElementById('workspace');
    if (!workspace) return;
    const open = !host.hidden;
    const overlay = window.innerWidth <= 980;
    workspace.classList.toggle('has-work-dock', open && !overlay);
    workspace.classList.toggle('work-dock-overlay', open && overlay);
    workspace.style.setProperty('--work-dock-width', open && !overlay ? `${Math.round(dockWidth)}px` : '0px');
    notifyVisibility(open);
  };

  // Drag resizer
  resizer.addEventListener('pointerdown', event => {
    if (event.button !== 0 || window.innerWidth <= 980) return;
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = dockWidth;
    const onMove = moveEvent => {
      const maxW = Math.min(880, Math.round(window.innerWidth * 0.6));
      dockWidth = Math.max(320, Math.min(maxW, startWidth + (startX - moveEvent.clientX)));
      syncWidthVar();
    };
    const onUp = () => {
      resizer.removeEventListener('pointermove', onMove);
      resizer.removeEventListener('pointerup', onUp);
      resizer.removeEventListener('pointercancel', onUp);
      try { localStorage.setItem(DOCK_WIDTH_KEY, String(Math.round(dockWidth))); } catch {}
    };
    resizer.addEventListener('pointermove', onMove);
    resizer.addEventListener('pointerup', onUp);
    resizer.addEventListener('pointercancel', onUp);
  });

  window.addEventListener('resize', () => {
    if (!host.hidden) syncWidthVar();
  });

  const setTab = tab => {
    if (tab === 'inspector' && inspectorData) activeTab = 'inspector';
    else if (tab === 'artifacts') activeTab = 'artifacts';
    else activeTab = 'overview';

    if (activeTab !== 'artifacts') cleanupPreviewHost();

    ovTabBtn.classList.toggle('is-active', activeTab === 'overview');
    artTabBtn.classList.toggle('is-active', activeTab === 'artifacts');
    inspTabBtn.classList.toggle('is-active', activeTab === 'inspector');
    ovPane.hidden = activeTab !== 'overview';
    artPane.hidden = activeTab !== 'artifacts';
    inspPane.hidden = activeTab !== 'inspector';

    if (activeTab === 'overview') renderOverviewPane();
    else if (activeTab === 'artifacts') renderArtifactsPane();
    else renderInspectorPane();
  };

  ovTabBtn.onclick = () => setTab('overview');
  artTabBtn.onclick = () => setTab('artifacts');
  inspTabBtn.onclick = () => setTab('inspector');

  // Auto-reveal bookkeeping (P1): once the user dismisses the dock during a
  // run, that run never pops it open again; and each auto-reveal reason fires
  // only on its first rising edge within a run.
  let userDismissedRunId = '';
  let autoRevealRunId = '';
  const autoRevealFired = new Set();
  const resetAutoRevealFor = runId => {
    if (runId === autoRevealRunId) return;
    autoRevealRunId = runId;
    autoRevealFired.clear();
    if (userDismissedRunId && userDismissedRunId !== runId) userDismissedRunId = '';
  };
  // Returns true when an auto-reveal for `reason` may happen now (and consumes it).
  const claimAutoReveal = reason => {
    if (userDismissedRunId && userDismissedRunId === (currentRunId || autoRevealRunId)) return false;
    if (autoRevealFired.has(reason)) return false;
    autoRevealFired.add(reason);
    return true;
  };

  const close = ({ byUser = true } = {}) => {
    if (host.hidden) return;
    if (byUser) userDismissedRunId = currentRunId || autoRevealRunId || '__none__';
    cleanupPreviewHost();
    host.hidden = true;
    syncWidthVar();
  };
  closeBtn.onclick = () => close();

  const hasOpenPopover = () => !!document.querySelector(
    '.hcp-popover:not([hidden]), .work-cli-popover:not([hidden]), [data-cli-picker-open="true"]'
  );
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (hasOpenPopover()) return;
    if (!host.hidden && !document.querySelector('dialog[open]') && document.getElementById('modal')?.hidden !== false) {
      close();
    }
  });

  const selectedFile = () => files.find(f => f.url === selectedFileUrl) || files[0] || null;
  const cacheKeyOfFile = file => `${file.url}@${Math.round(file.mtimeMs || 0)}:${file.bytes || 0}:${manualRefreshTick}`;

  async function readFullText(file) {
    const fetchUrl = appendCacheBust(file.url, `${Math.round(file.mtimeMs || 0)}_${manualRefreshTick}`);
    const res = await fetch(fetchUrl, { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) throw new Error(`读取文件失败 (HTTP ${res.status})`);
    return res.text();
  }

  async function loadTextSource(file) {
    if (!file?.url) return '';
    const key = cacheKeyOfFile(file);
    const cached = sourceCache.get(file.url);
    if (cached?.key === key) return cached.text;
    const text = await readFullText(file);
    const clipped = text.length > 250000 ? text.slice(0, 250000) + '\n\n…（文件超过 250 KB，预览已截断，可下载查看完整文件）' : text;
    if (files.includes(file) && cacheKeyOfFile(file) === key) sourceCache.set(file.url, { key, text: clipped });
    return clipped;
  }

  async function loadCheckpointSource(cp, file) {
    if (!currentRunId || !cp?.id || !api) return '';
    const runId = currentRunId;
    const path = file?.relativePath || file?.name;
    const candidates = path ? [`deliverables/${path}`, path] : (cp.primaryHtmlRel ? [cp.primaryHtmlRel] : []);
    for (const rel of candidates) {
      const cKey = `${runId}:${cp.id}:${rel}`;
      if (checkpointFileCache.has(cKey)) return checkpointFileCache.get(cKey);
      try {
        const data = await api(
          `/api/dimension/work/runs/${encodeURIComponent(runId)}/checkpoint-file?checkpointId=${encodeURIComponent(cp.id)}&path=${encodeURIComponent(rel)}`
        );
        if (typeof data?.content === 'string') {
          const item = { path: data.path || rel, content: data.content };
          checkpointFileCache.set(cKey, item);
          return item;
        }
        throw new Error('历史文件响应缺少内容');
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    throw new Error(`历史版本 v${cp.versionNumber} 中尚未生成该文件`);
  }

  // =========================================================================
  // Overview Pane: 1:1 Floating Rounded Card (进度 / 产物 / 上传文件)
  // =========================================================================
  function makeTriSection(titleText, defaultOpen = true) {
    const det = el('details', 'work-tri-sec');
    det.open = defaultOpen;
    const sum = el('summary', 'work-tri-head');
    const title = el('span', 'work-tri-title', titleText);
    const chev = el('span', 'work-tri-chev-wrap');
    chev.innerHTML = TRI_ICONS.chev;
    sum.append(title, chev);
    const body = el('div', 'work-tri-body');
    det.append(sum, body);
    return { det, body };
  }

  function renderOverviewPane() {
    ovPane.replaceChildren();
    const card = el('div', 'work-tri-card');

    // Section 1: 进度 (Progress Timeline)
    const { det: progSec, body: progBody } = makeTriSection('进度', true);
    if (!progressSteps.length) {
      progBody.append(el('div', 'work-tri-muted', '等待任务步骤展开…'));
    } else {
      const timeline = el('div', 'work-tri-timeline');
      const activeIdx = progressSteps.findIndex(s => s.status === 'running');
      const pivotIdx = activeIdx >= 0 ? activeIdx : progressSteps.length - 1;
      const hiddenCount = !expandEarlierSteps && pivotIdx >= 2 ? pivotIdx - 1 : 0;

      if (hiddenCount > 0) {
        const earlierBtn = el('button', 'work-tri-earlier');
        earlierBtn.type = 'button';
        earlierBtn.append(
          el('span', 'work-tri-node-sm'),
          el('span', 'work-tri-earlier-label', `${hiddenCount} 个更早的步骤`)
        );
        earlierBtn.onclick = () => {
          expandEarlierSteps = true;
          renderOverviewPane();
        };
        timeline.append(earlierBtn);
      } else if (expandEarlierSteps && pivotIdx >= 2) {
        const foldBtn = el('button', 'work-tri-earlier');
        foldBtn.type = 'button';
        foldBtn.append(
          el('span', 'work-tri-node-sm'),
          el('span', 'work-tri-earlier-label', '收起更早的步骤')
        );
        foldBtn.onclick = () => {
          expandEarlierSteps = false;
          renderOverviewPane();
        };
        timeline.append(foldBtn);
      }

      const visibleSteps = hiddenCount > 0 ? progressSteps.slice(hiddenCount) : progressSteps;
      visibleSteps.forEach((step, idx) => {
        const isCurrent = step.status === 'running' || (activeIdx < 0 && idx === visibleSteps.length - 1 && step.status === 'completed');
        const row = el('div', `work-tri-step status-${step.status || 'completed'}${isCurrent ? ' is-focus' : ''}`);
        const rail = el('span', 'work-tri-rail');
        if (isCurrent) {
          rail.append(el('span', `work-tri-ring${step.status === 'running' ? ' is-pulsing' : ''}`));
        } else {
          rail.append(el('span', 'work-tri-line-seg'));
        }
        const states = {running:'执行中', completed:'已完成', failed:'失败', interrupted:'已中断',
          cancelled:'已取消', blocked:'受阻', pending:'待执行', partial:'部分完成', unconfirmed:'未确认完成'};
        const txt = el('span', 'work-tri-step-text', `${step.label || ''} · ${states[step.status] || step.status}`);
        row.append(rail, txt);
        timeline.append(row);
      });
      progBody.append(timeline);
    }
    card.append(progSec);

    // Divider 1
    card.append(el('div', 'work-tri-divider'));

    // Section 2: 产物 (Deliverables & Live Canvas Entry)
    const { det: prodSec, body: prodBody } = makeTriSection('产物', true);
    const primaryFiles = (files || []).filter(f => f.category !== 'byproduct');
    const sbChanges = sandboxCheckouts.reduce((acc, s) => acc + ((s.diff?.changes || []).length), 0);

    if (!primaryFiles.length && !devServerUrl && !fileChanges.length && !sbChanges) {
      prodBody.append(el('div', 'work-tri-muted', '暂无产出文件'));
    } else {
      const list = el('div', 'work-tri-list');

      if (devServerUrl) {
        const devItem = el('button', 'work-tri-item is-live-dev');
        devItem.type = 'button';
        const ico = el('span', 'work-tri-ico');
        ico.innerHTML = TRI_ICONS.globe;
        const name = el('span', 'work-tri-name', `本地开发服务 ${extractPortLabel(devServerUrl)}`);
        const ext = el('span', 'work-tri-ext is-accent', 'LIVE');
        devItem.append(ico, name, ext);
        devItem.onclick = () => {
          viewMode = 'devserver';
          setTab('artifacts');
        };
        list.append(devItem);
      }

      for (const f of primaryFiles) {
        const extLow = String(f.extension || '').toLowerCase();
        const item = el('button', 'work-tri-item');
        item.type = 'button';
        item.title = `${f.relativePath || f.name}${f.bytes ? ` · ${formatBytes(f.bytes)}` : ''}（点击打开画布预览或源码）`;
        const ico = el('span', 'work-tri-ico');
        ico.innerHTML = CODE_EXTS.has(extLow) ? TRI_ICONS.code : (IMAGE_EXTS.has(extLow) ? TRI_ICONS.image : TRI_ICONS.doc);
        const name = el('span', 'work-tri-name', cleanStemLabel(f.name));
        const ext = el('span', 'work-tri-ext', upperExtBadge(f));
        item.append(ico, name, ext);
        item.onclick = () => {
          selectedFileUrl = f.url;
          activeCheckpointId = '';
          viewMode = 'preview';
          setTab('artifacts');
        };
        list.append(item);
      }

      if (fileChanges.length > 0) {
        const diffItem = el('button', 'work-tri-item');
        diffItem.type = 'button';
        const ico = el('span', 'work-tri-ico');
        ico.innerHTML = TRI_ICONS.code;
        const name = el('span', 'work-tri-name', `项目文件变更快照 (${fileChanges.length})`);
        const ext = el('span', 'work-tri-ext', 'DIFF');
        diffItem.append(ico, name, ext);
        diffItem.onclick = () => {
          viewMode = 'changes';
          setTab('artifacts');
        };
        list.append(diffItem);
      }

      if (sbChanges > 0) {
        const sbItem = el('button', 'work-tri-item');
        sbItem.type = 'button';
        const ico = el('span', 'work-tri-ico');
        ico.innerHTML = TRI_ICONS.code;
        const name = el('span', 'work-tri-name', `沙盒待回写改动 (${sbChanges})`);
        const ext = el('span', 'work-tri-ext', 'SYNC');
        sbItem.append(ico, name, ext);
        sbItem.onclick = () => {
          viewMode = 'sandbox';
          setTab('artifacts');
        };
        list.append(sbItem);
      }

      prodBody.append(list);

      if (checkpoints.length > 1) {
        const cpMini = el('div', 'work-tri-cp-bar');
        cpMini.append(el('span', 'work-tri-cp-label', '时光机'));
        for (const cp of checkpoints) {
          const b = el('button', 'work-cp-pill', `v${cp.versionNumber}`);
          b.type = 'button';
          b.title = `预览或回退至 v${cp.versionNumber} · ${cp.label || ''}`;
          b.onclick = () => {
            activeCheckpointId = cp.id;
            viewMode = 'preview';
            setTab('artifacts');
          };
          cpMini.append(b);
        }
        prodBody.append(cpMini);
      }
    }
    card.append(prodSec);

    // Divider 2
    card.append(el('div', 'work-tri-divider'));

    // Section 3: 上传文件 (Workspace Folder & Uploaded Reference Images/Attachments)
    const { det: upSec, body: upBody } = makeTriSection('上传文件', true);
    if (!uploadedItems.length) {
      const defItem = el('button', 'work-tri-item');
      defItem.type = 'button';
      const ico = el('span', 'work-tri-ico');
      ico.innerHTML = TRI_ICONS.folder;
      defItem.append(ico, el('span', 'work-tri-name', '隔离沙盒'));
      defItem.onclick = () => onPickProjectCwd?.();
      upBody.append(defItem);
    } else {
      const upList = el('div', 'work-tri-list');
      for (const u of uploadedItems) {
        const btn = el('button', 'work-tri-item');
        btn.type = 'button';
        const ico = el('span', 'work-tri-ico');
        ico.innerHTML = u.kind === 'folder' ? TRI_ICONS.folder : (u.kind === 'image' ? TRI_ICONS.image : TRI_ICONS.doc);
        const name = el('span', 'work-tri-name', u.name || '文件');
        btn.append(ico, name);
        if (u.ext) btn.append(el('span', 'work-tri-ext', u.ext));
        if (u.fullPath) btn.title = u.fullPath;
        btn.onclick = () => {
          if (u.kind === 'image' && u.imageUrl) {
            const lb = document.getElementById('chatImageLightbox');
            const lbImg = document.getElementById('chatImageLightboxImg');
            if (lb && lbImg) {
              lbImg.src = u.imageUrl;
              lb.hidden = false;
            } else {
              window.open(u.imageUrl, '_blank', 'noopener');
            }
          } else if (u.kind === 'folder') {
            if (u.fullPath && window.chrome?.webview?.postMessage) {
              window.__dimensionRevealPath?.(u.fullPath);
            } else {
              onPickProjectCwd?.();
            }
          }
        };
        upList.append(btn);
      }
      upBody.append(upList);
    }
    card.append(upSec);

    ovPane.append(card);
  }

  // =========================================================================
  // Live Canvas & Artifacts Pane
  // =========================================================================
  function safeHttpHref(rawUrl) {
    try {
      const u = new URL(String(rawUrl || ''), window.location.origin);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    } catch {}
    return '';
  }

  const OPAQUE_STORAGE_SHIM_TAG =
    '<script>(()=>{try{void window.localStorage.length}catch{' +
    'const mk=()=>{const m=new Map();return new Proxy({' +
    'get length(){return m.size},key:i=>[...m.keys()][i]??null,' +
    'getItem:k=>m.has(String(k))?m.get(String(k)):null,' +
    'setItem:(k,v)=>{m.set(String(k),String(v))},' +
    'removeItem:k=>{m.delete(String(k))},clear:()=>{m.clear()}' +
    '},{get:(t,p)=>p in t?t[p]:(m.has(String(p))?m.get(String(p)):undefined),' +
    'set:(t,p,v)=>{if(!(p in t))m.set(String(p),String(v));return true},' +
    'deleteProperty:(t,p)=>m.delete(String(p))})};' +
    'const ls=mk(),ss=mk();' +
    'Object.defineProperty(window,"localStorage",{get:()=>ls,configurable:true});' +
    'Object.defineProperty(window,"sessionStorage",{get:()=>ss,configurable:true});' +
    '}})();<\/script>';

  function injectOpaqueStorageShim(rawHtml) {
    const html = String(rawHtml || '');
    const headMatch = /<head\b[^>]*>/i.exec(html);
    if (headMatch) {
      const idx = headMatch.index + headMatch[0].length;
      return html.slice(0, idx) + OPAQUE_STORAGE_SHIM_TAG + html.slice(idx);
    }
    const docMatch = /<!doctype\b[^>]*>/i.exec(html);
    if (docMatch) {
      const idx = docMatch.index + docMatch[0].length;
      return html.slice(0, idx) + OPAQUE_STORAGE_SHIM_TAG + html.slice(idx);
    }
    return OPAQUE_STORAGE_SHIM_TAG + html;
  }

  function mountProtectedIframe(targetUrl, titleText, { allowCrossPortOrigin = false } = {}) {
    const frameWrap = el('div', `work-dock-canvas-shell${viewportMode === 'mobile' ? ' is-mobile' : ''}`);
    const frame = document.createElement('iframe');
    frame.className = 'work-dock-iframe';
    frame.title = titleText || '实时画布预览';
    let sandboxFlags = 'allow-scripts allow-forms';
    if (allowCrossPortOrigin) {
      try {
        const parsed = new URL(targetUrl, window.location.origin);
        if (parsed.origin !== window.location.origin && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
          sandboxFlags = 'allow-scripts allow-forms allow-same-origin';
        }
      } catch {}
    }
    frame.setAttribute('sandbox', sandboxFlags);
    if (window.chrome?.webview) {
      const pid = `work-dock-preview-${crypto.randomUUID()}`;
      previewSessionId = pid;
      webviewListener = event => {
        const val = event.data;
        if (val?.source === 'dimension-preview' && val.action === 'allowed' && val.id === pid) {
          frame.src = targetUrl;
        }
      };
      window.chrome.webview.addEventListener('message', webviewListener);
      try {
        window.chrome.webview.postMessage({ source: 'dimension-preview', action: 'open', id: pid, url: targetUrl });
      } catch {
        frame.src = targetUrl;
      }
    } else {
      frame.src = targetUrl;
    }
    frameWrap.append(frame);
    stage.append(frameWrap);
  }

  function renderDevServerStage() {
    cleanupPreviewHost();
    stage.replaceChildren();
    const safeDev = safeHttpHref(devServerUrl);
    if (!safeDev) {
      stage.append(el('div', 'work-dock-empty', '尚未检测到正在运行的本地开发服务端口。'));
      return;
    }
    const bustUrl = appendCacheBust(safeDev, manualRefreshTick);
    mountProtectedIframe(bustUrl, `本地开发服务 ${safeDev}`, { allowCrossPortOrigin: true });
  }

  function renderFileChangesStage() {
    cleanupPreviewHost();
    stage.replaceChildren();
    const wrap = el('div', 'work-dock-changes');
    const intro = el('p', 'work-dock-hint',
      fileChanges.length
        ? `共记录 ${fileChanges.length} 个项目文件的修改前后快照。点击恢复前会自动校验外部修改冲突。`
        : '当前对话尚未产生通过 write_file 记录的项目文件变更快照。'
    );
    wrap.append(intro);

    for (const item of fileChanges) {
      const card = el('article', 'work-dock-diff-card');
      const cardHead = el('div', 'work-dock-diff-head');
      const title = el('strong', 'work-dock-diff-path', item.relativePath);
      const tag = el('span', 'work-dock-diff-badge',
        `${item.existedBefore ? '修改文件' : '新建文件'}${item.restored ? ' · 已恢复' : ''}`
      );
      cardHead.append(title, tag);
      card.append(cardHead);

      const statusMsg = el('p', 'work-dock-diff-msg');
      statusMsg.hidden = true;

      if (!item.beforeOmitted) {
        card.append(createChangeDiff(item.existedBefore ? (item.beforeContent || '') : '', item.afterContent || ''));
        if (!item.restored && currentRunId && api) {
          const actions = el('div', 'work-dock-diff-actions');
          const restoreBtn = el('button', 'work-action', item.existedBefore ? '恢复为修改前版本' : '撤销新建（删除文件）');
          restoreBtn.type = 'button';

          const doRestore = async force => {
            restoreBtn.disabled = true;
            statusMsg.hidden = false;
            statusMsg.textContent = '正在恢复文件…';
            try {
              await api(`/api/dimension/work/runs/${encodeURIComponent(currentRunId)}/restore-file`, {
                method: 'POST',
                body: JSON.stringify({ relativePath: item.relativePath, force }),
              });
              item.restored = true;
              messageActionNotice(`已恢复：${item.relativePath}`);
              renderFileChangesStage();
            } catch (err) {
              if (err?.status === 409 && !force) {
                statusMsg.textContent = `${err.message || '目标文件在任务后已被外部修改'} `;
                const confirmForce = el('button', 'work-action is-danger', '确认强制覆盖恢复');
                confirmForce.type = 'button';
                confirmForce.onclick = () => void doRestore(true);
                const cancelForce = el('button', 'work-action', '取消');
                cancelForce.type = 'button';
                cancelForce.onclick = () => { statusMsg.hidden = true; restoreBtn.disabled = false; actions.replaceChildren(restoreBtn); };
                actions.replaceChildren(confirmForce, cancelForce);
                return;
              }
              statusMsg.textContent = err?.message || '恢复失败';
              restoreBtn.disabled = false;
            }
          };

          restoreBtn.onclick = async () => {
            const ok = await confirmDangerAction(item.existedBefore
              ? {
                title: '恢复为修改前版本',
                message: `将把「${item.relativePath}」还原为任务修改前的内容，任务对该文件做的所有改动都会被覆盖丢弃，且无法撤销。`,
                confirmLabel: '恢复',
              }
              : {
                title: '撤销新建（删除文件）',
                message: `将删除任务新建的文件「${item.relativePath}」，文件内容会一并丢失，且无法撤销。`,
                confirmLabel: '删除文件',
              });
            if (!ok) return;
            void doRestore(false);
          };
          actions.append(restoreBtn);
          card.append(actions);
        }
      } else {
        card.append(el('p', 'work-dock-hint', '原文件超过 256 KiB，已省略行级快照对比。'));
      }
      card.append(statusMsg);
      wrap.append(card);
    }
    stage.append(wrap);
  }

  function renderSandboxCheckoutStage() {
    cleanupPreviewHost();
    stage.replaceChildren();
    const wrap = el('div', 'work-dock-changes');
    if (!sandboxCheckouts.length) {
      wrap.append(el('p', 'work-dock-hint', '当前任务没有待同步的沙盒隔离检入改动。'));
      stage.append(wrap);
      return;
    }

    for (const slot of sandboxCheckouts) {
      const slotId = slot.taskId;
      const diff = slot.diff || {};
      const changes = Array.isArray(diff.changes) ? diff.changes : [];
      const sum = diff.summary || {};
      const state = diff.state || slot.checkout?.state || 'active';
      const box = el('section', 'work-dock-diff-card');
      const head = el('div', 'work-dock-diff-head');
      const ownerPrefix = slot.ownerName ? `[${slot.ownerName}] ` : '';
      head.append(
        el('strong', 'work-dock-diff-path', `${ownerPrefix}源工程：${diff.hostRoot || slot.checkout?.hostRoot || ''}`),
        el('span', 'work-dock-diff-badge', state === 'synced' ? '已同步回 Windows' : state === 'discarded' ? '已丢弃副本' : `新增 ${sum.added || 0} · 修改 ${sum.modified || 0} · 删除 ${sum.deleted || 0}`)
      );
      box.append(head);

      const statusMsg = el('p', 'work-dock-diff-msg');
      statusMsg.hidden = true;

      if (state === 'active' && changes.length && api) {
        const bar = el('div', 'work-dock-diff-actions');
        const syncBtn = el('button', 'work-action is-primary', `一键增量同步回 Windows (${changes.length} 项)`);
        syncBtn.type = 'button';
        const discardBtn = el('button', 'work-action', '丢弃沙盒副本');
        discardBtn.type = 'button';

        const doSync = async force => {
          syncBtn.disabled = true;
          discardBtn.disabled = true;
          statusMsg.hidden = false;
          statusMsg.textContent = '正在将变更增量写回 Windows 原目录（自动还原 CRLF 换行并备份原文件）…';
          try {
            const res = await api(`/api/dimension/work/runs/${encodeURIComponent(slotId)}/sync-to-host`, {
              method: 'POST',
              body: JSON.stringify({ force, cleanupSlot: true }),
            });
            diff.state = 'synced';
            if (slot.checkout) slot.checkout.state = 'synced';
            messageActionNotice(`已同步 ${res.syncedCount || 0} 个文件回 Windows${res.recycledCount ? `（${res.recycledCount} 个删除项已送入系统回收站）` : ''}`);
            renderSandboxCheckoutStage();
          } catch (err) {
            if (err?.status === 409 && !force) {
              statusMsg.textContent = `${err.message || '检测到 Windows 原工程中同名文件也被外部修改'} `;
              const forceBtn = el('button', 'work-action is-danger', '确认强制覆盖同步');
              forceBtn.type = 'button';
              forceBtn.onclick = () => void doSync(true);
              const cancelBtn = el('button', 'work-action', '取消');
              cancelBtn.type = 'button';
              cancelBtn.onclick = () => {
                statusMsg.hidden = true;
                syncBtn.disabled = false;
                discardBtn.disabled = false;
                bar.replaceChildren(syncBtn, discardBtn);
              };
              bar.replaceChildren(forceBtn, cancelBtn);
              return;
            }
            statusMsg.textContent = err?.message || '同步回 Windows 失败';
            syncBtn.disabled = false;
            discardBtn.disabled = false;
          }
        };

        syncBtn.onclick = () => void doSync(false);
        discardBtn.onclick = async () => {
          const ok = await confirmDangerAction({
            title: '丢弃沙盒副本',
            message: `将删除沙盒中的工程副本，其中尚未同步回 Windows 的 ${changes.length} 项改动会全部丢失，且无法恢复。Windows 原工程不受影响。`,
            confirmLabel: '丢弃副本',
          });
          if (!ok) return;
          syncBtn.disabled = true;
          discardBtn.disabled = true;
          try {
            await api(`/api/dimension/work/runs/${encodeURIComponent(slotId)}/discard-sandbox`, {
              method: 'POST',
              body: '{}',
            });
            diff.state = 'discarded';
            if (slot.checkout) slot.checkout.state = 'discarded';
            messageActionNotice('已丢弃沙盒副本并释放空间，Windows 原工程未作任何改动');
            renderSandboxCheckoutStage();
          } catch (err) {
            statusMsg.hidden = false;
            statusMsg.textContent = err?.message || '丢弃副本失败';
            syncBtn.disabled = false;
            discardBtn.disabled = false;
          }
        };
        bar.append(syncBtn, discardBtn);
        box.append(bar);
      }

      box.append(statusMsg);

      for (const item of changes) {
        const sub = el('div', 'work-dock-diff-sub');
        const subHead = el('div', 'work-dock-diff-head');
        const kindLabel = item.kind === 'added' ? '新增' : item.kind === 'deleted' ? '删除(进回收站)' : '修改';
        subHead.append(
          el('strong', 'work-dock-diff-path', item.path),
          el('span', 'work-dock-diff-badge', `${kindLabel}${item.hostConflict ? ' · 外部冲突' : ''}`)
        );
        sub.append(subHead);
        if (!item.previewOmitted && !item.binary) {
          sub.append(createChangeDiff(item.beforePreview || '', item.afterPreview || ''));
        } else {
          sub.append(el('p', 'work-dock-hint', item.binary ? '二进制文件变更（同步时按原字节写回）' : '文件较大，已省略内联文本对比'));
        }
        box.append(sub);
      }
      wrap.append(box);
    }
    stage.append(wrap);
  }

  async function renderSelectedFileStage(file) {
    cleanupPreviewHost();
    stage.replaceChildren();

    const renderRun = currentRunId, renderUrl = file?.url, renderMode = viewMode;
    const renderTick = manualRefreshTick, renderCp = activeCheckpointId;
    const current = () => activeTab === 'artifacts' && currentRunId === renderRun &&
      selectedFile()?.url === renderUrl && viewMode === renderMode &&
      activeCheckpointId === renderCp && manualRefreshTick === renderTick;
    const activeCp = activeCheckpointId ? checkpoints.find(c => c.id === activeCheckpointId) : null;
    if (activeCp) {
      const loading = el('div', 'work-dock-empty', `正在加载时光机快照 v${activeCp.versionNumber}…`);
      stage.append(loading);
      try {
        const snap = await loadCheckpointSource(activeCp, file);
        if (!current()) return;
        stage.replaceChildren();
        const snapExt = (snap.path.match(/\.[^./\\]+$/)?.[0] || file?.extension || '').toLowerCase();
        if (viewMode === 'preview' && (HTML_EXTS.has(snapExt) || SVG_EXTS.has(snapExt))) {
          const frameWrap = el('div', `work-dock-canvas-shell${viewportMode === 'mobile' ? ' is-mobile' : ''}`);
          const frame = document.createElement('iframe');
          frame.className = 'work-dock-iframe';
          frame.title = `v${activeCp.versionNumber} · ${snap.path}`;
          frame.setAttribute('sandbox', 'allow-scripts');
          frame.srcdoc = SVG_EXTS.has(snapExt) ? wrapSvgAsHtmlDoc(snap.content) : injectOpaqueStorageShim(snap.content);
          frameWrap.append(frame);
          stage.append(frameWrap);
        } else if (viewMode === 'preview' && MD_EXTS.has(snapExt)) {
          const mdBox = el('article', 'work-dock-markdown');
          renderRichMessage(mdBox, snap.content);
          stage.append(mdBox);
        } else {
          const pre = el('pre', 'work-dock-code');
          pre.append(el('code', '', snap.content));
          stage.append(pre);
        }
      } catch (err) {
        if (current()) {
          stage.replaceChildren(el('div', 'work-dock-empty', err.message || '无法读取该历史版本快照'));
        }
      }
      return;
    }

    if (!file) {
      stage.append(el('div', 'work-dock-empty', '当前对话暂无产出文件。任务生成网页、SVG 动画、图片或代码后会在此实时渲染。'));
      return;
    }
    if (!file.available) {
      stage.append(el('div', 'work-dock-empty', `文件暂不可预览：${file.reason || '不可访问'}`));
      return;
    }

    const ext = String(file.extension || '').toLowerCase();
    const isImg = IMAGE_EXTS.has(ext);
    const isSvg = SVG_EXTS.has(ext);
    const isHtml = HTML_EXTS.has(ext) || Boolean(file.previewUrl);
    const isMd = MD_EXTS.has(ext);
    const bustToken = `${Math.round(file.mtimeMs || 0)}_${manualRefreshTick}`;

    if (viewMode === 'preview' && isSvg) {
      const wrap = el('div', `work-dock-img-wrap${viewportMode === 'mobile' ? ' is-mobile' : ''}`);
      const img = el('img', 'work-dock-img is-svg-canvas');
      img.src = appendCacheBust(file.url, bustToken);
      img.alt = file.name;
      wrap.append(img);
      stage.append(wrap);
      return;
    }

    if (viewMode === 'preview' && isImg) {
      const wrap = el('div', 'work-dock-img-wrap');
      const img = el('img', 'work-dock-img');
      img.src = appendCacheBust(file.url, bustToken);
      img.alt = file.name;
      wrap.append(img);
      stage.append(wrap);
      return;
    }

    if (viewMode === 'preview' && isHtml) {
      const baseTarget = file.previewUrl || file.url;
      const withShim = `${baseTarget}${baseTarget.includes('?') ? '&' : '?'}shim=1`;
      const targetUrl = appendCacheBust(withShim, bustToken);
      mountProtectedIframe(targetUrl, file.name);
      return;
    }

    const loading = el('div', 'work-dock-empty', '正在读取文件内容…');
    stage.append(loading);
    try {
      const text = await loadTextSource(file);
      if (!current()) return;
      stage.replaceChildren();
      if (viewMode === 'preview' && isMd) {
        const mdBox = el('article', 'work-dock-markdown');
        renderRichMessage(mdBox, text);
        stage.append(mdBox);
      } else {
        const pre = el('pre', 'work-dock-code');
        const code = el('code', '', text);
        pre.append(code);
        stage.append(pre);
      }
    } catch (err) {
      if (current()) {
        stage.replaceChildren(el('div', 'work-dock-empty', err.message || '此二进制格式不支持文本预览，请点击上方按钮下载查看。'));
      }
    }
  }

  function renderCheckpointStrip() {
    checkpointStrip.replaceChildren();
    const showCp = checkpoints.length > 0 && (viewMode === 'preview' || viewMode === 'source');
    checkpointStrip.hidden = !showCp;
    if (!showCp) return;

    const pillsWrap = el('div', 'work-cp-pills');
    pillsWrap.append(el('span', 'work-cp-label', '时光机'));

    for (const cp of checkpoints) {
      const active = activeCheckpointId === cp.id;
      const btn = el('button', `work-cp-pill${active ? ' is-active' : ''}`, `v${cp.versionNumber}`);
      btn.type = 'button';
      btn.title = `v${cp.versionNumber} · ${cp.label || '历史快照'}（点击对比画面）`;
      btn.onclick = () => {
        activeCheckpointId = active ? '' : cp.id;
        renderArtifactsPane();
      };
      pillsWrap.append(btn);
    }

    const liveBtn = el('button', `work-cp-pill${!activeCheckpointId ? ' is-active is-live' : ''}`, '最新');
    liveBtn.type = 'button';
    liveBtn.title = '查看当前实时工作区画面';
    liveBtn.onclick = () => {
      if (!activeCheckpointId) return;
      activeCheckpointId = '';
      renderArtifactsPane();
    };
    pillsWrap.append(liveBtn);
    checkpointStrip.append(pillsWrap);

    if (activeCheckpointId) {
      const curCp = checkpoints.find(c => c.id === activeCheckpointId);
      if (curCp && currentRunId && api) {
        const restoreBtn = el('button', 'work-cp-restore-btn', `↺ 回退至 v${curCp.versionNumber}`);
        restoreBtn.type = 'button';
        restoreBtn.title = '将工作台代码一键恢复到此轮状态（回退前会自动生成防手滑备份）';
        restoreBtn.onclick = async () => {
          const ok = await confirmDangerAction({
            title: `回退至 v${curCp.versionNumber}`,
            message: `将把工作台代码整体恢复到 v${curCp.versionNumber}${curCp.label ? `（${curCp.label}）` : ''} 的状态，此后的所有改动都会被覆盖。回退前会自动生成一份备份，必要时可从备份找回。`,
            confirmLabel: '确认回退',
          });
          if (!ok) return;
          restoreBtn.disabled = true;
          restoreBtn.textContent = '正在回退…';
          try {
            await api(`/api/dimension/work/runs/${encodeURIComponent(currentRunId)}/restore-checkpoint`, {
              method: 'POST',
              body: JSON.stringify({ checkpointId: curCp.id }),
            });
            activeCheckpointId = '';
            manualRefreshTick++;
            sourceCache.clear();
            messageActionNotice(`已将工作台回退至 v${curCp.versionNumber}（回退前状态已自动备份）`);
            onCheckpointRestored?.(currentRunId);
            renderArtifactsPane();
          } catch (err) {
            messageActionNotice(err?.message || '回退检查点失败');
            restoreBtn.disabled = false;
            restoreBtn.textContent = `↺ 回退至 v${curCp.versionNumber}`;
          }
        };
        checkpointStrip.append(restoreBtn);
      }
    }
  }

  function renderArtifactsPane() {
    selectorBar.replaceChildren();
    actionStrip.replaceChildren();

    if (refreshWarning) selectorBar.append(el('span', 'work-dock-empty', refreshWarning));
    const allFiles = files || [];
    const primaryFiles = allFiles.filter(f => f.category !== 'byproduct');
    const byproductFiles = allFiles.filter(f => f.category === 'byproduct');
    const visibleFiles = showByproducts ? allFiles : primaryFiles;
    const hasChanges = fileChanges.length > 0;
    const totalSandboxChanges = sandboxCheckouts.reduce((acc, s) => acc + ((s.diff?.changes || []).length), 0);
    const hasSandbox = sandboxCheckouts.length > 0 && totalSandboxChanges > 0;

    if (viewMode === 'devserver' && !devServerUrl) {
      viewMode = 'preview';
    }
    if (!visibleFiles.length && !devServerUrl && !hasChanges && hasSandbox && viewMode !== 'sandbox') {
      viewMode = 'sandbox';
    } else if (!visibleFiles.length && !devServerUrl && hasChanges && viewMode !== 'changes' && viewMode !== 'sandbox') {
      viewMode = 'changes';
    } else if (!hasChanges && viewMode === 'changes') {
      viewMode = hasSandbox ? 'sandbox' : 'preview';
    } else if (!hasSandbox && viewMode === 'sandbox') {
      viewMode = hasChanges ? 'changes' : 'preview';
    }

    if (visibleFiles.length) {
      const select = document.createElement('select');
      select.className = 'work-dock-file-select';
      select.setAttribute('aria-label', '选择成品文件');
      const appendOption = (container, f) => {
        const opt = document.createElement('option');
        opt.value = f.url;
        const sizeStr = formatBytes(f.bytes);
        const relLabel = f.relativePath || f.name;
        opt.textContent = `${f.ownerName && f.category === 'byproduct' ? `[${f.ownerName}] ` : ''}${relLabel}${sizeStr ? ` (${sizeStr})` : ''}`;
        container.append(opt);
      };
      if (primaryFiles.length) {
        for (const f of primaryFiles) appendOption(select, f);
      }
      if (showByproducts && byproductFiles.length) {
        const grp = document.createElement('optgroup');
        grp.label = '过程副产品（草稿 / 纪要）';
        for (const f of byproductFiles) appendOption(grp, f);
        select.append(grp);
      }
      if (!visibleFiles.some(f => f.url === selectedFileUrl)) {
        selectedFileUrl = visibleFiles[0]?.url || '';
      }
      const cur = selectedFile();
      if (cur) {
        selectedFileUrl = cur.url;
        select.value = cur.url;
      }
      select.onchange = () => {
        selectedFileUrl = select.value;
        if (viewMode === 'changes' || viewMode === 'sandbox' || viewMode === 'devserver') viewMode = 'preview';
        renderArtifactsPane();
      };
      selectorBar.append(select);
    }

    if (devServerUrl) {
      const devBtn = el('button', `work-dock-pill is-dev-pill${viewMode === 'devserver' ? ' is-active' : ''}`, `🌐 本地服务 (${extractPortLabel(devServerUrl)})`);
      devBtn.type = 'button';
      devBtn.title = `在右侧画布实时预览 ${devServerUrl}`;
      devBtn.onclick = () => {
        viewMode = viewMode === 'devserver' ? 'preview' : 'devserver';
        renderArtifactsPane();
      };
      selectorBar.append(devBtn);
    }

    if (byproductFiles.length) {
      const bpBtn = el('button', `work-dock-pill${showByproducts ? ' is-active' : ''}`, `副产品 (${byproductFiles.length})`);
      bpBtn.type = 'button';
      bpBtn.title = '显示或隐藏任务过程中的草稿、思考纪要与日志';
      bpBtn.onclick = () => {
        showByproducts = !showByproducts;
        renderArtifactsPane();
      };
      selectorBar.append(bpBtn);
    }

    if (hasSandbox) {
      const sbBtn = el('button', `work-dock-pill${viewMode === 'sandbox' ? ' is-active' : ''}`, `沙盒回写 (${totalSandboxChanges})`);
      sbBtn.type = 'button';
      sbBtn.onclick = () => {
        viewMode = viewMode === 'sandbox' ? 'preview' : 'sandbox';
        renderArtifactsPane();
      };
      selectorBar.append(sbBtn);
    }

    if (hasChanges) {
      const diffBtn = el('button', `work-dock-pill${viewMode === 'changes' ? ' is-active' : ''}`, `变更对比 (${fileChanges.length})`);
      diffBtn.type = 'button';
      diffBtn.onclick = () => {
        viewMode = viewMode === 'changes' ? 'preview' : 'changes';
        renderArtifactsPane();
      };
      selectorBar.append(diffBtn);
    }

    selectorBar.hidden = !selectorBar.childElementCount;
    renderCheckpointStrip();

    if (viewMode === 'devserver') {
      actionStrip.hidden = false;
      const vpSeg = el('div', 'work-dock-seg');
      for (const [vp, label] of [['desktop', '桌面'], ['mobile', '手机']]) {
        const b = el('button', viewportMode === vp ? 'is-active' : '', label);
        b.type = 'button';
        b.onclick = () => { viewportMode = vp; renderArtifactsPane(); };
        vpSeg.append(b);
      }
      const reloadBtn = el('button', 'work-action', '⟳ 刷新');
      reloadBtn.type = 'button';
      reloadBtn.onclick = () => { manualRefreshTick++; renderDevServerStage(); };
      const extLink = el('a', 'work-action', '↗ 浏览器打开');
      const safeExtUrl = safeHttpHref(devServerUrl);
      if (safeExtUrl) {
        extLink.href = safeExtUrl;
        extLink.target = '_blank';
        extLink.rel = 'noopener noreferrer';
      } else {
        extLink.href = '#';
        extLink.onclick = e => e.preventDefault();
      }
      actionStrip.append(vpSeg, reloadBtn, extLink);
      renderDevServerStage();
      return;
    }

    if (viewMode === 'sandbox') {
      actionStrip.hidden = true;
      renderSandboxCheckoutStage();
      return;
    }

    if (viewMode === 'changes') {
      actionStrip.hidden = true;
      renderFileChangesStage();
      return;
    }

    const cur = selectedFile();
    if (!cur && !activeCheckpointId) {
      actionStrip.hidden = true;
      void renderSelectedFileStage(null);
      return;
    }

    actionStrip.hidden = false;
    const ext = String(cur?.extension || '.html').toLowerCase();
    const isHtmlOrSvg = HTML_EXTS.has(ext) || SVG_EXTS.has(ext) || Boolean(cur?.previewUrl);
    const hasDualView = isHtmlOrSvg || MD_EXTS.has(ext);

    if (hasDualView) {
      const seg = el('div', 'work-dock-seg');
      for (const [mode, label] of [['preview', '画布'], ['source', '源码']]) {
        const b = el('button', viewMode === mode ? 'is-active' : '', label);
        b.type = 'button';
        b.onclick = () => { viewMode = mode; renderArtifactsPane(); };
        seg.append(b);
      }
      actionStrip.append(seg);
    }

    if (viewMode === 'preview' && isHtmlOrSvg) {
      const vpSeg = el('div', 'work-dock-seg');
      for (const [vp, label] of [['desktop', '桌面'], ['mobile', '手机']]) {
        const b = el('button', viewportMode === vp ? 'is-active' : '', label);
        b.type = 'button';
        b.title = vp === 'mobile' ? '以 390px 移动视口检验响应式布局' : '以宽屏桌面视口渲染画布';
        b.onclick = () => { viewportMode = vp; renderArtifactsPane(); };
        vpSeg.append(b);
      }
      actionStrip.append(vpSeg);
    }

    const refreshBtn = el('button', 'work-action', '⟳ 刷新');
    refreshBtn.type = 'button';
    refreshBtn.title = '强制刷新最新文件内容与画布渲染';
    refreshBtn.onclick = () => {
      manualRefreshTick++;
      onManualRefresh?.(currentRunId);
      renderArtifactsPane();
    };
    actionStrip.append(refreshBtn);

    if (cur && (!IMAGE_EXTS.has(ext) || SVG_EXTS.has(ext)) && cur.available && !activeCheckpointId) {
      const copyBtn = el('button', 'work-action', '复制源码');
      copyBtn.type = 'button';
      copyBtn.onclick = async () => {
        try {
          const txt = await readFullText(cur);
          await copyMessageText(txt);
          messageActionNotice('已复制源码内容');
        } catch (e) {
          messageActionNotice(e.message || '无法复制该文件');
        }
      };
      actionStrip.append(copyBtn);
    }

    if (cur?.available && !activeCheckpointId) {
      const dlLink = el('a', 'work-action', '下载');
      dlLink.href = `${cur.url}${cur.url.includes('?') ? '&' : '?'}download=1`;
      dlLink.download = cur.name;
      actionStrip.append(dlLink);
    }

    void renderSelectedFileStage(cur);
  }

  let inspHeroRefs = null; // { avatarSlot, avatarSig, nameEl, badgeEl, jobEl }

  function renderInspectorPane() {
    if (!inspectorData) {
      inspHero.replaceChildren();
      inspHeroRefs = null;
      inspBody.replaceChildren(el('div', 'work-dock-empty', '点击圆桌顶栏的任意成员头像，即可查看其实时思路。'));
      return;
    }

    // In-place reconciliation so live streaming deltas NEVER tear down avatar SVG or scroll position!
    if (!inspHeroRefs || !inspHeroRefs.avatarSlot.isConnected) {
      inspHero.replaceChildren();
      const avatarSlot = el('span', 'work-inspector-avatar');
      const meta = el('div', 'work-inspector-meta');
      const topRow = el('div', 'work-inspector-title-row');
      const nameEl = el('strong', 'work-inspector-name');
      const badgeEl = el('span', 'work-inspector-badge');
      const jobEl = el('p', 'work-inspector-job');
      topRow.append(nameEl, badgeEl);
      meta.append(topRow, jobEl);
      inspHero.append(avatarSlot, meta);
      inspHeroRefs = { avatarSlot, avatarSig: '', nameEl, badgeEl, jobEl };
    }

    const nextAvSig = `${inspectorData.memberId || ''}:${inspectorData.statusCode || ''}`;
    if (inspHeroRefs.avatarSig !== nextAvSig && inspectorData.avatarHtml) {
      inspHeroRefs.avatarSig = nextAvSig;
      inspHeroRefs.avatarSlot.innerHTML = inspectorData.avatarHtml;
    }

    const nextName = inspectorData.memberName || inspectorData.memberId || '';
    if (inspHeroRefs.nameEl.textContent !== nextName) inspHeroRefs.nameEl.textContent = nextName;

    const nextBadgeClass = `work-inspector-badge status-${inspectorData.statusCode || 'idle'}`;
    if (inspHeroRefs.badgeEl.className !== nextBadgeClass) inspHeroRefs.badgeEl.className = nextBadgeClass;
    const nextBadgeText = inspectorData.statusLabel || '待命';
    if (inspHeroRefs.badgeEl.textContent !== nextBadgeText) inspHeroRefs.badgeEl.textContent = nextBadgeText;

    const nextJob = inspectorData.roleText || '';
    inspHeroRefs.jobEl.hidden = !nextJob;
    if (inspHeroRefs.jobEl.textContent !== nextJob) inspHeroRefs.jobEl.textContent = nextJob;

    if (inspectorData.bodyNode && inspBody.firstElementChild !== inspectorData.bodyNode) {
      inspBody.replaceChildren(inspectorData.bodyNode);
    }
  }

  function openPanel(targetTab) {
    const infoDrawer = document.getElementById('drawer');
    if (infoDrawer && !infoDrawer.hidden) {
      document.getElementById('chromeDrawerClose')?.click();
      infoDrawer.hidden = true;
    }
    host.hidden = false;
    setTab(targetTab);
    syncWidthVar();
  }

  return {
    isOpen: () => !host.hidden,
    activeTab: () => activeTab,
    inspectedMemberId: () => (!host.hidden && activeTab === 'inspector' ? inspectorData?.memberId || '' : ''),
    updateOverview({ runId = '', steps = [], uploads = [], autoReveal = false } = {}) {
      if (runId && runId !== currentRunId) {
        currentRunId = runId;
        expandEarlierSteps = false;
      }
      if (runId) resetAutoRevealFor(runId);
      progressSteps = Array.isArray(steps) ? steps : [];
      uploadedItems = Array.isArray(uploads) ? uploads : [];
      if (!host.hidden && activeTab === 'overview') {
        renderOverviewPane();
      } else if (autoReveal && host.hidden && progressSteps.length > 0 && window.innerWidth > 1080 && claimAutoReveal('overview')) {
        openPanel('overview');
      }
    },
    updateArtifacts({
      runId = '',
      files: nextFiles = [],
      changes: nextChanges = [],
      sandboxCheckouts: nextSandbox = [],
      checkpoints: nextCheckpoints = null,
      warning = '',
      autoReveal = false,
    } = {}) {
      refreshWarning = warning;
      const prevPrimary = files.filter(f => f.category !== 'byproduct').length + fileChanges.length + sandboxCheckouts.length;
      if (runId && runId !== currentRunId) {
        currentRunId = runId;
        sourceCache.clear();
        checkpointFileCache.clear();
        selectedFileUrl = '';
        activeCheckpointId = '';
        devServerUrl = '';
        checkpoints = [];
        expandEarlierSteps = false;
        showByproducts = false;
        lastRenderedSignature = '';
      }
      if (runId) resetAutoRevealFor(runId);
      files = Array.isArray(nextFiles) ? nextFiles : [];
      fileChanges = Array.isArray(nextChanges) ? nextChanges : [];
      sandboxCheckouts = Array.isArray(nextSandbox) ? nextSandbox : [];
      if (Array.isArray(nextCheckpoints)) {
        checkpoints = nextCheckpoints;
        if (activeCheckpointId && !checkpoints.some(c => c.id === activeCheckpointId)) {
          activeCheckpointId = '';
        }
      }

      const primary = files.filter(f => f.category !== 'byproduct');
      const sbChanges = sandboxCheckouts.reduce((acc, s) => acc + ((s.diff?.changes || []).length), 0);
      const totalPrimary = primary.length + fileChanges.length + sbChanges;
      artTabBtn.textContent = totalPrimary ? `实时画布 (${primary.length || sbChanges || fileChanges.length})` : '实时画布';

      if (primary.length && !primary.some(f => f.url === selectedFileUrl)) {
        const entryFile = primary.find(f => /\.html?$/i.test(f.name))
          || primary.find(f => /\.svg$/i.test(f.name))
          || primary.find(f => /\.md$/i.test(f.name))
          || primary[0];
        selectedFileUrl = entryFile.url;
      }

      const nextSig = JSON.stringify({
        runId: currentRunId,
        sel: selectedFileUrl,
        cpLen: checkpoints.length,
        refreshWarning,
        dev: devServerUrl,
        f: files.map(f => `${f.url}:${Math.round(f.mtimeMs || 0)}:${f.bytes || 0}`),
        c: fileChanges.length,
        s: sbChanges,
      });

      const hasCanvasTarget = primary.some(f => /\.(html?|svg)$/i.test(f.name));

      if (!host.hidden) {
        if (activeTab === 'overview') {
          renderOverviewPane();
          // Auto-jump to Live Canvas when an interactive HTML/SVG deliverable is freshly created!
          if (autoReveal && prevPrimary === 0 && hasCanvasTarget) {
            lastRenderedSignature = nextSig;
            viewMode = 'preview';
            setTab('artifacts');
          }
        } else if (activeTab === 'artifacts' && nextSig !== lastRenderedSignature) {
          lastRenderedSignature = nextSig;
          renderArtifactsPane();
        }
      } else if (autoReveal && host.hidden && ((prevPrimary === 0 && totalPrimary > 0) || (hasCanvasTarget && nextSig !== lastRenderedSignature)) && claimAutoReveal(hasCanvasTarget ? 'canvas' : 'artifacts')) {
        lastRenderedSignature = nextSig;
        if (hasCanvasTarget) {
          viewMode = 'preview';
          openPanel('artifacts');
        } else {
          openPanel('overview');
        }
      }
    },
    registerDevServerUrl(url, { autoReveal = false } = {}) {
      const clean = String(url || '').trim();
      if (!clean) return;
      const isNew = devServerUrl !== clean;
      devServerUrl = clean;
      if (autoReveal && isNew && host.hidden && claimAutoReveal(`devserver:${clean}`)) {
        viewMode = 'devserver';
        openPanel('artifacts');
      } else if (!host.hidden) {
        if (activeTab === 'overview') renderOverviewPane();
        else if (activeTab === 'artifacts') renderArtifactsPane();
      }
    },
    openDevServerUrl(url) {
      if (url) devServerUrl = String(url).trim();
      if (!devServerUrl) return;
      viewMode = 'devserver';
      openPanel('artifacts');
    },
    openOverview() {
      openPanel('overview');
    },
    openArtifacts({ fileUrl, checkpointId, showChanges = false, showSandbox = false } = {}) {
      if (checkpointId !== undefined) {
        activeCheckpointId = checkpointId || '';
      }
      if (fileUrl) {
        const target = files.find(f => f.url === fileUrl);
        if (target?.category === 'byproduct') showByproducts = true;
        selectedFileUrl = fileUrl;
        viewMode = 'preview';
      } else if (showSandbox) {
        viewMode = 'sandbox';
      } else if (showChanges) {
        viewMode = 'changes';
      } else if (viewMode === 'devserver' && !devServerUrl) {
        viewMode = 'preview';
      }
      openPanel('artifacts');
    },
    openInspector(data) {
      inspectorData = data;
      inspTabBtn.hidden = !inspectorData;
      if (inspectorData) {
        inspTabBtn.textContent = `${inspectorData.memberName || '成员'} · 思路`;
      }
      openPanel('inspector');
    },
    updateInspector(data) {
      if (!data) {
        inspectorData = null;
        inspTabBtn.hidden = true;
        if (activeTab === 'inspector') setTab('overview');
        return;
      }
      inspectorData = data;
      inspTabBtn.hidden = false;
      inspTabBtn.textContent = `${data.memberName || '成员'} · 思路`;
      if (!host.hidden && activeTab === 'inspector') {
        renderInspectorPane();
      }
    },
    close,
    clear() {
      cleanupPreviewHost();
      currentRunId = '';
      files = [];
      fileChanges = [];
      sandboxCheckouts = [];
      checkpoints = [];
      progressSteps = [];
      uploadedItems = [];
      expandEarlierSteps = false;
      activeCheckpointId = '';
      refreshWarning = '';
      devServerUrl = '';
      selectedFileUrl = '';
      showByproducts = false;
      inspectorData = null;
      lastRenderedSignature = '';
      sourceCache.clear();
      checkpointFileCache.clear();
      inspTabBtn.hidden = true;
      artTabBtn.textContent = '实时画布';
      close();
    },
  };
}
