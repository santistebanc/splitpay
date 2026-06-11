-- SplitPay offline-first schema for Supabase + PowerSync.
-- IDs are text because clients create rows offline before the server sees them.

create table if not exists public.groups (
  id text primary key,
  code text not null unique,
  name text not null,
  currency text not null default 'EUR',
  has_password boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Backfill for existing databases.
alter table public.groups add column if not exists has_password boolean not null default false;

-- Server-only group secrets. This table is deliberately NOT in the PowerSync
-- publication and has no RLS policies, so it is never replicated to clients and
-- is unreadable by the authenticated role. Only the service role (Edge
-- Functions) touches it. Stores a slow PBKDF2 hash, never the password.
create table if not exists public.group_secrets (
  group_id text primary key references public.groups(id) on delete cascade,
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.group_secrets enable row level security;
revoke all on public.group_secrets from anon, authenticated;

-- Server-only audit of password-gated join attempts for rate limiting.
create table if not exists public.join_attempts (
  id text primary key,
  group_id text not null,
  user_id uuid not null,
  success boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists join_attempts_lookup_idx
  on public.join_attempts(group_id, user_id, created_at desc);

alter table public.join_attempts enable row level security;
revoke all on public.join_attempts from anon, authenticated;

create table if not exists public.members (
  id text primary key,
  group_id text not null references public.groups(id) on delete cascade,
  display_name text not null,
  device_id text,
  user_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists members_group_user_idx
  on public.members(group_id, user_id)
  where user_id is not null and deleted_at is null;

create table if not exists public.expenses (
  id text primary key,
  group_id text not null references public.groups(id) on delete cascade,
  description text not null,
  amount_cents integer not null check (amount_cents > 0),
  paid_by_member_id text not null references public.members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.expense_splits (
  id text primary key,
  expense_id text not null references public.expenses(id) on delete cascade,
  member_id text not null references public.members(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.activity_logs (
  id text primary key,
  group_id text not null references public.groups(id) on delete cascade,
  type text not null,
  actor_member_id text references public.members(id),
  actor_name text,
  summary text not null,
  metadata_json text not null default '{}',
  created_at timestamptz not null default now()
);

grant select, insert, update, delete on public.groups to authenticated;
grant select, insert, update, delete on public.members to authenticated;
grant select, insert, update, delete on public.expenses to authenticated;
grant select, insert, update, delete on public.expense_splits to authenticated;
grant select, insert, update, delete on public.activity_logs to authenticated;

alter table public.groups enable row level security;
alter table public.members enable row level security;
alter table public.expenses enable row level security;
alter table public.expense_splits enable row level security;
alter table public.activity_logs enable row level security;

create policy "group members can read groups" on public.groups
  for select to authenticated
  using (
    exists (
      select 1 from public.members
      where members.group_id = groups.id
        and members.user_id = auth.uid()
        and members.deleted_at is null
    )
  );

create policy "members can read members in their groups" on public.members
  for select to authenticated
  using (
    exists (
      select 1 from public.members own_membership
      where own_membership.group_id = members.group_id
        and own_membership.user_id = auth.uid()
        and own_membership.deleted_at is null
    )
  );

create policy "members can read expenses in their groups" on public.expenses
  for select to authenticated
  using (
    exists (
      select 1 from public.members
      where members.group_id = expenses.group_id
        and members.user_id = auth.uid()
        and members.deleted_at is null
    )
  );

create policy "members can read splits in their groups" on public.expense_splits
  for select to authenticated
  using (
    exists (
      select 1
      from public.expenses
      join public.members on members.group_id = expenses.group_id
      where expenses.id = expense_splits.expense_id
        and members.user_id = auth.uid()
        and members.deleted_at is null
    )
  );

create policy "members can read activity in their groups" on public.activity_logs
  for select to authenticated
  using (
    exists (
      select 1 from public.members
      where members.group_id = activity_logs.group_id
        and members.user_id = auth.uid()
        and members.deleted_at is null
    )
  );

-- Writes are performed by the sync-upload Edge Function using the service role.
-- This keeps validation centralized instead of exposing direct table writes.

-- Set a strong, unique password here before running this anywhere real.
create role powersync_role with replication bypassrls login password 'CHANGE_ME_STRONG_PASSWORD';
grant select on all tables in schema public to powersync_role;
alter default privileges in schema public grant select on tables to powersync_role;

-- Secrets must never be replicated, even to the replication role.
revoke all on public.group_secrets from powersync_role;
revoke all on public.join_attempts from powersync_role;

drop publication if exists powersync;
create publication powersync for table
  public.groups,
  public.members,
  public.expenses,
  public.expense_splits,
  public.activity_logs;

