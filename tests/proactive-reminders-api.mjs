import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const project = path.resolve(import.meta.dirname, '..');
const output = path.join(project, 'outputs/proactive-reminders', 'api-' + Date.now());
const data = path.join(output, 'data');
await mkdir(data, { recursive: true });
const executable = path.resolve(process.argv[2] || path.join(project, 'outputs/build/DImensionagent-native.exe'));
const notices = [], checks = [], failures = [];
let child = null, base = '';
const pass = text => { checks.push(text); console.log('PASS ' + text); };
async function start() {
  child = spawn(executable, ['--data', data, '--ui', path.join(project, 'ui'), '--port', '0'], { cwd: output, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('native ready timeout: ' + stderr)), 15000);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      let index;
      while ((index = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, index).trim(); stdout = stdout.slice(index + 1);
        if (!line) continue;
        let value; try { value = JSON.parse(line); } catch { continue; }
        if (value.ready && value.port) { clearTimeout(timer); base = `http://127.0.0.1:${value.port}`; resolve(); }
        if (value.notification) notices.push(value.notification);
      }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { if (!base) { clearTimeout(timer); reject(new Error(`native exited ${code}: ${stderr}`)); } });
  });
  await ready;
}
async function stop() {
  if (!child || child.exitCode !== null) { child = null; base = ''; return; }
  const owned = child;
  const ended = new Promise(resolve => owned.once('exit', resolve));
  owned.stdin.write('shutdown\n');
  await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(new Error('native shutdown timeout')), 15000))]);
  child = null; base = '';
}
async function api(target, options = {}) {
  const response = await fetch(base + target, { ...options, headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000) });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error || `HTTP ${response.status}`), { status: response.status });
  return value;
}
const body = (method, value) => ({ method, body: JSON.stringify(value) });
const ruleInput = () => ({ name: '原生接口提醒', kind: 'interval', intervalMinutes: 1, message: '只通知，不执行', delivery: 'notification', budget: 2,
  endAt: Date.now() + 3600000, endEventType: '', scope: { source: 'scheduler', botId: '', groupId: '', runId: '' } });
try {
  await start();
  const info = await api('/api/native/info');
  assert(info.capabilities.includes('bounded-proactive-reminders'));
  const created = await api('/api/native/proactive-reminders', body('POST', ruleInput()));
  assert.equal(created.rule.enabled, false); assert.equal(created.rule.status, 'paused'); assert.equal(created.rule.nextTriggerAt, 0);
  const id = created.rule.id;
  const resumed = await api(`/api/native/proactive-reminders/${id}/resume`, body('POST', { revision: 1 }));
  assert.equal(resumed.rule.enabled, true); assert(resumed.rule.nextTriggerAt > Date.now());
  const scheduled = resumed.rule.nextTriggerAt;
  const beforeRestart = notices.length;
  await stop();
  assert.equal(notices.length, beforeRestart);
  await start();
  assert.equal(notices.length, beforeRestart);
  const restored = await api(`/api/native/proactive-reminders/${id}`);
  assert.equal(restored.rule.enabled, true); assert.equal(restored.rule.nextTriggerAt, scheduled);
  pass('Native CRUD creates disabled rules and restart preserves schedule without startup notification');

  let conflict = null;
  try { await api(`/api/native/proactive-reminders/${id}/pause`, body('POST', { revision: 1 })); } catch (error) { conflict = error; }
  assert.equal(conflict?.status, 409);
  const updated = await api(`/api/native/proactive-reminders/${id}`, body('PUT', { ...ruleInput(), name: '编辑后的原生提醒', revision: 2 }));
  assert.equal(updated.rule.revision, 3); assert(updated.rule.nextTriggerAt > Date.now());
  const paused = await api(`/api/native/proactive-reminders/${id}/pause`, body('POST', { revision: 3 }));
  assert.equal(paused.rule.enabled, false); assert.equal(paused.rule.nextTriggerAt, 0);
  await api(`/api/native/proactive-reminders/${id}`, body('DELETE', { revision: 4 }));
  assert.deepEqual((await api('/api/native/proactive-reminders')).rules, []);
  pass('Native API enforces revisions and supports edit, pause and delete without Work or tool calls');

  let invalid = null;
  try { await api('/api/native/proactive-reminders', body('POST', { ...ruleInput(), enabled: true })); } catch (error) { invalid = error; }
  assert.equal(invalid?.status, 400);
  const stored = JSON.parse(await readFile(path.join(data, 'proactive-reminders.json'), 'utf8'));
  assert.equal(stored.version, 1); assert.deepEqual(stored.rules, []);
  assert.equal(notices.length, beforeRestart);
  pass('Default-disabled validation is server-side and durable state remains well-formed');
} catch (error) { failures.push(error.stack); console.error(error.stack); process.exitCode = 1; }
finally {
  if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: failures.length === 0, checks, failures, notifications: notices }, null, 2));
  console.log('REPORT ' + path.join(output, 'report.json'));
}
