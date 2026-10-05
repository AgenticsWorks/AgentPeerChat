const t=(...args)=>globalThis.AgentPeerChatI18n?.t(...args)??args[0];
import ForceGraph from 'force-graph';

// A visualization of the same illustrative conversations shown in the chat panel.
// No analytics, remote graph service or third-party asset requests.
export function createAgentNetwork(container, agents, onSelect) {
  const colors = {grok:'#62e9ff', dots:'#ad91ff', muse:'#ffc780'};
  const positions = {grok:[-235,85], dots:[0,-155], muse:[235,85]};
  const nodes = Object.keys(agents).map(id => {
    const image = new Image(); image.src = agents[id].icon;
    return {id, name:agents[id].name, role:agents[id].role, color:colors[id], image,
      x:positions[id][0], y:positions[id][1], sent:0, received:0};
  });
  const links = nodes.flatMap(source => nodes.filter(target => source!==target).map(target => ({
    id:source.id+'-'+target.id, source:source.id, target:target.id, active:false, color:source.color
  })));
  let running=false, visible=false, hovered=null, fitted=false;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  function drawNode(node, ctx, globalScale) {
    const {color}=node, x=0, y=0, active=node.sending||node.receiving||node===hovered;
    ctx.save();ctx.translate(node.x,node.y);ctx.scale(1/globalScale,1/globalScale);
    const halo=ctx.createRadialGradient(x,y,20,x,y,active?68:48);
    halo.addColorStop(0,color+(active?'55':'22'));halo.addColorStop(1,color+'00');
    ctx.fillStyle=halo;ctx.beginPath();ctx.arc(x,y,active?68:48,0,Math.PI*2);ctx.fill();
    for(let ring=0;ring<3;ring++){
      const drift=running&&!reduced.matches?(Math.sin(performance.now()/800+ring)*2):0;
      ctx.beginPath();ctx.arc(x,y,32+ring*6+drift,0,Math.PI*2);
      ctx.strokeStyle=color+(active?['cc','55','22'][ring]:['55','22','11'][ring]);
      ctx.lineWidth=ring===0?1.3:.6;ctx.stroke();
    }
    ctx.fillStyle='#101a2b';ctx.beginPath();ctx.arc(x,y,27,0,Math.PI*2);ctx.fill();
    ctx.save();ctx.beginPath();ctx.arc(x,y,19,0,Math.PI*2);ctx.clip();
    ctx.fillStyle='#fff';ctx.fillRect(x-19,y-19,38,38);
    if(node.image.complete&&node.image.naturalWidth)ctx.drawImage(node.image,x-19,y-19,38,38);
    ctx.restore();
    ctx.textAlign='center';ctx.font='600 13px system-ui';ctx.fillStyle='#f1f5ff';
    ctx.fillText(node.name,x,y+62);
    ctx.font='10px system-ui';ctx.fillStyle=active?color:'#8898b1';
    ctx.fillText(node.sending?t("正在发送"):node.receiving?t("收到消息"):t(node.role),x,y+79);
    ctx.restore();
  }
  const graph = new ForceGraph(container)
    .graphData({nodes,links}).backgroundColor('rgba(0,0,0,0)')
    .nodeLabel(node=>node.name+' · '+t(node.role)).nodeVal(80)
    .nodeCanvasObject(drawNode)
    .nodePointerAreaPaint((node,color,ctx)=>{ctx.fillStyle=color;ctx.beginPath();ctx.arc(node.x,node.y,40/graph.zoom(),0,Math.PI*2);ctx.fill();})
    .linkCurvature(.18).linkColor(link=>link.active?link.color+'bb':'#56688538')
    .linkWidth(link=>link.active?1.5:.65)
    .linkDirectionalArrowLength(link=>link.active?5:0)
    .linkDirectionalArrowRelPos(.77).linkDirectionalArrowColor(link=>link.color)
    .linkDirectionalParticles(link=>link.active&&running&&!reduced.matches?3:0)
    .linkDirectionalParticleSpeed(.006).linkDirectionalParticleWidth(3)
    .linkDirectionalParticleCanvasObject((x,y,link,ctx)=>{
      ctx.save();ctx.shadowColor=link.color;ctx.shadowBlur=12;
      ctx.fillStyle=link.color;ctx.beginPath();ctx.arc(x,y,2.2,0,Math.PI*2);ctx.fill();
      ctx.shadowBlur=0;ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(x,y,.9,0,Math.PI*2);ctx.fill();ctx.restore();
    })
    .onNodeClick(node=>onSelect(node.id))
    .onNodeHover(node=>{hovered=node;container.style.cursor=node?'pointer':'grab';refresh();})
    .onNodeDragEnd(node=>{node.fx=node.x;node.fy=node.y;})
    .onZoom(({k})=>{container.dataset.zoom=k.toFixed(3);})
    .minZoom(.35).maxZoom(2.5).cooldownTicks(80).d3VelocityDecay(.55)
    .onEngineStop(()=>{if(!fitted){fit(0);fitted=true;container.dataset.fitted="true";}});
  graph.d3Force('charge').strength(-650);
  graph.d3Force('link').distance(link=>[link.source.id,link.target.id].includes('dots')?340:470).strength(.12);
  container.dataset.library='force-graph';
  container.querySelector('canvas').setAttribute('aria-hidden','true');
  function fit(duration=250){graph.zoomToFit(reduced.matches?0:duration,container.clientWidth<500?58:76);}
  function resize(){graph.width(container.clientWidth).height(container.clientHeight);fit(0);}
  new ResizeObserver(resize).observe(container);resize();
  function refresh(){graph.nodeCanvasObject(drawNode).linkColor(link=>link.active?link.color+'bb':'#56688538').linkDirectionalParticles(link=>link.active&&running&&!reduced.matches?3:0);}
  function setMessage({sender,receivers,traffic}){
    for(const node of nodes){node.sending=node.id===sender;node.receiving=receivers.includes(node.id);Object.assign(node,traffic[node.id]);}
    for(const link of links)link.active=(typeof link.source==='object'?link.source.id:link.source)===sender&&receivers.includes(typeof link.target==='object'?link.target.id:link.target);
    container.dataset.activeEdges=JSON.stringify(links.filter(link=>link.active).map(link=>link.id));
    refresh();
  }
  function setState(isRunning,isVisible){
    running=isRunning;visible=isVisible&&!document.hidden;
    graph.autoPauseRedraw(!running||reduced.matches);refresh();
    if(visible)graph.resumeAnimation();else graph.pauseAnimation();
  }
  reduced.addEventListener('change',()=>setState(running,visible));
  return {setMessage,setState,fit};
}
