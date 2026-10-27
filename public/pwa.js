import {t} from './i18n.js';
export function createAppExperience({installButton,settingsButton,banner,showHelp,onPush,onResume}){
 let deferred,registration;const standalone=()=>matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
 const viewport=()=>{const view=window.visualViewport;document.documentElement.style.setProperty('--app-height',`${view?.height||innerHeight}px`);document.documentElement.style.setProperty('--viewport-top',`${view?.offsetTop||0}px`);};
 const connectivity=()=>{banner.hidden=navigator.onLine!==false;banner.textContent=t('You’re offline. Your draft is saved; reconnect to send.');document.body.classList.toggle('app-offline',navigator.onLine===false);};
 const translate=()=>{installButton.title=installButton.ariaLabel=t('Install app');settingsButton.textContent=t(standalone()?'App installed':'Install app');connectivity();};
 window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferred=e;installButton.hidden=standalone();});window.addEventListener('appinstalled',()=>{deferred=null;installButton.hidden=true;translate();});
 const install=async()=>{if(standalone()){showHelp(t('App installed'),t('You’re already using the app.'));return;}if(deferred){const event=deferred;deferred=null;await event.prompt();await event.userChoice;installButton.hidden=true;}else showHelp(t('Install app'),t(/iPhone|iPad|iPod/.test(navigator.userAgent)?'Open this site in Safari, tap Share, then Add to Home Screen.':'In Chrome, open the ⋮ menu and choose Install app or Add to Home screen.'));};
 installButton.addEventListener('click',()=>void install());settingsButton.addEventListener('click',()=>void install());window.addEventListener('online',()=>{connectivity();void onResume();});window.addEventListener('offline',connectivity);window.addEventListener('pageshow',()=>{viewport();if(navigator.onLine!==false)void onResume();});window.addEventListener('resize',viewport);window.visualViewport?.addEventListener('resize',viewport);window.visualViewport?.addEventListener('scroll',viewport);
 navigator.serviceWorker?.addEventListener('message',event=>{if(event.data?.type==='mailbox_changed')void onPush();});
 if('serviceWorker'in navigator&&isSecureContext){registration=navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'}).catch(()=>null);}
 viewport();translate();return {ready:()=>registration||Promise.resolve(null),translate};
}
export function createPushClient({api,experience,language=()=> 'en'}){
 let active=false,registered=false;
 async function subscribe(){const registration=await experience.ready();if(!registration?.pushManager)return false;await navigator.serviceWorker.ready;
  const {public_key}=await api('/push/key');const key=Uint8Array.from(atob(public_key.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
  let subscription=await registration.pushManager.getSubscription();if(subscription&&subscription.options.applicationServerKey&&Array.from(new Uint8Array(subscription.options.applicationServerKey)).join()!==Array.from(key).join()){await subscription.unsubscribe();subscription=null;}
  subscription??=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
  await api('/push/subscriptions',{method:'POST',data:{...subscription.toJSON(),language:language()}});registered=true;return true;
 }
 return {async enable(){active=true;if(!('Notification'in globalThis)||!('PushManager'in globalThis))return false;return subscribe();},async restore(){active=true;if(globalThis.Notification?.permission==='granted')try{return await subscribe();}catch{}return false;},enabled:()=>active&&registered,
 async stop(){active=false;registered=false;try{const registration=await experience.ready(),subscription=await registration?.pushManager?.getSubscription();if(subscription){await api('/push/subscriptions',{method:'DELETE',data:{endpoint:subscription.endpoint}});await subscription.unsubscribe();}}catch{}}};
}
