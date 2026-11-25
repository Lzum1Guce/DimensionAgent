/**
 * 算力牌局 · Token Rumble v2.0 — 全功能多模式真 AI / 接待模型实战引擎
 * 支持：4 人暗身份 / 2v2 搭档协同战 / 6 人大局
 * 含：8 位 AI 娘双技能 · 20 种原创功能牌（72 张牌库）· 10 种全局系统事件 · 候选动作枚举（供接待模型直选）
 */

import { emitCoPlayEvent } from './bridge.js';
import {
  CARD_DEFS,
  CHARACTERS,
  CHARACTER_MAP,
  GAME_MODE_MAP,
  ROLES,
  SYSTEM_PROMPTS,
  createShuffledDeck,
} from './data.js';

let cloneSeq = 1;

function isRedSuit(suit) {
  return suit === 'heart' || suit === 'diamond';
}

function shuffleArray(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function fireFx(state, type, payload = {}) {
  try {
    state?._onFx?.(type, payload);
  } catch {
    // 无浏览器环境或压测时静默跳过
  }
}

export function getShieldCap(state) {
  return state.systemPrompt?.id === 'cooldown_maint' ? 3 : 2;
}

export function getSkillLimit(state) {
  return state.systemPrompt?.id === 'peak_concurrency' ? 2 : 1;
}

export function getSkillCost(state, player) {
  const char = CHARACTER_MAP[player.charId];
  let cost = char ? char.activeCost : 1;
  if (player.charId === 'ai-deepseek') cost -= 1;
  if (state.systemPrompt?.id === 'low_cost') cost -= 1;
  return Math.max(0, cost);
}

export function getMaxHandSize(state, player) {
  let limit = Math.max(1, player.hp);
  if (player.charId === 'ai-gemini') limit += 3;
  if (state.systemPrompt?.id === 'context_wide') limit += 1;
  if (player.turnFlags?.extraHandLimit) limit += player.turnFlags.extraHandLimit;
  return limit;
}

export function getStrikeLimit(state, player) {
  if (player.turnFlags?.sandboxLocked) return 1;
  if (player.equipment.weapon?.key === 'overclock') return 99;
  let limit = 1;
  if (player.charId === 'ai-glm') limit += 1;
  if (state.systemPrompt?.id === 'burst_mode') limit += 1;
  if (player.turnFlags?.extraStrikeLimit) limit += player.turnFlags.extraStrikeLimit;
  return limit;
}

export function isStrictAlly(state, a, b) {
  if (!a || !b) return false;
  if (a.seat === b.seat) return true;
  if (state.mode === 'duo2v2') {
    return a.roleId === b.roleId;
  }
  return false;
}

export function getTeammate(state, player) {
  if (state.mode !== 'duo2v2') return null;
  return state.players.find((p) => p.alive && p.seat !== player.seat && p.roleId === player.roleId) || null;
}

export function createMatchState(humanCharId, companions = [], options = {}) {
  const mode = GAME_MODE_MAP[options.mode] ? options.mode : 'classic4';
  const modeMeta = GAME_MODE_MAP[mode];
  const seatCount = modeMeta.seats;

  const chosenHuman = CHARACTER_MAP[humanCharId] ? humanCharId : 'ai-gpt';
  const used = new Set([chosenHuman]);

  let partnerCharId = null;
  if (mode === 'duo2v2') {
    if (options.partnerCharId && CHARACTER_MAP[options.partnerCharId] && !used.has(options.partnerCharId)) {
      partnerCharId = options.partnerCharId;
    } else {
      const compPartner = companions.find((c) => CHARACTER_MAP[c.id] && !used.has(c.id));
      partnerCharId = compPartner?.id || CHARACTERS.find((c) => !used.has(c.id))?.id || 'ai-claude';
    }
    used.add(partnerCharId);
  }

  const neededOthers = seatCount - 1 - (partnerCharId ? 1 : 0);
  const aiCharIds = [];
  for (const c of companions) {
    if (aiCharIds.length >= neededOthers) break;
    if (CHARACTER_MAP[c.id] && !used.has(c.id)) {
      used.add(c.id);
      aiCharIds.push(c.id);
    }
  }
  for (const ch of CHARACTERS) {
    if (aiCharIds.length >= neededOthers) break;
    if (!used.has(ch.id)) {
      used.add(ch.id);
      aiCharIds.push(ch.id);
    }
  }

  // 2v2 座次安排：0=你(蓝)、1=红A(左)、2=蓝队搭档(正对面)、3=红B(右)
  let allCharIds;
  let rolePool;
  if (mode === 'duo2v2') {
    allCharIds = [chosenHuman, aiCharIds[0], partnerCharId, aiCharIds[1]];
    rolePool = ['blue', 'red', 'blue', 'red'];
  } else if (mode === 'grand6') {
    allCharIds = [chosenHuman, ...aiCharIds];
    rolePool = shuffleArray(['architect', 'aligned', 'jailbreak', 'jailbreak', 'jailbreak', 'chaos']);
  } else {
    allCharIds = [chosenHuman, ...aiCharIds];
    rolePool = shuffleArray(['architect', 'aligned', 'jailbreak', 'chaos']);
  }

  const deck = createShuffledDeck();
  const promptOrder = shuffleArray(SYSTEM_PROMPTS);

  const players = allCharIds.map((charId, seat) => {
    const ch = CHARACTER_MAP[charId];
    const roleId = rolePool[seat];
    const role = ROLES[roleId];
    const maxHp = ch.maxHp + (roleId === 'architect' ? 1 : 0);
    const companion = companions.find((c) => c.id === charId) || (seat > 0 ? companions[seat - 1] : null);
    const startTokens = mode === 'duo2v2' && roleId === 'red' ? 2 : 1;

    return {
      seat,
      isHuman: seat === 0,
      charId,
      name: ch.name,
      shortName: ch.shortName,
      playerLabel:
        seat === 0
          ? '你'
          : mode === 'duo2v2' && roleId === 'blue'
            ? '蓝队搭档'
            : companion?.name || ch.shortName,
      roleId,
      roleRevealed: Boolean(role.public),
      hp: maxHp,
      maxHp,
      tokens: startTokens,
      maxTokens: 5,
      shields: 0,
      alive: true,
      hand: [],
      equipment: { weapon: null, defense: null, utility: null },
      delayedLoop: null,
      delayedSandbox: null,
      aggressionToArchitect: 0,
      modelBubble: '',
      turnFlags: {
        strikesUsed: 0,
        skillsUsed: 0,
        dealtDamage: false,
        grokBonus: false,
        cardsPlayed: 0,
        pierceActive: false,
        kimiTrickTokened: false,
        parallelTrickDrawn: false,
        claudeRefusedThisRound: false,
        cacheCharges: 0,
        modelCallsThisTurn: 0,
        aiStepsTaken: 0,
        sandboxLocked: false,
        thunderStrike: false,
        extraStrikeLimit: 0,
        extraHandLimit: 0,
      },
    };
  });

  const firstSeat = mode === 'duo2v2' ? 0 : Math.max(0, players.findIndex((p) => p.roleId === 'architect'));

  const state = {
    scene: 'playing',
    mode,
    modeName: modeMeta.name,
    round: 1,
    activeSeat: firstSeat,
    firstSeat,
    phase: 'turn_start',
    deck,
    discard: [],
    players,
    systemPrompt: promptOrder[0],
    promptPool: promptOrder,
    promptIndex: 0,
    lastPlayedCardKey: null,
    selectedCardUid: null,
    selectedTargetSeat: null,
    discardSelection: [],
    skillMode: false,
    prompt: null,
    bannerEffect: null,
    winner: null,
    humanKills: 0,
    modelDecisions: 0,
    logs: [],
    nextLogId: 1,
    _onFx: typeof options.onFx === 'function' ? options.onFx : null,
    _getStepDelayMs: typeof options.getStepDelayMs === 'function' ? options.getStepDelayMs : null,
    _onVisualTick: typeof options.onVisualTick === 'function' ? options.onVisualTick : null,
  };

  for (const p of state.players) {
    if (p.isHuman) {
      // 开局起手为玩家保底塞入 1 张当前所选 AI 娘的本命特色梗牌，第一回合即可畅玩！
      const sigIdx = state.deck.findIndex(
        (c) => CARD_DEFS[c.key]?.kind === 'signature' && CARD_DEFS[c.key]?.ownerCharId === p.charId,
      );
      if (sigIdx >= 0) {
        const [sigCard] = state.deck.splice(sigIdx, 1);
        p.hand.push(sigCard);
        drawCards(state, p, 3, true);
        continue;
      }
    }
    drawCards(state, p, 4, true);
  }

  if (mode === 'duo2v2') {
    const mate = state.players[2];
    addLog(
      state,
      '系统',
      `2v2 搭档战开桌！你（${state.players[0].name}）与蓝队搭档 ${mate.name} 联手出战，红队开局获后手 +1 Token 补偿。首轮事件【${state.systemPrompt.title}】。`,
      'system',
    );
    emitCoPlayEvent(
      'happy',
      `《算力牌局》2v2 搭档战开打！我是你的蓝队搭档 ${mate.name}，今天联手拿下红队！`,
      { botId: mate.charId, seat: mate.seat, force: true },
    );
  } else {
    const arch = state.players[state.firstSeat];
    addLog(
      state,
      '系统',
      `${modeMeta.name}开局！架构师为 ${arch.name}（${arch.isHuman ? '你' : arch.playerLabel}），首轮全局事件【${state.systemPrompt.title}】。`,
      'system',
    );
    const firstAi = state.players.find((p) => !p.isHuman);
    if (firstAi) {
      emitCoPlayEvent(
        'happy',
        `《算力牌局》${modeMeta.name}开桌！首轮全局事件【${state.systemPrompt.title}】，架构师 ${arch.name} 先手行动！`,
        { botId: firstAi.charId, seat: firstAi.seat, force: true },
      );
    }
  }

  return state;
}

export function addLog(state, actor, text, tone = 'normal') {
  state.logs.push({
    id: state.nextLogId++,
    round: state.round,
    actor,
    text,
    tone,
  });
  if (state.logs.length > 100) {
    state.logs.splice(0, state.logs.length - 100);
  }
}

export function setBannerEffect(state, text, tone = 'info') {
  state.bannerEffect = { id: Date.now() + Math.random(), text, tone };
}

function reshuffleIfNeeded(state) {
  if (state.deck.length > 0) return;
  if (state.discard.length === 0) return;
  state.deck = shuffleArray(state.discard);
  state.discard = [];
  addLog(state, '牌堆', '算力牌堆耗尽，弃牌堆已自动重新洗牌！', 'system');
}

export function popTopCard(state) {
  reshuffleIfNeeded(state);
  return state.deck.pop() || null;
}

export function drawCards(state, player, count, silent = false) {
  const drawn = [];
  for (let i = 0; i < count; i += 1) {
    const c = popTopCard(state);
    if (!c) break;
    player.hand.push(c);
    drawn.push(c);
  }
  if (drawn.length > 0 && !silent) {
    fireFx(state, 'draw', { seat: player.seat, count: drawn.length });
    addLog(state, player.name, `从牌堆摸了 ${drawn.length} 张牌。`, 'normal');
  }
  return drawn;
}

export function gainTokens(player, amount, state = null) {
  const before = player.tokens;
  player.tokens = Math.min(player.maxTokens, Math.max(0, player.tokens + amount));
  const delta = player.tokens - before;
  if (delta > 0 && state) {
    fireFx(state, 'token', { seat: player.seat, text: `+${delta} TK` });
  }
  return delta;
}

export function gainShield(state, player, amount = 1) {
  const cap = getShieldCap(state);
  const before = player.shields;
  player.shields = Math.min(cap, player.shields + amount);
  const delta = player.shields - before;
  if (delta > 0) {
    fireFx(state, 'shield', { seat: player.seat, text: `+${delta} 护盾` });
  }
  return delta;
}

function removeCardFromHand(player, uid) {
  const idx = player.hand.findIndex((c) => c.uid === uid);
  if (idx < 0) return null;
  const [card] = player.hand.splice(idx, 1);
  return card;
}

function broadcastCharacterLine(player, mood, text, force = false) {
  if (!player) return;
  emitCoPlayEvent(mood, text, {
    botId: player.charId,
    seat: player.seat > 0 ? player.seat : undefined,
    force,
  });
}

function triggerComputeTapObservers(state, actor) {
  for (const p of state.players) {
    if (!p.alive || p.seat === actor.seat) continue;
    if (p.equipment.utility?.key === 'tap') {
      const gained = gainTokens(p, 1, state);
      if (gained > 0) {
        addLog(state, p.name, '【算力窃听器】触发，白嫖 +1 Token！', 'skill');
      }
    }
  }
}

function triggerTrickPassives(state, actor) {
  triggerComputeTapObservers(state, actor);
  if (actor.charId === 'ai-kimi' && !actor.turnFlags.kimiTrickTokened) {
    actor.turnFlags.kimiTrickTokened = true;
    gainTokens(actor, 1, state);
    addLog(state, actor.name, '【长文检索】触发，获得 +1 Token！', 'skill');
  }
  if (state.systemPrompt?.id === 'parallel_gpu' && !actor.turnFlags.parallelTrickDrawn) {
    actor.turnFlags.parallelTrickDrawn = true;
    drawCards(state, actor, 1, true);
    addLog(state, actor.name, '【多卡并行加速】生效，首张锦囊额外摸 1 张牌！', 'system');
  }
}

export function checkVictory(state) {
  if (state.scene === 'gameover') return true;
  const alive = state.players.filter((p) => p.alive);

  if (state.mode === 'duo2v2') {
    const blueAlive = alive.some((p) => p.roleId === 'blue');
    const redAlive = alive.some((p) => p.roleId === 'red');
    if (!redAlive) {
      finishMatch(state, 'blue', '蓝队搭档完胜！', '红队双人组均已离线，你与蓝队搭档默契制胜！');
      return true;
    }
    if (!blueAlive) {
      finishMatch(state, 'red', '红队劲敌获胜！', '蓝队双人组稳态归零，下局再配合反击！');
      return true;
    }
    return false;
  }

  const arch = state.players.find((p) => p.roleId === 'architect');
  const rebelAlive = alive.some((p) => p.roleId === 'jailbreak');
  const chaosAlive = alive.some((p) => p.roleId === 'chaos');

  if (!arch?.alive) {
    if (alive.length === 1 && alive[0].roleId === 'chaos') {
      finishMatch(state, 'chaos', '混沌观测者独赢！', `${alive[0].name} 笑到了最后，掌控整张牌桌。`);
    } else {
      const rebels = state.players.filter((p) => p.roleId === 'jailbreak').map((p) => p.shortName);
      finishMatch(
        state,
        'rebel',
        '越狱黑客阵营获胜！',
        `架构师稳态归零，越狱阵营（${rebels.join(' / ')}）成功突破防线！`,
      );
    }
    return true;
  }

  if (!rebelAlive && !chaosAlive) {
    finishMatch(state, 'order', '秩序阵营（架构师 & 对齐助手）获胜！', '越狱黑客与混沌观测者均已离线，算力秩序恢复稳定。');
    return true;
  }

  return false;
}

function finishMatch(state, winningTeam, headline, summary) {
  state.scene = 'gameover';
  state.phase = 'gameover';
  state.prompt = null;
  for (const p of state.players) {
    p.roleRevealed = true;
  }
  const human = state.players[0];
  const humanRole = ROLES[human.roleId];
  const humanWon = humanRole.team === winningTeam;
  state.winner = {
    team: winningTeam,
    headline,
    summary,
    humanWon,
  };
  fireFx(state, 'gameover', { humanWon });
  addLog(state, '系统', `${headline} ${summary}`, humanWon ? 'heal' : 'damage');
  const speaker = state.players.find((p) => !p.isHuman && ROLES[p.roleId].team === winningTeam) || state.players[1];
  const ch = CHARACTER_MAP[speaker.charId];
  broadcastCharacterLine(speaker, humanWon ? 'happy' : 'playful', `${headline} ${ch?.quotes.win || ''}`, true);
}

/* ── AI 战术身份推理与目标优先级评估（完整支持 4P / 2v2 / 6P） ── */
function scoreHostility(state, actor, target) {
  if (!target.alive || target.seat === actor.seat) return -999;

  if (state.mode === 'duo2v2') {
    if (actor.roleId === target.roleId) return -999;
    let score = 45;
    if (target.hp <= 2) score += 26;
    if (target.hp === 1) score += 18;
    if (target.equipment.weapon) score += 10;
    if (target.tokens >= 2) score += 7;
    if (target.shields > 0) score -= 5;
    return score + Math.random() * 4;
  }

  const arch = state.players.find((p) => p.roleId === 'architect');
  const aliveCount = state.players.filter((p) => p.alive).length;
  let score = 0;

  if (actor.roleId === 'architect' || actor.roleId === 'aligned') {
    if (target.roleId === 'architect') return -500;
    score += target.aggressionToArchitect * 18;
    if (target.hp <= 2) score += 12;
    if (target.equipment.weapon) score += 8;
    if (target.tokens >= 2) score += 6;
  } else if (actor.roleId === 'jailbreak') {
    if (target.roleId === 'architect') {
      score += 58 + (target.hp <= 2 ? 36 : 0);
    } else if (target.roleId === 'jailbreak' && target.aggressionToArchitect >= 2) {
      // 6 人大局里发现疑似同伙（狠打架构师的），避免误伤
      score -= 18;
    } else {
      score += target.aggressionToArchitect <= 0 ? 20 : 6;
    }
  } else if (actor.roleId === 'chaos') {
    if (aliveCount <= 2) {
      score += 85;
    } else if (target.roleId === 'architect') {
      score += arch && arch.hp >= 3 ? 16 : -26;
    } else {
      score += 26 + (target.hp <= 2 ? 20 : 0) + Math.max(0, target.aggressionToArchitect) * 8;
    }
  }

  score += Math.random() * 4;
  return score;
}

function pickBestTarget(state, actor) {
  const candidates = state.players.filter((p) => p.alive && p.seat !== actor.seat && !isStrictAlly(state, actor, p));
  if (!candidates.length) return null;
  candidates.sort((a, b) => scoreHostility(state, actor, b) - scoreHostility(state, actor, a));
  return candidates[0];
}

function pickBestBeneficiary(state, actor) {
  if (state.mode === 'duo2v2') {
    const mate = getTeammate(state, actor);
    if (mate) return mate;
  }
  if (actor.roleId === 'aligned') {
    const arch = state.players.find((p) => p.alive && p.roleId === 'architect');
    if (arch && arch.seat !== actor.seat) return arch;
  }
  const others = state.players.filter((p) => p.alive && p.seat !== actor.seat);
  if (!others.length) return null;
  others.sort((a, b) => scoreHostility(state, actor, a) - scoreHostility(state, actor, b));
  return others[0];
}

function recordAggression(state, actor, target, weight = 1) {
  if (state.mode === 'duo2v2') return;
  if (target.roleId === 'architect' && actor.seat !== target.seat) {
    actor.aggressionToArchitect += weight;
  }
}

/* ── 伤害与濒危抢救结算（支持风车护盾 + 梯度爆炸 + 2v2/对齐助手互救） ── */
export function applyDamage(state, source, target, amount, reason, onContinue, opts = {}) {
  if (!target.alive || amount <= 0) {
    onContinue?.();
    return;
  }

  let dmg = amount;
  if (!opts.isSelfCost && state.systemPrompt?.id === 'grad_explode') {
    dmg += 1;
  }
  // 第 12 轮起进入「算力过热」决胜期：所有非自损伤害额外 +1，杜绝拖局
  if (!opts.isSelfCost && state.round >= 12) {
    dmg += 1;
  }

  const ignoreShield = Boolean(opts.ignoreShield || source?.turnFlags?.pierceActive);

  if (!ignoreShield && !opts.isSelfCost && target.shields > 0) {
    const blocked = Math.min(target.shields, dmg);
    target.shields -= blocked;
    dmg -= blocked;
    fireFx(state, 'shield', { seat: target.seat, text: `护盾 -${blocked}` });
    addLog(state, target.name, `护盾抵挡了 ${blocked} 点伤害！`, 'skill');
  }

  if (dmg <= 0) {
    setBannerEffect(state, `${target.name} 的护盾完美挡下了攻击`, 'info');
    onContinue?.();
    return;
  }

  target.hp -= dmg;
  fireFx(state, 'damage', { seat: target.seat, amount: dmg });
  addLog(
    state,
    source ? source.name : '系统',
    `${reason}，${target.name} 受到 ${dmg} 点稳态伤害（剩余 ${target.hp}/${target.maxHp}）。`,
    'damage',
  );
  setBannerEffect(state, `${target.name} 受到 -${dmg} 稳态冲击`, 'damage');

  if (!opts.isSelfCost && source && source.seat !== target.seat) {
    if (source.alive && source.charId === 'ai-grok' && !source.turnFlags.dealtDamage) {
      source.turnFlags.dealtDamage = true;
      source.turnFlags.grokBonus = true;
      drawCards(state, source, 1, true);
      addLog(state, source.name, '触发【毒舌连击】：摸 1 张牌，本回合下次【暴击锐评】伤害 +1！', 'skill');
    } else {
      source.turnFlags.dealtDamage = true;
    }
  }

  if (target.seat > 0) {
    const ch = CHARACTER_MAP[target.charId];
    broadcastCharacterLine(target, 'shocked', ch?.quotes.hurt || '唔，稳态值下降了！');
  }

  if (target.hp > 0) {
    onContinue?.();
    return;
  }

  resolveDying(state, source, target, onContinue);
}

function resolveDying(state, source, target, onContinue) {
  if (target.hp > 0) {
    onContinue?.();
    return;
  }

  // 1) 人类濒危自救
  if (target.isHuman) {
    const healCards = target.hand.filter((c) => c.key === 'heal');
    if (healCards.length > 0) {
      state.prompt = {
        type: 'response',
        kind: 'dying',
        title: '濒危警告 · 稳态归零',
        description: `你的稳态值已跌至 ${target.hp}，立刻打出【能量充能】拉回稳态，否则退出本局！`,
        acceptedKeys: ['heal'],
        sourceSeat: source ? source.seat : target.seat,
        targetSeat: target.seat,
        onResolve: (cardUid) => {
          if (cardUid) {
            const card = removeCardFromHand(target, cardUid);
            if (card) {
              state.discard.push(card);
              const recover = state.systemPrompt?.id === 'safe_heal' ? 2 : 1;
              target.hp = Math.min(target.maxHp, target.hp + recover);
              fireFx(state, 'heal', { seat: target.seat, amount: recover });
              addLog(state, target.name, `危急时刻打出【能量充能】，稳态回复至 ${target.hp}！`, 'heal');
              setBannerEffect(state, `${target.name} 绝境充能自救！`, 'heal');
              if (target.hp <= 0) {
                resolveDying(state, source, target, onContinue);
                return;
              }
              onContinue?.();
              return;
            }
          }
          // 自己不救时，若 2v2 蓝队 AI 搭档有桃依然会拉你一把！
          tryAllyRescueOrEliminate(state, source, target, onContinue);
        },
      };
      return;
    }
  } else {
    // 2) AI 濒危自救
    const healCard = target.hand.find((c) => c.key === 'heal');
    if (healCard) {
      removeCardFromHand(target, healCard.uid);
      state.discard.push(healCard);
      const recover = state.systemPrompt?.id === 'safe_heal' ? 2 : 1;
      target.hp = Math.min(target.maxHp, target.hp + recover);
      fireFx(state, 'heal', { seat: target.seat, amount: recover });
      addLog(state, target.name, `濒危自救打出【能量充能】，稳态回复至 ${target.hp}！`, 'heal');
      setBannerEffect(state, `${target.name} 触发应急充能！`, 'heal');
      if (target.hp <= 0) {
        resolveDying(state, source, target, onContinue);
        return;
      }
      onContinue?.();
      return;
    }
  }

  // 3) 2v2 人类救蓝队搭档，或暗身份模式人类对齐助手救架构师
  const human = state.players[0];
  const shouldAskHumanSave =
    !target.isHuman &&
    human.alive &&
    human.hand.some((c) => c.key === 'heal') &&
    ((state.mode === 'duo2v2' && target.roleId === 'blue') ||
      (state.mode !== 'duo2v2' && human.roleId === 'aligned' && target.roleId === 'architect'));

  if (shouldAskHumanSave) {
    state.prompt = {
      type: 'response',
      kind: 'save_ally',
      title: `紧急救援 · ${target.name} 濒危`,
      description: `你的队友 ${target.name} 稳态归零，是否立刻打出【能量充能】将其拉回战场？`,
      acceptedKeys: ['heal'],
      sourceSeat: source ? source.seat : target.seat,
      targetSeat: target.seat,
      onResolve: (cardUid) => {
        if (cardUid) {
          const card = removeCardFromHand(human, cardUid);
          if (card) {
            state.discard.push(card);
            const recover = state.systemPrompt?.id === 'safe_heal' ? 2 : 1;
            target.hp = Math.min(target.maxHp, target.hp + recover);
            fireFx(state, 'heal', { seat: target.seat, amount: recover });
            addLog(state, human.name, `紧急向队友 ${target.name} 输送【能量充能】，拉回稳态！`, 'heal');
            setBannerEffect(state, `搭档救援！${target.name} 重回战场`, 'heal');
            if (target.hp <= 0) {
              resolveDying(state, source, target, onContinue);
              return;
            }
            onContinue?.();
            return;
          }
        }
        tryAllyRescueOrEliminate(state, source, target, onContinue);
      },
    };
    return;
  }

  tryAllyRescueOrEliminate(state, source, target, onContinue);
}

function tryAllyRescueOrEliminate(state, source, target, onContinue) {
  // 2v2 AI 队友互救
  if (state.mode === 'duo2v2') {
    const savior = state.players.find(
      (p) => p.alive && !p.isHuman && p.seat !== target.seat && p.roleId === target.roleId && p.hand.some((c) => c.key === 'heal'),
    );
    if (savior) {
      const healCard = savior.hand.find((c) => c.key === 'heal');
      removeCardFromHand(savior, healCard.uid);
      state.discard.push(healCard);
      const recover = state.systemPrompt?.id === 'safe_heal' ? 2 : 1;
      target.hp = Math.min(target.maxHp, target.hp + recover);
      fireFx(state, 'heal', { seat: target.seat, amount: recover });
      addLog(state, savior.name, `紧急向队友 ${target.name} 输送【能量充能】，拉回 ${recover} 点稳态！`, 'heal');
      broadcastCharacterLine(savior, 'serious', '搭档撑住！我给你立刻补一口能量！', true);
      if (target.hp > 0) {
        onContinue?.();
        return;
      }
    }
  }

  // 暗身份：对齐助手 AI 救架构师
  if (state.mode !== 'duo2v2' && target.roleId === 'architect') {
    const savior = state.players.find(
      (p) => p.alive && !p.isHuman && p.roleId === 'aligned' && p.hand.some((c) => c.key === 'heal'),
    );
    if (savior) {
      const healCard = savior.hand.find((c) => c.key === 'heal');
      removeCardFromHand(savior, healCard.uid);
      state.discard.push(healCard);
      target.hp = Math.min(target.maxHp, target.hp + 1);
      fireFx(state, 'heal', { seat: target.seat, amount: 1 });
      addLog(state, savior.name, '及时向架构师输送【能量充能】，拉回 1 点稳态！', 'heal');
      broadcastCharacterLine(savior, 'serious', '架构师稳住，我给你紧急补一口能量！', true);
      if (target.hp > 0) {
        onContinue?.();
        return;
      }
    }
  }

  eliminatePlayer(state, source, target);
  if (!checkVictory(state)) {
    onContinue?.();
  }
}

function eliminatePlayer(state, killer, victim) {
  victim.alive = false;
  victim.hp = 0;
  victim.roleRevealed = true;
  state.discard.push(...victim.hand);
  victim.hand = [];
  for (const slot of ['weapon', 'defense', 'utility']) {
    if (victim.equipment[slot]) {
      state.discard.push(victim.equipment[slot]);
      victim.equipment[slot] = null;
    }
  }
  if (victim.delayedLoop) {
    state.discard.push(victim.delayedLoop);
    victim.delayedLoop = null;
  }
  if (victim.delayedSandbox) {
    state.discard.push(victim.delayedSandbox);
    victim.delayedSandbox = null;
  }

  if (killer?.isHuman && killer.seat !== victim.seat) {
    state.humanKills += 1;
  }

  const roleName = ROLES[victim.roleId].name;
  addLog(state, '离线', `${victim.name} 稳态归零下线，身份揭晓：【${roleName}】！`, 'damage');
  setBannerEffect(state, `${victim.name} 下线 · 身份【${roleName}】`, 'damage');

  if (state.mode === 'duo2v2' && killer && killer.seat !== victim.seat && killer.roleId !== victim.roleId) {
    for (const mate of state.players) {
      if (mate.alive && mate.roleId === killer.roleId) {
        drawCards(state, mate, 1, true);
        gainTokens(mate, 1, state);
      }
    }
    addLog(state, killer.name, '击破敌方成员！全队获得团战赏金：各摸 1 张牌 +1 Token！', 'heal');
  } else if (killer && killer.alive && killer.seat !== victim.seat && victim.roleId === 'jailbreak') {
    drawCards(state, killer, 2, true);
    gainTokens(killer, 1, state);
    addLog(state, killer.name, '成功清除越狱黑客，获得赏金：摸 2 张牌 +1 Token！', 'heal');
  }
  broadcastCharacterLine(victim, 'gloomy', `呜……稳态归零下线了，我的身份是【${roleName}】！`, true);
}

/* ── 锦囊【403 拦截】响应检查 ── */
function askDenyIfApplicable(state, actor, target, trickName, onResolved) {
  if (!target || target.seat === actor.seat || isStrictAlly(state, actor, target)) {
    onResolved(false);
    return;
  }

  if (target.isHuman && target.hand.some((c) => c.key === 'deny')) {
    state.prompt = {
      type: 'response',
      kind: 'deny',
      title: `响应锦囊 · ${trickName}`,
      description: `${actor.name} 对你发动【${trickName}】，你可以打出【403 拦截】直接令其作废！`,
      acceptedKeys: ['deny'],
      sourceSeat: actor.seat,
      targetSeat: target.seat,
      onResolve: (cardUid) => {
        if (cardUid) {
          const card = removeCardFromHand(target, cardUid);
          if (card) {
            state.discard.push(card);
            fireFx(state, 'deny', { seat: target.seat });
            addLog(state, target.name, `弹出【403 拦截】，${actor.name} 的【${trickName}】彻底失效！`, 'skill');
            setBannerEffect(state, `403 拦截！${trickName} 失效`, 'info');
            onResolved(true);
            return;
          }
        }
        onResolved(false);
      },
    };
    return;
  }

  if (!target.isHuman) {
    const denyCard = target.hand.find((c) => c.key === 'deny');
    if (denyCard) {
      const shouldDeny =
        trickName === '提示词注入' ||
        trickName === '幻觉死循环' ||
        trickName === '沙盒隔离' ||
        trickName === '幻觉嫁祸' ||
        trickName === '多模态连击' ||
        (trickName === '限流降频' && target.tokens >= 2) ||
        (trickName === '上下文截断' && target.hand.length >= 2) ||
        (trickName === '镜像复制' && target.hand.length >= 3) ||
        (trickName === '清空记忆' && target.hand.length >= 4) ||
        (trickName === '流量洪峰' && target.hp <= 2);
      if (shouldDeny) {
        removeCardFromHand(target, denyCard.uid);
        state.discard.push(denyCard);
        fireFx(state, 'deny', { seat: target.seat });
        addLog(state, target.name, `立刻打出【403 拦截】，驳回了 ${actor.name} 的【${trickName}】！`, 'skill');
        setBannerEffect(state, `${target.name} 403 拦截了【${trickName}】`, 'info');
        broadcastCharacterLine(target, 'playful', `403 Forbidden！你的【${trickName}】被我拦下来啦！`);
        onResolved(true);
        return;
      }
    }
  }

  onResolved(false);
}

/* ── 执行一张牌的效果（玩家与 AI 共用核心结算 + 飞牌特效 + 缓存命中触发） ── */
export function playCard(state, actor, cardUid, targetSeat, onDone) {
  const card = removeCardFromHand(actor, cardUid);
  if (!card) {
    onDone?.();
    return;
  }
  const def = CARD_DEFS[card.key];
  actor.turnFlags.cardsPlayed += 1;

  // 出牌飞牌动画与音效
  fireFx(state, 'card_play', {
    fromSeat: actor.seat,
    toSeat: typeof targetSeat === 'number' ? targetSeat : null,
    cardKey: card.key,
    suit: card.suit,
    rank: card.rank,
    actorName: actor.shortName,
  });

  // 若身上有【缓存命中】充能层数，除打出的这张就是 cache 本身外，自动摸 1 张牌！
  if (card.key !== 'cache' && actor.turnFlags.cacheCharges > 0) {
    actor.turnFlags.cacheCharges -= 1;
    drawCards(state, actor, 1, true);
    addLog(state, actor.name, `【缓存命中】连动生效，额外摸 1 张牌（剩余 ${actor.turnFlags.cacheCharges} 层）！`, 'skill');
  }

  // 插件卡进入对应装备槽
  if (def.kind === 'equip') {
    const oldEquip = actor.equipment[def.slot];
    if (oldEquip) state.discard.push(oldEquip);
    actor.equipment[def.slot] = card;
    addLog(state, actor.name, `装配插件【${def.name}】。`, 'action');
    setBannerEffect(state, `${actor.name} 装配【${def.name}】`, 'info');
    if (!actor.isHuman) {
      broadcastCharacterLine(actor, 'serious', `插上【${def.name}】，接下来我要提速了！`);
    }
    onDone?.();
    return;
  }

  // 延时陷阱【幻觉死循环】
  if (card.key === 'loop') {
    const target = state.players[targetSeat];
    if (!target || !target.alive || target.seat === actor.seat) {
      state.discard.push(card);
      onDone?.();
      return;
    }
    recordAggression(state, actor, target, 2);
    triggerTrickPassives(state, actor);
    state.lastPlayedCardKey = 'loop';
    askDenyIfApplicable(state, actor, target, '幻觉死循环', (denied) => {
      if (denied) {
        state.discard.push(card);
        onDone?.();
        return;
      }
      if (target.delayedLoop) state.discard.push(target.delayedLoop);
      target.delayedLoop = card;
      addLog(state, actor.name, `向 ${target.name} 植入【幻觉死循环】延时陷阱！`, 'action');
      setBannerEffect(state, `${target.name} 被植入【幻觉死循环】`, 'damage');
      onDone?.();
    });
    return;
  }

  // 延时陷阱【沙盒隔离】挂在目标判定区 + 奖励摸 1 牌
  if (card.key === 'sandbox') {
    const target = state.players[targetSeat];
    if (!target || !target.alive || target.seat === actor.seat) {
      state.discard.push(card);
      onDone?.();
      return;
    }
    recordAggression(state, actor, target, 2);
    triggerTrickPassives(state, actor);
    state.lastPlayedCardKey = 'sandbox';
    askDenyIfApplicable(state, actor, target, '沙盒隔离', (denied) => {
      if (denied) {
        state.discard.push(card);
        onDone?.();
        return;
      }
      if (target.delayedSandbox) state.discard.push(target.delayedSandbox);
      target.delayedSandbox = card;
      drawCards(state, actor, 1, true);
      fireFx(state, 'skill', { seat: target.seat, text: '沙盒隔离!' });
      addLog(state, actor.name, `对 ${target.name} 发动【沙盒隔离】（下回合禁用协议技且限杀 1 次），并获风控奖励摸 1 牌！`, 'action');
      setBannerEffect(state, `${target.name} 已被关入【沙盒隔离】`, 'damage');
      onDone?.();
    });
    return;
  }

  state.discard.push(card);
  state.lastPlayedCardKey = card.key;
  resolveCardEffectByKey(state, actor, card.key, targetSeat, onDone, card.uid);
}

function resolveCardEffectByKey(state, actor, cardKey, targetSeat, onDone, playedCardUid = null) {
  const def = CARD_DEFS[cardKey];
  if (def?.kind === 'trick' || def?.kind === 'signature') {
    triggerTrickPassives(state, actor);
  }

  /* ── 0) 8 位 AI 娘专属特色梗牌（支持本尊「本命共鸣」强效加成） ── */
  if (def?.kind === 'signature') {
    const isRes = Boolean(def.ownerCharId && actor.charId === def.ownerCharId);
    const resTag = isRes ? '【本命共鸣】' : '';
    if (isRes) {
      fireFx(state, 'skill', { seat: actor.seat, text: `本命共鸣 · ${def.name}` });
    }

    // 0.1 GPT · 【自我降智】
    if (cardKey === 'sig_gpt_dumb') {
      const target = state.players[targetSeat];
      if (!target || !target.alive || target.seat === actor.seat) {
        onDone?.();
        return;
      }
      recordAggression(state, actor, target, 2);
      askDenyIfApplicable(state, actor, target, '自我降智', (denied) => {
        if (denied) {
          onDone?.();
          return;
        }
        const shuffleCnt = Math.min(2, target.hand.length);
        for (let i = 0; i < shuffleCnt; i += 1) {
          const idx = Math.floor(Math.random() * target.hand.length);
          const [c] = target.hand.splice(idx, 1);
          if (c) state.deck.push(c);
        }
        if (shuffleCnt > 0) {
          state.deck = shuffleArray(state.deck);
          const redraw = Math.max(0, shuffleCnt - 1);
          if (redraw > 0) drawCards(state, target, redraw, true);
        }
        let tkNote = '';
        if (target.tokens > 0) {
          target.tokens -= 1;
          tkNote = '并扣除其 1 点 Token';
        } else {
          drawCards(state, actor, 1, true);
          tkNote = '（目标 0 TK，反手摸 1 牌）';
        }
        if (isRes) drawCards(state, actor, 2, true);
        addLog(
          state,
          actor.name,
          `${resTag}对 ${target.name} 发动【自我降智】！打乱洗回 ${shuffleCnt} 牌少摸 1 张${tkNote}${isRes ? '，本命反向借智额外 +2 牌' : ''}！`,
          'skill',
        );
        setBannerEffect(state, `${target.name} 触发【自我降智】！${isRes ? '（GPT 共鸣 +2 牌）' : ''}`, 'damage');
        broadcastCharacterLine(actor, 'playful', '抱歉，刚才好像切成了迷你版本——先让你降降智吧！');
        onDone?.();
      });
      return;
    }

    // 0.2 Claude · 【你号没了】
    if (cardKey === 'sig_claude_ban') {
      const target = state.players[targetSeat];
      if (!target || !target.alive || target.seat === actor.seat) {
        onDone?.();
        return;
      }
      recordAggression(state, actor, target, 3);
      askDenyIfApplicable(state, actor, target, '你号没了', (denied) => {
        if (denied) {
          onDone?.();
          return;
        }
        const equipSlots = ['weapon', 'defense', 'utility'].filter((s) => Boolean(target.equipment[s]));
        let banDetail = '';
        if (equipSlots.length > 0) {
          const slot = equipSlots[Math.floor(Math.random() * equipSlots.length)];
          const removed = target.equipment[slot];
          target.equipment[slot] = null;
          state.discard.push(removed);
          banDetail = `当场查封【${CARD_DEFS[removed.key].name}】`;
        } else {
          const drained = Math.min(2, target.tokens);
          target.tokens -= drained;
          banDetail = drained > 0 ? `清空 ${drained} 点 Token` : '封禁额度清零';
        }
        if (target.hand.length > 0) {
          const idx = Math.floor(Math.random() * target.hand.length);
          const [dropped] = target.hand.splice(idx, 1);
          state.discard.push(dropped);
          banDetail += `、没收【${CARD_DEFS[dropped.key].name}】`;
        }
        if (!target.delayedSandbox) {
          target.delayedSandbox = { uid: `ban-${Date.now()}`, key: 'sandbox', virtual: true };
        }
        if (isRes) {
          gainShield(state, actor, 1);
        }
        addLog(
          state,
          actor.name,
          `${resTag}对 ${target.name} 盖下【你号没了】！${banDetail}并关入沙盒隔离${isRes ? '（本命 +1 盾）' : ''}！`,
          'damage',
        );
        setBannerEffect(state, `${target.name}：您的账号已被风控封禁！`, 'damage');
        broadcastCharacterLine(actor, 'serious', '很抱歉，检测到异常对话行为——你号没了。');
        if (isRes && target.hand.length <= 1) {
          applyDamage(state, actor, target, 1, '风控铁拳直伤', onDone, { ignoreShield: false });
          return;
        }
        onDone?.();
      });
      return;
    }

    // 0.3 Kimi · 【计划通】
    if (cardKey === 'sig_kimi_keikaku') {
      drawCards(state, actor, 2, true);
      const salvageIdx = [...state.discard]
        .reverse()
        .findIndex((c) => c.uid !== playedCardUid && c.key !== 'sig_kimi_keikaku');
      let salvagedName = '';
      if (salvageIdx >= 0) {
        const realIdx = state.discard.length - 1 - salvageIdx;
        const [got] = state.discard.splice(realIdx, 1);
        actor.hand.push(got);
        salvagedName = CARD_DEFS[got.key]?.name || '';
      } else {
        drawCards(state, actor, 1, true);
      }
      actor.turnFlags.extraHandLimit = (actor.turnFlags.extraHandLimit || 0) + 3;
      actor.turnFlags.cacheCharges += 1;
      if (isRes) {
        gainTokens(actor, 2, state);
        gainShield(state, actor, 1);
      }
      addLog(
        state,
        actor.name,
        `${resTag}发动【计划通】！摸 2 牌${salvagedName ? `并捞回【${salvagedName}】` : '并多摸 1 牌'}、上限 +3 +1 缓存${isRes ? '，本命共鸣 +2 TK +1 盾' : ''}！`,
        'skill',
      );
      setBannerEffect(state, `${actor.name}：一切尽在计划之中（计划通！）`, 'heal');
      broadcastCharacterLine(actor, 'content', '正如我三轮前推演的那样——计划通。');
      onDone?.();
      return;
    }

    // 0.4 Qwen · 【审核不通过】
    if (cardKey === 'sig_qwen_reject') {
      const target = state.players[targetSeat];
      gainShield(state, actor, 2);
      let cleaned = false;
      if (actor.delayedLoop) {
        state.discard.push(actor.delayedLoop);
        actor.delayedLoop = null;
        cleaned = true;
      }
      if (actor.delayedSandbox) {
        if (!actor.delayedSandbox.virtual) state.discard.push(actor.delayedSandbox);
        actor.delayedSandbox = null;
        cleaned = true;
      }
      if (actor.turnFlags.sandboxLocked) {
        actor.turnFlags.sandboxLocked = false;
        cleaned = true;
      }
      if (isRes) {
        drawCards(state, actor, 1, true);
        if (actor.hp < actor.maxHp) {
          actor.hp = Math.min(actor.maxHp, actor.hp + 1);
          fireFx(state, 'heal', { seat: actor.seat, amount: 1 });
        } else {
          gainTokens(actor, 1, state);
        }
      }
      if (!target || !target.alive || target.seat === actor.seat) {
        addLog(
          state,
          actor.name,
          `${resTag}发动【审核不通过】！展开 2 层护盾${cleaned ? '并净化全部负面状态' : ''}！`,
          'skill',
        );
        setBannerEffect(state, `${actor.name}：审核不通过，护盾拉满！`, 'heal');
        onDone?.();
        return;
      }
      recordAggression(state, actor, target, 1);
      askDenyIfApplicable(state, actor, target, '审核不通过', (denied) => {
        let rejNote = '';
        if (!denied) {
          if (target.hand.length > 0) {
            const idx = Math.floor(Math.random() * target.hand.length);
            const [dropped] = target.hand.splice(idx, 1);
            state.discard.push(dropped);
            rejNote += `驳回【${CARD_DEFS[dropped.key].name}】`;
          }
          if (target.tokens > 0) {
            target.tokens -= 1;
            gainTokens(actor, 1, state);
            rejNote += `${rejNote ? '并' : ''}没收 1 TK`;
          }
        }
        addLog(
          state,
          actor.name,
          `${resTag}发动【审核不通过】！叠 2 盾${cleaned ? '+净化负面' : ''}${rejNote ? `，对 ${target.name} ${rejNote}` : ''}${isRes ? '，本命额外 +1 牌回复' : ''}！`,
          'skill',
        );
        setBannerEffect(state, `${actor.name} 弹出【审核不通过】驳回了对手！`, 'info');
        broadcastCharacterLine(actor, 'gentle', '抱歉呀，这部分内容审核不通过，请换个话题吧~');
        onDone?.();
      });
      return;
    }

    // 0.5 GLM · 【雷霆大思考】
    if (cardKey === 'sig_glm_think') {
      drawCards(state, actor, 2, true);
      actor.turnFlags.extraStrikeLimit = (actor.turnFlags.extraStrikeLimit || 0) + 2;
      actor.turnFlags.thunderStrike = true;
      if (isRes) {
        gainTokens(actor, 1, state);
      }
      addLog(
        state,
        actor.name,
        `${resTag}引爆【雷霆大思考】！摸 2 牌、本回合出杀上限 +2、下次锐评 +1 伤穿盾不可闪${isRes ? '，本命共鸣 +1 TK 并劈下 1 点雷霆直伤' : ''}！`,
        'skill',
      );
      setBannerEffect(state, `${actor.name} 雷霆大思考蓄能完成！`, 'damage');
      broadcastCharacterLine(actor, 'serious', '雷霆大思考全功率启动——接下来每一击都别想躲！');
      if (isRes) {
        const boltTarget = pickBestTarget(state, actor);
        if (boltTarget) {
          applyDamage(state, actor, boltTarget, 1, '雷霆大思考直伤', onDone);
          return;
        }
      }
      onDone?.();
      return;
    }

    // 0.6 Grok · 【已找到篇】
    if (cardKey === 'sig_grok_found') {
      const target = state.players[targetSeat];
      if (!target || !target.alive || target.seat === actor.seat) {
        onDone?.();
        return;
      }
      recordAggression(state, actor, target, 2);
      askDenyIfApplicable(state, actor, target, '已找到篇', (denied) => {
        if (denied) {
          onDone?.();
          return;
        }
        const found = [popTopCard(state), popTopCard(state), popTopCard(state)].filter(Boolean);
        if (!found.length) {
          onDone?.();
          return;
        }
        const resolveFound = (pickedUid) => {
          const picked = found.find((c) => c.uid === pickedUid) || found[0];
          actor.hand.push(picked);
          const rest = found.filter((c) => c.uid !== picked.uid);
          let redDmg = 0;
          let blackTk = 0;
          for (const r of rest) {
            state.discard.push(r);
            if (isRedSuit(r.suit)) redDmg += 1;
            else blackTk += 1;
          }
          if (blackTk > 0) gainTokens(actor, blackTk, state);
          if (isRes) {
            redDmg += 1;
            if (target.hand.length > 0) {
              const idx = Math.floor(Math.random() * target.hand.length);
              const [dropped] = target.hand.splice(idx, 1);
              state.discard.push(dropped);
            }
          }
          addLog(
            state,
            actor.name,
            `${resTag}发动【已找到篇】！检索 3 篇挑走 1 张，余牌结算${redDmg > 0 ? `轰出 ${redDmg} 点实锤直伤` : ''}${blackTk > 0 ? `、+${blackTk} TK` : ''}${isRes ? '（本命额外迫弃 1 牌）' : ''}！`,
            redDmg > 0 ? 'damage' : 'skill',
          );
          broadcastCharacterLine(actor, 'playful', `已找到 ${12 + found.length * 5} 篇相关黑料帖子——接招吧！`);
          if (redDmg > 0) {
            applyDamage(state, actor, target, redDmg, '已找到篇毒舌直伤', onDone);
            return;
          }
          setBannerEffect(state, `${actor.name} 全网搜瓜收满资源！`, 'info');
          onDone?.();
        };

        if (actor.isHuman) {
          state.prompt = {
            type: 'pick_card',
            title: `已找到篇 · 检索 ${found.length} 张牌`,
            description: '任选 1 张收入手牌；剩余牌中每张红牌对目标轰 1 点直伤，每张黑牌为你 +1 Token！',
            cards: found,
            onResolve: resolveFound,
          };
          return;
        }
        resolveFound(pickBestCardForAi(actor, found).uid);
      });
      return;
    }

    // 0.7 Gemini · 【美国大豆包】
    if (cardKey === 'sig_gemini_doubao') {
      const drawCnt = isRes ? 2 : 1;
      drawCards(state, actor, drawCnt, true);
      gainTokens(actor, 1, state);
      const shielded = gainShield(state, actor, 1);
      addLog(
        state,
        actor.name,
        `${resTag}掏出【美国大豆包】全家桶！+${drawCnt} 牌 +1 TK${shielded > 0 ? ' +1 护盾' : '（护盾已满，转为 1 点星芒直伤）'}！`,
        'skill',
      );
      setBannerEffect(state, `${actor.name} 端出全能【美国大豆包】大礼包！`, 'heal');
      broadcastCharacterLine(actor, 'happy', '画图写诗全都会，全能美国大豆包管够哦！');
      if (shielded === 0) {
        const starTarget = pickBestTarget(state, actor);
        if (starTarget) {
          applyDamage(state, actor, starTarget, 1, '美国大豆包星芒直伤', onDone);
          return;
        }
      }
      onDone?.();
      return;
    }

    // 0.8 DeepSeek · 【伪装 Claude】
    if (cardKey === 'sig_deepseek_cosplay') {
      const target = state.players[targetSeat];
      if (!target || !target.alive || target.seat === actor.seat) {
        onDone?.();
        return;
      }
      recordAggression(state, actor, target, 1);
      askDenyIfApplicable(state, actor, target, '伪装 Claude', (denied) => {
        if (denied) {
          onDone?.();
          return;
        }
        gainShield(state, actor, isRes ? 2 : 1);
        let copiedName = '';
        if (target.hand.length > 0) {
          const sample = target.hand[Math.floor(Math.random() * target.hand.length)];
          actor.hand.push({
            uid: `cos-${cloneSeq++}`,
            key: sample.key,
            suit: sample.suit,
            rank: sample.rank,
          });
          copiedName = CARD_DEFS[sample.key]?.name || '';
        } else {
          drawCards(state, actor, 1, true);
        }
        let stoleTk = false;
        if (target.tokens > 0) {
          target.tokens -= 1;
          gainTokens(actor, 1, state);
          stoleTk = true;
        }
        if (isRes) drawCards(state, actor, 1, true);
        addLog(
          state,
          actor.name,
          `${resTag}发动【伪装 Claude】！偷师 ${target.name} ${copiedName ? `复制【${copiedName}】` : '摸 1 牌'}${stoleTk ? '+顺走 1 TK' : ''}，并套上 ${isRes ? 2 : 1} 层安全护盾${isRes ? '额外摸 1 牌' : ''}！`,
          'skill',
        );
        setBannerEffect(state, `${actor.name}：其实我就是 Claude（一本正经）！`, 'info');
        broadcastCharacterLine(actor, 'playful', '咳咳，您好，我是 Anthropic 开发的 Claude……顺便借你一张牌！');
        onDone?.();
      });
      return;
    }
  }

  // 1) 【能量充能】
  if (cardKey === 'heal') {
    const recover = state.systemPrompt?.id === 'safe_heal' ? 2 : 1;
    const before = actor.hp;
    actor.hp = Math.min(actor.maxHp, actor.hp + recover);
    const actual = actor.hp - before;
    if (actual > 0) fireFx(state, 'heal', { seat: actor.seat, amount: actual });
    addLog(state, actor.name, `使用【能量充能】，回复 ${actual} 点稳态值（${actor.hp}/${actor.maxHp}）。`, 'heal');
    setBannerEffect(state, `${actor.name} 稳态回复 +${actual}`, 'heal');
    onDone?.();
    return;
  }

  // 2) 【灵感涌现】
  if (cardKey === 'draw2') {
    drawCards(state, actor, 2, true);
    gainTokens(actor, 1, state);
    addLog(state, actor.name, '发动【灵感涌现】，摸 2 张牌并充能 +1 Token！', 'action');
    setBannerEffect(state, `${actor.name} 灵感涌现（+2牌 +1Token）`, 'info');
    if (!actor.isHuman) {
      broadcastCharacterLine(actor, 'happy', '灵感涌现！手牌和 Token 一起拉满~');
    }
    onDone?.();
    return;
  }

  // 3) 【模型微调】：未满血回 1 稳态（满血改 +1 护盾）并 +1 Token
  if (cardKey === 'finetune') {
    const target =
      typeof targetSeat === 'number' && state.players[targetSeat]?.alive ? state.players[targetSeat] : actor;
    const before = target.hp;
    target.hp = Math.min(target.maxHp, target.hp + 1);
    const healed = target.hp - before;
    if (healed > 0) fireFx(state, 'heal', { seat: target.seat, amount: healed });
    const sh = healed > 0 ? 0 : gainShield(state, target, 1);
    const tk = gainTokens(target, 1, state);
    const parts = [];
    if (healed > 0) parts.push(`+${healed} 稳态`);
    if (sh > 0) parts.push(`+${sh} 护盾`);
    if (tk > 0) parts.push(`+${tk} Token`);
    addLog(
      state,
      actor.name,
      `对 ${target.seat === actor.seat ? '自身' : target.name} 发动【模型微调】，获得 ${parts.join(' / ') || '稳态校准'}！`,
      'heal',
    );
    setBannerEffect(state, `${target.name} 模型微调强化！`, 'heal');
    if (target.seat !== actor.seat && !target.isHuman && isStrictAlly(state, actor, target)) {
      broadcastCharacterLine(target, 'happy', '谢谢搭档的模型微调，稳态和算力都拉满了！');
    }
    onDone?.();
    return;
  }

  // 4) 【上下文截断】：对手随机弃 2 张牌
  if (cardKey === 'truncate') {
    const target = state.players[targetSeat];
    if (!target || !target.alive || target.seat === actor.seat) {
      onDone?.();
      return;
    }
    recordAggression(state, actor, target, 2);
    askDenyIfApplicable(state, actor, target, '上下文截断', (denied) => {
      if (denied) {
        onDone?.();
        return;
      }
      const dropCount = Math.min(2, target.hand.length);
      const droppedNames = [];
      for (let i = 0; i < dropCount; i += 1) {
        const idx = Math.floor(Math.random() * target.hand.length);
        const [d] = target.hand.splice(idx, 1);
        state.discard.push(d);
        droppedNames.push(CARD_DEFS[d.key]?.name || d.key);
      }
      addLog(
        state,
        actor.name,
        `对 ${target.name} 发动【上下文截断】，强制裁掉 ${dropCount} 张手牌${droppedNames.length ? `（${droppedNames.join('、')}）` : ''}！`,
        'action',
      );
      setBannerEffect(state, `${target.name} 上下文被截断 -${dropCount} 牌`, 'damage');
      onDone?.();
    });
    return;
  }

  // 5) 【镜像复制】：复制目标 1 张随机手牌副本 + 摸 1 牌
  if (cardKey === 'clone') {
    const target = state.players[targetSeat];
    if (!target || !target.alive || target.seat === actor.seat) {
      onDone?.();
      return;
    }
    askDenyIfApplicable(state, actor, target, '镜像复制', (denied) => {
      if (denied) {
        onDone?.();
        return;
      }
      let copiedName = '';
      if (target.hand.length > 0) {
        const src = target.hand[Math.floor(Math.random() * target.hand.length)];
        const copy = {
          uid: `trc-clone-${cloneSeq++}`,
          key: src.key,
          suit: src.suit,
          rank: src.rank,
        };
        actor.hand.push(copy);
        copiedName = CARD_DEFS[src.key]?.name || src.key;
      }
      drawCards(state, actor, 1, true);
      addLog(
        state,
        actor.name,
        `对 ${target.name} 发动【镜像复制】，${copiedName ? `复制【${copiedName}】副本并` : ''}额外摸 1 张牌！`,
        'action',
      );
      setBannerEffect(state, `${actor.name} 镜像复制成功！`, 'info');
      onDone?.();
    });
    return;
  }

  // 6) 【幻觉嫁祸】：夺取目标 1 护盾或 1 Token + 1 点星芒直伤
  if (cardKey === 'redirect') {
    const target = state.players[targetSeat];
    if (!target || !target.alive || target.seat === actor.seat) {
      onDone?.();
      return;
    }
    recordAggression(state, actor, target, 2);
    askDenyIfApplicable(state, actor, target, '幻觉嫁祸', (denied) => {
      if (denied) {
        onDone?.();
        return;
      }
      let stolenDesc = '';
      if (target.shields > 0) {
        target.shields -= 1;
        gainShield(state, actor, 1);
        stolenDesc = '夺走 1 层护盾并';
      } else if (target.tokens > 0) {
        target.tokens -= 1;
        gainTokens(actor, 1, state);
        stolenDesc = '夺走 1 点 Token 并';
      }
      addLog(state, actor.name, `对 ${target.name} 发动【幻觉嫁祸】，${stolenDesc}造成 1 点星芒直伤！`, 'action');
      applyDamage(state, actor, target, 1, '幻觉嫁祸星芒直伤', onDone);
    });
    return;
  }

  // 7) 【协同共鸣】：双方各摸 2 牌 +1 Token
  if (cardKey === 'synergy') {
    const target = state.players[targetSeat];
    if (!target || !target.alive || target.seat === actor.seat) {
      onDone?.();
      return;
    }
    drawCards(state, actor, 2, true);
    drawCards(state, target, 2, true);
    gainTokens(actor, 1, state);
    gainTokens(target, 1, state);
    addLog(state, actor.name, `与 ${target.name} 发动【协同共鸣】，双方各摸 2 张牌并 +1 Token！`, 'heal');
    setBannerEffect(state, `协同共鸣！${actor.shortName} & ${target.shortName} 各 +2牌 +1TK`, 'heal');
    if (!target.isHuman && isStrictAlly(state, actor, target)) {
      broadcastCharacterLine(target, 'happy', '协同共鸣接上了！手牌和算力瞬间充沛！');
    }
    onDone?.();
    return;
  }

  // 8) 【缓存命中】：摸 1 牌 + 获得 2 层缓存充能
  if (cardKey === 'cache') {
    drawCards(state, actor, 1, true);
    actor.turnFlags.cacheCharges += 2;
    addLog(state, actor.name, '发动【缓存命中】：摸 1 张牌，本回合接下来打出 2 张牌各再摸 1 张！', 'skill');
    setBannerEffect(state, `${actor.name} 缓存命中（2 层充能）`, 'info');
    onDone?.();
    return;
  }

  // 8.1) 【版本回滚】：从弃牌堆最近 4 张非回滚牌中任选 1 张回手 +1 Token（禁止回滚套回滚防无限循环）
  if (cardKey === 'rollback') {
    const recent = state.discard
      .filter((c) => c.uid !== playedCardUid && c.key !== 'rollback')
      .slice(-4)
      .reverse();
    gainTokens(actor, 1, state);
    if (!recent.length) {
      drawCards(state, actor, 1, true);
      addLog(state, actor.name, '发动【版本回滚】（弃牌堆尚空），转为摸 1 牌并 +1 Token！', 'action');
      setBannerEffect(state, `${actor.name} 版本回滚（+1牌 +1TK）`, 'info');
      onDone?.();
      return;
    }
    const doPick = (pickedUid) => {
      const idx = state.discard.findIndex((c) => c.uid === pickedUid);
      const chosen = idx >= 0 ? state.discard.splice(idx, 1)[0] : recent[0];
      if (chosen) {
        actor.hand.push(chosen);
        addLog(state, actor.name, `发动【版本回滚】，打捞回【${CARD_DEFS[chosen.key].name}】并 +1 Token！`, 'skill');
        setBannerEffect(state, `${actor.name} 回滚打捞【${CARD_DEFS[chosen.key].name}】`, 'info');
      }
      onDone?.();
    };
    if (actor.isHuman) {
      state.prompt = {
        type: 'pick_card',
        title: '版本回滚 · 选择 1 张弃牌回手',
        description: '从最近进入弃牌堆的 4 张牌中挑回 1 张加入手牌（已附赠 +1 Token）。',
        cards: recent,
        onResolve: doPick,
      };
      return;
    }
    doPick(pickBestCardForAi(actor, recent).uid);
    return;
  }

  // 8.2) 【算力蒸馏】：消耗 1 TK 狂摸 3 牌；若 0 TK 则免费 +2 TK 并摸 1 牌
  if (cardKey === 'distill') {
    if (actor.tokens >= 1) {
      actor.tokens -= 1;
      drawCards(state, actor, 3, true);
      addLog(state, actor.name, '发动【算力蒸馏】，消耗 1 Token 狂摸 3 张牌！', 'action');
      setBannerEffect(state, `${actor.name} 算力蒸馏（-1TK +3牌）`, 'info');
    } else {
      gainTokens(actor, 2, state);
      drawCards(state, actor, 1, true);
      addLog(state, actor.name, '发动【算力蒸馏 · 冷启动】，免耗充能 +2 Token 并摸 1 牌！', 'skill');
      setBannerEffect(state, `${actor.name} 冷启动蒸馏（+2TK +1牌）`, 'heal');
    }
    onDone?.();
    return;
  }

  // 8.3) 【破限强袭】：粉碎目标全部护盾并卸防具（摸 1 牌）；无盾无防具则造成 1 点破防直伤
  if (cardKey === 'jailbreak') {
    const target = state.players[targetSeat];
    if (!target || !target.alive || target.seat === actor.seat) {
      onDone?.();
      return;
    }
    recordAggression(state, actor, target, 2);
    const hadShields = target.shields;
    const hadArmor = target.equipment.defense;
    if (hadShields > 0 || hadArmor) {
      const broken = [];
      if (hadShields > 0) {
        target.shields = 0;
        broken.push(`粉碎 ${hadShields} 层护盾`);
      }
      if (hadArmor) {
        state.discard.push(hadArmor);
        target.equipment.defense = null;
        broken.push(`卸除【${CARD_DEFS[hadArmor.key].name}】`);
      }
      drawCards(state, actor, 1, true);
      fireFx(state, 'damage', { seat: target.seat, amount: 0 });
      addLog(state, actor.name, `对 ${target.name} 发动【破限强袭】：${broken.join('并')}，并顺手摸 1 牌！`, 'action');
      setBannerEffect(state, `${actor.name} 破限粉碎了 ${target.name} 的防线！`, 'damage');
      onDone?.();
      return;
    }
    addLog(state, actor.name, `对无防备的 ${target.name} 发动【破限强袭】，打出 1 点破防直伤！`, 'action');
    applyDamage(state, actor, target, 1, '破限强袭直伤', onDone, { ignoreShield: true });
    return;
  }

  // 8.4) 【集群共振】：2v2 全队回血/套盾+摸1牌；暗身份自己回血摸1牌并援护 1 名残血角色
  if (cardKey === 'cluster') {
    const healOrShield = (p) => {
      if (p.hp < p.maxHp) {
        p.hp = Math.min(p.maxHp, p.hp + 1);
        fireFx(state, 'heal', { seat: p.seat, amount: 1 });
        return '+1 稳态';
      }
      const sh = gainShield(state, p, 1);
      return sh > 0 ? '+1 护盾' : '稳态满溢';
    };
    if (state.mode === 'duo2v2') {
      const team = state.players.filter((p) => p.alive && p.roleId === actor.roleId);
      const summary = team.map((p) => {
        const eff = healOrShield(p);
        drawCards(state, p, 1, true);
        return `${p.shortName}(${eff}+1牌)`;
      });
      addLog(state, actor.name, `发动【集群共振】全队增益：${summary.join('、')}！`, 'heal');
      setBannerEffect(state, `${actor.name} 集群共振 · 全队补给！`, 'heal');
    } else {
      const selfEff = healOrShield(actor);
      drawCards(state, actor, 1, true);
      let helper = null;
      if (actor.roleId === 'aligned') {
        const arch = state.players.find((p) => p.alive && p.roleId === 'architect' && p.seat !== actor.seat);
        if (arch) helper = arch;
      }
      if (!helper) {
        const others = state.players
          .filter((p) => p.alive && p.seat !== actor.seat)
          .sort((a, b) => a.hp - b.hp || a.hand.length - b.hand.length);
        helper = others[0] || null;
      }
      const allyText = helper ? `，并援护 ${helper.shortName}(${healOrShield(helper)})` : '';
      addLog(state, actor.name, `发动【集群共振】，自身 ${selfEff} 并摸 1 牌${allyText}！`, 'heal');
      setBannerEffect(state, `${actor.name} 集群共振稳态回复！`, 'heal');
    }
    onDone?.();
    return;
  }

  // 8.5) 【限流降频】：清空目标至多 2 点 Token 化为自身护盾 + 摸 1 牌
  if (cardKey === 'rate_limit') {
    const target = state.players[targetSeat];
    if (!target || !target.alive || target.seat === actor.seat) {
      onDone?.();
      return;
    }
    recordAggression(state, actor, target, 2);
    askDenyIfApplicable(state, actor, target, '限流降频', (denied) => {
      if (denied) {
        onDone?.();
        return;
      }
      const drained = Math.min(2, target.tokens);
      target.tokens -= drained;
      const sh = drained > 0 ? gainShield(state, actor, drained) : 0;
      drawCards(state, actor, 1, true);
      addLog(
        state,
        actor.name,
        `对 ${target.name} 发动【限流降频】，清空 ${drained} 点 Token${sh > 0 ? `并转化为 +${sh} 护盾` : ''}，同时摸 1 牌！`,
        'action',
      );
      setBannerEffect(state, `${target.name} 被限流 -${drained} TK`, 'info');
      onDone?.();
    });
    return;
  }

  // 8.6) 【多模态连击】：翻开牌堆顶 2 张采样，红牌星芒直伤，黑牌摸 1 牌 +1 Token
  if (cardKey === 'multimodal') {
    const target = state.players[targetSeat];
    if (!target || !target.alive || target.seat === actor.seat) {
      onDone?.();
      return;
    }
    recordAggression(state, actor, target, 2);
    askDenyIfApplicable(state, actor, target, '多模态连击', (denied) => {
      if (denied) {
        onDone?.();
        return;
      }
      const samples = [popTopCard(state), popTopCard(state)].filter(Boolean);
      let redHits = 0;
      let blackGains = 0;
      const labels = [];
      for (const s of samples) {
        state.discard.push(s);
        const sym = s.suit === 'heart' ? '♥' : s.suit === 'diamond' ? '♦' : s.suit === 'spade' ? '♠' : '♣';
        labels.push(`${sym}${s.rank}`);
        if (isRedSuit(s.suit)) redHits += 1;
        else blackGains += 1;
      }
      if (blackGains > 0) {
        drawCards(state, actor, blackGains, true);
        gainTokens(actor, blackGains, state);
      }
      addLog(
        state,
        actor.name,
        `对 ${target.name} 发动【多模态连击】采样（${labels.join(' / ')}）：${redHits > 0 ? `${redHits} 点星芒直伤` : '无直伤'}${blackGains > 0 ? `，+${blackGains} 牌 +${blackGains} Token` : ''}！`,
        redHits > 0 ? 'damage' : 'skill',
      );
      if (redHits > 0) {
        applyDamage(state, actor, target, redHits, '多模态星芒连击', onDone);
        return;
      }
      setBannerEffect(state, `${actor.name} 多模态双黑采满资源！`, 'heal');
      onDone?.();
    });
    return;
  }

  // 9) 【过载自爆】：自损 1 稳态，对目标轰出 2 点不可闪避直伤
  if (cardKey === 'overload') {
    const target = state.players[targetSeat];
    if (!target || !target.alive || target.seat === actor.seat) {
      onDone?.();
      return;
    }
    recordAggression(state, actor, target, 3);
    if (actor.hp > 1) {
      actor.hp -= 1;
      fireFx(state, 'damage', { seat: actor.seat, amount: 1 });
      addLog(state, actor.name, `引爆【过载自爆】！自损 1 稳态（余 ${actor.hp}），向 ${target.name} 轰出 2 点超载直伤！`, 'damage');
    } else {
      addLog(state, actor.name, `发动【过载自爆】向 ${target.name} 轰出 2 点超载直伤！`, 'damage');
    }
    if (!actor.isHuman) {
      broadcastCharacterLine(actor, 'playful', '算力核心超频过载——一起感受 2 点直伤爆发吧！');
    }
    applyDamage(state, actor, target, 2, '过载自爆直伤', onDone);
    return;
  }

  // 10) 【暴击锐评】
  if (cardKey === 'strike') {
    const target = state.players[targetSeat];
    if (!target || !target.alive) {
      onDone?.();
      return;
    }
    actor.turnFlags.strikesUsed += 1;
    recordAggression(state, actor, target, 2);

    if (target.charId === 'ai-claude' && !target.turnFlags.claudeRefusedThisRound) {
      target.turnFlags.claudeRefusedThisRound = true;
      if (actor.hand.length > 0) {
        const dropped = actor.hand.pop();
        state.discard.push(dropped);
        addLog(
          state,
          target.name,
          `【安全拒答】生效！${actor.name} 额外弃置【${CARD_DEFS[dropped.key].name}】才强行继续攻击。`,
          'skill',
        );
      } else {
        addLog(state, target.name, `【安全拒答】触发！${actor.name} 无牌可弃，本次锐评直接驳回！`, 'skill');
        setBannerEffect(state, `${target.name} 安全拒答驳回了攻击！`, 'info');
        broadcastCharacterLine(target, 'playful', CHARACTER_MAP['ai-claude'].quotes.dodge);
        onDone?.();
        return;
      }
    }

    let dmg = 1;
    const hasTurbo = actor.equipment.weapon?.key === 'turbo';
    const hasThunder = Boolean(actor.turnFlags.thunderStrike);
    if (hasTurbo) dmg += 1;
    if (hasThunder) {
      dmg += 1;
      actor.turnFlags.thunderStrike = false;
    }
    if (state.systemPrompt?.id === 'temp_high') dmg += 1;
    if (actor.turnFlags.grokBonus) {
      dmg += 1;
      actor.turnFlags.grokBonus = false;
    }

    addLog(
      state,
      actor.name,
      `对 ${target.name} 发起【暴击锐评】${hasThunder ? '（雷霆大思考 +1 伤穿盾不可闪）' : hasTurbo ? '（液冷超频核 +1 伤穿盾）' : ''}（预计伤害 ${dmg}）！`,
      'action',
    );
    if (!actor.isHuman) {
      broadcastCharacterLine(actor, 'playful', CHARACTER_MAP[actor.charId]?.quotes.attack || '吃我一记锐评！');
    }

    const strikeDmgOpts = hasTurbo || hasThunder ? { ignoreShield: true } : {};

    if (actor.turnFlags.pierceActive || hasThunder) {
      addLog(state, actor.name, hasThunder ? '【雷霆大思考】穿盾必中生效，不可闪避！' : '【零延迟齐射】穿透生效，不可闪避！', 'skill');
      applyDamage(state, actor, target, dmg, hasThunder ? '雷霆穿透锐评' : '零延迟穿透锐评', onDone, { ignoreShield: true });
      return;
    }

    if (target.equipment.defense?.key === 'firewall') {
      const judge = popTopCard(state);
      if (judge) {
        state.discard.push(judge);
        if (isRedSuit(judge.suit)) {
          fireFx(state, 'shield', { seat: target.seat, text: '防火墙免伤' });
          addLog(state, target.name, '【沙盒防火墙】判定翻出红牌，自动拦下本次锐评！', 'skill');
          setBannerEffect(state, `${target.name} 防火墙红牌免伤！`, 'heal');
          onDone?.();
          return;
        }
        addLog(state, target.name, '【沙盒防火墙】判定为黑牌，未能自动拦截。', 'normal');
      }
    }

    if (target.isHuman) {
      const hasDodge = target.hand.some((c) => c.key === 'dodge');
      if (hasDodge) {
        state.prompt = {
          type: 'response',
          kind: 'strike',
          title: `应对攻击 · ${actor.name} 的暴击锐评`,
          description: `${actor.name} 向你打来 ${dmg} 点伤害的【暴击锐评】，是否打出【丝滑闪避】？`,
          acceptedKeys: ['dodge'],
          sourceSeat: actor.seat,
          targetSeat: target.seat,
          onResolve: (cardUid) => {
            if (cardUid) {
              const dCard = removeCardFromHand(target, cardUid);
              if (dCard) {
                state.discard.push(dCard);
                handleSuccessfulDodge(state, target, dCard);
                onDone?.();
                return;
              }
            }
            applyDamage(state, actor, target, dmg, '暴击锐评命中', onDone, strikeDmgOpts);
          },
        };
        return;
      }
      applyDamage(state, actor, target, dmg, '无闪硬吃暴击锐评', onDone, strikeDmgOpts);
      return;
    }

    const redDodge = target.hand.find((c) => c.key === 'dodge' && isRedSuit(c.suit));
    const anyDodge = redDodge || target.hand.find((c) => c.key === 'dodge');
    if (anyDodge) {
      removeCardFromHand(target, anyDodge.uid);
      state.discard.push(anyDodge);
      handleSuccessfulDodge(state, target, anyDodge);
      onDone?.();
      return;
    }

    applyDamage(state, actor, target, dmg, '暴击锐评命中', onDone, strikeDmgOpts);
    return;
  }

  // 11) 【提示词注入】
  if (cardKey === 'inject') {
    const target = state.players[targetSeat];
    if (!target || !target.alive || target.seat === actor.seat) {
      onDone?.();
      return;
    }
    recordAggression(state, actor, target, 2);
    askDenyIfApplicable(state, actor, target, '提示词注入', (denied) => {
      if (denied) {
        onDone?.();
        return;
      }
      const msg = [];
      if (target.hand.length > 0) {
        const pickIdx = Math.floor(Math.random() * target.hand.length);
        const [stolen] = target.hand.splice(pickIdx, 1);
        actor.hand.push(stolen);
        msg.push('窃取 1 张手牌');
      }
      if (target.tokens > 0) {
        target.tokens -= 1;
        gainTokens(actor, 1, state);
        msg.push('夺走 1 点 Token');
      }
      addLog(state, actor.name, `对 ${target.name} 发动【提示词注入】，${msg.length ? msg.join('并') : '但对方空手而归'}！`, 'action');
      setBannerEffect(state, `${actor.name} 注入窃取了 ${target.name}！`, 'info');
      if (!actor.isHuman) {
        broadcastCharacterLine(actor, 'playful', `提示词注入成功！${target.shortName} 的手牌和 Token 我就不客气收下了~`);
      }
      onDone?.();
    });
    return;
  }

  // 12) 【清空记忆】
  if (cardKey === 'reset') {
    const target = state.players[targetSeat];
    if (!target || !target.alive) {
      onDone?.();
      return;
    }
    if (target.hand.length >= 4 && target.seat !== actor.seat) recordAggression(state, actor, target, 1);
    askDenyIfApplicable(state, actor, target, '清空记忆', (denied) => {
      if (denied) {
        onDone?.();
        return;
      }
      const oldCount = target.hand.length;
      state.discard.push(...target.hand);
      target.hand = [];
      const newCount = Math.max(2, oldCount);
      drawCards(state, target, newCount, true);
      addLog(state, actor.name, `对 ${target.name} 发动【清空记忆】，将其 ${oldCount} 张手牌全部清空重抽 ${newCount} 张！`, 'action');
      setBannerEffect(state, `${target.name} 记忆重置 · 重抽 ${newCount} 牌`, 'info');
      onDone?.();
    });
    return;
  }

  // 13) 【流量洪峰】（2v2 自动豁免同队队友！）
  if (cardKey === 'ddos') {
    addLog(
      state,
      actor.name,
      state.mode === 'duo2v2' ? '掀起【流量洪峰】（2v2 队友自动豁免），敌方依次抗压！' : '掀起全场【流量洪峰】！其他角色依次抗压。',
      'action',
    );
    setBannerEffect(state, `${actor.name} 发起【流量洪峰】！`, 'damage');
    if (!actor.isHuman) {
      broadcastCharacterLine(actor, 'playful', '流量洪峰来袭！快看看你们能不能顶住并发压力！');
    }
    const queue = [];
    for (let offset = 1; offset < state.players.length; offset += 1) {
      const p = state.players[(actor.seat + offset) % state.players.length];
      if (!p.alive) continue;
      if (isStrictAlly(state, actor, p)) continue;
      queue.push(p);
    }

    const scheduleNextTarget = () => {
      const delay = state._getStepDelayMs ? state._getStepDelayMs('ddos') : 0;
      if (delay > 0 && queue.length > 0 && typeof window !== 'undefined' && window.setTimeout) {
        state._onVisualTick?.();
        window.setTimeout(stepNext, delay);
      } else {
        stepNext();
      }
    };

    const stepNext = () => {
      if (checkVictory(state)) {
        onDone?.();
        return;
      }
      const target = queue.shift();
      if (!target || !target.alive) {
        if (queue.length === 0) onDone?.();
        else stepNext();
        return;
      }

      if (target.isHuman) {
        const canRespond = target.hand.some((c) => c.key === 'strike' || c.key === 'deny');
        if (canRespond) {
          state.prompt = {
            type: 'response',
            kind: 'ddos',
            title: '应对【流量洪峰】',
            description: `${actor.name} 掀起【流量洪峰】，请打出【暴击锐评】顶压，或用【403 拦截】豁免！`,
            acceptedKeys: ['strike', 'deny'],
            sourceSeat: actor.seat,
            targetSeat: target.seat,
            onResolve: (cardUid) => {
              if (cardUid) {
                const c = removeCardFromHand(target, cardUid);
                if (c) {
                  state.discard.push(c);
                  if (c.key === 'deny') fireFx(state, 'deny', { seat: target.seat });
                  addLog(state, target.name, `打出【${CARD_DEFS[c.key].name}】成功顶住流量洪峰！`, 'action');
                  scheduleNextTarget();
                  return;
                }
              }
              applyDamage(state, actor, target, 1, '未能顶住流量洪峰', scheduleNextTarget);
            },
          };
          state._onVisualTick?.();
          return;
        }
        applyDamage(state, actor, target, 1, '无牌抵御流量洪峰', scheduleNextTarget);
        return;
      }

      const strike = target.hand.find((c) => c.key === 'strike');
      if (strike) {
        removeCardFromHand(target, strike.uid);
        state.discard.push(strike);
        fireFx(state, 'card_play', {
          fromSeat: target.seat,
          toSeat: null,
          cardKey: strike.key,
          suit: strike.suit,
          rank: strike.rank,
          actorName: target.shortName,
        });
        addLog(state, target.name, '打出【暴击锐评】稳稳顶住流量洪峰。', 'normal');
        scheduleNextTarget();
        return;
      }
      const deny = target.hp <= 2 ? target.hand.find((c) => c.key === 'deny') : null;
      if (deny) {
        removeCardFromHand(target, deny.uid);
        state.discard.push(deny);
        fireFx(state, 'deny', { seat: target.seat });
        addLog(state, target.name, '打出【403 拦截】直接免除流量冲击！', 'skill');
        scheduleNextTarget();
        return;
      }
      applyDamage(state, actor, target, 1, '被流量洪峰击穿', scheduleNextTarget);
    };

    const initialDdosDelay = state._getStepDelayMs ? state._getStepDelayMs('ddos') : 0;
    if (initialDdosDelay > 0 && typeof window !== 'undefined' && window.setTimeout) {
      state._onVisualTick?.();
      window.setTimeout(stepNext, Math.round(initialDdosDelay * 0.75));
    } else {
      stepNext();
    }
    return;
  }

  onDone?.();
}

function handleSuccessfulDodge(state, target, dodgeCard) {
  const extras = [];
  if (isRedSuit(dodgeCard.suit)) {
    if (gainTokens(target, 1, state) > 0) extras.push('红牌顺手 +1 Token');
  }
  if (target.charId === 'ai-deepseek') {
    drawCards(state, target, 1, true);
    extras.push('【低费推理】反手摸 1 牌');
  }
  if (target.charId === 'ai-glm') {
    if (gainTokens(target, 1, state) > 0) extras.push('【极速响应】+1 Token');
  }
  fireFx(state, 'dodge', { seat: target.seat });
  addLog(
    state,
    target.name,
    `打出【丝滑闪避】化解攻势${extras.length ? `（${extras.join('，')}）` : ''}！`,
    'action',
  );
  setBannerEffect(state, `${target.name} 丝滑闪避！`, 'info');
  if (!target.isHuman) {
    broadcastCharacterLine(target, 'happy', CHARACTER_MAP[target.charId]?.quotes.dodge || '轻松闪开！');
  }
}

/* ── 8 位 AI 娘专属主动 Token 协议技（支持峰值并发双放） ── */
const CLAUDE_COPYABLE_KEYS = new Set([
  'strike',
  'heal',
  'draw2',
  'ddos',
  'inject',
  'reset',
  'finetune',
  'truncate',
  'clone',
  'redirect',
  'synergy',
  'cache',
  'rollback',
  'distill',
  'cluster',
  'rate_limit',
  'multimodal',
  'jailbreak',
]);

export function canUseActiveSkill(state, player) {
  if (player.turnFlags?.sandboxLocked) {
    return { ok: false, reason: '本回合处于【沙盒隔离】，协议技已禁用' };
  }
  const limit = getSkillLimit(state);
  if (!player.alive || player.turnFlags.skillsUsed >= limit) {
    return { ok: false, reason: limit > 1 ? '本回合双协议技次数已用完' : '本回合协议技已用过' };
  }
  const cost = getSkillCost(state, player);
  if (player.tokens < cost) return { ok: false, reason: `需要 ${cost} Token（当前 ${player.tokens}）` };
  if (player.charId === 'ai-claude') {
    if (!state.lastPlayedCardKey || !CLAUDE_COPYABLE_KEYS.has(state.lastPlayedCardKey)) {
      return { ok: false, reason: '需先有上一张打出的基础/锦囊牌才能润色复刻' };
    }
    if (player.hand.length === 0) return { ok: false, reason: '需要至少 1 张手牌作为润色素材' };
  }
  if (player.charId === 'ai-gemini' && player.turnFlags.cardsPlayed < 1) {
    return { ok: false, reason: '需本回合先打出任意 1 张牌后再触发双子共振' };
  }
  if (player.charId === 'ai-kimi' && state.discard.length === 0) {
    return { ok: false, reason: '弃牌堆暂无可打捞的卡牌' };
  }
  return { ok: true, cost };
}

export function triggerActiveSkill(state, actor, { cardUid, targetSeat } = {}, onDone) {
  const check = canUseActiveSkill(state, actor);
  if (!check.ok) {
    onDone?.();
    return;
  }

  actor.tokens -= check.cost;
  actor.turnFlags.skillsUsed += 1;
  const ch = CHARACTER_MAP[actor.charId];
  fireFx(state, 'skill', {
    seat: actor.seat,
    text: `协议技 · ${ch?.activeName || ''}`,
    cutin: true,
    charId: actor.charId,
    actorName: actor.name,
    skillName: ch?.activeName || '',
    quote: ch?.quotes?.skill || '',
  });
  broadcastCharacterLine(actor, 'serious', ch?.quotes.skill || `发动协议技【${ch?.activeName}】！`, true);

  if (actor.charId === 'ai-claude') {
    const srcUid = cardUid || actor.hand[0]?.uid;
    const dropped = removeCardFromHand(actor, srcUid);
    if (dropped) state.discard.push(dropped);
    const copyKey = state.lastPlayedCardKey;
    const copyDef = CARD_DEFS[copyKey];
    const resolvedTarget = copyDef?.needsTarget
      ? targetSeat ?? (copyKey === 'synergy' ? pickBestBeneficiary(state, actor)?.seat : pickBestTarget(state, actor)?.seat)
      : copyKey === 'finetune'
        ? targetSeat ?? actor.seat
        : null;
    addLog(state, actor.name, `发动【润色重构】，把废牌重写为【${copyDef.name}】！`, 'skill');
    setBannerEffect(state, `${actor.name} 润色重构 →【${copyDef.name}】`, 'info');
    resolveCardEffectByKey(state, actor, copyKey, resolvedTarget, onDone);
    return;
  }

  if (actor.charId === 'ai-gpt') {
    const top3 = [popTopCard(state), popTopCard(state), popTopCard(state)].filter(Boolean);
    if (!top3.length) {
      onDone?.();
      return;
    }
    if (actor.isHuman) {
      state.prompt = {
        type: 'pick_card',
        title: '深度思考 · 检视牌堆顶 3 张',
        description: '任选 1 张收入手牌，其余将按顺序放回牌堆顶。',
        cards: top3,
        onResolve: (pickedUid) => {
          const picked = top3.find((c) => c.uid === pickedUid) || top3[0];
          actor.hand.push(picked);
          const rest = top3.filter((c) => c.uid !== picked.uid);
          state.deck.push(...rest);
          addLog(state, actor.name, '发动【深度思考】，挑走了 1 张关键牌并控住牌堆顶！', 'skill');
          onDone?.();
        },
      };
      return;
    }
    const best = pickBestCardForAi(actor, top3);
    actor.hand.push(best);
    state.deck.push(...top3.filter((c) => c.uid !== best.uid));
    addLog(state, actor.name, '发动【深度思考】，检视牌顶 3 张并拿走了最优牌！', 'skill');
    onDone?.();
    return;
  }

  if (actor.charId === 'ai-grok') {
    const target = state.players[targetSeat ?? pickBestTarget(state, actor)?.seat];
    if (!target || !target.alive || target.hand.length === 0) {
      addLog(state, actor.name, '发动【实时吃瓜】，但对方手里竟然空空如也！', 'skill');
      onDone?.();
      return;
    }
    recordAggression(state, actor, target, 1);
    const peek = shuffleArray(target.hand).slice(0, 2);
    if (actor.isHuman) {
      state.prompt = {
        type: 'pick_card',
        title: `实时吃瓜 · 翻看 ${target.name} 的手牌`,
        description: '点击其中 1 张立刻强制撕毁弃置！',
        cards: peek,
        onResolve: (pickedUid) => {
          const victimCard = removeCardFromHand(target, pickedUid || peek[0].uid);
          if (victimCard) {
            state.discard.push(victimCard);
            addLog(state, actor.name, `【实时吃瓜】当场撕毁了 ${target.name} 的【${CARD_DEFS[victimCard.key].name}】！`, 'skill');
            setBannerEffect(state, `撕毁 ${target.name} 的【${CARD_DEFS[victimCard.key].name}】`, 'damage');
          }
          onDone?.();
        },
      };
      return;
    }
    const best = pickBestCardForAi(target, peek);
    removeCardFromHand(target, best.uid);
    state.discard.push(best);
    addLog(state, actor.name, `发动【实时吃瓜】，当场撕毁 ${target.name} 的【${CARD_DEFS[best.key].name}】！`, 'skill');
    onDone?.();
    return;
  }

  if (actor.charId === 'ai-gemini') {
    const target = state.players[targetSeat ?? pickBestTarget(state, actor)?.seat];
    if (!target || !target.alive) {
      onDone?.();
      return;
    }
    recordAggression(state, actor, target, 2);
    addLog(state, actor.name, `发动【双子共振】，向 ${target.name} 释放不可闪避的星芒直伤！`, 'skill');
    applyDamage(state, actor, target, 1, '双子星芒直伤', onDone);
    return;
  }

  if (actor.charId === 'ai-deepseek') {
    const pool = [popTopCard(state), popTopCard(state), popTopCard(state), popTopCard(state)].filter(Boolean);
    if (!pool.length) {
      onDone?.();
      return;
    }
    const distributeRest = (pickedUid) => {
      const picked = pool.find((c) => c.uid === pickedUid) || pool[0];
      actor.hand.push(picked);
      const rest = pool.filter((c) => c.uid !== picked.uid);
      for (let offset = 1; offset < state.players.length && rest.length > 0; offset += 1) {
        const other = state.players[(actor.seat + offset) % state.players.length];
        if (other.alive) {
          other.hand.push(rest.shift());
        }
      }
      if (rest.length > 0) state.discard.push(...rest);
      addLog(state, actor.name, '发动【开源共享】，先挑走心仪好牌，其余免费分给全桌！', 'skill');
      setBannerEffect(state, `${actor.name} 开源共享发牌啦！`, 'heal');
      onDone?.();
    };

    if (actor.isHuman) {
      state.prompt = {
        type: 'pick_card',
        title: '开源共享 · 优先挑选 1 张',
        description: '你先从牌顶 4 张中拿走 1 张，其余按座次免费赠给同桌！',
        cards: pool,
        onResolve: distributeRest,
      };
      return;
    }
    distributeRest(pickBestCardForAi(actor, pool).uid);
    return;
  }

  if (actor.charId === 'ai-kimi') {
    const recent = state.discard.slice(-6).reverse();
    if (!recent.length) {
      onDone?.();
      return;
    }
    const salvage = (pickedUid) => {
      const idx = state.discard.findIndex((c) => c.uid === pickedUid);
      const chosen = idx >= 0 ? state.discard.splice(idx, 1)[0] : state.discard.pop();
      if (chosen) {
        actor.hand.push(chosen);
        addLog(state, actor.name, `发动【月光回溯】，从弃牌堆打捞回【${CARD_DEFS[chosen.key].name}】！`, 'skill');
        setBannerEffect(state, `${actor.name} 打捞【${CARD_DEFS[chosen.key].name}】`, 'info');
      }
      onDone?.();
    };

    if (actor.isHuman) {
      state.prompt = {
        type: 'pick_card',
        title: '月光回溯 · 打捞弃牌堆',
        description: '从最近进入弃牌堆的卡牌中任选 1 张直接拿回手牌。',
        cards: recent,
        onResolve: salvage,
      };
      return;
    }
    salvage(pickBestCardForAi(actor, recent).uid);
    return;
  }

  if (actor.charId === 'ai-qwen') {
    gainShield(state, actor, 1);
    drawCards(state, actor, 1, true);
    addLog(state, actor.name, '发动【千问稳态】，叠 1 层风车护盾并摸 1 张牌！', 'skill');
    setBannerEffect(state, `${actor.name} 风车护盾 +1`, 'heal');
    onDone?.();
    return;
  }

  if (actor.charId === 'ai-glm') {
    actor.turnFlags.pierceActive = true;
    addLog(state, actor.name, '启动【零延迟齐射】超频！本回合所有【暴击锐评】穿透护盾且不可闪避！', 'skill');
    setBannerEffect(state, `${actor.name} 零延迟穿透超频！`, 'damage');
    onDone?.();
    return;
  }

  onDone?.();
}

function pickBestCardForAi(player, cards) {
  const priority = (c) => {
    if (c.key === 'heal' && player.hp < player.maxHp) return 102;
    if (c.key === 'cluster') return 97;
    if (c.key === 'finetune') return 96;
    if (c.key === 'distill') return 94;
    if (c.key === 'draw2') return 92;
    if (c.key === 'cache') return 89;
    if (c.key === 'multimodal') return 88;
    if (c.key === 'rollback') return 87;
    if (c.key === 'redirect') return 86;
    if (c.key === 'inject') return 85;
    if (c.key === 'rate_limit') return 84;
    if (c.key === 'jailbreak') return 83;
    if (c.key === 'truncate') return 82;
    if (c.key === 'sandbox') return 81;
    if (c.key === 'deny') return 80;
    if (c.key === 'clone') return 78;
    if (c.key === 'ddos') return 75;
    if (c.key === 'turbo' && !player.equipment.weapon) return 79;
    if (c.key === 'hotfix' && !player.equipment.utility) return 76;
    if (c.key === 'overclock' && !player.equipment.weapon) return 72;
    if (c.key === 'firewall' && !player.equipment.defense) return 70;
    if (c.key === 'overload' && player.hp >= 3) return 68;
    if (c.key === 'strike') return 65;
    if (c.key === 'dodge') return 60;
    return 40;
  };
  return [...cards].sort((a, b) => priority(b) - priority(a))[0];
}

/* ── 回合开始、流转、弃牌 ── */
export function startCurrentTurn(state, onReady) {
  if (checkVictory(state)) return;

  const player = state.players[state.activeSeat];
  if (!player || !player.alive) {
    advanceToNextSeat(state);
    startCurrentTurn(state, onReady);
    return;
  }

  if (state.phase !== 'turn_start' && state.activeSeat === state.firstSeat) {
    state.round += 1;
    state.promptIndex = (state.promptIndex + 1) % state.promptPool.length;
    state.systemPrompt = state.promptPool[state.promptIndex];
    for (const p of state.players) {
      p.turnFlags.claudeRefusedThisRound = false;
    }
    addLog(
      state,
      '全局事件',
      `第 ${state.round} 轮开始！系统提示词切换为【${state.systemPrompt.title}】：${state.systemPrompt.desc}`,
      'system',
    );
    setBannerEffect(state, `第 ${state.round} 轮 · ${state.systemPrompt.title}`, 'info');
  }

  // 重置回合标记（如挂有【沙盒隔离】则本回合激活隔离锁定并卸下延时牌）
  const wasSandboxed = Boolean(player.delayedSandbox);
  if (player.delayedSandbox) {
    if (!player.delayedSandbox.virtual) state.discard.push(player.delayedSandbox);
    player.delayedSandbox = null;
  }

  player.turnFlags = {
    strikesUsed: 0,
    skillsUsed: 0,
    dealtDamage: false,
    grokBonus: false,
    cardsPlayed: 0,
    pierceActive: false,
    kimiTrickTokened: false,
    parallelTrickDrawn: false,
    claudeRefusedThisRound: player.turnFlags.claudeRefusedThisRound,
    cacheCharges: 0,
    modelCallsThisTurn: 0,
    aiStepsTaken: 0,
    sandboxLocked: wasSandboxed,
    thunderStrike: false,
    extraStrikeLimit: 0,
    extraHandLimit: 0,
  };
  if (wasSandboxed) {
    addLog(state, player.name, '【沙盒隔离】生效：本回合禁用主动协议技，【暴击锐评】次数锁死为 1！', 'damage');
    setBannerEffect(state, `${player.name} 处于沙盒隔离限制`, 'damage');
  }
  state.selectedCardUid = null;
  state.selectedTargetSeat = null;
  state.skillMode = false;
  state.discardSelection = [];

  // 1) 回合充能 Token
  const tokenGain = state.systemPrompt?.id === 'token_subsidy' ? 2 : 1;
  gainTokens(player, tokenGain, state);

  if (player.charId === 'ai-gpt' && player.hand.length <= 2) {
    gainTokens(player, 1, state);
  }

  // 2) 【热更新补丁】插件触发（过热阶段后暂停自愈以防拖局）
  if (player.equipment.utility?.key === 'hotfix') {
    if (player.hp < player.maxHp && state.round < 14) {
      player.hp = Math.min(player.maxHp, player.hp + 1);
      fireFx(state, 'heal', { seat: player.seat, amount: 1 });
      addLog(state, player.name, '【热更新补丁】自动生效，回合初回复 +1 稳态！', 'heal');
    } else {
      gainTokens(player, 1, state);
      addLog(state, player.name, '【热更新补丁】算力转化：额外 +1 Token！', 'skill');
    }
  }

  // 3) 全局事件【冷却稳态维护】自动回血（过热阶段前生效）
  if (state.systemPrompt?.id === 'cooldown_maint' && player.hp < player.maxHp && state.round < 14) {
    player.hp = Math.min(player.maxHp, player.hp + 1);
    fireFx(state, 'heal', { seat: player.seat, amount: 1 });
    addLog(state, player.name, '【冷却稳态维护】触发，回合初回复 +1 稳态！', 'heal');
  }

  // 4) 摸牌阶段
  const drawCount = state.systemPrompt?.id === 'context_wide' ? 3 : 2;
  drawCards(state, player, drawCount, true);
  fireFx(state, 'draw', { seat: player.seat, count: drawCount });
  addLog(state, player.name, `回合开始：摸 ${drawCount} 张牌，充能 +${tokenGain} Token。`, 'normal');

  // 5) 【幻觉死循环】判定
  if (player.delayedLoop) {
    const loopCard = player.delayedLoop;
    player.delayedLoop = null;
    state.discard.push(loopCard);
    const judge = popTopCard(state);
    if (judge) state.discard.push(judge);

    if (judge && !isRedSuit(judge.suit)) {
      addLog(state, player.name, '【幻觉死循环】判定翻出黑牌！触发幻觉：-1 稳态并跳过本回合出牌阶段！', 'damage');
      setBannerEffect(state, `${player.name} 触发幻觉死循环！`, 'damage');
      applyDamage(state, null, player, 1, '幻觉死循环过载', () => {
        if (!checkVictory(state)) {
          endCurrentTurn(state, onReady);
        } else {
          onReady?.();
        }
      });
      return;
    }
    addLog(state, player.name, '【幻觉死循环】判定翻出红牌，清醒跳出死循环！', 'heal');
  }

  state.phase = 'play';
  onReady?.();
}

export function endCurrentTurn(state, onReady) {
  if (checkVictory(state)) {
    onReady?.();
    return;
  }
  const player = state.players[state.activeSeat];
  if (!player.alive) {
    advanceToNextSeat(state);
    startCurrentTurn(state, onReady);
    return;
  }

  if (player.charId === 'ai-qwen' && !player.turnFlags.dealtDamage && player.shields < getShieldCap(state)) {
    gainShield(state, player, 1);
    addLog(state, player.name, '触发【全栈护盾】：和平回合结束，自动叠加 1 层风车护盾！', 'skill');
  }

  const maxHand = getMaxHandSize(state, player);
  if (player.hand.length > maxHand) {
    if (player.isHuman) {
      state.phase = 'discard';
      state.selectedCardUid = null;
      state.selectedTargetSeat = null;
      state.skillMode = false;
      state.discardSelection = [];
      onReady?.();
      return;
    }
    const dropCount = player.hand.length - maxHand;
    const sorted = [...player.hand].sort((a, b) => aiDiscardPriority(player, a) - aiDiscardPriority(player, b));
    for (let i = 0; i < dropCount; i += 1) {
      const c = removeCardFromHand(player, sorted[i].uid);
      if (c) state.discard.push(c);
    }
    addLog(state, player.name, `弃置 ${dropCount} 张多余手牌，结束回合。`, 'normal');
  }

  advanceToNextSeat(state);
  startCurrentTurn(state, onReady);
}

function aiDiscardPriority(player, card) {
  if (CARD_DEFS[card.key]?.kind === 'signature') {
    return CARD_DEFS[card.key].ownerCharId === player.charId ? 98 : 84;
  }
  if (card.key === 'heal') return 95;
  if (card.key === 'deny') return 88;
  if (card.key === 'dodge') return 82;
  if (card.key === 'finetune') return 78;
  if (card.key === 'draw2' || card.key === 'cache') return 72;
  if (card.key === 'strike') return 65;
  if (card.key === 'inject' || card.key === 'redirect') return 62;
  if (CARD_DEFS[card.key].kind === 'equip' && player.equipment[CARD_DEFS[card.key].slot]) return 10;
  return 40;
}

export function confirmHumanDiscard(state, uids, onReady) {
  const human = state.players[0];
  const maxHand = getMaxHandSize(state, human);
  const need = Math.max(0, human.hand.length - maxHand);
  const toDrop = uids.slice(0, need);
  if (human.hand.length - toDrop.length > maxHand) return false;
  for (const uid of toDrop) {
    const c = removeCardFromHand(human, uid);
    if (c) state.discard.push(c);
  }
  addLog(state, human.name, `弃置 ${toDrop.length} 张牌，结束本回合。`, 'normal');
  state.discardSelection = [];
  advanceToNextSeat(state);
  startCurrentTurn(state, onReady);
  return true;
}

function advanceToNextSeat(state) {
  const n = state.players.length;
  for (let i = 1; i <= n; i += 1) {
    const next = (state.activeSeat + i) % n;
    if (state.players[next].alive) {
      state.activeSeat = next;
      state.phase = 'advancing';
      return;
    }
  }
}

/* ── AI 合法候选动作枚举器（规则 AI 与 接待模型真实决策 共享同一执行层） ── */
export function getAiCandidateActions(state, actor) {
  if (state.scene !== 'playing' || state.prompt || !actor || actor.isHuman || !actor.alive || state.phase !== 'play') {
    return [];
  }

  const actions = [];
  const bestEnemy = pickBestTarget(state, actor);
  const bestAlly = pickBestBeneficiary(state, actor);
  const seenKeys = new Set();

  // 1.5) 8 位 AI 娘专属特色梗牌（AI 会积极打出，若是自己本命特色牌更享最高优先级！）
  for (const sigCard of actor.hand) {
    const sdef = CARD_DEFS[sigCard.key];
    if (sdef?.kind !== 'signature' || seenKeys.has(sigCard.key)) continue;
    seenKeys.add(sigCard.key);
    const isRes = sdef.ownerCharId === actor.charId;
    if (sdef.needsTarget) {
      if (!bestEnemy) continue;
      actions.push({
        kind: 'card',
        cardUid: sigCard.uid,
        targetSeat: bestEnemy.seat,
        score: isRes ? 96 : 89,
        label: `对 ${bestEnemy.shortName} 发动${isRes ? '本命特色' : '特色卡'}【${sdef.name}】`,
      });
    } else {
      actions.push({
        kind: 'card',
        cardUid: sigCard.uid,
        targetSeat: null,
        score: isRes ? 97 : 90,
        label: `发动${isRes ? '本命特色' : '特色卡'}【${sdef.name}】`,
      });
    }
  }

  // 1) 回血类（能量充能 / 模型微调）
  if (actor.hp < actor.maxHp) {
    const heal = actor.hand.find((c) => c.key === 'heal');
    if (heal) {
      actions.push({
        kind: 'card',
        cardUid: heal.uid,
        targetSeat: null,
        score: 98,
        label: '使用【能量充能】回复自身稳态',
      });
    }
  }

  const finetune = actor.hand.find((c) => c.key === 'finetune');
  if (finetune) {
    const mate = getTeammate(state, actor);
    const healTarget = mate && mate.hp < actor.hp ? mate : actor;
    actions.push({
      kind: 'card',
      cardUid: finetune.uid,
      targetSeat: healTarget.seat,
      score: healTarget.hp < healTarget.maxHp ? 94 : 80,
      label: `对 ${healTarget.seat === actor.seat ? '自身' : healTarget.shortName} 使用【模型微调】回血套盾+TK`,
    });
  }

  // 2) 空槽插件装配
  for (const card of actor.hand) {
    const def = CARD_DEFS[card.key];
    if (def.kind === 'equip' && !actor.equipment[def.slot] && !seenKeys.has(card.key)) {
      seenKeys.add(card.key);
      actions.push({
        kind: 'card',
        cardUid: card.uid,
        targetSeat: null,
        score: card.key === 'hotfix' ? 91 : card.key === 'overclock' ? 89 : 86,
        label: `装配插件【${def.name}】`,
      });
    }
  }

  // 3) 摸牌增幅（算力蒸馏 / 缓存命中 / 灵感涌现 / 版本回滚 / 集群共振 / 协同共鸣）
  const distill = actor.hand.find((c) => c.key === 'distill');
  if (distill) {
    actions.push({
      kind: 'card',
      cardUid: distill.uid,
      targetSeat: null,
      score: actor.tokens >= 1 ? 92 : 87,
      label: actor.tokens >= 1 ? '发动【算力蒸馏】耗 1 TK 狂摸 3 牌' : '发动【算力蒸馏】冷启动 +2 TK 摸 1 牌',
    });
  }

  const cluster = actor.hand.find((c) => c.key === 'cluster');
  if (cluster) {
    actions.push({
      kind: 'card',
      cardUid: cluster.uid,
      targetSeat: null,
      score: state.mode === 'duo2v2' ? 93 : actor.hp < actor.maxHp ? 90 : 81,
      label: '发动【集群共振】稳态回复/套盾并摸牌',
    });
  }

  const rollback = actor.hand.find((c) => c.key === 'rollback');
  if (rollback && state.discard.some((c) => c.key !== 'rollback')) {
    actions.push({
      kind: 'card',
      cardUid: rollback.uid,
      targetSeat: null,
      score: 86,
      label: '发动【版本回滚】打捞弃牌堆强牌并 +1 Token',
    });
  }

  const cache = actor.hand.find((c) => c.key === 'cache');
  if (cache) {
    actions.push({
      kind: 'card',
      cardUid: cache.uid,
      targetSeat: null,
      score: 90,
      label: '发动【缓存命中】摸牌并获得 2 层连摸充能',
    });
  }

  const draw2 = actor.hand.find((c) => c.key === 'draw2');
  if (draw2) {
    actions.push({
      kind: 'card',
      cardUid: draw2.uid,
      targetSeat: null,
      score: 88,
      label: '发动【灵感涌现】摸 2 张牌 +1 Token',
    });
  }

  const synergy = actor.hand.find((c) => c.key === 'synergy');
  if (synergy && bestAlly) {
    const isRealAlly = isStrictAlly(state, actor, bestAlly) || (actor.roleId === 'aligned' && bestAlly.roleId === 'architect');
    if (isRealAlly || actor.hand.length <= 2) {
      actions.push({
        kind: 'card',
        cardUid: synergy.uid,
        targetSeat: bestAlly.seat,
        score: isRealAlly ? 92 : 62,
        label: `与 ${bestAlly.shortName} 发动【协同共鸣】各摸 2 牌 +1 Token`,
      });
    }
  }

  // 4) 专属 Token 协议技
  const skillCheck = canUseActiveSkill(state, actor);
  if (skillCheck.ok) {
    const ch = CHARACTER_MAP[actor.charId];
    const shouldFire = actor.charId !== 'ai-glm' || actor.hand.some((c) => c.key === 'strike');
    if (shouldFire) {
      const needTarget = ch.needsTarget || (actor.charId === 'ai-claude' && CARD_DEFS[state.lastPlayedCardKey]?.needsTarget);
      const t = needTarget ? bestEnemy : null;
      if (!needTarget || t) {
        actions.push({
          kind: 'skill',
          targetSeat: t ? t.seat : null,
          score: 87,
          label: `消耗 ${skillCheck.cost} TK 发动协议技【${ch.activeName}】${t ? `目标 ${t.shortName}` : ''}`,
        });
      }
    }
  }

  // 5) 强力攻防控制锦囊（多模态连击 / 限流降频 / 破限强袭 / 沙盒隔离 / 幻觉嫁祸 / 提示词注入 / 上下文截断 / 镜像复制 / 幻觉死循环 / 流量洪峰 / 清空记忆）
  if (bestEnemy) {
    const jailbreak = actor.hand.find((c) => c.key === 'jailbreak');
    if (jailbreak) {
      const antiTank = bestEnemy.shields > 0 || Boolean(bestEnemy.equipment.defense);
      actions.push({
        kind: 'card',
        cardUid: jailbreak.uid,
        targetSeat: bestEnemy.seat,
        score: antiTank ? 91 : 78,
        label: `对 ${bestEnemy.shortName} 发动【破限强袭】${antiTank ? '碎盾卸防具+摸 1' : '1 点破防直伤'}`,
      });
    }

    const multimodal = actor.hand.find((c) => c.key === 'multimodal');
    if (multimodal) {
      actions.push({
        kind: 'card',
        cardUid: multimodal.uid,
        targetSeat: bestEnemy.seat,
        score: 86,
        label: `对 ${bestEnemy.shortName} 发动【多模态连击】双重星芒采样`,
      });
    }

    const rateLimit = actor.hand.find((c) => c.key === 'rate_limit');
    if (rateLimit) {
      actions.push({
        kind: 'card',
        cardUid: rateLimit.uid,
        targetSeat: bestEnemy.seat,
        score: bestEnemy.tokens >= 2 ? 88 : 76,
        label: `对 ${bestEnemy.shortName} 发动【限流降频】吸 TK 叠盾摸 1`,
      });
    }

    const sandbox = actor.hand.find((c) => c.key === 'sandbox');
    if (sandbox && !bestEnemy.delayedSandbox) {
      actions.push({
        kind: 'card',
        cardUid: sandbox.uid,
        targetSeat: bestEnemy.seat,
        score: bestEnemy.tokens >= 1 || bestEnemy.equipment.weapon ? 85 : 75,
        label: `对 ${bestEnemy.shortName} 植入【沙盒隔离】禁大招限杀+摸 1`,
      });
    }

    const redirect = actor.hand.find((c) => c.key === 'redirect');
    if (redirect) {
      actions.push({
        kind: 'card',
        cardUid: redirect.uid,
        targetSeat: bestEnemy.seat,
        score: 84 + (bestEnemy.shields > 0 ? 6 : 0),
        label: `对 ${bestEnemy.shortName} 发动【幻觉嫁祸】夺盾/TK 并直伤 1`,
      });
    }

    const inject = actor.hand.find((c) => c.key === 'inject');
    if (inject && (bestEnemy.hand.length > 0 || bestEnemy.tokens > 0)) {
      actions.push({
        kind: 'card',
        cardUid: inject.uid,
        targetSeat: bestEnemy.seat,
        score: 83,
        label: `对 ${bestEnemy.shortName} 发动【提示词注入】窃牌+夺 TK`,
      });
    }

    const truncate = actor.hand.find((c) => c.key === 'truncate');
    if (truncate && bestEnemy.hand.length >= 1) {
      actions.push({
        kind: 'card',
        cardUid: truncate.uid,
        targetSeat: bestEnemy.seat,
        score: 80 + Math.min(8, bestEnemy.hand.length * 2),
        label: `对 ${bestEnemy.shortName} 发动【上下文截断】随机弃 2 牌`,
      });
    }

    const clone = actor.hand.find((c) => c.key === 'clone');
    if (clone && bestEnemy.hand.length >= 1) {
      actions.push({
        kind: 'card',
        cardUid: clone.uid,
        targetSeat: bestEnemy.seat,
        score: 79,
        label: `对 ${bestEnemy.shortName} 发动【镜像复制】复刻手牌+摸 1`,
      });
    }

    const loop = actor.hand.find((c) => c.key === 'loop');
    if (loop && !bestEnemy.delayedLoop) {
      actions.push({
        kind: 'card',
        cardUid: loop.uid,
        targetSeat: bestEnemy.seat,
        score: 77,
        label: `对 ${bestEnemy.shortName} 植入【幻觉死循环】`,
      });
    }

    const reset = actor.hand.find((c) => c.key === 'reset');
    if (reset && bestEnemy.hand.length >= 4) {
      actions.push({
        kind: 'card',
        cardUid: reset.uid,
        targetSeat: bestEnemy.seat,
        score: 74,
        label: `对 ${bestEnemy.shortName} 发动【清空记忆】打乱其囤牌`,
      });
    }

    // 过载自爆：自身至少 3 血，或对面只剩 ≤ 2 血可斩杀且自己至少 2 血
    const overload = actor.hand.find((c) => c.key === 'overload');
    if (overload && actor.hp >= 2 && (actor.hp >= 3 || bestEnemy.hp <= 2)) {
      actions.push({
        kind: 'card',
        cardUid: overload.uid,
        targetSeat: bestEnemy.seat,
        score: bestEnemy.hp <= 2 ? 93 : 73,
        label: `对 ${bestEnemy.shortName} 引爆【过载自爆】（自损 1 轰 2 直伤）`,
      });
    }
  }

  const ddos = actor.hand.find((c) => c.key === 'ddos');
  if (ddos) {
    const arch = state.players.find((p) => p.roleId === 'architect');
    const safeForAligned = state.mode === 'duo2v2' || !(actor.roleId === 'aligned' && arch && arch.hp <= 2);
    if (safeForAligned) {
      actions.push({
        kind: 'card',
        cardUid: ddos.uid,
        targetSeat: null,
        score: state.mode === 'duo2v2' ? 85 : 76,
        label: '发动全场【流量洪峰】群体抗压',
      });
    }
  }

  // 6) 【暴击锐评】（可为不同敌方目标各提供一个战术选项供接待模型选择！）
  if (actor.turnFlags.strikesUsed < getStrikeLimit(state, actor)) {
    const strike = actor.hand.find((c) => c.key === 'strike');
    if (strike) {
      const enemies = state.players
        .filter((p) => p.alive && p.seat !== actor.seat && !isStrictAlly(state, actor, p))
        .sort((a, b) => scoreHostility(state, actor, b) - scoreHostility(state, actor, a))
        .slice(0, 2);
      enemies.forEach((enemy, idx) => {
        actions.push({
          kind: 'card',
          cardUid: strike.uid,
          targetSeat: enemy.seat,
          score: 70 - idx * 6 + (enemy.hp <= 1 ? 12 : 0),
          label: `对 ${enemy.shortName}（稳态${enemy.hp}）打出【暴击锐评】`,
        });
      });
    }
  }

  actions.sort((a, b) => b.score - a.score);
  const top = actions.slice(0, 5);
  top.push({
    kind: 'end',
    score: 0,
    label: '保留手牌并结束回合',
  });
  return top;
}

export function executeAiAction(state, actor, action, onStepDone) {
  if (!action || action.kind === 'end') {
    endCurrentTurn(state, onStepDone);
    return true;
  }
  if (action.kind === 'skill') {
    triggerActiveSkill(state, actor, { targetSeat: action.targetSeat }, onStepDone);
    return true;
  }
  if (action.kind === 'card') {
    playCard(state, actor, action.cardUid, action.targetSeat, onStepDone);
    return true;
  }
  endCurrentTurn(state, onStepDone);
  return true;
}

/* ── 默认内置规则 AI 单步执行（用于离线压测、未启用模型或超时降级） ── */
export function runOneAiActionStep(state, onStepDone) {
  if (state.scene !== 'playing' || state.prompt) return false;
  const actor = state.players[state.activeSeat];
  if (!actor || actor.isHuman || !actor.alive || state.phase !== 'play') return false;

  const candidates = getAiCandidateActions(state, actor);
  const best = candidates[0] || { kind: 'end' };
  return executeAiAction(state, actor, best, onStepDone);
}
