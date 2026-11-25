export {};
type NodeRecord={id:number;title:string;category:string};
type Edge={source:number;target:number};
type Snapshot={nodes:NodeRecord[];edges:Edge[];categories:string[]};
type Point={x:number;y:number};
type Layout="radial"|"clusters"|"hex";
const $=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const canvas=$<HTMLCanvasElement>("graph"), stage=$("stage"), ctx=canvas.getContext("2d")!;
const palettes=[{name:"Небесная",colors:["#41d9cc","#6fa0e8","#aa91e9","#e9b66e","#5ebd91","#e482a5","#80aab9","#e0d48f","#5faecb"]},{name:"Императорская",colors:["#e8c470","#d9e4e8","#be9860","#f2dfaf","#a4bfae","#c78981","#d8c9ed","#cfa346","#8aaab5"]},{name:"Полярная",colors:["#5ccde8","#9dbafa","#ba9be8","#79e5d7","#a5c2cf","#d6a9d4","#9bcb93","#e1c891","#87a5d6"]}];
let colors=palettes[0].colors, state:Snapshot={nodes:[],edges:[],categories:["Личность","Знания","Навыки","Опыт","Документы","Цели","Эмоции","Логика","Воспоминания"]};
let nodes:NodeRecord[]=[],edges:Edge[]=[],demo=true,mode:Layout="radial",expanded=false,selected:number|null=null,hover:number|null=null,filter:string|null=null;
let width=1,height=1,zoom=1,pan:Point={x:0,y:0},speed=.6,density=84,phase=0,last=0,drag:Point|null=null,dragOrigin:Point|null=null,moved=false;
let positions=new Map<number,Point>(),targets=new Map<number,Point>(),centers:Point[]=[],visible:NodeRecord[]=[],groups:NodeRecord[][]=[],groupCounts:number[]=[],neighbor=new Map<number,Set<number>>(),nodeMap=new Map<number,NodeRecord>();
let cursor:Point={x:0,y:0},fit=1;
const reduced=matchMedia("(prefers-reduced-motion: reduce)").matches;
const tau=Math.PI*2;
function makeDemo():{nodes:NodeRecord[];edges:Edge[]}{
 const ns=state.categories.flatMap((category,g)=>Array.from({length:28+g*3},(_,i)=>({id:-(g*1000+i+1),title:category+" · "+(i+1),category})));
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
function color(n:NodeRecord){return colors[Math.max(0,state.categories.indexOf(n.category))%colors.length]}
function polar(a:number,r:number):Point{return{x:Math.cos(a)*r,y:Math.sin(a)*r}}
function rebuild(){
 const cats=state.categories;groups=cats.map(c=>nodes.filter(n=>n.category===c));groupCounts=groups.map(g=>g.length);
 const all=groups.map(g=>g.slice(0,density));
 if(selected!==null){const n=nodeMap.get(selected);if(n){const g=cats.indexOf(n.category);if(g>=0&&!all[g].some(x=>x.id===n.id))all[g].push(n)}}
 visible=all.flat();targets=new Map();centers=[];
 const radius=mode==="hex"?100:mode==="clusters"?215:240;
 for(let g=0;g<cats.length;g++){
  const a=-Math.PI/2+tau*g/cats.length;
  const center=mode==="hex"?hexCenter(g):polar(a,radius);
  centers.push(center);
  all[g].forEach((n,i)=>{
   let p:Point;
   if(mode==="radial"){
    const col=i%9,row=Math.floor(i/9);const angle=a+((col-4)/9)*tau/cats.length*.84;
    p=polar(angle,115+row*15+(col%2)*4);
   }else{
    const rr=Math.sqrt((i+.5)/Math.max(all[g].length,1))*(mode==="hex"?55:62);const q=i*2.399963;
    p={x:center.x+Math.cos(q)*rr,y:center.y+Math.sin(q)*rr};
   }
   targets.set(n.id,p);if(!positions.has(n.id))positions.set(n.id,{x:0,y:0});
  });
 }
 for(const id of positions.keys())if(!targets.has(id))positions.delete(id);
}
function hexCenter(i:number):Point{
 const axial=[[1,0],[0,1],[-1,1],[-1,0],[0,-1],[1,-1],[2,-1],[1,1],[-1,2]];
 const [q,r]=axial[i%axial.length];return{x:Math.sqrt(3)*85*(q+r/2),y:127.5*r};
}
function resize(){const box=stage.getBoundingClientRect();width=Math.max(1,box.width);height=Math.max(1,box.height);const dpr=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);fit=Math.max(.1,Math.min(width/700,height/760));ctx.setTransform(dpr,0,0,dpr,0,0)}
new ResizeObserver(resize).observe(stage);resize();
function scale(){return fit*zoom}
function world(p:Point):Point{return{x:(p.x-width/2-pan.x)/scale(),y:(p.y-height/2-pan.y)/scale()}}
function worldToScreen(p:Point):Point{return{x:width/2+pan.x+p.x*scale(),y:height/2+pan.y+p.y*scale()}}
function circle(x:number,y:number,r:number,stroke:string,fill?:string){ctx.beginPath();ctx.arc(x,y,r,0,tau);if(fill){ctx.fillStyle=fill;ctx.fill()}ctx.strokeStyle=stroke;ctx.stroke()}
function line(a:Point,b:Point,c:string){ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle=c;ctx.stroke()}
function polygon(p:Point,r:number,c:string){ctx.beginPath();for(let j=0;j<6;j++){const v=polar(Math.PI/6+j*tau/6,r);if(j===0)ctx.moveTo(p.x+v.x,p.y+v.y);else ctx.lineTo(p.x+v.x,p.y+v.y)}ctx.closePath();ctx.fillStyle=c+"0b";ctx.fill();ctx.strokeStyle=c+"55";ctx.stroke()}
function drawCore(){
 const glow=ctx.createRadialGradient(0,0,0,0,0,66);glow.addColorStop(0,"#45d9ca28");glow.addColorStop(1,"#45d9ca00");ctx.fillStyle=glow;ctx.fillRect(-66,-66,132,132);
 for(let i=0;i<5;i++)circle(0,0,18+i*9,"#45d9ca"+(i===0?"a0":"28"));
 for(let i=0;i<36;i++){const a=i*tau/36+phase*.15;const p=polar(a,28+5*Math.sin(3*a+phase));circle(p.x,p.y,2.5,"#45d9ca77")}
 ctx.fillStyle="#d8eee9";ctx.font="10px system-ui";ctx.textAlign="center";ctx.fillText("ЯДРО",0,67);
}
function frame(now:number){
 const dt=last?Math.min(50,now-last):16;last=now;if(!reduced)phase+=dt*.001*speed;
 const dpr=canvas.width/width;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
 ctx.save();ctx.translate(width/2+pan.x,height/2+pan.y);ctx.scale(scale(),scale());ctx.lineWidth=1/Math.max(scale(),.45);
 const step=reduced?1:1-Math.pow(.001,dt/1000);
 for(const [id,t] of targets){const p=positions.get(id)!;p.x+=(t.x-p.x)*step;p.y+=(t.y-p.y)*step}
 if(mode==="radial"){
  for(let r=92;r<=310;r+=36)circle(0,0,r,"#18323d70");
  for(let i=0;i<90;i++){const a=i*tau/90;const p=polar(a,310),q=polar(a,314+(i%5===0?4:0));line(p,q,"#25434d70")}
 }else if(mode==="clusters"){circle(0,0,215,"#25434d50")}
 centers.forEach((c,g)=>{
  const col=colors[g%colors.length];const active=!filter||filter===state.categories[g];ctx.globalAlpha=active?1:.19;
  if(mode==="hex"){polygon(c,83,col);circle(c.x,c.y,24,col+"44")}
  else if(mode==="clusters"){circle(c.x,c.y,72,col+"77",col+"0a");circle(c.x,c.y,48,col+"22")}
  else{line(polar(-Math.PI/2+g*tau/centers.length,83),c,col+"30");circle(c.x,c.y,9,col+"a0",col+"15")}
  const label=mode==="radial"?polar(-Math.PI/2+g*tau/centers.length,280):{x:c.x,y:c.y+(mode==="hex"?-64:-79)};
  ctx.textAlign="center";ctx.font="10px system-ui";ctx.fillStyle=col;ctx.fillText(state.categories[g]+" · "+groupCounts[g],label.x,label.y);
 });
 ctx.globalAlpha=1;
 const focus=hover??selected;
 if(focus!==null){const p=positions.get(focus);if(p)for(const id of neighbor.get(focus)??[]){const q=positions.get(id);if(q)line(p,q,"#81e6dc95")}}
 for(const n of visible){
  const p=positions.get(n.id)!;const col=color(n);const lit=n.id===focus||n.id===selected;const related=focus!==null&&neighbor.get(focus)?.has(n.id);
  const dim=(filter!==null&&n.category!==filter)||(focus!==null&&!lit&&!related);
  ctx.globalAlpha=dim?.22:1;
  const r=lit?5:related?3.4:1.5+(.5+.5*Math.sin(phase*2+n.id*.71))*.7;
  if(lit||related)circle(p.x,p.y,r+4,col+"66");
  circle(p.x,p.y,r,col,col+(lit?"ff":"b0"));
 }
 ctx.globalAlpha=1;drawCore();
 ctx.restore();requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
function local(e:PointerEvent|WheelEvent|MouseEvent):Point{const r=canvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top}}
function hit(p:Point):number|null{let best:number|null=null,min=12*12;for(const n of visible){if(filter&&n.category!==filter)continue;const q=worldToScreen(positions.get(n.id)!);const d=(q.x-p.x)**2+(q.y-p.y)**2;if(d<min){min=d;best=n.id}}return best}
function tooltip(id:number|null,p:Point){const t=$("tooltip");const n=id===null?undefined:nodeMap.get(id);t.hidden=!n;if(n){text(t,n.title+"\n"+n.category+" · связей: "+(neighbor.get(n.id)?.size??0));t.style.left=Math.max(4,Math.min(width-194,p.x+14))+"px";t.style.top=Math.max(4,Math.min(height-75,p.y+12))+"px"}}
function choose(id:number|null){selected=id;rebuild();refreshDetails()}
canvas.addEventListener("pointerdown",e=>{if(e.button!==0)return;drag=local(e);dragOrigin=drag;moved=false;canvas.setPointerCapture(e.pointerId)});
canvas.addEventListener("pointermove",e=>{cursor=local(e);if(drag){pan.x+=cursor.x-drag.x;pan.y+=cursor.y-drag.y;drag=cursor;if(dragOrigin&&Math.hypot(cursor.x-dragOrigin.x,cursor.y-dragOrigin.y)>4)moved=true;hover=null;tooltip(null,cursor)}else{hover=hit(cursor);tooltip(hover,cursor)}});
canvas.addEventListener("pointerup",e=>{if(!moved&&drag)choose(hit(local(e)));drag=null;dragOrigin=null});
canvas.addEventListener("pointercancel",()=>{drag=null;dragOrigin=null});
canvas.addEventListener("pointerleave",()=>{hover=null;tooltip(null,cursor)});
function setZoom(z:number,p:Point={x:width/2,y:height/2}){const w=world(p);zoom=Math.max(.35,Math.min(5,z));pan={x:p.x-width/2-w.x*scale(),y:p.y-height/2-w.y*scale()};$<HTMLInputElement>("zoom").value=String(zoom)}
canvas.addEventListener("wheel",e=>{e.preventDefault();setZoom(zoom*Math.exp(-e.deltaY*.0015),local(e))},{passive:false});
function focusNode(id:number){choose(id);const p=targets.get(id);if(p){zoom=3;pan={x:-p.x*scale(),y:-p.y*scale()};$<HTMLInputElement>("zoom").value=String(zoom)}}
canvas.addEventListener("dblclick",e=>{const id=hit(local(e));if(id!==null)focusNode(id)});
function reset(){zoom=1;pan={x:0,y:0};$<HTMLInputElement>("zoom").value="1";filter=null;choose(null);refreshPanels()}
$("reset").onclick=reset;
function layout(isExpanded:boolean){expanded=isExpanded;$("layout").classList.toggle("expanded",expanded);$("home").classList.toggle("active",!expanded);$("atlas").classList.toggle("active",expanded);text($("subtitle"),expanded?"Детальная карта памяти":"Командный центр · живое ядро");reset()}
$("home").onclick=()=>layout(false);$("atlas").onclick=()=>layout(true);
document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach(b=>b.onclick=()=>{mode=b.dataset.mode as Layout;document.querySelectorAll("[data-mode]").forEach(x=>x.classList.toggle("active",x===b));rebuild()});
$<HTMLInputElement>("speed").oninput=e=>speed=Number((e.target as HTMLInputElement).value);
$<HTMLInputElement>("density").oninput=e=>{density=Number((e.target as HTMLInputElement).value);rebuild()};
$<HTMLInputElement>("zoom").oninput=e=>setZoom(Number((e.target as HTMLInputElement).value));
function renderPalettes(){const root=$("palettes");root.replaceChildren();for(const p of palettes){const b=document.createElement("button");b.className="swatch"+(colors===p.colors?" active":"");const s=document.createElement("span");s.textContent=p.name;const bar=document.createElement("b");for(const c of p.colors.slice(0,5)){const i=document.createElement("i");i.style.background=c;bar.append(i)}b.append(s,bar);b.onclick=()=>{colors=p.colors;document.documentElement.style.setProperty("--accent",colors[0]);renderPalettes();refreshPanels()};root.append(b)}}renderPalettes();
function refreshDetails(){const n=selected===null?undefined:nodeMap.get(selected);const el=$("details");el.replaceChildren();if(!n){text(el,"Выберите запись на карте");return}const info=document.createElement("p");text(info,n.title+" · "+n.category+" · "+(neighbor.get(n.id)?.size??0)+" связей");el.append(info);for(const id of Array.from(neighbor.get(n.id)??[]).slice(0,30)){const other=nodeMap.get(id);if(other){const b=document.createElement("button");b.className="entry";text(b,other.title);b.onclick=()=>focusNode(id);el.append(b)}}}
function options(el:HTMLSelectElement,items:{value:string;label:string}[]){const old=el.value;el.replaceChildren();for(const i of items){const o=document.createElement("option");o.value=i.value;o.textContent=i.label;el.append(o)}if(items.some(i=>i.value===old))el.value=old}
function refreshRecords(){const q=$<HTMLInputElement>("search").value.trim().toLowerCase(),el=$("records");el.replaceChildren();const results=nodes.filter(n=>(!filter||n.category===filter)&&n.title.toLowerCase().includes(q));for(const n of results.slice(0,100)){const b=document.createElement("button");b.className="entry";text(b,n.title);b.onclick=()=>focusNode(n.id);el.append(b)}if(results.length>100){const p=document.createElement("p");text(p,"Показано 100 из "+results.length+"; уточните поиск.");el.append(p)}}
$<HTMLInputElement>("search").oninput=refreshRecords;
function refreshPanels(){const cats=$("categories");cats.replaceChildren();state.categories.forEach((c,i)=>{const b=document.createElement("button");b.className="category-row"+(filter===c?" active":"");const label=document.createElement("span"),dot=document.createElement("i");dot.style.background=colors[i%colors.length];label.append(dot,document.createTextNode(c));const count=document.createElement("span");text(count,String(groupCounts[i]??0));b.append(label,count);b.onclick=()=>{filter=filter===c?null:c;refreshPanels()};cats.append(b)});refreshRecords();refreshDetails();
 options($("category"),state.categories.map(c=>({value:c,label:c})));
 const items=state.nodes.map(n=>({value:String(n.id),label:n.title}));options($("source"),items);options($("target"),items);
 $<HTMLButtonElement>("link").querySelector("button")!.disabled=items.length<2;
 text($("counts"),(demo?"ДЕМО: ":"")+"Записей "+nodes.length+" · Связей "+edges.length+" · На карте "+visible.length);
}
async function post(path:string,body:unknown){const r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const s=await r.json();if(!r.ok)throw new Error(s.error??"Ошибка API");setState(s as Snapshot)}
$<HTMLFormElement>("add").onsubmit=async e=>{e.preventDefault();try{await post("/api/nodes",{title:$<HTMLInputElement>("title").value,category:$<HTMLSelectElement>("category").value});$<HTMLInputElement>("title").value="";text($("message"),"Запись сохранена")}catch(err){text($("message"),String(err))}};
$<HTMLFormElement>("link").onsubmit=async e=>{e.preventDefault();try{await post("/api/edges",{source:Number($<HTMLSelectElement>("source").value),target:Number($<HTMLSelectElement>("target").value)});text($("message"),"Связь сохранена")}catch(err){text($("message"),String(err))}};
function clock(){text($("clock"),new Date().toLocaleTimeString("ru-RU"))}clock();setInterval(clock,1000);
fetch("/api/atlas").then(r=>{if(!r.ok)throw new Error("API "+r.status);return r.json()}).then(setState).catch(err=>{text($("status"),"API недоступен");text($("message"),String(err))});
