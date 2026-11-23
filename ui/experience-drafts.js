const LOCAL_PREFIX = 'dimension.conversation-draft.v1.';
const MAX_LOCAL_DRAFTS = 16;
const MAX_LOCAL_TOTAL_BYTES = 256 * 1024;
const MAX_DRAFT_BYTES = 64 * 1024;

function normalizedContext(context) {
  if (!context) return null;
  const mode = context.mode === 'work' ? 'work' : 'chat';
  const groupId = String(context.groupId || '');
  const botId = groupId ? '' : String(context.botId || '');
  if (!botId && !groupId) return null;
  return { mode, botId, groupId };
}

function contextKey(context) {
  const value = normalizedContext(context);
  return value ? JSON.stringify([value.mode, value.botId, value.groupId]) : '';
}

function utf8Bytes(text) {
  return new TextEncoder().encode(String(text || '')).byteLength;
}

/**
 * Versioned server drafts with a small, explicit local outbox. The outbox is
 * only a failure fallback; it never submits a message and never evicts unsent
 * text to make room for another context.
 */
export function createConversationDrafts(api, { storage, onStatus = () => {} } = {}) {
  let local = storage;
  if (!local) {
    try { local = globalThis.localStorage; } catch { local = null; }
  }
  const records = new Map();
  let activeKey = '', activation = 0;

  const recordFor = context => {
    const key = contextKey(context);
    if (!key) return null;
    if (!records.has(key)) records.set(key, {
      key, context: normalizedContext(context), text: '', revision: 0,
      mutation: 0, sendVersion: 0, timer: 0, queue: Promise.resolve(), loading: Promise.resolve(), loaded: false,
    });
    return records.get(key);
  };

  const localKey = key => LOCAL_PREFIX + encodeURIComponent(key);
  const readLocal = key => {
    if (!local) return null;
    try {
      const value = JSON.parse(local.getItem(localKey(key)) || 'null');
      if (!value || value.key !== key || typeof value.text !== 'string' || typeof value.mutation !== 'number') return null;
      return value;
    } catch { return null; }
  };
  const localEntries = () => {
    const rows = [];
    if (!local) return rows;
    try {
      for (let index = 0; index < local.length; ++index) {
        const key = local.key(index);
        if (!key?.startsWith(LOCAL_PREFIX)) continue;
        const value = JSON.parse(local.getItem(key) || 'null');
        if (value && typeof value.text === 'string') rows.push(value);
      }
    } catch { /* A blocked/corrupt store must not clear the visible editor. */ }
    return rows;
  };
  const writeLocal = record => {
    if (!local) return false;
    const value = {
      key: record.key, context: record.context, text: record.text,
      mutation: record.mutation, updatedAt: Date.now(),
    };
    const serialized = JSON.stringify(value);
    const others = localEntries().filter(row => row.key !== record.key);
    if (utf8Bytes(record.text) > MAX_DRAFT_BYTES || others.length >= MAX_LOCAL_DRAFTS ||
        utf8Bytes(serialized) + others.reduce((sum, row) => sum + utf8Bytes(JSON.stringify(row)), 0) > MAX_LOCAL_TOTAL_BYTES) {
      onStatus({ state: 'error', message: '本机草稿空间已满；输入仍保留，请恢复服务后保存。' });
      return false;
    }
    try { local.setItem(localKey(record.key), serialized); return true; }
    catch { return false; }
  };
  const removeLocal = (record, mutation) => {
    if (!local) return;
    try {
      const existing = readLocal(record.key);
      if (existing && existing.mutation === mutation) local.removeItem(localKey(record.key));
    } catch { /* The server copy remains authoritative. */ }
  };

  function capture(text) {
    const record = records.get(activeKey);
    if (!record) return;
    const next = String(text ?? '');
    if (record.text === next) return;
    record.text = next;
    ++record.mutation;
    writeLocal(record);
    onStatus({ state: 'saving' });
    clearTimeout(record.timer);
    record.timer = setTimeout(() => { void flush(record); }, 220);
  }

  function flush(record) {
    clearTimeout(record.timer);
    record.timer = 0;
    record.queue = record.queue.then(async () => {
      const mutation = record.mutation, text = record.text, baseRevision = record.revision;
      if (!text) {
        if (!baseRevision) {
          removeLocal(record, mutation);
          if (activeKey === record.key) onStatus({ state: 'empty' });
          return;
        }
        try {
          await api('/api/dimension/draft', {
            method: 'DELETE',
            body: JSON.stringify({ ...record.context, revision: String(baseRevision) }),
          });
          if (record.revision === baseRevision) record.revision = 0;
          if (record.mutation === mutation) {
            removeLocal(record, mutation);
            if (activeKey === record.key) onStatus({ state: 'empty' });
          }
        } catch (error) {
          // Keep even an intentionally empty outbox entry. Otherwise an older
          // server draft would reappear after reopening the conversation.
          writeLocal(record);
          if (activeKey === record.key) onStatus({ state: 'local', message: error.status === 409
            ? '另一窗口更新了草稿；当前清空状态已留在本机。'
            : '服务暂时不可用；清空状态已留在本机。' });
        }
        return;
      }
      try {
        const result = await api('/api/dimension/draft', {
          method: 'PUT',
          body: JSON.stringify({ ...record.context, text, baseRevision: String(baseRevision) }),
        });
        const saved = result?.draft;
        if (!saved || contextKey(saved) !== record.key || saved.text !== text) throw new Error('草稿服务返回了不匹配的上下文');
        // A newer response updates only the base version. Newer visible text is
        // kept and will be saved by the next queued operation.
        if (record.mutation === mutation || record.revision === baseRevision) {
          record.revision = Number(saved.revision);
        }
        if (record.mutation === mutation) {
          removeLocal(record, mutation);
          if (activeKey === record.key) onStatus({ state: 'saved' });
        } else {
          writeLocal(record);
        }
      } catch (error) {
        writeLocal(record);
        if (activeKey === record.key) onStatus({ state: 'local', message: error.status === 409
          ? '另一窗口更新了草稿；当前输入已留在本机，未被覆盖。'
          : '服务暂时不可用；当前输入已留在本机，尚未提交。' });
      }
    });
    return record.queue;
  }

  async function activate(context, { readCurrent, apply } = {}) {
    if (activeKey && readCurrent) capture(readCurrent());
    const next = normalizedContext(context), key = contextKey(next);
    if (key === activeKey) return;
    activeKey = key;
    const ticket = ++activation;
    const record = recordFor(next);
    if (!record) { apply?.(''); onStatus({ state: 'empty' }); return; }
    const pending = readLocal(key);
    if (pending) {
      record.text = pending.text;
      record.mutation = Math.max(record.mutation, pending.mutation);
    }
    apply?.(record.text);
    onStatus({ state: record.text ? 'restored' : 'empty' });
    const startingMutation = record.mutation, startingSendVersion = record.sendVersion;
    record.loading = (async () => {
      try {
        const result = await api(`/api/dimension/draft?mode=${encodeURIComponent(record.context.mode)}&botId=${encodeURIComponent(record.context.botId)}&groupId=${encodeURIComponent(record.context.groupId)}`);
        const remote = result?.draft;
        if (remote && contextKey(remote) !== key) throw new Error('草稿服务返回了其他上下文');
        record.revision = remote ? Number(remote.revision) : 0;
        record.loaded = true;
        const latestLocal = readLocal(key);
        const unchanged = record.mutation === startingMutation && record.sendVersion === startingSendVersion;
        // Pending local input or anything typed/sent while this request was in
        // flight is newer than the response and must not be overwritten by it.
        if (unchanged) {
          if (!latestLocal) record.text = remote?.text || '';
          if (ticket === activation && activeKey === key) {
            apply?.(record.text);
            onStatus({ state: record.text ? (latestLocal ? 'local' : 'restored') : 'empty' });
          }
        }
        if (latestLocal && record.sendVersion === startingSendVersion) void flush(record);
      } catch {
        if (ticket === activation && activeKey === key && record.sendVersion === startingSendVersion)
          onStatus({ state: record.text ? 'local' : 'error' });
      }
    })();
    await record.loading;
  }

  function clearAfterSend() {
    const record = records.get(activeKey);
    if (!record) return;
    clearTimeout(record.timer);
    const mutation = record.mutation;
    ++record.sendVersion;
    record.text = '';
    removeLocal(record, mutation);
    onStatus({ state: 'empty' });
    // This operation is chained after older saves. If the user types again
    // while waiting, the mutation check preserves the new draft.
    record.queue = record.queue.then(async () => {
      await record.loading;
      if (record.mutation !== mutation || record.text !== '') return;
      if (!record.revision) return;
      const revision = record.revision;
      try {
        await api('/api/dimension/draft', {
          method: 'DELETE',
          body: JSON.stringify({ ...record.context, revision: String(revision) }),
        });
        if (record.mutation === mutation && !record.text) record.revision = 0;
      } catch (error) {
        // A conflict means another/newer draft exists. Never restore the sent
        // text over it and never retry an unconditional delete.
        if (activeKey === record.key && error.status !== 409) onStatus({ state: 'error', message: '消息已提交；服务端草稿清理失败，不会自动重发。' });
      }
    });
    return record.queue;
  }

  function flushAll() {
    if (activeKey) {
      const record = records.get(activeKey);
      if (record?.timer) void flush(record);
    }
  }

  return { activate, capture, clearAfterSend, flushAll, contextKey };
}
