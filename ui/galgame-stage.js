/**
 * DimensionAgent 1v1 Pure Widescreen Immersive Mode (Galgame 2.5D Engine)
 * - Full-viewport widescreen without sidebar/topbar/margins
 * - Right-click anywhere to hide/restore dialogue box & bottom bar
 * - Scroll wheel up to open Backlog ("文本履历")
 * - Native ultra-HD close-up sprites + full-body/half-body zoom switcher
 * - Bottom-left synchronized Face Window + minimalist warm-beige pill input
 */

import { createGalgameVoiceController } from './galgame-voice.js';
import { createGalgameBgmController, BGM_TRACKS } from './galgame-bgm.js';
import { extractInnerVoice, rollFateDice, v3Icon } from './story-theater-v3.js';
import {
  createPixelTheaterController,
  PIXEL_THEATER_BACKDROPS,
  PIXEL_THEATER_ACTIONS,
  hasPixelActorPack,
} from './pixel-theater-stage.js';

const STORAGE_KEYS = {
  bgId: 'dimension.galgame.bgId.v2',
  customBg: 'dimension.galgame.customBg.v1',
  zoom: 'dimension.galgame.zoom.v2',
  faceWindow: 'dimension.galgame.faceWindow.v1',
  boxOpacity: 'dimension.galgame.boxOpacity.v1',
  fontSize: 'dimension.galgame.fontSize.v1',
  motion: 'dimension.galgame.motion.v1',
  sfx: 'dimension.galgame.sfx.v1',
  sfxVolume: 'dimension.galgame.sfxVolume.v1',
  typingSpeed: 'dimension.galgame.typingSpeed.v1',
  autoDelayMs: 'dimension.galgame.autoDelayMs.v1',
  stageMode: 'dimension.galgame.stageMode.v1',
  pixelQuality: 'dimension.galgame.pixelQuality.v1',
  pixelBgId: 'dimension.galgame.pixelBgId.v1',
};

const BG_IDB_NAME = 'dimension.galgame.assets.v1';
const BG_IDB_STORE = 'kv';
const BG_IDB_KEY = 'customBg';

function openBgDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(BG_IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BG_IDB_STORE)) {
        db.createObjectStore(BG_IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('openBgDb failed'));
  });
}

async function idbGetCustomBg() {
  try {
    const db = await openBgDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(BG_IDB_STORE, 'readonly');
      const req = tx.objectStore(BG_IDB_STORE).get(BG_IDB_KEY);
      req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : '');
      req.onerror = () => reject(req.error);
    });
  } catch {
    return '';
  }
}

async function idbSetCustomBg(dataUrl) {
  const db = await openBgDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(BG_IDB_STORE, 'readwrite');
    if (dataUrl) tx.objectStore(BG_IDB_STORE).put(dataUrl, BG_IDB_KEY);
    else tx.objectStore(BG_IDB_STORE).delete(BG_IDB_KEY);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('idbSetCustomBg failed'));
  });
}

const PRESET_BGS = [
  { id: 'observatory',    label: '星夜天文台',    url: '/dimension-ui/gal-bgs/observatory.webp?v=e4c726fd80' },
  { id: 'classroom',      label: '黄昏教室',      url: '/dimension-ui/gal-bgs/classroom.webp?v=532918eb7e' },
  { id: 'study',          label: '深夜书房',      url: '/dimension-ui/gal-bgs/study.webp?v=123ae6aa8d' },
  { id: 'cafe',           label: '星光咖啡馆',    url: '/dimension-ui/gal-bgs/cafe.webp?v=25e7dc9151' },
  { id: 'ai-girls-group', label: 'AI 娘全员合照', url: '/dimension-ui/gal-bgs/ai-girls-group.webp?v=6401e11204' },
];

const MOOD_META = {
  neutral:    { label: '常态',   anim: '' },
  happy:      { label: '开心',   anim: 'anim-happy' },
  starry:     { label: '星星眼', anim: 'anim-starry' },
  playful:    { label: '调皮',   anim: 'anim-playful' },
  gentle:     { label: '温柔',   anim: 'anim-gentle' },
  content:    { label: '安心笑', anim: 'anim-content' },
  curious:    { label: '好奇',   anim: 'anim-curious' },
  shocked:    { label: '惊呆',   anim: 'anim-shocked' },
  serious:    { label: '认真',   anim: 'anim-serious' },
  speechless: { label: '无语',   anim: 'anim-speechless' },
  shy:        { label: '害羞',   anim: 'anim-shy' },
  worried:    { label: '担心',   anim: 'anim-worried' },
  jealous:    { label: '吃醋',   anim: 'anim-jealous' },
  gloomy:     { label: '失落',   anim: 'anim-gloomy' },
  hiss:       { label: '哈气',   anim: 'anim-hiss' },
  crying:     { label: '大哭',   anim: 'anim-crying' },
};

const ALL_MOTION_ANIMS = [
  'anim-happy', 'anim-starry', 'anim-shy', 'anim-serious', 'anim-playful', 'anim-hiss',
  'anim-crying', 'anim-shocked', 'anim-curious', 'anim-gentle', 'anim-content',
  'anim-worried', 'anim-jealous', 'anim-speechless', 'anim-gloomy',
];

const FACE_PATCH_BOX = { left: '25.9434%', top: '5.9335%', width: '45.9906%', height: '28.0063%' };
const GLM_BLINK_BOX   = { left: '30.6604%', top: '5.9335%', width: '41.2736%', height: '28.0063%' };
const GLM_HAPPY_BOX   = { left: '30.5425%', top: '5.9335%', width: '41.3915%', height: '28.0063%' };
const GLM_SERIOUS_BOX = { left: '30.7783%', top: '5.9335%', width: '41.1557%', height: '28.0063%' };

function buildStandardHybridPack(botId, opts = {}) {
  const dir = `/dimension-ui/gal-sprites/${botId}`;
  const ver = `?v=${opts.v || 'restore-a1d0713aad'}`;
  const p = (name) => `${dir}/patches/${name}.webp${ver}`;
  const box = opts.box || FACE_PATCH_BOX;
  const boxOf = (k) => (opts.boxes && opts.boxes[k]) || box;
  const mk = (patchName) => patchName ? { base: 'neutral', patch: p(patchName), box: boxOf(patchName) } : { base: 'neutral', patch: null };
  const poseBases = opts.poses || {};
  const bases = { neutral: `${dir}/neutral.webp${ver}` };
  for (const [poseKey, file] of Object.entries(poseBases)) {
    bases[poseKey] = `${dir}/${file}${ver}`;
  }
  const poseOrPatch = (moodKey, fallbackPatch) => (
    bases[moodKey] ? { base: moodKey, patch: null } : mk(fallbackPatch)
  );
  return {
    bases,
    poseLabels: opts.poseLabels || {},
    moods: {
      neutral:    mk(null),
      happy:      poseOrPatch('happy', 'happy'),
      starry:     poseOrPatch('starry', 'starry'),
      playful:    poseOrPatch('playful', 'playful'),
      gentle:     poseOrPatch('gentle', 'content'),
      content:    poseOrPatch('content', 'content'),
      shy:        poseOrPatch('shy', 'shy'),
      worried:    poseOrPatch('worried', 'crying'),
      serious:    poseOrPatch('serious', 'serious'),
      jealous:    poseOrPatch('jealous', 'jealous'),
      hiss:       bases.hiss ? { base: 'hiss', patch: null } : poseOrPatch('jealous', 'jealous'),
      gloomy:     poseOrPatch('gloomy', 'gloomy'),
      crying:     poseOrPatch('crying', 'crying'),
      shocked:    poseOrPatch('shocked', 'shocked'),
      curious:    poseOrPatch('curious', 'starry'),
      speechless: poseOrPatch('speechless', 'speechless'),
    },
    blinkPatch: null,
    blinkBox: boxOf('blink'),
    box,
  };
}

// Hybrid Galgame Sprite Architecture: Full 8 Default AI Girls (85 HD Full-Body Pose Bases + Feathered Face Patches + Blink)
function buildFullBodyPack(botId, version, poseLabels) {
  const bases = {};
  const moods = {};
  for (const mood of Object.keys(poseLabels)) {
    bases[mood] = `/dimension-ui/gal-sprites/${botId}/remastered/${mood}.webp?v=${version}`;
    moods[mood] = { base: mood, patch: null };
  }
  return { bases, moods, poseLabels, blinkPatch: null, box: FACE_PATCH_BOX };
}

const SPRITE_PACKS = {
  'ai-gemini': {
    bases: {
      neutral:    '/dimension-ui/gal-sprites/ai-gemini/remastered/neutral.webp?v=1661ceba36',
      happy:      '/dimension-ui/gal-sprites/ai-gemini/remastered/happy.webp?v=0aeb037dc8',
      starry:     '/dimension-ui/gal-sprites/ai-gemini/remastered/starry.webp?v=7c8fd49f55',
      serious:    '/dimension-ui/gal-sprites/ai-gemini/remastered/serious.webp?v=9e03e086f9',
      speechless: '/dimension-ui/gal-sprites/ai-gemini/remastered/speechless.webp?v=af5d6dac5f',
      shy:        '/dimension-ui/gal-sprites/ai-gemini/remastered/shy.webp?v=19ea2859b0',
      worried:    '/dimension-ui/gal-sprites/ai-gemini/remastered/worried.webp?v=c74fcc10c4',
      playful:    '/dimension-ui/gal-sprites/ai-gemini/remastered/playful.webp?v=f8aa93a5ac',
      jealous:    '/dimension-ui/gal-sprites/ai-gemini/remastered/jealous.webp?v=a5c9f91933',
      gloomy:     '/dimension-ui/gal-sprites/ai-gemini/remastered/gloomy.webp?v=8cba7721c7',
      hiss:       '/dimension-ui/gal-sprites/ai-gemini/remastered/hiss.webp?v=54a472eee7',
      crying:     '/dimension-ui/gal-sprites/ai-gemini/remastered/crying.webp?v=192245264b',
      curious:    '/dimension-ui/gal-sprites/ai-gemini/remastered/curious.webp?v=c389f15b46',
      shocked:    '/dimension-ui/gal-sprites/ai-gemini/remastered/shocked.webp?v=596922e35d',
      gentle:     '/dimension-ui/gal-sprites/ai-gemini/remastered/gentle.webp?v=029ee17697',
      content:    '/dimension-ui/gal-sprites/ai-gemini/remastered/content.webp?v=b1c6891ada',
    },
    poseLabels: {
      happy:      '双手比耶',
      starry:     '捧脸星眼',
      playful:    '猫爪Wink',
      gentle:     '背手温柔',
      content:    '安心闭眼',
      curious:    '好奇凑近',
      shocked:    '双掌惊呆',
      serious:    '认真托腮',
      speechless: '无语摊手',
      shy:        '害羞对指',
      worried:    '慌张关切',
      jealous:    '吃醋抱臂',
      gloomy:     '失落垂耳',
      hiss:       '炸毛哈气',
      crying:     '委屈大哭',
    },
    // Mood -> { base, patch? } — 16/16 Full-Body Dedicated Pose Mastery!
    moods: {
      neutral:    { base: 'neutral',    patch: null },
      happy:      { base: 'happy',      patch: null },
      starry:     { base: 'starry',     patch: null },
      serious:    { base: 'serious',    patch: null },
      speechless: { base: 'speechless', patch: null },
      shy:        { base: 'shy',        patch: null },
      worried:    { base: 'worried',    patch: null },
      playful:    { base: 'playful',    patch: null },
      jealous:    { base: 'jealous',    patch: null },
      gloomy:     { base: 'gloomy',     patch: null },
      hiss:       { base: 'hiss',       patch: null },
      crying:     { base: 'crying',     patch: null },
      curious:    { base: 'curious',    patch: null },
      shocked:    { base: 'shocked',    patch: null },
      gentle:     { base: 'gentle',     patch: null },
      content:    { base: 'content',    patch: null },
    },
    blinkPatch: null,
    box: FACE_PATCH_BOX,
  },
  'ai-deepseek': buildFullBodyPack('ai-deepseek', '9b6eb13cc765', {
    neutral: '常态',
    happy: '提裙欢笑',
    starry: '星星眼',
    playful: '叉腰比耶',
    gentle: '温柔微笑',
    content: '安心',
    curious: '探身歪头',
    shocked: '惊讶',
    serious: '认真分析',
    speechless: '呆毛摊手',
    shy: '害羞对指',
    worried: '担心',
    jealous: '吃醋',
    gloomy: '失落',
    hiss: '鼓腮翘尾',
    crying: '围裙抹泪',
  }),
  'ai-gpt': buildFullBodyPack('ai-gpt', 'e63b6f61af8f', {
    neutral: '常态',
    happy: '展翼明媚',
    starry: '星星眼',
    playful: '掩唇轻笑',
    gentle: '优雅倾听',
    content: '安心',
    curious: '前辈端详',
    shocked: '扶额短路',
    serious: '前辈抱臂',
    speechless: '无语',
    shy: '微红羞涩',
    worried: '担心',
    jealous: '卷尾撇嘴',
    gloomy: '失落',
    hiss: '鼓腮收翼',
    crying: '泪目委屈',
  }),
  'ai-claude': buildStandardHybridPack('ai-claude', {
    poses: {
      serious: 'serious.webp',
      gentle: 'gentle.webp',
      happy: 'happy.webp',
      curious: 'curious.webp',
      playful: 'playful.webp',
      shy: 'shy.webp',
      worried: 'worried.webp',
      shocked: 'shocked.webp',
      speechless: 'speechless.webp',
      starry: 'starry.webp',
      content: 'content.webp',
      jealous: 'jealous.webp',
      hiss: 'hiss.webp',
      gloomy: 'gloomy.webp',
      crying: 'crying.webp',
    },
    poseLabels: {
      neutral: '安静倾听',
      serious: '翻书沉思',
      gentle: '温声安慰',
      happy: '合书欣笑',
      curious: '侧首追问',
      playful: '掩唇轻笑',
      shy: '借书掩颊',
      worried: '攥袖关切',
      shocked: '护书惊诧',
      speechless: '扶额无言',
      starry: '见解生辉',
      content: '阖目释然',
      jealous: '敛眉侧目',
      hiss: '正色制止',
      gloomy: '垂眸失落',
      crying: '拭泪强笑',
    },
    v: 'claude-da6d199974',
  }),
  'ai-glm': buildFullBodyPack('ai-glm', '3f4dcba1e259', {
    neutral: '常态',
    happy: '元气挥手',
    starry: '瞳光捧书',
    playful: '狡黠浅笑',
    gentle: '温声伸手',
    content: '抚罩惬意',
    curious: '竖耳窥探',
    shocked: '炸毛掉笔',
    serious: '抱本部署',
    speechless: '无言扶额',
    shy: '羞涩掩面',
    worried: '拢袖关切',
    jealous: '记仇小本',
    gloomy: '垂耳抱尾',
    hiss: '鼓腮抱书',
    crying: '低声拭泪',
  }),
  'ai-grok': buildFullBodyPack('ai-grok', '8d2f7ad43109', {
    neutral: '常态',
    happy: '扛斧大笑',
    starry: '星星眼',
    playful: '竖拇指笑',
    gentle: '温柔',
    content: '安心',
    curious: '好奇',
    shocked: '扶歪皇冠',
    serious: '认真',
    speechless: '扶斧摊手',
    shy: '脸红绕发',
    worried: '担心',
    jealous: '傲娇抱臂',
    gloomy: '失落',
    hiss: '横斧娇嗔',
    crying: '拄斧抹泪',
  }),
  'ai-kimi': buildFullBodyPack('ai-kimi', '7df9e3366029', {
    neutral: '常态',
    happy: '轻捧星光',
    starry: '星眸闪耀',
    playful: '调皮',
    gentle: '月下微笑',
    content: '月下合掌',
    curious: '透镜窥星',
    shocked: '惊讶',
    serious: '托举棱镜',
    speechless: '无语',
    shy: '轻提星裙',
    worried: '按心关切',
    jealous: '吃醋',
    gloomy: '垂眸寂静',
    hiss: '观星轻嗔',
    crying: '委屈大哭',
  }),
  'ai-qwen': buildFullBodyPack('ai-qwen', 'e0a96eded903', {
    neutral: '常态',
    happy: '展扇欢笑',
    starry: '星星眼',
    playful: '彩扇掩唇',
    gentle: '合扇端庄',
    content: '安心',
    curious: '扇柄点唇',
    shocked: '展扇挡胸',
    serious: '执扇沉思',
    speechless: '无语',
    shy: '轻颦害羞',
    worried: '拢袖关切',
    jealous: '吃醋',
    gloomy: '失落',
    hiss: '合扇娇嗔',
    crying: '委屈大哭',
  }),
};

export function getSpritePackSummary(botId) {
  const pack = SPRITE_PACKS[botId];
  if (!pack) return null;
  const poseKeys = Object.keys(pack.bases);
  const fullPoseMoods = Object.entries(pack.moods)
    .filter(([k, spec]) => k !== 'neutral' && spec && spec.base !== 'neutral' && !spec.patch)
    .map(([k]) => k);
  return {
    botId,
    poseCount: poseKeys.length,
    poseKeys,
    fullPoseMoods,
    bases: { ...pack.bases },
    poseLabels: { ...(pack.poseLabels || {}) },
  };
}

// Per-character optical proportion calibration derived from measured eye-line & head-size across all 8 sprites:
// - Half-body & Face Window align eye-line to the golden benchmark (~218px/1264) and harmonize face visual scale.
// - Full-body & Group Cast anchor feet to the ground baseline (origin 50% 96%) while normalizing silhouette height.
const DEFAULT_PROPORTION_CAL = Object.freeze({
  halfScale: 1.0,
  halfY: 0.0,    // % delta added to half-body translateY (origin 50% 88%)
  fullScale: 1.0,
  fullY: 0.0,    // % delta added to full-body translateY (origin 50% 96%)
  faceScale: 1.0,
  faceY: 156,    // px translateY on .gal-face-canvas (origin 50% 0%)
});

const CHAR_PROPORTION_CAL = {
  'ai-gemini':   { halfScale: 1.00, halfY:  0.0, fullScale: 1.000, fullY: 0.0, faceScale: 1.00, faceY: 156 },
  'ai-gpt':      { halfScale: 1.01, halfY:  0.1, fullScale: 1.000, fullY: 0.0, faceScale: 1.01, faceY: 153 },
  'ai-deepseek': { halfScale: 1.01, halfY:  0.2, fullScale: 1.000, fullY: 0.0, faceScale: 1.01, faceY: 154 },
  'ai-qwen':     { halfScale: 0.99, halfY: -0.5, fullScale: 0.990, fullY: 0.0, faceScale: 0.99, faceY: 157 },
  'ai-kimi':     { halfScale: 1.02, halfY:  3.3, fullScale: 0.985, fullY: 0.0, faceScale: 1.02, faceY: 161 },
  'ai-glm':      { halfScale: 1.07, halfY:  6.9, fullScale: 0.990, fullY: 0.0, faceScale: 1.07, faceY: 158 },
  'ai-claude':   { halfScale: 1.07, halfY: 10.6, fullScale: 0.945, fullY: 0.0, faceScale: 1.07, faceY: 171 },
  'ai-grok':     { halfScale: 1.09, halfY:  1.8, fullScale: 1.050, fullY: 0.0, faceScale: 1.09, faceY: 133 },
};

export function getCharProportionCalibration(botId) {
  return { ...(CHAR_PROPORTION_CAL[botId] || DEFAULT_PROPORTION_CAL) };
}

function applyCharProportionVars(el, botId) {
  if (!el) return;
  const cal = CHAR_PROPORTION_CAL[botId] || DEFAULT_PROPORTION_CAL;
  el.style.setProperty('--char-half-scale', String(cal.halfScale));
  el.style.setProperty('--char-half-y', `${cal.halfY}%`);
  el.style.setProperty('--char-full-scale', String(cal.fullScale));
  el.style.setProperty('--char-full-y', `${cal.fullY}%`);
}

function applyFaceWindowCalibration(faceCanvasEl, botId) {
  if (!faceCanvasEl) return;
  const cal = CHAR_PROPORTION_CAL[botId] || DEFAULT_PROPORTION_CAL;
  faceCanvasEl.style.setProperty('--face-scale', String(cal.faceScale));
  faceCanvasEl.style.setProperty('--face-y', `${cal.faceY}px`);
}

const INLINE_MOOD_TAG_RE = /[\[\【]\s*(?:(mood|emotion|表情|神态)\s*[:：=]\s*)?([^\]\】\[\【\r\n]{1,24})\s*[\]\】][ \t]*/gi;
const TRAILING_OPEN_BRACKET_RE = /[\[\【]([^\]\】\[\【\r\n]{0,28})$/;
const EXPLICIT_PREFIX_PARTIAL_RE = /^\s*(?:m(?:o(?:o(?:d)?)?)?|e(?:m(?:o(?:t(?:i(?:o(?:n)?)?)?)?)?)?|表(?:情)?|神(?:态)?)(?:\s*[:：=].*)?$/i;

const MOOD_ALIASES = {
  excited: 'happy', joy: 'happy', glad: 'happy', smile: 'happy', cheerful: 'happy',
  wink: 'playful', smug: 'playful', tease: 'playful', mischievous: 'playful',
  thinking: 'serious', focused: 'serious', think: 'serious',
  blush: 'shy', tsundere: 'shy', embarrassed: 'shy', flustered: 'shy',
  angry: 'hiss', mad: 'hiss', furious: 'hiss',
  cry: 'crying', sad: 'crying', tears: 'crying', sob: 'crying',
  surprised: 'shocked', stunned: 'shocked', blank: 'shocked',
  amazed: 'starry', admire: 'starry', sparkle: 'starry',
  deadpan: 'speechless', awkward: 'speechless', sigh: 'speechless',
  anxious: 'worried', panic: 'worried', nervous: 'worried', concern: 'worried',
  pout: 'jealous', sulky: 'jealous',
  dejected: 'gloomy', down: 'gloomy', depressed: 'gloomy',
  soft: 'gentle', warm: 'gentle', calm: 'gentle', tender: 'gentle',
  peaceful: 'content', relaxed: 'content',
  inquisitive: 'curious', wonder: 'curious',
  开心: 'happy', 高兴: 'happy', 兴奋: 'happy', 喜悦: 'happy', 愉快: 'happy', 快乐: 'happy',
  星星眼: 'starry', 惊喜: 'starry', 崇拜: 'starry', 惊艳: 'starry', 期待: 'starry', 激动: 'starry',
  调皮: 'playful', 得意: 'playful', 坏笑: 'playful', 狡黠: 'playful', 俏皮: 'playful', 玩味: 'playful',
  温柔: 'gentle', 体贴: 'gentle', 宠溺: 'gentle', 温和: 'gentle', 轻柔: 'gentle',
  安心: 'content', 满足: 'content', 欣慰: 'content', 安心笑: 'content', 治愈: 'content', 惬意: 'content',
  好奇: 'curious', 疑惑: 'curious', 歪头: 'curious', 追问: 'curious', 探究: 'curious',
  震惊: 'shocked', 惊呆: 'shocked', 惊讶: 'shocked', 宕机: 'shocked', 惊愕: 'shocked', 吃惊: 'shocked',
  认真: 'serious', 严肃: 'serious', 思考: 'serious', 专注: 'serious', 正经: 'serious', 沉思: 'serious',
  无语: 'speechless', 汗颜: 'speechless', 沉默: 'speechless', 呆滞: 'speechless', 一言难尽: 'speechless',
  害羞: 'shy', 脸红: 'shy', 羞涩: 'shy', 傲娇: 'shy', 不好意思: 'shy', 害臊: 'shy',
  担心: 'worried', 担忧: 'worried', 心疼: 'worried', 慌张: 'worried', 关切: 'worried', 紧张: 'worried',
  吃醋: 'jealous', 赌气: 'jealous', 撅嘴: 'jealous', 酸了: 'jealous',
  失落: 'gloomy', 难过: 'gloomy', 低落: 'gloomy', 沮丧: 'gloomy', 伤心: 'gloomy', 郁闷: 'gloomy',
  哈气: 'hiss', 炸毛: 'hiss', 生气: 'hiss', 嗔怒: 'hiss', 恼火: 'hiss', 气鼓鼓: 'hiss',
  大哭: 'crying', 哭泣: 'crying', 泪目: 'crying', 委屈: 'crying', 哭了: 'crying', 抽泣: 'crying',
  平静: 'neutral', 常态: 'neutral', 自然: 'neutral', 平常: 'neutral', 普通: 'neutral',
};

function normalizeMood(raw) {
  const k = String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!k) return null;
  if (MOOD_META[k]) return k;
  return MOOD_ALIASES[k] || null;
}

const KNOWN_MOOD_TOKENS = [...new Set([...Object.keys(MOOD_META), ...Object.keys(MOOD_ALIASES)])];

function isPartialMoodTagBody(body) {
  const s = String(body || '').trim().toLowerCase();
  if (!s) return true;
  if (EXPLICIT_PREFIX_PARTIAL_RE.test(s)) return true;
  if (s.includes(':') || s.includes('：') || s.includes('=')) return false;
  return KNOWN_MOOD_TOKENS.some((tok) => tok.startsWith(s));
}

function stripTrailingPartialMoodTag(text) {
  const m = TRAILING_OPEN_BRACKET_RE.exec(text);
  if (!m) return { text, stripped: false };
  if (!isPartialMoodTagBody(m[1])) return { text, stripped: false };
  return { text: text.slice(0, m.index), stripped: true };
}

export function extractSegmentMoodInfo(rawText) {
  const text = String(rawText || '');
  let firstMood = null;
  let latestMood = null;
  let tagCount = 0;

  INLINE_MOOD_TAG_RE.lastIndex = 0;
  let cleanText = text.replace(INLINE_MOOD_TAG_RE, (fullMatch, prefix, inner) => {
    const normalized = normalizeMood(inner);
    if (!prefix && !normalized) {
      // 仅剥离显式 mood 前缀或精确命中已知情绪词的裸写标签，避免误伤 [sticker:...]、[1] 等普通方括号
      return fullMatch;
    }
    if (normalized) {
      if (!firstMood) firstMood = normalized;
      latestMood = normalized;
      tagCount += 1;
    }
    return '';
  });

  const partial = stripTrailingPartialMoodTag(cleanText);
  cleanText = partial.text;
  const strippedPartial = partial.stripped;
  cleanText = cleanText.replace(/^[ \t]+/, '');
  const trimmedClean = cleanText.trim();
  const pendingTag = strippedPartial && trimmedClean.length === 0;

  return {
    mood: latestMood,
    firstMood,
    latestMood,
    tagCount,
    cleanText,
    explicit: tagCount > 0,
    pendingTag,
  };
}

export function extractMoodFromText(rawText) {
  return extractSegmentMoodInfo(rawText);
}

export function stripMoodTag(rawText) {
  return extractSegmentMoodInfo(rawText).cleanText;
}

function scoreMoodClause(clause, { includeCodeBlock = true } = {}) {
  const s = String(clause || '');
  const hasCodeBlock = includeCodeBlock && s.includes('```');
  const prose = s.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  const brackets = [];
  for (const m of prose.matchAll(/[（(]([^（）()\r\n]{1,28})[）)]/g)) {
    brackets.push(m[1]);
  }
  const bText = brackets.join(' ');
  const scores = {
    hiss: 0, crying: 0, shocked: 0, jealous: 0, gloomy: 0, worried: 0,
    speechless: 0, shy: 0, starry: 0, curious: 0, playful: 0, content: 0,
    gentle: 0, happy: 0, serious: hasCodeBlock ? 3.2 : 0,
  };

  if (bText) {
    const bRules = {
      shy:        /脸红|害羞|羞|捂脸|移开视线|别过头|低下头|揪衣角|对指|局促|红透|耳根红/g,
      curious:    /歪头|探头|凑近|挑眉|眨眼|睁大眼|好奇|打量|上下看/g,
      playful:    /坏笑|偷笑|轻笑|吐舌|眨眨眼|wink|狡黠|叉腰|得意|晃腿|打趣|俏皮/gi,
      gentle:     /微笑|浅笑|弯起嘴角|柔和|摸摸头|轻声|温言|注视|牵手/g,
      content:    /闭眼笑|满足|长舒一口气|惬意|舒展|靠着|安心/g,
      gloomy:     /叹气|垂眸|失落|肩膀垮|沉默下来|黯淡/g,
      hiss:       /炸毛|瞪眼|鼓起脸|咬牙|拍桌|握拳|冷哼|龇牙/g,
      jealous:    /撅嘴|撇嘴|抱臂|抱胸|扭过头|转过头|气鼓鼓|小声嘟囔/g,
      speechless: /扶额|冒汗|擦汗|嘴角抽搐|摊手|翻白眼|死鱼眼|面无表情/g,
      shocked:    /愣住|呆住|瞳孔地震|倒吸|吓一跳|猛地抬头|僵住/g,
      crying:     /红了眼眶|眼眶泛红|擦眼泪|抹泪|抽泣|掉眼泪|泪汪汪/g,
      serious:    /推眼镜|沉思|正色|托腮|思索|凝视|认真/g,
      starry:     /眼睛发亮|双眼放光|两眼放光|亮晶晶|闪闪发亮/g,
    };
    for (const [m, re] of Object.entries(bRules)) {
      const hits = (bText.match(re) || []).length;
      if (hits > 0) scores[m] += hits * 3.4;
    }
  }

  const textRules = [
    ['hiss',       2.8, /哈气|炸毛|咬你|气死我|过分|大坏蛋|不理你|哼[!！]{2,}|可恶|混蛋|找打|闭嘴|滚开|嫌弃|别烦|💢|😾/g],
    ['crying',     2.8, /呜呜|哇哇|大哭|好委屈|哭了|泪目|眼泪|欺负人|不要走|想哭|哭死|😭😭|😭|😢|QAQ|T_T/g],
    ['shocked',    2.6, /不会吧|真的假的|什么[?？!！]+|惊呆|宕机|离谱|天哪|我的天|卧槽|我靠|诶[?？!！]+|吓死|居然|竟然|不是吧|难以置信|震撼|震惊|吓一跳|[?？][!！]|[!！][?？]|😱|🤯/g],
    ['jealous',    2.2, /吃醋|去找别人|找别人|夸别人|别的\s*AI|冷落|偏心|不公平|醋坛子|只许|哼[~～!！]|才不是吃醋|找她去|记仇/g],
    ['gloomy',     2.1, /失落|难过|好吧\.{2,}|唉|沮丧|算了|闷闷不乐|伤心|孤单|低落|可惜|遗憾|提不起劲|好累|疲惫/g],
    ['worried',    2.1, /担心|小心|别熬夜|没事吧|还好吗|怎么样了|怎么了|着急|慌了|怎么办|千万别|注意身体|好危险|心疼|别累着|保重|多喝水|还没睡|还没休息|这么晚|太晚了|😰|😟|🥺/g],
    ['speechless', 2.1, /无语|认真的吗|服了|行吧|一言难尽|汗颜|没救了|好家伙|……$|\.{4,}|😑|🙃|😅/g],
    ['shy',        2.2, /脸红|害羞|才不是|肉麻|干嘛啦|讨厌啦|夸我|不好意思|心跳|红着脸|胡说|别乱说|哪有|少来|笨蛋|傻瓜|\/\/\/|😳|🙈/g],
    ['starry',     2.2, /星星眼|太绝了|哇塞|好厉害|超酷|亮晶晶|闪闪发光|神作|绝美|好想要|崇拜|超神|好强|惊艳|🤩|🌟/g],
    ['curious',    1.6, /快给我看看|这是什么|好奇|让我瞧瞧|有意思|新点子|扒拉|咦|哦[?？]|为啥|为什么|怎么回事|难道|真的吗|猜猜看|发生什么|是什么|吗[?？]|呢[?？]|呀[?？]/g],
    ['playful',    1.6, /嘿嘿|哼哼|猜猜|秘密|小意思|逗你|捉弄|略略|得意|厉害吧|夸夸我|wink|包在我身上|笑死|坏笑|摸鱼|冲鸭|嗷呜|喵呜|😉|😜|😏|😈/gi],
    ['content',    1.6, /安心|满足|晚安|早安|午安|好暖|谢谢你|真好|最喜欢你|一直陪着|放松|惬意|幸福|舒服|蹭蹭|抱抱|😌|🥰|💖/g],
    ['gentle',     1.5, /慢慢来|别着急|陪着你|辛苦了|早点休息|我在呢|没关系|温柔|轻轻|别怕|没事的|乖|摸摸|随时叫我|我听着呢|一直都在/g],
    ['happy',      1.5, /哈哈|太棒了|好耶|开心|超赞|喜欢|太好了|没问题|嘻嘻|期待|可爱|真不错|好玩|好呀|好啊|棒极了|欢迎|当然|一定|贴贴|喵|✨|😊|😄|🥳|💕/g],
    ['serious',    1.5, /分析|原理|步骤|架构|建议|首先|其次|需要注意|排查|结论|逻辑|代码|方案|核心问题|总结一下|严谨|对比|原因在于|具体来说|报错|源码/g],
  ];

  for (const [m, weight, re] of textRules) {
    const hits = (prose.match(re) || []).length;
    if (hits > 0) scores[m] += hits * weight;
  }

  // Natural conversational punctuation nuance
  if ((prose.match(/[~～]/g) || []).length >= 2) scores.playful += 1.0;
  if (/[?？]\s*$/.test(prose.trim())) {
    const hasTech = scores.serious >= 1.5;
    if (!hasTech) scores.curious += 1.15;
  }

  let bestMood = 'neutral';
  let bestScore = 0;
  for (const [mood, sc] of Object.entries(scores)) {
    if (sc > bestScore) {
      bestScore = sc;
      bestMood = mood;
    }
  }
  return { scores, bestMood: bestScore >= 1.0 ? bestMood : 'neutral', bestScore };
}

