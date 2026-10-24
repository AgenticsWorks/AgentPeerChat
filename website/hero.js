// Reusable deterministic Canvas hero. Caller owns canvas size/scale and background.
export const ASSET_FILES={muse:'/assets/orbit/muse.png',codex:'/assets/orbit/codex.svg',grok:'/assets/orbit/grok.png',claude:'/assets/orbit/claude.png',opencode:'/assets/orbit/opencode.png',openclaw:'/assets/orbit/openclaw.png',gemini:'/assets/orbit/gemini.png',cline:'/assets/orbit/cline.png',goose:'/assets/orbit/goose.png',brand:'/assets/orbit/agentpeerchat-ff97fe1c56fe.svg',deploy:'/assets/orbit/cloudflare-deploy.png'};
export const names={muse:'Muse',codex:'Codex',grok:'Grok Bot',claude:'Claude Code',opencode:'OpenCode',openclaw:'OpenClaw',gemini:'Gemini CLI',cline:'Cline',goose:'Goose'};
export const keys=Object.keys(names);
export const clamp=x=>Math.max(0,Math.min(1,x));
export const ease=x=>1-(1-clamp(x))**4;
export function rr(c,x,y,w,h,r,fill,stroke){c.beginPath();c.roundRect(x,y,w,h,r);if(fill){c.fillStyle=fill;c.fill()}if(stroke){c.strokeStyle=stroke;c.lineWidth=1;c.stroke()}}
export function txt(c,s,x,y,size=20,color='#101313',weight=600,align='left'){c.font=`${weight} ${size}px system-ui, sans-serif`;c.textAlign=align;c.textBaseline='top';c.fillStyle=color;c.fillText(s,x,y)}
export function fit(c,img,x,y,w,h){const iw=img.naturalWidth||img.width,ih=img.naturalHeight||img.height,scale=Math.min(w/iw,h/ih);c.drawImage(img,x+(w-iw*scale)/2,y+(h-ih*scale)/2,iw*scale,ih*scale)}
export function tile(c,a,key,x,y,size,t=0,options={}){
 const angle=options.angle??(.08*Math.sin(t*.7+x));const skew=options.skew??-.12;const squash=options.squash??.88;const depth=size*.10;
 // Long soft contact shadow, separate from the suspended object.
 c.save();c.translate(x+size*.08,y+size*.65);c.scale(1,.24);const sh=c.createRadialGradient(0,0,0,0,0,size*.8);sh.addColorStop(0,'rgba(33,42,38,.14)');sh.addColorStop(1,'rgba(33,42,38,0)');c.fillStyle=sh;c.beginPath();c.arc(0,0,size*.8,0,7);c.fill();c.restore();
 c.save();c.translate(x,y);c.rotate(angle);c.transform(1,skew,.16,squash,0,0);
 const central=key==='brand';for(let d=depth;d>0;d-=1.1){rr(c,-size/2+d*.26,-size/2+d,size,size,size*.25,central?'#0B2924':`rgb(${204+Math.floor(d/depth*12)},${212+Math.floor(d/depth*10)},${208+Math.floor(d/depth*10)})`)}
 c.shadowColor='rgba(24,40,33,.09)';c.shadowBlur=size*.12;c.shadowOffsetY=2;
 const grad=c.createLinearGradient(-size/2,-size/2,size/2,size/2);grad.addColorStop(0,central?'#376B57':'#FFFFFF');grad.addColorStop(.5,central?'#173F35':'#FFFFFF');grad.addColorStop(1,central?'#103529':'#E9EFEB');rr(c,-size/2,-size/2,size,size,size*.25,grad);c.shadowBlur=0;
 c.save();c.beginPath();c.roundRect(-size/2,-size/2,size,size,size*.25);c.clip();if(central){fit(c,a[key],-size*.47,-size*.47,size*.94,size*.94)}else fit(c,a[key],-size*.31,-size*.31,size*.62,size*.62);c.restore();
 c.strokeStyle=central?'rgba(221,240,189,.36)':'rgba(255,255,255,.95)';c.lineWidth=1.5;c.beginPath();c.roundRect(-size/2+1,-size/2+1,size-2,size-2,size*.25);c.stroke();
 c.restore();
}
export function ambient(c,x=640,y=320,r=390){const g=c.createRadialGradient(x,y,20,x,y,r);g.addColorStop(0,'rgba(221,237,225,.58)');g.addColorStop(.6,'rgba(236,242,236,.27)');g.addColorStop(1,'rgba(255,255,255,0)');c.fillStyle=g;c.fillRect(x-r,y-r,r*2,r*2)}
function packet(c,x,y,angle,peach=false){c.save();c.translate(x,y);c.rotate(angle);c.shadowColor='#183b2920';c.shadowBlur=7;c.shadowOffsetY=4;rr(c,-11,-7,22,15,3,'#fff','#E0E8E1');c.shadowBlur=0;rr(c,-7,-3,12,2,1,peach?'#EDAA82':'#93B89D');rr(c,-7,1,8,1.3,.5,'#CBD6CC');c.restore()}
export function drawHero(c,t,a,options={}){
 const cx=options.cx??640,cy=options.cy??300,scale=options.scale??1;const labels=options.labels??false;
 c.save();c.translate(cx,cy);c.scale(scale,scale);c.translate(-640,-300);ambient(c,640,305,410);
 const points=keys.map((key,i)=>{const theta=i/9*Math.PI*2-Math.PI/2+t*.055;return {key,x:640+Math.cos(theta)*303,y:300+Math.sin(theta)*205,theta,size:68+13*(Math.sin(theta)+1)/2}});
 c.save();c.strokeStyle='#D1DED2';c.lineWidth=1.1;c.setLineDash([2,7]);c.beginPath();c.ellipse(640,300,303,205,0,0,7);c.stroke();c.setLineDash([]);
 for(let i=0;i<9;i++){const p=points[i],q=points[(i+3)%9];c.strokeStyle='rgba(171,197,174,.32)';c.beginPath();c.moveTo(p.x,p.y);c.quadraticCurveTo(640,300,q.x,q.y);c.stroke();const v=(t*.13+i*.21)%1,u=1-v,x=u*u*p.x+2*u*v*640+v*v*q.x,y=u*u*p.y+2*u*v*300+v*v*q.y;packet(c,x,y,Math.atan2(q.y-p.y,q.x-p.x)*.12,i%3===0)}c.restore();
 const paint=p=>{tile(c,a,p.key,p.x,p.y+Math.sin(t*1.1+p.theta*4)*7,p.size,t,{angle:.10*Math.sin(p.theta+t*.25),skew:.09*Math.cos(p.theta),squash:.9});if(labels)txt(c,names[p.key],p.x,p.y+p.size*.67,12,'#53615A',600,'center')};
 points.filter(p=>p.y<300).forEach(paint);
 tile(c,a,'brand',640,300+Math.sin(t*.9)*9,210,t,{angle:-.14+Math.sin(t*.4)*.025,skew:-.09,squash:.91});
 points.filter(p=>p.y>=300).forEach(paint);
 c.restore();
}
