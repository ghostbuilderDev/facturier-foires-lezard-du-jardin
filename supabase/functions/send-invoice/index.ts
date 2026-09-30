import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type' }
const json = (body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json'}})

Deno.serve(async (req) => {
  if(req.method==='OPTIONS') return new Response('ok',{headers:cors})
  try{
    const auth=req.headers.get('Authorization')||''
    if(!auth.startsWith('Bearer ')) return json({error:'Non authentifié'},401)
    const url=Deno.env.get('SUPABASE_URL')!, anon=Deno.env.get('SUPABASE_ANON_KEY')!, service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const apiKey=Deno.env.get('RESEND_API_KEY')!, from=Deno.env.get('MAIL_FROM')||'Lézard du Jardin <factures@example.com>'
    if(!apiKey) return json({error:'RESEND_API_KEY manquante'},500)
    const userClient=createClient(url,anon,{global:{headers:{Authorization:auth}}})
    const {data:{user},error:uerr}=await userClient.auth.getUser(); if(uerr||!user)return json({error:'Session invalide'},401)
    const {invoice_id}=await req.json(); if(!invoice_id)return json({error:'invoice_id manquant'},400)
    const admin=createClient(url,service)
    const {data:inv,error:ierr}=await admin.from('invoices').select('*').eq('id',invoice_id).single(); if(ierr||!inv)return json({error:'Facture introuvable'},404)
    const {data:member}=await admin.from('company_members').select('role').eq('company_id',inv.company_id).eq('user_id',user.id).maybeSingle(); if(!member)return json({error:'Accès refusé'},403)
    const {data:company}=await admin.from('companies').select('*').eq('id',inv.company_id).single()
    if(!inv.pdf_path)return json({error:'PDF non encore archivé'},409)
    const {data:file,error:derr}=await admin.storage.from('invoices').download(inv.pdf_path); if(derr||!file)return json({error:'PDF introuvable'},500)
    const bytes=new Uint8Array(await file.arrayBuffer()); let binary=''; const chunk=0x8000; for(let i=0;i<bytes.length;i+=chunk) binary+=String.fromCharCode(...bytes.subarray(i,Math.min(i+chunk,bytes.length))); const b64=btoa(binary)
    const c=inv.customer_json||{}; const clientName=c.company_name||`${c.first_name||''} ${c.last_name||''}`.trim()||'Client'
    const to=String(c.email||'').trim(); const copy=String(company?.invoice_email||company?.email||'').trim(); if(!to&&!copy)return json({error:'Aucune adresse e-mail'},409)
    const payload:any={from,to:to?[to]:[copy],subject:`Votre facture ${inv.number} — ${company?.trade_name||company?.name||'Lézard du Jardin'}`,html:`<div style="font-family:Arial,sans-serif;color:#203128"><h2>Merci ${clientName}</h2><p>Veuillez trouver ci-joint votre facture <strong>${inv.number}</strong> d'un montant de <strong>${Number(inv.total_ttc).toFixed(2).replace('.',',')} € TTC</strong>.</p><p>Merci pour votre confiance et au plaisir de vous retrouver sur nos prochains rendez-vous jardin.</p><p>${company?.trade_name||company?.name||'Lézard du Jardin'}</p></div>`,attachments:[{filename:`${inv.number}.pdf`,content:b64}]}
    if(copy&&copy!==to) payload.bcc=[copy]
    const resp=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(payload)})
    const result=await resp.json(); if(!resp.ok)return json({error:result?.message||'Erreur envoi e-mail',details:result},502)
    await admin.from('invoices').update({emailed_at:new Date().toISOString()}).eq('id',inv.id)
    await admin.from('audit_events').insert({company_id:inv.company_id,actor_id:user.id,action:'EMAILED',entity_type:'invoice',entity_id:inv.id,payload:{provider:'resend',id:result?.id||null,to,copy}})
    return json({ok:true,id:result?.id})
  }catch(e){return json({error:String(e?.message||e)},500)}
})
