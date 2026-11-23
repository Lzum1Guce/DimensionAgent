// Synthetic-only verification for the one-time Bot/persona/memory extractor.
// This file never reads user character data or launches any native executable.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const project = path.resolve(import.meta.dirname, '..');
const extractor = path.join(project, 'tools/extract-bot-memory.mjs');
const output = path.join(project, 'outputs/bot-memory-extractor-tests', new Date().toISOString().replace(/[:.]/g, '-'));
const execFileAsync = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
const checks = [], failures = [], rejected = [], artifacts = [], cliCalls = [];
const PERSONA = ['SELF.md', 'PERSONALITY.md', 'PREFERENCES.md', 'SPEECH.md', 'CRAFT.md', 'CONSTITUTION.md', 'PARTNER.md'];
const excluded = ['work-runs', 'tool-receipts', 'message-receipts', 'artifacts', 'plugins', 'accounts', 'provider-settings', 'group-metadata'];
let sequence = 0;
assert(/^[Ll]:[\\/]/.test(output));
await fs.mkdir(path.join(output, 'temp'), { recursive: true });
const extractorBefore = hash(await fs.readFile(extractor));
const { extractBotMemory } = await import(pathToFileURL(extractor).href + '?verification=' + extractorBefore);
const env = { ...process.env, TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp') };
const jsonBytes = value => Buffer.from(JSON.stringify(value), 'utf8');
const fact = (id, status = 'confirmed', extras = {}) => ({ id, characterId: 'alpha', text: 'SYNTH_FACT_' + id + ' 中文🙂', status, ...extras });
const mid = (id, status = 'active', extras = {}) => ({ schemaVersion: 1, id, characterId: 'alpha', status, summary: 'SYNTH_MID_' + id + ' 中文🙂', openLoops: ['SYNTH_OPEN_LOOP'], entities: ['SYNTH_ENTITY'], ...extras });
async function exists(file) { try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function within(parent, file) { const rel = path.relative(parent, file); assert(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'Synthetic path must stay in its owned directory'); }
async function check(name, run) {
    try { await run(); checks.push(name); console.log('PASS ' + name); }
    catch (error) { failures.push({ name, error: error.stack }); console.error('FAIL ' + name + ': ' + error.message); }
}
async function fixture(label, botIds = ['alpha']) {
    const root = path.join(output, String(++sequence).padStart(3, '0') + '-' + label);
    const characters = path.join(root, 'characters'), roster = path.join(root, 'roster.json'), target = path.join(root, 'export');
    await fs.mkdir(characters, { recursive: true });
    const value = { root, characters, roster, output: target, files: new Map(), botIds };
    value.put = async (relative, data, scoped = true) => {
        const file = path.join(characters, relative); within(characters, file);
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
        await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes);
        if (scoped) value.files.set(relative.replaceAll(path.sep, '/'), bytes);
        return file;
    };
    value.character = (id, extras = {}) => value.put(id + '/character.json', JSON.stringify({ version: 1, id, name: 'Synthetic ' + id, role: 'SYNTH_ROLE_' + id + ' 中文🙂', ...extras }));
    value.note = (name, bytes, scoped = true) => value.put('alpha/workspace/notes/' + name, bytes, scoped);
    value.rosterWrite = async rosterValue => { value.rosterBytes = jsonBytes(rosterValue); await fs.writeFile(roster, value.rosterBytes); };
    for (const id of botIds) await value.character(id);
    await value.rosterWrite({ version: 1, chatBots: botIds.slice(0, 1), workBots: botIds.slice(0, 1) });
    return value;
}
async function completeManifest(folder) {
    try { const value = JSON.parse(await fs.readFile(path.join(folder, 'manifest.json'), 'utf8')); return value.complete === true; }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
}
async function rejectExtraction(fx, codes, change, target = fx.output) {
    let caught;
    try { await extractBotMemory({ characters: fx.characters, roster: fx.roster, output: target, ...(change ? { afterRead: change } : {}) }); }
    catch (error) { caught = error; }
    assert(caught, 'Expected extractor rejection');
    if (codes) assert((Array.isArray(codes) ? codes : [codes]).includes(caught.code), 'Unexpected rejection code: ' + caught.code);
    assert.equal(await completeManifest(target), false, 'Failure must not publish a complete manifest');
    rejected.push({ fixture: path.basename(fx.root), code: caught.code }); return caught;
}
async function cli(fx, args) {
    const argv = args || ['--characters', fx.characters, '--roster', fx.roster, '--output', fx.output];
    let result, status = 0;
    try { result = await execFileAsync(process.execPath, [extractor, ...argv], { cwd: output, windowsHide: true, env, timeout: 30000, maxBuffer: 1024 * 1024 }); }
    catch (error) { assert.equal(typeof error.code, 'number', 'CLI must return an ordinary exit status'); status = error.code; result = error; }
    assert.equal(result.stderr.trim(), '', 'CLI must not echo source data or stack traces');
    const value = JSON.parse(result.stdout.trim()); assert(!result.stdout.includes('SYNTH_'));
    cliCalls.push({ fixture: path.basename(fx.root), exitCode: status, result: value }); return { status, value };
}
async function filesUnder(folder, prefix = '') {
    const files = [];
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        assert(!entry.isSymbolicLink()); const relative = prefix + entry.name;
        if (entry.isDirectory()) files.push(...await filesUnder(path.join(folder, entry.name), relative + '/'));
        else { assert(entry.isFile()); files.push(relative); }
    }
    return files.sort();
}
async function verify(fx, folder = fx.output) {
    const manifest = JSON.parse(await fs.readFile(path.join(folder, 'manifest.json'), 'utf8'));
    assert.equal(manifest.format, 'dimension-bot-memory-migration-manifest'); assert.equal(manifest.version, 1); assert.equal(manifest.complete, true);
    assert.equal(manifest.coverage, 'bot-personas-and-memories-only'); assert.equal(manifest.snapshot, 'two-pass-stable-files-not-cross-file-transaction');
    assert.match(manifest.sourceId, /^legacy-[0-9a-f]{32}$/);
    assert.deepEqual(manifest.sourceFiles.map(row => row.path).sort(), [...fx.files.keys()].sort());
    assert.equal(manifest.sourceRosterSha256, hash(fx.rosterBytes));
    assert.deepEqual(await fs.readFile(path.join(folder, 'source-snapshot/roster.json')), fx.rosterBytes);
    for (const row of manifest.sourceFiles) {
        const expected = fx.files.get(row.path), bytes = await fs.readFile(path.join(folder, 'source-snapshot', row.path));
        assert.deepEqual(bytes, expected); assert.deepEqual(await fs.readFile(path.join(fx.characters, row.path)), expected, 'Extraction must not change the source');
        assert.equal(row.bytes, expected.length); assert.equal(row.sha256, hash(expected));
    }
    const snapshotFiles = await filesUnder(path.join(folder, 'source-snapshot'));
    assert.deepEqual(snapshotFiles, [...fx.files.keys(), 'roster.json'].sort(), 'Snapshot must contain only explicitly scoped source files and roster');
    const envelopes = [], bots = [], memories = [], packageBytes = [];
    for (const [index, row] of manifest.packages.entries()) {
        assert.equal(row.path, 'packages/part-' + String(index + 1).padStart(3, '0') + '.json');
        const bytes = await fs.readFile(path.join(folder, row.path)); assert.equal(bytes.length, row.bytes); assert.equal(hash(bytes), row.sha256); assert(bytes.length <= 4 * 1024 * 1024);
        const envelope = JSON.parse(bytes.toString('utf8')); assert.deepEqual(Object.keys(envelope).sort(), ['archive', 'format', 'sourceId', 'version']);
        assert.equal(envelope.format, 'dimension-bot-memory-transfer'); assert.equal(envelope.version, 1); assert.equal(envelope.sourceId, manifest.sourceId);
        const archive = envelope.archive;
        assert.deepEqual(Object.keys(archive).sort(), ['bots', 'conversations', 'coverage', 'excludedTypes', 'format', 'memories', 'version']);
        assert.equal(archive.format, 'dimension-conversation-archive'); assert.equal(archive.version, 1); assert.equal(archive.coverage, 'conversation-data-only');
        assert.deepEqual([...archive.excludedTypes].sort(), [...excluded].sort()); assert.deepEqual(archive.conversations, []);
        assert(archive.bots.length >= 1 && archive.bots.length <= 128);
        const botIds = new Set(archive.bots.map(bot => bot.id));
        for (const bot of archive.bots) { assert.deepEqual(Object.keys(bot).sort(), ['id', 'inChat', 'inWork', 'name', 'persona']); assert.equal(typeof bot.inChat, 'boolean'); assert.equal(typeof bot.inWork, 'boolean'); }
        for (const memory of archive.memories) {
            assert.deepEqual(Object.keys(memory).sort(), ['botId', 'groupId', 'id', 'revision', 'sourceActor', 'state', 'text']); assert(botIds.has(memory.botId));
            assert.match(memory.id, /^[1-9]\d*$/); assert(BigInt(memory.id) <= 9223372036854775807n); assert.equal(memory.groupId, ''); assert.equal(memory.revision, '1'); assert.equal(memory.sourceActor, 'user');
            assert(['confirmed', 'candidate', 'rejected'].includes(memory.state)); assert(memory.text.trim());
        }
        envelopes.push(envelope); bots.push(...archive.bots); memories.push(...archive.memories); packageBytes.push(bytes);
    }
    assert.equal(bots.length, manifest.bots); assert.equal(memories.length, manifest.memories); assert.equal(new Set(bots.map(row => row.id)).size, bots.length); assert.equal(new Set(memories.map(row => row.id)).size, memories.length);
    assert.equal(manifest.chatBots, bots.filter(row => row.inChat).length); assert.equal(manifest.workBots, bots.filter(row => row.inWork).length);
    for (const state of ['confirmed', 'candidate', 'rejected']) assert.equal(manifest.counts[state], memories.filter(row => row.state === state).length);
    const sourceRecords = new Map(manifest.sourceRecords.map(row => [row.botId + '|' + row.sourceKey, row]));
    assert.equal(sourceRecords.size, memories.length);
    for (const row of manifest.sourceRecords) { assert(memories.some(memory => memory.id === row.id && memory.botId === row.botId && memory.state === row.state)); for (const file of row.files) assert(fx.files.has(file)); }
    artifacts.push({ directory: folder, manifestSha256: hash(await fs.readFile(path.join(folder, 'manifest.json'))), bots: bots.length, memories: memories.length, packages: manifest.packages.length });
    return { manifest, envelopes, bots, memories, sourceRecords, packageBytes };
}

