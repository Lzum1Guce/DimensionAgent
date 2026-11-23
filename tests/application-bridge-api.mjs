// Original end-to-end fixture: native Work -> local model protocol -> real
// Linux Chrome -> synthetic website -> actual image download and task artifact.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import http from 'node:http';
import path from 'node:path';
const project=path.resolve(import.meta.dirname,'..'),args=new Map();
for(let i=2;i<process.argv.length;i+=2)args.set(process.argv[i].replace(/^--/,''),process.argv[i+1]);
const output=path.resolve(args.get('output')||path.join(project,'outputs/phase3-applications/api',new Date().toISOString().replace(/[:.]/g,'-')));
const executable=path.resolve(args.get('exe')||path.join(project,'outputs/build/DImensionagent-native.exe'));
const helper=path.resolve(args.get('helper')||path.join(project,'outputs/linux/dimension-desktop-helper-apps'));
const data=path.join(output,'data'),distro='dimension-sandbox';
const homeArgs=args.has('home-root')?['--desktop-home-root',args.get('home-root')]:[];
assert(/^[lL]:[\\/]/.test(output));
await mkdir(output,{recursive:true});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const original=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const checks=[],processes=[],modelCalls=[],errors=[];let app,web,model,stage='start',jobId,toolCounter=0;
const pass=name=>{checks.push({name,ok:true});console.log('PASS '+name);};
async function until(fn,description,timeout=15000){let last;const deadline=Date.now()+timeout;while(Date.now()<deadline){try{const value=await fn();if(value)return value;}catch(e){last=e;}await pause(80);}throw Error('Timeout '+description+(last?': '+last.message:''));}
function tracked(exe,argv){
 const child=spawn(exe,argv,{cwd:output,windowsHide:true,stdio:['pipe','pipe','pipe']});
 const record={child,stdout:'',stderr:''};processes.push(record);
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
 child.stdout.on('data',chunk=>record.stdout+=chunk);child.stderr.on('data',chunk=>{if(record.stderr.length<16384)record.stderr+=chunk;});
 record.exit=new Promise(resolve=>child.once('exit',(code,signal)=>{record.exitCode=code;record.signal=signal;resolve({code,signal});}));
 child.once('error',error=>record.error=error);
 return record;
}
async function ready(record){return until(()=>{if(record.error)throw record.error;if(record.child.exitCode!==null)throw Error(record.stderr);for(const line of record.stdout.split(/\r?\n/)){try{const j=JSON.parse(line);if(Number.isInteger(j.port))return j;}catch{}}},'process ready');}
async function stop(record,line=''){if(!record||record.child.exitCode!==null)return;record.child.stdin.end(line);const timer=setTimeout(()=>record.child.kill(),10000);const ended=await record.exit;clearTimeout(timer);assert.equal(ended.code,0,record.stderr);}
async function api(route,body,method=body===undefined?'GET':'POST',expected=200){
 const response=await fetch(app.base+route,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
 const text=await response.text();assert.equal(response.status,expected,route+': '+text.slice(0,500));return text?JSON.parse(text):null;
}
function samplePNG(bytes,x,y){
 let width,channels;const chunks=[];
 for(let at=8;at+12<=bytes.length;){const size=bytes.readUInt32BE(at),kind=bytes.toString('ascii',at+4,at+8),chunk=bytes.subarray(at+8,at+8+size);
  if(kind==='IHDR'){width=chunk.readUInt32BE(0);channels=({2:3,6:4})[chunk[9]];assert.equal(chunk[8],8);}
  if(kind==='IDAT')chunks.push(chunk);at+=size+12;if(kind==='IEND')break;}
 assert(width&&channels);const stride=width*channels,raw=inflateSync(Buffer.concat(chunks),{maxOutputLength:8*1024*1024});let previous=Buffer.alloc(stride);
 for(let row=0;row<=y;row++){const current=Buffer.alloc(stride),filter=raw[row*(stride+1)];
  for(let col=0;col<stride;col++){const a=col>=channels?current[col-channels]:0,b=previous[col],c=col>=channels?previous[col-channels]:0;let predictor=0;
   if(filter===1)predictor=a;else if(filter===2)predictor=b;else if(filter===3)predictor=Math.floor((a+b)/2);else if(filter===4){const p=a+b-c,da=Math.abs(p-a),db=Math.abs(p-b),dc=Math.abs(p-c);predictor=da<=db&&da<=dc?a:db<=dc?b:c;}else assert.equal(filter,0);
   current[col]=(raw[row*(stride+1)+1+col]+predictor)&255;}previous=current;}
 return [...previous.subarray(x*channels,x*channels+3)];
}
function tool(res,name,arguments_){
 const id='application_fixture_'+(++toolCounter),delta={tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(arguments_)}}]};
 res.writeHead(200,{'content-type':'text/event-stream'});
 res.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n');
 modelCalls.push({name,arguments:arguments_});
}
try{
 const script="import http.server,json,sys,base64\nimage=base64.b64decode(sys.argv[1]);count=0\npage='''<!doctype html><meta charset=\"utf-8\"><title>Original application fixture</title><style>body{margin:0;background:#eee}button,a{position:absolute;display:grid;place-items:center;left:20px;top:60px;width:700px;height:400px;background:#008844;color:white;font-size:40px}</style><button>Generate fixture image</button><script>document.querySelector('button').onclick=async()=>{let r=await fetch('/generate',{method:'POST'});if(r.ok){document.querySelector('button').remove();let a=document.createElement('a');a.style.background='#2244dd';a.href='/original.png';a.download='generated-original.png';a.textContent='Download original';document.body.append(a);}};<"+"/script>'''\nclass H(http.server.BaseHTTPRequestHandler):\n def log_message(self,*a):pass\n def do_GET(self):\n  global count\n  value=image if self.path=='/original.png' else json.dumps({'submissions':count}).encode() if self.path=='/count' else page.encode()\n  self.send_response(200);self.send_header('Content-Type','image/png' if self.path=='/original.png' else 'text/html; charset=utf-8');\n  if self.path=='/original.png':self.send_header('Content-Disposition','attachment; filename=generated-original.png')\n  self.end_headers();self.wfile.write(value)\n def do_POST(self):\n  global count\n  if self.path!='/generate':self.send_error(404);return\n  count+=1;self.send_response(200);self.end_headers();self.wfile.write(b'{}')\nserver=http.server.ThreadingHTTPServer(('0.0.0.0',0),H)\nimport threading\nthreading.Thread(target=server.serve_forever,daemon=True).start();print(json.dumps({'port':server.server_port}),flush=True);sys.stdin.buffer.read();server.shutdown();server.server_close()";
 web=tracked('C:/Windows/System32/wsl.exe',['-d',distro,'--','/usr/bin/python3','-u','-c',script,original.toString('base64')]);
 const webReady=await ready(web);
 model=http.createServer(async(req,res)=>{
  try{
   assert.equal(req.method,'POST');assert.equal(req.url,'/v1/chat/completions');let text='';for await(const bytes of req)text+=bytes;const body=JSON.parse(text);
   const names=new Map();for(const message of body.messages)for(const c of message.tool_calls||[])names.set(c.id,c.function.name);
   const results=body.messages.filter(m=>m.role==='tool').map(m=>{const execution=JSON.parse(m.content);let summary;try{summary=JSON.parse(execution.result);}catch{}return{name:names.get(m.tool_call_id),execution,summary};});
   const latest=results.findLast(r=>['application_start','application_observe','application_action'].includes(r.name));
   const imageParts=body.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(p=>p.type==='image_url');
   const image=imageParts.length?Buffer.from(imageParts.at(-1).image_url.url.split(',')[1],'base64'):null;
   let pixel;if(image){pixel=samplePNG(image,300,250);await writeFile(path.join(output,'latest-model-frame.png'),image);}
   if(stage==='start'){stage='green';return tool(res,'application_start',{appId:'fixture',prompt:'生成测试图片并返回原图'});}
   if(!jobId){assert(latest?.summary?.job?.id,JSON.stringify(latest));jobId=latest.summary.job.id;}
   if(latest?.execution.error)throw Error('Application tool failed: '+latest.execution.result);
   const observe=async()=>{await pause(900);return tool(res,'application_observe',{jobId});};
   if(stage==='green'){
    if(!pixel||pixel[0]>10||pixel[1]<120||pixel[1]>150||pixel[2]<50||pixel[2]>85)return observe();
    assert(latest.summary.desktop.observationId);stage='blue';return tool(res,'application_action',{jobId,phase:'submitting',action:{op:'click',x:200,y:250,observationId:latest.summary.desktop.observationId}});
   }
   if(stage==='blue'){
    if(!pixel||pixel[0]<20||pixel[0]>50||pixel[1]<50||pixel[1]>85||pixel[2]<200)return observe();
    stage='download';return tool(res,'application_action',{jobId,phase:'running',action:{op:'click',x:200,y:250,observationId:latest.summary.desktop.observationId}});
   }
   if(stage==='download'){stage='collect';await pause(1000);return tool(res,'application_collect',{jobId});}
   if(stage==='collect'){
    const result=results.findLast(r=>r.name==='application_collect');
    if(result.execution.error){await pause(600);return tool(res,'application_collect',{jobId,names:['generated-original.png']});}
    assert.equal(result.execution.artifacts.length,1);assert(result.execution.verification);stage='finish';
    return tool(res,'task_finish',{summary:'已取回应用原图',artifacts:result.execution.artifacts,verification:result.execution.verification});
   }
   throw Error('Unexpected model stage '+stage);
  }catch(error){errors.push(error.stack);if(!res.headersSent)res.writeHead(500);res.end('fixture error');}
 });
 model.listen(0,'127.0.0.1');await once(model,'listening');
 app=tracked(executable,['--data',data,'--ui',path.join(project,'ui'),'--port','0','--sandbox-distro',distro,'--desktop-helper',helper,...homeArgs]);
 app.base='http://127.0.0.1:'+(await ready(app)).port;
 const initial=await api('/api/dimension/app-bridge');assert(initial.apps.some(a=>a.id==='doubao'));assert.equal(initial.jobs.length,0);
 const state=await api('/api/dimension/app-bridge/apps/doubao/status');assert.equal(state.accountStatus,'unknown');assert.equal(state.desktopRunning,false);
 pass('Public app registry and status distinguish configuration from login');
 await api('/api/dimension/app-bridge/apps',{id:'fixture',name:'Original local fixture',url:'http://127.0.0.1:'+webReady.port+'/',instructions:'生成一次，等蓝色下载按钮出现后下载原图。'});
 await api('/api/dimension/app-bridge/apps/fixture',{enabled:true},'PATCH');
 await api('/api/dimension/bots',{id:'application-bot',name:'合成应用助手',mode:'work'});
 await api('/api/dimension/work/settings',{botId:'application-bot',approvalMode:'full'},'PATCH');
 await api('/api/providers',{name:'fixture',entry:{kind:'openai-chat-compat',baseUrl:'http://127.0.0.1:'+model.address().port+'/v1',spec:{model:'fixture-vision'},secret:{kind:'literal',value:'synthetic-only'}}});
 await api('/api/providers/fixture/activate',{});pass('Registered app and explicit Work provider are persisted without real accounts');
 const submitted=await api('/api/dimension/work/runs',{botId:'application-bot',text:'使用 fixture 应用生成测试图片，并直接返回原图。',requestId:'application-fixture'});
 const runId=submitted.run.id;
 const finished=await until(async()=>{const r=await api('/api/dimension/work/runs/'+runId);return r.terminal&&!r.executing?r:null;},'application work completes',180000);
 assert.equal(finished.status,'completed',JSON.stringify({status:finished.status,error:finished.error,answer:finished.answer,modelErrors:errors,modelCalls}));
 assert.equal(errors.length,0);pass('Work model operates real sandbox Chrome and completes using downloaded-image evidence');
 const jobs=await api('/api/dimension/app-bridge');const job=jobs.jobs.find(j=>j.id===jobId);assert.equal(job.status,'completed');assert.equal(job.files.length,1);
 const download=await fetch(app.base+'/api/dimension/app-bridge/jobs/'+jobId+'/files/0');assert.equal(download.status,200,download.ok?'':await download.text());assert.equal(download.headers.get('content-type'),'image/png');
 const returned=Buffer.from(await download.arrayBuffer());assert.deepEqual(returned,original);await writeFile(path.join(output,'returned-original.png'),returned);
 const artifacts=await api('/api/dimension/work/tasks/'+runId+'/artifacts');assert.equal(artifacts.files.length,1);assert.equal(artifacts.files[0].available,true);
 const artifact=await fetch(app.base+artifacts.files[0].url);assert.equal(artifact.status,200);assert.deepEqual(Buffer.from(await artifact.arrayBuffer()),original);
 pass('Application URL and Work artifact return identical verified original bytes, including long paths');
 const submittedActions=modelCalls.filter(c=>c.name==='application_action'&&c.arguments.phase==='submitting');assert.equal(submittedActions.length,1);
 const saved=await readFile(path.join(data,'application-services','services.json'),'utf8');assert(!saved.includes('iVBORw0KGgo'),'screenshots are not stored in job metadata');
 pass('One submission intent, durable job metadata and no base64 screenshot persistence');
 await stop(app,'shutdown\n');
 app=tracked(executable,['--data',data,'--ui',path.join(project,'ui'),'--port','0','--sandbox-distro',distro,'--desktop-helper',helper,...homeArgs]);app.base='http://127.0.0.1:'+(await ready(app)).port;
 const after=await api('/api/dimension/app-bridge');assert.equal(after.jobs.find(j=>j.id===jobId).status,'completed');assert.equal(after.apps.find(a=>a.id==='fixture').enabled,true);
 const recovered=await fetch(app.base+'/api/dimension/app-bridge/jobs/'+jobId+'/files/0');assert.deepEqual(Buffer.from(await recovered.arrayBuffer()),original);
 pass('Native restart preserves enabled apps, completed jobs and actual result files');
 await stop(app,'shutdown\n');await stop(web);await new Promise(resolve=>model.close(resolve));model=null;
 await writeFile(path.join(output,'result.json'),JSON.stringify({ok:true,checks,nativeSha256:hash(await readFile(executable)),helperSha256:hash(await readFile(helper)),modelCalls,processes:processes.map(p=>({pid:p.child.pid,code:p.exitCode,signal:p.signal}))},null,2));
}catch(error){
 await writeFile(path.join(output,'result.json'),JSON.stringify({ok:false,checks,error:error.stack,modelErrors:errors,modelCalls},null,2));throw error;
}finally{
 for(const record of processes)if(record.child.exitCode===null)await stop(record,record===web?'':'shutdown\n').catch(()=>{});
 if(model)await new Promise(resolve=>model.close(resolve));
}
