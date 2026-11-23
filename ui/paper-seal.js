/*
 * 自有「纸印」头像：软形色块 + 名字首字印文。
 * 造型与色板为维度 Agent 自定，不使用外部默认造型或色值。
 */
export const DEFAULT_SHAPE = 'round-seal';
export const DEFAULT_COLOR = 'pine-smoke';
export const XIAOCAOJU_ID = 'new-character';
export const XIAOCAOJU_NAME = '小草橘';
export const XIAOCAOJU_COLOR = 'persimmon';

export const SEAL_SHAPES = Object.freeze([
  Object.freeze({ id: 'round-seal', name: '圆印' }),
  Object.freeze({ id: 'square-seal', name: '方印' }),
  Object.freeze({ id: 'oval-v', name: '竖卵' }),
  Object.freeze({ id: 'inkstone-h', name: '横砚' }),
  Object.freeze({ id: 'leaf', name: '叶片' }),
  Object.freeze({ id: 'folded-corner', name: '折角' }),
  Object.freeze({ id: 'fan', name: '扇面' }),
  Object.freeze({ id: 'jade-jue', name: '玉玦' }),
]);

export const SEAL_COLORS = Object.freeze([
  Object.freeze({ id: 'pine-smoke', name: '松烟', hex: '#2A2723' }),
  Object.freeze({ id: 'tea-brown', name: '茶褐', hex: '#6B4F3A' }),
  Object.freeze({ id: 'cinnabar', name: '朱红', hex: '#C44536' }),
  Object.freeze({ id: 'persimmon', name: '柿橙', hex: '#D96A2B' }),
  Object.freeze({ id: 'turmeric', name: '姜黄', hex: '#C9A227' }),
  Object.freeze({ id: 'bamboo', name: '竹绿', hex: '#2F7D5A' }),
  Object.freeze({ id: 'teal-gray', name: '青灰', hex: '#3D7A7A' }),
  Object.freeze({ id: 'indigo', name: '靛青', hex: '#2B5F8A' }),
  Object.freeze({ id: 'dusk-purple', name: '黛紫', hex: '#5A4A7A' }),
  Object.freeze({ id: 'rouge', name: '胭脂', hex: '#B44A6A' }),
  Object.freeze({ id: 'slate', name: '石青', hex: '#5E6B73' }),
  Object.freeze({ id: 'ivory', name: '牙白', hex: '#F7F3EC' }),
]);

const SHAPE_IDS = new Set(SEAL_SHAPES.map((item) => item.id));
const COLOR_BY_ID = new Map(SEAL_COLORS.map((item) => [item.id, item]));
const LOCAL_KEY = 'dimension.paperSeal.v1';

export function firstVisibleGlyph(name) {
  const match = String(name || '').match(/\S/u);
  return match ? match[0] : '';
}

export function colorById(id) {
  return COLOR_BY_ID.get(id) || COLOR_BY_ID.get(DEFAULT_COLOR);
}

function isXiaoCaoJu(bot) {
  const id = bot?.id || '';
  const name = String(bot?.name || '').trim();
  return id === XIAOCAOJU_ID || name === XIAOCAOJU_NAME;
}

export function defaultPaperSeal(bot) {
  return {
    shape: DEFAULT_SHAPE,
    color: isXiaoCaoJu(bot) ? XIAOCAOJU_COLOR : DEFAULT_COLOR,
    pinned: false,
    stored: false,
  };
}

export function normalizePaperSeal(raw, bot) {
  const fallback = defaultPaperSeal(bot);
  const shape = SHAPE_IDS.has(raw?.shape) ? raw.shape : fallback.shape;
  const color = COLOR_BY_ID.has(raw?.color) ? raw.color : fallback.color;
  return {
    shape,
    color,
    pinned: raw?.pinned === true,
    stored: raw?.stored === true,
  };
}

let cachedSealText;
let cachedSeals = {};

function readLocalMap() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw !== cachedSealText) {
      const data = raw ? JSON.parse(raw) : {};
      cachedSeals = data && typeof data === 'object' ? data : {};
      cachedSealText = raw;
    }
    return cachedSeals;
  } catch {
    return {};
  }
}

export function readLocalSeal(id) {
  if (!id) return null;
  const raw = readLocalMap()[id];
  if (!raw || typeof raw !== 'object') return null;
  return normalizePaperSeal({ ...raw, stored: true }, { id });
}

export function writeLocalSeal(id, seal) {
  if (!id) return;
  const entry = {
    shape: seal.shape,
    color: seal.color,
    pinned: seal.pinned === true,
  };
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify({ ...readLocalMap(), [id]: entry })); } catch { /* ignore quota */ }
}

