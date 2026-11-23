// Browser tests use original DimensionAgent UI, a synthetic legacy fixture, and
// the real native/Node compatibility host against a synthetic local marketplace.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ui = join(project, 'ui');
const output = join(project, 'outputs/phase3-plugin-ui', new Date().toISOString().replace(/[:.]/g, '-'));
const children = [], checks = [], screenshots = [], failures = [], requests = [], external = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let cdp, legacyServer, marketFixture;
await mkdir(join(output, 'temp'), { recursive: true });
async function waitFor(fn, label, timeout = 15000) {
  const until = Date.now() + timeout; let last;
  while (Date.now() < until) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await delay(75); }
  throw new Error(`Timeout: ${label}${last ? `: ${last.message}` : ''}`);
}
function start(label, file, args) {
  const child = spawn(file, args, { cwd: output, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TEMP: join(output, 'temp'), TMP: join(output, 'temp') } });
  const record = { label, child, lines: [], stdout: '', stderr: '' }; children.push(record);
  child.stdout.on('data', data => { record.stdout += data; }); child.stderr.on('data', data => { record.stderr += data; });
  const reader = createInterface({ input: child.stdout }); reader.on('line', line => { try { record.lines.push(JSON.parse(line)); } catch {} }); child.on('exit', () => reader.close());
  return record;
}
class Cdp {
  constructor(socket) {
    this.socket = socket; this.sequence = 0; this.pending = new Map(); this.handlers = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) { const item = this.pending.get(message.id); if (!item) return; clearTimeout(item.timer); this.pending.delete(message.id); message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result); }
      else for (const handler of this.handlers.get(message.method) || []) Promise.resolve(handler(message.params)).catch(error => failures.push(error.message));
    });
    socket.addEventListener('close', () => { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('CDP closed')); } this.pending.clear(); });
  }
  on(name, handler) { const handlers = this.handlers.get(name) || []; handlers.push(handler); this.handlers.set(name, handlers); }
  call(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timeout')); }, 15000); this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression) { const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; }
}
async function click(selector) {
  let previous;
  const point = await waitFor(async () => {
    const point = await cdp.evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled||n.hidden)return null;n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,top=document.elementFromPoint(x,y);return r.width&&r.height&&top&&(top===n||n.contains(top))?{x,y}:null})()`);
    const stable = point && previous && Math.abs(point.x - previous.x) < .5 && Math.abs(point.y - previous.y) < .5; previous = point; return stable ? point : null;
  }, `clickable ${selector}`);
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}
async function fill(selector, text) { await click(selector); await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }); await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }); await cdp.call('Input.insertText', { text }); }
async function change(selector, value) { await cdp.evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('change',{bubbles:true}))})()`); }
async function shot(name) { const { data } = await cdp.call('Page.captureScreenshot', { format: 'png' }); const path = join(output, name + '.png'); await writeFile(path, Buffer.from(data, 'base64')); screenshots.push(path); }
function pass(name) { checks.push(name); console.log('PASS ' + name); }
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function api(origin, action, args = {}) { const response = await fetch(origin + '/api/dimension/plugin-market', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...args }) }); const result = await response.json(); assert(response.ok && result.ok !== false, JSON.stringify(result)); return result; }

async function legacyFixture() {
  const allowed = new Set(['styles.css', 'shared-capabilities-ui.js', 'plugin-market-ui.js', 'plugin-market-ui.css']);
  legacyServer = http.createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const json = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (path === '/') { response.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); response.end(`<!doctype html><link rel="stylesheet" href="/dimension-ui/styles.css"><button id="sharedSkillsBtn">Skill</button><button id="sharedPluginsBtn">插件</button><script type="module">import {bindSharedCapabilities} from '/dimension-ui/shared-capabilities-ui.js';bindSharedCapabilities({api:async(p,o)=>{const r=await fetch(p,o);if(!r.ok)throw new Error('legacy endpoint unavailable');return r.json()}});</script>`); return; }
    if (path === '/api/dimension/plugin-market') { json(404, { error: 'legacy feature absent' }); return; }
    if (path === '/api/extensions') { json(200, { extensions: [] }); return; }
    if (path === '/api/dimension/plugins') { json(200, { plugins: [{ id: 'legacy-synthetic', name: 'Synthetic legacy plugin', version: '0.9.0', builtin: true, state: 'disabled' }] }); return; }
    if (path === '/api/dimension/skills') { json(200, { skills: [{ topic: 'legacy-skill', title: 'Synthetic legacy Skill', keywords: ['synthetic'], body: 'Legacy text remains intact.' }] }); return; }
    const name = path.replace('/dimension-ui/', '');
    if (allowed.has(name)) { response.writeHead(200, { 'content-type': name.endsWith('.css') ? 'text/css' : 'text/javascript' }); response.end(await readFile(join(ui, name))); return; }
    response.writeHead(404); response.end();
  });
  return listen(legacyServer);
}

