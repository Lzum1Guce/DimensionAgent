// Real isolated native server + real headless Chrome. Synthetic records only;
// no model/provider/account, production client, API mock or user browser profile.
// Wait for the owner to release the group-archive build before executing.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const project = path.resolve(import.meta.dirname, '..'), options = new Map();
for (let i = 2; i < process.argv.length; i += 2) { assert(process.argv[i]?.startsWith('--') && process.argv[i + 1]); options.set(process.argv[i].slice(2), process.argv[i + 1]); }
const output = path.resolve(options.get('output') || path.join(project, 'outputs/phase3-group-roster-browser', new Date().toISOString().replace(/[:.]/g, '-')));
const executable = path.resolve(options.get('exe') || path.join(project, 'outputs/build/DImensionagent-native.exe'));
const ui = path.resolve(options.get('ui') || path.join(project, 'ui'));
const chromePath = options.get('chrome') || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const data = path.join(output, 'data'), profile = path.join(output, 'chrome-profile'), execFileAsync = promisify(execFile);
const env = { ...process.env, TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp') };
const digest = value => createHash('sha256').update(value).digest('hex'), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], failures = [], processes = [], requests = [], network = [], exceptions = [], blockedExternal = [], screenshots = [], fingerprints = {};
const owner = 'group-browser-owner', member = 'group-browser-member', groupIds = ['browser-group-main', 'browser-group-chat', 'browser-group-work'];
const privateSystem = 'BROWSER_SYNTH_PRIVATE_SYSTEM 中文🙂', groupSystem = 'BROWSER_SYNTH_GROUP_SYSTEM 中文🙂';
let native, chrome, cdp, origin, ok = false;
assert(/^[lL]:[\\/]/.test(output), 'All standalone outputs remain on L:');
function pass(name) { checks.push(name); console.log('PASS ' + name); }
async function until(fn, label, timeout = 15000) {
    const deadline = Date.now() + timeout; let last;
    while (Date.now() < deadline) {
        try { const result = await fn(); if (result) return result; } catch (error) { if (error.fatal) throw error; last = error; }
        await delay(60);
    }
    throw Error(`Timeout: ${label}${last ? ` (${last.message})` : ''}`);
}
function launch(label, command, args) {
    const child = spawn(command, args, { cwd: output, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
    const entry = { label, child, stdout: '', stderr: '', ready: null }; processes.push(entry);
    child.stdout.on('data', bytes => { entry.stdout += bytes; for (const line of entry.stdout.split(/\r?\n/)) { try { const value = JSON.parse(line); if (value.ready) entry.ready = value; } catch {} } });
    child.stderr.on('data', bytes => { entry.stderr += bytes; }); child.on('error', error => { entry.error = error; }); return entry;
}
async function api(route, payload, method = payload === undefined ? 'GET' : 'POST') {
    const response = await fetch(origin + route, { method, headers: { 'content-type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200, `${method} ${route} status`); const result = await response.json();
    if (route.startsWith('/api/native/archive/')) assert(!JSON.stringify(result).includes('BROWSER_SYNTH_'));
    return result;
}
class Cdp {
    constructor(socket) {
        this.socket = socket; this.sequence = 0; this.pending = new Map(); this.listeners = new Map();
        socket.addEventListener('message', event => {
            const value = JSON.parse(event.data);
            if (value.id) { const item = this.pending.get(value.id); if (!item) return; this.pending.delete(value.id); clearTimeout(item.timer); if (value.error) item.reject(Error(JSON.stringify(value.error))); else item.resolve(value.result); }
            else for (const handler of this.listeners.get(value.method) || []) Promise.resolve(handler(value.params)).catch(error => exceptions.push({ source: 'CDP handler', message: error.message }));
        });
        socket.addEventListener('close', () => { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(Error('CDP closed')); } this.pending.clear(); });
    }
    static async connect(url) { const socket = new WebSocket(url); await once(socket, 'open'); return new Cdp(socket); }
    on(method, handler) { const list = this.listeners.get(method) || []; list.push(handler); this.listeners.set(method, list); }
    call(method, params = {}) {
        const id = ++this.sequence; return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
            this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }));
        });
    }
    async evaluate(expression) { const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; }
}
async function click(selector, button = 'left') {
    let previous;
    const point = await until(async () => {
        const current = await cdp.evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.hidden)return null;el.scrollIntoView({block:'center',inline:'nearest'});const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,top=document.elementFromPoint(x,y);return r.width>0&&r.height>0&&top&&(top===el||el.contains(top))?{x,y}:null})()`);
        const stable = current && previous && Math.abs(current.x - previous.x) < 0.5 && Math.abs(current.y - previous.y) < 0.5; previous = current; return stable ? current : null;
    }, 'clickable ' + selector);
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button, clickCount: 1, ...point });
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button, clickCount: 1, ...point });
}
const visibleGroups = () => cdp.evaluate(`Array.from(document.querySelectorAll('#groupList .group-item')).filter(el=>el.getBoundingClientRect().height>0).map(el=>el.dataset.groupId).sort()`);
async function groupsEqual(expected, label) { const sorted = [...expected].sort(); return until(async () => JSON.stringify(await visibleGroups()) === JSON.stringify(sorted), label); }
async function mode(target) {
    if ((await cdp.evaluate(`document.querySelector('#modeSwitch')?.textContent.trim().toLowerCase()`)) !== target) await click('#modeSwitch');
    await until(() => cdp.evaluate(`document.querySelector('#modeSwitch')?.textContent.trim().toLowerCase()===${JSON.stringify(target)}`), target + ' mode');
}
async function reload() {
    const count = network.length; await cdp.call('Page.reload', { ignoreCache: true });
    await until(() => network.slice(count).some(row => row.url.startsWith(origin + '/api/dimension/groups') && row.status === 200), 'groups reloaded from real backend');
    assert.equal(await cdp.evaluate('Boolean(window.__bootErr)'), false);
}
async function screenshot(name) {
    const result = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(output, name + '.png'); await writeFile(file, Buffer.from(result.data, 'base64')); screenshots.push(file);
}
async function shutdown(entry) {
    if (!entry || entry.child.exitCode !== null) return;
    if (entry.label === 'chrome') { if (cdp) await cdp.call('Browser.close').catch(() => {}); }
    else entry.child.stdin.end('shutdown\n');
    await until(() => entry.child.exitCode !== null, entry.label + ' orderly shutdown', 10000);
    assert.equal(entry.child.exitCode, 0);
}

await mkdir(path.join(output, 'temp'), { recursive: true });
assert.equal(await stat(data).catch(error => { if (error.code === 'ENOENT') return null; throw error; }), null, 'Requires fresh synthetic data');
try {
    for (const [name, file] of [['native', executable], ['test', import.meta.filename], ['uiApp', path.join(ui, 'app.js')], ['uiRosters', path.join(ui, 'group-roster.js')]])
        fingerprints[name] = { path: file, sha256: digest(await readFile(file)) };
    if (options.has('expected-sha')) assert.equal(fingerprints.native.sha256, options.get('expected-sha').toLowerCase());
    native = launch('native', executable, ['--data', data, '--ui', ui, '--port', '0']);
    const ready = await until(() => { if (native.error) throw Object.assign(native.error, { fatal: true }); if (native.child.exitCode !== null) throw Object.assign(Error('Native failed before ready'), { fatal: true }); return native.ready; }, 'native ready');
    origin = `http://127.0.0.1:${ready.port}`;
    const groups = groupIds.map((id, index) => ({ id, name: ['双名单合成群', '仅 Chat 合成群', '仅 Work 合成群'][index], ownerId: owner, admins: [member], members: [owner, member], historyMembers: [owner, member], inChat: index !== 2, inWork: index !== 1, deleted: false, seal: { shape: 'round-seal', color: 'persimmon' }, revision: '7' }));
    const archive = { format: 'dimension-conversation-archive', version: 2, coverage: 'conversation-and-group-data', excludedTypes: ['work-runs', 'tool-receipts', 'message-receipts', 'artifacts', 'plugins', 'accounts', 'provider-settings', 'application-settings'],
        bots: [{ id: owner, name: '浏览器合成群主', persona: 'Synthetic browser-only owner', inChat: true, inWork: true }, { id: member, name: '浏览器合成成员', persona: 'Synthetic browser-only member', inChat: true, inWork: true }], groups,
        conversations: [{ botId: owner, groupId: '', mode: 'chat', messages: [{ id: '9007199254740993', actor: 'system', text: privateSystem, createdAtMs: '0' }] },
            { botId: owner, groupId: groupIds[0], mode: 'chat', messages: [{ id: '9007199254740994', actor: 'system', text: groupSystem, createdAtMs: '-1' }] }], memories: [] };
    const staged = await api('/api/native/archive/stage', { sourceId: 'synthetic-group-browser', policies: { bots: 'preserve-existing', memories: 'preserve-existing', groups: 'preserve-existing' }, archive });
    assert(staged.report.canCommit); await api('/api/native/archive/commit', { token: staged.token }); await api('/api/native/archive/stage/' + staged.token, undefined, 'DELETE');
    assert.equal((await api('/api/dimension/bootstrap')).features.persistentGroupRosters, true);
    assert((await api('/api/dimension/groups')).groups.every(group => group.rosterManaged === true));
    assert.deepEqual(await api('/api/providers'), []);

    chrome = launch('chrome', chromePath, ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,1000', '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-extensions', '--disable-client-side-phishing-detection', '--disable-breakpad', '--disable-features=OptimizationHints,MediaRouter',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', 'about:blank']);
    const port = await until(async () => { if (chrome.error) throw Object.assign(chrome.error, { fatal: true }); return Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }, 'isolated Chrome debug port');
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(), page = pages.find(row => row.type === 'page'); assert(page);
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    cdp.on('Runtime.exceptionThrown', value => exceptions.push({ source: 'browser', message: value.exceptionDetails.exception?.description || value.exceptionDetails.text }));
    cdp.on('Network.responseReceived', value => network.push({ url: value.response.url, status: value.response.status, type: value.type }));
    cdp.on('Network.requestWillBeSent', value => {
        const row = { url: value.request.url, method: value.request.method };
        if (/\/groups\/[^/]+\/roster$/.test(value.request.url) && value.request.postData) row.rosterBody = JSON.parse(value.request.postData);
        if (/\/groups\/[^/]+$/.test(value.request.url) && value.request.method === 'PATCH' && value.request.postData) row.groupPatch = JSON.parse(value.request.postData);
        requests.push(row);
    });
    cdp.on('Fetch.requestPaused', async value => {
        const url = new URL(value.request.url);
        if (['data:', 'blob:', 'about:'].includes(url.protocol) || ['127.0.0.1', 'localhost'].includes(url.hostname)) await cdp.call('Fetch.continueRequest', { requestId: value.requestId });
        else { blockedExternal.push(value.request.url); await cdp.call('Fetch.failRequest', { requestId: value.requestId, errorReason: 'BlockedByClient' }); }
    });
    await cdp.call('Page.enable'); await cdp.call('Runtime.enable'); await cdp.call('Network.enable'); await cdp.call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    // Deliberately stale local preferences prove backend flags are authoritative.
    const stale = { chatBots: [owner, member], workBots: [owner, member], chatGroups: [groupIds[2]], workGroups: [groupIds[1]], knownGroupIds: groupIds };
    await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: `if(!sessionStorage.getItem('syntheticRosterSeed')){localStorage.setItem('dimension.sidebarPrefs.v1',${JSON.stringify(JSON.stringify(stale))});sessionStorage.setItem('syntheticRosterSeed','1');}` });
    await cdp.call('Page.navigate', { url: origin + '/dimension-ui/' });
    await groupsEqual([groupIds[0], groupIds[1]], 'Chat roster restored from backend flags'); assert.equal(await cdp.evaluate('Boolean(window.__bootErr)'), false);
    await mode('work'); await groupsEqual([groupIds[0], groupIds[2]], 'Work roster restored from backend flags'); await mode('chat');
    pass('Real Chrome restores independent group rosters from backend flags despite contradictory local preferences');

    await click(`#botList [data-id="${owner}"]`);
    await until(() => cdp.evaluate(`Array.from(document.querySelectorAll('#transcript .bubble.system')).some(el=>el.textContent.includes(${JSON.stringify(privateSystem)})&&el.querySelector('.message-source')?.textContent==='系统')`), 'private system history label');
    await screenshot('01-private-system-history');
    await click(`#groupList [data-group-id="${groupIds[0]}"]`);
    await until(() => cdp.evaluate(`Array.from(document.querySelectorAll('#transcript .gmsg')).some(el=>el.textContent.includes(${JSON.stringify(groupSystem)})&&el.querySelector('.gmsg-name')?.firstChild?.textContent.trim()==='系统')`), 'group system history label');
    await screenshot('02-group-system-history');
    pass('Imported private and group system history render an explicit 系统 label in the real frontend');

    await click(`#groupList [data-group-id="${groupIds[0]}"]`, 'right'); await click('#gsDelete');
    await groupsEqual([groupIds[1]], 'Chat group removed');
    const afterRemove = (await api('/api/dimension/groups')).groups.find(group => group.id === groupIds[0]); assert.equal(afterRemove.inChat, false); assert.equal(afterRemove.inWork, true);
    assert(requests.some(row => row.method === 'POST' && row.url === origin + `/api/dimension/groups/${groupIds[0]}/roster` && row.rosterBody?.mode === 'chat' && row.rosterBody?.present === false));
    await mode('work'); await groupsEqual([groupIds[0], groupIds[2]], 'Work group survives Chat removal');
    await mode('chat'); await reload(); await groupsEqual([groupIds[1]], 'Hidden Chat roster persists through reload');
    pass('Removing a group from Chat sends the real roster API, preserves Work, and remains removed after refresh');

    await click('#newBotBtn'); await click('#createMenuGroupPool'); await click(`#groupPoolList [data-group-id="${groupIds[0]}"]`);
    await groupsEqual([groupIds[0], groupIds[1]], 'Group recalled to Chat');
    const recalled = (await api('/api/dimension/groups')).groups.find(group => group.id === groupIds[0]); assert.equal(recalled.inChat, true); assert.equal(recalled.inWork, true);
    assert(requests.some(row => row.method === 'POST' && row.url === origin + `/api/dimension/groups/${groupIds[0]}/roster` && row.rosterBody?.mode === 'chat' && row.rosterBody?.present === true));
    await reload(); await groupsEqual([groupIds[0], groupIds[1]], 'Recalled Chat roster persists through refresh');
    await mode('work'); await reload(); await groupsEqual([groupIds[0], groupIds[2]], 'Independent Work roster persists through refresh');
    pass('调入已有群 persists through the real roster endpoint and survives refresh in both modes');

    await mode('chat'); await click(`#groupList [data-group-id="${groupIds[0]}"]`); await click('#groupBar');
    const beforeKick = (await api(`/api/dimension/groups/${groupIds[0]}`)).group;
    await click(`#groupMembers [data-mid="${member}"]`, 'right'); await click('.group-ctx [data-act="kick"]');
    const kicked = await until(async () => { const group = (await api(`/api/dimension/groups/${groupIds[0]}`)).group; return !group.members.includes(member) ? group : null; }, 'administrator removed from current members');
    assert(!kicked.admins.includes(member)); assert(kicked.historyMembers.includes(member)); assert.equal(kicked.ownerId, owner);
    assert(requests.some(row => row.groupPatch?.baseRevision === beforeKick.revision && row.groupPatch.members?.length === 1 && row.groupPatch.members[0] === owner && row.groupPatch.admins?.length === 0));
    await until(() => cdp.evaluate(`!document.querySelector('#groupMembers [data-mid="${member}"]')`), 'administrator removed from drawer');
    await until(() => cdp.evaluate(`document.querySelector('#groupBarMeta')?.textContent.trim().startsWith('1 名成员')`), 'group header updates to one current member');
    pass('The real member menu removes an administrator and its admin role with baseRevision, retains history, and updates both drawer and header member count');

    await click('#groupDrawerInviteBtn');
    await until(() => cdp.evaluate(`!!document.querySelector('#modal [data-invite="${member}"]')`), 'captured invitation form');
    const concurrent = (await api(`/api/dimension/groups/${groupIds[0]}`, { name: '并发编辑保留群名', baseRevision: kicked.revision }, 'PATCH')).group;
    const responsesBeforeInvite = network.length;
    await click(`#modal [data-invite="${member}"]`);
    await until(() => network.slice(responsesBeforeInvite).some(row => row.url === origin + `/api/dimension/groups/${groupIds[0]}` && row.status === 409), 'stale invitation rejected by real backend');
    await until(() => cdp.evaluate(`Boolean(document.querySelector('#inviteMsg')?.textContent.trim())`), 'invitation conflict shown to user');
    await screenshot('03-invitation-revision-conflict');
    assert.deepEqual((await api(`/api/dimension/groups/${groupIds[0]}`)).group, concurrent);
    assert(requests.some(row => row.groupPatch?.baseRevision === kicked.revision && row.groupPatch.members?.includes(member)));
    await click('#modal [data-close]'); await reload(); await groupsEqual([groupIds[0], groupIds[1]], 'fresh group metadata after invitation conflict');
    await click(`#groupList [data-group-id="${groupIds[0]}"]`); await click('#groupInviteBtn'); await click(`#modal [data-invite="${member}"]`);
    const invited = await until(async () => { const group = (await api(`/api/dimension/groups/${groupIds[0]}`)).group; return group.members.includes(member) ? group : null; }, 'fresh invitation succeeds');
    assert.equal(invited.name, concurrent.name); assert.deepEqual(invited.admins, []); assert.equal(invited.historyMembers.filter(id => id === member).length, 1);
    assert(requests.some(row => row.groupPatch?.baseRevision === concurrent.revision && row.groupPatch.members?.includes(member)));
    await until(() => cdp.evaluate(`document.querySelector('#groupBarMeta')?.textContent.trim().startsWith('2 名成员')`), 'group header updates after successful invitation');
    pass('A stale invitation shows 409 without overwriting metadata; refreshing permits a valid invite and refreshes the header member count');

    assert.deepEqual(await api('/api/providers'), []); assert.equal((await api('/api/dimension/work/sessions')).runs.length, 0);
    assert.equal(exceptions.length, 0, JSON.stringify(exceptions)); assert.equal(blockedExternal.length, 0);
    assert(!requests.some(row => /\/say$|\/work\/runs$/.test(row.url) && row.method === 'POST'));
    for (const entry of processes) { assert(!entry.stdout.includes('BROWSER_SYNTH_')); assert(!entry.stderr.includes('BROWSER_SYNTH_')); }
    pass('Browser actions use only isolated synthetic data with no provider, model request, task, external page or uncaught browser error');
    ok = true;
} catch (error) {
    failures.push(error.stack); console.error(error.stack); process.exitCode = 1;
} finally {
    await shutdown(chrome).catch(error => failures.push(error.message));
    await shutdown(native).catch(error => failures.push(error.message));
    for (const entry of processes) if (entry.child.pid && entry.child.exitCode === null) await execFileAsync('taskkill', ['/PID', String(entry.child.pid), '/T', '/F'], { cwd: output, windowsHide: true }).catch(() => {});
    if (cdp?.socket.readyState === WebSocket.OPEN) cdp.socket.close();
    for (const entry of processes) await writeFile(path.join(output, entry.label + '.log'), entry.stdout + '\nSTDERR\n' + entry.stderr, 'utf8');
    ok &&= failures.length === 0 && processes.every(entry => entry.child.exitCode === 0); if (!ok) process.exitCode = 1;
    const report = { ok, checks, failures, fingerprints, requests, network, exceptions, blockedExternal, screenshots,
        windowsProcesses: processes.map(entry => ({ label: entry.label, pid: entry.child.pid, exitCode: entry.child.exitCode, signal: entry.child.signalCode })),
        data, chromeProfile: profile, ui, scope: 'Real headless Chrome with fresh L: profile, original native server, actual group-roster HTTP calls and system-history DOM; no model/provider/account, API mock, production client/data, WSL or visual regression suite.' };
    await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2), 'utf8'); console.log(JSON.stringify({ ok, checks: checks.length, output }));
}
