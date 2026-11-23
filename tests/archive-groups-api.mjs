// Original group-archive integration. Only generated data and real IPv4 loopback
// HTTP/model protocol are used. Do not run until the owner releases the new build.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat, cp } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { startFixture } from './app-integration.mjs';

const project = path.resolve(import.meta.dirname, '..'), options = new Map();
for (let i = 2; i < process.argv.length; i += 2) { assert(process.argv[i]?.startsWith('--') && process.argv[i + 1]); options.set(process.argv[i].slice(2), process.argv[i + 1]); }
const output = path.resolve(options.get('output') || path.join(project, 'outputs/phase3-archive-groups-api', new Date().toISOString().replace(/[:.]/g, '-')));
const executable = path.resolve(options.get('exe') || path.join(project, 'outputs/build/DImensionagent-native.exe'));
const baselineExe = path.resolve(options.get('baseline') || path.join(project, 'outputs/phase3-group-archives/baseline/DImensionagent-native-0.3.3.exe'));
const ui = path.resolve(options.get('ui') || path.join(project, 'ui'));
const python = options.get('python') || 'python', execFileAsync = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex'), clone = value => structuredClone(value), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], failures = [], traces = [], snapshots = [], processes = [], retainedTokens = new Set(), fingerprints = {};
const env = { ...process.env, TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp'), PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
const sourceId = 'synthetic-group-archive-source', privatePrefix = 'SYNTH_GROUP_BODY_', body = name => `${privatePrefix}${name} 中文🙂`;
const ids = { existing: 'groups-existing', owner: 'groups-owner', admin: 'groups-admin', member: 'groups-member', former: 'groups-former', outsider: 'groups-outsider' };
const groupId = 'groups-imported-main';
const baseExclusions = ['work-runs', 'tool-receipts', 'message-receipts', 'artifacts', 'plugins', 'accounts', 'provider-settings'];
const policies = { bots: 'preserve-existing', memories: 'preserve-existing', groups: 'preserve-existing' };
let app, fixture, ok = false, primary, existingGroup, mainData, completedGroupRun;
assert(/^[lL]:[\\/]/.test(output), 'Standalone outputs stay on L:');
function pass(name) { checks.push(name); console.log('PASS ' + name); }
function privateFree(value, label) { assert(!String(typeof value === 'string' ? value : JSON.stringify(value)).includes(privatePrefix), `${label} exposed source body content`); }
function insideOutput(folder) { const relative = path.relative(output, folder); assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Fixture must remain inside this output directory'); }
async function until(fn, label, timeout = 20000) {
    const deadline = Date.now() + timeout; let last;
    while (Date.now() < deadline) {
        try { const value = await fn(); if (value) return value; } catch (error) { if (error.fatal) throw error; last = error; }
        await delay(35);
    }
    throw Error(`Timeout: ${label}${last ? ` (${last.message})` : ''}`);
}
function recordedRoute(route) { return route.replace(/\/stage\/[0-9a-f]{32}/g, '/stage/:token'); }
async function response(route, payload, method = payload === undefined ? 'GET' : 'POST') {
    assert(app && app.child.exitCode === null);
    const encoded = payload === undefined ? undefined : JSON.stringify(payload), label = app.label;
    const result = await new Promise((resolve, reject) => {
        const req = http.request(app.origin + route, { method, headers: { 'content-type': 'application/json', ...(encoded === undefined ? {} : { 'content-length': Buffer.byteLength(encoded) }) } }, res => {
            const chunks = []; res.on('data', bytes => chunks.push(bytes)); res.on('error', reject);
            res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let value; try { value = JSON.parse(text); } catch {} resolve({ status: res.statusCode, text, value }); });
        });
        req.on('error', reject); req.setTimeout(30000, () => req.destroy(Error('Synthetic HTTP timeout'))); req.end(encoded);
    });
    assert(!result.text.includes('synthetic-key'), 'Public API exposed fixture credential');
    const trace = { process: label, method, route: recordedRoute(route), status: result.status };
    if (route.startsWith('/api/native/archive/')) {
        privateFree(result.text, 'Archive API');
        if (result.value) { const { token, ...metadata } = result.value; trace.metadata = metadata; if (token) trace.tokenSha256 = digest(token); }
    }
    traces.push(trace); return result;
}
async function api(route, payload, method, expected = 200) {
    const result = await response(route, payload, method);
    assert.equal(result.status, expected, `${method || (payload === undefined ? 'GET' : 'POST')} ${recordedRoute(route)} status`);
    assert(result.value !== undefined, 'Expected JSON API response'); return result.value;
}
async function startNative(label, data, exe = executable, expectedExit = 0) {
    insideOutput(data); assert(!app || app.child.exitCode !== null, 'Only one native fixture process at a time');
    const child = spawn(exe, ['--data', data, '--ui', ui, '--port', '0'], { cwd: output, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
    const entry = { label, child, data, exe, expectedExit, stdout: '', stderr: '', ready: false }; processes.push(entry); app = entry; retainedTokens.clear();
    child.stdout.on('data', bytes => { entry.stdout += bytes; for (const line of entry.stdout.split(/\r?\n/)) { try { const value = JSON.parse(line); if (value.ready) { entry.ready = true; entry.origin = `http://127.0.0.1:${value.port}`; } } catch {} } });
    child.stderr.on('data', bytes => { entry.stderr += bytes; }); child.on('error', error => { entry.error = error; });
    await until(() => { if (entry.error) throw Object.assign(entry.error, { fatal: true }); if (expectedExit !== 0) return child.exitCode !== null; if (child.exitCode !== null) throw Object.assign(Error(`Native startup failed ${child.exitCode}: ${entry.stderr}`), { fatal: true }); return entry.ready; }, `${label} startup`);
    if (expectedExit !== 0) { assert.equal(child.exitCode, expectedExit); assert.equal(entry.ready, false); }
    return entry;
}
async function closeNative() {
    if (!app || app.child.exitCode !== null) return;
    app.child.stdin.end('shutdown\n'); await until(() => app.child.exitCode !== null, `${app.label} orderly shutdown`); assert.equal(app.child.exitCode, app.expectedExit);
}

// SELECT-only inspection of generated fixture DBs using the trusted Windows DLL.
const sqliteProbe = `import ctypes,os,sys,json,re
dbpath=os.path.abspath(sys.argv[1]);allowed=os.path.abspath(sys.argv[2])
assert os.path.commonpath([dbpath,allowed])==allowed and os.path.basename(dbpath)=='identities.sqlite' and os.path.isfile(dbpath)
system=ctypes.create_unicode_buffer(32768)
assert ctypes.windll.kernel32.GetSystemDirectoryW(system,len(system))
sql=ctypes.CDLL(os.path.join(system.value,'winsqlite3.dll'))
def bind(name,result,args):
 fn=getattr(sql,name);fn.restype=result;fn.argtypes=args;return fn
ptr=ctypes.c_void_p;integer=ctypes.c_int;text=ctypes.c_char_p
open_db=bind('sqlite3_open_v2',integer,[text,ctypes.POINTER(ptr),integer,text]);close_db=bind('sqlite3_close_v2',integer,[ptr])
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
 assert readonly(db,b'main')==1;query('BEGIN')
 application=query('PRAGMA application_id')[0]['application_id'];assert application=='1145654593'
 tables={}
 for item in query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
  name=item['name'];assert re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*',name)
  tables[name]=sorted(query('SELECT * FROM "'+name+'"'),key=lambda row:json.dumps(row,sort_keys=True))
 query('ROLLBACK');assert changes(db)==0
 print(json.dumps({'applicationId':application,'readonly':True,'totalChanges':0,'tables':tables}))
finally:assert close_db(db)==0
`;
async function snapshot(label, data = app.data) {
    insideOutput(data);
    const result = await execFileAsync(python, ['-c', sqliteProbe, path.join(data, 'identities.sqlite'), data], { cwd: output, windowsHide: true, env, maxBuffer: 12 * 1024 * 1024, timeout: 15000 });
    const value = JSON.parse(result.stdout); assert(value.readonly); assert.equal(value.totalChanges, 0);
    const hash = digest(JSON.stringify(value.tables)); snapshots.push({ label, data, sha256: hash, tables: Object.fromEntries(Object.entries(value.tables).map(([name, rows]) => [name, rows.length])) });
    return { ...value, hash };
}
async function unchanged(before, label) { const after = await snapshot(label); assert.equal(after.hash, before.hash, `${label}: complete SQLite state changed`); return after; }
function selectedTables(value, names) { return Object.fromEntries(names.map(name => [name, value.tables[name]])); }
async function noStagedBodies(markers) {
    async function walk(folder) {
        for (const entry of await readdir(folder, { withFileTypes: true })) {
            const file = path.join(folder, entry.name);
            if (entry.isDirectory()) await walk(file);
            else if (entry.isFile() && (await stat(file)).size) { const bytes = await readFile(file); for (const marker of markers) assert(!bytes.includes(Buffer.from(marker)), 'Staged source body persisted before commit'); }
        }
    }
    await walk(app.data);
}
const botRecord = (id, name = id) => ({ id, name, persona: body('PERSONA_' + id), inChat: true, inWork: true });
const groupRecord = (id, members, extra = {}) => ({ id, name: 'Synthetic ' + id, ownerId: members[0], admins: members.slice(1, 2), members: [...members], historyMembers: [...members], inChat: true, inWork: true, deleted: false, seal: { shape: 'round-seal', color: 'persimmon' }, revision: '7', ...extra });
const archive = (bots, groups = [], conversations = [], memories = [], version = 2) => ({ format: 'dimension-conversation-archive', version, coverage: version === 2 ? 'conversation-and-group-data' : 'conversation-data-only', excludedTypes: [...baseExclusions, version === 2 ? 'application-settings' : 'group-metadata'], bots, ...(version === 2 ? { groups } : {}), conversations, memories });
const message = (id, text, actor = 'bot', createdAtMs = '1700000000123') => ({ id: String(9007199254740993n + BigInt(id)), actor, text: body(text), createdAtMs });
const memory = (id, botId, groupId, text, state = 'confirmed') => ({ id: String(9007199254741993n + BigInt(id)), botId, groupId, text: body(text), state, revision: '9', sourceActor: 'user' });
function smallArchive(tag) {
    const id = 'groups-stage-' + tag, gid = 'group-stage-' + tag;
    return archive([botRecord(id)], [groupRecord(gid, [id])], [{ botId: id, groupId: gid, mode: 'chat', messages: [message(0, 'STAGED_' + tag)] }], [memory(0, id, gid, 'STAGED_MEMORY_' + tag)]);
}
function primaryArchive() {
    const preserved = groupRecord(existingGroup.id, [ids.existing], { name: 'Imported replacement must not win', inChat: false, inWork: true, revision: '99' });
    return archive([botRecord(ids.existing, 'Must not replace existing Bot'), ...[ids.owner, ids.admin, ids.member, ids.former, ids.outsider].map(id => botRecord(id))], [
        preserved,
        groupRecord(groupId, [ids.owner, ids.admin, ids.member], { historyMembers: [ids.owner, ids.admin, ids.member, ids.former], revision: '9007199254740993' }),
    ], [
        { botId: ids.owner, groupId: '', mode: 'chat', messages: [message(0, 'PRIVATE_CHAT_USER', 'user'), message(1, 'PRIVATE_CHAT_REPLY')] },
        { botId: ids.owner, groupId: '', mode: 'work', messages: [message(2, 'PRIVATE_WORK_RECORD')] },
        { botId: ids.owner, groupId, mode: 'chat', messages: [message(3, 'GROUP_CHAT_USER', 'user', '0'), message(7, 'GROUP_CHAT_OWNER')] },
        { botId: ids.admin, groupId, mode: 'chat', messages: [message(4, 'GROUP_CHAT_ADMIN')] },
        { botId: ids.former, groupId, mode: 'chat', messages: [message(5, 'GROUP_CHAT_FORMER', 'bot', '-1')] },
        { botId: ids.member, groupId, mode: 'chat', messages: [message(6, 'GROUP_CHAT_SYSTEM', 'system')] },
        { botId: ids.owner, groupId, mode: 'work', messages: [message(8, 'GROUP_WORK_OWNER')] },
        { botId: ids.member, groupId, mode: 'work', messages: [message(9, 'GROUP_WORK_MEMBER')] },
        { botId: ids.former, groupId, mode: 'work', messages: [message(10, 'GROUP_WORK_FORMER')] },
    ], [memory(0, ids.owner, '', 'PRIVATE_MEMORY'), memory(1, ids.owner, groupId, 'GROUP_CONFIRMED'), memory(2, ids.admin, groupId, 'GROUP_CANDIDATE', 'candidate'), memory(3, ids.former, groupId, 'GROUP_REJECTED', 'rejected')]);
}
async function stage(document = primary, source = sourceId, choice = policies) {
    const result = await api('/api/native/archive/stage', { sourceId: source, policies: choice, archive: document });
    assert.match(result.token, /^[0-9a-f]{32}$/); assert.equal(result.staged, true); assert.equal(result.dataChanged, false);
    assert.equal(result.report.targetSnapshot, 'sqlite-read-transaction'); assert.match(result.report.digest, /^[0-9a-f]{64}$/);
    retainedTokens.add(result.token); return result;
}
const commit = (token, expected = 200) => api('/api/native/archive/commit', { token }, 'POST', expected);
async function discard(token, committed = false) { assert.deepEqual(await api('/api/native/archive/stage/' + token, undefined, 'DELETE'), { discarded: true, committed, dataChanged: false }); retainedTokens.delete(token); }
function noCreated(result) { for (const key of ['botsCreated', 'groupsCreated', 'messagesCreated', 'memoriesCreated']) assert.equal(result.report.counts[key], 0, key); }
async function groupHistory(id, mode = 'chat') {
    const rows = []; let before;
    for (let page = 0; page < 30; page++) {
        const query = new URLSearchParams({ mode, limit: '2', ...(before ? { before } : {}) }), result = await api(`/api/dimension/groups/${id}?${query}`);
        assert.equal(result.group.id, id); assert(result.messages.length <= 2); rows.unshift(...result.messages);
        if (!result.hasMore) { assert.equal(new Set(rows.map(row => row.messageId)).size, rows.length); return rows; }
        assert(result.messages.length); assert.equal(result.before, result.messages[0].messageId); if (before) assert(BigInt(result.before) < BigInt(before)); before = result.before;
    }
    throw Error('Group history pagination did not terminate');
}
async function roster(id, mode, present) { const result = await api(`/api/dimension/groups/${id}/roster`, { mode, present }); assert.equal(result.group.id, id); assert(Array.isArray(result.groups)); assert(Array.isArray(result.bots)); return result; }
async function listed(mode) { return (await api('/api/dimension/groups' + (mode ? '?mode=' + mode : ''))).groups.map(group => group.id).sort(); }
async function provisionProvider() { await api('/api/providers', { name: 'synthetic', entry: { kind: 'openai-chat-compat', baseUrl: fixture.baseUrl, spec: { model: 'fixture-flash' } }, secretValue: 'synthetic-key' }); }
function framesOf(result) {
    const frames = []; for (const line of result.text.split(/\r?\n/)) if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)));
    assert(!result.text.includes('THINKING_ONLY')); return frames;
}
async function say(id, tag, mode = 'discuss', workBotId) {
    const result = await response(`/api/dimension/groups/${id}/say`, { mode, text: 'APPTEST:' + tag, ...(workBotId ? { workBotId } : {}) });
    assert.equal(result.status, 200); return framesOf(result);
}
async function terminal(id) { return until(async () => { const run = await api('/api/dimension/work/runs/' + id); return run.terminal && !run.executing ? run : null; }, 'terminal synthetic Work task', 25000); }
async function stoppedWorkerCase(tag, trigger, expectedMembers) {
    const blockedTag = 'group_' + tag + '_blocked', immediateTag = 'group_' + tag + '_immediate', retryTag = 'group_' + tag + '_retry';
    fixture.gate(blockedTag);
    let firstFailure;
    const first = say(groupId, blockedTag).catch(error => { firstFailure = error; });
    await fixture.pending(blockedTag); await trigger();
    const immediate = await response(`/api/dimension/groups/${groupId}/say`, { mode: 'discuss', text: 'APPTEST:' + immediateTag });
    if (immediate.status === 409) {
        assert(!(await snapshot(tag + '-immediate-409')).tables.messages.some(row => row.text === 'APPTEST:' + immediateTag), '409 must not save a rejected group message');
    } else {
        assert.equal(immediate.status, 200); const frames = framesOf(immediate); assert(!frames.some(row => row.kind === 'error'));
        assert.deepEqual(frames.filter(row => row.kind === 'say' && row.from !== 'user').map(row => row.from), expectedMembers);
    }
    fixture.release(blockedTag); await first; if (firstFailure) throw firstFailure;
    let accepted = false;
    for (let attempt = 0; attempt < 20; attempt++) {
        const retried = await response(`/api/dimension/groups/${groupId}/say`, { mode: 'discuss', text: 'APPTEST:' + retryTag });
        if (retried.status === 409) {
            assert(!(await snapshot(tag + '-retry-409')).tables.messages.some(row => row.text === 'APPTEST:' + retryTag)); await delay(50); continue;
        }
        assert.equal(retried.status, 200); const frames = framesOf(retried); assert(!frames.some(row => row.kind === 'error'));
        assert.deepEqual(frames.filter(row => row.kind === 'say' && row.from !== 'user').map(row => row.from), expectedMembers); accepted = true; break;
    }
    assert(accepted, 'Stopped worker must eventually allow a responding new worker');
    const retryRecords = fixture.records.filter(row => row.tag === retryTag); assert.equal(retryRecords.length, expectedMembers.length);
}

