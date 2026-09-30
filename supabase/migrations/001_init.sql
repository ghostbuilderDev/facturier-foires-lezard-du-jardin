-- Facturier Foires Lézard du Jardin — schéma initial
create extension if not exists pgcrypto;

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  trade_name text,
  legal_name text,
  address text,
  postal_code text,
  city text,
  country text not null default 'France',
  siren text,
  siret text,
  vat_number text,
  email text,
  invoice_email text,
  phone text,
  invoice_prefix text not null default 'LDJ',
  default_vat_rate numeric(5,2) not null default 20,
  payment_terms text default 'Paiement comptant. Aucun escompte pour paiement anticipé. Pour les clients professionnels : pénalités de retard exigibles selon les conditions convenues et indemnité forfaitaire de 40 € pour frais de recouvrement lorsque applicable.',
  legal_footer text,
  created_at timestamptz not null default now()
);

create table if not exists public.company_members (
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'seller' check(role in ('owner','admin','seller')),
  created_at timestamptz not null default now(),
  primary key(company_id,user_id)
);

create or replace function public.is_company_member(p_company_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.company_members m where m.company_id=p_company_id and m.user_id=auth.uid());
$$;
create or replace function public.has_company_role(p_company_id uuid,p_roles text[])
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.company_members m where m.company_id=p_company_id and m.user_id=auth.uid() and m.role=any(p_roles));
$$;

create or replace function public.create_company(p_name text)
returns uuid language plpgsql security definer set search_path=public as $$
declare cid uuid;
begin
  if auth.uid() is null then raise exception 'Authentification requise'; end if;
  if exists(select 1 from public.company_members where user_id=auth.uid()) then raise exception 'Ce compte appartient déjà à une entreprise'; end if;
  insert into public.companies(name,trade_name,legal_name) values(p_name,p_name,p_name) returning id into cid;
  insert into public.company_members(company_id,user_id,role) values(cid,auth.uid(),'owner');
  return cid;
end$$;

grant execute on function public.create_company(text) to authenticated;

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
  name text not null, location text, starts_on date, ends_on date, is_active boolean not null default true, created_at timestamptz not null default now()
);
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
  sku text, name text not null, price_ttc numeric(12,2) not null default 0, vat_rate numeric(5,2) not null default 20,
  is_active boolean not null default true, sort_order int not null default 0, created_at timestamptz not null default now(),
  unique(company_id,sku)
);

create table if not exists public.intake_sessions (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
  event_id uuid references public.events(id) on delete set null, created_by uuid not null references auth.users(id),
  token uuid not null default gen_random_uuid() unique, status text not null default 'waiting' check(status in ('waiting','submitted','used','expired')),
  customer_json jsonb, expires_at timestamptz not null default (now()+interval '2 hours'), submitted_at timestamptz, created_at timestamptz not null default now()
);

create or replace function public.intake_context(p_token uuid)
returns table(trade_name text,event_name text,expires_at timestamptz,status text)
language sql security definer set search_path=public as $$
  select coalesce(c.trade_name,c.name),e.name,s.expires_at,
    case when s.expires_at < now() and s.status='waiting' then 'expired' else s.status end
  from public.intake_sessions s join public.companies c on c.id=s.company_id left join public.events e on e.id=s.event_id
  where s.token=p_token and s.expires_at > now()-interval '7 days' limit 1;
$$;

grant execute on function public.intake_context(uuid) to anon,authenticated;

