/**
 * 算力牌局 · Token Rumble — 战绩与胜率统计持久化（localStorage）
 */

const STORAGE_KEY = 'dimension_token_rumble_stats_v2';

function createEmptyStats() {
  return {
    totalGames: 0,
    wins: 0,
    currentStreak: 0,
    bestStreak: 0,
    byMode: {
      classic4: { games: 0, wins: 0 },
      duo2v2: { games: 0, wins: 0 },
      grand6: { games: 0, wins: 0 },
    },
    byChar: {},
    recent: [],
  };
}

export function loadStats() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return createEmptyStats();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return createEmptyStats();
    const base = createEmptyStats();
    return {
      totalGames: Number(parsed.totalGames) || 0,
      wins: Number(parsed.wins) || 0,
      currentStreak: Number(parsed.currentStreak) || 0,
      bestStreak: Number(parsed.bestStreak) || 0,
      byMode: {
        classic4: parsed.byMode?.classic4 || { games: 0, wins: 0 },
        duo2v2: parsed.byMode?.duo2v2 || { games: 0, wins: 0 },
        grand6: parsed.byMode?.grand6 || { games: 0, wins: 0 },
      },
      byChar: parsed.byChar && typeof parsed.byChar === 'object' ? parsed.byChar : {},
      recent: Array.isArray(parsed.recent) ? parsed.recent.slice(0, 12) : [],
    };
  } catch {
    return createEmptyStats();
  }
}

function saveStats(stats) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
  } catch {
    // 隐私模式或存储满时静默忽略
  }
}

export function recordMatchResult({
  mode = 'classic4',
  modeName = '4 人暗身份',
  charId = 'ai-gpt',
  charName = 'GPT 娘',
  roleId = 'architect',
  roleName = '架构师',
  won = false,
  rounds = 1,
  kills = 0,
  modelAssisted = false,
}) {
  const stats = loadStats();
  stats.totalGames += 1;
  if (won) {
    stats.wins += 1;
    stats.currentStreak += 1;
    if (stats.currentStreak > stats.bestStreak) {
      stats.bestStreak = stats.currentStreak;
    }
  } else {
    stats.currentStreak = 0;
  }

  if (!stats.byMode[mode]) {
    stats.byMode[mode] = { games: 0, wins: 0 };
  }
  stats.byMode[mode].games += 1;
  if (won) stats.byMode[mode].wins += 1;

  if (!stats.byChar[charId]) {
    stats.byChar[charId] = { games: 0, wins: 0, kills: 0 };
  }
  stats.byChar[charId].games += 1;
  if (won) stats.byChar[charId].wins += 1;
  stats.byChar[charId].kills += Number(kills) || 0;

  stats.recent.unshift({
    ts: Date.now(),
    mode,
    modeName,
    charId,
    charName,
    roleId,
    roleName,
    won: Boolean(won),
    rounds: Number(rounds) || 1,
    kills: Number(kills) || 0,
    modelAssisted: Boolean(modelAssisted),
  });
  stats.recent = stats.recent.slice(0, 12);

  saveStats(stats);
  return stats;
}

export function resetStats() {
  const empty = createEmptyStats();
  saveStats(empty);
  return empty;
}

export function formatWinRate(wins, games) {
  if (!games) return '0%';
  return `${Math.round((wins / games) * 100)}%`;
}
