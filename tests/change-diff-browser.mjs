import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startBrowser } from './native-browser-fixture.mjs';
import { until, digest } from './archive-export-api.mjs';
const project = path.resolve(import.meta.dirname, '..'), output = path.join(project, 'outputs/change-diff', 'browser-' + Date.now());
await mkdir(path.join(output, 'temp'), { recursive: true });
const failures = [], checks = []; let browser, server;
const pass = text => { checks.push(text); console.log('PASS ' + text); };
try {
  const html = `<!doctype html><meta charset="utf-8"><title>变更对比合成测试</title><style>:root{--color-composer-ring:#ddd;--color-raised:#fff;--color-ink:#222;--color-app:#f7f5f0;--color-ink-secondary:#555;--color-success:#176b45;--color-danger:#b42332}body{font-family:system-ui}</style>
    <div id="workCwdBar"></div><div id="approvalHost"></div><form id="composer"></form><button id="workAttachBtn"></button><input id="workAttachInput"><button id="workCwdPick"></button><span id="workCwdPath"></span><div id="fixture"></div>
    <script type="module">import {createChangeDiff} from '/dimension-ui/change-diff-ui.js';import {bindWorkShellUi} from '/dimension-ui/group-work-ui.js';
    window.createChangeDiff=createChangeDiff;window.decisions=[];window.diff=createChangeDiff('a\\nb\\nc','a\\nB\\nc\\nd');document.querySelector('#fixture').append(diff);
    window.work=bindWorkShellUi({isWork:()=>true,getSettings:()=>({projectCwd:'/synthetic'}),onDecide:(...args)=>decisions.push(args)});window.ready=true;</script>`;
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/dimension-ui/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return; }
    if (/^\/dimension-ui\/[a-z-]+\.js$/.test(url.pathname)) {
      const file = path.join(project, 'ui', path.basename(url.pathname)); res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(await readFile(file)); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await startBrowser({ output, processes: [] }, 'http://127.0.0.1:' + server.address().port);
  await until(() => browser.evaluate('window.ready'), 'diff component ready');
  assert.equal(await browser.evaluate('document.querySelectorAll("#fixture .change-diff-row[data-kind=add]").length'), 2);
  assert.equal(await browser.evaluate('document.querySelectorAll("#fixture .change-diff-row[data-kind=del]").length'), 1);
  assert((await browser.evaluate('document.querySelector("#fixture .change-diff-summary").textContent')).includes('+2 行'));
  assert.equal(await browser.evaluate(`(() => {const d=diff;while(d.firstChild)d.firstChild.remove();d.append(createChangeDiff('same','same'));return d.textContent})()`), '两段内容没有文本差异。');
  await browser.evaluate(`work.renderPending([{id:'approval-1',botId:'bot-1',action:{risk:'write',tool:'edit',path:'synthetic.txt',oldText:'a\\nb',newText:'a\\nB'}}])`);
  assert.equal(await browser.evaluate('document.querySelectorAll("#approvalHost .approval-card").length'), 1);
  assert((await browser.evaluate('document.querySelector("#approvalHost .change-diff-summary").textContent')).includes('+1 行'));
  assert((await browser.evaluate('document.querySelector("#approvalHost .change-diff-host > summary").textContent')).includes('变更对比'));
  await browser.click('#approvalHost .change-diff-host > summary'); await browser.screenshot('approval-change-diff');
  await browser.click('#approvalHost [data-allow="1"]');
  assert.deepEqual(await browser.evaluate('decisions'), [['approval-1', true, 'bot-1']]);
  pass('Line diff reports additions/deletions and identical text while approval keeps exact ID, decision and Bot identity');

  const safe = await browser.evaluate(`(() => {const d=createChangeDiff('<img src=x>','<b>safe</b>');document.querySelector('#fixture').append(d);return {images:d.querySelectorAll('img').length,text:d.textContent}})()`);
  assert.equal(safe.images, 0); assert(safe.text.includes('<img src=x>') && safe.text.includes('<b>safe</b>'));
  const fallback = await browser.evaluate(`(() => {const d=createChangeDiff(Array.from({length:260},(_,i)=>'old'+i).join('\\n'),'new');return d.querySelector('.change-diff-summary').textContent})()`);
  assert(fallback.includes('内容较大'));
  assert.deepEqual(browser.exceptions, []); assert.deepEqual(browser.blockedExternal, []);
  pass('Diff text remains DOM-safe and oversized content uses explicit bounded fallback');
} catch (error) { failures.push(error.stack); console.error(error.stack); process.exitCode = 1; }
finally {
  if (browser) await browser.stop().catch(error => { failures.push(error.stack); process.exitCode = 1; });
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: failures.length === 0, checks, failures, fingerprint: digest(await readFile(path.join(project, 'ui/change-diff-ui.js'))), screenshots: browser?.screenshots || [] }, null, 2));
  console.log('REPORT ' + path.join(output, 'report.json'));
}
