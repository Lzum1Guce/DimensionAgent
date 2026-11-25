/**
 * 算力牌局 · Token Rumble v2.0 — UI 渲染、事件交互、多模式排布与接待模型参战调度
 * 严格遵循无内联事件（CSP 合规）、零 Emoji 与 100% 视口锁定零滚动条布局
 */

import {
  abortPendingModelDecision,
  applyHostModelStatus,
  getReceptionModelStatus,
  isModelCoplayEnabled,
  probeReceptionModel,
  requestReceptionDecision,
  setModelCoplayEnabled,
} from './aiModel.js';
import { emitCoPlayEvent, parseUrlContext, subscribeHostBridge } from './bridge.js';
import { renderCodexModal, renderStatsModal, renderWallpaperModal } from './codexModal.js';
import {
  CARD_DEFS,
  CARD_LIST,
  CHARACTERS,
  CHARACTER_MAP,
  GAME_MODES,
  GAME_MODE_MAP,
  ROLES,
  SUIT_SYMBOL,
  SYSTEM_PROMPTS,
} from './data.js';
import {
  canUseActiveSkill,
  confirmHumanDiscard,
  createMatchState,
  endCurrentTurn,
  executeAiAction,
  getAiCandidateActions,
  getMaxHandSize,
  getSkillCost,
  getSkillLimit,
  getStrikeLimit,
  playCard,
  startCurrentTurn,
  triggerActiveSkill,
  addLog,
} from './engine.js';
import {
  cyclePacing,
  dispatchGameFx,
  getPacingProfile,
  isSoundEnabled,
  playSound,
  randomBetween,
  setSoundEnabled,
} from './fx.js';
import { formatWinRate, loadStats, recordMatchResult, resetStats } from './stats.js';

const root = document.getElementById('app');
const ctx = parseUrlContext();

const BG_MODE_KEY = 'token_rumble_bg_mode_v1';

function loadBgMode() {
  try {
    const raw = window.localStorage.getItem(BG_MODE_KEY);
    if (raw === 'soft' || raw === 'vivid' || raw === 'minimal') return raw;
  } catch {
    // 忽略沙盒无存储权限场景
  }
  return 'soft';
}

function saveBgMode(mode) {
  const next = mode === 'vivid' || mode === 'minimal' ? mode : 'soft';
  try {
    window.localStorage.setItem(BG_MODE_KEY, next);
  } catch {
    // 忽略沙盒无存储权限场景
  }
  return next;
}

let companions = ctx.companions;
let selectedMode = 'classic4';
let selectedCharId = 'ai-gpt';
let selectedPartnerId = 'ai-claude';
let state = null;
let logOpen = !ctx.embed && window.innerWidth >= 1180;
let helpOpen = false;
let modalView = null; // null | 'codex' | 'stats' | 'wallpaper'
let bgMode = loadBgMode(); // 'soft' | 'vivid' | 'minimal'
let codexTab = 'cards'; // 'cards' | 'chars' | 'events'
let codexFilter = 'all';
let aiTimer = null;
let dealTimer = null;
let dealingRevealCount = null; // null 表示发牌已完成；数字表示当前已发到玩家手里的张数
let aiThinkingSeat = null;
let aiThinkingMode = null; // 'model' | 'look' | 'play' | 'end'
let turnSerial = 0;
let matchRecorded = false;
const bubbleTimers = new Map();

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isRed(suit) {
  return suit === 'heart' || suit === 'diamond';
}

function ensureDistinctPartner() {
  if (selectedPartnerId === selectedCharId) {
    const alt = CHARACTERS.find((c) => c.id !== selectedCharId);
    if (alt) selectedPartnerId = alt.id;
  }
}

function clearAiTimer() {
  if (aiTimer) {
    window.clearTimeout(aiTimer);
    aiTimer = null;
  }
  if (dealTimer) {
    window.clearTimeout(dealTimer);
    dealTimer = null;
  }
  dealingRevealCount = null;
  abortPendingModelDecision();
  aiThinkingSeat = null;
  aiThinkingMode = null;
}

function clearBubbleTimers() {
  for (const t of bubbleTimers.values()) {
    window.clearTimeout(t);
  }
  bubbleTimers.clear();
}

function showSeatBubble(seat, text) {
  if (!state || !text) return;
  const p = state.players[seat];
  if (!p) return;
  p.modelBubble = String(text).slice(0, 44);
  if (bubbleTimers.has(seat)) {
    window.clearTimeout(bubbleTimers.get(seat));
  }
  const duration = getPacingProfile().bubbleDurationMs || 5200;
  bubbleTimers.set(
    seat,
    window.setTimeout(() => {
      if (state?.players[seat]) {
        state.players[seat].modelBubble = '';
        render();
      }
      bubbleTimers.delete(seat);
    }, duration),
  );
}

function recordMatchIfOver() {
  if (!state || state.scene !== 'gameover' || !state.winner || matchRecorded) return;
  matchRecorded = true;
  const human = state.players[0];
  const ch = CHARACTER_MAP[human.charId];
  const role = ROLES[human.roleId];
  recordMatchResult({
    mode: state.mode,
    modeName: state.modeName,
    charId: human.charId,
    charName: ch?.name || human.name,
    roleId: human.roleId,
    roleName: role?.name || '',
    won: Boolean(state.winner.humanWon),
    rounds: state.round,
    kills: state.humanKills || 0,
    modelAssisted: state.modelDecisions > 0,
  });
}

function waitMs(ms) {
  return new Promise((resolve) => {
    aiTimer = window.setTimeout(() => {
      aiTimer = null;
      resolve();
    }, Math.max(0, ms));
  });
}

