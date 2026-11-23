import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixture } from './app-integration.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.resolve(process.argv[2] ?? path.join(root, 'outputs', 'build', 'DImensionagent-native.exe'));
const ui = path.resolve(process.argv[3] ?? path.join(root, 'ui'));
const output = path.resolve(process.argv[4] ?? path.join(root, 'outputs', 'phase2-app'));
assert(path.isAbsolute(output) && output !== path.parse(output).root, 'Integration output must be a non-root absolute directory');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, 'group-'));
const dataDirectory = path.join(directory, 'data');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fingerprints = {
  native: digest(await readFile(executable)),
  ui: digest(await readFile(path.join(ui, 'app.js'))),
  test: digest(await readFile(fileURLToPath(import.meta.url))),
  modelFixture: digest(await readFile(path.join(root, 'tests', 'app-integration.mjs'))),
};
const bots = ['group-coordinator', 'group-worker-a', 'group-worker-b'];
const models = ['fixture-flash', 'fixture-simple', 'fixture-standard', 'fixture-complex', 'fixture-next',
  'fixture-chat-a', 'fixture-chat-b', 'fixture-chat-c'];
const fixture = await startFixture({ models, groupPlan: [
  { id: 'job_a', botId: bots[1], text: 'APPTEST:group_child_a', dependencies: [] },
  { id: 'job_b', botId: bots[2], text: 'APPTEST:group_child_b', dependencies: [] },
  { id: 'job_c', botId: bots[2], text: 'APPTEST:group_child_c', dependencies: ['job_a'] },
], partialGroupPlan: [
  { id: 'job_ok', botId: bots[1], text: 'APPTEST:partial_child_a', dependencies: [] },
  { id: 'job_fail', botId: bots[2], text: 'APPTEST:group_error', dependencies: [] },
  { id: 'job_blocked', botId: bots[2], text: 'APPTEST:partial_child_c', dependencies: ['job_fail'] },
], budgetGroupPlan: [
  { id: 'job_wait', botId: bots[1], text: 'APPTEST:budget_child', dependencies: [] },
] });
const tests = [];
const failures = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scrub = (text) => String(text).replaceAll('synthetic-key', '[synthetic credential redacted]');
let child;
let exited = false;
let exitPromise;
let stdout = '';
let stderr = '';
let base;
let groupId;
let parentRun;
let chatSocket;
const initialGroupMessageIds = [];
let limits = { chat: 32768, group: 32768, work: 65536, complex: 131072 };

