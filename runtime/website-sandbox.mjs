// One supervised WSL namespace per role. Only trusted installation paths enter the launch argv.
import {spawn} from 'node:child_process';
import {randomInt} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
import {createInterface} from 'node:readline';
import {egress} from './website-egress.mjs';
const [wsl,distro,supervisor]=process.argv.slice(2);
const sessions=new Map(),base=dirname(fileURLToPath(import.meta.url));
function linuxPath(path){
  if(!/^[A-Za-z]:[\\/]/.test(path))throw Error('安装路径需要本地驱动器');
  return '/mnt/'+path[0].toLowerCase()+path.slice(2).replaceAll('\\','/');
}
function start(bot){
  if(!wsl||!distro||!supervisor||sessions.size>=8)throw Error('角色网站沙盒未配置或已满');
  const args=['-d',distro,'-u','root','--exec',linuxPath(supervisor),'dimension-'+process.pid+'-'+randomInt(1e9),
    '2147483648','200000','100000','512','/usr/bin/setpriv','--reuid=1000','--regid=1000','--clear-groups','/usr/bin/bwrap','--unshare-all','--die-with-parent','--new-session',
    '--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64',
    '--ro-bind','/opt/google/chrome','/opt/google/chrome','--proc','/proc','--dev','/dev',
    '--size','268435456','--tmpfs','/tmp','--size','134217728','--tmpfs','/dev/shm','--dir','/tmp/home','--dir','/tmp/run',
    '--ro-bind','/mnt/wslg/runtime-dir/wayland-0','/tmp/run/wayland-0'];
  for(const f of ['fonts','ssl','ld.so.cache','passwd','group','nsswitch.conf','localtime'])args.push('--ro-bind-try','/etc/'+f,'/etc/'+f);
  for(const f of ['website-guide.mjs','website-sandbox-proxy.mjs'])args.push('--ro-bind',linuxPath(join(base,f)),'/app/'+f);
  args.push('--uid','1000','--gid','1000','--cap-drop','ALL','--clearenv','--setenv','PATH','/usr/bin:/bin',
    '--setenv','HOME','/tmp','--setenv','XDG_RUNTIME_DIR','/tmp','--setenv','WAYLAND_DISPLAY','/tmp/run/wayland-0',
    '--setenv','LANG','C.UTF-8','--chdir','/tmp','/usr/bin/node','/app/website-guide.mjs');
  const child=spawn(wsl,args,{stdio:['pipe','pipe','ignore'],windowsHide:true});
  const pending=new Map();
  const write=m=>{if(!child.stdin.destroyed&&!child.stdin.writableEnded)child.stdin.write(JSON.stringify(m)+'\n');};
  const proxy=egress(m=>write({network:m}));
  const session={child,send(req){pending.set(req.id,req.action);write(req);}};
  sessions.set(bot,session);
  function finish(){
    if(sessions.get(bot)===session)sessions.delete(bot);
    proxy.close();
    for(const id of pending.keys())reply({id,error:'角色沙盒已退出，请确认 WSL、Chrome 和 WSLg 可用'});
    pending.clear();
  }
  child.stdin.on('error',()=>{});child.once('error',finish);child.once('close',finish);
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{
    try{
      const m=JSON.parse(line);
      if(m.network){proxy.receive(m.network);return;}
      if(pending.get(m.id)==='close'){
        if(sessions.get(bot)===session)sessions.delete(bot);
        child.stdin.end();
      }
      if(pending.delete(m.id))reply(m);
    }catch{child.stdin.end();}
  });
  return session;
}
function reply(m){process.stdout.write(JSON.stringify(m)+'\n');}
const input=createInterface({input:process.stdin});
input.on('line',line=>{
  const req=JSON.parse(line);
  try{
    let s=sessions.get(req.bot);
    if(!s){
      if(req.action==='close'){reply({id:req.id,result:{closed:true}});return;}
      if(!['open','search'].includes(req.action))throw Error('当前角色尚未打开沙盒网站');
      s=start(req.bot);
    }
    s.send(req);
  }catch(e){reply({id:req.id,error:e.message});}
});
input.on('close',()=>{for(const {child} of sessions.values())child.stdin.end();});

