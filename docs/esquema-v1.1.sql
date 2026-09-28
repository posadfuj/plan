-- =============================================================================
-- Aiment Wallet: esquema de base de datos v1.1 (PostgreSQL 16, local-first)
-- -----------------------------------------------------------------------------
-- Es el punto de partida para las migraciones de Drizzle; no se ejecuta tal cual
-- en producción. Corre igual en PostgreSQL 16 local (Docker) y en cualquier
-- Postgres gestionado. Las tablas viven en el esquema "app" y solo la API Node
-- accede, con el rol app_api (sin BYPASSRLS). Si el proveedor final es
-- Supabase, el esquema "app" NO se expone por su Data API.
-- Las tablas de autenticación (user, session, account, verification) las crea
-- y migra Better Auth en el esquema "auth"; aquí no se definen.
--
-- Aislamiento por tenant (defensa en profundidad):
--   1. La API filtra siempre por organization_id.
--   2. RLS: la API abre cada transacción con
--        select set_config('app.org_id', '<uuid>', true);
--      y los jobs de sistema o el servicio web de Apple usan
--        select set_config('app.scope', 'system', true);
-- =============================================================================

create extension if not exists pgcrypto;
create extension if not exists citext;

create schema if not exists app;
set search_path = app, public;

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------
create type org_status        as enum ('draft', 'pending_review', 'live', 'suspended', 'cancelled');
create type member_role       as enum ('owner', 'admin', 'staff');
create type record_status     as enum ('active', 'inactive');
create type program_mode      as enum ('stamps', 'points');
create type program_status    as enum ('draft', 'active', 'archived');
create type reward_kind       as enum ('goal', 'catalog', 'gift');
create type membership_status as enum ('active', 'blocked', 'closed');
create type customer_status   as enum ('active', 'anonymized');
create type ledger_kind       as enum ('earn', 'bonus', 'convert', 'redeem', 'adjust', 'expire', 'reversal');
create type actor_type        as enum ('staff', 'owner', 'automation', 'system', 'superadmin');
create type earned_source     as enum ('goal', 'welcome', 'automation', 'manual');
create type earned_status     as enum ('available', 'redeemed', 'expired', 'voided');
create type redemption_status as enum ('completed', 'voided');
create type wallet_provider   as enum ('apple', 'google');
create type pass_status       as enum ('active', 'revoked');
create type link_kind         as enum ('registration', 'campaign', 'custom');
create type channel_kind      as enum ('qr', 'nfc', 'direct', 'unknown');
create type tag_kind          as enum ('qr', 'nfc');
create type consent_kind      as enum ('terms', 'privacy', 'marketing');

