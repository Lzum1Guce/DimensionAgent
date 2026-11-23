// DimensionAgent 0.4.3 Work Session Controller:
// - Solo Work: Claude-style focused continuous thread + inline tool pills + right-side Artifacts & Diff dock.
// - Group Work: Grok Heavy-style 1v1 Lead Owner dialogue + top Multi-Agent Roundtable bar + click-to-inspect live member thoughts.
import { changeTranscript } from './transcript-scroll.js';
import { createThoughtStream } from './thought-stream.js';
import { decorateMessage } from './message-context-ui.js';
import { workTaskGroups, classifyWorkError } from './work-task-groups.js';
import { createChangeDiff } from './change-diff-ui.js';
import { renderRichMessage } from './markdown-lite.js';
import { svgIcon, iconNode } from './ui-icons.js';
import { ensureRelaySvg, shootRelayArc } from './group-relay-fx.js';
import { createWorkRollupStream, createWhisperMarker, createChoicePromptCard } from './work-rollup-stream.js';

const STATUS_LABELS = {
  queued: '排队中',
  waiting: '等待前置',
  blocked: '执行受阻',
  planning: '规划方案',
  running: '执行中',
  stopping: '正在停止',
  'waiting-approval': '待你批准',
  completed: '已完成',
  partial: '阶段交付',
  failed: '执行出错',
  cancelled: '已取消',
  interrupted: '已中断',
};

const TOOL_LABELS = {
  delegate_work: '并发分派幕僚任务',
  team_status: '汇总幕僚进度与结论',
  delegate_app: '调用应用生成图片',
  app_job_status: '取回应用成果',
  list_apps: '检查可用应用',
  computer: '操作独立桌面',
  desktop_status: '检查桌面状态',
  desktop_observe: '观察桌面画面',
  desktop_capture: '截取桌面画面',
  run_command: '运行命令',
  run_in_vm: '沙盒运行命令',
  sandbox_exec: '隔离环境构建/执行',
  install_software: '安装软件依赖',
  configure_environment: '配置环境权限',
  environment_info: '读取环境信息',
  get_team_status: '查看成员进度',
  get_work_history: '查阅历史成果',
  read_work_artifact: '读取交付原文',
  import_work_artifacts: '引入历史成果',
  list_files: '浏览目录文件',
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '编辑文件',
  verify_file: '核验生成文件',
  web_fetch: '抓取网页资料',
  todo_write: '更新步骤计划',
  task_finish: '完成验收存证',
  finish_work: '核验结果',
  call_plugin_tool: '调用插件工具',
  list_harness_arsenal: '检索跨引擎工具与技能库',
  read_harness_skill: '装载跨引擎技能',
  call_harness_mcp: '调用跨引擎 MCP 工具',
};

const isActive = status => ['queued', 'planning', 'running', 'waiting-approval'].includes(status);

const el = (tag, className = '', text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const WORK_CONTINUE_TEXT = '请继续完成刚才的任务';

// P1：错误条 = 友好文案 + 可折叠原文 +（可继续类）「继续任务」按钮。
// 历史错误不再删除；新一轮开始时由调用方给旧错误条加 is-stale。
function buildWorkErrorBanner(rawText, { status = 'failed', fallback = '任务执行中断或出错', onContinue } = {}) {
  const raw = String(rawText || '').trim() || fallback;
  const info = classifyWorkError(raw, status);
  const box = el('div', 'work-inline-error is-rich');
  box.setAttribute('role', 'alert');
  const head = el('div', 'work-error-head');
  head.append(el('span', 'work-error-icon', '⚠'), el('span', 'work-error-msg', info.message));
  box.append(head);
  if (info.detail && info.detail !== info.message) {
    const more = el('details', 'work-error-detail');
    more.append(el('summary', '', '查看详情'), el('pre', 'work-error-raw', info.detail));
    box.append(more);
  }
  if (info.resumable && typeof onContinue === 'function') {
    const actions = el('div', 'work-error-actions');
    const btn = el('button', 'work-error-continue', '▶ 继续任务');
    btn.type = 'button';
    btn.title = `向伙伴发送「${WORK_CONTINUE_TEXT}」，在同一卷委托里接着做`;
    btn.onclick = async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = '正在唤回伙伴…';
      try {
        await onContinue(WORK_CONTINUE_TEXT);
        btn.textContent = '已继续 ✓';
        box.classList.add('is-stale');
      } catch {
        btn.disabled = false;
        btn.textContent = '▶ 继续任务';
      }
    };
    actions.append(btn);
    box.append(actions);
  }
  return box;
}

const markErrorsStale = scopeNode => {
  scopeNode?.querySelectorAll?.('.work-inline-error:not(.is-stale)').forEach(node => {
    node.classList.add('is-stale');
    node.querySelectorAll('.work-error-continue').forEach(b => { b.disabled = true; });
  });
};

function summarizeToolTarget(toolName, rawArgs) {
  if (!rawArgs) return '';
  try {
    const parsed = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
    if (!parsed || typeof parsed !== 'object') return '';
    if (toolName === 'delegate_work' && Array.isArray(parsed.jobs)) {
      return `${parsed.jobs.length} 项并行分工`;
    }
    const target = parsed.path || parsed.relativePath || parsed.file || parsed.url || parsed.name || '';
    if (target) return String(target).slice(0, 64);
    if (Array.isArray(parsed.argv) && parsed.argv.length) {
      return parsed.argv.join(' ').slice(0, 64);
    }
    if (parsed.command) {
      return String(parsed.command).split('\n')[0].trim().slice(0, 64);
    }
  } catch {}
  return '';
}

function projectDisplayLabel(workspace, fallbackCwd) {
  const proj = workspace?.project || fallbackCwd || '';
  if (!proj) return '隔离沙盒';
  if (String(proj).startsWith('\\\\') || String(proj).includes('/var/lib/dimension/managed')) return '隔离沙盒';
  const parts = String(proj).replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || String(proj);
}

const CHAT_IMG_TAG_RE = /\[chat-image:([A-Za-z0-9_-]{4,80})\]/g;

function renderWorkUserTurnContent(container, rawText) {
  container.replaceChildren();
  const str = String(rawText || '');
  const imageIds = [];
  let m;
  CHAT_IMG_TAG_RE.lastIndex = 0;
  while ((m = CHAT_IMG_TAG_RE.exec(str)) !== null) {
    if (!imageIds.includes(m[1])) imageIds.push(m[1]);
  }
  const cleanText = str.replace(CHAT_IMG_TAG_RE, '').trim();
  if (imageIds.length > 0) {
    const gallery = el('div', 'work-user-images');
    for (const cid of imageIds) {
      const imgUrl = `/api/dimension/chat/images/${encodeURIComponent(cid)}`;
      const thumbBtn = el('button', 'work-user-img-btn');
      thumbBtn.type = 'button';
      thumbBtn.title = '点击放大查看参考图';
      const img = el('img', 'work-user-img');
      img.src = imgUrl;
      img.alt = '参考图片';
      thumbBtn.append(img);
      thumbBtn.onclick = e => {
        e.stopPropagation();
        const lb = document.getElementById('chatImageLightbox');
        const lbImg = document.getElementById('chatImageLightboxImg');
        if (lb && lbImg) {
          lbImg.src = imgUrl;
          lb.hidden = false;
        } else {
          window.open(imgUrl, '_blank', 'noopener');
        }
      };
      gallery.append(thumbBtn);
    }
    container.append(gallery);
  }
  if (cleanText) {
    container.append(el('div', 'work-user-prompt-body', cleanText));
  } else if (!imageIds.length) {
    container.textContent = '';
  }
}

