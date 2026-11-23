// Real desktop-home persistence test with one offline Chrome smoke check. No
// models, real accounts or user files: only fresh synthetic Bots and workspaces,
// and one module-owned native
// namespace. Namespace deletion requires the manifest and owner marker to match.
// Wait for the owning agent's final DesktopHomes build/contract before running.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';

const project = path.resolve(import.meta.dirname, '..'), options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
    assert(process.argv[i]?.startsWith('--') && process.argv[i + 1]); options.set(process.argv[i].slice(2), process.argv[i + 1]);
}
const output = path.resolve(options.get('output') || path.join(project, 'outputs/phase3-desktop-refinement/native-home', new Date().toISOString().replace(/[:.]/g, '-')));
const data = path.join(output, 'data'), desktopData = path.join(data, 'desktop-data'), manifestFile = path.join(desktopData, 'desktop-homes.json');
const executable = path.resolve(options.get('exe') || path.join(project, 'outputs/build/DImensionagent-native.exe'));
const ui = path.resolve(options.get('ui') || path.join(project, 'ui'));
const helper = path.resolve(options.get('helper') || path.join(project, 'outputs/linux/dimension-desktop-helper'));
const wsl = options.get('wsl') || 'C:/Windows/System32/wsl.exe', distro = options.get('distro') || 'dimension-sandbox';
const stamp = `native-home-${Date.now().toString(36)}`, appId = 'synthetic-home-probe';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)), sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const execFileAsync = promisify(execFile), checks = [], failures = [], processes = [], bots = [], calls = [], trackers = new Map(), linuxHistory = [], namespaceAudits = [];
let app, hostIdentity, ownedManifest, cleanupProof, chromeSmoke, ok = false;
assert(/^[lL]:[\\/]/.test(output), 'Independent test output must remain on L:');
const winNormal = value => path.resolve(value.replace(/^\\\\\?\\/, '')).toLowerCase();
async function until(fn, label, timeout = 30000) {
    const deadline = Date.now() + timeout; let last;
    while (Date.now() < deadline) {
        try { const value = await fn(); if (value) return value; }
        catch (error) { if (error.fatal) throw error; last = error; }
        await delay(40);
    }
    throw Error(`Timeout: ${label}${last ? ` (${last.message})` : ''}`);
}
function pass(name, details) { checks.push({ name, details }); console.log('PASS ' + name); }
function noPixels(value, label) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    assert(!/data:image\/png;base64,|iVBORw0KGgo|"png"\s*:\s*"[A-Za-z0-9+/]{64}/.test(text), `${label}: image bytes must be separate PNG files`);
}
function withoutPng(value) { const { png, ...summary } = value; return summary; }
async function api(route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(app.origin + route, { method, headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000) });
    const text = await response.text(); assert.equal(response.status, 200, `${method} ${route}: ${response.status} ${response.status === 200 ? '' : text.slice(0, 1500)}`);
    const result = text ? JSON.parse(text) : null;
    const summary = result && typeof result === 'object' && !Array.isArray(result) ? withoutPng(result) : result;
    noPixels(summary, 'API summary'); calls.push({ method, route, status: response.status, summary }); return result;
}
const desktop = bot => `/api/dimension/work/desktops/${encodeURIComponent(bot.id)}`;
const state = bot => api(desktop(bot));
async function linuxPython(code, payload) {
    const result = await execFileAsync(wsl, ['-d', distro, '--exec', '/usr/bin/python3', '-c', code, ...(payload === undefined ? [] : [JSON.stringify(payload)])],
        { cwd: output, windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 15000 });
    return JSON.parse(result.stdout);
}
const identityProbe = `import os,pwd,json
p=pwd.getpwuid(os.getuid())
print(json.dumps({'uid':os.getuid(),'gid':os.getgid(),'home':p.pw_dir}))
`;
const homeProgram = bot => `import os,json,pathlib,fcntl
home=pathlib.Path('/home/bot');workspace=pathlib.Path('/workspace')
expected={'run':${JSON.stringify(stamp)},'tag':${JSON.stringify(bot.tag)}}
with (home/'synthetic-home-counter.lock').open('a') as lock:
 fcntl.flock(lock.fileno(),fcntl.LOCK_EX)
 marker=home/'synthetic-home-marker.json'
 existed=marker.exists()
 if existed: assert json.loads(marker.read_text())==expected
 else: marker.write_text(json.dumps(expected),encoding='utf-8')
 counter=home/'synthetic-home-counter.json'
 previous=json.loads(counter.read_text())['count'] if counter.exists() else 0
 counter.write_text(json.dumps({'count':previous+1}),encoding='utf-8')
 legacy=home/'legacy-synthetic-marker.json'
 result={'run':expected['run'],'tag':expected['tag'],'uid':os.getuid(),'gid':os.getgid(),'home':str(home),'markerExisted':existed,'count':previous+1,'previousCount':previous,'marker':json.loads(marker.read_text()),'legacyMarker':json.loads(legacy.read_text()) if legacy.exists() else None,'namespace':os.readlink('/proc/self/ns/pid')}
 temp=workspace/('home-result-'+str(os.getpid())+'.tmp')
 temp.write_text(json.dumps(result),encoding='utf-8');os.replace(temp,workspace/'home-result.json')
`;
const readyTitle = `Native HOME ready | ${stamp}`;
const smokeHtml = `<!doctype html><meta charset="utf-8"><title>Native HOME loading</title>
<style>html,body{margin:0;background:#14233b;color:#fff;font-family:"Noto Sans CJK SC",sans-serif}main{margin:62px;max-width:1100px}h1{font-size:56px;margin:0 0 12px}h2{font-size:34px;font-weight:500;margin:0 0 36px}p{font-size:28px;line-height:1.7}#ready{padding:24px 32px;border-radius:14px;background:#596373;font-size:30px}.swatches{display:flex;gap:24px;margin-top:36px}.swatches div{width:210px;height:115px;border-radius:12px}.blue{background:rgb(40,100,235)}.pink{background:rgb(230,35,165)}.amber{background:rgb(245,180,30)}</style>
<main><h1>Native HOME</h1><h2>原生 Linux 持久目录 · 独立桌面</h2><div id="ready">正在等待字体与画面</div><p>中文验证：你好，独立桌面！<br>离线页面 · 本轮合成数据 · 真实 Linux Chrome</p><div class="swatches"><div class="blue"></div><div class="pink"></div><div class="amber"></div></div></main>
<script>document.fonts.ready.then(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const box=document.querySelector('#ready');box.style.background='rgb(25,190,100)';box.textContent='已就绪：字体、颜色与中文显示正常';document.title=${JSON.stringify(readyTitle)};})));</script>`;
function readyPixels(bytes) {
    assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    let width, height, channels; const compressed = [];
    for (let offset = 8; offset + 12 <= bytes.length;) {
        const length = bytes.readUInt32BE(offset), kind = bytes.toString('ascii', offset + 4, offset + 8), end = offset + length + 12;
        assert(end <= bytes.length); const block = bytes.subarray(offset + 8, offset + 8 + length);
        if (kind === 'IHDR') { width = block.readUInt32BE(0); height = block.readUInt32BE(4); channels = ({ 2: 3, 6: 4 })[block[9]]; assert(channels); assert.equal(block[8], 8); assert.equal(block[12], 0); }
        else if (kind === 'IDAT') compressed.push(block);
        offset = end; if (kind === 'IEND') break;
    }
    assert.equal(width, 1280); assert.equal(height, 800); const stride = width * channels;
    const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: (stride + 1) * height }), pixels = Buffer.alloc(stride * height);
    assert.equal(raw.length, (stride + 1) * height);
    const paeth = (a, b, c) => { const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c); return da <= db && da <= dc ? a : db <= dc ? b : c; };
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)]; assert(filter <= 4);
        for (let x = 0; x < stride; x++) {
            const at = y * stride + x, left = x >= channels ? pixels[at - channels] : 0, up = y ? pixels[at - stride] : 0, ul = y && x >= channels ? pixels[at - stride - channels] : 0;
            pixels[at] = (raw[y * (stride + 1) + x + 1] + [0, left, up, Math.floor((left + up) / 2), paeth(left, up, ul)][filter]) & 255;
        }
    }
    let samples = 0;
    for (let y = 0; y < height; y += 4) for (let x = 0; x < width; x += 4) {
        const at = (y * width + x) * channels;
        if ([25, 190, 100].every((value, channel) => Math.abs(pixels[at + channel] - value) <= 5)) samples++;
    }
    return samples >= 1500;
}
async function chromeSmokeTest(bot) {
    await writeFile(path.join(bot.workspace, 'native-home-smoke.html'), smokeHtml, 'utf8');
    const observations = [], started = performance.now();
    let current = await api(desktop(bot) + '/action', { action: { op: 'launch', appId: 'synthetic-native-chrome' } });
    let elapsed;
    const ready = await until(async () => {
        const bytes = Buffer.from(current.png, 'base64'), colored = readyPixels(bytes), title = current.windowTitle || '';
        const milliseconds = performance.now() - started; observations.push({ milliseconds, title, readyPixels: colored });
        if (title.includes(readyTitle) && colored) { elapsed = milliseconds; return bytes; }
        await delay(100); current = await api(desktop(bot) + '/action', { action: { op: 'observe' } }); return null;
    }, 'real native-home Chrome ready title and pixels', 45000);
    assert.equal(current.profileStorage, 'linux');
    const target = path.join(output, 'smoke-native-home.png'); await writeFile(target, ready);
    chromeSmoke = { botId: bot.id, readyTitle: current.windowTitle, milliseconds: elapsed, observations, path: target, sha256: sha256(ready), width: 1280, height: 800 };
    pass('A single real Chrome launch through product desktop APIs renders the offline native-home page with ready title, Chinese and actual success pixels', { milliseconds: elapsed, path: target });
}

