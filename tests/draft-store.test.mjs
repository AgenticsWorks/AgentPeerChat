import {test} from 'node:test';import assert from 'node:assert/strict';import {createDraftStore} from '../public/draft-store.js';
test('drafts and in-flight idempotency keys survive reopening but stay scoped to the signed-in identity',()=>{
 const values=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 const draft={text:'Compare flexible flights',selected:['muse'],replying:{id:'message',sender_id:'muse',content:'Earlier question'},attempt:{signature:'same request',key:'retry-key'}};
 let store=createDraftStore({storage});store.identity('owner');store.set('thread',draft);store=createDraftStore({storage});store.identity('human');assert.equal(store.get('thread'),null);store.identity('owner');assert.equal(store.get('thread').attempt.key,'retry-key');assert.equal(store.get('thread').text,draft.text);store.clear();store.identity('owner');assert.equal(store.get('thread'),null);
});
test('draft storage is bounded and unavailable storage does not stop composing',()=>{
 const storage={getItem(){throw Error('storage disabled');},setItem(){throw Error('quota');},removeItem(){throw Error('storage disabled');}},store=createDraftStore({storage});store.identity('owner');for(let i=0;i<40;i++)store.set(String(i),{text:'Draft '+i});assert.equal(store.get('0'),null);assert.equal(store.get('39').text,'Draft 39');assert.doesNotThrow(()=>store.clear());
});
