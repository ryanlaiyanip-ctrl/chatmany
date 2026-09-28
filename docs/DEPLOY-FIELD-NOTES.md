# chatmany deploy — field notes from a real end-to-end install (Aug 17, 2026)

A live-verified record of deploying chatmany from a fresh clone to a working Instagram
connection, including every failure actually hit along the way and what each one turned out
to mean. No secrets in this file.

The README is the authoritative, newer guide. This install used polling only, so it does not
turn on instant delivery (README step 3.5). Where the two differ, follow the README. The traps
below (T1–T6) are the part the README does not cover.

## The happy path this install followed (in the order that worked)

1. **Cloudflare auth** — `npx wrangler login` (browser OAuth). One-time.
2. **Create the database** — `npx wrangler d1 create chatmany` → paste the printed
   `database_id` into `wrangler.toml`.
3. **Migrations** — `npm run db:migrate:remote` (applies every file in `schema/`).
4. **First deploy** — `npx wrangler deploy`. This is where the workers.dev subdomain gets
   claimed (see trap T1). The printed URL (`https://chatmany.<subdomain>.workers.dev`) is
   `MY ADDRESS` for everything below.
5. **Set `REDIRECT_URI`** in `wrangler.toml` to `MY ADDRESS/auth/callback`, redeploy.
6. **Owner token** — invent one (`openssl rand -hex 32`), store with
   `wrangler secret put OWNER_TOKEN` (or `wrangler secret bulk secrets.json`).
7. **Meta app** — developers.facebook.com → Create app → use case
   **"Manage messaging & content on Instagram"** → no business portfolio → Create.
8. **API setup with Instagram login** (Use cases → Customize):
   - "Add all required permissions" → must show a green check (verify — first click can
     silently not register; re-click until the button becomes "Go to permissions and features").
   - Copy **Instagram app ID + Instagram app secret** from THIS page (trap T2).
   - Section "Set up Instagram business login" → enter `MY ADDRESS/auth/callback` → Save.
   - "Business login settings" → confirm the same redirect URI is listed; add
     `MY ADDRESS/data-deletion` as the data deletion URL.
9. **App settings → Basic** — privacy policy `MY ADDRESS/privacy`, terms `MY ADDRESS/terms`,
   data deletion `MY ADDRESS/data-deletion`, category (e.g. Messaging) → Save. These unlock
   the Publish button.
10. **Publish** (sidebar) → Publish → "Your app was successfully published".
11. **Instagram Tester role** (trap T3 — the one that cost the most time):
    App roles → Roles → Add People → **Instagram Tester** → type the IG username → Add.
    Then, logged into that IG account **in a desktop browser**:
    instagram.com → Settings → **Apps and websites → Tester Invites → Accept**.
12. **Worker secrets** — `APP_ID` + `APP_SECRET` (the Instagram pair from step 8) via
    `wrangler secret bulk`.
13. **Connect** — open `MY ADDRESS/auth/authorize`, click Allow on Instagram's consent page →
    "Connected ✅ … Token valid ~60 days". Verify with
    `curl -H "Authorization: Bearer $OWNER_TOKEN" MY_ADDRESS/api/status`.

## Traps hit in this install (with the errors they actually produce)

**T1 — workers.dev subdomain collision.** A fresh Cloudflare account has no workers.dev
subdomain, wrangler auto-tries the worker name (`chatmany`) which is taken, and wrangler v4
has no interactive way to pick another. Fix: register one via the dashboard onboarding page,
or API: `PUT /accounts/{account_id}/workers/subdomain {"subdomain":"<name>"}`. Then deploy.
Also: the new `*.workers.dev` hostname serves TLS errors (curl exit 35) for ~1 minute after
first deploy — wait, don't debug.

**T2 — the two ID/secret pairs.** App settings → Basic shows an "App ID/App secret" that is
NOT the right pair. The right one is labeled **Instagram app ID / Instagram app secret** on
Use cases → Customize → API setup with Instagram login. The wrong pair fails only at the
very end (OAuth callback), after everything else looks perfect.

**T3 — missing Instagram Tester role (the big one).** With the app Live, permissions granted,
correct ID pair, and a working OAuth consent, EVERY graph.instagram.com call — the long-lived
token exchange, plain `/me`, everything — returns:

```json
{"error":{"message":"Unsupported request - method type: get","type":"IGApiException","code":100}}
```

This error says nothing about roles. It is not about the HTTP method (POST returns the same
message with "post"), not about the API version prefix, not about the token (the token is
valid — fake tokens fail differently). The fix is entirely non-obvious: the Instagram account
must hold the **Instagram Tester** role on the app AND have accepted the invite (desktop web
only; the phone app has no tester-invites screen). The moment the invite is accepted, the
exact same calls succeed. Older docs/reports show this failure as "Insufficient Developer
Role" — Meta changed the error text to something worse.

**T4 — token endpoints are unversioned.** `graph.instagram.com/access_token` and
`/refresh_access_token` — no `/vXX.X/` prefix (both paths exist, but code in this repo now
pins the documented unversioned form, verified live).

**T5 — OAuth state is single-slot.** Hitting `/auth/authorize` twice (browser prefetch,
double-click) overwrites the stored CSRF state and the first consent flow lands on
"Invalid state (possible CSRF)". Retrying the connect once fixes it.

**T6 — publish-state silence (README step 3.6).** An unpublished app returns
empty comment/message lists with no error. Publish before debugging anything else.

## Verification ladder (each step proves the previous)

1. `MY_ADDRESS/health` → `{"ok":true,"mode":"polling"}`
2. `/api/status` without token → 401; with owner token → `{"connected":false}` pre-connect
3. After connect: `/api/status` → username, `expires_in_days: 60`
4. `/api/media` → the account's real posts
5. Create a campaign with a nonsense keyword (e.g. `CHATMANYTEST`) on a real post,
   `POST /admin/poll`, watch `npx wrangler tail chatmany` — clean ticks
6. Comment the keyword **from a second account** (own account cannot DM itself) → DM arrives
   → button tap → email ask → delivery. Dashboard counters advance at each stage.

## Debugging kit used

- `npx wrangler tail chatmany --format pretty` — live logs incl. cron ticks
- `POST MY_ADDRESS/admin/poll` (owner token) — poll on demand, no waiting for cron
- `npx wrangler d1 execute chatmany --remote --json --command "SELECT ..."` — inspect state
- Cloudflare secrets: use `wrangler secret bulk <file>.json` (values never on the CLI)
