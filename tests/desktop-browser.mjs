// Real retained UI -> native desktop API -> WSL/bwrap -> Linux Chrome.
// Synthetic data, separate browser profiles, and file:///workspace fixtures only.
// No UI edits, API mocking, user accounts, external websites, or real Bot data.
// Run only after the native executable and Linux helper have been built:
// node tests/desktop-browser.mjs [--exe path] [--helper path] [--distro name]
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
    assert(process.argv[index]?.startsWith('--') && process.argv[index + 1], 'Arguments are --name value pairs');
    options.set(process.argv[index].slice(2), process.argv[index + 1]);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runId = `desktop-ui-${Date.now().toString(36)}`;
const output = resolve(options.get('output') || join(project, 'outputs/phase4-desktop-ui', stamp));
const executable = resolve(options.get('exe') || join(project, 'outputs/build/DImensionagent-native.exe'));
const helper = resolve(options.get('helper') || join(project, 'outputs/linux/dimension-desktop-helper'));
const ui = resolve(options.get('ui') || join(project, 'ui'));
const wsl = options.get('wsl') || 'C:/Windows/System32/wsl.exe';
const distro = options.get('distro') || 'dimension-sandbox';
const chrome = options.get('chrome') || 'D:/工具/chrome-win64/chrome.exe';
const sampleMs = Number(options.get('sample-ms') || 6000);
const minFps = Number(options.get('min-fps') || 27);
assert(output.startsWith(resolve(project, 'outputs') + (process.platform === 'win32' ? '\\' : '/')), 'All test output, profiles, and temporary files must remain in the isolated project outputs directory');
assert(sampleMs >= 3000 && sampleMs <= 30000 && minFps > 0 && minFps <= 30);

const bots = [
    { id: `${runId}-a`, name: '离线桌面测试甲', label: 'ALPHA', identity: [232, 42, 74], text: `甲方中文输入：你好，Linux！ ${runId}` },
    { id: `${runId}-b`, name: '离线桌面测试乙', label: 'BETA', identity: [50, 84, 238], text: `乙方独立输入：中文与登录隔离 ${runId}` },
];
const colors = { clicked: [245, 185, 25], typed: [45, 205, 85], entered: [178, 80, 220], idle: [80, 80, 80] };
const children = [], checks = [], screenshots = [], failures = [], exceptions = [], requests = [], responses = [], blockedExternal = [];
const linuxEvidence = [], streams = [], cleanup = [], createdBots = [];
const fingerprints = {};
const processTrackers = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let origin, cdp, native, success = false, streamTask;

async function waitFor(fn, label, timeout = 20000) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
        try { const value = await fn(); if (value) return value; }
        catch (error) { if (error.fatal) throw error; last = error; }
        await delay(100);
    }
    throw new Error(`Timeout: ${label}${last ? ` (${last.message})` : ''}`);
}
function start(label, command, args) {
    const child = spawn(command, args, { cwd: output, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, TEMP: join(output, 'temp'), TMP: join(output, 'temp') } });
    const entry = { label, child, records: [], stdout: '', stderr: '', startError: null };
    children.push(entry);
    child.on('error', error => { entry.startError = error; });
    child.stdout.on('data', data => { entry.stdout += data; });
    child.stderr.on('data', data => { entry.stderr += data; });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => { try { entry.records.push(JSON.parse(line)); } catch {} });
    child.on('exit', () => lines.close());
    return entry;
}
async function api(path, method = 'GET', body) {
    const response = await fetch(origin + path, { method, headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000) });
    const text = await response.text();
    assert(response.ok, `${method} ${path}: HTTP ${response.status} ${text.slice(0, 2000)}`);
    return text ? JSON.parse(text) : null;
}
const base = bot => `/api/dimension/work/desktops/${encodeURIComponent(bot.id)}`;
const status = bot => api(base(bot));
function pass(name, details) { checks.push({ name, details }); console.log(`PASS ${name}`); }
function near(actual, expected, tolerance = 35) { return actual?.length >= 3 && expected.every((value, index) => Math.abs(value - actual[index]) <= tolerance); }

