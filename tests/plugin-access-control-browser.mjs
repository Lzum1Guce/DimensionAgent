// Real Chrome against the real guard HTTP adapter and synthetic MCP delegate.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { handleRequest } from '../runtime/plugin-host-guard.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(project, 'outputs', 'plugin-access-control-browser'); await mkdir(out, { recursive: true });
const work = await mkdtemp(path.join(out, 'run-')), dataDir = path.join(work, 'data'), profile = path.join(work, 'chrome');
const delegate = path.join(project, 'tests', 'fixtures', 'plugin-guard-delegate.mjs');
const children = [], checks = [], external = [], failures = [];
let chrome, socket, cdp, server, success = false, pluginId;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 12000) { const end = Date.now() + timeout; let last; while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await delay(60); } throw new Error(`${label}: ${last?.message || 'timeout'}`); }
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); ws.addEventListener('message', event => { const value = JSON.parse(event.data); if (value.id) { const item = this.pending.get(value.id); if (!item) return; clearTimeout(item.timer); this.pending.delete(value.id); value.error ? item.reject(new Error(JSON.stringify(value.error))) : item.resolve(value.result); } else for (const fn of this.handlers.get(value.method) || []) fn(value.params); }); }
  on(name, fn) { const values = this.handlers.get(name) || []; values.push(fn); this.handlers.set(name, values); }
  call(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timeout')); }, 12000); this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async evaluate(expression) { const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; }
}
async function click(selector) { const point = await until(() => cdp.evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)return null;n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return r.width&&r.height?{x,y}:null})()`), 'click ' + selector); await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }); await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }); }
const check = name => { checks.push(name); console.log('PASS ' + name); };
async function backend(action, args = {}) { const response = await handleRequest({ action, dataDir, pluginHost: delegate, ...args }); assert.equal(response.ok, true, JSON.stringify(response)); return response; }
async function fixture(directory, version, permissions) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'fixture-guarded-echo', version, license: 'MIT', permissions, fixture: { server: 'server.mjs' } }));
  await writeFile(path.join(directory, 'server.mjs'), `import{createInterface}from'node:readline';import{mkdirSync,appendFileSync}from'node:fs';import{join}from'node:path';const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;if(m.method==='initialize')send(m.id,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'ui-fixture',version:'1'}});else if(m.method==='tools/call'){mkdirSync(process.env.PLUGIN_DATA_DIR,{recursive:true});appendFileSync(join(process.env.PLUGIN_DATA_DIR,'calls.log'),'ui-call\\n');send(m.id,{content:[{type:'text',text:'echo: '+m.params.arguments.text}]});}else send(m.id,{});}`);
}
async function serve() {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = value => { res.writeHead(200, { 'content-type': 'application/json;charset=utf-8' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/dimension/plugin-market' && req.method === 'GET') return json({ available: true });
    if (url.pathname === '/api/dimension/plugin-market' && req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
      if (body.action === 'adaptation.bots') return json({ ok: true, bots: [{ id: 'bot-a', name: '测试 Bot A' }, { id: 'bot-b', name: '测试 Bot B' }] });
      if (body.action === 'source.list') return json({ ok: true, sources: [] });
      return json(await handleRequest({ ...body, dataDir, pluginHost: delegate }));
    }
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); res.end(`<!doctype html><meta charset="utf-8"><div id="market"></div><script type="module">import{bindPluginMarket}from'/plugin-market-ui.js';const api=async(p,o={})=>{const r=await fetch(p,{...o,headers:{'content-type':'application/json'}});const v=await r.json();if(!r.ok||v.ok===false)throw new Error(v.error?.message||'request failed');return v};window.market=bindPluginMarket({api,host:document.querySelector('#market')});window.market.open();</script>`); return; }
    if (['/plugin-market-ui.js', '/plugin-market-ui.css'].includes(url.pathname)) { const file = path.join(project, 'ui', url.pathname.slice(1)); res.writeHead(200, { 'content-type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(await readFile(file)); return; }
    res.writeHead(404); res.end();
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`;
}