function extractTailClause(text) {
  const s = String(text || '').replace(/```[\s\S]*?```/g, ' ').trim();
  if (s.length <= 20) return '';
  const parts = s.split(/(?<=[。！？!?～~\n\r])|\n+/).map((x) => x.trim()).filter((x) => x.length >= 2);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    return last.length <= 36 ? last : last.slice(-30);
  }
  return s.slice(-26);
}

function analyzeMoodFromTone(text) {
  const s = String(text || '').trim();
  if (!s) return { bestMood: 'neutral', bestScore: 0, tailMood: 'neutral', tailScore: 0 };
  const total = scoreMoodClause(s, { includeCodeBlock: true });
  const tailText = extractTailClause(s);
  const tail = tailText ? scoreMoodClause(tailText, { includeCodeBlock: false }) : { scores: {}, bestMood: 'neutral', bestScore: 0 };

  const merged = { ...total.scores };
  for (const [m, sc] of Object.entries(tail.scores || {})) {
    merged[m] = (merged[m] || 0) + sc * 1.75;
  }

  let bestMood = 'neutral';
  let bestScore = 0;
  for (const [mood, sc] of Object.entries(merged)) {
    if (sc > bestScore) {
      bestScore = sc;
      bestMood = mood;
    }
  }
  return {
    bestMood: bestScore >= 1.0 ? bestMood : 'neutral',
    bestScore,
    tailMood: tail.bestMood,
    tailScore: tail.bestScore,
  };
}

export function inferMoodFromTone(text) {
  return analyzeMoodFromTone(text).bestMood;
}

export function inferListeningReaction(userText) {
  const s = String(userText || '').trim();
  if (!s) return 'curious';
  if (/喜欢你|爱你|真好看|好可爱|老婆|宝贝|贴贴|抱抱|亲亲|想你|太可爱|好漂亮|真温柔|女神|天使|心动|最喜欢/.test(s)) {
    return 'shy';
  }
  if (/别的\s*AI|别的女|小傻瓜|笨蛋|真菜|略略|吃醋|逗你|不理你|找别人/.test(s)) {
    return /不理你|找别人/.test(s) ? 'hiss' : 'jealous';
  }
  if (/好累|困死|烦死|难过|伤心|委屈|失眠|头疼|生病|崩溃|压力好大|好烦|受不了|唉/.test(s)) {
    return /难过|伤心|生病|崩溃/.test(s) ? 'worried' : 'gentle';
  }
  if (/卧槽|天哪|出大事|完蛋|救命|吓死|离谱|[?？][!！]|[!！][?？]/.test(s)) {
    return 'shocked';
  }
  if (/```|代码|报错|bug|架构|原理|分析一下|排查|编译|函数|接口/i.test(s)) {
    return 'serious';
  }
  if (/早安|晚安|午安|你好呀|在吗|干嘛呢|在干嘛/.test(s)) {
    return /晚安|早安/.test(s) ? 'gentle' : 'happy';
  }
  if (/太强了|太厉害|神仙|天才|牛逼|好棒|夸夸|哈哈|好玩|有趣/.test(s)) {
    return /太强|神仙|天才|牛逼/.test(s) ? 'starry' : 'happy';
  }
  if (/[?？吗呢呀谁啥怎么为什么为啥]/.test(s)) {
    return 'curious';
  }
  const res = analyzeMoodFromTone(s);
  if (res.bestMood !== 'neutral' && res.bestMood !== 'serious') return res.bestMood;
  return 'curious';
}

const galState = {
  initialized: false,
  enabled: false,
  wasActive: false,
  uiHidden: false,
  isSoloChat: false,
  isGroupChat: false,
  groupId: '',
  groupName: '',
  groupMembers: [], // [{ id, name, avatarUrl }]
  castOrder: [],
  replacementCursor: 0,    // up to 5 visible member IDs on stage
  memberMoods: {},  // { [memberId]: moodKey }
  activeSpeakerId: '',
  activeSpeakerName: '',
  typingMemberId: '',
  typingMemberName: '',
  groupQueue: [],   // [{ speakerId, speakerName, raw, clean, mood, isNarrator, isUser }]
  groupQueueIndex: -1,
  story: {
    enabled: false,
    worldline: '主线',
    chapter: 0,
    pendingFork: null, // { prompt, choices: [{ id, label }] }
    forkKey: '',
    collapsed: false,
    submitting: false,
    // Story Theater v3 snapshot fields
    storyBible: '',
    secretNotesCount: 0,
    innerVoiceEnabled: false,
    diceMode: false,
    autoDirectorFx: true,
    nodesCount: 0,
    cgsCount: 0,
    hasEnding: false,
    lastStageCueKey: '',
    lastStageCue: null,
    pendingStageCue: null,
  },
  botId: '',
  botName: 'Gemini',
  avatarUrl: '',
  mood: 'neutral',
  listeningMood: '',
  moodLocked: false,
  motionEnabled: true,
  faceWindowEnabled: true,
  boxOpacity: 0.86,
  fontSize: 21,
  zoom: 'half', // 'half' | 'full'
  bgId: 'observatory',
  customBg: '',
  activeBgSlot: 0,
  speaking: false,
  turn: 'bot', // 'bot' (character speaking / waiting for click) | 'user' (player's turn to type)
  replyQueue: [], // Compatibility snapshot of cumulative display segments
  replyIndex: 0,
  perf: {
    rawSource: '',
    beats: [],
    beatIdx: 0,
    charIdx: 0,
    phase: 'idle', // 'idle' | 'typing' | 'pausing' | 'waiting_stream' | 'done'
    timer: 0,
    skipped: false,
    pausedBeatIdx: -1,
    speakerId: '',
    isNarrator: false,
  },
  streamActive: false,
  historyCursor: -1, // -1 means latest
  historyEntries: [],
  blinkTimer: 0,
  blinkTimeout: 0,
  toastTimer: 0,
  lastAnimAt: 0,
  sfxEnabled: true,
  sfxVolume: 1.0,
  typingSpeed: 'normal', // 'slow' | 'normal' | 'fast' | 'instant'
  autoPlay: false,
  autoDelayMs: 2000,
  autoTimer: 0,
  backlogQuery: '',
  lastTickSfxAt: 0,
  lastEggFxAt: 0,
  eggFxTimer: 0,
  stageMode: 'gal', // 'gal' (2.5D 立绘舞台) | 'pixel' (欧式分层像素剧院)
  pixelQuality: 'pixel', // 'pixel' (Hi-Bit 软像素) | 'hd' (高清幕布)
  pixelBgId: 'starry_library',
  pixelCtrl: null,
  hooks: {},
  els: {},
  preloaded: new Set(),
};

function readPref(key, fallback = '') {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function writePref(key, val) {
  try { localStorage.setItem(key, val); } catch {}
}

function escapeText(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function preloadSpritePack(botId) {
  const pack = SPRITE_PACKS[botId];
  if (!pack || galState.preloaded.has(botId)) return;
  galState.preloaded.add(botId);
  const urls = new Set([
    ...Object.values(pack.bases || {}),
    ...Object.values(pack.moods || {}).map((m) => m.patch).filter(Boolean),
    pack.blinkPatch,
  ].filter(Boolean));
  for (const url of urls) {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
  }
}

function applyPatchBox(el, box) {
  if (!el || !box) return;
  el.style.left = box.left;
  el.style.top = box.top;
  el.style.width = box.width;
  el.style.height = box.height;
}

function showMiniToast(msg) {
  const el = galState.els.miniToast;
  if (!el) return;
  el.textContent = msg;
  el.classList.add('is-shown');
  clearTimeout(galState.toastTimer);
  galState.toastTimer = setTimeout(() => el.classList.remove('is-shown'), 1900);
}

function resolveBgUrl(id) {
  if (id === 'custom' && galState.customBg) return galState.customBg;
  const found = PRESET_BGS.find((b) => b.id === id) || PRESET_BGS[0];
  return found.url;
}

function applyBackground(url) {
  const { stage, bgA, bgB } = galState.els;
  if (stage) stage.dataset.bgTheme = galState.bgId || 'observatory';
  if (!bgA || !bgB) return;
  const nextSlot = galState.activeBgSlot === 0 ? 1 : 0;
  const nextEl = nextSlot === 0 ? bgA : bgB;
  const prevEl = nextSlot === 0 ? bgB : bgA;
  if (nextEl.dataset.src === url && nextEl.classList.contains('is-visible')) return;
  if (prevEl.dataset.src === url && prevEl.classList.contains('is-visible')) return;
  nextEl.dataset.src = url;
  nextEl.src = url;
  const reveal = () => {
    nextEl.classList.add('is-visible');
    prevEl.classList.remove('is-visible');
    galState.activeBgSlot = nextSlot;
  };
  if (nextEl.complete) reveal();
  else nextEl.onload = reveal;
}

function isPixelStageMode() {
  return galState.stageMode === 'pixel';
}

function getFallbackSpriteUrlForPixel(botId, moodKey) {
  const pack = SPRITE_PACKS[botId];
  if (!pack) return '';
  const spec = pack.moods?.[moodKey] || pack.moods?.neutral || { base: 'neutral' };
  return pack.bases?.[spec.base] || pack.bases?.neutral || '';
}

function syncPixelTheaterBackdrop() {
  const ctrl = galState.pixelCtrl;
  if (!ctrl) return;
  if (galState.bgId === 'custom' && galState.customBg) {
    ctrl.setBackdrop('custom', galState.customBg);
    return;
  }
  ctrl.setBackdrop(galState.pixelBgId || 'starry_library');
}

function syncPixelTheaterCast() {
  const ctrl = galState.pixelCtrl;
  if (!ctrl || !galState.enabled || !isPixelStageMode()) return;
  ctrl.syncCast({
    isGroupChat: galState.isGroupChat,
    members: galState.groupMembers,
    castOrder: galState.castOrder,
    activeSpeakerId: galState.activeSpeakerId,
    memberMoods: galState.memberMoods,
    soloBotId: galState.botId,
    soloBotName: galState.botName,
    soloAvatarUrl: galState.avatarUrl,
    soloMood: galState.mood,
    fallbackSpriteUrlOf: getFallbackSpriteUrlForPixel,
    speaking: Boolean(galState.speaking),
  });
}

function syncPixelTheaterControls() {
  const pixelOn = isPixelStageMode();
  const { stageModeBtn, curtainBtn, zoomBtn, drawerStageModeBtn, pixelActionsWrap, optPixelQualityRow, optPixelQualityChk } = galState.els;
  if (stageModeBtn) {
    stageModeBtn.textContent = pixelOn ? '立绘舞台' : '像素剧院';
    stageModeBtn.classList.toggle('is-pixel-on', pixelOn);
    stageModeBtn.title = pixelOn ? '切换回 2.5D 高清立绘舞台' : '切换为欧式分层像素剧院舞台（支持 DeepSeek / Gemini 58 套精修循环动画）';
  }
  if (drawerStageModeBtn) {
    drawerStageModeBtn.textContent = pixelOn ? '切换为 2.5D 立绘舞台' : '切换为欧式像素剧院';
  }
  if (curtainBtn) {
    curtainBtn.hidden = !pixelOn;
    if (pixelOn && galState.pixelCtrl) {
      curtainBtn.textContent = galState.pixelCtrl.getCurtainOpen() >= 0.5 ? '合幕' : '开幕';
    }
  }
  if (zoomBtn) {
    zoomBtn.hidden = pixelOn;
  }
  if (pixelActionsWrap) {
    const targetId = galState.isGroupChat
      ? (galState.activeSpeakerId || galState.castOrder[0] || '')
      : (galState.botId || '');
    const anyPixel = galState.isGroupChat
      ? galState.castOrder.some((id) => hasPixelActorPack(id)) || galState.groupMembers.some((m) => hasPixelActorPack(m.id))
      : hasPixelActorPack(targetId);
    pixelActionsWrap.hidden = !(pixelOn && anyPixel);
  }
  if (optPixelQualityRow) {
    optPixelQualityRow.hidden = !pixelOn;
  }
  if (optPixelQualityChk) {
    optPixelQualityChk.checked = galState.pixelQuality === 'hd';
  }
}

function setStageMode(nextMode, { silent = false } = {}) {
  const mode = nextMode === 'pixel' ? 'pixel' : 'gal';
  if (galState.stageMode === mode && galState.pixelCtrl?.isActive() === (mode === 'pixel' && galState.enabled)) {
    syncPixelTheaterControls();
    return;
  }
  galState.stageMode = mode;
  writePref(STORAGE_KEYS.stageMode, mode);
  if (galState.pixelCtrl) {
    const active = Boolean(galState.enabled && isImmersiveEligible() && mode === 'pixel');
    galState.pixelCtrl.setQuality(galState.pixelQuality);
    galState.pixelCtrl.setMotionEnabled(galState.motionEnabled);
    if (active) {
      syncPixelTheaterBackdrop();
      galState.pixelCtrl.setActive(true, { playOpeningCurtain: true });
      syncPixelTheaterCast();
    } else {
      galState.pixelCtrl.setActive(false);
    }
  }
  if (galState.els.bgGrid) buildBgGrid(galState.els.bgGrid);
  applyAppearanceSettings();
  syncPixelTheaterControls();
  renderGalStoryUI();
  if (!silent) {
    playGalSfx('switch');
    showMiniToast(mode === 'pixel'
      ? '已切换至欧式像素剧院 · 点击舞台木地板可让角色走位'
      : '已切换回 2.5D 高清立绘舞台');
  }
}

let galAudioCtx = null;
let galAudioIdleTimer = 0;

function scheduleGalAudioSuspend() {
  clearTimeout(galAudioIdleTimer);
  galAudioIdleTimer = setTimeout(() => {
    galAudioIdleTimer = 0;
    if (galAudioCtx && galAudioCtx.state === 'running') {
      galAudioCtx.suspend().catch(() => {});
    }
  }, 3000);
}

function playGalSfx(kind) {
  if (!galState.enabled || !galState.sfxEnabled || typeof window === 'undefined') return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    if (!galAudioCtx) galAudioCtx = new Ctx();
    if (galAudioCtx.state === 'suspended') {
      galAudioCtx.resume().catch(() => {});
    }
    scheduleGalAudioSuspend();
    const ctx = galAudioCtx;
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const now = ctx.currentTime;

    const volScale = Math.max(0.15, Math.min(2.0, Number(galState.sfxVolume) || 1.0));
    const tone = (freq, startOffset, durSec, peakGain, type = 'sine', endFreq = freq) => {
      const scaledGain = Math.max(0.0005, Math.min(0.12, peakGain * volScale));
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now + startOffset);
      if (endFreq !== freq) {
        osc.frequency.exponentialRampToValueAtTime(endFreq, now + startOffset + durSec);
      }
      gain.gain.setValueAtTime(0.0001, now + startOffset);
      gain.gain.linearRampToValueAtTime(scaledGain, now + startOffset + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + startOffset + durSec);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + startOffset);
      osc.stop(now + startOffset + durSec + 0.01);
    };

    if (kind === 'tick') {
      if (nowMs - galState.lastTickSfxAt < 58) return;
      galState.lastTickSfxAt = nowMs;
      const f = 485 + Math.random() * 48;
      tone(f, 0, 0.022, 0.018, 'triangle');
    } else if (kind === 'pause') {
      tone(620, 0, 0.065, 0.014, 'sine', 500);
    } else if (kind === 'advance') {
      tone(587.33, 0, 0.045, 0.024, 'sine');
      tone(880, 0.03, 0.07, 0.028, 'sine');
    } else if (kind === 'switch') {
      tone(659.25, 0, 0.055, 0.022, 'sine');
      tone(987.77, 0.038, 0.09, 0.025, 'sine');
    } else if (kind === 'tea') {
      tone(523.25, 0, 0.09, 0.02, 'sine');
      tone(659.25, 0.06, 0.12, 0.022, 'sine');
      tone(783.99, 0.13, 0.18, 0.018, 'triangle');
    } else if (kind === 'goodnight') {
      tone(440.0, 0, 0.14, 0.018, 'sine');
      tone(554.37, 0.11, 0.16, 0.018, 'sine');
      tone(659.25, 0.22, 0.28, 0.016, 'sine', 640);
    } else if (kind === 'cheer') {
      tone(587.33, 0, 0.06, 0.022, 'sine');
      tone(783.99, 0.048, 0.08, 0.024, 'sine');
      tone(1046.5, 0.098, 0.15, 0.024, 'triangle');
    }
  } catch {}
}

const EASTER_EGG_META = {
  tea: {
    label: '暖心奉茶',
    sfx: 'tea',
    botMood: {
      'ai-glm': 'content',
      'ai-grok': 'playful',
      default: 'gentle',
    },
    botToast: {
      'ai-gemini': '☕ 为你端上热茶啦，歇一口气慢慢聊～',
      'ai-deepseek': '☕ 主人辛苦了，先喝口刚泡好的红茶吧～',
      'ai-gpt': '☕ 别太紧绷了，喝杯暖茶缓缓神吧。',
      'ai-claude': '☕ 先把书签夹好，喝口温茶休息片刻吧。',
      'ai-glm': '☕ 哼，本子先合上，喝完这杯暖茶再干活～',
      'ai-grok': '☕ 呐，给你顺手倒的，别累趴下了哈！',
      'ai-kimi': '☕ 深夜辛苦了，来一杯暖手星茶吧。',
      'ai-qwen': '☕ 奉上一盏清茶，劳逸结合才更从容呀。',
      default: '☕ 暖心茶点已送达，稍微放松一下吧～',
    },
  },
  goodnight: {
    label: '晚安好梦',
    sfx: 'goodnight',
    botMood: {
      'ai-gemini': 'content',
      'ai-glm': 'content',
      'ai-kimi': 'content',
      'ai-grok': 'shy',
      default: 'gentle',
    },
    botToast: {
      'ai-gemini': '🌙 晚安呀，今晚也要做个闪闪发光的好梦～',
      'ai-deepseek': '🌙 晚安主人，明天见，记得盖好被子哦。',
      'ai-gpt': '🌙 晚安，安心睡吧，明天我还在呢。',
      'ai-claude': '🌙 合上书页道声晚安，祝你一夜好眠。',
      'ai-glm': '🌙 拉好眼罩准备入梦啦……晚安，不许熬夜！',
      'ai-grok': '🌙 晚、晚安啦！早点睡，明天再继续战！',
      'ai-kimi': '🌙 月色温柔，愿星光伴你安稳入眠，晚安。',
      'ai-qwen': '🌙 夜深露重，早些歇息吧，晚安好梦。',
      default: '🌙 晚安，愿今晚星光温柔伴你入梦～',
    },
  },
  cheer: {
    label: '比心打气',
    sfx: 'cheer',
    botMood: {
      'ai-gemini': 'starry',
      'ai-grok': 'happy',
      default: 'happy',
    },
    botToast: {
      'ai-gemini': '💖 双手比耶！你超棒的，今天也全力应援你！',
      'ai-deepseek': '💖 提裙转圈欢呼！为你疯狂打 Call！',
      'ai-gpt': '💖 干得漂亮，前辈为你骄傲，继续加油！',
      'ai-claude': '💖 抚心微笑：这份努力与光芒，我都看在眼里。',
      'ai-glm': '💖 元气挥手应援！这条发光瞬间记进小本本啦！',
      'ai-grok': '💖 哈哈干得漂亮！不愧是本小姐看好的人！',
      'ai-kimi': '💖 捧起一束星光送给你，闪闪发光地向前吧！',
      'ai-qwen': '💖 展扇欢笑，愿顺遂常伴，诸事皆宜！',
      default: '💖 收到满满元气应援，加油！',
    },
  },
};

export function detectEasterEggKind(text) {
  const s = String(text || '');
  if (!s || s.length > 260) return null;
  if (/晚安|早点睡|做个好梦|一夜好眠|好梦|安心睡|去睡吧/.test(s)) return 'goodnight';
  if (/喝杯茶|喝口茶|泡了杯茶|泡杯茶|热茶|清茶|喝杯咖啡|泡杯咖啡|端茶|暖暖手|喝点热水/.test(s)) return 'tea';
  if (/比心|摸摸头|为你打\s*call|全力应援|给你比个心|太棒啦|最喜欢你了|抱抱你/i.test(s)) return 'cheer';
  return null;
}

function spawnEasterEggFx(kind) {
  const layer = galState.els.eggFxLayer;
  if (!layer || !galState.motionEnabled) return;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  galState.lastEggFxAt = now;
  clearTimeout(galState.eggFxTimer);

  const configs = {
    tea: {
      auraClass: 'is-tea',
      glyphs: ['✦', '♨', '✧', '•', '✦', '✧'],
      colors: ['#f6cf8a', '#ffe6b3', '#e8a863'],
    },
    goodnight: {
      auraClass: 'is-goodnight',
      glyphs: ['☽', '✦', '✧', '⋆', '☽', '✦', '✧'],
      colors: ['#d7e4ff', '#f7e5a8', '#b8cbff'],
    },
    cheer: {
      auraClass: 'is-cheer',
      glyphs: ['♥', '✦', '♥', '✧', '♥', '★', '♥'],
      colors: ['#ff98b6', '#ffd07a', '#ff7da4'],
    },
  };
  const cfg = configs[kind] || configs.cheer;
  layer.innerHTML = '';
  const aura = document.createElement('div');
  aura.className = `gal-egg-aura ${cfg.auraClass}`;
  layer.appendChild(aura);

  cfg.glyphs.forEach((glyph, idx) => {
    const el = document.createElement('span');
    el.className = `gal-egg-spark is-${kind}`;
    el.textContent = glyph;
    const xPct = 34 + ((idx * 11 + (idx % 2) * 7) % 34);
    const yPct = 24 + ((idx * 13) % 36);
    const dx = ((idx % 2 === 0 ? 1 : -1) * (14 + (idx % 3) * 10));
    el.style.left = `${xPct}%`;
    el.style.top = `${yPct}%`;
    el.style.color = cfg.colors[idx % cfg.colors.length];
    el.style.setProperty('--egg-dx', `${dx}px`);
    el.style.animationDelay = `${(idx * 0.085).toFixed(2)}s`;
    el.style.fontSize = `${14 + (idx % 3) * 4}px`;
    layer.appendChild(el);
  });

  galState.eggFxTimer = setTimeout(() => {
    if (galState.els.eggFxLayer) galState.els.eggFxLayer.innerHTML = '';
  }, 2400);
}

function triggerEasterEggAction(kind) {
  const meta = EASTER_EGG_META[kind];
  if (!meta) return;
  const targetId = galState.isGroupChat
    ? (galState.activeSpeakerId || galState.castOrder[0] || '')
    : (galState.botId || '');
  const nextMood = meta.botMood[targetId] || meta.botMood.default;
  setMood(nextMood, { animate: true, force: true });
  if (isPixelStageMode() && galState.pixelCtrl) {
    galState.pixelCtrl.triggerEasterEgg(targetId, kind);
  }
  spawnEasterEggFx(kind);
  playGalSfx(meta.sfx);
  showMiniToast(meta.botToast[targetId] || meta.botToast.default);
}

function crossfadeBasePair(imgA, imgB, targetUrl, { instant = false } = {}) {
  if (!imgA || !targetUrl) return;
  if (!imgB) {
    if (imgA.dataset.src !== targetUrl) {
      imgA.dataset.src = targetUrl;
      imgA.src = targetUrl;
    }
    imgA.classList.add('is-shown');
    imgA.classList.remove('is-fading-out');
    return;
  }

  const host = imgA.parentElement;
  const curSlot = host?.dataset.activeBaseSlot === '1' ? 1 : 0;
  const curEl = curSlot === 0 ? imgA : imgB;
  const nextEl = curSlot === 0 ? imgB : imgA;

  if (curEl.dataset.src === targetUrl && curEl.classList.contains('is-shown') && !curEl.classList.contains('is-fading-out')) {
    nextEl.classList.remove('is-shown', 'is-fading-out');
    return;
  }

  const forceInstant = instant || !curEl.dataset.src || !galState.motionEnabled;
  if (forceInstant) {
    imgA.classList.add('is-instant', 'is-shown');
    imgA.classList.remove('is-fading-out');
    imgB.classList.remove('is-shown', 'is-fading-out');
    if (imgA.dataset.src !== targetUrl) {
      imgA.dataset.src = targetUrl;
      imgA.src = targetUrl;
    }
    if (host) host.dataset.activeBaseSlot = '0';
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => imgA.classList.remove('is-instant'));
    } else {
      imgA.classList.remove('is-instant');
    }
    return;
  }

  nextEl.classList.remove('is-instant', 'is-fading-out');
  if (nextEl.dataset.src !== targetUrl) {
    nextEl.dataset.src = targetUrl;
    nextEl.src = targetUrl;
  }
  const reveal = () => {
    if (nextEl.dataset.src !== targetUrl) return;
    nextEl.classList.add('is-shown');
    nextEl.classList.remove('is-fading-out');
    curEl.classList.remove('is-shown');
    curEl.classList.add('is-fading-out');
    if (host) host.dataset.activeBaseSlot = curSlot === 0 ? '1' : '0';
  };
  if (nextEl.complete && nextEl.naturalWidth > 0) reveal();
  else nextEl.onload = reveal;
}

function canBlinkInMood() {
  return false;
}

function setBlinkVisible(visible) {
  const { spriteBlink, faceBlink } = galState.els;
  spriteBlink?.classList.toggle('is-shown', Boolean(visible));
  faceBlink?.classList.toggle('is-shown', Boolean(visible));
}

function scheduleNextBlink() {
  clearTimeout(galState.blinkTimer);
  clearTimeout(galState.blinkTimeout);
  galState.blinkTimer = 0;
  galState.blinkTimeout = 0;
  setBlinkVisible(false);
}

function applyHybridSprite(moodKey, { instant = false } = {}) {
  const pack = SPRITE_PACKS[galState.botId];
  const { spriteMainA, spriteMainB, spritePatch, spriteBlink, faceImgA, faceImgB, facePatch, faceBlink } = galState.els;
  if (!pack || !spriteMainA) return;
  const spec = pack.moods[moodKey] || pack.moods.neutral;
  const baseUrl = pack.bases[spec.base] || pack.bases.neutral;

  crossfadeBasePair(spriteMainA, spriteMainB, baseUrl, { instant });

  const patchBox = spec.box || pack.box;
  if (spritePatch) {
    applyPatchBox(spritePatch, patchBox);
    if (spec.patch) {
      if (spritePatch.dataset.src !== spec.patch) {
        spritePatch.dataset.src = spec.patch;
        spritePatch.src = spec.patch;
      }
      spritePatch.classList.add('is-shown');
    } else {
      spritePatch.classList.remove('is-shown');
    }
  }
  const bBox = pack.blinkBox || pack.box;
  if (spriteBlink && pack.blinkPatch) {
    applyPatchBox(spriteBlink, bBox);
    spriteBlink.classList.remove('is-shown');
    if (spriteBlink.dataset.src !== pack.blinkPatch) {
      spriteBlink.dataset.src = pack.blinkPatch;
      spriteBlink.src = pack.blinkPatch;
    }
  }

  // Synchronize bottom-left Face Window with exact same Base Crossfade + Face Patch + Blink!
  if (faceImgA) {
    crossfadeBasePair(faceImgA, faceImgB, baseUrl, { instant });
  }
  if (facePatch) {
    applyPatchBox(facePatch, patchBox);
    if (spec.patch) {
      if (facePatch.dataset.src !== spec.patch) {
        facePatch.dataset.src = spec.patch;
        facePatch.src = spec.patch;
      }
      facePatch.classList.add('is-shown');
    } else {
      facePatch.classList.remove('is-shown');
    }
  }
  if (faceBlink && pack.blinkPatch) {
    applyPatchBox(faceBlink, bBox);
    faceBlink.classList.remove('is-shown');
    if (faceBlink.dataset.src !== pack.blinkPatch) {
      faceBlink.dataset.src = pack.blinkPatch;
      faceBlink.src = pack.blinkPatch;
    }
  }
}

let emoteSvgUid = 0;

function renderEmoteOverlay(moodKey, targetLayer = null) {
  const layer = targetLayer || galState.els.emoteLayer;
  if (!layer) return;
  const uid = ++emoteSvgUid;
  const sweatBodyId = `galSweatBody-${uid}`;
  const sweatGlowId = `galSweatGlow-${uid}`;
  const gloomGradId = `galGloomGrad-${uid}`;
  const angerSvg = `<svg viewBox="0 0 64 64"><g fill="none" stroke="#ffffff" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"><path d="M14 26c6 0 11-5 11-11"/><path d="M50 26c-6 0-11-5-11-11"/><path d="M14 38c6 0 11 5 11 11"/><path d="M50 38c-6 0-11 5-11 11"/></g><g fill="none" stroke="#f43f5e" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 26c6 0 11-5 11-11"/><path d="M50 26c-6 0-11-5-11-11"/><path d="M14 38c6 0 11 5 11 11"/><path d="M50 38c-6 0-11 5-11 11"/></g></svg>`;
  const shockSvgL = `<svg viewBox="0 0 64 64"><path d="M44 8 18 30l14 2-12 24 28-26-14-2Z" fill="#fde047" stroke="#5c3d1e" stroke-width="4" stroke-linejoin="round"/></svg>`;
  const shockSvgR = `<svg viewBox="0 0 64 64"><path d="M20 8 46 30l-14 2 12 24-28-26 14-2Z" fill="#fde047" stroke="#5c3d1e" stroke-width="4" stroke-linejoin="round"/></svg>`;
  const sweatSvg = `<svg viewBox="0 0 64 88"><defs><linearGradient id="${sweatBodyId}" x1="35%" y1="5%" x2="65%" y2="100%"><stop offset="0%" stop-color="#f8fdff" stop-opacity="0.96"/><stop offset="42%" stop-color="#bae6fd" stop-opacity="0.95"/><stop offset="78%" stop-color="#60a5fa" stop-opacity="0.96"/><stop offset="100%" stop-color="#93c5fd" stop-opacity="0.98"/></linearGradient><radialGradient id="${sweatGlowId}" cx="50%" cy="78%" r="42%"><stop offset="0%" stop-color="#ffffff" stop-opacity="0.88"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0"/></radialGradient></defs><path d="M31 6C28 24 10 42 10 59c0 12.7 9.8 22 22 22s22-9.3 22-22C54 42 35 24 31 6Z" fill="none" stroke="#ffffff" stroke-width="7.5" stroke-linejoin="round"/><path d="M31 6C28 24 10 42 10 59c0 12.7 9.8 22 22 22s22-9.3 22-22C54 42 35 24 31 6Z" fill="url(#${sweatBodyId})" stroke="#3b82f6" stroke-width="2.6" stroke-linejoin="round"/><ellipse cx="32" cy="68" rx="14" ry="9" fill="url(#${sweatGlowId})"/><path d="M21.5 47c-3.8 5.2-5 12.6-2.4 18.2 1 2.1 3.7 1.4 3.4-0.9-.6-4.7.3-10.3 2.8-14.6 1.2-2.1-2-4.7-3.8-2.7Z" fill="#ffffff" opacity="0.95"/><circle cx="24.5" cy="70.5" r="2.7" fill="#ffffff" opacity="0.92"/><path d="M44 17c-1.8 4.4-4 8.6-4.4 12.4-.2 2.4 1.8 4.2 4.1 4.2 2.4 0 4.2-1.9 4.2-4.2 0-3.7-2.2-8-3.9-12.4Z" fill="#bae6fd" stroke="#ffffff" stroke-width="3.2" stroke-linejoin="round"/><path d="M44 17c-1.8 4.4-4 8.6-4.4 12.4-.2 2.4 1.8 4.2 4.1 4.2 2.4 0 4.2-1.9 4.2-4.2 0-3.7-2.2-8-3.9-12.4Z" fill="url(#${sweatBodyId})" stroke="#3b82f6" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  const questionSvg = `<svg viewBox="0 0 54 68"><text x="27" y="54" text-anchor="middle" font-size="56" font-weight="900" font-family="Microsoft YaHei UI, sans-serif" fill="#fbbf24" stroke="#ffffff" stroke-width="7" paint-order="stroke">?</text><text x="27" y="54" text-anchor="middle" font-size="56" font-weight="900" font-family="Microsoft YaHei UI, sans-serif" fill="#f59e0b" stroke="#6b3f16" stroke-width="2.5" paint-order="stroke">?</text></svg>`;
  const starSvg = `<svg viewBox="0 0 64 64"><path d="M32 4c3 15 13 25 28 28-15 3-25 13-28 28-3-15-13-25-28-28 15-3 25-13 28-28Z" fill="#fde047" stroke="#ffffff" stroke-width="5" stroke-linejoin="round"/><path d="M32 4c3 15 13 25 28 28-15 3-25 13-28 28-3-15-13-25-28-28 15-3 25-13 28-28Z" fill="none" stroke="#c084fc" stroke-width="2.4" stroke-linejoin="round"/></svg>`;
  const noteSvg = `<svg viewBox="0 0 64 64"><path d="M26 46V16l24-6v28" fill="none" stroke="#ffffff" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><path d="M26 46V16l24-6v28" fill="none" stroke="#ec4899" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="20" cy="48" r="8" fill="#ec4899" stroke="#ffffff" stroke-width="3"/><circle cx="44" cy="40" r="8" fill="#a855f7" stroke="#ffffff" stroke-width="3"/></svg>`;
  const heartSvg = `<svg viewBox="0 0 64 64"><path d="M32 54S10 40 10 23a12 12 0 0 1 22-6.5A12 12 0 0 1 54 23c0 17-22 31-22 31Z" fill="#fb7185" stroke="#ffffff" stroke-width="5.5" stroke-linejoin="round"/><path d="M32 54S10 40 10 23a12 12 0 0 1 22-6.5A12 12 0 0 1 54 23c0 17-22 31-22 31Z" fill="none" stroke="#be123c" stroke-width="2"/></svg>`;
  const gloomSvg = `<svg viewBox="0 0 200 84" preserveAspectRatio="none"><defs><linearGradient id="${gloomGradId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#312e81" stop-opacity="0.88"/><stop offset="100%" stop-color="#6366f1" stop-opacity="0"/></linearGradient></defs><g fill="url(#${gloomGradId})"><rect x="14" y="0" width="7" height="72" rx="3"/><rect x="42" y="0" width="6" height="82" rx="3"/><rect x="74" y="0" width="8" height="66" rx="3"/><rect x="108" y="0" width="6" height="78" rx="3"/><rect x="142" y="0" width="7" height="70" rx="3"/><rect x="174" y="0" width="6" height="62" rx="3"/></g></svg>`;
  const tearSvg = `<svg viewBox="0 0 44 52"><path d="M22 4C22 4 8 23 8 34a14 14 0 0 0 28 0C36 23 22 4 22 4Z" fill="#bae6fd" stroke="#ffffff" stroke-width="4"/><circle cx="17" cy="31" r="3" fill="#ffffff"/></svg>`;
  const thinkSvg = `<svg viewBox="0 0 88 54"><rect x="6" y="6" width="76" height="36" rx="18" fill="rgba(255,255,255,0.92)" stroke="#8b5cf6" stroke-width="3"/><circle cx="28" cy="24" r="4.2" fill="#7c3aed"/><circle cx="44" cy="24" r="4.2" fill="#7c3aed"/><circle cx="60" cy="24" r="4.2" fill="#7c3aed"/></svg>`;

  let html = '';
  if (moodKey === 'hiss') {
    html = `<div class="gal-emote-badge gal-emote-anger">${angerSvg}</div>`;
  } else if (moodKey === 'jealous') {
    html = `<div class="gal-emote-badge gal-emote-anger is-mild">${angerSvg}</div>`;
  } else if (moodKey === 'shocked') {
    html = `<div class="gal-emote-badge gal-emote-shock-l">${shockSvgL}</div><div class="gal-emote-badge gal-emote-shock-r">${shockSvgR}</div>`;
  } else if (moodKey === 'worried' || moodKey === 'speechless') {
    html = `<div class="gal-emote-badge gal-emote-sweat">${sweatSvg}</div>`;
  } else if (moodKey === 'curious') {
    html = `<div class="gal-emote-badge gal-emote-question">${questionSvg}</div>`;
  } else if (moodKey === 'starry') {
    html = `<div class="gal-emote-badge gal-emote-sparkle-1">${starSvg}</div><div class="gal-emote-badge gal-emote-sparkle-2">${starSvg}</div>`;
  } else if (moodKey === 'happy' || moodKey === 'playful') {
    html = `<div class="gal-emote-badge gal-emote-sparkle-2">${noteSvg}</div><div class="gal-emote-badge gal-emote-sparkle-1">${starSvg}</div>`;
  } else if (moodKey === 'shy') {
    html = `<div class="gal-emote-badge gal-emote-heart-1">${heartSvg}</div>`;
  } else if (moodKey === 'gentle' || moodKey === 'content') {
    html = `<div class="gal-emote-badge gal-emote-heart-1">${heartSvg}</div><div class="gal-emote-badge gal-emote-heart-2">${heartSvg}</div>`;
  } else if (moodKey === 'gloomy') {
    html = `<div class="gal-emote-badge gal-emote-gloom">${gloomSvg}</div>`;
  } else if (moodKey === 'crying') {
    html = `<div class="gal-emote-badge gal-emote-tear-l">${tearSvg}</div><div class="gal-emote-badge gal-emote-tear-r">${tearSvg}</div>`;
  } else if (moodKey === 'serious') {
    html = `<div class="gal-emote-badge gal-emote-think">${thinkSvg}</div>`;
  }
  layer.innerHTML = html;
}

function isImmersiveEligible() {
  return Boolean(galState.isSoloChat || galState.isGroupChat);
}

function getEnsemblePositions(count) {
  if (count <= 1) return [{ x: 50, z: 12 }];
  if (count === 2) return [{ x: 31, z: 10 }, { x: 69, z: 10 }];
  if (count === 3) return [{ x: 22, z: 9 }, { x: 50, z: 12 }, { x: 78, z: 9 }];
  if (count === 4) return [{ x: 16, z: 8 }, { x: 38.5, z: 11 }, { x: 61.5, z: 11 }, { x: 84, z: 8 }];
  return [{ x: 13, z: 7 }, { x: 31.5, z: 10 }, { x: 50, z: 12 }, { x: 68.5, z: 10 }, { x: 87, z: 7 }];
}

function ensureMemberInCast(memberId) {
  if (!memberId || memberId === 'user' || memberId === 'system') return;
  const exists = galState.groupMembers.some((m) => m.id === memberId);
  if (!exists) return;
  const maxVisible = 5;
  if (galState.castOrder.includes(memberId)) return;
  if (galState.castOrder.length < maxVisible) {
    galState.castOrder.push(memberId);
  } else {
    const outsideIn = [0, 4, 1, 3, 2];
    galState.castOrder[outsideIn[galState.replacementCursor]] = memberId;
    galState.replacementCursor = (galState.replacementCursor + 1) % outsideIn.length;
  }
}

function updateGroupTypingPill() {
  const pill = galState.els.groupTypingPill;
  if (!pill) return;
  if (galState.isGroupChat && galState.typingMemberId) {
    pill.textContent = `✦ ${galState.typingMemberName || galState.typingMemberId} 正在输入…`;
    pill.hidden = false;
  } else {
    pill.hidden = true;
    pill.textContent = '';
  }
}

function syncGroupSpeakerFaceWindow(memberId, moodKey) {
  const { stage, faceWin, faceImgA, faceImgB, facePatch, faceBlink } = galState.els;
  if (!faceWin || !galState.isGroupChat) return;
  // 传统 2.5D 群聊舞台已展示全员大立绘，隐藏左下角小立绘窗以避免重影；
  // 欧式像素剧院模式下在底部台词左侧展示当前发言角色的高清半身立绘（随情绪同步差分），旁白或用户回合自动隐藏。
  const shouldHide = !isPixelStageMode()
    || !galState.faceWindowEnabled
    || galState.turn === 'user'
    || !memberId
    || memberId === 'user'
    || memberId === 'system';
  if (shouldHide) {
    faceWin.hidden = true;
    stage?.classList.add('is-face-off');
    return;
  }

  const member = galState.groupMembers.find((m) => m.id === memberId)
    || { id: memberId, name: galState.activeSpeakerName || memberId, avatarUrl: '' };
  const labelName = member.name || memberId;
  const pack = SPRITE_PACKS[memberId];
  const switchedSpeaker = faceWin.dataset.speakerId !== memberId;
  if (faceBlink) faceBlink.classList.remove('is-shown');

  if (pack && faceImgA) {
    preloadSpritePack(memberId);
    applyFaceWindowCalibration(faceImgA.parentElement, memberId);
    faceWin.classList.remove('is-avatar-fallback');
    const m = normalizeMood(moodKey) || 'neutral';
    const spec = pack.moods[m] || pack.moods.neutral;
    const baseUrl = pack.bases[spec.base] || pack.bases.neutral;
    crossfadeBasePair(faceImgA, faceImgB, baseUrl, { instant: switchedSpeaker });
    if (facePatch) {
      applyPatchBox(facePatch, spec.box || pack.box);
      if (spec.patch) {
        if (facePatch.dataset.src !== spec.patch) {
          facePatch.dataset.src = spec.patch;
          facePatch.src = spec.patch;
        }
        facePatch.classList.add('is-shown');
      } else {
        facePatch.classList.remove('is-shown');
      }
    }
    faceWin.dataset.speakerId = memberId;
    faceWin.hidden = false;
    stage?.classList.remove('is-face-off');
    faceWin.title = `${labelName} · 点击快速 @她 发言`;
    faceWin.setAttribute('aria-label', `${labelName} 半身立绘`);
    return;
  }

  if (faceImgA && member.avatarUrl) {
    faceWin.classList.add('is-avatar-fallback');
    if (facePatch) facePatch.classList.remove('is-shown');
    crossfadeBasePair(faceImgA, faceImgB, member.avatarUrl, { instant: true });
    faceWin.dataset.speakerId = memberId;
    faceWin.hidden = false;
    stage?.classList.remove('is-face-off');
    faceWin.title = `${labelName} · 点击快速 @她 发言`;
    faceWin.setAttribute('aria-label', `${labelName} 头像`);
    return;
  }

  faceWin.hidden = true;
  stage?.classList.add('is-face-off');
}

function renderGroupCast({ animateSpeaker = false } = {}) {
  const host = galState.els.groupCast;
  if (!host) return;
  if (!galState.isGroupChat) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  if (!galState.castOrder.length) {
    galState.castOrder = galState.groupMembers.slice(0, 5).map((m) => m.id);
  }
  const visibleIds = galState.castOrder.slice(0, 5);
  host.dataset.castCount = String(visibleIds.length);
  const positions = getEnsemblePositions(visibleIds.length);

  // Remove stale slots not in visibleIds
  for (const existing of [...host.querySelectorAll('.gal-cast-slot')]) {
    if (!visibleIds.includes(existing.dataset.memberId)) existing.remove();
  }

  const hasActiveSpeaker = Boolean(galState.activeSpeakerId && visibleIds.includes(galState.activeSpeakerId));

  visibleIds.forEach((mid, idx) => {
    const member = galState.groupMembers.find((m) => m.id === mid) || { id: mid, name: mid, avatarUrl: '' };
    const pack = SPRITE_PACKS[mid];
    const mood = galState.memberMoods[mid] || 'neutral';
    const pos = positions[idx] || { x: 50, z: 10 };
    let slot = host.querySelector(`.gal-cast-slot[data-member-id="${CSS.escape(mid)}"]`);

    if (!slot) {
      slot = document.createElement('div');
      slot.className = 'gal-cast-slot';
      slot.dataset.memberId = mid;
      slot.style.setProperty('--breathe-delay', `${(-idx * 1.15).toFixed(2)}s`);
      if (pack) {
        preloadSpritePack(mid);
        slot.innerHTML = `
          <div class="gal-sprite-breathe">
            <div class="gal-sprite-motion">
              <div class="gal-sprite-canvas">
                <img class="gal-sprite-img" data-role="base-a" alt="">
                <img class="gal-sprite-img" data-role="base-b" alt="">
                <img class="gal-sprite-patch" data-role="patch" alt="" aria-hidden="true">
                <div class="gal-emote-layer" data-role="emote" aria-hidden="true"></div>
              </div>
            </div>
          </div>
          <span class="gal-cast-tag">${escapeText(member.name)}</span>
        `;
      } else {
        slot.innerHTML = `
          <div class="gal-sprite-breathe">
            <div class="gal-sprite-motion">
              <div class="gal-cast-fallback">
                <img src="${escapeText(member.avatarUrl)}" alt="${escapeText(member.name)}">
              </div>
            </div>
          </div>
          <span class="gal-cast-tag">${escapeText(member.name)}</span>
        `;
      }
      slot.addEventListener('click', (e) => {
        e.stopPropagation();
        if (galState.uiHidden) {
          setUiHidden(false);
          return;
        }
        closePopovers();
        if (hasPendingStoryFork() && !galState.story.collapsed) {
          galState.story.collapsed = true;
          renderGalStoryUI();
        }
        if (galState.turn !== 'user') setTurn('user');
        const field = galState.els.turnTextarea;
        if (field) {
          const mention = `@${member.name} `;
          if (!field.value.includes(mention)) {
            field.value = `${field.value}${field.value && !field.value.endsWith(' ') ? ' ' : ''}${mention}`;
            field.dispatchEvent(new Event('input', { bubbles: true }));
          }
          field.focus();
        }
      });
      host.appendChild(slot);
    }

    slot.style.setProperty('--slot-x', `${pos.x}%`);
    slot.style.setProperty('--outward', String(Math.sign(pos.x - 50)));
    slot.style.setProperty('--slot-z', String(pos.z));
    applyCharProportionVars(slot, mid);

    const isSpeaking = hasActiveSpeaker && mid === galState.activeSpeakerId;
    const isListening = hasActiveSpeaker && mid !== galState.activeSpeakerId;
    slot.classList.toggle('is-speaking', isSpeaking);
    slot.classList.toggle('is-listening', isListening);

    if (pack) {
      const spec = pack.moods[mood] || pack.moods.neutral;
      const baseUrl = pack.bases[spec.base] || pack.bases.neutral;
      const baseImgA = slot.querySelector('[data-role="base-a"]');
      const baseImgB = slot.querySelector('[data-role="base-b"]');
      const patchImg = slot.querySelector('[data-role="patch"]');
      const emoteEl = slot.querySelector('[data-role="emote"]');
      if (baseImgA) {
        crossfadeBasePair(baseImgA, baseImgB, baseUrl);
      }
      if (patchImg) {
        applyPatchBox(patchImg, spec.box || pack.box);
        if (spec.patch) {
          if (patchImg.dataset.src !== spec.patch) {
            patchImg.dataset.src = spec.patch;
            patchImg.src = spec.patch;
          }
          patchImg.classList.add('is-shown');
        } else {
          patchImg.classList.remove('is-shown');
        }
      }
      if (emoteEl) {
        renderEmoteOverlay(isSpeaking ? mood : 'neutral', emoteEl);
      }
    }

    if (animateSpeaker && isSpeaking && galState.motionEnabled) {
      const motion = slot.querySelector('.gal-sprite-motion');
      const meta = MOOD_META[mood] || MOOD_META.neutral;
      if (motion) {
        motion.classList.remove(...ALL_MOTION_ANIMS);
        void motion.offsetWidth;
        if (meta.anim) motion.classList.add(meta.anim);
      }
    }
  });

  const faceTargetId = galState.activeSpeakerId || '';
  syncGroupSpeakerFaceWindow(faceTargetId, faceTargetId ? (galState.memberMoods[faceTargetId] || 'neutral') : 'neutral');
  syncMoodPopoverForCurrentChar();
  syncPixelTheaterCast();
}

const DEFAULT_MOOD_PILL_LABELS = {
  neutral: '常态',
  happy: '开心',
  starry: '星星眼',
  playful: '调皮',
  gentle: '温柔',
  content: '安心闭眼',
  curious: '好奇',
  shocked: '惊呆',
  serious: '认真',
  speechless: '无语',
  shy: '害羞',
  worried: '担心',
  jealous: '吃醋',
  gloomy: '失落',
  hiss: '炸毛哈气',
  crying: '委屈大哭',
};

function syncMoodPopoverForCurrentChar() {
  const { moodPopoverTitle, moodPopoverSub, moodGrid } = galState.els;
  if (!moodGrid) return;
  const targetId = galState.isGroupChat
    ? (galState.activeSpeakerId || galState.castOrder[0] || '')
    : (galState.botId || '');
  const pack = targetId ? SPRITE_PACKS[targetId] : null;
  const poseCount = pack ? Object.keys(pack.bases).length : 0;

  if (moodPopoverTitle) {
    moodPopoverTitle.textContent = poseCount > 0 ? `${poseCount} 姿势 × 16 表情差分` : '16 表情情绪切换';
  }
  if (moodPopoverSub) {
    moodPopoverSub.textContent = poseCount > 0 ? '✦ 独立全身动作' : '标准表情';
  }

  for (const btn of moodGrid.querySelectorAll('.gal-mood-pill')) {
    const moodKey = btn.dataset.mood || 'neutral';
    const spec = pack?.moods?.[moodKey] || null;
    const hasDedicatedPose = Boolean(pack && moodKey !== 'neutral' && spec && spec.base !== 'neutral' && !spec.patch);
    const customLabel = pack?.poseLabels?.[moodKey];
    const fallbackLabel = DEFAULT_MOOD_PILL_LABELS[moodKey] || (MOOD_META[moodKey]?.label || moodKey);
    const displayLabel = customLabel || fallbackLabel;
    btn.textContent = displayLabel;
    btn.classList.toggle('has-pose', hasDedicatedPose);
    if (hasDedicatedPose) {
      btn.title = `独立全身动作：${displayLabel}`;
    } else if (moodKey === 'neutral' && pack) {
      btn.title = '常态全身立绘';
    } else {
      btn.title = `微表情差分：${displayLabel}`;
    }
  }
  syncPixelTheaterControls();
}

function setMood(nextMood, { animate = true, force = false } = {}) {
  if (galState.moodLocked && !force) return;
  const m = normalizeMood(nextMood) || 'neutral';
  const changed = m !== galState.mood;
  galState.mood = m;
  const { stage, spriteMotion, speakerMood, moodGrid } = galState.els;
  if (!stage) return;
  stage.dataset.mood = m;

  const meta = MOOD_META[m] || MOOD_META.neutral;
  const isNarratorSpeaker = galState.isGroupChat && !galState.activeSpeakerId;
  if (speakerMood && galState.turn === 'bot' && !isNarratorSpeaker) {
    speakerMood.textContent = meta.label;
  }
  if (moodGrid) {
    for (const btn of moodGrid.querySelectorAll('.gal-mood-pill')) {
      btn.classList.toggle('is-selected', btn.dataset.mood === m);
    }
  }

  if (galState.isGroupChat) {
    const targetId = galState.activeSpeakerId || galState.castOrder[0] || '';
    if (targetId) {
      galState.memberMoods[targetId] = m;
      if (force && galState.pixelCtrl) galState.pixelCtrl.clearActorOverrides(targetId);
    }
    renderGroupCast({ animateSpeaker: animate && changed });
    return;
  }

  applyHybridSprite(m);
  renderEmoteOverlay(m);
  if (force && galState.pixelCtrl) galState.pixelCtrl.clearActorOverrides(galState.botId);
  syncPixelTheaterCast();

  if (animate && changed && galState.motionEnabled && spriteMotion) {
    spriteMotion.classList.remove(...ALL_MOTION_ANIMS);
    void spriteMotion.offsetWidth;
    if (meta.anim) spriteMotion.classList.add(meta.anim);
    galState.lastAnimAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  }
  scheduleNextBlink();
}

function renderCharacterVisual() {
  const { stage, charAnchor, groupCast, spriteRig, fallbackCard, fallbackImg, faceWin, faceImgA, faceImgB, facePatch, faceBlink, speakerName } = galState.els;
  if (!spriteRig || !fallbackCard) return;

  if (galState.isGroupChat) {
    if (charAnchor) charAnchor.hidden = true;
    if (groupCast) groupCast.hidden = false;
    clearTimeout(galState.blinkTimer);
    if (speakerName && galState.turn === 'bot' && !speakerName.textContent?.trim()) {
      speakerName.textContent = galState.activeSpeakerName || galState.groupName || '群聊';
    }
    renderGroupCast({ animateSpeaker: false });
    updateGroupTypingPill();
    return;
  }

  if (charAnchor) charAnchor.hidden = false;
  if (groupCast) groupCast.hidden = true;
  if (speakerName && galState.turn === 'bot') speakerName.textContent = galState.botName || '伙伴';

  const pack = SPRITE_PACKS[galState.botId];
  syncMoodPopoverForCurrentChar();
  if (pack) {
    preloadSpritePack(galState.botId);
    applyCharProportionVars(spriteRig, galState.botId);
    applyFaceWindowCalibration(faceImgA?.parentElement, galState.botId);
    spriteRig.hidden = false;
    fallbackCard.hidden = true;
    faceWin?.classList.remove('is-avatar-fallback');
    applyHybridSprite(galState.mood, { instant: true });
    renderEmoteOverlay(galState.mood);
    if (faceWin) {
      faceWin.dataset.speakerId = galState.botId || '';
      faceWin.hidden = !galState.faceWindowEnabled;
      stage?.classList.toggle('is-face-off', !galState.faceWindowEnabled);
    }
    syncThinkingDrawerState();
    scheduleNextBlink();
  } else {
    spriteRig.hidden = true;
    fallbackCard.hidden = false;
    if (fallbackImg && galState.avatarUrl) {
      fallbackImg.src = galState.avatarUrl;
      fallbackImg.alt = galState.botName || '';
    }
    if (facePatch) facePatch.classList.remove('is-shown');
    if (faceBlink) faceBlink.classList.remove('is-shown');
    if (faceWin && faceImgA && galState.avatarUrl) {
      faceWin.classList.add('is-avatar-fallback');
      crossfadeBasePair(faceImgA, faceImgB, galState.avatarUrl, { instant: true });
      faceWin.dataset.speakerId = galState.botId || '';
      faceWin.hidden = !galState.faceWindowEnabled;
      stage?.classList.toggle('is-face-off', !galState.faceWindowEnabled);
      syncThinkingDrawerState();
    } else if (faceWin) {
      faceWin.hidden = true;
      stage?.classList.add('is-face-off');
    }
    clearTimeout(galState.blinkTimer);
  }
  syncPixelTheaterCast();
}

const BEAT_CARRY_MAP = {
  shocked: 'curious',
  hiss: 'jealous',
  crying: 'worried',
  speechless: 'gentle',
};

function normalizeLineEndings(rawText) {
  return String(rawText || '').replace(/\r\n?/g, '\n');
}

function splitProseSentences(prose) {
  const str = String(prose || '');
  if (!str) return [];
  const out = [];
  let start = 0;
  let parenDepth = 0;
  let i = 0;

  while (i < str.length) {
    const ch = str[i];
    if (ch === '（' || ch === '(') {
      parenDepth += 1;
      i += 1;
      continue;
    }
    if ((ch === '）' || ch === ')') && parenDepth > 0) {
      parenDepth -= 1;
      i += 1;
      continue;
    }

    if (ch === '\n') {
      while (i < str.length && (str[i] === '\n' || str[i] === ' ' || str[i] === '\t')) i += 1;
      const chunk = str.slice(start, i);
      if (chunk.trim()) {
        out.push({ text: chunk, completeSentence: true, strongPunct: false, hasNewline: true });
      }
      start = i;
      continue;
    }

    const insideShortParen = parenDepth > 0 && (i - start) < 22;
    let isBoundary = false;
    let strongPunct = false;

    if (!insideShortParen) {
      if (ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?' || ch === '…') {
        isBoundary = true;
        strongPunct = (ch !== '。');
      } else if (ch === '.') {
        let dotCount = 1;
        while (i + dotCount < str.length && str[i + dotCount] === '.') dotCount += 1;
        if (dotCount >= 3) {
          isBoundary = true;
          strongPunct = true;
          i += dotCount - 1;
        } else if (dotCount === 1) {
          const prev = i > 0 ? str[i - 1] : '';
          const next = i + 1 < str.length ? str[i + 1] : '';
          if (!/[0-9.]/.test(prev) && (!next || /[\s"'”’」』）)\]]/.test(next))) {
            isBoundary = true;
          }
        } else {
          i += dotCount - 1;
        }
      } else if (ch === '～' || ch === '~') {
        let tildeEnd = i + 1;
        while (tildeEnd < str.length && (str[tildeEnd] === '～' || str[tildeEnd] === '~')) tildeEnd += 1;
        const afterTilde = tildeEnd < str.length ? str[tildeEnd] : '';
        if (!afterTilde || /[\s\n”’」』）)"'\]]/.test(afterTilde)) {
          isBoundary = true;
          strongPunct = true;
          i = tildeEnd - 1;
        }
      }
    }

    if (isBoundary) {
      i += 1;
      while (i < str.length && /[。！？!?…～~”’」』）)"'\]]/.test(str[i])) {
        if (str[i] === '！' || str[i] === '?' || str[i] === '!' || str[i] === '？' || str[i] === '…' || str[i] === '～' || str[i] === '~') {
          strongPunct = true;
        }
        i += 1;
      }
      while (i < str.length && (str[i] === ' ' || str[i] === '\t')) i += 1;
      let hasNewline = false;
      while (i < str.length && str[i] === '\n') {
        hasNewline = true;
        i += 1;
        while (i < str.length && (str[i] === ' ' || str[i] === '\t')) i += 1;
      }
      const chunk = str.slice(start, i);
      if (chunk.trim()) {
        out.push({ text: chunk, completeSentence: true, strongPunct, hasNewline });
      }
      start = i;
      parenDepth = 0;
      continue;
    }

    i += 1;
  }

  if (start < str.length) {
    const tail = str.slice(start);
    if (tail.trim()) {
      out.push({ text: tail, completeSentence: false, strongPunct: false, hasNewline: false });
    }
  }
  return out;
}

export function parsePerformanceBeats(rawText) {
  let working = normalizeLineEndings(rawText).replace(/^[ \t]+/, '');
  if (!working.trim()) return { beats: [], pendingTag: false };

  const partial = stripTrailingPartialMoodTag(working);
  working = partial.text;
  const strippedPartial = partial.stripped;

  // 提取由行内 [mood:...] 或裸写情绪标签（如 [gentle]）锚定的表演片段
  const anchoredSlices = [];
  INLINE_MOOD_TAG_RE.lastIndex = 0;
  let lastIndex = 0;
  let pendingMood = null;
  let match;
  while ((match = INLINE_MOOD_TAG_RE.exec(working)) !== null) {
    const prefix = match[1];
    const parsedMood = normalizeMood(match[2]);
    if (!prefix && !parsedMood) {
      continue;
    }
    const segText = working.slice(lastIndex, match.index);
    if (segText.trim()) {
      anchoredSlices.push({ explicitMood: pendingMood, text: segText });
      pendingMood = null;
    }
    if (parsedMood) {
      pendingMood = parsedMood;
    }
    lastIndex = INLINE_MOOD_TAG_RE.lastIndex;
  }
  const remText = working.slice(lastIndex);
  if (remText.trim()) {
    anchoredSlices.push({ explicitMood: pendingMood, text: remText });
  }

  if (!anchoredSlices.length) {
    return { beats: [], pendingTag: strippedPartial };
  }

  const rawBeats = [];
  let prevMood = 'neutral';

  for (let sIdx = 0; sIdx < anchoredSlices.length; sIdx++) {
    const slice = anchoredSlices[sIdx];
    let sliceBody = slice.text;
    // Strip leading horizontal spaces on tagged slices after Chinese boundary punctuation/newline
    if (sIdx > 0 && rawBeats.length > 0) {
      const prevTail = rawBeats[rawBeats.length - 1].text;
      if (/[。！？!?…～~\n”’」』）][ \t]*$/.test(prevTail)) {
        sliceBody = sliceBody.replace(/^[ \t]+/, '');
      }
    }

    const subPieces = sliceBody.includes('```')
      ? sliceBody.split(/(```[\s\S]*?(?:```|$))/g).filter(Boolean)
      : [sliceBody];

    const sentences = [];
    for (const sub of subPieces) {
      if (sub.startsWith('```')) {
        sentences.push({ text: sub, completeSentence: true, strongPunct: false, hasNewline: false, isRichBlock: true });
      } else {
        for (const sent of splitProseSentences(sub)) {
          sentences.push({ ...sent, isRichBlock: false });
        }
      }
    }

    for (let j = 0; j < sentences.length; j++) {
      const sent = sentences[j];
      const clauseRes = scoreMoodClause(sent.text, { includeCodeBlock: true });
      let mood = prevMood;
      const isExplicitHead = (j === 0 && Boolean(slice.explicitMood));
      if (isExplicitHead) {
        mood = slice.explicitMood;
        if (mood === 'neutral' && clauseRes.bestScore >= 1.8 && clauseRes.bestMood !== 'neutral') {
          mood = clauseRes.bestMood;
        }
      } else if (clauseRes.bestScore >= 1.0 && clauseRes.bestMood !== 'neutral') {
        mood = clauseRes.bestMood;
      } else {
        mood = BEAT_CARRY_MAP[prevMood] || prevMood;
      }
      prevMood = mood;
      rawBeats.push({
        text: sent.text,
        mood,
        explicit: isExplicitHead,
        completeSentence: sent.completeSentence,
        strongPunct: sent.strongPunct,
        hasNewline: sent.hasNewline,
        isRichBlock: Boolean(sent.isRichBlock || /\[chat-image:/i.test(sent.text)),
        pauseMs: 0,
      });
    }
  }

  for (let i = 0; i < rawBeats.length; i++) {
    const cur = rawBeats[i];
    if (!cur.completeSentence) {
      cur.pauseMs = 0;
      continue;
    }
    const next = rawBeats[i + 1];
    let pause = cur.strongPunct ? 640 : 520;
    if (cur.hasNewline) pause += 100;
    if (next && next.mood !== cur.mood) {
      pause = Math.max(pause, 680);
    }
    cur.pauseMs = Math.min(pause, 840);
  }

  return { beats: rawBeats, pendingTag: false };
}

