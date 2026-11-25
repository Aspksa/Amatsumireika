export {};
type NodeRecord={id:number;title:string;category:string;folder?:string;created_at?:string|null};
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
let showLabels=true, groupHover=-1, revealAt=0, groupRadii:number[]=[], mapExtent=350, currentLimit=84;
let extentX=350,extentY=350,activeGroup:string|null=null;
let originCache:Point={x:0,y:0}, folderPrefix="", groupPage=0, groupSlots=new Map<string,number>(), frameBudget=6000, slowFrames=0, fastFrames=0;
let groupAngles:number[]=[], groupWidths:number[]=[], drawEdges:Edge[]=[], freshNodes=new Map<number,number>(), freshEdges=new Map<string,number>(), initialized=false;
let hitBins=new Map<string,number[]>(), positionsVersion=0, binsVersion=-1, groupLayout:Point[]=[], geometryKey="";
let groupConnections=new Map<string,{a:number;b:number;count:number}>();
const CELL=24;
function edgeKey(e:Edge){return e.source+":"+e.target}
function isRadial(){return mode==="radial"||mode==="hud"}
function groupedFolder(n:NodeRecord){const f=folderOf(n);if(!folderPrefix)return f;const prefix=folderPrefix+"/";return f===folderPrefix?f:f.startsWith(prefix)?f.slice(0,prefix.length+f.slice(prefix.length).split("/")[0].length):null}
function groupAngle(g:number){return groupAngles[g]??(-Math.PI/2+tau*g/Math.max(1,groupNames.length))}
function ringSlot(i:number,spacing:number):Point{let ring=1;while(i>=6*ring){i-=6*ring;ring++}return polar(-Math.PI/2+tau*i/(6*ring),ring*spacing)}
function screenVisible(p:Point,r=12){const s=worldToScreen(p);return s.x>=-r&&s.y>=-r&&s.x<=Math.min(width,origin().x*2)+r&&s.y<=height+r}
function groupLabel(g:number):Point{const c=centers[g];return isRadial()&&groupNames.length<=12?polar(groupAngle(g),expanded?230:148):{x:c.x,y:c.y-groupRadii[g]-9}}
function nodeKind(n:NodeRecord){return n.category==="Документы"?"file":n.category==="Навыки"||n.category==="Цели"||n.category==="Логика"?"process":"memory"}
function age(n:NodeRecord){if(!n.created_at)return "Дата неизвестна";const d=new Date(n.created_at);return Number.isFinite(d.getTime())?d.toLocaleDateString("ru-RU")+" · "+Math.max(0,Math.floor((Date.now()-d.getTime())/86400000))+" дн.":"Дата неизвестна"}
function groupNameOf(n:NodeRecord){return expanded&&grouping==="folder"?groupedFolder(n):n.category}
function inScope(n:NodeRecord){return groupNameOf(n)!==null}
function activeChain(id:number|null){const set=new Set<number>();if(id!==null){set.add(id);for(const a of neighbor.get(id)??[]){set.add(a);if(set.size>=200)break;for(const b of neighbor.get(a)??[]){set.add(b);if(set.size>=200)break}if(set.size>=200)break}}return set}
function origin():Point{return originCache}
function limitAt(z:number){return expanded?Math.min(600,Math.round(density*Math.max(1,z/1.7))):Math.min(50,density)}
function allowed(n:NodeRecord){return inScope(n)&&(!filter||n.category===filter)&&(!activeGroup||groupNameOf(n)===activeGroup)}
function radialIcon(g:number){return groupNames.length>12?centers[g]:polar(groupAngle(g),248)}
const symbols=["◇","▤","✦","◈","▣","◎","♡","⌘","◉"];
const categoryKind=["ЯДРО","ПАМЯТЬ","ПРОЦЕССЫ","ПАМЯТЬ","ПАМЯТЬ","ПРОЦЕССЫ","ЯДРО","ПРОЦЕССЫ","ПАМЯТЬ"];
function modulePoint(i:number){return polar(-Math.PI/2+i*tau/Math.max(1,groupNames.length*3),269)}
function hubPoint(i:number){return polar(groupAngle(i),114)}
function folderOf(n:NodeRecord){return n.folder?.trim()||"Без папки"}
function groupColor(g:number){return colors[g%colors.length]}
function groupKey(g:number){return (expanded?grouping:"category")+":"+folderPrefix+":"+groupNames[g]}
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
 const previous=nodeMap,oldEdges=new Set(edges.map(edgeKey));state=s;demo=s.nodes.length===0;const data=demo?makeDemo():s;nodes=data.nodes;edges=data.edges;if(initialized&&!demo){const now=performance.now();for(const n of nodes)if(!previous.has(n.id))freshNodes.set(n.id,now);for(const e of edges)if(!oldEdges.has(edgeKey(e)))freshEdges.set(edgeKey(e),now)}initialized=true;geometryKey="";
 nodeMap=new Map(nodes.map(n=>[n.id,n]));neighbor=new Map();
 for(const e of edges){for(const [a,b] of [[e.source,e.target],[e.target,e.source]]){if(!neighbor.has(a))neighbor.set(a,new Set());neighbor.get(a)!.add(b)}}
 if(selected!==null&&!nodeMap.has(selected))selected=null;hover=null;if(demo)positions.clear();rebuild();refreshPanels();
 text($("status"),demo?"ДЕМО · БД ПУСТА":"ЛОКАЛЬНО · БД АКТИВНА");
}
function color(n:NodeRecord){return groupColor(nodeGroups.get(n.id)??Math.max(0,state.categories.indexOf(n.category)))}
function polar(a:number,r:number):Point{return{x:Math.cos(a)*r,y:Math.sin(a)*r}}
function rebuild(sampleZoom=zoom){
 const folderMode=expanded&&grouping==="folder";
 const key=[expanded,grouping,folderPrefix,mode,limitAt(sampleZoom),frameBudget,groupSize,strength,selected,Array.from(collapsed).sort().join("|")].join(";");
 if(key===geometryKey)return;geometryKey=key;
 const buckets=new Map<string,NodeRecord[]>();
 for(const n of nodes){const k=folderMode?groupedFolder(n):n.category;if(k===null)continue;const list=buckets.get(k)??[];list.push(n);buckets.set(k,list)}
 const names=folderMode?Array.from(buckets.keys()):state.categories.slice();
 const scope=(folderMode?"folder:"+folderPrefix:"category")+":";
 let next=0;for(const name of names){const n=groupSlots.get(scope+name);if(n!==undefined)next=Math.max(next,n+1)}
 for(const name of names)if(!groupSlots.has(scope+name))groupSlots.set(scope+name,next++);
 groupNames=names.sort((a,b)=>(groupSlots.get(scope+a)??0)-(groupSlots.get(scope+b)??0));
 groups=groupNames.map(c=>buckets.get(c)??[]);groupCounts=groups.map(g=>g.length);nodeGroups=new Map();
 groups.forEach((g,i)=>g.forEach(n=>nodeGroups.set(n.id,i)));
 currentLimit=limitAt(sampleZoom);
 const open=groups.reduce((sum,g,i)=>sum+(expanded&&collapsed.has(groupKey(i))?0:Number(g.length>0)),0);
 const quota=Math.max(0,Math.floor(frameBudget/Math.max(1,open)));
 let remaining=frameBudget;
 const all=groups.map((g,i)=>{if(expanded&&collapsed.has(groupKey(i)))return [];const take=Math.min(g.length,currentLimit,quota,remaining);remaining-=take;return g.slice(0,take)});
 // Reserve a single selected record even when the current LOD would omit it.
 if(selected!==null){const n=nodeMap.get(selected),g=nodeGroups.get(selected);if(n&&g!==undefined&&!collapsed.has(groupKey(g))&&!all[g].some(x=>x.id===n.id)){if(remaining<=0){const donor=all.find(x=>x.length>0);donor?.pop()}all[g].push(n)}}
 groupRadii=groups.map(g=>Math.max(48,Math.min(126,35+Math.sqrt(Math.min(g.length,600))*3.8))*groupSize);
 const maxR=Math.max(54,...groupRadii);if(mode==="hex")groupRadii=groupRadii.map(()=>maxR+12);
 const spacing=mode==="hex"?Math.sqrt(3)*(maxR+15):Math.max(mode==="tile"?220:180,maxR*2+38);
 const count=groupNames.length,weights=groupCounts.map(n=>Math.max(1,Math.sqrt(n))),total=weights.reduce((x,y)=>x+y,0)||1;
 let angle=-Math.PI/2;groupAngles=[];groupWidths=[];
 for(let g=0;g<count;g++){const arc=tau*(.45/Math.max(1,count)+.55*weights[g]/total);groupAngles.push(angle+arc/2);groupWidths.push(arc);angle+=arc}
 visible=all.flat();targets=new Map();centers=[];
 const ringR=Math.max(210,(maxR+20)/Math.sin(Math.PI/Math.max(3,count)));
 const many=expanded&&count>12;
 const axial=hexSlots(count);
 for(let g=0;g<count;g++){
  const a=groupAngle(g),slot=groupSlots.get(scope+groupNames[g])??g;
  const center=mode==="hex"?hexCenter(axial[g],spacing):mode==="tile"?ringSlot(slot,spacing):many?ringSlot(slot,spacing):polar(a,mode==="clusters"?ringR:mode==="force"?230:218);
  centers.push(center);
  all[g].forEach((n,i)=>{
   let p:Point;
   if(isRadial()&&!many){
    const cols=Math.max(3,Math.ceil(Math.sqrt(all[g].length)*1.25)),col=i%cols,row=Math.floor(i/cols);
    const theta=a+((col-(cols-1)/2)/cols)*groupWidths[g]*.78;
    const inner=expanded?86:125,outer=expanded?205:218,rows=Math.max(1,Math.ceil(all[g].length/cols)-1);
    if(expanded)p=polar(theta,inner+row*(outer-inner)/rows+(col%2)*2);
    else{const q=hubPoint(g);p=polar(a+Math.sin(n.id*12.9898)*.22+(col-(cols-1)/2)*.055,inner+((i*37)%101)/100*(outer-inner));if(i%7===0)p={x:q.x+(p.x-q.x)*.55,y:q.y+(p.y-q.y)*.55}}
   }else if(mode==="tile"){
    const cols=Math.ceil(Math.sqrt(all[g].length)),cell=110*groupSize/Math.max(1,cols);
    p={x:center.x+(i%cols-(cols-1)/2)*cell,y:center.y+(Math.floor(i/cols)-(cols-1)/2)*cell};
   }else{
    const rr=Math.sqrt((i+.5)/Math.max(all[g].length,1))*groupRadii[g]*.80,q=i*2.399963;
    p={x:center.x+Math.cos(q)*rr,y:center.y+Math.sin(q)*rr};
   }
   targets.set(n.id,p);if(!positions.has(n.id))positions.set(n.id,{...center});
  });
 }
 if(mode==="force"&&!many&&visible.length<=1800)relaxForce();
 for(const id of positions.keys())if(!targets.has(id))positions.delete(id);
 extentX=350;extentY=350;if(expanded&&(many||mode==="hex"||mode==="clusters"||mode==="tile")){centers.forEach((c,i)=>{const margin=mode==="tile"?100:groupRadii[i]+35;extentX=Math.max(extentX,Math.abs(c.x)+margin);extentY=Math.max(extentY,Math.abs(c.y)+margin)})}
 drawEdges=[];groupConnections=new Map();
 for(const e of edges){const a=nodeGroups.get(e.source),b=nodeGroups.get(e.target);if(a!==undefined&&b!==undefined&&a!==b){const lo=Math.min(a,b),hi=Math.max(a,b),k=lo+":"+hi,old=groupConnections.get(k);if(old)old.count++;else if(groupConnections.size<10000)groupConnections.set(k,{a:lo,b:hi,count:1})}if(drawEdges.length<2500&&targets.has(e.source)&&targets.has(e.target))drawEdges.push(e)}
 positionsVersion++;refreshGroupControls();resize();
}
function hexSlots(count:number):number[][]{const out:number[][]=[];const dirs=[[0,1],[-1,1],[-1,0],[0,-1],[1,-1],[1,0]];for(let r=1;out.length<count;r++){let q=r,s=-r;for(const [dq,ds] of dirs)for(let j=0;j<r&&out.length<count;j++){out.push([q,s]);q+=dq;s+=ds}}return out}
function hexCenter(p:number[],spacing:number):Point{const [q,r]=p;return{x:spacing*(q+r/2),y:spacing*Math.sqrt(3)/2*r}}
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
 const root=$("graph-groups");root.replaceChildren();const pages=Math.max(1,Math.ceil(groupNames.length/100));groupPage=Math.max(0,Math.min(pages-1,groupPage));text($("group-page"),(groupPage+1)+" / "+pages+" · "+groupNames.length);text($("folder-path"),folderPrefix||"Все папки");$("folder-up").hidden=!folderPrefix;
 groupNames.slice(groupPage*100,(groupPage+1)*100).forEach((name,j)=>{const i=groupPage*100+j;const b=document.createElement("button");b.className="group-toggle";const closed=collapsed.has(groupKey(i));b.setAttribute("aria-expanded",String(!closed));text(b,(closed?"▸ ":"▾ ")+name+" · "+groupCounts[i]);b.onclick=()=>{if(closed)collapsed.delete(groupKey(i));else collapsed.add(groupKey(i));if(selected!==null&&nodeGroups.get(selected)===i&& !closed)selected=null;rebuild();refreshDetails();refreshCounts()};root.append(b);if(grouping==="folder"&&expanded&&groups[i].some(n=>folderOf(n).startsWith(name+"/"))){const sub=document.createElement("button");text(sub,"↳ "+name);sub.onclick=()=>{folderPrefix=name;activeGroup=null;selected=null;groupPage=0;geometryKey="";reset()};root.append(sub)}})
}
$("group-prev").onclick=()=>{groupPage--;refreshGroupControls()};$("group-next").onclick=()=>{groupPage++;refreshGroupControls()};$("folder-up").onclick=()=>{folderPrefix=folderPrefix.split("/").slice(0,-1).join("/");groupPage=0;geometryKey="";reset()};
function resize(){const box=stage.getBoundingClientRect();width=Math.max(1,box.width);height=Math.max(1,box.height);const panel=$("right").getBoundingClientRect();originCache={x:expanded&&!presentation&&innerWidth>760&&!document.body.classList.contains("panel-hidden")?Math.max(1,Math.min(width,panel.left-box.left))/2:width/2,y:height/2};const dpr=Math.min(devicePixelRatio||1,2);const cw=Math.round(width*dpr),ch=Math.round(height*dpr);if(canvas.width!==cw)canvas.width=cw;if(canvas.height!==ch)canvas.height=ch;fit=Math.max(.025,Math.min((origin().x*2)/(expanded?extentX*2.04:590),height/(expanded?extentY*2.08:630)));ctx.setTransform(dpr,0,0,dpr,0,0)}
new ResizeObserver(resize).observe(stage);resize();
function scale(){return fit*zoom}
function world(p:Point):Point{const o=origin();return{x:(p.x-o.x-pan.x)/scale(),y:(p.y-o.y-pan.y)/scale()}}
function worldToScreen(p:Point):Point{const o=origin();return{x:o.x+pan.x+p.x*scale(),y:o.y+pan.y+p.y*scale()}}
function circle(x:number,y:number,r:number,stroke:string,fill?:string){ctx.beginPath();ctx.arc(x,y,r,0,tau);if(fill){ctx.fillStyle=fill;ctx.fill()}ctx.strokeStyle=stroke;ctx.stroke()}
function line(a:Point,b:Point,c:string){ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle=c;ctx.stroke()}
function polygon(p:Point,r:number,c:string){ctx.beginPath();for(let j=0;j<6;j++){const v=polar(Math.PI/6+j*tau/6,r);if(j===0)ctx.moveTo(p.x+v.x,p.y+v.y);else ctx.lineTo(p.x+v.x,p.y+v.y)}ctx.closePath();ctx.fillStyle=c+"13";ctx.fill();ctx.strokeStyle=c+"77";ctx.stroke()}
function drawCore(){
 const c=colors[0];
 if(expanded){
  circle(0,0,72,gridInk());circle(0,0,33,c+"aa",paper()?"#faf8f0":"#0a121b");
  if(mode==="hex"||mode==="clusters"){for(let i=0;i<40;i++){const p=polar(i*tau/40+phase*.05,43);circle(p.x,p.y,7,c+"32")}}
  ctx.strokeStyle=paper()?"#21313a":"#e2e9ed";ctx.beginPath();ctx.arc(0,0,12,0,tau);ctx.stroke();ctx.beginPath();ctx.ellipse(0,0,13,7,-.75,0,tau);ctx.stroke();
  ctx.fillStyle=paper()?"#21313a":"#c2d1d9";ctx.font="8px "+mono;ctx.textAlign="center";ctx.fillText("ЯДРО ЛИЧНОСТИ",0,47);if(mode==="hex"||mode==="clusters"){for(let j=0;j<12;j++){const p=polar(j*tau/12+phase*.03,61);circle(p.x,p.y,6,c+"55");ctx.font="7px "+mono;ctx.fillStyle=c;ctx.fillText(symbols[j%9],p.x,p.y+2)}}return;
 }
 ctx.save();ctx.scale(1.45,1.45);const pulse=1+.07*Math.sin(phase*1.7);
 const glow=ctx.createRadialGradient(0,0,0,0,0,64);glow.addColorStop(0,c+"35");glow.addColorStop(1,c+"00");ctx.fillStyle=glow;ctx.fillRect(-64,-64,128,128);
 for(let layer=0;layer<4;layer++){const count=80+layer*24;for(let i=0;i<count;i++){const a=i*2.399963+phase*(layer%2===0?.18:-.13)*(1+layer*.28);const lat=Math.acos(1-2*(i+.5)/count),rad=(14+layer*5)*pulse;const x=Math.cos(a)*Math.sin(lat)*rad,y=Math.cos(lat)*rad*.82+Math.sin(a)*Math.sin(lat)*rad*.26;const p={x,y};const col=groupColor(layer);if(i%8===0)line(p,{x:x*.65,y:y*.65},col+"26");circle(x,y,i%11===0?1.4:.55+layer*.12,col+"00",col+(i%7===0?"e8":"80"))}}
 ctx.fillStyle=c;ctx.font="8px "+mono;ctx.textAlign="center";ctx.fillText("КОГНИТИВНОЕ ЯДРО",0,43);ctx.restore();ctx.textAlign="center";
 for(let i=0;i<groupNames.length*3;i++){const p=modulePoint(i),g=i%groupNames.length,col=groupColor(g),kind=Math.floor(i/groupNames.length);circle(p.x,p.y,19,col+(groupHover===g?"aa":"38"),paper()?"#f2f0e8":"#101c27");ctx.fillStyle=groupHover===g?col:(paper()?"#52646c":"#91a4b0");ctx.font="15px "+mono;ctx.fillText(kind===0?symbols[g%9]:kind===1?String(groupCounts[g]):"↔",p.x,p.y+5);ctx.font="8px "+mono;const label=kind===0?groupNames[g].slice(0,12):kind===1?"Записи":"Связи";const w=ctx.measureText(label).width+8;ctx.fillStyle=paper()?"#e7e6df":"#101c27";ctx.fillRect(p.x-w/2,p.y+21,w,11);ctx.fillStyle=col;ctx.fillText(label,p.x,p.y+29)}

}
function frame(now:number){
 const elapsed=last?now-last:16,dt=Math.min(50,elapsed);last=now;if(!reduced)phase+=dt*.001*speed;if(expanded&&elapsed>32){slowFrames++;fastFrames=0}else{slowFrames=0;fastFrames++}if(slowFrames>=90&&frameBudget>1500){frameBudget=Math.max(1500,Math.floor(frameBudget*.75));slowFrames=0;rebuild(cameraTarget?.zoom??zoom);recenterFocusTarget();refreshCounts()}else if(fastFrames>=360&&frameBudget<6000){frameBudget=Math.min(6000,frameBudget+750);fastFrames=0;rebuild(cameraTarget?.zoom??zoom);recenterFocusTarget();refreshCounts()}
 if(cameraTarget){const ease=reduced?1:1-Math.pow(.0005,dt/1000);zoom+=(cameraTarget.zoom-zoom)*ease;pan.x+=(cameraTarget.pan.x-pan.x)*ease;pan.y+=(cameraTarget.pan.y-pan.y)*ease;if(Math.abs(zoom-cameraTarget.zoom)<.005&&Math.hypot(pan.x-cameraTarget.pan.x,pan.y-cameraTarget.pan.y)<.5){zoom=cameraTarget.zoom;pan=cameraTarget.pan;cameraTarget=null}$<HTMLInputElement>("zoom").value=String(zoom)}
 const dpr=canvas.width/width;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
 const reveal=reduced?1:Math.min(1,(now-revealAt)/850);const load=$("atlas-loading");if(!load.hidden){$<HTMLProgressElement>("atlas-progress").value=Math.min(100,reveal*180);if(reveal>=.56)load.hidden=true}
 const o=origin();ctx.save();ctx.translate(o.x+pan.x,o.y+pan.y);ctx.scale(scale(),scale());ctx.lineWidth=1/Math.max(scale(),.45);
 const step=reduced?1:1-Math.pow(.001,dt/1000);
 let moving=false;for(const [id,t] of targets){const p=positions.get(id)!;if(Math.hypot(t.x-p.x,t.y-p.y)>.05){p.x+=(t.x-p.x)*step;p.y+=(t.y-p.y)*step;moving=true}else{p.x=t.x;p.y=t.y}}if(moving)positionsVersion++;
 if(isRadial()&&groupNames.length<=12){
  if(mode==="hud"){ctx.setLineDash([12,5,2,5]);for(let k=0;k<3;k++)circle(0,0,240+k*28,gridInk());ctx.setLineDash([]);for(let i=0;i<36;i++){const a=i*tau/36;line(polar(a,317),polar(a,326+(i%3===0?8:0)),groupColor(i)+"77")}}
  for(const r of (expanded?[74,216,322]:[114,269]))circle(0,0,r,gridInk());
  if(expanded){for(let g=0;g<groups.length;g++){const n=Math.min(54,groups[g].length);for(let j=0;j<n;j++){const angle=groupAngle(g)+(j%18-8.5)*Math.min(.032,groupWidths[g]/20)+phase*.015;const p=polar(angle,296+Math.floor(j/18)*13);circle(p.x,p.y,5.6,groupColor(g)+"88","#101c27");if(zoom>.85){ctx.font="6.5px "+mono;ctx.textAlign="center";ctx.fillStyle=groupColor(g);ctx.fillText(symbols[(g+j)%9],p.x,p.y+2)}}}}
 }else if(mode==="clusters"){circle(0,0,215,"#25434d50")}
 centers.forEach((c,g)=>{
  if(expanded&&!screenVisible(c,(groupRadii[g]+130)*scale()))return;
  const col=groupColor(g);const active=(!filter||groups[g].some(n=>n.category===filter))&&(!activeGroup||groupNames[g]===activeGroup);ctx.globalAlpha=(active&&(groupHover<0||groupHover===g)?1:.19)*Math.min(1,reveal*2);
  if(mode==="hex"){polygon(c,groupRadii[g],col);circle(c.x,c.y,groupRadii[g]*.3,col+"55",col+"0a");for(let j=0;j<6;j++){const p=polar(Math.PI/6+j*tau/6,groupRadii[g]);circle(c.x+p.x,c.y+p.y,5,col+"75",paper()?"#f2f0e8":"#08121b");if(zoom>1){ctx.font="7px "+mono;ctx.textAlign="center";ctx.fillStyle=col;ctx.fillText(symbols[g%9],c.x+p.x,c.y+p.y+2)}}}
  else if(mode==="clusters"){circle(c.x,c.y,groupRadii[g],col+"77",col+"0a");for(const ratio of [.3,.55,.78])circle(c.x,c.y,groupRadii[g]*ratio,col+"22");const n=Math.min(12,Math.ceil(groupCounts[g]/7));for(let j=0;j<n;j++){const q=polar(j*tau/Math.max(1,n)+g*.17,groupRadii[g]+9);circle(c.x+q.x,c.y+q.y,5.5,col+"88","#101c27");ctx.font="6.5px "+mono;ctx.textAlign="center";ctx.fillStyle=col;ctx.fillText(symbols[(g+j)%9],c.x+q.x,c.y+q.y+2)}}
  else if(mode==="tile"){const sz=140*groupSize;ctx.fillStyle=col+"0b";ctx.strokeStyle=col+"55";ctx.fillRect(c.x-sz/2,c.y-sz/2,sz,sz);ctx.strokeRect(c.x-sz/2,c.y-sz/2,sz,sz)}
  else if(mode==="force"||groupNames.length>12){circle(c.x,c.y,groupRadii[g],col+"55",col+"0a");circle(c.x,c.y,groupRadii[g]*.62,col+"22")}
  else{const a=groupAngle(g);if(!expanded){const q=hubPoint(g);circle(q.x,q.y,13,col+"99",col+"40");circle(q.x,q.y,8,col+"cc",col);line(polar(a,35),q,col+"45");const t=(phase*.45+g*.11)%1;if(!reduced)circle(q.x*t,q.y*t,2,col+"00",col);for(const n of groups[g].slice(0,42)){const p=positions.get(n.id);if(p)line(q,p,col+"22")}}else{line(polar(a,74),c,col+"16");const p=radialIcon(g);circle(p.x,p.y,10,col+"88",col+"12");ctx.fillStyle=col;ctx.font="9px "+mono;ctx.textAlign="center";ctx.fillText(grouping==="folder"?"▣":symbols[g%9],p.x,p.y+3)}}

  const label=groupLabel(g);
  ctx.textAlign="center";ctx.font=(expanded?"10px ":"10px ")+mono;ctx.fillStyle=col;if(groupNames.length<=12||scale()>.35||groupHover===g||activeGroup===groupNames[g])ctx.fillText((expanded&&collapsed.has(groupKey(g))?"▸ ":"")+groupNames[g].toUpperCase().slice(0,28),label.x,label.y);if(expanded&&grouping==="category"&&(mode==="radial"||mode==="hud")){ctx.font="6px "+mono;ctx.fillText(categoryKind[g]??"ПАМЯТЬ",label.x,label.y+9)}
 });
 ctx.globalAlpha=1;
 const focus=hover??selected,chain=activeChain(focus);
 if(expanded&&strength>0){ctx.globalAlpha=1;const opacity=Math.round(strength*(mode==="force"?85:40)).toString(16).padStart(2,"0");let drawn=0;for(const e of drawEdges){const a=positions.get(e.source),b=positions.get(e.target);if(a&&b&&(!filter||nodeMap.get(e.source)?.category===filter||nodeMap.get(e.target)?.category===filter)){if(!screenVisible(a)&&!screenVisible(b))continue;const hi=groupHover>=0&&(nodeGroups.get(e.source)===groupHover||nodeGroups.get(e.target)===groupHover);const linked=chain.has(e.source)&&chain.has(e.target);line(a,b,hi||linked?"#65dfcbbb":(nodeGroups.get(e.source)!==nodeGroups.get(e.target)?"#bf9ae8":"#79b7bd")+opacity);const born=freshEdges.get(edgeKey(e));if(!reduced&&born!==undefined&&now-born<1800){const t=Math.min(1,(now-born)/900);circle(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t,3,"#65dfcb00","#65dfcb")}if(++drawn>=2500)break}}}
 if(focus!==null){const p=positions.get(focus);if(p)for(const id of neighbor.get(focus)??[]){const q=positions.get(id);if(q)line(p,q,"#81e6dc"+Math.round(strength*255).toString(16).padStart(2,"0"))}}
 if(expanded&&groupHover>=0&&strength>0){let count=0;for(const c of groupConnections.values()){if(c.a!==groupHover&&c.b!==groupHover)continue;line(centers[c.a],centers[c.b],"#65dfcb77");if(++count>200)break}}
 for(const n of visible){
  const p=positions.get(n.id)!;if(!screenVisible(p))continue;const col=color(n);const lit=n.id===focus||n.id===selected;const related=focus!==null&&chain.has(n.id);
  const dim=!allowed(n)||(groupHover>=0&&nodeGroups.get(n.id)!==groupHover)||(focus!==null&&!lit&&!related);
  ctx.globalAlpha=(dim?.22:1)*Math.max(0,Math.min(1,reveal*2-.6));
  const importance=Math.min(2,Math.log2(1+(neighbor.get(n.id)?.size??0))*.35),born=freshNodes.get(n.id),growth=born!==undefined&&!reduced?Math.max(.12,Math.min(1,(now-born)/650)):1;const r=(lit?4.5:related?2.7:(expanded?1.35:.75)+importance+(.5+.5*Math.sin(phase*1.5+n.id*.71))*.65)*growth;
  if(lit||related)circle(p.x,p.y,r+4,col+"66");
  if(expanded&&nodeKind(n)==="file"){ctx.fillStyle=col+(lit?"ff":"b0");ctx.fillRect(p.x-r,p.y-r,r*2,r*2)}else if(expanded&&nodeKind(n)==="process"){ctx.beginPath();ctx.moveTo(p.x,p.y-r*1.3);ctx.lineTo(p.x+r,p.y+r);ctx.lineTo(p.x-r,p.y+r);ctx.closePath();ctx.fillStyle=col;ctx.fill()}else circle(p.x,p.y,r,col,col+(lit?"ff":"b0"));
  if(expanded&&zoom>3&&lit){ctx.font="8px "+mono;ctx.fillStyle=col;ctx.fillText(symbols[state.categories.indexOf(n.category)%9]??"◇",p.x+6,p.y-4)}
 }
 ctx.globalAlpha=1;if(expanded&&showLabels&&zoom>=1.8){const used=new Set<string>();let labels=0;for(const n of visible){const p=positions.get(n.id)!,s=worldToScreen(p);if(s.x<0||s.x>origin().x*2||s.y<0||s.y>height||!allowed(n))continue;const key=Math.floor(s.x/100)+","+Math.floor(s.y/17);if(used.has(key)&&n.id!==focus)continue;used.add(key);ctx.font=(10/scale())+"px "+mono;ctx.fillStyle=paper()?"#21313a":"#c8d8df";ctx.textAlign="left";ctx.fillText(n.title.slice(0,30),p.x+5/scale(),p.y-5/scale());if(++labels>=100)break}}
 drawCore();
 ctx.restore();for(const [id,t] of freshNodes)if(now-t>1800)freshNodes.delete(id);for(const [id,t] of freshEdges)if(now-t>1800)freshEdges.delete(id);requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
function local(e:PointerEvent|WheelEvent|MouseEvent):Point{const r=canvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top}}
function hit(p:Point):number|null{if(binsVersion!==positionsVersion){hitBins=new Map();for(const n of visible){const q=positions.get(n.id)!;const k=Math.floor(q.x/CELL)+","+Math.floor(q.y/CELL);const list=hitBins.get(k)??[];list.push(n.id);hitBins.set(k,list)}binsVersion=positionsVersion}const w=world(p),radius=12/scale();let best:number|null=null,min=144;const check=(id:number)=>{const n=nodeMap.get(id);if(!n||!allowed(n))return;const q=worldToScreen(positions.get(id)!);const d=(q.x-p.x)**2+(q.y-p.y)**2;if(d<min){min=d;best=id}};if(radius>CELL*5){for(const n of visible)check(n.id)}else{for(let x=Math.floor((w.x-radius)/CELL);x<=Math.floor((w.x+radius)/CELL);x++)for(let y=Math.floor((w.y-radius)/CELL);y<=Math.floor((w.y+radius)/CELL);y++)for(const id of hitBins.get(x+","+y)??[])check(id)}return best}
function hitGroup(p:Point){const w=world(p);if(!expanded){for(let i=0;i<groupNames.length*3;i++){const q=modulePoint(i);if(Math.hypot(q.x-w.x,q.y-w.y)<22)return i%groupNames.length}for(let i=0;i<groupNames.length;i++){const q=hubPoint(i);if(Math.hypot(q.x-w.x,q.y-w.y)<16)return i}}else{for(let i=0;i<centers.length;i++){const q=isRadial()?radialIcon(i):centers[i],label=groupLabel(i);if(Math.hypot(q.x-w.x,q.y-w.y)<((mode==="clusters"||mode==="hex"||groupNames.length>12)?groupRadii[i]+15:18)||Math.abs(label.x-w.x)<Math.min(90,groupNames[i].length*3+8)&&Math.abs(label.y-w.y)<10)return i}}return -1}
function tooltip(id:number|null,p:Point){const t=$("tooltip");const n=id===null?undefined:nodeMap.get(id);t.hidden=!n;if(n){text(t,n.title+"\n"+n.category+" · "+age(n)+"\n"+folderOf(n)+" · связей: "+(neighbor.get(n.id)?.size??0)+"\nНажмите для карточки");t.style.left=Math.max(4,Math.min(origin().x*2-255,p.x+14))+"px";t.style.top=Math.max(4,Math.min(height-125,p.y+12))+"px"}}
function choose(id:number|null){if(selected!==id){selected=id;rebuild(cameraTarget?.zoom??zoom)}refreshDetails();if(id!==null){$<HTMLDetailsElement>("record-card").open=true}}
canvas.addEventListener("pointerdown",e=>{if(e.button!==0)return;cameraTarget=null;drag=local(e);dragOrigin=drag;moved=false;canvas.setPointerCapture(e.pointerId)});
canvas.addEventListener("pointermove",e=>{cursor=local(e);if(drag){pan.x+=cursor.x-drag.x;pan.y+=cursor.y-drag.y;drag=cursor;if(dragOrigin&&Math.hypot(cursor.x-dragOrigin.x,cursor.y-dragOrigin.y)>4)moved=true;hover=null;tooltip(null,cursor)}else{hover=hit(cursor);tooltip(hover,cursor);const groupHit=hitGroup(cursor);groupHover=groupHit>=0?groupHit:hover===null?-1:nodeGroups.get(hover)??-1;const m=$("module-tip");m.hidden=hover!==null||groupHover<0;if(!m.hidden){text(m,groupNames[groupHover]+" · "+groupCounts[groupHover]+" записей · "+Array.from(groupConnections.values()).filter(e=>e.a===groupHover||e.b===groupHover).reduce((sum,e)=>sum+e.count,0)+" межгрупповых связей");m.style.left=Math.min(width-175,Math.max(0,cursor.x+10))+"px";m.style.top=Math.max(0,cursor.y-30)+"px"}}});
canvas.addEventListener("pointerup",e=>{if(!moved&&drag){const p=local(e),id=hit(p),g=hitGroup(p);if(id!==null&&!(g>=0&&(!expanded||isRadial()&&groupNames.length<=12)))choose(id);else if(g>=0){const category=groupNames[g];if(!expanded){layout(true);grouping="category";filter=category;rebuild();refreshPanels()}else{if(grouping==="category"){filter=filter===category?null:category;activeGroup=null}else{filter=null;activeGroup=activeGroup===category?null:category}refreshPanels()}}else choose(null)}drag=null;dragOrigin=null});
canvas.addEventListener("pointercancel",()=>{drag=null;dragOrigin=null});
canvas.addEventListener("pointerleave",()=>{hover=null;groupHover=-1;$("module-tip").hidden=true;tooltip(null,cursor)});
function setZoom(z:number,p:Point=origin()){cameraTarget=null;const w=world(p);zoom=Math.max(.35,Math.min(5,z));if(limitAt(zoom)!==currentLimit){rebuild();refreshCounts()}const o=origin();pan={x:p.x-o.x-w.x*scale(),y:p.y-o.y-w.y*scale()};$<HTMLInputElement>("zoom").value=String(zoom)}
canvas.addEventListener("wheel",e=>{e.preventDefault();setZoom(zoom*Math.exp(-e.deltaY*.0015),local(e))},{passive:false});
function recenterFocusTarget(){if(cameraTarget&&selected!==null){const p=targets.get(selected);if(p)cameraTarget.pan={x:-p.x*fit*cameraTarget.zoom,y:-p.y*fit*cameraTarget.zoom}}}
function focusNode(id:number){if(!expanded)layout(true);if(!nodeGroups.has(id)&&grouping==="folder"){folderPrefix="";geometryKey="";rebuild()}const g=nodeGroups.get(id);if(g!==undefined)collapsed.delete(groupKey(g));filter=null;activeGroup=null;selected=id;const z=3;rebuild(z);refreshPanels();$<HTMLDetailsElement>("record-card").open=true;const p=targets.get(id);if(p)cameraTarget={zoom:z,pan:{x:-p.x*fit*z,y:-p.y*fit*z}}}
canvas.addEventListener("dblclick",e=>{const id=hit(local(e));if(id!==null)focusNode(id)});
function reset(){geometryKey="";cameraTarget=null;zoom=1;pan={x:0,y:0};$<HTMLInputElement>("zoom").value="1";filter=null;activeGroup=null;selected=null;rebuild();refreshPanels()}
$("reset").onclick=reset;
function layout(isExpanded:boolean){if(expanded===isExpanded)return;if(expanded)atlasMode=mode;expanded=isExpanded;revealAt=performance.now();$("atlas-loading").hidden=!expanded||reduced;groupHover=-1;$("module-tip").hidden=true;$("layout").classList.toggle("expanded",expanded);$("home").classList.toggle("active",!expanded);$("atlas").classList.toggle("active",expanded);text($("subtitle"),expanded?"Детальная карта памяти":"КОМАНДНЫЙ ЦЕНТР · ЖИВОЕ ЯДРО");text($("brand-mode"),expanded?"Атлас памяти":"Командный центр");mode=expanded?atlasMode:"radial";document.querySelectorAll<HTMLElement>("[data-mode]").forEach(x=>x.classList.toggle("active",x.dataset.mode===mode));resize();reset();positions.forEach(p=>{p.x*=.12;p.y*=.12});const el=$("layout");el.classList.remove("reveal");void el.offsetWidth;el.classList.add("reveal");text($("legend"),expanded?"Колесо — масштаб · Перетаскивание — перемещение · Двойной щелчок — фокус":"Нажмите на ядро, чтобы открыть полный атлас")}
$("core-open").onclick=()=>layout(true);
$("home").onclick=()=>layout(false);$("atlas").onclick=()=>layout(true);
document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach(b=>b.onclick=()=>{const keep=selected;mode=b.dataset.mode as Layout;atlasMode=mode;document.querySelectorAll("[data-mode]").forEach(x=>x.classList.toggle("active",x===b));cameraTarget=null;zoom=1;pan={x:0,y:0};$<HTMLInputElement>("zoom").value="1";groupHover=-1;if(keep!==null&&nodeGroups.has(keep))focusNode(keep);else rebuild();refreshCounts()});
document.querySelectorAll<HTMLButtonElement>("[data-group]").forEach(b=>b.onclick=()=>{grouping=b.dataset.group==="folder"?"folder":"category";folderPrefix="";groupPage=0;document.querySelectorAll("[data-group]").forEach(x=>x.classList.toggle("active",x===b));filter=null;activeGroup=null;selected=null;rebuild();refreshPanels()});
$("expand-groups").onclick=()=>{groupNames.forEach((_,i)=>collapsed.delete(groupKey(i)));rebuild();refreshCounts()};
$("collapse-groups").onclick=()=>{groupNames.forEach((_,i)=>collapsed.add(groupKey(i)));selected=null;hover=null;rebuild();refreshDetails();refreshCounts()};
$<HTMLInputElement>("strength").oninput=e=>{strength=Number((e.target as HTMLInputElement).value);if(mode==="force")rebuild()};
$<HTMLInputElement>("group-size").oninput=e=>{groupSize=Number((e.target as HTMLInputElement).value);rebuild()};
async function togglePresentation(on:boolean){if(on&&!expanded)layout(true);presentation=on;document.body.classList.toggle("presentation",on);$("presentation").setAttribute("aria-pressed",String(on));try{if(on&&!document.fullscreenElement&&document.documentElement.requestFullscreen)await document.documentElement.requestFullscreen();else if(!on&&document.fullscreenElement)await document.exitFullscreen()}catch{/* CSS presentation still works */}resize()}
$("presentation").onclick=()=>void togglePresentation(!presentation);$("exit-presentation").onclick=()=>void togglePresentation(false);document.addEventListener("fullscreenchange",()=>{if(!document.fullscreenElement&&presentation)void togglePresentation(false)});document.addEventListener("keydown",e=>{if(e.key==="/"&&!e.ctrlKey&&!e.metaKey&&!(e.target instanceof HTMLElement&&(["INPUT","TEXTAREA","SELECT"].includes(e.target.tagName)||e.target.isContentEditable))){e.preventDefault();if(presentation)void togglePresentation(false);if(!expanded)layout(true);if(document.body.classList.contains("panel-hidden")){$("toggle-panel").click()}$("search").focus();return}if(e.key==="Escape"&&presentation)void togglePresentation(false);else if(e.key==="Escape"&&expanded)layout(false)});
$<HTMLInputElement>("speed").oninput=e=>speed=Number((e.target as HTMLInputElement).value);
$<HTMLInputElement>("density").oninput=e=>{density=Number((e.target as HTMLInputElement).value);rebuild();refreshPanels()};
$<HTMLInputElement>("zoom").oninput=e=>setZoom(Number((e.target as HTMLInputElement).value));
function renderPalettes(){const root=$("palettes");root.replaceChildren();for(const name of ["Металл","Рубин","Океан","Неон","Бордо","Бумага","Императорская","Полярная"]){const p=palettes.find(x=>x.name===name)!;const b=document.createElement("button");b.className="swatch"+(colors===p.colors?" active":"");const s=document.createElement("span");s.textContent=p.name;const bar=document.createElement("b");for(const c of p.colors.slice(0,5)){const i=document.createElement("i");i.style.background=c;bar.append(i)}bar.style.background=p.name==="Бумага"?"#f2f0e8":p.name==="Рубин"?"#200b14":p.name==="Бордо"?"#251018":"#08121b";b.append(bar,s);if(colors===p.colors){const tag=document.createElement("small");tag.textContent="АКТИВНА";b.append(tag)}b.onclick=()=>{colors=p.colors;document.documentElement.style.setProperty("--accent",colors[0]);document.documentElement.classList.toggle("paper",p.name==="Бумага");renderPalettes();refreshPanels()};root.append(b)}}renderPalettes();
function refreshDetails(){const n=selected===null?undefined:nodeMap.get(selected);const el=$("details");el.replaceChildren();if(!n){text(el,"Выберите запись на карте");return}const info=document.createElement("p");text(info,n.title+" · "+n.category+" · "+folderOf(n)+" · "+age(n)+" · "+(neighbor.get(n.id)?.size??0)+" связей"+(n.category==="Документы"?" · Физический файл не привязан":""));el.append(info);for(const id of Array.from(neighbor.get(n.id)??[]).slice(0,30)){const other=nodeMap.get(id);if(other){const b=document.createElement("button");b.className="entry";text(b,other.title);b.onclick=()=>focusNode(id);el.append(b)}}}
function options(el:HTMLSelectElement,items:{value:string;label:string}[]){const old=el.value;el.replaceChildren();for(const i of items){const o=document.createElement("option");o.value=i.value;o.textContent=i.label;el.append(o)}if(items.some(i=>i.value===old))el.value=old}
function refreshRecords(){const q=$<HTMLInputElement>("search").value.trim().toLowerCase(),el=$("records");el.replaceChildren();$("search-block").classList.toggle("has-query",q.length>0);const results=nodes.filter(n=>allowed(n)&&(n.title+" "+folderOf(n)).toLowerCase().includes(q));for(const n of results.slice(0,100)){const b=document.createElement("button");b.className="entry";text(b,n.title);b.onclick=()=>focusNode(n.id);el.append(b)}if(results.length>100){const p=document.createElement("p");text(p,"Показано 100 из "+results.length+"; уточните поиск.");el.append(p)}}
$<HTMLInputElement>("search").oninput=refreshRecords;
function refreshPanels(){renderMatrix();const totals=categoryCounts();const overview=$("activity-grid");overview.replaceChildren();state.categories.forEach((c,i)=>{const item=document.createElement("div");item.className="activity-cell";item.style.setProperty("--cell",colors[i%colors.length]);item.style.setProperty("--order",String(i));const ring=document.createElement("i");text(ring,String(totals[i]??0));const label=document.createElement("span");text(label,c);item.append(ring,label);overview.append(item)});const cats=$("categories");cats.replaceChildren();state.categories.forEach((c,i)=>{const b=document.createElement("button");b.className="category-row"+(filter===c?" active":"");const label=document.createElement("span"),dot=document.createElement("i");dot.style.background=colors[i%colors.length];label.append(dot,document.createTextNode(c));const count=document.createElement("span");text(count,String(totals[i]??0));b.append(label,count);b.onclick=()=>{filter=filter===c?null:c;refreshPanels()};cats.append(b)});refreshRecords();refreshDetails();
 options($("category"),state.categories.map(c=>({value:c,label:c})));
 refreshLinkOptions();const items=state.nodes;
 $<HTMLButtonElement>("link").querySelector("button")!.disabled=items.length<2;
 refreshCounts();
}
function refreshLinkOptions(){const q=$<HTMLInputElement>("link-search").value.trim().toLowerCase();const items=state.nodes.filter(n=>!q||n.title.toLowerCase().includes(q)||String(n.id)===q).slice(0,300).map(n=>({value:String(n.id),label:n.title+" #"+n.id}));for(const id of ["source","target"]){const el=$<HTMLSelectElement>(id),old=nodeMap.get(Number(el.value));options(el,old&&old.id>0&&!items.some(x=>x.value===String(old.id))?[...items,{value:String(old.id),label:old.title+" #"+old.id}]:items)}}
$("link-search").oninput=refreshLinkOptions;
function refreshCounts(){text($("counts"),(demo?"ДЕМО: ":"")+"Записей "+nodes.length+" · Связей "+edges.length+" · На карте "+visible.length)}
async function post(path:string,body:unknown){const r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const s=await r.json();if(!r.ok)throw new Error(s.error??"Ошибка API");setState(s as Snapshot);signalTime();void loadEvents()}
$<HTMLFormElement>("add").onsubmit=async e=>{e.preventDefault();try{await post("/api/nodes",{title:$<HTMLInputElement>("title").value,category:$<HTMLSelectElement>("category").value,folder:$<HTMLInputElement>("folder").value});$<HTMLInputElement>("title").value="";text($("message"),"Запись сохранена")}catch(err){text($("message"),String(err))}};
$<HTMLFormElement>("link").onsubmit=async e=>{e.preventDefault();try{await post("/api/edges",{source:Number($<HTMLSelectElement>("source").value),target:Number($<HTMLSelectElement>("target").value)});text($("message"),"Связь сохранена")}catch(err){text($("message"),String(err))}};
$("save-settings").onclick=async()=>{try{const r=await fetch("/api/settings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({palette:palettes.find(p=>p.colors===colors)?.name,speed,density,strength,groupSize,showLabels})});if(!r.ok)throw Error("API "+r.status);text($("message"),"Настройки сохранены в SQLite");void loadEvents()}catch(err){text($("message"),String(err))}};
$<HTMLInputElement>("show-labels").onchange=e=>showLabels=(e.target as HTMLInputElement).checked;
$("export-png").onclick=()=>{canvas.toBlob(blob=>{if(!blob)return;const url=URL.createObjectURL(blob);const link=document.createElement("a");link.href=url;link.download="amatsumireika-atlas.png";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)},"image/png")};
async function loadSettings(){try{const response=await fetch("/api/settings");if(!response.ok)throw Error("API "+response.status);let saved=await response.json();if(Object.keys(saved).length===0){try{saved=JSON.parse(localStorage.getItem("atlas-visual-v2")??"{}")}catch{saved={}}}const p=palettes.find(p=>p.name===saved.palette);if(p){colors=p.colors;document.documentElement.style.setProperty("--accent",colors[0]);document.documentElement.classList.toggle("paper",p.name==="Бумага")}if(Number.isFinite(saved.speed))speed=Math.max(0,Math.min(2,saved.speed));if(Number.isFinite(saved.density))density=Math.max(12,Math.min(180,saved.density));if(Number.isFinite(saved.strength))strength=Math.max(0,Math.min(1,saved.strength));if(Number.isFinite(saved.groupSize))groupSize=Math.max(.55,Math.min(1,saved.groupSize));if(typeof saved.showLabels==="boolean")showLabels=saved.showLabels;$<HTMLInputElement>("speed").value=String(speed);$<HTMLInputElement>("density").value=String(density);$<HTMLInputElement>("strength").value=String(strength);$<HTMLInputElement>("group-size").value=String(groupSize);$<HTMLInputElement>("show-labels").checked=showLabels;renderPalettes();rebuild();refreshPanels()}catch(err){text($("message"),"Настройки: "+String(err))}}
type AtlasEvent={at:string;kind:string;detail:string};
let events:AtlasEvent[]=[],month=new Date(),daySelected=dayKey(new Date());
function dayKey(d:Date){return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")}
// Federal Russian production calendar, Monday–Friday; no regional holidays.
// 2026: decree 1466, 24.09.2025; 2027: decree 1187, 17.09.2026.
// Fixed holidays: article 112 of the Labour Code.
type DayType="work"|"weekend"|"holiday"|"short"|"transfer";
type ProductionRule={rest:string[];short:string[];work?:string[]};
const productionRules:Record<number,ProductionRule>={
 2026:{rest:["01-09","03-09","05-11","12-31"],short:["04-30","05-08","06-11","11-03"]},
 2027:{rest:["02-22","05-03","05-10","06-14","11-05","12-31"],short:["02-20","04-30","06-11","11-03"]}
};
const officialHolidays=new Set(["01-01","01-02","01-03","01-04","01-05","01-06","01-07","01-08","02-23","03-08","05-01","05-09","06-12","11-04"]);
const dayColors:Record<DayType,string>={work:"#42c9af",weekend:"#7184a5",holiday:"#e9b65c",short:"#ed8f7b",transfer:"#7184a5"};
const dayNames:Record<DayType,string>={work:"Рабочий день · 8 ч",weekend:"Выходной",holiday:"Праздник",short:"Сокращённый день · 7 ч",transfer:"Перенесённый выходной"};
const monthNames=["Янв","Фев","Мар","Апр","Май","Июн","Июл","Авг","Сен","Окт","Ноя","Дек"];
function productionDay(d:Date):DayType|null{
 const rules=productionRules[d.getFullYear()];if(!rules)return null;
 const key=dayKey(d).slice(5);
 if(officialHolidays.has(key))return "holiday";
 if(rules.short.includes(key))return "short";
 if(rules.rest.includes(key))return "transfer";
 if(rules.work?.includes(key))return "work";
 return d.getDay()===0||d.getDay()===6?"weekend":"work";
}
function yearDates(y:number){const result:Date[]=[];for(let d=new Date(y,0,1,12);d.getFullYear()===y;d.setDate(d.getDate()+1))result.push(new Date(d));return result}
function productionStats(dates:Date[]){
 if(!dates.length||dates.some(d=>productionDay(d)===null))return null;
 let work=0,short=0;for(const d of dates){const t=productionDay(d);if(t==="work"||t==="short")work++;if(t==="short")short++}
 return {work,rest:dates.length-work,short,h40:work*8-short,h36:Math.round((work*7.2-short)*10)/10,h24:Math.round((work*4.8-short)*10)/10};
}
let autoYear=true,calendarYear=new Date().getFullYear(),detailMonth:number|null=null;
let birthAt=-100000,birthKey="",calendarAnim=false,clockNotice="",calendarSource="",updatePending=false,lastUpdateDay="";
type TimeShape="spiral"|"dna"|"galaxy"|"sphere"|"crystal"|"fabric"|"years";
const timeShapes:TimeShape[]=["spiral","dna","galaxy","sphere","crystal","fabric","years"];
let timeShape:TimeShape="spiral",oldShape:TimeShape="spiral",morphAt=-100000,monthPulse=-100000,yearPulse=-100000;
let historyDate:string|null=null,playbackAt=0,playbackRunning=false,playbackKind:"year"|"events"="year",playbackDays:string[]=[];
let timeCursor:Point={x:0,y:0},timeFrame=0,timeFrameMs=0,timeQuality=1,timeLast=0,timePulse=-100000;
let timeDataReady=false,timeWindowKey="",timeRequest=0,timeDayCounts=new Map<string,number>(),timeCategories=new Map<string,number>(),timeEventDates:string[]=[];
let timeOverlay:HTMLCanvasElement|null=null,timeOverlayCtx:CanvasRenderingContext2D|null=null;
type TimeRay={p:Point;q:Point;d:Date;type:DayType|null};
const timeGeometryCache=new Map<string,TimeRay[]>();
const timeDateCache=new Map<number,Date[]>();
function geometryDates(y:number){let result=timeDateCache.get(y);if(!result){result=yearDates(y);if(timeDateCache.size>=5)timeDateCache.delete(timeDateCache.keys().next().value!);timeDateCache.set(y,result)}return result}
function timeReference(now:Date){return historyDate?new Date(historyDate+"T12:00:00"):now}
function timePoint(a:number,r:number):Point{return{x:160+Math.cos(a)*r,y:160+Math.sin(a)*r}}
function timeShapePoint(shape:TimeShape,i:number,n:number,year:number,outer:boolean):Point{
 const f=(i+.5)/n,a=-Math.PI/2+tau*f,base=69,length=rayLength(i,n),r=outer?base+length:base;
 if(shape==="spiral")return timePoint(a,r);
 if(shape==="dna"){const wave=Math.sin(a*2),offset=outer?15:-15;return timePoint(a,96+28*wave+offset*Math.cos(a*2))}
 if(shape==="galaxy"){const arm=i%3,b=-Math.PI/2+arm*tau/3+f*tau*.75;return timePoint(b,outer?75+63*f:65+60*f)}
 if(shape==="sphere"){const lat=Math.acos(1-2*f),lon=i*2.399963;const size=outer?131:118;return{x:160+Math.cos(lon)*Math.sin(lat)*size,y:160+Math.cos(lat)*size*.84+Math.sin(lon)*Math.sin(lat)*size*.18}}
 if(shape==="crystal"){const fac=Math.cos(Math.PI/6)/Math.cos(((a+Math.PI*4)%(Math.PI/3))-Math.PI/6);return timePoint(a,r*fac)}
 if(shape==="fabric"){const k=Math.sin(a*5+year*.1);return timePoint(a,r-12*Math.sin(a*3)+(outer?7:-7)*k)}
 return timePoint(a,(outer?95:88)+35*f);
}
function timeGeometry(shape:TimeShape,y:number,m:number|null):TimeRay[]{
 const k=shape+":"+y+":"+m;const old=timeGeometryCache.get(k);if(old)return old;
 const dates=geometryDates(y).filter(d=>m===null||d.getMonth()===m);
 const result=dates.map((d,i)=>({d,type:productionDay(d),p:timeShapePoint(shape,i,dates.length,y,false),q:timeShapePoint(shape,i,dates.length,y,true)}));
 if(timeGeometryCache.size>=32)timeGeometryCache.delete(timeGeometryCache.keys().next().value!);timeGeometryCache.set(k,result);return result
}
function interpolatedRays(y:number,nowMono:number){
 const end=timeGeometry(timeShape,y,detailMonth),t=reduced?1:eased((nowMono-morphAt)/800);if(t>=1)return end;
 const start=timeGeometry(oldShape,y,detailMonth);return end.map((v,i)=>({...v,p:{x:start[i].p.x+(v.p.x-start[i].p.x)*t,y:start[i].p.y+(v.p.y-start[i].p.y)*t},q:{x:start[i].q.x+(v.q.x-start[i].q.x)*t,y:start[i].q.y+(v.q.y-start[i].q.y)*t}}))
}
function setTimeShape(shape:TimeShape){if(!timeShapes.includes(shape)||shape===timeShape)return;oldShape=timeShape;timeShape=shape;morphAt=performance.now();$<HTMLSelectElement>("time-shape").value=shape;drawYear();if(!reduced)requestAnimationFrame(timeMorph)}
function timeMorph(){drawYear();if(performance.now()-morphAt<800&&!reduced)requestAnimationFrame(timeMorph)}
function timeDayAt(x:number,y:number,year:number){const rays=interpolatedRays(year,performance.now());let best:Date|null=null,dist=Infinity;for(const v of rays){const dx=v.q.x-v.p.x,dy=v.q.y-v.p.y,t=Math.max(0,Math.min(1,((x-v.p.x)*dx+(y-v.p.y)*dy)/(dx*dx+dy*dy||1))),d=Math.hypot(x-v.p.x-t*dx,y-v.p.y-t*dy);if(d<dist){dist=d;best=v.d}}return dist<20?best:null}
function drawAlternate(now:Date,y:number,c:CanvasRenderingContext2D,base:string,gold:string){
 const reference=dayKey(timeReference(now)),rays=interpolatedRays(y,performance.now());
 for(const v of rays){const k=dayKey(v.d),col=v.type?dayColors[v.type]:base,active=k<=reference;
 c.globalAlpha=active?.86:.16;c.lineWidth=detailMonth===null?1.2:3;
 c.strokeStyle=col;c.beginPath();c.moveTo(v.p.x,v.p.y);c.lineTo(v.q.x,v.q.y);c.stroke();
 if(timeDayCounts.has(k)){c.globalAlpha=.85;c.fillStyle="#bfa0e8";c.beginPath();c.arc(v.q.x,v.q.y,Math.min(3,1+Math.log2(1+(timeDayCounts.get(k)??0))*.3),0,tau);c.fill()}
 if(k===daySelected||k===reference){c.globalAlpha=1;c.fillStyle=gold;c.beginPath();c.arc(v.q.x,v.q.y,3,0,tau);c.fill()}
 }
 c.globalAlpha=1;
 if(timeShape==="years"){for(let offset=-1;offset<=1;offset+=2){const yy=y+offset,rr=offset<0?77:140;c.strokeStyle=base;c.lineWidth=2;c.beginPath();c.arc(160,160,rr,0,tau);c.stroke();c.strokeStyle=gold;c.lineWidth=.8;c.beginPath();c.arc(160,160,rr,-Math.PI/2,-Math.PI/2+tau*elapsedDays(yy,now)/geometryDates(yy).length);c.stroke()}}
}
function signalTime(){timePulse=performance.now();timeWindowKey="";if(timeDataReady)void refreshTimeWindow()}
function historySelect(value:string|null){historyDate=value;if(value){const d=new Date(value+"T12:00:00");if(!Number.isFinite(d.getTime())){historyDate=null;return}autoYear=false;calendarYear=d.getFullYear();detailMonth=null;daySelected=value}else chooseCalendarYear(null);renderCalendar()}
function startTimePlayback(kind:"year"|"events"){playbackKind=kind;playbackDays=kind==="year"?geometryDates(displayedYear(new Date())).map(dayKey):timeEventDates.slice();if(!playbackDays.length){text($("time-history-status"),"Нет дат для воспроизведения");return}playbackAt=performance.now();playbackRunning=true;historyDate=playbackDays[0];requestAnimationFrame(playTime)}
function playTime(now:number){if(!playbackRunning)return;const i=Math.min(playbackDays.length-1,Math.floor((now-playbackAt)/Math.max(65,14000/playbackDays.length)));historyDate=playbackDays[i];daySelected=historyDate;calendarYear=Number(historyDate.slice(0,4));autoYear=false;detailMonth=null;drawYear();text($("time-history-status"),"Просмотр "+historyDate);if(i+1>=playbackDays.length){playbackRunning=false;renderCalendar()}else requestAnimationFrame(playTime)}
function stopTimePlayback(){playbackRunning=false;historyDate=null;chooseCalendarYear(null)}
function overlayFrame(now:number){
 if(!timeOverlay||!timeOverlayCtx)return;requestAnimationFrame(overlayFrame);
 if(expanded||document.visibilityState==="hidden")return;
 const interval=timeQuality===1?33:66;if(now-timeLast<interval)return;
 const delta=timeLast?Math.min(200,now-timeLast):interval;timeLast=now;timeFrameMs=timeFrameMs*.94+delta*.06;timeFrame++;if(timeFrame%60===0)timeQuality=timeFrameMs>48?.5:1;
 const c=timeOverlayCtx,sz=wheel.width;if(timeOverlay.width!==sz)timeOverlay.width=sz;if(timeOverlay.height!==sz)timeOverlay.height=sz;
 c.setTransform(sz/320,0,0,sz/320,0,0);c.clearRect(0,0,320,320);
 const d=new Date(),h=d.getHours()+d.getMinutes()/60,sec=d.getSeconds()+d.getMilliseconds()/1000,min=d.getMinutes()+sec/60;
 const warm=h<6||h>=21?"#879fdb":h<10||h>=17?"#eac275":"#66d8cb";
 const phase=now*.001,angle=-Math.PI/2+tau*sec/60,ring=(r:number,a:number,b:number,col:string,w:number)=>{c.strokeStyle=col;c.lineWidth=w;c.beginPath();c.arc(160,160,r,a,b);c.stroke()};
 ring(56,-Math.PI/2,angle,warm,1.1);ring(63,-Math.PI/2,-Math.PI/2+tau*min/60,"#eac275",.65);
 const p=timePoint(angle,56);c.fillStyle=warm;c.beginPath();c.arc(p.x,p.y,reduced?1.8:2.3+.4*Math.sin(phase*6),0,tau);c.fill();
 if(!reduced){const count=timeQuality===1?40:18;for(let i=0;i<count;i++){const a=i*2.399963+phase*(i%2?.17:-.09),r=19+(i%13)*3.2;const pull=.8*Math.sin(phase+i),q=timePoint(a,r+pull);c.globalAlpha=.11+(i%4)*.055;c.fillStyle=warm;c.beginPath();c.arc(q.x+timeCursor.x*.015,q.y+timeCursor.y*.015,i%7===0?1.1:.55,0,tau);c.fill()}c.globalAlpha=1;
 const marker=timePoint(angle,56);for(let i=1;i<=5;i++){c.globalAlpha=(6-i)*.055;c.fillStyle=warm;c.beginPath();c.arc(marker.x,marker.y,2+i*1.4,0,tau);c.fill()}c.globalAlpha=1;
 for(const [at,col] of [[monthPulse,"#eac275"],[yearPulse,"#bfa0e8"],[timePulse,"#41d9cc"]] as [number,string][]){const f=(now-at)/1600;if(f>=0&&f<1){c.globalAlpha=(1-f)*.65;ring(65+eased(f)*88,0,tau,col,1.5);c.globalAlpha=1}}
 }
 if(timeFrame%60===0)text($("time-performance"),Math.round(timeFrameMs)+" мс между кадрами · "+(timeQuality===1?"обычный":"экономный")+" режим");
}

function viewDates(y:number){const all=yearDates(y);return detailMonth===null?all:all.filter(d=>d.getMonth()===detailMonth)}
function elapsedProduction(year:number,now:Date){const dates=yearDates(year),total=productionStats(dates);if(!total)return null;const past=dates.filter(d=>dayKey(d)<dayKey(now)),done=past.length?productionStats(past):{work:0,h40:0};return done?{remaining:total.work-done.work,doneHours:done.h40}:null}
function rayLength(i:number,n:number){return 12+57*(i+1)/n}
function eased(t:number){t=Math.max(0,Math.min(1,t));return t*t*(3-2*t)}
function mixHex(a:string,b:string,t:number){const x=parseInt(a.slice(1),16),y=parseInt(b.slice(1),16);return "#"+[16,8,0].map(k=>Math.round(((x>>k)&255)*(1-t)+((y>>k)&255)*t).toString(16).padStart(2,"0")).join("")}
function animateBirth(now:Date){birthAt=performance.now();birthKey=dayKey(now);if(reduced||calendarAnim)return;calendarAnim=true;const tick=()=>{drawYear(new Date());if(performance.now()-birthAt<1400)requestAnimationFrame(tick);else calendarAnim=false};requestAnimationFrame(tick)}
const wheel=$<HTMLCanvasElement>("year-wheel"),wheelCtx=wheel.getContext("2d")!;
function displayedYear(now:Date){return autoYear?now.getFullYear():calendarYear}
function elapsedDays(year:number,now:Date){const key=dayKey(now);return yearDates(year).filter(d=>dayKey(d)<=key).length}
function drawYear(now=new Date()){
 const y=displayedYear(now),days=viewDates(y),today=dayKey(timeReference(now)),selected=daySelected;const elapsed=performance.now()-birthAt,birth=!reduced&&elapsed>=0&&elapsed<1400;
 const box=wheel.getBoundingClientRect();const side=Math.max(1,Math.min(box.width,box.height));if(side<=1)return;
 const size=Math.max(1,Math.round(side*Math.min(devicePixelRatio||1,2)));if(wheel.width!==size)wheel.width=size;if(wheel.height!==size)wheel.height=size;
 const c=wheelCtx;c.setTransform(size/320,0,0,size/320,0,0);c.clearRect(0,0,320,320);
 const center=160,inner=69,step=tau/days.length;
 const dark=!paper(),base=dark?"#273a45":"#c9c7bf",ink=dark?"#9db1be":"#52646c",gold=dark?"#eac275":"#987026";
 const point=(angle:number,r:number)=>({x:center+Math.cos(angle)*r,y:center+Math.sin(angle)*r});
 function stroke(a:number,b:number,r:number,color:string,w:number){c.beginPath();c.arc(center,center,r,a,b);c.strokeStyle=color;c.lineWidth=w;c.stroke()}
 if(timeShape!=="spiral"||(!reduced&&performance.now()-morphAt<800)){drawAlternate(now,y,c,base,gold);return}
 stroke(0,tau,inner-4,base,.8);stroke(0,tau,inner-10,base,.5);stroke(0,tau,140,base,.5);stroke(0,tau,inner-1,dark?"#142631":"#e4e0d6",2.3);stroke(0,tau,142,base,.3);
 for(let i=0;i<60;i++){const angle=-Math.PI/2+i*tau/60,p=point(angle,inner-9),q=point(angle,inner-(i%5===0?15:12));c.beginPath();c.moveTo(p.x,p.y);c.lineTo(q.x,q.y);c.strokeStyle=i%5===0?gold:base;c.lineWidth=i%5===0?1:.6;c.stroke()}
 for(let i=0;i<days.length;i++){
  const d=days[i],key=dayKey(d),type=productionDay(d),angle=-Math.PI/2+(i+.5)*step,passed=key<=today;
  // Ray height grows with the ordinal day; a new ray is filled at local midnight.
  const length=rayLength(i,days.length)*(birth&&key===birthKey?eased(elapsed/800):1),tip=inner+length,p=point(angle,inner),q=point(angle,tip);const col=type?dayColors[type]:base;const prevType=i>0?productionDay(days[i-1]):type;const blended=mixHex(col,prevType?dayColors[prevType]:col,.12);
  c.globalAlpha=passed?1:.14;c.strokeStyle=mixHex(col,base,.45);c.lineWidth=detailMonth===null?1.35:3.6;c.beginPath();c.moveTo(p.x,p.y);c.lineTo(q.x,q.y);c.stroke();
  const mid=point(angle,inner+length*.48);c.strokeStyle=mixHex(blended,gold,.10);c.lineWidth=detailMonth===null?1.02:2.7;c.beginPath();c.moveTo(mid.x,mid.y);c.lineTo(q.x,q.y);c.stroke();c.globalAlpha=1;
  if(timeDayCounts.has(key)){const z=point(angle,tip+5);c.fillStyle="#bfa0e8";c.beginPath();c.arc(z.x,z.y,Math.min(2.5,.8+Math.log2(1+(timeDayCounts.get(key)??0))*.25),0,tau);c.fill()}
  if(key===today||key===selected){const k=point(angle,tip+3);if(key===today){c.globalAlpha=.13;c.fillStyle=gold;c.beginPath();c.arc(k.x,k.y,7,0,tau);c.fill();c.globalAlpha=1;stroke(angle-step*.65,angle+step*.65,tip+3,gold,1.7)}c.beginPath();c.arc(k.x,k.y,key===today?2.5:1.6,0,tau);c.fillStyle=key===today?gold:ink;c.fill()}
  if(detailMonth===null&&d.getDate()===1){const p1=point(angle-step/2,inner-1),p2=point(angle-step/2,141);c.strokeStyle=base;c.lineWidth=.7;c.beginPath();c.moveTo(p1.x,p1.y);c.lineTo(p2.x,p2.y);c.stroke()}
 }
 if(detailMonth===null){for(let m=0;m<12;m++){const first=days.findIndex(d=>d.getMonth()===m),n=new Date(y,m+1,0).getDate(),angle=-Math.PI/2+(first+n/2)*step,p=point(angle,151);c.font="9px "+mono;c.textAlign="center";c.textBaseline="middle";c.fillStyle=now.getFullYear()===y&&now.getMonth()===m?gold:ink;c.fillText(monthNames[m],p.x,p.y)}}else{for(let i=0;i<days.length;i++){const a=-Math.PI/2+(i+.5)*step,p=point(a,151);c.font="8px "+mono;c.textAlign="center";c.textBaseline="middle";c.fillStyle=dayKey(days[i])===today?gold:ink;c.fillText(String(i+1),p.x,p.y)}}
 const progress=days.filter(d=>dayKey(d)<=today).length/days.length;stroke(-Math.PI/2,-Math.PI/2+progress*tau,inner-3,gold,1.1);if(birth&&days.some(d=>dayKey(d)===birthKey)){c.globalAlpha=(1-elapsed/1400)*.55;stroke(0,tau,inner+72*eased(elapsed/1400),gold,1.6);c.globalAlpha=1}
}
function renderCalendar(now=new Date()){
 const year=displayedYear(now),days=yearDates(year),stats=productionStats(days),current=daySelected.slice(0,4)===String(year)?new Date(daySelected+"T12:00:00"):new Date(year,0,1,12);
 const selected=dayKey(current);daySelected=selected;month=current;
 for(const [id,active] of [["year-2026",!autoYear&&year===2026],["year-auto",autoYear],["year-2027",!autoYear&&year===2027]] as [string,boolean][]){$(id).classList.toggle("active",active);$(id).setAttribute("aria-pressed",String(active))}
 $<HTMLInputElement>("selected-date").value=selected;
 const shown=viewDates(year);text($("year-progress"),shown.filter(d=>dayKey(d)<=dayKey(timeReference(now))).length+" / "+shown.length);text($("chrono-level"),detailMonth===null?"Год":monthNames[detailMonth]+" · "+year);$("chrono-back").hidden=detailMonth===null;
 text($("prod-period"),String(year));
 text($("prod-work"),stats?String(stats.work):"—");text($("prod-rest"),stats?String(stats.rest):"—");text($("prod-hours"),stats?String(stats.h40):"—");
 const ms=productionStats(days.filter(d=>d.getMonth()===current.getMonth())),num=(n:number)=>n.toLocaleString("ru-RU");
 text($("prod-month"),ms?monthNames[current.getMonth()]+" · "+ms.work+" раб. / "+ms.rest+" вых. · "+ms.h40+" ч":"");
 text($("prod-norms"),stats?"36 ч — "+num(stats.h36)+" · 24 ч — "+num(stats.h24):"");
 const ep=elapsedProduction(year,now);text($("prod-remaining"),ep?String(ep.remaining):"—");text($("prod-done"),ep?String(ep.doneHours):"—");text($("prod-warning"),[stats?"":"Нет утверждённых данных на этот год",clockNotice].filter(Boolean).join(" · "));
 const kind=productionDay(current);text($("day-type"),kind?dayNames[kind]:"Тип дня неизвестен");
 renderEventRows($("day-events"),events.filter(e=>dayKey(new Date(e.at))===selected),"Нет зарегистрированных событий");
 drawYear(now);if(timeDataReady&&!playbackRunning)void refreshTimeWindow();
}
function chooseCalendarYear(year:number|null,now=new Date()){historyDate=null;detailMonth=null;autoYear=year===null;calendarYear=year??now.getFullYear();daySelected=calendarYear===now.getFullYear()?dayKey(now):dayKey(new Date(calendarYear,0,1,12));renderCalendar(now)}
$("year-2026").onclick=()=>chooseCalendarYear(2026);$("year-2027").onclick=()=>chooseCalendarYear(2027);$("year-auto").onclick=()=>chooseCalendarYear(null);$("today").onclick=()=>chooseCalendarYear(null);
$<HTMLInputElement>("selected-date").onchange=e=>{const value=(e.target as HTMLInputElement).value;if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return;const d=new Date(value+"T12:00:00");if(dayKey(d)!==value||d.getFullYear()<2026||d.getFullYear()>2100)return;calendarYear=d.getFullYear();autoYear=calendarYear===new Date().getFullYear();detailMonth=null;daySelected=value;renderCalendar()};
function openCalendarMonth(m:number,now=new Date()){if(m<0||m>11)return;detailMonth=m;const y=displayedYear(now);if(daySelected.slice(0,7)!==dayKey(new Date(y,m,1)).slice(0,7))daySelected=dayKey(new Date(y,m,1,12));renderCalendar(now)}
function closeCalendarMonth(now=new Date()){detailMonth=null;renderCalendar(now)}
$("chrono-back").onclick=()=>closeCalendarMonth();
$("prod-month").onclick=()=>openCalendarMonth(month.getMonth());
wheel.addEventListener("pointerup",e=>{const rect=wheel.getBoundingClientRect();if(!rect.width||!rect.height)return;const x=(e.clientX-rect.left)/rect.width*320-160,y=(e.clientY-rect.top)/rect.height*320-160,r=Math.hypot(x,y);if(r<66||r>160)return;if(timeShape!=="spiral"&&r<142){const hit=timeDayAt(x+160,y+160,displayedYear(new Date()));if(hit){daySelected=dayKey(hit);renderCalendar()}return}const days=viewDates(displayedYear(new Date())),angle=(Math.atan2(y,x)+Math.PI/2+tau)%tau,d=days[Math.min(days.length-1,Math.floor(angle/tau*days.length))];if(detailMonth===null&&r>=142){openCalendarMonth(d.getMonth());return}daySelected=dayKey(d);renderCalendar()});
wheel.addEventListener("dblclick",e=>{e.preventDefault();closeCalendarMonth()});
new ResizeObserver(()=>drawYear()).observe(wheel);
function renderEventRows(root:HTMLElement,list:AtlasEvent[],empty:string){root.replaceChildren();if(!list.length){text(root,empty);return}for(const e of list.slice(0,30)){const row=document.createElement("div");row.className="event-row";text(row,new Date(e.at).toLocaleString("ru-RU")+" · "+e.detail);root.append(row)}}
async function loadEvents(){try{const r=await fetch("/api/events");if(!r.ok)throw Error("API "+r.status);events=await r.json();renderCalendar();renderMatrix();renderEventRows($("notices"),events.slice(0,8),"Нет новых событий");text($("system-event"),events[0]?new Date(events[0].at).toLocaleTimeString("ru-RU")+" · "+events[0].detail.slice(0,70):"LOCAL / SQLITE / CANVAS")}catch(err){text($("notices"),"Журнал недоступен: "+String(err))}}
function renderMatrix(){const el=$("process-matrix");el.replaceChildren();const today=new Date();today.setHours(0,0,0,0);const dates=Array.from({length:7},(_,i)=>{const d=new Date(today);d.setDate(d.getDate()-6+i);return dayKey(d)});for(const kind of ["node","edge","settings"]){const label=document.createElement("div");label.className="matrix-label";text(label,kind==="node"?"Записи":kind==="edge"?"Связи":"Настройки");el.append(label);for(const date of dates){const count=events.filter(e=>e.kind===kind&&dayKey(new Date(e.at))===date).length;const b=document.createElement("button");b.className="matrix-cell"+(count?" active-cell":"");text(b,count?String(count):"·");b.title=date+" · "+kind+" · "+count;b.onclick=()=>{detailMonth=null;daySelected=date;calendarYear=Number(date.slice(0,4));autoYear=calendarYear===new Date().getFullYear();renderCalendar()};el.append(b)}}text($("skill-count"),String(state.nodes.filter(n=>n.category==="Навыки").length));text($("routine-count"),"Модуль рутин не подключён")}
renderCalendar();
function syncRanges(){for(const id of ["speed","strength","group-size","density","zoom"]){const el=$<HTMLInputElement>(id),v=Number(el.value);el.style.setProperty("--fill",100*(v-Number(el.min))/(Number(el.max)-Number(el.min))+"%");text($(id+"-value"),v.toFixed(id==="density"?0:2))}}
document.addEventListener("input",syncRanges);setInterval(syncRanges,250);syncRanges();$("toggle-panel").onclick=()=>{const hidden=document.body.classList.toggle("panel-hidden");$("toggle-panel").setAttribute("aria-pressed",String(hidden));resize()};
void loadSettings();void loadEvents();
text($("legend"),"Нажмите на ядро, чтобы открыть полный атлас");
let lastDay=dayKey(new Date()),lastWall=Date.now(),lastMono=performance.now();
function updateCalendarDate(now:Date){const key=dayKey(now);if(key!==lastDay){const lastDayBefore=lastDay,rollover=key.slice(0,4)!==lastDay.slice(0,4),wasToday=daySelected===lastDay;lastDay=key;if(rollover){yearPulse=performance.now();historyDate=null;playbackRunning=false;autoYear=true;calendarYear=now.getFullYear();daySelected=key;detailMonth=null}else if(autoYear&&wasToday){daySelected=key;if(detailMonth!==null)detailMonth=now.getMonth()}if(key.slice(0,7)!==lastDayBefore.slice(0,7))monthPulse=performance.now();if(key>lastDayBefore)animateBirth(now);renderCalendar(now)}}
function checkClock(now:Date,monoNow:number){const delta=now.getTime()-lastWall,monotonic=monoNow-lastMono;lastWall=now.getTime();lastMono=monoNow;const before=clockNotice;if(delta< -2000||Math.abs(delta-monotonic)>5000)clockNotice="Системное время изменилось или ПК проснулся";if(before!==clockNotice)renderCalendar(now)}
function needsCalendarUpdate(now:Date){return !productionRules[now.getFullYear()]||(now.getMonth()>=8&&!productionRules[now.getFullYear()+1])}
function clock(){const now=new Date();checkClock(now,performance.now());text($("clock"),now.toLocaleTimeString("ru-RU"));text($("clock-date"),now.toLocaleDateString("ru-RU",{day:"numeric",month:"short",weekday:"short"}));updateCalendarDate(now);if(needsCalendarUpdate(now)&&lastUpdateDay!==dayKey(now)){lastUpdateDay=dayKey(now);void loadCalendarUpdates(true)}}clock();setInterval(clock,1000);
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")clock()});
async function loadCalendarUpdates(refresh=false){if(updatePending)return;updatePending=true;try{const r=await fetch("/api/calendar"+(refresh?"/refresh":""),refresh?{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}:undefined);if(!r.ok)throw Error("API "+r.status);const data=await r.json();for(const rule of data.calendars??[]){if(!productionRules[rule.year]){productionRules[rule.year]={rest:rule.rest,short:rule.short,work:rule.work};timeGeometryCache.clear()}}calendarSource=data.status??"Локальные данные";text($("calendar-update-status"),calendarSource);renderCalendar()}catch{ text($("calendar-update-status"),"Обновление недоступно · сохранены локальные данные")}finally{updatePending=false}}
$("calendar-refresh").onclick=()=>void loadCalendarUpdates(true);void loadCalendarUpdates();

type ChatMessage={id:number;role:"user"|"system";content:string;created_at:string};
let chatBusy=false,chatReady=false,chatMessages:ChatMessage[]=[];
const chatInput=$<HTMLTextAreaElement>("chat-input"),chatSend=$<HTMLButtonElement>("chat-send");
function syncChat(){chatSend.disabled=chatBusy||!chatReady||!chatInput.value.trim()}
function renderChat(){const root=$("chat-log");root.replaceChildren();if(!chatMessages.length){const empty=document.createElement("div");empty.className="chat-empty";text(empty,"История сообщений пока пуста. /помощь — локальные команды.");root.append(empty)}for(const m of chatMessages){const item=document.createElement("article");item.className="chat-message "+m.role;const meta=document.createElement("div");meta.className="chat-meta";text(meta,(m.role==="user"?"Вы":"Система")+" · "+new Date(m.created_at).toLocaleString("ru-RU"));const body=document.createElement("div");text(body,m.content);item.append(meta,body);root.append(item)}root.scrollTop=root.scrollHeight}
async function loadChat(){try{const r=await fetch("/api/chat");if(!r.ok)throw Error("API "+r.status);const result=await r.json();chatMessages=result.messages;chatReady=true;renderChat();text($("chat-status"),"Локальное хранение · последние 200 сообщений")}catch{chatReady=false;text($("chat-status"),"История недоступна. Обновите страницу.")}syncChat()}
chatInput.oninput=syncChat;
async function sendChat(){if(chatBusy||!chatReady)return;const content=chatInput.value.trim();if(!content)return;chatBusy=true;syncChat();text($("chat-status"),"Сохранение…");try{const r=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({content})});const result=await r.json();if(!r.ok)throw Error(result.error??"API "+r.status);chatMessages=result.messages;if(chatInput.value.trim()===content)chatInput.value="";renderChat();signalTime();text($("chat-status"),"Сохранено в SQLite · модель не подключена")}catch(err){text($("chat-status"),"Не отправлено: "+String(err))}finally{chatBusy=false;syncChat();chatInput.focus()}}
$<HTMLFormElement>("chat-form").onsubmit=e=>{e.preventDefault();void sendChat()};
chatInput.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();void sendChat()}});
void loadChat();
// Local timeline and personnel ledger; all writes are explicit.
type TimelineResult={nodes:{id:number;title:string;category:string;at:string}[];events:AtlasEvent[];chats:AtlasEvent[];counts:{nodes:number;events:number;chats:number};daily?:{day:string;count:number}[]};
function utcBounds(d:Date,period:"day"|"year"){const a=period==="year"?new Date(d.getFullYear(),0,1):new Date(d.getFullYear(),d.getMonth(),d.getDate()),b=period==="year"?new Date(d.getFullYear()+1,0,1):new Date(d.getFullYear(),d.getMonth(),d.getDate()+1);return "start="+encodeURIComponent(a.toISOString())+"&end="+encodeURIComponent(b.toISOString())}
async function jsonRequest(url:string,data?:unknown){const r=await fetch(url,data===undefined?undefined:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});const v=await r.json();if(!r.ok)throw Error(v.error??"API "+r.status);return v}
async function refreshTimeWindow(){const key=daySelected;if(key===timeWindowKey)return;timeWindowKey=key;const req=++timeRequest,d=new Date(key+"T12:00:00");if(!Number.isFinite(d.getTime()))return;try{
 const [day,year]:[TimelineResult,TimelineResult]=await Promise.all([jsonRequest("/api/time/window?"+utcBounds(d,"day")),jsonRequest("/api/time/window?"+utcBounds(d,"year"))]);if(req!==timeRequest)return;
 timeDayCounts.clear();timeCategories.clear();for(const node of state.nodes){if(!node.created_at)continue;const k=dayKey(new Date(node.created_at));if(k.slice(0,4)!==key.slice(0,4))continue;timeDayCounts.set(k,(timeDayCounts.get(k)??0)+1);timeCategories.set(node.category,(timeCategories.get(node.category)??0)+1)}
 for(const item of [...year.events,...year.chats]){if(item.kind==="node")continue;const k=dayKey(new Date(item.at));timeDayCounts.set(k,(timeDayCounts.get(k)??0)+1)}
 timeEventDates=Array.from(timeDayCounts.keys()).sort();text($("time-history-status"),key+" · записей "+day.counts.nodes+" · событий "+day.counts.events+" · сообщений "+day.counts.chats);
 const root=$("time-memory");root.replaceChildren();for(const n of day.nodes.slice(0,50)){const b=document.createElement("button");b.className="entry";text(b,n.category+" · "+n.title);b.onclick=()=>focusNode(n.id);root.append(b)}
 for(const item of [...day.events.filter(e=>e.kind!=="node"),...day.chats].sort((a,b)=>a.at.localeCompare(b.at)).slice(0,50)){const row=document.createElement("p");text(row,new Date(item.at).toLocaleTimeString("ru-RU")+" · "+item.detail);root.append(row)}
 if(!root.children.length)text(root,"Нет зарегистрированных событий");
 const total=Array.from(timeCategories.values()).reduce((a,b)=>a+b,0),top=Array.from(timeCategories).sort((a,b)=>b[1]-a[1])[0];
 text($("time-biography"),"За год: "+total+" датированных записей; "+year.counts.chats+" сообщений. "+(top?"Чаще всего: "+top[0]+" ("+top[1]+").":"Нет датированных знаний.")+" События: до 500 записей журнала для визуализации.");
 drawYear();
 }catch(err){if(req===timeRequest){timeWindowKey="";text($("time-history-status"),String(err))}}}
