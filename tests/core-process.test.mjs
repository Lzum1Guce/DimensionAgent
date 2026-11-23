import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CoreClient } from '../work/core-client.mjs';

const root=resolve(import.meta.dirname,'..');
const exe=existsSync(join(root,'build/DImensionagent-core.exe'))?join(root,'build/DImensionagent-core.exe'):join(root,'outputs/build/DImensionagent-core.exe');
await mkdir(join(root,'outputs/process-tests'),{recursive:true});
const fixture=await mkdtemp(join(root,'outputs/process-tests/中文路径-'));
const database=join(fixture,'记忆.sqlite'), clients=[], checks=[];
const connect=()=>{const client=new CoreClient(exe,database);clients.push(client);return client;};
const check=async(name,fn)=>{await fn();checks.push(name);};
let client=connect();
const start=performance.now();
try {
  await check('native version and isolated database open',async()=>{
    const info=await client.request('info');assert.equal(info.phase,1);assert.equal(info.modelExecution,false);
  });
  const startupMs=performance.now()-start;
  await check('Bot ID, persona and independent rosters',async()=>{
    const bot=await client.request('bot.create',{botId:'test-alice',name:'艾丽丝',persona:'简洁地回答'});
    assert.equal(bot.id,'test-alice');assert.equal(bot.chat,false);assert.equal(bot.work,false);
    await client.request('bot.roster',{botId:bot.id,mode:'chat',present:true});
    assert.equal((await client.request('bot.list',{mode:'chat'})).length,1);
    assert.equal((await client.request('bot.list',{mode:'work'})).length,0);
  });
  let memory;
  await check('explicit source, confirmation and private/group boundary',async()=>{
    await assert.rejects(client.request('memory.propose',{botId:'test-alice',text:'不能冒充用户',sourceActor:'bot'}));
    memory=await client.request('memory.propose',{botId:'test-alice',groupId:'project-a',text:'项目预算是1.5万元，使用 C++。',sourceActor:'user'});
    assert.deepEqual(await client.request('memory.recall',{botId:'test-alice',groupId:'project-a',query:'项目预算'}),[]);
    memory=await client.request('memory.review',{memoryId:memory.id,revision:memory.revision,state:'confirmed'});
    assert.equal((await client.request('memory.recall',{botId:'test-alice',groupId:'project-a',query:'项目预算'})).length,1);
    assert.deepEqual(await client.request('memory.recall',{botId:'test-alice',groupId:'project-b',query:'项目预算'}),[]);
    assert.deepEqual(await client.request('memory.recall',{botId:'test-alice',query:'项目预算'}),[]);
  });
  await check('revision conflict cannot overwrite reviewed memory',async()=>{
    await assert.rejects(client.request('memory.edit',{memoryId:memory.id,revision:'1',text:'不应覆盖'}),{code:'conflict'});
    assert.equal((await client.request('memory.get',{memoryId:memory.id})).text,memory.text);
  });
  await check('paged conversations and stable cursors',async()=>{
    for(let i=0;i<72;i++)await client.request('message.append',{botId:'test-alice',mode:'chat',actor:'user',text:`测试消息 ${i}`});
    const first=await client.request('message.list',{botId:'test-alice',mode:'chat'});assert.equal(first.length,30);
    const cursor=first.at(-1).id;
    await client.request('message.append',{botId:'test-alice',mode:'chat',actor:'user',text:'分页期间新消息'});
    const second=await client.request('message.list',{botId:'test-alice',mode:'chat',before:cursor});
    assert.equal(new Set([...first,...second].map(row=>row.id)).size,60);
    assert.deepEqual(await client.request('message.list',{botId:'test-alice',mode:'work'}),[]);
    await assert.rejects(client.request('message.list',{botId:'test-alice',mode:'chat',limit:1.5}));
  });
  await check('remove clears conversation but retains same library identity and memory',async()=>{
    await client.request('bot.remove',{botId:'test-alice'});
    assert.equal((await client.request('bot.list')).length,1);
    assert.equal((await client.request('bot.list',{mode:'chat'})).length,0);
    assert.deepEqual(await client.request('message.list',{botId:'test-alice',mode:'chat'}),[]);
    assert.equal((await client.request('memory.get',{memoryId:memory.id})).text,memory.text);
    await client.request('bot.roster',{botId:'test-alice',mode:'work',present:true});
  });
  await check('restart and concurrent database connection preserve revisions',async()=>{
    assert.equal(await client.close(),0);client=connect();
    const restored=await client.request('bot.get',{botId:'test-alice'});assert.equal(restored.persona,'简洁地回答');assert.equal(restored.work,true);
    const other=connect();
    const revised=await other.request('memory.edit',{memoryId:memory.id,revision:memory.revision,text:'项目预算是15万元。'});
    await assert.rejects(client.request('memory.delete',{memoryId:memory.id,revision:memory.revision}),{code:'conflict'});
    memory=revised;assert.equal((await client.request('memory.get',{memoryId:memory.id})).text,'项目预算是15万元。');
    assert.equal(await other.close(),0);
  });
  await check('only explicit memory deletion removes its record',async()=>{
    await client.request('memory.delete',{memoryId:memory.id,revision:memory.revision});
    assert.equal(await client.request('memory.get',{memoryId:memory.id}),null);
    assert.equal((await client.request('bot.list')).length,1);
  });
  const report={passed:checks.length,checks,startupToInfoMs:Math.round(startupMs*10)/10,executableBytes:(await stat(exe)).size,productionDataUsed:false,modelRequests:0};
  await writeFile(join(root,'outputs/process-test-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} finally {await Promise.all(clients.map(client=>client.close()));}
