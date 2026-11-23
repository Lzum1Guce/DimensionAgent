import { bindContextLimits } from './context-limits-ui.js';

const STORAGE_KEY = 'dimension-client-settings';
const defaults = {
  language: 'zh-CN',
  theme: 'paperlight', // paperlight | nightink | system
  closeToTray: true,
  rememberWindowPosition: true,
  notificationsEnabled: true,
  notificationMerge: true,
  motion: 'full', // full | lite | off：界面动效强度
};

export function readClientSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch {}
  const injected = window.__dimensionClientSettings || {};
  const next = { ...defaults, ...injected, ...saved };
  if (!['zh-CN', 'en'].includes(next.language)) next.language = 'zh-CN';
  if (!['paperlight', 'warmamber', 'nightink', 'system'].includes(next.theme)) next.theme = 'paperlight';
  next.closeToTray = next.closeToTray !== false;
  next.rememberWindowPosition = next.rememberWindowPosition !== false;
  next.notificationsEnabled = next.notificationsEnabled !== false;
  next.notificationMerge = next.notificationMerge !== false;
  if (!['full', 'lite', 'off'].includes(next.motion)) next.motion = 'full';
  return next;
}

export function resolvedTheme(theme = readClientSettings().theme) {
  if (theme === 'system') {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'nightink' : 'paperlight';
  }
  if (theme === 'nightink') return 'nightink';
  if (theme === 'warmamber') return 'warmamber';
  return 'paperlight';
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = resolvedTheme(theme);
}

/** 界面动效：full 完整 / lite 精简（关闭粒子与装饰性循环动画）/ off 关闭（等同系统“减少动画”） */
export function applyMotion(motion = readClientSettings().motion) {
  document.documentElement.dataset.motion = ['lite', 'off'].includes(motion) ? motion : 'full';
}

function postHost(payload) {
  try { window.chrome?.webview?.postMessage({ source: 'dimension-settings', ...payload }); }
  catch { /* Browser preview has no native host. */ }
}

export function writeClientSettings(partial) {
  const next = { ...readClientSettings(), ...partial };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
  window.__dimensionClientSettings = next;
  applyTheme(next.theme);
  applyMotion(next.motion);
  postHost({ action: 'set', settings: next });
  return next;
}

