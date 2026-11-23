/*
 * DimensionAgent 0.5.1 Anime Atelier Copywriting & Motion FX Engine
 * Theme: 温润轻小说手账 · 二次元沙龙与琥珀星屑特效
 * Copyright (c) 2026 Lzum1Guce.
 */

const ATELIER_QUOTES = [
  '“每一句不经意的闲聊，都会在入梦整理时凝成只属于你们的记忆星屑。”',
  '“把繁琐的工程交给幕僚圆桌吧，你只管留住最初那一瞬的心动与灵感。”',
  '“所谓默契，就是不必把话说满，对方也听得懂你标点符号里的余温。”',
  '“推开茶会的门是日常物语，点亮工坊的灯便是并肩作战的序章。”',
  '“真正鲜活的灵魂从不靠死记硬背，而是记得与你并肩看过的每一场风景。”',
  '“今日份的奇思妙想，无论是半页草稿还是天马行空，都值得被认真回应。”',
  '“私密的心事锁进结界，公开的喜好带去茶会——分寸感也是羁绊的一部分。”',
  '“当琥珀色的星屑落满羊皮卷，新的篇章就已经悄然启程了。”',
  '“不必急着想好完美开场白，轻轻敲门的那一刻，故事就已经开始了。”',
  '“首席主理执笔统筹，众幕僚于幕后推演——你的圆桌永远为你留着主位。”',
];

export function getAtelierGreeting(now = new Date()) {
  const h = now.getHours();
  if (h >= 5 && h < 11) {
    return {
      badge: '✦ 朝露微光 · 晨间茶会',
      title: '早安，今日份的灵感羊皮卷已经铺开',
      sub: '在左侧点亮一枚伙伴印章开启私语，或推开茶会圆桌的门扉吧',
    };
  }
  if (h >= 11 && h < 14) {
    return {
      badge: '✦ 暖阳午憩 · 日间沙龙',
      title: '午安，茶香正好，聊点奇思妙想吗？',
      sub: '无论是轻松的午间闲谈，还是交办一份新委托，伙伴们都已就座待命',
    };
  }
  if (h >= 14 && h < 18) {
    return {
      badge: '✦ 琥珀斜阳 · 午后工坊',
      title: '欢迎归来，微风正适合酝酿新的物语',
      sub: '唤醒一位契约伙伴闲话家常，或召集圆桌幕僚合力锻造成品吧',
    };
  }
  if (h >= 18 && h < 23) {
    return {
      badge: '✦ 暮色灯火 · 晚间谈话室',
      title: '今日辛苦啦，挑一盏暖灯坐下聊聊吧',
      sub: '白昼的忙碌暂告段落，把未竟的脑洞或闲适心情交给身边的伙伴',
    };
  }
  return {
    badge: '✦ 星夜未眠 · 守夜人工坊',
    title: '夜深了，星屑与思绪仍在静静发光',
    sub: '守夜的伙伴还没有睡，随时陪你把灵光一闪变成触手可及的作品',
  };
}

// 系统“减少动画”或客户端设置里把界面动效调到「精简 / 关闭」时，都不生成粒子与装饰特效
const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ||
    ['lite', 'off'].includes(document.documentElement?.dataset?.motion));

let fxLayer = null;
function ensureFxLayer() {
  if (fxLayer && fxLayer.isConnected) return fxLayer;
  fxLayer = document.createElement('div');
  fxLayer.id = 'atelierFxLayer';
  fxLayer.className = 'atelier-fx-layer';
  fxLayer.setAttribute('aria-hidden', 'true');
  document.body.appendChild(fxLayer);
  return fxLayer;
}

const SPARK_COLORS = [
  'var(--color-accent)',
  '#e89b54',
  '#f0b86e',
  '#d96b43',
  '#f4cfa0',
];

