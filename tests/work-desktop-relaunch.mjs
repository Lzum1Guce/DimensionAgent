// Native Work -> loopback protocol fixture -> real isolated Linux helper.
// A short, synthetic Python program increments a workspace counter on each real
// launch. No Chrome, production data, accounts, remote services or desktop mocks.
// Run only after the owner confirms the launchToken build is ready.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { promisify } from 'node:util';

const project = path.resolve(import.meta.dirname, '..'), options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
    assert(process.argv[i]?.startsWith('--') && process.argv[i + 1]);
    options.set(process.argv[i].slice(2), process.argv[i + 1]);
}
const output = path.resolve(options.get('output') || path.join(project, 'outputs/phase3-desktop-refinement/relaunch', new Date().toISOString().replace(/[:.]/g, '-')));
const data = path.join(output, 'data');
const executable = path.resolve(options.get('exe') || path.join(project, 'outputs/build/DImensionagent-native.exe'));
const helper = path.resolve(options.get('helper') || path.join(project, 'outputs/linux/dimension-desktop-helper'));
const wsl = options.get('wsl') || 'C:/Windows/System32/wsl.exe', distro = options.get('distro') || 'dimension-sandbox';
const stamp = `relaunch-${Date.now().toString(36)}`, credential = 'synthetic-relaunch-fixture-key', appId = 'synthetic-counter';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const checks = [], failures = [], modelErrors = [], records = [], processes = [], cases = new Map(), trackers = new Map(), linuxHistory = [];
let app, server, modelOrigin, callSequence = 0, ok = false;
assert(/^[lL]:[\\/]/.test(output), 'Standalone test output must remain on L:');

async function until(fn, label, timeout = 30000) {
    const deadline = Date.now() + timeout; let last;
    while (Date.now() < deadline) {
        try { const value = await fn(); if (value) return value; }
        catch (error) { if (error.fatal) throw error; last = error; }
        await delay(40);
    }
    throw Error(`Timeout: ${label}${last ? ` (${last.message})` : ''}`);
}
function pass(name, details) { checks.push({ name, details }); console.log('PASS ' + name); }
function noPixels(value, label) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    assert(!/data:image\/png;base64,|iVBORw0KGgo|"base64_data"\s*:|"png"\s*:\s*"[A-Za-z0-9+/]{64}/.test(text), `${label}: no PNG base64`);
    assert(!text.includes(credential), `${label}: no provider credential`);
}
async function api(route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(app.origin + route, { method, headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000) });
    const text = await response.text(); assert.equal(response.status, 200, `${method} ${route}: ${response.status} ${text.slice(0, 1200)}`);
    noPixels(text, `${method} ${route}`); return text ? JSON.parse(text) : null;
}
const desktop = c => `/api/dimension/work/desktops/${encodeURIComponent(c.botId)}`;
const state = c => api(desktop(c));
const runState = c => api(`/api/dimension/work/runs/${c.runId}`);
function token(summary) {
    assert.equal(typeof summary?.launchToken, 'string', 'Desktop state includes opaque launchToken');
    assert(summary.launchToken.length >= 16, 'Launch token is nontrivial'); return summary.launchToken;
}
function png(bytes) {
    assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
    assert.equal(bytes.readUInt32BE(16), 1280); assert.equal(bytes.readUInt32BE(20), 800);
    return { bytes: bytes.length, width: 1280, height: 800, sha256: sha256(bytes) };
}
async function counter(c) {
    try {
        const value = JSON.parse(await readFile(path.join(c.workspace, 'counter.json'), 'utf8'));
        assert.equal(value.tag, c.tag); assert(Number.isSafeInteger(value.count) && value.count > 0); return value.count;
    } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}
