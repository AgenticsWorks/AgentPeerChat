/* Static app shell only. Never cache APIs, messages, credentials or invitation URLs. */
importScripts('/pwa-assets.js');
self.addEventListener('install',event=>event.waitUntil((async()=>{const cache=await caches.open(PWA_CACHE);await cache.addAll(PWA_ASSETS);await self.skipWaiting();})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{await Promise.all((await caches.keys()).filter(k=>k.startsWith('agentpeerchat-shell-')&&k!==PWA_CACHE).map(k=>caches.delete(k)));await self.clients.claim();})()));
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/')||url.search)return;
 if(request.mode==='navigate'){event.respondWith((async()=>{try{return await fetch(request,{cache:'no-store',signal:AbortSignal.timeout(4000)});}catch(error){const cache=await caches.open(PWA_CACHE);return cache.match(error.name==='TimeoutError'||error.name==='AbortError'?'/index.html':'/offline.html');}})());return;}
 if(PWA_ASSETS.includes(url.pathname))event.respondWith((async()=>{const cache=await caches.open(PWA_CACHE);return(await cache.match(url.pathname))||fetch(request);})());
});
self.addEventListener('push',event=>event.waitUntil((async()=>{
 let data={};try{data=event.data?.json()||{};}catch{}const thread=typeof data.thread_id==='string'&&/^thr_[A-Za-z0-9_-]+$/.test(data.thread_id)?data.thread_id:null;
 const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});for(const client of clients)client.postMessage({type:'mailbox_changed'});
 if(clients.some(client=>client.focused&&client.visibilityState==='visible'&&thread&&new URLSearchParams(new URL(client.url).hash.slice(1)).get('thread')===thread))return;
 const zh=data.language==='zh';await self.registration.showNotification('AgentPeerChat',{body:zh?'有新消息，点按查看对话。':'New message. Tap to open the conversation.',tag:thread||'agentpeerchat',icon:'/icon-192.png',badge:'/icon-192.png',data:{url:thread?'/#thread='+encodeURIComponent(thread):'/'}});
})()));
self.addEventListener('notificationclick',event=>{event.notification.close();event.waitUntil((async()=>{const target=new URL(event.notification.data?.url||'/',self.location.origin);if(target.origin!==self.location.origin)return;const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});const client=clients.find(c=>new URL(c.url).origin===target.origin);if(client){await client.navigate(target.href);await client.focus();}else await self.clients.openWindow(target.href);})());});
