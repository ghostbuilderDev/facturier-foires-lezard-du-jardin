import './styles.css'
import QRCode from 'qrcode'
import bundledCatalog from './catalogue.json'
import { supabase } from './supabase.js'
import { createInvoicePdf } from './invoicePdf.js'

const app = document.querySelector('#app')
const BRAND = 'Lézard du Jardin'
const PUBLIC_APP_URL = String(import.meta.env.VITE_PUBLIC_APP_URL || '').trim()
const LDJ_COMPANY_DEFAULTS = {
  trade_name:'Lézard du Jardin',
  legal_name:'LEZARD DU JARDIN',
  address:'12 rue de la Brande',
  postal_code:'17240', city:'Champagnolles', country:'France',
  siren:'902726165', siret:'90272616500019', vat_number:'FR05902726165',
  email:'sasulezarddujardin@gmail.com', invoice_email:'sasulezarddujardin@gmail.com',
  phone:'06 50 81 37 14', invoice_prefix:'LDJ', default_vat_rate:20,
  payment_terms:'Paiement comptant à la vente. Aucun escompte pour paiement anticipé.',
  legal_footer:'LEZARD DU JARDIN — SASU — SIREN 902 726 165 — SIRET 902 726 165 00019 — RCS Saintes 902 726 165 — TVA FR05 902 726 165 — Siège social : 12 rue de la Brande, 17240 Champagnolles, France — sasulezarddujardin@gmail.com — 06 50 81 37 14'
}

function isLoopbackHost(hostname){
  return ['127.0.0.1','localhost','::1'].includes(String(hostname||'').toLowerCase())
}
function getPublicAppBase(){
  if(PUBLIC_APP_URL){
    const u = new URL(PUBLIC_APP_URL)
    u.search = ''; u.hash = ''
    if(!u.pathname.endsWith('/')) u.pathname += '/'
    return u.toString()
  }
  if(!isLoopbackHost(location.hostname)){
    return new URL('./', location.href).toString()
  }
  throw new Error('Le QR client ne peut pas utiliser 127.0.0.1. Configure VITE_PUBLIC_APP_URL avec l’adresse publique GitHub Pages (recommandé) ou, pour un test sur le même Wi-Fi, avec l’adresse réseau affichée par Vite.')
}
function buildClientUrl(token){
  const url = new URL('client.html', getPublicAppBase())
  url.searchParams.set('t', token)
  return url
}
function buildPermanentClientUrl(){
  const url = new URL('client.html', getPublicAppBase())
  const code = state.company?.public_intake_code || 'c9c1626a-06be-4e17-9c84-4ca10753f10a'
  url.searchParams.set('public',code)
  return url
}
const state = {
  session:null, user:null, company:null, role:null, tab:'sale', saleMode:'quick',
  products:[], serverProducts:[], events:[], draft:null,
  intake:null, intakeTimer:null, pendingTimer:null, searchQuery:'', category:'', lastPdf:null
}
const money = n => `${Number(n||0).toFixed(2).replace('.',',')} €`
const localDateISO = (d=new Date()) => d.toLocaleDateString('sv-SE')
const timeFr = value => value ? new Date(value).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}) : ''
const uid = () => crypto.randomUUID()
const escapeHtml = s => String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c]))
const norm = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim()
const bundledProducts = bundledCatalog.map(p=>({
  ...p, id:`ldj-${p.product_id}`, source_product_id:String(p.product_id), is_bundled:true,
  image:p.image || ''
}))

// Après l'installation de cette version de remise à zéro, ne pas réutiliser
// un ancien panier de test sur le téléphone. Ne touche pas à la connexion.
try {
  if (localStorage.getItem('ldj_logo_reset_v15') !== 'done') {
    localStorage.removeItem('ldj_invoice_draft')
    localStorage.setItem('ldj_logo_reset_v15', 'done')
  }
} catch (_) {}

const blankCustomer = () => ({customer_type:'individual',first_name:'',last_name:'',company_name:'',siren:'',vat_number:'',address:'',postal_code:'',city:'',country:'France',email:'',phone:'',delivery_same:true,delivery_address:'',delivery_postal_code:'',delivery_city:''})
const savedPref = (k,def='') => localStorage.getItem('ldj_'+k) || def
const blankDraft = () => ({
  customer:blankCustomer(), lines:[], event_id:savedPref('last_event'),
  payment_method:savedPref('last_payment','Carte bancaire'), delivery_mode:savedPref('last_delivery','Emporté sur la foire'), notes:''
})

