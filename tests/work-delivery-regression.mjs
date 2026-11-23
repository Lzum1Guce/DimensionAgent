import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {startNative, until} from './archive-export-api.mjs';

const [exe, ui, output] = process.argv.slice(2);
await mkdir(path.join(output, 'temp'), {recursive:true});
let app, serial = 0, releaseIndependent;
const gate = new Promise(resolve => { releaseIndependent = resolve; });
let independentStarted = false;
const failures = [];
let observedMember = false;
let unrelatedId;
const server = http.createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const part of req) raw += part;
    const messages = JSON.parse(raw).messages;
    const lastUser = messages.filter(m => m.role === 'user').at(-1).content;
    const last = messages.at(-1);
    let name, args, answer;
    if (lastUser === 'INDEPENDENT 只返回文本') {
      independentStarted = true; await gate; answer = 'independent done';
    } else if (lastUser.includes('成员颜色职责')) {
      answer = '成员建议蓝色';
    } else if (lastUser.includes('GROUP')) {
      if (last.role === 'user') {
        name = 'send_member_task';
        args = {jobs:[{botId:'worker',task:'成员颜色职责，只返回文本'}]};
        if (lastUser.includes('FOREIGN')) Object.assign(args.jobs[0],{interruptCurrent:true,previousRunId:unrelatedId});
        if (lastUser.includes('INVALID')) args.jobs.push({botId:'unknown',task:'invalid'});
      } else if (last.role === 'tool' && /INVALID|FOREIGN/.test(lastUser)) {
        assert.equal(JSON.parse(last.content).error,true);
        answer = '批次未派发';
      } else {
        assert(last.content.includes('成员建议蓝色'));
        observedMember = true;
        name = 'task_finish'; args = {summary:'已收到蓝色建议',evidenceCallIds:[last.tool_call_id]};
      }
    } else if (lastUser.includes('LIST')) {
      if (last.role === 'user') {name='list_files';args={};} else answer='已完成';
    } else if (lastUser.includes('SECOND')) {
      if (last.role === 'user') {name='task_finish';args={summary:'second 已交付'};}
      else {assert.equal(JSON.parse(last.content).error,true);answer='缺少新文件';}
    } else if (last.role === 'user') {
      name='write_file'; args={path:'first.txt',content:'first'};
    } else if (messages.filter(m=>m.role==='tool').length === 1) {
      name='verify_file'; args={path:'first.txt',expected:'first'};
    } else {name='task_finish';args={summary:'first 已交付',evidenceCallIds:[last.tool_call_id]};}
    const delta=name?{tool_calls:[{index:0,id:'test-'+(++serial),type:'function',function:{name,arguments:JSON.stringify(args)}}]}:{content:answer};
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:name?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
  } catch (error) {failures.push(error.message);res.writeHead(500);res.end('fixture failed');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try {
  app=await startNative({label:'work',executable:exe,ui,data:path.join(output,'data'),output});
  for(const id of ['lead','worker']){
    await app.api('/api/dimension/bots',{id,name:id,persona:'fixture'});
    await app.api('/api/dimension/bots/'+id+'/roster',{mode:'work',present:true},'PATCH');
    await app.api('/api/dimension/work/settings',{botId:id,cliEngine:'builtin'},'PATCH');
  }
  await app.api('/api/providers',{name:'fixture',entry:{kind:'openai-chat-compat',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',spec:{model:'mock'},secret:{kind:'literal',value:'synthetic'}}});
  await app.api('/api/providers/fixture/activate',{});
  const group=(await app.api('/api/dimension/groups',{name:'test',ownerId:'lead',members:['lead','worker']})).group.id;
  await app.api('/api/dimension/groups/'+group+'/roster',{mode:'work',present:true},'POST');
  const submit=async(text,botId='lead',groupId='')=>(await app.api('/api/dimension/work/runs',{text,botId,groupId,requestId:'test-'+(++serial)})).run.id;
  const read=id=>app.api('/api/dimension/work/runs/'+id);
  const done=id=>until(async()=>{const r=await read(id);return r.terminal&&!r.executing&&r},'finished '+id,20000);
  assert.equal((await done(await submit('LIST 创建 report.txt'))).status,'failed');
  const id=await submit('创建 first.txt');
  assert.equal((await done(id)).status,'completed');
  await app.api('/api/dimension/work/runs/'+id+'/resume',{requestId:'continue',text:'SECOND 创建 second.txt'});
  assert.equal((await done(id)).status,'failed');
  const bad=await done(await submit('GROUP INVALID 派单','lead',group));
  assert.equal(bad.assignments.length,0);
  const other=await submit('INDEPENDENT 只返回文本','worker',group);
  await until(()=>independentStarted,'independent fixture'); 
  unrelatedId=other;
  const foreign=await done(await submit('GROUP FOREIGN 改派','lead',group));
  assert.equal(foreign.assignments.length,0);
  assert.equal((await read(other)).status,'running');
  const parent=await submit('GROUP 汇总颜色建议','lead',group);
  await until(async()=>(await read(parent)).assignments.length>0,'member queued');
  assert.equal((await read(other)).status,'running');
  assert.equal((await read(parent)).terminal,false);
  releaseIndependent();
  assert.equal((await done(other)).status,'completed');
  assert.equal((await done(parent)).status,'completed');
  assert.equal(observedMember,true);
  assert.deepEqual(failures,[]);
  console.log('PASS file delivery, resumed evidence, batch validation, independent queue and verified group return');
} finally {releaseIndependent();await app?.stop();server.close();}
