// Hidden, separate WebView2 process. No Windows mouse/keyboard input.
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import http from 'node:http';
import net from 'node:net';
import {mkdir,cp,copyFile,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Cdp} from './native-browser-fixture.mjs';
import {until,delay} from './archive-export-api.mjs';
const project=path.resolve(import.meta.dirname,'..'),output=path.join(project,'outputs/native-preview',String(Date.now()));
await mkdir(output,{recursive:true});
const host=path.join(output,'DImensionagent-preview-check.exe'),backend=path.join(output,'DImensionagent-native.exe'),data=path.join(output,'data');
await copyFile(path.join(project,'outputs/build/DImensionagent.exe'),host);
await copyFile(path.join(project,'outputs/build/DImensionagent-native.exe'),backend);
await copyFile(path.join(project,'outputs/dependencies/webview2/1.0.4314.35/build/native/x64/WebView2Loader.dll'),path.join(output,'WebView2Loader.dll'));
const source=path.join(project,'outputs/project-preview/0250f05e-second');
// Desktop manifests are intentionally bound to one data directory, so the
// synthetic UI fixture receives a new desktop state instead of cloning it.
await cp(path.join(source,'data'),data,{recursive:true,filter:file=>!path.relative(path.join(source,'data'),file).split(path.sep).includes('desktop-data')});
const portProbe=net.createServer();await new Promise(resolve=>portProbe.listen(0,'127.0.0.1',resolve));const debugPort=portProbe.address().port;await new Promise(resolve=>portProbe.close(resolve));
await writeFile(path.join(output,'native-client.json'),JSON.stringify({backend,ui:path.join(project,'ui'),data,loader:'WebView2Loader.dll',debugPort}));
const checks=[],exceptions=[],trapRequests=[];const pass=name=>{checks.push({name,ok:true});console.log('PASS '+name);};
const trap=http.createServer((req,res)=>{trapRequests.push(req.url);res.end('trap');});await new Promise(resolve=>trap.listen(0,'127.0.0.1',resolve));
const child=spawn(host,['--background'],{cwd:output,windowsHide:true,stdio:['ignore','pipe','pipe']});
let cdp,browserCdp;child.stdout.resume();let stderr='';child.stderr.on('data',bytes=>stderr+=bytes);
const ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});
try{
 const page=await until(async()=>{if(child.exitCode!==null)throw Object.assign(Error('Native host exited: '+stderr),{fatal:true});const pages=await fetch('http://127.0.0.1:'+debugPort+'/json/list').then(r=>r.json());return pages.find(p=>p.type==='page'&&p.url.includes('/dimension-ui/'));},'native hidden WebView2');
 cdp=await Cdp.connect(page.webSocketDebuggerUrl,exceptions);
 const version=await fetch('http://127.0.0.1:'+debugPort+'/json/version').then(r=>r.json());browserCdp=await Cdp.connect(version.webSocketDebuggerUrl,exceptions);
 await cdp.call('Runtime.enable');await cdp.call('Page.enable');
 const evaluate=expression=>cdp.evaluate(expression);
 await until(()=>evaluate('document.querySelector("#modeSwitch")?.dataset.bound==="1"&&!!window.chrome?.webview&&performance.getEntriesByType("resource").some(e=>e.name.endsWith("/api/dimension/bootstrap"))'),'native frontend bridge and bootstrap');
 await evaluate('if(document.querySelector("#modeSwitch").textContent.trim().toLowerCase()!=="work")document.querySelector("#modeSwitch").click()');
 await until(()=>evaluate('!!document.querySelector("#botList [data-id=preview-builder]")'),'native work Bot');
 await evaluate('document.querySelector("#botList [data-id=preview-builder]").click()');
 await until(()=>evaluate('!!document.querySelector(".work-artifact .work-action")'),'native artifact');
 await evaluate("window.__nativePreview=null;window.addEventListener('message',e=>{if(e.origin==='null'&&e.data?.fixture==='dimension-preview')window.__nativePreview=e.data;});document.querySelector('.work-artifact .work-action').click()");
 const report=await until(()=>evaluate('window.__nativePreview'),'host-approved interactive frame');
 assert.equal(report.value,'actual-module');assert(report.parentBlocked&&report.apiBlocked);
 pass('Hidden real WebView2 grants the actual preview URL and executes its local resources');
 const previewUrl=await evaluate('document.querySelector(".work-preview iframe").src');
 const original=JSON.parse(await readFile(path.join(source,'result.json'),'utf8')).files.find(f=>f.extension==='.html');
 const trapName='native-navigation-trap-'+Date.now()+'.html';
 await writeFile(path.join(path.dirname(original.path),trapName),'<!doctype html><h1>Navigation boundary fixture</h1><script>setTimeout(()=>location.href='+JSON.stringify('http://127.0.0.1:'+trap.address().port+'/leak?synthetic=yes')+',150)</script>');
 const trapUrl=new URL(trapName,previewUrl).href;
 await evaluate('document.querySelector(".work-preview iframe").src='+JSON.stringify(trapUrl));
 await until(async()=>(await readFile(path.join(data,'native-client.log'),'utf8')).includes('Blocked preview navigation outside its granted resources'),'native frame navigation blocked');
 await delay(300);assert.deepEqual(trapRequests,[]);
 pass('Native frame navigation is rejected before a different loopback service receives any request');
 await evaluate('document.querySelector(".work-preview-close").click()');
 await until(()=>evaluate('!document.querySelector(".work-preview")'),'native close');
 await evaluate('document.querySelector(".work-artifact .work-action").click()');
 await until(()=>evaluate('!!document.querySelector(".work-preview iframe")?.src'),'native reopen');
 await evaluate('document.querySelector(".work-preview").close()');
 await until(()=>evaluate('!document.querySelector(".work-preview")'),'native dialog close event');
 pass('Closing and reopening a native preview removes its modal and releases the navigation grant');
 const png=await cdp.call('Page.captureScreenshot',{format:'png'});await writeFile(path.join(output,'native-preview-closed.png'),Buffer.from(png.data,'base64'));
 cdp.socket.close();browserCdp.socket.close();cdp=browserCdp=null;
 await promisify(execFile)(host,['--quit'],{cwd:output,windowsHide:true});
 assert.equal(await ended,0);
 const inventory=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',
  'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:DIMENSION_NATIVE_TEST_DATA) } | Select-Object ProcessId,Name | ConvertTo-Json -Compress'],
  {cwd:output,windowsHide:true,env:{...process.env,DIMENSION_NATIVE_TEST_DATA:data}});
 assert.equal(inventory.stdout.trim(),'');
 pass('Explicit native quit clears the owned backend and WebView2 processes');
 await writeFile(path.join(output,'result.json'),JSON.stringify({ok:true,checks,trapRequests,hostSha256:createHash('sha256').update(await readFile(host)).digest('hex'),nativeSha256:createHash('sha256').update(await readFile(backend)).digest('hex')},null,2));console.log('RESULT '+output);
}catch(error){await writeFile(path.join(output,'result.json'),JSON.stringify({ok:false,checks,trapRequests,error:error.stack,stderr},null,2));throw error;}
finally{cdp?.socket.close();browserCdp?.socket.close();if(child.exitCode===null){await promisify(execFile)(host,['--quit'],{cwd:output,windowsHide:true}).catch(()=>{});await ended;}await new Promise(resolve=>trap.close(resolve));}