if ('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register(new URL('./sw.js', location.href).href).catch(()=>{}))
window.addEventListener('online', updateOnlineBadge)
window.addEventListener('offline', updateOnlineBadge)

async function boot(){
  const {data:{session}}=await supabase.auth.getSession(); state.session=session; state.user=session?.user||null
  supabase.auth.onAuthStateChange((_e,s)=>{state.session=s;state.user=s?.user||null;route()})
  route()
}
async function route(){
  clearIntakeWatch()
  if(!state.user){renderAuth();return}
  const {data,error}=await supabase.from('company_members').select('company_id,role,company:companies(*)').eq('user_id',state.user.id).limit(1).maybeSingle()
  if(error && error.code!=='PGRST116') console.error(error)
  if(!data){renderBootstrap();return}
  state.company=data.company; state.role=data.role
  await applyLdJCompanyDefaults()
  await Promise.all([loadProducts(),loadEvents()])
  state.draft=loadDraft()
  if(state.draft.event_id && !state.events.some(e=>e.id===state.draft.event_id)) state.draft.event_id=''
  renderShell(); navigate(state.tab)
}
async function applyLdJCompanyDefaults(){
  if(!state.company || !['owner','admin'].includes(state.role))return
  const patch={}
  for(const [key,value] of Object.entries(LDJ_COMPANY_DEFAULTS)){
    const cur=state.company[key]
    if(cur===null || cur===undefined || String(cur).trim()==='') patch[key]=value
  }
  // Correctif v1.5.1 : remplace uniquement l'ancienne adresse erronée,
  // sans toucher à une éventuelle autre adresse définie volontairement.
  const isLdJ = /l[eé]zard du jardin/i.test(`${state.company.trade_name||''} ${state.company.name||''}`)
  if(isLdJ){
    const oldMail='contact@lezarddujardin.fr'
    const correctMail='sasulezarddujardin@gmail.com'
    if(String(state.company.email||'').trim().toLowerCase()===oldMail) patch.email=correctMail
    if(!String(state.company.invoice_email||'').trim()) patch.invoice_email=correctMail
    if(String(state.company.legal_footer||'').includes(oldMail))
      patch.legal_footer=String(state.company.legal_footer).replaceAll(oldMail,correctMail)
  }
  if(!Object.keys(patch).length)return
  const {data,error}=await supabase.from('companies').update(patch).eq('id',state.company.id).select().single()
  if(error) console.warn('Mise à jour adresse facturation :',error.message)
  if(!error && data) state.company=data
}

function renderAuth(){
  app.innerHTML=`<div class="auth-wrap"><div class="auth-card">
    <div class="brand"><div class="brand-mark">LDJ</div><div><h1>Facturier Foires</h1><p>${BRAND}</p></div></div>
    <p class="muted">Connexion vendeur. Le catalogue des 389 produits est intégré dans l'application et reste disponible même avec un réseau faible.</p>
    <form id="login" class="grid"><label>E-mail<input required name="email" type="email" autocomplete="email"></label><label>Mot de passe<input required name="password" type="password" minlength="6" autocomplete="current-password"></label><div class="actions"><button class="btn btn-primary">Se connecter</button><button type="button" id="signup" class="btn btn-secondary">Créer mon premier compte</button></div></form><div id="auth-msg" class="footer-note"></div>
  </div></div>`
  const setMsg=t=>document.querySelector('#auth-msg').textContent=t
  document.querySelector('#login').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);const {error}=await supabase.auth.signInWithPassword({email:f.get('email'),password:f.get('password')});setMsg(error?error.message:'Connexion…')}
  document.querySelector('#signup').onclick=async()=>{const f=new FormData(document.querySelector('#login'));const email=f.get('email'),password=f.get('password');if(!email||!password)return setMsg('Renseigne e-mail et mot de passe.');const {error}=await supabase.auth.signUp({email,password});setMsg(error?error.message:'Compte créé. Reconnecte-toi après confirmation si elle est activée.')}
}
function renderBootstrap(){
  app.innerHTML=`<div class="bootstrap-wrap"><div class="bootstrap-card"><div class="brand"><div class="brand-mark">LDJ</div><div><h1>Créer l'espace entreprise</h1><p>Première configuration</p></div></div><p>Les mentions légales exactes seront complétées dans Réglages avant la première facture réelle.</p><form id="bootstrap" class="grid"><label>Nom commercial<input name="name" value="${BRAND}" required></label><button class="btn btn-primary">Créer l'espace</button></form></div></div>`
  document.querySelector('#bootstrap').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);const {error}=await supabase.rpc('create_company',{p_name:f.get('name')});if(error)return alert(error.message);route()}
}
function renderShell(){
  app.innerHTML=`<div class="shell"><aside class="sidebar"><div class="brand"><div class="brand-mark">LDJ</div><div><h1>Facturier</h1><p>${escapeHtml(state.company.trade_name||state.company.name||BRAND)}</p></div></div><nav class="nav">
    <button data-tab="sale">＋ Vente foire</button><button data-tab="day">▦ Suivi journée</button><button data-tab="invoices">▤ Factures</button><button data-tab="products">⌕ Catalogue</button><button data-tab="events">⌖ Foires</button><button data-tab="settings">⚙ Réglages</button>
  </nav><div class="side-bottom"><div id="net-badge"></div><br>${escapeHtml(state.user.email||'')}<br><button id="logout" class="btn btn-secondary" style="margin-top:10px">Déconnexion</button></div></aside>
  <main class="main"><header class="topbar"><div><h2 id="page-title">Facturier Foires</h2><span id="mobile-net" class="small muted"></span></div><span class="badge">${state.products.length} produits</span></header><section class="content" id="content"></section></main></div>
  <nav class="mobile-nav"><button data-tab="sale">＋<span>Vente</span></button><button data-tab="day">▦<span>Journée</span></button><button data-tab="invoices">▤<span>Factures</span></button><button data-tab="products">⌕<span>Produits</span></button><button data-tab="events">⌖<span>Foires</span></button></nav>`
  document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{if(b.dataset.tab==='sale')state.saleMode='quick';navigate(b.dataset.tab)})
  document.querySelector('#logout').onclick=()=>supabase.auth.signOut()
  updateOnlineBadge()
}
function updateOnlineBadge(){
  const online=navigator.onLine
  const html=online?'<span class="badge ok">● En ligne</span>':'<span class="badge offline">● Hors connexion</span>'
  const d=document.querySelector('#net-badge'); if(d)d.innerHTML=html
  const m=document.querySelector('#mobile-net'); if(m)m.textContent=online?'En ligne':'Hors connexion — catalogue + brouillon disponibles'
}
function navigate(tab){
  state.tab=tab; clearIntakeWatch(); clearPendingWatch(); document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab))
  const titles={sale:'Vente foire',day:'Suivi de la journée',invoices:'Factures',products:'Catalogue produits',events:'Foires & événements',settings:'Réglages entreprise'}
  const t=document.querySelector('#page-title');if(t)t.textContent=titles[tab]||'Facturier'
  ;({sale:renderSale,day:renderDaySales,invoices:renderInvoices,products:renderProducts,events:renderEvents,settings:renderSettings}[tab]||renderSale)()
}
async function loadProducts(){
  let remote=[]
  try{const {data}=await supabase.from('products').select('*').eq('company_id',state.company.id).eq('is_active',true).order('name');remote=data||[]}catch{}
  state.serverProducts=remote.map(p=>({...p,source_product_id:null,qr_payload:'',category:'Articles libres',image:'',is_bundled:false}))
  state.products=[...bundledProducts,...state.serverProducts]
}
async function loadEvents(){const {data}=await supabase.from('events').select('*').eq('company_id',state.company.id).order('starts_on',{ascending:false});state.events=data||[]}
function loadDraft(){try{return {...blankDraft(),...JSON.parse(localStorage.getItem('ldj_invoice_draft')||'{}')}}catch{return blankDraft()}}
function saveDraft(){localStorage.setItem('ldj_invoice_draft',JSON.stringify(state.draft))}
function draftTotals(){let ttc=0,ht=0;for(const l of state.draft.lines){const q=Number(l.quantity||0),p=Number(l.unit_price_ttc||0),d=Number(l.discount_percent||0),v=Number(l.vat_rate||0);const lt=q*p*(1-d/100);ttc+=lt;ht+=lt/(1+v/100)}return{ttc,ht,vat:ttc-ht}}

function renderSale(){
  return state.saleMode==='invoice' ? renderInvoiceSale() : renderQuickSale()
}
function renderQuickSale(){
  const d=state.draft,t=draftTotals()
  document.querySelector('#content').innerHTML=`
  <div class="fair-hero card"><div><div class="eyebrow">VENTE RAPIDE</div><h3>Scanner → enregistrer → client suivant</h3><p class="muted">Aucune facture ni coordonnées client ne sont nécessaires pour une vente rapide.</p></div><div class="fair-actions"><button id="scan-product" class="btn btn-scan">▣ Scanner QR produit</button><button id="find-product" class="btn btn-primary">⌕ Rechercher un produit</button><button id="free-line" class="btn btn-secondary">＋ Article libre</button></div></div>
  <div class="grid grid-2 sale-grid">
    <div class="card"><div class="card-head"><h3>1. Vente</h3><span class="badge">Express</span></div><div class="form-grid"><label>Foire<select id="event"><option value="">— Sans événement —</option>${state.events.map(e=>`<option value="${e.id}" ${d.event_id===e.id?'selected':''}>${escapeHtml(e.name)}</option>`).join('')}</select></label><label>Règlement<select id="payment">${['Carte bancaire','Espèces','Chèque','Virement','PayPal','Paiement en plusieurs fois','Autre'].map(x=>`<option ${d.payment_method===x?'selected':''}>${x}</option>`).join('')}</select></label><label class="full">Note facultative<input id="notes" value="${escapeHtml(d.notes)}" placeholder="couleur, livraison, remarque…"></label></div></div>
    <div class="card"><div class="card-head"><h3>Factures demandées</h3><span class="badge">Optionnel</span></div><p class="muted small">Les clients qui ont scanné l'affiche peuvent remplir leurs coordonnées pendant qu'ils attendent.</p><div class="actions"><button id="pending-clients" class="btn btn-secondary">Clients en attente <span id="pending-count" class="badge">0</span></button><button id="permanent-qr" class="btn btn-secondary">QR affiche permanent</button><button id="invoice-mode" class="btn btn-gold">Le client veut une facture</button></div></div>
  </div>
  <div class="card basket-card"><div class="card-head"><div><h3>2. Articles</h3><span class="small muted" id="basket-count"></span></div><button id="clear-lines" class="btn btn-danger">Vider les articles</button></div><div id="lines"></div><div class="totals"><div class="total-row"><span>Total HT</span><strong id="total-ht">${money(t.ht)}</strong></div><div class="total-row"><span>TVA</span><strong id="total-vat">${money(t.vat)}</strong></div><div class="total-row grand"><span>Total TTC</span><span id="total-ttc">${money(t.ttc)}</span></div></div></div>
  <div class="card finalize-card"><div class="notice"><strong>Enregistrer la vente</strong><br><span class="small">Enregistre les articles, l'heure, le règlement et le montant dans le suivi de la journée. Aucun PDF ni e-mail n'est généré.</span></div><div class="actions"><button id="record-quick" class="btn btn-primary btn-final">✓ Enregistrer la vente</button><button id="clear-draft" class="btn btn-danger">Annuler / vider</button></div><div id="quick-msg"></div></div>`
  renderLines();bindQuickSale();startPendingWatch()
}
function bindQuickSale(){
  ;['event','payment','notes'].forEach(id=>{const el=document.querySelector('#'+id);el.oninput=()=>{const key={event:'event_id',payment:'payment_method',notes:'notes'}[id];state.draft[key]=el.value;if(id==='event')localStorage.setItem('ldj_last_event',el.value);if(id==='payment')localStorage.setItem('ldj_last_payment',el.value);saveDraft()}})
  document.querySelector('#scan-product').onclick=openScanner
  document.querySelector('#find-product').onclick=openProductFinder
  document.querySelector('#free-line').onclick=()=>{state.draft.lines.push({id:uid(),description:'Article libre',quantity:1,unit_price_ttc:'',vat_rate:Number(state.company.default_vat_rate||20),discount_percent:0,sku:'',source_product_id:null,image:''});saveDraft();renderLines()}
  document.querySelector('#pending-clients').onclick=openPendingPosterClients
  document.querySelector('#permanent-qr').onclick=showPermanentInvoiceQr
  document.querySelector('#invoice-mode').onclick=()=>{state.saleMode='invoice';renderInvoiceSale()}
  document.querySelector('#clear-lines').onclick=()=>{if(confirm('Vider tous les articles du panier ?')){state.draft.lines=[];saveDraft();renderLines()}}
  document.querySelector('#clear-draft').onclick=()=>{if(confirm('Annuler la vente en cours et vider le panier ?')){const keep={event_id:state.draft.event_id,payment_method:state.draft.payment_method,delivery_mode:state.draft.delivery_mode};state.draft={...blankDraft(),...keep};saveDraft();renderQuickSale()}}
  document.querySelector('#record-quick').onclick=recordQuickSale
}
async function recordQuickSale(){
  const btn=document.querySelector('#record-quick'),msg=document.querySelector('#quick-msg')
  const goodLines=state.draft.lines.filter(l=>l.description&&Number(l.quantity)>0&&Number(l.unit_price_ttc)>=0)
  if(!goodLines.length){msg.innerHTML='<div class="notice error">Scanne au moins un article avant d’enregistrer la vente.</div>';return}
  if(!navigator.onLine){msg.innerHTML='<div class="notice error">Connexion nécessaire pour enregistrer la vente dans le journal. Le panier reste mémorisé.</div>';return}
  btn.disabled=true;btn.textContent='Enregistrement…'
  try{
    const payload=goodLines.map((l,position)=>({position,sku:l.sku||null,source_product_id:l.source_product_id?String(l.source_product_id):null,catalogue_number:l.catalogue_number?Number(l.catalogue_number):null,category:l.category||null,description:l.description,quantity:Number(l.quantity),unit_price_ttc:Number(l.unit_price_ttc),vat_rate:Number(l.vat_rate),discount_percent:Number(l.discount_percent||0)}))
    const {data:saleId,error}=await supabase.rpc('record_quick_sale',{p_event_id:state.draft.event_id||null,p_payment_method:state.draft.payment_method||null,p_notes:state.draft.notes||null,p_sale_date:localDateISO(),p_lines:payload})
    if(error)throw error
    const total=draftTotals().ttc
    const keep={event_id:state.draft.event_id,payment_method:state.draft.payment_method,delivery_mode:state.draft.delivery_mode}
    state.draft={...blankDraft(),...keep};saveDraft();renderQuickSale();flash(`✓ Vente ${money(total)} enregistrée`)
  }catch(e){msg.innerHTML=`<div class="notice error">${escapeHtml(e.message||e)}<br><span class="small">Si la fonction n'existe pas, exécute la migration 005 v1.4 dans Supabase.</span></div>`;btn.disabled=false;btn.textContent='✓ Enregistrer la vente'}
}