await check('CLI exports all personas, independent rosters and exact scoped source bytes while excluding history, attachments and runtime state', async () => {
    const fx = await fixture('scope', ['alpha', 'beta', 'gamma']);
    await fx.character('alpha', { createdAt: '2020-01-01', updatedAt: '2021-01-01', program: { marker: 'EXCLUDED_PROGRAM_METADATA' }, architecture: 'EXCLUDED_ARCHITECTURE' });
    const rawCharacter = fx.files.get('alpha/character.json'); await fx.put('alpha/character.json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), rawCharacter]));
    for (const filename of PERSONA) await fx.put('alpha/workspace/' + filename, 'SYNTH_PERSONA_' + filename + '\r\n中文🙂\r\n');
    for (const name of ['profile.md', 'people.md', 'bots.md', 'todo.md']) await fx.note(name, 'SYNTH_NOTE_' + name + '\r\n中文🙂\r\n');
    await fx.note('empty.md', ' \r\n\t');
    await fs.mkdir(path.join(fx.characters, 'alpha/workspace/notes/mid-pending'), { recursive: true });
    for (const relative of ['alpha/workspace/notes-backup/old.md', 'alpha/workspace/blobs/attachment.bin', 'alpha/workspace/sessions/history.json', 'alpha/workspace/prompts/system.md', 'alpha/workspace/runtime-state.json', 'alpha/program/runtime.mjs', 'alpha/workspace/notes/state.json'])
        await fx.put(relative, 'EXCLUDED_SYNTH_' + relative, false);
    await fx.rosterWrite({ version: 1, chatBots: ['alpha', 'ghost'], workBots: ['beta', 'ghost'] });
    const run = await cli(fx); assert.equal(run.status, 0); assert.equal(run.value.ok, true);
    const result = await verify(fx); assert.equal(result.bots.length, 3); assert.equal(result.memories.length, 5); assert.deepEqual(result.manifest.danglingRosterIds, ['ghost']);
    assert.deepEqual(result.bots.map(row => [row.id, row.inChat, row.inWork]), [['alpha', true, false], ['beta', false, true], ['gamma', false, false]]);
    const persona = result.bots[0].persona; assert(persona.includes('SYNTH_ROLE_alpha')); for (const filename of PERSONA.filter(name => name !== 'PARTNER.md')) assert(persona.includes('SYNTH_PERSONA_' + filename));
    assert(!persona.includes('SYNTH_PERSONA_PARTNER.md'), 'User relationship must not become the Bot persona');
    const typedNotes = [['user-relationship', 'SYNTH_PERSONA_PARTNER.md'], ['user-profile', 'SYNTH_NOTE_profile.md'], ['contacts', 'SYNTH_NOTE_people.md'], ['external-bots', 'SYNTH_NOTE_bots.md']];
    for (const [type, content] of typedNotes) {
        const record = result.sourceRecords.get('alpha|relation/' + type); assert(record && record.state === 'confirmed');
        const memory = result.memories.find(row => row.id === record.id); assert(memory.text.startsWith('@dimension-note/v1/' + type + '\n')); assert(memory.text.includes(content)); assert(!persona.includes(content));
    }
    assert.equal(result.manifest.counts.confirmed, 4); assert.equal(result.manifest.counts.candidate, 1); assert.equal(result.manifest.counts.emptyFiles, 1); assert.equal(result.manifest.counts.relationNotes, 4);
    for (const bytes of result.packageBytes) assert(!bytes.toString('utf8').includes('EXCLUDED_'));
});
await check('Known character-biography template becomes persona and never masquerades as user profile memory', async () => {
    const fx = await fixture('character-biography');
    const biography = '# Synthetic alpha\r\n\r\n- 日文名：合成角色\r\n- 英文名: Synthetic Alpha\r\n- 出处：合成故事\r\n- 角色库热度排名：123\r\n';
    const partner = 'SYNTH_USER_RELATIONSHIP_ONLY';
    await fx.note('profile.md', biography); await fx.put('alpha/workspace/PARTNER.md', partner);
    await extractBotMemory(fx); const result = await verify(fx);
    assert(result.bots[0].persona.includes(biography)); assert(!result.bots[0].persona.includes(partner));
    assert.equal(result.manifest.counts.characterProfilesMovedToPersona, 1); assert.equal(result.memories.length, 1); assert.equal(result.manifest.counts.relationNotes, 1);
    assert(!result.sourceRecords.has('alpha|relation/user-profile'));
    assert.equal(result.memories[0].text, '@dimension-note/v1/user-relationship\n' + partner);
    assert(!result.memories.some(row => row.text.includes('角色库热度排名')));
});
await check('Near-match or genuine user profiles remain typed user notes without heuristic reassignment to the Bot', async () => {
    const cases = [
        '# Somebody else\n- 日文名：合成人物\n- 出处：合成故事\n- 角色库热度排名：1',
        '# Synthetic alpha\n- 日文名：合成人物\n- 出处：合成故事\n- 角色库热度排名：1\n用户额外说明：SYNTH_USER_DETAIL',
        '# Synthetic alpha\n- 日文名：合成人物\n- 英文名：Alpha\n- 出处：合成故事',
        'SYNTH_USER_PROFILE：用户喜欢清晰简短的解释。'
    ];
    for (const [index, profileText] of cases.entries()) {
        const fx = await fixture('near-profile-' + index); await fx.note('profile.md', profileText);
        await extractBotMemory(fx); const result = await verify(fx);
        assert.equal(result.manifest.counts.characterProfilesMovedToPersona, 0); assert.equal(result.memories.length, 1);
        assert.equal(result.memories[0].text, '@dimension-note/v1/user-profile\n' + profileText);
        assert(!result.bots[0].persona.includes(profileText)); assert.equal(result.memories[0].state, 'confirmed');
    }
});
await check('Empty relationship, profile, contacts and external-Bot notes create no fake memory', async () => {
    const fx = await fixture('empty-relation-notes');
    await fx.put('alpha/workspace/PARTNER.md', ' \r\n\t'); for (const filename of ['profile.md', 'people.md', 'bots.md']) await fx.note(filename, '\r\n \t');
    await extractBotMemory(fx); const result = await verify(fx);
    assert.equal(result.memories.length, 0); assert.equal(result.manifest.counts.relationNotes, 0); assert.equal(result.manifest.counts.characterProfilesMovedToPersona, 0); assert(!result.bots[0].persona.includes('@dimension-note/'));
});
await check('Declared affectExpression is retained as Bot persona instead of user relationship data', async () => {
    const fx = await fixture('affect-expression'); await fx.character('alpha', { affectExpression: 'SYNTH_AFFECT_温和且简洁' });
    await extractBotMemory(fx); const result = await verify(fx); assert(result.bots[0].persona.includes('SYNTH_AFFECT_温和且简洁')); assert.equal(result.memories.length, 0);
});
await check('Fact/mid states and expiry are preserved for review; canonical JSONL and mid-directory mirrors deduplicate without losing locators', async () => {
    const fx = await fixture('states-and-mirrors'), expected = new Map();
    const facts = ['confirmed', 'accepted', 'active', 'candidate', 'pending', 'rejected', 'archived', 'superseded', 'deleted'].map(state => {
        expected.set('fact/f-' + state, ['confirmed', 'accepted', 'active'].includes(state) ? 'confirmed' : ['candidate', 'pending'].includes(state) ? 'candidate' : 'rejected'); return fact('f-' + state, state);
    });
    facts.push(fact('past-expiry', 'confirmed', { expiresAt: '2000-01-01T00:00:00Z' }), fact('future-expiry', 'confirmed', { expiresAt: '2099-01-01T00:00:00Z' }));
    expected.set('fact/past-expiry', 'candidate'); expected.set('fact/future-expiry', 'candidate');
    const mids = ['active', 'candidate', 'pending', 'confirmed', 'rejected', 'archived', 'superseded', 'deleted'].map(state => {
        expected.set('mid/m-' + state, ['active', 'candidate', 'pending', 'confirmed'].includes(state) ? 'candidate' : 'rejected');
        return mid('m-' + state, state, { expiresAt: '2000-01-01T00:00:00Z', sourceRefs: ['synthetic-record-ref'] });
    });
    await fx.note('deep.jsonl', facts.map(JSON.stringify).join('\n') + '\n');
    await fx.note('candidates.jsonl', JSON.stringify(facts[0]) + '\n');
    await fx.note('mid.entries.jsonl', mids.map(JSON.stringify).join('\n') + '\n');
    const mirror = Object.fromEntries(Object.entries(mids[0]).reverse());
    await fx.note('mid-entries/m-active.json', JSON.stringify(mirror));
    await fx.note('mid-pending/m-active.json', JSON.stringify(mids[0]));
    await extractBotMemory(fx); const result = await verify(fx); assert.equal(result.memories.length, expected.size);
    for (const [key, state] of expected) assert.equal(result.sourceRecords.get('alpha|' + key)?.state, state);
    assert.equal(result.manifest.counts.mirrorCopiesDeduplicated, 3);
    assert.equal(result.sourceRecords.get('alpha|mid/m-active').files.length, 3); assert.equal(result.manifest.counts.temporaryMemoriesHeldForReview, 4);
    assert(result.memories.some(row => row.text.includes('SYNTH_OPEN_LOOP') && row.text.includes('SYNTH_ENTITY')));
});
await check('Mid v3 preserves reinforcement/recall/TTL metadata in source bytes and deduplicates mirrors while active remains candidate and archived remains rejected', async () => {
    const fx = await fixture('mid-version-3');
    const metadata = {
        schemaVersion: 3, sourceRefs: ['SYNTH_V3_SOURCE_REFERENCE'],
        startAt: '1999-12-30T00:00:00Z', lastActive: '1999-12-31T00:00:00Z',
        stabilityMs: 86400000, expiresAt: '2000-01-01T00:00:00Z',
        recallCount: 7, importance: 0.75, compressor: 'SYNTH_V3_COMPRESSOR',
        contentHash: 'a'.repeat(64), lastRecalledAt: '1999-12-31T08:00:00Z',
        lastReinforcedAt: '1999-12-31T09:00:00Z', reinforcementCount: 3
    };
    const active = mid('v3-active', 'active', metadata), archived = mid('v3-archived', 'archived', metadata);
    await fx.note('mid.entries.jsonl', JSON.stringify(active) + '\r\n' + JSON.stringify(archived) + '\r\n');
    await fx.note('mid.jsonl', JSON.stringify(Object.fromEntries(Object.entries(active).reverse())) + '\n');
    await fx.note('mid-entries/v3-active.json', JSON.stringify(active, null, 2));
    await extractBotMemory(fx); const result = await verify(fx);
    assert.equal(result.memories.length, 2); assert.equal(result.manifest.counts.mirrorCopiesDeduplicated, 2);
    assert.equal(result.manifest.counts.temporaryMemoriesHeldForReview, 1);
    assert.equal(result.manifest.counts.confirmed, 0); assert.equal(result.manifest.counts.candidate, 1); assert.equal(result.manifest.counts.rejected, 1);
    const activeSource = result.sourceRecords.get('alpha|mid/v3-active'), archivedSource = result.sourceRecords.get('alpha|mid/v3-archived');
    assert.equal(activeSource.state, 'candidate'); assert.equal(activeSource.files.length, 3); assert.equal(archivedSource.state, 'rejected');
    const activeMemory = result.memories.find(row => row.id === activeSource.id);
    assert(activeMemory.text.includes(active.summary) && activeMemory.text.includes('SYNTH_OPEN_LOOP') && activeMemory.text.includes('SYNTH_ENTITY'));
    assert(!activeMemory.text.includes('SYNTH_V3_SOURCE_REFERENCE') && !activeMemory.text.includes('SYNTH_V3_COMPRESSOR'));
    const savedMirror = JSON.parse(await fs.readFile(path.join(fx.output, 'source-snapshot/alpha/workspace/notes/mid-entries/v3-active.json'), 'utf8'));
    assert.deepEqual(savedMirror, active);
    assert.equal(savedMirror.reinforcementCount, 3); assert.equal(savedMirror.recallCount, 7); assert.equal(savedMirror.expiresAt, metadata.expiresAt);
});
await check('Stable source and record IDs survive record reordering, added files/Bots, roster changes and repeated extraction', async () => {
    const fx = await fixture('stable-identities'); const firstRows = [fact('one'), fact('two', 'candidate')];
    await fx.note('deep.jsonl', firstRows.map(JSON.stringify).join('\n')); await fx.note('z.md', 'SYNTH_STABLE_NOTE');
    await fx.put('alpha/workspace/PARTNER.md', 'SYNTH_STABLE_RELATIONSHIP'); await fx.note('profile.md', 'SYNTH_STABLE_USER_PROFILE');
    await extractBotMemory(fx); const first = await verify(fx);
    await fx.note('deep.jsonl', [firstRows[1], fact('three'), firstRows[0]].map(JSON.stringify).join('\n'));
    await fx.note('a.md', 'SYNTH_NEW_EARLY_NOTE'); await fx.character('aardvark'); await fx.rosterWrite({ version: 1, chatBots: ['aardvark'], workBots: ['alpha'] });
    const secondDir = path.join(fx.root, 'export-2'); await extractBotMemory({ ...fx, output: secondDir }); const second = await verify(fx, secondDir);
    assert.equal(second.manifest.sourceId, first.manifest.sourceId);
    for (const [key, row] of first.sourceRecords) assert.equal(second.sourceRecords.get(key)?.id, row.id);
    const thirdDir = path.join(fx.root, 'export-3'); await extractBotMemory({ ...fx, characters: fx.characters.toLowerCase(), output: thirdDir }); const third = await verify(fx, thirdDir);
    assert.equal(third.manifest.sourceId, first.manifest.sourceId); assert.deepEqual(third.packageBytes, second.packageBytes);
});
await check('More than 256 characters split into lossless packages of at most 128 Bots', async () => {
    const ids = Array.from({ length: 260 }, (_, i) => 'bot-' + String(i).padStart(4, '0')), fx = await fixture('260-bots', ids);
    await fx.rosterWrite({ version: 1, chatBots: ids.filter((_, i) => i % 2 === 0), workBots: ids.filter((_, i) => i % 3 === 0) });
    const run = await cli(fx); assert.equal(run.status, 0); const result = await verify(fx);
    assert.deepEqual(result.envelopes.map(row => row.archive.bots.length), [128, 128, 4]); assert.deepEqual(result.bots.map(row => row.id).sort(), ids); assert.equal(result.memories.length, 0);
});
await check('Byte limit splits packages below 4 MiB before the Bot count limit', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => 'large-' + String(i).padStart(2, '0')), fx = await fixture('byte-split', ids);
    for (const id of ids) await fx.put(id + '/workspace/SELF.md', 'SYNTH_PERSONA_' + 'x'.repeat(220000));
    await extractBotMemory(fx); const result = await verify(fx); assert(result.envelopes.length > 1); assert.equal(result.bots.length, 20); assert(result.envelopes.every(row => row.archive.bots.length < 128));
});
await check('Conflicting same-family IDs reject the entire batch instead of choosing one mirrored record', async () => {
    const fx = await fixture('mirror-conflict'); await fx.note('mid.entries.jsonl', JSON.stringify(mid('shared'))); await fx.note('mid-entries/shared.json', JSON.stringify(mid('shared', 'active', { summary: 'SYNTH_DIFFERENT' })));
    await rejectExtraction(fx, 'MEMORY_MIRROR_CONFLICT');
});
await check('A per-file invalid record cannot become valid merely because an earlier JSONL mirror was accepted', async () => {
    const fx = await fixture('mirror-validation-order'), row = fact('missing-state'); delete row.status;
    await fx.note('candidates.jsonl', JSON.stringify(row)); await fx.note('deep.jsonl', JSON.stringify(row)); await rejectExtraction(fx, 'UNKNOWN_MEMORY_STATE');
});

