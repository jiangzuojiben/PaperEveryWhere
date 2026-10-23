const {Plugin,ItemView,Modal,requestUrl,request}=require('obsidian');
module.exports=class extends Plugin {
  onload(){
    this.registerView('synthetic-counter-view',leaf=>new class extends ItemView {
      constructor(leaf){super(leaf);this.count=0;this.file='Synthetic payload.md';}
      getViewType(){return 'synthetic-counter-view';}
      getDisplayText(){return 'Synthetic counter';}
      async onOpen(){this.draw();}
      draw(){this.contentEl.replaceChildren();const text=document.createElement('p');text.textContent='Synthetic counter: '+this.count;text.className='synthetic-counter-value';const button=document.createElement('button');button.textContent='Increment synthetic counter';button.onclick=()=>{this.count++;this.draw();};this.contentEl.append(text,button);}
      async setState(state){this.count=state.count;this.file=state.file;this.draw();}
      getState(){return {file:this.file,count:this.count};}
    }(leaf));
    this.addCommand({id:'open-counter',name:'Open synthetic counter',callback:async()=>{const leaf=this.app.workspace.getLeaf('tab');await leaf.setViewState({type:'synthetic-counter-view',state:{file:'Synthetic payload.md',count:1},active:true});await this.app.workspace.revealLeaf(leaf);}});
    this.addCommand({id:'roundtrip',name:'Roundtrip synthetic layout',callback:async()=>{const layout=this.app.workspace.getLayout();await this.app.workspace.changeLayout(layout);}});
    this.addCommand({id:'request',name:'Run loopback HTTP checks',callback:async()=>{
      const checks=[];let error;
      try{
        const p=requestUrl('http://127.0.0.1:28773/json');
        const [response,text,json,buffer]=await Promise.all([p,p.text,p.json,p.arrayBuffer]);
        checks.push({name:'promise facade text/json/arrayBuffer',pass:response.status===200&&text===JSON.stringify({fixture:'synthetic-only',value:7})&&json.value===7&&new TextDecoder().decode(buffer)===text});
        checks.push({name:'request alias returns text',pass:await request('http://127.0.0.1:28773/text')==='SYNTHETIC-HTTP-OK'});
        const missing=await requestUrl({url:'http://127.0.0.1:28773/missing',throw:false});
        checks.push({name:'throw false returns HTTP failure',pass:missing.status===404});
        let rejected=false;try{await requestUrl('http://127.0.0.1:28773/missing');}catch{rejected=true;}
        checks.push({name:'default HTTP failure rejects',pass:rejected});
      }catch(e){error=String(e);}
      new class extends Modal{onOpen(){this.titleEl.textContent='Loopback HTTP probe';const text=document.createElement('textarea');text.setAttribute('aria-label','Loopback HTTP probe JSON');text.value=JSON.stringify({checks,error});this.contentEl.appendChild(text);}}(this.app).open();
    }});
  }
};