export function spawnStardustBurst(x, y, { count = 7, spread = 44 } = {}) {
  if (prefersReducedMotion()) return;
  if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return;
  const layer = ensureFxLayer();
  if (layer.childElementCount > 48) return;

  const ring = document.createElement('span');
  ring.className = 'atelier-click-halo';
  ring.style.left = `${x}px`;
  ring.style.top = `${y}px`;
  layer.appendChild(ring);
  const ringAnim = ring.animate(
    [
      { transform: 'translate(-50%, -50%) scale(0.25)', opacity: 0.72 },
      { transform: 'translate(-50%, -50%) scale(1.65)', opacity: 0 },
    ],
    { duration: 440, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
  );
  ringAnim.onfinish = () => ring.remove();

  for (let i = 0; i < count; i++) {
    const node = document.createElement('span');
    const isStar = i % 2 === 0;
    node.className = isStar ? 'atelier-spark is-star' : 'atelier-spark is-dot';
    if (isStar) node.textContent = '✦';
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.style.color = SPARK_COLORS[i % SPARK_COLORS.length];

    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.55;
    const dist = spread * (0.52 + Math.random() * 0.62);
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist - 8;
    const rot = (Math.random() - 0.5) * 140;
    const scaleStart = isStar ? 0.55 + Math.random() * 0.45 : 0.7 + Math.random() * 0.5;

    layer.appendChild(node);
    const anim = node.animate(
      [
        {
          transform: `translate(-50%, -50%) translate(0px, 0px) scale(${scaleStart}) rotate(0deg)`,
          opacity: 0.96,
        },
        {
          transform: `translate(-50%, -50%) translate(${dx.toFixed(1)}px, ${(dy + 10).toFixed(1)}px) scale(0.12) rotate(${rot.toFixed(0)}deg)`,
          opacity: 0,
        },
      ],
      {
        duration: 460 + Math.round(Math.random() * 180),
        easing: 'cubic-bezier(0.18, 0.88, 0.32, 1)',
      }
    );
    anim.onfinish = () => node.remove();
  }
}

function buildMoteField(moteCount = 7) {
  const field = document.createElement('div');
  field.className = 'atelier-mote-field';
  field.setAttribute('aria-hidden', 'true');
  if (prefersReducedMotion()) return field;
  for (let i = 0; i < moteCount; i++) {
    const mote = document.createElement('span');
    mote.className = i % 3 === 0 ? 'atelier-mote is-star' : 'atelier-mote';
    if (i % 3 === 0) mote.textContent = '✦';
    const left = 22 + ((i * 67) % 56);
    const top = 24 + ((i * 41) % 52);
    const dur = 5.8 + (i % 5) * 1.2;
    const delay = -((i * 1.45) % 6);
    mote.style.setProperty('--mote-x', `${left}%`);
    mote.style.setProperty('--mote-y', `${top}%`);
    mote.style.setProperty('--mote-dur', `${dur.toFixed(2)}s`);
    mote.style.setProperty('--mote-delay', `${delay.toFixed(2)}s`);
    field.appendChild(mote);
  }
  return field;
}

let quoteCursor = Math.floor(Math.random() * ATELIER_QUOTES.length);

function enhanceWelcomeNode(welcome) {
  if (!welcome || welcome.dataset.atelierEnhanced === '1') return;
  welcome.dataset.atelierEnhanced = '1';

  const greeting = getAtelierGreeting();
  const img = welcome.querySelector('img');
  const origP = welcome.querySelector('p');

  if (img) {
    const haloWrap = document.createElement('div');
    haloWrap.className = 'atelier-wordmark-halo atelier-wordmark-float';
    img.parentNode.insertBefore(haloWrap, img);
    haloWrap.appendChild(img);
  }

  const heading = document.createElement('h2');
  heading.className = 'atelier-welcome-title';
  heading.textContent = greeting.title;

  if (origP) {
    origP.className = 'atelier-welcome-sub';
    origP.textContent = greeting.sub;
  }

  const quoteBtn = document.createElement('button');
  quoteBtn.type = 'button';
  quoteBtn.className = 'atelier-quote-pill';
  quoteBtn.title = '点击抽取下一枚次元灵感签';

  const quoteTag = document.createElement('span');
  quoteTag.className = 'atelier-quote-tag';
  quoteTag.textContent = '✦ 次元签';

  const quoteText = document.createElement('span');
  quoteText.className = 'atelier-quote-text';
  quoteText.textContent = ATELIER_QUOTES[quoteCursor % ATELIER_QUOTES.length];

  const quoteHint = document.createElement('span');
  quoteHint.className = 'atelier-quote-refresh';
  quoteHint.textContent = '换一句 ↻';

  quoteBtn.append(quoteTag, quoteText, quoteHint);
  quoteBtn.addEventListener('click', (ev) => {
    quoteCursor = (quoteCursor + 1) % ATELIER_QUOTES.length;
    const rect = quoteBtn.getBoundingClientRect();
    const cx = ev.clientX || rect.left + rect.width / 2;
    const cy = ev.clientY || rect.top + rect.height / 2;
    spawnStardustBurst(cx, cy, { count: 6, spread: 36 });
    quoteText.classList.remove('is-flipping');
    void quoteText.offsetWidth;
    quoteText.textContent = ATELIER_QUOTES[quoteCursor];
    quoteText.classList.add('is-flipping');
  });

  // 欢迎页已有 motion-fx 季节星天层，仅叠加少量轻柔近景光尘，避免视觉过密
  welcome.prepend(buildMoteField(3));
  if (origP) {
    welcome.insertBefore(heading, origP);
    welcome.appendChild(quoteBtn);
  } else {
    welcome.append(heading, quoteBtn);
  }
}

function enhanceWorkNewStage(stage) {
  if (!stage || stage.dataset.atelierEnhanced === '1') return;
  stage.dataset.atelierEnhanced = '1';
  stage.prepend(buildMoteField(7));
  const cards = stage.querySelectorAll('.work-starter-card');
  cards.forEach((card, idx) => {
    card.style.setProperty('--stagger-i', String(idx));
  });
}

function applyStaggerIndices(root) {
  if (!root) return;
  root.querySelectorAll('.drawer-item, .pwb-card').forEach((item, idx) => {
    item.style.setProperty('--stagger-i', String(idx));
  });
}

function triggerComposerSweep() {
  if (prefersReducedMotion()) return;
  const card = document.getElementById('composerCard');
  if (!card) return;
  card.classList.remove('is-launching');
  void card.offsetWidth;
  card.classList.add('is-launching');
  window.setTimeout(() => card.classList.remove('is-launching'), 680);
}

const STARDUST_SELECTOR = [
  '.work-starter-card',
  '.pwb-card',
  '.drawer-item',
  '.lm-sleep-btn',
  '.sidebar-dock-workbench',
  '#identityBtn',
  '.create-menu-item',
].join(', ');

const SPOTLIGHT_SELECTOR = '.work-starter-card, .pwb-card, .drawer-item, .lm-affect-card, .lm-mind-card';

let initialized = false;

export function initAnimeFx() {
  if (initialized || typeof document === 'undefined') return;
  initialized = true;

  applyStaggerIndices(document);
  const initialWelcome = document.querySelector('#transcript .conversation-welcome');
  if (initialWelcome) enhanceWelcomeNode(initialWelcome);

  // 1. Delegated Amber Stardust Click Burst (发送按钮与模式切换由 motion-fx 统一负责，避免重复叠加)
  document.addEventListener(
    'pointerdown',
    (ev) => {
      if (ev.button !== 0 || document.body?.classList.contains('galgame-active')) return;
      const target = ev.target instanceof Element ? ev.target.closest(STARDUST_SELECTOR) : null;
      if (!target) return;
      spawnStardustBurst(ev.clientX, ev.clientY, {
        count: target.matches('.lm-sleep-btn, .work-starter-card') ? 8 : 5,
        spread: target.matches('.lm-sleep-btn') ? 46 : 36,
      });
    },
    { passive: true }
  );

  // 2. Delegated 3D Radial Spotlight Glint on Cards (rAF 节流 + 沉浸模式早退)
  let spotRaf = 0;
  let spotCard = null;
  let spotClientX = 0;
  let spotClientY = 0;
  document.addEventListener(
    'pointermove',
    (ev) => {
      if (prefersReducedMotion() || document.body?.classList.contains('galgame-active')) return;
      const card = ev.target instanceof Element ? ev.target.closest(SPOTLIGHT_SELECTOR) : null;
      if (!card) return;
      spotCard = card;
      spotClientX = ev.clientX;
      spotClientY = ev.clientY;
      if (spotRaf) return;
      spotRaf = requestAnimationFrame(() => {
        spotRaf = 0;
        if (!spotCard || !spotCard.isConnected) return;
        const rect = spotCard.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const x = ((spotClientX - rect.left) / rect.width) * 100;
        const y = ((spotClientY - rect.top) / rect.height) * 100;
        spotCard.style.setProperty('--spot-x', `${x.toFixed(1)}%`);
        spotCard.style.setProperty('--spot-y', `${y.toFixed(1)}%`);
      });
    },
    { passive: true }
  );

  // 3. Composer Launch Shimmer Sweep on Starter Fill (发送粒子与框体动效统一归口 motion-fx，避免三重爆炸)
  document.addEventListener('click', (ev) => {
    const starter = ev.target instanceof Element ? ev.target.closest('.work-starter-card') : null;
    if (starter) triggerComposerSweep();
  });

  // 4. Observe Transcript & Drawer for Dynamic Stage Enhancements
  const transcript = document.getElementById('transcript');
  if (transcript) {
    const obs = new MutationObserver(() => {
      const w = transcript.querySelector('.conversation-welcome');
      if (w) enhanceWelcomeNode(w);
      const ws = transcript.querySelector('.work-new-thread-stage');
      if (ws) enhanceWorkNewStage(ws);
    });
    obs.observe(transcript, { childList: true });
  }
}
