// Only backend-issued source references are submitted. Display text is never
// treated as an authoritative quote or reconstructed as a message identity.
export function sourceReference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort().join(',');
  if (keys === 'messageId' && typeof value.messageId === 'string' && /^[1-9]\d*$/.test(value.messageId)) return value;
  if (keys === 'eventSeq,runId' && typeof value.runId === 'string' && value.runId &&
      typeof value.eventSeq === 'string' && /^[1-9]\d*$/.test(value.eventSeq)) return value;
  return null;
}

export function contextElement(context, nameOf = value => value) {
  if (context?.version !== 1 || !['quote', 'forward'].includes(context.kind) || !Array.isArray(context.sources)) return null;
  const node = document.createElement('details'); node.className = 'message-context';
  node.style.cssText = 'border-left:3px solid var(--color-edge, #b8b0a4);padding:6px 10px;margin:6px 0;font-size:13px;white-space:normal';
  const summary = document.createElement('summary');
  summary.textContent = (context.kind === 'forward' ? '转发来源' : '引用来源') + ' · ' + context.sources.length + ' 条';
  node.append(summary);
  for (const source of context.sources) {
    const entry = document.createElement('blockquote'); entry.style.cssText = 'margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere';
    const label = document.createElement('small'); label.style.cssText = 'display:block;opacity:.7;margin-bottom:4px';
    const actor = source.actor === 'user' ? '用户' : source.actor === 'system' ? '系统' : nameOf(source.botId);
    label.textContent = actor + ' · ' + (source.mode === 'work' ? 'Work' : 'Chat') + ' · ' +
      (source.groupId ? '群 ' + source.groupId : 'Bot ' + source.botId) + ' · 原消息 #' + source.messageId +
      (source.truncated ? ' · 摘录（码点 ' + (Number(source.offsetCodepoints) + 1) + ' 起，共 ' + source.totalCodepoints + '）' : '');
    const text = document.createElement('div'); text.className = 'message-context-text'; text.textContent = source.text || '';
    entry.append(label, text); node.append(entry);
  }
  return node;
}

let currentMenu = null;

export function closeMessageMenu({ restoreFocus = false } = {}) {
  const current = currentMenu;
  if (!current) return;
  currentMenu = null;
  current.listeners.abort();
  current.node.remove();
  if (restoreFocus && current.anchor?.isConnected) current.anchor.focus({ preventScroll: true });
}

export async function copyMessageText(text) {
  const value = String(text ?? '');
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch { /* WebView may not expose clipboard permissions; use the user-initiated fallback. */ }
  const previous = document.activeElement;
  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('aria-label', '复制消息');
  field.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0';
  document.body.append(field);
  try {
    field.select();
    if (!document.execCommand('copy')) throw new Error('复制失败，请重试或选中文字复制。');
  } finally {
    field.remove();
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  }
}

/**
 * 全局统一提示（toast）：底部居中堆叠，区分 info / success / warning / error。
 * 悬停暂停计时；错误提示带关闭按钮且停留更久；同文案短时间内不重复堆叠。
 * 也挂在 window.__dimensionToast 上供各模块调用。
 */
const TOAST_ICON = { info: '✦', success: '✓', warning: '!', error: '✕' };
function toastHost() {
  let host = document.getElementById('dimensionToastHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'dimensionToastHost';
    host.className = 'dimension-toast-host';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.append(host);
  }
  return host;
}
export function messageActionNotice(text, { level, duration } = {}) {
  const message = String(text ?? '').trim();
  if (!message) return;
  const kind = level || (/失败|错误|无法|未能|出错|拒绝|中断/.test(message) ? 'error' : /^(✦\s*)?已|成功/.test(message) ? 'success' : 'info');
  const host = toastHost();
  const dup = [...host.children].find((node) => node.dataset.message === message && !node.classList.contains('is-leaving'));
  if (dup) { dup.restartTimer?.(); return; }
  const item = document.createElement('div');
  item.className = `dimension-toast is-${kind}`;
  item.dataset.message = message;
  const icon = document.createElement('span');
  icon.className = 'dimension-toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = TOAST_ICON[kind] || TOAST_ICON.info;
  const body = document.createElement('span');
  body.className = 'dimension-toast-text';
  body.textContent = message;
  item.append(icon, body);
  const leave = () => {
    if (item.classList.contains('is-leaving')) return;
    item.classList.add('is-leaving');
    setTimeout(() => item.remove(), 220);
  };
  if (kind === 'error' || kind === 'warning') {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'dimension-toast-close';
    close.setAttribute('aria-label', '关闭提示');
    close.textContent = '×';
    close.addEventListener('click', leave);
    item.append(close);
  }
  const ttl = duration ?? (kind === 'error' ? 6000 : kind === 'warning' ? 4500 : 2800);
  let timer = 0;
  item.restartTimer = () => { clearTimeout(timer); timer = setTimeout(leave, ttl); };
  item.addEventListener('mouseenter', () => clearTimeout(timer));
  item.addEventListener('mouseleave', () => item.restartTimer());
  host.append(item);
  while (host.children.length > 4) host.firstElementChild.remove();
  item.restartTimer();
}
if (typeof window !== 'undefined') window.__dimensionToast = messageActionNotice;

