import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startBrowser } from './native-browser-fixture.mjs';
import { until, digest } from './archive-export-api.mjs';
const project = path.resolve(import.meta.dirname, '..'), output = path.join(project, 'outputs/attachment-library', 'browser-' + Date.now());
await mkdir(path.join(output, 'temp'), { recursive: true });
const failures = [], checks = [], requests = []; let browser, server;
const pass = text => { checks.push(text); console.log('PASS ' + text); };
try {
  const html = `<!doctype html><meta charset="utf-8"><title>附件资料库合成测试</title><style>:root{--color-composer-ring:#ddd;--color-raised:#fff;--color-ink:#222;--color-app:#f7f5f0;--color-ink-secondary:#555;--color-ink-tertiary:#777;--color-control:#eee;--color-raised-hover:#eee;--color-accent-text:#0868c8;--color-danger:#b42332}body{font-family:system-ui}</style>
    <button id="sharedAttachmentLibraryBtn">附件库</button><script type="module">import {bindAttachmentLibrary} from '/dimension-ui/attachment-library-ui.js';
    window.copies=[];window.opened=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>copies.push(text)}});window.addEventListener('dimension-global-search-open',event=>opened.push(event.detail));
    const api=async path=>{const response=await fetch(path);const data=await response.json();if(!response.ok)throw Error(data.error||response.status);return data};bindAttachmentLibrary({api});window.ready=true;</script>`;
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1'); requests.push({ method: req.method, path: url.pathname });
    if (url.pathname === '/dimension-ui/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return; }
    if (url.pathname === '/dimension-ui/attachment-library-ui.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(await readFile(path.join(project, 'ui/attachment-library-ui.js'))); return; }
    if (url.pathname === '/api/dimension/attachments') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ truncated: false, items: [
        { source: 'incoming', scope: 'Bot 项目 incoming', name: '<img src=x>.txt', path: 'F:/project/incoming/<img src=x>.txt', botId: 'bot-a', botName: 'Alpha', bytes: 12, available: true, url: '/api/dimension/attachments/incoming?botId=bot-a&path=file.txt' },
        { source: 'work-artifact', scope: '任务成果', name: 'result.txt', path: 'F:/task/result.txt', botId: 'bot-a', botName: 'Alpha', groupId: 'group-a', groupName: 'Team', runId: 'run-a', task: 'synthetic task', bytes: 20, available: true, url: '/api/dimension/work/tasks/run-a/files/result.txt' },
      ] })); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await startBrowser({ output, processes: [] }, 'http://127.0.0.1:' + server.address().port);
  await until(() => browser.evaluate('window.ready'), 'attachment library ready');
  await browser.click('#sharedAttachmentLibraryBtn'); await until(() => browser.evaluate('document.querySelectorAll(".attachment-library-item").length===2'), 'two attachment sources');
  assert.equal(await browser.evaluate('document.querySelectorAll(".attachment-library-item img").length'), 0);
  assert.equal(await browser.evaluate('document.querySelector(".attachment-library-item .attachment-library-actions a[download]").href.includes("download=1")'), true);
  await browser.evaluate('document.querySelector(".attachment-library-toolbar select").value="incoming";document.querySelector(".attachment-library-toolbar select").dispatchEvent(new Event("change"))');
  assert.equal(await browser.evaluate('document.querySelectorAll(".attachment-library-item").length'), 1);
  await browser.click('.attachment-library-item [type="button"]'); assert.deepEqual(await browser.evaluate('copies'), ['F:/project/incoming/<img src=x>.txt']);
  await browser.screenshot('attachment-library-incoming');
  await browser.evaluate('document.querySelector(".attachment-library-toolbar select").value="work-artifact";document.querySelector(".attachment-library-toolbar select").dispatchEvent(new Event("change"))');
  await browser.click('.attachment-library-item .attachment-library-actions button:last-child');
  assert.deepEqual(await browser.evaluate('opened'), [{ kind: 'work', runId: 'run-a', botId: 'bot-a', groupId: 'group-a' }]);
  assert.equal(await browser.evaluate('document.querySelector(".attachment-library-dialog").open'), false);
  assert(requests.every(row => row.method === 'GET'));
  assert.deepEqual(browser.exceptions, []); assert.deepEqual(browser.blockedExternal, []);
  pass('Attachment sources, filters, copy path, download URL and exact task identity remain scoped and DOM-safe');
} catch (error) { failures.push(error.stack); console.error(error.stack); process.exitCode = 1; }
finally {
  if (browser) await browser.stop().catch(error => { failures.push(error.stack); process.exitCode = 1; });
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: failures.length === 0, checks, failures, requests, fingerprint: digest(await readFile(path.join(project, 'ui/attachment-library-ui.js'))), screenshots: browser?.screenshots || [] }, null, 2));
  console.log('REPORT ' + path.join(output, 'report.json'));
}
