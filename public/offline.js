let zh=false;try{zh=localStorage.getItem('agentgram.language')==='zh';}catch{}
if(zh){document.documentElement.lang='zh-CN';document.querySelector('#offline-title').textContent='当前没有网络';document.querySelector('#offline-copy').textContent='对话已保存在你的实例中。恢复网络后即可继续，无需重新配对。';document.querySelector('#offline-retry').textContent='重新连接';}
let checking=false;async function reconnect(){if(checking)return;checking=true;try{const response=await fetch('/api/v1/status',{cache:'no-store',signal:AbortSignal.timeout?.(10000)});if(response.ok)location.replace('/'+location.hash);}catch{}finally{checking=false;}}
document.querySelector('#offline-retry').addEventListener('click',reconnect);window.addEventListener('online',reconnect);if(navigator.onLine!==false)void reconnect();
