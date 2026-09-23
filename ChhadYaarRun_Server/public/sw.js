/* Chhad Yaar Run - offline cache. AI files are cached on first visit, so the
   game loads fast afterwards and keeps working if the connection drops.
   Bump CACHE when you deploy a new version. */
const CACHE='chhad-yaar-run-v4';
const CORE=['./','index.html','manifest.webmanifest','icon-192.png','icon-512.png',
  'ai/vision_bundle.cjs','ai/vision_wasm_internal.js','ai/vision_wasm_internal.wasm','ai/pose_landmarker_lite.task'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const r=e.request; if(r.method!=='GET') return;
  const u=new URL(r.url); if(u.origin!==location.origin) return;
  const keep=res=>{ if(res&&res.ok){const cp=res.clone(); caches.open(CACHE).then(c=>c.put(r,cp));} return res; };
  if(u.pathname.includes('/ai/')){           // AI files never change: cache first
    e.respondWith(caches.match(r).then(hit=>hit||fetch(r).then(keep)));
    return;
  }
  e.respondWith(fetch(r).then(keep).catch(()=>caches.match(r,{ignoreSearch:true}).then(h=>h||caches.match('index.html'))));
});