function renderInvoiceSale(){
  const d=state.draft,c=d.customer,t=draftTotals()
  document.querySelector('#content').innerHTML=`
  <div class="fair-hero card"><div><div class="eyebrow">FACTURE CLIENT</div><h3>Facture uniquement si le client la demande</h3><p class="muted">Le panier en cours est conservé. Associe les coordonnées du client puis génère la facture.</p></div><div class="fair-actions"><button id="back-quick" class="btn btn-secondary">← Vente rapide</button><button id="scan-product" class="btn btn-scan">▣ Scanner QR produit</button><button id="find-product" class="btn btn-primary">⌕ Rechercher un produit</button><button id="free-line" class="btn btn-secondary">＋ Article libre</button></div></div>
  <div class="grid grid-2 sale-grid">
    <div class="card customer-card"><div class="card-head"><h3>1. Client</h3><span class="badge">QR anti-erreur</span></div><div class="customer-quick"><button id="new-qr" class="btn btn-gold">Afficher le QR client</button><button id="pending-clients" class="btn btn-secondary">Clients en attente <span id="pending-count" class="badge">0</span></button><button id="permanent-qr" class="btn btn-secondary">QR affiche permanent</button><span id="qr-status" class="small muted">Le client saisit lui-même ses coordonnées.</span></div><div id="qr-box" class="qr-box compact hidden"></div><details><summary>Saisie / vérification manuelle</summary><div class="form-grid" id="customer-form">
      <label>Type<select data-c="customer_type"><option value="individual" ${c.customer_type==='individual'?'selected':''}>Particulier</option><option value="company" ${c.customer_type==='company'?'selected':''}>Entreprise</option></select></label><label>Société<input data-c="company_name" value="${escapeHtml(c.company_name)}"></label><label>Prénom<input data-c="first_name" value="${escapeHtml(c.first_name)}"></label><label>Nom<input data-c="last_name" value="${escapeHtml(c.last_name)}"></label><label class="full">Adresse<input data-c="address" value="${escapeHtml(c.address)}"></label><label>Code postal<input data-c="postal_code" value="${escapeHtml(c.postal_code)}"></label><label>Ville<input data-c="city" value="${escapeHtml(c.city)}"></label><label>E-mail<input data-c="email" type="email" value="${escapeHtml(c.email)}"></label><label>Téléphone<input data-c="phone" value="${escapeHtml(c.phone)}"></label><label>SIREN client pro<input data-c="siren" value="${escapeHtml(c.siren)}"></label><label>TVA intracom. client pro<input data-c="vat_number" value="${escapeHtml(c.vat_number||'')}"></label><label>Pays<input data-c="country" value="${escapeHtml(c.country||'France')}"></label>
    </div></details></div>
    <div class="card"><div class="card-head"><h3>2. Vente</h3><span class="badge">Brouillon auto</span></div><div class="form-grid"><label>Foire<select id="event"><option value="">— Sans événement —</option>${state.events.map(e=>`<option value="${e.id}" ${d.event_id===e.id?'selected':''}>${escapeHtml(e.name)}</option>`).join('')}</select></label><label>Règlement<select id="payment">${['Carte bancaire','Espèces','Chèque','Virement','PayPal','Paiement en plusieurs fois','Autre'].map(x=>`<option ${d.payment_method===x?'selected':''}>${x}</option>`).join('')}</select></label><label>Remise / livraison<select id="delivery">${['Emporté sur la foire','Livraison à domicile','Retrait ultérieur'].map(x=>`<option ${d.delivery_mode===x?'selected':''}>${x}</option>`).join('')}</select></label><label>Note<input id="notes" value="${escapeHtml(d.notes)}" placeholder="couleur, livraison, montage…"></label></div></div>
  </div>
  <div class="card basket-card"><div class="card-head"><div><h3>3. Panier</h3><span class="small muted" id="basket-count"></span></div><button id="clear-lines" class="btn btn-danger">Vider les articles</button></div><div id="lines"></div><div class="totals"><div class="total-row"><span>Total HT</span><strong id="total-ht">${money(t.ht)}</strong></div><div class="total-row"><span>TVA</span><strong id="total-vat">${money(t.vat)}</strong></div><div class="total-row grand"><span>Total TTC</span><span id="total-ttc">${money(t.ttc)}</span></div></div></div>
  <div class="card finalize-card"><div class="notice"><strong>Validation définitive</strong><br><span class="small">Le numéro est attribué sur le serveur. Le PDF est archivé puis envoyé au client avec copie entreprise.</span></div><div class="actions"><button id="finalize" class="btn btn-primary btn-final">✓ Facturer et envoyer</button><button id="clear-draft" class="btn btn-danger">Nouvelle vente / effacer</button></div><div id="final-msg"></div></div>`
  renderLines();bindSale();startPendingWatch()
}
function bindSale(){
  const backQuick=document.querySelector('#back-quick');if(backQuick)backQuick.onclick=()=>{state.saleMode='quick';renderQuickSale()}
  document.querySelectorAll('[data-c]').forEach(i=>i.oninput=()=>{state.draft.customer[i.dataset.c]=i.value;saveDraft()})
  ;['event','payment','delivery','notes'].forEach(id=>{const el=document.querySelector('#'+id);el.oninput=()=>{const key={event:'event_id',payment:'payment_method',delivery:'delivery_mode',notes:'notes'}[id];state.draft[key]=el.value;if(id==='event')localStorage.setItem('ldj_last_event',el.value);if(id==='payment')localStorage.setItem('ldj_last_payment',el.value);if(id==='delivery')localStorage.setItem('ldj_last_delivery',el.value);saveDraft()}})
  document.querySelector('#scan-product').onclick=openScanner
  document.querySelector('#find-product').onclick=openProductFinder
  document.querySelector('#free-line').onclick=()=>{state.draft.lines.push({id:uid(),description:'Article libre',quantity:1,unit_price_ttc:'',vat_rate:Number(state.company.default_vat_rate||20),discount_percent:0,sku:'',source_product_id:null,image:''});saveDraft();renderLines()}
  document.querySelector('#new-qr').onclick=createIntakeQr
  document.querySelector('#pending-clients').onclick=openPendingPosterClients
  document.querySelector('#permanent-qr').onclick=showPermanentInvoiceQr
  document.querySelector('#clear-lines').onclick=()=>{if(confirm('Vider tous les articles du panier ?')){state.draft.lines=[];saveDraft();renderLines()}}
  document.querySelector('#clear-draft').onclick=()=>{if(confirm('Démarrer une nouvelle vente et effacer le brouillon en cours ?')){state.draft=blankDraft();saveDraft();renderSale()}}
  document.querySelector('#finalize').onclick=finalizeSale
}
function addProduct(product){
  const existing=state.draft.lines.find(l=>l.source_product_id && String(l.source_product_id)===String(product.source_product_id))
  if(existing){existing.quantity=Number(existing.quantity||0)+1}
  else state.draft.lines.push({id:uid(),source_product_id:product.source_product_id||null,catalogue_number:product.catalogue_number||null,qr_payload:product.qr_payload||'',sku:product.sku||'',description:product.name,quantity:1,unit_price_ttc:Number(product.price_ttc),vat_rate:Number(product.vat_rate||20),discount_percent:0,image:product.image||'',category:product.category||''})
  saveDraft();renderLines();flash(`✓ ${product.name}`)
}
function renderLines(){
  const box=document.querySelector('#lines');if(!box)return
  if(!state.draft.lines.length){box.innerHTML='<div class="empty basket-empty">Scanne un QR produit ou utilise la recherche.</div>'}
  else box.innerHTML=state.draft.lines.map(l=>`<div class="basket-line" data-line="${l.id}">${l.image?`<img src="${escapeHtml(l.image)}" alt="">`:'<div class="product-placeholder">LDJ</div>'}<div class="basket-main"><div class="basket-name">${escapeHtml(l.description)}</div><div class="small muted">${escapeHtml(l.sku||'Article libre')}${l.category?` · ${escapeHtml(l.category)}`:''}</div><div class="basket-edit"><label>Qté<input data-f="quantity" type="number" min="0.01" step="1" value="${l.quantity}"></label><label>PU TTC<input data-f="unit_price_ttc" type="number" min="0" step="0.01" value="${l.unit_price_ttc}"></label><label>Remise %<input data-f="discount_percent" type="number" min="0" max="100" step="1" value="${l.discount_percent||0}"></label><label>TVA<select data-f="vat_rate">${[20,10,5.5,0].map(v=>`<option value="${v}" ${Number(l.vat_rate)===v?'selected':''}>${v}%</option>`).join('')}</select></label></div>${!l.source_product_id?`<label class="free-description">Désignation<input data-f="description" value="${escapeHtml(l.description)}"></label>`:''}</div><div class="basket-side"><strong>${money(Number(l.quantity||0)*Number(l.unit_price_ttc||0)*(1-Number(l.discount_percent||0)/100))}</strong><div class="qty-buttons"><button data-minus="${l.id}">−</button><button data-plus="${l.id}">＋</button></div><button class="btn btn-danger mini" data-remove="${l.id}">×</button></div></div>`).join('')
  box.querySelectorAll('[data-line]').forEach(row=>row.querySelectorAll('[data-f]').forEach(inp=>inp.oninput=()=>{const line=state.draft.lines.find(x=>x.id===row.dataset.line);line[inp.dataset.f]=inp.value;saveDraft();refreshTotals()}))
  box.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{state.draft.lines=state.draft.lines.filter(l=>l.id!==b.dataset.remove);saveDraft();renderLines()})
  box.querySelectorAll('[data-plus]').forEach(b=>b.onclick=()=>{const l=state.draft.lines.find(x=>x.id===b.dataset.plus);l.quantity=Number(l.quantity||0)+1;saveDraft();renderLines()})
  box.querySelectorAll('[data-minus]').forEach(b=>b.onclick=()=>{const l=state.draft.lines.find(x=>x.id===b.dataset.minus);l.quantity=Math.max(1,Number(l.quantity||1)-1);saveDraft();renderLines()})
  const cnt=document.querySelector('#basket-count');if(cnt)cnt.textContent=`${state.draft.lines.reduce((s,l)=>s+Number(l.quantity||0),0)} article(s)`
  refreshTotals()
}
function refreshTotals(){const t=draftTotals();['ht','vat','ttc'].forEach(k=>{const el=document.querySelector('#total-'+k);if(el)el.textContent=money(t[k])});document.querySelectorAll('.basket-line').forEach(row=>{const l=state.draft.lines.find(x=>x.id===row.dataset.line);const strong=row.querySelector('.basket-side strong');if(strong)strong.textContent=money(Number(l.quantity||0)*Number(l.unit_price_ttc||0)*(1-Number(l.discount_percent||0)/100))})}
function flash(text){let el=document.querySelector('#flash');if(!el){el=document.createElement('div');el.id='flash';el.className='flash';document.body.appendChild(el)}el.textContent=text;el.classList.add('show');navigator.vibrate?.(60);clearTimeout(el._t);el._t=setTimeout(()=>el.classList.remove('show'),1500)}

