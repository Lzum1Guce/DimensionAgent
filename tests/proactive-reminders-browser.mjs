import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startBrowser } from './native-browser-fixture.mjs';
import { until } from './archive-export-api.mjs';

const project = path.resolve(import.meta.dirname, '..');
const output = path.join(project, 'outputs/proactive-reminders', 'browser-' + Date.now());
await mkdir(path.join(output, 'temp'), { recursive: true });
const requests = [], failures = [], checks = [];
const pass = text => { checks.push(text); console.log('PASS ' + text); };
let browser, server;
const rules = [];
const capabilities = { defaultEnabled: false, readSources: ['scheduler'], automaticWork: false, automaticTools: false, automaticUserFileWrites: false, externalSending: false };
try {
  const html = `<!doctype html><meta charset="utf-8"><title>主动提醒合成测试</title>
    <style>:root{--color-composer-ring:#ddd;--color-raised:#fff;--color-ink:#222;--color-app:#f7f5f0;--color-ink-secondary:#555;--color-ink-tertiary:#777;--color-control:#eee;--color-raised-hover:#eee;--color-success:#176b45}body{font-family:system-ui}</style>
    <button id="sharedProactiveRemindersBtn">主动提醒</button>
    <script type="module">
      import {bindProactiveReminders} from '/dimension-ui/proactive-reminders-ui.js';
      const api=async(path,options={})=>{const response=await fetch(path,options);const data=await response.json();if(!response.ok)throw Error(data.error||('HTTP '+response.status));return data};
      window.reminderUi=bindProactiveReminders({api});window.ready=true;
    </script>`;
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let body = ''; for await (const chunk of req) body += chunk;
    const input = body ? JSON.parse(body) : {};
    requests.push({ method: req.method, path: url.pathname, body: input });
    const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/dimension-ui/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return; }
    if (url.pathname === '/dimension-ui/proactive-reminders-ui.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(await readFile(path.join(project, 'ui/proactive-reminders-ui.js'))); return; }
    if (url.pathname === '/api/native/proactive-reminders' && req.method === 'GET') return json({ capabilities, rules });
    if (url.pathname === '/api/native/proactive-reminders' && req.method === 'POST') {
      const rule = { ...input, id: `reminder-${rules.length + 1}`, revision: 1, enabled: false, status: 'paused', triggerCount: 0, skippedCount: 0,
        nextTriggerAt: 0, lastTriggeredAt: 0, createdAt: Date.now(), updatedAt: Date.now(), seenEventIds: [], latestDraft: null, lastReason: '已创建，默认禁用' };
      rules.push(rule); return json({ rule, rules }, 201);
    }
    const match = /^\/api\/native\/proactive-reminders\/([^/]+)(?:\/(pause|resume))?$/.exec(url.pathname);
    if (match) {
      const index = rules.findIndex(rule => rule.id === match[1]);
      if (index < 0) return json({ error: 'not found' }, 404);
      const rule = rules[index];
      if (input.revision !== rule.revision) return json({ error: 'revision conflict' }, 409);
      if (match[2]) {
        rule.enabled = match[2] === 'resume'; rule.status = rule.enabled ? 'active' : 'paused';
        rule.nextTriggerAt = rule.enabled && rule.kind === 'interval' ? Date.now() + rule.intervalMinutes * 60000 : 0;
        rule.revision++; rule.lastReason = rule.enabled ? '已启用' : '已暂停';
        return json({ rule, rules });
      }
      if (req.method === 'PUT') {
        const next = { ...rule, ...input, id: rule.id, revision: rule.revision + 1, enabled: rule.enabled, status: rule.status };
        rules[index] = next; return json({ rule: next, rules });
      }
      if (req.method === 'DELETE') { rules.splice(index, 1); return json({ ok: true, removed: rule.id }); }
    }
    json({ error: 'not found' }, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await startBrowser({ output, processes: [] }, 'http://127.0.0.1:' + server.address().port);
  await until(() => browser.evaluate('window.ready'), 'reminder component ready');
  await browser.click('#sharedProactiveRemindersBtn');
  await until(() => browser.evaluate('document.querySelector(".pr-empty")?.textContent.includes("还没有")'), 'empty rules rendered');
  assert(await browser.evaluate('document.querySelector(".pr-boundary").textContent.includes("不会创建 Work")'));
  await browser.click('[data-new]');
  assert.equal(await browser.evaluate('document.querySelector(".pr-form [name=endAt]").value.length > 0'), true);
  await browser.replace('.pr-form [name=name]', '每小时整理进度');
  await browser.replace('.pr-form [name=message]', '只提醒我整理，不要自动执行');
  await browser.click('.pr-form [type=submit]');
  await until(() => browser.evaluate('document.querySelector(".pr-card")?.textContent.includes("每小时整理进度")'), 'created disabled rule card');
  assert.equal(rules.length, 1); assert.equal(rules[0].enabled, false); assert.equal(rules[0].status, 'paused');
  assert(rules[0].endAt > 0 && rules[0].scope.source === 'scheduler');
  assert(await browser.evaluate('document.querySelector(".pr-card").textContent.includes("已创建，默认禁用")'));
  pass('Create form persists explicit scope, message, interval, budget and end time while remaining disabled');

  await browser.click('[data-action=edit]');
  await browser.replace('.pr-form [name=message]', '编辑后的提醒文案');
  await browser.replace('.pr-form [name=budget]', '2');
  await browser.click('.pr-form [type=submit]');
  await until(() => browser.evaluate('document.querySelector(".pr-card")?.textContent.includes("编辑后的提醒文案")'), 'edited rule rendered');
  assert.equal(rules[0].revision, 2); assert.equal(rules[0].budget, 2); assert.equal(rules[0].enabled, false);
  await browser.click('[data-action=resume]');
  await until(() => browser.evaluate('document.querySelector(".pr-pill")?.textContent === "已启用"'), 'rule resumed');
  assert(rules[0].nextTriggerAt > Date.now());
  await browser.click('[data-action=pause]');
  await until(() => browser.evaluate('document.querySelector(".pr-pill")?.textContent === "已暂停"'), 'rule paused');
  assert.equal(rules[0].nextTriggerAt, 0);
  pass('Edit, resume and pause use revisions and expose next trigger state without hidden activation');

  await browser.evaluate('window.confirm=()=>true');
  await browser.click('[data-action=delete]');
  await until(() => browser.evaluate('Boolean(document.querySelector(".pr-empty"))'), 'rule deleted');
  assert.equal(rules.length, 0);
  assert(requests.every(row => row.path.startsWith('/api/native/proactive-reminders') || row.path.startsWith('/dimension-ui/') || row.path === '/favicon.ico'));
  assert(!requests.some(row => /work|tool|sandbox|message/.test(row.path)));
  pass('Delete completes CRUD and UI makes no Work, tool, sandbox, message or external requests');
  assert.deepEqual(browser.exceptions, []); assert.deepEqual(browser.blockedExternal, []);
} catch (error) { failures.push(error.stack); console.error(error.stack); process.exitCode = 1; }
finally {
  if (browser) await browser.stop().catch(error => { failures.push(error.stack); process.exitCode = 1; });
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: failures.length === 0, checks, failures, requests }, null, 2));
  console.log('REPORT ' + path.join(output, 'report.json'));
}
