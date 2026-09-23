/* =====================================================================
   CHHAD YAAR RUN - server
   Serves the game, stores every entry, and issues voucher codes centrally
   so the rules hold across all devices at the activation.

   Endpoints
     GET  /                  the game (static files from ./public)
     POST /api/session       one finished run -> stores it, may issue a voucher
     GET  /admin             admin panel (needs the admin key)
     GET  /api/stats         numbers for the panel
     GET  /api/entries       last N entries
     GET  /api/export.xlsx   Excel of everything
     GET  /api/export.csv    same as CSV
     GET  /healthz           for Coolify's health check

   Everything is a single small Node process with one JSON file on disk.
   The game itself is unchanged static files - no extra load on it.
   ===================================================================== */
const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

const PORT      = process.env.PORT || 3000;
const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR= process.env.PUBLIC_DIR || path.join(__dirname, 'public');
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me';

/* ---- campaign rules (override with environment variables in Coolify) ---- */
const RULES = {
  minScoreConsult : +(process.env.MIN_SCORE_CONSULT || 5000), // 50% off cardiac consultation
  packagesForFull : +(process.env.PACKAGES_FOR_FULL || 3),    // all three golden hearts
  maxVouchersDay  : +(process.env.MAX_VOUCHERS_DAY  || 5),
  validTill       : process.env.VALID_TILL || '31 Oct 2026',
  pools: {
    consult: {prefix:'FHMHEART@OPD', from:1, to:+(process.env.OPD_CODES||50),
              label:'50% off Cardiac Consultation'},
    package: {prefix:'FHMHEART@PHC', from:1, to:+(process.env.PHC_CODES||30),
              label:'Complimentary Cardiac Package worth Rs. 999'}
  }
};
const pad2 = n => String(n).padStart(2,'0');
const codeList = p => { const a=[]; for(let i=p.from;i<=p.to;i++) a.push(p.prefix+' - '+pad2(i)); return a; };

/* ---- storage: one JSON file, written atomically ---- */
const DB_FILE = path.join(DATA_DIR, 'db.json');
let DB = {entries:[], issued:{consult:[], package:[]}};
function loadDB(){
  try{ fs.mkdirSync(DATA_DIR,{recursive:true});
       if(fs.existsSync(DB_FILE)) DB = JSON.parse(fs.readFileSync(DB_FILE,'utf8'));
  }catch(e){ console.error('DB load failed, starting empty:', e.message); }
  DB.entries = DB.entries||[]; DB.issued = DB.issued||{consult:[],package:[]};
}
let saveTimer=null, saving=false;
function saveDB(){
  if(saveTimer) return;                       // batch rapid writes
  saveTimer=setTimeout(()=>{
    saveTimer=null; if(saving) return; saving=true;
    const tmp=DB_FILE+'.tmp';
    try{ fs.writeFileSync(tmp, JSON.stringify(DB)); fs.renameSync(tmp, DB_FILE); }
    catch(e){ console.error('DB save failed:', e.message); }
    saving=false;
  }, 250);
}
const istDay = (d=new Date()) =>
  new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
const istTime = (d=new Date()) =>
  new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(d);
const digits = s => String(s||'').replace(/\D/g,'');

/* ---- the voucher rules, applied in one place ---- */
function decideVoucher(entry){
  const mob = digits(entry.mobile);
  if(mob.length < 10) return {voucher:null, reason:'A mobile number is needed to claim a voucher'};

  // one voucher per phone number, ever - but they may keep playing
  const already = DB.entries.find(e => digits(e.mobile)===mob && e.voucherCode);
  if(already) return {voucher:null, reason:'This number has already won a voucher', already:already.voucherCode};

  const today = istDay();
  const todayCount = DB.entries.filter(e => e.voucherCode && e.day===today).length;
  if(todayCount >= RULES.maxVouchersDay)
    return {voucher:null, reason:"Today's vouchers are all claimed - do come back tomorrow"};

  // which prize? the package (all three golden hearts) outranks the consultation
  let kind = null;
  if((entry.packs|0) >= RULES.packagesForFull)          kind='package';
  else if((entry.score|0) >= RULES.minScoreConsult)     kind='consult';
  if(!kind) return {voucher:null, reason:'Score '+RULES.minScoreConsult+'+ or all three golden hearts to win'};

  const pool = codeList(RULES.pools[kind]);
  const used = new Set(DB.issued[kind]);
  const code = pool.find(c => !used.has(c));
  if(!code) return {voucher:null, reason:'All '+RULES.pools[kind].label+' codes have been claimed'};

  DB.issued[kind].push(code);
  return {voucher:{kind, code, label:RULES.pools[kind].label, validTill:RULES.validTill}};
}