class Cdp {
    constructor(socket) {
        this.socket = socket; this.sequence = 0; this.pending = new Map(); this.listeners = new Map();
        socket.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (message.id) {
                const item = this.pending.get(message.id); if (!item) return;
                clearTimeout(item.timer); this.pending.delete(message.id);
                message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
            } else for (const handler of this.listeners.get(message.method) || []) {
                Promise.resolve(handler(message.params)).catch(error => exceptions.push(error.stack));
            }
        });
        socket.addEventListener('close', () => {
            for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('CDP closed')); }
            this.pending.clear();
        });
    }
    on(method, handler) { const rows = this.listeners.get(method) || []; rows.push(handler); this.listeners.set(method, rows); }
    call(method, params = {}) {
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timeout`)); }, 20000);
            this.pending.set(id, { resolve, reject, timer });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }
    async evaluate(expression) {
        const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
    }
}
async function click(selector) {
    let previous;
    const point = await waitFor(async () => {
        const point = await cdp.evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled||n.hidden)return null;n.scrollIntoView({block:'center',inline:'nearest'});const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,top=document.elementFromPoint(x,y);return r.width&&r.height&&top&&(top===n||n.contains(top))?{x,y}:null})()`);
        const stable = point && previous && Math.abs(point.x - previous.x) < .5 && Math.abs(point.y - previous.y) < .5;
        previous = point; return stable ? point : null;
    }, `clickable ${selector}`);
    await mouseClick(point);
}
async function mouseClick(point) {
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}
async function fill(selector, text) {
    await click(selector);
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await cdp.call('Input.insertText', { text });
}
async function selectBot(bot) {
    await waitFor(() => cdp.evaluate(`!!document.querySelector('.ld-bot')&&!document.querySelector('.ld-bot').disabled`), 'Bot selector idle');
    await cdp.evaluate(`(()=>{const n=document.querySelector('.ld-bot');n.value=${JSON.stringify(bot.id)};n.dispatchEvent(new Event('change',{bubbles:true}))})()`);
}
async function remoteClick(x, y) {
    const state = await imageState();
    assert(state && Number.isFinite(state.contentOffsetY), 'Fixture content is located before clicking');
    const point = await cdp.evaluate(`(()=>{const n=document.querySelector('.ld-screen');n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return{x:r.left+${x}/1280*r.width,y:r.top+${y + state.contentOffsetY}/800*r.height}})()`);
    await mouseClick(point);
}
async function imageState() {
    // Kiosk can still expose a Chrome command-line warning. Locate the fixture
    // by its long, solid identity stripe rather than assuming content starts at y=0.
    return cdp.evaluate(`(()=>{const n=document.querySelector('.ld-screen');if(!n||n.hidden||!n.naturalWidth||!n.getAttribute('src'))return null;const c=document.createElement('canvas');c.width=n.naturalWidth;c.height=n.naturalHeight;const x=c.getContext('2d');x.drawImage(n,0,0);const pixel=(a,b)=>Array.from(x.getImageData(a,b,1,1).data),height=Math.min(240,c.height),strip=x.getImageData(40,0,1,height).data,colors=${JSON.stringify(bots.map(bot => bot.identity))};let found=-1,streak=0,last=-1;for(let y=0;y<height;y++){const color=colors.findIndex(rgb=>rgb.every((value,i)=>Math.abs(value-strip[y*4+i])<=35));streak=color>=0&&color===last?streak+1:color>=0?1:0;last=color;if(streak>=12){found=y-streak+1;break}}const row=found>=0?found+16:40;return{width:c.width,height:c.height,src:n.getAttribute('src'),contentOffsetY:found>=0?found-24:null,identity:pixel(40,row),clicked:pixel(440,row),typed:pixel(640,row),entered:pixel(840,row)}})()`);
}
async function frameFor(bot, extra = () => true, label = 'live fixture frame') {
    return waitFor(async () => {
        const errorText = await cdp.evaluate(`document.querySelector('.ld-error')?.textContent.trim()||''`);
        if (errorText) throw Object.assign(new Error(`Desktop UI error: ${errorText}`), { fatal: true });
        const state = await imageState();
        return state && near(state.identity, bot.identity) && extra(state) ? state : null;
    }, `${bot.label}: ${label}`, 45000);
}
async function takeControl(bot) {
    if (!(await status(bot)).humanControl) await click('.ld-control');
    await waitFor(async () => (await status(bot)).humanControl === true, `${bot.label} human takeover`);
    await waitFor(() => cdp.evaluate(`document.querySelector('.ld-state').textContent.includes('自动操作已暂停')`), `${bot.label} takeover shown in retained UI`);
}
async function screenshot(name) {
    const { data } = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const path = join(output, `${name}.png`); await writeFile(path, Buffer.from(data, 'base64')); screenshots.push(path);
}

