// Original protocol fixtures using only Node's built-in TCP/process/assert APIs.
// Usage: node tests/http-integration.mjs <path-to-http_test.exe>
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

const fixture = process.argv[2];
assert(fixture, 'Pass the native http_test executable');
const child = spawn(resolve(fixture), ['--serve'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const output = [];
let stderr = '';
child.stderr.on('data', bytes => { stderr += bytes; });
const lines = createInterface({ input: child.stdout });
lines.on('line', line => { output.push(JSON.parse(line)); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 3000) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
        assert(Date.now() < deadline, 'Timed out waiting for fixture state');
        assert(child.exitCode === null, `Fixture exited early: ${stderr}`);
        await delay(20);
    }
}

class Client {
    constructor(socket) {
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        this.closed = false;
        this.error = null;
        this.notify = null;
        socket.on('data', bytes => { this.buffer = Buffer.concat([this.buffer, bytes]); this.notify?.(); });
        socket.on('error', error => { this.error = error; this.notify?.(); });
        socket.on('close', () => { this.closed = true; this.notify?.(); });
    }
    static async connect(port) {
        const client = new Client(net.createConnection({ host: '127.0.0.1', port }));
        await once(client.socket, 'connect');
        return client;
    }
    async changed(deadline) {
        assert(Date.now() < deadline, 'TCP read timeout');
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.notify = null; reject(new Error('TCP read timeout')); }, deadline - Date.now());
            this.notify = () => { clearTimeout(timer); this.notify = null; resolve(); };
        });
    }
    async read(length, timeout = 3000) {
        const deadline = Date.now() + timeout;
        while (this.buffer.length < length) {
            assert(!this.closed, `TCP closed with ${this.buffer.length}/${length} bytes: ${this.error?.message ?? ''}`);
            await this.changed(deadline);
        }
        const bytes = this.buffer.subarray(0, length);
        this.buffer = this.buffer.subarray(length);
        return bytes;
    }
    async header(timeout = 3000) {
        const deadline = Date.now() + timeout;
        while (this.buffer.indexOf('\r\n\r\n') < 0) {
            assert(!this.closed, 'TCP closed before response headers');
            await this.changed(deadline);
        }
        return (await this.read(this.buffer.indexOf('\r\n\r\n') + 4)).toString();
    }
    async all(timeout = 3000) {
        const deadline = Date.now() + timeout;
        while (!this.closed) await this.changed(deadline);
        const bytes = this.buffer;
        this.buffer = Buffer.alloc(0);
        return bytes;
    }
    destroy() { this.socket.destroy(); }
    send(bytes) { this.socket.write(bytes); }
}

function frame(opcode, payload = Buffer.alloc(0), { final = true, masked = true, lengthWidth } = {}) {
    if (!Buffer.isBuffer(payload)) payload = Buffer.from(payload);
    const length = payload.length;
    const width = lengthWidth ?? (length < 126 ? 0 : length <= 65535 ? 2 : 8);
    const head = Buffer.alloc(2 + width + (masked ? 4 : 0));
    head[0] = (final ? 128 : 0) | opcode;
    head[1] = (masked ? 128 : 0) | (width === 0 ? length : width === 2 ? 126 : 127);
    if (width === 2) head.writeUInt16BE(length, 2);
    if (width === 8) head.writeBigUInt64BE(BigInt(length), 2);
    if (!masked) return Buffer.concat([head, payload]);
    const mask = Buffer.from([0x83, 0x2a, 0x6c, 0xf1]);
    mask.copy(head, 2 + width);
    const data = Buffer.from(payload);
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    return Buffer.concat([head, data]);
}

async function readFrame(client) {
    const head = await client.read(2);
    assert.equal(head[0] & 128, 128, 'Server sends final frames');
    assert.equal(head[1] & 128, 0, 'Server frames are unmasked');
    let length = head[1] & 127;
    if (length === 126) length = (await client.read(2)).readUInt16BE();
    if (length === 127) length = Number((await client.read(8)).readBigUInt64BE());
    return { opcode: head[0] & 15, payload: await client.read(length) };
}