function scheduleAiIfNeeded(extraPauseMs = 0) {
  if (aiTimer) {
    window.clearTimeout(aiTimer);
    aiTimer = null;
  }
  abortPendingModelDecision();
  aiThinkingSeat = null;
  aiThinkingMode = null;

  if (dealingRevealCount !== null) return;
  if (!state || state.scene !== 'playing' || state.prompt) {
    recordMatchIfOver();
    return;
  }
  const active = state.players[state.activeSeat];
  if (!active || active.isHuman || !active.alive || state.phase !== 'play') return;

  const serial = ++turnSerial;
  const pacing = getPacingProfile();
  const isTurnFirstStep = (active.turnFlags?.aiStepsTaken || 0) === 0;
  const preWaitMs = (isTurnFirstStep ? randomBetween(pacing.turnStartPause) : pacing.postActionMs) + extraPauseMs;

  aiThinkingSeat = active.seat;
  aiThinkingMode = isTurnFirstStep ? 'look' : 'play';
  render();

  (async () => {
    // 1) 回合初看新摸的牌 / 上一张飞牌收尾缓冲
    await waitMs(preWaitMs);
    if (serial !== turnSerial || !state || state.scene !== 'playing' || state.prompt) return;

    const currentActor = state.players[state.activeSeat];
    if (!currentActor || currentActor.isHuman || !currentActor.alive || state.phase !== 'play') {
      aiThinkingSeat = null;
      aiThinkingMode = null;
      return;
    }

    const candidates = getAiCandidateActions(state, currentActor);
    let chosenAction = candidates[0] || { kind: 'end' };

    // 根据动作类型决定拟真真人思考时长（出牌 / 放大招 / 思索后结束回合）
    const isBigPlay =
      chosenAction.kind === 'skill' ||
      (chosenAction.kind === 'card' &&
        ['ddos', 'overload', 'synergy', 'redirect', 'loop'].includes(
          currentActor.hand.find((c) => c.uid === chosenAction.cardUid)?.key,
        ));
    const targetThinkMs =
      chosenAction.kind === 'end'
        ? randomBetween(pacing.thinkEnd)
        : isBigPlay
          ? randomBetween(pacing.thinkSkill)
          : randomBetween(pacing.thinkPlay);

    const modelStatus = getReceptionModelStatus();
    const canAskModel =
      isModelCoplayEnabled() &&
      modelStatus.ready &&
      candidates.length > 1 &&
      (currentActor.turnFlags.modelCallsThisTurn || 0) < 2;

    const thinkStartedAt = Date.now();

    if (canAskModel) {
      aiThinkingSeat = currentActor.seat;
      aiThinkingMode = 'model';
      render();
      const decision = await requestReceptionDecision(state, currentActor, candidates, 4500);
      if (serial !== turnSerial || !state || state.scene !== 'playing' || state.prompt) {
        aiThinkingSeat = null;
        aiThinkingMode = null;
        return;
      }
      if (decision.usedModel) {
        currentActor.turnFlags.modelCallsThisTurn = (currentActor.turnFlags.modelCallsThisTurn || 0) + 1;
        state.modelDecisions += 1;
        chosenAction = candidates[decision.actionIndex] || chosenAction;
        if (decision.reply) {
          showSeatBubble(currentActor.seat, decision.reply);
          addLog(state, `${currentActor.shortName} · 接待模型`, decision.reply, 'model');
          emitCoPlayEvent(decision.mood || 'serious', decision.reply, {
            botId: currentActor.charId,
            seat: currentActor.seat,
            force: true,
          });
          render();
        }
      }
    } else {
      aiThinkingSeat = currentActor.seat;
      aiThinkingMode = chosenAction.kind === 'end' ? 'end' : 'play';
      render();
    }

    // 扣除模型网络耗时后，补足剩余的拟真思考时间，让本地 AI 与接待模型节奏同样沉稳舒适
    const elapsed = Date.now() - thinkStartedAt;
    const minPauseAfterModel = canAskModel ? 420 : 0;
    const remainingMs = Math.max(minPauseAfterModel, targetThinkMs - elapsed);
    if (remainingMs > 0) {
      await waitMs(remainingMs);
    }

    if (serial !== turnSerial || !state || state.scene !== 'playing' || state.prompt) return;
    const stillActor = state.players[state.activeSeat];
    if (!stillActor || stillActor.seat !== currentActor.seat || !stillActor.alive || state.phase !== 'play') return;

    aiThinkingSeat = null;
    aiThinkingMode = null;
    stillActor.turnFlags.aiStepsTaken = (stillActor.turnFlags.aiStepsTaken || 0) + 1;

    const actionWasEnd = chosenAction.kind === 'end';
    const nextExtraPause = actionWasEnd ? 0 : Math.round(getPacingProfile().flyDurationMs * 0.45);

    executeAiAction(state, stillActor, chosenAction, () => {
      recordMatchIfOver();
      render();
      scheduleAiIfNeeded(nextExtraPause);
    });
    recordMatchIfOver();
    render();
    if (!state.prompt && state.scene === 'playing' && state.players[state.activeSeat] && !state.players[state.activeSeat].isHuman) {
      scheduleAiIfNeeded(nextExtraPause);
    }
  })();
}

function startNewMatch(charId = selectedCharId) {
  turnSerial += 1;
  clearAiTimer();
  clearBubbleTimers();
  selectedCharId = charId;
  ensureDistinctPartner();
  helpOpen = false;
  modalView = null;
  matchRecorded = false;
  if (window.innerWidth < 1180) {
    logOpen = false;
  }

  state = createMatchState(charId, companions, {
    mode: selectedMode,
    partnerCharId: selectedPartnerId,
    onFx: (type, payload) => dispatchGameFx(type, payload),
    getStepDelayMs: (kind) => (kind === 'ddos' ? getPacingProfile().ddosStepMs : 0),
    onVisualTick: () => render(),
  });

  // 模拟真人荷官逐张发牌节奏
  const targetHandCount = state.players[0].hand.length;
  const dealStep = getPacingProfile().dealStepMs;
  const serial = ++turnSerial;
  dealingRevealCount = 0;
  render();

  const dealNextCard = () => {
    if (serial !== turnSerial || !state) return;
    dealingRevealCount += 1;
    playSound('draw');
    if (dealingRevealCount < targetHandCount) {
      render();
      dealTimer = window.setTimeout(dealNextCard, dealStep);
      return;
    }
    render();
    dealTimer = window.setTimeout(() => {
      if (serial !== turnSerial || !state) return;
      dealTimer = null;
      dealingRevealCount = null;
      startCurrentTurn(state, () => {
        recordMatchIfOver();
        render();
        scheduleAiIfNeeded();
      });
      render();
      scheduleAiIfNeeded();
    }, Math.round(dealStep * 1.4));
  };

  dealTimer = window.setTimeout(dealNextCard, Math.round(dealStep * 0.7));
}

function returnToSelect() {
  turnSerial += 1;
  clearAiTimer();
  clearBubbleTimers();
  helpOpen = false;
  modalView = null;
  state = null;
  render();
}

/* ── 纯白留白极简二次元实体卡牌渲染 ── */
function renderCardMarkup(card, { selected = false, disabled = false, action = 'select-card', extraClass = '' } = {}) {
  const def = CARD_DEFS[card.key];
  const red = isRed(card.suit);
  const len = def.name.length;
  const sizeClass = len >= 5 ? 'is-penta' : len === 4 ? 'is-quad' : len === 3 ? 'is-tri' : 'is-short';
  const isResonance = Boolean(
    def.kind === 'signature' && def.ownerCharId && state?.players?.[0]?.charId === def.ownerCharId,
  );
  const badgeText = isResonance ? '本命' : def.kindLabel;
  const titleAttr = `${SUIT_SYMBOL[card.suit]}${card.rank} ${def.name}（${def.kindLabel}）· ${def.actor}\n${def.desc}${def.resonanceDesc ? `\n${def.resonanceDesc}` : ''}`;
  return `
    <button
      type="button"
      class="tr-card is-${def.kind}${red ? ' is-red' : ' is-black'}${isResonance ? ' is-resonance' : ''}${selected ? ' is-selected' : ''} ${extraClass}"
      ${def.ownerCharId ? `data-char="${esc(def.ownerCharId)}"` : ''}
      data-action="${esc(action)}"
      data-uid="${esc(card.uid)}"
      ${disabled ? 'disabled' : ''}
      title="${esc(titleAttr)}"
      aria-pressed="${selected ? 'true' : 'false'}"
    >
      <img class="tr-card-art" src="${esc(def.image)}" alt="${esc(def.name)}" draggable="false" />
      <span class="tr-card-corner" aria-hidden="true">
        <b class="tr-card-rank">${esc(card.rank)}</b>
        <i class="tr-card-suit">${esc(SUIT_SYMBOL[card.suit])}</i>
      </span>
      <span class="tr-card-kind" aria-hidden="true">${esc(badgeText)}</span>
      <div class="tr-card-footer">
        <span class="tr-card-name ${sizeClass}">${esc(def.name)}</span>
        <span class="tr-card-cast">${esc(def.actor)}</span>
      </div>
      <span class="tr-card-accent" aria-hidden="true"></span>
    </button>
  `;
}

