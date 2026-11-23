// Run with node --test tests/ui-recovery.test.mjs. Use the shipped handlers with
// controlled transport timing; all file, clipboard and DOM state is in memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = name => readFileSync(new URL('../ui/' + name, import.meta.url), 'utf8');
const app = source('app.js'), dock = source('work-artifacts-dock.js');
const theater = source('story-theater-v3.js'), work = source('work-session-ui.js');
const noop = () => {};
function section(source, start, end) {
  const i = source.indexOf(start), j = source.indexOf(end, i + start.length);
  assert(i >= 0 && j > i, 'Missing handler boundary ' + start);
  return source.slice(i, j);
}
function execute(code, context) {
  return vm.runInNewContext('(async()=>{' + code + '})()', context);
}

test('accepted handoffs retire the submission ID and a transport retry keeps its ID', async () => {
  const ids = [], input = { value: '' };
  const handlers = section(app, 'const groupSendRetries', 'async function sendInterject');
  const env = {
    state: { activeGroupId: 'g', shellMode: 'chat', selections: {} }, crypto, TextDecoder,
    groupStreams: { begin: () => ({ mode: 'discuss' }), current: () => true,
      setMode: (t,m) => { t.mode=m; }, finish: () => true, busy: () => false },
    createThoughtStream: () => ({ finish: noop }), botNameOf: noop, takeGroupQuote: noop,
    clearSpeaking: noop, $: () => input, syncGroupChatControls: noop, addGroupMsg: () => ({}),
    setPending: noop, addGroupToRoster: noop, isWorkShell: () => false, setShellMode: noop,
    workSession: { refresh: noop }, activeGroup: noop, autoGrow: noop, addBubble: noop,
    remoteChatActive: new Set(), conversationDrafts: { capture: noop }, syncSendEnabled: noop,
    fetch: async (_, options) => {
      ids.push(JSON.parse(options.body).requestId);
      if (ids.length === 1) throw Error('transport');
      return new Response('data: {"kind":"run","mode":"work","runId":"r"}\n\n');
    },
  };
  await execute(handlers + "for(let i=0;i<3;i++)await sendGroup('same');", env);
  assert.equal(ids.length, 3); assert.equal(ids[0], ids[1]); assert.notEqual(ids[1], ids[2]);
});

test('history reads only the selected path and preserves transport errors', async () => {
  const attempts = [];
  const code = section(dock,'  async function loadCheckpointSource','  // ====') +
    "return loadCheckpointSource({id:'v1',versionNumber:1,primaryHtmlRel:'index.html'},file)";
  const env = { file:{ relativePath:'docs/guide.md',name:'guide.md' },currentRunId:'r',checkpointFileCache:new Map(),
    api: async path => { attempts.push(new URL(path,'http://local').searchParams.get('path')); throw Object.assign(Error('missing'),{status:404}); } };
  await assert.rejects(execute(code,env),/尚未生成/);
  assert.deepEqual(attempts,['deliverables/docs/guide.md','docs/guide.md']);
  await assert.rejects(execute(code,{...env,api:async()=>{throw Error('offline');}}),/offline/);
  const found=await execute(code,{...env,file:null,api:async()=>({path:'index.html',content:'entry'})});
  assert.equal(found.path,'index.html');
});

test('copy preserves full Unicode content; 20 preview generations keep one cache entry',async()=>{
  const raw='中文🙂'.repeat(70000)+'END',file={url:'a'},cache=new Map();
  let copied;
  const read=section(dock,'  const cacheKeyOfFile','  async function loadCheckpointSource');
  const copy=section(dock,'      copyBtn.onclick =','      actionStrip.append(copyBtn)');
  const preview=await execute(read+copy+
    'let text;for(let i=0;i<20;i++){manualRefreshTick++;text=await loadTextSource(cur)}await copyBtn.onclick();return text;',
    {cur:file,files:[file],sourceCache:cache,manualRefreshTick:0,copyBtn:{},appendCacheBust:x=>x,
      fetch:async()=>({ok:true,text:async()=>raw}),copyMessageText:s=>{copied=s;},messageActionNotice:noop});
  assert.match(preview,/预览已截断/); assert.equal(copied,raw); assert.equal(cache.size,1);
});

