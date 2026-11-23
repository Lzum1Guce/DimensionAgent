import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixture } from './app-integration.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.resolve(process.argv[2] ?? path.join(root, 'outputs', 'build', 'DImensionagent-native.exe'));
const ui = path.resolve(process.argv[3] ?? path.join(root, 'ui'));
const output = path.resolve(process.argv[4] ?? path.join(root, 'outputs', 'group-chat-governance'));
assert(path.isAbsolute(output) && output !== path.parse(output).root);
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, 'run-'));
const dataDirectory = path.join(directory, 'data');
const bots = ['group-coordinator', 'group-worker', 'group-worker-b'];
const models = ['fixture-flash', 'fixture-chat-a', 'fixture-chat-b', 'fixture-chat-c'];
let releaseOldInput;
const oldInputGate = new Promise((resolve) => { releaseOldInput = resolve; });
// The user history can contain earlier scenario markers. Select the injected
// response for the current submission and identify the member by its configured model.
const fullReply = '第一句，第二句。\n\n`a || b`';
let currentScenario;
const calls = [];
const fixture = await startFixture({ models, chatReply: async ({ body }) => {
  const tag = currentScenario;
  const member = 'Synthetic Member ' + models.indexOf(body.model);
  calls.push({tag, model:body.model});
  if (tag === 'group_one_bubble') return {text:fullReply};
  if (tag === 'group_mentions') return { text: `Addressed reply ${member}` };
  if (tag === 'group_duplicate') return { text: member === 'Synthetic Member 2' ? 'A distinct contribution' : member === 'Synthetic Member 3' ? '  SHARED   conclusion ' : 'Shared conclusion' };
  if (tag === 'group_silence') return { text: member === 'Synthetic Member 1' ? '+1' : member === 'Synthetic Member 2' ? ' [[SILENT]] ' : 'Only substantive reply' };
  if (tag === 'group_partial_failure') return member === 'Synthetic Member 1' ? { status: 502, error: 'Synthetic member failure' } : { text: `Surviving reply ${member}` };
  if (tag === 'group_old_input') {
    await oldInputGate;
    return { text: `STALE_REPLY ${member}` };
  }
  if (tag === 'group_new_input') return { text: `Fresh reply ${member}` };
  if (tag === 'group_quote_followup') return { text: `Quoted follow-up ${member}` };
  return {text: `Reply ${tag} ${member}`};
} });
const tests = [];
const failures = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child;
let exited = false;
let exitPromise;
let stdout = '';
let stderr = '';
let base;
let groupId;

async function until(predicate, description, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    if (exited) throw new Error(`Native exited unexpectedly: ${stderr}`);
    await sleep(20);
  }
  throw new Error(`Timed out: ${description}`);
}
async function check(name, action) {
  const started = Date.now();
  try {
    await action();
    tests.push({ name, passed: true, milliseconds: Date.now() - started });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    const detail = String(error.stack ?? error).replaceAll('synthetic-key', '[redacted]');
    tests.push({ name, passed: false, milliseconds: Date.now() - started, detail });
    failures.push(detail);
    process.stderr.write(`FAIL ${name}: ${detail}\n`);
    throw error;
  }
}
async function api(target, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + target, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000) });
  const text = await response.text();
  assert.ok(response.ok, `${method} ${target}: ${response.status} ${text}`);
  return JSON.parse(text);
}
async function groupSay(tag, extra = '', quote) {
  currentScenario = tag;
  const response = await fetch(base + `/api/dimension/groups/${groupId}/say`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `APPTEST:${tag}${extra}`, mode: 'discuss', ...(quote ? { quote } : {}) }),
    signal: AbortSignal.timeout(15000),
  });
  assert.ok(response.ok, `Group say failed: ${response.status}`);
  const events = [];
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end; (end = buffer.indexOf('\n\n')) >= 0;) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      for (const line of frame.split('\n')) if (line.startsWith('data: ')) events.push({ ...JSON.parse(line.slice(6)), receivedAt: Date.now() });
    }
  }
  assert.equal(buffer.trim(), '');
  return events;
}
const history = () => api(`/api/dimension/groups/${groupId}?mode=chat&limit=99`);
const speakers = (events) => events.filter((event) => event.kind === 'say' && event.from !== 'user');