function renderReceptionToggleBtn(compact = false) {
  const m = getReceptionModelStatus();
  const enabled = isModelCoplayEnabled();
  const shortModel = (m.model || '').split('/').pop().slice(0, 14);
  let label;
  if (compact) {
    label = enabled ? (m.ready ? '接待模型: 开' : '接待模型: 待机') : '接待模型: 关';
  } else {
    label = enabled
      ? m.ready
        ? `接待模型参战: 开${shortModel ? ` · ${shortModel}` : ''}`
        : '接待模型参战: 待接入'
      : '接待模型参战: 关';
  }
  const title = m.ready
    ? `当前接待模型：${m.model}（开启后 AI 娘每回合将由真实接待模型决策出牌并发表实时吐槽）`
    : '尚未检测到已配置的接待模型接口，开启后将自动探测，未接入时无缝使用内置策略 AI';
  return `
    <button
      type="button"
      class="tr-tb-btn tr-model-toggle${enabled && m.ready ? ' is-live' : enabled ? ' is-active' : ''}"
      data-action="toggle-model-coplay"
      title="${esc(title)}"
    >
      <span class="tr-status-dot${enabled && m.ready ? ' is-ready' : ''}"></span>
      <span>${esc(label)}</span>
    </button>
  `;
}

function renderPacingToggleBtn(compact = false) {
  const p = getPacingProfile();
  return `
    <button
      type="button"
      class="tr-tb-btn"
      data-action="cycle-pacing"
      title="点击切换牌局出牌节奏：真人节奏（拟真看牌与发牌速度） / 慢享节奏 / 疾速节奏"
    >${compact ? `节奏:${esc(p.label)}` : `节奏: ${esc(p.fullLabel)}`}</button>
  `;
}

/* ── 1. 自由选将与模式配置大厅（支持 4P / 2v2 搭档 / 6P 大局 + 图鉴 + 战绩 + 接待模型开关） ── */
function renderSelectScreen() {
  ensureDistinctPartner();
  const chosen = CHARACTER_MAP[selectedCharId] || CHARACTERS[0];
  const partner = CHARACTER_MAP[selectedPartnerId] || CHARACTERS[1];
  const modeInfo = GAME_MODE_MAP[selectedMode] || GAME_MODES[0];
  const stats = loadStats();
  const soundOn = isSoundEnabled();

  root.innerHTML = `
    <div class="tr-select-screen" data-bg-mode="${esc(bgMode)}">
      <header class="tr-select-head">
        <div class="tr-select-brand-col">
          <div class="tr-kicker">ORIGINAL AI-GIRL STRATEGY CARD GAME · TOKEN RUMBLE V2.0</div>
          <div class="tr-title-row">
            <h1 class="tr-select-title">算力牌局</h1>
            <span class="tr-pill">${CARD_LIST.length} 功能牌 · ${SYSTEM_PROMPTS.length} 全局事件</span>
            ${stats.totalGames > 0 ? `<span class="tr-pill is-subtle tr-num">战绩 ${stats.wins}/${stats.totalGames} (${formatWinRate(stats.wins, stats.totalGames)})</span>` : ''}
          </div>
        </div>

        <div class="tr-select-tools">
          ${renderReceptionToggleBtn(false)}
          ${renderPacingToggleBtn(false)}
          <button type="button" class="tr-tb-btn${bgMode !== 'minimal' ? ' is-active' : ''}" data-action="open-wallpaper" title="预览 8 位 AI 娘全员合照并切换桌面背景氛围">桌面</button>
          <button type="button" class="tr-tb-btn" data-action="open-codex">图鉴</button>
          <button type="button" class="tr-tb-btn" data-action="open-stats">战绩</button>
          <button type="button" class="tr-tb-btn${soundOn ? ' is-active' : ''}" data-action="toggle-sound">音效 ${soundOn ? '开' : '关'}</button>
        </div>
      </header>

      <div class="tr-mode-strip" role="radiogroup" aria-label="选择玩法模式">
        ${GAME_MODES.map((m) => {
          const active = m.id === selectedMode;
          return `
            <button
              type="button"
              class="tr-mode-pill${active ? ' is-active' : ''}"
              data-action="pick-mode"
              data-mode="${esc(m.id)}"
              role="radio"
              aria-checked="${active ? 'true' : 'false'}"
            >
              <div class="tr-mode-pill-top">
                <strong>${esc(m.name)}</strong>
                <span class="tr-mode-badge">${esc(m.badge)}</span>
              </div>
              <small>${esc(m.summary)}</small>
            </button>
          `;
        }).join('')}
      </div>

      <div class="tr-char-grid" role="radiogroup" aria-label="选择你的 AI 娘角色">
        ${CHARACTERS.map((ch) => {
          const isMe = ch.id === chosen.id;
          const isPartner = selectedMode === 'duo2v2' && ch.id === partner.id;
          return `
            <div
              class="tr-char-tile is-fullart${isMe ? ' is-selected' : ''}${isPartner ? ' is-partner' : ''}"
              data-char="${esc(ch.id)}"
              data-action="pick-char"
              data-char-id="${esc(ch.id)}"
              role="button"
              tabindex="0"
              aria-pressed="${isMe ? 'true' : 'false'}"
            >
              <img class="tr-char-portrait" src="${esc(ch.portrait)}" alt="${esc(ch.name)}" draggable="false" />
              <div class="tr-char-scrim" aria-hidden="true"></div>
              <span class="tr-char-cost-tag tr-num">${ch.activeCost} TK</span>
              ${
                isMe
                  ? '<span class="tr-char-role-flag is-me">我方出战</span>'
                  : isPartner
                    ? '<span class="tr-char-role-flag is-partner">蓝队搭档</span>'
                    : selectedMode === 'duo2v2'
                      ? `<button type="button" class="tr-partner-pick-btn" data-action="pick-partner" data-char-id="${esc(ch.id)}">设为搭档</button>`
                      : ''
              }
              <div class="tr-char-tile-meta">
                <strong>${esc(ch.name)}</strong>
                <small>${esc(ch.title)} · ${esc(ch.activeName)}</small>
              </div>
            </div>
          `;
        }).join('')}
      </div>

      <footer class="tr-select-footer">
        <div class="tr-chosen-detail">
          <div class="tr-chosen-head">
            <strong>${esc(chosen.name)}</strong>
            <span class="tr-pill">${esc(modeInfo.name)}</span>
            ${selectedMode === 'duo2v2' ? `<span class="tr-pill is-blue-pill">蓝队搭档 · ${esc(partner.name)}</span>` : `<span class="tr-pill is-subtle">稳态 ${chosen.maxHp}（架构师 +1）</span>`}
          </div>
          <div class="tr-chosen-skills">
            <span><b>被动 · ${esc(chosen.passiveName)}：</b>${esc(chosen.passiveDesc)}</span>
            <span><b>协议技 · ${esc(chosen.activeName)}（${chosen.activeCost} Token）：</b>${esc(chosen.activeDesc)}</span>
          </div>
        </div>
        <button type="button" class="tr-btn is-primary is-lg" data-action="start-match">
          <span>${selectedMode === 'duo2v2' ? `${esc(chosen.shortName)} + ${esc(partner.shortName)} 开战` : `以 ${esc(chosen.shortName)} 开启 ${esc(modeInfo.shortName)}`}</span>
        </button>
      </footer>

      ${renderActiveRichModal()}
    </div>
  `;
}

