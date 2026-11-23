// Isolated persistent notification inbox API integration. Synthetic data only.
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startFixture } from './app-integration.mjs';
import { startNative, until, delay, digest } from './archive-export-api.mjs';

const project = path.resolve(import.meta.dirname, '..');
const output = path.join(project, 'outputs/notification-inbox', 'api-' + Date.now() + '-' + process.pid);
const data = path.join(output, 'data');
const executable = path.resolve(process.argv[2] || path.join(project, 'outputs/build/DImensionagent-native.exe'));
const processes = [], traces = [], checks = [], failures = [];
const botId = 'notification-inbox-bot';
let app, fixture;
const pass = text => { checks.push(text); console.log('PASS ' + text); };
const systemNotices = () => processes.flatMap(entry => entry.stdout.split(/\r?\n/).flatMap(line => {
  try { const value = JSON.parse(line); return value.notification || value.notificationControl ? [value] : []; }
  catch { return []; }
}));
const launch = async label => {
  app = await startNative({ label, executable, ui: path.join(project, 'ui'), data, output, processes, traces });
  return app;
};
const stop = async () => { if (app) await app.stop(); app = null; };
const list = async (unread = false) => app.api('/api/native/notifications' + (unread ? '?unread=true' : ''));
const run = async id => app.api('/api/dimension/work/runs/' + encodeURIComponent(id));
const terminal = async (id, status) => {
  const value = await until(async () => {
    const current = await run(id); return current.terminal && !current.executing ? current : null;
  }, `Work ${id} terminal ${status}`);
  assert.equal(value.status, status, JSON.stringify({ status: value.status, error: value.error }));
  return value;
};
const submit = async (tag, requestId = 'request-' + tag) => {
  const result = await app.api('/api/dimension/work/runs', { botId, text: 'APPTEST:' + tag, requestId });
  assert(result.run?.id); return result;
};
const chat = async tag => {
  const frames = [];
  const socket = new WebSocket(app.origin.replace('http:', 'ws:') + '/ws/providers/world:console/panels/chat');
  socket.addEventListener('message', event => frames.push(JSON.parse(event.data)));
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(Error('Chat WebSocket failed')), { once: true });
  });
  socket.send(JSON.stringify({ type: 'hello', botId, historyLimit: 2 }));
  socket.send(JSON.stringify({ type: 'msg', botId, text: 'APPTEST:' + tag, requestId: 'chat-' + tag }));
  await until(() => frames.some(frame => !frame.history && frame.role === 'assistant' && frame.text === `Chat reply ${tag} 🙂`), 'ordinary Chat reply');
  socket.close();
};
const pendingApproval = async runId => until(async () => {
  const data = await app.api('/api/dimension/work/pending?botId=' + encodeURIComponent(botId));
  return data.pending.find(row => row.runId === runId && row.tool === 'write_file');
}, 'write_file approval');

