/*
 * DimensionAgent frontend. Copyright (c) 2026 Lzum1Guce.
 * Existing third-party source notices follow.
 * Modified from OpenMausBot official shell/UI interaction.
 * Upstream: https://github.com/milind-soni/OpenMausBot
 * Reference: v0.1.151 / commit b33a1c6437e2b5ea55000d89210727812ea2f21d
 * Upstream copyright 2026 Milind Soni and OpenMausBot contributors, Apache-2.0.
 * See LICENSES/OpenMausBot-Apache-2.0.txt and LICENSES/OpenMausBot-NOTICE.txt.
 * Changes: vanilla Dimension Agent client on the existing 18788 API;
 * chat transcript shows dialogue only; no mascot or upstream trademarks;
 * locked popup-close behavior is preserved.
 * Native preview additions: persistent Bot/group rosters and explicit system-message labels.
 */
import {
  SEAL_SHAPES,
  SEAL_COLORS,
  paperSealSvg,
  resolvePaperSeal,
  readLocalSeal,
  writeLocalSeal,
} from './paper-seal.js';
import { dimensionBotAvatar, startDimensionBots } from './dimension-bot-avatar.js';
import { startMotionFx } from './motion-fx.js';
import { bindMentionPicker, bindWorkShellUi, clearSpeaking, createVirtualList, highlightMentions, orderBotsForList, upsertSpeaking } from './group-work-ui.js';
import { openStickerPicker, renderStickers } from './stickers.js';
import { createGroupStreams } from './group-stream-state.js';
import { reconcileGroupRosters } from './group-roster.js';
import { insertGroupMessage } from './group-message-ui.js';
import { appendTranscript, changeTranscript, initTranscriptFollow, pinTranscriptToBottom } from './transcript-scroll.js';
import { createThoughtStream } from './thought-stream.js';
import { createWorkSessionUi } from './work-session-ui.js';
import { createSidebarState } from './sidebar-state-ui.js';
import { bindSharedCapabilities } from './shared-capabilities-ui.js';
import { createChangeDiff } from './change-diff-ui.js';
import { applyTheme, bindClientSettings, bindSidebarCollapse, readClientSettings } from './client-settings-ui.js';
import { bindContextUsage } from './context-usage-ui.js';
import { decorateMessage, sourceReference, openMessageMenu, closeMessageMenu, copyMessageText, messageActionNotice } from './message-context-ui.js';
import { ensureRelaySvg, shootRelayArc } from './group-relay-fx.js';
import { createConversationDrafts } from './experience-drafts.js';
import { renderRichMessage } from './markdown-lite.js';
import { createWorkArtifactsDock } from './work-artifacts-dock.js';
import { createWorkRosterTree } from './work-roster-tree.js';
import { initAnimeFx } from './anime-fx.js';
import { initGalgameStage, syncGalgameContext, syncGalgameStoryState, onGalgameUserMessage, onGalgameStream, onGalgameMessage, onGalgameGroupMessage, onGalgameGroupTyping, notifyGalgameNotice, stripMoodTag, getGalgameCgSnapshot, setGalgameBackgroundUrl } from './galgame-stage.js';
import { createStoryTheaterV3Controller, STORY_TEMPLATES, extractInnerVoice, rollFateDice, v3Icon } from './story-theater-v3.js';
import { createPlaygroundController } from './playground-ui.js';
import { openCliReceptionModal, isCliSelection, formatCliSelectionLabel, cliGearSvg, cliTerminalSvg } from './cli-reception-modal.js';

let syncChatImageDraftFn = () => {};
let playgroundUi = null;

const groupStreams = createGroupStreams();
const remoteChatActive = new Set();

const $ = (id) => document.getElementById(id);
const toast = (msg) => messageActionNotice(msg);

const state = {
  botId: 'new-character',
  botName: '小草橘',
  productName: '维度 Agent',
  bots: [],
  providers: [],
  activeProvider: '',
  model: '',
  socket: null,
  helloName: '控制台',
  pending: false,
  bootstrapped: false,
  persistentGroupRosters: false,
  persistentBotRosters: false,
  switching: false,
  uiTicket: 0,
  backdropArmed: false,
  ignoreClickTimer: 0,
  catalog: {},
  modules: [],
  modelSelection: null,
  conversationModel: null,
  shellMode: 'chat',
  workBots: [],
  groups: [],
  activeGroupId: null,
  savedChatNodes: null,
  savedPreGroupNodes: null,
  soloWork: false,
  groupMode: 'discuss',
  approvalMode: 'auto',
  workSettings: { approvalMode: 'auto', projectCwd: null },
  pendingApprovals: [],
  activeWorkRun: null,
  activeWorkBotId: null,
  sessionIdentity: null,
  drawerClosing: false,
  selections: { chat: null, work: null },
  lastSelectedBots: { chat: null, work: null },
};

function openTopLayerDialog({
  title = '请确认',
  message = '',
  hasInput = false,
  value = '',
  placeholder = '',
  maxLength = 520,
  allowEmpty = false,
  confirmLabel = '确定',
  cancelLabel = '取消',
  danger = false,
} = {}) {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'paper-confirm-dialog';
    const body = document.createElement('form');
    body.method = 'dialog';
    body.className = 'paper-prompt-body';

    const h2 = document.createElement('h2');
    h2.className = 'paper-prompt-title';
    h2.textContent = title;
    body.append(h2);

    if (message) {
      const p = document.createElement('p');
      p.className = 'paper-prompt-text';
      p.textContent = message;
      body.append(p);
    }

    let inputEl = null;
    if (hasInput) {
      inputEl = document.createElement('input');
      inputEl.type = 'text';
      inputEl.className = 'paper-prompt-input';
      inputEl.maxLength = maxLength;
      inputEl.value = value ?? '';
      inputEl.placeholder = placeholder || '';
      inputEl.autocomplete = 'off';
      body.append(inputEl);
    }

    const errMsg = document.createElement('p');
    errMsg.className = 'paper-prompt-msg';
    body.append(errMsg);

    const actions = document.createElement('div');
    actions.className = 'paper-prompt-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'paper-prompt-cancel';
    cancelBtn.textContent = cancelLabel;
    const okBtn = document.createElement('button');
    okBtn.type = 'submit';
    okBtn.className = `paper-prompt-ok${danger ? ' is-danger' : ''}`;
    okBtn.textContent = confirmLabel;
    actions.append(cancelBtn, okBtn);
    body.append(actions);
    dlg.append(body);
    document.body.append(dlg);

    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve(result);
    };

    cancelBtn.onclick = () => finish({ confirmed: false, value: null });
    dlg.addEventListener('cancel', e => { e.preventDefault(); finish({ confirmed: false, value: null }); });
    dlg.addEventListener('click', e => { if (e.target === dlg) finish({ confirmed: false, value: null }); });
    body.onsubmit = e => {
      e.preventDefault();
      if (inputEl) {
        const raw = String(inputEl.value ?? '');
        if (!allowEmpty && !raw.trim()) {
          errMsg.textContent = '请输入内容后再确认';
          inputEl.focus();
          return;
        }
        finish({ confirmed: true, value: raw });
        return;
      }
      finish({ confirmed: true, value: '' });
    };

    dlg.showModal();
    if (inputEl) {
      inputEl.focus();
      inputEl.select();
    } else {
      okBtn.focus();
    }
  });
}

window.__dimensionConfirm = opts => openTopLayerDialog(
  typeof opts === 'string'
    ? { title: '请确认', message: opts, danger: true }
    : { title: opts?.title || '请确认', message: opts?.message || '', confirmLabel: opts?.confirmLabel || '确定', danger: Boolean(opts?.danger ?? true) }
).then(res => res.confirmed);

window.__dimensionPrompt = opts => openTopLayerDialog(
  typeof opts === 'string'
    ? { title: opts, hasInput: true }
    : {
        title: opts?.title || '请输入',
        message: opts?.message || '',
        hasInput: true,
        value: opts?.value || '',
        placeholder: opts?.placeholder || '',
        allowEmpty: Boolean(opts?.allowEmpty),
        confirmLabel: opts?.confirmLabel || '确定',
      }
).then(res => (res.confirmed ? res.value : null));

let workRosterTree = null;
let linuxDesktopApi = null;
let ensureLinuxDesktopFn = null;

const workDock = createWorkArtifactsDock({
  host: $('workDock'),
  workspaceEl: $('workspace'),
  api,
  onCheckpointRestored: runId => workSession?.reloadArtifacts?.(runId),
  onManualRefresh: runId => workSession?.reloadArtifacts?.(runId),
  onPickProjectCwd: () => pickWorkCwd(),
  onOpenDesktopEmbed: async (container, opts = {}) => {
    if (!ensureLinuxDesktopFn) return;
    const mod = await ensureLinuxDesktopFn();
    linuxDesktopApi = mod;
    await mod?.attachEmbedded?.(container, opts);
  },
  onDetachDesktopEmbed: () => {
    linuxDesktopApi?.detachEmbedded?.();
  },
  onQuoteBrowserContext: ctx => {
    const input = $('composerInput');
    if (!input || !ctx?.url) return;
    const title = String(ctx.title || '').trim();
    const sel = String(ctx.selection || '').trim();
    const snippet = sel || String(ctx.text || '').trim().slice(0, 800);
    const lines = [
      `[参考网页] ${title ? `${title} - ` : ''}${ctx.url}`,
      snippet ? `> ${snippet.replace(/\n+/g, ' ')}` : '',
    ].filter(Boolean);
    const block = lines.join('\n');
    const prev = input.value.trim();
    input.value = prev ? `${prev}\n\n${block}\n` : `${block}\n`;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    toast(sel ? '已引用网页链接与选中内容到输入框' : '已引用当前网页上下文到输入框');
  },
  onVisibilityChange: open => {
    const b = $('workBrowserBtn');
    if (b) {
      b.classList.toggle('is-active', Boolean(open));
      b.setAttribute('aria-pressed', open ? 'true' : 'false');
    }
  },
  onLayoutChange: () => {
    if (workDock?.isOpen() && isDrawerOpen()) openDrawer(false);
    syncWindowChrome();
    pulseChatColumn(260);
  },
  getBots: () => knownBots(),
  getProviderGroups: () => (state.providers || []).map(item => ({
    providerId: item.name || item.id,
    title: item.title || item.name || item.id,
    models: providerModels(item).length ? providerModels(item) : (item.model ? [item.model] : []),
  })).filter(g => g.providerId),
  getActiveBotId: () => state.botId,
  getProjectCwd: () => state.workSettings?.projectCwd || '',
  getLatestUserInput: () => $('composerInput')?.value?.trim() || '',
  onBotPromoted: bot => {
    if (!bot?.id) return;
    mergeKnownBots([bot]);
    renderBotList();
    if (isWorkShell()) void workRosterTree?.refresh();
  },
  onNotify: msg => toast(msg),
});

const sidebarActivity = createSidebarState({
  api, getBotIds: () => [...readSidebarPrefs().chatBots, ...readSidebarPrefs().workBots, state.botId].filter(Boolean),
  onChange: data => {
    mergeKnownBots(data.bots);
    const ids = (data.work || []).filter(row => row.active).map(row => row.botId);
    if (!state.persistentBotRosters && ids.some(id => !workRosterIds().has(id))) updateSidebarPrefs(prefs => { prefs.workBots = [...new Set([...prefs.workBots, ...ids])]; });
    renderBotList();
    if (isWorkShell()) void workRosterTree?.refresh();
  },
});

const workSession = createWorkSessionUi({
  api,
  getTranscript: () => $('transcript'),
  nameOf: botNameOf,
  avatarOf: (id, size = 36, avatarState = 'idle') => {
    const bot = knownBots().find(item => item.id === id) || { id, name: typeof botNameOf === 'function' ? botNameOf(id) : id };
    return botAvatar(bot, size, avatarState);
  },
  groupMembersOf: () => currentGroup()?.members || [],
  getProjectCwd: () => state.workSettings?.projectCwd || '',
  onPickProjectCwd: () => pickWorkCwd(),
  dock: workDock,
  onBusy: (busy, runId, botId) => {
    state.activeWorkRun = runId || null; state.activeWorkBotId = botId || null;
    if ($('workStopBtn')) $('workStopBtn').hidden = !busy;
    if (isWorkShell()) setPending(busy);
  },
  onApproval: (botId) => { state.activeWorkBotId = botId; refreshWorkPending(); },
  onDiscuss: (text, quote) => { if (quote) setGroupQuote(quote); return sendGroup(text, { mode: 'discuss' }); },
  onQuote: quote => setGroupQuote(quote),
  onChange: () => {
    void sidebarActivity.refresh();
    void workRosterTree?.refresh();
  },
  onThreadChanged: () => {
    workRosterTree?.render();
    void workRosterTree?.refresh();
  },
});

workRosterTree = createWorkRosterTree({
  host: $('workRosterHost'),
  api,
  getBots: () => visibleModeBots(),
  getGroups: () => modeGroupList(),
  getQuery: () => sidebarQuery(),
  getActiveState: () => ({
    botId: hasConversation() && !state.activeGroupId ? state.botId : '',
    groupId: state.activeGroupId || '',
    runId: workSession.currentRunId(),
    isNewThread: workSession.isNewThread(),
  }),
  botDisplayNameOf: bot => displayBotName(bot),
  botAvatarOf: (bot, size, avatarState) => botAvatar(bot, size, avatarState),
  groupAvatarOf: (group, size) => groupAvatar(group, size),
  isBotPinned: bot => botSeal(bot).pinned === true,
  promptText: opts => window.__dimensionPrompt(opts),
  confirmDanger: opts => window.__dimensionConfirm({ ...opts, danger: true }),
  onBotContextMenu: (botId, pos) => openBotContextMenu(botId, pos),
  onGroupContextMenu: group => openGroupSettings(group.id),
  onThreadDeleted: (_runId, removedIds) => {
    workSession.removeRunIds(removedIds);
    void sidebarActivity.refresh();
  },
  onSelectThread: async ({ kind, id, runId }) => {
    if (!isWorkShell()) setShellMode('work', { restoreSelection: false });
    if (kind === 'group') {
      if (state.activeGroupId === id) {
        await workSession.reveal(runId);
        workRosterTree?.render();
        return;
      }
      state.pendingGroupWorkFocus = { groupId: id, runId };
      await openGroup(id, { keepNotice: true });
      return;
    }
    if (!state.activeGroupId && state.botId === id && state.soloWork) {
      await workSession.reveal(runId);
      workRosterTree?.render();
      return;
    }
    state.pendingWorkFocus = { botId: id, runId };
    await activateBot(id);
  },
  onNewThread: async ({ kind, id, projectCwd }) => {
    if (!isWorkShell()) setShellMode('work', { restoreSelection: false });
    if (kind === 'bot' && typeof projectCwd === 'string' && projectCwd && projectCwd !== (state.workSettings?.projectCwd || '')) {
      try {
        const res = await api('/api/dimension/work/pick-cwd', { method: 'POST', body: JSON.stringify({ botId: id, path: projectCwd }) });
        if (res?.settings && state.botId === id) state.workSettings = res.settings;
      } catch {}
    }
    if (kind === 'group') {
      if (state.activeGroupId === id) {
        workSession.startNewThread();
        workRosterTree?.render();
        return;
      }
      state.pendingGroupWorkFocus = { groupId: id, newThread: true };
      await openGroup(id, { keepNotice: true });
      return;
    }
    if (!state.activeGroupId && state.botId === id && state.soloWork) {
      workSession.startNewThread();
      workRosterTree?.render();
      return;
    }
    state.pendingWorkFocus = { botId: id, newThread: true };
    await activateBot(id);
  },
});

function hasConversation() {
  return Boolean(state.activeGroupId || state.selections?.[state.shellMode]);
}

function currentDraftContext() {
  if (!hasConversation()) return null;
  return { mode: state.shellMode, botId: state.activeGroupId ? '' : state.botId, groupId: state.activeGroupId || '' };
}

function syncDraftStatus({ state: status = 'empty', message = '' } = {}) {
  const node = $('draftStatus');
  if (!node) return;
  const labels = {
    empty: '未寄出的字句会静静留存在当前草稿笺', saving: '正在落墨暂存…',
    saved: '草稿已收好 · 仅留在此页', restored: '已为你拾回未寄出的草稿',
    local: '草稿已留在本机笺纸 · 尚未寄出', error: '草稿暂未同步至服务 · 尚未寄出',
  };
  node.textContent = message || labels[status] || labels.empty;
  node.dataset.state = status;
  // “已拾回草稿”只提示片刻，之后收起，不再一直占着发送键旁的位置
  clearTimeout(syncDraftStatus.timer);
  if (status === 'restored') {
    syncDraftStatus.timer = setTimeout(() => { if (node.dataset.state === 'restored') node.dataset.state = 'saved'; }, 3200);
  }
}

const conversationDrafts = createConversationDrafts(api, { onStatus: syncDraftStatus });

function showConversationWelcome() {
  if (hasConversation()) return;
  state.soloWork = false;
  const transcript = $('transcript');
  if (transcript) transcript.innerHTML = '<div class="conversation-welcome"><img src="/dimension-ui/startup-wordmark.png?v=673d8762a6" alt="DimensionAgent"><p>在左侧点亮一枚伙伴印章，或推开茶会圆桌的门扉 ✦</p></div>';
  syncConversationChrome(); setPending(false);
}

function workBadgeMarkup(id) {
  const badge = sidebarActivity.badge(id);
  return badge ? `<span class="bot-work-badge${badge.active ? ' is-working' : ''}">${escapeHtml(badge.label)}</span>` : '';
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  stripSecrets(data);
  if (!res.ok) throw Object.assign(new Error(data?.error?.message || data?.error || data?.message || `HTTP ${res.status}`), { status: res.status });
  return data;
}

async function uploadImageAsset(path, file) {
  if (!file?.size) throw new Error('请选择有效图片。');
  if (file.size > 8 * 1024 * 1024) throw new Error('图片最大 8 MB。');
  const extension = String(file.name || '').split('.').at(-1)?.toLowerCase();
  const mime = file.type || ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' })[extension];
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) throw new Error('请选择 PNG、JPEG、WebP 或 GIF 图片。');
  return api(path, { method: 'POST', headers: { 'content-type': mime }, body: file });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function isInternalText(text) {
  const value = String(text || '').trim();
  if (/^控制台(?:已)?在线[，,。.!！\s]*(?:我在[，,。.!！\s]*)?(?:有事就说[，,。.!！\s]*)?$/.test(value)) return true;
  return /^(?:\[brain:|\[memory\]|\[system\]|\[系统\]|\[time\]|\[handoff\]|\[affect\])/i.test(value);
}

function openTarotGalleryWithSwitch() {
  const tarot = window.DimensionTarot;
  if (!tarot) return;
  tarot.openGallery({
    onSelectBot: (targetBotId, meta) => {
      const bots = typeof knownBots === 'function' ? knownBots() : (state.bots || []);
      let matched = bots.find((b) => b.id === targetBotId);
      if (!matched && meta?.aliases) {
        matched = bots.find((b) => {
          const hay = `${b.id || ''} ${b.name || ''}`.toLowerCase();
          return meta.aliases.some((al) => hay.includes(al));
        });
      }
      if (matched) {
        activateBot(matched.id);
      } else if (meta) {
        tarot.openLightbox(meta.key);
      }
    },
  });
}

function updateEmptyHint() {
  const hint = $('emptyHint');
  if (!hint) return;
  hint.textContent = `和 ${state.botName} 打个招呼吧。这里只会显示对白。`;
  const hasBubble = Boolean($('transcript').querySelector('.bubble'));
  hint.hidden = hasBubble;
}

function prependReasoningFold(container, reasoning) {
  const txt = String(reasoning || '').trim();
  if (!container || !txt || container.querySelector('.chat-reasoning-fold')) return;
  const details = document.createElement('details');
  details.className = 'chat-reasoning-fold';
  const sum = document.createElement('summary');
  sum.textContent = '✦ 思考过程';
  const body = document.createElement('div');
  body.className = 'chat-reasoning-body';
  body.textContent = txt;
  details.append(sum, body);
  container.prepend(details);
}

function openChatImageLightbox(src) {
  const box = $('chatImageLightbox');
  const img = $('chatImageLightboxImg');
  if (!box || !img || !src) return;
  img.src = src;
  box.hidden = false;
}
function closeChatImageLightbox() {
  const box = $('chatImageLightbox');
  if (box) box.hidden = true;
}

let privateStreamState = { el: null, text: '', raf: 0 };
function clearPrivateStreamBubble() {
  if (privateStreamState.raf) { cancelAnimationFrame(privateStreamState.raf); privateStreamState.raf = 0; }
  if (privateStreamState.el) {
    privateStreamState.el.remove();
    privateStreamState.el = null;
  }
  privateStreamState.text = '';
}
function upsertPrivateStreamBubble(phase, delta = '', query = '') {
  if (isWorkShell() || state.activeGroupId) return;
  const transcript = $('transcript');
  if (!transcript) return;
  let el = privateStreamState.el;
  if (!el || !el.isConnected) {
    el = document.createElement('div');
    el.className = 'bubble assistant is-streaming';
    privateStreamState.el = el;
    privateStreamState.text = '';
    // 流式气泡出现后撤掉“正在等待”的占位气泡，避免两三个“思考中”同时出现
    changeTranscript(transcript, () => {
      transcript.querySelector('#pendingBubble')?.remove();
      transcript.appendChild(el);
      updateEmptyHint();
    });
  }
  if (phase === 'lookup') {
    const qText = String(query || delta || '').trim();
    onGalgameStream('lookup', qText);
    if (!privateStreamState.text) {
      changeTranscript(transcript, () => {
        const note = document.createElement('span');
        note.className = 'chat-stream-thinking';
        note.textContent = qText ? `✦ 悄悄查一下「${qText}」…` : '✦ 悄悄查一下相关资料…';
        el.replaceChildren(note);
      });
    }
    return;
  }
  if (phase === 'thinking' && !privateStreamState.text) {
    onGalgameStream('thinking', '');
    changeTranscript(transcript, () => {
      el.innerHTML = '<span class="chat-stream-thinking">✦ 正在深度思考…</span>';
    });
    return;
  }
  if (phase === 'delta' && delta) {
    privateStreamState.text += delta;
    onGalgameStream('delta', privateStreamState.text);
    // 每帧最多渲染一次；只有读者停在底部时才跟随，往上翻阅历史不会被拽回。
    if (privateStreamState.raf) return;
    privateStreamState.raf = requestAnimationFrame(() => {
      privateStreamState.raf = 0;
      const target = privateStreamState.el;
      if (!target || !target.isConnected) return;
      const display = stripMoodTag(privateStreamState.text).replace(/\s*\|\|\s*/g, '\n\n');
      changeTranscript(transcript, () => renderRichMessage(target, display));
    });
  }
}

function hydrateChatImages(container) {
  if (!container) return;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const targets = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeValue && node.nodeValue.includes('[chat-image:')) targets.push(node);
  }
  for (const textNode of targets) {
    const raw = textNode.nodeValue || '';
    const re = /\[chat-image:([A-Za-z0-9_-]{4,64})\]/g;
    let last = 0;
    let m;
    const frag = document.createDocumentFragment();
    while ((m = re.exec(raw)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(raw.slice(last, m.index)));
      const wrap = document.createElement('div');
      wrap.className = 'chat-inline-image-wrap';
      const img = document.createElement('img');
      img.className = 'chat-inline-image';
      img.src = `/api/dimension/chat/images/${encodeURIComponent(m[1])}`;
      img.alt = '聊天图片';
      img.loading = 'lazy';
      img.addEventListener('click', () => openChatImageLightbox(img.src));
      wrap.appendChild(img);
      frag.appendChild(wrap);
      last = m.index + m[0].length;
    }
    if (last < raw.length) frag.appendChild(document.createTextNode(raw.slice(last)));
    textNode.parentNode?.replaceChild(frag, textNode);
  }
}

function refreshPrivateRegenButton() {
  const transcript = $('transcript');
  if (!transcript) return;
  changeTranscript(transcript, () => {
    for (const old of transcript.querySelectorAll('.chat-regen-bar')) old.remove();
    if (isWorkShell() || state.activeGroupId || !state.botId) return;
    const bubbles = [...transcript.querySelectorAll('.bubble')];
    const last = bubbles[bubbles.length - 1];
    if (!last || !last.classList.contains('assistant') || !last.dataset.messageId) return;
    const bar = document.createElement('div');
    bar.className = 'chat-regen-bar';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-regen-btn';
    btn.textContent = '↻ 换一句';
    btn.title = '删除本轮回复并重新生成';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      void regeneratePrivateChat();
    });
    bar.appendChild(btn);
    last.appendChild(bar);
  });
}

async function regeneratePrivateChat() {
  if (isWorkShell() || state.activeGroupId || !state.botId || state.pending) return;
  setPending(true);
  try {
    const res = await api(`/api/dimension/bots/${encodeURIComponent(state.botId)}/chat/regenerate`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const scope = quoteScope();
    for (const mid of (res?.deletedIds || [])) {
      removeMessageLocally(scope, String(mid));
    }
    toast('正在重新生成本轮回复…');
  } catch (err) {
    setPending(false);
    toast(err?.message || '重新生成失败');
  }
}

function addBubble(role, text, who, identity = {}) {
  // 系统提示（断线、失败、进群提示等）不再冒充角色发言，统一渲染为居中的系统通知条
  if (role === 'assistant' && who === '系统') role = 'system';
  if (!text || (role !== 'user' && isInternalText(text))) return;
  if (messageWasDeleted(quoteScope(), identity.messageId)) return;
  const transcript = $('transcript');
  const existing = [...transcript.querySelectorAll('.bubble:not(.is-streaming)')].find(node =>
    (identity.messageId && node.dataset.messageId === identity.messageId) || (identity.requestId && node.classList.contains(role) && node.dataset.requestId === identity.requestId));
  if (existing) {
    if (role === 'assistant') existing.dataset.rawMoodText = text;
    changeTranscript(transcript, () => {
      if (role === 'assistant') clearPrivateStreamBubble();
      if (identity.messageId) existing.dataset.messageId = identity.messageId;
      if (identity.reasoning) prependReasoningFold(existing, identity.reasoning);
      if (identity.sourceRef || identity.context) presentMessage(existing, { ...identity, text: role === 'assistant' ? stripMoodTag(text) : text, from: role === 'user' ? 'user' : identity.from || who });
      refreshPrivateRegenButton();
    });
    return existing;
  }
  const el = document.createElement('div');
  el.className = `bubble ${role}`;
  if (role === 'assistant') el.dataset.rawMoodText = text;
  const cleanText = role === 'assistant' ? stripMoodTag(text) : text;
  if (role === 'user') renderStickers(el, cleanText);
  else renderRichMessage(el, cleanText);
  hydrateChatImages(el);
  if (role === 'assistant' && identity.reasoning) prependReasoningFold(el, identity.reasoning);
  if (role === 'system' || identity.actor === 'system') {
    const source = document.createElement('span');
    source.className = 'message-source system-source'; source.textContent = '✦ 系统提示';
    el.prepend(source);
  }
  if (identity.messageId) el.dataset.messageId = identity.messageId;
  if (identity.requestId) el.dataset.requestId = identity.requestId;
  presentMessage(el, { ...identity, text: cleanText, from: role === 'user' ? 'user' : identity.from || who });
  changeTranscript(transcript, () => {
    if (role === 'assistant') clearPrivateStreamBubble();
    transcript.appendChild(el);
    updateEmptyHint();
    refreshPrivateRegenButton();
  });
  if (!isWorkShell() && !state.activeGroupId && !state.soloWork) {
    if (role === 'user' && !identity.history) onGalgameUserMessage(text);
    else onGalgameMessage(role, text, { history: Boolean(identity.history) });
  }
  return el;
}

function quoteScope() { return JSON.stringify([state.shellMode, state.activeGroupId || '', state.activeGroupId ? '' : state.botId]); }
const deletedMessageIds = new Set();
function messageWasDeleted(scope, id) { return Boolean(id && deletedMessageIds.has(scope + ':' + id)); }
function presentMessage(node, message, scope = quoteScope()) {
  decorateMessage(node, message, { nameOf: botNameOf, onQuote: quote => {
    if (scope === quoteScope()) setGroupQuote({ ...quote, scope });
  }, onMenu: (source, event, anchor) => openChatMessageMenu({ ...source, scope }, event, anchor) });
  node.messageSource.scope = scope;
}

function openChatMessageMenu(source, event, anchor) {
  if (source.scope !== quoteScope() || state.groupSelecting) return;
  const [mode, groupId] = JSON.parse(source.scope);
  const saved = mode === 'chat' && Boolean(source.sourceRef?.messageId);
  const items = [
    { id: 'quote', label: '引用', disabled: !source.sourceRef, run: () => setGroupQuote(source) },
    { id: 'copy', label: '复制', run: async () => { await copyMessageText(source.text); messageActionNotice('已复制'); } },
    { id: 'delete', label: '删除', danger: true, disabled: !saved, run: () => confirmMessageDelete(source) },
    { id: 'forward', label: '转发', disabled: !saved, run: () => openForwardDialog([source]) },
  ];
  if (!groupId && mode === 'chat' && source.from !== 'user') {
    items.unshift({ id: 'regen', label: '重新生成', disabled: state.pending, run: () => void regeneratePrivateChat() });
  }
  if (groupId && mode === 'chat') items.push({ id: 'select', label: '多选', run: () => setGroupSelecting(true) });
  openMessageMenu({ anchor, ...(event.type === 'contextmenu' ? { x: event.clientX, y: event.clientY } : {}), items });
}

function removeMessageLocally(scope, messageId) {
  if (!messageId) return;
  deletedMessageIds.add(scope + ':' + messageId);
  const matches = node => node?.dataset?.messageId === messageId && node.messageSource?.scope === scope;
  for (const key of ['savedChatNodes', 'savedPreGroupNodes']) {
    if (Array.isArray(state[key])) state[key] = state[key].filter(node => !matches(node));
  }
  changeTranscript($('transcript'), () => {
    for (const node of $('transcript').querySelectorAll('.bubble[data-message-id], .gmsg[data-message-id]')) if (matches(node)) node.remove();
  });
  if (state.groupQuote?.scope === scope && state.groupQuote.sourceRef?.messageId === messageId) setGroupQuote(null);
  if (scope === quoteScope()) { if (!state.activeGroupId) updateEmptyHint(); syncGroupSelectBar(); }
}

function confirmMessageDelete(source) {
  if (source.scope !== quoteScope() || !source.sourceRef?.messageId) return;
  const [mode, groupId, botId] = JSON.parse(source.scope);
  if (mode !== 'chat') return;
  const route = groupId ? `groups/${encodeURIComponent(groupId)}` : `bots/${encodeURIComponent(botId)}`;
  showModal(`<div class="create-bot-body message-delete-dialog">
    <h2 class="create-bot-title">删除这条消息？</h2>
    <p class="create-bot-hint">人设和记忆保留。已被引用或转发的副本仍会保留。</p>
    <div class="message-delete-preview">${escapeHtml(source.text.slice(0, 500))}${source.text.length > 500 ? '…' : ''}</div>
    <p class="create-bot-msg" role="status"></p>
    <div class="message-delete-actions"><button type="button" data-cancel-delete>取消</button><button type="button" data-confirm-delete>删除</button></div>
  </div>`, false, 'create-bot');
  const dialog = document.querySelector('.message-delete-dialog');
  dialog.querySelector('[data-cancel-delete]').onclick = closeModal;
  dialog.querySelector('[data-confirm-delete]').onclick = async event => {
    if (source.scope !== quoteScope()) { closeModal(); return; }
    const button = event.currentTarget, status = dialog.querySelector('[role=status]');
    button.disabled = true; status.textContent = '正在删除…';
    try {
      await api(`/api/dimension/${route}/messages/${encodeURIComponent(source.sourceRef.messageId)}`, { method: 'DELETE' });
      removeMessageLocally(source.scope, source.sourceRef.messageId);
      if (dialog.isConnected) closeModal();
      messageActionNotice('已删除消息');
    } catch (error) { status.textContent = error.message || '删除失败，请重试。'; }
    finally { button.disabled = false; }
  };
}

const attachmentDrafts = new Map();
function attachmentDraft() {
  const key = quoteScope();
  if (!attachmentDrafts.has(key)) {
    attachmentDrafts.set(key, { images: [], stickers: [], uploading: 0 });
  }
  return attachmentDrafts.get(key);
}

function syncStickerDraft() {
  const host=$('chatStickerDraft');if(!host)return;
  host.hidden=isWorkShell() || !attachmentDraft().stickers.length;
  host.replaceChildren(...attachmentDraft().stickers.map((row,index)=>{
    const button=document.createElement('button');button.type='button';button.title=`移除表情：${row.name}`;
    renderStickers(button,`[sticker:${row.id}]`);button.onclick=()=>{attachmentDraft().stickers.splice(index,1);syncStickerDraft();syncSendEnabled($('composerInput'),$('sendBtn'));};return button;
  }));
}

const PENDING_WHISPERS = [
  '✦ 正在斟酌词句…',
  '✦ 思绪星屑汇聚中…',
  '✦ 羽毛笔沙沙落墨中…',
  '✦ 正在组织恰到好处的回应…',
];
let pendingWhisperIdx = 0;

function setPending(on) {
  state.pending = on;
  // 群聊里 pending 不锁输入：回合在跑时也允许插话。
  // 插话：任何视图都可以在回合进行中继续发，新消息在回合边界被接收。
  syncSendEnabled($('composerInput'), $('sendBtn'), false);
  syncThinkSlot();
  let pending = $('transcript').querySelector('.bubble.pending');
  // 群/工位视图不立等待气泡：思考行和状态条已提示「在跑」，气泡只会卡在消息中间留白。
  const quiet = Boolean(state.activeGroupId || state.soloWork);
  // 私聊等待回复时，发送键显示“回应中”的转圈态（仍可点，点了会提示稍候）
  $('sendBtn')?.classList.toggle('is-waiting', Boolean(on && !quiet && !isWorkShell()));
  if (on && !pending && !quiet) {
    pending = document.createElement('div');
    pending.className = 'bubble assistant pending';
    pending.id = 'pendingBubble';
    pending.textContent = PENDING_WHISPERS[pendingWhisperIdx++ % PENDING_WHISPERS.length];
    changeTranscript($('transcript'), () => { $('transcript').appendChild(pending); updateEmptyHint(); });
  } else if (!on && pending) {
    changeTranscript($('transcript'), () => { pending.remove(); updateEmptyHint(); });
  }
}

function displayAssistantName(from) {
  const name = String(from || '').trim();
  if (!name || /Lzum1Guce|DimensionAgent|Deepseek|new-character|维度 Agent/i.test(name)) return state.botName;
  return name;
}

function setModelStatus(text) {
  const el = $('modelReady');
  if (!el) return;
  const msg = String(text || '').trim();
  el.textContent = msg;
  el.hidden = !msg;
}

function modelChoices() {
  const rows = [];
  const seen = new Set();
  for (const item of state.providers) {
    const name = item.name || item.id;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const models = providerModels(item);
    if (!models.length && item.model) models.push(item.model);
    for (const model of models) {
      if (!model) continue;
      rows.push({ providerId: name, model, label: model });
    }
  }
  if (!rows.length && state.activeProvider && state.model) {
    rows.push({ providerId: state.activeProvider, model: state.model, label: state.model });
  }
  const counts = {};
  for (const row of rows) counts[row.label] = (counts[row.label] || 0) + 1;
  for (const row of rows) {
    if (counts[row.label] > 1) row.label = `${row.model}（${row.providerId}）`;
  }
  return rows;
}

function isModelMenuOpen() {
  const menu = $('modelMenu');
  return Boolean(menu && !menu.hidden);
}

function closeModelMenu() {
  const menu = $('modelMenu');
  const btn = $('modelTrigger');
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function placeModelMenu() {
  const btn = $('modelTrigger');
  const menu = $('modelMenu');
  if (!btn || !menu || menu.hidden) return;
  const gap = 8;
  const rect = btn.getBoundingClientRect();
  const triggerWidth = Math.round(rect.width);
  const width = Math.max(triggerWidth, 280);
  menu.style.width = `${Math.min(Math.max(width, 280), Math.max(triggerWidth, 320))}px`;
  menu.style.maxWidth = `${Math.max(triggerWidth, 320)}px`;
  const menuHeight = menu.offsetHeight;
  const menuWidth = menu.offsetWidth || 300;
  let left = rect.left;
  let top = rect.top - gap - menuHeight;
  if (top < 8) top = rect.bottom + gap;
  const maxLeft = Math.max(8, window.innerWidth - menuWidth - 8);
  left = Math.min(Math.max(8, left), maxLeft);
  const maxTop = Math.max(8, window.innerHeight - menuHeight - 8);
  top = Math.min(Math.max(8, top), maxTop);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function openModelMenu() {
  const menu = $('modelMenu');
  const btn = $('modelTrigger');
  if (!menu || !btn) return;
  closeReviewMenu();
  closeBotContextMenu();
  renderModels();
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  placeModelMenu();
}

function toggleModelMenu() {
  if (isModelMenuOpen()) closeModelMenu();
  else openModelMenu();
}

function renderModels() {
  const trigger = $('modelTrigger');
  const nameEl = $('modelTriggerName');
  const menu = $('modelMenu');
  const current = currentSelection();
  const isCli = isCliSelection(current);
  const currentLabel = isCli ? formatCliSelectionLabel(current) : (current?.model || '');
  if (nameEl) nameEl.textContent = currentLabel || '选择模型';
  if (trigger) {
    trigger.setAttribute('aria-label', currentLabel ? `选择模型，当前：${currentLabel}` : '选择模型');
  }
  if (!menu) return;
  const keyIcon = `<svg class="model-menu-key-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><circle cx="5.25" cy="8" r="2.55" stroke="currentColor" stroke-width="1.5"/><path d="M7.7 8h5.35v2.15M11.15 8v2.15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const checkIcon = `<svg class="model-option-check" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><path d="M3.2 8.2 6.35 11.2 12.8 4.5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const cliSub = isCli ? formatCliSelectionLabel(current) : '选用本机 Code CLI 模型';
  const cliRowHtml = `
    <div class="model-menu-cli-row${isCli ? ' is-active' : ''}">
      <button type="button" class="model-menu-cli-main" id="modelMenuCliBtn" data-action="cli-reception">
        ${cliTerminalSvg(16)}
        <span class="model-menu-cli-copy">
          <span class="model-menu-cli-title">本机 CLI 接待</span>
          <span class="model-menu-cli-sub">${escapeHtml(cliSub)}</span>
        </span>
        ${isCli ? checkIcon : ''}
      </button>
      <button type="button" class="model-menu-cli-gear" id="modelMenuCliSettingsBtn" data-action="cli-reception-settings" title="打开本机 CLI 设置并查看可使用模型">${cliGearSvg(12)}<span>设置</span></button>
    </div>`;
  const choices = modelChoices();
  const items = choices.map((row) => {
    const on = !isCli && current && current.providerId === row.providerId && (current.model || '') === row.model;
    const value = `${row.providerId}\t${row.model}`;
    return `<button type="button" class="model-option${on ? ' is-active' : ''}" role="option" data-value="${escapeHtml(value)}" aria-selected="${on ? 'true' : 'false'}"><span class="model-option-name">${escapeHtml(row.label)}</span>${checkIcon}</button>`;
  }).join('');
  menu.innerHTML = `<button type="button" class="model-menu-key" id="modelMenuKeyBtn">${keyIcon}<span class="model-menu-key-text">添加或更改密钥</span></button>${cliRowHtml}<div class="model-menu-sep" role="separator"></div>${items}`;
}

function bindModelSwitch() {
  const trigger = $('modelTrigger');
  const menu = $('modelMenu');
  if (!trigger || !menu || trigger.dataset.bound === '1') return;
  trigger.dataset.bound = '1';
  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleModelMenu();
  });
  menu.addEventListener('click', async (event) => {
    const cliBtn = event.target.closest('[data-action="cli-reception"], [data-action="cli-reception-settings"]');
    if (cliBtn) {
      event.preventDefault();
      closeModelMenu();
      openBotCliReceptionSettings();
      return;
    }
    const keyBtn = event.target.closest('.model-menu-key');
    if (keyBtn) {
      event.preventDefault();
      closeModelMenu();
      await openKeySettings();
      return;
    }
    const option = event.target.closest('.model-option');
    if (!option) return;
    event.preventDefault();
    const selection = parseSelectionValue(option.dataset.value || '');
    const current = currentSelection();
    closeModelMenu();
    if (!selection || (!isCliSelection(current) && current && selection.providerId === current.providerId && (selection.model || '') === (current.model || ''))) return;
    await switchModel(selection, { syncWorkLead: isCliSelection(current) });
  });
  document.addEventListener('pointerdown', (event) => {
    if (!isModelMenuOpen()) return;
    if (event.target.closest('#modelMenu, #modelTrigger')) return;
    closeModelMenu();
  });
  window.addEventListener('resize', () => { if (isModelMenuOpen()) placeModelMenu(); });
  window.visualViewport?.addEventListener('resize', () => { if (isModelMenuOpen()) placeModelMenu(); });
  window.visualViewport?.addEventListener('scroll', () => { if (isModelMenuOpen()) placeModelMenu(); });
}

function keyEyeSvg(hidden) {
  if (hidden) {
    return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><path d="M2.4 8s2.3-3.7 5.6-3.7S13.6 8 13.6 8s-2.3 3.7-5.6 3.7S2.4 8 2.4 8Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="8" cy="8" r="1.7" stroke="currentColor" stroke-width="1.5"/></svg>`;
  }
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><path d="M2.4 8s2.3-3.7 5.6-3.7S13.6 8 13.6 8s-2.3 3.7-5.6 3.7S2.4 8 2.4 8Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="8" cy="8" r="1.7" stroke="currentColor" stroke-width="1.5"/><path d="M3 13 13 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
}

function scrubSecret(text, secret) {
  let out = String(text || '');
  const value = String(secret || '');
  if (value && out.includes(value)) out = out.split(value).join('••••');
  return out;
}

async function openKeySettings(selectedName = '') {
  closeModelMenu();
  const ticket = bumpUiTicket();
  await loadProviders();
  if (!isCurrentUi(ticket)) return;
  const current = currentSelection();
  const preferred = selectedName || current?.providerId || state.activeProvider || state.providers[0]?.name || '';
  if (!preferred) {
    await openKeys();
    return;
  }
  const target = state.providers.find((item) => item.name === preferred) || state.providers[0];
  if (!target?.name) {
    await openKeys();
    return;
  }
  const html = `
    <div class="key-settings-body">
      <h2>密钥设置</h2>
      <div class="key-field">
        <input id="keySettingsSecret" type="password" autocomplete="off" placeholder="在此输入密钥" value="">
        <button type="button" class="key-eye" id="keySettingsEye" aria-label="显示或隐藏正在输入的内容" aria-pressed="false">${keyEyeSvg(true)}</button>
      </div>
      <p class="muted" id="keySettingsMsg"></p>
      <div class="key-settings-footer">
        <button type="button" class="key-cancel-btn" id="keySettingsCancel">取消</button>
        <button type="button" class="key-save-btn" id="keySettingsSave">保存</button>
      </div>
    </div>`;
  showModal(html, false, 'key-settings');
  $('backdrop')?.classList.add('is-key-settings');
  const input = document.getElementById('keySettingsSecret');
  const eye = document.getElementById('keySettingsEye');
  const msg = document.getElementById('keySettingsMsg');
  const say = (text) => { if (msg) msg.textContent = scrubSecret(text, input?.value); };
  eye?.addEventListener('click', () => {
    if (!input) return;
    const hide = input.type === 'text';
    input.type = hide ? 'password' : 'text';
    eye.setAttribute('aria-pressed', hide ? 'false' : 'true');
    eye.innerHTML = keyEyeSvg(hide);
  });
  document.getElementById('keySettingsCancel')?.addEventListener('click', () => closeModal());
  document.getElementById('keySettingsSave')?.addEventListener('click', async () => {
    const secretValue = input?.value || '';
    if (!secretValue) { closeModal(); return; }
    try {
      const detail = await api(`/api/providers/${encodeURIComponent(target.name)}`);
      const entry = cleanEntry(detail.entry);
      const payload = { name: target.name, entry, secretValue };
      if (detail.revision) payload.expectedRevision = detail.revision;
      await api(`/api/providers/${encodeURIComponent(target.name)}/save`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      await loadProviders();
      await refreshCatalogs();
      renderModels();
      closeModal();
    } catch (err) {
      say(err.message);
    }
  });
}

function botSeal(bot) {
  return readLocalSeal(bot?.id) || resolvePaperSeal(bot, null);
}

function sealMarkup(bot, size, breathe = false) {
  const seal = botSeal(bot);
  return paperSealSvg({
    shape: seal.shape,
    color: seal.color,
    name: bot?.name,
    size,
    breathe,
  });
}

/** 群头像：有上传图用图，没有就用纸印。 */
function groupAvatar(group, size) {
  if (group?.hasAvatar && group?.id) {
    const px = Math.round(size);
    const version = group.avatarRevision ? `?v=${encodeURIComponent(group.avatarRevision)}` : '';
    return `<span class="dbot dbot-img" style="width:${px}px;height:${px}px"><img src="/api/dimension/groups/${encodeURIComponent(group.id)}/avatar${version}" width="${px}" height="${px}" alt="" loading="lazy"></span>`;
  }
  return sealMarkup(group, size);
}

function pinMark() {
  return `<span class="pin-mark" aria-hidden="true"><svg width="10" height="10" viewBox="0 0 10 10" focusable="false"><circle cx="5" cy="3.1" r="2.15" fill="currentColor"/><path d="M5 5.2 V9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></span>`;
}

function knownBots() {
  return state.bots.length
    ? state.bots
    : [{ id: state.botId || 'new-character', name: state.botName, active: true }];
}

function bindBotActivators(root) {
  root.querySelectorAll('[data-work-team-toggle]').forEach(button => button.addEventListener('click', () => sidebarActivity.toggle(button.dataset.workTeamToggle)));
  root.querySelectorAll('[data-work-team-open]').forEach(button => button.addEventListener('click', () => {
    openGroup(button.dataset.workTeamOpen).catch(error => setModelStatus(error.message));
  }));
  root.querySelectorAll('[data-id]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      const id = btn.dataset.id;
      if (!id) return;
      // 行尾“⋯”：左键也能打开原本只能右键的操作菜单
      const more = event.target.closest?.('[data-row-more]');
      if (more && btn.contains(more)) {
        event.preventDefault();
        event.stopPropagation();
        const rect = more.getBoundingClientRect();
        openBotContextMenu(id, { x: rect.left, y: rect.bottom + 4 });
        return;
      }
      activateBot(id).catch((error) => { if (error?.name !== 'AbortError') showPaperHint(`打开会话失败：${error?.message || '请稍后重试'}`, { level: 'error' }); });
    });
    btn.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const id = btn.dataset.id;
      if (!id) return;
      openBotContextMenu(id, { x: event.clientX, y: event.clientY });
    });
    btn.addEventListener('keydown', (event) => {
      const menuKey = event.key === 'ContextMenu' || event.code === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
      if (!menuKey) return;
      event.preventDefault();
      event.stopPropagation();
      const id = btn.dataset.id;
      if (!id) return;
      const rect = btn.getBoundingClientRect();
      openBotContextMenu(id, { x: rect.left + Math.min(24, rect.width / 2), y: rect.bottom });
    });
  });
}

function isInternalBotId(value) {
  return /^new-character$/i.test(String(value || '').trim());
}

function identityDisplayName() {
  if (!hasConversation()) return '';
  const group = typeof activeGroup === 'function' ? activeGroup() : null;
  if (group) return group.name;
  const current = knownBots().find((bot) => bot.id === state.botId) || { id: state.botId, name: state.botName };
  const names = [typeof displayBotName === 'function' ? displayBotName(current) : '', state.botName, current.name];
  for (const raw of names) {
    const name = String(raw || '').trim();
    if (!name) continue;
    if (isForbiddenDisplayName(name) || /^维度 Agent$/i.test(name) || isInternalBotId(name)) continue;
    return name;
  }
  return '';
}

function renderTopSeal() {
  const slot = $('avatarSlot');
  const group = activeGroup();
  if ($('identityBtn')) $('identityBtn').hidden = Boolean(state.activeGroupId) || !hasConversation();
  const current = knownBots().find((bot) => bot.id === state.botId) || { id: state.botId, name: state.botName };
  const shown = identityDisplayName();
  if (slot) {
    slot.innerHTML = state.activeGroupId ? (group ? groupAvatar(group, 34) : '') : botAvatar({ ...current, name: shown }, 34);
    slot.removeAttribute('title');
  }
  const label = $('identityName');
  if (label) {
    label.textContent = shown;
    label.hidden = !shown;
  }
  const isGroupDiscuss = !isWorkShell() && Boolean(state.activeGroupId && group);
  const groupMemberList = isGroupDiscuss
    ? (group.members || []).map((mid) => ({
        id: mid,
        name: botNameOf(mid),
        avatarUrl: `/api/dimension/bots/${encodeURIComponent(mid)}/avatar`,
      }))
    : [];
  syncGalgameContext({
    botId: state.botId,
    botName: shown || current.name || state.botName,
    avatarUrl: state.botId ? `/api/dimension/bots/${encodeURIComponent(state.botId)}/avatar` : '',
    isSoloChat: !isWorkShell() && !state.activeGroupId && !state.soloWork && hasConversation() && Boolean(state.botId),
    isGroupChat: isGroupDiscuss,
    groupId: isGroupDiscuss ? group.id : '',
    groupName: isGroupDiscuss ? (group.name || group.id) : '',
    members: groupMemberList,
    storyConfig: isGroupDiscuss ? (group.storyConfig || null) : null,
  });
}

function renderDrawerSeal() {
  const slot = $('drawerAvatarSlot');
  if (!slot) return;
  const current = knownBots().find((bot) => bot.id === state.botId) || { id: state.botId, name: state.botName };
  slot.innerHTML = botAvatar({ ...current, name: state.botName || current.name }, 80);
  slot.removeAttribute('title');
}

function isDeletedBot(bot) {
  // Conversation removal retains the local identity. Roster membership controls visibility.
  return bot?.deleted === true || bot?.isDeleted === true || String(bot?.status || '').toLowerCase() === 'deleted';
}

function dedupeBots(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).filter((bot) => {
    if (!bot?.id || seen.has(bot.id)) return false;
    seen.add(bot.id);
    return true;
  });
}

/** 各模式的调出名单：持久化在侧栏偏好里；chat 与 work 互不同步。 */
function workRosterIds() {
  if (state.persistentBotRosters) return new Set(state.bots.filter(bot => bot.work === true).map(bot => bot.id));
  return new Set(readSidebarPrefs().workBots);
}

function chatRosterIds() {
  if (state.persistentBotRosters) return new Set(state.bots.filter(bot => bot.chat === true).map(bot => bot.id));
  return new Set(readSidebarPrefs().chatBots || []);
}

/** 当前模式的调出名单。小草橘和当前激活的 bot 常驻，防止切走后消失。 */
function rosterIds() {
  const ids = isWorkShell() ? workRosterIds() : chatRosterIds();
  if (state.persistentBotRosters) return ids;
  ids.add('new-character');
  const selected = state.selections?.[state.shellMode];
  if (selected?.kind === 'bot') ids.add(selected.id);
  return ids;
}

function syncNativeBotRosters() {
  if (!state.persistentBotRosters) return;
  const rosters = { chat: chatRosterIds(), work: workRosterIds() };
  const prefs = readSidebarPrefs();
  const ordered = (old, allowed) => [...(old || []).filter(id => allowed.has(id)), ...[...allowed].filter(id => !(old || []).includes(id))];
  const chatBots = ordered(prefs.chatBots, rosters.chat), workBots = ordered(prefs.workBots, rosters.work);
  if (JSON.stringify(chatBots) !== JSON.stringify(prefs.chatBots) || JSON.stringify(workBots) !== JSON.stringify(prefs.workBots)) {
    updateSidebarPrefs(next => { next.chatBots = chatBots; next.workBots = workBots; return next; });
  }
  let clearedCurrent = false;
  for (const mode of ['chat', 'work']) {
    if (state.selections[mode]?.kind === 'bot' && !rosters[mode].has(state.selections[mode].id)) {
      state.selections[mode] = null;
      if (mode === state.shellMode && !state.activeGroupId) clearedCurrent = true;
    }
    if (state.lastSelectedBots[mode] && !rosters[mode].has(state.lastSelectedBots[mode])) state.lastSelectedBots[mode] = null;
  }
  const saved = state.savedPreGroupSelection;
  if (saved?.value?.kind === 'bot' && !rosters[saved.mode || state.shellMode].has(saved.value.id)) state.savedPreGroupSelection = null;
  if (clearedCurrent && state.bootstrapped) {
    closeModal(); closeSoloWork(); disconnectChat(); showConversationWelcome();
  }
}

function replaceKnownBots(list) {
  if (!Array.isArray(list)) return;
  state.bots = dedupeBots(list);
  syncNativeBotRosters();
}

async function persistBotRoster(id, mode, present) {
  const known = state.bots.find(bot => bot.id === id);
  if (!known) throw new Error('这个 Bot 已不在角色库，请刷新后重试。');
  if (known[mode] === present) { syncNativeBotRosters(); return; }
  const result = await api(`/api/dimension/bots/${encodeURIComponent(id)}/roster`, {
    method: 'PATCH', body: JSON.stringify({ mode, present }),
  });
  const saved = result.bots?.find(bot => bot.id === id) || result.bot;
  if (!saved || saved[mode] !== present) throw new Error('名单更新结果不完整，请刷新后确认。');
  if (Array.isArray(result.bots)) replaceKnownBots(result.bots);
  else mergeKnownBots([saved]);
}

async function addToRoster(id, mode, { reveal = false } = {}) {
  const requestedMode = (mode || state.shellMode) === 'work' ? 'work' : 'chat';
  if (state.persistentBotRosters) await persistBotRoster(id, requestedMode, true);
  const key = requestedMode === 'work' ? 'workBots' : 'chatBots';
  updateSidebarPrefs((prefs) => {
    if (!state.persistentBotRosters) {
      const set = new Set(prefs[key] || []); set.add(String(id)); prefs[key] = [...set];
    }
    if (reveal) delete prefs.hidden[id];
    return prefs;
  });
}

function addToWorkRoster(id) {
  return addToRoster(id, 'work');
}

async function removeFromRoster(id, mode) {
  const requestedMode = (mode || state.shellMode) === 'work' ? 'work' : 'chat';
  if (state.persistentBotRosters) { await persistBotRoster(id, requestedMode, false); return; }
  const key = requestedMode === 'work' ? 'workBots' : 'chatBots';
  updateSidebarPrefs((prefs) => {
    prefs[key] = (prefs[key] || []).filter((x) => x !== id);
    return prefs;
  });
}

function modeBotList() {
  // chat 和 work 各自只显示自己调出的 bot；同一 bot 在两边各最多出现一次。
  const roster = rosterIds();
  return dedupeBots(knownBots().filter((bot) => roster.has(bot.id)));
}

function sidebarQuery() {
  return String($('sidebarSearchInput')?.value || '').trim().toLowerCase();
}

function normalizeSearchText(text) {
  return String(text || '').toLowerCase().replace(/[\s\-_·・.,，。/\\()（）\[\]【】]+/g, '');
}

function fuzzyMatchScore(text, query) {
  const rawQ = String(query || '').trim().toLowerCase();
  if (!rawQ) return 1;
  const hay = normalizeSearchText(text);
  if (!hay) return 0;
  const tokens = rawQ.split(/\s+/).map(normalizeSearchText).filter(Boolean);
  if (!tokens.length) return 1;
  let total = 0;
  for (const tok of tokens) {
    const idx = hay.indexOf(tok);
    if (idx >= 0) {
      total += (idx === 0 ? 120 : 90);
      continue;
    }
    let ti = 0, first = -1, last = 0, consec = 0, maxConsec = 0;
    for (let hi = 0; hi < hay.length && ti < tok.length; hi++) {
      if (hay[hi] === tok[ti]) {
        if (first < 0) first = hi;
        if (ti > 0 && hi === last + 1) { consec++; if (consec > maxConsec) maxConsec = consec; }
        else consec = 1;
        last = hi;
        ti++;
      }
    }
    if (ti < tok.length) return 0;
    const span = last - first + 1;
    total += 40 + maxConsec * 6 - Math.min(25, Math.max(0, span - tok.length));
  }
  return total;
}

function botSearchText(bot) {
  const id = String(bot?.id || '');
  const base = `${displayBotName(bot) || ''} ${bot?.name || ''} ${id} ${bot?.preview || ''}`;
  const tarot = window.DimensionTarot?.getMeta?.(id, bot?.name || '');
  if (!tarot) return base;
  return `${base} ${tarot.name} ${tarot.roman} ${tarot.arcana} ${(tarot.aliases || []).join(' ')}`;
}

function textMatchesQuery(text, query) {
  return fuzzyMatchScore(text, query) > 0;
}

function botMatchesQuery(bot, query) {
  return fuzzyMatchScore(botSearchText(bot), query) > 0;
}

function rankMatchingBots(bots, query) {
  if (!query) return bots;
  return bots.map(bot => ({ bot, score: fuzzyMatchScore(botSearchText(bot), query) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(item => item.bot);
}

function visibleModeBots() {
  const query = sidebarQuery();
  const bots = modeBotList().filter(bot => !isDeletedBot(bot) && (query || !isBotHidden(bot.id)));
  return rankMatchingBots(bots, query);
}

function knownGroups() {
  return Array.isArray(state.groups) ? state.groups : [];
}

function setKnownGroups(groups, mode = state.shellMode) {
  if (!Array.isArray(groups)) return;
  state.groups = groups.filter(group => group?.id);
  updateSidebarPrefs(prefs => reconcileGroupRosters(prefs, state.groups, mode));
}

function groupRosterIds(mode = state.shellMode) {
  return new Set(readSidebarPrefs()[mode === 'work' ? 'workGroups' : 'chatGroups'] || []);
}

function addGroupToRoster(id, mode = state.shellMode) {
  updateSidebarPrefs(prefs => {
    const key = mode === 'work' ? 'workGroups' : 'chatGroups';
    prefs[key] = [...new Set([...(prefs[key] || []), id])];
  });
}

function removeGroupFromRoster(id, mode = state.shellMode) {
  updateSidebarPrefs(prefs => {
    const key = mode === 'work' ? 'workGroups' : 'chatGroups';
    prefs[key] = (prefs[key] || []).filter(value => value !== id);
  });
  // Removing an entry does not delete the shared group or stop its work.
  if (mode === state.shellMode && state.activeGroupId === id) leaveGroup();
  if (state.selections[mode]?.kind === 'group' && state.selections[mode].id === id) state.selections[mode] = null;
  renderGroupSection();
}

function modeGroupList() {
  const roster = groupRosterIds();
  return knownGroups().filter(group => roster.has(group.id));
}
async function updateGroupRoster(id, mode, present) {
  const group = knownGroups().find(item => item.id === id);
  if (group?.rosterManaged === true) {
    const result = await api(`/api/dimension/groups/${encodeURIComponent(id)}/roster`, {
      method: 'POST', body: JSON.stringify({ mode, present }),
    });
    setKnownGroups(result.groups, mode);
  }
  if (present) addGroupToRoster(id, mode);
  else removeGroupFromRoster(id, mode);
}

function openGroupPool() {
  const mode = state.shellMode;
  const roster = groupRosterIds(mode), groups = knownGroups().filter(group => !roster.has(group.id));
  showModal(`<div class="modal-head"><h2>调入群 · ${shellModeLabel(mode)}</h2><button type="button" class="icon-btn" data-close>关闭</button></div>
    <div class="modal-body"><p class="muted">选择要加入当前模式侧栏的群。</p><div class="bot-pool-list" id="groupPoolList">
      ${groups.map(group => `<button type="button" class="group-item" data-group-id="${escapeHtml(group.id)}"><span class="seal-slot">${groupAvatar(group, 36)}</span><span class="group-item-name">${escapeHtml(group.name)}</span></button>`).join('') || '<p class="muted">已有群都在当前模式中，可以从新建菜单创建群。</p>'}
    </div></div>`);
  $('groupPoolList').onclick = async event => {
    const button = event.target.closest('[data-group-id]'); if (!button) return;
    button.disabled = true;
    try {
      await updateGroupRoster(button.dataset.groupId, mode, true);
      closeModal(); renderGroupSection();
      if (state.shellMode === mode) await openGroup(button.dataset.groupId);
    } catch (error) { button.disabled = false; setModelStatus(error.message); }
  };
}

/** Identity, placeholder and drawer always describe the visible conversation. */
function syncConversationChrome() {
  const group = activeGroup();
  for (const [key, draft] of attachmentDrafts) {
    if (!draft.images.length && !draft.stickers.length && !draft.uploading) attachmentDrafts.delete(key);
  }
  syncChatImageDraftFn();
  syncStickerDraft();
  renderTopSeal(); syncGroupBar(group); syncThinkSlot();
  if ($('composerInput')) {
    const input = $('composerInput');
    input.disabled = !hasConversation();
    if (!hasConversation()) {
      input.placeholder = '先在左侧点亮一枚伙伴印章，或推开茶会门扉…';
    } else if (isWorkShell()) {
      input.placeholder = state.activeGroupId
        ? `向「${group?.name || '圆桌结社'}」首席主理下达委托，众幕僚随时待命…`
        : `向「${state.botName}」递交今日的灵感委托或新脑洞…`;
    } else {
      input.placeholder = state.activeGroupId
        ? `往「${group?.name || '茶会圆桌'}」投下一枚有趣的话题…`
        : `轻叩「${state.botName}」的门扉，聊点日常或悄悄话…`;
    }
    void conversationDrafts.activate(currentDraftContext(), {
      readCurrent: () => input.value,
      apply: text => {
        input.value = text;
        if ($('galTurnTextarea')) $('galTurnTextarea').value = text;
        autoGrow(input);
        syncSendEnabled(input, $('sendBtn'));
      },
    });
  }
  syncSendEnabled($('composerInput'), $('sendBtn'));
  contextUsageUi?.refresh();
  syncChatThinkingToggle();
  workUi?.sync();
  workDock?.syncNativeOverlay?.();
  renderStoryStageBar();
  renderGroupDrawer({ loadJobs: isDrawerVisiblyOpen() }).catch(() => {});
}

let chatSearchTimer = null;
let chatSearchVersion = 0;
const closeChatSearch = () => {
  clearTimeout(chatSearchTimer);
  chatSearchVersion++;
  if ($('chatSearchBar')) $('chatSearchBar').hidden = true;
  if ($('chatSearchResults')) { $('chatSearchResults').hidden = true; $('chatSearchResults').innerHTML = ''; }
  if ($('chatSearchCount')) $('chatSearchCount').textContent = '';
};
let lastChatSearchScope;

function syncChatThinkingToggle() {
  const btn = $('chatThinkingToggle');
  const imgBtn = $('chatImageBtn');
  const searchBtn = $('chatSearchBtn');
  const visible = !isWorkShell() && hasConversation();
  if (imgBtn) imgBtn.hidden = !visible;
  if (searchBtn) searchBtn.hidden = !visible;
  const scope = visible ? JSON.stringify([state.activeGroupId || '', state.activeGroupId ? '' : state.botId]) : '';
  if (scope !== lastChatSearchScope) {
    closeChatSearch();
    if ($('chatSearchInput')) $('chatSearchInput').value = '';
    lastChatSearchScope = scope;
  }
  if (!btn) return;
  btn.hidden = !visible;
  const active = Boolean(state.chatThinkingEnabled);
  btn.classList.toggle('is-active', active);
  btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  const labelEl = btn.querySelector('span:last-child');
  if (labelEl) labelEl.textContent = active ? '深度思考 · 开' : '深度思考';
  btn.title = active
    ? '已开启模型自带深度推理（点击关闭，恢复快速回复）'
    : '已关闭模型深度推理（点击开启模型自带推理）';
  if (!btn._boundChatThinking) {
    btn._boundChatThinking = true;
    btn.addEventListener('click', async () => {
      const next = !Boolean(state.chatThinkingEnabled);
      state.chatThinkingEnabled = next;
      syncChatThinkingToggle();
      try {
        const res = await api('/api/dimension/chat/thinking', {
          method: 'PUT',
          body: JSON.stringify({ enabled: next }),
        });
        state.chatThinkingEnabled = Boolean(res?.enabled);
        syncChatThinkingToggle();
        toast(state.chatThinkingEnabled ? '已开启 Chat 深度思考（调用模型自带推理）' : '已关闭 Chat 深度思考（恢复快速回复）');
      } catch (err) {
        state.chatThinkingEnabled = !next;
        syncChatThinkingToggle();
        toast(err?.message || '切换深度思考状态失败');
      }
    });
  }
}

function renderGroupSection() {
  if (isWorkShell()) {
    workRosterTree?.render();
    return;
  }
  const list = $('groupList');
  const empty = $('groupEmpty');
  if (!list) return;
  const query = sidebarQuery();
  const all = modeGroupList().sort((a, b) => sidebarActivity.at(state.shellMode, 'group', b.id) - sidebarActivity.at(state.shellMode, 'group', a.id) || a.id.localeCompare(b.id));
  const groups = all.filter((group) => textMatchesQuery(group?.name, query));
  list.querySelectorAll('.group-item').forEach((el) => el.remove());
  if (!all.length) {
    if (empty) {
      empty.hidden = false;
      empty.textContent = '席位尚空 · 可从右上「＋」缔结新茶会或召回结社 ✦';
    }
    return;
  }
  if (empty) empty.hidden = true;
  for (const group of groups) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'group-item' + (group.id === state.activeGroupId ? ' active' : '');
    btn.dataset.groupId = group.id;
    btn.setAttribute('aria-current', group.id === state.activeGroupId ? 'page' : 'false');
    btn.innerHTML = `<span class="seal-slot">${groupAvatar(group, 36)}</span><span class="group-item-name">${escapeHtml(group.name || '')}</span>`;
    btn.addEventListener('click', () => { openGroup(group.id).catch((err) => { if (err.name !== 'AbortError') setModelStatus(err.message); }); });
    btn.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openGroupSettings(group.id);
    });
    list.appendChild(btn);
  }
}

function sealColorHex(bot) {
  const seal = botSeal(bot);
  const found = SEAL_COLORS.find((c) => c.id === seal.color);
  return found?.hex || '#2a2723';
}

function botAvatar(bot, size, state) {
  // 有真实头像文件（角色库引入）就用图，圆形裁切；思考态加脉冲圈。
  if (bot?.hasAvatar && bot?.id) {
    const px = Math.round(size);
    const pulse = state === 'thinking' ? ' is-thinking' : '';
    const version = bot.avatarRevision ? `?v=${encodeURIComponent(bot.avatarRevision)}` : '';
    return `<span class="dbot dbot-img${pulse}" style="width:${px}px;height:${px}px"><img src="/api/dimension/bots/${encodeURIComponent(bot.id)}/avatar${version}" width="${px}" height="${px}" alt="" loading="lazy"></span>`;
  }
  return dimensionBotAvatar(displayBotName(bot) || bot.name, sealColorHex(bot), size, state || 'idle');
}

/** 思考中的小球：任何回合在跑时，当前 bot（群里是群主）的头像在输入框侧做动态展示。 */
function syncThinkSlot() {
  const slot = $('thinkSlot');
  if (!slot) return;
  if (!state.pending) { slot.hidden = true; slot.innerHTML = ''; return; }
  const group = typeof activeGroup === 'function' ? activeGroup() : null;
  const botId = group?.ownerId || state.botId;
  const bot = knownBots().find((b) => b.id === botId) || { id: botId, name: botId };
  slot.innerHTML = botAvatar(bot, 22, 'thinking');
  slot.hidden = false;
}

function renderBotRow(bot, kind) {
  const active = hasConversation() && !state.activeGroupId && bot.id === state.botId;
  const name = displayBotName(bot);
  if (kind === 'pinned') {
    return `<button type="button" class="pinned-item${active ? ' active' : ''}" data-id="${escapeHtml(bot.id)}" aria-current="${active ? 'page' : 'false'}">
      ${pinMark()}
      <span class="seal-slot">${botAvatar({ ...bot, name }, 48)}</span>
      <span class="pinned-name">${escapeHtml(name)}</span>
      ${workBadgeMarkup(bot.id)}
    </button>`;
  }
  const preview = String(bot.preview || '').trim();
  return `<button type="button" class="bot-item${kind === 'team' ? ' is-team-member' : ''}${active ? ' active' : ''}" data-id="${escapeHtml(bot.id)}" aria-current="${active ? 'page' : 'false'}">
      <span class="seal-slot">${botAvatar({ ...bot, name }, 40)}</span>
      <span class="bot-item-text">
        <span class="bot-item-heading"><span class="bot-item-name">${escapeHtml(name)}</span>${workBadgeMarkup(bot.id)}</span>
        <span class="bot-item-preview">${preview ? escapeHtml(preview) : ''}</span>
      </span>
      <span class="row-more-btn" data-row-more role="button" tabindex="-1" aria-label="更多操作（置顶、重命名、分组…）" title="更多操作">⋯</span>
    </button>`;
}

function renderBotList() {
  const list = $('botList');
  const workHost = $('workRosterHost');
  const groupSec = $('groupSection');
  const pinnedBox = $('pinnedBots');
  const searchField = $('sidebarSearchInput');
  if (searchField) {
    const ph = isWorkShell() ? '筛选伙伴、工坊项目或委托卷宗…' : '筛选伙伴或茶会…';
    searchField.placeholder = ph;
    searchField.setAttribute('aria-label', ph);
  }
  if (workHost) workHost.hidden = !isWorkShell();
  if (isWorkShell()) {
    if (groupSec) groupSec.hidden = true;
    if (pinnedBox) pinnedBox.hidden = true;
    if (list) list.hidden = true;
    workRosterTree?.render();
    return;
  }
  if (groupSec) groupSec.hidden = false;
  if (list) list.hidden = false;
  if (!list) return;
  const allBots = visibleModeBots();
  const query = sidebarQuery();
  const teams = [];
  const grouped = new Set();
  const bots = allBots.filter(bot => !grouped.has(bot.id));
  const pinned = bots.filter((bot) => botSeal(bot).pinned === true);
  if (pinnedBox) {
    if (!pinned.length) {
      pinnedBox.hidden = true;
      pinnedBox.innerHTML = '';
    } else {
      pinnedBox.hidden = false;
      pinnedBox.innerHTML = pinned.map((bot) => renderBotRow(bot, 'pinned')).join('');
      bindBotActivators(pinnedBox);
    }
  }
  if (!allBots.length && query) {
    list.innerHTML = '<p class="bot-list-empty">没有匹配的 bot</p>';
    renderGroupSection();
    return;
  }
  const folders = sidebarFolders();
  const used = new Set();
  const sequence = [];
  for (const team of teams) {
    sequence.push({ type: 'work-team', team });
    if (query || !sidebarActivity.collapsed(team.id)) for (const bot of team.bots) sequence.push({ type: 'bot', bot, inTeam: true });
  }
  const legacyRecent = readSidebarPrefs().recentBots || [];
  const recentIds = bots.filter(bot => sidebarActivity.at(state.shellMode, 'bot', bot.id) || legacyRecent.includes(bot.id))
    .sort((a, b) => sidebarActivity.at(state.shellMode, 'bot', b.id) - sidebarActivity.at(state.shellMode, 'bot', a.id)
      || legacyRecent.indexOf(a.id) - legacyRecent.indexOf(b.id)).map(bot => bot.id);
  const recentBots = orderBotsForList(bots, {
    pinnedIds: pinned.map((b) => b.id),
    recentIds,
  }).filter((bot) => recentIds.includes(bot.id));
  for (const bot of recentBots) {
    sequence.push({ type: 'bot', bot });
    used.add(bot.id);
  }
  for (const folder of folders) {
    const members = bots.filter((bot) => folderIdOf(bot.id) === folder.id && !used.has(bot.id));
    if (!members.length) continue;
    sequence.push({ type: 'folder', folder });
    for (const bot of members) {
      sequence.push({ type: 'bot', bot });
      used.add(bot.id);
    }
  }
  for (const bot of bots) {
    if (used.has(bot.id)) continue;
    sequence.push({ type: 'bot', bot });
  }
  if (!state.botListVirtual) {
    state.botListVirtual = createVirtualList(list, {
      rowHeight: 58,
      renderRow: (row) => {
        if (row.type === 'work-team') {
          const team = row.team, expanded = Boolean(sidebarQuery()) || !sidebarActivity.collapsed(team.id);
          return `<div class="work-team-folder"><button type="button" class="work-team-toggle" data-work-team-toggle="${escapeHtml(team.id)}" aria-expanded="${expanded}" title="${escapeHtml(team.title)}"><span aria-hidden="true">${expanded ? '▾' : '▸'}</span><span class="work-team-folder-text"><strong>${escapeHtml(team.name)}</strong><small>${team.bots.length} 位 Bot 工作中</small></span></button><button type="button" class="work-team-open" data-work-team-open="${escapeHtml(team.groupId)}" title="打开项目">打开</button></div>`;
        }
        if (row.type === 'folder') return `<div class="bot-folder-label">${escapeHtml(row.folder.name)}</div>`;
        return renderBotRow(row.bot, row.inTeam ? 'team' : 'list');
      },
      bind: bindBotActivators,
    });
  }
  state.botListVirtual.setRows(sequence);
  renderGroupSection();
}

function applyBotChrome() {
  applyCurrentNameIfLocal();
  // Window / document title may use the product name; the top avatar must stay clean.
  document.title = state.productName || '维度 Agent';
  const title = $('drawerTitle');
  if (title) title.textContent = state.botName;
  syncConversationChrome();
  renderDrawerSeal();
  syncIdentityLabels();
  renderBotList();
  updateEmptyHint();
}

async function loadProviders() {
  try {
    const data = await api('/api/providers');
    const list = Array.isArray(data) ? data : (data.providers || data.items || []);
    state.providers = list.map((item) => ({
      name: item.name || item.id,
      displayName: item.displayName || item.title || item.name,
      module: item.module || item.kind || '',
      moduleTitle: item.moduleTitle || item.displayName || item.title || item.name,
      model: item.model || item.spec?.model || item.modelName || '',
      baseUrl: item.baseUrl || '',
      ready: item.ready === true || item.readiness?.state === 'ready',
      secretConfigured: item.secretConfigured === true || (typeof item.secretConfigured === 'string' && item.secretConfigured !== 'none'),
      revision: item.revision || '',
    }));
  } catch {
    state.providers = [];
  }
}

async function loadBootstrap() {
  const initial = !state.bootstrapped;
  const [data, g] = await Promise.all([api('/api/dimension/bootstrap'), api('/api/dimension/groups').catch(() => ({}))]);
  state.chatThinkingEnabled = Boolean(data.chatThinkingEnabled);
  syncChatThinkingToggle();
  state.persistentGroupRosters = data.features?.persistentGroupRosters === true;
  state.persistentBotRosters = data.features?.persistentBotRosters === true;
  archiveUi?.setAvailable(data.features?.conversationArchives === true);
  botArchiveUi?.setAvailable(data.features?.botArchives === true);
  archiveUi?.setBotAvailable(data.features?.botArchives === true);
  workSession.setHandoffAvailable(data.features?.taskHandoff === true);
  setKnownGroups(g.groups);
  state._groupMemberBots = g.bots;
  renderGroupSection();
  state.runtimeBotId = data.bot?.id || state.runtimeBotId || state.botId;
  const selected = state.selections[state.shellMode];
  state.botId = selected?.kind === 'bot' ? selected.id : state.runtimeBotId;
  state.botName = (Array.isArray(data.bots) ? data.bots.find(bot => bot.id === state.botId)?.name : '') || (data.bot?.id === state.botId ? data.bot.name : state.botName) || '小草橘';
  state.productName = data.productName || '维度 Agent';
  replaceKnownBots(Array.isArray(data.bots) ? data.bots : []);
  // An active bot must belong to this mode, not vanish when another bot is selected.
  if (!state.persistentBotRosters && state.selections?.[state.shellMode]?.kind === 'bot') await addToRoster(state.selections[state.shellMode].id);
  if (data.workSettings) state.workSettings = data.workSettings;
  if (data.approvalMode === 'full' || data.approvalMode === 'auto' || data.approvalMode === 'ask') {
    state.approvalMode = data.approvalMode;
    try { localStorage.setItem(REVIEW_STORAGE_KEY, data.approvalMode); } catch {}
  }
  mergeKnownBots(state._groupMemberBots);
  state._groupMemberBots = null;
  state.activeProvider = data.model?.activeProvider || '';
  state.model = data.model?.model || '';
  state.ready = data.model?.ready;
  state.modelSelection = data.model?.modelSelection || null;
  state.conversationModel = data.model?.conversationModel || null;
  const effective = data.model?.effective || currentSelection();
  applyBotChrome();
  await loadProviders();
  // Remote model discovery must never hold up switching a conversation or connecting Chat.
  if (initial) void refreshCatalogs().then(renderModels);
  renderModels();
  if (!isCliSelection(effective) && effective?.providerId && effective.model
      && (effective.providerId !== state.activeProvider || effective.model !== (data.model?.model || ''))) {
    try { await applyRuntimeSelection(effective); }
    catch (err) { setModelStatus(err.message); }
    await loadProviders();
    renderModels();
  }
  state.bootstrapped = true;
  playgroundUi?.refreshBots();
}

function disconnectChat() {
  const ws = state.socket;
  state.socket = null;
  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
  }
}

function cachedChatNodes() {
  if(state.savedChatNodes)return state.savedChatNodes;
  if(state.activeGroupId)return state.savedPreGroupNodes ??= [];
  return state.savedChatNodes ??= [];
}

let connectionBarTimer = 0;
function setChatConnectionState(ok) {
  clearTimeout(connectionBarTimer);
  let bar = document.getElementById('chatConnectionBar');
  if (ok) {
    if (bar && !bar.hidden) {
      bar.hidden = true;
      showPaperHint('✦ 星轨已重新接通', { level: 'success' });
    }
    return;
  }
  // 稍等片刻再显示，避免切换伙伴时的瞬时重连造成闪烁
  connectionBarTimer = setTimeout(() => {
    if (state.socket && state.socket.readyState === WebSocket.OPEN) return;
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'chatConnectionBar';
      bar.className = 'chat-connection-bar';
      bar.setAttribute('role', 'status');
      $('chatStage')?.prepend(bar);
    }
    bar.innerHTML = '<span class="chat-connection-dot" aria-hidden="true"></span><span>星轨连接中断，正在自动重连…</span>';
    bar.hidden = false;
  }, 1200);
}

function connectChat() {
  const connectedBot = state.botId;
  let pendingDelayedBubbles = 0;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws/providers/${encodeURIComponent('world:console')}/panels/chat`;
  const ws = new WebSocket(url);
  state.socket = ws;
  ws.addEventListener('open', () => {
    state.wsRetry = 0;
    setChatConnectionState(true);
    ws.send(JSON.stringify({ type: 'hello', protocolVersion: 2, historyLimit: 30, name: state.helloName, botId: state.botId }));
  });
  // 断线（重启/掉网）自动重连：指数退避，重连成功会重新握手并重放历史。
  ws.addEventListener('close', () => {
    if (state.socket !== ws) return;
    setPending(false);
    state.socket = null;
    setChatConnectionState(false);
    const delay = Math.min(15000, 1000 * 2 ** (state.wsRetry ?? 0));
    state.wsRetry = (state.wsRetry ?? 0) + 1;
    setTimeout(() => { if (!state.socket) connectChat(); }, delay);
  });
  ws.addEventListener('message', (event) => {
    if (state.socket !== ws || state.botId!==connectedBot) return;
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }
    if (frame.type === 'chat.stream') {
      if (!isWorkShell() && !state.activeGroupId && state.botId === connectedBot) {
        upsertPrivateStreamBubble(frame.phase, frame.delta || '', frame.query || '');
      }
      return;
    }
    if (frame.type === 'lore.learned') {
      const title = String(frame.title || '').trim();
      if (title) {
        const scopeTip = frame.scope === 'global' ? '全员共享' : '已记入词典';
        const notice = `✦ 已学会新梗「${title}」（${scopeTip}）`;
        toast(notice);
        notifyGalgameNotice(notice);
      }
      return;
    }
    if (frame.type === 'message.deleted') {
      removeMessageLocally(JSON.stringify(['chat', '', connectedBot]), frame.messageId); return;
    }
    const cacheMessage=()=>{
      if (messageWasDeleted(JSON.stringify(['chat', '', connectedBot]), frame.messageId)) return;
      const nodes=cachedChatNodes();
      if(nodes.some(node=>(frame.messageId && node.dataset?.messageId===frame.messageId) || (frame.requestId && node.dataset?.requestId===frame.requestId)))return;
      const el=document.createElement('div');el.className=`bubble ${frame.role==='user'?'user':'assistant'}`;renderStickers(el,frame.text);
      presentMessage(el, frame, JSON.stringify(['chat', '', connectedBot]));
      if(frame.messageId)el.dataset.messageId=frame.messageId;if(frame.requestId)el.dataset.requestId=frame.requestId;nodes.push(el);
      if(frame.role!=='user' && !frame.history)for(let i=nodes.length-1;i>=0;i--)if(nodes[i].classList?.contains('pending'))nodes.splice(i,1);
    };
    if (frame.type === 'input.rejected' || frame.type === 'request.error') {
      setPending(false);
      const submission = state.chatSubmission;
      if (submission?.botId === connectedBot && quoteScope() === submission.scope && !$('composerInput').value) {
        $('composerInput').value = submission.text; autoGrow($('composerInput'));
        conversationDrafts.capture(submission.text);
        if (submission.quote) setGroupQuote(submission.quote);
        for (const node of $('transcript').querySelectorAll('.bubble[data-request-id]'))
          if (node.dataset.requestId === submission.requestId && !node.dataset.messageId) node.remove();
      }
      if (state.activeGroupId || state.soloWork) cacheMessage();
      else if (hasConversation()) addBubble('assistant', frame.text || '消息未被接收，原文已恢复为草稿。', '系统');
      return;
    }
    // Chat only shows conversation. Do not cache hidden process frames for later replay.
    if (frame.type === 'proc' || frame.type === 'think') return;
    if (frame.type === 'sys' && frame.kind === 'refresh-groups') {
      // bot 建好团队/从角色库拉人了：刷新群列表和 bot 名单，立刻出现在侧边栏。
      api('/api/dimension/groups').then((g) => {
        setKnownGroups(g.groups, 'chat');
        mergeKnownBots(g.bots);
        renderGroupSection();
        renderBotList();
      }).catch(() => {});
      return;
    }
    if (frame.type === 'msg') {
      if (frame.role === 'user' && frame.requestId === state.chatSubmission?.requestId) state.chatSubmission = null;
      if (!frame.history && !isInternalText(frame.text)) sidebarActivity.message('chat', 'bot', connectedBot, frame.ts);
      if (!hasConversation()) return;
      if (state.activeGroupId || state.soloWork) {
        // 群视图/单 bot work 视图中单聊来消息：写入缓存的单聊现场节点，回去时可见。
        cacheMessage();
        return;
      }
      const role = frame.role || (frame.from === state.helloName ? 'user' : 'assistant');
      if (frame.history && role === 'user') {
        addBubble('user', frame.text, '你', frame);
        return;
      }
      if (frame.history && role !== 'user') {
        addBubble('assistant', frame.text, displayAssistantName(frame.from), frame);
        return;
      }
      if (!frame.history && role === 'user') { addBubble('user', frame.text, '你', frame); return; }
      if (!frame.history) {
        const delayMs = Number(frame.bubbleDelayMs) > 0 ? Math.min(420, Number(frame.bubbleDelayMs)) : 0;
        if (delayMs > 0) {
          pendingDelayedBubbles++;
          setPending(true);
          setTimeout(() => {
            pendingDelayedBubbles = Math.max(0, pendingDelayedBubbles - 1);
            if (pendingDelayedBubbles === 0) setPending(false);
            if (state.botId === connectedBot && !state.activeGroupId && !state.soloWork && !isWorkShell()) {
              addBubble('assistant', frame.text, displayAssistantName(frame.from), frame);
            } else {
              cacheMessage();
            }
            if (pendingDelayedBubbles > 0 && state.botId === connectedBot && !state.activeGroupId && !state.soloWork && !isWorkShell()) {
              setPending(true);
            }
          }, delayMs);
        } else {
          if (pendingDelayedBubbles === 0) setPending(false);
          addBubble('assistant', frame.text, displayAssistantName(frame.from), frame);
        }
      }
    }
  });
}

function extractSwitchSession(result) {
  if (!result || typeof result !== 'object') return null;
  const nested = result.session && typeof result.session === 'object' ? result.session : null;
  const pick = (...values) => {
    for (const value of values) {
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return null;
  };
  const toBotId = pick(result.toBotId, nested?.toBotId, result.bot?.id);
  const fromBotId = pick(result.fromBotId, nested?.fromBotId);
  const toFile = pick(result.toFile, nested?.toFile, result.sessionFile, nested?.sessionFile);
  const fromFile = pick(result.fromFile, nested?.fromFile);
  const kind = pick(result.kind, nested?.kind, result.toKind, nested?.toKind);
  const sessionId = pick(result.sessionId, nested?.sessionId, nested?.id);
  const messages = nested?.messages || nested?.transcript || result.messages || result.transcript;
  return {
    toBotId: toBotId ? String(toBotId) : null,
    fromBotId: fromBotId ? String(fromBotId) : null,
    toFile: toFile ? String(toFile) : null,
    fromFile: fromFile ? String(fromFile) : null,
    kind: kind ? String(kind) : null,
    sessionId: sessionId ? String(sessionId) : null,
    messages: Array.isArray(messages) ? messages : null,
    changed: result.changed === true,
  };
}

function isIsolatedSession(session) {
  if (!session) return false;
  if (session.kind === 'isolated') return true;
  const file = String(session.toFile || session.file || '');
  return /bot-sessions[\\/]/i.test(file);
}

function isProtectedLiveMainSession(session = state.sessionIdentity) {
  // 分不清归属，或仍是共用活主会话档时，禁止清空对白。
  if (!session) return true;
  if (session.shared === true || session.kind === 'legacy-bound' || session.kind === 'unbound-legacy') return true;
  const file = String(session.file || session.toFile || '');
  if (file && /session-main\.jsonl$/i.test(file) && !/bot-sessions[\\/]/i.test(file)) return true;
  if (!isIsolatedSession(session) && !file && !session.sessionId) return true;
  return false;
}

function rememberSessionIdentity(session) {
  const next = session || { toBotId: state.botId };
  state.sessionIdentity = {
    botId: next.toBotId || next.botId || state.botId,
    fromBotId: next.fromBotId || null,
    file: next.toFile || next.file || null,
    fromFile: next.fromFile || null,
    kind: next.kind || null,
    sessionId: next.sessionId || null,
    shared: !isIsolatedSession(next),
  };
}

function messageText(record) {
  if (record == null) return '';
  if (typeof record === 'string') return record;
  if (typeof record !== 'object') return '';
  const value = record.text ?? record.content ?? record.message ?? record.body;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((part) => (typeof part === 'string' ? part : (part?.text || part?.content || ''))).join('');
  }
  return '';
}

function messageRole(record) {
  const role = String(record?.role || record?.fromRole || '').toLowerCase();
  if (role === 'user' || role === 'human') return 'user';
  return 'assistant';
}

function showSessionTranscript(messages) {
  const transcript = $('transcript');
  if (!transcript) return;
  for (const bubble of [...transcript.querySelectorAll('.bubble')]) bubble.remove();
  for (const record of messages) {
    const text = messageText(record);
    const role = messageRole(record);
    if (!text || (role!=='user' && isInternalText(text))) continue;
    addBubble(role, text, role === 'user' ? '你' : displayAssistantName(record.from || record.who),record);
  }
  updateEmptyHint();
}

function clearTranscript(opts = {}) {
  // 只允许清空当前实例自己的隔离会话展示。分不清或会碰到共用活主会话时，先不动。
  const session = opts.session || state.sessionIdentity;
  if (opts.explicit !== true || isProtectedLiveMainSession(session) || !isIsolatedSession(session)) return false;
  const transcript = $('transcript');
  if (!transcript) return false;
  for (const bubble of [...transcript.querySelectorAll('.bubble')]) bubble.remove();
  updateEmptyHint();
  return true;
}

function routeChatSession(botId) {
  const id = String(botId || state.botId || '').trim();
  if (!id || id!==state.botId) return;
  disconnectChat();setPending(false);connectChat();
}

async function afterSwitch(result) {
  // 视图在 activateBot 里已经先行切好；这里只负责后端换角色工作区，不整页 reload。
  if (result?.restartRequired === true) {
    setModelStatus('正在唤醒…');
    try { await api('/api/run/restart', { method: 'POST' }); } catch { /* 重启会断开连接，属预期 */ }
    const wait = setInterval(async () => {
      try {
        const r = await fetch('/api/status');
        if (r.ok) {
          clearInterval(wait);
          // 视图已经对，WS 断线重连会自己接上；只刷新基础数据。
          await loadBootstrap();
          setModelStatus('');
        }
      } catch { /* 还没起来 */ }
    }, 800);
    return;
  }
  await loadBootstrap();
  const session = extractSwitchSession(result);
  rememberSessionIdentity(session || { toBotId: state.botId });
  routeChatSession(state.sessionIdentity?.botId || state.botId);
  setModelStatus('');
}

/** 视图先行：从目标 bot 的档案直接把它的历史铺到舞台，不等后端重启。 */
async function showBotHistory(id) {
  closeMessageMenu();
  if (!hasConversation() || state.activeGroupId || state.botId !== id) return;
  state.historyAbort?.abort(); state.historyAbort = new AbortController();
  const ticket = state.chatHistoryTicket = (state.chatHistoryTicket || 0) + 1;
  workSession.close();
  const transcript = $('transcript');
  if (!transcript) return;
  // 旧 bot 的现场服务端都有档（镜像/工位流），本地缓存直接丢。
  state.savedChatNodes = null;
  state.soloWork = false;
  transcript.innerHTML = '';
  try {
    if (isWorkShell()) { await openSoloWork(); return; }
    const data = await api(`/api/dimension/bots/${encodeURIComponent(id)}/history?limit=30`, { signal: state.historyAbort.signal });
    if (state.chatHistoryTicket !== ticket || state.botId !== id || state.activeGroupId || state.soloWork) return;
    const msgs = data.messages || [];
    changeTranscript(transcript, () => { for (const m of msgs) {
      addBubble(m.role || 'assistant', m.text, m.role === 'user' ? '你' : m.role === 'system' ? '系统' : botNameOf(id), m);
    } });
    if(data.hasMore && msgs[0]?.messageId)installEarlierHistory(id,msgs[0].messageId,ticket);
    if (!msgs.length) updateEmptyHint();
  } catch { /* 空历史 */ }
}

function installEarlierHistory(id,before,ticket) {
  const transcript=$('transcript'),button=document.createElement('button');button.type='button';button.className='chat-history-more';button.textContent='加载更多消息';transcript.prepend(button);
  button.onclick=async()=>{
    button.disabled=true;
    try{const data=await api(`/api/dimension/bots/${encodeURIComponent(id)}/history?limit=30&before=${encodeURIComponent(before)}`, { signal: state.historyAbort.signal });
      if(state.botId!==id || state.chatHistoryTicket!==ticket || state.activeGroupId || state.soloWork)return;
      const height=transcript.scrollHeight,top=transcript.scrollTop,anchor=button.nextSibling;
      changeTranscript(transcript,()=>{for(const m of data.messages || []){const node=addBubble(m.role,m.text,m.role==='user'?'你':botNameOf(id),m);if(node)transcript.insertBefore(node,anchor);}},{prepend:true});
      button.remove();if(data.hasMore && data.messages[0]?.messageId)installEarlierHistory(id,data.messages[0].messageId,ticket);
      transcript.scrollTop=top+transcript.scrollHeight-height;
    }catch(error){button.textContent='加载失败，点击重试';}finally{button.disabled=false;}
  };
}

function leaveGroup({ restoreConversation = true } = {}) {
  closeMessageMenu();
  state.groupUpdates?.close(); state.groupUpdates = null;
  state.groupLoadTicket = (state.groupLoadTicket || 0) + 1; state.groupAbort?.abort();
  if (!state.activeGroupId) return;
  workSession.close();
  state.activeGroupId = null;
  state.selections[state.shellMode] = state.savedPreGroupSelection?.mode === state.shellMode ? state.savedPreGroupSelection.value : null;
  setGroupSelecting(false);
  setGroupQuote(null);
  syncConversationChrome();
  syncGroupModeSwitch();
  const transcript = $('transcript');
  const sameBot = state.savedPreGroupBotId === state.botId;
  const saved = sameBot ? (state.savedPreGroupMode === state.shellMode ? state.savedPreGroupNodes : !isWorkShell() ? state.savedChatNodes : null) : null;
  const restore = Array.isArray(saved);
  // A mode change inside a group must not discard the hidden single-chat cache.
  if (!sameBot) state.savedChatNodes = null;
  else if (isWorkShell() && state.savedPreGroupMode === 'chat') state.savedChatNodes = state.savedPreGroupNodes;
  if (transcript) {
    transcript.innerHTML = '';
    // 恢复进群前的现场：可能是单聊，也可能是某个 bot 的 work 视图。
    if (restore) for (const node of saved) transcript.appendChild(node);
    if (!transcript.childNodes.length) transcript.innerHTML = '<p class="empty-hint" id="emptyHint"></p>';
  }
  state.savedPreGroupNodes = null;
  state.savedPreGroupMode = null; state.savedPreGroupBotId = null;
  if (!isWorkShell()) { state.soloWork = false; state.savedChatNodes = null; }
  if(!transcript?.querySelector('.bubble.pending'))setPending(false);
  updateEmptyHint();
  renderBotList();
  // activateBot owns the next history load. Restoring here would open the same
  // Work session twice and let the cancelled first load paint an error.
  if (!restoreConversation) { state.soloWork = false; return; }
  if (!hasConversation()) { showConversationWelcome(); return; }
  if (isWorkShell()) { state.soloWork = false; openSoloWork().catch(() => {}); }
  else if (!restore || !transcript?.querySelector('.bubble')) showBotHistory(state.botId).catch(() => {});
}

function addProcessLine(text) {
  const el = document.createElement('div');
  el.className = 'process-line';
  el.textContent = text;
  appendTranscript($('transcript'), el);
  return el;
}

let soloWorkOpenTicket = 0;

async function openSoloWork() {
  if (!hasConversation() || !state.bootstrapped || state.activeGroupId) return;
  const transcript = $('transcript');
  if (!transcript) return;
  const id = state.botId;
  const hasMountedStage = Boolean(
    transcript.querySelector('.claude-thread-stage, .work-new-thread-stage')
  );
  if (state.soloWork && state.soloWorkBotId === id && hasMountedStage && !state.pendingWorkFocus) {
    return;
  }
  const ticket = ++soloWorkOpenTicket;
  if (!state.savedChatNodes && !state.soloWork) {
    state.savedChatNodes = [...transcript.childNodes];
  }
  state.soloWork = true;
  state.soloWorkBotId = id;
  await addToWorkRoster(id);
  if (ticket !== soloWorkOpenTicket || state.botId !== id || state.activeGroupId || !isWorkShell() || !hasConversation()) {
    return;
  }
  try {
    const focus = state.pendingWorkFocus?.botId === id ? state.pendingWorkFocus : null;
    if (focus && state.pendingWorkFocus === focus) state.pendingWorkFocus = null;
    await workSession.open({
      botId: id,
      ...(focus?.runId ? { focusRunId: focus.runId } : {}),
      ...(focus?.newThread ? { newThread: true } : {}),
    });
    if (ticket !== soloWorkOpenTicket || state.botId !== id || !state.soloWork || state.activeGroupId) return;
    workRosterTree?.render();
  } catch (error) {
    if (ticket === soloWorkOpenTicket && state.botId === id && state.soloWork && !state.activeGroupId) {
      addBubble('assistant', `工作记录暂时无法加载：${error.message}`, '系统');
    }
  }
  updateEmptyHint();
}

function closeSoloWork() {
  workSession.close();
  if (!state.soloWork) return;
  setPending(false);
  state.soloWork = false;
  if (state.activeGroupId) return; // 在群里只摘标记，现场由退群恢复
  const transcript = $('transcript');
  if (transcript && state.savedChatNodes) {
    transcript.innerHTML = '';
    for (const node of state.savedChatNodes) transcript.appendChild(node);
    if (!state.savedChatNodes.length) transcript.innerHTML = '<p class="empty-hint" id="emptyHint"></p>';
  }
  state.savedChatNodes = null;
  updateEmptyHint();
}

function handleWorkEvent(ev) {
  if (ev.kind === 'run') {
    state.activeWorkRun = ev.runId;
    state.activeWorkBotId = ev.botId;
    if ($('workStopBtn')) $('workStopBtn').hidden = false;
    return true;
  }
  if (ev.kind === 'approval') {
    state.activeWorkBotId = ev.botId;
    refreshWorkPending();
    return true;
  }
  if (ev.kind === 'result') {
    const labels = { completed: '已通过验收', partial: '部分完成，尚未验收', failed: '执行失败', cancelled: '已停止', interrupted: '上次运行被中断' };
    const files = ev.deliverables?.length ? `\n交付文件：${ev.deliverables.join('、')}` : '';
    addProcessLine(`${botNameOf(ev.from)}：${labels[ev.status] || ev.status}${files}`);
    return true;
  }
  return false;
}

function finishWorkStream(id) {
  if (id && state.activeWorkRun !== id) return;
  state.activeWorkRun = null;
  state.activeWorkBotId = null;
  if ($('workStopBtn')) $('workStopBtn').hidden = true;
  refreshWorkPending();
}

async function stopActiveWork() {
  if (isWorkShell()) { await workSession.stop(); return; }
  const id = state.activeWorkRun;
  if (!id) return;
  try {
    await api(`/api/dimension/work/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' });
  } catch (err) { addBubble('assistant', `停止失败：${err.message}`, '系统'); }
}

async function sendSoloWork(text, quote) {
  const input = $('composerInput');
  const botId = state.botId, groupId = state.activeGroupId;
  try {
    await workSession.submit(text, quote?.sourceRef || quote);
  } catch (error) {
    if (state.botId !== botId || state.activeGroupId !== groupId || !isWorkShell()) return;
    if (!input.value.trim()) { input.value = text; autoGrow(input); conversationDrafts.capture(text); syncSendEnabled(input, $('sendBtn'), false); if (quote) setGroupQuote(quote); }
    addBubble('assistant', '未提交：' + error.message, '系统');
  }
}

async function activateBot(id) {
  if (!id) return;
  const activationMode = state.shellMode, previousSelection = state.selections[state.shellMode];
  const rosterTicket = state.rosterActivationTicket = (state.rosterActivationTicket || 0) + 1;
  try { await addToRoster(id, activationMode); }
  catch (error) { setModelStatus(error.message || '调入名单失败'); return; }
  if (state.rosterActivationTicket !== rosterTicket || state.shellMode !== activationMode) return;
  leaveGroup({ restoreConversation: false });
  setGroupQuote(null);
  state.selections[state.shellMode] = { kind: 'bot', id };
  state.lastSelectedBots[state.shellMode] = id;
  sidebarActivity.acknowledge(id);
  if (state.switching) {
    state.nextBotId = id;
    state.botId = id;
    const target = knownBots().find(bot => bot.id === id);
    if (target?.name) state.botName = target.name;
    applyBotChrome(); renderBotList();
    await showBotHistory(id);
    return;
  }
  if (id === state.botId && id === state.runtimeBotId) { applyBotChrome(); await showBotHistory(id); return; }
  const previousId=state.botId,previousName=state.botName;
  state.switching = true;
  // 视图先行（预加载体感）：立刻换成目标 bot 的名字、头像和它自己的历史，后端重启在后台追。
  const target = knownBots().find((b) => b.id === id);
  state.botId = id;
  if (target?.name) state.botName = target.name;
  applyBotChrome();
  renderBotList();
  showBotHistory(id).catch(() => {});
  setModelStatus('正在唤醒…');
  try {
    const result = await api(`/api/dimension/bots/${encodeURIComponent(id)}/activate`, { method: 'POST' });
    await afterSwitch(result);
  } catch (err) {
    if (state.shellMode === activationMode && state.selections[activationMode]?.id === id) {
      state.selections[activationMode] = previousSelection;
      state.botId=previousId;state.botName=previousName;applyBotChrome();renderBotList();
      if (previousSelection?.kind === 'group') await openGroup(previousSelection.id, { keepNotice: true });
      else if (hasConversation()) { await showBotHistory(previousId); routeChatSession(previousId); }
      else showConversationWelcome();
    }
    setModelStatus(err.message);
  } finally {
    state.switching = false;
    const next = state.nextBotId; state.nextBotId = null;
    if (next) void activateBot(next);
  }
}

const SETUP_WIZARD_DRAFT_KEY = 'dimension.setupWizard.draft.v1';
const SETUP_ISOLATION_NOTE = '';

const SETUP_SCENES = {
  gaming: {
    id: 'gaming',
    title: '游戏直播',
    blurb: '直播现场协作、观众备忘与每日复盘。外部直播与社群通道只作人设预设，一律标未接通。',
    questions: [
      '你主要在哪些平台直播？（填写后只作预设，通道标未接通）',
      '是否需要粉丝社群协作？（本批不会接通外部社群）',
      '是否希望整理高光和复盘？',
      '是否需要观众档案备忘？',
    ],
    members: [
      { name: '弹幕管家', role: '整理直播现场互动' },
      { name: '观众档案员', role: '整理观众备忘' },
      { name: '高光捕手', role: '记录精彩片段' },
      { name: '群助手', role: '社群协作备忘' },
      { name: '记忆整理员', role: '整理与复盘' },
      { name: '数据看板', role: '汇总复盘数据' },
    ],
    groups: [
      { name: '直播现场', members: ['弹幕管家', '高光捕手', '观众档案员'] },
      { name: '社群', members: ['群助手', '观众档案员'] },
      { name: '每日复盘', members: ['记忆整理员', '数据看板', '高光捕手'] },
    ],
    unconnected: ['直播弹幕', '感谢礼物', '弹幕情绪', '直播数据', '外部社群消息', '游戏事件', '观众档案同步'],
  },
  content: {
    id: 'content',
    title: '内容创作',
    blurb: '选题、起草、素材与发布节奏协助。外发与趋势检索只作预设，一律标未接通。',
    questions: [
      '你主要做什么类型的内容？（视频 / 文章 / 图文 / 播客）',
      '计划发布到哪些平台？（只作预设，标未接通）',
      '是否需要选题与发布节奏协助？',
      '更新节奏大概怎样？（例如日更 / 周更）',
    ],
    members: [
      { name: '选题助手', role: '提供选题与灵感整理' },
      { name: '脚本写手', role: '起草脚本和文案' },
      { name: '素材管理员', role: '整理素材清单' },
      { name: '发布计划员', role: '安排发布节奏' },
      { name: '数据分析师', role: '复盘内容表现' },
    ],
    groups: [
      { name: '选题筹划', members: ['选题助手', '脚本写手'] },
      { name: '制作中', members: ['脚本写手', '素材管理员'] },
      { name: '发布上线', members: ['发布计划员', '数据分析师'] },
    ],
    unconnected: ['趋势搜索', '外发发布', '网盘自动整理', '平台统计'],
  },
  community: {
    id: 'community',
    title: '社群管理',
    blurb: '日常运营与数据整理。外部社群接口只作人设预设，一律标未接通。',
    questions: [
      '你主要在哪些社群里做运营？（不会做成已连接入口）',
      '社群大概多大规模？',
      '主要讨论什么话题？',
      '是否需要话题引导和数据整理？',
    ],
    members: [
      { name: '群管家', role: '日常运营备忘' },
      { name: '话题引导员', role: '整理讨论话题' },
      { name: '数据统计员', role: '汇总活跃与讨论情况' },
    ],
    groups: [
      { name: '日常运营', members: ['群管家', '话题引导员'] },
      { name: '数据分析', members: ['数据统计员', '群管家'] },
    ],
    unconnected: ['外部社群发消息', '成员管理', '群统计'],
  },
  assistant: {
    id: 'assistant',
    title: '个人助理',
    blurb: '日程、任务、笔记与资料整理。日历与在线笔记等外部能力只作预设，一律标未接通。',
    questions: [
      '你最想助手帮你做什么？',
      '是否需要每日简报？',
      '是否需要任务提醒？',
      '是否需要整理笔记？',
    ],
    members: [
      { name: '日程管家', role: '整理日程与提醒' },
      { name: '任务追踪员', role: '拆解和跟踪待办' },
      { name: '笔记整理员', role: '归纳笔记' },
      { name: '信息收集员', role: '汇总参考资料' },
    ],
    groups: [
      { name: '每日助手', members: ['日程管家', '任务追踪员', '信息收集员'] },
      { name: '知识整理', members: ['笔记整理员', '信息收集员'] },
    ],
    unconnected: ['日历同步', '在线笔记同步', '订阅源', '网页搜索'],
  },
};

let setupWizard = null;
let setupMemberSeq = 0;

function isBrainRegionName(name) {
  const value = String(name || '').trim();
  return /脑区|小 bot|minibot/i.test(value);
}

function hashSetupName(name) {
  let hash = 0;
  for (const ch of String(name || '')) hash = (hash * 33 + ch.codePointAt(0)) >>> 0;
  return hash;
}

function nextSetupSeal(name, index) {
  const colorIndex = (index + hashSetupName(name)) % SEAL_COLORS.length;
  return { shape: 'round-seal', color: SEAL_COLORS[colorIndex].id };
}

function makeSetupMember(name, role, index) {
  setupMemberSeq += 1;
  const trimmed = String(name || '').trim() || '未命名';
  const seal = nextSetupSeal(trimmed, index ?? setupMemberSeq);
  return {
    key: `setup-m-${setupMemberSeq}`,
    name: trimmed,
    role: String(role || '').trim(),
    shape: seal.shape,
    color: seal.color,
  };
}

function cloneSetupScene(sceneId) {
  const scene = SETUP_SCENES[sceneId];
  if (!scene) return null;
  const members = scene.members.map((item, index) => makeSetupMember(item.name, item.role, index));
  const groups = scene.groups.map((group) => ({
    name: group.name,
    members: group.members.slice(),
  }));
  return {
    sceneId: scene.id,
    title: scene.title,
    members,
    groups,
    unconnected: scene.unconnected.slice(),
    answers: {},
    questions: scene.questions.slice(),
  };
}

function freshSetupWizardState() {
  return {
    step: 'home',
    sceneId: '',
    title: '',
    customText: '',
    customNote: '',
    questions: [],
    answers: {},
    members: [],
    groups: [],
    unconnected: [],
    selectedKey: '',
    addName: '',
    busy: false,
    message: '',
    error: '',
    createdName: '',
  };
}

function readSetupWizardDraft() {
  try {
    const raw = localStorage.getItem(SETUP_WIZARD_DRAFT_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw);
    if (!draft || typeof draft !== 'object') return null;
    if (draft.complete === true || draft.finished === true) {
      // 草稿若被误写成完成标记，只回收方案内容，绝不沿用完成态。
      delete draft.complete;
      delete draft.finished;
    }
    return draft;
  } catch {
    return null;
  }
}

function hasSetupWizardDraft() {
  const draft = readSetupWizardDraft();
  return Boolean(draft && (draft.sceneId || draft.customText || (Array.isArray(draft.members) && draft.members.length)));
}

function setupWizardSnapshot() {
  if (!setupWizard) return null;
  return {
    step: setupWizard.step,
    sceneId: setupWizard.sceneId,
    title: setupWizard.title,
    customText: setupWizard.customText,
    customNote: setupWizard.customNote,
    questions: setupWizard.questions,
    answers: setupWizard.answers,
    members: setupWizard.members,
    groups: setupWizard.groups,
    unconnected: setupWizard.unconnected,
    selectedKey: setupWizard.selectedKey,
    addName: setupWizard.addName,
    createdName: setupWizard.createdName || '',
  };
}

function writeSetupWizardDraft() {
  const snap = setupWizardSnapshot();
  if (!snap) return;
  try {
    localStorage.setItem(SETUP_WIZARD_DRAFT_KEY, JSON.stringify(snap));
  } catch { /* ignore quota */ }
}

function syncSetupMemberSeq() {
  for (const item of setupWizard?.members || []) {
    const n = Number(String(item.key || '').replace(/^setup-m-/, ''));
    if (Number.isFinite(n) && n > setupMemberSeq) setupMemberSeq = n;
  }
}

function applySetupPlan(plan, extras = {}) {
  setupWizard.sceneId = plan.sceneId || '';
  setupWizard.title = plan.title || '';
  setupWizard.questions = Array.isArray(plan.questions) ? plan.questions.slice() : [];
  setupWizard.answers = { ...(plan.answers || {}) };
  setupWizard.members = (plan.members || []).map((item, index) => ({
    key: item.key || makeSetupMember(item.name, item.role, index).key,
    name: String(item.name || '').trim() || '未命名',
    role: String(item.role || '').trim(),
    shape: item.shape || nextSetupSeal(item.name, index).shape,
    color: item.color || nextSetupSeal(item.name, index).color,
  }));
  setupWizard.groups = (plan.groups || []).map((group) => ({
    name: group.name,
    members: Array.isArray(group.members) ? group.members.slice() : [],
  }));
  setupWizard.unconnected = Array.from(new Set([...(plan.unconnected || []), ...(extras.unconnected || [])]));
  setupWizard.customNote = extras.customNote || plan.customNote || '';
  syncSetupMemberSeq();
  if (setupWizard.members.length === 1) setupWizard.selectedKey = setupWizard.members[0].key;
  else if (!setupWizard.members.some((item) => item.key === setupWizard.selectedKey)) setupWizard.selectedKey = '';
  setupWizard.error = '';
  setupWizard.message = '';
}

function unconnectedFromAnswers(answers) {
  const text = Object.values(answers || {}).join(' ');
  const found = [];
  const map = [
    [/B站|哔哩/i, 'B站'],
    [/抖音/, '抖音'],
    [/虎牙/, '虎牙'],
    [/斗鱼/, '斗鱼'],
    [/公众号/, '公众号'],
    [/小红书/, '小红书'],
    [/油管|YouTube/i, '油管'],
    [/微信|Discord|Telegram|QQ/i, '外部社群'],
    [/日历|Calendar/i, '日历同步'],
    [/Notion/i, '在线笔记同步'],
    [/RSS|订阅/i, '订阅源'],
  ];
  for (const [re, label] of map) {
    if (re.test(text)) found.push(label);
  }
  return found;
}

function visibleSetupGroups() {
  const names = new Set(setupWizard.members.map((item) => item.name));
  return setupWizard.groups
    .map((group) => ({
      name: group.name,
      members: (group.members || []).filter((name) => names.has(name)),
    }))
    .filter((group) => group.members.length);
}

function selectedSetupMember() {
  if (!setupWizard) return null;
  return setupWizard.members.find((item) => item.key === setupWizard.selectedKey) || null;
}

function suggestSetupPlan(text) {
  const source = String(text || '').trim();
  if (!source) return { error: '请先用一句话说明需求。' };
  const rules = [
    { id: 'gaming', keys: ['直播', '弹幕', '高光', '观众', '主播', '礼物'] },
    { id: 'content', keys: ['创作', '选题', '脚本', '素材', '发布', '文案', '视频', '文章', '图文', '播客'] },
    { id: 'community', keys: ['社群', '运营', '话题', '群管', '群助手', '群管家'] },
    { id: 'assistant', keys: ['日程', '任务', '笔记', '助理', '助手', '提醒', '简报', '收集'] },
  ];
  const scored = rules.map((rule) => ({
    id: rule.id,
    score: rule.keys.reduce((sum, key) => sum + (source.includes(key) ? 1 : 0), 0),
  })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);

  const named = [];
  const nameRe = /[「“"]([^」”"]{1,20})[」”"]/g;
  let match;
  while ((match = nameRe.exec(source))) {
    const name = match[1].trim();
    if (name && !isBrainRegionName(name) && !named.includes(name)) named.push(name);
  }

  const single = /只要一个|只需要一个|只要一名|只要一位|一个 bot|一个Bot|只确认一个|只建一个/i.test(source);
  let plan = null;
  let note = '建议由本地规则根据你的说明推导，不强制套用快速场景，也不会写入当前主会话。';

  if (scored.length === 1 || (scored.length > 1 && scored[0].score >= scored[1].score + 2)) {
    plan = cloneSetupScene(scored[0].id);
    note = `按你的说明，建议从「${plan.title}」出发，仍可增删成员；组群只是预案。`;
  } else if (scored.length > 1) {
    const primary = cloneSetupScene(scored[0].id);
    const extraNames = [];
    for (const item of scored.slice(1)) {
      const other = SETUP_SCENES[item.id];
      for (const member of other.members) {
        if (!primary.members.some((row) => row.name === member.name) && !extraNames.includes(member.name)) {
          extraNames.push(member.name);
          primary.members.push(makeSetupMember(member.name, member.role, primary.members.length));
        }
      }
      primary.unconnected = Array.from(new Set([...primary.unconnected, ...other.unconnected]));
    }
    plan = primary;
    plan.sceneId = 'custom';
    plan.title = '综合建议';
    note = '你的说明里有多个方向，下面是一套可改的综合建议，并不强制套用某一个快速场景。';
  } else if (named.length) {
    plan = {
      sceneId: 'custom',
      title: '自定义建议',
      questions: [],
      answers: {},
      members: named.filter((name) => !isBrainRegionName(name)).map((name, index) => makeSetupMember(name, '', index)),
      groups: [],
      unconnected: ['外部通道'],
    };
  } else {
    const fallbackName = /助手|助理/.test(source) ? '个人助手' : '自定义助手';
    plan = {
      sceneId: 'custom',
      title: '自定义建议',
      questions: [],
      answers: {},
      members: [makeSetupMember(fallbackName, '按你的说明提供协助', 0)],
      groups: [],
      unconnected: ['外部通道'],
    };
    note = '没有匹配到现成场景，先建议一个可改的单人方案。允许最终只确认一个 Bot。';
  }

  if (named.length && plan) {
    for (const name of named) {
      if (isBrainRegionName(name)) continue;
      if (!plan.members.some((item) => item.name === name)) {
        plan.members.push(makeSetupMember(name, '', plan.members.length));
      }
    }
  }

  if (single && plan.members.length > 1) {
    const preferred = named[0] && plan.members.find((item) => item.name === named[0]);
    plan.members = [preferred || plan.members[0]];
    plan.groups = [];
    note += ' 已按「只要一个」收成单人预案，你还可以再改。';
  }

  plan.members = plan.members.filter((item) => !isBrainRegionName(item.name));
  if (!plan.members.length) return { error: '建议里没有可创建的独立 Bot，13 个脑区小 bot 不能作为向导成员。' };
  return { plan, note };
}

async function createBotShell({ name, paperSeal }) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('请先填写名称。');
  if (isForbiddenDisplayName(trimmed)) throw new Error('这个名称不能用。');
  if (isBrainRegionName(trimmed)) throw new Error('13 个脑区小 bot 不能作为向导成员。');
  const result = await api('/api/dimension/bots', {
    method: 'POST',
    body: JSON.stringify({ name: trimmed, paperSeal, ...(state.persistentBotRosters ? { mode: state.shellMode } : {}) }),
  });
  if (!result.bot?.id) throw new Error('已发出创建请求，但没有返回新 bot。');
  writeLocalSeal(result.bot.id, paperSeal);
  const created = {
    ...result.bot,
    name: result.bot.name || trimmed,
    paperSeal: { ...paperSeal, stored: true },
    preview: '',
    active: false,
  };
  const incoming = Array.isArray(result.bots) ? result.bots : state.bots;
  const seen = new Set();
  state.bots = incoming.map((bot) => {
    seen.add(bot.id);
    return bot.id === created.id ? { ...bot, ...created, active: bot.active === true } : bot;
  });
  if (!seen.has(created.id)) state.bots = [...state.bots, created];
  syncNativeBotRosters();
  // 只刷新列表，不切换活主、不清对白、不改当前显示名。
  renderBotList();
  return created;
}

function setupWizardMarkup() {
  const draftHint = hasSetupWizardDraft()
    ? '<button type="button" class="setup-wiz-path" data-setup-act="resume"><strong>继续上次草稿</strong><span>只恢复待创建方案，不会把向导标为已完成。</span></button>'
    : '';
  if (setupWizard.step === 'home') {
    const cards = Object.values(SETUP_SCENES).map((scene) => `
      <button type="button" class="setup-wiz-scene" data-setup-act="scene" data-scene="${escapeHtml(scene.id)}">
        <strong>${escapeHtml(scene.title)}</strong>
        <span>${escapeHtml(scene.blurb)}</span>
      </button>`).join('');
    const roster = rosterIds();
    const owned = dedupeBots(knownBots()).filter((bot) => bot?.id && !isDeletedBot(bot) && !roster.has(bot.id));
    const poolQuery = String(setupWizard.poolQuery || '').trim().toLowerCase();
    const pool = poolQuery ? owned.filter((bot) => botMatchesQuery(bot, poolQuery)) : owned;
    const ownedMarkup = owned.length ? `
      <p class="setup-wiz-section-title">调出池 · 还没调出到${isWorkShell() ? ' work ' : ' chat '}的 bot（调出后才算启用）</p>
      <input id="setupWizPoolSearch" class="setup-wiz-input" maxlength="40" placeholder="搜名字调出…" value="${escapeHtml(setupWizard.poolQuery || '')}" autocomplete="off">
      <div class="setup-wiz-owned setup-wiz-pool">${pool.map((bot) => `
        <div class="setup-wiz-owned-row">
          <span class="seal-slot">${botAvatar(bot, 32)}</span>
          <span class="setup-wiz-owned-name">${escapeHtml(displayBotName(bot) || bot.name || bot.id)}</span>
          <button type="button" class="setup-wiz-text-btn" data-setup-act="use-existing" data-id="${escapeHtml(bot.id)}">调出</button>
        </div>`).join('') || '<p class="setup-wiz-hint">没有匹配的 bot。</p>'}</div>` : '';
    return `
      <p class="setup-wiz-lead">先选一条路：快速场景，或用一句话说明需求后给出建议。都不承诺固定时限。</p>
      <div class="setup-wiz-scenes">${cards}</div>
      <button type="button" class="setup-wiz-path" data-setup-act="custom">
        <strong>自定义对话</strong>
        <span>用自然语言说明需求，向导给出一套可改的 Bot 与组群建议。允许最终只确认一个 Bot。</span>
      </button>
      ${ownedMarkup}
      ${draftHint}`;
  }
  if (setupWizard.step === 'custom') {
    return `
      <div class="setup-wiz-custom">
        <p class="setup-wiz-lead">用自然语言说明你需要哪些 Bot，或希望怎样分工。建议由本地规则推导，不会写入当前主会话，也不会去接通外部通道。</p>
        <textarea id="setupWizCustomText" class="setup-wiz-text" maxlength="2000" placeholder="例如：我做内容创作，需要选题和脚本协助，先只要一个助手。">${escapeHtml(setupWizard.customText || '')}</textarea>
        <p class="setup-wiz-hint">不会调用外部工具，也不把分析写进活主聊天。</p>
      </div>
      <div class="setup-wiz-actions">
        <button type="button" class="setup-wiz-text-btn" data-setup-act="home">返回</button>
        <button type="button" class="setup-wiz-btn is-primary" data-setup-act="suggest">提出建议</button>
      </div>`;
  }

  const member = selectedSetupMember();
  const groups = visibleSetupGroups();
  const unconnected = Array.from(new Set([
    ...setupWizard.unconnected,
    ...unconnectedFromAnswers(setupWizard.answers),
  ]));
  const questions = setupWizard.questions.map((question, index) => `
    <div class="setup-wiz-q">
      <label for="setupWizQ${index}">${escapeHtml(question)}</label>
      <input id="setupWizQ${index}" class="setup-wiz-input" data-setup-q="${index}" value="${escapeHtml(setupWizard.answers[index] || '')}" maxlength="80" autocomplete="off">
    </div>`).join('');
  const members = setupWizard.members.map((item) => {
    const selected = item.key === setupWizard.selectedKey;
    return `
      <div class="setup-wiz-member${selected ? ' is-selected' : ''}" data-member-key="${escapeHtml(item.key)}">
        <button type="button" class="setup-wiz-seal-slot" data-setup-act="pick-member" data-member-key="${escapeHtml(item.key)}" aria-label="选择 ${escapeHtml(item.name)}" aria-pressed="${selected ? 'true' : 'false'}">
          ${paperSealSvg({ shape: item.shape, color: item.color, name: item.name, size: 40 })}
        </button>
        <div class="setup-wiz-member-main">
          <input class="setup-wiz-input" data-setup-rename="${escapeHtml(item.key)}" value="${escapeHtml(item.name)}" maxlength="40" aria-label="成员名称" autocomplete="off">
          <p class="setup-wiz-member-role">${escapeHtml(item.role || '独立 Bot 预案')} · 默认进入对话名单</p>
        </div>
        <div class="setup-wiz-member-actions">
          <button type="button" class="setup-wiz-text-btn" data-setup-act="pick-member" data-member-key="${escapeHtml(item.key)}">${selected ? '将创建这个' : '选为本次创建'}</button>
          <button type="button" class="setup-wiz-text-btn is-danger" data-setup-act="remove-member" data-member-key="${escapeHtml(item.key)}">删除</button>
        </div>
      </div>`;
  }).join('') || '<p class="setup-wiz-hint">还没有成员。可以先添加一个，或返回重选场景。</p>';

  const groupMarkup = groups.length
    ? groups.map((group) => `
        <div class="setup-wiz-group">
          <strong>${escapeHtml(group.name)}</strong>
          <p class="setup-wiz-group-members">${escapeHtml(group.members.join('、'))}</p>
        </div>`).join('')
    : '<p class="setup-wiz-hint">当前没有组群预案。本批也不会实建组群。</p>';

  const channelMarkup = unconnected.length
    ? `<div class="setup-wiz-chip-row">${unconnected.map((item) => `<span class="setup-wiz-tag is-off">${escapeHtml(item)} · 未接通</span>`).join('')}</div>`
    : '<p class="setup-wiz-hint">这条方案没有列出外部通道；若建议里出现通道能力，一律按未接通处理。</p>';

  const colorButtons = member ? SEAL_COLORS.map((item) => `
      <button type="button" data-setup-act="color" data-color="${escapeHtml(item.id)}" class="${item.id === 'ivory' ? 'is-ivory' : ''}" aria-label="${escapeHtml(item.name)}" aria-selected="${item.id === member.color ? 'true' : 'false'}" style="background:${escapeHtml(item.hex)}"></button>`).join('') : '';

  const sealEditor = member ? `
    <div class="setup-wiz-seals">
      <p class="setup-wiz-section-title">新 bot 的纸印：${escapeHtml(member.name)}</p>
      <div class="setup-wiz-preview">${paperSealSvg({ shape: member.shape, color: member.color, name: member.name, size: 88, breathe: true })}</div>
            <div class="setup-wiz-colors" role="listbox" aria-label="颜色">${colorButtons}</div>
    </div>` : '<p class="setup-wiz-hint">预案里若有多名成员，请先选一个再建。向导不能一次建出多个 Bot，也不能实建组群。</p>';

  const canCreate = Boolean(member) && !setupWizard.busy;
  return `
    <p class="setup-wiz-lead">${escapeHtml(setupWizard.title || '待创建方案')}${setupWizard.customNote ? ` · ${escapeHtml(setupWizard.customNote)}` : ''}</p>
    ${questions ? `<div class="setup-wiz-questions"><p class="setup-wiz-section-title">确认问题（可选）</p>${questions}</div>` : ''}
    <div class="setup-wiz-members">
      <p class="setup-wiz-section-title">将生成的 Bot（确认前可增删）</p>
      ${members}
      <div class="setup-wiz-add">
        <input id="setupWizAddName" class="setup-wiz-input" maxlength="40" placeholder="添加成员名称" value="${escapeHtml(setupWizard.addName || '')}" autocomplete="off" aria-label="添加成员名称">
        <button type="button" class="setup-wiz-btn" data-setup-act="add-member">添加</button>
      </div>
    </div>
    <div class="setup-wiz-groups">
      <p class="setup-wiz-section-title">组群预案（仅预览，本批不实建）</p>
      ${groupMarkup}
    </div>
    <div class="setup-wiz-channels">
      <p class="setup-wiz-section-title">通道能力</p>
      ${channelMarkup}
    </div>
    ${sealEditor}
    <p class="setup-wiz-note">${escapeHtml(SETUP_ISOLATION_NOTE)}</p>
    <div class="setup-wiz-actions">
      <button type="button" class="setup-wiz-text-btn" data-setup-act="home">返回</button>
      <button type="button" class="setup-wiz-btn" data-setup-act="save-draft">保存草稿</button>
      <button type="button" class="setup-wiz-btn is-primary" data-setup-act="create-shell" ${canCreate ? '' : 'disabled'}>创建</button>
    </div>`;
}

function renderSetupWizard() {
  const root = document.getElementById('setupWiz');
  if (!root || !setupWizard) return;
  const title = root.querySelector('.setup-wiz-title');
  if (title) title.textContent = '新建 Bot';
  const body = document.getElementById('setupWizBody');
  const msg = document.getElementById('setupWizMsg');
  if (body) body.innerHTML = setupWizardMarkup();
  if (msg) {
    msg.classList.toggle('is-error', Boolean(setupWizard.error));
    msg.classList.toggle('is-ok', Boolean(setupWizard.message) && !setupWizard.error);
    msg.textContent = setupWizard.error || setupWizard.message || '';
  }
  bindSetupWizard(root);
  writeSetupWizardDraft();
}

function bindSetupWizard(root) {
  const body = document.getElementById('setupWizBody');
  if (!body || body.dataset.bound === '1') {
    // 每次重绘后需要重新绑定；允许覆盖。
  }
  if (body) body.dataset.bound = '1';

  body?.querySelector('#setupWizCustomText')?.addEventListener('input', (event) => {
    setupWizard.customText = event.target.value;
  });
  body?.querySelector('#setupWizAddName')?.addEventListener('input', (event) => {
    setupWizard.addName = event.target.value;
  });
  body?.querySelector('#setupWizPoolSearch')?.addEventListener('input', (event) => {
    setupWizard.poolQuery = event.target.value;
    const body2 = document.getElementById('setupWizBody');
    if (body2) body2.innerHTML = setupWizardMarkup();
    bindSetupWizard(document.getElementById('setupWiz'));
    const input = document.getElementById('setupWizPoolSearch');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  });
  body?.querySelector('#setupWizAddName')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addSetupWizardMember();
  });
  body?.querySelectorAll('[data-setup-q]').forEach((input) => {
    input.addEventListener('input', () => {
      setupWizard.answers[input.getAttribute('data-setup-q')] = input.value;
    });
  });
  body?.querySelectorAll('[data-setup-rename]').forEach((input) => {
    input.addEventListener('input', () => {
      const key = input.getAttribute('data-setup-rename');
      const member = setupWizard.members.find((item) => item.key === key);
      if (!member) return;
      const previous = member.name;
      member.name = input.value.trim() || member.name;
      setupWizard.groups.forEach((group) => {
        group.members = group.members.map((name) => (name === previous ? member.name : name));
      });
    });
    input.addEventListener('change', () => renderSetupWizard());
  });
}

function addSetupWizardMember() {
  const name = String(setupWizard.addName || document.getElementById('setupWizAddName')?.value || '').trim();
  if (!name) {
    setupWizard.error = '请先填写要添加的成员名称。';
    setupWizard.message = '';
    renderSetupWizard();
    return;
  }
  if (isForbiddenDisplayName(name) || isBrainRegionName(name)) {
    setupWizard.error = isBrainRegionName(name) ? '13 个脑区小 bot 不能作为向导成员。' : '这个名称不能用。';
    setupWizard.message = '';
    renderSetupWizard();
    return;
  }
  const member = makeSetupMember(name, '', setupWizard.members.length);
  setupWizard.members.push(member);
  setupWizard.addName = '';
  setupWizard.error = '';
  setupWizard.message = '';
  if (setupWizard.members.length === 1) setupWizard.selectedKey = member.key;
  else setupWizard.selectedKey = setupWizard.selectedKey || '';
  renderSetupWizard();
}

function removeSetupWizardMember(key) {
  const target = setupWizard.members.find((item) => item.key === key);
  setupWizard.members = setupWizard.members.filter((item) => item.key !== key);
  if (target) {
    setupWizard.groups.forEach((group) => {
      group.members = group.members.filter((name) => name !== target.name);
    });
  }
  if (setupWizard.selectedKey === key) {
    setupWizard.selectedKey = setupWizard.members.length === 1 ? setupWizard.members[0].key : '';
  }
  setupWizard.error = '';
  setupWizard.message = '';
  renderSetupWizard();
}

function startSetupScene(sceneId) {
  const plan = cloneSetupScene(sceneId);
  if (!plan) return;
  applySetupPlan(plan);
  setupWizard.step = 'preview';
  setupWizard.customText = '';
  setupWizard.customNote = '';
  renderSetupWizard();
}

function resumeSetupWizardDraft() {
  const draft = readSetupWizardDraft();
  if (!draft) return;
  setupWizard = { ...freshSetupWizardState(), ...draft, busy: false, error: '', message: draft.createdName ? `草稿里记下了此前建过的「${draft.createdName}」。` : '' };
  syncSetupMemberSeq();
  if (!setupWizard.step || setupWizard.step === 'home') {
    setupWizard.step = (setupWizard.members && setupWizard.members.length) ? 'preview' : (setupWizard.customText ? 'custom' : 'home');
  }
  renderSetupWizard();
}

async function confirmSetupWizardShell() {
  if (setupWizard.busy) return;
  const member = selectedSetupMember();
  if (setupWizard.members.length > 1 && !member) {
    setupWizard.error = '预案里有多名成员。请先选一个（或删到只剩一个）再创建。';
    setupWizard.message = '';
    renderSetupWizard();
    return;
  }
  if (!member) {
    setupWizard.error = '请先选一个成员，或添加一个成员后再创建。';
    setupWizard.message = '';
    renderSetupWizard();
    return;
  }
  const name = String(member.name || '').trim();
  if (!name) {
    setupWizard.error = '请先填写名称。';
    setupWizard.message = '';
    renderSetupWizard();
    return;
  }
  setupWizard.busy = true;
  setupWizard.error = '';
  setupWizard.message = '正在创建…';
  renderSetupWizard();
  const paperSeal = { shape: member.shape, color: member.color, pinned: false };
  try {
    const created = await createBotShell({ name, paperSeal });
    setupWizard.busy = false;
    // 新建只调出到当前模式的名单，不激活：空壳 bot 由用户自己点开。
    if (created?.id) { await addToRoster(created.id); renderBotList(); }
    setupWizard.createdName = created.name || name;
    setupWizard.error = '';
    setupWizard.message = `已创建「${setupWizard.createdName}」，可以立即聊天、进群、领任务。`;
    writeSetupWizardDraft();
    renderSetupWizard();
  } catch (err) {
    setupWizard.busy = false;
    setupWizard.error = err.message || '创建没有成功，当前活聊天未被清空。';
    setupWizard.message = '';
    renderSetupWizard();
  }
}

async function onSetupWizardAction(event) {
  const btn = event.target.closest('[data-setup-act]');
  if (!btn || !setupWizard) return;
  const act = btn.getAttribute('data-setup-act');
  if (act === 'scene') startSetupScene(btn.getAttribute('data-scene'));
  else if (act === 'custom') {
    setupWizard.step = 'custom';
    setupWizard.error = '';
    setupWizard.message = '';
    renderSetupWizard();
    document.getElementById('setupWizCustomText')?.focus();
  } else if (act === 'home') {
    setupWizard.step = 'home';
    setupWizard.error = '';
    setupWizard.message = '';
    writeSetupWizardDraft();
    renderSetupWizard();
  } else if (act === 'resume') resumeSetupWizardDraft();
  else if (act === 'suggest') {
    setupWizard.customText = document.getElementById('setupWizCustomText')?.value || setupWizard.customText;
    const suggested = suggestSetupPlan(setupWizard.customText);
    if (suggested.error) {
      setupWizard.error = suggested.error;
      setupWizard.message = '';
      renderSetupWizard();
      return;
    }
    applySetupPlan(suggested.plan, { customNote: suggested.note });
    setupWizard.step = 'preview';
    renderSetupWizard();
  } else if (act === 'add-member') addSetupWizardMember();
  else if (act === 'remove-member') removeSetupWizardMember(btn.getAttribute('data-member-key'));
  else if (act === 'pick-member') {
    setupWizard.selectedKey = btn.getAttribute('data-member-key') || '';
    setupWizard.error = '';
    renderSetupWizard();
  } else if (act === 'color') {
    const member = selectedSetupMember();
    if (!member) return;
    member.color = btn.getAttribute('data-color');
    renderSetupWizard();
  } else if (act === 'save-draft') {
    writeSetupWizardDraft();
    setupWizard.error = '';
    setupWizard.message = '草稿已保存。这只是待创建方案，并没有把向导标为已完成。';
    renderSetupWizard();
  } else if (act === 'create-shell') confirmSetupWizardShell();
  else if (act === 'use-existing') {
    const id = btn.getAttribute('data-id');
    if (!id) return;
    btn.disabled = true;
    try { await addToRoster(id); renderBotList(); renderSetupWizard(); }
    catch (error) { setupWizard.error = error.message || '调入失败'; renderSetupWizard(); }
    finally { btn.disabled = false; }
  }
}

function openSetupWizard() {
  bumpUiTicket();
  setupWizard = freshSetupWizardState();
  showModal(`
    <div class="setup-wiz" id="setupWiz">
      <div class="setup-wiz-head">
        <h2 class="setup-wiz-title" id="setupWizTitle">新建 Bot</h2>
        <button type="button" class="setup-wiz-close" data-close>关闭</button>
      </div>
      <p class="setup-wiz-banner">${escapeHtml(SETUP_ISOLATION_NOTE)}</p>
      <p class="setup-wiz-msg" id="setupWizMsg"></p>
      <div class="setup-wiz-body" id="setupWizBody"></div>
    </div>`, false, 'setup-wizard');
  const root = document.getElementById('setupWiz');
  root?.addEventListener('click', onSetupWizardAction);
  renderSetupWizard();
}

/** All locally created/imported Bots stay available, including those removed from both modes. */
function renderBotPool() {
  const list = document.getElementById('botPoolList');
  if (!list) return;
  const roster = rosterIds();
  const query = String(document.getElementById('botPoolSearch')?.value || '').trim().toLowerCase();
  const pool = rankMatchingBots(dedupeBots(knownBots()).filter(bot => !roster.has(bot.id)), query);
  list.innerHTML = pool.slice(0, 80).map((bot) => `
    <div class="setup-wiz-owned-row">
      <span class="seal-slot">${botAvatar(bot, 32)}</span>
      <span class="setup-wiz-owned-name">${escapeHtml(displayBotName(bot) || bot.name || bot.id)}</span>
      <button type="button" class="setup-wiz-text-btn" data-pool-id="${escapeHtml(bot.id)}">调出</button>
    </div>`).join('') || `<p class="setup-wiz-hint">${query ? '没有匹配的 bot。' : '本地 Bot 都已在当前名单中。'}</p>`;
  list.querySelectorAll('[data-pool-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await addToRoster(btn.dataset.poolId, undefined, { reveal: true });
        renderBotList(); renderBotPool();
      } catch (error) {
        const message = $('newBotMsg');
        if (message) message.textContent = error.message || '调入失败';
      } finally { btn.disabled = false; }
    });
  });
}

/** Create a Bot, then optionally generate an editable persona draft. */
function openCreateBot() {
  bumpUiTicket();
  const draft = { name: '', shape: 'round-seal', color: 'persimmon', avatar: null, avatarUrl: '' };
  const colorHex = (id) => SEAL_COLORS.find((c) => c.id === id)?.hex || '#2a2723';
  const colorButtons = SEAL_COLORS.map((item) => `
      <button type="button" data-color="${escapeHtml(item.id)}" class="${item.id === 'ivory' ? 'is-ivory' : ''}" aria-label="${escapeHtml(item.name)}" aria-selected="${item.id === draft.color ? 'true' : 'false'}" style="background:${escapeHtml(item.hex)}"></button>`).join('');
  showModal(`
    <div class="create-bot-body">
      <h2 class="create-bot-title">创建新 Bot</h2>
      <button type="button" class="create-bot-library" id="openLibraryBtn">从角色库引入</button>
      <div class="create-bot-preview-row">
        <div class="create-bot-preview" id="newBotPreview"></div>
        <button type="button" class="create-bot-avatar-add" id="newBotAvatarBtn" title="为你的 bot 自定义头像" aria-label="为你的 bot 自定义头像">
          <svg class="avatar-add-icon" width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden="true"><path d="M15 8v14M8 15h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
          <img class="avatar-add-preview" id="newBotAvatarImg" alt="" hidden>
        </button>
        <input type="file" id="newBotAvatarInput" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
      </div>
      <input id="newBotName" class="create-bot-name" maxlength="40" placeholder="给你的 Bot 起个名字" autocomplete="off">
      <div class="create-bot-colors" id="newBotColors" role="listbox" aria-label="颜色">${colorButtons}</div>
      <div class="create-bot-footer">
        <button type="button" class="create-bot-cancel" data-close>取消</button>
        <button type="button" class="create-bot-submit" id="confirmNewBot" disabled>创建</button>
      </div>
      <p class="create-bot-msg" id="newBotMsg"></p>
      <div class="bot-pool" id="botPool">
<p class="setup-wiz-section-title">我的 Bot · 调入${isWorkShell() ? ' Work ' : ' Chat '}</p>
        <input id="botPoolSearch" class="setup-wiz-input" maxlength="40" placeholder="搜名字调出…" autocomplete="off">
        <div class="bot-pool-list" id="botPoolList"></div>
      </div>
    </div>`, false, 'create-bot');
  renderBotPool();
  const preview = document.getElementById('newBotPreview');
  const nameInput = document.getElementById('newBotName');
  const submitBtn = document.getElementById('confirmNewBot');
  const msg = document.getElementById('newBotMsg');
  const avatarBtn = document.getElementById('newBotAvatarBtn');
  const avatarImg = document.getElementById('newBotAvatarImg');
  avatarBtn.addEventListener('click', () => document.getElementById('newBotAvatarInput').click());
  document.getElementById('newBotAvatarInput').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    draft.avatar = file;
    if (draft.avatarUrl) URL.revokeObjectURL(draft.avatarUrl);
    draft.avatarUrl = URL.createObjectURL(file);
    avatarImg.src = draft.avatarUrl;
    avatarImg.hidden = false;
    avatarBtn.classList.add('has-image');
  });
  const refresh = () => {
    preview.innerHTML = dimensionBotAvatar(draft.name || '新伙伴', colorHex(draft.color), 96, 'idle');
    for (const btn of document.querySelectorAll('#newBotColors [data-color]')) {
      btn.setAttribute('aria-selected', btn.dataset.color === draft.color ? 'true' : 'false');
    }
    submitBtn.disabled = !draft.name.trim();
  };
  refresh();
  document.getElementById('openLibraryBtn').addEventListener('click', () => openLibraryPicker());
  document.getElementById('botPoolSearch').addEventListener('input', () => renderBotPool());
  nameInput.addEventListener('input', () => { draft.name = nameInput.value; submitBtn.disabled = !draft.name.trim(); });
  document.getElementById('newBotColors').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-color]');
    if (!btn) return;
    draft.color = btn.dataset.color;
    refresh();
  });
  submitBtn.addEventListener('click', async () => {
    submitBtn.disabled = true;
    if (msg) msg.textContent = '正在创建…';
    try {
      const created = await createBotShell({ name: draft.name, paperSeal: { shape: draft.shape, color: draft.color, pinned: false } });
      if (created?.id) { await addToRoster(created.id); renderBotList(); }
      closeModal();
      let avatarNotice = '';
      if (created?.id && draft.avatar) {
        try {
          const result = await uploadImageAsset(`/api/dimension/bots/${encodeURIComponent(created.id)}/avatar`, draft.avatar);
          Object.assign(created, { hasAvatar: true, avatarRevision: result?.avatarRevision || String(Date.now()) });
          patchBotRecord(created.id, { hasAvatar: true, avatarRevision: created.avatarRevision });
          renderBotList();
        } catch (error) { avatarNotice = `Bot 已创建，头像上传失败：${error.message || '请稍后重试'}。可在“自定义头像”中重新上传。`; }
        finally { if (draft.avatarUrl) URL.revokeObjectURL(draft.avatarUrl); }
      }
      openBotIntro(created, avatarNotice);
    } catch (err) {
      if (msg) msg.textContent = err.message || '创建失败';
      submitBtn.disabled = false;
    }
  });
  nameInput.focus();
}

function catalogResultRows(items) {
  return (items || []).map(item => `<button type="button" class="library-row" data-source-id="${escapeHtml(item.sourceId)}" data-entry-id="${escapeHtml(item.entryId)}" data-entry-revision="${escapeHtml(item.revision)}" title="${escapeHtml([item.source?.url, item.source?.license].filter(Boolean).join(' · '))}">
    <span class="library-row-avatar library-row-empty"></span><span class="library-row-main"><span class="library-row-name">${escapeHtml(item.name)}</span>
    <span class="library-row-sub">${escapeHtml([item.series, item.source?.name, item.entryId].filter(Boolean).join(' · '))}</span></span></button>`).join('');
}
function catalogIdentity(row) {
  return { sourceId: row.dataset.sourceId, entryId: row.dataset.entryId, revision: row.dataset.entryRevision };
}

/** Search explicitly imported directory snapshots by stable source/entry IDs. */
function openLibraryPicker() {
  const mode = state.shellMode;
  showModal(`
    <div class="create-bot-body library-picker">
      <h2 class="create-bot-title">角色库</h2>
      <p class="create-bot-hint">新建和已引入的 Bot 会保存在这里，重新调入继续使用原来的记忆。</p>
      <div class="library-archive-actions" data-bot-archive-entry ${botArchiveUi?.available ? '' : 'hidden'}><button type="button" class="text-btn" id="libraryImportBotArchive">导入 Bot 归档</button><span>选择资料、会话与记忆，创建新的 Bot。</span></div>
      <p class="create-bot-hint">外部角色来自你明确导入的 JSON 目录快照；搜索不会联网。相同来源 ID 的新快照替换目录索引，已引入的 Bot 保留。</p>
      <label class="text-btn">导入目录 JSON <input type="file" id="libraryCatalogFile" accept=".json,application/json"></label>
      <a class="text-btn" href="/dimension-ui/character-directory-example.json" download>下载格式示例</a>
      <p id="libraryCatalogMsg" class="create-bot-msg" role="status"></p><div id="librarySources"></div>
      <input id="librarySearch" class="create-bot-name" placeholder="搜我的 Bot、角色名或作品名" autocomplete="off">
      <div class="library-results" id="libraryResults"><p class="create-bot-msg">正在读取角色库…</p></div>
      <button type="button" class="text-btn" id="libraryMore" hidden>加载更多目录角色</button>
      <div class="create-bot-footer">
        <button type="button" class="create-bot-cancel" data-close>返回</button>
      </div>
    </div>`, false, 'create-bot');
  const input = document.getElementById('librarySearch');
  const results = document.getElementById('libraryResults');
  let timer = 0;
  let seq = 0;
  let ownedBots = [];
  let loadedEntries = [], directoryRevision = '', nextOffset = 0;
  const more = $('libraryMore'), sourceHost = $('librarySources'), catalogMessage = $('libraryCatalogMsg');
  const search = async (append = false) => {
    const mySeq = ++seq;
    more.disabled = true;
    try {
      const data = await api(`/api/dimension/library?q=${encodeURIComponent(input.value.trim())}${append ? '&offset=' + nextOffset + '&revision=' + encodeURIComponent(directoryRevision) : ''}`);
      if (mySeq !== seq) return;
      loadedEntries = append ? [...loadedEntries, ...(data.results || [])] : data.results || [];
      directoryRevision = data.directoryRevision; nextOffset = data.nextOffset;
      more.hidden = !data.hasMore;
      sourceHost.innerHTML = (data.sources || []).map(item => `<p class="create-bot-hint">${item.source.url ? `<a href="${escapeHtml(item.source.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.source.name)}</a>` : escapeHtml(item.source.name)} · ${item.count} 个条目 · ${escapeHtml(item.source.license)}</p>`).join('') || '<p class="create-bot-hint">尚未导入外部目录快照。</p>';
      ownedBots = Array.isArray(data.owned) ? data.owned : [];
      const roster = rosterIds();
      const ownedRows = ownedBots.slice(0, 80).map(bot => `
        <div class="library-owned-row">
        <button type="button" class="library-row" data-bot-id="${escapeHtml(bot.id)}" ${roster.has(bot.id) ? 'disabled' : ''}>
          <span class="library-row-avatar">${botAvatar(bot, 36)}</span>
          <span class="library-row-main"><span class="library-row-name">${escapeHtml(displayBotName(bot))}</span>
            <span class="library-row-sub">我的 Bot · ${roster.has(bot.id) ? '已在当前名单' : '调入并保留记忆'}</span></span>
        </button>${botArchiveUi?.available ? `<button type="button" class="text-btn library-archive-export" data-bot-archive-export="${escapeHtml(bot.id)}" aria-label="导出 ${escapeHtml(displayBotName(bot))} 的归档">导出</button>` : ''}</div>`).join('');
      const catalogRows = catalogResultRows(loadedEntries);
      results.innerHTML = (ownedRows ? `<p class="setup-wiz-section-title">我的 Bot</p>${ownedRows}` : '')
        + (catalogRows ? `<p class="setup-wiz-section-title">可引入的角色</p>${catalogRows}` : '')
        || '<p class="create-bot-msg">没有匹配的角色，可以返回创建新 Bot。</p>';
    } catch (err) {
      if (mySeq === seq) results.innerHTML = `<p class="create-bot-msg">${escapeHtml(err.message || '读取失败')}</p>`;
    } finally { if (mySeq === seq) more.disabled = false; }
  };
  more.addEventListener('click', () => { void search(true); });
  $('libraryImportBotArchive')?.addEventListener('click', () => {
    botArchiveUi?.openImport({ onCreated: async () => { if (results.isConnected) await search(); } });
  });
  $('libraryCatalogFile').addEventListener('change', async event => {
    const file = event.target.files?.[0]; if (!file) return;
    event.target.disabled = true;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('目录文件最多 2 MiB。');
      const catalog = JSON.parse(await file.text());
      await api('/api/dimension/library/catalog', { method: 'POST', body: JSON.stringify({ catalog, baseRevision: directoryRevision }) });
      await search(); catalogMessage.textContent = '目录快照已导入；选择条目可引入为 Bot。';
    } catch (error) { catalogMessage.textContent = error.message || '目录文件读取失败。'; }
    finally { event.target.disabled = false; event.target.value = ''; }
  });
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(search, 200);
  });
  results.addEventListener('click', async (event) => {
    const exportButton = event.target.closest('[data-bot-archive-export]');
    if (exportButton) {
      const selected = ownedBots.find(item => item.id === exportButton.dataset.botArchiveExport);
      if (selected) botArchiveUi?.openExport({ ...selected, name: displayBotName(selected) });
      return;
    }
    const row = event.target.closest('.library-row');
    if (!row || row.dataset.busy === '1' || !results.isConnected || state.shellMode !== mode) return;
    row.dataset.busy = '1';
    row.classList.add('is-busy');
    try {
      if (row.dataset.botId) {
        const bot = ownedBots.find(item => item.id === row.dataset.botId);
        if (!bot) throw new Error('这个 Bot 已不在本地角色库，请重新搜索');
        mergeKnownBots([bot]);
        await addToRoster(bot.id, mode, { reveal: true });
        renderBotList();
        closeModal();
        setModelStatus(`已调入「${displayBotName(bot)}」，原有记忆保留`);
        setTimeout(() => setModelStatus(''), 4000);
        return;
      }
      const data = await api('/api/dimension/library/import', {
        method: 'POST',
        body: JSON.stringify(catalogIdentity(row)),
      });
      if (Array.isArray(data.bots)) replaceKnownBots(data.bots);
      if (data.bot && !state.bots.some((b) => b.id === data.bot.id)) mergeKnownBots([data.bot]);
      // 引入即启用：调出到当前模式。
      if (data.bot?.id) await addToRoster(data.bot.id, mode, { reveal: true });
      renderBotList();
      closeModal();
      setModelStatus(`已从角色库引入「${data.bot?.name || ''}」`);
      setTimeout(() => setModelStatus(''), 4000);
    } catch (err) {
      row.dataset.busy = '';
      row.classList.remove('is-busy');
      setModelStatus(err.message || '引入失败');
    }
  });
  search();
  input.focus();
}

/** Generate an editable draft with the selected model, then save explicitly. */
async function openBotIntro(bot, notice = '') {
  const ticket = bumpUiTicket(), scope = quoteScope(), botId = bot.id;
  const name = bot?.name || '新 bot';
  showModal(`
    <div class="create-bot-body">
      <h2 class="create-bot-title">简单介绍一下「${escapeHtml(name)}」</h2>
      <p class="create-bot-hint">使用这个 Bot 当前选择的模型生成可编辑草稿。生成不会修改原档案；核对正文后再点击保存。</p>
      <textarea id="botIntroText" class="create-bot-intro" maxlength="1000" placeholder="比如：他是我的前端搭子，说话直接，改完代码必跑测试"></textarea>
      <label id="personaDraftLabel" hidden>人设草稿（可编辑）<textarea class="create-bot-intro" id="botIntroResult" rows="10"></textarea></label>
      <div class="create-bot-footer">
        <button type="button" class="create-bot-cancel" data-close>先这样</button>
        <button type="button" class="text-btn" id="cancelPersonaDraft" hidden>取消生成</button>
        <button type="button" class="create-bot-submit" id="genPersonaBtn" disabled>生成人设草稿</button>
        <button type="button" class="create-bot-submit" id="savePersonaDraft" hidden>保存此草稿</button>
      </div>
      <p class="create-bot-msg" id="botIntroMsg" role="status" aria-live="polite"></p>
    </div>`, false, 'create-bot');
  const input = document.getElementById('botIntroText');
  const btn = document.getElementById('genPersonaBtn');
  const msg = document.getElementById('botIntroMsg');
  const result = document.getElementById('botIntroResult');
  const cancel = $('cancelPersonaDraft'), save = $('savePersonaDraft'), label = $('personaDraftLabel');
  const panel = input.closest('.create-bot-body');
  const current = () => isCurrentUi(ticket) && scope === quoteScope() && panel.isConnected && !$('modal').hidden;
  let revision = '', draft = null, busy = false, stale = false, cancelling = false;
  const route = `/api/dimension/bots/${encodeURIComponent(botId)}/persona-gen`;
  const sync = () => {
    btn.disabled = busy || stale || !revision || !input.value.trim();
    input.disabled = busy; cancel.hidden = !busy; cancel.disabled = cancelling;
    save.hidden = draft?.status !== 'ready'; save.disabled = busy || stale || !result.value.trim();
  };
  if (msg) msg.textContent = notice;
  const cancelDraft = async () => {
    if (!draft || !['running', 'cancelling', 'ready'].includes(draft.status)) return;
    cancelling = true; sync();
    try { draft = await api(route + '/' + encodeURIComponent(draft.draftId), { method: 'DELETE' }); }
    catch (error) { if (current()) msg.textContent = error.message; }
  };
  cancel.addEventListener('click', () => { void cancelDraft(); });
  panel.querySelector('[data-close]').addEventListener('click', () => { void cancelDraft(); });
  input.addEventListener('input', sync); result.addEventListener('input', sync);
  btn.addEventListener('click', async () => {
    if (!current() || busy || stale || !revision) return;
    busy = true; cancelling = false; sync(); msg.textContent = '正在生成草稿…';
    try {
      draft = await api(route, {
        method: 'POST', body: JSON.stringify({ brief: input.value.trim(), baseRevision: revision }),
      });
      while (['running', 'cancelling'].includes(draft.status)) {
        if (!current()) { await cancelDraft(); return; }
        msg.textContent = `${cancelling ? '正在取消' : '正在生成'} · ${draft.model}`;
        await new Promise(resolve => setTimeout(resolve, 180));
        draft = await api(route + '/' + encodeURIComponent(draft.draftId));
      }
      if (!current()) return;
      if (draft.status === 'ready') {
        revision = draft.baseRevision; label.hidden = false; result.value = draft.persona;
        msg.textContent = `草稿已生成 · ${draft.model}。尚未保存，可以先修改正文。`;
      } else msg.textContent = draft.status === 'cancelled' ? '生成已取消，原人设未修改。' : draft.error || '生成未完成，原人设未修改。';
    } catch (err) {
      if (err.status === 409) stale = true;
      if (current()) msg.textContent = err.message || '生成失败';
    } finally { busy = false; if (current()) sync(); }
  });
  save.addEventListener('click', async () => {
    if (!current() || busy || stale || draft?.status !== 'ready') return;
    busy = true; sync();
    try {
      const data = await api(route + '/' + encodeURIComponent(draft.draftId) + '/apply', { method: 'POST',
        body: JSON.stringify({ persona: result.value, baseRevision: draft.baseRevision }) });
      if (!current()) return;
      revision = data.profileRevision; draft.status = 'saved'; msg.textContent = '人设草稿已保存到这个 Bot 的档案。';
    } catch (error) {
      if (error.status === 409) stale = true;
      if (current()) msg.textContent = stale ? '原人设已在其他位置修改，当前草稿保留。请关闭并重新打开档案核对。' : error.message;
    } finally { busy = false; if (current()) sync(); }
  });
  try {
    const data = await api(`/api/dimension/persona?botId=${encodeURIComponent(botId)}`);
    if (!current()) return; revision = data.profileRevision; sync();
  } catch (error) { if (current()) msg.textContent = error.message; }
  input.focus();
}

function autoGrow(el) {
  if (!el) return;
  if (!el.value) {
    el.style.height = '36px';
    el.closest('.composer-row')?.classList.remove('is-multiline');
    return;
  }
  el.style.height = '36px';
  const next = Math.min(Math.max(el.scrollHeight, 36), 160);
  el.style.height = `${next}px`;
  el.closest('.composer-row')?.classList.toggle('is-multiline', next > 38);
}

function isImeComposing(event) {
  return Boolean(event.isComposing || event.keyCode === 229 || event.which === 229 || event.target?.dataset.composing === '1');
}

function bindImeGuard(input) {
  if (!input || input.dataset.imeBound === '1') return;
  input.dataset.imeBound = '1';
  input.addEventListener('compositionstart', () => { input.dataset.composing = '1'; });
  input.addEventListener('compositionend', () => {
    requestAnimationFrame(() => { input.dataset.composing = '0'; });
  });
}

function bindStorySubmit(input, submit) {
  bindImeGuard(input);
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || isImeComposing(event)) return;
    event.preventDefault();
    submit();
  });
}

function bindComposerField(input, sendBtn, onSend, { pending } = {}) {
  if (!input) return;
  bindImeGuard(input);
  const busy = () => (typeof pending === 'function' ? pending() : false);
  const sync = () => syncSendEnabled(input, sendBtn, busy());
  input.addEventListener('input', () => {
    autoGrow(input);
    if (input.id === 'composerInput') conversationDrafts.capture(input.value);
    sync();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.keyCode !== 13) return;
    if (isImeComposing(event) || event.altKey || event.shiftKey) return;
    event.preventDefault();
    const hasPayload = Boolean(String(input.value || '').trim()) || Boolean(input.id === 'composerInput' && !isWorkShell() && attachmentDraft().stickers.length);
    if (busy() || (!hasPayload && !(input.id === 'composerInput' && attachmentDraft().images.length))) return;
    onSend();
  });
  autoGrow(input);
  sync();
}

function syncSendEnabled(input, button, pending = false) {
  if (!button) return;
  const hasImages = Boolean(input?.id === 'composerInput' && attachmentDraft().images.length);
  const hasStickers = Boolean(input?.id === 'composerInput' && !isWorkShell() && attachmentDraft().stickers.length);
  button.disabled = Boolean(pending) || (input?.id === 'composerInput' && !hasConversation()) || (!String(input?.value || '').trim() && !hasImages && !hasStickers);
}

const REVIEW_STORAGE_KEY = 'dimension-agent-approval-mode';
const SHELL_MODE_STORAGE_KEY = 'dimension-agent-shell-mode';

function readApprovalMode() {
  try {
    const raw = localStorage.getItem(REVIEW_STORAGE_KEY);
    if (raw === 'full' || raw === 'auto' || raw === 'ask') return raw;
  } catch {}
  return 'auto';
}


function mergeKnownBots(list) {
  if (!Array.isArray(list) || !list.length) return;
  if (state.persistentBotRosters) {
    const records = new Map(state.bots.map(bot => [bot.id, bot]));
    for (const bot of list) if (bot?.id) records.set(bot.id, { ...(records.get(bot.id) || {}), ...bot });
    state.bots = [...records.values()];
    syncNativeBotRosters();
    return;
  }
  const have = new Set((state.bots || []).map((bot) => bot.id));
  for (const bot of list) {
    if (!bot?.id || have.has(bot.id)) continue;
    state.bots = state.bots || [];
    state.bots.push(bot);
    have.add(bot.id);
  }
}

async function ensureMemberBots(ids) {
  const missing = [...new Set((ids || []).filter(Boolean))].filter((id) => !knownBots().some((bot) => bot.id === id));
  if (!missing.length) return;
  try {
    const data = await api(`/api/dimension/bots/lookup?ids=${encodeURIComponent(missing.slice(0, 40).join(','))}`);
    mergeKnownBots(data.bots);
  } catch {}
}

function currentMentionMembers() {
  if (!state.activeGroupId) return [];
  const group = (state.groups || []).find((g) => g.id === state.activeGroupId);
  return (group?.members || []).map((id) => ({ id, name: botNameOf(id) })).filter((m) => m.id);
}

function currentGroup() {
  return (state.groups || []).find((g) => g.id === state.activeGroupId) || null;
}

let workUi = null;
let contextUsageUi = null;
let archiveUi = null;
let archivedWorkUi = null;
let botArchiveUi = null;
let workPendingTimer = 0;

const LAST_EXPORT_DIR_KEY = 'dimension-last-export-dir-v1';

window.__dimensionRevealPath = targetPath => {
  if (!targetPath) return false;
  if (window.chrome?.webview?.postMessage) {
    try {
      window.chrome.webview.postMessage({ source: 'dimension-shell', action: 'reveal-path', path: String(targetPath) });
      return true;
    } catch {}
  }
  return false;
};

window.__dimensionPickFolder = ({ title = '选择保存到电脑的文件夹' } = {}) => {
  if (window.chrome?.webview?.postMessage) {
    return new Promise(resolve => {
      const reqId = `pick-${crypto.randomUUID()}`;
      let done = false;
      const onMsg = event => {
        const msg = event.data;
        if (msg?.source !== 'dimension-shell' || msg.action !== 'picked-folder' || msg.id !== reqId) return;
        done = true;
        window.chrome.webview.removeEventListener('message', onMsg);
        if (msg.cancelled || !msg.path) {
          resolve(null);
          return;
        }
        try { localStorage.setItem(LAST_EXPORT_DIR_KEY, msg.path); } catch {}
        resolve(String(msg.path));
      };
      window.chrome.webview.addEventListener('message', onMsg);
      try {
        window.chrome.webview.postMessage({ source: 'dimension-shell', action: 'pick-folder', id: reqId, title });
      } catch {
        if (!done) {
          window.chrome.webview.removeEventListener('message', onMsg);
          resolve(null);
        }
      }
    });
  }
  let remembered = '';
  try { remembered = localStorage.getItem(LAST_EXPORT_DIR_KEY) || ''; } catch {}
  return window.__dimensionPrompt({
    title,
    message: '请输入本机保存目录的完整路径（例如桌面或下载文件夹）：',
    value: remembered,
    placeholder: '例如 D:\\Downloads',
    confirmLabel: '保存到此目录',
  }).then(val => {
    const clean = val ? String(val).trim() : '';
    if (clean) {
      try { localStorage.setItem(LAST_EXPORT_DIR_KEY, clean); } catch {}
      return clean;
    }
    return null;
  });
};

const RECENT_WORK_CWDS_KEY = 'dimension-recent-work-cwds';

function readRecentWorkCwds() {
  try {
    const arr = JSON.parse(localStorage.getItem(RECENT_WORK_CWDS_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter(x => typeof x === 'string' && x.trim() && !x.startsWith('\\\\')).slice(0, 6) : [];
  } catch {
    return [];
  }
}

function rememberRecentWorkCwd(rawPath) {
  const clean = String(rawPath || '').trim();
  if (!clean || clean.startsWith('\\\\')) return;
  const next = [clean, ...readRecentWorkCwds().filter(p => p.toLowerCase() !== clean.toLowerCase())].slice(0, 6);
  try { localStorage.setItem(RECENT_WORK_CWDS_KEY, JSON.stringify(next)); } catch {}
}

async function applyWorkCwdPath(rawPath) {
  const grp = currentGroup();
  const botId = (isWorkShell() && grp) ? (grp.ownerId || grp.members?.[0] || state.botId) : state.botId;
  if (!botId) return;
  const trimmedPath = String(rawPath || '').trim();
  const data = trimmedPath
    ? await api('/api/dimension/work/pick-cwd', {
        method: 'POST',
        body: JSON.stringify({ botId, path: trimmedPath }),
      })
    : await api('/api/dimension/work/settings', {
        method: 'PATCH',
        body: JSON.stringify({ botId, projectCwd: null }),
      });
  if (trimmedPath && !data?.error) rememberRecentWorkCwd(data?.settings?.projectCwd || trimmedPath);
  if (data?.settings) state.workSettings = data.settings;
  if (data?.settings?.approvalMode) state.approvalMode = data.settings.approvalMode;
  workUi?.sync();
  void workRosterTree?.refresh();
  if (data?.error) messageActionNotice(data.error);
}

async function pickWorkCwd() {
  try {
    const grp = currentGroup();
    const botId = (isWorkShell() && grp) ? (grp.ownerId || grp.members?.[0] || state.botId) : state.botId;
    if (!botId) return;
    if (window.__dimensionPickFolder) {
      const picked = await window.__dimensionPickFolder({ title: '选择本地工作目录' });
      if (picked) {
        await applyWorkCwdPath(picked);
        return;
      }
      if (picked === '') return;
    }
    const current = await api(`/api/dimension/work/settings?botId=${encodeURIComponent(botId)}`);
    const chosen = await window.__dimensionPrompt({
      title: '选择本地工作目录',
      message: '填写本机项目目录完整路径（留空并确认可切换回隔离沙盒）。',
      value: current?.settings?.projectCwd || '',
      placeholder: '例如 D:\\Projects\\my-app',
      allowEmpty: true,
      confirmLabel: '保存目录',
    });
    if (chosen === null || chosen === undefined) return;
    await applyWorkCwdPath(chosen);
  } catch (err) {
    messageActionNotice(`选择工作目录失败：${err.message}`);
  }
}

async function handleWorkFiles(files) {
  if (!isWorkShell()) return;
  const all = [...(files || [])];
  const imgFiles = all.filter(f => f && String(f.type || '').startsWith('image/'));
  const otherFiles = all.filter(f => f && !String(f.type || '').startsWith('image/'));
  if (imgFiles.length && window.__dimensionHandleComposerImages) {
    await window.__dimensionHandleComposerImages(imgFiles);
  }
  if (!otherFiles.length) return;
  if (!state.workSettings?.projectCwd) {
    addBubble('assistant', '文本/代码附件需先绑定本地工作目录；图片可直接粘贴或拖入发送。', '系统');
    return;
  }
  for (const file of otherFiles) {
    const name = file.name || 'attachment';
    try {
      const text = await readWorkFile(file);
      const data = await api('/api/dimension/work/attachments', {
        method: 'POST',
        body: JSON.stringify({ botId: state.botId, name, content: text }),
      });
      if (!data?.ok) throw new Error(data?.error || '附件未受理');
      const tool = await api('/api/dimension/work/tools', {
        method: 'POST',
        body: JSON.stringify({
          botId: state.botId,
          tool: 'write',
          path: data.path,
          content: text,
        }),
      });
      if (tool?.pending) {
        addBubble('assistant', `附件「${name}」待批准后写入项目根 incoming。`, '系统');
        refreshWorkPending();
      } else if (tool?.ok) {
        addBubble('assistant', `已写入 ${tool.path || data.path}`, '系统');
      } else {
        addBubble('assistant', tool?.error || `附件「${name}」未写入`, '系统');
      }
    } catch (err) {
      addBubble('assistant', `附件「${name}」失败：${err.message}`, '系统');
    }
  }
}

function readWorkFile(file) {
  if (file.size > 512 * 1024) {
    return Promise.reject(new Error('附件超过 512KB，请拆分后添加'));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读不了这个文件'));
    reader.readAsText(file);
  });
}

async function refreshWorkPending() {
  if (!hasConversation()) { workUi?.renderPending([]); workSession?.presentPending?.([]); return; }
  if (!isWorkShell() && !state.activeWorkRun) return;
  try {
    const data = await api(`/api/dimension/work/pending?botId=${encodeURIComponent(state.activeWorkBotId || state.botId || '')}`);
    const rows = data.pending || data.items || data.list || [];
    state.pendingApprovals = Array.isArray(rows) ? rows : [];
    const inTalk = Boolean(isWorkShell() && workSession?.presentPending?.(state.pendingApprovals, {
      onDecide: (id, allow, botId) => decideWorkPending(id, allow, botId),
      onAuto: async (id, botId) => {
        await writeApprovalMode('auto', botId);
        if (id) await decideWorkPending(id, true, botId);
      },
    }));
    workUi?.renderPending(inTalk ? [] : state.pendingApprovals);
  } catch {
    /* 后端未就绪时不占位 */
  }
}

async function decideWorkPending(id, allow, botId) {
  if (!id) return;
  try {
    const result = await api(`/api/dimension/work/pending/${encodeURIComponent(id)}/decision`, {
      method: 'POST',
      body: JSON.stringify({ allow: Boolean(allow), botId: botId || state.activeWorkBotId || state.botId }),
    });
    if (result?.ok === false) throw new Error(result.error || result.result?.error || '操作未执行');
  } catch (err) {
    addBubble('assistant', `审核失败：${err.message}`, '系统');
  }
  await refreshWorkPending();
}

async function writeApprovalMode(mode, botId) {
  const next = (mode === 'full' || mode === 'auto' || mode === 'ask') ? mode : 'auto';
  // 群任务里审批请求可能来自非当前伙伴：只改发起请求的那位，并且不覆盖当前伙伴的显示状态
  const target = botId || state.botId;
  const isCurrent = target === state.botId;
  try {
    const data = await api('/api/dimension/work/settings', {
      method: 'PATCH', body: JSON.stringify({ botId: target, approvalMode: next }),
    });
    if (isCurrent) {
      state.workSettings = data.settings;
      state.approvalMode = data.settings.approvalMode;
      try { localStorage.setItem(REVIEW_STORAGE_KEY, state.approvalMode); } catch {}
    }
  } catch (err) { addBubble('assistant', `审核设置未保存：${err.message}`, '系统'); }
  syncReviewEntry();
}

function readShellMode() {
  try {
    const raw = localStorage.getItem(SHELL_MODE_STORAGE_KEY);
    if (raw === 'work' || raw === 'chat' || raw === 'playground') return raw;
  } catch {}
  return 'chat';
}

function isWorkShell() {
  return state.shellMode === 'work';
}

function isPlaygroundShell() {
  return state.shellMode === 'playground';
}

function shellModeLabel(mode = state.shellMode) {
  if (mode === 'work') return 'Work';
  if (mode === 'playground') return 'Playground';
  return 'Chat';
}

function syncModeSwitch() {
  const btn = $('modeSwitch');
  const label = shellModeLabel();
  if (btn) {
    btn.textContent = label;
    btn.setAttribute('aria-label', `切换模式，当前：${label}`);
  }
  const caption = $('sidebarModeCaption');
  if (caption) {
    caption.textContent = state.shellMode === 'work'
      ? '委托与共创'
      : state.shellMode === 'playground'
        ? '游戏伴玩库'
        : '伙伴与茶会';
  }
  const seg = $('modeSegPill');
  if (seg) {
    seg.querySelectorAll('[data-shell-target]').forEach(tab => {
      const active = tab.dataset.shellTarget === state.shellMode;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-pressed', String(active));
    });
  }
}

function setShellMode(mode, { restoreSelection = true } = {}) {
  closeMessageMenu();
  const next = mode === 'work' ? 'work' : (mode === 'playground' ? 'playground' : 'chat'), changed = next !== state.shellMode;
  if (changed) {
    state.historyAbort?.abort(); state.groupAbort?.abort(); state.groupUpdates?.close(); state.groupUpdates = null;
    state.chatHistoryTicket = (state.chatHistoryTicket || 0) + 1; state.groupLoadTicket = (state.groupLoadTicket || 0) + 1;
    workSession.close(); state.activeGroupId = null; state.soloWork = false;
    state.savedChatNodes = null; state.savedPreGroupNodes = null; state.savedPreGroupSelection = null;
    state.nextBotId = null; setGroupQuote(null);
    state.shellMode = next;
  }
  try { localStorage.setItem(SHELL_MODE_STORAGE_KEY, state.shellMode); } catch {}
  $('app')?.classList.toggle('is-work-shell', isWorkShell());
  $('app')?.classList.toggle('is-playground-shell', isPlaygroundShell());
  syncStickerDraft();syncSendEnabled($('composerInput'),$('sendBtn'));
  if (isPlaygroundShell()) {
    closeReviewMenu();
    closeBotContextMenu();
    if ($('drawer') && !$('drawer').hidden) openDrawer(false);
    workDock?.clear();
    syncReviewEntry();
    syncModeSwitch();
    workUi?.sync();
    workUi?.renderPending([]);
    playgroundUi?.activate();
    return;
  }
  playgroundUi?.deactivate();
  if (!isWorkShell()) {
    closeReviewMenu();
    workDock?.clear();
  } else {
    void workRosterTree?.refresh();
  }
  closeBotContextMenu();
  syncReviewEntry();
  syncModeSwitch();
  renderBotList();
  if (changed && state.bootstrapped && restoreSelection) {
    let selected = state.selections[state.shellMode];
    if (!selected && state.shellMode === 'work' && state.selections.chat?.kind === 'bot') {
      selected = { ...state.selections.chat };
      state.selections.work = selected;
    }
    if (selected?.kind === 'group' && groupRosterIds().has(selected.id)) openGroup(selected.id, { keepNotice: true }).catch(() => {});
    else if (selected?.kind === 'bot' && knownBots().some(bot => bot.id === selected.id)) void activateBot(selected.id);
    else { state.selections[state.shellMode] = null; showConversationWelcome(); }
  } else if (!hasConversation()) showConversationWelcome();
  workUi?.sync();
  if (isWorkShell()) refreshWorkPending();
  else workUi?.renderPending([]);
}

function isReviewMenuOpen() {
  const menu = $('reviewMenu');
  return Boolean(menu && !menu.hidden);
}

function placeReviewMenu() {
  const btn = $('reviewBtn');
  const menu = $('reviewMenu');
  if (!btn || !menu || menu.hidden) return;
  const gap = 8;
  const rect = btn.getBoundingClientRect();
  const menuHeight = menu.offsetHeight;
  const menuWidth = menu.offsetWidth || 280;
  let left = rect.left;
  let top = rect.top - gap - menuHeight;
  if (top < 8) top = rect.bottom + gap;
  const maxLeft = Math.max(8, window.innerWidth - menuWidth - 8);
  left = Math.min(Math.max(8, left), maxLeft);
  const maxTop = Math.max(8, window.innerHeight - menuHeight - 8);
  top = Math.min(Math.max(8, top), maxTop);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function closeReviewMenu() {
  const menu = $('reviewMenu');
  const btn = $('reviewBtn');
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
  syncReviewEntry();
}

function openReviewMenu() {
  if (!isWorkShell()) return;
  const menu = $('reviewMenu');
  const btn = $('reviewBtn');
  if (!menu || !btn) return;
  closeBotContextMenu();
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  syncReviewEntry();
  placeReviewMenu();
}

function toggleReviewMenu() {
  if (isReviewMenuOpen()) closeReviewMenu();
  else openReviewMenu();
}

function syncReviewEntry() {
  const btn = $('reviewBtn');
  const menu = $('reviewMenu');
  if (!btn) return;
  const work = isWorkShell();
  btn.hidden = !work;
  if (!work && menu && !menu.hidden) menu.hidden = true;
  const mode = state.approvalMode || 'auto';
  const reviewing = mode !== 'full' || (btn.getAttribute('aria-expanded') === 'true');
  btn.classList.toggle('is-review', reviewing);
  if (menu) {
    menu.querySelectorAll('.review-option').forEach((item) => {
      const on = item.dataset.mode === mode;
      item.classList.toggle('is-active', on);
      item.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }
}

function bindReviewEntry() {
  const btn = $('reviewBtn');
  const menu = $('reviewMenu');
  if (!btn || !menu || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  state.approvalMode = readApprovalMode();
  setShellMode(readShellMode());
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleReviewMenu();
  });
  menu.querySelectorAll('.review-option').forEach((item) => {
    item.addEventListener('click', (event) => {
      event.preventDefault();
      writeApprovalMode(item.dataset.mode);
      closeReviewMenu();
    });
  });
  document.addEventListener('pointerdown', (event) => {
    if (!isReviewMenuOpen()) return;
    if (event.target.closest('#reviewMenu, #reviewBtn')) return;
    closeReviewMenu();
  });
  window.addEventListener('resize', () => { if (isReviewMenuOpen()) placeReviewMenu(); });
  window.visualViewport?.addEventListener('resize', () => { if (isReviewMenuOpen()) placeReviewMenu(); });
  window.visualViewport?.addEventListener('scroll', () => { if (isReviewMenuOpen()) placeReviewMenu(); });
}

function bumpUiTicket() {
  state.uiTicket += 1;
  return state.uiTicket;
}

function isCurrentUi(ticket) {
  return ticket === state.uiTicket;
}

const DRAWER_TRANSITION_MS = 220;
let drawerCloseTimer = 0;

function isDrawerOpen() {
  const drawer = $('drawer');
  return Boolean(drawer && !drawer.hidden);
}

function isDrawerVisiblyOpen() {
  return isDrawerOpen() && !state.drawerClosing;
}

function isModalOpen() {
  return !$('modal').hidden;
}

function viewportWidth() {
  return window.visualViewport?.width || window.innerWidth;
}

function railDrawerWidth() {
  return Math.round(Math.min(340, viewportWidth() * 0.4));
}

function prefersOverlayDrawer() {
  const sidebar = $('sidebar');
  const sidebarW = Math.max(0, Math.round(sidebar?.getBoundingClientRect().width || 260));
  return (viewportWidth() - sidebarW - railDrawerWidth()) < 480;
}

function syncIdentityLabels() {
  const btn = $('identityBtn');
  if (!btn) return;
  const open = isDrawerVisiblyOpen();
  const label = open ? '关闭详细栏' : '打开详细栏';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function cancelDrawerCloseTimer() {
  if (drawerCloseTimer) {
    clearTimeout(drawerCloseTimer);
    drawerCloseTimer = 0;
  }
  state.drawerClosing = false;
}

let chatColumnPulse = 0;

function syncChatColumn() {
  const shell = document.querySelector('.main-shell');
  if (!shell) return;
  const width = Math.max(0, Math.round(shell.getBoundingClientRect().width));
  shell.style.setProperty('--chat-area-width', `${width}px`);
}

function pulseChatColumn(ms = 280) {
  const started = performance.now();
  if (chatColumnPulse) cancelAnimationFrame(chatColumnPulse);
  const step = (now) => {
    syncChatColumn();
    if (now - started < ms) chatColumnPulse = requestAnimationFrame(step);
    else chatColumnPulse = 0;
  };
  chatColumnPulse = requestAnimationFrame(step);
}

function syncDrawerLayout() {
  const workspace = $('workspace');
  if (!workspace) return;
  const open = isDrawerOpen();
  const closing = Boolean(state.drawerClosing);
  const overlay = open && !closing && prefersOverlayDrawer();
  const rail = open && !overlay;
  workspace.classList.toggle('drawer-overlay', overlay);
  workspace.classList.toggle('drawer-rail', rail);
  workspace.classList.toggle('drawer-closing', closing);
  if (overlay || !open) {
    workspace.style.setProperty('--drawer-rail-width', '0px');
  } else if (closing) {
    workspace.style.setProperty('--drawer-rail-width', '0px');
  } else {
    workspace.style.setProperty('--drawer-rail-width', `${railDrawerWidth()}px`);
  }
  syncBackdrop();
  syncWindowChrome();
  pulseChatColumn();
}

function syncBackdrop() {
  const modal = isModalOpen();
  const overlayDrawer = isDrawerVisiblyOpen() && prefersOverlayDrawer();
  const backdrop = $('backdrop');
  if (backdrop) {
    backdrop.hidden = !(overlayDrawer || modal);
    backdrop.classList.toggle('is-front', modal);
  }
  syncIdentityLabels();
}

function suppressClickThrough() {
  const drawer = $('drawer');
  drawer.classList.add('ignore-clicks');
  if (state.ignoreClickTimer) clearTimeout(state.ignoreClickTimer);
  state.ignoreClickTimer = setTimeout(() => {
    drawer.classList.remove('ignore-clicks');
    state.ignoreClickTimer = 0;
  }, 280);
}

function openDrawer(open) {
  if (open) workDock?.close(false);
  if (open && state.activeGroupId) setTimeout(() => renderGroupDrawer().catch(() => {}), 0);
  const drawer = $('drawer');
  const workspace = $('workspace');
  if (!drawer) return;
  if (open) {
    const wasHidden = drawer.hidden || state.drawerClosing;
    cancelDrawerCloseTimer();
    const useOverlay = prefersOverlayDrawer();
    if (wasHidden && !useOverlay && workspace) {
      workspace.classList.add('drawer-rail');
      workspace.classList.remove('drawer-overlay');
      workspace.style.setProperty('--drawer-rail-width', '0px');
      drawer.hidden = false;
      renderDrawerSeal();
      syncBackdrop();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!isDrawerOpen() || state.drawerClosing) return;
          syncDrawerLayout();
        });
      });
      return;
    }
    drawer.hidden = false;
    renderDrawerSeal();
    syncDrawerLayout();
    return;
  }
  bumpUiTicket();
  if (!isDrawerOpen() && !state.drawerClosing) {
    syncDrawerLayout();
    return;
  }
  const closingRail = Boolean(workspace?.classList.contains('drawer-rail')) && !prefersOverlayDrawer();
  if (!closingRail) {
    cancelDrawerCloseTimer();
    drawer.hidden = true;
    syncDrawerLayout();
    return;
  }
  if (drawerCloseTimer) clearTimeout(drawerCloseTimer);
  state.drawerClosing = true;
  syncDrawerLayout();
  drawerCloseTimer = setTimeout(() => {
    drawerCloseTimer = 0;
    state.drawerClosing = false;
    drawer.hidden = true;
    syncDrawerLayout();
  }, DRAWER_TRANSITION_MS);
}

function closeModal() {
  bumpUiTicket();
  if (typeof writeSetupWizardDraft === 'function' && setupWizard) writeSetupWizardDraft();
  const modal = $('modal');
  const backdrop = $('backdrop');
  if (modal?.hasAttribute('popover')) {
    try { modal.hidePopover(); } catch {}
    modal.removeAttribute('popover');
  }
  if (backdrop?.hasAttribute('popover')) {
    try { backdrop.hidePopover(); } catch {}
    backdrop.removeAttribute('popover');
  }
  modal.hidden = true;
  modal.classList.remove('wide', 'create-bot', 'create-group', 'key-settings', 'paper-prompt', 'setup-wizard');
  if (modal.dataset.extraClass) { modal.classList.remove(modal.dataset.extraClass); modal.dataset.extraClass = ''; }
  backdrop?.classList.remove('is-key-settings', 'is-create-group');
  modal.innerHTML = '';
  state.backdropArmed = false;
  if (isDrawerOpen()) suppressClickThrough();
  syncBackdrop();
  if (modalReturnFocus?.isConnected) modalReturnFocus.focus({ preventScroll: true });
  modalReturnFocus = null;
}

function showModal(html, wide = false, extraClass = '') {
  const modal = $('modal');
  const backdrop = $('backdrop');
  modal.classList.remove('wide', 'create-bot', 'create-group', 'key-settings', 'paper-prompt', 'setup-wizard');
  if (modal.dataset.extraClass) modal.classList.remove(modal.dataset.extraClass);
  backdrop?.classList.remove('is-key-settings', 'is-create-group');
  modal.classList.toggle('wide', wide);
  if (extraClass) modal.classList.add(extraClass);
  modal.dataset.extraClass = extraClass || '';
  if (extraClass === 'create-group') backdrop?.classList.add('is-create-group');
  // 记住打开前的焦点，关闭时还原；打开后把焦点移入弹窗
  if (modal.hidden && document.activeElement instanceof HTMLElement && !modal.contains(document.activeElement)) {
    modalReturnFocus = document.activeElement;
  }
  modal.innerHTML = html;
  modal.hidden = false;
  state.backdropArmed = false;
  syncBackdrop();
  if (document.querySelector('dialog[open]') && typeof modal.showPopover === 'function') {
    if (backdrop && !backdrop.hidden) {
      backdrop.setAttribute('popover', 'manual');
      try { backdrop.showPopover(); } catch {}
    }
    modal.setAttribute('popover', 'manual');
    try { modal.showPopover(); } catch {}
  }
  const heading = modal.querySelector('h1, h2, h3');
  if (heading) { heading.id ||= 'modalTitle'; modal.setAttribute('aria-labelledby', heading.id); }
  else modal.removeAttribute('aria-labelledby');
  requestAnimationFrame(() => {
    if (modal.hidden || modal.contains(document.activeElement)) return;
    const target = modal.querySelector('[autofocus], input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled])')
      || modal.querySelector('button:not([data-close]):not([disabled]), [href]')
      || modal.querySelector('button');
    target?.focus({ preventScroll: true });
  });
}
let modalReturnFocus = null;

function closeTopLayer() {
  if (isModalOpen()) closeModal();
  else if (isDrawerOpen()) openDrawer(false);
}

async function openPersona() {
  const ticket = bumpUiTicket();
  const botId = state.botId;
  const botName = state.botName;
  const path = `/api/dimension/persona?botId=${encodeURIComponent(botId)}`;
  // 人设弹窗只编人设；Chat 与 Work 继续读取同一个 Bot 档案。
  const data = await api(path);
  const history = data.profileRevision
    ? await api(`/api/dimension/persona/revisions?botId=${encodeURIComponent(botId)}&limit=20`).catch(() => ({ revisions: [] }))
    : { revisions: [] };
  if (!isCurrentUi(ticket) || state.botId !== botId) return;
  const fieldMarkup = (data.fields || []).map((field) => `
    <div class="field">
      <label for="persona-${escapeHtml(field.key)}">${escapeHtml(field.title)}</label>
      <textarea id="persona-${escapeHtml(field.key)}" data-key="${escapeHtml(field.key)}" rows="8">${escapeHtml(field.content)}</textarea>
    </div>`).join('');
  const tarot = window.DimensionTarot;
  const tarotStageHtml = tarot ? tarot.renderPersonaStageHTML(botId, data.character?.name || botName) : '';
  showModal(`
    <div class="modal-head">
      <h2>自我 · ${escapeHtml(data.character?.name || botName)}</h2>
      <button type="button" class="icon-btn" data-close>关闭</button>
    </div>
    <div class="modal-body">
      ${tarotStageHtml}
      <div id="personaEditor">${fieldMarkup}</div>
      <section id="personaPreview" class="persona-diff-list" aria-label="人设修改前后差异" hidden></section>
      <div class="persona-actions">
        <button type="button" class="send-btn" id="savePersona">预览并保存</button>
        <button type="button" class="send-btn" id="confirmPersonaSave" hidden>确认保存</button>
        <button type="button" class="text-btn" id="cancelPersonaPreview" hidden>返回编辑</button>
        ${data.profileRevision ? '<button type="button" class="text-btn" id="draftPersona">生成可编辑人设草稿</button>' : ''}
      </div>
      <p class="muted" id="personaMsg" role="status" aria-live="polite">保存前会显示前后差异；Chat 与 Work 共用此档案。</p>
      <section class="persona-revisions" id="personaRevisions">
        <h3>历史版本</h3>
        <p class="muted">每次保存都会保留上一版。恢复也会新增修订记录，不会覆盖或删除历史。</p>
        <div class="persona-revision-list" id="personaRevisionList"></div>
      </section>
    </div>`, true);
  const button = $('savePersona'), confirmButton = $('confirmPersonaSave'), cancelButton = $('cancelPersonaPreview');
  const modalRoot = $('modal');
  if (tarot && modalRoot) {
    tarot.mountInteractiveCards(modalRoot, { maxRy: 22, maxRx: 16 });
    modalRoot.querySelectorAll('[data-tarot-inspect]').forEach((el) => {
      el.addEventListener('click', () => tarot.openLightbox(el.dataset.tarotInspect));
    });
    modalRoot.querySelectorAll('[data-tarot-open-gallery]').forEach((el) => {
      el.addEventListener('click', () => openTarotGalleryWithSwitch());
    });
  }
  const message = $('personaMsg'), editor = $('personaEditor'), preview = $('personaPreview'), revisionsSection = $('personaRevisions');
  const areas = [...document.querySelectorAll('#modal textarea[data-key]')];
  const valuesOf = fields => Object.fromEntries((fields || []).map(field => [field.key, field.content ?? '']));
  const editorValues = () => Object.fromEntries(areas.map(area => [area.dataset.key, area.value]));
  let original = valuesOf(data.fields), revisions = history.revisions || [];
  let profileRevision = data.profileRevision, profileStale = false, pending = null, busy = false;

  const current = () => isCurrentUi(ticket) && state.botId === botId && button.isConnected;
  const renderRevisions = () => {
    const list = $('personaRevisionList');
    if (!list) return;
    list.innerHTML = revisions.length ? revisions.map((revision, index) => {
      const time = new Date(Number(revision.createdAtMs));
      const label = revision.action === 'restore' ? '恢复前版本' : '保存前版本';
      return `<div class="persona-revision-item">
        <div class="persona-revision-meta"><strong>${index === 0 ? '上一版 · ' : ''}${label} #${escapeHtml(revision.revisionId)}</strong>
          ${escapeHtml(Number.isFinite(time.getTime()) ? time.toLocaleString('zh-CN') : revision.createdAtMs)}${revision.restoredRevisionId && revision.restoredRevisionId !== '0' ? ` · 恢复自 #${escapeHtml(revision.restoredRevisionId)}` : ''}</div>
        <button type="button" class="text-btn" data-persona-restore="${escapeHtml(revision.revisionId)}" ${profileStale ? 'disabled' : ''}>预览并恢复</button>
      </div>`;
    }).join('') : '<p class="muted">第一次修改保存后，可在这里恢复上一版。</p>';
  };
  const showEdit = () => {
    pending = null; preview.hidden = true; preview.innerHTML = ''; editor.hidden = false; revisionsSection.hidden = false;
    button.hidden = false; confirmButton.hidden = true; cancelButton.hidden = true;
    if ($('draftPersona')) $('draftPersona').hidden = false;
    button.disabled = profileStale || busy; confirmButton.disabled = busy; cancelButton.disabled = busy;
    renderRevisions();
  };
  const showPreview = next => {
    const before = next.type === 'save' ? original : editorValues();
    const changed = (data.fields || []).filter(field => before[field.key] !== next.values[field.key]);
    if (!changed.length) { message.textContent = '五栏内容没有变化，无需保存或恢复。'; return; }
    pending = next;
    preview.innerHTML = `<p class="persona-diff-intro">${next.type === 'save' ? '确认后才会保存。' : '确认后会恢复为该版本，并保留当前版本供再次恢复。'}共修改 ${changed.length} 栏，其余 ${(data.fields || []).length - changed.length} 栏不变。</p>
      ${changed.map(field => `<article class="persona-diff-field" data-diff-key="${escapeHtml(field.key)}"><h3>${escapeHtml(field.title)}</h3>
        <div class="persona-inline-diff" data-inline-diff="${escapeHtml(field.key)}"></div>
        <details class="persona-raw-details"><summary>展开完整前后对照原文</summary>
        <div class="persona-diff-columns"><section><h4>修改前</h4><pre>${escapeHtml(before[field.key] || '') || '<span class="persona-diff-empty">（空）</span>'}</pre></section>
        <section class="persona-diff-after"><h4>${next.type === 'save' ? '修改后' : '恢复后'}</h4><pre>${escapeHtml(next.values[field.key] || '') || '<span class="persona-diff-empty">（空）</span>'}</pre></section></div>
        </details>
      </article>`).join('')}`;
    for (const field of changed) {
      const slot = preview.querySelector(`[data-inline-diff="${CSS.escape(field.key)}"]`);
      if (slot) slot.append(createChangeDiff(before[field.key] || '', next.values[field.key] || ''));
    }
    editor.hidden = true; revisionsSection.hidden = true; preview.hidden = false;
    button.hidden = true; if ($('draftPersona')) $('draftPersona').hidden = true; confirmButton.hidden = false; cancelButton.hidden = false;
    confirmButton.textContent = next.type === 'save' ? '确认保存' : '确认恢复';
    confirmButton.disabled = false; cancelButton.disabled = false;
    message.textContent = next.type === 'save' ? '尚未保存，请核对前后差异。' : '尚未恢复，请核对前后差异。';
    confirmButton.focus();
  };

  $('draftPersona')?.addEventListener('click', () => { void openBotIntro({ id: botId, name: data.character?.name || botName }); });
  button.addEventListener('click', () => {
    if (!current() || profileStale || busy) return;
    showPreview({ type: 'save', values: editorValues() });
  });
  cancelButton.addEventListener('click', () => { if (!busy) { showEdit(); message.textContent = '已返回编辑，修改尚未写入。'; } });
  $('personaRevisionList').addEventListener('click', event => {
    const target = event.target.closest('[data-persona-restore]');
    if (!target || profileStale || busy) return;
    const revision = revisions.find(row => row.revisionId === target.dataset.personaRestore);
    if (revision) showPreview({ type: 'restore', revisionId: revision.revisionId, values: valuesOf(revision.fields) });
  });
  confirmButton.addEventListener('click', async () => {
    if (!current() || !pending || busy || profileStale) return;
    busy = true; confirmButton.disabled = true; cancelButton.disabled = true;
    const submitted = pending;
    try {
      const saved = submitted.type === 'save'
        ? await api(path, { method: 'POST', body: JSON.stringify({ values: submitted.values, baseRevision: profileRevision }) })
        : await api(`/api/dimension/persona/restore?botId=${encodeURIComponent(botId)}`, {
            method: 'POST', body: JSON.stringify({ baseRevision: profileRevision, revisionId: submitted.revisionId }) });
      if (!current()) return;
      profileRevision = saved.profileRevision || profileRevision;
      original = valuesOf(saved.fields);
      for (const area of areas) area.value = original[area.dataset.key] ?? '';
      busy = false; showEdit();
      message.textContent = submitted.type === 'save'
        ? (profileRevision ? '已保存。上一版已保留，Chat 与 Work 将使用同一人设。' : '已保存。')
        : '已恢复为新修订。恢复前版本也已保留，Chat 与 Work 将使用同一人设。';
      if (profileRevision) try {
        const refreshed = await api(`/api/dimension/persona/revisions?botId=${encodeURIComponent(botId)}&limit=20`);
        if (current()) { revisions = refreshed.revisions || []; renderRevisions(); }
      } catch { if (current()) message.textContent += ' 历史列表暂未刷新，重新打开可读取。'; }
    } catch (err) {
      busy = false;
      if (err.status === 409) profileStale = true;
      if (current()) {
        message.textContent = err.message;
        message.setAttribute('role', 'alert');
        confirmButton.disabled = profileStale;
        cancelButton.disabled = false;
      }
    }
  });
  renderRevisions();
}

function visibleMemoryItems(list) {
  return Array.isArray(list) ? list : [];
}

function episodeMeta(entry) {
  if (entry.kind !== 'episode') return '';
  const time = new Date(Number(entry.eventTimeMs));
  return `<p class="muted">共同经历 · ${escapeHtml(Number.isFinite(time.getTime()) ? time.toLocaleString('zh-CN') : String(entry.eventTimeMs))}<br>参与者：${escapeHtml(entry.participants || '未注明')}<br>用户选择：${escapeHtml(entry.userChoice || '未注明')}<br>结果：${escapeHtml(entry.outcome || '未注明')}<br>来源：${escapeHtml(entry.sourceRef || '未注明')}</p>`;
}

function memoryCard(entry, kind) {
  const recallEnabled = entry.recallEnabled !== false;
  const recallBar = kind === 'entry'
    ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px">
         <span class="muted">${recallEnabled ? '当前参与对话召回' : '已暂停召回（原文保留，不传给模型）'}</span>
         <button type="button" class="text-btn" data-toggle-recall="${escapeHtml(entry.id || '')}" data-recall-next="${recallEnabled ? '0' : '1'}">${recallEnabled ? '暂停召回' : '恢复召回'}</button>
       </div>`
    : '';
  return `<article class="memory-card" data-id="${escapeHtml(entry.id || '')}" data-kind="${kind}">
    <textarea>${escapeHtml(entry.text || '')}</textarea>
    <p class="muted">${escapeHtml((entry.tags || []).join(' · '))}</p>
    ${episodeMeta(entry)}
    ${recallBar}
  </article>`;
}

async function saveMidEdits(botId) {
  const mid = [...document.querySelectorAll('#modal .memory-card[data-kind="mid"]')].map((card) => {
    const box = card.querySelector('textarea');
    return { id: card.dataset.id, text: box ? box.value : '' };
  }).filter((item) => item.id);
  if (!mid.length) return;
  await api(`/api/dimension/memory?botId=${encodeURIComponent(botId)}`, { method: 'POST', body: JSON.stringify({ action: 'save-mid', mid, botId }) });
}

function midSection(data) {
  const mid = visibleMemoryItems(data.mid || data.midterm || []);
  if (data.midMemoryVersion === 1) return `<section id="midMemorySection">
    <h3>中期记忆</h3>
    <p class="muted">手动记录，默认有效 7 天。到期后停止召回，原文仍保留；修改正文不续期，也不会自动转为长期记忆。</p>
    <div id="midMemoryEntries">${mid.map(midMemoryCard).join('') || '<p class="muted">还没有中期记忆。</p>'}</div>
    <p class="muted">清空正文后保存会删除该条。每次最多保存 100 条修改；每次延长 1–30 天，最远可延至未来 90 天。</p>
    <button type="button" class="send-btn" id="saveMidMemory">保存中期正文</button>
    <div class="field"><label for="newMidMemory">新增中期记忆</label><textarea id="newMidMemory" rows="3" placeholder="例如：本周五需要一起确认的事项"></textarea></div>
    <label for="newMidDays">有效天数</label> <select id="newMidDays">${midDayOptions()}</select>
    <button type="button" class="text-btn" id="addMidMemory">新增中期记忆</button>
    <p class="muted" id="midMemoryMsg" role="status" aria-live="polite"></p>
  </section>`;
  if (!mid.length) return '';
  return `<h3>中期记忆</h3>${mid.map((item) => memoryCard(item, 'mid')).join('')}`;
}

function midDayOptions() {
  return Array.from({ length: 30 }, (_, i) => `<option value="${i + 1}"${i === 6 ? ' selected' : ''}>${i + 1} 天${i === 6 ? '（默认）' : ''}</option>`).join('');
}

function midMemoryCard(item) {
  const expiry = new Date(Number(item.expiresAtMs));
  const expires = Number.isFinite(expiry.getTime()) ? expiry.toLocaleString('zh-CN') : String(item.expiresAtMs);
  return `<article class="memory-card" data-id="${escapeHtml(String(item.id))}" data-kind="mid">
    <label>中期记忆 #${escapeHtml(String(item.id))}<textarea aria-label="中期记忆正文 #${escapeHtml(String(item.id))}">${escapeHtml(item.text || '')}</textarea></label>
    <p class="muted">${item.expired ? '已过期 · 不参与召回' : '有效 · 可参与召回'} · 到期：${escapeHtml(expires)} · 强度 ${escapeHtml(String(item.strength))} · 用户手动记录</p>
    <label>延长天数 <select data-mid-days>${midDayOptions()}</select></label>
    <button type="button" class="text-btn" data-mid-extend>延长并强化</button>
  </article>`;
}

/** 保存的历史不等于单次模型输入；窗口设置不会删除历史。 */
async function openContext() {
  const ticket = bumpUiTicket();
  const botId = state.botId, botName = state.botName;
  const { showContextHistory } = await import('./conversation-services-ui.js');
  await showContextHistory({
    api, showModal, escapeHtml, botId, botName,
    isCurrent: () => isCurrentUi(ticket) && state.botId === botId,
    onSettings: () => { closeModal(); window.__dimensionOpenClientSettings?.(); },
  });
}

const RELATION_FIELDS = [
  { key: 'user-profile', title: '关于用户', description: '记录用户的信息、偏好和明确分享的情况。', placeholder: '用户明确分享的资料、偏好与背景；未知时留空。' },
  { key: 'user-relationship', title: '与用户的关系', description: '记录本 Bot 与用户在交流中逐步形成的了解和关系；不预设关系。', placeholder: '从真实交流中逐步了解用户；没有记录时留空，不预设熟悉程度或关系。' },
  { key: 'contacts', title: '联系人及关系', description: '记录本应用中的其他 Bot，以及跨平台的人类联系人及其关系。', placeholder: '本应用里的其他 Bot、跨平台的人类联系人及其关系。' },
  { key: 'external-bots', title: '认识的外部Bot', description: '记录在其他 Agent 平台认识的 Bot，以及与它们的关系。', placeholder: '其他 Agent 平台中的 Bot 名称、平台及交流关系。' },
];

function relationFields(data) {
  return (Array.isArray(data.overview?.relations) ? data.overview.relations : []).map(item => {
    const definition = RELATION_FIELDS.find(field => field.key === item.key);
    return { ...item, ...(definition || {}), content: typeof item.content === 'string' ? item.content : '' };
  });
}

async function openMemory() {
  const ticket = bumpUiTicket();
  const botId = state.botId, botName = state.botName;
  const groupId = state.activeGroupId || '';
  const path = `/api/dimension/memory?botId=${encodeURIComponent(botId)}&groupId=${encodeURIComponent(groupId)}`;
  const data = await api(path);
  if (!isCurrentUi(ticket) || state.botId !== botId) return;
  let memoryRevision = data.revision;
  let memoryEntries = visibleMemoryItems(data.entries);
  let memoryCandidates = visibleMemoryItems(data.candidates);
  const paginated = data.pagination === true;
  let pageBefore = data.before, hasMoreMemory = data.hasMore === true;
  const loadedMemories = new Map([...memoryEntries.map(item => [String(item.id), { ...item, state: 'confirmed' }]),
    ...memoryCandidates.map(item => [String(item.id), { ...item, state: 'candidate' }])]);
  let relationRevision = data.overview?.relationRevision;
  const nativeRelations = typeof relationRevision === 'string';
  const relationItems = relationFields(data);
  let midItems = visibleMemoryItems(data.mid || data.midterm || []);
  const nativeMid = data.midMemoryVersion === 1;
  const entries = memoryEntries.map((item) => memoryCard(item, 'entry')).join('')
    || (midItems.length ? '' : '<p class="muted">还没有长期记忆条目。</p>');
  const renderCandidateCard = item => {
    const conflict = item.conflictWith;
    const conflictHtml = conflict
      ? `<p class="muted" style="color:var(--color-warning)">检测到同主题已有记忆 #${escapeHtml(conflict.id)}：「${escapeHtml(conflict.text)}」</p>
         <button type="button" class="text-btn" data-resolve-conflict="${escapeHtml(item.id || '')}" data-replace-id="${escapeHtml(conflict.id)}" data-replace-rev="${escapeHtml(conflict.revision)}">采纳并替换旧记忆</button>`
      : '';
    return `<article class="memory-card" data-id="${escapeHtml(item.id || '')}">
      <p>${escapeHtml(item.text || '')}</p>
      ${episodeMeta(item)}
      ${conflictHtml}
      <button type="button" class="text-btn" data-review="confirm">确认新增</button>
      <button type="button" class="text-btn" data-review="reject">忽略</button>
    </article>`;
  };
  const candidates = visibleMemoryItems(data.candidates || []).map(renderCandidateCard).join('');
  const impressionItems = (Array.isArray(data.impressions) ? data.impressions : []).map(item => `
    <article class="memory-card" data-impression-id="${escapeHtml(item.id || '')}">
      <p><strong>${escapeHtml(item.observerBotId)} → ${escapeHtml(item.targetBotId)}</strong> · ${item.state === 'confirmed' ? '当前已确认' : item.state === 'candidate' ? '待确认' : '历史评价（保留审计）'}</p>
      <p>${escapeHtml(item.text || '')}</p>
      <p class="muted">适用：${escapeHtml(item.applicableScenarios || '')}<br>直接依据：${escapeHtml(item.evidence || '')}<br>来源：${escapeHtml(item.sourceRef || '')} · ${escapeHtml(item.eventTimeMs || '')}${item.supersedesId && item.supersedesId !== '0' ? `<br>纠正旧评价 #${escapeHtml(item.supersedesId)}` : ''}</p>
      ${item.state === 'candidate' ? `<button type="button" class="text-btn" data-impression-review="confirm" data-id="${escapeHtml(item.id)}" data-revision="${escapeHtml(item.revision)}">确认</button><button type="button" class="text-btn" data-impression-review="reject" data-id="${escapeHtml(item.id)}" data-revision="${escapeHtml(item.revision)}">忽略</button>` : ''}
    </article>`).join('');
  const targetOptions = launchedBots().filter(bot => bot.id !== botId).map(bot => `<option value="${escapeHtml(bot.id)}">${escapeHtml(bot.name || bot.id)}</option>`).join('');
  const relations = relationItems.map((item, index) => `
    <div class="field"><label for="relation-${index}">${escapeHtml(item.title)}</label>
      <p class="muted" id="relation-description-${index}">${escapeHtml(item.description || '')}</p>
      <textarea id="relation-${index}" data-rel="${escapeHtml(item.key)}" rows="4" aria-describedby="relation-description-${index}" placeholder="${escapeHtml(item.placeholder || item.description || '')}">${escapeHtml(item.content)}</textarea></div>`).join('');
  showModal(`
    <div class="modal-head">
      <h2>记忆 · ${escapeHtml(data.character?.name || botName)}</h2>
      <button type="button" class="icon-btn" data-close>关闭</button>
    </div>
    <div class="modal-body">
      <div id="livingMemoryHost"></div>
      <div class="persona-actions" style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px">
        <label class="switch" style="margin:0"><input type="checkbox" id="memoryCapturePaused" ${data.capturePaused ? 'checked' : ''}> 本会话暂停提取记忆</label>
        <button type="button" class="text-btn" id="extractChatMemories" ${data.capturePaused ? 'disabled' : ''}>✦ 拾取近期对话星屑（事实 · 时效动态 · 私密结界）</button>
      </div>
      <h3>待确认的经验候选</h3>
      <div id="memoryCandidates">${candidates || '<p class="muted">目前没有待确认的候选。</p>'}</div>
      ${midSection(data)}
      <h3>长期记忆</h3>
      <div id="memoryEntries">${entries}</div>
      ${paginated ? '<button type="button" class="text-btn" id="loadMoreMemory">加载更早的记忆</button><p class="muted" id="memoryPageStatus" role="status"></p><p class="muted">仅保存已修改的条目；清空条目将删除。每次最多保存 100 条修改。</p>' : ''}
      <div class="field"><label>新增一条记忆</label><textarea id="newMemory" rows="4" placeholder="写下要记住的内容"></textarea></div>
      <details id="episodeEditor"><summary>记录共同经历</summary><p class="muted">只记录能追溯来源的真实事件，先保存为候选，确认后才会被引用。</p>
        <div class="field"><label>发生了什么</label><textarea id="episodeText" rows="3" placeholder="一起处理过的问题、做过的事情"></textarea></div>
        <div class="field"><label>事件时间</label><input id="episodeTime" type="datetime-local"></div>
        <div class="field"><label>来源</label><input id="episodeSource" placeholder="message:消息ID 或 run:任务ID"></div>
        <div class="field"><label>参与者</label><input id="episodeParticipants" placeholder="例如：你、这个 Bot"></div>
        <div class="field"><label>你最后选择了什么</label><textarea id="episodeChoice" rows="2" placeholder="你的决定、修改或取舍"></textarea></div>
        <div class="field"><label>结果如何</label><textarea id="episodeOutcome" rows="2" placeholder="验证结果、尚未解决的事项"></textarea></div>
        <button type="button" class="text-btn" id="addEpisode">保存为共同经历候选</button><p class="muted" id="episodeMsg" role="status" aria-live="polite"></p>
      </details>
      <details id="impressionEditor"><summary>Bot→Bot 主观印象与协作经验</summary>
        <p class="muted">这是当前 Bot 对另一个 Bot 的可修正主观判断，不是对方客观人设，也不使用好感分。只能引用双方同群可见的原始消息或共同 Work；转述不算独立证据。</p>
        <div id="impressionEntries">${impressionItems || '<p class="muted">这个会话还没有 Bot→Bot 主观印象。</p>'}</div>
        ${groupId ? `<div class="field"><label>观察对象</label><select id="impressionTarget">${targetOptions}</select></div>
        <div class="field"><label>主观判断与协作经验</label><textarea id="impressionText" rows="3" placeholder="例如：我认为 Beta 在接口排错协作中会先复现再改代码"></textarea></div>
        <div class="field"><label>来源时间</label><input id="impressionTime" type="datetime-local"></div>
        <div class="field"><label>直接来源</label><input id="impressionSource" placeholder="message:群消息ID 或 run:共同Work任务ID"></div>
        <div class="field"><label>依据</label><textarea id="impressionEvidence" rows="2" placeholder="该来源中双方可见的具体行为"></textarea></div>
        <div class="field"><label>适用场景</label><input id="impressionScenarios" placeholder="例如：共同排查接口故障；不要推广为通用人格"></div>
        <div class="field"><label>纠正旧评价 ID（可选）</label><input id="impressionSupersedes" placeholder="必须使用新的直接来源"></div>
        <button type="button" class="text-btn" id="addImpression">保存为主观印象候选</button>` : '<p class="muted">进入一个真实群聊后，才能记录 Bot→Bot 主观印象。</p>'}
        <p class="muted" id="impressionMsg" role="status" aria-live="polite"></p>
      </details>
      <button type="button" class="send-btn" id="saveMemory">保存记忆</button>
      <p class="muted" id="memoryMsg" role="status" aria-live="polite"></p>
      ${relations ? `<h3>人物关系与档案</h3>${relations}<button type="button" class="send-btn" id="saveRelations">保存关系资料</button><p class="muted" id="relationMsg" role="status" aria-live="polite"></p>` : ''}
    </div>`);
  const modal = $('modal'), memoryButton = $('saveMemory'), memoryMessage = $('memoryMsg'), newMemory = $('newMemory');
  const candidateHost = $('memoryCandidates'), entryHost = $('memoryEntries');
  const loadMore = $('loadMoreMemory'), pageStatus = $('memoryPageStatus');
  const current = () => isCurrentUi(ticket) && state.botId === botId && memoryButton.isConnected;
  if (nativeMid) {
    const midHost = $('midMemoryEntries'), midMessage = $('midMemoryMsg'), midSave = $('saveMidMemory');
    const midNew = $('newMidMemory'), midAdd = $('addMidMemory'), midDays = $('newMidDays');
    let midBusy = false, midStale = false;
    const drafts = () => new Map(midItems.flatMap(item => {
      const box = midHost.querySelector(`[data-id="${CSS.escape(String(item.id))}"] textarea`);
      return box && box.value !== item.text ? [[String(item.id), box.value]] : [];
    }));
    const sync = () => {
      midSave.disabled = midAdd.disabled = midBusy || midStale;
      midNew.disabled = midDays.disabled = midBusy;
      for (const control of midHost.querySelectorAll('textarea,select,button'))
        control.disabled = midBusy || (midStale && control.tagName !== 'TEXTAREA');
    };
    const update = (result, settled = []) => {
      if (result.midMemoryVersion !== 1 || !Array.isArray(result.mid)) {
        midStale = true; throw new Error('保存结果缺少中期记忆版本，请重新打开面板确认。');
      }
      const pending = drafts(), done = new Set(settled.map(String));
      const next = new Map(result.mid.map(item => [String(item.id), item]));
      for (const item of midItems)
        if (pending.has(String(item.id)) && !done.has(String(item.id))) next.set(String(item.id), item);
      midItems = [...next.values()].sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0);
      midHost.innerHTML = midItems.map(midMemoryCard).join('') || '<p class="muted">还没有中期记忆。</p>';
      for (const [id, text] of pending) if (!done.has(id)) {
        const box = midHost.querySelector(`[data-id="${CSS.escape(id)}"] textarea`);
        if (box) box.value = text;
      }
    };
    const submit = async (body, settled, message, added = false) => {
      if (!current() || midBusy || midStale) return;
      midBusy = true; sync();
      try {
        const result = await api(path, { method: 'POST', body: JSON.stringify({ ...body, botId }) });
        if (!current()) return;
        update(result, settled);
        if (added) midNew.value = '';
        midMessage.textContent = message;
      } catch (err) {
        if (err.status === 409) midStale = true;
        if (current()) midMessage.textContent = midStale ? '中期记忆已变化，当前草稿已保留。请关闭并重新打开面板后再编辑。' : err.message;
      } finally { midBusy = false; if (current()) sync(); }
    };
    midSave.addEventListener('click', () => {
      const changed = drafts();
      const mid = midItems.filter(item => changed.has(String(item.id)))
        .map(item => ({ id: String(item.id), revision: String(item.revision), text: changed.get(String(item.id)) }));
      if (!mid.length) { midMessage.textContent = '正文没有修改。'; return; }
      if (mid.length > 100) { midMessage.textContent = '一次最多保存 100 条修改，此次尚未保存。'; return; }
      void submit({ action: 'save-mid', mid }, mid.map(item => item.id), '中期正文已保存；有效期保持不变。');
    });
    midAdd.addEventListener('click', () => {
      const text = midNew.value;
      if (!text.trim()) { midMessage.textContent = '请填写中期记忆正文。'; return; }
      void submit({ action: 'add-mid', text, days: Number(midDays.value) }, [], '中期记忆已新增。', true);
    });
    midHost.addEventListener('click', event => {
      const button = event.target.closest('[data-mid-extend]');
      if (!button || !midHost.contains(button)) return;
      const card = button.closest('[data-id]'), item = midItems.find(row => String(row.id) === card?.dataset.id);
      if (!item) return;
      if (drafts().has(String(item.id))) { midMessage.textContent = '请先保存这条记忆的正文修改，再延长有效期。'; return; }
      void submit({ action: 'reinforce-mid', id: String(item.id), revision: String(item.revision), days: Number(card.querySelector('[data-mid-days]').value) },
        [String(item.id)], '有效期已延长，记忆强度已增加。');
    });
    sync();
  }
  let memoryStale = false, memoryBusy = false, episodeBusy = false;
  const episodeButton = $('addEpisode'), episodeMessage = $('episodeMsg');
  const candidateMarkup = items => items.map(renderCandidateCard).join('') || '<p class="muted">目前没有待确认的候选。</p>';
  const memoryDrafts = () => new Map(memoryEntries.flatMap(entry => {
    const box = entryHost.querySelector(`.memory-card[data-kind="entry"][data-id="${CSS.escape(String(entry.id))}"] textarea`);
    return box && box.value !== entry.text ? [[String(entry.id), box.value]] : [];
  }));
  const syncMemoryControls = () => {
    memoryButton.disabled = memoryBusy || memoryStale;
    newMemory.disabled = memoryBusy;
    if (episodeButton) episodeButton.disabled = episodeBusy || memoryBusy || memoryStale;
    for (const box of entryHost.querySelectorAll('textarea')) box.disabled = memoryBusy;
    for (const button of candidateHost.querySelectorAll('[data-review]')) button.disabled = memoryBusy || memoryStale;
    if (loadMore) { loadMore.hidden = !hasMoreMemory; loadMore.disabled = memoryBusy || memoryStale; }
    if (pageStatus) pageStatus.textContent = `已加载 ${loadedMemories.size} 条${hasMoreMemory ? '，可继续查看更早记录。' : '，已加载全部可见记忆。'}`;
  };
  const updateMemory = (result, { settled = [], page = false } = {}) => {
    if (!current()) return;
    if (typeof result?.revision === 'string') memoryRevision = result.revision;
    if (paginated) {
      const drafts = memoryDrafts(), committed = new Set(settled.map(String));
      for (const id of committed) loadedMemories.delete(id);
      const merge = (item, state) => {
        const id = String(item.id);
        // An unrelated refresh must not adopt a newer revision underneath an
        // unsaved draft; its original revision must still detect a conflict.
        if (!drafts.has(id) || committed.has(id)) loadedMemories.set(id, { ...item, state });
      };
      for (const item of visibleMemoryItems(result?.entries)) merge(item, 'confirmed');
      for (const item of visibleMemoryItems(result?.candidates)) merge(item, 'candidate');
      for (const item of visibleMemoryItems(result?.updatedEntries)) merge(item, item.state);
      for (const id of result?.deletedIds || []) loadedMemories.delete(String(id));
      const ordered = [...loadedMemories.values()].sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0);
      memoryEntries = ordered.filter(item => item.state === 'confirmed');
      memoryCandidates = ordered.filter(item => item.state === 'candidate');
      entryHost.innerHTML = memoryEntries.map(item => memoryCard(item, 'entry')).join('') || '<p class="muted">还没有长期记忆条目。</p>';
      candidateHost.innerHTML = candidateMarkup(memoryCandidates);
      for (const [id, text] of drafts) if (!committed.has(id)) {
        const box = entryHost.querySelector(`.memory-card[data-id="${CSS.escape(id)}"] textarea`);
        if (box) box.value = text;
      }
      if (page) { pageBefore = result.before; hasMoreMemory = result.hasMore === true; }
      syncMemoryControls();
      return;
    }
    if (Array.isArray(result?.entries)) {
      memoryEntries = result.entries;
      entryHost.innerHTML = memoryEntries.map(item => memoryCard(item, 'entry')).join('') || '<p class="muted">还没有长期记忆条目。</p>';
    }
    if (Array.isArray(result?.candidates)) candidateHost.innerHTML = candidateMarkup(result.candidates);
  };
  syncMemoryControls();
  loadMore?.addEventListener('click', async () => {
    if (!current() || memoryBusy || memoryStale || !hasMoreMemory) return;
    memoryBusy = true; syncMemoryControls();
    try {
      if (typeof pageBefore !== 'string' || !/^[1-9]\d*$/.test(pageBefore)) throw new Error('记忆分页信息无效，请重新打开面板。');
      const before = pageBefore;
      const result = await api(`${path}&limit=100&before=${encodeURIComponent(before)}`);
      if (result.hasMore && (typeof result.before !== 'string' || BigInt(result.before) >= BigInt(before))) throw new Error('记忆分页没有前进，请重新打开面板。');
      updateMemory(result, { page: true });
    } catch (err) { if (current()) memoryMessage.textContent = err.message || '加载更早记忆失败。'; }
    finally { memoryBusy = false; if (current()) syncMemoryControls(); }
  });
  episodeButton?.addEventListener('click', async () => {
    if (!current() || episodeBusy || memoryBusy || memoryStale) return;
    const text = $('episodeText').value.trim(), sourceRef = $('episodeSource').value.trim();
    const participants = $('episodeParticipants').value.split(/[、,，]/).map(item => item.trim()).filter(Boolean);
    const userChoice = $('episodeChoice').value.trim(), outcome = $('episodeOutcome').value.trim();
    const eventTimeMs = new Date($('episodeTime').value).getTime();
    if (!text || !sourceRef || !participants.length || !userChoice || !outcome || !Number.isFinite(eventTimeMs) || eventTimeMs <= 0) {
      episodeMessage.textContent = '请完整填写事件、时间、来源、参与者、用户选择和结果。'; return;
    }
    episodeBusy = true; syncMemoryControls();
    try {
      updateMemory(await api(path, { method: 'POST', body: JSON.stringify({ action: 'propose-episode', text, eventTimeMs, sourceRef, participants, userChoice, outcome, botId }) }));
      if (current()) {
        for (const id of ['episodeText', 'episodeSource', 'episodeChoice', 'episodeOutcome']) $(id).value = '';
        episodeMessage.textContent = '已保存为共同经历候选，确认后才会被引用。';
      }
    } catch (error) { if (current()) episodeMessage.textContent = error.message; }
    finally { episodeBusy = false; if (current()) syncMemoryControls(); }
  });
  $('addImpression')?.addEventListener('click', async () => {
    if (!current() || memoryBusy || memoryStale) return;
    const targetBotId = $('impressionTarget').value, text = $('impressionText').value.trim();
    const sourceRef = $('impressionSource').value.trim(), evidence = $('impressionEvidence').value.trim();
    const applicableScenarios = $('impressionScenarios').value.trim(), supersedesId = $('impressionSupersedes').value.trim();
    const eventTimeMs = new Date($('impressionTime').value).getTime(), message = $('impressionMsg');
    if (!targetBotId || !text || !sourceRef || !evidence || !applicableScenarios || !Number.isFinite(eventTimeMs) || eventTimeMs <= 0) {
      message.textContent = '请完整填写对象、主观判断、时间、直接来源、依据和适用场景。'; return;
    }
    memoryBusy = true; syncMemoryControls();
    try {
      await api(path, { method: 'POST', body: JSON.stringify({ action: 'propose-impression', botId, groupId,
        targetBotId, text, eventTimeMs, sourceRef, evidence, applicableScenarios,
        ...(supersedesId ? { supersedesId } : {}) }) });
      if (current()) void openMemory();
    } catch (error) { if (current()) message.textContent = error.message; }
    finally { memoryBusy = false; if (current()) syncMemoryControls(); }
  });
  $('impressionEntries')?.addEventListener('click', async event => {
    const button = event.target.closest('[data-impression-review]');
    if (!button || !current() || memoryBusy || memoryStale) return;
    memoryBusy = true; syncMemoryControls();
    try {
      await api(path, { method: 'POST', body: JSON.stringify({ action: 'review', botId, groupId,
        candidateId: button.dataset.id, revision: button.dataset.revision,
        reviewAction: button.dataset.impressionReview }) });
      if (current()) void openMemory();
    } catch (error) { if (current()) $('impressionMsg').textContent = error.message; }
    finally { memoryBusy = false; if (current()) syncMemoryControls(); }
  });
  memoryButton.addEventListener('click', async () => {
    if (!current()) { memoryMessage.textContent = '当前 Bot 已切换，请重新打开记忆面板。'; return; }
    if (memoryStale || memoryBusy) return;
    const add = newMemory.value.trim();
    const baseRevision = memoryRevision;
    const next = memoryEntries.map(entry => {
      const box = entryHost.querySelector(`.memory-card[data-kind="entry"][data-id="${CSS.escape(String(entry.id))}"] textarea`);
      return { ...entry, text: box ? box.value : entry.text };
    });
    const changes = next.filter((entry, index) => entry.text !== memoryEntries[index].text)
      .map(entry => ({ id: String(entry.id), revision: String(entry.revision), text: entry.text }));
    if (paginated && changes.length > 100) { memoryMessage.textContent = '一次最多保存 100 条修改，请分批编辑后保存。此次尚未保存。'; return; }
    memoryBusy = true; syncMemoryControls();
    try {
      if (!nativeMid) await saveMidEdits(botId);
      if (paginated) {
        if (changes.length) updateMemory(await api(path, { method: 'POST', body: JSON.stringify({ action: 'save-entries', entries: changes, botId }) }), { settled: changes.map(entry => entry.id) });
      } else updateMemory(await api(path, { method: 'POST', body: JSON.stringify({ action: 'save', entries: next, baseRevision, botId }) }));
      if (add) {
        updateMemory(await api(path, { method: 'POST', body: JSON.stringify({ action: 'add', text: add, botId }) }));
        if (current()) newMemory.value = '';
      }
      if (current()) memoryMessage.textContent = '已保存。';
    } catch (err) {
      if (err.status === 409) memoryStale = true;
      if (current()) memoryMessage.textContent = memoryStale ? '记忆已在其他位置修改，请关闭并重新打开记忆面板。' : err.message;
    } finally { memoryBusy = false; if (current()) syncMemoryControls(); }
  });
  $('memoryCapturePaused')?.addEventListener('change', async event => {
    const paused = event.target.checked;
    const extractBtn = $('extractChatMemories');
    if (extractBtn) extractBtn.disabled = paused || memoryBusy;
    try {
      await api(path, { method: 'POST', body: JSON.stringify({ action: 'set-capture-policy', capturePaused: paused, botId, groupId }) });
      if (current()) memoryMessage.textContent = paused ? '已开启：本会话暂停从对话提取记忆。' : '已恢复：允许从本会话提取候选记忆。';
    } catch (err) { if (current()) memoryMessage.textContent = err.message; }
  });
  let lmHandle = null;
  void import('./living-memory-ui.js').then(({ mountLivingMemorySection }) =>
    mountLivingMemorySection({
      api,
      host: $('livingMemoryHost'),
      entriesHost: entryHost,
      botId,
      groupId,
      onNeedReload: () => openMemory(),
    })
  ).then(h => { lmHandle = h; }).catch(() => {});

  $('extractChatMemories')?.addEventListener('click', async () => {
    if (!current() || memoryBusy || memoryStale) return;
    memoryBusy = true; syncMemoryControls();
    try {
      const res = await api(path, { method: 'POST', body: JSON.stringify({ action: 'extract-from-chat', botId, groupId, useModel: true }) });
      const stat = res?.updatedEntries?.[0] || {};
      updateMemory(res);
      lmHandle?.repaintBadges?.();
      if (current()) {
        const midNote = stat.midAddedCount ? ` · 新增近期时效动态 ${stat.midAddedCount} 条` : '';
        const privNote = stat.privateTaggedCount ? ` · 自动标记私密隔离 ${stat.privateTaggedCount} 条` : '';
        memoryMessage.textContent = `提炼完成：新增长期候选 ${stat.extractedCount ?? 0} 条${midNote}${privNote}（拦截改口/假设 ${stat.filteredCount ?? 0} 条）。`;
      }
    } catch (err) { if (current()) memoryMessage.textContent = err.message; }
    finally { memoryBusy = false; if (current()) syncMemoryControls(); }
  });
  entryHost.addEventListener('click', async event => {
    const toggle = event.target.closest('[data-toggle-recall]');
    if (!toggle || !entryHost.contains(toggle) || !current() || memoryBusy || memoryStale) return;
    const memId = toggle.dataset.toggleRecall;
    const nextEnabled = toggle.dataset.recallNext === '1';
    memoryBusy = true; syncMemoryControls();
    try {
      const res = await api(path, { method: 'POST', body: JSON.stringify({ action: 'set-recall', memoryId: memId, recallEnabled: nextEnabled, botId, groupId }) });
      const cached = loadedMemories.get(String(memId));
      if (cached) cached.recallEnabled = nextEnabled;
      updateMemory(res);
      if (current()) memoryMessage.textContent = nextEnabled ? `记忆 #${memId} 已恢复参与召回。` : `记忆 #${memId} 已暂停召回（原文保留）。`;
    } catch (err) { if (current()) memoryMessage.textContent = err.message; }
    finally { memoryBusy = false; if (current()) syncMemoryControls(); }
  });
  candidateHost.addEventListener('click', async event => {
    const resolveBtn = event.target.closest('[data-resolve-conflict]');
    if (resolveBtn && candidateHost.contains(resolveBtn) && current() && !memoryBusy && !memoryStale) {
      const candId = resolveBtn.dataset.resolveConflict;
      const replaceId = resolveBtn.dataset.replaceId;
      const replaceRev = resolveBtn.dataset.replaceRev;
      memoryBusy = true; syncMemoryControls();
      try {
        const res = await api(path, { method: 'POST', body: JSON.stringify({
          action: 'resolve-conflict', candidateId: candId, replaceId, replaceRevision: replaceRev, botId, groupId,
        }) });
        loadedMemories.delete(String(replaceId));
        updateMemory(res, { settled: [candId, replaceId] });
        if (current()) memoryMessage.textContent = `已采纳新记忆并替换冲突旧条目 #${replaceId}。`;
      } catch (err) { if (current()) memoryMessage.textContent = err.message; }
      finally { memoryBusy = false; if (current()) syncMemoryControls(); }
      return;
    }
    const btn = event.target.closest('[data-review]');
    if (btn && candidateHost.contains(btn) && current() && !memoryBusy && !memoryStale) {
      const id = btn.closest('[data-id]')?.dataset.id;
      const candidate = loadedMemories.get(id);
      memoryBusy = true; syncMemoryControls();
      try {
        // Select the reviewed row's range so an old-page confirmation returns
        // its actual new revision instead of only the newest page of records.
        const reviewPath = paginated ? `${path}&limit=1${BigInt(id) < 9223372036854775807n ? `&before=${BigInt(id) + 1n}` : ''}` : path;
        updateMemory(await api(reviewPath, { method: 'POST', body: JSON.stringify({ action: 'review', candidateId: id, reviewAction: btn.dataset.review, botId,
          ...(paginated ? { revision: String(candidate.revision) } : {}) }) }), { settled: [id] });
      } catch (err) {
        if (err.status === 409) memoryStale = true;
        if (current()) memoryMessage.textContent = memoryStale ? '记忆已在其他位置修改，请关闭并重新打开记忆面板。' : err.message;
      } finally { memoryBusy = false; if (current()) syncMemoryControls(); }
    }
  });
  const relationButton = $('saveRelations'), relationMessage = $('relationMsg');
  const relationAreas = [...modal.querySelectorAll('textarea[data-rel]')];
  let relationStale = false;
  relationButton?.addEventListener('click', async () => {
    if (!current()) { relationMessage.textContent = '当前 Bot 已切换，请重新打开记忆面板。'; return; }
    if (relationStale) return;
    const values = Object.fromEntries(relationAreas.map(area => [area.dataset.rel, area.value]));
    relationButton.disabled = true;
    try {
      if (nativeRelations) {
        const result = await api(path, { method: 'POST', body: JSON.stringify({ action: 'save-relations', values, baseRevision: relationRevision, botId }) });
        if (!current()) return;
        const revision = result.overview?.relationRevision, saved = relationFields(result);
        if (typeof revision !== 'string' || !revision || saved.length !== RELATION_FIELDS.length || RELATION_FIELDS.some(field => !saved.some(item => item.key === field.key))) {
          relationStale = true; throw new Error('保存结果缺少关系版本，请关闭并重新打开记忆面板确认。');
        }
        relationRevision = revision;
        for (const area of relationAreas) area.value = saved.find(item => item.key === area.dataset.rel)?.content || '';
      } else {
        // Legacy servers expose editable relation fields through persona. Keep
        // their original keys, isolated from ordinary memory saves.
        await api(`/api/dimension/persona?botId=${encodeURIComponent(botId)}`, { method: 'POST', body: JSON.stringify({ values }) });
      }
      if (current()) relationMessage.textContent = '关系资料已保存。';
    } catch (err) {
      if (err.status === 409) relationStale = true;
      if (current()) relationMessage.textContent = relationStale ? '关系资料已变化，请关闭并重新打开记忆面板后再编辑。' : err.message;
    } finally { relationButton.disabled = relationStale; }
  });
}

async function openSpace() {
  const ticket = bumpUiTicket();
  const botId = state.botId, botName = state.botName;
  const { showIndependentSpace } = await import('./conversation-services-ui.js');
  await showIndependentSpace({
    api, showModal, escapeHtml, botId, botName,
    isCurrent: () => isCurrentUi(ticket) && state.botId === botId,
  });
}

function hasSecret(item) {
  const flag = item?.secretConfigured;
  return flag === true || (typeof flag === 'string' && flag !== 'none');
}

function stripSecrets(value, depth = 0) {
  if (value == null || depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) stripSecrets(item, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (/^(secretValue|apiKey|api_key|accessToken|password)$/i.test(key)) delete value[key];
    else stripSecrets(value[key], depth + 1);
  }
}

function selectionValue(sel) {
  if (!sel?.providerId) return '';
  return `${sel.providerId}\t${sel.model || ''}`;
}

function parseSelectionValue(value) {
  if (!value || value === '__keys__') return null;
  const at = value.indexOf('\t');
  if (at < 0) return { providerId: value, model: '' };
  return { providerId: value.slice(0, at), model: value.slice(at + 1) };
}

function currentSelection() {
  return state.conversationModel || state.modelSelection || (
    state.activeProvider && state.model
      ? { providerId: state.activeProvider, model: state.model }
      : null
  );
}

function providerModels(item) {
  const names = [];
  const seen = new Set();
  const add = (model) => {
    const id = typeof model === 'string' ? model : (model?.id || model?.name || '');
    if (!id || seen.has(id)) return;
    seen.add(id);
    names.push(id);
  };
  add(item.model);
  for (const model of (state.catalog[item.name] || [])) add(model);
  return names;
}

function cleanEntry(entry) {
  if (!entry || typeof entry !== 'object') return {};
  const out = JSON.parse(JSON.stringify(entry));
  stripSecrets(out);
  return out;
}

async function loadModules() {
  if (state.modules.length) return state.modules;
  try {
    const data = await api('/api/provider-modules');
    const list = Array.isArray(data) ? data : (data.modules || data.items || []);
    state.modules = list.map((item) => ({
      id: item.id,
      title: item.title || item.id,
      defaultBaseUrl: item.defaultBaseUrl || '',
    }));
  } catch {
    state.modules = [];
  }
  return state.modules;
}

async function refreshCatalogs() {
  const next = { ...state.catalog };
  await Promise.all(state.providers.map(async (item) => {
    if (!hasSecret(item)) return;
    try {
      const data = await api(`/api/providers/${encodeURIComponent(item.name)}/models`, { method: 'POST', body: '{}' });
      const models = data.models || data.items || [];
      next[item.name] = models.map((model) => (typeof model === 'string' ? model : (model.id || model.name || ''))).filter(Boolean);
    } catch {
      /* 保留已有目录，不把错误正文里的敏感字段留下 */
    }
  }));
  state.catalog = next;
}

async function persistConversationModel(selection, updateBotDefault, syncWorkLead = false) {
  const grp = currentGroup();
  const targetBotId = (grp && (!state.botId || !grp.members?.includes(state.botId)))
    ? (grp.ownerId || grp.members?.[0] || state.botId)
    : state.botId;
  const data = await api(`/api/dimension/bots/${encodeURIComponent(targetBotId)}/conversation-model`, {
    method: 'PATCH',
    body: JSON.stringify({
      modelSelection: selection,
      updateBotDefault: !!updateBotDefault,
      syncWorkLead: !!syncWorkLead,
    }),
  });
  state.modelSelection = data.modelSelection || (updateBotDefault ? selection : state.modelSelection);
  state.conversationModel = data.conversationModel || null;
  if (data.workLead && state.workSettings && typeof state.workSettings === 'object') {
    state.workSettings = { ...state.workSettings, workLead: data.workLead };
  }
  if (data.bot && Array.isArray(state.bots)) {
    const idx = state.bots.findIndex((b) => b.id === data.bot.id);
    if (idx >= 0) state.bots[idx] = { ...state.bots[idx], ...data.bot };
  }
  return data;
}

async function applyRuntimeSelection(selection) {
  if (isCliSelection(selection)) {
    state.activeProvider = selection.providerId || `cli:${selection.engineId || ''}`;
    state.model = selection.model || selection.engineId || '';
    state.ready = true;
    return;
  }
  const name = selection.providerId;
  const detail = await api(`/api/providers/${encodeURIComponent(name)}`);
  const entry = cleanEntry(detail.entry);
  if (selection.model && entry.spec?.model !== selection.model) {
    entry.spec = { ...(entry.spec || {}), model: selection.model };
    await api(`/api/providers/${encodeURIComponent(name)}/save`, {
      method: 'POST',
      body: JSON.stringify({ name, entry, expectedRevision: detail.revision }),
    });
  }
  await api(`/api/providers/${encodeURIComponent(name)}/activate`, { method: 'POST' });
  state.activeProvider = name;
  state.model = selection.model;
  state.ready = true;
}

async function switchModel(selection, { updateBotDefault, syncWorkLead = false } = {}) {
  if (isCliSelection(selection)) {
    try {
      await persistConversationModel(selection, updateBotDefault ?? true, syncWorkLead);
      await applyRuntimeSelection(selection);
      renderModels();
      workUi?.sync();
      setModelStatus('');
    } catch (err) {
      setModelStatus(err.message);
      renderModels();
      throw err;
    }
    return true;
  }
  if (!selection?.providerId || !selection.model) {
    await openKeySettings(selection?.providerId || '');
    return false;
  }
  const provider = state.providers.find((item) => item.name === selection.providerId);
  if (provider && !hasSecret(provider)) {
    await openKeySettings(selection.providerId);
    return false;
  }
  const previous = { provider: state.activeProvider, model: state.model, ready: state.ready };
  try {
    await applyRuntimeSelection(selection);
    await persistConversationModel(selection, updateBotDefault, syncWorkLead);
  } catch (err) {
    state.activeProvider = previous.provider;
    state.model = previous.model;
    state.ready = previous.ready;
    setModelStatus(err.message);
    renderModels();
    return false;
  }
  try {
    await loadProviders();
  } catch (err) {
    setModelStatus(err.message);
  }
  renderModels();
  workUi?.sync();
  return true;
}

function openBotCliReceptionSettings() {
  const grp = currentGroup();
  const targetBotId = (grp && (!state.botId || !grp.members?.includes(state.botId)))
    ? (grp.ownerId || grp.members?.[0] || state.botId)
    : state.botId;
  const targetBot = (state.bots || []).find((b) => b.id === targetBotId);
  const targetName = targetBot?.name || state.botName || targetBotId;
  openCliReceptionModal({
    api,
    botId: targetBotId,
    botName: targetName,
    currentSelection: currentSelection(),
    defaultSyncWorkLead: true,
    onSelectCli: async (cliSel, { syncWorkLead }) => {
      await switchModel(cliSel, { updateBotDefault: true, syncWorkLead });
      toast(`已为 ${targetName} 启用 ${formatCliSelectionLabel(cliSel)}`);
    },
    onSwitchToApi: async ({ syncWorkLead }) => {
      const choices = modelChoices().filter(choice => !isCliSelection(choice));
      if (choices.length) {
        const first = { providerId: choices[0].providerId, model: choices[0].model };
        if (!await switchModel(first, { updateBotDefault: true, syncWorkLead })) return false;
        toast(`已切回维度 API：${first.model}`);
        return true;
      } else {
        await openKeySettings();
        return false;
      }
    },
    onOpenSandboxSettings: () => {
      window.__dimensionOpenClientSettings?.('cli-sandbox');
    },
  });
}

async function openKeys(selectedName = '') {
  const ticket = bumpUiTicket();
  await Promise.all([loadProviders(), loadModules()]);
  if (!isCurrentUi(ticket)) return;
  const editing = { name: selectedName || '' };
  const renderForm = () => {
    const current = state.providers.find((item) => item.name === editing.name);
    const modules = state.modules.map((item) => {
      const selected = (editing.module || current?.module || '') === item.id ? ' selected' : '';
      return `<option value="${escapeHtml(item.id)}"${selected}>${escapeHtml(item.title)}</option>`;
    }).join('');
    const configured = current ? hasSecret(current) : false;
    const list = state.providers.map((item) => {
      const active = item.name === editing.name ? ' active' : '';
      const status = hasSecret(item) ? (item.ready ? '已配置' : '已配置 · 未就绪') : '需要密钥';
      return `<button type="button" class="drawer-item${active}" data-pick="${escapeHtml(item.name)}">
        <span class="item-title">${escapeHtml(item.moduleTitle || item.displayName || item.name)}</span>
        <span class="item-desc">${escapeHtml(item.name)} · ${escapeHtml(item.model || '未选模型')} · ${status}</span>
      </button>`;
    }).join('') || '<p class="muted">还没有接口实例。可以在下面新增一个兼容端点。</p>';
    return `
    <div class="modal-head">
      <h2>能力</h2>
      <button type="button" class="icon-btn" data-close>关闭</button>
    </div>
    <div class="modal-body">
      <p class="muted">密钥只保存在本机接口配置里，界面和接口都不会回传密钥正文。改模型只影响之后的对话，不会改已有对白。这是共用主会话上的 bot 默认与当前对话覆盖，不是互相隔离的多线程。</p>
      <h3>已有接口</h3>
      ${list}
      <button type="button" class="text-btn" id="newEndpointBtn">新增兼容端点</button>
      <h3>${current ? '编辑接口' : '新增兼容端点'}</h3>
      <div class="field"><label for="keyName">名称</label><input id="keyName" type="text" ${current ? 'readonly' : ''} value="${escapeHtml(editing.name)}" placeholder="英文、数字或连字符"></div>
      <div class="field"><label for="keyModule">接口类型</label><select id="keyModule">${modules}</select></div>
      <div class="field"><label for="keyBase">接口地址（可选）</label><input id="keyBase" type="url" value="${escapeHtml(editing.baseUrl ?? current?.baseUrl ?? '')}" placeholder="https://"></div>
      <div class="field"><label for="keyModel">模型</label><input id="keyModel" type="text" value="${escapeHtml(editing.model ?? current?.model ?? '')}" placeholder="模型名"></div>
      <div class="field"><label for="keySecret">密钥</label><input id="keySecret" type="password" autocomplete="off" placeholder="${configured ? '已配置，留空则保留原密钥' : '粘贴密钥，不会显示在别处'}"></div>
      <p class="muted" id="keysMsg"></p>
      <button type="button" class="send-btn" id="testKeyBtn">测试</button>
      <button type="button" class="send-btn" id="saveKeyBtn">保存</button>
      ${current ? '<button type="button" class="text-btn" id="deleteKeyBtn">删除这个接口</button>' : ''}
      <button type="button" class="text-btn" id="useKeyBtn">用于当前对话</button>
      <button type="button" class="text-btn" id="defaultKeyBtn">设为这个 bot 的默认并用于当前对话</button>
    </div>`;
  };
  const bindForm = () => {
    document.querySelectorAll('#modal [data-pick]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        editing.name = btn.dataset.pick || '';
        editing.module = '';
        editing.baseUrl = undefined;
        editing.model = undefined;
        const item = state.providers.find((row) => row.name === editing.name);
        if (item) {
          editing.module = item.module;
          editing.baseUrl = item.baseUrl;
          editing.model = item.model;
        }
        showModal(renderForm());
        bindForm();
      });
    });
    const newBtn = document.getElementById('newEndpointBtn');
    if (newBtn) newBtn.addEventListener('click', () => {
      editing.name = '';
      editing.module = state.modules.find((item) => item.id.includes('openai') || item.id.includes('compat'))?.id || state.modules[0]?.id || '';
      editing.baseUrl = (state.modules.find((item) => item.id === editing.module) || {}).defaultBaseUrl || '';
      editing.model = '';
      showModal(renderForm());
      bindForm();
    });
    const readForm = () => ({
      name: (document.getElementById('keyName')?.value || '').trim(),
      module: document.getElementById('keyModule')?.value || '',
      baseUrl: (document.getElementById('keyBase')?.value || '').trim(),
      model: (document.getElementById('keyModel')?.value || '').trim(),
      secretValue: document.getElementById('keySecret')?.value || '',
    });
    const say = (text) => {
      const el = document.getElementById('keysMsg');
      if (el) el.textContent = text;
    };
    const buildEntry = (form, existing) => {
      const entry = cleanEntry(existing || { kind: form.module, spec: {} });
      entry.kind = form.module || entry.kind;
      if (form.baseUrl) entry.baseUrl = form.baseUrl;
      else delete entry.baseUrl;
      entry.spec = { ...(entry.spec || {}), model: form.model };
      return entry;
    };
    const loadExisting = async (name) => {
      if (!name) return { entry: null, revision: undefined };
      const detail = await api(`/api/providers/${encodeURIComponent(name)}`);
      return { entry: cleanEntry(detail.entry), revision: detail.revision };
    };
    document.getElementById('keyModule')?.addEventListener('change', (event) => {
      const mod = state.modules.find((item) => item.id === event.target.value);
      const base = document.getElementById('keyBase');
      if (mod && base && !base.value) base.value = mod.defaultBaseUrl || '';
    });
    document.getElementById('testKeyBtn')?.addEventListener('click', async () => {
      try {
        const form = readForm();
        if (!form.name) { say('请先填写名称。'); return; }
        if (!form.model) { say('请先填写模型名。'); return; }
        const body = {};
        if (form.secretValue) {
          body.entry = buildEntry(form);
          body.secretValue = form.secretValue;
        } else if (!state.providers.find((item) => item.name === form.name)) {
          say('新接口测试需要先粘贴密钥。');
          return;
        }
        const result = await api(`/api/providers/${encodeURIComponent(form.name)}/test`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        const hint = result?.ok === false ? (result.error || result.message || '未通过') : (result?.model || result?.hint || result?.status || '测试完成');
        say(typeof hint === 'string' ? hint : '测试完成');
      } catch (err) {
        say(err.message);
      }
    });
    document.getElementById('saveKeyBtn')?.addEventListener('click', async () => {
      try {
        const form = readForm();
        if (!form.name || !form.module || !form.model) { say('名称、接口类型和模型都要填。'); return; }
        const existing = state.providers.find((item) => item.name === form.name);
        const loaded = existing ? await loadExisting(form.name) : { entry: null, revision: undefined };
        const entry = buildEntry(form, loaded.entry);
        const payload = { name: form.name, entry };
        if (loaded.revision) payload.expectedRevision = loaded.revision;
        if (form.secretValue) payload.secretValue = form.secretValue;
        const path = existing ? `/api/providers/${encodeURIComponent(form.name)}/save` : '/api/providers';
        await api(path, { method: 'POST', body: JSON.stringify(payload) });
        editing.name = form.name;
        editing.module = form.module;
        editing.baseUrl = form.baseUrl;
        editing.model = form.model;
        await loadProviders();
        await refreshCatalogs();
        renderModels();
        showModal(renderForm());
        bindForm();
        say('已保存。密钥不会出现在回传内容里。');
      } catch (err) {
        say(err.message);
      }
    });
    document.getElementById('deleteKeyBtn')?.addEventListener('click', async () => {
      try {
        const form = readForm();
        if (!form.name) return;
        const loaded = await loadExisting(form.name);
        await api(`/api/providers/${encodeURIComponent(form.name)}/delete`, {
          method: 'POST',
          body: JSON.stringify({ expectedRevision: loaded.revision }),
        });
        editing.name = '';
        editing.module = '';
        editing.baseUrl = '';
        editing.model = '';
        await loadProviders();
        renderModels();
        showModal(renderForm());
        bindForm();
        say('已删除。');
      } catch (err) {
        say(err.message);
      }
    });
    const useSelection = async (updateBotDefault) => {
      try {
        const form = readForm();
        if (!form.name || !form.model) { say('请先保存带模型名的接口。'); return; }
        await switchModel({ providerId: form.name, model: form.model }, { updateBotDefault });
        say(updateBotDefault ? '已设为这个 bot 的默认，并用于当前对话。' : '已用于当前对话。后续回合会改用这个模型。');
      } catch (err) {
        say(err.message);
      }
    };
    document.getElementById('useKeyBtn')?.addEventListener('click', () => useSelection(false));
    document.getElementById('defaultKeyBtn')?.addEventListener('click', () => useSelection(true));
  };
  if (!isCurrentUi(ticket)) return;
  showModal(renderForm());
  bindForm();
}


const CHROME_EDGE_PX = 7;
const chromeState = { isMaximized: false };

function postChrome(action, extra) {
  const payload = { source: 'dimension-chrome', action, ...(extra || {}) };
  try { window.chrome?.webview?.postMessage(payload); }
  catch { /* host not present outside the desktop shell */ }
}

function setChromeMaximized(max) {
  chromeState.isMaximized = Boolean(max);
  const btn = $('chromeMax');
  if (!btn) return;
  const restore = chromeState.isMaximized;
  const label = restore ? '还原' : '最大化';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  const iconMax = btn.querySelector('.chrome-icon-max');
  const iconRestore = btn.querySelector('.chrome-icon-restore');
  if (iconMax) iconMax.hidden = restore;
  if (iconRestore) iconRestore.hidden = !restore;
  document.documentElement.style.removeProperty('cursor');
}

function syncWindowChrome() {
  const cluster = $('chromeDrawerCluster');
  if (cluster) cluster.hidden = !isDrawerVisiblyOpen();
  const topbar = $('chatTopbar');
  if (topbar) topbar.classList.toggle('has-chrome-balance', !isDrawerVisiblyOpen() && !workDock?.isOpen());
}

function isChromeInteractive(node) {
  // In the 36px caption zone, only real chrome controls and open dialogs/docks are interactive.
  return Boolean(node?.closest?.('dialog[open], #clientSettings, #workDock, .work-dock-resizer, .sidebar-resizer, #modeSegPill, button, a, input, textarea, select, option, [role="menuitem"], [role="menuitemradio"], [role="option"], .model-menu, .review-menu, .create-menu, .modal, .mention-menu, #identityBtn, #newBotBtn, #modeSwitch, #windowChrome button, #chromeMin, #chromeMax, #chromeClose, #chromeDrawerClose, #sidebarCollapseBtn, #sidebarExpandBtn'));
}

function resizeEdgeAt(x, y) {
  if (chromeState.isMaximized) return null;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const t = CHROME_EDGE_PX;
  const left = x <= t;
  const right = x >= w - t;
  const top = y <= t;
  const bottom = y >= h - t;
  if (top && left) return 'top-left';
  if (top && right) return 'top-right';
  if (bottom && left) return 'bottom-left';
  if (bottom && right) return 'bottom-right';
  if (left) return 'left';
  if (right) return 'right';
  if (top) return 'top';
  if (bottom) return 'bottom';
  return null;
}

function cursorForEdge(edge) {
  switch (edge) {
    case 'left':
    case 'right':
      return 'ew-resize';
    case 'top':
    case 'bottom':
      return 'ns-resize';
    case 'top-left':
    case 'bottom-right':
      return 'nwse-resize';
    case 'top-right':
    case 'bottom-left':
      return 'nesw-resize';
    default:
      return '';
  }
}

function bindChromeDrag(root) {
  if (!root) return;
  root.addEventListener('pointerdown', (event) => {
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (isChromeInteractive(event.target)) return;
    if (resizeEdgeAt(event.clientX, event.clientY)) return;
    postChrome('drag');
  });
  root.addEventListener('dblclick', (event) => {
    if (event.defaultPrevented) return;
    if (isChromeInteractive(event.target)) return;
    postChrome('dblclick');
  });
}

function syncChromeCloseTitle() {
  const closeBtn = $('chromeClose');
  if (!closeBtn) return;
  const trayEl = $('csCloseToTray');
  const toTray = trayEl ? trayEl.checked : (readClientSettings().closeToTray !== false);
  const label = toTray ? '收起到托盘' : '关闭窗口';
  closeBtn.title = label;
  closeBtn.setAttribute('aria-label', label);
}

function bindWindowChrome() {
  $('chromeMin')?.addEventListener('click', () => postChrome('minimize'));
  $('chromeMax')?.addEventListener('click', () => postChrome('maximize'));
  $('chromeClose')?.addEventListener('click', () => postChrome('close'));
  $('chromeDrawerClose')?.addEventListener('click', () => openDrawer(false));
  $('csCloseToTray')?.addEventListener('change', syncChromeCloseTitle);
  syncChromeCloseTitle();
  bindChromeDrag($('chatTopbar'));
  bindChromeDrag(document.querySelector('.sidebar-head'));
  bindChromeDrag($('drawerKeyrow'));
  const CHROME_CAPTION_PX = 36;
  let captionClick = { at: 0, x: 0, y: 0 }, lastCaptionDouble = 0;
  const isCaptionDragPoint = (event) => (
    event.button === 0
    && event.clientY <= CHROME_CAPTION_PX
    && !isChromeInteractive(event.target)
    && !resizeEdgeAt(event.clientX, event.clientY)
  );
  document.addEventListener('pointerdown', (event) => {
    if (!isCaptionDragPoint(event)) return;
    const now = performance.now();
    const doubleClick = captionClick.at > 0 && now - captionClick.at <= 500
      && Math.abs(event.clientX - captionClick.x) <= 8
      && Math.abs(event.clientY - captionClick.y) <= 8;
    captionClick = doubleClick ? { at: 0, x: 0, y: 0 } : { at: now, x: event.clientX, y: event.clientY };
    event.preventDefault();
    event.stopPropagation();
    if (doubleClick) { lastCaptionDouble = now; postChrome('dblclick'); }
    else postChrome('drag');
  }, true);
  document.addEventListener('dblclick', (event) => {
    if (event.button !== 0 || event.clientY > CHROME_CAPTION_PX || resizeEdgeAt(event.clientX, event.clientY)) return;
    if (isChromeInteractive(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    const now = performance.now();
    if (now - lastCaptionDouble < 600) return;
    lastCaptionDouble = now;
    postChrome('dblclick');
  }, true);
  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (isChromeInteractive(event.target)) return;
    const edge = resizeEdgeAt(event.clientX, event.clientY);
    if (!edge) return;
    event.preventDefault();
    postChrome('resize', { edge });
  }, true);
  document.addEventListener('pointermove', (event) => {
    if (event.buttons) return;
    if (isChromeInteractive(event.target)) {
      document.documentElement.style.removeProperty('cursor');
      return;
    }
    const edge = resizeEdgeAt(event.clientX, event.clientY);
    const cursor = cursorForEdge(edge);
    if (cursor) document.documentElement.style.cursor = cursor;
    else document.documentElement.style.removeProperty('cursor');
  });
  const host = window.chrome?.webview;
  if (host && typeof host.addEventListener === 'function') {
    const closeButton = $('chromeClose');
    if (closeButton) {
      closeButton.title = '关闭窗口，继续在后台运行';
      closeButton.setAttribute('aria-label', '收起到托盘');
    }
    host.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || data.source !== 'dimension-chrome') return;
      if (typeof data.isMaximized === 'boolean') setChromeMaximized(data.isMaximized);
    });
  }
  syncWindowChrome();
}

function isCreateMenuOpen() {
  const menu = $('createMenu');
  return Boolean(menu && !menu.hidden);
}

function placeCreateMenu() {
  const btn = $('newBotBtn');
  const menu = $('createMenu');
  if (!btn || !menu || menu.hidden) return;
  const gap = 8;
  const rect = btn.getBoundingClientRect();
  const menuHeight = menu.offsetHeight;
  const menuWidth = menu.offsetWidth || 200;
  let left = rect.left;
  let top = rect.bottom + gap;
  if (top + menuHeight > window.innerHeight - 8) {
    top = rect.top - gap - menuHeight;
  }
  if (left + menuWidth > window.innerWidth - 8) {
    left = Math.max(8, rect.right + gap);
    if (left + menuWidth > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - menuWidth - 8);
    }
  }
  const maxTop = Math.max(8, window.innerHeight - menuHeight - 8);
  top = Math.min(Math.max(8, top), maxTop);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function closeCreateMenu() {
  const menu = $('createMenu');
  const btn = $('newBotBtn');
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function openCreateMenu() {
  const menu = $('createMenu');
  const btn = $('newBotBtn');
  if (!menu || !btn) return;
  closeReviewMenu();
  closeModelMenu();
  closeBotContextMenu();
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  placeCreateMenu();
}

function toggleCreateMenu() {
  if (isCreateMenuOpen()) closeCreateMenu();
  else openCreateMenu();
}

function isSidebarSearchOpen() {
  const box = $('sidebarSearch');
  return Boolean(box && !box.hidden);
}

function syncSidebarSearchClear() {
  const input = $('sidebarSearchInput');
  const clear = $('sidebarSearchClear');
  if (!clear) return;
  clear.hidden = !String(input?.value || '');
}

function closeSidebarSearch() {
  const box = $('sidebarSearch');
  const input = $('sidebarSearchInput');
  const btn = $('searchBotBtn');
  if (box) box.hidden = true;
  if (input) input.value = '';
  if (btn) btn.setAttribute('aria-expanded', 'false');
  syncSidebarSearchClear();
  renderBotList();
}

function openSidebarSearch() {
  const box = $('sidebarSearch');
  const input = $('sidebarSearchInput');
  const btn = $('searchBotBtn');
  if (!box) return;
  box.hidden = false;
  if (btn) btn.setAttribute('aria-expanded', 'true');
  syncSidebarSearchClear();
  input?.focus();
}

function toggleSidebarSearch() {
  if (isSidebarSearchOpen()) closeSidebarSearch();
  else openSidebarSearch();
}

function toggleShellMode() {
  // Each mode restores only its own selected conversation. Background tasks keep running.
  setShellMode(isWorkShell() ? 'chat' : 'work');
}

/** 已启动的 bot：chat 或 work 任一模式调出过的，外加小草橘和当前激活。 */
function launchedBots() {
  const prefs = readSidebarPrefs();
  const ids = new Set([...(prefs.chatBots || []), ...(prefs.workBots || []), 'new-character']);
  if (state.botId) ids.add(state.botId);
  return dedupeBots(knownBots()).filter((bot) => bot?.id && ids.has(bot.id));
}

function createGroupCandidates() {
  // 建群只从已启动的 bot 里选；池子里的先调出再进群。
  return launchedBots();
}

function openCreateGroup() {
  const mode = state.shellMode;
  const selected = new Set();
  const draft = { query: '', name: '' };
  const checkSvg = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false"><path d="M2.2 6.2 4.7 8.6 9.8 3.3" stroke="#FFFFFF" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  showModal(`
    <div class="create-group-body">
      <div class="create-group-left">
        <div class="create-group-search">
          <svg class="create-group-search-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
            <circle cx="6.5" cy="6.5" r="4.25" stroke="currentColor" stroke-width="1.5"/>
            <path d="M10.15 10.15L13.5 13.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="butt"/>
          </svg>
          <input type="text" id="createGroupSearch" class="create-group-search-input" placeholder="搜索伙伴" aria-label="搜索伙伴" autocomplete="off">
        </div>
        <div class="create-group-classify" aria-disabled="true">
          <span class="create-group-classify-label">按分类创建</span>
          <span class="create-group-classify-note">后续升级</span>
        </div>
        <div class="create-group-select-title">选择 bot 创建</div>
        <div class="create-group-bots" id="createGroupBots"></div>
        <div class="create-group-select-title" style="margin-top:12px">从角色库拉新角色</div>
        <input id="createGroupLibSearch" class="setup-wiz-input" maxlength="40" placeholder="搜角色名或作品名…" autocomplete="off">
        <div class="bot-pool-list" id="createGroupLibResults"></div>
      </div>
      <div class="create-group-divider" aria-hidden="true"></div>
      <div class="create-group-right">
        <h2 class="create-group-title" id="createGroupTitle">创建群</h2>
        <input type="text" id="createGroupName" class="create-group-name" maxlength="40" placeholder="给这个群起个名字" aria-label="给这个群起个名字" autocomplete="off">
        <div class="create-group-count" id="createGroupCount">已选 0 个 bot</div>
        <div class="create-group-chips" id="createGroupChips"></div>
        <div class="create-group-owner">
          <label for="createGroupOwner" class="create-group-owner-label">群主（拆任务、派活、验收）</label>
          <select id="createGroupOwner" class="create-group-owner-select"></select>
        </div>
        <p class="create-group-msg" id="createGroupMsg"></p>
        <div class="create-group-actions">
          <button type="button" class="create-group-ok" id="createGroupOk" disabled>确定</button>
          <button type="button" class="create-group-cancel" data-close>取消</button>
        </div>
      </div>
    </div>`, false, 'create-group');
  const search = $('createGroupSearch');
  const nameInput = $('createGroupName');
  const list = $('createGroupBots');
  const count = $('createGroupCount');
  const chips = $('createGroupChips');
  const ok = $('createGroupOk');
  const msg = $('createGroupMsg');

  const visibleCandidates = () => {
    const query = String(draft.query || '').trim().toLowerCase();
    return createGroupCandidates().filter((bot) => botMatchesQuery(bot, query));
  };

  const refresh = () => {
    const bots = visibleCandidates();
    if (!list) return;
    if (!bots.length) {
      list.innerHTML = draft.query.trim() ? '<p class="create-group-empty">没有匹配的 bot</p>' : '';
    } else {
      list.innerHTML = bots.map((bot) => {
        const on = selected.has(bot.id);
        return `<button type="button" class="create-group-bot${on ? ' is-selected' : ''}" data-id="${escapeHtml(bot.id)}" aria-pressed="${on ? 'true' : 'false'}">
          <span class="create-group-check">${checkSvg}</span>
          <span class="seal-slot">${botAvatar(bot, 36)}</span>
          <span class="create-group-bot-name">${escapeHtml(bot.name || '')}</span>
        </button>`;
      }).join('');
    }
    const picked = createGroupCandidates().filter((bot) => selected.has(bot.id));
    if (count) count.textContent = `已选 ${picked.length} 个 bot`;
    const ownerSel = $('createGroupOwner');
    if (ownerSel) {
      const prev = ownerSel.value;
      ownerSel.innerHTML = picked.map((bot) => `<option value="${escapeHtml(bot.id)}">${escapeHtml(bot.name || '')}</option>`).join('');
      if (picked.some((bot) => bot.id === prev)) ownerSel.value = prev;
    }
    if (chips) {
      chips.innerHTML = picked.map((bot) => `<span class="create-group-chip"><span class="seal-slot">${botAvatar(bot, 24)}</span><span class="create-group-chip-name">${escapeHtml(bot.name || '')}</span></span>`).join('');
    }
    const named = String(nameInput?.value || '').trim();
    if (ok) ok.disabled = picked.length < 2 || !named;
  };

  list?.addEventListener('click', (event) => {
    const btn = event.target.closest('.create-group-bot');
    if (!btn?.dataset.id) return;
    if (selected.has(btn.dataset.id)) selected.delete(btn.dataset.id);
    else selected.add(btn.dataset.id);
    refresh();
  });
  search?.addEventListener('input', () => {
    draft.query = search.value;
    refresh();
  });
  nameInput?.addEventListener('input', refresh);
  ok?.addEventListener('click', async () => {
    if (ok.disabled) return;
    const ownerSel = $('createGroupOwner');
    try {
      const result = await api('/api/dimension/groups', {
        method: 'POST',
        body: JSON.stringify({
          name: String(nameInput?.value || '').trim(),
          members: [...selected],
          ownerId: ownerSel?.value || [...selected][0],
          ...(state.persistentGroupRosters ? { mode } : {}),
        }),
      });
      setKnownGroups(result.groups, mode);
      addGroupToRoster(result.group.id, mode);
      renderGroupSection();
      closeModal();
      if (state.shellMode === mode) await openGroup(result.group.id);
    } catch (err) {
      if (msg) msg.textContent = err.message;
    }
  });
  // 角色库：搜 → 点 → 引入（启用）→ 直接选进这个群
  const libResults = $('createGroupLibResults');
  let libTimer = 0;
  let libSeq = 0;
  const libSearch = async () => {
    const mySeq = ++libSeq;
    const q = String($('createGroupLibSearch')?.value || '').trim();
    if (!libResults) return;
    if (!q) { libResults.innerHTML = ''; return; }
    try {
      const data = await api(`/api/dimension/library?q=${encodeURIComponent(q)}`);
      if (mySeq !== libSeq) return;
      libResults.innerHTML = catalogResultRows(data.results) || '<p class="setup-wiz-hint">已导入的目录中没有匹配角色。</p>';
    } catch (error) { if (mySeq === libSeq) libResults.innerHTML = `<p class="setup-wiz-hint">${escapeHtml(error.message || '目录读取失败')}</p>`; }
  };
  $('createGroupLibSearch')?.addEventListener('input', () => {
    clearTimeout(libTimer);
    libTimer = setTimeout(libSearch, 200);
  });
  libResults?.addEventListener('click', async (event) => {
    const row = event.target.closest('.library-row');
    if (!row || row.dataset.busy === '1') return;
    row.dataset.busy = '1';
    try {
      const data = await api('/api/dimension/library/import', { method: 'POST', body: JSON.stringify(catalogIdentity(row)) });
      const botId = data.bot?.id;
      if (!botId) throw new Error('引入失败');
      if (Array.isArray(data.bots)) replaceKnownBots(data.bots);
      await addToRoster(botId);
      renderBotList();
      selected.add(botId);
      refresh();
      if (msg) msg.textContent = `「${data.bot.name}」已引入并选入`;
    } catch (err) {
      row.dataset.busy = '';
      if (msg) msg.textContent = err.message || '引入失败';
    }
  });
  refresh();
  search?.focus();
}


// ---- 群会话 ----
function bindGroupBar() {
  const bar = $('groupBar');
  if (!bar || bar.dataset.bound === '1') return;
  bar.dataset.bound = '1';
  bar.addEventListener('click', () => { openDrawer(true); renderGroupDrawer(); });
  $('groupBarMoreBtn')?.addEventListener('click', () => { openDrawer(true); renderGroupDrawer(); });
  $('groupChatPauseBtn')?.addEventListener('click', pauseGroupChat);
  $('groupInviteBtn')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const group = activeGroup();
    if (group) openGroupInvite(group);
  });
}

function activeGroup() {
  return knownGroups().find((g) => g && g.id === state.activeGroupId) || null;
}

/** 群消息行：支持物语剧场电影感旁白卡片、世界线分岔横幅、角色代入名牌、折叠思考过程与内联图片。 */
function addGroupMsg(from, text, quote, ts, messageId, messageSeq, identity = {}) {
  if (messageWasDeleted(quoteScope(), messageId)) return;
  const inserted = insertGroupMessage($('transcript'), { messageId, messageSeq }, () => {
  const rawText = String(text || '');
  const isStoryEvent = from === 'system' && (
    rawText.startsWith('✦ 世界线分岔') ||
    rawText.startsWith('✦ 剧情改写') ||
    rawText.startsWith('✦ 终章收束') ||
    rawText.startsWith('✦ 新篇章启幕') ||
    rawText.startsWith('✦ 命运检定') ||
    rawText.startsWith('🎲 D20')
  );
  const isNarrator = rawText.startsWith('【旁白】');
  const scope = quoteScope();
  const group = currentGroup();

  if (isStoryEvent) {
    const row = document.createElement('div');
    row.className = 'gmsg is-story-event';
    row.innerHTML = `<div class="gmsg-story-banner">${escapeHtml(rawText).replace(/\n/g, '<br>')}</div>`;
    return row;
  }

  if (isNarrator) {
    const row = document.createElement('div');
    row.className = 'gmsg is-narrator';
    const narBody = rawText.slice('【旁白】'.length).trim();
    const narLabel = (from && from !== 'system' && from !== 'user') ? `✦ 旁白 · ${botNameOf(from)}` : '✦ 旁白';
    row.innerHTML = `<div class="gmsg-main"><div class="gmsg-bubble"><div class="gmsg-narrator-kicker">${escapeHtml(narLabel)}</div><div class="gmsg-narrator-text"></div></div></div>`;
    const bodyEl = row.querySelector('.gmsg-narrator-text');
    renderRichMessage(bodyEl, narBody);
    row.messageSource = { sourceRef: sourceReference(identity.sourceRef), text: rawText, from, scope };
    return row;
  }

  const isUser = from === 'user';
  const row = document.createElement('div');
  row.className = `gmsg${isUser ? ' is-user' : ''}`;
  row.dataset.speaker = from || '';
  const bot = isUser ? null : (knownBots().find((b) => b.id === from) || { id: from, name: from });
  const quoteHtml = quote?.text
    ? `<div class="gmsg-quote"><span class="gmsg-quote-name">${escapeHtml(quote.from === 'user' ? '你' : botNameOf(quote.from))}</span><span class="gmsg-quote-text">${escapeHtml(String(quote.text).slice(0, 120))}</span></div>`
    : '';
  const timeText = ts ? new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  let castBadgeHtml = '';
  if (!isUser && group?.storyConfig?.enabled && group?.storyConfig?.roleCastEnabled && Array.isArray(group.storyConfig.roleCast)) {
    const cast = group.storyConfig.roleCast.find((c) => c?.botId === from && c?.roleName);
    if (cast) castBadgeHtml = `<span class="gmsg-cast-badge">饰 ${escapeHtml(cast.roleName)}</span>`;
  }
  row.innerHTML = `${isUser ? '' : `<span class="gmsg-avatar">${botAvatar(bot, 30)}</span>`}
    <div class="gmsg-main"><div class="gmsg-name">${escapeHtml(isUser ? '你' : botNameOf(from))}${castBadgeHtml}<span class="gmsg-time">${escapeHtml(timeText)}</span></div>${quoteHtml}<div class="gmsg-bubble"></div></div>
    <span class="gmsg-check" hidden></span>`;
  const bubble = row.querySelector('.gmsg-bubble');
  const members = (group?.members || []).map((id) => ({ id, name: botNameOf(id) }));
  if (isUser) {
    renderStickers(bubble, text, members.length ? value => highlightMentions(value, members) : undefined);
  } else {
    const osParsed = extractInnerVoice(text);
    renderRichMessage(bubble, osParsed.cleanText, { members, mentionMembers: members });
    if (group?.storyConfig?.enabled && group?.storyConfig?.innerVoiceEnabled && osParsed.innerVoice) {
      const osEl = document.createElement('div');
      osEl.className = 'chat-os-bubble';
      osEl.textContent = `内心 OS · ${osParsed.innerVoice}`;
      bubble.appendChild(osEl);
    }
  }
  hydrateChatImages(bubble);
  if (!isUser && identity.reasoning) prependReasoningFold(bubble, identity.reasoning);
  presentMessage(bubble, { ...identity, text, from }, scope);
  row.messageSource = { sourceRef: sourceReference(identity.sourceRef), text, from, scope };
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (state.groupSelecting) return;
    if (scope === quoteScope()) openChatMessageMenu(row.messageSource, event, bubble);
  });
  row.addEventListener('click', () => {
    if (!state.groupSelecting) return;
    row.classList.toggle('is-picked');
    row.dataset.picked = row.classList.contains('is-picked') ? '1' : '';
    syncGroupSelectBar();
  });
  return row;
  });
  if (!isWorkShell() && state.activeGroupId) {
    const rawText = String(text || '');
    const isNarrator = rawText.startsWith('【旁白】') || (from === 'system' && (rawText.startsWith('✦ 世界线分岔') || rawText.startsWith('✦ 剧情改写')));
    const g = currentGroup();
    let displaySpeaker = from === 'user' ? '你' : (from === 'system' ? '系统' : botNameOf(from));
    if (from && from !== 'user' && from !== 'system' && g?.storyConfig?.enabled && g?.storyConfig?.roleCastEnabled && Array.isArray(g.storyConfig.roleCast)) {
      const cast = g.storyConfig.roleCast.find((c) => c?.botId === from && c?.roleName);
      if (cast?.roleName) displaySpeaker = `${cast.roleName}（${botNameOf(from)}）`;
    }
    onGalgameGroupMessage({
      messageId,
      from: from || '',
      speakerName: displaySpeaker,
      text: rawText,
      history: Boolean(identity._galHistory || identity.history),
      isNarrator,
    });
  }
  return inserted;
}

/** 多选模式：行末出勾选圈，底部出操作条。 */
function setGroupSelecting(on) {
  state.groupSelecting = on;
  document.querySelector('#chatStage')?.classList.toggle('is-selecting', on);
  for (const row of document.querySelectorAll('#chatStage .gmsg')) {
    row.classList.remove('is-picked');
    row.dataset.picked = '';
  }
  syncGroupSelectBar();
}

function pickedGroupMsgs() {
  return [...document.querySelectorAll('#chatStage .gmsg.is-picked')].map((row) => {
    const nameEl = row.querySelector('.gmsg-name');
    // 名字节点里挂着 hover 时间戳，取第一个文本节点才是纯名字。
    const name = nameEl?.childNodes?.[0]?.textContent?.trim() || '';
    return { name, text: row.messageSource?.text || '', sourceRef: row.messageSource?.sourceRef, scope: row.messageSource?.scope };
  }).filter((m) => m.text);
}

function syncGroupSelectBar() {
  let bar = $('groupSelectBar');
  if (!state.groupSelecting) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'groupSelectBar';
    bar.className = 'group-select-bar';
    bar.innerHTML = `<span class="gsb-count"></span>
      <button type="button" class="gsb-btn" data-act="forward">转发</button>
      <button type="button" class="gsb-btn" data-act="copy">复制</button>
      <button type="button" class="gsb-btn" data-act="cancel">取消</button>`;
    bar.addEventListener('click', async (event) => {
      const act = event.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel') setGroupSelecting(false);
      else if (act === 'copy') {
        const text = pickedGroupMsgs().map((m) => `${m.name}：${m.text}`).join('\n');
        try { await copyMessageText(text); setGroupSelecting(false); messageActionNotice('已复制'); }
        catch (error) { messageActionNotice(error.message); }
      } else if (act === 'forward') {
        const picked = pickedGroupMsgs();
        if (picked.length) openForwardDialog(picked);
      }
    });
    $('composer')?.before(bar);
  }
  bar.querySelector('.gsb-count').textContent = `已选 ${pickedGroupMsgs().length} 条`;
}

/** 转发：目标是其他群（只记录不触发）或某个 bot 的私聊（进它的会话档，下次聊到能看到）。 */
function openForwardDialog(picked) {
  const sourceScope = quoteScope(), sourceMode = state.shellMode;
  if (sourceMode !== 'chat' || !picked.length || picked.some(item => item.scope !== sourceScope || !item.sourceRef?.messageId)) return;
  const [, sourceGroupId, sourceBotId] = JSON.parse(sourceScope);
  const groups = knownGroups().filter(g => g.id !== sourceGroupId && groupRosterIds().has(g.id));
  const bots = launchedBots().filter(bot => sourceGroupId || bot.id !== sourceBotId);
  if (!groups.length && !bots.length) { messageActionNotice('还没有其他会话可转发，请先添加 Bot 或群聊。'); return; }
  const messageIds = picked.map(item => item.sourceRef.messageId), retryIds = new Map();
  showModal(`
    <div class="create-bot-body">
      <h2 class="create-bot-title">转发 ${picked.length} 条到</h2>
      ${groups.length ? `<p class="create-bot-hint">群</p><div class="forward-targets">${groups.map((g) => `
        <button type="button" class="forward-target" data-kind="group" data-id="${escapeHtml(g.id)}">${escapeHtml(g.name || '')}</button>`).join('')}</div>` : ''}
      <p class="create-bot-hint">Bot 私聊（下次聊天时可看到）</p>
      <div class="forward-targets">${bots.map((b) => `
        <button type="button" class="forward-target" data-kind="bot" data-id="${escapeHtml(b.id)}">${escapeHtml(displayBotName(b) || b.name || b.id)}</button>`).join('')}</div>
      <p class="create-bot-msg" id="forwardMsg"></p>
    </div>`, false, 'create-bot');
  const dialog = document.querySelector('.create-bot-body');
  let busy = false;
  dialog?.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-id]');
    if (!btn || busy || !dialog.contains(btn)) return;
    const msg = document.getElementById('forwardMsg');
    if (sourceScope !== quoteScope()) { if (msg) msg.textContent = '来源会话已切换，请重新选择要转发的消息。'; return; }
    if (msg) msg.textContent = '转发中…';
    const targetKey = btn.dataset.kind + ':' + btn.dataset.id;
    if (!retryIds.has(targetKey)) retryIds.set(targetKey, crypto.randomUUID());
    const payload = { requestId: retryIds.get(targetKey), ...(sourceGroupId ? { sourceGroupId } : { sourceBotId }), sourceMode: 'chat', messageIds };
    busy = true;
    for (const target of dialog.querySelectorAll('[data-id]')) target.disabled = true;
    try {
      if (btn.dataset.kind === 'bot') {
        await api(`/api/dimension/bots/${encodeURIComponent(btn.dataset.id)}/forward`, {
          method: 'POST', body: JSON.stringify(payload),
        });
      } else {
        await api(`/api/dimension/groups/${encodeURIComponent(btn.dataset.id)}/record`, {
          method: 'POST', body: JSON.stringify(payload),
        });
      }
      if (dialog.isConnected) closeModal();
      if (sourceScope === quoteScope()) setGroupSelecting(false);
    } catch (err) {
      if (msg) msg.textContent = err.message || '转发失败';
    } finally { busy = false; for (const target of dialog.querySelectorAll('[data-id]')) target.disabled = false; }
  });
}

/** 引用条：挂到输入框上，发送时随消息带走。 */
function setGroupQuote(quote) {
  if (quote && !sourceReference(quote.sourceRef)) return;
  state.groupQuote = quote ? { ...quote, scope: quote.scope || quoteScope() } : null;
  const bar = $('groupQuoteBar');
  if (!bar) return;
  if (!quote) { bar.hidden = true; bar.textContent = ''; return; }
  bar.hidden = false;
  bar.innerHTML = `<span>引用 ${escapeHtml(quote.from === 'user' ? '你' : botNameOf(quote.from))}：${escapeHtml(String(quote.text).slice(0, 60))}</span><button type="button" class="gquote-x" id="groupQuoteX" aria-label="取消引用">×</button>`;
  $('groupQuoteX')?.addEventListener('click', () => setGroupQuote(null));
  $('composerInput')?.focus();
}

function takeGroupQuote() {
  const q = state.groupQuote || null;
  setGroupQuote(null);
  return q?.scope === quoteScope() ? q : null;
}

let storyStageSubpanel = ''; // '' | 'rewrite' | 'nodes'
let lastStoryForkSig = '';
let lastStoryEndingSig = '';
let storyRefreshTimer = null;
let storyRefreshRetryTimer = null;
let storyV3Ctrl = null;

function ensureStoryV3() {
  if (storyV3Ctrl) return storyV3Ctrl;
  storyV3Ctrl = createStoryTheaterV3Controller({
    api,
    toast,
    getActiveGroup: () => activeGroup(),
    botNameOf,
    onGroupUpdated: (res) => {
      if (res?.groups) state.groups = res.groups;
      else if (res?.group) {
        state.groups = knownGroups().map((r) => (r.id === res.group.id ? res.group : r));
      }
      renderStoryStageBar();
      if (isDrawerVisiblyOpen()) renderGroupDrawer({ loadJobs: false }).catch(() => {});
    },
    onRewind: (group, node, directive) => triggerStoryRewind(group, node, directive),
    onApplyBgUrl: (url, title) => setGalgameBackgroundUrl(url, title),
    getStageCgContext: (group) => {
      const snap = getGalgameCgSnapshot(group);
      const nodes = group?.storyConfig?.nodes || [];
      const latestNode = nodes.length ? nodes[nodes.length - 1] : null;
      return {
        ...snap,
        title: latestNode?.title || `${group?.name || '物语剧场'} · 第 ${Number(group?.storyConfig?.chapterCounter || 1)} 幕`,
      };
    },
  });
  return storyV3Ctrl;
}

async function handleStoryV3Action(act, groupArg = null) {
  const group = groupArg || activeGroup();
  if (!group?.id) return;
  const v3 = ensureStoryV3();
  if (act === 'bible') { v3.openBibleModal(group); return; }
  if (act === 'secrets') { v3.openSecretsModal(group); return; }
  if (act === 'tree') { v3.openWorldlineTreeModal(group); return; }
  if (act === 'finale') { v3.openFinaleModal(group); return; }
  if (act === 'cg') { v3.openCgGalleryModal(group); return; }
  if (act === 'cg-snap') { await v3.quickCaptureCg(group); return; }
  if (act === 'toggle-dice') {
    const nextDice = !Boolean(group.storyConfig?.diceMode);
    try {
      const res = await api(`/api/dimension/groups/${encodeURIComponent(group.id)}/story/secrets`, {
        method: 'PUT',
        body: JSON.stringify({ diceMode: nextDice }),
      });
      if (res?.groups) state.groups = res.groups;
      if (res?.group) group.storyConfig = res.group.storyConfig;
      renderStoryStageBar();
      toast(nextDice ? '已开启 TRPG D20 命运骰子检定模式' : '已关闭命运骰子模式');
    } catch (err) {
      toast(err?.message || '切换命运骰子模式失败');
    }
  }
}

async function triggerStoryAdvance(group, { opening = false, directive = '', diceRoll = null, rethrow = false } = {}) {
  if (!group?.id) return;
  let roll = diceRoll;
  if (!roll && !opening && directive && group.storyConfig?.diceMode) {
    roll = await rollFateDice(directive);
  }
  try {
    const payload = { opening, directive };
    if (roll) payload.diceRoll = roll;
    const res = await api(`/api/dimension/groups/${encodeURIComponent(group.id)}/story/advance`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (res?.groups) state.groups = res.groups;
    if (res?.group) group.storyConfig = res.group.storyConfig;
    storyStageSubpanel = '';
    renderStoryStageBar();
    toast(directive
      ? `${roll ? `命运检定 D20=${roll.value} · ` : ''}已记录剧情改写，旁白正在推进新走向…`
      : (opening ? '物语剧场已开演，旁白正在展开第一幕…' : '旁白正在承接演绎并推进下一幕…'));
  } catch (err) {
    toast(err?.message || '推进剧场失败');
    if (rethrow) throw err;
  }
}

async function triggerStoryRewind(group, node, directive = '') {
  if (!group?.id || !node?.id) return false;
  try {
    const res = await api(`/api/dimension/groups/${encodeURIComponent(group.id)}/story/rewind`, {
      method: 'POST',
      body: JSON.stringify({ nodeId: node.id, directive }),
    });
    if (res?.groups) state.groups = res.groups;
    if (res?.group) group.storyConfig = res.group.storyConfig;
    storyStageSubpanel = '';
    renderStoryStageBar();
    toast(`已回溯至「第 ${node.chapter || 1} 幕」并开启平行 IF 线…`);
    return true;
  } catch (err) {
    toast(err?.message || '世界线回溯失败');
    return false;
  }
}

function refreshActiveGroupStoryState(groupId, { retryIfNoFork = false } = {}) {
  if (!groupId || state.activeGroupId !== groupId || isWorkShell()) return;
  clearTimeout(storyRefreshTimer);
  clearTimeout(storyRefreshRetryTimer);
  const pullOnce = async (allowRetry) => {
    try {
      const data = await api(`/api/dimension/groups/${encodeURIComponent(groupId)}?limit=1&mode=discuss`);
      if (data?.group && state.activeGroupId === groupId) {
        state.groups = knownGroups().map((row) => (row.id === groupId ? data.group : row));
        const pf = data.group.storyConfig?.pendingFork;
        const hasChoices = Boolean(pf?.choices?.length);
        const forkSig = hasChoices ? JSON.stringify([groupId, pf.prompt || '', pf.choices]) : '';
        if (hasChoices && forkSig !== lastStoryForkSig) {
          lastStoryForkSig = forkSig;
          storyStageSubpanel = '';
        } else if (!hasChoices) {
          lastStoryForkSig = '';
        }
        const ec = data.group.storyConfig?.endingCard;
        const endSig = ec?.title ? `${groupId}|${ec.title}|${ec.createdAt || ''}` : '';
        if (endSig && endSig !== lastStoryEndingSig) {
          const hadPrev = Boolean(lastStoryEndingSig);
          lastStoryEndingSig = endSig;
          if (!hadPrev || allowRetry) {
            toast(`终章达成「${ec.title}」（${ec.rank || 'True End'}）· 点击「结局纪念卡」赏析`);
          }
        } else if (!endSig) {
          lastStoryEndingSig = '';
        }
        renderStoryStageBar();
        if (isDrawerVisiblyOpen()) renderGroupDrawer({ loadJobs: false }).catch(() => {});
        if (allowRetry && !hasChoices && data.group.storyConfig?.enabled) {
          storyRefreshRetryTimer = setTimeout(() => {
            if (state.activeGroupId === groupId && !isWorkShell()) pullOnce(false);
          }, 950);
        }
      }
    } catch { /* ignore transient refresh errors */ }
  };
  storyRefreshTimer = setTimeout(() => pullOnce(retryIfNoFork), 260);
}

function renderStoryStageBar() {
  const bar = $('storyStageBar');
  const group = activeGroup();
  const sc = group?.storyConfig;
  syncGalgameStoryState(group && !isWorkShell() && sc?.enabled ? sc : null);
  if (!bar) return;
  if (!group || isWorkShell() || !sc?.enabled) {
    bar.hidden = true;
    bar.innerHTML = '';
    return;
  }
  bar.hidden = false;
  const nodes = Array.isArray(sc.nodes) ? sc.nodes : [];
  const chap = Number(sc.chapterCounter || nodes.length || 0);
  const wl = sc.worldline || '主线';
  const castCount = sc.roleCastEnabled && Array.isArray(sc.roleCast) ? sc.roleCast.length : 0;
  const fork = sc.pendingFork;
  const hasFork = Boolean(fork && Array.isArray(fork.choices) && fork.choices.length > 0);

  let html = `<div class="story-stage-top">
    <div class="story-stage-status">
      <span class="story-stage-pill">${escapeHtml(wl)}</span>
      <span>${chap > 0 ? `第 ${chap} 幕` : '待开演'}</span>
      ${castCount ? `<span class="story-stage-sep" aria-hidden="true"></span><span class="story-stage-submeta">角色代入 ${castCount} 人</span>` : ''}
    </div>
    <div class="story-stage-actions">
      <button type="button" class="story-stage-btn" data-story-act="enter">进入剧场</button>
      <button type="button" class="story-stage-btn is-primary" data-story-act="advance">${chap > 0 ? '下一幕' : '开演'}</button>
      <button type="button" class="story-stage-btn${storyStageSubpanel === 'rewrite' ? ' is-primary' : ''}" data-story-act="toggle-rewrite">改写走向</button>
      ${chap > 0 ? '<button type="button" class="story-stage-btn" data-story-act="export">导出剧本</button>' : ''}
    </div>
  </div>`;

  const secCnt = sc.secretNotes && typeof sc.secretNotes === 'object'
    ? Object.values(sc.secretNotes).filter((v) => String(v || '').trim()).length
    : 0;
  const cgCnt = Array.isArray(sc.cgs) ? sc.cgs.length : 0;
  const hasEnding = Boolean(sc.endingCard && sc.endingCard.title);
  html += `<div class="story-v3-toolbar">
    <button type="button" class="story-v3-chip${sc.storyBible ? ' is-active' : ''}" data-story-v3="bible" title="查看或编辑长期剧情账本与未解伏笔">${v3Icon('bible')}<span>剧情账本</span>${sc.storyBible ? '<span class="stv3-dot"></span>' : ''}</button>
    <button type="button" class="story-v3-chip${secCnt || sc.innerVoiceEnabled ? ' is-active' : ''}" data-story-v3="secrets" title="给单个角色塞私密底牌 & 开关读心心声">${v3Icon('secret')}<span>导演密信</span>${secCnt ? `<span class="stv3-count">${secCnt}</span>` : (sc.innerVoiceEnabled ? '<span class="stv3-dot"></span>' : '')}</button>
    <button type="button" class="story-v3-chip" data-story-v3="tree" title="打开可视化世界线分岔图谱与回溯">${v3Icon('tree')}<span>世界线树</span>${nodes.length ? `<span class="stv3-count">${nodes.length}</span>` : ''}</button>
    <button type="button" class="story-v3-chip${sc.diceMode ? ' is-active' : ''}" data-story-v3="toggle-dice" title="开关 TRPG D20 命运骰子检定">${v3Icon('dice')}<span>命运骰子</span>${sc.diceMode ? '<span class="stv3-dot"></span>' : ''}</button>
    <button type="button" class="story-v3-chip" data-story-v3="cg" title="定格 16:9 电影感剧场 CG 与回想画廊">${v3Icon('cg')}<span>剧场画廊</span>${cgCnt ? `<span class="stv3-count">${cgCnt}</span>` : ''}</button>
    <button type="button" class="story-v3-chip${hasEnding ? ' is-ending' : ' is-finale-plain'}" data-story-v3="finale" title="${hasEnding ? '查看典藏结局纪念卡或开启第二季' : '回收全部伏笔并揭晓本世界线大结局'}">${v3Icon(hasEnding ? 'trophy' : 'finale')}<span>${hasEnding ? '结局纪念卡' : '收束终章'}</span></button>
  </div>`;

  if (storyStageSubpanel === 'nodes' && nodes.length) {
    html += `<div class="story-stage-nodes-drawer">
      ${[...nodes].reverse().map((n) => `<div class="group-story-node-item">
        <div class="group-story-node-meta">
          <div class="group-story-node-title">${String(n.title || '').startsWith('第 ') ? escapeHtml(n.title) : `第 ${escapeHtml(String(n.chapter || 1))} 幕 · ${escapeHtml(n.title || '剧情节点')}`}</div>
          <div class="group-story-node-sub">${escapeHtml(n.worldline || '主线')}${n.directive ? ` · ${escapeHtml(n.directive.slice(0, 28))}` : ''}</div>
        </div>
        <button type="button" class="group-story-rewind-btn" data-stage-rewind="${escapeHtml(n.id)}">回溯此幕</button>
      </div>`).join('')}
    </div>`;
  }
  if (hasFork) {
    html += `<div class="story-fork-box">
      <div class="story-fork-prompt">✦ 命运分岔 · ${escapeHtml(fork.prompt || '选择世界线走向，或亲自改写这一幕')}</div>
      <div class="story-fork-choices">
        ${fork.choices.map((c) => `<button type="button" class="story-fork-choice-btn" data-fork-label="${escapeHtml(c.label)}"><strong>${escapeHtml(c.id || '•')}.</strong> ${escapeHtml(c.label)}</button>`).join('')}
      </div>
      <div class="story-rewrite-row">
        <input type="text" class="story-rewrite-input" id="storyForkCustomInput" placeholder="或写下你想改写的剧情转折（例如：电次提前冲出咖啡馆拦住玛琪玛…）">
        <button type="button" class="story-stage-btn is-primary" id="storyForkCustomSend">确认改写</button>
      </div>
    </div>`;
  } else if (storyStageSubpanel === 'rewrite') {
    html += `<div class="story-fork-box">
      <div class="story-fork-prompt">✦ 幕后改写 · 旁观者视角也能直接介入剧情走向</div>
      <div class="story-rewrite-row">
        <input type="text" class="story-rewrite-input" id="storyRewriteInput" placeholder="输入下一幕想改写的转折或事件…">
        <button type="button" class="story-stage-btn is-primary" id="storyRewriteSend">确认改写</button>
      </div>
    </div>`;
  }

  bar.innerHTML = html;

  bar.querySelector('[data-story-act="enter"]').onclick = () => $('galModeToggleBtn')?.click();
  bar.querySelector('[data-story-act="advance"]')?.addEventListener('click', () => {
    triggerStoryAdvance(group, { opening: chap === 0 });
  });
  bar.querySelectorAll('[data-story-v3]').forEach((btn) => {
    btn.addEventListener('click', () => {
      void handleStoryV3Action(btn.dataset.storyV3, group);
    });
  });
  bar.querySelector('[data-story-act="toggle-rewrite"]')?.addEventListener('click', () => {
    if (hasFork) {
      storyStageSubpanel = '';
      renderStoryStageBar();
      const inp = $('storyForkCustomInput');
      if (inp) {
        inp.focus();
        inp.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      return;
    }
    storyStageSubpanel = storyStageSubpanel === 'rewrite' ? '' : 'rewrite';
    renderStoryStageBar();
    $('storyRewriteInput')?.focus();
  });
  bar.querySelector('[data-story-act="toggle-nodes"]')?.addEventListener('click', () => {
    storyStageSubpanel = storyStageSubpanel === 'nodes' ? '' : 'nodes';
    renderStoryStageBar();
  });
  bar.querySelector('[data-story-act="export"]')?.addEventListener('click', async () => {
    try {
      const res = await api(`/api/dimension/groups/${encodeURIComponent(group.id)}/story/export`);
      const blob = new Blob([res?.markdown || ''], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = res?.filename || `${group.name || 'story'}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(`已导出轻小说剧本「${a.download}」`);
    } catch (err) {
      toast(err?.message || '导出物语失败');
    }
  });
  bar.querySelectorAll('[data-fork-label]').forEach((btn) => {
    btn.addEventListener('click', () => {
      triggerStoryAdvance(group, { opening: false, directive: btn.dataset.forkLabel || '' });
    });
  });
  const bindCustomInput = (inputId, btnId) => {
    const inp = $(inputId);
    const btn = $(btnId);
    if (!inp || !btn) return;
    const submit = () => {
      const val = inp.value.trim();
      if (!val) { toast('请先输入你想改写的剧情走势'); inp.focus(); return; }
      triggerStoryAdvance(group, { opening: false, directive: val });
    };
    btn.addEventListener('click', submit);
    bindStorySubmit(inp, submit);
  };
  bindCustomInput('storyForkCustomInput', 'storyForkCustomSend');
  bindCustomInput('storyRewriteInput', 'storyRewriteSend');
  bar.querySelectorAll('[data-stage-rewind]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetNode = nodes.find((x) => x.id === btn.dataset.stageRewind);
      if (!targetNode) return;
      const itemEl = btn.closest('.group-story-node-item');
      if (!itemEl) return;
      const existing = itemEl.querySelector('.group-inline-rewind-row');
      if (existing) { existing.remove(); itemEl.classList.remove('has-inline-rewind'); return; }
      itemEl.classList.add('has-inline-rewind');
      const row = document.createElement('div');
      row.className = 'group-inline-rewind-row';
      row.innerHTML = `<input type="text" class="story-rewrite-input" placeholder="输入从第 ${escapeHtml(String(targetNode.chapter || 1))} 幕改写的走向（留空直接重演）…">
        <button type="button" class="story-stage-btn is-primary">开启 IF 线</button>`;
      itemEl.appendChild(row);
      const inp = row.querySelector('input');
      const goBtn = row.querySelector('button');
      const run = () => triggerStoryRewind(group, targetNode, inp.value.trim());
      goBtn.addEventListener('click', run);
      bindStorySubmit(inp, run);
      inp.focus();
    });
  });
}

async function openGroup(id, { keepNotice } = {}) {
  closeMessageMenu();
  state.groupUpdates?.close(); state.groupUpdates = null;
  workSession.close();
  state.historyAbort?.abort(); state.groupAbort?.abort(); state.groupAbort = new AbortController();
  const ticket = state.groupLoadTicket = (state.groupLoadTicket || 0) + 1;
  // 进群前把当前现场整棵缓存（单聊或某个 bot 的 work 视图），退群时原样恢复，不重连、不重放。
  if (!state.activeGroupId) {
    const previousBot = state.lastSelectedBots[state.shellMode];
    state.savedPreGroupSelection = { mode: state.shellMode, value: previousBot ? { kind: 'bot', id: previousBot } : null };
    state.savedPreGroupNodes = [...$('transcript').childNodes];
    state.savedPreGroupMode = state.shellMode; state.savedPreGroupBotId = state.botId;
  }
  state.activeGroupId = id;
  state.selections[state.shellMode] = { kind: 'group', id };
  storyStageSubpanel = '';
  lastStoryForkSig = '';
  lastStoryEndingSig = '';
  if (isWorkShell()) sidebarActivity.acknowledgeGroup(id);
  setGroupSelecting(false); setGroupQuote(null);
  const transcript = $('transcript'); transcript.innerHTML = '';
  syncConversationChrome(); renderBotList();
  const mode = isWorkShell() ? 'work' : 'discuss';
  setPending(groupStreams.busy(id, mode));
  const data = await api(`/api/dimension/groups/${encodeURIComponent(id)}?limit=30&mode=${mode}`, { signal: state.groupAbort.signal });
  if (state.groupLoadTicket !== ticket || state.activeGroupId !== id) return;
  if (data.chatting) remoteChatActive.add(id); else remoteChatActive.delete(id);
  const group = data.group;
  state.groups = knownGroups().map(row => row.id === id ? group : row);
  if (!isWorkShell()) {
    if (!keepNotice) addBubble('assistant', `已进入群「${group.name}」。Chat 里大家自由接话，随时可以加入；要派任务时切到 Work。`, '系统');
    changeTranscript(transcript, () => { for (const m of data.messages || []) {
      addGroupMsg(m.from, m.text, m.quote, m.ts, m.messageId, m.messageSeq, { ...m, _galHistory: true });
    } });
    if (data.hasMore) installEarlierGroupHistory(id, data.before, ticket, mode);
    // 切换群聊回到剧场群时稳稳滚动到最新一幕底部，避免重置到消息流最顶端
    const pinGroupBottom = () => {
      if (state.activeGroupId !== id || isWorkShell()) return;
      transcript.scrollTop = transcript.scrollHeight;
    };
    requestAnimationFrame(() => { pinGroupBottom(); requestAnimationFrame(pinGroupBottom); });
    setTimeout(pinGroupBottom, 120);
  }
  await ensureMemberBots(group?.members || []);
  if (state.groupLoadTicket !== ticket || state.activeGroupId !== id) return;
  renderGroupSection();
  syncGroupModeSwitch();
  syncConversationChrome();
  setPending(groupStreams.busy(id, mode));
  workUi?.sync();
  if (isWorkShell()) {
    const leadId = group?.ownerId || group?.members?.[0] || state.botId;
    const gFocus = state.pendingGroupWorkFocus?.groupId === id ? state.pendingGroupWorkFocus : null;
    if (gFocus) state.pendingGroupWorkFocus = null;
    await workSession.open({
      botId: leadId,
      groupId: id,
      ...(gFocus?.runId ? { focusRunId: gFocus.runId } : {}),
      ...(gFocus?.newThread ? { newThread: true } : {}),
    });
    if (!workSession.isNewThread() && data.messages?.some(row => row.mode === 'work')) {
      const history = document.createElement('details'); history.className = 'work-legacy';
      const title = document.createElement('summary'); title.textContent = '早期群工作记录'; history.append(title);
      for (const row of data.messages.filter(row => row.mode === 'work')) {
        const text = document.createElement('div'); text.className = 'work-message'; text.textContent = `${botNameOf(row.from)}：${row.text}`; history.append(text);
      }
      appendTranscript(transcript, history);
    }
    workRosterTree?.render();
  }
  else if (typeof EventSource === 'function') {
    const after = Math.max(0, ...(data.messages || []).map(row => row.messageSeq || 0));
    const updates = new EventSource(`/api/dimension/groups/${encodeURIComponent(id)}/events?after=${after}`);
    state.groupUpdates = updates;
    updates.onmessage = event => {
      if (state.groupUpdates !== updates || state.activeGroupId !== id || state.groupLoadTicket !== ticket || isWorkShell()) return;
      try {
        const row = JSON.parse(event.data);
        if (row.kind === 'typing') {
          const g = activeGroup();
          syncChatGroupStarTyping(row.from, row.botName || (row.from ? botNameOf(row.from) : ''));
          if (row.from) {
            const bot = knownBots().find((b) => b.id === row.from) || { id: row.from, name: row.botName || botNameOf(row.from) };
            upsertSpeaking($('transcript'), row.from, row.botName || botNameOf(row.from), botAvatar(bot, 30));
          } else {
            clearSpeaking($('transcript'));
            if (g?.storyConfig?.enabled) {
              refreshActiveGroupStoryState(id, { retryIfNoFork: false });
            }
          }
          return;
        }
        if (row.mode === 'discuss') {
          clearSpeaking($('transcript'), row.from);
          syncChatGroupStarTyping('', '', row.from);
          sidebarActivity.message('chat', 'group', id, row.ts);
          addGroupMsg(row.from, row.text, row.quote, row.ts, row.messageId, row.messageSeq, row);
          if (activeGroup()?.storyConfig?.enabled && (
            String(row.text || '').startsWith('【旁白】') ||
            String(row.text || '').startsWith('✦ 世界线分岔') ||
            String(row.text || '').startsWith('✦ 剧情改写') ||
            String(row.text || '').startsWith('✦ 终章收束') ||
            String(row.text || '').startsWith('✦ 新篇章启幕') ||
            String(row.text || '').startsWith('✦ 命运检定') ||
            String(row.text || '').startsWith('🎲 D20')
          )) {
            refreshActiveGroupStoryState(id, { retryIfNoFork: true });
          }
        }
      } catch { /* Reconnect replays saved messages. */ }
    };
  }
}

function installEarlierGroupHistory(id, before, ticket, mode) {
  const transcript = $('transcript'), button = document.createElement('button'); button.type = 'button'; button.className = 'chat-history-more group-history-more'; button.textContent = '加载更多消息'; transcript.prepend(button);
  button.onclick = async () => {
    button.disabled = true;
    try {
      const data = await api(`/api/dimension/groups/${encodeURIComponent(id)}?limit=30&before=${before}&mode=${mode}`, { signal: state.groupAbort.signal });
      if (state.activeGroupId !== id || state.groupLoadTicket !== ticket) return;
      const height = transcript.scrollHeight, top = transcript.scrollTop, anchor = button.nextSibling;
      changeTranscript(transcript, () => { for (const message of data.messages || []) transcript.insertBefore(addGroupMsg(message.from, message.text, message.quote, message.ts, message.messageId, message.messageSeq, { ...message, _galHistory: true }), anchor); }, { prepend: true });
      button.remove(); if (data.hasMore) installEarlierGroupHistory(id, data.before, ticket, mode);
      transcript.scrollTop = top + transcript.scrollHeight - height;
    } catch (error) { if (button.isConnected) button.textContent = '加载失败，点击重试'; }
    finally { button.disabled = false; }
  };
}

let lastChatGroupSpeaker = '';

function syncChatGroupStarTyping(typingBotId, typingName = '', finishedSpeakerId = '') {
  onGalgameGroupTyping(typingBotId || '', typingName || (typingBotId ? botNameOf(typingBotId) : ''));
  const wrap = $('groupBarWrap');
  const avHost = $('groupBarAvatars');
  if (!wrap || wrap.hidden || !avHost) return;
  if (finishedSpeakerId && finishedSpeakerId !== 'user') {
    lastChatGroupSpeaker = finishedSpeakerId;
  }
  const seats = [...avHost.querySelectorAll('.star-seat[data-member-id]')];
  for (const s of seats) {
    const mid = s.dataset.memberId;
    const isNow = Boolean(typingBotId && mid === typingBotId);
    s.classList.toggle('is-typing', isNow);
    const stNode = s.querySelector('.seat-hover-state');
    if (stNode) stNode.textContent = isNow ? '正在输入回复…' : (s.classList.contains('is-lead') ? '群主 · 在线' : '群成员 · 在线');
  }
  if (typingBotId && lastChatGroupSpeaker && lastChatGroupSpeaker !== typingBotId) {
    const fromEl = avHost.querySelector(`.star-seat[data-member-id="${CSS.escape(lastChatGroupSpeaker)}"]`);
    const toEl = avHost.querySelector(`.star-seat[data-member-id="${CSS.escape(typingBotId)}"]`);
    if (fromEl && toEl) {
      shootRelayArc(wrap, fromEl, toEl, { color: 'var(--color-accent)' });
      lastChatGroupSpeaker = typingBotId;
    }
  } else if (typingBotId && !lastChatGroupSpeaker) {
    lastChatGroupSpeaker = typingBotId;
  }
}

function syncGroupBar(group) {
  const bar = $('groupBar');
  const wrap = $('groupBarWrap');
  if (!bar) return;
  // Work Group uses its own dedicated Star-Rail Roundtable Header; never duplicate Chat's group bar!
  if (!group || isWorkShell()) {
    if (wrap) wrap.hidden = true;
    bar.hidden = true;
    lastChatGroupSpeaker = '';
    return;
  }
  if (wrap) {
    wrap.hidden = false;
    ensureRelaySvg(wrap);
  }
  bar.hidden = false;
  $('groupBarSeal').innerHTML = groupAvatar(group, 32);
  $('groupBarName').textContent = group.name;
  if ($('groupBarMeta')) {
    $('groupBarMeta').textContent = `${(group.members || []).length} 位成员`;
    delete $('groupBarMeta').dataset.typing;
  }
  const avHost = $('groupBarAvatars');
  if (avHost) {
    const ownerId = group.ownerId || (group.members || [])[0] || '';
    const memberIds = group.members || [];
    avHost.innerHTML = memberIds.map((mid) => {
      const mb = knownBots().find((b) => b.id === mid) || { id: mid, name: botNameOf(mid) };
      const mName = botNameOf(mid);
      const isLead = mid === ownerId;
      return `<button type="button" class="star-seat${isLead ? ' is-lead' : ''}" data-member-id="${escapeHtml(mid)}">
        <span class="star-seat-ring">${botAvatar(mb, isLead ? 34 : 32)}${isLead ? '<span class="star-lead-crown">✦</span>' : ''}</span>
        <span class="star-seat-label">${escapeHtml(mName)}</span>
        <span class="seat-hover-card">
          <span class="seat-hover-title"><strong>${escapeHtml(mName)}</strong><span class="seat-hover-id">#${escapeHtml(String(mid).slice(0, 10))}</span></span>
          <span class="seat-hover-state">${isLead ? '群主 · 在线' : '群成员 · 在线'}</span>
          <span class="seat-hover-duty">群组：${escapeHtml(group.name)} · 点击查看群详情</span>
        </span>
      </button>`;
    }).join('');
    avHost.querySelectorAll('.star-seat').forEach((btn) => {
      btn.onclick = () => { openDrawer(true); renderGroupDrawer(); };
    });
  }
  syncGroupChatControls();
}

function syncGroupChatControls() {
  const button = $('groupChatPauseBtn');
  if (button) button.hidden = !state.activeGroupId || !(remoteChatActive.has(state.activeGroupId) || groupStreams.busy(state.activeGroupId, 'discuss'));
}

async function pauseGroupChat() {
  const id = state.activeGroupId;
  if (!id) return;
  try {
    await api(`/api/dimension/groups/${encodeURIComponent(id)}/chat/stop`, { method: 'POST', body: '{}' });
    remoteChatActive.delete(id);
    if (state.activeGroupId === id) { clearSpeaking($('transcript')); syncGroupChatControls(); }
  } catch (error) { if (state.activeGroupId === id) addBubble('assistant', `暂停失败：${error.message}`, '系统'); }
}

function botNameOf(id) {
  if (id === 'system') return '系统';
  const bot = (state.bots || []).find((b) => b.id === id);
  return bot?.name || id;
}

function botNameOfFallback(id) { return botNameOf(id); }

function syncGroupModeSwitch() {
  // 讨论/派活跟随外壳 Chat/Work 开关，不再单独渲染切换。
  $('groupModeSwitch')?.remove();
}

const groupSendRetries = new Map();
async function sendGroup(text, { mode = isWorkShell() ? 'work' : 'discuss' } = {}) {
  const id = state.activeGroupId;
  const shellMode = state.shellMode;
  const ticket = groupStreams.begin(id, mode);
  const visible = () => state.activeGroupId === id && state.shellMode === shellMode && groupStreams.current(ticket);
  const thoughts = createThoughtStream({ getTranscript: () => $('transcript'), visible: () => visible() && ticket.mode === 'work', nameOf: botNameOf });
  const quote = takeGroupQuote();
  const retryKey = JSON.stringify({ id, mode, text, quote: quote?.sourceRef });
  const requestId = groupSendRetries.get(retryKey) || crypto.randomUUID();
  groupSendRetries.set(retryKey, requestId);
  if (groupSendRetries.size > 32) groupSendRetries.delete(groupSendRetries.keys().next().value);
  if (mode === 'discuss') { clearSpeaking($('transcript')); syncGroupChatControls(); }
  const submittedRow = addGroupMsg('user', text, quote);
  setPending(true);
  let streamRunId = null;
  try {
    const res = await fetch(`/api/dimension/groups/${encodeURIComponent(id)}/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, workBotId: state.botId, mode, requestId, ...(quote ? { quote: quote.sourceRef } : {}) }),
    });
    if (!res.ok) {
      if (submittedRow.isConnected) submittedRow.remove();
      const input = $('composerInput');
      if (visible() && input && !input.value) {
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        if (quote) setGroupQuote(quote);
      }
      let detail = await res.text();
      try { const failure = JSON.parse(detail); detail = failure.error || failure.message || detail; } catch {}
      throw new Error(detail);
    }
    if (!res.body) throw new Error('服务没有返回任务流');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf(String.fromCharCode(10,10))) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 2);
        const payload = line.split('\n').filter(row => row.startsWith('data:')).map(row => row.slice(5).trim()).join('\n');
        if (!payload) continue;
        const ev = JSON.parse(payload);
        if (ev.kind === 'run') {
          streamRunId = ev.runId;
          groupStreams.setMode(ticket, ev.mode || mode);
          if (groupStreams.current(ticket) && ticket.mode === 'discuss') remoteChatActive.add(id);
          if (ev.mode === 'work' && streamRunId && groupSendRetries.get(retryKey) === requestId) {
            groupSendRetries.delete(retryKey);
          }
          if (ev.mode === 'work' && groupStreams.current(ticket)) {
            // The server accepted an explicit work request from Chat. Attach the durable view.
            addGroupToRoster(id, 'work');
            if (!visible()) continue;
            if (!isWorkShell()) { state.selections.work = { kind: 'group', id }; setShellMode('work'); }
            else await openGroup(id, { keepNotice: true });
            await reader.cancel();
            return;
          }
        }
        if (!visible()) continue;
        if (ticket.mode !== 'work' && ['speaking', 'think', 'process', 'status', 'plan', 'tool'].includes(ev.kind)) continue;
        if (ev.kind === 'run' && ticket.mode === 'discuss') { syncGroupChatControls(); continue; }
        if (ev.kind === 'typing' && ticket.mode === 'discuss') {
          syncChatGroupStarTyping(ev.from, ev.botName || (ev.from ? botNameOf(ev.from) : ''));
          if (ev.from) {
            const bot = knownBots().find((b) => b.id === ev.from) || { id: ev.from, name: ev.botName || botNameOf(ev.from) };
            upsertSpeaking($('transcript'), ev.from, ev.botName || botNameOf(ev.from), botAvatar(bot, 30));
          } else {
            clearSpeaking($('transcript'));
          }
          continue;
        }
        if (ev.kind === 'result') thoughts.settle(ev.from);
        if (ticket.mode === 'work' && handleWorkEvent(ev)) continue;
        if (ev.kind === 'speaking' && ev.from) {
          const bot = knownBots().find((b) => b.id === ev.from) || { id: ev.from, name: botNameOf(ev.from) };
          upsertSpeaking($('transcript'), ev.from, botNameOf(ev.from), botAvatar(bot, 30));
        } else if (ev.kind === 'say') {
          if (ev.from === 'user' && submittedRow.isConnected) submittedRow.remove();
          clearSpeaking($('transcript'), ev.from);
          syncChatGroupStarTyping('', '', ev.from);
          thoughts.settle(ev.from);
          addGroupMsg(ev.from, ev.text, ev.quote, ev.ts, ev.messageId, ev.messageSeq, ev);
          if (activeGroup()?.storyConfig?.enabled && (String(ev.text || '').startsWith('【旁白】') || String(ev.text || '').startsWith('✦ 世界线分岔') || String(ev.text || '').startsWith('✦ 剧情改写'))) {
            refreshActiveGroupStoryState(id, { retryIfNoFork: true });
          }
        } else if (ev.kind === 'silent') {
          clearSpeaking($('transcript'), ev.from);
          thoughts.settle(ev.from);
        } else if (ev.kind === 'think') thoughts.think(ev.from, ev.text);
        else if (ev.kind === 'process') thoughts.process(ev.from, ev.text);
        else if (ev.kind === 'status') { if (ev.from) thoughts.process(ev.from, ev.text); const g = typeof activeGroup === 'function' ? activeGroup() : null; if (g) renderGroupKanban(g).catch(() => {}); }
        else if (ev.kind === 'skill') addBubble('assistant', `沉淀了经验：${ev.text}`, '系统');
        else if (ev.kind === 'error') { thoughts.finish(); addBubble('assistant', `出错了：${ev.text}`, '系统'); }
      }
    }
    if (groupSendRetries.get(retryKey) === requestId) groupSendRetries.delete(retryKey);
  } catch (err) {
    if (submittedRow.isConnected) submittedRow.remove();
    if (visible() && !$('composerInput').value) {
      $('composerInput').value = text; autoGrow($('composerInput'));
      conversationDrafts.capture(text); syncSendEnabled($('composerInput'), $('sendBtn'));
      if (quote) setGroupQuote(quote);
    }
    if (visible()) addBubble('assistant', `出错了：${err.message}`, '系统');
  } finally {
    thoughts.finish();
    const wasVisible = visible();
    if (groupStreams.finish(ticket) && ticket.mode === 'discuss') remoteChatActive.delete(id);
    if (wasVisible) {
      clearSpeaking($('transcript'));
      if (ticket.mode === 'work') workSession.refresh();
      else setPending(groupStreams.busy(id));
      syncGroupChatControls();
      if (ticket.mode === 'discuss' && activeGroup()?.storyConfig?.enabled) {
        refreshActiveGroupStoryState(id, { retryIfNoFork: true });
      }
    }
  }
}
async function sendInterject(text) {
  return sendGroup(text, { mode: 'discuss' });
}


// ---- 群设置：共享资料、当前模式名单与明确的彻底删除 ----
function openGroupSettings(id) {
  const group = knownGroups().find((g) => g.id === id);
  if (!group) return;
  const mode = state.shellMode, modeLabel = shellModeLabel(mode);
  const ownerOptions = (group.members || []).map((mid) => `<option value="${escapeHtml(mid)}" ${mid === group.ownerId ? 'selected' : ''}>${escapeHtml(botNameOf(mid))}</option>`).join('');
  const seal = group.seal || {};
  const shapeOpts = SEAL_SHAPES.map((s) => `<option value="${s.id}" ${s.id === seal.shape ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('');
  const colorOpts = SEAL_COLORS.map((c) => `<option value="${c.id}" ${c.id === seal.color ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
  showModal(`
    <div class="modal-head"><h2>群设置 · ${escapeHtml(group.name)}</h2><button type="button" class="icon-btn" data-close>关闭</button></div>
    <div class="modal-body">
      <div class="field"><label>群名</label><input id="gsName" type="text" maxlength="40" value="${escapeHtml(group.name)}"></div>
      <p class="muted">从 ${modeLabel} 名单移除后，可在“新建 → 调入已有群”中重新调入。群资料、消息和任务记录保留，另一模式不受影响。</p>
      <div class="field"><label>群主（拆任务、派活、验收）</label><select id="gsOwner">${ownerOptions}</select></div>
      <div class="field"><label>群头像</label><div class="create-bot-avatar-row">
        <button type="button" class="create-bot-library" id="gsUploadAvatar">上传群头像</button>
        <button type="button" class="create-bot-cancel" id="gsResetAvatar" ${group.hasAvatar ? '' : 'hidden'}>恢复纸印</button>
        <input type="file" id="gsAvatarInput" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
      </div></div>
      <div class="field"><label>纸印形状</label><select id="gsShape">${shapeOpts}</select></div>
      <div class="field"><label>纸印颜色</label><select id="gsColor">${colorOpts}</select></div>
      <div class="modal-actions" style="display:flex;gap:10px;justify-content:space-between;margin-top:16px">
        <button type="button" class="text-btn" id="gsDelete">从 ${modeLabel} 名单移除</button>
        <button type="button" class="send-btn" id="gsSave">保存</button>
      </div>
      <details class="group-delete-advanced">
        <summary>彻底删除群</summary>
        <p class="muted">从 Chat 和 Work 中同时删除这个群，并清除群消息记录。</p>
        <button type="button" class="text-btn is-danger" id="gsDeleteForever">彻底删除群及消息记录</button>
      </details>
      <p class="muted" id="gsMsg"></p>
    </div>`);
  const reloadGroups = async () => {
    const g = await api('/api/dimension/groups');
    setKnownGroups(g.groups, mode);
    renderGroupSection();
    if (state.activeGroupId === id) {
      syncConversationChrome();
      renderGroupDrawer().catch(() => {});
    }
  };
  const avatarUpload = $('gsUploadAvatar'), avatarReset = $('gsResetAvatar'), avatarInput = $('gsAvatarInput'), avatarMessage = $('gsMsg');
  let avatarBusy = false;
  const avatarPending = busy => { avatarBusy = busy; avatarUpload.disabled = busy; avatarReset.disabled = busy; avatarInput.disabled = busy; };
  avatarUpload.addEventListener('click', () => avatarInput.click());
  avatarInput.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file || avatarBusy) return;
    avatarPending(true);
    try {
      await uploadImageAsset(`/api/dimension/groups/${encodeURIComponent(id)}/avatar`, file);
      await reloadGroups();
      avatarReset.hidden = false;
      avatarMessage.textContent = '群头像已更新。';
    } catch (err) { avatarMessage.textContent = err.message || '上传失败'; }
    finally { avatarPending(false); avatarInput.value = ''; }
  });
  avatarReset.addEventListener('click', async () => {
    if (avatarBusy) return;
    avatarPending(true);
    try {
      await api(`/api/dimension/groups/${encodeURIComponent(id)}/avatar`, { method: 'DELETE' });
      await reloadGroups();
      avatarReset.hidden = true;
      avatarMessage.textContent = '已恢复纸印。';
    } catch (err) { avatarMessage.textContent = err.message || '删除失败'; }
    finally { avatarPending(false); }
  });
  $('gsSave').addEventListener('click', async () => {
    try {
      const result = await api(`/api/dimension/groups/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: $('gsName').value.trim(),
          ownerId: $('gsOwner').value,
          seal: { shape: $('gsShape').value, color: $('gsColor').value },
          ...(group.rosterManaged ? { baseRevision: group.revision } : {}),
        }),
      });
      setKnownGroups(result.groups, mode);
      renderGroupSection();
      closeModal();
      if (state.activeGroupId === id) {
        if (groupRosterIds().has(id)) openGroup(id, { keepNotice: true }).catch(() => {});
        else leaveGroup();
      }
    } catch (err) { $('gsMsg').textContent = err.message; }
  });
  $('gsDelete').addEventListener('click', async () => {
    $('gsDelete').disabled = true;
    try {
      await updateGroupRoster(id, mode, false);
      closeModal();
      showPaperHint(`已从 ${modeLabel} 名单移除，可重新调入`);
    } catch (error) {
      $('gsDelete').disabled = false;
      $('gsMsg').textContent = error.message;
    }
  });
  $('gsDeleteForever').addEventListener('click', async () => {
    const ok = await window.__dimensionConfirm({
      title: `彻底删除群「${group.name}」？`,
      message: `这会同时移除 Chat 和 Work 中的群，并清除群消息记录，无法撤销。若只想从 ${modeLabel} 隐藏，请使用“从 ${modeLabel} 名单移除”。`,
      confirmLabel: '彻底删除',
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await api(`/api/dimension/groups/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setKnownGroups(result.groups);
      if (state.activeGroupId === id) leaveGroup();
      for (const shell of ['chat', 'work']) if (state.selections[shell]?.kind === 'group' && state.selections[shell].id === id) state.selections[shell] = null;
      renderGroupSection();
      closeModal();
    } catch (err) { $('gsMsg').textContent = err.message; }
  });
}


// ---- 群信息抽屉：成员管理与成员状态演示 ----
async function renderGroupDrawer({ loadJobs = true } = {}) {
  workSession.refreshRoundtableSeats?.();
  const group = activeGroup();
  const box = $('drawerGroup');
  const botList = $('drawerBotList');
  const hero = document.querySelector('.drawer-hero');
  if (!box) return;
  if (!group) {
    box.hidden = true;
    if (botList) botList.hidden = false;
    if (hero) hero.style.display = '';
    return;
  }
  box.hidden = false;
  if (botList) botList.hidden = true;
  if (hero) hero.style.display = 'none';
  $('groupSealSlot').innerHTML = groupAvatar(group, 56);
  $('groupHeroName').textContent = group.name;
  $('groupHeroMeta').textContent = `${group.id} · ${(group.members || []).length} 名成员 · 群主 ${botNameOf(group.ownerId)}`;

  // Quick 1-click Scene Presets (日常闲聊 / 主角互动 / 沉浸观剧)
  const presetBar = $('groupPresetBar');
  if (presetBar) {
    const syncPresetActive = () => {
      const lv = group.activityLevel || 'party';
      const sp = group.spotlightMode || 'semi';
      const st = Boolean(group.storyConfig?.enabled);
      let activeKey = '';
      if (st || sp === 'zero') activeKey = 'theater';
      else if (sp === 'lead') activeKey = 'lead';
      else if (lv === 'balanced' && sp === 'semi') activeKey = 'casual';
      presetBar.querySelectorAll('.group-preset-btn').forEach((b) => {
        b.classList.toggle('is-active', b.dataset.preset === activeKey);
      });
    };
    syncPresetActive();
    presetBar.querySelectorAll('.group-preset-btn').forEach((btn) => {
      btn.onclick = async () => {
        const key = btn.dataset.preset;
        const map = {
          casual:  { level: 'balanced', mode: 'semi', label: '日常闲聊' },
          lead:    { level: 'party',    mode: 'lead', label: '主角互动' },
          theater: { level: 'party',    mode: 'zero', label: '沉浸观剧' },
        };
        const cfg = map[key];
        if (!cfg) return;
        try {
          const [aRes, sRes] = await Promise.all([
            api(`/api/dimension/groups/${encodeURIComponent(group.id)}/activity-level`, {
              method: 'PUT', body: JSON.stringify({ level: cfg.level, customLimit: group.activityCustomLimit ?? 8 }),
            }),
            api(`/api/dimension/groups/${encodeURIComponent(group.id)}/spotlight`, {
              method: 'PUT', body: JSON.stringify({ mode: cfg.mode }),
            }),
          ]);
          if (sRes?.groups) state.groups = sRes.groups;
          else if (aRes?.groups) state.groups = aRes.groups;
          group.activityLevel = cfg.level;
          group.spotlightMode = cfg.mode;
          if (key === 'theater' && $('groupStorySection')) {
            $('groupStorySection').open = true;
            $('groupStoryPremise')?.focus();
          }
          toast(`已切换至「${cfg.label}」预设`);
          void renderGroupDrawer({ loadJobs: false });
        } catch (err) {
          toast(err?.message || '切换预设失败');
        }
      };
    });
  }

  // Sync per-group Activity Level selector (安静 / 日常 / 热闹 / 狂欢 / 自定义 0-999)，名称与客户端设置保持一致
  const actPills = $('groupActivityPills');
  if (actPills) {
    const ACT_META = {
      quiet:    { label: '安静', hint: '仅最相关的角色回应，其余成员保持静默。' },
      balanced: { label: '日常', hint: '自然的日常群聊节奏，核心角色接话、旁观者适度插话。' },
      lively:   { label: '热闹', hint: '更积极地接梗与互动，每轮约 4～5 位角色参与。' },
      party:    { label: '狂欢', hint: '全员自由接话与互动，适合热闹群像与沉浸剧场。⚠ Token 消耗最高。' },
      custom:   { label: '自定义', hint: '自由指定每轮最多允许的发言次数（0–999，0 为静默）。' },
    };
    const curLevel = ACT_META[group.activityLevel] ? group.activityLevel : 'party';
    const curLimit = Number.isFinite(Number(group.activityCustomLimit))
      ? Math.max(0, Math.min(999, Math.round(Number(group.activityCustomLimit))))
      : 8;
    const customRow = $('groupActivityCustomRow');
    const customInp = $('groupActivityCustomInput');
    const customSave = $('groupActivityCustomSave');
    const paintActivity = (lv, lim = curLimit) => {
      const m = ACT_META[lv] || ACT_META.party;
      if ($('groupActivityBadge')) $('groupActivityBadge').textContent = lv === 'custom' ? `自定义 · ${lim} 轮` : m.label;
      if ($('groupActivityHint')) $('groupActivityHint').textContent = m.hint;
      if (customRow) customRow.hidden = lv !== 'custom';
      if (customInp && document.activeElement !== customInp) customInp.value = String(lim);
      actPills.querySelectorAll('.group-activity-pill').forEach((btn) => {
        const active = btn.dataset.level === lv;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-checked', active ? 'true' : 'false');
      });
    };
    paintActivity(curLevel, curLimit);
    const saveGroupAct = async (nextLevel, rawLimit) => {
      const clamped = Math.max(0, Math.min(999, Math.round(Number(rawLimit) || 0)));
      paintActivity(nextLevel, clamped);
      try {
        const data = await api(`/api/dimension/groups/${encodeURIComponent(group.id)}/activity-level`, {
          method: 'PUT',
          body: JSON.stringify({ level: nextLevel, customLimit: clamped }),
        });
        if (data?.groups) state.groups = data.groups;
        group.activityLevel = nextLevel;
        group.activityCustomLimit = clamped;
        toast(`已将「${group.name}」对话频率设为：${nextLevel === 'custom' ? `自定义（${clamped} 轮）` : ACT_META[nextLevel].label}`);
      } catch (err) {
        paintActivity(group.activityLevel || 'party', group.activityCustomLimit ?? 8);
        toast(err?.message || '保存对话频率失败');
      }
    };
    actPills.querySelectorAll('.group-activity-pill').forEach((btn) => {
      btn.onclick = () => {
        const nextLevel = btn.dataset.level;
        if (!nextLevel) return;
        const lim = customInp ? customInp.value : curLimit;
        if (nextLevel === 'custom') {
          // 只展开输入框；填好后点「应用」或回车再保存
          paintActivity('custom', Math.max(0, Math.min(999, Math.round(Number(lim) || 0))));
          customInp?.focus();
          customInp?.select?.();
          return;
        }
        void saveGroupAct(nextLevel, lim);
      };
    });
    if (customSave) {
      customSave.onclick = () => void saveGroupAct('custom', customInp ? customInp.value : curLimit);
    }
    if (customInp) {
      customInp.onkeydown = (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void saveGroupAct('custom', customInp.value);
        }
      };
    }
  }

  // Sync per-group Spotlight Mode (旁观者 / 同行者 / 主角)
  const spotPills = $('groupSpotlightPills');
  if (spotPills) {
    const SPOT_META = {
      zero: { label: '旁观者', hint: '退居幕后静静看戏，角色们只彼此互动，不打破第四面墙。' },
      semi: { label: '同行者', hint: '与角色共同置身剧情之中，既有群像互动，也会自然回应你。' },
      lead: { label: '主角', hint: '聚光灯始终在你身上，全场的羁绊、情绪与抉择都围绕你展开。' },
    };
    const curSpot = SPOT_META[group.spotlightMode] ? group.spotlightMode : 'semi';
    const paintSpot = (mode) => {
      const m = SPOT_META[mode] || SPOT_META.semi;
      if ($('groupSpotlightBadge')) $('groupSpotlightBadge').textContent = m.label;
      if ($('groupSpotlightHint')) $('groupSpotlightHint').textContent = m.hint;
      spotPills.querySelectorAll('.group-activity-pill').forEach((btn) => {
        const active = btn.dataset.mode === mode;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-checked', active ? 'true' : 'false');
      });
    };
    paintSpot(curSpot);
    spotPills.querySelectorAll('.group-activity-pill').forEach((btn) => {
      btn.onclick = async () => {
        const nextMode = btn.dataset.mode;
        if (!nextMode || nextMode === (group.spotlightMode || 'semi')) return;
        paintSpot(nextMode);
        try {
          const data = await api(`/api/dimension/groups/${encodeURIComponent(group.id)}/spotlight`, {
            method: 'PUT',
            body: JSON.stringify({ mode: nextMode }),
          });
          if (data?.groups) state.groups = data.groups;
          group.spotlightMode = nextMode;
          toast(`已将「${group.name}」故事视角设为：${SPOT_META[nextMode].label}`);
        } catch (err) {
          paintSpot(group.spotlightMode || 'semi');
          toast(err?.message || '保存故事视角失败');
        }
      };
    });
  }

  // Sync Story Theater (物语剧场)
  const storyPremiseEl = $('groupStoryPremise');
  const storyNarratorEl = $('groupStoryNarrator');
  const storyStartBtn = $('groupStoryStartBtn');
  const storyStopBtn = $('groupStoryStopBtn');
  const storyCastToggle = $('groupStoryRoleCastToggle');
  const storyCastList = $('groupStoryCastList');
  const storyNodesWrap = $('groupStoryNodesWrap');
  const storyNodesList = $('groupStoryNodesList');
  const storyWorldlineTag = $('groupStoryWorldlineTag');
  const storyResetBtn = $('groupStoryResetBtn');
  if (storyPremiseEl && storyNarratorEl && storyStartBtn) {
    const sc = group.storyConfig || { enabled: false, premise: '', narratorBotId: '', roleCastEnabled: false, roleCast: [], nodes: [] };
    if (document.activeElement !== storyPremiseEl) storyPremiseEl.value = sc.premise || '';
    storyNarratorEl.replaceChildren(new Option('系统旁白（独立导演）', ''));
    for (const mid of (group.members || [])) {
      storyNarratorEl.append(new Option(`指定角色：${botNameOf(mid)}`, mid));
    }
    storyNarratorEl.value = (group.members || []).includes(sc.narratorBotId) ? sc.narratorBotId : '';

    const castDraft = new Map();
    for (const entry of (sc.roleCast || [])) {
      if (entry?.botId) castDraft.set(entry.botId, { roleName: entry.roleName || '', tier: entry.tier || 'supporting' });
    }
    const renderCastRows = () => {
      if (!storyCastList || !storyCastToggle) return;
      const show = Boolean(storyCastToggle.checked);
      storyCastList.hidden = !show;
      if (!show) return;
      const narId = storyNarratorEl.value || '';
      const actors = (group.members || []).filter((mid) => !narId || mid !== narId);
      storyCastList.innerHTML = actors.map((mid) => {
        const cur = castDraft.get(mid) || { roleName: '', tier: 'supporting' };
        return `<div class="group-story-cast-row" data-cast-bid="${escapeHtml(mid)}">
          <span class="group-story-cast-bot" title="${escapeHtml(botNameOf(mid))}">${escapeHtml(botNameOf(mid))}</span>
          <input type="text" class="group-story-cast-input" placeholder="代入角色（如：雷塞）" value="${escapeHtml(cur.roleName)}">
          <select class="group-story-cast-tier">
            <option value="lead"${cur.tier === 'lead' ? ' selected' : ''}>主角</option>
            <option value="supporting"${cur.tier === 'supporting' ? ' selected' : ''}>配角</option>
            <option value="antagonist"${cur.tier === 'antagonist' ? ' selected' : ''}>反派</option>
            <option value="cameo"${cur.tier === 'cameo' ? ' selected' : ''}>客串</option>
          </select>
        </div>`;
      }).join('');
      storyCastList.querySelectorAll('.group-story-cast-row').forEach((rowEl) => {
        const bid = rowEl.dataset.castBid;
        const inp = rowEl.querySelector('.group-story-cast-input');
        const sel = rowEl.querySelector('.group-story-cast-tier');
        const syncDraft = () => castDraft.set(bid, { roleName: inp.value.trim(), tier: sel.value });
        inp?.addEventListener('input', syncDraft);
        sel?.addEventListener('change', syncDraft);
      });
    };
    const collectRoleCast = () => {
      const narId = storyNarratorEl.value || '';
      const out = [];
      for (const mid of (group.members || [])) {
        if (narId && mid === narId) continue;
        const cur = castDraft.get(mid);
        if (cur?.roleName) out.push({ botId: mid, roleName: cur.roleName, tier: cur.tier || 'supporting' });
      }
      return out;
    };
    if (storyCastToggle) {
      storyCastToggle.checked = Boolean(sc.roleCastEnabled);
      storyCastToggle.onchange = renderCastRows;
    }
    storyNarratorEl.onchange = renderCastRows;
    renderCastRows();

    // Story Theater v3: 6 One-Click Premium Story Templates
    const tplWrap = $('groupStoryTemplatesWrap');
    if (tplWrap) {
      tplWrap.innerHTML = `
        <div class="stv3-templates-head">
          <span>一键剧本开局模板</span>
          <span style="opacity:0.65;">点击即填</span>
        </div>
        <div class="stv3-templates-grid">
          ${STORY_TEMPLATES.map((tpl) => `<button type="button" class="stv3-tpl-chip" data-tpl-id="${escapeHtml(tpl.id)}" title="${escapeHtml(tpl.premise)}">
            <em class="stv3-tpl-tag">${escapeHtml(tpl.badge)}</em>
            <strong>${escapeHtml(tpl.title)}</strong>
            <span>${escapeHtml(tpl.sub)}</span>
          </button>`).join('')}
        </div>
      `;
      tplWrap.querySelectorAll('[data-tpl-id]').forEach((btn) => {
        btn.onclick = async () => {
          const tpl = STORY_TEMPLATES.find((x) => x.id === btn.dataset.tplId);
          if (!tpl) return;
          storyPremiseEl.value = tpl.premise;
          castDraft.clear();
          for (const rc of (tpl.roleCast || [])) {
            if ((group.members || []).includes(rc.botId)) {
              castDraft.set(rc.botId, { roleName: rc.roleName, tier: rc.tier || 'supporting' });
            }
          }
          if (storyCastToggle) storyCastToggle.checked = castDraft.size > 0;
          renderCastRows();
          if (tpl.spotlight && tpl.spotlight !== (group.spotlightMode || 'semi')) {
            try {
              const sp = await api(`/api/dimension/groups/${encodeURIComponent(group.id)}/spotlight`, {
                method: 'PUT',
                body: JSON.stringify({ mode: tpl.spotlight }),
              });
              if (sp?.groups) state.groups = sp.groups;
              group.spotlightMode = tpl.spotlight;
            } catch {}
          }
          if (tpl.diceMode) {
            try {
              const sr = await api(`/api/dimension/groups/${encodeURIComponent(group.id)}/story/secrets`, {
                method: 'PUT',
                body: JSON.stringify({ diceMode: true }),
              });
              if (sr?.groups) state.groups = sr.groups;
              if (sr?.group) group.storyConfig = sr.group.storyConfig;
            } catch {}
          }
          toast(`已套用剧本模板「${tpl.title}」${tpl.diceMode ? '（已自动开启 D20 命运骰子）' : ''}，点击「开演」即可开场！`);
          storyPremiseEl.focus();
        };
      });
    }

    const paintNodes = (cfg) => {
      if (!storyNodesWrap || !storyNodesList) return;
      const nodes = cfg?.nodes || [];
      storyNodesWrap.hidden = !cfg?.enabled || !nodes.length;
      if (storyWorldlineTag) storyWorldlineTag.textContent = `世界线 · ${cfg?.worldline || '主线'}（共 ${nodes.length} 幕）`;
      storyNodesList.innerHTML = [...nodes].reverse().map((n) => `
        <div class="group-story-node-item">
          <div class="group-story-node-meta">
            <div class="group-story-node-title" title="${escapeHtml(n.title)}">${String(n.title || '').startsWith('第 ') ? escapeHtml(n.title) : `第 ${escapeHtml(String(n.chapter || 1))} 幕 · ${escapeHtml(n.title || '未命名节点')}`}</div>
            <div class="group-story-node-sub">${escapeHtml(n.worldline || '主线')}${n.directive ? ` · 改写：${escapeHtml(n.directive.slice(0, 26))}` : ''}</div>
          </div>
          <button type="button" class="group-story-rewind-btn" data-node-id="${escapeHtml(n.id)}">回溯此幕</button>
        </div>`).join('');
      storyNodesList.querySelectorAll('.group-story-rewind-btn').forEach((btn) => {
        btn.onclick = () => {
          const targetNode = nodes.find((x) => x.id === btn.dataset.nodeId);
          if (!targetNode) return;
          const itemEl = btn.closest('.group-story-node-item');
          if (!itemEl) return;
          const existing = itemEl.querySelector('.group-inline-rewind-row');
          if (existing) { existing.remove(); itemEl.classList.remove('has-inline-rewind'); return; }
          itemEl.classList.add('has-inline-rewind');
          const row = document.createElement('div');
          row.className = 'group-inline-rewind-row';
          row.innerHTML = `<input type="text" class="story-rewrite-input" placeholder="输入从第 ${escapeHtml(String(targetNode.chapter || 1))} 幕改写的走向（留空直接重演）…">
            <button type="button" class="story-stage-btn is-primary">开启 IF 线</button>`;
          itemEl.appendChild(row);
          const inp = row.querySelector('input');
          const goBtn = row.querySelector('button');
          const run = async () => {
            await triggerStoryRewind(group, targetNode, inp.value.trim());
            openDrawer(false);
          };
          goBtn.addEventListener('click', run);
          bindStorySubmit(inp, run);
          inp.focus();
        };
      });
    };

    const paintStory = (cfg) => {
      const enabled = Boolean(cfg?.enabled);
      if ($('groupStoryBadge')) $('groupStoryBadge').textContent = enabled ? '演绎中' : '未开演';
      storyStartBtn.textContent = enabled ? '保存并进入下一幕' : '开演';
      if (storyStopBtn) storyStopBtn.hidden = !enabled;
      paintNodes(cfg);
      renderStoryStageBar();
    };
    paintStory(sc);

    storyStartBtn.onclick = async () => {
      const premise = storyPremiseEl.value.trim();
      if (!premise) {
        toast('请先输入一段故事背景或开端（例如：从《电锯人》雷塞雨夜折返去见电次开始…）');
        storyPremiseEl.focus();
        return;
      }
      const wasEnabled = Boolean(group.storyConfig?.enabled);
      const narratorBotId = storyNarratorEl.value || '';
      const roleCastEnabled = Boolean(storyCastToggle?.checked);
      const roleCast = collectRoleCast();
      storyStartBtn.disabled = true;
      try {
        const saved = await api(`/api/dimension/groups/${encodeURIComponent(group.id)}/story`, {
          method: 'PUT',
          body: JSON.stringify({ enabled: true, premise, narratorBotId, roleCastEnabled, roleCast }),
        });
        if (saved?.groups) state.groups = saved.groups;
        if (saved?.group) group.storyConfig = saved.group.storyConfig;
        paintStory(group.storyConfig);
        await triggerStoryAdvance(group, { opening: !wasEnabled });
        openDrawer(false);
      } catch (err) {
        toast(err?.message || '启动故事演绎失败');
      } finally {
        storyStartBtn.disabled = false;
      }
    };
    if (storyStopBtn) {
      storyStopBtn.onclick = async () => {
        try {
          const saved = await api(`/api/dimension/groups/${encodeURIComponent(group.id)}/story`, {
            method: 'PUT',
            body: JSON.stringify({
              enabled: false,
              premise: storyPremiseEl.value.trim(),
              narratorBotId: storyNarratorEl.value || '',
              roleCastEnabled: Boolean(storyCastToggle?.checked),
              roleCast: collectRoleCast(),
            }),
          });
          if (saved?.groups) state.groups = saved.groups;
          if (saved?.group) group.storyConfig = saved.group.storyConfig;
          paintStory(group.storyConfig);
          toast('已结束剧场演绎，回到日常群聊。');
        } catch (err) {
          toast(err?.message || '结束剧场失败');
        }
      };
    }
    if (storyResetBtn) {
      let resetArmed = false;
      let resetTimer = null;
      storyResetBtn.onclick = async () => {
        if (!resetArmed) {
          resetArmed = true;
          storyResetBtn.textContent = '确认重置？';
          clearTimeout(resetTimer);
          resetTimer = setTimeout(() => { resetArmed = false; storyResetBtn.textContent = '重置世界线'; }, 3000);
          return;
        }
        resetArmed = false;
        clearTimeout(resetTimer);
        storyResetBtn.textContent = '重置世界线';
        try {
          const saved = await api(`/api/dimension/groups/${encodeURIComponent(group.id)}/story`, {
            method: 'PUT',
            body: JSON.stringify({
              enabled: true,
              premise: storyPremiseEl.value.trim(),
              narratorBotId: storyNarratorEl.value || '',
              roleCastEnabled: Boolean(storyCastToggle?.checked),
              roleCast: collectRoleCast(),
              resetTimeline: true,
            }),
          });
          if (saved?.groups) state.groups = saved.groups;
          if (saved?.group) group.storyConfig = saved.group.storyConfig;
          paintStory(group.storyConfig);
          toast('世界线已重置，可以重新开演第一幕。');
        } catch (err) {
          toast(err?.message || '重置世界线失败');
        }
      };
    }

    // Story Archives (剧本存档)
    const storyArchivesList = $('groupStoryArchivesList');
    const storyArchivesTitle = $('groupStoryArchivesTitle');
    const storySaveArchiveBtn = $('groupStorySaveArchiveBtn');
    const SPOT_LABEL = { zero: '旁观者', semi: '同行者', lead: '主角' };
    const renderArchives = (archives) => {
      if (!storyArchivesList) return;
      const list = Array.isArray(archives) ? archives : [];
      if (storyArchivesTitle) storyArchivesTitle.textContent = `剧本存档${list.length ? ` (${list.length})` : ''}`;
      if (!list.length) {
        storyArchivesList.innerHTML = '<div class="group-story-archive-empty">暂无剧本存档，每次开演或点击「存入存档」都会自动保存。</div>';
        return;
      }
      storyArchivesList.innerHTML = list.map((a) => {
        const ch = Number(a.chapterCount || (a.nodes || []).length || 0);
        const castCnt = a.roleCastEnabled && Array.isArray(a.roleCast) ? a.roleCast.length : 0;
        const metaParts = [];
        if (ch > 0) metaParts.push(`${ch} 幕`);
        if (castCnt > 0) metaParts.push(`代入 ${castCnt} 人`);
        if (a.spotlightMode && SPOT_LABEL[a.spotlightMode]) metaParts.push(SPOT_LABEL[a.spotlightMode]);
        return `<div class="group-story-node-item" data-archive-id="${escapeHtml(a.id)}">
          <div class="group-story-node-meta">
            <div class="group-story-node-title" title="${escapeHtml(a.premise || a.title || '')}">${escapeHtml(a.title || '未命名剧本')}</div>
            <div class="group-story-node-sub">${escapeHtml(metaParts.join(' · ') || '可随时重演')}</div>
          </div>
          <div class="group-story-archive-actions">
            <button type="button" class="group-story-rewind-btn" data-arch-act="load" title="读取到上方编辑区">读取</button>
            <button type="button" class="group-story-rewind-btn" data-arch-act="play" title="直接以此剧本开演新世界线">开演</button>
            <button type="button" class="group-story-archive-del" data-arch-act="del" title="删除存档">×</button>
          </div>
        </div>`;
      }).join('');

      const applyArchiveToForm = (arch) => {
        storyPremiseEl.value = arch.premise || '';
        storyNarratorEl.value = (group.members || []).includes(arch.narratorBotId) ? arch.narratorBotId : '';
        castDraft.clear();
        for (const c of (arch.roleCast || [])) {
          if (c?.botId && (group.members || []).includes(c.botId)) {
            castDraft.set(c.botId, { roleName: c.roleName || '', tier: c.tier || 'supporting' });
          }
        }
        if (storyCastToggle) storyCastToggle.checked = Boolean(arch.roleCastEnabled && castDraft.size > 0);
        renderCastRows();
      };

      storyArchivesList.querySelectorAll('[data-arch-act]').forEach((btn) => {
        btn.onclick = async () => {
          const aid = btn.closest('[data-archive-id]')?.dataset.archiveId;
          const arch = list.find((x) => x.id === aid);
          if (!arch) return;
          const act = btn.dataset.archAct;
          if (act === 'load') {
            applyArchiveToForm(arch);
            toast(`已载入剧本「${arch.title}」，可微调选角后点击开演！`);
            storyPremiseEl.focus();
            return;
          }
          if (act === 'play') {
            applyArchiveToForm(arch);
            const matchedCast = collectRoleCast();
            const narId = (group.members || []).includes(arch.narratorBotId) ? arch.narratorBotId : '';
            btn.disabled = true;
            try {
              if (arch.spotlightMode && arch.spotlightMode !== (group.spotlightMode || 'semi')) {
                const sp = await api(`/api/dimension/groups/${encodeURIComponent(group.id)}/spotlight`, {
                  method: 'PUT',
                  body: JSON.stringify({ mode: arch.spotlightMode }),
                });
                if (sp?.groups) state.groups = sp.groups;
                group.spotlightMode = arch.spotlightMode;
              }
              const saved = await api(`/api/dimension/groups/${encodeURIComponent(group.id)}/story`, {
                method: 'PUT',
                body: JSON.stringify({
                  enabled: true,
                  premise: arch.premise || '',
                  narratorBotId: narId,
                  roleCastEnabled: Boolean(arch.roleCastEnabled && matchedCast.length > 0),
                  roleCast: matchedCast,
                  resetTimeline: true,
                }),
              });
              if (saved?.groups) state.groups = saved.groups;
              if (saved?.group) group.storyConfig = saved.group.storyConfig;
              if (saved?.archives) renderArchives(saved.archives);
              paintStory(group.storyConfig);
              await triggerStoryAdvance(group, { opening: true });
              openDrawer(false);
            } catch (err) {
              toast(err?.message || '重演剧本失败');
            } finally {
              btn.disabled = false;
            }
            return;
          }
          if (act === 'del') {
            try {
              const res = await api(`/api/dimension/story-archives/${encodeURIComponent(aid)}`, { method: 'DELETE' });
              renderArchives(res?.archives || []);
              toast(`已删除剧本「${arch.title}」`);
            } catch (err) {
              toast(err?.message || '删除剧本失败');
            }
          }
        };
      });
    };

    if (storySaveArchiveBtn) {
      storySaveArchiveBtn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const premise = storyPremiseEl.value.trim();
        if (!premise) { toast('请先填写故事开端再存入存档'); storyPremiseEl.focus(); return; }
        const defaultTitle = premise.replace(/\s+/g, ' ').slice(0, 20);
        try {
          const res = await api('/api/dimension/story-archives', {
            method: 'POST',
            body: JSON.stringify({
              groupId: group.id,
              title: defaultTitle,
              premise,
              narratorBotId: storyNarratorEl.value || '',
              roleCastEnabled: Boolean(storyCastToggle?.checked),
              roleCast: collectRoleCast(),
              spotlightMode: group.spotlightMode || 'semi',
            }),
          });
          renderArchives(res?.archives || []);
          toast(`已存入剧本存档「${res?.archive?.title || defaultTitle}」`);
        } catch (err) {
          toast(err?.message || '存入存档失败');
        }
      };
    }

    if (storyArchivesList) {
      api('/api/dimension/story-archives')
        .then((res) => renderArchives(res?.archives || []))
        .catch(() => {});
    }
  }

  const members = $('groupMembers');
  members.innerHTML = (group.members || []).map((mid) => {
    const tags = [];
    if (mid === group.ownerId) tags.push('<span class="group-member-tag lead">群主</span>');
    else if ((group.admins || []).includes(mid)) tags.push('<span class="group-member-tag">管理员</span>');
    return `<button type="button" class="group-member" data-mid="${escapeHtml(mid)}" aria-haspopup="menu" title="成员操作（设管理员、移出茶会…）">
      ${botAvatar((state.bots || []).find((b) => b.id === mid) || { id: mid, name: mid }, 44)}
      <span class="group-member-name">${escapeHtml(botNameOf(mid))}</span>
      ${tags.join('')}
      <span class="row-more-btn" aria-hidden="true">⋯</span>
    </button>`;
  }).join('');
  members.querySelectorAll('.group-member').forEach((el) => {
    // 以前只能右键；现在左键、右键、键盘（Enter / 菜单键 / Shift+F10）都能打开成员菜单
    const openAt = (x, y) => openGroupMemberMenu(group, el.dataset.mid, x, y);
    el.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openAt(event.clientX, event.clientY);
    });
    el.addEventListener('click', (event) => {
      const rect = el.getBoundingClientRect();
      const fromKeyboard = event.detail === 0;
      openAt(fromKeyboard ? rect.left + 24 : event.clientX, fromKeyboard ? rect.bottom : event.clientY);
    });
    el.addEventListener('keydown', (event) => {
      if (!(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) return;
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      openAt(rect.left + 24, rect.bottom);
    });
  });
  $('groupDrawerInviteBtn').onclick = () => openGroupInvite(group);
  if (loadJobs) await renderGroupKanban(group);
}

async function renderGroupKanban(group) {
  const box = $('groupKanban');
  if (!box) return;
  const data = await api(`/api/dimension/groups/${encodeURIComponent(group.id)}/jobs`);
  if (state.activeGroupId !== group.id) return;
  const jobs = data.jobs || {};
  const steps = data.steps || {};
  const chatting = data.chatting || {};
  // 每个成员一行双状态：chat 侧（最近在讨论里说的话）+ 工作侧（手头活与当前步骤）。
  box.innerHTML = (group.members || []).map((mid) => {
    const current = jobs[mid];
    const step = steps[mid];
    const said = chatting[mid];
    const labels = { queued: '排队中', waiting: '等待依赖', running: '进行中', stopping: '正在停止', completed: '已完成', partial: '部分交付', failed: '失败', cancelled: '已取消', interrupted: '已中断', blocked: '受阻' };
    const active = data.version === 1 ? current?.active === true : !!current;
    const status = current ? (data.version === 1 ? labels[current.status] || '状态未知' : '进行中') : '空闲';
    return `<div class="kanban-card ${active ? 'is-doing' : 'is-idle'}" data-run-status="${escapeHtml(current?.status || 'idle')}">
      <div class="kc-title">${escapeHtml(botNameOf(mid))} <span class="kc-status">${status}</span></div>
      ${said ? `<div class="kc-chat">💬 ${escapeHtml(said)}</div>` : ''}
      ${current ? `<div class="kc-meta">${escapeHtml(String(current.job || '').slice(0, 160))}</div>` : ''}
      ${current && step ? `<div class="kc-result">▸ ${escapeHtml(step)}</div>` : ''}
    </div>`;
  }).join('') || '<p class="muted">还没有成员。</p>';
}

let groupCtxEl = null;
function closeGroupCtx() { groupCtxEl?.remove(); groupCtxEl = null; }

function openGroupMemberMenu(group, memberId, x, y) {
  closeGroupCtx();
  const isOwner = memberId === group.ownerId;
  const isAdmin = (group.admins || []).includes(memberId);
  const menu = document.createElement('div');
  menu.className = 'group-ctx';
  const opts = [];
  if (!isOwner) {
    opts.push(['lead', '设为群主']);
    opts.push(['admin', isAdmin ? '取消管理员' : '设为管理员']);
    opts.push(['kick', '踢出群', true]);
  } else {
    opts.push(['noop', '群主不能踢自己', true]);
  }
  menu.innerHTML = opts.map(([act, label, danger]) =>
    `<button type="button" data-act="${act}" class="${danger ? 'is-danger' : ''}">${label}</button>`).join('');
  document.body.appendChild(menu);
  groupCtxEl = menu;
  menu.style.left = `${Math.min(x, window.innerWidth - 170)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 140)}px`;
  menu.addEventListener('click', async (event) => {
    const act = event.target.closest('button')?.dataset.act;
    closeGroupCtx();
    if (!act || act === 'noop') return;
    if (act === 'kick') {
      const name = botNameOf(memberId);
      const ok = await window.__dimensionConfirm?.({ title: '请出茶会', message: `确定让「${name}」离开「${group.name || '这个茶会'}」吗？之后可以再邀请回来。`, confirmLabel: '请出', danger: true });
      if (!ok) return;
    }
    try {
      const patch = group.rosterManaged ? { baseRevision: group.revision } : {};
      if (act === 'lead') patch.ownerId = memberId;
      if (act === 'admin') {
        patch.admins = isAdmin
          ? (group.admins || []).filter((a) => a !== memberId)
          : [...(group.admins || []), memberId];
      }
      if (act === 'kick') {
        patch.members = group.members.filter((m) => m !== memberId);
        patch.admins = (group.admins || []).filter((m) => m !== memberId);
      }
      const result = await api(`/api/dimension/groups/${encodeURIComponent(group.id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      setKnownGroups(result.groups);
      renderGroupSection();
      syncConversationChrome();
    } catch (err) { setModelStatus(err.message); }
  });
  setTimeout(() => document.addEventListener('pointerdown', function onDown(e) {
    if (!menu.contains(e.target)) { closeGroupCtx(); document.removeEventListener('pointerdown', onDown); }
  }), 0);
}

function openGroupInvite(group) {
  const mode = state.shellMode;
  void import('./group-invite-ui.js').then(({ openGroupInviteDialog }) => {
    openGroupInviteDialog({
      group, mode, candidates: launchedBots(), api, showModal, closeModal,
      nameOf: displayBotName, addToRoster, mergeBots: mergeKnownBots, notify: showPaperHint,
      onSaved: result => {
        mergeKnownBots(result.bots); setKnownGroups(result.groups, mode);
        renderBotList(); renderGroupSection(); syncConversationChrome();
        if (state.activeGroupId === group.id) void renderGroupDrawer();
      },
    });
  }).catch((err) => messageActionNotice(err?.message || '邀请面板加载失败'));
}

const SIDEBAR_PREFS_KEY = 'dimension.sidebarPrefs.v1';
const FORBIDDEN_DISPLAY_NAME = '维度 Agent';
const LIVE_MAIN_BOT_ID = 'new-character';
let paperHintTimer = 0;
let botCtxPoint = { x: 0, y: 0 };
let botCtxBotId = '';

function defaultSidebarPrefs() {
  return { hidden: {}, deleted: {}, unread: {}, names: {}, folders: [], folderOf: {}, workBots: [], chatBots: [], recentBots: [], chatGroups: [], workGroups: [], knownGroupIds: null };
}

let sidebarPrefsRaw;
let sidebarPrefsSnapshot;

function readSidebarPrefs() {
  try {
    const raw = localStorage.getItem(SIDEBAR_PREFS_KEY);
    if (raw === sidebarPrefsRaw) return sidebarPrefsSnapshot;
    const data = raw ? JSON.parse(raw) : null;
    const snapshot = !data || typeof data !== 'object' ? defaultSidebarPrefs() : {
      hidden: data.hidden && typeof data.hidden === 'object' ? data.hidden : {},
      deleted: data.deleted && typeof data.deleted === 'object' ? data.deleted : {},
      unread: data.unread && typeof data.unread === 'object' ? data.unread : {},
      names: data.names && typeof data.names === 'object' ? data.names : {},
      folders: Array.isArray(data.folders) ? data.folders.filter((item) => item && item.id && item.name) : [],
      folderOf: data.folderOf && typeof data.folderOf === 'object' ? data.folderOf : {},
      workBots: Array.isArray(data.workBots) ? [...new Set(data.workBots.map(String))] : [],
      chatBots: Array.isArray(data.chatBots) ? [...new Set(data.chatBots.map(String))] : [],
      chatGroups: Array.isArray(data.chatGroups) ? [...new Set(data.chatGroups.map(String))] : [],
      workGroups: Array.isArray(data.workGroups) ? [...new Set(data.workGroups.map(String))] : [],
      knownGroupIds: Array.isArray(data.knownGroupIds) ? [...new Set(data.knownGroupIds.map(String))] : null,
      recentBots: Array.isArray(data.recentBots) ? [...new Set(data.recentBots.map(String))].slice(0, 24) : [],
    };
    sidebarPrefsRaw = raw;
    sidebarPrefsSnapshot = snapshot;
    return snapshot;
  } catch {
    return defaultSidebarPrefs();
  }
}

function writeSidebarPrefs(prefs) {
  try { localStorage.setItem(SIDEBAR_PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore quota */ }
}

function updateSidebarPrefs(patcher) {
  const prefs = structuredClone(readSidebarPrefs());
  const next = patcher(prefs) || prefs;
  writeSidebarPrefs(next);
  return next;
}

function isForbiddenDisplayName(name) {
  return String(name || '').trim() === FORBIDDEN_DISPLAY_NAME;
}

function displayBotName(bot) {
  const prefs = readSidebarPrefs();
  const local = typeof prefs.names?.[bot?.id] === 'string' ? prefs.names[bot.id].trim() : '';
  if (local && !isForbiddenDisplayName(local)) return local;
  const remote = String(bot?.name || '').trim();
  if (remote && !isForbiddenDisplayName(remote)) return remote;
  if (bot?.id === LIVE_MAIN_BOT_ID) return '小草橘';
  return remote && !isForbiddenDisplayName(remote) ? remote : '未命名';
}

function isLocallyDeleted(id) {
  if (!id) return false;
  return readSidebarPrefs().deleted?.[id] === true;
}

function isBotHidden(id) {
  if (!id) return false;
  return readSidebarPrefs().hidden?.[id] === true;
}

function botHasUnread(bot) {
  if (!bot) return false;
  const prefs = readSidebarPrefs();
  if (prefs.unread?.[bot.id] === true) return true;
  if (prefs.unread?.[bot.id] === false) return false;
  const count = Number(bot.unreadCount ?? bot.unread ?? 0);
  if (Number.isFinite(count) && count > 0) return true;
  return bot.unread === true || bot.hasUnread === true;
}

function botConversationId(bot) {
  const value = bot?.conversationId || bot?.sessionId || bot?.chatId || bot?.threadId || bot?.id;
  return String(value || '').trim();
}

function sidebarFolders() {
  return readSidebarPrefs().folders.slice();
}

function folderIdOf(botId) {
  const id = readSidebarPrefs().folderOf?.[botId];
  return id ? String(id) : '';
}

function findBotById(id) {
  if (!id) return null;
  const lists = [modeBotList(), knownBots(), Array.isArray(state.workBots) ? state.workBots : []];
  for (const list of lists) {
    const found = list.find((bot) => bot.id === id);
    if (found) return found;
  }
  return { id, name: id === LIVE_MAIN_BOT_ID ? '小草橘' : '' };
}

function patchBotRecord(id, patch) {
  const apply = (list) => Array.isArray(list)
    ? list.map((bot) => (bot.id === id ? { ...bot, ...patch } : bot))
    : list;
  state.bots = apply(state.bots);
  state.workBots = apply(state.workBots);
}

function applyCurrentNameIfLocal() {
  const local = readSidebarPrefs().names?.[state.botId];
  if (typeof local === 'string' && local.trim() && !isForbiddenDisplayName(local)) {
    state.botName = local.trim();
  }
}

async function persistPaperSeal(id, seal) {
  writeLocalSeal(id, seal);
  try {
    return await api(`/api/dimension/bots/${encodeURIComponent(id)}/paper-seal`, {
      method: 'PATCH',
      body: JSON.stringify({ paperSeal: { shape: seal.shape, color: seal.color, pinned: seal.pinned === true } }),
    });
  } catch {
    return null;
  }
}

function refreshBotChromeOrList(id) {
  if (id === state.botId) applyBotChrome();
  else renderBotList();
}

function ctxIcon(kind) {
  const common = 'width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"';
  if (kind === 'pin') {
    return `<svg ${common}><ellipse cx="6.4" cy="5.2" rx="3.1" ry="2.35" transform="rotate(-38 6.4 5.2)" stroke="currentColor" stroke-width="1.5"/><path d="M8.15 7.15 11.7 13.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  }
  if (kind === 'folder') {
    return `<svg ${common}><path d="M2.5 4.75h3.15l1.15 1.45H13.5V13H2.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M2.5 6.2h11" stroke="currentColor" stroke-width="1.5"/></svg>`;
  }
  if (kind === 'bell') {
    return `<svg ${common}><path d="M8 1.9A3.6 3.6 0 0 1 11.6 5.5v3.05l1.15 2.15H3.25L4.4 8.55V5.5A3.6 3.6 0 0 1 8 1.9Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M6.35 13.15a1.7 1.7 0 0 0 3.3 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  }
  if (kind === 'avatar') {
    return `<svg ${common}><circle cx="6.55" cy="6.55" r="4.2" stroke="currentColor" stroke-width="1.5"/><path d="M9.35 9.2 13.55 5c.35-.35.9-.35 1.25 0 .35.35.35.9 0 1.25l-4.2 4.2-2 .4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  }
  if (kind === 'rename') {
    return `<svg ${common}><rect x="2.25" y="2.75" width="8.6" height="10.5" rx="1.4" stroke="currentColor" stroke-width="1.5"/><path d="M9.15 10.1 13.4 5.85c.35-.35.9-.35 1.25 0 .35.35.35.9 0 1.25L10.4 11.35l-2 .4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  }
  if (kind === 'copy') {
    return `<svg ${common}><rect x="3" y="2.75" width="10" height="10.5" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M5.3 6.15h5.4M5.3 9.85h3.7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  }
  if (kind === 'eye') {
    return `<svg ${common}><path d="M2.25 8s2.35-3.85 5.75-3.85S13.75 8 13.75 8s-2.35 3.85-5.75 3.85S2.25 8 2.25 8Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="8" cy="8" r="1.7" stroke="currentColor" stroke-width="1.5"/></svg>`;
  }
  if (kind === 'eyeOff') {
    return `<svg ${common}><path d="M2.25 8s2.35-3.85 5.75-3.85S13.75 8 13.75 8s-2.35 3.85-5.75 3.85S2.25 8 2.25 8Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="8" cy="8" r="1.7" stroke="currentColor" stroke-width="1.5"/><path d="M3.1 12.9 12.9 3.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  }
  if (kind === 'trash') {
    return `<svg ${common}><path d="M3.15 5.1h9.7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M6.05 5.1V3.55h3.9V5.1" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M4.55 5.1l.7 7.7h5.5l.7-7.7" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M6.85 7.15v3.7M9.15 7.15v3.7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  }
  return `<svg ${common}></svg>`;
}

function ctxItemMarkup({ action, icon, label, danger = false, hidden = false }) {
  const hide = hidden ? ' hidden' : '';
  const dangerCls = danger ? ' is-danger' : '';
  return `<button type="button" class="bot-ctx-item${dangerCls}" role="menuitem" data-action="${escapeHtml(action)}"${hide}><span class="bot-ctx-hit" aria-hidden="true"></span>${ctxIcon(icon)}<span class="bot-ctx-label">${escapeHtml(label)}</span></button>`;
}

function isBotContextMenuOpen() {
  const menu = $('botContextMenu');
  return Boolean(menu && !menu.hidden);
}

function closeBotGroupMenu() {
  const menu = $('botGroupMenu');
  if (menu) {
    menu.hidden = true;
    menu.innerHTML = '';
  }
}

function closeBotContextMenu() {
  const menu = $('botContextMenu');
  if (menu) {
    menu.hidden = true;
    menu.innerHTML = '';
  }
  closeBotGroupMenu();
  botCtxBotId = '';
}

function placeNearPoint(el, x, y) {
  if (!el) return;
  const pad = 8;
  const w = el.offsetWidth || 248;
  const h = el.offsetHeight || 0;
  let left = x;
  let top = y;
  if (left + w > window.innerWidth - pad) left = x - w;
  if (top + h > window.innerHeight - pad) top = y - h;
  left = Math.min(Math.max(pad, left), Math.max(pad, window.innerWidth - w - pad));
  top = Math.min(Math.max(pad, top), Math.max(pad, window.innerHeight - h - pad));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function placeBotContextMenu(x = botCtxPoint.x, y = botCtxPoint.y) {
  const menu = $('botContextMenu');
  if (!menu || menu.hidden) return;
  placeNearPoint(menu, x, y);
}

function placeBotGroupMenu(anchor) {
  const menu = $('botGroupMenu');
  const main = $('botContextMenu');
  if (!menu || !main || menu.hidden) return;
  const mainRect = main.getBoundingClientRect();
  const itemRect = anchor?.getBoundingClientRect?.() || mainRect;
  const pad = 8;
  const w = menu.offsetWidth || 248;
  const h = menu.offsetHeight || 0;
  let left = mainRect.right + 4;
  let top = itemRect.top - 12;
  if (left + w > window.innerWidth - pad) left = mainRect.left - 4 - w;
  if (top + h > window.innerHeight - pad) top = window.innerHeight - h - pad;
  left = Math.min(Math.max(pad, left), Math.max(pad, window.innerWidth - w - pad));
  top = Math.min(Math.max(pad, top), Math.max(pad, window.innerHeight - h - pad));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function showPaperHint(text, options) {
  // 统一走全局提示，避免多套 toast 外观与时长不一致
  messageActionNotice(text, options);
}

function renderBotContextMenu(bot) {
  const menu = $('botContextMenu');
  if (!menu || !bot) return;
  const pinned = botSeal(bot).pinned === true;
  const hidden = isBotHidden(bot.id);
  const searching = Boolean(sidebarQuery());
  const unread = botHasUnread(bot);
  menu.innerHTML = [
    ctxItemMarkup({ action: 'pin', icon: 'pin', label: pinned ? '取消置顶' : '置顶' }),
    ctxItemMarkup({ action: 'group', icon: 'folder', label: '移至新分组' }),
    ctxItemMarkup({ action: 'read', icon: 'bell', label: '标为已读', hidden: !unread }),
    '<div class="bot-ctx-sep" role="separator"></div>',
    ctxItemMarkup({ action: 'avatar', icon: 'avatar', label: '自定义头像' }),
    ctxItemMarkup({ action: 'rename', icon: 'rename', label: '重命名 Bot' }),
    ctxItemMarkup({ action: 'copy', icon: 'copy', label: '复制对话 ID' }),
    ctxItemMarkup({ action: 'hide', icon: hidden && searching ? 'eye' : 'eyeOff', label: hidden && searching ? '在侧边栏显示' : '从侧边栏隐藏' }),
    ctxItemMarkup({ action: 'recall', icon: 'eyeOff', label: `从 ${shellModeLabel()} 名单收回`, hidden: !state.persistentBotRosters && (bot.id === 'new-character' || bot.id === state.botId) }),
    ctxItemMarkup({ action: 'delete', icon: 'trash', label: '删除', danger: true }),
  ].join('');
  menu.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onBotContextAction(bot, btn.dataset.action, btn);
    });
  });
}

function openBotContextMenu(id, point) {
  const bot = findBotById(id);
  const menu = $('botContextMenu');
  if (!bot?.id || !menu) return;
  closeCreateMenu();
  closeModelMenu();
  closeReviewMenu();
  closeBotGroupMenu();
  botCtxBotId = bot.id;
  botCtxPoint = { x: point?.x ?? 0, y: point?.y ?? 0 };
  renderBotContextMenu(bot);
  menu.hidden = false;
  placeBotContextMenu(botCtxPoint.x, botCtxPoint.y);
  const first = menu.querySelector('.bot-ctx-item:not([hidden])');
  first?.focus();
}

function openBotGroupMenu(bot, anchor) {
  const menu = $('botGroupMenu');
  if (!menu) return;
  const folders = sidebarFolders();
  const current = folderIdOf(bot.id);
  const items = folders.map((folder) => ctxItemMarkup({
    action: `folder:${folder.id}`,
    icon: 'folder',
    label: folder.name,
  }));
  items.push(ctxItemMarkup({ action: 'new-folder', icon: 'folder', label: '新分组…' }));
  menu.innerHTML = items.join('');
  menu.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const action = btn.dataset.action;
      if (action === 'new-folder') {
        closeBotContextMenu();
        openNewFolderDialog(bot);
        return;
      }
      if (action.startsWith('folder:')) {
        const folderId = action.slice(7);
        updateSidebarPrefs((prefs) => {
          prefs.folderOf[bot.id] = folderId;
          return prefs;
        });
        closeBotContextMenu();
        renderBotList();
      }
    });
  });
  menu.hidden = false;
  placeBotGroupMenu(anchor);
  const focusTarget = current
    ? menu.querySelector(`[data-action="folder:${CSS.escape ? CSS.escape(current) : current}"]`)
    : menu.querySelector('.bot-ctx-item');
  (focusTarget || menu.querySelector('.bot-ctx-item'))?.focus();
}

function openPaperPrompt({ title, message, value = '', placeholder = '', hasInput = false, confirmLabel = '确定', danger = false, validate, onConfirm }) {
  bumpUiTicket();
  const inputHtml = hasInput
    ? `<input id="paperPromptInput" class="paper-prompt-input" maxlength="40" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder || '')}" autocomplete="off" aria-label="${escapeHtml(placeholder || title)}">`
    : '';
  showModal(`
    <div class="paper-prompt-body">
      <h2 class="paper-prompt-title" id="paperPromptTitle">${escapeHtml(title)}</h2>
      ${message ? `<p class="paper-prompt-text" id="paperPromptText">${message}</p>` : ''}
      ${inputHtml}
      <p class="paper-prompt-msg" id="paperPromptMsg"></p>
      <div class="paper-prompt-actions">
        <button type="button" class="paper-prompt-cancel" data-close>取消</button>
        <button type="button" class="paper-prompt-ok${danger ? ' is-danger' : ''}" id="paperPromptOk">${escapeHtml(confirmLabel)}</button>
      </div>
    </div>`, false, 'paper-prompt');
  const input = $('paperPromptInput');
  const ok = $('paperPromptOk');
  const msg = $('paperPromptMsg');
  const submit = async () => {
    const next = input ? String(input.value || '').trim() : '';
    if (validate) {
      const error = validate(next);
      if (error) {
        if (msg) msg.textContent = error;
        input?.focus();
        return;
      }
    }
    const result = await onConfirm(next, { input, ok, msg });
    if (result === false) return;
    closeModal();
  };
  ok?.addEventListener('click', () => { submit(); });
  input?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || isImeComposing(event)) return;
    event.preventDefault();
    submit();
  });
  (input || ok)?.focus();
  if (input) {
    input.select();
  }
}

function openNewFolderDialog(bot) {
  openPaperPrompt({
    title: '新分组',
    placeholder: '给这个分组起个名字',
    value: '',
    hasInput: true,
    confirmLabel: '创建',
    validate: (name) => {
      if (!name) return '请填写分组名称。';
      if (isForbiddenDisplayName(name)) return '请换一个名称。';
      return '';
    },
    onConfirm: (name) => {
      const folder = { id: `folder-${Date.now().toString(36)}`, name };
      updateSidebarPrefs((prefs) => {
        prefs.folders = [...prefs.folders, folder];
        prefs.folderOf[bot.id] = folder.id;
        return prefs;
      });
      renderBotList();
    },
  });
}

function openRenameBotDialog(bot) {
  const current = displayBotName(bot);
  openPaperPrompt({
    title: '重命名 Bot',
    placeholder: '给这个 bot 起个名字',
    value: current === FORBIDDEN_DISPLAY_NAME ? '' : current,
    hasInput: true,
    confirmLabel: '确定',
    validate: (name) => {
      if (!name) return '请填写名称。';
      if (isForbiddenDisplayName(name)) return '请换一个名称。';
      return '';
    },
    onConfirm: (name) => {
      updateSidebarPrefs((prefs) => {
        prefs.names[bot.id] = name;
        return prefs;
      });
      patchBotRecord(bot.id, { name });
      if (bot.id === state.botId) {
        state.botName = name;
        applyBotChrome();
      } else {
        renderBotList();
      }
    },
  });
}

function deleteGuardReason(bot) {
  if (!bot?.id) return 'current';
  if (state.persistentBotRosters) return '';
  if (bot.id === LIVE_MAIN_BOT_ID) return 'live';
  if (bot.id === state.botId) return 'current';
  const session = state.sessionIdentity;
  if (session && (session.botId === bot.id || session.toBotId === bot.id) && isProtectedLiveMainSession(session)) return 'live';
  return '';
}

function openDeleteBotDialog(bot) {
  const name = displayBotName(bot);
  const mode = state.shellMode, native = state.persistentBotRosters;
  openPaperPrompt({
    title: native ? `删除 ${shellModeLabel(mode)} 会话` : '删除 bot',
    message: native ? `将清除与「${escapeHtml(name)}」在 ${shellModeLabel(mode)} 中的单聊消息，并从此模式的名单收回。另一个模式、人设、记忆、任务和成果保留，可从角色库重新调入。` : `将清除与「${escapeHtml(name)}」的单聊消息，并从 Chat、Work 名单收回。人设、记忆、任务和成果保留，可从角色库重新调入；记忆由你在记忆面板单独删除。`,
    confirmLabel: '删除',
    danger: true,
    onConfirm: async (_value, { msg }) => {
      const reason = deleteGuardReason(bot);
      if (reason === 'current') {
        if (msg) msg.textContent = '不能删除当前 bot';
        return false;
      }
      if (reason === 'live') {
        if (msg) msg.textContent = '不能删除活主 bot';
        return false;
      }
      if (msg) msg.textContent = '正在清除会话消息…';
      try {
        const result = await api(`/api/dimension/bots/${encodeURIComponent(bot.id)}${native ? `?mode=${mode}` : ''}`, { method: 'DELETE' });
        if (Array.isArray(result.bots)) replaceKnownBots(result.bots);
        updateSidebarPrefs((prefs) => {
          delete prefs.deleted[bot.id];
          if (!native || mode === 'work') prefs.workBots = (prefs.workBots || []).filter((id) => id !== bot.id);
          if (!native || mode === 'chat') prefs.chatBots = (prefs.chatBots || []).filter((id) => id !== bot.id);
          return prefs;
        });
        for (const affectedMode of native ? [mode] : ['chat', 'work']) {
          if (state.selections[affectedMode]?.kind === 'bot' && state.selections[affectedMode].id === bot.id) state.selections[affectedMode] = null;
          if (state.lastSelectedBots[affectedMode] === bot.id) state.lastSelectedBots[affectedMode] = null;
        }
        if (state.savedPreGroupSelection?.value?.id === bot.id && (!native || state.savedPreGroupSelection.mode === mode)) state.savedPreGroupSelection = null;
        if (state.savedPreGroupBotId === bot.id && (!native || state.shellMode === mode)) {
          state.savedPreGroupBotId = null; state.savedPreGroupNodes = null; state.savedChatNodes = null;
        }
        renderBotList();
      } catch (err) {
        if (msg) msg.textContent = err.message || '删除失败';
        return false;
      }
    },
  });
}

function openEditPaperSeal(bot) {
  bumpUiTicket();
  const current = botSeal(bot);
  const draft = { shape: 'round-seal', color: current.color };
  const name = displayBotName(bot);
  const colorButtons = SEAL_COLORS.map((item) => `
      <button type="button" data-color="${escapeHtml(item.id)}" class="${item.id === 'ivory' ? 'is-ivory' : ''}" aria-label="${escapeHtml(item.name)}" aria-selected="${item.id === draft.color ? 'true' : 'false'}" style="background:${escapeHtml(item.hex)}"></button>`).join('');
  showModal(`
    <div class="create-bot-body">
      <h2 class="create-bot-title" id="editSealTitle">自定义头像</h2>
      <div class="create-bot-preview" id="editSealPreview"></div>
      <div class="create-bot-avatar-row">
        <button type="button" class="create-bot-library" id="uploadAvatarBtn">上传自己的头像</button>
        <button type="button" class="create-bot-cancel" id="resetAvatarBtn" hidden>恢复默认头像</button>
        <input type="file" id="avatarFileInput" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
      </div>
      <div class="create-bot-colors" id="editSealColors" role="listbox" aria-label="颜色">${colorButtons}</div>
      <div class="create-bot-footer">
        <button type="button" class="create-bot-cancel" data-close>取消</button>
        <button type="button" class="create-bot-submit" id="confirmEditSeal">保存</button>
      </div>
      <p class="create-bot-msg" id="editSealMsg"></p>
    </div>`, false, 'create-bot');
  const preview = document.getElementById('editSealPreview');
  const submitBtn = document.getElementById('confirmEditSeal');
  const colorHex = (id) => SEAL_COLORS.find((c) => c.id === id)?.hex || '#2a2723';
  const resetBtn = document.getElementById('resetAvatarBtn');
  const uploadBtn = document.getElementById('uploadAvatarBtn'), avatarInput = document.getElementById('avatarFileInput'), avatarMessage = document.getElementById('editSealMsg');
  let avatarBusy = false;
  const avatarPending = busy => { avatarBusy = busy; uploadBtn.disabled = busy; resetBtn.disabled = busy; avatarInput.disabled = busy; submitBtn.disabled = busy; };
  const refreshPreview = () => {
    if (!preview.isConnected) return;
    preview.innerHTML = botAvatar(bot, 96);
    resetBtn.hidden = !bot.hasAvatar;
    for (const btn of document.querySelectorAll('#editSealColors [data-color]')) {
      btn.setAttribute('aria-selected', btn.dataset.color === draft.color ? 'true' : 'false');
    }
  };
  refreshPreview();
  uploadBtn.addEventListener('click', () => avatarInput.click());
  avatarInput.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file || avatarBusy) return;
    avatarPending(true);
    try {
      const result = await uploadImageAsset(`/api/dimension/bots/${encodeURIComponent(bot.id)}/avatar`, file);
      Object.assign(bot, { hasAvatar: true, avatarRevision: result?.avatarRevision || String(Date.now()) });
      patchBotRecord(bot.id, { hasAvatar: true, avatarRevision: bot.avatarRevision });
      refreshPreview();
      refreshBotChromeOrList(bot.id);
      avatarMessage.textContent = '头像已更新。';
    } catch (err) { avatarMessage.textContent = err.message || '上传失败'; }
    finally { avatarPending(false); avatarInput.value = ''; }
  });
  resetBtn.addEventListener('click', async () => {
    if (avatarBusy) return;
    avatarPending(true);
    try {
      await api(`/api/dimension/bots/${encodeURIComponent(bot.id)}/avatar`, { method: 'DELETE' });
      Object.assign(bot, { hasAvatar: false, avatarRevision: '' });
      patchBotRecord(bot.id, { hasAvatar: false, avatarRevision: '' });
      refreshPreview();
      refreshBotChromeOrList(bot.id);
      avatarMessage.textContent = '已恢复默认头像。';
    } catch (err) { avatarMessage.textContent = err.message || '删除失败'; }
    finally { avatarPending(false); }
  });
  document.getElementById('editSealColors').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-color]');
    if (!btn) return;
    draft.color = btn.dataset.color;
    refreshPreview();
  });
  const submit = async () => {
    const msg = document.getElementById('editSealMsg');
    submitBtn.disabled = true;
    const paperSeal = { shape: draft.shape, color: draft.color, pinned: current.pinned === true };
    await persistPaperSeal(bot.id, paperSeal);
    patchBotRecord(bot.id, { paperSeal: { ...paperSeal, stored: true }, pinned: paperSeal.pinned });
    closeModal();
    refreshBotChromeOrList(bot.id);
    if (msg) msg.textContent = '';
  };
  submitBtn.addEventListener('click', submit);
}

async function copyBotConversationId(bot) {
  const text = botConversationId(bot);
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const input = document.createElement('textarea');
      input.value = text;
      input.setAttribute('readonly', '');
      input.style.position = 'fixed';
      input.style.left = '-9999px';
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
    }
    showPaperHint('已复制');
  } catch {
    showPaperHint('复制失败');
  }
}

async function onBotContextAction(bot, action, button) {
  if (action === 'group') {
    if (!$('botGroupMenu') || $('botGroupMenu').hidden === false) {
      // if already open, keep / refresh
    }
    openBotGroupMenu(bot, button);
    return;
  }
  closeBotContextMenu();
  if (action === 'pin') {
    const seal = botSeal(bot);
    const next = { shape: seal.shape, color: seal.color, pinned: !seal.pinned };
    writeLocalSeal(bot.id, next);
    patchBotRecord(bot.id, { pinned: next.pinned, paperSeal: { ...next, stored: true } });
    renderBotList();
    persistPaperSeal(bot.id, next);
    return;
  }
  if (action === 'read') {
    updateSidebarPrefs((prefs) => {
      prefs.unread[bot.id] = false;
      return prefs;
    });
    patchBotRecord(bot.id, { unread: false, unreadCount: 0, hasUnread: false });
    renderBotList();
    return;
  }
  if (action === 'avatar') {
    openEditPaperSeal(bot);
    return;
  }
  if (action === 'rename') {
    openRenameBotDialog(bot);
    return;
  }
  if (action === 'copy') {
    copyBotConversationId(bot);
    return;
  }
  if (action === 'hide') {
    const hidden = isBotHidden(bot.id);
    const searching = Boolean(sidebarQuery());
    updateSidebarPrefs((prefs) => {
      if (hidden && searching) delete prefs.hidden[bot.id];
      else prefs.hidden[bot.id] = true;
      return prefs;
    });
    renderBotList();
    return;
  }
  if (action === 'recall') {
    try { await removeFromRoster(bot.id); renderBotList(); }
    catch (error) { showPaperHint(error.message || '收回失败'); }
    return;
  }
  if (action === 'delete') {
    openDeleteBotDialog(bot);
  }
}

function bindBotContextMenu() {
  if (document.documentElement.dataset.botCtxBound === '1') return;
  document.documentElement.dataset.botCtxBound = '1';
  document.addEventListener('pointerdown', (event) => {
    if (!isBotContextMenuOpen() && $('botGroupMenu')?.hidden !== false) return;
    if (event.target.closest('#botContextMenu, #botGroupMenu')) return;
    closeBotContextMenu();
  });
  window.addEventListener('resize', () => {
    if (isBotContextMenuOpen()) placeBotContextMenu();
    if ($('botGroupMenu') && !$('botGroupMenu').hidden) {
      const anchor = $('botContextMenu')?.querySelector('[data-action="group"]');
      placeBotGroupMenu(anchor);
    }
  });
  document.addEventListener('scroll', () => {
    if (isBotContextMenuOpen()) closeBotContextMenu();
  }, true);
}

function bindLeftbarControls() {
  const tarotBtn = $('openTarotGalleryBtn');
  if (tarotBtn && tarotBtn.dataset.bound !== '1') {
    tarotBtn.dataset.bound = '1';
    tarotBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeCreateMenu();
      openTarotGalleryWithSwitch();
    });
  }
  const searchBtn = $('searchBotBtn');
  const searchInput = $('sidebarSearchInput');
  const searchClear = $('sidebarSearchClear');
  const newBtn = $('newBotBtn');
  const modeBtn = $('modeSwitch');
  const menu = $('createMenu');
  if (searchBtn && searchBtn.dataset.bound !== '1') {
    searchBtn.dataset.bound = '1';
    searchBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeCreateMenu();
      toggleSidebarSearch();
    });
  }
  if (searchInput && searchInput.dataset.bound !== '1') {
    searchInput.dataset.bound = '1';
    searchInput.addEventListener('input', () => {
      syncSidebarSearchClear();
      renderBotList();
    });
    searchInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (String(searchInput.value || '')) {
        searchInput.value = '';
        syncSidebarSearchClear();
        renderBotList();
        return;
      }
      closeSidebarSearch();
    });
  }
  if (searchClear && searchClear.dataset.bound !== '1') {
    searchClear.dataset.bound = '1';
    searchClear.addEventListener('click', (event) => {
      event.preventDefault();
      if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
      }
      syncSidebarSearchClear();
      renderBotList();
    });
  }
  if (newBtn && newBtn.dataset.bound !== '1') {
    newBtn.dataset.bound = '1';
    newBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleCreateMenu();
    });
  }
  if (menu && menu.dataset.bound !== '1') {
    menu.dataset.bound = '1';
    $('createMenuBot')?.addEventListener('click', (event) => {
      event.preventDefault();
      closeCreateMenu();
      openCreateBot();
    });
    $('createMenuGroup')?.addEventListener('click', (event) => {
      event.preventDefault();
      closeCreateMenu();
      openCreateGroup();
    });
    $('createMenuGroupPool')?.addEventListener('click', event => {
      event.preventDefault(); closeCreateMenu(); openGroupPool();
    });
  }
  if (modeBtn && modeBtn.dataset.bound !== '1') {
    modeBtn.dataset.bound = '1';
    modeBtn.addEventListener('click', (event) => {
      event.preventDefault();
      toggleShellMode();
    });
    modeBtn.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      toggleShellMode();
    });
  }
  const modeSeg = $('modeSegPill');
  if (modeSeg && modeSeg.dataset.bound !== '1') {
    modeSeg.dataset.bound = '1';
    modeSeg.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-shell-target]');
      if (!tab) return;
      event.preventDefault();
      setShellMode(tab.dataset.shellTarget);
    });
  }
  const sbResizer = $('sidebarResizer');
  const appRoot = $('app');
  if (sbResizer && appRoot && sbResizer.dataset.bound !== '1') {
    sbResizer.dataset.bound = '1';
    const SB_WIDTH_KEY = 'dimension-sidebar-width';
    try {
      const savedW = Number(localStorage.getItem(SB_WIDTH_KEY));
      if (Number.isFinite(savedW) && savedW >= 220 && savedW <= 380) {
        appRoot.style.setProperty('--user-sidebar-width', `${Math.round(savedW)}px`);
      }
    } catch {}
    sbResizer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || appRoot.classList.contains('is-sidebar-collapsed')) return;
      event.preventDefault();
      sbResizer.setPointerCapture(event.pointerId);
      document.body.classList.add('is-resizing-sidebar');
      const startX = event.clientX;
      const startW = $('sidebar')?.getBoundingClientRect().width || 268;
      let latestW = startW;
      const onMove = (ev) => {
        latestW = Math.max(220, Math.min(380, startW + (ev.clientX - startX)));
        appRoot.style.setProperty('--user-sidebar-width', `${Math.round(latestW)}px`);
      };
      const onUp = () => {
        document.body.classList.remove('is-resizing-sidebar');
        sbResizer.removeEventListener('pointermove', onMove);
        sbResizer.removeEventListener('pointerup', onUp);
        sbResizer.removeEventListener('pointercancel', onUp);
        try { localStorage.setItem(SB_WIDTH_KEY, String(Math.round(latestW))); } catch {}
      };
      sbResizer.addEventListener('pointermove', onMove);
      sbResizer.addEventListener('pointerup', onUp);
      sbResizer.addEventListener('pointercancel', onUp);
    });
  }
  if (document.documentElement.dataset.createMenuBound !== '1') {
    document.documentElement.dataset.createMenuBound = '1';
    document.addEventListener('pointerdown', (event) => {
      if (!isCreateMenuOpen()) return;
      if (event.target.closest('#createMenu, #newBotBtn')) return;
      closeCreateMenu();
    });
    window.addEventListener('resize', () => { if (isCreateMenuOpen()) placeCreateMenu(); });
    window.visualViewport?.addEventListener('resize', () => { if (isCreateMenuOpen()) placeCreateMenu(); });
  }
  syncSidebarSearchClear();
  setShellMode(readShellMode());
}

function openKeyboardHelp() {
  showModal(`<div class="modal-head"><h2>✦ 键位秘籍</h2><button type="button" class="icon-btn" data-close>关闭</button></div>
    <div class="modal-body keyboard-help">
      <p class="muted">快捷键与页面按钮执行同一命令。</p>
      <dl class="keyboard-help-list">
        <div><dt><kbd>Enter</kbd> / <kbd>Ctrl</kbd> + <kbd>Enter</kbd></dt><dd>发送当前输入</dd></div>
        <div><dt><kbd>Shift</kbd> + <kbd>Enter</kbd></dt><dd>换行，不发送</dd></div>
        <div><dt><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>M</kbd></dt><dd>切换「闲谈 / 工坊」模式</dd></div>
        <div><dt><kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>↑</kbd> / <kbd>↓</kbd></dt><dd>切换到上一个 / 下一个会话</dd></div>
        <div><dt><kbd>Ctrl</kbd> + <kbd>K</kbd></dt><dd>全局搜索（会话、记忆、委托）</dd></div>
        <div><dt><kbd>Ctrl</kbd> + <kbd>F</kbd></dt><dd>在当前对话中查找</dd></div>
        <div><dt><kbd>Alt</kbd> + <kbd>↑</kbd></dt><dd>工坊：打开审批模式菜单</dd></div>
        <div><dt><kbd>Shift</kbd> + <kbd>F10</kbd> / 菜单键</dt><dd>打开会话或成员的操作菜单</dd></div>
        <div><dt><kbd>Ctrl</kbd> + <kbd>/</kbd></dt><dd>打开本秘籍</dd></div>
        <div><dt><kbd>Esc</kbd></dt><dd>关闭最上层的菜单或弹窗（一次一层）</dd></div>
        <div><dt>沉浸模式 · <kbd>Space</kbd> / <kbd>Enter</kbd></dt><dd>快进当前演译 / 推进下一句 / 轮到你发言</dd></div>
        <div><dt>沉浸模式 · <kbd>←</kbd> / <kbd>→</kbd></dt><dd>回看上一句 / 下一句对话</dd></div>
        <div><dt>沉浸模式 · <kbd>A</kbd> / <kbd>H</kbd> / <kbd>L</kbd> / <kbd>M</kbd></dt><dd>自动观剧 / 隐藏对话框 / 文本履历 / 静音音效</dd></div>
      </dl>
      <p class="muted">恢复草稿只会填入输入框，不会自动发送；中文输入法组词期间 Enter 不会发送。macOS 使用 Command 替代 Ctrl。</p>
    </div>`, false, 'keyboard-help-modal');
}

function cycleVisibleConversation(direction) {
  const selector = isWorkShell()
    ? '#workRosterHost .wrt-owner-btn[data-id], #workRosterHost .wrt-owner-btn[data-group-id]'
    : '#botList [data-id], #groupList [data-group-id]';
  const buttons = [...document.querySelectorAll(selector)]
    .filter(node => node.getBoundingClientRect().height > 0 && !node.disabled);
  if (!buttons.length) return;
  const current = buttons.findIndex(node => state.activeGroupId
    ? node.dataset.groupId === state.activeGroupId
    : node.dataset.id === state.botId && !node.dataset.groupId);
  const next = current < 0 ? 0 : (current + direction + buttons.length) % buttons.length;
  buttons[next]?.click();
}

function bindUi() {
  // 抽屉各项的说明文案已统一写在 index.html（“风格化标题 + 白话说明”），这里不再运行时覆盖
  $('identityBtn').addEventListener('click', () => openDrawer($('drawer').hidden || state.drawerClosing));
  window.addEventListener('resize', syncDrawerLayout);
  window.visualViewport?.addEventListener('resize', syncDrawerLayout);
  bindWindowChrome();
  applyTheme(readClientSettings().theme);
  const clientSettings = bindClientSettings({ api });
  window.__dimensionOpenClientSettings = (pane = '') => clientSettings.open(pane);
  window.addEventListener('dimension:cli-sandbox-updated', async () => {
    try {
      const grp = currentGroup();
      const botId = (isWorkShell() && grp) ? (grp.ownerId || grp.members?.[0] || state.botId) : state.botId;
      if (botId) {
        const data = await api(`/api/dimension/work/settings?botId=${encodeURIComponent(botId)}`);
        if (data?.settings) state.workSettings = data.settings;
      }
      workUi?.sync();
      workDock?.refreshCanvasLibrary?.();
    } catch {}
  });
  syncChromeCloseTitle();
  bindSidebarCollapse();
  $('pgSidebarExpandBtn')?.addEventListener('click', () => $('sidebarExpandBtn')?.click());
  playgroundUi = createPlaygroundController({
    sidebarHost: $('playgroundSidebarHost'),
    stageHost: $('playgroundStageHost'),
    getBots: () => knownBots(),
    onSetSidebarCollapsed: (collapsed) => {
      const appEl = $('app');
      if (!appEl) return;
      appEl.classList.toggle('is-sidebar-collapsed', Boolean(collapsed));
      const expand = $('sidebarExpandBtn');
      if (expand) expand.hidden = !collapsed;
    },
  });
  window.__dimensionOpenClientSettings = (pane = '') => clientSettings.open(pane);
  window.addEventListener('dimension-context-limits-changed', () => {
    contextUsageUi?.refresh();
  });
  const pwbDialog = $('publicWorkbenchDialog');
  $('openPublicWorkbenchBtn')?.addEventListener('click', () => {
    if (pwbDialog && !pwbDialog.open) pwbDialog.showModal();
  });
  $('publicWorkbenchClose')?.addEventListener('click', () => pwbDialog?.close());
  pwbDialog?.addEventListener('click', (event) => {
    if (event.target === pwbDialog) { pwbDialog.close(); return; }
    const card = event.target.closest('.pwb-card');
    if (card && !card.disabled) {
      pwbDialog.close();
      attachHubBackButton(card.querySelector('strong')?.textContent || '');
    }
  }, true);
  // 从扩展中枢进入子面板后，在子面板顶部放一个“← 返回扩展中枢”，不用再从侧栏重新打开
  function attachHubBackButton(label) {
    let tries = 0;
    const tryAttach = () => {
      const dialogs = [...document.querySelectorAll('dialog[open]')].filter((d) => d !== pwbDialog && !d.classList.contains('paper-confirm-dialog'));
      const modal = $('modal');
      const host = dialogs[dialogs.length - 1] || (modal && !modal.hidden ? modal : null);
      if (!host) { if (++tries < 12) setTimeout(tryAttach, 60); return; }
      if (host.querySelector('.hub-back-btn')) return;
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'hub-back-btn';
      back.innerHTML = '<span aria-hidden="true">←</span> 返回扩展中枢';
      back.title = label ? `离开「${label}」，回到扩展中枢` : '回到扩展中枢';
      back.addEventListener('click', () => {
        if (host.tagName === 'DIALOG') host.close();
        else closeModal();
        if (!pwbDialog.open) pwbDialog.showModal();
      });
      // 有的子面板 <dialog> 本身是透明外壳、真正的卡片是第一个子元素：放进卡片里，避免按钮悬在卡片外
      const transparent = getComputedStyle(host).backgroundColor === 'rgba(0, 0, 0, 0)';
      const inner = transparent && host.firstElementChild ? host.firstElementChild : host;
      inner.prepend(back);
      if (host.tagName === 'DIALOG') host.addEventListener('close', () => back.remove(), { once: true });
    };
    setTimeout(tryAttach, 30);
  }
  bindLeftbarControls();
  bindBotContextMenu();
  bindModelSwitch();
  $('keyboardHelpBtn')?.addEventListener('click', openKeyboardHelp);
  const backdrop = $('backdrop');
  backdrop.addEventListener('pointerdown', (event) => {
    state.backdropArmed = event.target === backdrop && event.button === 0;
  });
  backdrop.addEventListener('pointercancel', () => { state.backdropArmed = false; });
  backdrop.addEventListener('click', (event) => {
    const armed = state.backdropArmed && event.target === backdrop;
    state.backdropArmed = false;
    if (!armed) return;
    event.preventDefault();
    closeTopLayer();
  });
  $('modal').addEventListener('click', (event) => {
    if (!event.target.closest('[data-close]')) return;
    event.preventDefault();
    event.stopPropagation();
    closeModal();
  });
  document.addEventListener('keydown', (event) => {
    // Modal dialogs own their shortcuts, including native Escape cancellation.
    if (document.querySelector('dialog[open]')) return;
    const command = event.ctrlKey || event.metaKey;
    if (!isModalOpen() && command && !event.repeat && event.key === '/') {
      event.preventDefault(); openKeyboardHelp(); return;
    }
    if (!isModalOpen() && command && event.shiftKey && !event.altKey && !event.repeat && event.key.toLocaleLowerCase() === 'm') {
      event.preventDefault(); toggleShellMode(); return;
    }
    if (!isModalOpen() && command && event.altKey && !event.repeat && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault(); cycleVisibleConversation(event.key === 'ArrowUp' ? -1 : 1); return;
    }
    if (event.altKey && event.key === 'ArrowUp' && isWorkShell() && !event.repeat) {
      event.preventDefault();
      toggleReviewMenu();
      return;
    }
    if (event.key !== 'Escape') return;
    if (event.defaultPrevented) return;
    // Esc 按层级由上往下只关一层：灯箱 → 聊天内搜索 → 各类菜单 → 弹窗 → 侧栏搜索 → 抽屉
    if ($('chatImageLightbox') && !$('chatImageLightbox').hidden) {
      event.preventDefault();
      closeChatImageLightbox();
      return;
    }
    if ($('chatSearchBar') && !$('chatSearchBar').hidden) {
      event.preventDefault();
      closeChatSearch();
      return;
    }
    if (isBotContextMenuOpen() || ($('botGroupMenu') && !$('botGroupMenu').hidden)) {
      event.preventDefault();
      closeBotContextMenu();
      return;
    }
    if (isModelMenuOpen()) {
      event.preventDefault();
      closeModelMenu();
      return;
    }
    if (isReviewMenuOpen()) {
      event.preventDefault();
      closeReviewMenu();
      return;
    }
    if (isCreateMenuOpen()) {
      event.preventDefault();
      closeCreateMenu();
      return;
    }
    if (isModalOpen()) {
      event.preventDefault();
      closeTopLayer();
      return;
    }
    if (isSidebarSearchOpen()) {
      const input = $('sidebarSearchInput');
      if (input && String(input.value || '')) {
        event.preventDefault();
        input.value = '';
        syncSidebarSearchClear();
        renderBotList();
        return;
      }
      event.preventDefault();
      closeSidebarSearch();
      return;
    }
    if (isDrawerOpen()) {
      event.preventDefault();
      closeTopLayer();
      return;
    }
    if (workDock?.isOpen()) {
      event.preventDefault();
      workDock.close();
    }
  });
  document.querySelectorAll('.drawer-item').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ticket = state.uiTicket + 1;
      try {
        if (btn.dataset.open === 'persona') await openPersona();
        if (btn.dataset.open === 'context') await openContext();
        if (btn.dataset.open === 'memory') await openMemory();
        if (btn.dataset.open === 'space') await openSpace();
        if (btn.dataset.open === 'models') await openKeys();
        if (btn.dataset.open === 'bot-archive') {
          const selected = knownBots().find(bot => bot.id === state.botId);
          if (selected) botArchiveUi?.openExport({ ...selected, name: displayBotName(selected) });
        }
        if (btn.dataset.open === 'archived-work') {
          const selected = knownBots().find(bot => bot.id === state.botId);
          if (selected) archivedWorkUi?.open({ ...selected, name: displayBotName(selected) });
        }
      } catch (err) {
        if (!isCurrentUi(ticket)) return;
        showModal(`<div class="modal-head"><h2>无法打开</h2><button type="button" class="icon-btn" data-close>关闭</button></div><div class="modal-body"><p>${escapeHtml(err.message)}</p></div>`);
      }
    });
  });
  bindReviewEntry();
  bindGroupBar();
  syncChatThinkingToggle();
  const input = $('composerInput');
  const syncChatImageDraft = () => {
    const host = $('chatImageDraft');
    if (!host) return;
    const list = attachmentDraft().images || [];
    host.hidden = !list.length;
    if (host.hidden) { host.innerHTML = ''; return; }
    host.innerHTML = list.map((img, idx) => `
      <div class="chat-image-draft-item">
        <img src="${escapeHtml(img.url)}" alt="待发图片">
        <button type="button" class="chat-image-draft-del" data-idx="${idx}" aria-label="移除图片">×</button>
      </div>`).join('');
    host.querySelectorAll('.chat-image-draft-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        attachmentDraft().images.splice(Number(btn.dataset.idx), 1);
        syncChatImageDraft();
        syncSendEnabled(input, $('sendBtn'));
      });
    });
  };
  const encodeImageFileToPngBlob = (file) => new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const maxEdge = 1600;
      const scale = Math.min(1, maxEdge / Math.max(img.width || 1, img.height || 1));
      const w = Math.max(1, Math.round((img.width || 1) * scale));
      const h = Math.max(1, Math.round((img.height || 1) * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('图片编码失败'))), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法读取该图片')); };
    img.src = url;
  });
  const handleChatImageFiles = async (files) => {
    if (!hasConversation()) return;
    const draft = attachmentDraft();
    for (const file of files) {
      if (!file || !String(file.type || '').startsWith('image/')) continue;
      if (draft.images.length + draft.uploading >= 3) { toast('单条消息最多附带 3 张图片'); break; }
      draft.uploading++;
      try {
        const pngBlob = await encodeImageFileToPngBlob(file);
        const resp = await fetch('/api/dimension/chat/images', {
          method: 'POST',
          headers: { 'Content-Type': 'image/png' },
          body: pngBlob,
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data?.id) throw new Error(data?.error || '图片上传失败');
        draft.images.push({ id: data.id, url: data.url });
        syncChatImageDraft();
        syncSendEnabled(input, $('sendBtn'));
      } catch (err) {
        toast(err?.message || '上传图片失败');
      } finally {
        draft.uploading--;
      }
    }
  };
  window.__dimensionHandleComposerImages = handleChatImageFiles;
  syncChatImageDraftFn = syncChatImageDraft;
  $('chatImageBtn')?.addEventListener('click', () => {
    if (!hasConversation()) return;
    $('chatImageInput')?.click();
  });
  $('chatImageInput')?.addEventListener('change', (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (files.length) void handleChatImageFiles(files);
  });
  input.addEventListener('paste', (e) => {
    if (!hasConversation()) return;
    const items = [...(e.clipboardData?.items || [])];
    const imgs = items.filter((it) => it.kind === 'file' && String(it.type || '').startsWith('image/')).map((it) => it.getAsFile()).filter(Boolean);
    if (imgs.length) {
      e.preventDefault();
      void handleChatImageFiles(imgs);
    }
  });

  $('chatImageLightboxClose')?.addEventListener('click', closeChatImageLightbox);
  $('chatImageLightbox')?.addEventListener('click', (e) => {
    if (e.target === $('chatImageLightbox')) closeChatImageLightbox();
  });

  // Storage & Space Cleanup Dialog (扩展中枢 → 存储清理)
  {
    const dlg = $('storageCleanupDialog');
    const openBtn = $('sharedStorageCleanupBtn');
    const closeBtn = $('storageCleanupClose');
    const listEl = $('storageCatsList');
    const reclaimEl = $('storageReclaimableText');
    const totalEl = $('storageTotalText');
    const protEl = $('storageProtectedText');
    const autoCheck = $('storageAutoCleanCheck');
    const rescanBtn = $('storageRescanBtn');
    const cleanBtn = $('storageRunCleanBtn');
    let lastAudit = null;
    let selectedWorkDays = 7;
    const checkedIds = new Set(['old_releases', 'runtime_caches']);

    const fmtBytes = (b) => {
      const n = Number(b) || 0;
      if (n >= 1024 ** 3) return `${(n / (1024 ** 3)).toFixed(2)} GB`;
      if (n >= 1024 ** 2) return `${(n / (1024 ** 2)).toFixed(1)} MB`;
      if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
      return `${n} B`;
    };
    const updateCleanBtn = () => {
      if (!cleanBtn || !lastAudit) return;
      let sum = 0;
      for (const c of (lastAudit.categories || [])) {
        if (checkedIds.has(c.id)) sum += Number(c.bytes) || 0;
      }
      cleanBtn.disabled = checkedIds.size === 0 || sum === 0;
      cleanBtn.textContent = sum > 0 ? `立即清理（释放 ${fmtBytes(sum)}）` : '无可清理项';
    };
    const renderAudit = (data) => {
      lastAudit = data;
      if (reclaimEl) reclaimEl.textContent = fmtBytes(data?.reclaimableBytes);
      if (totalEl) totalEl.textContent = `总占用 ${fmtBytes(data?.totalBytes)}`;
      if (protEl) protEl.textContent = `核心受保护资产 ${fmtBytes(data?.protectedBytes)}`;
      if (autoCheck) autoCheck.checked = Boolean(data?.autoCleanEnabled);
      if (!listEl) return;
      listEl.innerHTML = (data?.categories || []).map((c) => {
        const checked = checkedIds.has(c.id);
        const daysHtml = c.id === 'old_work_runs'
          ? `<select class="storage-cat-days" id="storageWorkDaysSel">
               <option value="7"${selectedWorkDays === 7 ? ' selected' : ''}>清理 7 天前已完成</option>
               <option value="30"${selectedWorkDays === 30 ? ' selected' : ''}>清理 30 天前已完成</option>
               <option value="0"${selectedWorkDays === 0 ? ' selected' : ''}>清理全部已完成任务</option>
             </select>`
          : '';
        return `<label class="storage-cat-row">
          <input type="checkbox" data-cat-id="${escapeHtml(c.id)}"${checked ? ' checked' : ''}>
          <div class="storage-cat-main">
            <div class="storage-cat-head">
              <span class="storage-cat-title">${escapeHtml(c.title)}（${Number(c.count || 0)} 项）</span>
              <span class="storage-cat-size">${fmtBytes(c.bytes)}</span>
            </div>
            <div class="storage-cat-desc">${escapeHtml(c.desc)}</div>
            ${daysHtml}
          </div>
        </label>`;
      }).join('');
      listEl.querySelectorAll('input[data-cat-id]').forEach((cb) => {
        cb.addEventListener('change', () => {
          if (cb.checked) checkedIds.add(cb.dataset.catId);
          else checkedIds.delete(cb.dataset.catId);
          updateCleanBtn();
        });
      });
      const daysSel = $('storageWorkDaysSel');
      if (daysSel) {
        daysSel.addEventListener('click', (e) => e.stopPropagation());
        daysSel.addEventListener('change', () => {
          selectedWorkDays = Number(daysSel.value);
          void runAudit();
        });
      }
      updateCleanBtn();
    };
    const runAudit = async () => {
      if (reclaimEl) reclaimEl.textContent = '扫描中…';
      if (cleanBtn) cleanBtn.disabled = true;
      try {
        const data = await api(`/api/dimension/storage/audit?workDays=${selectedWorkDays}`);
        renderAudit(data);
      } catch (err) {
        if (reclaimEl) reclaimEl.textContent = '扫描失败';
        toast(err?.message || '扫描存储占用失败');
      }
    };
    openBtn?.addEventListener('click', () => {
      $('publicWorkbenchDialog')?.close?.();
      if (dlg && typeof dlg.showModal === 'function') dlg.showModal();
      void runAudit();
    });
    closeBtn?.addEventListener('click', () => dlg?.close?.());
    rescanBtn?.addEventListener('click', () => void runAudit());
    autoCheck?.addEventListener('change', async () => {
      try {
        await api('/api/dimension/storage/settings', {
          method: 'PUT',
          body: JSON.stringify({ autoCleanEnabled: Boolean(autoCheck.checked) }),
        });
        toast(autoCheck.checked ? '已开启自动定期保洁' : '已关闭自动定期保洁');
      } catch (err) {
        toast(err?.message || '保存自动保洁设置失败');
      }
    });
    cleanBtn?.addEventListener('click', async () => {
      if (!checkedIds.size) return;
      cleanBtn.disabled = true;
      cleanBtn.textContent = '清理中…';
      try {
        const res = await api('/api/dimension/storage/clean', {
          method: 'POST',
          body: JSON.stringify({ categories: [...checkedIds], workDays: selectedWorkDays }),
        });
        if (res?.audit) renderAudit(res.audit);
        toast(`清理完成！共释放 ${fmtBytes(res?.freedBytes)}（清理 ${Number(res?.removedCount || 0)} 项）`);
      } catch (err) {
        toast(err?.message || '清理失败');
        updateCleanBtn();
      }
    });
  }

  // Chat keyword search (Ctrl+F or top search icon)
  const openChatSearch = () => {
    if (isWorkShell() || !hasConversation()) return;
    const bar = $('chatSearchBar');
    if (!bar) return;
    bar.hidden = false;
    const inp = $('chatSearchInput');
    if (inp) { inp.focus(); inp.select(); }
  };
  const runChatSearch = async (rawQ, ticket, scope, targetId) => {
    const current = () => ticket === chatSearchVersion && !$('chatSearchBar')?.hidden &&
      (state.activeGroupId ? 'group' : 'bot') === scope && (state.activeGroupId || state.botId) === targetId;
    if (!current()) return;
    const q = String(rawQ || '').trim();
    const resBox = $('chatSearchResults');
    const countEl = $('chatSearchCount');
    if (!resBox || !countEl) return;
    if (!q) { resBox.hidden = true; resBox.innerHTML = ''; countEl.textContent = ''; return; }
    if (!targetId) return;
    try {
      const data = await api(`/api/dimension/chat/search?scope=${scope}&id=${encodeURIComponent(targetId)}&q=${encodeURIComponent(q)}`);
      if (!current()) return;
      const hits = data?.matches || [];
      countEl.textContent = hits.length ? `找到 ${hits.length} 条` : '无匹配';
      resBox.hidden = false;
      if (!hits.length) {
        resBox.innerHTML = '<div class="chat-search-hit"><div class="chat-search-hit-text">没有找到包含该关键词的对话记录</div></div>';
        return;
      }
      const safeRe = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      resBox.innerHTML = hits.map((h) => {
        const tsText = h.ts ? new Date(h.ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
        const highlighted = escapeHtml(h.text || '').replace(safeRe, (m) => `<mark>${m}</mark>`);
        return `<button type="button" class="chat-search-hit" data-target="${escapeHtml(h.messageId)}">
          <div class="chat-search-hit-meta"><span>${escapeHtml(h.from || '')}</span><span>${escapeHtml(tsText)}</span></div>
          <div class="chat-search-hit-text">${highlighted}</div>
        </button>`;
      }).join('');
      for (const button of resBox.querySelectorAll('button[data-target]')) {
        button.onclick = async () => {
          if (!current()) return;
          closeChatSearch();
          const navigation = chatSearchVersion;
          const active = () => navigation === chatSearchVersion && !isWorkShell() &&
            (state.activeGroupId ? 'group' : 'bot') === scope && (state.activeGroupId || state.botId) === targetId;
          if (!await revealGlobalSearchMessage(button.dataset.target, active) && active()) messageActionNotice('未找到原消息，可能已删除。');
        };
      }
    } catch {
      if (current()) countEl.textContent = '搜索失败';
    }
  };
  $('chatSearchBtn')?.addEventListener('click', () => {
    if ($('chatSearchBar')?.hidden) openChatSearch();
    else closeChatSearch();
  });
  $('chatSearchClose')?.addEventListener('click', closeChatSearch);
  $('chatSearchInput')?.addEventListener('input', (e) => {
    clearTimeout(chatSearchTimer);
    const val = e.target.value;
    const ticket = ++chatSearchVersion;
    const scope = state.activeGroupId ? 'group' : 'bot';
    const target = state.activeGroupId || state.botId;
    if (!val.trim()) void runChatSearch(val, ticket, scope, target);
    else chatSearchTimer = setTimeout(() => void runChatSearch(val, ticket, scope, target), 180);
  });
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !isWorkShell() && hasConversation()) {
      e.preventDefault();
      openChatSearch();
    } else if (e.key === 'Escape') {
      // 灯箱与聊天内搜索的 Esc 已并入 document 级的分层处理，这里不再重复关闭
    }
  });

  $('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!hasConversation()) return;
    const rawTrimmed = input.value.trim();
    const imgTags = attachmentDraft().images.map(img => `[chat-image:${img.id}]`);
    const text = isWorkShell()
      ? [
          rawTrimmed || (imgTags.length ? '请参考附带的图片完成任务' : ''),
          ...imgTags,
        ].filter(Boolean).join('\n')
      : [
          rawTrimmed,
          ...attachmentDraft().stickers.map(row => `[sticker:${row.id}]`),
          ...imgTags,
        ].filter(Boolean).join(' ');
    if (!text) return;
    if (isWorkShell()) {
      attachmentDraft().images.length = 0;
      syncChatImageDraft();
      input.value = '';
      autoGrow(input);
      conversationDrafts.clearAfterSend();
      syncSendEnabled(input, $('sendBtn'));
      sendSoloWork(text, takeGroupQuote());
      return;
    }
    if (state.activeGroupId) {
      attachmentDraft().stickers.length = 0;syncStickerDraft();
      attachmentDraft().images.length = 0;syncChatImageDraft();
      input.value = '';
      autoGrow(input);
      conversationDrafts.clearAfterSend();
      syncSendEnabled(input, $('sendBtn'));
      sendGroup(text);
      return;
    }
    if (state.pending) {
      // 以前这里静默返回，用户会以为没按到
      showPaperHint(`✦ ${state.botName || '伙伴'}还在回应中，等这句说完再寄出吧～`, { level: 'info' });
      return;
    }
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      // 连接断了（多半刚重启过）：不清输入框，告诉他重连后重发。
      addBubble('assistant', '连接断了，正在自动重连。这条没发出去——重连上之后原话再发一次就行。', '系统');
      if (!state.socket) connectChat();
      return;
    }
    const quote = takeGroupQuote();
    const retryKey = JSON.stringify({ scope: quoteScope(), text, quote: quote?.sourceRef });
    const requestId = state.chatSubmission?.key === retryKey ? state.chatSubmission.requestId : crypto.randomUUID();
    state.chatSubmission = { key: retryKey, requestId, text, quote, botId: state.botId, scope: quoteScope() };
    attachmentDraft().stickers.length = 0;syncStickerDraft();
    attachmentDraft().images.length = 0;syncChatImageDraft();
    addBubble('user', text, '你', { requestId });
    input.value = '';
    autoGrow(input);
    conversationDrafts.clearAfterSend();
      syncSendEnabled(input, $('sendBtn'));
    setPending(true);
    state.socket.send(JSON.stringify({ type: 'msg', text, botId: state.botId, requestId, ...(quote ? { quote: quote.sourceRef } : {}) }));
    sidebarActivity.message('chat', 'bot', state.botId);
  });
  bindComposerField(input, $('sendBtn'), () => { $('composer').requestSubmit(); });
  bindMentionPicker(input, currentMentionMembers);
  // 首屏低频弹窗模块按需懒加载：点击入口或触发自定义事件时再动态 import，加快冷启动
  const createLazyModule = (loader) => {
    let promise = null;
    return () => {
      if (!promise) {
        promise = loader().catch((err) => {
          promise = null;
          messageActionNotice(err?.message || '模块加载失败，请稍后重试');
          throw err;
        });
      }
      return promise;
    };
  };

  const ensureLinuxDesktop = createLazyModule(async () => {
    const { bindLinuxDesktop } = await import('./linux-desktop-ui.js');
    const mod = bindLinuxDesktop({
      api,
      getBotId: () => state.botId,
      getBots: () => knownBots(),
      onWorkspace: (id, path) => {
        if (id === state.botId) { state.workSettings.projectCwd = path; workUi?.sync(); }
      },
      onRequestEmbed: ({ library = false, targetBotId = '' } = {}) => {
        if (!isWorkShell() || !workDock?.openDesktop) return false;
        workDock.openDesktop({ library, targetBotId });
        return true;
      },
      onRequestCloseEmbed: () => {
        workDock?.openOverview?.();
      },
    });
    linuxDesktopApi = mod;
    linuxDesktopReady = true;
    return mod;
  });
  ensureLinuxDesktopFn = ensureLinuxDesktop;
  let linuxDesktopReady = false;
  const triggerLinuxDesktop = (softwareOnly = false, targetBotId = '') => {
    if (linuxDesktopReady) return;
    void ensureLinuxDesktop().then((mod) => {
      if (softwareOnly) void mod?.openModal?.(true, targetBotId);
      else void mod?.open?.(false, targetBotId);
    });
  };
  $('workBrowserBtn')?.addEventListener('click', () => {
    if (!isWorkShell()) return;
    workDock?.toggleBrowser?.();
  });
  $('linuxDesktopBtn')?.addEventListener('click', () => triggerLinuxDesktop(false, ''));
  $('sharedSoftwareBtn')?.addEventListener('click', () => triggerLinuxDesktop(true, ''));
  window.addEventListener('dimension-open-desktop', (event) => {
    if (linuxDesktopReady) return;
    triggerLinuxDesktop(false, event.detail?.botId || '');
  });
  window.addEventListener('dimension-open-app-desktop', (event) => {
    if (linuxDesktopReady) return;
    const appId = event.detail?.appId || '';
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(appId)) return;
    triggerLinuxDesktop(false, 'app:' + appId);
  });

  const bindLazyTrigger = (buttonId, loader) => {
    const btn = $(buttonId);
    if (!btn) return;
    let bound = false;
    const onFirstClick = (ev) => {
      if (bound) return;
      ev.stopImmediatePropagation();
      bound = true;
      btn.removeEventListener('click', onFirstClick);
      void loader().then(() => { btn.click(); }).catch((err) => {
        bound = false;
        btn.addEventListener('click', onFirstClick);
        messageActionNotice(err?.message || '功能模块加载失败');
      });
    };
    btn.addEventListener('click', onFirstClick);
  };

  bindLazyTrigger('sharedApplicationsBtn', async () => {
    const { bindApplicationBridge } = await import('./app-bridge-ui.js');
    bindApplicationBridge({ api, getBots: () => knownBots() });
  });
  bindSharedCapabilities({ api });
  bindLazyTrigger('sharedProactiveRemindersBtn', async () => {
    const { bindProactiveReminders } = await import('./proactive-reminders-ui.js');
    bindProactiveReminders({ api });
  });
  bindLazyTrigger('sharedTaskTemplatesBtn', async () => {
    const { bindTaskTemplates } = await import('./task-templates-ui.js');
    bindTaskTemplates({ api, getTargets: () => ({
      bots: knownBots(), groups: knownGroups(),
      activeBotId: state.botId, activeGroupId: state.activeGroupId,
    }) });
  });
  window.addEventListener('dimension-plugin-adaptation-created', () => { void sidebarActivity.refresh(); });
  window.addEventListener('dimension-open-plugin-adaptation', async event => {
    const { botId, runId } = event.detail || {};
    if (typeof botId !== 'string' || !botId || typeof runId !== 'string' || !runId.startsWith('run-')) return;
    try {
      const run = await api(`/api/dimension/work/runs/${encodeURIComponent(runId)}?view=1`);
      if (run.botId !== botId || run.groupId) throw new Error('任务不属于所选 Bot 的 Work 会话。');
      await ensureMemberBots([botId]);
      document.querySelector('dialog.capability-dialog[open]')?.close();
      state.pendingWorkFocus = { botId, runId };
      setShellMode('work', { restoreSelection: false });
      await activateBot(botId);
    } catch (error) { messageActionNotice(error.message || '无法打开适配任务，请稍后重试。'); }
  });
  {
    let available = false;
    const ensureBotArchive = createLazyModule(async () => {
      const { bindBotArchives } = await import('./bot-archive-ui.js');
      const real = bindBotArchives({ onImported: async () => { await loadBootstrap(); renderBotList(); } });
      real.setAvailable(available);
      return real;
    });
    botArchiveUi = {
      get available() { return available; },
      setAvailable(value) {
        available = value === true;
        document.querySelectorAll('[data-bot-archive-entry]').forEach(entry => { entry.hidden = !available; });
      },
      openExport: selectedBot => { void ensureBotArchive().then(real => real.openExport(selectedBot)); },
      openImport: options => { void ensureBotArchive().then(real => real.openImport(options)); },
    };
  }
  {
    const ensureArchivedWork = createLazyModule(async () => {
      const { bindArchivedWork } = await import('./archived-work-ui.js');
      return bindArchivedWork();
    });
    archivedWorkUi = {
      open: selectedBot => { void ensureArchivedWork().then(real => real.open(selectedBot)); },
    };
  }
  {
    let convAvailable = false;
    let convBotAvailable = false;
    let convReal = null;
    const convTrigger = $('conversationArchiveBtn');
    const ensureConvArchive = createLazyModule(async () => {
      const { bindConversationArchives } = await import('./conversation-archive-ui.js');
      convReal = bindConversationArchives({ onImportBot: () => botArchiveUi.openImport(), onRestored: async () => {
        const previous = new Set(knownBots().map(bot => bot.id));
        await loadBootstrap();
        for (const bot of knownBots()) if (!state.persistentBotRosters && !previous.has(bot.id)) {
          if (bot.chat) await addToRoster(bot.id, 'chat');
          if (bot.work) await addToRoster(bot.id, 'work');
        }
        renderBotList();
      } });
      convReal.setAvailable(convAvailable);
      convReal.setBotAvailable(convBotAvailable);
      return convReal;
    });
    if (convTrigger) {
      const onFirstConvClick = (ev) => {
        if (convReal) return;
        ev.stopImmediatePropagation();
        convTrigger.removeEventListener('click', onFirstConvClick);
        void ensureConvArchive().then(() => convTrigger.click()).catch(() => {
          convTrigger.addEventListener('click', onFirstConvClick);
        });
      };
      convTrigger.addEventListener('click', onFirstConvClick);
    }
    archiveUi = {
      setAvailable(value) {
        convAvailable = value === true;
        if (convTrigger) convTrigger.hidden = !convAvailable;
        convReal?.setAvailable(convAvailable);
      },
      setBotAvailable(value) {
        convBotAvailable = value === true;
        convReal?.setBotAvailable(convBotAvailable);
      },
    };
  }
  bindLazyTrigger('workGitHubBtn', async () => {
    const { bindWorkGitHub } = await import('./work-github-ui.js');
    bindWorkGitHub({ api, getContext: () => {
      const group = currentGroup();
      return { botId: group?.ownerId || state.botId, runId: workSession.currentRunId() || '' };
    } });
  });
  bindLazyTrigger('sharedWorkModelsBtn', async () => {
    const { bindWorkModels } = await import('./work-model-ui.js');
    bindWorkModels({ api });
  });
  bindLazyTrigger('contextLimitsBtn', async () => {
    const { bindContextDialog } = await import('./context-limits-ui.js');
    bindContextDialog({ api, onHistory: () => openContext().catch(error => showModal(`<div class="modal-head"><h2>历史暂时无法读取</h2><button type="button" data-close>关闭</button></div><p>${escapeHtml(error.message)}</p>`)) });
  });
  contextUsageUi = bindContextUsage({ api,
    getScope: () => !hasConversation() ? null : {
      mode: isWorkShell() ? 'work' : 'chat',
      botId: state.activeGroupId ? '' : state.botId,
      groupId: state.activeGroupId || '',
      botName: state.activeGroupId ? '' : state.botName,
    },
    onSettings: () => window.__dimensionOpenClientSettings?.('context'),
  });
  $('chatStickerBtn').onclick=()=>openStickerPicker(row=>{
    attachmentDraft().stickers.push(row);syncStickerDraft();syncSendEnabled(input,$('sendBtn'),false);input.focus();
  });
  workUi = bindWorkShellUi({
    isWork: () => isWorkShell() && hasConversation(),
    getSettings: () => state.workSettings,
    getLeadSelection: () => currentSelection(),
    onSelectLeadModel: async (selection) => {
      await switchModel(selection);
      workUi?.sync();
    },
    getProviderGroups: () => {
      const out = [];
      const seen = new Set();
      for (const item of (state.providers || [])) {
        const pid = item.name || item.id;
        if (!pid || seen.has(pid)) continue;
        seen.add(pid);
        const models = providerModels(item);
        if (!models.length && item.model) models.push(item.model);
        if (models.length) {
          out.push({
            providerId: pid,
            title: item.displayName || pid,
            models,
          });
        }
      }
      if (!out.length && state.activeProvider && !String(state.activeProvider).startsWith('cli:') && state.model) {
        out.push({ providerId: state.activeProvider, title: state.activeProvider, models: [state.model] });
      }
      return out;
    },
    pickCwd: pickWorkCwd,
    getRecentCwds: readRecentWorkCwds,
    onSelectCwdDirect: nextPath => applyWorkCwdPath(nextPath),
    onWorkspaceModeChange: async (nextMode) => {
      try {
        const grp = currentGroup();
        const botId = (isWorkShell() && grp) ? (grp.ownerId || grp.members?.[0] || state.botId) : state.botId;
        if (!botId) return;
        const data = await api('/api/dimension/work/settings', {
          method: 'PATCH',
          body: JSON.stringify({ botId, workspaceMode: nextMode }),
        });
        if (data?.settings) state.workSettings = data.settings;
        workUi?.sync();
        messageActionNotice(data?.settings?.workspaceModeReason || '工位模式已更新');
      } catch (err) {
        workUi?.sync();
        messageActionNotice(`切换工位模式失败：${err.message}`);
      }
    },
    onCliHarnessChange: async ({ cliEngine, cliModelSource, cliEngineConfig, workLead, roleProgress }) => {
      try {
        const grp = currentGroup();
        const botId = (isWorkShell() && grp) ? (grp.ownerId || grp.members?.[0] || state.botId) : state.botId;
        if (!botId) return;
        const patchBody = { botId };
        if (typeof roleProgress === 'boolean') patchBody.roleProgress = roleProgress;
        if (cliEngine) patchBody.cliEngine = cliEngine;
        if (cliModelSource) patchBody.cliModelSource = cliModelSource;
        if (cliEngineConfig) patchBody.cliEngineConfig = cliEngineConfig;
        if (workLead && typeof workLead === 'object') patchBody.workLead = workLead;
        const data = await api('/api/dimension/work/settings', {
          method: 'PATCH',
          body: JSON.stringify(patchBody),
        });
        if (data?.settings) state.workSettings = data.settings;
        workUi?.sync();
      } catch (err) {
        workUi?.sync();
        messageActionNotice(`切换工匠配置失败：${err.message}`);
      }
    },
    onRefreshCliAndModels: async (optsArg = {}) => {
      const silent = Boolean(optsArg && optsArg.silent);
      try {
        await loadProviders();
        await refreshCatalogs();
        const grp = currentGroup();
        const botId = (isWorkShell() && grp) ? (grp.ownerId || grp.members?.[0] || state.botId) : state.botId;
        if (botId) {
          const data = await api(`/api/dimension/work/settings?botId=${encodeURIComponent(botId)}&refresh=1`);
          if (data?.settings) state.workSettings = data.settings;
        }
        workUi?.sync();
        if (!silent) messageActionNotice('已刷新本机工匠探测与模型目录');
      } catch (err) {
        if (!silent) messageActionNotice(`刷新失败：${err.message}`);
      }
    },
    onAddCustomModel: () => {
      void openKeys();
    },
    onEditModels: () => {
      const btn = document.getElementById('sharedWorkModelsBtn');
      if (btn) btn.click();
      else void openKeySettings();
    },
    onOpenCliSandboxSettings: () => {
      window.__dimensionOpenClientSettings?.('cli-sandbox');
    },
    onOpenCliReceptionModal: () => {
      openBotCliReceptionSettings();
    },
    onFiles: handleWorkFiles,
    onDecide: decideWorkPending,
  });
  workUi.sync();
  if (isWorkShell()) refreshWorkPending();
}

async function waitGlobalSearchPage(control) {
  const started = performance.now(); control.click();
  while (control.isConnected && control.disabled && performance.now() - started < 10000) await new Promise(resolve => setTimeout(resolve, 50));
  await new Promise(resolve => setTimeout(resolve, 60));
}
function flashGlobalSearchTarget(node) {
  if (!node) return;
  document.querySelectorAll('.search-target-flash,.search-target-flash-in').forEach(item => item.classList.remove('search-target-flash', 'search-target-flash-in'));
  node.classList.add('search-target-flash', 'search-target-flash-in'); node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => node.classList.remove('search-target-flash', 'search-target-flash-in'), 2600);
}
async function revealGlobalSearchMessage(messageId, active = () => true, flash = true) {
  const wanted = String(messageId || ''), transcript = $('transcript');
  for (let page = 0; page < 40 && transcript && active(); ++page) {
    const target = [...transcript.querySelectorAll('[data-message-id]')].find(node => node.dataset.messageId === wanted);
    if (target) { if (flash) flashGlobalSearchTarget(target); return true; }
    const more = transcript.querySelector('.chat-history-more:not([hidden])'); if (!more) return false;
    await waitGlobalSearchPage(more);
    if (more.isConnected && /失败/.test(more.textContent)) return false;
  }
  return false;
}
async function revealGlobalSearchMemory(recordId) {
  const wanted = String(recordId || '');
  for (let page = 0; page < 40; ++page) {
    const target = [...document.querySelectorAll('.memory-card[data-id]')].find(node => node.dataset.id === wanted);
    if (target) { flashGlobalSearchTarget(target); return true; }
    const more = document.getElementById('loadMoreMemory'); if (!more || more.hidden) return false;
    await waitGlobalSearchPage(more);
  }
  return false;
}
async function openGlobalSearchHit(hit) {
  const kind = String(hit?.kind || '');
  if (kind === 'bot') { setShellMode('chat', { restoreSelection: false }); await activateBot(hit.id); return; }
  if (kind === 'group') { setShellMode('chat', { restoreSelection: false }); await openGroup(hit.id); return; }
  if (kind === 'work' || kind === 'artifact') {
    setShellMode('work', { restoreSelection: false });
    if (hit.groupId) {
      if (state.activeGroupId !== hit.groupId) await openGroup(hit.groupId);
    } else {
      state.pendingWorkFocus = { botId: hit.botId, runId: hit.runId };
      if (state.botId !== hit.botId || state.activeGroupId || !state.soloWork || state.selections.work?.id !== hit.botId) await activateBot(hit.botId);
    }
    const focused = await workSession.reveal(hit.runId);
    flashGlobalSearchTarget(document.querySelector(`[data-run-id="${CSS.escape(focused.rootRunId)}"]`));
    return;
  }
  setShellMode('chat', { restoreSelection: false });
  if (kind === 'message' && hit.groupId) {
    if (state.activeGroupId !== hit.groupId) await openGroup(hit.groupId);
    if (!await revealGlobalSearchMessage(hit.recordId)) messageActionNotice('会话已打开，但原消息未找到，可能已删除或超出可加载范围。');
    return;
  }
  if (state.botId !== hit.botId || state.activeGroupId || state.selections.chat?.kind !== 'bot' || state.selections.chat?.id !== hit.botId) await activateBot(hit.botId);
  if (kind === 'message') {
    await showBotHistory(hit.botId);
    if (!await revealGlobalSearchMessage(hit.recordId)) messageActionNotice('会话已打开，但原消息未找到，可能已删除或超出可加载范围。');
  } else if (kind === 'memory' || kind === 'mid_memory') {
    await openMemory();
    if (!await revealGlobalSearchMemory(hit.recordId)) messageActionNotice('记忆面板已打开，但目标条目未找到，可能已修改或删除。');
  }
}
window.addEventListener('dimension-global-search-open', event => {
  openGlobalSearchHit(event.detail || {}).catch(error => messageActionNotice(error.message || '无法打开搜索结果。'));
});

function pinAppHeight() {
  const viewport = window.visualViewport;
  const height = Math.max(1, Math.round(viewport?.height ?? window.innerHeight));
  document.documentElement.style.setProperty('--app-height', `${height}px`);
  syncChatColumn();
}

/** 旧「删除」只是本地标记：把这些 id 从两个名单清掉、标记作废。磁盘上还在的一律回调出池。 */
function migrateDeletedMarks() {
  updateSidebarPrefs((prefs) => {
    const marked = Object.keys(prefs.deleted || {});
    if (!marked.length) return prefs;
    const dead = new Set(marked);
    prefs.workBots = (prefs.workBots || []).filter((id) => !dead.has(id));
    prefs.chatBots = (prefs.chatBots || []).filter((id) => !dead.has(id));
    prefs.deleted = {};
    return prefs;
  });
}

const bootEnteredAt = performance.now();
let bootCurtainDismissed = false;

// 共享元素退场：幕布字标平滑飞到欢迎页字标的位置（只在显示欢迎页时），返回是否接管了退场
function flyBootWordmark(curtain) {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'off') return false;
  const from = curtain.querySelector('.boot-wordmark-img');
  const to = document.querySelector('#transcript .conversation-welcome img');
  if (!from || !to) return false;
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  if (!a.width || !b.width || b.bottom < 0 || b.top > window.innerHeight) return false;
  const dx = (b.left + b.width / 2) - (a.left + a.width / 2);
  const dy = (b.top + b.height / 2) - (a.top + a.height / 2);
  const scale = b.width / a.width;
  to.style.opacity = '0';
  curtain.classList.add('is-flying');
  requestAnimationFrame(() => {
    from.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${scale.toFixed(4)})`;
  });
  setTimeout(() => {
    to.style.transition = 'opacity 0.16s ease';
    to.style.opacity = '';
    setTimeout(() => { to.style.transition = ''; }, 200);
    curtain.remove();
    document.getElementById('bootSplashInlineStyle')?.remove();
  }, 600);
  return true;
}

function dismissBootCurtain(immediate = false) {
  if (bootCurtainDismissed) return;
  bootCurtainDismissed = true;
  const curtain = document.getElementById('bootSplashCurtain');
  if (!curtain) return;
  const statusEl = document.getElementById('bootStatusText');
  const finishLeave = () => {
    if (statusEl && !immediate) statusEl.textContent = '✦ 星轨就绪，欢迎归来';
    curtain.classList.add('is-ready');
    const leaveDelay = immediate ? 0 : 170;
    setTimeout(() => {
      if (flyBootWordmark(curtain)) return;
      curtain.classList.add('is-leaving');
      setTimeout(() => {
        curtain.remove();
        document.getElementById('bootSplashInlineStyle')?.remove();
      }, 520);
    }, leaveDelay);
  };
  if (immediate) {
    finishLeave();
    return;
  }
  const elapsed = performance.now() - bootEnteredAt;
  const minShowMs = 580;
  const waitMs = Math.max(0, minShowMs - elapsed);
  if (waitMs > 0) setTimeout(finishLeave, waitMs);
  else finishLeave();
}

// 绝对安全兜底：即使初始化接口慢响应也不阻塞交互（启动已失败时保留错误态，不强行撤幕）
setTimeout(() => {
  if (document.getElementById('bootSplashCurtain')?.classList.contains('is-error')) return;
  dismissBootCurtain(true);
}, 2800);

async function start() {
  window.__dimensionAppStarted = true;
  migrateDeletedMarks();
  pinAppHeight();
  window.addEventListener('resize', pinAppHeight);
  window.visualViewport?.addEventListener('resize', pinAppHeight);
  window.visualViewport?.addEventListener('scroll', pinAppHeight);
  bindUi();
  startDimensionBots();
  initAnimeFx();
  startMotionFx();
  initGalgameStage({
    loadReadingPosition: (id, current) => revealGlobalSearchMessage(id, current, false),
    renderRich: renderRichMessage,
    hydrateImages: hydrateChatImages,
    onStoryAdvance: ({ opening = false, directive = '', diceRoll = null } = {}) => {
      const group = activeGroup();
      if (!group) return Promise.reject(new Error('未找到当前物语剧场群聊'));
      return triggerStoryAdvance(group, { opening, directive, diceRoll, rethrow: true });
    },
    onStoryV3Action: (act) => void handleStoryV3Action(act),
    onRegenerate: () => regeneratePrivateChat(),
    getModelInfo: () => ({
      current: currentSelection(),
      choices: modelChoices(),
    }),
    onSelectModel: (selection) => switchModel(selection),
    onOpenCliReceptionModal: () => openBotCliReceptionSettings(),
    onUploadImages: (files) => window.__dimensionHandleComposerImages?.(files),
    getDraftMedia: () => ({
      images: [...attachmentDraft().images],
      stickers: [...attachmentDraft().stickers],
    }),
    removeDraftImage: (idx) => {
      if (!Array.isArray(attachmentDraft().images)) return;
      attachmentDraft().images.splice(idx, 1);
      syncChatImageDraftFn();
      syncSendEnabled($('composerInput'), $('sendBtn'));
    },
    removeDraftSticker: (idx) => {
      if (!Array.isArray(attachmentDraft().stickers)) return;
      attachmentDraft().stickers.splice(idx, 1);
      syncStickerDraft();
      syncSendEnabled($('composerInput'), $('sendBtn'));
    },
    onPickSticker: (onPicked) => openStickerPicker((row) => {
      attachmentDraft().stickers.push(row);
      syncStickerDraft();
      syncSendEnabled($('composerInput'), $('sendBtn'), false);
      onPicked?.(row);
    }),
  });
  initTranscriptFollow($('transcript'), $('transcriptJumpBtn'));
  $('composer')?.addEventListener('submit', () => {
    const hasContent = Boolean(String($('composerInput')?.value || '').trim()) || document.querySelector('#chatImageDraft:not([hidden]), #chatStickerDraft:not([hidden])');
    if (hasContent) pinTranscriptToBottom($('transcript'));
  }, true);
  let bootError = null;
  try { await loadBootstrap(); }
  catch (err) { bootError = err; window.__bootErr = String(err?.stack || err); setModelStatus(err.message); }
  if (!bootError) {
    if (isPlaygroundShell()) {
      $('app')?.classList.add('is-playground-shell');
      playgroundUi?.activate();
    } else if (hasConversation() && !isWorkShell()) await showBotHistory(state.botId);
    else showConversationWelcome();
    dismissBootCurtain();
  } else {
    showConversationWelcome();
    // 幕布还在：切到错误态（重新连接 / 仍然进入）；已被兜底撤下：给一条提示。
    const shown = !bootCurtainDismissed && window.__bootFail?.('无法连接到本地服务', bootError?.message || bootError);
    if (shown) bootCurtainDismissed = true;
    else showPaperHint(`✦ 星轨连接中断：${bootError?.message || '无法连接到本地服务'}，请稍后重试`);
  }
  sidebarActivity.start();
  window.addEventListener('pagehide', () => {
    conversationDrafts.capture($('composerInput')?.value || '');
    conversationDrafts.flushAll();
    sidebarActivity.stop();
  });
  window.addEventListener('pageshow', () => sidebarActivity.start());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) sidebarActivity.stop();
    else sidebarActivity.start();
  });
  connectChat();
  // Work 外壳刷新后回到这个 bot 的 work 视图。
  if (isWorkShell() && !state.activeGroupId) openSoloWork().catch(() => {});
  workUi?.sync();
  if (isWorkShell()) refreshWorkPending();
}

start();

$('workStopBtn')?.addEventListener('click', stopActiveWork);