const malformedCases = [
    ['character-unknown-field', 'UNSUPPORTED_CHARACTER_FIELD', fx => fx.character('alpha', { unrecognizedSemantics: true })],
    ['character-version', 'INVALID_CHARACTER', fx => fx.character('alpha', { version: 2 })],
    ['character-id-traversal', 'INVALID_CHARACTER', fx => fx.character('alpha', { id: '../escape' })],
    ['character-duplicate', 'DUPLICATE_JSON_KEY', fx => fx.put('alpha/character.json', '{"version":1,"id":"alpha","name":"one","\\u006eame":"two","role":"SYNTH_ROLE"}')],
    ['nested-duplicate', 'DUPLICATE_JSON_KEY', fx => fx.put('alpha/character.json', '{"version":1,"id":"alpha","name":"Synthetic alpha","role":"SYNTH_ROLE","program":{"nested":{"a":1,"\\u0061":2}}}')],
    ['json-depth', 'JSON_DEPTH', fx => { let nested = 0; for (let i = 0; i < 70; i++) nested = [nested]; return fx.character('alpha', { program: nested }); }],
    ['invalid-bot-directory', 'INVALID_BOT_DIRECTORY', fx => fx.character('bad_name')],
    ['character-lone-surrogate', 'INVALID_UNICODE', fx => fx.character('alpha', { role: 'SYNTH_BAD_\ud800' })],
    ['memory-lone-surrogate', 'INVALID_UNICODE', fx => fx.note('deep.jsonl', JSON.stringify(fact('unicode', 'confirmed', { text: 'SYNTH_BAD_\udc00' })))],
    ['nested-key-lone-surrogate', 'INVALID_UNICODE', fx => fx.character('alpha', { program: { ['\ud800']: 'SYNTH_VALUE' } })],
    ['affect-expression-empty', 'INVALID_AFFECT_EXPRESSION', fx => fx.character('alpha', { affectExpression: ' \t' })],
    ['affect-expression-type', 'INVALID_AFFECT_EXPRESSION', fx => fx.character('alpha', { affectExpression: { text: 'SYNTH_WRONG_TYPE' } })],
    ['character-invalid-utf8', 'INVALID_UTF8', fx => fx.put('alpha/character.json', Buffer.from([0x7b, 0xff, 0x7d]))],
    ['persona-invalid-utf8', 'INVALID_UTF8', fx => fx.put('alpha/workspace/SELF.md', Buffer.from([0xc0, 0xaf]))],
    ['memory-invalid-utf8', 'INVALID_UTF8', fx => fx.note('deep.jsonl', Buffer.from([0xed, 0xa0, 0x80]))],
    ['memory-duplicate', 'DUPLICATE_JSON_KEY', fx => fx.note('deep.jsonl', '{"id":"dup","characterId":"alpha","text":"SYNTH_A","text":"SYNTH_B","status":"confirmed"}')],
    ['roster-duplicate-key', 'DUPLICATE_JSON_KEY', async fx => { fx.rosterBytes = Buffer.from('{"version":1,"chatBots":[],"workBots":[],"workBots":["alpha"]}'); await fs.writeFile(fx.roster, fx.rosterBytes); }],
    ['roster-duplicate-id', 'INVALID_ROSTER', fx => fx.rosterWrite({ version: 1, chatBots: ['alpha', 'alpha'], workBots: [] })],
    ['roster-traversal', 'INVALID_ROSTER', fx => fx.rosterWrite({ version: 1, chatBots: ['../escape'], workBots: [] })],
    ['roster-unknown-field', 'INVALID_ROSTER', fx => fx.rosterWrite({ version: 1, chatBots: [], workBots: [], groups: [] })],
    ['unknown-note-file', 'UNSUPPORTED_NOTE_FILE', fx => fx.note('unknown-format.json', '{"important":"SYNTH_MUST_NOT_DISAPPEAR"}')],
    ['unknown-note-directory', 'UNSUPPORTED_NOTE_FILE', fx => fx.note('unknown-subtree/entry.md', 'SYNTH_MUST_NOT_DISAPPEAR')],
    ['fact-unknown-state', 'UNKNOWN_MEMORY_STATE', fx => fx.note('deep.jsonl', JSON.stringify(fact('expired', 'expired')))],
    ['fact-unknown-version', 'UNSUPPORTED_MEMORY_VERSION', fx => fx.note('deep.jsonl', JSON.stringify(fact('version', 'confirmed', { schemaVersion: 2 })))],
    ['fact-unknown-field', 'UNSUPPORTED_MEMORY_FIELD', fx => fx.note('deep.jsonl', JSON.stringify(fact('unknown', 'confirmed', { unknownSemantic: true })))],
    ['fact-group-scope', 'UNSUPPORTED_MEMORY_FIELD', fx => fx.note('deep.jsonl', JSON.stringify(fact('group', 'confirmed', { groupId: 'other-group' })))],
    ['fact-bad-expiry', 'INVALID_MEMORY_EXPIRY', fx => fx.note('deep.jsonl', JSON.stringify(fact('expiry', 'confirmed', { expiresAt: 'not-a-date' })))],
    ['fact-wrong-owner', 'MEMORY_OWNER_MISMATCH', fx => fx.note('deep.jsonl', JSON.stringify(fact('owner', 'confirmed', { characterId: 'beta' })))],
    ['mid-version', 'UNSUPPORTED_MEMORY_VERSION', fx => fx.note('mid.jsonl', JSON.stringify(mid('version', 'active', { schemaVersion: 2 })))],
    ['mid-version-4', 'UNSUPPORTED_MEMORY_VERSION', fx => fx.note('mid.jsonl', JSON.stringify(mid('version', 'active', { schemaVersion: 4 })))],
    ['mid-unknown-field', 'UNSUPPORTED_MEMORY_FIELD', fx => fx.note('mid.jsonl', JSON.stringify(mid('unknown', 'active', { unknownSemantic: true })))],
    ['mid-bad-detail', 'UNSUPPORTED_MEMORY_DETAIL', fx => fx.note('mid.jsonl', JSON.stringify(mid('detail', 'active', { openLoops: [42] })))],
    ['mid-filename-id', 'MEMORY_FILENAME_MISMATCH', fx => fx.note('mid-entries/wrong.json', JSON.stringify(mid('right')))],
    ['jsonl-malformed-line', 'INVALID_JSON', fx => fx.note('deep.jsonl', JSON.stringify(fact('valid')) + '\n{"not-closed":')],
    ['nul-persona', 'PERSONA_LIMIT', fx => fx.put('alpha/workspace/SELF.md', 'SYNTH_BEFORE\0AFTER')],
    ['nul-memory', 'MEMORY_TEXT_LIMIT', fx => fx.note('profile.md', 'SYNTH_BEFORE\0AFTER')],
    ['file-size', 'FILE_LIMIT', fx => fx.put('alpha/workspace/SELF.md', Buffer.alloc(1024 * 1024 + 1, 120))],
    ['persona-size', 'PERSONA_LIMIT', fx => fx.put('alpha/workspace/SELF.md', 'x'.repeat(262144))],
    ['memory-size', 'MEMORY_TEXT_LIMIT', fx => fx.note('profile.md', 'x'.repeat(262144))]
];
for (const [label, code, prepare] of malformedCases) await check('Strict input rejection: ' + label, async () => { const fx = await fixture(label); await prepare(fx); await rejectExtraction(fx, code); });