export function resolvePaperSeal(bot, local = readLocalSeal(bot?.id)) {
  const remote = bot?.paperSeal && typeof bot.paperSeal === 'object' ? bot.paperSeal : null;
  if (remote && remote.stored === true) {
    return normalizePaperSeal({ ...remote, pinned: bot?.pinned ?? remote.pinned }, bot);
  }
  if (local) {
    return local;
  }
  if (remote) {
    return normalizePaperSeal({ ...remote, pinned: bot?.pinned ?? remote.pinned }, bot);
  }
  if (bot?.pinned === true) {
    return { ...defaultPaperSeal(bot), pinned: true };
  }
  return defaultPaperSeal(bot);
}

function lighten(hex, amount = 0.12) {
  const h = String(hex || '').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const mix = (c) => Math.round(c + (255 - c) * amount);
  return `rgb(${mix(r)} ${mix(g)} ${mix(b)})`;
}

function polar(cx, cy, r, deg) {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy - r * Math.sin(rad)];
}

function paint(fill, outline = '') {
  return `fill="${fill}"${outline}`;
}

function shapeMarkup(shape, fill, outline = '') {
  switch (shape) {
    case 'square-seal':
      return `<rect x="14" y="14" width="72" height="72" rx="${(72 * 0.22).toFixed(2)}" ry="${(72 * 0.22).toFixed(2)}" ${paint(fill, outline)}/>`;
    case 'oval-v':
      return `<ellipse cx="50" cy="50" rx="30" ry="40" ${paint(fill, outline)}/>`;
    case 'inkstone-h':
      return `<rect x="10" y="26" width="80" height="48" rx="24" ry="24" ${paint(fill, outline)}/>`;
    case 'leaf':
      return `<path transform="rotate(-30 50 50)" d="M14 50 C28 26 54 22 88 50 C54 78 28 74 14 50 Z" ${paint(fill, outline)}/>`;
    case 'folded-corner': {
      const fold = lighten(fill, 0.12);
      return [
        `<path d="M30.96 16 H64 L84 36 V69.04 Q84 84 69.04 84 H30.96 Q16 84 16 69.04 V30.96 Q16 16 30.96 16 Z" ${paint(fill, outline)}/>`,
        `<path d="M64 16 L84 36 L64 36 Z" ${paint(fold, outline)}/>`,
      ].join('');
    }
    case 'fan':
      return `<path d="M14 80 A36 58 0 0 0 86 80 Z" ${paint(fill, outline)}/>`;
    case 'jade-jue': {
      const R = 40;
      const ring = 80 * 0.28;
      const r = R - ring;
      const [ox1, oy1] = polar(50, 50, R, 24);
      const [ox2, oy2] = polar(50, 50, R, -24);
      const [ix2, iy2] = polar(50, 50, r, -24);
      const [ix1, iy1] = polar(50, 50, r, 24);
      const fmt = (n) => n.toFixed(3);
      return `<path ${paint(fill, outline)} fill-rule="evenodd" d="M${fmt(ox1)} ${fmt(oy1)} A${R} ${R} 0 1 0 ${fmt(ox2)} ${fmt(oy2)} L${fmt(ix2)} ${fmt(iy2)} A${r} ${r} 0 1 1 ${fmt(ix1)} ${fmt(iy1)} Z"/>`;
    }
    default:
      return `<circle cx="50" cy="50" r="40" ${paint(fill, outline)}/>`;
  }
}

export function paperSealSvg({ shape, color, name, size = 40, breathe = false } = {}) {
  const pal = colorById(color);
  const fill = pal.hex;
  const glyph = firstVisibleGlyph(name);
  const ink = pal.id === 'ivory' ? '#2A2723' : '#F7F3EC';
  const outline = pal.id === 'ivory' ? ' stroke="#D9D3C8" stroke-width="1.2" paint-order="stroke fill"' : '';
  const text = glyph
    ? `<text x="50" y="50" text-anchor="middle" dominant-baseline="central" font-family="var(--font-sans)" font-weight="650" font-size="33.6" fill="${ink}">${escapeXml(glyph)}</text>`
    : '';
  const cls = breathe ? 'paper-seal is-breathing' : 'paper-seal';
  const px = Number(size) || 40;
  return `<svg class="${cls}" viewBox="0 0 100 100" width="${px}" height="${px}" aria-hidden="true" focusable="false">${shapeMarkup(shape || DEFAULT_SHAPE, fill, outline)}${text}</svg>`;
}

function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}
