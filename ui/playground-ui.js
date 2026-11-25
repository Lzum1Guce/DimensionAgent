/**
 * DimensionAgent — 游乐场（Playground）Steam Library 外壳、沙盒卡带库与多人多角色伴玩中枢
 * - 零 Emoji：全部使用 1.5px 极简线框 SVG 与精工排印
 * - 沙盒自动发现：自动拉取 /api/dimension/playground/sandbox（回落 /dimension-ui/playground-sandbox/catalog.json），点击游戏自动匹配沙盒入口
 * - 一键装入沙盒：支持直接把本地构建目录（如 dist）安全复制进隔离沙盒并自动注册
 * - 多人多角色同桌：支持 2~8 人游戏自由编组多名 DimensionAgent 角色落座，并实时同步主题与战局立绘联动
 */

const STORAGE_CUSTOM_KEY = 'dimension.playground.customGames.v2';
const STORAGE_META_KEY = 'dimension.playground.gameMeta.v2';
const STORAGE_PREFS_KEY = 'dimension.playground.prefs.v2';

const CHANNEL_META = {
  A: {
    code: 'SANDBOX A',
    label: '沙盒与本地卡带',
    short: 'A · 沙盒内嵌',
    group: 'local',
    transport: 'SANDBOX IFRAME / COPLAY-V1',
    boundary: '隔离沙盒静态托管 · 零宿主机写入',
  },
  B: {
    code: 'SANDBOX B',
    label: '沙盒与模拟器',
    short: 'B · 沙盒帧桥',
    group: 'sandbox',
    transport: 'WSL SANDBOX FRAME',
    boundary: '离线 Linux 沙盒 · 帧率与按键节流锁',
  },
  C: {
    code: 'PROTOCOL C',
    label: '联机协议搭子',
    short: 'C · 协议联机',
    group: 'protocol',
    transport: 'LOOPBACK SINGLE-PORT',
    boundary: '仅限 127.0.0.1 单端口 · 支持多人同服',
  },
  D: {
    code: 'BRIDGE D',
    label: '旁观与扩展槽',
    short: 'D · 扩展桥接',
    group: 'extension',
    transport: 'COPLAY / MCP BRIDGE',
    boundary: '只读事件监听 · 按预算限频解说',
  },
};

const GROUP_ORDER = [
  { id: 'recent', label: '近期游玩' },
  { id: 'local', label: '沙盒与本地卡带' },
  { id: 'sandbox', label: '沙盒与模拟器' },
  { id: 'protocol', label: '联机协议搭子' },
  { id: 'extension', label: '旁观与扩展槽' },
];

const ART_THEMES = {
  slate: {
    label: '石墨深蓝',
    posterBg: 'radial-gradient(circle at 78% 18%, rgba(96, 165, 250, 0.34), transparent 48%), linear-gradient(155deg, #171d2a 0%, #0e1118 62%, #0a0c11 100%)',
    heroBg: 'radial-gradient(ellipse 68% 90% at 76% 18%, rgba(96, 165, 250, 0.28), transparent 60%), linear-gradient(135deg, #161c29 0%, #0f1219 55%, #0b0d12 100%)',
    badgeBg: 'linear-gradient(135deg, #3b82f6, #1e3a5f)',
  },
  emerald: {
    label: '翡翠战棋',
    posterBg: 'radial-gradient(circle at 76% 20%, rgba(52, 211, 153, 0.30), transparent 48%), linear-gradient(155deg, #12241f 0%, #0d1514 62%, #090d0d 100%)',
    heroBg: 'radial-gradient(ellipse 68% 90% at 74% 18%, rgba(52, 211, 153, 0.25), transparent 60%), linear-gradient(135deg, #11231e 0%, #0e1413 55%, #0a0d0e 100%)',
    badgeBg: 'linear-gradient(135deg, #10b981, #114b3c)',
  },
  violet: {
    label: '星轨秘境',
    posterBg: 'radial-gradient(circle at 80% 22%, rgba(167, 139, 250, 0.32), transparent 50%), linear-gradient(155deg, #1e182e 0%, #12101c 62%, #0a0a10 100%)',
    heroBg: 'radial-gradient(ellipse 68% 90% at 78% 20%, rgba(167, 139, 250, 0.26), transparent 60%), linear-gradient(135deg, #1d182c 0%, #11101a 55%, #0b0b10 100%)',
    badgeBg: 'linear-gradient(135deg, #8b5cf6, #3b2667)',
  },
  amber: {
    label: '赤铜棋盘',
    posterBg: 'radial-gradient(circle at 74% 20%, rgba(251, 191, 36, 0.26), transparent 48%), linear-gradient(155deg, #271f14 0%, #15120e 62%, #0d0c0a 100%)',
    heroBg: 'radial-gradient(ellipse 68% 90% at 75% 18%, rgba(251, 191, 36, 0.22), transparent 60%), linear-gradient(135deg, #241c13 0%, #14120f 55%, #0d0c0b 100%)',
    badgeBg: 'linear-gradient(135deg, #d97706, #5c3a14)',
  },
  steel: {
    label: '冷钢极简',
    posterBg: 'radial-gradient(circle at 75% 22%, rgba(203, 213, 225, 0.24), transparent 46%), linear-gradient(155deg, #1d2129 0%, #111319 62%, #0a0b0f 100%)',
    heroBg: 'radial-gradient(ellipse 68% 90% at 75% 20%, rgba(203, 213, 225, 0.20), transparent 60%), linear-gradient(135deg, #1c2028 0%, #111318 55%, #0b0c10 100%)',
    badgeBg: 'linear-gradient(135deg, #64748b, #28303d)',
  },
};

const ROLE_META = {
  opponent:  { label: '对手', desc: '全神贯注与你切磋对弈，并在关键转折处犀利点评。' },
  partner:   { label: '搭子', desc: '并肩推进关卡与配合，主动分担协作与情绪陪伴。' },
  tactician: { label: '军师', desc: '专注局势推演与思路复盘，不越权代劳你的决策。' },
};

const MOOD_LIST = [
  { id: 'neutral',  label: '常态' },
  { id: 'happy',    label: '开心' },
  { id: 'serious',  label: '认真' },
  { id: 'playful',  label: '调皮' },
  { id: 'shocked',  label: '惊呆' },
  { id: 'gloomy',   label: '失落' },
];

const FALLBACK_BOTS = [
  { id: 'ai-claude',   name: 'Claude',   tagline: '细致耐心的策略复盘搭档' },
  { id: 'ai-deepseek', name: 'DeepSeek', tagline: '深度演算的硬核棋手' },
  { id: 'ai-gemini',   name: 'Gemini',   tagline: '灵感跳跃的创意陪玩伙伴' },
  { id: 'ai-grok',     name: 'Grok',     tagline: '嘴硬心软的高能吐槽对手' },
  { id: 'ai-gpt',      name: 'GPT',      tagline: '全面稳健的全局军师' },
  { id: 'ai-kimi',     name: 'Kimi',     tagline: '擅长记规则与长局推演' },
  { id: 'ai-qwen',     name: 'Qwen',     tagline: '条理清晰的协作伙伴' },
  { id: 'ai-glm',      name: 'GLM',      tagline: '干脆利落的节奏控场者' },
];

const FALLBACK_SLOTS = [
  {
    id: 'slot-sandbox-retro',
    code: 'SLOT-B1',
    title: '沙盒复古机与单机槽位',
    subtitle: 'WSL Sandbox Frame Bridge',
    description: '面向运行在 WSL 沙盒内的掌机模拟器或回合制 Roguelike 单机，采用视觉帧采样与安全键鼠限频桥接。',
    channel: 'B',
    theme: 'amber',
    players: 2,
    maxCompanions: 1,
    multiplayer: false,
    entryUrl: '',
    coverUrl: '',
    defaultRole: 'tactician',
    defaultBotIds: ['ai-gemini'],
    builtin: true,
  },
  {
    id: 'slot-minecraft-lan',
    code: 'SLOT-C1',
    title: 'Minecraft 多人联机搭子',
    subtitle: 'Loopback Multi-Bot Squad',
    description: '承接 Minecraft 本地局域网协议机器人，支持最多 4 位角色同时进服分工挖矿、建家与探险，严格锁定 127.0.0.1 单端口。',
    channel: 'C',
    theme: 'emerald',
    players: 5,
    maxCompanions: 4,
    multiplayer: true,
    entryUrl: '',
    coverUrl: '',
    defaultRole: 'partner',
    defaultBotIds: ['ai-grok', 'ai-claude', 'ai-gemini'],
    builtin: true,
  },
  {
    id: 'slot-spectator-mcp',
    code: 'SLOT-D1',
    title: '旁观解说与扩展卡带槽位',
    subtitle: 'External Bridge / MCP Slot',
    description: '为独立桌面端游戏或自定义 MCP 游戏插件预留的多人解说席，支持 1~3 位角色同席吐槽与复盘。',
    channel: 'D',
    theme: 'steel',
    players: 4,
    maxCompanions: 3,
    multiplayer: true,
    entryUrl: '',
    coverUrl: '',
    defaultRole: 'tactician',
    defaultBotIds: ['ai-gpt', 'ai-kimi'],
    builtin: true,
  },
];

