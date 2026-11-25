// Dependency-free model/runtime smoke test; this is not a browser or FPS benchmark.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {performance} = require('node:perf_hooks');
class Element {
  constructor(id='') {
    this.id=id; this.children=[]; this.value=''; this.hidden=false; this.open=true;
    const classes=new Set();
    this.classList={add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x),toggle:(x,v)=>{const next=v??!classes.has(x);if(next)classes.add(x);else classes.delete(x);return next}};
    this.style={setProperty(){}};
    this.min='0';this.max='5';
  }
  append(...children){this.children.push(...children)}
  replaceChildren(...children){this.children=children}
  addEventListener(){}
  setAttribute(){}
  removeAttribute(){}
  querySelector(){return new Element()}
  getBoundingClientRect(){return this.id==='right'?{left:830,top:0,width:278,height:1020}:{left:0,top:0,width:1108,height:1020}}
  getContext(){return new Proxy({}, {get:(o,k)=>o[k]??((k==="createRadialGradient"||k==="createLinearGradient")?(()=>({addColorStop(){}})):(()=>{})),set:(o,k,v)=>{o[k]=v;return true}})}
  focus(){}
}
const html=fs.readFileSync("index.html","utf8");const home=html.slice(html.indexOf('<aside id="left"'),html.indexOf('<section id="stage"'));for(const unwanted of ["today","month-today","selected-date","calendar-date-label","month-expand","time-shape","year-2026","year-auto","year-2027","day-events","calendar-refresh","time-history-status","cinema-mode","work-panel"])assert.ok(!home.includes('id="'+unwanted+'"'),"Removed from home: "+unwanted);
const els=new Map();
const document={getElementById:id=>{if(!els.has(id))els.set(id,new Element(id));return els.get(id)},createElement:()=>new Element(),createTextNode:s=>s,querySelectorAll:()=>[],addEventListener(){},documentElement:new Element(),body:new Element()};
const ctx=vm.createContext({document,innerWidth:1108,devicePixelRatio:1,performance,matchMedia:()=>({matches:true}),ResizeObserver:class {observe(){}},requestAnimationFrame(){},setInterval(){},fetch:()=>new Promise(()=>{}),assert,console});
const app=fs.readFileSync('dist/app.js','utf8').replace(/^export\s*\{\s*\};?\s*$/m,'');
vm.runInContext(app+`
const records=Array.from({length:100000},(_,i)=>({id:i+1,title:"Record "+i,category:state.categories[i%9],folder:"Root/"+(i%250)}));
setState({nodes:records,edges:[{source:1,target:2}],categories:state.categories});
expanded=true;grouping="folder";mode="hex";geometryKey="";rebuild();
assert.equal(groupNames.length,250,"No nine-group aggregation");
assert.equal(new Set(centers.map(p=>p.x+":"+p.y)).size,250,"Distinct hex cells");
assert.ok(visible.length<=6000,"Adaptive point budget");
assert.equal(groupCounts.reduce((a,b)=>a+b,0),100000,"No records lost");
for(const modeName of ["radial","clusters","hex","tile","force","hud"]){
 mode=modeName;rebuild();
 assert.equal(centers.length,250);
 assert.ok(centers.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)));
 assert.ok(visible.length<=6000);
}
folderPrefix="Root";rebuild();assert.equal(groupNames.length,250);
folderPrefix="";grouping="category";mode="radial";rebuild();assert.equal(groupNames.length,9);
focusNode(100000);assert.ok(targets.has(100000),"Selected record outside initial sample remains accessible");
assert.equal(cameraTarget.zoom,3);
assert.ok(Number.isFinite(cameraTarget.pan.x));
for(const y of [2026,2027]){const stats=productionStats(yearDates(y));assert.equal(stats.work,247);assert.equal(stats.rest,118);assert.equal(stats.short,4);assert.equal(stats.h40,1972);assert.equal(stats.h36,1774.4);assert.equal(stats.h24,1181.6)}
assert.equal(productionDay(new Date(2026,0,9,12)),"transfer");
assert.equal(productionDay(new Date(2027,1,20,12)),"short");
assert.equal(productionDay(new Date(2027,1,22,12)),"transfer");
assert.equal(productionDay(new Date(2027,10,5,12)),"transfer");
assert.equal(productionDay(new Date(2028,0,1,12)),null);
assert.equal(monthDayKind(new Date(2026,0,9,12)),"transfer");assert.equal(monthDayKind(new Date(2027,1,20,12)),"short");assert.equal(monthDayKind(new Date(2026,10,4,12)),"holiday");assert.equal(monthDayKind(new Date(2026,10,7,12)),"weekend");assert.equal(monthDayKind(new Date(2028,0,1,12)),"holiday");
assert.equal(elapsedDays(2026,new Date(2026,11,31,12)),365);
assert.equal(elapsedDays(2027,new Date(2027,0,1,0)),1);
lastDay="2026-12-31";autoYear=false;calendarYear=2026;daySelected=lastDay;updateCalendarDate(new Date(2027,0,1,0));assert.equal(displayedYear(new Date(2027,0,1,0)),2027);assert.equal(daySelected,"2027-01-01");assert.equal(autoYear,true);
assert.equal(needsCalendarUpdate(new Date(2026,10,25)),false);
assert.equal(needsCalendarUpdate(new Date(2027,8,1)),true);
assert.equal(elapsedProduction(2027,new Date(2027,0,1)).remaining,247);
assert.equal(elapsedProduction(2026,new Date(2027,0,1)).doneHours,1972);
assert.equal(elapsedProduction(2026,new Date(2027,0,1)).remaining,0);
chooseCalendarYear(2027,new Date(2027,1,20,12));openCalendarMonth(1,new Date(2027,1,20,12));assert.equal(viewDates(2027).length,28);closeCalendarMonth(new Date(2027,1,20,12));assert.equal(viewDates(2027).length,365);
assert.ok(calendarRayLength(new Date(2027,11,31))>calendarRayLength(new Date(2027,0,1)));
assert.equal(eased(0),0);assert.equal(eased(1),1);
lastWall=10000;lastMono=1000;checkClock(new Date(1000),2000);assert.ok(clockNotice.length>0);
const spiral=timeGeometry(2027,null);
assert.equal(spiral.length,365);assert.equal(timeGeometry(2027,1).length,28);assert.equal(timeGeometry(2028,null).length,366);
for(const [i,v] of spiral.entries()){assert.ok(Number.isFinite(v.q.x)&&Number.isFinite(v.q.y));assert.equal(spiralIndex(v.q.x-160,v.q.y-160,spiral.length),i)}
assert.ok(Math.hypot(spiral[364].q.x-160,spiral[364].q.y-160)>Math.hypot(spiral[0].q.x-160,spiral[0].q.y-160));
assert.ok(timeGeometryCache.size<=32);assert.equal(timeShape,"spiral");
assert.deepEqual(Array.from({length:12},(_,i)=>seasonOf(i)),["winter","winter","spring","spring","spring","summer","summer","summer","autumn","autumn","autumn","winter"]);assert.equal(seasonPaint(0,true),"#f1f5fa");assert.equal(seasonPaint(6,true),"#68d79a");assert.equal(seasonalRayColor(new Date(2027,6,15),true),seasonPaint(6,true));assert.notEqual(seasonalRayColor(new Date(2027,5,1),true),seasonPaint(5,true));assert.notEqual(seasonalRayColor(new Date(2027,4,31),true),seasonPaint(4,true));assert.notEqual(seasonPaint(0,true),seasonPaint(0,false));
assert.equal(isoWeek(new Date(2027,0,1)),53);assert.equal(isoWeek(new Date(2027,0,4)),1);assert.equal(isoWeek(new Date(2028,11,31)),52);
assert.ok(spiral.every(v=>Math.hypot(v.q.x-160,v.q.y-160)<=139.01));
assert.equal(new Set(spiral.map(v=>dayKey(v.d))).size,365);assert.equal(new Set(timeGeometry(2028,null).map(v=>dayKey(v.d))).size,366);
assert.equal(monthCells(2026,10).length,42);assert.equal(monthCells(2026,10).findIndex(Boolean),6);assert.equal(monthCells(2028,1).filter(Boolean).length,29);
assert.ok(calendarRayLength(new Date(2027,11,31))-calendarRayLength(new Date(2027,8,30))>calendarRayLength(new Date(2027,2,31))-calendarRayLength(new Date(2027,0,1)));
for(let m=0;m<12;m++){const dates=yearDates(2027).filter(d=>d.getMonth()===m);assert.ok(dates.every((d,i)=>!i||calendarRayLength(d)>=calendarRayLength(dates[i-1])));if(m)assert.ok(calendarRayLength(dates[0])>calendarRayLength(new Date(2027,m,0)));assert.ok(monthWeek(dates[0]).count>=4&&monthWeek(dates[0]).count<=6)}
assert.equal(monthWeek(new Date(2026,10,1)).count,6);
assert.equal(calendarRayLength(new Date(2027,0,4)),calendarRayLength(new Date(2027,0,10)));
for(const v of spiral){const hit=calendarHit(v.q.x-160,v.q.y-160,spiral.map(v=>v.d),false);assert.equal(dayKey(hit.date),dayKey(v.d));assert.equal(hit.month,false)}
assert.equal(calendarHit(0,0,spiral.map(v=>v.d),false),null);
for(const y of [2026,2027,2028,2100]){
 const dates=yearDates(y),labels=Array.from({length:12},(_,m)=>monthLabelLayout(y,m));
 for(const [m,l] of labels.entries()){
  assert.ok(l.width>=30,"full month label width: "+l.label+" "+l.width);
  assert.ok(l.radius>spiralInner+calendarRayLength(new Date(y,m+1,0,12)));
  for(const along of [l.radius,l.radius+l.width])for(const across of [-7,7]){
   assert.ok(Math.abs(along*l.ux-across*l.uy)<=annualTimeSide/2-3.9);
   assert.ok(Math.abs(along*l.uy+across*l.ux)<=annualTimeSide/2-3.9);
  }
  const hit=calendarHit((l.radius+l.width/2)*l.ux,(l.radius+l.width/2)*l.uy,dates,false);
  assert.equal(hit.month,true);assert.equal(hit.date.getMonth(),m);
 }
}
assert.equal(fullMonthNames[11],"Декабрь");assert.equal(fullMonthNames[8],"Сентябрь");
assert.equal(timePointer(192,116,{left:0,top:0,width:384,height:384},false).y,-76);
assert.equal(timePointer(160,84,{left:0,top:0,width:320,height:320},true).y,-76);
selectMonthDate(new Date(2027,0,31,12),new Date(2027,0,1));moveMonth(1,new Date(2027,0,1));assert.equal(daySelected,"2027-02-28");moveMonth(-2,new Date(2027,0,1));assert.equal(daySelected,"2026-12-28");
assert.equal(cinemaBudget("auto",2,2,false).fps,15);
assert.equal(cinemaBudget("cinema",12,2,false).fps,60);
assert.equal(cinemaBudget("off",12,2,false).count,0);
assert.equal(cinemaBudget("cinema",12,2,true).count,0);
assert.equal(cinemaBudget("cinema",12,0,false).fps,15);
const spark={x:10,y:20,vx:12,vy:0,life:1,max:1,size:1,hue:0};
assert.ok(stepCinemaParticle(spark,.05,{x:160,y:160}));
assert.ok(Number.isFinite(spark.x)&&Number.isFinite(spark.y));
assert.ok(spark.life<1);
assert.equal(cinemaClamp(100,0,1),1);
assert.match(cinemaColor(8),/^#[0-9a-f]{6}$/i);
const lp=cinemaLens({x:180,y:160},{x:0,y:0},.16);assert.ok(lp.x>180&&lp.y===160);
expanded=false;presentation=false;chooseCalendarYear(2027,new Date(2027,1,20,12));cinemaMode="cinema";cinemaPower=.72;
cinemaDraw(wheelCtx,performance.now(),new Date(2027,1,20,12),.016,cinemaBudget("cinema",12,2,false));
assert.ok(cinemaSprites.size<=16);
assert.ok(cinemaSparks.length<=180);
assert.equal(cinemaOnscreen(),true);expanded=true;assert.equal(cinemaOnscreen(),false);
startTimePlayback("year",true);assert.equal(playbackDays[0],"2027-12-31");stopTimePlayback();assert.equal(playbackRunning,false);
console.log("Cinematic budgets, draw smoke, reduced motion, particle physics and color interpolation: OK");
console.log("Production calendar 2026/2027, month drilldown, norms and midnight rollover: OK");
console.log("Atlas runtime geometry: 100000 records, 250 folders, 6 modes; OK");
`,ctx,{timeout:30000});
