import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, mkdtemp, readFile, stat, writeFile} from 'node:fs/promises';
import {startNative, until, delay} from './archive-export-api.mjs';

const [executable, ui, root] = process.argv.slice(2);
await mkdir(root, {recursive:true});
const output = await mkdtemp(path.join(root, 'canvas-'));
const cwd = path.join(output, '中文 工作区');
await mkdir(cwd);
await mkdir(path.join(output, 'temp'));
const app = await startNative({label:'canvas', executable, ui, output, data:path.join(output, 'data')});
const runs = '/api/dimension/canvas/runs';
async function start(id, commands) {
    const nodes = commands.map((command,i) => ({id:'n'+i, type:'action', actionKind:'run_command', actionTarget:command}));
    const edges = nodes.slice(1).map((node,i) => ({id:'e'+i, fromNodeId:nodes[i].id, targetKind:'node', targetId:node.id}));
    await app.api('/api/dimension/canvas/save', {id,name:id,kind:'canvas',nodes,edges});
    return runs+'/'+(await app.api(runs,{canvasId:id,inputText:'test',workspaceDir:cwd})).run.runId;
}
const finished = url => until(async () => {
    const {run} = await app.api(url);
    return ['completed','failed','cancelled'].includes(run.status) && run;
}, 'canvas finished');
try {
    const ok = await finished(await start('cwd-check',['cd & echo 中文输出 & echo ok>relative.txt']));
    assert.equal(ok.status,'completed');
    assert(ok.nodes.n0.output.includes(cwd));
    assert(ok.nodes.n0.output.includes('中文输出'));
    assert.equal((await readFile(path.join(cwd,'relative.txt'),'utf8')).trim(),'ok');
    await writeFile(path.join(cwd,'large.txt'), '甲'.repeat(50000));
    const large = await finished(await start('output-limit',['type large.txt']));
    assert.equal(large.status,'completed');
    assert.match(large.nodes.n0.output,/甲{1000}/);
    assert.match(large.nodes.n0.output,/已截断/);
    assert(Buffer.byteLength(large.nodes.n0.output) < 16500);
    const failed = await finished(await start('exit-check',['echo diagnostic & exit /b 7','echo wrong>unexpected.txt']));
    assert.equal(failed.status,'failed');
    assert.match(failed.nodes.n0.error,/退出码 7/);
    assert.match(failed.nodes.n0.output,/diagnostic/);
    assert.equal(failed.nodes.n1.iteration,0);
    await assert.rejects(stat(path.join(cwd,'unexpected.txt')),{code:'ENOENT'});
    await writeFile(path.join(cwd,'child.cmd'),'@echo off\r\necho ready>started.txt\r\nping -n 4 127.0.0.1 >nul\r\necho late>late.txt\r\n');
    const url = await start('cancel-check',['cmd /d /c child.cmd']);
    await until(()=>stat(path.join(cwd,'started.txt')),'child ready');
    await app.api(url+'/cancel',{});
    assert.equal((await finished(url)).status,'cancelled');
    await delay(3500);
    await assert.rejects(stat(path.join(cwd,'late.txt')),{code:'ENOENT'});
    console.log('PASS cwd, Chinese output, failure diagnostics, downstream blocking and process tree cancellation');
} finally {await app.stop();}
