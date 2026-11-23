// Check what actually crosses the provider boundary using an isolated native backend.
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, mkdtemp} from 'node:fs/promises';
import {once} from 'node:events';
import {startNative, until} from './archive-export-api.mjs';
import {startFixture} from './app-integration.mjs';

const release = path.resolve(process.argv[2]);
const root = path.resolve(process.argv[3]);
await mkdir(root, {recursive:true});
const output = await mkdtemp(path.join(root, 'chat-input-'));
await mkdir(path.join(output, 'temp'));
let pending = 0, releaseReplies;
const together = new Promise(resolve => { releaseReplies = resolve; });
const clients = [];
const fullReply = "第一句。第二句！\n\n行内代码 `a || b`\n```js\nreturn a || b;\n```";
const fixture = await startFixture({chatReply: async ({tag}) => {
  if (tag === 'singlebubble') return {text:fullReply};
  if (!tag.startsWith('parallel')) return {text:'fixture reply'};
  if (++pending === 4) releaseReplies();
  await together;
  return {text:'Reply '+tag};
}});
let app, socket;
try {
  app = await startNative({label:'chat-input', output, data:path.join(output,'data'),
    executable:path.join(release,'native/DImensionagent-native.exe'), ui:path.join(release,'ui')});
  const botId = 'input-fixture';
  await app.api('/api/dimension/bots', {id:botId,name:'Input fixture',persona:'Test'});
  await app.api('/api/providers/fixture/save', {name:'fixture',entry:{kind:'openai-chat-compat',baseUrl:fixture.baseUrl,
    spec:{model:'fixture-flash',maxTokens:1024}},secretValue:'synthetic-key'});
  await app.api('/api/dimension/bots/'+botId+'/conversation-model',{modelSelection:{providerId:'fixture',model:'fixture-flash'}});
  socket = new WebSocket(app.origin.replace('http:', 'ws:')+'/ws/providers/world:console/panels/chat');
  const frames = [];
  socket.addEventListener('message',e=>frames.push(JSON.parse(e.data)));
  await once(socket,'open');
  socket.send(JSON.stringify({type:'hello',botId,historyLimit:10}));
  async function submit(text, requestId) {
    const begin=frames.length, firstRecord=fixture.records.length;
    socket.send(JSON.stringify({type:'msg',text,botId,requestId}));
    await until(()=>frames.slice(begin).some(f=>!f.history&&f.role==='assistant'&&f.text==='fixture reply'),'chat reply');
    return fixture.records.slice(firstRecord).find(record=>!record.work).body.messages;
  }
  const plain = await submit('第一轮：请记住蓝色。','text');
  assert(plain.some(m=>m.role==='user'&&typeof m.content==='string'&&m.content.includes('请记住蓝色')));
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGNkYPjPwMDAxAAGAAsfAQMU4wsAAAAAAElFTkSuQmCC','base64');
  const upload=await fetch(app.origin+'/api/dimension/chat/images',{method:'POST',headers:{'content-type':'image/png'},body:bytes});
  assert.equal(upload.status,201);
  const {id}=await upload.json();
  const withImage=await submit('第二轮：请看图片。 [chat-image:'+id+']','image');
  const parts=withImage.filter(m=>m.role==='user'&&Array.isArray(m.content)).flatMap(m=>m.content);
  assert(parts.some(p=>p.type==='image_url'&&p.image_url.url==='data:image/png;base64,'+bytes.toString('base64')));
  assert(parts.some(p=>p.type==='text'&&p.text.includes('请看图片')));
  assert(withImage.some(m=>m.role==='user'&&typeof m.content==='string'&&m.content.includes('请记住蓝色')));
  console.log('PASS plain input, retained history and exact image bytes reached the provider');
  const begin = frames.length;
  socket.send(JSON.stringify({type:'msg',botId,text:'APPTEST:singlebubble',requestId:'singlebubble'}));
  await until(()=>frames.slice(begin).some(f=>f.role==='assistant' && f.text===fullReply),'single complete chat bubble');
  const replies=frames.slice(begin).filter(f=>!f.history && f.type==='msg' && f.role==='assistant');
  assert.deepEqual(replies.map(f=>f.text),[fullReply]);
  const recent=await app.api('/api/dimension/bots/'+botId+'/history?limit=20');
  assert.equal(recent.messages.filter(m=>m.messageId===replies[0].messageId && m.text===fullReply).length,1);
  console.log('PASS single private bubble preserves paragraphs and code in live events and history');
  await app.api('/api/dimension/chat/thinking',{enabled:true},'PUT');
  for (let i=0;i<4;i++) {
    const id='parallel'+i;
    await app.api('/api/dimension/bots',{id,name:id,persona:'Test'});
    await app.api('/api/dimension/bots/'+id+'/conversation-model',{modelSelection:{providerId:'fixture',model:'fixture-flash'}});
    const ws=new WebSocket(socket.url);
    clients.push(ws);
    await once(ws,'open');
    ws.send(JSON.stringify({type:'hello',botId:id,historyLimit:10}));
    ws.send(JSON.stringify({type:'msg',botId:id,text:'APPTEST:'+id,requestId:id}));
  }
  for (let i=0;i<4;i++) {
    const id='parallel'+i;
    const reply=await until(async()=>{
      const history=await app.api('/api/dimension/bots/'+id+'/history?limit=10');
      return history.messages.find(m=>m.role==='assistant' && m.text==='Reply '+id);
    },'parallel private reply');
    assert.equal(reply.reasoning,'THINKING_ONLY_'+id);
  }
  console.log('PASS simultaneous private chats retain their own reasoning');
} finally {
  releaseReplies(); clients.forEach(ws=>ws.close());
  socket?.close(); await fixture.close(); await app?.stop();
}
