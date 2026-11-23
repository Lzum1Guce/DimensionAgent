import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startBrowser } from './native-browser-fixture.mjs';
import { until, digest } from './archive-export-api.mjs';

const project = path.resolve(import.meta.dirname, '..'), output = path.join(project, 'outputs/work-partial-panel', 'browser-' + Date.now());
await mkdir(path.join(output, 'temp'), { recursive: true });
const failures = [], checks = [], streams = new Map();
let browser, server;
const names = { coordinator: '群主', success: '成功成员', failure: '失败成员', waiting: '受阻成员' };
const event = (id, seq, kind, text, extra = {}) => ({ seq, kind, text, runId: id, from: id, sourceRef: { runId: id, eventSeq: String(seq) }, ...extra });
const record = (id, botId, text, parentRunId, status, order) => ({
  id, botId, text, parentRunId, groupId: 'fixture-group', status, order, createdAt: `2026-11-16T12:00:0${order}Z`, detailsLoaded: true, lastSeq: 2,
  sourceRef: { runId: id, eventSeq: '1' }, events: [event(id, 1, 'result', text, { taskId: id, status }), event(id, 2, 'run-state', '', { status })], assignments: [],
});
const root = record('root-partial', 'coordinator', '整理资料并交付已验证成果', '', 'partial', 1);
root.answer = '部分交付：1/3 项完成，其余失败或受阻';
root.events = [event(root.id, 1, 'result', root.answer, { taskId: root.id, status: 'partial' }), event(root.id, 2, 'run-state', '', { status: 'partial' })];
const success = record('success-task', 'success', '整理可用资料', root.id, 'completed', 2);
const failure = record('failure-task', 'failure', '核验缺失资料', root.id, 'failed', 3);
failure.error = '模型请求失败，未生成核验成果';
failure.events[0].text = failure.error;
root.assignments = [
  { key: success.id, runId: success.id, jobId: 'job_ok', botId: success.botId, job: success.text, status: success.status, dependsOn: [] },
  { key: failure.id, runId: failure.id, jobId: 'job_fail', botId: failure.botId, job: failure.text, status: failure.status, dependsOn: [] },
  { key: 'job_blocked', runId: '', jobId: 'job_blocked', botId: 'waiting', job: '等待失败后继续核验', status: 'blocked', detail: '前置任务未完成', dependsOn: ['job_fail'] },
];
const rows = [failure, success, root];
const files = [{ name: 'verified.txt', path: 'synthetic/verified.txt', bytes: 16, available: true, extension: '.txt', url: '/fixture-files/verified.txt' }];
const pass = text => { checks.push(text); console.log('PASS ' + text); };
try {
  const html = `<!doctype html><meta charset="utf-8"><title>部分交付面板合成测试</title>
    <link rel="stylesheet" href="/dimension-ui/styles.css"><link rel="stylesheet" href="/dimension-ui/work-task-panel.css"><link rel="stylesheet" href="/dimension-ui/message-actions.css">
    <style>body{margin:0;background:#faf9f6;color:#45443e}main{max-width:900px;margin:20px auto}#fixtureTranscript{min-height:700px;padding:8px}</style>
    <main><div id="fixtureTranscript"></div><textarea id="composerInput"></textarea></main>
    <script type="module">
      import {createWorkSessionUi} from '/dimension-ui/work-session-ui.js?v=partial-panel1';
      const names=${JSON.stringify(names)};
      window.ui=createWorkSessionUi({api:async(url,options={})=>{const r=await fetch(url,options);if(!r.ok)throw Error('fixture '+r.status);return r.json()},getTranscript:()=>document.querySelector('#fixtureTranscript'),nameOf:id=>names[id]||id,onBusy:()=>{},onQuote:()=>{}});
      ui.setHandoffAvailable(true);await ui.open({botId:'coordinator',groupId:'fixture-group'});window.ready=true;
    </script>`;
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/dimension-ui/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return; }
    if (/^\/dimension-ui\/[a-zA-Z0-9.-]+\.(js|css)$/.test(url.pathname)) {
      const file = path.join(project, 'ui', path.basename(url.pathname));
      res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/css' }); res.end(await readFile(file)); return;
    }
    if (url.pathname === '/api/dimension/work/sessions') return json({ runs: rows, hasMore: false, paused: false });
    const stream = /^\/api\/dimension\/work\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': fixture\n\n'); streams.set(stream[1], res); req.on('close', () => streams.delete(stream[1])); return; }
    const artifacts = /^\/api\/dimension\/work\/tasks\/([^/]+)\/artifacts$/.exec(url.pathname);
    if (artifacts) return json({ files: artifacts[1] === success.id ? files : [] });
    if (url.pathname === '/fixture-files/verified.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('verified synthetic artifact'); return; }
    const run = /^\/api\/dimension\/work\/runs\/([^/]+)$/.exec(url.pathname);
    if (run) return json(rows.find(row => row.id === run[1]));
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await startBrowser({ output, processes: [] }, 'http://127.0.0.1:' + server.address().port);
  const { evaluate, click } = browser;
  await until(() => evaluate('window.ready'), 'partial panel ready');
  assert.equal(await evaluate('document.querySelectorAll("#fixtureTranscript > .work-task-space-inline").length'), 1);
  assert.equal(await evaluate('document.querySelector(".work-task-space-detail > [data-run-id=root-partial]").dataset.status'), 'partial');
  assert((await evaluate('document.querySelector(".work-task-space-detail > [data-run-id=root-partial] > .work-run-head .work-run-state").textContent')).includes('部分交付'));
  assert((await evaluate('document.querySelector(".work-task-space-detail .work-owner-talk-body").textContent')).includes('部分交付：1/3 项完成'));
  assert.equal(await evaluate('document.querySelector(".work-task-space-bot[data-run-id=success-task]").dataset.status'), 'completed');
  assert.equal(await evaluate('document.querySelector(".work-task-space-bot[data-run-id=failure-task]").dataset.status'), 'failed');
  assert.equal(await evaluate(`document.querySelector('.work-task-space-bot[data-entry-id="root-partial:job_blocked"]').dataset.status`), 'blocked');
  assert((await evaluate(`document.querySelector('.work-task-space-bot[data-entry-id="root-partial:job_blocked"] .work-task-space-bot-state').textContent`)).includes('前置任务未完成'));
  assert.equal(await evaluate('document.querySelectorAll("[data-run-id=job_blocked]").length'), 0);
  await click('.work-task-space-bot[data-run-id=success-task]');
  await until(() => evaluate('document.querySelector(".work-task-space-detail .work-talk-file")?.textContent.includes("verified.txt")'), 'successful member file in conversation');
  const artifactLink = await evaluate('document.querySelector(".work-task-space-detail > [data-run-id=success-task] .work-artifacts a[download]").getAttribute("href")');
  assert.equal(artifactLink, '/fixture-files/verified.txt?download=1');
  assert.equal(await evaluate('document.querySelector(".work-task-space-detail > [data-run-id=success-task] .work-artifacts a[download]").download'), 'verified.txt');
  await click('.work-task-space-bot[data-run-id=root-partial]');
  await browser.screenshot('partial-delivery-panel');
  assert.deepEqual(browser.exceptions, []); assert.deepEqual(browser.blockedExternal, []);
  pass('Partial parent, successful artifact, failed member and blocked dependency render distinct truthful states without a fourth task or a complete-delivery claim');
} catch (error) { failures.push(error.stack); console.error(error.stack); process.exitCode = 1; }
finally {
  if (browser) await browser.stop().catch(error => { failures.push(error.stack); process.exitCode = 1; });
  for (const stream of streams.values()) stream.end();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: failures.length === 0, checks, failures,
    fingerprint: digest(await readFile(path.join(project, 'ui/work-session-ui.js'))), screenshots: browser?.screenshots || [] }, null, 2));
  console.log('REPORT ' + path.join(output, 'report.json'));
}
