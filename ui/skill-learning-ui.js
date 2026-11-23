const node = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};

const styles = `
.skill-learning-dialog{width:min(940px,calc(100vw - 32px));height:min(780px,calc(100dvh - 32px));padding:0;border:1px solid var(--color-composer-ring);border-radius:16px;background:var(--color-raised);color:var(--color-ink);overflow:hidden}.skill-learning-dialog::backdrop{background:rgb(18 16 14 / .35)}
.skill-learning-shell{display:grid;grid-template-rows:auto auto minmax(0,1fr);height:100%}
.skill-learning-head{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--color-composer-ring)}.skill-learning-head h2{margin:0;font-size:18px}
.sl-tabs{display:flex;gap:8px;padding:10px 20px;border-bottom:1px solid var(--color-composer-ring);background:var(--color-app)}
.sl-tabs button[aria-pressed=true]{background:var(--color-accent);color:var(--color-accent-ink);border-color:transparent}
.skill-learning-body{overflow:auto;padding:14px 20px 22px}
.sl-retro-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 12px;margin-bottom:12px;border:1px solid var(--color-composer-ring);border-radius:11px;background:var(--color-app)}
.sl-retro-bar select{flex:1;min-width:220px;height:34px;padding:0 9px;border:1px solid var(--color-composer-ring);border-radius:8px;background:var(--color-raised);color:inherit;font:inherit}
.skill-learning-create{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:12px;margin-bottom:14px;border:1px solid var(--color-composer-ring);border-radius:12px;background:var(--color-app)}
.skill-learning-create input,.skill-learning-create textarea,.skill-learning-create select{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid var(--color-composer-ring);border-radius:9px;background:var(--color-raised);color:inherit;font:inherit}
.skill-learning-create .wide{grid-column:1/-1}
.skill-learning-create[hidden]{display:none}
.skill-learning-create-actions{display:flex;gap:8px}.skill-learning-create-actions button[type=submit]{flex:1}
.sl-pane-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}.sl-pane-bar span{font-size:12px;color:var(--color-ink-tertiary)}
.skill-learning-dialog .sl-new-btn{flex:none;border-color:transparent;background:var(--color-accent);color:var(--color-accent-ink);font-weight:600}.skill-learning-dialog .sl-new-btn[aria-expanded=true]{background:var(--color-control);color:var(--color-ink)}
.skill-learning-dialog button:focus-visible{outline:2px solid var(--color-focus);outline-offset:2px}
.skill-learning-badge[data-validation=verified]{color:var(--color-success)}.skill-learning-badge[data-validation=failed]{color:var(--color-danger)}
.skill-learning-create button[type=submit]{min-height:34px;border:0;border-radius:9px;background:var(--color-accent);color:var(--color-accent-ink);font:inherit;cursor:pointer}
.skill-learning-status{font-size:12px;color:var(--color-ink-secondary);margin:4px 0 8px}.skill-learning-note{font-size:11px;color:var(--color-ink-tertiary);margin:0 0 12px}
.skill-learning-topic{margin:10px 0;padding:12px;border:1px solid var(--color-composer-ring);border-radius:12px;background:var(--color-app)}
.skill-learning-topic h3{margin:0 0 8px;font-size:14px}.skill-learning-version{display:grid;gap:5px;margin-top:8px;padding:10px;border:1px solid var(--color-composer-ring);border-radius:10px;background:var(--color-raised)}
.skill-learning-meta{font-size:11px;color:var(--color-ink-secondary);overflow-wrap:anywhere}.skill-learning-badge{padding:1px 6px;border-radius:6px;background:var(--color-control)}
.skill-learning-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}.skill-learning-dialog button{min-height:30px;padding:0 10px;border:1px solid var(--color-composer-ring);border-radius:8px;background:var(--color-raised);color:inherit;font:inherit;cursor:pointer}
.skill-learning-body pre{max-height:140px;overflow:auto;margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;color:var(--color-ink-secondary)}
@media(max-width:640px){.skill-learning-create{grid-template-columns:1fr}.skill-learning-create .wide{grid-column:auto}.skill-learning-head,.sl-tabs,.skill-learning-body{padding-left:14px;padding-right:14px}}
`;

