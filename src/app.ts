export {};
type NodeRecord={id:number;title:string;category:string;folder?:string;created_at?:string|null};
type Edge={source:number;target:number};
type Snapshot={nodes:NodeRecord[];edges:Edge[];categories:string[];revision?:number;causes?:Edge[]};
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
function categoryCounts(){const totals=new Map<string,number>();for(const n of state.nodes)totals.set(n.category,(totals.get(n.category)??0)+1);return state.categories.map(c=>totals.get(c)??0)}
let cameraTarget:{zoom:number;pan:Point}|null=null;
const mono="JetBrains Mono, Cascadia Mono, Consolas, Liberation Mono, monospace";
function paper(){return document.documentElement.classList.contains("paper")}
function gridInk(){return paper()?"#71868f88":"#42637399"}
const motionPreference=matchMedia("(prefers-reduced-motion: reduce)");let reduced=motionPreference.matches;
const tau=Math.PI*2;
function makeDemo():{nodes:NodeRecord[];edges:Edge[]}{
 const ns=state.categories.flatMap((category,g)=>Array.from({length:28+g*3},(_,i)=>({id:-(g*1000+i+1),title:category+" · "+(i+1),category,folder:["Архив","Текущие","Исследования"][i%3]})));
 const es:Edge[]=ns.filter((_,i)=>i%7===0).flatMap((n,i)=>[{source:n.id,target:ns[(i*19+37)%ns.length].id}]).filter(e=>e.source!==e.target);
 return {nodes:ns,edges:es};
}
function text(el:HTMLElement,s:string){el.textContent=s}
function setState(s:Snapshot){
 if(s.revision!==undefined&&state.revision!==undefined&&s.revision<state.revision)return;
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
 drawCognitiveSignals();
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
 if(expanded&&strength>0){let drawn=0,scanned=0;for(const e of state.causes??[]){if(drawn>=250||++scanned>2500)break;const a=positions.get(e.source),b=positions.get(e.target);if(!a||!b||(!screenVisible(a)&&!screenVisible(b)))continue;const angle=Math.atan2(b.y-a.y,b.x-a.x),tip={x:b.x-Math.cos(angle)*9,y:b.y-Math.sin(angle)*9};line(a,tip,colors[0]+"aa");line(tip,{x:tip.x-Math.cos(angle-.55)*9,y:tip.y-Math.sin(angle-.55)*9},colors[0]);line(tip,{x:tip.x-Math.cos(angle+.55)*9,y:tip.y-Math.sin(angle+.55)*9},colors[0]);drawn++}}
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
function layout(isExpanded:boolean){if(expanded===isExpanded)return;if(expanded)atlasMode=mode;expanded=isExpanded;revealAt=performance.now();$("atlas-loading").hidden=!expanded||reduced;groupHover=-1;$("module-tip").hidden=true;$("layout").classList.toggle("expanded",expanded);$("home").classList.toggle("active",!expanded);$("atlas").classList.toggle("active",expanded);text($("subtitle"),expanded?"Детальная карта памяти":"КОМАНДНЫЙ ЦЕНТР · ЖИВОЕ ЯДРО");text($("brand-mode"),expanded?"Атлас памяти":"Командный центр");mode=expanded?atlasMode:"radial";document.querySelectorAll<HTMLElement>("[data-mode]").forEach(x=>x.classList.toggle("active",x.dataset.mode===mode));resize();reset();positions.forEach(p=>{p.x*=.12;p.y*=.12});const el=$("layout");el.classList.remove("reveal");void el.offsetWidth;el.classList.add("reveal");text($("legend"),expanded?"Колесо — масштаб · Перетаскивание — перемещение · Двойной щелчок — фокус":"Нажмите на ядро, чтобы открыть полный атлас");if(!expanded){chooseCalendarYear(null);wakeCinema()}}
$("core-open").onclick=()=>layout(true);
$("home").onclick=()=>{closeProjectSettings();layout(false)};$("atlas").onclick=()=>{closeProjectSettings();layout(true)};
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
function renderPalettes(){const root=$("palettes");root.replaceChildren();for(const name of ["Металл","Рубин","Океан","Неон","Бордо","Бумага","Императорская","Полярная"]){const p=palettes.find(x=>x.name===name)!;const b=document.createElement("button");b.className="swatch"+(colors===p.colors?" active":"");const s=document.createElement("span");s.textContent=p.name;const bar=document.createElement("b");for(const c of p.colors.slice(0,5)){const i=document.createElement("i");i.style.background=c;bar.append(i)}bar.style.background=p.name==="Бумага"?"#f2f0e8":p.name==="Рубин"?"#200b14":p.name==="Бордо"?"#251018":"#08121b";b.append(bar,s);if(colors===p.colors){const tag=document.createElement("small");tag.textContent="АКТИВНА";b.append(tag)}b.onclick=()=>{colors=p.colors;document.documentElement.style.setProperty("--accent",colors[0]);document.documentElement.classList.toggle("paper",p.name==="Бумага");renderPalettes();refreshPanels();drawYear();wakeCinema()};root.append(b)}}renderPalettes();
function refreshDetails(){const n=selected===null?undefined:nodeMap.get(selected);const el=$("details");el.replaceChildren();if(!n){text(el,"Выберите запись на карте");return}const info=document.createElement("p");text(info,n.title+" · "+n.category+" · "+folderOf(n)+" · "+age(n)+" · "+(neighbor.get(n.id)?.size??0)+" связей"+(n.category==="Документы"?" · Физический файл не привязан":""));el.append(info);for(const id of Array.from(neighbor.get(n.id)??[]).slice(0,30)){const other=nodeMap.get(id);if(other){const b=document.createElement("button");b.className="entry";const outgoing=state.causes?.some(e=>e.source===n.id&&e.target===id),incoming=state.causes?.some(e=>e.target===n.id&&e.source===id);text(b,(outgoing?"Следствие → ":incoming?"← Причина: ":"")+other.title);b.onclick=()=>focusNode(id);el.append(b)}}}
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
function refreshCounts(){text($("counts"),demo?"БД пуста · демонстрационный граф":"Записей "+state.nodes.length+" · Связей "+state.edges.length+" · На карте "+visible.length)}
async function post(path:string,body:unknown){const r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const s=await r.json();if(!r.ok)throw new Error(s.error??"Ошибка API");setState(s as Snapshot);signalTime();void loadEvents()}
$<HTMLFormElement>("add").onsubmit=async e=>{e.preventDefault();try{await post("/api/nodes",{title:$<HTMLInputElement>("title").value,category:$<HTMLSelectElement>("category").value,folder:$<HTMLInputElement>("folder").value});$<HTMLInputElement>("title").value="";text($("message"),"Запись сохранена")}catch(err){text($("message"),String(err))}};
$<HTMLFormElement>("link").onsubmit=async e=>{e.preventDefault();try{await post("/api/edges",{source:Number($<HTMLSelectElement>("source").value),target:Number($<HTMLSelectElement>("target").value)});text($("message"),"Связь сохранена")}catch(err){text($("message"),String(err))}};
$("save-settings").onclick=async()=>{try{const r=await fetch("/api/settings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({palette:palettes.find(p=>p.colors===colors)?.name,speed,density,strength,groupSize,showLabels,cinemaMode,cinemaPower})});if(!r.ok)throw Error("API "+r.status);text($("message"),"Настройки сохранены в SQLite");void loadEvents()}catch(err){text($("message"),String(err))}};
$<HTMLInputElement>("show-labels").onchange=e=>showLabels=(e.target as HTMLInputElement).checked;
$("export-png").onclick=()=>{canvas.toBlob(blob=>{if(!blob)return;const url=URL.createObjectURL(blob);const link=document.createElement("a");link.href=url;link.download="amatsumireika-atlas.png";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)},"image/png")};
async function loadSettings(){try{const response=await fetch("/api/settings");if(!response.ok)throw Error("API "+response.status);let saved=await response.json();if(!saved||typeof saved!=="object"||Array.isArray(saved))saved={};if(Object.keys(saved).length===0){try{saved=JSON.parse(localStorage.getItem("atlas-visual-v2")??"{}")}catch{saved={}}}if(!saved||typeof saved!=="object"||Array.isArray(saved))saved={};const p=palettes.find(p=>p.name===saved.palette);if(p){colors=p.colors;document.documentElement.style.setProperty("--accent",colors[0]);document.documentElement.classList.toggle("paper",p.name==="Бумага")}if(Number.isFinite(saved.speed))speed=Math.max(0,Math.min(2,saved.speed));if(Number.isFinite(saved.density))density=Math.max(12,Math.min(180,saved.density));if(Number.isFinite(saved.strength))strength=Math.max(0,Math.min(1,saved.strength));if(Number.isFinite(saved.groupSize))groupSize=Math.max(.55,Math.min(1,saved.groupSize));if(typeof saved.showLabels==="boolean")showLabels=saved.showLabels;if(["auto","cinema","quiet","off"].includes(saved.cinemaMode))cinemaMode=saved.cinemaMode;if(typeof saved.cinemaPower==="number"&&Number.isFinite(saved.cinemaPower))cinemaPower=cinemaClamp(saved.cinemaPower,0,1);$<HTMLSelectElement>("cinema-mode").value=cinemaMode;$<HTMLInputElement>("cinema-power").value=String(cinemaPower*100);cinemaSettings();$<HTMLInputElement>("speed").value=String(speed);$<HTMLInputElement>("density").value=String(density);$<HTMLInputElement>("strength").value=String(strength);$<HTMLInputElement>("group-size").value=String(groupSize);$<HTMLInputElement>("show-labels").checked=showLabels;renderPalettes();rebuild();refreshPanels();drawYear();wakeCinema()}catch(err){text($("message"),"Настройки: "+String(err))}}
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
const dayColors:Record<DayType,string>={work:"#d9af61",weekend:"#b4bec9",holiday:"#ffe5a2",short:"#bc8254",transfer:"#b4bec9"};
const paperDayColors:Record<DayType,string>={work:"#956510",weekend:"#586779",holiday:"#78500a",short:"#955039",transfer:"#586779"};
function dayPaint(type:DayType){return (paper()?paperDayColors:dayColors)[type]}
const dayNames:Record<DayType,string>={work:"Рабочий день · 8 ч",weekend:"Выходной",holiday:"Праздник",short:"Сокращённый день · 7 ч",transfer:"Перенесённый выходной"};
const monthNames=["Янв","Фев","Мар","Апр","Май","Июн","Июл","Авг","Сен","Окт","Ноя","Дек"];
const fullMonthNames=["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
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
const timeShape="spiral";
// A single sampled local clock for the live calendar, digits and animated rings.
let chronosWall=new Date(),chronosMono=performance.now();
function chronosNow(){return new Date(chronosWall.getTime())}
function chronosFrame(now:number){return new Date(chronosWall.getTime()+Math.min(999-chronosWall.getMilliseconds(),Math.max(0,now-chronosMono)))}
let chronosHover="",chronosLinkDate="",chronosLinkAt=-100000,chronosRenderKey="",chronosPreviewRay:TimeRay|undefined;
function chronosLink(key:string){chronosLinkDate=key;chronosLinkAt=performance.now();wakeCinema()}
function chronosPreview(key:string){if(chronosHover===key)return;chronosHover=key;chronosPreviewRay=key?timeGeometry(displayedYear(chronosNow()),detailMonth).find(v=>dayKey(v.d)===key):undefined;wakeCinema()}
function weekProgress(d:Date){const w=(d.getDay()+6)%7;return (w+(d.getHours()*3600+d.getMinutes()*60+d.getSeconds())/86400)/7}
function parseJumpDate(value:string){if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return null;const d=new Date(value+"T12:00:00");return Number.isFinite(d.getTime())&&dayKey(d)===value&&d.getFullYear()>=2026&&d.getFullYear()<=2100?d:null}

let monthPulse=-100000,yearPulse=-100000;
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
// One open radial spiral, advancing counterclockwise so its silhouette descends clockwise.
const spiralInner=68;
function timeInner(detail:boolean){return detail?73:spiralInner}
function spiralAngle(i:number,n:number){return -Math.PI/2-tau*(i+.5)/n}
function spiralIndex(x:number,y:number,n:number){const a=(-Math.atan2(y,x)-Math.PI/2+tau)%tau;return Math.min(n-1,Math.floor(a/tau*n))}
function timeGeometry(y:number,m:number|null):TimeRay[]{
 const k=y+":"+m,old=timeGeometryCache.get(k);if(old)return old;
 const dates=geometryDates(y).filter(d=>m===null||d.getMonth()===m);
 const inner=timeInner(m!==null),result=dates.map((d,i)=>{const a=spiralAngle(i,dates.length);return {d,type:productionDay(d),p:timePoint(a,inner),q:timePoint(a,inner+calendarRayLength(d,m!==null))}});
 if(timeGeometryCache.size>=32)timeGeometryCache.delete(timeGeometryCache.keys().next().value!);
 timeGeometryCache.set(k,result);return result
}
function signalTime(){timePulse=performance.now();cinemaBurst(160,160,24,65,1);wakeCinema();$("stage").classList.remove("time-signal");if(cinemaMotion()){void $("stage").offsetWidth;$("stage").classList.add("time-signal")}timeWindowKey="";if(timeDataReady)void refreshTimeWindow()}
function historySelect(value:string|null){playbackRunning=false;historyDate=value;if(value){const d=new Date(value+"T12:00:00");if(!Number.isFinite(d.getTime())){historyDate=null;return}autoYear=false;calendarYear=d.getFullYear();detailMonth=null;daySelected=value}else chooseCalendarYear(null);renderCalendar()}
function startTimePlayback(kind:"year"|"events",reverse=false){playbackRunning=false;playbackSerial++;playbackKind=kind;cinemaReverse=reverse;playbackDays=kind==="year"?geometryDates(displayedYear(new Date())).map(dayKey):timeEventDates.slice();if(!playbackDays.length){text($("time-history-status"),"Нет дат для воспроизведения");return}if(reverse)playbackDays.reverse();playbackAt=performance.now();playbackRunning=true;historyDate=playbackDays[0];const serial=++playbackSerial;requestAnimationFrame(n=>playTime(n,serial))}
function playTime(now:number,serial=playbackSerial){if(!playbackRunning||serial!==playbackSerial)return;const i=Math.min(playbackDays.length-1,Math.floor((now-playbackAt)/Math.max(65,14000/playbackDays.length)));historyDate=playbackDays[i];daySelected=historyDate;calendarYear=Number(historyDate.slice(0,4));autoYear=false;detailMonth=null;drawYear();text($("time-history-status"),"Просмотр "+historyDate);if(i+1>=playbackDays.length){playbackRunning=false;renderCalendar()}else requestAnimationFrame(n=>playTime(n,serial))}
function stopTimePlayback(){playbackRunning=false;playbackSerial++;historyDate=null;chooseCalendarYear(null)}
// Cinematic layer. Date geometry remains authoritative and hit targets never move.
type CinemaMode="auto"|"cinema"|"quiet"|"off";
type Spark={x:number;y:number;vx:number;vy:number;life:number;max:number;size:number;hue:number};
let cinemaMode:CinemaMode="cinema",cinemaPower=.9,cinemaTier=2,cinemaVisible=true,cinemaPending=false;
let cinemaCost=0,cinemaFrames=0,cinemaSlow=0,cinemaFast=0,cinemaTick=0,cinemaClockText="",cinemaSecondAt=-100000;
let cinemaMonthAt=-100000,cinemaQuarterAt=-100000,cinemaRevealAt=-100000,cinemaYearAt=-100000,cinemaBirthAt=-100000;
let cinemaPreviousYear=0,cinemaPreviousDate="",cinemaReverse=false,playbackSerial=0,cinemaLastDate="";
let cinemaPointer:Point={x:0,y:0};
let cinemaDigitEls:HTMLElement[]=[];
function cinemaMotion(){return !reduced&&cinemaMode!=="off"&&cinemaPower>0}
function cinemaQuiet(hour:number){return cinemaMode==="quiet"||(cinemaMode==="auto"&&(hour<6||hour>=23))}

const cinemaSparks:Spark[]=[],cinemaSprites=new Map<string,HTMLCanvasElement>();
const cinemaColors=["#eac275","#42c9af","#a78add","#78a5e6","#fff1c9"];
function cinemaClamp(v:number,min:number,max:number){return Math.max(min,Math.min(max,v))}
function cinemaBudget(mode:CinemaMode,hour:number,tier:number,reduce:boolean){
 if(reduce||mode==="off")return {fps:1,count:0,rich:false};
 const night=mode==="auto"&&(hour<6||hour>=23),quiet=mode==="quiet"||night;
 return {fps:quiet?15:tier===2?60:tier===1?30:15,count:quiet?18:tier===2?96:tier===1?54:24,rich:!quiet&&tier>0};
}
function cinemaColor(hour:number){const h=hour%24;return h<6?mixHex("#8499d3","#eac275",eased(h/6)*.35):h<10?mixHex("#eac275","#66d8cb",eased((h-6)/4)):h<17?"#66d8cb":h<21?mixHex("#66d8cb","#eac275",eased((h-17)/4)):mixHex("#eac275","#8499d3",eased((h-21)/3))}
function cinemaSprite(color:string){let sprite=cinemaSprites.get(color);if(sprite)return sprite;sprite=document.createElement("canvas");sprite.width=48;sprite.height=48;const c=sprite.getContext("2d");if(!c)return sprite;const g=c.createRadialGradient(24,24,0,24,24,24);g.addColorStop(0,color);g.addColorStop(.25,color+"96");g.addColorStop(1,color+"00");c.fillStyle=g;c.fillRect(0,0,48,48);if(cinemaSprites.size>=16)cinemaSprites.delete(cinemaSprites.keys().next().value!);cinemaSprites.set(color,sprite);return sprite}
function cinemaGlow(c:CanvasRenderingContext2D,x:number,y:number,r:number,color:string,alpha:number){c.globalAlpha=cinemaClamp(alpha,0,1);c.drawImage(cinemaSprite(color),x-r,y-r,r*2,r*2);c.globalAlpha=1}
function cinemaBurst(x:number,y:number,count:number,force:number,hue=0){
 if(!cinemaMotion()||!cinemaOnscreen())return;
 for(let i=0;i<count&&cinemaSparks.length<180;i++){const a=i*2.399963+cinemaTick*.013,v=force*(.4+.6*((i*17%23)/23)),life=.55+(i%9)*.1;cinemaSparks.push({x,y,vx:Math.cos(a)*v,vy:Math.sin(a)*v,life,max:life,size:.6+(i%4)*.3,hue})}
}
function stepCinemaParticle(p:Spark,dt:number,target:Point){const t=cinemaClamp(dt,0,.05),dx=target.x-p.x,dy=target.y-p.y,r=Math.max(12,Math.hypot(dx,dy)),a=16/(1+r*.04);p.vx=(p.vx+dx/r*a*t)*Math.exp(-.65*t);p.vy=(p.vy+dy/r*a*t)*Math.exp(-.65*t);p.x+=p.vx*t;p.y+=p.vy*t;p.life-=t;return p.life>0}
function cinemaEvent(now:Date,oldDay:string){const key=dayKey(now),at=performance.now();if(key<=oldDay)return;cinemaBirthAt=at;cinemaBurst(160,160,40,80);
 if(key.slice(0,7)!==oldDay.slice(0,7)){cinemaMonthAt=at;cinemaBurst(160,160,48,100,1);if(now.getMonth()%3===0)cinemaQuarterAt=at;}
 if(key.slice(0,4)!==oldDay.slice(0,4)){cinemaYearAt=at;cinemaPreviousYear=Number(oldDay.slice(0,4));cinemaBurst(160,160,75,115,2)}wakeCinema();
}
function cinemaLens(p:Point,mouse:Point,amount:number):Point{const dx=p.x-(160+mouse.x),dy=p.y-(160+mouse.y),d=Math.hypot(dx,dy),f=amount*Math.exp(-d*d/1150);return{x:p.x+dx*f,y:p.y+dy*f}}
function cinemaRing(c:CanvasRenderingContext2D,r:number,a:number,b:number,col:string,w:number,alpha=1){c.globalAlpha=cinemaClamp(alpha,0,1);c.strokeStyle=col;c.lineWidth=w;c.beginPath();c.arc(160,160,Math.max(0,r),a,b);c.stroke();c.globalAlpha=1}
function cinemaLine(c:CanvasRenderingContext2D,a:Point,b:Point,col:string,w:number,alpha:number){c.globalAlpha=cinemaClamp(alpha,0,1);c.strokeStyle=col;c.lineWidth=w;c.beginPath();c.moveTo(a.x,a.y);c.lineTo(b.x,b.y);c.stroke();c.globalAlpha=1}
function cinemaYearTransition(c:CanvasRenderingContext2D,now:number,power:number){
 const f=(now-cinemaYearAt)/2400;if(f<0||f>=1)return;
 const t=eased(f),inward=f<.5?1-eased(f*2):eased((f-.5)*2);
 for(let i=0;i<48;i++){const a=i*tau/48+t*2.5+(cinemaPreviousYear%17)*.04,rad=8+inward*(110+i%8*2),q=timePoint(a,rad);cinemaGlow(c,q.x,q.y,3+(i%3),cinemaColors[i%3],(1-f)*power*.6)}
 cinemaRing(c,8+inward*125,0,tau,"#bfa0e8",2,Math.sin(f*Math.PI)*power);
 if(f>.5)cinemaRing(c,8+eased((f-.5)*2)*132,0,tau,"#eac275",1.1,(1-f)*power);
}
function cinemaWave(c:CanvasRenderingContext2D,now:number,at:number,duration:number,col:string,from:number,to:number,power:number){const t=(now-at)/duration;if(t<0||t>=1)return;cinemaRing(c,from+(to-from)*eased(t),0,tau,col,1.1+2*(1-t),Math.sin(Math.PI*t)*power)}
function cinemaDraw(c:CanvasRenderingContext2D,now:number,d:Date,dt:number,budget:ReturnType<typeof cinemaBudget>){
 const sec=d.getSeconds()+d.getMilliseconds()/1000,min=d.getMinutes()+sec/60;
 const gold=paper()?"#80550f":"#ffd17a",light=paper()?"#586779":"#f5eee1",muted=paper()?"#a58d62":"#a9854b";
 const a=-Math.PI/2+tau*sec/60,inner=timeInner(detailMonth!==null);
 // A single readable track at every second, including zero and reduced motion.
 cinemaRing(c,inner-5,0,tau,muted,1.25,.78);
 cinemaRing(c,inner-5,-Math.PI/2,a,gold,1.35,.94);

 const minuteTip=timePoint(-Math.PI/2+tau*min/60,inner-5);c.fillStyle=light;c.beginPath();c.arc(minuteTip.x,minuteTip.y,1.35,0,tau);c.fill();
 const p=timePoint(a,inner-5);c.fillStyle=gold;c.beginPath();c.arc(p.x,p.y,2,0,tau);c.fill();
 const rays=timeGeometry(displayedYear(d),detailMonth);
 // Static hover highlighting survives reduced motion and disabled decorative effects.
 if(chronosPreviewRay)cinemaLine(c,chronosPreviewRay.p,chronosPreviewRay.q,gold,2.4,.9);
 if(!budget.count||!cinemaPower)return;
 const ref=dayKey(timeReference(d)),filled=rays.filter(v=>dayKey(v.d)<=ref);
 const target=filled.length?filled[filled.length-1].q:p,phase=now*.001,power=cinemaPower*.55*(.58+.42*Math.sin(Math.PI*(d.getHours()+d.getMinutes()/60)/24));
 const liveKey=dayKey(d),todayRay=rays.find(v=>dayKey(v.d)===liveKey);
 if(todayRay){const ratio=weekProgress(d),q={x:todayRay.p.x+(todayRay.q.x-todayRay.p.x)*ratio,y:todayRay.p.y+(todayRay.q.y-todayRay.p.y)*ratio};cinemaLine(c,todayRay.p,q,gold,2,.7*power)}
 const lf=(now-chronosLinkAt)/650,linked=lf>=0&&lf<1?rays.find(v=>dayKey(v.d)===chronosLinkDate):undefined;
 if(linked&&lf>=0&&lf<1){const t=eased(lf),q={x:linked.p.x+(linked.q.x-linked.p.x)*t,y:linked.p.y+(linked.q.y-linked.p.y)*t};cinemaGlow(c,q.x,q.y,7,gold,Math.sin(Math.PI*lf)*power);cinemaLine(c,linked.p,q,gold,1.8,(1-lf)*power)}
 cinemaYearTransition(c,now,power);
 cinemaWave(c,now,cinemaRevealAt,650,gold,inner-1,inner+(detailMonth===null?152:66),.36*power);
 cinemaWave(c,now,cinemaBirthAt,900,gold,inner,inner+(detailMonth===null?156:70),.3*power);
 cinemaGlow(c,p.x,p.y,3.5,gold,.35*power);
 if(filled.length){
  cinemaGlow(c,target.x,target.y,5,gold,.4*power);
  const head=Math.floor((phase*.025%1)*filled.length),count=Math.min(7,filled.length);
  for(let i=0;i<count;i++){const v=filled[(head-i+filled.length)%filled.length],alpha=(1-i/count)*power;
   cinemaGlow(c,v.q.x,v.q.y,2.5,gold,alpha*.22);
   cinemaLine(c,{x:v.p.x+(v.q.x-v.p.x)*.78,y:v.p.y+(v.q.y-v.p.y)*.78},v.q,seasonalRayColor(v.d,!paper()),.85,alpha*.38);
  }
 }
 for(let i=cinemaSparks.length-1;i>=0;i--){if(!stepCinemaParticle(cinemaSparks[i],dt,target))cinemaSparks.splice(i,1)}
 const pulse=(now-Math.max(cinemaBirthAt,cinemaMonthAt,cinemaYearAt,cinemaRevealAt,timePulse))/1000;
 if(pulse>=0&&pulse<1)cinemaGlow(c,target.x,target.y,8+12*eased(pulse),gold,(1-pulse)*power);
}
function cinemaOnscreen(){return cinemaVisible&&!expanded&&!presentation&&!document.body.classList.contains("settings-open")&&document.visibilityState!=="hidden"}
function wakeCinema(){if(!cinemaPending&&timeOverlayCtx&&cinemaOnscreen()){cinemaPending=true;requestAnimationFrame(overlayFrame)}}
function overlayFrame(now:number){
 cinemaPending=false;if(!timeOverlay||!timeOverlayCtx||!cinemaOnscreen())return;
 const d=chronosFrame(now),budget=cinemaBudget(cinemaPower===0?"off":cinemaMode,d.getHours(),cinemaTier,reduced);
 if(now-timeLast<1000/budget.fps-.8){wakeCinema();return}
 const start=performance.now(),dt=timeLast?Math.min(.05,(now-timeLast)/1000):1/60;timeLast=now;cinemaTick++;
 const c=timeOverlayCtx,sz=wheel.width;if(timeOverlay.width!==sz)timeOverlay.width=sz;if(timeOverlay.height!==sz)timeOverlay.height=sz;
 timeCanvasTransform(c,sz,detailMonth!==null);
 cinemaDraw(c,now,d,dt,budget);timeOverlay.setAttribute("data-frame",String(cinemaTick));
 const cost=performance.now()-start;cinemaCost=cinemaFrames?cinemaCost*.94+cost*.06:cost;cinemaFrames++;
 if(cinemaCost>10){cinemaSlow++;cinemaFast=0}else if(cinemaCost<4){cinemaFast++;cinemaSlow=0}else{cinemaFast=0;cinemaSlow=0}
 if(cinemaSlow>=30){cinemaTier=Math.max(0,cinemaTier-1);cinemaSlow=0}
 if(cinemaFast>=180){cinemaTier=Math.min(2,cinemaTier+1);cinemaFast=0}
 if(cinemaFrames%60===0||budget.fps===1)text($("time-performance"),"Canvas "+cinemaCost.toFixed(1)+" мс · цель "+budget.fps+" FPS · "+cinemaSparks.length+" частиц");
 if(budget.fps>1)wakeCinema();
}
function cinemaDigits(now:Date){
 const value=[now.getHours(),now.getMinutes(),now.getSeconds()].map(v=>String(v).padStart(2,"0")).join(":"),root=$("clock");
 if(value===cinemaClockText)return;
 const old=cinemaClockText;cinemaClockText=value;root.setAttribute("aria-label",value);
 if(cinemaDigitEls.length!==value.length){root.replaceChildren();cinemaDigitEls=[];for(const [i,ch] of Array.from(value).entries()){const s=document.createElement("span");s.className=(ch===":"?"cinema-colon":"cinema-digit")+(i>=5?" clock-seconds":"");s.setAttribute("aria-hidden","true");root.append(s);cinemaDigitEls.push(s)}}
 const quiet=cinemaQuiet(now.getHours());$("left").setAttribute("data-night",String(quiet));$("left").style.setProperty("--chrono-daylight",String(.55+.45*Math.sin(Math.PI*(now.getHours()+now.getMinutes()/60)/24)));
 for(let i=0;i<value.length;i++){const ch=value[i],s=cinemaDigitEls[i];if(ch===old[i]&&s.textContent===ch)continue;text(s,ch);s.classList.remove("digit-arrive");s.removeAttribute("data-old");
 if(ch!==":"&&ch!==old[i]&&cinemaMotion()&&!quiet&&cinemaOnscreen()){void s.offsetWidth;s.classList.add("digit-arrive");if(old[i]&&old[i]!==":"){if(i<2&&now.getMinutes()===0&&now.getSeconds()===0)cinemaBurst(160,160,3,12,0)}}}
 cinemaSecondAt=performance.now();wakeCinema();
}
function cinemaSettings(){
 const v=$<HTMLSelectElement>("cinema-mode").value;
 if(["auto","cinema","quiet","off"].includes(v))cinemaMode=v as CinemaMode;
 const p=Number($<HTMLInputElement>("cinema-power").value);if(Number.isFinite(p))cinemaPower=cinemaClamp(p/100,0,1);
 $("left").setAttribute("data-cinema",cinemaMode);$("left").style.setProperty("--cinema-intensity",String(cinemaPower));
 if(cinemaMode==="off"||cinemaPower===0){cinemaSparks.length=0;timeLast=0;drawYear()}
 try{localStorage.setItem("chrono-cinema-v2",JSON.stringify({mode:cinemaMode,power:cinemaPower}))}catch{}
 wakeCinema();
}
function viewDates(y:number){const all=geometryDates(y);return detailMonth===null?all:all.filter(d=>d.getMonth()===detailMonth)}
function elapsedProduction(year:number,now:Date){const dates=yearDates(year),total=productionStats(dates);if(!total)return null;const past=dates.filter(d=>dayKey(d)<dayKey(now)),done=past.length?productionStats(past):{work:0,h40:0};return done?{remaining:total.work-done.work,doneHours:done.h40}:null}
// Monday-first calendar weeks clipped to each month, including partial weeks.
function monthWeek(d:Date){const first=new Date(d.getFullYear(),d.getMonth(),1,12),offset=(first.getDay()+6)%7,last=new Date(d.getFullYear(),d.getMonth()+1,0,12).getDate();return {index:Math.floor((offset+d.getDate()-1)/7),count:Math.ceil((offset+last)/7)}}
function calendarRayLength(d:Date,detail=false){
 const w=monthWeek(d),m=d.getMonth();
 // A whole week is a visible band of equal-length daily rays. Every month begins above the preceding month.
 if(detail)return 3+63*Math.pow((w.index+1)/w.count,2.1);
 // Stronger month steps, gentler weekly shelves: the yearly fan grows almost linearly.
 const last=new Date(d.getFullYear(),m+1,0,12).getDate();
 const progress=(m+.18+.82*d.getDate()/last)/12;
 return 10+142*Math.pow(progress,1.48);
}
// Longer annual rays with room for full outward-facing month labels.
const annualTimeSide=520;
function timeViewSide(detail:boolean){return detail?320:annualTimeSide}
function timeCanvasTransform(c:CanvasRenderingContext2D,size:number,detail:boolean){
 const scale=size/timeViewSide(detail),offset=size/2-160*scale;
 c.setTransform(1,0,0,1,0,0);c.clearRect(0,0,size,size);c.setTransform(scale,0,0,scale,offset,offset);
}
function timePointer(clientX:number,clientY:number,rect:{left:number;top:number;width:number;height:number},detail:boolean):Point{
 const side=timeViewSide(detail);
 return {x:(clientX-rect.left)/Math.max(1,rect.width)*side-side/2,y:(clientY-rect.top)/Math.max(1,rect.height)*side-side/2};
}
type MonthLabel={angle:number;radius:number;width:number;ux:number;uy:number;label:string;fontSize:number};
const monthLabelCache=new Map<number,MonthLabel[]>();
function labelCorners(l:MonthLabel,pad=0):Point[]{
 return [l.radius-pad,l.radius+l.width+pad].flatMap(r=>[-7-pad,7+pad].map(t=>({x:r*l.ux-t*l.uy,y:r*l.uy+t*l.ux})));
}
function labelsOverlap(a:MonthLabel,b:MonthLabel,pad=1){
 const ac=labelCorners(a,pad),bc=labelCorners(b,pad);
 for(const axis of [{x:a.ux,y:a.uy},{x:-a.uy,y:a.ux},{x:b.ux,y:b.uy},{x:-b.uy,y:b.ux}]){
  const p=ac.map(v=>v.x*axis.x+v.y*axis.y),q=bc.map(v=>v.x*axis.x+v.y*axis.y);
  if(Math.max(...p)<=Math.min(...q)||Math.max(...q)<=Math.min(...p))return false;
 }
 return true;
}
function monthLabelLayouts(y:number){
 const cached=monthLabelCache.get(y);if(cached)return cached;
 const days=geometryDates(y),placed:MonthLabel[]=[];
 for(let m=0;m<12;m++){
  const first=days.findIndex(d=>d.getMonth()===m),last=new Date(y,m+1,0,12),n=last.getDate(),base=-Math.PI/2-(first+n/2)*tau/days.length,tip=spiralInner+calendarRayLength(last),label=fullMonthNames[m];
  const candidate=(shift:number,gutter:number,fontSize:number):MonthLabel=>{
   const angle=base+shift,ux=Math.cos(angle),uy=Math.sin(angle),radius=tip+8+gutter,edge=annualTimeSide/2-4;
   const limit=Math.min((edge-7*Math.abs(uy))/Math.max(.00001,Math.abs(ux)),(edge-7*Math.abs(ux))/Math.max(.00001,Math.abs(uy)));
   return {angle,radius,width:Math.min(Math.max(30,label.length*fontSize*.78),70,limit-radius),ux,uy,label,fontSize};
  };
  let best=candidate(0,0,12);
  outer:for(const font of [12,11,10,9])for(const gutter of [0,3,6])for(const shift of [0,.035,-.035,.07,-.07]){
   const v=candidate(shift,gutter,font);
   if(v.width>=30&&!placed.some(p=>labelsOverlap(p,v))){best=v;break outer}
  }
  placed.push(best);
 }
 if(monthLabelCache.size>=8)monthLabelCache.delete(monthLabelCache.keys().next().value!);
 monthLabelCache.set(y,placed);return placed;
}
function monthLabelLayout(y:number,m:number){return monthLabelLayouts(y)[m]}
function rayStrokeWidth(inner:number,tip:number,step:number,detail:boolean){return Math.min(detail?3.5:1.25,Math.max(.5,inner*step*.82))}
function relativeLuminance(hex:string){
 const v=parseInt(hex.slice(1),16),linear=(x:number)=>{const c=x/255;return c<=.04045?c/12.92:Math.pow((c+.055)/1.055,2.4)};
 return .2126*linear((v>>16)&255)+.7152*linear((v>>8)&255)+.0722*linear(v&255);
}
function contrastRatio(a:string,b:string){const x=relativeLuminance(a),y=relativeLuminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)}
function readableSeason(m:number,dark:boolean){const bg=dark?"#08121b":"#f2f0e8",base=seasonPaint(m,dark);for(let i=0;i<=20;i++){const col=mixHex(base,dark?"#ffffff":"#000000",i/20);if(contrastRatio(col,bg)>=4.5)return col}return dark?"#ffffff":"#000000"}
function weekStartKey(d:Date){const start=new Date(d.getFullYear(),d.getMonth(),d.getDate(),12);start.setDate(start.getDate()-(start.getDay()+6)%7);return dayKey(start)}
function calendarHit(x:number,y:number,days:Date[],detail:boolean){
 const r=Math.hypot(x,y),inner=timeInner(detail);if(r<inner-2||!days.length||Math.max(Math.abs(x),Math.abs(y))>timeViewSide(detail)/2)return null;
 const date=days[spiralIndex(x,y,days.length)],tip=inner+calendarRayLength(date,detail);
 if(r<=tip+5)return {date,month:false};
 if(!detail){
  const layout=monthLabelLayout(date.getFullYear(),date.getMonth()),along=x*layout.ux+y*layout.uy,across=-x*layout.uy+y*layout.ux;
  if(along>=layout.radius-3&&along<=layout.radius+layout.width+3&&Math.abs(across)<=9)return {date,month:true};
 }
 return null;
}
function eased(t:number){t=Math.max(0,Math.min(1,t));return t*t*(3-2*t)}
function mixHex(a:string,b:string,t:number){const x=parseInt(a.slice(1),16),y=parseInt(b.slice(1),16);return "#"+[16,8,0].map(k=>Math.round(((x>>k)&255)*(1-t)+((y>>k)&255)*t).toString(16).padStart(2,"0")).join("")}
function animateBirth(now:Date){birthAt=performance.now();birthKey=dayKey(now);if(!cinemaMotion()||calendarAnim||!cinemaOnscreen())return;calendarAnim=true;const tick=()=>{drawYear(new Date());if(performance.now()-birthAt<1400&&cinemaMotion()&&cinemaOnscreen())requestAnimationFrame(tick);else calendarAnim=false};requestAnimationFrame(tick)}
const wheel=$<HTMLCanvasElement>("year-wheel"),wheelCtx=wheel.getContext("2d")!;
function displayedYear(now:Date){return autoYear?now.getFullYear():calendarYear}
function elapsedDays(year:number,now:Date){const key=dayKey(now);return yearDates(year).filter(d=>dayKey(d)<=key).length}
// ISO week numbers, calculated in UTC from local calendar fields to avoid DST drift.
function isoWeek(d:Date){const t=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));t.setUTCDate(t.getUTCDate()+4-(t.getUTCDay()||7));const start=Date.UTC(t.getUTCFullYear(),0,1);return Math.ceil(((t.getTime()-start)/86400000+1)/7)}
function radialLabel(c:CanvasRenderingContext2D,label:string,a:number,r:number,color:string,font:string,width:number){
 const p=timePoint(a,r),flip=Math.cos(a)<0;
 c.save();c.translate(p.x,p.y);c.rotate(a+(flip?Math.PI:0));c.textAlign=flip?"right":"left";c.textBaseline="middle";c.fillStyle=color;c.font=font;c.fillText(label,0,0,width);c.restore();
}
function metalRay(c:CanvasRenderingContext2D,p:Point,q:Point,col:string,dark:boolean,passed:boolean,width:number){
 const grad=c.createLinearGradient(p.x,p.y,q.x,q.y);
 grad.addColorStop(0,mixHex(col,dark?"#08121b":"#f2f0e8",.24));
 grad.addColorStop(.45,col);
 grad.addColorStop(1,mixHex(col,dark?"#ffffff":"#000000",.12));
 c.globalAlpha=passed?.94:.68;c.strokeStyle=grad;c.lineWidth=width;c.beginPath();c.moveTo(p.x,p.y);c.lineTo(q.x,q.y);c.stroke();c.globalAlpha=1;
}
function animateMonthSwitch(direction=0){
 const root=$("left");root.classList.remove("chrono-month-transition");root.style.setProperty("--month-slide",direction<0?"-5px":direction>0?"5px":"0px");
 if(!cinemaMotion()||!cinemaOnscreen())return;
 void root.offsetWidth;root.classList.add("chrono-month-transition");
}
// Northern hemisphere meteorological seasons, shared by all displayed years.
type Season="winter"|"spring"|"summer"|"autumn";
function seasonOf(monthIndex:number):Season{return monthIndex===11||monthIndex<2?"winter":monthIndex<5?"spring":monthIndex<8?"summer":"autumn"}
const seasonColors:Record<Season,string>={winter:"#e7edf5",spring:"#e6a9cf",summer:"#69cfa6",autumn:"#dba253"};
const paperSeasonColors:Record<Season,string>={winter:"#738595",spring:"#a74677",summer:"#217b4a",autumn:"#a35b19"};
function seasonPaint(monthIndex:number,dark:boolean){return (dark?seasonColors:paperSeasonColors)[seasonOf(monthIndex)]}
// Blend across the first/last five days at seasonal boundaries, never change hit geometry.
function seasonalRayColor(d:Date,dark:boolean){
 const m=d.getMonth(),day=d.getDate(),last=new Date(d.getFullYear(),m+1,0).getDate(),current=seasonPaint(m,dark),prev=(m+11)%12,next=(m+1)%12;
 if(seasonOf(prev)!==seasonOf(m)&&day<=5)return mixHex(seasonPaint(prev,dark),current,.5+.5*eased((day-.5)/5));
 if(seasonOf(next)!==seasonOf(m)&&last-day<5)return mixHex(current,seasonPaint(next,dark),.5*(1-eased((last-day+.5)/5)));
 return current;
}
function seasonalHighlights(c:CanvasRenderingContext2D,rays:TimeRay[],phase:number,budget:ReturnType<typeof cinemaBudget>,power:number){
 if(!rays.length||!budget.rich||!cinemaMotion())return;
 const count=Math.min(15,rays.length);
 for(let i=0;i<count;i++){
  const v=rays[(Math.floor(phase*2)+i*Math.max(1,Math.floor(rays.length/count)))%rays.length],season=seasonOf(v.d.getMonth());
  
  const glow=(.5+.5*Math.sin(phase*1.2+i*2.4))*.26*power;
  const color=seasonalRayColor(v.d,!paper());
  const q={x:v.p.x+(v.q.x-v.p.x)*.86,y:v.p.y+(v.q.y-v.p.y)*.86};
  if(season==="winter"){c.globalAlpha=glow;c.fillStyle=color;c.beginPath();c.arc(v.q.x,v.q.y,.8,0,tau);c.fill();c.globalAlpha=1}
  else cinemaGlow(c,q.x,q.y,season==="spring"?4:season==="autumn"?4.5:3.5,color,glow);
 }
}
function drawYear(now=chronosNow()){
 const y=displayedYear(now),days=viewDates(y),today=dayKey(timeReference(now)),selected=daySelected;const elapsed=performance.now()-birthAt,birth=cinemaMotion()&&elapsed>=0&&elapsed<1400;
 const box=wheel.getBoundingClientRect();const side=Math.max(1,Math.min(box.width,box.height));if(side<=1)return;
 const size=Math.max(1,Math.round(side*Math.min(devicePixelRatio||1,2)));if(wheel.width!==size)wheel.width=size;if(wheel.height!==size)wheel.height=size;
 const c=wheelCtx;timeCanvasTransform(c,size,detailMonth!==null);$("left").setAttribute("data-time-detail",detailMonth===null?"year":"month");
 const center=160,inner=timeInner(detailMonth!==null),step=tau/days.length;
 const dark=!paper(),base=dark?"#79664b":"#9b8a70",ink=dark?"#e8e1d2":"#3e362b",gold=dark?"#ffd17a":"#80550f";
 const point=(angle:number,r:number)=>({x:center+Math.cos(angle)*r,y:center+Math.sin(angle)*r});
 function stroke(a:number,b:number,r:number,color:string,w:number){c.beginPath();c.arc(center,center,r,a,b);c.strokeStyle=color;c.lineWidth=w;c.stroke()}
 // Minimal inner clock rings; no competing outer numeric scales.
 // The independent clock layer draws the single track and progress.
 const actual=dayKey(now),liveMonth=now.getMonth(),liveWeek=weekStartKey(now),contours:Point[][]=Array.from({length:12},()=>[]);
 for(let i=0;i<days.length;i++){
  const d=days[i],key=dayKey(d),angle=spiralAngle(i,days.length),passed=key<=today,w=monthWeek(d);
  const length=calendarRayLength(d,detailMonth!==null)*(birth&&key===birthKey?Math.max(.02,eased(elapsed/1000)):1),tip=inner+length;
  const p=point(angle,inner),q=point(angle,tip),col=seasonalRayColor(d,dark);
  const currentWeek=weekStartKey(d)===liveWeek;
  metalRay(c,p,q,col,dark,passed,rayStrokeWidth(inner,tip,step,detailMonth!==null));
  contours[d.getMonth()].push(q);
  // A continuous weekly shelf, with a narrow separator at each week and month boundary.
  const prior=i?days[i-1]:null;
  const newMonth=!prior||prior.getMonth()!==d.getMonth(),newWeek=newMonth||monthWeek(prior!).index!==w.index;
  if(newMonth){const a=angle+step/2;cinemaLine(c,point(a,inner),point(a,tip),dark?"#08121b":"#f2f0e8",1.35,.95)}else if(newWeek&&detailMonth!==null){const a=angle+step/2;cinemaLine(c,point(a,tip-4),point(a,tip),dark?"#08121b":"#f2f0e8",.85,.8)}
  if(currentWeek)stroke(angle-step*.48,angle+step*.48,tip+2,gold,.9);
  if(key===actual||key===selected){
   const active=key===actual,k=point(angle,tip+3);
   cinemaLine(c,p,q,active?gold:ink,active?1.8:1.4,1);
   c.beginPath();c.arc(k.x,k.y,active?2.2:1.7,0,tau);c.fillStyle=active?gold:ink;c.fill();
  }
 }
 if(detailMonth===null){
  // A thin rounded exterior contour follows the ray tips without bridging month boundaries.
  for(let m=0;m<12;m++){const pts=contours[m];if(pts.length<2)continue;c.beginPath();c.moveTo(pts[0].x,pts[0].y);for(let i=1;i<pts.length-1;i++){const q=pts[i],n=pts[i+1];c.quadraticCurveTo(q.x,q.y,(q.x+n.x)/2,(q.y+n.y)/2)}c.lineTo(pts[pts.length-1].x,pts[pts.length-1].y);c.strokeStyle=readableSeason(m,dark);c.globalAlpha=.35;c.lineWidth=.55;c.stroke();c.globalAlpha=1}
  for(let m=0;m<12;m++){
   const label=monthLabelLayout(y,m),current=y===now.getFullYear()&&m===liveMonth;
   // Text extends away from each month band; flip the left half for upright reading.
   radialLabel(c,label.label,label.angle,label.radius,current?gold:readableSeason(m,dark),(current?"600 ":"500 ")+label.fontSize+"px Manrope, Inter, sans-serif",label.width);
  }
 }else{
  // Day numbers appear only after deliberate month drilldown.
  for(let i=0;i<days.length;i++){
   const d=days[i],a=spiralAngle(i,days.length),p=point(a,Math.min(149,inner+calendarRayLength(d,true)+9)),key=dayKey(d);
   c.font=(key===actual||key===selected?"700 ":"500 ")+"9px Inter, Segoe UI, sans-serif";c.textAlign="center";c.textBaseline="middle";c.fillStyle=key===actual||key===selected?gold:ink;c.fillText(String(i+1),p.x,p.y,16);
  }
 }
 if(birth&&days.some(d=>dayKey(d)===birthKey)){c.globalAlpha=(1-elapsed/1400)*.55;stroke(0,tau,inner+72*eased(elapsed/1400),gold,1.6);c.globalAlpha=1}
}
// Monday-first month layout. Render only the four to six rows actually required.
function monthCells(year:number,m:number):(Date|null)[]{
 const first=new Date(year,m,1,12),offset=(first.getDay()+6)%7,count=new Date(year,m+1,0,12).getDate();
 return Array.from({length:Math.ceil((offset+count)/7)*7},(_,i)=>i>=offset&&i<offset+count?new Date(year,m,i-offset+1,12):null);
}
function selectMonthDate(d:Date,now=chronosNow()){
 if(d.getFullYear()<2026||d.getFullYear()>2100)return;
 playbackRunning=false;playbackSerial++;historyDate=null;calendarYear=d.getFullYear();autoYear=calendarYear===now.getFullYear();
 if(detailMonth!==null)detailMonth=d.getMonth();const delta=(d.getFullYear()-month.getFullYear())*12+d.getMonth()-month.getMonth();daySelected=dayKey(d);chronosPreview("");renderCalendar(now);chronosLink(daySelected);if(delta)animateMonthSwitch(delta);
}
function moveMonth(offset:number,now=chronosNow()){
 const d=new Date(month.getFullYear(),month.getMonth()+offset,1,12);
 if(d.getFullYear()<2026||d.getFullYear()>2100)return;
 const day=Math.min(month.getDate(),new Date(d.getFullYear(),d.getMonth()+1,0,12).getDate());
 d.setDate(day);selectMonthDate(d,now);
}
// Unknown future years: show normal weekend pattern, never invent official transfers.
function monthDayKind(d:Date):DayType{
 return productionDay(d)??(officialHolidays.has(dayKey(d).slice(5))?"holiday":d.getDay()===0||d.getDay()===6?"weekend":"work");
}
function renderMonthGrid(current:Date,now:Date){
 const y=current.getFullYear(),m=current.getMonth(),selected=dayKey(current),today=dayKey(now),root=$("month-grid");
 const signature=[selected,today,JSON.stringify(productionRules[y]??null),detailMonth].join("|");
 if(signature===chronosRenderKey)return;
 text($("month-heading"),fullMonthNames[m]+" "+y+" г.");$("spiral-tooltip").hidden=true;
 const dateLabel=(d:Date)=>d.toLocaleDateString("ru-RU",{day:"numeric",month:"long",year:"numeric"});
 text($("chrono-today-label"),"Сегодня: "+dateLabel(now));text($("chrono-selected-label"),"Выбрано: "+dateLabel(current));
 const jump=$<HTMLInputElement>("chrono-jump");if(document.activeElement!==jump)jump.value=selected;chronosPreview("");
 const prev=root.querySelector<HTMLElement>(".is-selected"),previousRect=prev?.getBoundingClientRect();chronosRenderKey=signature;
 $("left").style.setProperty("--chrono-season-dark",readableSeason(m,true));$("left").style.setProperty("--chrono-season-paper",readableSeason(m,false));
 $("month-heading").setAttribute("aria-pressed",String(detailMonth!==null));$("month-heading").style.setProperty("--season-dark",readableSeason(m,true));$("month-heading").style.setProperty("--season-light",readableSeason(m,false));
 text($("month-rule-notice"),productionRules[y]?"":"Переносы на этот год не загружены; показаны обычные выходные и фиксированные праздники.");
 $<HTMLButtonElement>("month-prev").disabled=y===2026&&m===0;
 $<HTMLButtonElement>("month-next").disabled=y===2100&&m===11;
 root.replaceChildren();
 for(const d of monthCells(y,m)){
  if(!d){const blank=document.createElement("span");blank.className="month-blank";blank.setAttribute("aria-hidden","true");root.append(blank);continue}
  const k=dayKey(d),b=document.createElement("button");b.type="button";b.className="month-day";
  const kind=monthDayKind(d);b.classList.add("kind-"+kind);b.setAttribute("data-date",k);
  if(k<today)b.classList.add("is-past");
  if(weekStartKey(d)===weekStartKey(now))b.classList.add("is-current-week");
  if(k===today){b.classList.add("is-today");b.setAttribute("aria-current","date")}
  if(k===selected)b.classList.add("is-selected");
  b.setAttribute("aria-pressed",String(k===selected));const kindLabel=productionRules[y]?dayNames[kind]:kind==="holiday"?"Фиксированный праздник":kind==="weekend"?"Обычный выходной":"Предварительно рабочий день";
  const label=d.toLocaleDateString("ru-RU",{weekday:"long",day:"numeric",month:"long",year:"numeric"})+" · "+kindLabel+(k===today?" · Сегодня":"")+(k===selected?" · Выбрано":"");b.setAttribute("aria-label",label);b.title=label;
  text(b,String(d.getDate()));b.addEventListener("pointerenter",()=>chronosPreview(k));b.addEventListener("pointerleave",()=>chronosPreview(""));b.addEventListener("focus",()=>chronosPreview(k));b.addEventListener("blur",()=>chronosPreview(""));b.onclick=()=>{selectMonthDate(d);const next=root.children[(d.getDay()+6)%7+7*Math.floor(((new Date(y,m,1,12).getDay()+6)%7+d.getDate()-1)/7)] as HTMLElement|undefined;next?.focus()};root.append(b);
  if(k===selected&&previousRect&&cinemaMotion()&&cinemaOnscreen()){
   const rect=b.getBoundingClientRect(),dx=previousRect.left-rect.left,dy=previousRect.top-rect.top;
   if(Math.abs(dx)+Math.abs(dy)>1&&Math.abs(dx)+Math.abs(dy)<400){b.style.setProperty("--ring-x",dx+"px");b.style.setProperty("--ring-y",dy+"px");b.classList.add("ring-arrive")}
  }
 }
}
$("month-prev").onclick=()=>moveMonth(-1);
$("month-next").onclick=()=>moveMonth(1);
$("chrono-jump-go").onclick=()=>{const d=parseJumpDate($<HTMLInputElement>("chrono-jump").value);if(d){selectMonthDate(d);text($("chrono-jump-status"),"Дата выбрана")}else text($("chrono-jump-status"),"Допустимые даты: 2026–2100")};
$("month-heading").onclick=()=>{if(detailMonth===null)openCalendarMonth(month.getMonth());else closeCalendarMonth()};
function focusCalendarSelection(){ $("month-grid").querySelector<HTMLElement>(".is-selected")?.focus() }
$("month-grid").addEventListener("keydown",e=>{
 if(e.key==="Home"){e.preventDefault();chooseCalendarYear(null);focusCalendarSelection();return}
 const delta:Record<string,number>={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7};
 if(delta[e.key]!==undefined){e.preventDefault();const d=new Date(daySelected+"T12:00:00");d.setDate(d.getDate()+delta[e.key]);selectMonthDate(d);focusCalendarSelection()}
});
let calendarSwipe:Point|null=null,calendarSwipeAt=-100000;
$("month-grid").addEventListener("pointerdown",e=>{if(e.pointerType==="touch")calendarSwipe={x:e.clientX,y:e.clientY}});
$("month-grid").addEventListener("pointercancel",()=>{calendarSwipe=null});
$("month-grid").addEventListener("pointerup",e=>{const start=calendarSwipe;calendarSwipe=null;if(!start)return;const dx=e.clientX-start.x,dy=e.clientY-start.y;if(Math.abs(dx)>42&&Math.abs(dx)>Math.abs(dy)*1.5){calendarSwipeAt=performance.now();moveMonth(dx<0?1:-1)}});
$("month-grid").addEventListener("click",e=>{if(performance.now()-calendarSwipeAt<350){e.preventDefault();e.stopPropagation()}},true);
function renderCalendar(now=chronosNow()){
 const year=displayedYear(now),current=daySelected.slice(0,4)===String(year)?new Date(daySelected+"T12:00:00"):new Date(year,0,1,12);
 const selected=dayKey(current);daySelected=selected;month=current;renderMonthGrid(current,now);


 renderEventRows($("day-events"),events.filter(e=>dayKey(new Date(e.at))===selected),"Нет зарегистрированных событий");
 drawYear(now);if(timeDataReady&&!playbackRunning)void refreshTimeWindow();
}
function chooseCalendarYear(year:number|null,now=chronosNow()){const prior=displayedYear(now);if(prior!==(year??now.getFullYear())){cinemaYearAt=performance.now();cinemaPreviousYear=prior;wakeCinema()}historyDate=null;detailMonth=null;autoYear=year===null;calendarYear=year??now.getFullYear();daySelected=calendarYear===now.getFullYear()?dayKey(now):dayKey(new Date(calendarYear,0,1,12));renderCalendar(now)}
function openCalendarMonth(m:number,now=chronosNow()){if(m<0||m>11)return;cinemaRevealAt=performance.now();wakeCinema();detailMonth=m;const y=displayedYear(now);if(daySelected.slice(0,7)!==dayKey(new Date(y,m,1)).slice(0,7))daySelected=dayKey(new Date(y,m,1,12));renderCalendar(now);animateMonthSwitch()}
function closeCalendarMonth(now=chronosNow()){cinemaRevealAt=performance.now();wakeCinema();detailMonth=null;renderCalendar(now);animateMonthSwitch()}

wheel.addEventListener("pointerup",e=>{const rect=wheel.getBoundingClientRect();if(!rect.width||!rect.height)return;const p=timePointer(e.clientX,e.clientY,rect,detailMonth!==null),hit=calendarHit(p.x,p.y,viewDates(displayedYear(chronosNow())),detailMonth!==null);if(!hit)return;if(hit.month){openCalendarMonth(hit.date.getMonth());return}selectMonthDate(hit.date)});
wheel.addEventListener("dblclick",e=>{e.preventDefault();closeCalendarMonth()});
new ResizeObserver(()=>drawYear()).observe(wheel);
// Canvas labels are redrawn when local fonts finish loading, with safe system-font fallback.
if(document.fonts){void Promise.all([document.fonts.load("11px Inter","Январь Сентябрь Декабрь"),document.fonts.load("10px JetBrains Mono","ЯНВ")]).then(()=>drawYear()).catch(()=>{})}
function renderEventRows(root:HTMLElement,list:AtlasEvent[],empty:string){root.replaceChildren();if(!list.length){text(root,empty);return}for(const e of list.slice(0,30)){const row=document.createElement("div");row.className="event-row";text(row,new Date(e.at).toLocaleString("ru-RU")+" · "+e.detail);root.append(row)}}
async function loadEvents(){try{const r=await fetch("/api/events");if(!r.ok)throw Error("API "+r.status);events=await r.json();renderCalendar();renderMatrix();renderEventRows($("notices"),events.slice(0,8),"Нет новых событий");text($("system-event"),events[0]?new Date(events[0].at).toLocaleTimeString("ru-RU")+" · "+events[0].detail.slice(0,70):"LOCAL / SQLITE / CANVAS")}catch(err){text($("notices"),"Журнал недоступен: "+String(err))}}
function renderMatrix(){const el=$("process-matrix");el.replaceChildren();const today=new Date();today.setHours(0,0,0,0);const dates=Array.from({length:7},(_,i)=>{const d=new Date(today);d.setDate(d.getDate()-6+i);return dayKey(d)});for(const kind of ["node","edge","settings"]){const label=document.createElement("div");label.className="matrix-label";text(label,kind==="node"?"Записи":kind==="edge"?"Связи":"Настройки");el.append(label);for(const date of dates){const count=events.filter(e=>e.kind===kind&&dayKey(new Date(e.at))===date).length;const b=document.createElement("button");b.className="matrix-cell"+(count?" active-cell":"");text(b,count?String(count):"·");b.title=date+" · "+kind+" · "+count;b.onclick=()=>{detailMonth=null;daySelected=date;calendarYear=Number(date.slice(0,4));autoYear=calendarYear===new Date().getFullYear();renderCalendar()};el.append(b)}}text($("skill-count"),String(state.nodes.filter(n=>n.category==="Навыки").length));text($("routine-count"),"Локальные задачи — в когнитивном ядре")}
renderCalendar();
function syncRanges(){for(const id of ["speed","strength","group-size","density","zoom"]){const el=$<HTMLInputElement>(id),v=Number(el.value);el.style.setProperty("--fill",100*(v-Number(el.min))/(Number(el.max)-Number(el.min))+"%");text($(id+"-value"),v.toFixed(id==="density"?0:2))}}
document.addEventListener("input",syncRanges);setInterval(syncRanges,250);syncRanges();$("toggle-panel").onclick=()=>{const hidden=document.body.classList.toggle("panel-hidden");$("toggle-panel").setAttribute("aria-pressed",String(hidden));resize()};
void loadSettings();void loadEvents();
text($("legend"),"Нажмите на ядро, чтобы открыть полный атлас");
let lastDay=dayKey(new Date()),lastWall=Date.now(),lastMono=performance.now();
function updateCalendarDate(now:Date){const key=dayKey(now);if(key!==lastDay){const lastDayBefore=lastDay,rollover=key.slice(0,4)!==lastDay.slice(0,4),wasToday=daySelected===lastDay;lastDay=key;if(rollover){yearPulse=performance.now();historyDate=null;playbackRunning=false;autoYear=true;calendarYear=now.getFullYear();daySelected=key;detailMonth=null}else if(autoYear&&wasToday){daySelected=key;if(detailMonth!==null)detailMonth=now.getMonth()}if(key.slice(0,7)!==lastDayBefore.slice(0,7)){monthPulse=performance.now();animateMonthSwitch(1)}if(key>lastDayBefore){animateBirth(now);cinemaEvent(now,lastDayBefore)}renderCalendar(now)}}
function checkClock(now:Date,monoNow:number){const delta=now.getTime()-lastWall,monotonic=monoNow-lastMono;lastWall=now.getTime();lastMono=monoNow;const before=clockNotice;if(delta< -2000||Math.abs(delta-monotonic)>5000)clockNotice="Системное время изменилось или ПК проснулся";if(before!==clockNotice)renderCalendar(now)}
function needsCalendarUpdate(now:Date){return !productionRules[now.getFullYear()]||(now.getMonth()>=8&&!productionRules[now.getFullYear()+1])}
function clock(){const now=new Date();chronosWall=now;chronosMono=performance.now();checkClock(now,chronosMono);cinemaDigits(now);updateCalendarDate(now);if(needsCalendarUpdate(now)&&lastUpdateDay!==dayKey(now)){lastUpdateDay=dayKey(now);void loadCalendarUpdates(true)}}clock();setInterval(clock,1000);
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"){clock();wakeCinema()}});
async function loadCalendarUpdates(refresh=false){if(updatePending)return;updatePending=true;try{const r=await fetch("/api/calendar"+(refresh?"/refresh":""),refresh?{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}:undefined);if(!r.ok)throw Error("API "+r.status);const data=await r.json();for(const rule of data.calendars??[]){if(!productionRules[rule.year]){productionRules[rule.year]={rest:rule.rest,short:rule.short,work:rule.work};timeGeometryCache.clear()}}calendarSource=data.status??"Локальные данные";text($("calendar-update-status"),calendarSource);renderCalendar()}catch{ text($("calendar-update-status"),"Обновление недоступно · сохранены локальные данные")}finally{updatePending=false}}
$("calendar-refresh").onclick=()=>void loadCalendarUpdates(true);void loadCalendarUpdates();

type ChatMessage={id:number|string;role:"user"|"system"|"assistant";content:string;created_at:string};
let chatBusy=false,chatReady=false,chatMessages:ChatMessage[]=[];
const chatInput=$<HTMLTextAreaElement>("chat-input"),chatSend=$<HTMLButtonElement>("chat-send");
function syncChat(){chatSend.disabled=chatBusy||!chatReady||!chatInput.value.trim()}
function renderChat(){const root=$("chat-log");root.replaceChildren();if(!chatMessages.length){const empty=document.createElement("div");empty.className="chat-empty";text(empty,"История сообщений пока пуста. /помощь — локальные команды.");root.append(empty)}for(const m of chatMessages){const item=document.createElement("article");item.className="chat-message "+m.role;const meta=document.createElement("div");meta.className="chat-meta";text(meta,(m.role==="user"?"Вы":m.role==="assistant"?"Amatsumireika":"Система")+" · "+new Date(m.created_at).toLocaleString("ru-RU"));const body=document.createElement("div");text(body,m.content);item.append(meta,body);if(m.role==="assistant"&&typeof m.id==="string"&&m.id.endsWith("-assistant")){const id=m.id.slice(0,-10);for(const helpful of [true,false]){const b=document.createElement("button");b.type="button";text(b,helpful?"Полезно":"Не помогло");b.onclick=async()=>{try{await jsonRequest("/api/cognitive/feedback",{job:id,helpful});text(b,"Учтено");b.disabled=true}catch(err){text($("chat-status"),String(err))}};item.append(b)}}root.append(item)}root.scrollTop=root.scrollHeight}
async function loadChat(){try{const r=await fetch("/api/chat");if(!r.ok)throw Error("API "+r.status);const result=await r.json();if(chatBusy)return;const changed=JSON.stringify(chatMessages)!==JSON.stringify(result.messages);chatMessages=result.messages;chatReady=true;if(changed)renderChat();text($("chat-mode"),result.model_connected?"Cloud.ru настроен · запросы по согласию":"Локальный чат · настройте Cloud.ru");if(changed||!$("chat-status").textContent)text($("chat-status"),"Локальное хранение · последние 200 сообщений")}catch{chatReady=false;text($("chat-status"),"История недоступна. Обновите страницу.")}syncChat()}
chatInput.oninput=syncChat;
async function sendChat(){if(chatBusy||!chatReady)return;const content=chatInput.value.trim();if(!content)return;if($<HTMLInputElement>("cloud-consent").checked&&!content.startsWith("/")){void sendCloudChat(content);return}chatBusy=true;syncChat();text($("chat-status"),"Сохранение…");$("stage").classList.add("core-working");text($("core-activity"),"Локальная обработка · SQLite");try{const r=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({content})});const result=await r.json();if(!r.ok)throw Error(result.error??"API "+r.status);chatMessages=result.messages;if(chatInput.value.trim()===content)chatInput.value="";renderChat();signalTime();text($("core-activity"),"Сообщение сохранено");text($("chat-status"),"Сохранено в SQLite · без облачного запроса")}catch(err){text($("core-activity"),"Ошибка локальной обработки");text($("chat-status"),"Не отправлено: "+String(err))}finally{$("stage").classList.remove("core-working");chatBusy=false;syncChat();chatInput.focus()}}
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
async function renderTimeSnapshots(save=false){try{const list=await jsonRequest("/api/time/snapshots",save?{day:daySelected,mode:timeShape}:undefined);const root=$("time-snapshots");root.replaceChildren();for(const item of list.slice(0,20)){const b=document.createElement("button");b.className="entry";text(b,item.day+" · "+item.nodes+" записей · "+item.edges+" связей");b.onclick=()=>historySelect(item.day);root.append(b)}}catch(err){text($("time-history-status"),String(err))}}

