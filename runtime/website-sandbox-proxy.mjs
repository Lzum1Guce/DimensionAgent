// Inside the browser's private network namespace. Only Chromium connects here.
import http from 'node:http';
export async function browserProxy(send) {
  const streams=new Map();let next=0;
  const server=http.createServer((_req,res)=>res.writeHead(403).end());
  server.headersTimeout=6000;
  server.on('connect',(req,socket,head)=>{
    const match=/^([a-z0-9.-]{1,253}):443$/i.exec(req.url);
    if(!match||streams.size>=32||head.length){socket.destroy();return;}
    const id=++next;
    streams.set(id,socket);socket.pause();socket.setTimeout(60000,()=>socket.destroy());
    socket.on('error',()=>socket.destroy());
    socket.on('close',()=>{streams.delete(id);send({op:'end',id});});
    socket.on('data',buf=>{socket.pause();send({op:'bytes',id,data:buf.toString('base64')});});
    send({op:'connect',id,host:match[1]});
  });
  await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
  return {port:server.address().port,receive(m){
    const sock=streams.get(m.id);if(!sock)return;
    if(m.op==='ready'){sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');sock.resume();}
    else if(m.op==='ack')sock.resume();
    else if(m.op==='bytes')sock.write(Buffer.from(m.data,'base64'),()=>send({op:'ack',id:m.id}));
    else if(m.op==='end')sock.destroy();
  },close(){server.close();for(const s of streams.values())s.destroy();}};
}