try {
  await mkdir(path.join(output, 'temp'), { recursive: true });
  fixture = await startFixture();
  await launch('inbox-initial');
  assert((await app.api('/api/native/info')).capabilities.includes('persistent-notification-inbox'));
  assert.equal((await app.api('/api/dimension/bootstrap')).features.notificationInbox, true);
  await app.api('/api/dimension/bots', { id: botId, name: '通知测试 Bot', persona: 'Synthetic notification inbox persona' });
  for (const mode of ['chat', 'work'])
    await app.api(`/api/dimension/bots/${encodeURIComponent(botId)}/roster`, { mode, present: true }, 'PATCH');
  await app.api('/api/providers', { name: 'synthetic', entry: { kind: 'openai-chat-compat', baseUrl: fixture.baseUrl,
    spec: { model: 'fixture-flash' } }, secretValue: 'synthetic-key' });
  assert.deepEqual((await list()).items, []);
  pass('Native capability and empty inbox API are available');

  await chat('inbox_chat');
  assert.equal((await list()).total, 0);
  const completedSubmission = await submit('inbox_complete');
  const completedRun = await terminal(completedSubmission.run.id, 'completed');
  let inbox = await until(async () => {
    const value = await list(); return value.items.some(row => row.runId === completedRun.id && row.kind === 'completed') ? value : null;
  }, 'completed Work persisted in inbox');
  assert.equal(inbox.total, 1); assert.equal(inbox.unreadCount, 1);
  const completedNotice = inbox.items[0];
  assert.equal(completedNotice.botId, botId); assert.equal(completedNotice.botName, '通知测试 Bot');
  assert.equal(completedNotice.runId, completedRun.id); assert.equal(completedNotice.read, false);
  assert.equal(completedNotice.waiting, false); assert(completedNotice.summary.includes('APPTEST:inbox_complete'));
  assert(completedNotice.id && completedNotice.time);
  const duplicate = await submit('inbox_complete');
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.run.id, completedRun.id);
  await delay(150); assert.equal((await list()).total, 1);
  assert.equal((await list(true)).items.length, 1);
  pass('Ordinary Chat adds nothing; completion persists required fields and duplicate submission adds nothing');

  const noticesBeforeRestart = systemNotices().length;
  await stop(); await launch('inbox-restart-preserve');
  await delay(250);
  inbox = await list();
  assert.equal(inbox.total, 1); assert.equal(inbox.unreadCount, 1);
  assert.equal(inbox.items[0].id, completedNotice.id); assert.equal(inbox.items[0].read, false);
  assert.equal(systemNotices().length, noticesBeforeRestart, 'Restart replayed a system notification');
  const stored = JSON.parse(await readFile(path.join(data, 'notification-inbox.json'), 'utf8'));
  assert.equal(stored.version, 1); assert.equal(stored.items.length, 1); assert.equal(stored.items[0].id, completedNotice.id);
  const read = await app.api('/api/native/notifications/read', { id: completedNotice.id });
  assert.equal(read.found, true); assert.equal(read.unreadCount, 0);
  assert.equal((await list(true)).items.length, 0);
  await stop(); await launch('inbox-restart-read');
  assert.equal((await list()).items[0].read, true);
  assert.equal((await app.api('/api/native/notifications/unread-count')).unreadCount, 0);
  pass('Inbox and read state survive restarts without system notification replay');

  const beforeWaiting = (await list()).total;
  await app.api('/api/dimension/work/settings', { botId, approvalMode: 'ask' }, 'PATCH');
  fixture.gate('inbox_approval', true);
  const waitingSubmission = await submit('inbox_approval');
  const approval = await pendingApproval(waitingSubmission.run.id);
  inbox = await until(async () => {
    const value = await list();
    return value.items.some(row => row.runId === waitingSubmission.run.id && row.kind === 'takeover' && row.waiting) ? value : null;
  }, 'takeover waiting record');
  assert.equal(inbox.total, beforeWaiting + 1);
  const waitingId = inbox.items.find(row => row.runId === waitingSubmission.run.id).id;
  await app.api('/api/dimension/work/pending/' + encodeURIComponent(approval.id) + '/decision', { botId, allow: true });
  await fixture.pending('inbox_approval');
  inbox = await until(async () => {
    const value = await list();
    return value.items.find(row => row.id === waitingId)?.waiting === false ? value : null;
  }, 'approval decision resolves original inbox wait');
  const resolved = inbox.items.find(row => row.id === waitingId);
  assert(resolved.resolvedAt); assert.equal(inbox.total, beforeWaiting + 1);
  await app.api('/api/dimension/work/runs/' + encodeURIComponent(waitingSubmission.run.id) + '/cancel', {});
  await terminal(waitingSubmission.run.id, 'cancelled'); fixture.release('inbox_approval');
  await delay(150); assert.equal((await list()).total, beforeWaiting + 1);
  assert.equal((await list()).items.filter(row => row.runId === waitingSubmission.run.id).length, 1);
  await app.api('/api/dimension/work/settings', { botId, approvalMode: 'auto' }, 'PATCH');
  const readAll = await app.api('/api/native/notifications/read-all', {});
  assert.equal(readAll.unreadCount, 0); assert.equal((await app.api('/api/native/notifications/unread-count')).unreadCount, 0);
  pass('resolve-waiting updates the original record; cancel and read-all add no notifications');

  fixture.gate('inbox_cancel');
  const beforeCancel = (await list()).total;
  const cancelled = await submit('inbox_cancel'); await fixture.pending('inbox_cancel');
  await app.api('/api/dimension/work/runs/' + encodeURIComponent(cancelled.run.id) + '/cancel', {});
  await terminal(cancelled.run.id, 'cancelled'); fixture.release('inbox_cancel');
  await chat('inbox_chat_after');
  await delay(150); assert.equal((await list()).total, beforeCancel);
  pass('Direct cancellation and later ordinary Chat leave inbox count unchanged');

  // Simulate a persistent-storage failure after all preservation checks. The
  // native service must still execute Work and emit its normal desktop notice.
  await stop();
  await rm(path.join(data, 'notification-inbox.json'), { force: true });
  await mkdir(path.join(data, 'notification-inbox.json'));
  await launch('inbox-storage-failure');
  const failedStorage = await submit('inbox_storage_failure');
  await terminal(failedStorage.run.id, 'completed');
  await until(() => systemNotices().some(value => value.notification?.kind === 'completed' &&
    value.notification.runId === failedStorage.run.id), 'desktop notification survives inbox write failure');
  assert.equal((await list()).total, 0);
  pass('Inbox persistence failure does not block Work or normal desktop delivery');
  assert.deepEqual(fixture.errors, []);
} catch (error) {
  failures.push(error.stack || String(error)); console.error(error); process.exitCode = 1;
} finally {
  if (app) await stop().catch(error => { failures.push(error.stack); process.exitCode = 1; });
  if (fixture) await fixture.close();
  const report = { ok: failures.length === 0, checks, failures, traces, output, data,
    executable: { path: executable, sha256: digest(await readFile(executable)) }, deployed: false, productionDataRead: false };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log('NOTIFICATION_INBOX_API_RESULT ok=' + report.ok + ' passed=' + checks.length + ' failed=' + failures.length + ' directory=' + output);
}
