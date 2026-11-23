import assert from 'node:assert/strict';
import {mkdir, mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {startNative} from './archive-export-api.mjs';

const [executable, ui, root] = process.argv.slice(2);
await mkdir(root, {recursive:true});
const output = await mkdtemp(path.join(path.resolve(root), 'replay-'));
await mkdir(path.join(output, 'temp'));
const data = path.join(output, 'data');
const start = () => startNative({label:'replay', executable, ui, output, data});
let app = await start();
try {
  const bot = 'cursor-bot';
  await app.api('/api/dimension/bots',{id:bot,name:bot,persona:'Fixture'});
  const group = (await app.api('/api/dimension/groups',{name:'Cursor fixture',ownerId:bot,members:[bot]})).group.id;
  await app.stop();
  const db = new DatabaseSync(path.join(data, 'identities.sqlite'));
  const ids = [];
  try {
    const add = db.prepare('INSERT INTO messages(bot_id,group_id,mode,actor,text,created_at_ms) VALUES(?,?,?,?,?,?)');
    db.exec('BEGIN');
    for (let i=0; i<=150; i++) {
      ids.push(String(add.run(bot, group, 'chat', 'user', 'group '+i, Date.now()).lastInsertRowid));
      add.run(bot, '', 'chat', 'user', 'private', Date.now());
      add.run(bot, group, 'work', 'user', 'work', Date.now());
    }
    db.exec('COMMIT');
  } finally { db.close(); }
  app = await start();
  async function verify(after, lastId, expected) {
    const stop = new AbortController();
    const received = [];
    try {
      const response = await fetch(app.origin+'/api/dimension/groups/'+group+'/events?after='+after,{
        headers:lastId ? {'Last-Event-ID':lastId} : {},
        signal:AbortSignal.any([stop.signal, AbortSignal.timeout(12000)])
      });
      assert.equal(response.status,200);
      const decoder = new TextDecoder();
      let pending = '';
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk,{stream:true});
        let end;
        while ((end=pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0,end);
          pending = pending.slice(end+2);
          const id = /^id: (\d+)$/m.exec(frame)?.[1];
          if (id) {
            const row = JSON.parse(/^data: (.*)$/m.exec(frame)[1]);
            assert.equal(row.messageId,id);
            received.push(id);
          }
        }
        if (received.includes(expected.at(-1))) break;
      }
    } finally { stop.abort(); }
    assert.equal(received.length,expected.length,'replay count');
    assert.deepEqual(received,expected);
  }
  await verify(ids[0],null,ids.slice(1));
  await verify(ids[0],ids[85],ids.slice(86));
  console.log('PASS 150 queued messages and 65 after browser reconnect, in order and exactly once');
} finally { await app.stop(); }
