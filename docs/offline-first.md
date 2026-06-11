# Offline-First Setup

SplitPay now uses a local-first architecture:

- Expo React Native app
- PowerSync local SQLite
- Supabase Auth + Postgres
- PowerSync Cloud for sync
- Supabase Edge Functions for all writes and group lifecycle:
  - `sync-upload` — queued local data writes (expenses/splits/activity, renames, and **unclaimed** member-slot creation/removal); the server-side authorization boundary
  - `create-group` — ratifies a locally-created group on first connection, inserting its initial member slots and binding the creator's
  - `join-group` — previews a group's member slots, then joins by **claiming** a slot (or adding a new one), enforcing the optional password
  - `set-password` — sets / changes / removes a group's join password

## Member slots

A group is a set of named **member slots**. A slot may be:

- **claimed** — bound to a user (`members.user_id` is set); that user "is" this member, and
- **unclaimed** — just a name (`user_id IS NULL`) that anyone in the group can record
  expenses against, and that a future joiner can claim.

Rules (all enforced server-side):

- The creator defines the initial slots offline and claims one of them. Other
  people's slots start unclaimed.
- Any active member can add unclaimed slots (works offline; they sync as
  unclaimed) and rename unclaimed slots; a claimed slot is renamed only by its
  owner.
- **Claiming** a slot (assigning `user_id`) only ever happens through
  `create-group` (the creator) or `join-group` (a joiner). `sync-upload` never
  writes `user_id` and only ever creates unclaimed slots, so it can't be used to
  impersonate or to downgrade the creator's binding.
- A slot with expenses/splits can't be removed until they're settled and deleted.

## Environment Variables

Set these when running the mobile app:

```bash
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-publishable-or-anon-key
EXPO_PUBLIC_POWERSYNC_URL=https://your-instance.powersync.journeyapps.com
```

If these are missing, the app still works locally/offline but does not sync.

## Supabase

1. Create a Supabase project.
2. Enable anonymous auth.
3. Run `supabase/schema.sql` in the Supabase SQL editor.
4. Replace the `CHANGE_ME_STRONG_PASSWORD` placeholder for `powersync_role` in that
   SQL with a strong, unique password before running it. Use the same password
   when connecting PowerSync to Postgres (see the PowerSync section below). Never
   commit the real password.
5. Deploy the Edge Functions. From the repo root, after `supabase login` and
   `supabase link --project-ref <ref>`:

   ```bash
   npm run deploy:supabase
   ```

   This deploys `create-group`, `join-group`, `set-password`, and `sync-upload`.
   (`supabase/functions/_shared` is a shared module bundled into each function,
   not a function itself.)

### Group password protection

Groups can optionally require a password to join. The design keeps secrets off
clients:

- The password hash (PBKDF2-HMAC-SHA256) lives only in the server-only
  `group_secrets` table. It is **not** in the `powersync` publication and is
  revoked from the `authenticated` and `powersync_role` roles, so it never
  replicates to a device.
- Clients only ever see the replicated `groups.has_password` boolean.
- The password is verified once at join time by `join-group` (rate-limited via
  the server-only `join_attempts` table, with generic errors to avoid code
  enumeration). Durable proof of authorization is the member's row + JWT, not
  the password.
- All subsequent writes are authorized by `sync-upload`, which checks active
  group membership, never assigns `user_id`, and rejects client-side group
  creation.

## PowerSync

1. Create a PowerSync Cloud instance.
2. Connect it to Supabase Postgres using `powersync_role`.
3. Enable Supabase Auth in PowerSync.
4. Deploy `supabase/powersync-streams.yaml` as the sync stream config.

## Expo Go vs Production

The app currently uses `@powersync/adapter-sql-js` so it can run in Expo Go. This is the lowest-risk migration path, but PowerSync documents this adapter as development-only. Before production, switch to the OP-SQLite adapter:

```bash
npx expo install @powersync/op-sqlite @op-engineering/op-sqlite
```

Then replace the SQL.js open factory in `apps/mobile/src/localFirst/system.ts`.

Expo Web uses `@powersync/web` through `apps/mobile/src/localFirst/system.web.ts`. Its worker assets are copied to `apps/mobile/public/@powersync`; rerun `npx powersync-web copy-assets --output public` from `apps/mobile` after upgrading PowerSync Web.
