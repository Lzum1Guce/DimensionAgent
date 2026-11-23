import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixture } from './app-integration.mjs';
import { startNative, until, delay } from './archive-export-api.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  assert(process.argv[i]?.startsWith('--') && process.argv[i + 1], 'Use --name value pairs');
  options.set(process.argv[i].slice(2), process.argv[i + 1]);
}
const executable = path.resolve(options.get('executable') ?? path.join(project, 'outputs/build/DImensionagent-native.exe'));
const ui = path.resolve(options.get('ui') ?? path.join(project, 'ui'));
const outputRoot = path.resolve(options.get('output') ?? path.join(project, 'outputs/approvals-api'));
assert(path.isAbsolute(outputRoot) && outputRoot !== path.parse(outputRoot).root, 'Synthetic output must be a non-root absolute directory');
await mkdir(outputRoot, { recursive: true });
const output = await mkdtemp(path.join(outputRoot, 'run-'));
const data = path.join(output, 'data'), workspace = path.join(output, 'manual-project');
await Promise.all([mkdir(path.join(output, 'temp')), mkdir(workspace)]);
const processes = [], traces = [], tests = [], failures = [];
const fixture = await startFixture();
const bulk = await startBulkFixture();
let app;
const bot = 'approval-fixture-alpha', other = 'approval-fixture-beta';
const absent = async file => { try { await stat(file); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } };
const pendingPath = id => '/api/dimension/work/pending/' + encodeURIComponent(id);
const runPath = id => '/api/dimension/work/runs/' + encodeURIComponent(id);
const terminal = run => ['completed', 'interrupted', 'cancelled', 'failed'].includes(run.status);
const api = (...args) => app.api(...args);
const record = (id, botId = bot) => api(pendingPath(id) + '?botId=' + encodeURIComponent(botId));
const pending = async (runId, name) => {
  const rows = (await api('/api/dimension/work/pending?botId=' + bot)).pending;
  return rows.find(row => (!runId || row.runId === runId) && (!name || row.tool === name));
};
const waitPending = (runId, name) => until(() => pending(runId, name), 'pending approval ' + name);
const decide = (id, allow, botId = bot, expected = 200) =>
  api(pendingPath(id) + '/decision', { botId, allow }, 'POST', expected);
const setMode = (approvalMode, botId = bot) =>
  api('/api/dimension/work/settings', { botId, approvalMode }, 'PATCH');
