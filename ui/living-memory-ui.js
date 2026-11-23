// DimensionAgent 0.4.9 Living Memory & 4-Core Mind Loop UI Module.
import { svgIcon } from './ui-icons.js';

const mk = (tag, className = '', text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const STAGE_LABELS = {
  active: '余温犹存',
  fading: '涟漪渐平',
  settled: '静水深流',
  calm: '澄明待命',
};

// 统一错误提示：优先全局 toast，退回到模块内可见文字。
const notifyError = (message, fallbackHost) => {
  const text = String(message || '操作失败，请稍后重试。');
  let shown = false;
  try { if (typeof window.__dimensionToast === 'function') { window.__dimensionToast(text, { level: 'error' }); shown = true; } } catch {}
  if (!shown && fallbackHost?.isConnected) {
    let note = fallbackHost.querySelector(':scope > .lm-error-note');
    if (!note) { note = mk('p', 'lm-status-note lm-error-note'); note.setAttribute('role', 'alert'); fallbackHost.prepend(note); }
    note.textContent = text;
  }
};
const MODEL_HINT = ' · 会调用模型';

export async function mountLivingMemorySection({
  api,
  host,
  entriesHost,
  botId,
  groupId = '',
  onNeedReload,
}) {
  if (!host || !botId) return;
  let state = null;
  try {
    state = await api(`/api/dimension/living-memory?botId=${encodeURIComponent(botId)}&groupId=${encodeURIComponent(groupId)}`);
  } catch (err) {
    if (host.isConnected) host.replaceChildren(mk('p', 'lm-status-note', `✦ 活体记忆回廊暂时没能打开：${err?.message || '读取失败'}。稍后重新打开记忆面板即可重试。`));
    notifyError(`活体记忆读取失败：${err?.message || '请稍后重试'}`);
    return;
  }
  if (!host.isConnected) return;

  const paintPrivacyBadges = (visMap = {}) => {
    if (!entriesHost || groupId) return;
    for (const card of entriesHost.querySelectorAll('.memory-card[data-id]')) {
      const mid = card.dataset.id;
      if (!mid) continue;
      let pill = card.querySelector('.lm-vis-pill');
      if (!pill) {
        pill = mk('button', 'lm-vis-pill');
        pill.type = 'button';
        card.insertBefore(pill, card.firstChild);
      }
      const cur = visMap[mid] === 'private_secret' ? 'private_secret' : 'public_self';
      const applyVisual = v => {
        pill.dataset.vis = v;
        pill.classList.toggle('is-secret', v === 'private_secret');
        pill.textContent = v === 'private_secret' ? '私密心事 · 结界封存' : '公开习性 · 茶会可携';
        pill.title = v === 'private_secret'
          ? '已封入双人私密结界，绝不带入任何群聊茶会；点击可切换为公开习性'
          : '这位伙伴在群聊茶会中也记得这项偏好；点击可封存为私密心事';
      };
      applyVisual(cur);
      pill.onclick = async () => {
        const next = pill.dataset.vis === 'private_secret' ? 'public_self' : 'private_secret';
        pill.disabled = true;
        try {
          const updated = await api('/api/dimension/living-memory', {
            method: 'POST',
            body: JSON.stringify({ action: 'set-visibility', botId, groupId: '', memoryId: mid, visibility: next }),
          });
          visMap[mid] = next;
          applyVisual(next);
          if (updated?.visibility) state.visibility = updated.visibility;
        } catch (err) {
          notifyError(`切换记忆可见性失败：${err?.message || '请稍后重试'}`, host);
        }
        finally { pill.disabled = false; }
      };
    }
  };

  const render = () => {
    host.replaceChildren();
    const wrap = mk('section', 'lm-studio-panel');

    // 1. Sleep-Cycle Consolidation Bar
    const metaBar = mk('div', 'lm-metabolism-bar');
    const metaInfo = mk('div', 'lm-metabolism-info');
    const metaTitle = mk('strong', 'lm-bar-title');
    metaTitle.innerHTML = `${svgIcon('sparkles', 14)} <span>活体记忆回廊 · 梦境新陈代谢</span>`;
    const metaSub = mk('span', 'lm-bar-sub',
      groupId
        ? '已开启跨词语义联想、自然时序锚点与公开习性携带（私密心事自动结界隔离）'
        : '已开启 L0 羁绊底牌常驻、混合语义联想、自然时序感知与茶会往事回溯'
    );
    metaInfo.append(metaTitle, metaSub);

    const sleepBtn = mk('button', 'deliverable-btn is-primary lm-sleep-btn');
    sleepBtn.type = 'button';
    sleepBtn.innerHTML = `${svgIcon('sync', 13)}<span>一键入梦整理${MODEL_HINT}</span>`;
    sleepBtn.title = '在梦境中将高频动态凝结为永恒记忆、归并重影、抚平前后矛盾并拂去过期星屑（会调用模型，可能消耗额度）';

    const statusLine = mk('p', 'lm-status-note');
    statusLine.hidden = true;

    sleepBtn.onclick = async () => {
      sleepBtn.disabled = true;
      statusLine.hidden = false;
      statusLine.textContent = '✦ 正在潜入梦境整理记忆星屑与抚平矛盾…';
      try {
        const res = await api('/api/dimension/living-memory', {
          method: 'POST',
          body: JSON.stringify({ action: 'consolidate', botId, groupId, useModel: true }),
        });
        if (res?.state) state = res.state;
        const p = res?.promotedMidCount || 0;
        const m = res?.mergedDuplicateCount || 0;
        const c = res?.conflictsResolved || 0;
        const e = res?.expiredMidCleaned || 0;
        statusLine.textContent = `✦ 梦境整理完毕：凝结近期动态 ${p} 枚 · 归并重影 ${m} 处 · 抚平矛盾 ${c} 处 · 拂去过期星屑 ${e} 枚。`;
        if ((p + m + c + e) > 0 && onNeedReload) {
          await onNeedReload();
          return;
        }
        render();
      } catch (err) {
        statusLine.textContent = `整理未竟：${err.message}`;
        notifyError(`入梦整理失败：${err?.message || '请稍后重试'}`);
      } finally {
        sleepBtn.disabled = false;
      }
    };

    metaBar.append(metaInfo, sleepBtn);
    wrap.append(metaBar, statusLine);

    // 2. Dynamic Mood & Rapport Slice (Private Scope)
    if (!groupId) {
      const aff = state?.affect || {};
      const affCard = mk('div', 'lm-affect-card');
      const affHead = mk('div', 'lm-affect-head');
      const stage = aff.stage || 'calm';
      affHead.append(
        mk('strong', '', '当下心绪切片与双人默契手札（防 OOC 灵韵镀层）'),
        mk('span', `lm-stage-pill is-${stage}`, `${STAGE_LABELS[stage] || '澄明'}${aff.relativeTime ? ` · ${aff.relativeTime}` : ''}`)
      );

      const grid = mk('div', 'lm-affect-grid');
      const moodField = mk('label', 'lm-field');
      moodField.append(mk('span', '', '近期心绪余温（随昼夜自然平复，绝不污染原初人设）'));
      const moodInput = mk('input', '');
      moodInput.type = 'text';
      moodInput.maxLength = 140;
      moodInput.placeholder = '例如：刚与你联手摆平了棘手难题，眉眼舒展、语调轻快';
      moodInput.value = aff.moodWarmth || '';
      moodField.append(moodInput);

      const rapField = mk('label', 'lm-field');
      rapField.append(mk('span', '', '相处默契备忘（专属暗号、对话节奏与避雷针）'));
      const rapInput = mk('input', '');
      rapInput.type = 'text';
      rapInput.maxLength = 200;
      rapInput.placeholder = '例如：偏爱开门见山给结论，不喜客套寒暄，深夜聊技术更有精神';
      rapInput.value = aff.rapportNotes || '';
      rapField.append(rapInput);

      grid.append(moodField, rapField);

      const affActions = mk('div', 'lm-affect-actions');
      const saveAffBtn = mk('button', 'text-btn', '铭刻心绪与默契');
      saveAffBtn.type = 'button';
      const affNote = mk('span', 'muted', '');
      saveAffBtn.onclick = async () => {
        saveAffBtn.disabled = true;
        try {
          state = await api('/api/dimension/living-memory', {
            method: 'POST',
            body: JSON.stringify({
              action: 'update-affect',
              botId,
              moodWarmth: moodInput.value,
              rapportNotes: rapInput.value,
            }),
          });
          affNote.textContent = '✦ 已铭刻最新心绪切片';
        } catch (err) {
          affNote.textContent = err.message;
        } finally {
          saveAffBtn.disabled = false;
        }
      };
      affActions.append(saveAffBtn, affNote);
      affCard.append(affHead, grid, affActions);
      wrap.append(affCard);
    }

    // 3. Work -> Chat Collaboration Bridge Episodes
    const workEps = state?.workEpisodes || [];
    if (workEps.length > 0) {
      const epDetails = mk('details', 'lm-work-bridge');
      epDetails.append(mk('summary', '', `✦ 并肩作战的委托余音（${workEps.length} 卷 · 日常闲谈自动可忆）`));
      const epList = mk('div', 'lm-work-list');
      for (const ep of workEps.slice(0, 6)) {
        const item = mk('div', 'lm-work-item');
        const where = ep.groupName ? `结社「${ep.groupName}」` : '独奏工坊';
        item.append(
          mk('div', 'lm-work-meta', `${ep.relativeTime || '近期'} · ${where} · ${ep.participants || ''}`),
          mk('div', 'lm-work-body', `${ep.taskBrief} → ${ep.outcomeSummary}`)
        );
        epList.append(item);
      }
      epDetails.append(epList);
      wrap.append(epDetails);
    }

    // 4. Shared Lorebook & Zero-Config Web Meme Lookup Studio
    const loreMount = mk('div', 'lm-lore-mount');
    wrap.append(loreMount);
    void mountLorebookCard({ api, host: loreMount, botId, groupId });

    host.append(wrap);
    paintPrivacyBadges(state?.visibility || {});
  };

  render();
  return {
    repaintBadges: () => paintPrivacyBadges(state?.visibility || {}),
  };
}

async function mountLorebookCard({ api, host, botId, groupId = '' }) {
  if (!host) return;
  let loreState = null;
  try {
    loreState = await api('/api/dimension/lorebook');
  } catch (err) {
    if (host.isConnected) {
      host.replaceChildren(mk('p', 'lm-status-note', `✦ 共同梗词典暂时读取失败：${err?.message || '请稍后重试'}`));
    }
    return;
  }
  if (!host.isConnected) return;

  const sourceBadgeText = (src) => {
    if (src === 'auto_learned') return '聊天学会';
    if (src === 'imported') return '梗包导入';
    if (src === 'web_cached') return '联网沉淀';
    return '手动录入';
  };
  const scopeBadgeText = (sc) => {
    if (!sc || sc === 'global') return '全员共享';
    if (sc.startsWith('bot:')) return `仅 ${sc.slice(4)}`;
    if (sc.startsWith('group:')) return '当前群聊';
    return sc;
  };

  let sourcesPanelOpen = false;
  let lastLookupRes = null;

  const normalizeLookupConfig = (raw) => {
    const cfg = raw && typeof raw === 'object' ? raw : {};
    return {
      enableBing: cfg.enableBing !== false,
      enableBaike: cfg.enableBaike !== false,
      enableCnmeme: cfg.enableCnmeme !== false,
      enableBilibiliDetail: cfg.enableBilibiliDetail !== false,
      enableWikipedia: cfg.enableWikipedia !== false,
      priorityDomains: Array.isArray(cfg.priorityDomains)
        ? cfg.priorityDomains.filter((d) => typeof d === 'string' && d.trim())
        : ['bilibili.com', 'cnmeme.wiki', 'baike.baidu.com', 'zhihu.com', 'moegirl.org.cn', 'wiki.biligame.com'],
      customSources: Array.isArray(cfg.customSources)
        ? cfg.customSources.filter((s) => s && typeof s === 'object' && s.urlTemplate)
        : [],
    };
  };

  const safeExternalUrl = (raw) => {
    const u = String(raw || '').trim();
    return /^https?:\/\//i.test(u) ? u : '';
  };

  const renderLore = () => {
    host.replaceChildren();
    const card = mk('section', 'lm-lore-card');
    const lookupCfg = normalizeLookupConfig(loreState?.lookupConfig);

    const head = mk('div', 'lm-lore-head');
    const titleBox = mk('div', '');
    titleBox.append(
      mk('strong', 'lm-bar-title', `✦ 共同梗词典 & 多源查梗（${loreState?.totalCount || 0} 条）`),
      mk('span', 'lm-bar-sub', '内置 B站 BV 详情/标签直读、梗Wiki、百度百科、Bing 与维基百科，并可自由添加自定义搜索地址')
    );
    head.append(titleBox);
    card.append(head);

    // Switches bar
    const swRow = mk('div', 'lm-lore-switches');
    const makeSwitch = (labelText, checked, onChange) => {
      const lbl = mk('label', 'lm-lore-switch');
      const inp = mk('input', '');
      inp.type = 'checkbox';
      inp.checked = Boolean(checked);
      inp.onchange = () => onChange(inp.checked, inp);
      lbl.append(inp, mk('span', '', labelText));
      return lbl;
    };
    const loreStatus = mk('p', 'lm-status-note');
    loreStatus.hidden = true;
    const setStatus = (msg) => {
      loreStatus.hidden = !msg;
      loreStatus.textContent = msg || '';
    };

    const saveLookupConfig = async (nextCfg, okMsg) => {
      loreState = await api('/api/dimension/lorebook', {
        method: 'POST',
        body: JSON.stringify({ action: 'save-lookup-config', config: nextCfg }),
      });
      renderLore();
      if (okMsg && typeof window.__dimensionToast === 'function') {
        window.__dimensionToast(okMsg);
      }
    };

    swRow.append(
      makeSwitch('免配置联网查新梗 / 实时信息', loreState?.chatAutoWebLookup !== false, async (val, inp) => {
        inp.disabled = true;
        try {
          loreState = await api('/api/dimension/lorebook', {
            method: 'POST',
            body: JSON.stringify({ action: 'settings', chatAutoWebLookup: val }),
          });
          setStatus(val ? '✦ 已开启聊天免配置自动查新梗与实时核实' : '✦ 已暂停聊天自动联网核实（仍使用本地梗词典）');
        } catch (err) {
          inp.checked = !val;
          notifyError(`保存开关失败：${err?.message || '请稍后重试'}`, host);
        } finally {
          inp.disabled = false;
        }
      }),
      makeSwitch('科普新梗自动学会入库', loreState?.loreAutoLearn !== false, async (val, inp) => {
        inp.disabled = true;
        try {
          loreState = await api('/api/dimension/lorebook', {
            method: 'POST',
            body: JSON.stringify({ action: 'settings', loreAutoLearn: val }),
          });
          setStatus(val ? '✦ 已开启科普自动学习（教一次全员记住）' : '✦ 已暂停自动学习，仅保留手动/导入管理');
        } catch (err) {
          inp.checked = !val;
          notifyError(`保存开关失败：${err?.message || '请稍后重试'}`, host);
        } finally {
          inp.disabled = false;
        }
      })
    );

    const enabledBuiltinCount = [
      lookupCfg.enableBing,
      lookupCfg.enableBaike,
      lookupCfg.enableCnmeme,
      lookupCfg.enableBilibiliDetail,
      lookupCfg.enableWikipedia,
    ].filter(Boolean).length;
    const enabledCustomCount = lookupCfg.customSources.filter((s) => s.enabled !== false).length;
    const srcToggleBtn = mk(
      'button',
      'text-btn lm-lore-src-toggle',
      `${sourcesPanelOpen ? '▾' : '▸'} 搜索源与自定义地址（内置 ${enabledBuiltinCount}/5 · 自定义 ${enabledCustomCount}）`
    );
    srcToggleBtn.type = 'button';
    srcToggleBtn.onclick = () => {
      sourcesPanelOpen = !sourcesPanelOpen;
      renderLore();
    };
    swRow.append(srcToggleBtn);
    card.append(swRow);

    // Search Sources & Custom URL Configuration Drawer
    if (sourcesPanelOpen) {
      const srcBox = mk('div', 'lm-lore-sources-box');
      srcBox.append(mk('div', 'lm-lore-sources-title', '内置免费查梗源（零 API Key，并发短超时）'));

      const builtinRow = mk('div', 'lm-lore-builtin-grid');
      const draftCfg = {
        ...lookupCfg,
        priorityDomains: [...lookupCfg.priorityDomains],
        customSources: lookupCfg.customSources.map((s) => ({ ...s })),
      };
      const builtinDefs = [
        ['enableBilibiliDetail', 'B站 BV 详情与标签直读'],
        ['enableCnmeme', '梗Wiki (cnmeme.wiki)'],
        ['enableBaike', '百度百科公开词条'],
        ['enableBing', 'Bing CN（核心词提纯）'],
        ['enableWikipedia', '中/英文维基百科'],
      ];
      for (const [key, label] of builtinDefs) {
        builtinRow.append(makeSwitch(label, draftCfg[key], (val) => {
          draftCfg[key] = val;
        }));
      }

      const domWrap = mk('div', 'lm-lore-dom-row');
      const domInp = mk('input', 'lm-input');
      domInp.type = 'text';
      domInp.value = draftCfg.priorityDomains.join(', ');
      domInp.placeholder = '优先出处域名（逗号分隔，如：bilibili.com, cnmeme.wiki, baike.baidu.com, zhihu.com, moegirl.org.cn）';
      const saveSrcBtn = mk('button', 'deliverable-btn', '保存源与优先站点');
      saveSrcBtn.type = 'button';
      saveSrcBtn.onclick = async () => {
        const doms = domInp.value
          .split(/[,，;\s]+/)
          .map((x) => x.trim())
          .filter(Boolean);
        draftCfg.priorityDomains = doms;
        saveSrcBtn.disabled = true;
        try {
          await saveLookupConfig(draftCfg, '✦ 搜索源与优先出处站点已保存并生效');
        } catch (err) {
          notifyError(`保存搜索源失败：${err?.message || '请检查配置'}`, host);
        } finally {
          saveSrcBtn.disabled = false;
        }
      };
      domWrap.append(domInp, saveSrcBtn);
      srcBox.append(builtinRow, domWrap);

      // Custom Search URL Templates
      srcBox.append(mk('div', 'lm-lore-sources-title', '自定义搜索地址（需 http(s):// 且包含 {query}，自动识别 RSS / JSON / 网页摘要）'));
      const customList = mk('div', 'lm-lore-custom-list');
      if (!lookupCfg.customSources.length) {
        customList.append(mk('p', 'lm-lore-custom-empty', '尚未添加自定义搜索地址。可添加二次元/游戏 Wiki 词条页、公开 RSS 搜索源或自建 SearXNG 地址。'));
      } else {
        for (const s of lookupCfg.customSources) {
          const item = mk('div', `lm-lore-custom-item${s.enabled === false ? ' is-disabled' : ''}`);
          const meta = mk('div', 'lm-lore-custom-meta');
          meta.append(
            mk('strong', '', s.name || '自定义源'),
            mk('span', 'lm-lore-badge', (s.format || 'auto').toUpperCase()),
            mk('code', 'lm-lore-custom-url', s.urlTemplate)
          );
          const acts = mk('div', 'lm-lore-item-ctrls');
          const togBtn = mk('button', 'text-btn', s.enabled === false ? '启用' : '停用');
          togBtn.type = 'button';
          togBtn.onclick = async () => {
            const next = {
              ...lookupCfg,
              customSources: lookupCfg.customSources.map((x) => (x.id === s.id ? { ...x, enabled: x.enabled === false } : x)),
            };
            try {
              await saveLookupConfig(next, `✦ 已${s.enabled === false ? '启用' : '停用'}搜索源「${s.name}」`);
            } catch (err) {
              notifyError(`更新失败：${err?.message || '请稍后重试'}`, host);
            }
          };
          const delBtn = mk('button', 'text-btn is-danger', '删除');
          delBtn.type = 'button';
          delBtn.onclick = async () => {
            const next = {
              ...lookupCfg,
              customSources: lookupCfg.customSources.filter((x) => x.id !== s.id),
            };
            try {
              await saveLookupConfig(next, `✦ 已移除自定义搜索源「${s.name}」`);
            } catch (err) {
              notifyError(`删除失败：${err?.message || '请稍后重试'}`, host);
            }
          };
          acts.append(togBtn, delBtn);
          item.append(meta, acts);
          customList.append(item);
        }
      }

      const addCustomRow = mk('div', 'lm-lore-custom-add');
      const csName = mk('input', 'lm-input');
      csName.placeholder = '来源名称（如：B站Wiki / 自建SearXNG）';
      const csUrl = mk('input', 'lm-input');
      csUrl.placeholder = '搜索地址模板，含 {query}（如：https://cnmeme.wiki/entry/{query}）';
      const csFmt = mk('select', 'lm-input lm-lore-select');
      for (const [val, txt] of [['auto', '自动识别'], ['rss', 'RSS / Atom'], ['json', 'JSON 接口'], ['html', '网页摘要']]) {
        const op = mk('option', '', txt);
        op.value = val;
        csFmt.append(op);
      }
      const csAddBtn = mk('button', 'deliverable-btn is-primary', '＋ 添加地址');
      csAddBtn.type = 'button';
      csAddBtn.onclick = async () => {
        const name = csName.value.trim();
        const urlTemplate = csUrl.value.trim();
        if (!/^https?:\/\//i.test(urlTemplate) || !urlTemplate.includes('{query}')) {
          setStatus('自定义搜索地址必须以 http:// 或 https:// 开头，且包含 {query} 占位符');
          return;
        }
        csAddBtn.disabled = true;
        try {
          const next = {
            ...lookupCfg,
            customSources: [
              ...lookupCfg.customSources,
              { name: name || '自定义源', urlTemplate, format: csFmt.value, enabled: true },
            ],
          };
          await saveLookupConfig(next, `✦ 已添加搜索源「${name || '自定义源'}」`);
        } catch (err) {
          notifyError(`添加搜索地址失败：${err?.message || '请检查地址格式'}`, host);
        } finally {
          csAddBtn.disabled = false;
        }
      };
      addCustomRow.append(csName, csUrl, csFmt, csAddBtn);
      srcBox.append(customList, addCustomRow);
      card.append(srcBox);
    }

    // Live lookup quick tester (with source badges, clickable origin URLs, and 1-click capture to lorebook)
    const testRow = mk('div', 'lm-lore-test-row');
    const testInput = mk('input', 'lm-input lm-lore-test-input');
    testInput.type = 'text';
    testInput.placeholder = '试搜热梗或贴 B站 BV号/链接（如：曼波 / 广智救我 / BV1mA4m1c7od）';
    const testBtn = mk('button', 'deliverable-btn', '联网试搜');
    testBtn.type = 'button';
    const testResultBox = mk('div', 'lm-lore-test-results');
    testResultBox.hidden = true;

    // Quick Add Form refs declared early so 1-click capture from search results can prefill them
    const titleInp = mk('input', 'lm-input');
    titleInp.placeholder = '梗名 / 词条名（如：曼波）';
    const trigInp = mk('input', 'lm-input');
    trigInp.placeholder = '触发词/别名（逗号分隔，如：曼波, mambo, 诗歌剧）';
    const meanInp = mk('textarea', 'lm-textarea lm-lore-meaning');
    meanInp.rows = 2;
    meanInp.placeholder = '一句话大白话释义与玩梗用法（命中触发词时自动注入，让角色自然接梗）';

    const paintLookupResult = (res) => {
      testResultBox.replaceChildren();
      if (!res) {
        testResultBox.hidden = true;
        return;
      }
      testResultBox.hidden = false;
      const items = Array.isArray(res.items) ? res.items : [];
      if (!items.length) {
        testResultBox.append(mk('div', 'lm-lore-test-empty', `${res.fromCache ? '[缓存] ' : ''}${res.summary || res.error || '未查到公开结果'}`));
        return;
      }
      const bar = mk('div', 'lm-lore-test-meta', `${res.fromCache ? '⚡ 缓存秒返 · ' : ''}命中 ${items.length} 条出处参考（点击链接可查看原址，或一键带入下方词典）`);
      testResultBox.append(bar);
      for (const it of items) {
        const hit = mk('div', 'lm-lore-hit-card');
        const htop = mk('div', 'lm-lore-hit-top');
        const badgeCls = it.source === 'bilibili' || it.sourceLabel === 'B站' ? 'is-bili'
          : (it.source === 'cnmeme' || it.sourceLabel === '梗Wiki' ? 'is-meme' : '');
        const left = mk('div', 'lm-lore-item-title-wrap');
        left.append(
          mk('span', `lm-lore-badge ${badgeCls}`.trim(), it.sourceLabel || it.source || '网络'),
          mk('strong', 'lm-lore-hit-title', it.title || res.query || '未命名结果')
        );
        const right = mk('div', 'lm-lore-item-ctrls');
        const safeUrl = safeExternalUrl(it.url);
        if (safeUrl) {
          const link = mk('a', 'text-btn lm-lore-hit-link', '打开出处 ↗');
          link.href = safeUrl;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          right.append(link);
        }
        const pickBtn = mk('button', 'text-btn', '填入词典');
        pickBtn.type = 'button';
        pickBtn.onclick = () => {
          const qCore = (res.query || it.title || '').trim();
          titleInp.value = qCore.slice(0, 40);
          if (!trigInp.value.trim()) trigInp.value = qCore;
          const tail = safeUrl ? `（出处：${it.sourceLabel || '网络'} ${safeUrl}）` : '';
          meanInp.value = `${it.snippet || it.title || ''}${tail}`.trim();
          meanInp.focus();
          setStatus(`✦ 已将「${it.sourceLabel || '网络'}」查到的出处释义填入下方，微调后点击「存入梗词典」即可全员生效`);
        };
        right.append(pickBtn);
        htop.append(left, right);
        hit.append(htop);
        if (it.snippet) hit.append(mk('div', 'lm-lore-hit-snippet', it.snippet));
        if (safeUrl) hit.append(mk('div', 'lm-lore-hit-url', safeUrl));
        testResultBox.append(hit);
      }
    };

    const runLiveLookup = async () => {
      const q = testInput.value.trim();
      if (q.length < 2) { setStatus('请至少输入 2 个字符的测试关键词或 B站 BV 号'); return; }
      testBtn.disabled = true;
      testBtn.textContent = '查证中…';
      testResultBox.hidden = false;
      testResultBox.replaceChildren(mk('div', 'lm-lore-test-empty', `✦ 正在并发查询已启用的多源梗库与百科「${q}」…`));
      try {
        const res = await api('/api/dimension/lorebook', {
          method: 'POST',
          body: JSON.stringify({ action: 'test-lookup', query: q }),
        });
        lastLookupRes = res;
        paintLookupResult(res);
      } catch (err) {
        testResultBox.replaceChildren(mk('div', 'lm-lore-test-empty', `查询失败：${err?.message || '网络不可达'}`));
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = '联网试搜';
      }
    };
    testBtn.onclick = runLiveLookup;
    testInput.onkeydown = (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        runLiveLookup();
      }
    };
    testRow.append(testInput, testBtn);
    if (lastLookupRes) paintLookupResult(lastLookupRes);
    card.append(testRow, testResultBox);

    // Quick Add Form
    const form = mk('div', 'lm-lore-form');
    const scopeSel = mk('select', 'lm-input lm-lore-select');
    const optGlobal = mk('option', '', '全员共享');
    optGlobal.value = 'global';
    const optBot = mk('option', '', '仅当前伙伴');
    optBot.value = `bot:${botId}`;
    scopeSel.append(optGlobal, optBot);
    if (groupId) {
      const optGrp = mk('option', '', '仅当前群聊');
      optGrp.value = `group:${groupId}`;
      scopeSel.append(optGrp);
    }

    const formRow1 = mk('div', 'lm-lore-form-row');
    formRow1.append(titleInp, trigInp, scopeSel);
    const formActions = mk('div', 'lm-lore-actions');
    const addBtn = mk('button', 'deliverable-btn is-primary', '＋ 存入梗词典');
    addBtn.type = 'button';
    addBtn.onclick = async () => {
      const title = titleInp.value.trim();
      const meaning = meanInp.value.trim();
      if (!title || !meaning) { setStatus('请填写词条名称和释义'); return; }
      addBtn.disabled = true;
      try {
        loreState = await api('/api/dimension/lorebook', {
          method: 'POST',
          body: JSON.stringify({
            action: 'upsert',
            title,
            triggersText: trigInp.value.trim(),
            meaning,
            scope: scopeSel.value,
          }),
        });
        setStatus(`✦ 已存入梗词条「${title}」，聊到相关关键词时自动触发`);
        renderLore();
      } catch (err) {
        notifyError(`保存词条失败：${err?.message || '请稍后重试'}`, host);
      } finally {
        addBtn.disabled = false;
      }
    };

    const importBtn = mk('button', 'text-btn', '导入梗包 JSON');
    importBtn.type = 'button';
    const fileInp = mk('input', '');
    fileInp.type = 'file';
    fileInp.accept = '.json,application/json';
    fileInp.hidden = true;
    importBtn.onclick = () => fileInp.click();
    fileInp.onchange = async () => {
      const file = fileInp.files?.[0];
      fileInp.value = '';
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const res = await api('/api/dimension/lorebook', {
          method: 'POST',
          body: JSON.stringify({ action: 'import', payload: parsed }),
        });
        loreState = res;
        renderLore();
        if (typeof window.__dimensionToast === 'function') {
          window.__dimensionToast(`✦ 已导入梗包：新增 ${res.added || 0} 条，更新 ${res.updated || 0} 条`);
        }
      } catch (err) {
        notifyError(`导入梗包失败：${err?.message || 'JSON 格式不正确'}`, host);
      }
    };

    const exportBtn = mk('button', 'text-btn', '导出备份');
    exportBtn.type = 'button';
    exportBtn.onclick = async () => {
      try {
        const data = await api('/api/dimension/lorebook', {
          method: 'POST',
          body: JSON.stringify({ action: 'export' }),
        });
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'dimension-lorebook.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (err) {
        notifyError(`导出失败：${err?.message || '请稍后重试'}`, host);
      }
    };

    formActions.append(addBtn, importBtn, exportBtn, fileInp);
    form.append(formRow1, meanInp, formActions, loreStatus);
    card.append(form);

    // Entries list
    const entries = loreState?.entries || [];
    const listWrap = mk('div', 'lm-lore-list');
    if (!entries.length) {
      listWrap.append(mk('p', 'lm-lore-empty', '词典暂时还是空的。你可以手动记几条你们的专属梗，或在聊天里直接给她们科普一次，她们就会自动学会并存到这里。'));
    } else {
      for (const e of entries) {
        const row = mk('div', `lm-lore-item${e.enabled ? '' : ' is-disabled'}`);
        const top = mk('div', 'lm-lore-item-top');
        const left = mk('div', 'lm-lore-item-title-wrap');
        left.append(
          mk('strong', 'lm-lore-item-title', e.title),
          mk('span', 'lm-lore-badge', scopeBadgeText(e.scope)),
          mk('span', `lm-lore-badge is-${e.source || 'manual'}`, sourceBadgeText(e.source))
        );
        if (e.hitCount > 0) {
          left.append(mk('span', 'lm-lore-hits', `触发 ${e.hitCount} 次`));
        }
        const ctrls = mk('div', 'lm-lore-item-ctrls');
        const tog = mk('button', 'text-btn', e.enabled ? '停用' : '启用');
        tog.type = 'button';
        tog.onclick = async () => {
          try {
            loreState = await api('/api/dimension/lorebook', {
              method: 'POST',
              body: JSON.stringify({ action: 'toggle', id: e.id, enabled: !e.enabled }),
            });
            renderLore();
          } catch (err) {
            notifyError(`切换词条状态失败：${err?.message || '请稍后重试'}`, host);
          }
        };
        const del = mk('button', 'text-btn is-danger', '删除');
        del.type = 'button';
        del.onclick = async () => {
          try {
            loreState = await api('/api/dimension/lorebook', {
              method: 'POST',
              body: JSON.stringify({ action: 'delete', id: e.id }),
            });
            renderLore();
          } catch (err) {
            notifyError(`删除词条失败：${err?.message || '请稍后重试'}`, host);
          }
        };
        ctrls.append(tog, del);
        top.append(left, ctrls);

        const trigs = Array.isArray(e.triggers) && e.triggers.length ? `触发词：${e.triggers.join(' / ')}` : '';
        row.append(
          top,
          mk('div', 'lm-lore-item-meaning', e.meaning),
          ...(trigs ? [mk('div', 'lm-lore-item-trigs', trigs)] : [])
        );
        listWrap.append(row);
      }
    }
    card.append(listWrap);
    host.append(card);
  };

  renderLore();
}