let port;
let checks = 0;
const check = name => { checks++; console.log(`PASS ${name}`); };
function requestHead(path, { method = 'GET', headers = {}, host = `127.0.0.1:${port}`, body = '' } = {}) {
    const fields = { Host: host, ...headers };
    if (body.length && !Object.keys(fields).some(name => name.toLowerCase() === 'content-length')) fields['Content-Length'] = Buffer.byteLength(body);
    return `${method} ${path} HTTP/1.1\r\n${Object.entries(fields).map(([name, value]) => `${name}: ${value}\r\n`).join('')}\r\n`;
}
async function rawRequest(bytes, timeout = 3000) {
    const client = await Client.connect(port);
    try { client.send(bytes); return (await client.all(timeout)).toString(); }
    finally { client.destroy(); }
}
async function request(path, options = {}) {
    return rawRequest(Buffer.concat([Buffer.from(requestHead(path, options)), Buffer.from(options.body ?? '')]));
}
function status(response) { return Number(response.split(' ', 2)[1]); }
async function metrics() { return JSON.parse((await request('/metrics')).split('\r\n\r\n')[1]); }
const wsFields = { Upgrade: 'websocket', Connection: 'keep-alive, Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' };
async function websocket(extra = Buffer.alloc(0)) {
    const client = await Client.connect(port);
    client.send(Buffer.concat([Buffer.from(requestHead('/ws', { headers: { ...wsFields, Origin: `http://127.0.0.1:${port}` } })), extra]));
    const head = await client.header();
    assert.equal(status(head), 101);
    assert.match(head, /sec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/i);
    return client;
}
async function rejectsFrame(bytes, code) {
    const client = await websocket();
    try {
        client.send(bytes);
        const response = await readFrame(client);
        assert.equal(response.opcode, 8);
        assert.equal(response.payload.readUInt16BE(), code);
        await client.all();
    } finally { client.destroy(); }
}

