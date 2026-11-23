// 维度 Agent · 动效编排层（motion-fx）
// 只负责“给 DOM 打上动效类名 / 生成装饰节点”，不改任何业务逻辑；样式见 motion-fx.css。
// 分级：
//   off  / 系统“减少动画” → 什么都不做
//   lite（精简）→ 只保留功能性过渡（消息入场、切换淡入、弹窗进出、状态反馈）
//   full（完整）→ 再叠加装饰与庆祝：发送星屑、完成彩带、季节粒子、流星、印章盖章光晕等

const html = document.documentElement;
const reducedQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const level = () => (reducedQuery?.matches ? 'off' : (html.dataset.motion || 'full'));
const enabled = () => level() !== 'off';
const enhanced = () => level() === 'full';

const $ = (id) => document.getElementById(id);
const pulseClass = (el, cls, ms = 700) => {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth; // 重新触发同名动画
  el.classList.add(cls);
  clearTimeout(el[`_mfx_${cls}`]);
  el[`_mfx_${cls}`] = setTimeout(() => el.classList.remove(cls), ms);
};

/* ───────────── 装饰粒子层（全屏、不拦截点击） ───────────── */
let fxLayer = null;
function layer() {
  if (fxLayer?.isConnected) return fxLayer;
  fxLayer = document.createElement('div');
  fxLayer.className = 'mfx-layer';
  fxLayer.setAttribute('aria-hidden', 'true');
  document.body.append(fxLayer);
  return fxLayer;
}