$("time-replay").onclick=()=>startTimePlayback("year");$("time-events-replay").onclick=()=>startTimePlayback("events");$("time-live").onclick=stopTimePlayback;
$("time-travel").onclick=()=>historySelect(daySelected);$("time-snapshot").onclick=()=>void renderTimeSnapshots(true);$("time-refresh").onclick=()=>{timeWindowKey="";void refreshTimeWindow();void renderTimeSnapshots()};
wheel.addEventListener("pointermove",e=>{const rect=wheel.getBoundingClientRect();timeCursor=timePointer(e.clientX,e.clientY,rect,detailMonth!==null);const hit=calendarHit(timeCursor.x,timeCursor.y,viewDates(displayedYear(chronosNow())),detailMonth!==null),tip=$("spiral-tooltip");
 if(!hit){tip.hidden=true;return}
 const d=hit.date;tip.hidden=false;text(tip,hit.month?d.toLocaleDateString("ru-RU",{month:"long",year:"numeric"}):d.toLocaleDateString("ru-RU",{day:"numeric",month:"long",year:"numeric",weekday:"long"})+" · неделя "+(monthWeek(d).index+1));
});wheel.addEventListener("pointerleave",()=>{timeCursor={x:0,y:0};$("spiral-tooltip").hidden=true});
timeOverlay=$<HTMLCanvasElement>("time-overlay");timeOverlayCtx=timeOverlay.getContext("2d");
try{const saved=JSON.parse(localStorage.getItem("chrono-cinema-v2")??"{}");if(["auto","cinema","quiet","off"].includes(saved.mode))cinemaMode=saved.mode;if(typeof saved.power==="number"&&Number.isFinite(saved.power))cinemaPower=cinemaClamp(saved.power,0,1)}catch{}
$<HTMLSelectElement>("cinema-mode").value=cinemaMode;$<HTMLInputElement>("cinema-power").value=String(cinemaPower*100);cinemaSettings();
$("cinema-mode").onchange=cinemaSettings;$("cinema-power").oninput=cinemaSettings;
$("chrono-save").onclick=async()=>{try{await jsonRequest("/api/settings",{cinemaMode,cinemaPower});text($("chrono-save-status"),"Сохранено в SQLite")}catch(err){text($("chrono-save-status"),"Не сохранено: "+String(err))}};
$("time-reverse").onclick=()=>startTimePlayback("year",true);
if(typeof IntersectionObserver!=="undefined"){new IntersectionObserver(entries=>{cinemaVisible=entries.some(e=>e.isIntersecting);if(cinemaVisible){drawYear();wakeCinema()}}).observe(wheel)}
setInterval(()=>{if(cinemaOnscreen())wakeCinema()},1000);
wakeCinema();
if(typeof motionPreference.addEventListener==="function")motionPreference.addEventListener("change",e=>{reduced=e.matches;drawYear();wakeCinema()});
timeDataReady=true;void refreshTimeWindow();void renderTimeSnapshots();
type WorkProfile={id:number;name:string;schedule:string;anchor:string;hours:number};
type WorkRow={profile_id:number;name:string;day:string;planned:number|null;override?:number|null;actual:number|null;status:string;difference:number|null};
type WorkReport={month:string;profiles:WorkProfile[];rows:WorkRow[];summary:{profile_id:number;name:string;planned:number;actual:number;difference:number;unknown:number;missing:number}[]};
let workReportData:WorkReport|null=null,workRequest=0,workBusy=false;
const workInput=(id:string)=>$<HTMLInputElement>(id),workSelect=(id:string)=>$<HTMLSelectElement>(id);
function workNumber(id:string){const v=workInput(id).value.trim();return v===""?null:Number(v)}
function renderWorkDay(){const p=Number(workSelect("work-person").value),d=workInput("work-day").value,r=workReportData?.rows.find(r=>r.profile_id===p&&r.day===d);workInput("work-planned").value=r?.override==null?"":String(r.override);workInput("work-planned").placeholder=r?.planned==null?"Не задан":("Авто: "+r.planned+" ч");workInput("work-actual").value=r?.actual==null?"":String(r.actual);workSelect("work-status").value=r?.status??"normal"}
function renderWork(report:WorkReport){workReportData=report;options(workSelect("work-person"),report.profiles.map(p=>({value:String(p.id),label:p.name+" · "+p.schedule})));const root=$("work-summary");root.replaceChildren();
 for(const p of report.summary.slice(0,200)){const row=document.createElement("div");row.className="work-person-row";const head=document.createElement("strong");text(head,p.name);const bar=document.createElement("div");bar.className="work-bar";const fill=document.createElement("i");fill.style.width=(p.planned?Math.min(100,p.actual/p.planned*100):0)+"%";bar.append(fill);const meta=document.createElement("small");text(meta,"План "+p.planned+" ч · факт "+p.actual+" ч · Δ "+p.difference+" ч · нет факта: "+p.missing+(p.unknown?" · не задан план: "+p.unknown:""));row.append(head,bar,meta);root.append(row)}
 if(!report.profiles.length)text(root,"Добавьте сотрудника");renderWorkDay();
 const tbody=$("work-table");tbody.replaceChildren();const id=Number(workSelect("work-person").value);const today=dayKey(new Date()),upcoming=report.rows.filter(x=>x.day>=today&&x.profile_id===id),remaining=upcoming.reduce((sum,x)=>sum+(x.planned??0),0);text($("work-forecast"),"Предстоящий план месяца: "+remaining+" ч"+(upcoming.some(x=>x.planned===null)?" · часть смен не задана":""));for(const r of report.rows.filter(x=>x.profile_id===id)){const row=document.createElement("button");row.className="work-day-row";text(row,r.day.slice(8)+" · "+(r.planned??"—")+" / "+(r.actual??"—")+" ч");row.onclick=()=>{workInput("work-day").value=r.day;renderWorkDay()};tbody.append(row)}
 const exportLink=$<HTMLAnchorElement>("work-export");exportLink.href="/api/work/export?month="+encodeURIComponent(report.month);exportLink.download="timesheet-"+report.month+".xlsx";
}
async function loadWork(){const m=workInput("work-month").value,req=++workRequest;if(!/^\d{4}-\d{2}$/.test(m))return;try{const report=await jsonRequest("/api/work/report?month="+encodeURIComponent(m));if(req!==workRequest)return;renderWork(report);text($("work-message"),"План — прогноз нагрузки; Δ не является юридическим расчётом сверхурочных.")}catch(err){if(req===workRequest)text($("work-message"),String(err))}}
async function workWrite(url:string,data:unknown){if(workBusy)return;workBusy=true;try{await jsonRequest(url,data);await loadWork()}catch(err){text($("work-message"),String(err))}finally{workBusy=false}}
workInput("work-month").value=daySelected.slice(0,7);workInput("work-day").value=daySelected;workInput("work-anchor").value=daySelected;
$("work-reload").onclick=()=>void loadWork();$("work-panel").addEventListener("toggle",()=>{if(($("work-panel") as HTMLDetailsElement).open)void loadWork()});
workInput("work-month").onchange=()=>{workInput("work-day").value=workInput("work-month").value+"-01";void loadWork()};workInput("work-day").onchange=()=>{if(workInput("work-day").value.slice(0,7)!==workInput("work-month").value){workInput("work-month").value=workInput("work-day").value.slice(0,7);void loadWork()}else renderWorkDay()};workSelect("work-person").onchange=()=>{if(workReportData)renderWork(workReportData)};
$<HTMLFormElement>("work-profile-form").onsubmit=e=>{e.preventDefault();void workWrite("/api/work/profiles",{name:workInput("work-name").value,schedule:workSelect("work-schedule").value,anchor:workInput("work-anchor").value,hours:workNumber("work-hours")})};
$<HTMLFormElement>("work-day-form").onsubmit=e=>{e.preventDefault();void workWrite("/api/work/day",{profile_id:Number(workSelect("work-person").value),day:workInput("work-day").value,planned:workNumber("work-planned"),actual:workNumber("work-actual"),status:workSelect("work-status").value})};
document.documentElement.setAttribute("data-app-ready","1");
fetch("/api/atlas").then(r=>{if(!r.ok)throw new Error("API "+r.status);return r.json()}).then(s=>{setState(s);if(timeDataReady){timeWindowKey="";void refreshTimeWindow()}}).catch(err=>{setState({nodes:[],edges:[],categories:state.categories});text($("status"),"API недоступен · демо");text($("message"),String(err))});

