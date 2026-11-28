import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startNative, until } from './archive-export-api.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  assert(process.argv[i]?.startsWith('--') && process.argv[i + 1]);
  options.set(process.argv[i].slice(2), process.argv[i + 1]);
}
const executable = path.resolve(options.get('executable') ?? path.join(project, 'outputs/build/DImensionagent-native.exe'));
const ui = path.resolve(options.get('ui') ?? path.join(project, 'ui'));
const outputRoot = path.resolve(options.get('output') ?? path.join(project, 'outputs/model-policy-api'));
assert.match(outputRoot, /^L:[\\/]/i);
await mkdir(outputRoot, { recursive: true });
const output = await mkdtemp(path.join(outputRoot, 'run-')), data = path.join(output, 'data');
await mkdir(path.join(output, 'temp'));
const processes = [], traces = [], tests = [], failures = [];
const fixture = await startFixture();
const bot = 'model-policy-fixture', provider = 'policy-primary';
let app, persisted;
const api = (...args) => app.api(...args);
const runPath = id => '/api/dimension/work/runs/' + encodeURIComponent(id);
const route = model => ({ providerId: provider, model });
const plan = (enabled = true, higher = true) => ({ enabled, routes: {
  simple: route('small'), standard: higher ? route('middle') : null, complex: higher ? route('large') : null,
} });
const setPlan = value => api('/api/dimension/work-models', value, 'PUT');
const upgrades = run => run.events.filter(event => event.routeReason);
const requests = tag => fixture.requests.filter(request => request.tag === tag);
const submit = async tag => (await api('/api/dimension/work/runs', { botId: bot, text: '直接做，不用先出计划：APPTEST:' + tag, requestId: tag })).run;
const contexts = work => ({ chat: 32768, group: 32768, work, complex: work });
// Reconstruct the conservative native input reservation from the actual wire
// request, including tool definitions/results, rather than assuming half a window.
function inputReserve(body) {
  const bytes = value => Buffer.byteLength(value || '', 'utf8');
  let total = 512;
  for (const tool of body.tools || []) {
    const value = tool.function;
    total += Math.ceil((bytes(value.name) + bytes(value.description) + bytes(JSON.stringify(value.parameters)) + 32) / 4);
  }
  for (const message of body.messages) {
    assert.equal(typeof message.content, 'string');
    let messageBytes = bytes(message.content) + bytes(message.role) + bytes(message.tool_call_id) + 32;
    for (const call of message.tool_calls || [])
      messageBytes += bytes(call.id) + bytes(call.function.name) + bytes(call.function.arguments) + 32;
    total += Math.ceil(messageBytes / 4);
  }
  return total;
}
async function settled(id, expected = 'completed') {
  const value = await until(async () => {
    const value = await api(runPath(id));
    return ['completed', 'failed', 'cancelled', 'interrupted'].includes(value.status) ? value : false;
  }, 'policy run terminal');
  assert.equal(value.status, expected, JSON.stringify(value));
  return value;
}
function checkedFixtureFile(file) {
  const relative = path.relative(output, file);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Only inspect this synthetic output');
  return file;
}
async function check(name, fn) {
  const started = Date.now();
  try { await fn(); tests.push({ name, passed: true, milliseconds: Date.now() - started }); console.log('PASS ' + name); }
  catch (error) { tests.push({ name, passed: false, detail: String(error.stack ?? error) }); throw error; }
}
async function startFixture() {
  const sockets = new Set(), errors = [], requests = [], catalogs = [], steps = new Map(), pending = new Map();
  const state = { mode: 'ready', models: ['small', 'middle', 'large'], requests, catalogs, errors, pending };
  const textFor = tag => `SYNTHETIC_POLICY_${tag} 猫🙂\n`;
  const pathFor = tag => `policy/${tag}.txt`;
  const failure = (res, status = 503) => {
    if (res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"synthetic-secret-must-not-leak"}}');
  };
  const tool = (res, tag, step, name, args) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = value => `data: ${JSON.stringify(value)}\n\n`;
    res.end(event({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, type: 'function',
      id: `${tag}-${step}`, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }) +
      event({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
  };
  const server = http.createServer(async (req, res) => {
    req.on('error', () => {}); res.on('error', () => {});
    try {
      assert.equal(req.headers.authorization, 'Bearer synthetic-policy-key');
      if (req.method === 'GET' && ['/v1/models', '/responses/v1/models'].includes(req.url)) {
        catalogs.push({ url: req.url, mode: state.mode });
        if (state.mode === 'timeout') return;
        if (state.mode === 'unsupported') return failure(res, 404);
        if (state.mode === 'auth') return failure(res, 401);
        if (state.mode === 'redirect') {
          res.writeHead(302, { Location: '/must-not-follow' }); res.end(); return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (state.mode === 'malformed') res.end('{"synthetic-secret-must-not-leak":');
        else if (state.mode === 'oversized') res.end(' '.repeat(1024 * 1024 + 1));
        else res.end(JSON.stringify({ object: 'list', data: state.models.map(id => ({ id, ignored: 'provider-only-metadata' })) }));
        return;
      }
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions');
      let bytes = '';
      for await (const chunk of req) { bytes += chunk; assert(Buffer.byteLength(bytes) <= 4 * 1024 * 1024); }
      const body = JSON.parse(bytes);
      const tag = body.messages.filter(message => message.role === 'user')
        .map(message => /APPTEST:(policy_[a-z_]+)/.exec(String(message.content))?.[1]).filter(Boolean).at(-1);
      if (!tag || (!body.tools?.length && tag !== 'policy_budget_chat')) {
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({choices: [{message: {content: 'OK'}, finish_reason: 'stop'}]}));
        return;
      }
      assert(['small', 'middle', 'large'].includes(body.model));
      const step = steps.get(tag) ?? 0; steps.set(tag, step + 1);
      assert(step < 10);
      const results = body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
      const record = { tag, step, model: body.model, maxTokens: body.max_tokens, inputReserve: inputReserve(body), artifacts: results.flatMap(result => result.artifacts ?? []) };
      requests.push(record);
      if (tag === 'policy_large_text' && step === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ index: 0, message: {
          content: 'x'.repeat(300000), reasoning_content: 't'.repeat(160000),
          tool_calls: [{ type: 'function', id: `${tag}-${step}`, function: { name: 'write_file',
            arguments: JSON.stringify({ path: pathFor(tag), content: textFor(tag) }) } }],
        }, finish_reason: 'tool_calls' }] }));
        return;
      }
      if (tag === 'policy_budget_chat') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ index: 0, message: { content: 'Synthetic Chat budget response' }, finish_reason: 'stop' }] }));
        return;
      }
      if ((tag === 'policy_output_recover' && step === 1) || (tag === 'policy_output_bounded' && step >= 1)) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'PARTIAL_MUST_NOT_COMPLETE',
          tool_calls: [{ index: 0, id: 'never-execute-partial', type: 'function', function: { name: 'write_file', arguments: '{' } }] }, finish_reason: 'length' }] }) + '\n\ndata: [DONE]\n\n');
        return;
      }
      if (tag === 'policy_cancel') { pending.set(tag, { release: () => failure(res), record }); return; }
      if (['policy_no_higher', 'policy_disabled', 'policy_bounded'].includes(tag)) return failure(res);
      if (tag === 'policy_frozen' && step === 1) { pending.set(tag, { release: () => failure(res), record }); return; }
      if (step === 0) return tool(res, tag, step, 'write_file', {
        path: tag === 'policy_uncertain' ? '../must-not-write.txt' : pathFor(tag), content: textFor(tag),
      });
      if (tag === 'policy_output_recover' && step === 2)
        return tool(res, tag, step, 'write_file', { path: pathFor(tag), content: textFor(tag) });
      if (tag === 'policy_auth' && step === 1) return failure(res, 401);
      if (['policy_transient', 'policy_uncertain'].includes(tag) && step === 1) return failure(res);
      if (tag === 'policy_difficulty' && step <= 2)
        return tool(res, tag, step, 'task_finish', { summary: 'Invalid synthetic claim', artifacts: ['missing'], verification: 'invented' });
      const repeat = tag === 'policy_difficulty' ? 3 : 2;
      if (['policy_transient', 'policy_frozen', 'policy_difficulty'].includes(tag) && step === repeat) {
        assert.equal(body.model, 'middle', 'Must use the frozen configured higher route');
        assert(record.artifacts.length, 'Higher model must receive the original successful receipt');
        return tool(res, tag, step, 'write_file', { path: pathFor(tag), content: textFor(tag) });
      }
      const verified = results.findLast(result => !result.error && result.verification);
      if (verified) return tool(res, tag, step, 'task_finish', {
        summary: 'Verified synthetic routing delivery', artifacts: verified.artifacts, verification: verified.verification,
      });
      return tool(res, tag, step, 'verify_file', { path: pathFor(tag), expected: textFor(tag) });
    } catch (error) {
      errors.push(String(error.stack ?? error).replaceAll('synthetic-policy-key', '[redacted]'));
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      if (!res.destroyed) res.end('{"error":{"message":"Synthetic policy fixture assertion failed"}}');
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return Object.assign(state, { base: `http://127.0.0.1:${server.address().port}`, textFor,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } });
}