const submit = async (tag, requestId = 'submit-' + tag, botId = bot) => {
  const result = await api('/api/dimension/work/runs', { botId, text: 'APPTEST:' + tag, requestId });
  return result;
};
const savedFile = (runId, tag) => path.join(data, 'workspaces', runId, fixture.pathFor(tag));
async function startBulkFixture() {
  const errors = [], records = [], steps = new Map(), sockets = new Set();
  const textFor = (mode, index) => `SYNTHETIC_BULK_${mode}_${index} 猫🙂\n`;
  const pathFor = (mode, index) => `bulk/${mode}-${index}.txt`;
  const server = http.createServer(async (req, res) => {
    req.on('error', () => {}); res.on('error', () => {});
    try {
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers.authorization, 'Bearer synthetic-key');
      let bytes = '';
      for await (const chunk of req) { bytes += chunk; assert(Buffer.byteLength(bytes) <= 4 * 1024 * 1024); }
      const body = JSON.parse(bytes);
      assert.equal(body.model, 'fixture-bulk'); assert.equal(body.stream, true);
      const tag = body.messages.filter(message => message.role === 'user')
        .map(message => /APPTEST:(approval_bulk_(auto|full))/.exec(String(message.content)))
        .filter(Boolean).at(-1);
      assert(tag, 'Bulk fixture requires its synthetic task tag');
      const mode = tag[2], step = steps.get(mode) ?? 0;
      steps.set(mode, step + 1);
      assert(step < 22, 'Bulk fixture exceeded its deterministic tool rounds');
      let calls;
      if (step < 20) {
        calls = Array.from({ length: 16 }, (_, offset) => {
          const index = step * 16 + offset;
          return { name: 'write_file', args: { path: pathFor(mode, index), content: textFor(mode, index) } };
        });
      } else if (step === 20) {
        calls = [{ name: 'verify_file', args: { path: pathFor(mode, 319), expected: textFor(mode, 319) } }];
      } else {
        const verified = body.messages.filter(message => message.role === 'tool')
          .map(message => JSON.parse(message.content)).findLast(execution => !execution.error && execution.verification);
        assert(verified?.artifacts?.length, 'Bulk finish must copy real executor verification');
        calls = [{ name: 'task_finish', args: { summary: `Verified 320 ${mode} writes`,
          artifacts: verified.artifacts, verification: verified.verification } }];
      }
      records.push({ mode, step, tools: calls.map(call => call.name) });
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      const event = value => `data: ${JSON.stringify(value)}\n\n`;
      res.write(event({ choices: [{ index: 0, delta: { tool_calls: calls.map((call, index) => ({
        index, id: `bulk-${mode}-${step}-${index}`, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })) }, finish_reason: null }] }));
      res.end(event({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
    } catch (error) {
      errors.push(String(error.stack ?? error).replaceAll('synthetic-key', '[redacted]'));
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      if (!res.destroyed) res.end('{"error":{"message":"Synthetic bulk fixture assertion failed"}}');
    }
  });
  server.on('connection', socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, records, errors, textFor, pathFor,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
async function finishApproved(runId) {
  for (let rounds = 0; rounds < 12; ++rounds) {
    const value = await api(runPath(runId));
    if (terminal(value)) { assert.equal(value.status, 'completed', JSON.stringify(value)); return value; }
    const waiting = await pending(runId);
    if (waiting) await decide(waiting.id, true);
    await delay(25);
  }
  return until(async () => {
    const value = await api(runPath(runId));
    if (value.status === 'completed') return value;
    const waiting = await pending(runId);
    if (waiting) await decide(waiting.id, true);
    return false;
  }, 'completed approved task');
}
async function sseApproval(runId) {
  return new Promise((resolve, reject) => {
    let text = '', done = false;
    const request = http.get(app.origin + runPath(runId) + '/events', response => {
      response.setEncoding('utf8');
      response.on('data', chunk => {
        text += chunk;
        for (const block of text.split('\n\n')) {
          const line = block.split('\n').find(row => row.startsWith('data: '));
          if (!line) continue;
          let value; try { value = JSON.parse(line.slice(6)); } catch { continue; }
          if (value.kind === 'approval' && value.pending === true && value.botId === bot) {
            done = true; response.destroy(); request.destroy(); resolve(value); return;
          }
        }
      });
      response.on('error', error => { if (!done) reject(error); });
    });
    request.on('error', error => { if (!done) reject(error); });
    request.setTimeout(10000, () => request.destroy(Error('Approval SSE timeout')));
  });
}
async function check(name, fn) {
  const started = Date.now();
  try { await fn(); tests.push({ name, passed: true, milliseconds: Date.now() - started }); console.log('PASS ' + name); }
  catch (error) { tests.push({ name, passed: false, detail: String(error.stack ?? error) }); throw error; }
}
try {
  app = await startNative({ label: 'approvals-first', executable, ui, data, output, processes, traces });
  await check('synthetic providers, work rosters, and persisted UI mode', async () => {
    for (const id of [bot, other])
      await api('/api/dimension/bots', { id, name: 'Synthetic ' + id, mode: 'work' });
    await api('/api/providers', { name: 'approval-fixture', entry: { kind: 'openai-chat-compat',
      baseUrl: fixture.baseUrl, spec: { model: 'fixture-flash' } }, secretValue: 'synthetic-key' });
    await api('/api/dimension/bots/' + bot + '/activate', {});
    const setting = await api('/api/dimension/work/settings',
      { botId: bot, approvalMode: 'ask', projectCwd: workspace }, 'PATCH');
    assert.equal(setting.settings.approvalMode, 'ask');
    const boot = await api('/api/dimension/bootstrap');
    assert.equal(boot.approvalMode, 'ask'); assert.equal(boot.workSettings.approvalMode, 'ask');
    assert.equal(path.resolve(boot.workSettings.projectCwd), workspace);
  });
  await check('new attachment planning has no effect; deny and cross-Bot approval are safe', async () => {
    const planned = await api('/api/dimension/work/attachments', { botId: bot, name: 'denied.txt', content: 'SYNTH_DENIED' });
    assert.equal(planned.plannedOnly, true); assert(await absent(path.join(workspace, planned.path)));
    const result = await api('/api/dimension/work/tools',
      { botId: bot, tool: 'write', path: planned.path, content: 'SYNTH_DENIED', requestId: 'manual-deny' });
    assert.equal(result.pending, true);
    const item = await record(result.approvalId);
    assert.equal(item.state, 'pending'); assert.equal(item.highRisk, true);
    assert.match(item.argumentsDigest, /^[a-f0-9]{64}$/);
    await decide(item.id, true, other, 404);
    await api(pendingPath(item.id) + '/decision', { botId: bot, allow: 'yes' }, 'POST', 400);
    await decide(item.id, false); await decide(item.id, false);
    await decide(item.id, true, bot, 409);
    assert.equal((await record(item.id)).state, 'rejected');
    assert(await absent(path.join(workspace, planned.path)));
  });
  await check('manual approved write is real and request retry does not rewrite', async () => {
    const planned = await api('/api/dimension/work/attachments', { botId: bot, name: 'accepted.txt', content: 'SYNTH_ACCEPTED 猫🙂' });
    const input = { botId: bot, tool: 'write', path: planned.path, content: 'SYNTH_ACCEPTED 猫🙂', requestId: 'manual-accept' };
    const result = await api('/api/dimension/work/tools', input);
    assert.equal(result.pending, true); assert(await absent(path.join(workspace, planned.path)));
    await decide(result.approvalId, true);
    const complete = await until(async () => (await record(result.approvalId)).result, 'manual durable outcome');
    assert.equal(complete.ok, true);
    const file = path.join(workspace, planned.path);
    assert.equal(await readFile(file, 'utf8'), input.content);
    assert.deepEqual((await readdir(path.dirname(file))).filter(name => name.startsWith(path.basename(file))), [path.basename(file)]);
    const before = await stat(file);
    const repeated = await api('/api/dimension/work/tools', input);
    assert.equal(repeated.approvalId, result.approvalId);
    assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
    await api('/api/dimension/work/tools', { ...input, path: 'changed.txt' }, 'POST', 409);
  });
  await check('full permits explicit write; auto still waits for project-root write', async () => {
    await setMode('full');
    const result = await api('/api/dimension/work/tools',
      { botId: bot, tool: 'write', path: 'full.txt', content: 'SYNTH_FULL', requestId: 'manual-full' });
    assert.equal(result.ok, true); assert.equal(result.pending, false);
    assert.equal(await readFile(path.join(workspace, 'full.txt'), 'utf8'), 'SYNTH_FULL');
    await setMode('auto');
    const high = await api('/api/dimension/work/tools',
      { botId: bot, tool: 'write', path: 'auto-high.txt', content: 'SYNTH_HIGH', requestId: 'manual-auto-high' });
    assert.equal(high.pending, true);
    await decide(high.approvalId, false);
    assert(await absent(path.join(workspace, 'auto-high.txt')));
    await api('/api/dimension/work/tools',
      { botId: bot, tool: 'write', path: '../outside.txt', content: 'escape' }, 'POST', 400);
    await api('/api/dimension/work/tools',
      { botId: bot, tool: 'exec', command: 'must-not-run' }, 'POST', 400);
  });
  await check('auto allows low-risk isolated model tools without pending approval', async () => {
    const tag = 'approval_auto';
    const { run } = await submit(tag);
    await until(async () => (await api(runPath(run.id))).status === 'completed', 'auto task complete');
    assert.equal(await readFile(savedFile(run.id, tag), 'utf8'), fixture.textFor(tag));
    assert.equal((await api('/api/dimension/work/pending?botId=' + bot)).pending.length, 0);
  });
  await check('auto and full each execute 320 real writes without consuming approval capacity', async () => {
    const previousLimits = (await api('/api/dimension/context-limits')).limits;
    await api('/api/dimension/context-limits', { limits: { ...previousLimits, work: 1048576 } }, 'PUT');
    await api('/api/providers', { name: 'approval-bulk', entry: { kind: 'openai-chat-compat',
      baseUrl: bulk.baseUrl, spec: { model: 'fixture-bulk' } }, secretValue: 'synthetic-key' });
    await api('/api/providers/approval-bulk/activate', {});
    try {
      for (const mode of ['auto', 'full']) {
        await setMode(mode);
        const snapshotPath = path.join(data, 'approvals', 'approvals.json');
        const before = await readFile(snapshotPath, 'utf8');
        const { run } = await submit('approval_bulk_' + mode);
        const complete = await until(async () => {
          const value = await api(runPath(run.id));
          if (terminal(value) && value.status !== 'completed')
            throw Object.assign(Error('Bulk task ended unexpectedly: ' + JSON.stringify(value)), { fatal: true });
          return value.status === 'completed' ? value : false;
        }, '320 real ' + mode + ' writes complete', 60000);
        assert.equal(complete.artifacts.length, 320);
        const actual = path.join(data, 'workspaces', run.id, 'bulk');
        assert.equal((await readdir(actual)).length, 320);
        await Promise.all(Array.from({ length: 320 }, async (_, index) => {
          const file = path.join(data, 'workspaces', run.id, bulk.pathFor(mode, index));
          assert.equal(await readFile(file, 'utf8'), bulk.textFor(mode, index));
        }));
        assert.equal(await readFile(snapshotPath, 'utf8'), before, 'Automatic calls must not create approval records');
        assert.deepEqual((await readdir(path.dirname(snapshotPath))).filter(name => name.startsWith('approvals.json')), ['approvals.json']);
        assert.equal((await api('/api/dimension/work/pending?botId=' + bot)).pending.length, 0);
        const requests = bulk.records.filter(record => record.mode === mode);
        assert.equal(requests.length, 22);
        assert.equal(requests.flatMap(record => record.tools).filter(name => name === 'write_file').length, 320);
      }
    } finally {
      await api('/api/providers/approval-fixture/activate', {});
      await api('/api/dimension/context-limits', { limits: previousLimits }, 'PUT');
    }
  });
  await check('ask exposes SSE and waiting state, then consumes each tool once', async () => {
    await setMode('ask');
    const tag = 'approval_yes';
    const { run } = await submit(tag);
    const first = await waitPending(run.id, 'write_file');
    assert(await absent(savedFile(run.id, tag)));
    assert.equal((await api(runPath(run.id))).status, 'waiting-approval');
    const event = await sseApproval(run.id);
    assert.equal(event.approvalId, first.id);
    assert.equal((await record(first.id)).state, 'pending', 'Observer disconnect must not cancel the gate');
    await decide(first.id, true);
    const second = await waitPending(run.id, 'verify_file');
    assert.notEqual(second.id, first.id);
    const before = await stat(savedFile(run.id, tag));
    await decide(first.id, true);
    assert.equal((await stat(savedFile(run.id, tag))).mtimeMs, before.mtimeMs);
    await decide(second.id, true);
    await until(async () => (await api(runPath(run.id))).status === 'completed', 'ask task complete');
    assert.equal((await record(first.id)).consumed, true);
  });
  await check('model rejection pauses without writing', async () => {
    const tag = 'approval_no';
    const { run } = await submit(tag);
    const item = await waitPending(run.id, 'write_file');
    await decide(item.id, false);
    await until(async () => (await api(runPath(run.id))).status === 'interrupted', 'rejected task pause');
    assert(await absent(savedFile(run.id, tag)));
    assert.equal((await record(item.id)).state, 'rejected');
  });
  await check('stop cancels waiting approval and later allow cannot execute', async () => {
    const tag = 'approval_stop';
    const { run } = await submit(tag);
    const item = await waitPending(run.id, 'write_file');
    await api(runPath(run.id) + '/cancel', {});
    await until(async () => (await api(runPath(run.id))).status === 'cancelled', 'stopped task');
    assert.equal((await record(item.id)).state, 'cancelled');
    await decide(item.id, true, bot, 409);
    assert(await absent(savedFile(run.id, tag)));
  });
  await check('steer cancels even non-desktop gate, then new input can be approved', async () => {
    const oldTag = 'approval_steer_old', newTag = 'approval_steer_new';
    const { run } = await submit(oldTag);
    const old = await waitPending(run.id, 'write_file');
    const changed = await submit(newTag);
    assert.equal(changed.run.id, run.id); assert.equal(changed.supplemented, true);
    const current = await until(async () => {
      const item = await pending(run.id, 'write_file');
      return item && item.id !== old.id ? item : false;
    }, 'new-generation approval');
    assert.notEqual(current.argumentsDigest, old.argumentsDigest);
    assert.equal((await record(old.id)).state, 'cancelled');
    await decide(old.id, true, bot, 409);
    assert(await absent(savedFile(run.id, oldTag)));
    await finishApproved(run.id);
    assert.equal(await readFile(savedFile(run.id, newTag), 'utf8'), fixture.textFor(newTag));
    assert(await absent(savedFile(run.id, oldTag)));
  });
  await check('crash recovery makes pending authority stale; explicit resume creates new authority', async () => {
    const tag = 'approval_crash';
    const { run } = await submit(tag);
    const old = await waitPending(run.id, 'write_file');
    app.intentionalCrash = true;
    assert(app.child.kill(), 'Only kill this fixture-owned native child');
    await until(() => app.child.exitCode !== null || app.child.signalCode !== null, 'fixture child exit');
    app = await startNative({ label: 'approvals-restarted', executable, ui, data, output, processes, traces });
    assert.equal((await record(old.id)).state, 'stale');
    await decide(old.id, true, bot, 409);
    assert.equal((await api('/api/dimension/work/pending?botId=' + bot)).pending.length, 0);
    assert.equal((await api('/api/dimension/bootstrap')).approvalMode, 'ask');
    assert(await absent(savedFile(run.id, tag)));
    const resumedTag = 'approval_after_restart';
    const resumed = await api(runPath(run.id) + '/resume',
      { text: 'APPTEST:' + resumedTag, requestId: 'explicit-resume-after-crash' });
    assert.equal(resumed.run.attempt, 2);
    const fresh = await waitPending(run.id, 'write_file');
    assert.equal(fresh.attempt, 2); assert.notEqual(fresh.id, old.id);
    await finishApproved(run.id);
    assert.equal(await readFile(savedFile(run.id, resumedTag), 'utf8'), fixture.textFor(resumedTag));
    assert(await absent(savedFile(run.id, tag)));
  });
} catch (error) {
  failures.push(String(error.stack ?? error)); process.exitCode = 1;
} finally {
  for (const entry of processes) {
    try { if (!entry.intentionalCrash) await entry.stop(); }
    catch (error) { failures.push(String(error.stack ?? error)); process.exitCode = 1; }
    await writeFile(path.join(output, entry.label + '.log'), entry.stdout + '\nSTDERR\n' + entry.stderr);
  }
  await fixture.close();
  await bulk.close();
  if (fixture.errors.length) { failures.push(...fixture.errors); process.exitCode = 1; }
  if (bulk.errors.length) { failures.push(...bulk.errors); process.exitCode = 1; }
  const report = { passed: tests.filter(test => test.passed).length, failed: failures.length, tests, failures,
    output, data, manualWorkspace: workspace, traces, processes: processes.map(entry => ({
      pid: entry.child.pid, label: entry.label, intentionalCrash: Boolean(entry.intentionalCrash),
      exitCode: entry.child.exitCode, signal: entry.child.signalCode,
    })), modelRequests: fixture.records.length, bulkModelRequests: bulk.records,
    scope: 'Only explicit synthetic output, native child processes and IPv4 loopback model fixture; no real provider/account/WSL/old attachments.' };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, output }));
}

