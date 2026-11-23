// Native group submission, archive ownership and the release plugin worker.
// node tests/recovery-integration.mjs <release-directory> <fresh-output-root>
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { policies, startNative, until } from './archive-export-api.mjs';
import { startFixture } from './app-integration.mjs';

const release = path.resolve(process.argv[2]), root = path.resolve(process.argv[3]);
await mkdir(root, {recursive:true});
const output = await mkdtemp(path.join(root, 'recovery-'));
await mkdir(path.join(output,'temp'));
const fixture = await startFixture();
const apps = [];
async function open(label) {
  const app = await startNative({label, output, data:path.join(output,label),
    executable:path.join(release,'native/DImensionagent-native.exe'), ui:path.join(release,'ui')});
  apps.push(app); return app;
}
try {
  const source = await open('source'), botId = 'recovery-bot';
  await source.api('/api/dimension/bots',{id:botId,name:'测试伙伴',persona:'回归测试'});
  await source.api('/api/dimension/bots/'+botId+'/roster',{mode:'work',present:true},'PATCH');
  await source.api('/api/dimension/work/settings',{botId,cliEngine:'builtin'},'PATCH');
  await source.api('/api/providers/recovery/save',{name:'recovery',entry:{kind:'openai-chat-compat',baseUrl:fixture.baseUrl,spec:{model:'fixture-flash'}},secretValue:'synthetic-key'});
  await source.api('/api/providers/recovery/activate',{});
  await source.api('/api/dimension/bots/'+botId+'/conversation-model',{modelSelection:{providerId:'recovery',model:'fixture-flash'}});
  const {group} = await source.api('/api/dimension/groups',{name:'回归茶会',ownerId:botId,members:[botId]});
  const send = async (mode, requestId, text) => {
    const r=await source.response('/api/dimension/groups/'+group.id+'/say',{mode,requestId,text,workBotId:botId});
    assert.equal(r.status,200);
    return r.text.split('\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5)));
  };
  const line='APPTEST:group_chat';
  const chat=await send('discuss','chat',line);
  assert(chat.some(e=>e.kind==='say'&&e.from===botId),JSON.stringify(chat));
  const submit=async id=>(await send('work',id,'APPTEST:recovery_repeat')).find(e=>e.kind==='run').runId;
  const first=await submit('first');
  assert.equal(await submit('first'),first);
  const terminal=async id=>until(async()=>{
    const r=await source.api('/api/dimension/work/runs/'+id);
    return r.terminal&&!r.executing?r:null;
  },'terminal task',30000);
  assert.equal((await terminal(first)).status,'completed');
  fixture.gate('recovery_repeat');
  const next=await submit('second');
  assert.notEqual(next,first);
  await source.api('/api/dimension/work/runs/'+next+'/cancel',{});
  assert.equal((await terminal(next)).status,'cancelled');
  console.log('PASS native group chat, accepted retry, independent repeated submission and cancellation');

  const archive=await source.api('/api/native/archive/export',{});
  const target=await open('restored');
  const staged=await target.api('/api/native/archive/package/stage',{policies,package:archive});
  assert(staged.report.canCommit);
  await target.api('/api/native/archive/commit',{token:staged.token});
  const restored=await target.api('/api/dimension/groups/'+group.id+'?limit=100&mode=discuss');
  assert(restored.messages.some(row=>row.from==='user'&&row.text===line));
  assert(restored.messages.some(row=>row.from===botId));
  assert.equal((await target.api('/api/dimension/work/sessions?botId='+botId)).runs.length,0);
  console.log('PASS archive restores group history and respects work-run exclusions');

  const {handleRequest}=await import(pathToFileURL(path.join(release,'runtime/plugin-host.mjs')));
  const local=path.join(output,'fixture-plugin');
  await mkdir(path.join(local,'skills/example'),{recursive:true});
  await writeFile(path.join(local,'package.json'),JSON.stringify({name:'fixture-recovery',version:'1.0.0',license:'MIT',dsh:{bundle:{patch:['bundle.yml']}}}));
  await writeFile(path.join(local,'bundle.yml'),'[]');
  await writeFile(path.join(local,'skills/example/SKILL.md'),'---\nname: example\ndescription: Local test skill\n---\nSynthetic test.\n');
  const call=async(action,args={})=>{
    const result=await handleRequest({dataDir:path.join(output,'plugin-data'),action,...args});
    assert(result.ok,JSON.stringify(result.error));return result;
  };
  const installed=await call('package.install',{path:local});
  const pluginId=installed.plugin.id;
  await call('plugin.enable',{pluginId});assert((await call('plugin.list')).plugins.some(p=>p.id===pluginId&&p.enabled));
  await call('plugin.disable',{pluginId});await call('plugin.remove',{pluginId});
  assert(!(await call('plugin.list')).plugins.some(p=>p.id===pluginId));
  console.log('PASS installed runtime plugin install, enable, list, disable and remove');
} finally {
  await fixture.close();
  for (const app of apps.reverse()) await app.stop();
}
