// Work-mode left sidebar controller: Accordion Bot/Group -> Project -> Thread tree + [By Bot | By Project] view switcher.
import { openMessageMenu, messageActionNotice } from './message-context-ui.js';
import { svgIcon } from './ui-icons.js';

const VIEW_MODE_KEY = 'dimension-work-sidebar-view';
const EXPANDED_KEY = 'dimension-work-sidebar-expanded';

const ACTIVE_STATUSES = new Set(['queued', 'planning', 'running', 'waiting-approval', 'stopping']);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function projectFolderName(cwd, managed) {
  if (managed || !cwd) return '次元工坊区';
  const normalized = String(cwd).replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || normalized;
}

// Both sidebar views use the same folder identity and preserve catalog order.
function projectFolders(items) {
  const folders = new Map();
  for (const item of items) {
    const path = item.managedWorkspace ? '' : item.projectCwd || '';
    if (!folders.has(path)) {
      folders.set(path, {
        fullPath: path,
        label: projectFolderName(path, !path),
        isManaged: !path,
        items: [],
      });
    }
    folders.get(path).items.push(item);
  }
  return folders.values();
}

function sortedRosterBots(bots, byBot, isBotPinned) {
  const ranked = bots.map(bot => {
    const latest = byBot.get(bot.id)?.[0];
    return { bot, pinned: Boolean(isBotPinned?.(bot)), time: latest?.updatedAt || latest?.createdAt || '' };
  });
  return ranked.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.time.localeCompare(a.time));
}

function deriveThreadTitle(item) {
  const custom = String(item?.customTitle || '').trim();
  if (custom) return custom;
  const firstLine = String(item?.text || '').replace(/\s+/g, ' ').trim();
  if (!firstLine) return '未命名对话';
  return firstLine.length > 36 ? `${firstLine.slice(0, 36)}…` : firstLine;
}

