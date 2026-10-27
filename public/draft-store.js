// Drafts belong to this browser and signed-in identity; credentials are never stored.
export function createDraftStore({storage=globalThis.localStorage,prefix='agentpeerchat.drafts.'}={}){
 let identity=null,items={},clock=Date.now();const persist=()=>{if(!identity)return;try{storage.setItem(prefix+identity,JSON.stringify(items));}catch{}};
 return {identity(id){if(identity===id)return;identity=id;items={};try{const saved=JSON.parse(storage.getItem(prefix+id)||'{}');if(saved&&typeof saved==='object'&&!Array.isArray(saved))items=saved;}catch{};},
 get(id){const d=items[id];return d&&typeof d.text==='string'&&d.text.length<=32768?d:null;},
 set(id,draft){if(!identity)return;if(!draft.text&&!draft.replying){delete items[id];}else items[id]={...draft,updated:clock=Math.max(Date.now(),clock+1)};const sorted=Object.entries(items).sort((a,b)=>(b[1].updated||0)-(a[1].updated||0));items=Object.fromEntries(sorted.slice(0,32));persist();},
 clear(){if(identity)try{storage.removeItem(prefix+identity);}catch{}items={};identity=null;}};
}