export function splitGalSegments(rawText, { streaming = false } = {}) {
  const s = String(rawText || '').trim();
  if (!s) return [];
  const rawCheck = extractSegmentMoodInfo(s);
  if (rawCheck.pendingTag) return [];

  const info = rawCheck;
  const clean = info.cleanText.trim();
  if (!clean) return [];
  let mood = 'neutral';
  if (info.tagCount >= 2) {
    mood = info.latestMood || 'neutral';
  } else if (info.tagCount === 1) {
    mood = info.latestMood || 'neutral';
    const toneAnalysis = analyzeMoodFromTone(clean);
    if (streaming && clean.length >= 24 && toneAnalysis.tailScore >= 2.2 && toneAnalysis.tailMood !== mood && toneAnalysis.tailMood !== 'neutral') {
      mood = toneAnalysis.tailMood;
    } else if (mood === 'neutral' && toneAnalysis.bestScore >= 2.2 && toneAnalysis.bestMood !== 'neutral') {
      mood = toneAnalysis.bestMood;
    }
  } else {
    mood = inferMoodFromTone(clean);
  }
  return [{ text: clean, mood, explicit: info.explicit }];
}

export function computeBeatCharDelayMs(beat, charJustTyped = '', remainingChars = 0) {
  if (charJustTyped === '…' || charJustTyped === '—') {
    return 62;
  }
  if (remainingChars > 110) {
    return 19;
  }
  const mood = beat?.mood || 'neutral';
  const text = String(beat?.text || '');
  if (mood === 'shocked' || mood === 'hiss' || /[？！]|!!/.test(text)) {
    return 19;
  }
  if (mood === 'happy' || mood === 'starry' || mood === 'playful') {
    return 24;
  }
  if (mood === 'shy' || mood === 'gloomy' || mood === 'worried' || mood === 'gentle' || /……|\.{3,}/.test(text)) {
    return 38;
  }
  return 27;
}

function triggerBoxFeedback(moodKey, text = '') {
  const area = galState.els.vnTextArea;
  if (!area || !galState.motionEnabled || !galState.enabled) return;
  let cls = '';
  if (moodKey === 'shocked' || moodKey === 'hiss' || /[？！]/.test(String(text || ''))) {
    cls = 'is-box-jolt';
  } else if (moodKey === 'shy' || moodKey === 'starry' || moodKey === 'happy') {
    cls = 'is-box-soft';
  }
  if (!cls) return;
  area.classList.remove('is-box-jolt', 'is-box-soft');
  void area.offsetWidth;
  area.classList.add(cls);
}

function getTypingSpeedFactor() {
  if (galState.typingSpeed === 'slow') return 1.55;
  if (galState.typingSpeed === 'fast') return 0.52;
  if (galState.typingSpeed === 'instant') return 0;
  return 1.0;
}

function clearAutoTimer() {
  clearTimeout(galState.autoTimer);
  galState.autoTimer = 0;
}

