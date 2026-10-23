import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {pluginRequest} from '../desktop/plugin-request.mjs';
import {listenForFetch} from './helpers/http-listener.mjs';
async function server(t,handler){const value=http.createServer(handler);const port=await listenForFetch(value);t.after(()=>new Promise(resolve=>{value.close(resolve);value.closeAllConnections();}));return`http://127.0.0.1:${port}`;}
test('plugin HTTP returns exact binary and UTF-8 bytes without adding cloud credentials',async t=>{
 const url=await server(t,async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);assert.equal(req.headers.authorization,undefined);assert.equal(req.headers.cookie,undefined);res.setHeader('content-type','application/octet-stream');res.end(Buffer.concat(chunks));});
 const bytes=Buffer.from([0,255,1,128,10]);const result=await pluginRequest({url,method:'POST',body:bytes.toString('base64'),bodyEncoding:'base64'});
 assert.equal(result.status,200);assert.deepEqual(Buffer.from(result.bodyBase64,'base64'),bytes);
 const text=await pluginRequest({url,method:'POST',body:'中文\n',contentType:'text/plain'});assert.equal(text.text,'中文\n');
});
test('plugin request retains HTTP error status for the public throw option',async t=>{
 const url=await server(t,(_req,res)=>{res.writeHead(422,{'Content-Type':'application/json','x-test':'yes'});res.end('{"error":"fixture"}');});
 const result=await pluginRequest({url});assert.equal(result.status,422);assert.equal(result.headers['x-test'],'yes');assert.deepEqual(JSON.parse(result.text),{error:'fixture'});
});
test('cross-origin redirects strip credentials and POST 302 becomes a bodyless GET',async t=>{
 const destination=await server(t,(req,res)=>{res.end(JSON.stringify({method:req.method,authorization:req.headers.authorization||null,cookie:req.headers.cookie||null,type:req.headers['content-type']||null}));});
 const source=await server(t,(_req,res)=>{res.writeHead(302,{location:destination});res.end();});
 const result=await pluginRequest({url:source,method:'POST',body:'secret body',headers:{authorization:'test-only',cookie:'test-only'},contentType:'text/plain'});
 assert.deepEqual(JSON.parse(result.text),{method:'GET',authorization:null,cookie:null,type:null});
});
test('invalid schemes, body encodings and GET bodies are rejected before network',async()=>{
 for(const input of [{url:'file:///C:/private'},{url:'https://user:pass@example.test/'},{url:'http://127.0.0.1/',body:'x'},{url:'http://127.0.0.1/',method:'POST',body:'Zh==',bodyEncoding:'base64'},{url:'http://127.0.0.1/',headers:{'x-test':'a\r\nb'}}])await assert.rejects(pluginRequest(input));
});
test('response/body bounds and timeout terminate reads cleanly',async t=>{
 const large=await server(t,(_req,res)=>{res.write('123456');res.end('789');});await assert.rejects(pluginRequest({url:large},{maxBytes:4}),/limit/);
 await assert.rejects(pluginRequest({url:large,method:'POST',body:'12345'},{maxBytes:4}),/limit/);
 const stalled=await server(t,(_req,res)=>{res.writeHead(200);res.write('a');});await assert.rejects(pluginRequest({url:stalled},{timeoutMs:50}),error=>error.name==='AbortError');
});