await mkdir(path.join(output, 'temp'), { recursive: true });
try {
    for (const [name, file] of [['native', executable], ['baseline033', baselineExe], ['test', import.meta.filename], ['modelFixture', path.join(project, 'tests/app-integration.mjs')], ['uiApp', path.join(ui, 'app.js')]]) fingerprints[name] = { path: file, sha256: digest(await readFile(file)) };
    assert.equal(fingerprints.baseline033.sha256, 'c75e264488620b6aebe304033f317e007627866929c3d6ed249628edaa1651c3');
    if (options.has('expected-sha')) assert.equal(fingerprints.native.sha256, options.get('expected-sha').toLowerCase());
    fixture = await startFixture();
    mainData = path.join(output, 'main/data');
    assert.equal(await stat(mainData).catch(error => { if (error.code === 'ENOENT') return null; throw error; }), null, 'Requires fresh synthetic data');
    await startNative('main', mainData);
    assert.equal((await api('/api/native/info')).automaticDataMigration, false);
    await api('/api/dimension/bots', { id: ids.existing, name: 'Existing preserved Bot', persona: body('EXISTING_PERSONA') });
    const createdGroup = await api('/api/dimension/groups', { name: 'Existing preserved group', members: [ids.existing], ownerId: ids.existing });
    assert(Array.isArray(createdGroup.groups)); existingGroup = createdGroup.group;
    primary = primaryArchive();
    const baseline = await snapshot('main-baseline'), settingsBefore = await readFile(path.join(mainData, 'settings.json'), 'utf8');

    const invalid = [
        value => { delete value.policies.groups; }, value => { value.policies.groups = 'overwrite'; },
        value => { value.archive.groups[1].ownerId = ids.outsider; },
        value => { value.archive.groups[1].admins = [ids.former]; },
        value => { value.archive.groups[1].admins = [ids.admin, ids.admin]; },
        value => { value.archive.groups[1].members.push(ids.member); },
        value => { value.archive.groups[1].revision = 9007199254740992; },
        value => { value.archive.groups[1].unrecognized = body('INVALID_GROUP_FIELD'); },
    ];
    for (const change of invalid) { const value = { sourceId, policies: clone(policies), archive: clone(primary) }; change(value); await api('/api/native/archive/stage', value, 'POST', 400); }
    await unchanged(baseline, 'invalid-v2-roles-and-schema');
    const rejected = await stage(primary, sourceId, { ...policies, groups: 'reject-conflicts' }); assert.equal(rejected.report.canCommit, false); await commit(rejected.token, 409); await discard(rejected.token);
    await unchanged(baseline, 'group-reject-policy');
    pass('Invalid v2 roles/schema/policies and conflicting-group reject policy leave the complete Store unchanged');

    const prepared = await stage(); assert(prepared.report.canCommit); assert.equal(prepared.report.counts.groupsCreated, 1); assert.equal(prepared.report.counts.groupsPreserved, 1);
    await unchanged(baseline, 'v2-stage-read-only'); await noStagedBodies([body('GROUP_CHAT_FORMER'), body('GROUP_REJECTED')]);
    const imported = await commit(prepared.token); assert(imported.committed); assert.equal(imported.report.counts.botsCreated, 5); assert.equal(imported.report.counts.messagesCreated, 11); assert.equal(imported.report.counts.memoriesCreated, 4);
    const firstSnapshot = await snapshot('v2-imported'); const replay = await commit(prepared.token); assert.equal(replay.replayed, true); assert.deepEqual(replay.report, imported.report); await unchanged(firstSnapshot, 'v2-token-replay'); await discard(prepared.token, true);
    assert.equal(await readFile(path.join(mainData, 'settings.json'), 'utf8'), settingsBefore);
    const visible = await api(`/api/dimension/groups/${groupId}?mode=chat`), sourceGroup = primary.groups[1];
    assert.equal(visible.group.rosterManaged, true); assert.equal((await api('/api/dimension/bootstrap')).features.persistentGroupRosters, true);
    for (const key of ['id', 'name', 'ownerId', 'admins', 'members', 'historyMembers', 'inChat', 'inWork', 'deleted', 'seal', 'revision']) assert.deepEqual(visible.group[key], sourceGroup[key], 'Imported group ' + key);
    assert.deepEqual((await api(`/api/dimension/groups/${existingGroup.id}`)).group, existingGroup);
    for (const mode of ['chat', 'work']) {
        const source = primary.conversations.filter(row => row.groupId === groupId && row.mode === mode).flatMap(row => row.messages).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
        const rows = await groupHistory(groupId, mode); assert.deepEqual(rows.map(row => row.text), source.map(row => row.text));
        for (let i = 0; i < rows.length; i++) assert.equal(rows[i].createdAtMs, source[i].createdAtMs);
        assert(rows.some(row => row.from === ids.former));
    }
    const chatPageRows = await groupHistory(groupId, 'chat'), discussPageRows = await groupHistory(groupId, 'discuss'), workPageRows = await groupHistory(groupId, 'work');
    assert.deepEqual(discussPageRows, chatPageRows);
    const workMessageIds = new Set(workPageRows.map(row => row.messageId)); assert(discussPageRows.every(row => !workMessageIds.has(row.messageId)));
    pass('The retained UI discuss history alias paginates identically to Chat and never includes Work records');
    const system = (await groupHistory(groupId)).find(row => row.text === body('GROUP_CHAT_SYSTEM')); assert.equal(system.actor, 'system'); assert.equal(system.from, 'system');
    for (const mode of ['chat', 'work']) {
        const privateRows = (await api(`/api/dimension/bots/${ids.owner}/history?mode=${mode}&limit=99`)).messages;
        assert.deepEqual(privateRows.map(row => row.text), primary.conversations.find(row => row.botId === ids.owner && !row.groupId && row.mode === mode).messages.map(row => row.text));
    }
    assert.deepEqual((await api(`/api/dimension/work/sessions?groupId=${groupId}`)).runs, []);
    assert.equal(firstSnapshot.tables.memories.find(row => row.text === body('GROUP_REJECTED')).state, 'rejected');
    assert((await api(`/api/dimension/memory?botId=${ids.owner}&groupId=${groupId}`)).entries.some(row => row.text === body('GROUP_CONFIRMED')));
    pass('One v2 transaction restores group owner/admins/history members/seal/int64 revision and all scoped records while private Chat/Work stay separate');

    const beforeRoleErrors = await snapshot('before-invalid-group-edits');
    await api(`/api/dimension/groups/${groupId}`, { ownerId: ids.outsider }, 'PATCH', 400);
    await api(`/api/dimension/groups/${groupId}`, { admins: [ids.former] }, 'PATCH', 400);
    await api(`/api/dimension/groups/${groupId}/avatar`, undefined, 'DELETE', 501);
    await api(`/api/dimension/groups/${groupId}/avatar`, {}, 'POST', 501);
    await api(`/api/dimension/groups/${groupId}?mode=invalid`, undefined, 'GET', 400);
    await unchanged(beforeRoleErrors, 'role-edits-and-unknown-action-no-write');
    pass('Invalid group-role edits and unsupported avatar actions reject without changing or deleting the group');

    const v1id = 'groups-v1-compatible', v1 = archive([botRecord(v1id)], [], [{ botId: v1id, groupId: '', mode: 'chat', messages: [message(0, 'V1_PRIVATE')] }], [], 1);
    const v1stage = await stage(v1, 'synthetic-v1-compatible', { bots: 'preserve-existing', memories: 'preserve-existing' }); assert(v1stage.report.canCommit);
    await commit(v1stage.token); await discard(v1stage.token, true); assert.equal((await api(`/api/dimension/bots/${v1id}/history`)).messages[0].text, body('V1_PRIVATE'));
    pass('The unchanged v1 private archive and two-policy stage contract remain usable');

    for (const kind of ['group', 'profile', 'persona']) {
        const pending = await stage(smallArchive(kind), 'synthetic-stale-' + kind);
        if (kind === 'group') { const patched = await api(`/api/dimension/groups/${groupId}`, { name: 'Locally renamed group' }, 'PATCH'); assert(Array.isArray(patched.groups)); }
        else if (kind === 'profile') await api(`/api/dimension/bots/${ids.owner}/profile`, { name: 'Renamed owner 中文', persona: body('UPDATED_OWNER_PERSONA') }, 'PATCH');
        else await api('/api/dimension/persona?botId=' + ids.admin, { values: { persona: body('UPDATED_ADMIN_PERSONA') } });
        const changed = await snapshot('after-normal-' + kind + '-edit'); await commit(pending.token, 409); await unchanged(changed, 'stale-' + kind + '-stage'); await discard(pending.token);
        await noStagedBodies([body('STAGED_' + kind), body('STAGED_MEMORY_' + kind)]);
    }
    pass('Normal group, profile and legacy persona edits advance Store revision and reject a stale entire import without writes');

    const chatBefore = await groupHistory(groupId), workBefore = await groupHistory(groupId, 'work');
    await roster(groupId, 'chat', false); assert(!(await listed('chat')).includes(groupId)); assert((await listed('work')).includes(groupId));
    assert.deepEqual(await groupHistory(groupId), chatBefore); assert.deepEqual(await groupHistory(groupId, 'work'), workBefore);
    await roster(groupId, 'chat', true);
    await api(`/api/dimension/groups/${groupId}?mode=work`, undefined, 'DELETE'); assert((await listed('chat')).includes(groupId)); assert(!(await listed('work')).includes(groupId));
    const hiddenWork = await snapshot('work-roster-hidden');
    await api(`/api/dimension/groups/${groupId}/say`, { mode: 'work', workBotId: ids.owner, text: 'APPTEST:must_not_run_hidden' }, 'POST', 409);
    await api('/api/dimension/work/runs', { groupId, botId: ids.owner, text: 'APPTEST:must_not_run_hidden_direct', requestId: 'hidden-direct' }, 'POST', 409);
    await unchanged(hiddenWork, 'hidden-work-rejected'); assert.deepEqual(await groupHistory(groupId, 'work'), workBefore);
    await roster(groupId, 'work', true);
    const beforeOutsider = await snapshot('before-outsider');
    await api(`/api/dimension/groups/${groupId}/say`, { mode: 'work', workBotId: ids.outsider, text: 'APPTEST:must_not_run_outsider' }, 'POST', 409);
    await api('/api/dimension/work/runs', { groupId, botId: ids.former, text: 'APPTEST:must_not_run_former', requestId: 'former-direct' }, 'POST', 409);
    await api(`/api/dimension/groups/${groupId}/roster`, { mode: 'invalid', present: true }, 'POST', 400);
    await api(`/api/dimension/groups/${groupId}/roster`, { mode: 'discuss', present: true }, 'POST', 400);
    await unchanged(beforeOutsider, 'invalid-work-member-or-mode');
    assert(!fixture.records.some(row => row.tag.startsWith('must_not_run')));
    pass('Mode roster changes preserve the other roster and both histories; hidden Work and nonmember/old-member execution are rejected before the provider');

    await provisionProvider();
    const chatFrames = await say(groupId, 'group_archive_chat'); assert(!chatFrames.some(frame => frame.kind === 'error'));
    assert.deepEqual(chatFrames.filter(frame => frame.kind === 'say' && frame.from !== 'user').map(frame => frame.from), [ids.owner, ids.admin, ids.member]);
    const chatRequests = fixture.records.filter(record => record.tag === 'group_archive_chat'); assert.equal(chatRequests.length, 3);
    const ownerSystem = chatRequests[0].body.messages.filter(row => row.role === 'system').map(row => row.content).join('\n');
    assert(ownerSystem.includes('Renamed owner 中文')); assert(ownerSystem.includes(body('UPDATED_OWNER_PERSONA'))); assert(!ownerSystem.includes(body('PERSONA_' + ids.owner)));
    assert(chatRequests[1].body.messages.some(row => row.role === 'system' && row.content.includes(body('UPDATED_ADMIN_PERSONA'))));
    await stoppedWorkerCase('explicit_stop', () => api(`/api/dimension/groups/${groupId}/chat/stop`, {}), [ids.owner, ids.admin, ids.member]);
    await stoppedWorkerCase('roster_recall', async () => { await roster(groupId, 'chat', false); await roster(groupId, 'chat', true); }, [ids.owner, ids.admin, ids.member]);
    await stoppedWorkerCase('members_update', () => api(`/api/dimension/groups/${groupId}`, { members: [ids.owner, ids.admin] }, 'PATCH'), [ids.owner, ids.admin]);
    pass('Rapid stop/roster-recall/member updates either reject without saving or respond successfully; retries always respond using the current members');
    fixture.gate('group_archive_work');
    const frames = await say(groupId, 'group_archive_work', 'work', ids.owner), runId = frames.find(frame => frame.runId)?.runId; assert(runId); completedGroupRun = runId;
    await fixture.pending('group_archive_work');
    await api(`/api/dimension/groups/${groupId}`, undefined, 'DELETE', 409); await api(`/api/dimension/groups/${groupId}/roster`, { mode: 'work', present: false }, 'POST', 409);
    await api(`/api/dimension/groups/${groupId}?mode=work`, undefined, 'DELETE', 409);
    await api(`/api/dimension/groups/${groupId}`, { members: [ids.owner, ids.admin] }, 'PATCH', 409);
    // Chat removal does not cancel an independently running Work task.
    await roster(groupId, 'chat', false); const held = await api('/api/dimension/work/runs/' + runId); assert(!held.terminal); await roster(groupId, 'chat', true);
    fixture.release('group_archive_work'); const completed = await terminal(runId); assert.equal(completed.status, 'completed'); assert.equal(completed.groupId, groupId);
    const files = (await api(`/api/dimension/work/tasks/${runId}/artifacts`)).files; assert(files.length > 0);
    for (const file of files) { insideOutput(file.path); assert.equal(await readFile(file.path, 'utf8'), fixture.textFor('group_archive_work')); }
    assert(fixture.records.filter(row => row.tag === 'group_archive_work').every(row => row.work));
    pass('Imported groups continue real loopback Chat and verified Work; fresh names/personas reach model prompts, active Work blocks deletion/removal, and Chat roster removal leaves Work running');

    const beforeDelete = await snapshot('before-permanent-group-delete'), memoryBeforeDelete = beforeDelete.tables.memories;
    await api(`/api/dimension/groups/${groupId}`, undefined, 'DELETE');
    assert(!(await listed()).includes(groupId)); await api(`/api/dimension/groups/${groupId}`, undefined, 'GET', 404);
    const deleted = await snapshot('after-permanent-group-delete'); const identity = deleted.tables.groups.find(row => row.id === groupId); assert(identity); assert.equal(identity.deleted, '1');
    assert(!deleted.tables.messages.some(row => row.group_id === groupId)); assert.deepEqual(deleted.tables.memories, memoryBeforeDelete);
    assert.equal(deleted.tables.message_receipts.length, beforeDelete.tables.message_receipts.length);
    for (const previous of beforeDelete.tables.message_receipts) {
        const receipt = deleted.tables.message_receipts.find(row => ['bot_id', 'group_id', 'mode', 'request_key'].every(key => row[key] === previous[key]));
        assert(receipt, 'Consumed request receipt remains present');
        assert.equal(receipt.message_id, previous.group_id === groupId ? null : previous.message_id);
    }
    assert.equal((await api('/api/dimension/work/runs/' + runId)).status, 'completed');
    const restaged = await stage(); noCreated(restaged); assert.equal(restaged.report.counts.messagesTombstoned, 8); await commit(restaged.token); await discard(restaged.token, true);
    const afterRestage = await snapshot('deleted-group-not-resurrected');
    assert.deepEqual(selectedTables(afterRestage, ['bots', 'groups', 'messages', 'memories']), selectedTables(deleted, ['bots', 'groups', 'messages', 'memories']));
    await closeNative(); await startNative('main-restart', mainData);
    const restartedStage = await stage(); noCreated(restartedStage); assert.equal(restartedStage.report.counts.messagesTombstoned, 8); await commit(restartedStage.token); await discard(restartedStage.token, true);
    assert(!(await listed()).includes(groupId)); assert.equal((await api('/api/dimension/work/runs/' + runId)).status, 'completed');
    assert.deepEqual((await snapshot('deleted-group-restart')).tables.memories, memoryBeforeDelete);
    await closeNative();
    pass('Permanent group deletion clears both message modes but retains identity, all memories and receipts; same-source replay and restart cannot resurrect it');

    // Generate v3 state through the previously released ORIGINAL native binary,
    // then copy its orderly closed synthetic SQLite state for migration cases.
    // Desktop/runtime manifests are bound to their original data path and are
    // deliberately not transferred to the independent migration directories.
    const legacyData = path.join(output, 'legacy-seed/data'), validData = path.join(output, 'bootstrap-valid/data'), invalidData = path.join(output, 'bootstrap-retry/data');
    await startNative('legacy-seed-033', legacyData, baselineExe);
    const legacyIds = ['bootstrap-owner', 'bootstrap-admin', 'bootstrap-former'];
    for (const id of legacyIds) await api('/api/dimension/bots', { id, name: 'Original ' + id, persona: body('LEGACY_STORE_' + id) });
    await provisionProvider();
    const legacyGroup = (await api('/api/dimension/groups', { name: 'Legacy synthetic group', ownerId: legacyIds[0], members: legacyIds })).group.id;
    await say(legacyGroup, 'group_bootstrap_history');
    await api('/api/dimension/groups/' + legacyGroup, { members: legacyIds.slice(0, 2), admins: [legacyIds[1]] }, 'PATCH');
    await api(`/api/dimension/groups/${legacyGroup}?mode=chat`, undefined, 'DELETE');
    await api('/api/dimension/persona?botId=' + legacyIds[0], { values: { persona: body('LEGACY_OVERRIDE_PERSONA') } });
    const proposed = await api('/api/dimension/memory', { action: 'add', botId: legacyIds[0], groupId: legacyGroup, text: body('LEGACY_GROUP_MEMORY') });
    await api('/api/dimension/memory', { action: 'review', botId: legacyIds[0], groupId: legacyGroup, candidateId: proposed.candidates[0].id, reviewAction: 'confirm' });
    await closeNative();
    const oldRows = await snapshot('pre-bootstrap-v3-records', legacyData), oldSettings = JSON.parse(await readFile(path.join(legacyData, 'settings.json'), 'utf8'));
    oldSettings.bots[legacyIds[0]].name = 'Migrated profile name'; oldSettings.groups[legacyGroup].seal = { shape: 'round-seal', color: 'persimmon' };
    const oldSettingsText = JSON.stringify(oldSettings, null, 2);
    for (const destination of [validData, invalidData]) {
        await mkdir(destination, { recursive: true });
        for (const name of ['identities.sqlite', 'identities.sqlite-wal']) {
            const source = path.join(legacyData, name), present = await stat(source).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
            if (present) await cp(source, path.join(destination, name), { errorOnExist: true, force: false });
        }
    }
    await writeFile(path.join(validData, 'settings.json'), oldSettingsText, 'utf8');
    const invalidSettings = clone(oldSettings);
    invalidSettings.groups['zz-invalid-legacy-group'] = { id: 'zz-invalid-legacy-group', name: 'Invalid legacy group', members: [legacyIds[0]], historyMembers: legacyIds, ownerId: legacyIds[2], admins: [] };
    await writeFile(path.join(invalidData, 'settings.json'), JSON.stringify(invalidSettings, null, 2), 'utf8');
    await startNative('bootstrap-invalid', invalidData, executable, 1);
    const failed = await snapshot('bootstrap-failure-no-partial-records', invalidData);
    for (const name of ['bots', 'messages', 'memories']) assert.deepEqual(failed.tables[name], oldRows.tables[name], 'Failed bootstrap preserved ' + name);
    assert.equal(failed.tables.groups.length, 0); assert.equal(failed.tables.application_metadata_bootstrap.length, 0);
    invalidSettings.groups['zz-invalid-legacy-group'].ownerId = legacyIds[0];
    await writeFile(path.join(invalidData, 'settings.json'), JSON.stringify(invalidSettings, null, 2), 'utf8');
    await startNative('bootstrap-retry-success', invalidData);
    assert.equal((await api('/api/dimension/groups')).groups.length, 2); assert.equal((await snapshot('bootstrap-retry-marker')).tables.application_metadata_bootstrap.length, 1); await closeNative();
    pass('Invalid legacy roles fail startup before ready without partially migrating groups/profiles; correcting only synthetic JSON permits an atomic retry');

    await startNative('bootstrap-valid', validData);
    assert.equal(await readFile(path.join(validData, 'settings.json'), 'utf8'), oldSettingsText);
    const migrated = await api('/api/dimension/groups/' + legacyGroup); assert.equal(migrated.group.ownerId, legacyIds[0]); assert.deepEqual(migrated.group.admins, [legacyIds[1]]);
    assert.deepEqual(new Set(migrated.group.historyMembers), new Set(legacyIds)); assert.equal(migrated.group.inChat, false); assert.equal(migrated.group.inWork, true);
    assert(migrated.messages.some(row => row.from === legacyIds[2]));
    assert.equal((await api('/api/dimension/bots/lookup')).bots.find(row => row.id === legacyIds[0]).name, 'Migrated profile name');
    assert((await api('/api/dimension/persona?botId=' + legacyIds[0])).fields.some(row => row.content.includes(body('LEGACY_OVERRIDE_PERSONA'))));
    await api(`/api/dimension/bots/${legacyIds[0]}/profile`, { name: 'New durable profile', persona: body('NEW_DURABLE_PERSONA') }, 'PATCH');
    await api('/api/dimension/groups/' + legacyGroup, { name: 'New durable group' }, 'PATCH'); await roster(legacyGroup, 'chat', true); await roster(legacyGroup, 'work', false);
    const migratedStable = await snapshot('bootstrap-valid-edited'); assert.equal(migratedStable.tables.application_metadata_bootstrap.length, 1); await closeNative();
    const obsolete = clone(oldSettings); obsolete.bots[legacyIds[0]].name = 'Obsolete JSON name'; obsolete.bots[legacyIds[0]].persona = body('OBSOLETE_JSON_PERSONA');
    obsolete.groups[legacyGroup].name = 'Obsolete JSON group'; obsolete.groups['zz-invalid-after-marker'] = { invalid: true };
    await writeFile(path.join(validData, 'settings.json'), JSON.stringify(obsolete, null, 2), 'utf8');
    await startNative('bootstrap-valid-restart', validData);
    const finalGroup = (await api('/api/dimension/groups/' + legacyGroup)).group; assert.equal(finalGroup.name, 'New durable group'); assert.equal(finalGroup.inChat, true); assert.equal(finalGroup.inWork, false);
    assert.equal((await api('/api/dimension/bots/lookup')).bots.find(row => row.id === legacyIds[0]).name, 'New durable profile');
    const finalPersona = await api('/api/dimension/persona?botId=' + legacyIds[0]); assert(finalPersona.fields.some(row => row.content === body('NEW_DURABLE_PERSONA')));
    await unchanged(migratedStable, 'successful-bootstrap-never-reapplied'); await closeNative();
    pass('Successful bootstrap preserves the old JSON, imports old-member history/rosters/profiles once, and never reapplies stale or invalid legacy metadata after restart');

    assert.equal(fixture.errors.length, 0, fixture.errors.join('\n'));
    for (const entry of processes) { privateFree(entry.stdout, 'native stdout'); privateFree(entry.stderr, 'native stderr'); assert(!entry.stdout.includes('synthetic-key') && !entry.stderr.includes('synthetic-key')); }
    pass('Archive responses, errors and native logs disclose metadata only; provider traffic is synthetic IPv4 loopback and no production data is opened');
    ok = true;
} catch (error) {
    failures.push(error.stack); console.error(error.stack); process.exitCode = 1;
} finally {
    if (fixture) for (const [tag, gate] of fixture.gates) if (!gate.released) fixture.release(tag);
    if (app?.child.exitCode === null) for (const token of retainedTokens) await api('/api/native/archive/stage/' + token, undefined, 'DELETE').catch(() => {});
    await closeNative().catch(error => failures.push(error.message));
    for (const entry of processes) if (entry.child.pid && entry.child.exitCode === null) await execFileAsync('taskkill', ['/PID', String(entry.child.pid), '/T', '/F'], { cwd: output, windowsHide: true }).catch(() => {});
    if (fixture) await fixture.close().catch(error => failures.push(error.message));
    for (const entry of processes) await writeFile(path.join(output, entry.label + '.log'), entry.stdout + '\nSTDERR\n' + entry.stderr, 'utf8');
    ok &&= failures.length === 0 && processes.every(entry => entry.child.exitCode === entry.expectedExit); if (!ok) process.exitCode = 1;
    const report = { ok, checks, failures, fingerprints, traces, snapshots, windowsProcesses: processes.map(entry => ({ label: entry.label, pid: entry.child.pid, exitCode: entry.child.exitCode, expectedExit: entry.expectedExit, signal: entry.child.signalCode, ready: entry.ready, data: entry.data })),
        modelRequests: (fixture?.records || []).map(row => ({ tag: row.tag, work: row.work, model: row.body.model, promptSha256: digest(JSON.stringify(row.body)), started: row.started, ended: row.ended, aborted: row.aborted })), fixtureErrors: fixture?.errors || [],
        inspection: 'Trusted Windows system winsqlite3.dll, own synthetic DB paths only, SQLITE_OPEN_READONLY, SELECT read transaction, application_id and total_changes=0 verified',
        completedGroupRun, scope: 'Fresh synthetic datasets; original native 0.3.3 creates legacy seed; isolated native UI copy; real loopback HTTP/model protocol; no real accounts, models, production backend/data, WSL or external website.' };
    await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2), 'utf8'); console.log(JSON.stringify({ ok, checks: checks.length, output }));
}
