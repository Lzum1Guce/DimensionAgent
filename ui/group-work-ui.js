/** 群聊点名、陆续发言、左栏虚拟列表、工作项目根与待批卡片。不改左栏/胶囊/气泡既有样式。 */
import { appendTranscript, changeTranscript } from './transcript-scroll.js';
import { createChangeDiff } from './change-diff-ui.js';
import { createWorkCliPicker } from './work-cli-picker.js';

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

export function highlightMentions(text, members) {
  const raw = String(text ?? '');
  if (!raw) return '';
  const names = (members || []).flatMap((m) => [m?.name, m?.id]).filter(Boolean)
    .sort((a, b) => String(b).length - String(a).length)
    .map((n) => String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!names.length) return escapeHtml(raw);
  const re = new RegExp(`(@(?:${names.join('|')}))`, 'g');
  return escapeHtml(raw).replace(re, '<span class="gmsg-mention">$1</span>');
}

export function bindMentionPicker(input, getMembers) {
  if (!input || input.dataset.mentionBound === '1') return;
  input.dataset.mentionBound = '1';
  let menu = document.getElementById('mentionMenu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'mentionMenu';
    menu.className = 'mention-menu';
    menu.hidden = true;
    document.body.appendChild(menu);
  }
  let items = [];
  let active = 0;

  const close = () => { menu.hidden = true; items = []; };
  const currentToken = () => {
    const pos = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, pos);
    const m = before.match(/(^|[\s,，])@([^\s@，,]{0,40})$/);
    return m ? { start: pos - m[2].length - 1, query: m[2], pos } : null;
  };
  const render = () => {
    const tok = currentToken();
    const members = (typeof getMembers === 'function' ? getMembers() : []) || [];
    if (!tok || !members.length) { close(); return; }
    const q = tok.query.toLowerCase();
    items = members.filter((m) => {
      const name = String(m.name || '');
      const id = String(m.id || '');
      return !q || name.toLowerCase().includes(q) || id.toLowerCase().includes(q);
    }).slice(0, 8);
    if (!items.length) { close(); return; }
    active = Math.max(0, Math.min(active, items.length - 1));
    menu.innerHTML = items.map((m, i) => `<button type="button" class="mention-item${i === active ? ' is-active' : ''}" data-idx="${i}"><span class="mention-name">${escapeHtml(m.name || m.id)}</span></button>`).join('');
    const rect = input.getBoundingClientRect();
    menu.style.left = `${Math.max(12, rect.left)}px`;
    menu.style.bottom = `${Math.max(12, window.innerHeight - rect.top + 6)}px`;
    menu.hidden = false;
  };
  const insert = (member) => {
    const tok = currentToken();
    if (!tok) return;
    const ambiguous = getMembers().some(other => other.id !== member.id &&
      (other.name === member.name || other.id === member.name));
    const name = ambiguous ? member.id : (member.name || member.id);
    const before = input.value.slice(0, tok.start);
    const after = input.value.slice(tok.pos);
    input.value = `${before}@${name} ${after}`;
    const caret = (before + `@${name} `).length;
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    close();
    input.focus();
  };
  input.addEventListener('input', () => {
    if (input.dataset.composing === '1') return;
    render();
  });
  input.addEventListener('keydown', (event) => {
    if (menu.hidden || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopImmediatePropagation();
      active = (active + 1) % items.length;
      render();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopImmediatePropagation();
      active = (active - 1 + items.length) % items.length;
      render();
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      if (!items[active]) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      insert(items[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    }
  }, { capture: true });
  menu.addEventListener('mousedown', (event) => {
    const btn = event.target.closest('[data-idx]');
    if (!btn) return;
    event.preventDefault();
    insert(items[Number(btn.dataset.idx)]);
  });
  document.addEventListener('pointerdown', (event) => {
    if (menu.hidden) return;
    if (event.target === input || menu.contains(event.target)) return;
    close();
  });
}

export function speakingRow(from, name, avatarHtml) {
  const row = document.createElement('div');
  row.className = 'gmsg is-speaking';
  row.dataset.speaking = from;
  row.innerHTML = `${avatarHtml ? `<span class="gmsg-avatar">${avatarHtml}</span>` : ''}
    <div class="gmsg-main"><div class="gmsg-name">${escapeHtml(name)}</div><div class="gmsg-bubble gmsg-speaking-text" aria-label="${escapeHtml(name)} 正在输入"><span class="gmsg-typing-dots"><i></i><i></i><i></i></span></div></div>`;
  return row;
}

export function upsertSpeaking(transcript, from, name, avatarHtml) {
  if (!transcript || !from) return;
  let row = transcript.querySelector(`.gmsg.is-speaking[data-speaking="${cssEscape(from)}"]`);
  if (!row) {
    row = speakingRow(from, name, avatarHtml);
    appendTranscript(transcript, row);
  }
}

export function clearSpeaking(transcript, from) {
  if (!transcript) return;
  const sel = from
    ? `.gmsg.is-speaking[data-speaking="${cssEscape(from)}"]`
    : '.gmsg.is-speaking';
  changeTranscript(transcript, () => transcript.querySelectorAll(sel).forEach((el) => el.remove()));
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(value);
  return String(value).replace(/"/g, '\\"');
}

export function createVirtualList(listEl, { rowHeight = 58, renderRow, bind } = {}) {
  let rows = [];
  let onScroll = null;
  const paint = () => {
    if (!listEl) return;
    const height = rows.length * rowHeight;
    const view = listEl.clientHeight || 400;
    // Mode changes and search can shrink a long list below its previous scroll position.
    const top = Math.min(listEl.scrollTop, Math.max(0, height - view));
    if (listEl.scrollTop !== top) listEl.scrollTop = top;
    const start = Math.max(0, Math.floor(top / rowHeight) - 4);
    const end = Math.min(rows.length, Math.ceil((top + view) / rowHeight) + 4);
    const parts = [`<div class="bot-list-spacer" style="height:${height}px;position:relative">`];
    for (let i = start; i < end; i++) {
      const html = renderRow(rows[i], i);
      parts.push(`<div class="bot-list-virtual-row" style="position:absolute;left:0;right:0;top:${i * rowHeight}px;height:${rowHeight}px">${html}</div>`);
    }
    parts.push('</div>');
    listEl.innerHTML = parts.join('');
    bind?.(listEl);
  };
  const setRows = (next) => {
    rows = Array.isArray(next) ? next : [];
    paint();
  };
  let ro = null;
  if (!listEl.dataset.virtualBound) {
    listEl.dataset.virtualBound = '1';
    onScroll = () => paint();
    listEl.addEventListener('scroll', onScroll, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(paint);
      ro.observe(listEl);
    }
  }
  const destroy = () => {
    if (onScroll) listEl?.removeEventListener('scroll', onScroll);
    ro?.disconnect();
    if (listEl) delete listEl.dataset.virtualBound;
  };
  return { setRows, paint, rowHeight, destroy };
}

export function orderBotsForList(bots, { pinnedIds, recentIds } = {}) {
  const recent = new Set(recentIds || []);
  const pinned = new Set(pinnedIds || []);
  const head = [];
  const rest = [];
  for (const bot of bots || []) {
    if (pinned.has(bot.id)) continue;
    if (recent.has(bot.id)) head.push(bot);
    else rest.push(bot);
  }
  const recentOrder = [...(recentIds || [])];
  head.sort((a, b) => recentOrder.indexOf(a.id) - recentOrder.indexOf(b.id));
  return [...head, ...rest];
}

export function bindWorkShellUi(opts) {
  const bar = document.getElementById('workCwdBar');
  const host = document.getElementById('approvalHost');
  const composer = document.getElementById('composer');
  const attach = document.getElementById('workAttachBtn');
  const file = document.getElementById('workAttachInput');
  const pick = document.getElementById('workCwdPick');
  const pathEl = document.getElementById('workCwdPath');
  const desktopBtn = document.getElementById('linuxDesktopBtn');
  const browserBtn = document.getElementById('workBrowserBtn');
  let cliPicker = null;
  if (bar && !document.getElementById('workCliPickerTrigger')) {
    document.getElementById('workCliEngineSelect')?.remove();
    document.getElementById('workCliModelSourceSelect')?.remove();
    document.getElementById('workModeSelect')?.remove();
    document.getElementById('workExtraBtn')?.parentElement?.remove();
    cliPicker = createWorkCliPicker({
      getSettings: () => opts.getSettings?.() || {},
      getLeadSelection: () => opts.getLeadSelection?.() || null,
      onSelectLeadModel: sel => opts.onSelectLeadModel?.(sel),
      getProviderGroups: () => opts.getProviderGroups?.() || [],
      onChange: payload => opts.onCliHarnessChange?.(payload),
      onRefresh: arg => opts.onRefreshCliAndModels?.(arg),
      onAddCustomModel: () => opts.onAddCustomModel?.(),
      onEditModels: () => opts.onEditModels?.(),
      onOpenCliSandboxSettings: () => opts.onOpenCliSandboxSettings?.(),
      onOpenCliReceptionModal: () => opts.onOpenCliReceptionModal?.(),
    });
    bar.append(cliPicker.node);
  }
  const sync = () => {
    const work = Boolean(opts.isWork?.());
    if (bar) bar.hidden = !work;
    if (attach) attach.hidden = !work;
    if (desktopBtn) desktopBtn.hidden = !work;
    if (browserBtn) browserBtn.hidden = !work;
    if (!work) {
      cliPicker?.close();
      cwdMenu?.setAttribute('hidden', '');
      return;
    }
    const settings = opts.getSettings?.() || {};
    const cwd = settings.projectCwd || '';
    const isManagedPath = !cwd || String(cwd).startsWith('\\\\') || String(cwd).includes('/var/lib/dimension/managed');
    const isLocalWin = Boolean(settings.localWindowsProject) || (Boolean(cwd) && !isManagedPath);
    if (pathEl) {
      if (isManagedPath) {
        pathEl.textContent = '隔离沙盒';
      } else {
        const clean = String(cwd).replace(/[\\/]+$/, '');
        const base = clean.split(/[\\/]/).filter(Boolean).pop() || clean;
        const curMode = settings.workspaceMode || 'auto';
        const effShort = (curMode === 'windows_native' || (curMode === 'auto' && settings.effectiveWorkspaceMode === 'windows_native'))
          ? '原生'
          : '沙盒';
        pathEl.textContent = `${base} · ${effShort}`;
      }
      pathEl.title = isManagedPath ? '当前使用隔离沙盒工作台' : `${cwd}（点击切换工作目录或执行工位）`;
    }
    if (pick) {
      pick.title = cwd && !isManagedPath
        ? `当前本地工程：${cwd}\n点击切换目录或执行工位模式`
        : '当前：隔离沙盒 · 点击切换工作目录';
    }
    cliPicker?.sync();
  };

  // Unified Workspace Directory + Execution Mode Popover (eliminates separate <select> & duplicate ··· menu!)
  let cwdMenu = null;
  if (bar && pick && !document.getElementById('workCwdQuickMenu')) {
    cwdMenu = document.createElement('div');
    cwdMenu.id = 'workCwdQuickMenu';
    cwdMenu.className = 'work-quick-pop';
    cwdMenu.hidden = true;
    bar.append(cwdMenu);
  }

  document.addEventListener('pointerdown', e => {
    if (cwdMenu && !cwdMenu.hidden && !cwdMenu.contains(e.target) && !pick?.contains(e.target)) cwdMenu.hidden = true;
  });

  pick?.addEventListener('click', e => {
    const recents = opts.getRecentCwds?.() || [];
    const settings = opts.getSettings?.() || {};
    const curCwd = settings.projectCwd || '';
    const isManaged = !curCwd || String(curCwd).startsWith('\\\\') || String(curCwd).includes('/var/lib/dimension/managed');
    if (!cwdMenu || (!recents.length && isManaged)) {
      opts.pickCwd?.();
      return;
    }
    e.stopPropagation();
    if (!cwdMenu.hidden) {
      cwdMenu.hidden = true;
      return;
    }
    cwdMenu.replaceChildren();
    const addSecTitle = txt => {
      const hd = document.createElement('div');
      hd.className = 'work-quick-sec-title';
      hd.textContent = txt;
      cwdMenu.append(hd);
    };
    const addOpt = (label, sub, active, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `work-quick-item${active ? ' is-active' : ''}`;
      const main = document.createElement('span');
      main.textContent = label;
      b.append(main);
      if (sub) {
        const sm = document.createElement('small');
        sm.textContent = sub;
        b.append(sm);
      }
      b.onclick = () => { cwdMenu.hidden = true; fn(); };
      cwdMenu.append(b);
    };

    addSecTitle('工作目录');
    addOpt('隔离沙盒', '默认安全隔离环境', isManaged, () => opts.onSelectCwdDirect?.(''));
    for (const p of recents) {
      const name = String(p).replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || p;
      const active = !isManaged && String(curCwd).toLowerCase() === String(p).toLowerCase();
      addOpt(name, p, active, () => opts.onSelectCwdDirect?.(p));
    }
    addOpt('＋ 选择本地文件夹…', '', false, () => opts.pickCwd?.());

    if (!isManaged) {
      const curMode = settings.workspaceMode || 'auto';
      const eff = settings.effectiveWorkspaceMode === 'windows_native' ? '原生直改' : '沙盒检入';
      addSecTitle('本地项目工位模式');
      addOpt(`智能自动 (${eff})`, '按项目类型自动匹配最优工位', curMode === 'auto', () => opts.onWorkspaceModeChange?.('auto'));
      addOpt('沙盒隔离检入', '在隔离副本修改，支持彩色 Diff 一键回写', curMode === 'sandbox_checkout', () => opts.onWorkspaceModeChange?.('sandbox_checkout'));
      addOpt('Windows 原生直改', '直接读写本地文件夹并调用本机编译器', curMode === 'windows_native', () => opts.onWorkspaceModeChange?.('windows_native'));
    }
    cwdMenu.hidden = false;
  });
  attach?.addEventListener('click', () => file?.click());
  file?.addEventListener('change', () => {
    const chosen = [...(file.files || [])];
    file.value = '';
    if (chosen.length) opts.onFiles?.(chosen);
  });
  if (composer && !composer.dataset.dropBound) {
    composer.dataset.dropBound = '1';
    composer.addEventListener('dragover', (event) => {
      if (!opts.isWork?.()) return;
      event.preventDefault();
      composer.classList.add('is-drop');
    });
    composer.addEventListener('dragleave', () => composer.classList.remove('is-drop'));
    composer.addEventListener('drop', (event) => {
      composer.classList.remove('is-drop');
      if (!opts.isWork?.()) return;
      event.preventDefault();
      const files = [...(event.dataTransfer?.files || [])];
      if (files.length) opts.onFiles?.(files);
    });
  }
  const renderPending = (rows) => {
    if (!host) return;
    if (!rows?.length) { host.innerHTML = ''; host.hidden = true; return; }
    host.hidden = false;
    host.innerHTML = rows.map((row) => `
      <div class="approval-card" data-id="${escapeHtml(row.id)}" data-bot-id="${escapeHtml(row.botId)}">
        <div class="approval-card-title">待批准：${escapeHtml(riskLabel(row.action?.risk))}</div>
        <div class="approval-card-body">${escapeHtml(actionSummary(row.action))}</div>
        ${typeof row.action?.content === 'string' ? `<details><summary>查看写入内容（${row.action.content.length} 字符）</summary><pre>${escapeHtml(row.action.content.slice(0, 4000))}${row.action.content.length > 4000 ? '\n…（预览截断）' : ''}</pre></details>` : ''}
        ${row.action?.tool === 'edit' ? `<details class="change-diff-host"><summary>查看变更对比</summary></details>` : ''}
        <div class="approval-card-actions">
          <button type="button" class="approval-allow" data-allow="1">批准</button>
          <button type="button" class="approval-deny" data-allow="0">拒绝</button>
        </div>
      </div>`).join('');
    host.querySelectorAll('.approval-card').forEach((card, index) => {
      const row = rows[index];
      if (row?.action?.tool === 'edit') card.querySelector('.change-diff-host')?.append(createChangeDiff(row.action.oldText, row.action.newText));
    });
    host.querySelectorAll('[data-allow]').forEach((btn) => {
      btn.addEventListener('click', () => opts.onDecide?.(btn.closest('.approval-card')?.dataset.id, btn.dataset.allow === '1', btn.closest('.approval-card')?.dataset.botId));
    });
  };
  return { sync, renderPending };
}

function riskLabel(risk) {
  if (risk === 'write') return '写盘 / 改代码';
  if (risk === 'exec') return '隔离环境执行';
  if (risk === 'escape') return '越出项目根';
  if (risk === 'isolated') return '隔离盘路径';
  return '操作';
}

function actionSummary(action) {
  if (!action) return '';
  if (action.computer) return `${action.actorId || 'Bot'} 的独立 Linux 桌面 · ${JSON.stringify(action.computer)}`;
  const bits = [action.tool, action.path, action.command, action.query, action.pattern].filter(Boolean);
  return bits.join(' · ');
}