/* ── 2. 多模式极简二次元实战牌桌（支持 4P / 2v2 / 6P 椭圆零重叠排布） ── */
function renderSeatCard(player, { targetable = false, selectedTarget = false, isActive = false, compact = false } = {}) {
  const ch = CHARACTER_MAP[player.charId];
  const role = ROLES[player.roleId];
  const showRole = player.isHuman || player.roleRevealed || !player.alive;
  const roleText = showRole ? role.name : '身份未明';
  const roleClass = showRole ? role.badgeClass : 'is-hidden';
  const isSeatThinking = aiThinkingSeat === player.seat;
  const thinkingBadge = isSeatThinking
    ? aiThinkingMode === 'model'
      ? '<span class="tr-thinking-pill">模型思考中</span>'
      : aiThinkingMode === 'look'
        ? '<span class="tr-thinking-pill is-local">看牌中…</span>'
        : aiThinkingMode === 'end'
          ? '<span class="tr-thinking-pill is-local">整理手牌</span>'
          : '<span class="tr-thinking-pill is-local">思考出牌…</span>'
    : isActive && player.alive
      ? '<span class="tr-acting-pill">行动中</span>'
      : '';

  const equips = [player.equipment.weapon, player.equipment.defense, player.equipment.utility]
    .filter(Boolean)
    .map((c) => CARD_DEFS[c.key].name);

  const hpDots = Array.from({ length: player.maxHp }, (_, idx) => {
    const filled = idx < player.hp;
    const low = player.hp <= 1;
    const mid = player.hp === 2;
    return `<span class="tr-hp-dot${filled ? ' is-full' : ''}${filled && low ? ' is-low' : filled && mid ? ' is-mid' : ''}"></span>`;
  }).join('');

  const tokenDots = Array.from({ length: player.maxTokens }, (_, idx) => {
    return `<span class="tr-tk-dot${idx < player.tokens ? ' is-full' : ''}"></span>`;
  }).join('');

  const tag = targetable ? 'button' : 'div';
  const extraAttrs =
    tag === 'button'
      ? `type="button" data-action="select-target" data-seat="${player.seat}" aria-pressed="${selectedTarget ? 'true' : 'false'}"`
      : '';

  return `
    <${tag}
      class="tr-seat is-fullart${compact ? ' is-compact' : ''}${player.isHuman ? ' is-human' : ''}${isActive ? ' is-active' : ''}${targetable ? ' is-targetable' : ''}${selectedTarget ? ' is-selected' : ''}${!player.alive ? ' is-dead' : ''}${state?.mode === 'duo2v2' ? ` is-team-${role.team}` : ''}"
      data-char="${esc(ch.id)}"
      data-seat-box="${player.seat}"
      ${extraAttrs}
      title="${esc(`${ch.name}（${ch.title}）\n被动【${ch.passiveName}】：${ch.passiveDesc}\n协议技【${ch.activeName}】：${ch.activeDesc}`)}"
    >
      <div class="tr-seat-art-clip" aria-hidden="true">
        <img class="tr-seat-art-img" src="${esc(ch.portrait)}" alt="" draggable="false" />
        <div class="tr-seat-scrim"></div>
      </div>
      ${player.modelBubble ? `<div class="tr-seat-bubble">${esc(player.modelBubble)}</div>` : ''}
      <div class="tr-seat-top">
        <span class="tr-role-tag ${roleClass}">${esc(roleText)}</span>
        <span class="tr-seat-badges">
          ${player.shields > 0 ? `<span class="tr-shield-pill">盾 ${player.shields}</span>` : ''}
          ${player.turnFlags?.cacheCharges > 0 ? `<span class="tr-cache-pill">缓存 ${player.turnFlags.cacheCharges}</span>` : ''}
          ${player.delayedLoop ? '<span class="tr-loop-pill">死循环</span>' : ''}
          ${player.delayedSandbox || player.turnFlags?.sandboxLocked ? '<span class="tr-sandbox-pill">隔离</span>' : ''}
          ${thinkingBadge}
          ${!player.alive ? '<span class="tr-dead-pill">已离线</span>' : ''}
        </span>
      </div>

      <div class="tr-seat-body is-fullart">
        <div class="tr-seat-info">
          <div class="tr-seat-name-row">
            <strong>${esc(ch.name)}</strong>
            <small>${esc(player.isHuman ? '你' : player.playerLabel)}</small>
          </div>

          <div class="tr-meter-row" aria-label="稳态 ${player.hp}/${player.maxHp}">
            <span class="tr-meter-label">稳态</span>
            <div class="tr-dots">${hpDots}</div>
            <span class="tr-num">${player.hp}/${player.maxHp}</span>
          </div>

          <div class="tr-meter-row" aria-label="Token ${player.tokens}/${player.maxTokens}">
            <span class="tr-meter-label">TK</span>
            <div class="tr-dots">${tokenDots}</div>
            <span class="tr-num">${player.tokens}</span>
          </div>

          <div class="tr-seat-foot">
            <span class="tr-num">牌 ${player.hand.length}</span>
            ${equips.length ? `<span class="tr-eq-inline">${esc(equips.join(' · '))}</span>` : ''}
          </div>
        </div>
      </div>
    </${tag}>
  `;
}

function getSelectedCard(human) {
  if (!state.selectedCardUid) return null;
  return human.hand.find((c) => c.uid === state.selectedCardUid) || null;
}

function getTargetScope(human) {
  if (state.activeSeat !== 0 || state.phase !== 'play' || state.prompt) return null;
  if (state.skillMode) {
    const ch = CHARACTER_MAP[human.charId];
    if (ch.needsTarget) return 'other';
    if (human.charId === 'ai-claude') {
      const copyDef = CARD_DEFS[state.lastPlayedCardKey];
      if (copyDef?.needsTarget || copyDef?.optionalTarget) return copyDef.targetScope || 'other';
    }
    return null;
  }
  const card = getSelectedCard(human);
  if (!card) return null;
  const def = CARD_DEFS[card.key];
  if (def.needsTarget || def.optionalTarget) {
    return def.targetScope || 'other';
  }
  return null;
}

function isSeatTargetable(player, scope) {
  if (!scope || !player.alive) return false;
  if (scope === 'any') return true;
  if (scope === 'ally_or_self') {
    if (player.isHuman) return true;
    if (state.mode === 'duo2v2') return player.roleId === 'blue';
    return true;
  }
  return !player.isHuman;
}