await check('Oversized single-Bot memory data fails instead of splitting or silently dropping that Bot', async () => {
    const fx = await fixture('oversized-single-bot');
    for (let i = 0; i < 18; i++) await fx.note('large-' + i + '.md', 'x'.repeat(240000));
    await rejectExtraction(fx, 'SINGLE_BOT_PACKAGE_LIMIT');
});
await check('Reparse paths in source roots, Bot directories, notes and output parents are rejected', async () => {
    for (const kind of ['source-root', 'bot-directory', 'notes', 'output-parent']) {
        const fx = await fixture('junction-' + kind), destination = path.join(fx.root, 'junction-target'); await fs.mkdir(destination);
        let link;
        if (kind === 'source-root') { link = path.join(fx.root, 'characters-link'); await fs.symlink(fx.characters, link, 'junction'); fx.characters = link; }
        else if (kind === 'bot-directory') { link = path.join(fx.characters, 'linked-bot'); await fs.symlink(destination, link, 'junction'); }
        else if (kind === 'notes') { link = path.join(fx.characters, 'alpha/workspace/notes'); await fs.mkdir(path.dirname(link), { recursive: true }); await fs.symlink(destination, link, 'junction'); }
        else { link = path.join(fx.root, 'output-link'); await fs.symlink(destination, link, 'junction'); fx.output = path.join(link, 'export'); }
        try { await rejectExtraction(fx, 'REPARSE_PATH'); assert.equal(await completeManifest(path.join(destination, 'export')), false); }
        finally { if ((await fs.lstat(link)).isSymbolicLink()) await fs.unlink(link); }
    }
});
await check('An output parent changed to a junction after source reads cannot redirect publication', async () => {
    const fx = await fixture('output-parent-race'), parent = path.join(fx.root, 'output-parent'), destination = path.join(fx.root, 'redirect-target');
    await fs.mkdir(parent); await fs.mkdir(destination); fx.output = path.join(parent, 'export');
    within(fx.root, parent); within(fx.root, destination);
    try {
        await rejectExtraction(fx, 'REPARSE_PATH', async () => { await fs.rmdir(parent); await fs.symlink(destination, parent, 'junction'); });
        assert.equal(await completeManifest(path.join(destination, 'export')), false);
    } finally { if ((await fs.lstat(parent)).isSymbolicLink()) await fs.unlink(parent); }
});
await check('Second pass rejects changed bytes, added files, deleted files and changed roster without a manifest', async () => {
    for (const kind of ['bytes', 'added-file', 'deleted-file', 'roster']) {
        const fx = await fixture('changed-' + kind); await fx.note('profile.md', 'SYNTH_ORIGINAL');
        await rejectExtraction(fx, kind === 'deleted-file' ? ['SOURCE_CHANGED', 'ENOENT'] : 'SOURCE_CHANGED', async () => {
            if (kind === 'bytes') await fs.writeFile(path.join(fx.characters, 'alpha/workspace/notes/profile.md'), 'SYNTH_CHANGED');
            if (kind === 'added-file') await fs.writeFile(path.join(fx.characters, 'alpha/workspace/notes/added.md'), 'SYNTH_ADDED');
            if (kind === 'deleted-file') await fs.unlink(path.join(fx.characters, 'alpha/workspace/notes/profile.md'));
            if (kind === 'roster') await fs.writeFile(fx.roster, JSON.stringify({ version: 1, chatBots: [], workBots: ['alpha'] }));
        });
    }
});
await check('An existing output is never overwritten and output inside the source is rejected', async () => {
    const fx = await fixture('no-overwrite'); await fs.mkdir(fx.output); const sentinel = Buffer.from('SYNTH_EXISTING_OUTPUT');
    await fs.writeFile(path.join(fx.output, 'manifest.json'), sentinel);
    const run = await cli(fx); assert.equal(run.status, 1); assert.equal(run.value.code, 'OUTPUT_EXISTS'); assert.deepEqual(await fs.readFile(path.join(fx.output, 'manifest.json')), sentinel);
    await rejectExtraction(fx, 'OUTPUT_INSIDE_SOURCE', undefined, path.join(fx.characters, 'export'));
});
await check('CLI rejects duplicate/unknown/relative arguments without executing hooks or publishing outputs', async () => {
    for (const kind of ['duplicate', 'hook', 'relative']) {
        const fx = await fixture('cli-' + kind), args = ['--characters', kind === 'relative' ? 'characters' : fx.characters, '--roster', fx.roster, '--output', fx.output];
        if (kind === 'duplicate') args.push('--output', fx.output);
        if (kind === 'hook') args.push('--afterRead', 'SYNTH_MUST_NOT_EXECUTE');
        const run = await cli(fx, args); assert.equal(run.status, 1); assert.equal(run.value.code, kind === 'relative' ? 'ABSOLUTE_LOCAL_PATH_REQUIRED' : 'INVALID_ARGUMENTS'); assert.equal(await completeManifest(fx.output), false);
    }
});
await check('A destination appearing after validation prevents publication rather than overwriting it', async () => {
    const fx = await fixture('destination-created-race');
    await rejectExtraction(fx, ['EEXIST', 'OUTPUT_EXISTS'], async () => { await fs.mkdir(fx.output); await fs.writeFile(path.join(fx.output, 'sentinel.txt'), 'SYNTH_KEEP'); });
    assert.equal(await fs.readFile(path.join(fx.output, 'sentinel.txt'), 'utf8'), 'SYNTH_KEEP');
});
await check('Extractor fingerprint remains unchanged during this verification run', async () => { assert.equal(hash(await fs.readFile(extractor)), extractorBefore); });

const report = {
    ok: failures.length === 0, checks, failures, rejected, cliCalls, artifacts,
    fingerprints: { extractor: { path: extractor, sha256: extractorBefore }, test: { path: import.meta.filename, sha256: hash(await fs.readFile(import.meta.filename)) } },
    output, scope: 'Only new synthetic L: fixtures; direct extractor CLI/exported function, source snapshots and package integrity/contents; controlled afterRead mutations and owned junctions; no actual user characters, native runtime/build, old backend source, provider/model, account, external service or plugin.'
};
await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ ok: report.ok, checks: checks.length, failures: failures.length, output }));
if (!report.ok) process.exitCode = 1;
