# Deploying Stryx on Railway

Everything runs in one Railway project: four services, two custom domains.

| Service | What it is | Reachable from the internet? |
|---|---|---|
| **Postgres** | Railway's Postgres template: accounts, wallets (encrypted keys), mint history, audit log | No, once its public address is removed (step 1) |
| **Redis** | Railway's Redis template: sessions, nonce counters, emergency-stop flags, the mint queues | No, once its public address is removed (step 1) |
| **api** | `apps/api`, built from `deploy/railway/api.Dockerfile`. The scheduled-mint and signed-mint queues run inside it | No (only through **web**) |
| **web** | Caddy, built from `deploy/railway/web.Dockerfile`: the dashboard on `app.yourdomain`, the landing page on `yourdomain`, and `/api` forwarded to **api** | Yes |

```
visitor ──https──▶ Railway edge ──▶ web (Caddy) ──/api──▶ api ──▶ Postgres, Redis
                                     ├─ app.yourdomain  → dashboard
                                     └─ yourdomain      → landing page (+ /api/home/drops, /api/waitlist only)
```

Why the API sits behind **web** instead of having its own domain: the dashboard calls `/api/...` on its
own address, the session cookie is pinned to the dashboard's host, and the API sends no CORS headers. So
the API must be same-origin with the dashboard, and Caddy makes it so.

Throughout, replace `stryx.xyz` with your domain.

---

## Before you start (outside Railway)

These take the longest, so start them first.

1. **Region.** Decide where the servers run before creating anything: every service in the project goes in
   the same Railway region, and the KMS key goes in the AWS region nearest it. Mint speed depends on it:
   each mint talks to OpenSea and the RPCs, and every signature asks KMS once, so an ocean between the
   servers and any of them adds that round trip to every mint. Measure from the candidate regions before
   choosing (see "Before the first real drop").
2. **AWS KMS key**, in the AWS region chosen above. Production refuses to start without it: wallet private
   keys are encrypted with a key that never leaves AWS. Follow `infra/aws/README.md` steps 1, 2 and 4 to create the key and its policy.
   Railway cannot assume an AWS role, so for step 3 create an **IAM user** (not a role) with only that
   policy attached and make an **access key** for it. You will need: the key's ARN, the region, the access
   key ID and the secret.
3. **RPC endpoints** for each chain you will mint on: an Alchemy, QuickNode or similar account. Free public
   endpoints are too slow and rate-limited for real drops. For a chain you mint on under time pressure, add
   a second provider as its `_FALLBACK`.