async function until(predicate, description, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    if (exited) throw new Error(`Native exited unexpectedly: ${stderr}`);
    await sleep(20);
  }
  throw new Error(`Timed out: ${description}`);
}
async function check(name, action) {
  const started = Date.now();
  try { await action(); tests.push({ name, passed: true, milliseconds: Date.now() - started }); process.stdout.write(`PASS ${name}\n`); }
  catch (error) {
    const detail = scrub(error.stack ?? error);
    tests.push({ name, passed: false, milliseconds: Date.now() - started, detail });
    failures.push(detail); process.stderr.write(`FAIL ${name}: ${detail}\n`); throw error;
  }
}
async function api(target, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + target, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000) });
  const text = await response.text();
  assert.ok(!text.includes('synthetic-key'), 'Public API leaked credential');
  assert.ok(response.ok, `${method} ${target}: ${response.status} ${text}`);
  return JSON.parse(text);
}
async function groupSay(tag, extra = '') {
  const response = await fetch(base + `/api/dimension/groups/${groupId}/say`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `APPTEST:${tag}${extra}`, mode: 'discuss' }), signal: AbortSignal.timeout(15000),
  });
  assert.ok(response.ok, `Group say failed: ${response.status}`);
  const events = [];
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end; (end = buffer.indexOf('\n\n')) >= 0;) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      assert.ok(!frame.includes('THINKING_ONLY') && !frame.includes('synthetic-key'));
      for (const line of frame.split('\n')) if (line.startsWith('data: '))
        events.push({ ...JSON.parse(line.slice(6)), receivedAt: Date.now() });
    }
  }
  assert.equal(buffer.trim(), '');
  return events;
}
async function getRun(id) { return api(`/api/dimension/work/runs/${id}`); }
async function terminal(id) {
  return until(async () => { const run = await getRun(id); return run.terminal && !run.executing ? run : null; }, `terminal ${id}`, 12000);
}
async function complete(id) {
  const run = await terminal(id);
  assert.equal(run.status, 'completed', JSON.stringify({ status: run.status, error: run.error, answer: run.answer }));
  return run;
}
async function work(tag, extra = '') {
  return (await api('/api/dimension/work/runs', { botId: bots[0], text: `APPTEST:${tag}${extra}`, requestId: `group-suite-${tag}` })).run.id;
}
async function groupWork(tag) {
  const response = await fetch(base + `/api/dimension/groups/${groupId}/say`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'work', workBotId: bots[0], text: `APPTEST:${tag}` }), signal: AbortSignal.timeout(15000),
  });
  if (response.status !== 200) throw Error(await response.text());
  const frame = (await response.text()).split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(frame.slice(6)).runId;
}
async function setLimits(next) {
  limits = { ...limits, ...next };
  const result = await api('/api/dimension/context-limits', { limits }, 'PUT');
  assert.deepEqual(result.limits, limits);
}
async function routes(simple = 'fixture-simple') {
  const settings = { enabled: true, routes: {
    simple: { providerId: 'synthetic', model: simple },
    standard: { providerId: 'synthetic', model: 'fixture-standard' },
    complex: { providerId: 'synthetic', model: 'fixture-complex' },
  } };
  await api('/api/dimension/work-models', { settings }, 'PUT');
}

