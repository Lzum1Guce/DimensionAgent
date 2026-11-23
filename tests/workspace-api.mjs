import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {existsSync} from 'node:fs';
import {mkdir,readFile,writeFile,link,symlink,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {startNative,until,parseOptions} from './archive-export-api.mjs';
const options=parseOptions(), project=path.resolve(import.meta.dirname,'..');
const output=path.resolve(options.get('output')||path.join(project,'outputs/phase3-workspaces',String(Date.now())));
assert.match(output,/^L:[\\/]/i);await mkdir(output,{recursive:true});
const fallbackExe=existsSync(path.join(project,'build/DImensionagent-native.exe'))?path.join(project,'build/DImensionagent-native.exe'):path.join(project,'outputs/build/DImensionagent-native.exe');
const executable=path.resolve(options.get('exe')||fallbackExe);
const data=path.join(output,'data'),first=path.join(output,'项目甲'),second=path.join(output,'项目乙');
const checks=[],processes=[],errors=[],calls=[];let app,serial=0,release,hold=true;
const content='用户新上传的测试要求。\n',resultPath='generated/result.txt';let incoming;
const model=http.createServer(async(req,res)=>{
 try{
  assert.equal(req.url,'/v1/chat/completions');let bytes='';for await(const part of req)bytes+=part;
  const body=JSON.parse(bytes);
  if(!body.tools?.length){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{index:0,message:{content:'ok'},finish_reason:'stop'}]}));return;}
  if(hold)await new Promise(resolve=>release=resolve);
  const resumed=body.messages.some(m=>m.role==='user'&&String(m.content).includes('RESUMED'));
  const next=body.messages.some(m=>m.role==='user'&&String(m.content).includes('SECOND'));
  const answer=resumed?'continued at original project':next?'created at second project':'created at first project';
  const mapping=new Map();for(const m of body.messages)for(const c of m.tool_calls||[])mapping.set(c.id,c.function.name);
  const results=body.messages.filter(m=>m.role==='tool').map(m=>({name:mapping.get(m.tool_call_id),value:JSON.parse(m.content)}));
  const good=results.filter(x=>!x.value.error),verified=good.findLast(x=>x.name==='verify_file'&&x.value.verification&&x.value.result.includes(resultPath));
  let tool,args;
  const expectedScope=next?second:first;
  assert(body.messages.some(m=>m.role==='system'&&String(m.content).includes(expectedScope)),'System prompt binds the actual selected project');
  if(!next&&!good.some(x=>x.name==='read_file')){tool='read_file';args={scope:'project',path:incoming};}
  else if(!good.some(x=>x.name==='write_file'&&x.value.metadata?.workspaceFixture===answer)&&
          !body.messages.some(m=>(m.tool_calls||[]).some(c=>c.function.name==='write_file'&&JSON.parse(c.function.arguments).content===answer))){
   if(!next)assert.equal(good.find(x=>x.name==='read_file').value.result,content);
   tool='write_file';args={scope:'project',path:resultPath,content:answer};
  }else if(!body.messages.some(m=>(m.tool_calls||[]).some(c=>c.function.name==='verify_file'&&JSON.parse(c.function.arguments).expected===answer))){tool='verify_file';args={scope:'project',path:resultPath,expected:answer};}
  else{assert(verified);tool='task_finish';args={summary:answer,artifacts:verified.value.artifacts,verification:verified.value.verification};}
  calls.push({tool,args});const id='workspace-call-'+(++serial);
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.end('data: '+JSON.stringify({choices:[{index:0,delta:{tool_calls:[{index:0,id,type:'function',function:{name:tool,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n');
 }catch(error){errors.push(error.stack);res.writeHead(500);res.end('fixture failed');}
});
await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
const pass=name=>{checks.push({name,ok:true});console.log('PASS '+name);};
const start=async()=>app=await startNative({label:'workspace',executable,ui:path.join(project,'ui'),data,output,processes});
const api=(...args)=>app.api(...args);
const complete=async id=>until(async()=>{const r=await api('/api/dimension/work/runs/'+id);return r.terminal&&!r.executing?r:null;},'workspace run completion');
try{
 await start();
 await api('/api/dimension/bots',{id:'workspace-one',name:'合成工作区助手',mode:'work'});
 await api('/api/dimension/bots',{id:'workspace-two',name:'合成独立助手',mode:'work'});
 const a=await api('/api/dimension/work/settings?botId=workspace-one'),b=await api('/api/dimension/work/settings?botId=workspace-two');
 assert(a.settings.projectCwd&&b.settings.projectCwd);assert.notEqual(a.settings.projectCwd,b.settings.projectCwd);pass('Each Bot automatically receives its own project folder');
 await api('/api/dimension/work/pick-cwd',{botId:'workspace-one',path:first});
 assert.equal((await api('/api/dimension/work/pick-cwd',{botId:'workspace-one',path:null})).cancelled,true);
 assert.equal((await api('/api/dimension/work/settings?botId=workspace-one')).settings.projectCwd,first);pass('Selecting a project works and cancellation preserves it');
 await api('/api/dimension/work/settings',{botId:'workspace-one',approvalMode:'full'},'PATCH');
 incoming=(await api('/api/dimension/work/attachments',{botId:'workspace-one',name:'需求.txt',content})).path;
 assert((await api('/api/dimension/work/tools',{botId:'workspace-one',tool:'write',path:incoming,content,requestId:'new-attachment'})).ok);
 await api('/api/dimension/work/settings',{botId:'workspace-one',approvalMode:'auto',cliEngine:'builtin'},'PATCH');
 const sentinel=path.join(output,'external-sentinel.txt'),sentinelText='Synthetic external sentinel must stay unchanged';
 await writeFile(sentinel,sentinelText);await mkdir(path.join(first,'generated'),{recursive:true});await mkdir(path.join(second,'generated'),{recursive:true});
 await link(sentinel,path.join(first,resultPath+'.pending'));
 let hasSymlink=false;
 try{await symlink(sentinel,path.join(second,resultPath+'.pending'),'file');hasSymlink=true;}
 catch(err){if(err.code!=='EPERM')throw err;}
 await api('/api/providers',{name:'workspace-fixture',entry:{kind:'openai-chat-compat',baseUrl:'http://127.0.0.1:'+model.address().port+'/v1',spec:{model:'workspace-model'},secret:{kind:'literal',value:'synthetic-only'}}});
 await api('/api/providers/workspace-fixture/activate',{});
 const submitted=await api('/api/dimension/work/runs',{botId:'workspace-one',requestId:'workspace-first',text:'FIRST 使用新附件并在项目中输出文件'}),id=submitted.run.id;
 await until(()=>release,'model fixture begins');
 await api('/api/dimension/work/pick-cwd',{botId:'workspace-one',path:second},'POST',409);
 hold=false;release();assert.equal((await complete(id)).status,'completed');
 assert.equal(await readFile(path.join(first,resultPath),'utf8'),'created at first project');pass('New attachment is read by the model; verified project output is written, and active root changes reject');
 assert.equal(await readFile(sentinel,'utf8'),sentinelText);assert.equal((await lstat(path.join(first,resultPath+'.pending'))).nlink,2);
 pass('Automatic project writes leave pre-existing pending hardlinks and external sentinels untouched');
 const files=(await api('/api/dimension/work/tasks/'+id+'/artifacts')).files;assert.equal(files.length,1);assert(files[0].url.includes('scope=project'));
 assert.equal((await app.response(files[0].url)).text,'created at first project');
 const base=files[0].url.slice(0,files[0].url.indexOf('/files/')+7);
 const hidden=base+incoming.split('/').map(encodeURIComponent).join('/')+'?scope=project';assert.notEqual(hidden,files[0].url);
 assert.equal((await app.response(hidden)).status,404);pass('Project artifacts are readable but arbitrary uploaded project files are not exposed as results');
 await api('/api/dimension/work/pick-cwd',{botId:'workspace-one',path:second});
 await api('/api/dimension/work/runs/'+id+'/resume',{requestId:'resume-original',text:'RESUMED 继续原任务'});
 assert.equal((await complete(id)).status,'completed');assert.equal(await readFile(path.join(first,resultPath),'utf8'),'continued at original project');
 assert.equal((await api('/api/dimension/work/runs/'+id)).workspace.project,first);pass('Resuming an old task retains its original project after preference changes');
 const newer=await api('/api/dimension/work/runs',{botId:'workspace-one',requestId:'new-second',text:'SECOND 写入新的项目'});
 assert.equal((await complete(newer.run.id)).status,'completed');assert.equal(await readFile(path.join(second,resultPath),'utf8'),'created at second project');pass('A new task adopts the new project folder');
 assert.equal(await readFile(sentinel,'utf8'),sentinelText);if(hasSymlink)assert((await lstat(path.join(second,resultPath+'.pending'))).isSymbolicLink());
 pass('Automatic project writes leave pre-existing pending symlinks and external sentinels untouched');
 await app.stop();await start();assert.equal((await api('/api/dimension/work/runs/'+id)).workspace.project,first);
 assert.equal((await app.response(files[0].url)).text,'continued at original project');pass('Restart preserves task bindings and original result URLs');
 assert.deepEqual(errors,[]);await app.stop();
 await writeFile(path.join(output,'result.json'),JSON.stringify({ok:true,checks,calls,nativeSha256:createHash('sha256').update(await readFile(executable)).digest('hex'),processes:processes.map(p=>({pid:p.child.pid,exit:p.child.exitCode}))},null,2));
}catch(error){await writeFile(path.join(output,'result.json'),JSON.stringify({ok:false,checks,error:error.stack,errors,calls},null,2));throw error;}
finally{if(release)release();if(app)await app.stop().catch(()=>{});await new Promise(resolve=>model.close(resolve));}