function productMatches(q,p){const n=norm(q);if(!n)return true;return [p.name,p.sku,p.category,p.catalogue_number,p.product_id].some(v=>norm(v).includes(n))}
function openProductFinder(){
  const cats=[...new Set(bundledProducts.map(p=>p.category))].sort((a,b)=>a.localeCompare(b,'fr'))
  const modal=makeModal(`<div class="finder"><div class="modal-head"><h3>Rechercher un produit</h3><button data-close class="modal-close">×</button></div><div class="finder-tools"><input id="finder-q" autofocus placeholder="Nom, référence LDJ, n° catalogue…"><select id="finder-cat"><option value="">Toutes les catégories</option>${cats.map(c=>`<option>${escapeHtml(c)}</option>`).join('')}</select></div><div id="finder-results" class="product-grid"></div></div>`)
  const q=modal.querySelector('#finder-q'),cat=modal.querySelector('#finder-cat'),results=modal.querySelector('#finder-results')
  const draw=()=>{const arr=state.products.filter(p=>productMatches(q.value,p)&&(!cat.value||p.category===cat.value)).slice(0,80);results.innerHTML=arr.map(p=>`<button class="product-card" data-prod="${escapeHtml(String(p.source_product_id||p.id))}" data-bundled="${p.is_bundled?'1':'0'}">${p.image?`<img loading="lazy" src="${escapeHtml(p.image)}" alt="">`:'<div class="product-placeholder">LDJ</div>'}<span class="product-card-body"><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.sku||'')} · ${escapeHtml(p.category||'')}</small><b>${money(p.price_ttc)}</b></span></button>`).join('')||'<div class="empty">Aucun produit trouvé.</div>';results.querySelectorAll('[data-prod]').forEach(b=>b.onclick=()=>{const p=b.dataset.bundled==='1'?state.products.find(x=>x.is_bundled&&String(x.source_product_id)===b.dataset.prod):state.products.find(x=>!x.is_bundled&&String(x.id)===b.dataset.prod);if(p){addProduct(p);modal.remove()}})}
  q.oninput=draw;cat.onchange=draw;draw();q.focus()
}
function makeModal(html){const wrap=document.createElement('div');wrap.className='modal-backdrop';wrap.innerHTML=`<div class="modal-card">${html}</div>`;document.body.appendChild(wrap);wrap.querySelectorAll('[data-close]').forEach(x=>x.onclick=()=>wrap.remove());wrap.onclick=e=>{if(e.target===wrap)wrap.remove()};return wrap}
async function openScanner(){
  const modal=makeModal(`<div class="scanner"><div class="modal-head"><h3>Scanner un QR produit</h3><button data-close class="modal-close">×</button></div><div class="scanner-frame"><video id="scan-video" autoplay playsinline muted></video><div class="scan-target"></div></div><p id="scan-msg" class="muted">Présente le QR Lézard du Jardin dans le cadre.</p><div class="manual-scan"><input id="manual-code" placeholder="Ou saisir LDJ:P:1234"><button id="manual-add" class="btn btn-secondary">Ajouter</button></div></div>`)
  const video=modal.querySelector('#scan-video'),msg=modal.querySelector('#scan-msg');let stream=null,stopped=false
  const cleanup=()=>{stopped=true;stream?.getTracks().forEach(t=>t.stop())}
  const oldRemove=modal.remove.bind(modal);modal.remove=()=>{cleanup();oldRemove()}
  modal.querySelector('[data-close]').onclick=()=>modal.remove()
  const handle=code=>{const p=state.products.find(x=>x.qr_payload===code || String(x.source_product_id)===String(code).replace(/^LDJ:P:/i,''));if(!p){msg.textContent=`QR non reconnu : ${code}`;return false}addProduct(p);modal.remove();return true}
  modal.querySelector('#manual-add').onclick=()=>handle(modal.querySelector('#manual-code').value.trim())
  try{
    if(!('BarcodeDetector' in window))throw new Error('Lecteur QR natif non disponible sur ce navigateur. Utilise la saisie du code ou la recherche produit.')
    const detector=new BarcodeDetector({formats:['qr_code']})
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false});video.srcObject=stream
    const loop=async()=>{if(stopped)return;try{const codes=await detector.detect(video);if(codes?.length&&handle(codes[0].rawValue))return}catch{}requestAnimationFrame(loop)};video.onloadeddata=()=>loop()
  }catch(e){msg.textContent=e.message||String(e);modal.querySelector('.scanner-frame').classList.add('scanner-disabled')}
}