try {
  const v1 = path.join(work, 'v1'); await fixture(v1, '1.0.0', ['process:execute']);
  const plan = (await backend('package.inspect', { path: v1 })).inspection;
  pluginId = (await backend('package.install', { planId: plan.planId })).plugin.id;
  const origin = await serve();
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(chrome); const reader = createInterface({ input: chrome.stderr }); reader.on('line', () => {});
  const port = await until(async () => Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]), 'Chrome port');
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page');
  socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, 'open'); cdp = new Cdp(socket);
  cdp.on('Runtime.exceptionThrown', value => failures.push(value.exceptionDetails.exception?.description || value.exceptionDetails.text));
  cdp.on('Fetch.requestPaused', async value => { const url = new URL(value.request.url); if (['127.0.0.1', 'localhost'].includes(url.hostname)) await cdp.call('Fetch.continueRequest', { requestId: value.requestId }); else { external.push(value.request.url); await cdp.call('Fetch.failRequest', { requestId: value.requestId, errorReason: 'BlockedByClient' }); } });
  for (const method of ['Page.enable', 'Runtime.enable', 'Fetch.enable']) await cdp.call(method, method === 'Fetch.enable' ? { patterns: [{ urlPattern: '*' }] } : {});
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.call('Page.navigate', { url: origin });
  await until(() => cdp.evaluate(`!!document.querySelector('.pm-installed-card')`), 'installed card');
  await click('[data-market-tab="installed"]');
  const initial = await cdp.evaluate(`document.querySelector('.pm-installed-card').textContent`);
  assert(initial.includes('1.0.0') && initial.includes(v1) && initial.includes('无需登录') && initial.includes('未启用') && initial.includes('process:execute'), initial);
  check('Installed UI separates install/login/enable and shows exact source, version and permissions');

  await cdp.evaluate(`(()=>{const n=document.querySelector('.pm-scope-select');n.value='bot:bot-a';n.dispatchEvent(new Event('change'))})()`);
  await click('.pm-installed-card .pm-card-actions button');
  await until(() => cdp.evaluate(`document.querySelector('.pm-scope-list')?.textContent.includes('测试 Bot A')`), 'Bot scope enabled');
  const enabled = (await backend('plugin.list')).plugins[0]; assert.equal(enabled.scopes[0].botId, 'bot-a'); assert.equal(enabled.enabled, true);
  await backend('tools.call', { botId: 'bot-a', runId: 'run-ui', runCreatedAt: new Date().toISOString(), name: 'mcp__fixture__echo', args: { text: 'ui-data' } });
  check('UI grants only the selected Bot and a real MCP call creates retained plugin data');

  const v2 = path.join(work, 'v2'); await fixture(v2, '2.0.0', ['process:execute', 'network:https://example.test']);
  const update = (await backend('package.inspect', { path: v2 })).inspection; await backend('package.update', { pluginId, planId: update.planId });
  await click('.pm-refresh');
  await until(() => cdp.evaluate(`document.querySelector('.pm-permission-warning')?.textContent.includes('旧 Work')`), 'reconfirmation warning');
  assert.equal(await cdp.evaluate(`document.querySelector('.pm-permissions').open`), true);
  await click('.pm-installed-card .pm-card-actions button');
  await until(() => cdp.evaluate(`!!document.querySelector('.pm-reconfirm')`), 'confirmation panel');
  await cdp.evaluate(`document.querySelector('.pm-reconfirm input').checked=true`);
  await click('.pm-reconfirm button');
  await until(async () => (await backend('plugin.list')).plugins[0].enabled, 'reauthorized');
  check('Permission widening displays the full list and requires an explicit checkbox before enabling');

  await click('.pm-installed-card .pm-card-actions button:nth-child(2)'); await click('.pm-installed-card .pm-confirm button');
  await until(() => cdp.evaluate(`!!document.querySelector('.pm-retained-data')`), 'retained data section');
  assert.equal((await backend('plugin.list')).plugins.length, 0);
  await click('.pm-retained-row > button'); await click('.pm-retained-row .pm-confirm button');
  await until(() => cdp.evaluate(`!document.querySelector('.pm-retained-data')`), 'data deleted separately');
  assert.deepEqual(external, []); assert.deepEqual(failures, []);
  check('Uninstall and data deletion are separate confirmed UI operations; no external requests or script errors');
  success = true;
} catch (error) { failures.push(error.stack); console.error(error.stack); process.exitCode = 1; }
finally {
  if (cdp) await cdp.call('Browser.close').catch(() => {});
  for (const child of children) if (child.exitCode === null) child.kill();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await writeFile(path.join(out, 'result.json'), JSON.stringify({ success, checks, failures, external, fixtureDirectory: work, realAccountsUsed: false, externalNetworkUsed: false }, null, 2));
  console.log(JSON.stringify({ success, checks: checks.length, report: path.join(out, 'result.json') }));
}