try {
  child = spawn(executable, ['--data', dataDirectory, '--ui', ui, '--port', '0'], {
    cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    for (const line of stdout.split(/\r?\n/)) {
      try { const value = JSON.parse(line); if (value.ready) base = `http://127.0.0.1:${value.port}`; } catch {}
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  exitPromise = new Promise((resolve) => child.once('close', (code) => { exited = true; resolve(code); }));
  await until(() => { if (spawnError) throw spawnError; return base; }, 'native ready');

  await check('provision group, per-bot Chat models and separate Work routes', async () => {
    for (const [index, id] of bots.entries()) {
      await api('/api/dimension/bots', { id, name: `Synthetic Member ${index + 1}`, persona: 'Synthetic group test persona' });
      const roster = await api(`/api/dimension/bots/${id}/roster`, { mode: 'work', present: true }, 'PATCH');
      assert.equal(roster.bot.chat, true); assert.equal(roster.bot.work, true);
    }
    await api('/api/providers', { name: 'synthetic', entry: { kind: 'openai-chat-compat', baseUrl: fixture.baseUrl,
      spec: { model: 'fixture-flash', maxTokens: 4096 } }, secretValue: 'synthetic-key' });
    for (const [index, id] of bots.entries())
      await api(`/api/dimension/bots/${id}/conversation-model`, { modelSelection: { providerId: 'synthetic', model: `fixture-chat-${'abc'[index]}` } });
    await routes();
    groupId = (await api('/api/dimension/groups', { name: 'Synthetic Group', ownerId: bots[0], members: bots })).group.id;
    assert.ok(groupId);
  });

  await check('group Chat uses per-bot models with spaced turns and no thought output', async () => {
    const events = await groupSay('group_chat');
    const said = events.filter((event) => event.kind === 'say' && event.from !== 'user');
    assert.equal(said.length, 3);
    assert.equal(new Set(said.map((event) => event.from)).size, 3);
    for (let index = 1; index < said.length; ++index)
      assert.ok(said[index].receivedAt - said[index - 1].receivedAt >= 450, 'Group SSE replies arrived as one batch');
    const records = fixture.records.filter((record) => record.tag === 'group_chat');
    assert.equal(records.length, 3);
    assert.deepEqual(records.map((record) => record.body.model), ['fixture-chat-a', 'fixture-chat-b', 'fixture-chat-c']);
    for (let index = 1; index < records.length; ++index)
      assert.ok(records[index].started - records[index - 1].started >= 550, 'Group turns were sent simultaneously');
    const history = await api(`/api/dimension/groups/${groupId}?mode=chat&limit=99`);
    assert.equal(history.messages.length, 4);
    initialGroupMessageIds.push(...history.messages.map((message) => message.messageId));
    for (const bot of bots) assert.equal((await api(`/api/dimension/bots/${bot}/history?limit=99`)).messages.length, 0);
  });

  await check('group upstream failure emits an SSE error and preserves the user input', async () => {
    const events = await groupSay('group_error');
    assert.ok(events.some((event) => event.kind === 'error' && /HTTP error 502/.test(event.text)));
    const history = await api(`/api/dimension/groups/${groupId}?mode=chat&limit=99`);
    assert.ok(history.messages.some((message) => message.from === 'user' && message.text === 'APPTEST:group_error'));
  });

  await check('group Work delegates in parallel, enforces dependencies and delivers child artifacts through the parent', async () => {
    fixture.gate('group_child_a'); fixture.gate('group_child_b');
    const response = await fetch(base + `/api/dimension/groups/${groupId}/say`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'work', workBotId: bots[0], text: 'APPTEST:group_coordinator' }), signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const frame = (await response.text()).split('\n').find((line) => line.startsWith('data: '));
    parentRun = JSON.parse(frame.slice(6)).runId;
    const [a, b] = await Promise.all([fixture.pending('group_child_a'), fixture.pending('group_child_b')]);
    assert.equal(a.record.ended, null); assert.equal(b.record.ended, null);
    fixture.release('group_child_b');
    await until(async () => (await getRun(parentRun)).assignments.find((job) => job.jobId === 'job_b' && job.status === 'completed'), 'independent child B completed');
    await sleep(1100);
    assert.ok(!fixture.records.some((record) => record.tag === 'group_child_c'), 'Dependent job started before child A finished');
    fixture.release('group_child_a');
    const parent = await complete(parentRun);
    assert.equal(parent.answer, 'Verified group delivery');
    assert.equal(parent.assignments.length, 3);
    assert.ok(parent.assignments.every((job) => job.status === 'completed'));
    const coordinatorCalls = fixture.records.filter((record) => record.tag === 'group_coordinator');
    assert.ok(coordinatorCalls.length <= 8, `Long wait still caused rapid coordinator polling: ${coordinatorCalls.length}`);
    const coordinatorRecord = coordinatorCalls[0];
    const coordinatorTools = coordinatorRecord.body.tools.map((tool) => tool.function.name);
    assert.ok(coordinatorTools.includes('delegate_work') && coordinatorTools.includes('team_status'));
    for (const record of fixture.records.filter((record) => ['group_child_a', 'group_child_b', 'group_child_c'].includes(record.tag))) {
      const names = record.body.tools.map((tool) => tool.function.name);
      assert.ok(!names.includes('delegate_work') && !names.includes('team_status'));
    }
    const statusEvents = parent.events.filter((event) => event.kind === 'tool' && event.tool.name === 'team_status' && event.tool.status === 'completed');
    const finishEvent = parent.events.find((event) => event.kind === 'tool' && event.tool.name === 'task_finish' && event.tool.status === 'completed');
    assert.ok(statusEvents.length > 0 && finishEvent);
    const statusViews = statusEvents.map((event) => JSON.parse(event.tool.result));
    assert.ok(statusViews.some((view) => view.waitTimedOut && view.waitTimeoutCount >= 1));
    assert.ok(statusViews.every((view) => view.waitSecondsRequested === 1 && view.statusCallLimit === 512 && view.waitTimeoutLimit === 120));
    assert.equal(statusViews.at(-1).readyForSummary, true);
    assert.equal(statusViews.at(-1).waitBudgetExhausted, false);
    const finishArgs = JSON.parse(finishEvent.tool.args);
    assert.equal(finishArgs.artifacts.length, 3);
    assert.match(finishArgs.verification, /^team_status /);
    const childC = fixture.records.find((record) => record.tag === 'group_child_c');
    assert.ok(childC && JSON.stringify(childC.body).includes('Verified delivery group_child_a'), 'Dependency result was not passed to child C');
    const files = (await api(`/api/dimension/work/tasks/${parentRun}/artifacts`)).files;
    assert.equal(files.length, 3, 'Parent filtered out trusted child artifacts');
    const downloaded = new Set();
    for (const file of files) {
      assert.equal(file.available, true);
      const relative = path.relative(dataDirectory, file.path);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      const download = await fetch(base + file.url, { signal: AbortSignal.timeout(5000) });
      assert.equal(download.status, 200);
      assert.match(download.headers.get('content-security-policy'), /sandbox/);
      const text = await download.text();
      assert.equal(text, await readFile(file.path, 'utf8'));
      downloaded.add(text);
    }
    assert.deepEqual(downloaded, new Set(['group_child_a', 'group_child_b', 'group_child_c'].map(fixture.textFor)));
  });

  await check('Chat, Work ledger and private histories remain isolated', async () => {
    const discussion = await api(`/api/dimension/groups/${groupId}?mode=chat&limit=99`);
    assert.ok(discussion.messages.every((message) => !message.text.includes('group_coordinator') && !message.text.includes('Verified delivery')));
    const workHistory = await api(`/api/dimension/work/sessions?groupId=${groupId}&limit=50`);
    assert.equal(workHistory.runs.length, 4);
    assert.ok(workHistory.runs.every((run) => run.groupId === groupId && !run.text.includes('APPTEST:group_chat')));
    const workMessages = await api(`/api/dimension/groups/${groupId}?mode=work&limit=99`);
    assert.ok(workMessages.messages.every((message) => !message.text.includes('APPTEST:group_chat')));
    for (const bot of bots) assert.equal((await api(`/api/dimension/bots/${bot}/history?limit=99`)).messages.length, 0);
  });

  await check('failed member and blocked dependency produce an evidence-bound partial delivery', async () => {
    const id = await groupWork('group_partial_coordinator');
    const run = await terminal(id);
    assert.equal(run.status, 'partial', JSON.stringify({ status: run.status, error: run.error, answer: run.answer }));
    assert.match(run.answer, /部分交付/);
    const states = Object.fromEntries(run.assignments.map((job) => [job.jobId, job]));
    assert.equal(states.job_ok.status, 'completed');
    assert.equal(states.job_fail.status, 'failed');
    assert.equal(states.job_blocked.status, 'blocked');
    assert.equal(states.job_blocked.runId, '');
    assert.ok(!fixture.records.some((record) => record.tag === 'partial_child_c'));
    const finish = run.events.find((event) => event.kind === 'tool' && event.tool.name === 'task_finish' && event.tool.status === 'completed');
    const args = JSON.parse(finish.tool.args);
    assert.equal(args.deliveryMode, 'partial');
    assert.equal(args.artifacts.length, 1);
    assert.match(args.verification, /: partial 1\/3 /);
    const files = (await api(`/api/dimension/work/tasks/${id}/artifacts`)).files;
    assert.equal(files.length, 1);
    assert.equal(await readFile(files[0].path, 'utf8'), fixture.textFor('partial_child_a'));
    const notices = stdout.split(/\r?\n/).flatMap(line => {
      try { const value = JSON.parse(line); return value.notification ? [value.notification] : []; } catch { return []; }
    });
    assert.ok(notices.some(notification => notification.runId === id && notification.kind === 'partial' && notification.title === '部分交付'));
    assert.ok(!notices.some(notification => notification.runId === id && notification.kind === 'completed'));
  });

  await check('status-call budget exhaustion stops coordinator polling without losing the gated member', async () => {
    // Isolate the polling budget from unrelated context-compaction work.
    await setLimits({ work: 1048576, complex: 1048576 });
    fixture.gate('budget_child');
    const id = await groupWork('group_budget_coordinator');
    const run = await until(async () => {
      const value = await getRun(id); return value.terminal && !value.executing ? value : null;
    }, 'budget-exhausted coordinator', 600000);
    assert.equal(run.status, 'failed');
    assert.match(run.error, /unverified_text_completion/);
    const views = run.events.filter((event) => event.kind === 'tool' && event.tool.name === 'team_status' && event.tool.status === 'completed')
      .map((event) => JSON.parse(event.tool.result));
    assert.ok(views.at(-1).waitBudgetExhausted);
    assert.ok(views.at(-1).statusCallCount >= 512 && views.at(-1).statusCallCount <= 513);
    const coordinatorCalls = fixture.records.filter((record) => record.tag === 'group_budget_coordinator').length;
    assert.ok(coordinatorCalls >= 513 && coordinatorCalls <= 600, `Unexpected coordinator call count ${coordinatorCalls}`);
    const stoppedAt = fixture.records.length; await sleep(120);
    assert.equal(fixture.records.length, stoppedAt, 'Coordinator kept polling after budget exhaustion');
    const childId = run.assignments.find((job) => job.jobId === 'job_wait').runId;
    fixture.release('budget_child');
    await complete(childId);
    await setLimits({ work: 65536, complex: 131072 });
  });

  await check('removing a group member preserves historical messages and stops future turns', async () => {
    await api(`/api/dimension/groups/${groupId}`, { members: bots.slice(0, 2) }, 'PATCH');
    const after = await api(`/api/dimension/groups/${groupId}?mode=chat&limit=99`);
    for (const id of initialGroupMessageIds) assert.ok(after.messages.some((message) => message.messageId === id));
    const frames = await groupSay('group_after_remove');
    const speakers = frames.filter((event) => event.kind === 'say' && event.from !== 'user').map((event) => event.from);
    assert.deepEqual(speakers, bots.slice(0, 2));
    const retained = await api(`/api/dimension/groups/${groupId}?mode=chat&limit=99`);
    assert.ok(retained.messages.some((message) => message.from === bots[2] && message.text.includes('group_chat')));
  });

  await check('simple, standard and complex routes select real request models and updates apply to new runs', async () => {
    for (const [tag, extra, expected] of [
      ['route_simple', '', 'fixture-simple'], ['route_standard', ' 分析', 'fixture-standard'],
      ['route_complex', ' 架构', 'fixture-complex'],
    ]) {
      await complete(await work(tag, extra));
      const records = fixture.records.filter((record) => record.tag === tag);
      assert.ok(records.length >= 3); assert.ok(records.every((record) => record.body.model === expected));
    }
    await routes('fixture-next');
    await complete(await work('route_updated'));
    assert.ok(fixture.records.filter((record) => record.tag === 'route_updated').every((record) => record.body.model === 'fixture-next'));
  });

  await check('Work and complex limits reject oversized current turns before networking and accept them after an increase', async () => {
    await setLimits({ work: 8192, complex: 8192 });
    // Work uses the documented ceil(UTF-8 bytes / 4) heuristic, not one token per byte.
    for (const [tag, padding] of [['limit_work_low', 40000], ['limit_complex_low', 60000]]) {
      const id = await work(tag, ' ' + 'x'.repeat(padding));
      const run = await terminal(id);
      assert.equal(run.status, 'interrupted'); assert.match(run.error, /上下文/);
      assert.ok(run.text.includes('x'.repeat(padding)));
      assert.ok(!fixture.records.some((record) => record.tag === tag));
    }
    await setLimits({ work: 32768, complex: 32768 });
    await complete(await work('limit_work_high', ' ' + 'x'.repeat(5000)));
    await complete(await work('limit_complex_high', ' ' + 'x'.repeat(7000)));
    assert.ok(fixture.records.some((record) => record.tag === 'limit_work_high'));
    assert.ok(fixture.records.some((record) => record.tag === 'limit_complex_high'));
  });

  await check('group context limit yields explicit SSE failure and takes effect on subsequent calls', async () => {
    await setLimits({ group: 8192 });
    const low = await groupSay('group_limit_low', ' ' + 'g'.repeat(6000));
    assert.ok(low.some((event) => event.kind === 'error' && /上下文上限/.test(event.text)));
    assert.ok(!fixture.records.some((record) => record.tag === 'group_limit_low'));
    await setLimits({ group: 32768 });
    const high = await groupSay('group_limit_high', ' ' + 'g'.repeat(6000));
    assert.ok(!high.some((event) => event.kind === 'error'));
    assert.equal(high.filter((event) => event.kind === 'say' && event.from !== 'user').length, 2);
    assert.equal(fixture.records.filter((record) => record.tag === 'group_limit_high').length, 2);
  });

  await check('private Chat context limit fails without an upstream call and succeeds after an increase', async () => {
    const frames = [];
    chatSocket = new WebSocket(base.replace('http:', 'ws:') + '/ws/providers/world:console/panels/chat');
    chatSocket.addEventListener('message', (event) => frames.push(JSON.parse(event.data)));
    await new Promise((resolve, reject) => {
      chatSocket.addEventListener('open', resolve, { once: true });
      chatSocket.addEventListener('error', () => reject(new Error('Chat WebSocket open failed')), { once: true });
    });
    chatSocket.send(JSON.stringify({ type: 'hello', botId: bots[0] }));
    await setLimits({ chat: 8192 });
    chatSocket.send(JSON.stringify({ type: 'msg', botId: bots[0], requestId: 'chat-limit-low', text: 'APPTEST:chat_limit_low ' + 'c'.repeat(6000) }));
    const failure = await until(() => frames.find((frame) => frame.type === 'request.error'), 'Chat limit failure');
    assert.match(failure.text, /上下文上限/);
    assert.ok(!fixture.records.some((record) => record.tag === 'chat_limit_low'));
    await setLimits({ chat: 32768 });
    chatSocket.send(JSON.stringify({ type: 'msg', botId: bots[0], requestId: 'chat-limit-high', text: 'APPTEST:chat_limit_high ' + 'c'.repeat(6000) }));
    await until(() => frames.some((frame) => frame.text === 'Chat reply chat_limit_high 🙂'), 'Chat after limit increase');
    assert.ok(fixture.records.some((record) => record.tag === 'chat_limit_high' && record.body.model === 'fixture-chat-a'));
    const history = await api(`/api/dimension/bots/${bots[0]}/history?limit=99`);
    assert.ok(history.messages.some((message) => message.text.startsWith('APPTEST:chat_limit_low')));
  });

  await check('all group fixtures stayed isolated and credential-free', async () => {
    assert.equal(fixture.errors.length, 0, fixture.errors.join('\n'));
    assert.ok(!stdout.includes('synthetic-key') && !stderr.includes('synthetic-key'));
    assert.ok(!(await readFile(path.join(dataDirectory, 'settings.json'), 'utf8')).includes('synthetic-key'));
    const providers = await api('/api/providers');
    assert.ok(!JSON.stringify(providers).includes('protectedKey'));
  });
} catch (error) {
  if (!failures.length) failures.push(scrub(error.stack ?? error));
  process.exitCode = 1;
} finally {
  if (chatSocket) chatSocket.close();
  if (child && !exited) {
    child.stdin.end('shutdown\n');
    const timer = setTimeout(() => child.kill(), 10000);
    const code = await exitPromise;
    clearTimeout(timer);
    if (code !== 0) { failures.push(`Native exit code ${code}`); process.exitCode = 1; }
  }
  await fixture.close();
  const report = { passed: tests.filter((test) => test.passed).length, failed: failures.length,
    tests, failures, fixtureErrors: fixture.errors, dataDirectory, groupId, parentRun, executable,
    fingerprints, processes: child ? [{ pid: child.pid, exitCode: child.exitCode, signal: child.signalCode }] : [],
    network: 'ephemeral IPv4 loopback only', readProductionData: false,
    requests: fixture.records.map((record) => ({ tag: record.tag, model: record.body.model, started: record.started,
      ended: record.ended, aborted: record.aborted, work: record.work })) };
  await writeFile(path.join(directory, 'native.stdout.log'), scrub(stdout));
  await writeFile(path.join(directory, 'native.stderr.log'), scrub(stderr));
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(output, 'group-integration-result.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`GROUP_INTEGRATION_RESULT passed=${report.passed} failed=${report.failed} directory=${directory}\n`);
}
