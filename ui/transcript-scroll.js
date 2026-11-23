/**
 * 聊天区智能吸底与新消息提示：
 * - 视角顶在最下方（距底部 <= 4px）时，自动跟随新消息与流式输出到底部；
 * - 只要向上抬了一点或更多距离，立刻解除跟随并锁定在当前阅读位置，不被后续新消息拽回；
 * - 锁定期间如有新消息或流式内容到来，在消息框上方显示“新消息提示”胶囊，点击即平滑回到最下方并重新锁定跟随。
 */
const BOTTOM_TOLERANCE = 4;
const MSG_SELECTOR = '.bubble:not(#pendingBubble):not(.is-streaming), .gmsg, .group-msg, .claude-user-turn, .claude-assistant-turn';

const changing = new WeakSet();
const states = new WeakMap();

export const atTranscriptEnd = (el) => {
  if (!el) return true;
  return el.scrollHeight - el.clientHeight - el.scrollTop <= BOTTOM_TOLERANCE;
};

function prefersReducedMotion() {
  return (
    document.documentElement.dataset.motion === 'off'
    || Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches)
  );
}

function getState(el) {
  let st = states.get(el);
  if (st) return st;
  st = {
    pinned: true,
    unreadCount: 0,
    hasNewContent: false,
    programmaticUntil: 0,
    followRaf: 0,
    jumpBtn: null,
    bound: false,
  };
  states.set(el, st);
  return st;
}

function cancelFollowRaf(st) {
  if (st.followRaf) {
    cancelAnimationFrame(st.followRaf);
    st.followRaf = 0;
  }
}

function scheduleBottomSettle(el, st) {
  cancelFollowRaf(st);
  st.followRaf = requestAnimationFrame(() => {
    st.followRaf = 0;
    if (!st.pinned || !el.isConnected || changing.has(el)) return;
    const target = Math.max(0, el.scrollHeight - el.clientHeight);
    if (Math.abs(el.scrollTop - target) > 1) {
      st.programmaticUntil = performance.now() + 80;
      el.scrollTop = target;
    }
  });
}

function renderJumpButton(el, st, { pulse = false } = {}) {
  const btn = st.jumpBtn || document.getElementById('transcriptJumpBtn');
  if (!btn) return;
  st.jumpBtn = btn;
  const shouldShow = !st.pinned && (st.unreadCount > 0 || st.hasNewContent) && !el.querySelector('.conversation-welcome');
  if (!shouldShow) {
    btn.hidden = true;
    btn.classList.remove('is-visible', 'is-pulsing');
    return;
  }
  const textEl = btn.querySelector('.transcript-jump-text');
  const label = st.unreadCount > 0
    ? `${st.unreadCount > 99 ? '99+' : st.unreadCount} 条新消息`
    : '有新消息';
  if (textEl) textEl.textContent = label;
  else btn.textContent = `↓ ${label}`;
  btn.setAttribute('aria-label', `${label}，点击回到最下方并跟随`);

  const wasHidden = btn.hidden;
  btn.hidden = false;
  if (wasHidden) {
    requestAnimationFrame(() => btn.classList.add('is-visible'));
  } else {
    btn.classList.add('is-visible');
  }
  if (pulse && !prefersReducedMotion()) {
    btn.classList.remove('is-pulsing');
    void btn.offsetWidth;
    btn.classList.add('is-pulsing');
  }
}

function unlockByUser(el, st) {
  cancelFollowRaf(st);
  st.programmaticUntil = 0;
  if (!st.pinned) return;
  st.pinned = false;
  // 若用户离开底部时恰好正在流式输出，立刻亮出提示胶囊，不产生一拍延迟
  if (el.querySelector('.is-streaming')) {
    st.hasNewContent = true;
    renderJumpButton(el, st, { pulse: false });
  }
}

