# chatmany

Self-hosted Instagram **comment-to-DM** automation, using the **official Meta Instagram API only** — no scraping, no unofficial access. When someone comments a keyword on your post or reel, chatmany DMs them, optionally asks them to follow, optionally captures their email, then delivers a link or reward.

You clone this repo, create your own Meta app, connect your own Instagram account, and deploy your own instance on Cloudflare's free tier. **The author hosts nothing and stores none of your data.** Free ($0/month) at single-creator scale.

> **Status:** feature-complete for single-creator use — the automation engine (OAuth, polling, token refresh, rate limiting, analytics events) **plus a ManyChat-style web UI** to build and monitor campaigns without editing JSON.

> 🎬 **TikTok support is coming soon.** Same comment→DM funnel, same self-hosted setup. Star the repo to get notified.

> 💬 **Stuck? DM me** [@build.ryanip](https://instagram.com/build.ryanip) on Instagram and I'll help you get it running. Bug reports and feature ideas are welcome in [Issues](https://github.com/ryanlaiyanip-ctrl/chatmany/issues).

---

## 🤖 Want an AI to walk you through the install?

Setup involves a terminal and Meta's developer dashboard. If that isn't your comfort zone, open **ChatGPT** — or **Codex**, if you'd rather it run the commands for you — and paste the block below. It'll guide you through the whole thing, one step at a time, and it already knows the traps that break most installs.

**Copy everything between the lines:**

---

```text
I want to install "chatmany" — a self-hosted Instagram comment-to-DM tool —
on my own computer and my own free Cloudflare account.

The complete setup guide is the README here:
https://github.com/ryanlaiyanip-ctrl/chatmany

Please read that README first, then walk me through the setup ONE STEP AT A
TIME. Wait for me to confirm each step worked before giving me the next one.
Assume I am not a programmer: tell me exactly what to click, what to type,
and what I should expect to see. If I paste an error, diagnose it and give
me the fix rather than starting over.

These five things break most installs — please keep me from getting them
wrong, and check with me at each one:

1. There are TWO different app ID/secret pairs in a Meta app. I need the
   "Instagram app ID" and "Instagram app secret" from
   Use cases -> Customize -> API setup with Instagram login.
   NOT the "App ID"/"App secret" from App settings -> Basic. Using the wrong
   pair still installs and deploys perfectly, then fails at the very end.

2. Do NOT tell me to click the "Generate token" button. The Connect step
   creates the correct token automatically. That button's token expires in
   hours and cannot be upgraded.

3. The redirect URL must be registered in TWO separate places in the Meta
   dashboard. Filling in one does not fill in the other.

4. The app MUST be Published (switched from Development to Live). If it
   isn't, Instagram returns empty comment and message lists with no error,
   and nothing works while looking completely fine.

5. I need Node.js 22 or newer, and I have to accept the Instagram tester
   invite from a DESKTOP browser — the phone app doesn't show it.

Start by telling me what I need to have ready before we begin.
```

---

## Requirements

- An Instagram **Professional** account (Creator or Business). Personal accounts are unsupported — switch in the Instagram app under **Settings → Account type and tools → Switch to professional account**.
- **A second Instagram account** to test with — any personal account works, including a friend's. You cannot trigger your own campaign from the account chatmany is running, because it would have to DM itself.
- A free [Cloudflare](https://dash.cloudflare.com) account (Workers + D1).
- A free [Meta developer](https://developers.facebook.com) account.
- **Node.js 22 or newer** and `npm` locally (to deploy). Check yours with `node -v`; if it prints anything below `v22`, update from [nodejs.org](https://nodejs.org) or the deploy tooling will refuse to run.

---

## Setup

**Read this first.** Setup takes about 45 minutes. It has four parts, and **they must be done in this order**, because Part 3 needs a web address that doesn't exist until Part 2 creates it:

| Part | What you do | Where |
|---|---|---|
| **1** | Create a Meta app and copy two values out of it | Meta's website |
| **2** | Put chatmany online, get your web address | Your computer's terminal |
| **3** | Give that address back to Meta, then Publish | Meta's website |
| **4** | Connect your Instagram account | Your browser |

You do not need to know how to code. Every terminal command is written out to copy and paste.

**Two things to have open the whole time:** a browser, and a blank note (Notes, Notepad, anything).

You'll collect **five values** into that note as you go, and later steps refer to them by these exact names:

| Name | You get it in |
|---|---|
| `INSTAGRAM APP ID` | step 1.6 |
| `INSTAGRAM APP SECRET` | step 1.6 |
| `DATABASE ID` | step 2.4 |
| `OWNER TOKEN` | step 2.7 (you invent this one) |
| `MY ADDRESS` | step 2.8 |

Keep that note until the very end.

---

### Part 1 — Create your Meta app

A "Meta app" is just a permission slip that lets your own software talk to your own Instagram account. It's free. Nobody reviews it. You are not launching a product.

#### 1.1 — Log in

Go to **[developers.facebook.com](https://developers.facebook.com)**.

Click **Log in** in the top-right corner and sign in with your normal Facebook account. Don't have one? Click **Sign up** — it's free, and it does **not** need to be connected to your Instagram account.

#### 1.2 — Start creating the app

At the top-right of the page, click **My Apps**.

On the page that loads, click the green **Create app** button.

#### 1.3 — Name it

In the **App name** box, type any name you want — `chatmany` is fine. Nobody but you sees this.

Check that the **App contact email** box has your email in it (Meta usually fills this in for you).

Click **Next**.

#### 1.4 — Choose the right use case ⚠️

You'll now see several large cards, each describing something a Meta app can do.

Click the card that says **"Manage messaging and content on Instagram"**.

> **Can't find it?** Press **Cmd+F** (Mac) or **Ctrl+F** (Windows) and type `Instagram`. Your browser will highlight it.
>
> **Do not** pick any card mentioning **Facebook Login**, **Facebook Pages**, or **Business Integration**. Those are different products and chatmany will not work with them.

Click **Next**, then click **Go to dashboard** (or **Create app**, depending on which Meta shows you). If it asks for your Facebook password, type it in — that's Meta confirming it's you.

You should now be looking at your app's dashboard, with a menu running down the left-hand side.

#### 1.5 — Add the permissions to your use case

In the **left sidebar**, click **Use cases**.

You'll see a card named **"Manage messaging and content on Instagram"**. On the right-hand side of that card, click the **Customize** button.

You're now on a page with numbered sections (1, 2, 3, 4...). Look at **section 1, "Add required messaging permissions."**

- If it shows a **green checkmark** — nothing to do, move on.
- If it shows a **half-filled or grey circle** — click the **"Add all required permissions"** button inside that section.

> ⚠️ **Do not skip this.** Skipping it produces a confusing `Invalid platform app` error much later, at Part 4, with no hint that this was the cause.

**Now confirm the three permissions actually landed.** In the **left sidebar**, click **Permissions and features**. It's a long list covering products you'll never use (Ads, Pages, Business Manager) — ignore all of it and use the page's search box to find these three:

- `instagram_business_basic`
- `instagram_business_manage_comments`
- `instagram_business_manage_messages`

Each should show a status like **"Ready for testing"**. The button you clicked above normally adds all three for you, so this is usually just a check. If any one is missing or greyed out, click into it here and follow the prompt to request it.

#### 1.6 — Copy your Instagram app ID and secret ⚠️⚠️

**This is the single most common way this entire setup fails. Read the whole box before clicking anything.**

> Your Meta app contains **two different pairs** of ID + secret. They sit on different pages, they look equally correct, and only one pair works:
>
> | Page | What it's labelled | Use it? |
> |---|---|---|
> | App settings → Basic | "App ID" / "App secret" | ❌ **NO** — chatmany never uses these |
> | Use cases → Customize → API setup with Instagram login | "**Instagram** app ID" / "**Instagram** app secret" | ✅ **YES** |
>
> Pick the wrong pair and everything still installs, deploys, and looks perfectly healthy — then Part 4 dead-ends on Instagram's own page with:
>
> ```
> Invalid Request: Request parameters are invalid: Invalid platform app
> ```

**Stay on the same Customize page from step 1.5.** Scroll down to the section titled **"API setup with Instagram login"** (usually section 2 or 3).

Inside it you'll find two values:

1. **Instagram app ID** — a long number, shown openly. Copy it into your note as `INSTAGRAM APP ID`.
2. **Instagram app secret** — hidden behind dots. Click **Show** next to it (Meta may ask for your Facebook password), then copy it into your note as `INSTAGRAM APP SECRET`.

> 🔒 The app secret is a password. Don't post it, screenshot it, or paste it into a chat window.

> ### 🛑 Ignore the "Generate token" button
>
> The same section has a tempting **Generate token** button. **Don't click it.** You do not need to create a token by hand at any point — Part 4 does it for you, automatically and correctly.
>
> That button produces a *debug* token meant for manually poking at the API. It looks like it worked, and chatmany will even accept it, but:
>
> | | "Generate token" button | Part 4 (the Connect flow) |
> |---|---|---|
> | Lasts | **a few hours** | **60 days** |
> | Renews itself | ❌ no | ✅ yes, daily |
> | Upgradeable to long-lived | ❌ fails with `Session key invalid` | n/a — already is |
>
> These numbers are measured, not estimated — from two real installs of this exact code on the same Instagram account. Use this button and your automation dies quietly before the day is out.

#### 1.7 — Add your Instagram account as a tester

Still on the same Customize page, scroll to the section named **"Add or remove Instagram testers"** (usually section 3).

Click **Add people**, type your Instagram username (without the `@`), and click **Add**.

**Now accept the invite from inside Instagram itself** — adding it here only *sends* an invitation:

1. **On a desktop or laptop computer**, go to [instagram.com](https://instagram.com) in a browser and log in as that account.
2. Go to **Settings and privacy → Apps and websites → Tester invites**.
3. Click **Accept**.

> ⚠️ **This only works on a desktop browser.** The Instagram phone app does not show tester invites anywhere in its settings — there is no way to accept from your phone. If you can't find the option, that's why: switch to a computer.

> ⚠️ The Meta dashboard shows a blank status either way, so it will **not** tell you whether you did this. If you skip it, Part 4 fails with `Insufficient Developer Role`.

> ### ✅ Before leaving Part 1, confirm all three:
> 1. Section 1 "Add required messaging permissions" shows a **green checkmark**
> 2. Your note has an **Instagram app ID** and an **Instagram app secret** — copied from the *API setup with Instagram login* section, **not** from App settings → Basic
> 3. You clicked **Accept** on the tester invite **inside Instagram**

---

### Part 2 — Put chatmany online

Everything here happens in a terminal. That's a window where you type commands instead of clicking buttons.

**Open it:**
- **Mac** — press **Cmd+Space**, type `Terminal`, press **Enter**.
- **Windows** — click Start, type `PowerShell`, press **Enter**.

**How to use it:** copy one command, paste it in, press **Enter**, and *wait* until the text stops scrolling and you see your cursor again. Then do the next one. Never paste two commands at once.

#### 2.1 — Download the code

```bash
git clone https://github.com/ryanlaiyanip-ctrl/chatmany.git chatmany
```

> **`git: command not found`?** Install it: Mac — run `xcode-select --install` and click through the installer. Windows — download from [git-scm.com](https://git-scm.com/downloads).

#### 2.2 — Go into the folder and install

```bash
cd chatmany
```

```bash
npm install
```

`npm install` prints a lot of text and takes 1–2 minutes. Warnings are normal and fine. Only a line starting with `ERROR` is a problem.

> **`npm: command not found`?** Install Node.js from [nodejs.org](https://nodejs.org) (take the "LTS" button), then **close and reopen your terminal** and run both commands again.
>
> **Errors mentioning your Node version?** Run `node -v`. It must be `v22` or higher — older versions are rejected by the deploy tooling. Update from the same link.

#### 2.3 — Log into Cloudflare

```bash
npx wrangler login
```

This opens a browser tab. Log in — or click **Sign up** if you don't have an account, it's free and needs no credit card. Then click the blue **Allow** button.

Return to your terminal. It should say **"Successfully logged in."**

#### 2.4 — Create your database

```bash
npx wrangler d1 create chatmany
```

The output contains a line that looks like this:

```
database_id = "a1b2c3d4-5678-90ab-cdef-1234567890ab"
```

**Copy the long value between the quote marks** into your note as `DATABASE ID`.

#### 2.5 — Paste the database ID into the settings file

Open the file `wrangler.toml`, which is inside the `chatmany` folder you just downloaded.

**Easiest way to find it:** in the same terminal you've been using, run this — it opens the exact right folder in a window, no hunting:

```bash
open .
```

*(On Windows, run `start .` instead.)*

Then right-click `wrangler.toml` → **Open With** → **TextEdit** (Mac) or **Notepad** (Windows).

Near the top you'll see:

```toml
[[d1_databases]]
binding = "DB"
database_name = "chatmany"
database_id = "REPLACE-WITH-THE-ID-FROM-wrangler-d1-create"
```

Replace **only** the value inside the quotes on the `database_id` line with your `DATABASE ID`. Keep the quote marks. Change nothing else — the `REDIRECT_URI` line further down gets fixed in Part 3.

Save: **Cmd+S** (Mac) or **Ctrl+S** (Windows).

#### 2.6 — Build the database tables

```bash
npm run db:migrate:remote
```

When it asks `Your database may not be available to serve requests during the migration, continue?`, type `yes` and press **Enter**.

You should see a small table with ✅ next to each migration.

#### 2.7 — Set your three secret values

Run these **one at a time**. After each, the terminal waits for you to paste a value and press **Enter**.

> **Your typing will be invisible.** No dots, no stars, nothing moves. That's deliberate — it's how terminals handle passwords. It is not frozen. Paste, press Enter, keep going.

> **On the very first one, you'll get an extra question.** Because nothing has been deployed yet, wrangler asks:
>
> ```
> There doesn't seem to be a Worker called "chatmany". Do you want to
> create a new Worker with that name and add secrets to it?
> ```
>
> Answer **yes**. This is expected and correct — it just reserves the name ahead of the real deploy in 2.8. You'll only see it once.

```bash
npx wrangler secret put APP_ID
```
Paste your **`INSTAGRAM APP ID`** from step 1.6.

⚠️ Not the "App ID" from App settings → Basic. If you're unsure which one you copied, go back to step 1.6 and check.

```bash
npx wrangler secret put APP_SECRET
```
Paste your **`INSTAGRAM APP SECRET`** from step 1.6.

```bash
npx wrangler secret put OWNER_TOKEN
```

This one you **make up yourself** — nothing to copy. It's the password for your own chatmany dashboard.

**Make it at least 20 characters.** This single value is the only thing protecting your contacts, emails, and campaigns from anyone who finds your web address. Mash your keyboard, or use `xk29fJ3mQpz81LwT4nBv`.

**Write it in your note as `OWNER TOKEN` before pressing Enter** — you cannot read it back later.

> Got one wrong? Just run the same command again with a new value. It overwrites instantly.

#### 2.8 — Put it online

```bash
npm run deploy
```

Near the bottom of the output is a real web address:

```
https://chatmany.your-name.workers.dev
```

**Copy it into your note as `MY ADDRESS`.** Almost everything in Part 3 needs it.

> ### ✅ Before leaving Part 2:
> Paste `MY ADDRESS` into your browser with `/health` on the end — e.g. `https://chatmany.your-name.workers.dev/health`
>
> You should see: `{"ok":true,"mode":"polling"}`
>
> Anything else means Part 2 didn't finish. Scroll up through your terminal and find the **first** red error line — that's the real cause. Don't continue until this shows `"ok":true`.

---

### Part 3 — Give your address back to Meta, then Publish

Four separate places need `MY ADDRESS`. Missing any one of them breaks Part 4, so tick them off as you go.

**Always copy-paste `MY ADDRESS` — never retype it.** A single wrong character fails with an error that doesn't mention typos.

#### 3.1 — Fix the redirect line in your settings file

Open `wrangler.toml` again (same file as step 2.5). Near the bottom, find:

```toml
REDIRECT_URI = "https://REPLACE-WITH-YOUR-WORKER-URL.workers.dev/auth/callback"
```

Replace what's inside the quotes with **`MY ADDRESS` + `/auth/callback`**. If your address is `https://chatmany.abc123.workers.dev`, it becomes:

```toml
REDIRECT_URI = "https://chatmany.abc123.workers.dev/auth/callback"
```

Save the file.

> ⚠️ **You must change this line.** The placeholder is not a real address, so leaving it means Instagram has nowhere valid to send you back to. The app still deploys and looks fine either way, which is what makes this easy to miss.

#### 3.2 — Push that change live

```bash
npm run deploy
```

#### 3.3 — Register the redirect URL — place 1 of 2

Go to [developers.facebook.com](https://developers.facebook.com) → **My Apps** → click your app.

In the **left sidebar**, click **Facebook Login for Business**, then click **Settings** underneath it.

> Yes, "Facebook" — even though you're using Instagram Login. Meta puts this setting there anyway. This is not a mistake in these instructions.

Scroll to **"Client OAuth settings"** and find the box labelled **"Valid OAuth Redirect URIs."**

Paste **`MY ADDRESS` + `/auth/callback`** into it and **press Enter** (it becomes a blue tag).

Scroll to the bottom and click **Save changes**. *Nothing on this page saves by itself.*

#### 3.4 — Register the redirect URL — place 2 of 2

In the **left sidebar**, click **Use cases** → **Customize** (same page as Part 1).

Scroll to the section **"Set up Instagram business login"** (usually section 4).

It has its **own separate redirect URL field**. Paste **the exact same value** — `MY ADDRESS` + `/auth/callback` — and click **Save**.

> ⚠️ This is a genuinely separate setting from 3.3. Filling in one does not fill in the other, and both are required.

#### 3.5 — Fill in the three legal URLs

In the **left sidebar**, click **App settings** → **Basic**.

Fill in these three boxes using `MY ADDRESS` — chatmany already serves all three pages, so they work the moment you deployed:

| Box on the page | What to paste |
|---|---|
| Privacy Policy URL | `MY ADDRESS` + `/privacy` |
| Terms of Service URL | `MY ADDRESS` + `/terms` |
| User data deletion → Data deletion instructions URL | `MY ADDRESS` + `/data-deletion` |

Also upload an **App icon** — any square image, 1024×1024. Meta refuses to publish without one.

Click **Save changes** at the bottom.

#### 3.6 — Publish the app

At the top of the dashboard, find the toggle that says **Development** and switch it to **Live**. (On some layouts this is a **Publish** button instead.)

> ⚠️ **This step is not optional, and skipping it fails in a way that looks like a bug in chatmany.** While the app sits in Development mode, Instagram accepts your login but then returns **empty lists** for comments and messages. Your campaigns will simply never fire, with no error anywhere.

> ### ✅ Before leaving Part 3:
> 1. Open all three in your browser — `MY ADDRESS` + `/privacy`, `/terms`, `/data-deletion`. Each must show a real page, not "not found."
> 2. The toggle at the top of the dashboard reads **Live**, not Development.

---

### Part 4 — Connect your Instagram account

Open a browser tab logged into the Instagram account you added as a tester in step 1.7.

Go to **`MY ADDRESS` + `/auth/authorize`** — for example `https://chatmany.abc123.workers.dev/auth/authorize`.

Instagram shows its own permission screen. Click **Allow**.

> 🔒 You're typing your password on **instagram.com**, not into chatmany. chatmany never sees it — it only receives a token afterwards.

You'll bounce back to your own site. That's it — you're connected. The token lasts 60 days and renews itself daily, automatically.

> ### ✅ Confirm it worked:
> Go to **`MY ADDRESS` + `/`**, sign in with your `OWNER TOKEN`, and check that your Instagram username and profile picture appear.

---

### Troubleshooting Part 4

Instagram's errors don't say what's actually wrong. Find your exact message below.

<details>
<summary><b>"Invalid Request: Request parameters are invalid: Invalid platform app"</b></summary>

Two possible causes.

**Cause 1 — wrong app ID (most likely).** You used the App ID from *App settings → Basic* instead of the Instagram app ID.

Check what your site is actually sending. Paste this into your terminal, replacing the address with yours:

```bash
curl -s -o /dev/null -D - https://chatmany.abc123.workers.dev/auth/authorize | grep -i location
```

Read the `client_id=` number in the output. Now compare it to the **Instagram app ID** at *Use cases → Customize → API setup with Instagram login*.

**Different?** That's your bug. Fix it:

```bash
npx wrangler secret put APP_ID
```
```bash
npx wrangler secret put APP_SECRET
```
```bash
npm run deploy
```

**Cause 2 —** you skipped the **"Add all required permissions"** button in step 1.5.
</details>

<details>
<summary><b>"Insufficient Developer Role: Insufficient developer role"</b></summary>

Good news — your app ID is right, this error only appears after that hurdle. Check in order:

1. **Is the app Live?** Step 3.6. In Development mode only accepted testers can log in.
2. **Did you accept the tester invite inside Instagram?** Step 1.7 — *Settings and privacy → Apps and websites → Tester invites → Accept*. Adding the account on Meta's dashboard only sends the invite. The dashboard's status column stays blank whether or not you accepted, so it can't tell you.
3. **Wait 5 minutes and retry.** Publishing takes a little while to take effect.
</details>

<details>
<summary><b>"URL blocked" / "redirect_uri is not allowed"</b></summary>

The address you're being sent back to isn't registered with Meta, or doesn't match exactly.

Both places must contain the **identical** value — 3.3 (*Facebook Login for Business → Settings*) **and** 3.4 (*Use cases → Customize → Set up Instagram business login*).

Check for: a missing `/auth/callback` on the end, `http://` instead of `https://`, a trailing slash, or the `REPLACE-WITH-YOUR-WORKER-URL` placeholder left behind in `wrangler.toml` from step 3.1.
</details>

<details>
<summary><b>Login works, but comments and messages never trigger anything</b></summary>

Your app is still in **Development** mode — step 3.6. Instagram returns empty lists rather than an error, so nothing appears broken.
</details>

<details>
<summary><b>"Couldn't find a D1 DB with the name or binding 'chatmany'"</b></summary>

Only happens if you renamed things in step 2.5 to run a second copy.

Open `package.json`, find these two lines, and change `chatmany` to your new name in both:

```json
"db:migrate:local": "wrangler d1 migrations apply chatmany --local",
"db:migrate:remote": "wrangler d1 migrations apply chatmany --remote"
```
</details>

<details>
<summary><b>Deploy fails mentioning cron triggers</b></summary>

Cloudflare's free plan allows 5 cron triggers per account, and each chatmany install uses 2 — so you can run two installs, not three.

Note the Worker itself still deploys successfully when this happens, so it looks half-broken rather than clearly blocked. Delete an old install with `npx wrangler delete <name>`.
</details>

---

### Part 5 — Build your first campaign

Open **`MY ADDRESS`** in your browser and sign in with the `OWNER TOKEN` from your note. You get the **chatmany web UI**:

- **Automations** — every campaign as a row: status, keyword, runs, CTR. Bulk-select to **Archive** (pause without losing history) or **Delete** (permanent, cascades everywhere).
- **Create** — a visual builder: pick the post/reel, set keywords (whole-word), toggle the public reply / follow-gate / email steps, and write your copy. A live Instagram phone preview (driven by your own avatar, handle, and selected post) shows exactly what followers see across Post / Comments / DM. Hit **Go live**.
- **Dashboard** — metric cards (comments, opening DMs, clicks + CTR, follows, emails, delivered) and a conversion funnel, over a date range.
- **Contacts** — everyone who entered a campaign, their funnel status, captured email, with **Export CSV**.
- **Archive** — campaigns you've paused; restore or permanently delete from here.

**Prefer JSON?** Entirely optional — the builder above does the same thing.

Make a copy of `config.example.json` named `config.json`, set your `media_id` and keywords in it, then import it. Replace **both** placeholders below with your own values — the address with `MY ADDRESS`, and `YOUR_OWNER_TOKEN` with the `OWNER TOKEN` from your note:

```bash
curl -X POST https://chatmany.abc123.workers.dev/config/import \
  -H "Authorization: Bearer YOUR_OWNER_TOKEN" \
  -H "content-type: application/json" \
  --data @config.json
```

Either way, the polling cron (every minute, checking at most every ~90 seconds) now watches that media. Comment a keyword from a **second** test account and you'll get: opening DM → (follow gate) → (email ask) → reward, per your toggles.

> ✅ **Final end-to-end verification, before you consider this ready to show anyone else:** comment your keyword from the second account, wait up to ~90 seconds, and confirm the opening DM actually lands in that account's **Requests** folder (not Primary — that's expected for a first-time commenter, see the postback-button note under [How it works](#how-it-works)). Then work through the full funnel yourself (tap the button → follow-gate if enabled → email-ask if enabled → reward) and check the **Dashboard** tab shows those events incrementing in real time. If the DM never arrives, re-check the Publish step (3.6) first — an empty comments feed is the most common cause, not a config mistake in the campaign itself.

---

## How it works

- **Polling mode (default).** A Cloudflare Cron runs each minute and (a) reads comments on active-campaign media and (b) reads recent conversations for inbound taps/replies. Both feed one transport-agnostic **state machine**:

  ```
  NEW → AWAITING_TAP → (AWAITING_FOLLOW?) → (AWAITING_EMAIL?) → DELIVER → DONE
  ```

- **Keyword match is whole-word, case-insensitive.** Keyword `ai` fires on `"I like this AI"` or `"i like this ai"` but never on `"fair"`.
- **Liking a comment is not possible.** Instagram's API has no `/likes` edge on a comment — the only comment operations it supports are read, reply, delete, hide/unhide, and enable/disable. The builder shows this toggle greyed out rather than letting you switch on something that silently does nothing.
- **Opening DM is a private reply to the comment** — the only sanctioned way to open a chat with a fresh commenter (valid up to 7 days, once per comment). It uses a **postback button** so it survives the Requests folder.
- **Follow-gate is a nudge, not a check.** No Instagram API can tell you whether a specific person follows you — there is no follower list and no relationship edge in the scopes this app holds. So the gate asks them to follow and gives them a button that says "I followed"; tapping it always advances. The wording is the whole mechanism: being asked to press *I followed* is what prompts people to actually go and follow. It is sent as a **postback button**, not a quick-reply chip, so it doesn't vanish the moment they type or leave the thread.
- **Email capture** uses Instagram's native `user_email` quick-reply chip, with a typed-reply fallback — an invalid reply gets re-asked instead of silently ignored, and the reward is only ever sent once a real email is captured.
- **Idempotent everywhere**, including across overlapping poll invocations. A comment is processed exactly once and a person gets exactly one DM per campaign, even across re-polls, webhook retries, or an overlapping cron tick racing a manual `/admin/poll` call.
- **Rate-safe.** Sends are paced with a throttle + exponential backoff on 429s, plus a conservative account-wide hourly cap on opening DMs.
- **Webhook mode (optional).** Set `MODE = "webhook"` to receive push events instead of polling (verified `X-Hub-Signature-256`). Polling is the guaranteed baseline; webhooks are a latency upgrade.
- **Archiving is non-destructive.** It stops a campaign and hides it from the main list without deleting its history — unlike Delete, which cascades and removes everything permanently.

## Cost

$0/month at single-creator scale — Cloudflare Workers (100k req/day), D1 (100k writes/day), Cron Triggers, and the Meta API (rate-limited, not priced) are all free tier. Only a genuinely viral account would exceed free limits.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest — keyword matching, state transitions, engine idempotency/retry, poll-race regression
npm run dev         # wrangler dev (local Worker + D1)
```

Local secrets go in a gitignored `.dev.vars` file (same keys as `.env.example`). Apply the schema locally with `npm run db:migrate:local`.

## Project layout

```
src/
  index.ts            Worker entry: HTTP routes + cron (scheduled) handlers
  config.ts           config validation (Section 7 schema)
  db.ts               D1 data-access helpers
  runtime.ts          builds the per-invocation API client + queue + engine
  api/client.ts       thin wrappers over graph.instagram.com
  auth/               OAuth onboarding + token refresh
  engine/             transport-agnostic state machine (match, transitions, engine)
  poller/             comment + message polls
  queue/              rate-limit send queue (throttle + backoff)
  routes/             auth, api (UI), config import/export, webhook, http helpers
public/               web UI (index.html, styles.css, app.js), plus /privacy, /terms, /data-deletion
schema/               D1 migrations
```

## Questions or problems?

**DM [@build.ryanip](https://instagram.com/build.ryanip) on Instagram** — happy to help you get set up, especially if you're stuck on the Meta dashboard.

Found a bug or want a feature? Open an [issue](https://github.com/ryanlaiyanip-ctrl/chatmany/issues). If the setup guide was confusing anywhere, that's worth an issue too — most problems people hit here are documentation problems, not code problems.

## Roadmap

- **TikTok support** — coming soon. Same comment→DM funnel, self-hosted the same way.
- **"Any post" trigger** — watch every post automatically instead of picking one.

## License

MIT. Built clean-room from official Meta API documentation.