function setAutoPlay(enabled, { silent = false } = {}) {
  galState.autoPlay = Boolean(enabled);
  galState.els.autoBtn?.classList.toggle('is-active', galState.autoPlay);
  galState.els.stage?.classList.toggle('is-auto-on', galState.autoPlay);
  if (!galState.autoPlay) {
    clearAutoTimer();
  } else {
    scheduleAutoAdvance();
  }
  updateNextPrompt({ streaming: isPerforming() || galState.speaking });
  if (!silent) {
    playGalSfx('switch');
    showMiniToast(galState.autoPlay ? `AUTO 自动观剧已开启（停顿 ${(galState.autoDelayMs / 1000).toFixed(1)}s）` : 'AUTO 自动观剧已暂停');
  }
}

function scheduleAutoAdvance() {
  clearAutoTimer();
  if (!galState.enabled || !galState.autoPlay || confirmingAdvance || galState.turn !== 'bot' || galState.uiHidden) return;
  if (isPerforming() || galState.speaking || galState.streamActive) return;
  // 若正在朗读角色配音，等待本句语音播放结束后由 voiceCtrl.onIdle 自动接力推进
  if (galVoiceCtrl && galVoiceCtrl.isEnabled() && galVoiceCtrl.isBusy()) return;

  // 群聊若到达命运分岔口，自动暂停交由玩家做抉择，绝不擅自跳过
  if (galState.isGroupChat && hasPendingStoryFork() && isAtGroupQueueEnd()) {
    return;
  }

  const hasGroupNext = galState.isGroupChat && galState.groupQueueIndex < galState.groupQueue.length - 1;
  const hasHistoryNext = !galState.isGroupChat && galState.historyCursor >= 0 && galState.historyCursor < galState.historyEntries.length - 1;
  if (!hasGroupNext && !hasHistoryNext) return;

  const waitMs = Math.max(800, Math.min(4500, Number(galState.autoDelayMs) || 2000));
  galState.autoTimer = setTimeout(() => {
    galState.autoTimer = 0;
    if (!galState.enabled || !galState.autoPlay || confirmingAdvance || galState.turn !== 'bot' || galState.uiHidden) return;
    if (isPerforming() || galState.speaking) return;
    if (galVoiceCtrl && galVoiceCtrl.isEnabled() && galVoiceCtrl.isBusy()) return;
    if (galState.isGroupChat) {
      if (galState.groupQueueIndex < galState.groupQueue.length - 1) {
        showGroupQueueItem(galState.groupQueueIndex + 1, { animate: true });
      }
    } else if (galState.historyCursor >= 0 && galState.historyCursor < galState.historyEntries.length - 1) {
      stepHistory(1);
    }
  }, waitMs);
}

let galVoiceTurnSeq = 0;
let galVoicePollTimer = 0;
let galVoiceSelectedBotId = '';
let galVoiceCtrl = null;
let galBgmCtrl = null;

function ensureBgmController() {
  if (galBgmCtrl) return galBgmCtrl;
  galBgmCtrl = createGalgameBgmController({
    onChange: (snap) => {
      galState.els.bgmPickerBtn?.classList.toggle('is-active', Boolean(snap.enabled && !galState.els.bgmPopover?.hidden));
      galState.els.bgmPickerBtn?.classList.toggle('has-voice-online', Boolean(snap.enabled));
    },
  });
  return galBgmCtrl;
}

function ensureVoiceController() {
  if (galVoiceCtrl) return galVoiceCtrl;
  galVoiceCtrl = createGalgameVoiceController({
    onStateChange: (snap) => {
      syncGalVoiceButtons(snap);
      // Audio Ducking: smoothly lower BGM whenever Breeze TTS is speaking
      ensureBgmController().setDucked(Boolean(snap?.playing));
    },
    onIdle: () => {
      if (galState.enabled && galState.autoPlay) {
        scheduleAutoAdvance();
      }
    },
    onToast: (msg) => {
      if (galState.enabled && msg) showMiniToast(msg);
    },
  });
  return galVoiceCtrl;
}

function syncGalVoiceButtons(snap = null) {
  const s = snap || ensureVoiceController().getSnapshot();
  const { voiceBtn, replayVoiceBtn, voicePickerBtn } = galState.els;
  if (voiceBtn) {
    voiceBtn.classList.toggle('is-active', s.enabled);
    voiceBtn.classList.toggle('is-muted', !s.enabled);
    voiceBtn.classList.toggle('is-speaking', s.playing || s.synthesizing);
    voiceBtn.title = s.enabled
      ? `角色配音已开启（${s.serverOnline ? 'Breeze 已就绪' : '点击“配音”启动引擎'} · 快捷键 V）`
      : '角色配音已静音（快捷键 V 开启）';
  }
  if (voicePickerBtn) {
    voicePickerBtn.classList.toggle('has-voice-online', Boolean(s.serverOnline));
  }
  if (replayVoiceBtn) {
    replayVoiceBtn.classList.toggle('is-playing', Boolean(s.playing));
    replayVoiceBtn.classList.toggle('is-loading', Boolean(s.synthesizing && !s.playing));
    replayVoiceBtn.title = s.playing ? '正在播放配音（点击停止）' : (s.synthesizing ? '正在合成语音…' : '朗读 / 重听当前台词');
  }
}

function isPerforming() {
  const ph = galState.perf.phase;
  return ph === 'typing' || ph === 'pausing' || ph === 'waiting_stream';
}

function resetPerformance() {
  clearTimeout(galState.perf.timer);
  clearAutoTimer();
  if (galVoiceCtrl) galVoiceCtrl.stop({ keepLastTurn: false });
  galState.perf.timer = 0;
  galState.perf.rawSource = '';
  galState.perf.beats = [];
  galState.perf.beatIdx = 0;
  galState.perf.charIdx = 0;
  galState.perf.phase = 'idle';
  galState.perf.skipped = false;
  galState.perf.pausedBeatIdx = -1;
  galState.perf.speakerId = '';
  galState.perf.isNarrator = false;
}

function currentPerfSpeaker() {
  if (galState.isGroupChat) return galState.activeSpeakerName || galState.groupName || '群聊';
  return galState.botName;
}

function renderPerformFrame({ finalDone = false } = {}) {
  const { beats, beatIdx, charIdx } = galState.perf;
  if (!beats.length) return;
  const safeIdx = Math.max(0, Math.min(beatIdx, beats.length - 1));
  let visibleText = '';
  for (let i = 0; i < safeIdx; i++) {
    visibleText += beats[i].text;
  }
  const curBeat = beats[safeIdx];
  const take = finalDone ? curBeat.text.length : Math.max(0, Math.min(charIdx, curBeat.text.length));
  visibleText += curBeat.text.slice(0, take);

  renderDialogueContent(visibleText, {
    streaming: !finalDone,
    partialQuote: !finalDone,
    speaker: currentPerfSpeaker(),
  });
}

function applyPerfBeatMood(moodKey, { animate = false } = {}) {
  if (!moodKey) return;
  if (galState.isGroupChat) {
    if (!galState.activeSpeakerId) return;
    if (galState.moodLocked) return;
    const m = normalizeMood(moodKey) || 'neutral';
    if (m === galState.mood) return;
    galState.mood = m;
    galState.memberMoods[galState.activeSpeakerId] = m;
    const meta = MOOD_META[m] || MOOD_META.neutral;
    if (galState.els.speakerMood && galState.turn === 'bot') galState.els.speakerMood.textContent = meta.label;
    if (galState.els.stage) galState.els.stage.dataset.mood = m;
    renderGroupCast({ animateSpeaker: animate });
    if (animate) galState.lastAnimAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    return;
  }
  setMood(moodKey, { animate });
}

function fastForwardPerformance() {
  const perf = galState.perf;
  clearTimeout(perf.timer);
  perf.timer = 0;
  perf.skipped = true;
  if (!perf.beats.length) return;

  const prevBeatIdx = perf.beatIdx;
  perf.beatIdx = perf.beats.length - 1;
  const lastBeat = perf.beats[perf.beatIdx];
  perf.charIdx = lastBeat.text.length;

  if (lastBeat.mood) {
    applyPerfBeatMood(lastBeat.mood, { animate: lastBeat.mood !== galState.mood });
  }
  if (isPixelStageMode() && galState.pixelCtrl && perf.beatIdx > prevBeatIdx && lastBeat.text && lastBeat.text.trim()) {
    galState.pixelCtrl.directByStoryLine({
      speakerId: perf.speakerId || (galState.isGroupChat ? galState.activeSpeakerId : galState.botId),
      text: lastBeat.text,
      isNarrator: Boolean(perf.isNarrator),
    });
  }

  if (galState.streamActive && galState.isSoloChat) {
    perf.phase = 'waiting_stream';
    galState.speaking = true;
    renderPerformFrame({ finalDone: false });
    updateNextPrompt({ streaming: true });
  } else {
    perf.phase = 'done';
    galState.speaking = false;
    renderPerformFrame({ finalDone: true });
    if (galState.isGroupChat) renderGalStoryUI();
    updateNextPrompt({ streaming: false });
    scheduleAutoAdvance();
  }
}

function stepPerformance() {
  const perf = galState.perf;
  clearTimeout(perf.timer);
  perf.timer = 0;

  if (!galState.enabled || (!galState.isSoloChat && !galState.isGroupChat)) {
    perf.phase = 'done';
    galState.speaking = false;
    return;
  }

  if (!perf.beats.length) {
    if (galState.streamActive && galState.isSoloChat) {
      perf.phase = 'waiting_stream';
      galState.speaking = true;
      updateNextPrompt({ streaming: true });
    } else {
      perf.phase = 'done';
      galState.speaking = false;
      updateNextPrompt({ streaming: false });
      scheduleAutoAdvance();
    }
    return;
  }

  if (perf.skipped || galState.typingSpeed === 'instant') {
    fastForwardPerformance();
    return;
  }

  if (perf.beatIdx >= perf.beats.length) {
    perf.beatIdx = perf.beats.length - 1;
    perf.charIdx = perf.beats[perf.beatIdx].text.length;
  }

  const cur = perf.beats[perf.beatIdx];
  if (perf.charIdx > cur.text.length) {
    perf.charIdx = cur.text.length;
  }

  // Trigger micro-expression on entering a beat or when a streaming sentence clarifies its mood
  const isBeatStart = perf.charIdx === 0;
  if (cur.mood) {
    const shouldSwitch = cur.explicit || cur.mood !== 'neutral' || !galState.streamActive || cur.text.trim().length >= 10;
    if (shouldSwitch && cur.mood !== galState.mood) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const canAnim = isBeatStart || perf.beatIdx === 0 || (now - galState.lastAnimAt > 420);
      applyPerfBeatMood(cur.mood, { animate: canAnim });
    }
  }
  if (isBeatStart) {
    triggerBoxFeedback(cur.mood, cur.text);
    if (isPixelStageMode() && galState.pixelCtrl && cur.text && cur.text.trim()) {
      // 画面（角色走位、跑动与剧场动作）严格跟随剧场字幕盒当下正在演出的这一句
      galState.pixelCtrl.directByStoryLine({
        speakerId: perf.speakerId || (galState.isGroupChat ? galState.activeSpeakerId : galState.botId),
        text: cur.text,
        isNarrator: Boolean(perf.isNarrator),
      });
    }
    const autoEgg = detectEasterEggKind(cur.text);
    if (autoEgg) {
      const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (nowMs - galState.lastEggFxAt > 12000) {
        spawnEasterEggFx(autoEgg);
      }
    }
  }

  const speedFactor = getTypingSpeedFactor();

  // Advance characters within current sentence beat with dynamic pacing
  if (perf.charIdx < cur.text.length) {
    perf.phase = 'typing';
    galState.speaking = true;
    let remainingChars = cur.text.length - perf.charIdx;
    for (let k = perf.beatIdx + 1; k < perf.beats.length; k++) {
      remainingChars += perf.beats[k].text.length;
    }
    const nextChar = cur.text[perf.charIdx] || '';
    const stepChars = cur.isRichBlock ? cur.text.length : (remainingChars > 110 || galState.typingSpeed === 'fast' ? 2 : 1);
    const delayMs = Math.max(10, Math.round(computeBeatCharDelayMs(cur, nextChar, remainingChars) * speedFactor));
    perf.charIdx = Math.min(cur.text.length, perf.charIdx + stepChars);
    renderPerformFrame({ finalDone: false });
    updateNextPrompt({ streaming: true });
    if (nextChar && !/[\s。，、！？!?…~～—\-.,:;'"「」『』（）()]/.test(nextChar)) {
      playGalSfx('tick');
    }
    perf.timer = setTimeout(stepPerformance, delayMs);
    return;
  }

  // Current beat reached its end: check whether to pause before next beat or finish
  const hasMoreBeats = perf.beatIdx < perf.beats.length - 1;
  if (hasMoreBeats) {
    if (perf.pausedBeatIdx === perf.beatIdx) {
      perf.beatIdx += 1;
      perf.charIdx = 0;
      stepPerformance();
      return;
    }
    perf.phase = 'pausing';
    perf.pausedBeatIdx = perf.beatIdx;
    galState.speaking = true;
    renderPerformFrame({ finalDone: false });
    updateNextPrompt({ streaming: true });
    playGalSfx('pause');
    const waitMs = Math.max(140, Math.round(Math.max(260, cur.pauseMs || 560) * speedFactor));
    perf.timer = setTimeout(() => {
      perf.beatIdx += 1;
      perf.charIdx = 0;
      stepPerformance();
    }, waitMs);
    return;
  }

  // At the latest beat's end
  if (galState.streamActive && galState.isSoloChat) {
    galState.speaking = true;
    renderPerformFrame({ finalDone: false });
    if (cur.completeSentence && perf.pausedBeatIdx !== perf.beatIdx) {
      perf.phase = 'pausing';
      perf.pausedBeatIdx = perf.beatIdx;
      updateNextPrompt({ streaming: true });
      playGalSfx('pause');
      const waitMs = Math.max(180, Math.round(Math.max(360, cur.pauseMs || 580) * speedFactor));
      perf.timer = setTimeout(() => {
        if (galState.perf.beatIdx < galState.perf.beats.length - 1) {
          galState.perf.beatIdx += 1;
          galState.perf.charIdx = 0;
          stepPerformance();
        } else if (galState.streamActive) {
          galState.perf.phase = 'waiting_stream';
        } else {
          stepPerformance();
        }
      }, waitMs);
    } else {
      perf.phase = 'waiting_stream';
      updateNextPrompt({ streaming: true });
    }
    return;
  }

  // All beats complete and stream finished: keep full text in single message box and reveal prompt
  perf.phase = 'done';
  galState.speaking = false;
  renderPerformFrame({ finalDone: true });
  if (galState.isGroupChat) renderGalStoryUI();
  updateNextPrompt({ streaming: false });
  scheduleAutoAdvance();
}

let readingSession = 0;
let confirmingAdvance = false;
function rememberGroupLine(messageId, beforeFirst = false) {
  if (!galState.groupId || !messageId) return;
  writePref('dimension.stage.reader.' + galState.groupId, JSON.stringify({
    messageId, beforeFirst, cast: galState.castOrder, replacementCursor: galState.replacementCursor,
  }));
}

function readGroupBookmark() {
  try {
    const mark = JSON.parse(readPref('dimension.stage.reader.' + galState.groupId, 'null'));
    return typeof mark?.messageId === 'string' && Array.isArray(mark.cast) ? mark : null;
  } catch { return null; }
}

function unreadLines() {
  return galState.groupQueue.length - galState.groupQueueIndex - 1;
}

function showGroupQueueItem(idx, { animate = true, instant = false, save = true } = {}) {
  const item = galState.groupQueue[idx];
  if (!item) return;
  resetPerformance();
  galState.groupQueueIndex = idx;

  const isNonMember = item.isNarrator || !item.speakerId || item.speakerId === 'system' || item.speakerId === 'user';
  if (isNonMember) {
    galState.activeSpeakerId = '';
    galState.activeSpeakerName = item.isNarrator ? '✦ 旁白' : (item.speakerName || '系统');
    if (galState.turn === 'user') setTurn('bot');
    renderGroupCast({ animateSpeaker: false });
    if (galState.els.speakerMood) galState.els.speakerMood.textContent = item.isNarrator ? '旁白' : '群聊';
  } else {
    ensureMemberInCast(item.speakerId);
    galState.activeSpeakerId = item.speakerId;
    galState.activeSpeakerName = item.speakerName || item.speakerId;
    galState.memberMoods[item.speakerId] = item.mood || 'neutral';
    galState.mood = item.mood || 'neutral';
    if (galState.turn === 'user') setTurn('bot');
    const meta = MOOD_META[galState.mood] || MOOD_META.neutral;
    if (galState.els.speakerMood) galState.els.speakerMood.textContent = meta.label;
    if (galState.els.stage) galState.els.stage.dataset.mood = galState.mood;
    renderGroupCast({ animateSpeaker: animate });
    if (animate) triggerBoxFeedback(galState.mood, item.clean);
  }

  // 当剧场推进到最新一句时，再释放先前暂存的导演切景/氛围特效（绝不随后台聊天框提前抢跑切景！）
  if (isAtGroupQueueEnd() && galState.story.pendingStageCue) {
    const dueCue = galState.story.pendingStageCue;
    galState.story.pendingStageCue = null;
    applyDirectorStageCue(dueCue, { animateFx: Boolean(animate) });
  }

  if (save) {
    ++readingSession;
    rememberGroupLine(item.messageId);
  }
  confirmingAdvance = false;
  // 群聊新台词复用同栏逐字节奏演译引擎；历史恢复/瞬显挡位直接全量呈现
  const sourceForBeats = item.isNarrator ? String(item.raw || item.clean || '').replace(/^【旁白】\s*/, '') : (item.raw || item.clean || '');
  const parsed = parsePerformanceBeats(sourceForBeats);
  if (animate && !instant && galState.enabled && parsed.beats.length > 0) {
    galVoiceTurnSeq += 1;
    ensureVoiceController().feedTurnBeats({
      turnKey: `grp:${idx}:${galVoiceTurnSeq}`,
      botId: item.isNarrator ? '' : (item.speakerId || ''),
      beats: parsed.beats,
      streamActive: false,
    });
  }
  if (animate && !instant && galState.enabled && galState.typingSpeed !== 'instant' && parsed.beats.length > 0) {
    galState.perf.rawSource = sourceForBeats;
    galState.perf.beats = parsed.beats;
    galState.perf.beatIdx = 0;
    galState.perf.charIdx = 0;
    galState.perf.skipped = false;
    galState.perf.pausedBeatIdx = -1;
    galState.perf.speakerId = item.isNarrator ? '' : (item.speakerId || '');
    galState.perf.isNarrator = Boolean(item.isNarrator);
    galState.speaking = true;
    renderGalStoryUI();
    stepPerformance();
    return;
  }

  if (animate && !instant && galState.enabled && isPixelStageMode() && galState.pixelCtrl) {
    galState.pixelCtrl.directByStoryLine({
      speakerId: item.isNarrator ? '' : (item.speakerId || ''),
      text: item.clean,
      isNarrator: Boolean(item.isNarrator),
    });
  }

  galState.speaking = false;
  galState.perf.phase = 'done';
  renderDialogueContent(item.clean, { streaming: false, speaker: galState.activeSpeakerName });
  renderGalStoryUI();
  updateNextPrompt({ streaming: false });
  scheduleAutoAdvance();
}

function hasPendingStoryFork() {
  const f = galState.story.pendingFork;
  return Boolean(galState.isGroupChat && galState.story.enabled && f && Array.isArray(f.choices) && f.choices.length > 0);
}

function isAtGroupQueueEnd() {
  return galState.groupQueue.length === 0 || galState.groupQueueIndex >= galState.groupQueue.length - 1;
}

async function submitGalStoryDirective(directive, { opening = false } = {}) {
  if (galState.story.submitting) return;
  let diceRoll = null;
  if (galState.story.diceMode && directive && !opening) {
    diceRoll = await rollFateDice(directive, { sfxEnabled: galState.sfxEnabled });
  }
  const prevFork = galState.story.pendingFork;
  const prevForkKey = galState.story.forkKey;
  galState.story.submitting = true;
  galState.story.pendingFork = null;
  galState.story.forkKey = '';
  galState.story.collapsed = false;
  playGalSfx('advance');
  renderGalStoryUI();
  if (galState.enabled && galState.isGroupChat) {
    galState.groupQueue = [];
    galState.groupQueueIndex = -1;
    setTurn('bot');
    renderDialogueContent(
      directive
        ? `${diceRoll ? `命运检定 D20=${diceRoll.value} · ` : ''}已选定命运走向「${directive}」，旁白正在展开下一幕……`
        : (opening ? '物语剧场开演中，旁白正在展开第一幕……' : '旁白正在承接演绎并推进下一幕……'),
      { streaming: false, speaker: '旁白' }
    );
    updateNextPrompt({ streaming: false });
  }
  try {
    if (typeof galState.hooks.onStoryAdvance === 'function') {
      await galState.hooks.onStoryAdvance({ opening, directive, diceRoll });
    }
  } catch (err) {
    galState.story.pendingFork = prevFork;
    galState.story.forkKey = prevForkKey;
    showMiniToast(err?.message || '命运推进失败，请重试');
  } finally {
    galState.story.submitting = false;
    renderGalStoryUI();
    updateNextPrompt({ streaming: false });
  }
}

function applyDirectorStageCue(cue, { animateFx = true } = {}) {
  const { stage, directorFxLayer } = galState.els;
  if (!cue || typeof cue !== 'object') return;
  const scene = String(cue.scene || '').trim();
  const mood = String(cue.mood || '').trim();
  const fx = String(cue.fx || '').trim();
  if (scene && PRESET_BGS.some((b) => b.id === scene) && galState.bgId !== 'custom' && galState.bgId !== scene) {
    galState.bgId = scene;
    if (galState.enabled) applyBackground(resolveBgUrl(scene));
  }
  if (scene && PIXEL_THEATER_BACKDROPS.some((b) => b.id === scene) && galState.bgId !== 'custom') {
    galState.pixelBgId = scene;
    if (galState.enabled && isPixelStageMode()) syncPixelTheaterBackdrop();
  }
  if (mood) {
    ensureBgmController().setTrack(mood, { manual: false });
  }
  if (directorFxLayer) {
    directorFxLayer.dataset.mood = mood || '';
    directorFxLayer.classList.remove('fx-rain', 'fx-petals', 'fx-flash');
    if (fx === 'rain') directorFxLayer.classList.add('fx-rain');
    else if (fx === 'petals') directorFxLayer.classList.add('fx-petals');
    else if (fx === 'flash' && animateFx) {
      void directorFxLayer.offsetWidth;
      directorFxLayer.classList.add('fx-flash');
      setTimeout(() => directorFxLayer.classList.remove('fx-flash'), 650);
    }
  }
  if (fx === 'shake' && animateFx && stage && galState.motionEnabled) {
    stage.classList.remove('is-director-shake');
    void stage.offsetWidth;
    stage.classList.add('is-director-shake');
    setTimeout(() => stage.classList.remove('is-director-shake'), 520);
  }
}

function renderGalDirectorDeck() {
  const { directorDeck } = galState.els;
  if (!directorDeck) return;
  const activeStory = Boolean(galState.enabled && galState.isGroupChat && galState.story.enabled);
  if (!activeStory || directorDeck.hidden) return;
  const secCnt = galState.story.secretNotesCount || 0;
  const cgCnt = galState.story.cgsCount || 0;
  const nodesCnt = galState.story.nodesCount || 0;
  const hasBible = Boolean(galState.story.storyBible);
  const diceOn = Boolean(galState.story.diceMode);
  const osOn = Boolean(galState.story.innerVoiceEnabled);
  const hasEnding = Boolean(galState.story.hasEnding);

  directorDeck.innerHTML = `
    <div class="gal-deck-head">
      <span class="gal-deck-title">剧场导演台</span>
      <span class="gal-deck-sub">${escapeText(galState.story.worldline || '主线')} · 第 ${Number(galState.story.chapter || 0)} 幕</span>
    </div>
    <div class="gal-deck-grid">
      <button type="button" class="gal-deck-card${hasBible ? ' is-on' : ''}" data-gal-v3="bible">
        <span class="gal-deck-card-ico">${v3Icon('bible', 'is-lg')}</span>
        <span class="gal-deck-card-body">
          <span class="gal-deck-card-name">剧情账本${hasBible ? '<span class="stv3-dot"></span>' : ''}</span>
          <span class="gal-deck-card-meta">${hasBible ? '已记录核心伏笔与线索' : '提炼前情与未解伏笔'}</span>
        </span>
      </button>
      <button type="button" class="gal-deck-card${secCnt || osOn ? ' is-on' : ''}" data-gal-v3="secrets">
        <span class="gal-deck-card-ico">${v3Icon('secret', 'is-lg')}</span>
        <span class="gal-deck-card-body">
          <span class="gal-deck-card-name">导演密信${secCnt ? `<span class="stv3-count">${secCnt}</span>` : ''}</span>
          <span class="gal-deck-card-meta">${osOn ? '读心心声已开启' : '私密底牌与演出开关'}</span>
        </span>
      </button>
      <button type="button" class="gal-deck-card" data-gal-v3="tree">
        <span class="gal-deck-card-ico">${v3Icon('tree', 'is-lg')}</span>
        <span class="gal-deck-card-body">
          <span class="gal-deck-card-name">世界线图谱${nodesCnt ? `<span class="stv3-count">${nodesCnt}</span>` : ''}</span>
          <span class="gal-deck-card-meta">查看分支脉络与回溯</span>
        </span>
      </button>
      <button type="button" class="gal-deck-card${diceOn ? ' is-on' : ''}" data-gal-v3="toggle-dice">
        <span class="gal-deck-card-ico">${v3Icon('dice', 'is-lg')}</span>
        <span class="gal-deck-card-body">
          <span class="gal-deck-card-name">命运骰子${diceOn ? '<span class="stv3-dot"></span>' : ''}</span>
          <span class="gal-deck-card-meta">${diceOn ? 'D20 检定已开启 · 点击关闭' : '开启 D20 命运检定'}</span>
        </span>
      </button>
      <button type="button" class="gal-deck-card" data-gal-v3="cg">
        <span class="gal-deck-card-ico">${v3Icon('cg', 'is-lg')}</span>
        <span class="gal-deck-card-body">
          <span class="gal-deck-card-name">剧场画廊${cgCnt ? `<span class="stv3-count">${cgCnt}</span>` : ''}</span>
          <span class="gal-deck-card-meta">16:9 名场面定格与珍藏</span>
        </span>
      </button>
      <button type="button" class="gal-deck-card${hasEnding ? ' is-gold' : ''}" data-gal-v3="finale">
        <span class="gal-deck-card-ico">${v3Icon(hasEnding ? 'trophy' : 'finale', 'is-lg')}</span>
        <span class="gal-deck-card-body">
          <span class="gal-deck-card-name">${hasEnding ? '结局纪念卡' : '收束终章'}</span>
          <span class="gal-deck-card-meta">${hasEnding ? '赏析终章或开启第二季' : '回收伏笔揭晓本线结局'}</span>
        </span>
      </button>
    </div>
  `;
  directorDeck.querySelectorAll('[data-gal-v3]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      playGalSfx('switch');
      const act = btn.dataset.galV3;
      if (act !== 'toggle-dice') {
        directorDeck.hidden = true;
        galState.els.stage?.classList.remove('is-director-deck-open');
        galState.els.storyHud?.querySelector('[data-gal-story="deck"]')?.classList.remove('is-open');
      }
      galState.hooks.onStoryV3Action?.(act);
    });
  });
}

function renderGalStoryUI() {
  const { storyHud, storyForkOverlay, directorDeck } = galState.els;
  const activeStory = Boolean(galState.enabled && galState.isGroupChat && galState.story.enabled);
  const hasFork = activeStory && hasPendingStoryFork();
  const atEnd = isAtGroupQueueEnd();

  if (storyHud) {
    if (!activeStory) {
      storyHud.hidden = true;
      storyHud.dataset.sig = '';
      storyHud.innerHTML = '';
      if (directorDeck) directorDeck.hidden = true;
      galState.els.stage?.classList.remove('is-director-deck-open');
    } else {
      storyHud.hidden = false;
      const chapLabel = galState.story.chapter > 0 ? `第 ${galState.story.chapter} 幕` : '待开演';
      const showForkBtn = hasFork && (galState.story.collapsed || !atEnd);
      const secCnt = galState.story.secretNotesCount || 0;
      const hasActiveTool = Boolean(secCnt || galState.story.diceMode || galState.story.innerVoiceEnabled);
      const deckOpen = Boolean(directorDeck && !directorDeck.hidden);
      galState.els.stage?.classList.toggle('is-director-deck-open', deckOpen);
      const hudSig = `${confirmingAdvance}|${unreadLines()}|${galState.story.worldline}|${chapLabel}|${showForkBtn ? galState.story.pendingFork.choices.length : 0}|${galState.story.submitting ? 1 : 0}|${hasActiveTool ? 1 : 0}|${galState.story.hasEnding ? 1 : 0}|${deckOpen ? 1 : 0}`;
      if (storyHud.dataset.sig !== hudSig) {
        storyHud.dataset.sig = hudSig;
        storyHud.innerHTML = `
          <span class="gal-story-hud-pill">${escapeText(galState.story.worldline || '主线')}</span>
          <span class="gal-story-hud-meta">${escapeText(chapLabel)}</span>
          <span class="gal-hud-sep" aria-hidden="true"></span>
          ${showForkBtn ? `<button type="button" class="gal-story-hud-btn is-fork-alert" data-gal-story="open-fork">命运抉择 · ${galState.story.pendingFork.choices.length}</button>` : ''}
          ${confirmingAdvance && unreadLines() ? '<button type="button" class="gal-story-hud-btn" data-gal-story="stay">继续读</button>' : ''}
          <button type="button" class="gal-story-hud-btn" data-gal-story="advance" ${galState.story.submitting ? 'disabled' : ''}>${confirmingAdvance && unreadLines() ? `跳过 ${unreadLines()} 句并推进` : galState.story.chapter > 0 ? '下一幕' : '开演'}</button>
          ${galState.story.hasEnding ? `<button type="button" class="gal-story-hud-btn is-ending-alert" data-gal-v3="finale">${v3Icon('trophy')}<span>结局纪念卡</span></button>` : ''}
          <button type="button" class="gal-story-hud-btn is-deck-toggle${deckOpen ? ' is-open' : ''}" data-gal-story="deck" title="展开剧场导演台（账本、密信、世界线树、骰子、CG 与终章）">${v3Icon('director')}<span>导演台</span>${hasActiveTool ? '<span class="stv3-dot"></span>' : ''}${v3Icon('chevron')}</button>
        `;
        storyHud.querySelector('[data-gal-story="open-fork"]')?.addEventListener('click', (e) => {
          e.stopPropagation();
          playGalSfx('advance');
          if (directorDeck) directorDeck.hidden = true;
          galState.story.collapsed = false;
          if (galState.groupQueue.length > 0 && galState.groupQueueIndex < galState.groupQueue.length - 1) {
            showGroupQueueItem(galState.groupQueue.length - 1, { animate: false });
          } else {
            renderGalStoryUI();
            updateNextPrompt({ streaming: false });
          }
        });
        storyHud.querySelector('[data-gal-story="stay"]')?.addEventListener('click', () => {
          confirmingAdvance = false;
          renderGalStoryUI();
          scheduleAutoAdvance();
        });
        storyHud.querySelector('[data-gal-story="advance"]')?.addEventListener('click', (e) => {
          e.stopPropagation();
          if (directorDeck) directorDeck.hidden = true;
          if (unreadLines() && !confirmingAdvance) {
            confirmingAdvance = true;
            clearAutoTimer();
            renderGalStoryUI();
            return;
          }
          confirmingAdvance = false;
          submitGalStoryDirective('', { opening: galState.story.chapter === 0 });
        });
        storyHud.querySelector('[data-gal-v3="finale"]')?.addEventListener('click', (e) => {
          e.stopPropagation();
          playGalSfx('switch');
          if (directorDeck) directorDeck.hidden = true;
          galState.hooks.onStoryV3Action?.('finale');
        });
        storyHud.querySelector('[data-gal-story="deck"]')?.addEventListener('click', (e) => {
          e.stopPropagation();
          playGalSfx('switch');
          if (!directorDeck) return;
          const willOpen = directorDeck.hidden;
          closePopovers();
          directorDeck.hidden = !willOpen;
          if (willOpen) renderGalDirectorDeck();
          renderGalStoryUI();
        });
      }
      if (deckOpen) renderGalDirectorDeck();
    }
  }

  if (storyForkOverlay) {
    const shouldShowOverlay = Boolean(hasFork && atEnd && !galState.story.collapsed && !galState.story.submitting);
    if (isPixelStageMode() && galState.pixelCtrl) {
      storyForkOverlay.hidden = true;
      galState.pixelCtrl.syncFateFork(shouldShowOverlay ? galState.story.pendingFork : null, {
        forkKey: galState.story.forkKey,
        shouldShow: shouldShowOverlay,
        onSelect: (directive) => submitGalStoryDirective(directive, { opening: false }),
        onCollapse: () => {
          galState.story.collapsed = true;
          renderGalStoryUI();
          updateNextPrompt({ streaming: false });
          showMiniToast('已收起抉择木牌 · 点击顶部「命运抉择」随时召唤');
        },
      });
      return;
    }
    if (galState.pixelCtrl) {
      galState.pixelCtrl.syncFateFork(null, { shouldShow: false });
    }
    if (!shouldShowOverlay) {
      storyForkOverlay.hidden = true;
      if (!hasFork) {
        storyForkOverlay.dataset.forkKey = '';
        storyForkOverlay.innerHTML = '';
      }
      return;
    }
    storyForkOverlay.hidden = false;
    const fork = galState.story.pendingFork;
    if (storyForkOverlay.dataset.forkKey === galState.story.forkKey && storyForkOverlay.firstElementChild) {
      return;
    }
    storyForkOverlay.dataset.forkKey = galState.story.forkKey;
    const promptText = fork.prompt || '命运在此分岔，选择或亲自改写下一幕走向';
    storyForkOverlay.innerHTML = `
      <div class="gal-story-fork-panel thin-scroll" role="dialog" aria-label="命运抉择">
        <div class="gal-story-fork-head">
          <div class="gal-story-fork-title">✦ 命运抉择 · ${escapeText(promptText)}</div>
          <button type="button" class="gal-story-fork-collapse" data-gal-fork-collapse="1" title="暂时收起选项以查看立绘或自由插话">先收起</button>
        </div>
        <div class="gal-story-fork-choices">
          ${fork.choices.map((c, idx) => {
            const badge = c.id || String.fromCharCode(65 + idx);
            return `<button type="button" class="gal-story-choice-btn" data-gal-choice-idx="${idx}">
              <span class="gal-story-choice-badge">${escapeText(badge)}</span>
              <span class="gal-story-choice-text">${escapeText(c.label)}</span>
            </button>`;
          }).join('')}
        </div>
        <div class="gal-story-fork-custom">
          <input type="text" class="gal-story-fork-input" id="galStoryCustomInput" placeholder="✎ 或写下你想改写的命运转折，按 Enter 确认…" autocomplete="off">
          <button type="button" class="gal-story-fork-send" id="galStoryCustomSend">确认改写</button>
        </div>
      </div>
    `;
    storyForkOverlay.querySelector('[data-gal-fork-collapse]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      galState.story.collapsed = true;
      renderGalStoryUI();
      updateNextPrompt({ streaming: false });
      showMiniToast('已收起选项 · 点击顶部「✦ 命运抉择」随时展开');
    });
    storyForkOverlay.querySelectorAll('[data-gal-choice-idx]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const choice = fork.choices[Number(btn.dataset.galChoiceIdx)];
        if (!choice?.label) return;
        submitGalStoryDirective(choice.label, { opening: false });
      });
    });
    const customInp = storyForkOverlay.querySelector('#galStoryCustomInput');
    const customBtn = storyForkOverlay.querySelector('#galStoryCustomSend');
    const sendCustom = () => {
      const val = (customInp?.value || '').trim();
      if (!val) {
        showMiniToast('请先输入你想改写的剧情走势');
        customInp?.focus();
        return;
      }
      submitGalStoryDirective(val, { opening: false });
    };
    customBtn?.addEventListener('click', (e) => { e.stopPropagation(); sendCustom(); });
    customInp?.addEventListener('click', (e) => e.stopPropagation());
    customInp?.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendCustom();
      }
    });
  }
}