create or replace function public.submit_customer_intake(p_token uuid,p_payload jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare s public.intake_sessions;
begin
  select * into s from public.intake_sessions where token=p_token for update;
  if not found or s.expires_at<now() or s.status<>'waiting' then raise exception 'QR expiré ou déjà utilisé'; end if;
  if coalesce(p_payload->>'email','')='' or coalesce(p_payload->>'address','')='' or coalesce(p_payload->>'postal_code','')='' or coalesce(p_payload->>'city','')='' or (case when coalesce(p_payload->>'customer_type','individual')='company' then coalesce(p_payload->>'company_name','')='' else coalesce(p_payload->>'last_name','')='' end) then raise exception 'Coordonnées incomplètes'; end if;
  update public.intake_sessions set customer_json=p_payload,status='submitted',submitted_at=now() where id=s.id;
end$$;
grant execute on function public.submit_customer_intake(uuid,jsonb) to anon,authenticated;

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete restrict,
  created_by uuid not null references auth.users(id), event_id uuid references public.events(id) on delete set null,
  kind text not null default 'invoice' check(kind in ('invoice','credit_note')), number text,
  status text not null default 'draft' check(status in ('draft','final','credited','cancelled')),
  customer_json jsonb not null default '{}'::jsonb, sale_date date not null default current_date, issued_at timestamptz,
  payment_method text, delivery_mode text, notes text, total_ht numeric(12,2) not null default 0,total_vat numeric(12,2) not null default 0,total_ttc numeric(12,2) not null default 0,
  pdf_path text, emailed_at timestamptz, integrity_hash text, created_at timestamptz not null default now(),
  unique(company_id,number)
);
create table if not exists public.invoice_lines (
  id uuid primary key default gen_random_uuid(), invoice_id uuid not null references public.invoices(id) on delete cascade,
  position int not null default 0, description text not null, quantity numeric(12,3) not null default 1,
  unit_price_ttc numeric(12,2) not null default 0, vat_rate numeric(5,2) not null default 20, discount_percent numeric(5,2) not null default 0,
  created_at timestamptz not null default now()
);
create table if not exists public.invoice_sequences (
  company_id uuid not null references public.companies(id) on delete cascade, year int not null, doc_type text not null,
  last_value bigint not null default 0, primary key(company_id,year,doc_type)
);
create table if not exists public.audit_events (
  id bigint generated always as identity primary key, company_id uuid not null references public.companies(id) on delete restrict,
  actor_id uuid, action text not null, entity_type text not null, entity_id uuid, payload jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);

create or replace function public.finalize_invoice(p_invoice_id uuid)
returns text language plpgsql security definer set search_path=public as $$
declare inv public.invoices; comp public.companies; seq bigint; yr int; n text; tht numeric; tva numeric; ttc numeric; line_json text;
begin
  select * into inv from public.invoices where id=p_invoice_id for update;
  if not found then raise exception 'Facture introuvable'; end if;
  if not public.is_company_member(inv.company_id) then raise exception 'Accès refusé'; end if;
  if inv.status<>'draft' then raise exception 'Facture déjà finalisée'; end if;
  if not exists(select 1 from public.invoice_lines where invoice_id=inv.id) then raise exception 'Aucune ligne de facture'; end if;
  select * into comp from public.companies where id=inv.company_id;
  yr=extract(year from inv.sale_date)::int;
  insert into public.invoice_sequences(company_id,year,doc_type,last_value) values(inv.company_id,yr,inv.kind,1)
    on conflict(company_id,year,doc_type) do update set last_value=public.invoice_sequences.last_value+1 returning last_value into seq;
  n=(case when inv.kind='credit_note' then 'AV-' else coalesce(nullif(comp.invoice_prefix,''),'LDJ')||'-' end)||yr::text||'-'||lpad(seq::text,6,'0');
  select round(sum(quantity*unit_price_ttc*(1-discount_percent/100)),2),
         round(sum((quantity*unit_price_ttc*(1-discount_percent/100))/(1+vat_rate/100)),2)
    into ttc,tht from public.invoice_lines where invoice_id=inv.id;
  tva=round(ttc-tht,2);
  select coalesce(jsonb_agg(jsonb_build_object('position',position,'description',description,'quantity',quantity,'unit_price_ttc',unit_price_ttc,'vat_rate',vat_rate,'discount_percent',discount_percent) order by position,id)::text,'[]') into line_json from public.invoice_lines where invoice_id=inv.id;
  update public.invoices set number=n,status='final',issued_at=now(),total_ht=tht,total_vat=tva,total_ttc=ttc,
    integrity_hash=encode(digest(n||'|'||customer_json::text||'|'||line_json||'|'||tht::text||'|'||tva::text||'|'||ttc::text,'sha256'),'hex')
    where id=inv.id;
  insert into public.audit_events(company_id,actor_id,action,entity_type,entity_id,payload) values(inv.company_id,auth.uid(),'FINALIZED','invoice',inv.id,jsonb_build_object('number',n,'total_ttc',ttc));
  return n;
