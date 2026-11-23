import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,access} from 'node:fs/promises';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'outputs','phase3-desktop-policy');
await mkdir(out,{recursive:true});const folder=await mkdtemp(path.join(out,'fixture-')),data=path.join(folder,'data');
const checks=[],processes=[],linuxHistory=[],tracked=new Map();let child,base,passed=false,failure=null;
const linuxPath=value=>'/mnt/'+value[0].toLowerCase()+value.slice(2).replaceAll('\\','/');
const inspectScript=path.join(folder,'process-snapshot.py');
await writeFile(inspectScript,`import os,sys,json,pathlib
marker=sys.argv[1]; previous=json.loads(sys.argv[2]); rows={}; roots=set()
own_namespace=os.readlink('/proc/self/ns/pid')
known={(int(p['pid']),p['starttime']) for p in previous}
namespaces={p['namespace'] for p in previous if p['namespace'] != own_namespace}
for name in os.listdir('/proc'):
 if not name.isdigit() or int(name)==os.getpid(): continue
 try:
  base='/proc/'+name
  stat=pathlib.Path(base+'/stat').read_text().rsplit(')',1)[1].split()
  argv=pathlib.Path(base+'/cmdline').read_bytes().decode('utf-8','replace').split('\\0')
  namespace=os.readlink(base+'/ns/pid')
  cgroup=pathlib.Path(base+'/cgroup').read_text()
  row={'pid':int(name),'ppid':int(stat[1]),'state':stat[0],'starttime':stat[19],'namespace':namespace,'cgroup':cgroup,'program':os.path.basename(argv[0])}
  rows[row['pid']]=row
  if row['program']=='bwrap' and any(marker in arg for arg in argv): roots.add(row['pid'])
 except (OSError,ValueError,IndexError): pass
while True:
 added={p['pid'] for p in rows.values() if p['ppid'] in roots}-roots
 if not added: break
 roots |= added
current=[p for p in rows.values() if p['pid'] in roots]
remaining=[p for p in rows.values() if (p['pid'],p['starttime']) in known or p['pid'] in roots or '/dimension-' in p['cgroup']]
print(json.dumps({'current':current,'remaining':remaining}))
`);
async function linuxSnapshot(label){
 const result=await promisify(execFile)('C:/Windows/System32/wsl.exe',['-d','dimension-sandbox','--exec','/usr/bin/python3',linuxPath(inspectScript),linuxPath(data),JSON.stringify([...tracked.values()])],{cwd:folder,windowsHide:true,maxBuffer:4*1024*1024});
 const value=JSON.parse(result.stdout);for(const p of value.current)tracked.set(p.pid+':'+p.starttime,p);
 linuxHistory.push({label,...value});return value;
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=25000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await delay(50);}throw Error('Timed out: '+label);}
async function start(){let output='';child=spawn(path.join(root,'outputs/build/DImensionagent-native.exe'),['--data',data,'--ui',path.join(root,'ui'),'--port','0','--wsl','C:/Windows/System32/wsl.exe','--sandbox-distro','dimension-sandbox','--desktop-helper',path.join(root,'outputs/linux/dimension-desktop-helper')],{cwd:folder,windowsHide:true,stdio:['pipe','pipe','pipe']});processes.push(child);child.stdout.on('data',b=>output+=b);child.stderr.resume();await until(()=>output.includes('\n'),'native ready');base='http://127.0.0.1:'+JSON.parse(output.split('\n')[0]).port;}
async function api(url,body,method=body?'POST':'GET',expected=200){const r=await fetch(base+url,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await r.json();assert.equal(r.status,expected,JSON.stringify(value).slice(0,1500));return value;}
const url=bot=>'/api/dimension/work/desktops/'+bot;
const act=(bot,action,extra={},expected=200)=>api(url(bot)+'/action',{action,...extra},'POST',expected);
async function probeReport(state,count){return until(async()=>{
 try{const value=JSON.parse(await readFile(path.join(state.workspace,'namespace-report.json'),'utf8'));return value.count===count&&value;}
 catch{return false;}
},'launched software finishes its namespace probe',6000);}
async function close(){if(child&&child.exitCode===null){child.stdin.end('shutdown\n');await until(()=>child.exitCode!==null,'native shutdown',12000);}}
const script=`import os,json,pathlib,tempfile
home=pathlib.Path('/home/bot'); marker=home/'native-policy-marker'
count=int(marker.read_text())+1 if marker.exists() else 1
marker.write_text(str(count))
routes=pathlib.Path('/proc/net/route').read_text()
report={'uid':os.getuid(),'home':str(home),'count':count,'hostMountVisible':pathlib.Path('/mnt/c').exists() or pathlib.Path('/mnt/l').exists(),'shadowVisible':pathlib.Path('/etc/shadow').exists(),'defaultRoute':any(line.split()[1]=='00000000' for line in routes.splitlines()[1:] if len(line.split())>1),'resolverAvailable':pathlib.Path('/etc/resolv.conf').is_file() and pathlib.Path('/etc/resolv.conf').stat().st_size>0,'temporary':tempfile.gettempdir()}
pathlib.Path('/workspace/namespace-report.json').write_text(json.dumps(report))
`;
try{
 await start();
 const info=await api('/api/native/info');assert.equal(info.phase,3);assert.equal(info.stageStatus,'native-ready');
 assert.equal(info.desktopConfigured,true);assert(info.capabilities.includes('linux-desktop'));
 assert(info.capabilities.includes('desktop-agent-tools'));assert(info.capabilities.includes('application-services'));assert(!info.pending.includes('application-services'));
 assert.equal(info.automaticDataMigration,false);
 checks.push('Native capability metadata distinguishes desktop tools from pending application services');
 const a='desktop-policy-a',b='desktop-policy-b';
 for(const id of [a,b])await api('/api/dimension/bots',{id,name:'Synthetic '+id});
 const states=await Promise.all([a,b].map(id=>api(url(id))));
 assert.notEqual(states[0].workspace,states[1].workspace);
 for(const state of states){assert.equal(state.available,true);assert.equal(state.running,false);assert(state.workspace.startsWith(data+path.sep));await writeFile(path.join(state.workspace,'namespace-probe.py'),script);}
 await api('/api/dimension/work/software',{apps:[{id:'namespace-probe',name:'Synthetic namespace check',executable:'/usr/bin/python3',args:['/workspace/namespace-probe.py']}]},'PUT');
 for(const id of [a,b])await api('/api/dimension/work/settings',{botId:id,networkAccess:false},'PATCH');
 const first=await act(a,{op:'launch',appId:'namespace-probe'});
 const png=Buffer.from(first.png,'base64');assert.equal(png.subarray(1,4).toString(),'PNG');assert.equal(png.readUInt32BE(16),1280);assert.equal(png.readUInt32BE(20),800);
 const firstReport=await probeReport(states[0],1);
 assert.equal(firstReport.uid,1000);assert.equal(firstReport.hostMountVisible,false);assert.equal(firstReport.shadowVisible,false);assert.equal(firstReport.defaultRoute,false);assert.equal(firstReport.resolverAvailable,true);assert.equal(firstReport.temporary,'/tmp');assert.equal(firstReport.count,1);
 checks.push('Real Linux namespace has its own home, tmp, PID/network namespace and only explicit workspace mounts');
 const prior=(await api('/api/dimension/work/settings?botId='+a)).settings;
 await api('/api/dimension/work/settings',{botId:a,networkAccess:true,approvalMode:'invalid'},'PATCH',400);
 assert.equal((await api(url(a))).running,true);assert.deepEqual((await api('/api/dimension/work/settings?botId='+a)).settings,prior);
 checks.push('Invalid mixed settings are rejected before any desktop stop or runtime change');
 const registryBefore=await api('/api/dimension/work/software');
 const large=Array.from({length:6},(_,i)=>({id:'large-'+i,name:'Synthetic boundary',executable:'/usr/bin/true',args:Array.from({length:100},()=> 'x'.repeat(8192))}));
 let excess=JSON.stringify({apps:large}).length-(4*1024*1024-4);
 for(let app=large.length-1;app>=0&&excess>0;app--)for(let i=99;i>=0&&excess>0;i--){const remove=Math.min(excess,large[app].args[i].length);large[app].args[i]=large[app].args[i].slice(remove);excess-=remove;}
 assert.equal(JSON.stringify({apps:large}).length,4*1024*1024-4);
 await api('/api/dimension/work/software',{apps:large},'PUT',400);assert.deepEqual(await api('/api/dimension/work/software'),registryBefore);
 checks.push('An HTTP-sized registry that would exceed persisted state limits is rejected without poisoning restart');
 const overflowStarted=Date.now();
 await act(a,{op:'type',text:'x'.repeat(300*1024),observationId:first.observationId},{},400);
 assert(Date.now()-overflowStarted<5000);assert.equal((await api(url(a))).running,true);
 checks.push('Over-limit helper input is rejected immediately and leaves the desktop usable');
 await api(url(a)+'/control',{human:false});
 await act(a,{op:'press',key:'F1',observationId:first.observationId},{},400);
 await api(url(a)+'/control',{human:true});
 await act(a,{op:'press',key:'F1',observationId:first.observationId},{},400);
 const observed=await act(a,{op:'observe'});
 await act(a,{op:'press',key:'F1',observationId:observed.observationId});
 await act(a,{op:'press',key:'F1',observationId:observed.observationId},{},400);
 checks.push('Human takeover and current observation are required for manual input; old observations cannot replay actions');
 const registry=await api('/api/dimension/work/software');
 await api('/api/dimension/work/software',{apps:[...registry.apps,{id:'tmpfs-quota',name:'Synthetic combined tmpfs quota',executable:'/usr/bin/python3',args:['-c',`import pathlib,json
result={'limited':False}
try:
 for name in ['/tmp/a','/run/user/1000/b','/dev/shm/c']:
  pathlib.Path(name).write_bytes(b'x'*7*1024**2)
except OSError as error:
 result={'limited':error.errno==28,'errno':error.errno}
pathlib.Path('/workspace/tmpfs-quota.json').write_text(json.dumps(result))
`]}]},'PUT');
 await act(a,{op:'launch',appId:'tmpfs-quota'});
 const quota=await until(async()=>{try{return JSON.parse(await readFile(path.join(states[0].workspace,'tmpfs-quota.json'),'utf8'));}catch{return false;}},'combined desktop tmpfs quota',6000);
 assert.equal(quota.limited,true);assert.equal(quota.errno,28);
 checks.push('Tmp, runtime and shared memory writes fail with ENOSPC when their combined 16 MiB hard quota is exhausted');
 const beforeStop=(await api(url(a))).desktopId;await api(url(a)+'/stop',{});
 const second=await act(a,{op:'launch',appId:'namespace-probe'});assert.notEqual(second.desktopId,beforeStop);
 await act(a,{op:'press',key:'F1',observationId:observed.observationId},{fastInput:true},400);
 assert.equal((await probeReport(states[0],2)).count,2);
 await act(b,{op:'launch',appId:'namespace-probe'});
 assert.equal((await probeReport(states[1],1)).count,1);
 checks.push('Restart preserves each Bot home, rejects old session input, and keeps other Bot homes independent');
 await api('/api/dimension/work/settings',{botId:a,networkAccess:true},'PATCH',400);assert.equal((await api(url(a))).running,true);
 assert.equal((await api(url(b))).running,true);
 assert((await linuxSnapshot('before-graceful-shutdown')).current.length>0);
 await close();await start();
 await until(async()=>!(await linuxSnapshot('after-graceful-shutdown')).remaining.length,'Linux graceful cleanup',12000);
 assert.equal((await api(url(a))).running,false);assert.equal((await api(url(b))).running,false);
 assert.equal((await api('/api/dimension/work/settings?botId='+a)).settings.networkAccess,false);
 assert.equal((await api('/api/dimension/work/settings?botId='+b)).settings.networkAccess,false);
 assert.equal((await api('/api/dimension/work/software')).apps[0].id,'namespace-probe');
 checks.push('Shared-network enable is rejected without stopping a desktop; backend restart preserves loopback-only policy without relaunching apps');
 await Promise.all([a,b].map(id=>act(id,{op:'launch',appId:'namespace-probe'})));
 const beforeCrash=await linuxSnapshot('before-abrupt-native-exit');
 assert(beforeCrash.current.filter(p=>p.program==='Xvfb').length===2);
 const crashed=child;crashed.kill();await until(()=>crashed.exitCode!==null||crashed.signalCode!==null,'abrupt native exit',6000);
 child=null;
 await until(async()=>!(await linuxSnapshot('after-abrupt-native-exit')).remaining.length,'Linux crash cleanup',12000);
 checks.push('Abrupt native process termination removes both Linux desktop namespaces and all tracked descendants, including Xvfb and the window managers');
 passed=true;
}catch(error){failure=error.stack;throw error;}finally{
 await close().catch(()=>{child?.kill();});
 const remaining=(await linuxSnapshot('final')).remaining;
 const fingerprints={};for(const [key,file] of Object.entries({native:'outputs/build/DImensionagent-native.exe',helper:'outputs/linux/dimension-desktop-helper'}))fingerprints[key]=createHash('sha256').update(await readFile(path.join(root,file))).digest('hex');
 const report={passed:passed&&remaining.length===0,failure,checks,remainingLinuxProcesses:remaining,linuxHistory,windowsProcessExitCodes:processes.map(p=>({exitCode:p.exitCode,signal:p.signalCode})),fingerprints,fixture:folder,productionDataUsed:false,realAccountsUsed:false};
 const serialized=JSON.stringify(report,null,2);await writeFile(path.join(folder,'result.json'),serialized);await writeFile(path.join(out,'result.json'),serialized);
 console.log(JSON.stringify({passed:report.passed,checks:checks.length,remainingLinuxProcesses:remaining.length,fingerprints,report:path.join(out,'result.json')}));
 assert.equal(remaining.length,0);
}