function getHumanPlayHint(human) {
  if (dealingRevealCount !== null) return '正在为你与同桌 AI 娘依次发放起手牌……';
  if (state.prompt) return state.prompt.description;
  if (state.phase === 'discard') {
    const need = Math.max(0, human.hand.length - getMaxHandSize(state, human));
    return `手牌超出上限，请再选择 ${Math.max(0, need - state.discardSelection.length)} 张牌弃置（或一键智能弃牌）。`;
  }
  if (state.activeSeat !== 0) {
    const cur = state.players[state.activeSeat];
    if (aiThinkingSeat === cur.seat && aiThinkingMode === 'model') {
      return `${cur.name} 正在由接待模型推演最优出牌策略……`;
    }
    if (aiThinkingSeat === cur.seat && aiThinkingMode === 'look') {
      return `${cur.name} 刚摸完牌，正在查看手牌局势……`;
    }
    return `${cur.name} 正在思考出牌与协议技……`;
  }
  if (state.skillMode) {
    const ch = CHARACTER_MAP[human.charId];
    if (ch.needsCard && !state.selectedCardUid) return `协议技【${ch.activeName}】：请点选 1 张手牌作为润色素材。`;
    if (ch.needsTarget && state.selectedTargetSeat === null) return `协议技【${ch.activeName}】：请点击场上一名目标。`;
    return `协议技【${ch.activeName}】已就绪，点击「确认释放」即可触发！`;
  }
  const card = getSelectedCard(human);
  if (!card) {
    return '点选手牌出牌，或点击下方「协议技」消耗 Token 释放角色大招。';
  }
  const def = CARD_DEFS[card.key];
  if (!def.playableInTurn) return `【${def.name}】为响应式功能牌，需在对手触发时打出。`;
  if (card.key === 'heal' && human.hp >= human.maxHp) return '当前稳态值已满，暂无需使用【能量充能】。';
  if (card.key === 'overload' && human.hp < 2) return '当前稳态不足 2 点，无法发动【过载自爆】。';
  if (card.key === 'strike' && human.turnFlags.strikesUsed >= getStrikeLimit(state, human)) {
    return '本回合【暴击锐评】次数已用完（装配并发加速卡可无限连击）。';
  }
  if (def.optionalTarget && state.selectedTargetSeat === null) {
    return `已选【${def.name}】：直接打出可强化自身，或先点蓝队搭档为其回血套盾 +1 TK。`;
  }
  const isResonance = Boolean(def.kind === 'signature' && def.ownerCharId === human.charId);
  if (def.needsTarget && state.selectedTargetSeat === null) {
    return `${isResonance ? '【本命共鸣】' : ''}已选【${def.name}】，请点击场上一名目标席位。`;
  }
  return `已就绪：【${def.name}】— ${def.desc}${isResonance && def.resonanceDesc ? `（${def.resonanceDesc}）` : ''}`;
}

function checkHumanCanConfirmPlay(human) {
  if (state.scene !== 'playing' || state.activeSeat !== 0 || state.phase !== 'play' || state.prompt) return false;
  if (state.skillMode) {
    const ch = CHARACTER_MAP[human.charId];
    const sk = canUseActiveSkill(state, human);
    if (!sk.ok) return false;
    if (ch.needsCard && !state.selectedCardUid) return false;
    if (ch.needsTarget && state.selectedTargetSeat === null) return false;
    if (human.charId === 'ai-claude') {
      const copyDef = CARD_DEFS[state.lastPlayedCardKey];
      if (copyDef?.needsTarget && state.selectedTargetSeat === null) return false;
    }
    return true;
  }
  const card = getSelectedCard(human);
  if (!card) return false;
  const def = CARD_DEFS[card.key];
  if (!def.playableInTurn) return false;
  if (card.key === 'heal' && human.hp >= human.maxHp) return false;
  if (card.key === 'overload' && human.hp < 2) return false;
  if (card.key === 'strike' && human.turnFlags.strikesUsed >= getStrikeLimit(state, human)) return false;
  if (def.needsTarget && state.selectedTargetSeat === null) return false;
  return true;
}

function renderArenaSeats(human, targetScope) {
  const isSix = state.mode === 'grand6';
  const makeSeat = (p, compact = false) =>
    renderSeatCard(p, {
      targetable: isSeatTargetable(p, targetScope),
      selectedTarget: state.selectedTargetSeat === p.seat,
      isActive: state.activeSeat === p.seat,
      compact,
    });

  if (isSix) {
    // 6 人顺时针布局：底0(你) -> 左下1 -> 左上2 -> 顶3 -> 右上4 -> 右下5
    const s1 = state.players[1];
    const s2 = state.players[2];
    const s3 = state.players[3];
    const s4 = state.players[4];
    const s5 = state.players[5];
    return {
      top: makeSeat(s3, true),
      left: `<div class="tr-side-stack">${makeSeat(s2, true)}${makeSeat(s1, true)}</div>`,
      right: `<div class="tr-side-stack">${makeSeat(s4, true)}${makeSeat(s5, true)}</div>`,
    };
  }

  return {
    top: makeSeat(state.players[2], false),
    left: makeSeat(state.players[1], false),
    right: makeSeat(state.players[3], false),
  };
}