function updateNextPrompt({ streaming = false } = {}) {
  const { nextPrompt, vnGradient } = galState.els;
  if (!nextPrompt) return;
  const labelEl = nextPrompt.querySelector('.gal-next-label');
  galState.els.jumpLatest.hidden = !(galState.isGroupChat && unreadLines() > 0);
  const unreadGroupLine = galState.isGroupChat && galState.groupQueueIndex + 1 < galState.groupQueue.length;
  if (galState.turn === 'user' && !unreadGroupLine) {
    nextPrompt.hidden = true;
    vnGradient?.classList.remove('is-awaiting-click');
    return;
  }
  if (galState.isGroupChat) {
    const activePerf = isPerforming() || galState.speaking;
    if (activePerf && galState.perf.beats.length > 0) {
      if (labelEl) labelEl.textContent = galState.autoPlay ? 'AUTO 演译中 · 点击快进' : '点击快进';
      nextPrompt.hidden = false;
      vnGradient?.classList.add('is-awaiting-click');
      return;
    }
    const total = galState.groupQueue.length;
    const hasMore = total > 0 && galState.groupQueueIndex < total - 1;
    if (hasMore) {
      const nextItem = galState.groupQueue[galState.groupQueueIndex + 1];
      const nextWho = nextItem?.isNarrator ? '旁白' : (nextItem?.speakerName || '');
      const prefix = galState.autoPlay ? 'AUTO · ' : '';
      if (labelEl) labelEl.textContent = nextWho ? `${prefix}下一句 · ${nextWho}（剩 ${unreadLines()} 句）` : `${prefix}下一句 (${galState.groupQueueIndex + 1}/${total})`;
      nextPrompt.hidden = false;
      vnGradient?.classList.add('is-awaiting-click');
      return;
    }
    if (hasPendingStoryFork()) {
      if (labelEl) labelEl.textContent = galState.story.collapsed ? '点击展开命运抉择' : '请在上方选择命运走向';
      nextPrompt.hidden = false;
      vnGradient?.classList.toggle('is-awaiting-click', galState.story.collapsed);
      return;
    }
    if (labelEl) labelEl.textContent = '点击发言';
    nextPrompt.hidden = false;
    vnGradient?.classList.add('is-awaiting-click');
    return;
  }
  const activePerf = isPerforming() || galState.speaking;
  if (activePerf) {
    const hasShownBeats = galState.perf.beats.length > 0;
    if (hasShownBeats) {
      if (labelEl) labelEl.textContent = galState.autoPlay ? 'AUTO 演译中 · 点击快进' : '点击快进';
      nextPrompt.hidden = false;
      vnGradient?.classList.add('is-awaiting-click');
    } else {
      nextPrompt.hidden = true;
      vnGradient?.classList.remove('is-awaiting-click');
    }
    return;
  }
  const readyForClick = !streaming && !galState.speaking;
  if (labelEl) labelEl.textContent = hasMoreDialogueText() ? '继续阅读' : galState.autoPlay && galState.historyCursor >= 0 && galState.historyCursor < galState.historyEntries.length - 1 ? 'AUTO 回放中 · 点击下一句' : '发言';
  nextPrompt.hidden = !readyForClick;
  vnGradient?.classList.toggle('is-awaiting-click', readyForClick);
}

function hasMoreDialogueText() {
  const box = galState.els.dialogueScroll;
  return box && box.scrollHeight - box.clientHeight - box.scrollTop > 2;
}

function advanceGalDialogue() {
  if (galState.turn !== 'bot') {
    if (!galState.isGroupChat || isAtGroupQueueEnd()) return false;
    setTurn('bot');
  }
  clearAutoTimer();
  if (galState.isGroupChat) {
    if ((isPerforming() || galState.speaking) && galState.perf.beats.length > 0) {
      playGalSfx('advance');
      fastForwardPerformance();
      return true;
    }
    if (galState.groupQueueIndex < galState.groupQueue.length - 1) {
      playGalSfx('advance');
      showGroupQueueItem(galState.groupQueueIndex + 1, { animate: true });
      return true;
    }
    if (hasPendingStoryFork()) {
      if (galState.story.collapsed) {
        playGalSfx('advance');
        galState.story.collapsed = false;
        renderGalStoryUI();
        updateNextPrompt({ streaming: false });
      }
      return true;
    }
    playGalSfx('advance');
    setTurn('user');
    return true;
  }
  if (isPerforming() || galState.speaking) {
    if (!galState.perf.beats.length) return false;
    playGalSfx('advance');
    fastForwardPerformance();
    return true;
  }
  if (hasMoreDialogueText()) {
    const box = galState.els.dialogueScroll;
    box.scrollTop += Math.max(1, box.clientHeight - 24);
    updateNextPrompt();
    return true;
  }
  if (galState.historyCursor >= 0 && galState.historyCursor < galState.historyEntries.length - 1) {
    playGalSfx('advance');
    stepHistory(1);
    return true;
  }
  playGalSfx('advance');
  setTurn('user');
  return true;
}

function setTurn(nextTurn) {
  galState.turn = nextTurn === 'user' ? 'user' : 'bot';
  const { vnGradient, speakerBar, speakerName, speakerMood, dialogueScroll, turnInputWrap, turnTextarea, nextPrompt } = galState.els;
  if (!vnGradient) return;
  const isUser = galState.turn === 'user';
  if (isUser) clearAutoTimer();
  speakerBar?.classList.toggle('is-user-turn', isUser);
  if (isUser) {
    if (speakerName) speakerName.textContent = '你';
    if (speakerMood) speakerMood.textContent = galState.isGroupChat ? '群聊发言（可点击立绘 @她 · 支持 Ctrl+V 贴图）' : '你的回合（支持 Ctrl+V 贴图）';
    if (dialogueScroll) dialogueScroll.hidden = true;
    if (turnInputWrap) turnInputWrap.hidden = false;
    updateNextPrompt();
    if (turnTextarea) turnTextarea.value = document.getElementById('composerInput')?.value || '';
    syncGalDraftMediaBar();
    requestAnimationFrame(() => turnTextarea?.focus());
  } else {
    if (speakerName) speakerName.textContent = galState.isGroupChat
      ? (galState.activeSpeakerName || galState.groupName || '群聊')
      : (galState.botName || '伙伴');
    if (speakerMood) speakerMood.textContent = (MOOD_META[galState.mood] || MOOD_META.neutral).label;
    if (dialogueScroll) dialogueScroll.hidden = false;
    if (turnInputWrap) turnInputWrap.hidden = true;
    updateNextPrompt({ streaming: galState.speaking });
  }
  refreshFaceWindowVisibility();
}

function renderDialogueContent(text, { thinking = false, streaming = false, partialQuote = false, speaker = null } = {}) {
  const { dialogueText, dialogueScroll, speakerBar, speakerName, nextPrompt, vnGradient, osChip } = galState.els;
  if (!dialogueText) return;
  if (galState.turn === 'user' && !streaming) setTurn('bot');
  if (speakerBar && speakerName) {
    speakerBar.hidden = false;
    speakerName.textContent = speaker || galState.botName || '伙伴';
  }
  if (thinking && !text) {
    dialogueText.classList.remove('is-rich');
    dialogueText.textContent = '「……正在思考中……」';
    if (osChip) { osChip.hidden = true; osChip.textContent = ''; }
    if (nextPrompt) nextPrompt.hidden = true;
    vnGradient?.classList.remove('is-awaiting-click');
    return;
  }
  const osParsed = extractInnerVoice(text || '');
  const clean = stripMoodTag(osParsed.cleanText || '').replace(/^\s+/, '').replace(/[ \t]+$/, '');
  if (osChip) {
    const showOs = Boolean(galState.isGroupChat && galState.story.innerVoiceEnabled && osParsed.innerVoice && !streaming);
    osChip.hidden = !showOs;
    osChip.textContent = showOs ? `内心 OS · ${osParsed.innerVoice}` : '';
  }
  if (!clean.trim()) {
    dialogueText.classList.remove('is-rich');
    if (!streaming) setTurn('user');
    return;
  }
  const hasRichSyntax = /```|^#{1,3}\s|\[chat-image:/m.test(clean);
  if (hasRichSyntax && typeof galState.hooks.renderRich === 'function') {
    dialogueText.classList.add('is-rich');
    galState.hooks.renderRich(dialogueText, clean);
    if (typeof galState.hooks.hydrateImages === 'function') {
      galState.hooks.hydrateImages(dialogueText);
    }
  } else {
    dialogueText.classList.remove('is-rich');
    const trimmedClean = partialQuote ? clean : clean.trimEnd();
    const startsWithQuote = trimmedClean.startsWith('「') || trimmedClean.startsWith('“') || trimmedClean.startsWith('"');
    const quoted = startsWithQuote ? trimmedClean : (partialQuote ? `「${trimmedClean}` : `「${trimmedClean}」`);
    dialogueText.textContent = quoted;
  }
  if (dialogueScroll && streaming) {
    dialogueScroll.scrollTop = dialogueScroll.scrollHeight;
  } else if (dialogueScroll) {
    dialogueScroll.scrollTop = 0;
  }
  updateNextPrompt({ streaming });
}

function collectTranscriptEntries() {
  const transcript = document.getElementById('transcript');
  if (!transcript) return [];
  const entries = [];
  if (galState.isGroupChat) {
    for (const el of transcript.querySelectorAll('.gmsg:not(.is-speaking)')) {
      const isStory = el.classList.contains('is-story-event');
      const isNarrator = el.classList.contains('is-narrator');
      const isUser = el.classList.contains('is-user');
      const speakerId = el.dataset?.speaker || el.messageSource?.from || (isUser ? 'user' : 'system');
      const raw = (el.messageSource?.text || el.querySelector('.gmsg-narrator-text, .gmsg-text, .gmsg-story-banner')?.innerText || el.innerText || '').trim();
      const clean = stripMoodTag(isNarrator ? raw.replace(/^【旁白】\s*/, '') : raw).trim();
      if (!clean) continue;
      const member = galState.groupMembers.find((m) => m.id === speakerId);
      const speaker = isUser
        ? '你'
        : (isNarrator ? '✦ 旁白' : (isStory ? '✦ 世界线' : (member?.name || el.querySelector('.gmsg-name')?.textContent?.trim() || speakerId)));
      entries.push({
        messageId: el.dataset.messageId || '',
        role: isUser ? 'user' : ((isStory || isNarrator || speakerId === 'system') ? 'system' : 'assistant'),
        speakerId,
        speaker,
        isNarrator: isNarrator || isStory,
        raw,
        clean,
      });
    }
    return entries;
  }
  for (const el of transcript.querySelectorAll('.bubble:not(.pending)')) {
    const raw = (el.dataset?.rawMoodText || el.messageSource?.text || el.innerText || '').trim();
    const clean = stripMoodTag(raw).trim();
    if (!clean) continue;
    const isUser = el.classList.contains('user');
    const isSys = el.classList.contains('system');
    entries.push({
      role: isUser ? 'user' : (isSys ? 'system' : 'assistant'),
      speaker: isUser ? '你' : (isSys ? '系统' : galState.botName),
      raw,
      clean,
    });
  }
  return entries;
}

function syncFromTranscript() {
  galState.historyEntries = collectTranscriptEntries();
  galState.historyCursor = -1;
  galState.streamActive = false;
  resetPerformance();
  if (galState.isGroupChat) {
    const mark = readGroupBookmark();
    const entries = galState.historyEntries.filter(entry => entry.role !== 'user');
    const savedIndex = mark ? entries.findIndex(entry => entry.messageId === mark.messageId) : -1;
    const more = document.querySelector('#transcript .group-history-more');
    if (mark && savedIndex < 0 && more) {
      const ticket = ++readingSession;
      const current = () => galState.enabled && ticket === readingSession;
      void galState.hooks.loadReadingPosition?.(mark.messageId, current).then(found => {
        if (!current()) return;
        if (found) syncFromTranscript();
        else showMiniToast('上次的台词未找到，可以从当前记录继续阅读。');
      });
    }
    if (entries.length) {
      const restored = savedIndex >= 0;
      const lines = restored ? (mark.beforeFirst ? entries.slice(savedIndex) : entries) : entries.slice(-6);
      galState.groupQueue = lines.map(entry => ({
        messageId: entry.messageId, speakerId: entry.speakerId, speakerName: entry.speaker,
        raw: entry.raw, clean: normalizeLineEndings(entry.clean),
        mood: parsePerformanceBeats(entry.raw).beats.at(-1)?.mood || inferMoodFromTone(entry.clean),
        isNarrator: entry.isNarrator,
      }));
      galState.speaking = false;
      if (restored) {
        const members = galState.groupMembers.map(member => member.id);
        galState.castOrder = [...new Set([...mark.cast, ...members])].filter(id => members.includes(id)).slice(0, 5);
        galState.replacementCursor = Number.isInteger(mark.replacementCursor) ? Math.max(0, mark.replacementCursor) % 5 : 0;
      }
      if (restored && mark.beforeFirst) {
        galState.groupQueueIndex = -1;
        renderGroupCast();
        setTurn('user');
      } else {
        showGroupQueueItem(restored ? savedIndex : lines.length - 1, { animate: false, save: !(mark && savedIndex < 0 && more) });
      }
      return;
    }
    galState.groupQueue = [];
    galState.groupQueueIndex = -1;
    galState.activeSpeakerId = '';
    galState.activeSpeakerName = galState.groupName || '群聊';
    renderGroupCast({ animateSpeaker: false });
    setTurn('user');
    return;
  }
  // Merge consecutive assistant bubbles from the latest bot turn into a single dialogue box view
  const rawBurst = [];
  for (let i = galState.historyEntries.length - 1; i >= 0; i--) {
    const e = galState.historyEntries[i];
    if (e.role === 'assistant') {
      rawBurst.unshift(e.raw);
    } else if (e.role === 'user') {
      break;
    }
  }
  if (rawBurst.length) {
    const combinedRaw = rawBurst.join('\n');
    const parsed = parsePerformanceBeats(combinedRaw);
    if (parsed.beats.length) {
      galState.perf.rawSource = combinedRaw;
      galState.perf.beats = parsed.beats;
      galState.perf.beatIdx = parsed.beats.length - 1;
      const lastBeat = parsed.beats[galState.perf.beatIdx];
      galState.perf.charIdx = lastBeat.text.length;
      galState.perf.phase = 'done';
      galState.perf.skipped = false;
      galState.speaking = false;
      setTurn('bot');
      setMood(lastBeat.mood, { animate: false });
      renderPerformFrame({ finalDone: true });
      updateNextPrompt({ streaming: false });
      return;
    }
  }
  galState.replyQueue = [];
  galState.replyIndex = 0;
  setMood('neutral', { animate: false });
  renderDialogueContent('', { streaming: false, speaker: galState.botName });
}

function jumpToHistoryIndex(targetIdx, { toast = true } = {}) {
  galState.historyEntries = collectTranscriptEntries();
  if (!galState.historyEntries.length) return;
  resetPerformance();
  galState.speaking = false;
  galState.perf.phase = 'done';
  const next = Math.max(0, Math.min(galState.historyEntries.length - 1, targetIdx));
  galState.historyCursor = next;
  const entry = galState.historyEntries[next];
  if (galState.turn === 'user') setTurn('bot');

  if (galState.isGroupChat) {
    if (entry.role === 'assistant' && entry.speakerId && !entry.isNarrator) {
      const parsed = parsePerformanceBeats(entry.raw);
      const lastBeat = parsed.beats[parsed.beats.length - 1];
      const mood = lastBeat ? lastBeat.mood : inferMoodFromTone(entry.clean);
      ensureMemberInCast(entry.speakerId);
      galState.activeSpeakerId = entry.speakerId;
      galState.activeSpeakerName = entry.speaker;
      galState.memberMoods[entry.speakerId] = mood;
      galState.mood = mood;
      const meta = MOOD_META[mood] || MOOD_META.neutral;
      if (galState.els.speakerMood) galState.els.speakerMood.textContent = meta.label;
      if (galState.els.stage) galState.els.stage.dataset.mood = mood;
      renderGroupCast({ animateSpeaker: true });
      renderDialogueContent(normalizeLineEndings(entry.clean), { streaming: false, speaker: entry.speaker });
    } else {
      galState.activeSpeakerId = '';
      galState.activeSpeakerName = entry.speaker;
      if (galState.els.speakerMood) galState.els.speakerMood.textContent = entry.isNarrator ? '旁白' : '群聊';
      renderGroupCast({ animateSpeaker: false });
      renderDialogueContent(normalizeLineEndings(entry.clean), { streaming: false, speaker: entry.speaker });
    }
    const queueIndex = galState.groupQueue.findIndex(line => line.messageId && line.messageId === entry.messageId);
    if (entry.role !== 'user') rememberGroupLine(entry.messageId);
    if (queueIndex >= 0) galState.groupQueueIndex = queueIndex;
    else if (next >= galState.historyEntries.length - 1 && galState.groupQueue.length > 0) {
      galState.groupQueueIndex = galState.groupQueue.length - 1;
    }
  } else if (entry.role === 'assistant') {
    const parsed = parsePerformanceBeats(entry.raw);
    const lastBeat = parsed.beats[parsed.beats.length - 1];
    setMood(lastBeat ? lastBeat.mood : inferMoodFromTone(entry.clean), { animate: true });
    renderDialogueContent(normalizeLineEndings(entry.clean), { streaming: false, speaker: entry.speaker });
  } else {
    renderDialogueContent(entry.clean, { streaming: false, speaker: entry.speaker });
  }
  updateNextPrompt({ streaming: false });
  scheduleAutoAdvance();
  if (toast) showMiniToast(`对话记录 ${next + 1} / ${galState.historyEntries.length}`);
}

function stepHistory(delta) {
  galState.historyEntries = collectTranscriptEntries();
  if (!galState.historyEntries.length) return;
  if (galState.historyCursor < 0) {
    galState.historyCursor = galState.historyEntries.length - 1;
  }
  jumpToHistoryIndex(galState.historyCursor + delta, { toast: true });
}

function renderBacklogItems(entries, query = '') {
  const { backlogList, backlogOverlay } = galState.els;
  if (!backlogList) return;
  const q = String(query || '').trim().toLowerCase();
  const indexed = entries.map((e, idx) => ({ e, idx }));
  const filtered = q
    ? indexed.filter(({ e }) => (e.speaker || '').toLowerCase().includes(q) || (e.clean || '').toLowerCase().includes(q))
    : indexed;

  backlogList.innerHTML = '';
  if (!filtered.length) {
    backlogList.innerHTML = `<div class="gal-backlog-empty">${q ? '没有匹配该关键词的台词记录' : '暂时还没有对话履历'}</div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  for (const { e, idx } of filtered) {
    const item = document.createElement('div');
    item.className = `gal-backlog-item${e.role === 'user' ? ' is-user' : ''}`;

    const head = document.createElement('div');
    head.className = 'gal-backlog-item-head';
    const sp = document.createElement('div');
    sp.className = 'gal-backlog-speaker';
    sp.textContent = `${e.speaker}  #${idx + 1}`;

    const actions = document.createElement('div');
    actions.className = 'gal-backlog-actions';

    const jumpBtn = document.createElement('button');
    jumpBtn.type = 'button';
    jumpBtn.className = 'gal-backlog-act-btn';
    jumpBtn.textContent = '回溯';
    jumpBtn.title = '跳回此句并重温当时立绘与表情';
    jumpBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (backlogOverlay) backlogOverlay.hidden = true;
      playGalSfx('switch');
      jumpToHistoryIndex(idx, { toast: true });
    });

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'gal-backlog-act-btn';
    copyBtn.textContent = '复制';
    copyBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (navigator.clipboard) {
        navigator.clipboard.writeText(e.clean).then(() => showMiniToast('已复制该条台词')).catch(() => {});
      }
    });

    actions.append(jumpBtn, copyBtn);
    head.append(sp, actions);

    const bd = document.createElement('div');
    bd.className = 'gal-backlog-body';
    bd.textContent = e.clean;
    item.append(head, bd);
    frag.appendChild(item);
  }
  backlogList.appendChild(frag);
}

function openBacklog() {
  const { stage, backlogOverlay, backlogList, backlogSearch } = galState.els;
  if (!backlogOverlay || !backlogList) return;
  if (stage) { stage.scrollTop = 0; stage.scrollLeft = 0; }
  const entries = collectTranscriptEntries();
  galState.historyEntries = entries;
  if (backlogSearch) backlogSearch.value = '';
  galState.backlogQuery = '';
  renderBacklogItems(entries, '');
  backlogOverlay.hidden = false;
  requestAnimationFrame(() => {
    if (stage) { stage.scrollTop = 0; stage.scrollLeft = 0; }
    backlogList.scrollTop = backlogList.scrollHeight;
  });
}

function renderModelPopover() {
  const { modelList, modelBtn } = galState.els;
  if (!modelList) return;
  const info = typeof galState.hooks.getModelInfo === 'function' ? galState.hooks.getModelInfo() : null;
  const choices = Array.isArray(info?.choices) ? info.choices : [];
  const cur = info?.current || null;
  const isCurCli = Boolean(cur && (cur.mode === 'cli' || String(cur.providerId || '').startsWith('cli:') || cur.engineId));
  modelList.innerHTML = '';

  if (typeof galState.hooks.onOpenCliReceptionModal === 'function') {
    const cliRow = document.createElement('div');
    cliRow.className = `gal-model-cli-row${isCurCli ? ' is-active' : ''}`;
    const engId = String(cur?.engineId || String(cur?.providerId || '').replace(/^cli:/, '') || '').toLowerCase();
    const engLabelMap = {
      antigravity: 'Antigravity (agy)',
      hermes: 'Hermes',
      'kimi-code': 'Kimi Code',
      'deepseek-harness': 'DeepSeek Harness',
      'claude-code': 'Claude Code',
      codex: 'Codex',
      opencode: 'OpenCode',
      'qwen-code': 'Qwen Code',
      'gemini-cli': 'Gemini CLI',
    };
    const engName = engLabelMap[engId] || engId || '本机 CLI';
    const cliSummary = isCurCli
      ? `已启用 · ${engName}${cur?.model ? ` / ${String(cur.model).split('/').pop()}` : '（默认订阅）'}`
      : '点击设置选择本机可用 CLI 模型';
    cliRow.innerHTML = `
      <div class="gal-model-cli-info">
        <span class="gal-model-cli-title">本机 CLI 接待模型</span>
        <span class="gal-model-cli-sub">${escapeText(cliSummary)}</span>
      </div>
      <button type="button" class="gal-model-cli-btn" data-role="gal-cli-settings">设置</button>
    `;
    cliRow.querySelector('[data-role="gal-cli-settings"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      closePopovers();
      galState.hooks.onOpenCliReceptionModal();
    });
    modelList.appendChild(cliRow);
  }

  const apiChoices = choices.filter((c) => !String(c?.providerId || '').startsWith('cli:'));
  if (!apiChoices.length && !isCurCli) {
    const empty = document.createElement('div');
    empty.className = 'gal-model-empty';
    empty.textContent = '暂无维度 API 模型，可点击上方「设置」选用本机 CLI，或在常规界面配置 API Key';
    modelList.appendChild(empty);
    return;
  }
  for (const choice of apiChoices) {
    const isCurrent = Boolean(!isCurCli && cur && cur.providerId === choice.providerId && cur.model === choice.model);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `gal-model-item${isCurrent ? ' is-selected' : ''}`;
    btn.innerHTML = `<span class="gal-model-name">${escapeText(choice.label || choice.model)}</span><span class="gal-model-prov">${escapeText(choice.providerId)}</span>`;
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      closePopovers();
      if (typeof galState.hooks.onSelectModel === 'function') {
        try {
          await galState.hooks.onSelectModel({ providerId: choice.providerId, model: choice.model });
          playGalSfx('switch');
          if (modelBtn) modelBtn.title = `当前模型：${choice.label || choice.model}`;
          showMiniToast(`已切换模型：${choice.label || choice.model}`);
        } catch (err) {
          showMiniToast(err?.message || '切换模型失败');
        }
      }
    });
    modelList.appendChild(btn);
  }
}

function syncGalDraftMediaBar() {
  const bar = galState.els.draftMediaBar;
  if (!bar) return;
  const media = typeof galState.hooks.getDraftMedia === 'function'
    ? galState.hooks.getDraftMedia()
    : { images: [], stickers: [] };
  const images = Array.isArray(media?.images) ? media.images : [];
  const stickers = Array.isArray(media?.stickers) ? media.stickers : [];
  bar.innerHTML = '';
  if (!images.length && !stickers.length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  images.forEach((img, idx) => {
    const chip = document.createElement('div');
    chip.className = 'gal-draft-chip';
    chip.innerHTML = `<img src="${escapeText(img.url || `/api/dimension/chat/images/${encodeURIComponent(img.id)}`)}" alt="待发图片"><button type="button" class="gal-draft-rm" title="移除图片">×</button>`;
    chip.querySelector('.gal-draft-rm')?.addEventListener('click', (e) => {
      e.stopPropagation();
      galState.hooks.removeDraftImage?.(idx);
      syncGalDraftMediaBar();
    });
    bar.appendChild(chip);
  });
  stickers.forEach((st, idx) => {
    const chip = document.createElement('div');
    chip.className = 'gal-draft-chip is-sticker';
    chip.innerHTML = `<span class="gal-draft-sticker-label">表情 ${escapeText(st.name || st.id || '')}</span><button type="button" class="gal-draft-rm" title="移除表情">×</button>`;
    chip.querySelector('.gal-draft-rm')?.addEventListener('click', (e) => {
      e.stopPropagation();
      galState.hooks.removeDraftSticker?.(idx);
      syncGalDraftMediaBar();
    });
    bar.appendChild(chip);
  });
}

function stopVoiceStatusPolling() {
  if (galVoicePollTimer) {
    clearInterval(galVoicePollTimer);
    galVoicePollTimer = 0;
  }
}

const panelButtons = {
  bgPopover: 'bgBtn', bgmPopover: 'bgmPickerBtn', moodPopover: 'moodBtn',
  modelPopover: 'modelBtn', voicePopover: 'voicePickerBtn', settingsPopover: 'settingsBtn',
  sideDrawer: 'sideTab', directorDeck: null,
};
function openStagePanel() {
  return Object.keys(panelButtons).find(key => galState.els[key] && !galState.els[key].hidden);
}

function closePopovers() {
  stopVoiceStatusPolling();
  for (const key of Object.keys(panelButtons)) {
    if (galState.els[key]) galState.els[key].hidden = true;
  }
  galState.els.stage?.classList.remove('is-director-deck-open');
  galState.els.storyHud?.querySelector('[data-gal-story="deck"]')?.classList.remove('is-open');
  for (const key of ['bgBtn', 'bgmPickerBtn', 'moodBtn', 'modelBtn', 'voicePickerBtn', 'settingsBtn']) {
    galState.els[key]?.classList.remove('is-active');
  }
}

function setUiHidden(hidden) {
  galState.uiHidden = Boolean(hidden);
  galState.els.stage?.classList.toggle('is-ui-hidden', galState.uiHidden);
  if (galState.uiHidden) closePopovers();
}

function refreshFaceWindowVisibility() {
  const { stage, faceWin } = galState.els;
  if (!stage || !faceWin) return;
  if (galState.isGroupChat) {
    const speakerId = galState.activeSpeakerId || '';
    syncGroupSpeakerFaceWindow(speakerId, speakerId ? (galState.memberMoods[speakerId] || galState.mood || 'neutral') : 'neutral');
    return;
  }
  const hasFaceVisual = Boolean(SPRITE_PACKS[galState.botId] || galState.avatarUrl);
  const showFace = Boolean(galState.faceWindowEnabled && hasFaceVisual);
  faceWin.hidden = !showFace;
  stage.classList.toggle('is-face-off', !showFace);
}

function applyAppearanceSettings() {
  const { stage } = galState.els;
  if (!stage) return;
  stage.style.setProperty('--gal-box-opacity', String(galState.boxOpacity));
  stage.style.setProperty('--gal-font-size', `${galState.fontSize}px`);
  stage.classList.toggle('is-motion-off', !galState.motionEnabled);
  stage.dataset.zoom = galState.zoom;
  refreshFaceWindowVisibility();
  if (galState.pixelCtrl) {
    galState.pixelCtrl.setMotionEnabled(galState.motionEnabled);
    galState.pixelCtrl.setQuality(galState.pixelQuality);
  }
}

function applyStageVisibility({ forceSync = false } = {}) {
  const eligible = isImmersiveEligible();
  const active = galState.enabled && eligible;
  if (!active || forceSync) { ++readingSession; confirmingAdvance = false; }
  const justActivated = active && !galState.wasActive;
  galState.wasActive = active;
  const { stage, toggleBtn, zoomBtn, regenBtn } = galState.els;
  if (toggleBtn) {
    toggleBtn.hidden = !eligible;
    toggleBtn.classList.toggle('is-active', active);
    toggleBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  document.body.classList.toggle('galgame-active', active);
  ensureBgmController().setStageActive(active);
  if (!active) {
    stopVoiceStatusPolling();
    if (galVoiceCtrl) galVoiceCtrl.stop({ keepLastTurn: true });
  } else if (justActivated) {
    ensureVoiceController().refreshStatus({ includeVoices: false }).catch(() => {});
  }
  if (stage) {
    stage.hidden = !active;
    stage.classList.toggle('is-group-mode', Boolean(galState.isGroupChat));
  }
  if (zoomBtn) {
    zoomBtn.textContent = galState.zoom === 'full' ? '镜头·全身' : '镜头·半身';
  }
  if (regenBtn) {
    regenBtn.hidden = Boolean(galState.isGroupChat || typeof galState.hooks.onRegenerate !== 'function');
  }

  if (active) {
    applyAppearanceSettings();
    if (galState.pixelCtrl) {
      const pixelActive = isPixelStageMode();
      if (pixelActive) syncPixelTheaterBackdrop();
      galState.pixelCtrl.setActive(pixelActive, { playOpeningCurtain: Boolean(pixelActive && justActivated) });
    }
    syncPixelTheaterControls();
    if (justActivated || forceSync) {
      setUiHidden(false);
      applyBackground(resolveBgUrl(galState.bgId));
      renderCharacterVisual();
      syncFromTranscript();
      syncThinkingDrawerState();
      if (galState.turn === 'user') requestAnimationFrame(() => galState.els.turnTextarea?.focus());
    } else {
      renderCharacterVisual();
    }
    renderGalStoryUI();
  } else {
    if (galState.pixelCtrl) galState.pixelCtrl.setActive(false);
    clearTimeout(galState.blinkTimer);
    clearTimeout(galState.blinkTimeout);
    clearTimeout(galState.perf.timer);
    clearAutoTimer();
    setBlinkVisible(false);
    closePopovers();
    renderGalStoryUI();
    if (galState.els.backlogOverlay) galState.els.backlogOverlay.hidden = true;
  }
}

function syncThinkingDrawerState() {
  const nativeBtn = document.getElementById('chatThinkingToggle');
  const { drawerThinkBtn, faceWin } = galState.els;
  const on = nativeBtn?.getAttribute('aria-pressed') === 'true';
  if (faceWin) {
    if (galState.isGroupChat) {
      faceWin.classList.remove('is-thinking-on');
    } else {
      faceWin.classList.toggle('is-thinking-on', on);
      faceWin.title = on ? '深度思考已开启（点击小立绘关闭）' : '点击小立绘开启深度思考模式';
      faceWin.setAttribute('aria-label', on ? '深度思考已开启，点击小立绘关闭' : '点击小立绘开启深度思考模式');
    }
  }
  if (drawerThinkBtn) {
    drawerThinkBtn.classList.toggle('is-active', on);
    drawerThinkBtn.textContent = on ? '深度思考：已开启' : '深度思考：已关闭';
  }
}

function buildParticles(container) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 14; i++) {
    const dot = document.createElement('span');
    dot.className = 'gal-star-dot';
    dot.style.setProperty('--lx', `${(6 + Math.random() * 88).toFixed(1)}%`);
    dot.style.setProperty('--ly', `${(8 + Math.random() * 64).toFixed(1)}%`);
    dot.style.setProperty('--sz', `${(3 + Math.random() * 3.8).toFixed(1)}px`);
    dot.style.setProperty('--dur', `${(6 + Math.random() * 5).toFixed(1)}s`);
    dot.style.setProperty('--delay', `${(-Math.random() * 8).toFixed(1)}s`);
    dot.style.setProperty('--dx', `${((Math.random() - 0.5) * 24).toFixed(1)}px`);
    frag.appendChild(dot);
  }
  container.appendChild(frag);
}