type CloudState={key_present:boolean;storage:string;model:string;models:string[];status:string;checked:string|null;requests:number;successes:number;failures:number;input_tokens:number;output_tokens:number;generation_requests:number;capabilities?:{id:string;kind:string;capabilities:string[];source:string}[];generation_enabled?:boolean};
let cloudState:CloudState|null=null,cloudBusy=false;
const cloudKey=$<HTMLInputElement>("cloud-key"),cloudModel=$<HTMLSelectElement>("cloud-model");
function renderCloud(v:CloudState){
 cloudState=v;
 const statuses:Record<string,string>={not_configured:"Ключ не задан",configured:"Ключ сохранён · не проверено",connected:"Последняя операция успешна",invalid_or_incomplete_response:"Некорректный ответ модели",unauthorized:"Ключ отклонён",rate_limited:"Лимит запросов",http_error:"Ошибка Cloud.ru",network_error:"Нет связи",invalid_response:"Некорректный ответ",key_locked:"Ключ недоступен на этом ПК"};
 text($("cloud-indicator"),statuses[v.status]??"Не проверено");$("cloud-indicator").setAttribute("data-connected",String(v.status==="connected"));
 text($("cloud-storage"),v.storage==="windows_dpapi"?"Защита Windows":v.storage==="session"?"Только текущий сеанс":v.storage==="locked"?"Введите ключ заново":"Ключ не сохранён");
 cloudKey.placeholder=v.key_present?"Ключ сохранён · введите новый для замены":"Введите API-ключ";
 cloudModel.replaceChildren();const placeholder=document.createElement("option");placeholder.value="";text(placeholder,"Выберите основную модель");cloudModel.append(placeholder);
 for(const model of v.models){const option=document.createElement("option");option.value=model;text(option,model);cloudModel.append(option)}cloudModel.value=v.model;const rates=$<HTMLSelectElement>("budget-model");const oldRate=rates.value;rates.replaceChildren();const empty=document.createElement("option");empty.value="";text(empty,"Выберите модель");rates.append(empty);for(const id of v.models){const opt=document.createElement("option");opt.value=id;text(opt,id);rates.append(opt)}rates.value=v.models.includes(oldRate)?oldRate:v.model;const cap=v.capabilities?.find(c=>c.id===v.model);text($("cloud-capability"),cap?cap.kind+" · "+(cap.capabilities.join(", ")||"Дополнительные возможности не подтверждены")+" · "+cap.source:"Выберите модель");
 for(const [id,value] of [["cloud-requests",v.requests],["cloud-successes",v.successes],["cloud-failures",v.failures],["cloud-input-tokens",v.input_tokens],["cloud-output-tokens",v.output_tokens],["cloud-generations",v.generation_requests]] as [string,number][]){text($(id),String(value))}
 text($("cloud-checked"),v.checked?"Последний запрос: "+new Date(v.checked).toLocaleString("ru-RU"):"Запросы каталога ещё не выполнялись");syncCloud();
}
function syncCloud(){$<HTMLButtonElement>("cloud-refresh").disabled=cloudBusy||!cloudState?.key_present;$<HTMLButtonElement>("cloud-save-key").disabled=cloudBusy;cloudModel.disabled=cloudBusy||!cloudState?.models.length||!cloudState.key_present;cloudKey.disabled=cloudBusy}
async function cloudAction(url:string,data?:unknown){if(cloudBusy)return;cloudBusy=true;syncCloud();text($("cloud-message"),"Загрузка…");try{const v=await jsonRequest(url,data);renderCloud(v);await loadBudget();text($("cloud-message"),data===undefined?"":url.endsWith("/models")?"Результат запроса указан в статусе.":"Настройки сохранены.")}catch(err){text($("cloud-message"),String(err));if(cloudState)renderCloud(cloudState)}finally{cloudBusy=false;syncCloud()}}
function closeProjectSettings(){if(!document.body.classList.contains("settings-open"))return;document.body.classList.remove("settings-open");$("project-settings-page").hidden=true;$("project-settings").setAttribute("aria-pressed","false");cloudKey.value="";resize();wakeCinema()}
$("project-settings").onclick=()=>{if(document.body.classList.contains("settings-open")){closeProjectSettings();return}document.body.classList.add("settings-open");$("project-settings-page").hidden=false;$("project-settings").setAttribute("aria-pressed","true");openSettingsTab("api");void cloudAction("/api/cloud/settings");void loadCloudHistory()};
$("settings-back").onclick=closeProjectSettings;
$("cloud-key-form").addEventListener("submit",e=>{e.preventDefault();const key=cloudKey.value.trim();cloudKey.value="";if(key)void cloudAction("/api/cloud/settings",{api_key:key})});
$("cloud-refresh").onclick=()=>void cloudAction("/api/cloud/models",{confirm:true});
cloudModel.onchange=()=>{if(cloudModel.value)void cloudAction("/api/cloud/settings",{model:cloudModel.value})};

