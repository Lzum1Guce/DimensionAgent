import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const sessions = new Map(), lanes = new Map();
const say = data => process.stdout.write(JSON.stringify(data)+'\n');
function webUrl(raw) {
  const u = new URL(raw);
  if (u.protocol!=='https:' || u.port || u.username || u.password || !/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(u.hostname) || /\.(local|localhost|lan|home|internal|arpa)$/i.test(u.hostname)) throw Error('网站沙盒仅支持公网 HTTPS 标准端口');
  return u;
}
// CDP uses anonymous pipes. The browser namespace has no externally reachable debugger.
function pipeDebugger(child) {
  const pending=new Map();let id=0,buffer='';
  child.stdio[4].setEncoding('utf8');
  child.stdio[4].on('data',chunk=>{
    buffer+=chunk;
    for(let end;(end=buffer.indexOf('\0'))>=0;){
      const raw=buffer.slice(0,end);buffer=buffer.slice(end+1);
      const msg=JSON.parse(raw),entry=pending.get(msg.id);
      if(!entry)continue;
      pending.delete(msg.id);clearTimeout(entry.timer);
      if(msg.error)entry.reject(Error('页面已变化，请重新查看'));else entry.resolve(msg.result);
    }
  });
  const closed=()=>{for(const e of pending.values()){clearTimeout(e.timer);e.reject(Error('沙盒浏览器已关闭'));}pending.clear();};
  child.once('exit',closed);child.stdio[3].on('error',closed);
  return (method,params={},sessionId)=>new Promise((resolve,reject)=>{
    const seq=++id,timer=setTimeout(()=>{pending.delete(seq);reject(Error('沙盒浏览器操作超时'));},method==='Page.navigate'?13000:7000);
    pending.set(seq,{resolve,reject,timer});
    child.stdio[3].write(JSON.stringify({id:seq,method,params,sessionId})+'\0');
  });
}
const {browserProxy}=await import('./website-sandbox-proxy.mjs');
const proxy=await browserProxy(network=>say({network}));
async function launch(bot) {
  const profile=await mkdtemp('/tmp/browser-');
  const child=spawn('/opt/google/chrome/chrome',['--ozone-platform=wayland','--disable-dev-shm-usage',
    '--user-data-dir='+profile,'--remote-debugging-pipe','--disable-quic','--disable-gpu',
    '--proxy-server=http://127.0.0.1:'+proxy.port,'--proxy-bypass-list=<-loopback>',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--no-first-run','--no-default-browser-check',
    '--disable-sync','--disable-extensions','--disable-background-networking','--incognito','about:blank'],
    {stdio:['ignore','ignore','ignore','pipe','pipe']});
  const call=pipeDebugger(child),session={child};
  child.once('error',()=>{session.failed=true;});
  child.once('exit',()=>{
    session.failed=true;sessions.delete(bot);
    // The user's window close must release the WSL workload even without another chat command.
    proxy.close();process.stdin.destroy();
  });
  try{
    const {targetInfos}=await call('Target.getTargets');
    let target=targetInfos.find(t=>t.type==='page');
    if(!target)target=await call('Target.createTarget',{url:'about:blank'});
    const {sessionId}=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true});
    session.cdp={call:(method,params)=>call(method,params,method==='Browser.close'?undefined:sessionId)};
    sessions.set(bot,session);return session;
  }catch(e){child.kill();throw e;}
}
// Executed in an isolated world. Retain references to the actual controls, never their input values.
function inspectPage(prefix,origin,articleOnly=false) {
  if(location.origin!==origin)return {error:'页面已经跳转到其他站点，请用 /浏览 和当前地址重新授权'};
  const visible=e=>e.checkVisibility?e.checkVisibility({visibilityProperty:true,opacityProperty:true}):!!e.getClientRects().length;
  const clean=s=>(s||'').replace(/\s+/g,' ').trim();
  const label=e=>clean(e.getAttribute('aria-label')||Array.from(e.labels||[],l=>l.innerText).join(' ')||
    e.getAttribute('placeholder')||(!e.matches('textarea,input,select')&&!e.isContentEditable&&e.innerText)||e.getAttribute('name')||e.type||e.tagName).slice(0,90);
  const fields=[];
  const types={email:'邮箱',tel:'手机号',username:'用户名',name:'姓名','given-name':'名','family-name':'姓',password:'密码',
    'one-time-code':'验证码','cc-number':'银行卡号','cc-csc':'安全码','cc-exp':'卡片有效期',identity:'证件信息'};
  const classify=e=>{
    if(!(e instanceof HTMLInputElement)||e.readOnly||e.disabled||!visible(e)||!e.getClientRects().length)return '';
    const hint=e.autocomplete.toLowerCase().split(/\s+/).pop();
    if(e.type==='password'||hint==='current-password'||hint==='new-password')return 'password';
    if(hint==='one-time-code'||/验证码|verification.?code|\botp\b/i.test(label(e)+' '+e.name))return 'one-time-code';
    if(hint.startsWith('cc-'))return Object.hasOwn(types,hint)?hint:'cc-number';
    const description=label(e)+' '+e.name+' '+e.id;
    if(/银行卡|信用卡|安全码|credit.?card|card.?number|\bcvv\b|\bcvc\b/i.test(description))return 'cc-number';
    if(/身份证|证件号|护照|social.security|passport/i.test(description))return 'identity';
    if(!['text','email','tel'].includes(e.type))return '';
    if(Object.hasOwn(types,hint))return hint;
    if(Object.hasOwn(types,e.type))return e.type;
    if(/邮箱|电子邮件|\be[-_ ]?mail\b/i.test(description))return 'email';
    if(/手机号|电话号码|phone.?number/i.test(description))return 'tel';
    if(/用户名|user.?name/i.test(description))return 'username';
    return '';
  };
  const bindings=[];
  const entries=[], controls=[];
  for(const e of document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button]')){
    if(!visible(e)||e.disabled)continue;
    const ref=prefix+'-'+(entries.length+1), name=label(e), href=e.getAttribute('href');
    entries.push({ref,e,name,unchanged:()=>label(e)===name&&visible(e)&&e.getAttribute('href')===href});controls.push({ref,name,kind:e.tagName.toLowerCase()});
    const kind=classify(e);
    if(!articleOnly && kind && location.protocol==='https:' && fields.length<10){
      const form=e.form, destination=form?.action||location.href;
      if(new URL(destination,location.href).origin===origin){
        const siteOnly=!['email','tel','username','name','given-name','family-name'].includes(kind);
        fields.push({ref,kind,label:types[kind],siteOnly});
        const page=location.href,fieldName=e.name;
        bindings.push({ref,e,siteOnly,valid:()=>location.href===page&&e.isConnected&&classify(e)===kind&&
          e.name===fieldName&&e.form===form&&(form?.action||location.href)===destination&&visible(e)});
      }
    }
    if(entries.length===60)break;
  }
  globalThis.guideEntries=entries;
  globalThis.guideCardBindings=bindings;
  const pieces=[];let size=0;
  const walker=document.createTreeWalker((articleOnly && document.querySelector('main,article,[role=main]')) || document.body || document.documentElement,NodeFilter.SHOW_TEXT);
  for(let n=walker.nextNode(),i=0;n&&i<16000&&size<5500;n=walker.nextNode(),i++){
    const p=n.parentElement;
    if(!p||p.closest('script,style,noscript,input,textarea,select,[contenteditable],[aria-hidden=true]')||p.isContentEditable||!visible(p))continue;
    const t=clean(n.textContent);if(t){pieces.push(t);size+=t.length+1;}
  }
  return {site:location.origin,title:document.title,text:pieces.join(' ').slice(0,5500),controls,fields};
}
function act(ref,click,origin) {
  const entry=globalThis.guideEntries?.find(x=>x.ref===ref),e=entry?.e;
  if(location.origin!==origin||!e?.isConnected||e.disabled||!entry.unchanged()||!e.getClientRects().length)return {error:'控件已变化，请重新查看网页'};
  e.scrollIntoView({block:'center'});e.focus({preventScroll:true});
  if(click){globalThis.guideEntries=[];e.click();}
  else e.animate([{outline:'4px solid #f08030'},{outline:'4px solid #f08030'}],{duration:4000});
  return {control:entry.name,action:click?'已点击':'已定位'};
}
// Runs in the original isolated world and checks DOM identity again immediately before delivery.
function applyPrivateFields(values) {
  const fields=globalThis.guideCardBindings||[];
  globalThis.guideCardBindings=[];
  globalThis.guideEntries=[];
  if(!fields.length||!fields.every(f=>f.valid()))return false;
  const ready=values.map(({ref,value})=>({field:fields.find(f=>f.ref===ref&&!f.siteOnly),value}));
  if(ready.some(({field})=>!field))return false;
  const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  for(const {field,value} of ready){
    if(!field.valid())return false;
    set.call(field.e,value);
    field.e.dispatchEvent(new Event('input',{bubbles:true}));
    field.e.dispatchEvent(new Event('change',{bubbles:true}));
  }
  const next=fields.find(f=>f.siteOnly&&f.valid());
  if(next){next.e.scrollIntoView({block:'center'});next.e.focus();}
  return true;
}
async function useCard(s,token,values) {
  const card=s.card;
  if(!card||card.token!==token||Date.now()>card.expires)throw Error('输入卡已失效，请重新查看网页');
  s.card=null;
  if(!Array.isArray(values)||values.length>10||new Set(values.map(v=>v.ref)).size!==values.length||
    !values.every(v=>card.fields.some(f=>f.ref===v.ref&&!f.siteOnly)&&typeof v.value==='string'&&v.value.length<=512))
    throw Error('输入卡字段无效');
  const {frameTree}=await s.cdp.call('Page.getFrameTree');
  if(frameTree.frame.loaderId!==card.loader||frameTree.frame.url!==card.url)throw Error('页面已变化，输入卡已失效');
  // After handoff, the site may echo private input anywhere. Keep the entire window private.
  s.privateMode=true;
  const r=await s.cdp.call('Runtime.callFunctionOn',{executionContextId:card.world,
    functionDeclaration:applyPrivateFields.toString(),arguments:[{value:values}],returnByValue:true});
  if(r.result?.value!==true)throw Error('表单已变化，请在网站窗口核对');
  await s.cdp.call('Page.bringToFront');
  return {applied:true};
}
async function navigate(s,target) {
  const nav=await s.cdp.call('Page.navigate',{url:target.href});
  if(nav.errorText)throw Error('网页加载失败，请检查网络或系统代理');
  for(let i=0;i<40;i++){
    const {frameTree}=await s.cdp.call('Page.getFrameTree');
    if(!nav.loaderId || frameTree.frame.loaderId===nav.loaderId)return;
    await delay(100);
  }
  throw Error('页面仍在跳转，请稍后重试');
}

