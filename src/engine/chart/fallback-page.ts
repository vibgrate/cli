/**
 * Tiny architecture map served when the Architecture module does not render a page.
 * Workspace packages, then a column slice. No interaction framework, no CDN.
 */
export function fallbackArchPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Code map</title>
<style>
:root {
  --bg:#0b0f0c; --s1:#141c16; --s2:#1b241d; --line:#2a362c;
  --t:#e8f0e9; --tm:#9aab9e; --tl:#6b7a6e; --cyan:#38bdf8; --green:#22c55e;
  --sans:"IBM Plex Sans","Segoe UI",system-ui,sans-serif;
}
[data-theme="light"] {
  --bg:#f4f1ea; --s1:#fffdf8; --s2:#fff; --line:#d9d3c6;
  --t:#1c241d; --tm:#5d675f; --tl:#7e877f;
}
* { box-sizing:border-box; }
html,body { margin:0; height:100%; background:var(--bg); color:var(--t); font-family:var(--sans); }
body { display:flex; flex-direction:column; }
header { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:8px 12px; border-bottom:1px solid var(--line); background:var(--s1); }
.mark { width:10px; height:10px; border-radius:3px; background:var(--green); }
.brand { font-weight:650; font-size:14px; }
.brand small { color:var(--tm); font-weight:500; margin-left:6px; }
button { font:inherit; color:inherit; cursor:pointer; height:34px; padding:0 10px; border-radius:8px; border:1px solid var(--line); background:var(--s2); }
.note { padding:8px 12px; font-size:13px; color:var(--tm); border-bottom:1px solid var(--line); }
.work { flex:1; display:grid; grid-template-columns:1fr 320px; min-height:0; }
.stage { overflow:auto; padding:16px; }
.drawer { border-left:1px solid var(--line); background:var(--s1); overflow:auto; padding:14px; }
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:12px; }
.card, .pkg {
  text-align:left; height:auto; padding:12px 14px; border-radius:4px; width:100%;
  border-left:3px solid var(--cyan);
}
.pkg small, .card small { display:block; color:var(--tm); font-size:12px; margin-top:4px; }
.cols { display:flex; gap:16px; align-items:flex-start; }
.col { flex:1; min-width:200px; }
.col h2 { margin:0 0 8px; font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--tl); }
.col .stack { display:flex; flex-direction:column; gap:8px; }
.more { font-size:12px; color:var(--tl); padding:6px; }
.lbl { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--tl); margin:14px 0 6px; }
a { color:var(--cyan); }
@media (max-width:860px) { .work { grid-template-columns:1fr; } .drawer { border-left:0; border-top:1px solid var(--line); } }
</style>
</head>
<body>
<header>
  <div class="mark"></div>
  <div class="brand">Code map<small id="subtitle"></small></div>
  <button type="button" id="back" hidden>Workspace</button>
  <button type="button" id="theme">Theme</button>
</header>
<div class="note" id="note">Loading the map…</div>
<div class="work">
  <div class="stage" id="stage"></div>
  <aside class="drawer" id="drawer"><p class="lbl">Details</p><p id="empty">Select a package, then a card.</p></aside>
