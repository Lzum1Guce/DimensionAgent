import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

// Only loopback HTTP is used. No installed application source or live model
// configuration is read; this artificial credential exists only in this test.
const executable = process.argv[2];
if (!executable) throw new Error('Usage: node model-http-fixture.mjs <model_test.exe> [output-directory]');
const outputDirectory = process.argv[3] && path.resolve(process.argv[3]);
if (outputDirectory) await mkdir(outputDirectory, { recursive: true });
const credential = 'fixture-key-never-echo-4b72';
const errors = [];
const requests = {};
const sockets = new Set();
let redirectedRequests = 0;
let largestRequest = 0;
let largestTextRequest = 0;
let largestChatRequest = 0;
let largestWorkRequest = 0;
let largestWorkTextRequest = 0;
const imageEvidence = [];
const uploadEvidence = [];
const workPayloadEvidence = [];

function inspectImage(url, index, scenario, protocol) {
  assert.equal(typeof url, 'string');
  assert.match(url, /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/);
  const encoded = url.slice('data:image/png;base64,'.length);
  const png = Buffer.from(encoded, 'base64');
  assert.equal(png.toString('base64'), encoded, 'Image is not canonical base64');
  assert.ok(png.length <= 5 * 1024 * 1024, 'Image binary exceeded its limit');
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), 3);
  assert.equal(png.readUInt32BE(20), 2);
  assert.deepEqual(png.subarray(24, 29), Buffer.from([8, 2, 0, 0, 0]));
  const compressed = [];
  let offset = 8;
  let ended = false;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    assert.ok(offset + 12 + length <= png.length, 'PNG chunk was truncated');
    if (type === 'IDAT') compressed.push(png.subarray(offset + 8, offset + 8 + length));
    if (type === 'IEND') { assert.equal(offset + 12, png.length); ended = true; }
    offset += length + 12;
  }
  assert.ok(ended && compressed.length);
  const pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: 1024 });
  const expected = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 255,
    0, 255, 255, 255, 0, 0, 0, 255, 0, 255]);
  if (index % 2) for (let i = 0; i < expected.length; ++i) if (i % 10) expected[i] ^= 255;
  assert.deepEqual(pixels, expected, 'Actual PNG pixels changed in transport');
  if (scenario.endsWith('vision-large')) assert.equal(png.length, 5 * 1024 * 1024);
  if (scenario === 'vision-near-limit') assert.equal(png.length, 4 * 1024 * 1024);
  imageEvidence.push({ scenario, protocol, index, width: 3, height: 2, binaryBytes: png.length,
    sha256: createHash('sha256').update(png).digest('hex'),
    decodedScanlines: [...pixels], actualPixelsVerified: true });
}

const delta = (value, finish = null) => ({ choices: [{ index: 0, delta: value, finish_reason: finish }] });
const data = (value) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const jsonReply = {
  error: null,
  choices: [{ index: 0, message: { role: 'assistant', content: 'JSON答复😀', reasoning_content: '非流式思考',
    tool_calls: [{ id: 'json_call', type: 'function', function: { name: 'search', arguments: '{"q":"猫"}' } }] },
    finish_reason: 'tool_calls' }], usage: { prompt_tokens: 7, completion_tokens: 4 },
};
const responsesReply = { status: 'completed', error: null, output: [
  { type: 'reasoning', summary: [{ type: 'summary_text', text: '摘要🧠' }] },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '响应🙂' }] },
  { type: 'function_call', id: 'item_2', call_id: 'response_call', name: 'search', arguments: '{"q":"猫"}' },
], usage: { input_tokens: 8, output_tokens: 9 } };

