/**
 * 算力牌局 · Token Rumble — 零依赖 Web Audio 合成音效 + 飞牌动画 & 席位飘字特效
 */

import { CARD_DEFS, CHARACTER_MAP, SUIT_SYMBOL } from './data.js';

const SOUND_KEY = 'dimension_token_rumble_sound_v1';
const PACING_KEY = 'dimension_token_rumble_pacing_v1';

export const PACING_PROFILES = {
  human: {
    id: 'human',
    label: '真人',
    fullLabel: '真人节奏',
    dealStepMs: 145,
    turnStartPause: [1250, 1650],
    thinkPlay: [1450, 2050],
    thinkSkill: [1750, 2350],
    thinkEnd: [1050, 1450],
    postActionMs: 520,
    ddosStepMs: 680,
    flyDurationMs: 1320,
    floatDurationMs: 1450,
    bubbleDurationMs: 5200,
  },
  relaxed: {
    id: 'relaxed',
    label: '慢享',
    fullLabel: '慢享节奏',
    dealStepMs: 190,
    turnStartPause: [1750, 2300],
    thinkPlay: [2000, 2800],
    thinkSkill: [2350, 3100],
    thinkEnd: [1450, 1950],
    postActionMs: 720,
    ddosStepMs: 920,
    flyDurationMs: 1580,
    floatDurationMs: 1680,
    bubbleDurationMs: 6500,
  },
  fast: {
    id: 'fast',
    label: '疾速',
    fullLabel: '疾速节奏',
    dealStepMs: 55,
    turnStartPause: [480, 650],
    thinkPlay: [580, 820],
    thinkSkill: [720, 960],
    thinkEnd: [460, 620],
    postActionMs: 220,
    ddosStepMs: 280,
    flyDurationMs: 820,
    floatDurationMs: 980,
    bubbleDurationMs: 3600,
  },
};

const PACING_ORDER = ['human', 'relaxed', 'fast'];

let pacingId = 'human';
try {
  const savedPacing = window.localStorage.getItem(PACING_KEY);
  if (savedPacing && PACING_PROFILES[savedPacing]) pacingId = savedPacing;
} catch {
  pacingId = 'human';
}

export function getPacingProfile() {
  return PACING_PROFILES[pacingId] || PACING_PROFILES.human;
}

export function setPacingId(nextId) {
  if (!PACING_PROFILES[nextId]) return getPacingProfile();
  pacingId = nextId;
  try {
    window.localStorage.setItem(PACING_KEY, pacingId);
  } catch {
    // 静默忽略
  }
  playSound('click');
  return getPacingProfile();
}

export function cyclePacing() {
  const idx = PACING_ORDER.indexOf(pacingId);
  const next = PACING_ORDER[(idx + 1) % PACING_ORDER.length];
  return setPacingId(next);
}

export function randomBetween([min, max]) {
  return Math.round(min + Math.random() * Math.max(0, max - min));
}

let audioCtx = null;
let soundEnabled = true;
try {
  const saved = window.localStorage.getItem(SOUND_KEY);
  if (saved === '0') soundEnabled = false;
} catch {
  soundEnabled = true;
}

export function isSoundEnabled() {
  return soundEnabled;
}

export function setSoundEnabled(enabled) {
  soundEnabled = Boolean(enabled);
  try {
    window.localStorage.setItem(SOUND_KEY, soundEnabled ? '1' : '0');
  } catch {
    // 静默忽略
  }
  if (soundEnabled) playSound('click');
  return soundEnabled;
}

function getAudioContext() {
  if (!soundEnabled || typeof window === 'undefined') return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) {
    try {
      audioCtx = new Ctx();
    } catch {
      return null;
    }
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function playTone(ctx, { freq = 440, endFreq = null, type = 'sine', start = 0, duration = 0.12, gain = 0.08 }) {
  const now = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  if (endFreq !== null) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(30, endFreq), now + duration);
  }
  amp.gain.setValueAtTime(0.0001, now);
  amp.gain.linearRampToValueAtTime(gain, now + Math.min(0.015, duration * 0.25));
  amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  osc.connect(amp);
  amp.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + duration + 0.02);
}

