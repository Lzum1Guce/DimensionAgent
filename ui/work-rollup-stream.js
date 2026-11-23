// 维度工坊统一程序化推流组件（批次动作自动合并 + 垂直图标步骤树 + 群聊轻量传信路标与选项确认卡）
import { renderRichMessage } from './markdown-lite.js';
import { createChangeDiff } from './change-diff-ui.js';

const mk = (tag, className = '', text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const STEP_ICONS = {
  read: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.25h5.6L12.75 5.4v8.35a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10.5a1 1 0 0 1 1-1Z"/><path d="M9.25 2.4v3.1h3.1M5.5 8.25h5M5.5 10.75h3.5"/></svg>',
  edit: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="m10.8 2.9 2.3 2.3-7.6 7.6-2.9.6.6-2.9 7.6-7.6Z"/><path d="M9.5 4.2 11.8 6.5"/></svg>',
  think: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12.25h4M6.6 14h2.8M8 2.25a4.25 4.25 0 0 0-2.45 7.72c.48.35.8.88.88 1.48h3.14c.08-.6.4-1.13.88-1.48A4.25 4.25 0 0 0 8 2.25Z"/></svg>',
  command: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2.75" width="12" height="10.5" rx="1.6"/><path d="m5 6.25 2.25 1.75L5 9.75M8.5 10h2.75"/></svg>',
  search: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4.25"/><path d="m10.2 10.2 3.3 3.3"/></svg>',
  notify: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M2.75 4A1.5 1.5 0 0 1 4.25 2.5h7.5a1.5 1.5 0 0 1 1.5 1.5v5.25a1.5 1.5 0 0 1-1.5 1.5H6.2L3.25 13v-2.25h-.5a1.5 1.5 0 0 1-1.5-1.5V4Z"/></svg>',
  other: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.5v11M2.5 8h11"/></svg>',
  chevron: '<svg class="wrs-chev" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 6.25 3.5 3.5 3.5-3.5"/></svg>',
};

function cleanBasename(rawPath) {
  const s = String(rawPath || '').trim().replace(/[\\/]+$/, '');
  if (!s) return '';
  const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return idx >= 0 ? s.slice(idx + 1) : s;
}

/**
 * 程序化工具分类器（跨所有模型与所有 CLI 100% 统一归一化）
 */
export function classifyToolAction(toolName, rawArgs) {
  const rawName = String(toolName || '').trim();
  const low = rawName.toLowerCase();
  let parsed = {};
  if (rawArgs) {
    try {
      parsed = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
    } catch {}
  }
  if (!parsed || typeof parsed !== 'object') parsed = {};

  // 若后端已预分类（cli_step），直接使用
  if (parsed.__actionCategory && parsed.__displayVerb) {
    return {
      category: parsed.__actionCategory,
      verb: parsed.__displayVerb,
      target: parsed.__displayTarget || '',
      fileKey: parsed.__actionCategory === 'edit' || parsed.__actionCategory === 'read'
        ? (parsed.__displayTarget || rawName) : '',
      parsed,
    };
  }

  const pathVal = parsed.path || parsed.file_path || parsed.filePath || parsed.target_file || parsed.filename || '';
  const descVal = parsed.description || parsed.explanation || parsed.summary || parsed.toolSummary || '';
  const cmdVal = parsed.command || parsed.cmd || (Array.isArray(parsed.argv) ? parsed.argv.join(' ') : '');
  const queryVal = parsed.pattern || parsed.query || parsed.regex || '';

  if (['read_file', 'read', 'view_file', 'cat', 'read_many_files', 'read_work_artifact'].includes(low)) {
    const file = cleanBasename(pathVal) || '文件';
    return { category: 'read', verb: '阅读', target: file, fileKey: pathVal || file, parsed };
  }
  if ([
    'write_file', 'edit_file', 'write', 'edit', 'multiedit', 'patch',
    'apply_patch', 'replace_in_file', 'str_replace_editor', 'file_change',
  ].includes(low)) {
    const file = cleanBasename(pathVal) || '文件';
    return { category: 'edit', verb: '编辑', target: file, fileKey: pathVal || file, parsed };
  }
  if ([
    'terminal', 'bash', 'shell', 'run_command', 'run_in_vm', 'sandbox_exec',
    'host_exec', 'execute_command', 'command_execution', 'run_shell_command', 'cli_agent_exec',
  ].includes(low)) {
    const label = String(descVal || (cmdVal ? String(cmdVal).split('\n')[0].trim() : '') || '').slice(0, 72);
    return { category: 'command', verb: '运行命令', target: label, fileKey: '', parsed };
  }
  if ([
    'grep', 'grep_files', 'search_files', 'glob', 'list_files', 'ls',
    'find_files', 'search_content', 'web_fetch',
  ].includes(low)) {
    const verb = ['list_files', 'ls', 'glob', 'find_files'].includes(low) ? '浏览目录' : '内容检索';
    const target = String(queryVal || cleanBasename(pathVal) || parsed.url || '').slice(0, 56);
    return { category: 'search', verb, target, fileKey: '', parsed };
  }
  if (['send_member_task', 'delegate_work', 'team_status', 'notify', 'message_teammate'].includes(low)) {
    const target = parsed.botName || parsed.botId
      || (Array.isArray(parsed.jobs) ? `${parsed.jobs.length} 项成员分工` : '');
    return { category: 'notify', verb: low === 'team_status' ? '收到成员回执' : '派发协作通知', target, fileKey: '', parsed };
  }
  if (low === 'verify_file' || low === 'task_finish' || low === 'finish_work') {
    const target = cleanBasename(pathVal) || '';
    return { category: 'other', verb: '核验成果', target, fileKey: '', parsed };
  }

  return { category: 'other', verb: '使用工具', target: rawName || '操作', fileKey: '', parsed };
}

/**
 * 根据批次内统计计数自动合成一行极简中文摘要（如“已编辑 1 个文件和运行 2 个命令”）
 */
export function formatBatchRollupSummary(stats, isRunning = false) {
  const editCnt = stats.editedFiles.size;
  const readCnt = stats.readFiles.size;
  const cmdCnt = stats.commands;
  const searchCnt = stats.searches;
  const notifyCnt = stats.notifications;
  const otherCnt = stats.others;

  const clauses = [];
  const primaryPair = [];
  if (editCnt > 0) primaryPair.push(`已编辑 ${editCnt} 个文件`);
  else if (readCnt > 0) primaryPair.push(`已阅读 ${readCnt} 个文件`);

  if (cmdCnt > 0) primaryPair.push(`运行 ${cmdCnt} 个命令`);

  if (primaryPair.length === 2 && searchCnt === 0 && notifyCnt === 0 && otherCnt === 0) {
    return `${primaryPair[0]}和${primaryPair[1]}`;
  }

  if (editCnt > 0) clauses.push(`已编辑 ${editCnt} 个文件`);
  if (readCnt > 0 && editCnt === 0) clauses.push(`已阅读 ${readCnt} 个文件`);
  else if (readCnt > 0 && editCnt > 0) clauses.push(`阅读 ${readCnt} 个文件`);
  if (searchCnt > 0) clauses.push(`检索 ${searchCnt} 次`);
  if (otherCnt > 0) clauses.push(`使用了 ${otherCnt} 个工具`);
  if (cmdCnt > 0) clauses.push(`运行 ${cmdCnt} 个命令`);
  if (notifyCnt > 0) clauses.push(`收到 ${notifyCnt} 条通知`);

  if (!clauses.length) {
    if (stats.thoughts > 0) return isRunning ? '正在深度思考…' : '思考已完成';
    return isRunning ? '正在准备执行步骤…' : '已完成步骤处理';
  }
  if (clauses.length === 2 && !clauses[1].startsWith('收到') && !clauses[0].startsWith('使用了')) {
    return `${clauses[0]}和${clauses[1]}`;
  }
  return clauses.join('，');
}

function formatDurationClock(ms, active) {
  if (!active && (ms == null || !Number.isFinite(ms) || ms <= 0)) {
    return '已完成工作';
  }
  const totalSec = Math.max(1, Math.floor(Math.max(0, ms || 0) / 1000));
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  let timeStr = '';
  if (hours > 0) {
    timeStr = mins > 0 ? `${hours}小时${mins}分钟` : `${hours}小时`;
  } else if (mins > 0) {
    timeStr = `${mins}分钟${secs}秒`;
  } else {
    timeStr = `${secs}秒`;
  }
  return active ? `正在工作 ${timeStr}` : `工作了 ${timeStr}`;
}

/**
 * 创建统一程序化推流视图（适用于单人 Work 主流 & 群聊非群主 Bot 独立工位面板）
 */
export function createWorkRollupStream({ avatarHtml = '', initialCreatedAt = '', initialEndedAt = '' } = {}) {
  const root = mk('div', 'wrs-turn-container');

  // 1. 顶部工作时长折叠头（头像 + “工作了 X秒 ⌄”）
  const headBar = mk('button', 'wrs-work-header');
  headBar.type = 'button';
  headBar.hidden = true;
  const headAvatar = mk('span', 'wrs-head-orb');
  if (avatarHtml) headAvatar.innerHTML = avatarHtml;
  const headLabel = mk('span', 'wrs-head-clock', '正在工作 1秒');
  const headChev = mk('span', 'wrs-head-chev');
  headChev.innerHTML = STEP_ICONS.chevron;
  headBar.append(headAvatar, headLabel, headChev);

  const bodyWrap = mk('div', 'wrs-body');
  headBar.onclick = () => {
    const collapsed = root.classList.toggle('is-body-collapsed');
    bodyWrap.hidden = collapsed;
  };

  // 2. Bot 代理人守界润色透视区（可选展示）
  const brokerZone = mk('div', 'wrs-broker-zone');
  brokerZone.hidden = true;

  // 3. 交替叙事与动作批次流容器
  const feed = mk('div', 'wrs-feed');
  const rulesZone = mk('details', 'wrs-broker-pill');
  rulesZone.hidden = true;
  rulesZone.append(mk('summary', 'wrs-broker-pill-sum', '项目规范'));
  const shownRules = new Set();
  function showProjectInstructions(info) {
    const key = JSON.stringify([info.workspace, info.directory, info.engine, info.revision]);
    if (shownRules.has(key)) return;
    shownRules.add(key);
    ensureHeaderVisible();
    rulesZone.hidden = false;
    const block = mk('div', 'wrs-broker-pill-body');
    block.append(mk('div', '', `${info.botId} · ${info.engine === 'builtin' ? '内置 Work' : info.engine} · ${info.workspace}`));
    block.append(mk('div', '', `规范基准：${info.base} · 适用目录：${info.directory || '.'}`));
    for (const file of info.files || []) {
      const native = file.delivery === 'native';
      const row = mk('div', '', `${file.path} · ${native ? '由 CLI 自行读取（未确认）' : '客户端已加载'} · ${file.sha256.slice(0, 12)}`);
      row.title = file.sha256;
      block.append(row);
    }
    if (!info.files?.length) block.append(mk('div', '', '此目录未发现项目规范'));
    rulesZone.append(block);
  }
  bodyWrap.append(rulesZone, brokerZone, feed);
  root.append(headBar, bodyWrap);

  const parseValidMs = iso => {
    const v = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(v) && v > 0 ? v : null;
  };

  let turnStartMs = parseValidMs(initialCreatedAt);
  let fallbackEndMs = parseValidMs(initialEndedAt);
  let firstEventMs = null;
  let lastEventMs = null;
  let explicitDurationMs = null;
  let settledDurationMs = null;
  let liveStartedWallMs = null;
  let clockTimer = null;
  let isTurnActive = false;
  let hasAnyProcessActivity = false;

  let currentBatch = null;
  let activeThoughtRow = null;
  let activeCommentary = null;
  let lastSettledCommentary = null;
  const stepMap = new Map(); // callId -> stepEntry

  const flushCommentaryDom = cur => {
    if (!cur) return;
    if (cur.rafId) {
      cancelAnimationFrame(cur.rafId);
      cur.rafId = 0;
    }
    cur.block.textContent = cur.text;
  };

  const ensureHeaderVisible = () => {
    if (!hasAnyProcessActivity) {
      hasAnyProcessActivity = true;
      headBar.hidden = false;
    }
  };

  const noteEventTime = isoStr => {
    const ms = parseValidMs(isoStr);
    if (ms == null) return;
    if (firstEventMs == null || ms < firstEventMs) firstEventMs = ms;
    if (lastEventMs == null || ms > lastEventMs) lastEventMs = ms;
    if (!isTurnActive && explicitDurationMs == null) {
      settledDurationMs = computeSettledDurationMs();
      refreshClockText();
    }
  };

  const computeLiveElapsedMs = () => {
    const now = Date.now();
    const MAX_LIVE_WINDOW = 6 * 3600 * 1000;
    if (firstEventMs != null && now >= firstEventMs && (now - firstEventMs) < MAX_LIVE_WINDOW) {
      return now - firstEventMs;
    }
    if (turnStartMs != null && now >= turnStartMs && (now - turnStartMs) < MAX_LIVE_WINDOW) {
      return now - turnStartMs;
    }
    if (liveStartedWallMs != null) {
      return Math.max(1000, now - liveStartedWallMs);
    }
    return 1000;
  };

  const computeSettledDurationMs = () => {
    if (explicitDurationMs != null && explicitDurationMs > 0) return explicitDurationMs;
    if (firstEventMs != null && lastEventMs != null && lastEventMs >= firstEventMs) {
      return Math.max(1000, lastEventMs - firstEventMs);
    }
    const anchorStart = firstEventMs ?? turnStartMs;
    if (anchorStart != null && fallbackEndMs != null && fallbackEndMs >= anchorStart) {
      // Only trust run-level updatedAt - createdAt if within a single turn (< 4 hours)
      const span = fallbackEndMs - anchorStart;
      if (span <= 4 * 3600 * 1000) return Math.max(1000, span);
    }
    if (liveStartedWallMs != null) {
      return Math.max(1000, Date.now() - liveStartedWallMs);
    }
    return 0;
  };

  const refreshClockText = () => {
    const elapsed = isTurnActive
      ? computeLiveElapsedMs()
      : (settledDurationMs != null ? settledDurationMs : computeSettledDurationMs());
    headLabel.textContent = formatDurationClock(elapsed, isTurnActive);
  };

  const setActiveState = (active, endedIso = '') => {
    const nextActive = Boolean(active);
    const endParsed = parseValidMs(endedIso);
    if (endParsed != null) {
      fallbackEndMs = endParsed;
      if (lastEventMs == null || endParsed > lastEventMs) lastEventMs = endParsed;
    }
    isTurnActive = nextActive;
    root.classList.toggle('is-working', isTurnActive);
    if (isTurnActive) {
      if (liveStartedWallMs == null) liveStartedWallMs = Date.now();
      settledDurationMs = null;
      if (!clockTimer) {
        refreshClockText();
        clockTimer = setInterval(refreshClockText, 1000);
      }
    } else {
      if (clockTimer) {
        clearInterval(clockTimer);
        clockTimer = null;
      }
      settledDurationMs = computeSettledDurationMs();
      liveStartedWallMs = null;
      refreshClockText();
      sealActiveThought();
      sealCurrentBatch();
      sealCommentary();
    }
  };

  const createActionBatch = () => {
    ensureHeaderVisible();
    const details = mk('details', 'wrs-batch');
    details.dataset.userToggled = '0';

    const summary = mk('summary', 'wrs-batch-summary');
    const summaryText = mk('span', 'wrs-batch-title', '正在执行步骤…');
    const summaryChev = mk('span', 'wrs-batch-chev');
    summaryChev.innerHTML = STEP_ICONS.chevron;
    summary.append(summaryText, summaryChev);

    summary.addEventListener('click', () => {
      details.dataset.userToggled = '1';
    });

    const tree = mk('div', 'wrs-step-tree');
    details.append(summary, tree);
    feed.append(details);

    const batch = {
      details,
      summaryText,
      tree,
      stats: {
        editedFiles: new Set(),
        readFiles: new Set(),
        commands: 0,
        searches: 0,
        notifications: 0,
        others: 0,
        thoughts: 0,
      },
      runningCount: 0,
      refreshSummary() {
        const activeNow = batch.runningCount > 0;
        details.classList.toggle('is-batch-running', activeNow);
        summaryText.textContent = formatBatchRollupSummary(batch.stats, activeNow);
      },
    };
    return batch;
  };

  const ensureBatch = () => {
    if (!currentBatch) currentBatch = createActionBatch();
    return currentBatch;
  };

  const sealCurrentBatch = () => {
    if (!currentBatch) return;
    currentBatch.runningCount = 0;
    currentBatch.refreshSummary();
    if (currentBatch.details.dataset.userToggled !== '1') {
      currentBatch.details.open = false;
    }
    currentBatch = null;
  };

  const thoughtSeconds = t => {
    const evMs = (t.startEventMs != null && lastEventMs != null) ? lastEventMs - t.startEventMs : 0;
    const wallMs = Date.now() - t.startWallMs;
    const ms = t.sealed ? Math.max(evMs, t.sealedWallMs ?? 0) : wallMs;
    return Math.max(1, Math.round(ms / 1000));
  };

  const refreshThoughtLabel = t => {
    if (!t) return;
    t.verbEl.textContent = t.sealed ? `✦ 思考了 ${thoughtSeconds(t)}s` : `✦ 思考中 · ${thoughtSeconds(t)}s`;
  };

  const stopThoughtTicker = t => {
    if (t?.tickId) {
      clearInterval(t.tickId);
      t.tickId = 0;
    }
  };

  const startThoughtTicker = t => {
    stopThoughtTicker(t);
    let detachedTicks = 0;
    t.tickId = setInterval(() => {
      if (!t.row.isConnected) {
        // Stage got discarded / replaced: stop ticking instead of leaking.
        if (++detachedTicks > 5) stopThoughtTicker(t);
        return;
      }
      detachedTicks = 0;
      refreshThoughtLabel(t);
    }, 1000);
  };

  // Full text is only written while the row is expanded; collapsed rows just
  // keep their summary fresh. Opening the row back-fills the text once.
  const flushThoughtBody = t => {
    if (!t || t.writtenLen === t.text.length) return;
    t.body.textContent = t.text.trim();
    t.writtenLen = t.text.length;
  };

  const sealActiveThought = () => {
    if (!activeThoughtRow || activeThoughtRow.sealed) return;
    if (activeThoughtRow.rafId) {
      cancelAnimationFrame(activeThoughtRow.rafId);
      activeThoughtRow.rafId = 0;
    }
    stopThoughtTicker(activeThoughtRow);
    activeThoughtRow.sealedWallMs = Date.now() - activeThoughtRow.startWallMs;
    activeThoughtRow.sealed = true;
    if (activeThoughtRow.row.open) flushThoughtBody(activeThoughtRow);
    activeThoughtRow.row.classList.remove('is-thinking-live');
    refreshThoughtLabel(activeThoughtRow);
    if (activeThoughtRow.row.dataset.userToggled !== '1') {
      activeThoughtRow.row.open = false;
    }
  };

  const resetStageThought = () => {
    sealActiveThought();
    activeThoughtRow = null;
  };

  const pushThinking = deltaText => {
    const clean = String(deltaText || '');
    if (!clean.trim() && !activeThoughtRow) return;
    ensureHeaderVisible();

    // 关键修复：同一阶段内即使模型交错吐出 thinking_delta 与 text_delta，
    // 绝不调用 sealCommentary() 拦腰斩断正在流式输出的话语，也绝不重复创建多个“思考已完成”！
    if (!activeThoughtRow) {
      const host = currentBatch ? currentBatch.tree : feed;
      const row = mk('details', `wrs-step is-think is-thinking-live${currentBatch ? '' : ' is-standalone-think'}`);
      // P1：思考过程默认折叠，只在 summary 上显示计时。
      row.open = false;
      const sum = mk('summary', 'wrs-step-line');
      sum.addEventListener('click', () => {
        row.dataset.userToggled = '1';
      });
      if (currentBatch) {
        const ico = mk('span', 'wrs-step-icon');
        ico.innerHTML = STEP_ICONS.think;
        sum.append(ico);
        currentBatch.stats.thoughts += 1;
        currentBatch.refreshSummary();
      }
      const verbEl = mk('span', 'wrs-step-verb', '✦ 思考中 · 1s');
      sum.append(verbEl);
      const body = mk('pre', 'wrs-step-detail');
      row.append(sum, body);
      if (!currentBatch && activeCommentary?.block?.parentNode === host) {
        host.insertBefore(row, activeCommentary.block);
      } else {
        host.append(row);
      }
      const t = {
        row, verbEl, body, text: '', rafId: 0, tickId: 0, writtenLen: 0,
        sealed: false, sealedWallMs: null, startWallMs: Date.now(), startEventMs: lastEventMs,
      };
      row.addEventListener('toggle', () => {
        if (!row.open) return;
        flushThoughtBody(t);
        if (!t.sealed) t.body.scrollTop = t.body.scrollHeight;
      });
      activeThoughtRow = t;
      startThoughtTicker(t);
    } else if (activeThoughtRow.sealed && clean.trim()) {
      // Same stage resumed thinking after a commentary burst: revive the row.
      activeThoughtRow.sealed = false;
      activeThoughtRow.row.classList.add('is-thinking-live');
      refreshThoughtLabel(activeThoughtRow);
      startThoughtTicker(activeThoughtRow);
    }
    activeThoughtRow.text += clean;
    if (!activeThoughtRow.rafId && activeThoughtRow.row.open) {
      const targetRow = activeThoughtRow;
      targetRow.rafId = requestAnimationFrame(() => {
        targetRow.rafId = 0;
        if (!targetRow.row.open) return;
        flushThoughtBody(targetRow);
        if (targetRow.row.classList.contains('is-thinking-live')) {
          targetRow.body.scrollTop = targetRow.body.scrollHeight;
        }
      });
    }
  };

  const endsWithSentenceStop = s => /[。！？.!?\n…—:;：；]$/.test(String(s || '').trim());

  const ensureCommentary = () => {
    if (activeCommentary) return activeCommentary;
    sealActiveThought();
    sealCurrentBatch();
    // 关键修复：若中间没有任何可见工具步骤批次（feed 末尾正是上一块正文），
    // 直接重新激活并合流同一正文块，彻底杜绝一句话被拆成上下两段！
    if (lastSettledCommentary && lastSettledCommentary.block?.parentNode === feed && lastSettledCommentary.block === feed.lastElementChild) {
      const prev = lastSettledCommentary.text || '';
      const sep = prev && endsWithSentenceStop(prev) ? '\n\n' : '';
      const reused = lastSettledCommentary.block;
      reused.classList.add('is-streaming');
      activeCommentary = { block: reused, text: prev + sep, rafId: 0 };
      lastSettledCommentary = null;
      return activeCommentary;
    }
    const block = mk('div', 'wrs-commentary is-streaming');
    feed.append(block);
    activeCommentary = { block, text: '', rafId: 0 };
    return activeCommentary;
  };

  const pushCommentaryDelta = delta => {
    const str = String(delta || '');
    if (!str) return;
    ensureHeaderVisible();
    sealActiveThought();
    const cur = ensureCommentary();
    cur.text += str;
    if (!cur.rafId) {
      cur.rafId = requestAnimationFrame(() => {
        cur.rafId = 0;
        if (activeCommentary === cur) {
          cur.block.textContent = cur.text;
        }
      });
    }
  };

  const completeCommentaryBlock = fullText => {
    const text = String(fullText ?? '').trim();
    if (!text) {
      sealCommentary();
      sealActiveThought();
      return null;
    }
    ensureHeaderVisible();
    sealActiveThought();
    if (activeCommentary) {
      const cur = activeCommentary;
      if (cur.rafId) {
        cancelAnimationFrame(cur.rafId);
        cur.rafId = 0;
      }
      const existing = cur.text.trim();
      if (!existing || text.startsWith(existing)) {
        cur.text = text;
      } else if (!existing.endsWith(text)) {
        const sep = endsWithSentenceStop(existing) ? '\n\n' : '';
        cur.text = existing + sep + text;
      }
      cur.block.classList.remove('is-streaming');
      renderRichMessage(cur.block, cur.text);
      lastSettledCommentary = { block: cur.block, text: cur.text };
      activeCommentary = null;
      return cur.block;
    }
    if (lastSettledCommentary && lastSettledCommentary.block?.parentNode === feed && lastSettledCommentary.block === feed.lastElementChild) {
      const prev = lastSettledCommentary.text || '';
      if (prev === text || prev.endsWith(text)) {
        return lastSettledCommentary.block;
      }
      const merged = text.startsWith(prev)
        ? text
        : (prev + (endsWithSentenceStop(prev) ? '\n\n' : '') + text);
      renderRichMessage(lastSettledCommentary.block, merged);
      lastSettledCommentary.text = merged;
      return lastSettledCommentary.block;
    }
    sealCurrentBatch();
    const block = mk('div', 'wrs-commentary');
    renderRichMessage(block, text);
    feed.append(block);
    lastSettledCommentary = { block, text };
    return block;
  };

  const sealCommentary = () => {
    if (!activeCommentary) return;
    const cur = activeCommentary;
    flushCommentaryDom(cur);
    cur.block.classList.remove('is-streaming');
    const trimmed = cur.text.trim();
    if (trimmed) {
      renderRichMessage(cur.block, trimmed);
      lastSettledCommentary = { block: cur.block, text: trimmed };
    } else {
      cur.block.remove();
    }
    activeCommentary = null;
  };

  const consumeTrailingAnswerPreview = finalAnswerText => {
    const target = String(finalAnswerText ?? '').trim();
    if (!target) return;
    if (activeCommentary) {
      const cur = activeCommentary;
      if (cur.rafId) {
        cancelAnimationFrame(cur.rafId);
        cur.rafId = 0;
      }
      const streamed = cur.text.trim();
      if (!streamed || target === streamed || target.startsWith(streamed) || streamed.startsWith(target)) {
        cur.block.remove();
        activeCommentary = null;
      } else {
        sealCommentary();
      }
    } else if (lastSettledCommentary && lastSettledCommentary.text === target && lastSettledCommentary.block === feed.lastElementChild) {
      lastSettledCommentary.block.remove();
      lastSettledCommentary = null;
    }
    resetStageThought();
    if (!feed.children.length && brokerZone.hidden && rulesZone.hidden) {
      headBar.hidden = true;
      hasAnyProcessActivity = false;
    }
  };

  const upsertToolStep = (tool, keyPrefix = '') => {
    if (!tool) return;
    ensureHeaderVisible();
    sealCommentary();
    resetStageThought();
    lastSettledCommentary = null;

    const key = `${keyPrefix}:${tool.callId || tool.name || Math.random()}`;
    let entry = stepMap.get(key);
    const info = classifyToolAction(tool.name, tool.args);

    if (!entry) {
      const batch = ensureBatch();
      if (info.category === 'edit') batch.stats.editedFiles.add(info.fileKey || info.target);
      else if (info.category === 'read') batch.stats.readFiles.add(info.fileKey || info.target);
      else if (info.category === 'command') batch.stats.commands += 1;
      else if (info.category === 'search') batch.stats.searches += 1;
      else if (info.category === 'notify') batch.stats.notifications += 1;
      else batch.stats.others += 1;

      const row = mk('details', `wrs-step is-${info.category}`);
      const sum = mk('summary', 'wrs-step-line');
      const ico = mk('span', 'wrs-step-icon');
      ico.innerHTML = STEP_ICONS[info.category] || STEP_ICONS.other;
      const verbEl = mk('span', 'wrs-step-verb', info.verb);
      const targetEl = mk('span', 'wrs-step-target', info.target);
      targetEl.hidden = !info.target;
      const statusDot = mk('span', 'wrs-step-state');
      sum.append(ico, verbEl, targetEl, statusDot);

      const detailBox = mk('div', 'wrs-step-detail-wrap');
      const argsPre = mk('pre', 'wrs-step-detail is-args');
      const outPre = mk('pre', 'wrs-step-detail is-out');
      detailBox.append(argsPre, outPre);
      row.append(sum, detailBox);
      batch.tree.append(row);

      entry = { row, verbEl, targetEl, statusDot, detailBox, argsPre, outPre, batch, wasRunning: false };
      stepMap.set(key, entry);
    }

    const st = tool.status || 'running';
    entry.row.dataset.status = st;
    const nowRunning = st === 'running';
    if (nowRunning && !entry.wasRunning) {
      entry.batch.runningCount += 1;
      entry.wasRunning = true;
    } else if (!nowRunning && entry.wasRunning) {
      entry.batch.runningCount = Math.max(0, entry.batch.runningCount - 1);
      entry.wasRunning = false;
    }

    if (info.target && !entry.targetEl.textContent) {
      entry.targetEl.textContent = info.target;
      entry.targetEl.hidden = false;
    }

    entry.statusDot.textContent = st === 'running'
      ? '执行中…'
      : st === 'failed'
        ? '失败'
        : (tool.durationMs != null && tool.durationMs > 0 ? `${(tool.durationMs / 1000).toFixed(1)}s` : '');

    // 若为编辑操作且包含修改前后文本，直接挂载内联红绿 Diff
    if (info.parsed?.oldText !== undefined && info.parsed?.newText !== undefined && !entry.detailBox.querySelector('.change-diff')) {
      entry.argsPre.hidden = true;
      entry.detailBox.prepend(createChangeDiff(info.parsed.oldText, info.parsed.newText));
    } else {
      const cleanArgs = typeof tool.args === 'string' ? tool.args : JSON.stringify(tool.args || '');
      entry.argsPre.textContent = cleanArgs.slice(0, 2400);
      entry.argsPre.hidden = !cleanArgs || cleanArgs === '{}';
    }

    const resTxt = String(tool.result || '');
    entry.outPre.textContent = resTxt.slice(0, 4000);
    entry.outPre.hidden = !resTxt;

    entry.batch.refreshSummary();
  };

  /**
   * 渲染 Bot 代理人接单语与可展开的守界润色委托书胶囊
   */
  const renderBrokerEnrichment = ({ directDispatch = false, platform = '', workspace = '', botName = '伙伴', greeting = '', enrichedPrompt = '', hardConstraints = [], engineName = '', modelLabel = '' } = {}) => {
    brokerZone.replaceChildren();
    brokerZone.hidden = false;

    if (greeting) {
      const greetEl = mk('div', 'wrs-broker-greeting', greeting);
      brokerZone.append(greetEl);
    }

    if (enrichedPrompt) {
      const pill = mk('details', 'wrs-broker-pill');
      const sum = mk('summary', 'wrs-broker-pill-sum');
      const engineBadge = engineName ? ` · 幕后工匠：${engineName}${modelLabel ? ` (${modelLabel})` : ''}` : '';
      sum.textContent = directDispatch ? `原始任务已直达 CLI${engineBadge}` : `✦ 已由「${botName}」守界润色委托书${engineBadge}`;
      const body = mk('div', 'wrs-broker-pill-body');
      if (Array.isArray(hardConstraints) && hardConstraints.length) {
        const lockBox = mk('div', 'wrs-broker-locks');
        lockBox.append(mk('strong', '', '已原样锁定的硬边界：'));
        for (const c of hardConstraints) lockBox.append(mk('span', 'wrs-lock-chip', c));
        body.append(lockBox);
      }
      if (platform) body.append(mk('div', '', `执行环境：${platform}${workspace ? ' · ' + workspace : ''}`));
      const pre = mk('pre', 'wrs-broker-brief', enrichedPrompt);
      body.append(pre);
      pill.append(sum, body);
      brokerZone.append(pill);
    }
  };

  return {
    node: root,
    setActiveState,
    setStartedAt(isoStr) {
      const parsed = parseValidMs(isoStr);
      if (parsed != null) {
        turnStartMs = parsed;
        refreshClockText();
      }
    },
    resetClock(isoStr) {
      const parsed = parseValidMs(isoStr);
      turnStartMs = parsed ?? Date.now();
      fallbackEndMs = null;
      firstEventMs = parsed;
      lastEventMs = parsed;
      explicitDurationMs = null;
      settledDurationMs = null;
      liveStartedWallMs = isTurnActive ? Date.now() : null;
      refreshClockText();
    },
    noteEventTime,
    setDurationMs(ms) {
      if (Number.isFinite(ms) && ms > 0) {
        explicitDurationMs = ms;
        settledDurationMs = ms;
        refreshClockText();
      }
    },
    pushThinking,
    sealActiveThought,
    pushCommentaryDelta,
    completeCommentaryBlock,
    sealCommentary,
    consumeTrailingAnswerPreview,
    upsertToolStep,
    sealCurrentBatch,
    showProjectInstructions,
    renderBrokerEnrichment,
    get lastCommentaryText() {
      return activeCommentary?.text || '';
    },
  };
}

/**
 * 群聊主面板轻量级跨智能体传信路标（如图 3 & 图 4：“已发消息给 [头像] 主程” / “消息来自 [头像] 主程”）
 */
export function createWhisperMarker({ direction = 'to', botId = '', botName = '成员', avatarHtml = '', onClick } = {}) {
  const wrap = mk('div', `wrs-whisper-row is-${direction}`);
  const btn = mk('button', 'wrs-whisper-pill');
  btn.type = 'button';
  btn.dataset.botId = botId;
  btn.title = `点击查看「${botName}」的独立原生会话工作面板`;

  const prefix = mk('span', 'wrs-whisper-prefix', direction === 'from' ? '消息来自' : '已发消息给');
  const av = mk('span', 'wrs-whisper-avatar');
  if (avatarHtml) av.innerHTML = avatarHtml;
  const name = mk('span', 'wrs-whisper-name', botName);

  btn.append(prefix, av, name);
  if (typeof onClick === 'function') {
    btn.onclick = () => onClick(botId);
  }
  wrap.append(btn);
  return wrap;
}

/**
 * 群聊/单聊主面板极简交互式 A/B 选项确认卡（如图 3：“你要看的是哪个客户端怎么跑？ [A] 维度 Agent  [B] 别的”）
 */
export function createChoicePromptCard({ question = '', options = [], onSelect } = {}) {
  const card = mk('div', 'wrs-choice-card');
  if (question) {
    card.append(mk('div', 'wrs-choice-title', question));
  }
  const list = mk('div', 'wrs-choice-list');
  const letters = 'ABCDEFGH';

  (options || []).forEach((opt, idx) => {
    const label = typeof opt === 'string' ? opt : (opt?.label || opt?.text || '');
    const value = typeof opt === 'string' ? opt : (opt?.value || label);
    if (!label) return;

    const item = mk('button', 'wrs-choice-btn');
    item.type = 'button';
    const keyBadge = mk('span', 'wrs-choice-key', letters[idx] || String(idx + 1));
    const textSpan = mk('span', 'wrs-choice-label', label);
    item.append(keyBadge, textSpan);

    item.onclick = () => {
      if (card.dataset.resolved === '1') return;
      card.dataset.resolved = '1';
      card.classList.add('is-resolved');
      item.classList.add('is-picked');
      list.querySelectorAll('button').forEach(b => { b.disabled = true; });
      onSelect?.(value, label);
    };
    list.append(item);
  });

  card.append(list);
  return card;
}
