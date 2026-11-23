import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distro = process.env.DIMENSION_WSL_DISTRO ?? 'dimension-sandbox';
const outputRoot = path.resolve(process.argv[2] ?? path.join(project, 'outputs', 'phase3-desktop'));
const executable = path.resolve(process.argv[3] ?? path.join(project, 'outputs', 'linux', 'dimension-desktop-helper'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function command(program, args, { timeout = 10000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: project, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
    const timer = setTimeout(() => { child.kill(); reject(new Error('Command timed out')); }, timeout);
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}
async function linuxPath(filename) {
  if (process.platform !== 'win32') return filename;
  const result = await command('wsl.exe', ['-d', distro, '--', '/usr/bin/wslpath', '-u', filename]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

const fixtureHTML = `<!doctype html><meta charset="utf-8"><title>Desktop synthetic fixture</title>
<style>html,body{margin:0;background:#e5f1ff;font:24px sans-serif}h1{position:fixed;left:30px;top:8px;font-size:30px}textarea{position:fixed;left:30px;top:80px;width:1000px;height:180px;font-size:30px}button,#drag{position:fixed;top:320px;height:100px;width:220px;font-size:28px}button{left:30px;background:#2774cd;color:white}#drag{left:500px;background:#ffd34f;display:grid;place-items:center;touch-action:none}#scroll{position:fixed;left:30px;top:480px;width:1000px;height:220px;overflow:auto;background:#fff}#long{height:1400px;background:linear-gradient(#dfd,#88a);padding:20px}</style>
<h1>Original Linux desktop fixture</h1><textarea id="text" autofocus></textarea><button id="button">Click fixture</button><div id="drag">Drag fixture</div><div id="scroll"><div id="long">Scroll fixture</div></div>
<script>
let clicked=0,dragged=0,startX=null;
const text=document.querySelector('#text'),area=document.querySelector('#scroll'),drag=document.querySelector('#drag');
function report(){document.title='Desktop fixture | text='+text.value+' | click='+clicked+' | drag='+dragged+' | scroll='+(area.scrollTop>0)}
text.addEventListener('input',report);document.querySelector('#button').onclick=()=>{clicked++;report()};
drag.onpointerdown=e=>{startX=e.clientX;drag.setPointerCapture(e.pointerId)};drag.onpointerup=e=>{if(startX!==null&&Math.abs(e.clientX-startX)>100)dragged++;startX=null;report()};area.onscroll=report;
window.onload=()=>{text.focus();report()};
</script>`;

// This synthetic test supervisor is outside bwrap. It retains process identity
// across reparenting and PID reuse; it never prints unrelated host processes.
const processTracker = `import os,sys,time,json,subprocess
trace_file=sys.argv[1]
host_namespace=os.readlink('/proc/self/ns/pid')
known={}
private_namespaces=set()
def snapshot():
 result={}
 for name in os.listdir('/proc'):
  if not name.isdigit(): continue
  try:
   raw=open('/proc/'+name+'/stat').read(); end=raw.rfind(')'); fields=raw[end+1:].split()
   try: namespace=os.readlink('/proc/'+name+'/ns/pid')
   except OSError: namespace=None
   pid=int(name)
   result[pid]={'pid':pid,'ppid':int(fields[1]),'pgrp':int(fields[2]),'session':int(fields[3]),'state':fields[0],'starttime':fields[19],'comm':raw[raw.find('(')+1:end],'namespace':namespace}
  except (OSError,ValueError,IndexError): pass
 return result
child=subprocess.Popen(sys.argv[2:],stdin=sys.stdin,stdout=sys.stdout,stderr=sys.stderr)
initial=snapshot(); root=initial.get(child.pid)
if root: known[(root['pid'],root['starttime'])]=dict(root,firstSeen=time.monotonic(),lastSeen=time.monotonic(),detached=False)
def refresh():
 current=snapshot()
 selected={pid for (pid,start) in known if pid in current and current[pid]['starttime']==start}
 for pid in list(selected):
  namespace=current[pid]['namespace']
  if namespace and namespace!=host_namespace: private_namespaces.add(namespace)
 changed=True
 while changed:
  changed=False
  for pid,entry in current.items():
   if pid not in selected and (entry['ppid'] in selected or entry['namespace'] in private_namespaces):
    selected.add(pid); changed=True
    if entry['namespace'] and entry['namespace']!=host_namespace: private_namespaces.add(entry['namespace'])
 now=time.monotonic()
 for pid in selected:
  entry=current[pid]; key=(pid,entry['starttime']); previous=known.get(key)
  known[key]=dict(entry,firstSeen=previous['firstSeen'] if previous else now,lastSeen=now,detached=(previous['detached'] if previous else False) or (entry['session']==pid and entry['comm']=='python3'))
 return current
while child.poll() is None:
 refresh(); time.sleep(.02)
deadline=time.monotonic()+5
remaining=[]
while True:
 current=refresh(); remaining=[entry for (pid,start),entry in known.items() if pid in current and current[pid]['starttime']==start]
 if not remaining or time.monotonic()>=deadline: break
 time.sleep(.025)
with open(trace_file,'w') as output: json.dump({'root':root,'exitCode':child.returncode,'tracked':list(known.values()),'privateNamespaces':sorted(private_namespaces),'remaining':remaining},output,indent=2)
sys.exit(child.returncode)
`;

export async function startDesktop(root, binary, { shareNetwork = false } = {}) {
  const workspace = path.join(root, 'workspace'), home = path.join(root, 'home');
  await mkdir(workspace, { recursive: true }); await mkdir(home, { recursive: true });
  await writeFile(path.join(workspace, 'fixture.html'), fixtureHTML);
  const processTreePath = path.join(root, 'process-tree.json');
  const [workspaceLinux, homeLinux, binaryLinux, traceLinux] = await Promise.all([linuxPath(workspace), linuxPath(home), linuxPath(binary), linuxPath(processTreePath)]);
  const args = ['--unshare-all', '--die-with-parent', '--new-session'];
  if (shareNetwork) args.push('--share-net');
  for (const leaf of ['passwd', 'group', 'hosts', 'resolv.conf', 'nsswitch.conf', 'fonts', 'ssl']) args.push('--ro-bind', '/etc/' + leaf, '/etc/' + leaf);
  for (const leaf of ['alternatives', 'ld.so.cache', 'localtime', 'xdg', 'gtk-3.0']) args.push('--ro-bind-try', '/etc/' + leaf, '/etc/' + leaf);
  args.push('--ro-bind', '/usr', '/usr', '--ro-bind', '/opt', '/opt',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/dev/shm', '--tmpfs', '/tmp', '--tmpfs', '/run', '--dir', '/home',
    '--bind', homeLinux, '/home/bot', '--bind', workspaceLinux, '/workspace', '--ro-bind', binaryLinux, '/dimension-helper',
    '--uid', '1000', '--gid', '1000', '--cap-drop', 'ALL', '--clearenv',
    '--setenv', 'DISPLAY', ':99', '--setenv', 'HOME', '/home/bot', '--setenv', 'USER', 'bot', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'TMPDIR', '/tmp',
    '--chdir', '/workspace', '/dimension-helper');
  const tracedArgs = ['/usr/bin/python3', '-u', '-c', processTracker, traceLinux, '/usr/bin/bwrap', ...args];
  const child = process.platform === 'win32'
    ? spawn('wsl.exe', ['-d', distro, '--', ...tracedArgs], { cwd: project, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(tracedArgs[0], tracedArgs.slice(1), { cwd: project, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(), events = [], frames = [], errors = [];
  let buffer = '', stderr = '', sequence = 0, ready;
  const readiness = new Promise((resolve, reject) => { ready = { resolve, reject }; });
  const exit = new Promise(resolve => child.once('exit', (code, signal) => {
    for (const task of pending.values()) task.reject(Error('Desktop exited before response'));
    pending.clear(); ready.reject(Error('Desktop exited before ready: ' + stderr)); resolve({ code, signal });
  }));
  child.on('error', error => ready.reject(error));
  child.stdout.setEncoding('utf8');
  child.stderr.on('data', chunk => { if (stderr.length < 16384) stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        assert(line.length < 8 * 1024 * 1024, 'NDJSON line fits Windows 8 MiB limit');
        const value = JSON.parse(line);
        if (value.event === 'ready') { events.push(value); ready.resolve(value); }
        else if (value.event === 'frame') { frames.push({ ...value, receivedAt: Date.now() }); if (frames.length > 500) frames.shift(); }
        else if (pending.has(String(value.id))) { const item = pending.get(String(value.id)); pending.delete(String(value.id)); item.resolve(value); }
        else events.push(value);
      } catch (error) { errors.push(error.message); }
    }
  });
  await Promise.race([readiness, pause(15000).then(() => { throw Error('Desktop ready timeout: ' + stderr); })]);
  return {
    child, root, workspace, home, processTreePath, events, frames, errors, exit,
    get stderr() { return stderr; },
    async request(op, fields = {}, timeout = 12000) {
      const id = String(++sequence);
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      child.stdin.write(JSON.stringify({ id, op, ...fields }) + '\n');
      let timer;
      try { return await Promise.race([result, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Desktop operation timeout: ' + op)), timeout); })]); }
      finally { clearTimeout(timer); pending.delete(id); }
    },
    async close(eof = false) {
      if (child.exitCode !== null) return exit;
      if (eof) child.stdin.end();
      else { await this.request('shutdown'); child.stdin.end(); }
      return Promise.race([exit, pause(8000).then(() => { child.kill(); throw Error('Desktop did not stop after shutdown/EOF'); })]);
    },
  };
}

async function startLoopbackFixture(directory) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'a.html'), fixtureHTML.replaceAll('Desktop fixture', 'Network desktop A').replaceAll('#e5f1ff', '#ffe5e5'));
  await writeFile(path.join(directory, 'b.html'), fixtureHTML.replaceAll('Desktop fixture', 'Network desktop B').replaceAll('#e5f1ff', '#e5ffe5'));
  const target = await linuxPath(directory);
  const code = "import http.server,functools,threading,sys,json\nclass Handler(http.server.SimpleHTTPRequestHandler):\n def log_message(self,*args):pass\nserver=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=sys.argv[1]))\nthreading.Thread(target=server.serve_forever,daemon=True).start()\nprint(json.dumps({'port':server.server_address[1]}),flush=True)\nsys.stdin.buffer.read()\nserver.shutdown();server.server_close()\n";
  const commandArgs = ['/usr/bin/python3', '-u', '-c', code, target];
  const child = process.platform === 'win32' ? spawn('wsl.exe', ['-d', distro, '--', ...commandArgs], { cwd: project, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) : spawn(commandArgs[0], commandArgs.slice(1), { cwd: project, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stderr.on('data', bytes => { if (stderr.length < 16384) stderr += bytes; });
  const ended = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', bytes => { stdout += bytes; if (stdout.includes('\n')) { try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); } } });
    child.once('exit', code => reject(Error('Loopback fixture exited: ' + code + ' ' + stderr)));
  });
  const { port } = await Promise.race([ready, pause(10000).then(() => { throw Error('Loopback fixture startup timed out'); })]);
  return { port, async close() { child.stdin.end(); return Promise.race([ended, pause(3000).then(() => { child.kill(); throw Error('Loopback fixture did not close'); })]); } };
}

async function main() {
  await mkdir(outputRoot, { recursive: true });
  const work = await mkdtemp(path.join(outputRoot, 'linux-desktop-'));
  const report = [], desktops = [];
  async function test(name, operation) {
    try { await operation(); report.push({ name, ok: true }); console.log('PASS ' + name); }
    catch (error) { report.push({ name, ok: false, error: error.stack }); console.error('FAIL ' + name + '\n' + error.stack); }
  }
  let desktop, blankHash, screenshot;
  async function waitTitle(predicate, timeout = 8000, target = desktop) {
    const deadline = Date.now() + timeout;
    let latest;
    do { const response = await target.request('observe'); if (response.ok) { latest = response.result; if (predicate(latest.windowTitle ?? '')) return latest; } await pause(100); } while (Date.now() < deadline);
    throw Error('Expected window state did not appear: ' + (latest?.windowTitle ?? '(no active title)'));
  }
  try {
    await test('isolated helper starts a real 1280x800 desktop and emits ready', async () => {
      desktop = await startDesktop(path.join(work, 'first'), executable); desktops.push(desktop);
      assert.deepEqual(desktop.events[0], { event: 'ready', width: 1280, height: 800, previewFps: 30 });
    });
    if (!desktop) throw Error('Desktop startup prerequisite failed');
    await test('observe returns a real PNG with exact dimensions', async () => {
      const result = await desktop.request('observe'); assert(result.ok, JSON.stringify(result));
      const bytes = Buffer.from(result.result.png, 'base64'); assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(bytes.readUInt32BE(16), 1280); assert.equal(bytes.readUInt32BE(20), 800); blankHash = hash(bytes);
      await writeFile(path.join(work, 'empty-desktop.png'), bytes);
    });
    await test('absolute launch starts Chrome in the private desktop', async () => {
      const result = await desktop.request('launch', { executable: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--password-store=basic', '--user-data-dir=/home/bot/chrome', '--window-size=1200,760', '--window-position=0,0', '--app=file:///workspace/fixture.html'] });
      assert(result.ok, JSON.stringify(result)); assert(result.result.pid > 0);
      screenshot = await waitTitle(title => title.includes('Desktop fixture'), 40000);
      assert(screenshot, 'Chrome window title is visible'); assert.notEqual(hash(Buffer.from(screenshot.png, 'base64')), blankHash);
      await writeFile(path.join(work, 'chrome-fixture.png'), Buffer.from(screenshot.png, 'base64'));
    });
    await test('Chinese and emoji text is pasted with UTF-8 clipboard', async () => {
      const value = '桌面输入测试🙂'; assert((await desktop.request('click', { x: 200, y: 200, button: 'left' })).ok); await pause(300); assert((await desktop.request('type', { text: value })).ok);
      const view = await waitTitle(title => title.includes('text=' + value));
      await writeFile(path.join(work, 'chinese-input.png'), Buffer.from(view.png, 'base64'));
    });
    await test('validated modifier chord and BackSpace act on the real window', async () => {
      assert((await desktop.request('press', { key: 'ctrl+a' })).ok); assert((await desktop.request('press', { key: 'BackSpace' })).ok);
      await waitTitle(title => /text= \| click=/.test(title));
    });
    await test('real click, interpolated drag and scroll reach the fixture', async () => {
      assert((await desktop.request('click', { x: 90, y: 440, button: 'left' })).ok);
      assert((await desktop.request('drag', { x: 570, y: 440, toX: 850, toY: 440, button: 1 })).ok);
      assert((await desktop.request('scroll', { x: 300, y: 650, amount: 3 })).ok);
      const view = await waitTitle(title => /click=1 \| drag=1 \| scroll=true/.test(title));
      await writeFile(path.join(work, 'mouse-actions.png'), Buffer.from(view.png, 'base64'));
    });
    await test('invalid coordinates, oversized text, key injection and relative executables fail', async () => {
      for (const [op, fields] of [ ['click', { x: -1, y: 20 }], ['click', { x: 1280, y: 20 }], ['scroll', { x: 0, y: 0, amount: 51 }], ['press', { key: 'ctrl+a; touch /workspace/not-created' }], ['type', { text: 'x'.repeat(65537) }], ['launch', { executable: 'google-chrome', args: [] }] ]) assert.equal((await desktop.request(op, fields)).ok, false, op);
    });
    await test('30fps preview emits actual JPEG frames with monotonic sequence', async () => {
      assert((await desktop.request('preview', { enabled: true })).ok); const begin = Date.now(); await pause(2200);
      const frames = desktop.frames.filter(frame => frame.receivedAt >= begin); assert(frames.length >= 40, 'Expected at least 40 live frames over 2.2 seconds; received ' + frames.length);
      for (let i = 0; i < frames.length; ++i) { assert.equal(frames[i].width, 1280); assert.equal(frames[i].height, 800); const bytes = Buffer.from(frames[i].jpeg, 'base64'); assert.equal(bytes.subarray(0, 2).toString('hex'), 'ffd8'); assert.equal(bytes.subarray(-2).toString('hex'), 'ffd9'); if (i) assert(frames[i].seq > frames[i - 1].seq); }
      await writeFile(path.join(work, 'preview-frame.jpg'), Buffer.from(frames.at(-1).jpeg, 'base64'));
      await writeFile(path.join(work, 'preview-measurement.json'), JSON.stringify({ frames: frames.length, elapsedMs: Date.now() - begin, approximateFps: frames.length / ((Date.now() - begin) / 1000) }, null, 2));
    });
    await test('preview can be disabled and no later frame follows its response', async () => {
      assert((await desktop.request('preview', { enabled: false })).ok); const count = desktop.frames.length; await pause(200); assert.equal(desktop.frames.length, count); assert((await desktop.request('observe')).ok);
    });
    await test('two private displays can coexist with the same :99 address', async () => {
      const second = await startDesktop(path.join(work, 'second'), executable); desktops.push(second);
      const view = await second.request('observe'); assert(view.ok, JSON.stringify(view)); assert(!view.result.windowTitle?.includes('Desktop fixture'));
      assert.equal((await second.close()).code, 0);
    });
    await test('long-lived helper reaps completed launch processes between requests', async () => {
      for (let i = 0; i < 20; ++i) assert((await desktop.request('launch', { executable: '/usr/bin/true', args: [] })).ok);
      await pause(50);
      const script = "import os,json\nowner=os.getppid(); zombies=[]\nfor name in os.listdir('/proc'):\n if not name.isdigit(): continue\n try:\n  data=open('/proc/'+name+'/stat').read().rsplit(')',1)[1].split()\n  if data[0]=='Z' and int(data[1])==owner: zombies.append(name)\n except (OSError,ValueError): pass\nwith open('/workspace/zombies.json','w') as f: json.dump(zombies,f)\n";
      assert((await desktop.request('launch', { executable: '/usr/bin/python3', args: ['-c', script] })).ok);
      const filename = path.join(desktop.workspace, 'zombies.json'), deadline = Date.now() + 3000;
      let zombies;
      while (Date.now() < deadline) { try { zombies = JSON.parse(await readFile(filename, 'utf8')); break; } catch {} await pause(20); }
      assert.deepEqual(zombies, []);
    });
    await test('network-enabled desktops share real loopback HTTP but keep X11, input and previews separate', async () => {
      const server = await startLoopbackFixture(path.join(work, 'network-http'));
      let first, second;
      try {
        first = await startDesktop(path.join(work, 'network-first'), executable, { shareNetwork: true }); desktops.push(first);
        second = await startDesktop(path.join(work, 'network-second'), executable, { shareNetwork: true }); desktops.push(second);
        const chrome = suffix => ({ executable: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--password-store=basic', '--user-data-dir=/home/bot/chrome', '--window-size=1200,760', '--window-position=0,0', '--app=http://127.0.0.1:' + server.port + '/' + suffix + '.html'] });
        assert((await first.request('launch', chrome('a'))).ok); assert((await second.request('launch', chrome('b'))).ok);
        const [firstPage, secondPage] = await Promise.all([waitTitle(t => t.startsWith('Network desktop A'), 50000, first), waitTitle(t => t.startsWith('Network desktop B'), 50000, second)]);
        assert.notEqual(hash(Buffer.from(firstPage.png, 'base64')), hash(Buffer.from(secondPage.png, 'base64')));
        assert((await first.request('click', { x: 200, y: 200 })).ok); await pause(300); assert((await first.request('type', { text: 'A 独立输入' })).ok);
        await waitTitle(t => t.includes('text=A 独立输入'), 8000, first);
        const unaffected = await second.request('observe'); assert(unaffected.ok); assert.match(unaffected.result.windowTitle, /^Network desktop B \| text= \|/);
        assert((await second.request('click', { x: 200, y: 200 })).ok); await pause(300); assert((await second.request('type', { text: 'B 独立输入' })).ok);
        const [a, b] = await Promise.all([waitTitle(t => t.includes('text=A 独立输入'), 8000, first), waitTitle(t => t.includes('text=B 独立输入'), 8000, second)]);
        await writeFile(path.join(work, 'network-desktop-a.png'), Buffer.from(a.png, 'base64')); await writeFile(path.join(work, 'network-desktop-b.png'), Buffer.from(b.png, 'base64'));
        assert((await first.request('preview', { enabled: true })).ok); assert((await second.request('preview', { enabled: true })).ok);
        const counts = [first.frames.length, second.frames.length]; await pause(900);
        assert(first.frames.length - counts[0] >= 15); assert(second.frames.length - counts[1] >= 15);
        assert.equal((await first.close()).code, 0); const surviving = await second.request('observe'); assert(surviving.ok); assert(surviving.result.windowTitle.includes('B 独立输入'));
        await writeFile(path.join(work, 'network-isolation.json'), JSON.stringify({ loopbackPort: server.port, firstTitle: a.windowTitle, secondTitle: b.windowTitle, concurrentFrames: [first.frames.length - counts[0], second.frames.length - counts[1]], secondSurvivedFirstShutdown: true }, null, 2));
      } finally { if (first?.child.exitCode === null) await first.close(true); if (second?.child.exitCode === null) await second.close(true); await server.close(); }
    });
    await test('stdin EOF stops preview and kills detached descendants', async () => {
      const marker = 'desktop-child-' + randomUUID();
      const script = `import os,time\npid=os.fork()\nif pid==0:\n os.setsid()\n while True:\n  with open('/workspace/${marker}.txt','a') as f:f.write('tick\\n')\n  time.sleep(0.05)\nelse:\n time.sleep(120)\n`;
      assert((await desktop.request('launch', { executable: '/usr/bin/python3', args: ['-c', script] })).ok);
      const heartbeat = path.join(desktop.workspace, marker + '.txt'), deadline = Date.now() + 3000;
      while (Date.now() < deadline) { try { if ((await stat(heartbeat)).size) break; } catch {} await pause(25); }
      assert((await stat(heartbeat)).size > 0); assert((await desktop.request('preview', { enabled: true })).ok);
      const begin = Date.now(); assert.equal((await desktop.close(true)).code, 0); assert(Date.now() - begin < 3000);
      const before = (await stat(heartbeat)).size; await pause(250); assert.equal((await stat(heartbeat)).size, before);
    });
    await test('all stdout was valid NDJSON and helper diagnostics stayed bounded', async () => {
      for (const session of desktops) { assert.deepEqual(session.errors, []); assert(session.stderr.length < 16384); }
    });
    await test('PID/starttime and private-namespace tracking confirms no desktop process remains', async () => {
      const traces = [];
      for (const session of desktops) {
        const trace = JSON.parse(await readFile(session.processTreePath, 'utf8'));
        assert(trace.root?.pid > 0 && trace.root?.starttime); assert(trace.tracked.length > 0); assert.deepEqual(trace.remaining, []);
        for (const row of trace.tracked) assert(row.pid > 0 && row.starttime);
        traces.push({ root: session.root, rootIdentity: { pid: trace.root.pid, starttime: trace.root.starttime }, trackedCount: trace.tracked.length, privateNamespaces: trace.privateNamespaces, commands: [...new Set(trace.tracked.map(row => row.comm))], detachedChildObserved: trace.tracked.some(row => row.detached), remaining: trace.remaining });
      }
      assert(traces.some(trace => trace.commands.includes('Xvfb'))); assert(traces.some(trace => trace.commands.includes('chrome'))); assert(traces.some(trace => trace.commands.includes('ffmpeg'))); assert(traces.some(trace => trace.detachedChildObserved));
      await writeFile(path.join(work, 'process-cleanup.json'), JSON.stringify({ tracking: 'ancestry plus private PID namespaces, identities are PID and /proc/stat starttime; no argv-path filter', traces }, null, 2));
    });
  } catch (error) { report.push({ name: 'test harness prerequisites', ok: false, error: error.stack }); }
  finally { for (const session of desktops) if (session.child.exitCode === null) await session.close(true).catch(() => session.child.kill()); }
  const result = { passed: report.filter(row => row.ok).length, total: report.length, executable, work, report };
  await writeFile(path.join(outputRoot, 'linux-desktop-report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result.passed, total: result.total, report: path.join(outputRoot, 'linux-desktop-report.json'), work }));
  if (result.passed !== result.total) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