function renderPlayingScreen() {
  const human = state.players[0];
  const humanChar = CHARACTER_MAP[human.charId];
  const humanRole = ROLES[human.roleId];
  const activePlayer = state.players[state.activeSeat];
  const isMyPlayPhase = dealingRevealCount === null && state.activeSeat === 0 && state.phase === 'play' && !state.prompt;
  const targetScope = getTargetScope(human);
  const canConfirm = checkHumanCanConfirmPlay(human);
  const skillState = canUseActiveSkill(state, human);
  const skillCost = getSkillCost(state, human);
  const skillLimit = getSkillLimit(state);
  const maxHand = getMaxHandSize(state, human);
  const isSix = state.mode === 'grand6';
  const soundOn = isSoundEnabled();

  const arenaSeats = renderArenaSeats(human, targetScope);
  const myEquips = [human.equipment.weapon, human.equipment.defense, human.equipment.utility].filter(Boolean);

  root.innerHTML = `
    <div class="tr-game" data-scene="${esc(state.scene)}" data-mode="${esc(state.mode)}" data-bg-mode="${esc(bgMode)}">
      <header class="tr-topbar">
        <div class="tr-tb-group">
          <span class="tr-brand"><i></i>算力牌局</span>
          <span class="tr-sub-pill">${esc(state.modeName)}</span>
        </div>

        <div class="tr-tb-center tr-num">
          <span>第 ${state.round} 轮</span>
          <span class="tr-sep">/</span>
          <strong>${
            dealingRevealCount !== null
              ? '正在发牌…'
              : state.prompt
                ? '响应窗口'
                : aiThinkingSeat !== null && aiThinkingMode === 'model'
                  ? `${activePlayer.shortName} · 模型思考中`
                  : aiThinkingSeat !== null && aiThinkingMode === 'look'
                    ? `${activePlayer.shortName} · 看牌中`
                    : `${activePlayer.name} · ${state.phase === 'discard' ? '弃牌' : '行动中'}`
          }</strong>
        </div>

        <div class="tr-tb-group">
          ${renderReceptionToggleBtn(true)}
          ${renderPacingToggleBtn(true)}
          <button type="button" class="tr-tb-btn${bgMode !== 'minimal' ? ' is-active' : ''}" data-action="open-wallpaper" title="预览 8 位 AI 娘全员合照并切换桌面背景氛围">桌面</button>
          <button type="button" class="tr-tb-btn${soundOn ? ' is-active' : ''}" data-action="toggle-sound">音效</button>
          <button type="button" class="tr-tb-btn" data-action="open-codex">图鉴</button>
          <button type="button" class="tr-tb-btn" data-action="open-stats">战绩</button>
          <button type="button" class="tr-tb-btn${logOpen ? ' is-active' : ''}" data-action="toggle-log">日志</button>
          <button type="button" class="tr-tb-btn${helpOpen ? ' is-active' : ''}" data-action="toggle-help">规则</button>
          <button type="button" class="tr-tb-btn" data-action="back-select">大厅</button>
        </div>
      </header>

      <div class="tr-stage-wrap">
        <main class="tr-arena${isSix ? ' is-six' : ''}" aria-label="算力牌局实战牌桌">
          <div class="tr-ring" aria-hidden="true"></div>

          <div class="tr-slot tr-slot--top">${arenaSeats.top}</div>
          <div class="tr-slot tr-slot--left">${arenaSeats.left}</div>

          <div class="tr-slot tr-slot--center">
            <div class="tr-system-card is-${esc(state.systemPrompt.tone)}" title="${esc(state.systemPrompt.desc)}">
              <span class="tr-system-kicker">SYSTEM PROMPT · 第 ${state.round} 轮全局规则</span>
              <strong>${esc(state.systemPrompt.title)}</strong>
              <p>${esc(state.systemPrompt.desc)}</p>
            </div>

            <div class="tr-piles-bar tr-num">
              <span>牌堆 <b>${state.deck.length}</b></span>
              <i></i>
              <span>弃牌 <b>${state.discard.length}</b></span>
              ${state.lastPlayedCardKey ? `<i></i><span>上一牌 <b>${esc(CARD_DEFS[state.lastPlayedCardKey].name)}</b></span>` : ''}
              ${state.modelDecisions > 0 ? `<i></i><span>模型参战 <b>${state.modelDecisions}次</b></span>` : ''}
            </div>

            ${state.bannerEffect ? `<div class="tr-effect-toast is-${esc(state.bannerEffect.tone)}">${esc(state.bannerEffect.text)}</div>` : ''}
            <p class="tr-center-hint">${esc(getHumanPlayHint(human))}</p>
          </div>

          <div class="tr-slot tr-slot--right">${arenaSeats.right}</div>

          <div class="tr-slot tr-slot--bottom">
            <div class="tr-human-row">
              ${renderSeatCard(human, {
                targetable: isSeatTargetable(human, targetScope),
                selectedTarget: state.selectedTargetSeat === 0,
                isActive: state.activeSeat === 0,
                compact: isSix,
              })}

              <div class="tr-side-panel">
                <div class="tr-role-secret-row">
                  <span class="tr-secret-label">${state.mode === 'duo2v2' ? '你的所属阵营' : '你的秘密身份'}</span>
                  <strong class="tr-role-tag ${humanRole.badgeClass}">${esc(humanRole.name)}</strong>
                </div>
                <p class="tr-secret-goal">${esc(humanRole.goal)}</p>
                <div class="tr-equip-line">
                  <span class="tr-secret-label">插件</span>
                  ${
                    myEquips.length
                      ? myEquips.map((c) => `<span class="tr-equip-chip">${esc(CARD_DEFS[c.key].name)}</span>`).join('')
                      : '<span class="tr-equip-empty">暂无已装配插件</span>'
                  }
                </div>
              </div>
            </div>
          </div>

          ${renderPromptOverlay()}
        </main>

        <aside class="tr-log-drawer${logOpen ? ' is-open' : ''}" aria-label="战局日志">
          <div class="tr-log-head">
            <strong>战局记录</strong>
            <button type="button" class="tr-tb-btn" data-action="toggle-log">收起</button>
          </div>
          <div class="tr-log-list">
            ${state.logs
              .slice()
              .reverse()
              .map(
                (entry) => `
                  <div class="tr-log-item is-${esc(entry.tone)}">
                    <span class="tr-num">R${entry.round} · ${esc(entry.actor)}</span>
                    <p>${esc(entry.text)}</p>
                  </div>
                `,
              )
              .join('')}
          </div>
        </aside>
      </div>

      <section class="tr-hand-dock" aria-label="手牌与协议技操作区">
        <div class="tr-hand-strip">
          ${(() => {
            const visibleHand =
              dealingRevealCount !== null ? human.hand.slice(0, dealingRevealCount) : human.hand;
            if (!visibleHand.length) {
              return `<div class="tr-empty-hand">${dealingRevealCount !== null ? '荷官正在发牌……' : '当前暂无手牌'}</div>`;
            }
            return visibleHand
              .map((card, idx) => {
                const isSelected =
                  state.phase === 'discard'
                    ? state.discardSelection.includes(card.uid)
                    : state.selectedCardUid === card.uid;
                const disabled =
                  dealingRevealCount !== null ||
                  state.scene !== 'playing' ||
                  Boolean(state.prompt) ||
                  state.activeSeat !== 0 ||
                  (state.phase !== 'play' && state.phase !== 'discard');
                const extraClass =
                  dealingRevealCount !== null && idx === visibleHand.length - 1 ? 'is-dealing-in' : '';
                return renderCardMarkup(card, { selected: isSelected, disabled, extraClass });
              })
              .join('');
          })()}
        </div>

        <div class="tr-dock-bar">
          <div class="tr-dock-left">
            <span class="tr-hand-stat tr-num">
              手牌 <b>${human.hand.length}</b> / 上限 ${maxHand} · Token <b>${human.tokens}</b>
              ${human.turnFlags?.cacheCharges > 0 ? ` · 缓存 <b>${human.turnFlags.cacheCharges}</b>` : ''}
            </span>

            <button
              type="button"
              class="tr-btn is-skill${state.skillMode ? ' is-active' : ''}"
              data-action="toggle-skill"
              ${!isMyPlayPhase || !skillState.ok ? 'disabled' : ''}
              title="${esc(`${humanChar.activeName}（消耗 ${skillCost} Token，本轮可用 ${skillLimit} 次）：${humanChar.activeDesc}${!skillState.ok ? `\n暂不可用：${skillState.reason}` : ''}`)}"
            >
              <span>协议技 · ${esc(humanChar.activeName)}</span>
              <em class="tr-cost-chip tr-num">${skillCost} TK</em>
            </button>

            <button
              type="button"
              class="tr-btn is-primary"
              data-action="confirm-play"
              ${!canConfirm ? 'disabled' : ''}
            >
              <span>${state.skillMode ? '确认释放协议技' : '打出所选牌'}</span>
            </button>
          </div>

          <div class="tr-dock-right">
            ${
              state.phase === 'discard' && state.activeSeat === 0
                ? `
                  <button
                    type="button"
                    class="tr-btn"
                    data-action="confirm-discard"
                    ${human.hand.length - state.discardSelection.length > maxHand ? 'disabled' : ''}
                  >确认弃牌</button>
                  <button type="button" class="tr-btn is-primary" data-action="auto-discard">一键智能弃牌</button>
                `
                : `
                  <button type="button" class="tr-btn is-primary" data-action="end-turn" ${!isMyPlayPhase ? 'disabled' : ''}>
                    <span>结束回合</span>
                  </button>
                `
            }
          </div>
        </div>
      </section>

      ${helpOpen ? renderHelpPopover(humanChar) : ''}
      ${state.scene === 'gameover' ? renderGameOverOverlay() : ''}
      ${renderActiveRichModal()}
    </div>
  `;
}

