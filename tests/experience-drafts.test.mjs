import assert from 'node:assert/strict';
import { createConversationDrafts } from '../ui/experience-drafts.js';

const context = { mode: 'chat', botId: 'alpha', groupId: '' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class Storage {
  constructor() { this.values = new Map(); }
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function remoteApi(remote, calls, failPut = false) {
  return async (route, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ route, method, body: options.body ? JSON.parse(options.body) : null });
    if (method === 'GET') return { draft: remote ? { ...context, ...remote, revision: String(remote.revision) } : null };
    if (method === 'PUT') {
      if (failPut) throw Object.assign(Error('offline'), { status: 503 });
      const body = JSON.parse(options.body);
      remote = { text: body.text, revision: Number(body.baseRevision) + 1 };
      return { draft: { ...context, ...remote, revision: String(remote.revision) } };
    }
    if (method === 'DELETE') { remote = null; return { cleared: true }; }
    throw Error('unexpected command');
  };
}

const tests = [];
async function test(name, run) {
  await run(); tests.push(name); console.log(`PASS ${name}`);
}

await test('Manual emptying deletes only the matching server draft', async () => {
  const calls = [], storage = new Storage();
  let currentRemote = null;
  const api = async (route, options = {}) => {
    const method = options.method || 'GET'; calls.push({ method });
    if (method === 'GET') return { draft: currentRemote ? { ...context, ...currentRemote, revision: String(currentRemote.revision) } : null };
    if (method === 'PUT') {
      const body = JSON.parse(options.body); currentRemote = { text: body.text, revision: Number(body.baseRevision) + 1 };
      return { draft: { ...context, ...currentRemote, revision: String(currentRemote.revision) } };
    }
    currentRemote = null; return { cleared: true };
  };
  const actual = createConversationDrafts(api, { storage });
  await actual.activate(context);
  actual.capture('delete me'); actual.flushAll(); await sleep(20);
  assert.equal(currentRemote.text, 'delete me');
  actual.capture(''); actual.flushAll(); await sleep(20);
  assert.equal(currentRemote, null);
  assert(calls.some(call => call.method === 'DELETE'));
});

await test('Failed backend saves restore from bounded local outbox without submitting', async () => {
  const storage = new Storage(), calls = [];
  const offline = createConversationDrafts(remoteApi(null, calls, true), { storage });
  await offline.activate(context);
  offline.capture('离线草稿'); offline.flushAll(); await sleep(20);
  assert.equal(storage.length, 1);
  assert(calls.every(call => call.route === '/api/dimension/draft' || call.route.startsWith('/api/dimension/draft?')));

  let remote = null; const retryCalls = [];
  const api = async (route, options = {}) => {
    const method = options.method || 'GET'; retryCalls.push({ route, method });
    if (method === 'GET') return { draft: null };
    const body = JSON.parse(options.body); remote = { text: body.text, revision: 1 };
    return { draft: { ...context, ...remote, revision: '1' } };
  };
  const reopened = createConversationDrafts(api, { storage });
  let visible = '';
  await reopened.activate(context, { apply: text => { visible = text; } });
  await sleep(20);
  assert.equal(visible, '离线草稿');
  assert.equal(remote.text, '离线草稿');
  assert.equal(storage.length, 0);
  assert(retryCalls.every(call => call.route.startsWith('/api/dimension/draft')));
});

await test('Typing during send cleanup preserves the new draft', async () => {
  const storage = new Storage(); let resolveFirst, currentRemote = null, deletes = 0;
  const puts = [];
  const api = async (route, options = {}) => {
    const method = options.method || 'GET';
    if (method === 'GET') return { draft: null };
    if (method === 'DELETE') { ++deletes; currentRemote = null; return { cleared: true }; }
    const body = JSON.parse(options.body); puts.push(body);
    if (puts.length === 1) await new Promise(resolve => { resolveFirst = resolve; });
    currentRemote = { text: body.text, revision: puts.length };
    return { draft: { ...context, ...currentRemote, revision: String(puts.length) } };
  };
  const drafts = createConversationDrafts(api, { storage });
  await drafts.activate(context);
  drafts.capture('submitted'); drafts.flushAll(); await sleep(5);
  const clearing = drafts.clearAfterSend();
  drafts.capture('new input'); drafts.flushAll();
  resolveFirst(); await clearing; await sleep(20);
  assert.equal(deletes, 0);
  assert.equal(currentRemote.text, 'new input');
  assert.equal(puts.length, 2);
});

await test('Slow reads cannot resurrect text sent before their response', async () => {
  const storage = new Storage(); let resolveRead, deletes = 0, visible = 'initial';
  const api = async (route, options = {}) => {
    const method = options.method || 'GET';
    if (method === 'GET') {
      await new Promise(resolve => { resolveRead = resolve; });
      return { draft: { ...context, text: 'already sent', revision: '7' } };
    }
    if (method === 'DELETE') {
      const body = JSON.parse(options.body);
      assert.equal(body.revision, '7'); ++deletes; return { cleared: true };
    }
    throw Error('no save expected');
  };
  const drafts = createConversationDrafts(api, { storage });
  const loading = drafts.activate(context, { apply: text => { visible = text; } });
  const clearing = drafts.clearAfterSend();
  resolveRead(); await Promise.all([loading, clearing]);
  assert.equal(visible, '');
  assert.equal(deletes, 1);
});

console.log(JSON.stringify({ passed: true, checks: tests.length }));
