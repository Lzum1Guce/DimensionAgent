import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startBrowser } from './native-browser-fixture.mjs';
import { until, digest } from './archive-export-api.mjs';
const project = path.resolve(import.meta.dirname, '..'), output = path.join(project, 'outputs/skill-learning', 'browser-' + Date.now());
await mkdir(path.join(output, 'temp'), { recursive: true });
const failures = [], checks = [], calls = []; let browser, server;
const library = { 'synthetic-skill': { activeRevision: 0, versions: [{ revision: 1, title: 'Synthetic <b>skill</b>', keywords: ['synthetic'], origin: 'synthetic task', body: 'SYNTH_BODY', validation: 'verified', evidence: 'synthetic case passed' }] } };
const pass = text => { checks.push(text); console.log('PASS ' + text); };
try {
  const html = `<!doctype html><meta charset="utf-8"><title>学习候选合成测试</title><style>:root{--color-composer-ring:#ddd;--color-raised:#fff;--color-ink:#222;--color-app:#f7f5f0;--color-ink-secondary:#555;--color-ink-tertiary:#777;--color-control:#eee;--color-accent:#1084fe;--color-accent-ink:#fff}body{font-family:system-ui}</style><button id="sharedSkillLearningBtn">学习候选</button>
    <script type="module">import {bindSkillLearning} from '/dimension-ui/skill-learning-ui.js';const api=async(path,options={})=>{const response=await fetch(path,{...options,headers:{'content-type':'application/json'}});const data=await response.json();if(!response.ok)throw Error(data.error||response.status);return data};bindSkillLearning({api});window.ready=true;</script>`;
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/dimension-ui/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return; }
    if (url.pathname === '/dimension-ui/skill-learning-ui.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(await readFile(path.join(project, 'ui/skill-learning-ui.js'))); return; }
    if (url.pathname === '/api/dimension/skill-library') {
      if (req.method === 'POST') { let text = ''; for await (const chunk of req) text += chunk; calls.push(JSON.parse(text)); }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ library, skills: {} })); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await startBrowser({ output, processes: [] }, 'http://127.0.0.1:' + server.address().port);
  await until(() => browser.evaluate('window.ready'), 'skill learning ready');
  await browser.click('#sharedSkillLearningBtn'); await until(() => browser.evaluate('document.querySelectorAll(".skill-learning-version").length===1'), 'candidate rendered');
  assert.equal(await browser.evaluate('document.querySelectorAll(".skill-learning-version b").length'), 0);
  assert((await browser.evaluate('document.querySelector(".skill-learning-dialog").textContent')).includes('候选默认对模型不可见'));
  await browser.click('.skill-learning-actions button:last-child');
  await until(() => calls.length === 1, 'activation submitted'); assert.deepEqual(calls[0], { action: 'activate', topic: 'synthetic-skill', revision: '1' });
  await browser.replace('[name=topic]', 'new-skill'); await browser.replace('[name=title]', 'New skill'); await browser.replace('[name=keywords]', 'test, reusable'); await browser.replace('[name=origin]', 'synthetic retrospective'); await browser.replace('[name=body]', 'bounded reusable steps');
  await browser.click('.skill-learning-create [type=submit]'); await until(() => calls.length === 2, 'candidate submitted');
  assert.equal(calls[1].action, 'create'); assert.deepEqual(calls[1].keywords, ['test', 'reusable']); assert.equal(calls[1].body, 'bounded reusable steps');
  await browser.screenshot('skill-learning-candidates');
  assert.deepEqual(browser.exceptions, []); assert.deepEqual(browser.blockedExternal, []);
  pass('Learning UI preserves candidate invisibility notice, exact activation identity, source evidence and structured create payload');
} catch (error) { failures.push(error.stack); console.error(error.stack); process.exitCode = 1; }
finally {
  if (browser) await browser.stop().catch(error => { failures.push(error.stack); process.exitCode = 1; });
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: failures.length === 0, checks, failures, calls, fingerprint: digest(await readFile(path.join(project, 'ui/skill-learning-ui.js'))), screenshots: browser?.screenshots || [] }, null, 2));
  console.log('REPORT ' + path.join(output, 'report.json'));
}
