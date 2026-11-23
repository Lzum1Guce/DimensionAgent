// Real native-process API checks for procedure-only Work templates.
// Uses fresh synthetic data below this feature directory; no provider or production data.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { project, parseOptions, startNative, digest } from './archive-export-api.mjs';

const options = parseOptions();
const output = path.resolve(options.get('output') || path.join(project, 'outputs', 'work-templates-api', new Date().toISOString().replace(/[:.]/g, '-')));
const executable = path.resolve(options.get('exe') || path.join(project, 'outputs', 'build', 'DImensionagent-native.exe'));
const ui = path.resolve(options.get('ui') || path.join(project, 'ui'));
const data = path.join(output, 'data');
const processes = [], traces = [], checks = [], failures = [];
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const route = id => '/api/dimension/work/templates/' + encodeURIComponent(id);
const sessions = (app, botId, groupId = '') => app.api('/api/dimension/work/sessions?botId=' + encodeURIComponent(botId) + '&groupId=' + encodeURIComponent(groupId) + '&limit=50');
const content = (name, scope, body) => ({ name, description: '合成模板说明：只保留流程', scope, body });
let app;

async function create(app, value, requestId, expected = 200) {
  return app.api('/api/dimension/work/templates', { ...value, requestId }, 'POST', expected);
}
async function update(app, id, value, revision, requestId, expected = 200) {
  return app.api(route(id), { ...value, revision, requestId }, 'PATCH', expected);
}
async function use(app, id, target, requestId, expected = 200) {
  return app.api(route(id) + '/use', { ...target, requestId }, 'POST', expected);
}
async function snapshot(runId) {
  return JSON.parse(await readFile(path.join(data, 'work-runs', 'runs', runId, 'snapshot.json'), 'utf8'));
}

