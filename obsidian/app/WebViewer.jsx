import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {ArrowLeft,ArrowRight,RefreshCw,ExternalLink,X,Globe} from 'lucide-react';
import './webviewer.css';
export default function WebViewer({url,visible=true}) {
  const bridge=window.vaultdesk,host=useRef(null),id=useRef('web-'+crypto.randomUUID()),alive=useRef(false);
  const [address,setAddress]=useState(url),[state,setState]=useState({url,loading:true}),[error,setError]=useState('');
  const shown=useRef(visible);shown.current=visible;
  const bounds=()=>{const r=host.current?.getBoundingClientRect();return r?{x:r.x,y:r.y,width:r.width,height:r.height}:{x:0,y:0,width:0,height:0};};
  const update=()=>{if(alive.current)bridge.webviewBounds(id.current,bounds(),shown.current).catch(e=>setError(e.message));};
  useEffect(()=>{
    if(!bridge?.webviewOpen)return;
    let live=true;
    const unsubscribe=bridge.onChange(event=>{if(live&&event.type==='webviewer'&&event.id===id.current){setState(event);setAddress(event.url);setError(event.error||'');}});
    bridge.webviewOpen({id:id.current,url,bounds:bounds(),visible:shown.current}).then(result=>{if(live){alive.current=true;setState(result);update();}else bridge.webviewClose(id.current).catch(()=>{});}).catch(e=>live&&setError(e.message));
    return()=>{live=false;alive.current=false;unsubscribe();bridge.webviewClose(id.current).catch(()=>{});};
  },[url]);
  useLayoutEffect(()=>{if(!host.current)return;const observer=new ResizeObserver(update);observer.observe(host.current);window.addEventListener('resize',update);update();return()=>{observer.disconnect();window.removeEventListener('resize',update);};},[visible]);
  const action=async value=>{try{setState(await bridge.webviewAction(id.current,value));}catch(e){setError(e.message);}};
  return <section className="vd-webviewer" aria-label="内嵌网页"><form className="vd-web-toolbar" onSubmit={async e=>{e.preventDefault();try{await bridge.webviewNavigate(id.current,address);setError('');}catch(error){setError(error.message);}}}>
    <button type="button" title="网页后退" aria-label="网页后退" disabled={!state.canGoBack} onClick={()=>action('back')}><ArrowLeft size={16}/></button><button type="button" title="网页前进" aria-label="网页前进" disabled={!state.canGoForward} onClick={()=>action('forward')}><ArrowRight size={16}/></button><button type="button" title="刷新网页" aria-label="刷新网页" disabled={!bridge?.webviewOpen} onClick={()=>action(state.loading?'stop':'reload')}>{state.loading?<X size={16}/>:<RefreshCw size={16}/>}</button>
    <input aria-label="网页地址" value={address} onChange={e=>setAddress(e.target.value)} placeholder="https://…"/><button type="submit" disabled={!bridge?.webviewOpen}>前往</button><button type="button" title="在浏览器打开" aria-label="在浏览器打开" onClick={()=>{if(bridge)bridge.openExternal(state.url||url).catch(e=>setError(e.message));else window.open(url,'_blank','noopener,noreferrer');}}><ExternalLink size={16}/></button>
    </form>{error&&<div className="vd-web-error" role="alert">{error}</div>}<div ref={host} className="vd-web-host">{!bridge?.webviewOpen&&<div className="empty-pane"><Globe size={32}/><p>内嵌网页在桌面版中打开。</p><a href={url} target="_blank" rel="noopener noreferrer">在浏览器打开此网页</a></div>}</div></section>;
}
