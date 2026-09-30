-- Upgrade v1.0 — Lézard du Jardin
alter table public.companies alter column invoice_prefix set default 'LDJ';
update public.companies set invoice_prefix='LDJ' where invoice_prefix='ADJ';

create or replace function public.submit_customer_intake(p_token uuid,p_payload jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare s public.intake_sessions;
begin
  select * into s from public.intake_sessions where token=p_token for update;
  if not found or s.expires_at<now() or s.status<>'waiting' then raise exception 'QR expiré ou déjà utilisé'; end if;
  if coalesce(p_payload->>'email','')='' or coalesce(p_payload->>'address','')='' or coalesce(p_payload->>'postal_code','')='' or coalesce(p_payload->>'city','')='' or
     (case when coalesce(p_payload->>'customer_type','individual')='company' then coalesce(p_payload->>'company_name','')='' else coalesce(p_payload->>'last_name','')='' end)
  then raise exception 'Coordonnées incomplètes'; end if;
  update public.intake_sessions set customer_json=p_payload,status='submitted',submitted_at=now() where id=s.id;
end$$;
grant execute on function public.submit_customer_intake(uuid,jsonb) to anon,authenticated;