export function bindSkillLearning({ api }) {
  const validationLabels = { untested: '待验证', verified: '验证通过', failed: '验证未通过' };
  const runStatusLabels = { completed: '已完成', partial: '部分交付', failed: '执行失败' };
  const relativeTime = value => {
    const time = new Date(value).getTime(); if (!Number.isFinite(time)) return '';
    const diff = Date.now() - time;
    if (diff < 0) return new Date(time).toLocaleDateString();
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)} 天前`;
    return new Date(time).toLocaleDateString();
  };
  if (document.getElementById('skillLearningDialog')) return;
  const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
  const dialog = node('dialog', 'skill-learning-dialog'); dialog.id = 'skillLearningDialog'; dialog.setAttribute('aria-label', '经验与项目进化');
  dialog.innerHTML = `<div class="skill-learning-shell">
    <header class="skill-learning-head"><h2>经验候选与项目进化</h2><button type="button" data-close>关闭</button></header>
    <nav class="sl-tabs" aria-label="进化分类">
      <button type="button" data-sl-tab="skills" aria-pressed="true">经验候选与任务复盘</button>
      <button type="button" data-sl-tab="knowledge" aria-pressed="false">项目知识库</button>
      <button type="button" data-sl-tab="checklist" aria-pressed="false">错误案例防坑单</button>
    </nav>
    <div class="skill-learning-body">
      <p class="skill-learning-status" role="status">候选默认对模型不可见；验证启用后才参与后续任务，且绝不自动扩大权限。</p>
      <section data-sl-pane="skills">
        <div class="sl-retro-bar">
          <strong>从真实任务一键复盘：</strong>
          <select id="slRetroRunSelect"><option value="">选择近期已结束的 Work 任务…</option></select>
          <button type="button" id="slRetroExtractBtn">提炼复盘候选</button>
        </div>
        <div class="sl-pane-bar"><span>也可以手动记下一条经验候选（默认不启用）。</span><button type="button" class="sl-new-btn" data-sl-toggle="slSkillForm" aria-expanded="false" aria-controls="slSkillForm">＋ 新建候选</button></div>
        <form class="skill-learning-create" id="slSkillForm" hidden>
          <input name="topic" required maxlength="100" placeholder="经验编号（英文短名），例如 summarize-project">
          <input name="title" required maxlength="200" placeholder="候选名称">
          <input name="keywords" required placeholder="关键词，用逗号分隔">
          <input name="origin" required maxlength="4000" placeholder="经验来源：哪个任务、反馈或案例">
          <textarea name="body" class="wide" required maxlength="60000" rows="3" placeholder="可复用步骤、适用条件和验证方法"></textarea>
          <div class="skill-learning-create-actions wide"><button type="submit">手动创建候选（不启用）</button><button type="button" data-sl-cancel>取消</button></div>
        </form>
        <p class="skill-learning-note">复盘提炼依据真实任务终态、实证产物与中途补充；失败/部分交付任务会同步沉淀到「错误案例防坑单」。启用或回退只同步正文到共享 Skill，不修改人设或权限。</p>
        <div id="slSkillList"></div>
      </section>

      <section data-sl-pane="knowledge" hidden>
        <div class="sl-pane-bar"><span>登记目录约定、术语、已定决策与验收标准。</span><button type="button" class="sl-new-btn" data-sl-toggle="slKnowledgeForm" aria-expanded="false" aria-controls="slKnowledgeForm">＋ 新建知识</button></div>
        <form class="skill-learning-create" id="slKnowledgeForm" hidden>
          <input name="title" required maxlength="200" placeholder="知识标题，例如：前端构建相对路径约定">
          <select name="category"><option value="目录约定">目录约定</option><option value="项目术语">项目术语</option><option value="已定决策">已定决策</option><option value="验收标准">验收标准</option></select>
          <input name="projectCwd" maxlength="1024" placeholder="适用项目绝对路径（留空代表全局通用）">
          <input name="days" type="number" min="0" max="365" value="0" placeholder="有效天数（0表示长期有效）">
          <input name="origin" class="wide" maxlength="500" placeholder="来源说明：例如哪次讨论或文档拍板">
          <textarea name="body" class="wide" required maxlength="8000" rows="3" placeholder="具体约定内容（启用且未过期时自动作为参考背景注入对应 Work 任务）"></textarea>
          <div class="skill-learning-create-actions wide"><button type="submit">保存项目知识</button><button type="button" data-sl-cancel>取消</button></div>
        </form>
        <div id="slKnowledgeList"></div>
      </section>

      <section data-sl-pane="checklist" hidden>
        <div class="sl-pane-bar"><span>把踩过的坑记成交付前核对项。</span><button type="button" class="sl-new-btn" data-sl-toggle="slChecklistForm" aria-expanded="false" aria-controls="slChecklistForm">＋ 新建检查项</button></div>
        <form class="skill-learning-create" id="slChecklistForm" hidden>
          <input name="title" required maxlength="200" placeholder="坑点简称，例如：Ninja 未传 Release 导致 Debug 包">
          <input name="projectCwd" maxlength="1024" placeholder="适用项目绝对路径（留空代表全局通用）">
          <textarea name="symptom" class="wide" required maxlength="2000" rows="2" placeholder="错误现象或踩坑原因"></textarea>
          <textarea name="prevention" class="wide" required maxlength="2000" rows="2" placeholder="交付前必查核对项（启用后自动附加到对应项目 Work 提示词）"></textarea>
          <div class="skill-learning-create-actions wide"><button type="submit">添加防坑检查项</button><button type="button" data-sl-cancel>取消</button></div>
        </form>
        <div id="slChecklistList"></div>
      </section>
    </div>
  </div>`;
  document.body.append(dialog);

  const status = dialog.querySelector('.skill-learning-status');
  const skillList = dialog.querySelector('#slSkillList');
  const knList = dialog.querySelector('#slKnowledgeList');
  const clList = dialog.querySelector('#slChecklistList');
  const retroSelect = dialog.querySelector('#slRetroRunSelect');
  let state = { library: {}, projectKnowledge: [], errorChecklist: [], recentRuns: [] }, version = 0, activeTab = 'skills';

  const switchTab = next => {
    activeTab = next;
    for (const btn of dialog.querySelectorAll('[data-sl-tab]')) btn.setAttribute('aria-pressed', String(btn.dataset.slTab === next));
    for (const pane of dialog.querySelectorAll('[data-sl-pane]')) pane.hidden = pane.dataset.slPane !== next;
  };
  for (const btn of dialog.querySelectorAll('[data-sl-tab]')) btn.onclick = () => switchTab(btn.dataset.slTab);

  // 「＋ 新建」按钮：点击后展开对应表单，提交成功或取消后收起。
  const setFormOpen = (form, openIt) => {
    form.hidden = !openIt;
    const toggle = dialog.querySelector(`[data-sl-toggle="${form.id}"]`);
    if (toggle) toggle.setAttribute('aria-expanded', String(openIt));
    if (openIt) form.querySelector('input,textarea,select')?.focus();
  };
  for (const toggle of dialog.querySelectorAll('[data-sl-toggle]')) {
    const form = dialog.querySelector(`#${toggle.dataset.slToggle}`);
    toggle.onclick = () => setFormOpen(form, form.hidden);
  }
  for (const cancel of dialog.querySelectorAll('[data-sl-cancel]')) {
    cancel.onclick = () => { const form = cancel.closest('form'); form.reset(); setFormOpen(form, false); };
  }

  const apply = data => {
    state = {
      library: data.library || {},
      projectKnowledge: Array.isArray(data.projectKnowledge) ? data.projectKnowledge : [],
      errorChecklist: Array.isArray(data.errorChecklist) ? data.errorChecklist : [],
      recentRuns: Array.isArray(data.recentRuns) ? data.recentRuns : [],
    };
    paint();
  };

  const request = async (body, okMsg = '已更新进化库。') => {
    status.textContent = '正在提交…';
    try {
      const data = await api('/api/dimension/skill-library', { method: 'POST', body: JSON.stringify(body) });
      apply(data);
      status.textContent = okMsg;
      return true;
    } catch (error) {
      status.textContent = error.message || '操作失败。';
      return false;
    }
  };

  const paint = () => {
    retroSelect.replaceChildren(new Option('选择近期已结束的 Work 任务…', ''));
    for (const r of state.recentRuns) {
      const title = String(r.text || '').replace(/\s+/g, ' ').trim() || '未命名委托';
      const when = relativeTime(r.updatedAt);
      const option = new Option(`【${runStatusLabels[r.status] || '已结束'}】${title}${r.artifactCount ? ` · 产物 ${r.artifactCount} 项` : ''}${when ? ` · ${when}` : ''}`, r.id);
      option.title = String(r.text || '');
      retroSelect.add(option);
    }

    skillList.replaceChildren();
    for (const [topic, entry] of Object.entries(state.library)) {
      const card = node('section', 'skill-learning-topic'), active = Number(entry.activeRevision || 0);
      card.append(node('h3', '', `${entry.versions?.[0]?.title || topic} · ${topic}${active ? ` · 当前 v${active}` : ' · 未启用'}`));
      for (const row of [...(entry.versions || [])].sort((a, b) => b.revision - a.revision)) {
        const item = node('article', 'skill-learning-version'), meta = node('div', 'skill-learning-meta');
        const validation = validationLabels[row.validation] || '状态未知';
        const badge = node('span', 'skill-learning-badge', validation); badge.dataset.validation = row.validation || '';
        meta.append(node('span', 'skill-learning-badge', `v${row.revision}`), document.createTextNode(' '), badge, document.createTextNode(row.revision === active ? ' · 当前生效' : ''));
        item.append(meta, node('div', 'skill-learning-meta', `来源：${row.origin}`));
        if (row.evidence) item.append(node('div', 'skill-learning-meta', `验证证据：${row.evidence}`));
        item.append(node('pre', '', row.body));
        const actions = node('div', 'skill-learning-actions');
        for (const [label, passed] of [['记录验证通过', true], ['记录验证失败', false]]) {
          const button = node('button', '', label); button.type = 'button';
          button.onclick = async () => {
            const evidence = window.__dimensionPrompt
              ? await window.__dimensionPrompt({ title: '填写验证案例、结果与必要说明', placeholder: '输入真实任务表现或验证说明…', confirmLabel: '提交验证' })
              : window.prompt('填写验证案例、结果与必要说明');
            if (evidence?.trim()) void request({ action: 'validate', topic, revision: String(row.revision), passed, evidence: evidence.trim() });
          };
          actions.append(button);
        }
        if (row.validation === 'verified' && row.revision !== active) {
          const button = node('button', '', active ? '回退到此版本' : '启用此版本'); button.type = 'button';
          button.onclick = () => void request({ action: active ? 'rollback' : 'activate', topic, revision: String(row.revision) });
          actions.append(button);
        }
        item.append(actions); card.append(item);
      }
      skillList.append(card);
    }
    if (!Object.keys(state.library).length) skillList.append(node('p', 'skill-learning-status', '还没有经验候选；可从上方选择真实 Work 任务一键提炼复盘。'));

    knList.replaceChildren();
    for (const item of state.projectKnowledge) {
      const card = node('section', 'skill-learning-topic');
      const expText = item.expiresAtMs > 0 ? `到期：${new Date(Number(item.expiresAtMs)).toLocaleDateString()}${item.expired ? '（已过期停用）' : ''}` : '长期有效';
      card.append(
        node('h3', '', `[${item.category || '项目约定'}] ${item.title} · v${item.revision || 1} · ${item.enabled && !item.expired ? '已启用' : '未启用'}`),
        node('div', 'skill-learning-meta', `适用范围：${item.projectCwd || '全局通用'} · ${expText} · 来源：${item.origin || '用户登记'}`),
        node('pre', '', item.body),
      );
      const actions = node('div', 'skill-learning-actions');
      const toggle = node('button', '', item.enabled ? '停用' : '启用'); toggle.type = 'button';
      toggle.onclick = () => void request({ action: 'toggle-knowledge', id: item.id, enabled: !item.enabled });
      const del = node('button', '', '删除'); del.type = 'button';
      del.onclick = async () => {
        const ok = window.__dimensionConfirm
          ? await window.__dimensionConfirm({ title: '删除项目知识', message: `删除项目知识「${item.title}」？`, confirmLabel: '删除', danger: true })
          : window.confirm(`删除项目知识「${item.title}」？`);
        if (ok) void request({ action: 'delete-knowledge', id: item.id });
      };
      actions.append(toggle, del); card.append(actions); knList.append(card);
    }
    if (!state.projectKnowledge.length) knList.append(node('p', 'skill-learning-status', '还没有登记项目知识。添加后会自动注入匹配项目的 Work 背景提示中。'));

    clList.replaceChildren();
    for (const item of state.errorChecklist) {
      const card = node('section', 'skill-learning-topic');
      card.append(
        node('h3', '', `${item.title} · v${item.revision || 1} · ${item.enabled ? '已启用核对' : '待确认未启用'}`),
        node('div', 'skill-learning-meta', `适用范围：${item.projectCwd || '全局通用'}${item.originRunId ? ' · 来源：真实委托复盘' : ''}`),
        node('pre', '', `现象：${item.symptom}\n交付前核对：${item.prevention}`),
      );
      const actions = node('div', 'skill-learning-actions');
      const toggle = node('button', '', item.enabled ? '停用核对' : '启用交付前核对'); toggle.type = 'button';
      toggle.onclick = () => void request({ action: 'toggle-checklist', id: item.id, enabled: !item.enabled });
      const del = node('button', '', '删除'); del.type = 'button';
      del.onclick = async () => {
        const ok = window.__dimensionConfirm
          ? await window.__dimensionConfirm({ title: '删除防坑检查项', message: `删除防坑检查项「${item.title}」？`, confirmLabel: '删除', danger: true })
          : window.confirm(`删除防坑检查项「${item.title}」？`);
        if (ok) void request({ action: 'delete-checklist', id: item.id });
      };
      actions.append(toggle, del); card.append(actions); clList.append(card);
    }
    if (!state.errorChecklist.length) clList.append(node('p', 'skill-learning-status', '还没有历史错误防坑检查项。'));
  };

  const load = async () => {
    const ticket = ++version;
    try {
      const data = await api('/api/dimension/skill-library');
      if (ticket === version) apply(data);
    } catch (error) { status.textContent = error.message || '读取失败'; }
  };

  dialog.querySelector('#slRetroExtractBtn').onclick = () => {
    const runId = retroSelect.value;
    if (!runId) { status.textContent = '请先从下拉框选择一条已结束的 Work 任务。'; return; }
    const run = state.recentRuns.find(item => item.id === runId);
    const label = String(run?.text || '').replace(/\s+/g, ' ').trim().slice(0, 40) || '所选委托';
    void request({ action: 'propose-from-run', runId }, `已从委托「${label}」提炼复盘草稿（如有报错已同步加入错误案例防坑单）。`);
  };

  const skillForm = dialog.querySelector('#slSkillForm');
  skillForm.onsubmit = async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(skillForm));
    if (await request({ action: 'create', ...values, keywords: String(values.keywords).split(/[,，\s]+/).filter(Boolean) })) { skillForm.reset(); setFormOpen(skillForm, false); }
  };

  const knForm = dialog.querySelector('#slKnowledgeForm');
  knForm.onsubmit = async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(knForm));
    if (await request({ action: 'save-knowledge', ...values, days: Number(values.days || 0) }, '已保存项目知识条目。')) { knForm.reset(); setFormOpen(knForm, false); }
  };

  const clForm = dialog.querySelector('#slChecklistForm');
  clForm.onsubmit = async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(clForm));
    if (await request({ action: 'save-checklist', ...values }, '已添加错误防坑检查项。')) { clForm.reset(); setFormOpen(clForm, false); }
  };

  const open = () => { if (!dialog.open) dialog.showModal(); void load(); };
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { version++; });
  document.getElementById('sharedSkillLearningBtn')?.addEventListener('click', open);
}
