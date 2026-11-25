// Right-side Hand-Journal Bookmark Tab: Model Canvas (UE Blueprint + Circuit Loop + Edge-Attachment)
// Pure native ES Module: HTML node chips + SVG cubic Bezier wires + live junction dots + real-time execution view.

const NODE_W = 216;
const NODE_H_DEFAULT = 96;

const NODE_TYPE_META = {
  input:         { label: '开始任务', short: '开始', tone: 'input',    icon: '▶' },
  action:        { label: '执行动作', short: '动作', tone: 'action',   icon: '⚡' },
  reference:     { label: '读取资料', short: '资料', tone: 'ref',      icon: '📄' },
  agent:         { label: '让伙伴处理', short: '伙伴', tone: 'agent',  icon: '✦' },
  compress:      { label: '提炼整理', short: '整理', tone: 'compress', icon: '✂' },
  gate:          { label: '确认与检查', short: '确认', tone: 'gate',   icon: '✔' },
  function_call: { label: '组合步骤', short: '组合', tone: 'func',     icon: '📦' },
};

const ACTION_KIND_META = {
  open_app:    { label: '打开软件 / 文件夹', icon: '⚡', targetLbl: '软件名、文件或文件夹路径（留空打开当前项目目录）', placeholder: '例如：notepad.exe 或 L:\\MyProject' },
  open_url:    { label: '打开网页',         icon: '🌐', targetLbl: '要打开的网址', placeholder: '例如：https://github.com 或 localhost:5173' },
  read_file:   { label: '读取文件 / 目录',   icon: '📂', targetLbl: '文件或目录路径（留空自动读取当前项目目录）', placeholder: '例如：README.md 或 L:\\Docs\\notes.txt' },
  fetch_url:   { label: '获取网页 / 接口信息', icon: '🔍', targetLbl: '要读取信息的网页或接口地址', placeholder: '例如：https://example.com/status' },
  run_command: { label: '运行命令 / 脚本',   icon: '💻', targetLbl: '要运行的命令行（支持 {{input}} 变量）', placeholder: '例如：git status --short 或 python script.py' },
};

const LOGIC_OP_OPTIONS = [
  { value: 'contains',     label: '包含文字', needVal: true,  ph: '例如：成功 / 200 / PASS' },
  { value: 'not_contains', label: '不包含文字', needVal: true, ph: '例如：错误 / ERROR / FAIL' },
  { value: 'equals',       label: '完全等于', needVal: true,  ph: '例如：true / 是' },
  { value: 'not_empty',    label: '内容不为空', needVal: false, ph: '' },
  { value: 'is_true',      label: '布尔值为真', needVal: false, ph: '' },
  { value: 'is_false',     label: '布尔值为假', needVal: false, ph: '' },
  { value: 'gt_len',       label: '字数大于', needVal: true,  ph: '例如：20' },
];

const isLogicGateMode = m => m === 'bool_switch' || m === 'logic_and' || m === 'logic_or';

const CLI_ENGINE_OPTIONS = [
  { id: 'auto', label: '自动优选 CLI' },
  { id: 'antigravity', label: 'Antigravity (agy)' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'gemini-cli', label: 'Gemini CLI' },
  { id: 'qwen-code', label: 'Qwen Code' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'kimi-code', label: 'Kimi Code' },
  { id: 'deepseek-harness', label: 'DeepSeek Harness' },
  { id: 'hermes', label: 'Hermes' },
];

const el = (tag, className = '', text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};

const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

const deepClone = obj => JSON.parse(JSON.stringify(obj));

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// Cubic Bezier math for exact edge-attachment junction point calculation
function cubicPoint(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;
  return {
    x: mt2 * mt * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t2 * t * p3.x,
    y: mt2 * mt * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t2 * t * p3.y,
  };
}

function closestTOnCubic(p0, p1, p2, p3, pt) {
  let bestT = 0.5;
  let bestDist = Infinity;
  for (let i = 3; i <= 17; i++) {
    const t = i / 20;
    const p = cubicPoint(p0, p1, p2, p3, t);
    const d = (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      bestT = t;
    }
  }
  return { t: Math.max(0.18, Math.min(0.82, bestT)), dist: Math.sqrt(bestDist) };
}

