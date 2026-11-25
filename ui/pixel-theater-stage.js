/**
 * DimensionAgent 正式版 · 欧式分层像素剧院舞台引擎 (ESM)
 * - 6 层独立透明欧式剧院合成（独立可换幕景 / 暖金追光与飘尘 / 满底实木地板与 7 脚灯 / 像素演员层 / 双帘丝绒开合幕布 / 鎏金顶檐）
 * - DeepSeek（29 套）+ Gemini（29 套）+ Grok（29 套）共 87 套终极零频闪 14 帧真循环像素动画（其余角色自动高精立绘优雅同台兼容）
 * - Layer 3.5 命运抉择 4 块手举木牌（3 剧情选项 + 第 4 块原地书写自定义改写，真人高低错落与多频独立呼吸、不漏手）
 * - 零 Emoji / 严格 CSP 合规 / 闲置零开销（退出像素剧院自动停帧）
 */

const ASSET_ROOT = '/dimension-ui/pixel-theater';
const SPRITE_VER = 'v6-isnet-20261124';

const LAYER_ASSETS = {
  pixel: {
    valance: '/dimension-ui/pixel-theater/layers/pixel/valance_top.webp?v=9e445cb71b',
    curtainLeftOpen: '/dimension-ui/pixel-theater/layers/pixel/curtain_left_open.webp?v=4fd06c0fe7',
    curtainRightOpen: '/dimension-ui/pixel-theater/layers/pixel/curtain_right_open.webp?v=0b31780f5c',
    curtainLeftClosed: '/dimension-ui/pixel-theater/layers/pixel/curtain_left_closed.webp?v=e1cf8bdc46',
    curtainRightClosed: '/dimension-ui/pixel-theater/layers/pixel/curtain_right_closed.webp?v=8547833744',
    floor: '/dimension-ui/pixel-theater/layers/pixel/stage_floor.webp?v=e9cbc9848c',
  },
  hd: {
    valance: '/dimension-ui/pixel-theater/layers/hd/valance_top.webp?v=30d1e7a493',
    curtainLeftOpen: '/dimension-ui/pixel-theater/layers/hd/curtain_left_open.webp?v=008afd8ab3',
    curtainRightOpen: '/dimension-ui/pixel-theater/layers/hd/curtain_right_open.webp?v=ad6a06a293',
    curtainLeftClosed: '/dimension-ui/pixel-theater/layers/hd/curtain_left_closed.webp?v=c6cc0243cd',
    curtainRightClosed: '/dimension-ui/pixel-theater/layers/hd/curtain_right_closed.webp?v=bc15ba398e',
    floor: '/dimension-ui/pixel-theater/layers/hd/stage_floor.webp?v=fb8c53f7f1',
  },
};

const PROP_ASSETS = {
  pixel: {
    sign_a: '/dimension-ui/pixel-theater/props/pixel/sign_a.webp?v=c231da30ed',
    sign_b: '/dimension-ui/pixel-theater/props/pixel/sign_b.webp?v=8161ce70bc',
    sign_c: '/dimension-ui/pixel-theater/props/pixel/sign_c.webp?v=84347d7162',
    sign_d: '/dimension-ui/pixel-theater/props/pixel/sign_d.webp?v=341797874c',
  },
  hd: {
    sign_a: '/dimension-ui/pixel-theater/props/hd/sign_a.webp?v=51b9d7afb9',
    sign_b: '/dimension-ui/pixel-theater/props/hd/sign_b.webp?v=8ae4cb93ff',
    sign_c: '/dimension-ui/pixel-theater/props/hd/sign_c.webp?v=5ad45dd258',
    sign_d: '/dimension-ui/pixel-theater/props/hd/sign_d.webp?v=5b3e4f70a2',
  },
};

export const PIXEL_THEATER_BACKDROPS = [
  {
    id: 'starry_library',
    label: '星夜天文图书馆',
    desc: '古典欧式拱窗星空与暖黄灯串',
    pixel: '/dimension-ui/pixel-theater/backdrops/pixel/01_starry_library.webp?v=147de8d55b',
    hd: '/dimension-ui/pixel-theater/backdrops/hd/01_starry_library.webp?v=caa702bb86',
    lightTint: [255, 228, 172],
  },
  {
    id: 'observatory',
    label: '深蓝星夜天文台',
    desc: '高穹顶观星台与漫天银河',
    pixel: '/dimension-ui/pixel-theater/backdrops/pixel/04_observatory.webp?v=e7bb4b7321',
    hd: '/dimension-ui/pixel-theater/backdrops/hd/04_observatory.webp?v=dc3ee21e77',
    lightTint: [215, 232, 255],
  },
  {
    id: 'study',
    label: '阳光拱窗书房',
    desc: '午后暖阳洒落的像素古典书房',
    pixel: '/dimension-ui/pixel-theater/backdrops/pixel/02_sunny_study.webp?v=7c4a85f35a',
    hd: '/dimension-ui/pixel-theater/backdrops/hd/02_sunny_study.webp?v=6d6fb25116',
    lightTint: [255, 232, 168],
  },
  {
    id: 'anomaly_study',
    label: '绿天异变书房',
    desc: '窗外泛起异世界绿光的奇幻幕景',
    pixel: '/dimension-ui/pixel-theater/backdrops/pixel/03_anomaly_study.webp?v=390ec7e6a4',
    hd: '/dimension-ui/pixel-theater/backdrops/hd/03_anomaly_study.webp?v=f950b53550',
    lightTint: [195, 255, 198],
  },
  {
    id: 'classroom',
    label: '黄昏古典教室',
    desc: '斜阳余晖映照的剧场教室幕景',
    pixel: '/dimension-ui/pixel-theater/backdrops/pixel/05_classroom.webp?v=35313e5e11',
    hd: '/dimension-ui/pixel-theater/backdrops/hd/05_classroom.webp?v=e1ad87a76e',
    lightTint: [255, 206, 152],
  },
  {
    id: 'cafe',
    label: '暖灯剧场咖啡馆',
    desc: '复古木质吧台与暖黄挂灯',
    pixel: '/dimension-ui/pixel-theater/backdrops/pixel/06_cafe.webp?v=fd940e800c',
    hd: '/dimension-ui/pixel-theater/backdrops/hd/06_cafe.webp?v=cb81939e6b',
    lightTint: [255, 222, 166],
  },
];

export const PIXEL_THEATER_ACTIONS = [
  { key: 'act_huishou',   label: '挥手致意' },
  { key: 'act_jugong',    label: '优雅鞠躬' },
  { key: 'act_tiaoqi',    label: '欢快跳起' },
  { key: 'act_tiaowu',    label: '舞台起舞' },
  { key: 'act_guzhang',   label: '鼓掌喝彩' },
  { key: 'act_diantou',   label: '点头赞同' },
  { key: 'act_zhi',       label: '指向前方' },
  { key: 'act_didongxi',  label: '双手递物' },
  { key: 'act_zhuanshen', label: '轻盈转身' },
  { key: 'act_pao',       label: '小步奔跑' },
  { key: 'act_zuoxia',    label: '坐下歇息' },
  { key: 'walk',          label: '走路入场' },
];

const DUO_EMO_MAP = {
  'ai-deepseek': {
    idle:       { key: 'idle',       label: '待机呼吸' },
    neutral:    { key: 'changtai',   label: '常态微笑' },
    happy:      { key: 'kaixin',     label: '开心跃动' },
    starry:     { key: 'xingyan',    label: '星星眼' },
    playful:    { key: 'tiaopi',     label: '调皮眨眼' },
    gentle:     { key: 'wenrou',     label: '温柔浅笑' },
    content:    { key: 'anxin',      label: '安心闭眼' },
    curious:    { key: 'haoqi',      label: '好奇张望' },
    shocked:    { key: 'jingya',     label: '惊讶睁眼' },
    serious:    { key: 'renzhen',    label: '认真思考' },
    speechless: { key: 'wuyu',       label: '无语摊手' },
    shy:        { key: 'haixiu',     label: '害羞脸红' },
    worried:    { key: 'danxin',     label: '担心皱眉' },
    jealous:    { key: 'chicu',      label: '吃醋鼓腮' },
    gloomy:     { key: 'shiluo',     label: '失落低头' },
    hiss:       { key: 'haqi',       label: '气鼓鼓哈气' },
    crying:     { key: 'daku',       label: '委屈大哭' },
  },
  'ai-gemini': {
    idle:       { key: 'idle',       label: '待机呼吸' },
    neutral:    { key: 'changtai',   label: '常态微笑' },
    happy:      { key: 'biye',       label: '双手比耶' },
    starry:     { key: 'xingyan',    label: '捧脸星眼' },
    playful:    { key: 'maozhua',    label: '猫爪眨眼' },
    gentle:     { key: 'wenrou',     label: '背手温柔' },
    content:    { key: 'anxin',      label: '安心闭眼' },
    curious:    { key: 'haoqi',      label: '好奇凑近' },
    shocked:    { key: 'jingya',     label: '双掌惊讶' },
    serious:    { key: 'renzhen',    label: '认真托腮' },
    speechless: { key: 'wuyu',       label: '无语摊手' },
    shy:        { key: 'haixiu',     label: '害羞对指' },
    worried:    { key: 'huangzhang', label: '慌张关切' },
    jealous:    { key: 'chicu',      label: '吃醋抱臂' },
    gloomy:     { key: 'shiluo',     label: '失落垂耳' },
    hiss:       { key: 'zhamao',     label: '可爱炸毛' },
    crying:     { key: 'daku',       label: '委屈大哭' },
  },
  'ai-grok': {
    idle:       { key: 'idle',       label: '待机呼吸' },
    neutral:    { key: 'changtai',   label: '常态微笑' },
    happy:      { key: 'daxiao',     label: '开怀大笑' },
    starry:     { key: 'xingyan',    label: '星星眼' },
    playful:    { key: 'pujin',      label: '扑近调皮' },
    gentle:     { key: 'wenrou',     label: '温柔浅笑' },
    content:    { key: 'anxin',      label: '安心闭眼' },
    curious:    { key: 'haoqi',      label: '好奇张望' },
    shocked:    { key: 'jingya',     label: '惊讶睁眼' },
    serious:    { key: 'renzhen',    label: '认真思考' },
    speechless: { key: 'wuyu',       label: '无语摊手' },
    shy:        { key: 'haixiu',     label: '害羞脸红' },
    worried:    { key: 'danxin',     label: '担心皱眉' },
    jealous:    { key: 'aojiao',     label: '傲娇鼓腮' },
    gloomy:     { key: 'shiluo',     label: '失落低头' },
    hiss:       { key: 'jiaochen',   label: '娇嗔哈气' },
    crying:     { key: 'shiluo',     label: '委屈低头' },
  },
};

