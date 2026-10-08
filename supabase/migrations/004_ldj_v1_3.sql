-- Facturier LDJ v1.3 - QR permanent + file clients + suivi des ventes
-- Migration cumulative : peut être exécutée même si 003 n'a jamais été lancée.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
alter function public.finalize_invoice(uuid) set search_path = public, extensions;

-- Identité Lézard du Jardin : ne complète que les champs encore vides.
update public.companies
set trade_name = coalesce(nullif(trade_name,''),'Lézard du Jardin'),
    legal_name = coalesce(nullif(legal_name,''),'LEZARD DU JARDIN'),
    address = coalesce(nullif(address,''),'12 rue de la Brande'),
    postal_code = coalesce(nullif(postal_code,''),'17240'),
    city = coalesce(nullif(city,''),'Champagnolles'),
    country = coalesce(nullif(country,''),'France'),
    siren = coalesce(nullif(siren,''),'902726165'),
    siret = coalesce(nullif(siret,''),'90272616500019'),
    vat_number = coalesce(nullif(vat_number,''),'FR05902726165'),
    email = coalesce(nullif(email,''),'contact@lezarddujardin.fr'),
    invoice_email = coalesce(nullif(invoice_email,''),'sasulezarddujardin@gmail.com'),
    phone = coalesce(nullif(phone,''),'06 50 81 37 14'),
    invoice_prefix = coalesce(nullif(invoice_prefix,''),'LDJ'),
    payment_terms = coalesce(nullif(payment_terms,''),'Paiement comptant à la vente. Aucun escompte pour paiement anticipé.'),
    legal_footer = coalesce(nullif(legal_footer,''),'LEZARD DU JARDIN — SASU — SIREN 902 726 165 — SIRET 902 726 165 00019 — RCS Saintes 902 726 165 — TVA FR05 902 726 165 — Siège social : 12 rue de la Brande, 17240 Champagnolles, France — contact@lezarddujardin.fr — 06 50 81 37 14')
where lower(coalesce(trade_name,name,'')) like '%lézard du jardin%'
   or lower(coalesce(trade_name,name,'')) like '%lezard du jardin%';

-- QR permanent : chaque scan crée une session indépendante pour éviter tout mélange
-- lorsque plusieurs clients remplissent le formulaire en même temps.
alter table public.intake_sessions alter column created_by drop not null;
alter table public.intake_sessions add column if not exists source text not null default 'seller';
alter table public.intake_sessions add column if not exists used_at timestamptz;
alter table public.intake_sessions add column if not exists used_by uuid references auth.users(id) on delete set null;

alter table public.companies add column if not exists public_intake_code uuid;
update public.companies
set public_intake_code='c9c1626a-06be-4e17-9c84-4ca10753f10a'::uuid
where public_intake_code is null
  and (siren='902726165'
       or lower(coalesce(trade_name,name,'')) like '%lézard du jardin%'
       or lower(coalesce(trade_name,name,'')) like '%lezard du jardin%');
update public.companies set public_intake_code=gen_random_uuid() where public_intake_code is null;
alter table public.companies alter column public_intake_code set not null;
create unique index if not exists companies_public_intake_code_uidx on public.companies(public_intake_code);
create index if not exists intake_sessions_queue_idx on public.intake_sessions(company_id,source,status,submitted_at desc);

do $$ begin
  create policy intake_update on public.intake_sessions
  for update using(public.is_company_member(company_id))
  with check(public.is_company_member(company_id));
exception when duplicate_object then null; end $$;

drop function if exists public.start_public_intake(text);
create or replace function public.start_public_intake(p_code uuid)
returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare
  cid uuid;
  tok uuid;
begin
  select id into cid
  from public.companies
  where public_intake_code=p_code
  limit 1;

  if cid is null then raise exception 'QR public invalide'; end if;

  insert into public.intake_sessions(company_id,event_id,created_by,source,expires_at)
  values(cid,null,null,'poster',now()+interval '24 hours')
  returning token into tok;

  return tok;
end$$;
grant execute on function public.start_public_intake(uuid) to anon, authenticated;

-- Traçabilité article : les nouvelles lignes de facture gardent désormais la référence
-- catalogue en plus de la désignation et du prix figés au moment de la vente.
alter table public.invoice_lines add column if not exists sku text;
alter table public.invoice_lines add column if not exists source_product_id text;
alter table public.invoice_lines add column if not exists catalogue_number integer;
alter table public.invoice_lines add column if not exists category text;
create index if not exists invoice_lines_source_product_idx on public.invoice_lines(source_product_id);
create index if not exists invoices_company_sale_date_idx on public.invoices(company_id,sale_date,status);