4. **OpenSea API key** (from OpenSea's developer portal) to resolve collections and read drop stages.
5. **Your domain**, with access to its DNS settings.
6. **Two wallet addresses** you control, for the operator (admin) sign-in. One is a spare, so losing one
   is not a lockout.
7. **Random secrets.** Generate four now and keep them in your password manager:
   ```bash
   openssl rand -hex 32   # API_AUTH_TOKEN
   openssl rand -hex 32   # ACCESS_CODE_SECRET
   openssl rand -hex 24   # stryx_app database password
   openssl rand -hex 24   # stryx_analytics database password
   ```
8. Install the Railway CLI (`npm i -g @railway/cli`) and run `railway login`.
9. **A `production` branch.** Railway deploys from it, not from `main` (see "Updating"):
   ```bash
   git push origin main:production
   ```

---

## 1. Create the project and the data services

1. In Railway, **New Project → Deploy from GitHub repo → Buoyafi/stryx-platform**. This creates one
   service; you will configure it as **api** in step 2. (If Railway asks to deploy immediately, let it; it
   will fail until the variables are set, which is fine.)
2. In the project, **+ New → Database → PostgreSQL**. Rename the service to `Postgres` if it is not already.
3. **+ New → Database → Redis**. Rename it to `Redis`.
4. Put every service in the region you chose: each service → **Settings → Deploy → Region** (this one, and
   api and web as you create them).
5. **Remove the public addresses of Postgres and Redis**, before the first api deploy. The templates usually
   come with one (a TCP proxy, what `DATABASE_PUBLIC_URL` and `REDIS_PUBLIC_URL` point at). Open each →
   **Settings → Networking → Public Networking** and delete the TCP proxy. This matters on its own: the
   first deploy's migrations create the `stryx_app` and `stryx_analytics` logins with the development
   passwords that are in this repository, and `stryx_app` can read and change users and wallets. Step 4
   replaces those passwords; until then, only the other services in this project may reach the database.
   Everything in this guide then reaches Postgres and Redis through the api service (`railway ssh`), which
   is on the private network.
6. Postgres: open it → **Backups** and turn on scheduled backups (daily at least). Wallet keys live here:
   losing this database without a backup loses access to every wallet's funds.

---

## 2. The api service

Open the GitHub service from step 1, rename it to **api**, then:

**Settings**
- **Source → Branch:** `production`.
- **Build → Builder:** Dockerfile. **Dockerfile Path:** `deploy/railway/api.Dockerfile`. Leave Root Directory empty.
- **Deploy → Pre-deploy Command:** `npm run db:migrate -w @stryx/database`
  (applies new database migrations before each release; a failed migration stops the release).
- **Deploy → Healthcheck Path:** `/health`
- **Networking:** do **not** generate a public domain. Note its private address: `api.railway.internal`.
- **Watch Paths** (optional, saves rebuilds): leave empty for now.

**Variables** (Variables tab → Raw Editor). `${{...}}` are Railway references to the other services, typed
exactly like that.

```bash
NODE_ENV=production
HOST=::
PORT=3000
TLS_TERMINATED=true
TRUST_PROXY=2               # web's Caddy sends "visitor, peer": see "Visitor addresses" in step 6

# Database. DATABASE_URL is the owner role: migrations and the operator scripts use it.
DATABASE_URL=${{Postgres.DATABASE_URL}}
# RUNTIME_DATABASE_URL and ANALYTICS_DATABASE_URL are added in step 4, after the first deploy.

REDIS_URL=${{Redis.REDIS_URL}}

# Key custody (AWS KMS)
KMS_PROVIDER=aws
KMS_KEY_ID=arn:aws:kms:REGION:ACCOUNT:key/...
AWS_REGION=REGION            # the same region as in KMS_KEY_ID
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...

# Sign-in
API_AUTH_TOKEN=<the first openssl value>
APP_ORIGIN=https://app.stryx.xyz
ACCESS_CODE_SECRET=<the second openssl value>

# Chains: set only the ones you use (names are in .env.example)
RPC_BASE=https://...
RPC_BASE_FALLBACK=https://...
RPC_ETHEREUM=https://...

OPENSEA_API_KEY=...
COINGECKO_API_KEY=

# Off until you have rehearsed a signed mint in production (see "Before the first real drop")
SIGNED_MINT_EXECUTION_ENABLED=false
```

What each one is for, and every optional one, is in `.env.example`. Leave these **unset** in production:
`KMS_PROVIDER=local`/`LOCAL_KMS_KEK`, `ENABLE_TESTNETS`, `ALLOW_PENDING_MIGRATIONS`,
`OPERATOR_TOKEN_MODE` (its production default, `off`, is right), and `TERMS_VERSION`/`PRIVACY_VERSION`
until the legal documents are final.

Deploy. The first deploy runs every migration (creating the tables and the two limited database roles),
then starts the API. In the deploy logs you should see `database migrations up to date` and
`api listening`, plus one warning that `RUNTIME_DATABASE_URL` is not set. Step 4 clears that warning.

The API refuses to start, with a one-line reason, if something essential is wrong: a missing
`NODE_ENV`, `KMS_PROVIDER=local` in production, `TLS_TERMINATED` not true, `APP_ORIGIN` not https, a
pending migration. Read the last lines of the deploy log first.

Go straight on to step 4 once the API is up: it replaces the development database passwords.

### Redis must keep its data across restarts

Emergency-stop flags, nonce counters and scheduled mints live only in Redis. A Redis that forgets them on
a restart could send with a stale nonce, drop a scheduled mint, or lift an emergency stop. Check it from
the api service:

```bash
railway ssh --service api
cd apps/api
node -e "const R=require('ioredis');const r=new R(process.env.REDIS_URL);Promise.all([r.config('GET','appendonly'),r.config('GET','dir')]).then(x=>{console.log(x);process.exit(0)})"
exit
```

It prints `appendonly` and `dir`. If `appendonly` is `yes` and `dir` is the Redis volume's path, you are
done. If it is `no`: open Redis → **Settings → Deploy → Custom Start Command**, keep the command exactly
as the template set it, and add `--appendonly yes` to its `redis-server` arguments. If that field is empty,
set it to:

```
/bin/sh -c 'exec redis-server --requirepass "$REDIS_PASSWORD" --appendonly yes --dir "$RAILWAY_VOLUME_MOUNT_PATH"'
```

Use the shell's `$REDIS_PASSWORD` there, not a `${{...}}` reference: it is not certain Railway fills those
in inside a start command, and a password that does not match `REDIS_URL` stops the API reaching Redis.
Redeploy Redis and check again.

---

## 3. The web service

**+ New → GitHub Repo → Buoyafi/stryx-platform** again, rename it **web**.

**Settings**
- **Source → Branch:** `production`.
- **Builder:** Dockerfile. **Dockerfile Path:** `deploy/railway/web.Dockerfile`.
- **Networking → Custom Domain:** add `app.stryx.xyz`, then `stryx.xyz` (and `www.stryx.xyz` if you want
  it). Railway shows a DNS record for each; add those at your DNS provider. HTTPS certificates are issued
  automatically once DNS resolves. On Cloudflare, set these records to **DNS only** (grey cloud): this
  setup is built and tested for visitors reaching Railway directly, and Railway cannot check a proxied
  record.

**Variables**

```bash
# Read by Caddy at runtime
APP_HOST=app.stryx.xyz
API_UPSTREAM=api.railway.internal:3000

# Read at BUILD time (changing one needs a redeploy)
VITE_APP_URL=https://app.stryx.xyz
VITE_WAITLIST_URL=https://stryx.xyz/#waitlist
# Optional: WalletConnect "Phone wallet" (add both domains under the project's allowed domains at reown.com)
VITE_WALLETCONNECT_PROJECT_ID=
# Only once the Terms and Privacy Policy are final:
# VITE_LEGAL_LINKS=true
# VITE_TERMS_URL=https://stryx.xyz/terms.html
# VITE_PRIVACY_URL=https://stryx.xyz/privacy.html
```

Deploy. Then open `https://stryx.xyz` (the landing page) and `https://app.stryx.xyz` (the dashboard's
signed-out Home).

---

## 4. Lock down the database roles (right after the first deploy)

The migrations created two limited roles, `stryx_app` (what the running API uses, which cannot edit or
delete the audit log) and `stryx_analytics` (read-only, for the admin Overview), with development
passwords from the repository. Give them real ones, then point the API at them.

1. Set the passwords from the api service (Postgres has no public address, so `railway connect` will not
   reach it), with the two database passwords you generated:
   ```bash
   railway ssh --service api
   cd packages/database
   echo "ALTER ROLE stryx_app WITH PASSWORD '<stryx_app password>'; ALTER ROLE stryx_analytics WITH PASSWORD '<stryx_analytics password>';" \
     | npx prisma db execute --stdin --url "$DATABASE_URL"
   exit
   ```
   It prints `Script executed successfully.`
2. On **api → Variables**, add:
   ```bash
   RUNTIME_DATABASE_URL=postgresql://stryx_app:<stryx_app password>@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}
   ANALYTICS_DATABASE_URL=postgresql://stryx_analytics:<stryx_analytics password>@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}
   ```
3. Redeploy **api**. The `RUNTIME_DATABASE_URL` warning is gone from the log.

---

## 5. Make yourself the operator

The API token cannot be used to sign in in production; the operator signs in with a wallet. Link your
two wallets to the operator account:

```bash
railway ssh --service api
cd apps/api
npm run operator:adopt -- 0xYourWallet
npm run operator:adopt -- 0xYourSpareWallet
npm run operator:list
exit
```

Then open `https://app.stryx.xyz`, **Connect wallet** with one of them, and sign. You land in the
dashboard with **Admin** in the menu. From Admin → Invite codes you can now create codes for other people.

---

## 6. Check it

- [ ] `https://app.stryx.xyz` shows the signed-out Home; `https://stryx.xyz` shows the landing page.
- [ ] Signing in with your operator wallet works, and Admin is in the menu.
- [ ] Landing page waitlist: submit your own email; it appears in Admin → Waitlist.
- [ ] Wallets: create one wallet, check its balance shows on each chain you configured.
- [ ] `railway ssh --service api`, then `npm run chains:doctor` (you start in the repo root): every configured
      chain answers, and it lists any misnamed `RPC_*` variable.
- [ ] Emergency stop: press it on the test wallet, check a send is refused, release it.
- [ ] **Visitor addresses are real (TRUST_PROXY).** The per-visitor limits only work if the API sees each
      visitor's own address. Test it from your computer:
      ```bash
      for i in $(seq 1 11); do
        curl -s -o /dev/null -w "%{http_code}\n" -X POST https://app.stryx.xyz/api/auth/code/check \
          -H "Origin: https://app.stryx.xyz" -H "Content-Type: application/json" -d '{"code":"ZZZZ-ZZZZ"}'
      done
      ```
      The last line should be `429` (limited). Then, within 15 minutes:
      1. The same command once more with `-H "X-Forwarded-For: 1.2.3.4"` added, and once with
         `-H "X-Real-IP: 1.2.3.4"`, must **still** be `429`. If either is not, anyone can dodge the limits
         by sending that header: tell me, and do not invite anyone yet.
      2. From your phone on mobile data (not your Wi-Fi), enter a made-up code on the dashboard's "Got a
         code?" card: it must say the code is wrong, not "too many tries". If it says too many tries, every
         visitor shares one address: tell me before inviting anyone.

      How the address is found: Railway's edge overwrites `X-Real-IP` with the connecting address on every
      request, while the number of Railway hops it leaves in `X-Forwarded-For` varies. So web's Caddy
      replaces `X-Forwarded-For` with "`X-Real-IP`, its own peer" and drops any `Forwarded` header, and
      the API skips the two hops it trusts (`TRUST_PROXY=2`: Caddy, then that peer) to reach the visitor.
      Counting Railway's hops instead gave a Railway address that changed per request, and the limits
      never added up (seen on the first deploy, 2026-10-08).

---

## 7. Invite emails (optional)

With this, **Admin → Waitlist → Approve & send invite** makes the person a single-use code (valid 14 days,
revocable under Invite codes, labelled with their address) and emails it from `invites@<your domain>`,
with the Stryx logo, a "Claim your access" button that opens the dashboard with the code filled in, and
a footer with the site and X links. If the email fails, nothing is marked and the code is taken back.
Without it, the button is not shown and invites stay manual.

1. **Resend** (resend.com, free up to 3,000 emails a month): sign up, **Domains → Add domain**, enter
   `stryx.xyz`. Resend lists DNS records (an MX and TXT records for SPF and DKIM, under a `send` and a
   `resend._domainkey` name). Add each one in Cloudflare → DNS exactly as shown, **DNS only** (grey cloud),
   and press **Verify** in Resend. It turns green within minutes.
2. In Resend, **API Keys → Create API key**, permission **Sending access**, domain `stryx.xyz`. Copy it
   (it starts `re_`; it is shown once).
3. **Replies** (optional): Cloudflare → `stryx.xyz` → **Email → Email Routing** → enable it (it adds its
   own MX records; keep Resend's records too), then a custom address `hello@stryx.xyz` forwarding to your
   own inbox (confirm the email Cloudflare sends you).
4. On **api → Variables**:
   ```bash
   RESEND_API_KEY=re_...
   INVITE_EMAIL_REPLY_TO=hello@stryx.xyz     # only if you did step 3
   # INVITE_EMAIL_FROM defaults to "Stryx <invites@gostryx.com>": set it if your domain is different
   INVITE_EMAIL_FROM=Stryx <invites@stryx.xyz>
   ```
   Redeploy api.
5. Check: join the waitlist on the landing page with an address of your own, then **Approve & send
   invite** on it. The email arrives (look in spam the first time, and mark it "not spam"), the button
   opens the dashboard with the code filled in. Revoke that code under Invite codes afterwards.

The logo images in the email are served from the dashboard (`/brand/email-*.png`), so they show once
**web** has been released with them.

---

## Updating

Railway watches the `production` branch, so merging to `main` deploys nothing. To release what is on
`main`:

```bash
git push origin main:production
```

Both **api** and **web** rebuild, and each api release runs its migrations first. Release only when no
drop is running or about to start (check Operations): a restart stops the API mid-run, and a signed mint
that is running is then marked failed, never retried (so it can never mint twice). There is no CI, so run
`npm run build` and `npm test` on `main` before releasing.

To change a `VITE_*` variable, edit it on **web** and redeploy.

Roll back: open the service → **Deployments** → an earlier one → **Redeploy**. A migration is never
undone by a rollback; the older build simply refuses to start if the database is ahead of it, so roll
back only to a build that already had every migration.

---

## Before the first real drop

1. If you have not measured the region yet: from `railway ssh --service api`, time a few requests to
   OpenSea and to each chain's RPC (for example `time curl -s -o /dev/null https://api.opensea.io/`), and
   compare with a second region. Moving later means a new project region and redeploying every service.
2. On a cheap Base drop, do a dry run, then one real mint from one wallet with a small **Job spend limit**.
   Check the transaction on the explorer, the tip it paid, and that Activity and the proof card show it.
3. Only then set `SIGNED_MINT_EXECUTION_ENABLED=true` on **api** for signed (GTD/FCFS) stages, and rehearse
   one with a dry run first.
4. Before inviting anyone: the Terms and Privacy Policy finished (`docs/legal/*-REVIEW.md`), then
   `TERMS_VERSION` and `PRIVACY_VERSION` on **api** and the `VITE_*` legal links on **web**.

---

## When something is wrong

| Symptom | Where to look |
|---|---|
| api never becomes healthy | api → Deployments → the latest → logs. The last lines name the missing setting. |
| "Database is missing migrations" | The pre-deploy command did not run or failed: check it is set (step 2) and read its log. |
| Dashboard loads but every action fails | web cannot reach api: `API_UPSTREAM` must be `api.railway.internal:3000`, and api needs `HOST=::`. |
| Log says "HOST=:: but this machine has no IPv6" | The API fell back to IPv4. On Railway that means web cannot reach it over the private network: check the project's private networking is on. |
| "This request did not come from the Stryx app" | `APP_ORIGIN` on api must be exactly `https://app.stryx.xyz` (no trailing slash). |
| Signed out after every refresh | You are on a different address than `APP_ORIGIN`, or `APP_HOST` on web is wrong. |
| Balances say a chain is not configured | Its `RPC_*` variable is missing or misnamed: run `npm run chains:doctor` on api. |
| Scheduled mints never fire | Redis: check `REDIS_URL` references the Redis service, and that it keeps data (end of step 2). |
| A merge to `main` did not deploy | Expected: Railway deploys `production`. See "Updating". |

## What it costs, roughly

Railway bills by usage. Expect about $5 for the plan plus roughly $10 to $30 a month for these four
services at low traffic, mostly the API's memory. RPC, OpenSea and AWS KMS are billed by their own
providers (KMS: about $1 a month for the key plus a fraction of a cent per signing).

---

## How this guide was checked

The images, the Caddyfile and steps 2, 4 and 5 were run end to end in Docker on 2026-10-08, the way
Railway runs them: a fresh Postgres owned by `postgres`, Redis with a password, the pre-deploy migration
command (all migrations applied), the API with the production settings above, then web in front of it.
Checked: the dashboard and its routes, `/api` on the dashboard host, only `/api/home/drops` and
`/api/waitlist` on the landing host, the security and cache headers, the waitlist form, the per-visitor
limit and that a forged `X-Forwarded-For` does not get round it, the role passwords and
`RUNTIME_DATABASE_URL`, `operator:adopt` inside the container, and a real wallet sign-in through Caddy
(`__Host-` secure session cookie, operator account as admin). Not checkable there: AWS KMS (no
credentials), RPCs and OpenSea (no network), and Railway's own edge, which is why step 6 tests the
visitor address on the real deployment.

Reviewed and changed on 2026-10-08: the public database addresses, the region, deploying from
`production`, the Redis start command, page caching and the API image running as `node`. Run locally:
the Caddyfile (every page `no-cache`, hashed assets cached a year, both hosts), the API image as `node`,
its pre-deploy migration, the step 4 password change through `prisma db execute` (the old development
password is then refused), the Redis check, the fallback Redis start command, and `operator:list`.
Not checkable without Railway: the names of its settings (Public Networking, Region, Source branch) and
what the Redis template's start command already contains.
