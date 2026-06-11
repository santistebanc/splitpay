# SplitPay

Mobile-first bill splitting for trips with friends. The app uses Expo React Native for iOS, Android, and web, with offline-first local storage and optional sync through Supabase + PowerSync.

Users do not create accounts in the UI. Each install keeps an anonymous local device id, and Supabase anonymous auth is used behind the scenes when sync is configured.

## Apps

- `apps/mobile`: Expo React Native app
- `supabase`: Postgres schema, PowerSync stream config, and the upload Edge Function

## Local Setup

```bash
npm install
npm run dev
```

This exports and serves the web app on `http://127.0.0.1:8082`.

For Expo's interactive mobile tools, use:

```bash
npm run dev:mobile
```

The app works locally without server environment variables. In that mode, changes are stored offline on the device only and do not sync to other users.

## Sync Setup

Copy the example env file and fill in Supabase + PowerSync values:

```bash
cp apps/mobile/.env.example apps/mobile/.env
```

Required for sync:

- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_ANON_KEY`
- `EXPO_PUBLIC_POWERSYNC_URL`

Then follow [docs/offline-first.md](docs/offline-first.md) to apply the Supabase schema, deploy the Edge Functions, and configure PowerSync streams.

Deploy the Supabase Edge Functions used by the app (from the repo root, after `supabase login` + `supabase link`):

```bash
npm run deploy:supabase
```

This deploys all four functions: `sync-upload` (queued offline writes + the write authorization boundary), `create-group` (ratifies offline-created groups), `join-group` (join by code, enforcing the optional password), and `set-password` (set/change/remove a group's join password).

## Checks

```bash
npm run typecheck
npm --workspace apps/mobile run export:web
```

The web build uses PowerSync worker assets under `apps/mobile/public/@powersync`. If PowerSync Web is upgraded, refresh them with:

```bash
cd apps/mobile
npx powersync-web copy-assets --output public
```
