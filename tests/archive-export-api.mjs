// Original native-export integration and pure fixture helpers for its browser
// companion. No process starts when this file is imported. Wait for build release.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { startFixture } from './app-integration.mjs';

export const project = path.resolve(import.meta.dirname, '..');
export const policies = { bots: 'preserve-existing', memories: 'preserve-existing', groups: 'preserve-existing' };
export const bodyPrefix = 'SYNTH_EXPORT_BODY_', body = name => `${bodyPrefix}${name} 中文🙂`;
export const excluded = ['work-runs', 'tool-receipts', 'message-receipts', 'artifacts', 'plugins', 'accounts', 'provider-settings', 'application-settings'];
export const digest = value => createHash('sha256').update(value).digest('hex');
export const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const execFileAsync = promisify(execFile), clone = value => structuredClone(value);
export function parseOptions() { const options = new Map(); for (let i = 2; i < process.argv.length; i += 2) { assert(process.argv[i]?.startsWith('--') && process.argv[i + 1]); options.set(process.argv[i].slice(2), process.argv[i + 1]); } return options; }
export async function until(fn, label, timeout = 20000) {
    const deadline = Date.now() + timeout; let last;
    while (Date.now() < deadline) { try { const value = await fn(); if (value) return value; } catch (error) { if (error.fatal) throw error; last = error; } await delay(35); }
    throw Error(`Timeout: ${label}${last ? ` (${last.message})` : ''}`);
}
export function fixtureArchive(prefix = 'export') {
    const ids = { owner: prefix + '-owner', admin: prefix + '-admin', former: prefix + '-former', worker: prefix + '-worker', group: prefix + '-group', hidden: prefix + '-hidden-group', deleted: prefix + '-deleted-group' };
    const bot = (id, chat = true, work = true) => ({ id, name: 'Synthetic ' + id, persona: body('PERSONA_' + id), inChat: chat, inWork: work });
    const group = (id, members, extra = {}) => ({ id, name: 'Synthetic ' + id, ownerId: members[0], admins: members.slice(1), members, historyMembers: members, inChat: true, inWork: true, deleted: false, seal: { shape: 'round-seal', color: 'persimmon' }, revision: '9007199254740993', ...extra });
    let mid = 9007199254740993n, memid = 9007199254741993n;
    const message = (name, actor = 'bot', createdAtMs = '1700000000123') => ({ id: String(mid++), actor, text: body(name), createdAtMs });
    const memory = (botId, groupId, name, state, revision) => ({ id: String(memid++), botId, groupId, text: body(name), state, revision, sourceActor: 'user' });
    return { ids, archive: { format: 'dimension-conversation-archive', version: 2, coverage: 'conversation-and-group-data', excludedTypes: [...excluded],
        bots: [bot(ids.owner), bot(ids.admin, true, false), bot(ids.former, false, false), bot(ids.worker, false, true)],
        groups: [group(ids.group, [ids.owner, ids.admin], { historyMembers: [ids.owner, ids.admin, ids.former] }), group(ids.hidden, [ids.worker], { inChat: false }), group(ids.deleted, [ids.worker])],
        conversations: [
            { botId: ids.owner, groupId: '', mode: 'chat', messages: [message('PRIVATE_ZERO', 'user', '0'), message('PRIVATE_SYSTEM_NEGATIVE', 'system', '-1')] },
            { botId: ids.owner, groupId: '', mode: 'work', messages: [message('PRIVATE_WORK_INT64_MAX', 'bot', '9223372036854775807')] },
            { botId: ids.worker, groupId: '', mode: 'work', messages: [message('WORK_ONLY_INT64_MIN', 'system', '-9223372036854775808'), message('WORK_ONLY_NORMAL')] },
            { botId: ids.owner, groupId: ids.group, mode: 'chat', messages: [message('GROUP_USER', 'user')] },
            { botId: ids.admin, groupId: ids.group, mode: 'chat', messages: [message('GROUP_ADMIN')] },
            { botId: ids.former, groupId: ids.group, mode: 'chat', messages: [message('GROUP_FORMER_SYSTEM', 'system')] },
            { botId: ids.owner, groupId: ids.group, mode: 'work', messages: [message('GROUP_WORK_OWNER')] },
            { botId: ids.former, groupId: ids.group, mode: 'work', messages: [message('GROUP_WORK_FORMER')] },
            { botId: ids.worker, groupId: ids.deleted, mode: 'chat', messages: [message('DELETED_GROUP_CHAT')] },
            { botId: ids.worker, groupId: ids.deleted, mode: 'work', messages: [message('DELETED_GROUP_WORK')] },
        ],
        memories: [memory(ids.owner, '', 'PRIVATE_CONFIRMED', 'confirmed', '9223372036854775807'), memory(ids.admin, ids.group, 'GROUP_CANDIDATE', 'candidate', '7'), memory(ids.former, ids.group, 'GROUP_REJECTED', 'rejected', '11'), memory(ids.worker, ids.hidden, 'HIDDEN_GROUP_MEMORY', 'confirmed', '3'), memory(ids.worker, ids.deleted, 'DELETED_GROUP_MEMORY', 'confirmed', '5')],
    } };
}
export function assertPackage(value) {
    assert.deepEqual(Object.keys(value).sort(), ['format', 'version', 'sourceId', 'sourceRevision', 'snapshot', 'coverage', 'completeApplicationRestore', 'contentSha256', 'packageSha256', 'counts', 'archive'].sort());
    assert.equal(value.format, 'dimension-conversation-export'); assert.equal(value.version, 1); assert.match(value.sourceId, /^native-[0-9a-f]{32}$/);
    assert.match(value.sourceRevision, /^(0|[1-9]\d*)$/); assert(BigInt(value.sourceRevision) <= 9223372036854775807n);
    assert.equal(value.snapshot, 'sqlite-read-transaction'); assert.equal(value.coverage, 'conversation-and-group-data'); assert.equal(value.completeApplicationRestore, false);
    assert.equal(value.archive.format, 'dimension-conversation-archive'); assert.equal(value.archive.version, 2); assert.equal(value.archive.coverage, 'conversation-and-group-data');
    assert.deepEqual([...value.archive.excludedTypes].sort(), [...excluded].sort()); assert.match(value.contentSha256, /^[0-9a-f]{64}$/);
    assert.equal(value.contentSha256, digest(canonical(value.archive)), 'Canonical archive checksum');
    const { packageSha256, ...unsignedPackage } = value; assert.match(packageSha256, /^[0-9a-f]{64}$/);
    assert.equal(packageSha256, digest(canonical(unsignedPackage)), 'Canonical complete-package checksum');
    assert.deepEqual(value.counts, { bots: value.archive.bots.length, groups: value.archive.groups.length, conversations: value.archive.conversations.length, messages: value.archive.conversations.reduce((n, row) => n + row.messages.length, 0), memories: value.archive.memories.length });
    return value;
}
export function rebindPackage(value) { const { packageSha256, ...unsignedPackage } = value; return { ...unsignedPackage, packageSha256: digest(canonical(unsignedPackage)) }; }
export async function startNative({ label, executable, ui, data, output, processes = [], traces = [], extraArgs = [] }) {
    assert(path.isAbsolute(output) && output !== path.parse(output).root, 'Synthetic native output must be a non-root absolute directory'); const relative = path.relative(output, data); assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    const child = spawn(executable, ['--data', data, '--ui', ui, '--port', '0', ...extraArgs], { cwd: output, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp') } });
    const entry = { label, child, data, stdout: '', stderr: '', tokens: new Set(), origin: null }; processes.push(entry);
    child.stdout.on('data', bytes => { entry.stdout += bytes; for (const line of entry.stdout.split(/\r?\n/)) { try { const value = JSON.parse(line); if (value.ready) entry.origin = `http://127.0.0.1:${value.port}`; } catch {} } });
    child.stderr.on('data', bytes => { entry.stderr += bytes; }); child.on('error', error => { entry.error = error; });
    await until(() => { if (entry.error) throw Object.assign(entry.error, { fatal: true }); if (child.exitCode !== null) throw Object.assign(Error(`${label} exited ${child.exitCode}: ${entry.stderr}`), { fatal: true }); return entry.origin; }, label + ' ready');
    entry.response = async (route, payload, method = payload === undefined ? 'GET' : 'POST', headers = {}) => {
        const encoded = payload === undefined ? undefined : typeof payload === 'string' ? payload : JSON.stringify(payload);
        const result = await new Promise((resolve, reject) => {
            const req = http.request(entry.origin + route, { method, headers: { 'content-type': 'application/json', ...(encoded === undefined ? {} : { 'content-length': Buffer.byteLength(encoded) }), ...headers } }, res => {
                const chunks = []; res.on('data', bytes => chunks.push(bytes)); res.on('error', reject);
                res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let value; try { value = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, value }); });
            });
            req.on('error', reject); req.setTimeout(30000, () => req.destroy(Error('Synthetic HTTP timeout'))); req.end(encoded);
        });
        const trace = { process: label, method, route: route.replace(/\/stage\/[0-9a-f]{32}/g, '/stage/:token'), status: result.status };
        if (route === '/api/native/archive/export' && result.status === 200) {
            const value = result.value; trace.export = { format: value?.format, sourceIdSha256: value?.sourceId ? digest(value.sourceId) : null, sourceRevision: value?.sourceRevision, contentSha256: value?.contentSha256, counts: value?.counts };
        } else if (route.startsWith('/api/native/archive/')) {
            assert(!result.text.includes(bodyPrefix), 'Archive metadata response exposed record content');
            if (result.value) { const { token, ...metadata } = result.value; trace.metadata = metadata; if (token) trace.tokenSha256 = digest(token); }
        }
        traces.push(trace); return result;
    };
    entry.api = async (route, payload, method, expected = 200, headers) => { const result = await entry.response(route, payload, method, headers); assert.equal(result.status, expected, `${label}: ${method || (payload === undefined ? 'GET' : 'POST')} ${route} status`); assert(result.value !== undefined); return result.value; };
    entry.stop = async () => { if (child.exitCode !== null) return; child.stdin.end('shutdown\n'); await until(() => child.exitCode !== null, label + ' orderly shutdown'); assert.equal(child.exitCode, 0); };
    return entry;
}

