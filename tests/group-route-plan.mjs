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
await writeFile(path.join(npm,'hermes.cmd'),await readFile(path.join(npm,'qwen.cmd')));
const providerNativeEntry = { ...nativeEntry, engineId: 'hermes', providerId: 'native-fixture', custom: true };
const ranked='claude-opus-4-6-thinking-auto-high-effort', middle='local-standard', calls=[];
let counter=0;
const server=http.createServer(async(req,res)=>{
  if(req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[middle,ranked,'catalog-only'].map(id=>({id}))}));return;}
  let text='';for await (const chunk of req)text+=chunk;
  const body=JSON.parse(text),lead=body.tools?.some(t=>t.function?.name==='delegate_work'),soloCommander=!lead && body.tools?.some(t=>t.function?.name==='dispatch_native_cli');
  calls.push({lead,soloCommander,body});
  if(lead && body.messages.some(m=>m.role==='user' && m.content==='HOLD_ROUTE')){
    res.writeHead(503);res.end();return;
  }
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
  if(body.messages.some(m=>m.role==='user' && m.content==='MULTI_APPROVAL')){
    args.jobs=[
      {id:'first',botId:'dispatch-member',text:'校验编码',routeReason:'执行编码',poolModel:providerNativeEntry},
      {id:'second',botId:'dispatch-review',text:'审查设计',routeReason:'独立审查',poolModel:{providerId:'dispatch',model:'catalog-only'}},
    ];
  }
  if(body.messages.some(m=>m.role==='user' && m.content==='SPECIALTY_PLAN')){
    args.jobs=[{id:'specialist',botId:'dispatch-member',text:'设计前端接口',specialty:'frontend',acceptance:'提供接口清单'}];
  }
  const picking=body.messages.some(m=>m.role==='system' && m.content?.startsWith('你负责模型分配'));
  const review=body.messages.some(m=>m.role==='system' && m.content?.startsWith('你是群主，审查刚刚交付'));
  const blocked=review && body.messages.some(m=>m.content?.includes('BLOCK_REVIEW'));
  const fencedReview = '审查结论如下：\n```json\n' + JSON.stringify({pass:!blocked,reason:blocked?'缺少浏览器验收':'已检查文本交付'}) + '\n```';
  const delta=review?{content:fencedReview}:picking?{content:JSON.stringify(args)}:lead&&!body.messages.some(m=>m.role==='tool')?{tool_calls:[{index:0,id:'dispatch'+(++counter),type:'function',function:{name:tool,arguments:JSON.stringify(args)}}]}:soloCommander&&!body.messages.some(m=>m.role==='tool')?{tool_calls:[{index:0,id:'solo-cli-'+(++counter),type:'function',function:{name:'dispatch_native_cli',arguments:JSON.stringify({task:'按已确认计划实现并验证节日插件'})}}]}:{content:body.tools?.length?'已处理。':'先确定节日内容，再实现并测试。是否按此计划开始执行？'};
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let app;
try{
  app=await startNative({label:'dispatch-test',executable:path.resolve(exe),ui:path.resolve('ui'),data:path.join(output,'data'),output});
  const api=(...args)=>app.api(...args);
  await api('/api/providers',{name:'dispatch',entry:{kind:'openai-chat-compat',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',spec:{model:middle,maxTokens:4096}},secretValue:'test-only'});
  for(const botId of ['dispatch-lead','dispatch-member','dispatch-review']){
    await api('/api/dimension/bots',{id:botId,name:botId,persona:'测试成员'});
    await api('/api/dimension/bots/'+botId+'/roster',{mode:'work',present:true},'PATCH');
    await api('/api/dimension/bots/'+botId+'/conversation-model',{modelSelection:{providerId:'dispatch',model:middle}});
    await api('/api/dimension/work/settings',{botId,cliEngine:'builtin',workspaceMode:'windows_native',projectCwd:project,approvalMode:'full'},'PATCH');
  }
  await api('/api/dimension/work-models',{enabled:true,routes:{standard:{providerId:'dispatch',model:middle},complex:{providerId:'dispatch',model:ranked}}},'PUT');
  const gid=(await api('/api/dimension/groups',{name:'Dispatch',ownerId:'dispatch-lead',members:['dispatch-lead','dispatch-member','dispatch-review']})).group.id;
  const idea = '我想做个星露谷插件';
  let discussionRun = (await api('/api/dimension/work/runs',{botId:'dispatch-lead',groupId:gid,text:idea,requestId:'idea'})).run;
  const discussionId = discussionRun.id;
  for (const [index, text] of [idea, '加一个节日，细节还没确定', '等我说“开始做”再动手'].entries()) {
    if (index) await api('/api/dimension/work/runs/'+discussionId+'/resume',{text,requestId:'idea-'+index});
    for (let i=0;i<100;i++) {
      discussionRun=await api('/api/dimension/work/runs/'+discussionId);
      if (discussionRun.terminal) break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(discussionRun.status,'completed');
    assert.equal(discussionRun.assignments.length,0);
    const request=calls.findLast(x=>x.body.messages.some(m=>m.role==='user' && m.content===text));
    assert(request && !request.body.tools?.length,'discussion exposed execution tools');
  }
  assert.equal(discussionRun.planPhase,'ready');
  assert(discussionRun.answer.includes(ranked) && discussionRun.answer.includes('dispatch-member'));
  assert.equal(discussionRun.routePlan.assignments.job1.model,ranked);
  const persisted=discussionRun.routePlan;
  await assert.rejects(api('/api/dimension/work/runs/'+discussionId+'/resume',{text:'开始',planAttempt:'1',requestId:'stale'}));
  await app.stop();
  app=await startNative({label:'restart-plan',executable:path.resolve(exe),ui:path.resolve('ui'),data:path.join(output,'data'),output});
  assert.deepEqual((await api('/api/dimension/work/runs/'+discussionId)).routePlan,persisted);
  const approvedAt=calls.length;
  await api('/api/dimension/work/runs/'+discussionId+'/resume',{text:'开始做吧',requestId:'idea-start'});
  for(let i=0;i<100 && !calls.slice(approvedAt).some(x=>x.lead);i++) await new Promise(resolve=>setTimeout(resolve,100));
  const duplicate=await api('/api/dimension/work/runs/'+discussionId+'/resume',{text:'开始做吧',requestId:'idea-start'});
  assert.equal(duplicate.run.attempt,discussionRun.attempt+1);
  const approved=calls.slice(approvedAt).find(x=>x.lead);
  assert(approved?.body.messages.some(m=>m.content===idea),'authorized execution must keep the original idea');
  console.log('PASS discussion, requirements follow-up, quoted confirmation and explicit start');
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
    const run=(await api('/api/dimension/work/runs',{botId:'dispatch-lead',groupId:gid,text:'直接做，不用先出计划：'+test+' 只返回文本',deliveryMode:'queue',requestId:test})).run;
    let saved;
    for(let i=0;i<200;i++){
      saved=await api('/api/dimension/work/runs/'+run.id);
      if(saved.terminal && (denied || saved.assignments.some(a=>a.actualRoute?.model===expected) && calls.slice(before).some(r=>!r.lead && r.body.tools?.length > 0 && r.body.model===expected)))break;
      await new Promise(r=>setTimeout(r,180));
    }
    const seen=calls.slice(before),lead=seen.find(r=>r.lead && r.body.messages.some(m=>m.role==='user' && m.content==='直接做，不用先出计划：'+test+' 只返回文本'));
    assert(lead,JSON.stringify(saved).slice(-1200));
    assert(lead.body.messages.some(m=>m.role==='system'&&m.content.includes(ranked)&&m.content.includes('accountAccess')),'missing coordinator inventory');
    if(denied){assert.equal(seen.filter(r=>!r.lead && r.body.tools?.length > 0).length,0);assert.equal(saved.assignments.length,0);continue;}
    const plan=saved.events.find(e=>e.dispatchPlan);assert(plan,JSON.stringify(saved.events).slice(-2200));assert(plan.text.includes(test==="UPGRADE_CASE"?middle:expected));
    if(test==="UPGRADE_CASE")assert(saved.events.some(e=>e.dispatchPlan&&e.text.includes("已升级")&&e.text.includes(ranked)));
    assert(seen.some(r=>!r.lead && r.body.tools?.length > 0 && r.body.model===expected), 'child request did not use planned model');
    assert.equal(saved.assignments[0].actualRoute.model,expected);
    console.log(test,plan.text);
  }
  const pending=(await api('/api/dimension/work/runs',{botId:'dispatch-lead',groupId:gid,text:'HOLD_ROUTE',deliveryMode:'queue',requestId:'hold-plan'})).run;
  async function settled(id){
    for(let i=0;i<250;i++){
      const r=await api('/api/dimension/work/runs/'+id);
      if(r.terminal && !r.executing)return r;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error('run did not settle');
  }
  const held=await settled(pending.id);
  assert.equal(held.planPhase,'ready');
  const holdOffset=calls.length;
  await api('/api/dimension/work/runs/'+pending.id+'/resume',{text:'执行',planAttempt:String(held.attempt),requestId:'hold-start'});
  const interrupted=await settled(pending.id);
  assert.equal(interrupted.status,'interrupted');
  assert(interrupted.error.includes('重新') && interrupted.assignments.length===0);
  assert(calls.slice(holdOffset).filter(x=>x.lead).every(x=>x.body.model===held.routePlan.lead.model));
  assert(!interrupted.events.some(e=>e.kind==='tool'));
  console.log('PASS unavailable approved coordinator pauses without switching models');
  await api('/api/dimension/work/settings',{botId:'dispatch-lead',cliEngine:'qwen-code',cliModelSource:'native',
    cliEngineConfig:{engineId:'qwen-code',modelSource:'native',model:'solo-fixture'}},'PATCH');
  const solo=(await api('/api/dimension/work/runs',{botId:'dispatch-lead',text:'创建一个节日插件',deliveryMode:'queue',requestId:'solo-plan'})).run;
  let proposal;
  for(let i=0;i<100;i++){
    proposal=await api('/api/dimension/work/runs/'+solo.id);
    if(proposal.terminal)break;
    await new Promise(r=>setTimeout(r,100));
  }
  assert.equal(proposal.planPhase,'ready');
  assert(proposal.answer.includes('solo-fixture') && proposal.routePlan.cli.engineId==='qwen-code');
  await api('/api/dimension/work/settings',{botId:'dispatch-lead',cliEngine:'builtin'},'PATCH');
  assert(!proposal.events.some(e=>e.kind==='tool'||e.kind==='cli-step'));
  assert.equal(await readFile(marker,'utf8').catch(()=>''),'');
  await api('/api/dimension/work/runs/'+solo.id+'/resume',{text:'执行',planAttempt:String(proposal.attempt),requestId:'solo-go'});
  for(let i=0;i<150 && (await readFile(marker,'utf8').catch(()=>'' )).trim()!=='solo-fixture';i++)await new Promise(r=>setTimeout(r,100));
  assert.equal((await readFile(marker,'utf8')).trim(),'solo-fixture');
  console.log('PASS private CLI process starts only after explicit plan confirmation');
  const inventory=await api('/api/dimension/work-models');
  assert(inventory.cliModels.some(m=>m.engineId===nativeEntry.engineId && m.model===nativeEntry.model));
  const custom={...nativeEntry,model:'private-version',custom:true};
  const mixed=[{providerId:'dispatch',model:'catalog-only'},custom,nativeEntry,providerNativeEntry];
  assert.deepEqual((await api('/api/dimension/work-models',{...inventory.settings,pool:mixed},'PUT')).settings.pool,mixed);
  await assert.rejects(api('/api/dimension/work-models',{...inventory.settings,pool:[{...custom,engineId:'unknown-cli'}]},'PUT'));
  const nativeRun=(await api('/api/dimension/work/runs',{botId:'dispatch-lead',groupId:gid,text:'直接做，不用先出计划：NATIVE_ROUTE 只返回文本',requestId:'native'})).run;
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
  await settled(nativeRun.id);
  const multi=(await api('/api/dimension/work/runs',{botId:'dispatch-lead',groupId:gid,text:'MULTI_APPROVAL',deliveryMode:'queue',requestId:'multi-plan'})).run;
  const published=await settled(multi.id);
  assert.equal(published.planPhase,'ready');
  assert.equal(published.assignments.length,0);
  const library = await api('/api/dimension/canvas/library');
  const blueprint = library.canvases.find(g => g.id === published.routePlan.blueprintCanvasId);
  const nativeNode = blueprint?.nodes.find(n => n.botId === 'dispatch-member');
  assert.equal(nativeNode?.cliModelSource, 'native');
  assert.equal(nativeNode.cliNativeProvider, providerNativeEntry.providerId);
  assert.equal(nativeNode.cliNativeModel, providerNativeEntry.model);
  assert(published.answer.includes(nativeEntry.model) && published.answer.includes('catalog-only'));
  await api('/api/dimension/work/runs/'+multi.id+'/resume',{text:'开始',planAttempt:String(published.attempt),requestId:'multi-go'});
  let actual;
  for(let i=0;i<200;i++){
    actual=await api('/api/dimension/work/runs/'+multi.id);
    if(actual.assignments.length===2 && actual.assignments.every(a=>a.actualRoute?.model))break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(actual.assignments.length,2);
  for(const job of published.routePlan.jobs){
    const child=await api('/api/dimension/work/runs/'+actual.assignments.find(a=>a.botId===job.botId).runId);
    const expected=published.routePlan.assignments[job.id];
    assert.equal(child.actualRoute.model,expected.model);
    assert.equal(child.assignedRoute.cli?.model,expected.cli?.model);
  }
  console.log('PASS confirmed two-member mixed CLI/API assignment matches actual routes');
  await settled(multi.id);
  const manual = {providerId:'dispatch',model:middle,specialties:['frontend'],manualOnly:true};
  const specialist = {providerId:'dispatch',model:'catalog-only',specialties:['frontend'],costTier:'standard'};
  const profiles = [manual,{...nativeEntry,costTier:'low'},specialist];
  const prefs = await api('/api/dimension/work-models',{...inventory.settings,routingPreference:'quality',pool:profiles},'PUT');
  assert.deepEqual(prefs.settings.pool,profiles);
  await assert.rejects(api('/api/dimension/work-models',{...prefs.settings,pool:[{...manual,specialties:['invalid']}]},'PUT'));
  const draft=(await api('/api/dimension/work/runs',{botId:'dispatch-lead',groupId:gid,text:'SPECIALTY_PLAN',requestId:'specialty-plan'})).run;
  const plan=await settled(draft.id);
  assert.equal(plan.routePlan.assignments.job1.model,specialist.model);
  const graph=(await api('/api/dimension/canvas/library')).canvases.find(g=>g.id===plan.routePlan.blueprintCanvasId);
  const node=graph.nodes.find(n=>n.id==='job1');
  assert(node.prompt.includes('提供接口清单'));
  node.model=manual.model;
  node.assignmentLocked=true;
  node.requiresWorkspace=true;
  await api('/api/dimension/canvas/save',graph);
  const start='/api/dimension/work/runs/'+draft.id+'/execute-blueprint';
  await assert.rejects(api(start,{canvasId:graph.id,requestId:'invalid-capability'}));
  const packed = await api('/api/dimension/canvas/collapse',{
    canvasId:graph.id,nodeIds:[node.id],name:'成员交付',description:'保留工作区能力要求'
  });
  assert(packed.function.nodes.some(n=>n.id===node.id && n.requiresWorkspace));
  const nested = await app.response(start,{canvasId:graph.id,requestId:'invalid-nested-capability'});
  assert.equal(nested.status,409,nested.text);
  assert(nested.text.includes('成员交付') && nested.text.includes('CLI'),nested.text);
  console.log('PASS nested function capabilities checked before group blueprint execution');
  node.requiresWorkspace=false;
  // User manual override to an outside-pool model is now explicitly allowed in DimensionImage blueprints!
  node.model='off-pool';
  await api('/api/dimension/canvas/save',graph);
  const offPoolOffset=calls.length;
  await api(start,{canvasId:graph.id,requestId:'off-pool-allowed'});
  const offPoolDone=await settled(draft.id);
  assert.equal(offPoolDone.status,'completed',JSON.stringify(offPoolDone.events).slice(-1500));
  assert(calls.slice(offPoolOffset).some(call=>call.body.model==='off-pool'), 'Blueprint must execute user-selected outside-pool model');
  node.model=manual.model;
  await api('/api/dimension/canvas/save',graph);
  const offset=calls.length;
  await api(start,{canvasId:graph.id,requestId:'confirmed-override'});
  const executed=await settled(draft.id);
  assert.equal(executed.status,'completed',JSON.stringify(executed.events).slice(-1500));
  assert(calls.slice(offset).some(call=>call.body.model===manual.model && JSON.stringify(call.body.messages).includes('提供接口清单')));
  const runs=await api('/api/dimension/canvas/runs');
  const cr=runs.runs.find(r=>r.canvasId===graph.id);
  const state=(await api('/api/dimension/canvas/runs/'+cr.runId)).run.nodes.job1;
  assert.equal(state.plannedRoute,'API / dispatch / '+manual.model);
  assert.equal(state.modelLabel,'dispatch / '+manual.model);
  assert(executed.events.some(e=>e.blueprintStep?.status==='review_passed'));
  node.prompt+=' BLOCK_REVIEW';
  await api('/api/dimension/canvas/save',graph);
  await api(start,{canvasId:graph.id,requestId:'reject-handoff'});
  const paused=await settled(draft.id);
  assert.equal(paused.status,'interrupted');
  assert.equal(paused.planPhase,'ready');
  assert(paused.error.includes('执行组合已锁定'));
  assert(paused.events.some(e=>e.blueprintStep?.status==='review_blocked'));
  const blockedRun=(await api('/api/dimension/canvas/runs')).runs.find(r=>r.canvasId===graph.id);
  assert.equal(blockedRun.nodes['bp-lead-final'].iteration,0);
  assert(blockedRun.nodes.job1.output);
  const independentStart = await app.response('/api/dimension/canvas/runs', {canvasId:graph.id,workspaceDir:project});
  assert.equal(independentStart.status,409);
  assert.equal((await api('/api/dimension/work/runs/'+draft.id)).status,'interrupted');
  const kept=(await api('/api/dimension/canvas/library')).canvases.find(g=>g.id===graph.id).nodes.find(n=>n.id===node.id);
  assert(kept.assignmentLocked && kept.model===manual.model);
  console.log('PASS owner review blocks downstream delivery and preserves locked selection and partial output');
  await api('/api/dimension/work-models',{...prefs.settings,routingPreference:'economy'},'PUT');
  const economy=(await api('/api/dimension/work/runs',{botId:'dispatch-lead',groupId:gid,text:'SPECIALTY_PLAN',requestId:'economy-plan'})).run;
  const cheaper=await settled(economy.id);
  assert.equal(cheaper.routePlan.assignments.job1.cli?.model,nativeEntry.model);
  console.log('PASS profile routing, economy preference, manual override, hard constraints and saved execution receipt');
  console.log('PASS both dispatch paths and unconfigured route refusal');
}finally{if(app)await app.stop();server.closeAllConnections();await new Promise(r=>server.close(r));}