export function createModelCanvasPane({
  api,
  host,
  getBots,
  getProviderGroups,
  getActiveBotId,
  getProjectCwd,
  getLatestUserInput,
  onCloseDock,
  onBotPromoted,
  onNotify,
} = {}) {
  const notify = msg => {
    if (onNotify) onNotify(msg);
  };

  // Library & editor state
  let library = { canvases: [], functions: [], harnesses: [] };
  let loaded = false;
  let dirty = false;
  let navStack = []; // [{ id, kind, name }] — breadcrumb stack for UE Blueprint drill-down!
  let graph = null;  // Working editable copy of the currently opened canvas or blueprint function

  // Selection & viewport state
  const selectedNodeIds = new Set();
  let selectedEdgeId = '';
  let inspectorOpen = false;
  let approvalCollapsed = false;
  let needsFit = true;
  let showRunBar = false;
  let panX = 24;
  let panY = 24;
  let zoom = 0.88;

  // Interactive wire dragging state
  let wireDrag = null; // { fromNodeId, fromPort, startX, startY, curX, curY, hoverNodeId, hoverEdgeId, hoverT }

  // Live run state
  let activeRun = null;
  let pollTimer = null;
  let visible = false;
  let pollGeneration = 0;
  let starting = false;
  let pendingStart = null;
  let leaving = false;
  let editRevision = 0;
  let runInputDraft = '';
  let linkedWork = null; // { workRunId, groupId, groupMemberIds, canvasId, readyToStart, executing, onExecute }

  // Undo / Redo history stack (up to 40 steps, auto-coalesces continuous text typing)
  const MAX_HISTORY = 40;
  let undoStack = [];
  let redoStack = [];
  let lastCommittedSnap = null;
  let lastMergeTarget = null;
  let lastMergeAt = 0;
  let restoringHistory = false;

  // Cached node heights and computed edge Bezier curves for junction point evaluation
  const nodeDims = new Map();
  const edgeCurves = new Map(); // edgeId -> { p0, p1, p2, p3 }

  // =========================================================================
  // Build Persistent Shell DOM
  // =========================================================================
  host.replaceChildren();
  const root = el('div', 'mc-root');

  // Top Header Toolbar
  const topbar = el('div', 'mc-topbar');
  const brandBadge = el('span', 'mc-brand', 'DimensionImage');
  brandBadge.title = 'DimensionImage · 通俗可视化自动化流程蓝图';
  const crumbBar = el('div', 'mc-crumbs');
  const tplSelect = el('select', 'mc-select mc-tpl-select');
  tplSelect.title = '切换 DimensionImage 流程蓝图或新建流程';
  const btnNew = el('button', 'mc-btn', '＋新建');
  btnNew.type = 'button'; btnNew.title = '新建空白 DimensionImage 流程';
  const btnSave = el('button', 'mc-btn', '保存');
  btnSave.type = 'button'; btnSave.title = '保存当前流程或组合步骤 (Ctrl+S)';
  const btnUndo = el('button', 'mc-btn mc-icon-btn', '↶');
  btnUndo.type = 'button'; btnUndo.title = '撤销上一步修改 (Ctrl+Z)'; btnUndo.disabled = true;
  const btnRedo = el('button', 'mc-btn mc-icon-btn', '↷');
  btnRedo.type = 'button'; btnRedo.title = '重做 (Ctrl+Y / Ctrl+Shift+Z)'; btnRedo.disabled = true;
  const undoGrp = el('div', 'mc-undo-grp');
  undoGrp.append(btnUndo, btnRedo);
  const btnAutoLayout = el('button', 'mc-btn', '✨ 整理');
  btnAutoLayout.type = 'button'; btnAutoLayout.title = '一键自动整理排版，消除节点重叠与连线交叉（可 Ctrl+Z 撤回）';
  const btnAddNode = el('button', 'mc-btn', '＋步骤 ▾');
  btnAddNode.type = 'button'; btnAddNode.title = '添加动作积木（也可在画布空白处右键直接原地添加）';
  const btnCollapse = el('button', 'mc-btn is-blueprint', '📦 打包组合');
  btnCollapse.type = 'button'; btnCollapse.title = '把选中的多个步骤打包成一个常用组合，以后一键重复使用';
  btnCollapse.disabled = true;
  const btnRunToggle = el('button', 'mc-btn is-primary', '▶ 运行');
  btnRunToggle.type = 'button';
  const btnCancelRun = el('button', 'mc-btn is-danger', '■ 停止');
  btnCancelRun.type = 'button'; btnCancelRun.hidden = true;
  const btnClose = el('button', 'work-dock-close', '收起');
  btnClose.type = 'button'; btnClose.title = '收起右侧工作区';
  btnClose.onclick = () => onCloseDock?.();

  const topLeft = el('div', 'mc-top-group');
  topLeft.append(brandBadge, crumbBar, tplSelect, btnNew);
  const topRight = el('div', 'mc-top-group');
  topRight.append(undoGrp, btnAutoLayout, btnAddNode, btnCollapse, btnSave, btnRunToggle, btnCancelRun, btnClose);
  topbar.append(topLeft, topRight);

  // Add-Node Popover Menu
  const addMenu = el('div', 'mc-add-menu');
  addMenu.hidden = true;

  // Smart Right-Click Context Menu (canvas / node / edge)
  const ctxMenu = el('div', 'mc-ctx-menu');
  ctxMenu.hidden = true;

  // Work-Group Linked Blueprint Banner (shown when editing a group/solo Work blueprint)
  const workLinkBar = el('div', 'mc-work-link-bar');
  workLinkBar.hidden = true;

  // Run Bar (collapsible input launcher + live status strip)
  const runBar = el('div', 'mc-runbar');
  runBar.hidden = true;

  // Collapse-to-Function inline dialog bar
  const collapseBar = el('div', 'mc-collapse-bar');
  collapseBar.hidden = true;

  // Main workspace split: Blueprint Viewport + Collapsible Inspector Drawer
  const body = el('div', 'mc-body');
  const viewport = el('div', 'mc-viewport');
  const world = el('div', 'mc-world');
  const svgLayer = svgEl('svg', { class: 'mc-svg-layer', width: '4000', height: '3000', viewBox: '0 0 4000 3000' });
  const defs = svgEl('defs');
  defs.innerHTML = `
    <marker id="mcArrowMain" markerWidth="10" markerHeight="10" refX="8.5" refY="3.5" orient="auto">
      <path d="M0,0.6 L8.5,3.5 L0,6.4 z" fill="#5c6ee0"/>
    </marker>
    <marker id="mcArrowLoop" markerWidth="10" markerHeight="10" refX="8.5" refY="3.5" orient="auto">
      <path d="M0,0.6 L8.5,3.5 L0,6.4 z" fill="#e08b1a"/>
    </marker>`;
  svgLayer.append(defs);
  const edgesGroup = svgEl('g', { class: 'mc-edges-group' });
  const junctionsGroup = svgEl('g', { class: 'mc-junctions-group' });
  const previewGroup = svgEl('g', { class: 'mc-preview-group' });
  svgLayer.append(edgesGroup, junctionsGroup, previewGroup);

  const nodesLayer = el('div', 'mc-nodes-layer');
  world.append(svgLayer, nodesLayer);

  // Floating wire hint & zoom HUD
  const wireToast = el('div', 'mc-wire-toast');
  wireToast.hidden = true;

  const hud = el('div', 'mc-hud');
  const hudLegend = el('div', 'mc-hud-legend');
  hudLegend.innerHTML =
    `<span class="mc-leg-item"><i class="mc-leg-line is-main"></i>下一步</span>` +
    `<span class="mc-leg-item"><i class="mc-leg-line is-supp"></i>顺带补充（并行）</span>` +
    `<span class="mc-leg-item"><i class="mc-leg-line is-loop"></i>不满意重做</span>`;
  const hudZoom = el('div', 'mc-hud-zoom');
  const btnZoomOut = el('button', 'mc-hud-btn', '−');
  btnZoomOut.type = 'button';
  const zoomLbl = el('span', 'mc-hud-zoom-lbl', '88%');
  const btnZoomIn = el('button', 'mc-hud-btn', '＋');
  btnZoomIn.type = 'button';
  const btnFit = el('button', 'mc-hud-btn', '居中');
  btnFit.type = 'button';
  hudZoom.append(btnZoomOut, zoomLbl, btnZoomIn, btnFit);
  hud.append(hudLegend, hudZoom);

  // Floating Approval Gate Banner (pops at bottom of canvas when a human approval gate pauses!)
  const approvalBanner = el('div', 'mc-approval-banner');
  approvalBanner.hidden = true;

  viewport.append(world, wireToast, approvalBanner, hud);

  const inspector = el('aside', 'mc-inspector thin-scroll');
  inspector.hidden = true;

  body.append(viewport, inspector);
  root.append(topbar, workLinkBar, addMenu, ctxMenu, collapseBar, runBar, body);
  host.append(root);

  // =========================================================================
  // Helpers & Run-Frame Lookup
  // =========================================================================
  const currentFramePrefix = () => {
    // If drilled into a function_call chip during live run, prefix tracks chipId::...
    let p = '';
    for (let i = 1; i < navStack.length; i++) {
      if (navStack[i].viaChipId) p += `${navStack[i].viaChipId}::`;
    }
    return p;
  };

  const getRunForCurrentGraph = () => {
    if (!activeRun || !navStack.length) return null;
    return activeRun.canvasId === navStack[0].id ? activeRun : null;
  };

  const getNodeRunState = nodeId => {
    const curRun = getRunForCurrentGraph();
    if (!curRun || !curRun.nodes) return null;
    const key = currentFramePrefix() + nodeId;
    return curRun.nodes[key] || null;
  };

  const getEdgeLoopCount = edgeId => {
    if (!activeRun || !activeRun.loopCounts) return 0;
    if (navStack.length && activeRun.canvasId !== navStack[0].id) return 0;
    return Number(activeRun.loopCounts[currentFramePrefix() + edgeId] || 0);
  };

  const isEdgeActivePulse = edgeId => {
    if (!activeRun || !Array.isArray(activeRun.activeEdges)) return false;
    if (navStack.length && activeRun.canvasId !== navStack[0].id) return false;
    return activeRun.activeEdges.includes(currentFramePrefix() + edgeId);
  };

  const findGraphInLibrary = id => {
    return (library.canvases || []).find(c => c.id === id) ||
           (library.functions || []).find(f => f.id === id) || null;
  };

  const applyTransform = () => {
    world.style.transform = `translate(${Math.round(panX)}px, ${Math.round(panY)}px) scale(${zoom})`;
    zoomLbl.textContent = `${Math.round(zoom * 100)}%`;
  };

  const fitViewport = () => {
    if (!graph || !graph.nodes.length) {
      panX = 24; panY = 24; zoom = 0.88;
      needsFit = false;
      applyTransform();
      return;
    }
    const vr = viewport.getBoundingClientRect();
    if (vr.width < 120 || vr.height < 80) {
      needsFit = true;
      return;
    }
    needsFit = false;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of graph.nodes) {
      minX = Math.min(minX, n.x - 16);
      minY = Math.min(minY, n.y - 10);
      maxX = Math.max(maxX, n.x + NODE_W + 16);
      maxY = Math.max(maxY, n.y + (nodeDims.get(n.id)?.h || NODE_H_DEFAULT) + 12);
    }
    // Include feedback loop bottom clearance in viewport bounds so loops are never clipped
    for (const c of edgeCurves.values()) {
      if (c.isLoop && Number.isFinite(c.lowY)) {
        maxY = Math.max(maxY, c.lowY + 26);
        minX = Math.min(minX, Math.min(c.p0.x, c.p3.x) - 52);
        maxX = Math.max(maxX, Math.max(c.p0.x, c.p3.x) + 46);
      }
    }
    const pad = 30;
    const gw = Math.max(240, maxX - minX + pad * 2);
    const gh = Math.max(180, maxY - minY + pad * 2);
    const s = Math.max(0.26, Math.min(1.05, Math.min((vr.width - 18) / gw, (vr.height - 54) / gh)));
    zoom = Number(s.toFixed(2));
    panX = Math.round((vr.width - (maxX - minX) * zoom) / 2 - minX * zoom);
    panY = Math.round(Math.max(20, (vr.height - 46 - (maxY - minY) * zoom) / 2 - minY * zoom));
    applyTransform();
  };

  if (typeof ResizeObserver !== 'undefined') {
    let lastObsW = 0;
    const vpObs = new ResizeObserver(entries => {
      const w = Math.round(entries[0]?.contentRect?.width || 0);
      if (w >= 120 && (needsFit || (lastObsW < 120 && w >= 120))) {
        lastObsW = w;
        requestAnimationFrame(() => fitViewport());
      } else if (w > 0) {
        lastObsW = w;
      }
    });
    vpObs.observe(viewport);
  }

  const renderWorkLinkBar = () => {
    workLinkBar.replaceChildren();
    if (!linkedWork || !graph || graph.id !== linkedWork.canvasId) {
      workLinkBar.hidden = true;
      return;
    }
    workLinkBar.hidden = false;
    const curRun = activeRun && activeRun.canvasId === graph.id ? activeRun : null;
    const curDone = Boolean(curRun && ['completed', 'failed', 'cancelled'].includes(curRun.status));
    const curRunning = Boolean(curRun && (curRun.status === 'running' || curRun.status === 'waiting_approval'));
    if (curDone && !linkedWork.readyToStart) {
      linkedWork.executing = false;
      linkedWork.readyToStart = false;
    }
    const isExec = curRunning || (!curDone && Boolean(linkedWork.executing));
    const info = el('div', 'mc-work-link-info');
    if (curDone && !linkedWork.readyToStart) {
      const ok = curRun.status === 'completed';
      info.append(
        el('span', `mc-work-link-badge${ok ? ' is-live' : ''}`, ok ? '✓ 蓝图已完成交付' : '○ 蓝图已结束'),
        el('span', 'mc-work-link-text', ok
          ? '执行成果已回流到左侧工坊会话，可继续微调后再次运行或另存模板'
          : (curRun.error || '可调整节点或连线后重新运行'))
      );
      workLinkBar.append(info);
      return;
    }
    if (isExec) {
      info.append(
        el('span', 'mc-work-link-badge is-live', '⚡ 协同蓝图运行中'),
        el('span', 'mc-work-link-text', '正在实时同步步骤进度与产出到左侧工坊会话')
      );
      workLinkBar.append(info);
      return;
    }
    info.append(
      el('span', 'mc-work-link-badge', '📐 协同蓝图'),
      el('span', 'mc-work-link-text', dirty
        ? '已修改 Bot / 模型或连线（开工时将自动保存并按此蓝图执行）'
        : '点任意节点可直接改 Bot / 模型 / CLI，或拖线改流向')
    );
    workLinkBar.append(info);
    if (linkedWork.manualAssignment && linkedWork.readyToStart) {
      for (const n of graph.nodes.filter(n=>n.type==='agent')) {
        const pick = el('button','mc-btn',(n.assignmentLocked?'🔒 ':'')+(n.title || n.id));
        pick.type='button';
        pick.onclick=()=>{selectedNodeIds.clear(); selectedNodeIds.add(n.id); selectedEdgeId=null; inspectorOpen=true; renderAll();};
        workLinkBar.append(pick);
      }
    }
    if (linkedWork.readyToStart && typeof linkedWork.onExecute === 'function') {
      const goBtn = el('button', 'mc-btn is-run mc-work-link-go', dirty ? '▶ 保存并按蓝图开工' : '▶ 按当前蓝图开工');
      goBtn.type = 'button';
      goBtn.onclick = async () => {
        goBtn.disabled = true;
        try {
          if (dirty) {
            const ok = await saveCurrentGraph({ silent: true });
            if (!ok) { goBtn.disabled = false; return; }
          }
          await linkedWork.onExecute(graph.id);
        } catch (err) {
          goBtn.disabled = false;
          notify(`启动蓝图失败：${err?.message || err}`);
        }
      };
      workLinkBar.append(goBtn);
    }
  };

  const captureSnap = () => {
    if (!graph) return null;
    return {
      json: JSON.stringify({ nodes: graph.nodes, edges: graph.edges }),
      selNodes: [...selectedNodeIds],
      selEdge: selectedEdgeId,
    };
  };

  const syncUndoButtons = () => {
    btnUndo.disabled = undoStack.length === 0;
    btnRedo.disabled = redoStack.length === 0;
    btnUndo.title = undoStack.length ? `撤销 (${undoStack.length} 步可用 · Ctrl+Z)` : '暂无可撤销操作 (Ctrl+Z)';
    btnRedo.title = redoStack.length ? `重做 (${redoStack.length} 步可用 · Ctrl+Y)` : '暂无可重做操作 (Ctrl+Y)';
  };

  const resetHistory = () => {
    undoStack = [];
    redoStack = [];
    lastCommittedSnap = captureSnap();
    lastMergeTarget = null;
    lastMergeAt = 0;
    syncUndoButtons();
  };

  const commitHistorySnapshot = () => {
    if (restoringHistory || !graph) return;
    const nowSnap = captureSnap();
    if (!nowSnap) return;
    if (!lastCommittedSnap) {
      lastCommittedSnap = nowSnap;
      return;
    }
    if (nowSnap.json === lastCommittedSnap.json) return;

    // Coalesce rapid continuous keystrokes inside the same inspector text input/textarea
    const activeEl = document.activeElement;
    const isTypingInInspector = Boolean(
      activeEl && inspector.contains(activeEl) &&
      (activeEl.tagName === 'TEXTAREA' || (activeEl.tagName === 'INPUT' && ['text', 'number', 'search', 'url'].includes(activeEl.type)))
    );
    const nowMs = Date.now();
    if (isTypingInInspector && lastMergeTarget === activeEl && (nowMs - lastMergeAt) < 650) {
      lastCommittedSnap = nowSnap;
      lastMergeAt = nowMs;
      return;
    }

    undoStack.push(lastCommittedSnap);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack = [];
    lastCommittedSnap = nowSnap;
    lastMergeTarget = isTypingInInspector ? activeEl : null;
    lastMergeAt = isTypingInInspector ? nowMs : 0;
    syncUndoButtons();
  };

  const applySnap = snap => {
    if (!graph || !snap) return;
    restoringHistory = true;
    try {
      const parsed = JSON.parse(snap.json);
      graph.nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
      graph.edges = Array.isArray(parsed.edges) ? parsed.edges : [];
      selectedNodeIds.clear();
      for (const id of (snap.selNodes || [])) {
        if (graph.nodes.some(n => n.id === id)) selectedNodeIds.add(id);
      }
      selectedEdgeId = graph.edges.some(e => e.id === snap.selEdge) ? snap.selEdge : '';
      if (!selectedNodeIds.size && !selectedEdgeId) inspectorOpen = false;
      lastCommittedSnap = captureSnap();
      lastMergeTarget = null;
      lastMergeAt = 0;
      ++editRevision;
      dirty = true;
      btnSave.classList.add('is-dirty');
      btnSave.textContent = '保存*';
      syncUndoButtons();
      renderAll();
    } finally {
      restoringHistory = false;
    }
  };

  const performUndo = () => {
    if (!graph || !undoStack.length) return;
    const cur = captureSnap();
    const prev = undoStack.pop();
    if (cur) {
      redoStack.push(cur);
      if (redoStack.length > MAX_HISTORY) redoStack.shift();
    }
    applySnap(prev);
  };

  const performRedo = () => {
    if (!graph || !redoStack.length) return;
    const cur = captureSnap();
    const next = redoStack.pop();
    if (cur) {
      undoStack.push(cur);
      if (undoStack.length > MAX_HISTORY) undoStack.shift();
    }
    applySnap(next);
  };

  const markDirty = () => {
    commitHistorySnapshot();
    ++editRevision;
    dirty = true;
    btnSave.classList.add('is-dirty');
    btnSave.textContent = '保存*';
    renderWorkLinkBar();
  };

  const clearDirty = () => {
    dirty = false;
    btnSave.classList.remove('is-dirty');
    btnSave.textContent = '保存';
    lastCommittedSnap = captureSnap();
    renderWorkLinkBar();
  };

  const openGraphById = (id, { pushDrill = false, viaChipId = '' } = {}) => {
    const found = findGraphInLibrary(id);
    if (!found) return;
    graph = deepClone(found);
    selectedNodeIds.clear();
    selectedEdgeId = '';
    inspectorOpen = false;
    ctxMenu.hidden = true;
    clearDirty();
    resetHistory();
    if (pushDrill) {
      navStack.push({ id: found.id, kind: found.kind, name: found.name, viaChipId });
    } else {
      navStack = [{ id: found.id, kind: found.kind, name: found.name, viaChipId: '' }];
      if (!activeRun || activeRun.canvasId !== found.id) {
        showRunBar = false;
      }
    }
    renderAll();
    requestAnimationFrame(() => fitViewport());
  };

  // =========================================================================
  // Library & Server Synchronization
  // =========================================================================
  const loadLibrary = async ({ keepCurrent = true } = {}) => {
    if (!api) return;
    try {
      const data = await api('/api/dimension/canvas/library');
      library = {
        canvases: Array.isArray(data?.canvases) ? data.canvases : [],
        functions: Array.isArray(data?.functions) ? data.functions : [],
        modelPool: Array.isArray(data?.modelPool) ? data.modelPool : [],
        harnesses: Array.isArray(data?.harnesses) ? data.harnesses : [],
      };
      loaded = true;
      if (!graph || !keepCurrent || (!dirty && !findGraphInLibrary(graph.id))) {
        const first =
          library.canvases.find(c => c.id === 'tpl-action-info-flow') ||
          library.canvases.find(c => c.id === 'tpl-engineering-circuit') ||
          library.canvases[0] ||
          library.functions[0];
        if (first) openGraphById(first.id);
      } else {
        renderTopbar();
        if (inspectorOpen) renderInspector();
      }
    } catch (err) {
      notify(`加载模型画布库失败：${err?.message || err}`);
    }
  };

  const saveCurrentGraph = async ({ silent = false } = {}) => {
    if (!api || !graph) return false;
    const submitted = graph;
    const revision = editRevision;
    try {
      const res = await api('/api/dimension/canvas/save', {
        method: 'POST',
        body: JSON.stringify(graph),
      });
      if (res?.graph) {
        const saved = res.graph;
        const list = saved.kind === 'function' ? library.functions : library.canvases;
        const idx = list.findIndex(x => x.id === saved.id);
        if (idx >= 0) list[idx] = deepClone(saved);
        else list.push(deepClone(saved));
        if (graph !== submitted || editRevision !== revision) return false;
        graph = deepClone(saved);
        if (navStack.length) {
          navStack[navStack.length - 1].name = graph.name;
          navStack[navStack.length - 1].id = graph.id;
        }
        clearDirty();
        renderTopbar();
        if (!silent) notify(`已保存${graph.kind === 'function' ? '组合步骤' : '流程蓝图'}「${graph.name}」`);
        return true;
      }
      return false;
    } catch (err) {
      notify(`保存校验未通过：${err?.message || err}`);
      return false;
    }
  };

  const mayLeaveGraph = async () => {
    if (!dirty) return true;
    if (leaving) return false;
    leaving = true;
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label', '未保存的画布');
    dialog.append(el('p', '', '当前画布有未保存的修改。'));
    for (const [label, value] of [['保存并切换', 'save'], ['放弃修改', 'discard'], ['留在当前画布', 'stay']]) {
      const button = el('button', 'mc-btn', label);
      button.onclick = () => dialog.close(value);
      dialog.append(button);
    }
    document.body.append(dialog);
    try {
      const decision = new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
      dialog.showModal();
      const choice = await decision;
      return choice === 'discard' || (choice === 'save' && await saveCurrentGraph({ silent: true }));
    } finally {
      dialog.remove();
      leaving = false;
    }
  };

  const stopPolling = () => {
    ++pollGeneration;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  };

  const schedulePoll = delay => {
    stopPolling();
    if (visible) pollTimer = setTimeout(pollActiveRun, delay);
  };

  const pollActiveRun = async () => {
    const generation = pollGeneration;
    const runId = activeRun?.runId;
    const current = () => visible && generation === pollGeneration && runId === activeRun?.runId;
    if (!current()) return;
    if (!api || !activeRun?.runId) return;
    try {
      const res = await api(`/api/dimension/canvas/runs/${encodeURIComponent(activeRun.runId)}`);
      if (!current()) return;
      if (res?.run) {
        const prevStatus = activeRun.status;
        activeRun = res.run;
        renderRunChrome();
        renderNodesAndEdges();
        if (inspectorOpen) renderInspector();
        if (activeRun.status === 'running' || activeRun.status === 'waiting_approval') {
          schedulePoll(700);
        } else {
          stopPolling();
          if (linkedWork && linkedWork.canvasId === activeRun.canvasId) {
            linkedWork = { ...linkedWork, executing: false };
            renderWorkLinkBar();
          }
          if (prevStatus !== activeRun.status) {
            if (activeRun.status === 'completed') notify(`流程「${activeRun.canvasName}」已执行完成！`);
            else if (activeRun.status === 'failed') notify(`流程执行失败：${activeRun.error || '请点击步骤查看详情'}`);
          }
        }
      }
    } catch {
      if (current()) schedulePoll(1500);
    }
  };

  const startCircuitRun = async (inputText) => {
    if (!api || !graph || starting || ['running', 'waiting_approval'].includes(activeRun?.status)) return;
    starting = true;
    renderRunChrome();
    try {
      if (navStack.length > 1) {
        // Save inner function first, then jump back to root canvas to execute!
        if (dirty) {
          const ok = await saveCurrentGraph({ silent: true });
          if (!ok) return;
        }
        openGraphById(navStack[0].id);
      } else if (dirty) {
        const ok = await saveCurrentGraph({ silent: true });
        if (!ok) return;
      }
      const task = {
        canvasId: graph.id,
        inputText: String(inputText || '').trim() || '请按当前 DimensionImage 蓝图流程执行本轮任务',
        workspaceDir: getProjectCwd?.() || '',
        botId: getActiveBotId?.() || '',
      };
      const signature = JSON.stringify(task);
      if (pendingStart?.signature !== signature) pendingStart = { signature, id: crypto.randomUUID() };
      const res = await api('/api/dimension/canvas/runs', {
        method: 'POST',
        body: JSON.stringify({ ...task, requestId: pendingStart.id }),
      });
      if (res?.run) {
        pendingStart = null;
        activeRun = res.run;
        renderRunChrome();
        renderNodesAndEdges();
        schedulePoll(500);
      }
    } catch (err) {
      notify(`启动蓝图流程失败：${err?.message || err}`);
    } finally {
      starting = false;
      renderRunChrome();
    }
  };

  const submitGateDecision = async (gateKey, approved, comment) => {
    if (!api || !activeRun?.runId) return;
    try {
      const res = await api(`/api/dimension/canvas/runs/${encodeURIComponent(activeRun.runId)}/gate`, {
        method: 'POST',
        body: JSON.stringify({ gateKey, approved: Boolean(approved), comment: String(comment || '') }),
      });
      if (res?.run) {
        activeRun = res.run;
        renderRunChrome();
        renderNodesAndEdges();
        schedulePoll(400);
      }
    } catch (err) {
      notify(`审批操作失败：${err?.message || err}`);
    }
  };

  const cancelCurrentRun = async () => {
    if (!api || !activeRun?.runId) return;
    try {
      const res = await api(`/api/dimension/canvas/runs/${encodeURIComponent(activeRun.runId)}/cancel`, {
        method: 'POST',
        body: '{}',
      });
      if (res?.run) {
        activeRun = res.run;
        renderRunChrome();
        renderNodesAndEdges();
      }
    } catch (err) {
      notify(`停止失败：${err?.message || err}`);
    }
  };

  // =========================================================================
  // Edge Geometry (Main, Edge-Attached Parallel Supplement, Feedback Loop)
  // =========================================================================
  const getNodePortPos = (nodeId, portKind) => {
    const n = graph?.nodes.find(x => x.id === nodeId);
    if (!n) return { x: 0, y: 0 };
    const h = nodeDims.get(nodeId)?.h || NODE_H_DEFAULT;
    if (portKind === 'in') return { x: n.x - 8, y: n.y + h * 0.5 };
    if (n.type === 'gate') {
      if (portKind === 'loop') return { x: n.x + NODE_W + 9, y: n.y + h * 0.72 };
      return { x: n.x + NODE_W + 9, y: n.y + h * 0.34 }; // 'pass' / 'out'
    }
    return { x: n.x + NODE_W + 7, y: n.y + h * 0.5 };
  };

  const computeEdgeCurve = (edge, visited = new Set()) => {
    if (edgeCurves.has(edge.id)) return edgeCurves.get(edge.id);
    if (visited.has(edge.id)) return null;
    visited.add(edge.id);

    const p0 = getNodePortPos(edge.fromNodeId, edge.fromPort === 'loop' ? 'loop' : 'out');
    let p3;
    if (edge.targetKind === 'edge') {
      const hostEdge = graph.edges.find(e => e.id === edge.targetId);
      if (!hostEdge) return null;
      const hc = computeEdgeCurve(hostEdge, visited);
      if (!hc) return null;
      p3 = cubicPoint(hc.p0, hc.p1, hc.p2, hc.p3, Math.max(0.15, Math.min(0.85, Number(edge.attachT ?? 0.5))));
    } else {
      p3 = getNodePortPos(edge.targetId, 'in');
    }

    let p1, p2;
    const isLoop = edge.wireKind === 'feedback' || edge.fromPort === 'loop';
    if (isLoop && p3.x <= p0.x + 24) {
      // Smooth rounded U-circuit loop routed cleanly below any intermediate nodes,
      // entering target input port horizontally from the left!
      const spanMinX = Math.min(p0.x, p3.x) - 56;
      const spanMaxX = Math.max(p0.x, p3.x) + 56;
      let clearBottom = Math.max(p0.y, p3.y) + 74;
      for (const n of (graph?.nodes || [])) {
        const nh = nodeDims.get(n.id)?.h || NODE_H_DEFAULT;
        if (n.x + NODE_W >= spanMinX && n.x <= spanMaxX) {
          clearBottom = Math.max(clearBottom, n.y + nh + 44);
        }
      }
      const lowY = Math.round(clearBottom);
      const rOutX = Math.round(p0.x + 34);
      const lInX = Math.round(p3.x - 38);
      const rad = 22;
      const pathD = [
        `M ${p0.x} ${p0.y}`,
        `L ${rOutX - rad} ${p0.y}`,
        `Q ${rOutX} ${p0.y}, ${rOutX} ${p0.y + rad}`,
        `L ${rOutX} ${lowY - rad}`,
        `Q ${rOutX} ${lowY}, ${rOutX - rad} ${lowY}`,
        `L ${lInX + rad} ${lowY}`,
        `Q ${lInX} ${lowY}, ${lInX} ${lowY - rad}`,
        `L ${lInX} ${p3.y + rad}`,
        `Q ${lInX} ${p3.y}, ${lInX + rad} ${p3.y}`,
        `L ${p3.x} ${p3.y}`,
      ].join(' ');
      p1 = { x: rOutX, y: lowY };
      p2 = { x: lInX, y: lowY };
      const curve = {
        p0, p1, p2, p3,
        isLoop: true,
        lowY,
        pathD,
        labelPt: { x: Math.round((rOutX + lInX) / 2), y: lowY },
      };
      edgeCurves.set(edge.id, curve);
      return curve;
    } else if (edge.targetKind === 'edge') {
      // Smooth tributary curving neatly into the target edge's junction dot
      const dy = p3.y - p0.y;
      const dx = p3.x - p0.x;
      p1 = { x: p0.x + Math.max(44, Math.abs(dx) * 0.45), y: p0.y };
      p2 = { x: p3.x, y: p3.y - Math.sign(dy || 1) * Math.max(42, Math.abs(dy) * 0.45) };
    } else {
      const dx = Math.max(44, Math.abs(p3.x - p0.x) * 0.46);
      p1 = { x: p0.x + dx, y: p0.y };
      p2 = { x: p3.x - dx, y: p3.y };
    }

    const curve = { p0, p1, p2, p3 };
    edgeCurves.set(edge.id, curve);
    return curve;
  };

  const curvePathD = c => c.pathD || `M ${c.p0.x} ${c.p0.y} C ${c.p1.x} ${c.p1.y}, ${c.p2.x} ${c.p2.y}, ${c.p3.x} ${c.p3.y}`;

  // =========================================================================
  // Render Topbar, Breadcrumbs, Add Menu, Run Bar, Approval Banner
  // =========================================================================
  const renderTopbar = () => {
    crumbBar.replaceChildren();
    if (navStack.length > 1) {
      for (let i = 0; i < navStack.length; i++) {
        if (i > 0) crumbBar.append(el('span', 'mc-crumb-sep', '▸'));
        const item = navStack[i];
        const b = el('button', `mc-crumb-btn${i === navStack.length - 1 ? ' is-cur' : ''}`,
          `${item.kind === 'function' ? '📦 ' : ''}${item.name}`);
        b.type = 'button';
        b.onclick = async () => {
          if (i === navStack.length - 1 || !await mayLeaveGraph()) return;
          navStack = navStack.slice(0, i + 1);
          const g = findGraphInLibrary(item.id);
          if (g) {
            graph = deepClone(g);
            selectedNodeIds.clear();
            selectedEdgeId = '';
            inspectorOpen = false;
            clearDirty();
            renderAll();
            requestAnimationFrame(() => fitViewport());
          }
        };
        crumbBar.append(b);
      }
      tplSelect.hidden = true;
      btnNew.hidden = true;
    } else {
      tplSelect.hidden = false;
      btnNew.hidden = false;
      tplSelect.replaceChildren();
      const grpC = document.createElement('optgroup');
      grpC.label = 'DimensionImage 流程蓝图';
      for (const c of (library.canvases || [])) {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = `${c.builtin ? '✦ ' : ''}${c.name}`;
        grpC.append(opt);
      }
      tplSelect.append(grpC);

      if ((library.functions || []).length) {
        const grpF = document.createElement('optgroup');
        grpF.label = '📦 已打包的常用组合步骤（双击展开编辑）';
        for (const f of library.functions) {
          const opt = document.createElement('option');
          opt.value = f.id;
          opt.textContent = `📦 ${f.name}`;
          grpF.append(opt);
        }
        tplSelect.append(grpF);
      }
      if (graph) tplSelect.value = graph.id;
    }

    const collapsibleCount = [...selectedNodeIds].filter(id => {
      const n = graph?.nodes.find(x => x.id === id);
      return n && n.type !== 'input';
    }).length;
    btnCollapse.disabled = collapsibleCount === 0;
    btnCollapse.textContent = collapsibleCount > 0 ? `📦 打包组合 (${collapsibleCount})` : '📦 打包组合';
    renderWorkLinkBar();
  };

  const renderAddMenu = () => {
    addMenu.replaceChildren();
    addMenu.append(el('div', 'mc-add-sec', '⚡ 常用自动化动作'));
    const actionItems = [
      { type: 'action', actionKind: 'open_app', title: '打开软件 / 文件夹', desc: '启动本机软件、打开文档或项目文件夹' },
      { type: 'action', actionKind: 'open_url', title: '打开网页', desc: '打开指定网站或本地预览链接' },
      { type: 'action', actionKind: 'read_file', title: '读取文件 / 目录', desc: '实时读取本地文件内容或文件夹清单' },
      { type: 'action', actionKind: 'fetch_url', title: '获取网页信息', desc: '抓取指定网址或接口的正文内容给下一步' },
      { type: 'action', actionKind: 'run_command', title: '运行命令 / 脚本', desc: '在项目目录执行自定义命令并获取输出' },
      { type: 'reference', title: '读取文本资料 (.txt)', desc: '粘贴说明或挂本地 txt，连到箭头上即可顺带补充' },
    ];
    for (const it of actionItems) {
      const row = el('button', 'mc-add-item');
      row.type = 'button';
      const ico = it.actionKind ? ACTION_KIND_META[it.actionKind].icon : NODE_TYPE_META[it.type].icon;
      row.append(el('strong', '', `${ico} ${it.title}`), el('span', '', it.desc));
      row.onclick = () => {
        addNodeToCanvas(it.type, it.actionKind ? { actionKind: it.actionKind, title: it.title } : {});
        addMenu.hidden = true;
      };
      addMenu.append(row);
    }

    addMenu.append(el('div', 'mc-add-sec', '🔀 布尔与逻辑条件'));
    const logicItems = [
      { type: 'gate', gateMode: 'bool_switch', boolSource: 'fixed', boolValue: true, title: '布尔值（真 / 假）', desc: '固定开关真/假，或自动判断上游真假（支持取反）' },
      { type: 'gate', gateMode: 'logic_and', conditionRules: [{ op: 'not_empty', value: '' }, { op: 'is_true', value: '' }], title: '和 / 且条件 (AND)', desc: '全部条件或所有上游都满足才继续，否则走备用/重做' },
      { type: 'gate', gateMode: 'logic_or', conditionRules: [{ op: 'contains', value: 'PASS' }, { op: 'contains', value: '完成' }], title: '或条件 (OR)', desc: '只要任意一条条件或任意一路上游满足就继续' },
    ];
    for (const it of logicItems) {
      const row = el('button', 'mc-add-item');
      row.type = 'button';
      const ico = it.gateMode === 'bool_switch' ? '🔘' : it.gateMode === 'logic_and' ? '∧' : '∨';
      row.append(el('strong', '', `${ico} ${it.title}`), el('span', '', it.desc));
      row.onclick = () => {
        addNodeToCanvas('gate', {
          title: it.title,
          gateMode: it.gateMode,
          boolSource: it.boolSource || 'auto',
          boolValue: it.boolValue ?? true,
          invertResult: false,
          conditionRules: it.conditionRules ? deepClone(it.conditionRules) : [],
        });
        addMenu.hidden = true;
      };
      addMenu.append(row);
    }

    addMenu.append(el('div', 'mc-add-sec', '✦ AI 伙伴与流程控制'));
    const flowItems = [
      { type: 'agent', title: '让伙伴处理', desc: '选用常驻伙伴或新建临时角色 · 支持模型 / 沙盒 CLI' },
      { type: 'compress', title: '提炼整理信息', desc: '把前面内容提炼成精简要点或交接单，不爆上下文' },
      { type: 'gate', title: '等我确认 / 自动检查', desc: '停下来等我点通过/重做，或按关键词自动返工' },
      { type: 'input', title: '开始步骤', desc: '整个流程或组合步骤的起点' },
    ];
    for (const it of flowItems) {
      const row = el('button', 'mc-add-item');
      row.type = 'button';
      row.append(el('strong', '', `${NODE_TYPE_META[it.type].icon} ${it.title}`), el('span', '', it.desc));
      row.onclick = () => {
        addNodeToCanvas(it.type);
        addMenu.hidden = true;
      };
      addMenu.append(row);
    }
    if ((library.functions || []).length) {
      addMenu.append(el('div', 'mc-add-sec', '📦 插入常用组合步骤'));
      for (const fn of library.functions) {
        if (graph?.kind === 'function' && fn.id === graph.id) continue;
        const row = el('button', 'mc-add-item is-fn');
        row.type = 'button';
        row.append(el('strong', '', `📦 ${fn.name}`), el('span', '', fn.description || `包含 ${(fn.nodes || []).length} 个内部步骤 · 双击可展开查看`));
        row.onclick = () => {
          addNodeToCanvas('function_call', { functionId: fn.id, title: fn.name });
          addMenu.hidden = true;
        };
        addMenu.append(row);
      }
    }
  };

  const addNodeToCanvas = (type, extra = {}) => {
    if (!graph) return;
    const vr = viewport.getBoundingClientRect();
    const cx = Math.round(((vr.width * 0.45) - panX) / zoom);
    const cy = Math.round(((vr.height * 0.42) - panY) / zoom);
    const jitter = (graph.nodes.length % 5) * 26;
    const hasExactPos = typeof extra.x === 'number' && typeof extra.y === 'number';
    const base = {
      id: uid('n'),
      type,
      title: extra.title || NODE_TYPE_META[type]?.label || '新步骤',
      x: hasExactPos ? Math.max(20, Math.round(extra.x / 8) * 8) : Math.max(40, cx + jitter),
      y: hasExactPos ? Math.max(20, Math.round(extra.y / 8) * 8) : Math.max(40, cy + jitter),
      botMode: 'existing',
      botId: getActiveBotId?.() || (getBots?.()?.[0]?.id || 'ai-claude'),
      inlineName: '',
      inlinePersona: '',
      engineKind: 'api',
      providerId: '',
      model: '',
      cliEngineId: 'auto',
      cliModelSource: 'work',
      cliNativeProvider: '',
      cliNativeModel: '',
      reasoningEffort: '',
      readOnly: type === 'compress',
      prompt: '',
      contextMode: 'handoff',
      includeMemory: false,
      refMode: 'text',
      actionKind: extra.actionKind || 'read_file',
      actionTarget: '',
      actionArgs: '',
      actionTimeoutSec: 30,
      boolSource: extra.boolSource || 'auto',
      boolValue: extra.boolValue !== undefined ? Boolean(extra.boolValue) : true,
      invertResult: Boolean(extra.invertResult),
      conditionRules: Array.isArray(extra.conditionRules) ? extra.conditionRules : [],
      refText: '',
      filePath: '',
      maxInlineChars: 12000,
      forceFullText: false,
      compressMode: 'handoff_card',
      maxOutputChars: 2400,
      gateMode: extra.gateMode || 'approval',
      passKeyword: 'PASS',
      failKeyword: 'FAIL',
      maxIterations: 3,
      approvalHint: '',
      functionId: extra.functionId || '',
      paramNote: '',
    };
    graph.nodes.push(base);
    selectedNodeIds.clear();
    selectedNodeIds.add(base.id);
    selectedEdgeId = '';
    inspectorOpen = extra.openInspector !== undefined ? Boolean(extra.openInspector) : true;
    markDirty();
    renderAll();
    return base;
  };

  // =========================================================================
  // Quick Selection Operations (Duplicate, Delete) & Topological Auto-Layout
  // =========================================================================
  const deleteEdgeById = edgeId => {
    if (!graph || !edgeId) return;
    graph.edges = graph.edges.filter(x => x.id !== edgeId && !(x.targetKind === 'edge' && x.targetId === edgeId));
    if (selectedEdgeId === edgeId) selectedEdgeId = '';
    inspectorOpen = false;
    markDirty();
    renderAll();
  };

  const deleteNodesByIds = ids => {
    if (!graph || !ids.length) return;
    const removable = new Set(ids.filter(id => {
      const n = graph.nodes.find(x => x.id === id);
      return n && n.type !== 'input';
    }));
    if (!removable.size) {
      notify('起点步骤不可删除');
      return;
    }
    const removedEdges = new Set(
      graph.edges.filter(e => removable.has(e.fromNodeId) || (e.targetKind === 'node' && removable.has(e.targetId))).map(e => e.id)
    );
    graph.nodes = graph.nodes.filter(n => !removable.has(n.id));
    graph.edges = graph.edges.filter(e => !removedEdges.has(e.id) && !(e.targetKind === 'edge' && removedEdges.has(e.targetId)));
    for (const id of removable) selectedNodeIds.delete(id);
    if (removedEdges.has(selectedEdgeId)) selectedEdgeId = '';
    if (!selectedNodeIds.size && !selectedEdgeId) inspectorOpen = false;
    markDirty();
    renderAll();
  };

  const deleteCurrentSelection = () => {
    if (!graph) return;
    if (selectedEdgeId) {
      deleteEdgeById(selectedEdgeId);
      return;
    }
    if (selectedNodeIds.size) {
      deleteNodesByIds([...selectedNodeIds]);
    }
  };

  const duplicateSelectedNodes = (explicitIds = null) => {
    if (!graph) return;
    const srcIds = (explicitIds || [...selectedNodeIds]).filter(id => {
      const n = graph.nodes.find(x => x.id === id);
      return n && n.type !== 'input';
    });
    if (!srcIds.length) return;
    const idMap = new Map();
    const createdNodes = [];
    for (const sid of srcIds) {
      const orig = graph.nodes.find(x => x.id === sid);
      if (!orig) continue;
      const copy = deepClone(orig);
      copy.id = uid('n');
      copy.x = Math.round(((orig.x || 40) + 40) / 8) * 8;
      copy.y = Math.round(((orig.y || 40) + 40) / 8) * 8;
      if (copy.title && !copy.title.endsWith('副本')) copy.title = `${copy.title} 副本`;
      idMap.set(sid, copy.id);
      createdNodes.push(copy);
    }
    for (const cn of createdNodes) graph.nodes.push(cn);
    const edgeIdMap = new Map();
    for (const e of graph.edges.slice()) {
      if (e.targetKind === 'node' && idMap.has(e.fromNodeId) && idMap.has(e.targetId)) {
        const ce = deepClone(e);
        ce.id = uid('e');
        ce.fromNodeId = idMap.get(e.fromNodeId);
        ce.targetId = idMap.get(e.targetId);
        edgeIdMap.set(e.id, ce.id);
        graph.edges.push(ce);
      }
    }
    for (const e of graph.edges.slice()) {
      if (e.targetKind === 'edge' && idMap.has(e.fromNodeId) && edgeIdMap.has(e.targetId)) {
        const ce = deepClone(e);
        ce.id = uid('e');
        ce.fromNodeId = idMap.get(e.fromNodeId);
        ce.targetId = edgeIdMap.get(e.targetId);
        graph.edges.push(ce);
      }
    }
    selectedNodeIds.clear();
    for (const cn of createdNodes) selectedNodeIds.add(cn.id);
    selectedEdgeId = '';
    inspectorOpen = createdNodes.length === 1;
    markDirty();
    renderAll();
  };

  const autoLayoutGraph = () => {
    if (!graph || !graph.nodes.length) return;
    const nodes = graph.nodes;
    const edges = graph.edges || [];
    const nodeById = new Map(nodes.map(n => [n.id, n]));

    // Identify pure edge-attached supplement nodes so they anchor snugly under their host edge
    const suppEdgeBySource = new Map();
    const hasNodeOutgoing = new Set();
    const hasNodeIncoming = new Set();
    for (const e of edges) {
      if (e.targetKind === 'edge') {
        if (!suppEdgeBySource.has(e.fromNodeId)) suppEdgeBySource.set(e.fromNodeId, e);
      } else if (e.targetKind === 'node') {
        if (e.wireKind !== 'feedback' && e.fromPort !== 'loop') {
          hasNodeOutgoing.add(e.fromNodeId);
          hasNodeIncoming.add(e.targetId);
        }
      }
    }
    const suppOnlyIds = new Set();
    for (const [sid] of suppEdgeBySource) {
      const n = nodeById.get(sid);
      if (n && n.type !== 'input' && !hasNodeOutgoing.has(sid) && !hasNodeIncoming.has(sid)) {
        suppOnlyIds.add(sid);
      }
    }

    // Build forward DAG adjacency (including forward Else branches that cannot loop back to source)
    const fwdOut = new Map();
    const fwdIn = new Map();
    const mainAdj = new Map();
    for (const n of nodes) {
      fwdOut.set(n.id, []);
      fwdIn.set(n.id, []);
      mainAdj.set(n.id, []);
    }
    for (const e of edges) {
      if (e.targetKind === 'node' && e.wireKind !== 'feedback' && e.fromPort !== 'loop') {
        mainAdj.get(e.fromNodeId)?.push(e.targetId);
      }
    }
    const canReachMain = (start, goal) => {
      const vis = new Set([start]);
      const q = [start];
      while (q.length) {
        const u = q.shift();
        if (u === goal) return true;
        for (const v of (mainAdj.get(u) || [])) {
          if (!vis.has(v)) { vis.add(v); q.push(v); }
        }
      }
      return false;
    };
    const isForwardEdge = e => {
      if (e.targetKind !== 'node') return false;
      if (e.wireKind !== 'feedback' && e.fromPort !== 'loop') return true;
      return !canReachMain(e.targetId, e.fromNodeId);
    };
    for (const e of edges) {
      if (!isForwardEdge(e) || suppOnlyIds.has(e.fromNodeId) || suppOnlyIds.has(e.targetId)) continue;
      fwdOut.get(e.fromNodeId)?.push({ to: e.targetId, isElse: e.fromPort === 'loop' || e.wireKind === 'feedback' });
      fwdIn.get(e.targetId)?.push({ from: e.fromNodeId, isElse: e.fromPort === 'loop' || e.wireKind === 'feedback' });
    }

    // Longest-path topological layering for primary nodes
    const layer = new Map();
    for (const n of nodes) {
      if (suppOnlyIds.has(n.id)) continue;
      layer.set(n.id, n.type === 'input' ? 0 : (fwdIn.get(n.id)?.length ? 1 : 0));
    }
    for (let iter = 0; iter < nodes.length; iter++) {
      let changed = false;
      for (const [u, outs] of fwdOut) {
        if (!layer.has(u)) continue;
        const lu = layer.get(u);
        for (const { to } of outs) {
          if (!layer.has(to)) continue;
          if (layer.get(to) < lu + 1) {
            layer.set(to, lu + 1);
            changed = true;
          }
        }
      }
      if (!changed) break;
    }

    const cols = new Map();
    for (const n of nodes) {
      if (!layer.has(n.id)) continue;
      const l = layer.get(n.id);
      if (!cols.has(l)) cols.set(l, []);
      cols.get(l).push(n);
    }

    // Order each column by barycenter of upstream Y + pass(top)/else(bottom) fork bias
    const sortedLayers = [...cols.keys()].sort((a, b) => a - b);
    const rankInLayer = new Map();
    const COL_STEP_X = 278;
    const ROW_GAP_Y = 44;
    const CENTER_Y = 230;
    const START_X = 48;

    for (const l of sortedLayers) {
      const list = cols.get(l);
      list.sort((a, b) => {
        const score = n => {
          const ins = fwdIn.get(n.id) || [];
          if (!ins.length) return (n.y || 0) / 1000;
          let sum = 0;
          for (const { from, isElse } of ins) {
            const pr = rankInLayer.get(from) ?? 0;
            sum += pr + (isElse ? 0.45 : -0.15);
          }
          return sum / ins.length;
        };
        const da = score(a), db = score(b);
        if (Math.abs(da - db) > 0.01) return da - db;
        return (a.y || 0) - (b.y || 0);
      });
      const heights = list.map(n => nodeDims.get(n.id)?.h || NODE_H_DEFAULT);
      const totalH = heights.reduce((acc, h) => acc + h, 0) + Math.max(0, list.length - 1) * ROW_GAP_Y;
      let curY = CENTER_Y - totalH / 2;
      for (let i = 0; i < list.length; i++) {
        list[i].x = START_X + l * COL_STEP_X;
        list[i].y = Math.round(curY / 8) * 8;
        rankInLayer.set(list[i].id, i - (list.length - 1) / 2);
        curY += heights[i] + ROW_GAP_Y;
      }
    }

    // Place pure edge-attached supplement nodes cleanly below their host edge source without colliding
    const edgeById = new Map(edges.map(e => [e.id, e]));
    const placedRects = nodes.filter(n => !suppOnlyIds.has(n.id)).map(n => ({
      x: n.x, y: n.y, w: NODE_W, h: nodeDims.get(n.id)?.h || NODE_H_DEFAULT,
    }));
    const collides = (x, y, h) => placedRects.some(r =>
      x < r.x + r.w + 26 && x + NODE_W + 26 > r.x && y < r.y + r.h + 30 && y + h + 30 > r.y
    );
    for (const sid of suppOnlyIds) {
      const n = nodeById.get(sid);
      const se = suppEdgeBySource.get(sid);
      const hostEdge = se ? edgeById.get(se.targetId) : null;
      const hostFrom = hostEdge ? nodeById.get(hostEdge.fromNodeId) : null;
      const nh = nodeDims.get(sid)?.h || NODE_H_DEFAULT;
      let tx = hostFrom ? Math.round((hostFrom.x + 24) / 8) * 8 : START_X + COL_STEP_X;
      let ty = hostFrom ? Math.round((hostFrom.y + (nodeDims.get(hostFrom.id)?.h || NODE_H_DEFAULT) + 60) / 8) * 8 : CENTER_Y + 148;
      let guard = 0;
      while (collides(tx, ty, nh) && guard < 16) {
        ty += 48;
        guard++;
      }
      n.x = tx;
      n.y = ty;
      placedRects.push({ x: tx, y: ty, w: NODE_W, h: nh });
    }

    let minY = Infinity;
    for (const n of nodes) minY = Math.min(minY, n.y);
    if (minY < 48) {
      const shiftY = Math.ceil((48 - minY) / 8) * 8;
      for (const n of nodes) n.y += shiftY;
    }

    markDirty();
    renderAll();
    requestAnimationFrame(() => fitViewport());
    notify('✨ 已自动整理蓝图排版（可 Ctrl+Z 撤回）');
  };

  const renderRunChrome = () => {
    const curRun = getRunForCurrentGraph();
    const running = Boolean(curRun && (curRun.status === 'running' || curRun.status === 'waiting_approval'));
    btnCancelRun.hidden = !running;
    btnRunToggle.textContent = showRunBar ? '收起运行栏' : (running ? '● 运行中' : '▶ 运行');

    // Render Run Input & Status Bar
    runBar.replaceChildren();
    if (showRunBar || running) {
      runBar.hidden = false;
      const row = el('div', 'mc-runbar-row');
      const inp = el('input', 'mc-run-input');
      inp.type = 'text';
      inp.placeholder = '输入本次要交给 DimensionImage 执行的目标需求…';
      inp.value = runInputDraft;
      inp.oninput = () => { runInputDraft = inp.value; };
      inp.onkeydown = e => {
        if (e.key === 'Enter' && !running) {
          e.preventDefault();
          void startCircuitRun(inp.value);
        }
      };

      const pullBtn = el('button', 'mc-btn', '取左侧需求');
      pullBtn.type = 'button';
      pullBtn.onclick = () => {
        const latest = getLatestUserInput?.() || '';
        if (latest) {
          runInputDraft = latest;
          inp.value = latest;
        } else {
          notify('左侧对话暂无可引用的输入文本');
        }
      };

      const goBtn = el('button', 'mc-btn is-primary', running ? '流程执行中…' : '▶ 开始执行');
      goBtn.type = 'button';
      goBtn.disabled = Boolean(running) || starting;
      goBtn.onclick = () => void startCircuitRun(inp.value);

      row.append(inp, pullBtn, goBtn);
      runBar.append(row);

      if (curRun) {
        const stRow = el('div', 'mc-run-status');
        const badge = el('span', `mc-run-badge is-${curRun.status}`);
        const mapLabel = {
          running: '▶ 执行中',
          waiting_approval: '⏸ 等待确认',
          completed: '✔ 已完成',
          failed: '✖ 执行失败',
          cancelled: '○ 已停止',
        };
        badge.textContent = mapLabel[curRun.status] || curRun.status;
        let lastLog = (curRun.logs || []).slice(-1)[0] || '';
        if (!curRun.error && lastLog) {
          lastLog = lastLog
            .replace(/^(⏸\s*)?(等待人工审批|等待确认)\s*[:：]?\s*/, '')
            .replace(/^▶\s*节点启动\s*[:：]?\s*/, '正在执行 ')
            .trim();
        }
        const logTxt = el('span', 'mc-run-log-tail', curRun.error || lastLog);
        stRow.append(badge, logTxt);
        if (curRun.finishedAt && curRun.createdAt) {
          const seconds = ((curRun.finishedAt-curRun.createdAt)/1000).toFixed(1);
          const review = curRun.gateReviews > 0
            ? `人工审批 ${curRun.gateReviews} 次 · 退回 ${curRun.gateRejections} 次`
            : '无人工验收记录';
          stRow.append(el('span','mc-muted',`总耗时 ${seconds} 秒 · ${review}`));
        }
        runBar.append(stRow);
      }
    } else {
      runBar.hidden = true;
    }

    // Floating Approval Banner for any waiting human gate (scoped to current graph!)
    const waiting = Array.isArray(curRun?.waitingGates) ? curRun.waitingGates : [];
    if (waiting.length && curRun?.status === 'waiting_approval') {
      const gate = waiting[0];
      approvalBanner.hidden = false;
      approvalBanner.classList.toggle('is-collapsed', approvalCollapsed);
      approvalBanner.replaceChildren();
      const head = el('div', 'mc-apv-head');
      const headRight = el('div', 'mc-apv-head-right');
      const toggleApvBtn = el('button', 'mc-apv-toggle', approvalCollapsed ? '▴ 展开确认' : '▾ 暂收看图');
      toggleApvBtn.type = 'button';
      toggleApvBtn.onclick = () => {
        approvalCollapsed = !approvalCollapsed;
        renderRunChrome();
      };
      headRight.append(
        el('span', 'mc-apv-iter', `第 ${gate.iteration || 1}/${gate.maxIterations || 3} 轮`),
        toggleApvBtn
      );
      head.append(
        el('strong', '', `✔ 等待你的确认：${gate.title}${gate.framePrefix ? '（组合步骤内）' : ''}`),
        headRight
      );
      approvalBanner.append(head);
      if (!approvalCollapsed) {
        if (gate.approvalHint) {
          approvalBanner.append(el('p', 'mc-apv-hint', gate.approvalHint));
        }
        if (gate.output) {
          const prev = el('pre', 'mc-apv-preview thin-scroll', gate.output.slice(0, 900) + (gate.output.length > 900 ? '\n…（点击该确认步骤查看完整内容）' : ''));
          approvalBanner.append(prev);
        }
        const ctrl = el('div', 'mc-apv-ctrl');
        const noteInp = el('input', 'mc-apv-input');
        noteInp.type = 'text';
        noteInp.placeholder = '可选填补充说明，或不满意时写下修改意见…';
        const passBtn = el('button', 'mc-btn is-pass', '✓ 通过继续');
        passBtn.type = 'button';
        passBtn.onclick = () => void submitGateDecision(gate.key, true, noteInp.value);
        const rejectBtn = el('button', 'mc-btn is-loop', '↻ 不满意重做');
        rejectBtn.type = 'button';
        rejectBtn.onclick = () => void submitGateDecision(gate.key, false, noteInp.value || '请按要求修改重做');
        ctrl.append(noteInp, rejectBtn, passBtn);
        approvalBanner.append(ctrl);
      }
    } else {
      approvalCollapsed = false;
      approvalBanner.hidden = true;
    }
  };

  // =========================================================================
  // Render SVG Wires, Junction Dots & HTML Node Chips
  // =========================================================================
  const renderEdgesOnly = () => {
    edgesGroup.replaceChildren();
    junctionsGroup.replaceChildren();
    previewGroup.replaceChildren();
    edgeCurves.clear();
    if (!graph) return;

    // 1. Compute curves (main edges first so edge-attached supplements resolve accurately)
    for (const e of graph.edges) {
      if (e.targetKind !== 'edge') computeEdgeCurve(e);
    }
    for (const e of graph.edges) {
      if (e.targetKind === 'edge') computeEdgeCurve(e);
    }

    // Map host edges that have edge-attached junction dots so labels avoid colliding with dots
    const attachedTsByHost = new Map();
    for (const e of graph.edges) {
      if (e.targetKind === 'edge' && e.targetId) {
        const list = attachedTsByHost.get(e.targetId) || [];
        list.push(Number(e.attachT ?? 0.5));
        attachedTsByHost.set(e.targetId, list);
      }
    }

    // 2. Render each wire + generous invisible hit-path for clicking & edge-attachment drop!
    for (const e of graph.edges) {
      const c = edgeCurves.get(e.id);
      if (!c) continue;
      const d = curvePathD(c);
      const isLoop = e.wireKind === 'feedback' || e.fromPort === 'loop';
      const isSupp = e.targetKind === 'edge' || e.wireKind === 'supplement';
      const isSel = selectedEdgeId === e.id;
      const isPulse = isEdgeActivePulse(e.id);
      const isHoverAttach = wireDrag && wireDrag.hoverEdgeId === e.id;

      const g = svgEl('g', {
        class: `mc-edge-g${isLoop ? ' is-loop' : isSupp ? ' is-supp' : ' is-main'}${isSel ? ' is-selected' : ''}${isPulse ? ' is-pulse' : ''}${isHoverAttach ? ' is-attach-hover' : ''}`,
        'data-edge-id': e.id,
      });

      const hit = svgEl('path', { class: 'mc-edge-hit', d, fill: 'none', 'stroke-width': 18 });
      hit.addEventListener('click', ev => {
        ev.stopPropagation();
        selectedNodeIds.clear();
        selectedEdgeId = e.id;
        inspectorOpen = true;
        renderAll();
      });

      const visAttrs = { class: 'mc-edge-path', d, fill: 'none' };
      // Edge-attached supplements terminate cleanly in a glowing junction dot (no duplicate marker!)
      if (!(isSupp && e.targetKind === 'edge')) {
        visAttrs['marker-end'] = isLoop ? 'url(#mcArrowLoop)' : 'url(#mcArrowMain)';
      }
      const vis = svgEl('path', visAttrs);
      g.append(hit, vis);

      // Smart anti-collision pill placement:
      // - Loops center cleanly along bottom straight segment
      // - Edge-attached supplements sit near source (t=0.32) away from junction dot & bottom loops
      // - Host edges carrying a junction dot shift pill upward/clear of the dot; ultra-short spans omit pill unless selected
      const spanDist = Math.hypot(c.p3.x - c.p0.x, c.p3.y - c.p0.y);
      const hostDots = attachedTsByHost.get(e.id) || [];
      let labelPt;
      if (c.labelPt) {
        labelPt = c.labelPt;
      } else if (isSupp) {
        labelPt = cubicPoint(c.p0, c.p1, c.p2, c.p3, 0.50);
      } else if (hostDots.length) {
        const avgDot = hostDots.reduce((a, b) => a + b, 0) / hostDots.length;
        const base = cubicPoint(c.p0, c.p1, c.p2, c.p3, avgDot >= 0.45 ? 0.38 : 0.62);
        labelPt = { x: base.x, y: base.y - 20 };
      } else {
        labelPt = cubicPoint(c.p0, c.p1, c.p2, c.p3, 0.5);
      }

      const isBackLoop = isLoop && Boolean(c.isLoop);
      const loopCnt = isBackLoop ? getEdgeLoopCount(e.id) : 0;
      const fromN = graph.nodes.find(x => x.id === e.fromNodeId);
      const pillText = isBackLoop
        ? (loopCnt > 0 ? `↻ ${loopCnt}/${fromN?.maxIterations || 3}` : (e.label ? `↻ ${e.label}` : '↻ 重做'))
        : (isLoop ? (e.label || '✗ 不满足') : (e.label || ''));
      const showPill = Boolean(pillText) && (isLoop || isSupp || isSel || spanDist >= 72);
      if (showPill) {
        const fo = svgEl('foreignObject', {
          x: Math.round(labelPt.x - 62),
          y: Math.round(labelPt.y - 12),
          width: 124,
          height: 24,
          class: 'mc-edge-label-fo',
        });
        const pill = el('div', `mc-edge-pill${isLoop ? ' is-loop' : isSupp ? ' is-supp' : ''}`, pillText);
        fo.append(pill);
        g.append(fo);
      }

      edgesGroup.append(g);

      // Render glowing circuit junction dot ● where an edge-attached supplement joins its host wire!
      if (isSupp && e.targetKind === 'edge') {
        const jDot = svgEl('circle', {
          class: `mc-junction-dot${isSel ? ' is-selected' : ''}`,
          'data-edge-id': e.id,
          cx: c.p3.x,
          cy: c.p3.y,
          r: isSel ? 6.5 : 5.2,
        });
        jDot.addEventListener('click', ev => {
          ev.stopPropagation();
          selectedNodeIds.clear();
          selectedEdgeId = e.id;
          inspectorOpen = true;
          renderAll();
        });
        junctionsGroup.append(jDot);
      }
    }

    // 3. Render live preview wire during drag-to-connect
    if (wireDrag) {
      const p0 = { x: wireDrag.startX, y: wireDrag.startY };
      const p3 = { x: wireDrag.curX, y: wireDrag.curY };
      const isLoop = wireDrag.fromPort === 'loop';
      const dx = Math.max(46, Math.abs(p3.x - p0.x) * 0.45);
      const p1 = { x: p0.x + dx, y: p0.y };
      const p2 = { x: p3.x - dx, y: p3.y };
      const previewPath = svgEl('path', {
        class: `mc-edge-preview${isLoop ? ' is-loop' : wireDrag.hoverEdgeId ? ' is-supp' : ''}`,
        d: curvePathD({ p0, p1, p2, p3 }),
        fill: 'none',
      });
      previewGroup.append(previewPath);

      if (wireDrag.hoverEdgeId && edgeCurves.has(wireDrag.hoverEdgeId)) {
        const hc = edgeCurves.get(wireDrag.hoverEdgeId);
        const jp = cubicPoint(hc.p0, hc.p1, hc.p2, hc.p3, wireDrag.hoverT);
        previewGroup.append(svgEl('circle', { class: 'mc-junction-preview', cx: jp.x, cy: jp.y, r: 7 }));
      }
    }
  };

  const summarizeNodeSubtitle = n => {
    if (n.type === 'input') return '流程起点 · 接收本次需求';
    if (n.type === 'action') {
      const am = ACTION_KIND_META[n.actionKind || 'read_file'] || ACTION_KIND_META.read_file;
      const tgt = (n.actionTarget || '').trim();
      return tgt ? `${am.label}：${tgt.length > 22 ? tgt.slice(0, 22) + '…' : tgt}` : `${am.label}（默认当前项目）`;
    }
    if (n.type === 'reference') {
      return n.refMode === 'file'
        ? (n.filePath ? `读取文档: ${n.filePath.split(/[\\/]/).pop()}` : '未选择 .txt 文件路径')
        : (n.refText ? `${n.refText.slice(0, 26)}${n.refText.length > 26 ? '…' : ''}` : '空白参考文本');
    }
    if (n.type === 'compress') {
      const m = n.compressMode === 'summary' ? '要点摘要' : n.compressMode === 'custom' ? '自定义整理' : '结构化交接单';
      return `${m} · ≤${n.maxOutputChars || 2400}字`;
    }
    if (n.type === 'gate') {
      const inv = n.invertResult ? ' · 取反' : '';
      if (n.gateMode === 'bool_switch') {
        if (n.boolSource === 'fixed') return `固定布尔：${n.boolValue ? '真 (True)' : '假 (False)'}${inv}`;
        return `自动判断上游真 / 假${inv}`;
      }
      if (n.gateMode === 'logic_and') {
        const cnt = (n.conditionRules || []).length;
        return cnt ? `全部满足（${cnt} 条条件）${inv}` : `全部上游均为真 (AND)${inv}`;
      }
      if (n.gateMode === 'logic_or') {
        const cnt = (n.conditionRules || []).length;
        return cnt ? `任一满足（${cnt} 条条件）${inv}` : `任一上游为真 (OR)${inv}`;
      }
      return n.gateMode === 'auto_condition'
        ? `自动检查 (${n.passKeyword || 'PASS'}) · 最多 ${n.maxIterations || 3}次`
        : `等我确认 · 最多重做 ${n.maxIterations || 3}次`;
    }
    if (n.type === 'function_call') {
      const fn = (library.functions || []).find(f => f.id === n.functionId);
      return fn ? `双击展开 · 含 ${(fn.nodes || []).length} 个子步骤` : '未选择组合步骤';
    }
    // Agent node
    const bots = getBots?.() || [];
    const roleLabel = n.botMode === 'inline'
      ? `临时:${n.inlineName || '未命名'}`
      : (bots.find(b => b.id === n.botId)?.name || n.botId || '未选伙伴');
    const engLabel = n.engineKind === 'cli'
      ? `CLI:${n.cliEngineId || 'auto'}`
      : (n.model || '维度 API');
    return `${roleLabel} · ${engLabel}`;
  };

  const renderNodesAndEdges = () => {
    nodesLayer.replaceChildren();
    if (!graph) {
      renderEdgesOnly();
      return;
    }

    const curRun = getRunForCurrentGraph();
    const runFinished = Boolean(curRun && ['completed', 'failed', 'cancelled'].includes(curRun.status));
    for (const n of graph.nodes) {
      const meta = NODE_TYPE_META[n.type] || NODE_TYPE_META.agent;
      const rs = getNodeRunState(n.id);
      const isSel = selectedNodeIds.has(n.id);
      const isHoverTarget = wireDrag && wireDrag.hoverNodeId === n.id;

      const isLogicNode = n.type === 'gate' && isLogicGateMode(n.gateMode);
      const cardTone = isLogicNode ? 'logic' : meta.tone;
      const isSkipped = runFinished && (!rs || rs.status === 'pending' || rs.status === 'skipped');
      const runCls = isSkipped ? ' is-run-skipped' : (rs ? ` is-run-${rs.status}` : '');
      const card = el('div', `mc-node is-tone-${cardTone}${isSel ? ' is-selected' : ''}${isHoverTarget ? ' is-wire-target' : ''}${runCls}`);
      card.dataset.nodeId = n.id;
      card.style.left = `${n.x}px`;
      card.style.top = `${n.y}px`;
      card.style.width = `${NODE_W}px`;

      // Header bar
      const head = el('div', 'mc-node-head');
      let badgeText = `${meta.icon} ${meta.short}`;
      if (n.type === 'action') {
        const ai = ACTION_KIND_META[n.actionKind || 'read_file']?.icon || meta.icon;
        badgeText = `${ai} ${meta.short}`;
      } else if (n.type === 'gate') {
        if (n.gateMode === 'bool_switch') badgeText = '🔘 布尔';
        else if (n.gateMode === 'logic_and') badgeText = '∧ 和/AND';
        else if (n.gateMode === 'logic_or') badgeText = '∨ 或/OR';
      }
      const badge = el('span', 'mc-node-badge', badgeText);
      const title = el('span', 'mc-node-title', n.title || meta.label);
      head.append(badge, title);
      if (rs && rs.iteration > 1) {
        head.append(el('span', 'mc-node-iter', `第${rs.iteration}轮`));
      }

      const bodyBox = el('div', 'mc-node-body');
      bodyBox.append(el('div', 'mc-node-sub', summarizeNodeSubtitle(n)));
      if (isSkipped) {
        bodyBox.append(el('div', 'mc-node-live is-skipped', '— 本轮未触发'));
      } else if (rs && rs.progressNote) {
        const gateCls = isLogicNode && rs.status === 'completed'
          ? (rs.gateDecision === 'loop' ? ' is-gate-false' : rs.gateDecision === 'pass' ? ' is-gate-true' : '')
          : '';
        bodyBox.append(el('div', `mc-node-live is-${rs.status}${gateCls}`, rs.progressNote));
      } else if (n.type === 'agent' && n.readOnly) {
        bodyBox.append(el('div', 'mc-node-tag', '只读分析'));
      } else if (n.type === 'function_call') {
        bodyBox.append(el('div', 'mc-node-tag is-fn', '可复用组合步骤'));
      }

      // Input Port (left side; also rendered as amber loop-in pin if an input/reference receives a feedback wire!)
      const hasLoopIncoming = graph.edges.some(e => e.targetKind === 'node' && e.targetId === n.id && (e.wireKind === 'feedback' || e.fromPort === 'loop'));
      if (n.type !== 'input' && n.type !== 'reference') {
        const inPort = el('div', 'mc-port is-in');
        inPort.title = '输入引脚';
        card.append(inPort);
      } else if (hasLoopIncoming) {
        const inPort = el('div', 'mc-port is-in is-loop-in');
        inPort.title = '闭环反馈接收引脚';
        card.append(inPort);
      }

      // Output Ports (right side)
      if (n.type === 'gate') {
        const passPort = el('button', 'mc-port is-out is-pass', '✓');
        passPort.type = 'button';
        passPort.title = isLogicNode ? '满足条件（真 True）时走这条路' : '通过确认后继续下一步';
        passPort.addEventListener('pointerdown', ev => startWireDrag(ev, n.id, 'pass'));

        const loopPort = el('button', 'mc-port is-out is-loop', isLogicNode ? '✗' : '↻');
        loopPort.type = 'button';
        loopPort.title = isLogicNode
          ? '不满足条件（假 False）时：连到下游走备用分支，或连回上游重做'
          : '不满意重做：拉线连回上游步骤重新执行';
        loopPort.addEventListener('pointerdown', ev => startWireDrag(ev, n.id, 'loop'));
        card.append(passPort, loopPort);
      } else {
        const outPort = el('button', 'mc-port is-out');
        outPort.type = 'button';
        outPort.title = '按住拖出连线：连到节点=主干直连；连到已有连线=并行补充支流';
        outPort.addEventListener('pointerdown', ev => startWireDrag(ev, n.id, 'out'));
        card.append(outPort);
      }

      card.append(head, bodyBox);

      // Node Dragging & Selection
      card.addEventListener('pointerdown', ev => {
        if (ev.target.closest('.mc-port')) return;
        if (ev.button !== 0) return;
        ev.stopPropagation();

        if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
          if (selectedNodeIds.has(n.id)) selectedNodeIds.delete(n.id);
          else selectedNodeIds.add(n.id);
          selectedEdgeId = '';
          inspectorOpen = selectedNodeIds.size === 1;
        } else {
          if (!selectedNodeIds.has(n.id) || selectedNodeIds.size > 1) {
            selectedNodeIds.clear();
            selectedNodeIds.add(n.id);
          }
          selectedEdgeId = '';
          inspectorOpen = true;
        }
        renderTopbar();
        renderInspector();

        // Drag selected nodes smoothly
        const startClientX = ev.clientX;
        const startClientY = ev.clientY;
        const origCoords = new Map();
        for (const sid of selectedNodeIds) {
          const sn = graph.nodes.find(x => x.id === sid);
          if (sn) origCoords.set(sid, { x: sn.x, y: sn.y });
        }
        let moved = false;
        try { card.setPointerCapture(ev.pointerId); } catch {}

        const onMove = me => {
          const dx = (me.clientX - startClientX) / zoom;
          const dy = (me.clientY - startClientY) / zoom;
          if (!moved && Math.hypot(dx, dy) < 3) return;
          moved = true;
          for (const [sid, orig] of origCoords) {
            const sn = graph.nodes.find(x => x.id === sid);
            if (!sn) continue;
            sn.x = Math.max(12, Math.round((orig.x + dx) / 8) * 8);
            sn.y = Math.max(12, Math.round((orig.y + dy) / 8) * 8);
            const dom = nodesLayer.querySelector(`.mc-node[data-node-id="${CSS.escape(sid)}"]`);
            if (dom) {
              dom.style.left = `${sn.x}px`;
              dom.style.top = `${sn.y}px`;
            }
          }
          renderEdgesOnly();
        };
        const onUp = () => {
          card.removeEventListener('pointermove', onMove);
          card.removeEventListener('pointerup', onUp);
          card.removeEventListener('pointercancel', onUp);
          if (moved) markDirty();
          // Re-sync selected class on cards
          nodesLayer.querySelectorAll('.mc-node').forEach(elNode => {
            elNode.classList.toggle('is-selected', selectedNodeIds.has(elNode.dataset.nodeId));
          });
        };
        card.addEventListener('pointermove', onMove);
        card.addEventListener('pointerup', onUp);
        card.addEventListener('pointercancel', onUp);
      });

      // Double-click a UE Blueprint Function Chip -> drill directly inside its inner circuit!
      if (n.type === 'function_call') {
        card.addEventListener('dblclick', async ev => {
          ev.stopPropagation();
          if (n.functionId && await mayLeaveGraph())
            openGraphById(n.functionId, { pushDrill: true, viaChipId: n.id });
        });
      }

      nodesLayer.append(card);
    }

    // Measure actual node heights before drawing curves so ports align to pixel perfection
    for (const card of nodesLayer.querySelectorAll('.mc-node')) {
      const id = card.dataset.nodeId;
      nodeDims.set(id, { w: card.offsetWidth || NODE_W, h: card.offsetHeight || NODE_H_DEFAULT });
    }
    renderEdgesOnly();
  };

  // =========================================================================
  // Drag-to-Wire (Supports BOTH Node-to-Node AND Edge-Attachment Parallel Supplement!)
  // =========================================================================
  const clientToWorld = (clientX, clientY) => {
    const r = viewport.getBoundingClientRect();
    return {
      x: (clientX - r.left - panX) / zoom,
      y: (clientY - r.top - panY) / zoom,
    };
  };

  const startWireDrag = (ev, fromNodeId, fromPort) => {
    ev.stopPropagation();
    ev.preventDefault();
    const start = getNodePortPos(fromNodeId, fromPort);
    wireDrag = {
      fromNodeId,
      fromPort,
      startX: start.x,
      startY: start.y,
      curX: start.x,
      curY: start.y,
      hoverNodeId: '',
      hoverEdgeId: '',
      hoverT: 0.5,
    };

    const onMove = me => {
      const pt = clientToWorld(me.clientX, me.clientY);
      wireDrag.curX = pt.x;
      wireDrag.curY = pt.y;
      wireDrag.hoverNodeId = '';
      wireDrag.hoverEdgeId = '';

      // 1. Check if hovering over any target node card
      for (const n of graph.nodes) {
        if (n.id === fromNodeId && fromPort !== 'loop') continue;
        if (n.type === 'input' && fromPort !== 'loop') continue;
        const h = nodeDims.get(n.id)?.h || NODE_H_DEFAULT;
        if (pt.x >= n.x - 14 && pt.x <= n.x + NODE_W + 10 && pt.y >= n.y - 10 && pt.y <= n.y + h + 10) {
          wireDrag.hoverNodeId = n.id;
          break;
        }
      }

      // 2. If NOT over a node and NOT dragging a feedback loop, check proximity to any existing non-feedback edge!
      if (!wireDrag.hoverNodeId && fromPort !== 'loop') {
        let bestEdge = '';
        let bestT = 0.5;
        let bestDist = 26;
        for (const e of graph.edges) {
          if (e.wireKind === 'feedback' || e.fromPort === 'loop') continue;
          if (e.fromNodeId === fromNodeId) continue;
          const c = edgeCurves.get(e.id);
          if (!c) continue;
          const hit = closestTOnCubic(c.p0, c.p1, c.p2, c.p3, pt);
          if (hit.dist < bestDist) {
            bestDist = hit.dist;
            bestEdge = e.id;
            bestT = hit.t;
          }
        }
        if (bestEdge) {
          wireDrag.hoverEdgeId = bestEdge;
          wireDrag.hoverT = bestT;
        }
      }

      // Update floating wire guide toast
      if (wireDrag.hoverEdgeId) {
        const he = graph.edges.find(x => x.id === wireDrag.hoverEdgeId);
        const srcName = graph.nodes.find(x => x.id === he?.fromNodeId)?.title || he?.fromNodeId || '上游';
        const dstName = he?.targetKind === 'node'
          ? (graph.nodes.find(x => x.id === he.targetId)?.title || he.targetId)
          : '连线';
        wireToast.textContent = `● 松手附着到「${srcName} → ${dstName}」连线，作为「${srcName}」的并行补充信息`;
        wireToast.hidden = false;
      } else if (wireDrag.hoverNodeId) {
        const tn = graph.nodes.find(x => x.id === wireDrag.hoverNodeId);
        wireToast.textContent = fromPort === 'loop'
          ? `↻ 松手建立闭环反馈回路，打回「${tn?.title || tn?.id}」重跑`
          : `→ 松手直连至「${tn?.title || tn?.id}」作为主干上游`;
        wireToast.hidden = false;
      } else {
        wireToast.textContent = fromPort === 'loop'
          ? '拖至上游节点建立闭环反馈回路'
          : '拖至目标节点（主干直连），或拖至已有连线上（并行补充支流）';
        wireToast.hidden = false;
      }

      renderEdgesOnly();
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      wireToast.hidden = true;

      if (wireDrag.hoverEdgeId) {
        const newEdge = {
          id: uid('e'),
          fromNodeId,
          fromPort: fromPort === 'pass' ? 'pass' : 'out',
          targetKind: 'edge',
          targetId: wireDrag.hoverEdgeId,
          attachT: Number(wireDrag.hoverT.toFixed(2)),
          wireKind: 'supplement',
          label: '并行补充',
        };
        graph.edges.push(newEdge);
        selectedNodeIds.clear();
        selectedEdgeId = newEdge.id;
        inspectorOpen = true;
        markDirty();
      } else if (wireDrag.hoverNodeId) {
        const newEdge = {
          id: uid('e'),
          fromNodeId,
          fromPort,
          targetKind: 'node',
          targetId: wireDrag.hoverNodeId,
          attachT: 0.5,
          wireKind: fromPort === 'loop' ? 'feedback' : 'main',
          label: fromPort === 'loop' ? '闭环返工' : '',
        };
        graph.edges.push(newEdge);
        selectedNodeIds.clear();
        selectedEdgeId = newEdge.id;
        inspectorOpen = true;
        markDirty();
      }

      wireDrag = null;
      renderAll();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  // =========================================================================
  // Collapsible Property Inspector (Node & Edge Configuration + Live Output)
  // =========================================================================
  const renderInspector = () => {
    const wasHidden = inspector.hidden;
    const syncViewportAfterToggle = () => {
      if (wasHidden !== inspector.hidden) {
        requestAnimationFrame(() => fitViewport());
      }
    };
    inspector.replaceChildren();
    if (!graph || !inspectorOpen) {
      inspector.hidden = true;
      syncViewportAfterToggle();
      return;
    }

    const head = el('div', 'mc-insp-head');
    const closeInsp = el('button', 'mc-btn', '×');
    closeInsp.type = 'button';
    closeInsp.onclick = () => {
      inspectorOpen = false;
      inspector.hidden = true;
      requestAnimationFrame(() => fitViewport());
    };

    // Case A: Edge Inspector
    if (selectedEdgeId) {
      const edge = graph.edges.find(e => e.id === selectedEdgeId);
      if (!edge) { inspector.hidden = true; syncViewportAfterToggle(); return; }
      inspector.hidden = false;
      syncViewportAfterToggle();
      head.append(el('strong', '', edge.targetKind === 'edge' ? '● 顺带补充连线（并行）' : edge.wireKind === 'feedback' ? '↻ 不满意重做回路' : '→ 下一步连线'), closeInsp);
      inspector.append(head);

      const fromN = graph.nodes.find(x => x.id === edge.fromNodeId);
      let descTxt = '';
      if (edge.targetKind === 'edge') {
        const hostEdge = graph.edges.find(x => x.id === edge.targetId);
        const hostFrom = graph.nodes.find(x => x.id === hostEdge?.fromNodeId);
        const hostTo = graph.nodes.find(x => x.id === hostEdge?.targetId);
        descTxt = `规则说明：「${fromN?.title || edge.fromNodeId}」挂在「${hostFrom?.title || '?'} → ${hostTo?.title || '?'}」连线上，运行时会与「${hostFrom?.title || '?'}」同时执行，并作为「${hostFrom?.title || '?'}」的顺带补充资料一起交给下一步。`;
      } else if (edge.wireKind === 'feedback') {
        const toN = graph.nodes.find(x => x.id === edge.targetId);
        descTxt = `重做规则：当「${fromN?.title || edge.fromNodeId}」点不满意重做或检查未通过时，自动把修改意见带回「${toN?.title || edge.targetId}」重新执行一轮。`;
      } else {
        const toN = graph.nodes.find(x => x.id === edge.targetId);
        descTxt = `流程流向：「${fromN?.title || edge.fromNodeId}」完成后直接进入下一步「${toN?.title || edge.targetId}」（可以把资料或其他动作拉线挂到这条线上做顺带补充）。`;
      }
      inspector.append(el('p', 'mc-insp-note', descTxt));

      const lblField = makeField('连线标注', 'text', edge.label || '', v => {
        edge.label = v; markDirty(); renderEdgesOnly();
      }, '例如：读取结果 / 顺带补充 / 不满意重做');
      inspector.append(lblField);

      if (edge.targetKind === 'edge') {
        const tWrap = el('label', 'mc-field');
        tWrap.append(el('span', 'mc-field-lbl', `汇入连接点位置 (${Math.round((edge.attachT ?? 0.5) * 100)}%)`));
        const slider = el('input', 'mc-range');
        slider.type = 'range'; slider.min = '0.2'; slider.max = '0.8'; slider.step = '0.05';
        slider.value = String(edge.attachT ?? 0.5);
        slider.oninput = () => {
          edge.attachT = Number(slider.value);
          tWrap.firstElementChild.textContent = `汇入连接点位置 (${Math.round(edge.attachT * 100)}%)`;
          markDirty();
          renderEdgesOnly();
        };
        tWrap.append(slider);
        inspector.append(tWrap);
      }

      if (edge.targetKind === 'node') {
        const kindWrap = el('label', 'mc-field');
        kindWrap.append(el('span', 'mc-field-lbl', '导线性质'));
        const sel = el('select', 'mc-input');
        sel.innerHTML = `<option value="main">主干直连（正向依赖）</option><option value="feedback">闭环反馈回路（循环重跑）</option>`;
        sel.value = edge.wireKind === 'feedback' ? 'feedback' : 'main';
        sel.onchange = () => {
          edge.wireKind = sel.value;
          edge.fromPort = sel.value === 'feedback' ? 'loop' : (fromN?.type === 'gate' ? 'pass' : 'out');
          markDirty();
          renderEdgesOnly();
        };
        kindWrap.append(sel);
        inspector.append(kindWrap);
      }

      const delBtn = el('button', 'mc-btn is-danger mc-insp-del', '断开此连线');
      delBtn.type = 'button';
      delBtn.onclick = () => {
        // Also remove any secondary supplements attached onto this edge
        graph.edges = graph.edges.filter(x => x.id !== edge.id && !(x.targetKind === 'edge' && x.targetId === edge.id));
        selectedEdgeId = '';
        inspectorOpen = false;
        markDirty();
        renderAll();
      };
      inspector.append(delBtn);
      return;
    }

    // Case B: Single Node Inspector
    if (selectedNodeIds.size !== 1) {
      inspector.hidden = true;
      return;
    }
    const nid = [...selectedNodeIds][0];
    const node = graph.nodes.find(x => x.id === nid);
    if (!node) { inspector.hidden = true; return; }

    inspector.hidden = false;
    syncViewportAfterToggle();
    const meta = NODE_TYPE_META[node.type] || NODE_TYPE_META.agent;
    head.append(el('strong', '', `${meta.icon} ${meta.label}`), closeInsp);
    inspector.append(head);

    inspector.append(makeField('步骤名称', 'text', node.title || '', v => {
      node.title = v; markDirty(); renderNodesAndEdges();
    }));

    if (node.type === 'action') {
      const ak = node.actionKind || 'read_file';
      const am = ACTION_KIND_META[ak] || ACTION_KIND_META.read_file;
      inspector.append(makeSelect('动作类型', Object.entries(ACTION_KIND_META).map(([k, v]) => ({
        value: k, label: `${v.icon} ${v.label}`,
      })), ak, v => {
        const prevMeta = ACTION_KIND_META[node.actionKind || 'read_file'];
        node.actionKind = v;
        if (!node.title || node.title === '执行动作' || (prevMeta && node.title === prevMeta.label)) {
          node.title = ACTION_KIND_META[v]?.label || '执行动作';
        }
        markDirty();
        renderAll();
      }));
      inspector.append(makeField(am.targetLbl, 'text', node.actionTarget || '', v => {
        node.actionTarget = v; markDirty(); renderNodesAndEdges();
      }, am.placeholder));
      if (ak === 'open_app') {
        inspector.append(makeField('启动参数（可选）', 'text', node.actionArgs || '', v => {
          node.actionArgs = v; markDirty();
        }, '例如：--new-window 或文件路径'));
      }
      if (ak === 'fetch_url' || ak === 'run_command') {
        inspector.append(makeField('超时上限（秒，3~300）', 'number', String(node.actionTimeoutSec || 30), v => {
          node.actionTimeoutSec = Math.max(3, Math.min(300, Number(v) || 30)); markDirty();
        }));
      }
      if (ak === 'read_file') {
        inspector.append(makeField('最大读取字数（防爆上下文）', 'number', String(node.maxInlineChars || 12000), v => {
          node.maxInlineChars = Math.max(500, Math.min(500000, Number(v) || 12000)); markDirty();
        }));
      }
    }

    if (node.type === 'agent') {
      // Role source: existing resident bot vs canvas-scoped inline temporary bot!
      const modeSel = makeSelect('执行角色来源', [
        { value: 'existing', label: '选用现有常驻伙伴' },
        { value: 'inline', label: '画布新建专属临时角色（不污染侧边栏）' },
      ], node.botMode || 'existing', v => {
        node.botMode = v; markDirty(); renderAll();
      });
      inspector.append(modeSel);

      if (node.botMode === 'inline') {
        inspector.append(makeField('临时角色名称', 'text', node.inlineName || '', v => {
          node.inlineName = v; markDirty(); renderNodesAndEdges();
        }, '例如：安全审计员 / 毒舌编辑'));
        inspector.append(makeTextarea('角色人设与职责设定', node.inlinePersona || '', 3, v => {
          node.inlinePersona = v; markDirty();
        }, '描述这个画布专属角色的性格、专业背景与评判标准…'));

        const promoteBtn = el('button', 'mc-btn', '✦ 将此临时角色转正为常驻伙伴');
        promoteBtn.type = 'button';
        promoteBtn.onclick = async () => {
          if (!api) return;
          const nm = (node.inlineName || node.title || '').trim();
          if (!nm) { notify('请先填写临时角色名称'); return; }
          try {
            const res = await api('/api/dimension/canvas/promote-bot', {
              method: 'POST',
              body: JSON.stringify({ name: nm, persona: node.inlinePersona || '' }),
            });
            if (res?.bot?.id) {
              node.botMode = 'existing';
              node.botId = res.bot.id;
              markDirty();
              onBotPromoted?.(res.bot);
              notify(`「${res.bot.name}」已转正为常驻伙伴！`);
              renderAll();
            }
          } catch (err) {
            notify(`转正失败：${err?.message || err}`);
          }
        };
        inspector.append(promoteBtn);
      } else {
        const bots = getBots?.() || [];
        const grpSet = new Set(Array.isArray(linkedWork?.groupMemberIds) ? linkedWork.groupMemberIds : []);
        const botOpts = [];
        if (grpSet.size) {
          for (const b of bots) {
            if (grpSet.has(b.id)) botOpts.push({ value: b.id, label: `★ 本群 · ${b.name || b.id}` });
          }
          for (const b of bots) {
            if (!grpSet.has(b.id)) botOpts.push({ value: b.id, label: b.name || b.id });
          }
        } else {
          for (const b of bots) botOpts.push({ value: b.id, label: b.name || b.id });
        }
        if (node.botId && !botOpts.some(o => o.value === node.botId)) {
          botOpts.unshift({ value: node.botId, label: node.botId });
        }
        if (!botOpts.length) botOpts.push({ value: 'ai-claude', label: 'Claude' });
        inspector.append(makeSelect('选择常驻伙伴', botOpts, node.botId || botOpts[0].value, v => {
          node.botId = v; if (graph.id.startsWith('grp-bp-')) node.assignmentLocked=true; markDirty(); renderNodesAndEdges();
        }));
      }

      if (graph.id.startsWith('grp-bp-')) {
        inspector.append(makeCheckbox('锁定此节点的成员与执行组合',Boolean(node.assignmentLocked),v=>{
          node.assignmentLocked=v; markDirty(); renderWorkLinkBar();
        }));
      }
      const poolRestricted = graph.id.startsWith('grp-bp-') && node.id !== 'bp-lead-final' && library.modelPool?.length;
      if (poolRestricted) {
        const entries = library.modelPool.filter(m => !node.requiresWorkspace || m.engineId);
        const current = entries.findIndex(m => m.engineId
          ? node.engineKind === 'cli' && node.cliModelSource === 'native' && m.engineId === node.cliEngineId && m.model === node.cliNativeModel && (m.providerId || '') === (node.cliNativeProvider || '')
          : node.engineKind !== 'cli' && node.providerId === m.providerId && node.model === m.model);
        const opts = entries.map((m,i) => ({value:String(i),label:[m.engineId || 'API',m.providerId,m.model].filter(Boolean).join(' / ')}));
        if (current < 0) opts.unshift({value:'',label:'请选择允许池中的组合'});
        inspector.append(makeSelect('此节点的执行组合',opts,current < 0 ? '' : String(current),value => {
          const m = value === '' ? null : entries[Number(value)];
          if (!m) return;
          Object.assign(node, {assignmentLocked:true,engineKind:m.engineId ? 'cli':'api',cliEngineId:m.engineId || 'auto',
            cliModelSource:m.engineId ? 'native':'work',cliNativeProvider:m.engineId ? m.providerId || '' : '',
            cliNativeModel:m.engineId ? m.model : '',providerId:m.engineId ? '' : m.providerId,model:m.engineId ? '' : m.model});
          markDirty(); renderAll();
        }));
        if (node.requiresWorkspace) inspector.append(el('small','mc-muted','此节点需要工作区执行能力，仅显示 CLI。'));
      } else {
      // Engine selector: Dimension API vs Official Code CLI (Bubblewrap Sandbox!)
      inspector.append(makeSelect('执行引擎', [
        { value: 'api', label: '维度 API（自定义模型直连）' },
        { value: 'cli', label: '官方 Code CLI（遵循沙盒隔离策略）' },
      ], node.engineKind || 'api', v => {
        node.engineKind = v; if (graph.id.startsWith('grp-bp-')) node.assignmentLocked=true; markDirty(); renderAll();
      }));

      if (node.engineKind === 'cli') {
        const cliOpts = CLI_ENGINE_OPTIONS.map(o => {
          const desc = (library.harnesses || []).find(h => h.id === o.id);
          const tag = desc?.executionMode === 'sandbox' ? ' [沙盒已装]' : desc?.executionMode === 'host' ? ' [宿主机]' : '';
          return { value: o.id, label: o.label + tag };
        });
        inspector.append(makeSelect('指定 Code CLI', cliOpts, node.cliEngineId || 'auto', v => {
          node.cliEngineId = v; if (graph.id.startsWith('grp-bp-')) node.assignmentLocked=true; markDirty(); renderNodesAndEdges();
        }));
        inspector.append(makeSelect('CLI 模型驱动源', [
          { value: 'work', label: '维度 API 驱动（免登录，直接用下方模型）' },
          { value: 'native', label: '官方原生订阅（使用该 CLI 沙盒登录态）' },
        ], node.cliModelSource || 'work', v => {
          node.cliModelSource = v; if (graph.id.startsWith('grp-bp-')) node.assignmentLocked=true; markDirty(); renderAll();
        }));
        if (node.cliModelSource === 'native') {
          inspector.append(makeField('原生模型 ID（留空用 CLI 默认）', 'text', node.cliNativeModel || '', v => {
            node.cliNativeModel = v; if (graph.id.startsWith('grp-bp-')) node.assignmentLocked=true; markDirty(); renderNodesAndEdges();
          }, '例如：gpt-5 / claude-sonnet-4-6'));
        }
      }

      if (node.engineKind === 'api' || node.cliModelSource !== 'native') {
        appendProviderModelFields(inspector, node);
      }

      }

      inspector.append(makeSelect('推理强度', [
        { value: '', label: 'Auto（默认）' },
        { value: 'low', label: 'Low（轻量快速）' },
        { value: 'medium', label: 'Medium（均衡）' },
        { value: 'high', label: 'High（深度推理）' },
      ], node.reasoningEffort || '', v => { node.reasoningEffort = v; markDirty(); }));

      inspector.append(makeSelect('上下文接收模式', [
        { value: 'handoff', label: '精简交接（推荐：总委托 + 连线主干与并行补充）' },
        { value: 'full_chain', label: '完整链路（额外附带更早节点摘要）' },
        { value: 'template_only', label: '仅自定义变量拼装（零多余 Token）' },
      ], node.contextMode || 'handoff', v => { node.contextMode = v; markDirty(); }));

      inspector.append(makeCheckbox('只读分析模式（CLI 沙盒以物理只读挂载工作区）', Boolean(node.readOnly), v => {
        node.readOnly = v; markDirty(); renderNodesAndEdges();
      }));
      if (node.botMode === 'existing') {
        inspector.append(makeCheckbox('附带该伙伴的长期经验记忆', Boolean(node.includeMemory), v => {
          node.includeMemory = v; markDirty();
        }));
      }

      inspector.append(makeTextarea('本节点任务指令（可用 {{input}} / {{prev}} / {{feedback}}）', node.prompt || '', 4, v => {
        node.prompt = v; markDirty();
      }, '告诉她这一棒具体做什么、输出什么格式…'));
    }

    if (node.type === 'reference') {
      inspector.append(makeSelect('资料来源', [
        { value: 'text', label: '手动粘贴文本 / 设定 / 规范' },
        { value: 'file', label: '实时读取本地 .txt / .md 文件' },
      ], node.refMode || 'text', v => { node.refMode = v; markDirty(); renderAll(); }));

      if (node.refMode === 'file') {
        inspector.append(makeField('本地文件路径（UTF-8 .txt/.md/.json）', 'text', node.filePath || '', v => {
          node.filePath = v; markDirty(); renderNodesAndEdges();
        }, '例如：L:\\Projects\\spec.txt'));
      } else {
        inspector.append(makeTextarea('资料正文内容', node.refText || '', 6, v => {
          node.refText = v; markDirty(); renderNodesAndEdges();
        }, '粘贴需要给 Bot 阅读的参考规范、设定集或背景文本…'));
      }
      inspector.append(makeField('大文件截断上限（字符数，防爆窗口）', 'number', String(node.maxInlineChars || 12000), v => {
        node.maxInlineChars = Math.max(500, Math.min(500000, Number(v) || 12000)); markDirty();
      }));
      inspector.append(makeCheckbox('强制全文注入（仅建议搭配超长上下文模型）', Boolean(node.forceFullText), v => {
        node.forceFullText = v; markDirty();
      }));
    }

    if (node.type === 'compress') {
      inspector.append(makeSelect('压缩提炼模式', [
        { value: 'handoff_card', label: '结构化交接单（目标 / 产物 / 风险 / 建议）' },
        { value: 'summary', label: '高密度要点摘要' },
        { value: 'custom', label: '按下方自定义规则提炼' },
      ], node.compressMode || 'handoff_card', v => { node.compressMode = v; markDirty(); renderNodesAndEdges(); }));
      inspector.append(makeField('目标最大输出字数', 'number', String(node.maxOutputChars || 2400), v => {
        node.maxOutputChars = Math.max(200, Math.min(32000, Number(v) || 2400)); markDirty(); renderNodesAndEdges();
      }));
      appendProviderModelFields(inspector, node);
      inspector.append(makeTextarea('额外压缩/提取要求（可选）', node.prompt || '', 3, v => {
        node.prompt = v; markDirty();
      }, '例如：只保留报错堆栈和变更文件路径…'));
    }

    if (node.type === 'gate') {
      inspector.append(makeSelect('判断与检查方式', [
        { value: 'bool_switch', label: '🔘 布尔值（真/假开关或真假判断）' },
        { value: 'logic_and', label: '∧ 和/且条件（AND · 全部满足）' },
        { value: 'logic_or', label: '∨ 或条件（OR · 任一满足）' },
        { value: 'approval', label: '✔ 等我亲自确认（通过/重做）' },
        { value: 'auto_condition', label: '🏷 关键词检查（PASS/FAIL）' },
      ], node.gateMode || 'approval', v => { node.gateMode = v; markDirty(); renderAll(); }));

      if (node.gateMode === 'bool_switch') {
        inspector.append(makeSelect('布尔值来源', [
          { value: 'fixed', label: '固定开关（手动选择真 / 假）' },
          { value: 'auto', label: '自动判断上游输出为真或假' },
        ], node.boolSource || 'auto', v => { node.boolSource = v; markDirty(); renderAll(); }));

        if ((node.boolSource || 'auto') === 'fixed') {
          const swWrap = el('div', 'mc-field');
          swWrap.append(el('span', 'mc-field-lbl', '当前布尔值'));
          const seg = el('div', 'mc-bool-seg');
          const tBtn = el('button', `mc-bool-btn${node.boolValue !== false ? ' is-true-on' : ''}`, '✓ 真 (True)');
          tBtn.type = 'button';
          tBtn.onclick = () => { node.boolValue = true; markDirty(); renderAll(); };
          const fBtn = el('button', `mc-bool-btn${node.boolValue === false ? ' is-false-on' : ''}`, '✗ 假 (False)');
          fBtn.type = 'button';
          fBtn.onclick = () => { node.boolValue = false; markDirty(); renderAll(); };
          seg.append(tBtn, fBtn);
          swWrap.append(seg);
          inspector.append(swWrap);
        }
        inspector.append(makeCheckbox('结果取反（真变假、假变真 / 非 NOT）', Boolean(node.invertResult), v => {
          node.invertResult = v; markDirty(); renderNodesAndEdges();
        }));
      } else if (node.gateMode === 'logic_and' || node.gateMode === 'logic_or') {
        const isAnd = node.gateMode === 'logic_and';
        inspector.append(el('p', 'mc-insp-note',
          isAnd
            ? '和 (AND) 规则：下方所有条件全部满足才走「✓ 满足」路线；若下方未设条件，则把所有连进来的上游开关/步骤做「全部为真」判断。'
            : '或 (OR) 规则：下方任意一条条件满足即走「✓ 满足」路线；若下方未设条件，则把所有连进来的上游开关/步骤做「任一为真」判断。'
        ));
        if (!Array.isArray(node.conditionRules)) node.conditionRules = [];
        const rulesWrap = el('div', 'mc-rules-wrap');
        rulesWrap.append(el('span', 'mc-field-lbl', isAnd ? '需全部满足的条件列表（和 / AND）' : '满足任意一条即可（或 / OR）'));
        node.conditionRules.forEach((rule, idx) => {
          const row = el('div', 'mc-rule-row');
          const opSel = el('select', 'mc-select mc-rule-op');
          for (const o of LOGIC_OP_OPTIONS) {
            const opt = document.createElement('option');
            opt.value = o.value; opt.textContent = o.label;
            opSel.append(opt);
          }
          opSel.value = rule.op || 'contains';
          opSel.onchange = () => { rule.op = opSel.value; markDirty(); renderAll(); };
          row.append(opSel);

          const metaOp = LOGIC_OP_OPTIONS.find(o => o.value === (rule.op || 'contains')) || LOGIC_OP_OPTIONS[0];
          if (metaOp.needVal) {
            const valInp = el('input', 'mc-input mc-rule-val');
            valInp.type = 'text';
            valInp.value = rule.value || '';
            valInp.placeholder = metaOp.ph;
            valInp.oninput = () => { rule.value = valInp.value; markDirty(); };
            row.append(valInp);
          }
          const rmBtn = el('button', 'mc-btn mc-rule-rm', '×');
          rmBtn.type = 'button';
          rmBtn.title = '删除该条件';
          rmBtn.onclick = () => {
            node.conditionRules.splice(idx, 1);
            markDirty(); renderAll();
          };
          row.append(rmBtn);
          rulesWrap.append(row);
        });
        const addRuleBtn = el('button', 'mc-btn mc-rule-add', '＋ 添加一条条件');
        addRuleBtn.type = 'button';
        addRuleBtn.onclick = () => {
          node.conditionRules.push({ op: 'contains', value: '' });
          markDirty(); renderAll();
        };
        rulesWrap.append(addRuleBtn);
        inspector.append(rulesWrap);

        inspector.append(makeCheckbox('对总结果取反（非 NOT）', Boolean(node.invertResult), v => {
          node.invertResult = v; markDirty(); renderNodesAndEdges();
        }));
        inspector.append(makeField('若连回上游重做：最多重做次数（1~20）', 'number', String(node.maxIterations || 3), v => {
          node.maxIterations = Math.max(1, Math.min(20, Number(v) || 3)); markDirty(); renderNodesAndEdges();
        }));
      } else if (node.gateMode === 'auto_condition') {
        inspector.append(makeField('通过关键词（上游包含即继续）', 'text', node.passKeyword || 'PASS', v => {
          node.passKeyword = v; markDirty(); renderNodesAndEdges();
        }));
        inspector.append(makeField('重做关键词（上游包含即打回重做）', 'text', node.failKeyword || 'FAIL', v => {
          node.failKeyword = v; markDirty(); renderNodesAndEdges();
        }));
        inspector.append(makeField('最多重做次数（防无限循环，1~20）', 'number', String(node.maxIterations || 3), v => {
          node.maxIterations = Math.max(1, Math.min(20, Number(v) || 3)); markDirty(); renderNodesAndEdges();
        }));
      } else {
        inspector.append(makeTextarea('确认时的提醒文字', node.approvalHint || '', 2, v => {
          node.approvalHint = v; markDirty();
        }, '例如：请先看下生成的内容，满意点通过，不满意写下意见让它重做…'));
        inspector.append(makeField('最多重做次数（防无限循环，1~20）', 'number', String(node.maxIterations || 3), v => {
          node.maxIterations = Math.max(1, Math.min(20, Number(v) || 3)); markDirty(); renderNodesAndEdges();
        }));
      }
    }

    if (node.type === 'function_call') {
      const fnOpts = (library.functions || [])
        .filter(f => !(graph.kind === 'function' && f.id === graph.id))
        .map(f => ({ value: f.id, label: `📦 ${f.name}` }));
      inspector.append(makeSelect('选择的常用组合步骤', fnOpts.length ? fnOpts : [{ value: '', label: '暂无已打包组合' }], node.functionId || '', v => {
        node.functionId = v;
        const found = (library.functions || []).find(f => f.id === v);
        if (found) node.title = found.name;
        markDirty();
        renderAll();
      }));
      inspector.append(makeTextarea('给这个组合步骤的补充交代（可选）', node.paramNote || '', 3, v => {
        node.paramNote = v; markDirty();
      }, '例如：本次只看前端页面部分，忽略后端脚本…'));

      if (node.functionId) {
        const drillBtn = el('button', 'mc-btn is-blueprint', '📦 双击/点击展开内部步骤 →');
        drillBtn.type = 'button';
        drillBtn.onclick = async () => {
          if (await mayLeaveGraph()) openGraphById(node.functionId, { pushDrill: true, viaChipId: node.id });
        };
        inspector.append(drillBtn);
      }
    }

    // Live Run Output Viewer for this node
    const rs = getNodeRunState(node.id);
    if (rs && (rs.output || rs.error)) {
      const outBox = el('div', 'mc-insp-output');
      outBox.append(el('div', 'mc-field-lbl', `本节点最近运行产出 (${rs.status}${rs.modelLabel ? ` · ${rs.modelLabel}` : ''})`));
      if (rs.plannedRoute) {
        outBox.append(el('div','mc-field-lbl', `开工指定：${rs.plannedRoute} · 执行器记录：${rs.modelLabel || '未返回'}`));
        if (rs.finishedAt && rs.startedAt) outBox.append(el('div','mc-field-lbl', `节点耗时 ${((rs.finishedAt-rs.startedAt)/1000).toFixed(1)} 秒 · 实际费用未知`));
      }
      if (rs.error) outBox.append(el('div', 'mc-insp-err', rs.error));
      if (rs.output) outBox.append(el('pre', 'mc-insp-pre thin-scroll', rs.output));
      if (Array.isArray(rs.artifacts) && rs.artifacts.length) {
        outBox.append(el('div', 'mc-insp-arts', `改动产物：${rs.artifacts.join('、')}`));
      }
      inspector.append(outBox);
    }

    // Delete Node Button (keep at least 1 node)
    if (graph.nodes.length > 1) {
      const delBtn = el('button', 'mc-btn is-danger mc-insp-del', '删除此步骤');
      delBtn.type = 'button';
      delBtn.onclick = () => {
        const removedEdges = new Set(
          graph.edges.filter(e => e.fromNodeId === node.id || (e.targetKind === 'node' && e.targetId === node.id)).map(e => e.id)
        );
        graph.nodes = graph.nodes.filter(x => x.id !== node.id);
        graph.edges = graph.edges.filter(e => !removedEdges.has(e.id) && !(e.targetKind === 'edge' && removedEdges.has(e.targetId)));
        selectedNodeIds.delete(node.id);
        inspectorOpen = false;
        markDirty();
        renderAll();
      };
      inspector.append(delBtn);
    }
  };

  function appendProviderModelFields(container, node) {
    const groups = getProviderGroups?.() || [];
    const provOpts = [{ value: '', label: '自动沿用默认模型' }];
    for (const g of groups) {
      provOpts.push({ value: g.providerId, label: g.title || g.providerId });
    }
    if (node.providerId && !provOpts.some(o => o.value === node.providerId)) {
      provOpts.push({ value: node.providerId, label: `${node.providerId}（当前指定）` });
    }
    container.append(makeSelect('模型供应商', provOpts, node.providerId || '', v => {
      if (graph.id.startsWith('grp-bp-')) node.assignmentLocked=true;
      node.providerId = v;
      const g = groups.find(x => x.providerId === v);
      node.model = g?.models?.[0] || '';
      markDirty();
      renderAll();
    }));
    const curGrp = groups.find(x => x.providerId === node.providerId);
    if (curGrp && Array.isArray(curGrp.models) && curGrp.models.length) {
      const mOpts = curGrp.models.map(m => ({ value: m, label: m }));
      if (node.model && !mOpts.some(o => o.value === node.model)) {
        mOpts.unshift({ value: node.model, label: `${node.model}（当前指定）` });
      }
      container.append(makeSelect('指定模型', mOpts, node.model || mOpts[0].value, v => {
        node.model = v; if (graph.id.startsWith('grp-bp-')) node.assignmentLocked=true; markDirty(); renderNodesAndEdges();
      }));
    } else if (node.providerId || node.model) {
      container.append(makeField('模型 ID', 'text', node.model || '', v => {
        node.model = v; if (graph.id.startsWith('grp-bp-')) node.assignmentLocked=true; markDirty(); renderNodesAndEdges();
      }));
    }
  }

  function makeField(label, type, value, onChange, placeholder = '') {
    const wrap = el('label', 'mc-field');
    wrap.append(el('span', 'mc-field-lbl', label));
    const inp = el('input', 'mc-input');
    inp.type = type;
    inp.value = value;
    if (placeholder) inp.placeholder = placeholder;
    inp.oninput = () => onChange(inp.value);
    wrap.append(inp);
    return wrap;
  }

  function makeTextarea(label, value, rows, onChange, placeholder = '') {
    const wrap = el('label', 'mc-field');
    wrap.append(el('span', 'mc-field-lbl', label));
    const ta = el('textarea', 'mc-textarea thin-scroll');
    ta.rows = rows;
    ta.value = value;
    if (placeholder) ta.placeholder = placeholder;
    ta.oninput = () => onChange(ta.value);
    wrap.append(ta);
    return wrap;
  }

  function makeSelect(label, options, value, onChange) {
    const wrap = el('label', 'mc-field');
    wrap.append(el('span', 'mc-field-lbl', label));
    const sel = el('select', 'mc-input');
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.append(opt);
    }
    sel.value = value;
    sel.onchange = () => onChange(sel.value);
    wrap.append(sel);
    return wrap;
  }

  function makeCheckbox(label, checked, onChange) {
    const wrap = el('label', 'mc-check');
    const inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.checked = checked;
    inp.onchange = () => onChange(inp.checked);
    wrap.append(inp, el('span', '', label));
    return wrap;
  }

  const renderAll = () => {
    renderTopbar();
    renderRunChrome();
    renderNodesAndEdges();
    renderInspector();
  };

  // =========================================================================
  // Toolbar Events, Pan/Zoom, UE Blueprint Collapse Dialog
  // =========================================================================
  tplSelect.onchange = async () => {
    const nextId = tplSelect.value;
    tplSelect.value = graph?.id || '';
    if (nextId && nextId !== graph?.id && await mayLeaveGraph()) openGraphById(nextId);
  };

  btnNew.onclick = async () => {
    if (!await mayLeaveGraph()) return;
    const id = uid('canvas');
    const fresh = {
      id,
      name: `我的流程 ${(library.canvases || []).length + 1}`,
      description: '新建的 DimensionImage 自动化流程蓝图',
      kind: 'canvas',
      category: '自定义',
      builtin: false,
      nodes: [
        { id: 'in-1', type: 'input', title: '开始任务', x: 50, y: 160 },
        {
          id: 'bot-1', type: 'agent', title: '让伙伴处理', x: 360, y: 160,
          botMode: 'existing', botId: getActiveBotId?.() || 'ai-claude',
          engineKind: 'api', contextMode: 'handoff', prompt: '请根据收到的信息完成这一步处理。',
        },
      ],
      edges: [
        { id: 'e-1', fromNodeId: 'in-1', fromPort: 'out', targetKind: 'node', targetId: 'bot-1', attachT: 0.5, wireKind: 'main', label: '下一步' },
      ],
    };
    graph = fresh;
    navStack = [{ id: fresh.id, kind: 'canvas', name: fresh.name, viaChipId: '' }];
    selectedNodeIds.clear();
    selectedEdgeId = '';
    inspectorOpen = false;
    resetHistory();
    markDirty();
    await saveCurrentGraph({ silent: false });
    renderAll();
    requestAnimationFrame(() => fitViewport());
  };

  btnUndo.onclick = () => performUndo();
  btnRedo.onclick = () => performRedo();
  btnAutoLayout.onclick = () => autoLayoutGraph();
  btnSave.onclick = () => void saveCurrentGraph();

  // =========================================================================
  // Smart Right-Click Context Menu (Blank Canvas / Node Card / Wire)
  // =========================================================================
  const hideContextMenu = () => {
    ctxMenu.hidden = true;
  };

  const positionContextMenu = (clientX, clientY) => {
    ctxMenu.hidden = false;
    const rr = root.getBoundingClientRect();
    const mw = ctxMenu.offsetWidth || 248;
    const mh = ctxMenu.offsetHeight || 280;
    let left = Math.round(clientX - rr.left);
    let top = Math.round(clientY - rr.top);
    if (left + mw > rr.width - 8) left = Math.max(8, rr.width - mw - 8);
    if (top + mh > rr.height - 8) top = Math.max(8, rr.height - mh - 8);
    ctxMenu.style.left = `${left}px`;
    ctxMenu.style.top = `${top}px`;
  };

  const addCtxItem = (label, onClick, { kbd = '', danger = false, disabled = false } = {}) => {
    const btn = el('button', `mc-ctx-item${danger ? ' is-danger' : ''}`);
    btn.type = 'button';
    btn.disabled = disabled;
    btn.append(el('span', 'mc-ctx-lbl', label));
    if (kbd) btn.append(el('span', 'mc-ctx-kbd', kbd));
    btn.onclick = ev => {
      ev.stopPropagation();
      hideContextMenu();
      onClick();
    };
    ctxMenu.append(btn);
  };

  const showBlankContextMenu = (clientX, clientY) => {
    if (!graph) return;
    const pt = clientToWorld(clientX, clientY);
    const dropX = Math.max(20, Math.round((pt.x - NODE_W / 2) / 8) * 8);
    const dropY = Math.max(20, Math.round((pt.y - 44) / 8) * 8);

    ctxMenu.replaceChildren();
    ctxMenu.append(el('div', 'mc-ctx-sec', '在此处添加步骤'));
    addCtxItem('✦ 让伙伴处理（AI 步骤）', () => addNodeToCanvas('agent', { x: dropX, y: dropY }));
    addCtxItem('📖 读取文件 / 目录', () => addNodeToCanvas('action', { actionKind: 'read_file', title: '读取文件 / 目录', x: dropX, y: dropY }));
    addCtxItem('🌐 获取网页信息', () => addNodeToCanvas('action', { actionKind: 'fetch_url', title: '获取网页信息', x: dropX, y: dropY }));
    addCtxItem('💻 运行命令 / 脚本', () => addNodeToCanvas('action', { actionKind: 'run_command', title: '运行命令 / 脚本', x: dropX, y: dropY }));
    addCtxItem('📄 读取文本资料 (.txt)', () => addNodeToCanvas('reference', { title: '读取文本资料', x: dropX, y: dropY }));
    addCtxItem('🗜 提炼整理信息', () => addNodeToCanvas('compress', { title: '提炼整理信息', x: dropX, y: dropY }));

    const logicRow = el('div', 'mc-ctx-logic-row');
    const logicDefs = [
      { label: '🔘 布尔', opts: { gateMode: 'bool_switch', boolSource: 'fixed', boolValue: true, title: '布尔开关' } },
      { label: '∧ 和(AND)', opts: { gateMode: 'logic_and', title: '和条件 (AND)' } },
      { label: '∨ 或(OR)', opts: { gateMode: 'logic_or', title: '或条件 (OR)' } },
    ];
    for (const ld of logicDefs) {
      const chip = el('button', 'mc-ctx-chip is-logic', ld.label);
      chip.type = 'button';
      chip.onclick = ev => {
        ev.stopPropagation();
        hideContextMenu();
        addNodeToCanvas('gate', { ...ld.opts, x: dropX, y: dropY });
      };
      logicRow.append(chip);
    }
    ctxMenu.append(logicRow);
    addCtxItem('✔ 等我亲自确认', () => addNodeToCanvas('gate', { gateMode: 'approval', title: '等我亲自确认', x: dropX, y: dropY }));

    ctxMenu.append(el('div', 'mc-ctx-sep'));
    addCtxItem('✨ 一键自动整理排版', () => autoLayoutGraph());
    addCtxItem('◎ 居中适配视图', () => fitViewport());
    ctxMenu.append(el('div', 'mc-ctx-sep'));
    addCtxItem('↶ 撤销', () => performUndo(), { kbd: 'Ctrl+Z', disabled: undoStack.length === 0 });
    addCtxItem('↷ 重做', () => performRedo(), { kbd: 'Ctrl+Y', disabled: redoStack.length === 0 });
    positionContextMenu(clientX, clientY);
  };

  const showNodeContextMenu = (nodeId, clientX, clientY) => {
    if (!graph) return;
    const node = graph.nodes.find(n => n.id === nodeId);
    if (!node) return;
    if (!selectedNodeIds.has(nodeId)) {
      selectedNodeIds.clear();
      selectedNodeIds.add(nodeId);
      selectedEdgeId = '';
      renderTopbar();
      nodesLayer.querySelectorAll('.mc-node').forEach(elNode => {
        elNode.classList.toggle('is-selected', selectedNodeIds.has(elNode.dataset.nodeId));
      });
    }

    ctxMenu.replaceChildren();
    const meta = NODE_TYPE_META[node.type] || NODE_TYPE_META.agent;
    ctxMenu.append(el('div', 'mc-ctx-head', `${meta.icon} ${node.title || meta.label}`));

    if (node.type === 'agent') {
      const bots = getBots?.() || [];
      if (bots.length) {
        const grpSet = new Set(Array.isArray(linkedWork?.groupMemberIds) ? linkedWork.groupMemberIds : []);
        const ordered = [...bots].sort((a, b) => Number(grpSet.has(b.id)) - Number(grpSet.has(a.id)));
        ctxMenu.append(el('div', 'mc-ctx-sec', '⚡ 快速切换伙伴'));
        const strip = el('div', 'mc-ctx-bot-strip');
        for (const b of ordered.slice(0, 6)) {
          const active = node.botMode !== 'inline' && node.botId === b.id;
          const chip = el('button', `mc-ctx-chip${active ? ' is-active' : ''}`, `${grpSet.has(b.id) ? '★ ' : ''}${b.name || b.id}`);
          chip.type = 'button';
          chip.onclick = ev => {
            ev.stopPropagation();
            hideContextMenu();
            node.botMode = 'existing';
            node.botId = b.id;
            markDirty();
            renderAll();
          };
          strip.append(chip);
        }
        ctxMenu.append(strip);
        ctxMenu.append(el('div', 'mc-ctx-sep'));
      }
    }

    if (node.type === 'gate' && node.gateMode === 'bool_switch' && node.boolSource === 'fixed') {
      addCtxItem(node.boolValue !== false ? '⇄ 切换为「✗ 假 (False)」' : '⇄ 切换为「✓ 真 (True)」', () => {
        node.boolValue = !(node.boolValue !== false);
        markDirty();
        renderAll();
      });
    }

    addCtxItem('⚙ 编辑属性与模型', () => {
      selectedNodeIds.clear();
      selectedNodeIds.add(node.id);
      selectedEdgeId = '';
      inspectorOpen = true;
      renderAll();
    });
    if (node.type !== 'input') {
      addCtxItem('📋 复制此步骤', () => duplicateSelectedNodes([node.id]), { kbd: 'Ctrl+D' });
    }
    const collapsibleCount = [...selectedNodeIds].filter(id => {
      const x = graph.nodes.find(nn => nn.id === id);
      return x && x.type !== 'input';
    }).length;
    if (collapsibleCount >= 2) {
      addCtxItem(`📦 打包所选 ${collapsibleCount} 个步骤`, () => btnCollapse.click());
    }
    if (node.type !== 'input') {
      ctxMenu.append(el('div', 'mc-ctx-sep'));
      addCtxItem('🗑 删除此步骤', () => deleteNodesByIds([node.id]), { kbd: 'Del', danger: true });
    }
    positionContextMenu(clientX, clientY);
  };

  const showEdgeContextMenu = (edgeId, clientX, clientY) => {
    if (!graph) return;
    const edge = graph.edges.find(e => e.id === edgeId);
    if (!edge) return;
    selectedNodeIds.clear();
    selectedEdgeId = edgeId;
    renderTopbar();
    renderEdgesOnly();

    ctxMenu.replaceChildren();
    ctxMenu.append(el('div', 'mc-ctx-head', edge.targetKind === 'edge' ? '● 顺带补充连线' : edge.wireKind === 'feedback' ? '↻ 重做/分支连线' : '→ 下一步连线'));
    addCtxItem('⚙ 编辑连线标注与属性', () => {
      inspectorOpen = true;
      renderAll();
    });
    if (edge.targetKind === 'node') {
      const fromN = graph.nodes.find(x => x.id === edge.fromNodeId);
      const isFb = edge.wireKind === 'feedback';
      addCtxItem(isFb ? '⇄ 切换为主干直连' : '⇄ 切换为重做/备用分支线', () => {
        edge.wireKind = isFb ? 'main' : 'feedback';
        edge.fromPort = isFb ? (fromN?.type === 'gate' ? 'pass' : 'out') : 'loop';
        markDirty();
        renderAll();
      });
    }
    ctxMenu.append(el('div', 'mc-ctx-sep'));
    addCtxItem('✂ 断开此连线', () => deleteEdgeById(edgeId), { kbd: 'Del', danger: true });
    positionContextMenu(clientX, clientY);
  };

  viewport.addEventListener('contextmenu', ev => {
    if (!graph) return;
    if (ev.target.closest('.mc-hud, .mc-approval-banner')) return;
    ev.preventDefault();
    ev.stopPropagation();
    addMenu.hidden = true;
    const nodeCard = ev.target.closest('.mc-node');
    if (nodeCard?.dataset?.nodeId) {
      showNodeContextMenu(nodeCard.dataset.nodeId, ev.clientX, ev.clientY);
      return;
    }
    const edgeEl = ev.target.closest('[data-edge-id]');
    if (edgeEl?.getAttribute('data-edge-id')) {
      showEdgeContextMenu(edgeEl.getAttribute('data-edge-id'), ev.clientX, ev.clientY);
      return;
    }
    showBlankContextMenu(ev.clientX, ev.clientY);
  });

  btnAddNode.onclick = ev => {
    ev.stopPropagation();
    hideContextMenu();
    if (addMenu.hidden) {
      renderAddMenu();
      const rr = root.getBoundingClientRect();
      const br = btnAddNode.getBoundingClientRect();
      addMenu.style.top = `${Math.round(br.bottom - rr.top + 6)}px`;
      addMenu.style.left = `${Math.max(8, Math.min(Math.round(br.left - rr.left), Math.round(rr.width - 252)))}px`;
      addMenu.style.right = 'auto';
      addMenu.hidden = false;
    } else {
      addMenu.hidden = true;
    }
  };
  document.addEventListener('click', ev => {
    if (!addMenu.hidden && !addMenu.contains(ev.target) && ev.target !== btnAddNode) {
      addMenu.hidden = true;
    }
    if (!ctxMenu.hidden && !ctxMenu.contains(ev.target)) {
      hideContextMenu();
    }
  });

  window.addEventListener('keydown', ev => {
    if (!visible || !graph) return;
    const tgt = ev.target;
    const inEditable = Boolean(tgt && tgt.closest && tgt.closest('input, textarea, select, [contenteditable="true"]'));
    const mod = ev.ctrlKey || ev.metaKey;
    const key = String(ev.key || '').toLowerCase();

    if (key === 'escape') {
      if (!ctxMenu.hidden || !addMenu.hidden || !collapseBar.hidden) {
        hideContextMenu();
        addMenu.hidden = true;
        collapseBar.hidden = true;
        return;
      }
      if (!inEditable && (selectedNodeIds.size || selectedEdgeId || inspectorOpen)) {
        selectedNodeIds.clear();
        selectedEdgeId = '';
        inspectorOpen = false;
        renderAll();
      }
      return;
    }

    if (mod && key === 's') {
      if (!tgt || root.contains(tgt) || !inEditable) {
        ev.preventDefault();
        void saveCurrentGraph();
      }
      return;
    }

    if (inEditable) return;

    if (mod && !ev.shiftKey && key === 'z') {
      ev.preventDefault();
      performUndo();
    } else if (mod && (key === 'y' || (ev.shiftKey && key === 'z'))) {
      ev.preventDefault();
      performRedo();
    } else if (mod && key === 'd') {
      if (selectedNodeIds.size) {
        ev.preventDefault();
        duplicateSelectedNodes();
      }
    } else if (key === 'delete' || key === 'backspace') {
      if (selectedEdgeId || selectedNodeIds.size) {
        ev.preventDefault();
        deleteCurrentSelection();
      }
    }
  });

  // Pack selected steps into a reusable combo module
  btnCollapse.onclick = () => {
    const ids = [...selectedNodeIds].filter(id => {
      const n = graph?.nodes.find(x => x.id === id);
      return n && n.type !== 'input';
    });
    if (!ids.length) return;
    collapseBar.replaceChildren();
    collapseBar.hidden = false;
    const titleSpan = el('span', 'mc-collapse-title', `📦 将已选 ${ids.length} 个步骤打包为常用组合：`);
    const nameInp = el('input', 'mc-run-input');
    nameInp.type = 'text';
    nameInp.placeholder = '输入组合名称（例如：读取并整理日报）';
    nameInp.value = `常用组合 ${(library.functions || []).length + 1}`;
    const okBtn = el('button', 'mc-btn is-blueprint', '确认打包');
    okBtn.type = 'button';
    const cancelBtn = el('button', 'mc-btn', '取消');
    cancelBtn.type = 'button';
    cancelBtn.onclick = () => { collapseBar.hidden = true; };
    okBtn.onclick = async () => {
      if (dirty) {
        const saved = await saveCurrentGraph({ silent: true });
        if (!saved) return;
      }
      try {
        const res = await api('/api/dimension/canvas/collapse', {
          method: 'POST',
          body: JSON.stringify({
            canvasId: graph.id,
            nodeIds: ids,
            name: nameInp.value.trim() || '自定义组合步骤',
            description: `由 ${ids.length} 个步骤打包而成的常用组合`,
          }),
        });
        collapseBar.hidden = true;
        if (res?.canvas && res?.function) {
          await loadLibrary({ keepCurrent: false });
          openGraphById(res.canvas.id);
          selectedNodeIds.clear();
          if (res.chipNodeId) selectedNodeIds.add(res.chipNodeId);
          inspectorOpen = true;
          renderAll();
          notify(`已打包常用组合「${res.function.name}」！双击即可展开查看或修改内部步骤。`);
        }
      } catch (err) {
        notify(`打包失败：${err?.message || err}`);
      }
    };
    collapseBar.append(titleSpan, nameInp, okBtn, cancelBtn);
    nameInp.focus();
    nameInp.select();
  };

  btnRunToggle.onclick = () => {
    showRunBar = !showRunBar;
    renderRunChrome();
  };
  btnCancelRun.onclick = () => void cancelCurrentRun();

  // Viewport Panning & Wheel Zoom
  viewport.addEventListener('pointerdown', ev => {
    hideContextMenu();
    if (ev.button !== 0 && ev.button !== 1) return;
    if (ev.target.closest('.mc-node, .mc-hud, .mc-approval-banner, .mc-edge-hit, .mc-junction-dot')) return;
    selectedNodeIds.clear();
    selectedEdgeId = '';
    inspectorOpen = false;
    renderTopbar();
    renderInspector();
    nodesLayer.querySelectorAll('.mc-node.is-selected').forEach(n => n.classList.remove('is-selected'));
    renderEdgesOnly();

    const startX = ev.clientX;
    const startY = ev.clientY;
    const origPanX = panX;
    const origPanY = panY;
    try { viewport.setPointerCapture(ev.pointerId); } catch {}
    viewport.classList.add('is-panning');
    const onMove = me => {
      panX = origPanX + (me.clientX - startX);
      panY = origPanY + (me.clientY - startY);
      applyTransform();
    };
    const onUp = () => {
      viewport.classList.remove('is-panning');
      viewport.removeEventListener('pointermove', onMove);
      viewport.removeEventListener('pointerup', onUp);
      viewport.removeEventListener('pointercancel', onUp);
    };
    viewport.addEventListener('pointermove', onMove);
    viewport.addEventListener('pointerup', onUp);
    viewport.addEventListener('pointercancel', onUp);
  });

  viewport.addEventListener('wheel', ev => {
    hideContextMenu();
    if (ev.target.closest('.mc-inspector, .mc-approval-banner, .mc-ctx-menu')) return;
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.08 : 0.92;
    const nextZoom = Math.max(0.26, Math.min(1.55, Number((zoom * factor).toFixed(3))));
    const rect = viewport.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    const wx = (mx - panX) / zoom;
    const wy = (my - panY) / zoom;
    zoom = nextZoom;
    panX = mx - wx * zoom;
    panY = my - wy * zoom;
    applyTransform();
  }, { passive: false });

  btnZoomIn.onclick = () => { zoom = Math.min(1.55, Number((zoom + 0.1).toFixed(2))); applyTransform(); };
  btnZoomOut.onclick = () => { zoom = Math.max(0.26, Number((zoom - 0.1).toFixed(2))); applyTransform(); };
  btnFit.onclick = () => fitViewport();

  const attachedRunIds = new Map();
  const showAttachedRun = async (canvasId, canvasRunId) => {
    if (linkedWork && linkedWork.canvasId === canvasId) {
      linkedWork = { ...linkedWork, readyToStart: false, executing: true };
    }
    try {
      const res = await api(`/api/dimension/canvas/runs/${encodeURIComponent(canvasRunId)}`);
      if (res?.run && graph?.id === canvasId && attachedRunIds.get(canvasId) === canvasRunId) {
        activeRun = res.run;
        const stillActive = activeRun.status === 'running' || activeRun.status === 'waiting_approval';
        if (linkedWork && linkedWork.canvasId === canvasId) {
          linkedWork = { ...linkedWork, readyToStart: false, executing: stillActive };
        }
        showRunBar = true;
        renderTopbar();
        renderRunChrome();
        renderNodesAndEdges();
        if (stillActive) {
          schedulePoll(350);
        }
      }
    } catch {}
  };

  return {
    activate: async () => {
      visible = true;
      needsFit = true;
      if (!loaded) {
        await loadLibrary({ keepCurrent: false });
      } else {
        renderAll();
      }
      requestAnimationFrame(() => fitViewport());
      setTimeout(() => { if (visible && needsFit) fitViewport(); }, 220);
      if (activeRun && (activeRun.status === 'running' || activeRun.status === 'waiting_approval')) {
        schedulePoll(400);
      }
    },
    deactivate: () => {
      visible = false;
      stopPolling();
      addMenu.hidden = true;
      hideContextMenu();
    },
    refreshLibrary: () => loadLibrary({ keepCurrent: true }),
    getActiveGraph: () => graph,
    openGraph: async (canvasId, linkCtx = null, { automatic = false } = {}) => {
      await loadLibrary({ keepCurrent: true });
      if (canvasId && findGraphInLibrary(canvasId)) {
        if (!graph || graph.id !== canvasId) {
          if (dirty && (automatic || !await mayLeaveGraph())) return false;
          openGraphById(canvasId);
        } else {
          renderTopbar();
          if (inspectorOpen) renderInspector();
        }
      }
      if (linkCtx !== undefined) linkedWork = linkCtx;
      if (!linkCtx?.readyToStart && attachedRunIds.has(canvasId)) await showAttachedRun(canvasId, attachedRunIds.get(canvasId));
      renderWorkLinkBar();
      requestAnimationFrame(() => fitViewport());
      setTimeout(() => { if (visible) fitViewport(); }, 220);
    },
    attachRun: async (canvasId, canvasRunId) => {
      if (!api || !canvasId || !canvasRunId) return;
      attachedRunIds.set(canvasId, canvasRunId);
      await loadLibrary({ keepCurrent: true });
      if (attachedRunIds.get(canvasId) !== canvasRunId) return;
      if (graph?.id !== canvasId) {
        if (dirty || !findGraphInLibrary(canvasId)) return;
        openGraphById(canvasId);
      }
      await showAttachedRun(canvasId, canvasRunId);
    },
    ensureSaved: async (expectedCanvasId = '') => {
      if (!graph || !dirty) return true;
      if (expectedCanvasId && graph.id !== expectedCanvasId && navStack[0]?.id !== expectedCanvasId) return true;
      return saveCurrentGraph({ silent: true });
    },
    setWorkLink: linkCtx => {
      linkedWork = linkCtx || null;
      renderWorkLinkBar();
    },
  };
}