type CloudJob={id:string;status:string;answer:string;error:string;tool_result:string;input_tokens:number|null;output_tokens:number|null;model:string};
async function loadCloudHistory(){try{const v=await jsonRequest("/api/cloud/history");const root=$("cloud-history");root.replaceChildren();for(const model of v.models){const p=document.createElement("p");text(p,model.model+" · "+model.requests+" запросов · "+model.input_tokens+"/"+model.output_tokens+" токенов · неизвестный расход: "+model.unknown_usage+" · "+(model.latency_ms??"—")+" мс");root.append(p)}for(const job of v.jobs){const p=document.createElement("p");text(p,new Date(job.created).toLocaleString("ru-RU")+" · "+job.model+" · "+job.status+" · "+(job.input_tokens??"?")+"/"+(job.output_tokens??"?")+" · "+(job.latency_ms??"—")+" мс");root.append(p)}}catch(err){text($("cloud-history"),String(err))}}
$("cloud-history-refresh").onclick=()=>void loadCloudHistory();
$("memory-search").onclick=async()=>{try{const v=await jsonRequest("/api/cloud/memory?q="+encodeURIComponent($<HTMLInputElement>("memory-query").value));const root=$("memory-results");root.replaceChildren();for(const item of v){const p=document.createElement("p");text(p,item.category+" · "+item.title);root.append(p)}if(!v.length)text(root,"Совпадений нет");const select=$<HTMLSelectElement>("embedding-node");select.replaceChildren();const blank=document.createElement("option");blank.value="";text(blank,"Выберите запись");select.append(blank);for(const item of v){const option=document.createElement("option");option.value=String(item.id);option.dataset.title=item.title;text(option,item.title);select.append(option)}}catch(err){text($("memory-results"),String(err))}};
async function sendCloudChat(content:string){
 if(chatBusy)return;const consent=$<HTMLInputElement>("cloud-consent");consent.checked=false;
 chatBusy=true;syncChat();$("stage").classList.add("core-working");text($("core-activity"),"Cloud.ru · очередь");text($("chat-mode"),"Cloud.ru · разовый запрос");
 const root=$("chat-log"),user=document.createElement("article"),reply=document.createElement("article");user.className="chat-message user";reply.className="chat-message system";text(user,content);text(reply,"Ожидание ответа…");root.append(user,reply);root.scrollTop=root.scrollHeight;
 const id=crypto.randomUUID(),mode=$<HTMLSelectElement>("cloud-chat-mode").value;
 try{let memory:unknown[]=[];const useMemory=$<HTMLInputElement>("cloud-memory");if(useMemory.checked){useMemory.checked=false;const preview=await jsonRequest("/api/cognitive/preview",{query:content.slice(0,300)});if(preview.memory.length&&window.confirm("Передать Cloud.ru следующие записи только в этом запросе?\n"+preview.memory.map((r:{id:number;title:string;category:string})=>r.category+": "+r.title).join("\n")))memory=preview.memory;else if(preview.memory.length){text($("chat-status"),"Отправка отменена");return}}let job:CloudJob=await jsonRequest("/api/cloud/generate",{id,content,mode,confirm:true,memory,memory_confirm:memory.length>0});if(chatInput.value.trim()===content)chatInput.value="";
 for(let i=0;i<500;i++){
  text(reply,job.answer+(job.tool_result?"\nЛокальный результат: "+job.tool_result:"")||"Ожидание ответа…");
  root.scrollTop=root.scrollHeight;text($("core-activity"),"Cloud.ru · "+job.status);text($("chat-status"),job.status==="running"?"Генерация…":job.status);
  if(!["queued","running"].includes(job.status)){if(job.status!=="done")text($("chat-status"),"Запрос не завершён: "+job.error+" · автоматического повтора нет");else text($("chat-status"),"Готово · токены "+(job.input_tokens??"?")+"/"+(job.output_tokens??"?"));signalTime();break}
  await new Promise(resolve=>setTimeout(resolve,400));job=await jsonRequest("/api/cloud/job?id="+encodeURIComponent(job.id));
 }
 }catch(err){text($("chat-status"),"Проверьте историю запросов перед повтором: "+String(err))}
 finally{chatBusy=false;syncChat();$("stage").classList.remove("core-working");text($("core-activity"),"Cloud.ru · запрос завершён или связь прервана");chatInput.focus();void loadCloudHistory();void loadChat();if(!$("project-settings-page").hidden)void cloudAction("/api/cloud/settings")}
}