test('late search response after clear cannot restore results',async()=>{
  const elements={chatSearchResults:{},chatSearchCount:{},chatSearchBar:{hidden:false}};
  let finish;
  await execute(section(app,'  const runChatSearch =',"  $('chatSearchBtn')")+
    "const p=runChatSearch('old',1,'bot','b');++chatSearchVersion;await runChatSearch('',2,'bot','b');release();await p;",
    {chatSearchVersion:1,$:k=>elements[k],state:{botId:'b'},api:()=>new Promise(r=>{finish=r;}),
      release:()=>finish({matches:[{text:'old'}]}),escapeHtml:s=>s});
  assert.equal(elements.chatSearchResults.hidden,true); assert.equal(elements.chatSearchCount.textContent,'');
});

test('rewind preserves draft after failure and repeated Enter submits once',async()=>{
  let calls=0,closed=0,release;
  const gate=new Promise(r=>{release=r;});
  const env={group:{id:'g'},selectedNode:{id:'n'},dirInp:{value:'draft'},goBtn:{},toast:noop,
    api:async()=>{calls++;await gate;throw Error('offline');},closeModal:()=>{closed++;},release};
  await execute(section(app,'async function triggerStoryRewind','function refreshActiveGroupStoryState')+
    'const onRewind=triggerStoryRewind;'+section(theater,'      const doRewind =','      goBtn.onclick')+
    'const a=doRewind(),b=doRewind();release();await Promise.all([a,b]);',env);
  assert.equal(calls,1); assert.equal(closed,0); assert.equal(env.dirInp.value,'draft'); assert.equal(env.goBtn.disabled,false);
});

test('failed capture allows immediate retry',async()=>{
  const snapBtn={};
  await execute(section(theater,'    snapBtn.onclick =','    const upBtn')+'await snapBtn.onclick();',
    {snapBtn,group:{},quickCaptureCg:async()=>null});
  assert.equal(snapBtn.disabled,false);
});

test('root checkpoints shared by siblings; partial failure preserves data; success may clear it',async()=>{
  const buckets=new Map();let mode='full',reads=0;
  const api=async url=>{
    if(url.endsWith('checkpoints'))reads++;
    if(mode==='fail'&&!url.endsWith('artifacts'))throw Error('offline');
    const rows=mode==='empty'?[]:[{id:'x'}];
    if(url.endsWith('checkpoints'))return {checkpoints:rows};
    if(url.endsWith('sandbox-diff'))return {checkout:rows[0]||null,diff:{changes:rows}};
    if(url.endsWith('file-changes'))return {changes:rows};
    return {files:rows};
  };
  const env={api,artifactMap:buckets,records:[],scope:{},focusedRootId:'',workTaskGroups:()=>({rootOf:new Map([['child','root']])})};
  const refresh=await execute(section(work,'  const checkpointRequests','  const buildOverviewPayload')+
     "return ()=>Promise.all(['root','child'].map(loadArtifactsForTask));",env);
  await refresh();assert.equal(reads,1);
  mode='fail';await refresh();
  const b=buckets.get('root');assert.equal(b.changesByTask.get('child').length,1);assert.equal(b.checkpoints.length,1);
  assert.equal(b.sandboxByTask.size,2);assert(b.errors.size>0);
  mode='empty';await refresh();assert.equal(b.errors.size,0);assert.equal(b.checkpoints.length,0);
  assert.equal(b.sandboxByTask.size,0);assert.equal(b.changesByTask.get('child').length,0);assert.equal(reads,3);
});
