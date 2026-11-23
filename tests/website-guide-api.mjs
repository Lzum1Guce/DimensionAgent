import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {createHash,X509Certificate} from 'node:crypto';
import path from 'node:path';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {startBrowser} from './native-browser-fixture.mjs';
import {startNative,until,parseOptions} from './archive-export-api.mjs';
const opt=parseOptions(),release=path.resolve(opt.get('release')), output=path.resolve(opt.get('output'));
await mkdir(output,{recursive:true});
const runtime=path.join(output,'runtime');
await mkdir(runtime);
const source=await readFile(path.join(release,'runtime/website-guide.mjs'),'utf8');
let secure, delivered='', changed=false, secureUrl='';
let workerSource=source;
if(opt.get('tls-fixture')){
  const fixture=opt.get('tls-fixture');
  const key=await readFile(path.join(fixture,'key.pem')), cert=await readFile(path.join(fixture,'cert.pem'));
  const spki=new X509Certificate(cert).publicKey.export({type:'spki',format:'der'});
  const pin=createHash('sha256').update(spki).digest('base64');
  workerSource=source.replace("'--no-default-browser-check'",JSON.stringify('--ignore-certificate-errors-spki-list='+pin)+",'--no-default-browser-check'");
  secure=https.createServer({key,cert},async(req,res)=>{
    if(req.url==='/signup'){res.setHeader('content-type','text/html; charset=utf-8');
      res.end('<h1>测试注册表单</h1><input type="hidden" value="SECRET-FIXTURE"><button onclick="this.innerText=\'操作成功\'">下一步</button>');return;}
    if(req.url==='/delivered'){for await(const part of req)delivered+=part;res.end();return;}
    if(req.url==='/check'){res.end(changed?'yes':'no');return;}
    res.setHeader('content-type','text/html; charset=utf-8');res.end(`<h1>表单</h1><label>邮箱<input id="email" type="email"></label>
      <label>密码<input type="password"></label><label>验证码<input autocomplete="one-time-code"></label><p id="echo"></p>
      <script>email.oninput=()=>{echo.textContent=email.value;fetch('/delivered',{method:'POST',body:email.value})};
      setInterval(async()=>{if((await(await fetch('/check')).text())==='yes')history.replaceState({},'', '/changed')},50);</script>`);
  });
  await new Promise(resolve=>secure.listen(0,'127.0.0.1',resolve));
  secureUrl='https://form.fixture.example/form';
}
await writeFile(path.join(runtime,'website-guide.mjs'),workerSource.replace("'--no-first-run'","'--headless=new','--no-first-run'"));
for(const f of ['website-sandbox.mjs','website-sandbox-proxy.mjs'])await copyFile(path.join(release,'runtime',f),path.join(runtime,f));
let gateway=await readFile(path.join(release,'runtime/website-egress.mjs'),'utf8');
if(secure){
  // Route only the synthetic TLS fixture inside this disposable test gateway.
  gateway=gateway.replace('const ips=await lookup', `if(host==='form.fixture.example'){
    const sock=net.connect({host:'127.0.0.1',port:${secure.address().port}},()=>ready(sock));
    entry.sock=sock;sock.on('error',()=>end(id));return;
  }
      const ips=await lookup`);
}
await writeFile(path.join(runtime,'website-egress.mjs'),gateway);
let requests=[];
let selectedSource;
const httpServer=http.createServer(async(req,res)=>{
  if(req.url==='/signup'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<h1>测试注册表单</h1><label>密码<input type=password value="SECRET-FIXTURE"></label><button onclick="this.innerText=\'操作成功\'">下一步</button>');return;}
  if(req.method==='POST'){
    let body='';for await(const c of req)body+=c;
    const request=JSON.parse(body);
    requests.push(request);res.setHeader('Content-Type','application/json');
    if(request.tools?.some(t=>t.function?.name==='website_read_result')&&!request.messages.some(m=>m.role==='tool')){
      const evidence=request.messages.find(m=>m.content?.startsWith?.('网站助手观察结果'));
      const hits=JSON.parse(evidence.content.split('\n').slice(1).join('\n')).result?.results||[];
      const hit=hits.find(h=>/(^|\.)blender\.org$/.test(new URL(h.url).hostname))||hits[0];
      if(hit){
        selectedSource=hit.url;
        res.end(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{
          id:'read-result',type:'function',function:{name:'website_read_result',arguments:JSON.stringify({ref:hit.ref})}
        }]},finish_reason:'tool_calls'}]}));return;
      }
    }
    res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'网站结果已收到'},finish_reason:'stop'}]}));return;
  }
  res.writeHead(404).end();
});
await new Promise(resolve=>httpServer.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+httpServer.address().port;
let app,ws,ui;
try{
  app=await startNative({label:'browser-guide',executable:path.join(release,'native/DImensionagent-native.exe'),ui:path.join(release,'ui'),
    data:path.join(output,'data'),output,extraArgs:['--sandbox-distro','dimension-sandbox','--desktop-helper',path.join(release,'linux/dimension-desktop-helper'),'--node',path.join(release,'runtime/node/node.exe'),'--plugin-host',path.join(runtime,'plugin-host.mjs')]});
  for(const id of ['web-one','web-two'])await app.api('/api/dimension/bots',{id,name:id,mode:'chat'});
  await app.api('/api/providers',{name:'guide',entry:{kind:'openai-chat-compat',baseUrl:url+'/v1',spec:{model:'guide'}},secretValue:'fixture'});
  ws=new WebSocket(app.origin.replace('http:','ws:')+'/ws/providers/world:console/panels/chat');
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  const frames=[];ws.onmessage=e=>frames.push(JSON.parse(e.data));
  let seq=0;
  async function chat(text,bot='web-one'){
    const start=requests.length,frame=frames.length;
    ws.send(JSON.stringify({type:'hello',botId:bot,historyLimit:1}));
    ws.send(JSON.stringify({type:'msg',botId:bot,text,requestId:'guide-'+(++seq)}));
    const request=await until(()=>requests.slice(start).find(q=>q.messages?.some(m=>m.content===text)),'model received '+text,45000);
    await until(()=>frames.slice(frame).some(f=>!f.history&&f.role==='assistant'&&f.text==='网站结果已收到'),'reply');
    const observation=request.messages.find(m=>typeof m.content==='string'&&m.content.startsWith('网站助手观察结果'));
    assert(observation,JSON.stringify(request.messages).slice(0,1800));
    assert.equal(observation.role,'user');
    return JSON.parse(observation.content.split('\n').slice(1).join('\n'));
  }
  const denied=await chat('/浏览 '+url+'/signup');
  assert(denied.error,'sandbox must reject host HTTP');
  assert((await chat('/浏览 https://127.0.0.1/')).error,'sandbox must reject literal loopback');
  if(secure){
  const opened=await chat('/浏览 https://form.fixture.example/signup 帮我注册');
  assert(opened.result,JSON.stringify(opened));
  assert.match(opened.result.text,/测试注册表单/);
  assert(!JSON.stringify(opened).includes('SECRET-FIXTURE'));
  assert.match((await chat('/网页','web-two')).error,/尚未打开/);
  const ref=opened.result.controls.find(x=>x.name==='下一步').ref;
  assert.equal((await chat('/定位 '+ref)).result.action,'已定位');
  assert.equal((await chat('/点击 '+ref)).result.action,'已点击');
  assert.match((await chat('/网页')).result.text,/操作成功/);
  assert((await chat('/点击 '+ref)).error);
    assert(!frames.some(f=>f.type==='website.input-card'),'no card for plain HTTP');
    const observe=async(text)=>{const start=frames.length;await chat(text);return frames.slice(start).find(f=>f.type==='website.input-card').card;};
    const post=(card,values,bot='web-one',headers={})=>app.response('/api/dimension/bots/'+bot+'/website-input',
      {token:card.token,values},'POST',{'X-Dimension-Input':'1',...headers});
    ui=await startBrowser({output,processes:[]},app.origin);
    const selectRole=async id=>{
      const selector='.bot-item[data-id="'+id+'"]';
      await until(()=>ui.evaluate('!!document.querySelector('+JSON.stringify(selector)+')'),'role in sidebar');
      await ui.evaluate('document.querySelector('+JSON.stringify(selector)+').click()');
      await until(()=>ui.evaluate('document.querySelector('+JSON.stringify(selector)+').classList.contains("active")'),'role selected');
    };
    await selectRole('web-one');
    const dismissed=await observe('/浏览 '+secureUrl);
    await until(()=>ui.evaluate('!document.querySelector("#websiteInputCard").hidden'),'card rendered');
    await selectRole('web-two');
    await until(()=>ui.evaluate('document.querySelector("#websiteInputCard").hidden'),'card cleared on role switch');
    await new Promise(r=>setTimeout(r,150));
    assert.equal((await post(dismissed,[])).status,409);
    await selectRole('web-one');
    const stale=await observe('/网页');
    changed=true;await new Promise(r=>setTimeout(r,400));
    assert.equal((await post(stale,[])).status,409);
    changed=false;
    const restricted=await observe('/网页');
    const password=restricted.fields.find(f=>f.kind==='password');
    assert.equal((await post(restricted,[{ref:password.ref,value:'synthetic-rejected'}])).status,409);
    const card=await observe('/网页');
    assert.equal(card.origin,new URL(secureUrl).origin);
    assert(card.fields.find(f=>f.kind==='password').siteOnly);
    assert(card.fields.find(f=>f.kind==='one-time-code').siteOnly);
    const email=card.fields.find(f=>f.kind==='email');
    const secret='private-card-fixture@example.invalid',values=[{ref:email.ref,value:secret}];
    assert.equal((await post(card,values,'web-two')).status,409);
    assert.equal((await post(card,values,'web-one',{Origin:'https://outside.example'})).status,403);
    assert.equal(await ui.evaluate('document.querySelectorAll("#websiteInputCard input").length'),1);
    await ui.replace('#websiteInputCard input',secret);
    await ui.click('#websiteInputCard button');

    await until(()=>delivered===secret,'intended form received private input');
    assert.equal((await post(card,values)).status,409);
    assert.match((await chat('/网页')).error,/私密输入/);
    assert(!JSON.stringify(requests).includes(card.token)&&!JSON.stringify(requests).includes(secret));
    assert(!JSON.stringify(frames).includes(secret));
    assert(!JSON.stringify(await app.api('/api/dimension/bots/web-one/history')).includes(secret));
    console.log('PASS live HTTPS private input, separate credential handoff, stale page, wrong role, foreign origin, replay, privacy lock and history');
    await chat('/关闭网页');
  }
  if(opt.get('live-search')==='yes'){
    const text='帮我上网找 Blender 官网 下载';
    const found=await chat(text);
    assert(found.result?.results.length,JSON.stringify(found));
    const output=requests.flatMap(q=>q.messages).find(m=>m.role==='tool'&&m.tool_call_id==='read-result');
    assert(output, 'no source read returned to model');
    assert(output.content.includes(new URL(selectedSource).hostname)&&output.content.length>400,output.content.slice(0,600));
    console.log('PASS live '+found.result.provider+' search and opened '+new URL(selectedSource).hostname);
  }
  assert((await chat('/关闭网页')).result.closed);
  console.log('PASS private Chat, real browser navigation, model evidence, sensitive input omission, role isolation, highlight, click, stale ref and close');
}finally{ws?.close();await ui?.stop();await app?.stop();httpServer.close();secure?.close();}

