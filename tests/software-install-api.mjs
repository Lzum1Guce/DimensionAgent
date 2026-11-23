// Only the small Ubuntu hello fixture package is installed; if this test adds
// it, cleanup removes exactly that package and never autoremove dependencies.
import assert from 'node:assert/strict';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {startNative,until,parseOptions} from './archive-export-api.mjs';
const exec=promisify(execFile),options=parseOptions(),project=path.resolve(import.meta.dirname,'..');
const output=path.resolve(options.get('output')||path.join(project,'outputs/phase3-software/api',String(Date.now())));
assert.match(output,/^L:[\\/]/i);await mkdir(output,{recursive:true});
const executable=path.resolve(options.get('exe')||path.join(project,'outputs/build/DImensionagent-native.exe'));
const data=path.join(output,'data'),checks=[],processes=[],errors=[],calls=[];
const helper=path.join(project,'outputs/linux/dimension-desktop-helper-apps');
const wsl=async(...argv)=>exec('C:/Windows/System32/wsl.exe',['-d','dimension-sandbox','-u','root','--exec',...argv],{cwd:output,windowsHide:true,timeout:120000,maxBuffer:262144});
let app,cleanup=false,model;const pass=name=>{checks.push({name,ok:true});console.log('PASS '+name);};
const packageInstalled=async()=>{try{return(await wsl('/usr/bin/dpkg-query','-W','-f=${db:Status-Abbrev}','hello')).stdout.startsWith('ii ');}catch{return false;}};
const initialInstalled=await packageInstalled();
try{
 model=http.createServer(async(req,res)=>{
  try{
   assert.equal(req.url,'/v1/chat/completions');let bytes='';for await(const part of req)bytes+=part;const body=JSON.parse(bytes);
   const results=body.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));
   const previous=results.at(-1);let name,args;
   if(!previous){name='software_install';args={package:'hello',executable:'/usr/bin/hello',appId:'fixture-hello',name:'Linux安装验收程序'};}
   else{assert.equal(previous.error,false,previous.result);assert(previous.verification&&previous.artifacts.length===1);name='task_finish';args={summary:'Linux软件已安装并核验，可在公共区调用',artifacts:previous.artifacts,verification:previous.verification};}
   calls.push(name);res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{index:0,delta:{tool_calls:[{index:0,id:'software-fixture-'+calls.length,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n');
  }catch(e){errors.push(e.stack);res.writeHead(500);res.end('fixture failed');}
 });
 await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
 const start=async()=>app=await startNative({label:'software',executable,ui:path.join(project,'ui'),data,output,processes,
    extraArgs:['--desktop-helper',helper,'--sandbox-distro','dimension-sandbox','--desktop-home-root','/home/dimension']});
 await start();const api=(...args)=>app.api(...args);
 const before=await api('/api/dimension/work/software');assert(before.installerAvailable);assert(!before.apps.some(a=>a.id==='fixture-hello'));
 await api('/api/dimension/bots',{id:'software-fixture',name:'合成安装助手',mode:'work'});
 await api('/api/dimension/work/settings',{botId:'software-fixture',approvalMode:'ask'},'PATCH');
 await api('/api/providers',{name:'software-fixture',entry:{kind:'openai-chat-compat',baseUrl:'http://127.0.0.1:'+model.address().port+'/v1',spec:{model:'fixture-installer'},secret:{kind:'literal',value:'synthetic-only'}}});
 await api('/api/providers/software-fixture/activate',{});
 const run=(await api('/api/dimension/work/runs',{botId:'software-fixture',requestId:'software-install',text:'在Linux中安装hello测试软件，并核验程序'})).run;
 const pending=await until(async()=>{const data=await api('/api/dimension/work/pending?botId=software-fixture');return data.pending.find(p=>p.tool==='software_install');},'installation approval');
 assert.equal(await packageInstalled(),initialInstalled);pass('Installation waits for real user approval before changing Linux');
 cleanup=!initialInstalled;
 await api('/api/dimension/work/pending/'+pending.id+'/decision',{botId:'software-fixture',allow:true});
 const done=await until(async()=>{const item=await api('/api/dimension/work/runs/'+run.id);return item.terminal&&!item.executing?item:null;},'actual apt installation and verified finish',180000);
 assert.equal(done.status,'completed',JSON.stringify({error:done.error,answer:done.answer,errors}));
 assert.deepEqual(calls,['software_install','task_finish']);assert.equal((await wsl('/usr/bin/hello')).stdout.trim(),'Hello, world!');
 pass(initialInstalled?'Real installed software is validated and the task completes directly':'A real package is downloaded, installed, executed and the task completes directly');
 const after=await api('/api/dimension/work/software');assert(after.apps.some(a=>a.id==='fixture-hello'&&a.executable==='/usr/bin/hello'));
 assert.equal(after.installations.find(a=>a.appId==='fixture-hello').status,'installed');pass('Only verified executable is registered in the shared software catalog');
 const files=(await api('/api/dimension/work/tasks/'+run.id+'/artifacts')).files;assert.equal(files.length,1);
 const receipt=await api(files[0].url);assert(receipt.verified&&receipt.installed&&receipt.package==='hello');pass('Task result returns the actual installation verification record');
 await app.stop();await start();assert((await api('/api/dimension/work/software')).apps.some(a=>a.id==='fixture-hello'));pass('Restart preserves software registration and installation status');
 await app.stop();
 if(cleanup){await wsl('/usr/bin/apt-get','-y','-o','APT::Get::AutomaticRemove=false','remove','hello');cleanup=false;assert.equal(await packageInstalled(),false);pass('Only the newly installed fixture package is removed after testing');}
 await writeFile(path.join(output,'result.json'),JSON.stringify({ok:true,checks,calls,initialInstalled,nativeSha256:createHash('sha256').update(await readFile(executable)).digest('hex'),processes:processes.map(p=>({pid:p.child.pid,exit:p.child.exitCode}))},null,2));
}catch(error){await writeFile(path.join(output,'result.json'),JSON.stringify({ok:false,checks,calls,error:error.stack,errors,initialInstalled},null,2));throw error;}
finally{
 if(app)await app.stop().catch(()=>{});
 if(model)await new Promise(resolve=>model.close(resolve));
 if(cleanup&&await packageInstalled())await wsl('/usr/bin/apt-get','-y','-o','APT::Get::AutomaticRemove=false','remove','hello');
}
