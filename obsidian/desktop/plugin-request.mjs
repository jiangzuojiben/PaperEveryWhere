const MAX_BYTES=32*1024*1024;
const validUrl=value=>{
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Plugin requests require HTTP/HTTPS without URL credentials');
  return url;
};
export async function pluginRequest(input,{timeoutMs=30000,maxBytes=MAX_BYTES}={}){
  if(!input||typeof input.url!=='string')throw Error('Expected a plugin request URL');
  let url=validUrl(input.url),method=String(input.method||'GET').toUpperCase();
  if(!/^[A-Z]+$/.test(method))throw Error('Invalid HTTP method');
  const headers=new Headers();
  for(const [name,value]of Object.entries(input.headers||{})){
    if(typeof value!=='string'||/[\r\n]/.test(name+value))throw Error('Invalid request header');
    headers.set(name,value);
  }
  if(input.contentType&&!headers.has('content-type'))headers.set('content-type',input.contentType);
  let body;
  if(input.body!==undefined){
    if(typeof input.body!=='string')throw Error('The request body must be serialized text or base64');
    if(input.bodyEncoding==='base64'){
      if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.body))throw Error('Invalid request body base64');
      body=Buffer.from(input.body,'base64');
      if(body.toString('base64')!==input.body)throw Error('Non-canonical request body base64');
    }else if(input.bodyEncoding===undefined||input.bodyEncoding==='utf8')body=Buffer.from(input.body,'utf8');
    else throw Error('Unsupported request body encoding');
    if(body.length>maxBytes)throw Error('Plugin request body exceeds the configured limit');
    if(['GET','HEAD'].includes(method))throw Error('GET/HEAD requests cannot contain a body');
  }
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    for(let redirects=0;redirects<=10;redirects++){
      const response=await fetch(url,{method,headers,body,redirect:'manual',signal:controller.signal});
      if([301,302,303,307,308].includes(response.status)&&response.headers.has('location')){
        await response.body?.cancel();
        if(redirects===10)throw Error('Plugin request exceeded 10 redirects');
        const next=validUrl(new URL(response.headers.get('location'),url));
        if(next.origin!==url.origin)for(const name of ['authorization','cookie','proxy-authorization'])headers.delete(name);
        if(response.status===303&&method!=='HEAD'||[301,302].includes(response.status)&&method==='POST'){
          method='GET';body=undefined;headers.delete('content-type');headers.delete('content-length');
        }
        url=next;continue;
      }
      const length=Number(response.headers.get('content-length'));
      if(Number.isFinite(length)&&length>maxBytes){await response.body?.cancel();throw Error('Plugin response exceeds the configured limit');}
      const reader=response.body?.getReader(),chunks=[];let size=0;
      if(reader)try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes){await reader.cancel();throw Error('Plugin response exceeds the configured limit');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
      const bytes=Buffer.concat(chunks,size);
      return{status:response.status,headers:Object.fromEntries(response.headers),bodyBase64:bytes.toString('base64'),text:bytes.toString('utf8'),url:url.href};
    }
  }finally{clearTimeout(timer);}
}