-- Helper para RLS
create or replace function app.tenant_ok(org uuid) returns boolean
language sql stable as $$
  select coalesce(current_setting('app.scope', true), '') = 'system'
      or org = nullif(current_setting('app.org_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Planes y organizaciones
-- ---------------------------------------------------------------------------
create table plans (
  code        text primary key,                 -- 'basic', 'pro', 'multi'
  name        text not null,
  limits      jsonb not null default '{}',      -- {"branches":1,"staff":5,"customers":2000}
  features    jsonb not null default '{}',      -- {"automations":false,"csv":true}
  active      boolean not null default true
);

create table organizations (
  id            uuid primary key default gen_random_uuid(),   -- UUIDv7 generado en la API
  slug          citext not null unique,
  name          text not null,
  legal_name    text,
  tax_id        text,                                          -- RUC
  category      text,                                          -- rubro / plantilla de origen
  status        org_status not null default 'draft',
  plan_code     text not null references plans(code),
  timezone      text not null default 'America/Lima',
  currency      char(3) not null default 'PEN',
  locale        text not null default 'es-PE',
  branding      jsonb not null default '{}',   -- logo, colores, textos, "powered_by": true
  settings      jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table org_feature_overrides (
  organization_id uuid not null references organizations(id),
  feature         text not null,
  value           jsonb not null,
  primary key (organization_id, feature)
);

create table branches (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name            text not null,
  address         text,
  latitude        numeric(9,6),
  longitude       numeric(9,6),
  status          record_status not null default 'active',
  created_at      timestamptz not null default now()
);
create index on branches (organization_id);

-- ---------------------------------------------------------------------------
-- Usuarios, trabajadores y dispositivos de caja
-- ---------------------------------------------------------------------------
-- users.id = id del usuario en Better Auth (dueños, admins y superadmin; generado como UUID)
create table users (
  id             uuid primary key,
  email          citext not null unique,
  full_name      text,
  is_superadmin  boolean not null default false,
  created_at     timestamptz not null default now()
);

-- Un trabajador puede no tener login propio (user_id null): entra con dispositivo + PIN
create table organization_users (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references organizations(id),
  user_id             uuid references users(id),
  display_name        text not null,
  role                member_role not null,
  branch_ids          uuid[],                           -- null = todas las sucursales
  pin_hash            text,                             -- argon2id
  pin_failed_attempts int not null default 0,
  pin_locked_until    timestamptz,
  status              record_status not null default 'active',
  created_at          timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index on organization_users (organization_id);

create table worker_devices (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references organizations(id),
  branch_id          uuid not null references branches(id),
  name               text not null,                     -- "Celular caja 1"
  device_secret_hash text not null,                     -- se guarda en cookie httpOnly del dispositivo
  authorized_by      uuid not null references organization_users(id),
  last_seen_at       timestamptz,
  revoked_at         timestamptz,
  created_at         timestamptz not null default now()
);
create index on worker_devices (organization_id);

create table staff_sessions (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references organizations(id),
  device_id            uuid not null references worker_devices(id),
  organization_user_id uuid not null references organization_users(id),
  expires_at           timestamptz not null,            -- p. ej. fin del turno / 12 h
  revoked_at           timestamptz,
  created_at           timestamptz not null default now()
);
create index on staff_sessions (device_id, expires_at);

-- ---------------------------------------------------------------------------
-- Programa, reglas versionadas y premios
-- ---------------------------------------------------------------------------
create table loyalty_programs (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references organizations(id),
  name               text not null,                     -- "Club Barbería Pedro"
  mode               program_mode not null,             -- no se cambia si ya hay membresías
  unit_label         text not null default 'sellos',    -- "sellos", "puntos", "lavados"
  status             program_status not null default 'draft',
  current_version_id uuid,                              -- FK diferida más abajo
  design             jsonb not null default '{}',       -- colores de pase, strip, textos
  created_at         timestamptz not null default now()
);
-- MVP: un solo programa activo por organización
create unique index one_active_program_per_org
  on loyalty_programs (organization_id) where status = 'active';

create table program_rule_versions (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations(id),
  program_id        uuid not null references loyalty_programs(id),
  version           int not null,
  -- {"type":"per_visit","units":1} | {"type":"per_amount","amount_per_unit":1.00,"rounding":"floor"}
  earn_rule         jsonb not null,
  goal              int,                                -- sellos para premio (modo stamps)
  welcome_bonus     jsonb not null default '{"type":"none"}',  -- none | units | reward
  -- {"cooldown_minutes":240,"max_units_per_tx":1,"staff_daily_units":200,"max_amount_per_tx":500}
  limits            jsonb not null default '{}',
  expiration_months int,                                -- null = sin expiración (piloto)
  created_by        uuid references organization_users(id),
  created_at        timestamptz not null default now(),
  unique (program_id, version),
  check (goal is null or goal > 0),
  check (expiration_months is null or expiration_months > 0)
);

alter table loyalty_programs
  add constraint loyalty_programs_current_version_fk
  foreign key (current_version_id) references program_rule_versions(id)
  deferrable initially deferred;

create table rewards (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  program_id      uuid not null references loyalty_programs(id),
  kind            reward_kind not null,    -- goal: al completar sellos; catalog: cuesta puntos; gift: bienvenida/automatización
  name            text not null,           -- "Corte gratis"
  description     text,
  cost            int,                     -- solo catalog (puntos)
  validity_days   int,                     -- vigencia del premio ganado
  active          boolean not null default true,
  sort_order      int not null default 0,
  created_at      timestamptz not null default now(),
  check ((kind = 'catalog') = (cost is not null)),
  check (cost is null or cost > 0)
);
create index on rewards (program_id);

-- ---------------------------------------------------------------------------
-- Clientes (por negocio), consentimientos y membresías
-- ---------------------------------------------------------------------------
create table customers (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  full_name       text,
  phone_e164      text,                                 -- +51XXXXXXXXX
  email           citext,
  birth_date      date,
  status          customer_status not null default 'active',
  anonymized_at   timestamptz,
  created_at      timestamptz not null default now(),
  check (status = 'anonymized' or (full_name is not null and phone_e164 is not null))
);
create unique index customers_org_phone on customers (organization_id, phone_e164)
  where status = 'active';
create index on customers (organization_id, created_at desc);

create table consent_versions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id),    -- null = plantilla de plataforma
  kind            consent_kind not null,
  version         int not null,
  body_md         text not null,
  published_at    timestamptz not null default now()
);
create unique index consent_versions_uniq
  on consent_versions (coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, version);

create table customer_consents (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references organizations(id),
  customer_id        uuid not null references customers(id),
  consent_version_id uuid not null references consent_versions(id),
  granted            boolean not null,                  -- false = baja / revocación
  channel            channel_kind not null,
  ip                 inet,
  user_agent         text,
  created_at         timestamptz not null default now()
);
create index on customer_consents (customer_id, created_at desc);

create table memberships (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references organizations(id),
  program_id         uuid not null references loyalty_programs(id),
  customer_id        uuid not null references customers(id),
  member_scan_token  text not null unique,      -- 128 bits, va en el QR que escanea la caja (/s/...); no abre datos privados
  web_card_token     text not null unique,      -- 128 bits, URL secreta de la tarjeta web (/m/...); revocable (rotación)
  short_code         text not null,             -- 6–8 caracteres, respaldo manual en caja
  balance            int not null default 0,    -- materializado, solo lo cambia la API en transacción
  lifetime_earned    int not null default 0,
  status             membership_status not null default 'active',
  first_validated_at timestamptz,               -- 1.ª visita validada: dispara el bono de bienvenida
  last_activity_at   timestamptz,               -- base para expiración por inactividad
  version            int not null default 0,
  created_at         timestamptz not null default now(),
  unique (program_id, customer_id),
  unique (organization_id, short_code),
  check (balance >= 0)
);
create index on memberships (organization_id, last_activity_at);

-- ---------------------------------------------------------------------------
-- Ledger inmutable, premios ganados y canjes
-- ---------------------------------------------------------------------------
create table ledger_entries (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references organizations(id),
  membership_id      uuid not null references memberships(id),
  branch_id          uuid references branches(id),
  kind               ledger_kind not null,
  delta              int not null,
  amount_money       numeric(12,2),             -- importe informado por caja (modo points)
  rule_version_id    uuid not null references program_rule_versions(id),
  actor_type         actor_type not null,
  actor_id           uuid,                      -- organization_users.id / users.id / automations.id
  device_id          uuid references worker_devices(id),
  reason             text,
  reverses_entry_id  uuid references ledger_entries(id),
  idempotency_key    text not null,
  balance_after      int not null,              -- foto del saldo, útil para auditoría y soporte
  created_at         timestamptz not null default now(),
  unique (organization_id, idempotency_key),
  check (delta <> 0),
  check ((kind = 'reversal') = (reverses_entry_id is not null)),
  check (kind <> 'adjust' or reason is not null),
  check (balance_after >= 0)
);
create index on ledger_entries (organization_id, membership_id, created_at desc);
create index on ledger_entries (organization_id, created_at desc);
create index on ledger_entries (organization_id, actor_id, created_at desc);
-- Un movimiento solo puede anularse una vez
create unique index ledger_single_reversal on ledger_entries (reverses_entry_id)
  where reverses_entry_id is not null;

-- El pasado no se edita: se bloquea UPDATE/DELETE a nivel de base
create or replace function app.ledger_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'ledger_entries es inmutable: crea una reversa o ajuste';
end $$;
create trigger ledger_no_update before update or delete on ledger_entries
  for each row execute function app.ledger_immutable();

create table earned_rewards (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  membership_id   uuid not null references memberships(id),
  reward_id       uuid not null references rewards(id),
  source          earned_source not null,
  source_entry_id uuid references ledger_entries(id),   -- el 'convert' que lo generó (modo stamps)
  status          earned_status not null default 'available',
  expires_at      timestamptz,
  created_at      timestamptz not null default now(),
  redeemed_at     timestamptz
);
create index on earned_rewards (membership_id) where status = 'available';

create table redemptions (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references organizations(id),
  membership_id        uuid not null references memberships(id),
  reward_id            uuid not null references rewards(id),
  earned_reward_id     uuid references earned_rewards(id),   -- canje de premio ganado
  ledger_entry_id      uuid references ledger_entries(id),   -- canje de catálogo (descuenta puntos)
  branch_id            uuid references branches(id),
  organization_user_id uuid references organization_users(id),
  device_id            uuid references worker_devices(id),
  idempotency_key      text not null,
  status               redemption_status not null default 'completed',
  created_at           timestamptz not null default now(),
  unique (organization_id, idempotency_key),
  check ((earned_reward_id is null) <> (ledger_entry_id is null))
);
-- Un premio ganado se canjea una sola vez
create unique index redemptions_single_use on redemptions (earned_reward_id)
  where earned_reward_id is not null and status = 'completed';

-- ---------------------------------------------------------------------------
-- Wallet
-- ---------------------------------------------------------------------------
create table wallet_passes (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id),
  membership_id    uuid not null references memberships(id),
  provider         wallet_provider not null,
  issuer_ref       text not null,               -- cuenta emisora usada (p. ej. 'apple:pass.com.aimentwallet.loyalty@individual-2026')
  external_id      text not null,               -- Apple serialNumber / Google objectId (nunca un id interno)
  auth_token_hash  text,                        -- Apple authenticationToken (sha256)
  pass_version     int not null default 1,      -- sube con cada cambio visible
  status           pass_status not null default 'active',
  last_synced_at   timestamptz,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),   -- "passesUpdatedSince" de Apple
  unique (provider, external_id),
  unique (membership_id, provider)
);

