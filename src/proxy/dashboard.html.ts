/**
 * The local dashboard: one self-contained HTML document (inline CSS + JS,
 * no external assets, theme-neutral via `prefers-color-scheme`). Polls
 * `/api/stats`, `/api/savings` and `/api/settings` on the same origin.
 */

export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vibgrate CLI · proxy</title>
<style>
:root{--bg:#f6f7f8;--fg:#1c2128;--muted:#5c6670;--card:#ffffff;--line:#dfe3e8;--accent:#0f766e;--warn:#b45309;--bad:#b91c1c;--ok:#15803d;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--fg:#e6e9ee;--muted:#9aa4b1;--card:#171b21;--line:#2a313b;--accent:#2dd4bf;--warn:#f59e0b;--bad:#f87171;--ok:#4ade80}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;align-items:baseline;gap:16px;padding:16px 24px;border-bottom:1px solid var(--line)}header h1{font-size:18px;margin:0}header .meta{color:var(--muted);font-family:var(--mono);font-size:12px}
main{padding:16px 24px;display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
section{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px}section h2{margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.wide{grid-column:1/-1}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}.tile{padding:8px 10px;border:1px solid var(--line);border-radius:6px}.tile .v{font-size:20px;font-weight:600;font-family:var(--mono)}.tile .l{color:var(--muted);font-size:12px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:5px 6px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500}td.num,th.num{text-align:right;font-family:var(--mono)}
.bar{height:8px;background:var(--line);border-radius:4px;overflow:hidden}.bar>i{display:block;height:100%;background:var(--accent)}
.muted{color:var(--muted)}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}code{font-family:var(--mono);font-size:12px}
form.settings{display:grid;grid-template-columns:1fr auto;gap:6px 10px;align-items:center;max-height:420px;overflow:auto}form.settings label{font-family:var(--mono);font-size:12px}form.settings input,form.settings select{width:100%;padding:4px 6px;border:1px solid var(--line);border-radius:4px;background:var(--bg);color:var(--fg);font-family:var(--mono);font-size:12px}
button{padding:6px 12px;border:1px solid var(--line);border-radius:6px;background:var(--accent);color:#fff;cursor:pointer}button.secondary{background:transparent;color:var(--fg)}#settings-status{margin-top:8px;font-size:12px}
.scroll{max-height:360px;overflow:auto}details summary{cursor:pointer;color:var(--muted)}
</style>
</head>
<body>
<header><h1>Vibgrate CLI · proxy</h1><span class="meta" id="meta">connecting…</span><span class="meta" id="layers"></span></header>
<main>
<section class="wide"><h2>Savings</h2><div class="tiles" id="hero"></div><div style="margin-top:10px" id="target"></div></section>
<section><h2>Today · 7 days · 30 days</h2><table><thead><tr><th>window</th><th class="num">requests</th><th class="num">tokens saved</th><th class="num">USD saved</th><th class="num">saved %</th></tr></thead><tbody id="windows"></tbody></table></section>
<section><h2>Output shaping (estimate)</h2><div id="output"></div></section>
<section><h2>By model</h2><div class="scroll"><table><thead><tr><th>model</th><th class="num">req</th><th class="num">saved</th><th class="num">USD</th></tr></thead><tbody id="by-model"></tbody></table></div></section>
<section><h2>By client</h2><div class="scroll"><table><thead><tr><th>client</th><th class="num">req</th><th class="num">saved</th><th class="num">USD</th></tr></thead><tbody id="by-client"></tbody></table></div></section>
<section><h2>By project</h2><div class="scroll"><table><thead><tr><th>project</th><th class="num">req</th><th class="num">saved</th><th class="num">USD</th></tr></thead><tbody id="by-project"></tbody></table></div></section>
<section><h2>Runtime</h2><div class="tiles" id="runtime"></div></section>
<section><h2>Retrievable originals (CCR store)</h2><div class="tiles" id="ccr"></div></section>
<section class="wide"><h2>Live requests</h2><div class="scroll"><table><thead><tr><th>time</th><th>id</th><th>model</th><th>client</th><th class="num">status</th><th class="num">before</th><th class="num">after</th><th class="num">saved</th><th class="num">out</th><th class="num">ms</th><th>transforms</th></tr></thead><tbody id="requests"></tbody></table></div></section>
<section class="wide"><h2>Settings (hot knobs · loopback only)</h2><form class="settings" id="settings-form"></form><div style="margin-top:8px;display:flex;gap:8px"><button type="button" id="save">Save to settings.json</button><button type="button" class="secondary" id="reload">Reload</button></div><div id="settings-status" class="muted"></div></section>
</main>
<script>
(function(){
'use strict';
var $=function(id){return document.getElementById(id)};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function n(v){v=Number(v||0);if(v>=1e6)return (v/1e6).toFixed(2)+'M';if(v>=1e3)return (v/1e3).toFixed(1)+'k';return String(Math.round(v))}
function usd(v){return '$'+Number(v||0).toFixed(4)}
function pct(v){return v==null||!isFinite(v)?'—':Number(v).toFixed(1)+'%'}
function tile(l,v,cls){return '<div class="tile"><div class="v '+(cls||'')+'">'+v+'</div><div class="l">'+esc(l)+'</div></div>'}
function rows(id,map){var keys=Object.keys(map||{}).sort(function(a,b){return (map[b].tokensSaved||map[b].headlineTokensSaved||0)-(map[a].tokensSaved||map[a].headlineTokensSaved||0)});var h='';keys.forEach(function(k){var r=map[k];h+='<tr><td><code>'+esc(k)+'</code></td><td class="num">'+n(r.requests)+'</td><td class="num">'+n(r.headlineTokensSaved!=null?r.headlineTokensSaved:r.tokensSaved)+'</td><td class="num">'+usd(r.usdSaved)+'</td></tr>'});$(id).innerHTML=h||'<tr><td colspan="4" class="muted">no requests yet</td></tr>'}
async function get(u){var r=await fetch(u,{headers:{'accept':'application/json'}});if(!r.ok)throw new Error(u+' → '+r.status);return r.json()}
var lastSettings=null;
async function refresh(){
  try{
    var s=await get('/api/stats');var sv=await get('/api/savings');
    var m=s.metrics||{},t=m.tokens||{},c=s.config||{};
    $('meta').textContent='v'+s.version+' · pid '+s.pid+' · up '+Math.round(s.uptimeSeconds/60)+' min · mode '+(c.mode||'?')+' · profile '+(c.profile||'?')+(c.tokenAuth?' · token auth':'');
    var L=s.layers||{bound:[],missing:[]};$('layers').innerHTML=L.missing&&L.missing.length?'<span class="warn">fallback layers: '+esc(L.missing.join(', '))+'</span>':'<span class="ok">all layers live</span>';
    var life=(s.savings&&s.savings.lifetime)||{};var sess=(s.savings&&s.savings.session)||{};
    $('hero').innerHTML=tile('tokens saved (lifetime)',n(life.headlineTokensSaved),'ok')+tile('USD saved (lifetime)',usd(life.usdSaved),'ok')+tile('saved % (lifetime)',pct(life.savingsPercent))+tile('requests (lifetime)',n(life.requests))+tile('tokens saved (this session)',n(sess.headlineTokensSaved))+tile('USD saved (this session)',usd(sess.usdSaved))+tile('in-process saved %',pct(t.savingsPercent))+tile('cache read tokens',n(t.cacheRead))+tile('output tokens saved (est.)',n(t.outputSaved));
    var target=(c.savingsTarget||0)*100;var cur=life.savingsPercent||0;$('target').innerHTML='<div class="muted">target '+target.toFixed(0)+'% · current '+pct(cur)+'</div><div class="bar"><i style="width:'+Math.max(0,Math.min(100,cur))+'%"></i></div>';
    var w=sv.rollups||{};var h='';['today','7d','30d','all'].forEach(function(k){var r=w[k];if(!r)return;var before=r.tokensBefore||0;h+='<tr><td>'+esc(k)+'</td><td class="num">'+n(r.requests)+'</td><td class="num">'+n(r.tokensSaved)+'</td><td class="num">'+usd(r.usdSaved)+'</td><td class="num">'+pct(before>0?100*r.tokensSaved/before:null)+'</td></tr>'});$('windows').innerHTML=h||'<tr><td colspan="5" class="muted">no ledger events yet</td></tr>';
    var o=s.outputSavings||{};if(!o.nRequests){$('output').innerHTML='<span class="muted">not measured yet — enable VG_OUTPUT_SHAPER and set VG_OUTPUT_HOLDOUT (e.g. 0.1) to measure with a holdout.</span>'}else{var band=(o.bandIsCi?'95% CI ':'benchmark band ')+pct(o.ciLowPct)+' … '+pct(o.ciHighPct);$('output').innerHTML='<div class="tiles">'+tile('method',esc(o.kind))+tile('requests',n(o.nRequests))+tile('reduction',pct(o.pct))+tile('tokens saved',n(o.tokensSaved))+'</div><div class="muted" style="margin-top:8px">'+esc(band)+' · level L'+esc(o.level)+'</div>'}
    var all=(w.all)||{};rows('by-model',all.byModel&&Object.keys(all.byModel).length?all.byModel:(s.savings&&s.savings.byModel)||{});rows('by-client',all.byClient&&Object.keys(all.byClient).length?all.byClient:(s.savings&&s.savings.byClient)||{});rows('by-project',all.byProject&&Object.keys(all.byProject).length?all.byProject:(s.savings&&s.savings.byProject)||{});
    var r=m.requests||{},lat=m.latencyMs||{},ov=m.overheadMs||{};$('runtime').innerHTML=tile('requests',n(r.total))+tile('cached',n(r.cached))+tile('rate limited',n(r.rateLimited),r.rateLimited?'warn':'')+tile('budget denied',n(r.budgetDenied),r.budgetDenied?'warn':'')+tile('failed (5xx)',n(r.failed),r.failed?'bad':'')+tile('in flight',n(r.inboundActive))+tile('avg latency ms',n(lat.avg))+tile('avg overhead ms',n(ov.avg))+tile('sessions',n((s.sessions||{}).sessions))+tile('response cache',n((s.responseCache||{}).entries)+' / '+n((s.responseCache||{}).totalHits)+' hits')+tile('spend (est.)',usd((s.cost||{}).totalUsd));
    var st=s.ccrStore;$('ccr').innerHTML=st?Object.keys(st).sort().map(function(k){var v=st[k];return tile(k,typeof v==='number'?n(v):esc(String(v)))}).join(''):'<span class="muted">store not bound (fallback)</span>';
    var rq=s.recentRequests||[];var rh='';rq.forEach(function(x){var cls=x.status>=500?'bad':x.status>=400?'warn':'';rh+='<tr><td class="muted">'+esc((x.timestamp||'').slice(11,19))+'</td><td><code>'+esc(x.requestId)+'</code></td><td><code>'+esc(x.model)+'</code></td><td>'+esc(x.client)+'</td><td class="num '+cls+'">'+esc(x.status)+'</td><td class="num">'+n(x.inputTokensOriginal)+'</td><td class="num">'+n(x.inputTokensOptimized)+'</td><td class="num">'+n(x.tokensSaved+x.deferredTokens)+'</td><td class="num">'+n(x.outputTokens)+'</td><td class="num">'+n(x.totalMs)+'</td><td><code>'+esc((x.transforms||[]).slice(0,6).join(', '))+(x.transforms&&x.transforms.length>6?' …':'')+'</code></td></tr>'});$('requests').innerHTML=rh||'<tr><td colspan="11" class="muted">no requests yet — point an agent at it (vg install &lt;agent&gt; --compress)</td></tr>';
  }catch(e){$('meta').textContent='stats unavailable: '+e.message}
}
async function loadSettings(){
  try{
    var s=await get('/api/settings');lastSettings=s;var knobs=(s.knobs||[]).filter(function(k){return k.hot});var h='';
    knobs.forEach(function(k){var cur=s.effective&&s.effective[k.name]!=null?s.effective[k.name]:'';var stored=s.settings&&s.settings[k.name]!=null;var ctl;
      if(k.type==='bool'){ctl='<select name="'+esc(k.name)+'"><option value="">(default '+esc(k.default||'')+')</option><option value="true"'+(String(cur)==='true'?' selected':'')+'>true</option><option value="false"'+(String(cur)==='false'?' selected':'')+'>false</option></select>'}
      else if(k.type==='enum'){ctl='<select name="'+esc(k.name)+'"><option value="">(default '+esc(k.default||'')+')</option>'+(k.values||[]).map(function(v){return '<option value="'+esc(v)+'"'+(String(cur)===v?' selected':'')+'>'+esc(v)+'</option>'}).join('')+'</select>'}
      else{ctl='<input name="'+esc(k.name)+'" value="'+esc(stored?s.settings[k.name]:'')+'" placeholder="'+esc(cur||k.default||'')+'">'}
      h+='<label title="'+esc(k.description)+'">'+esc(k.name)+(stored?' <span class="ok">•</span>':'')+'</label><div>'+ctl+'</div>'});
    $('settings-form').innerHTML=h||'<span class="muted">settings are only editable from loopback</span>';$('settings-status').textContent='file: '+(s.path||'');
  }catch(e){$('settings-form').innerHTML='<span class="muted">settings unavailable ('+esc(e.message)+') — the editor is loopback-only</span>'}
}
async function save(){
  var values={};var form=$('settings-form');Array.prototype.forEach.call(form.querySelectorAll('input,select'),function(el){var v=el.value;var stored=lastSettings&&lastSettings.settings&&lastSettings.settings[el.name]!=null;if(v==='' ){if(stored)values[el.name]=null}else values[el.name]=v});
  try{var r=await fetch('/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({values:values})});var j=await r.json();
    if(!r.ok){$('settings-status').innerHTML='<span class="bad">'+esc(j.error||r.status)+'</span> '+esc(JSON.stringify(j.field_errors||j.unknown_keys||''));return}
    $('settings-status').innerHTML='<span class="ok">saved</span> changed: '+esc((j.changed_keys||[]).join(', ')||'nothing')+(j.needs_restart&&j.needs_restart.length?' · restart needed for: '+esc(j.needs_restart.join(', ')):'');loadSettings();refresh();
  }catch(e){$('settings-status').innerHTML='<span class="bad">'+esc(e.message)+'</span>'}
}
$('save').addEventListener('click',save);$('reload').addEventListener('click',loadSettings);
refresh();loadSettings();setInterval(refresh,5000);
})();
</script>
</body>
</html>`;
}
