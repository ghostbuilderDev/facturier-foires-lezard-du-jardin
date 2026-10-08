import './styles.css'
import { supabase } from './supabase.js'

const root=document.querySelector('#client-app')
const escapeHtml=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c]))
const params=new URLSearchParams(location.search)
let token=params.get('t')
const publicCode=params.get('public')||''
const publicMode=Boolean(publicCode)

async function boot(){
  if(!token && publicMode){
    const {data,error}=await supabase.rpc('start_public_intake',{p_code:publicCode})
    if(error||!data)return showError('Le formulaire permanent n’est pas encore activé. Demandez au vendeur d’afficher le QR client.')
    token=data
    history.replaceState({},'',`client.html?t=${encodeURIComponent(token)}`)
  }
  if(!token)return showError('QR code invalide ou incomplet.')
  const {data,error}=await supabase.rpc('intake_context',{p_token:token})
  if(error||!data?.length)return showError('Ce QR code est invalide, expiré ou déjà utilisé.')
  const ctx=data[0]
  if(ctx.status!=='waiting')return showError(ctx.status==='submitted'?'Vos coordonnées ont déjà été transmises.':'Ce QR code n’est plus actif.')
  render(ctx)
}
function render(ctx){
  root.innerHTML=`<div class="client-wrap"><div class="client-card"><div class="client-header"><div class="brand-mark" style="margin:auto">LDJ</div><h1>${escapeHtml(ctx.trade_name||'Lézard du Jardin')}</h1><p class="muted">${ctx.event_name?`Pour votre achat à ${escapeHtml(ctx.event_name)}`:'Coordonnées pour votre facture'}</p></div>
    <div class="notice"><strong>Vous évitez ainsi toute erreur de saisie.</strong><br><span class="small">Ces informations seront reprises automatiquement sur votre facture.</span></div>
    <form id="customer" class="form-grid" style="margin-top:18px">
      <label>Vous êtes<select name="customer_type" id="customer-type"><option value="individual">Un particulier</option><option value="company">Une entreprise</option></select></label><label id="company-wrap" class="hidden">Société<input name="company_name"></label>
      <label>Prénom<input name="first_name" autocomplete="given-name"></label><label>Nom<input name="last_name" autocomplete="family-name" required></label>
      <label id="siren-wrap" class="hidden">SIREN<input name="siren" inputmode="numeric" maxlength="9"></label><label id="vat-wrap" class="hidden">TVA intracommunautaire<input name="vat_number" autocomplete="off" placeholder="FR..."></label>
      <label class="full">Adresse<input name="address" autocomplete="street-address" required></label><label>Code postal<input name="postal_code" autocomplete="postal-code" inputmode="numeric" required></label><label>Ville<input name="city" autocomplete="address-level2" required></label>
      <label>Pays<input name="country" value="France" autocomplete="country-name"></label><label>E-mail<input name="email" type="email" autocomplete="email" required></label><label>Téléphone<input name="phone" type="tel" autocomplete="tel"></label>
      <label class="full check"><input type="checkbox" id="delivery-same" checked> L'adresse de livraison est la même que l'adresse de facturation.</label>
      <div id="delivery" class="full form-grid hidden"><label class="full">Adresse de livraison<input name="delivery_address"></label><label>Code postal livraison<input name="delivery_postal_code"></label><label>Ville livraison<input name="delivery_city"></label></div>
      <label class="full check"><input name="marketing_opt_in" type="checkbox"> J'accepte de recevoir occasionnellement les nouveautés et invitations de Lézard du Jardin. <strong>(facultatif)</strong></label>
      <label class="full check"><input id="accurate" type="checkbox" required> Je confirme que les coordonnées saisies sont exactes.</label>
      <div class="full"><button id="submit" class="btn btn-primary" style="width:100%">Transmettre mes coordonnées</button></div>
    </form><p class="privacy">Les informations saisies servent à établir et transmettre votre facture ainsi qu'à respecter les obligations comptables de l'entreprise. Les données de facturation sont conservées pendant la durée légale applicable. L'option de communication commerciale est séparée et facultative.</p><div id="msg"></div>
  </div></div>`
  const type=document.querySelector('#customer-type');const toggle=()=>{const pro=type.value==='company';document.querySelector('#company-wrap').classList.toggle('hidden',!pro);document.querySelector('#siren-wrap').classList.toggle('hidden',!pro);document.querySelector('#vat-wrap').classList.toggle('hidden',!pro);document.querySelector('[name="company_name"]').required=pro};type.onchange=toggle
  document.querySelector('#delivery-same').onchange=e=>document.querySelector('#delivery').classList.toggle('hidden',e.target.checked)
  document.querySelector('#customer').onsubmit=submit
}
async function submit(e){
  e.preventDefault();const btn=document.querySelector('#submit'),msg=document.querySelector('#msg');btn.disabled=true;btn.textContent='Transmission…'
  const f=new FormData(e.currentTarget),deliverySame=document.querySelector('#delivery-same').checked
  const payload={customer_type:f.get('customer_type'),company_name:f.get('company_name')||'',siren:(f.get('siren')||'').replace(/\s/g,''),vat_number:(f.get('vat_number')||'').replace(/\s/g,''),first_name:f.get('first_name')||'',last_name:f.get('last_name')||'',address:f.get('address')||'',postal_code:f.get('postal_code')||'',city:f.get('city')||'',country:f.get('country')||'France',email:f.get('email')||'',phone:f.get('phone')||'',delivery_same:deliverySame,delivery_address:deliverySame?'':(f.get('delivery_address')||''),delivery_postal_code:deliverySame?'':(f.get('delivery_postal_code')||''),delivery_city:deliverySame?'':(f.get('delivery_city')||''),marketing_opt_in:f.get('marketing_opt_in')==='on'}
  const {error}=await supabase.rpc('submit_customer_intake',{p_token:token,p_payload:payload})
  if(error){msg.innerHTML=`<div class="notice error" style="margin-top:12px">${escapeHtml(error.message)}</div>`;btn.disabled=false;btn.textContent='Transmettre mes coordonnées';return}
  root.innerHTML=`<div class="client-wrap"><div class="client-card" style="text-align:center"><div class="brand-mark" style="margin:auto">✓</div><h1>Merci</h1><p>Vos coordonnées ont bien été transmises au vendeur.</p><p class="muted">Vous pouvez fermer cette page et indiquer votre nom au vendeur. Votre facture vous sera envoyée par e-mail après validation de la vente.</p></div></div>`
}
function showError(t){root.innerHTML=`<div class="client-wrap"><div class="client-card"><h1>QR non disponible</h1><div class="notice error">${escapeHtml(t)}</div><p class="muted">Demandez simplement au vendeur d'afficher un nouveau QR code.</p></div></div>`}
boot()