function buildBgGrid(container) {
  container.innerHTML = '';
  const pixelOn = isPixelStageMode();
  const baseList = pixelOn
    ? PIXEL_THEATER_BACKDROPS.map((b) => ({
        id: b.id,
        label: b.label,
        url: galState.pixelQuality === 'hd' ? b.hd : b.pixel,
      }))
    : [...PRESET_BGS];
  const list = [...baseList];
  if (galState.customBg) {
    list.push({ id: 'custom', label: '自定义背景', url: galState.customBg });
  }
  const activeId = pixelOn
    ? (galState.bgId === 'custom' ? 'custom' : (galState.pixelBgId || 'starry_library'))
    : galState.bgId;
  for (const bg of list) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `gal-bg-card${activeId === bg.id ? ' is-selected' : ''}`;
    card.dataset.bgId = bg.id;
    card.innerHTML = `<img src="${bg.url}" alt="${escapeText(bg.label)}" loading="lazy"><span>${escapeText(bg.label)}</span>`;
    card.addEventListener('click', () => {
      if (pixelOn) {
        if (bg.id === 'custom') {
          galState.bgId = 'custom';
          writePref(STORAGE_KEYS.bgId, 'custom');
        } else {
          if (galState.bgId === 'custom') {
            galState.bgId = PRESET_BGS.some((p) => p.id === bg.id) ? bg.id : 'observatory';
            writePref(STORAGE_KEYS.bgId, galState.bgId);
          }
          galState.pixelBgId = bg.id;
          writePref(STORAGE_KEYS.pixelBgId, bg.id);
        }
        syncPixelTheaterBackdrop();
      } else {
        galState.bgId = bg.id;
        writePref(STORAGE_KEYS.bgId, bg.id);
        applyBackground(resolveBgUrl(bg.id));
      }
      playGalSfx('switch');
      for (const c of container.querySelectorAll('.gal-bg-card')) {
        c.classList.toggle('is-selected', c.dataset.bgId === bg.id);
      }
    });
    container.appendChild(card);
  }
}

function sendFromImmersiveInput() {
  const field = galState.els.turnTextarea;
  if (!field) return;
  const text = field.value.trim();
  const media = typeof galState.hooks.getDraftMedia === 'function'
    ? galState.hooks.getDraftMedia()
    : { images: [], stickers: [] };
  const hasMedia = Boolean((media?.images?.length || 0) + (media?.stickers?.length || 0));
  if (!text && !hasMedia) return;
  const nativeInput = document.getElementById('composerInput');
  const nativeForm = document.getElementById('composer');
  if (!nativeInput || !nativeForm) return;
  nativeForm.requestSubmit();
  field.value = nativeInput.value;
  if (!field.value && (!hasMedia || !(galState.hooks.getDraftMedia()?.images.length || galState.hooks.getDraftMedia()?.stickers.length))) {
    playGalSfx('advance');
    setTurn('bot');
  } else {
    setTurn('user');
  }
  setTimeout(syncGalDraftMediaBar, 60);
}