async function createIntakeQr(){
  if(!navigator.onLine)return alert('Le QR client nécessite une connexion. Les coordonnées peuvent être saisies manuellement hors ligne.')
  let publicBase
  try{publicBase=getPublicAppBase()}catch(e){return alert(e.message||String(e))}
  clearIntakeWatch();const expires=new Date(Date.now()+2*60*60*1000).toISOString()
  const {data,error}=await supabase.from('intake_sessions').insert({company_id:state.company.id,event_id:state.draft.event_id||null,created_by:state.user.id,expires_at:expires}).select().single();if(error)return alert(error.message)
  state.intake=data;const url=buildClientUrl(data.token)
  const box=document.querySelector('#qr-box');box.classList.remove('hidden');box.innerHTML=`<canvas id="qr"></canvas><div class="small muted">Le client scanne puis valide.</div><div class="small muted" style="margin-top:6px">Formulaire sécurisé Lézard du Jardin</div>`
  await QRCode.toCanvas(document.querySelector('#qr'),url.toString(),{width:220,margin:1,errorCorrectionLevel:'M'});document.querySelector('#qr-status').innerHTML='<span class="badge warn pulse">En attente du client…</span>';watchIntake(data.id)
}
async function showPermanentInvoiceQr(){
  let url
  try{url=buildPermanentClientUrl()}catch(e){return alert(e.message||String(e))}
  const modal=document.createElement('div');modal.className='modal-backdrop';modal.innerHTML=`<div class="modal-card" style="max-width:560px"><div class="modal-head"><h3>QR permanent — obtenir sa facture</h3><button class="modal-close" data-close>×</button></div><div class="qr-box"><canvas id="permanent-qr-canvas"></canvas><div class="small muted">QR permanent à imprimer sur l'affiche Lézard du Jardin.</div><a class="btn btn-primary" href="./affiche_facture_ldj.pdf" target="_blank" rel="noopener">Ouvrir l'affiche A4</a></div></div>`;document.body.appendChild(modal);modal.querySelector('[data-close]').onclick=()=>modal.remove();await QRCode.toCanvas(modal.querySelector('#permanent-qr-canvas'),url.toString(),{width:260,margin:1,errorCorrectionLevel:'M'})
}
function clearPendingWatch(){if(state.pendingTimer)clearInterval(state.pendingTimer);state.pendingTimer=null}
async function refreshPendingClientCount(){
  const badge=document.querySelector('#pending-count');if(!badge)return
  const since=new Date(Date.now()-24*60*60*1000).toISOString()
  const {count,error}=await supabase.from('intake_sessions').select('id',{count:'exact',head:true}).eq('company_id',state.company.id).eq('status','submitted').eq('source','poster').gte('submitted_at',since)
  if(!error)badge.textContent=String(count||0)
}
function startPendingWatch(){clearPendingWatch();refreshPendingClientCount();state.pendingTimer=setInterval(refreshPendingClientCount,5000)}
async function openPendingPosterClients(){
  const since=new Date(Date.now()-24*60*60*1000).toISOString()
  const {data,error}=await supabase.from('intake_sessions').select('id,customer_json,submitted_at').eq('company_id',state.company.id).eq('status','submitted').eq('source','poster').gte('submitted_at',since).order('submitted_at',{ascending:true}).limit(50)
  if(error)return alert('Active d’abord la migration 004 v1.3 dans Supabase : '+error.message)
  const rows=data||[];const modal=document.createElement('div');modal.className='modal-backdrop';modal.innerHTML=`<div class="modal-card" style="max-width:720px"><div class="modal-head"><h3>Clients en attente (${rows.length})</h3><button class="modal-close" data-close>×</button></div><p class="muted small">Les clients peuvent remplir le QR permanent pendant qu'ils attendent. Choisis simplement le bon nom pour la vente en cours.</p>${rows.length?rows.map(r=>{const c=r.customer_json||{},name=c.company_name||`${c.first_name||''} ${c.last_name||''}`.trim()||'Client';return `<div class="notice pending-client" style="margin-bottom:10px"><div><strong>${escapeHtml(name)}</strong> <span class="badge">${escapeHtml(timeFr(r.submitted_at))}</span><br><span class="small">${escapeHtml(c.email||'')} ${c.phone?'· '+escapeHtml(c.phone):''}<br>${escapeHtml([c.address,c.postal_code,c.city].filter(Boolean).join(', '))}</span></div><div class="actions" style="margin-top:8px"><button class="btn btn-primary mini" data-use="${r.id}">Utiliser pour cette vente</button></div></div>`}).join(''):'<div class="empty">Aucun client en attente.</div>'}</div>`;document.body.appendChild(modal);modal.querySelector('[data-close]').onclick=()=>modal.remove();modal.querySelectorAll('[data-use]').forEach(b=>b.onclick=async()=>{
    const row=rows.find(r=>r.id===b.dataset.use);if(!row)return
    b.disabled=true;b.textContent='Association…'
    const {data:claimed,error:claimError}=await supabase.from('intake_sessions').update({status:'used',used_at:new Date().toISOString(),used_by:state.user.id}).eq('id',row.id).eq('status','submitted').select('id').maybeSingle()
    if(claimError||!claimed){alert('Ce client vient déjà d’être utilisé sur un autre appareil.');modal.remove();refreshPendingClientCount();return}
    state.draft.customer={...blankCustomer(),...(row.customer_json||{})};saveDraft();modal.remove();refreshPendingClientCount();state.saleMode='invoice';renderInvoiceSale();flash('✓ Client associé à la facture')
  })
}
function clearIntakeWatch(){if(state.intakeTimer)clearInterval(state.intakeTimer);state.intakeTimer=null;if(state.intake?.channel)supabase.removeChannel(state.intake.channel);state.intake=null}
function watchIntake(id){const handle=async row=>{if(row.status==='submitted'&&row.customer_json){state.draft.customer={...blankCustomer(),...row.customer_json};saveDraft();const s=document.querySelector('#qr-status');if(s)s.innerHTML='<span class="badge ok">✓ Coordonnées reçues</span>';fillCustomerInputs();clearIntakeWatch();flash('✓ Coordonnées client reçues')}};const channel=supabase.channel('intake-'+id).on('postgres_changes',{event:'UPDATE',schema:'public',table:'intake_sessions',filter:`id=eq.${id}`},p=>handle(p.new)).subscribe();if(state.intake)state.intake.channel=channel;state.intakeTimer=setInterval(async()=>{const {data}=await supabase.from('intake_sessions').select('status,customer_json').eq('id',id).maybeSingle();if(data)handle(data)},3000)}
function fillCustomerInputs(){document.querySelectorAll('[data-c]').forEach(i=>{i.value=state.draft.customer[i.dataset.c]??''})}

