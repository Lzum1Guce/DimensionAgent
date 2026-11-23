import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startBrowser } from './native-browser-fixture.mjs';
import { until, digest } from './archive-export-api.mjs';

const project = path.resolve(import.meta.dirname, '..');
const output = path.join(project, 'outputs/work-stream', 'browser-' + Date.now());
await mkdir(path.join(output, 'temp'), { recursive: true });
const failures = [], checks = [], streams = new Map();
let browser, server;
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
      const file = path.join(project, 'ui', path.basename(url.pathname));
      res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/css' }); res.end(await readFile(file)); return;
    }
    if (url.pathname === '/api/dimension/work/sessions') return json({ runs: [run], hasMore: false, paused: false });
    const stream = /^\/api\/dimension\/work\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': fixture\n\n'); streams.set(stream[1], res); req.on('close', () => streams.delete(stream[1])); return; }
    if (url.pathname === '/api/dimension/work/tasks/solo-run/artifacts') return json({ files: [] });
    if (url.pathname === '/api/dimension/work/runs/solo-run') return json(run);
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await startBrowser({ output, processes: [] }, 'http://127.0.0.1:' + server.address().port);
  const { evaluate } = browser;
  await until(() => evaluate('window.ready'), 'single Bot stream ready');
  assert.equal(await evaluate('document.querySelectorAll(".claude-assistant-turn").length'), 2);
  assert.equal(await evaluate('document.querySelectorAll(".claude-tool-pill").length'), 1);
  assert.equal(await evaluate('document.querySelector(".claude-tool-pill").dataset.status'), 'completed');
  assert((await evaluate('document.querySelector(".claude-tool-summary").textContent')).includes('运行命令'));
  assert((await evaluate('document.querySelector(".claude-tool-summary").textContent')).includes('npm test'));
  assert.equal(await evaluate('document.querySelector(".claude-assistant-author").textContent'), '中野三玖');
  const ticker = await evaluate('document.querySelector(".claude-trace-summary").textContent');
  assert(!ticker.includes('RAW_CHAIN_OF_THROUGH_NOT_FOR_TICKER'));
  const texts = await evaluate('Array.from(document.querySelectorAll(".claude-assistant-body")).map(node => node.textContent)');
  assert.deepEqual(texts, ['我先检查项目结构。', answer]);
  assert.deepEqual(browser.exceptions, []);
  assert.deepEqual(browser.blockedExternal, []);
  pass('Single Bot prose streams once, tool cards interleave visibly, raw reasoning stays out of the live ticker, and final text is not duplicated');
} catch (error) { failures.push(error.stack); console.error(error.stack); process.exitCode = 1; }
finally {
  if (browser) await browser.stop().catch(error => { failures.push(error.stack); process.exitCode = 1; });
  for (const stream of streams.values()) stream.end();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: failures.length === 0, checks, failures,
    fingerprint: digest(await readFile(path.join(project, 'ui/work-session-ui.js'))) }, null, 2));
  console.log('REPORT ' + path.join(output, 'report.json'));
}
