// Publish only the independent introduction site. Credentials arrive through the process environment.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const token=process.env.VERCEL_TOKEN;
if(!token)throw new Error('Provide VERCEL_TOKEN through your secret manager.');
let teamId=process.env.VERCEL_TEAM_ID;
if(!teamId){
 const response=await fetch('https://api.vercel.com/v2/teams',{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw new Error('Cannot discover Vercel team scope: HTTP '+response.status);
 const teams=(await response.json()).teams||[];
 if(teams.length>1)throw new Error('Choose the target account with VERCEL_TEAM_ID.');
 teamId=teams[0]?.id;
}
async function api(path,method='GET',body,raw=false){
 const response=await fetch('https://api.vercel.com'+path+(teamId?(path.includes('?')?'&':'?')+'teamId='+encodeURIComponent(teamId):''),{method,headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':raw?'application/octet-stream':'application/json'}:{})},body:body?(raw?body:JSON.stringify(body)):undefined,signal:AbortSignal.timeout(60000)});
 const d=await response.json();if(!response.ok)throw new Error('Vercel '+response.status+' '+String(d.error?.message||'API error').replaceAll(token,'[redacted]'));return d;
}
try{
 let project;try{project=await api('/v9/projects/agentgram-intro')}catch(error){if(!error.message.startsWith('Vercel 404'))throw error;project=await api('/v10/projects','POST',{name:'agentgram-intro',framework:null,buildCommand:null,outputDirectory:null});}
 await mkdir('.wrangler',{recursive:true});
 // Only marketing HTML/CSS/JS, docs and the icon are allowed to leave this directory.
 const allowed=['index.html','style.css','app.js','vercel.json','deployment.html','server-deployment.html','protocol.html','product.html','assets/icon.svg','assets/dots.svg','assets/grok.svg','assets/muse.svg'];
 const files=[];for(const file of allowed){const data=await readFile('website/'+file);if(data.includes(Buffer.from(token)))throw new Error('Credential found in an upload file.');files.push({file,data:data.toString('base64'),encoding:'base64'});}
 const deployment=await api('/v13/deployments','POST',{name:project.name,project:project.id,target:'production',files,projectSettings:{framework:null,buildCommand:null,outputDirectory:'.'}});
 console.log('Production deployment created: '+deployment.id);
 let ready=deployment;
 while(!['READY','ERROR','CANCELED'].includes(ready.readyState||ready.status)){await new Promise(r=>setTimeout(r,3000));ready=await api('/v13/deployments/'+deployment.id);}
 if((ready.readyState||ready.status)!=='READY')throw new Error('Deployment did not become ready: '+(ready.readyState||ready.status));
 const aliases=Array.isArray(ready.alias)?ready.alias:[];
 const result={projectId:project.id,projectName:project.name,teamId,deploymentId:deployment.id,deploymentUrl:'https://'+ready.url,aliases,readyAt:new Date().toISOString(),uploadedFiles:allowed};
 await writeFile('.wrangler/vercel-intro-deployment.json',JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result,null,2));
}catch(error){console.error(String(error.message).replaceAll(token,'[redacted]'));process.exitCode=1;}
