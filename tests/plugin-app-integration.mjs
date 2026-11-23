import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile, readFile, access} from 'node:fs/promises';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'), out=path.join(root,'outputs','phase3-plugin-app');
await mkdir(out,{recursive:true}); const dir=await mkdtemp(path.join(out,'fixture-'));
const pkg=path.join(dir,'package'), data=path.join(dir,'data'), pidsFile=path.join(dir,'mcp-pids.jsonl');
const skillBody='---\nname: fixture-instructions\ndescription: Synthetic skill for the compatibility test.\n---\nReturn SKILL_FIXTURE_COMPLETE.\n';
await mkdir(pkg,{recursive:true});
await writeFile(path.join(pkg,'package.json'),JSON.stringify({name:'dimension-fixture-mcp',version:'1.0.0',license:'MIT',type:'module',dsh:{bundle:{patch:'./cordis.patch.yml'}}}));
const serverFile=path.join(pkg,'server.mjs');
await writeFile(serverFile, `import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
appendFileSync(process.argv[2],JSON.stringify({pid:process.pid,event:'start',workspace:process.env.DIMENSION_WORKSPACE||''})+'\\n');
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
const lines=createInterface({input:process.stdin});
lines.on('line',async line=>{const q=JSON.parse(line);if(q.id===undefined)return;
if(q.method==='initialize')send(q.id,{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1.0.0'}});
else if(q.method==='tools/list')send(q.id,{tools:['echo',...Array.from({length:Number(process.argv[3]||0)},(_,i)=>'extra_'+i)].map(name=>({name,description:'Synthetic echo only',inputSchema:{type:'object',properties:{text:{type:'string'},delay:{type:'integer'}},required:['text']}}))});
else if(q.method==='tools/call'){if(q.params.arguments.delay)await new Promise(r=>setTimeout(r,q.params.arguments.delay));send(q.id,{content:[{type:'text',text:'fixture echo: '+q.params.arguments.text}]});}
else send(q.id,{});});
lines.on('close',()=>process.exit(0));
`);
await writeFile(path.join(pkg,'cordis.patch.yml'),'- insert:\n    - id: fixture\n      name: "@deepseek-ai/dsh-mcp-client"\n      config:\n        serverName: fixture\n        transport: stdio\n        command: '+JSON.stringify(process.execPath)+'\n        args: '+JSON.stringify(['server.mjs',pidsFile])+'\n');
const modelRecords=[],checks=[];let app,origin,stderr='',success=false,releaseIndex;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f,label,ms=18000){const end=Date.now()+ms;while(Date.now()<end){const value=await f();if(value)return value;await sleep(30);}throw Error('Timeout: '+label);}
const model=createServer(async(req,res)=>{
 try {
  if(req.url==='/held-index'){releaseIndex=()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({format:1,title:'Synthetic held index',plugins:[]}));};return;}
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw);modelRecords.push(body);
  const messages=body.messages,latest=[...messages].reverse().find(m=>m.role==='user')?.content||'';
  const done=messages.filter(m=>m.role==='tool').map(m=>({id:m.tool_call_id,value:JSON.parse(m.content)}));
  const names=(body.tools||[]).map(t=>t.function.name), mcp=names.find(n=>n.startsWith('mcp__'));
  assert(names.length<=65,'Model catalog exceeded the native run limit');
  const isSkill=latest.includes('skill-suite'), isBroad=latest.includes('broad-plugin'), resultPath=isSkill?'skill-result.txt':'plugin-result.txt', expected=isSkill?skillBody:'fixture echo: native bridge';
  let call;
  if(isBroad&&!done.length){assert(names.includes('delegate_work'));assert(names.includes('call_plugin_tool'));call={id:'catalog',name:'list_plugin_tools',arguments:JSON.stringify({query:'extra_79',limit:1})};}
  else if(isBroad&&!done.some(t=>t.id==='plugin')){const found=JSON.parse(done.find(t=>t.id==='catalog').value.result);assert.equal(found.tools.length,1);assert.equal(found.tools[0].rawName,'extra_79');call={id:'plugin',name:'call_plugin_tool',arguments:JSON.stringify({name:found.tools[0].name,args:{text:'native bridge'}})};}
  else if(isSkill&&!done.length){assert(names.includes('list_skills'));call={id:'skill-list',name:'list_skills',arguments:'{}'};}
  else if(isSkill&&!done.some(t=>t.id==='skill-read')){const selected=JSON.parse(done.find(t=>t.id==='skill-list').value.result).skills.find(s=>s.name==='fixture-instructions');assert(selected);call={id:'skill-read',name:'read_skill',arguments:JSON.stringify({pluginId:selected.pluginId,skillId:selected.skillId})};}
  else if(!done.length)call={id:'plugin',name:mcp,arguments:JSON.stringify({text:'native bridge',...(latest.includes('slow-plugin')?{delay:10000}:{})})};
  else if(!done.some(t=>t.id==='write')){const response=done.find(t=>t.id===(isSkill?'skill-read':'plugin')).value;assert.equal(response.error,false);const actual=isSkill?JSON.parse(response.result).body:response.result;assert.equal(actual,expected);call={id:'write',name:'write_file',arguments:JSON.stringify({path:resultPath,content:actual})};}
  else if(!done.some(t=>t.id==='verify'))call={id:'verify',name:'verify_file',arguments:JSON.stringify({path:resultPath,expected})};
  else {const proof=done.find(t=>t.id==='verify').value;call={id:'finish',name:'task_finish',arguments:JSON.stringify({summary:'Verified plugin result.',artifacts:proof.artifacts,verification:proof.verification})};}
  if(!call.name)throw Error('Enabled MCP tool missing from model request');
  res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'',tool_calls:[{type:'function',id:call.id,function:{name:call.name,arguments:call.arguments}}]},finish_reason:'tool_calls'}]}));
 }catch(e){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:e.message}}));}
});
await new Promise(r=>model.listen(0,'127.0.0.1',r));
async function api(url,body,method=body?'POST':'GET'){const res=await fetch(origin+url,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await res.json();assert(res.ok,JSON.stringify(value));return value;}
const plugin=(action,args={})=>api('/api/dimension/plugin-market',{action,...args});
async function terminal(id){return until(async()=>{const r=await api('/api/dimension/work/runs/'+id);return ['completed','failed','cancelled','interrupted'].includes(r.status)?r:null;},'task terminal');}
try{
 app=spawn(path.join(root,'outputs','build','DImensionagent-native.exe'),['--data',data,'--ui',path.join(root,'ui'),'--port','0','--node',process.execPath,'--plugin-host',path.join(root,'runtime','plugin-host.mjs')],{cwd:dir,windowsHide:true,stdio:['pipe','pipe','pipe']});
 app.stderr.on('data',b=>stderr+=b);let stdout='';app.stdout.on('data',b=>stdout+=b);
 await until(()=>stdout.includes('\n'),'native ready');origin='http://127.0.0.1:'+JSON.parse(stdout.split('\n')[0]).port;
 assert.equal((await api('/api/dimension/plugin-market')).available,true);
 const status=await plugin('status');assert.equal((status.plugins||[]).length,0);
 const inspection=(await plugin('package.inspect',{path:pkg})).inspection;
 assert.equal(inspection.classification.supported,true);
 const installed=(await plugin('package.install',{planId:inspection.planId})).plugin;
 const pluginId=installed.id||installed.pluginId;assert(pluginId);
 assert.equal(installed.enabled,false);
 assert.equal(await access(pidsFile).then(()=>true,()=>false),false,'Inspection and installation must not start MCP');
 checks.push('Native API inspects and installs an immutable synthetic MCP bundle without executing it');
 await plugin('plugin.enable',{pluginId});
 const tools=(await plugin('tools.list')).tools;assert.equal(tools.length,1);assert.match(tools[0].name,/^mcp__/);
 checks.push('Explicit enable starts discovery and publishes a stable namespaced model tool');
 const adding=plugin('source.add',{url:'http://127.0.0.1:'+model.address().port+'/held-index'});
 try{await until(()=>releaseIndex,'index request reached fixture');const cached=await Promise.race([plugin('tools.list'),sleep(2500).then(()=>{throw Error('Work catalog read waited for network-bound management');})]);assert.equal(cached.tools.length,1);}
 finally{releaseIndex?.();const added=await adding;await plugin('source.remove',{sourceId:added.source.id});}
 checks.push('Work catalog reads remain responsive while an independent market request waits on the network');
 await api('/api/dimension/bots',{id:'plugin-helper',name:'合成插件测试助手',mode:'work'});
 await api('/api/dimension/work/settings',{botId:'plugin-helper',approvalMode:'full'},'PATCH');
 await api('/api/providers',{name:'fixture',entry:{kind:'openai-chat-compat',baseUrl:'http://127.0.0.1:'+model.address().port+'/v1',spec:{model:'fixture-flash'}},secretValue:'synthetic-fixture-key'});
 const submitted=await api('/api/dimension/work/runs',{botId:'plugin-helper',text:'Call the synthetic plugin and verify a written result.',requestId:'plugin-complete'});
 const run=await terminal(submitted.run.id);assert.equal(run.status,'completed',run.error);
 assert(run.events.some(e=>e.kind==='tool'&&e.tool?.name.startsWith('mcp__')&&e.tool.status==='completed'));
 const files=(await api('/api/dimension/work/tasks/'+run.id+'/artifacts')).files;assert.equal(files.length,1);
 assert.equal(await (await fetch(origin+files[0].url)).text(),'fixture echo: native bridge');
 const starts=(await readFile(pidsFile,'utf8')).trim().split('\n').map(JSON.parse);
 assert(starts.some(s=>s.workspace===path.join(data,'workspaces',run.id)),'The trusted task workspace must reach the MCP process');
 checks.push('C++ task → hidden compatibility worker → MCP → file verification returns an actual artifact');
 const slow=await api('/api/dimension/work/runs',{botId:'plugin-helper',text:'slow-plugin',requestId:'plugin-cancel'});
 await until(async()=>{const r=await api('/api/dimension/work/runs/'+slow.run.id);return r.events.some(e=>e.kind==='tool'&&e.tool?.name.startsWith('mcp__')&&e.tool.status==='running');},'MCP executing');
 const cancelledAt=Date.now();await api('/api/dimension/work/runs/'+slow.run.id+'/cancel',{});assert.equal((await terminal(slow.run.id)).status,'cancelled');
 assert(Date.now()-cancelledAt<2500);
 checks.push('Stopping Work interrupts the compatibility worker and its MCP process');
 await plugin('plugin.disable',{pluginId});assert.equal((await plugin('tools.list')).tools.length,0);
 await plugin('plugin.remove',{pluginId});assert.equal((await plugin('plugin.list')).plugins.length,0);
 checks.push('Disable removes tool exposure; uninstall removes only the installed synthetic package');
 const skillDir=path.join(dir,'pure-skill');await mkdir(skillDir);await writeFile(path.join(skillDir,'SKILL.md'),skillBody);
 const skillInstalled=(await plugin('package.install',{path:skillDir})).plugin;
 assert.equal(skillInstalled.enabled,false);await plugin('plugin.enable',{pluginId:skillInstalled.id});
 assert.equal((await plugin('tools.list')).tools.length,0);
 const skillRun=await api('/api/dimension/work/runs',{botId:'plugin-helper',text:'skill-suite: read the synthetic skill and verify its body as the result.',requestId:'skill-complete'});
 const skillCompleted=await terminal(skillRun.run.id);assert.equal(skillCompleted.status,'completed',skillCompleted.error);
 const skillFiles=(await api('/api/dimension/work/tasks/'+skillCompleted.id+'/artifacts')).files;assert.equal(skillFiles.length,1);
 assert.equal(await (await fetch(origin+skillFiles[0].url)).text(),skillBody);
 await plugin('plugin.remove',{pluginId:skillInstalled.id});assert.equal((await plugin('skill.list')).skills.length,0);
 checks.push('A pure Skill package becomes discoverable and readable inside Work without an MCP server');
 const broadDir=path.join(dir,'broad-package');await mkdir(broadDir);
 const broadManifest=JSON.parse(await readFile(path.join(pkg,'package.json'),'utf8'));broadManifest.name='dimension-fixture-broad';
 await writeFile(path.join(broadDir,'package.json'),JSON.stringify(broadManifest));
 await writeFile(path.join(broadDir,'server.mjs'),await readFile(serverFile));
 await writeFile(path.join(broadDir,'cordis.patch.yml'),(await readFile(path.join(pkg,'cordis.patch.yml'),'utf8')).replace('serverName: fixture','serverName: broad').replace(JSON.stringify(['server.mjs',pidsFile]),JSON.stringify(['server.mjs',pidsFile,'80'])));
 const broad=(await plugin('package.install',{path:broadDir})).plugin;await plugin('plugin.enable',{pluginId:broad.id});
 assert.equal((await plugin('tools.list')).tools.length,81);
 const broadGroup=(await api('/api/dimension/groups',{name:'Synthetic tool catalog group',ownerId:'plugin-helper',members:['plugin-helper']})).group.id;
 const broadRun=await api('/api/dimension/work/runs',{botId:'plugin-helper',groupId:broadGroup,text:'broad-plugin: find and call extra_79; verify the actual result.',requestId:'broad-complete'});
 const broadCompleted=await terminal(broadRun.run.id);assert.equal(broadCompleted.status,'completed',broadCompleted.error);
 assert(broadCompleted.events.some(e=>e.kind==='tool'&&e.tool?.name==='call_plugin_tool'&&e.tool.status==='completed'));
 const broadFiles=(await api('/api/dimension/work/tasks/'+broadCompleted.id+'/artifacts')).files;
 assert.equal(await (await fetch(origin+broadFiles[0].url)).text(),'fixture echo: native bridge');
 await plugin('plugin.remove',{pluginId:broad.id});
 checks.push('An 81-tool package stays fully reachable through paged discovery without breaking group Work or its delegation tool');
 success=true;
}finally{
 if(app&&app.exitCode===null){app.stdin.end('shutdown\n');await Promise.race([new Promise(r=>app.once('exit',r)),sleep(5000)]);if(app.exitCode===null)app.kill();}
 model.closeAllConnections();await new Promise(r=>model.close(r));await sleep(100);
 let pids=[];try{pids=(await readFile(pidsFile,'utf8')).trim().split('\n').map(s=>JSON.parse(s).pid);}catch{}
 const remaining=pids.filter(pid=>{try{process.kill(pid,0);return true;}catch{return false;}});
 const report={passed:success&&remaining.length===0,checks,remainingMcpProcesses:remaining,modelRequests:modelRecords.length,fixtureDirectory:dir,realPluginsImported:false,productionDataUsed:false,stderr};
 await writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 assert.equal(remaining.length,0,'MCP processes survived shutdown');
}
