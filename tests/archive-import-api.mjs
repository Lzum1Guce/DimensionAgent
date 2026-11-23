// Original real-HTTP archive import fixture. Starts only an isolated native
// process with fresh synthetic data. No production client, models, WSL or UI edits.
// SQLite inspection is read-only through the Windows system winsqlite3.dll.
// Wait for the owner to confirm the archive-import build before running.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const project = path.resolve(import.meta.dirname, '..'), options = new Map();
for (let i = 2; i < process.argv.length; i += 2) { assert(process.argv[i]?.startsWith('--') && process.argv[i + 1]); options.set(process.argv[i].slice(2), process.argv[i + 1]); }
const output = path.resolve(options.get('output') || path.join(project, 'outputs/phase3-archive-import-api', new Date().toISOString().replace(/[:.]/g, '-')));
const data = path.join(output, 'data'), database = path.join(data, 'identities.sqlite');
const executable = path.resolve(options.get('exe') || path.join(project, 'outputs/build/DImensionagent-native.exe'));
const python = options.get('python') || 'python', execFileAsync = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex'), clone = value => structuredClone(value), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], failures = [], traces = [], snapshots = [], processes = [], retainedTokens = new Set();
const env = { ...process.env, TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp'), PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
const excludedTypes = ['work-runs', 'tool-receipts', 'message-receipts', 'artifacts', 'plugins', 'accounts', 'provider-settings', 'group-metadata'];
const policies = { bots: 'preserve-existing', memories: 'preserve-existing' }, sourceId = 'synthetic-archive-api-source';
const privatePrefix = 'SYNTH_BODY_', body = name => `${privatePrefix}${name} 中文🙂`;
const ids = { existing: 'archive-existing', chat: 'archive-chat-only', work: 'archive-work-only', both: 'archive-both' };
let app, ok = false, originalMemory, firstCommit, settingsBaseline;
assert(/^[lL]:[\\/]/.test(output), 'All standalone output stays on L:');
function pass(name, details) { checks.push({ name, details }); console.log('PASS ' + name); }
function privateFree(value, label) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    assert(!text.includes(privatePrefix), `${label} exposed source body content`);
}
async function until(fn, label, timeout = 15000) {
    const deadline = Date.now() + timeout; let last;
    while (Date.now() < deadline) {
        try { const result = await fn(); if (result) return result; }
        catch (error) { if (error.fatal) throw error; last = error; }
        await delay(30);
    }
    throw Error(`Timeout: ${label}${last ? ` (${last.message})` : ''}`);
}
function recordedRoute(route) { return route.replace(/\/stage\/[0-9a-f]{32}/g, '/stage/:token'); }
async function response(route, payload, method = payload === undefined ? 'GET' : 'POST', headers = {}) {
    const encoded = payload === undefined ? undefined : typeof payload === 'string' ? payload : JSON.stringify(payload);
    const result = await new Promise((resolve, reject) => {
        const request = http.request(app.origin + route, { method, headers: { 'content-type': 'application/json', ...(encoded === undefined ? {} : { 'content-length': Buffer.byteLength(encoded) }), ...headers } }, incoming => {
            const chunks = []; incoming.on('data', chunk => chunks.push(chunk)); incoming.on('error', reject);
            incoming.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let value; try { value = JSON.parse(text); } catch {} resolve({ status: incoming.statusCode, text, value }); });
        });
        request.on('error', reject); request.setTimeout(30000, () => request.destroy(Error('Synthetic HTTP request timeout')));
        request.end(encoded);
    });
    if (route.startsWith('/api/native/archive/')) privateFree(result.text, `${method} ${recordedRoute(route)}`);
    const trace = { method, route: recordedRoute(route), status: result.status };
    if (route.startsWith('/api/native/archive/') && result.value) {
        const { token, ...metadata } = result.value; trace.metadata = metadata; if (token) trace.tokenSha256 = digest(token);
    }
    traces.push(trace); return result;
}
async function api(route, payload, method, expected = 200, headers) {
    const result = await response(route, payload, method, headers);
    assert.equal(result.status, expected, `${method || (payload === undefined ? 'GET' : 'POST')} ${recordedRoute(route)}: ${result.status}`);
    assert(result.value !== undefined, 'Expected JSON API response'); return result.value;
}
async function startNative() {
    const child = spawn(executable, ['--data', data, '--ui', path.join(project, 'ui'), '--port', '0'],
        { cwd: output, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
    const entry = { child, stdout: '', stderr: '', port: null }; processes.push(entry);
    child.stdout.on('data', bytes => { entry.stdout += bytes; for (const line of entry.stdout.split(/\r?\n/)) { try { const row = JSON.parse(line); if (row.ready) entry.port = row.port; } catch {} } });
    child.stderr.on('data', bytes => { entry.stderr += bytes; }); child.on('error', error => { entry.error = error; });
    await until(() => { if (entry.error) throw Object.assign(entry.error, { fatal: true }); if (child.exitCode !== null) throw Object.assign(Error(`Native exited ${child.exitCode}: ${entry.stderr}`), { fatal: true }); return entry.port; }, 'isolated native ready');
    entry.origin = `http://127.0.0.1:${entry.port}`; app = entry;
}
async function closeNative() {
    if (!app || app.child.exitCode !== null) return;
    app.child.stdin.end('shutdown\n'); await until(() => app.child.exitCode !== null, 'native orderly shutdown'); assert.equal(app.child.exitCode, 0);
}

// Fixed SELECT-only inspection of this test's own database, never Store(...).
// Integer values stay decimal strings so the test does not lose int64 precision.
const sqliteProbe = `import ctypes,os,sys,json,re
dbpath=os.path.abspath(sys.argv[1]);allowed=os.path.abspath(sys.argv[2])
assert os.path.commonpath([dbpath,allowed])==allowed and os.path.basename(dbpath)=='identities.sqlite' and os.path.isfile(dbpath)
system=ctypes.create_unicode_buffer(32768)
assert ctypes.windll.kernel32.GetSystemDirectoryW(system,len(system))
sql=ctypes.CDLL(os.path.join(system.value,'winsqlite3.dll'))
def bind(name,result,args):
 fn=getattr(sql,name);fn.restype=result;fn.argtypes=args;return fn
ptr=ctypes.c_void_p;integer=ctypes.c_int;text=ctypes.c_char_p
open_db=bind('sqlite3_open_v2',integer,[text,ctypes.POINTER(ptr),integer,text])
close_db=bind('sqlite3_close_v2',integer,[ptr])
prepare=bind('sqlite3_prepare_v2',integer,[ptr,text,integer,ctypes.POINTER(ptr),ctypes.POINTER(text)])
step=bind('sqlite3_step',integer,[ptr]);finalize=bind('sqlite3_finalize',integer,[ptr])
columns=bind('sqlite3_column_count',integer,[ptr]);column_name=bind('sqlite3_column_name',text,[ptr,integer])
column_type=bind('sqlite3_column_type',integer,[ptr,integer]);column_text=bind('sqlite3_column_text',ptr,[ptr,integer])
column_bytes=bind('sqlite3_column_bytes',integer,[ptr,integer]);column_int=bind('sqlite3_column_int64',ctypes.c_longlong,[ptr,integer])
column_double=bind('sqlite3_column_double',ctypes.c_double,[ptr,integer]);column_blob=bind('sqlite3_column_blob',ptr,[ptr,integer])
readonly=bind('sqlite3_db_readonly',integer,[ptr,text]);changes=bind('sqlite3_total_changes',integer,[ptr])
db=ptr();assert open_db(dbpath.encode('utf-8'),ctypes.byref(db),1,None)==0
def query(command):
 statement=ptr();assert prepare(db,command.encode('utf-8'),-1,ctypes.byref(statement),None)==0
 rows=[]
 try:
  while True:
   result=step(statement)
   if result==101:break
   assert result==100;row={}
   for i in range(columns(statement)):
    kind=column_type(statement,i);name=column_name(statement,i).decode('utf-8')
    if kind==1:value=str(column_int(statement,i))
    elif kind==2:value=repr(column_double(statement,i))
    elif kind==3:value=ctypes.string_at(column_text(statement,i),column_bytes(statement,i)).decode('utf-8')
    elif kind==4:value={'blobHex':ctypes.string_at(column_blob(statement,i),column_bytes(statement,i)).hex()}
    else:assert kind==5;value=None
    row[name]=value
   rows.append(row)
 finally:assert finalize(statement)==0
 return rows
try:
 assert readonly(db,b'main')==1
 query('BEGIN')
 application=query('PRAGMA application_id')[0]['application_id'];assert application=='1145654593'
 tables={}
 for item in query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
  name=item['name'];assert re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*',name)
  tables[name]=sorted(query('SELECT * FROM "'+name+'"'),key=lambda row:json.dumps(row,sort_keys=True))
 query('ROLLBACK');assert changes(db)==0
 print(json.dumps({'applicationId':application,'readonly':True,'totalChanges':0,'tables':tables}))
finally:assert close_db(db)==0
`;
async function snapshot(label) {
    const result = await execFileAsync(python, ['-c', sqliteProbe, database, data], { cwd: output, windowsHide: true, env, maxBuffer: 8 * 1024 * 1024, timeout: 15000 });
    const value = JSON.parse(result.stdout); assert.equal(value.readonly, true); assert.equal(value.totalChanges, 0);
    const hash = digest(JSON.stringify(value.tables)); snapshots.push({ label, sha256: hash, tables: Object.fromEntries(Object.entries(value.tables).map(([name, rows]) => [name, rows.length])) });
    return { ...value, hash };
}
const domain = snapshot => JSON.stringify(Object.fromEntries(['bots', 'messages', 'memories'].map(name => [name, snapshot.tables[name]])));
async function assertUnchanged(before, label) { const after = await snapshot(label); assert.equal(after.hash, before.hash, `${label}: complete synthetic SQLite state changed`); return after; }
async function noStagedBodies(markers) {
    async function walk(folder) {
        for (const entry of await readdir(folder, { withFileTypes: true })) {
            const file = path.join(folder, entry.name);
            if (entry.isDirectory()) await walk(file);
            else if (entry.isFile()) {
                // Windows keeps its empty instance/service lock files open
                // exclusively. A verified zero-byte file cannot hold a body.
                if ((await stat(file)).size === 0) continue;
                const bytes = await readFile(file); for (const marker of markers) assert(!bytes.includes(Buffer.from(marker)), 'Uncommitted archive body persisted to a target file');
            }
        }
    }
    await walk(data);
}
function archive(bots, conversations = [], memories = []) { return { format: 'dimension-conversation-archive', version: 1, coverage: 'conversation-data-only', excludedTypes: [...excludedTypes], bots, conversations, memories }; }
function smallArchive(tag) {
    const id = `archive-${tag}`;
    return archive([{ id, name: `Synthetic ${tag}`, persona: body(`PERSONA_${tag}`), inChat: true, inWork: false }],
        [{ botId: id, groupId: '', mode: 'chat', messages: [{ id: '9007199254740993', actor: 'user', text: body(`MESSAGE_${tag}`), createdAtMs: '1700000000123' }] }],
        [{ id: '9007199254741993', botId: id, groupId: '', text: body(`MEMORY_${tag}`), state: 'confirmed', revision: '7', sourceActor: 'user' }]);
}
let nextMessage = 9007199254740993n;
const message = (name, createdAtMs, actor = 'user') => ({ id: String(nextMessage++), actor, text: body(name), createdAtMs });
const primary = archive([
    { id: ids.existing, name: 'Imported replacement must not win', persona: body('CONFLICT_PERSONA'), inChat: false, inWork: true },
    { id: ids.chat, name: 'Synthetic Chat only', persona: body('CHAT_PERSONA'), inChat: true, inWork: false },
    { id: ids.work, name: 'Synthetic Work only', persona: body('WORK_PERSONA'), inChat: false, inWork: true },
    { id: ids.both, name: 'Synthetic dual roster', persona: body('BOTH_PERSONA'), inChat: true, inWork: true },
], [
    { botId: ids.existing, groupId: '', mode: 'chat', messages: [message('EXISTING_CHAT', '1680000000001')] },
    { botId: ids.chat, groupId: '', mode: 'chat', messages: [message('EPOCH_ZERO', '0'), message('BEFORE_EPOCH', '-1'), message('NORMAL_TIME', '1700000000123', 'bot')] },
    { botId: ids.work, groupId: '', mode: 'work', messages: [message('INT64_MIN_TIME', '-9223372036854775808', 'system'), message('INT64_MAX_TIME', '9223372036854775807', 'bot'), message('WORK_NORMAL_TIME', '1600000000123')] },
    { botId: ids.both, groupId: '', mode: 'chat', messages: [message('DUAL_CHAT_USER', '1500000000000'), message('DUAL_CHAT_REPLY', '1500000000001', 'bot')] },
    { botId: ids.both, groupId: '', mode: 'work', messages: [message('DUAL_WORK_USER', '1510000000000'), message('DUAL_WORK_REPLY', '1510000000001', 'bot')] },
], [
    { id: '9007199254741993', botId: ids.existing, groupId: '', text: body('EXISTING_MEMORY'), state: 'candidate', revision: '99', sourceActor: 'user' },
    { id: '9007199254741994', botId: ids.chat, groupId: '', text: body('IMPORTED_CONFIRMED'), state: 'confirmed', revision: '9223372036854775807', sourceActor: 'user' },
    { id: '9007199254741995', botId: ids.chat, groupId: '', text: body('IMPORTED_CANDIDATE'), state: 'candidate', revision: '7', sourceActor: 'user' },
    { id: '9007199254741996', botId: ids.chat, groupId: '', text: body('IMPORTED_REJECTED'), state: 'rejected', revision: '11', sourceActor: 'user' },
    { id: '9007199254741997', botId: ids.work, groupId: '', text: body('WORK_MEMORY'), state: 'confirmed', revision: '3', sourceActor: 'user' },
    { id: '9007199254741998', botId: ids.chat, groupId: '', text: body('IMPORTED_CONFIRMED_NORMAL'), state: 'confirmed', revision: '5', sourceActor: 'user' },
]);
const envelope = (document, source = sourceId, choice = policies) => ({ sourceId: source, archive: document, policies: choice });
async function stage(document = primary, source = sourceId, choice = policies) {
    const before = Date.now(), result = await api('/api/native/archive/stage', envelope(document, source, choice));
    assert.match(result.token, /^[0-9a-f]{32}$/); assert.equal(result.staged, true); assert.equal(result.dataChanged, false);
    assert.equal(typeof result.expiresAtMs, 'string'); const expiry = BigInt(result.expiresAtMs);
    assert(expiry > BigInt(before) && expiry <= BigInt(Date.now() + 600500));
    assert.match(result.report.targetRevision, /^\d+$/); assert.match(result.report.digest, /^[0-9a-f]{64}$/);
    assert.equal(result.report.targetSnapshot, 'sqlite-read-transaction'); assert.equal(result.report.requiresCommitRecheck, true);
    assert.equal(result.report.completeApplicationRestore, false); assert.equal(result.report.applicationMetadataPreserved, true);
    retainedTokens.add(result.token); return result;
}
const commit = (token, expected = 200) => api('/api/native/archive/commit', { token }, 'POST', expected);
async function discard(token, committed = false) {
    const result = await api('/api/native/archive/stage/' + token, undefined, 'DELETE');
    assert.deepEqual(result, { discarded: true, committed, dataChanged: false }); retainedTokens.delete(token); return result;
}
function createdZero(result) { for (const name of ['botsCreated', 'messagesCreated', 'memoriesCreated']) assert.equal(result.report.counts[name], 0, name); }
async function allHistory(botId, mode = 'chat', legacyWork = false) {
    const rows = []; let before;
    for (let page = 0; page < 15; page++) {
        const query = new URLSearchParams({ limit: '2', ...(legacyWork ? {} : { mode }), ...(before ? { before } : {}) });
        const result = await api(`/api/dimension/bots/${botId}/${legacyWork ? 'work' : 'history'}?${query}`);
        assert(result.messages.length <= 2); assert.equal(typeof result.hasMore, 'boolean');
        for (const row of result.messages) { assert.equal(row.botId, botId); assert.equal(row.mode, mode); assert.match(row.messageId, /^\d+$/); assert.equal(typeof row.createdAtMs, 'string'); if (mode === 'work') assert.equal(row.archived, true); }
        rows.unshift(...result.messages);
        if (!result.hasMore) { assert.equal(new Set(rows.map(row => row.messageId)).size, rows.length); return rows; }
        assert(result.messages.length); assert.equal(result.before, result.messages[0].messageId); if (before) assert(BigInt(result.before) < BigInt(before)); before = result.before;
    }
    throw Error('History pagination did not terminate');
}
async function assertImportedViews() {
    const bots = (await api('/api/dimension/bots/lookup')).bots;
    const expectedRosters = { [ids.existing]: [true, false], [ids.chat]: [true, false], [ids.work]: [false, true], [ids.both]: [true, true] };
    for (const [id, expected] of Object.entries(expectedRosters)) { const item = bots.find(row => row.id === id); assert(item); assert.deepEqual([item.chat, item.work], expected); }
    assert.equal(bots.find(row => row.id === ids.existing).name, 'Existing synthetic identity');
    const persona = await api(`/api/dimension/persona?botId=${ids.existing}`); assert(persona.fields.some(field => field.content.includes(body('ORIGINAL_APP_PERSONA'))));
    for (const source of primary.conversations) {
        const rows = await allHistory(source.botId, source.mode, source.mode === 'work');
        assert.deepEqual(rows.map(row => row.text), source.messages.map(row => row.text));
        for (let i = 0; i < rows.length; i++) {
            assert.equal(rows[i].actor, source.messages[i].actor);
            assert.equal(rows[i].role, source.messages[i].actor === 'bot' ? 'assistant' : source.messages[i].actor);
            if (source.messages[i].actor === 'system') assert.equal(rows[i].from, '系统');
            assert.equal(rows[i].createdAtMs, source.messages[i].createdAtMs);
            const time = BigInt(source.messages[i].createdAtMs);
            const expected = time === -9223372036854775808n || time === 9223372036854775807n ? '' : new Date(Number(time)).toISOString();
            assert.equal(rows[i].ts, expected);
        }
        if (source.mode === 'work') assert.deepEqual(await allHistory(source.botId, 'work'), rows);
    }
    assert.deepEqual(await allHistory(ids.chat, 'work', true), []); assert.deepEqual(await allHistory(ids.work, 'chat'), []);
    const remembered = await api(`/api/dimension/memory?botId=${ids.chat}`); assert.match(remembered.revision, /^[0-9a-f]{64}$/);
    assert.equal(remembered.entries.find(row => row.text === body('IMPORTED_CONFIRMED')).revision, '9223372036854775807');
    assert.equal(remembered.entries.find(row => row.text === body('IMPORTED_CONFIRMED_NORMAL')).revision, '5');
    assert.equal(remembered.candidates.find(row => row.text === body('IMPORTED_CANDIDATE')).revision, '7');
    assert(!JSON.stringify(remembered).includes(body('IMPORTED_REJECTED')));
    assert.deepEqual((await api(`/api/dimension/memory?botId=${ids.existing}`)).entries, originalMemory.entries);
    const stored = await snapshot('after-primary-visible-views');
    const rejected = stored.tables.memories.find(row => row.text === body('IMPORTED_REJECTED'));
    assert.equal(rejected.state, 'rejected'); assert.equal(rejected.revision, '11');
    assert.equal(stored.tables.messages.filter(row => Object.values(ids).includes(row.bot_id)).length, 11);
    for (const id of Object.values(ids)) assert.deepEqual((await api(`/api/dimension/work/sessions?botId=${id}`)).runs, []);
    assert.deepEqual((await api('/api/dimension/groups')).groups, []);
    assert.deepEqual((await api('/api/dimension/sidebar')).work, []);
    assert.equal(await readFile(path.join(data, 'settings.json'), 'utf8'), settingsBaseline);
    return stored;
}

await mkdir(path.join(output, 'temp'), { recursive: true });
assert.equal(await stat(data).catch(error => { if (error.code === 'ENOENT') return null; throw error; }), null, 'This test requires a fresh synthetic data directory');
const fingerprints = {};
try {
    for (const [name, file] of [['native', executable], ['test', import.meta.filename]]) fingerprints[name] = { path: file, sha256: digest(await readFile(file)) };
    await startNative(); assert.equal((await api('/api/native/info')).automaticDataMigration, false);
    await api('/api/dimension/bots', { id: ids.existing, name: 'Existing synthetic identity', persona: body('ORIGINAL_STORE_PERSONA') });
    await api('/api/dimension/persona?botId=' + ids.existing, { values: { persona: body('ORIGINAL_APP_PERSONA') } });
    const proposed = await api('/api/dimension/memory', { action: 'add', botId: ids.existing, text: body('EXISTING_MEMORY') });
    originalMemory = await api('/api/dimension/memory', { action: 'review', botId: ids.existing, candidateId: proposed.candidates[0].id, reviewAction: 'confirm' });
    settingsBaseline = await readFile(path.join(data, 'settings.json'), 'utf8');
    const before = await snapshot('baseline');

    const preview = await api('/api/native/archive/preflight', primary);
    assert.equal(preview.readOnly, true); assert.equal(preview.importImplemented, true); assert.equal(preview.commitRequiresStaging, true); assert.equal(preview.canImport, false);
    await assertUnchanged(before, 'preflight-is-read-only');
    pass('The legacy preflight remains advisory and read-only while explicitly requiring staging for imports');

    const invalid = [
        value => { delete value.policies; }, value => { delete value.policies.memories; }, value => { value.policies.bots = 'overwrite'; },
        value => { value.policies.extra = body('FORBIDDEN_POLICY'); }, value => { value.extra = body('FORBIDDEN_ENVELOPE'); },
        value => { value.sourceId = '../invalid namespace'; }, value => { value.archive.version = 99; },
        value => { value.archive.accounts = [body('UNSUPPORTED_ACCOUNT')]; }, value => { value.archive.conversations[0].messages[0].id = 9007199254740992; },
        value => { value.archive.conversations[0].botId = 'missing-reference'; },
    ];
    for (const change of invalid) { const value = envelope(clone(primary), sourceId, clone(policies)); change(value); await api('/api/native/archive/stage', value, 'POST', 400); }
    await api('/api/native/archive/stage', undefined, 'GET', 405); await api('/api/native/archive/commit', undefined, 'GET', 405);
    const unknown = randomBytes(16).toString('hex'); await commit(unknown, 404); await commit('bad-token', 400);
    await api('/api/native/archive/stage/' + unknown, undefined, 'DELETE', 404);
    await api('/api/native/archive/stage/' + unknown, undefined, 'GET', 405);
    await api('/api/native/archive/commit', { token: unknown, extra: body('FORBIDDEN_COMMIT') }, 'POST', 400);
    await assertUnchanged(before, 'strict-input-rejections');
    pass('Both policies, exact request fields, source namespace, archive schema, methods and token formats are enforced without writes or body leaks');

    for (const headers of [{ origin: 'https://untrusted.example' }, { 'sec-fetch-site': 'cross-site' }, { host: 'untrusted.example' }]) {
        const result = await response('/api/native/archive/stage', envelope(smallArchive('untrusted')), 'POST', headers); assert.equal(result.status, 403);
    }
    await assertUnchanged(before, 'cross-site-and-host-rejections');
    pass('Existing Origin, Sec-Fetch-Site and Host protections apply to the new import endpoint over real HTTP');

    const slots = [];
    for (let i = 0; i < 4; i++) slots.push(await stage(smallArchive(`slot-${i}`), `synthetic-slot-${i}`));
    const capacity = await api('/api/native/archive/stage', envelope(smallArchive('slot-extra'), 'synthetic-slot-extra'), 'POST', 429); assert.equal(capacity.code, 'archive_stage_capacity');
    await api('/api/native/archive/stage/' + slots[0].token, {}, 'DELETE', 400);
    await discard(slots[0].token); await commit(slots[0].token, 404);
    slots[0] = await stage(smallArchive('slot-replaced'), 'synthetic-slot-replaced');
    await noStagedBodies([body('MESSAGE_slot-1'), body('MEMORY_slot-2'), body('PERSONA_slot-replaced')]);
    for (const item of slots) await discard(item.token);
    await assertUnchanged(before, 'bounded-memory-only-staging');
    pass('Four in-memory slots are bounded; discard releases capacity, accepts no body, and never persists staged source records');

    for (const choice of [{ bots: 'reject-conflicts', memories: 'preserve-existing' }, { bots: 'preserve-existing', memories: 'reject-conflicts' }]) {
        const rejected = await stage(primary, sourceId, choice); assert.equal(rejected.report.canCommit, false); assert(rejected.report.issueCount > 0);
        const denied = await commit(rejected.token, 409); assert.equal(denied.code, 'archive_stage_blocked'); await discard(rejected.token);
    }
    for (const shape of ['group', 'empty']) {
        const value = smallArchive(`unsupported-${shape}`);
        if (shape === 'group') value.conversations[0].groupId = 'synthetic-group-without-metadata'; else value.conversations[0].messages = [];
        const rejected = await stage(value, `synthetic-${shape}`); assert.equal(rejected.report.canCommit, false); await commit(rejected.token, 409); await discard(rejected.token);
    }
    await assertUnchanged(before, 'unsupported-and-policy-blocked');
    pass('Reject policies, group scopes and empty conversation restoration block the complete commit instead of partially importing');

    const prepared = await stage(); assert.equal(prepared.report.canCommit, true);
    assert.equal(prepared.report.counts.botsCreated, 3); assert.equal(prepared.report.counts.messagesCreated, 11); assert.equal(prepared.report.counts.memoriesCreated, 5);
    await assertUnchanged(before, 'successful-stage-no-write'); await noStagedBodies([body('CHAT_PERSONA'), body('EPOCH_ZERO'), body('IMPORTED_CONFIRMED')]);
    firstCommit = await commit(prepared.token); assert.equal(firstCommit.committed, true); assert.equal(firstCommit.replayed, false);
    assert.equal(firstCommit.report.digest, prepared.report.digest); assert.equal(firstCommit.report.revisionBefore, prepared.report.targetRevision);
    assert(BigInt(firstCommit.report.revisionAfter) > BigInt(firstCommit.report.revisionBefore));
    assert.equal(firstCommit.report.counts.botsCreated, 3); assert.equal(firstCommit.report.counts.messagesCreated, 11); assert.equal(firstCommit.report.counts.memoriesCreated, 5);
    const imported = await assertImportedViews();
    pass('One commit imports private Chat/Work records, independent rosters, review states and exact int64 times/revisions while preserving existing Bot, memory and app settings');
    pass('UI-compatible paginated Chat and archived Work APIs expose original records, including epoch/negative time and empty display timestamps for int64 extremes, without executable Work tasks');

    const beforeSave = await api('/api/dimension/memory?botId=' + ids.chat);
    const ordinary = beforeSave.entries.find(entry => entry.text === body('IMPORTED_CONFIRMED_NORMAL'));
    const exhausted = beforeSave.entries.find(entry => entry.text === body('IMPORTED_CONFIRMED'));
    assert(ordinary && exhausted); assert.equal(ordinary.revision, '5'); assert.equal(exhausted.revision, '9223372036854775807');
    await api('/api/dimension/memory', { action: 'save', botId: ids.chat, baseRevision: beforeSave.revision,
        entries: [{ id: ordinary.id, text: body('SHOULD_ROLL_BACK_NORMAL') }, { id: exhausted.id, text: body('SHOULD_FAIL_REVISION_LIMIT') }] }, 'POST', 409);
    const afterSave = await api('/api/dimension/memory?botId=' + ids.chat);
    assert.equal(afterSave.revision, beforeSave.revision); assert.deepEqual(afterSave.entries, beforeSave.entries);
    await assertUnchanged(imported, 'memory-batch-revision-overflow-rollback');
    await api('/api/dimension/memory', { action: 'save', botId: ids.chat, baseRevision: beforeSave.revision, entries: [{ id: ordinary.id }] }, 'POST', 400);
    const afterMissingText = await api('/api/dimension/memory?botId=' + ids.chat);
    assert.equal(afterMissingText.revision, beforeSave.revision); assert.deepEqual(afterMissingText.entries, beforeSave.entries);
    await assertUnchanged(imported, 'memory-save-missing-text-no-delete');
    pass('A batch save ending at INT64_MAX rolls back the earlier ordinary-revision edit; missing text returns 400 without deleting, and all text, revisions and aggregate revisions remain unchanged');

    const replay = await commit(prepared.token); assert.equal(replay.replayed, true); assert.equal(replay.report.countsDescribe, 'original-commit'); assert.deepEqual(replay.report, firstCommit.report);
    await assertUnchanged(imported, 'same-token-replay'); await discard(prepared.token, true); await commit(prepared.token, 404);
    assert.equal(domain(await snapshot('discard-after-commit')), domain(imported));
    const restaged = await stage(); createdZero(restaged); const repeated = await commit(restaged.token); assert.equal(repeated.replayed, false); createdZero(repeated); await discard(restaged.token, true);
    assert.equal(domain(await snapshot('same-source-restage')), domain(imported));
    const changed = clone(primary); changed.conversations[1].messages[0].text = body('CHANGED_USED_SOURCE_RECORD');
    const changedStage = await stage(changed); assert.equal(changedStage.report.canCommit, false); await commit(changedStage.token, 409); await discard(changedStage.token);
    assert.equal(domain(await snapshot('changed-source-refused')), domain(imported));
    pass('Cached commit replay, discard-after-commit and stable-source restaging cannot duplicate records; changed consumed source identities are refused');

    const raceArchive = smallArchive('concurrent-batch'), raceStage = await stage(raceArchive, 'synthetic-concurrent-batch'); assert.equal(raceStage.report.canCommit, true);
    await api('/api/dimension/memory', { action: 'add', botId: ids.existing, text: body('CONCURRENT_TARGET_EDIT') });
    const afterEdit = await snapshot('after-concurrent-target-edit');
    await commit(raceStage.token, 409); await assertUnchanged(afterEdit, 'stale-stage-atomic-no-write'); await discard(raceStage.token);
    assert(!(await api('/api/dimension/bots/lookup')).bots.some(bot => bot.id === 'archive-concurrent-batch'));
    await noStagedBodies([body('MESSAGE_concurrent-batch'), body('MEMORY_concurrent-batch'), body('PERSONA_concurrent-batch')]);
    pass('A public target mutation after staging causes 409 and leaves the complete synthetic SQLite database unchanged by the failed batch');

    const removed = await api('/api/dimension/bots/' + ids.chat, undefined, 'DELETE'); assert.equal(removed.memoryPreserved, true);
    // The explicit Bot deletion may update application chat receipts. Imports
    // must preserve the new user-selected application state from this point.
    settingsBaseline = await readFile(path.join(data, 'settings.json'), 'utf8');
    assert.deepEqual(await allHistory(ids.chat), []);
    const memory = await api('/api/dimension/memory?botId=' + ids.chat), deletedEntry = memory.entries.find(entry => entry.text === body('IMPORTED_CONFIRMED'));
    assert(deletedEntry); await api('/api/dimension/memory', { action: 'save', botId: ids.chat, baseRevision: memory.revision, entries: [{ id: deletedEntry.id, text: '' }] });
    const deletedState = await snapshot('after-user-delete');
    const tombstones = await stage(); assert.equal(tombstones.report.canCommit, true); createdZero(tombstones);
    assert.equal(tombstones.report.counts.messagesTombstoned, 3); assert.equal(tombstones.report.counts.memoriesTombstoned, 1);
    const tombstoneCommit = await commit(tombstones.token); createdZero(tombstoneCommit); await discard(tombstones.token, true);
    assert.equal(domain(await snapshot('no-resurrection-after-delete')), domain(deletedState));
    const deletedBot = (await api('/api/dimension/bots/lookup')).bots.find(bot => bot.id === ids.chat); assert.equal(deletedBot.chat, false); assert.equal(deletedBot.work, false);
    assert.deepEqual(await allHistory(ids.chat), []); assert(!(await api('/api/dimension/memory?botId=' + ids.chat)).entries.some(entry => entry.id === deletedEntry.id));
    pass('Removing a Bot and separately deleting its confirmed memory leaves source tombstones, so restaging cannot restore rosters, history or the deleted memory');

    const pending = await stage(smallArchive('restart-pending'), 'synthetic-restart-pending');
    await noStagedBodies([body('MESSAGE_restart-pending'), body('PERSONA_restart-pending')]);
    await closeNative(); await startNative(); retainedTokens.clear(); await commit(pending.token, 404);
    const restartBaseline = await snapshot('restart-baseline');
    const recoveredStage = await stage(); createdZero(recoveredStage); assert.equal(recoveredStage.report.counts.messagesTombstoned, 3); assert.equal(recoveredStage.report.counts.memoriesTombstoned, 1);
    const recovered = await commit(recoveredStage.token); createdZero(recovered); assert.equal(recovered.replayed, false); await discard(recoveredStage.token, true);
    assert.equal(domain(await snapshot('restart-source-dedup')), domain(restartBaseline));
    assert(!(await api('/api/dimension/bots/lookup')).bots.some(bot => bot.id === 'archive-restart-pending'));
    assert.deepEqual((await api('/api/dimension/work/sessions?botId=' + ids.both)).runs, []);
    await noStagedBodies([body('MESSAGE_restart-pending'), body('PERSONA_restart-pending')]);
    assert.equal(await readFile(path.join(data, 'settings.json'), 'utf8'), settingsBaseline);
    pass('Restart drops uncommitted memory-only stages while durable source mappings and deletion tombstones still prevent replay');
    for (const entry of processes) { privateFree(entry.stdout, 'native stdout'); privateFree(entry.stderr, 'native stderr'); }
    pass('Archive responses, errors and native logs contain metadata only; standalone evidence uses independent synthetic data and read-only SQLite inspection');
    ok = true;
} catch (error) {
    failures.push(error.stack); console.error(error.stack); process.exitCode = 1;
} finally {
    if (app?.child.exitCode === null) for (const token of retainedTokens) await api('/api/native/archive/stage/' + token, undefined, 'DELETE').catch(() => {});
    await closeNative().catch(error => failures.push(error.message));
    for (const entry of processes) if (entry.child.pid && entry.child.exitCode === null)
        await execFileAsync('taskkill', ['/PID', String(entry.child.pid), '/T', '/F'], { cwd: output, windowsHide: true }).catch(() => {});
    for (let i = 0; i < processes.length; i++) await writeFile(path.join(output, `native-${i}.log`), processes[i].stdout + '\nSTDERR\n' + processes[i].stderr, 'utf8');
    ok &&= failures.length === 0 && processes.every(entry => entry.child.exitCode === 0); if (!ok) process.exitCode = 1;
    const report = { ok, checks, failures, traces, snapshots, fingerprints, windowsProcesses: processes.map(entry => ({ pid: entry.child.pid, exitCode: entry.child.exitCode, signal: entry.child.signalCode })),
        inspectedDatabase: database, inspection: 'Windows system winsqlite3.dll; SQLITE_OPEN_READONLY; SELECT-only read transaction; application_id checked; total_changes=0',
        expiryCoverage: 'HTTP verifies future bounded expiresAtMs, four slots, discard and process-local loss. Exact TTL and source-byte limit boundaries belong to trusted-constructor unit tests; no product test clock/flags or system-clock changes.',
        scope: 'Fresh synthetic Bot, message and memory records only. No production client/data, real model calls, Linux desktop, group restoration, settings import or executable Work tasks.' };
    await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2), 'utf8'); console.log(JSON.stringify({ ok, checks: checks.length, output }));
}
