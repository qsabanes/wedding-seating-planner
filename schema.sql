-- Wedding Seating Planner — database schema + security.
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to re-run: it drops and recreates everything in this app's scope.

-- ============================================================
-- TABLES
-- ============================================================

create table if not exists weddings (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  event_date  date,
  created_at  timestamptz not null default now()
);

create table if not exists collaborators (
  id            uuid primary key default gen_random_uuid(),
  wedding_id    uuid not null references weddings(id) on delete cascade,
  user_id       uuid references auth.users(id) on delete cascade,
  invited_email text,
  role          text not null default 'editor',
  created_at    timestamptz not null default now(),
  unique (wedding_id, user_id)
);

create table if not exists guests (
  id          uuid primary key default gen_random_uuid(),
  wedding_id  uuid not null references weddings(id) on delete cascade,
  name        text not null,
  side        text,                         -- which partner's side (e.g. Quico / Laura)
  guest_group text,
  dietary     text,
  rsvp_status text default 'pending',
  plus_one    boolean default false,
  is_child    boolean not null default false,
  notes       text,
  created_at  timestamptz not null default now()
);

-- Idempotent upgrades for databases created before these columns existed:
alter table guests add column if not exists side text;
alter table guests add column if not exists is_child boolean not null default false;

create table if not exists tables (
  id          uuid primary key default gen_random_uuid(),
  wedding_id  uuid not null references weddings(id) on delete cascade,
  label       text not null,
  shape       text not null default 'round',  -- round | long | square
  seats       int  not null default 8,
  pos_x       real not null default 0,
  pos_y       real not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists seat_assignments (
  id          uuid primary key default gen_random_uuid(),
  wedding_id  uuid not null references weddings(id) on delete cascade,
  table_id    uuid not null references tables(id) on delete cascade,
  guest_id    uuid not null references guests(id) on delete cascade,
  seat_index  int,
  unique (guest_id)  -- a guest sits in at most one seat
);

create table if not exists constraints (
  id          uuid primary key default gen_random_uuid(),
  wedding_id  uuid not null references weddings(id) on delete cascade,
  guest_a     uuid not null references guests(id) on delete cascade,
  guest_b     uuid not null references guests(id) on delete cascade,
  kind        text not null,  -- together | apart
  created_at  timestamptz not null default now()
);

-- ============================================================
-- ACCESS HELPER
-- SECURITY DEFINER so it can check membership without triggering
-- RLS recursion between weddings <-> collaborators.
-- ============================================================

create or replace function can_access_wedding(wid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from weddings w
    where w.id = wid and w.owner_id = auth.uid()
  ) or exists (
    select 1 from collaborators c
    where c.wedding_id = wid and c.user_id = auth.uid()
  );
$$;

create or replace function is_wedding_owner(wid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from weddings w
    where w.id = wid and w.owner_id = auth.uid()
  );
$$;

-- When a user signs in, attach any invites addressed to their email.
-- SECURITY DEFINER so the invitee can claim a row the owner created.
create or replace function claim_invites()
returns void
language sql
security definer
set search_path = public
as $$
  update collaborators
  set user_id = auth.uid()
  where user_id is null
    and lower(invited_email) = lower(auth.jwt() ->> 'email');
$$;

-- ============================================================
-- ROW-LEVEL SECURITY
-- ============================================================

alter table weddings        enable row level security;
alter table collaborators   enable row level security;
alter table guests          enable row level security;
alter table tables          enable row level security;
alter table seat_assignments enable row level security;
alter table constraints     enable row level security;

-- weddings -------------------------------------------------
drop policy if exists weddings_select on weddings;
drop policy if exists weddings_insert on weddings;
drop policy if exists weddings_update on weddings;
drop policy if exists weddings_delete on weddings;

create policy weddings_select on weddings for select
  using (can_access_wedding(id));
create policy weddings_insert on weddings for insert
  with check (owner_id = auth.uid());
create policy weddings_update on weddings for update
  using (can_access_wedding(id)) with check (can_access_wedding(id));
create policy weddings_delete on weddings for delete
  using (owner_id = auth.uid());

-- collaborators (only the owner manages the invite list) ----
drop policy if exists collab_select on collaborators;
drop policy if exists collab_write on collaborators;

create policy collab_select on collaborators for select
  using (can_access_wedding(wedding_id));
create policy collab_write on collaborators for all
  using (is_wedding_owner(wedding_id))
  with check (is_wedding_owner(wedding_id));

-- child tables: full access if you can access the wedding ---
-- (one identical policy set per table)

drop policy if exists guests_all on guests;
create policy guests_all on guests for all
  using (can_access_wedding(wedding_id))
  with check (can_access_wedding(wedding_id));

drop policy if exists tables_all on tables;
create policy tables_all on tables for all
  using (can_access_wedding(wedding_id))
  with check (can_access_wedding(wedding_id));

drop policy if exists seats_all on seat_assignments;
create policy seats_all on seat_assignments for all
  using (can_access_wedding(wedding_id))
  with check (can_access_wedding(wedding_id));

drop policy if exists constraints_all on constraints;
create policy constraints_all on constraints for all
  using (can_access_wedding(wedding_id))
  with check (can_access_wedding(wedding_id));