function track(server) {
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function sseHeaders(res) {
  res.writeHead(200, { 'Content-Type': 'Text/Event-Stream; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.flushHeaders();
}

function pause(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function fragmented(res, text) {
  // Every UTF-8 multibyte scalar is necessarily split across writes. Delays
  // prevent all application writes from collapsing into a single network read.
  const bytes = Buffer.from(text);
  for (let index = 0; index < bytes.length && !res.destroyed;) {
    const length = bytes[index] >= 0x80 ? 1 : Math.min(7, bytes.length - index);
    res.write(bytes.subarray(index, index + length));
    index += length;
    await pause(1);
  }
  if (!res.destroyed) res.end();
}

async function largeWrites(res, parts, scenario, { end = true } = {}) {
  const entry = { scenario, kind: 'response', writtenBytes: 0, closed: false };
  workPayloadEvidence.push(entry);
  res.once('close', () => { entry.closed = true; });
  for (const part of parts) {
    if (res.destroyed) break;
    entry.writtenBytes += Buffer.byteLength(part);
    if (!res.write(part)) {
      await new Promise((resolve) => {
        const ready = () => { res.off('drain', ready); res.off('close', ready); resolve(); };
        res.once('drain', ready); res.once('close', ready);
      });
    }
  }
  if (end && !res.destroyed) res.end();
}

const redirectServer = http.createServer((req, res) => {
  ++redirectedRequests;
  req.resume();
  res.end('Redirect should never be followed');
});
track(redirectServer);
const redirectPort = await listen(redirectServer);

const server = http.createServer(async (req, res) => {
  req.on('error', () => {});
  res.on('error', () => {});
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const scenario = url.pathname.split('/')[1];
    const work = scenario.startsWith('work-') || scenario.startsWith('responses-work-');
    requests[scenario] = (requests[scenario] || 0) + 1;
    if (scenario === 'capture') {
      ++redirectedRequests;
      req.resume();
      res.end('Unexpected redirect');
      return;
    }
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, `Bearer ${credential}`);
    assert.match(req.headers['content-type'], /^application\/json/);
    if (scenario === 'vision-stalled-upload') {
      const entry = { scenario, declaredBytes: Number(req.headers['content-length']), bytesRead: 0,
        bytesReadWhilePaused: req.socket.bytesRead, closed: false };
      assert.ok(entry.declaredBytes > 4 * 1024 * 1024 && entry.declaredBytes <= 12 * 1024 * 1024);
      uploadEvidence.push(entry);
      req.pause();
      // A paused Node socket cannot observe a queued FIN until it reads again.
      // Resume after the client's 500 ms cancellation. TCP may already have
      // queued body bytes; this checks cancellation/closure, not send progress.
      let resumed = false;
      const resume = setTimeout(() => {
        entry.bytesReadWhilePaused = req.socket.bytesRead;
        resumed = true;
        req.resume();
      }, 750);
      req.socket.once('close', () => {
        entry.closed = true; entry.bytesRead = req.socket.bytesRead;
        if (!resumed) entry.bytesReadWhilePaused = entry.bytesRead;
        clearTimeout(resume);
      });
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    largestRequest = Math.max(largestRequest, bytes.length);
    if (work) {
      largestWorkRequest = Math.max(largestWorkRequest, bytes.length);
      workPayloadEvidence.push({ scenario, kind: 'request', bytes: bytes.length });
    } else largestChatRequest = Math.max(largestChatRequest, bytes.length);
    const body = JSON.parse(bytes.toString('utf8'));
    assert.equal(body.model, 'fixture-model');
    assert.equal(body.stream, true);
    const responses = scenario.startsWith('responses-');
    const vision = scenario.includes('vision');
    assert.equal(url.pathname, `/${scenario}/v1/${responses ? 'responses' : 'chat/completions'}`);
    if (responses) {
      assert.equal(body.max_output_tokens, 4096);
      const output = body.input.find((item) => item.type === 'function_call_output');
      assert.equal(output.call_id, 'history_call');
      assert.equal(output.output, 'historical result');
      assert.equal(body.input.find((item) => item.type === 'function_call').name, 'search');
      assert.equal(body.tools[0].name, 'search');
      assert.equal(body.tools[0].strict, false);
    } else {
      assert.equal(body.max_tokens, 4096);
      const output = body.messages.find((item) => item.role === 'tool');
      assert.equal(output.tool_call_id, 'history_call');
      assert.equal(output.content, 'historical result');
      assert.equal(body.messages.find((item) => item.role === 'assistant').tool_calls[0].function.name, 'search');
      assert.equal(body.tools[0].function.name, 'search');
      assert.equal(body.stream_options.include_usage, true);
      if (scenario === 'chat-sampling') {
        assert.deepEqual(body.thinking, { type: 'disabled' });
        assert.equal(body.temperature, 0.8);
      } else if (scenario === 'work-reasoning') {
        assert.deepEqual(body.thinking, { type: 'enabled' });
        assert.equal(body.reasoning_effort, 'high');
        if (requests[scenario] === 2) {
          const generated = body.messages.find(message => message.role === 'assistant' &&
            message.tool_calls?.some(call => call.id === 'json_call'));
          assert.equal(generated?.reasoning_content, '非流式思考');
        }
      } else {
        assert.equal('thinking' in body, false, 'Default/Work request unexpectedly changed thinking mode');
        assert.equal('temperature' in body, false, 'Default/Work request unexpectedly changed temperature');
        assert.equal('reasoning_effort' in body, false, 'Unconfigured request unexpectedly changed reasoning effort');
      }
    }
    if (vision) {
      assert.ok(bytes.length <= (work ? 48 : 12) * 1024 * 1024, 'Image request exceeded wire bound');
      const messages = responses ? body.input : body.messages;
      const imageMessages = messages.filter((item) => Array.isArray(item.content));
      assert.ok(imageMessages.length >= 1 && imageMessages.length <= 2);
      let imageCount = 0;
      for (const message of imageMessages) {
        assert.equal(message.role, 'user');
        assert.equal(message.content[0].type, responses ? 'input_text' : 'text');
        assert.equal(typeof message.content[0].text, 'string');
        if (scenario === 'vision-empty') assert.equal(message.content[0].text, '');
        for (const part of message.content.slice(1)) {
          assert.equal(part.type, responses ? 'input_image' : 'image_url');
          inspectImage(responses ? part.image_url : part.image_url.url, imageCount++, scenario,
            responses ? 'responses' : 'chat-completions');
        }
      }
      assert.equal(imageCount, scenario.endsWith('-two') || scenario === 'vision-near-limit' ? 2 : 1);
      if (scenario.endsWith('vision-large') || scenario === 'vision-near-limit')
        assert.ok(bytes.length > 4 * 1024 * 1024, 'Large image did not exercise separate body limit');
    } else {
      if (work) largestWorkTextRequest = Math.max(largestWorkTextRequest, bytes.length);
      else largestTextRequest = Math.max(largestTextRequest, bytes.length);
      assert.ok(bytes.length <= (work ? 32 : 4) * 1024 * 1024, 'Text request exceeded profile bound');
    }
    switch (scenario) {
      case 'work-request':
      case 'responses-work-request':
      case 'work-escaped-request':
      case 'work-vision-two': {
        assert.ok(bytes.length > 4 * 1024 * 1024, 'Work did not send a real large request');
        const messages = responses ? body.input : body.messages;
        const text = messages[0].content;
        assert.equal(text, (scenario === 'work-escaped-request' ? '\u0001' : 'Q')
          .repeat(scenario === 'work-escaped-request' ? 1024 * 1024 : 5 * 1024 * 1024));
        if (vision) assert.ok(bytes.length > 12 * 1024 * 1024, 'Work did not exceed the old image body bound');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responses ? responsesReply : jsonReply));
        return;
      }
      case 'work-wire-overhead':
      case 'work-cancel-stream': {
        sseHeaders(res);
        const heartbeat = ':' + 'h'.repeat(8190) + '\n';
        const parts = Array(768).fill(heartbeat);
        parts.push(data(delta({ content: 'ok' }, scenario === 'work-cancel-stream' ? null : 'stop')));
        if (scenario !== 'work-cancel-stream') parts.push('data: [DONE]\n\n');
        await largeWrites(res, parts, scenario, { end: scenario !== 'work-cancel-stream' });
        return;
      }
      case 'work-large-stream':
      case 'responses-work-large-stream': {
        sseHeaders(res);
        const parts = [];
        const thinking = 'T'.repeat(64 * 1024), text = 'R'.repeat(64 * 1024);
        for (let i = 0; i < 80; ++i)
          parts.push(data(responses ? { type: 'response.reasoning_text.delta', delta: thinking } : delta({ reasoning_content: thinking })));
        for (let i = 0; i < 80; ++i)
          parts.push(data(responses ? { type: 'response.output_text.delta', delta: text } : delta({ content: text })));
        if (responses) parts.push(data({ type: 'response.completed', response: { status: 'completed', output: [
          { type: 'reasoning', summary: [{ type: 'summary_text', text: 'T'.repeat(5 * 1024 * 1024) }] },
          { type: 'message', content: [{ type: 'output_text', text: 'R'.repeat(5 * 1024 * 1024) }] },
        ] } }));
        else parts.push(data(delta({}, 'stop')), 'data: [DONE]\n\n');
        await largeWrites(res, parts, scenario);
        return;
      }
      case 'work-large-json':
      case 'responses-work-large-json': {
        const content = 'J'.repeat(5 * 1024 * 1024);
        const result = responses ? { status: 'completed', output: [
          { type: 'message', content: [{ type: 'output_text', text: content }] },
        ] } : { choices: [{ index: 0, message: { content }, finish_reason: 'stop' }] };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        await largeWrites(res, [JSON.stringify(result)], scenario);
        return;
      }
      case 'work-large-tools':
      case 'responses-work-large-tools': {
        const args = JSON.stringify({ q: 'A'.repeat(5 * 1024 * 1024) });
        sseHeaders(res);
        if (responses) {
          const item = { type: 'function_call', call_id: 'large_tool', name: 'search', arguments: args };
          await largeWrites(res, [data({ type: 'response.output_item.done', output_index: 0, item }),
            data({ type: 'response.completed', response: { status: 'completed', output: [item] } })], scenario);
        } else await largeWrites(res, [data(delta({ tool_calls: [{ index: 0, id: 'large_tool', type: 'function',
          function: { name: 'search', arguments: args } }] }, 'tool_calls')), 'data: [DONE]\n\n'], scenario);
        return;
      }
      case 'work-output-bound':
      case 'work-tool-bound': {
        sseHeaders(res);
        const content = 'x'.repeat(1536 * 1024);
        res.end(data(delta(scenario === 'work-output-bound' ? { reasoning_content: content } : {
          tool_calls: [{ index: 0, id: 'bounded', type: 'function', function: { name: 'search', arguments: JSON.stringify({ q: content }) } }],
        }, 'stop')));
        return;
      }
      case 'work-line-bound':
        sseHeaders(res);
        res.end(':' + 'x'.repeat(1024 * 1024 + 1));
        return;
      case 'work-event-bound':
        sseHeaders(res);
        res.end(('data: ' + ' '.repeat(128 * 1024) + '\n').repeat(9));
        return;
      case 'work-wire-bound':
        sseHeaders(res);
        res.end((':' + 'x'.repeat(8190) + '\n').repeat(129));
        return;
      case 'context-code':
      case 'context-message':
      case 'context-413':
      case 'generic-400':
      case 'generic-413':
      case 'malformed-400':
      case 'large-error-400':
      case 'negative-context-400': {
        const status = scenario.endsWith('413') ? 413 : 400;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        if (scenario === 'malformed-400') res.end('{');
        else if (scenario === 'large-error-400') res.end(JSON.stringify({ error: { message: 'x'.repeat(70 * 1024), code: 'context_length_exceeded' } }));
        else res.end(JSON.stringify({ error: {
          code: scenario === 'context-code' || scenario === 'context-413' ? 'context_length_exceeded' : 'invalid_request_error',
          message: scenario === 'context-message' ? "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens. Please reduce the length of the messages or completion." :
            scenario === 'negative-context-400' ? 'Invalid tool schema. The context length was not exceeded.' : `Request body size or schema is invalid: ${credential}`,
        } }));
        return;
      }
      case 'context-json':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'context_window_exceeded', message: credential } }));
        return;
      case 'context-sse':
        sseHeaders(res);
        res.end('event: error\n' + data({ code: 'context_length_exceeded', message: credential }));
        return;
      case 'responses-context-sse':
        sseHeaders(res);
        res.end(data({ type: 'response.failed', response: { error: { code: 'context_length_exceeded', message: credential } } }));
        return;
      case 'sse': {
        sseHeaders(res);
        let text = '\uFEFF: heartbeat\r\n\r\n';
        text += data(delta({ reasoning_content: '先想🤔', content: '你' }));
        text += 'event: message\r\ndata: {"choices":\r\ndata: [{"index":0,"delta":{"content":"好🌏"}}]}\r\n\r\n';
        text += data(delta({ tool_calls: [
          { index: 1, id: 'call_', type: 'function', function: { name: 'se', arguments: '{"q":"' } },
          { index: 0, id: 'call_z', type: 'function', function: { name: 'other', arguments: '{}' } },
        ] }));
        text += data(delta({ tool_calls: [{ index: 1, id: 'a', function: { name: 'arch', arguments: '猫"}' } }] }));
        text += data(delta({}, 'tool_calls'));
        text += data({ choices: [], usage: { prompt_tokens: 123, completion_tokens: 45 } });
        text += 'data: [DONE]\r\n\r\n';
        await fragmented(res, text);
        return;
      }
      case 'json':
      case 'work-reasoning':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        await fragmented(res, JSON.stringify(jsonReply));
        return;
      case 'no-usage':
      case 'chat-sampling':
        sseHeaders(res);
        res.end(data(delta({ content: 'ok' }, 'stop')));
        return;
      case 'responses-sse': {
        sseHeaders(res);
        const events = [
          { type: 'response.reasoning_summary_text.delta', delta: '摘要🧠' },
          { type: 'response.output_text.delta', output_index: 1, delta: '响应🙂' },
          { type: 'response.output_item.added', output_index: 2,
            item: { type: 'function_call', id: 'item_2', call_id: 'response_call', name: 'search', arguments: '' } },
          { type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'item_2', delta: '{"q":' },
          { type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'item_2', delta: '"猫"}' },
          { type: 'response.function_call_arguments.done', output_index: 2, arguments: '{"q":"猫"}' },
          { type: 'response.output_item.done', output_index: 2, item: responsesReply.output[2] },
          { type: 'response.completed', response: responsesReply },
        ];
        await fragmented(res, events.map((event) => `event: ${event.type}\n${data(event)}`).join(''));
        return;
      }
      case 'responses-json':
      case 'responses-vision':
      case 'responses-vision-two':
      case 'responses-vision-large':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responsesReply));
        return;
      case 'responses-incomplete':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...responsesReply, status: 'incomplete' }));
        return;
      case 'chat-output-limit':
        sseHeaders(res);
        res.end(data(delta({ content: 'unfinished', tool_calls: [{ index: 0, id: 'partial', type: 'function', function: { name: 'search', arguments: '{' } }] }, 'length')) + 'data: [DONE]\n\n');
        return;
      case 'chat-output-limit-json':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ index: 0, message: { content: 'unfinished' }, finish_reason: 'length' }] }));
        return;
      case 'responses-output-limit':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...responsesReply, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }));
        return;
      case 'responses-output-limit-sse':
        sseHeaders(res);
        res.end(data({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{' }) +
          data({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }));
        return;
      case 'http-error':
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Do not echo ${credential}` } }));
        return;
      case 'redirect':
        res.writeHead(307, { Location: `http://127.0.0.1:${redirectPort}/capture` });
        res.end();
        return;
      case 'redirect-same':
        res.writeHead(302, { Location: '/capture' });
        res.end();
        return;
      case 'provider-error':
        sseHeaders(res);
        res.end(data({ error: { message: `Do not echo ${credential}` } }));
        return;
      case 'invalid-json':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(`{"message":"${credential}",`);
        return;
      case 'truncated':
        sseHeaders(res);
        res.end(data(delta({ content: 'unfinished' })));
        return;
      case 'invalid-tool':
        sseHeaders(res);
        res.end(data(delta({ tool_calls: [{ index: 0, id: 'bad', function: { name: 'search', arguments: '{' } }] }, 'tool_calls')) + 'data: [DONE]\n\n');
        return;
      case 'huge-line':
        sseHeaders(res);
        res.end('data: ' + 'x'.repeat(256 * 1024 + 1));
        return;
      case 'huge-body':
        sseHeaders(res);
        res.end((':' + 'x'.repeat(8190) + '\n').repeat(513));
        return;
      case 'huge-event':
        sseHeaders(res);
        res.end(('data: ' + 'x'.repeat(128 * 1024) + '\n').repeat(9));
        return;
      case 'huge-json':
      case 'vision-huge-json':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(' '.repeat(4 * 1024 * 1024 + 1));
        return;
      case 'html':
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<p>${credential}</p>`);
        return;
      case 'slow-headers':
      case 'vision-slow-headers':
        // No timer or work outlives the client's cancellation.
        return;
      case 'slow-body':
      case 'responses-vision-slow-body':
        sseHeaders(res);
        res.write(': waiting\n\n');
        return;
      case 'trickle': {
        sseHeaders(res);
        const timer = setInterval(() => { if (!res.destroyed) res.write(': ping\n\n'); }, 20);
        res.once('close', () => clearInterval(timer));
        return;
      }
      case 'callback':
        sseHeaders(res);
        res.write(data(delta({ content: 'callback' })));
        return;
      case 'disconnect':
        req.socket.destroy();
        return;
      case 'vision-chat':
      case 'vision-empty':
      case 'vision-two':
      case 'vision-large':
      case 'vision-near-limit':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jsonReply));
        return;
      default:
        throw new Error('Unknown fixture route');
    }
  } catch (error) {
    // Assertion payloads may include the synthetic key; retain no raw body.
    errors.push(String(error.message).replaceAll(credential, '[redacted]'));
    if (!res.headersSent) res.writeHead(422, { 'Content-Type': 'application/json' });
    if (!res.destroyed) res.end('{"error":{"message":"Fixture validation failed"}}');
  }
});
track(server);
const port = await listen(server);

let stdout = '';
let stderr = '';
let result = 1;
try {
  const child = spawn(path.resolve(executable), [`http://127.0.0.1:${port}`], {
    cwd: outputDirectory ?? process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { stdout += chunk; process.stdout.write(chunk); });
  child.stderr.on('data', (chunk) => { stderr += chunk; process.stderr.write(chunk); });
  const guard = setTimeout(() => child.kill(), 60000);
  try {
    result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
    });
  } finally { clearTimeout(guard); }
  assert.equal(redirectedRequests, 0, 'A redirect was followed');
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.ok(largestChatRequest > 10 * 1024 * 1024 && largestChatRequest <= 12 * 1024 * 1024,
    'Independent image request bound was not exercised');
  assert.ok(largestTextRequest <= 4 * 1024 * 1024, 'Oversized text body reached fixture');
  assert.ok(largestWorkTextRequest > 4 * 1024 * 1024 && largestWorkTextRequest <= 32 * 1024 * 1024,
    'Work did not send a request above the original 4 MiB bound');
  assert.ok(largestWorkRequest > 12 * 1024 * 1024 && largestWorkRequest <= 48 * 1024 * 1024,
    'Work did not send a request above the original 12 MiB image bound');
  assert.ok(workPayloadEvidence.some((entry) => entry.scenario === 'work-wire-overhead' && entry.writtenBytes > 4 * 1024 * 1024));
  assert.ok(workPayloadEvidence.some((entry) => entry.scenario === 'responses-work-large-stream' && entry.writtenBytes > 10 * 1024 * 1024));
  assert.ok(imageEvidence.some((entry) => entry.protocol === 'chat-completions'));
  assert.ok(imageEvidence.some((entry) => entry.protocol === 'responses'));
  await pause(50);
  assert.ok(workPayloadEvidence.some((entry) => entry.scenario === 'work-cancel-stream' &&
    entry.kind === 'response' && entry.writtenBytes > 4 * 1024 * 1024 && entry.closed), 'Large Work stream was not cancelled');
  assert.equal(uploadEvidence.length, 1, 'Cancelled image upload never reached fixture');
  assert.ok(uploadEvidence[0].closed && uploadEvidence[0].bytesReadWhilePaused < uploadEvidence[0].declaredBytes,
    'Paused-read image request was not cancelled and closed');
  assert.ok(Object.keys(requests).length >= 20, 'HTTP test suite did not run');
  if (outputDirectory) await writeFile(path.join(outputDirectory, 'model-http-result.json'), JSON.stringify({
    result, redirectedRequests, largestRequest, largestTextRequest, largestChatRequest, largestWorkRequest,
    largestWorkTextRequest, requests, errors, imageEvidence, uploadEvidence, workPayloadEvidence, stdout, stderr,
    network: 'ephemeral IPv4 loopback only', credentialSource: 'synthetic fixture constant',
  }, null, 2));
} finally {
  for (const socket of sockets) socket.destroy();
  await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => redirectServer.close(resolve))]);
}
process.exitCode = result;
