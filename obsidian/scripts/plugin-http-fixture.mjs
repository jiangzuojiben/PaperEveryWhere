import http from 'node:http';
const server=http.createServer((req,res)=>{
  if(req.url==='/json'){res.setHeader('content-type','application/json');res.end(JSON.stringify({fixture:'synthetic-only',value:7}));}
  else if(req.url==='/text')res.end('SYNTHETIC-HTTP-OK');
  else{res.statusCode=404;res.end('synthetic missing');}
});
server.listen(28773,'127.0.0.1',()=>console.log('Synthetic plugin HTTP fixture: 127.0.0.1:28773'));
for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>server.close());
