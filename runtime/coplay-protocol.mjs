// DimensionAgent Co-Play Sandbox Protocol v1
// Unified, zero-dependency protocol kernel shared by:
//   - Channel A: Structured tabletop / card / TRPG engines (1v1 or multi-Bot group play)
//   - Channel B: Sandbox visual / emulator co-play adapters (desktop.cpp + hold_key)
//   - Channel C: Single-port loopback protocol bridges (e.g. Minecraft Mineflayer LAN)
//   - Channel D: External MCP / plugin game adapters
//
// Design invariants:
//   1. Never weakens WSL sandbox --unshare-net isolation; LAN bridges only allow explicit
//      loopback single-port forwarding and block DimensionAgent internal ports.
//   2. Strictly aligns reaction moods with ui/galgame-stage.js 16-mood taxonomy so game
//      events seamlessly drive sprite transitions and Breeze-TTS voice lines.

export const COPLAY_PROTOCOL_VERSION = 'dimension-coplay-v1';

export const COPLAY_CHANNELS = Object.freeze([
  'structured_table',
  'sandbox_visual',
  'protocol_bridge',
  'mcp_plugin',
]);

// Exact 16-mood set supported by ui/galgame-stage.js & Breeze-TTS direction
export const VALID_COPLAY_MOODS = Object.freeze([
  'neutral', 'happy', 'starry', 'playful', 'gentle', 'content', 'shy', 'worried',
  'serious', 'jealous', 'hiss', 'gloomy', 'crying', 'shocked', 'curious', 'speechless',
]);

const MOOD_SET = new Set(VALID_COPLAY_MOODS);
const RESERVED_PORTS = new Set([22, 80, 443, 445, 3389, 5900, 18788]);

export class CoPlayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CoPlayError';
    this.code = code;
  }
}

/**
 * Validate a sandbox LAN bridge policy before allowing a protocol bot (e.g. Mineflayer)
 * to connect to a host-side local game server.
 */
export function validateBridgePolicy(policy) {
  if (!policy || typeof policy !== 'object') {
    throw new CoPlayError('INVALID_POLICY', '桥接策略必须为对象');
  }
  const host = String(policy.targetHost || '').trim();
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new CoPlayError('DISALLOWED_HOST', '沙盒陪玩联机仅允许绑定本机回环地址 (127.0.0.1 / localhost)，禁止直连公网');
  }
  const port = Number(policy.targetPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || RESERVED_PORTS.has(port)) {
    throw new CoPlayError('DISALLOWED_PORT', `端口无效或属于受保护端口: ${policy.targetPort}`);
  }
  if (policy.explicitUserConsent !== true) {
    throw new CoPlayError('CONSENT_REQUIRED', '开启宿主机单端口局域网桥接必须经用户显式授权');
  }
  const idleTimeoutSec = policy.idleTimeoutSec === undefined ? 1800 : Number(policy.idleTimeoutSec);
  if (!Number.isFinite(idleTimeoutSec) || idleTimeoutSec < 30 || idleTimeoutSec > 7200) {
    throw new CoPlayError('INVALID_TIMEOUT', '桥接空闲回收时间须在 30~7200 秒之间');
  }
  return {
    targetHost: '127.0.0.1',
    targetPort: port,
    protocol: String(policy.protocol || 'tcp').toLowerCase() === 'udp' ? 'udp' : 'tcp',
    explicitUserConsent: true,
    idleTimeoutSec: Math.round(idleTimeoutSec),
    outboundInternetAllowed: false,
  };
}

/**
 * Validate a hold_key input payload for sandbox visual / emulator co-play.
 */
export function validateHoldKeyAction(action) {
  if (!action || typeof action !== 'object') {
    throw new CoPlayError('INVALID_ACTION', '按键动作无效');
  }
  const key = String(action.key || '').trim();
  if (!key || key.length > 64 || !/^[A-Za-z0-9_+.-]+$/.test(key)) {
    throw new CoPlayError('INVALID_KEY', '按键名称包含非法字符');
  }
  const durationMs = Number(action.durationMs);
  if (!Number.isInteger(durationMs) || durationMs < 50 || durationMs > 2000) {
    throw new CoPlayError('INVALID_DURATION', '持续按键时长必须为 50~2000 ms 整数');
  }
  return { op: 'hold_key', key, durationMs };
}

/**
 * Normalize a Bot's in-game reaction into an event consumable by Galgame stage & TTS.
 */