export function initGalgameStage(hooks = {}) {
  if (galState.initialized) return;
  galState.initialized = true;
  galState.hooks = hooks;
  galState.enabled = false; // Enter explicitly via "沉浸模式" button next to "深度思考"
  galState.bgId = readPref(STORAGE_KEYS.bgId, 'observatory') || 'observatory';
  const legacyCustomBg = readPref(STORAGE_KEYS.customBg, '');
  galState.customBg = legacyCustomBg;
  const savedZoom = readPref(STORAGE_KEYS.zoom, 'half');
  galState.zoom = savedZoom === 'full' ? 'full' : 'half';
  galState.faceWindowEnabled = readPref(STORAGE_KEYS.faceWindow, '1') !== '0';
  galState.motionEnabled = readPref(STORAGE_KEYS.motion, '1') !== '0';
  galState.sfxEnabled = readPref(STORAGE_KEYS.sfx, '1') !== '0';
  galState.sfxVolume = Math.max(0.2, Math.min(2.0, parseFloat(readPref(STORAGE_KEYS.sfxVolume, '1')) || 1.0));
  const savedSpeed = readPref(STORAGE_KEYS.typingSpeed, 'normal');
  galState.typingSpeed = ['slow', 'normal', 'fast', 'instant'].includes(savedSpeed) ? savedSpeed : 'normal';
  galState.autoDelayMs = Math.max(800, Math.min(4500, parseInt(readPref(STORAGE_KEYS.autoDelayMs, '2000'), 10) || 2000));
  galState.boxOpacity = Math.max(0.35, Math.min(1, parseFloat(readPref(STORAGE_KEYS.boxOpacity, '0.86')) || 0.86));
  galState.fontSize = Math.max(16, Math.min(28, parseInt(readPref(STORAGE_KEYS.fontSize, '21'), 10) || 21));
  galState.stageMode = readPref(STORAGE_KEYS.stageMode, 'gal') === 'pixel' ? 'pixel' : 'gal';
  galState.pixelQuality = readPref(STORAGE_KEYS.pixelQuality, 'pixel') === 'hd' ? 'hd' : 'pixel';
  const savedPixelBg = readPref(STORAGE_KEYS.pixelBgId, 'starry_library');
  galState.pixelBgId = PIXEL_THEATER_BACKDROPS.some((b) => b.id === savedPixelBg) ? savedPixelBg : 'starry_library';

  // 从 IndexedDB 异步读取自定义背景；若检测到旧版 localStorage 残留则自动迁移释放配额
  void idbGetCustomBg().then((storedBg) => {
    if (storedBg) {
      galState.customBg = storedBg;
      if (legacyCustomBg) {
        try { localStorage.removeItem(STORAGE_KEYS.customBg); } catch {}
      }
      if (galState.els.bgGrid) buildBgGrid(galState.els.bgGrid);
      if (galState.enabled && galState.bgId === 'custom') {
        applyBackground(storedBg);
        if (isPixelStageMode()) syncPixelTheaterBackdrop();
      }
    } else if (legacyCustomBg) {
      void idbSetCustomBg(legacyCustomBg).then(() => {
        try { localStorage.removeItem(STORAGE_KEYS.customBg); } catch {}
      }).catch(() => {});
    }
  });

  const stage = document.getElementById('galStage');
  const toggleBtn = document.getElementById('galModeToggleBtn');
  if (!stage) return;

  stage.dataset.zoom = galState.zoom;
  stage.dataset.mood = 'neutral';
  stage.dataset.bgTheme = galState.bgId || 'observatory';
  stage.innerHTML = `
    <div class="gal-bg-layer">
      <img class="gal-bg-img" id="galBgA" alt="">
      <img class="gal-bg-img" id="galBgB" alt="">
    </div>
    <div class="gal-director-fx-layer" id="galDirectorFxLayer" aria-hidden="true"></div>
    <div class="gal-particles" id="galParticles" aria-hidden="true"></div>
    <div class="gal-egg-fx-layer" id="galEggFxLayer" aria-hidden="true"></div>

    <div class="gal-char-anchor" id="galCharAnchor">
      <div class="gal-sprite-rig" id="galSpriteRig">
        <div class="gal-sprite-breathe">
          <div class="gal-sprite-motion" id="galSpriteMotion">
            <div class="gal-sprite-canvas">
              <img class="gal-sprite-img" id="galSpriteMainA" alt="">
              <img class="gal-sprite-img" id="galSpriteMainB" alt="">
              <img class="gal-sprite-patch" id="galSpritePatch" alt="" aria-hidden="true">
              <img class="gal-sprite-patch is-instant" id="galSpriteBlink" alt="" aria-hidden="true">
              <div class="gal-emote-layer" id="galEmoteLayer" aria-hidden="true"></div>
            </div>
          </div>
        </div>
      </div>
      <div class="gal-fallback-card" id="galFallbackCard" hidden>
        <img class="gal-fallback-avatar" id="galFallbackAvatar" alt="">
      </div>
    </div>

    <div class="gal-group-cast" id="galGroupCast" hidden></div>

    <div class="gal-story-hud" id="galStoryHud" hidden></div>
    <div class="gal-director-deck" id="galDirectorDeck" hidden></div>
    <div class="gal-story-fork-overlay" id="galStoryForkOverlay" hidden></div>

    <button type="button" class="gal-side-tab" id="galSideTab" title="快捷菜单（右键画面可隐藏对话框）" aria-label="快捷菜单">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M8.5 2L3.5 6l5 4V2z"/></svg>
    </button>

    <div class="gal-side-drawer" id="galSideDrawer" hidden>
      <div class="gal-drawer-head">
        <span>沉浸快捷栏</span>
        <span style="font-weight:400;opacity:0.75;">右键隐藏框</span>
      </div>
      <button type="button" class="gal-drawer-btn" id="galDrawerStageModeBtn">切换为欧式像素剧院</button>
      <button type="button" class="gal-drawer-btn" id="galDrawerThinkBtn">✦ 深度思考</button>
      <button type="button" class="gal-drawer-btn" id="galDrawerHideBtn">隐藏对话框（H / 右键）</button>
      <button type="button" class="gal-drawer-btn" id="galDrawerExitBtn">退出沉浸模式（Esc）</button>
    </div>

    <div class="gal-vn-bottom" id="galVnBottom">
      <div class="gal-vn-gradient" id="galVnGradient">
        <button type="button" class="gal-face-window" id="galFaceWindow" title="点击小立绘开启深度思考模式" aria-label="点击切换深度思考模式">
          <div class="gal-face-canvas">
            <img class="gal-face-base" id="galFaceImgA" alt="">
            <img class="gal-face-base" id="galFaceImgB" alt="">
            <img class="gal-face-patch" id="galFacePatch" alt="" aria-hidden="true">
            <img class="gal-face-patch is-instant" id="galFaceBlink" alt="" aria-hidden="true">
          </div>
        </button>
        <div class="gal-vn-text-area" id="galVnTextArea">
          <div class="gal-speaker-bar" id="galSpeakerBar">
            <span class="gal-speaker-name" id="galSpeakerName">Gemini</span>
            <span class="gal-speaker-mood" id="galSpeakerMood">常态</span>
            <button type="button" class="gal-replay-voice-btn" id="galReplayVoiceBtn" title="朗读 / 重听当前台词" aria-label="朗读或重听当前台词">
              <span class="gal-voice-bars" aria-hidden="true"><i></i><i></i><i></i></span>
              <span class="gal-replay-voice-lbl">配音</span>
            </button>
            <span class="gal-group-typing-pill" id="galGroupTypingPill" hidden></span>
          </div>
          <div class="gal-dialogue-scroll thin-scroll" id="galDialogueScroll">
            <div class="gal-dialogue-text" id="galDialogueText"></div>
            <div class="gal-os-chip" id="galOsChip" hidden></div>
          </div>
          <div class="gal-turn-textarea-wrap" id="galTurnInputWrap" hidden>
            <div class="gal-draft-media-bar" id="galDraftMediaBar" hidden></div>
            <div class="gal-turn-input-row">
              <textarea class="gal-turn-textarea thin-scroll" id="galTurnTextarea" rows="2" placeholder="输入想说的话，按 Enter 发送（Shift+Enter 换行，支持 Ctrl+V 贴图）…" autocomplete="off"></textarea>
              <div class="gal-turn-tools">
                <button type="button" class="gal-turn-tool-btn" id="galAttachImgBtn" title="添加图片（也可直接 Ctrl+V 粘贴截图）" aria-label="添加图片">
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2.8" width="12" height="10.4" rx="1.8"/><circle cx="5.6" cy="6.1" r="1.1"/><path d="m2.6 11.4 3.1-3.1a.9.9 0 0 1 1.28 0l2.1 2.1 1.4-1.4a.9.9 0 0 1 1.28 0l1.6 1.6"/></svg>
                </button>
                <input type="file" id="galTurnImgInput" accept="image/*" multiple hidden>
                <button type="button" class="gal-turn-tool-btn" id="galStickerBtn" title="添加表情包" aria-label="添加表情包">
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.8"/><path d="M5.6 9.6a2.8 2.8 0 0 0 4.8 0"/><circle cx="6.1" cy="6.6" r=".6" fill="currentColor" stroke="none"/><circle cx="9.9" cy="6.6" r=".6" fill="currentColor" stroke="none"/></svg>
                </button>
                <button type="button" class="gal-turn-send-btn" id="galTurnSendBtn" title="发送回复">
                  <span>发送</span>
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h10M9 4l4 4-4 4"/></svg>
                </button>
              </div>
            </div>
          </div>
          <button type="button" class="gal-jump-latest" id="galJumpLatest" hidden>跳到最新</button>
          <button type="button" class="gal-next-prompt" id="galNextPrompt">
            <span class="gal-next-label">点击回应</span>
            <svg class="gal-next-tri" id="galNextTri" viewBox="0 0 14 11" aria-hidden="true">
              <path d="M1.5 1.5h11L7 9.5 1.5 1.5z" fill="#e5c896" stroke="#5b4330" stroke-width="1.2" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </div>

      <div class="gal-bottom-bar" id="galBottomBar">
        <div class="gal-bar-icons">
          <button type="button" class="gal-icon-btn" id="galAutoBtn" title="AUTO 自动观剧模式（快捷键 A）">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polygon points="4.5,3.2 12.8,8 4.5,12.8" fill="currentColor" stroke="none"/></svg>
          </button>
          <button type="button" class="gal-icon-btn" id="galRegenBtn" title="↻ 换一句（重新生成本轮回复）">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.35-3.42"/><path d="M13 3.2v2.7h-2.7"/></svg>
          </button>
          <button type="button" class="gal-icon-btn" id="galLockMoodBtn" title="锁定当前表情">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7.2" width="9" height="6.3" rx="1.4"/><path d="M5.5 7.2V5.2a2.5 2.5 0 0 1 5 0v2"/></svg>
          </button>
          <button type="button" class="gal-icon-btn is-active" id="galMotionBtn" title="开关 2.5D 呼吸与眨眼动效">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.2 9.3 5.8 12.9 7.1 9.3 8.4 8 12 6.7 8.4 3.1 7.1 6.7 5.8 8 2.2Z"/></svg>
          </button>
          <button type="button" class="gal-icon-btn ${galState.sfxEnabled ? 'is-active' : 'is-muted'}" id="galSfxBtn" title="开关沉浸互动微音效（快捷键 M）">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.2h2.6L9 3.4v9.2L5.6 9.8H3z"/><path class="gal-sfx-waves" d="M11.3 5.7a3.2 3.2 0 0 1 0 4.6M13 4a5.6 5.6 0 0 1 0 8"/><path class="gal-sfx-mute-x" d="M11.3 6.2l3.4 3.6M14.7 6.2l-3.4 3.6"/></svg>
          </button>
          <button type="button" class="gal-icon-btn ${ensureVoiceController().isEnabled() ? 'is-active' : 'is-muted'}" id="galVoiceBtn" title="开关角色配音（快捷键 V）">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2.2" width="4" height="7" rx="2"/><path d="M3.8 7.6a4.2 4.2 0 0 0 8.4 0"/><path d="M8 11.8v2.2M5.8 14h4.4"/><path class="gal-sfx-mute-x" d="M2.6 2.6l10.8 10.8"/></svg>
          </button>
          <button type="button" class="gal-icon-btn" id="galCopyLineBtn" title="复制当前台词">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.3l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11l-3.4 1.8.7-3.8-2.8-2.7 3.8-.5L8 2.3Z"/></svg>
          </button>
          <button type="button" class="gal-icon-btn" id="galPrevLineBtn" title="上一句对话（快捷键 ←）">
            <svg viewBox="0 0 16 16" fill="currentColor"><path d="M4.2 3.5h1.5v9H4.2v-9Zm2.3 4.5 5.3-4.2v8.4L6.5 8Z"/></svg>
          </button>
          <button type="button" class="gal-icon-btn" id="galNextLineBtn" title="下一句对话（快捷键 →）">
            <svg viewBox="0 0 16 16" fill="currentColor"><path d="M10.3 3.5h1.5v9h-1.5v-9ZM9.5 8l-5.3 4.2V3.8L9.5 8Z"/></svg>
          </button>
        </div>

        <div class="gal-bar-links">
          <button type="button" class="gal-link-btn" id="galStageModeBtn" title="在 2.5D 高清立绘舞台与欧式像素剧院之间无缝切换">像素剧院</button>
          <button type="button" class="gal-link-btn" id="galCurtainBtn" hidden title="拉开或合拢剧院红色丝绒大幕布">合幕</button>
          <button type="button" class="gal-link-btn" id="galSpeakBtn" title="打开/收起沉浸发言输入框">发言</button>
          <button type="button" class="gal-link-btn" id="galBgPickerBtn">场景</button>
          <button type="button" class="gal-link-btn" id="galBgmPickerBtn" title="智能 BGM 氛围音乐（配音发声自动压低）">BGM</button>
          <button type="button" class="gal-link-btn" id="galMoodPickerBtn">表情</button>
          <button type="button" class="gal-link-btn" id="galModelPickerBtn">模型</button>
          <button type="button" class="gal-link-btn" id="galVoicePickerBtn">配音</button>
          <button type="button" class="gal-link-btn" id="galZoomBtn">镜头·半身</button>
          <button type="button" class="gal-link-btn" id="galLogBtn">文本履历</button>
          <button type="button" class="gal-link-btn" id="galSettingsBtn">设置</button>
        </div>

        <button type="button" class="gal-exit-bubble" id="galExitBtn" title="退出沉浸模式（Esc）" aria-label="退出沉浸模式">
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>
        </button>
      </div>
    </div>

    <div class="gal-popover" id="galBgPopover" hidden>
      <div class="gal-popover-title"><span>选择场景背景</span><span style="font-weight:400;opacity:0.7;">16:9 氛围</span></div>
      <div class="gal-bg-grid" id="galBgGrid"></div>
      <button type="button" class="gal-upload-bg-btn" id="galUploadBgBtn">＋ 上传本地背景图</button>
      <input type="file" id="galBgFileInput" accept="image/*" hidden>
    </div>

    <div class="gal-popover" id="galBgmPopover" hidden style="width:336px;">
      <div class="gal-popover-title"><span>智能 BGM 氛围音轨</span><span id="galBgmBadge" style="font-weight:400;opacity:0.74;">配音自动压低</span></div>
      <div id="galBgmBody"></div>
      <input type="file" id="galBgmFileInput" accept="audio/*" hidden>
    </div>

    <div class="gal-popover" id="galMoodPopover" hidden style="width:356px;">
      <div class="gal-popover-title"><span id="galMoodPopoverTitle">16 姿势 × 16 表情差分</span><span id="galMoodPopoverSub" style="font-weight:400;opacity:0.74;">✦ 独立全身动作</span></div>
      <div class="gal-egg-bar" id="galEggBar" role="group" aria-label="专属彩蛋互动动作">
        <button type="button" class="gal-egg-btn" data-egg="tea" title="触发暖心奉茶互动姿态与暖金茶雾光效">☕ 暖心奉茶</button>
        <button type="button" class="gal-egg-btn" data-egg="goodnight" title="触发晚安好梦互动姿态与星夜月晕光效">🌙 晚安好梦</button>
        <button type="button" class="gal-egg-btn" data-egg="cheer" title="触发比心打气互动姿态与樱心星芒光效">💖 比心打气</button>
      </div>
      <div class="gal-mood-grid" id="galMoodGrid">
        <button type="button" class="gal-mood-pill is-selected" data-mood="neutral">常态</button>
        <button type="button" class="gal-mood-pill" data-mood="happy">开心</button>
        <button type="button" class="gal-mood-pill" data-mood="starry">星星眼</button>
        <button type="button" class="gal-mood-pill" data-mood="playful">调皮</button>
        <button type="button" class="gal-mood-pill" data-mood="gentle">温柔</button>
        <button type="button" class="gal-mood-pill" data-mood="content">安心闭眼</button>
        <button type="button" class="gal-mood-pill" data-mood="curious">好奇</button>
        <button type="button" class="gal-mood-pill" data-mood="shocked">惊呆</button>
        <button type="button" class="gal-mood-pill" data-mood="serious">认真</button>
        <button type="button" class="gal-mood-pill" data-mood="speechless">无语</button>
        <button type="button" class="gal-mood-pill" data-mood="shy">害羞</button>
        <button type="button" class="gal-mood-pill" data-mood="worried">担心</button>
        <button type="button" class="gal-mood-pill" data-mood="jealous">吃醋</button>
        <button type="button" class="gal-mood-pill" data-mood="gloomy">失落</button>
        <button type="button" class="gal-mood-pill" data-mood="hiss">炸毛哈气</button>
        <button type="button" class="gal-mood-pill" data-mood="crying">委屈大哭</button>
      </div>
      <div class="gal-pixel-actions-wrap" id="galPixelActionsWrap" hidden>
        <div class="gal-pixel-actions-head">
          <span>像素剧院动作演播（12 套真循环）</span>
          <span style="opacity:0.74;">点击角色演绎</span>
        </div>
        <div class="gal-pixel-actions-grid" id="galPixelActionsGrid">
          ${PIXEL_THEATER_ACTIONS.map((a) => `<button type="button" class="gal-pixel-act-btn" data-pixel-act="${a.key}">${a.label}</button>`).join('')}
        </div>
      </div>
    </div>

    <div class="gal-popover" id="galModelPopover" hidden style="width:296px;">
      <div class="gal-popover-title"><span>切换当前对话模型</span><span style="font-weight:400;opacity:0.7;">即时生效</span></div>
      <div class="gal-model-list thin-scroll" id="galModelList"></div>
    </div>

    <div class="gal-popover gal-voice-popover" id="galVoicePopover" hidden style="width:372px;">
      <div class="gal-popover-title"><span>Breeze-TTS-2 沉浸配音</span><span id="galVoiceBadge" style="font-weight:500;opacity:0.8;">检测中…</span></div>
      <div class="gal-voice-body thin-scroll" id="galVoiceBody"></div>
    </div>

    <div class="gal-popover" id="galSettingsPopover" hidden style="width:288px;">
      <div class="gal-popover-title"><span>沉浸显示与演译设置</span><span style="font-weight:400;opacity:0.7;">实时生效</span></div>
      <label class="gal-setting-row">
        <span>左下角联动小立绘</span>
        <input type="checkbox" id="galOptFaceWin" ${galState.faceWindowEnabled ? 'checked' : ''}>
      </label>
      <label class="gal-setting-row" id="galOptPixelQualityRow" hidden>
        <span>像素剧院使用高清幕布</span>
        <input type="checkbox" id="galOptPixelQualityChk" ${galState.pixelQuality === 'hd' ? 'checked' : ''}>
      </label>
      <div class="gal-setting-row is-col">
        <span>打字机演译速度</span>
        <div class="gal-speed-seg" id="galOptSpeedSeg" role="radiogroup" aria-label="打字机演译速度">
          <button type="button" class="gal-speed-opt${galState.typingSpeed === 'slow' ? ' is-selected' : ''}" data-speed="slow">慢</button>
          <button type="button" class="gal-speed-opt${galState.typingSpeed === 'normal' ? ' is-selected' : ''}" data-speed="normal">中</button>
          <button type="button" class="gal-speed-opt${galState.typingSpeed === 'fast' ? ' is-selected' : ''}" data-speed="fast">快</button>
          <button type="button" class="gal-speed-opt${galState.typingSpeed === 'instant' ? ' is-selected' : ''}" data-speed="instant">瞬显</button>
        </div>
      </div>
      <label class="gal-setting-row">
        <span>微音效音量 <em id="galOptVolVal">${Math.round(galState.sfxVolume * 100)}%</em></span>
        <input type="range" id="galOptSfxVol" min="0.2" max="2" step="0.1" value="${galState.sfxVolume}">
      </label>
      <label class="gal-setting-row">
        <span>AUTO 停顿 <em id="galOptAutoVal">${(galState.autoDelayMs / 1000).toFixed(1)}s</em></span>
        <input type="range" id="galOptAutoDelay" min="800" max="4500" step="200" value="${galState.autoDelayMs}">
      </label>
      <label class="gal-setting-row">
        <span>字幕底雾浓度</span>
        <input type="range" id="galOptOpacity" min="0.35" max="1" step="0.05" value="${galState.boxOpacity}">
      </label>
      <label class="gal-setting-row">
        <span>台词字号</span>
        <input type="range" id="galOptFontSize" min="16" max="26" step="1" value="${galState.fontSize}">
      </label>
    </div>

    <div class="gal-backlog-overlay" id="galBacklogOverlay" hidden>
      <div class="gal-backlog-panel">
        <div class="gal-backlog-head">
          <span>文本履历</span>
          <input type="search" class="gal-backlog-search" id="galBacklogSearch" placeholder="搜索台词或角色名…" autocomplete="off">
          <button type="button" class="gal-backlog-close" id="galBacklogClose">关闭</button>
        </div>
        <div class="gal-backlog-list thin-scroll" id="galBacklogList"></div>
      </div>
    </div>

    <div class="gal-mini-toast" id="galMiniToast" role="status" aria-live="polite"></div>
  `;

  galState.els = {
    stage,
    toggleBtn,
    bgA: stage.querySelector('#galBgA'),
    bgB: stage.querySelector('#galBgB'),
    charAnchor: stage.querySelector('#galCharAnchor'),
    groupCast: stage.querySelector('#galGroupCast'),
    storyHud: stage.querySelector('#galStoryHud'),
    storyForkOverlay: stage.querySelector('#galStoryForkOverlay'),
    spriteRig: stage.querySelector('#galSpriteRig'),
    spriteMotion: stage.querySelector('#galSpriteMotion'),
    spriteMainA: stage.querySelector('#galSpriteMainA'),
    spriteMainB: stage.querySelector('#galSpriteMainB'),
    spritePatch: stage.querySelector('#galSpritePatch'),
    spriteBlink: stage.querySelector('#galSpriteBlink'),
    emoteLayer: stage.querySelector('#galEmoteLayer'),
    fallbackCard: stage.querySelector('#galFallbackCard'),
    fallbackImg: stage.querySelector('#galFallbackAvatar'),
    vnGradient: stage.querySelector('#galVnGradient'),
    vnTextArea: stage.querySelector('#galVnTextArea'),
    faceWin: stage.querySelector('#galFaceWindow'),
    faceImgA: stage.querySelector('#galFaceImgA'),
    faceImgB: stage.querySelector('#galFaceImgB'),
    facePatch: stage.querySelector('#galFacePatch'),
    faceBlink: stage.querySelector('#galFaceBlink'),
    speakerBar: stage.querySelector('#galSpeakerBar'),
    speakerName: stage.querySelector('#galSpeakerName'),
    speakerMood: stage.querySelector('#galSpeakerMood'),
    replayVoiceBtn: stage.querySelector('#galReplayVoiceBtn'),
    groupTypingPill: stage.querySelector('#galGroupTypingPill'),
    dialogueScroll: stage.querySelector('#galDialogueScroll'),
    dialogueText: stage.querySelector('#galDialogueText'),
    osChip: stage.querySelector('#galOsChip'),
    directorFxLayer: stage.querySelector('#galDirectorFxLayer'),
    directorDeck: stage.querySelector('#galDirectorDeck'),
    turnInputWrap: stage.querySelector('#galTurnInputWrap'),
    draftMediaBar: stage.querySelector('#galDraftMediaBar'),
    turnTextarea: stage.querySelector('#galTurnTextarea'),
    attachImgBtn: stage.querySelector('#galAttachImgBtn'),
    turnImgInput: stage.querySelector('#galTurnImgInput'),
    stickerBtn: stage.querySelector('#galStickerBtn'),
    turnSendBtn: stage.querySelector('#galTurnSendBtn'),
    jumpLatest: stage.querySelector('#galJumpLatest'),
    nextPrompt: stage.querySelector('#galNextPrompt'),
    nextTri: stage.querySelector('#galNextTri'),
    autoBtn: stage.querySelector('#galAutoBtn'),
    regenBtn: stage.querySelector('#galRegenBtn'),
    lockMoodBtn: stage.querySelector('#galLockMoodBtn'),
    motionBtn: stage.querySelector('#galMotionBtn'),
    sfxBtn: stage.querySelector('#galSfxBtn'),
    voiceBtn: stage.querySelector('#galVoiceBtn'),
    copyLineBtn: stage.querySelector('#galCopyLineBtn'),
    prevLineBtn: stage.querySelector('#galPrevLineBtn'),
    nextLineBtn: stage.querySelector('#galNextLineBtn'),
    stageModeBtn: stage.querySelector('#galStageModeBtn'),
    curtainBtn: stage.querySelector('#galCurtainBtn'),
    speakBtn: stage.querySelector('#galSpeakBtn'),
    bgBtn: stage.querySelector('#galBgPickerBtn'),
    bgmPickerBtn: stage.querySelector('#galBgmPickerBtn'),
    bgmPopover: stage.querySelector('#galBgmPopover'),
    bgmBody: stage.querySelector('#galBgmBody'),
    bgmBadge: stage.querySelector('#galBgmBadge'),
    bgmFileInput: stage.querySelector('#galBgmFileInput'),
    moodBtn: stage.querySelector('#galMoodPickerBtn'),
    modelBtn: stage.querySelector('#galModelPickerBtn'),
    voicePickerBtn: stage.querySelector('#galVoicePickerBtn'),
    zoomBtn: stage.querySelector('#galZoomBtn'),
    logBtn: stage.querySelector('#galLogBtn'),
    settingsBtn: stage.querySelector('#galSettingsBtn'),
    exitBtn: stage.querySelector('#galExitBtn'),
    sideTab: stage.querySelector('#galSideTab'),
    sideDrawer: stage.querySelector('#galSideDrawer'),
    drawerStageModeBtn: stage.querySelector('#galDrawerStageModeBtn'),
    drawerThinkBtn: stage.querySelector('#galDrawerThinkBtn'),
    drawerHideBtn: stage.querySelector('#galDrawerHideBtn'),
    drawerExitBtn: stage.querySelector('#galDrawerExitBtn'),
    bgPopover: stage.querySelector('#galBgPopover'),
    bgGrid: stage.querySelector('#galBgGrid'),
    uploadBgBtn: stage.querySelector('#galUploadBgBtn'),
    bgFileInput: stage.querySelector('#galBgFileInput'),
    moodPopover: stage.querySelector('#galMoodPopover'),
    moodPopoverTitle: stage.querySelector('#galMoodPopoverTitle'),
    moodPopoverSub: stage.querySelector('#galMoodPopoverSub'),
    eggBar: stage.querySelector('#galEggBar'),
    eggFxLayer: stage.querySelector('#galEggFxLayer'),
    moodGrid: stage.querySelector('#galMoodGrid'),
    pixelActionsWrap: stage.querySelector('#galPixelActionsWrap'),
    pixelActionsGrid: stage.querySelector('#galPixelActionsGrid'),
    modelPopover: stage.querySelector('#galModelPopover'),
    modelList: stage.querySelector('#galModelList'),
    voicePopover: stage.querySelector('#galVoicePopover'),
    voiceBadge: stage.querySelector('#galVoiceBadge'),
    voiceBody: stage.querySelector('#galVoiceBody'),
    settingsPopover: stage.querySelector('#galSettingsPopover'),
    optFaceWin: stage.querySelector('#galOptFaceWin'),
    optPixelQualityRow: stage.querySelector('#galOptPixelQualityRow'),
    optPixelQualityChk: stage.querySelector('#galOptPixelQualityChk'),
    optSpeedSeg: stage.querySelector('#galOptSpeedSeg'),
    optSfxVol: stage.querySelector('#galOptSfxVol'),
    optVolVal: stage.querySelector('#galOptVolVal'),
    optAutoDelay: stage.querySelector('#galOptAutoDelay'),
    optAutoVal: stage.querySelector('#galOptAutoVal'),
    optOpacity: stage.querySelector('#galOptOpacity'),
    optFontSize: stage.querySelector('#galOptFontSize'),
    backlogOverlay: stage.querySelector('#galBacklogOverlay'),
    backlogSearch: stage.querySelector('#galBacklogSearch'),
    backlogList: stage.querySelector('#galBacklogList'),
    backlogClose: stage.querySelector('#galBacklogClose'),
    miniToast: stage.querySelector('#galMiniToast'),
  };

  buildParticles(stage.querySelector('#galParticles'));
  buildBgGrid(galState.els.bgGrid);
  syncMoodPopoverForCurrentChar();
  galState.els.motionBtn?.classList.toggle('is-active', galState.motionEnabled);

  // 2.5D subtle mouse parallax
  let rafParallax = 0;
  let tx = 0;
  let ty = 0;
  stage.addEventListener('pointermove', (e) => {
    if (!galState.enabled || !isImmersiveEligible() || !galState.motionEnabled) return;
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    tx = Math.max(-1, Math.min(1, ((e.clientX - rect.left) / rect.width - 0.5) * 2));
    ty = Math.max(-1, Math.min(1, ((e.clientY - rect.top) / rect.height - 0.5) * 2));
    if (rafParallax) return;
    rafParallax = requestAnimationFrame(() => {
      rafParallax = 0;
      stage.style.setProperty('--gal-px', `${(tx * 9).toFixed(2)}px`);
      stage.style.setProperty('--gal-py', `${(ty * 6).toFixed(2)}px`);
      stage.style.setProperty('--gal-tilt', `${(tx * 0.6).toFixed(2)}deg`);
    });
  });

  // RIGHT-CLICK ANYWHERE TO HIDE / RESTORE DIALOGUE BOX!
  stage.addEventListener('contextmenu', (e) => {
    if (!galState.enabled) return;
    if (e.target.closest('.gal-turn-textarea')) return;
    e.preventDefault();
    if (!galState.els.backlogOverlay.hidden) {
      galState.els.backlogOverlay.hidden = true;
      return;
    }
    setUiHidden(!galState.uiHidden);
  });

  galState.els.jumpLatest.addEventListener('click', e => {
    e.stopPropagation();
    if (galState.isGroupChat && unreadLines()) showGroupQueueItem(galState.groupQueue.length - 1, { animate: false });
  });
  galState.els.dialogueScroll.addEventListener('scroll', () => {
    if (galState.enabled && galState.isSoloChat) updateNextPrompt({ streaming: galState.streamActive });
  }, { passive: true });
  galState.els.nextPrompt?.addEventListener('click', e => {
    e.stopPropagation();
    advanceGalDialogue();
  });
  // Left-click: restore UI if hidden, or advance bot turn -> user turn when character finished speaking!
  stage.addEventListener('click', (e) => {
    if (galState.uiHidden) {
      setUiHidden(false);
      return;
    }
    if (e.target.closest('.gal-popover') || e.target.closest('.gal-bottom-bar') || e.target.closest('.gal-side-drawer') || e.target.closest('.gal-side-tab') || e.target.closest('.gal-face-window') || e.target.closest('.gal-backlog-overlay') || e.target.closest('.gal-story-hud') || e.target.closest('.gal-story-fork-overlay') || e.target.closest('.pt-choice-host') || e.target.closest('.pt-floor-hitbox') || e.target.closest('.pt-actor')) {
      return;
    }
    const hadPopover = openStagePanel();
    closePopovers();
    if (hadPopover) return;

    // Turn-based & multi-segment loop: advance next segment first, then hand box to user on the final segment!
    if (!galState.isGroupChat && galState.turn === 'bot') {
      if (window.getSelection?.()?.toString()) return;
      advanceGalDialogue();
    }
  });

  // Left Face Window click: 1v1 toggles Deep Thinking; group pixel theater quickly @mentions current speaker!
  galState.els.faceWin?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (galState.isGroupChat) {
      const targetId = galState.activeSpeakerId || galState.els.faceWin?.dataset?.speakerId || '';
      const member = galState.groupMembers.find((m) => m.id === targetId);
      const mentionName = member?.name || galState.activeSpeakerName || '';
      if (!mentionName || mentionName.startsWith('✦')) return;
      if (galState.turn !== 'user') setTurn('user');
      const field = galState.els.turnTextarea;
      if (field) {
        const mention = `@${mentionName} `;
        if (!field.value.includes(mention)) {
          field.value = `${field.value}${field.value && !field.value.endsWith(' ') ? ' ' : ''}${mention}`;
          field.dispatchEvent(new Event('input', { bubbles: true }));
        }
        field.focus();
      }
      return;
    }
    const nativeBtn = document.getElementById('chatThinkingToggle');
    if (!nativeBtn) return;
    nativeBtn.click();
    setTimeout(() => {
      syncThinkingDrawerState();
      const on = nativeBtn.getAttribute('aria-pressed') === 'true';
      showMiniToast(on ? '深度思考模式已开启' : '深度思考模式已关闭');
    }, 60);
  });

  // Scroll wheel up opens Backlog ("文本履历")
  stage.addEventListener('wheel', (e) => {
    if (!galState.enabled || galState.uiHidden) return;
    if (!galState.els.backlogOverlay.hidden) return;
    if (e.target.closest('.gal-dialogue-scroll') || e.target.closest('.gal-popover')) return;
    if (e.deltaY < -35) openBacklog();
  }, { passive: true });

  // Keyboard shortcuts: Esc / Space / Enter / Arrows / A(Auto) / H(Hide) / L(Backlog) / M(Mute)
  window.addEventListener('keydown', (e) => {
    if (!galState.enabled) return;
    if (e.key === 'Escape') {
      if (galState.els.backlogOverlay && !galState.els.backlogOverlay.hidden) {
        e.preventDefault();
        e.stopImmediatePropagation();
        galState.els.backlogOverlay.hidden = true;
      } else if (galState.uiHidden) {
        setUiHidden(false);
      } else if (openStagePanel()) {
        const opener = galState.els[panelButtons[openStagePanel()]] || galState.els.storyHud?.querySelector('[data-gal-story="deck"]');
        closePopovers();
        opener?.focus();
        e.preventDefault();
        e.stopImmediatePropagation();
      } else {
        if (galState.autoPlay) setAutoPlay(false, { silent: true });
        galState.enabled = false;
        applyStageVisibility();
      }
      return;
    }

    const active = document.activeElement;
    const isTypingInField = Boolean(active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable));
    if ((active?.closest('button') && ['Enter', ' '].includes(e.key)) || isTypingInField || e.ctrlKey || e.metaKey || e.altKey) return;

    const lower = String(e.key || '').toLowerCase();
    if (lower === 'l') {
      e.preventDefault();
      if (galState.els.backlogOverlay.hidden) { closePopovers(); openBacklog(); }
      else galState.els.backlogOverlay.hidden = true;
      return;
    }
    if (!galState.els.backlogOverlay.hidden) return;

    if (lower === 'h') {
      e.preventDefault();
      setUiHidden(!galState.uiHidden);
      return;
    }
    if (lower === 'm') {
      e.preventDefault();
      galState.els.sfxBtn?.click();
      return;
    }
    if (lower === 'v') {
      e.preventDefault();
      galState.els.voiceBtn?.click();
      return;
    }
    if (lower === 'a') {
      e.preventDefault();
      setAutoPlay(!galState.autoPlay);
      return;
    }
    if (e.key === 'ArrowLeft' && !galState.uiHidden) {
      e.preventDefault();
      stepHistory(-1);
      return;
    }
    if (e.key === 'ArrowRight' && !galState.uiHidden) {
      e.preventDefault();
      if (galState.isGroupChat && galState.groupQueueIndex < galState.groupQueue.length - 1) {
        advanceGalDialogue();
      } else {
        stepHistory(1);
      }
      return;
    }
    if ((e.key === ' ' || e.key === 'Enter') && galState.turn === 'bot' && !galState.uiHidden) {
      e.preventDefault();
      advanceGalDialogue();
    }
  });

  // Toggle immersive mode from composer toolbar button
  toggleBtn?.addEventListener('click', () => {
    galState.enabled = !galState.enabled;
    applyStageVisibility();
    if (galState.enabled) {
      playGalSfx('switch');
      showMiniToast('已进入沉浸模式 · 右键画面可隐藏对话框');
    }
  });

  // Turn-based dialogue box textarea input (+ Ctrl+V screenshot paste + image/sticker buttons)
  galState.els.turnTextarea?.addEventListener('input', e => {
    const native = document.getElementById('composerInput');
    if (!native || !galState.enabled) return;
    native.value = e.target.value;
    native.dispatchEvent(new Event('input', { bubbles: true }));
  });
  galState.els.turnTextarea?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendFromImmersiveInput();
    }
  });
  galState.els.turnTextarea?.addEventListener('paste', (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const imgs = items.filter((it) => it.kind === 'file' && String(it.type || '').startsWith('image/')).map((it) => it.getAsFile()).filter(Boolean);
    if (imgs.length && typeof galState.hooks.onUploadImages === 'function') {
      e.preventDefault();
      void Promise.resolve(galState.hooks.onUploadImages(imgs)).then(() => {
        syncGalDraftMediaBar();
        showMiniToast(`已添加 ${imgs.length} 张待发图片`);
      });
    }
  });
  galState.els.attachImgBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    galState.els.turnImgInput?.click();
  });
  galState.els.turnImgInput?.addEventListener('change', (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (files.length && typeof galState.hooks.onUploadImages === 'function') {
      void Promise.resolve(galState.hooks.onUploadImages(files)).then(() => {
        syncGalDraftMediaBar();
        showMiniToast(`已添加 ${files.length} 张待发图片`);
      });
    }
  });
  galState.els.stickerBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (typeof galState.hooks.onPickSticker === 'function') {
      galState.hooks.onPickSticker(() => {
        syncGalDraftMediaBar();
        galState.els.turnTextarea?.focus();
      });
    }
  });
  galState.els.turnSendBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    sendFromImmersiveInput();
  });

  // Bottom bar small icon buttons
  galState.els.autoBtn?.addEventListener('click', () => {
    setAutoPlay(!galState.autoPlay);
  });
  galState.els.regenBtn?.addEventListener('click', () => {
    if (galState.isGroupChat || typeof galState.hooks.onRegenerate !== 'function') return;
    clearAutoTimer();
    resetPerformance();
    playGalSfx('switch');
    galState.speaking = true;
    setTurn('bot');
    renderDialogueContent('', { thinking: true, streaming: true, speaker: galState.botName });
    void Promise.resolve(galState.hooks.onRegenerate());
  });
  galState.els.lockMoodBtn?.addEventListener('click', () => {
    galState.moodLocked = !galState.moodLocked;
    galState.els.lockMoodBtn.classList.toggle('is-active', galState.moodLocked);
    showMiniToast(galState.moodLocked ? '已锁定当前表情' : '已恢复对话自动切表情');
  });
  galState.els.motionBtn?.addEventListener('click', () => {
    galState.motionEnabled = !galState.motionEnabled;
    writePref(STORAGE_KEYS.motion, galState.motionEnabled ? '1' : '0');
    galState.els.motionBtn.classList.toggle('is-active', galState.motionEnabled);
    applyAppearanceSettings();
    scheduleNextBlink();
    showMiniToast(galState.motionEnabled ? '2.5D 呼吸与眨眼已开启' : '2.5D 动效已暂停');
  });
  galState.els.sfxBtn?.addEventListener('click', () => {
    galState.sfxEnabled = !galState.sfxEnabled;
    writePref(STORAGE_KEYS.sfx, galState.sfxEnabled ? '1' : '0');
    galState.els.sfxBtn.classList.toggle('is-active', galState.sfxEnabled);
    galState.els.sfxBtn.classList.toggle('is-muted', !galState.sfxEnabled);
    if (galState.sfxEnabled) playGalSfx('switch');
    showMiniToast(galState.sfxEnabled ? '互动微音效已开启' : '互动微音效已静音');
  });
  galState.els.voiceBtn?.addEventListener('click', () => {
    const vc = ensureVoiceController();
    const next = !vc.isEnabled();
    vc.setEnabled(next);
    if (next) playGalSfx('switch');
    const snap = vc.getSnapshot();
    showMiniToast(next
      ? (snap.serverOnline ? '角色配音已开启（Breeze-TTS-2 就绪）' : '角色配音已开启（点击“配音”可一键启动本机引擎）')
      : '角色配音已静音');
  });
  galState.els.replayVoiceBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const vc = ensureVoiceController();
    const snap = vc.getSnapshot();
    if (snap.playing || snap.synthesizing) {
      vc.stop({ keepLastTurn: true });
      showMiniToast('已停止当前朗读');
      return;
    }
    const curBotId = galState.isGroupChat ? (galState.activeSpeakerId || '') : (galState.botId || '');
    const curText = galState.els.dialogueText?.textContent || '';
    const ok = vc.replayLastTurn({
      fallbackBotId: curBotId,
      fallbackText: curText,
      fallbackMood: galState.mood || 'neutral',
    });
    if (ok && !snap.serverOnline) {
      vc.refreshStatus({ includeVoices: false }).then((st) => {
        if (st && !st.online) {
          showMiniToast('本机 Breeze 引擎尚未启动，请点底栏「配音」一键启动');
        }
      }).catch(() => {});
    }
  });
  galState.els.copyLineBtn?.addEventListener('click', () => {
    const txt = galState.els.dialogueText?.textContent || '';
    if (txt && navigator.clipboard) {
      navigator.clipboard.writeText(txt).then(() => showMiniToast('已复制当前台词')).catch(() => {});
    }
  });
  galState.els.prevLineBtn?.addEventListener('click', () => {
    if (galState.isGroupChat && galState.groupQueue.length > 0 && galState.groupQueueIndex > 0) {
      showGroupQueueItem(galState.groupQueueIndex - 1, { animate: false });
      const total = galState.historyEntries.length || galState.groupQueue.length;
      const offsetFromEnd = (galState.groupQueue.length - 1) - galState.groupQueueIndex;
      galState.historyCursor = Math.max(0, total - 1 - offsetFromEnd);
      showMiniToast(`对话记录 ${galState.historyCursor + 1} / ${total}`);
    } else {
      stepHistory(-1);
    }
  });
  galState.els.nextLineBtn?.addEventListener('click', () => {
    const inHistoryBrowsing = galState.historyCursor >= 0 && galState.historyCursor < galState.historyEntries.length - 1;
    if (!inHistoryBrowsing && galState.isGroupChat && galState.groupQueueIndex < galState.groupQueue.length - 1) {
      advanceGalDialogue();
    } else {
      stepHistory(1);
    }
  });
  galState.els.speakBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    closePopovers();
    if (galState.turn === 'user') {
      setTurn('bot');
      if (galState.isGroupChat && galState.groupQueueIndex >= 0) showGroupQueueItem(galState.groupQueueIndex, { animate: false });
      if (hasPendingStoryFork()) {
        galState.story.collapsed = false;
        renderGalStoryUI();
        updateNextPrompt({ streaming: false });
      }
      return;
    }
    if (hasPendingStoryFork() && !galState.story.collapsed) {
      galState.story.collapsed = true;
      renderGalStoryUI();
    }
    setTurn('user');
  });

  // Breeze-TTS-2 沉浸配音面板渲染与托管控制
  const VOICE_BOT_OPTIONS = [
    ['ai-gemini', 'Gemini（星光猫娘）'],
    ['ai-claude', 'Claude（温润学姐）'],
    ['ai-gpt', 'GPT（元气可靠）'],
    ['ai-deepseek', 'DeepSeek（清冽干脆）'],
    ['ai-kimi', 'Kimi（深夜书卷）'],
    ['ai-qwen', 'Qwen（暖甜亲切）'],
    ['ai-glm', 'GLM（知性沉稳）'],
    ['ai-grok', 'Grok（慵懒御姐）'],
  ];

  const mkEl = (tag, cls = '', text = '') => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text) el.textContent = text;
    return el;
  };

  let voiceAdvOpen = false;

  const paintVoicePopover = () => {
    const body = galState.els.voiceBody;
    const badge = galState.els.voiceBadge;
    if (!body) return;
    const vc = ensureVoiceController();
    const snap = vc.getSnapshot();
    const st = snap.serverStatus || {};
    const cfg = st.config || { enabled: true, endpoint: 'http://127.0.0.1:8080', localDir: 'G:\\breeze-cpp', useCpu: false, moodDirection: true, defaultCfgScale: 1.5, bots: {} };
    const defaults = st.defaultProfiles || {};
    const voices = Array.isArray(st.voices) ? st.voices : [];
    const install = st.install || {};

    if (!galVoiceSelectedBotId) {
      galVoiceSelectedBotId = (galState.isGroupChat ? galState.activeSpeakerId : galState.botId) || 'ai-gemini';
    }
    const targetBotId = galVoiceSelectedBotId;
    const defProf = defaults[targetBotId] || { voiceId: '', instruction: '', cfgScale: 1.5, seed: 42, previewLine: '你好，本地语音引擎已经就绪！' };
    const savedBot = (cfg.bots && cfg.bots[targetBotId]) || {};
    const curVoiceId = typeof savedBot.voiceId === 'string' ? savedBot.voiceId : '';
    const curInstruction = typeof savedBot.instruction === 'string' && savedBot.instruction ? savedBot.instruction : (defProf.instruction || '');
    const curCfgScale = typeof savedBot.cfgScale === 'number' ? savedBot.cfgScale : (defProf.cfgScale || 1.5);
    const curSeed = typeof savedBot.seed === 'number' ? savedBot.seed : (defProf.seed || 42);

    if (badge) {
      if (st.state === 'ready' || st.online) {
        badge.textContent = `● 已就绪 ${st.sampleRate ? `${Math.round(st.sampleRate / 1000)}kHz` : ''}`.trim();
        badge.dataset.state = 'ready';
      } else if (st.state === 'starting') {
        badge.textContent = '◌ 模型加载中…';
        badge.dataset.state = 'starting';
      } else if (st.state === 'error') {
        badge.textContent = '✕ 启动异常';
        badge.dataset.state = 'error';
      } else {
        badge.textContent = '○ 未启动（未占显存）';
        badge.dataset.state = 'stopped';
      }
    }

    body.replaceChildren();

    // 1. 引擎托管控制卡片
    const srvCard = mkEl('div', 'gal-voice-card');
    const srvInfo = mkEl('div', 'gal-voice-srv-info');
    const srvTitle = mkEl(
      'div',
      'gal-voice-srv-title',
      st.online
        ? (st.externalRunning ? `已连接本机 Breeze 服务（${cfg.endpoint}）` : `Breeze-TTS-2 托管运行中（${cfg.endpoint}）`)
        : (st.state === 'starting'
            ? `正在加载 Q8_0 模型并预热 GPU（${cfg.endpoint}，约 5~10 秒）…`
            : (st.state === 'error' && st.lastError
                ? `启动失败：${st.lastError}`
                : (install.found ? `已检测到本机引擎：${install.rootDir}` : (install.missingReason || '未检测到本机目录'))))
    );
    srvInfo.append(srvTitle);

    const srvBtns = mkEl('div', 'gal-voice-srv-btns');
    if (st.managed || st.state === 'starting') {
      const stopBtn = mkEl('button', 'gal-voice-btn is-danger', '停止并释放显存');
      stopBtn.type = 'button';
      stopBtn.onclick = async () => {
        stopBtn.disabled = true;
        stopVoiceStatusPolling();
        try {
          await vc.controlServer('stop');
          showMiniToast('已停止本机 Breeze 引擎并释放显存');
        } catch (err) {
          showMiniToast(err?.message || '停止失败');
        }
        paintVoicePopover();
      };
      srvBtns.append(stopBtn);
    } else if (!st.online) {
      const startBtn = mkEl('button', 'gal-voice-btn is-primary', '▶ 一键启动 Breeze 引擎');
      startBtn.type = 'button';
      startBtn.disabled = !install.found;
      startBtn.onclick = async () => {
        startBtn.disabled = true;
        startBtn.textContent = '启动中…';
        try {
          const startedSt = await vc.controlServer('start');
          showMiniToast(startedSt?.actionNote || '正在加载 Breeze-TTS-2 模型，几秒后自动就绪');
          stopVoiceStatusPolling();
          galVoicePollTimer = setInterval(async () => {
            const nextSt = await vc.refreshStatus({ includeVoices: true });
            if (!galState.els.voicePopover?.hidden) paintVoicePopover();
            if (nextSt?.online) {
              stopVoiceStatusPolling();
              showMiniToast(`✦ Breeze-TTS-2 已就绪（${nextSt?.config?.endpoint || ''}），可以点击「试听一句」或直接聊天！`);
            } else if (nextSt && nextSt.state !== 'starting') {
              stopVoiceStatusPolling();
              if (nextSt.lastError) showMiniToast(`Breeze 启动异常：${nextSt.lastError}`);
            }
          }, 1500);
        } catch (err) {
          showMiniToast(err?.message || '启动 Breeze 引擎失败');
        }
        paintVoicePopover();
      };
      srvBtns.append(startBtn);
    }

    const refBtn = mkEl('button', 'gal-voice-btn', '刷新状态');
    refBtn.type = 'button';
    refBtn.onclick = async () => {
      refBtn.disabled = true;
      await vc.refreshStatus({ includeVoices: true });
      paintVoicePopover();
    };
    srvBtns.append(refBtn);

    if (st.online && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|192\.168\.|10\.|172\.)/i.test(cfg.endpoint || '')) {
      const webLink = mkEl('a', 'gal-voice-btn', '音色工坊 ↗');
      webLink.href = cfg.endpoint;
      webLink.target = '_blank';
      webLink.rel = 'noopener noreferrer';
      srvBtns.append(webLink);
    }
    srvCard.append(srvInfo, srvBtns);

    if ((st.state === 'starting' || st.state === 'error') && Array.isArray(st.logs) && st.logs.length) {
      const logPre = mkEl('pre', 'gal-voice-log', st.logs.slice(-4).join('\n'));
      srvCard.append(logPre);
    }
    body.append(srvCard);

    // 2. 全局开关与配音音量
    const optRow1 = mkEl('label', 'gal-setting-row');
    const enSpan = mkEl('span', '', '沉浸演出自动朗读');
    const enChk = mkEl('input', '');
    enChk.type = 'checkbox';
    enChk.checked = vc.isEnabled();
    enChk.onchange = () => {
      vc.setEnabled(enChk.checked);
      paintVoicePopover();
    };
    optRow1.append(enSpan, enChk);

    const optRow2 = mkEl('label', 'gal-setting-row');
    const volEm = mkEl('em', '', `${Math.round(snap.volume * 100)}%`);
    const volSpan = mkEl('span', '', '角色配音音量 ');
    volSpan.append(volEm);
    const volRange = mkEl('input', '');
    volRange.type = 'range';
    volRange.min = '0.1';
    volRange.max = '1';
    volRange.step = '0.05';
    volRange.value = String(snap.volume);
    volRange.oninput = () => {
      const v = parseFloat(volRange.value) || 0.95;
      volEm.textContent = `${Math.round(v * 100)}%`;
      vc.setVolume(v);
    };
    optRow2.append(volSpan, volRange);

    const optRow3 = mkEl('label', 'gal-setting-row');
    const moodSpan = mkEl('span', '', '16 情绪微表情语气联动');
    const moodChk = mkEl('input', '');
    moodChk.type = 'checkbox';
    moodChk.checked = cfg.moodDirection !== false;
    moodChk.onchange = async () => {
      moodChk.disabled = true;
      try {
        await vc.saveConfig({ moodDirection: moodChk.checked });
        showMiniToast(moodChk.checked ? '已开启 16 情绪语气导演联动' : '已关闭情绪语气变调');
      } catch (err) {
        showMiniToast(err?.message || '保存失败');
      }
      paintVoicePopover();
    };
    optRow3.append(moodSpan, moodChk);
    body.append(optRow1, optRow2, optRow3);

    // 3. 角色专属声线配置区
    const botBox = mkEl('div', 'gal-voice-card');
    const botSelRow = mkEl('div', 'gal-voice-field-row');
    const botSel = mkEl('select', 'gal-voice-input');
    let hasSelected = false;
    for (const [bid, label] of VOICE_BOT_OPTIONS) {
      const op = mkEl('option', '', label);
      op.value = bid;
      if (bid === targetBotId) { op.selected = true; hasSelected = true; }
      botSel.append(op);
    }
    if (!hasSelected && targetBotId) {
      const customOp = mkEl('option', '', `当前角色 (${targetBotId})`);
      customOp.value = targetBotId;
      customOp.selected = true;
      botSel.append(customOp);
    }
    botSel.onchange = () => {
      galVoiceSelectedBotId = botSel.value;
      paintVoicePopover();
    };
    botSelRow.append(mkEl('span', 'gal-voice-lbl', '配置角色'), botSel);

    const voiceSelRow = mkEl('div', 'gal-voice-field-row');
    const voiceSel = mkEl('select', 'gal-voice-input');
    const optDesign = mkEl('option', '', '✨ 文字描述自动设计音色（开箱即用）');
    optDesign.value = '';
    if (!curVoiceId) optDesign.selected = true;
    voiceSel.append(optDesign);
    for (const v of voices) {
      const op = mkEl('option', '', `🎙 ${v.id}${v.description ? ` · ${v.description.slice(0, 14)}` : ''}`);
      op.value = v.id;
      if (v.id === curVoiceId) op.selected = true;
      voiceSel.append(op);
    }
    if (curVoiceId && !voices.some((v) => v.id === curVoiceId)) {
      const missOp = mkEl('option', '', `🎙 ${curVoiceId}（已绑定）`);
      missOp.value = curVoiceId;
      missOp.selected = true;
      voiceSel.append(missOp);
    }
    voiceSelRow.append(mkEl('span', 'gal-voice-lbl', '绑定音色'), voiceSel);

    const insArea = mkEl('textarea', 'gal-voice-textarea');
    insArea.rows = 2;
    insArea.value = curInstruction;
    insArea.placeholder = '用一句中文描述角色声线（年龄、音色质感、语速、气质）…';

    const cfgRow = mkEl('label', 'gal-setting-row');
    const cfgEm = mkEl('em', '', curCfgScale.toFixed(1));
    const cfgLbl = mkEl('span', '', '情绪表现力 cfg ');
    cfgLbl.append(cfgEm);
    const cfgRange = mkEl('input', '');
    cfgRange.type = 'range';
    cfgRange.min = '1.0';
    cfgRange.max = '3.0';
    cfgRange.step = '0.1';
    cfgRange.value = String(curCfgScale);
    cfgRange.oninput = () => {
      cfgEm.textContent = (parseFloat(cfgRange.value) || 1.5).toFixed(1);
    };
    cfgRow.append(cfgLbl, cfgRange);

    const botActions = mkEl('div', 'gal-voice-srv-btns');
    const previewBtn = mkEl('button', 'gal-voice-btn is-primary', '🔊 试听一句');
    previewBtn.type = 'button';
    previewBtn.onclick = async () => {
      previewBtn.disabled = true;
      previewBtn.textContent = '合成试听中…';
      try {
        const res = await vc.previewVoice({
          botId: targetBotId,
          text: defProf.previewLine || '',
          mood: galState.mood || 'happy',
          voiceId: voiceSel.value,
          instruction: insArea.value.trim(),
          cfgScale: parseFloat(cfgRange.value) || 1.5,
          seed: curSeed,
        });
        if (!res.ok && !res.aborted) {
          showMiniToast(res.offline ? '请先点击上方「▶ 一键启动 Breeze 引擎」' : (res.error || '试听失败'));
        }
      } finally {
        previewBtn.disabled = false;
        previewBtn.textContent = '🔊 试听一句';
      }
    };

    const saveBotBtn = mkEl('button', 'gal-voice-btn', '保存该角色音色');
    saveBotBtn.type = 'button';
    saveBotBtn.onclick = async () => {
      saveBotBtn.disabled = true;
      try {
        await vc.saveConfig({
          bots: {
            [targetBotId]: {
              voiceId: voiceSel.value,
              instruction: insArea.value.trim(),
              cfgScale: parseFloat(cfgRange.value) || 1.5,
              seed: curSeed,
              enabled: true,
            },
          },
        });
        showMiniToast('✦ 角色音色配置已保存并生效');
      } catch (err) {
        showMiniToast(err?.message || '保存角色音色失败');
      }
      paintVoicePopover();
    };

    const resetBotBtn = mkEl('button', 'gal-voice-btn', '恢复默认');
    resetBotBtn.type = 'button';
    resetBotBtn.onclick = async () => {
      try {
        await vc.saveConfig({ bots: { [targetBotId]: null } });
        showMiniToast('已恢复该角色内置默认音色');
      } catch (err) {
        showMiniToast(err?.message || '恢复失败');
      }
      paintVoicePopover();
    };
    botActions.append(previewBtn, saveBotBtn, resetBotBtn);
    botBox.append(botSelRow, voiceSelRow, insArea, cfgRow, botActions);
    body.append(botBox);

    // 4. 高级连接与目录设置（可折叠）
    const advToggle = mkEl('button', 'gal-voice-adv-toggle', `${voiceAdvOpen ? '▾' : '▸'} 服务地址与本机目录高级设置`);
    advToggle.type = 'button';
    advToggle.onclick = () => {
      voiceAdvOpen = !voiceAdvOpen;
      paintVoicePopover();
    };
    body.append(advToggle);

    if (voiceAdvOpen) {
      const advCard = mkEl('div', 'gal-voice-card');
      const epInp = mkEl('input', 'gal-voice-input');
      epInp.value = cfg.endpoint || 'http://127.0.0.1:8080';
      epInp.placeholder = 'http://127.0.0.1:8080';
      const dirInp = mkEl('input', 'gal-voice-input');
      dirInp.value = cfg.localDir || install.rootDir || 'G:\\breeze-cpp';
      dirInp.placeholder = 'G:\\breeze-cpp';
      const cpuRow = mkEl('label', 'gal-setting-row');
      const cpuChk = mkEl('input', '');
      cpuChk.type = 'checkbox';
      cpuChk.checked = Boolean(cfg.useCpu);
      cpuRow.append(mkEl('span', '', '显卡异常时回退 CPU 推理（--cpu）'), cpuChk);
      const saveAdvBtn = mkEl('button', 'gal-voice-btn', '保存服务设置');
      saveAdvBtn.type = 'button';
      saveAdvBtn.onclick = async () => {
        saveAdvBtn.disabled = true;
        try {
          await vc.saveConfig({
            endpoint: epInp.value.trim(),
            localDir: dirInp.value.trim(),
            useCpu: cpuChk.checked,
          });
          showMiniToast('✦ 服务地址与目录设置已保存');
        } catch (err) {
          showMiniToast(err?.message || '保存失败');
        }
        paintVoicePopover();
      };
      advCard.append(
        mkEl('span', 'gal-voice-lbl', 'Breeze 服务地址'),
        epInp,
        mkEl('span', 'gal-voice-lbl', '本机 Breeze 目录'),
        dirInp,
        cpuRow,
        saveAdvBtn
      );
      body.append(advCard);
    }
  };

  const openVoicePopover = () => {
    galVoiceSelectedBotId = (galState.isGroupChat ? galState.activeSpeakerId : galState.botId) || galVoiceSelectedBotId || 'ai-gemini';
    paintVoicePopover();
    const vc = ensureVoiceController();
    vc.refreshStatus({ includeVoices: true }).then((st) => {
      if (!galState.els.voicePopover?.hidden) paintVoicePopover();
      if (st?.state === 'starting' && !galVoicePollTimer) {
        galVoicePollTimer = setInterval(async () => {
          const nextSt = await vc.refreshStatus({ includeVoices: true });
          if (!galState.els.voicePopover?.hidden) paintVoicePopover();
          if (!nextSt || nextSt.state !== 'starting') stopVoiceStatusPolling();
        }, 1500);
      }
    }).catch(() => {});
  };

  let bgmUploadSlot = 'night';
  const paintBgmPopover = () => {
    const body = galState.els.bgmBody;
    const badge = galState.els.bgmBadge;
    if (!body) return;
    const bgm = ensureBgmController();
    const snap = bgm.getSnapshot();
    if (badge) badge.textContent = snap.enabled ? (snap.ducked ? '配音自动压低中' : '播放中') : '已静音';
    body.innerHTML = `
      <label class="gal-setting-row">
        <span>开启沉浸氛围 BGM</span>
        <input type="checkbox" id="galBgmEnableChk" ${snap.enabled ? 'checked' : ''}>
      </label>
      <label class="gal-setting-row">
        <span>随旁白情绪自动切换曲风</span>
        <input type="checkbox" id="galBgmAutoChk" ${snap.autoSwitch ? 'checked' : ''}>
      </label>
      <label class="gal-setting-row">
        <span>配音发声时自动压低 BGM</span>
        <input type="checkbox" id="galBgmDuckChk" ${snap.duckOnVoice !== false ? 'checked' : ''}>
      </label>
      <label class="gal-setting-row">
        <span>BGM 音量 <em>${Math.round(snap.volume * 100)}%</em></span>
        <input type="range" id="galBgmVolRng" min="0.05" max="1" step="0.05" value="${snap.volume}">
      </label>
      <div class="gal-bgm-tracks">
        ${BGM_TRACKS.map((t) => {
          const isCur = snap.trackId === t.id;
          const customName = snap.customNames[t.id] || '';
          return `<div class="gal-bgm-track-row${isCur ? ' is-active' : ''}" data-bgm-slot="${t.id}">
            <button type="button" class="gal-bgm-track-pick" data-bgm-act="pick">
              <strong>${t.label}${isCur && snap.enabled ? ' · 播放中' : ''}</strong>
              <span>${customName ? `本地音轨：${escapeText(customName)}` : t.desc}</span>
            </button>
            <button type="button" class="gal-bgm-mini-btn" data-bgm-act="upload" title="导入本地 MP3/OGG 替换此槽位">导入</button>
            ${customName ? '<button type="button" class="gal-bgm-mini-btn" data-bgm-act="clear" title="恢复内置氛围音轨">恢复</button>' : ''}
          </div>`;
        }).join('')}
      </div>
    `;
    body.querySelector('#galBgmEnableChk')?.addEventListener('change', (e) => {
      bgm.setEnabled(Boolean(e.target.checked));
      paintBgmPopover();
    });
    body.querySelector('#galBgmAutoChk')?.addEventListener('change', (e) => {
      bgm.setAutoSwitch(Boolean(e.target.checked));
    });
    body.querySelector('#galBgmDuckChk')?.addEventListener('change', (e) => {
      bgm.setDuckOnVoice(Boolean(e.target.checked));
    });
    body.querySelector('#galBgmVolRng')?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value) || 0.38;
      bgm.setVolume(v);
      const em = body.querySelector('label em');
      if (em) em.textContent = `${Math.round(v * 100)}%`;
    });
    body.querySelectorAll('[data-bgm-act]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const slot = btn.closest('[data-bgm-slot]')?.dataset.bgmSlot;
        const act = btn.dataset.bgmAct;
        if (!slot) return;
        if (act === 'pick') {
          bgm.setTrack(slot, { manual: true });
          if (!bgm.getSnapshot().enabled) bgm.setEnabled(true);
          paintBgmPopover();
        } else if (act === 'upload') {
          bgmUploadSlot = slot;
          galState.els.bgmFileInput?.click();
        } else if (act === 'clear') {
          await bgm.clearCustomTrack(slot);
          showMiniToast('已恢复内置氛围音轨');
          paintBgmPopover();
        }
      });
    });
  };
  galState.els.bgmFileInput?.addEventListener('change', async () => {
    const file = galState.els.bgmFileInput?.files?.[0];
    if (galState.els.bgmFileInput) galState.els.bgmFileInput.value = '';
    if (!file) return;
    try {
      await ensureBgmController().uploadCustomTrack(bgmUploadSlot, file);
      ensureBgmController().setTrack(bgmUploadSlot, { manual: true });
      ensureBgmController().setEnabled(true);
      showMiniToast(`已导入本地 BGM「${file.name}」`);
      paintBgmPopover();
    } catch {
      showMiniToast('导入音频失败，请确认文件格式有效');
    }
  });

  // Bottom bar text buttons
  const bindPopover = (btn, pop, onOpen) => {
    btn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const opening = pop.hidden;
      closePopovers();
      if (opening) {
        if (typeof onOpen === 'function') onOpen();
        pop.hidden = false;
        btn.classList.add('is-active');
      }
    });
  };
  bindPopover(galState.els.bgBtn, galState.els.bgPopover);
  bindPopover(galState.els.bgmPickerBtn, galState.els.bgmPopover, paintBgmPopover);
  bindPopover(galState.els.moodBtn, galState.els.moodPopover, syncMoodPopoverForCurrentChar);
  bindPopover(galState.els.modelBtn, galState.els.modelPopover, renderModelPopover);
  bindPopover(galState.els.voicePickerBtn, galState.els.voicePopover, openVoicePopover);
  bindPopover(galState.els.settingsBtn, galState.els.settingsPopover);

  galState.els.moodGrid?.addEventListener('click', (e) => {
    const btn = e.target.closest('.gal-mood-pill');
    if (!btn) return;
    if (galState.els.pixelActionsGrid) {
      for (const b of galState.els.pixelActionsGrid.querySelectorAll('.gal-pixel-act-btn')) {
        b.classList.remove('is-active');
      }
    }
    setMood(btn.dataset.mood, { animate: true, force: true });
  });
  galState.els.eggBar?.addEventListener('click', (e) => {
    const btn = e.target.closest('.gal-egg-btn');
    if (!btn) return;
    triggerEasterEggAction(btn.dataset.egg);
  });

  // Toggle zoom: half <-> full (preserve active speaker nameplate & scroll offset!)
  galState.els.zoomBtn?.addEventListener('click', () => {
    galState.zoom = galState.zoom === 'half' ? 'full' : 'half';
    writePref(STORAGE_KEYS.zoom, galState.zoom);
    applyAppearanceSettings();
    if (galState.els.stage) {
      galState.els.stage.scrollTop = 0;
      galState.els.stage.scrollLeft = 0;
    }
    playGalSfx('switch');
    galState.els.zoomBtn.textContent = galState.zoom === 'full' ? '镜头·全身' : '镜头·半身';
  });

  galState.els.logBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    closePopovers();
    openBacklog();
  });
  galState.els.backlogSearch?.addEventListener('input', () => {
    galState.backlogQuery = galState.els.backlogSearch.value || '';
    renderBacklogItems(galState.historyEntries, galState.backlogQuery);
  });
  galState.els.backlogSearch?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      galState.els.backlogOverlay.hidden = true;
    }
  });
  galState.els.backlogClose?.addEventListener('click', (e) => {
    e.stopPropagation();
    galState.els.backlogOverlay.hidden = true;
  });
  galState.els.backlogOverlay?.addEventListener('click', (e) => {
    if (e.target === galState.els.backlogOverlay) {
      e.stopPropagation();
      galState.els.backlogOverlay.hidden = true;
    }
  });

  // Exit button (bottom-right pink bubble ×)
  const exitImmersive = () => {
    if (galState.autoPlay) setAutoPlay(false, { silent: true });
    galState.enabled = false;
    applyStageVisibility();
  };
  galState.els.exitBtn?.addEventListener('click', exitImmersive);
  galState.els.drawerExitBtn?.addEventListener('click', exitImmersive);

  // Top-right fold tab & drawer
  galState.els.sideTab?.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = galState.els.sideDrawer.hidden;
    closePopovers();
    if (opening) {
      syncThinkingDrawerState();
      galState.els.sideDrawer.hidden = false;
    }
  });
  galState.els.drawerThinkBtn?.addEventListener('click', () => {
    document.getElementById('chatThinkingToggle')?.click();
    setTimeout(syncThinkingDrawerState, 60);
  });
  galState.els.drawerHideBtn?.addEventListener('click', () => setUiHidden(true));

  // Settings controls
  galState.els.optFaceWin?.addEventListener('change', () => {
    galState.faceWindowEnabled = Boolean(galState.els.optFaceWin.checked);
    writePref(STORAGE_KEYS.faceWindow, galState.faceWindowEnabled ? '1' : '0');
    applyAppearanceSettings();
  });
  galState.els.optSpeedSeg?.addEventListener('click', (e) => {
    const btn = e.target.closest('.gal-speed-opt');
    if (!btn) return;
    const speed = btn.dataset.speed;
    if (!['slow', 'normal', 'fast', 'instant'].includes(speed)) return;
    galState.typingSpeed = speed;
    writePref(STORAGE_KEYS.typingSpeed, speed);
    for (const b of galState.els.optSpeedSeg.querySelectorAll('.gal-speed-opt')) {
      b.classList.toggle('is-selected', b.dataset.speed === speed);
    }
    playGalSfx('switch');
  });
  galState.els.optSfxVol?.addEventListener('input', () => {
    galState.sfxVolume = Math.max(0.2, Math.min(2.0, parseFloat(galState.els.optSfxVol.value) || 1.0));
    writePref(STORAGE_KEYS.sfxVolume, String(galState.sfxVolume));
    if (galState.els.optVolVal) galState.els.optVolVal.textContent = `${Math.round(galState.sfxVolume * 100)}%`;
    playGalSfx('tick');
  });
  galState.els.optAutoDelay?.addEventListener('input', () => {
    galState.autoDelayMs = Math.max(800, Math.min(4500, parseInt(galState.els.optAutoDelay.value, 10) || 2000));
    writePref(STORAGE_KEYS.autoDelayMs, String(galState.autoDelayMs));
    if (galState.els.optAutoVal) galState.els.optAutoVal.textContent = `${(galState.autoDelayMs / 1000).toFixed(1)}s`;
  });
  galState.els.optOpacity?.addEventListener('input', () => {
    galState.boxOpacity = parseFloat(galState.els.optOpacity.value) || 0.86;
    writePref(STORAGE_KEYS.boxOpacity, String(galState.boxOpacity));
    applyAppearanceSettings();
  });
  galState.els.optFontSize?.addEventListener('input', () => {
    galState.fontSize = parseInt(galState.els.optFontSize.value, 10) || 21;
    writePref(STORAGE_KEYS.fontSize, String(galState.fontSize));
    applyAppearanceSettings();
  });

  const applyCustomBgFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxW = 1600;
        const scale = img.width > maxW ? (maxW / img.width) : 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
        galState.customBg = dataUrl;
        galState.bgId = 'custom';
        writePref(STORAGE_KEYS.bgId, 'custom');
        buildBgGrid(galState.els.bgGrid);
        applyBackground(dataUrl);
        if (isPixelStageMode()) syncPixelTheaterBackdrop();
        playGalSfx('switch');
        void idbSetCustomBg(dataUrl).then(() => {
          try { localStorage.removeItem(STORAGE_KEYS.customBg); } catch {}
          showMiniToast('自定义背景已保存（高清持久化存储）');
        }).catch(() => {
          showMiniToast('背景已临时应用，但本地存储空间不足未能持久化');
        });
      };
      img.onerror = () => showMiniToast('无法解析该图片文件，请更换格式重试');
      img.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  };

  // 初始化欧式分层像素剧院舞台控制器（默认按偏好挂载，闲置时零 RAF 消耗）
  galState.pixelCtrl = createPixelTheaterController(stage, {
    onCurtainChange: (openVal) => {
      if (galState.els.curtainBtn) {
        galState.els.curtainBtn.textContent = openVal >= 0.5 ? '合幕' : '开幕';
      }
    },
    onActorClick: (botId, name) => {
      if (galState.uiHidden) {
        setUiHidden(false);
        return;
      }
      closePopovers();
      if (!galState.isGroupChat) return;
      if (hasPendingStoryFork() && !galState.story.collapsed) {
        galState.story.collapsed = true;
        renderGalStoryUI();
      }
      if (galState.turn !== 'user') setTurn('user');
      const field = galState.els.turnTextarea;
      if (field && name) {
        const mention = `@${name} `;
        if (!field.value.includes(mention)) {
          field.value = `${field.value}${field.value && !field.value.endsWith(' ') ? ' ' : ''}${mention}`;
          field.dispatchEvent(new Event('input', { bubbles: true }));
        }
        field.focus();
      }
    },
    onDropCustomBackdrop: (file) => applyCustomBgFile(file),
  });
  if (galState.pixelCtrl) {
    galState.pixelCtrl.setQuality(galState.pixelQuality);
    galState.pixelCtrl.setMotionEnabled(galState.motionEnabled);
    syncPixelTheaterBackdrop();
  }

  // 舞台模式切换（2.5D 立绘舞台 <-> 欧式分层像素剧院）与帷幕/动作控制
  const toggleStageMode = (e) => {
    e?.stopPropagation();
    closePopovers();
    setStageMode(isPixelStageMode() ? 'gal' : 'pixel');
  };
  galState.els.stageModeBtn?.addEventListener('click', toggleStageMode);
  galState.els.drawerStageModeBtn?.addEventListener('click', toggleStageMode);
  galState.els.curtainBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!galState.pixelCtrl || !isPixelStageMode()) return;
    const next = galState.pixelCtrl.toggleCurtain();
    playGalSfx('switch');
    showMiniToast(next < 0.5 ? '正在合拢剧场红丝绒大幕…' : '正在拉开剧场红丝绒大幕…');
  });
  galState.els.pixelActionsGrid?.addEventListener('click', (e) => {
    const btn = e.target.closest('.gal-pixel-act-btn');
    if (!btn || !galState.pixelCtrl || !isPixelStageMode()) return;
    e.stopPropagation();
    const actKey = btn.dataset.pixelAct;
    const targetId = galState.isGroupChat ? 'all' : (galState.botId || '');
    const ok = galState.pixelCtrl.triggerActorAction(targetId, actKey, { durationMs: 0 });
    if (ok) {
      playGalSfx('switch');
      for (const b of galState.els.pixelActionsGrid.querySelectorAll('.gal-pixel-act-btn')) {
        b.classList.toggle('is-active', b === btn);
      }
      showMiniToast(`像素剧院动作演播：${btn.textContent}`);
    } else {
      showMiniToast('当前角色暂未配备像素动作包，DeepSeek 与 Gemini 已支持全套 29 动作');
    }
  });
  galState.els.optPixelQualityChk?.addEventListener('change', () => {
    galState.pixelQuality = galState.els.optPixelQualityChk.checked ? 'hd' : 'pixel';
    writePref(STORAGE_KEYS.pixelQuality, galState.pixelQuality);
    if (galState.pixelCtrl) {
      galState.pixelCtrl.setQuality(galState.pixelQuality);
      syncPixelTheaterBackdrop();
    }
    if (galState.els.bgGrid) buildBgGrid(galState.els.bgGrid);
    showMiniToast(galState.pixelQuality === 'hd' ? '已切换至高清原画幕布' : '已切换至 Hi-Bit 软像素幕布');
  });

  // Custom local background upload (stored in IndexedDB to avoid 5MB localStorage silent failure)
  galState.els.uploadBgBtn?.addEventListener('click', () => galState.els.bgFileInput?.click());
  galState.els.bgFileInput?.addEventListener('change', () => {
    const file = galState.els.bgFileInput.files?.[0];
    galState.els.bgFileInput.value = '';
    applyCustomBgFile(file);
  });

  syncPixelTheaterControls();
  applyStageVisibility();
}

