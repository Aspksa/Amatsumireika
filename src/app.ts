export {};
type NodeRecord={id:number;title:string;category:string;folder?:string};
type Edge={source:number;target:number};
type Snapshot={nodes:NodeRecord[];edges:Edge[];categories:string[]};
type Point={x:number;y:number};
type Layout="radial"|"clusters"|"hex"|"force"|"tile"|"hud";
const $=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const canvas=$<HTMLCanvasElement>("graph"), stage=$("stage"), ctx=canvas.getContext("2d")!;
const palettes=[{name:"Океан",colors:["#41d9cc","#6fa0e8","#aa91e9","#e9b66e","#5ebd91","#e482a5","#80aab9","#e0d48f","#5faecb"]},{name:"Императорская",colors:["#e8c470","#d9e4e8","#be9860","#f2dfaf","#a4bfae","#c78981","#d8c9ed","#cfa346","#8aaab5"]},{name:"Полярная",colors:["#5ccde8","#9dbafa","#ba9be8","#79e5d7","#a5c2cf","#d6a9d4","#9bcb93","#e1c891","#87a5d6"]}];
palettes.push({name:"Металл",colors:["#d5ad70","#b7c5d0","#c395d9","#c7a469","#83aaa3","#c78f77","#8e9ba8","#c6bc95","#6c8eab"]},{name:"Рубин",colors:["#f06b94","#eebc70","#c47bea","#d2768b","#7cc3b2","#e19b9b","#9aa5d8","#cdaa65","#cc86b2"]},{name:"Неон",colors:["#3cdbbc","#80b8ff","#b984ff","#d8ec62","#4ef0ae","#ff68a8","#5ad9ef","#f7aa55","#b6e274"]},{name:"Бордо",colors:["#d6a9a0","#d6c0a5","#ad819a","#b88f73","#9aafa7","#be8290","#8f9fab","#d1ad8f","#ad93c0"]},{name:"Бумага",colors:["#247e73","#386b9c","#7653a2","#987026","#36825c","#a84572","#466e7e","#85742b","#2f7295"]});
let colors=palettes[0].colors, state:Snapshot={nodes:[],edges:[],categories:["Личность","Знания","Навыки","Опыт","Документы","Цели","Эмоции","Логика","Воспоминания"]};
let nodes:NodeRecord[]=[],edges:Edge[]=[],demo=true,mode:Layout="radial",expanded=false,selected:number|null=null,hover:number|null=null,filter:string|null=null;
let width=1,height=1,zoom=1,pan:Point={x:0,y:0},speed=.6,density=84,phase=0,last=0,drag:Point|null=null,dragOrigin:Point|null=null,moved=false;
let positions=new Map<number,Point>(),targets=new Map<number,Point>(),centers:Point[]=[],visible:NodeRecord[]=[],groups:NodeRecord[][]=[],groupCounts:number[]=[],neighbor=new Map<number,Set<number>>(),nodeMap=new Map<number,NodeRecord>();
let cursor:Point={x:0,y:0},fit=1;
let atlasMode:Layout="radial", grouping:"category"|"folder"="category", groupNames:string[]=[], collapsed=new Set<string>(), strength=.35, groupSize=.9;
let nodeGroups=new Map<number,number>(), presentation=false;
function folderOf(n:NodeRecord){return n.folder?.trim()||"Без папки"}
function groupColor(g:number){return colors[g%colors.length]}
function groupKey(g:number){return grouping+":"+groupNames[g]}
function categoryCounts(){return state.categories.map(c=>nodes.filter(n=>n.category===c).length)}
let cameraTarget:{zoom:number;pan:Point}|null=null;
const mono="Cascadia Mono, Consolas, Liberation Mono, monospace";
function paper(){return document.documentElement.classList.contains("paper")}
function gridInk(){return paper()?"#84949b55":"#27414b70"}
const reduced=matchMedia("(prefers-reduced-motion: reduce)").matches;
const tau=Math.PI*2;
function makeDemo():{nodes:NodeRecord[];edges:Edge[]}{
 const ns=state.categories.flatMap((category,g)=>Array.from({length:28+g*3},(_,i)=>({id:-(g*1000+i+1),title:category+" · "+(i+1),category,folder:["Архив","Текущие","Исследования"][i%3]})));
 const es:Edge[]=ns.filter((_,i)=>i%7===0).flatMap((n,i)=>[{source:n.id,target:ns[(i*19+37)%ns.length].id}]).filter(e=>e.source!==e.target);
 return {nodes:ns,edges:es};
}
function text(el:HTMLElement,s:string){el.textContent=s}
function setState(s:Snapshot){
 state=s;demo=s.nodes.length===0;const data=demo?makeDemo():s;nodes=data.nodes;edges=data.edges;
 nodeMap=new Map(nodes.map(n=>[n.id,n]));neighbor=new Map();
 for(const e of edges){for(const [a,b] of [[e.source,e.target],[e.target,e.source]]){if(!neighbor.has(a))neighbor.set(a,new Set());neighbor.get(a)!.add(b)}}
 if(selected!==null&&!nodeMap.has(selected))selected=null;hover=null;positions.clear();rebuild();refreshPanels();
 text($("status"),demo?"ДЕМО · БД ПУСТА":"ЛОКАЛЬНО · БД АКТИВНА");
}
function color(n:NodeRecord){return groupColor(nodeGroups.get(n.id)??Math.max(0,state.categories.indexOf(n.category)))}
function polar(a:number,r:number):Point{return{x:Math.cos(a)*r,y:Math.sin(a)*r}}
function rebuild(){
 const folderMode=expanded&&grouping==="folder";
 const buckets=new Map<string,NodeRecord[]>();
 for(const n of nodes){const key=folderMode?folderOf(n):n.category;const list=buckets.get(key)??[];list.push(n);buckets.set(key,list)}
 groupNames=folderMode?Array.from(buckets.keys()).sort((a,b)=>a.localeCompare(b,"ru")):state.categories.slice();
 // Keep the overview legible; extra folder groups remain accessible in search.
 if(folderMode&&groupNames.length>9){const rest=groupNames.slice(8);let other="Остальные папки";while(buckets.has(other))other+=" ·";buckets.set(other,rest.flatMap(k=>buckets.get(k)??[]));groupNames=[...groupNames.slice(0,8),other]}
 groups=groupNames.map(c=>buckets.get(c)??[]);groupCounts=groups.map(g=>g.length);nodeGroups=new Map();
 groups.forEach((g,i)=>g.forEach(n=>nodeGroups.set(n.id,i)));
 const all=groups.map((g,i)=>expanded&&collapsed.has(groupKey(i))?[]:g.slice(0,density));
 if(selected!==null){const n=nodeMap.get(selected),g=nodeGroups.get(selected);if(n&&g!==undefined&&!(expanded&&collapsed.has(groupKey(g)))&&!all[g].some(x=>x.id===n.id))all[g].push(n)}
 visible=all.flat();targets=new Map();centers=[];
 const count=Math.max(1,groupNames.length);
 for(let g=0;g<count;g++){
  if(!groupNames[g])continue;
  const angle=-Math.PI/2+tau*g/count;
  const center=mode==="hex"?hexCenter(g):mode==="tile"?tileCenter(g):polar(angle,mode==="clusters"||mode==="force"?230:218);
  centers.push(center);
  all[g].forEach((n,i)=>{
   let p:Point;
   if(mode==="radial"||mode==="hud"){
    const cols=Math.max(3,Math.ceil(Math.sqrt(all[g].length)*1.25)),col=i%cols,row=Math.floor(i/cols);
    const a=angle+((col-(cols-1)/2)/cols)*tau/count*.78;
    const inner=expanded?104:72,outer=expanded?215:190,rows=Math.max(1,Math.ceil(all[g].length/cols)-1);p=polar(a,inner+row*(outer-inner)/rows+(col%2)*2);
   }else if(mode==="tile"){
    const cols=Math.ceil(Math.sqrt(all[g].length)),cell=110*groupSize/Math.max(1,cols);
    p={x:center.x+(i%cols-(cols-1)/2)*cell,y:center.y+(Math.floor(i/cols)-(cols-1)/2)*cell};
   }else{
    const rr=Math.sqrt((i+.5)/Math.max(all[g].length,1))*(mode==="hex"?55:62)*groupSize;const q=i*2.399963;
    p={x:center.x+Math.cos(q)*rr,y:center.y+Math.sin(q)*rr};
   }
   targets.set(n.id,p);if(!positions.has(n.id))positions.set(n.id,{x:0,y:0});
  });
 }
 if(mode==="force")relaxForce();
 for(const id of positions.keys())if(!targets.has(id))positions.delete(id);
 refreshGroupControls();
}
function hexCenter(i:number):Point{
 const axial=[[1,0],[0,1],[-1,1],[-1,0],[0,-1],[1,-1],[2,-1],[1,1],[-1,2]];
 const [q,r]=axial[i%axial.length];return{x:Math.sqrt(3)*85*(q+r/2),y:127.5*r};
}
function tileCenter(i:number):Point{return{x:(i%3-1)*180,y:(Math.floor(i/3)-1)*180}}
function relaxForce(){
 const seeds=new Map(Array.from(targets,([id,p])=>[id,{...p}]));
 const activeEdges=edges.filter(e=>targets.has(e.source)&&targets.has(e.target)).slice(0,5000);
 for(let step=0;step<22;step++){
  const bins=new Map<string,number[]>(),delta=new Map<number,Point>();
  for(const [id,p] of targets){const key=Math.floor(p.x/20)+","+Math.floor(p.y/20);const b=bins.get(key)??[];b.push(id);bins.set(key,b);delta.set(id,{x:0,y:0})}
  for(const [id,p] of targets){const d=delta.get(id)!,seed=seeds.get(id)!;d.x+=(seed.x-p.x)*.07;d.y+=(seed.y-p.y)*.07;const bx=Math.floor(p.x/20),by=Math.floor(p.y/20);
   for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(const other of (bins.get((bx+x)+","+(by+y))??[]).slice(0,32)){
    if(other===id)continue;const q=targets.get(other)!;let dx=p.x-q.x,dy=p.y-q.y;let dist=Math.hypot(dx,dy);if(dist<.01){dx=id>other?.1:-.1;dy=.1;dist=Math.hypot(dx,dy)}if(dist<16){const push=(16-dist)*.085;d.x+=dx/dist*push;d.y+=dy/dist*push}
   }
  }
  for(const e of activeEdges){const a=targets.get(e.source)!,b=targets.get(e.target)!,da=delta.get(e.source)!,db=delta.get(e.target)!;const dx=b.x-a.x,dy=b.y-a.y,len=Math.max(1,Math.hypot(dx,dy));const f=Math.min(3,Math.max(-3,(len-45)*strength*.025));da.x+=dx/len*f;da.y+=dy/len*f;db.x-=dx/len*f;db.y-=dy/len*f}
  for(const [id,p] of targets){const d=delta.get(id)!;p.x=Math.max(-345,Math.min(345,p.x+Math.max(-7,Math.min(7,d.x))));p.y=Math.max(-345,Math.min(345,p.y+Math.max(-7,Math.min(7,d.y))))}
 }
}
function refreshGroupControls(){
 const root=$("graph-groups");root.replaceChildren();
 groupNames.forEach((name,i)=>{const b=document.createElement("button");b.className="group-toggle";const closed=collapsed.has(groupKey(i));b.setAttribute("aria-expanded",String(!closed));text(b,(closed?"▸ ":"▾ ")+name+" · "+groupCounts[i]);b.onclick=()=>{if(closed)collapsed.delete(groupKey(i));else collapsed.add(groupKey(i));if(selected!==null&&nodeGroups.get(selected)===i&& !closed)selected=null;rebuild();refreshDetails();refreshCounts()};root.append(b)})
}
function resize(){const box=stage.getBoundingClientRect();width=Math.max(1,box.width);height=Math.max(1,box.height);const dpr=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);fit=Math.max(.1,Math.min(width/(expanded?(mode==="hex"?830:mode==="force"?790:735):670),height/(expanded?(mode==="hex"?760:735):740)));ctx.setTransform(dpr,0,0,dpr,0,0)}
new ResizeObserver(resize).observe(stage);resize();
function scale(){return fit*zoom}
function world(p:Point):Point{return{x:(p.x-width/2-pan.x)/scale(),y:(p.y-height/2-pan.y)/scale()}}
function worldToScreen(p:Point):Point{return{x:width/2+pan.x+p.x*scale(),y:height/2+pan.y+p.y*scale()}}
function circle(x:number,y:number,r:number,stroke:string,fill?:string){ctx.beginPath();ctx.arc(x,y,r,0,tau);if(fill){ctx.fillStyle=fill;ctx.fill()}ctx.strokeStyle=stroke;ctx.stroke()}
function line(a:Point,b:Point,c:string){ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle=c;ctx.stroke()}
function polygon(p:Point,r:number,c:string){ctx.beginPath();for(let j=0;j<6;j++){const v=polar(Math.PI/6+j*tau/6,r);if(j===0)ctx.moveTo(p.x+v.x,p.y+v.y);else ctx.lineTo(p.x+v.x,p.y+v.y)}ctx.closePath();ctx.fillStyle=c+"0b";ctx.fill();ctx.strokeStyle=c+"55";ctx.stroke()}
function drawCore(){
 const c=colors[0];
 if(expanded){
  circle(0,0,72,gridInk());circle(0,0,33,c+"aa",paper()?"#faf8f0":"#0a121b");
  if(mode==="hex"){for(let i=0;i<40;i++){const p=polar(i*tau/40+phase*.05,43);circle(p.x,p.y,7,c+"32")}}
  ctx.strokeStyle=paper()?"#21313a":"#e2e9ed";ctx.beginPath();ctx.arc(0,0,12,0,tau);ctx.stroke();ctx.beginPath();ctx.ellipse(0,0,13,7,-.75,0,tau);ctx.stroke();
  ctx.fillStyle=paper()?"#21313a":"#c2d1d9";ctx.font="8px "+mono;ctx.textAlign="center";ctx.fillText("ЯДРО",0,47);return;
 }
 const glow=ctx.createRadialGradient(0,0,0,0,0,61);glow.addColorStop(0,c+"35");glow.addColorStop(1,c+"00");ctx.fillStyle=glow;ctx.fillRect(-61,-61,122,122);
 circle(0,0,31,c+"20");circle(0,0,48,c+"15");
 for(let i=0;i<155;i++){const a=i*2.399963+phase*.18;const r=2+Math.sqrt((i+.5)/155)*(29+2*Math.sin(phase+i*.17));const p=polar(a,r);const q=polar(a+.5,r*.82);if(i%4===0)line(p,q,c+"32");circle(p.x,p.y,i%9===0?1.3:.65,c+"00",c+(i%7===0?"f0":"80"))}
 ctx.fillStyle=c;ctx.font="8px "+mono;ctx.textAlign="center";ctx.fillText("КОГНИТИВНОЕ ЯДРО",0,61);
}
function frame(now:number){
 const dt=last?Math.min(50,now-last):16;last=now;if(!reduced)phase+=dt*.001*speed;
 if(cameraTarget){const ease=reduced?1:1-Math.pow(.0005,dt/1000);zoom+=(cameraTarget.zoom-zoom)*ease;pan.x+=(cameraTarget.pan.x-pan.x)*ease;pan.y+=(cameraTarget.pan.y-pan.y)*ease;if(Math.abs(zoom-cameraTarget.zoom)<.005&&Math.hypot(pan.x-cameraTarget.pan.x,pan.y-cameraTarget.pan.y)<.5){zoom=cameraTarget.zoom;pan=cameraTarget.pan;cameraTarget=null}$<HTMLInputElement>("zoom").value=String(zoom)}
 const dpr=canvas.width/width;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
 ctx.save();ctx.translate(width/2+pan.x,height/2+pan.y);ctx.scale(scale(),scale());ctx.lineWidth=1/Math.max(scale(),.45);
 const step=reduced?1:1-Math.pow(.001,dt/1000);
 for(const [id,t] of targets){const p=positions.get(id)!;p.x+=(t.x-p.x)*step;p.y+=(t.y-p.y)*step}
 if(mode==="radial"||mode==="hud"){
  if(mode==="hud"){ctx.setLineDash([12,5,2,5]);for(let k=0;k<3;k++)circle(0,0,240+k*28,gridInk());ctx.setLineDash([]);for(let i=0;i<36;i++){const a=i*tau/36;line(polar(a,317),polar(a,326+(i%3===0?8:0)),groupColor(i)+"77")}}
  for(const r of (expanded?[100,222,285,320]:[70,190,238,274]))circle(0,0,r,gridInk());
  if(expanded){for(let g=0;g<groups.length;g++){const n=Math.min(32,groups[g].length);for(let j=0;j<n;j++){const angle=-Math.PI/2+g*tau/groups.length+(j%16-7.5)*.032;const p=polar(angle,292+Math.floor(j/16)*12);circle(p.x,p.y,4.5,colors[g]+"68");circle(p.x,p.y,1.3,colors[g]+"90")}}}
 }else if(mode==="clusters"){circle(0,0,215,"#25434d50")}
 centers.forEach((c,g)=>{
  const col=groupColor(g);const active=!filter||groups[g].some(n=>n.category===filter);ctx.globalAlpha=active?1:.19;
  if(mode==="hex"){polygon(c,81*groupSize,col);circle(c.x,c.y,24*groupSize,col+"55",col+"0a");for(let j=0;j<6;j++){const p=polar(Math.PI/6+j*tau/6,81*groupSize);circle(c.x+p.x,c.y+p.y,3,col+"55",paper()?"#f2f0e8":"#08121b")}}
  else if(mode==="clusters"){circle(c.x,c.y,72*groupSize,col+"77",col+"0a");circle(c.x,c.y,48*groupSize,col+"22")}
  else if(mode==="tile"){const sz=140*groupSize;ctx.fillStyle=col+"0b";ctx.strokeStyle=col+"55";ctx.fillRect(c.x-sz/2,c.y-sz/2,sz,sz);ctx.strokeRect(c.x-sz/2,c.y-sz/2,sz,sz)}
  else if(mode==="force"){circle(c.x,c.y,70*groupSize,col+"22",col+"05")}
  else{const a=-Math.PI/2+g*tau/centers.length;if(!expanded){const p=polar(a,247);circle(p.x,p.y,16,col+"55",col+"0e");ctx.font="10px "+mono;ctx.textAlign="center";ctx.fillStyle=col;ctx.fillText(String(groupCounts[g]),p.x,p.y+3);const q=polar(a,113);circle(q.x,q.y,5,col+"99",col);line(polar(a,32),q,col+"30");line(q,p,col+"20")}else{line(polar(a,74),c,col+"16")}}
  const label=(mode==="radial"||mode==="hud")?polar(-Math.PI/2+g*tau/centers.length,expanded?241:210):{x:c.x,y:c.y+(mode==="hex"?-36:-79)};
  ctx.textAlign="center";ctx.font=(expanded?"9px ":"10px ")+mono;ctx.fillStyle=col;ctx.fillText((expanded&&collapsed.has(groupKey(g))?"▸ ":"")+groupNames[g].toUpperCase().slice(0,28),label.x,label.y);
 });
 ctx.globalAlpha=1;
 const focus=hover??selected;
 if(expanded&&strength>0){ctx.globalAlpha=1;const opacity=Math.round(strength*(mode==="force"?85:40)).toString(16).padStart(2,"0");let drawn=0;for(const e of edges){const a=positions.get(e.source),b=positions.get(e.target);if(a&&b&&(!filter||nodeMap.get(e.source)?.category===filter||nodeMap.get(e.target)?.category===filter)){line(a,b,"#79b7bd"+opacity);if(++drawn>=2500)break}}}
 if(focus!==null){const p=positions.get(focus);if(p)for(const id of neighbor.get(focus)??[]){const q=positions.get(id);if(q)line(p,q,"#81e6dc"+Math.round(strength*255).toString(16).padStart(2,"0"))}}
 for(const n of visible){
  const p=positions.get(n.id)!;const col=color(n);const lit=n.id===focus||n.id===selected;const related=focus!==null&&neighbor.get(focus)?.has(n.id);
  const dim=(filter!==null&&n.category!==filter)||(focus!==null&&!lit&&!related);
  ctx.globalAlpha=dim?.22:1;
  const r=lit?4.5:related?2.7:(expanded?1.1:1.3)+(.5+.5*Math.sin(phase*1.5+n.id*.71))*.55;
  if(lit||related)circle(p.x,p.y,r+4,col+"66");
  circle(p.x,p.y,r,col,col+(lit?"ff":"b0"));
 }
 ctx.globalAlpha=1;if(expanded&&zoom>=1.8){const used=new Set<string>();let labels=0;for(const n of visible){const p=positions.get(n.id)!,s=worldToScreen(p);if(s.x<0||s.x>width||s.y<0||s.y>height||(filter&&n.category!==filter))continue;const key=Math.floor(s.x/100)+","+Math.floor(s.y/17);if(used.has(key)&&n.id!==focus)continue;used.add(key);ctx.font=(10/scale())+"px "+mono;ctx.fillStyle=paper()?"#21313a":"#c8d8df";ctx.textAlign="left";ctx.fillText(n.title.slice(0,30),p.x+5/scale(),p.y-5/scale());if(++labels>=100)break}}
 drawCore();
 ctx.restore();requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
function local(e:PointerEvent|WheelEvent|MouseEvent):Point{const r=canvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top}}
function hit(p:Point):number|null{let best:number|null=null,min=12*12;for(const n of visible){if(filter&&n.category!==filter)continue;const q=worldToScreen(positions.get(n.id)!);const d=(q.x-p.x)**2+(q.y-p.y)**2;if(d<min){min=d;best=n.id}}return best}
function tooltip(id:number|null,p:Point){const t=$("tooltip");const n=id===null?undefined:nodeMap.get(id);t.hidden=!n;if(n){text(t,n.title+"\n"+n.category+" · связей: "+(neighbor.get(n.id)?.size??0));t.style.left=Math.max(4,Math.min(width-194,p.x+14))+"px";t.style.top=Math.max(4,Math.min(height-75,p.y+12))+"px"}}
function choose(id:number|null){selected=id;rebuild();refreshDetails()}
canvas.addEventListener("pointerdown",e=>{if(e.button!==0)return;cameraTarget=null;drag=local(e);dragOrigin=drag;moved=false;canvas.setPointerCapture(e.pointerId)});
canvas.addEventListener("pointermove",e=>{cursor=local(e);if(drag){pan.x+=cursor.x-drag.x;pan.y+=cursor.y-drag.y;drag=cursor;if(dragOrigin&&Math.hypot(cursor.x-dragOrigin.x,cursor.y-dragOrigin.y)>4)moved=true;hover=null;tooltip(null,cursor)}else{hover=hit(cursor);tooltip(hover,cursor)}});
canvas.addEventListener("pointerup",e=>{if(!moved&&drag)choose(hit(local(e)));drag=null;dragOrigin=null});
canvas.addEventListener("pointercancel",()=>{drag=null;dragOrigin=null});
canvas.addEventListener("pointerleave",()=>{hover=null;tooltip(null,cursor)});
function setZoom(z:number,p:Point={x:width/2,y:height/2}){cameraTarget=null;const w=world(p);zoom=Math.max(.35,Math.min(5,z));pan={x:p.x-width/2-w.x*scale(),y:p.y-height/2-w.y*scale()};$<HTMLInputElement>("zoom").value=String(zoom)}
canvas.addEventListener("wheel",e=>{e.preventDefault();setZoom(zoom*Math.exp(-e.deltaY*.0015),local(e))},{passive:false});
function focusNode(id:number){if(!expanded)layout(true);const g=nodeGroups.get(id);if(g!==undefined)collapsed.delete(groupKey(g));choose(id);const p=targets.get(id);if(p){const z=3;cameraTarget={zoom:z,pan:{x:-p.x*fit*z,y:-p.y*fit*z}}}}
canvas.addEventListener("dblclick",e=>{const id=hit(local(e));if(id!==null)focusNode(id)});
function reset(){cameraTarget=null;zoom=1;pan={x:0,y:0};$<HTMLInputElement>("zoom").value="1";filter=null;choose(null);refreshPanels()}
$("reset").onclick=reset;
function layout(isExpanded:boolean){if(expanded===isExpanded)return;if(expanded)atlasMode=mode;expanded=isExpanded;$("layout").classList.toggle("expanded",expanded);$("home").classList.toggle("active",!expanded);$("atlas").classList.toggle("active",expanded);text($("subtitle"),expanded?"Детальная карта памяти":"КОМАНДНЫЙ ЦЕНТР · ЖИВОЕ ЯДРО");text($("brand-mode"),expanded?"Атлас памяти":"Командный центр");$(expanded?"search-atlas":"search-home").append($("search-block"));mode=expanded?atlasMode:"radial";document.querySelectorAll<HTMLElement>("[data-mode]").forEach(x=>x.classList.toggle("active",x.dataset.mode===mode));resize();reset();positions.forEach(p=>{p.x*=.12;p.y*=.12});const el=$("layout");el.classList.remove("reveal");void el.offsetWidth;el.classList.add("reveal");text($("legend"),expanded?"Колесо — масштаб · Перетаскивание — перемещение · Двойной щелчок — фокус":"Нажмите на ядро, чтобы открыть полный атлас")}
$("core-open").onclick=()=>layout(true);
$("home").onclick=()=>layout(false);$("atlas").onclick=()=>layout(true);
document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach(b=>b.onclick=()=>{mode=b.dataset.mode as Layout;atlasMode=mode;document.querySelectorAll("[data-mode]").forEach(x=>x.classList.toggle("active",x===b));cameraTarget=null;resize();rebuild()});
document.querySelectorAll<HTMLButtonElement>("[data-group]").forEach(b=>b.onclick=()=>{grouping=b.dataset.group==="folder"?"folder":"category";document.querySelectorAll("[data-group]").forEach(x=>x.classList.toggle("active",x===b));filter=null;selected=null;rebuild();refreshPanels()});
$("expand-groups").onclick=()=>{groupNames.forEach((_,i)=>collapsed.delete(groupKey(i)));rebuild();refreshCounts()};
$("collapse-groups").onclick=()=>{groupNames.forEach((_,i)=>collapsed.add(groupKey(i)));selected=null;hover=null;rebuild();refreshDetails();refreshCounts()};
$<HTMLInputElement>("strength").oninput=e=>{strength=Number((e.target as HTMLInputElement).value);if(mode==="force")rebuild()};
$<HTMLInputElement>("group-size").oninput=e=>{groupSize=Number((e.target as HTMLInputElement).value);rebuild()};
async function togglePresentation(on:boolean){if(on&&!expanded)layout(true);presentation=on;document.body.classList.toggle("presentation",on);$("presentation").setAttribute("aria-pressed",String(on));try{if(on&&!document.fullscreenElement&&document.documentElement.requestFullscreen)await document.documentElement.requestFullscreen();else if(!on&&document.fullscreenElement)await document.exitFullscreen()}catch{/* CSS presentation still works */}resize()}
$("presentation").onclick=()=>void togglePresentation(!presentation);$("exit-presentation").onclick=()=>void togglePresentation(false);document.addEventListener("fullscreenchange",()=>{if(!document.fullscreenElement&&presentation)void togglePresentation(false)});document.addEventListener("keydown",e=>{if(e.key==="Escape"&&presentation)void togglePresentation(false);else if(e.key==="Escape"&&expanded)layout(false)});
$<HTMLInputElement>("speed").oninput=e=>speed=Number((e.target as HTMLInputElement).value);
$<HTMLInputElement>("density").oninput=e=>{density=Number((e.target as HTMLInputElement).value);rebuild();refreshPanels()};
$<HTMLInputElement>("zoom").oninput=e=>setZoom(Number((e.target as HTMLInputElement).value));
function renderPalettes(){const root=$("palettes");root.replaceChildren();for(const p of palettes){const b=document.createElement("button");b.className="swatch"+(colors===p.colors?" active":"");const s=document.createElement("span");s.textContent=p.name;const bar=document.createElement("b");for(const c of p.colors.slice(0,5)){const i=document.createElement("i");i.style.background=c;bar.append(i)}b.append(s,bar);b.onclick=()=>{colors=p.colors;document.documentElement.style.setProperty("--accent",colors[0]);document.documentElement.classList.toggle("paper",p.name==="Бумага");renderPalettes();refreshPanels()};root.append(b)}}renderPalettes();
function refreshDetails(){const n=selected===null?undefined:nodeMap.get(selected);const el=$("details");el.replaceChildren();if(!n){text(el,"Выберите запись на карте");return}const info=document.createElement("p");text(info,n.title+" · "+n.category+" · "+folderOf(n)+" · "+(neighbor.get(n.id)?.size??0)+" связей");el.append(info);for(const id of Array.from(neighbor.get(n.id)??[]).slice(0,30)){const other=nodeMap.get(id);if(other){const b=document.createElement("button");b.className="entry";text(b,other.title);b.onclick=()=>focusNode(id);el.append(b)}}}
function options(el:HTMLSelectElement,items:{value:string;label:string}[]){const old=el.value;el.replaceChildren();for(const i of items){const o=document.createElement("option");o.value=i.value;o.textContent=i.label;el.append(o)}if(items.some(i=>i.value===old))el.value=old}
function refreshRecords(){const q=$<HTMLInputElement>("search").value.trim().toLowerCase(),el=$("records");el.replaceChildren();const results=nodes.filter(n=>(!filter||n.category===filter)&&(n.title+" "+folderOf(n)).toLowerCase().includes(q));for(const n of results.slice(0,100)){const b=document.createElement("button");b.className="entry";text(b,n.title);b.onclick=()=>focusNode(n.id);el.append(b)}if(results.length>100){const p=document.createElement("p");text(p,"Показано 100 из "+results.length+"; уточните поиск.");el.append(p)}}
$<HTMLInputElement>("search").oninput=refreshRecords;
function refreshPanels(){const totals=categoryCounts();const overview=$("activity-grid");overview.replaceChildren();state.categories.forEach((c,i)=>{const item=document.createElement("div");item.className="activity-cell";item.style.setProperty("--cell",colors[i%colors.length]);item.style.setProperty("--order",String(i));const ring=document.createElement("i");text(ring,String(totals[i]??0));const label=document.createElement("span");text(label,c);item.append(ring,label);overview.append(item)});const cats=$("categories");cats.replaceChildren();state.categories.forEach((c,i)=>{const b=document.createElement("button");b.className="category-row"+(filter===c?" active":"");const label=document.createElement("span"),dot=document.createElement("i");dot.style.background=colors[i%colors.length];label.append(dot,document.createTextNode(c));const count=document.createElement("span");text(count,String(totals[i]??0));b.append(label,count);b.onclick=()=>{filter=filter===c?null:c;refreshPanels()};cats.append(b)});refreshRecords();refreshDetails();
 options($("category"),state.categories.map(c=>({value:c,label:c})));
 const items=state.nodes.map(n=>({value:String(n.id),label:n.title}));options($("source"),items);options($("target"),items);
 $<HTMLButtonElement>("link").querySelector("button")!.disabled=items.length<2;
 refreshCounts();
}
function refreshCounts(){text($("counts"),(demo?"ДЕМО: ":"")+"Записей "+nodes.length+" · Связей "+edges.length+" · На карте "+visible.length)}
async function post(path:string,body:unknown){const r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const s=await r.json();if(!r.ok)throw new Error(s.error??"Ошибка API");setState(s as Snapshot)}
$<HTMLFormElement>("add").onsubmit=async e=>{e.preventDefault();try{await post("/api/nodes",{title:$<HTMLInputElement>("title").value,category:$<HTMLSelectElement>("category").value,folder:$<HTMLInputElement>("folder").value});$<HTMLInputElement>("title").value="";text($("message"),"Запись сохранена")}catch(err){text($("message"),String(err))}};
$<HTMLFormElement>("link").onsubmit=async e=>{e.preventDefault();try{await post("/api/edges",{source:Number($<HTMLSelectElement>("source").value),target:Number($<HTMLSelectElement>("target").value)});text($("message"),"Связь сохранена")}catch(err){text($("message"),String(err))}};
$("save-settings").onclick=()=>{try{localStorage.setItem("atlas-visual-v2",JSON.stringify({palette:palettes.find(p=>p.colors===colors)?.name,speed,density,strength,groupSize}));text($("message"),"Настройки сохранены в браузере")}catch{ text($("message"),"Хранилище браузера недоступно") }};
$("export-png").onclick=()=>{canvas.toBlob(blob=>{if(!blob)return;const url=URL.createObjectURL(blob);const link=document.createElement("a");link.href=url;link.download="amatsumireika-atlas.png";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)},"image/png")};
try{const raw=localStorage.getItem("atlas-visual-v2");if(raw){const saved=JSON.parse(raw);const p=palettes.find(p=>p.name===saved.palette);if(p){colors=p.colors;document.documentElement.style.setProperty("--accent",colors[0]);document.documentElement.classList.toggle("paper",p.name==="Бумага")}if(Number.isFinite(saved.strength))strength=Math.max(0,Math.min(1,saved.strength));if(Number.isFinite(saved.groupSize))groupSize=Math.max(.55,Math.min(1,saved.groupSize));$<HTMLInputElement>("strength").value=String(strength);$<HTMLInputElement>("group-size").value=String(groupSize);if(Number.isFinite(saved.speed))speed=Math.max(0,Math.min(2,saved.speed));if(Number.isFinite(saved.density))density=Math.max(12,Math.min(180,saved.density));$<HTMLInputElement>("speed").value=String(speed);$<HTMLInputElement>("density").value=String(density);renderPalettes()}}catch{/* defaults remain */}
text($("legend"),"Нажмите на ядро, чтобы открыть полный атлас");
function clock(){text($("clock"),new Date().toLocaleTimeString("ru-RU"))}clock();setInterval(clock,1000);
fetch("/api/atlas").then(r=>{if(!r.ok)throw new Error("API "+r.status);return r.json()}).then(setState).catch(err=>{text($("status"),"API недоступен");text($("message"),String(err))});
