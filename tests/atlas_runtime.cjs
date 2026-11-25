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
  querySelector(){return new Element()}
  getBoundingClientRect(){return this.id==='right'?{left:830,top:0,width:278,height:1020}:{left:0,top:0,width:1108,height:1020}}
  getContext(){return new Proxy({}, {get:(o,k)=>o[k]??(()=>{}),set:(o,k,v)=>{o[k]=v;return true}})}
  focus(){}
}
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
assert.equal(elapsedDays(2026,new Date(2026,11,31,12)),365);
assert.equal(elapsedDays(2027,new Date(2027,0,1,0)),1);
lastDay="2026-12-31";autoYear=false;calendarYear=2026;daySelected=lastDay;updateCalendarDate(new Date(2027,0,1,0));assert.equal(displayedYear(new Date(2027,0,1,0)),2027);assert.equal(daySelected,"2027-01-01");assert.equal(autoYear,true);
console.log("Production calendar 2026/2027 and midnight rollover: OK");
console.log("Atlas runtime geometry: 100000 records, 250 folders, 6 modes; OK");
`,ctx,{timeout:30000});
