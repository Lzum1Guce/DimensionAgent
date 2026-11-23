import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { startDesktop } from './linux-desktop.test.mjs';

const project=path.resolve(import.meta.dirname,'..');
const output=path.resolve(process.argv[2]||path.join(project,'outputs/phase3-applications/linux-downloads',new Date().toISOString().replace(/[:.]/g,'-')));
const binary=path.resolve(process.argv[3]||path.join(project,'outputs/linux/dimension-desktop-helper-apps'));
assert(/^[lL]:[\\/]/.test(output));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const checks=[];let desktop,exit;
const pass=name=>{checks.push({name,ok:true});console.log('PASS '+name);};
function greenButton(base64){
 const bytes=Buffer.from(base64,'base64');let width,channels;const chunks=[];
 for(let at=8;at+12<=bytes.length;){const size=bytes.readUInt32BE(at),kind=bytes.toString('ascii',at+4,at+8),data=bytes.subarray(at+8,at+8+size);
  if(kind==='IHDR'){width=data.readUInt32BE(0);channels=({2:3,6:4})[data[9]];assert.equal(data[8],8);}
  if(kind==='IDAT')chunks.push(data);at+=size+12;if(kind==='IEND')break;}
 assert(width&&channels);const stride=width*channels,raw=inflateSync(Buffer.concat(chunks),{maxOutputLength:8*1024*1024});
 let previous=Buffer.alloc(stride);
 for(let y=0;y<=250;y++){const row=Buffer.alloc(stride),filter=raw[y*(stride+1)];
  for(let x=0;x<stride;x++){const a=x>=channels?row[x-channels]:0,b=previous[x],c=x>=channels?previous[x-channels]:0;
   let estimate=0;if(filter===1)estimate=a;else if(filter===2)estimate=b;else if(filter===3)estimate=Math.floor((a+b)/2);else if(filter===4){const p=a+b-c,da=Math.abs(p-a),db=Math.abs(p-b),dc=Math.abs(p-c);estimate=da<=db&&da<=dc?a:db<=dc?b:c;}else assert.equal(filter,0);
   row[x]=(raw[y*(stride+1)+1+x]+estimate)&255;}
  previous=row;
 }
 const at=200*channels;return previous[at]<10&&previous[at+1]>120&&previous[at+1]<150&&previous[at+2]>50&&previous[at+2]<85;
}
async function until(fn,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await delay(100);}throw Error('Timed out waiting for actual Chrome state');}
await mkdir(output,{recursive:true});
try{
 desktop=await startDesktop(path.join(output,'desktop'),binary);
 const initial=await desktop.request('downloads');assert(initial.ok);assert.deepEqual(initial.result.files,[]);pass('Fresh sandbox has no fabricated browser downloads');
 const html='<!doctype html><meta charset="utf-8"><title>download-ready</title><style>body{margin:0;background:#eee}button{position:absolute;left:20px;top:60px;width:700px;height:400px;background:#008844;color:white;font-size:40px}</style><button autofocus>Download original fixture PNG</button><script>document.querySelector("button").onclick=()=>{const bytes=Uint8Array.from(atob("'+png.toString('base64')+'"),c=>c.charCodeAt(0));const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([bytes],{type:"image/png"}));a.download="fixture-output.png";document.body.append(a);a.click();document.title="download-issued";};</script>';
 await writeFile(path.join(desktop.workspace,'download.html'),html);
 const launched=await desktop.request('launch',{executable:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--disable-background-networking','--user-data-dir=/home/bot/chrome','--window-size=1200,760','--window-position=0,0','--app=file:///workspace/download.html']});
 assert(launched.ok,JSON.stringify(launched));
 await until(async()=>{const shot=await desktop.request('observe');return shot.ok&&shot.result.windowTitle?.includes('download-ready')&&greenButton(shot.result.png);},45000);
 const before=await desktop.request('observe');await writeFile(path.join(output,'before-download.png'),Buffer.from(before.result.png,'base64'));
 assert((await desktop.request('click',{x:200,y:250,button:'left'})).ok);
 await until(async()=>{const shot=await desktop.request('observe');return shot.ok&&shot.result.windowTitle?.includes('download-issued');},10000);
 const found=await until(async()=>{const list=await desktop.request('downloads');assert(list.ok,JSON.stringify(list));return list.result.files.find(f=>f.name==='fixture-output.png');});
 assert.equal(found.bytes,png.length);assert(found.snapshot);pass('Real Chrome click creates a regular PNG in private Downloads');
 const read=await desktop.request('download_read',{name:found.name,snapshot:found.snapshot,offset:0});assert(read.ok,JSON.stringify(read));
 assert.equal(read.result.offset,0);assert.equal(read.result.total,png.length);assert.equal(read.result.eof,true);
 const actual=Buffer.from(read.result.data,'base64');assert.deepEqual(actual,png);
 await writeFile(path.join(output,'actual-browser-download.png'),actual);
 pass('Bound snapshot reads the exact original downloaded bytes without a screenshot');
 const shot=await desktop.request('observe');assert(shot.ok);await writeFile(path.join(output,'download-screen.png'),Buffer.from(shot.result.png,'base64'));
 for(const name of ['../fixture-output.png','/etc/passwd','a\\b.png','.hidden.png']){
   const rejected=await desktop.request('download_read',{name,snapshot:found.snapshot,offset:0});assert.equal(rejected.ok,false);
 }
 pass('Path traversal, absolute paths and hidden names cannot escape Downloads');
 await writeFile(path.join(desktop.home,'Downloads','fixture-output.png'),Buffer.concat([png,Buffer.from('changed')]));
 assert.equal((await desktop.request('download_read',{name:found.name,snapshot:found.snapshot,offset:0})).ok,false);
 pass('A stale snapshot cannot read a changed file');
 await writeFile(path.join(desktop.home,'Downloads','unfinished.png.crdownload'),png);
 await writeFile(path.join(desktop.home,'Downloads','too-large.png'),Buffer.alloc(16*1024*1024+1));
 assert((await desktop.request('launch',{executable:'/usr/bin/python3',args:['-c',"import os;os.symlink('/etc/passwd','/home/bot/Downloads/link.png')"]})).ok);
 await delay(200);
 const filtered=await desktop.request('downloads');assert(filtered.ok);
 assert(filtered.result.files.every(f=>!['unfinished.png.crdownload','too-large.png','link.png'].includes(f.name)));
 pass('Unfinished, oversized and symlink files are excluded from completed downloads');
 exit=await desktop.close();assert.equal(exit.code,0);
 const processTree=JSON.parse(await readFile(desktop.processTreePath,'utf8'));assert.deepEqual(processTree.remaining,[]);
 pass('Helper and Chrome descendants exit without residual processes');
 await writeFile(path.join(output,'result.json'),JSON.stringify({ok:true,checks,exit,binarySha256:createHash('sha256').update(await readFile(binary)).digest('hex')},null,2));
}catch(error){
 if(desktop&&desktop.child.exitCode===null){try{const shot=await desktop.request('observe');if(shot.ok)await writeFile(path.join(output,'failure.png'),Buffer.from(shot.result.png,'base64'));}catch{}}
 await writeFile(path.join(output,'result.json'),JSON.stringify({ok:false,checks,error:error.stack},null,2));throw error;
}finally{if(desktop&&desktop.child.exitCode===null)await desktop.close(true);}
