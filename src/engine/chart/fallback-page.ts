/**
 * Tiny architecture map served when the Architecture module does not render a page.
 * Workspace packages, then a column slice. No interaction framework, no CDN.
 * VS Code hosts the same page over postMessage (`data-host="vscode"`).
 */
import type { ArchPageHost } from './arch-types.js';

export function fallbackArchPage(opts?: { host?: ArchPageHost; nonce?: string }): string {
  const host: ArchPageHost = opts?.host === 'vscode' ? 'vscode' : 'browser';
  const nonce = opts?.nonce ?? '';
  return `<!DOCTYPE html>
<html lang="en" data-host="${host}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Code map</title>
<style>
:root {
  --bg:#0b0f0c; --s1:#141c16; --s2:#1b241d; --line:#2a362c;
  --t:#e8f0e9; --tm:#9aab9e; --tl:#6b7a6e; --cyan:#38bdf8; --green:#22c55e;
  --sans:"IBM Plex Sans","Segoe UI",system-ui,sans-serif; --link:var(--cyan);
}
[data-theme="light"] {
  --bg:#f4f1ea; --s1:#fffdf8; --s2:#fff; --line:#d9d3c6;
  --t:#1c241d; --tm:#5d675f; --tl:#7e877f;
}
[data-host="vscode"] {
  --bg:var(--vscode-editor-background,#0b0f0c);
  --s1:var(--vscode-editorWidget-background,#141c16);
  --s2:var(--vscode-input-background,#1b241d);
  --line:var(--vscode-widget-border,var(--vscode-panel-border,#2a362c));
  --t:var(--vscode-foreground,#e8f0e9);
  --tm:var(--vscode-descriptionForeground,#9aab9e);
  --tl:var(--vscode-descriptionForeground,#6b7a6e);
  --sans:var(--vscode-font-family,system-ui);
  --link:var(--vscode-textLink-foreground,var(--cyan));
  --cyan:var(--vscode-charts-blue,#38bdf8);
  --green:var(--vscode-charts-green,#22c55e);
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
.more { font-size:12px; color:var(--tl); padding:6px; background:none; border:none; height:auto; text-align:left; }
.openfile { background:none; border:none; padding:0; height:auto; color:var(--link); text-decoration:underline; cursor:pointer; font:inherit; text-align:left; }
.lbl { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--tl); margin:14px 0 6px; }
a { color:var(--link); }
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
<script nonce="${nonce}">
const HOST=document.documentElement.getAttribute("data-host")||"browser";
const vscode=(function(){try{return HOST==="vscode"?acquireVsCodeApi():null}catch(e){return null}})();
if(HOST==="vscode"){
  document.getElementById("theme").hidden=true;
  const light=document.body.classList.contains("vscode-light")||document.body.classList.contains("vscode-high-contrast-light");
  document.documentElement.setAttribute("data-theme",light?"light":"dark");
}
const state = { zoom:"workspace", packageId:null, focus:null, overview:null, slice:null, pendingPackage:null };
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
  if (HOST==="vscode") return {};
  const p = new URLSearchParams((location.hash||"").replace(/^#/,""));
  return { zoom:p.get("zoom")||"workspace", package:p.get("package"), n:p.get("n"), view:p.get("view") };
}
function writeHash(){
  if (HOST==="vscode") return;
  const p = new URLSearchParams();
  p.set("zoom", state.zoom);
  if (state.packageId) p.set("package", state.packageId);
  if (state.focus) p.set("n", state.focus);
  const next = p.toString();
  try { if (location.hash.replace(/^#/,"") !== next) history.replaceState(null,"","#"+next); } catch (e) {}
}
function api(path, cb){
  if (vscode) { window.__wait = window.__wait || {}; window.__wait[path] = cb; vscode.postMessage({ type:"fetch", path:path }); return; }
  fetch(path).then(function(r){ return r.ok ? r.json() : Promise.reject(); }).then(cb).catch(function(){
    document.getElementById("note").textContent = "Could not load the map. Run vg first.";
  });
}
window.addEventListener("message", function(e){
  const m = e.data; if (!m) return;
  if (m.type === "init" && m.overview) { state.overview = m.overview; if (m.packageId) state.pendingPackage = m.packageId; afterOverview(); }
  if (m.type === "slice" && m.slice) { state.slice = m.slice; drawSlice(); }
  if (m.type === "node" && m.node) { openCardFromNode(m.node, m.card); }
  if (m.type === "fetch-result" && window.__wait && window.__wait[m.path]) { window.__wait[m.path](m.body); delete window.__wait[m.path]; }
});
function afterOverview(){
  const m = state.overview.meta;
  document.title = m.title || "Code map";
  document.getElementById("subtitle").textContent = " · " + m.packages + " packages · " + m.symbols + " symbols";
  const h = readHash();
  const pack = state.pendingPackage || (h.zoom === "slice" ? h.package : null);
  state.pendingPackage = null;
  if (pack) { state.focus = h.n || state.focus; openSlice(pack); }
  else drawWorkspace();
}
function boot(){
  if (vscode) { vscode.postMessage({ type:"ready" }); return; }
  api("/api/overview", function(body){ state.overview = body; afterOverview(); });
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
    b.innerHTML = "<strong>"+esc(pkg.name)+"</strong><small>"+esc(pkg.mix || (pkg.job+" · "+pkg.symbols+" symbols"))+"</small>";
    b.onclick = function(){ openSlice(pkg.id); };
    grid.appendChild(b);
  }
  writeHash();
}
function openSlice(packageId){
  if (vscode) { vscode.postMessage({ type:"openSlice", packageId:packageId, view:"job", focus:state.focus, arch:true }); return; }
  const url = "/api/slice?package="+encodeURIComponent(packageId)+(state.focus? "&focus="+encodeURIComponent(state.focus):"");
  api(url, function(body){ state.slice = body; drawSlice(); });
}
function drawSlice(){
  state.zoom = "slice";
  state.packageId = state.slice.packageId;
  document.getElementById("back").hidden = false;
  document.getElementById("note").innerHTML = "<b>"+esc(state.slice.packageName)+"</b> · column slice. Tests are hidden."
    +(state.slice.emptyHint? " "+esc(state.slice.emptyHint):"");
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
      if (HOST !== "vscode" && card.color) b.style.borderLeftColor = card.color;
      b.innerHTML = "<strong>"+esc(card.title)+"</strong><small>"+esc(card.subtitle)+"</small>"
        +(card.intent? "<small>"+esc(card.intent)+"</small>":"");
      b.onclick = function(){ openCard(card); };
      stack.appendChild(b);
    }
    const extra = state.slice.overflow && state.slice.overflow[col.id];
    if (extra) {
      const more = document.createElement("button");
      more.className = "more";
      more.type = "button";
      const hint = state.slice.overflowHint && state.slice.overflowHint[col.id];
      more.textContent = hint ? "+ " + hint : "+ " + extra + " more in this lane";
      stack.appendChild(more);
    }
    wrap.appendChild(stack);
    cols.appendChild(wrap);
  }
  stage.innerHTML = "";
  stage.appendChild(cols);
  writeHash();
  if (state.slice.focusCardId) {
    const card = state.slice.columns.flatMap(function(c){ return c.cards; }).concat(state.slice.guards||[]).find(function(c){ return c.id === state.slice.focusCardId; });
    if (card) openCard(card);
  }
}
function openCard(card){
  state.focus = card.symbolId;
  writeHash();
  if (vscode) { vscode.postMessage({ type:"node", id:card.symbolId, card:card }); return; }
  api("/api/node/"+encodeURIComponent(card.symbolId), function(n){ openCardFromNode(n, card); });
}
function openCardFromNode(n, card){
  const drawer = document.getElementById("drawer");
  const calls = (n.calls||[]).slice(0,40);
  const called = (n.calledBy||[]).slice(0,40);
  const lifted = (card && card.calls && card.calls.length) ? card.calls.map(function(x){ return x.name; }) : calls;
  const liftedBy = (card && card.calledBy && card.calledBy.length) ? card.calledBy.map(function(x){ return x.name; }) : called;
  const file = n.file || (card && card.file) || "";
  const line = n.line || (card && card.line) || 0;
  drawer.innerHTML = "<h2>"+esc(n.name||card.title)+"</h2>"
    + "<p>"+esc((card && card.job) || ((n.view&&n.view.job)||""))+"</p>"
    + "<p>"+esc((card && card.intent) || ((n.view&&n.view.intent)|| (card && card.subtitle) || ""))+"</p>"
    + "<p class=lbl>Where</p><p>"+(file ? "<button type=button class=openfile data-file='"+esc(file)+"' data-line='"+(line||1)+"'>"+esc(file)+(line? ", line "+line:"")+"</button>" : "")+"</p>"
    + "<p class=lbl>Calls</p>" + (lifted.length? "<ul>"+lifted.map(function(x){return "<li>"+esc(x)+"</li>";}).join("")+"</ul>":"<p>No calls in this slice.</p>")
    + "<p class=lbl>Called by</p>" + (liftedBy.length? "<ul>"+liftedBy.map(function(x){return "<li>"+esc(x)+"</li>";}).join("")+"</ul>":"<p>No callers in this slice.</p>");
  const btn = drawer.querySelector(".openfile");
  if (btn) btn.onclick = function(){
    const f = btn.getAttribute("data-file");
    const ln = parseInt(btn.getAttribute("data-line")||"1", 10) || 1;
    if (vscode) vscode.postMessage({ type:"openFile", file:f, line:ln });
  };
}
document.getElementById("back").onclick = function(){ state.focus = null; drawWorkspace(); };
document.getElementById("theme").onclick = function(){
  const light = document.documentElement.dataset.theme === "light";
  document.documentElement.dataset.theme = light ? "" : "light";
};
boot();
</script>
</body>
</html>`;
}