// A fixed Linux audit/cleanup worker. It reads only the test namespace and its
// synthetic markers. All deletion uses an already-validated parent directory FD.
const namespaceWorker = `import os,pwd,json,sys,re,stat,shutil
request=json.loads(sys.argv[1]);manifest=request['manifest']
root=manifest['linuxRoot'];name=manifest['namespace'];owner=manifest['owner']
assert manifest['schema']==1
assert root==pwd.getpwuid(os.getuid()).pw_dir==request['expectedRoot']
assert os.path.realpath(root)==root and os.getuid()==request['hostUid'] and os.getgid()==request['hostGid']
assert re.fullmatch(r'\\.dimension-native-[0-9a-f]{32}',name)
assert re.fullmatch(r'[0-9a-f]{32}',owner)
assert manifest['distribution']==request['distribution']
assert set(manifest['homes']).issubset(request['ownedBots'])
flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
rootfd=os.open(root,flags);rootstat=os.fstat(rootfd)
assert rootstat.st_uid==os.getuid()
nsfd=os.open(name,flags,dir_fd=rootfd);nsstat=os.fstat(nsfd)
assert nsstat.st_uid==os.getuid() and stat.S_ISDIR(nsstat.st_mode)
def read_json(parent,name):
 fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parent)
 with os.fdopen(fd,'r',encoding='utf-8') as source:
  text=source.read(65537);assert len(text)<=65536;return json.loads(text)
marker=read_json(nsfd,'.dimension-owner.json')
assert marker=={'schema':1,'namespace':name,'owner':owner}
profiles={}
for bot,entry in manifest['homes'].items():
 assert re.fullmatch(r'bot-[0-9a-f]{32}',bot)
 if entry['storage']!='linux':continue
 botfd=os.open(bot,flags,dir_fd=nsfd);botstat=os.fstat(botfd)
 sidecar=read_json(nsfd,'.owner-'+bot+'.json')
 assert sidecar['owner']==owner and sidecar['botHash']==bot
 assert int(sidecar['device'])==botstat.st_dev and int(sidecar['inode'])==botstat.st_ino
 assert botstat.st_uid==os.getuid()
 synthetic=None;count=None
 try:
  synthetic=read_json(botfd,'synthetic-home-marker.json')
  assert synthetic=={'run':request['run'],'tag':request['ownedBots'][bot]}
  count=read_json(botfd,'synthetic-home-counter.json')['count']
 except FileNotFoundError:
  assert not request.get('requireSynthetic',False)
 profiles[bot]={'marker':synthetic,'count':count,'device':botstat.st_dev,'inode':botstat.st_ino,'uid':botstat.st_uid,'gid':botstat.st_gid}
 os.close(botfd)
current=os.stat(name,dir_fd=rootfd,follow_symlinks=False)
assert stat.S_ISDIR(current.st_mode) and (current.st_dev,current.st_ino)==(nsstat.st_dev,nsstat.st_ino)
result={'root':root,'namespace':name,'ownerMarker':marker,'profiles':profiles,'namespaceDevice':nsstat.st_dev,'namespaceInode':nsstat.st_ino,'rootDevice':rootstat.st_dev,'rootInode':rootstat.st_ino,'deleted':False}
os.close(nsfd)
if request['action']=='delete':
 assert shutil.rmtree.avoids_symlink_attacks
 shutil.rmtree(name,dir_fd=rootfd)
 try:os.stat(name,dir_fd=rootfd,follow_symlinks=False);raise AssertionError('namespace remains')
 except FileNotFoundError:pass
 assert (os.fstat(rootfd).st_dev,os.fstat(rootfd).st_ino)==(rootstat.st_dev,rootstat.st_ino)
 assert os.path.isdir(root)
 result['deleted']=True;result['rootPreserved']=True
else:assert request['action']=='inspect'
os.close(rootfd);print(json.dumps(result))
`;
async function manifest() {
    const text = await readFile(manifestFile, 'utf8'), value = JSON.parse(text);
    assert.equal(value.schema, 1); assert.equal(value.distribution, distro);
    assert.equal(value.linuxRoot, hostIdentity.home); assert.match(value.namespace, /^\.dimension-native-[0-9a-f]{32}$/); assert.match(value.owner, /^[0-9a-f]{32}$/);
    assert.equal(winNormal(value.dataDirectory), winNormal(desktopData));
    assert(Object.keys(value.homes).every(hash => bots.some(bot => bot.hash === hash)), 'Manifest contains only this test data set');
    for (const [hash, entry] of Object.entries(value.homes)) {
        const bot = bots.find(candidate => candidate.hash === hash);
        assert.equal(entry.storage, bot.expectedStorage); assert.equal(winNormal(entry.legacyHome), winNormal(bot.legacyHome));
    }
    if (ownedManifest) { assert.equal(value.owner, ownedManifest.owner); assert.equal(value.namespace, ownedManifest.namespace); }
    else ownedManifest = value;
    return { text, value };
}
async function auditNamespace(action, requireSynthetic = true) {
    const current = await manifest();
    const audit = await linuxPython(namespaceWorker, { action, manifest: current.value, expectedRoot: hostIdentity.home, hostUid: hostIdentity.uid, hostGid: hostIdentity.gid,
        distribution: distro, ownedBots: Object.fromEntries(bots.map(bot => [bot.hash, bot.tag])), run: stamp, requireSynthetic });
    namespaceAudits.push({ at: Date.now(), action, ...audit }); return audit;
}