const EXTRA_ACTOR_ACTIONS = {
  'ai-grok': [
    { key: 'qingxiao', label: '轻笑捂嘴' },
  ],
};

// 按动作独立标定精灵表原画朝向（-1 表示原画朝左，1 表示原画朝右）
// 实测原画方向：DeepSeek 的 walk(v2_1) 原画朝左、act_pao(11-奔跑) 原画朝右；Gemini 的 walk 与 act_pao 原画均朝左；Grok 的 walk 与 act_pao 原画均朝右
const ACTION_NATIVE_FACING = {
  'ai-deepseek': { walk: -1, act_pao: 1 },
  'ai-gemini':   { walk: -1, act_pao: -1 },
  'ai-grok':     { walk: 1,  act_pao: 1 },
};

function buildPixelActorCatalog() {
  const mk = (botId, prefix, defaultFacing) => {
    const actions = {};
    const nativeMap = ACTION_NATIVE_FACING[botId] || {};
    for (const act of PIXEL_THEATER_ACTIONS) {
      actions[act.key] = {
        key: act.key,
        label: act.label,
        sheet: `${ASSET_ROOT}/actors/${botId}/${prefix}_${act.key}_sheet.webp?v=${SPRITE_VER}`,
        frames: 14,
        durMs: act.key === 'walk' ? 105 : 120,
        nativeFacing: typeof nativeMap[act.key] === 'number' ? nativeMap[act.key] : defaultFacing,
      };
    }
    const emo = DUO_EMO_MAP[botId] || {};
    for (const info of Object.values(emo)) {
      if (!actions[info.key]) {
        actions[info.key] = {
          key: info.key,
          label: info.label,
          sheet: `${ASSET_ROOT}/actors/${botId}/${prefix}_${info.key}_sheet.webp?v=${SPRITE_VER}`,
          frames: 14,
          durMs: 120,
          nativeFacing: typeof nativeMap[info.key] === 'number' ? nativeMap[info.key] : defaultFacing,
        };
      }
    }
    for (const extra of (EXTRA_ACTOR_ACTIONS[botId] || [])) {
      if (!actions[extra.key]) {
        actions[extra.key] = {
          key: extra.key,
          label: extra.label,
          sheet: `${ASSET_ROOT}/actors/${botId}/${prefix}_${extra.key}_sheet.webp?v=${SPRITE_VER}`,
          frames: 14,
          durMs: 120,
          nativeFacing: typeof nativeMap[extra.key] === 'number' ? nativeMap[extra.key] : defaultFacing,
        };
      }
    }
    return { botId, prefix, defaultFacing, actions };
  };

  return {
    'ai-deepseek': mk('ai-deepseek', 'deepseek', 1),
    'ai-gemini':   mk('ai-gemini', 'gemini', -1),
    'ai-grok':     mk('ai-grok', 'grok', 1),
  };
}

export const PIXEL_ACTOR_CATALOG = buildPixelActorCatalog();

export function hasPixelActorPack(botId) {
  return Boolean(botId && PIXEL_ACTOR_CATALOG[botId]);
}

export function resolveMoodToPixelAction(botId, moodKey, { speaking = false } = {}) {
  const map = DUO_EMO_MAP[botId];
  if (!map) return 'idle';
  const m = String(moodKey || 'neutral').trim().toLowerCase();
  if (m === 'neutral' || !m) {
    return speaking ? map.neutral.key : map.idle.key;
  }
  return (map[m] && map[m].key) || map.idle.key;
}

export function inferTheaterActionFromText(rawText) {
  const s = String(rawText || '');
  if (!s) return '';
  if (/挥手|摆手|打招呼|你好呀|早安|午安|晚安|再见|拜拜|哈喽|你好！/.test(s)) return 'act_huishou';
  if (/鞠躬|致谢|请多指教|万分抱歉|感谢各位|行了一礼/.test(s)) return 'act_jugong';
  if (/跳起来|蹦起来|欢呼|好耶|起跳|蹦蹦跳跳/.test(s)) return 'act_tiaoqi';
  if (/起舞|跳舞|华尔兹|翩翩起舞|转个圈/.test(s)) return 'act_tiaowu';
  if (/鼓掌|拍手|啪啪|喝彩|太精彩了/.test(s)) return 'act_guzhang';
  if (/递给你|递过去|奉茶|请收下|拿好|给你这个/.test(s)) return 'act_didongxi';
  if (/转身|回过头|回头看|转过身/.test(s)) return 'act_zhuanshen';
  if (/看那边|指向|往前看|快看前面|就在那/.test(s)) return 'act_zhi';
  if (/跑过来|冲鸭|快跑|撒腿|小跑/.test(s)) return 'act_pao';
  if (/坐下|歇会儿|坐着|休息一下/.test(s)) return 'act_zuoxia';
  if (/点头|点点头|嗯嗯|同意|确实如此|赞同/.test(s)) return 'act_diantou';
  return '';
}

const HUMAN_STAGGER_PRESETS_4 = [
  [
    { raiseY: 4.8, shiftX: -0.35, tilt: -2.6 },
    { raiseY: -2.4, shiftX: -0.1, tilt: -0.8 },
    { raiseY: 3.4, shiftX: 0.15, tilt: 1.1 },
    { raiseY: -1.6, shiftX: 0.35, tilt: 2.7 },
  ],
  [
    { raiseY: -1.8, shiftX: -0.35, tilt: -2.8 },
    { raiseY: 4.6, shiftX: -0.05, tilt: 0.9 },
    { raiseY: -2.2, shiftX: 0.1, tilt: -0.7 },
    { raiseY: 3.6, shiftX: 0.35, tilt: 2.5 },
  ],
  [
    { raiseY: 3.2, shiftX: -0.3, tilt: -2.4 },
    { raiseY: -1.4, shiftX: -0.1, tilt: -1.0 },
    { raiseY: 4.8, shiftX: 0.15, tilt: 1.2 },
    { raiseY: -2.5, shiftX: 0.35, tilt: 2.8 },
  ],
];

const HUMAN_STAGGER_PRESETS_3 = [
  [
    { raiseY: 5.2, shiftX: -0.5, tilt: -2.6 },
    { raiseY: -2.2, shiftX: 0.2, tilt: 0.9 },
    { raiseY: 2.6, shiftX: 0.5, tilt: 2.9 },
  ],
  [
    { raiseY: -1.6, shiftX: -0.6, tilt: -2.9 },
    { raiseY: 4.8, shiftX: -0.1, tilt: -0.8 },
    { raiseY: 0.6, shiftX: 0.6, tilt: 2.5 },
  ],
];

