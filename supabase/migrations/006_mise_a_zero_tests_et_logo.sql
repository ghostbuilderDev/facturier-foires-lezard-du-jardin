-- Lézard du Jardin : mise en place v1.4 + remise à zéro des essais (v1.5)
-- Exécuter UNE SEULE fois dans Supabase > SQL Editor.
-- ATTENTION : supprime les 4 factures de test et jusqu'à 20 ventes rapides de test
-- de LA MÊME entreprise, ainsi que les formulaires QR en attente de cet espace.
-- Ne supprime pas les 389 produits, les événements, les utilisateurs ni les secrets.
-- Si des factures réelles existent, ce script doit REFUSER de s'exécuter.

begin;

do $$
declare
  matching_companies int;
  confirmed_final int;
  target_company uuid;
  quick_count int;
begin
  select count(*) into matching_companies
  from (
    select company_id from public.invoices
    group by company_id
    having count(*) filter(where status='final') = 4
       and count(*) filter(where status='final' and number in (
           'LDJ-2026-000001','LDJ-2026-000002',
           'LDJ-2026-000003','LDJ-2026-000004')) = 4
       and count(*) filter(where number is not null) = 4
  ) target;
  if matching_companies <> 1 then
    raise exception 'SECURITE : 4 factures test 000001 a 000004 introuvables dans un seul espace. Aucun effacement.';
  end if;
  select company_id into target_company
  from public.invoices group by company_id
  having count(*) filter(where status='final') = 4
     and count(*) filter(where status='final' and number in (
       'LDJ-2026-000001','LDJ-2026-000002',
       'LDJ-2026-000003','LDJ-2026-000004')) = 4
     and count(*) filter(where number is not null) = 4;
  -- Si l'application avait deja des ventes rapides reelles, ne pas effacer aveuglement.
  if to_regclass('public.sales') is not null then
    execute 'select count(*) from public.sales where company_id=$1'
      into quick_count using target_company;
    if quick_count > 20 then
      raise exception 'SECURITE : plus de 20 ventes rapides. Aucun effacement. Contacter assistance.';
    end if;
  end if;
  raise notice '4 factures tests reconnues; espace %, ventes rapides a effacer: %', target_company, coalesce(quick_count,0);
end $$;

-- Rejoue les changements v1.4 de facon idempotente si la premiere migration avait echoue.
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
-- Un seul espace reçoit le code imprimé sur l'affiche.
-- Celui qui détient les 4 factures test est celui utilisé pour la remise à zéro.
do $$
declare
  active_company uuid;
  fixed_code constant uuid := 'c9c1626a-06be-4e17-9c84-4ca10753f10a';
begin
  select i.company_id into active_company
  from public.invoices i
  group by i.company_id
  having count(*) filter (where i.status='final')=4
     and count(*) filter (where i.status='final' and i.number in
       ('LDJ-2026-000001','LDJ-2026-000002','LDJ-2026-000003','LDJ-2026-000004'))=4
  limit 1;
  if active_company is not null then
    update public.companies set public_intake_code=gen_random_uuid()
      where id<>active_company and public_intake_code=fixed_code;
    update public.companies set public_intake_code=fixed_code
      where id=active_company;
  end if;
  update public.companies set public_intake_code=gen_random_uuid()
    where public_intake_code is null;
end $$;
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


-- ============================================================
-- v1.4 - VENTES RAPIDES SANS FACTURE
-- Les ventes ordinaires sont enregistrées dans un journal séparé.
-- Une facture n'est créée que lorsqu'un client la demande.
-- ============================================================

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  created_by uuid not null references auth.users(id),
  event_id uuid references public.events(id) on delete set null,
  sale_date date not null,
  sold_at timestamptz not null default now(),
  payment_method text,
  notes text,
  status text not null default 'recorded' check(status in ('recorded','voided')),
  total_ht numeric(12,2) not null default 0,
  total_vat numeric(12,2) not null default 0,
  total_ttc numeric(12,2) not null default 0,
  integrity_hash text,
  voided_at timestamptz,
  voided_by uuid references auth.users(id) on delete set null,
  void_reason text,
  created_at timestamptz not null default now()
);

