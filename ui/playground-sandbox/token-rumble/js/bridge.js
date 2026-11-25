/**
 * 算力牌局 · Token Rumble — DimensionAgent 游乐场双向伴玩与主题桥接
 * 协议：dimension-coplay-v1
 */

export function applyThemeMode(mode) {
  const normalized = mode === 'light' || mode === 'codexlight' ? 'light' : 'dark';
  document.documentElement.dataset.codexTheme = normalized;
  return normalized;
}

export function parseUrlContext() {
  const params = new URLSearchParams(window.location.search);
  const embed = params.get('embed') === '1';
  const theme = applyThemeMode(params.get('theme') || 'dark');
  let companions = [];
  const raw = params.get('companions');
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        companions = parsed
          .filter((item) => item && item.id)
          .map((item, idx) => ({
            seat: Number(item.seat) || idx + 1,
            id: String(item.id),
            name: String(item.name || item.id.replace(/^ai-/i, '')),
            role: String(item.role || '对手'),
          }));
      }
    } catch {
      companions = [];
    }
  }
  return { embed, theme, companions };
}

export function subscribeHostBridge({ onTheme, onRoster, onModel }) {
  const handler = (event) => {
    const data = event?.data;
    if (!data || data.protocol !== 'dimension-coplay-v1') return;
    if (data.type === 'coplay:theme' && data.theme) {
      const mode = applyThemeMode(data.theme);
      onTheme?.(mode);
    }
    if (data.type === 'coplay:roster' && Array.isArray(data.companions)) {
      const list = data.companions
        .filter((item) => item && item.id)
        .map((item, idx) => ({
          seat: Number(item.seat) || idx + 1,
          id: String(item.id),
          name: String(item.name || item.id.replace(/^ai-/i, '')),
          role: String(item.role || '对手'),
        }));
      onRoster?.(list);
    }
    if (data.type === 'coplay:model') {
      onModel?.({
        ready: Boolean(data.ready),
        model: String(data.model || ''),
        providerId: String(data.providerId || ''),
      });
    }
  };
  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}

let lastEmitAt = 0;

export function emitCoPlayEvent(mood, text, meta = {}) {
  if (!window.parent || window.parent === window) return;
  const now = Date.now();
  // 轻微节流避免 AI 连续动作刷爆右侧聊天气泡，重要事件可设 force: true
  if (!meta.force && now - lastEmitAt < 260) return;
  lastEmitAt = now;
  try {
    window.parent.postMessage(
      {
        protocol: 'dimension-coplay-v1',
        type: 'coplay:event',
        mood: mood || 'neutral',
        text: String(text || '').slice(0, 260),
        botId: meta.botId || undefined,
        seat: typeof meta.seat === 'number' ? meta.seat : undefined,
      },
      '*',
    );
  } catch {
    // 独立浏览器打开时静默跳过
  }
}