/** One transient menu shared by private, group and Work messages. */
export function openMessageMenu({ anchor, x, y, items, onError = error => messageActionNotice(error.message || '操作失败，请重试。') }) {
  closeMessageMenu();
  const menu = document.createElement('div');
  menu.className = 'message-action-menu group-ctx'; menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '消息操作');
  const listeners = new AbortController();
  const buttons = [];
  for (const action of items) {
    const item = document.createElement('button'); item.type = 'button';
    item.className = 'message-action-item group-ctx-item' + (action.danger ? ' is-danger' : '');
    item.dataset.messageAction = action.id; item.setAttribute('role', 'menuitem');
    item.textContent = action.label; item.disabled = Boolean(action.disabled);
    if (action.title) item.title = action.title;
    item.addEventListener('click', async event => {
      event.stopPropagation();
      closeMessageMenu();
      try { await action.run(); } catch (error) { onError(error); }
    });
    menu.append(item); if (!item.disabled) buttons.push(item);
  }
  if (!buttons.length) return;
  document.body.append(menu);
  const bounds = menu.getBoundingClientRect(), origin = anchor?.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x ?? origin?.left ?? 8, window.innerWidth - bounds.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y ?? origin?.bottom ?? 8, window.innerHeight - bounds.height - 8))}px`;
  currentMenu = { node: menu, anchor, listeners };
  const signal = listeners.signal;
  document.addEventListener('pointerdown', event => { if (!menu.contains(event.target)) closeMessageMenu(); }, { capture: true, signal });
  document.addEventListener('contextmenu', event => { if (!menu.contains(event.target)) closeMessageMenu(); }, { signal });
  document.addEventListener('scroll', event => { if (!menu.contains(event.target)) closeMessageMenu(); }, { capture: true, signal });
  window.addEventListener('resize', () => closeMessageMenu(), { signal });
  window.addEventListener('blur', () => closeMessageMenu(), { signal });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMessageMenu({ restoreFocus: true }); }
    else if (event.key === 'Tab') closeMessageMenu();
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const index = Math.max(0, buttons.indexOf(document.activeElement));
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
        (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus({ preventScroll: true });
    }
  }, { capture: true, signal });
  buttons[0].focus({ preventScroll: true });
}

export function decorateMessage(node, message, { nameOf, onQuote, onMenu } = {}) {
  for (const child of [...node.children]) if (child.classList.contains('message-context') || child.classList.contains('message-quote-action')) child.remove();
  const context = contextElement(message.context, nameOf);
  if (context) node.prepend(context);
  const sourceRef = sourceReference(message.sourceRef);
  node.messageSource = { sourceRef, text: String(message.text || ''), from: message.from || message.actor || message.role || 'user' };
  node.messageActions = { onQuote, onMenu };
  if (!node.dataset.messageMenuBound) {
    node.dataset.messageMenuBound = '1';
    if (!node.hasAttribute('tabindex')) node.tabIndex = 0;
    const open = event => {
      event.preventDefault(); event.stopPropagation();
      const source = node.messageSource, actions = node.messageActions;
      if (actions.onMenu) { actions.onMenu(source, event, node); return; }
      const items = [];
      if (source.sourceRef && actions.onQuote) items.push({ id: 'quote', label: '引用', run: () => actions.onQuote(source) });
      items.push({ id: 'copy', label: '复制', run: async () => { await copyMessageText(source.text); messageActionNotice('已复制'); } });
      openMessageMenu({ anchor: node, ...(event.type === 'contextmenu' ? { x: event.clientX, y: event.clientY } : {}), items });
    };
    node.addEventListener('contextmenu', open);
    node.addEventListener('keydown', event => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) open(event);
    });
  }
}
