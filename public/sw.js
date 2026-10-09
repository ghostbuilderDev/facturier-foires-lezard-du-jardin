const CACHE='ldj-facturier-v1.5.1.1.5-logo';
const SHELL=['./','./index.html','./client.html','./manifest.webmanifest','./icon.svg','./logo-ldj.png','./affiche_facture_ldj.pdf'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;const u=new URL(e.request.url);if(u.origin!==location.origin)return;e.respondWith(caches.match(e.request).then(cached=>{const fresh=fetch(e.request).then(r=>{if(r&&r.ok)caches.open(CACHE).then(c=>c.put(e.request,r.clone()));return r}).catch(()=>cached);return cached||fresh}))});
