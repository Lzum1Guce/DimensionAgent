import assert from 'node:assert/strict';
import { createGalgameVoiceController, groupVoiceChunks } from '../ui/galgame-voice.js';

import { parsePerformanceBeats } from '../ui/galgame-stage.js';
const requests = [], players = [];
const tick = () => new Promise(resolve => setImmediate(resolve));
globalThis.fetch = async (_url, options) => new Promise(resolve => {
  requests.push({ ...JSON.parse(options.body), signal: options.signal, finish: () => resolve(new Response(new Uint8Array(64))) });
});
globalThis.Audio = class {
  constructor() { players.push(this); }
  play() { return Promise.resolve(); }
  pause() { this.paused = true; }
};
const ctrl = createGalgameVoiceController();
const first = '我看过了。', second = '问题在第二步。';
function feed(lines, key = 'one', streaming = true) {
  ctrl.feedTurnBeats({ turnKey: key, botId: key, streamActive: streaming,
    beats: parsePerformanceBeats(lines.join('')).beats });
}
feed([first, '问题']);
requests[0].finish(); await tick();
feed([first, second]);
feed([first, second], 'one', false);
players[0].onended(); await tick();
assert.deepEqual(requests.map(x => x.text), [first, second]);
requests[1].finish(); await tick();
assert.equal(players.length, 2);
feed(['第三句。'], 'two');
assert(players[1].paused);
feed(['第四句。'], 'three');
assert(requests[2].signal.aborted);
requests[2].finish(); requests[3].finish(); await tick();
assert.equal(players.length, 3);
ctrl.setEnabled(false);
feed(['手动试听。'], 'four', false);
assert(ctrl.replayLastTurn()); requests.at(-1).finish(); await tick();
assert(!ctrl.isEnabled());
ctrl.stop(); await tick();
assert(!ctrl.isBusy());
assert.equal(groupVoiceChunks([{text:'I see'},{text:'what happened'}])[0].text, 'I see what happened');
const long = '这是一条长句'.repeat(80);
assert.equal(groupVoiceChunks([{text:long}]).map(x => x.text).join(''), long);
console.log('PASS streamed playback, shared prefetch, role switches, stale requests, muted replay, long lines and English spacing');
