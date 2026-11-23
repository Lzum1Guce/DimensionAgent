// Original synthetic HTTP/native integration. Never reads installed task data.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { startNative, until, digest } from './archive-export-api.mjs';

const project = path.resolve(import.meta.dirname, '..');
const output = path.join(project, 'outputs/work-compaction', 'api-' + Date.now());
await mkdir(path.join(output, 'temp'), { recursive: true });
const data = path.join(output, 'data'), processes = [], traces = [], checks = [], failures = [];
const bot = 'synthetic-compaction-bot', provider = 'synthetic-compaction-provider';
const states = new Map(), requests = [], errors = [], sockets = new Set();
let app;
const send = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
const server = http.createServer(async (req, res) => {
  req.on('error', () => {}); res.on('error', () => {});
  try {
    assert.equal(req.headers.authorization, 'Bearer synthetic-compaction-key');
    let raw = ''; for await (const chunk of req) { raw += chunk; assert(Buffer.byteLength(raw) < 32 * 1024 * 1024); }
    const body = JSON.parse(raw);
    const tag = body.messages.map(row => /COMPACT_TEST:(auto|overflow)/.exec(row.content || '')?.[1]).findLast(Boolean);
    assert(tag, 'Original task marker remains available');
    const state = states.get(tag) || { step: 0, summaries: 0, overflow: 0, normal: 0 };
    states.set(tag, state);
    const summary = !body.tools?.length;
    requests.push({ tag, summary, maxTokens: body.max_tokens, bytes: Buffer.byteLength(raw), model: body.model });
    if (summary) {
      state.summaries++;
      assert(state.summaries <= 2, 'Bounded compaction');
      send(res, { choices: [{ index: 0, message: { content: '历史摘要：已按用户要求创建合成文件，正在核验；保留尚未完成的验收步骤。不要重复写入文件。' }, finish_reason: 'stop' }] });
      return;
    }
    state.normal++;
    assert(state.normal <= 6, 'No retry loop');
    if (tag === 'overflow' && state.step === 3 && !state.overflow) {
      state.overflow++;
      send(res, { error: { code: 'context_length_exceeded', message: 'Maximum context length exceeded' } }, 400);
      return;
    }
    const results = body.messages.filter(row => row.role === 'tool').map(row => {
      try { return JSON.parse(row.content); } catch { return {}; }
    });
    const file = 'compaction/' + tag + '.txt', content = 'Verified synthetic compaction artifact ' + tag;
    let name, args;
    if (state.step === 0) { name = 'write_file'; args = { path: file, content }; }
    else if (state.step === 1) { name = 'read_file'; args = { path: file }; }
    else if (state.step === 2) { name = 'verify_file'; args = { path: file, expected: content }; }
    else {
      const proof = results.findLast(row => row.verification && !row.error);
      assert(proof, 'Recent complete verification exchange remains exact');
      name = 'task_finish'; args = { summary: 'Verified synthetic task completed after context compaction', artifacts: proof.artifacts, verification: proof.verification };
    }
    const step = state.step++;
    send(res, { choices: [{ index: 0, message: { content: name === 'task_finish' ? '' : 'x'.repeat(28000), tool_calls: [{
      id: tag + '-' + step, type: 'function', function: { name, arguments: JSON.stringify(args) },
    }] }, finish_reason: 'tool_calls' }] });
  } catch (error) {
    errors.push(error.stack);
    if (!res.headersSent) send(res, { error: { message: 'Synthetic assertion failed' } }, 500);
    else res.end();
  }
});
server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const defaultExe = existsSync(path.join(project, 'build/DImensionagent-native.exe'))
  ? path.join(project, 'build/DImensionagent-native.exe')
  : path.join(project, 'outputs/build/DImensionagent-native.exe');
const executable = defaultExe;
const config = { executable, ui: path.join(project, 'ui'), data, output, processes, traces };
const saved = [];
try {
  app = await startNative({ ...config, label: 'native' });
  await app.api('/api/dimension/bots', { id: bot, name: 'Synthetic context test', mode: 'work' });
  await app.api('/api/dimension/bots/' + bot + '/roster', { mode: 'work', present: true }, 'PATCH');
  await app.api('/api/providers', { name: provider, entry: { kind: 'openai-chat-compat', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, spec: { model: 'synthetic', maxTokens: 8192 } }, secretValue: 'synthetic-compaction-key' });
  await app.api('/api/dimension/work/settings', { botId: bot, approvalMode: 'auto', cliEngine: 'builtin' }, 'PATCH');
  for (const tag of ['auto', 'overflow']) {
    const window = tag === 'auto' ? 32768 : 1048576;
    await app.api('/api/dimension/context-limits', { limits: { chat: 32768, group: 32768, work: window, complex: window } }, 'PUT');
    const created = await app.api('/api/dimension/work/runs', { botId: bot, text: 'COMPACT_TEST:' + tag + ' Create and verify the synthetic artifact.', requestId: 'compaction-' + tag });
    const id = created.run.id;
    const run = await until(async () => {
      const value = await app.api('/api/dimension/work/runs/' + id);
      return value.terminal && !value.executing ? value : null;
    }, 'synthetic task settled', 60000);
    assert.equal(run.status, 'completed', JSON.stringify({ status: run.status, error: run.error, fixtureErrors: errors }));
    assert(states.get(tag).summaries >= 1, 'Actual extra summary model request occurred');
    assert.equal(states.get(tag).overflow, tag === 'overflow' ? 1 : 0);
    const snapshotFile = path.join(data, 'work-runs/runs', id, 'snapshot.json');
    const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8'));
    assert.equal(snapshot.messages.filter(row => row.role === 'assistant' && row.content === 'x'.repeat(28000)).length, 3, 'Original uncompressed model messages remain saved');
    const writes = snapshot.tools.filter(row => row.call.name === 'write_file');
    assert.equal(writes.length, 1, 'Compaction/overflow cannot replay a write');
    assert.equal(writes[0].state, 'finished');
    assert.equal(run.artifacts.length, 1);
    assert.equal(await readFile(run.artifacts[0], 'utf8'), 'Verified synthetic compaction artifact ' + tag);
    const source = await readFile(snapshotFile); saved.push({ id, snapshotFile, source });
    checks.push(tag === 'auto' ? 'Automatic pressure invokes a real summary HTTP request; original messages, recent verification and single write receipt survive' : 'Confirmed provider overflow compacts and retries once, completes with real executor evidence and no duplicate write');
  }
  const before = requests.length;
  await app.stop(); app = await startNative({ ...config, label: 'native-restart' });
  for (const item of saved) {
    const run = await app.api('/api/dimension/work/runs/' + item.id);
    assert.equal(run.status, 'completed');
    assert.deepEqual(await readFile(item.snapshotFile), item.source);
  }
  assert.equal(requests.length, before);
  checks.push('Restart restores compressed-state snapshots without new model requests or changes to original evidence');
  assert.deepEqual(errors, []);
} catch (error) { failures.push(error.stack); process.exitCode = 1; }
finally {
  if (app?.child.exitCode === null) await app.stop().catch(error => { failures.push(error.stack); process.exitCode = 1; });
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
  for (const row of processes) await writeFile(path.join(output, row.label + '.log'), row.stdout + '\nSTDERR\n' + row.stderr);
  const report = { passed: !failures.length, checks, failures, errors, requests, nativeSha256: digest(await readFile(executable)), productionDataUsed: false };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checks, failures, output }));
}
