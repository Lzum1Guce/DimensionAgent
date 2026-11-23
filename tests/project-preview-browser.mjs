import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {startNative,until,parseOptions} from './archive-export-api.mjs';
import {startBrowser} from './native-browser-fixture.mjs';
const options=parseOptions(),project=path.resolve(import.meta.dirname,'..');
const output=path.resolve(options.get('output')||path.join(project,'outputs/project-preview',String(Date.now())));
await mkdir(output,{recursive:true});
const executable=path.resolve(options.get('exe')||path.join(project,'outputs/build/DImensionagent-native.exe'));
const checks=[],processes=[],errors=[],calls=[];let app,browser,sequence=0;
const pass=name=>{checks.push({name,ok:true});console.log('PASS '+name);};
const model=http.createServer(async(req,res)=>{
 try{
  let bytes='';for await(const part of req)bytes+=part;const body=JSON.parse(bytes);
  const previous=body.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content)).at(-1);
  let name,args;
  if(!previous){
   name='sandbox_exec';
   const files={
    'index.html':'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="style.css"><h1 id="result">Building preview</h1><button id="counter">0</button><script type="module" src="main.js"></script>',
    'style.css':'h1{color:rgb(17,34,51)}body{font-family:sans-serif;background:#faf9f7;padding:32px}',
    'module.js':'export const value = "actual-module";',
    'data.json':JSON.stringify({value:'actual-data'}),
    'main.js':`import {value} from './module.js';
     const data=await fetch('./data.json').then(r=>r.json());
     let parentBlocked=false,apiBlocked=false;
     try{void parent.document.title;}catch{parentBlocked=true;}
     try{await fetch(${JSON.stringify(app.origin+'/api/status')});}catch{apiBlocked=true;}
     document.querySelector('#result').textContent=value+' '+data.value;
     let n=0;document.querySelector('#counter').onclick=()=>{document.querySelector('#counter').textContent=++n;parent.postMessage({fixture:'dimension-preview-counter',n},'*');};
     parent.postMessage({fixture:'dimension-preview',value,data:data.value,parentBlocked,apiBlocked,color:getComputedStyle(document.querySelector('#result')).color},'*');`
   };
   const script="const fs=require('fs');fs.mkdirSync('dist',{recursive:true});for(const [name,body] of Object.entries("+JSON.stringify(files)+"))fs.writeFileSync('dist/'+name,body);console.log('Built actual isolated preview');";
   args={argv:['/usr/bin/node','-e',script],cwd:'.',timeoutSeconds:30,outputs:['dist/index.html']};
  }else{
   assert.equal(previous.error,false,previous.result);assert(previous.artifacts.length===2);assert(previous.verification.includes('SHA256'));
   const actual=JSON.parse(previous.result);assert(actual.ok);assert(actual.stdout.includes('Built actual isolated preview'));
   name='task_finish';args={summary:'项目已实际构建，可以交互预览。',artifacts:previous.artifacts,verification:previous.verification};
  }
  calls.push(name);res.writeHead(200,{'content-type':'text/event-stream'});
  res.end('data: '+JSON.stringify({choices:[{index:0,delta:{tool_calls:[{index:0,id:'preview-'+(++sequence),type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n');
 }catch(error){errors.push(error.stack);res.writeHead(500);res.end('fixture failed');}
});
await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
try{
 app=await startNative({label:'preview',executable,ui:path.join(project,'ui'),data:path.join(output,'data'),output,processes,
  extraArgs:['--desktop-helper',path.join(project,'outputs/linux/dimension-desktop-helper-apps'),'--sandbox-distro','dimension-sandbox','--desktop-home-root','/home/dimension']});
 const api=(...args)=>app.api(...args);
 await api('/api/dimension/bots',{id:'preview-builder',name:'项目预览测试助手',mode:'work'});
 await api('/api/dimension/work/settings',{botId:'preview-builder',approvalMode:'ask',networkAccess:false},'PATCH');
 await api('/api/providers',{name:'preview-fixture',entry:{kind:'openai-chat-compat',baseUrl:'http://127.0.0.1:'+model.address().port+'/v1',spec:{model:'fixture-builder'},secret:{kind:'literal',value:'synthetic-only'}}});
 await api('/api/providers/preview-fixture/activate',{});
 const run=(await api('/api/dimension/work/runs',{botId:'preview-builder',requestId:'preview-build',text:'构建一个可交互的HTML项目，验证后返还预览'})).run;
 const pending=await until(async()=>(await api('/api/dimension/work/pending?botId=preview-builder')).pending.find(p=>p.tool==='sandbox_exec'),'build approval');
 assert.equal(calls.length,1);await api('/api/dimension/work/pending/'+pending.id+'/decision',{botId:'preview-builder',allow:true});
 const completed=await until(async()=>{const r=await api('/api/dimension/work/runs/'+run.id);return r.terminal&&!r.executing?r:null;},'real Linux build');
 assert.equal(completed.status,'completed',JSON.stringify({completed,errors}));assert.deepEqual(calls,['sandbox_exec','task_finish']);
 const files=(await api('/api/dimension/work/tasks/'+run.id+'/artifacts')).files;
 const html=files.find(f=>f.extension==='.html'),receipt=files.find(f=>f.extension==='.json');assert(html?.previewUrl&&receipt);
 assert.notEqual(new URL(html.previewUrl).origin,app.origin);const record=await api(receipt.url);assert(record.ok&&record.ephemeralHome&&!record.networkAccess);
 pass('Work approval executes a real Linux Node build and finishes from real artifact checksums and receipt');
 const artifact=await app.response(html.url);assert.equal(artifact.status,200);assert(artifact.headers['content-security-policy'].includes("script-src 'none'"));
 const raw=await fetch(html.previewUrl,{headers:{origin:'null','sec-fetch-site':'cross-site'}});assert.equal(raw.status,200);
 assert(raw.headers.get('content-security-policy').includes('sandbox allow-scripts'));assert.equal((await fetch(html.previewUrl,{method:'POST'})).status,403);
 pass('Interactive preview has its own loopback origin; original download stays inert and preview cannot mutate');
 browser=await startBrowser({output,processes},app.origin);
 const {evaluate,click,cdp}=browser;
 await until(()=>evaluate('!!document.querySelector("#modeSwitch")'),'frontend ready');
 if(await evaluate('document.querySelector("#modeSwitch").textContent.trim().toLowerCase()!=="work"'))await click('#modeSwitch');
 await until(()=>evaluate('document.querySelector("#modeSwitch").textContent.trim().toLowerCase()==="work"'),'Work mode selected');
 await until(()=>evaluate('!!document.querySelector("#botList [data-id=preview-builder]")'),'Work Bot roster');
 await click('#botList [data-id=preview-builder]');
 await until(()=>evaluate('!!document.querySelector(".work-artifact .work-action")'),'delivered artifact card');
 await evaluate(`window.__previewReport=null;window.__previewCounter=0;window.addEventListener('message',e=>{if(e.origin!=='null')return;if(e.data?.fixture==='dimension-preview')window.__previewReport=e.data;if(e.data?.fixture==='dimension-preview-counter')window.__previewCounter=e.data.n;});`);
 await click('.work-artifact .work-action');
 const report=await until(()=>evaluate('window.__previewReport'),'actual iframe module and data load');
 assert.deepEqual(report,{fixture:'dimension-preview',value:'actual-module',data:'actual-data',parentBlocked:true,apiBlocked:true,color:'rgb(17, 34, 51)'});
 const attrs=await evaluate('({sandbox:document.querySelector(".work-preview iframe").getAttribute("sandbox"),src:document.querySelector(".work-preview iframe").src})');
 assert.equal(attrs.sandbox,'allow-scripts');assert.equal(attrs.src,html.previewUrl);
 pass('Real Chrome executes local JS modules, CSS and JSON while parent document and application API remain inaccessible');
 await browser.screenshot('01-interactive-project-preview');
 await click('.work-preview-close');await until(()=>evaluate('!document.querySelector(".work-preview")'),'close button removes preview');
 await click('.work-artifact .work-action');await until(()=>evaluate('!!document.querySelector(".work-preview[open]")'),'reopen');
 const outside=await evaluate('(()=>{let r=document.querySelector(".work-preview").getBoundingClientRect();return{x:Math.max(1,r.x-8),y:Math.max(1,r.y-8)}})()');
 await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...outside});
 await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...outside});
 await until(()=>evaluate('!document.querySelector(".work-preview")'),'backdrop dismissal');
 await click('.work-artifact .work-action');await until(()=>evaluate('!!document.querySelector(".work-preview[open]")'),'third opening');
 await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 await until(()=>evaluate('!document.querySelector(".work-preview")'),'Escape dismissal');
 await browser.screenshot('02-preview-closed');
 pass('Repeated preview opening, close button, backdrop and Escape leave no modal overlay');
 assert.deepEqual(errors,[]);assert.deepEqual(browser.exceptions,[]);
 await browser.stop();browser=null;await app.stop();
 await writeFile(path.join(output,'result.json'),JSON.stringify({ok:true,checks,calls,files,nativeSha256:createHash('sha256').update(await readFile(executable)).digest('hex')},null,2));console.log('RESULT '+output);
}catch(error){await writeFile(path.join(output,'result.json'),JSON.stringify({ok:false,checks,calls,error:error.stack,errors,browserErrors:browser?.exceptions},null,2));throw error;}
finally{if(browser)await browser.stop().catch(()=>{});if(app)await app.stop().catch(()=>{});await new Promise(resolve=>model.close(resolve));}