async function loadBudget(){try{const v=await jsonRequest("/api/cloud/budget");$<HTMLInputElement>("budget-day").value=String(v.day);$<HTMLInputElement>("budget-month").value=String(v.month);const rate=v.rates.find((r:{model:string})=>r.model===$<HTMLSelectElement>("budget-model").value);$<HTMLInputElement>("budget-input").value=String(rate?.input??0);$<HTMLInputElement>("budget-output").value=String(rate?.output??0);text($("budget-status"),"Расчёт: "+v.day_used+" ₽ сегодня / "+v.month_used+" ₽ за месяц")}catch(err){text($("budget-status"),String(err))}}
$("budget-save").onclick=async()=>{try{const n=(id:string)=>Number($<HTMLInputElement>(id).value);await jsonRequest("/api/cloud/budget",{day:n("budget-day"),month:n("budget-month"),model:$<HTMLSelectElement>("budget-model").value,input:n("budget-input"),output:n("budget-output")});await loadBudget()}catch(err){text($("budget-status"),String(err))}};

$<HTMLSelectElement>("budget-model").onchange=()=>void loadBudget();
let embeddingBusy=false;
$("embedding-search").onclick=async()=>{
 if(embeddingBusy)return;
 const select=$<HTMLSelectElement>("embedding-node"),confirm=$<HTMLInputElement>("embedding-confirm"),query=$<HTMLInputElement>("memory-query").value.trim();
 if(!select.value||!query){text($("embedding-status"),"Выберите запись и введите запрос");return}
 const title=select.options[select.selectedIndex]?.dataset.title;
 const allowed=confirm.checked;confirm.checked=false;embeddingBusy=true;$<HTMLButtonElement>("embedding-search").disabled=true;
 try{const v=await jsonRequest("/api/cloud/embed-search",{query,node_id:Number(select.value),title,confirm:allowed});const root=$("memory-results");root.replaceChildren();for(const item of v.results){const p=document.createElement("p");text(p,item.category+" · "+item.title);root.append(p)}text($("embedding-status"),v.cache?"Локальный кеш, без облачного запроса":"Получены и сохранены эмбеддинги");void loadCloudHistory();void loadBudget()}
 catch(err){text($("embedding-status"),String(err))}
 finally{embeddingBusy=false;$<HTMLButtonElement>("embedding-search").disabled=false}
};

