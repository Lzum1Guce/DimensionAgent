const QUICK_PRESETS = [
  { label: '8K', tokens: 8192 },
  { label: '32K', tokens: 32768 },
  { label: '64K', tokens: 65536 },
  { label: '128K', tokens: 131072 },
  { label: '256K', tokens: 262144 },
  { label: '512K', tokens: 524288 },
  { label: '1M', tokens: 1048576 },
  { label: '2M', tokens: 2097152 },
];

function formatTokenBadge(n) {
  const val = Number(n) || 0;
  if (val >= 1048576) {
    const m = val / 1048576;
    return `${Number.isInteger(m) ? m : m.toFixed(2).replace(/\.?0+$/, '')}M · ${val.toLocaleString('zh-CN')} tokens`;
  }
  const k = val / 1024;
  return `${Number.isInteger(k) ? k : k.toFixed(1).replace(/\.0$/, '')}K · ${val.toLocaleString('zh-CN')} tokens`;
}

export function bindContextLimits({ api, dialog }) {
  const section = document.createElement('section');
  section.className = 'context-limits';
  section.innerHTML = `
    <h3>自定义上下文容量</h3>
    <p class="context-lead">上下文窗口大小完全交由你自主决定；系统仅保留最低与最高安全闸值，不再强制缩减你的配置。</p>
    <div class="context-gate-banner" id="ctxGateBanner">安全闸值范围：最低 4,096 (4K) tokens ～ 最高 2,097,152 (2M) tokens</div>
    <form class="context-form">
      <div class="context-fields"></div>
      <p class="context-status" role="status"></p>
      <footer class="context-footer">
        <button type="button" class="context-reset">填入推荐参考值</button>
        <button type="submit" class="context-save-btn">保存并立即生效</button>
      </footer>
    </form>`;
  dialog.append(section);

  const form = section.querySelector('form');
  const status = section.querySelector('.context-status');
  const fields = section.querySelector('.context-fields');
  const gateBanner = section.querySelector('#ctxGateBanner');

  let version = 0;
  let busy = false;
  let snapshot;

  const lock = () => {
    for (const ctrl of form.querySelectorAll('input,button')) {
      ctrl.disabled = busy || !snapshot;
    }
  };

  const paint = (data) => {
    snapshot = data;
    const minVal = Number(data.min) || 4096;
    const maxVal = Number(data.max) || 2097152;
    if (gateBanner) {
      gateBanner.textContent = `系统安全闸值：最低 ${minVal.toLocaleString('zh-CN')} (${Math.round(minVal / 1024)}K) ～ 最高 ${maxVal.toLocaleString('zh-CN')} (${Math.round(maxVal / 1048576)}M) tokens`;
    }
    fields.replaceChildren();

    for (const [id, item] of Object.entries(data.recommendations || {})) {
      const curTokens = Math.min(maxVal, Math.max(minVal, Number(data.limits?.[id] ?? item.tokens)));

      const card = document.createElement('div');
      card.className = 'ctx-limit-card';

      const head = document.createElement('div');
      head.className = 'ctx-limit-head';
      const title = document.createElement('strong');
      title.className = 'ctx-limit-title';
      title.textContent = item.label;
      const badge = document.createElement('span');
      badge.className = 'ctx-limit-badge';
      badge.textContent = formatTokenBadge(curTokens);
      head.append(title, badge);

      const hint = document.createElement('small');
      hint.className = 'ctx-limit-hint';
      hint.textContent = item.reason || '';

      const controls = document.createElement('div');
      controls.className = 'ctx-limit-controls';

      const range = document.createElement('input');
      range.type = 'range';
      range.className = 'ctx-limit-range';
      range.min = String(minVal);
      range.max = String(maxVal);
      range.step = '4096';
      range.value = String(curTokens);
      range.setAttribute('aria-label', `${item.label} 滑块调节`);

      const numInput = document.createElement('input');
      numInput.type = 'number';
      numInput.className = 'ctx-limit-number';
      numInput.name = id;
      numInput.min = String(minVal);
      numInput.max = String(maxVal);
      numInput.step = '1';
      numInput.required = true;
      numInput.value = String(curTokens);
      numInput.setAttribute('aria-label', `${item.label} 精确上限（tokens）`);

      const chips = document.createElement('div');
      chips.className = 'ctx-limit-chips';

      const syncActiveChip = (val) => {
        const n = Number(val);
        badge.textContent = formatTokenBadge(n);
        for (const c of chips.querySelectorAll('button')) {
          c.classList.toggle('is-active', Number(c.dataset.tokens) === n);
        }
      };

      for (const preset of QUICK_PRESETS) {
        if (preset.tokens < minVal || preset.tokens > maxVal) continue;
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'ctx-preset-chip';
        chip.dataset.tokens = String(preset.tokens);
        chip.textContent = preset.label;
        chip.onclick = () => {
          numInput.value = String(preset.tokens);
          range.value = String(preset.tokens);
          syncActiveChip(preset.tokens);
          status.textContent = '已调整数值，点击下方“保存并立即生效”完成应用。';
        };
        chips.append(chip);
      }

      range.oninput = () => {
        numInput.value = range.value;
        syncActiveChip(range.value);
      };
      numInput.oninput = () => {
        const n = Number(numInput.value);
        if (Number.isFinite(n)) {
          range.value = String(Math.min(maxVal, Math.max(minVal, n)));
          syncActiveChip(n);
        }
      };

      syncActiveChip(curTokens);
      controls.append(range, numInput);
      card.append(head, hint, controls, chips);
      fields.append(card);
    }
  };

  const load = async () => {
    const ticket = ++version;
    busy = true;
    snapshot = undefined;
    lock();
    status.textContent = '正在读取当前上下文配置…';
    try {
      const data = await api('/api/dimension/context-limits');
      if (ticket !== version || !dialog.open) return;
      paint(data);
      status.textContent = '';
    } catch (error) {
      if (ticket === version) status.textContent = error.message;
    } finally {
      if (ticket === version) {
        busy = false;
        lock();
      }
    }
  };

  dialog.addEventListener('close', () => {
    version++;
    busy = false;
  });

  section.querySelector('.context-reset').onclick = () => {
    if (!snapshot) return;
    for (const [id, item] of Object.entries(snapshot.recommendations || {})) {
      const numEl = form.elements[id];
      if (numEl) {
        numEl.value = String(item.tokens);
        numEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    status.textContent = '已填入参考值，点击“保存并立即生效”确认。';
  };

  form.onsubmit = async (event) => {
    event.preventDefault();
    if (busy || !snapshot || !form.reportValidity()) return;
    const limits = Object.fromEntries(
      Object.keys(snapshot.recommendations || {}).map((id) => [id, Math.round(Number(form.elements[id].value))])
    );
    const ticket = ++version;
    busy = true;
    lock();
    status.textContent = '正在保存你的上下文配置…';
    try {
      const data = await api('/api/dimension/context-limits', {
        method: 'PUT',
        body: JSON.stringify({ limits }),
      });
      window.dispatchEvent(new CustomEvent('dimension-context-limits-changed', { detail: data }));
      if (ticket !== version || !dialog.open) return;
      paint(data);
      status.textContent = '✓ 已保存并生效！右下角上下文仪表与后续对话将直接按你设定的窗口运行。';
    } catch (error) {
      if (ticket === version) status.textContent = error.message;
    } finally {
      if (ticket === version) {
        busy = false;
        lock();
      }
    }
  };

  lock();
  return { load };
}

export function bindContextDialog({ api, onHistory }) {
  const trigger = document.getElementById('contextLimitsBtn');
  if (!trigger) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'context-dialog work-model-dialog';
  dialog.innerHTML = '<header><h2>上下文容量配置</h2><button type="button" class="context-close">关闭</button></header>';
  const context = bindContextLimits({ api, dialog });
  dialog.querySelector('.context-limits h3')?.remove();
  if (onHistory) {
    const history = document.createElement('button');
    history.type = 'button';
    history.className = 'context-history';
    history.textContent = '查看当前 Bot 的历史与归档';
    history.onclick = () => {
      dialog.close();
      void onHistory();
    };
    dialog.append(history);
  }
  dialog.querySelector('.context-close').onclick = () => dialog.close();
  trigger.onclick = () => {
    if (!dialog.open) {
      dialog.showModal();
      void context.load();
    }
  };
  document.body.append(dialog);
}