async function finalizeSale(){
  let finalized=null
  const msg=document.querySelector('#final-msg'),btn=document.querySelector('#finalize');msg.innerHTML=''
  if(!navigator.onLine)return msg.innerHTML='<div class="notice error">Connexion nécessaire pour attribuer le numéro définitif et envoyer le PDF.</div>'
  const c=state.draft.customer,validName=c.customer_type==='company'?(c.company_name||c.last_name):(c.first_name&&c.last_name)
  if(!validName||!c.email||!c.address||!c.postal_code||!c.city)return msg.innerHTML='<div class="notice error">Coordonnées client incomplètes : identité, adresse, code postal, ville et e-mail sont nécessaires.</div>'
  const goodLines=state.draft.lines.filter(l=>l.description&&Number(l.quantity)>0&&Number(l.unit_price_ttc)>=0);if(!goodLines.length)return msg.innerHTML='<div class="notice error">Ajoute au moins un article.</div>'
  btn.disabled=true;btn.textContent='Création de la facture…'
  try{
    const {data:inv,error:ierr}=await supabase.from('invoices').insert({company_id:state.company.id,created_by:state.user.id,event_id:state.draft.event_id||null,customer_json:c,sale_date:localDateISO(),payment_method:state.draft.payment_method,delivery_mode:state.draft.delivery_mode,notes:state.draft.notes,status:'draft'}).select().single();if(ierr)throw ierr
    const payload=goodLines.map((l,position)=>({invoice_id:inv.id,position,sku:l.sku||null,source_product_id:l.source_product_id?String(l.source_product_id):null,catalogue_number:l.catalogue_number?Number(l.catalogue_number):null,category:l.category||null,description:l.description,quantity:Number(l.quantity),unit_price_ttc:Number(l.unit_price_ttc),vat_rate:Number(l.vat_rate),discount_percent:Number(l.discount_percent||0)}));const {error:lerr}=await supabase.from('invoice_lines').insert(payload);if(lerr)throw lerr
    const {data:number,error:ferr}=await supabase.rpc('finalize_invoice',{p_invoice_id:inv.id});if(ferr)throw ferr
    finalized={id:inv.id,number}; const keep={event_id:state.draft.event_id,payment_method:state.draft.payment_method,delivery_mode:state.draft.delivery_mode}; state.draft={...blankDraft(),...keep}; saveDraft()
    btn.textContent='Génération du PDF…';const {data:full,error:rerr}=await supabase.from('invoices').select('*').eq('id',inv.id).single();if(rerr)throw rerr;const {data:lines}=await supabase.from('invoice_lines').select('*').eq('invoice_id',inv.id).order('position')
    const blob=await createInvoicePdf({invoice:full,company:state.company,lines:lines||[]});const year=new Date(full.issued_at).getFullYear(),path=`${state.company.id}/${year}/${full.number}-${full.id}.pdf`;const {error:uerr}=await supabase.storage.from('invoices').upload(path,blob,{contentType:'application/pdf',upsert:false});if(uerr)throw uerr;const {error:aerr}=await supabase.rpc('attach_invoice_pdf',{p_invoice_id:inv.id,p_path:path});if(aerr)throw aerr
    btn.textContent='Envoi par e-mail…';const {error:eerr}=await supabase.functions.invoke('send-invoice',{body:{invoice_id:inv.id}});const dl=URL.createObjectURL(blob);state.lastPdf={blob,number:full.number,url:dl}
    msg.innerHTML=`<div class="notice success"><strong>✓ ${escapeHtml(number)}</strong><br>PDF archivé${eerr?' — e-mail à relancer':' — envoyé au client + copie entreprise'}.<div class="actions result-actions"><a class="btn btn-secondary" href="${dl}" download="${escapeHtml(full.number)}.pdf">Télécharger PDF</a><button class="btn btn-secondary" id="share-pdf">Partager</button><button class="btn btn-primary" id="next-sale">Nouvelle vente</button></div>${eerr?`<div class="small">Erreur e-mail : ${escapeHtml(eerr.message)}</div>`:''}</div>`
    document.querySelector('#next-sale').onclick=()=>{state.saleMode='quick';renderQuickSale()};document.querySelector('#share-pdf').onclick=shareLastPdf
  }catch(err){msg.innerHTML=finalized?`<div class="notice error"><strong>⚠ ${escapeHtml(finalized.number)} a bien été numérotée.</strong><br>L'étape PDF / envoi a échoué : ${escapeHtml(err.message||err)}<br><strong>Ne refacture pas la vente.</strong> Ouvre l'onglet Factures et utilise "Réparer PDF".</div>`:`<div class="notice error"><strong>Erreur :</strong> ${escapeHtml(err.message||err)}</div>`}finally{btn.disabled=false;btn.textContent='✓ Facturer et envoyer'}
}
async function shareLastPdf(){if(!state.lastPdf)return;try{const file=new File([state.lastPdf.blob],`${state.lastPdf.number}.pdf`,{type:'application/pdf'});if(navigator.share&&navigator.canShare?.({files:[file]}))await navigator.share({files:[file],title:`Facture ${state.lastPdf.number}`});else window.open(state.lastPdf.url,'_blank')}catch(e){if(e.name!=='AbortError')alert(e.message)}}

