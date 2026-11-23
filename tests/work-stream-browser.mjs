import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startBrowser } from './native-browser-fixture.mjs';
import { until, digest } from './archive-export-api.mjs';

const project = path.resolve(import.meta.dirname, '..');
const uiDir = process.argv[3] || path.join(project, 'ui');
const output = path.join(process.argv[2] || path.join(project, 'outputs/work-stream'), 'browser-' + Date.now());
await mkdir(path.join(output, 'temp'), { recursive: true });
const failures = [], checks = [], streams = new Map();
let browser, server, confirmation;
const event = (seq, kind, text, extra = {}) => ({ seq, kind, text, runId: 'solo-run', from: 'miku', ...extra });
const answer = '测试已经通过，我把结果整理好了。';
const run = {
  id: 'solo-run', botId: 'miku', groupId: '', text: '检查项目并运行测试', status: 'completed',
  answer, detailsLoaded: true, lastSeq: 20, order: 0,
  sourceRef: { runId: 'solo-run', eventSeq: '1' },
  events: [
    event(1, 'think', 'RAW_CHAIN_OF_THROUGH_NOT_FOR_TICKER'),
    event(2, 'commentary', '我先检查'),
    event(3, 'commentary', '项目结构。'),
    // The durable backend commits model_reply before starting that reply's tools.
    event(4, 'plan', '我先检查项目结构。'),
    event(5, 'tool', '', { tool: { name: 'run_command', callId: 'call-test', args: '{"command":"npm test"}', status: 'running' } }),
    event(6, 'tool', '', { tool: { name: 'run_command', callId: 'call-test', args: '{"command":"npm test"}', status: 'completed', result: '18 passed' } }),
    event(7, 'think', 'SECOND_RAW_CHAIN'),
    event(8, 'commentary', answer),
    event(9, 'answer', answer),
    event(10, 'run-state', '', { status: 'completed' }),
  ],
};
const pass = text => { checks.push(text); console.log('PASS ' + text); };
try {
  const html = `<!doctype html><meta charset="utf-8"><title>单 Bot Work 流式时间线测试</title>
    <link rel="stylesheet" href="/dimension-ui/styles.css"><link rel="stylesheet" href="/dimension-ui/design-polish.css"><link rel="stylesheet" href="/dimension-ui/work-task-panel.css">
    <main><div id="fixtureTranscript"></div><textarea id="composerInput"></textarea></main>
    <script type="module">
      import {createWorkSessionUi} from '/dimension-ui/work-session-ui.js';
      window.ui=createWorkSessionUi({api:async(url,options={})=>{const r=await fetch(url,options);if(!r.ok)throw Error('fixture '+r.status);return r.json()},getTranscript:()=>document.querySelector('#fixtureTranscript'),nameOf:()=> '中野三玖',onBusy:()=>{},onQuote:()=>{}});
      await ui.open({botId:'miku',groupId:''});window.ready=true;
    </script>`;
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/dimension-ui/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return; }
    if (/^\/dimension-ui\/[a-zA-Z0-9.-]+\.(js|css)$/.test(url.pathname)) {
      const file = path.join(uiDir, path.basename(url.pathname));
      res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/css' }); res.end(await readFile(file)); return;
    }
    if (url.pathname === '/api/dimension/work/runs/solo-run/resume') {
      let body = '';
      for await (const chunk of req) body += chunk;
      confirmation = JSON.parse(body);
      run.planPhase = 'approved';
      run.attempt++;
      return json({run});
    }
    if (url.pathname === '/api/dimension/work/sessions') return json({ runs: [run], hasMore: false, paused: false });
    const stream = /^\/api\/dimension\/work\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': fixture\n\n'); streams.set(stream[1], res); req.on('close', () => streams.delete(stream[1])); return; }
    if (url.pathname === '/api/dimension/work/tasks/solo-run/artifacts') return json({ files: run.groupId ? ['a.txt','b.txt'].map(name=>({name,path:name,url:'/files/'+name,bytes:16,available:true})) : [] });
    if (url.pathname === '/api/dimension/work/runs/solo-run') return json(run);
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await startBrowser({ output, processes: [] }, 'http://127.0.0.1:' + server.address().port);
  const { evaluate } = browser;
  await until(() => evaluate('window.ready'), 'single Bot stream ready');
  assert.equal(await evaluate('document.querySelectorAll(".claude-assistant-turn").length'), 1);
  assert.equal(await evaluate('document.querySelectorAll(".wrs-step.is-command").length'), 1);
  assert.equal(await evaluate('document.querySelector(".wrs-step.is-command").dataset.status'), 'completed');
  assert((await evaluate('document.querySelector(".wrs-step.is-command summary").textContent')).includes('运行命令'));
  assert((await evaluate('document.querySelector(".wrs-step.is-command summary").textContent')).includes('npm test'));
  assert.equal(await evaluate('document.querySelector(".claude-assistant-author").textContent'), '中野三玖');
  const ticker = await evaluate('document.querySelector(".wrs-work-header").textContent');
  assert(!ticker.includes('RAW_CHAIN_OF_THROUGH_NOT_FOR_TICKER'));
  const texts = await evaluate('Array.from(document.querySelectorAll(".wrs-commentary, .claude-assistant-body")).map(node => node.textContent)');
  assert.deepEqual(texts, ['我先检查项目结构。', answer]);
  await evaluate('ui.close()');
  run.groupId = 'fixture-group';
  run.status = 'cancelled';
  run.events = [event(1, 'commentary', '我先看看'), event(2, 'commentary', '工作区。'),
    event(3, 'plan', '我先看看工作区。'), event(4, 'commentary', '接下来'), event(5, 'commentary', '确认版本。'),
    event(6, 'plan', '接下来确认版本。'), event(7, 'result', '', {status:'cancelled'}),
    event(8, 'run-state', '', {status:'cancelled'})];
  run.answer = '';
  await evaluate("ui.open({botId:'miku',groupId:'fixture-group'})");
  const replay = await evaluate('Array.from(document.querySelectorAll(".grok-lead-bubble .claude-assistant-body"), node=>node.textContent)');
  assert.deepEqual(replay, ['我先看看工作区。', '接下来确认版本。']);
  assert.equal(await evaluate('document.querySelectorAll(".grok-lead-bubble.is-streaming").length'),0);
  await until(() => evaluate('document.querySelector(".deliverable-meta")?.textContent.includes("已取消 · 任务文件包 · 共 2 个文件")'), 'cancelled package label');
  pass('Cancelled group replay renders each streamed reply once and clears cursors');
  run.status = 'completed'; run.planPhase = 'ready'; run.attempt = 3;
  run.answer = '计划先核对版本。\n\n预计模型分配\n• 拟定方案：群主 · fixture / lead\n• 执行：成员 · fixture / worker\n\n是否按此计划开始执行？';
  run.events.push(event(21,'answer',run.answer));run.lastSeq=21;
  await evaluate('ui.refresh()');
  assert((await evaluate('document.querySelector(".claude-timeline").innerText')).includes('fixture / worker'));
  await browser.click('[data-action="approve-work-plan"]');
  await until(()=>Boolean(confirmation),'confirmation request');
  assert.deepEqual(confirmation,{text:'按此计划开始',planAttempt:'3',requestId:'approve-plan:solo-run:3'});
  await until(()=>evaluate(`!document.querySelector('[data-action="approve-work-plan"]')`),'confirmation consumed');
  pass('Plan button submits its run and version and disappears after acceptance');
  assert.deepEqual(browser.exceptions, []);
  assert.deepEqual(browser.blockedExternal, []);
  pass('Single Bot prose streams once, tool cards interleave visibly, raw reasoning stays out of the live ticker, and final text is not duplicated');
} catch (error) { failures.push(error.stack); console.error(error.stack); process.exitCode = 1; }
finally {
  if (browser) await browser.stop().catch(error => { failures.push(error.stack); process.exitCode = 1; });
  for (const stream of streams.values()) stream.end();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: failures.length === 0, checks, failures,
    fingerprint: digest(await readFile(path.join(uiDir, 'work-session-ui.js'))) }, null, 2));
  console.log('REPORT ' + path.join(output, 'report.json'));
}