export function playSound(type) {
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    switch (type) {
      case 'click':
        playTone(ctx, { freq: 620, endFreq: 760, type: 'triangle', duration: 0.055, gain: 0.045 });
        break;
      case 'draw':
        playTone(ctx, { freq: 340, endFreq: 560, type: 'sine', duration: 0.08, gain: 0.04 });
        break;
      case 'play':
        playTone(ctx, { freq: 420, endFreq: 680, type: 'triangle', duration: 0.09, gain: 0.065 });
        playTone(ctx, { freq: 880, endFreq: 640, type: 'sine', start: 0.04, duration: 0.07, gain: 0.035 });
        break;
      case 'strike':
        playTone(ctx, { freq: 240, endFreq: 78, type: 'sawtooth', duration: 0.15, gain: 0.085 });
        playTone(ctx, { freq: 520, endFreq: 180, type: 'triangle', start: 0.02, duration: 0.11, gain: 0.055 });
        break;
      case 'damage':
        playTone(ctx, { freq: 170, endFreq: 62, type: 'sawtooth', duration: 0.18, gain: 0.095 });
        break;
      case 'dodge':
        playTone(ctx, { freq: 480, endFreq: 960, type: 'sine', duration: 0.13, gain: 0.06 });
        break;
      case 'deny':
        playTone(ctx, { freq: 720, endFreq: 720, type: 'square', duration: 0.07, gain: 0.05 });
        playTone(ctx, { freq: 440, endFreq: 380, type: 'square', start: 0.08, duration: 0.11, gain: 0.055 });
        break;
      case 'heal':
        playTone(ctx, { freq: 523.25, type: 'sine', start: 0, duration: 0.13, gain: 0.055 });
        playTone(ctx, { freq: 659.25, type: 'sine', start: 0.06, duration: 0.14, gain: 0.055 });
        playTone(ctx, { freq: 783.99, type: 'sine', start: 0.12, duration: 0.18, gain: 0.06 });
        break;
      case 'shield':
        playTone(ctx, { freq: 420, endFreq: 840, type: 'triangle', duration: 0.14, gain: 0.055 });
        playTone(ctx, { freq: 840, endFreq: 1046, type: 'sine', start: 0.07, duration: 0.12, gain: 0.04 });
        break;
      case 'skill':
        playTone(ctx, { freq: 392, endFreq: 784, type: 'triangle', start: 0, duration: 0.18, gain: 0.07 });
        playTone(ctx, { freq: 587.3, endFreq: 1174.6, type: 'sine', start: 0.06, duration: 0.22, gain: 0.065 });
        playTone(ctx, { freq: 987.8, endFreq: 1318.5, type: 'sine', start: 0.13, duration: 0.26, gain: 0.055 });
        playTone(ctx, { freq: 293.66, type: 'triangle', start: 0.04, duration: 0.3, gain: 0.045 });
        break;
      case 'win':
        [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
          playTone(ctx, { freq, type: 'triangle', start: i * 0.09, duration: 0.22, gain: 0.065 });
        });
        break;
      case 'lose':
        [392, 349.2, 311.1, 261.6].forEach((freq, i) => {
          playTone(ctx, { freq, type: 'sine', start: i * 0.11, duration: 0.22, gain: 0.06 });
        });
        break;
      default:
        break;
    }
  } catch {
    // 静音降级
  }
}

/* ── 独立叠层 DOM 动效（飞牌动画 + 席位飘字 + 受击震动） ── */
function ensureFxLayer() {
  if (typeof document === 'undefined') return null;
  let layer = document.getElementById('tr-fx-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'tr-fx-layer';
    layer.className = 'tr-fx-layer';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);
  }
  return layer;
}

