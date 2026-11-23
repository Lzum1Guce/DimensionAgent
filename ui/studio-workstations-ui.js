const mk = (tag, className = '', text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};

export function bindStudioWorkstations({ api, host }) {
  if (!host) return { refresh: async () => {} };

  let cliProfiles = [];
  let bots = [];
  let capDoc = { cards: {}, ledger: [], notes: [] };
  let selectedBotId = '';
  let statusText = '';

  const setStatus = msg => {
    statusText = msg || '';
    const bar = host.querySelector('.studio-ws-status');
    if (bar) bar.textContent = statusText;
  };

  async function refresh() {
    try {
      const [cliRes, botsRes, capRes] = await Promise.all([
        api('/api/dimension/work/cli-profiles').catch(() => ({ profiles: [] })),
        api('/api/dimension/bots/lookup').catch(() => ({ bots: [] })),
        api('/api/dimension/bot-capabilities').catch(() => ({ cards: {}, ledger: [], notes: [] })),
      ]);
      cliProfiles = Array.isArray(cliRes?.profiles) ? cliRes.profiles : [];
      bots = Array.isArray(botsRes?.bots) ? botsRes.bots.filter(b => !b.deleted) : [];
      capDoc = capRes && typeof capRes === 'object' ? capRes : { cards: {}, ledger: [], notes: [] };
      if (!selectedBotId && bots.length) selectedBotId = bots[0].id;
      render();
    } catch (err) {
      setStatus(`加载工位配置失败：${err.message}`);
    }
  }

  function render() {
    host.replaceChildren();
    const wrap = mk('div', 'studio-ws-wrap');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:16px;';

    const statusLine = mk('p', 'studio-ws-status', statusText);
    statusLine.style.cssText = 'margin:0;font-size:12px;opacity:.82;';
    wrap.append(statusLine);

    // Section 1: External Subscribed Agent CLIs & Headless Pro Tools
    const cliSec = mk('section', 'cap-plugin');
    cliSec.append(
      mk('strong', '', '外部订阅 Agent CLI 与无头软件工位底座'),
      mk('p', '', '全局共享只读可执行程序（如沙盒 /opt/dimension-tools/bin 下的 Claude Code / Codex，或 Blender 无头渲染），每个 Bot 自动挂载各自独立的 HOME 凭证目录，互不串号。')
    );

    const cliList = mk('div', 'studio-cli-list');
    cliList.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:8px;';
    for (const prof of cliProfiles) {
      const row = mk('div', 'cap-plugin');
      row.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 10px;';
      const title = mk('strong', '', `${prof.name || prof.id}`);
      const badge = mk('small', '', `[${prof.platform === 'windows' ? 'Windows 原生' : 'WSL 沙盒'}] ${prof.binary || ''}`);
      const probeNote = mk('small', '', '');
      probeNote.style.cssText = 'flex-basis:100%;opacity:.8;';

      const actions = mk('div', '');
      actions.style.cssText = 'margin-left:auto;display:flex;gap:6px;';

      const probeBtn = mk('button', 'cap-plugin-toggle', '探测环境');
      probeBtn.type = 'button';
      probeBtn.onclick = async () => {
        probeBtn.disabled = true;
        probeNote.textContent = '正在探测可执行状态…';
        try {
          const res = await api('/api/dimension/work/cli-profiles', {
            method: 'POST',
            body: JSON.stringify({ action: 'probe', id: prof.id }),
          });
          const p = res?.probe || {};
          probeNote.textContent = `${p.installed ? '✓ 已就绪' : '✕ 未安装'}：${p.detail || ''}${p.versionOutput ? ` (${p.versionOutput.trim()})` : ''}`;
        } catch (err) {
          probeNote.textContent = `探测失败：${err.message}`;
        } finally {
          probeBtn.disabled = false;
        }
      };

      const toggleBtn = mk('button', 'cap-plugin-toggle', prof.enabled ? '已启用 (点击停用)' : '启用工位');
      toggleBtn.type = 'button';
      toggleBtn.onclick = async () => {
        toggleBtn.disabled = true;
        try {
          const updated = { ...prof, enabled: !prof.enabled };
          const res = await api('/api/dimension/work/cli-profiles', {
            method: 'POST',
            body: JSON.stringify(updated),
          });
          cliProfiles = Array.isArray(res?.profiles) ? res.profiles : cliProfiles;
          setStatus(`已${updated.enabled ? '启用' : '停用'}工位：${prof.name}`);
          render();
        } catch (err) {
          setStatus(err.message);
          toggleBtn.disabled = false;
        }
      };

      actions.append(probeBtn, toggleBtn);
      row.append(title, badge, actions, probeNote);
      cliList.append(row);
    }
    cliSec.append(cliList);

    // Quick add custom CLI profile
    const addForm = mk('form', 'cap-plugin-form');
    addForm.style.cssText = 'margin-top:10px;display:grid;grid-template-columns:1fr 1fr 1.4fr auto;gap:6px;align-items:end;';
    addForm.innerHTML = `
      <label>编号<input name="id" placeholder="如 gemini-cli" pattern="[a-z0-9_-]{2,48}" required></label>
      <label>显示名称<input name="name" placeholder="如 Gemini CLI 工位" required></label>
      <label>程序绝对路径<input name="binary" placeholder="/opt/dimension-tools/bin/gemini" required></label>
      <button type="submit">登记工位</button>
    `;
    addForm.onsubmit = async e => {
      e.preventDefault();
      try {
        const id = addForm.elements.id.value.trim();
        const name = addForm.elements.name.value.trim();
        const binary = addForm.elements.binary.value.trim();
        const platform = binary.startsWith('/') ? 'wsl' : 'windows';
        const res = await api('/api/dimension/work/cli-profiles', {
          method: 'POST',
          body: JSON.stringify({ id, name, binary, platform, headlessArgs: [], isolatedBotHome: true, enabled: true }),
        });
        cliProfiles = Array.isArray(res?.profiles) ? res.profiles : cliProfiles;
        addForm.reset();
        setStatus(`已登记工位：${name}`);
        render();
      } catch (err) {
        setStatus(err.message);
      }
    };
    cliSec.append(addForm);
    wrap.append(cliSec);

    // Section 2: Per-Bot Workstation Capability Card & Collaboration Ledger
    const cardSec = mk('section', 'cap-plugin');
    cardSec.append(
      mk('strong', '', '跨 Bot 工种能力卡与群聊派单账本'),
      mk('p', '', '为每个 Bot 标记专长工种、已配装备与交接规范；Work 群主分派任务时会自动按能力卡与历史配合胜率精准派单。')
    );

    if (bots.length) {
      const pickerRow = mk('div', '');
      pickerRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin:8px 0;';
      pickerRow.append(mk('span', '', '选择角色：'));
      const sel = document.createElement('select');
      for (const b of bots) {
        sel.append(new Option(`${b.name} (${b.id})`, b.id, false, b.id === selectedBotId));
      }
      sel.onchange = () => { selectedBotId = sel.value; render(); };
      pickerRow.append(sel);
      cardSec.append(pickerRow);

      const curCard = (capDoc.cards && capDoc.cards[selectedBotId]) || {};
      const cardForm = mk('form', '');
      cardForm.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
      cardForm.innerHTML = `
        <label>工种头衔<input name="roleTag" maxlength="80" placeholder="例如：全栈主程 / Blender建模师 / 豆包视觉美术 / QQ外联助理"></label>
        <label>擅长领域（逗号分隔）<input name="specialties" placeholder="例如：C++20，前端重构，性能优化"></label>
        <label>已挂载工位装备（逗号分隔）<input name="equippedTools" placeholder="例如：claude-code，doubao，blender-headless，windows-native"></label>
        <label>标准交接约定<input name="handoffContract" maxlength="240" placeholder="例如：交付源码后附带构建验证结果与相对路径产物"></label>
        <div><button type="submit">保存能力卡</button></div>
      `;
      cardForm.elements.roleTag.value = curCard.roleTag || '';
      cardForm.elements.specialties.value = Array.isArray(curCard.specialties) ? curCard.specialties.join('，') : '';
      cardForm.elements.equippedTools.value = Array.isArray(curCard.equippedTools) ? curCard.equippedTools.join('，') : '';
      cardForm.elements.handoffContract.value = curCard.handoffContract || '';

      cardForm.onsubmit = async e => {
        e.preventDefault();
        try {
          const splitTags = raw => String(raw || '').split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
          const saved = await api('/api/dimension/bot-capabilities', {
            method: 'POST',
            body: JSON.stringify({
              action: 'save-card',
              botId: selectedBotId,
              card: {
                roleTag: cardForm.elements.roleTag.value.trim(),
                specialties: splitTags(cardForm.elements.specialties.value),
                equippedTools: splitTags(cardForm.elements.equippedTools.value),
                handoffContract: cardForm.elements.handoffContract.value.trim(),
              },
            }),
          });
          if (saved?.capabilities) capDoc = saved.capabilities;
          setStatus('工种能力卡已保存，群聊派单将立即生效');
          render();
        } catch (err) {
          setStatus(err.message);
        }
      };
      cardSec.append(cardForm);
    }

    const ledgerRows = Array.isArray(capDoc.ledger) ? capDoc.ledger.slice(-6).reverse() : [];
    if (ledgerRows.length) {
      const lgWrap = mk('div', '');
      lgWrap.style.cssText = 'margin-top:10px;font-size:12px;opacity:.88;';
      lgWrap.append(mk('strong', '', '近期群聊自动沉淀协作记录：'));
      for (const r of ledgerRows) {
        lgWrap.append(mk('div', '', `• ${r.fromBotId} → ${r.toBotId} [${r.status}]：${r.taskSummary || ''}`));
      }
      cardSec.append(lgWrap);
    }

    wrap.append(cardSec);
    host.append(wrap);
  }

  return { refresh };
}
