// Isolated headless Chrome. CDP input targets this test page only; no host input.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { until } from './archive-export-api.mjs';

export class Cdp {
  constructor(socket, exceptions) {
    this.socket = socket; this.sequence = 0; this.pending = new Map(); this.listeners = new Map();
    socket.addEventListener('message', event => {
      const value = JSON.parse(event.data);
      if (value.id) {
        const item = this.pending.get(value.id); if (!item) return;
        this.pending.delete(value.id); clearTimeout(item.timer);
        if (value.error) item.reject(Error(JSON.stringify(value.error))); else item.resolve(value.result);
      } else for (const handler of this.listeners.get(value.method) || [])
        Promise.resolve(handler(value.params)).catch(error => exceptions.push(error.message));
    });
    socket.addEventListener('close', () => {
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(Error('CDP closed')); }
      this.pending.clear();
    });
  }
  static async connect(url, exceptions) { const socket = new WebSocket(url); await once(socket, 'open'); return new Cdp(socket, exceptions); }
  on(method, handler) { const list = this.listeners.get(method) || []; list.push(handler); this.listeners.set(method, list); }
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
export async function startBrowser(config, origin, chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe') {
  const profile = path.join(config.output, 'chrome-profile');
  await mkdir(profile, { recursive: true });
  const child = spawn(chromePath, ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--window-size=1440,1300', '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-extensions', '--disable-client-side-phishing-detection',
    '--disable-breakpad', '--disable-features=OptimizationHints,MediaRouter', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', 'about:blank'],
    { cwd: config.output, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TEMP: path.join(config.output, 'temp'), TMP: path.join(config.output, 'temp') } });
  const processEntry = { label: 'chrome', child, stdout: '', stderr: '' }; config.processes.push(processEntry);
  child.stdout.on('data', bytes => { processEntry.stdout += bytes; }); child.stderr.on('data', bytes => { processEntry.stderr += bytes; });
  child.on('error', error => { processEntry.error = error; });
  const port = await until(async () => {
    if (processEntry.error) throw Object.assign(processEntry.error, { fatal: true });
    return Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
  }, 'Chrome debugging port');
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const page = pages.find(value => value.type === 'page'); assert(page);
  const browser = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
  const exceptions = [], requests = [], responses = [], blockedExternal = [], screenshots = [];
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl, exceptions), browserCdp = await Cdp.connect(browser.webSocketDebuggerUrl, exceptions);
  cdp.on('Runtime.exceptionThrown', value => exceptions.push(value.exceptionDetails.exception?.description || value.exceptionDetails.text));
  cdp.on('Network.requestWillBeSent', value => {
    const url = new URL(value.request.url), request = value.request;
    let body; try { body = request.postData ? JSON.parse(request.postData) : undefined; } catch {}
    requests.push({ id: value.requestId, pathname: url.pathname, query: url.search, method: request.method, body });
  });
  cdp.on('Network.responseReceived', value => responses.push({ id: value.requestId, pathname: new URL(value.response.url).pathname, status: value.response.status }));
  let failNextRequest = null;
  cdp.on('Fetch.requestPaused', async value => {
    const url = new URL(value.request.url);
    if (failNextRequest?.(value.request)) {
      failNextRequest = null;
      await cdp.call('Fetch.failRequest', { requestId: value.requestId, errorReason: 'Failed' });
    } else if (['http:', 'https:'].includes(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname)) {
      blockedExternal.push(url.origin); await cdp.call('Fetch.failRequest', { requestId: value.requestId, errorReason: 'BlockedByClient' });
    } else await cdp.call('Fetch.continueRequest', { requestId: value.requestId });
  });
  await cdp.call('Runtime.enable'); await cdp.call('Network.enable'); await cdp.call('Page.enable');
  await cdp.call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await cdp.call('Page.navigate', { url: origin + '/dimension-ui/' });
  const evaluate = expression => cdp.evaluate(expression);
  async function click(selector, button = 'left') {
    let previous;
    const point = await until(async () => {
      const current = await evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.hidden||el.disabled)return null;el.scrollIntoView({block:'center',inline:'nearest'});const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,top=document.elementFromPoint(x,y);return r.width>0&&r.height>0&&top&&(top===el||el.contains(top))?{x,y}:null})()`);
      const stable = current && previous && Math.abs(current.x - previous.x) < 0.5 && Math.abs(current.y - previous.y) < 0.5;
      previous = current; return stable ? current : null;
    }, 'clickable ' + selector);
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button, clickCount: 1, ...point });
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button, clickCount: 1, ...point });
  }
  async function replace(selector, text) {
    await click(selector);
    await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await cdp.call('Input.insertText', { text });
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).value`), text);
  }
  async function screenshot(name) {
    const result = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(config.output, name + '.png'); await writeFile(file, Buffer.from(result.data, 'base64')); screenshots.push(file);
  }
  async function closeEditor() {
    if (await evaluate('!document.querySelector("#modal").hidden')) {
      await click('#modal [data-close]'); await until(() => evaluate('document.querySelector("#modal").hidden'), 'editor closed');
    }
  }
  async function openMemory() {
    await closeEditor();
    if (await evaluate('document.querySelector("#drawer").hidden')) await click('#identityBtn');
    await click('[data-open="memory"]'); await until(() => evaluate('!!document.querySelector("#saveMidMemory")'), 'native memory editor');
  }
  async function stop() {
    if (child.exitCode === null) {
      await browserCdp.call('Browser.close').catch(() => {});
      await until(() => child.exitCode !== null, 'Chrome shutdown', 10000);
    }
    cdp.socket.close(); browserCdp.socket.close();
    const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "chrome.exe" -and $_.CommandLine -and $_.CommandLine.Contains($env:DIMENSION_TEST_CHROME_PROFILE) } | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
      { cwd: config.output, windowsHide: true, timeout: 15000, env: { ...process.env, DIMENSION_TEST_CHROME_PROFILE: profile } });
    assert.equal(result.stdout.trim(), '', 'No residual test Chrome processes');
    assert.equal(child.exitCode, 0, 'Chrome exits normally');
  }
  return { cdp, evaluate, click, replace, screenshot, closeEditor, openMemory, stop, exceptions, requests, responses, blockedExternal, screenshots,
    failNext: predicate => { failNextRequest = predicate; } };
}