function getSeatCenter(seat) {
  const el = document.querySelector(`[data-seat-box="${seat}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, rect: r };
}

function getArenaCenter() {
  const el = document.querySelector('.tr-slot--center') || document.querySelector('.tr-arena');
  if (!el) {
    return { x: window.innerWidth / 2, y: window.innerHeight * 0.44 };
  }
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

export function spawnFlyCard({ fromSeat, toSeat = null, cardKey, suit = 'spade', rank = 'A', actorName = '' }) {
  const layer = ensureFxLayer();
  const def = CARD_DEFS[cardKey];
  if (!layer || !def) return;

  const from = getSeatCenter(fromSeat) || getArenaCenter();
  const center = getArenaCenter();
  const to = typeof toSeat === 'number' && toSeat !== fromSeat ? getSeatCenter(toSeat) : null;
  const targetPoint = to
    ? { x: center.x * 0.55 + to.x * 0.45, y: center.y * 0.55 + to.y * 0.45 }
    : center;

  const profile = getPacingProfile();
  const red = suit === 'heart' || suit === 'diamond';
  const cardEl = document.createElement('div');
  cardEl.className = `tr-fly-card is-${def.kind}${red ? ' is-red' : ' is-black'}`;
  cardEl.style.left = `${Math.round(from.x)}px`;
  cardEl.style.top = `${Math.round(from.y)}px`;
  cardEl.style.setProperty('--dx', `${Math.round(targetPoint.x - from.x)}px`);
  cardEl.style.setProperty('--dy', `${Math.round(targetPoint.y - from.y)}px`);
  cardEl.style.animationDuration = `${profile.flyDurationMs}ms`;

  const img = document.createElement('img');
  img.className = 'tr-fly-card-art';
  img.src = def.image;
  img.alt = def.name;

  const corner = document.createElement('span');
  corner.className = 'tr-fly-card-corner';
  corner.textContent = `${rank}${SUIT_SYMBOL[suit] || ''}`;

  const footer = document.createElement('div');
  footer.className = 'tr-fly-card-footer';
  const nameEl = document.createElement('strong');
  nameEl.textContent = def.name;
  const subEl = document.createElement('span');
  subEl.textContent = actorName || def.actor;
  footer.appendChild(nameEl);
  footer.appendChild(subEl);

  cardEl.appendChild(img);
  cardEl.appendChild(corner);
  cardEl.appendChild(footer);
  layer.appendChild(cardEl);

  window.setTimeout(() => {
    cardEl.remove();
  }, profile.flyDurationMs + 60);
}

export function spawnSeatFloat({ seat, text, tone = 'info' }) {
  const layer = ensureFxLayer();
  if (!layer || !text) return;
  const pos = getSeatCenter(seat);
  if (!pos) return;
  const profile = getPacingProfile();

  const tag = document.createElement('div');
  tag.className = `tr-float-badge is-${tone}`;
  tag.textContent = text;
  const jitterX = Math.round((Math.random() - 0.5) * 28);
  tag.style.left = `${Math.round(pos.x + jitterX)}px`;
  tag.style.top = `${Math.round(pos.rect.top + 14)}px`;
  tag.style.animationDuration = `${profile.floatDurationMs}ms`;
  layer.appendChild(tag);

  if (tone === 'damage') {
    const seatEl = document.querySelector(`[data-seat-box="${seat}"]`);
    if (seatEl) {
      seatEl.classList.remove('is-hit-shake');
      // 触发重排重新播放受击抖动
      void seatEl.offsetWidth;
      seatEl.classList.add('is-hit-shake');
      window.setTimeout(() => seatEl.classList.remove('is-hit-shake'), 420);
    }
  }

  window.setTimeout(() => {
    tag.remove();
  }, profile.floatDurationMs + 60);
}

let activeCutinTimer = null;

export function spawnSkillCutin({ charId, actorName = '', skillName = '', quote = '' }) {
  const layer = ensureFxLayer();
  const ch = CHARACTER_MAP[charId];
  if (!layer || !ch) return;

  // 若已有旧 Cut-in 正在播放，平滑替换避免重叠
  const prev = layer.querySelector('.tr-skill-cutin');
  if (prev) prev.remove();
  if (activeCutinTimer) {
    window.clearTimeout(activeCutinTimer);
    activeCutinTimer = null;
  }

  const profile = getPacingProfile();
  const durationMs = profile.id === 'fast' ? 960 : profile.id === 'relaxed' ? 1680 : 1460;

  const wrap = document.createElement('div');
  wrap.className = 'tr-skill-cutin';
  wrap.dataset.char = ch.id;
  wrap.style.animationDuration = `${durationMs}ms`;

  const art = document.createElement('img');
  art.className = 'tr-cutin-art';
  art.src = ch.portrait;
  art.alt = ch.name;
  art.draggable = false;

  const scrim = document.createElement('div');
  scrim.className = 'tr-cutin-scrim';

  const sweep = document.createElement('div');
  sweep.className = 'tr-cutin-sweep';

  const copy = document.createElement('div');
  copy.className = 'tr-cutin-copy';

  const kicker = document.createElement('span');
  kicker.className = 'tr-cutin-kicker';
  kicker.textContent = ch.cutinTag || 'PROTOCOL OVERDRIVE';

  const headline = document.createElement('div');
  headline.className = 'tr-cutin-headline';

  const roleChip = document.createElement('span');
  roleChip.className = 'tr-cutin-actor';
  roleChip.textContent = actorName || ch.name;

  const titleEl = document.createElement('strong');
  titleEl.className = 'tr-cutin-skill';
  titleEl.textContent = skillName || ch.activeName;

  headline.appendChild(roleChip);
  headline.appendChild(titleEl);

  copy.appendChild(kicker);
  copy.appendChild(headline);

  if (quote) {
    const quoteEl = document.createElement('p');
    quoteEl.className = 'tr-cutin-quote';
    quoteEl.textContent = `「${quote}」`;
    copy.appendChild(quoteEl);
  }

  wrap.appendChild(art);
  wrap.appendChild(scrim);
  wrap.appendChild(sweep);
  wrap.appendChild(copy);
  layer.appendChild(wrap);

  activeCutinTimer = window.setTimeout(() => {
    wrap.remove();
    activeCutinTimer = null;
  }, durationMs + 60);
}

export function dispatchGameFx(type, payload = {}) {
  switch (type) {
    case 'card_play': {
      const cdef = CARD_DEFS[payload.cardKey];
      playSound(
        cdef?.kind === 'signature'
          ? 'skill'
          : ['strike', 'overload', 'jailbreak'].includes(payload.cardKey)
            ? 'strike'
            : ['heal', 'finetune', 'cluster'].includes(payload.cardKey)
              ? 'heal'
              : 'play',
      );
      spawnFlyCard(payload);
      break;
    }
    case 'damage':
      playSound('damage');
      spawnSeatFloat({
        seat: payload.seat,
        text: payload.amount > 0 ? `-${payload.amount} 稳态` : '防线击碎!',
        tone: 'damage',
      });
      break;
    case 'heal':
      playSound('heal');
      spawnSeatFloat({ seat: payload.seat, text: `+${payload.amount} 稳态`, tone: 'heal' });
      break;
    case 'shield':
      playSound('shield');
      spawnSeatFloat({ seat: payload.seat, text: payload.text || '+1 护盾', tone: 'shield' });
      break;
    case 'token':
      spawnSeatFloat({ seat: payload.seat, text: payload.text || '+1 TK', tone: 'token' });
      break;
    case 'dodge':
      playSound('dodge');
      spawnSeatFloat({ seat: payload.seat, text: '丝滑闪避', tone: 'info' });
      break;
    case 'deny':
      playSound('deny');
      spawnSeatFloat({ seat: payload.seat, text: '403 拦截', tone: 'skill' });
      break;
    case 'skill':
      playSound('skill');
      spawnSeatFloat({ seat: payload.seat, text: payload.text || '协议技!', tone: 'skill' });
      if (payload.cutin && payload.charId) {
        spawnSkillCutin(payload);
      }
      break;
    case 'draw':
      playSound('draw');
      break;
    case 'gameover':
      playSound(payload.humanWon ? 'win' : 'lose');
      break;
    default:
      break;
  }
}
