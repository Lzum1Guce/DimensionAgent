import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixture } from './app-integration.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.resolve(process.argv[2] ?? path.join(root, 'outputs', 'build', 'DImensionagent-native.exe'));
const ui = path.resolve(process.argv[3] ?? path.join(root, 'ui'));
const output = path.resolve(process.argv[4] ?? path.join(root, 'outputs', 'impression-api'));
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, 'run-'));
const data = path.join(directory, 'data');
const fixture = await startFixture();
const alpha = 'impression-alpha', beta = 'impression-beta';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(action, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await action();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`Timeout: ${label}`);
}
let app, socket;
const frames = [];
const processes = [];
async function launch() {
  const child = spawn(executable, ['--data', data, '--ui', ui, '--port', '0'],
    { cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const record = { child, stdout: '', stderr: '', exited: false, port: null };
  processes.push(record);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    record.stdout += chunk;
    for (const line of record.stdout.split(/\r?\n/)) {
      try { const value = JSON.parse(line); if (value.ready) record.port = value.port; } catch {}
    }
  });
  child.stderr.on('data', chunk => { record.stderr += chunk; });
  record.exit = new Promise(resolve => child.once('close', code => { record.exited = true; resolve(code); }));
  await until(() => {
    if (record.exited) throw new Error(`Native exited: ${record.stderr}`);
    return record.port;
  }, 'native ready');
  record.base = `http://127.0.0.1:${record.port}`;
  record.stop = async () => {
    if (record.exited) return;
    child.stdin.end('shutdown\n');
    const timer = setTimeout(() => child.kill(), 10000);
    assert.equal(await record.exit, 0, record.stderr); clearTimeout(timer);
  };
  return record;
}
async function response(target, body, method = body === undefined ? 'GET' : 'POST') {
  const result = await fetch(app.base + target, { method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const text = await result.text();
  let value; try { value = JSON.parse(text); } catch { value = { text }; }
  return { status: result.status, value, text };
}
async function api(target, body, method = body === undefined ? 'GET' : 'POST') {
  const result = await response(target, body, method);
  assert.equal(result.status, 200, `${method} ${target}: ${result.text}`);
  return result.value;
}
async function openChat() {
  const ws = new WebSocket(app.base.replace('http:', 'ws:') + '/ws/providers/world:console/panels/chat');
  ws.addEventListener('message', event => frames.push(JSON.parse(event.data)));
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.send(JSON.stringify({ type: 'hello', botId: alpha, historyLimit: 1 }));
  return ws;
}
async function privateChat(tag) {
  const begin = frames.length, text = `APPTEST:${tag}`;
  socket.send(JSON.stringify({ type: 'msg', botId: alpha, text, requestId: `request-${tag}` }));
  await until(() => frames.slice(begin).some(frame => !frame.history && frame.role === 'assistant' && frame.text === `Chat reply ${tag} 🙂`), tag);
}
async function groupSay(tag, extra = '', mode = 'discuss') {
  const result = await fetch(app.base + `/api/dimension/groups/${groupId}/say`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: `APPTEST:${tag}${extra}`, mode, ...(mode === 'work' ? { workBotId: alpha } : {}) }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await result.text();
  assert.equal(result.status, 200, text);
  const events = text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  return { events, runId: events[0]?.runId };
}
function modelMemory(tag, botName) {
  return fixture.records.filter(record => record.tag === tag).filter(record =>
    record.body.messages.some(message => message.role === 'system' && message.content.includes(`你是 ${botName}。`)));
}

let groupId;
try {
  app = await launch();
  for (const [id, name] of [[alpha, 'Impression Alpha'], [beta, 'Impression Beta']]) {
    await api('/api/dimension/bots', { id, name, persona: `Synthetic persona ${id}` });
    await api(`/api/dimension/bots/${id}/roster`, { mode: 'work', present: true }, 'PATCH');
  }
  await api('/api/providers', { name: 'synthetic', entry: { kind: 'openai-chat-compat', baseUrl: fixture.baseUrl,
    spec: { model: 'fixture-flash' } }, secretValue: 'synthetic-key' });
  groupId = (await api('/api/dimension/groups', { name: 'Synthetic impressions', ownerId: alpha, members: [alpha, beta] })).group.id;
  socket = await openChat();
  await privateChat('private_impression_source');
  const privateHistory = await api(`/api/dimension/bots/${alpha}/history?limit=20`);
  const privateMessage = privateHistory.messages.find(row => row.text === 'APPTEST:private_impression_source');
  assert(privateMessage);

  await groupSay('impression_source');
  const sharedHistory = await api(`/api/dimension/groups/${groupId}?mode=chat&limit=50`);
  const source = sharedHistory.messages.find(row => row.from === 'user' && row.text === 'APPTEST:impression_source');
  assert(source);
  const impression = { action: 'propose-impression', botId: alpha, groupId, targetBotId: beta,
    text: '我认为 Beta 在接口排错协作中会先复现', eventTimeMs: Date.now(), sourceRef: `message:${source.messageId}`,
    evidence: '双方同群可见的排错互动', applicableScenarios: '共同排查接口故障' };
  const privateAttempt = await response('/api/dimension/memory', { ...impression,
    sourceRef: `message:${privateMessage.messageId}` });
  assert.equal(privateAttempt.status, 404);
  const emptyScope = await response('/api/dimension/memory', { ...impression, groupId: '' });
  assert.equal(emptyScope.status, 400);

  let memory = await api('/api/dimension/memory', impression);
  let candidate = memory.impressions.find(row => row.sourceRef === impression.sourceRef);
  assert(candidate && candidate.state === 'candidate' && candidate.subjective === true);
  assert(!Object.hasOwn(candidate, 'affinity') && !Object.hasOwn(candidate, 'confidence'));
  const repeated = await api('/api/dimension/memory', impression);
  const duplicate = repeated.impressions.find(row => row.id === candidate.id);
  assert.equal(repeated.impressions.length, 1); assert.equal(duplicate.revision, candidate.revision);

  await groupSay('impression_candidate_recall', '\n接口排错 复现');
  for (const record of modelMemory('impression_candidate_recall', 'Impression Alpha'))
    assert(!JSON.stringify(record.body).includes('Bot→Bot主观协作印象'));
  await api('/api/dimension/memory', { action: 'review', botId: alpha, groupId,
    candidateId: candidate.id, revision: candidate.revision, reviewAction: 'confirm' });
  await groupSay('impression_confirmed_recall', '\n接口排错 复现');
  const alphaRecall = modelMemory('impression_confirmed_recall', 'Impression Alpha');
  const betaRecall = modelMemory('impression_confirmed_recall', 'Impression Beta');
  assert(alphaRecall.length && betaRecall.length);
  assert(alphaRecall.some(record => JSON.stringify(record.body).includes('Bot→Bot主观协作印象') &&
    JSON.stringify(record.body).includes('不是对象客观人设')));
  assert(betaRecall.every(record => !JSON.stringify(record.body).includes('Bot→Bot主观协作印象')));

  const work = await groupSay('impression_shared_work', '', 'work');
  assert(work.runId);
  await until(async () => {
    const run = await api(`/api/dimension/work/runs/${work.runId}`);
    return run.terminal && !run.executing ? run : null;
  }, 'shared Work completion');
  const correctionBody = { ...impression, text: '我修正为：Beta 在共同 Work 中适合按写文件再验证的步骤协作',
    sourceRef: `run:${work.runId}`, evidence: '共同 Work 收据显示写文件后完成验证',
    applicableScenarios: '共同完成可验证文件任务', supersedesId: candidate.id };
  memory = await api('/api/dimension/memory', correctionBody);
  const correction = memory.impressions.find(row => row.sourceRef === correctionBody.sourceRef);
  assert(correction && correction.state === 'candidate' && correction.supersedesId === candidate.id);
  assert.equal(memory.impressions.find(row => row.id === candidate.id).state, 'confirmed');
  await api('/api/dimension/memory', { action: 'review', botId: alpha, groupId,
    candidateId: correction.id, revision: correction.revision, reviewAction: 'confirm' });
  memory = await api(`/api/dimension/memory?botId=${alpha}&groupId=${encodeURIComponent(groupId)}`);
  assert.equal(memory.impressions.find(row => row.id === candidate.id).state, 'rejected');
  assert.equal(memory.impressions.find(row => row.id === correction.id).state, 'confirmed');

  const exported = await api('/api/native/archive/export', {});
  const archived = exported.archive.memories.find(row => row.id === correction.id);
  assert(archived && archived.kind === 'impression' && archived.targetBotId === beta &&
    archived.supersedesId === candidate.id && archived.applicableScenarios === correctionBody.applicableScenarios);

  await app.stop(); app = await launch();
  memory = await api(`/api/dimension/memory?botId=${alpha}&groupId=${encodeURIComponent(groupId)}`);
  assert.equal(memory.impressions.length, 2);
  assert.equal(memory.impressions.find(row => row.id === candidate.id).state, 'rejected');
  assert.equal(memory.impressions.find(row => row.id === correction.id).state, 'confirmed');
  assert.deepEqual(fixture.errors, []);
  const report = { passed: 8, failed: 0, syntheticOnly: true, directionIsolation: true,
    privateSourceRejected: true, duplicateSourceIdempotent: true, confirmedRecall: true,
    sharedWorkCorrection: true, archiveFields: true, restartRecovery: true };
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`IMPRESSION_API_RESULT ${JSON.stringify(report)}\n`);
} finally {
  if (socket) socket.close();
  if (app && !app.exited) await app.stop();
  await fixture.close();
}