function fixture(bot) {
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Offline ${bot.label} ${runId}</title>
<style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#18202c;color:#fff;font:22px sans-serif}.box{position:absolute;top:24px;width:160px;height:80px;border:0;border-radius:0}.label{position:absolute;top:110px;font-size:17px}#identity{left:24px;background:rgb(${bot.identity.join(',')})}#tap{left:224px;background:rgb(0,180,210);cursor:pointer}#clicked{left:424px}#typed{left:624px}#entered{left:824px}.proof{background:rgb(80,80,80)}textarea{position:absolute;left:24px;top:170px;width:1100px;height:210px;background:#fff;color:#111;font:28px sans-serif;padding:15px;resize:none}#report{position:absolute;left:24px;top:405px;white-space:pre-wrap;width:1120px}canvas{position:absolute;left:24px;top:630px}h1{margin:24px 0 0 1000px;font-size:30px}</style>
<div id="identity" class="box"></div><button id="tap" class="box" aria-label="Click fixture button"></button><div id="clicked" class="box proof"></div><div id="typed" class="box proof"></div><div id="entered" class="box proof"></div>
<div class="label" style="left:24px">${bot.label} 独立桌面</div><div class="label" style="left:224px">点击此色块</div><div class="label" style="left:424px">点击成功</div><div class="label" style="left:624px">中文完整匹配</div><div class="label" style="left:824px">Enter 已收到</div><h1>OFFLINE</h1>
<textarea id="text" aria-label="Remote fixture text"></textarea><pre id="report"></pre><canvas width="1100" height="90" id="motion"></canvas>
<script>const expected=${JSON.stringify(bot.text)},input=document.querySelector('#text');let taps=0,enters=0;const update=()=>{document.querySelector('#clicked').style.background=taps?'rgb(245,185,25)':'rgb(80,80,80)';document.querySelector('#typed').style.background=input.value.includes(expected)?'rgb(45,205,85)':'rgb(80,80,80)';document.querySelector('#entered').style.background=enters&&input.value.includes('\\n')?'rgb(178,80,220)':'rgb(80,80,80)';document.querySelector('#report').textContent='${bot.label} · 点击 '+taps+' 次 · Enter '+enters+' 次\\n实际文本：'+input.value};document.querySelector('#tap').onclick=()=>{taps++;update()};input.oninput=update;input.onkeydown=e=>{if(e.key==='Enter'){enters++;setTimeout(update,0)}};const c=document.querySelector('#motion').getContext('2d');let step=0;function animate(){step++;c.fillStyle='#304250';c.fillRect(0,0,1100,90);c.fillStyle=step%2?'#ffdc50':'#50dcff';c.fillRect((step*7)%1000,0,100,90);c.fillStyle='white';c.font='24px sans-serif';c.fillText('Local animation frame '+step,240,55);requestAnimationFrame(animate)}update();animate();</script></html>`;
}

function jpegDimensions(bytes) {
    assert(bytes[0] === 255 && bytes[1] === 216, 'Frame begins with JPEG SOI');
    for (let index = 2; index + 9 < bytes.length;) {
        if (bytes[index] !== 255) { index++; continue; }
        while (bytes[index] === 255) index++;
        const marker = bytes[index++];
        if (marker === 216 || marker === 217 || marker === 1 || (marker >= 208 && marker <= 215)) continue;
        if (index + 2 > bytes.length) break;
        const length = bytes.readUInt16BE(index);
        if (length < 2 || index + length > bytes.length) break;
        if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) return { width: bytes.readUInt16BE(index + 5), height: bytes.readUInt16BE(index + 3) };
        if (marker === 218) break;
        index += length;
    }
    throw new Error('JPEG frame has no supported SOF dimensions');
}
async function measureStream(bot, phase = 'single-input') {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), sampleMs + 15000);
    let reader, buffer = Buffer.alloc(0), firstFrame, lastFrame;
    const times = [], hashes = new Set(); let totalBytes = 0, contentType, dimensions;
    try {
        const response = await fetch(origin + base(bot) + `/stream?view=browser-test&t=${Date.now()}`, { signal: controller.signal });
        assert.equal(response.status, 200);
        contentType = response.headers.get('content-type') || '';
        assert(/^multipart\/x-mixed-replace\b/i.test(contentType), `Expected MJPEG MIME, received ${contentType}`);
        const match = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
        assert(match, 'MJPEG response declares a boundary');
        const boundary = Buffer.from('--' + (match[1] || match[2]));
        reader = response.body.getReader();
        while (times.length < 2 || times.at(-1) - times[0] < sampleMs) {
            const chunk = await reader.read(); assert(!chunk.done, 'Stream remained open during measurement');
            totalBytes += chunk.value.length; buffer = Buffer.concat([buffer, chunk.value]);
            assert(buffer.length < 32 * 1024 * 1024, 'Bounded multipart receive buffer');
            while (true) {
                const start = buffer.indexOf(boundary); if (start < 0) break;
                if (start) buffer = buffer.subarray(start);
                const headerEnd = buffer.indexOf('\r\n\r\n'); if (headerEnd < 0) break;
                const header = buffer.subarray(boundary.length, headerEnd).toString('ascii');
                assert(/content-type:\s*image\/jpeg/i.test(header), 'Multipart frame declares image/jpeg');
                const lengthMatch = /content-length:\s*(\d+)/i.exec(header);
                const payloadStart = headerEnd + 4;
                let payloadEnd;
                if (lengthMatch) {
                    payloadEnd = payloadStart + Number(lengthMatch[1]);
                    if (buffer.length < payloadEnd) break;
                } else {
                    const next = buffer.indexOf(boundary, payloadStart); if (next < 0) break;
                    payloadEnd = next;
                    if (buffer[payloadEnd - 2] === 13 && buffer[payloadEnd - 1] === 10) payloadEnd -= 2;
                }
                const frame = Buffer.from(buffer.subarray(payloadStart, payloadEnd));
                assert(frame.at(-2) === 255 && frame.at(-1) === 217, 'Frame ends with JPEG EOI');
                dimensions ||= jpegDimensions(frame);
                firstFrame ||= frame; lastFrame = frame;
                hashes.add(createHash('sha256').update(frame).digest('hex')); times.push(performance.now());
                buffer = buffer.subarray(payloadEnd);
            }
        }
    } finally { clearTimeout(timeout); await reader?.cancel().catch(() => {}); controller.abort(); }
    assert.deepEqual(dimensions, { width: 1280, height: 800 });
    const gaps = times.slice(1).map((time, index) => time - times[index]);
    const sorted = [...gaps].sort((a, b) => a - b);
    const prefix = `mjpeg-${bot.label.toLowerCase()}-${phase}`;
    const result = { botId: bot.id, phase, targetFps: 30, acceptanceMinFps: minFps, frames: times.length, distinctFrames: hashes.size,
        durationMs: times.at(-1) - times[0], averageFps: (times.length - 1) * 1000 / (times.at(-1) - times[0]),
        p50GapMs: sorted[Math.floor(sorted.length * .50)], p95GapMs: sorted[Math.floor(sorted.length * .95)],
        maxGapMs: Math.max(...gaps), bytes: totalBytes, dimensions, contentType,
        firstFrameFile: join(output, `${prefix}-first.jpg`), lastFrameFile: join(output, `${prefix}-last.jpg`) };
    streams.push(result);
    await writeFile(result.firstFrameFile, firstFrame); await writeFile(result.lastFrameFile, lastFrame);
    assert(hashes.size > 10, 'Offline animation produces genuinely changing frames');
    assert(result.averageFps >= minFps, `Measured ${result.averageFps.toFixed(2)} FPS, below smoke threshold ${minFps} for the 30 FPS target`);
    return result;
}

async function linuxSnapshot(label) {
    const probe = `import os,json
rows=[]
for name in os.listdir('/proc'):
 if not name.isdigit(): continue
 try:
  raw=open('/proc/'+name+'/stat').read();end=raw.rfind(')');fields=raw[end+2:].split()
  try: namespace=os.readlink('/proc/'+name+'/ns/pid')
  except OSError: namespace=None
  try: command=open('/proc/'+name+'/cmdline','rb').read().replace(b'\\0',b' ').decode('utf-8','replace')
  except OSError: command=''
  rows.append({'pid':int(name),'ppid':int(fields[1]),'starttime':fields[19],'state':fields[0],'comm':raw[raw.find('(')+1:end],'namespace':namespace,'command':command})
 except (OSError,IndexError,ValueError): pass
print(json.dumps({'hostNamespace':os.readlink('/proc/self/ns/pid'),'processes':rows}))
`;
    const result = await execFileAsync(wsl, ['--distribution', distro, '--exec', '/usr/bin/python3', '-c', probe],
        { cwd: output, windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, TEMP: join(output, 'temp'), TMP: join(output, 'temp') } });
    const snapshot = JSON.parse(result.stdout);
    const rows = snapshot.processes; rows.hostNamespace = snapshot.hostNamespace;
    // Persist only this test's process trees; no unrelated command lines in artifacts.
    const selected = new Map();
    for (const bot of bots) for (const row of linuxTree(rows, bot)) selected.set(row.pid, row);
    linuxEvidence.push({ label, at: new Date().toISOString(), processes: [...selected.values()] });
    return rows;
}
function linuxTree(rows, bot) {
    let tracker = processTrackers.get(bot.id);
    if (!tracker) { tracker = { known: new Map(), privateNamespaces: new Set() }; processTrackers.set(bot.id, tracker); }
    const byPid = new Map(rows.map(row => [row.pid, row]));
    // Native storage may hash Bot IDs. Match the actual bind-mounted workspace
    // returned by status instead of assuming a particular directory naming scheme.
    const windowsWorkspace = bot.workspace?.replaceAll('\\', '/');
    const linuxWorkspace = windowsWorkspace && /^[a-z]:\//i.test(windowsWorkspace)
        ? `/mnt/${windowsWorkspace[0].toLowerCase()}${windowsWorkspace.slice(2)}` : null;
    const roots = new Set([...tracker.known.values()].filter(row => byPid.get(row.pid)?.starttime === row.starttime).map(row => row.pid));
    if (!tracker.known.size) for (const row of rows) {
        if (row.command.includes(bot.id) || (linuxWorkspace && row.command.includes(linuxWorkspace))) roots.add(row.pid);
    }
    const addNamespace = row => { if (row?.namespace && row.namespace !== rows.hostNamespace) tracker.privateNamespaces.add(row.namespace); };
    for (const pid of roots) addNamespace(byPid.get(pid));
    let added;
    do {
        added = false;
        for (const row of rows) if (!roots.has(row.pid) && (roots.has(row.ppid) || tracker.privateNamespaces.has(row.namespace))) {
            roots.add(row.pid); addNamespace(row); added = true;
        }
    } while (added);
    const selected = rows.filter(row => roots.has(row.pid));
    for (const row of selected) {
        const key = `${row.pid}:${row.starttime}`, prior = tracker.known.get(key);
        tracker.known.set(key, { ...row, firstSeen: prior?.firstSeen || Date.now(), lastSeen: Date.now(), detached: Boolean(prior?.detached || (prior && prior.ppid !== row.ppid)) });
    }
    return selected;
}
async function assertGone(bot, tracked) {
    assert(tracked.length > 0, `${bot.label}: Linux process tree is identifiable for cleanup verification`);
    const identities = new Set(tracked.map(row => `${row.pid}:${row.starttime}`));
    await waitFor(async () => {
        const rows = await linuxSnapshot(`waiting-${bot.label}-stop`);
        return !rows.some(row => identities.has(`${row.pid}:${row.starttime}`)) && linuxTree(rows, bot).length === 0;
    }, `${bot.label}: helper, X server, WM and Chrome process tree exit`, 30000);
    const tracker = processTrackers.get(bot.id);
    cleanup.push({ botId: bot.id, tracked: [...tracker.known.values()], privateNamespaces: [...tracker.privateNamespaces], remaining: [] });
}
async function shutdown(entry) {
    if (entry.child.exitCode !== null || !entry.child.pid) return;
    const exited = once(entry.child, 'exit');
    if (entry.label === 'browser') await cdp?.call('Browser.close').catch(() => {});
    else entry.child.stdin.end('shutdown\n');
    if (!(await Promise.race([exited.then(() => true), delay(5000).then(() => false)]))) {
        await execFileAsync('taskkill', ['/PID', String(entry.child.pid), '/T', '/F'], { windowsHide: true, cwd: output }).catch(() => {});
        await Promise.race([exited, delay(3000)]);
    }
}

await mkdir(join(output, 'temp'), { recursive: true });
try {
    for (const [label, path] of [['native', executable], ['helper', helper]]) {
        fingerprints[label] = { path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') };
    }
    native = start('native', executable, ['--data', join(output, 'data'), '--ui', ui, '--port', '0', '--wsl', wsl,
        '--sandbox-distro', distro, '--desktop-helper', helper]);
    const ready = await waitFor(() => { if (native.startError) throw native.startError; return native.records.find(row => row.ready); }, 'new native desktop server ready', 30000);
    origin = `http://127.0.0.1:${ready.port}`;
    for (const bot of bots) {
        await api('/api/dimension/bots', 'POST', { id: bot.id, name: bot.name, persona: 'Synthetic offline desktop browser test only.' });
        createdBots.push(bot);
        await api('/api/dimension/work/settings', 'PATCH', { botId: bot.id, networkAccess: false });
        const state = await status(bot);
        assert.equal(state.running, false); assert.equal(state.networkAccess, false);
        assert(Array.isArray(state.apps)); assert(isAbsolute(state.workspace), 'Desktop status returns an absolute Windows workspace');
        const within = relative(output, resolve(state.workspace));
        assert(within && !within.startsWith('..') && !isAbsolute(within), 'Fixture workspace stays inside this test output');
        bot.workspace = state.workspace;
        await mkdir(bot.workspace, { recursive: true });
        await writeFile(join(bot.workspace, 'fixture.html'), fixture(bot), 'utf8');
    }
    await api('/api/dimension/work/software', 'PUT', { apps: [{ id: 'offline-chrome', name: 'Offline Chrome fixture', executable: '/usr/bin/google-chrome', args: ['--kiosk', 'file:///workspace/fixture.html'] }] });
    await linuxSnapshot('before-launch');

    const profile = join(output, 'browser-profile');
    const browser = start('browser', chrome, ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
        `--user-data-dir=${profile}`, '--window-size=1440,1200', '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-extensions',
        '--disable-client-side-phishing-detection', '--disable-breakpad', '--disable-features=OptimizationHints,MediaRouter',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', 'about:blank']);
    const port = await waitFor(async () => { if (browser.startError) throw browser.startError; return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }, 'isolated browser CDP ready');
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(row => row.type === 'page');
    assert(target);
    const socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, 'open'); cdp = new Cdp(socket);
    cdp.on('Runtime.exceptionThrown', value => exceptions.push(value.exceptionDetails.exception?.description || value.exceptionDetails.text));
    cdp.on('Network.requestWillBeSent', value => {
        if (value.request.url.includes('/api/')) requests.push({ url: value.request.url, method: value.request.method, body: value.request.postData });
    });
    cdp.on('Network.responseReceived', value => responses.push({ url: value.response.url, status: value.response.status, mimeType: value.response.mimeType }));
    cdp.on('Fetch.requestPaused', async value => {
        const url = new URL(value.request.url);
        if (['data:', 'blob:', 'about:'].includes(url.protocol) || ['127.0.0.1', 'localhost'].includes(url.hostname)) await cdp.call('Fetch.continueRequest', { requestId: value.requestId });
        else { blockedExternal.push(value.request.url); await cdp.call('Fetch.failRequest', { requestId: value.requestId, errorReason: 'BlockedByClient' }); }
    });
    for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable']) await cdp.call(method);
    await cdp.call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
    await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('dimension.sidebarPrefs.v1',${JSON.stringify(JSON.stringify({ chatBots: bots.map(bot => bot.id), workBots: bots.map(bot => bot.id) }))});` });
    await cdp.call('Page.navigate', { url: origin + '/dimension-ui/' });
    await click(`#botList [data-id="${bots[0].id}"]`);
    await click('#sharedSoftwareBtn');
    await waitFor(() => cdp.evaluate(`document.querySelector('.ld-app')?.value==='offline-chrome'`), 'public fixture software list');
    await click('.ld-launch');
    const first = await frameFor(bots[0]);
    assert.deepEqual({ width: first.width, height: first.height }, { width: 1280, height: 800 });
    assert.equal((await status(bots[0])).previewFps, 30);
    await waitFor(() => cdp.evaluate(`document.querySelector('.ld-screen').getAttribute('src').includes('/stream?')`), 'retained UI continuous stream');
    await screenshot('01-alpha-real-preview');
    pass('Public software launches real isolated Linux Chrome and the retained UI decodes its 1280×800 stream');

    if ((await status(bots[0])).humanControl) {
        await click('.ld-control');
        await waitFor(async () => !(await status(bots[0])).humanControl, 'initial automatic control');
    }
    await takeControl(bots[0]);
    streamTask = measureStream(bots[0]).then(value => ({ value }), error => ({ error }));
    await remoteClick(300, 65);
    await frameFor(bots[0], state => near(state.clicked, colors.clicked), 'click reaches offline Linux page');
    await remoteClick(220, 240);
    await fill('.ld-text', bots[0].text); await click('.ld-paste');
    await frameFor(bots[0], state => near(state.typed, colors.typed), 'full Chinese string reaches Linux textarea');
    await click('.ld-enter');
    await frameFor(bots[0], state => near(state.entered, colors.entered), 'Return reaches Linux textarea');
    await screenshot('02-alpha-chinese-input');
    pass('Human takeover, pointer click, complete Chinese text, and Return traverse the real remote input path');
    const measured = await streamTask; streamTask = null; if (measured.error) throw measured.error;
    pass('Real MJPEG changes continuously while user input is active', measured.value);

    await click('.ld-close');
    await waitFor(async () => { const state = await status(bots[0]); return state.running && state.humanControl === false; }, 'closing preview releases control and keeps Chrome running');
    assert.equal(await cdp.evaluate(`document.querySelector('.linux-desktop-dialog').open`), false);
    await click('#sharedSoftwareBtn');
    await frameFor(bots[0], state => near(state.typed, colors.typed) && near(state.entered, colors.entered), 'reopen preserves page and text');
    pass('Closing preview returns human control while preserving the live desktop and entered text');

    await takeControl(bots[0]);
    await selectBot(bots[1]);
    await waitFor(async () => (await status(bots[0])).humanControl === false, 'switch releases Alpha');
    await waitFor(() => cdp.evaluate(`document.querySelector('.ld-screen').hidden && !document.querySelector('.ld-screen').hasAttribute('src')`), 'stopped Beta shows no stale Alpha image');
    await click('.ld-launch');
    await frameFor(bots[1], state => near(state.clicked, colors.idle) && near(state.typed, colors.idle), 'Beta starts with its own empty fixture');
    await takeControl(bots[1]);
    await remoteClick(300, 65); await remoteClick(220, 240);
    await fill('.ld-text', bots[1].text); await click('.ld-paste');
    await frameFor(bots[1], state => near(state.clicked, colors.clicked) && near(state.typed, colors.typed), 'Beta receives its distinct Chinese string');
    await screenshot('03-beta-isolated-input');
    const dualSamples = await Promise.allSettled(bots.map(bot => measureStream(bot, 'dual-desktop')));
    for (const sample of dualSamples) if (sample.status === 'rejected') throw sample.reason;
    pass('Both live Linux Chrome desktops stream changing frames concurrently at the measured rate', dualSamples.map(sample => sample.value));
    const both = await linuxSnapshot('two-live-desktops');
    const tracked = bots.map(bot => linuxTree(both, bot));
    for (let index = 0; index < bots.length; index++) assert(tracked[index].length > 0, `${bots[index].label} sandbox process tree visible`);
    assert(!tracked[0].some(row => tracked[1].some(other => row.pid === other.pid)), 'Bot sandbox process trees are disjoint');
    await selectBot(bots[0]);
    await waitFor(async () => !(await status(bots[1])).humanControl, 'switch releases Beta');
    await frameFor(bots[0], state => near(state.typed, colors.typed) && near(state.entered, colors.entered), 'Alpha retained its own input after Beta activity');
    await screenshot('04-alpha-retained-after-switch');
    pass('Two live Bot desktops, control ownership, streamed frames, and Chinese input stay isolated');

    await click('.ld-stop');
    await waitFor(async () => !(await status(bots[0])).running, 'Alpha stopped');
    assert.equal((await status(bots[1])).running, true, 'Stopping Alpha leaves Beta running');
    await assertGone(bots[0], tracked[0]);
    await selectBot(bots[1]);
    await frameFor(bots[1], state => near(state.typed, colors.typed), 'Beta still displays its own text after Alpha stop');
    await screenshot('05-beta-survives-alpha-stop');
    await click('.ld-stop');
    await waitFor(async () => !(await status(bots[1])).running, 'Beta stopped');
    await assertGone(bots[1], tracked[1]);
    await screenshot('06-both-desktops-stopped');
    await click('.ld-close');
    pass('Stopping one desktop preserves the other and stopping both removes their tracked Linux process trees', cleanup);

    const actionBodies = requests.filter(row => row.url.includes('/work/desktops/') && row.url.endsWith('/action')).map(row => JSON.parse(row.body || '{}'));
    for (const op of ['observe', 'launch', 'click', 'type', 'press']) assert(actionBodies.some(row => row.action?.op === op), `Retained UI sent ${op}`);
    assert(actionBodies.some(row => row.fastInput === true && row.action?.op === 'type'), 'Input runs through the stream-aware frontend path');
    assert.deepEqual(responses.filter(row => row.status >= 400 && /\/work\/(desktops|software|settings)/.test(row.url)), [], 'No failed desktop UI requests');
    assert.deepEqual(exceptions, [], 'No browser exceptions');
    assert.deepEqual(blockedExternal, [], 'Retained UI makes no external requests for these workflows');
    success = true;
} catch (error) {
    failures.push(error.stack); console.error(error.stack); process.exitCode = 1;
    if (cdp) {
        await screenshot('failure').catch(() => {});
        await writeFile(join(output, 'failure-dom.txt'), await cdp.evaluate('document.body.innerText').catch(() => ''), 'utf8');
        await writeFile(join(output, 'failure-image-state.json'), JSON.stringify(await imageState().catch(() => null), null, 2));
    }
} finally {
    if (streamTask) await streamTask;
    if (origin && native?.child.exitCode === null) {
        for (const bot of createdBots) await api(base(bot) + '/stop', 'POST', {}).catch(error => failures.push(`Cleanup ${bot.id}: ${error.message}`));
        const remaining = await linuxSnapshot('final-after-stop').catch(error => { failures.push(`Cleanup process inspection: ${error.message}`); return null; });
        if (remaining) for (const bot of createdBots) {
            const rows = linuxTree(remaining, bot);
            if (rows.length) failures.push(`Cleanup left ${rows.length} Linux processes for ${bot.id}`);
        }
    }
    for (const entry of [...children].reverse()) await shutdown(entry).catch(error => failures.push(`Shutdown ${entry.label}: ${error.message}`));
    for (const entry of children) await writeFile(join(output, `${entry.label}.log`), entry.stdout + '\nSTDERR\n' + entry.stderr, 'utf8');
    if (failures.length || exceptions.length) { success = false; process.exitCode = 1; }
    const processes = children.map(entry => ({ label: entry.label, pid: entry.child.pid, exitCode: entry.child.exitCode, signal: entry.child.signalCode, error: entry.startError?.message }));
    if (processes.some(entry => entry.pid && entry.exitCode === null && !entry.signal)) { success = false; process.exitCode = 1; failures.push('A started Windows test process did not exit'); }
    await writeFile(join(output, 'result.json'), JSON.stringify({ ok: success, checks, screenshots, streams, cleanup, failures, exceptions, blockedExternal,
        requests, responses, linuxEvidence, processes, fingerprints, fixture: { runId, bots, output, executable, helper, distro, ui },
        scope: 'Synthetic offline pages with real native APIs; no real accounts, external websites, model-provider API calls, package installation, or user profiles.',
        frameRateNote: `Target 30 FPS; configurable smoke floor ${minFps}. Report the actual measured FPS, not merely previewFps:30.` }, null, 2), 'utf8');
    console.log(JSON.stringify({ ok: success, checks: checks.length, output }));
}
