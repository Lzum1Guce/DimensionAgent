import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, link, mkdir, mkdtemp, open, readFile, readdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CoreClient } from '../work/core-client.mjs';

const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  assert(process.argv[i]?.startsWith('--') && process.argv[i + 1], 'Use --executable EXE --core CORE_EXE --output L:\\OUTPUT');
  assert(!options.has(process.argv[i]), 'Duplicate test argument'); options.set(process.argv[i], process.argv[i + 1]);
}
for (const key of ['--executable', '--core', '--output']) assert(options.has(key), `Missing ${key}`);
assert.equal(options.size, 3);
const executable = path.resolve(options.get('--executable')), core = path.resolve(options.get('--core'));
const output = path.resolve(options.get('--output'));
assert(/^[lL]:[\\/]/.test(output), 'Synthetic outputs must stay on L:');
await mkdir(output, { recursive: true });
const fixture = await mkdtemp(path.join(output, 'bot-memory-import-'));
await mkdir(path.join(fixture, 'temp'));
process.chdir(fixture); process.env.TEMP = path.join(fixture, 'temp'); process.env.TMP = process.env.TEMP;
const checks = [], prefix = 'PRIVATE_TRANSFER_BODY_';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = async file => { try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const clone = value => structuredClone(value);
const check = async (name, action) => { await action(); checks.push(name); };
const bot = (id, chat, work) => ({ id, name: prefix + id + ' 中文', persona: prefix + id + ' persona\n🙂', inChat: chat, inWork: work });
const memory = (id, botId, state, revision) => ({ id, botId, groupId: '', text: prefix + id + ' 记忆🙂', state, revision, sourceActor: 'user' });
const transfer = {
  format: 'dimension-bot-memory-transfer', version: 1, sourceId: 'legacy-synthetic-stable-v1',
  archive: { format: 'dimension-conversation-archive', version: 1, coverage: 'conversation-data-only',
    excludedTypes: ['work-runs', 'tool-receipts', 'message-receipts', 'artifacts', 'plugins', 'accounts', 'provider-settings', 'group-metadata'],
    bots: [bot('alpha', true, false), bot('beta', false, true)], conversations: [],
    memories: [memory('9007199254740993', 'alpha', 'candidate', '7'), memory('9007199254740994', 'alpha', 'confirmed', '9007199254740993'), memory('9223372036854775807', 'beta', 'rejected', '9223372036854775807')] },
};
const input = path.join(fixture, '规范化输入.json'), database = path.join(fixture, 'target.sqlite');
await writeFile(input, JSON.stringify(transfer), 'utf8');
const sourceHash = hash(await readFile(input));
const invoke = (args, expected = 0) => {
  const result = spawnSync(executable, args, { cwd: fixture, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 65536,
    env: { ...process.env, TEMP: path.join(fixture, 'temp'), TMP: path.join(fixture, 'temp') } });
  assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, expected, 'Unexpected CLI exit status');
  assert.equal(result.stderr, ''); assert(!result.stdout.includes(prefix), 'CLI exposed record content');
  assert(!result.stdout.includes(fixture), 'CLI exposed a supplied path');
  const lines = result.stdout.trim().split(/\r?\n/); assert.equal(lines.length, 1);
  return JSON.parse(lines[0]);
};
const cli = (source = input, target = database, apply = false, expected = 0) => invoke(['--input', source, '--database', target, ...(apply ? ['--apply'] : [])], expected);
const noSidecars = async target => { for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(await exists(target + suffix), false); };
const withCore = async (action, target = database) => {
  const client = new CoreClient(core, target);
  try { await client.request('info'); return await action(client); } finally { assert.equal(await client.close(), 0); }
};
const writeCase = async (name, value) => {
  const file = path.join(fixture, name + '.json');
  await writeFile(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)); return file;
};
const unchanged = async (file, action) => { const before = await readFile(file); await action(); assert.deepEqual(await readFile(file), before); };