create table if not exists public.sale_lines (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete restrict,
  position int not null default 0,
  sku text,
  source_product_id text,
  catalogue_number integer,
  category text,
  description text not null,
  quantity numeric(12,3) not null default 1,
  unit_price_ttc numeric(12,2) not null default 0,
  vat_rate numeric(5,2) not null default 20,
  discount_percent numeric(5,2) not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists sales_company_date_idx on public.sales(company_id,sale_date,status,sold_at);
create index if not exists sales_event_date_idx on public.sales(event_id,sale_date,status);
create index if not exists sale_lines_sale_idx on public.sale_lines(sale_id,position);
create index if not exists sale_lines_product_idx on public.sale_lines(source_product_id);

alter table public.sales enable row level security;
alter table public.sale_lines enable row level security;

do $$ begin
  create policy sales_select on public.sales for select
  using(public.is_company_member(company_id));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy sale_lines_select on public.sale_lines for select
  using(exists(select 1 from public.sales s where s.id=sale_id and public.is_company_member(s.company_id)));
exception when duplicate_object then null; end $$;

-- Aucun droit direct INSERT/UPDATE/DELETE n'est donné au navigateur pour les ventes rapides.
-- L'enregistrement passe uniquement par la fonction atomique ci-dessous.

create or replace function public.record_quick_sale(
  p_event_id uuid,
  p_payment_method text,
  p_notes text,
  p_sale_date date,
  p_lines jsonb
) returns uuid
language plpgsql
security definer
set search_path=public,extensions
as $$
declare
  cid uuid;
  sid uuid;
  item jsonb;
  pos int := 0;
  q numeric;
  price numeric;
  vat numeric;
  disc numeric;
  ttc numeric;
  ht numeric;
  sum_ttc numeric := 0;
  sum_ht numeric := 0;
  payload_text text := '';
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;

  select company_id into cid
  from public.company_members
  where user_id=auth.uid()
  order by case role when 'owner' then 1 when 'admin' then 2 else 3 end
  limit 1;

  if cid is null then raise exception 'Aucune entreprise associée'; end if;
  if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then
    raise exception 'Aucun article';
  end if;
  if p_event_id is not null and not exists(select 1 from public.events e where e.id=p_event_id and e.company_id=cid) then
    raise exception 'Événement invalide';
  end if;

  insert into public.sales(company_id,created_by,event_id,sale_date,payment_method,notes)
  values(cid,auth.uid(),p_event_id,coalesce(p_sale_date,current_date),nullif(trim(coalesce(p_payment_method,'')),''),nullif(trim(coalesce(p_notes,'')),''))
  returning id into sid;

  for item in select value from jsonb_array_elements(p_lines)
  loop
    q := greatest(coalesce(nullif(item->>'quantity','')::numeric,0),0);
    price := greatest(coalesce(nullif(item->>'unit_price_ttc','')::numeric,0),0);
    vat := coalesce(nullif(item->>'vat_rate','')::numeric,20);
    disc := least(100,greatest(0,coalesce(nullif(item->>'discount_percent','')::numeric,0)));
    if q <= 0 then continue; end if;
    if coalesce(trim(item->>'description'),'')='' then continue; end if;

    ttc := round(q*price*(1-disc/100),2);
    ht := case when vat=0 then ttc else round(ttc/(1+vat/100),2) end;
    sum_ttc := sum_ttc + ttc;
    sum_ht := sum_ht + ht;

    insert into public.sale_lines(
      sale_id,position,sku,source_product_id,catalogue_number,category,description,
      quantity,unit_price_ttc,vat_rate,discount_percent
    ) values (
      sid,pos,nullif(item->>'sku',''),nullif(item->>'source_product_id',''),
      case when coalesce(item->>'catalogue_number','') ~ '^[0-9]+$' then (item->>'catalogue_number')::int else null end,
      nullif(item->>'category',''),item->>'description',q,price,vat,disc
    );

    payload_text := payload_text || '|' || coalesce(item->>'source_product_id','') || ':' || coalesce(item->>'sku','') || ':' || (item->>'description') || ':' || q::text || ':' || price::text || ':' || vat::text || ':' || disc::text;
    pos := pos + 1;
  end loop;

  if pos=0 then
    delete from public.sales where id=sid;
    raise exception 'Aucune ligne de vente valide';
  end if;

  update public.sales
  set total_ht=round(sum_ht,2),
      total_vat=round(sum_ttc-sum_ht,2),
      total_ttc=round(sum_ttc,2),
      integrity_hash=encode(digest(cid::text||'|'||sid::text||'|'||coalesce(p_sale_date,current_date)::text||'|'||coalesce(p_payment_method,'')||payload_text,'sha256'),'hex')
  where id=sid;

  insert into public.audit_events(company_id,actor_id,action,entity_type,entity_id,payload)
  values(cid,auth.uid(),'QUICK_SALE_RECORDED','sale',sid,jsonb_build_object('total_ttc',round(sum_ttc,2),'lines',pos,'payment_method',p_payment_method));

  return sid;
end$$;

grant execute on function public.record_quick_sale(uuid,text,text,date,jsonb) to authenticated;

-- Remise à zéro : verrouillage de la seule entreprise avec les quatre tests.
do $$
declare
  company_to_reset uuid;
  pdf_count int;
  sale_count int;
  deleted_invoice_count int;
  invoice_uuid uuid;
begin
  select company_id into company_to_reset
  from public.invoices
  group by company_id
  having count(*) filter(where status='final') = 4
     and count(*) filter(where status='final' and number in (
       'LDJ-2026-000001','LDJ-2026-000002',
       'LDJ-2026-000003','LDJ-2026-000004')) = 4
     and count(*) filter(where number is not null) = 4
  limit 1;
  if company_to_reset is null then
    raise exception 'SECURITE : factures tests non reconnues, aucune suppression.';
  end if;

  -- Les documents test ne restent pas dans le journal principal.
  -- Les fichiers du bucket privé Storage ne sont pas supprimés par SQL
  -- pour ne jamais casser le système de fichiers Supabase.
  -- Les nouveaux PDF portent aussi leur UUID : pas de collision avec les anciens.
  delete from public.audit_events
   where company_id=company_to_reset and entity_type in ('invoice','sale');

  -- Les lignes de facture sont en cascade depuis invoices.
  delete from public.invoices
   where company_id=company_to_reset;
  get diagnostics deleted_invoice_count = row_count;

  -- Les ventes rapides utilisent des lignes avec ON DELETE RESTRICT.
  delete from public.sale_lines sl
   using public.sales s
   where sl.sale_id=s.id and s.company_id=company_to_reset;
  delete from public.sales
   where company_id=company_to_reset;
  get diagnostics sale_count = row_count;

  -- Nettoyage des anciennes demandes client de test (jetons QR temporaires).
  delete from public.intake_sessions
   where company_id=company_to_reset;

  -- Numéro de 2026 : la prochaine facture sera LDJ-2026-000001.
  delete from public.invoice_sequences
   where company_id=company_to_reset
     and year=2026 and doc_type in ('invoice','credit_note');

  -- Conserver les paramètres de la société et le QR permanent de l'affiche.
  update public.companies set invoice_prefix='LDJ'
   where id=company_to_reset;

  raise notice 'Reinitialisation terminee : % factures, % ventes rapides effacees. Catalogue preserve.',
    deleted_invoice_count, sale_count;
end $$;

commit;

-- Verification (retourne zero partout pour l'entreprise nettoyee)
select c.name,
  (select count(*) from public.invoices i where i.company_id=c.id) as factures_restantes,
  (select count(*) from public.sales s where s.company_id=c.id) as ventes_rapides_restantes,
  coalesce((select last_value from public.invoice_sequences s
    where s.company_id=c.id and s.year=2026 and s.doc_type='invoice'),0) as compteur_facture_2026
from public.companies c
where c.public_intake_code='c9c1626a-06be-4e17-9c84-4ca10753f10a'::uuid;