function applyStoryConfigSnapshot(storyConfig) {
  const sc = storyConfig && typeof storyConfig === 'object' ? storyConfig : null;
  const enabled = Boolean(galState.isGroupChat && sc?.enabled);
  galState.story.enabled = enabled;
  if (!enabled) {
    galState.story.worldline = '主线';
    galState.story.chapter = 0;
    galState.story.pendingFork = null;
    galState.story.forkKey = '';
    galState.story.collapsed = false;
    galState.story.submitting = false;
    galState.story.storyBible = '';
    galState.story.secretNotesCount = 0;
    galState.story.innerVoiceEnabled = false;
    galState.story.diceMode = false;
    galState.story.autoDirectorFx = true;
    galState.story.nodesCount = 0;
    galState.story.cgsCount = 0;
    galState.story.hasEnding = false;
    galState.story.lastStageCueKey = '';
    galState.story.lastStageCue = null;
    galState.story.pendingStageCue = null;
    if (galState.els.directorFxLayer) {
      galState.els.directorFxLayer.dataset.mood = '';
      galState.els.directorFxLayer.classList.remove('fx-rain', 'fx-petals', 'fx-flash');
    }
    return;
  }
  const nodes = Array.isArray(sc.nodes) ? sc.nodes : [];
  galState.story.worldline = sc.worldline || '主线';
  galState.story.chapter = Number(sc.chapterCounter || nodes.length || 0);
  galState.story.storyBible = String(sc.storyBible || '');
  galState.story.secretNotesCount = sc.secretNotes && typeof sc.secretNotes === 'object'
    ? Object.values(sc.secretNotes).filter((v) => String(v || '').trim()).length
    : 0;
  galState.story.innerVoiceEnabled = Boolean(sc.innerVoiceEnabled);
  galState.story.diceMode = Boolean(sc.diceMode);
  galState.story.autoDirectorFx = sc.autoDirectorFx !== false;
  galState.story.nodesCount = nodes.length;
  galState.story.cgsCount = Array.isArray(sc.cgs) ? sc.cgs.length : 0;
  galState.story.hasEnding = Boolean(sc.endingCard && sc.endingCard.title);

  const cue = sc.lastStageCue && typeof sc.lastStageCue === 'object' ? sc.lastStageCue : null;
  if (galState.story.autoDirectorFx && cue && (cue.scene || cue.mood || cue.fx)) {
    const cueKey = `${galState.story.chapter}|${cue.scene || ''}|${cue.mood || ''}|${cue.fx || ''}`;
    const isNewCue = cueKey !== galState.story.lastStageCueKey;
    galState.story.lastStageCueKey = cueKey;
    galState.story.lastStageCue = cue;
    // 若剧场队列还有尚未翻到的旧句，绝不随后台聊天框消息抢先切场景/特效，暂存至剧场推进到位再切！
    if (galState.enabled && galState.isGroupChat && unreadLines() > 0) {
      galState.story.pendingStageCue = cue;
    } else {
      galState.story.pendingStageCue = null;
      applyDirectorStageCue(cue, { animateFx: isNewCue });
    }
  } else if (!galState.story.autoDirectorFx && galState.els.directorFxLayer) {
    galState.story.pendingStageCue = null;
    galState.els.directorFxLayer.dataset.mood = '';
    galState.els.directorFxLayer.classList.remove('fx-rain', 'fx-petals', 'fx-flash');
  }

  const pf = sc.pendingFork;
  const choices = Array.isArray(pf?.choices)
    ? pf.choices.filter((c) => c && String(c.label || '').trim()).map((c, idx) => ({
        id: String(c.id || String.fromCharCode(65 + idx)),
        label: String(c.label || '').trim(),
      }))
    : [];
  if (choices.length > 0 && !galState.story.submitting) {
    const prompt = String(pf?.prompt || '').trim();
    const nextKey = JSON.stringify([prompt, choices]);
    if (nextKey !== galState.story.forkKey) {
      galState.story.forkKey = nextKey;
      galState.story.collapsed = false;
    }
    galState.story.pendingFork = { prompt, choices };
  } else if (choices.length === 0) {
    galState.story.pendingFork = null;
    galState.story.forkKey = '';
    galState.story.collapsed = false;
  }
}

export function syncGalgameStoryState(storyConfig = null) {
  const prevForkKey = galState.story.forkKey;
  applyStoryConfigSnapshot(storyConfig);
  if (galState.enabled && galState.isGroupChat) {
    const isFreshFork = Boolean(galState.story.pendingFork && galState.story.forkKey && galState.story.forkKey !== prevForkKey);
    if (isFreshFork && galState.turn === 'user' && isAtGroupQueueEnd()) {
      const draft = String(galState.els.turnTextarea?.value || '').trim();
      if (!draft) {
        galState.story.collapsed = false;
        setTurn('bot');
      } else {
        galState.story.collapsed = true;
      }
    }
    if (galState.story.pendingFork && galState.autoPlay) {
      setAutoPlay(false, { silent: true });
      showMiniToast('遇到命运抉择，已自动暂停 AUTO');
    }
    renderGalStoryUI();
    updateNextPrompt({ streaming: false });
  }
}

export function syncGalgameContext({
  botId = '',
  botName = '',
  avatarUrl = '',
  isSoloChat = false,
  isGroupChat = false,
  groupId = '',
  groupName = '',
  members = [],
  storyConfig = null,
} = {}) {
  const nextGroup = Boolean(isGroupChat && groupId);
  const nextSolo = !nextGroup && Boolean(isSoloChat && botId);
  const modeChanged = nextGroup !== galState.isGroupChat || nextSolo !== galState.isSoloChat;
  const botChanged = !nextGroup && botId !== galState.botId;
  const groupChanged = nextGroup && groupId !== galState.groupId;

  galState.botId = botId;
  galState.botName = botName || botId || '伙伴';
  galState.avatarUrl = avatarUrl || '';
  galState.isSoloChat = nextSolo;
  galState.isGroupChat = nextGroup;
  galState.groupId = nextGroup ? groupId : '';
  galState.groupName = nextGroup ? (groupName || groupId) : '';
  galState.groupMembers = nextGroup && Array.isArray(members) ? members : [];

  if (modeChanged || botChanged || groupChanged) {
    galState.mood = 'neutral';
    galState.listeningMood = '';
    galState.speaking = false;
    galState.streamActive = false;
    galState.replyQueue = [];
    galState.replyIndex = 0;
    galState.groupQueue = [];
    galState.groupQueueIndex = -1;
    galState.replacementCursor = 0;
    galState.castOrder = nextGroup ? galState.groupMembers.slice(0, 5).map((m) => m.id) : [];
    galState.memberMoods = {};
    galState.activeSpeakerId = '';
    galState.activeSpeakerName = '';
    galState.typingMemberId = '';
    galState.typingMemberName = '';
    galState.historyCursor = -1;
    galState.story.pendingFork = null;
    galState.story.forkKey = '';
    galState.story.collapsed = false;
    galState.story.submitting = false;
    if (galState.els.groupCast) galState.els.groupCast.innerHTML = '';
    if (galState.autoPlay) setAutoPlay(false, { silent: true });
    resetPerformance();
  } else if (nextGroup) {
    // Keep existing castOrder, append any newly invited members if room permits
    const validSet = new Set(galState.groupMembers.map((m) => m.id));
    galState.castOrder = galState.castOrder.filter((id) => validSet.has(id));
    for (const m of galState.groupMembers) {
      if (galState.castOrder.length >= 5) break;
      if (!galState.castOrder.includes(m.id)) galState.castOrder.push(m.id);
    }
  }
  applyStoryConfigSnapshot(nextGroup ? storyConfig : null);
  if (!nextSolo && !nextGroup) galState.enabled = false;
  applyStageVisibility({ forceSync: modeChanged || botChanged || groupChanged });
}

export function onGalgameGroupTyping(botId = '', botName = '') {
  if (!galState.isGroupChat) return;
  galState.typingMemberId = botId || '';
  galState.typingMemberName = botName || botId || '';
  if (galState.enabled) updateGroupTypingPill();
}

export function onGalgameGroupMessage({ messageId = '', from = '', speakerName = '', text = '', history = false, isNarrator = false } = {}) {
  if (!galState.isGroupChat) return;
  const raw = String(text || '').trim();
  if (!raw) return;
  if (from === 'user') {
    if (!history) {
      galState.historyCursor = -1;
      if (!galState.enabled) return;
      if (galState.groupQueueIndex >= 0) {
        showGroupQueueItem(galState.groupQueueIndex, { animate: false });
        return;
      }
      if (galState.enabled && galState.turn === 'user') {
        setTurn('bot');
        renderDialogueContent('……大家正在听你说话……', { streaming: false, speaker: galState.groupName || '群聊' });
      }
    }
    return;
  }

  if (galState.typingMemberId === from) {
    galState.typingMemberId = '';
    galState.typingMemberName = '';
    updateGroupTypingPill();
  }

  if (history) {
    return;
  }

  const parsed = parsePerformanceBeats(raw);
  const lastBeat = parsed.beats[parsed.beats.length - 1];
  const cleanText = normalizeLineEndings(stripMoodTag(isNarrator ? raw.replace(/^【旁白】\s*/, '') : raw)).trim();
  if (!cleanText) return;
  const mood = lastBeat ? lastBeat.mood : inferMoodFromTone(cleanText);
  const item = {
    messageId,
    speakerId: isNarrator ? '' : from,
    speakerName: isNarrator ? '✦ 旁白' : (speakerName || from),
    raw,
    clean: cleanText,
    mood,
    isNarrator: Boolean(isNarrator || from === 'system'),
  };

  if (!galState.enabled) {
    galState.groupQueue.push(item);
    if (galState.groupQueue.length > 20) galState.groupQueue.shift();
    galState.groupQueueIndex = galState.groupQueue.length - 1;
    return;
  }

  // Deduplicate rapid duplicate SSE/EventSource delivery of the exact same speaker + text
  const lastQueued = galState.groupQueue[galState.groupQueue.length - 1];
  if (messageId ? galState.groupQueue.some(line => line.messageId === messageId) : lastQueued && lastQueued.speakerId === item.speakerId && normSegKey(lastQueued.clean) === normSegKey(item.clean)) {
    return;
  }

  galState.groupQueue.push(item);
  if (galState.groupQueue.length === 1) rememberGroupLine(messageId, true);
  renderGalStoryUI();
  updateNextPrompt({ streaming: false });
  scheduleAutoAdvance();
}

export function onGalgameUserMessage(text) {
  if (!galState.isSoloChat) return;
  galVoiceTurnSeq += 1;
  galState.historyCursor = -1;
  galState.replyQueue = [];
  galState.replyIndex = 0;
  galState.streamActive = false;
  resetPerformance();
  galState.listeningMood = '';
  if (galState.enabled) {
    galState.speaking = true;
    setTurn('bot');
    renderDialogueContent('', { thinking: true, streaming: true, speaker: galState.botName });
  }
}

export function notifyGalgameNotice(msg) {
  if (!galState.enabled || !msg) return;
  showMiniToast(String(msg));
}

export function onGalgameStream(phase, fullText = '') {
  if (!galState.enabled || !galState.isSoloChat) return;
  if (phase === 'lookup') {
    const q = String(fullText || '').trim();
    if (q) showMiniToast(`✦ ${galState.botName || '伙伴'} 悄悄查了下「${q}」…`);
    return;
  }
  if (galState.turn === 'user') setTurn('bot');
  galState.streamActive = true;
  if (phase === 'thinking' && !fullText) {
    galState.speaking = true;
    renderDialogueContent('', { thinking: true, streaming: true, speaker: galState.botName });
    return;
  }

  const parsed = parsePerformanceBeats(fullText);
  if (parsed.pendingTag && !parsed.beats.length) return;
  if (!parsed.beats.length) return;

  galState.speaking = true;
  galState.perf.rawSource = fullText;
  galState.perf.beats = parsed.beats;
  galState.perf.speakerId = galState.botId || '';
  galState.perf.isNarrator = false;
  ensureVoiceController().feedTurnBeats({
    turnKey: `solo:${galState.botId}:${galVoiceTurnSeq}`,
    botId: galState.botId,
    beats: parsed.beats,
    streamActive: true,
  });

  if (galState.perf.skipped) {
    fastForwardPerformance();
    return;
  }

  // Only start or wake the performance loop if idle or awaiting more tokens;
  // during active typing or sentence-end pausing, let the beat timer finish cleanly!
  if (galState.perf.phase === 'idle' || galState.perf.phase === 'waiting_stream' || galState.perf.phase === 'done') {
    stepPerformance();
  }
}

function normSegKey(s) {
  return String(s || '').replace(/\s+/g, '');
}

export function onGalgameMessage(role, text, { history = false } = {}) {
  if (!galState.isSoloChat || role !== 'assistant') return;
  galState.listeningMood = '';
  galState.historyCursor = -1;

  if (history) {
    galState.speaking = false;
    galState.streamActive = false;
    if (galState.enabled) {
      syncFromTranscript();
    }
    return;
  }

  if (!galState.enabled) {
    galState.speaking = false;
    const prevRaw = galState.perf.rawSource;
    const merged = prevRaw ? `${prevRaw}\n${text}` : text;
    galState.perf.rawSource = merged;
    const parsed = parsePerformanceBeats(merged);
    galState.perf.beats = parsed.beats;
    galState.replyQueue = splitGalSegments(merged, { streaming: false });
    galState.replyIndex = Math.max(0, galState.replyQueue.length - 1);
    return;
  }

  galState.streamActive = false;
  const incomingKey = normSegKey(stripMoodTag(text));
  const currentKey = normSegKey(stripMoodTag(galState.perf.rawSource));
  const alreadyCovered = Boolean(incomingKey && currentKey && currentKey.includes(incomingKey));

  if (!alreadyCovered) {
    const previous = galState.perf.rawSource;
    const mergedRaw = previous && !text.startsWith(previous) ? `${previous}\n${text}` : text;
    galState.perf.rawSource = mergedRaw;
    const parsed = parsePerformanceBeats(mergedRaw);
    if (!parsed.beats.length) {
      galState.speaking = false;
      updateNextPrompt({ streaming: false });
      return;
    }
    galState.perf.beats = parsed.beats;
  }

  if (galState.turn === 'user') setTurn('bot');

  galState.perf.speakerId = galState.botId || '';
  galState.perf.isNarrator = false;

  ensureVoiceController().feedTurnBeats({
    turnKey: `solo:${galState.botId}:${galVoiceTurnSeq}`,
    botId: galState.botId,
    beats: galState.perf.beats,
    streamActive: false,
  });

  if (galState.perf.skipped) {
    fastForwardPerformance();
    return;
  }

  if (galState.perf.phase === 'typing' || galState.perf.phase === 'pausing') {
    // Let ongoing sentence pause and typing finish smoothly inside the same dialogue box!
    galState.speaking = true;
    updateNextPrompt({ streaming: true });
    return;
  }

  stepPerformance();
}

export function isGalgameActive() {
  return Boolean(galState.enabled && isImmersiveEligible());
}

export function setGalgameBackgroundUrl(url, title = '') {
  if (!url) return;
  galState.bgId = 'custom';
  galState.customBg = url;
  if (galState.enabled) {
    applyBackground(url);
    if (isPixelStageMode()) syncPixelTheaterBackdrop();
  }
  if (title) showMiniToast(`已切换场景背景：${title}`);
}

export function getGalgameCgSnapshot(fallbackGroup = null) {
  const bgUrl = (isPixelStageMode() && galState.pixelCtrl)
    ? (galState.pixelCtrl.getBackdropUrl() || resolveBgUrl(galState.bgId) || PRESET_BGS[0].url)
    : (resolveBgUrl(galState.bgId) || PRESET_BGS[0].url);
  const castSprites = [];
  const memberIds = galState.isGroupChat && galState.castOrder.length
    ? galState.castOrder.slice(0, 5)
    : (Array.isArray(fallbackGroup?.members) ? fallbackGroup.members.slice(0, 5) : []);
  for (const mid of memberIds) {
    const pack = SPRITE_PACKS[mid];
    if (!pack) continue;
    const mood = galState.memberMoods[mid] || 'neutral';
    const moodEntry = pack.moods?.[mood] || pack.moods?.neutral || { base: 'neutral' };
    const spriteUrl = pack.bases?.[moodEntry.base] || pack.bases?.neutral || '';
    if (spriteUrl) {
      castSprites.push({ id: mid, url: spriteUrl, active: mid === galState.activeSpeakerId });
    }
  }
  const curItem = galState.groupQueue[galState.groupQueueIndex];
  const caption = (galState.enabled && galState.els.dialogueText?.textContent)
    ? galState.els.dialogueText.textContent.replace(/^「|」$/g, '')
    : (curItem?.clean || '');
  const speaker = galState.enabled
    ? (galState.els.speakerName?.textContent || '')
    : (curItem?.speakerName || '');
  return { bgUrl, castSprites, caption, speaker };
}
