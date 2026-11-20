-- Relate — Supabase schema
-- Reconstructed from the queries in server.js. Run it in the Supabase SQL editor on a fresh project;
-- if you already have these tables, compare column by column rather than running it blind.

create extension if not exists pgcrypto; -- gen_random_uuid()

-- your own profile: a single row with id 'me'
create table if not exists profiles (
  id            text primary key default 'me',
  name          text,
  role          text,
  offer         text,
  looking       text,
  tone          text,
  linkedin_url  text,
  linkedin_card jsonb,
  photo         text,          -- data: URI or https URL
  updated_at    timestamptz default now()
);

-- integration keys: a single row with id 'me' (never returned in full by the API)
create table if not exists settings (
  id          text primary key default 'me',
  exa_key     text,
  ai_provider text,
  ai_key      text,
  updated_at  timestamptz default now()
);

-- the people you've met
create table if not exists relationships (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  met_context  text default '',
  note         text not null,
  contact      jsonb default '{}'::jsonb,   -- role, email, phone, linkedin, want
  profile_card jsonb,                        -- pulled via Exa: headline, about, photo, research[]
  research     jsonb default '[]'::jsonb,    -- agent findings
  assessment   jsonb,                        -- agent assessment + your decision
  brief        jsonb,
  card         jsonb,                        -- shareable insight card (/share/:id)
  next_action  text,
  interactions jsonb default '[]'::jsonb,    -- notes and voice notes (base64 audio)
  deck_job_id  uuid,                         -- latest talk track for this person
  created_at   timestamptz default now()
);

-- ---- job queues the QwenWork agent works through ----
create table if not exists profile_jobs (
  id           uuid primary key default gen_random_uuid(),
  linkedin_url text,
  name         text,
  status       text not null default 'queued', -- queued | done | failed
  card         jsonb,
  note         text,
  created_at   timestamptz default now()
);

create table if not exists research_jobs (
  id              uuid primary key default gen_random_uuid(),
  relationship_id uuid references relationships(id) on delete cascade,
  name            text not null,
  context         text,
  status          text not null default 'queued',
  findings        jsonb,
  assessment      jsonb,
  created_at      timestamptz default now()
);

create table if not exists ocr_jobs (
  id         uuid primary key default gen_random_uuid(),
  image      text not null,                 -- data: URI of the business card
  status     text not null default 'queued',
  fields     jsonb,
  created_at timestamptz default now()
);

create table if not exists transcribe_jobs (
  id         uuid primary key default gen_random_uuid(),
  audio      text not null,                 -- data: URI of the voice note
  status     text not null default 'queued',
  text       text,
  created_at timestamptz default now()
);

-- ---- shareable pages ----
create table if not exists deck_jobs (
  id              uuid primary key default gen_random_uuid(),
  relationship_id uuid references relationships(id) on delete cascade,
  name            text not null,
  context         text,
  status          text not null default 'queued',
  deck            jsonb,
  pdf             text,                     -- base64 or data: URI
  accepted        boolean default false,
  responded_at    timestamptz,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create table if not exists talk_jobs (
  id              uuid primary key default gen_random_uuid(),
  relationship_id uuid references relationships(id) on delete cascade,
  name            text not null,
  status          text not null default 'queued',
  track           jsonb,                    -- { role, topics: [{ topic, why, questions[], bring }] }
  picked_topic    integer,
  responded_at    timestamptz,
  created_at      timestamptz default now()
);

-- the API only ever PATCHes these rows, so they must exist
insert into profiles (id) values ('me') on conflict do nothing;
insert into settings (id) values ('me') on conflict do nothing;

-- Access: server.js talks to Supabase with SUPABASE_ANON_KEY, so these tables need policies that let
-- that key read and write. Anyone holding the anon key can then do the same, so keep it server-side
-- only (it is never sent to the browser), or switch server.js to a service-role key and keep RLS on
-- with no anon policies.
