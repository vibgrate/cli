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
body { display:flex; flex-direction:column; min-height:100dvh; }
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
.work { flex:1; display:grid; grid-template-columns:1fr var(--panel); min-height:0; }
.work.closed { grid-template-columns:1fr 0; }
.canvas { position:relative; overflow:hidden; min-height:280px;
  background: linear-gradient(var(--line) 1px,transparent 1px), linear-gradient(90deg,var(--line) 1px,transparent 1px);
  background-size:32px 32px; }
svg { width:100%; height:100%; min-height:360px; display:block; }
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
  border-radius:10px; padding:10px 12px; font-size:12px; color:var(--tm); }
.fab { display:none; position:absolute; right:12px; bottom:12px; height:40px; padding:0 14px;
  border-radius:999px; border:1px solid var(--line); background:var(--s1); }
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
  .work { grid-template-columns:1fr; grid-template-rows:1fr auto; }
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
  <div class="canvas">
    <svg id="map" viewBox="0 0 1120 760" preserveAspectRatio="xMidYMin meet" role="img" aria-label="Code map"></svg>
    <div class="hint"><b>Click a card</b> to see what it does. Yellow = a source step is missing from the map. Rose = an architecture rule broke in that body.</div>
    <button class="fab" id="open">Details</button>
  </div>
  <aside class="drawer" id="drawer" aria-label="Details"></aside>
</div>
<footer id="foot"></footer>
<script>
const LANE_X = {Handlers:40, Guards:40, Services:430, Models:820};
const AREA_X = {};
const state = { arch:true, view:"job", focus:null, reach:null, path:null, q:"", data:null };

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
  const used = {Handlers:0,Guards:0,Services:0,Models:0};
  const areaUsed = {};
  state.data.areas.forEach((a,i) => { AREA_X[a.id] = 40 + (i%3)*390; });
  state.data.nodes.forEach(n => {
    if (state.arch && state.view !== "cluster") {
      const lane = n.lane || "Models";
      const row = used[lane] || 0; used[lane] = row+1;
      const top = lane === "Guards" ? 400 : 52;
      n.x = LANE_X[lane] ?? 40; n.y = top + row*70; n.w=250; n.h=58;
    } else {
      const row = areaUsed[n.area] || 0; areaUsed[n.area] = row+1;
      n.x = AREA_X[n.area] ?? 40; n.y = 52 + row*70; n.w=250; n.h=58;
    }
  });
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
    h += '<text class="col" x="40" y="24">HANDLERS</text><text class="col" x="40" y="384">GUARDS</text><text class="col" x="430" y="24">SERVICES</text><text class="col" x="820" y="24">MODELS</text>';
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
  document.querySelectorAll(".node").forEach(g => g.addEventListener("click", () => openNode(g.dataset.id)));
  const m = state.data.meta;
  document.getElementById("foot").innerHTML = "<span>"+m.nodes+" symbols</span><span>"+(m.architectureLoaded?"Architecture loaded":"Architecture not loaded")+"</span><span>"+(m.pulses?m.pulses+" rule break"+(m.pulses===1?"":"s"):"No rule breaks")+"</span>";
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
document.addEventListener("keydown", e => {
  if ((e.metaKey||e.ctrlKey) && e.key.toLowerCase()==="k") { e.preventDefault(); document.getElementById("q").focus(); }
  if (e.key==="/" && document.activeElement.tagName!=="INPUT") { e.preventDefault(); document.getElementById("q").focus(); }
  if (e.key==="Escape") document.getElementById("work").classList.add("closed");
});
boot();
</script>
</body>
</html>`;
}
