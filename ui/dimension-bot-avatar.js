// DimensionBot：维度 Agent 默认动态头像
// 造型：整颗撑满头像框的极简圆球 + 只有一对灵动眼睛 + 球顶探出的嫩绿小草芽呆毛。
// 物理：两自由度弹簧-阻尼-重力-惯性实时物理模拟（主茎摆角 θ + 叶尖弹性弯曲 bend），
//       对球体呼吸起伏、鼠标划过速度、悬停蹦跳、思考节奏与页面滚动惯性产生真实的 Q 弹摆动。
// 性能：单全局 rAF 仅更新视口内可见头像的草茎贝塞尔路径与叶片 transform，零 innerHTML 重建；
//       页面隐藏 / motion="off" / prefers-reduced-motion 时自动暂停。

const STATES = new Set(['idle', 'thinking']);

function escapeAttr(value) {
  return String(value ?? '').replace(/[&"<>]/g, (ch) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[ch]));
}

function normalizeHex(color) {
  const raw = String(color || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
  if (/^#[0-9a-f]{3}$/i.test(raw)) return `#${raw.slice(1).split('').map((c) => c + c).join('')}`;
  return '#2A2723';
}

function isLightColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6;
}

// 名字决定稳定的“性格相位”：不同伙伴的眨眼、呼吸与草芽摇曳自然错开。
function phaseFrom(name) {
  let h = 2166136261;
  for (const ch of String(name || 'DimensionBot')) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 9000) / 1000;
}

function eye(cx) {
  return `<g class="dbot-eye" style="transform-origin:${cx}px 50px">`
    + `<ellipse class="dbot-sclera" cx="${cx}" cy="50" rx="8.2" ry="10.2"/>`
    + `<g class="dbot-pupils"><ellipse class="dbot-pupil" cx="${cx + 0.7}" cy="51.2" rx="5.1" ry="6.5"/>`
    + `<circle class="dbot-glint" cx="${cx + 2.6}" cy="47.4" r="2.1"/><circle class="dbot-glint is-small" cx="${cx - 1.2}" cy="54.2" r="0.95"/></g>`
    + '</g>';
}

// 球顶 (50, 7.5) 向上长出的默认静止态嫩芽
const ROOT_X = 50;
const ROOT_Y = 7.5;
const STEM_LEN = 18.5;
const INITIAL_STEM = 'M50 7.5 Q52 -2.8 52.8 -10.8';

export function dimensionBotSvg() {
  return '<svg class="dbot-svg" viewBox="0 0 100 100" focusable="false">'
    + '<g class="dbot-float"><g class="dbot-squash">'
    + '<g class="dbot-ahoge">'
    + `<path class="dbot-sprout-stem" d="${INITIAL_STEM}"/>`
    + '<g class="dbot-sprout-head" transform="translate(52.8 -10.8) rotate(8)">'
    + '<path class="dbot-leaf is-left" d="M0 0 C-3.2 -6.2 -11.4 -9.4 -15.4 -5.2 C-11.2 -0.6 -4.6 1.5 0 0 Z"/>'
    + '<path class="dbot-leaf is-right" d="M0 0 C3.0 -7.6 12.0 -10.8 16.6 -6.0 C11.8 -0.8 5.2 1.5 0 0 Z"/>'
    + '<path class="dbot-leaf-vein" d="M-1.5 -0.8 Q-7.0 -4.0 -11.4 -4.9 M1.5 -0.8 Q7.6 -4.5 12.4 -5.6"/>'
    + '</g>'
    + '</g>'
    + '<circle class="dbot-body" cx="50" cy="52" r="46"/>'
    + '<ellipse class="dbot-shine" cx="32" cy="27" rx="11.5" ry="5.6" transform="rotate(-32 32 27)"/>'
    + `<g class="dbot-face">${eye(35.5)}${eye(64.5)}</g>`
    + '</g></g></svg>';
}

/**
 * 返回 DimensionBot 头像的 HTML 字符串（可直接拼入 innerHTML）。
 * @param {string} name   伙伴名，用于稳定的动效相位
 * @param {string} color  印章色 #RRGGBB
 * @param {number} size   像素尺寸
 * @param {'idle'|'thinking'} state
 */
export function dimensionBotAvatar(name, color, size = 40, state = 'idle') {
  const hex = normalizeHex(color);
  const mode = STATES.has(state) ? state : 'idle';
  const px = Math.max(12, Math.round(Number(size) || 40));
  const classes = ['dimension-bot', `is-${mode}`];
  if (isLightColor(hex)) classes.push('is-light');
  if (px < 28) classes.push('is-tiny');
  const phase = phaseFrom(name);
  return `<span class="${classes.join(' ')}" data-state="${mode}" data-phase="${phase.toFixed(2)}" style="width:${px}px;height:${px}px;--dbot-color:${escapeAttr(hex)};--dbot-phase:-${phase.toFixed(2)}s" aria-hidden="true">${dimensionBotSvg()}</span>`;
}

/* ───────────── 小草芽呆毛物理模拟引擎（弹簧 + 阻尼 + 重力 + 惯性） ───────────── */
const physMap = new WeakMap();
let started = false;
let rafId = 0;
let lastTime = 0;
let lastPtrX = null;
let lastPtrY = null;
let lastPtrT = 0;
let globalScrollImpulse = 0;

function getMotionLevel() {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return 'off';
  return document.documentElement.dataset.motion || 'full';
}

function getPhys(el) {
  let p = physMap.get(el);
  if (p) return p;
  const phase = Number(el.dataset.phase) || 0;
  p = {
    phase,
    angle: 0.14,
    angVel: 0,
    bend: 0.06,
    bendVel: 0,
    impX: 0,
    impY: 0,
    lastY: null,
    stem: el.querySelector('.dbot-sprout-stem'),
    head: el.querySelector('.dbot-sprout-head'),
    leafL: el.querySelector('.dbot-leaf.is-left'),
    leafR: el.querySelector('.dbot-leaf.is-right'),
  };
  physMap.set(el, p);
  return p;
}

function kickBot(el, ix, iy = 0) {
  if (!el) return;
  const p = getPhys(el);
  p.impX += ix;
  p.impY += iy;
}

let idleFrames = 0;

function stepPhysics(now) {
  rafId = 0;
  if (document.hidden || getMotionLevel() === 'off') {
    lastTime = 0;
    idleFrames = 0;
    return;
  }
  const dt = lastTime ? Math.min(0.036, Math.max(0.008, (now - lastTime) / 1000)) : 0.016;
  lastTime = now;

  const t = now / 1000;
  const isLite = getMotionLevel() === 'lite';
  const amp = isLite ? 0.52 : 1.0;

  const bots = document.querySelectorAll('.dimension-bot');
  const vh = window.innerHeight || 900;
  let anyActive = Math.abs(globalScrollImpulse) >= 0.01;

  for (const el of bots) {
    const p = getPhys(el);
    if (!p.stem || !p.head) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.bottom < -40 || rect.top > vh + 40) {
      p.lastY = null;
      continue;
    }

    // 感知头像在屏幕上的纵向位移（列表滚动、消息顶起等）转化为真实重力惯性
    let bodyAy = 0;
    if (p.lastY !== null) {
      const dy = rect.top - p.lastY;
      if (Math.abs(dy) > 0.3 && Math.abs(dy) < 120) {
        bodyAy = Math.max(-18, Math.min(18, dy * 0.28));
      }
    }
    p.lastY = rect.top;

    const thinking = el.classList.contains('is-thinking');
    if (thinking || Math.abs(bodyAy) > 0.05 || Math.abs(p.impX) > 0.01 || Math.abs(p.impY) > 0.01) {
      anyActive = true;
    }
    const ph = t + p.phase;

    const restAngle = thinking
      ? 0.18 * Math.sin(ph * 2.8) * amp + 0.08
      : 0.08;
    const breeze = thinking
      ? (Math.sin(ph * 2.1) * 1.45 + Math.sin(ph * 3.7 + 1.2) * 0.9) * amp
      : 0;
    const breathAy = thinking ? Math.cos(ph * 2.85) * 2.6 * amp : 0;

    // 欠阻尼弹簧 + 阻力 + 重力倒摆 + 动态惯性冲量
    const stiffness = thinking ? 86 : 66;
    const damping = isLite ? 6.4 : 4.8;
    const gravityTorque = 15.0 * Math.sin(p.angle);
    const verticalSquash = (bodyAy + breathAy + p.impY + globalScrollImpulse) * Math.sin(p.angle + 0.25) * 2.3;

    const angAcc = -stiffness * (p.angle - restAngle)
      - damping * p.angVel
      + gravityTorque * 0.42
      + breeze
      + p.impX * 28
      + verticalSquash;

    p.angVel += angAcc * dt;
    p.angle += p.angVel * dt;
    if (p.angle > 1.05) { p.angle = 1.05; p.angVel *= -0.45; }
    else if (p.angle < -1.05) { p.angle = -1.05; p.angVel *= -0.45; }

    // 叶尖二阶弹性弯曲：耦合主茎角加速度，产生柔韧的鞭梢滞后 Q 弹弧度
    const bendAcc = -120 * (p.bend - p.angle * 0.36)
      - 6.0 * p.bendVel
      - angAcc * 0.024
      + (bodyAy + breathAy) * 0.14;
    p.bendVel += bendAcc * dt;
    p.bend += p.bendVel * dt;
    p.bend = Math.max(-0.85, Math.min(0.85, p.bend));

    p.impX *= 0.65;
    p.impY *= 0.65;
    if (Math.abs(p.impX) < 0.005) p.impX = 0;
    if (Math.abs(p.impY) < 0.005) p.impY = 0;

    if (Math.abs(p.angVel) > 0.015 || Math.abs(p.bendVel) > 0.015) {
      anyActive = true;
    }

    const tipAngle = p.angle + p.bend * 0.56;
    const stretch = Math.max(0.85, Math.min(1.15, 1 - (bodyAy + p.impY) * 0.008));
    const len = STEM_LEN * stretch;

    const ctrlX = ROOT_X + Math.sin(p.angle * 0.55) * (len * 0.56);
    const ctrlY = ROOT_Y - Math.cos(p.angle * 0.55) * (len * 0.56);
    const tipX = ROOT_X + Math.sin(tipAngle) * len;
    const tipY = ROOT_Y - Math.cos(tipAngle) * len;
    const headDeg = (tipAngle + p.bend * 0.48) * (180 / Math.PI);

    p.stem.setAttribute('d', `M${ROOT_X} ${ROOT_Y} Q${ctrlX.toFixed(2)} ${ctrlY.toFixed(2)} ${tipX.toFixed(2)} ${tipY.toFixed(2)}`);
    p.head.setAttribute('transform', `translate(${tipX.toFixed(2)} ${tipY.toFixed(2)}) rotate(${headDeg.toFixed(2)})`);

    if (p.leafL && p.leafR) {
      const flap = Math.max(-15, Math.min(15, p.angVel * 2.5 + p.bendVel * 1.15));
      p.leafL.setAttribute('transform', `rotate(${(-flap * 0.72).toFixed(1)})`);
      p.leafR.setAttribute('transform', `rotate(${(flap * 0.72).toFixed(1)})`);
    }
  }

  globalScrollImpulse *= 0.75;
  if (Math.abs(globalScrollImpulse) < 0.01) globalScrollImpulse = 0;

  if (anyActive) {
    idleFrames = 0;
    rafId = requestAnimationFrame(stepPhysics);
  } else {
    idleFrames++;
    if (idleFrames < 45) {
      rafId = requestAnimationFrame(stepPhysics);
    } else {
      // Automatically hibernate physics rAF once all springs have settled; pointer/scroll/click wakes it up via ensureRunning()
      lastTime = 0;
    }
  }
}

function ensureRunning() {
  if (rafId || document.hidden || getMotionLevel() === 'off') return;
  lastTime = 0;
  rafId = requestAnimationFrame(stepPhysics);
}

/** 启动所有 DimensionBot 的小草芽物理模拟与交互响应。可重复调用。 */
export function startDimensionBots() {
  if (started) { ensureRunning(); return; }
  started = true;

  const sync = () => {
    const paused = document.hidden || getMotionLevel() === 'off';
    document.documentElement.classList.toggle('dbot-paused', paused);
    if (paused && rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
      lastTime = 0;
    } else if (!paused) {
      ensureRunning();
    }
  };

  document.addEventListener('visibilitychange', sync);
  new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  window.matchMedia?.('(prefers-reduced-motion: reduce)')?.addEventListener?.('change', sync);

  // 鼠标划过头像或其宿主条目：鼠标速度转化为风力/拨动冲量，让小草芽 Q 弹甩动
  document.addEventListener('pointermove', (e) => {
    if (getMotionLevel() === 'off') return;
    const now = performance.now();
    const dt = Math.max(8, now - lastPtrT);
    const vx = lastPtrX === null ? 0 : (e.clientX - lastPtrX) / dt;
    const vy = lastPtrY === null ? 0 : (e.clientY - lastPtrY) / dt;
    lastPtrX = e.clientX;
    lastPtrY = e.clientY;
    lastPtrT = now;

    const host = e.target?.closest?.('.dimension-bot, .bot-item, .pinned-item, .seal-slot, .group-member');
    if (!host) return;
    const bot = host.classList?.contains('dimension-bot') ? host : host.querySelector?.('.dimension-bot');
    if (!bot) return;
    const clampedVx = Math.max(-2.4, Math.min(2.4, vx));
    const clampedVy = Math.max(-2.0, Math.min(2.0, vy));
    kickBot(bot, clampedVx * 1.2, clampedVy * 1.4);
  }, { passive: true });

  // 悬停进入：配合球体蹦一下给小草芽向后仰再回弹的惯性冲量
  document.addEventListener('pointerover', (e) => {
    if (getMotionLevel() === 'off') return;
    const host = e.target?.closest?.('.dimension-bot, .bot-item, .pinned-item, .seal-slot, .group-member');
    if (!host || (e.relatedTarget && host.contains(e.relatedTarget))) return;
    const bot = host.classList?.contains('dimension-bot') ? host : host.querySelector?.('.dimension-bot');
    if (bot) kickBot(bot, (Math.random() > 0.5 ? 1 : -1) * 1.15, -3.4);
  }, { passive: true });

  // 点击头像或伙伴项：清脆的 Q 弹点点头冲量
  document.addEventListener('pointerdown', (e) => {
    if (getMotionLevel() === 'off') return;
    const host = e.target?.closest?.('.dimension-bot, .bot-item, .pinned-item, .seal-slot, .group-member');
    if (!host) return;
    const bot = host.classList?.contains('dimension-bot') ? host : host.querySelector?.('.dimension-bot');
    if (bot) kickBot(bot, 1.4, 4.4);
  }, { passive: true });

  // 滚轮滚动：给屏幕内所有小草芽施加风压/惯性
  document.addEventListener('wheel', (e) => {
    if (getMotionLevel() === 'off') return;
    globalScrollImpulse = Math.max(-6, Math.min(6, globalScrollImpulse + (e.deltaY > 0 ? 1.8 : -1.8)));
  }, { passive: true });

  sync();
}
