// Real native source/target + Chrome download and file input. Application APIs
// are never mocked. The sole fault injection gates one synthetic File read.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { project, policies, body, bodyPrefix, digest, canonical, delay, until, parseOptions, fixtureArchive, assertPackage, startNative, readSnapshot, rawImport } from './archive-export-api.mjs';

const options = parseOptions();
const output = path.resolve(options.get('output') || path.join(project, 'outputs/phase3-archive-export-browser', new Date().toISOString().replace(/[:.]/g, '-')));
const executable = path.resolve(options.get('exe') || path.join(project, 'outputs/build/DImensionagent-native.exe'));
const ui = path.resolve(options.get('ui') || path.join(project, 'ui'));
const chromePath = options.get('chrome') || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sourceData = path.join(output, 'source/data'), targetData = path.join(output, 'target/data');
const profile = path.join(output, 'chrome-profile'), downloadsPath = path.join(output, 'downloads');
const env = { ...process.env, TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp') }, execFileAsync = promisify(execFile);
const checks = [], failures = [], processes = [], traces = [], snapshots = [], requests = [], network = [], exceptions = [], blockedExternal = [], screenshots = [], downloads = [], fingerprints = {};
const requestMetadata = new Map(), trackedResponses = new Map(), stageResponses = [], commitResponses = [];
const seed = fixtureArchive('export-browser'), ids = seed.ids;
let source, target, chrome, cdp, browserCdp, currentApp, packageValue, downloadedFile, gateInstalled = false, ok = false, residualChrome = [];
assert(/^[lL]:[\\/]/.test(output), 'All test outputs remain on L:');
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const cleanUrl = url => url.replace(/\/stage\/[0-9a-f]{32}/g, '/stage/:token');
const snap = (app, label) => readSnapshot(app.data, output, label, snapshots, options.get('python'));
const unchanged = async (app, before, label) => assert.equal((await snap(app, label)).hash, before.hash, label + ': complete Store changed');

class Cdp {
    constructor(socket) {
        this.socket = socket; this.sequence = 0; this.pending = new Map(); this.listeners = new Map();
        socket.addEventListener('message', event => {
            const value = JSON.parse(event.data);
            if (value.id) {
                const item = this.pending.get(value.id); if (!item) return;
                this.pending.delete(value.id); clearTimeout(item.timer);
                if (value.error) item.reject(Error(JSON.stringify(value.error))); else item.resolve(value.result);
            } else for (const handler of this.listeners.get(value.method) || []) Promise.resolve(handler(value.params)).catch(error => exceptions.push({ source: 'CDP handler', message: error.message }));
        });
        socket.addEventListener('close', () => { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(Error('CDP closed')); } this.pending.clear(); });
    }
    static async connect(url) { const socket = new WebSocket(url); await once(socket, 'open'); return new Cdp(socket); }
    on(method, handler) { const handlers = this.listeners.get(method) || []; handlers.push(handler); this.listeners.set(method, handlers); }
    call(method, params = {}) {
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
            this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }));
        });
    }
    async evaluate(expression) {
        const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
    }
}
async function click(selector) {
    let previous;
    const point = await until(async () => {
        const current = await cdp.evaluate('(() => {const el=document.querySelector(' + JSON.stringify(selector) + ');if(!el||el.hidden||el.disabled)return null;el.scrollIntoView({block:"center",inline:"nearest"});const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,top=document.elementFromPoint(x,y);return r.width>0&&r.height>0&&top&&(top===el||el.contains(top))?{x,y}:null})()');
        const stable = current && previous && Math.abs(current.x - previous.x) < 0.5 && Math.abs(current.y - previous.y) < 0.5;
        previous = current; return stable ? current : null;
    }, 'clickable ' + selector);
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}
async function key(keyName, code, keyCode) {
    await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: keyName, code, windowsVirtualKeyCode: keyCode });
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: keyCode });
}
async function uiState() {
    return cdp.evaluate('(() => {const q=id=>document.getElementById(id);return {open:!!q("conversationArchiveDialog")?.open,file:q("archiveImportInput")?.files[0]?.name||"",inputDisabled:q("archiveImportInput")?.disabled,preview:!!q("archivePreview")&&!q("archivePreview").hidden,restoreDisabled:q("archiveRestore")?.disabled,summary:q("archiveSummary")?.textContent||"",issues:q("archiveIssues")?.textContent||"",status:q("archiveStatus")?.textContent||"",policy:q("archiveConflictPolicy")?.value}})()');
}
async function openDialog() {
    if (!(await uiState()).open) await click('#conversationArchiveBtn');
    await until(async () => (await uiState()).open, 'archive dialog open');
}
async function closeDialog(how = 'close') {
    if (how === 'escape') { await cdp.evaluate('document.querySelector("#archiveClose").focus()'); await key('Escape', 'Escape', 27); }
    else await click('#archiveClose');
    await until(async () => !(await uiState()).open, 'archive dialog closed');
}
async function navigate(app) {
    currentApp = app; const before = network.length;
    await cdp.call('Page.navigate', { url: app.origin + '/dimension-ui/' });
    await until(() => network.slice(before).some(row => row.url === app.origin + '/api/dimension/bootstrap' && row.status === 200), app.label + ' actual bootstrap');
    await until(() => cdp.evaluate('!!document.querySelector("#conversationArchiveBtn")&&!document.querySelector("#conversationArchiveBtn").hidden'), app.label + ' archive feature');
    assert.equal(await cdp.evaluate('Boolean(window.__bootErr)'), false);
}
async function setFile(file) {
    const { root } = await cdp.call('DOM.getDocument');
    const { nodeId } = await cdp.call('DOM.querySelector', { nodeId: root.nodeId, selector: '#archiveImportInput' }); assert(nodeId);
    await cdp.call('DOM.setFileInputFiles', { nodeId, files: [file] });
}
async function nextStage(before, app = currentApp, expected = 200) {
    const row = await until(() => stageResponses.slice(before).find(item => item.origin === app.origin), 'actual package stage response');
    assert.equal(row.status, expected);
    await until(async () => !(await uiState()).inputDisabled, 'preview UI idle');
    return row;
}
async function preview(file = downloadedFile, expected = 200) {
    const before = stageResponses.length; await setFile(file); return nextStage(before, currentApp, expected);
}
async function released(app, row, before, label) {
    await until(() => network.some(item => item.url === app.origin + '/api/native/archive/stage/:token' && item.status === 200 && item.requestId !== undefined && requestMetadata.get(item.requestId)?.tokenSha256 === digest(row.value.token)), label + ' actual discard');
    await app.api('/api/native/archive/commit', { token: row.value.token }, 'POST', 404); app.tokens.delete(row.value.token);
    await unchanged(app, before, label);
}
async function setPolicy(value) {
    assert(['preserve-existing', 'reject-conflicts'].includes(value));
    await cdp.evaluate('document.querySelector("#archiveConflictPolicy").focus()');
    await key(value === 'reject-conflicts' ? 'End' : 'Home', value === 'reject-conflicts' ? 'End' : 'Home', value === 'reject-conflicts' ? 35 : 36);
    await key('Tab', 'Tab', 9);
    await until(async () => (await uiState()).policy === value, 'policy selection ' + value);
}
async function screenshot(name) {
    const value = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(output, name + '.png'); await writeFile(file, Buffer.from(value.data, 'base64')); screenshots.push(file);
}
async function mode(value) {
    if (await cdp.evaluate('document.querySelector("#modeSwitch")?.textContent.trim().toLowerCase()') !== value) await click('#modeSwitch');
    await until(() => cdp.evaluate('document.querySelector("#modeSwitch")?.textContent.trim().toLowerCase()===' + JSON.stringify(value)), value + ' mode');
}
async function visibleFixtureRows() {
    return cdp.evaluate('(() => {const visible=el=>el.getBoundingClientRect().height>0;return {bots:Array.from(document.querySelectorAll("#botList [data-id]")).filter(visible).map(el=>el.dataset.id).filter(id=>id.startsWith("export-browser-")).sort(),groups:Array.from(document.querySelectorAll("#groupList [data-group-id]")).filter(visible).map(el=>el.dataset.groupId).sort()}})()');
}
async function assertRosters(modeName, bots, groups) {
    await mode(modeName);
    await until(async () => canonical(await visibleFixtureRows()) === canonical({ bots: bots.slice().sort(), groups: groups.slice().sort() }), modeName + ' restored rosters');
}
async function restoreFileMethod() {
    if (!gateInstalled || !cdp || cdp.socket.readyState !== WebSocket.OPEN) return;
    await cdp.evaluate('(() => {const gate=window.__archiveFileGate;if(!gate)return false;if(gate.descriptor)Object.defineProperty(File.prototype,"arrayBuffer",gate.descriptor);else delete File.prototype.arrayBuffer;const ok=File.prototype.arrayBuffer===gate.original;delete window.__archiveFileGate;return ok})()').then(value => assert(value));
    gateInstalled = false;
}
async function listResidualChrome() {
    const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Where-Object { $_.Name -match "^chrome\\.exe$" -and $_.CommandLine -and $_.CommandLine.Contains($env:DIMENSION_TEST_CHROME_PROFILE) } | Select-Object ProcessId,Name | ConvertTo-Json -Compress'], { cwd: output, windowsHide: true, env: { ...env, DIMENSION_TEST_CHROME_PROFILE: profile }, timeout: 15000 });
    if (!result.stdout.trim()) return [];
    const value = JSON.parse(result.stdout); return Array.isArray(value) ? value : [value];
}

