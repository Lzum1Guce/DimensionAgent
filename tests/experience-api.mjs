import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

const root = path.resolve(import.meta.dirname, '..');
const executable = path.join(root, 'outputs/build/DImensionagent-native.exe');
const outputParent = path.join(root, 'outputs/experience-api');
await mkdir(outputParent, { recursive: true });
const output = await mkdtemp(path.join(outputParent, 'fixture-'));
const data = path.join(output, 'data');
const checks = [];
let child, base, failure;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startServer() {
  child = spawn(executable, ['--data', data, '--ui', path.join(root, 'ui'), '--port', '0'], {
    cwd: output, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  let ready, startError;
  child.on('error', error => { startError = error; });
  createInterface({ input: child.stdout }).on('line', line => {
    try { const value = JSON.parse(line); if (value.ready) ready = value; } catch {}
  });
  const deadline = Date.now() + 12000;
  while (!ready && Date.now() < deadline) {
    if (startError) throw startError;
    await wait(25);
  }
  assert(ready, 'native server becomes ready');
  base = 'http://127.0.0.1:' + ready.port;
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.stdin.end('shutdown\n');
  await Promise.race([exited, wait(5000).then(() => { throw Error('native shutdown timeout'); })]);
}

async function api(url, body, method = body === undefined ? 'GET' : 'POST', status = 200) {
  const response = await fetch(base + url, {
    method, headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(12000),
  });
  const text = await response.text();
  let result;
  try { result = text ? JSON.parse(text) : null; } catch { result = text; }
  assert.equal(response.status, status, `${method} ${url}: ${text}`);
  return result;
}

const draftPath = (mode, botId = '', groupId = '') =>
  `/api/dimension/draft?mode=${mode}&botId=${encodeURIComponent(botId)}&groupId=${encodeURIComponent(groupId)}`;
const saveDraft = (mode, botId, groupId, text, baseRevision, method = 'PUT', status = 200) =>
  api('/api/dimension/draft', { mode, botId, groupId, text, baseRevision }, method, status);
const values = fields => Object.fromEntries(fields.map(field => [field.key, field.content]));

try {
  await startServer();
  const info = await api('/api/native/info');
  assert(info.capabilities.includes('versioned-conversation-drafts'));
  assert(info.capabilities.includes('persona-revision-restore'));
  for (const [id, name] of [['experience-alpha', '体验甲'], ['experience-beta', '体验乙']]) {
    await api('/api/dimension/bots', {
      id, name,
      persona: '【SELF.md】\n原始自我\n\n【PERSONALITY.md】\n原始性格\n\n【PREFERENCES.md】\n原始喜好\n\n【SPEECH.md】\n原始说话\n\n【CRAFT.md】\n原始工作',
    });
  }
  const group = await api('/api/dimension/groups', {
    name: '体验群', ownerId: 'experience-alpha', members: ['experience-alpha', 'experience-beta'],
  });
  const groupId = group.group.id;
  checks.push('Synthetic Bots and group are isolated in a new native dataset');

  assert.equal((await api(draftPath('chat', 'experience-alpha'))).draft, null);
  const alpha1 = (await saveDraft('chat', 'experience-alpha', '', '甲 Chat 草稿', '0')).draft;
  const beta1 = (await saveDraft('chat', 'experience-beta', '', '乙 Chat 草稿', '0')).draft;
  const work1 = (await saveDraft('work', 'experience-alpha', '', '甲 Work 草稿', '0')).draft;
  const group1 = (await saveDraft('chat', '', groupId, '群 Chat 草稿', '0')).draft;
  assert.equal(alpha1.revision, '1');
  assert.equal((await api(draftPath('chat', 'experience-alpha'))).draft.text, '甲 Chat 草稿');
  assert.equal((await api(draftPath('chat', 'experience-beta'))).draft.text, '乙 Chat 草稿');
  assert.equal((await api(draftPath('work', 'experience-alpha'))).draft.text, '甲 Work 草稿');
  assert.equal((await api(draftPath('chat', '', groupId))).draft.text, '群 Chat 草稿');
  checks.push('Two Bots, Work and group drafts retain separate exact contexts');

  await saveDraft('chat', 'experience-alpha', '', 'other window', '0', 'PUT', 409);
  assert.equal((await api(draftPath('chat', 'experience-alpha'))).draft.text, '甲 Chat 草稿');
  await api('/api/dimension/draft', { mode: 'chat', botId: 'experience-alpha', groupId: '', revision: '999' }, 'DELETE', 409);
  assert.equal((await api(draftPath('chat', 'experience-alpha'))).draft.text, '甲 Chat 草稿');
  checks.push('Stale writes and stale clears cannot replace or erase newer input');

  await api('/api/dimension/draft', { mode: 'chat', botId: 'experience-beta', groupId: '', revision: beta1.revision }, 'DELETE');
  assert.equal((await api(draftPath('chat', 'experience-beta'))).draft, null);
  assert.equal((await api(draftPath('chat', 'experience-alpha'))).draft.text, '甲 Chat 草稿');
  const alpha2 = (await saveDraft('chat', 'experience-alpha', '', '发送期间新输入', alpha1.revision)).draft;
  await api('/api/dimension/draft', { mode: 'chat', botId: 'experience-alpha', groupId: '', revision: alpha1.revision }, 'DELETE', 409);
  assert.equal((await api(draftPath('chat', 'experience-alpha'))).draft.text, '发送期间新输入');
  await api('/api/dimension/draft', { mode: 'chat', botId: 'experience-alpha', groupId: '', revision: alpha2.revision }, 'DELETE');
  checks.push('Sending clears only its own submitted revision and preserves other Bots');

  await stopServer();
  await startServer();
  assert.equal((await api(draftPath('work', 'experience-alpha'))).draft.text, '甲 Work 草稿');
  assert.equal((await api(draftPath('chat', '', groupId))).draft.text, '群 Chat 草稿');
  assert.equal((await api(draftPath('chat', 'experience-alpha'))).draft, null);
  assert.equal((await api(draftPath('chat', 'experience-beta'))).draft, null);
  assert.equal(work1.text, '甲 Work 草稿');
  assert.equal(group1.text, '群 Chat 草稿');
  checks.push('Backend reopen restores remaining drafts without resurrecting sent drafts');

  await saveDraft('chat', 'experience-alpha', groupId, 'invalid dual scope', '0', 'PUT', 400);
  await saveDraft('chat', 'experience-alpha', '', 'x'.repeat(65537), '0', 'PUT', 400);
  checks.push('Ambiguous scopes and oversized drafts are rejected without a write');

  const before = await api('/api/dimension/persona?botId=experience-alpha');
  assert.equal(before.fields.length, 5);
  const firstValues = values(before.fields);
  firstValues.speech_style = '第一版说话';
  firstValues.personality = '第一版性格';
  const first = await api('/api/dimension/persona?botId=experience-alpha', {
    values: firstValues, baseRevision: before.profileRevision,
  });
  let revisions = (await api('/api/dimension/persona/revisions?botId=experience-alpha')).revisions;
  assert.equal(revisions.length, 1);
  assert.equal(values(revisions[0].fields).speech_style, '原始说话');
  assert.equal(revisions[0].action, 'save');

  const secondValues = values(first.fields);
  secondValues.speech_style = '第二版说话';
  const second = await api('/api/dimension/persona?botId=experience-alpha', {
    values: secondValues, baseRevision: first.profileRevision,
  });
  revisions = (await api('/api/dimension/persona/revisions?botId=experience-alpha')).revisions;
  assert.equal(revisions.length, 2);
  assert.equal(values(revisions[0].fields).speech_style, '第一版说话');
  const target = revisions[0];

  const restored = await api('/api/dimension/persona/restore?botId=experience-alpha', {
    baseRevision: second.profileRevision, revisionId: target.revisionId,
  });
  assert.equal(values(restored.fields).speech_style, '第一版说话');
  revisions = (await api('/api/dimension/persona/revisions?botId=experience-alpha')).revisions;
  assert.equal(revisions.length, 3);
  assert.equal(revisions[0].action, 'restore');
  assert.equal(revisions[0].restoredRevisionId, target.revisionId);
  assert.equal(values(revisions[0].fields).speech_style, '第二版说话');

  const restoredAgain = await api('/api/dimension/persona/restore?botId=experience-alpha', {
    baseRevision: restored.profileRevision, revisionId: revisions[0].revisionId,
  });
  assert.equal(values(restoredAgain.fields).speech_style, '第二版说话');
  revisions = (await api('/api/dimension/persona/revisions?botId=experience-alpha')).revisions;
  assert.equal(revisions.length, 4);
  assert.equal(revisions[0].action, 'restore');
  checks.push('Five-field saves retain prior versions and restoration itself is reversible history');

  await api('/api/dimension/persona/restore?botId=experience-alpha', {
    baseRevision: first.profileRevision, revisionId: target.revisionId,
  }, 'POST', 409);
  const other = await api('/api/dimension/persona?botId=experience-beta');
  assert.equal(values(other.fields).speech_style, '原始说话');
  assert.equal(values((await api('/api/dimension/persona?botId=experience-alpha')).fields).speech_style, '第二版说话');
  checks.push('Stale restoration is rejected and another Bot remains unchanged');
} catch (error) {
  failure = String(error.stack ?? error);
} finally {
  try { await stopServer(); } catch (error) { failure ??= String(error); child?.kill(); }
  const report = { passed: !failure && child?.exitCode === 0, checks, failure: failure ?? null,
    nativeExitCode: child?.exitCode, productionDataUsed: false, externalServicesUsed: false };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: checks.length, report: path.join(output, 'result.json'), failure: report.failure }));
  if (!report.passed) process.exitCode = 1;
}