function renderActiveRichModal() {
  if (modalView === 'codex') {
    return renderCodexModal({ tab: codexTab, filter: codexFilter });
  }
  if (modalView === 'stats') {
    return renderStatsModal(loadStats());
  }
  if (modalView === 'wallpaper') {
    return renderWallpaperModal({ bgMode });
  }
  return '';
}

function renderPromptOverlay() {
  const p = state.prompt;
  if (!p || state.scene !== 'playing') return '';

  if (p.type === 'response') {
    const human = state.players[0];
    const matched = human.hand.filter((c) => p.acceptedKeys.includes(c.key));
    return `
      <div class="tr-prompt-banner" role="alertdialog" aria-label="${esc(p.title)}">
        <div class="tr-prompt-body">
          <span class="tr-prompt-kicker">RESPONSE WINDOW · 即时响应</span>
          <strong>${esc(p.title)}</strong>
          <p>${esc(p.description)}</p>
        </div>
        <div class="tr-prompt-actions">
          ${matched
            .map((card) => {
              const def = CARD_DEFS[card.key];
              return `
                <button type="button" class="tr-btn is-primary" data-action="prompt-respond" data-uid="${esc(card.uid)}">
                  打出 ${esc(SUIT_SYMBOL[card.suit])}${esc(card.rank)} ${esc(def.name)}
                </button>
              `;
            })
            .join('')}
          <button type="button" class="tr-btn" data-action="prompt-respond" data-uid="">不响应</button>
        </div>
      </div>
    `;
  }

  if (p.type === 'pick_card') {
    return `
      <div class="tr-modal-backdrop" role="dialog" aria-label="${esc(p.title)}">
        <div class="tr-modal-card">
          <span class="tr-prompt-kicker">PROTOCOL SKILL · 协议抉择</span>
          <h3>${esc(p.title)}</h3>
          <p>${esc(p.description)}</p>
          <div class="tr-pick-strip">
            ${p.cards.map((card) => renderCardMarkup(card, { action: 'prompt-pick', extraClass: 'is-pickable' })).join('')}
          </div>
        </div>
      </div>
    `;
  }

  return '';
}

function renderHelpPopover(humanChar) {
  return `
    <aside class="tr-help-popover" role="dialog" aria-label="算力牌局规则说明">
      <div class="tr-log-head">
        <strong>算力牌局 · 快速上手</strong>
        <button type="button" class="tr-tb-btn" data-action="toggle-help">关闭</button>
      </div>
      <div class="tr-help-body">
        <h4>1. 三大模式规则</h4>
        <p><b>4人暗身份</b>：架构师+助手 vs 越狱黑客 vs 混沌独赢。<br/><b>2v2 搭档战</b>：蓝红双人明置对抗，队友免洪峰误伤、可互奶互救、击杀全队拿赏金。<br/><b>6人大局</b>：1 架构师 + 1 助手 + 3 越狱黑客 + 1 混沌观测者混战。</p>
        <h4>2. 接待模型参战 & ${CARD_LIST.length} 种原创手牌</h4>
        <p>开启顶栏「接待模型」开关后，已接入的接待模型会亲自指挥 AI 娘决策出牌并发表实时吐槽；点「图鉴」可随时查阅全部 ${CARD_LIST.length} 种手牌（含 8 张 AI 娘专属特色梗牌，本尊打出额外触发本命共鸣！）与 10 种全局系统事件。</p>
        <h4>3. 当前角色 · ${esc(humanChar.name)}</h4>
        <p><b>被动【${esc(humanChar.passiveName)}】</b>：${esc(humanChar.passiveDesc)}<br/><b>协议技【${esc(humanChar.activeName)}】</b>：${esc(humanChar.activeDesc)}</p>
      </div>
    </aside>
  `;
}

function renderGameOverOverlay() {
  const w = state.winner;
  if (!w) return '';
  return `
    <div class="tr-modal-backdrop" role="dialog" aria-label="对局结算">
      <div class="tr-gameover-card${state.players.length > 4 ? ' is-wide' : ''}">
        <span class="tr-result-pill${w.humanWon ? ' is-win' : ' is-lose'}">${w.humanWon ? '对局胜利' : '遗憾落败'}</span>
        <h2>${esc(w.headline)}</h2>
        <p>${esc(w.summary)}</p>
        <div class="tr-gameover-meta tr-num">
          <span>${esc(state.modeName)}</span>
          <span>共 ${state.round} 轮</span>
          <span>你的淘汰 ${state.humanKills || 0}</span>
          ${state.modelDecisions > 0 ? `<span>接待模型决策 ${state.modelDecisions} 次</span>` : ''}
        </div>
        <div class="tr-reveal-grid${state.players.length > 4 ? ' is-six' : ''}">
          ${state.players
            .map((p) => {
              const ch = CHARACTER_MAP[p.charId];
              const role = ROLES[p.roleId];
              return `
                <div class="tr-reveal-item is-fullart${p.isHuman ? ' is-me' : ''}" data-char="${esc(ch.id)}">
                  <img src="${esc(ch.portrait)}" alt="${esc(ch.name)}" />
                  <div>
                    <strong>${esc(ch.shortName)} ${p.isHuman ? '（你）' : ''}</strong>
                    <span class="tr-role-tag ${role.badgeClass}">${esc(role.name)}</span>
                    <small>${p.alive ? `存活 · 稳态 ${p.hp}` : '已离线'}</small>
                  </div>
                </div>
              `;
            })
            .join('')}
        </div>
        <div class="tr-gameover-actions">
          <button type="button" class="tr-btn is-primary" data-action="restart-same">原阵容再来一局</button>
          <button type="button" class="tr-btn" data-action="open-stats">查看战绩</button>
          <button type="button" class="tr-btn" data-action="back-select">返回大厅</button>
        </div>
      </div>
    </div>
  `;
}

function render() {
  if (!state) {
    renderSelectScreen();
  } else {
    renderPlayingScreen();
  }
}

