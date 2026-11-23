// Windows side. Resolve locally and pin the destination IP even when using the system proxy.
import {lookup} from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {networkInterfaces} from 'node:os';
const exec=promisify(execFile), cache=new Map();
const policy=new net.BlockList();
for(const [base,width] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]])policy.addSubnet(base,width);
export function publicAddress(ip){
  if(!net.isIPv4(ip)||policy.check(ip))return false;
  const lan=new net.BlockList();
  for(const n of Object.values(networkInterfaces()).flat()){
    if(n?.family==='IPv4'&&n.cidr)lan.addSubnet(n.address,Number(n.cidr.split('/')[1]));
  }
  return !lan.check(ip);
}
async function resolveProxy(host){
  const script="$ErrorActionPreference='Stop';$u=[uri]('https://'+$env:DIMENSION_WEB_HOST+'/');$p=[Net.WebRequest]::GetSystemWebProxy();if(!$p.IsBypassed($u)){$p.GetProxy($u).AbsoluteUri}";
  const {stdout}=await exec(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:6000,env:{...process.env,DIMENSION_WEB_HOST:host}});
  const value=stdout.trim()?new URL(stdout.trim()):null;
  if(value && (!['http:','https:'].includes(value.protocol)||value.username||value.password))throw Error('unsupported proxy');
  return value;
}
// Chromium opens many connections at once. Share route lookups and limit Windows helper processes.
const queue=[], resolving=new Map();let active=0;
function pump(){
  while(active<2&&queue.length){
    const {host,resolve,reject}=queue.shift();active++;
    resolveProxy(host).then(value=>{
      if(cache.size>=128)cache.delete(cache.keys().next().value);
      cache.set(host,{until:Date.now()+30000,value});resolve(value);
    },reject).finally(()=>{active--;resolving.delete(host);pump();});
  }
}
function systemProxy(host){
  const old=cache.get(host);
  if(old&&old.until>Date.now())return old.value;
  if(resolving.has(host))return resolving.get(host);
  const next=new Promise((resolve,reject)=>queue.push({host,resolve,reject}));
  resolving.set(host,next);pump();return next;
}
export function egress(send){
  const streams=new Map();
  function end(id){const e=streams.get(id);if(!e)return;streams.delete(id);e.req?.destroy();e.sock?.destroy();send({op:'end',id});}
  async function connect(id,host){
    if(typeof host!=='string'||host.length>253||!/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(host)||/\.(localhost|local|lan|internal|home|arpa)$/i.test(host)||streams.size>=32||streams.has(id)){send({op:'end',id});return;}
    const entry={};streams.set(id,entry);
    try{
      const ips=await lookup(host,{all:true,family:4});
      if(!ips.length||!ips.every(a=>publicAddress(a.address)))throw Error('not public');
      const proxy=await systemProxy(host);
      if(streams.get(id)!==entry)return;
      function ready(sock){
        if(streams.get(id)!==entry){sock.destroy();return;}
        entry.sock=sock;sock.setTimeout(60000,()=>end(id));
        sock.on('close',()=>end(id));sock.on('error',()=>end(id));
        send({op:'ready',id});
        sock.on('data',buf=>{sock.pause();send({op:'bytes',id,data:buf.toString('base64')});});
      }
      const ip=ips[0].address;
      if(!proxy){
        const sock=net.connect({host:ip,port:443,timeout:8000},()=>ready(sock));
        entry.sock=sock;sock.on('error',()=>end(id));sock.once('timeout',()=>end(id));return;
      }
      const transport=proxy.protocol==='https:'?https:http;
      const req=transport.request({hostname:proxy.hostname,port:proxy.port||(proxy.protocol==='https:'?443:80),
        method:'CONNECT',path:ip+':443',headers:{Host:ip+':443'},agent:false});
      entry.req=req;req.setTimeout(8000,()=>end(id));req.once('error',()=>end(id));
      req.once('connect',(res,sock,head)=>{if(res.statusCode!==200||head.length){sock.destroy();end(id);}else ready(sock);});
      req.end();
    }catch{end(id);}
  }
  return {receive(m){
    if(!Number.isSafeInteger(m.id)||m.id<1)return;
    if(m.op==='connect'){void connect(m.id,m.host);return;}
    const sock=streams.get(m.id)?.sock;
    if(m.op==='end')end(m.id);
    else if(m.op==='ack')sock?.resume();
    else if(m.op==='bytes'&&sock&&typeof m.data==='string'&&m.data.length<=131072)
      sock.write(Buffer.from(m.data,'base64'),()=>send({op:'ack',id:m.id}));
  },close(){for(const id of [...streams.keys()])end(id);}};
}

