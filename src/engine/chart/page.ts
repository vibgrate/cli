/** Self-contained map page served by `vg show arch`. No CDN, no build step. */
export function chartPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Code map</title>
<style>
:root {
  --bg:#0b0f0c; --s0:#0e1510; --s1:#141c16; --s2:#1b241d;
  --line:#2a362c; --t:#e8f0e9; --tm:#9aab9e; --tl:#6b7a6e;
  --green:#22c55e; --cyan:#38bdf8; --amber:#fbbf24; --orange:#fb923c; --rose:#fb7185;
  --panel:340px; --safe:env(safe-area-inset-bottom,0px);
  --sans:"IBM Plex Sans","Segoe UI",system-ui,sans-serif;
}
[data-theme="light"] {
  --bg:#f4f1ea; --s0:#efece4; --s1:#fffdf8; --s2:#fff;
  --line:#d9d3c6; --t:#1c241d; --tm:#5d675f; --tl:#7e877f;
}
* { box-sizing:border-box; }
html,body { margin:0; height:100%; background:var(--bg); color:var(--t); font-family:var(--sans); }
body { display:flex; flex-direction:column; min-height:100dvh; overflow:hidden; }
button,input { font:inherit; color:inherit; }
button { cursor:pointer; }
a { color:var(--cyan); text-decoration:none; }
header {
  display:flex; flex-wrap:wrap; gap:8px; align-items:center;
  padding:8px 12px; border-bottom:1px solid var(--line); background:var(--s1);
}
.mark { width:10px; height:10px; border-radius:3px; background:var(--green); }
.brand { font-weight:650; font-size:14px; }
.brand small { color:var(--tm); font-weight:500; margin-left:6px; }
.search {
  flex:1 1 160px; min-width:140px; max-width:280px; height:36px;
  border:1px solid var(--line); background:var(--bg); border-radius:8px; padding:0 10px;
}
.tools { display:flex; flex-wrap:wrap; gap:6px; }
.tools button, .seg button {
  height:34px; padding:0 10px; border-radius:8px; border:1px solid var(--line);
  background:var(--s2); color:var(--tm); font-size:13px;
}
.tools button[aria-pressed="true"], .seg button[aria-pressed="true"] {
  color:var(--t); border-color:color-mix(in srgb,var(--green) 50%, var(--line));
  background:color-mix(in srgb,var(--green) 12%, var(--s2));
}
.seg { display:flex; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
.seg button { border:0; border-radius:0; background:transparent; }
.seg button + button { border-left:1px solid var(--line); }
.note { padding:8px 12px; font-size:13px; color:var(--tm); border-bottom:1px solid var(--line); background:var(--s0); }
.note b { color:var(--t); }
.work { flex:1; display:grid; grid-template-columns:1fr var(--panel); grid-template-rows:minmax(0,1fr); min-height:0; }
.work.closed { grid-template-columns:1fr 0; }
.stage { position:relative; min-height:0; height:100%; overflow:hidden; }
.canvas {
  height:100%; min-height:0; overflow:auto; overscroll-behavior:contain;
  -webkit-overflow-scrolling:touch; cursor:grab; user-select:none;
  background: linear-gradient(var(--line) 1px,transparent 1px), linear-gradient(90deg,var(--line) 1px,transparent 1px);
  background-size:32px 32px; background-attachment:local;
}
.canvas.panning, .canvas.panning .node { cursor:grabbing; }
svg { display:block; }
.col { fill:var(--tl); font:600 10px var(--sans); letter-spacing:.12em; }
.node { cursor:pointer; }
.node.dim { opacity:.16; }
.node .name { font:650 13px var(--sans); fill:var(--t); }
.node .meta { font:11px var(--sans); fill:var(--tm); }
.edge { fill:none; stroke-width:1.4; opacity:.7; }
.edge.call { stroke:var(--orange); }
.edge.references { stroke:var(--cyan); stroke-dasharray:5 4; }
.edge.contains { stroke:#94a3b8; stroke-dasharray:2 3; opacity:.3; }
.edge.dim { opacity:.08; }
.edge.hot { opacity:1; stroke-width:2.2; }
.hint { position:absolute; left:12px; bottom:12px; max-width:min(320px,calc(100% - 24px));
  background:color-mix(in srgb,var(--s1) 92%,transparent); border:1px solid var(--line);
  border-radius:10px; padding:10px 12px; font-size:12px; color:var(--tm); pointer-events:none; z-index:2; }
.zoom {
  position:absolute; right:12px; top:12px; display:flex; z-index:2;
  border:1px solid var(--line); border-radius:8px; overflow:hidden; background:var(--s1);
}
.zoom button {
  height:32px; min-width:36px; padding:0 8px; border:0; border-radius:0;
  background:transparent; color:var(--t); font-size:16px; line-height:1;
}
.zoom button + button { border-left:1px solid var(--line); }
#zoom-fit { min-width:52px; font-size:12px; color:var(--tm); }
.fab { display:none; position:absolute; right:12px; bottom:12px; height:40px; padding:0 14px;
  border-radius:999px; border:1px solid var(--line); background:var(--s1); z-index:2; }
.drawer { background:var(--s1); border-left:1px solid var(--line); overflow:auto; min-height:0; }
.dh { display:flex; align-items:center; gap:8px; padding:12px 14px; position:sticky; top:0;
  background:var(--s1); border-bottom:1px solid var(--line); }
.dh h2 { margin:0; font-size:16px; flex:1; }
.icon { width:34px; height:34px; border-radius:8px; border:1px solid var(--line); background:transparent; color:var(--tm); }
.db { padding:12px 14px 28px; }
.lead { font-size:15px; line-height:1.45; margin:0 0 12px; }
.chips { display:flex; flex-wrap:wrap; gap:6px; margin:0 0 14px; }
.chip { font-size:12px; padding:4px 8px; border-radius:999px; border:1px solid var(--line); background:var(--s2); }
.lbl { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--tl); margin:14px 0 6px; }
.place,.empty { font-size:13px; color:var(--tm); }
.list { list-style:none; margin:0; padding:0; }
.list li { display:flex; gap:8px; padding:6px 0; border-bottom:1px solid var(--line); font-size:14px; }
.verb { color:var(--tl); font-size:12px; min-width:56px; }
.warn,.break { margin-top:14px; padding:12px; border-radius:10px; }
.warn { border:1px solid color-mix(in srgb,var(--amber) 45%,var(--line)); background:color-mix(in srgb,var(--amber) 8%,transparent); }
.break { border:1px solid color-mix(in srgb,var(--rose) 45%,var(--line)); background:color-mix(in srgb,var(--rose) 8%,transparent); }
.warn h3,.break h3 { margin:0 0 6px; font-size:14px; }
details { margin-top:16px; border-top:1px solid var(--line); padding-top:10px; color:var(--tm); font-size:13px; }
footer { padding:6px 12px calc(6px + var(--safe)); border-top:1px solid var(--line); color:var(--tl); font-size:12px; display:flex; gap:12px; flex-wrap:wrap; }
@media (max-width:860px) {
  .work { grid-template-columns:1fr; grid-template-rows:minmax(0,1fr) auto; }
  .work.closed { grid-template-columns:1fr; }
  .drawer { border-left:0; border-top:1px solid var(--line); max-height:48dvh; border-radius:16px 16px 0 0; }
  .work.closed .drawer { display:none; }
  .fab { display:inline-flex; align-items:center; }
  .hint { bottom:60px; }
  .brand small { display:none; }
}
</style>
</head>
<body>
<header>
  <div class="mark"></div>
  <div class="brand">Code map<small id="subtitle"></small></div>
  <input id="q" class="search" placeholder="Find a handler or service" autocomplete="off" aria-label="Find a handler or service">
  <div class="tools">
    <button id="arch" aria-pressed="true">Architecture on</button>
    <div class="seg" role="tablist">
      <button data-view="job" aria-pressed="true">By job</button>
      <button data-view="cluster">By cluster</button>
      <button data-view="calls">Who calls whom</button>
      <button data-view="missing">Missing steps</button>
      <button data-view="problems">Problems</button>
    </div>
    <button id="callers">Who calls this</button>
    <button id="callees">What this calls</button>
    <button id="theme">Theme</button>
    <button id="save">Save map</button>
  </div>
</header>
<div class="note" id="note">Loading the map…</div>
<div class="work" id="work">
  <div class="stage">
    <div class="canvas" id="canvas" tabindex="0" aria-label="Code map. Scroll or drag to move. Pinch or Control-scroll to zoom.">
      <svg id="map" role="img" aria-label="Code map"></svg>
    </div>
    <div class="zoom" role="group" aria-label="Map zoom">
      <button id="zoom-out" aria-label="Zoom out" title="Zoom out (−)">−</button>
      <button id="zoom-fit" aria-label="Reset zoom" title="Reset zoom (0)">100%</button>
      <button id="zoom-in" aria-label="Zoom in" title="Zoom in (+)">+</button>
    </div>
    <div class="hint"><b>Scroll or drag</b> to move. Pinch or Ctrl-scroll to zoom. Click a card to see what it does. Yellow = a source step is missing from the map. Rose = an architecture rule broke in that body.</div>
    <button class="fab" id="open">Details</button>
  </div>
  <aside class="drawer" id="drawer" aria-label="Details"></aside>
</div>
<footer id="foot"></footer>
<script>
const LANE_X = {Handlers:40, Guards:40, Services:430, Models:820};
const AREA_X = {};
const state = { arch:true, view:"job", focus:null, reach:null, path:null, q:"", data:null, guardsTop:400 };
const cam = { k:0 };
const gesture = { pan:false, moved:false, x:0, y:0, sl:0, st:0, ignoreUntil:0 };

function canvasEl(){ return document.getElementById("canvas"); }
function readHash(){
  const raw = (location.hash || "").replace(/^#/, "");
  const p = new URLSearchParams(raw);
  return { n: p.get("n"), view: p.get("view"), arch: p.get("arch") };
}
function writeHash(){
  const p = new URLSearchParams();
  if (state.focus) p.set("n", state.focus);
  if (state.view && state.view !== "job") p.set("view", state.view);
  if (!state.arch) p.set("arch", "0");
  const next = p.toString();
  if (location.hash.replace(/^#/, "") !== next) history.replaceState(null, "", next ? "#"+next : "#");
}
function worldSize(){
  let w = 1120, h = 760;
  if (!state.data) return {w,h};
  state.data.nodes.forEach(n => {
    if (n.x==null) return;
    w = Math.max(w, n.x + n.w + 48);
    h = Math.max(h, n.y + n.h + 64);
  });
  return {w,h};
}
function fitK(){
  const c = canvasEl();
  const {w} = worldSize();
  const cw = (c && c.clientWidth) ? c.clientWidth : w;
  return cw / Math.max(w, 1);
}
function sizeMap(){
  const svg = document.getElementById("map");
  const c = canvasEl();
  if (!svg || !c) return;
  const {w,h} = worldSize();
  if (!cam.k) cam.k = fitK();
  cam.k = Math.min(4, Math.max(0.25, cam.k));
  svg.setAttribute("viewBox", "0 0 " + w + " " + h);
  svg.setAttribute("preserveAspectRatio", "xMinYMin meet");
  svg.style.width = (w * cam.k) + "px";
  svg.style.height = (h * cam.k) + "px";
  const fit = document.getElementById("zoom-fit");
  if (fit) fit.textContent = Math.round((cam.k / fitK()) * 100) + "%";
}
function zoomBy(factor, cx, cy){
  const c = canvasEl();
  if (!c) return;
  const rect = c.getBoundingClientRect();
  const ox = (cx==null) ? c.clientWidth/2 : (cx - rect.left);
  const oy = (cy==null) ? c.clientHeight/2 : (cy - rect.top);
  const px = c.scrollLeft + ox;
  const py = c.scrollTop + oy;
  const prev = cam.k || fitK();
  cam.k = Math.min(4, Math.max(0.25, prev * factor));
  sizeMap();
  const r = cam.k / prev;
  c.scrollLeft = px * r - ox;
  c.scrollTop = py * r - oy;
}
function resetZoom(){
  cam.k = fitK();
  sizeMap();
  const c = canvasEl();
  if (c) c.scrollTo({left:0, top:0});
}
function reveal(n){
  if (!n || n.x==null) return;
  const c = canvasEl();
  if (!c) return;
  const k = cam.k || 1;
  const left = n.x * k, right = (n.x+n.w)*k, top = n.y*k, bot = (n.y+n.h)*k;
  const pad = 28;
  const visL = c.scrollLeft, visR = visL + c.clientWidth, visT = c.scrollTop, visB = visT + c.clientHeight;
  if (left >= visL+pad && right <= visR-pad && top >= visT+pad && bot <= visB-pad) return;
  c.scrollTo({
    left: Math.max(0, (n.x + n.w/2)*k - c.clientWidth/2),
    top: Math.max(0, (n.y + n.h/2)*k - c.clientHeight/3)
  });
}
async function boot(){
  const res = await fetch("/api/graph");
  if (!res.ok) { document.getElementById("note").textContent = "Could not load the map. Run vg first."; return; }
  state.data = await res.json();
  document.title = state.data.meta.title;
  document.getElementById("subtitle").textContent = " · " + state.data.meta.nodes + " symbols";
  const h = readHash();
  if (h.view && ["job","cluster","calls","missing","problems"].indexOf(h.view) >= 0) {
    state.view = h.view;
    document.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", b.getAttribute("data-view")===h.view ? "true" : "false"));
  }
  if (h.arch === "0") {
    state.arch = false;
    document.getElementById("arch").setAttribute("aria-pressed", "false");
    document.getElementById("arch").textContent = "Architecture off";
  }
  draw();
  const wanted = h.n && state.data.nodes.find(n => n.id===h.n || n.name===h.n || n.qualifiedName===h.n);
  const first = wanted || state.data.nodes.find(n => n.pulse) || state.data.nodes.find(n => n.kind === "route") || state.data.nodes[0];
  if (first) openNode(first.id);
}
function node(id){ return state.data.nodes.find(n => n.id===id); }
function note(){
  const el = document.getElementById("note");
  const m = state.data.meta;
  if (!state.arch) { el.innerHTML = "<b>Showing the raw map.</b> Jobs and “writes data” labels stay hidden until architecture is on."; return; }
  if (!m.architectureLoaded) { el.innerHTML = "<b>Showing the raw map.</b> Architecture labels appear after the architecture module classifies this project."; return; }
  el.innerHTML = "<b>Showing what each piece is for.</b> " + esc(m.policyLabel || "") + (m.pulses ? " · " + m.pulses + " rule break" + (m.pulses===1?"":"s") : " · no rule breaks") + (m.missingSteps ? " · " + m.missingSteps + " missing step" + (m.missingSteps===1?"":"s") : "");
}
function visible(){
  let nodes = state.data.nodes;
  if (!state.arch) { /* still hide files, already filtered */ }
  if (state.view === "calls") nodes = nodes.filter(n => n.kind !== "property");
  if (state.view === "missing") nodes = nodes.filter(n => n.missingStep);
  if (state.view === "problems") nodes = nodes.filter(n => n.pulse);
  if (state.q) {
    const q = state.q.toLowerCase();
    nodes = nodes.filter(n => (n.name+" "+n.qualifiedName+" "+n.job+" "+(n.intent||"")+" "+n.purposes.map(p=>p.label).join(" ")).toLowerCase().includes(q));
  }
  return new Set(nodes.map(n => n.id));
}
function layout(){
  const areaUsed = {};
  state.data.areas.forEach((a,i) => { AREA_X[a.id] = 40 + (i%3)*390; });
  if (state.arch && state.view !== "cluster") {
    const buckets = {Handlers:[], Guards:[], Services:[], Models:[]};
    state.data.nodes.forEach(n => {
      const lane = n.lane && buckets[n.lane] ? n.lane : "Models";
      buckets[lane].push(n);
    });
    function place(list, x, top){
      list.forEach((n,i) => { n.x=x; n.y=top+i*70; n.w=250; n.h=58; });
      return top + list.length * 70;
    }
    const hEnd = place(buckets.Handlers, LANE_X.Handlers, 52);
    state.guardsTop = Math.max(400, hEnd + 48);
    place(buckets.Guards, LANE_X.Guards, state.guardsTop);
    place(buckets.Services, LANE_X.Services, 52);
    place(buckets.Models, LANE_X.Models, 52);
  } else {
    state.guardsTop = 400;
    state.data.nodes.forEach(n => {
      const row = areaUsed[n.area] || 0; areaUsed[n.area] = row+1;
      n.x = AREA_X[n.area] ?? 40; n.y = 52 + row*70; n.w=250; n.h=58;
    });
  }
}
const OUT={}, INN={};
function indexEdges(){
  Object.keys(OUT).forEach(k => delete OUT[k]);
  Object.keys(INN).forEach(k => delete INN[k]);
  state.data.edges.forEach(e => {
    (OUT[e.src]=OUT[e.src]||[]).push(e);
    (INN[e.dst]=INN[e.dst]||[]).push(e);
  });
}
function walk(id, dir){
  const map = {};
  state.data.edges.forEach(e => {
    if (dir==="out") (map[e.src]=map[e.src]||[]).push(e.dst);
    else (map[e.dst]=map[e.dst]||[]).push(e.src);
  });
  const seen=new Set([id]); const q=[id];
  while(q.length){ const c=q.pop(); (map[c]||[]).forEach(n => { if(!seen.has(n)){ seen.add(n); q.push(n);} }); }
  return seen;
}
function draw(){
  if (!state.data) return;
  layout(); note(); indexEdges();
  const vis = visible();
  let hot = null;
  if (state.reach==="in" && state.focus) hot = walk(state.focus,"in");
  if (state.reach==="out" && state.focus) hot = walk(state.focus,"out");
  if (state.path) hot = new Set(state.path);
  let h = "";
  if (state.arch && state.view !== "cluster") {
    h += '<text class="col" x="40" y="24">HANDLERS</text><text class="col" x="40" y="'+(state.guardsTop-16)+'">GUARDS</text><text class="col" x="430" y="24">SERVICES</text><text class="col" x="820" y="24">MODELS</text>';
  } else {
    state.data.areas.forEach(a => {
      h += '<text class="col" x="'+(AREA_X[a.id]||40)+'" y="24">'+esc(a.label.toUpperCase())+'</text>';
    });
  }
  state.data.edges.forEach(e => {
    if (!vis.has(e.src) || !vis.has(e.dst)) return;
    if (state.view==="calls" && e.kind==="contains") return;
    const a=node(e.src), b=node(e.dst);
    if (a.x==null || b.x==null) return;
    const x1=a.x+a.w,y1=a.y+a.h/2,x2=b.x,y2=b.y+b.h/2,m=(x1+x2)/2;
    const on = hot ? (hot.has(e.src)&&hot.has(e.dst)) : true;
    h += '<path class="edge '+e.kind+(on?" hot":" dim")+'" d="M'+x1+','+y1+' C'+m+','+y1+' '+m+','+y2+' '+x2+','+y2+'"/>';
  });
  state.data.nodes.forEach(n => {
    if (!vis.has(n.id) || n.x==null) return;
    const color = state.arch && n.classified ? n.color : colorForKind(n.kind);
    const dim = hot ? !hot.has(n.id) : false;
    const job = state.arch ? n.job : n.kindLabel;
    const does = state.arch && n.purposes[0] ? " · "+n.purposes[0].label : "";
    h += '<g class="node'+(dim?" dim":"")+'" data-id="'+n.id+'">'
      + '<rect x="'+n.x+'" y="'+n.y+'" width="'+n.w+'" height="'+n.h+'" rx="10" fill="var(--s1)" stroke="'+color+'" stroke-width="'+(state.focus===n.id?2.4:1.4)+'"/>'
      + '<text class="name" x="'+(n.x+14)+'" y="'+(n.y+24)+'">'+esc(n.name)+'</text>'
      + '<text class="meta" x="'+(n.x+14)+'" y="'+(n.y+42)+'">'+esc(job+does)+'</text>'
      + (n.pulse ? '<circle cx="'+(n.x+n.w-14)+'" cy="'+(n.y+14)+'" r="4.5" fill="#fb7185"/>' : "")
      + (n.missingStep && !n.pulse ? '<circle cx="'+(n.x+n.w-14)+'" cy="'+(n.y+14)+'" r="4.5" fill="#fbbf24"/>' : "")
      + '</g>';
  });
  document.getElementById("map").innerHTML = h;
  document.querySelectorAll(".node").forEach(g => g.addEventListener("click", ev => {
    if (gesture.moved || Date.now() < gesture.ignoreUntil) { ev.preventDefault(); ev.stopPropagation(); return; }
    openNode(g.dataset.id);
  }));
  sizeMap();
  const m = state.data.meta;
  document.getElementById("foot").innerHTML = "<span>"+m.nodes+" symbols</span><span>"+(m.architectureLoaded?"Architecture loaded":"Architecture not loaded")+"</span><span>"+(m.pulses?m.pulses+" rule break"+(m.pulses===1?"":"s"):"No rule breaks")+"</span><span>Scroll or drag · pinch or Ctrl-scroll to zoom</span>";
}
function colorForKind(kind){
  return {route:"#38bdf8",function:"#38bdf8",method:"#22c55e",class:"#22c55e",property:"#94a3b8"}[kind] || "#94a3b8";
}
function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }
async function openNode(id){
  state.focus = id; state.path = null; writeHash();
  document.getElementById("work").classList.remove("closed");
  const n = node(id);
  let detail = null;
  try { const r = await fetch("/api/node/"+encodeURIComponent(id)); if (r.ok) detail = await r.json(); } catch {}
  const calls = (OUT[id]||[]).filter(e => e.kind !== "contains");
  const called = (INN[id]||[]).filter(e => e.kind !== "contains");
  const kids = (OUT[id]||[]).filter(e => e.kind === "contains");
  const findings = (detail && detail.arch && detail.arch.findings) || [];
  const pulse = findings.filter(f => typeof f.line === "number" && f.line > 0);
  let html = '<div class="dh"><h2>'+esc(n.name)+'</h2><button class="icon" id="close" aria-label="Hide details">✕</button></div><div class="db">';
  html += '<p class="lead">'+esc(n.intent || n.signature || n.kindLabel)+'</p>';
  html += '<div class="chips"><span class="chip">'+(state.arch ? esc(n.job) : esc(n.kindLabel))+'</span>';
  if (state.arch) n.purposes.forEach(p => html += '<span class="chip">'+esc(p.label)+'</span>');
  html += '</div>';
  html += '<p class="lbl">Where</p><p class="place">'+esc(n.file)+(n.line? ", line "+n.line:"")+'</p>';
  html += '<p class="lbl">Calls</p>';
  if (!calls.length) html += '<p class="empty">Doesn’t call anything else on this map.</p>';
  else {
    html += '<ul class="list">';
    calls.forEach(e => html += '<li><span class="verb">'+(e.kind==="call"?"calls":"uses")+'</span><a href="#" data-go="'+e.dst+'">'+esc(node(e.dst).name)+'</a></li>');
    html += '</ul>';
  }
  html += '<p class="lbl">Called by</p>';
  if (!called.length) html += '<p class="empty">Nothing on this map calls this.</p>';
  else {
    html += '<ul class="list">';
    called.forEach(e => html += '<li><span class="verb">from</span><a href="#" data-go="'+e.src+'">'+esc(node(e.src).name)+'</a></li>');
    html += '</ul>';
  }
  if (kids.length){
    html += '<p class="lbl">Contains</p><ul class="list">';
    kids.forEach(e => html += '<li><span class="verb">has</span><a href="#" data-go="'+e.dst+'">'+esc(node(e.dst).name)+'</a></li>');
    html += '</ul>';
  }
  if (n.missingStep) html += '<div class="warn"><h3>This map is missing a step</h3><p>'+esc(n.missingStepText || "A call in the source never made it onto the map.")+'</p></div>';
  if (pulse.length){
    html += pulse.map(f => '<div class="break"><h3>This breaks an architecture rule</h3><p>'+esc(f.message)+(f.line? " Line "+f.line+".":"")+'</p></div>').join("");
  }
  html += '<details><summary>More</summary><p>'+esc(n.qualifiedName)+'</p></details></div>';
  document.getElementById("drawer").innerHTML = html;
  document.getElementById("close").onclick = () => document.getElementById("work").classList.add("closed");
  document.querySelectorAll("[data-go]").forEach(a => a.onclick = ev => { ev.preventDefault(); openNode(a.dataset.go); });
  draw();
  reveal(n);
}
document.getElementById("q").addEventListener("input", e => { state.q = e.target.value; draw(); });
document.getElementById("arch").onclick = () => {
  state.arch = !state.arch;
  document.getElementById("arch").setAttribute("aria-pressed", state.arch);
  document.getElementById("arch").textContent = state.arch ? "Architecture on" : "Architecture off";
  if (state.focus) openNode(state.focus); else draw();
};
document.querySelectorAll("[data-view]").forEach(b => b.onclick = () => {
  document.querySelectorAll("[data-view]").forEach(x => x.setAttribute("aria-pressed","false"));
  b.setAttribute("aria-pressed","true");
  state.view = b.dataset.view; state.reach=null; draw();
});
document.getElementById("callers").onclick = () => { if(state.focus){ state.reach="in"; draw(); } };
document.getElementById("callees").onclick = () => { if(state.focus){ state.reach="out"; draw(); } };
document.getElementById("theme").onclick = () => {
  const light = document.documentElement.dataset.theme === "light";
  document.documentElement.dataset.theme = light ? "" : "light";
};
document.getElementById("save").onclick = () => {
  if (!state.data) return;
  const blob = new Blob([JSON.stringify(state.data, null, 2)], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "code-map.json";
  a.click();
};
document.getElementById("open").onclick = () => document.getElementById("work").classList.remove("closed");
document.getElementById("zoom-in").onclick = () => zoomBy(1.2);
document.getElementById("zoom-out").onclick = () => zoomBy(1/1.2);
document.getElementById("zoom-fit").onclick = () => resetZoom();
(function bindPanZoom(){
  const c = canvasEl();
  c.addEventListener("wheel", e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomBy(Math.exp(-dy * 0.002), e.clientX, e.clientY);
  }, { passive: false });
  c.addEventListener("pointerdown", e => {
    if (e.pointerType === "touch" || e.button !== 0) return;
    gesture.pan = true; gesture.moved = false;
    gesture.x = e.clientX; gesture.y = e.clientY;
    gesture.sl = c.scrollLeft; gesture.st = c.scrollTop;
    c.classList.add("panning");
    try { c.setPointerCapture(e.pointerId); } catch {}
  });
  c.addEventListener("pointermove", e => {
    if (!gesture.pan) return;
    const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) gesture.moved = true;
    if (gesture.moved) {
      c.scrollLeft = gesture.sl - dx;
      c.scrollTop = gesture.st - dy;
    }
  });
  function endPan(){
    if (!gesture.pan) return;
    c.classList.remove("panning");
    if (gesture.moved) gesture.ignoreUntil = Date.now() + 250;
    gesture.pan = false;
  }
  c.addEventListener("pointerup", endPan);
  c.addEventListener("pointercancel", endPan);
})();
window.addEventListener("resize", () => { if (state.data) sizeMap(); });
document.addEventListener("keydown", e => {
  if ((e.metaKey||e.ctrlKey) && e.key.toLowerCase()==="k") { e.preventDefault(); document.getElementById("q").focus(); return; }
  if (e.key==="/" && document.activeElement.tagName!=="INPUT") { e.preventDefault(); document.getElementById("q").focus(); return; }
  if (e.key==="Escape") document.getElementById("work").classList.add("closed");
  const typing = document.activeElement && document.activeElement.tagName==="INPUT";
  if (typing) return;
  if (e.key==="+" || e.key==="=") { e.preventDefault(); zoomBy(1.2); }
  if (e.key==="-" || e.key==="_") { e.preventDefault(); zoomBy(1/1.2); }
  if (e.key==="0") { e.preventDefault(); resetZoom(); }
  const c = canvasEl();
  if (!c) return;
  const step = e.shiftKey ? 240 : 80;
  if (e.key==="ArrowDown") { e.preventDefault(); c.scrollBy({top: step}); }
  if (e.key==="ArrowUp") { e.preventDefault(); c.scrollBy({top: -step}); }
  if (e.key==="ArrowRight") { e.preventDefault(); c.scrollBy({left: step}); }
  if (e.key==="ArrowLeft") { e.preventDefault(); c.scrollBy({left: -step}); }
  if (e.key==="PageDown") { e.preventDefault(); c.scrollBy({top: c.clientHeight * 0.9}); }
  if (e.key==="PageUp") { e.preventDefault(); c.scrollBy({top: -c.clientHeight * 0.9}); }
  if (e.key==="Home") { e.preventDefault(); c.scrollTo({top:0}); }
  if (e.key==="End") { e.preventDefault(); c.scrollTo({top: c.scrollHeight}); }
});
boot();
</script>
</body>
</html>`;
}
