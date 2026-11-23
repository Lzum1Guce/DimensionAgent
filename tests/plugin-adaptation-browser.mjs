import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const project=path.resolve(import.meta.dirname,'..'),root=path.join(project,'outputs','plugin-adaptation');
await mkdir(root,{recursive:true});const out=await mkdtemp(path.join(root,'browser-'));
const checks=[],errors=[];let socket,chrome,server;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,name)=>{const end=Date.now()+12000;while(Date.now()<end){const v=await fn();if(v)return v;await delay(50);}throw Error('Timeout '+name);};
class CDP{
 constructor(ws){this.ws=ws;this.seq=0;this.pending=new Map();ws.onmessage=({data})=>{const m=JSON.parse(data);if(m.id){const q=this.pending.get(m.id);if(q){this.pending.delete(m.id);clearTimeout(q.timer);m.error?q.reject(Error(JSON.stringify(m.error))):q.resolve(m.result);}}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);};}
 call(method,params={}){return new Promise((resolve,reject)=>{const id=++this.seq,timer=setTimeout(()=>reject(Error(method+' timeout')),12000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}));});}
 async evaluate(expression){const r=await this.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
}
const html="<!doctype html><html><meta charset=\"utf-8\"><link rel=\"stylesheet\" href=\"/styles.css\"><body style=\"padding:30px;max-width:1000px;margin:auto\"><main id=\"market\"></main><script type=\"module\">\nimport {bindPluginMarket} from '/plugin-market-ui.js';\nwindow.requests=[];window.created=[];window.opened=[];window.failStart=false;window.delayStart=0;window.emptyBots=false;\nwindow.addEventListener('dimension-plugin-adaptation-created',e=>window.created.push(e.detail));\nwindow.addEventListener('dimension-open-plugin-adaptation',e=>window.opened.push(e.detail));\nconst unsupported={kind:'needs-adapter',supported:false,reasons:['Synthetic Cordis service requires an adapter.']};\nwindow.market=bindPluginMarket({host:document.querySelector('#market'),api:async(route,options)=>{\n const r=JSON.parse(options.body);window.requests.push(r);\n if(r.action==='source.list')return {sources:[{id:'source-fixture',name:'Synthetic local fixture'}]};\n if(r.action==='plugin.list')return {plugins:[]};\n if(r.action==='market.list')return {items:[{name:'fixture-plugin',title:'Synthetic Cordis plugin',description:'An original synthetic plugin for UI verification.',version:'1.2.3',license:'MIT',runtimeCompatibility:{status:'needs-adapter'}}]};\n if(r.action==='market.versions')return {versions:['1.2.3','1.2.4']};\n if(r.action==='package.inspect')return {inspection:{planId:'plan-'+r.version,manifest:{name:r.name,version:r.version,license:'MIT'},classification:unsupported,source:{type:'synthetic'}}};\n if(r.action==='adaptation.bots')return {bots:window.emptyBots?[]:[{id:'bot-a',name:'Bot A'},{id:'bot-b',name:'Bot B <img src=x>'}]};\n if(r.action==='adaptation.start'){\n  if(window.delayStart)await new Promise(resolve=>setTimeout(resolve,window.delayStart));\n  if(window.failStart)throw Error('Synthetic preparation failed. Retry is safe.');\n  return {run:{id:'run-'+r.botId,botId:r.botId,status:'queued'},adaptation:{functionalVerification:'not-verified'}};\n }\n throw Error('Unexpected fixture action '+r.action);\n}});\nawait window.market.open();\n</script></body></html>";
let success=false;
try{
 server=http.createServer(async(req,res)=>{const url=new URL(req.url,'http://localhost');if(url.pathname==='/'){res.setHeader('content-type','text/html;charset=utf-8');res.end(html);return;}const name=url.pathname.slice(1);if(['styles.css','plugin-market-ui.js','plugin-market-ui.css'].includes(name)){res.setHeader('content-type',name.endsWith('.css')?'text/css':'text/javascript');res.end(await readFile(path.join(project,'ui',name)));return;}res.writeHead(404);res.end();});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const profile=path.join(out,'chrome-profile');await mkdir(profile);
 chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','about:blank'],{cwd:out,windowsHide:true,stdio:'ignore'});
 const port=await until(async()=>{try{return Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);}catch{return false;}},'Chrome');
 const page=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(x=>x.type==='page');
 socket=new WebSocket(page.webSocketDebuggerUrl);await once(socket,'open');const c=new CDP(socket);
 await c.call('Page.enable');await c.call('Runtime.enable');await c.call('Emulation.setDeviceMetricsOverride',{width:1180,height:1000,deviceScaleFactor:1,mobile:false});
 await c.call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
 const query=s=>'document.querySelector('+JSON.stringify(s)+')';
 const click=async s=>{await until(()=>c.evaluate('!!'+query(s)+' && !'+query(s)+'.disabled'),'click '+s);await c.evaluate(query(s)+'.click()');};
 const select=async(s,v)=>c.evaluate('(()=>{const n='+query(s)+';n.value='+JSON.stringify(v)+';n.dispatchEvent(new Event("change",{bubbles:true}));})()');
 const pass=name=>{checks.push(name);console.log('PASS '+name);};
 await click('.pm-card button');await click('.pm-inspect-button');
 await until(()=>c.evaluate('!!document.querySelector(".pm-adapt-install")'),'inspect');
 assert.equal(await c.evaluate(query('.pm-install')+'.disabled'),true);
 await click('.pm-adapt-install');
 await until(()=>c.evaluate(query('.pm-adaptation-bot')+'.options.length===3'),'bots');
 assert.equal(await c.evaluate(query('.pm-adaptation-start')+'.disabled'),true);
 assert.equal(await c.evaluate('window.requests.filter(x=>x.action==="adaptation.start").length'),0);
 assert.equal(await c.evaluate('document.querySelectorAll(".pm-adaptation-choice img").length'),0);
 await click('.pm-adaptation-cancel');
 assert.equal(await c.evaluate('!!document.querySelector(".pm-adaptation-choice")'),false);
 pass('Needs-adapter keeps direct install disabled; Bot choice is explicit; cancellation creates no task');
 await click('.pm-adapt-install');await until(()=>c.evaluate(query('.pm-adaptation-bot')+'.options.length===3'),'bots reopen');
 await select('.pm-adaptation-bot','bot-b');await c.evaluate('window.failStart=true');await click('.pm-adaptation-start');
 await until(()=>c.evaluate(query('.pm-adaptation-status')+'.textContent.includes("Synthetic preparation failed")'),'failure');
 assert.equal(await c.evaluate(query('.pm-adaptation-bot')+'.disabled'),false);
 await c.evaluate('window.failStart=false;window.delayStart=150');
 await c.evaluate('document.querySelector(".pm-adaptation-start").click();document.querySelector(".pm-adaptation-start").click()');
 await until(()=>c.evaluate('window.created.length===1'),'created');
 const attempts=await c.evaluate('window.requests.filter(x=>x.action==="adaptation.start")');
 assert.equal(attempts.length,2);assert.equal(attempts[0].requestId,attempts[1].requestId);
 assert.equal(attempts[1].botId,'bot-b');assert.equal(attempts[1].planId,'plan-1.2.3');
 assert.deepEqual(Object.keys(attempts[1]).sort(),['action','botId','planId','requestId'].sort());
 await click('.pm-adaptation-open');
 assert.deepEqual(await c.evaluate('window.opened'),[{botId:'bot-b',runId:'run-bot-b'}]);
 assert.match(await c.evaluate(query('.pm-adaptation-choice')+'.textContent'),/实际测试/);
 const shot=await c.call('Page.captureScreenshot',{format:'png'});await writeFile(path.join(out,'selected-bot-created.png'),Buffer.from(shot.data,'base64'));
 pass('Retry reuses identity; double-click submits once; exact selected Bot/version reach Work callbacks');
 await select('.pm-version','1.2.4');
 assert.equal(await c.evaluate('!!document.querySelector(".pm-adaptation-choice")'),false);
 await click('.pm-inspect-button');await until(()=>c.evaluate(query('.pm-install')+'.textContent.includes("1.2.4")'),'new version');
 await c.evaluate('window.emptyBots=true');await click('.pm-adapt-install');
 await until(()=>c.evaluate(query('.pm-adaptation-status')+'.textContent.includes("没有可用")'),'empty bots');
 assert.equal(await c.evaluate(query('.pm-adaptation-start')+'.disabled'),true);
 await click('.pm-adaptation-cancel');await c.evaluate('window.emptyBots=false');
 await click('.pm-adapt-install');await until(()=>c.evaluate(query('.pm-adaptation-bot')+'.options.length===3'),'bots again');
 await select('.pm-adaptation-bot','bot-a');await c.evaluate('window.delayStart=250');await click('.pm-adaptation-start');
 await select('.pm-version','1.2.3');await until(()=>c.evaluate('window.created.length===2'),'background creation');
 assert.equal(await c.evaluate('!!document.querySelector(".pm-adaptation-choice")'),false);
 assert.equal((await c.evaluate('window.requests.filter(x=>x.action==="adaptation.start").at(-1)')).planId,'plan-1.2.4');
 pass('Changing versions clears stale controls; empty Bot lists block; pending creation retains its authorized version');
 assert.deepEqual(errors,[]);success=true;await c.call('Browser.close').catch(()=>{});
}finally{
 socket?.close();if(chrome&&chrome.exitCode===null){await Promise.race([once(chrome,'exit'),delay(2000)]);if(chrome.exitCode===null)chrome.kill();}
 if(server)await new Promise(resolve=>server.close(resolve));
 await writeFile(path.join(out,'result.json'),JSON.stringify({success,checks,errors},null,2));
 console.log(JSON.stringify({success,checks:checks.length,output:out}));
}