await mkdir(path.join(output, 'temp'), { recursive: true }); await mkdir(downloadsPath, { recursive: true });
for (const file of [sourceData, targetData, profile]) assert.equal(await stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; }), null, 'Requires fresh synthetic path: ' + file);
try {
    for (const [name, file] of [['native', executable], ['test', import.meta.filename], ['apiHelpers', path.join(project, 'tests/archive-export-api.mjs')], ['modelFixtureDependency', path.join(project, 'tests/app-integration.mjs')], ['uiApp', path.join(ui, 'app.js')], ['uiEntry', path.join(ui, 'index.html')], ['uiArchive', path.join(ui, 'conversation-archive-ui.js')], ['uiArchiveStyles', path.join(ui, 'conversation-archive.css')]])
        fingerprints[name] = { path: file, sha256: digest(await readFile(file)) };
    if (options.has('expected-sha')) assert.equal(fingerprints.native.sha256, options.get('expected-sha').toLowerCase());
    source = await startNative({ label: 'source', executable, ui, data: sourceData, output, processes, traces });
    target = await startNative({ label: 'target', executable, ui, data: targetData, output, processes, traces });
    await rawImport(source, seed.archive, 'synthetic-export-browser-seed');
    await source.api('/api/dimension/groups/' + ids.deleted, undefined, 'DELETE');
    for (const app of [source, target]) { assert.equal((await app.api('/api/dimension/bootstrap')).features.conversationArchives, true); assert.deepEqual(await app.api('/api/providers'), []); }
    const child = spawn(chromePath, ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--window-size=1440,1100', '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-extensions', '--disable-client-side-phishing-detection', '--disable-breakpad', '--disable-features=OptimizationHints,MediaRouter',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', 'about:blank'], { cwd: output, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
    chrome = { label: 'chrome', child, stdout: '', stderr: '' }; processes.push(chrome);
    child.stdout.on('data', bytes => { chrome.stdout += bytes; }); child.stderr.on('data', bytes => { chrome.stderr += bytes; }); child.on('error', error => { chrome.error = error; });
    const port = await until(async () => { if (chrome.error) throw Object.assign(chrome.error, { fatal: true }); return Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }, 'fresh Chrome debug port');
    const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(), page = pages.find(row => row.type === 'page'); assert(page);
    const browser = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
    cdp = await Cdp.connect(page.webSocketDebuggerUrl); browserCdp = await Cdp.connect(browser.webSocketDebuggerUrl);
    browserCdp.on('Browser.downloadWillBegin', value => downloads.push({ guid: value.guid, fileName: value.suggestedFilename, urlSha256: digest(value.url), state: 'started' }));
    browserCdp.on('Browser.downloadProgress', value => { const item = downloads.find(row => row.guid === value.guid); if (item) { item.state = value.state; item.receivedBytes = value.receivedBytes; item.totalBytes = value.totalBytes; } });
    await browserCdp.call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadsPath, eventsEnabled: true });
    cdp.on('Runtime.exceptionThrown', value => exceptions.push({ source: 'browser', message: value.exceptionDetails.exception?.description || value.exceptionDetails.text }));
    cdp.on('Network.requestWillBeSent', value => {
        const parsed = new URL(value.request.url), row = { requestId: value.requestId, url: cleanUrl(value.request.url), method: value.request.method };
        if (parsed.pathname.startsWith('/api/native/archive/')) {
            const token = /\/stage\/([0-9a-f]{32})$/.exec(parsed.pathname)?.[1]; if (token) row.tokenSha256 = digest(token);
            if (value.request.postData) {
                const payload = JSON.parse(value.request.postData);
                if (payload.token) row.tokenSha256 = digest(payload.token);
                if (payload.package) row.package = { sourceIdSha256: digest(payload.package.sourceId || ''), sourceRevision: payload.package.sourceRevision, contentSha256: payload.package.contentSha256, packageSha256: payload.package.packageSha256, policies: payload.policies };
            }
        }
        requestMetadata.set(value.requestId, row); requests.push(row);
    });
    cdp.on('Network.responseReceived', value => {
        const parsed = new URL(value.response.url), row = { requestId: value.requestId, url: cleanUrl(value.response.url), status: value.response.status, type: value.type };
        if (parsed.pathname === '/api/native/archive/export') row.headers = Object.fromEntries(Object.entries(value.response.headers).filter(([name]) => ['content-disposition', 'cache-control', 'content-type'].includes(name.toLowerCase())).map(([name, content]) => [name.toLowerCase(), content]));
        network.push(row);
        if (['/api/native/archive/package/stage', '/api/native/archive/commit'].includes(parsed.pathname)) trackedResponses.set(value.requestId, { ...row, origin: parsed.origin, kind: parsed.pathname.endsWith('/stage') ? 'stage' : 'commit' });
    });
    cdp.on('Network.loadingFinished', async value => {
        const row = trackedResponses.get(value.requestId); if (!row) return;
        trackedResponses.delete(value.requestId);
        const result = await cdp.call('Network.getResponseBody', { requestId: value.requestId }), content = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
        assert(!content.includes(bodyPrefix), 'Archive preview/commit response exposed record content'); row.value = JSON.parse(content); row.request = requestMetadata.get(value.requestId);
        if (row.kind === 'stage') { if (row.value.token) [source, target].find(app => app.origin === row.origin).tokens.add(row.value.token); stageResponses.push(row); }
        else commitResponses.push(row);
    });
    cdp.on('Fetch.requestPaused', async value => {
        const url = new URL(value.request.url);
        if (['data:', 'blob:', 'about:'].includes(url.protocol) || ['127.0.0.1', 'localhost'].includes(url.hostname)) await cdp.call('Fetch.continueRequest', { requestId: value.requestId });
        else { blockedExternal.push(value.request.url); await cdp.call('Fetch.failRequest', { requestId: value.requestId, errorReason: 'BlockedByClient' }); }
    });
    await cdp.call('Page.enable'); await cdp.call('Runtime.enable'); await cdp.call('Network.enable', { maxPostDataSize: 8 * 1024 * 1024 }); await cdp.call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await navigate(source); const sourceBefore = await snap(source, 'source-before-browser-export');
    await openDialog(); await click('#archiveExport');
    const download = await until(() => downloads.find(row => row.state === 'completed'), 'actual Chrome JSON download');
    assert.match(download.fileName, /^DimensionAgent-conversations-[0-9]+\.json$/);
    downloadedFile = path.join(downloadsPath, download.fileName);
    const downloadedBytes = await readFile(downloadedFile); packageValue = assertPackage(JSON.parse(downloadedBytes.toString('utf8')));
    download.path = downloadedFile; download.sha256 = digest(downloadedBytes); download.counts = packageValue.counts; download.contentSha256 = packageValue.contentSha256; download.packageSha256 = packageValue.packageSha256;
    const exportResponse = network.find(row => row.url === source.origin + '/api/native/archive/export'); assert.equal(exportResponse.status, 200);
    assert.match(exportResponse.headers['content-disposition'], /attachment/); assert.match(exportResponse.headers['cache-control'], /no-store/);
    assert.equal(packageValue.counts.messages, 10); assert(packageValue.archive.groups.find(row => row.id === ids.deleted).deleted);
    await unchanged(source, sourceBefore, 'browser-export-read-only');
    pass('The source export button saves a real Chrome JSON download on L: with valid complete-package/content checksums and read-only snapshot data');

    const self = await preview(); assert.equal(self.value.report.canCommit, false); assert(self.value.report.issues.some(row => row.code === 'source_is_target'));
    let state = await uiState(); assert(state.preview && state.restoreDisabled); assert(state.issues.includes('来自当前') && state.issues.includes('不能')); assert(!state.summary.includes(bodyPrefix) && !state.issues.includes(bodyPrefix));
    await screenshot('01-source-self-restore-blocked'); await unchanged(source, sourceBefore, 'self-preview-no-write'); await closeDialog(); await released(source, self, sourceBefore, 'self-close-clears-token');
    pass('Selecting the exported file on its source visibly blocks self-restore, disables commit and releases the preview on close without writes');

    await navigate(target); const targetBefore = await snap(target, 'target-before-file-preview'); await openDialog();
    const canceled = await preview(); assert(canceled.value.report.canCommit); state = await uiState(); assert(state.preview && !state.restoreDisabled); assert(state.status.includes('尚未写入'));
    await unchanged(target, targetBefore, 'target-preview-no-write'); await screenshot('02-target-preview-no-write');
    await click('#archiveCancel'); await until(async () => !(await uiState()).preview && !(await uiState()).file, 'cancel clears file and preview');
    await released(target, canceled, targetBefore, 'cancel-clears-token');
    for (const how of ['close', 'escape']) { const staged = await preview(); assert(staged.value.report.canCommit); await closeDialog(how); await released(target, staged, targetBefore, how + '-clears-token'); await openDialog(); }
    pass('Actual file input auto-previews without writes; cancel, close and Escape each discard the real server token, confirmed by subsequent commit 404');

    const corruptFile = path.join(downloadsPath, 'synthetic-corrupt-checksum.json'), duplicateFile = path.join(downloadsPath, 'synthetic-duplicate-key.json');
    await writeFile(corruptFile, JSON.stringify({ ...packageValue, packageSha256: '0'.repeat(64) }), 'utf8');
    const originalJson = downloadedBytes.toString('utf8'), duplicateJson = originalJson.replace(/("format"\s*:\s*"dimension-conversation-export")/, '$1,$1'); assert.notEqual(duplicateJson, originalJson);
    await writeFile(duplicateFile, duplicateJson, 'utf8');
    for (const file of [corruptFile, duplicateFile]) {
        await preview(file, 400); state = await uiState(); assert(!state.preview && state.restoreDisabled && state.status.trim()); assert(!state.status.includes(bodyPrefix));
        await unchanged(target, targetBefore, 'invalid-file-' + path.basename(file)); await closeDialog(); await openDialog();
    }
    pass('Bad checksums and duplicate JSON keys reach the strict native parser from the real file input and cannot produce a usable preview or write data');

    const delayedFile = path.join(downloadsPath, 'delayed-invalid-A.json'); await writeFile(delayedFile, '{"format":"synthetic-invalid-delayed-A"}', 'utf8');
    await cdp.evaluate('(() => {const original=File.prototype.arrayBuffer,descriptor=Object.getOwnPropertyDescriptor(File.prototype,"arrayBuffer");const gate={original,descriptor,triggered:false};window.__archiveFileGate=gate;Object.defineProperty(File.prototype,"arrayBuffer",{configurable:true,writable:true,value:function(...args){if(this.name==="delayed-invalid-A.json"){gate.triggered=true;return new Promise((resolve,reject)=>{gate.release=()=>original.apply(this,args).then(resolve,reject)})}return original.apply(this,args)}});return true})()'); gateInstalled = true;
    await setFile(delayedFile); await until(() => cdp.evaluate('window.__archiveFileGate.triggered'), 'delayed A read started');
    await closeDialog(); await openDialog(); const validB = await preview(); assert(validB.value.report.canCommit);
    const beforeRelease = stageResponses.length;
    await cdp.evaluate('(async () => {await window.__archiveFileGate.release();await new Promise(resolve=>setTimeout(resolve,100));return true})()');
    state = await uiState(); assert.equal(state.file, path.basename(downloadedFile)); assert(state.summary.includes(path.basename(downloadedFile)) && state.preview && !state.restoreDisabled); assert.equal(stageResponses.length, beforeRelease);
    const beforePolicy = stageResponses.length; await setPolicy('reject-conflicts'); const reprievedB = await nextStage(beforePolicy);
    assert(reprievedB.value.report.canCommit); assert.equal(reprievedB.request.package.contentSha256, packageValue.contentSha256); assert.equal(reprievedB.request.package.packageSha256, packageValue.packageSha256); assert.equal(reprievedB.request.package.sourceIdSha256, digest(packageValue.sourceId));
    assert.deepEqual(reprievedB.request.package.policies, { bots: 'reject-conflicts', memories: 'reject-conflicts', groups: 'reject-conflicts' });
    await unchanged(target, targetBefore, 'delayed-A-cannot-replace-valid-B'); await restoreFileMethod();
    pass('A delayed invalid A read cannot replace valid B after close/reopen; B remains selected and re-previews under a changed policy without writes, and File.arrayBuffer is restored');

    assert.equal(commitResponses.length, 0, 'No UI action committed before the explicit restore button');
    await click('#archiveRestore');
    const committed = await until(() => commitResponses[0], 'explicit UI commit response'); assert.equal(committed.status, 200); assert.equal(committed.value.replayed, false);
    await until(async () => (await uiState()).status.includes('恢复完成') && !(await uiState()).inputDisabled, 'restore completes and refreshes lists');
    assert.equal(commitResponses.length, 1);
    const restored = await snap(target, 'target-after-explicit-ui-restore');
    assert.deepEqual(restored.tables.messages.map(row => row.text).sort(), packageValue.archive.conversations.flatMap(row => row.messages.map(message => message.text)).sort());
    assert.deepEqual(restored.tables.memories.map(row => row.text).sort(), packageValue.archive.memories.map(row => row.text).sort());
    const bootstrap = await target.api('/api/dimension/bootstrap'); for (const bot of seed.archive.bots) assert(bootstrap.bots.some(row => row.id === bot.id && row.name === bot.name));
    assert.equal((await target.api('/api/dimension/bots/' + ids.owner + '/history?mode=chat')).messages.length, 2);
    assert.equal((await target.api('/api/dimension/groups/' + ids.group + '?mode=discuss')).messages.length, 3);
    await screenshot('03-explicit-restore-completed'); await closeDialog();
    await assertRosters('chat', [ids.owner, ids.admin], [ids.group]); await screenshot('04-restored-chat-rosters');
    await assertRosters('work', [ids.owner, ids.worker], [ids.group, ids.hidden]); await screenshot('05-restored-work-rosters');
    await mode('chat');
    pass('Only the explicit restore button commits; real APIs expose restored messages and memories, and the existing frontend immediately refreshes independent Chat/Work rosters');

    const localName = 'Synthetic target profile retained';
    await target.api('/api/dimension/bots/' + ids.owner + '/profile', { name: localName, persona: body('TARGET_LOCAL_PROFILE') }, 'PATCH');
    const conflictBefore = await snap(target, 'target-local-profile-edit'); await openDialog(); assert.equal((await uiState()).policy, 'reject-conflicts');
    const conflict = await preview(); assert.equal(conflict.value.report.canCommit, false); assert(conflict.value.report.issues.some(row => row.code === 'bot_conflict'));
    state = await uiState(); assert(state.preview && state.restoreDisabled); assert(state.issues.includes('Bot 资料与当前数据不同'));
    await unchanged(target, conflictBefore, 'visible-conflict-no-write'); assert.equal((await target.api('/api/dimension/bootstrap')).bots.find(row => row.id === ids.owner).name, localName);
    await screenshot('06-target-profile-conflict'); await click('#archiveCancel'); await released(target, conflict, conflictBefore, 'conflict-cancel-clears-token'); await closeDialog();
    pass('Reject-conflicts visibly reports changed target Bot data, disables restore and preserves the local profile throughout preview and cancellation');

    for (const app of [source, target]) { assert.deepEqual(await app.api('/api/providers'), []); assert.equal((await app.api('/api/dimension/work/sessions')).runs.length, 0); }
    await unchanged(source, sourceBefore, 'source-still-unchanged');
    assert.equal(exceptions.length, 0, JSON.stringify(exceptions)); assert.equal(blockedExternal.length, 0);
    assert(!requests.some(row => /\/say$|\/work\/runs$/.test(row.url) && row.method === 'POST'));
    for (const entry of processes) assert(!entry.stdout.includes(bodyPrefix) && !entry.stderr.includes(bodyPrefix));
    pass('All browser behavior uses isolated synthetic source/target data without model/provider calls, external pages, API response mocks or uncaught browser errors');
    ok = true;
} catch (error) {
    failures.push(error.stack); console.error(error.stack); process.exitCode = 1;
    if (cdp?.socket.readyState === WebSocket.OPEN) await screenshot('failure-state').catch(() => {});
} finally {
    await restoreFileMethod().catch(error => failures.push(error.message));
    if (chrome?.child.exitCode === null) {
        if (browserCdp) await browserCdp.call('Browser.close').catch(() => {});
        await until(() => chrome.child.exitCode !== null, 'Chrome orderly shutdown', 10000).catch(error => failures.push(error.message));
        if (chrome.child.exitCode !== null && chrome.child.exitCode !== 0) failures.push('Chrome exit ' + chrome.child.exitCode);
    }
    for (const app of [source, target]) if (app?.child.exitCode === null) {
        for (const token of app.tokens) await app.response('/api/native/archive/stage/' + token, undefined, 'DELETE').catch(() => {});
        await app.stop().catch(error => failures.push(error.message));
    }
    for (const entry of processes) if (entry.child.pid && entry.child.exitCode === null) await execFileAsync('taskkill', ['/PID', String(entry.child.pid), '/T', '/F'], { cwd: output, windowsHide: true }).catch(() => {});
    for (const connection of [cdp, browserCdp]) if (connection?.socket.readyState === WebSocket.OPEN) connection.socket.close();
    if (chrome) {
        await until(async () => { residualChrome = await listResidualChrome(); return residualChrome.length === 0; }, 'no residual Chrome for owned L: profile', 10000).catch(error => failures.push(error.message));
    }
    for (const entry of processes) await writeFile(path.join(output, entry.label + '.log'), entry.stdout + '\nSTDERR\n' + entry.stderr, 'utf8');
    const metadata = row => { const { token, ...value } = row.value; return { origin: row.origin, status: row.status, request: row.request, response: value, ...(token ? { tokenSha256: digest(token) } : {}) }; };
    ok &&= failures.length === 0 && processes.every(entry => entry.child.exitCode === 0) && residualChrome.length === 0; if (!ok) process.exitCode = 1;
    const report = { ok, checks, failures, fingerprints, downloads, traces, snapshots, requests, network, stages: stageResponses.map(metadata), commits: commitResponses.map(metadata), exceptions, blockedExternal, screenshots,
        windowsProcesses: processes.map(entry => ({ label: entry.label, pid: entry.child.pid, exitCode: entry.child.exitCode, signal: entry.child.signalCode, data: entry.data })), residualChrome, sourceData, targetData, chromeProfile: profile, ui,
        scope: 'Real headless Chrome, fresh L: profile, actual attachment download/file input and UI lifecycle against two native databases; read-only system SQLite snapshots; only named synthetic File.arrayBuffer read is gated then restored; no production data/accounts, real providers/models, WSL, external websites or mocked application API responses.' };
    await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2), 'utf8'); console.log(JSON.stringify({ ok, checks: checks.length, output }));
}