</div>
<script>
const state = { zoom:"workspace", packageId:null, focus:null, overview:null, slice:null };
function esc(s){
  return String(s==null?"":s).replace(/[&<>"']/g, function(c){
    if (c==="&") return "&amp;";
    if (c==="<") return "&lt;";
    if (c===">") return "&gt;";
    if (c==='"') return "&quot;";
    return "&#39;";
  });
}
function readHash(){
  const p = new URLSearchParams((location.hash||"").replace(/^#/,""));
  return { zoom:p.get("zoom")||"workspace", package:p.get("package"), n:p.get("n"), view:p.get("view") };
}
function writeHash(){
  const p = new URLSearchParams();
  p.set("zoom", state.zoom);
  if (state.packageId) p.set("package", state.packageId);
  if (state.focus) p.set("n", state.focus);
  const next = p.toString();
  if (location.hash.replace(/^#/,"") !== next) history.replaceState(null,"","#"+next);
}
async function boot(){
  const ov = await fetch("/api/overview");
  if (!ov.ok) { document.getElementById("note").textContent = "Could not load the map. Run vg first."; return; }
  state.overview = await ov.json();
  const m = state.overview.meta;
  document.title = m.title || "Code map";
  document.getElementById("subtitle").textContent = " · " + m.packages + " packages · " + m.symbols + " symbols";
  const h = readHash();
  if (h.zoom === "slice" && h.package) {
    state.focus = h.n;
    await openSlice(h.package);
  } else {
    drawWorkspace();
  }
}
function drawWorkspace(){
  state.zoom = "workspace"; state.slice = null; state.packageId = null;
  document.getElementById("back").hidden = true;
  const m = state.overview.meta;
  document.getElementById("note").innerHTML = m.architectureLoaded
    ? "<b>How the projects fit together.</b> Open a package to see UI → service → store."
    : "<b>How the projects fit together.</b> Architecture labels appear after the architecture module classifies this project.";
  const stage = document.getElementById("stage");
  stage.innerHTML = '<div class="grid"></div>';
  const grid = stage.firstChild;
  for (const pkg of state.overview.packages) {
    const b = document.createElement("button");
    b.className = "pkg";
    b.type = "button";
    b.innerHTML = "<strong>"+esc(pkg.name)+"</strong><small>"+esc(pkg.job)+" · "+pkg.symbols+" symbols"
      +(pkg.findings? " · "+pkg.findings+" rule break"+(pkg.findings===1?"":"s"):"")+"</small>";
    b.onclick = () => openSlice(pkg.id);
    b.ondblclick = () => openSlice(pkg.id);
    grid.appendChild(b);
  }
  writeHash();
}
async function openSlice(packageId){
  const url = "/api/slice?package="+encodeURIComponent(packageId)+(state.focus? "&focus="+encodeURIComponent(state.focus):"");
  const res = await fetch(url);
  if (!res.ok) { document.getElementById("note").textContent = "Could not open that package."; return; }
  state.slice = await res.json();
  state.zoom = "slice";
  state.packageId = state.slice.packageId;
  document.getElementById("back").hidden = false;
  document.getElementById("note").innerHTML = "<b>"+esc(state.slice.packageName)+"</b> · column slice. Tests are hidden. Double-click a workspace card to return.";
  const stage = document.getElementById("stage");
  const cols = document.createElement("div");
  cols.className = "cols";
  for (const col of state.slice.columns) {
    const wrap = document.createElement("div");
    wrap.className = "col";
    wrap.innerHTML = "<h2>"+esc(col.title)+"</h2>";
    const stack = document.createElement("div");
    stack.className = "stack";
    for (const card of col.cards) {
      const b = document.createElement("button");
      b.className = "card";
      b.type = "button";
      b.style.borderLeftColor = card.color || "var(--cyan)";
      b.innerHTML = "<strong>"+esc(card.title)+"</strong><small>"+esc(card.subtitle)+"</small>";
      b.onclick = () => openCard(card);
      stack.appendChild(b);
    }
    const extra = state.slice.overflow && state.slice.overflow[col.id];
    if (extra) {
      const more = document.createElement("div");
      more.className = "more";
      more.textContent = "+ " + extra + " more in this lane";
      stack.appendChild(more);
    }
    wrap.appendChild(stack);
    cols.appendChild(wrap);
  }
  stage.innerHTML = "";
  stage.appendChild(cols);
  writeHash();
  if (state.slice.focusCardId) {
    const card = state.slice.columns.flatMap(c => c.cards).concat(state.slice.guards||[]).find(c => c.id === state.slice.focusCardId);
    if (card) openCard(card);
  }
}
async function openCard(card){
  state.focus = card.symbolId;
  writeHash();
  const res = await fetch("/api/node/"+encodeURIComponent(card.symbolId));
  const drawer = document.getElementById("drawer");
  if (!res.ok) { drawer.textContent = "Not found."; return; }
  const n = await res.json();
  const calls = (n.calls||[]).slice(0,40);
  const called = (n.calledBy||[]).slice(0,40);
  drawer.innerHTML = "<h2>"+esc(n.name||card.title)+"</h2>"
    + "<p>"+esc((n.view&&n.view.intent)||card.subtitle||"")+"</p>"
    + "<p class=lbl>Where</p><p>"+esc(n.file)+(n.line? ", line "+n.line:"")+"</p>"
    + "<p class=lbl>Calls</p>" + (calls.length? "<ul>"+calls.map(x=>"<li>"+esc(x)+"</li>").join("")+"</ul>":"<p>Doesn't call anything else on this map.</p>")
    + "<p class=lbl>Called by</p>" + (called.length? "<ul>"+called.map(x=>"<li>"+esc(x)+"</li>").join("")+"</ul>":"<p>Nothing on this map calls this.</p>");
}
document.getElementById("back").onclick = () => { state.focus = null; drawWorkspace(); };
document.getElementById("theme").onclick = () => {
  const light = document.documentElement.dataset.theme === "light";
  document.documentElement.dataset.theme = light ? "" : "light";
};
boot();
</script>
</body>
</html>`;
}