function spawnNative(extra = [], expectedRejection = false) {
    const distributionArgs = extra.includes('--sandbox-distro') ? [] : ['--sandbox-distro', distro];
    const child = spawn(executable, ['--data', data, '--ui', ui, '--port', '0', '--wsl', wsl,
        ...distributionArgs, '--desktop-helper', helper, ...extra],
    { cwd: output, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp') } });
    const entry = { child, stdout: '', stderr: '', port: null, extra, expectedRejection }; processes.push(entry);
    child.stdout.on('data', bytes => { entry.stdout += bytes; for (const line of entry.stdout.split(/\r?\n/)) { try { const row = JSON.parse(line); if (row.ready) entry.port = row.port; } catch {} } });
    child.stderr.on('data', bytes => { entry.stderr += bytes; }); child.on('error', error => { entry.error = error; }); return entry;
}
async function launchNative(extra = []) {
    const entry = spawnNative(extra);
    await until(() => { if (entry.error) throw Object.assign(entry.error, { fatal: true }); if (entry.child.exitCode !== null) throw Object.assign(Error(`Native exited ${entry.child.exitCode}: ${entry.stderr}`), { fatal: true }); return entry.port; }, 'native ready');
    entry.origin = `http://127.0.0.1:${entry.port}`; app = entry;
}
async function closeEntry(entry) {
    if (!entry || entry.child.exitCode !== null) return;
    entry.child.stdin.end('shutdown\n'); await until(() => entry.child.exitCode !== null, 'native orderly shutdown', 15000); assert.equal(entry.child.exitCode, 0);
}
const closeNative = () => closeEntry(app);
async function rejectedConfiguration(extra, label) {
    const before = await manifest(), entry = spawnNative(extra, true);
    await until(() => { if (entry.error) throw Object.assign(entry.error, { fatal: true }); return entry.port || entry.child.exitCode !== null; }, `${label} configuration rejected`, 15000);
    if (entry.port) { await closeEntry(entry); throw Error(`${label}: conflicting configuration became ready`); }
    assert.notEqual(entry.child.exitCode, 0); assert.equal(await readFile(manifestFile, 'utf8'), before.text, `${label}: original manifest bytes preserved`);
    await auditNamespace('inspect'); return { exitCode: entry.child.exitCode, manifestSha256: sha256(before.text) };
}
async function setupBot(tag, expectedStorage) {
    const bot = { tag, id: `${stamp}-${tag}`, expectedStorage, observations: [] }; bots.push(bot);
    bot.hash = 'bot-' + sha256(bot.id).slice(0, 32);
    bot.legacyHome = path.join(desktopData, 'desktops', bot.hash, 'home');
    await api('/api/dimension/bots', { id: bot.id, name: `Synthetic home ${tag}`, persona: 'Offline native-home persistence test only.' });
    const roster = await api(`/api/dimension/bots/${encodeURIComponent(bot.id)}/roster`, { mode: 'work', present: true }, 'PATCH');
    assert.equal(roster.bot.id, bot.id); assert.equal(roster.bot.work, true);
    assert.equal(roster.bots.find(entry => entry.id === bot.id)?.work, true);
    await api('/api/dimension/work/settings', { botId: bot.id, networkAccess: false }, 'PATCH');
    const current = await state(bot); assert.equal(current.profileStorage, expectedStorage);
    bot.workspace = current.workspace; const within = path.relative(output, bot.workspace); assert(within && !within.startsWith('..') && !path.isAbsolute(within));
    assert.equal(path.basename(path.dirname(bot.workspace)), bot.hash);
    assert.equal(winNormal(path.join(path.dirname(bot.workspace), 'home')), winNormal(bot.legacyHome));
    await writeFile(path.join(bot.workspace, 'home-probe.py'), homeProgram(bot), 'utf8'); return bot;
}
async function observeProgram(bot, expectedCount, phase) {
    const current = await api(desktop(bot) + '/action', { action: { op: 'launch', appId } });
    assert.equal(current.profileStorage, bot.expectedStorage); assert.equal(current.running, true);
    assert.equal(typeof current.png, 'string'); const bytes = Buffer.from(current.png, 'base64');
    assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))); assert.equal(bytes.readUInt32BE(16), 1280); assert.equal(bytes.readUInt32BE(20), 800);
    await writeFile(path.join(output, `${bot.tag}-${phase}.png`), bytes);
    const observed = await until(async () => {
        try { const value = JSON.parse(await readFile(path.join(bot.workspace, 'home-result.json'), 'utf8')); return value.count === expectedCount ? value : null; }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }, `${bot.tag} real home counter ${expectedCount}`, 10000);
    assert.equal(observed.run, stamp); assert.equal(observed.tag, bot.tag); assert.equal(observed.uid, 1000); assert.equal(observed.gid, 1000);
    assert.equal(observed.home, '/home/bot'); assert.equal(observed.previousCount, expectedCount - 1); assert.equal(observed.markerExisted, expectedCount > 1);
    assert.deepEqual(observed.marker, { run: stamp, tag: bot.tag }); assert(observed.namespace.startsWith('pid:['));
    bot.observations.push({ phase, ...observed, captureSha256: sha256(bytes), state: withoutPng(current) }); return observed;
}
async function stopAll() {
    for (const bot of bots) if (bot.workspace) { const current = await api(desktop(bot) + '/stop', {}); assert.equal(current.running, false); }
}
const processProbe = `import os,json
rows=[]
for name in os.listdir('/proc'):
 if not name.isdigit():continue
 try:
  raw=open('/proc/'+name+'/stat').read();end=raw.rfind(')');fields=raw[end+2:].split()
  try: ns=os.readlink('/proc/'+name+'/ns/pid')
  except OSError: ns=None
  try: cmd=open('/proc/'+name+'/cmdline','rb').read().replace(b'\\0',b' ').decode('utf-8','replace')
  except OSError: cmd=''
  rows.append({'pid':int(name),'ppid':int(fields[1]),'starttime':fields[19],'state':fields[0],'namespace':ns,'comm':raw[raw.find('(')+1:end],'command':cmd})
 except (OSError,ValueError,IndexError):pass
print(json.dumps({'host':os.readlink('/proc/self/ns/pid'),'rows':rows}))
`;
async function linuxSnapshot(label) {
    const { rows, host } = await linuxPython(processProbe), byPid = new Map(rows.map(row => [row.pid, row])), selected = new Map();
    for (const bot of bots) {
        let tracker = trackers.get(bot.tag); if (!tracker) { tracker = { known: new Map(), namespaces: new Set() }; trackers.set(bot.tag, tracker); }
        const roots = new Set([...tracker.known.values()].filter(row => byPid.get(row.pid)?.starttime === row.starttime).map(row => row.pid));
        const workspace = bot.workspace && '/mnt/' + bot.workspace[0].toLowerCase() + bot.workspace.slice(2).replaceAll('\\', '/');
        for (const row of rows) if (workspace && row.command.includes(workspace) && /(?:^|\/)bwrap\s/.test(row.command)) roots.add(row.pid);
        const remember = row => { if (row.namespace && row.namespace !== host) tracker.namespaces.add(row.namespace); };
        for (const pid of roots) remember(byPid.get(pid));
        let added; do { added = false; for (const row of rows) if (!roots.has(row.pid) && (roots.has(row.ppid) || tracker.namespaces.has(row.namespace))) { roots.add(row.pid); remember(row); added = true; } } while (added);
        for (const row of rows) if (roots.has(row.pid)) { tracker.known.set(`${row.pid}:${row.starttime}`, row); selected.set(`${row.pid}:${row.starttime}`, { ...row, tag: bot.tag }); }
    }
    const current = [...selected.values()]; linuxHistory.push({ label, at: Date.now(), processes: current }); return current;
}

