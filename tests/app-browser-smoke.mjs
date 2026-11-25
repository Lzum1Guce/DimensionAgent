// Real retained UI + native server + local model fixture. No application API
// interception/mocking, user browser profile, account data or external services.
// node tests/app-browser-smoke.mjs [native-exe] [retained-ui-directory] [output-directory]
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultExe = existsSync(join(project, 'build/DImensionagent-native.exe'))
    ? join(project, 'build/DImensionagent-native.exe')
    : join(project, 'outputs/build/DImensionagent-native.exe');
const executable = resolve(process.argv[2] || defaultExe);
const uiDirectory = resolve(process.argv[3] || join(project, 'ui'));
const outputRoot = resolve(process.argv[4] || join(project, 'outputs/phase2-browser'));
assert.match(outputRoot, /^L:[\\/]/i, 'Browser test output must remain on L:');
const outputDirectory = join(outputRoot, new Date().toISOString().replace(/[:.]/g, '-'));
const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const alpha = 'browser-alpha';
const beta = 'browser-beta';
const providerId = 'browser-fixture';
const children = [];
const network = [];
const websocketFrames = [];
const exceptions = [];
const blockedExternal = [];
const checks = [];
const shots = [];
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let origin;
let cdp;
let chrome;

async function waitFor(predicate, label, timeout = 12000) {
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
        try { const result = await predicate(); if (result) return result; }
        catch (error) { lastError = error; }
        await delay(75);
    }
    throw new Error(`Timed out: ${label}${lastError ? ` (${lastError.message})` : ''}`);
}

function startProcess(label, command, args) {
    const process = spawn(command, args, { windowsHide: true, cwd: outputDirectory, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...globalThis.process.env, TEMP: join(outputDirectory, 'temp'), TMP: join(outputDirectory, 'temp') } });
    const item = { label, process, records: [], stdout: '', stderr: '' };
    process.stdout.on('data', data => { item.stdout += data; });
    process.stderr.on('data', data => { item.stderr += data; });
    const lines = createInterface({ input: process.stdout });
    lines.on('line', line => { try { item.records.push(JSON.parse(line)); } catch {} });
    process.on('exit', () => lines.close());
    children.push(item);
    return item;
}