await check('help and argument errors are bounded JSON without content', async () => {
  assert.match(invoke(['--help']).usage, /--apply/);
  assert.equal(invoke([], 2).error.code, 'invalid_arguments');
  assert.equal(invoke(['--input', input, '--database', database, '--apply', '--apply'], 2).error.code, 'invalid_arguments');
  assert.equal(invoke(['--input', 'relative.json', '--database', database], 2).error.code, 'invalid_path');
  assert.equal(invoke(['--input', input, '--database', database + ':stream'], 2).error.code, 'invalid_path');
});
await check('new-target preview does not create any file or sidecar', async () => {
  const files = await readdir(fixture);
  const result = cli();
  assert.equal(result.ok, true); assert.equal(result.status, 'preview'); assert.equal(result.advisory, true);
  assert.equal(result.requiresCommitRecheck, true); assert.equal(result.canCommit, null); assert.equal(result.targetExists, false);
  assert.deepEqual(result.input, { bots: 2, memories: 3 }); assert.deepEqual(result.proposedAdds, result.input);
  assert.deepEqual(result.existing, { bots: 0, memories: 0 }); assert.equal(result.messagesImported, 0); assert.equal(result.attachmentsImported, 0);
  assert.deepEqual(await readdir(fixture), files); assert.equal(await exists(database), false); await noSidecars(database);
  assert.equal(hash(await readFile(input)), sourceHash);
});
await check('missing target parent is not silently created', async () => {
  const parent = path.join(fixture, 'never-create');
  assert.equal(cli(input, path.join(parent, 'target.sqlite'), false, 4).error.code, 'invalid_parent');
  assert.equal(await exists(parent), false);
});
await check('apply creates a native target and imports only Bots and private memories', async () => {
  const result = cli(input, database, true);
  assert.equal(result.status, 'applied'); assert.equal(result.counts.botsCreated, 2); assert.equal(result.counts.memoriesCreated, 3);
  assert.equal(result.messagesImported, 0); assert.equal(result.attachmentsImported, 0);
  assert(BigInt(result.revisionAfter) > BigInt(result.revisionBefore)); await noSidecars(database);
  await withCore(async client => {
    const bots = await client.request('bot.list');
    assert.equal(bots.length, 2);
    for (const source of transfer.archive.bots) {
      const target = bots.find(value => value.id === source.id);
      assert.equal(target.name, source.name); assert.equal(target.persona, source.persona);
      assert.equal(target.chat, source.inChat); assert.equal(target.work, source.inWork);
      const memories = await client.request('memory.list', { botId: source.id, groupId: '', limit: 100 });
      for (const memory of transfer.archive.memories.filter(value => value.botId === source.id)) {
        const restored = memories.find(value => value.text === memory.text); assert(restored);
        assert.equal(restored.state, memory.state); assert.equal(restored.revision, memory.revision); assert.equal(restored.groupId, '');
      }
      for (const mode of ['chat', 'work']) assert.deepEqual(await client.request('message.list', { botId: source.id, mode }), []);
    }
  });
  await noSidecars(database); assert.equal(hash(await readFile(input)), sourceHash);
  assert.equal(await exists(path.join(fixture, 'attachments')), false);
});
await check('existing-target preview is read-only and explicitly advisory', async () => {
  const files = await readdir(fixture), before = await stat(database);
  await unchanged(database, async () => {
    const result = cli(); assert.equal(result.targetExists, true); assert.equal(result.canCommit, null);
    assert.equal(result.proposedAdds, null); assert.equal(result.advisory, true);
    assert.deepEqual(result.existing, { bots: 2, memories: 3 });
  });
  assert.equal((await stat(database)).mtimeMs, before.mtimeMs); assert.deepEqual(await readdir(fixture), files);
});
await check('stable-source replay reuses mappings without duplicate memory or revision writes', async () => {
  await unchanged(database, async () => {
    const result = cli(input, database, true); assert.equal(result.status, 'unchanged');
    assert.equal(result.counts.botsCreated, 0); assert.equal(result.counts.memoriesCreated, 0); assert.equal(result.counts.memoriesReused, 3);
    assert.equal(result.revisionBefore, result.revisionAfter);
  });
});
await check('same source memory ID with changed content blocks the entire batch', async () => {
  const changed = clone(transfer); changed.archive.memories[0].text += ' changed';
  changed.archive.bots.push(bot('gamma', false, false)); changed.archive.memories.push(memory('77', 'gamma', 'candidate', '1'));
  const file = await writeCase('changed-source', changed), before = hash(await readFile(file));
  const preview = cli(file); assert.equal(preview.canCommit, null); assert.equal(preview.proposedAdds, null);
  await unchanged(database, async () => {
    const result = cli(file, database, true, 3); assert.equal(result.status, 'conflict');
    assert.equal(result.issueCodes.source_record_changed, 1); assert.equal(result.canCommit, false);
  });
  assert.equal(hash(await readFile(file)), before);
  await withCore(async client => { assert.equal(await client.request('bot.get', { botId: 'gamma' }), null); });
});
await check('differing Bot profile is rejected without overwriting native content', async () => {
  const changed = clone(transfer); changed.archive.bots[0].persona += ' changed';
  const file = await writeCase('changed-bot', changed);
  await unchanged(database, async () => { assert.equal(cli(file, database, true, 3).issueCodes.bot_conflict, 1); });
});
await check('unmapped same-text memory with different review metadata is rejected', async () => {
  const changed = clone(transfer); changed.sourceId = 'legacy-another-source'; changed.archive.memories[0].state = 'rejected';
  const file = await writeCase('memory-conflict', changed);
  await unchanged(database, async () => { assert.equal(cli(file, database, true, 3).issueCodes.memory_conflict, 1); });
});
await check('deleting an imported memory leaves a replay tombstone', async () => {
  let removed;
  await withCore(async client => {
    removed = (await client.request('memory.list', { botId: 'alpha', groupId: '' })).find(value => value.text === transfer.archive.memories[0].text);
    await client.request('memory.delete', { memoryId: removed.id, revision: removed.revision });
  });
  const result = cli(input, database, true); assert.equal(result.status, 'unchanged');
  assert.equal(result.counts.memoriesTombstoned, 1); assert.equal(result.counts.memoriesReused, 2); assert.equal(result.counts.memoriesCreated, 0);
  await withCore(async client => { assert.equal(await client.request('memory.get', { memoryId: removed.id }), null); });
});
await check('a second bounded packet can reuse the source namespace and globally distinct IDs', async () => {
  const next = clone(transfer); next.archive.bots = [bot('gamma', false, false)]; next.archive.memories = [memory('78', 'gamma', 'candidate', '1')];
  const file = await writeCase('next-packet', next);
  const result = cli(file, database, true); assert.equal(result.counts.botsCreated, 1); assert.equal(result.counts.memoriesCreated, 1);
  assert.equal(cli(file, database, true).counts.memoriesReused, 1);
});
await check('active native database is rejected until the owning process closes', async () => {
  await withCore(async () => {
    assert.equal(cli(input, database, false, 4).error.code, 'file_busy');
    assert.equal(cli(input, database, true, 4).error.code, 'file_busy');
  });
  await noSidecars(database);
});
await check('sidecars are rejected without cleanup or target changes', async () => {
  const sidecar = database + '-wal'; await writeFile(sidecar, 'synthetic sidecar');
  try {
    await unchanged(database, async () => { assert.equal(cli(input, database, false, 4).error.code, 'target_not_offline'); });
    assert.equal(await readFile(sidecar, 'utf8'), 'synthetic sidecar');
  } finally { await unlink(sidecar); }
});