type CogData={revision?:number;rejected?:{id:number;title:string}[];state:{enabled:number;style:string;last_cycle:string|null;cycles:number;last_intent:string;last_error:string};persona:{identity:string;character:string;values:string[];limitations:string};counts:Record<string,number>;health:{nodes:number;edges:number;pending:number;foreign_key_issues:number};candidates:{id:number;kind:string;title:string;source:string;confidence:number;conflict:number}[];relations:{source:number;target:number;kind:string;source_title:string;target_title:string}[];skills:{name:string;attempts:number;successes:number;failures:number}[];goals:{title:string;state:string}[];events:{id:number;kind:string;detail:string;at:string;node_id:number|null}[]};
let cog:CogData|null=null,cogBusy=false,cogLoading=false,cogEvent=0,cogPulseAt=-10000,cogHighlights:number[]=[];
const cogLabels:Record<string,string>={fact:"Знания",episode:"События",procedure:"Навыки",preference:"Предпочтения",habit:"Привычки",cause:"Причины",goal:"Цели",document:"Документы",emotion:"Эмоции"};
function drawCognitiveSignals(){
 if(!cog)return;
 const elapsed=performance.now()-cogPulseAt;
 if(elapsed<3500){const ratio=Math.min(1,elapsed/3500),r=expanded?42+ratio*160:42+ratio*78;circle(0,0,reduced?65:r,colors[0]+(reduced?"88":Math.round((1-ratio)*170).toString(16).padStart(2,"0")))}
 for(const id of cogHighlights.slice(0,8)){const p=positions.get(id);if(p&&elapsed<3500){const tint=evoConflictIds.has(id)?"#dc7777":colors[0];line({x:0,y:0},p,tint+"99");circle(p.x,p.y,8,tint+"cc")}}
}
function openSettingsTab(tab:"api"|"cognitive"){$("settings-api-content").hidden=tab!=="api";$("settings-cognitive-content").hidden=tab!=="cognitive";$("settings-api-tab").classList.toggle("active",tab==="api");$("settings-cognitive-tab").classList.toggle("active",tab==="cognitive");if(tab==="cognitive")void loadCognitive(true)}
$("settings-api-tab").onclick=()=>openSettingsTab("api");$("settings-cognitive-tab").onclick=()=>openSettingsTab("cognitive");
$("cognitive-open").onclick=()=>{if(!$("project-settings-page").hidden){openSettingsTab("cognitive");return}$("project-settings").click();openSettingsTab("cognitive")};
function cogRows(id:string,items:string[]){const root=$(id);root.replaceChildren();for(const item of items){const p=document.createElement("p");text(p,item);root.append(p)}if(!items.length)text(root,"Нет данных")}
function cogButton(label:string,run:()=>void){const b=document.createElement("button");b.type="button";text(b,label);b.onclick=run;return b}
function renderCognitive(v:CogData,full:boolean){
 cog=v;const latest=v.events[0];if(latest&&latest.id>cogEvent){if(cogEvent>0){cogPulseAt=performance.now();cogHighlights=v.events.filter(e=>e.id>cogEvent&&e.node_id!==null).map(e=>e.node_id!)}cogEvent=latest.id}
 text($("cognitive-live"),"Память "+v.health.nodes+" · связи "+v.health.edges+" · кандидаты "+v.health.pending+" · "+(v.state.enabled?"локальный цикл "+v.state.cycles:"пауза"));
 text($("skill-count"),state.nodes.filter(n=>n.category==="Навыки").length+" записей · "+v.skills.reduce((n,k)=>n+k.attempts,0)+" операций");
 if(!full)return;
 text($("cog-persona"),v.persona.identity+" · "+v.persona.character);text($("cog-values"),v.persona.values.join(" · ")+" · "+v.persona.limitations);
 text($("cog-health"),"Циклы: "+v.state.cycles+" · нарушения связей: "+v.health.foreign_key_issues+" · "+(v.state.last_error||v.state.last_cycle||"Цикл ещё не выполнен"));
 $<HTMLInputElement>("cog-enabled").checked=!!v.state.enabled;$<HTMLSelectElement>("cog-style").value=v.state.style;
 cogRows("cog-counts",Object.keys(cogLabels).map(k=>cogLabels[k]+": "+(v.counts[k]??0)));
 const candidates=$("cog-candidates");candidates.replaceChildren();for(const c of v.candidates){const row=document.createElement("div");row.className="cog-review";const p=document.createElement("p");text(p,c.title+" · "+(cogLabels[c.kind]??c.kind)+" · источник "+c.source+" · эвристика "+Math.round(c.confidence*100)+"%"+(c.conflict?" · ПРОТИВОРЕЧИЕ":""));row.append(p,cogButton(c.conflict?"Сохранить оба утверждения":"Принять",()=>void cogAction("review",{id:c.id,action:"approve",confirm_conflict:!!c.conflict})),cogButton("Отклонить",()=>void cogAction("review",{id:c.id,action:"reject"})));candidates.append(row)}if(!v.candidates.length)text(candidates,"Кандидатов нет");
 const rejected=$("cog-rejected");rejected.replaceChildren();for(const c of v.rejected??[]){const p=document.createElement("p");text(p,c.title+" ");p.append(cogButton("Вернуть",()=>void cogAction("review",{id:c.id,action:"reopen"})));rejected.append(p)}
 const rel=$("cog-relations");rel.replaceChildren();for(const r of v.relations){const row=document.createElement("div");row.className="cog-review";const p=document.createElement("p");text(p,r.source_title+" ↔ "+r.target_title+" · "+r.kind);row.append(p,cogButton("Подтвердить",()=>void cogAction("relation",{...r,action:"approve"})),cogButton("Отклонить",()=>void cogAction("relation",{...r,action:"reject"})));rel.append(row)}if(!v.relations.length)text(rel,"Предложений нет");
 cogRows("cog-skills",v.skills.map(s=>s.name+" · "+s.successes+"/"+s.attempts+" успешных · ошибок "+s.failures));cogRows("cog-goals",v.goals.map(g=>g.title+" · "+(g.state==="done"?"выполнено":"предложение")));cogRows("cog-events",v.events.map(e=>new Date(e.at).toLocaleString("ru-RU")+" · "+e.detail));
}
let cogFullPending=false;
async function loadCognitive(full=false){if(cogBusy||cogLoading){if(full)cogFullPending=true;return}cogLoading=true;try{const v=await jsonRequest("/api/cognitive"+(full?"":"?light=1"));if(cogBusy)return;renderCognitive(v,full);if(v.revision!==state.revision){const next=await jsonRequest("/api/atlas");if(!cogBusy){setState(next);void loadEvents()}}}catch(err){if(full)text($("cog-message"),String(err));else text($("cognitive-live"),"Локальное ядро недоступно")}finally{cogLoading=false;if(cogFullPending&&!cogBusy){cogFullPending=false;void loadCognitive(true)}}}
async function cogAction(action:string,data:unknown){if(cogBusy)return;cogBusy=true;try{const result=await jsonRequest("/api/cognitive/"+action,data);if(action==="lookup"){cogRows("cog-results",result.results.map((r:{id:number;title:string;score:number})=>"#"+r.id+" · "+r.title+" · "+r.score));cogHighlights=result.results.map((r:{id:number})=>r.id);cogPulseAt=performance.now()}else if(action==="plan"){cogRows("cog-results",result.steps)}else{renderCognitive(result,true);if(["review","relation"].includes(action)){setState(await jsonRequest("/api/atlas"));signalTime()}}text($("cog-message"),"Готово · локальная обработка")}catch(err){text($("cog-message"),String(err))}finally{cogBusy=false;if(cogFullPending){cogFullPending=false;void loadCognitive(true)}}}
$("cog-cycle").onclick=()=>void cogAction("cycle",{});
$("cog-save").onclick=()=>void cogAction("settings",{enabled:$<HTMLInputElement>("cog-enabled").checked,style:$<HTMLSelectElement>("cog-style").value});
$("cog-cause-save").onclick=()=>void cogAction("relation",{source:Number($<HTMLInputElement>("cog-cause-source").value),target:Number($<HTMLInputElement>("cog-cause-target").value),kind:"cause",action:"approve"});
$("cog-lookup").onclick=()=>void cogAction("lookup",{query:$<HTMLInputElement>("cog-query").value});
$("cog-plan").onclick=()=>void cogAction("plan",{query:$<HTMLInputElement>("cog-query").value});
$("cog-refresh").onclick=()=>void loadCognitive(true);
void loadCognitive();setInterval(()=>{if(document.visibilityState!=="hidden"){void loadCognitive(false);if(!chatBusy)void loadChat()}},5000);

