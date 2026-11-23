import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';

const root = path.resolve(import.meta.dirname, '..');
const parent = path.join(root, 'outputs', 'phase3-archive-api');
await mkdir(parent, { recursive: true });
const output = await mkdtemp(path.join(parent, 'fixture-'));
const data = path.join(output, 'data');
const executable = path.join(root, 'outputs/build/DImensionagent-native.exe');
const checks = [];
let child, base, failure;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await wait(25);
  }
  throw Error('Timeout: ' + label);
}
async function api(url, body, method = body ? 'POST' : 'GET', status = 200) {
  const response = await fetch(base + url, {
    method, headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.equal(response.status, status);
  return result;
}
const incoming = () => ({
  format: 'dimension-conversation-archive', version: 1, coverage: 'conversation-data-only',
  excludedTypes: ['work-runs', 'tool-receipts', 'message-receipts', 'artifacts',
    'plugins', 'accounts', 'provider-settings', 'group-metadata'],
  bots: [
    { id: 'existing', name: 'Existing', persona: 'PRIVATE_CHANGED_PERSONA', inChat: true, inWork: false },
    { id: 'new-bot', name: 'New', persona: 'PRIVATE_NEW_PERSONA', inChat: true, inWork: true },
  ],
  conversations: [{ botId: 'existing', groupId: '', mode: 'chat',
    messages: [{ id: '9007199254740993', actor: 'user', text: 'PRIVATE_MESSAGE', createdAtMs: '1700000000000' }] }],
  memories: [{ id: '1', botId: 'existing', groupId: '', text: 'PRIVATE_MEMORY',
    state: 'candidate', revision: '99', sourceActor: 'user' }],
});
try {
  child = spawn(executable, ['--data', data, '--ui', path.join(root, 'ui'), '--port', '0'],
    { cwd: output, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  let ready, startError;
  child.on('error', error => { startError = error; });
  createInterface({ input: child.stdout }).on('line', line => {
    try { const value = JSON.parse(line); if (value.ready) ready = value; } catch {}
  });
  await until(() => { if (startError) throw startError; return ready; }, 'native ready');
  base = 'http://127.0.0.1:' + ready.port;
  const info = await api('/api/native/info');
  assert(info.capabilities.includes('archive-preflight'));
  assert(info.capabilities.includes('archive-staging'));
  assert(info.capabilities.includes('atomic-private-archive-import'));
  assert(!info.pending.includes('migration'));
  checks.push('Metadata advertises both read-only preflight and implemented staged import');

  await api('/api/dimension/bots', { id: 'existing', name: 'Existing', persona: 'PRIVATE_ORIGINAL_PERSONA' });
  const added = await api('/api/dimension/memory', { action: 'add', botId: 'existing', text: 'PRIVATE_MEMORY' });
  await api('/api/dimension/memory', { action: 'review', botId: 'existing',
    candidateId: added.candidates[0].id, reviewAction: 'confirm' });
  const memoryBefore = await api('/api/dimension/memory?botId=existing');
  const botsBefore = await api('/api/dimension/bots/lookup');
  const preview = await api('/api/native/archive/preflight', incoming());
  assert.equal(preview.readOnly, true);
  assert.equal(preview.importImplemented, true);
  assert.equal(preview.commitRequiresStaging, true);
  assert.equal(preview.canImport, false);
  assert.equal(preview.advisory, true);
  assert.equal(preview.requiresCommitRecheck, true);
  assert.equal(preview.targetSnapshot, 'non-atomic-public-reads');
  assert.equal(preview.targetDataset, 'native-store');
  assert.equal(preview.applicationMetadataCompared, false);
  assert(preview.blockers.some(item => item.code === 'application-metadata-not-supported'));
  assert.equal(preview.defaultMemoryPolicy, 'preserve-existing');
  assert.equal(preview.counts.bots.additions, 1);
  assert.equal(preview.counts.bots.conflicts, 1);
  assert.equal(preview.counts.memories.conflicts, 1);
  assert.equal(preview.counts.messages.additions, 1);
  assert(!JSON.stringify(preview).includes('PRIVATE_'));
  checks.push('Native API returns bounded conflict and loss metadata without source text or writes');

  const group = incoming();
  group.conversations[0].groupId = 'synthetic-group';
  const groupPreview = await api('/api/native/archive/preflight', group);
  assert(groupPreview.blockers.some(item => item.code === 'group-metadata-unsupported'));
  checks.push('Group text without group metadata is explicitly blocked from restoration');

  for (const change of [
    value => { value.version = 99; },
    value => { value.workRuns = ['PRIVATE_UNSUPPORTED']; },
    value => { value.conversations[0].botId = 'missing'; },
    value => { value.conversations[0].messages[0].id = 9007199254740992; },
  ]) {
    const archive = incoming();
    change(archive);
    const error = await api('/api/native/archive/preflight', archive, 'POST', 400);
    assert.equal(error.code, 'archive_rejected');
    assert.equal(typeof error.path, 'string');
    assert(!JSON.stringify(error).includes('PRIVATE_'));
  }
  checks.push('Unsupported versions/types, broken references and lossy numeric IDs fail with structural errors');
  await api('/api/native/archive/preflight', undefined, 'GET', 405);
  checks.push('Preflight rejects unsupported HTTP methods');
  assert.deepEqual(await api('/api/dimension/memory?botId=existing'), memoryBefore);
  assert.deepEqual(await api('/api/dimension/bots/lookup'), botsBefore);
  checks.push('Accepted and rejected previews leave confirmed memory and Bot roster unchanged');
} catch (error) {
  failure = String(error.stack ?? error);
} finally {
  if (child && child.exitCode === null) {
    child.stdin.end('shutdown\n');
    try { await until(() => child.exitCode !== null, 'shutdown'); }
    catch (error) { failure ??= String(error); child.kill(); }
  }
  const report = { passed: !failure && child?.exitCode === 0, checks, failure: failure ?? null,
    nativeExitCode: child?.exitCode, executable,
    nativeSha256: createHash('sha256').update(await readFile(executable)).digest('hex'),
    productionDataUsed: false, realModelProviderUsed: false };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: checks.length, report: path.join(output, 'result.json'),
    failure: report.failure }));
  if (!report.passed) process.exitCode = 1;
}