const invalid = [];
const addInvalid = (name, mutate, code = 'invalid_archive') => { const value = clone(transfer); mutate(value); invalid.push([name, value, code]); };
addInvalid('extra-envelope-attachments', value => { value.attachments = []; }, 'invalid_envelope');
addInvalid('extra-archive-attachments', value => { value.archive.attachments = []; });
addInvalid('missing-source', value => { delete value.sourceId; }, 'invalid_envelope');
addInvalid('wrong-envelope-version', value => { value.version = 2; }, 'invalid_envelope');
addInvalid('native-source', value => { value.sourceId = 'native-0123456789abcdef0123456789abcdef'; }, 'invalid_source');
addInvalid('empty-legacy-source', value => { value.sourceId = 'legacy-'; }, 'invalid_source');
addInvalid('invalid-source', value => { value.sourceId = 'legacy-path/name'; }, 'invalid_source');
addInvalid('empty-conversation', value => { value.archive.conversations = [{ botId: 'alpha', groupId: '', mode: 'chat', messages: [] }]; }, 'unsupported_scope');
addInvalid('message-history', value => { value.archive.conversations = [{ botId: 'alpha', groupId: '', mode: 'chat', messages: [{ id: '1', actor: 'user', text: prefix + 'message', createdAtMs: '0' }] }]; }, 'unsupported_scope');
addInvalid('group-memory', value => { value.archive.memories[0].groupId = 'some-group'; }, 'unsupported_scope');
addInvalid('v2-archive', value => { value.archive.version = 2; value.archive.coverage = 'conversation-and-group-data'; value.archive.groups = []; value.archive.excludedTypes[value.archive.excludedTypes.length - 1] = 'application-settings'; }, 'unsupported_scope');
addInvalid('invalid-int64', value => { value.archive.memories[0].revision = '9223372036854775808'; });
addInvalid('too-many-bots', value => { for (let i = 0; i < 255; ++i) value.archive.bots.push(bot('synthetic-' + i, false, false)); }, 'limit_exceeded');
addInvalid('too-many-memories', value => { value.archive.memories = Array.from({ length: 10001 }, (_, i) => memory(String(i + 1), 'alpha', 'candidate', '1')); }, 'limit_exceeded');
invalid.push(['duplicate-member', JSON.stringify(transfer).replace('{', '{"version":1,'), 'invalid_json']);
invalid.push(['invalid-utf8', Buffer.from([0x7b, 0xff, 0x7d]), 'invalid_json']);
invalid.push(['oversized-input', Buffer.alloc(4 * 1024 * 1024 + 1, 32), 'limit_exceeded']);
for (const [name, value, code] of invalid) await check('reject ' + name + ' before creating a target', async () => {
  const file = await writeCase(name, value), target = path.join(fixture, name + '.sqlite');
  const before = hash(await readFile(file));
  assert.equal(cli(file, target, true, 2).error.code, code); assert.equal(await exists(target), false); await noSidecars(target);
  assert.equal(hash(await readFile(file)), before);
});
await check('source and target paths cannot overlap or occupy a SQLite sidecar', async () => {
  await unchanged(input, async () => { assert.equal(cli(input, input, true, 2).error.code, 'path_conflict'); });
  assert.equal(cli(database + '-wal', database, true, 2).error.code, 'path_conflict');
});
await check('unrelated and empty existing files are never initialized', async () => {
  for (const [name, bytes] of [['unrelated.sqlite', Buffer.from('PRIVATE_TRANSFER_BODY_foreign-file')], ['empty.sqlite', Buffer.alloc(0)]]) {
    const target = path.join(fixture, name); await writeFile(target, bytes);
    await unchanged(target, async () => { assert.equal(cli(input, target, false, 4).error.code, 'invalid_target'); assert.equal(cli(input, target, true, 4).error.code, 'invalid_target'); });
    await noSidecars(target);
  }
});
await check('older native schema is not upgraded by the bridge', async () => {
  const target = path.join(fixture, 'older-native.sqlite'); await copyFile(database, target);
  const bytes = await readFile(target); bytes.writeUInt32BE(3, 60); await writeFile(target, bytes);
  await unchanged(target, async () => { assert.equal(cli(input, target, true, 4).error.code, 'invalid_target'); });
});
await check('hard-linked source and target files are rejected', async () => {
  const linkedInput = path.join(fixture, 'hard-input.json'); await link(input, linkedInput);
  try { assert.equal(cli(linkedInput, database, false, 2).error.code, 'unsafe_path'); } finally { await unlink(linkedInput); }
  const linkedTarget = path.join(fixture, 'hard-target.sqlite'); await link(database, linkedTarget);
  try { assert.equal(cli(input, linkedTarget, true, 2).error.code, 'unsafe_path'); } finally { await unlink(linkedTarget); }
});
await check('directory junctions are rejected for both input and target ancestors', async () => {
  const real = path.join(fixture, 'real'), junction = path.join(fixture, 'junction'); await mkdir(real);
  await symlink(real, junction, 'junction'); await copyFile(input, path.join(real, 'input.json'));
  assert.equal(cli(path.join(junction, 'input.json'), database, false, 2).error.code, 'unsafe_path');
  assert.equal(cli(input, path.join(junction, 'target.sqlite'), true, 2).error.code, 'unsafe_path');
  assert.equal(await exists(path.join(real, 'target.sqlite')), false);
});
await check('target size is bounded before SQLite inspection', async () => {
  const target = path.join(fixture, 'too-large.sqlite'), handle = await open(target, 'wx');
  try { await handle.truncate(64 * 1024 * 1024 + 1); } finally { await handle.close(); }
  assert.equal(cli(input, target, false, 2).error.code, 'limit_exceeded');
});
await check('original normalized input remains byte-identical after all operations', async () => { assert.equal(hash(await readFile(input)), sourceHash); });
const report = { passed: checks.length, checks, productionDataUsed: false, modelRequests: 0, httpRequests: 0, sourceUnchanged: true };
await writeFile(path.join(fixture, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
