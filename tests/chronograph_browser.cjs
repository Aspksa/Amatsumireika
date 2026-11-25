// Real Chromium smoke test; no npm/browser-driver dependency.
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {spawn}=require("node:child_process");
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=20000){const end=Date.now()+ms;let last;while(Date.now()<end){try{const v=await fn();if(v)return v}catch(e){last=e}await delay(100)}throw Error(label+(last?": "+last.message:""))}
async function main(){
 const chrome=[process.env.CHROME_PATH,process.env.CHROME_BIN,"/usr/bin/google-chrome","/usr/bin/google-chrome-stable","/usr/bin/chromium","/usr/bin/chromium-browser"].find(p=>p&&fs.existsSync(p));
 assert.ok(chrome,"Chromium/Chrome executable required");
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"chrono-browser-"));
 let server,browser,ws;let serverOutput="",browserOutput="";
 try{
  server=spawn(process.env.PYTHON||"python",["-u","server.py","--port","0"],{stdio:["ignore","pipe","pipe"]});
  server.stdout.on("data",b=>serverOutput+=b);server.stderr.on("data",b=>serverOutput+=b);
  const url=await until(()=>serverOutput.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0],"server startup");
  browser=spawn(chrome,["--headless=new","--no-sandbox","--disable-dev-shm-usage","--remote-debugging-port=0","--user-data-dir="+dir,"--window-size=1440,900","about:blank"],{stdio:["ignore","ignore","pipe"]});
  browser.stderr.on("data",b=>browserOutput+=b);
  const port=await until(()=>fs.readFileSync(path.join(dir,"DevToolsActivePort"),"utf8").split("\n")[0],"Chrome startup");
  const target=await until(async()=>{const tabs=await (await fetch("http://127.0.0.1:"+port+"/json/list")).json();return tabs.find(t=>t.type==="page")?.webSocketDebuggerUrl},"DevTools page");
  ws=new WebSocket(target);await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true})});
  let id=0;const pending=new Map(),errors=[];
  ws.addEventListener("message",event=>{const m=JSON.parse(event.data);if(m.id&&pending.has(m.id)){const [ok,fail]=pending.get(m.id);pending.delete(m.id);m.error?fail(Error(m.error.message)):ok(m.result)}else if(m.method==="Runtime.exceptionThrown")errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text)});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,[resolve,reject]);ws.send(JSON.stringify({id:n,method,params}))});
  async function evaluate(expression){const r=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
  await send("Runtime.enable");await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await send("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"no-preference"}]});
  await send("Page.navigate",{url});
  await until(()=>evaluate('Boolean(document.querySelector("#time-overlay")?.getAttribute("data-frame"))'),"animation starts");
  const sample=()=>evaluate(`(()=>{const el=document.querySelector("#time-overlay"),c=el.getContext("2d"),d=c.getImageData(0,0,el.width,el.height).data;let hash=2166136261,lit=0;for(let i=0;i<d.length;i+=4){if(d[i+3]>35){lit++;hash=Math.imul(hash^d[i]^d[i+1]<<8^d[i+2]<<16^d[i+3]<<24,16777619)}}const w=el.getBoundingClientRect(),p=document.querySelector("#left").getBoundingClientRect(),clock=document.querySelector("#clock").getBoundingClientRect();return {frame:Number(el.getAttribute("data-frame")),hash,lit,width:w.width,height:w.height,top:w.top-p.top,clockCenter:Math.abs(clock.left+clock.width/2-w.left-w.width/2),clockText:document.querySelector("#clock").textContent,year:document.querySelector("#month-grid .is-selected").dataset.date.slice(0,4),localYear:String(new Date().getFullYear()),homeDetails:document.querySelectorAll("#left details").length,yearButtons:document.querySelectorAll("#year-2026,#year-auto,#year-2027").length}})()`);
  await evaluate(`Promise.all([["Inter","Интерфейс"],["Manrope","123456"],["Source Serif 4","Личность"],["Cormorant Garamond","Amatsumireika"],["JetBrains Mono","Данные"]].map(([f,t])=>document.fonts.load(\x2716px "\x27+f+\x27"\x27,t)))`);
  assert.equal(await evaluate(`Array.from(document.fonts).filter(f=>f.status==="loaded").length`),5);
  assert.equal(await evaluate(`document.querySelectorAll("#clock .clock-seconds").length`),3);
  assert.ok(await evaluate(`parseFloat(getComputedStyle(document.querySelector("#clock .clock-seconds")).fontSize)<parseFloat(getComputedStyle(document.querySelector("#clock")).fontSize)`));
  const a=await sample();await delay(1250);const b=await sample();
  assert.ok(a.width>100&&Math.abs(a.width-a.height)<2,"square visible canvas "+JSON.stringify(a));
  assert.ok(a.top>=0&&a.top<25,"wheel top-aligned "+a.top);
  assert.ok(a.clockCenter<3,"clock horizontally centered");
  assert.equal(await evaluate('document.querySelector("#time-shape")===null'),true);
  assert.equal(await evaluate('document.querySelector(".chrono-clock").children.length'),1);
  assert.equal(await evaluate('document.querySelector(".chrono-clock").firstElementChild.id'),"clock");
  assert.equal(await evaluate('document.querySelector(".chrono-stats")===null'),true);
  assert.equal(await evaluate('document.querySelector("#month-grid").children.length'),42);
  assert.ok(await evaluate(`getComputedStyle(document.querySelector("#month-heading")).getPropertyValue("--season-dark").trim().startsWith("#")`));
  assert.equal(await evaluate('document.querySelector(".chrono-select,.month-footer,#month-today,#selected-date,#calendar-date-label,#month-expand")===null'),true);
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".month-calendar")).borderTopWidth'),"0px");
  const reset=()=>evaluate('document.querySelector("#month-grid").dispatchEvent(new KeyboardEvent("keydown",{key:"Home",bubbles:true}))');
  await reset();
  await evaluate('(()=>{for(let i=0;i<Math.abs((new Date().getFullYear()-2026)*12+new Date().getMonth()-10);i++)document.querySelector(new Date().getFullYear()*12+new Date().getMonth()>2026*12+10?"#month-prev":"#month-next").click()})()');
  assert.equal(await evaluate('document.querySelector("[data-date=\\"2026-11-04\\"]").classList.contains("kind-holiday")'),true);
  assert.equal(await evaluate('document.querySelector("[data-date=\\"2026-11-07\\"]").classList.contains("kind-weekend")'),true);
  assert.equal(await evaluate('getComputedStyle(document.querySelector("[data-date=\\"2026-11-07\\"]")).color'),"rgb(228, 184, 94)");
  await reset();
  await evaluate('document.querySelector("#month-heading").click()');
  assert.equal(await evaluate('document.querySelector("#month-heading").getAttribute("aria-pressed")'),"true");
  await evaluate('document.querySelector("#month-heading").click()');
  assert.equal(await evaluate('document.querySelector("#month-heading").getAttribute("aria-pressed")'),"false");
  assert.equal(await evaluate('document.querySelectorAll("#month-grid .is-today").length'),1);
  const oldHeading=await evaluate('document.querySelector("#month-heading").textContent');
  await evaluate('document.querySelector("#month-next").click()');
  assert.notEqual(await evaluate('document.querySelector("#month-heading").textContent'),oldHeading);
  await reset();
  assert.equal(await evaluate('document.querySelector("#month-heading").textContent'),oldHeading);
  assert.equal(await evaluate('document.querySelectorAll("#month-grid .is-selected.is-today").length'),1);
  assert.equal(a.homeDetails,0);assert.equal(a.yearButtons,0);assert.equal(a.year,a.localYear);
  assert.ok(a.lit>80&&b.lit>80,"visible non-transparent pixels");
  assert.ok(b.frame>a.frame+3&&a.hash!==b.hash,"Canvas actually changes");
  assert.notEqual(a.clockText,b.clockText,"clock ticks");
  assert.deepEqual(errors,[],"no uncaught page exceptions");
  await evaluate('document.querySelector("#atlas").click()');await delay(400);const paused=await evaluate('Number(document.querySelector("#time-overlay").getAttribute("data-frame"))');await delay(350);assert.equal(await evaluate('Number(document.querySelector("#time-overlay").getAttribute("data-frame"))'),paused,"atlas pauses hidden calendar");
  await evaluate('document.querySelector("#home").click()');await until(async()=>await evaluate('Number(document.querySelector("#time-overlay").getAttribute("data-frame"))')>paused,"home restarts animation");
  assert.deepEqual(errors,[]);
  assert.equal(await evaluate('document.documentElement.getAttribute("data-app-ready")'),"1");
  await evaluate('document.querySelector("#atlas").click()');await delay(200);await evaluate('Array.from(document.querySelectorAll(".swatch")).find(b=>b.textContent.includes("Бумага")).click()');await evaluate('document.querySelector("#home").click()');await delay(350);
  assert.equal(await evaluate('document.documentElement.classList.contains("paper")'),true);
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#clock")).color'),"rgb(128, 85, 15)");
  await send("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});await delay(1100);assert.ok((await sample()).lit>80,"reduced motion still renders time rings");assert.deepEqual(errors,[]);
  console.log("Real Chrome: square "+a.width+"x"+a.height+", "+a.lit+" visible pixels, frames "+a.frame+" → "+b.frame+", clock ticks, hide/resume, no uncaught errors.");
 }catch(e){console.error(serverOutput.slice(-2500));console.error(browserOutput.slice(-2500));throw e}
 finally{try{ws?.close()}catch{}browser?.kill();server?.kill();await delay(300);try{fs.rmSync(dir,{recursive:true,force:true})}catch{}}
}
main().catch(e=>{console.error(e);process.exitCode=1});