const QUILL_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/></svg>';

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function easeOutBackSoft(t) {
  const c1 = 1.42;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function easeInCubic(t) {
  return t * t * t;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function getStageSlotCoords(count) {
  if (count <= 1) return [{ x: 50, y: 71.5, facing: 1 }];
  if (count === 2) return [
    { x: 37.5, y: 71.5, facing: 1 },
    { x: 62.5, y: 71.5, facing: -1 },
  ];
  if (count === 3) return [
    { x: 27.5, y: 70.0, facing: 1 },
    { x: 50.0, y: 72.5, facing: 1 },
    { x: 72.5, y: 70.0, facing: -1 },
  ];
  if (count === 4) return [
    { x: 22.5, y: 69.0, facing: 1 },
    { x: 40.5, y: 72.2, facing: 1 },
    { x: 59.5, y: 72.2, facing: -1 },
    { x: 77.5, y: 69.0, facing: -1 },
  ];
  return [
    { x: 19.5, y: 68.5, facing: 1 },
    { x: 34.5, y: 71.5, facing: 1 },
    { x: 50.0, y: 73.0, facing: 1 },
    { x: 65.5, y: 71.5, facing: -1 },
    { x: 80.5, y: 68.5, facing: -1 },
  ];
}

export function createPixelTheaterController(stageEl, hooks = {}) {
  if (!stageEl) return null;

  const root = document.createElement('div');
  root.className = 'pt-stage-root mode-pixel';
  root.id = 'galPixelTheaterRoot';
  root.hidden = true;
  root.innerHTML = `
    <div class="pt-stage-layer pt-layer-backdrop">
      <img class="pt-backdrop-img" data-pt="bg-prev" alt="">
      <img class="pt-backdrop-img" data-pt="bg-main" alt="">
    </div>
    <div class="pt-stage-layer pt-layer-lights">
      <canvas class="pt-lights-canvas" data-pt="lights" width="960" height="540"></canvas>
    </div>
    <div class="pt-stage-layer pt-layer-floor">
      <img class="pt-stage-img" data-pt="floor" alt="">
      <div class="pt-footlights-glow" aria-hidden="true"></div>
    </div>
    <div class="pt-floor-hitbox" data-pt="floor-hitbox" title="点击舞台木地板可演示角色走位"></div>
    <div class="pt-stage-layer pt-layer-actors" data-pt="actors"></div>
    <div class="pt-stage-layer pt-layer-curtains">
      <img class="pt-curtain-piece pt-curtain-left-closed" data-pt="curtain-lc" alt="">
      <img class="pt-curtain-piece pt-curtain-right-closed" data-pt="curtain-rc" alt="">
      <img class="pt-curtain-piece pt-curtain-left-open" data-pt="curtain-lo" alt="">
      <img class="pt-curtain-piece pt-curtain-right-open" data-pt="curtain-ro" alt="">
    </div>
    <div class="pt-stage-layer pt-layer-valance">
      <img class="pt-stage-img" data-pt="valance" alt="">
    </div>
    <div class="pt-drop-overlay" data-pt="drop-overlay">松开鼠标，立即更换像素剧院幕景背景</div>
  `;

  const choiceHost = document.createElement('div');
  choiceHost.className = 'pt-choice-host';
  choiceHost.id = 'galPixelChoiceHost';
  choiceHost.hidden = true;
  choiceHost.innerHTML = `
    <div class="pt-choice-scrim" aria-hidden="true"></div>
    <div class="pt-fate-banner" data-pt="fate-banner">
      <span class="pt-fate-banner-line" aria-hidden="true"></span>
      <span class="pt-fate-banner-text" data-pt="fate-banner-text">命运抉择</span>
      <span class="pt-fate-banner-line" aria-hidden="true"></span>
      <button type="button" class="pt-fate-collapse-btn" data-pt="fate-collapse">先收起</button>
    </div>
    <div class="pt-choice-signs-box" data-pt="fate-signs"></div>
  `;

  // 插入到舞台最前部（在 .gal-bg-layer 之后，所有对话/HUD/浮窗之下）；choiceHost 置于舞台内做 Layer 3.5
  const anchorBefore = stageEl.querySelector('.gal-director-fx-layer') || stageEl.firstChild;
  stageEl.insertBefore(root, anchorBefore);
  const forkOverlayRef = stageEl.querySelector('#galStoryForkOverlay');
  if (forkOverlayRef && forkOverlayRef.parentElement === stageEl) {
    stageEl.insertBefore(choiceHost, forkOverlayRef);
  } else {
    stageEl.appendChild(choiceHost);
  }

  const els = {
    bgPrev: root.querySelector('[data-pt="bg-prev"]'),
    bgMain: root.querySelector('[data-pt="bg-main"]'),
    lightsCanvas: root.querySelector('[data-pt="lights"]'),
    floor: root.querySelector('[data-pt="floor"]'),
    floorHitbox: root.querySelector('[data-pt="floor-hitbox"]'),
    actorsLayer: root.querySelector('[data-pt="actors"]'),
    curtainLC: root.querySelector('[data-pt="curtain-lc"]'),
    curtainRC: root.querySelector('[data-pt="curtain-rc"]'),
    curtainLO: root.querySelector('[data-pt="curtain-lo"]'),
    curtainRO: root.querySelector('[data-pt="curtain-ro"]'),
    valance: root.querySelector('[data-pt="valance"]'),
    dropOverlay: root.querySelector('[data-pt="drop-overlay"]'),
    fateBanner: choiceHost.querySelector('[data-pt="fate-banner"]'),
    fateBannerText: choiceHost.querySelector('[data-pt="fate-banner-text"]'),
    fateCollapseBtn: choiceHost.querySelector('[data-pt="fate-collapse"]'),
    fateSignsBox: choiceHost.querySelector('[data-pt="fate-signs"]'),
  };

  const lightCtx = els.lightsCanvas.getContext('2d');
  const particles = [];
  for (let i = 0; i < 32; i++) {
    particles.push({
      x: Math.random(),
      y: 0.14 + Math.random() * 0.72,
      r: 1.1 + Math.random() * 2.0,
      vx: (Math.random() - 0.5) * 0.006,
      vy: -0.004 - Math.random() * 0.009,
      alpha: 0.24 + Math.random() * 0.52,
      twinkle: Math.random() * Math.PI * 2,
    });
  }

  const st = {
    active: false,
    motionEnabled: true,
    quality: 'pixel', // 'pixel' | 'hd'
    backdropId: 'starry_library',
    customBgUrl: '',
    curtainOpen: 1.0,
    curtainTarget: 1.0,
    curtainAnimStart: 0,
    curtainAnimFrom: 1.0,
    curtainAnimDuration: 1100,
    curtainAnimating: false,
    actors: new Map(), // botId -> actor state
    activeSpeakerId: '',
    isGroupChat: false,
    rafId: 0,
    lastTs: 0,
    preloadedSheets: new Set(),
    fate: {
      forkKey: '',
      visible: false,
      locked: false,
      editingIndex: -1,
      presetCursor: 0,
      signs: [],
      hideTimer: 0,
      onSelect: null,
      onCollapse: null,
      prompt: '',
    },
  };

  function preloadSheet(url) {
    if (!url || st.preloadedSheets.has(url)) return;
    st.preloadedSheets.add(url);
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
  }

  function resolveBackdropMeta(bgId) {
    return PIXEL_THEATER_BACKDROPS.find((b) => b.id === bgId) || PIXEL_THEATER_BACKDROPS[0];
  }

  function applyLayerAssets() {
    wakeStage();
    const assets = LAYER_ASSETS[st.quality] || LAYER_ASSETS.pixel;
    els.valance.src = assets.valance;
    els.curtainLO.src = assets.curtainLeftOpen;
    els.curtainRO.src = assets.curtainRightOpen;
    els.curtainLC.src = assets.curtainLeftClosed;
    els.curtainRC.src = assets.curtainRightClosed;
    els.floor.src = assets.floor;

    root.classList.toggle('mode-pixel', st.quality === 'pixel');

    const props = PROP_ASSETS[st.quality] || PROP_ASSETS.pixel;
    for (const s of st.fate.signs) {
      if (s.imgEl && props[s.prop]) {
        s.imgEl.src = props[s.prop];
      }
    }

    if (!st.customBgUrl) {
      const bg = resolveBackdropMeta(st.backdropId);
      const nextUrl = st.quality === 'pixel' ? bg.pixel : bg.hd;
      if (els.bgMain.getAttribute('src') !== nextUrl) {
        els.bgMain.src = nextUrl;
      }
    }
  }

  function crossfadeBackdrop(nextSrc) {
    if (!nextSrc) return;
    const prevSrc = els.bgMain.getAttribute('src');
    if (prevSrc === nextSrc) return;
    if (prevSrc) {
      els.bgPrev.src = prevSrc;
      els.bgPrev.classList.remove('fade-out');
      els.bgPrev.style.opacity = '1';
    }
    els.bgMain.src = nextSrc;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        els.bgPrev.classList.add('fade-out');
        els.bgPrev.style.opacity = '0';
      });
    });
  }

  function setBackdrop(bgId, customUrl = '') {
    if (bgId === 'custom' && customUrl) {
      st.backdropId = 'custom';
      st.customBgUrl = customUrl;
      crossfadeBackdrop(customUrl);
      return;
    }
    const meta = resolveBackdropMeta(bgId || st.backdropId);
    st.backdropId = meta.id;
    st.customBgUrl = '';
    const src = st.quality === 'pixel' ? meta.pixel : meta.hd;
    crossfadeBackdrop(src);
  }

  function applyCurtainProgress(p) {
    const clamped = Math.max(0, Math.min(1, p));
    st.curtainOpen = clamped;

    const slidePct = clamped * 102;
    const compressX = 1 - clamped * 0.42;
    const closedOpacity = clamped > 0.86 ? Math.max(0, 1 - (clamped - 0.86) / 0.14) : 1;

    els.curtainLC.style.transform = `translate3d(${-slidePct}%, 0, 0) scaleX(${compressX.toFixed(4)})`;
    els.curtainRC.style.transform = `translate3d(${slidePct}%, 0, 0) scaleX(${compressX.toFixed(4)})`;
    els.curtainLC.style.opacity = closedOpacity.toFixed(3);
    els.curtainRC.style.opacity = closedOpacity.toFixed(3);

    const openT = Math.max(0, Math.min(1, (clamped - 0.22) / 0.78));
    const openEased = easeInOutCubic(openT);
    const sideShift = (1 - openEased) * 14;
    const sideOpacity = Math.min(1, openT * 1.45);

    els.curtainLO.style.transform = `translate3d(${-sideShift.toFixed(2)}%, 0, 0)`;
    els.curtainRO.style.transform = `translate3d(${sideShift.toFixed(2)}%, 0, 0)`;
    els.curtainLO.style.opacity = sideOpacity.toFixed(3);
    els.curtainRO.style.opacity = sideOpacity.toFixed(3);

    if (typeof hooks.onCurtainChange === 'function') {
      hooks.onCurtainChange(clamped);
    }
  }

  function animateCurtainTo(target, durationMs = 1100) {
    wakeStage();
    st.curtainAnimFrom = st.curtainOpen;
    st.curtainTarget = Math.max(0, Math.min(1, target));
    st.curtainAnimStart = performance.now();
    st.curtainAnimDuration = Math.max(180, durationMs * Math.abs(st.curtainTarget - st.curtainAnimFrom));
    st.curtainAnimating = true;
  }

  function applyActorVisualAction(actor, actionKey, { resetElapsed = true, labelOverride = '' } = {}) {
    if (!actor || !actor.isPixel) return;
    const cat = PIXEL_ACTOR_CATALOG[actor.id];
    if (!cat) return;
    const act = cat.actions[actionKey] || cat.actions.idle;
    const realKey = cat.actions[actionKey] ? actionKey : 'idle';
    const changed = actor.action !== realKey;
    actor.action = realKey;
    if (resetElapsed || changed) actor.animElapsedMs = 0;

    preloadSheet(act.sheet);
    if (actor.spriteEl) {
      const targetBg = `url("${act.sheet}")`;
      if (actor.spriteEl.dataset.sheet !== act.sheet) {
        actor.spriteEl.dataset.sheet = act.sheet;
        actor.spriteEl.style.backgroundImage = targetBg;
        actor.spriteEl.style.backgroundSize = `${act.frames * 100}% 100%`;
      }
    }
    if (actor.pillEl) {
      actor.pillEl.textContent = labelOverride || act.label;
    }
  }

  function createActorDom(botId, name, isPixel, fallbackUrl, isAvatarChip) {
    const el = document.createElement('div');
    el.className = 'pt-actor';
    el.dataset.botId = botId;

    const shadow = document.createElement('div');
    shadow.className = 'pt-actor-shadow';
    el.appendChild(shadow);

    let spriteEl = null;
    let fallbackEl = null;
    let fallbackImg = null;
    if (isPixel) {
      spriteEl = document.createElement('div');
      spriteEl.className = 'pt-actor-sprite';
      el.appendChild(spriteEl);
    } else {
      fallbackEl = document.createElement('div');
      fallbackEl.className = `pt-actor-fallback${isAvatarChip ? ' is-avatar-chip' : ''}`;
      fallbackImg = document.createElement('img');
      fallbackImg.alt = name;
      if (fallbackUrl) fallbackImg.src = fallbackUrl;
      fallbackEl.appendChild(fallbackImg);
      el.appendChild(fallbackEl);
    }

    const tag = document.createElement('div');
    tag.className = 'pt-actor-nametag';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = name;
    const pillSpan = document.createElement('span');
    pillSpan.className = 'pt-actor-action-pill';
    pillSpan.textContent = isPixel ? '待机呼吸' : '立绘同台';
    tag.append(nameSpan, pillSpan);
    el.appendChild(tag);

    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (typeof hooks.onActorClick === 'function') {
        hooks.onActorClick(botId, name);
      }
    });

    els.actorsLayer.appendChild(el);
    return { el, spriteEl, fallbackEl, fallbackImg, nameEl: nameSpan, pillEl: pillSpan };
  }

  function syncCast({
    isGroupChat = false,
    members = [],
    castOrder = [],
    activeSpeakerId = '',
    memberMoods = {},
    soloBotId = '',
    soloBotName = '',
    soloAvatarUrl = '',
    soloMood = 'neutral',
    fallbackSpriteUrlOf = null,
    speaking = false,
  } = {}) {
    wakeStage();
    st.isGroupChat = Boolean(isGroupChat);
    st.activeSpeakerId = isGroupChat ? String(activeSpeakerId || '') : String(soloBotId || '');

    const list = [];
    if (isGroupChat) {
      const ids = (castOrder && castOrder.length ? castOrder : members.map((m) => m.id)).slice(0, 5);
      for (const id of ids) {
        const m = members.find((x) => x.id === id) || { id, name: id, avatarUrl: '' };
        list.push({
          id: m.id,
          name: m.name || m.id,
          avatarUrl: m.avatarUrl || '',
          mood: memberMoods[m.id] || 'neutral',
          isSpeaking: Boolean(activeSpeakerId && m.id === activeSpeakerId),
        });
      }
    } else if (soloBotId) {
      list.push({
        id: soloBotId,
        name: soloBotName || soloBotId,
        avatarUrl: soloAvatarUrl || '',
        mood: soloMood || 'neutral',
        isSpeaking: Boolean(speaking),
      });
    }

    const keepIds = new Set(list.map((x) => x.id));
    for (const [id, actor] of st.actors.entries()) {
      if (!keepIds.has(id)) {
        actor.el.remove();
        st.actors.delete(id);
      }
    }

    const coords = getStageSlotCoords(list.length);
    const hasAnySpeaker = isGroupChat && Boolean(activeSpeakerId && keepIds.has(activeSpeakerId));

    list.forEach((entry, idx) => {
      const isPixel = hasPixelActorPack(entry.id);
      const fbUrl = (!isPixel && typeof fallbackSpriteUrlOf === 'function')
        ? (fallbackSpriteUrlOf(entry.id, entry.mood) || entry.avatarUrl)
        : entry.avatarUrl;
      const isAvatarChip = !isPixel && fbUrl === entry.avatarUrl && Boolean(entry.avatarUrl);
      const slot = coords[idx] || { x: 50, y: 71, facing: 1 };

      let actor = st.actors.get(entry.id);
      if (!actor) {
        const dom = createActorDom(entry.id, entry.name, isPixel, fbUrl, isAvatarChip);
        // 新上台角色：若像素剧院已激活且动效开启，从对应侧红丝绒大幕布后迈步走上舞台！
        const wingStartX = slot.x < 50 ? 6.0 : 94.0;
        const shouldWalkIn = Boolean(st.active && st.motionEnabled);
        actor = {
          id: entry.id,
          name: entry.name,
          isPixel,
          x: shouldWalkIn ? wingStartX : slot.x,
          y: slot.y,
          targetX: slot.x,
          targetY: slot.y,
          homeX: slot.x,
          homeY: slot.y,
          facing: shouldWalkIn ? (slot.x < 50 ? 1 : -1) : slot.facing,
          mood: entry.mood,
          action: 'idle',
          moveMode: 'walk',
          postMoveAction: '',
          postMoveDurationMs: 0,
          overrideAction: '',
          overrideUntil: 0,
          walking: shouldWalkIn,
          lastChoreoAt: 0,
          animElapsedMs: idx * 360,
          phase: idx * 1.65,
          ...dom,
        };
        st.actors.set(entry.id, actor);
        // 首次登台预热待机、走路与奔跑精灵表
        if (isPixel) {
          const cat = PIXEL_ACTOR_CATALOG[entry.id];
          if (cat) {
            preloadSheet(cat.actions.idle.sheet);
            preloadSheet(cat.actions.walk.sheet);
            preloadSheet(cat.actions.act_pao.sheet);
          }
          if (shouldWalkIn) {
            applyActorVisualAction(actor, 'walk', { resetElapsed: true });
          }
        }
      } else {
        actor.name = entry.name;
        actor.nameEl.textContent = entry.name;
        actor.mood = entry.mood;
        // 如果编排人数变更导致默认站位改变，且演员当前不在自定义漫步中，则自然走过去
        const homeMoved = Math.abs(actor.homeX - slot.x) > 1.2 || Math.abs(actor.homeY - slot.y) > 1.2;
        if (homeMoved) {
          actor.homeX = slot.x;
          actor.homeY = slot.y;
          actor.targetX = slot.x;
          actor.targetY = slot.y;
        }
      }

      actor.el.classList.toggle('is-speaking', hasAnySpeaker ? entry.isSpeaking : (!isGroupChat && entry.isSpeaking));
      actor.el.classList.toggle('is-listening', hasAnySpeaker && !entry.isSpeaking);

      if (actor.isPixel) {
        const now = performance.now();
        const hasValidOverride = Boolean(actor.overrideAction && (actor.overrideUntil === 0 || now < actor.overrideUntil));
        if (!actor.walking && !hasValidOverride) {
          const targetAct = resolveMoodToPixelAction(actor.id, entry.mood, { speaking: entry.isSpeaking });
          applyActorVisualAction(actor, targetAct, { resetElapsed: false });
        }
      } else if (actor.fallbackImg && fbUrl && actor.fallbackImg.getAttribute('src') !== fbUrl) {
        actor.fallbackImg.src = fbUrl;
        actor.fallbackEl?.classList.toggle('is-avatar-chip', isAvatarChip);
      }
    });
  }

  function triggerActorAction(botId, actionKey, { durationMs = 0 } = {}) {
    wakeStage();
    const targetIds = botId === 'all'
      ? [...st.actors.keys()]
      : (botId ? [botId] : (st.activeSpeakerId ? [st.activeSpeakerId] : [...st.actors.keys()].slice(0, 1)));
    const now = performance.now();
    let triggered = false;
    for (const id of targetIds) {
      const actor = st.actors.get(id);
      if (!actor || !actor.isPixel) continue;
      actor.walking = false;
      if (actionKey === 'idle' || !actionKey) {
        actor.overrideAction = '';
        actor.overrideUntil = 0;
        const baseAct = resolveMoodToPixelAction(actor.id, actor.mood, { speaking: false });
        applyActorVisualAction(actor, baseAct, { resetElapsed: true });
      } else {
        actor.overrideAction = actionKey;
        actor.overrideUntil = durationMs > 0 ? (now + durationMs) : 0;
        applyActorVisualAction(actor, actionKey, { resetElapsed: true });
      }
      triggered = true;
    }
    return triggered;
  }

  function clearActorOverrides(botId = '') {
    wakeStage();
    for (const actor of st.actors.values()) {
      if (botId && actor.id !== botId) continue;
      actor.overrideAction = '';
      actor.overrideUntil = 0;
    }
  }

  function triggerEasterEgg(botId, eggKind) {
    const map = { tea: 'act_didongxi', goodnight: 'anxin', cheer: 'act_tiaoqi' };
    const act = map[eggKind] || 'act_huishou';
    return triggerActorAction(botId || 'all', act, { durationMs: 3600 });
  }

  /* ---- 剧情驱动角色自主走位导演引擎（Autonomous Story Choreography） ---- */
  function clampStageCoord(x, y) {
    const uiHidden = stageEl.classList.contains('is-ui-hidden');
    const cx = Math.max(15.5, Math.min(84.5, Number(x) || 50));
    const cy = Math.max(64.5, Math.min(uiHidden ? 85.0 : 75.2, Number(y) || 71.0));
    return { x: cx, y: cy };
  }

  function resolveNonOverlappingTarget(actorId, rawX, rawY) {
    let { x, y } = clampStageCoord(rawX, rawY);
    const minSepX = 14.2;
    for (let iter = 0; iter < 3; iter++) {
      let pushed = false;
      for (const other of st.actors.values()) {
        if (other.id === actorId) continue;
        const ox = other.targetX;
        const oy = other.targetY;
        const dx = x - ox;
        const dy = Math.abs(y - oy);
        if (Math.abs(dx) < minSepX && dy < 5.5) {
          const dir = dx === 0 ? (x < 50 ? -1 : 1) : Math.sign(dx);
          x = ox + dir * minSepX;
          pushed = true;
        }
      }
      const clamped = clampStageCoord(x, y);
      x = clamped.x;
      y = clamped.y;
      if (!pushed) break;
    }
    return { x, y };
  }

  function commandActorMove(actor, rawX, rawY, {
    mode = 'walk',
    postAction = '',
    postDurationMs = 3200,
    faceAfter = 0,
  } = {}) {
    if (!actor) return false;
    const safe = resolveNonOverlappingTarget(actor.id, rawX, rawY);
    const dist = Math.hypot(safe.x - actor.x, safe.y - actor.y);
    actor.moveMode = mode === 'run' ? 'run' : 'walk';
    actor.postMoveAction = postAction || '';
    actor.postMoveDurationMs = postDurationMs || 3200;
    actor.lastChoreoAt = performance.now();

    if (dist < 1.8) {
      if (faceAfter) actor.facing = faceAfter;
      if (postAction && actor.isPixel) {
        triggerActorAction(actor.id, postAction, { durationMs: postDurationMs });
      }
      return false;
    }
    actor.targetX = safe.x;
    actor.targetY = safe.y;
    actor.walking = true;
    actor.overrideAction = '';
    actor.overrideUntil = 0;
    if (actor.isPixel) {
      const moveAct = actor.moveMode === 'run' ? 'act_pao' : 'walk';
      applyActorVisualAction(actor, moveAct, { resetElapsed: true });
    }
    return true;
  }

  function getActorAliases(actor) {
    const out = [actor.name, actor.id].filter(Boolean);
    const id = String(actor.id || '').toLowerCase();
    if (id === 'ai-deepseek') out.push('deepseek', '深求', '鲸鱼女仆', '小鲸鱼');
    else if (id === 'ai-gemini') out.push('gemini', '双子', '星光猫娘', '猫耳娘', '小猫娘');
    else if (id === 'ai-claude') out.push('claude', '克劳德');
    else if (id === 'ai-gpt') out.push('gpt', '白龙娘');
    else if (id === 'ai-grok') out.push('grok', '格洛克', '金发斧娘', '斧娘', '小斧');
    else if (id === 'ai-kimi') out.push('kimi');
    else if (id === 'ai-qwen') out.push('qwen', '千问');
    else if (id === 'ai-glm') out.push('glm', '智谱');
    return [...new Set(out.map((s) => String(s).trim().toLowerCase()).filter((s) => s.length >= 2))];
  }

  function findMentionedActors(text, excludeId = '') {
    const lower = String(text || '').toLowerCase();
    const hits = [];
    for (const actor of st.actors.values()) {
      if (excludeId && actor.id === excludeId) continue;
      const aliases = getActorAliases(actor);
      let firstIdx = Infinity;
      for (const al of aliases) {
        const idx = lower.indexOf(al);
        if (idx >= 0 && idx < firstIdx) firstIdx = idx;
      }
      if (firstIdx < Infinity) hits.push({ actor, idx: firstIdx });
    }
    hits.sort((a, b) => a.idx - b.idx);
    return hits.map((h) => h.actor);
  }

  function applyClauseChoreography(actor, clause, { allowSubtleStep = false, lastSpeakerId = '' } = {}) {
    if (!actor || !clause) return false;
    const s = String(clause || '').trim();
    if (!s) return false;
    const isRun = /跑|飞奔|冲过来|冲过去|冲向|狂奔|小跑|追过去|撒腿/.test(s);
    const mode = isRun ? 'run' : 'walk';
    const postAction = inferTheaterActionFromText(s);

    // 1. 走向 / 凑近 / 跑向另一位在场同伴（预判目标最终落点 targetX/targetY，实现双人联动自然汇合！）
    const mentionedOthers = findMentionedActors(s, actor.id);
    if (mentionedOthers.length > 0 && /走|跑|靠|凑|贴|拉|拍|递|挽|追|找|冲|移|挨|身旁|身边|过去|过来|悄悄/.test(s)) {
      const target = mentionedOthers[0];
      const goalX = target.targetX ?? target.x;
      const goalY = target.targetY ?? target.y;
      const side = actor.x <= goalX ? -1 : 1;
      const tx = goalX + side * 14.5;
      const ty = Math.min(74.8, Math.max(65.0, goalY + (Math.random() - 0.5) * 1.4));
      return commandActorMove(actor, tx, ty, { mode, postAction, faceAfter: -side });
    }

    // 2. 后退 / 躲避 / 退到幕布边角
    if (/后退|退后|退开|退一步|躲开|躲到|躲在|溜到|溜走|退到一旁|缩到角落|离远|远离|躲起来/.test(s)) {
      const toLeft = actor.x < 50;
      const tx = toLeft ? (18 + Math.random() * 5) : (77 + Math.random() * 5);
      const ty = 66.2 + Math.random() * 2.0;
      return commandActorMove(actor, tx, ty, { mode, postAction });
    }

    // 3. 探索窗边 / 望远镜 / 暗门 / 书架 / 阁楼方向
    if (/窗边|窗外|拱窗|望远镜|暗门|阁楼|书架|门边|门口|探头|调查|过去看看|凑近看|环顾|四周|观察/.test(s)) {
      let tx = 50;
      if (/左|书架|暗门/.test(s)) tx = 24 + Math.random() * 6;
      else if (/右|门|阁楼/.test(s)) tx = 70 + Math.random() * 6;
      else if (/望远镜|窗|星/.test(s)) tx = 44 + Math.random() * 14;
      else tx = actor.x < 50 ? 28 : 72;
      const ty = 64.8 + Math.random() * 1.4;
      return commandActorMove(actor, tx, ty, { mode, postAction: postAction || 'haoqi' });
    }

    // 4. 上前一步 / 站到台前中央聚光
    if (/走上前|上前一步|走上台前|来到台前|走到中央|站到中间|站出来|挺身而出|走近|凑过来|过来|向前一步|闪亮登场|听好了|大家看我/.test(s)) {
      const offset = st.actors.size > 1 ? (actor.homeX < 50 ? -5.5 : 5.5) : 0;
      const tx = 50 + offset;
      const ty = 74.2;
      return commandActorMove(actor, tx, ty, { mode, postAction });
    }

    // 5. 归位 / 回到原位 / 集合站好
    if (/走回|回到原位|退回原位|归位|站好|回位/.test(s)) {
      return commandActorMove(actor, actor.homeX, actor.homeY, { mode, postAction });
    }

    // 6. 踱步 / 来回走 / 换一边 / 逛逛
    if (/踱步|来回走|走来走去|换个位置|走两步|绕一圈|散步|走动/.test(s)) {
      const shift = actor.x > 52 ? -(14 + Math.random() * 8) : (14 + Math.random() * 8);
      return commandActorMove(actor, actor.x + shift, 70.5 + (Math.random() - 0.5) * 3.0, { mode, postAction });
    }

    // 7. 只有演出动作词（无位移）：直接演动作
    if (postAction && actor.isPixel) {
      triggerActorAction(actor.id, postAction, { durationMs: 3200 });
      return true;
    }

    // 8. 群像对话自然微步：发言者若在边角/后排，轻轻朝台心或对话对象迈一小步（克制防乱跑）
    if (allowSubtleStep && st.actors.size >= 2) {
      const now = performance.now();
      if (now - (actor.lastChoreoAt || 0) < 4200) return false;
      const prevSpeaker = lastSpeakerId && lastSpeakerId !== actor.id ? st.actors.get(lastSpeakerId) : null;
      const farFromHome = Math.hypot(actor.x - actor.homeX, actor.y - actor.homeY) > 16;
      if (farFromHome) {
        // 之前因探索/后退跑远了，重新发言时温柔往回靠半程
        return commandActorMove(actor, (actor.x + actor.homeX) * 0.5, (actor.y + actor.homeY) * 0.5, { mode: 'walk' });
      }
      if (prevSpeaker) {
        const toward = Math.sign(prevSpeaker.x - actor.x) || 1;
        const stepX = Math.abs(prevSpeaker.x - actor.x) > 22 ? actor.x + toward * 6.5 : actor.x + (50 - actor.x) * 0.18;
        const stepY = Math.min(74.0, Math.max(68.5, actor.y + 1.8));
        if (Math.hypot(stepX - actor.x, stepY - actor.y) >= 3.0) {
          return commandActorMove(actor, stepX, stepY, { mode: 'walk' });
        }
      }
    }
    return false;
  }

  let prevStorySpeakerId = '';

  function directByStoryLine({ speakerId = '', text = '', isNarrator = false } = {}) {
    if (!st.active || !st.motionEnabled || st.actors.size === 0) return false;
    const raw = String(text || '').trim();
    if (!raw) return false;
    let movedAny = false;

    // 仅由剧场中实际演出的旁白/角色语句驱动走位（绝不跟随聊天框消息变化）
    if (isNarrator || !speakerId || !st.actors.has(speakerId)) {
      const clauses = raw.split(/[。！？!?\n；;，,]+/).map((x) => x.trim()).filter(Boolean);
      for (const clause of clauses) {
        const mentioned = findMentionedActors(clause);
        if (mentioned.length > 0) {
          const subject = mentioned[0];
          if (applyClauseChoreography(subject, clause, { allowSubtleStep: false })) {
            movedAny = true;
          }
        } else if (/众人|大家|两人|二人|她们|全员|一起/.test(clause) && /走|跑|退|散开|靠拢|集合|上前|窗边|暗门/.test(clause)) {
          let i = 0;
          for (const a of st.actors.values()) {
            if (/散开|退后|后退/.test(clause)) {
              const sideX = a.homeX < 50 ? 20 + i * 4 : 80 - i * 4;
              if (commandActorMove(a, sideX, 67.0, { mode: /跑|冲/.test(clause) ? 'run' : 'walk' })) movedAny = true;
            } else if (/靠拢|集合|围过来|凑近/.test(clause)) {
              const centerX = 50 + (a.homeX < 50 ? -8.5 : 8.5);
              if (commandActorMove(a, centerX, 72.5, { mode: /跑|冲/.test(clause) ? 'run' : 'walk' })) movedAny = true;
            } else if (applyClauseChoreography(a, clause, { allowSubtleStep: false })) {
              movedAny = true;
            }
            i += 1;
          }
        }
      }
      return movedAny;
    }

    // 剧场中当前正在发言的角色：按当前这一拍台词解析走位与演出动作
    const speaker = st.actors.get(speakerId);
    if (speaker) {
      movedAny = applyClauseChoreography(speaker, raw, {
        allowSubtleStep: st.isGroupChat,
        lastSpeakerId: prevStorySpeakerId,
      });
      prevStorySpeakerId = speakerId;
    }
    return movedAny;
  }

  function handleFloorClick(ev) {
    wakeStage();
    if (!st.active || st.curtainOpen < 0.35 || st.fate.visible) return;
    ev.stopPropagation();
    const rect = root.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const uiHidden = stageEl.classList.contains('is-ui-hidden');
    const xPct = Math.max(12, Math.min(88, ((ev.clientX - rect.left) / rect.width) * 100));
    const maxY = uiHidden ? 87.5 : 77.5;
    const yPct = Math.max(63.5, Math.min(maxY, ((ev.clientY - rect.top) / rect.height) * 100));

    const ripple = document.createElement('div');
    ripple.className = 'pt-walk-ripple';
    ripple.style.left = `${xPct.toFixed(2)}%`;
    ripple.style.top = `${yPct.toFixed(2)}%`;
    root.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);

    // 优先选距离点击位置最近的演员走过去
    let chosen = null;
    let bestDist = Infinity;
    for (const a of st.actors.values()) {
      const d = Math.hypot(a.x - xPct, (a.y - yPct) * 1.4);
      if (d < bestDist) {
        bestDist = d;
        chosen = a;
      }
    }
    if (!chosen) return;
    chosen.targetX = xPct;
    chosen.targetY = yPct;
    chosen.moveMode = 'walk';
    chosen.postMoveAction = '';
    chosen.postMoveDurationMs = 0;
    if (!chosen.walking) {
      chosen.walking = true;
      chosen.overrideAction = '';
      chosen.overrideUntil = 0;
      if (chosen.isPixel) {
        applyActorVisualAction(chosen, 'walk', { resetElapsed: true });
      }
    }
  }

  /* ---- Layer 3.5: 4 块命运抉择手举木牌（与真实 pendingFork 完全打通） ---- */
  function enterCustomSignEdit(idx) {
    wakeStage();
    const s = st.fate.signs[idx];
    if (!s || !s.isCustom || st.fate.locked) return;
    st.fate.editingIndex = idx;
    s.editingTarget = 1;
    s.hoverTarget = 1;
    s.el.classList.add('is-editing');
    els.fateBannerText.textContent = '自由演绎 · 请在木牌上直接写下命运转折并回车落定';
    const inp = s.el.querySelector('.pt-custom-input');
    if (inp) setTimeout(() => inp.focus({ preventScroll: true }), 60);
  }

  function exitCustomSignEdit(idx) {
    wakeStage();
    const s = st.fate.signs[idx];
    if (!s) return;
    if (st.fate.editingIndex === idx) st.fate.editingIndex = -1;
    s.editingTarget = 0;
    s.hoverTarget = 0;
    s.el.classList.remove('is-editing');
    els.fateBannerText.textContent = st.fate.prompt || '命运在此分岔，选择或亲手改写下一幕走向';
  }

  function commitCustomSignInput(idx, rawText) {
    const text = String(rawText || '').trim();
    const s = st.fate.signs[idx];
    if (!s || st.fate.locked) return;
    if (!text) {
      const inp = s.el.querySelector('.pt-custom-input');
      if (inp) {
        inp.placeholder = '请先写下行动内容…';
        inp.focus({ preventScroll: true });
      }
      return;
    }
    s.data = { ...s.data, badge: '自由演绎', title: text, sub: '玩家自定义命运' };
    const titleEl = s.el.querySelector('.pt-choice-sign-title');
    const subEl = s.el.querySelector('.pt-choice-sign-sub');
    if (titleEl) titleEl.textContent = text;
    if (subEl) subEl.textContent = '玩家自定义命运';
    s.editingTarget = 0;
    st.fate.editingIndex = -1;
    s.el.classList.remove('is-editing');
    handleFateChoiceClick(idx);
  }

  function handleFateChoiceClick(chosenIdx) {
    wakeStage();
    if (st.fate.locked || !st.fate.visible) return;
    const chosenSign = st.fate.signs[chosenIdx];
    if (!chosenSign) return;
    st.fate.locked = true;
    const now = performance.now();

    st.fate.signs.forEach((s, idx) => {
      s.el.classList.add('is-disabled');
      if (idx === chosenIdx) {
        s.el.classList.add('is-chosen');
        s.chosenLiftTarget = -9.0;
        s.hoverTarget = 1;
        const badgeEl = s.el.querySelector('.pt-choice-sign-badge');
        if (badgeEl) badgeEl.textContent = '已落定';
      } else {
        s.hoverTarget = 0;
        s.mode = 'leaving';
        s.leaveFromY = s.currentEnterY;
        s.animStart = now + 70 + idx * 55;
        s.animDur = 460;
      }
    });

    const directive = chosenSign.data.directive || chosenSign.data.title;
    els.fateBannerText.textContent = `命运已落定 · ${directive}`;

    const onSelectCb = st.fate.onSelect;
    clearTimeout(st.fate.hideTimer);
    st.fate.hideTimer = setTimeout(() => {
      const tNow = performance.now();
      wakeStage();
      chosenSign.mode = 'leaving';
      chosenSign.leaveFromY = chosenSign.currentEnterY;
      chosenSign.animStart = tNow;
      chosenSign.animDur = 480;
      st.fate.visible = false;
      els.fateBanner.classList.remove('is-visible');
      choiceHost.classList.remove('is-visible');
      stageEl.classList.remove('is-pixel-fork-open');
      setTimeout(() => {
        if (!st.fate.visible) choiceHost.hidden = true;
      }, 520);
      if (typeof onSelectCb === 'function') {
        onSelectCb(directive);
      }
    }, 680);
  }

  function hideFateSignsImmediate() {
    clearTimeout(st.fate.hideTimer);
    st.fate.hideTimer = 0;
    st.fate.visible = false;
    st.fate.locked = false;
    st.fate.editingIndex = -1;
    st.fate.forkKey = '';
    st.fate.signs = [];
    els.fateSignsBox.innerHTML = '';
    els.fateBanner.classList.remove('is-visible');
    choiceHost.classList.remove('is-visible');
    choiceHost.hidden = true;
    stageEl.classList.remove('is-pixel-fork-open');
  }

  function syncFateFork(fork, {
    forkKey = '',
    shouldShow = false,
    onSelect = null,
    onCollapse = null,
  } = {}) {
    wakeStage();
    st.fate.onSelect = onSelect;
    st.fate.onCollapse = onCollapse;

    if (!st.active || !shouldShow || !fork || !Array.isArray(fork.choices) || !fork.choices.length) {
      if (st.fate.visible || !choiceHost.hidden) {
        hideFateSignsImmediate();
      }
      return;
    }

    if (st.fate.visible && st.fate.forkKey === forkKey && st.fate.signs.length > 0) {
      choiceHost.hidden = false;
      stageEl.classList.add('is-pixel-fork-open');
      return;
    }

    clearTimeout(st.fate.hideTimer);
    st.fate.forkKey = forkKey;
    st.fate.prompt = fork.prompt || '命运在此分岔，选择或亲手改写下一幕走向';
    st.fate.locked = false;
    st.fate.editingIndex = -1;
    st.fate.presetCursor += 1;

    const rawChoices = fork.choices.slice(0, 3);
    const propsMap = PROP_ASSETS[st.quality] || PROP_ASSETS.pixel;
    const propKeys = ['sign_a', 'sign_b', 'sign_c'];
    const items = rawChoices.map((c, i) => ({
      badge: `抉择 ${c.id || String.fromCharCode(65 + i)}`,
      title: String(c.label || '').trim(),
      sub: '点击高举落定',
      directive: String(c.label || '').trim(),
      prop: propKeys[i] || 'sign_a',
      isCustom: false,
    }));
    items.push({
      badge: '自定义',
      title: '书写你的抉择',
      sub: '点击木牌直接输入',
      directive: '',
      prop: 'sign_d',
      isCustom: true,
    });

    const count = items.length; // 3 或 4
    const presets = count <= 3 ? HUMAN_STAGGER_PRESETS_3 : HUMAN_STAGGER_PRESETS_4;
    const preset = presets[st.fate.presetCursor % presets.length];
    const centers = count === 2
      ? [36.0, 64.0]
      : count === 3
        ? [24.5, 50.0, 75.5]
        : [18.8, 39.6, 60.4, 81.2];
    const now = performance.now();

    els.fateSignsBox.innerHTML = '';
    st.fate.signs = [];
    els.fateBannerText.textContent = st.fate.prompt;

    items.forEach((item, idx) => {
      const card = document.createElement('div');
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
      card.className = 'pt-choice-sign-btn' + (count <= 3 ? ' is-three-mode' : '') + (item.isCustom ? ' is-custom-sign' : '');
      card.dataset.choiceIndex = String(idx);
      card.setAttribute('aria-label', `${item.badge}：${item.title}`);

      const img = document.createElement('img');
      img.className = 'pt-choice-sign-img';
      img.src = propsMap[item.prop] || propsMap.sign_a;
      img.alt = item.isCustom ? '命运抉择自定义输入木牌' : `命运抉择木牌 ${idx + 1}`;

      const face = document.createElement('div');
      face.className = 'pt-choice-sign-face';
      if (item.isCustom) {
        face.innerHTML = `
          <span class="pt-choice-sign-badge">${QUILL_ICON_SVG}<span>${escapeHtml(item.badge)}</span></span>
          <div class="pt-choice-idle-text">
            <div class="pt-choice-sign-title">${escapeHtml(item.title)}</div>
            <div class="pt-choice-sign-sub">${escapeHtml(item.sub)}</div>
          </div>
          <div class="pt-custom-editor">
            <input class="pt-custom-input" type="text" maxlength="48" placeholder="写下你想改写的剧情…" aria-label="输入自定义命运抉择">
            <div class="pt-custom-actions">
              <button type="button" class="pt-custom-act pt-custom-submit">落定</button>
              <button type="button" class="pt-custom-act pt-custom-cancel">取消</button>
            </div>
          </div>
        `;
      } else {
        face.innerHTML = `
          <span class="pt-choice-sign-badge">${escapeHtml(item.badge)}</span>
          <span class="pt-choice-sign-title">${escapeHtml(item.title)}</span>
          <span class="pt-choice-sign-sub">${escapeHtml(item.sub)}</span>
        `;
      }

      card.append(img, face);

      const pItem = preset[idx] || { raiseY: 0, shiftX: 0, tilt: 0 };
      const jitterY = (Math.random() - 0.5) * 0.9;
      const jitterX = (Math.random() - 0.5) * 0.3;
      const jitterRot = (Math.random() - 0.5) * 0.65;
      const leftPct = (centers[idx] || 50) + pItem.shiftX + jitterX;
      card.style.left = `${leftPct.toFixed(2)}%`;

      const signState = {
        index: idx,
        prop: item.prop,
        data: item,
        isCustom: item.isCustom,
        el: card,
        imgEl: img,
        baseOffsetY: pItem.raiseY + jitterY,
        baseRot: pItem.tilt + jitterRot,
        hover: 0,
        hoverTarget: 0,
        editing: 0,
        editingTarget: 0,
        freqY1: 1.42 + idx * 0.24 + Math.random() * 0.14,
        freqY2: 0.71 + idx * 0.17,
        phaseY1: idx * 1.95 + Math.random() * 1.4,
        phaseY2: idx * 1.25 + Math.random() * 2.0,
        freqX1: 0.88 + idx * 0.21 + Math.random() * 0.11,
        phaseX1: idx * 1.7 + Math.random() * 1.5,
        freqR1: 1.08 + idx * 0.22 + Math.random() * 0.13,
        freqR2: 0.52 + idx * 0.15,
        phaseR1: idx * 2.25 + Math.random() * 1.6,
        phaseR2: idx * 0.9 + Math.random() * 1.8,
        mode: 'entering',
        animStart: now + idx * 90,
        animDur: 740 + idx * 40,
        currentEnterY: 98,
        chosenLift: 0,
        chosenLiftTarget: 0,
        enterTiltBoost: idx < count / 2 ? -4.0 : 4.0,
      };

      card.addEventListener('mouseenter', () => {
        wakeStage();
        if (!st.fate.locked && st.fate.editingIndex === -1) signState.hoverTarget = 1;
      });
      card.addEventListener('mouseleave', () => {
        wakeStage();
        if (st.fate.editingIndex !== idx) signState.hoverTarget = 0;
      });

      if (item.isCustom) {
        const inp = face.querySelector('.pt-custom-input');
        const subBtn = face.querySelector('.pt-custom-submit');
        const canBtn = face.querySelector('.pt-custom-cancel');
        card.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (st.fate.locked || !st.fate.visible || st.fate.editingIndex === idx) return;
          enterCustomSignEdit(idx);
        });
        card.addEventListener('keydown', (ev) => {
          if (ev.target === card && (ev.key === 'Enter' || ev.key === ' ')) {
            ev.preventDefault();
            ev.stopPropagation();
            enterCustomSignEdit(idx);
          }
        });
        inp.addEventListener('click', (ev) => ev.stopPropagation());
        inp.addEventListener('keydown', (ev) => {
          ev.stopPropagation();
          if (ev.key === 'Enter' && !ev.isComposing) {
            ev.preventDefault();
            commitCustomSignInput(idx, inp.value);
          } else if (ev.key === 'Escape') {
            ev.preventDefault();
            exitCustomSignEdit(idx);
          }
        });
        subBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          commitCustomSignInput(idx, inp.value);
        });
        canBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          exitCustomSignEdit(idx);
        });
      } else {
        card.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (st.fate.editingIndex !== -1) exitCustomSignEdit(st.fate.editingIndex);
          handleFateChoiceClick(idx);
        });
        card.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            ev.stopPropagation();
            handleFateChoiceClick(idx);
          }
        });
      }

      els.fateSignsBox.appendChild(card);
      st.fate.signs.push(signState);
    });

    st.fate.visible = true;
    choiceHost.hidden = false;
    stageEl.classList.add('is-pixel-fork-open');
    requestAnimationFrame(() => {
      choiceHost.classList.add('is-visible');
      els.fateBanner.classList.add('is-visible');
    });
    renderFateSigns(0.016, now / 1000, now);
  }

  /* ---- 60FPS 主驱动循环 ---- */
  function renderLights(dt, nowSec) {
    if (!lightCtx) return;
    const w = els.lightsCanvas.width;
    const h = els.lightsCanvas.height;
    lightCtx.clearRect(0, 0, w, h);

    const visibility = Math.max(0, (st.curtainOpen - 0.1) / 0.9);
    if (visibility <= 0.01) return;

    const bgMeta = resolveBackdropMeta(st.backdropId);
    const [tr, tg, tb] = bgMeta ? bgMeta.lightTint : [255, 228, 176];

    lightCtx.save();
    lightCtx.globalCompositeOperation = 'screen';
    const sway = st.motionEnabled ? Math.sin(nowSec * 0.45) * 18 : 0;

    const beams = [
      { topX: w * 0.28, botX: w * 0.44 + sway, topW: 46, botW: 250, alpha: 0.095 },
      { topX: w * 0.72, botX: w * 0.56 - sway, topW: 46, botW: 250, alpha: 0.095 },
      { topX: w * 0.50, botX: w * 0.50 + sway * 0.4, topW: 60, botW: 290, alpha: 0.075 },
    ];
    for (const b of beams) {
      const grad = lightCtx.createLinearGradient(b.topX, h * 0.08, b.botX, h * 0.94);
      grad.addColorStop(0, `rgba(${tr}, ${tg}, ${tb}, ${(b.alpha * visibility).toFixed(3)})`);
      grad.addColorStop(0.65, `rgba(${tr}, ${tg}, ${tb}, ${(b.alpha * 0.42 * visibility).toFixed(3)})`);
      grad.addColorStop(1, `rgba(${tr}, ${tg}, ${tb}, 0)`);
      lightCtx.fillStyle = grad;
      lightCtx.beginPath();
      lightCtx.moveTo(b.topX - b.topW * 0.5, h * 0.06);
      lightCtx.lineTo(b.topX + b.topW * 0.5, h * 0.06);
      lightCtx.lineTo(b.botX + b.botW * 0.5, h * 0.94);
      lightCtx.lineTo(b.botX - b.botW * 0.5, h * 0.94);
      lightCtx.closePath();
      lightCtx.fill();
    }

    if (st.motionEnabled) {
      for (const p of particles) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.y < 0.12) {
          p.y = 0.86;
          p.x = 0.14 + Math.random() * 0.72;
        }
        if (p.x < 0.12) p.x = 0.88;
        if (p.x > 0.88) p.x = 0.12;
        const tw = 0.55 + 0.45 * Math.sin(nowSec * 2.1 + p.twinkle);
        const a = p.alpha * tw * visibility * 0.55;
        lightCtx.fillStyle = `rgba(${tr}, ${tg}, ${tb}, ${a.toFixed(3)})`;
        lightCtx.beginPath();
        lightCtx.arc(p.x * w, p.y * h, p.r, 0, Math.PI * 2);
        lightCtx.fill();
      }
    }
    lightCtx.restore();
  }

  function renderActors(dt, nowSec, nowMs) {
    for (const a of st.actors.values()) {
      const dx = a.targetX - a.x;
      const dy = a.targetY - a.y;
      const dist = Math.hypot(dx, dy);

      if (dist > 0.25) {
        const speed = a.moveMode === 'run' ? 28.5 : 18.5;
        const step = Math.min(dist, speed * dt);
        a.x += (dx / dist) * step;
        a.y += (dy / dist) * step;
        if (Math.abs(dx) > 0.15) a.facing = dx > 0 ? 1 : -1;
        const moveAct = a.moveMode === 'run' ? 'act_pao' : 'walk';
        if (!a.walking || (a.isPixel && a.action !== moveAct)) {
          const wasWalking = a.walking;
          a.walking = true;
          if (a.isPixel) applyActorVisualAction(a, moveAct, { resetElapsed: !wasWalking });
        }
      } else if (a.walking) {
        a.walking = false;
        a.moveMode = 'walk';
        if (a.isPixel) {
          if (a.postMoveAction) {
            const pAct = a.postMoveAction;
            const pDur = a.postMoveDurationMs || 3200;
            a.postMoveAction = '';
            a.postMoveDurationMs = 0;
            a.overrideAction = pAct;
            a.overrideUntil = performance.now() + pDur;
            applyActorVisualAction(a, pAct, { resetElapsed: true });
          } else {
            const isSpk = a.id === st.activeSpeakerId;
            const nextAct = a.overrideAction || resolveMoodToPixelAction(a.id, a.mood, { speaking: isSpk });
            applyActorVisualAction(a, nextAct, { resetElapsed: true });
          }
        }
      }

      if (a.isPixel && a.overrideAction && a.overrideUntil > 0 && nowMs >= a.overrideUntil && !a.walking) {
        a.overrideAction = '';
        a.overrideUntil = 0;
        const isSpk = a.id === st.activeSpeakerId;
        const nextAct = resolveMoodToPixelAction(a.id, a.mood, { speaking: isSpk });
        applyActorVisualAction(a, nextAct, { resetElapsed: true });
      }

      if (a.isPixel && a.spriteEl) {
        const cat = PIXEL_ACTOR_CATALOG[a.id];
        const act = cat?.actions?.[a.action] || cat?.actions?.idle;
        if (act && act.frames > 1) {
          if (st.motionEnabled || a.walking) {
            a.animElapsedMs += dt * 1000;
          }
          const frameIdx = Math.floor(a.animElapsedMs / act.durMs) % act.frames;
          const pct = (frameIdx / (act.frames - 1)) * 100;
          a.spriteEl.style.backgroundPosition = `${pct.toFixed(4)}% 0%`;
        }
        let flipX = 1;
        if ((a.action === 'walk' || a.action === 'act_pao') && cat) {
          const nativeFacing = (act && typeof act.nativeFacing === 'number') ? act.nativeFacing : cat.defaultFacing;
          flipX = a.facing === nativeFacing ? 1 : -1;
        }
        a.spriteEl.style.transform = `scaleX(${flipX})`;
      } else if (a.fallbackEl) {
        const bob = st.motionEnabled ? Math.sin(nowSec * 2.4 + a.phase) * 2.2 : 0;
        const tilt = a.walking ? Math.sin(nowSec * 12) * 3.5 : 0;
        a.fallbackEl.style.transform = `translateY(${bob.toFixed(2)}px) rotate(${tilt.toFixed(2)}deg)`;
      }

      const depthT = (a.y - 63.5) / 24.0;
      const perspScale = 0.88 + Math.max(0, Math.min(1, depthT)) * 0.24;
      a.el.style.left = `${a.x.toFixed(2)}%`;
      a.el.style.top = `${a.y.toFixed(2)}%`;
      a.el.style.zIndex = String(Math.round(a.y * 10));
      a.el.style.transform = `translate(-50%, -96%) scale(${perspScale.toFixed(3)})`;
    }
  }

  function renderFateSigns(dt, nowSec, nowMs) {
    if (!st.fate.signs.length) return;
    for (const s of st.fate.signs) {
      s.hover += (s.hoverTarget - s.hover) * Math.min(1, dt * 10);
      s.editing += (s.editingTarget - s.editing) * Math.min(1, dt * 11);
      s.chosenLift += (s.chosenLiftTarget - s.chosenLift) * Math.min(1, dt * 9);

      let enterY = s.currentEnterY;
      let enterRotExtra = 0;

      if (s.mode === 'entering') {
        if (nowMs < s.animStart) {
          enterY = 98;
          enterRotExtra = s.enterTiltBoost;
        } else {
          const t = Math.min(1, (nowMs - s.animStart) / s.animDur);
          const e = easeOutBackSoft(t);
          enterY = 98 * (1 - e);
          enterRotExtra = s.enterTiltBoost * (1 - Math.min(1, t * 1.15));
          if (t >= 1) {
            s.mode = 'idle';
            enterY = 0;
            enterRotExtra = 0;
          }
        }
      } else if (s.mode === 'leaving') {
        if (nowMs >= s.animStart) {
          const t = Math.min(1, (nowMs - s.animStart) / s.animDur);
          const e = easeInCubic(t);
          enterY = (s.leaveFromY || 0) + (102 - (s.leaveFromY || 0)) * e;
          if (t >= 1) {
            s.mode = 'hidden';
            enterY = 102;
          }
        }
      } else if (s.mode === 'hidden') {
        enterY = 102;
      }

      s.currentEnterY = enterY;

      const motionDamp = st.motionEnabled ? 1 : 0;
      const breathDamp = (s.mode === 'hidden' ? 0 : (1 - 0.78 * s.editing)) * motionDamp;
      const breathY = (
        Math.sin(nowSec * s.freqY1 + s.phaseY1) * 1.35 +
        Math.sin(nowSec * s.freqY2 + s.phaseY2) * 0.55
      ) * breathDamp;
      const swayX = (
        Math.sin(nowSec * s.freqX1 + s.phaseX1) * 1.0 +
        Math.cos(nowSec * (s.freqX1 * 0.53) + s.phaseY2) * 0.35
      ) * breathDamp;
      const swayRot = (
        Math.sin(nowSec * s.freqR1 + s.phaseR1) * 1.45 +
        Math.sin(nowSec * s.freqR2 + s.phaseR2) * 0.48
      ) * breathDamp;

      const hoverLiftY = -4.8 * s.hover - 3.6 * s.editing;
      const totalY = s.baseOffsetY + enterY + breathY + hoverLiftY + s.chosenLift;
      const rotKeep = (1 - 0.55 * s.hover) * (1 - 0.92 * s.editing);
      const totalRot = (s.baseRot * rotKeep) + swayRot * (1 - 0.35 * s.hover) + enterRotExtra;
      const totalScale = 1 + 0.03 * s.hover + 0.065 * s.editing + (s.chosenLiftTarget < 0 ? 0.035 : 0);

      s.el.style.transform =
        `translate3d(calc(-50% + ${swayX.toFixed(2)}%), ${totalY.toFixed(2)}%, 0) rotate(${totalRot.toFixed(2)}deg) scale(${totalScale.toFixed(3)})`;
    }
  }

  function wakeStage() {
    if (!st.active || st.rafId) return;
    st.lastTs = performance.now();
    st.rafId = requestAnimationFrame(tick);
  }

  function tick(now) {
    if (!st.active) {
      st.rafId = 0;
      return;
    }
    const dt = st.lastTs ? Math.min(0.05, (now - st.lastTs) / 1000) : 0.016;
    st.lastTs = now;
    const nowSec = now / 1000;

    if (st.curtainAnimating) {
      const elapsed = now - st.curtainAnimStart;
      const t = Math.min(1, elapsed / st.curtainAnimDuration);
      const val = st.curtainAnimFrom + (st.curtainTarget - st.curtainAnimFrom) * easeInOutCubic(t);
      applyCurtainProgress(val);
      if (t >= 1) st.curtainAnimating = false;
    }

    renderLights(dt, nowSec);
    renderActors(dt, nowSec, now);
    renderFateSigns(dt, nowSec, now);
    const needsFrame = st.motionEnabled || st.curtainAnimating ||
      [...st.actors.values()].some(a => a.walking || a.overrideUntil > now) ||
      st.fate.signs.some(s => s.mode === 'entering' || s.mode === 'leaving' ||
        Math.abs(s.hoverTarget - s.hover) > 0.01 || Math.abs(s.editingTarget - s.editing) > 0.01 ||
        Math.abs(s.chosenLiftTarget - s.chosenLift) > 0.01);
    st.rafId = needsFrame ? requestAnimationFrame(tick) : 0;
  }

  function setActive(nextActive, { playOpeningCurtain = false } = {}) {
    const active = Boolean(nextActive);
    st.active = active;
    root.hidden = !active;
    stageEl.classList.toggle('is-pixel-theater', active);

    if (active) {
      applyLayerAssets();
      if (playOpeningCurtain && st.motionEnabled) {
        applyCurtainProgress(0.0);
        animateCurtainTo(1.0, 980);
      } else {
        applyCurtainProgress(st.curtainOpen);
      }
      wakeStage();
    } else {
      if (st.rafId) {
        cancelAnimationFrame(st.rafId);
        st.rafId = 0;
      }
      hideFateSignsImmediate();
    }
  }

  // 事件绑定（全部使用 addEventListener，严格 CSP 合规）
  els.floorHitbox.addEventListener('click', handleFloorClick);

  els.fateCollapseBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const cb = st.fate.onCollapse;
    hideFateSignsImmediate();
    if (typeof cb === 'function') cb();
  });

  // 支持拖拽本地图片直接替换像素剧院幕景背景
  let dragCounter = 0;
  stageEl.addEventListener('dragenter', (ev) => {
    if (!st.active) return;
    if (!ev.dataTransfer || !Array.from(ev.dataTransfer.types || []).includes('Files')) return;
    ev.preventDefault();
    dragCounter += 1;
    els.dropOverlay.classList.add('is-visible');
  });
  stageEl.addEventListener('dragover', (ev) => {
    if (!st.active) return;
    if (!ev.dataTransfer || !Array.from(ev.dataTransfer.types || []).includes('Files')) return;
    ev.preventDefault();
  });
  stageEl.addEventListener('dragleave', () => {
    if (!st.active) return;
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) els.dropOverlay.classList.remove('is-visible');
  });
  stageEl.addEventListener('drop', (ev) => {
    if (!st.active) return;
    dragCounter = 0;
    els.dropOverlay.classList.remove('is-visible');
    const file = ev.dataTransfer?.files?.[0];
    if (!file || !String(file.type || '').startsWith('image/')) return;
    ev.preventDefault();
    if (typeof hooks.onDropCustomBackdrop === 'function') {
      hooks.onDropCustomBackdrop(file);
    }
  });

  applyLayerAssets();
  applyCurtainProgress(1.0);

  return {
    setActive,
    isActive: () => st.active,
    setMotionEnabled(enabled) {
      wakeStage();
      st.motionEnabled = Boolean(enabled);
    },
    setQuality(q) {
      st.quality = q === 'hd' ? 'hd' : 'pixel';
      applyLayerAssets();
    },
    getQuality: () => st.quality,
    setBackdrop,
    getBackdropId: () => st.backdropId,
    getBackdropUrl() {
      if (st.backdropId === 'custom' && st.customBgUrl) return st.customBgUrl;
      const meta = resolveBackdropMeta(st.backdropId);
      return st.quality === 'pixel' ? meta.pixel : meta.hd;
    },
    toggleCurtain() {
      const nextTarget = st.curtainOpen >= 0.5 ? 0.0 : 1.0;
      animateCurtainTo(nextTarget, 1150);
      return nextTarget;
    },
    animateCurtainTo,
    getCurtainOpen: () => st.curtainOpen,
    syncCast,
    directByStoryLine,
    triggerActorAction,
    clearActorOverrides,
    triggerEasterEgg,
    syncFateFork,
    isFateVisible: () => st.fate.visible,
  };
}