function detectLocalDevUrl(rawText) {
  const s = String(rawText || '');
  if (!s) return '';
  const m = s.match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})(?:\/[^\s"'<>)\]]*)?/i);
  if (!m) return '';
  const port = Number(m[1]);
  if (!Number.isFinite(port) || port < 80 || port > 65535 || port === 18788) return '';
  return m[0].replace(/[.,;]+$/, '');
}

function createDevServerCapsule(devUrl, dock) {
  const safeDevUrl = detectLocalDevUrl(devUrl);
  const btn = el('button', 'work-devserver-pill');
  btn.type = 'button';
  const dot = el('span', 'work-devserver-dot');
  const labelWrap = el('span', '', '本地服务已就绪：');
  labelWrap.append(el('strong', '', safeDevUrl || String(devUrl || '')));
  const cta = el('span', 'work-devserver-cta', '在右侧画布预览 ↗');
  btn.append(dot, labelWrap, cta);
  btn.onclick = () => {
    if (safeDevUrl) dock?.openDevServerUrl?.(safeDevUrl);
  };
  return btn;
}

function createInlineToolPill(tool, actorLabel = '') {
  const details = el('details', 'claude-tool-pill');
  details.dataset.callId = tool.callId || '';
  details.dataset.status = tool.status || 'running';

  const summary = el('summary', 'claude-tool-summary');
  const dot = el('span', 'claude-tool-dot');
  dot.setAttribute('aria-hidden', 'true');
  const nameSpan = el('span', 'claude-tool-name');
  const targetSpan = el('span', 'claude-tool-target');
  const metaSpan = el('span', 'claude-tool-meta');
  summary.append(dot, nameSpan, targetSpan, metaSpan);

  const body = el('div', 'claude-tool-body');
  const argsPre = el('pre', 'claude-tool-args');
  const resPre = el('pre', 'claude-tool-result');
  body.append(argsPre, resPre);
  details.append(summary, body);

  const sync = nextTool => {
    details.dataset.status = nextTool.status || 'running';
    const semantic = TOOL_LABELS[nextTool.name] || nextTool.name || '执行工具';
    nameSpan.textContent = actorLabel ? `${actorLabel} · ${semantic}` : semantic;
    const target = summarizeToolTarget(nextTool.name, nextTool.args);
    targetSpan.textContent = target;
    targetSpan.hidden = !target;
    const stateText = {
      running: '执行中…',
      completed: nextTool.durationMs != null ? `${(nextTool.durationMs / 1000).toFixed(1)}s` : '完成',
      failed: '失败',
      cancelled: '已取消',
      interrupted: '中断',
    }[nextTool.status] || nextTool.status || '';
    metaSpan.textContent = stateText;
    argsPre.textContent = nextTool.args || '';
    argsPre.hidden = !nextTool.args;
    resPre.textContent = nextTool.result || (nextTool.status === 'running' ? '正在等待工具返回…' : '');
    resPre.hidden = !resPre.textContent;
  };
  sync(tool);

  return { node: details, sync };
}

function buildApprovalCard(row, { nameOf, isGroup, handlers }) {
  const box = el('div', 'claude-approval-card');
  box.dataset.approvalId = row.id || '';
  const riskText = {
    write: '写入 / 修改代码文件',
    exec: '隔离环境执行命令',
    escape: '访问项目根以外路径',
    isolated: '访问隔离盘路径',
  }[row.action?.risk] || '执行受控操作';

  const actorPrefix = isGroup && row.botId ? `幕僚「${nameOf(row.botId)}」请求拍板：` : '需要你批准操作：';
  box.append(el('div', 'claude-approval-title', `${actorPrefix}${riskText}`));

  const summaryBits = [
    row.action?.computer ? `${nameOf(row.action.actorId || row.botId || 'Bot')} 的独立 Linux 桌面` : '',
    row.action?.tool,
    row.action?.path,
    row.action?.command,
    row.action?.query,
    row.action?.pattern,
  ].filter(Boolean).join(' · ');
  if (summaryBits) box.append(el('div', 'claude-approval-summary', summaryBits));

  if (typeof row.action?.content === 'string') {
    const extra = el('details', 'claude-approval-more');
    extra.append(el('summary', '', `查看待写入内容（${row.action.content.length} 字符）`));
    const pre = el('pre', '');
    pre.textContent = row.action.content.slice(0, 4000) + (row.action.content.length > 4000 ? '\n…（预览已截断）' : '');
    extra.append(pre);
    box.append(extra);
  }
  if (row.action?.tool === 'edit') {
    const extra = el('details', 'claude-approval-more');
    extra.open = true;
    extra.append(el('summary', '', '查看变更前后对比'));
    extra.append(createChangeDiff(row.action.oldText, row.action.newText));
    box.append(extra);
  }

  const actionsRow = el('div', 'claude-approval-actions');
  const allowBtn = el('button', 'claude-approval-btn is-primary', '批准执行');
  allowBtn.type = 'button';
  const denyBtn = el('button', 'claude-approval-btn', '拒绝');
  denyBtn.type = 'button';
  const autoBtn = el('button', 'claude-approval-btn is-link', '批准并切换为默契护航');
  autoBtn.type = 'button';
  autoBtn.title = '批准本次操作，并把这位伙伴的审批模式切换为「默契护航」：日常操作自动放行，高危操作仍会请示你';
  const statusText = el('span', 'claude-approval-status', '');
  statusText.hidden = true;
  const buttons = { allow: allowBtn, deny: denyBtn, auto: autoBtn };
  const approvalId = String(row.id || '');

  const paintLocked = picked => {
    box.dataset.decided = '1';
    for (const b of Object.values(buttons)) {
      b.disabled = true;
      b.classList.toggle('is-selected', b === picked);
    }
    statusText.textContent = '已提交，等待确认…';
    statusText.hidden = false;
  };
  const unlock = () => {
    delete box.dataset.decided;
    for (const b of Object.values(buttons)) {
      b.disabled = false;
      b.classList.remove('is-selected');
    }
    statusText.textContent = '';
    statusText.hidden = true;
  };

  const lockChoice = async (kind, fn) => {
    if (box.dataset.decided === '1') return;
    if (approvalId && approvalDecisionsInFlight.has(approvalId)) return;
    if (approvalId) approvalDecisionsInFlight.set(approvalId, kind);
    paintLocked(buttons[kind]);
    let failed = false;
    try {
      await fn?.();
    } catch {
      failed = true;
    }
    if (approvalId) approvalDecisionsInFlight.delete(approvalId);
    // 处理完成后（app 会先刷新待审批列表再 resolve），若卡片仍挂在页面上说明该审批依旧待处理（提交失败），恢复可点击。
    if (failed || box.parentNode) unlock();
  };

  allowBtn.onclick = () => lockChoice('allow', () => handlers.onDecide?.(row.id, true, row.botId));
  denyBtn.onclick = () => lockChoice('deny', () => handlers.onDecide?.(row.id, false, row.botId));
  autoBtn.onclick = async () => {
    if (box.dataset.decided === '1') return;
    const title = '批准并切换为默契护航';
    const message = '之后这位伙伴的日常操作将自动放行，仅高危操作会请示你，可随时在输入框左侧盾牌按钮改回。';
    const ok = window.__dimensionConfirm
      ? await window.__dimensionConfirm({ title, message, confirmLabel: '批准并切换', danger: false })
      : window.confirm(`${title}\n\n${message}`);
    if (!ok) return;
    await lockChoice('auto', () => handlers.onAuto?.(row.id, row.botId));
  };
  actionsRow.append(allowBtn, denyBtn, statusText, autoBtn);
  box.append(actionsRow);

  // 重建时（如卡片被移出后又出现）保持“处理中/已锁定”，不能变回可点击。
  const inFlight = approvalId ? approvalDecisionsInFlight.get(approvalId) : '';
  if (inFlight) paintLocked(buttons[inFlight]);
  return box;
}

// approvalId -> 'allow' | 'deny' | 'auto'：用户已点击、等待服务端确认的审批项。
const approvalDecisionsInFlight = new Map();

/**
 * 按审批项 id 做 keyed 更新：已存在的卡片原样保留（保留 details 展开状态与滚动），
 * 只新增新出现的、移除已消失的，并按 rows 顺序排列。
 */
function syncApprovalZone(zone, rows, build) {
  const list = rows || [];
  const existing = new Map();
  for (const card of [...zone.children]) {
    const id = card.dataset?.approvalId || '';
    if (id && !existing.has(id)) existing.set(id, card);
    else card.remove();
  }
  const wanted = new Set(list.map(row => String(row?.id || '')).filter(Boolean));
  for (const [id, card] of existing) {
    if (!wanted.has(id)) {
      card.remove();
      existing.delete(id);
    }
  }
  let prev = null;
  for (const row of list) {
    const id = String(row?.id || '');
    let card = id ? existing.get(id) : null;
    if (card) existing.delete(id);
    else card = build(row);
    const anchor = prev ? prev.nextSibling : zone.firstChild;
    if (card !== anchor) zone.insertBefore(card, anchor);
    prev = card;
  }
  return list.length > 0;
}

/**
 * Member Native CLI Studio Inspector View (mounted inside right-hand Work Dock when clicking a member on the Roundtable
 * or clicking an inline "已发消息给 / 消息来自" whisper marker).
 * Renders the exact grouped action rollup + vertical icon step tree + live duration header!
 */
function createMemberInspectorRunView(run, { nameOf, avatarOf }) {
  const root = el('div', 'member-inspector-stream');
  const promptCard = el('div', 'member-inspector-prompt');
  promptCard.append(el('span', 'member-inspector-kicker', '分派职责 / 原生会话命题'), el('div', 'member-inspector-task-text', run.text || ''));

  const rollup = createWorkRollupStream({
    avatarHtml: avatarOf?.(run.botId, 20, 'thinking') || '',
    initialCreatedAt: run.createdAt || '',
    initialEndedAt: !isActive(run.status) ? (run.updatedAt || '') : '',
  });

  const answerHost = el('div', 'member-inspector-answer');
  answerHost.hidden = true;
  root.append(promptCard, rollup.node, answerHost);

  let lastToolAction = '';
  let lastSeq = 0;
  let status = run.status || 'queued';
  let latestResponse = run.answer || run.error || '';
  rollup.setActiveState(isActive(status));

  const renderFinalAnswer = text => {
    if (!String(text || '').trim()) return;
    latestResponse = text;
    answerHost.hidden = false;
    answerHost.replaceChildren(el('div', 'member-inspector-kicker', `回传群主的成果报告 · ${nameOf ? nameOf(run.botId) : ''}`));
    const body = el('div', 'member-inspector-md');
    renderRichMessage(body, text);
    answerHost.append(body);
  };

  if (latestResponse) renderFinalAnswer(latestResponse);

  const accept = event => {
    if (!Number.isSafeInteger(event.seq) || event.seq <= lastSeq) return false;
    lastSeq = event.seq;
    if (event.ts) rollup.noteEventTime(event.ts);
    if (event.kind === 'think') {
      rollup.pushThinking(event.text);
      lastToolAction = '深度思考中…';
    } else if (event.kind === 'commentary') {
      rollup.pushCommentaryDelta(event.text);
      lastToolAction = '播报阶段进展…';
    } else if (event.kind === 'project-instructions' && event.instructions) {
      rollup.showProjectInstructions(event.instructions);
    } else if (event.kind === 'broker-enriched' && event.broker) {
      rollup.renderBrokerEnrichment(event.broker);
      lastToolAction = event.broker.engineName ? `运行 ${event.broker.engineName}…` : '正在启动执行引擎…';
    } else if (event.kind === 'cli-step' && event.step) {
      const s = event.step;
      if (s.kind === 'thinking') {
        rollup.pushThinking(s.text);
        lastToolAction = '正在思考…';
      } else if (s.kind === 'commentary') {
        rollup.pushCommentaryDelta(s.text);
      } else if (s.kind === 'tool_start' || s.kind === 'tool_end') {
        rollup.upsertToolStep({
          name: s.toolName,
          callId: s.toolCallId,
          args: JSON.stringify({
            __actionCategory: s.actionCategory,
            __displayVerb: s.displayVerb,
            __displayTarget: s.displayTarget,
            raw: s.args || '',
          }),
          result: s.output || '',
          durationMs: s.durationMs || 0,
          status: s.kind === 'tool_start' ? 'running' : (s.isError ? 'failed' : 'completed'),
        }, event.taskId || run.id);
        lastToolAction = `${s.displayVerb || '执行'} ${s.displayTarget || ''}`.trim().slice(0, 26);
      } else if (s.kind === 'result' && s.durationMs > 0) {
        rollup.setDurationMs(s.durationMs);
      }
    } else if (event.kind === 'status' || event.kind === 'process') {
      if (event.text) lastToolAction = String(event.text).split('\n')[0].slice(0, 28);
    } else if (event.kind === 'tool' && event.tool) {
      if (event.tool.name !== 'dispatch_native_cli') {
        rollup.upsertToolStep(event.tool, event.taskId || run.id);
      }
      lastToolAction = TOOL_LABELS[event.tool.name] || event.tool.name || '执行工具';
    } else if (event.kind === 'say' || event.kind === 'plan') {
      if (event.from !== 'user' && String(event.text || '').trim()) {
        rollup.completeCommentaryBlock(event.text);
      }
    } else if (event.kind === 'input') {
      if (event.from === 'user' && event.text) {
        promptCard.querySelector('.member-inspector-task-text').textContent = event.text;
        rollup.resetClock(event.ts || new Date().toISOString());
        rollup.setActiveState(true);
      }
    } else if (event.kind === 'result' || event.kind === 'answer' || event.kind === 'team-result') {
      rollup.consumeTrailingAnswerPreview(event.text);
      rollup.sealCurrentBatch();
      renderFinalAnswer(event.text);
    } else if (event.kind === 'error') {
      rollup.sealCurrentBatch();
      const errNode = el('div', 'work-inline-error', event.text || '执行出错');
      root.insertBefore(errNode, answerHost);
    } else if (event.kind === 'run-state') {
      status = event.status;
      rollup.setActiveState(isActive(status));
    }
    return true;
  };

  return {
    root,
    accept,
    setTitle: text => { promptCard.querySelector('.member-inspector-task-text').textContent = text || ''; },
    update: next => {
      status = next;
      rollup.setActiveState(isActive(status));
    },
    advanceCursor: seq => { if (Number.isSafeInteger(seq)) lastSeq = Math.max(lastSeq, seq); },
    get lastSeq() { return lastSeq; },
    get status() { return status; },
    get microStatus() {
      if (status === 'completed') return '已完成交付 ✓';
      if (status === 'waiting-approval') return '待你批准';
      if (status === 'failed' || status === 'blocked') return STATUS_LABELS[status] || '异常';
      if (isActive(status)) return lastToolAction || STATUS_LABELS[status] || '工作中…';
      return STATUS_LABELS[status] || status;
    },
    get detailsLoaded() { return run.detailsLoaded !== false; },
  };
}

/**
 * Ultra-compact, collapsed-by-default single-line turn trace for Solo Work.
 * Keeps reasoning & tool execution out of the user's reading path unless explicitly expanded.
 */
function createCollapsedTurnTrace() {
  const details = el('details', 'claude-turn-trace is-live');
  details.open = false;

  const summary = el('summary', 'claude-trace-summary');
  const dot = el('span', 'claude-trace-dot');
  dot.setAttribute('aria-hidden', 'true');
  const ticker = el('span', 'claude-trace-ticker', '正在思考…');
  const hint = el('span', 'claude-trace-hint', '展开过程');
  summary.append(dot, ticker, hint);

  const drawer = el('div', 'claude-trace-drawer thin-scroll');
  details.append(summary, drawer);

  const startedAt = Date.now();
  const tools = new Map();
  let currentReasonPre = null;
  let reasonText = '';
  let stepCount = 0;
  let hasThought = false;
  let settled = false;
  let latestPreview = '';

  details.addEventListener('toggle', () => {
    hint.textContent = details.open ? '收起' : '展开过程';
  });

  const refreshTicker = () => {
    if (settled) {
      const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      const parts = [];
      if (hasThought) parts.push('思考已完成');
      if (stepCount > 0) parts.push(`执行 ${stepCount} 步操作`);
      if (!parts.length) parts.push('已完成处理');
      ticker.textContent = `${parts.join(' · ')}（${secs} 秒）`;
      return;
    }
    const stepSuffix = stepCount > 0 ? ` · 第 ${stepCount} 步` : '';
    ticker.textContent = `${latestPreview || '正在思考…'}${stepSuffix}`;
  };

  const think = delta => {
    if (!delta) return;
    hasThought = true;
    if (!currentReasonPre) {
      currentReasonPre = el('pre', 'claude-trace-reasoning');
      reasonText = '';
      drawer.append(currentReasonPre);
    }
    reasonText += String(delta);
    currentReasonPre.textContent = reasonText;
    // Reasoning remains available in the expandable drawer, but raw chain-of-
    // thought never becomes the live ticker shown in the user's reading path.
    latestPreview = '正在思考…';
    refreshTicker();
    if (details.open) drawer.scrollTop = drawer.scrollHeight;
  };

  const process = text => {
    const clean = String(text || '').trim();
    if (!clean) return;
    currentReasonPre = null;
    const line = el('div', 'claude-trace-step', clean.split('\n')[0].slice(0, 140));
    drawer.append(line);
    latestPreview = clean.split('\n')[0].slice(0, 46);
    refreshTicker();
    if (details.open) drawer.scrollTop = drawer.scrollHeight;
  };

  const upsertTool = (key, toolObj) => {
    let pill = tools.get(key);
    if (!pill) {
      currentReasonPre = null;
      stepCount++;
      pill = createInlineToolPill(toolObj);
      tools.set(key, pill);
      drawer.append(pill.node);
    } else {
      pill.sync(toolObj);
    }
    const semantic = TOOL_LABELS[toolObj.name] || toolObj.name || '执行工具';
    const target = summarizeToolTarget(toolObj.name, toolObj.args);
    latestPreview = target ? `${semantic}：${target}` : semantic;
    refreshTicker();
    if (details.open) drawer.scrollTop = drawer.scrollHeight;
  };

  const seal = () => {
    if (settled) return;
    settled = true;
    details.classList.remove('is-live');
    refreshTicker();
  };

  return { node: details, think, process, upsertTool, seal };
}

function formatDeliverableSize(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function derivePackageTitle(run, deliverables) {
  const rels = deliverables.map(f => String(f.relativePath || f.name || '').replace(/\\/g, '/'));
  let commonTop = '';
  let allShareTop = rels.length > 0;
  for (const r of rels) {
    const idx = r.indexOf('/');
    if (idx <= 0) { allShareTop = false; break; }
    const top = r.slice(0, idx);
    if (!commonTop) commonTop = top;
    else if (commonTop !== top) { allShareTop = false; break; }
  }
  if (allShareTop && commonTop) return commonTop;
  const firstLine = String(run?.text || '').split(/\r?\n/).find(Boolean) || '项目成品';
  const cleaned = firstLine.replace(/^APPTEST:[A-Za-z0-9_-]+\s*/, '').trim().slice(0, 26);
  return cleaned || '项目成品';
}

function renderDeliverablePackageZone({
  run, status, files = [], changes = [], sandboxCheckouts = [], checkpoints = [], artOpenBtn, artifactStrip, dock, api, isGroup = false, fallbackCwd = '',
}) {
  artifactStrip.replaceChildren();
  const primaryFiles = (files || []).filter(f => f.available !== false && f.category !== 'byproduct');
  const byproductCount = (files || []).filter(f => f.category === 'byproduct').length;
  const taskDeliverables = primaryFiles.filter(f => f.sourceScope !== 'project');
  const projectDeliverables = primaryFiles.filter(f => f.sourceScope === 'project');
  const sbCount = sandboxCheckouts.reduce((acc, s) => acc + ((s.diff?.changes || []).length), 0);

  const visibleCount = primaryFiles.length + (changes.length ? 1 : 0) + (sbCount ? 1 : 0);
  artOpenBtn.hidden = visibleCount === 0 && checkpoints.length === 0;
  if (visibleCount > 0 || checkpoints.length > 0) {
    const countNum = primaryFiles.length || sbCount || changes.length || checkpoints.length;
    if (isGroup) {
      artOpenBtn.innerHTML = `${svgIcon('box', 13)}<span>群文件 ${countNum}</span>`;
    } else {
      artOpenBtn.textContent = `实时画布 (${countNum})`;
    }
  }

  if (visibleCount === 0 && checkpoints.length === 0) {
    artifactStrip.hidden = true;
    return;
  }
  artifactStrip.hidden = false;

  if (checkpoints.length > 1) {
    const cpRow = el('div', 'work-inline-checkpoints');
    cpRow.append(el('span', 'work-inline-cp-title', '⏱ 时光机版本：'));
    for (const cp of checkpoints) {
      const b = el('button', 'work-inline-cp-btn', `v${cp.versionNumber}`);
      b.type = 'button';
      b.title = `v${cp.versionNumber} · ${cp.label || '历史快照'}（点击在右侧画布对比或回退）`;
      b.onclick = () => dock?.openArtifacts({ checkpointId: cp.id });
      cpRow.append(b);
    }
    const latestBtn = el('button', 'work-inline-cp-btn is-live', '最新');
    latestBtn.type = 'button';
    latestBtn.onclick = () => dock?.openArtifacts({ checkpointId: '' });
    cpRow.append(latestBtn);
    artifactStrip.append(cpRow);
  }

  // 1. Sandbox Checkout Sync-Back Banner (0.4.4 Hybrid Workspace)
  if (sbCount > 0) {
    const sbChip = el('button', 'claude-artifact-chip is-diff');
    sbChip.type = 'button';
    sbChip.innerHTML = `<span class="claude-art-icon">${svgIcon('sync', 15)}</span><span class="claude-art-info"><strong>${isGroup ? '群沙盒副本待回写' : '沙盒工位待回写'} (${sbCount})</strong><small>核验彩色 Diff 并增量同步回 Windows</small></span><span class="claude-art-open">回写 ↗</span>`;
    sbChip.onclick = () => dock?.openArtifacts({ showSandbox: true });
    artifactStrip.append(sbChip);
  }

  // Helper to run native folder pick + backend /export-deliverables
  const runLocalExport = async ({ btn, statusRow, folderName = '', forceFolder = false }) => {
    const picker = window.__dimensionPickFolder;
    if (!picker || !api) return;
    const chosenDir = await picker({
      title: forceFolder ? `选择「${folderName || '成品文件夹'}」的保存位置` : '选择成品保存到电脑的位置',
    });
    if (!chosenDir) return;
    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = '正在保存…';
    try {
      const res = await api(`/api/dimension/work/runs/${encodeURIComponent(run.id)}/export-deliverables`, {
        method: 'POST',
        body: JSON.stringify({ targetDir: chosenDir, folderName, forceFolder }),
      });
      statusRow.hidden = false;
      statusRow.replaceChildren();
      const okSpan = el('span', 'deliverable-saved-path');
      okSpan.innerHTML = `${svgIcon('check', 13)} `;
      okSpan.append(document.createTextNode(`已保存至：${res.savedPath}`));
      statusRow.append(okSpan);
      if (window.chrome?.webview?.postMessage) {
        const openExplorerBtn = el('button', 'deliverable-reveal-btn');
        openExplorerBtn.type = 'button';
        openExplorerBtn.innerHTML = `${svgIcon('folderOpen', 13)} <span>${res.kind === 'folder' ? '打开此文件夹' : '在文件夹中显示'}</span>`;
        openExplorerBtn.onclick = () => window.__dimensionRevealPath?.(res.savedPath);
        statusRow.append(openExplorerBtn);
      }
    } catch (err) {
      statusRow.hidden = false;
      statusRow.replaceChildren(el('span', 'deliverable-save-err', `保存失败：${err.message || '请重试'}`));
    } finally {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  };

  // 2. Task-Scoped Finished Deliverables (1 file -> Single File Card; >=2 or nested -> Package Folder/ZIP Card)
  const effectiveDeliverables = taskDeliverables.length > 0
    ? taskDeliverables
    : (changes.length === 0 ? projectDeliverables : []);

  if (effectiveDeliverables.length === 1 && !String(effectiveDeliverables[0].relativePath || '').includes('/')) {
    const f = effectiveDeliverables[0];
    const card = el('div', 'deliverable-card is-single');
    const mainRow = el('div', 'deliverable-card-head');
    const info = el('div', 'deliverable-card-info');
    info.append(
      iconNode('file', 'deliverable-icon', 19),
      el('div', 'deliverable-titles')
    );
    const titles = info.lastChild;
    titles.append(
      el('strong', 'deliverable-name', f.name),
      el('span', 'deliverable-meta', `${taskDeliverables.length ? "任务文件" : "项目文件"} · ${formatDeliverableSize(f.bytes)}${byproductCount > 0 ? ` · 已隐藏 ${byproductCount} 份过程草稿` : ''}`)
    );

    const statusLabel = el('span', 'deliverable-run-status', (STATUS_LABELS[status] || status) + ' · ');
    titles.querySelector('.deliverable-meta').prepend(statusLabel);
    const actions = el('div', 'deliverable-actions');
    const saveBtn = el('button', 'deliverable-btn is-primary');
    saveBtn.type = 'button';
    saveBtn.innerHTML = `${svgIcon('download', 14)}<span>保存到电脑…</span>`;
    const previewBtn = el('button', 'deliverable-btn');
    previewBtn.type = 'button';
    previewBtn.innerHTML = `${svgIcon('eye', 14)}<span>预览</span>`;
    previewBtn.onclick = () => dock?.openArtifacts({ fileUrl: f.url });
    actions.append(saveBtn, previewBtn);
    mainRow.append(info, actions);

    const statusRow = el('div', 'deliverable-status-row');
    statusRow.hidden = true;
    saveBtn.onclick = () => void runLocalExport({ btn: saveBtn, statusRow, forceFolder: false });

    card.append(mainRow, statusRow);
    artifactStrip.append(card);
  } else if (effectiveDeliverables.length >= 1) {
    const pkgTitle = derivePackageTitle(run, effectiveDeliverables);
    const totalBytes = effectiveDeliverables.reduce((s, f) => s + Number(f.bytes || 0), 0);
    const entryFile = effectiveDeliverables.find(f => /^index\.html?$/i.test(f.name))
      || effectiveDeliverables.find(f => /\.html?$/i.test(f.name))
      || effectiveDeliverables.find(f => /\.md$/i.test(f.name))
      || effectiveDeliverables[0];

    const card = el('div', 'deliverable-card is-package');
    const mainRow = el('div', 'deliverable-card-head');
    const info = el('div', 'deliverable-card-info');
    info.append(
      iconNode('box', 'deliverable-icon', 20),
      el('div', 'deliverable-titles')
    );
    const titles = info.lastChild;
    titles.append(
      el('strong', 'deliverable-name', pkgTitle),
      el('span', 'deliverable-meta', `${taskDeliverables.length ? "任务文件包" : "项目文件包"} · 共 ${effectiveDeliverables.length} 个文件（${formatDeliverableSize(totalBytes)}）${byproductCount > 0 ? ` · 已过滤 ${byproductCount} 份过程副产品` : ''}`)
    );

    const statusLabel = el('span', 'deliverable-run-status', (STATUS_LABELS[status] || status) + ' · ');
    titles.querySelector('.deliverable-meta').prepend(statusLabel);
    const actions = el('div', 'deliverable-actions');
    const saveFolderBtn = el('button', 'deliverable-btn is-primary');
    saveFolderBtn.type = 'button';
    saveFolderBtn.innerHTML = `${svgIcon('folder', 14)}<span>保存为本地文件夹…</span>`;

    const zipLink = el('a', 'deliverable-btn');
    zipLink.innerHTML = `${svgIcon('archive', 14)}<span>下载 .zip</span>`;
    zipLink.href = `/api/dimension/work/runs/${encodeURIComponent(run.id)}/deliverables.zip`;
    zipLink.download = `${pkgTitle}.zip`;

    const previewBtn = el('button', 'deliverable-btn');
    previewBtn.type = 'button';
    previewBtn.innerHTML = `${svgIcon('eye', 14)}<span>预览</span>`;
    previewBtn.onclick = () => dock?.openArtifacts({ fileUrl: entryFile?.url });

    actions.append(saveFolderBtn, zipLink, previewBtn);
    mainRow.append(info, actions);

    const treeDetails = el('details', 'deliverable-tree');
    const treeSummary = el('summary', '', `▸ 查看成品目录清单（${effectiveDeliverables.length} 项）`);
    const treeList = el('div', 'deliverable-tree-list thin-scroll');
    for (const f of effectiveDeliverables) {
      const itemBtn = el('button', 'deliverable-tree-item');
      itemBtn.type = 'button';
      itemBtn.append(
        el('span', 'deliverable-tree-path', f.relativePath || f.name),
        el('span', 'deliverable-tree-size', formatDeliverableSize(f.bytes))
      );
      itemBtn.onclick = () => dock?.openArtifacts({ fileUrl: f.url });
      treeList.append(itemBtn);
    }
    treeDetails.append(treeSummary, treeList);

    const statusRow = el('div', 'deliverable-status-row');
    statusRow.hidden = true;
    saveFolderBtn.onclick = () => void runLocalExport({ btn: saveFolderBtn, statusRow, folderName: pkgTitle, forceFolder: true });

    card.append(mainRow, treeDetails, statusRow);
    artifactStrip.append(card);
  }

  // 3. Local Windows Project Direct Modifications
  const projRoot = run.workspace?.project || fallbackCwd || '';
  const isLocalWinProj = projRoot && !String(projRoot).startsWith('\\\\');
  if (changes.length > 0) {
    const diffCard = el('div', 'deliverable-card is-local-proj');
    const row = el('div', 'deliverable-card-head');
    const info = el('div', 'deliverable-card-info');
    info.append(
      iconNode('wrench', 'deliverable-icon', 18),
      el('div', 'deliverable-titles')
    );
    info.lastChild.append(
      el('strong', 'deliverable-name', `已在项目目录更新 ${changes.length} 个文件`),
      el('span', 'deliverable-meta', isLocalWinProj ? projRoot : '支持查看修改前后红绿 Diff 与一键恢复')
    );
    const actions = el('div', 'deliverable-actions');
    if (isLocalWinProj && window.chrome?.webview?.postMessage) {
      const openDirBtn = el('button', 'deliverable-btn is-primary');
      openDirBtn.type = 'button';
      openDirBtn.innerHTML = `${svgIcon('folderOpen', 14)}<span>打开本地项目文件夹</span>`;
      openDirBtn.onclick = () => window.__dimensionRevealPath?.(projRoot);
      actions.append(openDirBtn);
    }
    const diffBtn = el('button', 'deliverable-btn');
    diffBtn.type = 'button';
    diffBtn.innerHTML = `${svgIcon('diff', 14)}<span>查看变更对比</span>`;
    diffBtn.onclick = () => dock?.openArtifacts({ showChanges: true });
    actions.append(diffBtn);
    row.append(info, actions);
    diffCard.append(row);
    artifactStrip.append(diffCard);
  }
}

/**
 * Claude-style Solo Work Thread View (Focused Single Thread + Continuous Stream)
 */
function createClaudeSoloThreadView(run, {
  api, transcript, nameOf, avatarOf, onAction, onArtifacts, onApproval, onDetails, onQuote, onNewThread, onSelectChoice, onContinue, dock, handoffAvailable, fallbackCwd,
}) {
  const root = el('section', 'claude-thread-stage work-run');
  root.dataset.runId = run.id;
  root.tabIndex = -1;

  // Sticky lightweight thread top bar
  const topBar = el('header', 'claude-thread-bar');
  const titleGroup = el('div', 'claude-thread-meta');
  const projBadge = el('span', 'claude-proj-pill');
  projBadge.innerHTML = `${svgIcon('folder', 12)} `;
  projBadge.append(document.createTextNode(projectDisplayLabel(run.workspace, fallbackCwd)));
  if (run.workspace?.project) projBadge.title = run.workspace.project;
  const stateBadge = el('span', 'claude-state-pill');
  titleGroup.append(projBadge, stateBadge);

  const barActions = el('div', 'claude-bar-actions');
  const overviewOpenBtn = el('button', 'claude-bar-btn', '任务面板');
  overviewOpenBtn.type = 'button';
  overviewOpenBtn.title = '打开右侧三段式任务概览（进度 / 产物 / 上传文件）';
  overviewOpenBtn.onclick = () => dock?.openOverview?.();

  const artOpenBtn = el('button', 'claude-bar-btn', '实时画布');
  artOpenBtn.type = 'button';
  artOpenBtn.hidden = true;
  artOpenBtn.onclick = () => dock?.openArtifacts({});

  const handoffBtn = el('button', 'claude-bar-btn', '导出交接');
  handoffBtn.type = 'button';
  handoffBtn.dataset.action = 'handoff';
  handoffBtn.hidden = !handoffAvailable;
  handoffBtn.onclick = () => onAction('handoff', run.id);

  const newThreadBtn = el('button', 'claude-bar-btn is-accent', '＋ 新对话');
  newThreadBtn.type = 'button';
  newThreadBtn.title = '开启一条全新的独立项目对话';
  newThreadBtn.onclick = () => onNewThread?.();

  barActions.append(overviewOpenBtn, artOpenBtn, handoffBtn, newThreadBtn);
  topBar.append(titleGroup, barActions);

  // Continuous Conversation Stream
  const stream = el('div', 'claude-stream');

  // Initial User Prompt Bubble
  const firstUserBubble = el('div', 'bubble user claude-user-turn work-run-title');
  const firstUserText = el('div', 'claude-user-text');
  let lastSoloTitle = String(run.text || '');
  renderWorkUserTurnContent(firstUserText, lastSoloTitle);
  firstUserBubble.append(firstUserText);
  decorateMessage(firstUserBubble, { ...run, from: 'user' }, { nameOf, onQuote });
  stream.append(firstUserBubble);

  // Lazy details loader button if historical run events weren't preloaded
  const lazyLoadBtn = el('button', 'claude-lazy-load', '▸ 点击展开历史思考与工具执行步骤');
  lazyLoadBtn.type = 'button';
  lazyLoadBtn.hidden = run.detailsLoaded !== false;
  lazyLoadBtn.onclick = () => {
    lazyLoadBtn.disabled = true;
    lazyLoadBtn.textContent = '正在加载完整执行轨迹…';
    onDetails(run.id);
  };
  stream.append(lazyLoadBtn);

  // Active Timeline Container (events append chronologically here!)
  const timeline = el('div', 'claude-timeline');
  const approvalZone = el('div', 'claude-approval-zone');
  const artifactStrip = el('div', 'claude-artifact-strip');
  artifactStrip.hidden = true;
  const filesHiddenStore = el('div', 'work-artifacts-hidden');
  filesHiddenStore.hidden = true;
  filesHiddenStore.dataset.artifactOwner = run.id;

  stream.append(timeline, approvalZone, artifactStrip, filesHiddenStore);
  root.append(topBar, stream);

  let activeRollup = null;
  let currentTurnStartIso = run.createdAt || '';
  const ensureRollup = (startedIso = '') => {
    if (!activeRollup) {
      if (startedIso) currentTurnStartIso = startedIso;
      activeRollup = createWorkRollupStream({
        avatarHtml: avatarOf?.(run.botId, 22, 'thinking') || '',
        initialCreatedAt: startedIso || currentTurnStartIso,
        initialEndedAt: !isActive(status) ? (run.updatedAt || '') : '',
      });
      activeRollup.setActiveState(isActive(status));
      timeline.append(activeRollup.node);
    }
    if (startedIso) activeRollup.noteEventTime(startedIso);
    return activeRollup;
  };
  const sealRollup = (endedIso = '') => {
    if (activeRollup) {
      activeRollup.setActiveState(false, endedIso);
    }
  };

  let answerBlock = null;
  let compactionBanner = null;
  let lastSeq = 0;
  let status = run.status || 'queued';
  let connected = true;
  let liveArtTimer = null;
  const seenDevUrls = new Set();

  const scheduleLiveArtifactSync = targetTaskId => {
    if (liveArtTimer) clearTimeout(liveArtTimer);
    liveArtTimer = setTimeout(() => {
      liveArtTimer = null;
      onArtifacts(targetTaskId || run.id, filesHiddenStore);
    }, 420);
  };

  const announceDevUrl = rawUrl => {
    const clean = String(rawUrl || '').trim();
    if (!clean || seenDevUrls.has(clean)) return;
    seenDevUrls.add(clean);
    dock?.registerDevServerUrl?.(clean, { autoReveal: true });
    timeline.append(createDevServerCapsule(clean, dock));
  };

  const appendAssistantTurn = (text, messageEvent) => {
    if (!String(text || '').trim()) return null;
    sealRollup();
    const block = el('article', 'claude-assistant-turn work-message');
    const author = el('div', 'claude-assistant-author', nameOf(run.botId));
    const body = el('div', 'claude-assistant-body');
    renderRichMessage(body, text);
    block.append(author, body);
    if (messageEvent) decorateMessage(block, messageEvent, { nameOf, onQuote });
    timeline.append(block);
    return block;
  };

  const update = next => {
    if (status !== next) {
      const fileStatus = artifactStrip.querySelector('.deliverable-run-status');
      if (fileStatus) fileStatus.textContent = (STATUS_LABELS[next] || next) + ' · ';
    }
    status = next;
    root.dataset.status = status;
    const label = !connected && isActive(status) ? '重连中…' : (STATUS_LABELS[status] || status);
    stateBadge.textContent = label;
    stateBadge.dataset.status = status;
    handoffBtn.hidden = !handoffAvailable;
    if (activeRollup) activeRollup.setActiveState(isActive(status));
    if (!isActive(status)) {
      sealRollup();
    }
  };

  const accept = event => {
    if (!Number.isSafeInteger(event.seq) || event.seq <= lastSeq) return false;
    changeTranscript(transcript, () => {
      lastSeq = event.seq;
      if (event.kind === 'think') {
        ensureRollup(event.ts).pushThinking(event.text);
      } else if (event.kind === 'status' || event.kind === 'process') {
        if (event.text) ensureRollup(event.ts);
      } else if (event.kind === 'commentary') {
        ensureRollup(event.ts).pushCommentaryDelta(event.text);
      } else if (event.kind === 'project-instructions' && event.instructions) {
        ensureRollup(event.ts).showProjectInstructions(event.instructions);
      } else if (event.kind === 'broker-enriched' && event.broker) {
        ensureRollup(event.ts).renderBrokerEnrichment(event.broker);
      } else if (event.kind === 'cli-step' && event.step) {
        const rStream = ensureRollup(event.ts);
        const s = event.step;
        if (s.kind === 'thinking') {
          rStream.pushThinking(s.text);
        } else if (s.kind === 'commentary') {
          rStream.pushCommentaryDelta(s.text);
        } else if (s.kind === 'tool_start' || s.kind === 'tool_end') {
          rStream.upsertToolStep({
            name: s.toolName,
            callId: s.toolCallId,
            args: JSON.stringify({
              __actionCategory: s.actionCategory,
              __displayVerb: s.displayVerb,
              __displayTarget: s.displayTarget,
              raw: s.args || '',
            }),
            result: s.output || '',
            durationMs: s.durationMs || 0,
            status: s.kind === 'tool_start' ? 'running' : (s.isError ? 'failed' : 'completed'),
          }, event.taskId || run.id);
          if (s.kind === 'tool_end' && !s.isError && s.actionCategory === 'edit') {
            scheduleLiveArtifactSync(event.taskId || run.id);
          }
          const devUrl = s.detectedDevUrl || detectLocalDevUrl(s.output);
          if (devUrl) announceDevUrl(devUrl);
        } else if (s.kind === 'result' && s.durationMs > 0) {
          rStream.setDurationMs(s.durationMs);
        }
      } else if (event.kind === 'choice-prompt' && event.choice) {
        sealRollup();
        timeline.append(createChoicePromptCard({
          question: event.choice.question,
          options: event.choice.options,
          onSelect: value => onSelectChoice?.(value),
        }));
      } else if (event.kind === 'tool' && event.tool) {
        if (event.tool.name !== 'dispatch_native_cli' && event.tool.name !== 'ask_user_choice') {
          ensureRollup(event.ts).upsertToolStep(event.tool, event.taskId || run.id);
          if (event.tool.status === 'completed') {
            if (event.tool.name === 'write_file' || event.tool.name === 'edit_file') {
              scheduleLiveArtifactSync(event.taskId || run.id);
            }
            const devUrl = detectLocalDevUrl(event.tool.result);
            if (devUrl) announceDevUrl(devUrl);
          }
        } else {
          ensureRollup(event.ts);
        }
      } else if (event.kind === 'context-compaction') {
        const phaseLabel = {
          started: '正在自动精简早期上下文记录…',
          completed: event.modelCalls === 0 && event.prunedResults > 0 ? '已自动折叠超长工具输出' : '已自动摘要早期上下文，原始记录完整保留',
          failed: '上下文整理跳过',
          discarded: '需求更新，跳过旧上下文整理',
        }[event.phase];
        if (phaseLabel) {
          if (!compactionBanner) {
            compactionBanner = el('div', 'claude-system-divider');
            timeline.append(compactionBanner);
          }
          const tokenInfo = event.phase === 'completed' && Number.isSafeInteger(event.beforeTokens) && Number.isSafeInteger(event.afterTokens) && event.beforeTokens > event.afterTokens
            ? `（${event.beforeTokens.toLocaleString('zh-CN')} → ${event.afterTokens.toLocaleString('zh-CN')} tokens）`
            : '';
          compactionBanner.textContent = `✦ ${phaseLabel}${tokenInfo}`;
        }
      } else if (event.kind === 'input') {
        sealRollup(event.ts);
        activeRollup = null;
        answerBlock = null;
        currentTurnStartIso = event.ts || new Date().toISOString();
        markErrorsStale(timeline);
        if (event.from === 'user') {
          const turn = el('div', 'bubble user claude-user-turn');
          renderWorkUserTurnContent(turn, event.text || '');
          decorateMessage(turn, event, { nameOf, onQuote });
          timeline.append(turn);
        } else if (event.text) {
          timeline.append(el('div', 'claude-system-divider', event.text));
        }
      } else if (event.kind === 'say') {
        if (event.from !== 'user' && String(event.text || '').trim()) {
          ensureRollup(event.ts).completeCommentaryBlock(event.text);
        }
      } else if (event.kind === 'plan' && event.dispatchPlan) {
        sealRollup(event.ts); appendAssistantTurn(event.text, event);
      } else if (event.kind === 'plan') {
        if (String(event.text || '').trim()) {
          ensureRollup(event.ts).completeCommentaryBlock(event.text);
        }
      } else if (event.kind === 'answer') {
        if (activeRollup) {
          if (event.ts) activeRollup.noteEventTime(event.ts);
          activeRollup.consumeTrailingAnswerPreview(event.text);
        }
        sealRollup(event.ts);
        if (String(event.text || '').trim()) {
          if (!answerBlock) {
            answerBlock = appendAssistantTurn(event.text, event);
          } else {
            const body = answerBlock.querySelector('.claude-assistant-body');
            if (body) renderRichMessage(body, event.text);
            decorateMessage(answerBlock, event, { nameOf, onQuote });
          }
        }
      } else if (event.kind === 'result' || event.kind === 'team-result') {
        const isTerminalFailure = event.kind === 'result'
          && event.status
          && event.status !== 'completed'
          && event.status !== 'partial';
        if (isTerminalFailure) {
          if (activeRollup && event.ts) activeRollup.noteEventTime(event.ts);
          sealRollup(event.ts);
          if (event.status !== 'cancelled' && String(event.text || '').trim()) {
            timeline.append(buildWorkErrorBanner(event.text, { status: event.status, onContinue }));
          }
        } else {
          if (activeRollup) {
            if (event.ts) activeRollup.noteEventTime(event.ts);
            activeRollup.consumeTrailingAnswerPreview(event.text);
          }
          sealRollup(event.ts);
          if (String(event.text || '').trim()) {
            if (!answerBlock) {
              answerBlock = appendAssistantTurn(event.text, event);
            } else {
              const body = answerBlock.querySelector('.claude-assistant-body');
              if (body) renderRichMessage(body, event.text);
              decorateMessage(answerBlock, event, { nameOf, onQuote });
            }
          }
        }
        if (event.taskId || run.id) onArtifacts(event.taskId || run.id, filesHiddenStore);
      } else if (event.kind === 'run-state') {
        if (event.ts && activeRollup) activeRollup.noteEventTime(event.ts);
        if (event.status === 'running') answerBlock = null;
        update(event.status);
      } else if (event.kind === 'approval') {
        onApproval(event.botId);
      } else if (event.kind === 'error') {
        sealRollup();
        const errBox = buildWorkErrorBanner(event.text, { status: event.status || 'failed', fallback: '任务执行中断或出错', onContinue });
        timeline.append(errBox);
      }
    });
    return true;
  };

  // Render pre-existing snapshot answer/error when detailsLoaded is false
  if (run.detailsLoaded === false && (run.answer || run.error)) {
    if (run.error) timeline.append(buildWorkErrorBanner(run.error, { status: run.status, onContinue }));
    else if (run.answer) answerBlock = appendAssistantTurn(run.answer, { text: run.answer, from: run.botId });
  }

  const renderArtifactChips = ({ files = [], changes = [], sandboxCheckouts = [], checkpoints = [] }) => {
    renderDeliverablePackageZone({
      run, status, files, changes, sandboxCheckouts, checkpoints, artOpenBtn, artifactStrip, dock, api, isGroup: false, fallbackCwd,
    });
  };

  const presentApprovals = (rows, handlers = {}) => syncApprovalZone(
    approvalZone, rows, row => buildApprovalCard(row, { nameOf, isGroup: false, handlers }),
  );

  update(status);

  return {
    root,
    files: filesHiddenStore,
    accept,
    update: next => changeTranscript(transcript, () => update(next)),
    setTitle: text => {
      const nextRaw = String(text || '');
      if (nextRaw !== lastSoloTitle) {
        lastSoloTitle = nextRaw;
        renderWorkUserTurnContent(firstUserText, nextRaw);
      }
    },
    setTeam: () => {},
    setEmbedded: () => {},
    renderArtifactChips,
    presentApprovals,
    setConnected: val => { connected = val; update(status); },
    setHandoffAvailable: val => { handoffAvailable = val === true; update(status); },
    advanceCursor: seq => { if (Number.isSafeInteger(seq)) lastSeq = Math.max(lastSeq, seq); },
    get lastSeq() { return lastSeq; },
    get status() { return status; },
    get detailsLoaded() { return run.detailsLoaded !== false; },
  };
}

/**
 * Grok Heavy-style Group Roundtable View:
 * - Top: Multi-Agent Roundtable Bar (Lead + Member pulse avatars; click any member to inspect live thoughts in right dock)
 * - Body: Pure 1v1 conversation exclusively between User and Group Owner (Lead)!
 */
function createGrokGroupRoundtableView(run, {
  api, transcript, nameOf, avatarOf, groupMembersOf, onAction, onArtifacts, onApproval, onDetails, onQuote, onNewThread, onInspectMember, onSelectChoice, onContinue, dock, handoffAvailable, fallbackCwd,
}) {
  // P1：视图级监听统一挂在这个 controller 上，视图被替换 / 会话关闭时 abort。
  const viewAbort = new AbortController();
  const root = el('section', 'claude-thread-stage is-grok-roundtable work-run');
  root.dataset.runId = run.id;
  root.dataset.workKind = 'group';
  root.tabIndex = -1;

  // 1. Star-Rail Pure Avatar + Short ID Top Stage (zero text buttons; text relocated to hover cards & ··· menu)
  const roundtable = el('header', 'grok-roundtable-bar is-star-rail');
  ensureRelaySvg(roundtable);

  const railWrap = el('div', 'star-rail-row');
  const seatsRow = el('div', 'grok-roundtable-seats star-rail-seats thin-scroll');
  const tailActions = el('div', 'star-rail-tail');

  const artOpenBtn = el('button', 'star-tail-icon-btn is-art-badge');
  artOpenBtn.type = 'button';
  artOpenBtn.hidden = true;
  artOpenBtn.title = '打开群组交付成果面板';
  artOpenBtn.setAttribute('aria-label', '打开群组交付成果面板');
  artOpenBtn.innerHTML = svgIcon('box', 14);
  artOpenBtn.onclick = () => dock?.openArtifacts({});

  const inviteTriggerBtn = el('button', 'star-tail-icon-btn is-dashed');
  inviteTriggerBtn.type = 'button';
  inviteTriggerBtn.title = '邀请新成员入群';
  inviteTriggerBtn.setAttribute('aria-label', '邀请新成员入群');
  inviteTriggerBtn.innerHTML = svgIcon('plus', 13);
  inviteTriggerBtn.onclick = () => document.getElementById('groupInviteBtn')?.click();

  const moreWrap = el('div', 'star-more-wrap');
  const moreBtn = el('button', 'star-tail-icon-btn');
  moreBtn.type = 'button';
  moreBtn.title = '更多群组操作（新对话 / 群设置 / 导出交接包）';
  moreBtn.setAttribute('aria-label', '更多群组操作');
  moreBtn.textContent = '⋯';

  const moreMenu = el('div', 'star-more-popover');
  moreMenu.hidden = true;

  const newThreadBtn = el('button', 'star-menu-item');
  newThreadBtn.type = 'button';
  newThreadBtn.innerHTML = `${svgIcon('plus', 13)}<span>开启新圆桌对话</span>`;
  newThreadBtn.onclick = () => { moreMenu.hidden = true; onNewThread?.(); };

  const groupInfoBtn = el('button', 'star-menu-item');
  groupInfoBtn.type = 'button';
  groupInfoBtn.innerHTML = `${svgIcon('sliders', 13)}<span>群组详情与成员管理</span>`;
  groupInfoBtn.onclick = () => { moreMenu.hidden = true; document.getElementById('groupBar')?.click(); };

  const handoffBtn = el('button', 'star-menu-item');
  handoffBtn.type = 'button';
  handoffBtn.dataset.action = 'handoff';
  handoffBtn.hidden = !handoffAvailable;
  handoffBtn.innerHTML = `${svgIcon('archive', 13)}<span>导出任务交接包</span>`;
  handoffBtn.onclick = () => { moreMenu.hidden = true; onAction('handoff', run.id); };

  moreMenu.append(newThreadBtn, groupInfoBtn, handoffBtn);
  moreBtn.onclick = e => {
    e.stopPropagation();
    moreMenu.hidden = !moreMenu.hidden;
  };
  document.addEventListener('pointerdown', e => {
    if (!moreMenu.hidden && !moreWrap.contains(e.target)) moreMenu.hidden = true;
  }, { signal: viewAbort.signal });
  moreWrap.append(moreBtn, moreMenu);

  tailActions.append(artOpenBtn, inviteTriggerBtn, moreWrap);
  railWrap.append(seatsRow, tailActions);

  // 2px Ultra-Thin Bottom Progress Hairline (replaces text progress capsule!)
  const hairlineTrack = el('div', 'star-progress-hairline');
  const hairlineFill = el('div', 'star-progress-fill');
  hairlineTrack.append(hairlineFill);
  hairlineTrack.hidden = true;

  roundtable.append(railWrap, hairlineTrack);

  // 2. Pure 1v1 Conversation Stream (User <-> Group Owner Lead ONLY; ZERO thinking/tool noise!)
  const stream = el('div', 'claude-stream');

  const firstUserBubble = el('div', 'bubble user claude-user-turn work-run-title');
  const firstUserText = el('div', 'claude-user-text');
  let lastRawTitle = String(run.text || '');
  renderWorkUserTurnContent(firstUserText, lastRawTitle);
  firstUserBubble.append(firstUserText);
  decorateMessage(firstUserBubble, { ...run, from: 'user' }, { nameOf, onQuote });
  stream.append(firstUserBubble);

  const timeline = el('div', 'claude-timeline');
  const approvalZone = el('div', 'claude-approval-zone');
  const artifactStrip = el('div', 'claude-artifact-strip');
  artifactStrip.hidden = true;
  const filesHiddenStore = el('div', 'work-artifacts-hidden');
  filesHiddenStore.hidden = true;
  filesHiddenStore.dataset.artifactOwner = run.id;

  stream.append(timeline, approvalZone, artifactStrip, filesHiddenStore);
  root.append(roundtable, stream);

  // Off-stage Lead Inspector View: keeps Group Owner's reasoning & scheduling tools completely out of main chat,
  // while still inspectable on-demand by clicking the Group Owner avatar in the top Roundtable bar!
  const ownerInspectorView = createMemberInspectorRunView(run, { nameOf, avatarOf });

  let answerBlock = null;
  let delegationBanner = null;
  let currentJobs = [];
  let lastSeq = 0;
  let status = run.status || 'queued';
  let connected = true;
  const prevMemberStates = new Map();
  const emittedWhispers = new Set();
  let convergedAnimated = run.status === 'completed';

  const seatCache = new Map();
  let seatDivider = null;

  const inspectMemberDirect = memberId => {
    const entry = seatCache.get(memberId);
    if (memberId === run.botId) {
      onInspectMember?.(memberId, {
        runId: run.id,
        isLead: true,
        job: '统筹拆解目标、实时接待对话并交叉汇总成员结论',
        status,
        inspectorView: ownerInspectorView,
      });
    } else {
      onInspectMember?.(memberId, entry?.latestJob || currentJobs.find(j => (j.botId || j.assignee) === memberId) || null);
    }
    paintRoundtableSeats();
  };

  let collabLogDetails = null;
  let collabLogSummary = null;
  let collabLogBody = null;
  let whisperCount = 0;

  const ensureCollabLog = () => {
    if (!collabLogDetails || !timeline.contains(collabLogDetails)) {
      collabLogDetails = el('details', 'grok-collab-log');
      collabLogSummary = el('summary', 'grok-collab-log-summary', '✦ 成员协作记录');
      collabLogBody = el('div', 'grok-collab-log-body');
      collabLogDetails.append(collabLogSummary, collabLogBody);
      whisperCount = 0;
      timeline.append(collabLogDetails);
    }
    return { collabLogDetails, collabLogSummary, collabLogBody };
  };

  const appendWhisperOnce = (key, direction, memberId) => {
    if (!memberId || memberId === run.botId || emittedWhispers.has(key)) return;
    emittedWhispers.add(key);
    const { collabLogSummary: sumEl, collabLogBody: bodyEl } = ensureCollabLog();
    whisperCount++;
    sumEl.textContent = `✦ 成员协作与交接记录 (${whisperCount}) · 点击展开查看思路`;
    const marker = createWhisperMarker({
      direction,
      botId: memberId,
      botName: nameOf(memberId),
      avatarHtml: avatarOf?.(memberId, 16, 'idle') || '',
      onClick: bid => inspectMemberDirect(bid),
    });
    bodyEl.append(marker);
  };

  const ensureSeatNode = (memberId, isLead) => {
    let entry = seatCache.get(memberId);
    if (entry) return entry;

    const btn = el('button', `grok-seat star-seat ${isLead ? 'is-lead' : 'is-member'}`);
    btn.type = 'button';
    btn.dataset.memberId = memberId;

    const avatarWrap = el('span', 'grok-seat-avatar star-seat-ring');
    const avatarSlot = el('span', 'star-seat-avatar-slot');
    avatarWrap.append(avatarSlot);
    if (isLead) avatarWrap.append(el('span', 'star-lead-crown', '✦'));
    const dot = el('span', 'grok-seat-dot');
    avatarWrap.append(dot);

    const nameNode = el('span', 'grok-seat-name star-seat-label');

    const pop = el('div', 'seat-hover-card');
    const titleRow = el('div', 'seat-hover-title');
    const hoverName = el('strong', '');
    const hoverId = el('span', 'seat-hover-id');
    titleRow.append(hoverName, hoverId);
    const hoverState = el('div', 'seat-hover-state');
    const hoverDuty = el('div', 'seat-hover-duty');
    pop.append(titleRow, hoverState, hoverDuty);

    btn.append(avatarWrap, nameNode, pop);
    entry = {
      btn,
      avatarSlot,
      avatarMood: '',
      dot,
      nameNode,
      hoverName,
      hoverId,
      hoverState,
      hoverDuty,
      latestJob: null,
    };

    btn.onclick = () => {
      if (dock?.isOpen?.() && dock?.activeTab?.() === 'inspector' && dock?.inspectedMemberId?.() === memberId) {
        dock.close();
      } else if (isLead) {
        onInspectMember?.(memberId, {
          runId: run.id,
          isLead: true,
          job: '统筹拆解目标、并发调度群幕僚并交叉汇总最终答复',
          status,
          inspectorView: ownerInspectorView,
        });
      } else {
        onInspectMember?.(memberId, entry.latestJob);
      }
      paintRoundtableSeats();
    };

    seatCache.set(memberId, entry);
    return entry;
  };

  const syncSeatContent = (entry, { memberId, isLead, name, seatClass, dotClass, mood, avatarSize, stateLine, dutyLine, job }) => {
    if (entry.btn.className !== seatClass) entry.btn.className = seatClass;
    if (entry.dot.className !== dotClass) entry.dot.className = dotClass;
    if (entry.avatarMood !== mood) {
      entry.avatarMood = mood;
      entry.avatarSlot.innerHTML = avatarOf(memberId, avatarSize, mood);
    }
    if (entry.nameNode.textContent !== name) entry.nameNode.textContent = name;
    if (entry.hoverName.textContent !== name) entry.hoverName.textContent = name;
    const idTag = `#${String(memberId || '').slice(0, 10)}`;
    if (entry.hoverId.textContent !== idTag) entry.hoverId.textContent = idTag;
    if (entry.hoverState.textContent !== stateLine) entry.hoverState.textContent = stateLine;
    const nextDuty = dutyLine || '';
    if (entry.hoverDuty.textContent !== nextDuty) entry.hoverDuty.textContent = nextDuty;
    entry.hoverDuty.hidden = !nextDuty;
    if (!isLead) entry.latestJob = job || null;
  };

  const paintRoundtableSeats = () => {
    const ownerId = run.botId;
    const ownerName = nameOf(ownerId);
    const ownerThinking = isActive(status);
    const inspectedId = dock?.inspectedMemberId?.() || '';

    // Lead Star-Rail Seat (in-place DOM update to prevent hover flicker during streaming)
    const leadEntry = ensureSeatNode(ownerId, true);
    const leadStateText = !connected && ownerThinking ? '网络重连中…' : `群主统筹 · ${STATUS_LABELS[status] || status}`;
    syncSeatContent(leadEntry, {
      memberId: ownerId,
      isLead: true,
      name: ownerName,
      seatClass: `grok-seat star-seat is-lead status-${status}${inspectedId === ownerId ? ' is-selected' : ''}`,
      dotClass: `grok-seat-dot status-${status}`,
      mood: ownerThinking ? 'thinking' : 'idle',
      avatarSize: 34,
      stateLine: leadStateText,
      dutyLine: '点击旁路查看群主拆解思路与统筹进度',
    });

    // Build member list combining all group members + assigned jobs
    const assignedJobs = currentJobs.filter(j => !String(j.key || '').startsWith('owner:') && (j.botId || j.assignee) !== ownerId);
    const jobByBot = new Map();
    const jobByKey = new Map();
    for (const j of assignedJobs) {
      const mid = j.botId || j.assignee;
      if (mid) jobByBot.set(mid, j);
      if (j.id || j.jobId || j.key) jobByKey.set(j.id || j.jobId || j.key, j);
    }

    const rosterIds = (groupMembersOf?.() || []).filter(id => id && id !== ownerId);
    const allMemberIds = [...new Set([...jobByBot.keys(), ...rosterIds])];

    const desiredNodes = [leadEntry.btn];
    if (allMemberIds.length) {
      if (!seatDivider) seatDivider = el('span', 'grok-seat-divider');
      desiredNodes.push(seatDivider);
    }

    const seatElByBot = new Map([[ownerId, leadEntry.btn]]);
    const pendingRelays = [];
    const activeIds = new Set([ownerId, ...allMemberIds]);

    for (const mid of allMemberIds) {
      const job = jobByBot.get(mid);
      const mName = nameOf(mid);
      const mStatus = job ? (job.status || (job.dependsOn?.length ? 'waiting' : 'queued')) : 'idle';
      const mActive = isActive(mStatus);
      const microText = job?.inspectorView?.microStatus
        || (job ? (STATUS_LABELS[mStatus] || mStatus) : '静候调遣');

      const memberEntry = ensureSeatNode(mid, false);
      syncSeatContent(memberEntry, {
        memberId: mid,
        isLead: false,
        name: mName,
        seatClass: `grok-seat star-seat is-member status-${mStatus}${!job ? ' is-unassigned' : ''}${inspectedId === mid ? ' is-selected' : ''}`,
        dotClass: `grok-seat-dot status-${mStatus}`,
        mood: mActive ? 'thinking' : 'idle',
        avatarSize: 32,
        stateLine: microText,
        dutyLine: job?.job ? `分工：${job.job}` : '点击打开幕僚实时透视栏',
        job,
      });
      desiredNodes.push(memberEntry.btn);
      seatElByBot.set(mid, memberEntry.btn);

      const prevSt = prevMemberStates.get(mid);
      if (job && prevSt !== mStatus) {
        const deps = job.dependencies || job.dependsOn || [];
        if ((!prevSt || prevSt === 'idle') && (mStatus === 'queued' || mStatus === 'running')) {
          // Scene 1: Lead -> Member fan-out
          pendingRelays.push({ from: ownerId, to: mid, color: 'var(--color-accent)' });
        } else if (prevSt === 'waiting' && (mStatus === 'queued' || mStatus === 'running') && deps.length) {
          // Scene 2: Member A -> Member B dependency baton handoff!
          const depJob = jobByKey.get(deps[0]) || assignedJobs.find(x => x.status === 'completed' && (x.botId || x.assignee) !== mid);
          const fromBot = depJob ? (depJob.botId || depJob.assignee) : ownerId;
          pendingRelays.push({ from: fromBot || ownerId, to: mid, color: '#d97706' });
        }
      }
      prevMemberStates.set(mid, mStatus);
    }

    // Reconcile children in-place without tearing down existing hovered nodes
    for (const [cachedId, cachedEntry] of seatCache.entries()) {
      if (!activeIds.has(cachedId)) {
        cachedEntry.btn.remove();
        seatCache.delete(cachedId);
      }
    }
    if (!allMemberIds.length && seatDivider?.parentNode === seatsRow) {
      seatDivider.remove();
    }
    desiredNodes.forEach((node, idx) => {
      const currentAtIdx = seatsRow.children[idx];
      if (currentAtIdx !== node) {
        seatsRow.insertBefore(node, currentAtIdx || null);
      }
    });

    if (assignedJobs.length) {
      const doneCnt = assignedJobs.filter(j => j.status === 'completed').length;
      const pct = Math.round((doneCnt / assignedJobs.length) * 100);
      hairlineTrack.hidden = false;
      hairlineFill.style.width = `${Math.max(8, pct)}%`;
      hairlineFill.classList.toggle('is-complete', doneCnt === assignedJobs.length);

      // Scene 3: All members completed -> converge emerald light arcs back to Lead!
      if (doneCnt === assignedJobs.length && !convergedAnimated) {
        convergedAnimated = true;
        assignedJobs.forEach((j, idx) => {
          const mb = j.botId || j.assignee;
          if (mb && seatElByBot.has(mb)) {
            pendingRelays.push({ from: mb, to: ownerId, color: 'var(--color-success)', delay: idx * 80 });
          }
        });
      } else if (doneCnt < assignedJobs.length) {
        convergedAnimated = false;
      }
    } else {
      hairlineTrack.hidden = true;
      hairlineFill.style.width = '0%';
    }

    if (pendingRelays.length && roundtable.isConnected) {
      requestAnimationFrame(() => {
        pendingRelays.forEach((rel, idx) => {
          const fromNode = seatElByBot.get(rel.from);
          const toNode = seatElByBot.get(rel.to);
          if (fromNode && toNode) {
            shootRelayArc(roundtable, fromNode, toNode, {
              color: rel.color,
              delayMs: rel.delay !== undefined ? rel.delay : idx * 75,
            });
          }
        });
      });
    }
  };

  const syncDelegationCaption = () => {
    const assigned = currentJobs.filter(j => !String(j.key || '').startsWith('owner:') && (j.botId || j.assignee) !== run.botId);
    if (!assigned.length) {
      if (isActive(status)) {
        if (!delegationBanner) {
          delegationBanner = el('div', 'grok-delegation-hint is-live');
          timeline.append(delegationBanner);
        }
        delegationBanner.classList.add('is-live');
        delegationBanner.textContent = `✦ ${nameOf(run.botId)} 正在统筹分析与调度…`;
      } else if (delegationBanner) {
        delegationBanner.remove();
        delegationBanner = null;
      }
      return;
    }
    if (!delegationBanner) {
      delegationBanner = el('div', 'grok-delegation-hint');
      timeline.append(delegationBanner);
    }
    const names = [...new Set(assigned.map(j => nameOf(j.botId || j.assignee)))].join('、');
    const done = assigned.filter(j => j.status === 'completed').length;
    const runningNow = isActive(status) || assigned.some(j => isActive(j.status));
    delegationBanner.classList.toggle('is-live', runningNow);
    delegationBanner.textContent = runningNow
      ? `✦ ${names} 正在后台并行协办（${done}/${assigned.length} 完成）· 点顶栏头像可看思路`
      : `✦ 本轮经 ${names} 协办汇流`;
  };

  const setTeam = jobs => {
    currentJobs = Array.isArray(jobs) ? jobs : [];
    syncDelegationCaption();
    paintRoundtableSeats();
  };

  let liveOwnerStream = null;
  let pendingOwnerTextBuf = '';
  let turnInterimBubbles = [];

  const ensureLiveOwnerBubble = () => {
    if (liveOwnerStream && timeline.contains(liveOwnerStream.block)) return liveOwnerStream;
    const block = el('article', 'claude-assistant-turn is-group-lead grok-lead-bubble work-message is-streaming');
    const body = el('div', 'claude-assistant-body');
    block.append(body);
    timeline.append(block);
    liveOwnerStream = { block, body, text: '', rafId: 0 };
    return liveOwnerStream;
  };

  const sealLiveOwnerStream = ({ isFinal = false } = {}) => {
    pendingOwnerTextBuf = '';
    if (!liveOwnerStream) return null;
    const cur = liveOwnerStream;
    liveOwnerStream = null;
    if (cur.rafId) cancelAnimationFrame(cur.rafId);
    const clean = cur.text.trim();
    if (!clean) {
      cur.block.remove();
      return null;
    }
    cur.block.classList.remove('is-streaming');
    renderRichMessage(cur.body, clean);
    if (!isFinal && !turnInterimBubbles.includes(cur.block)) {
      turnInterimBubbles.push(cur.block);
    }
    return cur.block;
  };

  const foldInterimBubblesIntoCollabLog = finalBlock => {
    const toFold = turnInterimBubbles.filter(b => b && b !== finalBlock && timeline.contains(b));
    turnInterimBubbles = [];
    if (!toFold.length) return;
    const { collabLogDetails: detEl, collabLogSummary: sumEl, collabLogBody: bodyEl } = ensureCollabLog();
    for (const b of toFold) {
      b.classList.add('is-folded-interim');
      bodyEl.append(b);
      whisperCount++;
    }
    sumEl.textContent = `✦ 统筹与成员协作过程 (${whisperCount}) · 点击展开`;
    detEl.open = false;
    // Keep folded log right above final answer block
    if (finalBlock && finalBlock.parentNode === timeline) {
      timeline.insertBefore(detEl, finalBlock);
    }
  };

  const settleOwnerTurn = (text, messageEvent, { isFinal = false } = {}) => {
    pendingOwnerTextBuf = '';
    const clean = String(text || '').trim();
    if (!clean) {
      sealLiveOwnerStream({ isFinal });
      return null;
    }
    if (liveOwnerStream && timeline.contains(liveOwnerStream.block)) {
      const cur = liveOwnerStream;
      liveOwnerStream = null;
      if (cur.rafId) cancelAnimationFrame(cur.rafId);
      cur.block.classList.remove('is-streaming');
      renderRichMessage(cur.body, clean);
      if (messageEvent) decorateMessage(cur.block, messageEvent, { nameOf, onQuote });
      if (!isFinal && !turnInterimBubbles.includes(cur.block)) {
        turnInterimBubbles.push(cur.block);
      }
      return cur.block;
    }
    // Deduplicate if identical to the last interim bubble just sealed
    const lastInterim = turnInterimBubbles[turnInterimBubbles.length - 1];
    if (lastInterim && timeline.contains(lastInterim) && lastInterim.querySelector('.claude-assistant-body')?.textContent.trim() === clean) {
      if (isFinal) {
        turnInterimBubbles.pop();
        if (messageEvent) decorateMessage(lastInterim, messageEvent, { nameOf, onQuote });
      }
      return lastInterim;
    }
    const block = el('article', 'claude-assistant-turn is-group-lead grok-lead-bubble work-message');
    const body = el('div', 'claude-assistant-body');
    renderRichMessage(body, clean);
    block.append(body);
    if (messageEvent) decorateMessage(block, messageEvent, { nameOf, onQuote });
    timeline.append(block);
    if (!isFinal) turnInterimBubbles.push(block);
    return block;
  };

  const appendOwnerTurn = (text, messageEvent, opts) => settleOwnerTurn(text, messageEvent, opts);

  const update = next => {
    if (status !== next) {
      const fileStatus = artifactStrip.querySelector('.deliverable-run-status');
      if (fileStatus) fileStatus.textContent = (STATUS_LABELS[next] || next) + ' · ';
    }
    status = next;
    root.dataset.status = status;
    handoffBtn.hidden = !handoffAvailable;
    if (!isActive(status)) {
      sealLiveOwnerStream();
    }
    ownerInspectorView.update(status);
    syncDelegationCaption();
    paintRoundtableSeats();
  };

  const accept = event => {
    if (!Number.isSafeInteger(event.seq) || event.seq <= lastSeq) return false;
    changeTranscript(transcript, () => {
      lastSeq = event.seq;
      const fromOwner = !event.from || event.from === 'user' || event.from === run.botId;
      if (fromOwner) {
        ownerInspectorView.accept(event);
      }

      if (event.kind === 'team') {
        sealLiveOwnerStream();
        const nextJobs = Array.isArray(event.assignments) ? event.assignments : [];
        for (const j of nextJobs) {
          const mid = j.botId || j.assignee;
          const jid = j.runId || j.key || j.jobId || mid;
          if (!mid || mid === run.botId) continue;
          if (['queued', 'running', 'planning'].includes(j.status)) {
            appendWhisperOnce(`to:${jid}`, 'to', mid);
          } else if (j.status === 'completed') {
            appendWhisperOnce(`to:${jid}`, 'to', mid);
            appendWhisperOnce(`from:${jid}`, 'from', mid);
          }
        }
        setTeam(nextJobs);
      } else if (event.kind === 'tool') {
        if (fromOwner) sealLiveOwnerStream();
      } else if (event.kind === 'member-whisper' && event.whisper) {
        sealLiveOwnerStream();
        const w = event.whisper;
        const wKey = `${w.direction || 'to'}:${w.childRunId || w.id || event.seq}`;
        appendWhisperOnce(wKey, w.direction || 'to', w.botId);
      } else if (event.kind === 'choice-prompt' && event.choice) {
        sealLiveOwnerStream();
        timeline.append(createChoicePromptCard({
          question: event.choice.question,
          options: event.choice.options,
          onSelect: value => onSelectChoice?.(value),
        }));
      } else if (event.kind === 'input') {
        sealLiveOwnerStream();
        const rawText = String(event.text || '');
        const isInternalCallback = Boolean(event.context?.memberCallback) || rawText.startsWith('[[MEMBER_CALLBACK]]');
        if (isInternalCallback && event.context?.fromBotId) {
          appendWhisperOnce(`from:${event.context.childRunId || event.seq}`, 'from', event.context.fromBotId);
        }
        if (event.from === 'user' && !isInternalCallback) {
          markErrorsStale(timeline);
          answerBlock = null;
          delegationBanner = null;
          collabLogDetails = null;
          turnInterimBubbles = [];
          const turn = el('div', 'bubble user claude-user-turn');
          renderWorkUserTurnContent(turn, rawText);
          decorateMessage(turn, event, { nameOf, onQuote });
          timeline.append(turn);
        }
      } else if (event.kind === 'commentary') {
        if (fromOwner && event.from !== 'user' && event.text) {
          const chunk = String(event.text);
          if (!liveOwnerStream) {
            pendingOwnerTextBuf += chunk;
            if (!pendingOwnerTextBuf.trim()) return;
            const cur = ensureLiveOwnerBubble();
            cur.text = pendingOwnerTextBuf;
            pendingOwnerTextBuf = '';
            cur.body.textContent = cur.text;
            return;
          }
          const cur = ensureLiveOwnerBubble();
          cur.text += chunk;
          if (!cur.rafId) {
            cur.rafId = requestAnimationFrame(() => {
              cur.rafId = 0;
              if (liveOwnerStream === cur) {
                cur.body.textContent = cur.text;
              }
            });
          }
        }
      } else if (event.kind === 'say' || event.kind === 'plan') {
        if (fromOwner && event.from !== 'user') {
          if (String(event.text || '').trim()) {
            appendOwnerTurn(event.text, event, { isFinal: false });
          } else {
            sealLiveOwnerStream();
          }
        }
      } else if (event.kind === 'team-result' || event.kind === 'answer' || (event.kind === 'result' && (!event.taskId || event.taskId === run.id))) {
        const isTerminalFailure = event.kind === 'result'
          && event.status
          && event.status !== 'completed'
          && event.status !== 'partial';
        if (isTerminalFailure) {
          sealLiveOwnerStream({ isFinal: true });
          if (event.status !== 'cancelled' && String(event.text || '').trim()) {
            timeline.append(buildWorkErrorBanner(event.text, { status: event.status, onContinue }));
          }
        } else if (String(event.text || '').trim()) {
          if (!answerBlock) {
            answerBlock = appendOwnerTurn(event.text, event, { isFinal: true });
          } else {
            sealLiveOwnerStream({ isFinal: true });
            const body = answerBlock.querySelector('.claude-assistant-body');
            if (body) renderRichMessage(body, event.text);
            decorateMessage(answerBlock, event, { nameOf, onQuote });
          }
          foldInterimBubblesIntoCollabLog(answerBlock);
        } else {
          sealLiveOwnerStream({ isFinal: true });
        }
        onArtifacts(event.taskId || run.id, filesHiddenStore);
      } else if (event.kind === 'result' && event.taskId && event.taskId !== run.id) {
        onArtifacts(event.taskId, filesHiddenStore);
      } else if (event.kind === 'run-state') {
        if (event.status === 'running') answerBlock = null;
        update(event.status);
      } else if (event.kind === 'approval') {
        onApproval(event.botId);
      } else if (event.kind === 'error' && fromOwner) {
        timeline.append(buildWorkErrorBanner(event.text, { status: event.status || 'failed', fallback: '统筹任务出错', onContinue }));
      }
    });
    return true;
  };

  if (run.detailsLoaded === false && (run.answer || run.error)) {
    if (run.error) timeline.append(buildWorkErrorBanner(run.error, { status: run.status, onContinue }));
    else if (run.answer) answerBlock = appendOwnerTurn(run.answer, { text: run.answer, from: run.botId });
  }

  const renderArtifactChips = ({ files = [], changes = [], sandboxCheckouts = [], checkpoints = [] }) => {
    renderDeliverablePackageZone({
      run, status, files, changes, sandboxCheckouts, checkpoints, artOpenBtn, artifactStrip, dock, api, isGroup: true, fallbackCwd,
    });
  };

  const presentApprovals = (rows, handlers = {}) => syncApprovalZone(
    approvalZone, rows, row => buildApprovalCard(row, { nameOf, isGroup: true, handlers }),
  );

  setTeam(run.assignments || []);
  update(status);

  return {
    root,
    files: filesHiddenStore,
    accept,
    setTeam: jobs => changeTranscript(transcript, () => setTeam(jobs)),
    update: next => changeTranscript(transcript, () => update(next)),
    setTitle: text => {
      const nextRaw = String(text || '');
      if (nextRaw !== lastRawTitle) {
        lastRawTitle = nextRaw;
        renderWorkUserTurnContent(firstUserText, nextRaw);
      }
      ownerInspectorView.setTitle(text);
    },
    ownerInspectorView,
    setEmbedded: () => {},
    renderArtifactChips,
    presentApprovals,
    refreshSeats: paintRoundtableSeats,
    dispose: () => viewAbort.abort(),
    setConnected: val => { connected = val; update(status); },
    setHandoffAvailable: val => { handoffAvailable = val === true; update(status); },
    advanceCursor: seq => { if (Number.isSafeInteger(seq)) lastSeq = Math.max(lastSeq, seq); },
    get lastSeq() { return lastSeq; },
    get status() { return status; },
    get detailsLoaded() { return run.detailsLoaded !== false; },
  };
}

export function createWorkSessionUi({
  api,
  getTranscript,
  nameOf = id => id,
  avatarOf = () => '',
  groupMembersOf = () => [],
  getProjectCwd = () => '',
  onPickProjectCwd,
  dock,
  onBusy = () => {},
  onApproval = () => {},
  onDiscuss = () => {},
  onQuote = () => {},
  onChange = () => {},
  onThreadChanged = () => {},
}) {
  let scope = null; // { botId, groupId? }
  let controller = null;
  let poll = undefined;
  let version = 0;
  let revealVersion = 0;
  let records = [];
  let rootViews = new Map();       // rootRunId -> ClaudeSoloView | GrokGroupView
  let inspectorViews = new Map();  // childRunId -> MemberInspectorView
  let streams = new Map();         // runId -> EventSource
  let loadingDetails = new Set();
  let deleted = new Set();
  let artifactMap = new Map();     // rootRunId -> { filesByTask: Map, changesByTask: Map }
  let focusedRootId = '';
  let newThreadMode = false;
  let handoffAvailable = false;
  let dismissHandoff = null;
  let refreshTask = null;
  let retrySubmission = null;
  let approvalRows = [];
  let approvalHandlers = {};
  let inspectedMemberId = '';

  const query = before => new URLSearchParams({
    botId: scope.botId,
    ...(scope.groupId ? { groupId: scope.groupId } : {}),
    limit: '30',
    ...(before ? { before } : {}),
    cursors: JSON.stringify(Object.fromEntries([
      ...[...rootViews].map(([id, v]) => [id, v.lastSeq]),
      ...[...inspectorViews].map(([id, v]) => [id, v.lastSeq]),
    ])),
  });

  const topLevelRecords = () => workTaskGroups(records).groups.map(g => g.root);

  const syncBusy = () => {
    // 只反映当前聚焦线程（根任务）是否在运行；其他线程在跑时不显示停止按钮，避免误停。
    const focused = !newThreadMode && focusedRootId ? records.find(r => r.id === focusedRootId) : null;
    if (focused && isActive(focused.status)) {
      onBusy(true, focused.id, focused.botId);
      return;
    }
    onBusy(false, null, null);
  };

  const syncConnection = ok => {
    connectionOk = ok;
    for (const view of rootViews.values()) view.setConnected(ok);
  };

  // P1：常驻轮询节流——后台跳过；连接正常且没有活动任务时降到 20s 一次。
  const POLL_BASE_MS = 4000;
  const POLL_IDLE_MS = 20000;
  let connectionOk = true;
  let lastRefreshAt = 0;
  const pollTick = () => {
    if (!scope || document.hidden) return;
    const hasActive = records.some(r => isActive(r.status)) || streams.size > 0;
    if (!hasActive && connectionOk && Date.now() - lastRefreshAt < POLL_IDLE_MS) return;
    void refresh();
  };

  const showNotice = (msg, level = 'error') => {
    if (!msg) return;
    // P1：优先走全局 toast（app.js 暴露），不再往 transcript 末尾塞红框。
    if (typeof window.__dimensionToast === 'function') {
      try {
        window.__dimensionToast(msg, { level });
        return;
      } catch {}
    }
    const transcript = getTranscript();
    if (!transcript) return;
    const banner = el('div', 'work-inline-error', msg);
    transcript.append(banner);
    setTimeout(() => { if (banner.isConnected) banner.remove(); }, 6000);
  };

  // Root views own document-level listeners; always dispose the one being replaced.
  const setRootView = (id, view) => {
    const prev = rootViews.get(id);
    if (prev && prev !== view) prev.dispose?.();
    rootViews.set(id, view);
  };
  const disposeAllRootViews = () => {
    for (const v of rootViews.values()) v.dispose?.();
  };

  // Handoff Package Export Dialog (kept 100% compatible with task_handoff backend)
  const showHandoff = id => {
    dismissHandoff?.();
    const record = records.find(row => row.id === id);
    if (!record) return;
    const previousFocus = document.activeElement;
    const dialog = el('dialog', 'work-model-dialog work-handoff-dialog');
    dialog.setAttribute('aria-label', '导出任务交接包');
    const head = el('header', '');
    head.append(el('h2', '', '导出对话交接包'));
    const closeBtn = el('button', 'work-action', '关闭'); closeBtn.type = 'button';
    head.append(closeBtn);
    const intro = el('p', '', '导出当前项目对话的要求、进度、幕僚分工与最终结论，不含任何密钥或登录状态。');
    const choice = el('label', 'bot-archive-choice');
    const includeFiles = document.createElement('input');
    includeFiles.type = 'checkbox'; includeFiles.checked = true;
    const choiceText = el('span', 'bot-archive-choice-main');
    choiceText.append(el('strong', '', '附带成果文件'), el('small', '', '单文件最多 8 MiB，附件合计最多 16 MiB，完整交接包最多 24 MiB。'));
    choice.append(includeFiles, choiceText);
    const selection = el('p', 'wm-status', '正在统计附件…');
    selection.setAttribute('aria-live','polite');
    const status = el('p', 'wm-status'); status.hidden = true;
    status.setAttribute('role','status');
    const footer = el('footer', '');
    const cancel = el('button', 'work-action', '取消'); cancel.type = 'button';
    const download = el('button', 'work-action is-primary', '下载交接包'); download.type = 'button';
    footer.append(cancel, download);
    dialog.append(head, intro, choice, selection, status, footer);

    let disposed = false, reqCtrl = null;
    const preview = new AbortController();
    let files = null;
    const updateSelection = () => {
      if (!includeFiles.checked) { selection.textContent = '已选 0 个附件，仅导出任务资料。'; return; }
      if (!files) { selection.textContent = previewFailed ? '未取得附件统计，可重试导出。' : '正在统计附件…'; return; }
      const total = files.reduce((sum,f) => sum + Number(f.declaredBytes),0);
      const oversize = files.filter(f => Number(f.declaredBytes) > 8 * 1024 * 1024);
      const missing = files.filter(f => !f.availableAtSnapshot);
      const size = total < 1024 ? total + ' B' : total < 1048576 ? (total / 1024).toFixed(1) + ' KiB' : (total / 1048576).toFixed(2) + ' MiB';
      const parts = [`已选 ${files.length} 个附件，共 ${size}。`];
      if (oversize.length) parts.push('超过单文件上限：' + oversize.map(f=>f.name).join('、') + '。');
      if (total > 16 * 1048576) parts.push('附件合计超过 16 MiB。');
      if (missing.length) parts.push('文件缺失：' + missing.map(f=>f.name).join('、') + '。');
      selection.textContent = parts.join(' ');
    };
    let previewFailed = false;
    includeFiles.onchange = updateSelection;
    const requestPackage = (include,signal) => fetch(`/api/dimension/work/runs/${encodeURIComponent(id)}/handoff`, {
      method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json', Accept:'application/json'},
      body:JSON.stringify({includeFiles:include}), signal
    });
    requestPackage(false,preview.signal).then(async res => {
      if (!res.ok) throw new Error();
      const meta = await res.json();
      files = meta.artifacts.filter(f=>f.reason !== 'protected-runtime-or-account-material');
    }).catch(()=>{ previewFailed = true; }).finally(()=>{ if (!disposed) updateSelection(); });
    const dismiss = () => {
      if (disposed) return;
      disposed = true; preview.abort(); reqCtrl?.abort();
      if (dialog.open) dialog.close();
      dialog.remove();
      if (dismissHandoff === dismiss) dismissHandoff = null;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
    dismissHandoff = dismiss;
    closeBtn.onclick = dismiss; cancel.onclick = dismiss;
    dialog.addEventListener('cancel', e => { e.preventDefault(); dismiss(); });

    download.onclick = async () => {
      if (reqCtrl || disposed) return;
      reqCtrl = new AbortController();
      download.disabled = true; includeFiles.disabled = true;
      download.textContent = '正在导出…'; status.hidden = true;
      try {
        const res = await requestPackage(includeFiles.checked, reqCtrl.signal);
        if (!res.ok) {
          const detail = await res.json().catch(()=>({}));
          const reasons = {
            handoff_file_too_large:'单个附件超过 8 MiB，可取消附带文件后导出。',
            handoff_attachment_limit:'附件合计超过 16 MiB，可取消附带文件后导出。',
            handoff_package_limit:'完整交接包超过 24 MiB，请减少导出内容。',
            handoff_item_limit:'成果或子任务数量超过导出上限。',
            handoff_text_limit:'任务文本超过导出上限。',
            handoff_redaction_limit:'任务内容超过脱敏处理上限。',
            handoff_file_missing:'成果文件缺失，可取消附带文件后导出。',
            handoff_file_changed:'成果文件在导出时发生变化，请重试。'
          };
          throw new Error(reasons[detail.error] || `导出失败（HTTP ${res.status}），请稍后重试。`);
        }
        const filename = /filename="(dimension-task-[a-f0-9]{16}\.json)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || `dimension-task-${id.slice(0, 8)}.json`;
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = filename;
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        dismiss();
      } catch (err) {
        if (!disposed && err.name !== 'AbortError') {
          status.textContent = err.message || '导出失败'; status.hidden = false;
        }
      } finally {
        reqCtrl = null;
        if (!disposed) { download.disabled = false; includeFiles.disabled = false; download.textContent = '下载交接包'; }
      }
    };
    document.body.append(dialog);
    dialog.showModal();
  };

  // Sync artifacts, checkpoints & 0.4.2 file-changes into both inline chips and the right-side Work Dock
  const checkpointRequests = new Map();
  const taskRequests = new Map();
  const paintArtifacts = rootId => {
    if (rootId === focusedRootId && !newThreadMode) syncFocusedArtifactsToUi(rootId, { autoReveal: true });
  };

  const refreshCheckpoints = (rootId, bucket) => {
    if (checkpointRequests.has(rootId)) return checkpointRequests.get(rootId);
    const request = api(`/api/dimension/work/runs/${encodeURIComponent(rootId)}/checkpoints`)
      .then(data => {
        if (!Array.isArray(data?.checkpoints)) throw new Error('检查点响应无效');
        bucket.checkpoints = data.checkpoints;
        bucket.errors.delete('checkpoints');
      }).catch(() => bucket.errors.set('checkpoints', '检查点'))
      .finally(() => {
        if (checkpointRequests.get(rootId) === request) checkpointRequests.delete(rootId);
        if (artifactMap.get(rootId) === bucket) paintArtifacts(rootId);
      });
    checkpointRequests.set(rootId, request);
    return request;
  };

  const loadArtifactsForTask = async (taskId) => {
    const { rootOf } = workTaskGroups(records);
    const rootId = rootOf.get(taskId) || taskId;
    if (!artifactMap.has(rootId)) {
      artifactMap.set(rootId, { filesByTask: new Map(), changesByTask: new Map(), sandboxByTask: new Map(), checkpoints: [], errors: new Map() });
    }
    const bucket = artifactMap.get(rootId);
    const token = Symbol();
    taskRequests.set(taskId, token);
    const checkpointsReady = refreshCheckpoints(rootId, bucket);
    const id = encodeURIComponent(taskId);
    const [files, changes, sandbox] = await Promise.allSettled([
      api(`/api/dimension/work/tasks/${id}/artifacts`),
      api(`/api/dimension/work/runs/${id}/file-changes`),
      api(`/api/dimension/work/runs/${id}/sandbox-diff`),
    ]);
    if (!scope || artifactMap.get(rootId) !== bucket || taskRequests.get(taskId) !== token) return;
    taskRequests.delete(taskId);
    const taskRec = records.find(r => r.id === taskId);
    const ownerName = scope.groupId && taskRec?.botId ? nameOf(taskRec.botId) : '';
    const received = (result, valid, label) => {
      const key = `${taskId}:${label}`;
      if (result.status === 'fulfilled' && valid) {
        bucket.errors.delete(key);
        return true;
      }
      bucket.errors.set(key, label);
      return false;
    };
    if (received(files, Array.isArray(files.value?.files), '文件')) {
      bucket.filesByTask.set(taskId, files.value.files.map(f => ({ ...f, ownerName })));
    }
    if (received(changes, Array.isArray(changes.value?.changes), '变更')) {
      bucket.changesByTask.set(taskId, changes.value.changes);
    }
    const info = sandbox.value;
    if (received(sandbox, info && (info.checkout === null || Array.isArray(info.diff?.changes)), '沙盒差异')) {
      if (info.checkout && info.diff?.changes?.length) {
        bucket.sandboxByTask.set(taskId, { taskId, ownerName, checkout: info.checkout, diff: info.diff });
      } else bucket.sandboxByTask.delete(taskId);
    }
    paintArtifacts(rootId);
    await checkpointsReady;
  };

  const buildOverviewPayload = rootId => {
    const { groups } = workTaskGroups(records);
    const grp = groups.find(g => g.root.id === rootId);
    const rootRec = grp?.root || records.find(r => r.id === rootId);
    if (!rootRec) return { steps: [], uploads: [] };

    // 1. Uploads: Workspace folder + Reference images
    const uploads = [];
    const proj = rootRec.workspace?.project || getProjectCwd?.() || '';
    const isManaged = !proj || String(proj).startsWith('\\\\') || String(proj).includes('/var/lib/dimension/managed');
    if (!isManaged) {
      const folderName = String(proj).replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || proj;
      uploads.push({ kind: 'folder', name: folderName, fullPath: proj });
    } else {
      uploads.push({ kind: 'folder', name: '隔离沙盒工作台', fullPath: '' });
    }

    const seenImgs = new Set();
    const scanImgs = txt => {
      const s = String(txt || '');
      let m;
      CHAT_IMG_TAG_RE.lastIndex = 0;
      while ((m = CHAT_IMG_TAG_RE.exec(s)) !== null) {
        if (!seenImgs.has(m[1])) {
          seenImgs.add(m[1]);
          uploads.push({
            kind: 'image',
            name: `参考图片 ${seenImgs.size}`,
            ext: 'PNG',
            imageUrl: `/api/dimension/chat/images/${encodeURIComponent(m[1])}`,
          });
        }
      }
    };
    scanImgs(rootRec.text);
    for (const ev of rootRec.events || []) {
      if (ev.kind === 'input' && ev.from === 'user') scanImgs(ev.text);
    }

    // 2. Progress Steps: Prefer structured todo_write if available, else synthesize clean milestones
    let explicitTodos = null;
    const allRuns = grp ? grp.runs : [rootRec];
    for (const r of allRuns) {
      for (const ev of r.events || []) {
        if (ev.kind === 'tool' && ev.tool?.name === 'todo_write' && ev.tool.status === 'completed' && ev.tool.args) {
          try {
            const parsed = typeof ev.tool.args === 'string' ? JSON.parse(ev.tool.args) : ev.tool.args;
            if (Array.isArray(parsed?.todos) && parsed.todos.length) {
              explicitTodos = parsed.todos.map(t => ({
                label: String(t.content || t.title || t.text || '').trim(),
                status: t.status === 'in_progress' ? 'running' : (t.status === 'completed' ? 'completed' : 'pending'),
              })).filter(t => t.label);
            }
          } catch {}
        }
      }
    }

    const steps = [];
    const byCall = new Map();
    function addStep(label, status, key) {
      if (key && byCall.has(key)) {
        byCall.get(key).status = status;
        return;
      }
      const step = {label, status};
      steps.push(step);
      if (key) byCall.set(key, step);
    }
    const settledStatus = (status, runStatus) =>
      status === 'running' && !isActive(runStatus) ? 'unconfirmed' : status;

    if (rootRec.groupId && Array.isArray(rootRec.assignments) && rootRec.assignments.length) {
      for (const job of rootRec.assignments) {
        const bid = job.botId || job.assignee;
        if (!bid || bid === rootRec.botId) continue;
        const jStat = isActive(job.status) ? 'running' : job.status || 'pending';
        const brief = String(job.job || '协办专项任务').split(/\r?\n/)[0].slice(0, 28);
        const route = job.actualRoute?.model ? ` · Work ${job.actualRoute.providerId}/${job.actualRoute.model}` : '';
        const cli = job.cliRoute?.engine ? ` · ${job.cliRoute.engine} 启动模型：${job.cliRoute.model || 'CLI 默认'}` : '';
        addStep(`${nameOf(bid)}：${brief}${route}${cli}`, jStat);
      }
    }

    for (const r of allRuns) {
      for (const ev of r.events || []) {
        if (ev.kind === 'cli-step' && ev.step) {
          const s = ev.step;
          if (!['tool_start','tool_end'].includes(s.kind) || !['edit','command'].includes(s.actionCategory)) continue;
          const st = s.kind === 'tool_start' ? 'running' : s.isError || s.exitCode > 0 ? 'failed' : 'completed';
          const label = s.displayTarget || s.displayVerb || (s.actionCategory === 'edit' ? '编辑文件' : '执行命令');
          const key = s.toolCallId && JSON.stringify([r.id,'cli',s.toolCallId]);
          if (s.kind === 'tool_start') byCall.delete(key);
          addStep(label, settledStatus(st, r.status), key);
        } else if (ev.kind === 'tool' && ev.tool) {
          const t = ev.tool;
          const labels = {write_file:'写入', edit_file:'编辑', run_command:'执行命令', sandbox_exec:'沙盒命令',
            run_in_vm:'虚拟机命令', verify_file:'核验文件'};
          if (!Object.hasOwn(labels,t.name)) continue;
          const target = summarizeToolTarget(t.name,t.args);
          const key = t.callId && JSON.stringify([r.id,'tool',t.callId]);
          if (t.status === 'running') byCall.delete(key);
          addStep([labels[t.name],target].filter(Boolean).join(' '), settledStatus(t.status || 'unconfirmed',r.status), key);
        }
      }
    }
    if (explicitTodos) {
      const todos = explicitTodos.map(t => ({...t,status:settledStatus(t.status,rootRec.status)}));
      return {steps:[...todos,...steps], uploads};
    }
    return {steps, uploads};
  };

  const syncOverviewToDock = (rootId, { autoReveal = false } = {}) => {
    if (!rootId || rootId !== focusedRootId || newThreadMode) return;
    const { steps, uploads } = buildOverviewPayload(rootId);
    dock?.updateOverview?.({ runId: rootId, steps, uploads, autoReveal });
  };

  const syncFocusedArtifactsToUi = (rootId, { autoReveal = false } = {}) => {
    const view = rootViews.get(rootId);
    const bucket = artifactMap.get(rootId);
    const allFiles = bucket ? [...bucket.filesByTask.values()].flat() : [];
    const seenUrls = new Set();
    const dedupedFiles = allFiles.filter(f => {
      if (!f?.url || seenUrls.has(f.url)) return false;
      seenUrls.add(f.url);
      return true;
    });
    const allChanges = bucket ? [...bucket.changesByTask.values()].flat() : [];
    const allSandbox = bucket?.sandboxByTask ? [...bucket.sandboxByTask.values()] : [];
    const checkpoints = bucket?.checkpoints || [];
    syncOverviewToDock(rootId, { autoReveal: false });
    view?.renderArtifactChips({ files: dedupedFiles, changes: allChanges, sandboxCheckouts: allSandbox, checkpoints });
    const failed = [...new Set(bucket?.errors?.values() || [])];
    const warning = failed.length ? `${failed.join('、')}刷新失败，可重试。` : '';
    dock?.updateArtifacts({ runId: rootId, warning, files: dedupedFiles, changes: allChanges, sandboxCheckouts: allSandbox, checkpoints, autoReveal });
  };

  const inspectMember = (memberId, job) => {
    inspectedMemberId = memberId;
    const childRunId = job?.runId || '';
    let bodyNode = null;
    if (job?.isLead && job?.inspectorView) {
      const rootRec = records.find(r => r.id === childRunId);
      if (rootRec && rootRec.detailsLoaded === false) {
        void loadDetails(childRunId);
      }
      bodyNode = job.inspectorView.root;
    } else if (childRunId) {
      const childRec = records.find(r => r.id === childRunId);
      if (childRec && childRec.detailsLoaded === false) {
        void loadDetails(childRunId);
      }
      bodyNode = inspectorViews.get(childRunId)?.root || null;
    } else {
      bodyNode = el('div', 'work-dock-empty', job
        ? `正在等待前置依赖完成后启动（职责：${job.job || '协办'}）`
        : '群主在本轮对话中尚未向该成员分派具体子任务。');
    }
    const statusCode = job?.status || 'idle';
    const statusLabel = job?.inspectorView?.microStatus || (job ? (STATUS_LABELS[statusCode] || statusCode) : '待命');
    dock?.openInspector({
      memberId,
      memberName: job?.isLead ? `${nameOf(memberId)} · 群主` : nameOf(memberId),
      avatarHtml: avatarOf(memberId, 40, isActive(statusCode) ? 'thinking' : 'idle'),
      roleText: job?.job || '作为群幕僚待命，随时响应群主并发调遣',
      statusCode,
      statusLabel,
      bodyNode,
    });
  };

  const syncLiveInspector = () => {
    if (!inspectedMemberId || !dock?.isOpen() || dock?.activeTab() !== 'inspector') return;
    if (!focusedRootId) return;
    const { groups } = workTaskGroups(records);
    const curGroup = groups.find(g => g.root.id === focusedRootId);
    if (!curGroup) return;
    if (curGroup.root.botId === inspectedMemberId) {
      const rootView = rootViews.get(focusedRootId);
      const leadInsp = rootView?.ownerInspectorView;
      const statusCode = curGroup.root.status || 'idle';
      dock.updateInspector({
        memberId: inspectedMemberId,
        memberName: `${nameOf(inspectedMemberId)} · 群主`,
        avatarHtml: avatarOf(inspectedMemberId, 40, isActive(statusCode) ? 'thinking' : 'idle'),
        roleText: '统筹拆解目标、并发调度群幕僚并交叉汇总最终答复',
        statusCode,
        statusLabel: leadInsp?.microStatus || STATUS_LABELS[statusCode] || statusCode,
        bodyNode: leadInsp?.root || el('div', 'work-dock-empty', '暂无统筹调度记录'),
      });
      return;
    }
    const childRec = curGroup.runs.find(r => r.id !== focusedRootId && r.botId === inspectedMemberId);
    const rawAssign = (curGroup.root.assignments || []).find(a => (a.botId || a.assignee) === inspectedMemberId);
    const inspView = childRec ? inspectorViews.get(childRec.id) : null;
    const statusCode = childRec?.status || rawAssign?.status || 'idle';
    dock.updateInspector({
      memberId: inspectedMemberId,
      memberName: nameOf(inspectedMemberId),
      avatarHtml: avatarOf(inspectedMemberId, 40, isActive(statusCode) ? 'thinking' : 'idle'),
      roleText: childRec?.text || rawAssign?.job || '群幕僚协办',
      statusCode,
      statusLabel: inspView?.microStatus || STATUS_LABELS[statusCode] || statusCode,
      bodyNode: inspView?.root || el('div', 'work-dock-empty', '等待群主分派…'),
    });
  };

  const renderNewThreadWelcome = () => {
    const transcript = getTranscript();
    if (!transcript || !scope) return;
    transcript.replaceChildren();
    const box = el('section', 'work-new-thread-stage');
    const av = el('div', 'work-new-avatar');
    av.innerHTML = avatarOf(scope.botId, 64, 'idle');
    const title = el('h2', 'work-new-title',
      scope.groupId
        ? `召集首席「${nameOf(scope.botId)}」开启圆桌作战会议`
        : `与「${nameOf(scope.botId)}」缔结新的灵感委托`
    );
    const sub = el('p', 'work-new-sub',
      scope.groupId
        ? '你只需与首席主理一对一自然交谈；同席幕僚将在幕后并行推演、各展所长，再由主理交叉淬炼后向你呈报。'
        : '每一卷委托皆享独立记忆视界与专属右侧成品宝匣，随时可在左栏卷宗树中重拾续写。'
    );

    const cwdCard = el('div', 'work-new-cwd-card');
    const setCwdVisual = (target, cwdStr) => {
      target.innerHTML = `${svgIcon(cwdStr ? 'folder' : 'box', 13)} `;
      target.append(document.createTextNode(cwdStr ? `工作目录：${cwdStr}` : '工作目录：隔离沙盒'));
    };
    const curCwd = getProjectCwd?.() || '';
    const cwdLabel = el('span', 'work-new-cwd-text');
    setCwdVisual(cwdLabel, curCwd);
    cwdCard.append(cwdLabel);
    if (onPickProjectCwd) {
      const pickBtn = el('button', 'claude-bar-btn', '绑定本地工程目录');
      pickBtn.type = 'button';
      pickBtn.onclick = async () => {
        await onPickProjectCwd();
        setCwdVisual(cwdLabel, getProjectCwd?.() || '');
      };
      cwdCard.append(pickBtn);
    }

    const starters = scope.groupId
      ? [
          { icon: 'sparkles', title: '圆桌多维推演策论', desc: '众幕僚各抒奇谋，首席交叉挑错成案', prompt: '请召集各成员从各自专长视角独立推演一套完整方案，再由你交叉挑错并整理为可直接落地的最终方案：\n' },
          { icon: 'box', title: '合力锻造开箱成品匣', desc: '界面与内核分头铸造，打包为完整交付物', prompt: '请分工协作构建一个直接可运行的网页应用成品（写入 deliverables/），附上本地运行说明：\n' },
          { icon: 'wrench', title: '工程结界隐患大巡检', desc: '并发深挖瓶颈与暗礁，呈递优先级改造榜', prompt: '请安排成员并发审查当前项目的潜在缺陷、性能瓶颈与体验短板，汇总一份按优先级排序的改造方案。' },
        ]
      : [
          { icon: 'box', title: '锻造开箱即用小神器', desc: '自动封入整洁文件夹或 .zip 成品宝匣', prompt: '请帮我开发一个界面精致、双击即可运行的单页工具（放入 deliverables/ 目录）：\n' },
          { icon: 'folder', title: '研读或重塑本地工程', desc: '洞悉代码脉络，支持安全 Diff 审阅回写', prompt: '请先梳理当前项目目录的核心结构，然后针对以下需求给出修改方案并落地验证：\n' },
          { icon: 'sparkles', title: '深度考据与企划手札', desc: '去芜存菁，直接呈递论据扎实的成稿', prompt: '请围绕以下主题做一份深入、论据扎实且可直接执行的结构化方案报告：\n' },
        ];

    const starterGrid = el('div', 'work-starter-grid');
    for (const s of starters) {
      const cardBtn = el('button', 'work-starter-card');
      cardBtn.type = 'button';
      const head = el('span', 'work-starter-head');
      head.innerHTML = `${svgIcon(s.icon, 14)}<span>${s.title}</span>`;
      const desc = el('span', 'work-starter-desc', s.desc);
      cardBtn.append(head, desc);
      cardBtn.onclick = () => {
        const input = document.getElementById('composerInput');
        if (!input) return;
        input.value = s.prompt;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      };
      starterGrid.append(cardBtn);
    }

    box.append(av, title, sub, cwdCard, starterGrid);
    transcript.append(box);
  };

  async function loadDetails(id) {
    if (!scope || loadingDetails.has(id)) return;
    const isRoot = rootViews.has(id);
    const existing = isRoot ? rootViews.get(id) : inspectorViews.get(id);
    if (!existing || existing.detailsLoaded) return;
    const ticket = version;
    loadingDetails.add(id);
    try {
      const record = await api(`/api/dimension/work/runs/${encodeURIComponent(id)}?view=1`, { signal: controller.signal });
      if (ticket !== version) return;
      records = records.map(r => r.id === id ? record : r);
      if (isRoot) {
        const fresh = makeRootView(record);
        for (const ev of record.events || []) fresh.accept(ev);
        fresh.advanceCursor(record.lastSeq);
        fresh.update(record.status);
        setRootView(id, fresh);
      } else {
        const fresh = createMemberInspectorRunView(record, { nameOf, avatarOf });
        for (const ev of record.events || []) fresh.accept(ev);
        fresh.advanceCursor(record.lastSeq);
        fresh.update(record.status);
        inspectorViews.set(id, fresh);
      }
      streams.get(id)?.close();
      streams.delete(id);
      connectStream(record);
      syncStage();
      if (record.artifacts?.length) void loadArtifactsForTask(id);
    } catch (err) {
      if (ticket === version) showNotice(err.message || '加载详细记录失败');
    } finally {
      if (ticket === version) loadingDetails.delete(id);
    }
  }

  const makeRootView = record => {
    const common = {
      api,
      transcript: getTranscript(),
      nameOf,
      avatarOf,
      groupMembersOf,
      onAction: handleAction,
      onArtifacts: taskId => void loadArtifactsForTask(taskId),
      onApproval,
      onDetails: loadDetails,
      onQuote: quote => { if (rootViews.get(record.id)?.root.isConnected) onQuote(quote); },
      onNewThread: () => startNewThread(),
      onInspectMember: inspectMember,
      onSelectChoice: val => { if (val) void submit(val); },
      // 「继续任务」：聚焦到该线程后，走与 composer 发送消息相同的 submit()；
      // 线程已结束时 submit 会自动走 /resume。
      onContinue: async text => {
        if (!scope) throw new Error('工作视图尚未就绪');
        if (newThreadMode || focusedRootId !== record.id) {
          newThreadMode = false;
          focusedRootId = record.id;
        }
        try {
          return await submit(text || WORK_CONTINUE_TEXT);
        } catch (err) {
          showNotice(err?.message || '继续任务失败，请稍后重试', 'error');
          throw err;
        }
      },
      dock,
      handoffAvailable,
      fallbackCwd: getProjectCwd?.() || '',
    };
    return record.groupId
      ? createGrokGroupRoundtableView(record, common)
      : createClaudeSoloThreadView(record, common);
  };

  const handleAction = async (actionName, id) => {
    const ticket = version;
    try {
      if (actionName === 'handoff') {
        showHandoff(id);
        return;
      }
      await api(`/api/dimension/work/runs/${encodeURIComponent(id)}/${actionName}`, { method: 'POST', body: '{}' });
      if (ticket === version) await refresh();
    } catch (err) {
      if (ticket === version) showNotice(err.message);
    }
  };

  const connectStream = record => {
    if (!isActive(record.status) || streams.has(record.id)) return;
    const ticket = version;
    const view = rootViews.get(record.id) || inspectorViews.get(record.id);
    if (!view) return;
    const es = new EventSource(`/api/dimension/work/runs/${encodeURIComponent(record.id)}/events?after=${view.lastSeq}`);
    streams.set(record.id, es);
    es.onmessage = msg => {
      if (ticket !== version || streams.get(record.id) !== es) return;
      try {
        const ev = JSON.parse(msg.data);
        consumeEvent(record, ev);
        syncConnection(true);
      } catch {}
    };
    es.onerror = () => {
      if (ticket === version && streams.get(record.id) === es) syncConnection(false);
    };
    es.onopen = () => {
      if (ticket === version && streams.get(record.id) === es) syncConnection(true);
    };
  };

  const STAGE_SYNC_IMMEDIATE = new Set(['run-state', 'team', 'result', 'team-result', 'answer', 'input', 'approval', 'error', 'choice-prompt']);
  const STAGE_SYNC_MIN_GAP_MS = 150;
  let stageSyncRaf = 0;
  let stageSyncTimer = 0;
  let lastStageSyncAt = 0;

  const consumeEvent = (record, event) => {
    if (event.kind === 'deleted') {
      removeRunIds([record.id]);
      onChange();
      return;
    }
    const view = rootViews.get(record.id) || inspectorViews.get(record.id);
    if (!view?.accept(event)) return;
    record = records.find(r => r.id === record.id) || record;
    if (!Array.isArray(record.events)) record.events = [];
    if (['project-instructions', 'broker-enriched', 'cli-step', 'tool', 'input', 'run-state'].includes(event.kind)) {
      record.events.push(event);
      if (record.events.length > 160) record.events.splice(0, record.events.length - 160);
    }

    if (['run-state', 'team', 'result', 'team-result', 'answer', 'input'].includes(event.kind)) {
      onChange();
    }
    if (event.kind === 'run-state') {
      record.status = event.status;
      const cur = records.find(r => r.id === record.id);
      if (cur) cur.status = event.status;
      syncBusy();
      if (!isActive(event.status)) {
        streams.get(record.id)?.close();
        streams.delete(record.id);
        void refresh();
      }
    }
    if (event.kind === 'team') {
      record.assignments = event.assignments;
      const cur = records.find(r => r.id === record.id);
      if (cur) cur.assignments = event.assignments;
    }
    // P1：关键事件立即同步；thinking / commentary / tool 增量等按帧合并（≥150ms 一次）。
    // 事件本身已由 view.accept() 实时渲染，这里只决定 syncStage 的时机。
    requestStageSync(STAGE_SYNC_IMMEDIATE.has(event.kind));
  };

  function requestStageSync(immediate = false) {
    if (immediate) {
      syncStage();
      return;
    }
    if (stageSyncRaf || stageSyncTimer) return;
    const schedule = () => {
      stageSyncRaf = requestAnimationFrame(() => {
        stageSyncRaf = 0;
        syncStage();
      });
    };
    const wait = STAGE_SYNC_MIN_GAP_MS - (performance.now() - lastStageSyncAt);
    if (wait > 0) {
      stageSyncTimer = setTimeout(() => {
        stageSyncTimer = 0;
        schedule();
      }, wait);
    } else {
      schedule();
    }
  }

  function cancelPendingStageSync() {
    if (stageSyncRaf) { cancelAnimationFrame(stageSyncRaf); stageSyncRaf = 0; }
    if (stageSyncTimer) { clearTimeout(stageSyncTimer); stageSyncTimer = 0; }
  }

  function syncPlanButton(view, record) {
    let button = view.root.querySelector('[data-action="approve-work-plan"]');
    if (record.status !== 'completed' || record.planPhase !== 'ready') {
      button?.remove();
      return;
    }
    const attempt = String(record.attempt);
    if (button?.dataset.planAttempt === attempt) return;
    button?.remove();
    button = el('button', 'claude-bar-btn is-accent', '按此计划开始');
    button.type = 'button';
    button.dataset.action = 'approve-work-plan';
    button.dataset.planAttempt = attempt;
    view.root.querySelector('.claude-timeline')?.after(button);
    button.onclick = async () => {
      button.disabled = true;
      const ticket = version;
      try {
        const result = await api(`/api/dimension/work/runs/${encodeURIComponent(record.id)}/resume`, {
          method: 'POST',
          body: JSON.stringify({text:'按此计划开始', planAttempt:attempt, requestId:`approve-plan:${record.id}:${attempt}`}),
        });
        if (ticket === version) merge({runs:[result.run]});
      } catch (error) {
        if (ticket === version) {
          button.disabled = false;
          showNotice(error.message || '确认失败，请重新查看计划');
          void refresh();
        }
      }
    };
  }

  function syncStage() {
    cancelPendingStageSync();
    lastStageSyncAt = performance.now();
    const transcript = getTranscript();
    if (!transcript || !scope) return;

    const { groups, rootOf } = workTaskGroups(records);

    // Ensure views exist for all known records
    for (const group of groups) {
      const rootRec = group.root;
      if (!rootViews.has(rootRec.id)) {
        const v = makeRootView(rootRec);
        for (const ev of rootRec.events || []) v.accept(ev);
        v.advanceCursor(rootRec.lastSeq);
        v.update(rootRec.status);
        rootViews.set(rootRec.id, v);
        if (rootRec.artifacts?.length) void loadArtifactsForTask(rootRec.id);
      }
      for (const childRec of group.runs) {
        if (childRec.id === rootRec.id) continue;
        if (!inspectorViews.has(childRec.id)) {
          const iv = createMemberInspectorRunView(childRec, { nameOf, avatarOf });
          for (const ev of childRec.events || []) iv.accept(ev);
          iv.advanceCursor(childRec.lastSeq);
          iv.update(childRec.status);
          inspectorViews.set(childRec.id, iv);
          if (childRec.artifacts?.length) void loadArtifactsForTask(childRec.id);
        }
      }

      // Bind team jobs with live inspector views on group root view
      const rootView = rootViews.get(rootRec.id);
      if (rootView) syncPlanButton(rootView, rootRec);
      if (rootView && scope.groupId) {
        const assignMap = new Map();
        for (const r of group.runs) {
          for (const job of r.assignments || []) {
            if (!job.runId || !deleted.has(job.runId)) {
              assignMap.set(job.runId || `${r.id}:${job.key || job.jobId}`, { ...job, parentRunId: r.id });
            }
          }
        }
        const jobs = [{ key: `owner:${rootRec.id}`, botId: rootRec.botId, job: rootRec.text, status: rootRec.status }];
        for (const r of group.runs) {
          if (r.id === rootRec.id) continue;
          const iv = inspectorViews.get(r.id);
          jobs.push({
            ...assignMap.get(r.id),
            key: r.id,
            runId: r.id,
            botId: r.botId,
            parentRunId: r.parentRunId,
            job: r.text,
            status: r.status,
            inspectorView: iv,
          });
          assignMap.delete(r.id);
        }
        jobs.push(...assignMap.values());
        rootView.setTeam(jobs);
      }
    }

    if (newThreadMode) {
      if (!transcript.querySelector('.work-new-thread-stage')) {
        renderNewThreadWelcome();
      }
      presentPending();
      return;
    }

    // Pick focused root thread if unset or invalid
    if (!focusedRootId || !rootViews.has(focusedRootId)) {
      const sortedRoots = [...groups.map(g => g.root)].sort((a, b) =>
        String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''))
      );
      const runningOne = sortedRoots.find(r => isActive(r.status));
      const target = runningOne || sortedRoots[0] || null;
      if (!target) {
        newThreadMode = true;
        renderNewThreadWelcome();
        onThreadChanged?.({ runId: '', isNewThread: true });
        return;
      }
      focusedRootId = target.id;
      const rootView = rootViews.get(focusedRootId);
      if (rootView && !rootView.detailsLoaded) void loadDetails(focusedRootId);
      onThreadChanged?.({ runId: focusedRootId, isNewThread: false });
      syncBusy();
    }

    const activeView = rootViews.get(focusedRootId);
    if (activeView && activeView.root.parentNode !== transcript) {
      transcript.replaceChildren(activeView.root);
      syncFocusedArtifactsToUi(focusedRootId, { autoReveal: false });
      if (!activeView.detailsLoaded) void loadDetails(focusedRootId);
    }

    presentPending();
    if (focusedRootId && !newThreadMode) {
      const rootRec = records.find(r => r.id === focusedRootId);
      syncOverviewToDock(focusedRootId, { autoReveal: Boolean(rootRec && isActive(rootRec.status)) });
    }
    syncLiveInspector();
  }

  const merge = data => {
    for (const id of data.deletedIds || []) removeRunIds([id]);
    const incoming = (data.runs || []).filter(rec => {
      if (deleted.has(rec.id)) return false;
      const existing = rootViews.get(rec.id) || inspectorViews.get(rec.id);
      if (rec.detailsLoaded && existing && !existing.detailsLoaded) return true;
      return !existing || rec.lastSeq >= existing.lastSeq;
    });

    const combined = new Map(records.map(r => [r.id, r]));
    for (const r of incoming) {
      const prior = combined.get(r.id);
      if (!prior?.events?.length) { combined.set(r.id, r); continue; }
      // Session refreshes send only the events after the view cursor.
      const events = new Map(prior.events.map(ev=>[ev.seq,ev]));
      for (const ev of r.events || []) events.set(ev.seq,ev);
      combined.set(r.id,{...r,events:[...events.values()].sort((a,b)=>a.seq-b.seq).slice(-160)});
    }
    records = [...combined.values()].sort((a, b) =>
      String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
    );

    const { rootOf } = workTaskGroups(records);
    for (const rec of incoming) {
      const isRoot = rootOf.get(rec.id) === rec.id;
      let v = isRoot ? rootViews.get(rec.id) : inspectorViews.get(rec.id);
      const hydratingFullDetails = Boolean(rec.detailsLoaded && v && !v.detailsLoaded);
      if (!v || hydratingFullDetails) {
        if (hydratingFullDetails) {
          streams.get(rec.id)?.close();
          streams.delete(rec.id);
        }
        v = isRoot ? makeRootView(rec) : createMemberInspectorRunView(rec, { nameOf, avatarOf });
        if (isRoot) setRootView(rec.id, v);
        else inspectorViews.set(rec.id, v);
      }
      v.setTitle(rec.text);
      for (const ev of rec.events || []) v.accept(ev);
      v.advanceCursor(rec.lastSeq);
      v.update(rec.status);
      if (isActive(rec.status)) connectStream(rec);
      else { streams.get(rec.id)?.close(); streams.delete(rec.id); }
      if (rec.artifacts?.length && !artifactMap.get(rootOf.get(rec.id) || rec.id)?.filesByTask.has(rec.id)) {
        void loadArtifactsForTask(rec.id);
      }
    }

    syncStage();
    syncBusy();
  };

  function refresh() {
    if (!scope) return Promise.resolve();
    if (refreshTask) return refreshTask;
    const ticket = version;
    lastRefreshAt = Date.now();
    refreshTask = (async () => {
      try {
        const data = await api(`/api/dimension/work/sessions?${query()}`, { signal: controller.signal });
        if (ticket === version) {
          merge(data);
          syncConnection(true);
        }
      } catch {
        if (ticket === version) syncConnection(false);
      } finally {
        if (ticket === version) refreshTask = null;
      }
    })();
    return refreshTask;
  }

  function presentPending(rows, handlers) {
    if (rows !== undefined) {
      approvalRows = rows || [];
      approvalHandlers = handlers || {};
    }
    if (!scope || !focusedRootId || newThreadMode) { hideApprovalPill(); return false; }
    const view = rootViews.get(focusedRootId);
    if (!view?.presentApprovals) { hideApprovalPill(); return false; }
    const { groups } = workTaskGroups(records);
    const curGroup = groups.find(g => g.root.id === focusedRootId);
    const relatedRunIds = new Set(curGroup ? curGroup.runs.map(r => r.id) : [focusedRootId]);
    const matched = approvalRows.filter(row => {
      if (row.runId) return relatedRunIds.has(row.runId);
      return !scope.groupId && row.botId === scope.botId;
    });
    const presented = view.presentApprovals(matched, approvalHandlers) === true || matched.length === 0;
    updateApprovalPill();
    return presented;
  }

  // ===== P1：待审批浮动胶囊「⚠ N 项待你批准 ↓」 =====
  let approvalPill = null;
  let approvalPillArmed = false;
  let approvalPillScrollSignal = null;
  let approvalPillRaf = 0;
  const seenApprovalIds = new Set();

  const pendingApprovalCards = () => {
    if (!scope || newThreadMode || !focusedRootId) return [];
    const view = rootViews.get(focusedRootId);
    if (!view?.root?.isConnected) return [];
    return [...view.root.querySelectorAll('.claude-approval-card:not([data-decided="1"])')];
  };

  const approvalCardInView = (card, tr) => {
    const a = card.getBoundingClientRect();
    const b = tr.getBoundingClientRect();
    return a.bottom > b.top + 8 && a.top < b.bottom - 8;
  };

  function hideApprovalPill() {
    if (approvalPill) approvalPill.hidden = true;
  }

  const ensureApprovalPill = tr => {
    if (!approvalPill) {
      approvalPill = el('div', 'work-approval-pill-dock');
      const btn = el('button', 'work-approval-pill');
      btn.type = 'button';
      btn.setAttribute('aria-live', 'polite');
      btn.onclick = () => {
        const first = pendingApprovalCards()[0];
        approvalPillArmed = false;
        hideApprovalPill();
        first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      };
      approvalPill.append(btn);
    }
    // 粘在 transcript 末尾（sticky bottom），自然位于 composer 上方。
    if (approvalPill.parentNode !== tr || tr.lastElementChild !== approvalPill) tr.append(approvalPill);
    return approvalPill;
  };

  const bindApprovalPillScroll = tr => {
    const signal = controller?.signal;
    if (!signal || approvalPillScrollSignal === signal) return;
    approvalPillScrollSignal = signal;
    tr.addEventListener('scroll', () => {
      if (approvalPillRaf || !approvalPill || approvalPill.hidden) return;
      approvalPillRaf = requestAnimationFrame(() => {
        approvalPillRaf = 0;
        updateApprovalPill();
      });
    }, { passive: true, signal });
  };

  function updateApprovalPill() {
    const tr = getTranscript();
    if (!tr || !scope) { hideApprovalPill(); return; }
    bindApprovalPillScroll(tr);
    const cards = pendingApprovalCards();
    let arrived = false;
    for (const card of cards) {
      const id = card.dataset.approvalId || '';
      if (id && !seenApprovalIds.has(id)) { seenApprovalIds.add(id); arrived = true; }
    }
    if (!cards.length || cards.some(card => approvalCardInView(card, tr))) {
      approvalPillArmed = false;
      hideApprovalPill();
      return;
    }
    if (arrived) approvalPillArmed = true;
    if (!approvalPillArmed) { hideApprovalPill(); return; }
    const pill = ensureApprovalPill(tr);
    pill.firstElementChild.textContent = `⚠ ${cards.length} 项待你批准 ↓`;
    pill.hidden = false;
  }

  function removeRunIds(ids) {
    for (const id of ids || []) {
      deleted.add(id);
      streams.get(id)?.close();
      streams.delete(id);
      rootViews.get(id)?.dispose?.();
      rootViews.get(id)?.root.remove();
      rootViews.delete(id);
      inspectorViews.delete(id);
      artifactMap.delete(id);
    }
    records = records.filter(r => !deleted.has(r.id));
    if (focusedRootId && deleted.has(focusedRootId)) {
      focusedRootId = '';
      dock?.clear();
      syncStage();
    }
    syncBusy();
  }

  function startNewThread() {
    if (!scope) return;
    newThreadMode = true;
    focusedRootId = '';
    inspectedMemberId = '';
    dock?.clear();
    renderNewThreadWelcome();
    onThreadChanged?.({ runId: '', isNewThread: true });
    syncBusy();
    document.getElementById('composerInput')?.focus();
  }

  async function reveal(id) {
    if (!scope || !id) throw new Error('请先打开对应的工作会话');
    const ticket = version, focusTicket = ++revealVersion, loaded = new Map();
    const current = () => ticket === version && focusTicket === revealVersion;
    const inScope = rec => scope.groupId ? rec.groupId === scope.groupId : (!rec.groupId && rec.botId === scope.botId);

    const loadOne = async runId => {
      if (loaded.has(runId)) return loaded.get(runId);
      const rec = await api(`/api/dimension/work/runs/${encodeURIComponent(runId)}?view=1`, { signal: controller.signal });
      if (!current()) return null;
      if (!rec || rec.id !== runId || rec.deleted || deleted.has(runId)) throw new Error('该对话已删除或不可用');
      if (!inScope(rec)) throw new Error('该对话属于其他角色或群组');
      loaded.set(runId, rec);
      return rec;
    };

    // P1：transcript 为空时显示轻量占位，加载完（或失败）移除。
    const trForPlaceholder = getTranscript();
    let loadingPlaceholder = null;
    if (trForPlaceholder && !trForPlaceholder.querySelector('.claude-thread-stage, .work-new-thread-stage')
      && !trForPlaceholder.textContent.trim()) {
      loadingPlaceholder = el('div', 'work-reveal-loading', '✦ 正在翻开卷宗…');
      loadingPlaceholder.setAttribute('role', 'status');
      trForPlaceholder.append(loadingPlaceholder);
    }
    const dropPlaceholder = () => { loadingPlaceholder?.remove(); loadingPlaceholder = null; };

    try {
      let rec = await loadOne(id);
      if (!current()) return null;
      const chain = new Set();
      // 父链天然是串行依赖（要先知道 parentRunId）。
      while (rec?.parentRunId && !chain.has(rec.id)) {
        chain.add(rec.id);
        rec = await loadOne(rec.parentRunId);
        if (!current()) return null;
      }
      // 子任务按层并行拉取。
      let frontier = [...loaded.values()];
      while (frontier.length) {
        const pending = new Set();
        for (const parent of frontier) {
          for (const job of parent.assignments || []) {
            if (job.runId && !loaded.has(job.runId)) pending.add(job.runId);
          }
        }
        if (!pending.size) break;
        const children = await Promise.all([...pending].map(childId => loadOne(childId)));
        if (!current()) return null;
        frontier = children.filter(Boolean);
      }
      if (!current()) return null;
    } finally {
      dropPlaceholder();
    }

    newThreadMode = false;
    inspectedMemberId = '';
    dock?.clear();
    merge({ runs: [...loaded.values()] });
    const rootId = workTaskGroups(records).rootOf.get(id) || id;
    focusedRootId = rootId;
    syncStage();
    syncBusy();
    const targetNode = rootViews.get(rootId)?.root;
    if (targetNode?.isConnected) {
      const tr = getTranscript();
      targetNode.focus({ preventScroll: true });
      // P1：有待审批卡片 → 定位到第一张；否则滚到底部看最新结果。
      const firstApproval = targetNode.querySelector('.claude-approval-card');
      if (firstApproval) {
        firstApproval.scrollIntoView({ block: 'center' });
      } else if (tr) {
        tr.scrollTop = tr.scrollHeight;
        // 富文本 / 图片可能在下一帧才撑开高度，再补一次。
        requestAnimationFrame(() => {
          if (tr.isConnected && targetNode.isConnected) tr.scrollTop = tr.scrollHeight;
        });
      }
    }
    for (const r of loaded.values()) {
      if (r.artifacts?.length) void loadArtifactsForTask(r.id);
    }
    onThreadChanged?.({ runId: rootId, isNewThread: false });
    return { runId: id, rootRunId: rootId };
  }

  const close = () => {
    dismissHandoff?.();
    cancelPendingStageSync();
    hideApprovalPill();
    dock?.clear();
    controller?.abort();
    loadingDetails.clear();
    deleted.clear();
    artifactMap.clear();
    checkpointRequests.clear();
    taskRequests.clear();
    focusedRootId = '';
    newThreadMode = false;
    inspectedMemberId = '';
    version++;
    revealVersion++;
    scope = null;
    clearInterval(poll);
    poll = undefined;
    for (const s of streams.values()) s.close();
    streams.clear();
    disposeAllRootViews();
    rootViews.clear();
    inspectorViews.clear();
    records = [];
    refreshTask = null;
    const bar = document.getElementById('workSessionBar');
    if (bar) { bar.replaceChildren(); bar.hidden = true; }
    onBusy(false);
  };

  const open = async next => {
    close();
    scope = { botId: next.botId, ...(next.groupId ? { groupId: next.groupId } : {}) };
    controller = new AbortController();
    const ticket = version;
    newThreadMode = Boolean(next.newThread);
    focusedRootId = next.focusRunId || '';

    // Hide legacy workSessionBar completely (no more awkward <select> dropdown!)
    const bar = document.getElementById('workSessionBar');
    if (bar) { bar.replaceChildren(); bar.hidden = true; }

    if (newThreadMode) {
      renderNewThreadWelcome();
      onThreadChanged?.({ runId: '', isNewThread: true });
    } else if (!next.focusRunId) {
      const tr = getTranscript();
      if (tr && !tr.querySelector('.claude-thread-stage, .work-new-thread-stage')) {
        renderNewThreadWelcome();
      }
    }

    const data = await api(`/api/dimension/work/sessions?${query()}`, { signal: controller.signal });
    if (ticket !== version) return null;
    merge(data);
    poll = setInterval(pollTick, POLL_BASE_MS);
    // 切回前台时立刻补一次刷新（后台期间 pollTick 会跳过）。
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && ticket === version) void refresh();
    }, { signal: controller.signal });
    if (next.focusRunId) {
      await reveal(next.focusRunId);
    }
    return data;
  };

  const submit = async (text, quote) => {
    if (!scope) throw new Error('工作视图尚未就绪，请稍后重试');
    const ticket = version;
    const focusedRec = !newThreadMode && focusedRootId ? records.find(r => r.id === focusedRootId) : null;

    // Intelligent continuous routing:
    // - New thread mode or no focused thread -> POST /work/runs with deliveryMode: 'queue' (creates a fresh root thread!)
    // - Focused thread is currently running/queued/waiting -> POST /work/runs with deliveryMode: 'steer' (steers active run!)
    // - Focused thread is finished (completed/partial/failed/cancelled/interrupted) -> POST /work/runs/:id/resume (continues same thread!)
    const isContinuingFinished = Boolean(focusedRec && !isActive(focusedRec.status));
    const isSteeringActive = Boolean(focusedRec && isActive(focusedRec.status));
    const deliveryMode = isSteeringActive ? 'steer' : 'queue';

    const key = JSON.stringify({ scope, target: focusedRec?.id || 'new', text, quote: quote || null });
    const requestId = retrySubmission?.key === key ? retrySubmission.id : crypto.randomUUID();
    retrySubmission = { key, id: requestId };
    const cursors = Object.fromEntries([...rootViews].map(([id, v]) => [id, v.lastSeq]));

    const endpoint = isContinuingFinished
      ? `/api/dimension/work/runs/${encodeURIComponent(focusedRec.id)}/resume`
      : '/api/dimension/work/runs';

    const result = await api(endpoint, {
      method: 'POST',
      body: JSON.stringify({ ...scope, text, quote, deliveryMode, requestId, cursors,
        ...(isContinuingFinished && focusedRec.planPhase === 'ready' && !quote &&
          /^(开始|开始吧|开始做|开始做吧|执行|执行吧|按这个做|按这个方案做|按此计划开始执行|按此计划开始|按计划执行|可以|同意|确认执行)[。！!]?$/u.test(text.trim())
          ? {planAttempt:String(focusedRec.attempt)} : {}) }),
    });

    if (retrySubmission?.id === requestId) retrySubmission = null;
    if (result.mode === 'discuss') {
      if (ticket === version) await onDiscuss(text, quote);
      return result;
    }

    if (ticket === version) {
      const run = result.run || result;
      if (run.id) {
        newThreadMode = false;
        focusedRootId = run.parentRunId || run.id;
        merge({ runs: [run] });
        onThreadChanged?.({ runId: focusedRootId, isNewThread: false, created: !focusedRec });
      } else {
        void refresh();
      }
      onChange();
    }
    return result;
  };

  return {
    open,
    close,
    submit,
    refresh,
    reveal,
    presentPending,
    removeRunIds,
    startNewThread,
    currentRunId: () => (newThreadMode ? '' : focusedRootId),
    isNewThread: () => newThreadMode,
    reloadArtifacts: targetId => {
      const id = targetId || focusedRootId;
      if (!id) return;
      const { groups } = workTaskGroups(records);
      const grp = groups.find(g => g.root.id === id);
      if (grp) {
        for (const r of grp.runs) void loadArtifactsForTask(r.id);
      } else {
        void loadArtifactsForTask(id);
      }
    },
    refreshRoundtableSeats: () => {
      if (focusedRootId) rootViews.get(focusedRootId)?.refreshSeats?.();
    },
    setHandoffAvailable: val => {
      handoffAvailable = val === true;
      if (!handoffAvailable) dismissHandoff?.();
      for (const v of rootViews.values()) v.setHandoffAvailable(handoffAvailable);
    },
    stop: () => {
      // 只停止当前聚焦的线程（群任务时即群根任务）；聚焦线程不在运行时不做任何取消，避免误停其他任务。
      if (newThreadMode || !focusedRootId) return;
      const target = records.find(r => r.id === focusedRootId && isActive(r.status));
      if (target) return handleAction('cancel', target.id);
    },
  };
}