try {
  await mkdir(path.join(output, 'temp'), { recursive: true });
  app = await startNative({ label: 'native', executable, ui, data, output, processes, traces });
  const alpha = 'template-alpha', beta = 'template-beta';
  await app.api('/api/dimension/bots', { id: alpha, name: '合成私聊助手', persona: '私聊目标', mode: 'work' });
  await app.api('/api/dimension/bots', { id: beta, name: '合成备用助手', persona: '备用目标', mode: 'work' });
  const createdGroup = await app.api('/api/dimension/groups', { name: '合成模板群', members: [alpha], ownerId: alpha, mode: 'work' });
  const group = createdGroup.group.id;
  await app.api('/api/dimension/work/settings', { botId: alpha, approvalMode: 'ask' }, 'PATCH');

  const original = content('发布前检查', 'private', '步骤一：检查差异。\n步骤二：运行测试。\n步骤三：报告结果。');
  const forbidden = { runId: 'run-old', status: 'completed', approvalMode: 'full', toolGrants: ['write_file'], secret: 'DO_NOT_SAVE' };
  for (const [key, value] of Object.entries(forbidden))
    await create(app, { ...original, [key]: value }, 'forbidden-' + key, 400);
  assert.equal((await sessions(app, alpha)).runs.length, 0);
  pass('CRUD rejects run state, approvals, tool grants and secrets without creating Work');

  const created = await create(app, original, 'create-private');
  const privateId = created.template.id;
  assert.match(privateId, /^[0-9a-f]{32}$/);
  assert.equal(created.duplicate, false);
  assert.deepEqual(Object.keys(created.template).sort(), ['body', 'createdAt', 'description', 'id', 'name', 'revision', 'scope', 'updatedAt'].sort());
  const createdAgain = await create(app, original, 'create-private');
  assert.equal(createdAgain.duplicate, true);
  assert.equal(createdAgain.template.id, privateId);
  assert.equal((await app.api('/api/dimension/work/templates')).templates.length, 1);
  await create(app, { ...original, body: '相同请求编号不得绑定另一份流程' }, 'create-private', 409);
  assert.equal((await app.api('/api/dimension/work/templates')).templates.length, 1);
  await create(app, original, 'create-private-conflict', 200);
  assert.equal((await app.api('/api/dimension/work/templates')).templates.length, 2);
  const extraId = (await app.api('/api/dimension/work/templates')).templates.find(row => row.id !== privateId).id;
  await app.api(route(extraId), { revision: 1, requestId: 'delete-extra' }, 'DELETE');
  pass('Create/list/get work and repeated create is idempotent, not a second template');

  await update(app, privateId, { ...original, runId: 'run-old' }, 1, 'update-forbidden', 400);
  const editedValue = { ...original, name: '发布前检查（已编辑）', body: '步骤一：重新检查差异。\n步骤二：运行完整测试。\n步骤三：只报告实测结果。' };
  await update(app, privateId, { ...editedValue, approvalMode: 'full' }, 1, 'update-authorization', 400);
  const edited = await update(app, privateId, editedValue, 1, 'update-private');
  assert.equal(edited.template.revision, 2);
  assert.equal(edited.template.body, editedValue.body);
  const editedAgain = await update(app, privateId, editedValue, 1, 'update-private');
  assert.equal(editedAgain.duplicate, true);
  assert.equal(editedAgain.template.revision, 2);
  await update(app, privateId, original, 1, 'stale-update', 409);
  assert.equal((await app.api(route(privateId))).template.body, editedValue.body);
  await create(app, { ...original, name: 'x'.repeat(241) }, 'oversize-name', 400);
  await create(app, { ...original, body: 'x'.repeat(65537) }, 'oversize-body', 400);
  assert.equal((await sessions(app, alpha)).runs.length, 0);
  pass('Edit validates revision and bounds; failed or repeated edits neither run nor rewrite history');

  const beforeRestart = (await app.api(route(privateId))).template;
  await app.stop();
  app = await startNative({ label: 'native-restart', executable, ui, data, output, processes, traces });
  assert.deepEqual((await app.api(route(privateId))).template, beforeRestart);
  assert.equal((await sessions(app, alpha)).runs.length, 0);
  pass('A real native restart preserves templates and still creates no run');

  await use(app, privateId, { botId: alpha, groupId: group }, 'private-wrong-group', 400);
  await use(app, privateId, { botId: alpha, approvalMode: 'full' }, 'private-inherited-approval', 400);
  await use(app, privateId, { botId: 'missing-bot' }, 'private-missing-target', 404);
  assert.equal((await sessions(app, alpha)).runs.length, 0);
  const used = await use(app, privateId, { botId: alpha }, 'use-private');
  const privateRun = used.run.id;
  assert.equal(used.duplicate, false);
  assert.deepEqual(used.target, { botId: alpha, botName: '合成私聊助手', groupId: '', groupName: '', scope: 'private' });
  assert.equal(used.run.text, editedValue.body);
  assert.equal(used.run.groupId, '');
  assert.equal(used.run.inputContext, null);
  assert.equal(used.run.inputCount, 1);
  assert.equal(used.run.parentRunId, '');
  const privateSnapshot = await snapshot(privateRun);
  assert.deepEqual(privateSnapshot.tools, []);
  assert.deepEqual(privateSnapshot.requests, ['template:' + privateId + ':use-private']);
  assert.equal(privateSnapshot.inputs.length, 1);
  assert.equal(privateSnapshot.inputs[0].context, null);
  assert(!JSON.stringify(privateSnapshot).includes('DO_NOT_SAVE'));
  assert.equal((await app.api('/api/dimension/work/pending?botId=' + alpha)).pending.length, 0);
  pass('Only explicit use submits a fresh private run with current target and no inherited context, receipts or approvals');

  const duplicateUses = await Promise.all(Array.from({ length: 12 }, () => use(app, privateId, { botId: alpha }, 'use-private')));
  assert(duplicateUses.every(result => result.run.id === privateRun));
  assert(duplicateUses.every(result => result.duplicate === true));
  assert.equal((await sessions(app, alpha)).runs.length, 1);
  assert.deepEqual((await snapshot(privateRun)).requests, ['template:' + privateId + ':use-private']);
  pass('Concurrent repeated clicks return the original run and never duplicate execution');

  const thirdValue = { ...editedValue, body: '这是编辑后的新流程；历史任务不应变化。' };
  const third = await update(app, privateId, thirdValue, 2, 'update-after-run');
  assert.equal(third.template.revision, 3);
  assert.equal((await app.api('/api/dimension/work/runs/' + privateRun)).text, editedValue.body);
  const newUse = await use(app, privateId, { botId: alpha }, 'use-private-new-revision');
  assert.notEqual(newUse.run.id, privateRun);
  assert.equal(newUse.run.text, thirdValue.body);
  assert.equal((await app.api('/api/dimension/work/runs/' + privateRun)).text, editedValue.body);
  pass('Editing changes only later manual uses; historical runs retain their original text');

  const groupValue = content('群发布流程', 'group', '由当前群成员执行群流程。');
  const groupCreated = await create(app, groupValue, 'create-group');
  const groupId = groupCreated.template.id;
  await use(app, groupId, { botId: alpha }, 'group-wrong-private', 400);
  await use(app, groupId, { botId: beta, groupId: group }, 'group-nonmember', 409);
  assert.equal((await sessions(app, alpha, group)).runs.length, 0);
  const groupUses = await Promise.all(Array.from({ length: 10 }, () => use(app, groupId, { botId: alpha, groupId: group }, 'use-group')));
  assert.equal(new Set(groupUses.map(result => result.run.id)).size, 1);
  assert.equal(groupUses.filter(result => !result.duplicate).length, 1);
  assert.deepEqual(groupUses[0].target, { botId: alpha, botName: '合成私聊助手', groupId: group, groupName: '合成模板群', scope: 'group' });
  assert.equal(groupUses[0].run.inputContext, null);
  assert.equal((await sessions(app, alpha, group)).runs.length, 1);
  assert.equal((await sessions(app, beta)).runs.length, 0);
  pass('Group scope enforces current membership and target display; duplicate group clicks create one run');

  const deleted = await app.api(route(groupId), { revision: 1, requestId: 'delete-group' }, 'DELETE');
  assert.equal(deleted.deleted, true);
  const deletedAgain = await app.api(route(groupId), { revision: 1, requestId: 'delete-group' }, 'DELETE');
  assert.equal(deletedAgain.duplicate, true);
  await app.api(route(groupId), undefined, 'GET', 404);
  assert.equal((await app.api('/api/dimension/work/runs/' + groupUses[0].run.id)).text, groupValue.body);
  const stored = await readFile(path.join(data, 'work-templates', 'templates.json'), 'utf8');
  assert(!stored.includes('DO_NOT_SAVE'));
  assert(!stored.includes('approvalMode'));
  assert(!stored.includes('toolGrants'));
  assert(!stored.includes(privateRun));
  assert(!stored.includes(groupUses[0].run.id));
  pass('Delete is idempotent and leaves history intact; persisted templates contain no run IDs or authorization');

  await app.stop();
  const report = {
    ok: true, checks, failures, productionDataUsed: false, providerRequests: 0,
    fingerprints: { native: digest(await readFile(executable)), apiTest: digest(await readFile(import.meta.filename)) },
    traces,
  };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, checks: checks.length, output }));
} catch (error) {
  failures.push(error.stack);
  process.exitCode = 1;
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: false, checks, failures, traces, productionDataUsed: false }, null, 2));
  console.error(error);
} finally {
  if (app?.child.exitCode === null) await app.stop().catch(error => failures.push(error.message));
}
