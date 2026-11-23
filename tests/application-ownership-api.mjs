// Actual native HTTP/Work/ApplicationBridge with a deliberately synthetic JSON
// desktop peer. No WSL distribution, browser, keyboard/mouse or account is used.
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,unlink,stat} from 'node:fs/promises';
import path from 'node:path';
import {startNative,until,delay,parseOptions} from './archive-export-api.mjs';
const project=path.resolve(import.meta.dirname,'..'),options=parseOptions();
const executable=path.resolve(options.get('exe')||path.join(project,'outputs/build/DImensionagent-native.exe'));
const peer=path.resolve(options.get('peer')||path.join(project,'outputs/build/application_bridge_test.exe'));
const parent=path.resolve(options.get('output')||path.join(project,'outputs/application-ownership-api'));
assert(path.isAbsolute(parent)&&parent!==path.parse(parent).root,'Test output must be a non-root absolute directory');await mkdir(parent,{recursive:true});
const output=await mkdtemp(path.join(parent,'run-')),data=path.join(output,'data');await mkdir(path.join(output,'temp'));
const checks=[],processes=[],traces=[],errors=[],calls=[],sockets=new Set(),pending=new Map(),queues=new Map(),runs=new Map(),results=new Map();
let app,serial=0,peerFolder;
const notifications=entry=>entry.stdout.split(/\r?\n/).flatMap(line=>{try{const value=JSON.parse(line);return value.notification?[value.notification]:[];}catch{return [];}});
const allNotifications=()=>processes.flatMap(notifications);
const notificationControls=entry=>entry.stdout.split(/\r?\n/).flatMap(line=>{try{const value=JSON.parse(line);return value.notificationControl?[value.notificationControl]:[];}catch{return [];}});
const allNotificationControls=()=>processes.flatMap(notificationControls);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const pass=name=>{checks.push({name,ok:true});console.log('PASS '+name);};
const api=(...args)=>app.api(...args);
function dispatch(tag){
 const res=pending.get(tag),queue=queues.get(tag);if(!res||!queue?.length)return;
 pending.delete(tag);const call=queue.shift();calls.push({tag,...call});
 res.writeHead(200,{'content-type':'text/event-stream'});
 res.end('data: '+JSON.stringify({choices:[{index:0,delta:{tool_calls:[{index:0,id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n');
}
const model=http.createServer(async(req,res)=>{
 try{
  assert.equal(req.url,'/v1/chat/completions');assert.equal(req.method,'POST');let text='';for await(const b of req){text+=b;assert(Buffer.byteLength(text)<4*1024*1024);}
  const body=JSON.parse(text);for(const message of body.messages)if(message.role==='tool')results.set(message.tool_call_id,JSON.parse(message.content));
  const tags=JSON.stringify(body.messages.filter(m=>m.role==='user')).match(/APP_OWN:([a-z]+)/g);
  assert(tags?.length,'synthetic task identity required');const tag=tags.at(-1).slice(8);
  assert(!pending.has(tag),'one model turn per fixture run');pending.set(tag,res);
  res.on('close',()=>{if(pending.get(tag)===res)pending.delete(tag);});dispatch(tag);
 }catch(error){errors.push(error.stack);if(!res.headersSent)res.writeHead(500);res.end('fixture failed');}
});
model.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('error',()=>{});});
await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
function enqueue(tag,name,args){const call={id:'ownership-'+(++serial),name,arguments:args};if(!queues.has(tag))queues.set(tag,[]);queues.get(tag).push(call);dispatch(tag);return call;}
async function receipt(tag,call){return until(()=>results.get(call.id),'model tool result '+tag+' '+call.name,15000);}
async function tool(tag,name,args){return receipt(tag,enqueue(tag,name,args));}
const state=tag=>api('/api/dimension/work/runs/'+runs.get(tag));
const job=id=>api('/api/dimension/app-bridge/jobs/'+id).then(r=>r.job);
const list=()=>api('/api/dimension/app-bridge');
async function findJob(tag){return until(async()=>{const rows=(await list()).jobs;return rows.find(j=>j.runId===runs.get(tag));},'persisted job '+tag);}
async function submit(tag){
 const bot='ownership-'+tag;await api('/api/dimension/bots',{id:bot,name:'Synthetic '+tag,mode:'work'});
 await api('/api/dimension/work/settings',{botId:bot,approvalMode:'full'},'PATCH');
 const submitted=await api('/api/dimension/work/runs',{botId:bot,requestId:'submit-'+tag,text:'APP_OWN:'+tag+' Synthetic ownership test'});runs.set(tag,submitted.run.id);
 await until(()=>pending.has(tag),'initial model request '+tag);return submitted.run.id;
}
const startArgs=tag=>({appId:'fixture',prompt:'Synthetic image '+tag});
async function start(tag){const result=await tool(tag,'application_start',startArgs(tag));assert.equal(result.error,false,result.result);return JSON.parse(result.result).job.id;}
async function paused(tag,id){enqueue(tag,'application_wait',{jobId:id,status:'waiting-user',reason:'Synthetic controlled pause'});await until(async()=>{const run=await state(tag);return run.status==='interrupted'&&!run.executing;},'paused '+tag);assert.equal((await job(id)).status,'waiting-user');}
async function finish(tag,result){enqueue(tag,'task_finish',{summary:'Synthetic image verified',artifacts:result.artifacts,verification:result.verification});await until(async()=>{const run=await state(tag);return run.status==='completed'&&!run.executing;},'finished '+tag);}
const history=async()=>{try{return (await readFile(path.join(peerFolder,'peer-history.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(e){if(e.code==='ENOENT')return [];throw e;}};
const downloads=names=>writeFile(path.join(peerFolder,'peer-downloads.json'),JSON.stringify({names}));
const inputCount=rows=>rows.filter(row=>['press','click','drag','scroll','type'].includes(row.op)).length;
const exists=async file=>{try{await stat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const startNativeFixture=async label=>app=await startNative({label,executable,ui:path.join(project,'ui'),data,output,processes,traces,
 extraArgs:['--wsl',peer,'--desktop-helper',peer,'--sandbox-distro','application-ownership-fixture']});
try{
 await startNativeFixture('ownership');
 await api('/api/dimension/app-bridge/apps',{id:'fixture',name:'Synthetic peer only',url:'http://127.0.0.1:1/never-opened',instructions:'This fixture never opens a browser.'});
 await api('/api/dimension/app-bridge/apps/fixture',{enabled:true},'PATCH');
 await api('/api/providers',{name:'ownership',entry:{kind:'openai-chat-compat',baseUrl:'http://127.0.0.1:'+model.address().port+'/v1',spec:{model:'synthetic-ownership'}},secretValue:'synthetic-only'});
 await api('/api/providers/ownership/activate',{});
 await submit('first');const first=await start('first');
 const desktop=await api('/api/dimension/app-bridge/apps/fixture/desktop');peerFolder=path.dirname(desktop.workspace);
 assert(path.relative(data,peerFolder)&&!path.relative(data,peerFolder).startsWith('..'));
 const saved=JSON.parse(await readFile(path.join(data,'application-services/services.json'),'utf8'));
 assert.equal(saved.jobs[first].desktopOwned,true);assert.equal(saved.jobs[first].started,true);
 pass('Actual Work/application HTTP creates a durable owner using only the synthetic external peer');
 await paused('first',first);
 await submit('second');const waitingCall=enqueue('second','application_start',startArgs('second'));const second=(await findJob('second')).id;
 assert.equal((await job(second)).status,'queued');
 const waiting=await job(second);assert.match(waiting.waitReason,/旧任务占用/);assert.match(waiting.detail,/旧任务占用/);
 assert.equal(waiting.waitingFor.length,1);assert.equal(waiting.waitingFor[0].jobId,first);assert.equal(waiting.waitingFor[0].runId,runs.get('first'));assert.equal(waiting.waitingFor[0].ownership,'desktop');
 await api('/api/dimension/app-bridge/jobs/'+first+'/resume',{});await until(()=>pending.has('first'),'resumed first model turn');
 await delay(60);assert.equal((await job(second)).started,false);
 const resumedDisk=JSON.parse(await readFile(path.join(data,'application-services/services.json'),'utf8'));
 assert.equal(resumedDisk.jobs[first].desktopOwned,true);assert.equal(resumedDisk.jobs[second].desktopOwned,false);
 pass('Resuming A retains ownership while B remains queued');
 const steered=await api('/api/dimension/work/runs',{botId:'ownership-second',requestId:'inspect-queued',text:'APP_OWN:second Check queued action rejection'});
 assert.equal(steered.run.id,runs.get('second'));await until(()=>pending.has('second'),'queued B cancellation drains into new model turn');
 assert.equal((await job(second)).started,false);
 const action={op:'press',key:'Enter',observationId:'deliberately-unused'};
 const beforeInputs=inputCount(await history());
 for(const [tag,id] of [['second',second],['first',first]]){
  const moved=await tool(tag,'application_action',{jobId:id,action});assert.equal(moved.error,true,moved.result);assert.equal(moved.metadata.no_side_effects,true);
  const collected=await tool(tag,'application_collect',{jobId:id});assert.equal(collected.error,true,collected.result);assert.equal(collected.metadata.no_side_effects,true);
 }
 assert.equal(inputCount(await history()),beforeInputs);
 assert.equal((await job(second)).started,false);
 pass('Queued B and resumed-before-observation A reject both input and collection before any peer input');
 const observed=await tool('first','application_observe',{jobId:first});assert.equal(observed.error,false,observed.result);
 const secondStart=enqueue('second','application_start',startArgs('second'));await delay(60);assert.equal((await job(second)).started,false);
 await downloads(['first.png']);const firstResult=await tool('first','application_collect',{jobId:first});assert.equal(firstResult.error,false,firstResult.result);
 assert.equal((await receipt('second',secondStart)).error,false);assert.equal((await job(second)).started,true);
 assert.equal((await job(second)).waitingFor.length,0);
 const old=await tool('second','application_collect',{jobId:second});assert.equal(old.error,true,old.result);
 await downloads(['first.png','second.png']);const secondResult=await tool('second','application_collect',{jobId:second});assert.equal(secondResult.error,false,secondResult.result);
 const secondJob=await job(second);assert.deepEqual(secondJob.files.map(f=>f.sourceName),['second.png']);
 await finish('first',firstResult);await finish('second',secondResult);
 const original=await fetch(app.origin+'/api/dimension/app-bridge/jobs/'+second+'/files/0');assert.equal(original.status,200);assert.deepEqual(Buffer.from(await original.arrayBuffer()),png);
 pass('A releases only after verified collection; B captures a fresh baseline and returns only its own subsequent download');
 await submit('draining');const draining=await start('draining');await submit('successor');
 await downloads(['first.png','second.png','late-predecessor.png']);
 await writeFile(path.join(peerFolder,'peer-block-download'),'block');enqueue('draining','application_collect',{jobId:draining});
 await until(()=>exists(path.join(peerFolder,'peer-download-entered')),'download callback entered');
 const successorStart=enqueue('successor','application_start',startArgs('successor'));const successor=(await findJob('successor')).id;
 await api('/api/dimension/app-bridge/jobs/'+draining+'/cancel',{});
 assert.equal((await job(draining)).status,'cancelled');assert.equal((await job(successor)).started,false);
 const beforeRelease=await history();assert.equal(beforeRelease.at(-1).op,'download_read');
 await writeFile(path.join(peerFolder,'peer-release-download'),'release');
 assert.equal((await receipt('successor',successorStart)).error,false);
 const drained=await job(draining);assert.equal(drained.status,'cancelled');assert.equal(drained.files.length,0);
 const afterRelease=await history(),releaseIndex=afterRelease.findLastIndex(e=>e.op==='download_released');
 assert(releaseIndex>=0&&afterRelease.slice(releaseIndex+1).some(e=>e.op==='observe'));
 const late=await tool('successor','application_collect',{jobId:successor});assert.equal(late.error,true,late.result);
 pass('HTTP cancellation retains occupancy through a draining download callback and suppresses late publication');
 await paused('successor',successor);await api('/api/dimension/app-bridge/jobs/'+successor+'/cancel',{});
 await unlink(path.join(peerFolder,'peer-block-download'));await unlink(path.join(peerFolder,'peer-release-download'));
 await app.stop();const notificationIdsBeforeRestart=allNotifications().map(n=>n.id);await startNativeFixture('ownership-restarted');
 const recovered=(await list()).jobs;
 assert.equal(recovered.find(j=>j.id===first).status,'completed');assert.equal(recovered.find(j=>j.id===second).status,'completed');
 assert.equal(recovered.find(j=>j.id===draining).status,'cancelled');assert.equal(recovered.find(j=>j.id===successor).status,'cancelled');
 assert.deepEqual(recovered.find(j=>j.id===second).files.map(f=>f.sourceName),['second.png']);
 pass('Restart preserves completed/cancelled job ownership outcomes and published source identities');
 const notices=allNotifications();assert.deepEqual(notices.map(n=>n.id),notificationIdsBeforeRestart,'Restart replayed persisted native stdout notifications');
 const resource=notices.find(n=>n.runId===runs.get('second')&&n.kind==='resource');assert(resource&&/旧任务占用/.test(resource.detail),'Missing queued-application resource notification');
 assert(allNotificationControls().some(n=>n.id==='application:'+second+':acquired'&&n.kind==='resolve-waiting'&&n.runId===runs.get('second')),'Resource acquisition did not resolve the queued notification');
 assert(notices.some(n=>n.runId===runs.get('first')&&n.kind==='takeover'),'Missing application_wait takeover notification');
 for(const tag of ['first','second'])assert(notices.some(n=>n.runId===runs.get(tag)&&n.kind==='completed'),'Missing completed notification for '+tag);
 assert(notices.every(n=>['completed','failed','resource','takeover'].includes(n.kind)),'Unexpected notification kind');
 assert(!notices.some(n=>/run_cancelled|任务已取消|已取消/.test(n.title+'\n'+n.detail)),'Native stdout contained a cancellation notification');
 for(const tag of ['draining','successor'])assert(!notices.some(n=>n.runId===runs.get(tag)&&['completed','failed'].includes(n.kind)),'Cancelled run emitted a terminal notification: '+tag);
 pass('Native stdout reports resource, takeover and completed events without cancellation or restart replay');
 assert.deepEqual(errors,[]);await app.stop();
 await writeFile(path.join(output,'result.json'),JSON.stringify({ok:true,checks,nativeSha256:hash(await readFile(executable)),peerSha256:hash(await readFile(peer)),calls,traces,peerHistory:await history(),processes:processes.map(p=>({pid:p.child.pid,exit:p.child.exitCode}))},null,2));
 console.log(JSON.stringify({passed:checks.length,output}));
}catch(error){await writeFile(path.join(output,'result.json'),JSON.stringify({ok:false,checks,error:error.stack,errors,calls,traces,peerHistory:peerFolder?await history():[]},null,2));throw error;}
finally{
 if(peerFolder)await writeFile(path.join(peerFolder,'peer-release-download'),'cleanup').catch(()=>{});
 for(const res of pending.values())res.destroy();pending.clear();
 if(app)await app.stop().catch(()=>{});for(const socket of sockets)socket.destroy();await new Promise(resolve=>model.close(resolve));
 for(const p of processes)await writeFile(path.join(output,p.label+'.log'),p.stdout+'\nSTDERR\n'+p.stderr);
}