/* ── 统一事件委托（零内联脚本，严格通过 CSP 检查） ── */
root.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const action = target.dataset.action;

  if (action === 'close-modal-backdrop') {
    if (event.target === target) {
      modalView = null;
      render();
    }
    return;
  }

  if (action === 'close-modal') {
    modalView = null;
    playSound('click');
    render();
    return;
  }

  if (action === 'open-codex') {
    modalView = 'codex';
    helpOpen = false;
    playSound('click');
    render();
    return;
  }

  if (action === 'open-stats') {
    modalView = 'stats';
    helpOpen = false;
    playSound('click');
    render();
    return;
  }

  if (action === 'open-wallpaper') {
    modalView = 'wallpaper';
    helpOpen = false;
    playSound('click');
    render();
    return;
  }

  if (action === 'set-bg-mode') {
    bgMode = saveBgMode(target.dataset.bgMode || 'soft');
    playSound('click');
    render();
    return;
  }

  if (action === 'codex-tab') {
    codexTab = target.dataset.tab || 'cards';
    playSound('click');
    render();
    return;
  }

  if (action === 'codex-filter') {
    codexFilter = target.dataset.filter || 'all';
    playSound('click');
    render();
    return;
  }

  if (action === 'reset-stats') {
    resetStats();
    playSound('click');
    render();
    return;
  }

  if (action === 'toggle-sound') {
    setSoundEnabled(!isSoundEnabled());
    render();
    return;
  }

  if (action === 'cycle-pacing') {
    cyclePacing();
    render();
    return;
  }

  if (action === 'toggle-model-coplay') {
    const next = setModelCoplayEnabled(!isModelCoplayEnabled());
    playSound('click');
    if (next && !getReceptionModelStatus().ready) {
      probeReceptionModel(selectedCharId).then(() => render());
    }
    render();
    return;
  }

  if (action === 'pick-mode') {
    selectedMode = target.dataset.mode || 'classic4';
    ensureDistinctPartner();
    playSound('click');
    render();
    return;
  }

  if (action === 'pick-partner') {
    const cid = target.dataset.charId;
    if (cid && cid !== selectedCharId) {
      selectedPartnerId = cid;
      playSound('click');
      render();
    }
    return;
  }

  if (action === 'pick-char') {
    const cid = target.dataset.charId || selectedCharId;
    if (selectedMode === 'duo2v2' && cid === selectedPartnerId) {
      selectedPartnerId = selectedCharId;
    }
    selectedCharId = cid;
    ensureDistinctPartner();
    playSound('click');
    render();
    return;
  }

  if (action === 'start-match' || action === 'restart-same') {
    startNewMatch(selectedCharId);
    return;
  }

  if (action === 'back-select') {
    playSound('click');
    returnToSelect();
    return;
  }

  if (!state) return;

  if (action === 'toggle-log') {
    logOpen = !logOpen;
    playSound('click');
    render();
    return;
  }

  if (action === 'toggle-help') {
    helpOpen = !helpOpen;
    playSound('click');
    render();
    return;
  }

  const human = state.players[0];

  if (action === 'select-card') {
    const uid = target.dataset.uid;
    playSound('click');
    if (state.phase === 'discard' && state.activeSeat === 0) {
      if (state.discardSelection.includes(uid)) {
        state.discardSelection = state.discardSelection.filter((id) => id !== uid);
      } else {
        state.discardSelection.push(uid);
      }
      render();
      return;
    }
    if (state.activeSeat !== 0 || state.phase !== 'play' || state.prompt) return;
    if (state.selectedCardUid === uid) {
      state.selectedCardUid = null;
      state.selectedTargetSeat = null;
    } else {
      state.selectedCardUid = uid;
      if (!state.skillMode) {
        state.selectedTargetSeat = null;
        // 2v2 选到【协同共鸣】时体贴地自动预选蓝队搭档（seat 2）
        const chosenCard = human.hand.find((c) => c.uid === uid);
        if (chosenCard?.key === 'synergy' && state.mode === 'duo2v2' && state.players[2]?.alive) {
          state.selectedTargetSeat = 2;
        }
      }
    }
    render();
    return;
  }

  if (action === 'select-target') {
    const seat = Number(target.dataset.seat);
    state.selectedTargetSeat = state.selectedTargetSeat === seat ? null : seat;
    playSound('click');
    render();
    return;
  }

  if (action === 'toggle-skill') {
    if (state.activeSeat !== 0 || state.phase !== 'play' || state.prompt) return;
    const ch = CHARACTER_MAP[human.charId];
    if (!state.skillMode && !ch.needsCard && !ch.needsTarget) {
      triggerActiveSkill(state, human, {}, () => {
        recordMatchIfOver();
        render();
        scheduleAiIfNeeded();
      });
      render();
      return;
    }
    state.skillMode = !state.skillMode;
    state.selectedTargetSeat = null;
    playSound('click');
    render();
    return;
  }

  if (action === 'confirm-play') {
    if (!checkHumanCanConfirmPlay(human)) return;
    if (state.skillMode) {
      const cardUid = state.selectedCardUid;
      const targetSeat = state.selectedTargetSeat;
      state.skillMode = false;
      state.selectedCardUid = null;
      state.selectedTargetSeat = null;
      triggerActiveSkill(state, human, { cardUid, targetSeat }, () => {
        recordMatchIfOver();
        render();
        scheduleAiIfNeeded();
      });
      render();
      return;
    }
    const cardUid = state.selectedCardUid;
    const targetSeat = state.selectedTargetSeat;
    state.selectedCardUid = null;
    state.selectedTargetSeat = null;
    playCard(state, human, cardUid, targetSeat, () => {
      recordMatchIfOver();
      render();
      scheduleAiIfNeeded();
    });
    render();
    return;
  }

  if (action === 'end-turn') {
    if (state.activeSeat !== 0 || state.phase !== 'play' || state.prompt) return;
    playSound('click');
    endCurrentTurn(state, () => {
      recordMatchIfOver();
      render();
      scheduleAiIfNeeded();
    });
    render();
    scheduleAiIfNeeded();
    return;
  }

  if (action === 'confirm-discard') {
    confirmHumanDiscard(state, state.discardSelection, () => {
      recordMatchIfOver();
      render();
      scheduleAiIfNeeded();
    });
    render();
    scheduleAiIfNeeded();
    return;
  }

  if (action === 'auto-discard') {
    const maxHand = getMaxHandSize(state, human);
    const need = Math.max(0, human.hand.length - maxHand);
    const uids = human.hand.slice(0, need).map((c) => c.uid);
    confirmHumanDiscard(state, uids, () => {
      recordMatchIfOver();
      render();
      scheduleAiIfNeeded();
    });
    render();
    scheduleAiIfNeeded();
    return;
  }

  if (action === 'prompt-respond' && state.prompt?.type === 'response') {
    const uid = target.dataset.uid || null;
    const resolver = state.prompt.onResolve;
    state.prompt = null;
    resolver?.(uid);
    recordMatchIfOver();
    render();
    scheduleAiIfNeeded();
    return;
  }

  if (action === 'prompt-pick' && state.prompt?.type === 'pick_card') {
    const uid = target.dataset.uid;
    const resolver = state.prompt.onResolve;
    state.prompt = null;
    resolver?.(uid);
    recordMatchIfOver();
    render();
    scheduleAiIfNeeded();
  }
});

// 订阅宿主主题切换、伴玩阵容变化与接待模型状态推送
subscribeHostBridge({
  onTheme: () => {
    // CSS 通过 html[data-codex-theme] 自动实时切换
  },
  onRoster: (nextList) => {
    companions = nextList;
    if (state) {
      for (let i = 1; i < state.players.length; i += 1) {
        if (state.mode === 'duo2v2' && state.players[i].roleId === 'blue') continue;
        if (nextList[i - 1]?.name) {
          state.players[i].playerLabel = nextList[i - 1].name;
        }
      }
    }
    render();
  },
  onModel: (info) => {
    applyHostModelStatus(info);
    render();
  },
});

// 启动时自动主动探测同源接待模型是否可用
probeReceptionModel(selectedCharId).then(() => render());
window.addEventListener('resize', () => {
  if (logOpen && window.innerWidth < 1120) {
    logOpen = false;
    render();
  }
});
render();
