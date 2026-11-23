import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startBrowser } from './native-browser-fixture.mjs';
import { until, digest } from './archive-export-api.mjs';
const project = path.resolve(import.meta.dirname, '..'), output = path.join(project, 'outputs/global-search', 'browser-' + Date.now());
await mkdir(path.join(output, 'temp'), { recursive: true });
const requests = [], failures = [], checks = []; let browser, server, fail = false;
const pass = text => { checks.push(text); console.log('PASS ' + text); };
try {
  const html = `<!doctype html><meta charset="utf-8"><title>全局搜索合成测试</title><style>:root{--color-composer-ring:#ddd;--color-raised:#fff;--color-ink:#222;--color-app:#f7f5f0;--color-ink-secondary:#555;--color-ink-tertiary:#777;--color-control:#eee;--color-raised-hover:#eee;--color-accent:#1084fe;--color-accent-ink:#fff;--color-warning:#b97b18}body{font-family:system-ui}</style>
    <button id="sharedGlobalSearchBtn">全局搜索</button><script type="module">import {bindGlobalSearch} from '/dimension-ui/global-search-ui.js';
    const api=async(path,options={})=>{const response=await fetch(path,options);const data=await response.json();if(!response.ok)throw Error(data.error||('HTTP '+response.status));return data};
    window.opened=[];window.addEventListener('dimension-global-search-open',event=>opened.push(event.detail));bindGlobalSearch({api});window.ready=true;</script>`;
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1'); requests.push({ method: req.method, path: url.pathname, query: url.searchParams.get('q') });
    if (url.pathname === '/dimension-ui/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return; }
    if (url.pathname === '/dimension-ui/global-search-ui.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(await readFile(path.join(project, 'ui/global-search-ui.js'))); return; }
    if (url.pathname === '/api/dimension/search') {
      res.writeHead(fail ? 500 : 200, { 'content-type': 'application/json' });
      if (fail) { res.end(JSON.stringify({ error: 'synthetic search unavailable' })); return; }
      const results = [
        { kind: 'bot', id: 'bot-alpha', text: 'Alpha Bot', title: 'Alpha Bot' },
        { kind: 'message', recordId: '11', botId: 'bot-alpha', title: 'Alpha Bot', text: 'alpha <img src=x onerror=alert(1)> conversation' },
        { kind: 'memory', recordId: '22', botId: 'bot-alpha', title: 'Alpha Bot', state: 'confirmed', text: 'alpha memory' },
        { kind: 'work', runId: 'run-alpha', botId: 'bot-alpha', title: 'alpha task', status: 'completed', text: 'alpha result' },
        { kind: 'artifact', runId: 'run-alpha', botId: 'bot-alpha', title: 'alpha task', artifact: 'alpha.txt', text: 'alpha.txt' },
      ];
      res.end(JSON.stringify({ query: url.searchParams.get('q'), count: results.length, results, workTruncated: false })); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await startBrowser({ output, processes: [] }, 'http://127.0.0.1:' + server.address().port);
  await until(() => browser.evaluate('window.ready'), 'global search ready');
  await browser.click('#sharedGlobalSearchBtn'); await browser.replace('.global-search-input', 'alpha'); await browser.click('.global-search-submit');
  await until(() => browser.evaluate('document.querySelectorAll(".global-search-row").length===5'), 'five result types');
  assert.equal(await browser.evaluate('document.querySelectorAll(".global-search-snippet mark").length>0'), true);
  assert.equal(await browser.evaluate('document.querySelectorAll(".global-search-snippet img").length'), 0);
  assert((await browser.evaluate('document.querySelector(".global-search-dialog").textContent')).includes('<img src=x onerror=alert(1)>'));
  await browser.screenshot('global-search-results');
  await browser.evaluate('document.querySelector(".global-search-type").value="memory";document.querySelector(".global-search-type").dispatchEvent(new Event("change"))');
  assert.equal(await browser.evaluate('document.querySelectorAll(".global-search-row").length'), 1);
  await browser.click('.global-search-row');
  assert.equal(await browser.evaluate('opened.length'), 1); assert.equal(await browser.evaluate('opened[0].kind'), 'memory'); assert.equal(await browser.evaluate('opened[0].recordId'), '22');
  assert.equal(await browser.evaluate('document.querySelector(".global-search-dialog").open'), false);
  assert(requests.every(row => row.method === 'GET'));
  pass('Search renders scoped typed results with safe text highlighting, type filters and exact record identity on open');

  await browser.evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"k",ctrlKey:true,bubbles:true}))');
  assert.equal(await browser.evaluate('document.querySelector(".global-search-dialog").open'), true);
  fail = true; await browser.click('.global-search-submit');
  await until(() => browser.evaluate('document.querySelector(".global-search-status").textContent.includes("synthetic search unavailable")'), 'search error visible');
  assert.equal(await browser.evaluate('document.querySelector(".global-search-submit").disabled'), false);
  assert.deepEqual(browser.exceptions, []); assert.deepEqual(browser.blockedExternal, []);
  pass('Ctrl+K opens search and request failures restore controls without injecting result HTML');
} catch (error) { failures.push(error.stack); console.error(error.stack); process.exitCode = 1; }
finally {
  if (browser) await browser.stop().catch(error => { failures.push(error.stack); process.exitCode = 1; });
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: failures.length === 0, checks, failures, requests, fingerprint: digest(await readFile(path.join(project, 'ui/global-search-ui.js'))), screenshots: browser?.screenshots || [] }, null, 2));
  console.log('REPORT ' + path.join(output, 'report.json'));
}