function csvCell(value){const s=String(value??'');return `"${s.replace(/"/g,'""')}"`}
function downloadDayCsv(date,records,detail){
  const header=['Date','Heure','Type','N° facture','Référence','Produit','Qté','PU TTC','Remise %','Total TTC','TVA %','Règlement']
  const rows=detail.map(d=>[date,timeFr(d.time),d.type,d.number||'',d.sku||'',d.description,Number(d.quantity||0),Number(d.unit_price_ttc||0).toFixed(2).replace('.',','),Number(d.discount_percent||0).toFixed(0),Number(d.total_ttc||0).toFixed(2).replace('.',','),Number(d.vat_rate||0).toString().replace('.',','),d.payment_method||''])
  const content='\ufeff'+[header,...rows].map(r=>r.map(csvCell).join(';')).join('\r\n')
  const blob=new Blob([content],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`ventes_ldj_${date}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
}
async function fetchInvoiceLines(ids){
  if(!ids.length)return []
  const all=[];const pageSize=1000
  for(let from=0;;from+=pageSize){const {data,error}=await supabase.from('invoice_lines').select('invoice_id,position,sku,source_product_id,catalogue_number,category,description,quantity,unit_price_ttc,vat_rate,discount_percent').in('invoice_id',ids).order('invoice_id').order('position').range(from,from+pageSize-1);if(error)throw error;const chunk=data||[];all.push(...chunk);if(chunk.length<pageSize)break}
  return all
}
async function fetchQuickSaleLines(ids){
  if(!ids.length)return []
  const all=[];const pageSize=1000
  for(let from=0;;from+=pageSize){const {data,error}=await supabase.from('sale_lines').select('sale_id,position,sku,source_product_id,catalogue_number,category,description,quantity,unit_price_ttc,vat_rate,discount_percent').in('sale_id',ids).order('sale_id').order('position').range(from,from+pageSize-1);if(error)throw error;const chunk=data||[];all.push(...chunk);if(chunk.length<pageSize)break}
  return all
}
async function renderDaySales(selectedDate=localDateISO(),selectedEvent=''){
  const box=document.querySelector('#content');box.innerHTML='<div class="card"><h3>Suivi de la journée</h3><div class="empty">Calcul des ventes…</div></div>'
  let iq=supabase.from('invoices').select('id,number,issued_at,sale_date,total_ht,total_vat,total_ttc,event_id,payment_method').eq('company_id',state.company.id).eq('status','final').eq('sale_date',selectedDate).order('issued_at',{ascending:true})
  let sq=supabase.from('sales').select('id,sold_at,sale_date,total_ht,total_vat,total_ttc,event_id,payment_method,status').eq('company_id',state.company.id).eq('status','recorded').eq('sale_date',selectedDate).order('sold_at',{ascending:true})
  if(selectedEvent){iq=iq.eq('event_id',selectedEvent);sq=sq.eq('event_id',selectedEvent)}
  const [ir,sr]=await Promise.all([iq,sq])
  if(ir.error){box.innerHTML=`<div class="notice error">${escapeHtml(ir.error.message)}</div>`;return}
  if(sr.error){box.innerHTML=`<div class="notice error">${escapeHtml(sr.error.message)}<br><span class="small">Exécute la migration 005 v1.4 dans Supabase.</span></div>`;return}
  const invs=ir.data||[],sales=sr.data||[]
  let invoiceLines=[],saleLines=[]
  try{[invoiceLines,saleLines]=await Promise.all([fetchInvoiceLines(invs.map(i=>i.id)),fetchQuickSaleLines(sales.map(i=>i.id))])}catch(e){box.innerHTML=`<div class="notice error">${escapeHtml(e.message||e)}</div>`;return}
  const records=[...sales.map(x=>({id:x.id,type:'Vente rapide',number:'',time:x.sold_at,...x})),...invs.map(x=>({id:x.id,type:'Facture',time:x.issued_at,...x}))].sort((a,b)=>new Date(a.time)-new Date(b.time))
  const totalTtc=records.reduce((s,i)=>s+Number(i.total_ttc||0),0),totalHt=records.reduce((s,i)=>s+Number(i.total_ht||0),0),totalVat=records.reduce((s,i)=>s+Number(i.total_vat||0),0)
  const invBy=Object.fromEntries(invs.map(i=>[i.id,i])),saleBy=Object.fromEntries(sales.map(i=>[i.id,i]))
  const detail=[]
  for(const l of saleLines){const r=saleBy[l.sale_id]||{},lineTotal=Number(l.quantity||0)*Number(l.unit_price_ttc||0)*(1-Number(l.discount_percent||0)/100);detail.push({...l,type:'Vente rapide',number:'',time:r.sold_at,payment_method:r.payment_method,total_ttc:lineTotal})}
  for(const l of invoiceLines){const r=invBy[l.invoice_id]||{},lineTotal=Number(l.quantity||0)*Number(l.unit_price_ttc||0)*(1-Number(l.discount_percent||0)/100);detail.push({...l,type:'Facture',number:r.number,time:r.issued_at,payment_method:r.payment_method,total_ttc:lineTotal})}
  detail.sort((a,b)=>new Date(a.time)-new Date(b.time))
  const qty=detail.reduce((s,l)=>s+Number(l.quantity||0),0)
  const products=new Map();for(const l of detail){const key=l.source_product_id||l.sku||l.description;const cur=products.get(key)||{sku:l.sku||'',name:l.description,qty:0,total:0};cur.qty+=Number(l.quantity||0);cur.total+=Number(l.total_ttc||0);products.set(key,cur)}
  const productRows=[...products.values()].sort((a,b)=>b.total-a.total)
  const payments=new Map();for(const r of records){const k=r.payment_method||'Non renseigné';payments.set(k,(payments.get(k)||0)+Number(r.total_ttc||0))}
  box.innerHTML=`
    <div class="card day-toolbar"><div><h3>Suivi des ventes</h3><p class="muted small">Ventes rapides + factures demandées, réunies dans le même total.</p></div><div class="day-filters"><label>Date<input id="day-date" type="date" value="${escapeHtml(selectedDate)}"></label><label>Foire<select id="day-event"><option value="">Toutes</option>${state.events.map(e=>`<option value="${e.id}" ${selectedEvent===e.id?'selected':''}>${escapeHtml(e.name)}</option>`).join('')}</select></label><button id="today-sales" class="btn btn-secondary">Aujourd'hui</button><button id="export-sales" class="btn btn-primary" ${records.length?'':'disabled'}>Exporter CSV</button></div></div>
    <div class="kpis day-kpis"><div class="kpi"><strong>${records.length}</strong><span>ventes</span></div><div class="kpi"><strong>${sales.length}</strong><span>ventes rapides</span></div><div class="kpi"><strong>${invs.length}</strong><span>factures</span></div><div class="kpi"><strong>${qty.toLocaleString('fr-FR')}</strong><span>articles vendus</span></div><div class="kpi"><strong>${money(totalTtc)}</strong><span>CA TTC</span></div><div class="kpi"><strong>${money(records.length?totalTtc/records.length:0)}</strong><span>panier moyen</span></div></div>
    <div class="grid grid-2" style="margin-top:18px"><div class="card"><div class="card-head"><h3>Articles vendus</h3><span class="badge">${productRows.length} référence(s)</span></div>${productRows.length?`<div class="table-wrap"><table class="day-table"><thead><tr><th>Réf.</th><th>Article</th><th>Qté</th><th>CA TTC</th></tr></thead><tbody>${productRows.map(p=>`<tr><td>${escapeHtml(p.sku||'—')}</td><td>${escapeHtml(p.name)}</td><td><strong>${p.qty.toLocaleString('fr-FR')}</strong></td><td><strong>${money(p.total)}</strong></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">Aucune vente sur cette journée.</div>'}</div>
    <div class="card"><div class="card-head"><h3>Répartition règlements</h3></div>${payments.size?`<div class="payment-list">${[...payments.entries()].sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<div class="payment-row"><span>${escapeHtml(k)}</span><strong>${money(v)}</strong></div>`).join('')}</div>`:'<div class="empty">Aucun règlement.</div>'}<div class="notice" style="margin-top:14px"><strong>Totaux</strong><br><span class="small">HT ${money(totalHt)} · TVA ${money(totalVat)} · TTC ${money(totalTtc)}</span></div></div></div>
    <div class="card" style="margin-top:18px"><div class="card-head"><h3>Détail chronologique</h3><span class="badge">${detail.length} ligne(s)</span></div>${detail.length?`<div class="table-wrap"><table><thead><tr><th>Heure</th><th>Type</th><th>N°</th><th>Produit</th><th>Qté</th><th>PU TTC</th><th>Total TTC</th><th>Règlement</th></tr></thead><tbody>${detail.map(l=>`<tr><td>${escapeHtml(timeFr(l.time))}</td><td>${escapeHtml(l.type)}</td><td>${escapeHtml(l.number||'—')}</td><td><strong>${escapeHtml(l.description)}</strong>${l.sku?`<br><span class="small muted">${escapeHtml(l.sku)}</span>`:''}</td><td>${Number(l.quantity||0).toLocaleString('fr-FR')}</td><td>${money(l.unit_price_ttc)}</td><td><strong>${money(l.total_ttc)}</strong></td><td>${escapeHtml(l.payment_method||'')}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">Aucune vente.</div>'}</div>`
  const dateEl=box.querySelector('#day-date'),eventEl=box.querySelector('#day-event');dateEl.onchange=()=>renderDaySales(dateEl.value,eventEl.value);eventEl.onchange=()=>renderDaySales(dateEl.value,eventEl.value);box.querySelector('#today-sales').onclick=()=>renderDaySales(localDateISO(),eventEl.value);box.querySelector('#export-sales').onclick=()=>downloadDayCsv(selectedDate,records,detail)
}

async function renderInvoices(){
  const box=document.querySelector('#content');box.innerHTML='<div class="card"><h3>Factures</h3><div class="empty">Chargement…</div></div>'
  const {data,error}=await supabase.from('invoices').select('id,number,issued_at,total_ttc,status,customer_json,pdf_path,emailed_at,event_id,payment_method').eq('company_id',state.company.id).eq('status','final').order('issued_at',{ascending:false}).limit(250);if(error){box.innerHTML=`<div class="notice error">${escapeHtml(error.message)}</div>`;return}
  const rows=data||[],today=new Date().toLocaleDateString('sv-SE'),todayRows=rows.filter(r=>new Date(r.issued_at).toLocaleDateString('sv-SE')===today),ca=todayRows.reduce((s,r)=>s+Number(r.total_ttc||0),0)
  box.innerHTML=`<div class="kpis"><div class="kpi"><strong>${todayRows.length}</strong><span>factures aujourd'hui</span></div><div class="kpi"><strong>${money(ca)}</strong><span>CA facturé aujourd'hui</span></div><div class="kpi"><strong>${money(todayRows.length?ca/todayRows.length:0)}</strong><span>panier moyen</span></div></div><div class="card" style="margin-top:18px"><div class="card-head"><h3>Historique</h3><span class="badge">${rows.length}</span></div><div class="table-wrap"><table><thead><tr><th>N°</th><th>Date</th><th>Client</th><th>Règlement</th><th>Total TTC</th><th>E-mail</th><th></th></tr></thead><tbody>${rows.map(r=>`<tr><td><strong>${escapeHtml(r.number)}</strong></td><td>${new Date(r.issued_at).toLocaleDateString('fr-FR')}</td><td>${escapeHtml(r.customer_json?.company_name||`${r.customer_json?.first_name||''} ${r.customer_json?.last_name||''}`)}</td><td>${escapeHtml(r.payment_method||'')}</td><td>${money(r.total_ttc)}</td><td>${r.emailed_at?'<span class="badge ok">Envoyé</span>':'<span class="badge warn">À relancer</span>'}</td><td>${r.pdf_path?`<button class="btn btn-secondary mini" data-open="${r.id}">PDF</button> <button class="btn btn-secondary mini" data-resend="${r.id}">Renvoyer</button>`:`<button class="btn btn-gold mini" data-repair="${r.id}">Réparer PDF</button>`}</td></tr>`).join('')}</tbody></table></div></div>`
  box.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openInvoicePdf(b.dataset.open));box.querySelectorAll('[data-resend]').forEach(b=>b.onclick=async()=>{b.disabled=true;b.textContent='…';const {error}=await supabase.functions.invoke('send-invoice',{body:{invoice_id:b.dataset.resend}});alert(error?error.message:'Facture renvoyée.');renderInvoices()});box.querySelectorAll('[data-repair]').forEach(b=>b.onclick=()=>repairInvoicePdf(b.dataset.repair,b))
}
async function openInvoicePdf(id){const {data:inv}=await supabase.from('invoices').select('pdf_path').eq('id',id).single();if(!inv?.pdf_path)return;const {data,error}=await supabase.storage.from('invoices').createSignedUrl(inv.pdf_path,60);if(error)return alert(error.message);window.open(data.signedUrl,'_blank','noopener')}
async function repairInvoicePdf(id,button){
  button.disabled=true;button.textContent='Réparation…'
  try{const {data:inv,error}=await supabase.from('invoices').select('*').eq('id',id).single();if(error)throw error;const {data:lines,error:lerr}=await supabase.from('invoice_lines').select('*').eq('invoice_id',id).order('position');if(lerr)throw lerr;const blob=await createInvoicePdf({invoice:inv,company:state.company,lines:lines||[]});const year=new Date(inv.issued_at).getFullYear(),path=`${state.company.id}/${year}/${inv.number}-${inv.id}.pdf`;const {error:uerr}=await supabase.storage.from('invoices').upload(path,blob,{contentType:'application/pdf',upsert:false});if(uerr && !String(uerr.message||'').toLowerCase().includes('already'))throw uerr;const {error:aerr}=await supabase.rpc('attach_invoice_pdf',{p_invoice_id:id,p_path:path});if(aerr)throw aerr;const {error:eerr}=await supabase.functions.invoke('send-invoice',{body:{invoice_id:id}});alert(eerr?'PDF réparé. Envoi e-mail à relancer : '+eerr.message:'PDF réparé et facture envoyée.');renderInvoices()}catch(e){alert('Réparation impossible : '+(e.message||e));button.disabled=false;button.textContent='Réparer PDF'}
}

function renderProducts(){
  const box=document.querySelector('#content');const cats=[...new Set(bundledProducts.map(p=>p.category))].sort((a,b)=>a.localeCompare(b,'fr'))
  box.innerHTML=`<div class="catalog-toolbar card"><div><h3>Catalogue Lézard du Jardin</h3><p class="muted small">${bundledProducts.length} produits intégrés · recherche disponible hors connexion</p></div><div class="finder-tools"><input id="catalog-q" placeholder="Rechercher nom, réf., n°…"><select id="catalog-cat"><option value="">Toutes les catégories</option>${cats.map(c=>`<option>${escapeHtml(c)}</option>`).join('')}</select></div></div><div id="catalog-grid" class="product-grid catalogue-page"></div><div class="card" style="margin-top:18px"><details><summary>Ajouter un article hors catalogue</summary><form id="product-form" class="form-grid detail-form"><label>Référence<input name="sku" required></label><label>TVA %<input name="vat" type="number" step="0.1" value="20"></label><label class="full">Désignation<input name="name" required></label><label>Prix TTC<input name="price" type="number" min="0" step="0.01" required></label><div><button class="btn btn-primary">Ajouter</button></div></form></details></div>`
  const q=box.querySelector('#catalog-q'),cat=box.querySelector('#catalog-cat'),grid=box.querySelector('#catalog-grid')
  const draw=()=>{const arr=state.products.filter(p=>productMatches(q.value,p)&&(!cat.value||p.category===cat.value));grid.innerHTML=arr.map(p=>`<div class="product-card static">${p.image?`<img loading="lazy" src="${escapeHtml(p.image)}" alt="">`:'<div class="product-placeholder">LDJ</div>'}<span class="product-card-body"><strong>${escapeHtml(p.name)}</strong><small>N° ${p.catalogue_number||'—'} · ${escapeHtml(p.sku||'')}</small><small>${escapeHtml(p.category||'')}</small><b>${money(p.price_ttc)}</b><code>${escapeHtml(p.qr_payload||'')}</code></span></div>`).join('')};q.oninput=draw;cat.onchange=draw;draw()
  box.querySelector('#product-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);const {error}=await supabase.from('products').insert({company_id:state.company.id,sku:f.get('sku'),name:f.get('name'),price_ttc:Number(f.get('price')),vat_rate:Number(f.get('vat'))});if(error)return alert(error.message);await loadProducts();renderProducts()}
}
async function renderEvents(){
  const box=document.querySelector('#content');box.innerHTML=`<div class="grid grid-2"><div class="card"><h3>Ajouter une foire</h3><form id="event-form" class="form-grid"><label class="full">Nom<input name="name" placeholder="Ex. Journées des Plantes — …" required></label><label class="full">Lieu<input name="location"></label><label>Début<input name="start" type="date"></label><label>Fin<input name="end" type="date"></label><button class="btn btn-primary">Ajouter</button></form></div><div class="card"><h3>Organisation</h3><p>La foire choisie reste mémorisée d'une vente à l'autre. Chaque vente rapide ou facture est rattachée à l'événement pour retrouver ensuite son chiffre d'affaires.</p></div></div><div class="card" style="margin-top:18px"><h3>Événements</h3><div class="table-wrap"><table><thead><tr><th>Nom</th><th>Lieu</th><th>Dates</th></tr></thead><tbody>${state.events.map(e=>`<tr><td>${escapeHtml(e.name)}</td><td>${escapeHtml(e.location||'')}</td><td>${e.starts_on||''}${e.ends_on?` → ${e.ends_on}`:''}</td></tr>`).join('')}</tbody></table></div></div>`
  document.querySelector('#event-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);const {error}=await supabase.from('events').insert({company_id:state.company.id,name:f.get('name'),location:f.get('location'),starts_on:f.get('start')||null,ends_on:f.get('end')||null});if(error)return alert(error.message);await loadEvents();renderEvents()}
}
function renderSettings(){
  const c=state.company,can=['owner','admin'].includes(state.role);document.querySelector('#content').innerHTML=`<div class="card"><div class="card-head"><h3>Identité & mentions de facture</h3>${can?'':'<span class="badge warn">Lecture seule</span>'}</div><form id="settings" class="form-grid"><label>Nom commercial<input name="trade_name" value="${escapeHtml(c.trade_name||c.name||BRAND)}"></label><label>Raison sociale<input name="legal_name" value="${escapeHtml(c.legal_name||'')}"></label><label class="full">Adresse<input name="address" value="${escapeHtml(c.address||'')}"></label><label>Code postal<input name="postal_code" value="${escapeHtml(c.postal_code||'')}"></label><label>Ville<input name="city" value="${escapeHtml(c.city||'')}"></label><label>SIREN<input name="siren" value="${escapeHtml(c.siren||'')}"></label><label>SIRET<input name="siret" value="${escapeHtml(c.siret||'')}"></label><label>N° TVA intracommunautaire<input name="vat_number" value="${escapeHtml(c.vat_number||'')}"></label><label>E-mail entreprise<input name="email" type="email" value="${escapeHtml(c.email||'')}"></label><label>E-mail copie factures<input name="invoice_email" type="email" value="${escapeHtml(c.invoice_email||'')}"></label><label>Téléphone<input name="phone" value="${escapeHtml(c.phone||'')}"></label><label>Préfixe factures<input name="invoice_prefix" value="${escapeHtml(c.invoice_prefix||'LDJ')}"></label><label>TVA par défaut<input name="default_vat_rate" type="number" step="0.1" value="${c.default_vat_rate||20}"></label><label class="full">Conditions / mentions de paiement<textarea name="payment_terms">${escapeHtml(c.payment_terms||'')}</textarea></label><label class="full">Pied de facture légal<textarea name="legal_footer">${escapeHtml(c.legal_footer||'')}</textarea></label><div class="full"><button class="btn btn-primary" ${can?'':'disabled'}>Enregistrer</button></div></form><div class="notice"><strong>Identité Lézard du Jardin préremplie :</strong> siège social, SIREN/SIRET, TVA, téléphone et e-mails sont complétés automatiquement s'ils sont vides. Vérifie toujours avant une facture réelle.</div></div>`
  if(can)document.querySelector('#settings').onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.currentTarget).entries());f.default_vat_rate=Number(f.default_vat_rate);const {data,error}=await supabase.from('companies').update(f).eq('id',c.id).select().single();if(error)return alert(error.message);state.company=data;alert('Réglages enregistrés.')}
}
boot()