try {
    await until(() => output.length > 0);
    port = output[0].port;
    assert(port > 0);
    const health = await request('/health');
    assert.equal(status(health), 200);
    assert(health.endsWith('native-http-ok'));
    assert.match(health, /connection: close/i);
    assert(!/access-control-allow-origin/i.test(health));
    assert((await request('/inspect?a=1')).endsWith('GET /inspect /inspect?a=1'));
    check('GET, origin-form path/query, close delimiting, no wildcard CORS');

    const echo = '中文😀'.repeat(1000);
    assert((await request('/echo', { method: 'POST', body: echo })).endsWith(echo));
    const head = await request('/health', { method: 'HEAD' });
    assert.match(head, /content-length: 14/i);
    assert(head.endsWith('\r\n\r\n'));
    assert.equal(status(await request('/throw')), 500);
    assert.equal(status(await request('/invalid-header')), 500);
    check('POST Unicode body, HEAD, route exception, response header injection');

    for (const origin of ['https://untrusted.example', 'null', `http://127.0.0.1:${port + 1}`, `http://localhost:${port}`]) {
        assert.equal(status(await request('/echo', { method: 'POST', headers: { Origin: origin, 'Content-Length': 0 } })), 403);
        assert.equal(status(await request('/sse', { headers: { Origin: origin } })), 403);
        assert.equal(status(await request('/ws', { headers: { ...wsFields, Origin: origin } })), 403);
    }
    assert.equal(status(await request('/health', { host: 'rebinding.example' })), 403);
    assert.equal(status(await request('/health', { headers: { 'Sec-Fetch-Site': 'cross-site' } })), 403);
    assert.equal(status(await request('/health', { host: `localhost:${port}`, headers: { Origin: `http://localhost:${port}` } })), 200);
    assert.equal(status(await request('/health', { headers: { Origin: `http://127.0.0.1:${port}` } })), 200);
    check('Host, Origin and browser fetch-site isolation across POST/SSE/WebSocket');

    for (const extra of ['Content-Length: 0\r\nContent-Length: 0', 'Content-Length: 0, 0', 'Content-Length: +0', 'Transfer-Encoding: chunked', 'Transfer-Encoding: identity\r\nContent-Length: 0', 'X-Bad: one\nInjected: value']) {
        assert.equal(status(await rawRequest(`POST /echo HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${extra}\r\n\r\n`)), 400);
    }
    assert.equal(status(await request('/echo', { method: 'POST', headers: { 'Content-Length': 4194305 } })), 413);
    assert.equal(status(await request('/health', { headers: { 'X-Large': 'x'.repeat(32768) } })), 431);
    assert.equal(status(await request('/echo', { method: 'POST', headers: { Expect: '100-continue', 'Content-Length': 3 } })), 417);
    const boundaryBody = 'a'.repeat(4194304);
    assert((await request('/echo', { method: 'POST', body: boundaryBody })).endsWith(boundaryBody));
    check('Duplicate/ambiguous lengths, TE, malformed headers, 32 KiB and 4 MiB limits');

    const sse = await Client.connect(port);
    sse.send(requestHead('/sse', { headers: { Origin: `http://127.0.0.1:${port}` } }));
    assert.match(await sse.header(), /content-type: text\/event-stream/i);
    const expected = 'id: 0\ndata: event-0\n\nid: 1\ndata: event-1\n\nid: 2\ndata: event-2\n\n';
    assert.equal((await sse.read(Buffer.byteLength(expected))).toString(), expected);
    sse.destroy();
    let state;
    for (let i = 0; i < 30; i++) { state = await metrics(); if (state.streams_stopped === 1) break; await delay(30); }
    assert.equal(state.streams_stopped, 1, 'Disconnect stops a waiting SSE handler without another write');
    check('Continuous SSE framing and passive disconnect stop-token notification');

    const ws = await websocket(frame(1, 'early'));
    assert.equal((await readFrame(ws)).payload.toString(), 'early', 'Frame bytes coalesced with handshake are retained');
    const utf8 = Buffer.from('分片中文😀 across frames');
    ws.send(frame(1, utf8.subarray(0, 2), { final: false }));
    ws.send(frame(9, 'ping-payload'));
    ws.send(frame(0, utf8.subarray(2)));
    const pong = await readFrame(ws);
    assert.equal(pong.opcode, 10);
    assert.equal(pong.payload.toString(), 'ping-payload');
    assert.deepEqual((await readFrame(ws)).payload, utf8);
    for (const text of ['thread:async中文', 'x'.repeat(150), 'y'.repeat(70000), 'z'.repeat(4194304)]) {
        ws.send(frame(1, text));
        assert.equal((await readFrame(ws)).payload.toString(), text);
    }
    for (let i = 0; i < 12; i++) {
        const start = Date.now();
        ws.send(frame(1, `delayed:background-${i}`));
        assert.equal((await readFrame(ws)).payload.toString(), `delayed:background-${i}`);
        assert(Date.now() - start < 1000, 'An idle receiver must not starve an independent background sender');
    }
    ws.send(frame(8, Buffer.from([0x03, 0xe8])));
    assert.equal((await readFrame(ws)).opcode, 8);
    await ws.all();
    ws.destroy();
    check('RFC handshake, buffered frames, UTF-8 fragmentation, ping/pong, lengths, and background sends during idle reads');

    await rejectsFrame(frame(1, 'unmasked', { masked: false }), 1002);
    await rejectsFrame(frame(0, 'orphan continuation'), 1002);
    await rejectsFrame(frame(1, 'short', { lengthWidth: 2 }), 1002);
    await rejectsFrame(frame(9, 'bad ping', { final: false }), 1002);
    await rejectsFrame(frame(1, Buffer.from([0xc0, 0xaf])), 1007);
    await rejectsFrame(frame(1, Buffer.from([0xed, 0xa0, 0x80])), 1007);
    await rejectsFrame(frame(8, Buffer.from([0x03, 0xed])), 1002);
    await rejectsFrame(frame(2, 'binary'), 1003);
    const oversized = Buffer.alloc(10);
    oversized[0] = 0x81; oversized[1] = 0xff; oversized.writeBigUInt64BE(4194305n, 2);
    await rejectsFrame(oversized, 1009);
    assert.equal(status(await request('/ws', { headers: { ...wsFields, 'Sec-WebSocket-Version': '12' } })), 426);
    assert.equal(status(await request('/ws', { headers: { ...wsFields, 'Sec-WebSocket-Key': 'AAAAAAAAAAAAAAAAAAAAAB==' } })), 400);
    const closeByServer = await websocket();
    closeByServer.send(frame(1, 'server-close'));
    assert.equal((await readFrame(closeByServer)).payload.subarray(2).toString(), 'done');
    await closeByServer.all();
    closeByServer.destroy();
    check('WebSocket masking, protocol errors, invalid Unicode, close status, limits and server close');

    const held = await Promise.all(Array.from({ length: 70 }, () => Client.connect(port)));
    await delay(500);
    assert(held.filter(client => !client.closed).length <= 64, 'Connection count is bounded');
    assert(held.some(client => client.closed), 'Excess connections are refused');
    held.forEach(client => client.destroy());
    await delay(250);
    assert.equal(status(await request('/health')), 200);
    check('64-connection admission limit and recovery after disconnect');

    await Promise.all([
        (async () => {
            const slow = await Client.connect(port);
            slow.send(`GET /health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Slow: `);
            assert.equal(status((await slow.all(18000)).toString()), 408);
            slow.destroy();
        })(),
        (async () => {
            const slow = await Client.connect(port);
            slow.send(requestHead('/echo', { method: 'POST', headers: { 'Content-Length': 100 } }) + 'a');
            assert.equal(status((await slow.all(18000)).toString()), 408);
            slow.destroy();
        })(),
        (async () => {
            const slow = await websocket();
            slow.send(Buffer.from([0x81]));
            await slow.all(18000);
            slow.destroy();
        })(),
        (async () => {
            const slow = await Client.connect(port);
            slow.socket.pause();
            slow.send(requestHead('/flood'));
            let state;
            for (let i = 0; i < 90; i++) { state = await metrics(); if (state.floods_stopped) break; await delay(100); }
            assert.equal(state.floods_stopped, 1, 'Slow reader releases the writer after its deadline');
            slow.destroy();
        })()
    ]);
    check('HTTP header/body and WebSocket frame read deadlines; slow-reader write deadline');

    const shutdownSse = await Client.connect(port);
    shutdownSse.send(requestHead('/sse'));
    await shutdownSse.header();
    const shutdownWs = await websocket();
    shutdownWs.send(Buffer.from([0x81])); // Partial frame header.
    const shutdownHttp = await Client.connect(port);
    shutdownHttp.send('GET /health HTTP/1.1\r\n');
    const shutdownBody = await Client.connect(port);
    shutdownBody.send(requestHead('/echo', { method: 'POST', headers: { 'Content-Length': 100 } }) + 'a');
    const shutdownIdle = await Promise.all(Array.from({ length: 60 }, () => Client.connect(port)));
    await delay(150);
    assert(shutdownIdle.every(client => !client.closed), 'All 64 connections are active before shutdown');
    const exit = once(child, 'exit');
    const shutdownStarted = Date.now();
    child.stdin.end('stop\n');
    const shutdownTimer = setTimeout(() => child.kill(), 2500);
    const [exitCode, signal] = await exit;
    clearTimeout(shutdownTimer);
    assert.equal(exitCode, 0, `Graceful shutdown failed: ${signal ?? ''} ${stderr}`);
    assert(Date.now() - shutdownStarted < 2000, 'Shutdown interrupts partial reads and waiting streams');
    await Promise.all([shutdownSse.all(), shutdownWs.all(), shutdownHttp.all(), shutdownBody.all(), ...shutdownIdle.map(client => client.all())]);
    assert(output.some(value => value.stopped && value.streams_stopped >= 2));
    check('Stop interrupts SSE, partial HTTP/WS reads and 60 idle clients; joins all 64 workers');
    console.log(JSON.stringify({ ok: true, checks, transport: 'native-winsock-loopback' }));
} finally {
    if (child.exitCode === null) child.kill();
    lines.close();
}