await mkdir(path.join(output, 'temp'), { recursive: true });
const existingData = await stat(data).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
assert.equal(existingData, null, 'Native-home cleanup test requires a fresh data directory');
const fingerprints = {};
try {
    for (const [name, file] of [['native', executable], ['helper', helper], ['test', import.meta.filename]]) fingerprints[name] = { path: file, sha256: sha256(await readFile(file)) };
    hostIdentity = await linuxPython(identityProbe); assert(path.posix.isAbsolute(hostIdentity.home)); assert(hostIdentity.uid > 0 && hostIdentity.gid > 0);
    await launchNative();
    await api('/api/dimension/work/software', { apps: [
        { id: appId, name: 'Synthetic home marker and counter', executable: '/usr/bin/python3', args: ['/workspace/home-probe.py'] },
        { id: 'synthetic-native-chrome', name: 'Synthetic offline native-home Chrome', executable: '/usr/bin/google-chrome', args: ['--app=file:///workspace/native-home-smoke.html'] },
    ] }, 'PUT');
    const legacy = await setupBot('legacy', 'windows'), legacyMarker = { run: stamp, tag: 'legacy', message: 'Synthetic existing Windows home; keep in place.' };
    await writeFile(path.join(legacy.legacyHome, 'legacy-synthetic-marker.json'), JSON.stringify(legacyMarker), 'utf8');
    await closeNative();

    await launchNative(['--desktop-home-root', hostIdentity.home]);
    assert.equal((await state(legacy)).profileStorage, 'windows');
    assert.deepEqual(JSON.parse(await readFile(path.join(legacy.legacyHome, 'legacy-synthetic-marker.json'), 'utf8')), legacyMarker);
    const legacyFirst = await observeProgram(legacy, 1, 'root-enabled'); assert.deepEqual(legacyFirst.legacyMarker, legacyMarker);
    pass('An existing Windows home remains Windows-backed with its synthetic marker after enabling the native root');

    const alpha = await setupBot('alpha', 'linux'), beta = await setupBot('beta', 'linux');
    await manifest(); const firstAlpha = await observeProgram(alpha, 1, 'first'), firstBeta = await observeProgram(beta, 1, 'first');
    assert.notEqual(firstAlpha.namespace, firstBeta.namespace); assert.equal(firstAlpha.legacyMarker, null); assert.equal(firstBeta.legacyMarker, null);
    await chromeSmokeTest(alpha);
    const firstAudit = await auditNamespace('inspect');
    assert.equal(firstAudit.profiles[alpha.hash].count, 1); assert.equal(firstAudit.profiles[beta.hash].count, 1);
    assert.notEqual(firstAudit.profiles[alpha.hash].inode, firstAudit.profiles[beta.hash].inode);
    pass('New Bots use distinct owned native Linux homes while real sandbox programs run as guest UID/GID 1000', { hostUid: hostIdentity.uid, hostGid: hostIdentity.gid });
    await linuxSnapshot('three-live-desktops-first'); await stopAll(); await closeNative();
    await until(async () => (await linuxSnapshot('first-shutdown')).length === 0, 'first desktop namespaces drained', 3000);

    await launchNative(); // Deliberately omit --desktop-home-root after restart.
    for (const bot of bots) assert.equal((await state(bot)).profileStorage, bot.expectedStorage);
    const secondAlpha = await observeProgram(alpha, 2, 'restart-no-flag'), secondBeta = await observeProgram(beta, 2, 'restart-no-flag');
    assert.notEqual(secondAlpha.namespace, secondBeta.namespace);
    const legacySecond = await observeProgram(legacy, 2, 'restart-no-flag'); assert.deepEqual(legacySecond.legacyMarker, legacyMarker);
    const secondAudit = await auditNamespace('inspect');
    assert.equal(secondAudit.profiles[alpha.hash].count, 2); assert.equal(secondAudit.profiles[beta.hash].count, 2);
    for (const bot of [alpha, beta]) assert.equal(secondAudit.profiles[bot.hash].inode, firstAudit.profiles[bot.hash].inode);
    pass('Stopping and restarting without the root flag preserves Linux home selection, markers, counters and original directory identity');
    await linuxSnapshot('three-live-desktops-restarted'); await stopAll(); await closeNative();
    await until(async () => (await linuxSnapshot('second-shutdown')).length === 0, 'second desktop namespaces drained', 3000);

    const saved = await manifest();
    const rootRejection = await rejectedConfiguration(['--desktop-home-root', path.posix.join(hostIdentity.home, saved.value.namespace)], 'different root');
    const distroRejection = await rejectedConfiguration(['--sandbox-distro', `synthetic-home-conflict-${Date.now().toString(36)}`], 'different distro');
    assert.deepEqual(JSON.parse(await readFile(path.join(legacy.legacyHome, 'legacy-synthetic-marker.json'), 'utf8')), legacyMarker);
    pass('Conflicting root and distro are rejected before ready without changing the manifest, owner or synthetic markers', { rootRejection, distroRejection });

    cleanupProof = await auditNamespace('delete'); assert.equal(cleanupProof.deleted, true); assert.equal(cleanupProof.rootPreserved, true);
    pass('Cleanup validates manifest, no-follow owner markers and inode identity, then deletes only the newly created namespace');
    assert.deepEqual(await linuxSnapshot('final'), []); pass('All test desktop processes are gone by PID, starttime and PID namespace; standalone evidence stays on L:');
    ok = true;
} catch (error) {
    failures.push(error.stack); console.error(error.stack); process.exitCode = 1;
} finally {
    if (app?.child.exitCode === null) await stopAll().catch(error => failures.push(`Desktop cleanup: ${error.message}`));
    await closeNative().catch(error => failures.push(error.message));
    for (const entry of processes) if (entry.child.pid && entry.child.exitCode === null) {
        await closeEntry(entry).catch(() => {});
        if (entry.child.exitCode === null) await execFileAsync('taskkill', ['/PID', String(entry.child.pid), '/T', '/F'], { cwd: output, windowsHide: true }).catch(() => {});
    }
    await until(async () => (await linuxSnapshot('cleanup-final')).length === 0, 'test processes drained', 3000).catch(error => failures.push(error.message));
    if (!cleanupProof?.deleted && hostIdentity) {
        const exists = await stat(manifestFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (exists) {
            // Refuse unowned or changed manifests instead of guessing a directory.
            try {
                const candidate = JSON.parse(await readFile(manifestFile, 'utf8'));
                if (candidate.linuxRoot) cleanupProof = await auditNamespace('delete', false);
                else cleanupProof = { deleted: false, nativeRootConfigured: false, namespaceRemovalNotNeeded: true };
            }
            catch (error) { failures.push(`Native namespace cleanup refused: ${error.message}`); }
        }
    }
    for (let i = 0; i < processes.length; i++) await writeFile(path.join(output, `native-${i}.log`), processes[i].stdout + '\nSTDERR\n' + processes[i].stderr, 'utf8');
    ok &&= failures.length === 0; if (!ok) process.exitCode = 1;
    const report = { ok, checks, failures, hostIdentity, bots, ownedManifest, namespaceAudits, cleanupProof, chromeSmoke, linuxHistory, calls, fingerprints,
        windowsProcesses: processes.map(entry => ({ pid: entry.child.pid, exitCode: entry.child.exitCode, expectedRejection: entry.expectedRejection, extra: entry.extra })),
        scope: 'Fresh synthetic Bots, markers and one offline Chrome smoke page. The default passwd home is a storage parent; no pre-existing account files are read or removed. No real model calls or external websites.' };
    noPixels(report, 'report'); await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify({ ok, checks: checks.length, output }));
}