try {
  child = spawn(executable, ['--data', dataDirectory, '--ui', ui, '--port', '0'], {
    cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    for (const line of stdout.split(/\r?\n/)) {
      try { const value = JSON.parse(line); if (value.ready) base = `http://127.0.0.1:${value.port}`; } catch {}
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  exitPromise = new Promise((resolve) => child.once('close', (code) => { exited = true; resolve(code); }));
  await until(() => { if (spawnError) throw spawnError; return base; }, 'native ready');

  await check('provision isolated group and per-bot Chat models', async () => {
    for (const [index, id] of bots.entries()) {
      await api('/api/dimension/bots', { id, name: `Synthetic Member ${index + 1}`, persona: 'Synthetic group test persona' });
      const roster = await api(`/api/dimension/bots/${id}/roster`, { mode: 'work', present: true }, 'PATCH');
      assert.equal(roster.bot.chat, true);
    }
    await api('/api/providers', { name: 'synthetic', entry: { kind: 'openai-chat-compat', baseUrl: fixture.baseUrl,
      spec: { model: 'fixture-flash', maxTokens: 4096 } }, secretValue: 'synthetic-key' });
    for (const [index, id] of bots.entries())
      await api(`/api/dimension/bots/${id}/conversation-model`, { modelSelection: { providerId: 'synthetic', model: `fixture-chat-${'abc'[index]}` } });
    groupId = (await api('/api/dimension/groups', { name: 'Synthetic Group', ownerId: bots[0], members: bots })).group.id;
  });

  await check('overlapping handles and historical quotes select only the intended member', async () => {
    const originalGroup = groupId;
    groupId = (await api('/api/dimension/groups', { name: 'Routing edge cases', ownerId: bots[0], members: bots })).group.id;
    const seed = speakers(await groupSay('group_seed', ' @'+bots[2]));
    assert.deepEqual(seed.map(e=>e.from), [bots[2]]);
    for (let i=0;i<14;i++) await groupSay('group_filler_'+i,' @'+bots[0]);
    const before = calls.length;
    const follow = speakers(await groupSay('group_older_reply','',{messageId:seed[0].messageId}));
    assert.deepEqual(follow.map(e=>e.from),[bots[2]]);
    assert.deepEqual(calls.slice(before).map(r=>r.model),['fixture-chat-c']);
    groupId = originalGroup;
  });
  await check('ordinary group Chat retains spaced per-bot turns and hides thoughts', async () => {
    const events = await groupSay('group_chat');
    assert.equal(speakers(events).length, 3);
    const records = calls.filter((record) => record.tag === 'group_chat');
    assert.deepEqual(records.map((record) => record.model).sort(), ['fixture-chat-a', 'fixture-chat-b', 'fixture-chat-c']);
    for (let index = 1; index < speakers(events).length; ++index)
      assert.ok(speakers(events)[index].receivedAt - speakers(events)[index - 1].receivedAt >= 0);
    assert.ok(!JSON.stringify(events).includes('THINKING_ONLY'));
    for (const bot of bots) assert.equal((await api(`/api/dimension/bots/${bot}/history?limit=99`)).messages.length, 0);
  });

  await check('explicit @ mention calls only the addressed group member', async () => {
    const events = await groupSay('group_mentions', ' @Synthetic Member 2 请回答');
    assert.deepEqual(speakers(events).map((event) => event.from), [bots[1]]);
    const records = calls.filter((record) => record.tag === 'group_mentions');
    assert.equal(records.length, 1);
    assert.equal(records[0].model, 'fixture-chat-b');
  });

  await check('group member sends one complete bubble with punctuation, paragraphs and code', async () => {
    const rows=speakers(await groupSay('group_one_bubble',' @'+bots[1]));
    assert.deepEqual(rows.map(row=>[row.from,row.text]),[[bots[1],fullReply]]);
    assert.ok((await history()).messages.some(row=>row.messageId===rows[0].messageId && row.text===fullReply));
  });

  await check('quoting a Bot follow-up calls only that member', async () => {
    const seeded = await groupSay('group_quote_seed');
    const target = speakers(seeded).find((event) => event.from === bots[1]);
    assert.ok(target?.messageId);
    const events = await groupSay('group_quote_followup', '', { messageId: target.messageId });
    assert.deepEqual(speakers(events).map((event) => event.from), [bots[1]]);
    assert.equal(calls.filter((record) => record.tag === 'group_quote_followup').length, 1);
  });

  await check('nonadjacent duplicate replies are suppressed after normalization', async () => {
    const events = await groupSay('group_duplicate');
    assert.equal(speakers(events).length, 2);
    assert.ok(speakers(events).some(event => event.from === bots[1]));
    assert.ok(speakers(events).some(event => [bots[0],bots[2]].includes(event.from)));
    assert.equal((await history()).messages.filter((message) => /shared\s+conclusion/i.test(message.text)).length, 1);
    assert.equal(calls.filter((record) => record.tag === 'group_duplicate').length, 3);
  });

  await check('silent markers and mechanical agreement do not create messages', async () => {
    const events = await groupSay('group_silence');
    assert.equal(speakers(events).length, 1);
    assert.equal(speakers(events)[0].from, bots[2]);
    assert.equal(speakers(events)[0].text, 'Only substantive reply');
  });

  await check('one member model failure does not cancel remaining replies', async () => {
    const events = await groupSay('group_partial_failure');
    assert.deepEqual(speakers(events).map((event) => event.from).sort(), bots.slice(1).sort());
    assert.ok(events.some((event) => event.kind === 'error' && /Synthetic Member 1/.test(event.text) && /502/.test(event.text)));
  });

  await check('new user input discards stale queued replies before continuing', async () => {
    const oldSay = groupSay('group_old_input');
    await until(() => calls.some((record) => record.tag === 'group_old_input'), 'old input model entered');
    const newSay = groupSay('group_new_input');
    await until(async () => (await history()).messages.some((message) => message.text === 'APPTEST:group_new_input'), 'new input saved');
    releaseOldInput();
    await Promise.all([oldSay, newSay]);
    const rows = await history();
    assert.ok(!rows.messages.some((message) => message.text.startsWith('STALE_REPLY')));
    assert.equal(rows.messages.filter((message) => message.text.startsWith('Fresh reply')).length, 3);
    assert.equal(calls.filter((record) => record.tag === 'group_old_input').length, 1);
    assert.equal(calls.filter((record) => record.tag === 'group_new_input').length, 3);
  });

  await check('all group fixtures stayed isolated and credential-free', async () => {
    assert.equal(fixture.errors.length, 0, fixture.errors.join('\n'));
    assert.ok(!stdout.includes('synthetic-key') && !stderr.includes('synthetic-key'));
    assert.ok(!(await readFile(path.join(dataDirectory, 'settings.json'), 'utf8')).includes('synthetic-key'));
  });
} catch (error) {
  if (!failures.length) failures.push(String(error.stack ?? error).replaceAll('synthetic-key', '[redacted]'));
  process.exitCode = 1;
} finally {
  releaseOldInput();
  if (child && !exited) {
    child.stdin.end('shutdown\n');
    const timer = setTimeout(() => child.kill(), 10000);
    const code = await exitPromise;
    clearTimeout(timer);
    if (code !== 0) { failures.push(`Native exit code ${code}`); process.exitCode = 1; }
  }
  await fixture.close();
  const report = { passed: tests.filter((test) => test.passed).length, failed: failures.length, tests, failures,
    fixtureErrors: fixture.errors, dataDirectory, groupId, executable,
    nativeSha256: createHash('sha256').update(await readFile(executable)).digest('hex'),
    processes: child ? [{ pid: child.pid, exitCode: child.exitCode, signal: child.signalCode }] : [],
    network: 'ephemeral IPv4 loopback only', readProductionData: false };
  await writeFile(path.join(directory, 'native.stdout.log'), stdout.replaceAll('synthetic-key', '[redacted]'));
  await writeFile(path.join(directory, 'native.stderr.log'), stderr.replaceAll('synthetic-key', '[redacted]'));
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(output, 'latest-result.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`GROUP_CHAT_RESULT passed=${report.passed} failed=${report.failed} directory=${directory}\n`);
}