/* ---- request helpers ---- */
const send = (res,code,body,type='application/json')=>{
  const buf = Buffer.isBuffer(body)?body:Buffer.from(typeof body==='string'?body:JSON.stringify(body));
  res.writeHead(code,{'Content-Type':type,'Content-Length':buf.length,'Cache-Control':'no-store'});
  res.end(buf);
};
const readBody = req => new Promise((resolve,reject)=>{
  let n=0, chunks=[];
  req.on('data',c=>{ n+=c.length; if(n>64*1024){ reject(new Error('too large')); req.destroy(); } chunks.push(c); });
  req.on('end',()=>{ try{ resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}')); }catch(e){ reject(e); } });
  req.on('error',reject);
});
const authed = q => q.key === ADMIN_KEY;

/* ---- the table used for the panel and for Excel ---- */
const COLUMNS = [
  ['day','Date'],['time','Time'],['name','Name'],['mobile','Mobile'],
  ['age','Age group'],['checkup','Last check-up'],['consent','Consent to contact'],
  ['score','Score'],['heartPct','Heart %'],['packs','Golden hearts'],
  ['good','Good habits'],['hits','Hits'],['distance','Distance (m)'],
  ['voucherLabel','Voucher won'],['voucherCode','Voucher code'],
  ['device','Device'],['appVersion','App version']
];
const rows = () => DB.entries.map(e => COLUMNS.map(([k]) => e[k]===undefined?'':e[k]));

function csv(){
  const esc = v => '"'+String(v==null?'':v).replace(/"/g,'""')+'"';
  return [COLUMNS.map(c=>esc(c[1])).join(',')].concat(rows().map(r=>r.map(esc).join(','))).join('\r\n');
}
function xlsx(){
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  const aoa = [COLUMNS.map(c=>c[1])].concat(rows());
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = COLUMNS.map(c => ({wch: Math.max(10, c[1].length+2)}));
  ws['!autofilter'] = {ref: XLSX.utils.encode_range({s:{r:0,c:0},e:{r:aoa.length-1,c:COLUMNS.length-1}})};
  XLSX.utils.book_append_sheet(wb, ws, 'Entries');
  const vouchers = DB.entries.filter(e=>e.voucherCode)
    .map(e=>[e.day,e.time,e.name,e.mobile,e.voucherLabel,e.voucherCode,e.score,e.packs]);
  XLSX.utils.book_append_sheet(wb,
    XLSX.utils.aoa_to_sheet([['Date','Time','Name','Mobile','Voucher','Code','Score','Golden hearts']].concat(vouchers)),
    'Vouchers');
  return XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
}

function stats(){
  const today = istDay();
  const t = DB.entries.filter(e=>e.day===today);
  const used = k => DB.issued[k].length, total = k => codeList(RULES.pools[k]).length;
  return {
    today, rules: RULES,
    runsTotal: DB.entries.length, runsToday: t.length,
    playersToday: new Set(t.map(e=>digits(e.mobile)).filter(m=>m.length>=10)).size,
    consentedTotal: DB.entries.filter(e=>e.consent==='yes').length,
    vouchersToday: t.filter(e=>e.voucherCode).length,
    vouchersTotal: DB.entries.filter(e=>e.voucherCode).length,
    codes: {
      consult:{used:used('consult'), total:total('consult'), left:total('consult')-used('consult')},
      package:{used:used('package'), total:total('package'), left:total('package')-used('package')}
    },
    bestToday: t.reduce((m,e)=>Math.max(m,e.score|0),0)
  };
}

/* ---- static files ---- */
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript','.cjs':'text/javascript',
  '.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json',
  '.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.wasm':'application/wasm',
  '.task':'application/octet-stream','.ico':'image/x-icon','.md':'text/markdown; charset=utf-8'};
function serveStatic(req,res,pathname){
  let rel = decodeURIComponent(pathname.replace(/^\/+/,'')) || 'index.html';
  const file = path.join(PUBLIC_DIR, rel);
  if(!file.startsWith(PUBLIC_DIR)) return send(res,403,{error:'forbidden'});
  fs.stat(file,(err,st)=>{
    if(err||!st.isFile()){
      if(rel!=='index.html') return serveStatic(req,res,'/index.html');
      return send(res,404,{error:'not found'});
    }
    const ext = path.extname(file).toLowerCase();
    const long = /\.(wasm|task|cjs|png|webmanifest)$/.test(ext);
    res.writeHead(200,{'Content-Type':MIME[ext]||'application/octet-stream','Content-Length':st.size,
      'Cache-Control': long?'public, max-age=604800':'no-cache'});
    fs.createReadStream(file).pipe(res);
  });
}

/* ---- server ---- */
loadDB();
http.createServer(async (req,res)=>{
  const u = url.parse(req.url,true), q = u.query, p = u.pathname;
  res.setHeader('X-Content-Type-Options','nosniff');

  if(p==='/healthz') return send(res,200,{ok:true, entries:DB.entries.length});

  if(p==='/api/session' && req.method==='POST'){
    let b; try{ b = await readBody(req); }catch(e){ return send(res,400,{error:'bad request'}); }
    const now = new Date();
    const entry = {
      id: now.getTime().toString(36)+Math.random().toString(36).slice(2,7),
      day: istDay(now), time: istTime(now), iso: now.toISOString(),
      name: String(b.name||'').slice(0,80),
      mobile: digits(b.mobile).slice(0,15),
      age: String(b.age||'').slice(0,20),
      checkup: String(b.checkup||'').slice(0,30),
      consent: b.consent ? 'yes' : 'no',
      score: b.score|0, heartPct: b.heartPct|0, packs: b.packs|0,
      good: b.good|0, hits: b.hits|0, distance: b.distance|0,
      device: String(b.device||'').slice(0,120), appVersion: String(b.appVersion||'').slice(0,20),
      voucherLabel:'', voucherCode:''
    };
    const out = decideVoucher(entry);
    if(out.voucher){ entry.voucherLabel = out.voucher.label; entry.voucherCode = out.voucher.code; }
    DB.entries.push(entry); saveDB();
    return send(res,200,{ok:true, id:entry.id, voucher:out.voucher||null,
                         reason:out.reason||'', already:out.already||''});
  }

  if(p==='/admin')            return serveAdmin(res);
  if(p==='/api/stats')        return authed(q)?send(res,200,stats()):send(res,401,{error:'bad key'});
  if(p==='/api/entries')      return authed(q)
      ? send(res,200,{columns:COLUMNS.map(c=>c[1]), rows:rows().slice(-(+q.n||100)).reverse()})
      : send(res,401,{error:'bad key'});
  if(p==='/api/export.csv')   return authed(q)
      ? send(res,200,'\ufeff'+csv(),'text/csv; charset=utf-8') : send(res,401,{error:'bad key'});
  if(p==='/api/export.xlsx'){
    if(!authed(q)) return send(res,401,{error:'bad key'});
    try{
      const buf = xlsx();
      res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition':'attachment; filename="chhad-yaar-run_'+istDay()+'.xlsx"','Content-Length':buf.length});
      return res.end(buf);
    }catch(e){ return send(res,500,{error:'excel failed: '+e.message}); }
  }

  if(req.method!=='GET') return send(res,405,{error:'method not allowed'});
  serveStatic(req,res,p);
}).listen(PORT, ()=>console.log('Chhad Yaar Run server on :'+PORT+'  data:'+DATA_DIR));

/* ---- admin panel (one page, no build step) ---- */
function serveAdmin(res){
  send(res,200,`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Chhad Yaar Run - Admin</title>
<style>
:root{--g:#0CA854;--r:#E83035;--ink:#12362A;--line:#D7E8DE}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 Helvetica,Arial,sans-serif;background:#F3FBF6;color:var(--ink)}
header{background:#fff;border-bottom:2px solid var(--line);padding:14px 20px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
h1{font-size:18px;margin:0}.sp{flex:1}
input,button{font:inherit;padding:9px 12px;border-radius:9px;border:1.5px solid var(--line);background:#fff}
button{background:var(--g);color:#fff;border-color:var(--g);cursor:pointer}button.alt{background:#fff;color:var(--ink)}
main{padding:20px;max-width:1200px;margin:0 auto}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:18px}
.card{background:#fff;border:1.5px solid var(--line);border-radius:14px;padding:14px}
.card b{display:block;font-size:26px}.card span{font-size:12px;letter-spacing:.08em;color:#6B8579;font-weight:700}
table{width:100%;border-collapse:collapse;background:#fff;border:1.5px solid var(--line);border-radius:14px;overflow:hidden}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--line);font-size:13px;white-space:nowrap}
th{background:#EAF7F0;font-size:11px;letter-spacing:.06em}
tr:has(td.win){background:#F2FBF6}td.win{color:var(--g);font-weight:700}
.note{color:#6B8579;font-size:13px;margin:10px 0}
</style></head><body>
<header><h1>Chhad Yaar Run — Admin</h1><div class="sp"></div>
<input id="key" type="password" placeholder="Admin key" style="width:190px">
<button onclick="save()">Open</button>
<button class="alt" onclick="dl('xlsx')">Excel</button>
<button class="alt" onclick="dl('csv')">CSV</button></header>
<main>
<div class="cards" id="cards"></div>
<div class="note" id="note"></div>
<div style="overflow:auto"><table id="tbl"></table></div>
</main>
<script>
const K=()=>localStorage.getItem('cyr-admin')||'';
function save(){localStorage.setItem('cyr-admin',document.getElementById('key').value.trim());load();}
function dl(kind){location.href='/api/export.'+kind+'?key='+encodeURIComponent(K());}
function card(v,l){return '<div class="card"><b>'+v+'</b><span>'+l+'</span></div>';}
async function load(){
  const key=K(); if(!key) return;
  document.getElementById('key').value=key;
  try{
    const s=await (await fetch('/api/stats?key='+encodeURIComponent(key))).json();
    if(s.error){document.getElementById('note').textContent='Wrong admin key.';return;}
    document.getElementById('cards').innerHTML=
      card(s.runsToday,'RUNS TODAY')+card(s.playersToday,'PLAYERS TODAY')+card(s.bestToday,'BEST SCORE TODAY')+
      card(s.vouchersToday+' / '+s.rules.maxVouchersDay,'VOUCHERS TODAY')+
      card(s.codes.consult.left,'CONSULT CODES LEFT')+card(s.codes.package.left,'PACKAGE CODES LEFT')+
      card(s.runsTotal,'RUNS TOTAL')+card(s.consentedTotal,'CONSENTED');
    document.getElementById('note').textContent=
      'Voucher rules: score '+s.rules.minScoreConsult+'+ = 50% off consultation · all '+s.rules.packagesForFull+
      ' golden hearts = complimentary package · one voucher per phone number · max '+s.rules.maxVouchersDay+
      ' per day · valid till '+s.rules.validTill+'.';
    const e=await (await fetch('/api/entries?key='+encodeURIComponent(key)+'&n=200')).json();
    document.getElementById('tbl').innerHTML='<tr>'+e.columns.map(c=>'<th>'+c+'</th>').join('')+'</tr>'+
      e.rows.map(r=>'<tr>'+r.map((v,i)=>'<td'+((i===14&&v)?' class="win"':'')+'>'+String(v).replace(/[<>&]/g,'')+'</td>').join('')+'</tr>').join('');
  }catch(err){document.getElementById('note').textContent='Could not reach the server.';}
}
load(); setInterval(load,15000);
</script></body></html>`,'text/html; charset=utf-8');
}