export async function mountCoreMindOverview({ api, host, botId }) {
  if (!host || !botId) return;
  let state = null;
  try {
    state = await api(`/api/dimension/living-memory?botId=${encodeURIComponent(botId)}`);
  } catch (err) {
    if (host.isConnected) host.replaceChildren(mk('p', 'lm-status-note', `✦ 心智回廊暂时没能展开：${err?.message || '读取失败'}。`));
    notifyError(`心智回廊读取失败：${err?.message || '请稍后重试'}`);
    return;
  }
  if (!host.isConnected) return;

  const paint = () => {
    host.replaceChildren();
    const mind = state?.coreMind || {};
    const box = mk('section', 'lm-core-mind-banner');
    const head = mk('div', 'lm-core-mind-head');
    const titleWrap = mk('div', '');
    titleWrap.append(
      mk('strong', 'lm-bar-title', '✦ 四大心智回廊（13 枚微思绪凝练视图）'),
      mk('span', 'lm-bar-sub', mind.relativeTime ? `上次入梦凝练：${mind.relativeTime}` : '统摄潜台词感知、星屑代谢、羁绊演化与幕后自省')
    );
    const refreshLabel = `凝练并刷新心智环${MODEL_HINT}`;
    const refreshBtn = mk('button', 'text-btn', refreshLabel);
    refreshBtn.type = 'button';
    refreshBtn.title = '整理近期记忆并重新凝练四大心智回廊（会调用模型，可能消耗额度）';
    refreshBtn.onclick = async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = '正在凝练…';
      try {
        const res = await api('/api/dimension/living-memory', {
          method: 'POST',
          body: JSON.stringify({ action: 'consolidate', botId, groupId: '', useModel: true }),
        });
        if (res?.state) state = res.state;
        paint();
      } catch (err) {
        notifyError(`心智环凝练失败：${err?.message || '请稍后重试'}`, host);
      }
      finally {
        refreshBtn.disabled = false;
        refreshBtn.textContent = refreshLabel;
      }
    };
    head.append(titleWrap, refreshBtn);

    const grid = mk('div', 'lm-mind-grid');
    const cards = [
      ['Ⅰ · 当下感知与言外之意', mind.perception || '点击右上「凝练并刷新心智环」，捕捉当前交流的温度与潜台词。'],
      ['Ⅱ · 记忆星屑提炼与归并', mind.memoryDigest || '自动分流长久铭刻与近期时效动态，并在梦境中抚平前后矛盾。'],
      ['Ⅲ · 羁绊与同席印象演化', mind.relationShift || 'L0 羁绊底牌常驻相伴，公开习性与私密心事分层守护。'],
      ['Ⅳ · 幕后复盘与自省', mind.reflection || '保持鲜活口吻与自然时间远近感，拒绝生硬背诵历史档案。'],
    ];
    for (const [label, body] of cards) {
      const c = mk('div', 'lm-mind-card');
      c.append(mk('strong', '', label), mk('p', '', body));
      grid.append(c);
    }
    box.append(head, grid);
    host.append(box);
  };

  paint();
}
