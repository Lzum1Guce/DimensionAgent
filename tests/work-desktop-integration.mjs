// Real native Work -> loopback model protocol fixture -> real isolated Linux Chrome.
// The fixture chooses click coordinates by decoding actual PNG pixels. No desktop
// API mocking, production data, external websites, real accounts, or UI edits.
// Run only after the owning agent confirms the native/helper build is ready.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';

const project = path.resolve(import.meta.dirname, '..');
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) { assert(process.argv[i]?.startsWith('--') && process.argv[i + 1]); args.set(process.argv[i].slice(2), process.argv[i + 1]); }
const output = path.resolve(args.get('output') || path.join(project, 'outputs/phase3-vision/integration', new Date().toISOString().replace(/[:.]/g, '-')));
const data = path.join(output, 'data');
const executable = path.resolve(args.get('exe') || path.join(project, 'outputs/build/DImensionagent-native.exe'));
const helper = path.resolve(args.get('helper') || path.join(project, 'outputs/linux/dimension-desktop-helper'));
const wsl = args.get('wsl') || 'C:/Windows/System32/wsl.exe';
const distro = args.get('distro') || 'dimension-sandbox';
const selectedCases = new Set((args.get('cases') || 'main,human,restart,cancel,steer').split(','));
for (const name of selectedCases) assert(['main', 'human', 'restart', 'cancel', 'steer'].includes(name), `Unknown case group: ${name}`);
const runStamp = `vision-${Date.now().toString(36)}`;
const secret = 'synthetic-vision-fixture-key';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const checks = [], failures = [], modelErrors = [], records = [], processes = [], cases = new Map(), trackers = new Map(), linuxHistory = [];
let app, modelServer, modelOrigin, toolSequence = 0, successful = false;
assert(/^[lL]:[\\/]/.test(output), 'All standalone test output must stay on L:');

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
    assert(!/data:image\/png;base64,|iVBORw0KGgo|"base64_data"\s*:|"png"\s*:\s*"[A-Za-z0-9+/]{64}/.test(text), `${label} must not persist or publish PNG base64`);
    assert(!text.includes(secret), `${label} must not expose the synthetic provider credential`);
}
async function api(route, body, method = body === undefined ? 'GET' : 'POST', expected = 200) {
    const response = await fetch(app.origin + route, { method, headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000) });
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${route}: ${response.status} ${text.slice(0, 1500)}`);
    return text ? JSON.parse(text) : null;
}
const desktop = c => `/api/dimension/work/desktops/${encodeURIComponent(c.botId)}`;
const state = c => api(desktop(c));
const getRun = c => api(`/api/dimension/work/runs/${c.runId}`);
async function terminal(c, expected = 'completed', timeout = 70000) {
    const run = await until(async () => { const run = await getRun(c); return run.terminal && !run.executing ? run : null; }, `${c.tag} terminal`, timeout);
    assert.equal(run.status, expected, JSON.stringify({ tag: c.tag, status: run.status, error: run.error, answer: run.answer }));
    return run;
}

// Small independent PNG reader: only the actual 8-bit, non-interlaced image
// formats used by the helper. Pixel data never comes from the HTML fixture's
// random coordinates or a simulated desktop response.
function decodePng(bytes) {
    assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    let width, height, channels, type, palette, alpha; const compressed = [];
    for (let offset = 8; offset + 12 <= bytes.length;) {
        const length = bytes.readUInt32BE(offset), kind = bytes.toString('ascii', offset + 4, offset + 8), end = offset + 12 + length;
        assert(end <= bytes.length, 'PNG chunk boundary'); const block = bytes.subarray(offset + 8, offset + 8 + length);
        if (kind === 'IHDR') {
            width = block.readUInt32BE(0); height = block.readUInt32BE(4); type = block[9]; channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[type];
            assert.equal(block[8], 8); assert.equal(block[12], 0); assert(channels); assert.equal(width, 1280); assert.equal(height, 800);
        } else if (kind === 'IDAT') compressed.push(block);
        else if (kind === 'PLTE') palette = block;
        else if (kind === 'tRNS') alpha = block;
        offset = end; if (kind === 'IEND') break;
    }
    assert(width && height && compressed.length); const stride = width * channels;
    const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: (stride + 1) * height });
    assert.equal(raw.length, (stride + 1) * height);
    const pixels = Buffer.alloc(stride * height);
    const paeth = (a, b, c) => { const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c); return da <= db && da <= dc ? a : db <= dc ? b : c; };
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)]; assert(filter <= 4);
        for (let x = 0; x < stride; x++) {
            const at = y * stride + x, left = x >= channels ? pixels[at - channels] : 0, up = y ? pixels[at - stride] : 0, ul = y && x >= channels ? pixels[at - stride - channels] : 0;
            const predictor = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, ul)][filter];
            pixels[at] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255;
        }
    }
    const rgb = (x, y) => {
        const at = (y * width + x) * channels;
        if (type === 3) { const i = pixels[at]; assert(palette && i * 3 + 2 < palette.length); return [palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2], alpha?.[i] ?? 255]; }
        return type === 0 || type === 4 ? [pixels[at], pixels[at], pixels[at], type === 4 ? pixels[at + 1] : 255] : [pixels[at], pixels[at + 1], pixels[at + 2], type === 6 ? pixels[at + 3] : 255];
    };
    const locate = color => {
        let count = 0, minX = width, minY = height, maxX = 0, maxY = 0;
        for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
            const value = rgb(x, y);
            if (color.every((v, i) => Math.abs(value[i] - v) <= 5)) { count++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
        }
        return count >= 100 ? { x: Math.floor((minX + maxX) / 2), y: Math.floor((minY + maxY) / 2), pixelsSampled: count } : null;
    };
    return { width, height, sha256: digest(bytes), locate };
}
const color = { target: [240, 30, 190], clicked: [245, 180, 25], typed: [30, 170, 220], done: [30, 210, 80] };
function imageObservation(bytes, c) {
    const png = decodePng(bytes);
    return { width: png.width, height: png.height, sha256: png.sha256, identity: png.locate(c.identity), target: png.locate(color.target), clicked: png.locate(color.clicked), typed: png.locate(color.typed), done: png.locate(color.done) };
}
function htmlFixture(c) {
    // Random positions deliberately stay only in the page content. The model
    // handler receives pixels and cannot choose a point from this local truth.
    const x = randomInt(280, 1050), y = randomInt(180, 440);
    return `<!doctype html><meta charset="utf-8"><title>Offline ${c.tag}</title><style>html,body{margin:0;background:#18202c;color:white;font:24px sans-serif;overflow:hidden}#identity{position:absolute;left:24px;top:24px;width:180px;height:65px;background:rgb(${c.identity})}#clicked,#typed,#done{position:absolute;top:24px;width:180px;height:65px;background:#505050}#clicked{left:244px}#typed{left:464px}#done{left:684px}#target{position:absolute;left:${x}px;top:${y}px;width:90px;height:70px;border:0;background:rgb(240,30,190)}textarea{position:absolute;left:24px;top:550px;width:1130px;height:170px;background:white;color:black;font:28px sans-serif}#label{position:absolute;left:24px;top:110px}#report{position:absolute;left:24px;top:465px}</style><div id="identity"></div><div id="clicked"></div><div id="typed"></div><div id="done"></div><div id="label">${c.tag} · 离线视觉测试：寻找随机位置粉色色块</div><button id="target" aria-label="Random click target"></button><textarea id="text"></textarea><div id="report"></div><script>const expected=${JSON.stringify(c.text)},input=document.querySelector('#text');let clicks=0,enters=0;function update(){document.querySelector('#clicked').style.background=clicks?'rgb(245,180,25)':'#505050';document.querySelector('#typed').style.background=input.value.includes(expected)?'rgb(30,170,220)':'#505050';document.querySelector('#done').style.background=input.value.includes(expected)&&input.value.includes('\\n')&&enters?'rgb(30,210,80)':'#505050';document.querySelector('#report').textContent='点击 '+clicks+' / Enter '+enters+' / '+input.value;}document.querySelector('#target').onclick=()=>{clicks++;input.focus();update()};input.oninput=update;input.onkeydown=e=>{if(e.key==='Enter'){enters++;setTimeout(update,0)}};update();</script>`;
}
const freezer = `import os,time,signal,pathlib,json
parent=os.getppid()
assert pathlib.Path('/proc/'+str(parent)+'/cmdline').read_bytes().split(b'\\0')[0]==b'/dimension-helper'
arm=pathlib.Path('/workspace/arm-freeze')
deadline=time.monotonic()+90
while not arm.exists() and time.monotonic()<deadline: time.sleep(.01)
if arm.exists():
 pathlib.Path('/workspace/frozen.json').write_text(json.dumps({'helperPid':parent,'namespace':os.readlink('/proc/self/ns/pid')}))
 os.kill(parent,signal.SIGSTOP)
 while True: time.sleep(1)
`;