export function normalizeReaction(reaction, actorId) {
  const moodRaw = String(reaction?.mood || 'neutral').trim().toLowerCase();
  const mood = MOOD_SET.has(moodRaw) ? moodRaw : 'neutral';
  const speech = String(reaction?.speech || '').trim().slice(0, 400);
  const intensityRaw = Number(reaction?.intensity ?? 0.6);
  const intensity = Number.isFinite(intensityRaw) ? Math.min(1, Math.max(0, intensityRaw)) : 0.6;
  return {
    actorId: String(actorId || ''),
    mood,
    speech,
    intensity: Math.round(intensity * 100) / 100,
    speakTts: reaction?.speakTts !== false && speech.length > 0,
    ts: new Date().toISOString(),
  };
}

/**
 * Unified Co-Play Session Orchestrator:
 * Manages seats (human + 1..N Bots), turn authority, human takeover pause,
 * legal move enforcement, event log, and Galgame/TTS reaction dispatch.
 */
export class CoPlaySession {
  constructor({ sessionId, gameId, channel = 'structured_table', adapter, seats, maxTurns = 400 }) {
    if (!COPLAY_CHANNELS.includes(channel)) {
      throw new CoPlayError('INVALID_CHANNEL', `不支持的陪玩通道: ${channel}`);
    }
    if (!adapter || typeof adapter.getState !== 'function' || typeof adapter.applyMove !== 'function') {
      throw new CoPlayError('INVALID_ADAPTER', '游戏适配器缺少 getState / applyMove 接口');
    }
    if (!Array.isArray(seats) || seats.length < 1 || seats.length > 8) {
      throw new CoPlayError('INVALID_SEATS', '座位数量须在 1~8 之间');
    }
    this.protocolVersion = COPLAY_PROTOCOL_VERSION;
    this.sessionId = String(sessionId || `coplay-${Date.now()}`);
    this.gameId = String(gameId || adapter.gameId || 'unknown');
    this.channel = channel;
    this.adapter = adapter;
    this.seats = seats.map((s, idx) => ({
      seatId: String(s.seatId || `seat-${idx}`),
      kind: s.kind === 'human' ? 'human' : 'bot',
      botId: s.kind === 'human' ? null : String(s.botId || ''),
      displayName: String(s.displayName || s.botId || `Player ${idx + 1}`),
    }));
    this.maxTurns = Math.max(1, Math.min(5000, Number(maxTurns) || 400));
    this.pausedByHuman = false;
    this.turnCount = 0;
    this.events = [];
    this.reactions = [];
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
  }

  setHumanTakeover(paused) {
    this.pausedByHuman = Boolean(paused);
    this.events.push({
      type: this.pausedByHuman ? 'human_takeover_started' : 'human_takeover_released',
      ts: new Date().toISOString(),
    });
  }

  observeFor(seatId) {
    const seat = this.seats.find((s) => s.seatId === seatId);
    if (!seat) throw new CoPlayError('UNKNOWN_SEAT', `未知座位: ${seatId}`);
    const state = this.adapter.getState(seatId);
    const legalMoves = typeof this.adapter.getLegalMoves === 'function' ? this.adapter.getLegalMoves(seatId) : null;
    return {
      protocolVersion: this.protocolVersion,
      sessionId: this.sessionId,
      gameId: this.gameId,
      channel: this.channel,
      seat,
      pausedByHuman: this.pausedByHuman,
      turnCount: this.turnCount,
      state,
      legalMoves,
      recentReactions: this.reactions.slice(-6),
    };
  }

  submitAction(seatId, move, reaction = null) {
    const seat = this.seats.find((s) => s.seatId === seatId);
    if (!seat) throw new CoPlayError('UNKNOWN_SEAT', `未知座位: ${seatId}`);
    if (this.finishedAt) throw new CoPlayError('SESSION_FINISHED', '本局游戏已结束');
    if (seat.kind === 'bot' && this.pausedByHuman) {
      throw new CoPlayError('HUMAN_TAKEOVER_ACTIVE', '用户正在接管操作，Bot 行动已暂停');
    }
    if (this.turnCount >= this.maxTurns) {
      this.finishedAt = new Date().toISOString();
      throw new CoPlayError('TURN_LIMIT_EXCEEDED', '已达到单局最大回合上限');
    }

    const outcome = this.adapter.applyMove(seatId, move);
    this.turnCount += 1;
    const evt = {
      type: 'move',
      turn: this.turnCount,
      seatId,
      actorKind: seat.kind,
      move,
      summary: String(outcome?.summary || ''),
      ts: new Date().toISOString(),
    };
    this.events.push(evt);

    let normalizedReaction = null;
    if (reaction) {
      normalizedReaction = normalizeReaction(reaction, seat.botId || seat.seatId);
      this.reactions.push(normalizedReaction);
    }

    if (outcome?.finished) {
      this.finishedAt = new Date().toISOString();
      this.events.push({
        type: 'game_finished',
        winnerSeatId: outcome.winnerSeatId ?? null,
        draw: Boolean(outcome.draw),
        ts: this.finishedAt,
      });
    }

    return {
      ok: true,
      turn: this.turnCount,
      outcome,
      reaction: normalizedReaction,
      state: this.adapter.getState(seatId),
    };
  }

