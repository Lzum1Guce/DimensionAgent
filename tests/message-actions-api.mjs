// Real native API with only a fresh synthetic database; no model/provider setup.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setup, cleanup, parseOptions, startNative, digest, until } from './relation-notes-api.mjs';
import { fixtureArchive, rawImport } from './archive-export-api.mjs';

const config = await setup(parseOptions(), 'message-actions/api');
config.fingerprints.apiTest = digest(await readFile(import.meta.filename));
const checks = [], failures = [], frames = [];
const pass = text => { checks.push(text); console.log('PASS ' + text); };
const seed = fixtureArchive('message-actions'), ids = seed.ids;
let app, socket;
const history = (bot = ids.owner, mode = 'chat') => app.api(`/api/dimension/bots/${bot}/history?mode=${mode}&limit=99`);
const group = (id = ids.group, mode = 'chat') => app.api(`/api/dimension/groups/${id}?mode=${mode}&limit=99`);
const remove = (scope, id, message) => `/api/dimension/${scope}/${id}/messages/${message.messageId}`;
const runs = async () => Promise.all(['chat-runs', 'work-runs'].map(name => readdir(path.join(config.data, name))));
try {
  app = await startNative({ ...config, label: 'native' });
  await rawImport(app, seed.archive, 'synthetic-message-actions');
  const original = await history(), originalWork = await history(ids.owner, 'work');
  const originalGroup = await group(), originalGroupWork = await group(ids.group, 'work');
  const source = original.messages[0], groupSource = originalGroup.messages[0];
  const preserved = (await app.api('/api/native/archive/export', {}, 'POST')).archive;
  const originalRuns = await runs();
  socket = new WebSocket(app.origin.replace('http:', 'ws:') + '/ws/providers/world:console/panels/chat');
  socket.addEventListener('message', event => frames.push(JSON.parse(event.data)));
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.send(JSON.stringify({ type: 'hello', botId: ids.owner, historyLimit: 1 }));
  await until(() => frames.length, 'private history handshake');

  const body = { requestId: 'private-to-private', sourceMode: 'chat', sourceBotId: ids.owner, messageIds: [source.messageId] };
  const route = `/api/dimension/bots/${ids.admin}/forward`;
  const forwarded = (await app.api(route, body)).message;
  const groupForwarded = (await app.api(`/api/dimension/groups/${ids.deleted}/record`, { ...body, requestId: 'private-to-group' })).message;
  assert.equal(forwarded.actor, 'system');
  assert.equal(forwarded.context.kind, 'forward');
  assert.equal(forwarded.context.sources[0].text, source.text);
  assert.equal(forwarded.context.sources[0].groupId, '');
  assert.equal(forwarded.context.sources[0].botId, ids.owner);
  assert.deepEqual(groupForwarded.context, forwarded.context);
  assert.equal((await app.api(route, body)).message.messageId, forwarded.messageId);
  const oldBody = { requestId: 'group-to-private', sourceMode: 'chat', sourceGroupId: ids.group, messageIds: [groupSource.messageId] };
  const oldForwarded = (await app.api(route, oldBody)).message;
  const groupToGroup = (await app.api(`/api/dimension/groups/${ids.deleted}/record`, { ...oldBody, requestId: 'group-to-group' })).message;
  assert.equal(oldForwarded.context.sources[0].text, groupSource.text);
  assert.deepEqual(groupToGroup.context, oldForwarded.context);
  pass('Private and group Chat sources forward to private and group destinations with authentic snapshots and stable retries');

  for (const bad of [
    { ...body, sourceGroupId: ids.group }, { ...body, sourceMode: 'work' },
    { ...body, sourceBotId: ids.admin, requestId: 'cross-private' },
    { ...body, messageIds: [source.messageId, groupSource.messageId], requestId: 'mixed' },
    { ...body, messageIds: [originalWork.messages[0].messageId], requestId: 'work' },
    { ...body, messageIds: [source.messageId, source.messageId], requestId: 'duplicate' },
    { ...body, messageIds: ['01'], requestId: 'noncanonical' },
    { ...body, sourceRef: { messageId: source.messageId } }, { ...body, text: 'forged snapshot' },
  ]) await app.api(route, bad, 'POST', 400);
  await app.api(route, { ...body, sourceBotId: ids.admin }, 'POST', 409);
  await app.api(route, { ...body, requestId: 'unknown', messageIds: ['999999999'] }, 'POST', 404);
  pass('Ambiguous scopes, Work rows, mixed/private foreign IDs, forged content and malformed IDs fail without writes');

  const privateDelete = remove('bots', ids.owner, source);
  await app.api(remove('bots', ids.admin, source), undefined, 'DELETE', 404);
  await app.api(remove('groups', ids.group, source), undefined, 'DELETE', 404);
  await app.api(remove('bots', ids.owner, originalWork.messages[0]), undefined, 'DELETE', 404);
  await app.api(remove('groups', ids.group, originalGroupWork.messages[0]), undefined, 'DELETE', 404);
  await app.api(privateDelete + '?mode=work', undefined, 'DELETE', 400);
  await app.api(privateDelete, { mode: 'work' }, 'DELETE', 400);
  await app.api(privateDelete, undefined, 'GET', 405);
  assert.equal((await app.api(privateDelete, undefined, 'DELETE')).deleted, true);
  assert.equal((await app.api(privateDelete, undefined, 'DELETE')).deleted, false);
  await until(() => frames.find(frame => frame.type === 'message.deleted' && frame.messageId === source.messageId && frame.botId === ids.owner), 'private deletion broadcast');
  assert(!(await history()).messages.some(row => row.messageId === source.messageId));
  await app.api(remove('bots', ids.admin, source), undefined, 'DELETE', 404);
  assert.equal((await app.api(route, body)).message.messageId, forwarded.messageId);
  await app.api(route, { ...body, requestId: 'deleted-source' }, 'POST', 404);
  assert.equal((await history(ids.admin)).messages.find(row => row.messageId === forwarded.messageId).context.sources[0].text, source.text);
  pass('Private deletion broadcasts, removes only the selected row, keeps snapshots and has a persistent idempotent tombstone');

  const groupDelete = remove('groups', ids.group, groupSource);
  await app.api(remove('bots', groupSource.botId, groupSource), undefined, 'DELETE', 404);
  await app.api(remove('groups', ids.deleted, groupSource), undefined, 'DELETE', 404);
  assert.equal((await app.api(groupDelete, undefined, 'DELETE')).deleted, true);
  assert.equal((await app.api(groupDelete, undefined, 'DELETE')).deleted, false);
  assert(!(await group()).messages.some(row => row.messageId === groupSource.messageId));
  assert.equal((await app.api(route, oldBody)).message.messageId, oldForwarded.messageId);
  assert.equal((await app.api(remove('bots', ids.admin, forwarded), undefined, 'DELETE')).deleted, true);
  await app.api(route, body, 'POST', 409);
  const exported = (await app.api('/api/native/archive/export', {}, 'POST')).archive;
  assert.deepEqual(exported.memories, preserved.memories);
  assert.deepEqual(exported.bots, preserved.bots);
  assert.deepEqual((await history(ids.owner, 'work')).messages, originalWork.messages);
  assert.deepEqual((await group(ids.group, 'work')).messages, originalGroupWork.messages);
  assert.deepEqual(await runs(), originalRuns);
  pass('Group deletion and forwarded-record deletion retain memories/personas/Work, and no operation creates a model run');

  socket.close(); socket = null;
  await app.stop(); app = await startNative({ ...config, label: 'restart' });
  assert.equal((await app.api(privateDelete, undefined, 'DELETE')).deleted, false);
  assert.equal((await app.api(groupDelete, undefined, 'DELETE')).deleted, false);
  await app.api(route, body, 'POST', 409);
  assert.deepEqual((await group(ids.deleted)).messages.find(row => row.messageId === groupForwarded.messageId).context, groupForwarded.context);
  pass('Real native restart retains exact deletion tombstones and historical forwarding snapshots');
} catch (error) { failures.push(error.stack); process.exitCode = 1; }
finally {
  socket?.close();
  if (app?.child.exitCode === null) await app.stop().catch(error => failures.push(error.message));
  await cleanup(config);
  const result = { ok: failures.length === 0, checks, failures, fingerprints: config.fingerprints, traces: config.traces, productionDataUsed: false };
  await writeFile(path.join(config.output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, checks: checks.length, output: config.output }));
}
