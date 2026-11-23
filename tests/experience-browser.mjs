// Real retained UI + native server + local model fixture. All state is synthetic
// and confined to this project's outputs directory; no production data or network.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

const root = path.resolve(import.meta.dirname, '..');
const executable = path.join(root, 'outputs/build/DImensionagent-native.exe');
const outputParent = path.join(root, 'outputs/experience-browser');
await mkdir(outputParent, { recursive: true });
const output = await mkdtemp(path.join(outputParent, 'fixture-'));
await mkdir(path.join(output, 'temp'));
const alpha = 'experience-alpha', beta = 'experience-beta';
const children = [], checks = [], exceptions = [], badResponses = [], shots = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let origin, cdp, chrome, failure;

async function waitFor(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const result = await predicate(); if (result) return result; }
    catch (error) { lastError = error; }
    await delay(75);
  }
  throw Error(`Timed out: ${label}${lastError ? ` (${lastError.message})` : ''}`);
}

function startProcess(label, command, args) {
  const process = spawn(command, args, { windowsHide: true, cwd: output, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...globalThis.process.env, TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp') } });
  const item = { label, process, records: [], stdout: '', stderr: '' };
  process.stdout.on('data', data => { item.stdout += data; });
  process.stderr.on('data', data => { item.stderr += data; });
  createInterface({ input: process.stdout }).on('line', line => {
    try { item.records.push(JSON.parse(line)); } catch {}
  });
  children.push(item);
  return item;
}

async function api(route, { method = 'GET', body } = {}) {
  const response = await fetch(origin + route, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const text = await response.text();
  assert(response.ok, `${method} ${route}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

class Cdp {
  constructor(socket) {
    this.socket = socket; this.sequence = 0; this.pending = new Map(); this.listeners = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const item = this.pending.get(message.id); if (!item) return;
        this.pending.delete(message.id); clearTimeout(item.timer);
        if (message.error) item.reject(Error(JSON.stringify(message.error))); else item.resolve(message.result);
      } else for (const handler of this.listeners.get(message.method) ?? []) handler(message.params);
    });
    socket.addEventListener('close', () => {
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(Error('CDP closed')); }
      this.pending.clear();
    });
  }
  static async connect(url) { const socket = new WebSocket(url); await once(socket, 'open'); return new Cdp(socket); }
  on(method, handler) { const rows = this.listeners.get(method) ?? []; rows.push(handler); this.listeners.set(method, rows); }
  call(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`CDP ${method} timeout`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
}

async function visible(selector) {
  return cdp.evaluate(`(() => { const n=document.querySelector(${JSON.stringify(selector)}); return !!n&&!n.hidden&&n.getBoundingClientRect().width>0&&n.getBoundingClientRect().height>0; })()`);
}
async function click(selector) {
  await waitFor(() => visible(selector), `visible ${selector}`);
  let previous;
  const point = await waitFor(async () => {
    const current = await cdp.evaluate(`(() => { const n=document.querySelector(${JSON.stringify(selector)}); if(!n)return null;n.scrollIntoView({block:'center',inline:'nearest'});const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,t=document.elementFromPoint(x,y);return t&&(t===n||n.contains(t))?{x,y}:null; })()`);
    const stable = current && previous && Math.abs(current.x - previous.x) < .5 && Math.abs(current.y - previous.y) < .5;
    previous = current; return stable ? current : null;
  }, `clickable ${selector}`);
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}
async function fill(selector, text) {
  await click(selector);
  await key('a', 2);
  await cdp.call('Input.insertText', { text });
}
async function key(keyValue, modifiers = 0) {
  const definitions = {
    a: ['KeyA', 65], m: ['KeyM', 77], '/': ['Slash', 191], Enter: ['Enter', 13],
    Escape: ['Escape', 27], ArrowDown: ['ArrowDown', 40], ArrowUp: ['ArrowUp', 38],
  };
  const [code, windowsVirtualKeyCode] = definitions[keyValue] ?? [keyValue, 0];
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: keyValue, code, windowsVirtualKeyCode, modifiers,
    ...(keyValue === 'Enter' ? { text: '\r' } : {}) });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: keyValue, code, windowsVirtualKeyCode, modifiers });
}
const inputValue = () => cdp.evaluate('document.getElementById("composerInput")?.value');
async function waitInput(expected, label = `input ${expected}`) {
  await waitFor(async () => await inputValue() === expected, label);
}
async function draft(mode, botId) {
  return (await api(`/api/dimension/draft?mode=${mode}&botId=${botId}&groupId=`)).draft;
}
async function screenshot(name) {
  await delay(150);
  const { data } = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(output, `${name}.png`);
  await writeFile(file, Buffer.from(data, 'base64'));
  assert((await stat(file)).size > 1000);
  shots.push(file);
}
function pass(name) { checks.push(name); console.log(`PASS ${name}`); }
async function shutdown(item) {
  if (item.process.exitCode !== null) return;
  const exited = once(item.process, 'exit');
  if (item.label === 'chrome') { if (cdp) await cdp.call('Browser.close').catch(() => {}); }
  else item.process.stdin.end('shutdown\n');
  if (!await Promise.race([exited.then(() => true), delay(5000).then(() => false)])) {
    await new Promise(resolve => execFile('taskkill', ['/PID', String(item.process.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
  }
}

try {
  const model = startProcess('model-fixture', process.execPath, [path.join(root, 'tests/app-integration.mjs'), '--fixture-only']);
  const modelReady = await waitFor(() => model.records.find(row => row.baseUrl), 'local model fixture');
  const server = startProcess('native', executable, ['--data', path.join(output, 'data'), '--ui', path.join(root, 'ui'), '--port', '0']);
  const ready = await waitFor(() => server.records.find(row => row.ready), 'native ready');
  origin = `http://127.0.0.1:${ready.port}`;
  await api('/api/providers/experience-fixture/save', { method: 'POST', body: { name: 'experience-fixture',
    entry: { kind: 'openai-chat-compat', baseUrl: modelReady.baseUrl, spec: { model: 'fixture-flash', maxTokens: 4096 } }, secretValue: 'synthetic-key' } });
  const persona = '【SELF.md】\n原始自我\n\n【PERSONALITY.md】\n原始性格\n\n【PREFERENCES.md】\n原始喜好\n\n【SPEECH.md】\n原始说话\n\n【CRAFT.md】\n原始工作';
  for (const [id, name] of [[alpha, '体验甲'], [beta, '体验乙']]) {
    await api('/api/dimension/bots', { method: 'POST', body: { id, name, persona } });
    await api(`/api/dimension/bots/${id}/roster`, { method: 'PATCH', body: { mode: 'work', present: true } });
  }

  const profile = path.join(output, 'chrome-profile');
  chrome = startProcess('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--window-size=1440,1000', '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-extensions',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', 'about:blank']);
  const debugPort = await waitFor(async () => Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]), 'CDP port');
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  cdp = await Cdp.connect(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  cdp.on('Runtime.exceptionThrown', row => exceptions.push(row.exceptionDetails.exception?.description || row.exceptionDetails.text));
  cdp.on('Network.responseReceived', row => { if (row.response.status >= 400) badResponses.push({ url: row.response.url, status: row.response.status }); });
  await cdp.call('Page.enable'); await cdp.call('Runtime.enable'); await cdp.call('Network.enable');
  await cdp.call('Page.navigate', { url: origin });
  await waitFor(() => visible(`#botList [data-id="${alpha}"]`), 'alpha roster');
  await click(`#botList [data-id="${alpha}"]`);
  await waitFor(() => cdp.evaluate('!document.getElementById("composerInput").disabled'), 'composer enabled');

  await fill('#composerInput', '甲未发送');
  await waitFor(async () => (await draft('chat', alpha))?.text === '甲未发送', 'alpha draft saved');
  await click(`#botList [data-id="${beta}"]`);
  await waitInput('', 'beta starts empty');
  await fill('#composerInput', '乙未发送');
  await waitFor(async () => (await draft('chat', beta))?.text === '乙未发送', 'beta draft saved');
  await click(`#botList [data-id="${alpha}"]`);
  await waitInput('甲未发送', 'alpha restored after switch');
  assert.equal((await draft('chat', beta)).text, '乙未发送');
  pass('Two Bot drafts survive switching without crossing text');

  await key('m', 10); // Ctrl+Shift+M
  await waitFor(() => cdp.evaluate('document.getElementById("modeSwitch").textContent === "Work"'), 'Work shortcut');
  await click(`#botList [data-id="${alpha}"]`);
  await fill('#composerInput', '甲 Work 未发送');
  await waitFor(async () => (await draft('work', alpha))?.text === '甲 Work 未发送', 'work draft saved');
  await key('m', 10);
  await waitFor(() => cdp.evaluate('document.getElementById("modeSwitch").textContent === "Chat"'), 'Chat shortcut');
  await waitInput('甲未发送', 'Chat draft distinct from Work');
  pass('Mode shortcut restores independent Chat and Work drafts');

  await key('/', 2);
  await waitFor(() => visible('.keyboard-help-list'), 'keyboard help');
  assert(await cdp.evaluate('document.querySelector(".keyboard-help-list").textContent.includes("Shift")'));
  await screenshot('keyboard-help');
  await key('Escape');
  await waitFor(() => cdp.evaluate('document.getElementById("modal").hidden'), 'help closed');
  await fill('#composerInput', '第一行');
  await key('Enter', 8);
  assert.equal(await inputValue(), '第一行\n');
  assert.equal(await cdp.evaluate('document.querySelectorAll(".bubble.user").length'), 0);
  pass('Keyboard help is discoverable and Shift+Enter edits without sending');

  await fill('#composerInput', 'UI_SEND_ALPHA');
  await key('Enter', 2);
  await waitInput('', 'keyboard send clears editor');
  await waitFor(async () => (await draft('chat', alpha)) === null, 'submitted alpha draft cleared');
  await waitFor(() => cdp.evaluate('[...document.querySelectorAll(".bubble.user")].some(n=>n.textContent.includes("UI_SEND_ALPHA"))'), 'keyboard message submitted');
  assert.equal((await draft('chat', beta)).text, '乙未发送');
  assert.equal((await draft('work', alpha)).text, '甲 Work 未发送');
  pass('Ctrl+Enter uses the send command and clears only the submitted draft');

  await key('ArrowDown', 3); // Ctrl+Alt+Down activates the same roster button.
  await waitInput('乙未发送', 'conversation navigation shortcut');
  await cdp.call('Page.reload', { ignoreCache: true });
  await waitFor(() => visible(`#botList [data-id="${beta}"]`), 'roster after reload');
  await click(`#botList [data-id="${beta}"]`);
  await waitInput('乙未发送', 'unsent draft restored after reopen');
  assert.equal(await cdp.evaluate('[...document.querySelectorAll(".bubble.user")].filter(n=>n.textContent.includes("乙未发送")).length'), 0);
  pass('Browser reopen restores the exact Bot draft and never auto-submits it');

  await click(`#botList [data-id="${alpha}"]`);
  await waitInput('', 'sent alpha stays empty after reopen');
  await fill('#composerInput', 'UI_BUTTON_SEND');
  await click('#sendBtn');
  await waitFor(async () => (await draft('chat', alpha)) === null, 'button-submitted draft cleared');
  await waitFor(() => cdp.evaluate('[...document.querySelectorAll(".bubble.user")].some(n=>n.textContent.includes("UI_BUTTON_SEND"))'), 'button message submitted');
  assert.equal((await draft('chat', beta)).text, '乙未发送');
  pass('Send button and keyboard share submission and scoped clearing behavior');

  await click('#identityBtn');
  await click('[data-open="persona"]');
  await waitFor(() => cdp.evaluate('document.querySelectorAll("#personaEditor textarea[data-key]").length === 5'), 'five persona fields');
  await fill('#persona-speech_style', 'UI_AFTER_PERSONA');
  await click('#savePersona');
  await waitFor(() => visible('#personaPreview'), 'persona diff preview');
  const diff = await cdp.evaluate('document.getElementById("personaPreview").textContent');
  assert(diff.includes('原始说话') && diff.includes('UI_AFTER_PERSONA') && diff.includes('修改前') && diff.includes('修改后'));
  const beforeConfirm = await api(`/api/dimension/persona?botId=${alpha}`);
  assert.equal(beforeConfirm.fields.find(field => field.key === 'speech_style').content, '原始说话');
  await screenshot('persona-diff-before-confirm');
  await click('#confirmPersonaSave');
  await waitFor(() => cdp.evaluate('document.getElementById("personaMsg").textContent.includes("已保存")'), 'persona saved');
  await waitFor(() => visible('[data-persona-restore]'), 'previous persona available');
  pass('Five-field editor shows real before/after differences and saves only after confirmation');

  await click('[data-persona-restore]');
  await waitFor(() => visible('#personaPreview'), 'restore diff preview');
  const restoreDiff = await cdp.evaluate('document.getElementById("personaPreview").textContent');
  assert(restoreDiff.includes('UI_AFTER_PERSONA') && restoreDiff.includes('原始说话'));
  await click('#confirmPersonaSave');
  await waitFor(() => cdp.evaluate('document.getElementById("personaMsg").textContent.includes("已恢复")'), 'persona restored');
  const restored = await api(`/api/dimension/persona?botId=${alpha}`);
  assert.equal(restored.fields.find(field => field.key === 'speech_style').content, '原始说话');
  const revisions = await api(`/api/dimension/persona/revisions?botId=${alpha}`);
  assert.equal(revisions.revisions.length, 2);
  assert.equal(revisions.revisions[0].action, 'restore');
  assert.equal(revisions.revisions[0].fields.find(field => field.key === 'speech_style').content, 'UI_AFTER_PERSONA');
  await cdp.evaluate('document.getElementById("personaRevisions").scrollIntoView({block:"center"})');
  await screenshot('persona-restored-with-revision');
  pass('Restore previews differences and records a reversible restoration revision');

  await key('Escape');
  await screenshot('final-composer');
  assert.deepEqual(exceptions, [], 'no browser runtime exceptions');
  assert.deepEqual(badResponses, [], 'no failed browser requests');
  pass('Real browser run has zero console exceptions and zero HTTP error responses');
} catch (error) {
  failure = String(error.stack ?? error);
} finally {
  for (const item of [...children].reverse()) {
    try { await shutdown(item); } catch (error) { failure ??= String(error); }
  }
  const report = { passed: !failure, checks, failure: failure ?? null, exceptions, badResponses, screenshots: shots,
    productionDataUsed: false, externalServicesUsed: false };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: checks.length, report: path.join(output, 'result.json'), failure: report.failure }));
  if (!report.passed) process.exitCode = 1;
}