function ensureBound(el, jumpBtn = null) {
  if (!el) return null;
  const st = getState(el);
  if (jumpBtn) st.jumpBtn = jumpBtn;
  else if (!st.jumpBtn) st.jumpBtn = document.getElementById('transcriptJumpBtn');

  if (st.bound) return st;
  st.bound = true;

  // 用户手动滚动：向上抬离最下方超过容差立即锁定当前位置；滑回最下方自动恢复跟随。
  const onScroll = () => {
    if (changing.has(el)) return;
    const now = performance.now();
    const atEnd = atTranscriptEnd(el);
    if (atEnd) {
      st.pinned = true;
      if (st.unreadCount || st.hasNewContent) {
        st.unreadCount = 0;
        st.hasNewContent = false;
        renderJumpButton(el, st);
      }
      return;
    }
    if (now >= st.programmaticUntil) {
      unlockByUser(el, st);
    }
  };

  // 滚轮向上：无论是否处于动画中，立刻把视角控制权交还用户。
  const onWheel = (e) => {
    if (e.deltaY < 0) {
      cancelFollowRaf(st);
      st.programmaticUntil = 0;
      if (!atTranscriptEnd(el)) unlockByUser(el, st);
    }
  };

  // 拖动滚动条时立刻中断程序跟随
  const onPointerDown = (e) => {
    if (e.target === el && e.offsetX > el.clientWidth) {
      cancelFollowRaf(st);
      st.programmaticUntil = 0;
    }
  };

  let touchY = null;
  const onTouchStart = (e) => { touchY = e.touches?.[0]?.clientY ?? null; };
  const onTouchMove = (e) => {
    const y = e.touches?.[0]?.clientY;
    if (touchY !== null && typeof y === 'number' && y > touchY + 3) {
      unlockByUser(el, st);
    }
    if (typeof y === 'number') touchY = y;
  };

  el.addEventListener('scroll', onScroll, { passive: true });
  el.addEventListener('wheel', onWheel, { passive: true });
  el.addEventListener('pointerdown', onPointerDown, { passive: true });
  el.addEventListener('touchstart', onTouchStart, { passive: true });
  el.addEventListener('touchmove', onTouchMove, { passive: true });

  const bindBtn = (btn) => {
    if (!btn || btn.dataset.transcriptJumpBound === '1') return;
    btn.dataset.transcriptJumpBound = '1';
    btn.addEventListener('click', () => {
      pinTranscriptToBottom(el, { smooth: true });
    });
  };
  bindBtn(st.jumpBtn);

  return st;
}

export function initTranscriptFollow(el, jumpBtn) {
  const st = ensureBound(el, jumpBtn);
  if (!st) return;
  if (st.jumpBtn && st.jumpBtn.dataset.transcriptJumpBound !== '1') {
    st.jumpBtn.dataset.transcriptJumpBound = '1';
    st.jumpBtn.addEventListener('click', () => {
      pinTranscriptToBottom(el, { smooth: true });
    });
  }
  renderJumpButton(el, st);
}

export function resetTranscriptFollow(el) {
  if (!el) return;
  const st = ensureBound(el);
  cancelFollowRaf(st);
  st.pinned = true;
  st.unreadCount = 0;
  st.hasNewContent = false;
  st.programmaticUntil = 0;
  renderJumpButton(el, st);
}

export function pinTranscriptToBottom(el, { smooth = false } = {}) {
  if (!el) return;
  const st = ensureBound(el);
  cancelFollowRaf(st);
  st.pinned = true;
  st.unreadCount = 0;
  st.hasNewContent = false;
  renderJumpButton(el, st);

  const target = Math.max(0, el.scrollHeight - el.clientHeight);
  const useSmooth = smooth && !prefersReducedMotion() && Math.abs(target - el.scrollTop) > 24;
  if (useSmooth) {
    st.programmaticUntil = performance.now() + 450;
    try {
      el.scrollTo({ top: target, behavior: 'smooth' });
    } catch {
      el.scrollTop = target;
    }
    setTimeout(() => {
      if (!st.pinned || !el.isConnected) return;
      const finalTarget = Math.max(0, el.scrollHeight - el.clientHeight);
      if (Math.abs(el.scrollTop - finalTarget) > 1) {
        st.programmaticUntil = performance.now() + 80;
        el.scrollTop = finalTarget;
      }
    }, 360);
  } else {
    st.programmaticUntil = performance.now() + 80;
    el.scrollTop = target;
    scheduleBottomSettle(el, st);
  }
}

