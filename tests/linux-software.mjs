import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const project=path.resolve(import.meta.dirname,'..'),output=path.join(project,'outputs/phase3-software/linux',String(Date.now()));
await mkdir(output,{recursive:true});const helper=path.join(project,'outputs/linux/dimension-software-helper');
const linuxPath=helper.replaceAll('\\','/').replace(/^([a-zA-Z]):/,(_,drive)=>'/mnt/'+drive.toLowerCase());
const checks=[],processes=[];const pass=name=>{checks.push({name,ok:true});console.log('PASS '+name);};
async function run(request){
 const child=spawn('C:/Windows/System32/wsl.exe',['-d','dimension-sandbox','-u','root','--exec',linuxPath],{cwd:output,windowsHide:true,stdio:['pipe','pipe','pipe']});
 const rec={pid:child.pid};processes.push(rec);let data='',error='';
 child.stdout.on('data',value=>data+=value);child.stderr.on('data',value=>error+=value);
 const ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
 child.stdin.write(JSON.stringify(request)+'\n');const timer=setTimeout(()=>child.stdin.end(),620000);
 try{const result=await ended;rec.exit=result.code;assert.equal(result.code,0,error.slice(-300));return JSON.parse(data.trim());}finally{clearTimeout(timer);child.stdin.end();}
}
try{
 const paths=['/usr/bin/printf','/bin/printf'];let executable;
 for(const candidate of paths){const result=await run({operation:'query',package:'coreutils',executable:candidate});if(result.verified){executable=candidate;break;}}
 assert(executable,'A real installed executable must be verified by its owning package');pass('Queries actual dpkg status and validates executable ownership');
 const existing=await run({operation:'install',package:'coreutils',executable});assert(existing.ok&&existing.verified&&existing.alreadyInstalled);pass('Already-installed package is verified without repeating installation');
 const wrong=await run({operation:'install',package:'coreutils',executable:'/usr/bin/not-real-dimensionagent'});assert.equal(wrong.ok,false);assert.equal(wrong.code,'executable_not_owned_by_package');pass('Installed package with wrong executable is not falsely registered');
 const bad=await run({operation:'install',package:'--help',executable});assert.equal(bad.ok,false);assert.equal(bad.code,'invalid_package_or_executable');pass('Package option injection is rejected before any apt command');
 const missing=await run({operation:'install',package:'dimensionagent-nonexistent-fixture-package',executable:'/usr/bin/dimensionagent-fixture'});assert.equal(missing.ok,false);assert.equal(missing.code,'package_install_failed');pass('Actual apt failure is reported without a fabricated success');
 await writeFile(path.join(output,'result.json'),JSON.stringify({ok:true,checks,processes,helperSha256:createHash('sha256').update(await readFile(helper)).digest('hex')},null,2));
 console.log('RESULT '+output);
}catch(error){await writeFile(path.join(output,'result.json'),JSON.stringify({ok:false,checks,processes,error:error.stack},null,2));throw error;}