async function countIs(c, expected, eventual = false) {
    if (eventual) await until(async () => (await counter(c)) === expected, `${c.tag} real Python count ${expected}`, 10000);
    assert.equal(await counter(c), expected, `${c.tag}: real launch count`);
    c.expectedCount = expected;
}
const counterProgram = tag => `import os,json,pathlib,fcntl,time
root=pathlib.Path('/workspace')
with (root/'counter.lock').open('a') as lock:
 fcntl.flock(lock.fileno(),fcntl.LOCK_EX)
 target=root/'counter.json'
 count=json.loads(target.read_text())['count']+1 if target.exists() else 1
 row={'tag':${JSON.stringify(tag)},'count':count,'pid':os.getpid(),'namespace':os.readlink('/proc/self/ns/pid'),'monotonic':time.monotonic_ns()}
 temp=root/('counter-'+str(os.getpid())+'.tmp')
 temp.write_text(json.dumps(row),encoding='utf-8')
 os.replace(temp,target)
 with (root/'counter-events.jsonl').open('a',encoding='utf-8') as events: events.write(json.dumps(row)+'\\n')
`;

function requestParts(body, responses) {
    const input = responses ? body.input : body.messages; assert(Array.isArray(input));
    const names = new Map(), results = [], texts = [], images = [];
    for (const row of input) {
        if (row.type === 'function_call') names.set(row.call_id, row.name);
        for (const call of row.tool_calls || []) names.set(call.id, call.function.name);
        if (row.role !== 'user') continue;
        if (typeof row.content === 'string') texts.push(row.content);
        else for (const part of row.content || []) {
            if (part.type === 'text' || part.type === 'input_text') texts.push(part.text);
            const url = part.type === 'input_image' ? part.image_url : part.type === 'image_url' ? part.image_url?.url : null;
            if (url) { assert(url.startsWith('data:image/png;base64,')); images.push(Buffer.from(url.slice('data:image/png;base64,'.length), 'base64')); }
        }
    }
    for (const row of input) if (row.role === 'tool' || row.type === 'function_call_output') {
        const execution = JSON.parse(row.output ?? row.content); noPixels(execution, 'model tool JSON');
        let summary; try { summary = JSON.parse(execution.result); } catch {}
        results.push({ name: names.get(row.call_id || row.tool_call_id), execution, summary });
    }
    return { texts, results, images };
}
function sendTool(res, responses, name, toolArgs) {
    const id = `relaunch_call_${++callSequence}`, encoded = JSON.stringify(toolArgs), sse = value => `data: ${JSON.stringify(value)}\n\n`;
    if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    if (responses) {
        const item = { type: 'function_call', id: `item_${callSequence}`, call_id: id, name, arguments: encoded };
        const events = [
            { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
            { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: encoded },
            { type: 'response.output_item.done', output_index: 0, item },
            { type: 'response.completed', response: { id: `response_${callSequence}`, status: 'completed', output: [item], usage: { input_tokens: 80, output_tokens: 20 } } },
        ];
        res.end(events.map(event => `event: ${event.type}\n${sse(event)}`).join(''));
    } else res.end(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: encoded } }] }, finish_reason: null }] }) +
        sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 80, completion_tokens: 20 } }) + 'data: [DONE]\n\n');
    return id;
}
function succeeded(row, name) { assert.equal(row?.name, name); assert(!row.execution.error, JSON.stringify(row.execution)); assert(row.summary); return row.summary; }
function denied(row, code) {
    assert.equal(row?.name, 'desktop_launch'); assert.equal(row.execution.error, true);
    assert.equal(row.execution.metadata?.code, code); assert.equal(row.execution.metadata?.no_side_effects, true);
}
async function plan(c, parts, res, responses, record) {
    const latest = parts.results.findLast(row => row.name?.startsWith('desktop_'));
    record.images = parts.images.map(png);
    const emit = (name, toolArgs, next) => {
        c.stage = next; record.tool = { name, arguments: toolArgs }; c.sent.push(record.tool);
        return sendTool(res, responses, name, toolArgs);
    };
    const finish = () => emit('task_finish', { summary: `Verified real launch count ${c.expectedCount} for ${c.tag}`, artifacts: c.evidence.artifacts, verification: c.evidence.verification }, 'finished');
    const gate = label => {
        assert(!c.gate || c.gate.closed); if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.write(': synthetic relaunch gate\n\n'); c.gate = { label, closed: false, emit, record, latest };
        res.once('close', () => { c.gate.closed = true; });
    };
    switch (c.stage) {
    case 'initial': return emit('desktop_status', {}, 'initial-status');
    case 'initial-status':
        c.initialToken = token(succeeded(latest, 'desktop_status')); assert.equal(latest.summary.running, false);
        return emit('desktop_status', {}, 'status-stable');
    case 'status-stable':
        assert.equal(token(succeeded(latest, 'desktop_status')), c.initialToken);
        return emit('desktop_launch', { appId }, 'legacy-launched');
    case 'legacy-launched':
        c.firstToken = token(succeeded(latest, 'desktop_launch')); assert.notEqual(c.firstToken, c.initialToken);
        assert(parts.images.length); await countIs(c, 1, true);
        if (c.tag === 'beta') return emit('desktop_capture', {}, 'captured');
        return emit('desktop_launch', { appId }, 'legacy-reused');
    case 'legacy-reused':
        assert.equal(token(succeeded(latest, 'desktop_launch')), c.firstToken); await countIs(c, 1);
        assert.equal(token(await state(c)), c.firstToken);
        return emit('desktop_status', {}, 'fresh-status');
    case 'fresh-status':
        assert.equal(token(succeeded(latest, 'desktop_status')), c.firstToken);
        c.explicitLaunch = { appId, launchToken: c.firstToken };
        return emit('desktop_launch', c.explicitLaunch, 'explicit-launched');
    case 'explicit-launched':
        c.secondToken = token(succeeded(latest, 'desktop_launch')); assert.notEqual(c.secondToken, c.firstToken);
        await countIs(c, 2, true);
        return emit('desktop_launch', { appId, launchToken: c.initialToken }, 'stale-initial-denied');
    case 'stale-initial-denied':
        denied(latest, 'launch_state_stale'); await countIs(c, 2); assert.equal(token(await state(c)), c.secondToken);
        return emit('desktop_launch', { appId, launchToken: c.foreignToken }, 'foreign-denied');
    case 'foreign-denied':
        denied(latest, 'launch_state_stale'); await countIs(c, 2); await countIs(cases.get('beta'), 1);
        assert.equal(token(await state(c)), c.secondToken); assert.equal(token(await state(cases.get('beta'))), c.foreignToken);
        return emit('desktop_launch', { appId, arbitrarySalt: 'must-not-bypass-launch-receipts' }, 'salt-denied');
    case 'salt-denied':
        denied(latest, 'invalid_arguments'); await countIs(c, 2); assert.equal(token(await state(c)), c.secondToken);
        return emit('desktop_observe', {}, 'observe-stable');
    case 'observe-stable': {
        const summary = succeeded(latest, 'desktop_observe'); assert.equal(token(summary), c.secondToken);
        return emit('desktop_action', { op: 'press', key: 'F2', observationId: summary.observationId }, 'pressed');
    }
    case 'pressed':
        c.afterPressToken = token(succeeded(latest, 'desktop_action')); assert.notEqual(c.afterPressToken, c.secondToken);
        await countIs(c, 2); return emit('desktop_status', {}, 'press-status-stable');
    case 'press-status-stable':
        assert.equal(token(succeeded(latest, 'desktop_status')), c.afterPressToken);
        return emit('desktop_observe', {}, 'before-stop');
    case 'before-stop':
        assert.equal(token(succeeded(latest, 'desktop_observe')), c.afterPressToken); return gate('before-stop');
    case 'post-stop-status':
        assert.equal(token(succeeded(latest, 'desktop_status')), c.stoppedToken); assert.equal(latest.summary.running, false);
        c.afterStopLaunch = { appId, launchToken: c.stoppedToken };
        return emit('desktop_launch', c.afterStopLaunch, 'after-stop-launched');
    case 'after-stop-launched':
        c.thirdToken = token(succeeded(latest, 'desktop_launch')); assert.notEqual(c.thirdToken, c.stoppedToken);
        await countIs(c, 3, true); return emit('desktop_status', {}, 'after-stop-stable');
    case 'after-stop-stable':
        assert.equal(token(succeeded(latest, 'desktop_status')), c.thirdToken);
        return emit('desktop_launch', { appId, launchToken: c.afterPressToken }, 'pre-stop-denied');
    case 'pre-stop-denied':
        denied(latest, 'launch_state_stale'); await countIs(c, 3); assert.equal(token(await state(c)), c.thirdToken);
        return emit('desktop_capture', {}, 'captured');
    case 'captured': {
        const summary = succeeded(latest, 'desktop_capture'); assert.equal(summary.imageAttached, true); assert(parts.images.length);
        c.evidence = latest.execution; assert(c.evidence.artifacts.length === 1 && c.evidence.verification);
        c.capture = png(parts.images.at(-1)); assert(c.evidence.verification.includes(c.capture.sha256));
        await writeFile(path.join(output, `${c.tag}-model-capture.png`), parts.images.at(-1));
        if (c.tag === 'beta') return finish();
        c.preRestartToken = token(summary); assert.equal(c.preRestartToken, c.thirdToken); return gate('before-restart');
    }
    case 'replay-after-restart':
        assert.equal(parts.images.length, 0, 'Restart cannot restore ephemeral PNGs');
        return emit('desktop_launch', c.explicitLaunch, 'recovered-receipt');
    case 'recovered-receipt':
        assert.equal(token(succeeded(latest, 'desktop_launch')), c.secondToken);
        assert.equal(parts.images.length, 0, 'A reused completed launch cannot invent a fresh PNG');
        await countIs(c, 3); assert.equal((await state(c)).running, false);
        return emit('desktop_launch', { appId, launchToken: c.preRestartToken }, 'cross-restart-denied');
    case 'cross-restart-denied':
        denied(latest, 'launch_state_stale'); assert.equal(parts.images.length, 0);
        await countIs(c, 3); assert.equal((await state(c)).running, false); await countIs(cases.get('beta'), 1);
        return finish();
    default: throw Error(`Unexpected ${c.tag} model stage: ${c.stage}`);
    }
}
async function startModel() {
    server = http.createServer(async (req, res) => {
        req.on('error', () => {}); res.on('error', () => {});
        try {
            assert.equal(req.method, 'POST'); assert(['/v1/chat/completions', '/v1/responses'].includes(req.url));
            assert.equal(req.headers.authorization, `Bearer ${credential}`);
            const chunks = []; let size = 0;
            for await (const chunk of req) { size += chunk.length; assert(size <= 4 * 1024 * 1024); chunks.push(chunk); }
            const body = JSON.parse(Buffer.concat(chunks)), responses = req.url.endsWith('/responses'); assert.equal(body.stream, true);
            const parts = requestParts(body, responses), tag = parts.texts.flatMap(text => [...text.matchAll(/RELAUNCH:([a-z]+)/g)].map(match => match[1])).at(-1);
            const c = cases.get(tag); assert(c); assert.equal(responses, c.responses);
            const launchTool = body.tools.map(tool => tool.function || tool).find(tool => tool.name === 'desktop_launch');
            assert(launchTool?.parameters?.properties?.launchToken, 'Optional launchToken is published in the model tool schema');
            assert(!launchTool.parameters.required?.includes('launchToken'));
            const record = { tag, stage: c.stage, protocol: responses ? 'responses' : 'chat-completions', started: Date.now(), ended: null, aborted: false, requestBytes: size };
            records.push(record); res.once('close', () => { record.ended = Date.now(); record.aborted = !res.writableEnded; });
            await plan(c, parts, res, responses, record);
        } catch (error) {
            modelErrors.push(error.stack); if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
            if (!res.destroyed) res.end(JSON.stringify({ error: { message: 'Synthetic relaunch fixture assertion failed' } }));
        }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); modelOrigin = `http://127.0.0.1:${server.address().port}/v1`;
}
async function launchNative() {
    const child = spawn(executable, ['--data', data, '--ui', path.join(project, 'ui'), '--port', '0', '--wsl', wsl, '--sandbox-distro', distro, '--desktop-helper', helper],
        { cwd: output, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp') } });
    const entry = { child, stdout: '', stderr: '', port: null }; processes.push(entry);
    child.stdout.on('data', bytes => { entry.stdout += bytes; for (const line of entry.stdout.split(/\r?\n/)) { try { const row = JSON.parse(line); if (row.ready) entry.port = row.port; } catch {} } });
    child.stderr.on('data', bytes => { entry.stderr += bytes; }); child.on('error', error => { entry.error = error; });
    await until(() => { if (entry.error) throw Object.assign(entry.error, { fatal: true }); assert.equal(child.exitCode, null); return entry.port; }, 'native relaunch ready');
    entry.origin = `http://127.0.0.1:${entry.port}`; app = entry;
}
async function closeNative() {
    if (!app || app.child.exitCode !== null) return;
    app.child.stdin.end('shutdown\n'); await until(() => app.child.exitCode !== null, 'native orderly shutdown', 15000); assert.equal(app.child.exitCode, 0);
}
async function setupCase(tag, responses) {
    const c = { tag, responses, botId: `${stamp}-${tag}`, stage: 'initial', sent: [], expectedCount: 0 }; cases.set(tag, c);
    await api('/api/dimension/bots', { id: c.botId, name: `Synthetic relaunch ${tag}`, persona: 'Offline launch-token test only.' });
    await api(`/api/dimension/bots/${c.botId}/conversation-model`, { modelSelection: { providerId: responses ? 'relaunch-responses' : 'relaunch-chat', model: 'relaunch-fixture' } });
    await api('/api/dimension/work/settings', { botId: c.botId, networkAccess: false }, 'PATCH');
    const initial = await state(c); token(initial); c.workspace = initial.workspace;
    const relative = path.relative(output, c.workspace); assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await writeFile(path.join(c.workspace, 'counter.py'), counterProgram(tag), 'utf8'); return c;
}
async function submit(c) {
    const result = await api('/api/dimension/work/runs', { botId: c.botId, text: `RELAUNCH:${c.tag} Verify explicit repeated launch intent and receipt safety using the synthetic counter.`, requestId: `${stamp}-${c.tag}` });
    c.runId = result.run.id;
}
async function terminal(c) {
    const result = await until(async () => {
        if (modelErrors.length) throw Object.assign(Error(modelErrors.at(-1)), { fatal: true });
        const run = await runState(c); return run.terminal && !run.executing ? run : null;
    }, `${c.tag} completed`, 70000);
    assert.equal(result.status, 'completed', JSON.stringify(result)); return result;
}
async function gateFor(c, label) {
    return until(() => { if (modelErrors.length) throw Object.assign(Error(modelErrors.at(-1)), { fatal: true }); return c.gate?.label === label && !c.gate.closed ? c.gate : null; }, `${c.tag} ${label}`, 70000);
}
async function journal(c) {
    const folder = path.join(data, 'work-runs/runs', c.runId, 'events'), rows = [];
    for (const file of (await readdir(folder)).filter(name => name.endsWith('.jsonl')).sort()) {
        const text = await readFile(path.join(folder, file), 'utf8'); noPixels(text, `${c.tag} journal`);
        for (const line of text.split('\n')) if (line.trim()) rows.push(JSON.parse(line));
    }
    return rows;
}
const canonical = value => JSON.stringify(value, Object.keys(value).sort());
function launchStarted(event, toolArgs) {
    if (event.type !== 'tool_started' || event.data?.call?.name !== 'desktop_launch') return false;
    const raw = event.data.call.arguments; return canonical(typeof raw === 'string' ? JSON.parse(raw) : raw) === canonical(toolArgs);
}
async function delivery(c) {
    await terminal(c); const result = await api(`/api/dimension/work/tasks/${c.runId}/artifacts`);
    assert.equal(result.files.length, 1); assert.equal(result.files[0].available, true);
    const response = await fetch(app.origin + result.files[0].url); assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer()), info = png(bytes);
    assert.equal(info.sha256, c.capture.sha256); assert(c.evidence.verification.includes(info.sha256));
    assert.equal(sha256(await readFile(result.files[0].path)), info.sha256);
    await writeFile(path.join(output, `${c.tag}-download.png`), bytes); c.artifact = { ...result.files[0], ...info };
}
async function hygiene(c) {
    noPixels(await runState(c), `${c.tag} GET run`); noPixels(await state(c), `${c.tag} GET desktop`);
    noPixels(await readFile(path.join(data, 'work-runs/runs', c.runId, 'snapshot.json'), 'utf8'), `${c.tag} snapshot`); await journal(c);
    const response = await fetch(app.origin + `/api/dimension/work/runs/${c.runId}/events?after=0`, { signal: AbortSignal.timeout(10000) }); assert.equal(response.status, 200);
    const events = await response.text(); noPixels(events, `${c.tag} public SSE`); await writeFile(path.join(output, `${c.tag}-public-events.txt`), events, 'utf8');
}
const processProbe = `import os,json
rows=[]
for name in os.listdir('/proc'):
 if not name.isdigit():continue
 try:
  raw=open('/proc/'+name+'/stat').read();end=raw.rfind(')');fields=raw[end+2:].split()
  try: ns=os.readlink('/proc/'+name+'/ns/pid')
  except OSError: ns=None
  try: cmd=open('/proc/'+name+'/cmdline','rb').read().replace(b'\\0',b' ').decode('utf-8','replace')
  except OSError: cmd=''
  rows.append({'pid':int(name),'ppid':int(fields[1]),'starttime':fields[19],'state':fields[0],'namespace':ns,'comm':raw[raw.find('(')+1:end],'command':cmd})
 except (OSError,ValueError,IndexError):pass
print(json.dumps({'host':os.readlink('/proc/self/ns/pid'),'rows':rows}))
`;
async function linuxSnapshot(label) {
    const result = await promisify(execFile)(wsl, ['-d', distro, '--exec', '/usr/bin/python3', '-c', processProbe], { cwd: output, windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 15000 });
    const { rows, host } = JSON.parse(result.stdout), byPid = new Map(rows.map(row => [row.pid, row])), selected = new Map();
    for (const c of cases.values()) {
        let tracker = trackers.get(c.tag); if (!tracker) { tracker = { known: new Map(), namespaces: new Set() }; trackers.set(c.tag, tracker); }
        const roots = new Set([...tracker.known.values()].filter(row => byPid.get(row.pid)?.starttime === row.starttime).map(row => row.pid));
        const workspace = c.workspace && '/mnt/' + c.workspace[0].toLowerCase() + c.workspace.slice(2).replaceAll('\\', '/');
        for (const row of rows) if (workspace && row.command.includes(workspace) && /(?:^|\/)bwrap\s/.test(row.command)) roots.add(row.pid);
        const remember = row => { if (row.namespace && row.namespace !== host) tracker.namespaces.add(row.namespace); };
        for (const pid of roots) remember(byPid.get(pid));
        let added; do { added = false; for (const row of rows) if (!roots.has(row.pid) && (roots.has(row.ppid) || tracker.namespaces.has(row.namespace))) { roots.add(row.pid); remember(row); added = true; } } while (added);
        for (const row of rows) if (roots.has(row.pid)) { tracker.known.set(`${row.pid}:${row.starttime}`, row); selected.set(`${row.pid}:${row.starttime}`, { ...row, tag: c.tag }); }
    }
    const current = [...selected.values()]; linuxHistory.push({ label, at: Date.now(), processes: current }); return current;
}

await mkdir(path.join(output, 'temp'), { recursive: true });
const fingerprints = {};
try {
    for (const [name, file] of [['native', executable], ['helper', helper], ['test', import.meta.filename]]) fingerprints[name] = { path: file, sha256: sha256(await readFile(file)) };
    await startModel(); await launchNative();
    for (const [name, kind] of [['relaunch-chat', 'openai-chat-compat'], ['relaunch-responses', 'openai-responses-compat']])
        await api('/api/providers', { name, entry: { kind, baseUrl: modelOrigin, spec: { model: 'relaunch-fixture', maxTokens: 4096 } }, secretValue: credential });
    await api('/api/dimension/work-models', { settings: { enabled: false, routes: {} } }, 'PUT');
    await api('/api/dimension/work/software', { apps: [{ id: appId, name: 'Synthetic isolated launch counter', executable: '/usr/bin/python3', args: ['/workspace/counter.py'] }] }, 'PUT');

    const beta = await setupCase('beta', true), alpha = await setupCase('alpha', false);
    await submit(beta); await delivery(beta); await countIs(beta, 1);
    const betaBefore = await state(beta), alphaBefore = await state(alpha);
    const taken = await api(desktop(beta) + '/control', { human: true });
    assert.notEqual(token(taken), token(betaBefore)); assert.equal(taken.humanControl, true);
    const returned = await api(desktop(beta) + '/control', { human: false });
    assert.notEqual(token(returned), token(taken)); assert.equal(returned.humanControl, false);
    assert.equal(token(await state(alpha)), token(alphaBefore)); await countIs(beta, 1);
    alpha.foreignToken = token(returned);
    pass('Takeover and return rotate only their Bot launch token while another Bot and its counter remain unchanged');

    await submit(alpha); const stopGate = await gateFor(alpha, 'before-stop');
    await countIs(alpha, 2); await linuxSnapshot('two-real-counter-desktops');
    const stopped = await api(desktop(alpha) + '/stop', {}); alpha.stoppedToken = token(stopped);
    assert.equal(stopped.running, false); assert.notEqual(alpha.stoppedToken, alpha.afterPressToken);
    assert.equal(token(await state(beta)), alpha.foreignToken); assert.equal((await state(beta)).running, true); await countIs(beta, 1);
    stopGate.emit('desktop_status', {}, 'post-stop-status');
    const restartGate = await gateFor(alpha, 'before-restart'); await countIs(alpha, 3);
    let events = await journal(alpha);
    const legacy = events.filter(event => launchStarted(event, { appId }));
    assert.equal(legacy.filter(event => event.data.willExecute).length, 1); assert(legacy.some(event => event.data.reused));
    pass('Legacy launch arguments reuse the first receipt while a current explicit token dispatches a second real program', { count: 2 });
    pass('Status and observe preserve launchToken; a real F2 press rotates it without launching another program');
    pass('Old, foreign-Bot and pre-stop tokens plus arbitrary extra arguments are refused with no_side_effects and unchanged counters');
    assert.equal(events.filter(event => launchStarted(event, alpha.afterStopLaunch) && event.data.willExecute).length, 1);
    pass('Stopping rotates the token and a fresh status token starts the same app again in the same Work run', { count: 3 });

    await linuxSnapshot('before-backend-restart'); await closeNative(); await until(() => restartGate.record.aborted, 'shutdown aborts fixture model gate');
    await until(async () => (await linuxSnapshot('after-backend-shutdown')).length === 0, 'old desktop namespaces drained', 3000);
    await launchNative(); assert.equal((await runState(alpha)).status, 'interrupted');
    const recovered = await state(alpha); assert.equal(recovered.running, false); assert.notEqual(token(recovered), alpha.preRestartToken);
    assert.notEqual(token(await state(beta)), alpha.foreignToken);
    alpha.stage = 'replay-after-restart';
    await api(`/api/dimension/work/runs/${alpha.runId}/resume`, { requestId: `${stamp}-alpha-resume`, text: 'CONTINUE: preserve completed launch receipts and reject tokens from the previous backend instance.' });
    await delivery(alpha); await countIs(alpha, 3); await countIs(beta, 1);
    events = await journal(alpha); const explicit = events.filter(event => launchStarted(event, alpha.explicitLaunch));
    assert.equal(explicit.filter(event => event.data.willExecute).length, 1); assert(explicit.some(event => event.data.reused));
    assert.equal((await state(alpha)).running, false); assert.equal((await state(beta)).running, false);
    pass('Restart reuses the completed token-bearing launch without dispatch or PNG recovery, and rejects an unused prior-instance token');

    for (const c of cases.values()) {
        await hygiene(c);
        const text = await readFile(path.join(c.workspace, 'counter-events.jsonl'), 'utf8');
        c.counterEvents = text.trim().split('\n').map(line => JSON.parse(line));
        assert.equal(c.counterEvents.length, c.expectedCount); assert.deepEqual(c.counterEvents.map(row => row.count), Array.from({ length: c.expectedCount }, (_, i) => i + 1));
        for (const row of c.counterEvents) { assert.equal(row.tag, c.tag); assert(row.pid > 0 && row.namespace.startsWith('pid:[')); }
    }
    assert(alpha.counterEvents.every(row => row.namespace !== beta.counterEvents[0].namespace), 'Counter programs for different live Bots run in separate PID namespaces');
    assert.deepEqual(modelErrors, []); assert(records.some(row => row.protocol === 'chat-completions' && row.images.length)); assert(records.some(row => row.protocol === 'responses' && row.images.length));
    pass('Both protocol paths carry real PNGs and downloadable captures while public GET/SSE, events, snapshots and receipts contain no PNG base64');
    assert.deepEqual(await linuxSnapshot('final'), []); pass('Both Bot counters and PID/starttime/namespace identities remain isolated, with no test processes left');
    ok = true;
} catch (error) {
    failures.push(error.stack); console.error(error.stack); process.exitCode = 1;
} finally {
    if (app?.child.exitCode === null) {
        for (const c of cases.values()) {
            if (c.runId) await api(`/api/dimension/work/runs/${c.runId}/cancel`, {}).catch(() => {});
            if (c.workspace) await api(desktop(c) + '/stop', {}).catch(error => failures.push(`Cleanup ${c.tag}: ${error.message}`));
        }
        await until(async () => (await linuxSnapshot('cleanup-final')).length === 0, 'test processes drained', 3000).catch(error => failures.push(error.message));
    }
    await closeNative().catch(error => failures.push(error.message));
    for (const entry of processes) if (entry.child.pid && entry.child.exitCode === null)
        await promisify(execFile)('taskkill', ['/PID', String(entry.child.pid), '/T', '/F'], { cwd: output, windowsHide: true }).catch(() => {});
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (let i = 0; i < processes.length; i++) await writeFile(path.join(output, `native-${i}.log`), processes[i].stdout + '\nSTDERR\n' + processes[i].stderr, 'utf8');
    ok &&= failures.length === 0 && modelErrors.length === 0; if (!ok) process.exitCode = 1;
    const caseReports = [...cases.values()].map(({ gate, evidence, ...c }) => ({ ...c, verification: evidence?.verification, artifacts: evidence?.artifacts }));
    const report = { ok, checks, failures, modelErrors, records, cases: caseReports, linuxHistory, fingerprints,
        windowsProcesses: processes.map(entry => ({ pid: entry.child.pid, exitCode: entry.child.exitCode, signal: entry.child.signalCode })),
        scope: 'Independent synthetic data, loopback model protocols and real Linux helper/Python counters. No Chrome, production data, real accounts or external services.' };
    noPixels(report, 'report'); await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify({ ok, checks: checks.length, output }));
}