type EvoRecord={id:number;title:string;category:string;state?:string;freshness?:string;via?:number;score?:number};
let evoBusy=false,evoConflictIds=new Set<number>(),evoNext:number|null=0;
function evoFocus(id:number,ids:number[]=[id]){closeProjectSettings();focusNode(id);cogHighlights=ids;cogPulseAt=performance.now()}
async function evoRun(action:string,data?:unknown){if(evoBusy)return;evoBusy=true;try{
 const result=await jsonRequest("/api/evolution"+(action?"/"+action:""),data);
 if(!action){cogRows("evo-clusters",result.clusters.map((r:{category:string;folder:string;count:number})=>r.category+" / "+(r.folder||"Корень")+" · "+r.count));
 const root=$("evo-conflicts");root.replaceChildren();evoConflictIds=new Set<number>();for(const r of result.conflicts){evoConflictIds.add(r.source);evoConflictIds.add(r.target);const p=document.createElement("p");text(p,r.subject+": "+r.source_title+" ↔ "+r.target_title);p.append(cogButton("#"+r.source,()=>{ $<HTMLInputElement>("evo-id").value=String(r.source);evoFocus(r.source,[r.source,r.target])}),cogButton("#"+r.target,()=>{$<HTMLInputElement>("evo-id").value=String(r.target);evoFocus(r.target,[r.source,r.target])}));root.append(p)}if(!result.conflicts.length)text(root,"Нет выявленных структурированных конфликтов");
 cogRows("evo-versions",[...result.versions.map((r:{title:string;state:string;at:string})=>r.title+" · "+r.state+" · "+r.at.slice(0,10)),...result.due.map((r:{title:string})=>"Требует проверки: "+r.title)]);
 cogRows("evo-digests",result.digests.map((r:{title:string;source_ids:string})=>r.title+" · источники "+r.source_ids));cogRows("evo-journal",result.journal.map((r:{at:string;detail:string})=>r.at.slice(0,19)+" · "+r.detail));
 }else if(action==="explore"){cogRows("evo-route",result.stages.map((r:{name:string;count:number})=>r.name+" · "+r.count));const root=$("evo-results");root.replaceChildren();for(const [label,records] of [["Основные",result.seeds],["Связанные",result.linked],["Опыт",result.experience]] as [string,EvoRecord[]][]){const p=document.createElement("p");text(p,label+" · "+records.length);root.append(p);for(const r of records){const b=cogButton("#"+r.id+" "+r.title+" · "+(r.state??"")+" "+(r.freshness??""),()=>{$<HTMLInputElement>("evo-id").value=String(r.id)});root.append(b,cogButton("На карте",()=>evoFocus(r.id)))}}cogHighlights=result.seeds.map((r:EvoRecord)=>r.id);cogPulseAt=performance.now();
 }else if(action==="semantic"){cogRows("evo-results",result.pairs.length?result.pairs.map((r:{id:number;title:string;similarity:number})=>"#"+r.id+" "+r.title+" · сходство "+r.similarity):["Нет кандидатов: "+result.status]);}
 else if(action==="digest")cogRows("evo-results",[result.title,"Источники: "+result.source_ids.join(", ")]);
 text($("evo-message"),"Готово · без облачных запросов");
 }catch(err){text($("evo-message"),String(err))}finally{evoBusy=false}}
