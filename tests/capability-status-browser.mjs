import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startBrowser } from './native-browser-fixture.mjs';
import { until, digest } from './archive-export-api.mjs';

const project = path.resolve(import.meta.dirname, '..');
const output = path.join(project, 'outputs/capability-status', 'browser-' + Date.now());
await mkdir(path.join(output, 'temp'), { recursive: true });
const requests = [], failures = [], checks = [];
const pass = text => { checks.push(text); console.log('PASS ' + text); };
let browser, server, degraded = false;
try {
  const html = `<!doctype html><meta charset="utf-8"><title>能力状态合成测试</title>
    <style>:root{--color-composer-ring:#ddd;--color-raised:#fff;--color-ink:#222;--color-app:#f7f5f0;--color-ink-secondary:#555;--color-ink-tertiary:#777;--color-control:#eee;--color-raised-hover:#eee;--color-success:#176b45;--color-warning:#966200;--color-danger:#b42332}body{font-family:system-ui}</style>
    <button id="sharedCapabilityStatusBtn">能力状态</button>
    <script type="module">
      import {bindCapabilityStatus} from '/dimension-ui/capability-status-ui.js';
      const api=async(path,options={})=>{const response=await fetch(path,options);const data=await response.json();if(!response.ok)throw Error(data.error||('HTTP '+response.status));return data};
      window.statusUi=bindCapabilityStatus({api});window.ready=true;
    </script>`;
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1'); requests.push({ method: req.method, path: url.pathname });
    const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/dimension-ui/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return; }
    if (url.pathname === '/dimension-ui/capability-status-ui.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(await readFile(path.join(project, 'ui/capability-status-ui.js'))); return; }
    if (url.pathname === '/api/status') return json({ ready: true, status: 'ready' });
    if (url.pathname === '/api/native/info') return json({ version: '0.4.0', phase: 3, stageStatus: 'native-ready', dataFormat: 'sqlite-v7', desktopConfigured: !degraded, capabilities: ['linux-desktop', 'sandbox-build-test'] });
    if (url.pathname === '/api/providers') {
      if (degraded) return json({ error: 'synthetic providers unavailable' }, 500);
      return json([{ id: 'deepseek', ready: true, secretConfigured: true }, { id: 'backup', ready: false, secretConfigured: 'none' }]);
    }
    if (url.pathname === '/api/dimension/bootstrap') return json({ model: { model: 'deepseek-flash', effective: { providerId: 'deepseek', model: 'deepseek-flash' } } });
    if (url.pathname === '/api/dimension/plugins') {
      if (degraded) return json({ error: 'synthetic plugins unavailable' }, 500);
      return json({ plugins: [{ id: 'one', state: 'loaded', enabled: true }, { id: 'two', state: 'failed', enabled: false }] });
    }
    if (url.pathname === '/api/extensions') return degraded ? json({ error: 'synthetic extensions unavailable' }, 500) : json({ extensions: [] });
    if (url.pathname === '/api/dimension/plugin-market') return degraded ? json({ error: 'synthetic market unavailable' }, 500) : json({ available: true, hostReady: true });
    json({ error: 'not found' }, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await startBrowser({ output, processes: [] }, 'http://127.0.0.1:' + server.address().port);
  await until(() => browser.evaluate('window.ready'), 'status component ready');
  await browser.click('#sharedCapabilityStatusBtn');
  await until(() => browser.evaluate('document.querySelectorAll(".cap-status-card").length===5 && document.querySelector(".cap-status-summary").textContent.includes("只读检查完成")'), 'five status cards loaded');
  const initial = await browser.evaluate('document.querySelector(".cap-status-dialog").textContent');
  assert(initial.includes('本地接口正常') && initial.includes('外部网络与服务商连通性未主动测试'));
  assert(initial.includes('1/2 个接口就绪') && initial.includes('deepseek / deepseek-flash'));
  assert(initial.includes('2 个已发现 · 1 个已启用 · 1 个失败'));
  assert(initial.includes('Linux / 沙盒') && initial.includes('已配置'));
  assert(initial.includes('未发起模型生成或目录刷新') && initial.includes('未执行 Linux 命令'));
  assert(requests.every(row => row.method === 'GET'));
  assert(!requests.some(row => row.path.includes('/models') || row.path.includes('sandbox_exec')));
  await browser.screenshot('capability-status-ready');
  pass('Read-only self-check separates local network, provider readiness, plugin failures and configured sandbox without generation or command execution');

  degraded = true;
  await browser.click('[data-refresh]');
  await until(() => browser.evaluate('document.querySelector(".cap-status-summary").textContent.includes("3 项检查失败")'), 'independent failures rendered');
  const failed = await browser.evaluate('document.querySelector(".cap-status-dialog").textContent');
  assert(failed.includes('本地服务') && failed.includes('正常'));
  assert(failed.includes('模型') && failed.includes('检查失败'));
  assert(failed.includes('插件') && failed.includes('检查失败'));
  assert(failed.includes('Linux / 沙盒') && failed.includes('未配置'));
  assert.equal(await browser.evaluate('document.querySelector(".cap-status-dialog").open'), true);
  assert.equal(await browser.evaluate('document.querySelector("[data-refresh]").disabled'), false);
  assert(requests.every(row => row.method === 'GET'));
  await browser.screenshot('capability-status-partial-failure');
  await browser.click('[data-close]');
  assert.equal(await browser.evaluate('document.querySelector(".cap-status-dialog").open'), false);
  pass('Refresh keeps successful sections visible under provider/plugin/market failures and never turns configuration state into a fake execution test');
  assert.deepEqual(browser.exceptions, []); assert.deepEqual(browser.blockedExternal, []);
} catch (error) { failures.push(error.stack); console.error(error.stack); process.exitCode = 1; }
finally {
  if (browser) await browser.stop().catch(error => { failures.push(error.stack); process.exitCode = 1; });
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: failures.length === 0, checks, failures, requests,
    fingerprint: digest(await readFile(path.join(project, 'ui/capability-status-ui.js'))), screenshots: browser?.screenshots || [] }, null, 2));
  console.log('REPORT ' + path.join(output, 'report.json'));
}