end$$;
grant execute on function public.finalize_invoice(uuid) to authenticated;

create or replace function public.attach_invoice_pdf(p_invoice_id uuid,p_path text)
returns void language plpgsql security definer set search_path=public as $$
declare inv public.invoices;
begin
  select * into inv from public.invoices where id=p_invoice_id for update;
  if not public.is_company_member(inv.company_id) or inv.status<>'final' then raise exception 'Accès refusé'; end if;
  if inv.pdf_path is not null and inv.pdf_path<>p_path then raise exception 'PDF déjà attaché'; end if;
  update public.invoices set pdf_path=p_path where id=p_invoice_id;
  insert into public.audit_events(company_id,actor_id,action,entity_type,entity_id,payload) values(inv.company_id,auth.uid(),'PDF_ATTACHED','invoice',inv.id,jsonb_build_object('path',p_path));
end$$;
grant execute on function public.attach_invoice_pdf(uuid,text) to authenticated;

-- RLS
alter table public.companies enable row level security;
alter table public.company_members enable row level security;
alter table public.events enable row level security;
alter table public.products enable row level security;
alter table public.intake_sessions enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_lines enable row level security;
alter table public.invoice_sequences enable row level security;
alter table public.audit_events enable row level security;

create policy companies_select on public.companies for select using(public.is_company_member(id));
create policy companies_update on public.companies for update using(public.has_company_role(id,array['owner','admin'])) with check(public.has_company_role(id,array['owner','admin']));
create policy members_select on public.company_members for select using(user_id=auth.uid() or public.is_company_member(company_id));
create policy events_select on public.events for select using(public.is_company_member(company_id));
create policy events_write on public.events for all using(public.has_company_role(company_id,array['owner','admin'])) with check(public.has_company_role(company_id,array['owner','admin']));
create policy products_select on public.products for select using(public.is_company_member(company_id));
create policy products_write on public.products for all using(public.has_company_role(company_id,array['owner','admin'])) with check(public.has_company_role(company_id,array['owner','admin']));
create policy intake_select on public.intake_sessions for select using(public.is_company_member(company_id));
create policy intake_insert on public.intake_sessions for insert with check(public.is_company_member(company_id) and created_by=auth.uid());
create policy invoice_select on public.invoices for select using(public.is_company_member(company_id));
create policy invoice_insert on public.invoices for insert with check(public.is_company_member(company_id) and created_by=auth.uid());
create policy invoice_update_draft on public.invoices for update using(public.is_company_member(company_id) and status='draft') with check(public.is_company_member(company_id));
create policy line_select on public.invoice_lines for select using(exists(select 1 from public.invoices i where i.id=invoice_id and public.is_company_member(i.company_id)));
create policy line_insert on public.invoice_lines for insert with check(exists(select 1 from public.invoices i where i.id=invoice_id and i.status='draft' and public.is_company_member(i.company_id)));
create policy line_update on public.invoice_lines for update using(exists(select 1 from public.invoices i where i.id=invoice_id and i.status='draft' and public.is_company_member(i.company_id)));
create policy line_delete on public.invoice_lines for delete using(exists(select 1 from public.invoices i where i.id=invoice_id and i.status='draft' and public.is_company_member(i.company_id)));
create policy audit_select on public.audit_events for select using(public.is_company_member(company_id));

-- Stockage privé des PDF
insert into storage.buckets(id,name,public) values('invoices','invoices',false) on conflict(id) do nothing;
create policy invoice_pdf_select on storage.objects for select to authenticated using(bucket_id='invoices' and public.is_company_member(((storage.foldername(name))[1])::uuid));
create policy invoice_pdf_insert on storage.objects for insert to authenticated with check(bucket_id='invoices' and public.is_company_member(((storage.foldername(name))[1])::uuid));

-- Realtime : permet la remontée instantanée du formulaire QR au vendeur.
do $$ begin
  alter publication supabase_realtime add table public.intake_sessions;
exception when duplicate_object then null; end $$;