export function changeTranscript(el, change, { force = false, prepend = false, anchorSelector } = {}) {
  if (!el || changing.has(el)) return change();
  const st = ensureBound(el);

  // 如果之前是空容器或欢迎页，说明正在载入新会话，重置跟随态
  const hadWelcome = el.childElementCount <= 2 && Boolean(el.querySelector('.conversation-welcome'));
  const wasEmpty = el.children.length === 0 || hadWelcome;
  if (wasEmpty && !prepend) {
    st.pinned = true;
    st.unreadCount = 0;
    st.hasNewContent = false;
  }

  const follow = !prepend && (force || (st.pinned && (atTranscriptEnd(el) || performance.now() < st.programmaticUntil)));
  if (!follow && !prepend && !atTranscriptEnd(el)) {
    st.pinned = false;
  }

  // Fast path: when pinned at bottom (95% of streaming updates), skip expensive pre/post DOM queries and sync layout reflows!
  if (follow) {
    changing.add(el);
    try {
      return change();
    } finally {
      changing.delete(el);
      st.pinned = true;
      if (st.unreadCount || st.hasNewContent) {
        st.unreadCount = 0;
        st.hasNewContent = false;
        renderJumpButton(el, st);
      }
      st.programmaticUntil = performance.now() + 100;
      scheduleBottomSettle(el, st);
    }
  }

  const prevMsgCount = el.querySelectorAll(MSG_SELECTOR).length;
  const prevScrollHeight = el.scrollHeight;
  const prevLastChild = el.lastElementChild;
  const hadStreaming = Boolean(el.querySelector('.is-streaming'));

  const top = el.scrollTop;
  const edge = el.getBoundingClientRect().top;
  const candidates = anchorSelector ? el.querySelectorAll(anchorSelector) : el.children;
  const anchor = [...candidates].find((child) => child.getBoundingClientRect().bottom > edge);
  const offset = anchor?.getBoundingClientRect().top;

  changing.add(el);
  try {
    return change();
  } finally {
    changing.delete(el);
    if (anchor && el.contains(anchor)) {
      // 锁定在当前阅读行：上方节点折叠/替换时补偿位移，视角纹丝不动。
      const shift = anchor.getBoundingClientRect().top - offset;
      if (Math.abs(shift) > 1) el.scrollTop += shift;
    } else if (Math.abs(el.scrollTop - top) > 1) {
      el.scrollTop = Math.min(top, Math.max(0, el.scrollHeight - el.clientHeight));
    }

    // 向上加载更早历史消息不计入新消息提示
    if (!prepend && !el.querySelector('.conversation-welcome')) {
      const nextMsgCount = el.querySelectorAll(MSG_SELECTOR).length;
      const addedMsgs = Math.max(0, nextMsgCount - prevMsgCount);
      const hasStreaming = Boolean(el.querySelector('.is-streaming'));
      const streamFinished = hadStreaming && !hasStreaming;
      const grewAtBottom = el.scrollHeight > prevScrollHeight + 2
        && (el.lastElementChild !== prevLastChild || hasStreaming);
      if (addedMsgs > 0) {
        st.unreadCount += addedMsgs;
        st.hasNewContent = true;
        renderJumpButton(el, st, { pulse: true });
      } else if (grewAtBottom || streamFinished) {
        st.hasNewContent = true;
        renderJumpButton(el, st, { pulse: false });
      }
    } else if (el.querySelector('.conversation-welcome')) {
      resetTranscriptFollow(el);
    }
  }
}

export function appendTranscript(el, child, options) {
  return changeTranscript(el, () => el?.appendChild(child), options);
}
