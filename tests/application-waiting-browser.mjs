import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startBrowser } from './native-browser-fixture.mjs';
import { until, digest } from './archive-export-api.mjs';

const project = path.resolve(import.meta.dirname, '..'), output = path.join(project, 'outputs/application-waiting', 'browser-' + Date.now());
await mkdir(path.join(output, 'temp'), { recursive: true });
const failures = [], checks = [], calls = [];
let browser, server;
const state = {
  apps: [],
  jobs: [
    { id: 'old-owner', appId: 'fixture', botId: 'alpha', runId: 'run-old', prompt: '旧生图任务', status: 'waiting-user', detail: '等待用户检查旧网页', waitingFor: [] },
    { id: 'new-waiting', appId: 'fixture', botId: 'beta', runId: 'run-new', prompt: '新生图任务', status: 'queued', detail: '应用被旧任务占用，正在等待处理', waitReason: '应用被旧任务占用，正在等待处理',
      waitingFor: [{ jobId: 'old-owner', botId: 'alpha', runId: 'run-old', status: 'waiting-user', ownership: 'desktop' }] },
  ],
};
const pass = text => { checks.push(text); console.log('PASS ' + text); };
try {
  const html = `<!doctype html><meta charset="utf-8"><title>应用等待反馈合成测试</title><link rel="stylesheet" href="/dimension-ui/app-bridge.css"><button id="sharedApplicationsBtn">应用服务</button>
    <script type="module">import {bindApplicationBridge} from '/dimension-ui/app-bridge-ui.js';
      const api=async(path,options={})=>{const response=await fetch(path,{...options,headers:{'content-type':'application/json'}});const data=await response.json();if(!response.ok)throw Error(data.error||response.status);return data};
      bindApplicationBridge({api,getBots:()=>[{id:'alpha',name:'旧任务 Bot'},{id:'beta',name:'新任务 Bot'}]});window.ready=true;
    </script>`;
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/dimension-ui/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return; }
    if (/^\/dimension-ui\/[a-zA-Z0-9.-]+\.(js|css)$/.test(url.pathname)) {
      const file = path.join(project, 'ui', path.basename(url.pathname));
      res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/css' }); res.end(await readFile(file)); return;
    }
    if (url.pathname === '/api/dimension/app-bridge') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(state)); return; }
    if (url.pathname === '/api/dimension/app-bridge/jobs/old-owner/cancel' && req.method === 'POST') {
      calls.push('cancel-old'); state.jobs[1].waitingFor = []; state.jobs[1].detail = '等待应用桌面可用'; state.jobs[1].waitReason = '等待应用桌面可用';
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ job: state.jobs[0] })); return;
    }
    if (url.pathname === '/api/dimension/app-bridge/jobs/new-waiting/cancel' && req.method === 'POST') { calls.push('cancel-new'); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await startBrowser({ output, processes: [] }, 'http://127.0.0.1:' + server.address().port);
  await until(() => browser.evaluate('window.ready'), 'application bridge ready');
  await browser.click('#sharedApplicationsBtn');
  await until(() => browser.evaluate('document.querySelectorAll(".ab-waiters").length===1'), 'owner wait reason rendered');
  const waiting = await browser.evaluate('document.querySelector("[data-job-id=new-waiting]").textContent');
  assert(waiting.includes('应用被旧任务占用') && waiting.includes('旧任务 Bot') && waiting.includes('桌面占用中'));
  await browser.click('[data-job-id=new-waiting] .ab-waiters button');
  await until(() => calls.length === 1 && calls[0] === 'cancel-old', 'old owner cancelled');
  await until(() => browser.evaluate('document.querySelectorAll(".ab-waiters").length===0'), 'wait reason cleared');
  assert(!calls.includes('cancel-new'));
  await browser.screenshot('application-waiting-owner');
  assert.deepEqual(browser.exceptions, []); assert.deepEqual(browser.blockedExternal, []);
  pass('Waiting panel names the actual old owner and cancels only that owner; queued task is not stopped and its reason clears after release');
} catch (error) { failures.push(error.stack); console.error(error.stack); process.exitCode = 1; }
finally {
  if (browser) await browser.stop().catch(error => { failures.push(error.stack); process.exitCode = 1; });
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: failures.length === 0, checks, failures, calls,
    fingerprint: digest(await readFile(path.join(project, 'ui/app-bridge-ui.js'))), screenshots: browser?.screenshots || [] }, null, 2));
  console.log('REPORT ' + path.join(output, 'report.json'));
}
