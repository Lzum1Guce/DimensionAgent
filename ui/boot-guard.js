// Early theme restoration & boot failure guard (external script for strict CSP compliance).
(() => {
  try {
    const saved = JSON.parse(localStorage.getItem('dimension-client-settings') || '{}');
    const raw = saved.theme || (window.__dimensionClientSettings && window.__dimensionClientSettings.theme) || 'paperlight';
    const resolved = raw === 'system'
      ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'nightink' : 'paperlight')
      : (raw === 'nightink' || raw === 'warmamber' || raw === 'codex' || raw === 'codexlight' ? raw : 'paperlight');
    document.documentElement.dataset.theme = resolved;
    const motion = saved.motion || (window.__dimensionClientSettings && window.__dimensionClientSettings.motion);
    document.documentElement.dataset.motion = (motion === 'lite' || motion === 'off') ? motion : 'full';
  } catch {}

  let failed = false;
  const fail = (reason, detail) => {
    const curtain = document.getElementById('bootSplashCurtain');
    if (failed || !curtain || curtain.classList.contains('is-leaving')) return false;
    failed = true;
    curtain.classList.add('is-error');
    curtain.setAttribute('role', 'alertdialog');
    const status = document.getElementById('bootStatusText');
    if (status) status.textContent = '✦ 星轨连接中断 · ' + (reason || '界面未能完成加载');
    const footer = curtain.querySelector('.boot-footer');
    if (footer && !footer.querySelector('.boot-error-actions')) {
      if (detail) {
        const d = document.createElement('div');
        d.className = 'boot-error-detail';
        d.textContent = String(detail).slice(0, 220);
        footer.appendChild(d);
      }
      const actions = document.createElement('div');
      actions.className = 'boot-error-actions';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'is-primary';
      retry.textContent = '重新连接';
      retry.addEventListener('click', () => location.reload());
      actions.appendChild(retry);
      if (window.__dimensionAppStarted) {
        const enter = document.createElement('button');
        enter.type = 'button';
        enter.textContent = '仍然进入';
        enter.addEventListener('click', () => {
          curtain.classList.add('is-leaving');
          setTimeout(() => curtain.remove(), 520);
        });
        actions.appendChild(enter);
      }
      footer.appendChild(actions);
      retry.focus();
    }
    return true;
  };

  window.__bootFail = fail;
  window.addEventListener('error', (event) => {
    if (window.__dimensionAppStarted) return;
    const t = event.target;
    const isScriptLoad = t && t.tagName === 'SCRIPT';
    if (!(event instanceof ErrorEvent) && !isScriptLoad) return;
    fail('界面脚本出错', event.message || (isScriptLoad && t.src) || '');
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    if (window.__dimensionAppStarted) return;
    fail('界面初始化失败', event.reason && (event.reason.message || event.reason));
  });

  const activateDeferredStyles = () => {
    document.querySelectorAll('link[data-defer-css="1"]').forEach((link) => {
      if (link.media === 'all') return;
      const promote = () => { link.media = 'all'; };
      if (link.sheet) promote();
      else {
        link.addEventListener('load', promote, { once: true });
        setTimeout(promote, 240);
      }
    });
  };

  document.addEventListener('DOMContentLoaded', () => {
    requestAnimationFrame(activateDeferredStyles);
    const appEntry = document.getElementById('dimensionAppEntry');
    appEntry?.addEventListener('error', () => {
      fail('界面模块加载失败', 'app.js 或其依赖模块无法载入');
    });
  });

  setTimeout(() => {
    if (!window.__dimensionAppStarted) fail('界面模块加载超时', '请检查后端服务是否正常运行');
  }, 12000);
})();
