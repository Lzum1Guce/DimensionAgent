const STORAGE_KEY = 'dimension.sidebarState.v1';
const REQUEST_TIMEOUT_MS = 8000;
const labels = { completed: '工作完成', partial: '待继续', failed: '工作失败', cancelled: '已中止', interrupted: '已中断', waiting: '等待前置任务', blocked: '等待前置任务' };

export function createSidebarState({ api, getBotIds, onChange = () => {}, storage = globalThis.localStorage }) {
  let saved = {};
  try { saved = JSON.parse(storage?.getItem(STORAGE_KEY) || '{}') || {}; } catch { /* Optional local preference. */ }
  const activity = saved.activity || {}, seen = saved.seen || {}, collapsed = saved.collapsed || {};
  let snapshot = { work: [], teams: [] }, fingerprint = '', pending, timer, started = false, pollVersion = 0, needsPaint = false;
  const save = () => { try { storage?.setItem(STORAGE_KEY, JSON.stringify({ activity, seen, collapsed })); } catch { /* Optional local preference. */ } };
  const note = (key, timestamp) => {
    const at = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
    if (!Number.isFinite(at) || at <= (activity[key] || 0)) return false;
    activity[key] = at; return true;
  };
  const accept = data => {
    let changed = false;
    for (const [key, at] of Object.entries(data.activity || {})) changed = note(key, at) || changed;
    const next = { work: Array.isArray(data.work) ? data.work : [], teams: Array.isArray(data.teams) ? data.teams : [] };
    const key = JSON.stringify(next);
    changed = changed || key !== fingerprint; fingerprint = key; snapshot = next;
    if (changed || needsPaint) {
      save(); needsPaint = true;
      onChange(data);
      needsPaint = false;
    }
  };
  const refresh = () => {
    if (pending) return pending.promise;
    const controller = new AbortController(), request = { promise: null, cancel: () => {} };
    // Also settle locally: a suspended WebView/network adapter may never finish its fetch.
    const cancelled = new Promise(resolve => { request.cancel = () => { controller.abort(); resolve(null); }; });
    const timeout = setTimeout(request.cancel, REQUEST_TIMEOUT_MS);
    pending = request;
    request.promise = Promise.race([
      Promise.resolve().then(() => api(`/api/dimension/sidebar?botIds=${encodeURIComponent([...new Set(getBotIds())].join(','))}`, {
        cache: 'no-store', signal: controller.signal,
      })),
      cancelled,
    ]).then(data => { if (pending === request && !controller.signal.aborted) accept(data); })
      .catch(() => { /* Keep the last known state while reconnecting; retry on the next tick. */ })
      .finally(() => { clearTimeout(timeout); if (pending === request) pending = null; });
    return request.promise;
  };
  const nextDelayMs = () => (snapshot.work.some(row => row?.active) ? 2500 : 8000);
  const tick = async version => {
    if (!started || version !== pollVersion) return;
    if (globalThis.document?.hidden) return;
    await refresh();
    if (started && version === pollVersion && !globalThis.document?.hidden) {
      timer = setTimeout(() => void tick(version), nextDelayMs());
    }
  };
  const onVisibilityChange = () => {
    if (!started || globalThis.document?.hidden) {
      clearTimeout(timer);
      return;
    }
    clearTimeout(timer);
    void tick(pollVersion);
  };
  return {
    accept, refresh,
    start() {
      if (started) return;
      started = true;
      globalThis.document?.addEventListener?.('visibilitychange', onVisibilityChange);
      void tick(++pollVersion);
    },
    stop() {
      started = false;
      ++pollVersion;
      clearTimeout(timer);
      globalThis.document?.removeEventListener?.('visibilitychange', onVisibilityChange);
      pending?.cancel();
      pending = null;
    },
    message(mode, kind, id, timestamp = Date.now()) {
      if (id && note(`${mode}:${kind}:${id}`, timestamp)) { save(); onChange({}); }
    },
    at(mode, kind, id) { return activity[`${mode}:${kind}:${id}`] || 0; },
    badge(id) {
      const row = snapshot.work.find(row => row.botId === id);
      if (!row) return null;
      if (row.active) return { ...row, label: '工作中' };
      if (seen[id] === row.token) return null;
      return { ...row, label: labels[row.status] || '待继续' };
    },
    acknowledge(id) {
      const row = snapshot.work.find(row => row.botId === id);
      if (!row || row.active || seen[id] === row.token) return;
      seen[id] = row.token; save(); onChange({});
    },
    acknowledgeGroup(id) {
      let changed = false;
      for (const row of snapshot.work.filter(row => row.groupId === id)) if (seen[row.botId] !== row.token) {
        seen[row.botId] = row.token; changed = true;
      }
      if (changed) { save(); onChange({}); }
    },
    teams() { return snapshot.teams; },
    collapsed(id) { return collapsed[id] === true; },
    toggle(id) { collapsed[id] = !collapsed[id]; save(); onChange({}); },
  };
}