create table apple_devices (
  id                uuid primary key default gen_random_uuid(),
  device_library_id text not null unique,
  push_token        text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table apple_registrations (
  apple_device_id uuid not null references apple_devices(id) on delete cascade,
  wallet_pass_id  uuid not null references wallet_passes(id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (apple_device_id, wallet_pass_id)
);
create index on apple_registrations (wallet_pass_id);

create table google_wallet_classes (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  program_id      uuid not null unique references loyalty_programs(id),
  issuer_ref      text not null,                -- cuenta emisora de Google usada
  class_id        text not null unique,         -- "<issuerId>.aw_<program>"
  review_status   text,
  last_synced_at  timestamptz,
  last_error      text
);

-- ---------------------------------------------------------------------------
-- URLs cortas, material físico y medición de canal
-- ---------------------------------------------------------------------------
create table short_links (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,         -- "X8P2K" (sin caracteres ambiguos)
  organization_id uuid not null references organizations(id),
  branch_id       uuid references branches(id),
  kind            link_kind not null default 'registration',
  target          text not null,                -- ruta interna o URL absoluta
  status          record_status not null default 'active',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on short_links (organization_id);

create table physical_tags (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  short_link_id   uuid not null references short_links(id),
  kind            tag_kind not null,
  internal_code   text not null unique,         -- código de inventario Aiment Card
  nfc_uid         text,
  locked          boolean not null default false,
  delivered_at    timestamptz,
  notes           text
);

create table channel_visits (
  id                      bigserial primary key,
  organization_id         uuid not null references organizations(id),
  short_link_id           uuid not null references short_links(id),
  channel                 channel_kind not null,
  visitor_hash            text,                 -- hash rotativo, sin IP en claro
  converted_membership_id uuid references memberships(id),
  created_at              timestamptz not null default now()
);
create index on channel_visits (organization_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Outbox, automatizaciones y auditoría
-- ---------------------------------------------------------------------------
create table event_outbox (
  id              bigserial primary key,
  organization_id uuid not null references organizations(id),
  type            text not null,                -- ledger.created, reward.earned, membership.created...
  aggregate_id    uuid not null,                -- normalmente membership_id
  payload         jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  dispatched_at   timestamptz,
  attempts        int not null default 0
);
create index event_outbox_pending on event_outbox (id) where dispatched_at is null;

create table automations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  program_id      uuid not null references loyalty_programs(id),
  key             text not null,                -- welcome | goal_reached | almost_there | birthday | inactivity
  enabled         boolean not null default true,
  config          jsonb not null default '{}',
  updated_at      timestamptz not null default now(),
  unique (program_id, key)
);

create table automation_runs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  automation_id   uuid not null references automations(id),
  membership_id   uuid not null references memberships(id),
  idempotency_key text not null unique,         -- p. ej. "birthday:<membership>:2026"
  status          text not null,                -- done | skipped | failed
  result          jsonb,
  created_at      timestamptz not null default now()
);

create table audit_logs (
  id              bigserial primary key,
  organization_id uuid references organizations(id),   -- null = acción de plataforma
  actor_type      actor_type not null,
  actor_id        uuid,
  action          text not null,                -- "program.rule_changed", "ledger.adjust", "org.suspended"...
  entity_type     text not null,
  entity_id       uuid,
  before          jsonb,
  after           jsonb,
  ip              inet,
  created_at      timestamptz not null default now()
);
create index on audit_logs (organization_id, created_at desc);

-- Fase 2 (se crea desde ya para no migrar datos después)
create table subscriptions (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null unique references organizations(id),
  plan_code          text not null references plans(code),
  status             text not null default 'trial',   -- trial | active | past_due | cancelled
  current_period_end timestamptz,
  provider           text,                             -- mercadopago | culqi | manual
  provider_ref       text,
  created_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS en todas las tablas con organization_id
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'branches','organization_users','worker_devices','staff_sessions','loyalty_programs',
    'program_rule_versions','rewards','customers','customer_consents','memberships',
    'ledger_entries','earned_rewards','redemptions','wallet_passes','google_wallet_classes',
    'short_links','physical_tags','channel_visits','event_outbox','automations',
    'automation_runs','org_feature_overrides','subscriptions'
  ] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format(
      'create policy tenant_isolation on app.%I using (app.tenant_ok(organization_id)) with check (app.tenant_ok(organization_id))', t);
  end loop;
end $$;

alter table organizations enable row level security;
alter table organizations force row level security;
create policy tenant_isolation on organizations
  using (app.tenant_ok(id)) with check (app.tenant_ok(id));

alter table audit_logs enable row level security;
alter table audit_logs force row level security;
create policy tenant_isolation on audit_logs
  using (coalesce(current_setting('app.scope', true), '') = 'system'
         or organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (true);                             -- se puede escribir siempre, leer solo lo propio

-- Rol de la API: sin BYPASSRLS
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_api') then
    create role app_api nologin;
  end if;
end $$;
grant usage on schema app to app_api;
grant select, insert, update, delete on all tables in schema app to app_api;
grant usage, select on all sequences in schema app to app_api;
revoke update, delete on ledger_entries from app_api;
revoke update, delete on audit_logs from app_api;