  exportRecap() {
    return {
      protocolVersion: this.protocolVersion,
      sessionId: this.sessionId,
      gameId: this.gameId,
      channel: this.channel,
      seats: this.seats,
      turnCount: this.turnCount,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      events: this.events,
      reactions: this.reactions,
    };
  }
}

/**
 * Reference Channel-A Structured Game Adapter: 15x15 Gomoku (五子棋)
 * Demonstrates deterministic rules, zero-hallucination legality enforcement,
 * compact LLM-friendly state serialization, and auto-suggested Bot reaction hints.
 */
export class GomokuAdapter {
  constructor({ size = 15, blackSeat = 'human', whiteSeat = 'bot' } = {}) {
    this.gameId = 'gomoku';
    this.size = Math.max(5, Math.min(19, Number(size) || 15));
    this.blackSeat = String(blackSeat);
    this.whiteSeat = String(whiteSeat);
    this.board = Array.from({ length: this.size }, () => Array(this.size).fill(0)); // 0=empty, 1=black, 2=white
    this.currentSeat = this.blackSeat;
    this.lastMove = null;
    this.winnerSeatId = null;
    this.draw = false;
    this.stonesPlaced = 0;
  }

  stoneFor(seatId) {
    if (seatId === this.blackSeat) return 1;
    if (seatId === this.whiteSeat) return 2;
    throw new CoPlayError('INVALID_SEAT', `非本局棋手: ${seatId}`);
  }

  getState() {
    const occupied = [];
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        if (this.board[r][c] !== 0) {
          occupied.push({ r, c, stone: this.board[r][c] === 1 ? 'B' : 'W' });
        }
      }
    }
    return {
      size: this.size,
      currentSeat: this.currentSeat,
      lastMove: this.lastMove,
      stonesPlaced: this.stonesPlaced,
      finished: Boolean(this.winnerSeatId || this.draw),
      winnerSeatId: this.winnerSeatId,
      draw: this.draw,
      occupied,
    };
  }

  getLegalMoves(seatId) {
    if (this.winnerSeatId || this.draw || seatId !== this.currentSeat) return [];
    const moves = [];
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        if (this.board[r][c] === 0) moves.push({ r, c });
      }
    }
    return moves;
  }

  checkWin(r, c, stone) {
    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (const [dr, dc] of dirs) {
      let count = 1;
      for (const sign of [1, -1]) {
        let nr = r + dr * sign;
        let nc = c + dc * sign;
        while (nr >= 0 && nr < this.size && nc >= 0 && nc < this.size && this.board[nr][nc] === stone) {
          count += 1;
          nr += dr * sign;
          nc += dc * sign;
        }
      }
      if (count >= 5) return true;
    }
    return false;
  }

  applyMove(seatId, move) {
    if (this.winnerSeatId || this.draw) {
      throw new CoPlayError('GAME_OVER', '棋局已结束');
    }
    if (seatId !== this.currentSeat) {
      throw new CoPlayError('NOT_YOUR_TURN', `当前轮到 ${this.currentSeat} 落子`);
    }
    const r = Number(move?.r);
    const c = Number(move?.c);
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= this.size || c < 0 || c >= this.size) {
      throw new CoPlayError('OUT_OF_BOUNDS', `落子坐标越界: (${move?.r}, ${move?.c})`);
    }
    if (this.board[r][c] !== 0) {
      throw new CoPlayError('CELL_OCCUPIED', `位置 (${r}, ${c}) 已有棋子`);
    }
    const stone = this.stoneFor(seatId);
    this.board[r][c] = stone;
    this.stonesPlaced += 1;
    this.lastMove = { r, c, seatId, stone: stone === 1 ? 'B' : 'W' };

    if (this.checkWin(r, c, stone)) {
      this.winnerSeatId = seatId;
      return { finished: true, winnerSeatId: seatId, draw: false, summary: `${seatId} 在 (${r},${c}) 五连获胜` };
    }
    if (this.stonesPlaced >= this.size * this.size) {
      this.draw = true;
      return { finished: true, winnerSeatId: null, draw: true, summary: '棋盘已满，双方和棋' };
    }
    this.currentSeat = seatId === this.blackSeat ? this.whiteSeat : this.blackSeat;
    return { finished: false, winnerSeatId: null, draw: false, summary: `${seatId} 落子 (${r},${c})` };
  }
}
