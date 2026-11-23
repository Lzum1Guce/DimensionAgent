export function bindWorkGitHub({ api, getContext }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'work-model-dialog';
  dialog.innerHTML = `<header><h2>GitHub 连接</h2><button data-close>关闭</button></header>
    <p data-env></p><p data-project></p><p data-repo></p><p data-account></p>
    <p data-status role="status"></p><footer><button data-refresh>刷新状态</button>
    <button data-login hidden>通过浏览器登录</button></footer>`;
  document.body.append(dialog);
  const el = name => dialog.querySelector('[data-' + name + ']');
  let version = 0, context;
  const load = async () => {
    const ticket = ++version;
    for (const field of ['env','project','repo','account']) el(field).textContent = '';
    el('login').hidden = true;
    el('refresh').disabled = true;
    el('status').textContent = '正在检查工位…';
    try {
      if (!context.botId) throw new Error('请先选择一个 Work 角色或群聊。');
      const data = await api('/api/dimension/work/github?' + new URLSearchParams(context));
      if (ticket !== version) return;
      el('env').textContent = '执行环境：' + data.environment;
      el('project').textContent = '项目目录：' + (data.project || '尚未绑定');
      const permissions = { READ:'只读', TRIAGE:'分类管理', WRITE:'可写', MAINTAIN:'维护', ADMIN:'管理' };
      el('repo').textContent = 'GitHub 仓库（origin）：' + (data.repository || '未确认') +
        (data.repository ? ' · ' + (permissions[data.permission] || '权限未确认') : '');
      el('account').textContent = '当前账号：' + (data.account || '未确认');
      const windows = data.environment === 'Windows';
      const hints = {
        connected: '已验证 GitHub 账号。对具体仓库的权限以实际操作为准。',
        missing: windows ? '未检测到 GitHub CLI。可在 Windows 终端运行 winget install --id GitHub.cli，完成后刷新。' : '此沙盒未检测到 GitHub CLI。',
        unverified: windows ? '无法验证登录，请检查网络或登录后刷新。' : '沙盒内无法验证账号。',
        awaitingWorkspace: '任务绑定沙盒后，可在该任务中刷新并检查实际环境。',
        sandboxUnavailable: '沙盒执行助手当前不可用。',
        unknown: '本次检查未完成，请稍后刷新。'
      };
      let hint = hints[data.state] || hints.unknown;
      if (!windows) hint += ' 沙盒使用临时 HOME。需要复用 Windows 登录时，请选择 Windows 原生工位。';
      if (data.networkEnabled === false) hint += ' 当前沙盒联网已关闭。';
      if (windows && data.state === 'unverified' && !data.loginAvailable)
        hint += ' 可在本机终端运行 gh auth login --hostname github.com --web。';
      el('status').textContent = hint;
      el('login').hidden = !data.loginAvailable || data.state === 'connected';
    } catch (err) {
      if (ticket === version) el('status').textContent = err.message;
    } finally { if (ticket === version) el('refresh').disabled = false; }
  };
  el('refresh').onclick = load;
  el('close').onclick = () => dialog.close();
  dialog.onclose = () => { ++version; };
  el('login').onclick = async () => {
    el('login').disabled = true;
    try {
      await api('/api/dimension/work/github/login', {method:'POST',body:JSON.stringify(context)});
      el('status').textContent = '请按 GitHub CLI 窗口的提示完成浏览器授权，再刷新状态。';
    } catch (err) { el('status').textContent = err.message; }
    finally { el('login').disabled = false; }
  };
  document.getElementById('workGitHubBtn').onclick = () => {
    context = getContext();
    if (!dialog.open) dialog.showModal();
    void load();
  };
}
