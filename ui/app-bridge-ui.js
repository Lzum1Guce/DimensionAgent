const node = (tag, className, text) => { const el = document.createElement(tag); el.className = className; if (text !== undefined) el.textContent = text; return el; };
const labels = { queued: '排队中', preparing: '准备应用', submitting: '提交需求', running: '制作中', 'waiting-login': '等待登录', 'waiting-verification': '等待网站验证', 'waiting-user': '等待交还/继续', 'needs-review': '需要检查', completed: '已取回', failed: '失败', cancelled: '已停止' };

export function bindApplicationBridge({ api, getBots }) {
  const dialog = node('dialog', 'app-bridge-dialog');
  dialog.innerHTML = `<header><h2>应用服务</h2><button type="button" class="ab-close">关闭</button></header><p>配置 Bot 可以使用的应用。日常只需告诉 Bot 你的需求，完成后会直接返回结果。</p><div class="ab-apps"></div><details class="ab-add-app"><summary>添加网页应用</summary><p>使用独立桌面登录，所有 Bot 共用此应用账号。当前支持通过网页生成并下载图片。</p><label>编号 <input class="ab-new-id" placeholder="my-image-app" maxlength="48"></label><label>名称 <input class="ab-new-name" placeholder="应用名称" maxlength="60"></label><label>网址 <input class="ab-new-url" type="url" placeholder="https://" maxlength="4096"></label><label>操作说明 <textarea class="ab-new-instructions" rows="3" placeholder="如何进入制作页和下载原图；不填写账号密码"></textarea></label><button type="button" class="ab-register">保存应用</button></details><h3>最近制作记录</h3><div class="ab-jobs"></div><p class="ab-status" role="status"></p>`;
  document.body.append(dialog);
  const el = selector => dialog.querySelector(selector);
  let timer, generation = 0, loading = false, signature = '', pending = new Set();
  const status = text => { el('.ab-status').textContent = text; };
  const button = (text, fn, key) => {
    const b = node('button', '', text); b.type = 'button'; b.disabled = pending.has(key);
    b.onclick = async () => {
      if (pending.has(key)) return; pending.add(key); b.disabled = true;
      const ticket = generation;
      try { await fn(); if (dialog.open && ticket === generation) { signature = ''; await load(); } }
      catch (e) { if (dialog.open && ticket === generation) status(e.message); }
      finally { pending.delete(key); b.disabled = false; }
    }; return b;
  };
  const render = data => {
    const bots = new Map(getBots().map(b => [b.id, b.name || b.id]));
    el('.ab-apps').replaceChildren(...data.apps.map(app => {
      const card = node('article', 'ab-card');
      card.append(node('strong', '', app.name), node('p', '', '图片生成 · 官方网页版运行于独立 Linux 沙盒 · 所有 Bot 可用'));
      const actions = node('div', 'ab-actions');
      actions.append(button('打开 ' + app.name + ' / 登录', async () => {
        dialog.close(); window.dispatchEvent(new CustomEvent('dimension-open-app-desktop', { detail: { appId: app.id } }));
      }, 'open:' + app.id));
      actions.append(button('检查连接', async () => { const state = await api(`/api/dimension/app-bridge/apps/${encodeURIComponent(app.id)}/status`); status(state.detail); }, 'status:' + app.id));
      actions.append(button(app.enabled ? '停用' : '启用', () => api(`/api/dimension/app-bridge/apps/${encodeURIComponent(app.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !app.enabled }) }), 'enable:' + app.id));
      card.append(actions, node('small', '', app.enabled ? '已启用 · 首次登录后，直接对 Bot 说“帮我生成一张……”即可' : '已停用')); return card;
    }));
    el('.ab-jobs').replaceChildren(...data.jobs.map(job => {
      const card = node('article', 'ab-job'); card.dataset.jobId = job.id;
      card.append(node('strong', '', `${bots.get(job.botId) || job.botId} · ${labels[job.status] || job.status}`));
      card.append(node('p', 'ab-prompt', job.prompt), node('small', '', job.detail || ''));
      const actions = node('div', 'ab-actions');
      for (const blocker of job.waitingFor || []) {
        const owner = bots.get(blocker.botId) || blocker.botId || '上一任务';
        const wait = node('div', 'ab-waiters');
        wait.append(node('small', '', `占用者：${owner} · ${labels[blocker.status] || blocker.status} · ${blocker.ownership === 'operation' ? '操作回调中' : '桌面占用中'}`));
        if (blocker.jobId) wait.append(button('停止占用任务', () => api(`/api/dimension/app-bridge/jobs/${encodeURIComponent(blocker.jobId)}/cancel`, { method: 'POST', body: '{}' }), `cancel-blocker:${job.id}:${blocker.jobId}`));
        card.append(wait);
      }
      if (['waiting-login', 'waiting-verification', 'waiting-user', 'needs-review'].includes(job.status)) actions.append(button('继续检查', () => api(`/api/dimension/app-bridge/jobs/${encodeURIComponent(job.id)}/resume`, { method: 'POST', body: '{}' }), 'resume:' + job.id));
      if (!['completed', 'failed', 'cancelled'].includes(job.status)) actions.append(button('停止任务', () => api(`/api/dimension/app-bridge/jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST', body: '{}' }), 'cancel:' + job.id));
      if (job.status === 'completed') job.files.forEach((file, i) => {
        const link = node('a', 'ab-image'); link.href = `/api/dimension/app-bridge/jobs/${encodeURIComponent(job.id)}/files/${i}`; link.target = '_blank'; link.rel = 'noopener';
        const image = node('img', ''); image.src = link.href; image.alt = `生成图片 ${i + 1}`; image.loading = 'lazy'; link.append(image); actions.append(link);
      }); card.append(actions); return card;
    }));
    if (!data.jobs.length) el('.ab-jobs').append(node('p', '', '还没有应用任务。登录后，直接在 Work 中告诉 Bot 你想制作什么。'));
  };
  async function load() {
    if (loading || !dialog.open) return;
    loading = true; const ticket = generation;
    try { const data = await api('/api/dimension/app-bridge'); if (!dialog.open || ticket !== generation) return; const next = JSON.stringify(data); if (next !== signature) { signature = next; render(data); } }
    catch (e) { if (dialog.open && ticket === generation) status(e.message); }
    finally { loading = false; }
  }
  function open() { if (dialog.open) return; generation++; signature = ''; status(''); dialog.showModal(); void load(); timer = setInterval(() => { void load(); }, 2500); }
  el('.ab-close').onclick = () => dialog.close();
  el('.ab-register').onclick = async () => {
    const button = el('.ab-register');
    if (button.disabled) return;
    button.disabled = true;
    try {
      await api('/api/dimension/app-bridge/apps', { method: 'POST', body: JSON.stringify({
        id: el('.ab-new-id').value.trim(), name: el('.ab-new-name').value.trim(),
        url: el('.ab-new-url').value.trim(), instructions: el('.ab-new-instructions').value.trim(),
      }) });
      status('应用已保存。启用后打开桌面完成首次登录。');
      for (const selector of ['.ab-new-id', '.ab-new-name', '.ab-new-url', '.ab-new-instructions']) el(selector).value = '';
      signature = ''; await load();
    } catch (e) { status(e.message); }
    finally { button.disabled = false; }
  };
  dialog.addEventListener('close', () => { generation++; clearInterval(timer); });
  document.getElementById('sharedApplicationsBtn')?.addEventListener('click', open);
  return { open };
}
