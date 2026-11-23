import assert from 'node:assert/strict';
import { mkdir,mkdtemp,writeFile,readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
const project=path.resolve(import.meta.dirname,'..'),root=path.join(project,'outputs','plugin-adaptation');
await mkdir(root,{recursive:true});const out=await mkdtemp(path.join(root,'native-')),data=path.join(out,'data'),pkg=path.join(out,'upstream');
await mkdir(pkg);await writeFile(path.join(pkg,'package.json'),JSON.stringify({name:'fixture-original-echo',version:'2.3.4',license:'MIT',main:'index.js'}));
const license='MIT synthetic fixture\nCopyright 2026 fixture\n';await writeFile(path.join(pkg,'LICENSE'),license);await writeFile(path.join(pkg,'index.js'),'export const echo = text => text;\n');
const adapterServer="import {createInterface} from 'node:readline';\nconst send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');\nfor await(const line of createInterface({input:process.stdin})){\n const m=JSON.parse(line);if(m.id===undefined)continue;\n if(m.method==='initialize')send(m.id,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-adapter',version:'1.0.0'}});\n else if(m.method==='tools/list')send(m.id,{tools:[{name:'echo',description:'Ported synthetic upstream echo',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}]});\n else if(m.method==='tools/call')send(m.id,{content:[{type:'text',text:m.params.arguments.text}]});\n else process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unsupported'}})+'\\n');\n}";
const checks=[],modelObservations=[],modelFailures=[];let app,origin,stderr='',releaseHeld,heldReached=false,holdReleased=false;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,label,timeout=25000)=>{const end=Date.now()+timeout;while(Date.now()<end){const v=await fn();if(v)return v;await delay(50);}throw Error('Timeout '+label);};
const pass=name=>{checks.push(name);console.log('PASS '+name);};
const model=createServer(async(req,res)=>{
 try{
  let body='';for await(const c of req)body+=c;const request=JSON.parse(body);
  const latest=request.messages.filter(m=>m.role==='user').at(-1)?.content||'';
  const adapting=latest.includes('适配并安装插件'), held=latest.includes('hold-existing'), testing=latest.includes('test-installed-adapter');
  const names=request.tools?.map(x=>x.function.name)||[];
  modelObservations.push({kind:adapting?'adaptation':held?'existing':testing?'test':'ordinary',privileged:names.filter(x=>x.startsWith('plugin_adaptation_'))});
  if(held&&!holdReleased){heldReached=true;await new Promise(r=>releaseHeld=()=>{holdReleased=true;r();});}
  const done=new Map(request.messages.filter(m=>m.role==='tool').map(m=>[m.tool_call_id,JSON.parse(m.content)]));
  const calls=[];const call=(id,name,args)=>calls.push({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
  if(adapting){
   assert(names.includes('plugin_adaptation_inspect')&&names.includes('plugin_adaptation_install'));
   if(!done.has('source'))call('source','read_file',{scope:'project',path:'adapted/SOURCE.json'});
   else {
    const source=JSON.parse(done.get('source').result),name='dimension-adapter-'+source.name.replace(/[^a-z0-9._-]/g,'-').slice(0,140)+'-'+source.fingerprint.slice(0,8);
    if(!done.has('write-manifest')){
     call('write-manifest','write_file',{scope:'project',path:'adapted/package.json',content:JSON.stringify({name,version:source.version,license:source.license,type:'module',dsh:{bundle:{patch:'bundle.yml'}}})});
     call('write-bundle','write_file',{scope:'project',path:'adapted/bundle.yml',content:JSON.stringify([{insert:[{name:'@deepseek-ai/dsh-mcp-client',config:{serverName:'adaptation_fixture',transport:'stdio',command:'node',args:['server.mjs']}}]}])});
     call('write-server','write_file',{scope:'project',path:'adapted/server.mjs',content:adapterServer});
     call('write-report','write_file',{scope:'project',path:'adapted/ADAPTATION.json',content:JSON.stringify({status:'ready',sourceFingerprint:source.fingerprint,capabilities:[{name:'Echo',implementation:['server.mjs'],testEvidence:[]}],missingCapabilities:[],testingNotes:'This Work has not executed functionality. Installation receipt must remain limited.'})});
    }else if(!done.has('inspect'))call('inspect','plugin_adaptation_inspect',{});
    else if(!done.has('install')){
     const checked=done.get('inspect');assert.equal(checked.error,false,JSON.stringify(checked));
     call('install','plugin_adaptation_install',{planId:JSON.parse(checked.result).inspection.planId});
    }else {
     const receipt=done.get('install');assert.equal(receipt.error,false,JSON.stringify(receipt));assert.match(receipt.verification,/未验证原插件功能/);
     call('finish','task_finish',{summary:'适配包已安装且停用；此阶段未验证原功能。',artifacts:receipt.artifacts,verification:receipt.verification});
    }
   }
  }else{
   assert(!names.includes('plugin_adaptation_install'),'Ordinary tasks must not inherit install authority');
   const expected=testing?'actual adapter response':'existing work complete';
   if(testing&&!done.has('mcp'))call('mcp',names.find(x=>x.startsWith('mcp__adaptation_fixture__echo')),{text:expected});
   else if(!done.has('write')){if(testing)assert.equal(done.get('mcp').result,expected);call('write','write_file',{path:'result.txt',content:expected});}
   else if(!done.has('verify'))call('verify','verify_file',{path:'result.txt',expected});
   else{const proof=done.get('verify');call('finish','task_finish',{summary:testing?'Synthetic echo was actually called and its output verified.':'Existing task completed.',artifacts:proof.artifacts,verification:proof.verification});}
  }
  res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'',tool_calls:calls},finish_reason:'tool_calls'}]}));
 }catch(e){modelFailures.push(e.stack);res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Synthetic model assertion failed'}}));}
});
model.listen(0,'127.0.0.1');await once(model,'listening');
async function api(route,body,expected=200){const r=await fetch(origin+route,{method:body?'POST':'GET',headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const v=await r.json();assert.equal(r.status,expected,JSON.stringify(v));return v;}
const plugin=(action,args={},expected=200)=>api('/api/dimension/plugin-market',{action,...args},expected);
const terminal=id=>until(async()=>{const r=await api('/api/dimension/work/runs/'+id+'?view=1');return r.terminal&&!r.executing?r:null;},'terminal '+id,40000);
let success=false;
try{
 app=spawn(path.join(project,'outputs','build','DImensionagent-native.exe'),['--data',data,'--ui',path.join(project,'ui'),'--port','0','--node',process.execPath,'--plugin-host',path.join(project,'runtime','plugin-host.mjs')],{cwd:out,windowsHide:true,stdio:['pipe','pipe','pipe']});
 let stdout='';app.stdout.on('data',b=>stdout+=b);app.stderr.on('data',b=>stderr+=b);
 await until(()=>stdout.includes('\n'),'native ready');origin='http://127.0.0.1:'+JSON.parse(stdout.split('\n')[0]).port;
 await api('/api/dimension/bots',{id:'adapter-bot',name:'Synthetic adapter Bot',mode:'work'});
 await api('/api/dimension/bots',{id:'other-bot',name:'Synthetic other Bot',mode:'work'});
 await api('/api/providers',{name:'fixture',entry:{kind:'openai-chat-compat',baseUrl:'http://127.0.0.1:'+model.address().port+'/v1',spec:{model:'fixture'}},secretValue:'synthetic-only'});
 assert((await plugin('adaptation.bots')).bots.some(x=>x.id==='adapter-bot'));
 const inspection=(await plugin('package.inspect',{path:pkg})).inspection;
 const held=(await api('/api/dimension/work/runs',{botId:'adapter-bot',text:'hold-existing',requestId:'hold'})).run;
 await until(()=>heldReached,'existing model held');
 await plugin('adaptation.prepare',{adaptationId:'adapt-'+'0'.repeat(32)},403);
 await plugin('adaptation.install',{},403);
 await plugin('adaptation.start',{planId:inspection.planId,botId:'adapter-bot',requestId:'extra',path:out},400);
 const selected={planId:inspection.planId,botId:'adapter-bot',requestId:'adapt-click'};
 const started=await plugin('adaptation.start',selected);
 assert.notEqual(started.run.id,held.id);assert.equal(started.run.status,'queued');
 const duplicate=await plugin('adaptation.start',selected);
 assert.equal(duplicate.run.id,started.run.id);assert.equal(duplicate.duplicate,true);
 const still=await api('/api/dimension/work/runs/'+held.id+'?view=1');
 assert.equal(still.status,'running');assert.equal(still.inputCount,1);
 const pending=await api('/api/dimension/work/runs/'+started.run.id+'?view=1');
 assert.equal(pending.workspace.project,started.adaptation.workspace);
 assert.equal(await readFile(path.join(pending.workspace.project,'original','LICENSE'),'utf8'),license);
 pass('Selected Bot receives a separate queued Work task with exact source materials; retries do not duplicate or steer existing work');
 releaseHeld();assert.equal((await terminal(held.id)).status,'completed');
 const finished=await terminal(started.run.id);assert.equal(finished.status,'completed',finished.error);
 const records=finished.events.filter(e=>e.kind==='tool'&&e.tool?.status==='completed');
 assert(records.some(e=>e.tool.name==='plugin_adaptation_inspect'));assert(records.some(e=>e.tool.name==='plugin_adaptation_install'));
 const installed=(await plugin('plugin.list')).plugins;assert.equal(installed.length,1);assert.equal(installed[0].enabled,false);
 assert.equal(installed[0].adaptation.functionalVerification,'not-verified');
 assert.equal((await plugin('tools.list')).tools.length,0);
 assert.match(finished.answer,/未验证原功能/);
 pass('Bound Work actually writes an adapter, checks and installs it disabled with a narrow installation receipt');
 await plugin('adaptation.install',{adaptationId:started.adaptation.id,botId:'other-bot',runId:started.run.id},403);
 assert(modelObservations.filter(x=>x.kind==='existing').every(x=>!x.privileged.length));
 pass('Internal adaptation endpoints are blocked at HTTP and ordinary Work does not receive installation tools');
 // Explicit activation is synthetic test authorization, after asserting the default-disabled result.
 const permissions=await fetch(origin+'/api/dimension/work/settings',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({botId:'other-bot',approvalMode:'full'})});
 assert.equal(permissions.status,200,await permissions.text());
 await plugin('plugin.enable',{pluginId:installed[0].id});
 const testRun=(await api('/api/dimension/work/runs',{botId:'other-bot',text:'test-installed-adapter',requestId:'actual-test'})).run;
 const tested=await terminal(testRun.id);assert.equal(tested.status,'completed',tested.error);
 const artifact=(await api('/api/dimension/work/tasks/'+tested.id+'/artifacts')).files.find(f=>f.name==='result.txt')||(await api('/api/dimension/work/tasks/'+tested.id+'/artifacts')).files[0];
 assert.equal(await(await fetch(origin+artifact.url)).text(),'actual adapter response');
 await plugin('plugin.disable',{pluginId:installed[0].id});
 pass('An explicit later synthetic activation really calls the adapted MCP capability and verifies its output');
 assert.deepEqual(modelFailures,[]);success=true;
}finally{
 releaseHeld?.();
 if(app&&app.exitCode===null){app.stdin.end('shutdown\n');await Promise.race([once(app,'exit'),delay(5000)]);if(app.exitCode===null)app.kill();}
 await new Promise(r=>model.close(r));
 await writeFile(path.join(out,'result.json'),JSON.stringify({success,checks,modelObservations,modelFailures,stderr,nativeExitCode:app?.exitCode,scope:'Synthetic isolated native data and local model only. No production account or market access.'},null,2));
 console.log(JSON.stringify({success,checks:checks.length,output:out}));
}