try {
  app = await startNative({ label: 'policy-first', executable, ui, data, output, processes, traces });
  await check('provision isolated providers and configured routes without catalog network calls', async () => {
    await api('/api/dimension/bots', { id: bot, name: 'Synthetic model policy', mode: 'work' });
    for (const [name, kind, baseUrl] of [[provider, 'openai-chat-compat', fixture.base + '/v1'],
      ['policy-responses', 'openai-responses-compat', fixture.base + '/responses/v1/responses']])
      await api('/api/providers', { name, entry: { kind, baseUrl, spec: { model: 'small' } }, secretValue: 'synthetic-policy-key' });
    await api('/api/dimension/bots/' + bot + '/activate', {});
    await api('/api/dimension/work/settings', { botId: bot, cliEngine: 'builtin', workspaceMode: 'windows_native', projectCwd: output, approvalMode: 'full' }, 'PATCH');
    const originalContexts = (await api('/api/dimension/context-limits')).limits;
    assert.equal(originalContexts.work, 1048576);
    assert.equal(originalContexts.complex, 1048576);
    assert.equal(originalContexts.chat, 32768);
    await api('/api/dimension/context-limits', { limits: contexts(1048576) }, 'PUT');
    await setPlan(plan());
    const before = fixture.catalogs.length;
    const view = await api('/api/dimension/work-models');
    assert.equal(fixture.catalogs.length, before);
    assert(view.models.some(model => model.providerId === provider && model.model === 'small'));
  });
  await check('real GET catalogs refresh, support response endpoint bases, and retain manual selections', async () => {
    await setPlan({ ...plan(), routes: { ...plan().routes, complex: route('manual-special') } });
    const settings = (await api('/api/dimension/work-models')).settings;
    const direct = await api('/api/providers/' + provider + '/models', {});
    assert.equal(direct.catalog.status, 'ready'); assert(direct.models.includes('middle'));
    assert(direct.models.includes('manual-special'));
    fixture.models.push('newly-discovered');
    const refreshed = await api('/api/dimension/work-models?refresh=1');
    assert(refreshed.models.some(model => model.model === 'newly-discovered'));
    assert(fixture.catalogs.some(request => request.url === '/responses/v1/models'));
    assert.deepEqual(refreshed.settings, settings);
    assert.equal((await api('/api/providers/' + provider)).entry.spec.model, 'small');
    await setPlan(plan());
  });
  await check('unsupported, authentication, malformed, oversized, redirect and timeout preserve catalog', async () => {
    for (const mode of ['unsupported', 'auth', 'malformed', 'oversized', 'redirect', 'timeout']) {
      fixture.mode = mode;
      const before = Date.now();
      const result = await api('/api/providers/' + provider + '/models', {});
      assert.equal(result.catalog.status, mode === 'unsupported' ? 'unsupported' : 'error');
      assert(result.models.includes('newly-discovered') && result.models.includes('small'));
      assert(!JSON.stringify(result).includes('synthetic-secret-must-not-leak'));
      assert(Date.now() - before < 12000, 'Catalog request must stay bounded');
    }
    fixture.mode = 'ready';
  });
  await check('ordinary work stays on initial model with real verified output', async () => {
    const tag = 'policy_normal', run = await submit(tag), done = await settled(run.id);
    assert.equal(upgrades(done).length, 0);
    assert(requests(tag).every(request => request.model === 'small'));
    assert(requests(tag).every(request => request.maxTokens === 256000));
    assert.equal(await readFile(checkedFixtureFile(done.artifacts[0]), 'utf8'), fixture.textFor(tag));
  });
  await check('transient model failure upgrades once and reuses successful side-effect receipt', async () => {
    const tag = 'policy_transient', run = await submit(tag), done = await settled(run.id);
    assert.equal(upgrades(done).length, 1); assert.equal(upgrades(done)[0].routeReason, 'model_http_503');
    assert.deepEqual(requests(tag).map(request => request.model), ['small', 'small', 'middle', 'middle']);
    const native = JSON.parse(await readFile(path.join(data, 'work-runs/runs', run.id, 'snapshot.json'), 'utf8'));
    const writes = native.tools.filter(tool => tool.call.name === 'write_file');
    assert.equal(writes.length, 2); assert(writes.every(tool => tool.state === 'finished' && !tool.execution.error));
    assert.equal(await readFile(checkedFixtureFile(done.artifacts[0]), 'utf8'), fixture.textFor(tag));
    persisted = run.id;
  });
  await check('attempt freezes higher route while settings change and repeated write preserves mtime', async () => {
    const tag = 'policy_frozen', run = await submit(tag);
    const hold = await until(() => fixture.pending.get(tag), 'model failure hold after first actual write');
    const file = checkedFixtureFile(hold.record.artifacts[0]), before = await stat(file);
    await setPlan({ ...plan(), routes: { ...plan().routes, standard: route('large') } });
    hold.release();
    const done = await settled(run.id);
    assert.equal(upgrades(done)[0].modelRoute.model, 'middle');
    assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
    assert.equal(await readFile(file, 'utf8'), fixture.textFor(tag));
    await setPlan(plan());
  });
  await check('two failed completion checks trigger one configured upgrade', async () => {
    const tag = 'policy_difficulty', run = await submit(tag), done = await settled(run.id);
    assert.equal(upgrades(done).length, 1); assert.equal(upgrades(done)[0].routeReason, 'verification_failed');
    assert.deepEqual(requests(tag).map(request => request.model), ['small', 'small', 'small', 'middle', 'middle']);
  });
  await check('no higher route, disabled routing, auth and uncertain effects do not upgrade', async () => {
    for (const tag of ['policy_no_higher', 'policy_disabled', 'policy_auth', 'policy_uncertain']) {
      await setPlan(tag === 'policy_no_higher' ? plan(true, false) : tag === 'policy_disabled' ? plan(false) : plan());
      const run = await submit(tag), done = await settled(run.id, 'failed');
      assert.equal(upgrades(done).length, 0); assert(requests(tag).every(request => request.model === 'small'));
    }
    await setPlan(plan());
  });
  await check('persistent provider failure permits at most two forward switches', async () => {
    const tag = 'policy_bounded', run = await submit(tag), done = await settled(run.id, 'failed');
    assert.equal(upgrades(done).length, 2);
    assert.deepEqual(requests(tag).map(request => request.model), ['small', 'middle', 'large']);
  });
  await check('stop cancels the model request without switching routes', async () => {
    const tag = 'policy_cancel', run = await submit(tag);
    const hold = await until(() => fixture.pending.get(tag), 'model cancellation hold');
    await api(runPath(run.id) + '/cancel', {});
    const done = await settled(run.id, 'cancelled'); hold.release();
    assert.equal(upgrades(done).length, 0); assert.equal(requests(tag).length, 1);
  });
  await check('Work output-limit recovery discards partial tools and retries within one unchanged budget', async () => {
    await setPlan(plan());
    const tag = 'policy_output_recover', run = await submit(tag), done = await settled(run.id);
    assert.equal(upgrades(done).length, 0);
    assert.equal(requests(tag).length, 4);
    assert(requests(tag).every(request => request.model === 'small' && request.maxTokens === 256000));
    const native = JSON.parse(await readFile(path.join(data, 'work-runs/runs', run.id, 'snapshot.json'), 'utf8'));
    assert(!native.messages.some(message => String(message.content).includes('PARTIAL_MUST_NOT_COMPLETE')));
    assert(!native.tools.some(tool => tool.call.id === 'never-execute-partial'));
    const writes = native.tools.filter(tool => tool.call.name === 'write_file');
    assert.equal(writes.length, 2); assert(writes.every(tool => tool.state === 'finished' && !tool.execution.error));
    assert.equal(await readFile(checkedFixtureFile(done.artifacts[0]), 'utf8'), fixture.textFor(tag));
  });
  await check('Repeated output truncation pauses for explicit continuation instead of failing or looping', async () => {
    const tag = 'policy_output_bounded', run = await submit(tag), done = await settled(run.id, 'interrupted');
    assert.equal(requests(tag).length, 3); assert.equal(upgrades(done).length, 0);
    assert.match(done.error, /model_output_limit_reached/);
    const native = JSON.parse(await readFile(path.join(data, 'work-runs/runs', run.id, 'snapshot.json'), 'utf8'));
    assert.equal(native.tools.length, 1); assert.equal(native.tools[0].state, 'finished');
    assert.equal(await readFile(checkedFixtureFile(path.join(data, 'workspaces', run.id, fixture.pathFor?.(tag) ?? `policy/${tag}.txt`)), 'utf8'), fixture.textFor(tag));
  });
  await check('A 300000-byte model body and 160000-byte thinking chunk complete through the real model parser', async () => {
    const tag = 'policy_large_text', run = await submit(tag), done = await settled(run.id);
    const native = JSON.parse(await readFile(path.join(data, 'work-runs/runs', run.id, 'snapshot.json'), 'utf8'));
    assert(native.messages.some(message => message.role === 'assistant' && message.content.length === 300000));
    assert.equal(await readFile(checkedFixtureFile(done.artifacts[0]), 'utf8'), fixture.textFor(tag));
    assert(requests(tag).every(request => request.maxTokens === 256000));
  });
  await check('Work defaults to 256000 when context fits; explicit and saved context ceilings reserve actual input; Chat stays 4096', async () => {
    const configure = spec => api('/api/providers', { name: provider, entry: { kind: 'openai-chat-compat', baseUrl: fixture.base + '/v1', spec: { model: 'small', ...spec } }, secretValue: 'synthetic-policy-key' });
    await configure({ maxTokens: 1700 });
    const explicit = 'policy_budget_explicit'; await settled((await submit(explicit)).id);
    assert(requests(explicit).every(request => request.maxTokens === 1700));
    await configure({ maxTokens: 30000, contextWindow: 32768 });
    const bounded = 'policy_budget_context'; await settled((await submit(bounded)).id);
    assert(requests(bounded).every(request => request.maxTokens === Math.min(30000, 32768 - request.inputReserve)));
    await configure({});
    await api('/api/dimension/context-limits', { limits: contexts(32768) }, 'PUT');
    const userBounded = 'policy_budget_user_context'; await settled((await submit(userBounded)).id);
    assert(requests(userBounded).every(request => request.maxTokens === Math.min(16384, 32768 - request.inputReserve)));
    assert.deepEqual((await api('/api/dimension/context-limits')).limits, contexts(32768));
    await api('/api/dimension/context-limits', { limits: { ...contexts(65536), complex: 131072 } }, 'PUT');
    const savedDefault = 'policy_budget_saved_default'; await settled((await submit(savedDefault)).id);
    assert(requests(savedDefault).every(request => request.maxTokens === Math.min(32768, 65536 - request.inputReserve) && request.maxTokens < 256000));
    assert.equal((await api('/api/dimension/context-limits')).limits.work, 65536);
    assert.equal(Object.hasOwn((await api('/api/providers/' + provider)).entry.spec, 'maxTokens'), false);
    await api('/api/dimension/bots/' + bot + '/roster', { mode: 'chat', present: true }, 'PATCH');
    const frames = [], socket = new WebSocket(app.origin.replace('http:', 'ws:') + '/ws/providers/world:console/panels/chat');
    socket.addEventListener('message', event => frames.push(JSON.parse(event.data)));
    try {
      await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
      socket.send(JSON.stringify({ type: 'hello', botId: bot }));
      socket.send(JSON.stringify({ type: 'msg', botId: bot, text: 'APPTEST:policy_budget_chat', requestId: 'budget-chat' }));
      await until(() => frames.some(frame => frame.text === 'Synthetic Chat budget response'), 'Chat budget response');
      assert.equal(requests('policy_budget_chat').length, 1);
      assert.equal(requests('policy_budget_chat')[0].maxTokens, 4096);
    } finally { socket.close(); }
  });
  await check('An unselected provider with the same URL/model cannot lower the chosen Work route window', async () => {
    await api('/api/dimension/context-limits', { limits: contexts(1048576) }, 'PUT');
    await api('/api/providers', { name: provider, entry: { kind: 'openai-chat-compat', baseUrl: fixture.base + '/v1', spec: { model: 'small', maxTokens: 30000, contextWindow: 32768 } }, secretValue: 'synthetic-policy-key' });
    await api('/api/providers', { name: 'policy-unselected-small-window', entry: { kind: 'openai-responses-compat', baseUrl: fixture.base + '/v1', spec: { model: 'small', contextWindow: 8192 } }, secretValue: 'synthetic-policy-key' });
    await setPlan(plan());
    const tag = 'policy_selected_window'; await settled((await submit(tag)).id);
    assert(requests(tag).every(request => request.maxTokens === Math.min(30000, 32768 - request.inputReserve)));
    assert(requests(tag).every(request => request.maxTokens > 8192));
  });
  await check('restart preserves model-switch audit without new model calls', async () => {
    const count = fixture.requests.length;
    await app.stop();
    app = await startNative({ label: 'policy-restarted', executable, ui, data, output, processes, traces });
    const restored = await api(runPath(persisted));
    assert.equal(restored.status, 'completed'); assert.equal(upgrades(restored).length, 1);
    assert.equal(upgrades(restored)[0].routeReason, 'model_http_503');
    assert.equal(fixture.requests.length, count);
  });
} catch (error) { failures.push(String(error.stack ?? error)); process.exitCode = 1; }
finally {
  for (const entry of processes) {
    try { await entry.stop(); } catch (error) { failures.push(String(error.stack ?? error)); process.exitCode = 1; }
    await writeFile(path.join(output, entry.label + '.log'), entry.stdout + '\nSTDERR\n' + entry.stderr);
  }
  await fixture.close();
  if (fixture.errors.length) { failures.push(...fixture.errors); process.exitCode = 1; }
  const report = { passed: tests.filter(test => test.passed).length, failed: failures.length, tests, failures, output, data,
    traces, catalogs: fixture.catalogs, modelRequests: fixture.requests,
    scope: 'L: synthetic files and child native server with IPv4 loopback fake model/catalog only; no real accounts, external services, host applications or WSL.' };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, output }));
}