let ok = false;
try {
  const legacyOrigin = await legacyFixture();
  const profile = join(output, 'chrome-profile');
  start('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--disable-breakpad', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', 'about:blank']);
  const port = await waitFor(async () => Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]), 'Chrome ready');
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page');
  const socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, 'open'); cdp = new Cdp(socket);
  cdp.on('Runtime.exceptionThrown', value => failures.push(value.exceptionDetails.exception?.description || value.exceptionDetails.text));
  cdp.on('Network.requestWillBeSent', value => { if (value.request.url.includes('/api/')) requests.push({ url: value.request.url, method: value.request.method, body: value.request.postData }); });
  cdp.on('Fetch.requestPaused', async value => { const url = new URL(value.request.url); if (['127.0.0.1', 'localhost'].includes(url.hostname) || ['about:', 'data:', 'blob:'].includes(url.protocol)) await cdp.call('Fetch.continueRequest', { requestId: value.requestId }); else { external.push(value.request.url); await cdp.call('Fetch.failRequest', { requestId: value.requestId, errorReason: 'BlockedByClient' }); } });
  for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable']) await cdp.call(method);
  await cdp.call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 960, deviceScaleFactor: 1, mobile: false });
  await cdp.call('Page.navigate', { url: legacyOrigin });
  await click('#sharedPluginsBtn');
  await waitFor(() => cdp.evaluate(`document.querySelector('.cap-plugin-list').textContent.includes('Synthetic legacy plugin')`), 'legacy plugin list');
  assert.equal(await cdp.evaluate(`document.querySelector('.cap-market-host').hidden`), true);
  assert.equal(await cdp.evaluate(`document.querySelector('.cap-legacy-plugins').hidden`), false);
  assert.equal(await cdp.evaluate(`document.querySelector('.cap-status').textContent`), '');
  await shot('01-legacy-plugin-fallback');
  await click('[data-tab="skills"]');
  await waitFor(() => cdp.evaluate(`document.querySelector('.cap-list').textContent.includes('Synthetic legacy Skill')`), 'legacy Skill list');
  await click('.cap-skill-item');
  assert.equal(await cdp.evaluate(`document.querySelector('.cap-skill-form textarea').value`), 'Legacy text remains intact.');
  pass('Old backend 404 silently preserves the local plugin interface and Skill editor');

  if (!process.argv.includes('--legacy-only')) {
    // The fixture is supplied by the compatibility-host test and contains only
    // synthetic format-1 packages and a synthetic MCP echo service.
    const { createBrowserMarketFixture } = await import('./plugin-host.test.mjs');
    marketFixture = await createBrowserMarketFixture(join(output, 'synthetic-market'));
    const native = start('native', join(project, 'outputs/build/DImensionagent-native.exe'), ['--data', join(output, 'data'), '--ui', ui, '--node', process.execPath, '--plugin-host', join(project, 'runtime/plugin-host.mjs'), '--port', '0']);
    const ready = await waitFor(() => native.lines.find(value => value.ready), 'native compatibility host ready');
    const origin = `http://127.0.0.1:${ready.port}`;
    await cdp.call('Page.navigate', { url: origin + '/dimension-ui/' });
    await click('#sharedPluginsBtn');
    await waitFor(() => cdp.evaluate(`!!document.querySelector('.plugin-market') && !document.querySelector('.cap-market-host').hidden`), 'feature-detected market');
    await waitFor(() => cdp.evaluate(`document.querySelector('.pm-results-note').textContent.includes('还没有索引源')`), 'empty sources loaded');
    assert.equal((await api(origin, 'source.list')).sources.length, 0);
    await shot('02-market-empty');
    await fill('.pm-source-form input', marketFixture.indexUrl);
    await click('.pm-source-form button');
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.pm-catalog .pm-card').length>=2`), 'synthetic source catalog');
    assert.equal((await api(origin, 'source.list')).sources.length, 1);
    assert.equal(await cdp.evaluate(`typeof window.__marketInjected`), 'undefined');
    await shot('03-source-and-catalog');
    pass('Optional market starts empty, accepts a user source, and renders metadata without executing HTML');

    const mcpName = marketFixture.mcpName, unsupportedName = marketFixture.unsupportedName;
    await fill('.pm-query', mcpName);
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.pm-catalog .pm-card').length===1 && document.querySelector('.pm-catalog .pm-card').dataset.packageName===${JSON.stringify(mcpName)}`), 'catalog search');
    await click('.pm-catalog .pm-card button');
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.pm-version option').length>=2`), 'version choices');
    const exact = marketFixture.exactVersion;
    await change('.pm-version', exact);
    await click('.pm-inspect-button');
    await waitFor(() => cdp.evaluate(`!!document.querySelector('.pm-install') && !document.querySelector('.pm-install').disabled`), 'exact-version compatible inspection');
    assert((await cdp.evaluate(`document.querySelector('.pm-inspection-result').textContent`)).includes(exact));
    await shot('04-exact-version-inspection');
    await change('.pm-version', marketFixture.otherVersion);
    assert.equal(await cdp.evaluate(`!!document.querySelector('.pm-install')`), false, 'Changing versions invalidates the prior installation plan');
    await change('.pm-version', exact); await click('.pm-inspect-button');
    await waitFor(() => cdp.evaluate(`!!document.querySelector('.pm-install') && !document.querySelector('.pm-install').disabled`), 'fresh exact-version inspection');
    await click('.pm-install');
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.pm-installed-card').length===1`), 'installed list');
    let plugin = (await api(origin, 'plugin.list')).plugins[0];
    assert.equal(plugin.version || plugin.manifest?.version, exact); assert.equal(plugin.enabled, false);
    await shot('05-installed-disabled');
    await click('.pm-installed-card .pm-card-actions button');
    await waitFor(async () => (await api(origin, 'plugin.list')).plugins[0]?.enabled === true, 'synthetic plugin enabled');
    await click('.pm-installed-card .pm-card-actions button');
    await waitFor(async () => (await api(origin, 'plugin.list')).plugins[0]?.enabled === false, 'synthetic plugin disabled');
    await click('.pm-installed-card .pm-card-actions button:nth-child(2)');
    await click('.pm-installed-card .pm-confirm button');
    await waitFor(async () => (await api(origin, 'plugin.list')).plugins.length === 0, 'synthetic plugin removed');
    pass('Exact version is checked and pinned; version changes invalidate plans; install defaults disabled and management round-trips');

    await click('[data-market-tab="discover"]');
    await fill('.pm-query', unsupportedName);
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.pm-catalog .pm-card').length===1 && document.querySelector('.pm-catalog .pm-card').dataset.packageName===${JSON.stringify(unsupportedName)}`), 'unsupported search');
    await click('.pm-catalog .pm-card button');
    await waitFor(() => cdp.evaluate(`!document.querySelector('.pm-inspect-button').disabled`), 'unsupported version');
    await click('.pm-inspect-button');
    await waitFor(() => cdp.evaluate(`!!document.querySelector('.pm-install')`), 'unsupported inspection');
    assert.equal(await cdp.evaluate(`document.querySelector('.pm-install').disabled`), true);
    assert((await cdp.evaluate(`document.querySelector('.pm-inspection-result').textContent`)).includes('需要适配'));
    assert((await cdp.evaluate(`document.querySelector('.pm-inspection-result .pm-reasons').textContent`)).length > 0, 'Incompatibility has a concrete reason');
    await shot('06-needs-adapter');
    await click('[data-market-tab="compatibility"]');
    assert((await cdp.evaluate(`document.querySelector('.pm-compatibility').textContent`)).includes('Cordis'));
    await shot('07-compatibility');
    await click('[data-market-tab="discover"]');
    await click('.pm-sources summary');
    if (!(await cdp.evaluate(`document.querySelector('.pm-sources').open`))) await click('.pm-sources summary');
    await click('.pm-source button'); await click('.pm-source .pm-confirm button');
    await waitFor(async () => (await api(origin, 'source.list')).sources.length === 0, 'source removed');
    pass('Unsupported runtime dependencies show reasons and cannot install; compatibility guidance and source removal work');
    assert(!requests.some(request => request.body?.includes('local.discover') || request.body?.includes('local.import')), 'No real-machine discovery or import occurs');
  }
  assert.deepEqual(failures, []); assert.deepEqual(external, []); ok = true;
  console.log(JSON.stringify({ ok, checks: checks.length, output }));
} catch (error) {
  failures.push(error.stack); console.error(error.stack);
  if (cdp) { await shot('failure').catch(() => {}); await writeFile(join(output, 'failure-dom.txt'), await cdp.evaluate('document.body.innerText').catch(() => ''), 'utf8'); }
  process.exitCode = 1;
} finally {
  for (const entry of [...children].reverse()) {
    if (entry.child.exitCode === null) {
      const exit = once(entry.child, 'exit');
      if (entry.label === 'chrome') await cdp?.call('Browser.close').catch(() => {}); else entry.child.stdin.end('shutdown\n');
      if (!(await Promise.race([exit.then(() => true), delay(4000).then(() => false)]))) await new Promise(resolve => execFile('taskkill', ['/PID', String(entry.child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
    }
    await writeFile(join(output, entry.label + '.log'), entry.stdout + '\nSTDERR\n' + entry.stderr, 'utf8');
  }
  await marketFixture?.close();
  if (legacyServer) { legacyServer.closeAllConnections(); await new Promise(resolve => legacyServer.close(resolve)); }
  await writeFile(join(output, 'result.json'), JSON.stringify({ ok, checks, screenshots, failures, requests, external, processes: children.map(entry => ({ label: entry.label, pid: entry.child.pid, exitCode: entry.child.exitCode })) }, null, 2));
  console.log('Plugin UI artifacts: ' + output);
}