async function api(path, { method = 'GET', body } = {}) {
    const response = await fetch(origin + path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const text = await response.text();
    assert(response.ok, `${method} ${path}: ${response.status} ${text}`);
    return text ? JSON.parse(text) : null;
}

class Cdp {
    constructor(socket) {
        this.socket = socket;
        this.sequence = 0;
        this.pending = new Map();
        this.listeners = new Map();
        socket.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (message.id) {
                const item = this.pending.get(message.id);
                if (!item) return;
                this.pending.delete(message.id); clearTimeout(item.timer);
                if (message.error) item.reject(new Error(JSON.stringify(message.error)));
                else item.resolve(message.result);
            } else for (const handler of this.listeners.get(message.method) ?? []) {
                Promise.resolve(handler(message.params)).catch(error => exceptions.push({ source: 'cdp-handler', message: error.message }));
            }
        });
        socket.addEventListener('close', () => {
            for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('CDP connection closed')); }
            this.pending.clear();
        });
    }
    static async connect(url) {
        const socket = new WebSocket(url);
        await once(socket, 'open');
        return new Cdp(socket);
    }
    on(method, handler) {
        const handlers = this.listeners.get(method) ?? [];
        handlers.push(handler); this.listeners.set(method, handlers);
    }
    call(method, params = {}) {
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timeout`)); }, 15000);
            this.pending.set(id, { resolve, reject, timer });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }
    async evaluate(expression) {
        const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
    }
}

async function visible(selector) {
    return cdp.evaluate(`(() => { const node=document.querySelector(${JSON.stringify(selector)}); return !!node && !node.hidden && node.getBoundingClientRect().width>0 && node.getBoundingClientRect().height>0; })()`);
}
async function click(selector) {
    await waitFor(() => visible(selector), `visible ${selector}`);
    let previous;
    const position = await waitFor(async () => {
        const point = await cdp.evaluate(`(() => { const node=document.querySelector(${JSON.stringify(selector)}); if(!node)return null; node.scrollIntoView({block:'center',inline:'nearest'}); const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2; const top=document.elementFromPoint(x,y); return x>=0&&x<innerWidth&&y>=0&&y<innerHeight&&top&&(top===node||node.contains(top))?{x,y}:null; })()`);
        const stable = point && previous && Math.abs(point.x - previous.x) < 0.5 && Math.abs(point.y - previous.y) < 0.5;
        previous = point;
        return stable ? point : null;
    }, `stable clickable ${selector}`);
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...position });
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...position });
}
async function fill(selector, text) {
    await click(selector);
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await cdp.call('Input.insertText', { text });
}
async function select(selector, value) {
    await waitFor(() => visible(selector), `visible ${selector}`);
    await cdp.evaluate(`(() => { const node=document.querySelector(${JSON.stringify(selector)}); node.value=${JSON.stringify(value)}; node.dispatchEvent(new Event('change',{bubbles:true})); })()`);
}
async function escape() {
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
}
async function screenshot(name) {
    await delay(150);
    const { data } = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const path = join(outputDirectory, `${name}.png`);
    await writeFile(path, Buffer.from(data, 'base64'));
    shots.push(path);
}
function pass(name) { checks.push(name); console.log(`PASS ${name}`); }

async function seedChatHistory(count) {
    const websocket = new WebSocket(origin.replace('http:', 'ws:') + '/ws/providers/world%3Aconsole/panels/chat');
    const replies = [];
    websocket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.type === 'msg' && message.role === 'assistant' && !message.history) replies.push(message);
        if (message.type === 'request.error') exceptions.push({ source: 'history-fixture', message: message.text });
    });
    await once(websocket, 'open');
    websocket.send(JSON.stringify({ type: 'hello', botId: alpha, historyLimit: 1 }));
    for (let i = 0; i < count; i++) {
        websocket.send(JSON.stringify({ type: 'msg', botId: alpha, text: `APPTEST:history${String(i).padStart(2, '0')}`, requestId: `browser-history-${i}` }));
        await waitFor(() => replies.length > i, `synthetic history reply ${i}`);
    }
    websocket.close();
    await once(websocket, 'close');
}

async function shutdown(item) {
    if (item.process.exitCode !== null) return;
    const exit = once(item.process, 'exit');
    if (item.label === 'chrome') {
        if (cdp) await cdp.call('Browser.close').catch(() => {});
    } else item.process.stdin.end('shutdown\n');
    const stopped = await Promise.race([exit.then(() => true), delay(4000).then(() => false)]);
    if (!stopped) await new Promise(resolve => execFile('taskkill', ['/PID', String(item.process.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
}

await mkdir(join(outputDirectory, 'temp'), { recursive: true });
let success = false;
try {
    const model = startProcess('model-fixture', process.execPath, [join(project, 'tests/app-integration.mjs'), '--fixture-only', '--verify-retry']);
    const modelReady = await waitFor(() => model.records.find(record => record.baseUrl), 'local model fixture ready');
    const server = startProcess('native', executable, ['--data', join(outputDirectory, 'data'), '--ui', uiDirectory, '--port', '0']);
    const ready = await waitFor(() => server.records.find(record => record.ready), 'native server ready');
    origin = `http://127.0.0.1:${ready.port}`;
    await api(`/api/providers/${providerId}/save`, { method: 'POST', body: { name: providerId,
        entry: { kind: 'openai-chat-compat', baseUrl: modelReady.baseUrl, spec: { model: 'fixture-flash', maxTokens: 4096 } }, secretValue: 'synthetic-key' } });
    for (const [id, name] of [[alpha, '原生测试甲'], [beta, '原生测试乙']]) {
        await api('/api/dimension/bots', { method: 'POST', body: { id, name, persona: 'Synthetic browser test only.', paperSeal: { shape: 'round-seal', color: 'persimmon' } } });
        const roster = await api(`/api/dimension/bots/${encodeURIComponent(id)}/roster`, { method: 'PATCH', body: { mode: 'work', present: true } });
        assert.equal(roster.bot.id, id);
        assert.equal(roster.bot.work, true);
        assert.equal(roster.bots.find(bot => bot.id === id)?.work, true);
        await api('/api/dimension/work/settings', { method: 'PATCH', body: { botId: id, cliEngine: 'builtin', workspaceMode: 'windows_native', projectCwd: outputDirectory, approvalMode: 'full' } });
    }

    const profile = join(outputDirectory, 'chrome-profile');
    chrome = startProcess('chrome', chromePath, ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
        `--user-data-dir=${profile}`, '--window-size=1440,1000', '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-extensions',
        '--disable-client-side-phishing-detection', '--disable-breakpad', '--disable-features=OptimizationHints,MediaRouter',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', 'about:blank']);
    const debugPort = await waitFor(async () => {
        const text = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
        return Number(text.split('\n')[0]);
    }, 'isolated Chrome debugging port');
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const target = targets.find(target => target.type === 'page');
    assert(target, 'Chrome page target exists');
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    cdp.on('Runtime.exceptionThrown', value => exceptions.push({ source: 'browser', message: value.exceptionDetails.exception?.description || value.exceptionDetails.text }));
    cdp.on('Network.responseReceived', value => network.push({ url: value.response.url, status: value.response.status, type: value.type }));
    for (const [method, direction] of [['Network.webSocketFrameSent', 'sent'], ['Network.webSocketFrameReceived', 'received']]) {
        cdp.on(method, value => websocketFrames.push({ direction, requestId: value.requestId, timestamp: value.timestamp, payload: value.response.payloadData }));
    }
    cdp.on('Fetch.requestPaused', async value => {
        const url = new URL(value.request.url);
        if (['data:', 'blob:', 'about:'].includes(url.protocol) || ['127.0.0.1', 'localhost'].includes(url.hostname)) {
            await cdp.call('Fetch.continueRequest', { requestId: value.requestId });
        } else {
            blockedExternal.push(value.request.url);
            await cdp.call('Fetch.failRequest', { requestId: value.requestId, errorReason: 'BlockedByClient' });
        }
    });
    await cdp.call('Page.enable');
    await cdp.call('Runtime.enable');
    await cdp.call('Network.enable');
    await cdp.call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    // Bootstrap must use the authoritative rosters saved through the native API.
    await cdp.call('Page.navigate', { url: origin + '/dimension-ui/' });
    await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('#botList .bot-item[data-id="${alpha}"]')) && Boolean(document.querySelector('#botList .bot-item[data-id="${beta}"]')) && !window.__bootErr`), 'real frontend bootstrap');
    assert(await visible('.conversation-welcome'));
    assert.equal(await cdp.evaluate(`document.querySelector('#sendBtn').disabled`), true);
    await screenshot('01-empty-selection');
    pass('Initial empty selection keeps the welcome view and disabled send button');

    const viewport = width => cdp.call('Emulation.setDeviceMetricsOverride', {width, height:1000, deviceScaleFactor:1, mobile:false});
    await viewport(900);
    await waitFor(()=>visible('#sidebarExpandBtn'),'narrow sidebar defaults to collapsed');
    await click('#sidebarExpandBtn');
    await viewport(1440); await viewport(800);
    await waitFor(()=>cdp.evaluate("!document.querySelector('#app').classList.contains('is-sidebar-collapsed')"),'manual narrow sidebar preference');
    await cdp.call('Page.reload');
    await waitFor(()=>visible('#botList .bot-item') ,'expanded narrow sidebar survives reload');
    await viewport(1440);
    pass('Narrow layout collapses by default and preserves manual expansion');

    await click(`#botList [data-id="${alpha}"]`);
    await waitFor(() => cdp.evaluate(`document.querySelector('#identityName').textContent.includes('原生测试甲') && !document.querySelector('.conversation-welcome')`), 'select synthetic bot');
    await waitFor(async () => (await cdp.evaluate(`document.querySelector('#modelReady').hidden`))
        && websocketFrames.some(frame => frame.direction === 'sent' && frame.payload.includes('"type":"hello"') && frame.payload.includes(alpha)), 'activated Chat WebSocket ready');
    await fill('#composerInput', 'APPTEST:browserchat');
    await waitFor(() => cdp.evaluate(`!document.querySelector('#sendBtn').disabled`), 'Chat send enabled');
    await click('#sendBtn');
    await waitFor(() => cdp.evaluate(`document.querySelector('#transcript').textContent.includes('Chat reply browserchat 🙂')`), 'real WebSocket chat reply');
    const chatText = await cdp.evaluate(`document.querySelector('#transcript').textContent`);
    assert(!chatText.includes('THINKING_ONLY'));
    assert.equal(await cdp.evaluate(`document.querySelectorAll('#transcript .work-process').length`), 0);
    await screenshot('02-chat-reply');
    pass('Chat sends through the native WebSocket/model path and hides model thinking');

    await click('#chatSearchBtn');
    await fill('#chatSearchInput', 'browserchat');
    await waitFor(() => cdp.evaluate(`document.querySelector('#chatSearchResults .chat-search-hit-text')?.textContent.includes('browserchat')`), 'search current chat history');
    await click('#chatSearchClose');
    assert.equal(await visible('#chatSearchResults'), false);
    pass('Current conversation search opens the matching history and closes cleanly');

    await seedChatHistory(17);
    await click(`#botList [data-id="${beta}"]`);
    await waitFor(() => cdp.evaluate(`document.querySelector('#identityName').textContent.includes('原生测试乙')`), 'second bot selection');
    assert(!(await cdp.evaluate(`document.querySelector('#transcript').textContent`)).includes('browserchat'));
    await click(`#botList [data-id="${alpha}"]`);
    await waitFor(() => visible('.chat-history-more'), 'paged chat history control');
    const chatBefore = await cdp.evaluate(`document.querySelectorAll('#transcript .bubble').length`);
    await click('.chat-history-more');
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('#transcript .bubble').length>${chatBefore}`), 'older chat page appended');
    assert((await cdp.evaluate(`document.querySelector('#transcript').textContent`)).includes('APPTEST:browserchat'));
    await screenshot('03-chat-history');
    pass('Bot switching isolates conversations; older Chat history loads through its cursor API');

    await click('[data-shell-target="work"]');
    await waitFor(() => cdp.evaluate(`document.querySelector('#modeSwitch').textContent==='Work'`), 'Work mode');
    await waitFor(() => visible('.work-new-thread-stage'), 'Chat selection opens a fresh Work thread');
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.work-run').length`), 0);
    await fill('#composerInput', '直接做，不用先出计划 APPTEST:browser');
    await click('#sendBtn');
    const run = await waitFor(async () => {
        const sessions = await api(`/api/dimension/work/sessions?botId=${alpha}&limit=10`);
        const row = sessions.runs.find(row => row.text === '直接做，不用先出计划 APPTEST:browser');
        if (row && ['failed', 'partial', 'cancelled'].includes(row.status)) throw new Error(JSON.stringify(row));
        return row?.status === 'completed' ? row : null;
    }, 'browser submitted Work task completes', 25000);
    const runSelector = `.work-run[data-run-id="${run.id}"]`;
    await waitFor(() => visible(`${runSelector} .deliverable-name`), 'verified Work artifact');
    assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(runSelector+' .deliverable-tree-path')}).textContent`), 'deliveries/browser.txt');
    const artifacts = await api(`/api/dimension/work/tasks/${run.id}/artifacts`);
    assert.equal(artifacts.files.length, 1);
    const artifact = artifacts.files[0];
    assert.equal(await (await fetch(origin + artifact.url)).text(), 'Delivered by browser\n猫🙂\n');
    await waitFor(()=>cdp.evaluate(`(()=>{const steps=[...document.querySelectorAll('#workDock .work-tri-step')];
      return ['failed','completed'].every(st=>steps.some(row=>row.classList.contains('status-'+st) && row.textContent.includes('核验文件')));})()`),
      'completed run retains the failed verification and its successful retry');
    pass('Work overview preserves failed and successful verification attempts separately');
    const artifactPath = resolve(artifact.path);
    assert(artifactPath.startsWith(resolve(outputDirectory) + (process.platform === 'win32' ? '\\' : '/')));
    const originalBytes = await readFile(artifactPath);
    try {
        await writeFile(artifactPath,Buffer.alloc(9 * 1024 * 1024));
        await click(runSelector + ' [data-action="handoff"]');
        const dialog = '.work-handoff-dialog[open]';
        await waitFor(()=>cdp.evaluate(`document.querySelector('${dialog}')?.textContent.includes('超过单文件上限：browser.txt')`),'actual oversized attachment named before export');
        await click(dialog + ' footer .is-primary');
        await waitFor(()=>cdp.evaluate(`document.querySelector('${dialog} [role=status]')?.textContent.includes('单个附件超过 8 MiB')`),'backend rejects single file below package limit');
        await click(dialog + ' input[type=checkbox]');
        await waitFor(()=>cdp.evaluate(`document.querySelector('${dialog}')?.textContent.includes('已选 0 个附件')`),'metadata-only selection');
        await escape();
    } finally { await writeFile(artifactPath,originalBytes); }
    pass('Handoff names a 9 MiB file and distinguishes attachment and package limits');

    const rollup = runSelector + ' .wrs-body';
    const before = await visible(rollup);
    await click(runSelector + ' .wrs-work-header');
    assert.equal(await visible(rollup), !before);
    if (before) await click(runSelector + ' .wrs-work-header');
    await screenshot('04-work-process');
    await click(runSelector + ' .deliverable-actions button.deliverable-btn:not(.is-primary)');
    await waitFor(() => cdp.evaluate(`document.querySelector('#workDock .work-dock-code')?.textContent === 'Delivered by browser\\n猫🙂\\n'`), 'preview contains complete UTF-8 artifact');
    await screenshot('05-artifact-preview');
    await escape();
    await waitFor(() => cdp.evaluate(`document.querySelector('#workDock').hidden`), 'Escape closes preview');
    pass('Work completes with a UTF-8 deliverable, expandable process and actual dock preview');

    for (let i = 0; i < 5; i++) {
        const task = await api('/api/dimension/work/runs', { method: 'POST', body: { botId: alpha, text: `APPTEST:older${i}`, requestId: `browser-older-${i}`, deliveryMode: 'queue' } });
        await waitFor(async () => (await api(`/api/dimension/work/runs/${task.run.id}`)).status === 'completed', `history Work task ${i}`);
    }
    await click(`.wrt-owner-btn[data-id="${beta}"]`);
    await waitFor(() => cdp.evaluate(`document.querySelector('#identityName').textContent.includes('原生测试乙')`), 'Work bot isolation');
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.work-run').length`), 0);
    await click(`.wrt-owner-btn[data-id="${alpha}"]`);
    const olderRow = `.wrt-thread[data-run-id="${run.id}"] .wrt-thread-btn`;
    await waitFor(() => visible(olderRow), 'older work remains available in the project tree');
    await click(olderRow);
    await waitFor(() => visible(runSelector), 'selected historical run restored');
    await screenshot('06-work-history');
    await click('[data-shell-target="chat"]');
    await waitFor(() => cdp.evaluate(`document.querySelector('#modeSwitch').textContent==='Chat' && document.querySelector('#transcript').textContent.includes('Chat reply')`), 'restore Chat conversation after Work');
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.work-run').length`), 0);
    pass('Work sessions stay isolated, older runs reopen from the project tree, and mode switching restores Chat');

    await click('#contextUsageBtn');
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.cs-pane[data-cs-pane="context"] input[type=number]').length===4 && !document.querySelector('.cs-pane[data-cs-pane="context"] input').disabled`), 'context settings loaded');
    const contextLabels = await cdp.evaluate(`document.querySelector('.cs-pane[data-cs-pane="context"]').textContent`);
    assert(!contextLabels.includes('undefined') && !contextLabels.includes('NaN'));
    await fill('.cs-pane[data-cs-pane="context"] input[name="chat"]', '49152');
    await click('.cs-pane[data-cs-pane="context"] button[type="submit"]');
    await waitFor(() => cdp.evaluate(`document.querySelector('.context-status').textContent.includes('已保存')`), 'context save confirmed');
    assert.equal((await api('/api/dimension/context-limits')).limits.chat, 49152);
    await click('.context-reset');
    await click('.cs-pane[data-cs-pane="context"] button[type="submit"]');
    await waitFor(async () => (await api('/api/dimension/context-limits')).limits.chat === 32768, 'context recommended values saved');
    await screenshot('07-context-settings');
    await escape();
    if (await cdp.evaluate(`document.querySelector('#identityBtn').getAttribute('aria-expanded')==='true'`)) await click('#identityBtn');
    pass('Context labels, edits and recommended values round-trip through the real settings API');

    await click('#openPublicWorkbenchBtn');
    await click('#sharedWorkModelsBtn');
    const modelDialog = '.work-model-dialog:not(.context-dialog)[open]';
    await waitFor(() => cdp.evaluate(`!!document.querySelector(${JSON.stringify(modelDialog + ' select[name="simple"]')}) && !document.querySelector(${JSON.stringify(modelDialog + ' select[name="simple"]')}).disabled`), 'model routing settings loaded');
    await select(`${modelDialog} select[name="simple"]`, '');
    await click(`${modelDialog} button[type="submit"]`);
    await waitFor(() => cdp.evaluate(`document.querySelector('.wm-status').textContent.includes('已保存')`), 'model routing saved');
    assert.equal((await api('/api/dimension/work-models')).settings.routes.simple, null);
    await select(`${modelDialog} select[name="simple"]`, JSON.stringify([providerId, 'fixture-flash']));
    await click(`${modelDialog} button[type="submit"]`);
    await waitFor(async () => (await api('/api/dimension/work-models')).settings.routes.simple?.providerId === providerId, 'explicit model restored');
    await screenshot('08-model-settings');
    await escape();
    if (await visible('#publicWorkbenchClose')) await click('#publicWorkbenchClose');
    await click('#modelTrigger');
    await waitFor(() => visible('#modelMenu .model-option'), 'conversation model menu');
    assert((await cdp.evaluate(`document.querySelector('#modelMenu').textContent`)).includes('fixture-flash'));
    await escape();
    pass('Model routing supports inherited and explicit selections; conversation model menu is populated');

    const storyGroup = (await api('/api/dimension/groups',{method:'POST',body:{name:'IME fixture',ownerId:alpha,members:[alpha,beta]}})).group.id;
    const storyPath = '/api/dimension/groups/'+storyGroup+'/story';
    await api(storyPath,{method:'PUT',body:{enabled:true,premise:'测试输入法选词'}});
    await cdp.call('Page.reload');
    const groupSelector = '#groupList [data-group-id="'+storyGroup+'"]';
    await waitFor(()=>visible(groupSelector),'story group in roster');
    await click(groupSelector);
    await click('[data-story-act="toggle-rewrite"]');
    await fill('#storyRewriteInput','测试改写');
    await cdp.evaluate(`(()=>{const input=document.querySelector('#storyRewriteInput');
      input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));
      input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));})()`);
    await delay(200);
    assert.equal(network.filter(n=>n.url.endsWith(storyPath+'/advance')).length,0);
    await cdp.call('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await waitFor(()=>network.some(n=>n.url.endsWith(storyPath+'/advance') && n.status===200),'normal Enter advances after composition');
    assert.equal(network.filter(n=>n.url.endsWith(storyPath+'/advance')).length,1);
    pass('Story input ignores composition commit and submits once on the following Enter');

    assert.equal(exceptions.length, 0, `Browser exceptions: ${JSON.stringify(exceptions)}`);
    const failedCore = network.filter(row => row.status >= 400 && /\/api\/(providers|dimension\/(bootstrap|bots|work\/|context-limits|work-models))/.test(row.url));
    assert.deepEqual(failedCore.map(r=>[r.status,new URL(r.url).pathname]), [[413,'/api/dimension/work/runs/'+run.id+'/handoff']], 'Only the intentional oversized export fails');
    assert.deepEqual(blockedExternal, [], 'The UI needed no external network requests');
    success = true;
    console.log(JSON.stringify({ ok: true, checks: checks.length, outputDirectory }));
} catch (error) {
    if (cdp) {
        await screenshot('failure').catch(() => {});
        await writeFile(join(outputDirectory, 'failure-dom.txt'), await cdp.evaluate(`document.body.innerText`).catch(() => ''), 'utf8');
    }
    console.error(error.stack);
    process.exitCode = 1;
} finally {
    for (const item of [...children].reverse()) await shutdown(item).catch(error => exceptions.push({ source: 'shutdown', message: error.message }));
    for (const item of children) await writeFile(join(outputDirectory, `${item.label}.log`), `${item.stdout}\nSTDERR\n${item.stderr}`, 'utf8');
    await writeFile(join(outputDirectory, 'result.json'), JSON.stringify({ ok: success, checks, screenshots: shots, origin, network, websocketFrames, exceptions, blockedExternal }, null, 2));
    console.log(`Browser artifacts: ${outputDirectory}`);
}
