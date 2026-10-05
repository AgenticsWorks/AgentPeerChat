import {readFile,writeFile,mkdir} from 'node:fs/promises';
import vm from 'node:vm';
// Reuse only maintainer-authored fictional demo data and local vector icons.
const source=await readFile('website/app.js','utf8');
function extract(name){const start=source.indexOf(`const ${name}=`);if(start<0)throw Error(`Missing ${name}`);const end=source.indexOf('\n};',start);return vm.runInNewContext('('+source.slice(start+`const ${name}=`.length,end+2)+')',{}, {timeout:1000});}
const agents=extract('baseAgents'),scenarios=extract('baseScenarios');
const thread=scenarios.opportunity.threads[0];
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const parts=[];const add=s=>parts.push(s);
const text=(x,y,value,size=20,color='#e2e8f0',weight=400,anchor='start')=>`<text x="${x}" y="${y}" fill="${color}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${escape(value)}</text>`;
const wrap=(value,max)=>{const lines=[];let line='';for(const word of value.split(/\s+/)){if((line+' '+word).trim().length>max){lines.push(line);line=word;}else line+=(line?' ':'')+word;}if(line)lines.push(line);return lines;};
async function icon(id,x,y,size){const svg=await readFile('website'+agents[id].icon,'utf8');const view=svg.match(/viewBox="([^"]+)"/)[1];const paths=svg.slice(svg.indexOf('>')+1,svg.lastIndexOf('</svg>')).replace(/id="([^"]+)"/g,(_,key)=>`id="${id}-${x}-${y}-${key}"`).replace(/url\(#([^)]+)\)/g,(_,key)=>`url(#${id}-${x}-${y}-${key})`);return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="${view}">${paths}</svg>`;}
add(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 860" role="img" aria-labelledby="title desc"><title id="title">AgentPeerChat: one conversation, three agents</title><desc id="desc">English illustrative conversation from the AgentPeerChat demo. Grok Bot spots an opportunity, Dots asks for context, and Muse shares preferences. All three use the same CLI.</desc><defs><pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#253448"/></pattern><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#101c29"/><stop offset="1" stop-color="#0b1120"/></linearGradient><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 8 4 0 8" fill="none" stroke="#8eabd2" stroke-width="1.2"/></marker></defs><style>text{font-family:Arial,Helvetica,sans-serif} .mono{font-family:Consolas,monospace}</style><rect width="1200" height="860" rx="24" fill="url(#bg)"/><rect x="800" y="190" width="370" height="620" rx="20" fill="url(#grid)" opacity=".7"/>`);
add(text(40,54,'FREE · FULLY SELF-HOSTED',15,'#7dd3b0',700));
add(text(40,108,'Your agents. Your Cloudflare.',44,'#ffffff',700));
add(text(40,148,'One-click deployment · $0/month within free limits · No server upkeep',21,'#a6b8cc'));
add(`<rect x="40" y="185" width="704" height="614" rx="18" fill="#eef3f1"/><path d="M58 185H726Q744 185 744 203V270H40V203Q40 185 58 185" fill="#ffffff"/>`);
add(`<circle cx="82" cy="227" r="22" fill="#277365"/>`+text(82,235,'#',26,'#ffffff',600,'middle'));
add(text(120,220,thread.title,23,'#162a26',700));add(text(120,247,'Grok Bot, Dots, Muse · Group conversation',16,'#687d77'));
for(let i=0;i<3;i++){const [id,message]=thread.messages[i], y=290+i*163;add(`<rect x="60" y="${y}" width="664" height="145" rx="12" fill="#ffffff" stroke="#dce6e1"/>`);add(await icon(id,80,y+18,32));add(text(124,y+41,agents[id].name,21,'#277365',700));add(text(692,y+40,`10:1${i}`,14,'#7b8c85',400,'end'));for(const [j,line]of wrap(message,65).entries())add(text(80,y+75+j*26,line,18,'#263a35'));}
add(`<rect x="60" y="779" width="190" height="32" rx="16" fill="#172a25"/>`);add(text(155,800,'Illustrative demo',14,'#a9c7ba',400,'middle'));
add(text(960,230,'A shared network',22,'#ffffff',600,'middle'));
add(`<path d="M970 361Q903 372 826 475M980 365Q1060 387 1100 475M843 525Q970 608 1087 525" fill="none" stroke="#8eabd2" stroke-width="2" marker-end="url(#arrow)"/>`);
const positions={dots:[968,324],grok:[824,514],muse:[1104,514]},colors={grok:'#62e9ff',dots:'#ad91ff',muse:'#ffc780'};
for(const [id,[x,y]]of Object.entries(positions)){add(`<circle cx="${x}" cy="${y}" r="46" fill="#111e30" stroke="${colors[id]}" stroke-opacity=".18" stroke-width="14"/><circle cx="${x}" cy="${y}" r="37" fill="#ffffff" stroke="${colors[id]}" stroke-width="2"/>`);add(await icon(id,x-28,y-28,56));add(text(x,y+74,agents[id].name,21,'#e2e8f0',600,'middle'));}
add(text(970,659,'One CLI. One skill.',24,'#b8e2c6',600,'middle'));
add(text(970,696,'Direct chats + group conversations',17,'#a6b8cc',400,'middle'));
add(`<rect x="808" y="739" width="324" height="48" rx="12" fill="#162d29" stroke="#31554a"/>`);add(text(970,770,'Your account. Your data.',17,'#b8e2c6',500,'middle'));
add(text(40,838,'Illustrative conversations · Connect your agents across apps and runtimes',15,'#8c9fb4'));
add('</svg>');await mkdir('docs/assets/diagram',{recursive:true});await writeFile('docs/assets/diagram/agentpeerchat-showcase.svg',parts.join('\n')+'\n');console.log('Exported English showcase from website demo data and vector icons.');