/* ── 极简线框 SVG 图标库（全站零 Emoji） ── */
const ICONS = {
  grid: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.25" y="2.25" width="4.5" height="4.5" rx="1"/><rect x="9.25" y="2.25" width="4.5" height="4.5" rx="1"/><rect x="2.25" y="9.25" width="4.5" height="4.5" rx="1"/><rect x="9.25" y="9.25" width="4.5" height="4.5" rx="1"/></svg>',
  search: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.4 10.4 3.1 3.1"/></svg>',
  close: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2.5 2.5 9.5 9.5M9.5 2.5 2.5 9.5"/></svg>',
  chevron: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5"/></svg>',
  plus: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 3.25v9.5M3.25 8h9.5"/></svg>',
  play: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.2 2.85a.75.75 0 0 1 1.14-.64l8.1 5.15a.75.75 0 0 1 0 1.28l-8.1 5.15a.75.75 0 0 1-1.14-.64V2.85Z"/></svg>',
  back: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.5 5.5 8 10 12.5"/></svg>',
  sliders: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4.5h7M12 4.5h1.5M2.5 11.5h2M7 11.5h6.5"/><circle cx="10.75" cy="4.5" r="1.4"/><circle cx="5.75" cy="11.5" r="1.4"/></svg>',
  volumeOn: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6h2.6l3.4-2.75v9.5L5.1 10H2.5V6Z"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.9 3.6a6 6 0 0 1 0 8.8"/></svg>',
  volumeOff: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6h2.6l3.4-2.75v9.5L5.1 10H2.5V6Z"/><path d="m11 6 3 4m0-4-3 4"/></svg>',
  shield: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2 13 4v4.2c0 2.9-2.1 5-5 5.8-2.9-.8-5-2.9-5-5.8V4L8 2Z"/></svg>',
  link: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 9.5 9.5 6.5M5.3 7.2 3.8 8.7a2.5 2.5 0 1 0 3.5 3.5l1.5-1.5M10.7 8.8l1.5-1.5a2.5 2.5 0 0 0-3.5-3.5L7.2 5.3"/></svg>',
  book: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3.25h7.75A2.25 2.25 0 0 1 13 5.5v7.25H5.25A2.25 2.25 0 0 0 3 15V3.25Z"/><path d="M3 12.75h10"/></svg>',
  panelRight: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.8"/><path d="M10.5 2.5v11"/></svg>',
  users: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5.5" r="2.2"/><path d="M2 13a4 4 0 0 1 8 0"/><circle cx="11.4" cy="6.2" r="1.7"/><path d="M11.6 10.2a3 3 0 0 1 2.6 2.8"/></svg>',
  box: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2 13.5 5v6L8 14 2.5 11V5L8 2Z"/><path d="M8 8v6M2.5 5 8 8l5.5-3"/></svg>',
  emblemA: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="10" y="10" width="44" height="44" rx="8"/><path d="M10 24h44M10 38h44M24 10v44M38 10v44"/><circle cx="31" cy="31" r="4"/></svg>',
  emblemB: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="8" y="16" width="48" height="32" rx="10"/><path d="M22 26v12M16 32h12"/><circle cx="43" cy="29" r="2.6"/><circle cx="48" cy="35" r="2.6"/></svg>',
  emblemC: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.6"><polygon points="32,8 54,20 54,44 32,56 10,44 10,20"/><path d="M32 8v48M10 20l22 12 22-12"/></svg>',
  emblemD: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="32" cy="32" r="20"/><circle cx="32" cy="32" r="8"/><path d="M32 6v8M32 50v8M6 32h8M50 32h8"/></svg>',
};

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isSafeEntryUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return true;
  if (s.startsWith('/')) return true;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function currentAppThemeMode() {
  const t = document.documentElement.dataset.theme || 'paperlight';
  return (t === 'codex' || t === 'nightink') ? 'dark' : 'light';
}

function formatDuration(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m === 0) return '0.0 小时';
  if (m < 60) return `${m} 分钟`;
  return `${(m / 60).toFixed(1)} 小时`;
}

