// Headless browser coverage for the public notification inbox entry.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startBrowser } from './native-browser-fixture.mjs';
import { until, digest } from './archive-export-api.mjs';

const project = path.resolve(import.meta.dirname, '..');
const output = path.join(project, 'outputs/notification-inbox', 'browser-' + Date.now() + '-' + process.pid);
await mkdir(path.join(output, 'temp'), { recursive: true });
const requests = [], failures = [], checks = [];
let browser, server;
const pass = text => { checks.push(text); console.log('PASS ' + text); };
let rows = [
  { id: 'run-1:8:completed', kind: 'completed', title: '任务完成', botId: 'bot-1', botName: '通知 Bot', groupId: '', runId: 'run-1', summary: '完成任务 <img src=x onerror=alert(1)>', detail: '任务已完成，可查看结果', time: '2026-11-16T08:00:00.000Z', read: false, waiting: false, resolvedAt: '' },
  { id: 'run-2:5:resource', kind: 'resource', title: '等待资源', botId: 'bot-2', botName: '资源 Bot', groupId: '', runId: 'run-2', summary: '等待共享应用', detail: '应用资源正被其他任务占用', time: '2026-11-16T08:01:00.000Z', read: false, waiting: false, resolvedAt: '2026-11-16T08:02:00.000Z' },
  { id: 'run-3:4:takeover', kind: 'takeover', title: '需要接管', botId: 'bot-3', botName: '审批 Bot', groupId: '', runId: 'run-3', summary: '有操作等待你的批准', detail: '有操作等待你的批准', time: '2026-11-16T08:03:00.000Z', read: true, waiting: true, resolvedAt: '' },
];
const unread = () => rows.filter(row => !row.read).length;
try {
  const [shellIndex, sharedCapabilities, appEntry] = await Promise.all([
    readFile(path.join(project, 'ui/index.html'), 'utf8'), readFile(path.join(project, 'ui/shared-capabilities-ui.js'), 'utf8'),
    readFile(path.join(project, 'ui/app.js'), 'utf8'),
  ]);
  assert(shellIndex.includes('id="sharedNotificationsBtn"')); assert(shellIndex.includes('id="notificationUnreadBadge"'));
  assert(sharedCapabilities.includes("import('./notification-inbox-ui.js?v=notification-inbox1')"));
  assert(/import \{ bindSharedCapabilities \} from '\.\/shared-capabilities-ui\.js\?v=[^']+'/.test(appEntry));
  pass('Actual public shell contains and loads the notification inbox entry');
  const html = `<!doctype html><meta charset="utf-8"><title>通知收件箱合成测试</title><style>:root{--color-composer-ring:#ddd;--color-raised:#fff;--color-ink:#222;--color-app:#f7f5f0;--color-ink-secondary:#555;--color-ink-tertiary:#777;--color-control:#eee;--color-raised-hover:#eee;--color-accent:#1084fe;--color-accent-ink:#fff;--color-accent-border:#3b94f0;--color-warning:#b97b18}body{font-family:system-ui}[hidden]{display:none!important}</style>
    <div id="transcript"></div><button id="sharedNotificationsBtn">通知 <span id="notificationUnreadBadge" hidden>0</span></button><script type="module">import {bindNotificationInbox} from '/dimension-ui/notification-inbox-ui.js';
    const api=async(path,options={})=>{const response=await fetch(path,options);const data=await response.json();if(!response.ok)throw Error(data.error||('HTTP '+response.status));return data};
    window.inbox=bindNotificationInbox({api});window.ready=true;</script>`;
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path: url.pathname, query: url.search, body: body ? JSON.parse(body) : null });
    if (url.pathname === '/dimension-ui/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return; }
    if (url.pathname === '/dimension-ui/notification-inbox-ui.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(await readFile(path.join(project, 'ui/notification-inbox-ui.js'))); return; }
    if (url.pathname === '/api/native/notifications/unread-count') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ unreadCount: unread() })); return;
    }
    if (url.pathname === '/api/native/notifications') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ items: rows, unreadCount: unread(), total: rows.length, limit: 500 })); return;
    }
    if (url.pathname === '/api/native/notifications/read' && req.method === 'POST') {
      const id = JSON.parse(body).id, found = rows.find(row => row.id === id); if (found) found.read = true;
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, found: Boolean(found), unreadCount: unread() })); return;
    }
    if (url.pathname === '/api/native/notifications/read-all' && req.method === 'POST') {
      const updated = unread(); for (const row of rows) row.read = true;
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, updated, unreadCount: 0 })); return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await startBrowser({ output, processes: [] }, 'http://127.0.0.1:' + server.address().port);
  await until(() => browser.evaluate('window.ready && !document.getElementById("notificationUnreadBadge").hidden'), 'unread badge loaded');
  assert.equal(await browser.evaluate('document.getElementById("notificationUnreadBadge").textContent'), '2');
  await browser.click('#sharedNotificationsBtn');
  await until(() => browser.evaluate('document.querySelectorAll(".notification-inbox-item").length===3'), 'three inbox records');
  assert.equal(await browser.evaluate('document.querySelector(".notification-inbox-dialog").open'), true);
  assert.equal(await browser.evaluate('document.querySelectorAll(".notification-inbox-item img").length'), 0);
  assert((await browser.evaluate('document.querySelector(".notification-inbox-item").textContent')).includes('<img src=x onerror=alert(1)>'));
  assert((await browser.evaluate(`document.querySelector('[data-notification-id="run-2:5:resource"]').textContent`)).includes('等待已解除'));
  assert((await browser.evaluate(`document.querySelector('[data-notification-id="run-3:4:takeover"]').textContent`)).includes('等待中'));
  await browser.screenshot('notification-inbox');
  pass('Public entry renders unread count, safe notification fields and resolved versus active waits');

  await browser.click('[data-notification-id="run-1:8:completed"] .notification-inbox-read');
  await until(() => browser.evaluate('document.getElementById("notificationUnreadBadge").textContent==="1"'), 'single read updates badge');
  assert.equal(await browser.evaluate('document.querySelectorAll(".notification-inbox-item.is-unread").length'), 1);
  await browser.click('[data-filter="unread"]');
  assert.equal(await browser.evaluate('document.querySelectorAll(".notification-inbox-item").length'), 1);
  assert.equal(await browser.evaluate('document.querySelector(".notification-inbox-item").dataset.notificationId'), 'run-2:5:resource');
  pass('Single read persists through API and unread filtering keeps only unread history');

  await browser.click('[data-read-all]');
  await until(() => browser.evaluate('document.getElementById("notificationUnreadBadge").hidden'), 'all read clears badge');
  assert.equal(await browser.evaluate('document.querySelectorAll(".notification-inbox-item").length'), 0);
  assert((await browser.evaluate('document.querySelector(".notification-inbox-empty").textContent')).includes('没有未读'));
  await browser.click('[data-filter="all"]');
  assert.equal(await browser.evaluate('document.querySelectorAll(".notification-inbox-item").length'), 3);
  assert.equal(await browser.evaluate('document.querySelectorAll(".notification-inbox-read").length'), 0);
  assert.equal(await browser.evaluate('document.querySelector("[data-read-all]").disabled'), true);
  assert(requests.filter(row => row.path === '/api/native/notifications/read').length === 1);
  assert(requests.filter(row => row.path === '/api/native/notifications/read-all').length === 1);
  assert.equal(await browser.evaluate('document.querySelectorAll("#transcript .notification-inbox-item").length'), 0);
  assert.deepEqual(browser.exceptions, []); assert.deepEqual(browser.blockedExternal, []);
  pass('Mark-all clears unread state without deleting records or creating stream widgets');
} catch (error) {
  failures.push(error.stack || String(error)); console.error(error); process.exitCode = 1;
} finally {
  if (browser) await browser.stop().catch(error => { failures.push(error.stack); process.exitCode = 1; });
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ ok: failures.length === 0, checks, failures, requests,
    fingerprint: digest(await readFile(path.join(project, 'ui/notification-inbox-ui.js'))), screenshots: browser?.screenshots || [] }, null, 2));
  console.log('NOTIFICATION_INBOX_BROWSER_RESULT ok=' + (failures.length === 0) + ' passed=' + checks.length + ' failed=' + failures.length + ' directory=' + output);
}