const evoId=()=>Number($<HTMLInputElement>("evo-id").value);
$("evo-refresh").onclick=()=>void evoRun("");
$("evo-panel").addEventListener("toggle",()=>{if($<HTMLDetailsElement>("evo-panel").open)void evoRun("")});
$("evo-explore").onclick=()=>void evoRun("explore",{query:$<HTMLInputElement>("evo-query").value});
$("evo-semantic").onclick=()=>void evoRun("semantic",{id:evoId()});
$("evo-fact").onclick=()=>void evoRun("fact",{id:evoId(),state:$<HTMLSelectElement>("evo-state").value});
$("evo-freshness").onclick=()=>void evoRun("freshness",{id:evoId(),days:Number($<HTMLInputElement>("evo-days").value)});
$("evo-digest").onclick=()=>void evoRun("digest",{ids:$<HTMLInputElement>("evo-ids").value.split(",").map(x=>Number(x.trim()))});

async function evoPage(after:number){try{const result=await jsonRequest("/api/evolution/page?after="+after+"&limit=100");evoNext=result.next;const root=$("evo-page-results");root.replaceChildren();for(const r of result.nodes as EvoRecord[])root.append(cogButton("#"+r.id+" "+r.title,()=>{$<HTMLInputElement>("evo-id").value=String(r.id)}));$<HTMLButtonElement>("evo-page-next").disabled=evoNext===null}catch(err){text($("evo-message"),String(err))}}
$("evo-page-first").onclick=()=>void evoPage(0);
$("evo-page-next").onclick=()=>{if(evoNext!==null)void evoPage(evoNext)};
$("evo-quality").onclick=async()=>{try{const v=await jsonRequest("/api/evolution/quality");cogRows("evo-quality-result",v.checks.map((r:{name:string;issues:number})=>r.name+": "+r.issues+" нарушений"))}catch(err){text($("evo-quality-result"),String(err))}};
