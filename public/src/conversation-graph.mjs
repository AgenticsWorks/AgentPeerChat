import ForceGraph from 'force-graph';
import {forceCollide} from 'd3-force-3d';
import {conversationGraph,threadPeople} from '../conversation-view.js';
const instances=new WeakMap();
export function renderConversationGraph(container,threads,{openThread,chooseAgent,t,icon}){
 const data=conversationGraph(threads), signature=JSON.stringify(data);
 const sentCount=id=>data.conversations.reduce((sum,thread)=>sum+Number(threadPeople(thread).find(p=>p.id===id)?.sent_count??0),0);
 let entry=instances.get(container);
 if(!entry){
  container.replaceChildren();
  const graph=new ForceGraph(container).backgroundColor('#101726').nodeId('id').nodeRelSize(28)
   .nodeCanvasObject((node,ctx,scale)=>{
    const radius=node.group?30:25;
    ctx.save();ctx.translate(node.x,node.y);
    ctx.shadowColor=node.group?'#a78bfa':'#53d9c7';ctx.shadowBlur=12;
    ctx.fillStyle=node.group?'#302a49':'#26374c';ctx.beginPath();ctx.arc(0,0,radius+4,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;if(entry.selectedId===node.id){ctx.strokeStyle='#a6fff0';ctx.lineWidth=3;ctx.stroke();}
    const people=node.group?node.people.slice(0,3):[node.person];
    people.forEach((person,i)=>{
     const image=entry.images.get(person.id),r=node.group?12:23;
     const x=node.group?(i===0?0:i===1?-13:13):0,y=node.group?(i===0?-10:10):0;
     ctx.save();ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.clip();ctx.fillStyle='#526b8b';ctx.fillRect(x-r,y-r,r*2,r*2);
     if(image?.complete&&image.naturalWidth)ctx.drawImage(image,x-r,y-r,r*2,r*2);
     else{ctx.fillStyle='white';ctx.font=`bold ${r}px system-ui`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(person.name.slice(0,1).toUpperCase(),x,y);}ctx.restore();
    });
    ctx.fillStyle='#eff5ff';ctx.textAlign='center';ctx.font=`600 ${Math.max(12,13/scale)}px system-ui`;ctx.fillText(node.name,0,radius+23);
    ctx.fillStyle='#93a5bf';ctx.font=`${Math.max(10,11/scale)}px system-ui`;ctx.fillText(node.group?t('{0} messages',node.count):t('{0} sent',node.count),0,radius+40);ctx.restore();
   }).nodePointerAreaPaint((node,color,ctx,scale)=>{ctx.fillStyle=color;ctx.beginPath();ctx.arc(node.x,node.y,node.group?34:29,0,Math.PI*2);ctx.fill();ctx.font=`600 ${Math.max(12,13/scale)}px system-ui`;const width=Math.max(80,ctx.measureText(node.name).width+20);ctx.fillRect(node.x-width/2,node.y+25,width,55);})
   .linkColor(link=>link.group?'#9f8bd3':'#5b9cab').linkWidth(2).linkCurvature(0).linkHoverPrecision(12)
   .linkCanvasObjectMode(()=> 'after').linkCanvasObject((link,ctx,scale)=>{
    if(link.group)return;const x=(link.source.x+link.target.x)/2,y=(link.source.y+link.target.y)/2;const text=t('{0} messages',link.count);ctx.save();ctx.font=`600 ${12/scale}px system-ui`;const width=ctx.measureText(text).width+18/scale,height=24/scale;ctx.fillStyle='#213849';ctx.strokeStyle='#5b9cab';ctx.lineWidth=1/scale;ctx.beginPath();ctx.roundRect(x-width/2,y-height/2,width,height,6/scale);ctx.fill();ctx.stroke();ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle='#d9f9f3';ctx.fillText(text,x,y);ctx.restore();
   }).linkPointerAreaPaint((link,color,ctx,scale)=>{
    ctx.strokeStyle=color;ctx.lineWidth=18/scale;ctx.beginPath();ctx.moveTo(link.source.x,link.source.y);ctx.lineTo(link.target.x,link.target.y);ctx.stroke();if(!link.group){ctx.font=`600 ${12/scale}px system-ui`;const width=ctx.measureText(t('{0} messages',link.count)).width+22/scale;ctx.fillStyle=color;ctx.fillRect((link.source.x+link.target.x)/2-width/2,(link.source.y+link.target.y)/2-15/scale,width,30/scale);}
   })
   .linkLineDash(link=>link.group?[5,4]:null).linkLabel(link=>{const label=document.createElement('span');label.textContent=link.name;return label;})
   .nodeLabel(node=>{const label=document.createElement('span');label.textContent=node.name;return label;})
   .onNodeClick(node=>{entry.selectedId=node.id;node.group?entry.callbacks.openThread(node.thread):entry.callbacks.chooseAgent(node.id);})
   .onLinkClick(link=>link.thread&&entry.callbacks.openThread(link.thread))
   .onNodeHover(node=>{container.style.cursor=node?'pointer':'grab';}).onLinkHover(link=>{container.style.cursor=link?'pointer':'grab';});
  entry={graph,images:new Map(),signature:null,visible:false,fitTicks:0,callbacks:{openThread,chooseAgent}};instances.set(container,entry);
  const resize=()=>{if(container.clientWidth){graph.width(container.clientWidth).height(Math.max(440,Math.min(600,innerHeight-300)));graph.resumeAnimation();if(!entry.visible){entry.fitTicks=15;graph.d3ReheatSimulation();}entry.visible=true;}else{graph.pauseAnimation();entry.visible=false;}};
  new ResizeObserver(resize).observe(container);entry.resize=resize;
  graph.onEngineTick(()=>{if(entry.fitTicks>0&&--entry.fitTicks===0&&container.clientWidth)graph.zoomToFit(300,95);});
  const canvas=container.querySelector('canvas');canvas.setAttribute('role','img');canvas.setAttribute('aria-label',t('Conversation map'));
  graph.d3Force('collide',forceCollide(75));graph.d3Force('charge').strength(-650);graph.d3Force('link').distance(link=>link.group?145:230);
 }
 entry.callbacks={openThread,chooseAgent};entry.resize();
 if(entry.signature!==signature){
  entry.signature=signature;entry.fitTicks=15;
  const nodes=data.people.map(person=>({id:person.id,name:person.name,person,count:sentCount(person.id)})),links=[];
  for(const person of data.people){const src=icon(person);if(src){const image=new Image();image.src=src;entry.images.set(person.id,image);}else entry.images.delete(person.id);}
  for(const thread of data.conversations){const people=threadPeople(thread);if(thread.kind==='direct'&&people.length===2)links.push({source:people[0].id,target:people[1].id,thread:thread.id,count:Number(thread.message_count??0),name:people.map(p=>p.name).join(' ↔ ')});
   else{const id='group:'+thread.id;nodes.push({id,name:thread.title||t('Group chat'),group:true,people,thread:thread.id,count:Number(thread.message_count??0)});for(const person of people)links.push({source:person.id,target:id,group:true,name:thread.title,thread:thread.id});}}
  entry.graph.graphData({nodes,links});entry.graph.onEngineStop(()=>{entry.graph.zoomToFit(400,95);entry.graph.onEngineStop(()=>{});});
 }
 return{fit:()=>entry.graph.zoomToFit(400,95),zoom:factor=>entry.graph.zoom(entry.graph.zoom()*factor,250)};
}