function shortRelativeTime(isoStr) {
  if (!isoStr) return '';
  const ts = Date.parse(isoStr);
  if (!Number.isFinite(ts)) return '';
  const diffMin = Math.floor((Date.now() - ts) / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分前`;
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function createWorkRosterTree({
  api,
  host,
  getBots,
  getGroups,
  getQuery,
  getActiveState, // () => ({ botId, groupId, runId, isNewThread })
  botAvatarOf,
  groupAvatarOf,
  botDisplayNameOf,
  isBotPinned,
  onSelectThread, // ({ kind: 'bot'|'group', id, runId, projectCwd })
  onNewThread,    // ({ kind: 'bot'|'group', id, projectCwd })
  onBotContextMenu,
  onGroupContextMenu,
  promptText,     // ({ title, value, placeholder, confirmLabel }) => Promise<string|null>
  confirmDanger,  // ({ title, message, confirmLabel }) => Promise<boolean>
  onThreadDeleted,// (runId, deletedIds) => void
} = {}) {
  if (!host) {
    return { refresh: async () => {}, render: () => {}, setVisible: () => {}, items: () => [] };
  }

  let viewMode = 'bot'; // 'bot' | 'project'
  try {
    const saved = localStorage.getItem(VIEW_MODE_KEY);
    if (saved === 'bot' || saved === 'project') viewMode = saved;
  } catch {}

  let expandedSet = new Set();
  try {
    const savedExp = JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]');
    if (Array.isArray(savedExp)) expandedSet = new Set(savedExp);
  } catch {}

  const saveExpanded = () => {
    try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expandedSet].slice(-120))); } catch {}
  };

  let catalogItems = [];
  let catalogFingerprint = '';
  let lastRenderKey = '';
  let loading = false;
  let refreshTimer = 0;

  host.innerHTML = '';
  const toolbar = document.createElement('div');
  toolbar.className = 'wrt-toolbar';
  toolbar.innerHTML = `
    <div class="wrt-view-switch" role="tablist" aria-label="工作导航视角">
      <button type="button" role="tab" data-wrt-view="bot" class="${viewMode === 'bot' ? 'is-active' : ''}" aria-selected="${viewMode === 'bot'}">按伙伴</button>
      <button type="button" role="tab" data-wrt-view="project" class="${viewMode === 'project' ? 'is-active' : ''}" aria-selected="${viewMode === 'project'}">按卷宗</button>
    </div>
  `;
  const treeBody = document.createElement('div');
  treeBody.className = 'wrt-body';
  host.append(toolbar, treeBody);

  toolbar.addEventListener('click', event => {
    const btn = event.target.closest('[data-wrt-view]');
    if (!btn) return;
    const next = btn.dataset.wrtView;
    if (next !== 'bot' && next !== 'project') return;
    viewMode = next;
    try { localStorage.setItem(VIEW_MODE_KEY, viewMode); } catch {}
    toolbar.querySelectorAll('[data-wrt-view]').forEach(node => {
      const on = node.dataset.wrtView === viewMode;
      node.classList.toggle('is-active', on);
      node.setAttribute('aria-selected', String(on));
    });
    render();
  });

  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      const res = await api('/api/dimension/work/catalog');
      if (Array.isArray(res?.items)) {
        const nextFp = JSON.stringify(res.items.map(it => [it.id, it.status, it.updatedAt, it.customTitle, it.text, it.createdAt, it.projectCwd, it.managedWorkspace, it.botId, it.groupId, it.pinned, it.artifactCount]));
        catalogItems = res.items;
        if (nextFp !== catalogFingerprint) {
          catalogFingerprint = nextFp;
          render(true);
        }
      }
    } catch {
      // Keep cached catalog on transient error
    } finally {
      loading = false;
    }
  }

  function toggleExpand(key, forceOpen) {
    const next = forceOpen !== undefined ? forceOpen : !expandedSet.has(key);
    if (next) expandedSet.add(key);
    else expandedSet.delete(key);
    saveExpanded();
    render();
  }

  function openThreadMenu(item, anchor, event) {
    const title = deriveThreadTitle(item);
    openMessageMenu({
      anchor,
      ...(event?.type === 'contextmenu' ? { x: event.clientX, y: event.clientY } : {}),
      items: [
        {
          id: 'pin',
          label: item.pinned ? '取消置顶对话' : '置顶此对话',
          run: async () => {
            await api('/api/dimension/work/catalog', {
              method: 'POST',
              body: JSON.stringify({ action: 'pin', runId: item.id, pinned: !item.pinned }),
            });
            await refresh();
          },
        },
        {
          id: 'rename',
          label: '重命名标题',
          run: async () => {
            if (!promptText) return;
            const next = await promptText({
              title: '重命名项目对话',
              placeholder: '留空可恢复默认首句标题',
              value: item.customTitle || title,
              confirmLabel: '保存',
              allowEmpty: true,
            });
            if (next === null || next === undefined) return;
            const trimmed = String(next).trim();
            await api('/api/dimension/work/catalog', {
              method: 'POST',
              body: JSON.stringify({ action: 'rename', runId: item.id, title: trimmed }),
            });
            item.customTitle = trimmed;
            render();
            messageActionNotice(trimmed ? '对话标题已更新' : '已恢复默认标题');
          },
        },
        {
          id: 'delete',
          label: '删除此对话',
          danger: true,
          run: async () => {
            const ok = confirmDanger
              ? await confirmDanger({
                  title: '删除这条工作对话？',
                  message: `将移除「${title}」的对话记录（如有运行中任务将一并停止），但工作区内的本地项目文件会安全保留。`,
                  confirmLabel: '删除对话',
                })
              : true;
            if (!ok) return;
            const res = await api(`/api/dimension/work/runs/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
            const removedIds = new Set(res?.deletedIds || [item.id]);
            catalogItems = catalogItems.filter(row => !removedIds.has(row.id));
            onThreadDeleted?.(item.id, [...removedIds]);
            render();
            messageActionNotice('已删除工作对话');
          },
        },
      ],
    });
  }

  function statusDotClass(status) {
    if (status === 'waiting-approval') return 'is-approval';
    if (ACTIVE_STATUSES.has(status)) return 'is-running';
    if (status === 'failed' || status === 'blocked' || status === 'interrupted') return 'is-failed';
    if (status === 'completed') return 'is-done';
    return 'is-idle';
  }

  function renderThreadRow(item, activeState, { ownerPrefix = '' } = {}) {
    const isCurrent = !activeState.isNewThread && activeState.runId === item.id;
    const title = deriveThreadTitle(item);
    const timeLabel = shortRelativeTime(item.updatedAt || item.createdAt);
    const row = document.createElement('div');
    row.className = `wrt-thread${isCurrent ? ' is-active' : ''}${item.pinned ? ' is-pinned' : ''}`;
    row.dataset.runId = item.id;

    const mainBtn = document.createElement('button');
    mainBtn.type = 'button';
    mainBtn.className = 'wrt-thread-btn';
    mainBtn.title = `${title}${item.projectCwd && !item.managedWorkspace ? `\n项目：${item.projectCwd}` : ''}`;
    mainBtn.innerHTML = `
      <span class="wrt-dot ${statusDotClass(item.status)}" aria-hidden="true"></span>
      ${item.pinned ? `<span class="wrt-pin" title="已置顶" aria-hidden="true">${svgIcon('pin', 11)}</span>` : ''}
      ${ownerPrefix ? `<span class="wrt-thread-owner">${esc(ownerPrefix)}</span>` : ''}
      <span class="wrt-thread-title">${esc(title)}</span>
      <span class="wrt-thread-meta">${item.artifactCount > 0 ? `<span class="wrt-art-count" title="${item.artifactCount} 个成品文件">${svgIcon('paperclip', 11)}${item.artifactCount}</span>` : ''}${esc(timeLabel)}</span>
    `;
    mainBtn.onclick = () => {
      onSelectThread?.({
        kind: item.groupId ? 'group' : 'bot',
        id: item.groupId || item.botId,
        runId: item.id,
        projectCwd: !item.managedWorkspace ? item.projectCwd : '',
      });
    };
    mainBtn.oncontextmenu = event => {
      event.preventDefault();
      event.stopPropagation();
      openThreadMenu(item, row, event);
    };
    mainBtn.onkeydown = event => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault();
        openThreadMenu(item, row, event);
      }
    };

    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'wrt-thread-more';
    moreBtn.textContent = '⋯';
    moreBtn.title = '更多操作';
    moreBtn.setAttribute('aria-label', '对话操作菜单');
    moreBtn.onclick = event => {
      event.preventDefault();
      event.stopPropagation();
      openThreadMenu(item, moreBtn, event);
    };

    row.append(mainBtn, moreBtn);
    return row;
  }

  function matchesSearch(item, ownerName, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      String(ownerName || '').toLowerCase().includes(q) ||
      deriveThreadTitle(item).toLowerCase().includes(q) ||
      String(item.text || '').toLowerCase().includes(q) ||
      String(item.projectCwd || '').toLowerCase().includes(q)
    );
  }

  function renderByBot(bots, groups, query, activeState) {
    const frag = document.createDocumentFragment();
    const byGroup = new Map(), byBot = new Map();
    for (const item of catalogItems) {
      const owners = item.groupId ? byGroup : byBot;
      const id = item.groupId || item.botId;
      if (!owners.has(id)) owners.set(id, []);
      owners.get(id).push(item);
    }

    // Auto-expand currently active owner on initial render
    if (activeState.groupId) expandedSet.add(`group:${activeState.groupId}`);
    else if (activeState.botId) expandedSet.add(`bot:${activeState.botId}`);

    // 1. Groups section
    const groupSection = document.createElement('section');
    groupSection.className = 'wrt-section';
    const groupHead = document.createElement('div');
    groupHead.className = 'wrt-section-title';
    groupHead.textContent = '协作圆桌群';
    groupSection.append(groupHead);

    let visibleGroups = 0;
    for (const group of groups) {
      const gItems = byGroup.get(group.id) || [];
      const filteredItems = query ? gItems.filter(it => matchesSearch(it, group.name, query)) : gItems;
      const nameMatches = !query || String(group.name || '').toLowerCase().includes(query.toLowerCase());
      if (!nameMatches && !filteredItems.length) continue;
      visibleGroups++;

      const key = `group:${group.id}`;
      const isExpanded = Boolean(query) || expandedSet.has(key);
      const isOwnerActive = activeState.groupId === group.id;
      const hasRunning = gItems.some(it => ACTIVE_STATUSES.has(it.status));

      const card = document.createElement('div');
      card.className = `wrt-node${isOwnerActive ? ' is-owner-active' : ''}${isExpanded ? ' is-expanded' : ''}`;

      const row = document.createElement('div');
      row.className = 'wrt-owner-row';

      const caretBtn = document.createElement('button');
      caretBtn.type = 'button';
      caretBtn.className = 'wrt-caret';
      caretBtn.setAttribute('aria-label', isExpanded ? '收起项目列表' : '展开项目列表');
      caretBtn.innerHTML = svgIcon(isExpanded ? 'chevronDown' : 'chevronRight', 12);
      caretBtn.onclick = e => { e.stopPropagation(); toggleExpand(key); };

      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'wrt-owner-btn';
      selectBtn.dataset.groupId = group.id;
      selectBtn.innerHTML = `
        <span class="seal-slot wrt-avatar">${groupAvatarOf(group, 32)}</span>
        <span class="wrt-owner-text">
          <span class="wrt-owner-name">${esc(group.name || '未命名群')}</span>
          <span class="wrt-owner-sub">${hasRunning ? '<span class="wrt-live-pill">协作中</span>' : `${gItems.length} 个项目对话`}</span>
        </span>
      `;
      selectBtn.onclick = () => {
        if (!expandedSet.has(key)) toggleExpand(key, true);
        else if (isOwnerActive) { toggleExpand(key, false); return; }
        if (gItems.length) {
          onSelectThread?.({ kind: 'group', id: group.id, runId: gItems[0].id, projectCwd: !gItems[0].managedWorkspace ? gItems[0].projectCwd : '' });
        } else {
          onNewThread?.({ kind: 'group', id: group.id });
        }
      };
      selectBtn.oncontextmenu = e => {
        e.preventDefault();
        onGroupContextMenu?.(group, e);
      };

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'wrt-new-btn';
      addBtn.title = `在「${group.name}」新建圆桌任务`;
      addBtn.setAttribute('aria-label', `在 ${group.name} 新建圆桌任务`);
      addBtn.textContent = '＋';
      addBtn.onclick = e => {
        e.stopPropagation();
        expandedSet.add(key);
        saveExpanded();
        onNewThread?.({ kind: 'group', id: group.id });
      };

      row.append(caretBtn, selectBtn, addBtn);
      card.append(row);

      if (isExpanded) {
        const sub = document.createElement('div');
        sub.className = 'wrt-children';
        if (isOwnerActive && activeState.isNewThread) {
          const draftRow = document.createElement('div');
          draftRow.className = 'wrt-thread is-active is-draft';
          draftRow.innerHTML = '<span class="wrt-dot is-running"></span><span class="wrt-thread-title">新圆桌对话（待发起…）</span>';
          sub.append(draftRow);
        }
        const shown = query ? filteredItems : gItems;
        if (!shown.length && !(isOwnerActive && activeState.isNewThread)) {
          const empty = document.createElement('button');
          empty.type = 'button';
          empty.className = 'wrt-empty-action';
          empty.textContent = '暂无历史项目 · 点击发起新圆桌对话';
          empty.onclick = () => onNewThread?.({ kind: 'group', id: group.id });
          sub.append(empty);
        } else {
          renderGroupedByFolder(sub, shown, activeState, { kind: 'group', id: group.id });
        }
        card.append(sub);
      }

      groupSection.append(card);
    }

    if (!visibleGroups && !query) {
      const hint = document.createElement('p');
      hint.className = 'wrt-empty-hint';
      hint.textContent = '还没有协作群，可点右上角“＋”创建或调入。';
      groupSection.append(hint);
    }
    if (visibleGroups || !query) frag.append(groupSection);

    // 2. Bots section
    const botSection = document.createElement('section');
    botSection.className = 'wrt-section';
    const botHead = document.createElement('div');
    botHead.className = 'wrt-section-title';
    botHead.textContent = '角色与经历项目';
    botSection.append(botHead);

    let visibleBots = 0;
    for (const { bot, pinned } of sortedRosterBots(bots, byBot, isBotPinned)) {
      const bName = botDisplayNameOf(bot);
      const bItems = byBot.get(bot.id) || [];
      const filteredItems = query ? bItems.filter(it => matchesSearch(it, bName, query)) : bItems;
      const nameMatches = !query || String(bName || '').toLowerCase().includes(query.toLowerCase());
      if (!nameMatches && !filteredItems.length) continue;
      visibleBots++;

      const key = `bot:${bot.id}`;
      const isExpanded = Boolean(query) || expandedSet.has(key);
      const isOwnerActive = !activeState.groupId && activeState.botId === bot.id;
      const hasRunning = bItems.some(it => ACTIVE_STATUSES.has(it.status));
      const projectSet = new Set(bItems.filter(it => !it.managedWorkspace && it.projectCwd).map(it => projectFolderName(it.projectCwd, false)));

      const card = document.createElement('div');
      card.className = `wrt-node${isOwnerActive ? ' is-owner-active' : ''}${isExpanded ? ' is-expanded' : ''}`;

      const row = document.createElement('div');
      row.className = 'wrt-owner-row';

      const caretBtn = document.createElement('button');
      caretBtn.type = 'button';
      caretBtn.className = 'wrt-caret';
      caretBtn.setAttribute('aria-label', isExpanded ? '收起项目列表' : '展开项目列表');
      caretBtn.innerHTML = svgIcon(isExpanded ? 'chevronDown' : 'chevronRight', 12);
      caretBtn.onclick = e => { e.stopPropagation(); toggleExpand(key); };

      const subSummary = hasRunning
        ? '<span class="wrt-live-pill">执行中</span>'
        : bItems.length
          ? `${bItems.length} 条对话${projectSet.size ? ` · ${[...projectSet].slice(0, 2).map(esc).join(' / ')}` : ''}`
          : '尚无项目记录';

      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'wrt-owner-btn';
      selectBtn.dataset.id = bot.id;
      selectBtn.innerHTML = `
        <span class="seal-slot wrt-avatar">${botAvatarOf({ ...bot, name: bName }, 32, hasRunning ? 'thinking' : 'idle')}</span>
        <span class="wrt-owner-text">
          <span class="wrt-owner-name">${pinned ? `<span class="wrt-pin-bot" aria-hidden="true">${svgIcon('pin', 11)}</span>` : ''}${esc(bName)}</span>
          <span class="wrt-owner-sub">${subSummary}</span>
        </span>
      `;
      selectBtn.onclick = () => {
        if (!expandedSet.has(key)) toggleExpand(key, true);
        else if (isOwnerActive) { toggleExpand(key, false); return; }
        if (bItems.length) {
          onSelectThread?.({ kind: 'bot', id: bot.id, runId: bItems[0].id, projectCwd: !bItems[0].managedWorkspace ? bItems[0].projectCwd : '' });
        } else {
          onNewThread?.({ kind: 'bot', id: bot.id });
        }
      };
      selectBtn.oncontextmenu = e => {
        e.preventDefault();
        onBotContextMenu?.(bot.id, { x: e.clientX, y: e.clientY });
      };

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'wrt-new-btn';
      addBtn.title = `与「${bName}」开启新项目对话`;
      addBtn.setAttribute('aria-label', `与 ${bName} 开启新项目对话`);
      addBtn.textContent = '＋';
      addBtn.onclick = e => {
        e.stopPropagation();
        expandedSet.add(key);
        saveExpanded();
        onNewThread?.({ kind: 'bot', id: bot.id });
      };

      row.append(caretBtn, selectBtn, addBtn);
      card.append(row);

      if (isExpanded) {
        const sub = document.createElement('div');
        sub.className = 'wrt-children';
        if (isOwnerActive && activeState.isNewThread) {
          const draftRow = document.createElement('div');
          draftRow.className = 'wrt-thread is-active is-draft';
          draftRow.innerHTML = '<span class="wrt-dot is-running"></span><span class="wrt-thread-title">新项目对话（待发起…）</span>';
          sub.append(draftRow);
        }
        const shown = query ? filteredItems : bItems;
        if (!shown.length && !(isOwnerActive && activeState.isNewThread)) {
          const empty = document.createElement('button');
          empty.type = 'button';
          empty.className = 'wrt-empty-action';
          empty.textContent = '还没有经历过的项目 · 点击新建对话';
          empty.onclick = () => onNewThread?.({ kind: 'bot', id: bot.id });
          sub.append(empty);
        } else {
          renderGroupedByFolder(sub, shown, activeState, { kind: 'bot', id: bot.id });
        }
        card.append(sub);
      }

      botSection.append(card);
    }

    if (!visibleBots && query && !visibleGroups) {
      const none = document.createElement('p');
      none.className = 'wrt-empty-hint';
      none.textContent = '没有匹配的 Bot、项目或历史对话';
      botSection.append(none);
    }

    frag.append(botSection);
    return frag;
  }

  function renderGroupedByFolder(container, items, activeState, ownerInfo) {
    const hasCustomFolders = items.some(it => !it.managedWorkspace && it.projectCwd);
    if (!hasCustomFolders) {
      for (const it of items) container.append(renderThreadRow(it, activeState));
      return;
    }

    for (const bucket of projectFolders(items)) {
      const folderWrap = document.createElement('div');
      folderWrap.className = 'wrt-folder-group';
      const head = document.createElement('div');
      head.className = 'wrt-folder-head';
      head.title = bucket.fullPath || '隔离托管工作区';
      head.innerHTML = `<span class="wrt-folder-icon" aria-hidden="true">${svgIcon(bucket.isManaged ? 'box' : 'folder', 12)}</span><span class="wrt-folder-name">${esc(bucket.label)}</span>`;
      if (!bucket.isManaged) {
        const quickNew = document.createElement('button');
        quickNew.type = 'button';
        quickNew.className = 'wrt-folder-new';
        quickNew.textContent = '＋';
        quickNew.title = `在项目 ${bucket.label} 下新建对话`;
        quickNew.onclick = e => {
          e.stopPropagation();
          onNewThread?.({ ...ownerInfo, projectCwd: bucket.fullPath });
        };
        head.append(quickNew);
      }
      folderWrap.append(head);
      for (const it of bucket.items) {
        folderWrap.append(renderThreadRow(it, activeState));
      }
      container.append(folderWrap);
    }
  }

  function renderByProject(bots, groups, query, activeState) {
    const frag = document.createDocumentFragment();
    const botMap = new Map(bots.map(b => [b.id, botDisplayNameOf(b)]));
    const groupMap = new Map(groups.map(g => [g.id, g.name]));
    const visibleItems = catalogItems.filter(item => {
      const owners = item.groupId ? groupMap : botMap;
      const id = item.groupId || item.botId;
      return owners.has(id) && matchesSearch(item, owners.get(id), query);
    });

    if (!visibleItems.length) {
      const empty = document.createElement('p');
      empty.className = 'wrt-empty-hint';
      empty.textContent = query ? '没有匹配的项目或目标对话' : '还没有任何项目工作记录。切回「按伙伴」点击“＋”即可开始第一个项目！';
      frag.append(empty);
      return frag;
    }

    for (const proj of projectFolders(visibleItems)) {
      const closedKey = `closed:proj:${proj.fullPath || '__managed__'}`;
      const isOpen = Boolean(query) || !expandedSet.has(closedKey);
      const box = document.createElement('section');
      box.className = `wrt-proj-card${isOpen ? ' is-open' : ''}`;

      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'wrt-proj-head';
      head.title = proj.fullPath || '各 Bot 默认独立托管工作区';
      head.innerHTML = `
        <span class="wrt-proj-caret" aria-hidden="true">${svgIcon(isOpen ? 'chevronDown' : 'chevronRight', 12)}</span>
        <span class="wrt-proj-icon" aria-hidden="true">${svgIcon(proj.isManaged ? 'box' : 'folder', 13)}</span>
        <span class="wrt-proj-title">${esc(proj.label)}</span>
        <span class="wrt-proj-count">${proj.items.length}</span>
      `;
      head.onclick = () => {
        if (expandedSet.has(closedKey)) expandedSet.delete(closedKey);
        else expandedSet.add(closedKey);
        saveExpanded();
        render();
      };
      box.append(head);

      if (isOpen) {
        const list = document.createElement('div');
        list.className = 'wrt-proj-list';
        for (const it of proj.items) {
          const ownerLabel = it.groupId
            ? `群·${groupMap.get(it.groupId) || it.groupId}`
            : (botMap.get(it.botId) || it.botId);
          list.append(renderThreadRow(it, activeState, { ownerPrefix: ownerLabel }));
        }
        box.append(list);
      }
      frag.append(box);
    }

    return frag;
  }

  function render(force = true) {
    if (host.hidden) return;
    const bots = getBots?.() || [];
    const groups = getGroups?.() || [];
    const query = String(getQuery?.() || '').trim();
    const activeState = getActiveState?.() || {};
    const renderKey = JSON.stringify([
      viewMode,
      query,
      activeState,
      [...expandedSet],
      bots.map(b => [b.id, b.name]),
      groups.map(g => [g.id, g.name]),
      catalogFingerprint,
    ]);
    if (!force && renderKey === lastRenderKey && treeBody.childElementCount > 0) return;
    lastRenderKey = renderKey;

    const prevScroll = treeBody.scrollTop;
    treeBody.replaceChildren(
      viewMode === 'project'
        ? renderByProject(bots, groups, query, activeState)
        : renderByBot(bots, groups, query, activeState)
    );
    treeBody.scrollTop = prevScroll;
  }

  function scheduleNextRefresh() {
    clearTimeout(refreshTimer);
    if (host.hidden || document.hidden) return;
    const hasActive = catalogItems.some(it => ACTIVE_STATUSES.has(it.status));
    const delay = hasActive ? 5000 : 18000;
    refreshTimer = setTimeout(async () => {
      if (!document.hidden && !host.hidden) await refresh();
      scheduleNextRefresh();
    }, delay);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !host.hidden) {
      void refresh().finally(scheduleNextRefresh);
    } else {
      clearTimeout(refreshTimer);
    }
  });

  function setVisible(visible) {
    host.hidden = !visible;
    clearTimeout(refreshTimer);
    if (visible) {
      render(false);
      void refresh().finally(scheduleNextRefresh);
    }
  }

  return {
    refresh,
    render,
    setVisible,
    items: () => catalogItems,
    latestFor(kind, id) {
      return catalogItems.find(it => (kind === 'group' ? it.groupId === id : (!it.groupId && it.botId === id))) || null;
    },
  };
}
