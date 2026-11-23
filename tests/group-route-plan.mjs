import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {startNative} from './archive-export-api.mjs';

const [exe,root]=process.argv.slice(2);
assert(exe && path.isAbsolute(root));
await mkdir(root,{recursive:true});
const output=await mkdtemp(path.join(root,'dispatch-')), project=path.join(output,'project');
await mkdir(project);await mkdir(path.join(output,'temp'));
// Use a private CLI installation, never a signed-in executable, for native dispatch.
process.env.APPDATA=path.join(output,'roaming');
const npm=path.join(process.env.APPDATA,'npm');
await mkdir(npm,{recursive:true});
const marker=path.join(project,'native-model.txt');
await writeFile(path.join(npm,'qwen.cmd'), [
  '@echo off',':next','if "%~1"=="" exit /b 1','if "%~1"=="-m" goto model','shift','goto next',
  ':model','>native-model.txt echo %~2','echo {"type":"result","result":"fixture complete"}','exit /b 0'
].join('\r\n'));
const nativeEntry={engineId:'qwen-code',providerId:'',model:'qwen3-max'};
const ranked='claude-opus-4-6-thinking-auto-high-effort', middle='local-standard', calls=[];
let counter=0;
const server=http.createServer(async(req,res)=>{
  if(req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[middle,ranked,'catalog-only'].map(id=>({id}))}));return;}
  let text='';for await (const chunk of req)text+=chunk;
  const body=JSON.parse(text),lead=body.tools?.some(t=>t.function?.name==='delegate_work');
  calls.push({lead,body});
  const upgrade=body.messages.some(m=>typeof m.content==='string'&&m.content.includes('UPGRADE_CASE'));
  if(!lead && upgrade && body.model===middle){res.writeHead(503);res.end();return;}
  const direct=upgrade || body.messages.some(m=>typeof m.content==='string'&&m.content.includes('DIRECT_CASE'));
  const invalid=body.messages.some(m=>typeof m.content==='string'&&m.content.includes('INVALID_CASE'));
  const poolCase=body.messages.findLast(m=>m.role==='user')?.content || '';
  const poolTest=typeof poolCase==='string' && poolCase.includes('POOL_');
  const tool=direct?'send_member_task':'delegate_work';
  const args={jobs:[{...(direct?{task:'核对编码交付'}:{id:'design',text:'制定验收方案'}),botId:'dispatch-member',routeTier:invalid?'catalog-only':upgrade?'standard':'complex',routeReason:'需要核对复杂边界',benchmarkCategory:'Reasoning'}]};
  if(poolTest) args.jobs[0].poolModel={providerId:'dispatch',model:poolCase.includes('DENIED')?ranked:'catalog-only'};
  if(typeof poolCase==="string" && poolCase.includes("NATIVE_ROUTE")) args.jobs[0].poolModel=nativeEntry;
  const delta=lead&&!body.messages.some(m=>m.role==='tool')?{tool_calls:[{index:0,id:'dispatch'+(++counter),type:'function',function:{name:tool,arguments:JSON.stringify(args)}}]}:{content:'已处理。'};
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let app;
try{
  app=await startNative({label:'dispatch-test',executable:path.resolve(exe),ui:path.resolve('ui'),data:path.join(output,'data'),output});
  const api=(...args)=>app.api(...args);
  await api('/api/providers',{name:'dispatch',entry:{kind:'openai-chat-compat',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',spec:{model:middle,maxTokens:4096}},secretValue:'test-only'});
  for(const botId of ['dispatch-lead','dispatch-member']){
    await api('/api/dimension/bots',{id:botId,name:botId,persona:'测试成员'});
    await api('/api/dimension/bots/'+botId+'/roster',{mode:'work',present:true},'PATCH');
    await api('/api/dimension/bots/'+botId+'/conversation-model',{modelSelection:{providerId:'dispatch',model:middle}});
    await api('/api/dimension/work/settings',{botId,cliEngine:'builtin',workspaceMode:'windows_native',projectCwd:project,approvalMode:'full'},'PATCH');
  }
  await api('/api/dimension/work-models',{enabled:true,routes:{standard:{providerId:'dispatch',model:middle},complex:{providerId:'dispatch',model:ranked}}},'PUT');
  const gid=(await api('/api/dimension/groups',{name:'Dispatch',ownerId:'dispatch-lead',members:['dispatch-lead','dispatch-member']})).group.id;
  for(const test of ['DIRECT_CASE','DELEGATE_CASE','UPGRADE_CASE','INVALID_CASE','POOL_PICK','POOL_DENIED']){
    const poolTest=test.startsWith('POOL_'), denied=test==='INVALID_CASE'||test==='POOL_DENIED';
    const expected=poolTest?'catalog-only':ranked;
    if(test==='POOL_PICK'){
      const settings=(await api('/api/dimension/work-models')).settings;
      const entry={providerId:'dispatch',model:expected};
      const choices=[{providerId:"dispatch",model:middle},entry];
      const savedPool=await api('/api/dimension/work-models',{...settings,pool:[...choices,entry]},'PUT');
      assert.deepEqual(savedPool.settings.pool,choices);
      assert.deepEqual((await api('/api/dimension/work-models',settings,'PUT')).settings.pool,choices);
    }
    const before=calls.length;
    const run=(await api('/api/dimension/work/runs',{botId:'dispatch-lead',groupId:gid,text:test+' 只返回文本',requestId:test})).run;
    let saved;
    for(let i=0;i<200;i++){
      saved=await api('/api/dimension/work/runs/'+run.id);
      if(saved.terminal && (denied || saved.assignments.some(a=>a.actualRoute?.model===expected) && calls.slice(before).some(r=>!r.lead && r.body.tools?.length > 0 && r.body.model===expected)))break;
      await new Promise(r=>setTimeout(r,180));
    }
    const seen=calls.slice(before),lead=seen.find(r=>r.lead);
    assert(lead,JSON.stringify(saved).slice(-1200));
    assert(lead.body.messages.some(m=>m.role==='system'&&m.content.includes(ranked)&&m.content.includes('accountAccess')),'missing coordinator inventory');
    if(denied){assert.equal(seen.filter(r=>!r.lead && r.body.tools?.length > 0).length,0);assert.equal(saved.assignments.length,0);continue;}
    const plan=saved.events.find(e=>e.dispatchPlan);assert(plan,JSON.stringify(saved.events).slice(-2200));assert(plan.text.includes(test==="UPGRADE_CASE"?middle:expected));
    if(test==="UPGRADE_CASE")assert(saved.events.some(e=>e.dispatchPlan&&e.text.includes("已升级")&&e.text.includes(ranked)));
    assert(seen.some(r=>!r.lead && r.body.tools?.length > 0 && r.body.model===expected), 'child request did not use planned model');
    assert.equal(saved.assignments[0].actualRoute.model,expected);
    console.log(test,plan.text);
  }
  const inventory=await api('/api/dimension/work-models');
  assert(inventory.cliModels.some(m=>m.engineId===nativeEntry.engineId && m.model===nativeEntry.model));
  const custom={...nativeEntry,model:'private-version',custom:true};
  const mixed=[{providerId:'dispatch',model:'catalog-only'},custom,nativeEntry];
  assert.deepEqual((await api('/api/dimension/work-models',{...inventory.settings,pool:mixed},'PUT')).settings.pool,mixed);
  await assert.rejects(api('/api/dimension/work-models',{...inventory.settings,pool:[{...custom,engineId:'unknown-cli'}]},'PUT'));
  const nativeRun=(await api('/api/dimension/work/runs',{botId:'dispatch-lead',groupId:gid,text:'NATIVE_ROUTE 只返回文本',requestId:'native'})).run;
  let receipt='';
  for(let i=0;i<150;i++){
    receipt=await readFile(marker,'utf8').catch(()=>'');
    if(receipt.trim()===nativeEntry.model)break;
    await new Promise(r=>setTimeout(r,160));
  }
  assert.equal(receipt.trim(),nativeEntry.model,'CLI process must receive the selected model');
  const report=await api('/api/dimension/work/runs/'+nativeRun.id);
  assert(report.events.some(e=>e.dispatchPlan && e.text.includes(nativeEntry.model)));
  console.log('PASS native CLI received selected model');
  console.log('PASS both dispatch paths and unconfigured route refusal');
}finally{if(app)await app.stop();server.closeAllConnections();await new Promise(r=>server.close(r));}
