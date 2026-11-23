import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startBrowser } from './native-browser-fixture.mjs';
import { until, digest } from './archive-export-api.mjs';

const project = path.resolve(import.meta.dirname, '..'), output = path.join(project, 'outputs/brain-space', 'browser-' + Date.now());
await mkdir(path.join(output, 'temp'), { recursive: true });
const failures = [], checks = [], requests = [];
let browser, server;
const round = { id: 'job-combined-synthetic', sourceMessageId: '42', status: 'completed', summary: 'Synthetic combined <b>summary</b>', openQuestions: ['Confirm the assumption'], modelCalls: 1, completedAtMs: '1700000000000' };
const modules = [
  { id: 'observations', name: '感知', region: '事实与未知', duty: '区分事实与缺失资料', thinkWithModel: true, analysisStatus: 'completed', calledModel: true, findings: [{ kind: 'fact', summary: 'Observed private reply', source: { kind: 'combined-space-round', jobId: round.id, messageId: '42' } }], trace: [] },
  { id: 'planning', name: '筹划', region: '下一步', duty: '提出下一步', thinkWithModel: false, analysisStatus: 'cached', calledModel: false, findings: [], trace: [] },
  ...Array.from({ length: 11 }, (_, index) => ({ id: 'module-' + index, name: '模块' + index, region: '职责', duty: '只读职责', thinkWithModel: false, analysisStatus: 'disabled', calledModel: false, findings: [], trace: [] })),
];
const space = { version: 2, botId: 'alpha', pipeline: 'combined', maxAuxiliaryModelCalls: 1, storage: 'brain-space.json', latestRound: round, latestJob: null, minibots: modules };
const pass = text => { checks.push(text); console.log('PASS ' + text); };
try {
  const html = `<!doctype html><meta charset="utf-8"><title>独立空间合成测试</title><div id="modal" hidden></div><script type="module">
    import {showIndependentSpace} from '/dimension-ui/conversation-services-ui.js';
    window.showModal = html => { const root = document.getElementById('modal'); root.innerHTML = html; root.hidden = false; };
    window.api = async (path, options = {}) => { const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json' } }); const data = await response.json(); if (!response.ok) throw Error(data.error || response.status); return data; };
    window.ready = showIndependentSpace({ api: window.api, showModal: window.showModal, escapeHtml: value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'), botId: 'alpha', botName: 'Synthetic Bot', isCurrent: () => true }).then(() => true);
  </script>`;
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/dimension-ui/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return; }
    if (url.pathname === '/dimension-ui/conversation-services-ui.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(await readFile(path.join(project, 'ui/conversation-services-ui.js'))); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path: url.pathname, query: url.search, body: body ? JSON.parse(body) : null });
    const json = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/dimension/space') return json(space);
    if (url.pathname === '/api/dimension/space/analyze') return json({ id: round.id, botId: 'alpha', status: 'completed', terminal: true, calledModel: true, modelCalls: 1 });
    if (url.pathname === '/api/dimension/skill-library') return json({ library: {}, skills: {} });
    if (url.pathname === '/api/dimension/minibots/observations/chat' || url.pathname === '/api/dimension/minibots/planning/chat') return json({ turns: [], hasMore: false });
    if (url.pathname === '/api/dimension/minibots/planning/think') return json({ thinkWithModel: true });
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await startBrowser({ output, processes: [] }, 'http://127.0.0.1:' + server.address().port);
  await until(() => browser.evaluate('window.ready'), 'independent space rendered');
  assert((await browser.evaluate('document.querySelector(".space-round-card").textContent')).includes('Synthetic combined'));
  assert.equal(await browser.evaluate('document.querySelector(".space-round-card b")'), null);
  assert((await browser.evaluate('document.querySelector(".space-main").textContent')).includes('本轮确实调用模型'));
  assert((await browser.evaluate('document.querySelector(".space-main").textContent')).includes('感知'));
  assert((await browser.evaluate('document.querySelector(".space-round-card").textContent')).includes('思考轮次'));
  assert((await browser.evaluate('document.querySelector(".space-round-card").textContent')).includes('经验候选'));
  assert.equal(requests.filter(row => row.path === '/api/dimension/space/analyze').length, 0);
  await browser.click('[data-mini="planning"]');
  assert.equal(requests.filter(row => row.path === '/api/dimension/space/analyze').length, 0);
  await browser.click('#miniAnalyze'); await until(() => requests.filter(row => row.path === '/api/dimension/space/analyze').length === 1, 'manual combined analysis');
  assert.equal(requests.find(row => row.path === '/api/dimension/space/analyze').body.botId, 'alpha');
  await browser.click('#spaceLearn'); await until(() => requests.some(row => row.path === '/api/dimension/skill-library'), 'learning candidate submitted');
  const learning = requests.find(row => row.path === '/api/dimension/skill-library').body;
  assert.equal(learning.action, 'create'); assert.equal(learning.origin.includes(round.id), true);
  assert(learning.body.includes('需用原对话和实际案例人工验证'));
  assert(!('enabled' in learning) && !('activate' in learning));
  await browser.screenshot('brain-space-combined');
  assert.deepEqual(browser.exceptions, []); assert.deepEqual(browser.blockedExternal, []);
  pass('Space panel is read-only on open/switch, shows actual model provenance and submits only an unenabled learning candidate');
} catch (error) { failures.push(error.stack); console.error(error.stack); process.exitCode = 1; }
finally {
  if (browser) await browser.stop().catch(error => { failures.push(error.stack); process.exitCode = 1; });
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: failures.length === 0, checks, failures, requests, fingerprint: digest(await readFile(path.join(project, 'ui/conversation-services-ui.js'))), screenshots: browser?.screenshots || [] }, null, 2));
  console.log('REPORT ' + path.join(output, 'report.json'));
}