const sqliteProbe = `import ctypes,os,sys,json,re
dbpath=os.path.abspath(sys.argv[1]);allowed=os.path.abspath(sys.argv[2])
assert os.path.commonpath([dbpath,allowed])==allowed and os.path.basename(dbpath)=='identities.sqlite' and os.path.isfile(dbpath)
system=ctypes.create_unicode_buffer(32768);assert ctypes.windll.kernel32.GetSystemDirectoryW(system,len(system))
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
export async function readSnapshot(data, output, label, records, python = 'python') {
    const relative = path.relative(output, data); assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    const result = await execFileAsync(python, ['-c', sqliteProbe, path.join(data, 'identities.sqlite'), data], { cwd: output, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp') }, maxBuffer: 16 * 1024 * 1024, timeout: 15000 });
    const value = JSON.parse(result.stdout); assert(value.readonly); assert.equal(value.totalChanges, 0); const hash = digest(canonical(value.tables));
    records?.push({ label, data, sha256: hash, tables: Object.fromEntries(Object.entries(value.tables).map(([name, rows]) => [name, rows.length])) }); return { ...value, hash };
}
export async function rawImport(app, archive, sourceId) {
    const staged = await app.api('/api/native/archive/stage', { sourceId, policies, archive }); assert(staged.report.canCommit);
    const result = await app.api('/api/native/archive/commit', { token: staged.token }); await app.api('/api/native/archive/stage/' + staged.token, undefined, 'DELETE'); return result;
}
const rowsSorted = rows => rows.map(canonical).sort();
function assertArchiveRows(archive, state, exactIds = false) {
    const botIds = new Set(archive.bots.map(row => row.id)), groupIds = new Set(archive.groups.map(row => row.id));
    assert.deepEqual(rowsSorted(state.tables.bots.filter(row => botIds.has(row.id)).map(row => ({ id: row.id, name: row.name, persona: row.persona, inChat: row.in_chat === '1', inWork: row.in_work === '1' }))), rowsSorted(archive.bots));
    assert.deepEqual(rowsSorted(state.tables.groups.filter(row => groupIds.has(row.id)).map(row => ({ id: row.id, name: row.name, ownerId: row.owner_id, members: JSON.parse(row.members), historyMembers: JSON.parse(row.history_members), admins: JSON.parse(row.admins), inChat: row.in_chat === '1', inWork: row.in_work === '1', deleted: row.deleted === '1', seal: { shape: row.seal_shape, color: row.seal_color }, revision: row.revision }))), rowsSorted(archive.groups));
    const expectedMessages = archive.conversations.flatMap(scope => scope.messages.map(row => ({ botId: scope.botId, groupId: scope.groupId, mode: scope.mode, ...(exactIds ? { id: row.id } : {}), actor: row.actor, text: row.text, createdAtMs: row.createdAtMs })));
    const actualMessages = state.tables.messages.filter(row => botIds.has(row.bot_id)).map(row => ({ botId: row.bot_id, groupId: row.group_id, mode: row.mode, ...(exactIds ? { id: row.id } : {}), actor: row.actor, text: row.text, createdAtMs: row.created_at_ms }));
    assert.deepEqual(rowsSorted(actualMessages), rowsSorted(expectedMessages));
    assert.deepEqual(rowsSorted(state.tables.memories.filter(row => botIds.has(row.bot_id)).map(row => ({ ...(exactIds ? { id: row.id } : {}), botId: row.bot_id, groupId: row.group_id, text: row.text, state: row.state, revision: row.revision, sourceActor: row.source_actor }))), rowsSorted(archive.memories.map(({ id, ...row }) => ({ ...(exactIds ? { id } : {}), ...row }))));
}
async function integration() {
    const options = parseOptions(), output = path.resolve(options.get('output') || path.join(project, 'outputs/phase3-archive-export-api', new Date().toISOString().replace(/[:.]/g, '-')));
    const executable = path.resolve(options.get('exe') || path.join(project, 'outputs/build/DImensionagent-native.exe')), ui = path.resolve(options.get('ui') || path.join(project, 'ui'));
    const checks = [], failures = [], processes = [], traces = [], snapshots = [], fingerprints = {}, exports = [];
    const pass = name => { checks.push(name); console.log('PASS ' + name); }, snap = (app, label) => readSnapshot(app.data, output, label, snapshots, options.get('python'));
    const unchanged = async (app, before, label) => assert.equal((await snap(app, label)).hash, before.hash, label + ': complete Store changed');
    const packageStage = async (app, packageValue, choice = policies) => { const result = await app.api('/api/native/archive/package/stage', { package: packageValue, policies: choice }); app.tokens.add(result.token); return result; };
    const discard = async (app, token) => { await app.api('/api/native/archive/stage/' + token, undefined, 'DELETE'); app.tokens.delete(token); };
    const noCreated = result => { for (const key of ['botsCreated', 'groupsCreated', 'messagesCreated', 'memoriesCreated']) assert.equal(result.report.counts[key], 0, key); };
    let source, target, fixture, ok = false, packageValue;
    const sourceData = path.join(output, 'source/data'), targetData = path.join(output, 'target/data'); assert(/^[lL]:[\\/]/.test(output));
    await mkdir(path.join(output, 'temp'), { recursive: true }); await mkdir(path.join(output, 'downloads'), { recursive: true });
    assert.equal(await stat(sourceData).catch(error => { if (error.code === 'ENOENT') return null; throw error; }), null, 'Requires fresh source');
    assert.equal(await stat(targetData).catch(error => { if (error.code === 'ENOENT') return null; throw error; }), null, 'Requires fresh target');
    try {
        for (const [name, file] of [['native', executable], ['test', import.meta.filename], ['modelFixture', path.join(project, 'tests/app-integration.mjs')], ['uiApp', path.join(ui, 'app.js')], ['uiEntry', path.join(ui, 'index.html')], ['uiArchive', path.join(ui, 'conversation-archive-ui.js')], ['uiArchiveStyles', path.join(ui, 'conversation-archive.css')]]) fingerprints[name] = { path: file, sha256: digest(await readFile(file)) };
        if (options.has('expected-sha')) assert.equal(fingerprints.native.sha256, options.get('expected-sha').toLowerCase());
        const excludedMarkers = ['EXCLUDED_EXPORT_ACCOUNT', 'EXCLUDED_EXPORT_PLUGIN', 'EXCLUDED_EXPORT_SETTING'];
        await mkdir(sourceData, { recursive: true }); await writeFile(path.join(sourceData, 'settings.json'), JSON.stringify({ accounts: { synthetic: excludedMarkers[0] }, plugins: { synthetic: excludedMarkers[1] }, syntheticExportSetting: excludedMarkers[2] }), 'utf8');
        source = await startNative({ label: 'source', executable, ui, data: sourceData, output, processes, traces }); target = await startNative({ label: 'target', executable, ui, data: targetData, output, processes, traces });
        assert.equal((await source.api('/api/dimension/bootstrap')).features.conversationArchives, true);
        const seed = fixtureArchive(), ids = seed.ids; await rawImport(source, seed.archive, 'synthetic-export-seed');
        await source.api(`/api/dimension/bots/${ids.owner}/profile`, { name: 'Edited source identity', persona: body('EDITED_SOURCE_PERSONA') }, 'PATCH');
        await source.api(`/api/dimension/groups/${ids.deleted}`, undefined, 'DELETE');
        fixture = await startFixture(); await source.api('/api/providers', { name: 'synthetic', entry: { kind: 'openai-chat-compat', baseUrl: fixture.baseUrl, spec: { model: 'fixture-flash' } }, secretValue: 'synthetic-key' });
        const runId = (await source.api('/api/dimension/work/runs', { botId: ids.owner, text: 'APPTEST:export_excluded_execution', requestId: 'export-excluded-execution' })).run.id;
        const completed = await until(async () => { const run = await source.api('/api/dimension/work/runs/' + runId); return run.terminal && !run.executing ? run : null; }, 'synthetic Work completion'); assert.equal(completed.status, 'completed');
        const artifacts = (await source.api(`/api/dimension/work/tasks/${runId}/artifacts`)).files; assert(artifacts.length > 0);
        const sourceBefore = await snap(source, 'source-before-export'), settingsBefore = await readFile(path.join(sourceData, 'settings.json'), 'utf8');
        const exported = await source.response('/api/native/archive/export', undefined, 'POST'); assert.equal(exported.status, 200);
        assert.match(exported.headers['content-type'], /application\/json/i); assert.match(exported.headers['content-disposition'], /attachment/i); assert.match(exported.headers['content-disposition'], /\.json/i); assert.match(exported.headers['cache-control'], /no-store/i);
        packageValue = assertPackage(exported.value); assertArchiveRows(packageValue.archive, sourceBefore, true);
        const exportFile = path.join(output, 'downloads/native-source-export.json'); await writeFile(exportFile, exported.text, 'utf8'); exports.push({ path: exportFile, sha256: digest(exported.text), contentSha256: packageValue.contentSha256 });
        assert(packageValue.archive.groups.find(row => row.id === ids.deleted).deleted); assert(packageValue.archive.memories.some(row => row.groupId === ids.deleted)); assert(!packageValue.archive.conversations.some(row => row.groupId === ids.deleted));
        await unchanged(source, sourceBefore, 'export-read-only'); assert.equal(await readFile(path.join(sourceData, 'settings.json'), 'utf8'), settingsBefore);
        assert.deepEqual(assertPackage(await source.api('/api/native/archive/export', {}, 'POST')), packageValue);
        for (const marker of [...excludedMarkers, 'synthetic-key', 'export_excluded_execution', runId, ...artifacts.map(row => row.path)]) assert(!exported.text.includes(marker), 'Export included application/execution metadata');
        pass('Real no-store attachment export is one read-only snapshot with strict counts, canonical checksum and exact conversation/group/profile/int64 data; settings/accounts/providers/plugins/Work execution and artifacts are absent');

        await source.api('/api/native/archive/export', undefined, 'GET', 405); await source.api('/api/native/archive/export', { extra: body('INVALID_EXPORT_FIELD') }, 'POST', 400);
        await source.api('/api/native/archive/export?download=1', {}, 'POST', 400);
        for (const headers of [{ origin: 'https://untrusted.example' }, { 'sec-fetch-site': 'cross-site' }, { host: 'untrusted.example' }]) { const denied = await source.response('/api/native/archive/export', {}, 'POST', headers); assert.equal(denied.status, 403); }
        const self = await packageStage(source, packageValue); assert.equal(self.report.canCommit, false); assert(self.report.issues.some(row => row.code === 'source_is_target')); await source.api('/api/native/archive/commit', { token: self.token }, 'POST', 409); await discard(source, self.token); await unchanged(source, sourceBefore, 'self-restore-and-export-rejections');
        pass('Export method/origin/Host/input guards reject safely, and restoring the native package into its own source is blocked without writes');

        const targetBefore = await snap(target, 'target-before-malformed-packages');
        const invalid = [value => { value.format = 'wrong'; }, value => { value.version = 2; }, value => { value.sourceId = '../bad'; }, value => { value.sourceRevision = 1; }, value => { value.snapshot = 'none'; }, value => { value.coverage = 'everything'; }, value => { value.completeApplicationRestore = true; }, value => { value.contentSha256 = '0'.repeat(64); }, value => { value.counts.messages++; }, value => { value.counts.extra = 0; }, value => { value.extra = body('INVALID_PACKAGE_FIELD'); }, value => { value.archive.conversations[0].messages[0].text = body('TAMPERED_BODY'); }];
        for (const change of invalid) { let value = clone(packageValue); change(value); value = rebindPackage(value); await target.api('/api/native/archive/package/stage', { package: value, policies }, 'POST', 400); }
        for (const change of [value => { value.packageSha256 = '0'.repeat(64); }, value => { value.sourceId = value.sourceId.slice(0, -1) + (value.sourceId.endsWith('0') ? '1' : '0'); }, value => { value.sourceRevision = String(BigInt(value.sourceRevision) + 1n); }]) {
            const value = clone(packageValue); change(value); await target.api('/api/native/archive/package/stage', { package: value, policies }, 'POST', 400);
        }
        const duplicatePackageJson = JSON.stringify(packageValue).replace('"format":"dimension-conversation-export"', '"format":"dimension-conversation-export","format":"dimension-conversation-export"');
        await target.api('/api/native/archive/package/stage', '{"package":' + duplicatePackageJson + ',"policies":' + JSON.stringify(policies) + '}', 'POST', 400);
        for (const payload of [{ package: packageValue }, { package: packageValue, policies: { bots: 'preserve-existing', memories: 'preserve-existing' } }, { package: packageValue, policies, sourceId: 'attempted-override' }, { package: packageValue, policies: { ...policies, groups: 'overwrite' } }]) await target.api('/api/native/archive/package/stage', payload, 'POST', 400);
        await target.api('/api/native/archive/package/stage', undefined, 'GET', 405); await unchanged(target, targetBefore, 'malformed-packages-no-write');
        pass('Tampered checksum/content/counts, invalid package metadata, missing policies and override fields reject the whole request without writes or source-body echo');

        const onDisk = assertPackage(JSON.parse(await readFile(exportFile, 'utf8'))), canceled = await packageStage(target, onDisk); assert(canceled.report.canCommit); await unchanged(target, targetBefore, 'package-preview-no-write'); await discard(target, canceled.token); await target.api('/api/native/archive/commit', { token: canceled.token }, 'POST', 404); await unchanged(target, targetBefore, 'package-cancel-no-write');
        const stale = await packageStage(target, onDisk); await target.api('/api/dimension/bots', { id: 'target-local-mutation', name: 'Local target identity', persona: body('LOCAL_TARGET_PERSONA') });
        const afterEdit = await snap(target, 'target-local-edit'); await target.api('/api/native/archive/commit', { token: stale.token }, 'POST', 409); await unchanged(target, afterEdit, 'stale-package-atomic-refusal'); await discard(target, stale.token);
        pass('The saved export file previews without writes, cancellation frees its token, and a target mutation invalidates the entire staged package');

        const targetSettings = await readFile(path.join(targetData, 'settings.json'), 'utf8'), ready = await packageStage(target, onDisk); assert(ready.report.canCommit);
        const committed = await target.api('/api/native/archive/commit', { token: ready.token }); assert.equal(committed.replayed, false);
        const restored = await snap(target, 'target-restored'); assertArchiveRows(onDisk.archive, restored); assert.equal(await readFile(path.join(targetData, 'settings.json'), 'utf8'), targetSettings);
        assert.deepEqual((await target.api(`/api/dimension/work/sessions?botId=${ids.owner}`)).runs, []);
        assert.equal((await target.api(`/api/dimension/bots/${ids.owner}/history?mode=chat`)).messages.length, 2); assert.equal((await target.api(`/api/dimension/groups/${ids.group}?mode=discuss`)).messages.length, 3);
        const replay = await target.api('/api/native/archive/commit', { token: ready.token }); assert(replay.replayed); assert.deepEqual(replay.report, committed.report); await unchanged(target, restored, 'same-token-package-replay'); await discard(target, ready.token);
        const repeated = await packageStage(target, onDisk); noCreated(repeated); noCreated(await target.api('/api/native/archive/commit', { token: repeated.token })); await discard(target, repeated.token);
        assertArchiveRows(onDisk.archive, await snap(target, 'restaged-package-no-duplicates'));
        let changed = clone(onDisk); changed.archive.conversations[0].messages[0].text = body('CHANGED_CONSUMED_ID'); changed.contentSha256 = digest(canonical(changed.archive)); changed = rebindPackage(changed);
        const changedStage = await packageStage(target, changed); assert.equal(changedStage.report.canCommit, false); await target.api('/api/native/archive/commit', { token: changedStage.token }, 'POST', 409); await discard(target, changedStage.token);
        pass('Explicit commit restores all recorded profiles, modes, group roles/history and memory states exactly; cached and restaged package replay cannot duplicate or replace consumed records');

        await target.api(`/api/dimension/bots/${ids.owner}`, undefined, 'DELETE'); await target.api(`/api/dimension/groups/${ids.group}`, undefined, 'DELETE');
        const remembered = await target.api(`/api/dimension/memory?botId=${ids.owner}`), removedMemory = remembered.entries.find(row => row.text === body('PRIVATE_CONFIRMED')); assert(removedMemory);
        await target.api('/api/dimension/memory', { action: 'save', botId: ids.owner, baseRevision: remembered.revision, entries: [{ id: removedMemory.id, text: '' }] });
        const deleted = await snap(target, 'target-user-deletions'), deletedSettings = await readFile(path.join(targetData, 'settings.json'), 'utf8');
        const noResurrection = await packageStage(target, onDisk); noCreated(noResurrection); assert.equal(noResurrection.report.counts.messagesTombstoned, 8); assert.equal(noResurrection.report.counts.memoriesTombstoned, 1);
        noCreated(await target.api('/api/native/archive/commit', { token: noResurrection.token })); await discard(target, noResurrection.token);
        const afterReplay = await snap(target, 'deleted-package-replay'); for (const table of ['bots', 'groups', 'messages', 'memories']) assert.deepEqual(afterReplay.tables[table], deleted.tables[table]); assert.equal(await readFile(path.join(targetData, 'settings.json'), 'utf8'), deletedSettings);
        pass('Package replay after Bot/group/memory deletion respects durable tombstones and never restores deleted rosters, histories or memories');

        await source.stop(); source = await startNative({ label: 'source-restart', executable, ui, data: sourceData, output, processes, traces });
        const restartExport = assertPackage(await source.api('/api/native/archive/export', {}, 'POST')); assert.deepEqual(restartExport, onDisk);
        const extra = { ...clone(seed.archive), groups: [], conversations: [{ botId: ids.worker, groupId: '', mode: 'work', messages: [{ id: '9007199254750000', actor: 'bot', text: body('INCREMENTAL_WORK'), createdAtMs: '1700000000999' }] }], memories: [] };
        await rawImport(source, extra, 'synthetic-export-incremental'); const next = assertPackage(await source.api('/api/native/archive/export', {}, 'POST'));
        assert.equal(next.sourceId, onDisk.sourceId); assert(BigInt(next.sourceRevision) > BigInt(onDisk.sourceRevision)); assert.notEqual(next.contentSha256, onDisk.contentSha256); assert.equal(next.counts.messages, onDisk.counts.messages + 1);
        const delta = await packageStage(target, next); assert(delta.report.canCommit); assert.equal(delta.report.counts.messagesCreated, 1); assert.equal(delta.report.counts.messagesTombstoned, 8); await target.api('/api/native/archive/commit', { token: delta.token }); await discard(target, delta.token);
        const incremental = await snap(target, 'incremental-export-only-new-record'); assert.equal(incremental.tables.messages.filter(row => row.text === body('INCREMENTAL_WORK')).length, 1); assert(!incremental.tables.messages.some(row => row.group_id === ids.group));
        pass('Native source identity remains stable across restart and later exports; incremental packages add only new records while honoring earlier target deletions');

        assert.equal(fixture.errors.length, 0, fixture.errors.join('\n'));
        for (const entry of processes) { assert(!entry.stdout.includes(bodyPrefix) && !entry.stderr.includes(bodyPrefix)); assert(!entry.stdout.includes('synthetic-key') && !entry.stderr.includes('synthetic-key')); }
        pass('Archive metadata/error responses and native logs contain no exported body or credential; only the intentional synthetic export artifact contains records');
        ok = true;
    } catch (error) { failures.push(error.stack); console.error(error.stack); process.exitCode = 1; }
    finally {
        for (const app of [source, target]) if (app?.child.exitCode === null) { for (const token of app.tokens) await discard(app, token).catch(() => {}); await app.stop().catch(error => failures.push(error.message)); }
        for (const entry of processes) if (entry.child.pid && entry.child.exitCode === null) await execFileAsync('taskkill', ['/PID', String(entry.child.pid), '/T', '/F'], { cwd: output, windowsHide: true }).catch(() => {});
        if (fixture) await fixture.close();
        for (const entry of processes) await writeFile(path.join(output, entry.label + '.log'), entry.stdout + '\nSTDERR\n' + entry.stderr, 'utf8');
        ok &&= failures.length === 0 && processes.every(entry => entry.child.exitCode === 0); if (!ok) process.exitCode = 1;
        const report = { ok, checks, failures, fingerprints, exports, traces, snapshots, windowsProcesses: processes.map(entry => ({ label: entry.label, pid: entry.child.pid, exitCode: entry.child.exitCode, signal: entry.child.signalCode, data: entry.data })), modelRequests: (fixture?.records || []).map(row => ({ tag: row.tag, work: row.work, model: row.body.model, promptSha256: digest(canonical(row.body)) })), fixtureErrors: fixture?.errors || [], scope: 'Only new synthetic source/target native databases and a real IPv4 loopback model fixture; read-only system SQLite inspector; intentional export file on L:; no real data/account/provider/plugin installation/WSL/external website.' };
        await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2), 'utf8'); console.log(JSON.stringify({ ok, checks: checks.length, output }));
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) await integration();
