// Process/lifecycle integration without desktop input or window automation.
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,copyFile,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const project=path.resolve(import.meta.dirname,'..'),base=path.resolve(project,'../..');
const bundle=process.argv[2]?path.resolve(process.argv[2]):null;
const output=path.join(project,'outputs/phase3-desktop-client',String(Date.now()));await mkdir(output,{recursive:true});
const host=path.join(output,'DImensionagent-client-lifecycle.exe'),backend=path.join(output,'DImensionagent-native.exe');
await copyFile(bundle?path.join(bundle,'DImensionagent.exe'):path.join(project,'outputs/build/DImensionagent.exe'),host);await copyFile(bundle?path.join(bundle,'native/DImensionagent-native.exe'):path.join(project,'outputs/build/DImensionagent-native.exe'),backend);
await copyFile(bundle?path.join(bundle,'runtime/webview2/WebView2Loader.dll'):path.join(project,'outputs/dependencies/webview2/1.0.4314.35/build/native/x64/WebView2Loader.dll'),path.join(output,'WebView2Loader.dll'));
const config={backend,ui:path.join(bundle||project,'ui'),data:path.join(output,'data'),loader:'WebView2Loader.dll',icon:path.join(bundle||project,'ui/DimensionAgent.ico'),
    splash:bundle?path.join(bundle,'ui/splash.png'):path.join(base,'outputs/DimensionAgent-开屏.png'),node:bundle?path.join(bundle,'runtime/node/node.exe'):path.join(project,'outputs/release-candidate/runtime/node/node.exe'),pluginHost:path.join(bundle||project,'runtime/plugin-host.mjs')};
await writeFile(path.join(output,'native-client.json'),JSON.stringify(config));
const checks=[],processes=[];const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,ms=30000){const limit=Date.now()+ms;while(Date.now()<limit){const result=await fn();if(result)return result;await pause(75);}throw Error('Timeout '+label);}
const exec=promisify(execFile);
async function inventory(){
 const needle=output.replaceAll("'","''");
 const script="$rows = @(Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -like '"+needle+"*') -or (($_.Name -eq 'msedgewebview2.exe') -and ($_.CommandLine -like '*"+needle+"*')) } | Select-Object ProcessId,ParentProcessId,Name); ConvertTo-Json -InputObject $rows -Compress";
 const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{cwd:output,windowsHide:true});return JSON.parse(stdout||'[]');
}
function launch(args){
 const child=spawn(host,args,{cwd:output,windowsHide:true,stdio:['ignore','pipe','pipe']});const rec={pid:child.pid,args};processes.push(rec);
 let diagnostic='';child.stderr.on('data',data=>diagnostic+=data);child.stdout.resume();
 rec.ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{rec.exit=code;rec.signal=signal;rec.diagnostic=diagnostic;resolve(code);});});return rec;
}
const pass=name=>{checks.push({name,ok:true});console.log('PASS '+name);};
let current;
async function ready(){return until(async()=>{try{const text=await readFile(path.join(output,'data/native-client.log'),'utf8');if(!text.includes('Frontend loaded'))return false;const matches=[...text.matchAll(/Native service ready on 127\.0\.0\.1:(\d+)/g)];return matches.at(-1)?.[1];}catch{return false;}},'hidden frontend startup',45000);}
try{
 current=launch(['--background']);const port=await ready();
 assert.equal((await fetch('http://127.0.0.1:'+port+'/api/status').then(r=>r.json())).ready,true);
 let live=await inventory();assert(live.some(p=>p.ProcessId===current.pid));assert.equal(live.filter(p=>p.Name==='DImensionagent-native.exe').length,1);pass('Hidden Win32/WebView2 host launches one owned native backend and loads the preserved UI');
 const duplicate=launch(['--background']);assert.equal(await duplicate.ended,0);live=await inventory();assert.equal(live.filter(p=>p.Name==='DImensionagent-client-lifecycle.exe').length,1);assert.equal(live.filter(p=>p.Name==='DImensionagent-native.exe').length,1);pass('Repeated background startup reuses the existing instance without another backend');
 const quit=launch(['--quit']);assert.equal(await quit.ended,0);assert.equal(await current.ended,0);await until(async()=>!(await inventory()).length,'all host/backend/WebView2 children exit');pass('Explicit quit completes graceful backend shutdown and leaves no owned processes');
 const again=launch(['--quit']);assert.equal(await again.ended,0);assert.equal((await inventory()).length,0);pass('Quit when not running does not start a service');
 const bad=path.join(output,'bad-client.json');await writeFile(bad,JSON.stringify({...config,data:path.join(output,'bad-data'),backend:path.join(output,'missing.exe')}));
 const failure=launch(['--background','--config',bad]);assert.equal(await failure.ended,1);assert.equal((await inventory()).length,0);pass('Incomplete installation returns a nonzero exit without background residue or a modal prompt');
 current=launch(['--background']);await until(async()=>(await inventory()).some(p=>p.Name==='DImensionagent-native.exe'),'relaunch owns backend');
 await exec('taskkill.exe',['/PID',String(current.pid),'/F'],{cwd:output,windowsHide:true});await current.ended;
 await until(async()=>!(await inventory()).length,'crash cleanup');pass('Abrupt host exit closes the ownership job and cleans backend and WebView2 descendants');
 await writeFile(path.join(output,'result.json'),JSON.stringify({ok:true,checks,hostSha256:createHash('sha256').update(await readFile(host)).digest('hex'),nativeSha256:createHash('sha256').update(await readFile(backend)).digest('hex'),processes:processes.map(({ended,...p})=>p)},null,2));console.log('RESULT '+output);
}catch(error){await writeFile(path.join(output,'result.json'),JSON.stringify({ok:false,checks,error:error.stack,processes:processes.map(({ended,...p})=>p)},null,2));throw error;}
finally{if(current&&current.exit===undefined){const quit=launch(['--quit']);await quit.ended;await current.ended;}}