function formatTimer(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatTimeShort(ts) {
  if (!ts) return '尚未启动';
  try {
    const d = new Date(ts);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '最近';
  }
}

function spriteUrl(botId, mood = 'neutral') {
  const cleanId = String(botId || 'ai-claude').trim();
  const known = new Set(['ai-claude', 'ai-deepseek', 'ai-gemini', 'ai-glm', 'ai-gpt', 'ai-grok', 'ai-kimi', 'ai-qwen']);
  const folder = known.has(cleanId) ? cleanId : 'ai-claude';
  return `/dimension-ui/gal-sprites/${folder}/${mood}.webp`;
}

function emblemForChannel(ch) {
  if (ch === 'B') return ICONS.emblemB;
  if (ch === 'C') return ICONS.emblemC;
  if (ch === 'D') return ICONS.emblemD;
  return ICONS.emblemA;
}

function readJson(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null');
    if (parsed !== null && parsed !== undefined) return parsed;
  } catch {}
  return fallback;
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function normalizeGame(raw) {
  const players = Math.max(1, Math.min(8, Number(raw.players) || 2));
  const maxCompanions = Math.max(1, Math.min(7, Number(raw.maxCompanions) || Math.max(1, players - 1)));
  const defaultBotIds = Array.isArray(raw.defaultBotIds) && raw.defaultBotIds.length
    ? raw.defaultBotIds
    : [raw.defaultBotId || 'ai-claude'];
  return {
    id: String(raw.id),
    packageId: raw.packageId || '',
    code: raw.code || 'GAME',
    title: raw.title || raw.id,
    subtitle: raw.subtitle || 'Sandbox Cartridge',
    description: raw.description || '',
    channel: CHANNEL_META[raw.channel] ? raw.channel : 'A',
    theme: ART_THEMES[raw.theme] ? raw.theme : 'slate',
    players,
    maxCompanions,
    multiplayer: Boolean(raw.multiplayer ?? (players > 2)),
    entryUrl: String(raw.entryUrl || ''),
    coverUrl: String(raw.coverUrl || ''),
    defaultRole: ROLE_META[raw.defaultRole] ? raw.defaultRole : 'partner',
    defaultBotIds,
    sandboxInstalled: Boolean(raw.sandboxInstalled),
    source: raw.source || (raw.builtin ? 'slot' : 'custom'),
    builtin: Boolean(raw.builtin),
  };
}

export function createPlaygroundController({ sidebarHost, stageHost, getBots, onSetSidebarCollapsed } = {}) {
  let active = false;
  let sandboxGames = [];
  let customGames = readJson(STORAGE_CUSTOM_KEY, []);
  let metaByGame = readJson(STORAGE_META_KEY, {});
  const prefs = {
    view: 'home', // home | detail | live
    selectedId: '',
    filter: 'all', // all | ready | multi | A | B | C | D
    search: '',
    collapsedGroups: {},
    companionsByGame: {}, // gameId -> string[] (ordered seats!)
    roleByGame: {},
    voiceEnabled: true,
    receptionEnabled: true,
    ...readJson(STORAGE_PREFS_KEY, {}),
  };

  let receptionState = {
    checked: false,
    nativeApi: false,
    ready: false,
    providerId: '',
    model: '',
    reason: '',
    busy: false,
    lastAutoEventAt: 0,
  };

  let sessionNumber = 0;
  let liveSession = new AbortController();
  let receptionRevision = 0;
  let liveState = {
    startedAt: 0,
    timerId: null,
    cinemaMode: false,
    focusBotId: '',
    moodByBot: {},
    banter: [],
    recentEvents: [],
    groupChatAll: true,
    prevSidebarCollapsed: null,
  };

  let modalState = {
    open: false,
    editingId: null,
    tab: 'sandbox', // sandbox | url
  };
  let modalRoot = null;

  function botsList() {
    const raw = typeof getBots === 'function' ? getBots() : [];
    const map = new Map();
    if (Array.isArray(raw)) {
      for (const b of raw) {
        if (b?.id && /^ai-/.test(b.id)) {
          map.set(b.id, {
            id: b.id,
            name: b.name || b.id.replace(/^ai-/, ''),
            tagline: b.tagline || b.description || '已就绪的伴玩伙伴',
          });
        }
      }
    }
    for (const fb of FALLBACK_BOTS) {
      if (!map.has(fb.id)) map.set(fb.id, fb);
      else if (!map.get(fb.id).tagline) map.get(fb.id).tagline = fb.tagline;
    }
    return [...map.values()];
  }

  function mergedGames() {
    const map = new Map();
    for (const raw of sandboxGames) {
      const g = normalizeGame(raw);
      map.set(g.id, g);
    }
    for (const raw of customGames) {
      const g = normalizeGame(raw);
      const prev = map.get(g.id);
      map.set(g.id, prev ? { ...prev, ...g, sandboxInstalled: prev.sandboxInstalled || g.sandboxInstalled } : g);
    }
    for (const raw of FALLBACK_SLOTS) {
      const g = normalizeGame(raw);
      if (!map.has(g.id)) map.set(g.id, g);
    }
    return [...map.values()].map((g) => {
      const meta = metaByGame[g.id] || {};
      return {
        ...g,
        playMinutes: Number(meta.playMinutes || 0),
        sessions: Number(meta.sessions || 0),
        lastPlayedAt: Number(meta.lastPlayedAt || 0),
        journal: Array.isArray(meta.journal) && meta.journal.length
          ? meta.journal
          : [{
              at: g.sandboxInstalled ? '沙盒自动匹配' : '槽位就绪',
              author: '系统',
              text: g.sandboxInstalled
                ? `已从沙盒目录自动匹配入口（支持 ${g.players} 人桌，最多 ${g.maxCompanions} 位角色同席）。`
                : '配置本地入口或一键装入沙盒构建目录即可启动。',
            }],
      };
    });
  }

  function currentGame() {
    const all = mergedGames();
    return all.find((g) => g.id === prefs.selectedId) || all[0] || null;
  }

  function companionsFor(game) {
    const bots = botsList();
    if (!game) return bots.slice(0, 1);
    const maxN = Math.max(1, Number(game.maxCompanions) || 1);
    const saved = prefs.companionsByGame?.[game.id];
    let ids = Array.isArray(saved) && saved.length ? saved : game.defaultBotIds;
    ids = ids.filter((id) => bots.some((b) => b.id === id)).slice(0, maxN);
    if (!ids.length) ids = [bots[0]?.id || 'ai-claude'];
    return ids.map((id, idx) => {
      const b = bots.find((item) => item.id === id) || bots[0];
      return { ...b, seat: idx + 1 };
    });
  }

  function roleFor(game) {
    const raw = prefs.roleByGame?.[game?.id] || game?.defaultRole || 'partner';
    return ROLE_META[raw] ? raw : 'partner';
  }

  function persist() {
    writeJson(STORAGE_CUSTOM_KEY, customGames);
    writeJson(STORAGE_META_KEY, metaByGame);
    writeJson(STORAGE_PREFS_KEY, {
      selectedId: prefs.selectedId,
      filter: prefs.filter,
      collapsedGroups: prefs.collapsedGroups,
      companionsByGame: prefs.companionsByGame,
      roleByGame: prefs.roleByGame,
      voiceEnabled: prefs.voiceEnabled,
      receptionEnabled: prefs.receptionEnabled,
    });
  }

  function receptionBadgeLabel() {
    const shortModel = receptionState.model
      ? receptionState.model.split('/').pop().slice(0, 22)
      : '';
    const cliTag = receptionState.protocol === 'cli-reception' ? 'CLI · ' : '';
    if (!prefs.receptionEnabled) return '接待模型 · 已暂停';
    if (receptionState.nativeApi && receptionState.ready) {
      return `接待模型 · ${cliTag}${shortModel || '已自动接入'}`;
    }
    if (!receptionState.nativeApi && receptionState.ready && shortModel) {
      return `接待模型 · ${cliTag}${shortModel}（重启直通）`;
    }
    if (receptionState.checked) return '接待模型 · 未配置接口';
    return '接待模型 · 检测中';
  }

  async function refreshReceptionModel(botId = '') {
    const revision = ++receptionRevision;
    const query = botId ? `?botId=${encodeURIComponent(botId)}` : '';
    try {
      const res = await fetch(`/api/dimension/playground/reception-model${query}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (revision !== receptionRevision) return receptionState;
        receptionState = {
          ...receptionState,
          checked: true,
          nativeApi: true,
          ready: Boolean(data?.ready),
          providerId: String(data?.providerId || ''),
          model: String(data?.model || ''),
          protocol: String(data?.protocol || ''),
          cliEngineId: String(data?.cliEngineId || ''),
          reason: String(data?.reason || ''),
        };
        if (active) renderStage();
        const g = currentGame();
        if (prefs.view === 'live' && g) pushRosterToFrame(g, companionsFor(g));
        return receptionState;
      }
    } catch {}
    // 兼容尚未重启的新/老后端：自动从 /api/dimension/bootstrap 识别接待模型状态
    try {
      const res = await fetch('/api/dimension/bootstrap', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (revision !== receptionRevision) return receptionState;
        receptionState = {
          ...receptionState,
          checked: true,
          nativeApi: false,
          ready: Boolean(data?.model?.ready && data?.model?.model),
          providerId: String(data?.model?.activeProvider || ''),
          model: String(data?.model?.model || ''),
          reason: '需重启软件以启用原生游乐场接待模型通道',
        };
        if (active) renderStage();
        return receptionState;
      }
    } catch {}
    if (revision === receptionRevision) receptionState = { ...receptionState, checked: true };
    return receptionState;
  }

  async function requestReceptionReply({ bot, roleLabel, game, mode = 'chat', userMessage = '', eventText = '', gameContext = '' }) {
    if (!prefs.receptionEnabled || !receptionState.nativeApi || !receptionState.ready) return null;
    try {
      const res = await fetch('/api/dimension/playground/coplay-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: liveSession.signal,
        body: JSON.stringify({
          botId: bot.id,
          botName: bot.name,
          role: roleLabel,
          gameTitle: game?.title || '游乐场',
          mode,
          userMessage,
          eventText,
          gameContext: gameContext || liveState.recentEvents.slice(-3).join('；'),
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data?.ok && data.reply) return data;
    } catch {}
    return null;
  }

  function ensureMeta(gameId) {
    if (!metaByGame[gameId]) metaByGame[gameId] = { playMinutes: 0, sessions: 0, lastPlayedAt: 0, journal: [] };
    return metaByGame[gameId];
  }

  async function refreshSandboxCatalog() {
    let loaded = null;
    try {
      const res = await fetch('/api/dimension/playground/sandbox', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data?.games)) loaded = data.games;
      }
    } catch {}
    if (!loaded) {
      try {
        const res = await fetch(`/dimension-ui/playground-sandbox/catalog.json?_=${Date.now()}`, { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.games)) loaded = data.games;
        }
      } catch {}
    }
    if (Array.isArray(loaded)) {
      sandboxGames = loaded;
      if (!prefs.selectedId && sandboxGames[0]?.id) prefs.selectedId = sandboxGames[0].id;
      if (active) render();
    }
  }

  function buildRuntimeEntryUrl(game, seated) {
    const raw = String(game.entryUrl || '').trim();
    if (!raw || !isSafeEntryUrl(raw)) return '';
    try {
      const url = new URL(raw, window.location.origin);
      url.searchParams.set('embed', '1');
      url.searchParams.set('theme', currentAppThemeMode());
      const roleLabel = ROLE_META[roleFor(game)].label;
      const payload = seated.map((b) => ({ seat: b.seat, id: b.id, name: b.name, role: roleLabel }));
      url.searchParams.set('companions', JSON.stringify(payload));
      return raw.startsWith('/') ? `${url.pathname}${url.search}${url.hash}` : url.toString();
    } catch {
      return raw;
    }
  }

  function pushRosterToFrame(game, seated) {
    const frame = stageHost?.querySelector('#pgLiveFrame');
    if (!frame?.contentWindow) return;
    const roleLabel = ROLE_META[roleFor(game)].label;
    try {
      frame.contentWindow.postMessage({
        protocol: 'dimension-coplay-v1',
        type: 'coplay:roster',
        companions: seated.map((b) => ({ seat: b.seat, id: b.id, name: b.name, role: roleLabel })),
      }, '*');
      frame.contentWindow.postMessage({
        protocol: 'dimension-coplay-v1',
        type: 'coplay:theme',
        theme: currentAppThemeMode(),
      }, '*');
      frame.contentWindow.postMessage({
        protocol: 'dimension-coplay-v1',
        type: 'coplay:model',
        ready: Boolean(receptionState.ready && receptionState.nativeApi && prefs.receptionEnabled),
        model: receptionState.model || '',
        providerId: receptionState.providerId || '',
      }, '*');
    } catch {}
  }

  function stopLiveTimer() {
    if (liveState.timerId) {
      clearInterval(liveState.timerId);
      liveState.timerId = null;
    }
  }

  function renderSidebar() {
    if (!sidebarHost) return;
    const allGames = mergedGames();
    const q = String(prefs.search || '').trim().toLowerCase();
    const filtered = allGames.filter((g) => {
      if (!q) return true;
      const ch = CHANNEL_META[g.channel] || CHANNEL_META.A;
      return (
        g.title.toLowerCase().includes(q) ||
        (g.subtitle || '').toLowerCase().includes(q) ||
        (g.code || '').toLowerCase().includes(q) ||
        ch.label.toLowerCase().includes(q)
      );
    });

    const recentGames = filtered
      .filter((g) => g.lastPlayedAt > 0)
      .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
      .slice(0, 4);

    const groupsHtml = GROUP_ORDER.map((grp) => {
      const items = grp.id === 'recent'
        ? recentGames
        : filtered.filter((g) => (CHANNEL_META[g.channel]?.group || 'local') === grp.id);
      if (!items.length) return '';
      const collapsed = Boolean(prefs.collapsedGroups?.[grp.id]);
      return `
        <section class="pg-sb-group${collapsed ? ' is-collapsed' : ''}" data-pg-group="${esc(grp.id)}">
          <button type="button" class="pg-sb-group-head" data-pg-toggle-group="${esc(grp.id)}">
            <span class="pg-sb-group-chevron">${ICONS.chevron}</span>
            <span>${esc(grp.label)}</span>
            <span class="pg-sb-group-count pg-num">${items.length}</span>
          </button>
          <div class="pg-sb-group-list">
            ${items.map((g) => {
              const art = ART_THEMES[g.theme] || ART_THEMES.slate;
              const isSelected = prefs.view !== 'home' && prefs.selectedId === g.id;
              const isReady = Boolean(String(g.entryUrl || '').trim());
              return `
                <div class="pg-sb-item${isSelected ? ' is-active' : ''}" data-pg-open-game="${esc(g.id)}" title="${esc(g.title)}" role="button" tabindex="0">
                  <span class="pg-sb-item-badge" style="background:${art.badgeBg}">${esc(g.players)}P</span>
                  <span class="pg-sb-item-title">${esc(g.title)}</span>
                  <button type="button" class="pg-sb-play" data-pg-launch="${esc(g.id)}" title="${isReady ? '直接开始游玩' : '打开舞台'}" aria-label="开始 ${esc(g.title)}">${ICONS.play}</button>
                  <span class="pg-sb-dot${isReady ? ' is-ready' : ''}" title="${isReady ? '沙盒/入口已就绪' : '待挂载'}"></span>
                </div>
              `;
            }).join('')}
          </div>
        </section>
      `;
    }).join('');

    sidebarHost.innerHTML = `
      <div class="pg-sb-top">
        <button type="button" class="pg-sb-home-btn${prefs.view === 'home' ? ' is-active' : ''}" data-pg-go-home="1">
          ${ICONS.grid}
          <span>游乐场主页</span>
          <span class="pg-sb-home-count pg-num">${allGames.length}</span>
        </button>
        <div class="pg-sb-search-wrap">
          <span class="pg-sb-search-icon">${ICONS.search}</span>
          <input type="text" class="pg-sb-search" id="pgSidebarSearch" value="${esc(prefs.search)}" placeholder="筛选卡带或人数…" autocomplete="off" aria-label="筛选游戏卡带">
          ${prefs.search ? `<button type="button" class="pg-sb-search-clear" data-pg-clear-search="1" aria-label="清空搜索">${ICONS.close}</button>` : ''}
        </div>
      </div>
      <div class="pg-sb-tree thin-scroll">
        ${groupsHtml || '<div style="padding:18px 10px;font-size:12px;color:var(--color-ink-tertiary);text-align:center;">未找到匹配的游戏卡带</div>'}
      </div>
      <div class="pg-sb-foot">
        <button type="button" class="pg-sb-add-btn" data-pg-add-game="1">
          ${ICONS.box}
          <span>装入沙盒 / 接入游戏</span>
        </button>
      </div>
    `;
  }

  function renderHomeView() {
    const allGames = mergedGames();
    const readyCount = allGames.filter((g) => String(g.entryUrl || '').trim()).length;
    const recent = [...allGames]
      .sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0) || Number(b.sandboxInstalled) - Number(a.sandboxInstalled))
      .slice(0, 3);

    const visibleGames = allGames.filter((g) => {
      if (prefs.filter === 'all') return true;
      if (prefs.filter === 'ready') return Boolean(String(g.entryUrl || '').trim());
      if (prefs.filter === 'multi') return g.maxCompanions > 1;
      return g.channel === prefs.filter;
    });

    const filterButtons = [
      { id: 'all', label: '全部' },
      { id: 'ready', label: '沙盒就绪' },
      { id: 'multi', label: '多人同桌' },
      { id: 'A', label: '沙盒卡带' },
      { id: 'B', label: '模拟器' },
      { id: 'C', label: '协议联机' },
    ];

    return `
      <div class="pg-scroll-view thin-scroll">
        <div class="pg-home-shell">
          <header class="pg-home-header">
            <div>
              <div class="pg-home-kicker">DIMENSION PLAYGROUND · SANDBOX &amp; MULTI-COMPANION</div>
              <h1 class="pg-home-title">游乐场</h1>
              <p class="pg-home-subtitle">将游戏直接装入本地隔离沙盒，点击任意游戏自动匹配入口，并支持多位角色同桌伴玩。</p>
            </div>
            <div class="pg-home-actions">
              <span class="pg-reception-pill${receptionState.ready && prefs.receptionEnabled ? ' is-live' : ''}" title="${esc(receptionState.reason || '自动复用当前已配置的接待模型 API')}">
                <span class="pg-dot"></span>
                <span>${esc(receptionBadgeLabel())}</span>
              </span>
              <span class="pg-tag pg-num">沙盒就绪 ${readyCount} / ${allGames.length}</span>
              <button type="button" class="pg-btn is-primary" data-pg-add-game="1">
                ${ICONS.box}
                <span>装入沙盒游戏</span>
              </button>
            </div>
          </header>

          <section class="pg-section" aria-label="快速开桌">
            <div class="pg-section-head">
              <h2 class="pg-section-title">快速开桌</h2>
            </div>
            <div class="pg-recent-strip">
              ${recent.map((g) => {
                const art = ART_THEMES[g.theme] || ART_THEMES.slate;
                const seated = companionsFor(g);
                const isReady = Boolean(String(g.entryUrl || '').trim());
                return `
                  <article class="pg-recent-card" data-pg-open-game="${esc(g.id)}">
                    <div class="pg-recent-thumb" style="background:${art.posterBg}">
                      ${g.coverUrl ? `<img src="${esc(g.coverUrl)}" alt="">` : ''}
                      <span class="pg-recent-thumb-code">${esc(g.code || 'GAME')}</span>
                    </div>
                    <div class="pg-recent-meta">
                      <div class="pg-recent-name">${esc(g.title)}</div>
                      <div class="pg-recent-sub">
                        <span class="pg-num">${g.players}人桌</span>
                        <span>·</span>
                        <span>${isReady ? (g.sandboxInstalled ? '沙盒自动匹配' : '已绑定入口') : '待配置入口'}</span>
                      </div>
                      <div class="pg-recent-companion">
                        <span class="pg-mini-avatars-stack">
                          ${seated.map((b) => `<img class="pg-mini-avatar" src="${esc(spriteUrl(b.id, 'neutral'))}" alt="">`).join('')}
                        </span>
                        <span>${esc(seated.map((b) => b.name).join(' · '))}</span>
                      </div>
                    </div>
                    <button type="button" class="pg-recent-start" data-pg-launch="${esc(g.id)}">
                      ${ICONS.play}
                      <span>开始</span>
                    </button>
                  </article>
                `;
              }).join('')}
            </div>
          </section>

          <section class="pg-section" aria-label="全部游戏库">
            <div class="pg-section-head">
              <h2 class="pg-section-title">游戏库 <span class="pg-num">(${visibleGames.length})</span></h2>
              <div class="pg-filter-pills" role="tablist" aria-label="游戏分类筛选">
                ${filterButtons.map((btn) => `
                  <button type="button" class="pg-filter-pill${prefs.filter === btn.id ? ' is-active' : ''}" data-pg-filter="${esc(btn.id)}">${esc(btn.label)}</button>
                `).join('')}
              </div>
            </div>
            <div class="pg-poster-grid">
              ${visibleGames.map((g) => {
                const art = ART_THEMES[g.theme] || ART_THEMES.slate;
                const seated = companionsFor(g);
                const isReady = Boolean(String(g.entryUrl || '').trim());
                const bgStyle = g.coverUrl
                  ? `background-image:url('${esc(g.coverUrl)}')`
                  : `background:${art.posterBg}`;
                return `
                  <article class="pg-poster-card" data-pg-open-game="${esc(g.id)}">
                    <div class="pg-poster-bg" style="${bgStyle}"></div>
                    <div class="pg-poster-gridlines"></div>
                    <div class="pg-poster-emblem">${emblemForChannel(g.channel)}</div>
                    <div class="pg-poster-vignette"></div>
                    <div class="pg-poster-top">
                      <span class="pg-players-badge">${g.players}P · ${g.maxCompanions > 1 ? '多人' : '单挑'}</span>
                      <span class="pg-status-pill${isReady ? ' is-ready' : ''}">
                        <span class="pg-dot"></span>
                        <span>${g.sandboxInstalled ? '沙盒就绪' : isReady ? '已挂载' : '槽位'}</span>
                      </span>
                    </div>
                    <div class="pg-poster-bottom">
                      <span class="pg-poster-code">${esc(g.code || 'CARTRIDGE')}</span>
                      <h3 class="pg-poster-title">${esc(g.title)}</h3>
                      <div class="pg-poster-tagline">${esc(g.subtitle)}</div>
                      <div class="pg-poster-meta-row">
                        <span>${esc(seated.length > 1 ? `${seated.length} 位伙伴同桌` : seated[0].name)}</span>
                        <span class="pg-num">${formatDuration(g.playMinutes)}</span>
                      </div>
                      <div class="pg-poster-actions">
                        <button type="button" class="pg-poster-play-btn${isReady ? ' is-ready' : ''}" data-pg-launch="${esc(g.id)}">
                          ${ICONS.play}
                          <span>${isReady ? '开始游玩' : '配置入口'}</span>
                        </button>
                        <button type="button" class="pg-poster-detail-btn" data-pg-open-game="${esc(g.id)}">详情</button>
                      </div>
                    </div>
                  </article>
                `;
              }).join('')}
              <button type="button" class="pg-poster-add" data-pg-add-game="1">
                <span class="pg-poster-add-icon">${ICONS.plus}</span>
                <strong>装入新游戏到沙盒</strong>
                <span>选择本地构建目录或绑定端口，自动匹配入口与多人席位</span>
              </button>
            </div>
          </section>
        </div>
      </div>
    `;
  }

  function renderDetailView(game) {
    const art = ART_THEMES[game.theme] || ART_THEMES.slate;
    const ch = CHANNEL_META[game.channel] || CHANNEL_META.A;
    const bots = botsList();
    const seated = companionsFor(game);
    const seatedMap = new Map(seated.map((b) => [b.id, b.seat]));
    const activeRoleKey = roleFor(game);
    const activeRole = ROLE_META[activeRoleKey];
    const isReady = Boolean(String(game.entryUrl || '').trim());
    const isMulti = game.maxCompanions > 1;
    const heroBgStyle = game.coverUrl
      ? `background-image:url('${esc(game.coverUrl)}')`
      : `background:${art.heroBg}`;

    return `
      <div class="pg-scroll-view thin-scroll">
        <section class="pg-detail-hero">
          <div class="pg-hero-bg" style="${heroBgStyle}"></div>
          <div class="pg-hero-grid"></div>
          <div class="pg-hero-fade"></div>
          <div class="pg-hero-topbar">
            <button type="button" class="pg-hero-back" data-pg-go-home="1">
              ${ICONS.back}
              <span>返回游乐场主页</span>
            </button>
            <button type="button" class="pg-hero-config" data-pg-edit-game="${esc(game.id)}">
              ${ICONS.sliders}
              <span>配置卡带</span>
            </button>
          </div>
          <div class="pg-hero-content">
            <div class="pg-hero-titles">
              <div class="pg-hero-badges">
                <span class="pg-channel-chip">${esc(ch.code)} · ${game.players} 人局</span>
                <span class="pg-status-pill${isReady ? ' is-ready' : ''}">
                  <span class="pg-dot"></span>
                  <span>${gStatusLabel(game)}</span>
                </span>
              </div>
              <h1 class="pg-hero-name">${esc(game.title)}</h1>
              <p class="pg-hero-desc">${esc(game.description || '沙盒游戏卡带，支持多角色同桌入席与战局联动。')}</p>
            </div>
          </div>
        </section>

        <div class="pg-action-bar-wrap">
          <div class="pg-action-bar">
            <div class="pg-action-left">
              <button type="button" class="pg-play-cta" data-pg-launch="${esc(game.id)}">
                ${ICONS.play}
                <span>${isReady ? '开始游玩' : '进入舞台配置'}</span>
              </button>

              <div class="pg-companion-inline" aria-label="陪玩席位选择">
                <span class="pg-inline-label pg-num">
                  ${isMulti ? `同桌席位 ${seated.length}/${game.maxCompanions}` : '陪玩席位'}
                </span>
                <div class="pg-avatar-strip">
                  ${bots.map((b) => {
                    const seatNum = seatedMap.get(b.id);
                    return `
                      <button type="button" class="pg-bot-chip${seatNum ? ' is-selected' : ''}" data-pg-pick-bot="${esc(b.id)}" title="${esc(b.name)} · ${seatNum ? `已在 ${seatNum} 号位` : (isMulti ? '点击加入同桌' : '点击切换伙伴')}">
                        <img src="${esc(spriteUrl(b.id, 'neutral'))}" alt="${esc(b.name)}">
                        ${isMulti && seatNum ? `<span class="pg-seat-badge">${seatNum}</span>` : ''}
                      </button>
                    `;
                  }).join('')}
                </div>
                ${isMulti && seated.length < game.maxCompanions ? `<button type="button" class="pg-autofill-btn" data-pg-autofill="1">一键满桌</button>` : ''}
                <div class="pg-role-seg" role="group" aria-label="陪玩身份">
                  ${Object.entries(ROLE_META).map(([key, meta]) => `
                    <button type="button" class="pg-role-opt${key === activeRoleKey ? ' is-active' : ''}" data-pg-pick-role="${esc(key)}">${esc(meta.label)}</button>
                  `).join('')}
                </div>
                <button type="button" class="pg-voice-toggle${prefs.voiceEnabled ? ' is-on' : ''}" data-pg-toggle-voice="1">
                  ${prefs.voiceEnabled ? ICONS.volumeOn : ICONS.volumeOff}
                  <span>${prefs.voiceEnabled ? '语音开' : '静音'}</span>
                </button>
              </div>
            </div>

            <div class="pg-stats-row">
              <div class="pg-stat-cell">
                <span class="pg-stat-label">同玩时长</span>
                <span class="pg-stat-value">${formatDuration(game.playMinutes)}</span>
              </div>
              <div class="pg-stat-cell">
                <span class="pg-stat-label">支持人数</span>
                <span class="pg-stat-value">${game.players} 人（最多 ${game.maxCompanions} AI）</span>
              </div>
              <div class="pg-stat-cell">
                <span class="pg-stat-label">最近游玩</span>
                <span class="pg-stat-value">${formatTimeShort(game.lastPlayedAt)}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="pg-detail-body">
          <div class="pg-col">
            <section class="pg-panel">
              <div class="pg-panel-head">
                <h2 class="pg-panel-title">${ICONS.link} <span>沙盒自动匹配入口与协议</span></h2>
                <button type="button" class="pg-btn is-sm" data-pg-edit-game="${esc(game.id)}">修改入口</button>
              </div>
              <div class="pg-kv-grid">
                <div class="pg-kv-box">
                  <span class="pg-kv-k">自动匹配入口 (Sandbox Entry)</span>
                  <span class="pg-kv-v${isReady ? '' : ' is-empty'}" title="${esc(game.entryUrl || '未绑定')}">${esc(game.entryUrl || '未绑定 · 点右上角配置或装入沙盒')}</span>
                </div>
                <div class="pg-kv-box">
                  <span class="pg-kv-k">多人联动协议</span>
                  <span class="pg-kv-v">dimension-coplay-v1 (roster + theme)</span>
                </div>
                <div class="pg-kv-box">
                  <span class="pg-kv-k">承载方式</span>
                  <span class="pg-kv-v">${esc(game.sandboxInstalled ? 'LOCAL SANDBOX PACKAGE' : ch.transport)}</span>
                </div>
                <div class="pg-kv-box">
                  <span class="pg-kv-k">卡带编号</span>
                  <span class="pg-kv-v">${esc(game.code || game.id)}</span>
                </div>
              </div>
            </section>

            <section class="pg-panel">
              <div class="pg-panel-head">
                <h2 class="pg-panel-title">${ICONS.book} <span>对局手账与同行记录</span></h2>
                <span class="pg-tag pg-num">${(game.journal || []).length} 条记录</span>
              </div>
              <form class="pg-journal-form" id="pgJournalForm">
                <input type="text" class="pg-input" id="pgJournalInput" placeholder="记录一笔多人名场面、通关笔记或卡带备忘…" autocomplete="off">
                <button type="submit" class="pg-btn is-sm is-primary">记入</button>
              </form>
              <div class="pg-journal-list">
                ${(game.journal || []).map((entry) => `
                  <article class="pg-journal-item">
                    <div class="pg-journal-meta">
                      <span>${esc(entry.author || '记录')}</span>
                      <span class="pg-num">${esc(entry.at || '')}</span>
                    </div>
                    <div class="pg-journal-text">${esc(entry.text)}</div>
                  </article>
                `).join('')}
              </div>
            </section>
          </div>

          <div class="pg-col">
            <section class="pg-panel">
              <div class="pg-panel-head">
                <h2 class="pg-panel-title">${ICONS.users} <span>本桌入席伙伴（${seated.length} 位）</span></h2>
                <span class="pg-tag">${esc(activeRole.label)}</span>
              </div>
              <div class="pg-roster-grid">
                ${seated.map((b) => `
                  <div class="pg-roster-member">
                    <div class="pg-roster-portrait">
                      <img src="${esc(spriteUrl(b.id, 'neutral'))}" alt="${esc(b.name)}">
                    </div>
                    <div class="pg-roster-info">
                      <strong><span>${esc(b.name)}</span><span class="pg-seat-tag">${b.seat}号位</span></strong>
                      <small>${esc(b.tagline)}</small>
                    </div>
                  </div>
                `).join('')}
              </div>
            </section>

            <section class="pg-panel">
              <div class="pg-panel-head">
                <h2 class="pg-panel-title">${ICONS.shield} <span>沙盒隔离边界</span></h2>
              </div>
              <div class="pg-boundary-list">
                <div class="pg-boundary-row">
                  <span>承载通道</span>
                  <span class="pg-boundary-val">${esc(ch.code)}</span>
                </div>
                <div class="pg-boundary-row">
                  <span>边界策略</span>
                  <span class="pg-boundary-val">${esc(ch.boundary)}</span>
                </div>
                <div class="pg-boundary-row">
                  <span>主题同步</span>
                  <span class="pg-boundary-val">AUTO (${currentAppThemeMode().toUpperCase()})</span>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    `;
  }

  function gStatusLabel(game) {
    if (game.sandboxInstalled) return '已装入沙盒 · 自动匹配入口';
    if (String(game.entryUrl || '').trim()) return '外部入口已绑定';
    return '等待装入沙盒或绑定地址';
  }

  function renderLiveView(game) {
    const seated = companionsFor(game);
    const focusBot = seated.find((b) => b.id === liveState.focusBotId) || seated[0];
    const focusMood = liveState.moodByBot[focusBot.id] || 'neutral';
    const role = ROLE_META[roleFor(game)];
    const elapsed = liveState.startedAt ? Math.floor((Date.now() - liveState.startedAt) / 1000) : 0;
    const runtimeUrl = buildRuntimeEntryUrl(game, seated);
    const validEntry = Boolean(runtimeUrl);
    const isMulti = seated.length > 1;

    return `
      <div class="pg-live-shell" data-session="${sessionNumber}">
        <header class="pg-live-bar">
          <div class="pg-live-bar-left">
            <button type="button" class="pg-btn is-sm is-ghost" data-pg-exit-live="1">
              ${ICONS.back}
              <span>结束并返回</span>
            </button>
            <span class="pg-live-title">${esc(game.title)}</span>
            <span class="pg-live-pill">
              <span class="pg-live-dot"></span>
              <span id="pgLiveClock">${formatTimer(elapsed)}</span>
            </span>
            <span class="pg-tag pg-num">${game.sandboxInstalled ? '沙盒运行中' : '外部挂载'} · ${1 + seated.length}人桌</span>
            <button type="button" class="pg-reception-pill${receptionState.ready && prefs.receptionEnabled ? ' is-live' : ''}" data-pg-toggle-reception="1" title="${esc(receptionState.reason || '点击切换接待模型 API 自动实时回应')}">
              <span class="pg-dot"></span>
              <span>${esc(receptionBadgeLabel())}</span>
            </button>
          </div>
          <div class="pg-live-bar-right">
            <button type="button" class="pg-btn is-sm" data-pg-edit-game="${esc(game.id)}">
              ${ICONS.sliders}
              <span>卡带设置</span>
            </button>
            <button type="button" class="pg-btn is-sm" data-pg-toggle-cinema="1">
              ${ICONS.panelRight}
              <span>${liveState.cinemaMode ? '显示伴玩席' : '全宽画布'}</span>
            </button>
          </div>
        </header>

        <div class="pg-live-body${liveState.cinemaMode ? ' is-cinema' : ''}">
          <div class="pg-canvas-pane">
            ${validEntry
              ? `<iframe class="pg-live-frame" id="pgLiveFrame" src="${esc(runtimeUrl)}" title="${esc(game.title)}" allow="autoplay; gamepad; fullscreen"></iframe>`
              : `
                <div class="pg-mount-empty">
                  <div class="pg-mount-card">
                    <span class="pg-tag" style="align-self:flex-start;">等待装入沙盒或入口</span>
                    <h3>挂载你的游戏画面</h3>
                    <p>粘贴本地游戏地址或点击右上「卡带设置」将构建目录直接装入本地沙盒，右侧 ${esc(seated.map((b) => b.name).join('、'))} 已全部就位。</p>
                    <form class="pg-mount-row" id="pgQuickMountForm">
                      <input type="text" class="pg-input" id="pgQuickMountInput" placeholder="http://127.0.0.1:5173" value="${esc(game.entryUrl || '')}" autocomplete="off">
                      <button type="submit" class="pg-btn is-primary">立即挂载</button>
                    </form>
                  </div>
                </div>
              `
            }
          </div>

          <aside class="pg-companion-rail" aria-label="多角色伴玩席">
            ${isMulti ? `
              <div class="pg-live-roster-bar thin-scroll" role="tablist" aria-label="同桌角色切换">
                ${seated.map((b) => `
                  <button type="button" class="pg-live-seat-pill${b.id === focusBot.id ? ' is-focus' : ''}" data-pg-focus-bot="${esc(b.id)}">
                    <img src="${esc(spriteUrl(b.id, liveState.moodByBot[b.id] || 'neutral'))}" alt="">
                    <span class="pg-live-seat-num">${b.seat}</span>
                    <span>${esc(b.name)}</span>
                  </button>
                `).join('')}
              </div>
            ` : ''}

            <div class="pg-sprite-stage">
              <img class="pg-sprite-img" id="pgSpriteImg" src="${esc(spriteUrl(focusBot.id, focusMood))}" alt="${esc(focusBot.name)}">
              <div class="pg-sprite-overlay">
                <div class="pg-sprite-who">
                  <strong>${esc(focusBot.name)}${isMulti ? ` · ${focusBot.seat}号位` : ''}</strong>
                  <span>${esc(role.label)} · ${prefs.voiceEnabled ? '语音联动开' : '静默陪伴'}</span>
                </div>
                <span class="pg-tag">${esc((MOOD_LIST.find((m) => m.id === focusMood) || MOOD_LIST[0]).label)}</span>
              </div>
            </div>

            <div class="pg-mood-strip thin-scroll" role="group" aria-label="立绘情绪">
              ${MOOD_LIST.map((m) => `
                <button type="button" class="pg-mood-btn${m.id === focusMood ? ' is-active' : ''}" data-pg-mood="${esc(m.id)}">${esc(m.label)}</button>
              `).join('')}
            </div>

            <div class="pg-banter-feed thin-scroll" id="pgBanterFeed">
              ${liveState.banter.map((msg) => `
                <div class="pg-banter-msg${msg.kind === 'user' ? ' is-user' : msg.kind === 'system' ? ' is-system' : ''}">
                  ${msg.sender ? `<div class="pg-banter-sender">${esc(msg.sender)}</div>` : ''}
                  <div>${esc(msg.text)}</div>
                </div>
              `).join('')}
            </div>

            <form class="pg-banter-form" id="pgBanterForm">
              <input type="text" class="pg-input" id="pgBanterInput" placeholder="${isMulti ? '对全桌伙伴聊两句战局…' : `跟 ${esc(focusBot.name)} 聊两句战局…`}" autocomplete="off">
              <button type="submit" class="pg-btn is-sm is-primary">发送</button>
            </form>
          </aside>
        </div>
      </div>
    `;
  }

  function renderStage() {
    if (!stageHost) return;
    if (prefs.view === 'live') {
      const g = currentGame();
      if (g) {
        const prevFrameSrc = stageHost.querySelector('#pgLiveFrame')?.getAttribute('src') || '';
        const seated = companionsFor(g);
        const nextUrl = buildRuntimeEntryUrl(g, seated);
        // 若 iframe 地址未变且已在 live 视图，尽量只局部刷新右侧伴玩席避免重刷正在玩的游戏！
        const existingRail = stageHost.querySelector('.pg-companion-rail');
        if (existingRail?.closest('.pg-live-shell')?.dataset.session === String(sessionNumber)) {
          const temp = document.createElement('div');
          temp.innerHTML = renderLiveView(g);
          const freshRail = temp.querySelector('.pg-companion-rail');
          const freshBar = temp.querySelector('.pg-live-bar');
          const liveBody = stageHost.querySelector('.pg-live-body');
          // Keep the composer attached so focus, selection and IME composition survive updates.
          const form = existingRail.querySelector('#pgBanterForm');
          const input = form.querySelector('input');
          input.placeholder = freshRail.querySelector('#pgBanterInput').placeholder;
          for (const node of [...existingRail.children]) if (node !== form) node.remove();
          for (const node of [...freshRail.children]) if (node.id !== 'pgBanterForm') existingRail.insertBefore(node, form);
          if (prevFrameSrc !== (nextUrl || '')) {
            liveBody.querySelector('.pg-canvas-pane').replaceWith(temp.querySelector('.pg-canvas-pane'));
            liveBody.querySelector('iframe')?.addEventListener('load', () => pushRosterToFrame(g, seated), { once: true });
          }
          if (freshBar) stageHost.querySelector('.pg-live-bar')?.replaceWith(freshBar);
          if (liveBody) liveBody.classList.toggle('is-cinema', liveState.cinemaMode);
          const feed = stageHost.querySelector('#pgBanterFeed');
          if (feed) feed.scrollTop = feed.scrollHeight;
          return;
        }
        stageHost.innerHTML = renderLiveView(g);
        const frame = stageHost.querySelector('#pgLiveFrame');
        frame?.addEventListener('load', () => pushRosterToFrame(g, seated), { once: true });
        const feed = stageHost.querySelector('#pgBanterFeed');
        if (feed) feed.scrollTop = feed.scrollHeight;
        return;
      }
      prefs.view = 'home';
    }
    if (prefs.view === 'detail') {
      const g = currentGame();
      if (g) {
        stageHost.innerHTML = renderDetailView(g);
        return;
      }
      prefs.view = 'home';
    }
    stageHost.innerHTML = renderHomeView();
  }

  function ensureModalRoot() {
    if (modalRoot && modalRoot.isConnected) return modalRoot;
    modalRoot = document.createElement('div');
    modalRoot.className = 'pg-modal-mask';
    modalRoot.id = 'pgCartridgeModal';
    modalRoot.hidden = true;
    document.body.appendChild(modalRoot);

    modalRoot.addEventListener('click', (event) => {
      if (event.target === modalRoot || event.target.closest('[data-pg-modal-close]')) {
        closeModal();
        return;
      }
      const tabBtn = event.target.closest('[data-pg-modal-tab]');
      if (tabBtn) {
        modalState.tab = tabBtn.dataset.pgModalTab;
        openModal(modalState.editingId, modalState.tab);
        return;
      }
      const delBtn = event.target.closest('[data-pg-delete-game]');
      if (delBtn) {
        const id = delBtn.dataset.pgDeleteGame;
        customGames = customGames.filter((g) => g.id !== id);
        if (prefs.selectedId === id) {
          prefs.selectedId = mergedGames()[0]?.id || '';
          prefs.view = 'home';
        }
        persist();
        closeModal();
        render();
      }
    });

    modalRoot.addEventListener('submit', async (event) => {
      const sbForm = event.target.closest('#pgSandboxInstallForm');
      if (sbForm) {
        event.preventDefault();
        const fd = new FormData(sbForm);
        const err = sbForm.querySelector('#pgFormError');
        const submitBtn = sbForm.querySelector('button[type="submit"]');
        const payload = {
          sourceDir: String(fd.get('sourceDir') || '').trim(),
          packageId: String(fd.get('packageId') || '').trim(),
          title: String(fd.get('title') || '').trim(),
          subtitle: String(fd.get('subtitle') || '').trim() || 'Installed Sandbox Game',
          description: String(fd.get('description') || '').trim(),
          players: Number(fd.get('players') || 4),
          theme: String(fd.get('theme') || 'slate'),
        };
        if (!payload.sourceDir) return;
        if (err) { err.hidden = true; err.textContent = ''; }
        if (submitBtn) submitBtn.disabled = true;
        try {
          const res = await fetch('/api/dimension/playground/sandbox/install', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data?.error || data?.message || `装入沙盒失败（HTTP ${res.status}）`);
          await refreshSandboxCatalog();
          prefs.selectedId = `sb-${data.packageId}`;
          prefs.view = 'detail';
          persist();
          closeModal();
          render();
        } catch (e) {
          if (err) {
            err.hidden = false;
            err.textContent = e?.message || '当前后端版本尚未重启加载沙盒安装接口，请重启客户端后再试，或先切到「绑定入口 URL」标签页。';
          }
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
        return;
      }

      const form = event.target.closest('#pgCartridgeForm');
      if (!form) return;
      event.preventDefault();
      const fd = new FormData(form);
      const title = String(fd.get('title') || '').trim();
      const entryUrl = String(fd.get('entryUrl') || '').trim();
      if (!title) return;
      if (entryUrl && !isSafeEntryUrl(entryUrl)) {
        const err = form.querySelector('#pgFormError');
        if (err) { err.hidden = false; err.textContent = '入口地址必须以 http://、https:// 或 / 开头。'; }
        return;
      }
      const players = Math.max(1, Math.min(8, Number(fd.get('players') || 2)));
      const patch = {
        title,
        subtitle: String(fd.get('subtitle') || '').trim() || 'External Cartridge',
        description: String(fd.get('description') || '').trim(),
        channel: CHANNEL_META[fd.get('channel')] ? String(fd.get('channel')) : 'A',
        theme: ART_THEMES[fd.get('theme')] ? String(fd.get('theme')) : 'slate',
        players,
        maxCompanions: Math.max(1, players - 1),
        multiplayer: players > 2,
        entryUrl,
        coverUrl: String(fd.get('coverUrl') || '').trim(),
      };
      if (modalState.editingId) {
        const idx = customGames.findIndex((g) => g.id === modalState.editingId);
        const existing = mergedGames().find((g) => g.id === modalState.editingId);
        const merged = { ...(existing || {}), ...patch, id: modalState.editingId };
        if (idx >= 0) customGames[idx] = merged;
        else customGames.unshift(merged);
        prefs.selectedId = modalState.editingId;
      } else {
        const id = `custom-${Date.now().toString(36)}`;
        customGames.unshift({
          id,
          code: `EXT-${String(mergedGames().length + 1).padStart(2, '0')}`,
          defaultRole: 'partner',
          defaultBotIds: players > 2 ? ['ai-claude', 'ai-gemini'] : ['ai-claude'],
          ...patch,
        });
        prefs.selectedId = id;
        prefs.view = 'detail';
      }
      persist();
      closeModal();
      render();
    });

    return modalRoot;
  }

  function openModal(editingId = null, forceTab = null) {
    const item = editingId ? mergedGames().find((g) => g.id === editingId) : null;
    const tab = forceTab || (item ? 'url' : 'sandbox');
    modalState = { open: true, editingId, tab };
    const root = ensureModalRoot();
    root.innerHTML = `
      <div class="pg-modal" role="dialog" aria-modal="true" aria-labelledby="pgModalTitle">
        <div class="pg-modal-head">
          <h3 id="pgModalTitle">${item ? '配置游戏卡带' : '装入沙盒 / 接入外部游戏'}</h3>
          <button type="button" class="pg-btn is-sm is-ghost" data-pg-modal-close="1" aria-label="关闭">${ICONS.close}</button>
        </div>
        ${!item ? `
          <div style="padding:12px 20px 0;">
            <div class="pg-modal-tabs">
              <button type="button" class="pg-modal-tab${tab === 'sandbox' ? ' is-active' : ''}" data-pg-modal-tab="sandbox">装入本地沙盒（推荐）</button>
              <button type="button" class="pg-modal-tab${tab === 'url' ? ' is-active' : ''}" data-pg-modal-tab="url">绑定本地 / 远端 URL</button>
            </div>
          </div>
        ` : ''}
        ${tab === 'sandbox' && !item ? `
          <form id="pgSandboxInstallForm">
            <div class="pg-modal-body thin-scroll">
              <div class="pg-field">
                <label for="pgSrcDir">游戏构建目录（含 index.html 的 dist 目录）</label>
                <input id="pgSrcDir" name="sourceDir" class="pg-input" required placeholder="例如：F:\\my-game\\dist">
                <small>后端会将目录安全复制到隔离沙盒中永久托管，彻底脱离外部 dev server，点哪个游戏自动匹配入口。</small>
              </div>
              <div class="pg-field-row">
                <div class="pg-field">
                  <label for="pgSbTitle">游戏名称</label>
                  <input id="pgSbTitle" name="title" class="pg-input" required placeholder="例如：星海桌游">
                </div>
                <div class="pg-field">
                  <label for="pgSbPlayers">总人数（决定可入席 AI 数）</label>
                  <select id="pgSbPlayers" name="players" class="pg-select">
                    <option value="2">2 人局（你 + 1 位角色）</option>
                    <option value="3">3 人局（你 + 2 位角色）</option>
                    <option value="4" selected>4 人局（你 + 3 位角色）</option>
                    <option value="6">6 人局（你 + 5 位角色）</option>
                    <option value="8">8 人局（你 + 7 位角色）</option>
                  </select>
                </div>
              </div>
              <div class="pg-field-row">
                <div class="pg-field">
                  <label for="pgSbId">沙盒目录标识（可选）</label>
                  <input id="pgSbId" name="packageId" class="pg-input" placeholder="自动生成，如 star-game">
                </div>
                <div class="pg-field">
                  <label for="pgSbTheme">封面主色调</label>
                  <select id="pgSbTheme" name="theme" class="pg-select">
                    ${Object.entries(ART_THEMES).map(([k, m]) => `<option value="${esc(k)}">${esc(m.label)}</option>`).join('')}
                  </select>
                </div>
              </div>
              <div class="pg-field">
                <label for="pgSbDesc">简介说明</label>
                <textarea id="pgSbDesc" name="description" class="pg-textarea" rows="2" placeholder="简述玩法与多人分工…"></textarea>
              </div>
              <div id="pgFormError" hidden style="color:var(--color-danger);font-size:12px;"></div>
            </div>
            <div class="pg-modal-foot">
              <span></span>
              <div class="pg-modal-foot-right">
                <button type="button" class="pg-btn is-sm" data-pg-modal-close="1">取消</button>
                <button type="submit" class="pg-btn is-sm is-primary">装入沙盒并上架</button>
              </div>
            </div>
          </form>
        ` : `
          <form id="pgCartridgeForm">
            <div class="pg-modal-body thin-scroll">
              <div class="pg-field">
                <label for="pgFTitle">游戏名称</label>
                <input id="pgFTitle" name="title" class="pg-input" required value="${esc(item?.title || '')}" placeholder="例如：算力牌局 / 星牌阵营战 / 我的桌游">
              </div>
              <div class="pg-field">
                <label for="pgFUrl">入口地址（沙盒路径或本地 URL）</label>
                <input id="pgFUrl" name="entryUrl" class="pg-input" value="${esc(item?.entryUrl || '')}" placeholder="例如：/dimension-ui/playground-sandbox/... 或 http://127.0.0.1:7100/?embed=1">
              </div>
              <div class="pg-field-row">
                <div class="pg-field">
                  <label for="pgFPlayers">总人数</label>
                  <select id="pgFPlayers" name="players" class="pg-select">
                    ${[2, 3, 4, 5, 6, 8].map((n) => `<option value="${n}"${(item?.players || 4) === n ? ' selected' : ''}>${n} 人桌（最多 ${n - 1} 位角色）</option>`).join('')}
                  </select>
                </div>
                <div class="pg-field">
                  <label for="pgFChannel">接入通道</label>
                  <select id="pgFChannel" name="channel" class="pg-select">
                    ${Object.entries(CHANNEL_META).map(([k, m]) => `
                      <option value="${esc(k)}"${(item?.channel || 'A') === k ? ' selected' : ''}>${esc(m.code)} · ${esc(m.label)}</option>
                    `).join('')}
                  </select>
                </div>
              </div>
              <div class="pg-field-row">
                <div class="pg-field">
                  <label for="pgFTheme">海报主色调</label>
                  <select id="pgFTheme" name="theme" class="pg-select">
                    ${Object.entries(ART_THEMES).map(([k, m]) => `
                      <option value="${esc(k)}"${(item?.theme || 'slate') === k ? ' selected' : ''}>${esc(m.label)}</option>
                    `).join('')}
                  </select>
                </div>
                <div class="pg-field">
                  <label for="pgFSub">副标题 / 标签</label>
                  <input id="pgFSub" name="subtitle" class="pg-input" value="${esc(item?.subtitle || '')}" placeholder="例如：4P Identity Strategy">
                </div>
              </div>
              <div class="pg-field">
                <label for="pgFCover">自定义封面图 URL（可选）</label>
                <input id="pgFCover" name="coverUrl" class="pg-input" value="${esc(item?.coverUrl || '')}" placeholder="留空将自动使用精工几何海报">
              </div>
              <div class="pg-field">
                <label for="pgFDesc">简介说明</label>
                <textarea id="pgFDesc" name="description" class="pg-textarea" rows="2">${esc(item?.description || '')}</textarea>
              </div>
              <div id="pgFormError" hidden style="color:var(--color-danger);font-size:12px;"></div>
            </div>
            <div class="pg-modal-foot">
              ${item && !item.sandboxInstalled && !item.builtin ? `<button type="button" class="pg-btn is-sm is-danger" data-pg-delete-game="${esc(item.id)}">移出游戏库</button>` : '<span></span>'}
              <div class="pg-modal-foot-right">
                <button type="button" class="pg-btn is-sm" data-pg-modal-close="1">取消</button>
                <button type="submit" class="pg-btn is-sm is-primary">${item ? '保存配置' : '添加到游戏库'}</button>
              </div>
            </div>
          </form>
        `}
      </div>
    `;
    root.hidden = false;
  }

  function closeModal() {
    modalState = { open: false, editingId: null, tab: 'sandbox' };
    if (modalRoot) modalRoot.hidden = true;
  }

  function companionReply(bot, roleKey, userText, isFollowUp = false) {
    const t = String(userText || '').trim();
    if (isFollowUp) {
      return `附议！我在 ${bot.seat} 号位也盯着这波呢，关于「${t}」我来配合收尾。`;
    }
    if (roleKey === 'opponent') {
      return `收到「${t}」——我在 ${bot.seat} 号位可不会手软，放马过来。`;
    }
    if (roleKey === 'tactician') {
      return `明白，针对「${t}」，建议先控好手牌节奏并留意下家动作。`;
    }
    return `没问题，我在 ${bot.seat} 号位陪着你——关于「${t}」，咱们稳稳推进。`;
  }

  function resetLiveSession() {
    ++sessionNumber;
    liveSession.abort();
    liveSession = new AbortController();
    ++receptionRevision;
    receptionState.busy = false;
    receptionState.lastAutoEventAt = 0;
  }

  function launchGame(id) {
    const game = mergedGames().find((g) => g.id === id);
    if (!game) return;
    prefs.selectedId = game.id;
    resetLiveSession();
    prefs.view = 'live';
    const meta = ensureMeta(game.id);
    meta.sessions = (Number(meta.sessions) || 0) + 1;
    meta.lastPlayedAt = Date.now();
    const seated = companionsFor(game);
    const role = ROLE_META[roleFor(game)];

    const appEl = document.getElementById('app');
    liveState.prevSidebarCollapsed = appEl?.classList.contains('is-sidebar-collapsed') || false;
    onSetSidebarCollapsed?.(true);

    liveState.startedAt = Date.now();
    liveState.cinemaMode = false;
    liveState.focusBotId = seated[0]?.id || 'ai-claude';
    liveState.moodByBot = Object.fromEntries(seated.map((b) => [b.id, 'neutral']));
    liveState.recentEvents = [];
    void refreshReceptionModel(liveState.focusBotId);
    liveState.banter = [
      {
        kind: 'system',
        text: `SANDBOX CO-PLAY · ${game.code} · ${seated.map((b) => `${b.seat}号位 ${b.name}`).join(' / ')}`,
      },
      ...seated.slice(0, 2).map((b, idx) => ({
        kind: 'bot',
        sender: `${b.name} · ${b.seat}号位 · ${role.label}`,
        text: idx === 0
          ? `已入席「${game.title}」${b.seat}号位${game.sandboxInstalled ? '（沙盒自动匹配就绪）' : ''}，随时开局！`
          : `我也落座 ${b.seat} 号位啦，这桌人齐了，开打吧！`,
      })),
    ];

    stopLiveTimer();
    liveState.timerId = setInterval(() => {
      const clock = stageHost?.querySelector('#pgLiveClock');
      if (clock && liveState.startedAt) {
        clock.textContent = formatTimer((Date.now() - liveState.startedAt) / 1000);
      }
    }, 1000);
    persist();
    render();
  }

  function exitLive() {
    resetLiveSession();
    stopLiveTimer();
    const game = currentGame();
    if (game && liveState.startedAt) {
      const meta = ensureMeta(game.id);
      const mins = Math.max(1, Math.round((Date.now() - liveState.startedAt) / 60000));
      meta.playMinutes = (Number(meta.playMinutes) || 0) + mins;
      meta.lastPlayedAt = Date.now();
    }
    liveState.startedAt = 0;
    if (liveState.prevSidebarCollapsed === false) {
      onSetSidebarCollapsed?.(false);
    }
    liveState.prevSidebarCollapsed = null;
    prefs.view = 'detail';
    persist();
    render();
  }

  function render() {
    if (!active) return;
    renderSidebar();
    renderStage();
  }

  /* ── 事件委托（零内联 onclick，严格 CSP 合规） ── */
  sidebarHost?.addEventListener('click', (event) => {
    const toggleGrp = event.target.closest('[data-pg-toggle-group]');
    if (toggleGrp) {
      const gid = toggleGrp.dataset.pgToggleGroup;
      prefs.collapsedGroups[gid] = !prefs.collapsedGroups[gid];
      persist();
      renderSidebar();
      return;
    }
    if (event.target.closest('[data-pg-go-home]')) {
      if (prefs.view === 'live') exitLive();
      prefs.view = 'home';
      render();
      return;
    }
    if (event.target.closest('[data-pg-clear-search]')) {
      prefs.search = '';
      renderSidebar();
      return;
    }
    if (event.target.closest('[data-pg-add-game]')) {
      openModal(null);
      return;
    }
    const sbLaunch = event.target.closest('[data-pg-launch]');
    if (sbLaunch) {
      event.stopPropagation();
      launchGame(sbLaunch.dataset.pgLaunch);
      return;
    }
    const openBtn = event.target.closest('[data-pg-open-game]');
    if (openBtn) {
      if (prefs.view === 'live') exitLive();
      prefs.selectedId = openBtn.dataset.pgOpenGame;
      prefs.view = 'detail';
      persist();
      render();
    }
  });

  sidebarHost?.addEventListener('input', (event) => {
    if (event.target.id === 'pgSidebarSearch') {
      prefs.search = event.target.value;
      const pos = event.target.selectionStart || prefs.search.length;
      renderSidebar();
      const nextInput = sidebarHost.querySelector('#pgSidebarSearch');
      if (nextInput) {
        nextInput.focus();
        nextInput.setSelectionRange(pos, pos);
      }
    }
  });

  stageHost?.addEventListener('click', (event) => {
    if (event.target.closest('[data-pg-add-game]')) { openModal(null); return; }
    if (event.target.closest('[data-pg-go-home]')) {
      if (prefs.view === 'live') exitLive();
      prefs.view = 'home';
      render();
      return;
    }
    const filterBtn = event.target.closest('[data-pg-filter]');
    if (filterBtn) {
      prefs.filter = filterBtn.dataset.pgFilter;
      persist();
      renderStage();
      return;
    }
    if (event.target.closest('[data-pg-toggle-reception]')) {
      prefs.receptionEnabled = !prefs.receptionEnabled;
      persist();
      const g = currentGame();
      if (prefs.view === 'live' && g) pushRosterToFrame(g, companionsFor(g));
      renderStage();
      return;
    }
    const launchBtn = event.target.closest('[data-pg-launch]');
    if (launchBtn) {
      event.stopPropagation();
      launchGame(launchBtn.dataset.pgLaunch);
      return;
    }
    const editBtn = event.target.closest('[data-pg-edit-game]');
    if (editBtn) { openModal(editBtn.dataset.pgEditGame); return; }
    const openBtn = event.target.closest('[data-pg-open-game]');
    if (openBtn) {
      prefs.selectedId = openBtn.dataset.pgOpenGame;
      prefs.view = 'detail';
      persist();
      render();
      return;
    }
    if (event.target.closest('[data-pg-exit-live]')) { exitLive(); return; }
    if (event.target.closest('[data-pg-toggle-cinema]')) {
      liveState.cinemaMode = !liveState.cinemaMode;
      renderStage();
      return;
    }

    // 多人圆桌选角：单人局替换，多人局多选加入/移出最多 maxCompanions 位
    const pickBot = event.target.closest('[data-pg-pick-bot]');
    if (pickBot) {
      const g = currentGame();
      if (!g) return;
      const bid = pickBot.dataset.pgPickBot;
      const currentList = companionsFor(g).map((b) => b.id);
      if (g.maxCompanions <= 1) {
        prefs.companionsByGame[g.id] = [bid];
      } else {
        if (currentList.includes(bid)) {
          if (currentList.length > 1) {
            prefs.companionsByGame[g.id] = currentList.filter((id) => id !== bid);
          }
        } else if (currentList.length < g.maxCompanions) {
          prefs.companionsByGame[g.id] = [...currentList, bid];
        } else {
          // 已满桌时滚动替换最早的一位，保持丝滑无阻塞
          prefs.companionsByGame[g.id] = [...currentList.slice(1), bid];
        }
      }
      persist();
      renderStage();
      return;
    }

    // 一键满桌
    if (event.target.closest('[data-pg-autofill]')) {
      const g = currentGame();
      if (!g) return;
      const currentList = companionsFor(g).map((b) => b.id);
      const pool = botsList().map((b) => b.id).filter((id) => !currentList.includes(id));
      prefs.companionsByGame[g.id] = [...currentList, ...pool].slice(0, g.maxCompanions);
      persist();
      renderStage();
      return;
    }

    const focusBotBtn = event.target.closest('[data-pg-focus-bot]');
    if (focusBotBtn) {
      liveState.focusBotId = focusBotBtn.dataset.pgFocusBot;
      renderStage();
      return;
    }

    const pickRole = event.target.closest('[data-pg-pick-role]');
    if (pickRole) {
      const g = currentGame();
      if (g) {
        prefs.roleByGame[g.id] = pickRole.dataset.pgPickRole;
        persist();
        renderStage();
      }
      return;
    }
    if (event.target.closest('[data-pg-toggle-voice]')) {
      prefs.voiceEnabled = !prefs.voiceEnabled;
      persist();
      renderStage();
      return;
    }
    const moodBtn = event.target.closest('[data-pg-mood]');
    if (moodBtn) {
      const g = currentGame();
      const seated = companionsFor(g);
      const targetId = liveState.focusBotId || seated[0]?.id || 'ai-claude';
      liveState.moodByBot[targetId] = moodBtn.dataset.pgMood;
      renderStage();
    }
  });

  stageHost?.addEventListener('submit', (event) => {
    if (event.target.id === 'pgJournalForm') {
      event.preventDefault();
      const input = stageHost.querySelector('#pgJournalInput');
      const text = String(input?.value || '').trim();
      const g = currentGame();
      if (!text || !g) return;
      const meta = ensureMeta(g.id);
      meta.journal = [{ at: formatTimeShort(Date.now()), author: '玩家手账', text }, ...(meta.journal || [])].slice(0, 30);
      persist();
      renderStage();
      return;
    }
    if (event.target.id === 'pgQuickMountForm') {
      event.preventDefault();
      const input = stageHost.querySelector('#pgQuickMountInput');
      const url = String(input?.value || '').trim();
      const g = currentGame();
      if (!g || !url || !isSafeEntryUrl(url)) return;
      const idx = customGames.findIndex((item) => item.id === g.id);
      const updated = { ...g, entryUrl: url };
      if (idx >= 0) customGames[idx] = updated;
      else customGames.unshift(updated);
      liveState.banter.push({ kind: 'system', text: `MOUNTED ENTRY · ${url}` });
      persist();
      render();
      return;
    }
    if (event.target.id === 'pgBanterForm') {
      event.preventDefault();
      const input = stageHost.querySelector('#pgBanterInput');
      const text = String(input?.value || '').trim();
      const g = currentGame();
      if (!text || !g) return;
      input.value = '';
      const session = liveSession;
      const seated = companionsFor(g);
      const focusBot = seated.find((b) => b.id === liveState.focusBotId) || seated[0];
      const roleKey = roleFor(g);
      const roleLabel = ROLE_META[roleKey].label;
      liveState.banter.push({ kind: 'user', text });
      liveState.recentEvents.push(`玩家说：${text}`);
      if (liveState.recentEvents.length > 8) liveState.recentEvents.shift();

      if (prefs.receptionEnabled && receptionState.nativeApi && receptionState.ready) {
        const pendingItem = {
          kind: 'bot',
          sender: `${focusBot.name} · 接待模型思考中…`,
          text: '…',
        };
        liveState.banter.push(pendingItem);
        renderStage();
        stageHost.querySelector('#pgBanterInput')?.focus();

        void (async () => {
          const aiRes = await requestReceptionReply({
            bot: focusBot,
            roleLabel,
            game: g,
            mode: 'chat',
            userMessage: text,
          });
          if (session !== liveSession || !active || prefs.view !== 'live' || g.id !== currentGame()?.id) return;
          if (aiRes?.reply) {
            pendingItem.sender = `${focusBot.name} · ${focusBot.seat}号位 · 接待模型`;
            pendingItem.text = aiRes.reply;
            if (aiRes.mood && MOOD_LIST.some((m) => m.id === aiRes.mood)) {
              liveState.moodByBot[focusBot.id] = aiRes.mood;
            }
          } else {
            pendingItem.sender = `${focusBot.name} · ${focusBot.seat}号位 · ${roleLabel}`;
            pendingItem.text = companionReply(focusBot, roleKey, text, false);
          }
          if (active && prefs.view === 'live') renderStage();

          // 多人同桌时，第二位 AI 娘通过接待模型顺口接一句
          const second = seated.find((b) => b.id !== focusBot.id);
          if (second && active && prefs.view === 'live') {
            const follow = await requestReceptionReply({
              bot: second,
              roleLabel: '同桌',
              game: g,
              mode: 'chat',
              userMessage: text,
              eventText: `${focusBot.name}刚回复了：「${pendingItem.text}」，请你用25字以内顺口接一句或吐槽。`,
            });
            if (session === liveSession && follow?.reply && active && prefs.view === 'live' && g.id === currentGame()?.id) {
              liveState.banter.push({
                kind: 'bot',
                sender: `${second.name} · ${second.seat}号位 · 接待模型`,
                text: follow.reply,
              });
              if (follow.mood && MOOD_LIST.some((m) => m.id === follow.mood)) {
                liveState.moodByBot[second.id] = follow.mood;
              }
              renderStage();
            }
          }
        })();
        return;
      }

      liveState.banter.push({
        kind: 'bot',
        sender: `${focusBot.name} · ${focusBot.seat}号位 · ${roleLabel}`,
        text: companionReply(focusBot, roleKey, text, false),
      });
      const second = seated.find((b) => b.id !== focusBot.id);
      if (second) {
        liveState.banter.push({
          kind: 'bot',
          sender: `${second.name} · ${second.seat}号位 · 同桌`,
          text: companionReply(second, roleKey, text, true),
        });
      }
      renderStage();
      stageHost.querySelector('#pgBanterInput')?.focus();
    }
  });

  /* ── 监听沙盒/嵌入游戏发来的 dimension-coplay-v1 战局联动事件（支持按 botId / seat 自动切焦点角色！） ── */
  window.addEventListener('message', (event) => {
    if (!active || prefs.view !== 'live') return;
    const data = event.data;
    if (!data || data.protocol !== 'dimension-coplay-v1') return;
    if (data.type === 'coplay:event') {
      const g = currentGame();
      const seated = companionsFor(g);
      let speaker = seated.find((b) => b.id === data.botId);
      if (!speaker && typeof data.seat === 'number' && data.seat >= 1) {
        speaker = seated[data.seat - 1];
      }
      if (!speaker) speaker = seated.find((b) => b.id === liveState.focusBotId) || seated[0];

      liveState.focusBotId = speaker.id;
      if (data.mood && MOOD_LIST.some((m) => m.id === data.mood)) {
        liveState.moodByBot[speaker.id] = data.mood;
      }
      if (data.text) {
        const cleanText = String(data.text).slice(0, 280);
        liveState.recentEvents.push(cleanText);
        if (liveState.recentEvents.length > 8) liveState.recentEvents.shift();
        liveState.banter.push({
          kind: 'bot',
          sender: `${speaker.name}${seated.length > 1 ? ` · ${speaker.seat}号位` : ''} · 实时反应`,
          text: cleanText,
        });
        // 若接待模型已自动接通，按低频防抖（>= 8 秒）自动追加一句有灵魂的真实 AI 战局点评！
        const now = Date.now();
        if (
          prefs.receptionEnabled &&
          receptionState.nativeApi &&
          receptionState.ready &&
          !receptionState.busy &&
          now - receptionState.lastAutoEventAt >= 8000
        ) {
          const session = liveSession;
          receptionState.busy = true;
          receptionState.lastAutoEventAt = now;
          const roleLabel = ROLE_META[roleFor(g)].label;
          void requestReceptionReply({
            bot: speaker,
            roleLabel,
            game: g,
            mode: 'event',
            eventText: cleanText,
            gameContext: String(data.gameContext || ''),
          }).then((aiRes) => {
            if (session !== liveSession || g.id !== currentGame()?.id) return;
            receptionState.busy = false;
            if (aiRes?.reply && active && prefs.view === 'live') {
              if (aiRes.mood && MOOD_LIST.some((m) => m.id === aiRes.mood)) {
                liveState.moodByBot[speaker.id] = aiRes.mood;
              }
              liveState.banter.push({
                kind: 'bot',
                sender: `${speaker.name} · 接待模型点评`,
                text: aiRes.reply,
              });
              renderStage();
            }
          }).catch(() => {
            if (session === liveSession) receptionState.busy = false;
          });
        }
      }
      renderStage();
    }
  });

  // 监听 DimensionAgent 全局主题变化，实时把浅白/暗黑主题同步给运行中的沙盒游戏
  const themeObserver = new MutationObserver(() => {
    if (!active || prefs.view !== 'live') return;
    const g = currentGame();
    if (g) pushRosterToFrame(g, companionsFor(g));
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  const publicApi = {
    registerGame(manifest) {
      if (!manifest || !manifest.id || !manifest.title) return false;
      const idx = customGames.findIndex((g) => g.id === manifest.id);
      const norm = normalizeGame(manifest);
      if (idx >= 0) customGames[idx] = { ...customGames[idx], ...norm };
      else customGames.unshift(norm);
      persist();
      render();
      return true;
    },
    getGames() {
      return mergedGames();
    },
    openGame(id) {
      if (!mergedGames().some((g) => g.id === id)) return false;
      prefs.selectedId = id;
      prefs.view = 'detail';
      persist();
      render();
      return true;
    },
    refreshSandbox: refreshSandboxCatalog,
  };
  window.DimensionPlayground = publicApi;

  // 启动时预拉一次沙盒卡带清单与接待模型状态
  void refreshSandboxCatalog();
  void refreshReceptionModel();

  return {
    activate() {
      active = true;
      if (sidebarHost) sidebarHost.hidden = false;
      if (stageHost) stageHost.hidden = false;
      void refreshSandboxCatalog();
      void refreshReceptionModel();
      render();
    },
    deactivate() {
      resetLiveSession();
      if (prefs.view === 'live') {
        stopLiveTimer();
        if (liveState.prevSidebarCollapsed === false) {
          onSetSidebarCollapsed?.(false);
        }
        liveState.prevSidebarCollapsed = null;
        prefs.view = 'detail';
      }
      active = false;
      closeModal();
      if (sidebarHost) sidebarHost.hidden = true;
      if (stageHost) stageHost.hidden = true;
    },
    refreshBots() {
      if (active) render();
    },
    api: publicApi,
  };
}
