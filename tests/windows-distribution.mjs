import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, mkdtemp, readFile} from 'node:fs/promises';
import {startNative} from './archive-export-api.mjs';

const [installed, work] = process.argv.slice(2);
assert(path.isAbsolute(installed) && path.isAbsolute(work));
const config=JSON.parse(await readFile(path.join(installed,'native-client.json'),'utf8'));
const output=await mkdtemp(path.join(work,'first-start-'));
await mkdir(path.join(output,'temp'));
const ids='claude deepseek gemini glm gpt grok kimi qwen'.split(' ').map(name=>'ai-'+name).sort();
const app=await startNative({label:'installed-client',executable:path.join(installed,config.backend),
  ui:path.join(installed,config.ui),output,data:path.join(output,'clean-data')});
try {
  const boot=await app.api('/api/dimension/bootstrap');
  assert.deepEqual(boot.bots.map(b=>b.id).sort(),ids);
  assert.deepEqual(await app.api('/api/providers'),[]);
  assert.equal(boot.model.ready,false);
  for(const id of ids){
    for(const mode of ['chat','work']){
      const history=await app.api('/api/dimension/bots/'+id+'/history?mode='+mode);
      assert.deepEqual(history.messages,[]);
    }
  }
  const {groups}=await app.api('/api/dimension/groups');
  assert.equal(groups.length,1);
  assert.equal(groups[0].id,'grp-ai-chan-party');
  assert.deepEqual([...groups[0].members].sort(),ids);
  const groupHistory=await app.api('/api/dimension/groups/grp-ai-chan-party?mode=discuss');
  assert.deepEqual(groupHistory.messages,[]);
  console.log('PASS eight factory roles, one factory group, empty Chat/Work histories, empty group history and zero providers');
} finally {await app.stop();}
