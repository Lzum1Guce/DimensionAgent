// Real native API with an original local model fixture and entirely synthetic
// Bot/group/task data. Does not read production data or launch the installed app.
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseOptions, startNative, digest, until } from './archive-export-api.mjs';
import { startFixture } from './app-integration.mjs';

const project = path.resolve(import.meta.dirname, '..'), options = parseOptions();
const output = path.resolve(options.get('output') || path.join(project, 'outputs/team-panel', 'api-' + Date.now()));
const allowed = path.join(project, 'outputs/team-panel'), relative = path.relative(allowed, output);
assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Test outputs must remain inside outputs/team-panel');
await mkdir(path.join(output, 'temp'), { recursive: true });
const executable = path.resolve(options.get('exe') || path.join(project, 'outputs/build/DImensionagent-native.exe'));
const ui = path.resolve(options.get('ui') || path.join(project, 'ui')), data = path.join(output, 'data');
const binary = path.join(output, 'test-native.exe'); await copyFile(executable, binary);
const fingerprints = { native: digest(await readFile(binary)), test: digest(await readFile(import.meta.filename)),
  appSource: digest(await readFile(path.join(project, 'src/app.cpp'))) };
if (options.has('expected-sha')) assert.equal(fingerprints.native, options.get('expected-sha').toLowerCase());
const processes = [], traces = [], checks = [], failures = [], pass = text => { checks.push(text); console.log('PASS ' + text); };
const coordinator = 'team-coordinator', draft = 'team-draft', review = 'team-review';
let app, fixture, groupId;
const config = { executable: binary, ui, data, output, processes, traces };
const get = id => app.api('/api/dimension/work/runs/' + id + '?view=1');
const complete = id => until(async () => {
  const run = await get(id);
  if (['failed', 'cancelled', 'interrupted'].includes(run.status)) throw Object.assign(Error(JSON.stringify(run)), { fatal: true });
  return run.status === 'completed' && !run.executing ? run : null;
}, 'completed synthetic task ' + id, 25000);
const sessions = extra => app.api('/api/dimension/work/sessions?' + new URLSearchParams({ botId: coordinator, groupId, ...extra }));
try {
  fixture = await startFixture({ groupPlan: [
    { id: 'draft', botId: draft, text: 'APPTEST:team_panel_draft' },
    { id: 'images', botId: review, text: 'APPTEST:team_panel_images' },
    { id: 'review', botId: review, text: 'APPTEST:team_panel_review', dependencies: ['draft', 'images'] },
  ] });
  app = await startNative({ ...config, label: 'native' });
  for (const [id, name] of [[coordinator, '薇尔莉特'], [draft, '亚丝娜'], [review, '芙莉莲']]) {
    await app.api('/api/dimension/bots', { id, name, persona: 'Synthetic task panel fixture' });
    await app.api('/api/dimension/bots/' + id + '/roster', { mode: 'work', present: true }, 'PATCH');
  }
  await app.api('/api/providers', { name: 'synthetic', entry: { kind: 'openai-chat-compat', baseUrl: fixture.baseUrl,
    spec: { model: 'fixture-flash' } }, secretValue: 'synthetic-key' });
  groupId = (await app.api('/api/dimension/groups', { name: '合成任务面板', ownerId: coordinator, members: [coordinator, draft, review] })).group.id;
  await app.api('/api/dimension/groups/' + groupId + '/roster', { mode: 'work', present: true }, 'POST');
  fixture.gate('team_panel_draft');
  const rootId = (await app.api('/api/dimension/work/runs', { botId: coordinator, groupId, text: 'APPTEST:group_coordinator', requestId: 'team-panel-parent' })).run.id;
  await fixture.pending('team_panel_draft');
  const system = fixture.records.find(row => row.tag === 'group_coordinator')?.body.messages.find(message => message.role === 'system')?.content;
  assert(system?.includes('薇尔莉特') && system.includes('亚丝娜') && system.includes('使用上述真实成员名称') && system.includes('默认只给简短报告'));
  assert(system.includes('群工作默认并发') && system.includes('一次 delegate_work') && system.includes('team_status') && system.includes('readyForSummary') && system.includes('用户明确指定单人或顺序执行时遵循要求'));
  const workerSystem = fixture.records.find(row => row.tag === 'team_panel_draft')?.body.messages.find(message => message.role === 'system')?.content;
  assert(workerSystem?.includes('你负责已经分配给你的这一部分工作') && !workerSystem.includes('一次 delegate_work'));
  const pending = await until(async () => {
    const value = await get(rootId);
    return value.assignments.some(job => job.jobId === 'review' && job.status === 'waiting') && value.assignments.some(job => job.jobId === 'images' && job.status === 'completed') ? value : null;
  }, 'independent work completed while dependent review waits');
  assert.equal(pending.parentRunId, '');
  const pendingReview = pending.assignments.find(job => job.jobId === 'review');
  assert.equal(pendingReview.botId, review); assert.equal(pendingReview.assignee, review); assert.equal(pendingReview.runId, '');
  assert.deepEqual(pendingReview.dependsOn, ['draft', 'images']);
  const running = await sessions({ limit: '1' });
  assert.equal(running.runs.filter(row => !row.parentRunId).length, 1);
  for (const job of pending.assignments.filter(job => job.runId)) {
    assert.equal(job.key, job.runId);
    const child = running.runs.find(row => row.id === job.runId); assert(child, 'Root page includes each started worker');
    assert.equal(child.parentRunId, rootId); assert.equal(child.botId, job.botId);
  }
  pass('Omitted dependencies start different Bots concurrently; real dependencies wait, with distinct coordinator/assignee instructions and one root panel');

  fixture.release('team_panel_draft');
  const finished = await complete(rootId), children = finished.assignments.map(job => job.runId);
  assert.equal(children.length, 3); assert.equal(new Set(children).size, 3);
  assert.equal(finished.assignments.filter(job => job.botId === review).length, 2, 'Two tasks by one Bot keep separate identities');
  const files = [];
  for (const id of children) {
    assert.equal((await get(id)).parentRunId, rootId);
    const delivered = (await app.api('/api/dimension/work/tasks/' + id + '/artifacts')).files;
    assert.equal(delivered.length, 1); assert.equal(delivered[0].available, true);
    files.push({ path: delivered[0].path, bytes: await readFile(delivered[0].path) });
  }
  const independentId = (await app.api('/api/dimension/work/runs', { botId: review, groupId, text: 'APPTEST:team_panel_independent', requestId: 'team-panel-independent', deliveryMode: 'queue' })).run.id;
  await complete(independentId);
  const latest = await sessions({ limit: '1' });
  assert.deepEqual(latest.runs.map(row => row.id), [independentId]); assert.equal(latest.hasMore, true); assert.equal(latest.before, independentId);
  const older = await sessions({ limit: '1', before: latest.before });
  assert.deepEqual(new Set(older.runs.map(row => row.id)), new Set([rootId, ...children]));
  assert.equal(older.before, rootId); assert.equal(older.hasMore, false);
  const delta = await sessions({ limit: '1', before: latest.before, cursors: JSON.stringify(Object.fromEntries(older.runs.map(row => [row.id, row.lastSeq]))) });
  assert(delta.runs.every(row => row.events.length === 0));
  pass('Pagination counts roots and returns all children; same-Bot repeated jobs and same-group independent work remain distinct with separate artifact access and event cursors');

  await app.stop(); app = await startNative({ ...config, label: 'native-restart' });
  const restored = await sessions({ limit: '50' });
  for (const id of children) assert.equal(restored.runs.find(row => row.id === id)?.parentRunId, rootId);
  const removed = await app.api('/api/dimension/work/runs/' + rootId, undefined, 'DELETE');
  assert.deepEqual(new Set(removed.deletedIds), new Set([rootId, ...children]));
  const after = await sessions({ limit: '50' }); assert.deepEqual(after.runs.map(row => row.id), [independentId]);
  for (const file of files) assert.deepEqual(await readFile(file.path), file.bytes);
  await app.stop(); app = await startNative({ ...config, label: 'native-after-delete' });
  assert.deepEqual((await sessions({ limit: '50' })).runs.map(row => row.id), [independentId]);
  pass('Persisted parent links survive restart; deleting one task removes exactly its complete tree through refresh/restart and retains unrelated work plus all workspace file bytes');

  fixture.gate('team_panel_draft', true);
  const activeRoot = (await app.api('/api/dimension/work/runs', { botId: coordinator, groupId, text: 'APPTEST:group_coordinator', requestId: 'team-panel-running-delete' })).run.id;
  await fixture.pending('team_panel_draft');
  const liveChild = (await get(activeRoot)).assignments.find(job => job.jobId === 'draft' && job.runId)?.runId; assert(liveChild);
  const partialFile = (await app.api('/api/dimension/work/tasks/' + liveChild + '/artifacts')).files[0]; assert(partialFile?.available);
  const partialBytes = await readFile(partialFile.path);
  const stopped = await app.api('/api/dimension/work/runs/' + activeRoot, undefined, 'DELETE');
  assert(stopped.deletedIds.includes(activeRoot) && stopped.deletedIds.includes(liveChild));
  assert.deepEqual((await sessions({ limit: '50' })).runs.map(row => row.id), [independentId]);
  assert.deepEqual(await readFile(partialFile.path), partialBytes);
  pass('Deleting a running parent cancels and drains the exact active tree, preserves partial files and leaves no returning child cards');
  assert.deepEqual(fixture.errors, []);
  await app.stop();
} catch (error) { failures.push(error.stack); console.error(error.stack); process.exitCode = 1; }
finally {
  if (app?.child.exitCode === null) await app.stop().catch(error => { failures.push(error.stack); process.exitCode = 1; });
  if (fixture) await fixture.close();
  for (const entry of processes) await writeFile(path.join(output, entry.label + '.log'), entry.stdout + '\nSTDERR\n' + entry.stderr);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ type: 'real-native-synthetic-model-api', passed: failures.length === 0, checks, failures,
    fingerprints, traces, productionDataUsed: false, fixtureErrors: fixture?.errors || [] }, null, 2));
  console.log('REPORT ' + path.join(output, 'report.json'));
}