// Extract only organic results from the search provider. Never use executable page actions.
function extractResults(provider) {
  if(provider==='360'){
    return Array.from(document.querySelectorAll('li.res-list[data-result-type=normal]')).slice(0,20).flatMap(row=>{
      const a=row.querySelector('h3 a[data-mdurl]');
      return a?[{url:a.dataset.mdurl,title:a.textContent.trim(),summary:row.querySelector('.res-desc')?.textContent.trim()||''}]:[];
    });
  }
  const title=document.querySelector('channel > title')?.textContent?.trim().toLowerCase();
  const query=new URL(location.href).searchParams.get('q').trim().toLowerCase();
  if(!title?.includes(query))return [];
  return Array.from(document.querySelectorAll('item')).slice(0,20).map(item=>({
    url:item.querySelector('link')?.textContent.trim(),title:item.querySelector('title')?.textContent.trim(),
    summary:item.querySelector('description')?.textContent.trim()
  }));
}
function publicResult(raw){
  try {
    const u=webUrl(raw);
    if(u.protocol!=='https:'||u.port||!/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(u.hostname)||
      /\.(local|localhost|internal|lan|home|test|invalid|arpa)$/i.test(u.hostname))return null;
    u.hash='';
    return u;
  }catch{return null;}
}
async function search(s,query,run){
  const state=s.search?.run===run ? s.search : {run,results:[],reads:0,queries:0};
  if(state.queries>=3)throw Error('本轮已搜索三次，请根据已有资料回答');
  ++state.queries;
  state.results=[];
  s.search=state;
  if(typeof query!=='string'||!query.trim()||query.length>500)throw Error('请输入 1 到 500 字的搜索内容');
  for(const [provider,base] of [['360','https://www.so.com/s'],['bing','https://www.bing.com/search']]){
    try {
      const target=new URL(base);
      target.search='?q='+encodeURIComponent(query.trim());
      if(provider==='bing')target.search+='&format=rss&setlang='+(/[\u3400-\u9fff]/u.test(query)?'zh-CN':'en-US');
      await navigate(s,target);
      const {frameTree}=await s.cdp.call('Page.getFrameTree');
      if(new URL(frameTree.frame.url).origin!==target.origin)continue;
      const {executionContextId}=await s.cdp.call('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'DimensionAgentGuide'});
      for(let i=0;i<12;i++){
        const r=await s.cdp.call('Runtime.evaluate',{contextId:executionContextId,returnByValue:true,
          expression:'('+extractResults.toString()+')('+JSON.stringify(provider)+')'});
        const results=[], seen=new Set();
        for(const item of r.result?.value||[]){
          const u=publicResult(item.url);
          if(!u||!item.title||seen.has(u.href))continue;
          seen.add(u.href);
          results.push({ref:randomBytes(6).toString('hex'),title:item.title.slice(0,180),url:u.href,summary:(item.summary||'').slice(0,350)});
          if(results.length===8)break;
        }
        if(results.length){s.origin=target.origin;state.results=results;return {query,provider,results};}
        await delay(150);
      }
    }catch{}
  }
  throw Error('搜索服务未返回可用结果，可能需要验证或更换关键词');
}
async function handle({bot,action,url,ref,query,run,token,values}) {
  let s=sessions.get(bot);
  if(action==='close'){if(s)s.child.kill();return {closed:true};}
  if(action==='open')webUrl(url);
  if(!s && (action==='open'||action==='search')){
    if(sessions.size>=8)throw Error('请先关闭一个网站窗口');
    s=await launch(bot);
  }
  if(!s)throw Error('当前角色尚未打开网站，请发送 /浏览 https://网站地址');
  if(action==='discard-card'){if(s.card?.token===token)s.card=null;return {discarded:true};}
  if(action==='use-card')return useCard(s,token,values);
  if(s.privateMode)throw Error('当前窗口正在私密输入，请在网站完成操作。发送 /关闭网页 可结束私密会话');
  if(action!=='point')s.card=null;
  if(action==='search')return search(s,query,run);
  if(action==='result'){
    const hit=s.search?.results.find(item=>item.ref===ref);
    if(!hit||!run||run!==s.search.run)throw Error('该结果不属于本次搜索');
    if(s.search.reads>=4)throw Error('本次搜索已尝试阅读四个来源，请根据已有资料回答');
    ++s.search.reads;
    url=hit.url;
  }
  if(action==='open'||action==='result'){
    const target=webUrl(url);
    if(action==='open')s.search=null;
    s.origin=target.origin;
    await navigate(s,target);
  }
  const {frameTree}=await s.cdp.call('Page.getFrameTree');
  if(webUrl(frameTree.frame.url).origin!==s.origin)throw Error('网站已跳转，请用 /浏览 和当前网址重新授权');
  const {executionContextId}=await s.cdp.call('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'DimensionAgentGuide'});
  const evaluate=async(fn,args)=>{
    const r=await s.cdp.call('Runtime.evaluate',{contextId:executionContextId,returnByValue:true,expression:'('+fn.toString()+')('+args.map(x=>JSON.stringify(x)).join(',')+')'});
    if(r.exceptionDetails||!r.result?.value)throw Error('页面已变化，请重新查看');
    if(r.result.value.error)throw Error(r.result.value.error);
    return r.result.value;
  };
  if(action==='result'){
    let page;
    for(let n=0;n<10;n++){
      page=await evaluate(inspectPage,[randomBytes(4).toString('hex'),s.origin,true]);
      if(page.text.trim())break;
      await delay(150);
    }
    if(!page.text.trim())throw Error('该来源没有可读取的正文');
    return {url:frameTree.frame.url,title:page.title,text:page.text};
  }
  if(action==='read'||action==='open'){
    let page;
    for(let i=0;i<12;i++){
      page=await evaluate(inspectPage,[randomBytes(4).toString('hex'),s.origin]);
      if(page.text.trim()||page.controls.length)break;
      await delay(150);
    }
    const fields=page.fields;delete page.fields;
    if(fields.length){
      const token=randomBytes(24).toString('hex'), expires=Date.now()+120000;
      s.card={token,expires,fields,world:executionContextId,loader:frameTree.frame.loaderId,url:frameTree.frame.url};
      page.privateCard={token,expires,fields,origin:s.origin};
    }
    return page;
  }
  if(action==='point')return evaluate(act,[ref,false,s.origin]);
  if(action==='click'){
    const completed=await evaluate(act,[ref,true,s.origin]);
    for(let n=0;n<3;n++){
      await delay(200);
      try {
        const after=await handle({bot,action:'read'});
        if(after.privateCard){completed.privateCard=after.privateCard;break;}
      }catch{break;}
    }
    return completed;
  }
  throw Error('未知网页操作');
}
const input=createInterface({input:process.stdin});
input.on('line',line=>{
  let req;try{req=JSON.parse(line);}catch{return;}
  if(req.network){proxy.receive(req.network);return;}
  const prior=lanes.get(req.bot)||Promise.resolve();
  const work=prior.then(()=>handle(req)).then(result=>say({id:req.id,result}),err=>say({id:req.id,error:err.message})).finally(()=>{if(req.action==='close'||!sessions.size){proxy.close();process.stdin.destroy();}});
  lanes.set(req.bot,work);work.finally(()=>{if(lanes.get(req.bot)===work)lanes.delete(req.bot);});
});
input.on('close',()=>{proxy.close();for(const s of sessions.values())s.child.kill();});

