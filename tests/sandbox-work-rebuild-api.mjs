import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {randomUUID} from 'node:crypto';
import {startNative,until,parseOptions} from './archive-export-api.mjs';
const project=path.resolve(import.meta.dirname,'..'),options=parseOptions();
const output=path.resolve(options.get('output')||path.join(project,'outputs/work-rebuild',String(Date.now())));
const writeOnly = options.get('case') === 'root-write';
const probe = 'root-write-' + randomUUID() + '.txt';
const botId = 'rebuild-' + randomUUID();
const revisions = ['首次写入 🙂', '更新后的内容'];
await mkdir(output,{recursive:true});
const executable=path.resolve(options.get('exe') || path.join(project,'outputs/build/DImensionagent-native.exe')),processes=[],checks=[],calls=[],errors=[];
let app;const pass=name=>{checks.push({name,ok:true});console.log('PASS '+name);};
const build={argv:['/usr/bin/node','-e',"const fs=require('fs');fs.writeFileSync('output.txt',fs.readFileSync('input.txt','utf8'));console.log('actually built '+fs.readFileSync('input.txt','utf8'))"],outputs:['output.txt'],timeoutSeconds:30};
const marker='retry-'+randomUUID();
const retry={argv:['/usr/bin/python3','-c',"import pathlib,sys; p=pathlib.Path('"+marker+"'); first=not p.exists();p.write_text('attempt');print('first failure' if first else 'actual retry');sys.exit(7 if first else 0)"],timeoutSeconds:30};
const model=http.createServer(async(req,res)=>{
 try{
  let bytes='';for await(const b of req)bytes+=b;const body=JSON.parse(bytes);
  // Background conversation requests share this provider. Only Work calls
  // carry the sandbox execution tool and belong in the run assertions.
  if (!body.tools?.some(tool => tool.function?.name === 'sandbox_exec')) {
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}]}));
    return;
  }
  const results=body.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));let name,args;
  if (writeOnly) {
    for (const result of results) assert(!result.error, result.result);
    const step = results.length;
    if (step === 4) {
      name = 'task_finish';
      args = {summary:'托管根目录写入与替换均已验证', artifacts:results[3].artifacts, verification:results[3].verification};
    } else {
      assert(step < 4);
      const content = revisions[Math.floor(step / 2)];
      name = step % 2 ? 'verify_file' : 'write_file';
      args = {scope:'project', path:probe, ...(step % 2 ? {expected:content} : {content})};
    }
  } else switch(results.length){
   case 0:name='write_file';args={scope:'project',path:'input.txt',content:'revision-one'};break;
   case 1:assert(!results[0].error, results[0].result);name='sandbox_exec';args=build;break;
   case 2:assert(!results[1].error);assert(JSON.parse(results[1].result).stdout.includes('revision-one'));name='write_file';args={scope:'project',path:'input.txt',content:'revision-two'};break;
   case 3:name='sandbox_exec';args=build;break;
   case 4:assert(!results[3].error);assert(JSON.parse(results[3].result).stdout.includes('revision-two'),'Repeated command must actually rebuild changed source');name='sandbox_exec';args=retry;break;
   case 5:assert(results[4].error);assert.equal(results[4].metadata.execution_outcome_known,true);assert.equal(results[4].metadata.no_side_effects,false);assert.equal(JSON.parse(results[4].result).exitCode,7);name='sandbox_exec';args=retry;break;
   case 6:assert(!results[5].error);assert(JSON.parse(results[5].result).stdout.includes('actual retry'));name='sandbox_exec';args={argv:['/usr/bin/python3','-c','import os;os.write(1,bytes(200000));os.write(2,bytes(200000))'],timeoutSeconds:30};break;
   case 7:{
    const last=results[6];assert(!last.error);const v=JSON.parse(last.result);assert(v.ok&&v.outputExcerpted);assert(v.stdout.includes('200000')&&v.stdout.length<200);assert(v.stderr.includes('200000')&&v.stderr.length<200);
    name='task_finish';args={summary:'已在源码修改后重新构建，并验证失败重试和长日志。',artifacts:results[3].artifacts,verification:results[3].verification};break;
   }
   default:throw Error('Unexpected model round '+results.length);
  }
  calls.push({name,args});res.writeHead(200,{'content-type':'text/event-stream'});
  res.end('data: '+JSON.stringify({choices:[{index:0,delta:{tool_calls:[{index:0,id:'rebuild-'+calls.length,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n');
 }catch(error){errors.push(error.stack);res.writeHead(500);res.end('fixture failed');}
});
await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
try{
 app=await startNative({label:'rebuild',executable,ui:path.resolve(options.get('ui') || path.join(project,'ui')),data:path.join(output,'data'),output,processes,
  extraArgs:['--desktop-helper',path.resolve(options.get('helper') || path.join(project,'outputs/linux/dimension-desktop-helper-apps')),'--sandbox-distro','dimension-sandbox','--desktop-home-root','/home/dimension']});
 const api=(...args)=>app.api(...args);
 await api('/api/dimension/bots',{id:botId,name:'合成构建测试助手',mode:'work'});
 await api('/api/dimension/work/settings',{botId,cliEngine:'builtin',approvalMode:'full',networkAccess:false},'PATCH');
 await api('/api/providers',{name:'rebuild-fixture',entry:{kind:'openai-chat-compat',baseUrl:'http://127.0.0.1:'+model.address().port+'/v1',spec:{model:'fixture-rebuild'},secret:{kind:'literal',value:'synthetic-only'}}});
 await api('/api/providers/rebuild-fixture/activate',{});
 const run=(await api('/api/dimension/work/runs',{botId,requestId:'rebuild',text:'验证真实构建、源码修改后的重建、失败后重试和完整日志保存'})).run;
 const done=await until(async()=>{const r=await api('/api/dimension/work/runs/'+run.id);return r.terminal&&!r.executing?r:null;},'real repeated commands',90000);
 assert.equal(done.status,'completed',JSON.stringify({status:done.status,error:done.error,errors}));assert.deepEqual(errors,[]);
 if (writeOnly) {
   assert.equal(calls.length,5);
   const binding = JSON.parse(await readFile(path.join(output,'data/workspace-bindings',run.id+'.json'),'utf8'));
   assert.match(binding.project,/^\\\\wsl\.localhost\\dimension-sandbox\\var\\lib\\dimension\\managed\\/i);
   assert.equal(await readFile(path.join(binding.project,probe),'utf8'),revisions[1]);
   pass('Managed WSL root creates a new file, verifies exact bytes, then replaces and verifies it');
 } else {
 assert.equal(calls.length,8);
 pass('New tool call IDs actually rerun the same build command after source changes');
 pass('A known exit 7 can be retried without falsely claiming its partial writes had no side effects');
 const files=(await api('/api/dimension/work/tasks/'+run.id+'/artifacts')).files;
 const snapshots=files.filter(f=>f.relativePath.startsWith('sandbox-snapshots/') && f.name.endsWith('-output.txt'));
 assert.deepEqual(await Promise.all(snapshots.map(async f=>(await app.response(f.url)).text)),['revision-one','revision-two']);
 const logs=await Promise.all(files.filter(f=>f.extension==='.json').map(async file=>({file,data:await api(file.url)})));
 const controls=logs.find(x=>x.data.stdout?.length===200000&&x.data.stderr?.length===200000);
 assert(controls,'Full control-byte logs remain available as real receipt files');
 pass('Large control-byte logs stay complete on disk while model results stay below their budget');
 }
 await app.stop();
 await writeFile(path.join(output,'result.json'),JSON.stringify({ok:true,checks,calls: calls.map(c=>c.name),nativeSha256:createHash('sha256').update(await readFile(executable)).digest('hex')},null,2));console.log('RESULT '+output);
}catch(error){await writeFile(path.join(output,'result.json'),JSON.stringify({ok:false,checks,calls:calls.map(c=>c.name),errors,error:error.stack},null,2));throw error;}
finally{if(app)await app.stop().catch(()=>{});await new Promise(resolve=>model.close(resolve));}
