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
async function post(path:string,body:unknown){const r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const s=await r.json();if(!r.ok)throw new Error(s.error??"Ошибка API");setState(s as Snapshot);void loadEvents()}
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
const productionRules:Record<number,{rest:string[];short:string[]}>={
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
 return d.getDay()===0||d.getDay()===6?"weekend":"work";
}
function yearDates(y:number){const result:Date[]=[];for(let d=new Date(y,0,1,12);d.getFullYear()===y;d.setDate(d.getDate()+1))result.push(new Date(d));return result}
function productionStats(dates:Date[]){
 if(!dates.length||dates.some(d=>productionDay(d)===null))return null;
 let work=0,short=0;for(const d of dates){const t=productionDay(d);if(t==="work"||t==="short")work++;if(t==="short")short++}
 return {work,rest:dates.length-work,short,h40:work*8-short,h36:Math.round((work*7.2-short)*10)/10,h24:Math.round((work*4.8-short)*10)/10};
}
let autoYear=true,calendarYear=new Date().getFullYear();
const wheel=$<HTMLCanvasElement>("year-wheel"),wheelCtx=wheel.getContext("2d")!;
function displayedYear(now:Date){return autoYear?now.getFullYear():calendarYear}
function elapsedDays(year:number,now:Date){const key=dayKey(now);return yearDates(year).filter(d=>dayKey(d)<=key).length}
function drawYear(now=new Date()){
 const y=displayedYear(now),days=yearDates(y),today=dayKey(now),selected=daySelected;
 const box=wheel.getBoundingClientRect();const side=Math.max(1,Math.min(box.width,box.height));if(side<=1)return;
 const size=Math.max(1,Math.round(side*Math.min(devicePixelRatio||1,2)));if(wheel.width!==size)wheel.width=size;if(wheel.height!==size)wheel.height=size;
 const c=wheelCtx;c.setTransform(size/320,0,0,size/320,0,0);c.clearRect(0,0,320,320);
 const center=160,inner=69,step=tau/days.length;
 const dark=!paper(),base=dark?"#273a45":"#c9c7bf",ink=dark?"#9db1be":"#52646c",gold=dark?"#eac275":"#987026";
 const point=(angle:number,r:number)=>({x:center+Math.cos(angle)*r,y:center+Math.sin(angle)*r});
 function stroke(a:number,b:number,r:number,color:string,w:number){c.beginPath();c.arc(center,center,r,a,b);c.strokeStyle=color;c.lineWidth=w;c.stroke()}
 stroke(0,tau,inner-4,base,.8);stroke(0,tau,inner-10,base,.5);stroke(0,tau,140,base,.5);
 for(let i=0;i<60;i++){const angle=-Math.PI/2+i*tau/60,p=point(angle,inner-9),q=point(angle,inner-(i%5===0?15:12));c.beginPath();c.moveTo(p.x,p.y);c.lineTo(q.x,q.y);c.strokeStyle=i%5===0?gold:base;c.lineWidth=i%5===0?1:.6;c.stroke()}
 for(let i=0;i<days.length;i++){
  const d=days[i],key=dayKey(d),type=productionDay(d),angle=-Math.PI/2+(i+.5)*step,passed=key<=today;
  // Ray height grows with the ordinal day; a new ray is filled at local midnight.
  const length=12+57*(i+1)/days.length,tip=inner+length,p=point(angle,inner),q=point(angle,tip);
  c.globalAlpha=passed?1:.19;c.strokeStyle=type?dayColors[type]:base;c.lineWidth=key===today?2:1.02;c.beginPath();c.moveTo(p.x,p.y);c.lineTo(q.x,q.y);c.stroke();c.globalAlpha=1;
  if(key===today||key===selected){const k=point(angle,tip+3);c.beginPath();c.arc(k.x,k.y,key===today?2.5:1.6,0,tau);c.fillStyle=key===today?gold:ink;c.fill()}
  if(d.getDate()===1){const p1=point(angle-step/2,inner-1),p2=point(angle-step/2,141);c.strokeStyle=base;c.lineWidth=.7;c.beginPath();c.moveTo(p1.x,p1.y);c.lineTo(p2.x,p2.y);c.stroke()}
 }
 for(let m=0;m<12;m++){const first=days.findIndex(d=>d.getMonth()===m),n=new Date(y,m+1,0).getDate(),angle=-Math.PI/2+(first+n/2)*step,p=point(angle,151);c.font="9px "+mono;c.textAlign="center";c.textBaseline="middle";c.fillStyle=now.getFullYear()===y&&now.getMonth()===m?gold:ink;c.fillText(monthNames[m],p.x,p.y)}
 const progress=elapsedDays(y,now)/days.length;stroke(-Math.PI/2,-Math.PI/2+progress*tau,inner-3,gold,1.1);
}
function renderCalendar(now=new Date()){
 const year=displayedYear(now),days=yearDates(year),stats=productionStats(days),current=daySelected.slice(0,4)===String(year)?new Date(daySelected+"T12:00:00"):new Date(year,0,1,12);
 const selected=dayKey(current);daySelected=selected;month=current;
 for(const [id,active] of [["year-2026",!autoYear&&year===2026],["year-auto",autoYear],["year-2027",!autoYear&&year===2027]] as [string,boolean][]){$(id).classList.toggle("active",active);$(id).setAttribute("aria-pressed",String(active))}
 $<HTMLInputElement>("selected-date").value=selected;
 text($("year-progress"),elapsedDays(year,now)+" / "+days.length);
 text($("prod-period"),String(year));
 text($("prod-work"),stats?String(stats.work):"—");text($("prod-rest"),stats?String(stats.rest):"—");text($("prod-hours"),stats?String(stats.h40):"—");
 const ms=productionStats(days.filter(d=>d.getMonth()===current.getMonth())),num=(n:number)=>n.toLocaleString("ru-RU");
 text($("prod-month"),ms?monthNames[current.getMonth()]+" · "+ms.work+" раб. / "+ms.rest+" вых. · "+ms.h40+" ч":"");
 text($("prod-norms"),stats?"36 ч — "+num(stats.h36)+" · 24 ч — "+num(stats.h24):"");
 text($("prod-warning"),stats?"":"Нет утверждённых данных на этот год");
 const kind=productionDay(current);text($("day-type"),kind?dayNames[kind]:"Тип дня неизвестен");
 renderEventRows($("day-events"),events.filter(e=>dayKey(new Date(e.at))===selected),"Нет зарегистрированных событий");
 drawYear(now);
}
function chooseCalendarYear(year:number|null,now=new Date()){autoYear=year===null;calendarYear=year??now.getFullYear();daySelected=calendarYear===now.getFullYear()?dayKey(now):dayKey(new Date(calendarYear,0,1,12));renderCalendar(now)}
$("year-2026").onclick=()=>chooseCalendarYear(2026);$("year-2027").onclick=()=>chooseCalendarYear(2027);$("year-auto").onclick=()=>chooseCalendarYear(null);$("today").onclick=()=>chooseCalendarYear(null);
$<HTMLInputElement>("selected-date").onchange=e=>{const value=(e.target as HTMLInputElement).value;if(!/^202[67]-\d{2}-\d{2}$/.test(value))return;const d=new Date(value+"T12:00:00");if(dayKey(d)!==value)return;calendarYear=d.getFullYear();autoYear=calendarYear===new Date().getFullYear();daySelected=value;renderCalendar()};
wheel.addEventListener("pointerup",e=>{const rect=wheel.getBoundingClientRect(),x=(e.clientX-rect.left)/rect.width*320-160,y=(e.clientY-rect.top)/rect.height*320-160,r=Math.hypot(x,y);if(r<66||r>158)return;const days=yearDates(displayedYear(new Date())),angle=(Math.atan2(y,x)+Math.PI/2+tau)%tau,d=days[Math.min(days.length-1,Math.floor(angle/tau*days.length))];daySelected=dayKey(d);renderCalendar()});
new ResizeObserver(()=>drawYear()).observe(wheel);
function renderEventRows(root:HTMLElement,list:AtlasEvent[],empty:string){root.replaceChildren();if(!list.length){text(root,empty);return}for(const e of list.slice(0,30)){const row=document.createElement("div");row.className="event-row";text(row,new Date(e.at).toLocaleString("ru-RU")+" · "+e.detail);root.append(row)}}
async function loadEvents(){try{const r=await fetch("/api/events");if(!r.ok)throw Error("API "+r.status);events=await r.json();renderCalendar();renderMatrix();renderEventRows($("notices"),events.slice(0,8),"Нет новых событий");text($("system-event"),events[0]?new Date(events[0].at).toLocaleTimeString("ru-RU")+" · "+events[0].detail.slice(0,70):"LOCAL / SQLITE / CANVAS")}catch(err){text($("notices"),"Журнал недоступен: "+String(err))}}
function renderMatrix(){const el=$("process-matrix");el.replaceChildren();const today=new Date();today.setHours(0,0,0,0);const dates=Array.from({length:7},(_,i)=>{const d=new Date(today);d.setDate(d.getDate()-6+i);return dayKey(d)});for(const kind of ["node","edge","settings"]){const label=document.createElement("div");label.className="matrix-label";text(label,kind==="node"?"Записи":kind==="edge"?"Связи":"Настройки");el.append(label);for(const date of dates){const count=events.filter(e=>e.kind===kind&&dayKey(new Date(e.at))===date).length;const b=document.createElement("button");b.className="matrix-cell"+(count?" active-cell":"");text(b,count?String(count):"·");b.title=date+" · "+kind+" · "+count;b.onclick=()=>{daySelected=date;calendarYear=Number(date.slice(0,4));autoYear=calendarYear===new Date().getFullYear();renderCalendar()};el.append(b)}}text($("skill-count"),String(state.nodes.filter(n=>n.category==="Навыки").length));text($("routine-count"),"Модуль рутин не подключён")}
renderCalendar();
function syncRanges(){for(const id of ["speed","strength","group-size","density","zoom"]){const el=$<HTMLInputElement>(id),v=Number(el.value);el.style.setProperty("--fill",100*(v-Number(el.min))/(Number(el.max)-Number(el.min))+"%");text($(id+"-value"),v.toFixed(id==="density"?0:2))}}
document.addEventListener("input",syncRanges);setInterval(syncRanges,250);syncRanges();$("toggle-panel").onclick=()=>{const hidden=document.body.classList.toggle("panel-hidden");$("toggle-panel").setAttribute("aria-pressed",String(hidden));resize()};
void loadSettings();void loadEvents();
text($("legend"),"Нажмите на ядро, чтобы открыть полный атлас");
let lastDay=dayKey(new Date());
function updateCalendarDate(now:Date){const key=dayKey(now);if(key!==lastDay){const rollover=key.slice(0,4)!==lastDay.slice(0,4),wasToday=daySelected===lastDay;lastDay=key;if(rollover){autoYear=true;calendarYear=now.getFullYear();daySelected=key}else if(autoYear&&wasToday)daySelected=key;renderCalendar(now)}}
function clock(){const now=new Date();text($("clock"),now.toLocaleTimeString("ru-RU"));text($("clock-date"),now.toLocaleDateString("ru-RU",{day:"numeric",month:"short",weekday:"short"}));updateCalendarDate(now)}clock();setInterval(clock,1000);
type ChatMessage={id:number;role:"user"|"system";content:string;created_at:string};
let chatBusy=false,chatReady=false,chatMessages:ChatMessage[]=[];
const chatInput=$<HTMLTextAreaElement>("chat-input"),chatSend=$<HTMLButtonElement>("chat-send");
function syncChat(){chatSend.disabled=chatBusy||!chatReady||!chatInput.value.trim()}
function renderChat(){const root=$("chat-log");root.replaceChildren();if(!chatMessages.length){const empty=document.createElement("div");empty.className="chat-empty";text(empty,"История сообщений пока пуста. /помощь — локальные команды.");root.append(empty)}for(const m of chatMessages){const item=document.createElement("article");item.className="chat-message "+m.role;const meta=document.createElement("div");meta.className="chat-meta";text(meta,(m.role==="user"?"Вы":"Система")+" · "+new Date(m.created_at).toLocaleString("ru-RU"));const body=document.createElement("div");text(body,m.content);item.append(meta,body);root.append(item)}root.scrollTop=root.scrollHeight}
async function loadChat(){try{const r=await fetch("/api/chat");if(!r.ok)throw Error("API "+r.status);const result=await r.json();chatMessages=result.messages;chatReady=true;renderChat();text($("chat-status"),"Локальное хранение · последние 200 сообщений")}catch{chatReady=false;text($("chat-status"),"История недоступна. Обновите страницу.")}syncChat()}
chatInput.oninput=syncChat;
async function sendChat(){if(chatBusy||!chatReady)return;const content=chatInput.value.trim();if(!content)return;chatBusy=true;syncChat();text($("chat-status"),"Сохранение…");try{const r=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({content})});const result=await r.json();if(!r.ok)throw Error(result.error??"API "+r.status);chatMessages=result.messages;if(chatInput.value.trim()===content)chatInput.value="";renderChat();text($("chat-status"),"Сохранено в SQLite · модель не подключена")}catch(err){text($("chat-status"),"Не отправлено: "+String(err))}finally{chatBusy=false;syncChat();chatInput.focus()}}
$<HTMLFormElement>("chat-form").onsubmit=e=>{e.preventDefault();void sendChat()};
chatInput.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();void sendChat()}});
void loadChat();
fetch("/api/atlas").then(r=>{if(!r.ok)throw new Error("API "+r.status);return r.json()}).then(setState).catch(err=>{text($("status"),"API недоступен");text($("message"),String(err))});