function requestParts(body, responses) {
    const input = responses ? body.input : body.messages; assert(Array.isArray(input));
    const names = new Map(), results = [], texts = [], images = [];
    for (const row of input) {
        if (row.type === 'function_call') names.set(row.call_id, row.name);
        for (const call of row.tool_calls || []) names.set(call.id, call.function.name);
        if (row.role === 'user') {
            if (typeof row.content === 'string') texts.push(row.content);
            else for (const part of row.content || []) {
                if (part.type === 'text' || part.type === 'input_text') texts.push(part.text);
                const url = part.type === 'input_image' ? part.image_url : part.type === 'image_url' ? part.image_url?.url : null;
                if (url) { assert(url.startsWith('data:image/png;base64,')); images.push(Buffer.from(url.slice('data:image/png;base64,'.length), 'base64')); }
            }
        }
    }
    for (const row of input) if (row.role === 'tool' || row.type === 'function_call_output') {
        const execution = JSON.parse(row.output ?? row.content); noPixels(execution, 'model tool result JSON');
        let summary; try { summary = JSON.parse(execution.result); } catch {}
        results.push({ name: names.get(row.call_id || row.tool_call_id), execution, summary });
    }
    return { texts, images, results };
}
function sendTool(res, responses, name, toolArgs) {
    const id = `vision_call_${++toolSequence}`, encoded = JSON.stringify(toolArgs), sse = obj => `data: ${JSON.stringify(obj)}\n\n`;
    if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    if (responses) {
        const item = { type: 'function_call', id: `item_${toolSequence}`, call_id: id, name, arguments: encoded };
        const events = [
            { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
            { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: encoded },
            { type: 'response.output_item.done', output_index: 0, item },
            { type: 'response.completed', response: { id: `response_${toolSequence}`, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 20 } } },
        ];
        res.end(events.map(event => `event: ${event.type}\n${sse(event)}`).join(''));
    } else res.end(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: encoded } }] }, finish_reason: null }] }) +
        sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }) + 'data: [DONE]\n\n');
    return id;
}
function lastDesktop(parts) { return parts.results.findLast(row => row.name?.startsWith('desktop_')); }
async function plan(c, parts, res, responses, record) {
    const latest = lastDesktop(parts);
    const image = parts.images.at(-1);
    const observed = image ? imageObservation(image, c) : null;
    record.images = parts.images.map(bytes => ({ bytes: bytes.length, sha256: digest(bytes) }));
    if (observed) { record.observation = observed; c.imageObservations.push(observed); await writeFile(path.join(output, `${c.tag}-last-model-image.png`), image); }
    const emit = (name, toolArgs, next) => {
        if (next) c.stage = next; record.tool = { name, arguments: toolArgs };
        if (name === 'desktop_launch' && toolArgs.appId === 'vision-chrome') c.launchRequestedAt = Date.now();
        c.sent.push({ name, arguments: toolArgs }); return sendTool(res, responses, name, toolArgs);
    };
    const observe = async next => {
        c.waitFrames++;
        if (c.waitFrames === 3 || c.waitFrames === 12) await linuxSnapshot(`${c.tag}-${next}-wait-${c.waitFrames}`);
        assert(c.waitFrames <= 12, `${c.tag}: real Chrome frame did not reach expected state`);
        await delay(next === 'seek' ? 3000 : 1000); return emit('desktop_observe', {}, next);
    };
    const action = (fields, next) => { assert(latest?.summary?.observationId); const toolArgs = { ...fields, observationId: latest.summary.observationId }; return emit('desktop_action', toolArgs, next); };
    const finish = () => { assert(c.evidence?.artifacts?.length && c.evidence.verification); return emit('task_finish', { summary: `Verified real desktop ${c.tag}`, artifacts: c.evidence.artifacts, verification: c.evidence.verification }, 'finished'); };
    const gate = label => {
        assert(!c.gate || c.gate.closed, 'One pending fixture model call per case');
        if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.write(': synthetic model gate\n\n');
        c.gate = { label, closed: false, record, res, emit, latest, imageCount: parts.images.length };
        res.once('close', () => { c.gate.closed = true; });
    };
    if (!['status', 'resume-observe', 'replay-success', 'replay-uncertain', 'after-replay-uncertain'].includes(c.stage) && latest?.execution.error) {
        throw Error(`${c.tag}: unexpected desktop tool error ${JSON.stringify(latest.execution).slice(0, 1200)}`);
    }
    switch (c.stage) {
    case 'status': return emit('desktop_status', {}, 'launch');
    case 'launch': assert.equal(latest.summary.humanControl, false); return emit('desktop_launch', { appId: 'vision-chrome' }, 'seek');
    case 'resume-observe': assert.equal(parts.images.length, 0, 'Resumed attempt cannot recover pixels from persisted JSON'); c.waitFrames = 0; return emit('desktop_observe', {}, 'seek');
    case 'seek': {
        if (!observed?.identity || !observed.target) return observe('seek');
        c.firstVisualMilliseconds ??= Date.now() - c.launchRequestedAt;
        if (c.mode === 'human' && !c.humanResumed) return gate('before-human-observe');
        c.waitFrames = 0;
        c.chosenPoint = { x: observed.target.x, y: observed.target.y, imageSha256: observed.sha256 };
        return action({ op: 'click', x: observed.target.x, y: observed.target.y }, 'click-proof');
    }
    case 'click-proof':
        if (!observed?.identity || !observed.clicked) return observe('click-proof');
        c.waitFrames = 0; c.successfulAction = { op: 'type', text: c.text, observationId: latest.summary.observationId };
        return emit('desktop_action', c.successfulAction, 'type-proof');
    case 'type-proof':
        if (!observed?.typed) return observe('type-proof');
        c.waitFrames = 0; return action({ op: 'press', key: 'Return' }, 'green');
    case 'green':
        if (!observed?.done) return observe('green');
        c.waitFrames = 0; return emit('desktop_capture', {}, 'captured');
    case 'captured':
        assert.equal(latest.name, 'desktop_capture'); assert(observed?.done && observed.identity, 'capture pixels prove this Bot received full Chinese text and Return');
        assert.equal(latest.summary.imageAttached, true); c.evidence = latest.execution; c.captureSha256 = observed.sha256;
        await writeFile(path.join(output, `${c.tag}-model-capture.png`), image);
        if (c.mode === 'restart') return gate('before-restart');
        if (c.mode === 'cancel' || c.mode === 'steer') return emit('desktop_launch', { appId: 'vision-freeze' }, 'arm-freeze');
        return finish();
    case 'arm-freeze': assert.equal(latest.name, 'desktop_launch'); return gate('before-frozen-action');
    case 'replay-success':
        assert.equal(parts.images.length, 0, 'Restart did not reload transient images');
        return emit('desktop_action', c.successfulAction, 'after-replay-success');
    case 'after-replay-success':
        assert.equal(latest.name, 'desktop_action'); assert(!latest.execution.error); assert.equal(parts.images.length, 0, 'Reused receipt cannot invent cached PNG');
        c.successReplayObserved = true; return finish();
    case 'replay-uncertain':
        if (c.restarted) assert.equal(parts.images.length, 0, 'Uncertain recovery did not reload image pixels');
        return emit('desktop_action', c.blockedAction, 'after-replay-uncertain');
    case 'after-replay-uncertain':
        assert.equal(latest.name, 'desktop_action'); assert.equal(latest.execution.error, true, 'Uncertain action replay must be refused');
        c.uncertainReplayObserved = true; record.uncertainResult = latest.execution; return finish();
    default: throw Error(`${c.tag}: unexpected model stage ${c.stage}`);
    }
}
async function startModel() {
    modelServer = http.createServer(async (req, res) => {
        req.on('error', () => {}); res.on('error', () => {});
        try {
            assert.equal(req.method, 'POST'); assert(['/v1/chat/completions', '/v1/responses'].includes(req.url));
            assert.equal(req.headers.authorization, `Bearer ${secret}`);
            const chunks = []; let size = 0;
            for await (const chunk of req) { size += chunk.length; assert(size <= 4 * 1024 * 1024); chunks.push(chunk); }
            const body = JSON.parse(Buffer.concat(chunks)); const responses = req.url.endsWith('/responses');
            assert.equal(body.stream, true); const parts = requestParts(body, responses);
            const tag = parts.texts.flatMap(text => [...text.matchAll(/VISION:([a-z0-9_-]+)/g)].map(match => match[1])).at(-1);
            const c = cases.get(tag); assert(c, 'Synthetic task marker identifies model case'); assert.equal(c.responses, responses);
            const catalog = body.tools.map(tool => tool.function?.name || tool.name);
            for (const name of ['desktop_status', 'desktop_launch', 'desktop_observe', 'desktop_action', 'desktop_capture', 'task_finish']) assert(catalog.includes(name), `${name} is published to model`);
            const record = { tag, protocol: responses ? 'responses' : 'chat-completions', stage: c.stage, started: Date.now(), ended: null, aborted: false, requestBytes: size };
            records.push(record); res.once('close', () => { record.ended = Date.now(); record.aborted = !res.writableEnded; });
            await plan(c, parts, res, responses, record);
        } catch (error) {
            modelErrors.push(error.stack); if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
            if (!res.destroyed) res.end(JSON.stringify({ error: { message: 'Synthetic vision fixture assertion failed' } }));
        }
    });
    modelServer.listen(0, '127.0.0.1'); await once(modelServer, 'listening');
    modelOrigin = `http://127.0.0.1:${modelServer.address().port}/v1`;
}
async function launchNative() {
    const child = spawn(executable, ['--data', data, '--ui', path.join(project, 'ui'), '--port', '0', '--wsl', wsl, '--sandbox-distro', distro, '--desktop-helper', helper],
        { cwd: output, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp') } });
    const entry = { child, stdout: '', stderr: '', port: null }; processes.push(entry);
    child.stdout.on('data', bytes => { entry.stdout += bytes; for (const line of entry.stdout.split(/\r?\n/)) { try { const row = JSON.parse(line); if (row.ready) entry.port = row.port; } catch {} } });
    child.stderr.on('data', bytes => { entry.stderr += bytes; }); child.on('error', error => { entry.error = error; });
    await until(() => { if (entry.error) throw Object.assign(entry.error, { fatal: true }); assert.equal(child.exitCode, null, 'native remains running'); return entry.port; }, 'native vision ready');
    entry.origin = `http://127.0.0.1:${entry.port}`; app = entry;
}
async function closeNative() {
    if (!app || app.child.exitCode !== null) return;
    app.child.stdin.end('shutdown\n'); await until(() => app.child.exitCode !== null, 'native orderly shutdown', 15000); assert.equal(app.child.exitCode, 0);
}
async function setupCase(tag, responses = false, mode = 'normal') {
    const c = { tag, responses, mode, botId: `${runStamp}-${tag.replaceAll('_', '-')}`, text: `完整中文输入：你好，桌面！ ${tag}`, identity: responses ? [45, 75, 235] : [230, 45, 70], stage: 'status', waitFrames: 0, imageObservations: [], sent: [] };
    cases.set(tag, c);
    await api('/api/dimension/bots', { id: c.botId, name: `Synthetic vision ${tag}`, persona: 'Synthetic offline vision test only.' });
    await api(`/api/dimension/bots/${c.botId}/conversation-model`, { modelSelection: { providerId: responses ? 'vision-responses' : 'vision-chat', model: 'vision-fixture' } });
    await api('/api/dimension/work/settings', { botId: c.botId, networkAccess: false }, 'PATCH');
    const current = await state(c); c.workspace = current.workspace;
    const relative = path.relative(output, c.workspace); assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await writeFile(path.join(c.workspace, 'fixture.html'), htmlFixture(c), 'utf8');
    await writeFile(path.join(c.workspace, 'freeze-helper.py'), freezer, 'utf8');
    return c;
}
async function submit(c) {
    const result = await api('/api/dimension/work/runs', { botId: c.botId, text: `VISION:${c.tag} Find the pink target from real pixels, click it, type ${c.text}, press Return, capture and verify.`, requestId: `${runStamp}-${c.tag}` });
    c.runId = result.run.id; return result;
}
async function gateFor(c, label) { return until(() => { if (modelErrors.length) throw Object.assign(Error(modelErrors.at(-1)), { fatal: true }); return c.gate?.label === label && !c.gate.closed ? c.gate : null; }, `${c.tag} ${label}`, 70000); }
async function journal(c) {
    const folder = path.join(data, 'work-runs/runs', c.runId, 'events'), rows = [];
    for (const file of (await readdir(folder)).filter(name => name.endsWith('.jsonl')).sort()) {
        const text = await readFile(path.join(folder, file), 'utf8'); noPixels(text, `${c.tag} event journal`);
        for (const line of text.split('\n')) if (line.trim()) rows.push(JSON.parse(line));
    }
    return rows;
}
const canonical = value => JSON.stringify(value, Object.keys(value).sort());
function matchingAction(event, toolArgs) {
    if (event.type !== 'tool_started' || event.data?.call?.name !== 'desktop_action') return false;
    const raw = event.data.call.arguments; return canonical(typeof raw === 'string' ? JSON.parse(raw) : raw) === canonical(toolArgs);
}
async function verifyDelivery(c) {
    const run = await terminal(c); noPixels(run, `${c.tag} GET run`);
    const result = await api(`/api/dimension/work/tasks/${c.runId}/artifacts`); assert.equal(result.files.length, 1); assert.equal(result.files[0].available, true);
    const response = await fetch(app.origin + result.files[0].url); assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer()), observed = imageObservation(bytes, c);
    assert(observed.done && observed.identity, 'Downloaded artifact contains real full Chinese/Return success pixels for this Bot');
    assert.equal(observed.sha256, c.captureSha256); assert(c.evidence.verification.includes(observed.sha256));
    assert.equal(digest(await readFile(result.files[0].path)), observed.sha256);
    await writeFile(path.join(output, `${c.tag}-download.png`), bytes); c.artifact = { ...result.files[0], sha256: observed.sha256 };
    return run;
}
async function hygiene(c) {
    noPixels(await getRun(c), `${c.tag} public run`);
    const snapshot = await readFile(path.join(data, 'work-runs/runs', c.runId, 'snapshot.json'), 'utf8'); noPixels(snapshot, `${c.tag} snapshot`);
    await journal(c);
    const response = await fetch(app.origin + `/api/dimension/work/runs/${c.runId}/events?after=0`, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200); const events = await response.text(); noPixels(events, `${c.tag} public SSE`);
    await writeFile(path.join(output, `${c.tag}-public-events.txt`), events, 'utf8');
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
  try: wait=open('/proc/'+name+'/wchan').read().strip()
  except OSError: wait=''
  rows.append({'pid':int(name),'ppid':int(fields[1]),'starttime':fields[19],'state':fields[0],'namespace':ns,'comm':raw[raw.find('(')+1:end],'command':cmd,'waitChannel':wait,'residentPages':fields[21]})
 except (OSError,ValueError,IndexError):pass
print(json.dumps({'host':os.readlink('/proc/self/ns/pid'),'rows':rows,'memory':open('/proc/meminfo').read(),'load':open('/proc/loadavg').read().strip()}))
`;
async function linuxSnapshot(label) {
    const result = await promisify(execFile)(wsl, ['-d', distro, '--exec', '/usr/bin/python3', '-c', processProbe], { cwd: output, windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 15000 });
    const { rows, host, memory, load } = JSON.parse(result.stdout), byPid = new Map(rows.map(row => [row.pid, row])), selected = new Map();
    for (const c of cases.values()) {
        let tracker = trackers.get(c.tag); if (!tracker) { tracker = { known: new Map(), namespaces: new Set() }; trackers.set(c.tag, tracker); }
        const roots = new Set([...tracker.known.values()].filter(row => byPid.get(row.pid)?.starttime === row.starttime).map(row => row.pid));
        const workspace = c.workspace && '/mnt/' + c.workspace[0].toLowerCase() + c.workspace.slice(2).replaceAll('\\', '/');
        for (const row of rows) if (workspace && row.command.includes(workspace) && /(?:^|\/)bwrap\s/.test(row.command)) roots.add(row.pid);
        const rememberNs = row => { if (row.namespace && row.namespace !== host) tracker.namespaces.add(row.namespace); };
        for (const pid of roots) rememberNs(byPid.get(pid));
        let added; do { added = false; for (const row of rows) if (!roots.has(row.pid) && (roots.has(row.ppid) || tracker.namespaces.has(row.namespace))) { roots.add(row.pid); rememberNs(row); added = true; } } while (added);
        for (const row of rows) if (roots.has(row.pid)) { tracker.known.set(`${row.pid}:${row.starttime}`, row); selected.set(`${row.pid}:${row.starttime}`, { ...row, tag: c.tag }); }
    }
    const current = [...selected.values()]; linuxHistory.push({ label, at: Date.now(), memory, load, processes: current }); return current;
}
async function stopDesktop(c) { await api(desktop(c) + '/stop', {}); await until(async () => !(await state(c)).running, `${c.tag} desktop stopped`); }
async function armAndBlock(c) {
    const gate = await gateFor(c, 'before-frozen-action');
    await linuxSnapshot(`${c.tag}-before-freeze`);
    c.blockedAction = { op: 'press', key: 'Return', observationId: gate.latest.summary.observationId };
    await writeFile(path.join(c.workspace, 'arm-freeze'), 'synthetic test only');
    c.frozen = await until(async () => { try { return JSON.parse(await readFile(path.join(c.workspace, 'frozen.json'), 'utf8')); } catch { return false; } }, `${c.tag} helper stopped by its own test child`);
    c.stage = 'await-cancel-or-steer'; gate.emit('desktop_action', c.blockedAction, c.stage);
    await until(async () => (await journal(c)).some(event => matchingAction(event, c.blockedAction) && event.data.willExecute), `${c.tag} blocked keyboard action started`);
    await delay(100);
}

await mkdir(path.join(output, 'temp'), { recursive: true });
const fingerprints = {};
try {
    for (const [name, file] of [['native', executable], ['helper', helper]]) fingerprints[name] = { path: file, sha256: digest(await readFile(file)) };
    await startModel(); await launchNative();
    for (const [name, kind] of [['vision-chat', 'openai-chat-compat'], ['vision-responses', 'openai-responses-compat']]) {
        await api('/api/providers', { name, entry: { kind, baseUrl: modelOrigin, spec: { model: 'vision-fixture', maxTokens: 4096 } }, secretValue: secret });
    }
    await api('/api/dimension/work-models', { settings: { enabled: false, routes: {} } }, 'PUT');
    await api('/api/dimension/work/software', { apps: [
        { id: 'vision-chrome', name: 'Synthetic offline vision Chrome', executable: '/usr/bin/google-chrome', args: ['--enable-logging', '--log-file=/workspace/chrome.log', '--kiosk', 'file:///workspace/fixture.html'] },
        { id: 'vision-freeze', name: 'Synthetic isolated helper cancellation fixture', executable: '/usr/bin/python3', args: ['/workspace/freeze-helper.py'] },
    ] }, 'PUT');

    if (selectedCases.has('main')) {
    const a = await setupCase('parallel_chat'), b = await setupCase('parallel_responses', true);
    await Promise.all([submit(a), submit(b)]); await Promise.all([verifyDelivery(a), verifyDelivery(b)]);
    assert(records.some(x => x.tag === a.tag && records.some(y => y.tag === b.tag && x.started < y.ended && y.started < x.ended)), 'Two Bots have overlapping real model transactions');
    assert.notEqual(a.chosenPoint.imageSha256, b.chosenPoint.imageSha256);
    await linuxSnapshot('parallel-real-desktops');
    for (const c of [a, b]) { assert(c.chosenPoint); await hygiene(c); await stopDesktop(c); }
    pass('Chat Completions and Responses each receive real PNGs, infer random target coordinates, type complete Chinese/Return, capture, finish and download verified images', { chat: a.chosenPoint, responses: b.chosenPoint });
    pass('Two Bot Work/model/desktop paths execute concurrently without exchanging image identity or input', { bots: [a.botId, b.botId] });
    }

    if (selectedCases.has('human')) {
    const human = await setupCase('human', false, 'human'); await submit(human); const gate = await gateFor(human, 'before-human-observe');
    await api(desktop(human) + '/control', { human: true });
    gate.emit('desktop_observe', {}, 'await-human-pause');
    await terminal(human, 'interrupted'); const count = records.filter(row => row.tag === human.tag).length;
    await delay(250); assert.equal(records.filter(row => row.tag === human.tag).length, count, 'No model generation after takeover interruption');
    const pausedJournal = await journal(human), denied = pausedJournal.findLast(row => row.type === 'tool_result' && row.data?.call?.name === 'desktop_observe');
    assert(denied?.data.execution.error); noPixels(denied, 'human takeover result');
    await api(desktop(human) + '/control', { human: false }); human.humanResumed = true; human.stage = 'resume-observe';
    await api(`/api/dimension/work/runs/${human.runId}/resume`, { requestId: `${human.tag}-resume`, text: 'CONTINUE after returning control' });
    await verifyDelivery(human); await hygiene(human); await stopDesktop(human);
    pass('Human takeover denies a fresh observation, interrupts Work without another model call, and resumes only after control is returned');
    }

    if (selectedCases.has('restart')) {
    const restart = await setupCase('restart_success', true, 'restart'); await submit(restart);
    const restartGate = await gateFor(restart, 'before-restart');
    await linuxSnapshot('before-successful-restart'); await closeNative(); await until(() => restartGate.record.aborted, 'shutdown aborts held synthetic model');
    await launchNative(); assert.equal((await getRun(restart)).status, 'interrupted'); assert.equal((await state(restart)).running, false);
    restart.stage = 'replay-success'; restart.restarted = true;
    await api(`/api/dimension/work/runs/${restart.runId}/resume`, { requestId: `${restart.tag}-resume`, text: 'CONTINUE without repeating the completed keyboard action' });
    await verifyDelivery(restart); assert(restart.successReplayObserved);
    const replayRows = (await journal(restart)).filter(event => matchingAction(event, restart.successfulAction));
    assert.equal(replayRows.filter(event => event.data.willExecute).length, 1); assert(replayRows.some(event => event.data.reused));
    assert.equal((await state(restart)).running, false, 'Receipt reuse did not relaunch or send input to a desktop'); await hygiene(restart);
    pass('Native restart preserves successful keyboard receipts and artifact verification, without persisting pixels or replaying input');
    }

    if (selectedCases.has('cancel')) {
    const cancel = await setupCase('cancel_uncertain', false, 'cancel'); await submit(cancel); await armAndBlock(cancel);
    const cancelStart = performance.now(); await api(`/api/dimension/work/runs/${cancel.runId}/cancel`, {}); await terminal(cancel, 'cancelled', 10000);
    cancel.cancelMilliseconds = performance.now() - cancelStart;
    assert(cancel.cancelMilliseconds <= 3500, `Frozen-helper cancellation exceeded the 3500ms fault-test bound: ${cancel.cancelMilliseconds}ms`);
    assert.equal((await state(cancel)).running, false);
    const afterCancel = await linuxSnapshot('after-in-flight-cancel'); assert(!afterCancel.some(row => row.tag === cancel.tag), 'Canceled stopped helper and all tracked namespace children');
    await closeNative(); await launchNative(); cancel.restarted = true; cancel.stage = 'replay-uncertain';
    await api(`/api/dimension/work/runs/${cancel.runId}/resume`, { requestId: `${cancel.tag}-resume`, text: 'CONTINUE and refuse repeating the uncertain keyboard action' });
    await verifyDelivery(cancel); assert(cancel.uncertainReplayObserved);
    const cancelledRows = (await journal(cancel)).filter(event => matchingAction(event, cancel.blockedAction));
    assert.equal(cancelledRows.filter(event => event.data.willExecute).length, 1); assert(cancelledRows.some(event => !event.data.willExecute));
    assert.equal((await state(cancel)).running, false); await hygiene(cancel);
    pass('Cancel interrupts in-flight keyboard I/O promptly; after restart the uncertain action is refused instead of replayed', { milliseconds: cancel.cancelMilliseconds });
    }

    if (selectedCases.has('steer')) {
    const steer = await setupCase('steer_uncertain', true, 'steer'); await submit(steer); await armAndBlock(steer);
    steer.stage = 'replay-uncertain'; const steerStart = performance.now();
    const steered = await api('/api/dimension/work/runs', { botId: steer.botId, text: 'STEER_CHANGE: stop the pending key and keep the previous verified capture', requestId: `${steer.tag}-supplement` });
    assert.equal(steered.run.id, steer.runId); assert.equal(steered.supplemented, true);
    await until(async () => !(await state(steer)).running, 'steering stops the blocked desktop', 10000);
    steer.cancelMilliseconds = performance.now() - steerStart; assert(steer.cancelMilliseconds <= 3500, `Steering cancellation took ${steer.cancelMilliseconds}ms`);
    await verifyDelivery(steer); assert(steer.uncertainReplayObserved);
    const steeredRows = (await journal(steer)).filter(event => matchingAction(event, steer.blockedAction));
    assert.equal(steeredRows.filter(event => event.data.willExecute).length, 1); await hygiene(steer);
    pass('Steering cancels an in-flight desktop action in the same run and does not replay its uncertain keyboard request', { milliseconds: steer.cancelMilliseconds });
    }

    for (const c of cases.values()) { await hygiene(c); await stopDesktop(c); }
    assert.deepEqual(modelErrors, []);
    if ([...cases.values()].some(c => c.responses)) assert(records.some(row => row.protocol === 'responses' && row.images.length));
    if ([...cases.values()].some(c => !c.responses)) assert(records.some(row => row.protocol === 'chat-completions' && row.images.length));
    pass('Images travel in actual multimodal model requests while tool JSON, public GET/SSE, durable events and snapshots remain free of PNG base64');
    const remaining = await linuxSnapshot('final'); assert.deepEqual(remaining, []);
    pass('All test desktop processes are gone by PID/starttime and private PID namespace identity');
    successful = true;
} catch (error) {
    failures.push(error.stack); console.error(error.stack); process.exitCode = 1;
} finally {
    if (app?.child.exitCode === null) {
        for (const c of cases.values()) {
            if (c.runId) await api(`/api/dimension/work/runs/${c.runId}/cancel`, {}).catch(() => {});
            if (c.workspace) await stopDesktop(c).catch(error => failures.push(`Cleanup ${c.tag}: ${error.message}`));
        }
        await until(async () => (await linuxSnapshot('cleanup-final')).length === 0, 'tracked Linux processes drained during cleanup', 3000).catch(error => failures.push(error.message));
    }
    await closeNative().catch(error => failures.push(error.message));
    for (const entry of processes) if (entry.child.pid && entry.child.exitCode === null) {
        await promisify(execFile)('taskkill', ['/PID', String(entry.child.pid), '/T', '/F'], { cwd: output, windowsHide: true }).catch(() => {});
    }
    if (modelServer) { modelServer.closeAllConnections(); await new Promise(resolve => modelServer.close(resolve)); }
    for (let index = 0; index < processes.length; index++) await writeFile(path.join(output, `native-${index}.log`), processes[index].stdout + '\nSTDERR\n' + processes[index].stderr, 'utf8');
    successful &&= failures.length === 0 && modelErrors.length === 0;
    if (!successful) process.exitCode = 1;
    const caseReports = [...cases.values()].map(({ gate, evidence, ...c }) => ({ ...c, verification: evidence?.verification, artifacts: evidence?.artifacts }));
    const report = { ok: successful, selectedCases: [...selectedCases], checks, failures, modelErrors, records, cases: caseReports, linuxHistory, fingerprints,
        windowsProcesses: processes.map(entry => ({ pid: entry.child.pid, exitCode: entry.child.exitCode, signal: entry.child.signalCode })),
        scope: 'Synthetic offline pages and loopback model protocols only. No real accounts, external services, production data, or UI/backend edits.',
        cancellationThreshold: 'Frozen-helper fault: 3500ms upper bound, including 500ms ACK drain, 2000ms EOF grace and scheduling allowance. Actual measured durations are reported.' };
    noPixels(report, 'test report');
    await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify({ ok: successful, checks: checks.length, output }));
}
