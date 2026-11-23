/** Selection is local until confirmation; membership is committed in one PATCH. */
export function openGroupInviteDialog({ group, mode, candidates, api, showModal, closeModal, nameOf, addToRoster, mergeBots, onSaved, notify }) {
  showModal(`<div class="modal-head"><h2>邀请进群</h2><button type="button" class="icon-btn" data-close>关闭</button></div>
    <div class="modal-body group-invite-dialog">
      <p class="setup-wiz-hint">可多选，一次邀请加入。</p>
      <p class="setup-wiz-section-title">已启动的 Bot</p><div id="inviteActiveList"></div>
      <p class="setup-wiz-section-title">从角色库选择</p>
      <input id="inviteLibSearch" class="setup-wiz-input" maxlength="80" placeholder="搜我的 Bot、角色名或作品名…" autocomplete="off">
      <div id="inviteLibResults"></div>
      <button type="button" class="text-btn" id="inviteLibMore" hidden>加载更多目录角色</button>
      <div class="group-invite-footer"><div id="inviteSelected" class="group-invite-selected" aria-label="已选成员"></div>
        <p id="inviteMsg" class="muted" role="status"></p>
        <div class="group-invite-actions"><button type="button" class="text-btn" id="inviteClear">清空选择</button><button type="button" class="text-btn" id="inviteConfirm" disabled>邀请加入（0）</button></div>
      </div></div>`);
  const dialog = document.querySelector('.group-invite-dialog');
  const get = id => dialog.querySelector('#' + id);
  const selected = new Map(), resolved = new Map(), members = new Set(group.members || []);
  const activeIds = new Set(candidates.map(bot => bot.id));
  let busy = false, timer, sequence = 0, nextOffset = 0, revision = '', entries = [];
  const sync = () => {
    get('inviteConfirm').textContent = `邀请加入（${selected.size}）`;
    get('inviteConfirm').disabled = busy || !selected.size;
    get('inviteClear').disabled = busy || !selected.size;
    for (const input of dialog.querySelectorAll('input[type=checkbox]')) {
      input.checked = selected.has(input.dataset.inviteKey); input.disabled = busy;
    }
    get('inviteSelected').replaceChildren(...[...selected].map(([key, item]) => {
      const chip = document.createElement('button'); chip.type = 'button'; chip.textContent = item.name + ' ×';
      chip.setAttribute('aria-label', '取消选择 ' + item.name); chip.disabled = busy;
      chip.onclick = () => { selected.delete(key); sync(); }; return chip;
    }));
  };
  const choice = item => {
    const label = document.createElement('label'); label.className = 'group-invite-option';
    const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.inviteKey = item.key;
    if (item.botId) input.dataset.inviteBot = item.botId;
    const name = document.createElement('span'); name.textContent = item.name;
    input.onchange = () => { if (input.checked) selected.set(item.key, item); else selected.delete(item.key); sync(); };
    label.append(input, name); return label;
  };
  const owned = bot => ({ key: 'bot:' + bot.id, botId: bot.id, name: nameOf(bot), bot });
  get('inviteActiveList').replaceChildren(...candidates.filter(bot => !members.has(bot.id)).map(bot => choice(owned(bot))));
  if (!get('inviteActiveList').childElementCount) get('inviteActiveList').textContent = '已启动的 Bot 都在群里了，可以从角色库选择。';
  const search = async (append = false) => {
    const ticket = ++sequence, query = get('inviteLibSearch').value.trim();
    get('inviteLibMore').disabled = true;
    try {
      const data = await api('/api/dimension/library?q=' + encodeURIComponent(query) +
        (append ? '&offset=' + nextOffset + '&revision=' + encodeURIComponent(revision) : ''));
      if (!dialog.isConnected || ticket !== sequence) return;
      entries = append ? [...entries, ...(data.results || [])] : data.results || [];
      nextOffset = data.nextOffset; revision = data.directoryRevision;
      const local = (data.owned || []).filter(bot => !members.has(bot.id) && !activeIds.has(bot.id)).slice(0, 80);
      const external = entries.map(item => ({ key: JSON.stringify(['catalog', item.sourceId, item.entryId]), name: item.name,
        identity: { sourceId: item.sourceId, entryId: item.entryId, revision: item.revision } }));
      get('inviteLibResults').replaceChildren(...local.map(bot => choice(owned(bot))), ...external.map(choice));
      if (!get('inviteLibResults').childElementCount) get('inviteLibResults').textContent = query ? '没有匹配的可邀请角色。' : '没有其他可邀请角色，可以先创建 Bot 或导入角色目录。';
      get('inviteLibMore').hidden = !data.hasMore;
      sync();
    } catch (error) { if (dialog.isConnected && ticket === sequence) get('inviteMsg').textContent = error.message || '角色库读取失败。'; }
    finally { if (dialog.isConnected && ticket === sequence) get('inviteLibMore').disabled = busy; }
  };
  get('inviteLibSearch').oninput = () => { clearTimeout(timer); ++sequence; timer = setTimeout(() => { if (dialog.isConnected) void search(); }, 200); };
  get('inviteLibMore').onclick = () => { void search(true); };
  get('inviteClear').onclick = () => { selected.clear(); sync(); };
  get('inviteConfirm').onclick = async () => {
    if (busy || !selected.size) return;
    busy = true; sync(); get('inviteLibSearch').disabled = true; get('inviteLibMore').disabled = true;
    get('inviteMsg').textContent = '正在邀请…';
    try {
      const ids = [];
      for (const [key, item] of selected) {
        let botId = item.botId || resolved.get(key);
        if (!botId) {
          const imported = await api('/api/dimension/library/import', { method: 'POST', body: JSON.stringify(item.identity) });
          botId = imported.bot?.id;
          if (!botId) throw new Error('角色引入失败，请重试。');
          resolved.set(key, botId); mergeBots(imported.bots || [imported.bot]);
        } else if (item.bot) mergeBots([item.bot]);
        if (!dialog.isConnected) return;
        await addToRoster(botId, mode);
        ids.push(botId);
      }
      if (!dialog.isConnected) return;
      // Merge with the current roster so another client's additions are not lost.
      const latest = await api(`/api/dimension/groups/${encodeURIComponent(group.id)}?limit=1&mode=${mode === 'work' ? 'work' : 'discuss'}`);
      if (!dialog.isConnected) return;
      const current = latest.group;
      const result = await api(`/api/dimension/groups/${encodeURIComponent(group.id)}`, { method: 'PATCH',
        body: JSON.stringify({ members: [...new Set([...(current.members || []), ...ids])], baseRevision: current.revision }) });
      onSaved(result);
      if (dialog.isConnected) closeModal();
      notify(`已邀请 ${new Set(ids).size} 名成员加入群聊`);
    } catch (error) {
      if (dialog.isConnected) get('inviteMsg').textContent = (error.message || '邀请失败，请重试。') + (resolved.size ? ' 已引入的角色保留在角色库，重试不会重复创建。' : '');
    } finally {
      busy = false;
      if (dialog.isConnected) { sync(); get('inviteLibSearch').disabled = false; get('inviteLibMore').disabled = false; }
    }
  };
  void search();
}