export function bindClientSettings({ api } = {}) {
  const dialog = document.getElementById('clientSettings');
  const mask = document.getElementById('clientSettingsMask');
  const gear = document.getElementById('clientSettingsBtn');
  if (!dialog || !gear) return { open() {}, close() {} };

  let contextCtrl = null;
  const GROUP_ACT_META = {
    quiet:    { label: '安静', hint: '极简省 Token，仅最相关成员开口，旁观者默认潜水。' },
    balanced: { label: '日常', hint: '自然的群聊节奏，主角稳接对话、旁观适度起哄。推荐日常使用。' },
    lively:   { label: '热闹', hint: '更爱接梗起哄，每轮 4～5 位伙伴有较高意愿参与互动。' },
    party:    { label: '狂欢', hint: '全员自由思考插嘴，气氛拉满！⚠ Token 消耗最高。' },
    custom:   { label: '自定义', hint: '自由指定每轮最多允许的群聊会话数（0-999，0 为静默）。' },
  };
  let groupActState = { level: 'party', customLimit: 8 };
  const paintGroupActivity = () => {
    const lv = GROUP_ACT_META[groupActState.level] ? groupActState.level : 'party';
    const meta = GROUP_ACT_META[lv];
    const badge = dialog.querySelector('#csGroupActBadge');
    const hint = dialog.querySelector('#csGroupActHint');
    const row = dialog.querySelector('#csGroupActCustomRow');
    const inp = dialog.querySelector('#csGroupActCustomInput');
    if (badge) badge.textContent = lv === 'custom' ? `自定义 · ${groupActState.customLimit} 轮` : meta.label;
    if (hint) hint.textContent = meta.hint;
    if (row) row.hidden = lv !== 'custom';
    if (inp && document.activeElement !== inp) inp.value = String(groupActState.customLimit);
    dialog.querySelectorAll('#csGroupActPills .group-activity-pill').forEach((btn) => {
      const on = btn.dataset.level === lv;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  };
  const loadGroupActivity = async () => {
    if (!api) return;
    try {
      const data = await api('/api/dimension/group-activity');
      if (data && GROUP_ACT_META[data.level]) {
        groupActState.level = data.level;
        const n = Number(data.customLimit);
        groupActState.customLimit = Number.isFinite(n) ? Math.max(0, Math.min(999, Math.round(n))) : 8;
      }
      paintGroupActivity();
    } catch {}
  };
  const saveGroupActivity = async (level, customLimit) => {
    if (!api) return;
    const clamped = Math.max(0, Math.min(999, Math.round(Number(customLimit) || 0)));
    groupActState = { level, customLimit: clamped };
    paintGroupActivity();
    const st = dialog.querySelector('#csGroupActStatus');
    if (st) st.textContent = '正在保存…';
    try {
      const data = await api('/api/dimension/group-activity', {
        method: 'PUT',
        body: JSON.stringify({ level, customLimit: clamped }),
      });
      if (data) {
        groupActState = {
          level: data.level || level,
          customLimit: Math.max(0, Math.min(999, Math.round(Number(data.customLimit ?? clamped)))),
        };
      }
      paintGroupActivity();
      if (st) st.textContent = `已保存：${level === 'custom' ? `自定义（每轮上限 ${groupActState.customLimit} 条）` : GROUP_ACT_META[level].label}`;
      window.dispatchEvent(new CustomEvent('dimension:group-activity-updated', { detail: data }));
    } catch (err) {
      if (st) st.textContent = err?.message || '保存失败';
    }
  };
  dialog.querySelectorAll('#csGroupActPills .group-activity-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      const lv = btn.dataset.level;
      if (!lv) return;
      const inp = dialog.querySelector('#csGroupActCustomInput');
      const lim = inp ? inp.value : groupActState.customLimit;
      if (lv === 'custom') {
        // 只展开输入框，等用户填好数字后点「保存」或按回车再提交，避免用默认值误存
        groupActState.level = 'custom';
        paintGroupActivity();
        const st = dialog.querySelector('#csGroupActStatus');
        if (st) st.textContent = '填写每轮上限后点「保存」生效';
        inp?.focus();
        inp?.select?.();
        return;
      }
      void saveGroupActivity(lv, lim);
    });
  });
  dialog.querySelector('#csGroupActCustomSave')?.addEventListener('click', () => {
    const inp = dialog.querySelector('#csGroupActCustomInput');
    void saveGroupActivity('custom', inp ? inp.value : groupActState.customLimit);
  });
  dialog.querySelector('#csGroupActCustomInput')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void saveGroupActivity('custom', event.target.value);
    }
  });
  const paint = () => {
    const s = readClientSettings();
    const close = dialog.querySelector('#csCloseToTray');
    const remember = dialog.querySelector('#csRememberWindow');
    const system = dialog.querySelector('#csThemeSystem');
    const notificationsEnabled = dialog.querySelector('#csNotificationsEnabled');
    const notificationMerge = dialog.querySelector('#csNotificationMerge');
    if (close) close.checked = s.closeToTray;
    if (remember) remember.checked = s.rememberWindowPosition;
    if (system) system.checked = s.theme === 'system';
    if (notificationsEnabled) notificationsEnabled.checked = s.notificationsEnabled;
    if (notificationMerge) notificationMerge.checked = s.notificationMerge;
    dialog.querySelectorAll('.cs-theme-card').forEach((card) => {
      const on = s.theme !== 'system' && card.dataset.theme === resolvedTheme(s.theme);
      card.setAttribute('aria-pressed', on ? 'true' : 'false');
      // 跟随系统时也标出当前实际生效的主题，避免三张卡都不亮让人困惑
      card.classList.toggle('is-auto', s.theme === 'system' && card.dataset.theme === resolvedTheme('system'));
    });
    dialog.querySelectorAll('input[name="csLanguage"]').forEach((radio) => {
      radio.checked = radio.value === s.language;
    });
    const MOTION_HINTS = {
      full: '完整：保留星芽粒子、头像漂浮等全部动效。',
      lite: '精简：关闭点击粒子与装饰性循环动画，保留必要的过渡与加载提示。',
      off: '关闭：几乎不播放动画（与系统“减少动画”相同），适合低配设备或对动效敏感时。',
    };
    dialog.querySelectorAll('.cs-motion-opt').forEach((btn) => {
      const on = btn.dataset.motion === s.motion;
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
      btn.classList.toggle('is-active', on);
      btn.tabIndex = on ? 0 : -1;
    });
    const motionHint = dialog.querySelector('#csMotionHint');
    if (motionHint) motionHint.textContent = MOTION_HINTS[s.motion] || MOTION_HINTS.full;
    applyMotion(s.motion);
    applyTheme(s.theme);
  };

  const showPane = (name) => {
    dialog.querySelectorAll('.cs-nav-item').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.csPane === name));
    dialog.querySelectorAll('.cs-pane').forEach((pane) => { pane.hidden = pane.dataset.csPane !== name; });
    if (name === 'group') {
      paintGroupActivity();
      void loadGroupActivity();
    }
    if (name === 'context' && api) {
      if (!contextCtrl) {
        const host = dialog.querySelector('#csContextHost');
        const fake = {
          get open() { return !dialog.hidden; },
          append: (node) => host?.append(node),
          addEventListener: () => {},
        };
        contextCtrl = bindContextLimits({ api, dialog: fake });
      }
      void contextCtrl.load();
    }
  };

  let returnFocus = null;
  const open = (initialPane = '') => {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    paint();
    dialog.hidden = false;
    mask.hidden = false;
    if (initialPane) {
      showPane(initialPane);
    } else {
      const activeNav = dialog.querySelector('.cs-nav-item.is-active');
      if (activeNav?.dataset.csPane === 'context') void contextCtrl?.load();
    }
    (dialog.querySelector('.cs-nav-item.is-active') || dialog.querySelector('#clientSettingsClose'))?.focus();
  };
  const close = () => {
    dialog.hidden = true;
    mask.hidden = true;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  };

  gear.addEventListener('click', (event) => { event.preventDefault(); open(); });
  mask.addEventListener('click', close);
  dialog.querySelector('#clientSettingsClose')?.addEventListener('click', close);
  // capture 阶段处理 Esc 并阻止继续传播：只关设置这一层，不连带关掉下面的抽屉/弹窗
  document.addEventListener('keydown', (event) => {
    if (dialog.hidden) return;
    // 设置之上若还弹着原生 <dialog>（确认框等），交给它自己处理
    if (document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
      return;
    }
    // 简易焦点陷阱：Tab 不跑出设置面板
    if (event.key === 'Tab') {
      const focusables = [...dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((node) => !node.disabled && node.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!dialog.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }, true);
  dialog.querySelectorAll('.cs-nav-item').forEach((btn) => {
    btn.addEventListener('click', () => showPane(btn.dataset.csPane));
  });
  const motionOpts = [...dialog.querySelectorAll('.cs-motion-opt')];
  motionOpts.forEach((btn, index) => {
    btn.addEventListener('click', () => { writeClientSettings({ motion: btn.dataset.motion }); paint(); });
    // 单选组：方向键切换
    btn.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const next = motionOpts[(index + step + motionOpts.length) % motionOpts.length];
      next.click();
      next.focus();
    });
  });
  dialog.querySelector('#csCloseToTray')?.addEventListener('change', (event) => {
    writeClientSettings({ closeToTray: event.target.checked });
  });
  dialog.querySelector('#csRememberWindow')?.addEventListener('change', (event) => {
    writeClientSettings({ rememberWindowPosition: event.target.checked });
  });
  dialog.querySelector('#csNotificationsEnabled')?.addEventListener('change', (event) => {
    writeClientSettings({ notificationsEnabled: event.target.checked });
  });
  dialog.querySelector('#csNotificationMerge')?.addEventListener('change', (event) => {
    writeClientSettings({ notificationMerge: event.target.checked });
  });
  dialog.querySelector('#csThemeSystem')?.addEventListener('change', (event) => {
    writeClientSettings({ theme: event.target.checked ? 'system' : resolvedTheme() });
    paint();
  });
  dialog.querySelectorAll('.cs-theme-card').forEach((card) => {
    card.addEventListener('click', () => {
      writeClientSettings({ theme: card.dataset.theme });
      paint();
    });
  });
  dialog.querySelectorAll('input[name="csLanguage"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      writeClientSettings({ language: radio.value });
      const restart = dialog.querySelector('#csRestart');
      if (restart) restart.hidden = false;
    });
  });
  dialog.querySelector('#csRestart')?.addEventListener('click', () => postHost({ action: 'restart' }));
  window.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', () => {
    if (readClientSettings().theme === 'system') applyTheme('system');
  });
  paint();
  try {
    window.chrome?.webview?.addEventListener('message', (event) => {
      const data = event.data;
      if (data?.source !== 'dimension-settings') return;
      if (data.language || data.theme || 'closeToTray' in data
        || 'notificationsEnabled' in data || 'notificationMerge' in data) {
        window.__dimensionClientSettings = { ...readClientSettings(), ...data };
        paint();
      }
    });
  } catch { /* no host */ }
  return { open, close, paint };
}

export function bindSidebarCollapse() {
  const app = document.getElementById('app');
  const collapse = document.getElementById('sidebarCollapseBtn');
  const expand = document.getElementById('sidebarExpandBtn');
  if (!app) return;
  const key = 'dimension-sidebar-collapsed';
  const narrow = matchMedia('(max-width: 900px)');
  let preference = null;
  try { preference = localStorage.getItem(key); } catch {}
  const sync = () => {
    const collapsed = preference === '1' || (preference !== '0' && narrow.matches);
    app.classList.toggle('is-sidebar-collapsed', collapsed);
    if (expand) expand.hidden = !collapsed;
  };
  const choose = collapsed => {
    preference = collapsed ? '1' : '0';
    try { localStorage.setItem(key, preference); } catch {}
    sync();
  };
  sync();
  narrow.addEventListener('change', sync);
  collapse?.addEventListener('click', () => choose(true));
  expand?.addEventListener('click', () => choose(false));
}