async function renderTimeSnapshots(save=false){try{const list=await jsonRequest("/api/time/snapshots",save?{day:daySelected,mode:timeShape}:undefined);const root=$("time-snapshots");root.replaceChildren();for(const item of list.slice(0,20)){const b=document.createElement("button");b.className="entry";text(b,item.day+" · "+item.nodes+" записей · "+item.edges+" связей");b.onclick=()=>{setTimeShape(item.mode);historySelect(item.day)};root.append(b)}}catch(err){text($("time-history-status"),String(err))}}
$<HTMLSelectElement>("time-shape").onchange=e=>setTimeShape((e.target as HTMLSelectElement).value as TimeShape);
$("time-replay").onclick=()=>startTimePlayback("year");$("time-events-replay").onclick=()=>startTimePlayback("events");$("time-live").onclick=stopTimePlayback;
$("time-travel").onclick=()=>historySelect(daySelected);$("time-snapshot").onclick=()=>void renderTimeSnapshots(true);$("time-refresh").onclick=()=>{timeWindowKey="";void refreshTimeWindow();void renderTimeSnapshots()};
wheel.addEventListener("pointermove",e=>{const rect=wheel.getBoundingClientRect();timeCursor={x:(e.clientX-rect.left)/Math.max(1,rect.width)*320-160,y:(e.clientY-rect.top)/Math.max(1,rect.height)*320-160}});wheel.addEventListener("pointerleave",()=>timeCursor={x:0,y:0});
timeOverlay=$<HTMLCanvasElement>("time-overlay");timeOverlayCtx=timeOverlay.getContext("2d");requestAnimationFrame(overlayFrame);
timeDataReady=true;void refreshTimeWindow();void renderTimeSnapshots();
type WorkProfile={id:number;name:string;schedule:string;anchor:string;hours:number};
type WorkRow={profile_id:number;name:string;day:string;planned:number|null;actual:number|null;status:string;difference:number|null};
type WorkReport={month:string;profiles:WorkProfile[];rows:WorkRow[];summary:{profile_id:number;name:string;planned:number;actual:number;difference:number;unknown:number;missing:number}[]};
let workReportData:WorkReport|null=null,workRequest=0,workBusy=false;
const workInput=(id:string)=>$<HTMLInputElement>(id),workSelect=(id:string)=>$<HTMLSelectElement>(id);
function workNumber(id:string){const v=workInput(id).value.trim();return v===""?null:Number(v)}
function renderWorkDay(){const p=Number(workSelect("work-person").value),d=workInput("work-day").value,r=workReportData?.rows.find(r=>r.profile_id===p&&r.day===d);workInput("work-planned").value=r?.planned==null?"":String(r.planned);workInput("work-actual").value=r?.actual==null?"":String(r.actual);workSelect("work-status").value=r?.status??"normal"}
function renderWork(report:WorkReport){workReportData=report;options(workSelect("work-person"),report.profiles.map(p=>({value:String(p.id),label:p.name+" · "+p.schedule})));const root=$("work-summary");root.replaceChildren();
 for(const p of report.summary.slice(0,200)){const row=document.createElement("div");row.className="work-person-row";const head=document.createElement("strong");text(head,p.name);const bar=document.createElement("div");bar.className="work-bar";const fill=document.createElement("i");fill.style.width=(p.planned?Math.min(100,p.actual/p.planned*100):0)+"%";bar.append(fill);const meta=document.createElement("small");text(meta,"План "+p.planned+" ч · факт "+p.actual+" ч · Δ "+p.difference+" ч · нет факта: "+p.missing+(p.unknown?" · не задан план: "+p.unknown:""));row.append(head,bar,meta);root.append(row)}
 if(!report.profiles.length)text(root,"Добавьте сотрудника");renderWorkDay();
 const tbody=$("work-table");tbody.replaceChildren();const id=Number(workSelect("work-person").value);for(const r of report.rows.filter(x=>x.profile_id===id)){const row=document.createElement("div");row.className="work-day-row";text(row,r.day.slice(8)+" · "+(r.planned??"—")+" / "+(r.actual??"—")+" ч");row.onclick=()=>{workInput("work-day").value=r.day;renderWorkDay()};tbody.append(row)}
 const exportLink=$<HTMLAnchorElement>("work-export");exportLink.href="/api/work/export?month="+encodeURIComponent(report.month);exportLink.download="timesheet-"+report.month+".xlsx";
}
async function loadWork(){const m=workInput("work-month").value,req=++workRequest;if(!/^\d{4}-\d{2}$/.test(m))return;try{const report=await jsonRequest("/api/work/report?month="+encodeURIComponent(m));if(req!==workRequest)return;renderWork(report);text($("work-message"),"План — прогноз нагрузки; Δ не является юридическим расчётом сверхурочных.")}catch(err){if(req===workRequest)text($("work-message"),String(err))}}
async function workWrite(url:string,data:unknown){if(workBusy)return;workBusy=true;try{await jsonRequest(url,data);await loadWork()}catch(err){text($("work-message"),String(err))}finally{workBusy=false}}
workInput("work-month").value=daySelected.slice(0,7);workInput("work-day").value=daySelected;workInput("work-anchor").value=daySelected;
$("work-reload").onclick=()=>void loadWork();$("work-panel").addEventListener("toggle",()=>{if(($("work-panel") as HTMLDetailsElement).open)void loadWork()});
workInput("work-month").onchange=()=>{workInput("work-day").value=workInput("work-month").value+"-01";void loadWork()};workInput("work-day").onchange=()=>{if(workInput("work-day").value.slice(0,7)!==workInput("work-month").value){workInput("work-month").value=workInput("work-day").value.slice(0,7);void loadWork()}else renderWorkDay()};workSelect("work-person").onchange=()=>{if(workReportData)renderWork(workReportData)};
$<HTMLFormElement>("work-profile-form").onsubmit=e=>{e.preventDefault();void workWrite("/api/work/profiles",{name:workInput("work-name").value,schedule:workSelect("work-schedule").value,anchor:workInput("work-anchor").value,hours:workNumber("work-hours")})};
$<HTMLFormElement>("work-day-form").onsubmit=e=>{e.preventDefault();void workWrite("/api/work/day",{profile_id:Number(workSelect("work-person").value),day:workInput("work-day").value,planned:workNumber("work-planned"),actual:workNumber("work-actual"),status:workSelect("work-status").value})};
fetch("/api/atlas").then(r=>{if(!r.ok)throw new Error("API "+r.status);return r.json()}).then(s=>{setState(s);if(timeDataReady){timeWindowKey="";void refreshTimeWindow()}}).catch(err=>{text($("status"),"API недоступен");text($("message"),String(err))});
