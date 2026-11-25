/**
 * 算力牌局 · Token Rumble — 接待模型真实下场打牌控制器
 * 自动探测 /api/dimension/playground/reception-model，开启后在 AI 回合调用
 * POST /api/dimension/playground/coplay-reply (mode: "decide") 返回真实出牌决策与台词；
 * 若接口未配置或超时（4500ms）自动 0 感知回落内置策略 AI，绝不卡桌。
 */

import { CARD_DEFS, GAME_MODE_MAP, ROLES } from './data.js';

const COPLAY_ENABLE_KEY = 'dimension_token_rumble_model_coplay_v1';

let modelCoplayEnabled = true;
try {
  const saved = window.localStorage.getItem(COPLAY_ENABLE_KEY);
  if (saved === '0') modelCoplayEnabled = false;
} catch {
  modelCoplayEnabled = true;
}

let modelStatus = {
  ready: false,
  model: '',
  providerId: '',
  checked: false,
};

let activeController = null;

export function isModelCoplayEnabled() {
  return modelCoplayEnabled;
}

export function setModelCoplayEnabled(enabled) {
  modelCoplayEnabled = Boolean(enabled);
  try {
    window.localStorage.setItem(COPLAY_ENABLE_KEY, modelCoplayEnabled ? '1' : '0');
  } catch {
    // 忽略
  }
  return modelCoplayEnabled;
}

export function getReceptionModelStatus() {
  return { ...modelStatus };
}

export function applyHostModelStatus(info) {
  if (!info) return;
  modelStatus = {
    ready: Boolean(info.ready),
    model: String(info.model || ''),
    providerId: String(info.providerId || ''),
    checked: true,
  };
}

export async function probeReceptionModel(botId = 'ai-claude') {
  if (typeof window === 'undefined' || !window.fetch) return getReceptionModelStatus();
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 2500);
  try {
    const res = await window.fetch(
      `/api/dimension/playground/reception-model?botId=${encodeURIComponent(botId)}`,
      { method: 'GET', signal: controller.signal },
    );
    if (!res.ok) {
      modelStatus.checked = true;
      return getReceptionModelStatus();
    }
    const data = await res.json();
    if (data && data.ok) {
      modelStatus = {
        ready: Boolean(data.ready),
        model: String(data.model || ''),
        providerId: String(data.providerId || ''),
        checked: true,
      };
    }
  } catch {
    modelStatus.checked = true;
  } finally {
    window.clearTimeout(timer);
  }
  return getReceptionModelStatus();
}

export function abortPendingModelDecision() {
  if (activeController) {
    try {
      activeController.abort();
    } catch {
      // 忽略
    }
    activeController = null;
  }
}

function buildCompactGameContext(state, actor, candidates) {
  const modeInfo = GAME_MODE_MAP[state.mode] || GAME_MODE_MAP.classic4;
  const selfRole = ROLES[actor.roleId];
  const seatsSummary = state.players
    .map((p) => {
      const roleText = p.seat === actor.seat || p.roleRevealed || !p.alive ? ROLES[p.roleId].name : '未明';
      const status = p.alive
        ? `稳态${p.hp}/${p.maxHp} 盾${p.shields} TK${p.tokens} 手牌${p.hand.length}`
        : '已离线';
      const selfTag = p.seat === actor.seat ? '[你]' : p.isHuman ? '[玩家]' : '';
      return `座${p.seat}${selfTag}${p.shortName}(${roleText}): ${status}`;
    })
    .join('；');

  const handNames = actor.hand.map((c) => CARD_DEFS[c.key]?.name || c.key).join('、') || '空';
  const candLines = candidates.map((c, idx) => `${idx}: ${c.label}`).join(' | ');

  return [
    `模式:${modeInfo.name} 第${state.round}轮 全局事件:${state.systemPrompt?.title || ''}(${state.systemPrompt?.short || ''})`,
    `你的身份:${selfRole?.name || ''}，目标:${selfRole?.goal || ''}`,
    `桌面状态: ${seatsSummary}`,
    `你的手牌: ${handNames}`,
    `候选动作(必须从以下编号选 0~${candidates.length - 1}): ${candLines}`,
  ].join('\n');
}

export async function requestReceptionDecision(state, actor, candidates, timeoutMs = 4500) {
  if (!modelCoplayEnabled || !modelStatus.ready) {
    return { usedModel: false };
  }
  if (!Array.isArray(candidates) || candidates.length <= 1) {
    return { usedModel: false };
  }
  if (typeof window === 'undefined' || !window.fetch) {
    return { usedModel: false };
  }

  abortPendingModelDecision();
  const controller = new AbortController();
  activeController = controller;
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const recentLogs = state.logs
      .slice(-3)
      .map((l) => `${l.actor}:${l.text}`)
      .join('；');
    const payload = {
      botId: actor.charId,
      botName: actor.name,
      role: ROLES[actor.roleId]?.name || '对手',
      gameTitle: '算力牌局 · Token Rumble',
      mode: 'decide',
      gameContext: buildCompactGameContext(state, actor, candidates),
      eventText: recentLogs || '轮到你行动，请结合手牌和身份选出最佳动作编号。',
    };

    const res = await window.fetch('/api/dimension/playground/coplay-reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) return { usedModel: false };
    const data = await res.json();
    if (!data || !data.ok) return { usedModel: false };

    const idx = Number.isInteger(data.actionIndex) ? data.actionIndex : -1;
    if (idx < 0 || idx >= candidates.length) {
      return {
        usedModel: false,
        reply: typeof data.reply === 'string' ? data.reply : '',
        mood: typeof data.mood === 'string' ? data.mood : 'neutral',
      };
    }

    return {
      usedModel: true,
      actionIndex: idx,
      mood: data.mood || 'serious',
      reply: String(data.reply || '').slice(0, 60),
      model: String(data.model || modelStatus.model || ''),
    };
  } catch {
    return { usedModel: false };
  } finally {
    window.clearTimeout(timer);
    if (activeController === controller) activeController = null;
  }
}