/** 从某点喷出若干 ✦ / 彩带，用 WAAPI 播放后自动移除 */
function burst(x, y, { count = 8, spread = 60, rise = 40, glyphs = ['✦', '✧', '·'], palette, duration = 900, gravity = 0, confetti = false } = {}) {
  if (!enhanced()) return;
  const host = layer();
  const colors = palette || ['var(--color-accent)', '#f2c46d', 'color-mix(in srgb, var(--color-accent) 60%, #fff)'];
  for (let i = 0; i < count; i++) {
    const node = document.createElement('span');
    node.className = confetti ? 'mfx-confetti' : 'mfx-spark';
    if (!confetti) node.textContent = glyphs[i % glyphs.length];
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.style.color = colors[i % colors.length];
    if (confetti) node.style.background = colors[i % colors.length];
    host.append(node);
    const angle = (-Math.PI / 2) + (Math.random() - 0.5) * Math.PI * (confetti ? 1.2 : 0.9);
    const dist = spread * (0.55 + Math.random() * 0.6);
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist - rise * Math.random();
    const spin = (Math.random() - 0.5) * (confetti ? 720 : 240);
    const scale = 0.7 + Math.random() * 0.7;
    const anim = node.animate([
      { transform: 'translate(-50%, -50%) scale(0.2) rotate(0deg)', opacity: 0 },
      { transform: `translate(calc(-50% + ${dx * 0.55}px), calc(-50% + ${dy * 0.55}px)) scale(${scale}) rotate(${spin * 0.5}deg)`, opacity: 1, offset: 0.35 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy + gravity}px)) scale(${scale * 0.6}) rotate(${spin}deg)`, opacity: 0 },
    ], { duration: duration + Math.random() * 300, easing: 'cubic-bezier(0.16, 0.84, 0.32, 1)' });
    anim.onfinish = () => node.remove();
  }
}

/* ───────────── 1. 聊天消息：入场、流式收尾、批量切换 ───────────── */
const MSG_SELECTOR = '.bubble, .gmsg, .group-msg, .claude-user-turn, .claude-assistant-turn, .work-inline-error';
let lastStreamRemovedAt = 0;

function classifyMessage(node) {
  if (node.matches('.bubble.user, .gmsg.is-user, .claude-user-turn')) return 'is-from-user';
  if (node.matches('.bubble.system')) return 'is-from-system';
  return 'is-from-other';
}

function handleTranscriptMutations(records) {
  if (!enabled()) return;
  const transcript = $('transcript');
  const added = [];
  for (const record of records) {
    if (record.type === 'attributes') { handleAttributeChange(record); continue; }
    // Short-circuit incremental Markdown block updates inside an existing message bubble!
    if (record.target !== transcript && record.target?.closest?.('.md-content, .wrs-commentary')) continue;
    for (const node of record.removedNodes) {
      if (node.nodeType === 1 && node.classList?.contains('is-streaming')) lastStreamRemovedAt = performance.now();
    }
    for (const node of record.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.matches?.(MSG_SELECTOR)) added.push(node);
      else if (node.querySelectorAll) node.querySelectorAll(MSG_SELECTOR).forEach((n) => added.push(n));
      if (node.matches?.('.conversation-welcome') || node.querySelector?.('.conversation-welcome')) {
        queueMicrotask(() => decorateWelcome(transcript?.querySelector('.conversation-welcome')));
      }
      if (node.matches?.('.claude-approval-card')) pulseClass(node, 'mfx-attention', 1600);
      else node.querySelectorAll?.('.claude-approval-card:not([data-decided="1"])').forEach((card) => pulseClass(card, 'mfx-attention', 1600));
    }
  }
  if (!added.length) return;
  // 一次性塞进很多条 = 切换会话 / 加载历史：整体淡入一次，不逐条弹
  if (added.length > 4) {
    pulseClass(transcript, 'mfx-switching', 460);
    return;
  }
  const settling = performance.now() - lastStreamRemovedAt < 400;
  for (const node of added) {
    if (node.classList.contains('is-streaming')) { node.classList.add('mfx-enter', 'is-from-other'); continue; }
    // 流式气泡刚收尾、换成正式气泡：不再重复入场，只扫过一道柔光
    if (settling && node.matches('.bubble.assistant')) { pulseClass(node, 'mfx-settle', 1100); continue; }
    if (node.matches('.work-inline-error')) { pulseClass(node, 'mfx-nudge', 600); continue; }
    node.classList.add('mfx-enter', classifyMessage(node));
    setTimeout(() => node.classList.remove('mfx-enter'), 700);
  }
}

/* ───────────── 2. 发送：按钮起飞 + 输入框涟漪 + 星屑 ───────────── */
function bindSend() {
  const composer = $('composer');
  composer?.addEventListener('submit', () => {
    if (!enabled()) return;
    const input = $('composerInput');
    const hasContent = Boolean(String(input?.value || '').trim()) || document.querySelector('#chatImageDraft:not([hidden]), #chatStickerDraft:not([hidden])');
    if (!hasContent) return;
    const btn = $('sendBtn');
    pulseClass(btn, 'mfx-launch', 620);
    pulseClass($('composerCard'), 'mfx-sent', 700);
    if (btn && enhanced()) {
      const r = btn.getBoundingClientRect();
      burst(r.left + r.width / 2, r.top + r.height / 2, { count: 7, spread: 46, rise: 30, duration: 760 });
    }
  }, true);
}

/* ───────────── 3. 闲谈 / 工坊切换：区域交叉滑入 ───────────── */
function bindModeSwap() {
  const app = $('app');
  if (!app) return;
  let wasWork = app.classList.contains('is-work-shell');
  new MutationObserver(() => {
    const isWork = app.classList.contains('is-work-shell');
    if (isWork === wasWork) return;
    wasWork = isWork;
    if (!enabled()) return;
    const dir = isWork ? 'to-work' : 'to-chat';
    for (const el of [document.querySelector('.sidebar-roster'), $('composerCard'), $('transcript')]) {
      if (!el) continue;
      el.classList.remove('mfx-swap-to-work', 'mfx-swap-to-chat');
      void el.offsetWidth;
      el.classList.add(`mfx-swap-${dir}`);
      setTimeout(() => el.classList.remove(`mfx-swap-${dir}`), 520);
    }
    const tab = document.querySelector(`.mode-seg-tab[data-shell-target="${isWork ? 'work' : 'chat'}"]`);
    if (tab && enhanced()) {
      const r = tab.getBoundingClientRect();
      burst(r.left + r.width / 2, r.top + r.height / 2, { count: 5, spread: 26, rise: 10, duration: 620 });
    }
  }).observe(app, { attributes: true, attributeFilter: ['class'] });
}

/* ───────────── 4. 抽屉：条目依次浮入 ───────────── */
function bindDrawer() {
  const drawer = $('drawer');
  if (!drawer) return;
  new MutationObserver(() => {
    if (drawer.hidden || !enabled()) return;
    const items = drawer.querySelectorAll('.drawer-item:not([hidden]), .group-activity-card, .group-members-head, .group-preset-bar');
    items.forEach((item, i) => item.style.setProperty('--mfx-i', String(i)));
    pulseClass(drawer, 'mfx-stagger', 900);
  }).observe(drawer, { attributes: true, attributeFilter: ['hidden'] });
}

/* ───────────── 5. 工坊：状态变化反馈、审批盖章 ───────────── */
const ACTIVE = new Set(['queued', 'planning', 'running', 'waiting-approval']);
function handleAttributeChange(record) {
  const el = record.target;
  if (record.attributeName === 'data-status' && el.classList?.contains('claude-state-pill')) {
    const prev = record.oldValue || '';
    const next = el.dataset.status || '';
    if (prev === next) return;
    if (next === 'completed' && ACTIVE.has(prev)) {
      pulseClass(el, 'mfx-done', 1200);
      const r = el.getBoundingClientRect();
      burst(r.left + r.width / 2, r.top + r.height / 2, { count: 16, spread: 90, rise: 30, duration: 1200, gravity: 40, confetti: true });
      burst(r.left + r.width / 2, r.top + r.height / 2, { count: 6, spread: 50, duration: 900 });
    } else if ((next === 'failed' || next === 'blocked') && ACTIVE.has(prev)) {
      pulseClass(el, 'mfx-shake', 600);
    } else if (ACTIVE.has(next) && !ACTIVE.has(prev)) {
      pulseClass(el, 'mfx-kick', 900);
    }
    return;
  }
  if (record.attributeName === 'data-decided' && el.classList?.contains('claude-approval-card')) {
    el.querySelector(':scope > .mfx-stamp')?.remove();
    if (el.dataset.decided !== '1') return;
    const picked = el.querySelector('.claude-approval-btn.is-selected');
    const denied = picked && !picked.classList.contains('is-primary') && !picked.classList.contains('is-link');
    const stamp = document.createElement('span');
    stamp.className = `mfx-stamp ${denied ? 'is-deny' : 'is-allow'}`;
    stamp.setAttribute('aria-hidden', 'true');
    stamp.textContent = denied ? '驳' : '准';
    el.append(stamp);
    if (!denied && enhanced()) {
      requestAnimationFrame(() => {
        const r = stamp.getBoundingClientRect();
        burst(r.left + r.width / 2, r.top + r.height / 2, { count: 8, spread: 44, duration: 800 });
      });
    }
  }
}

/* ───────────── 6. 欢迎页氛围：时段天色 + 季节粒子 + 节日彩蛋 ───────────── */
function daypart(hour) {
  if (hour >= 5 && hour < 8) return 'dawn';
  if (hour >= 8 && hour < 16) return 'day';
  if (hour >= 16 && hour < 19) return 'dusk';
  return 'night';
}
function season(month) {
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'autumn';
  return 'winter';
}
const HOLIDAYS = {
  '01-01': '✦ 新年快乐 · 新的一卷物语开篇啦',
  '02-14': '✦ 情人节快乐 · 今天的私语会更甜一点',
  '04-01': '✦ 愚人节 · 伙伴们今天说的话要打个问号哦',
  '05-01': '✦ 劳动节快乐 · 工坊今天也给自己放个假吧',
  '06-01': '✦ 儿童节快乐 · 永远保有一颗二次元的心',
  '10-31': '✦ 万圣夜 · 不给糖就捣蛋',
  '12-24': '✦ 平安夜 · 愿你被温柔的雪包围',
  '12-25': '✦ 圣诞快乐 · 礼物就藏在下一句对话里',
  '12-31': '✦ 跨年夜 · 一起倒数吧',
};
const SEASON_GLYPH = { spring: 'petal', summer: 'firefly', autumn: 'leaf', winter: 'snow' };

function decorateWelcome(welcome) {
  if (!welcome || welcome.querySelector(':scope > .mfx-sky')) return;
  const now = new Date();
  const part = daypart(now.getHours());
  const sea = season(now.getMonth() + 1);
  welcome.dataset.daypart = part;
  welcome.dataset.season = sea;
  const sky = document.createElement('div');
  sky.className = `mfx-sky is-${part} is-${sea}`;
  sky.setAttribute('aria-hidden', 'true');
  if (part === 'night' || part === 'dusk') {
    for (let i = 0; i < 16; i++) {
      const s = document.createElement('i');
      s.className = 'mfx-star';
      s.style.setProperty('--x', `${(i * 61 + 7) % 100}%`);
      s.style.setProperty('--y', `${(i * 37 + 11) % 62}%`);
      s.style.setProperty('--d', `${(2.4 + (i % 5) * 0.7).toFixed(1)}s`);
      s.style.setProperty('--delay', `${-((i * 0.9) % 4).toFixed(1)}s`);
      s.style.setProperty('--s', `${(i % 3) + 1.5}px`);
      sky.append(s);
    }
    if (part === 'night') {
      const meteor = document.createElement('i');
      meteor.className = 'mfx-meteor';
      sky.append(meteor);
    }
  }
  // 季节粒子：夏天白天没有萤火虫，换成光点
  const glyph = sea === 'summer' && part !== 'night' && part !== 'dusk' ? 'sunmote' : SEASON_GLYPH[sea];
  for (let i = 0; i < 10; i++) {
    const p = document.createElement('i');
    p.className = `mfx-particle is-${glyph}`;
    p.style.setProperty('--x', `${(i * 9.7 + 5) % 92}%`);
    p.style.setProperty('--d', `${(8.5 + (i % 4) * 2.2).toFixed(1)}s`);
    p.style.setProperty('--delay', `${-((i * 1.9) % 11).toFixed(1)}s`);
    p.style.setProperty('--sway', `${14 + (i % 3) * 10}px`);
    p.style.setProperty('--size', `${8 + (i % 3) * 2}px`);
    sky.append(p);
  }
  welcome.prepend(sky);
  const key = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (HOLIDAYS[key] && !welcome.querySelector('.mfx-holiday')) {
    const chip = document.createElement('div');
    chip.className = 'mfx-holiday';
    chip.textContent = HOLIDAYS[key];
    const title = welcome.querySelector('.atelier-welcome-title');
    if (title) title.after(chip); else welcome.append(chip);
  }
}

/* ───────────── 启动 ───────────── */
let started = false;
export function startMotionFx() {
  if (started) return;
  started = true;
  const transcript = $('transcript');
  if (transcript) {
    new MutationObserver(handleTranscriptMutations).observe(transcript, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['data-status', 'data-decided'],
    });
    decorateWelcome(transcript.querySelector('.conversation-welcome'));
  }
  bindSend();
  bindModeSwap();
  bindDrawer();
  // 欢迎页可能在 anime-fx 增强前就渲染了：稍后再补一次
  setTimeout(() => decorateWelcome($('transcript')?.querySelector('.conversation-welcome')), 600);
}
