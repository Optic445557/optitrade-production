# OptiTrade v2.11.19 — Production Overlay Instructions

This ZIP is **not another copy of OptiTrade**.

It is designed to be extracted directly into your current real `optitrade-v1` folder.

## What it adds to your current project

- Latest OptiTrade branded mailer files from v2.11.18
- `render.yaml` for Render deployment
- `.gitignore` for GitHub safety
- `.env.render.example`
- this production instruction file
- package version updated to 2.11.19

It does **not** contain your `.env`, database, or `node_modules`.

## Step 1 — Extract into the real OptiTrade folder

1. Stop the local server with `Ctrl + C`.
2. Open `OptiTrade-v2.11.19-PATCH-Mailer-Production-Overlay.zip`.
3. Extract everything directly into your current `optitrade-v1` folder.
4. Choose **Replace files in destination** when Windows asks.

After extraction, keep using that same `optitrade-v1` folder locally.

## Step 2 — Test locally once

Run:

```cmd
npm start
```

Test login and open:

- `/admin/message-center.html`
- `/api/health`

The health endpoint should return an OK response.

## Step 3 — What goes to GitHub

Upload the CONTENTS of your current `optitrade-v1` folder to the repository root.

The GitHub root should contain things such as:

```text
admin/
public/
server/
scripts/
package.json
package-lock.json
render.yaml
.gitignore
.env.example
.env.render.example
```

### NEVER upload these

```text
.env
node_modules/
database/
*.db
*.db-wal
*.db-shm
your ZIP files
```

Important: `.gitignore` protects you when using Git/GitHub Desktop. If you manually upload files in the GitHub website, still make sure you do not select `.env`, `node_modules`, or `database`.

## Step 4 — Create the Render service

In Render:

1. Choose **New → Blueprint**.
2. Connect the GitHub repository.
3. Render reads `render.yaml`.
4. The service uses Node and starts with `npm start`.
5. The SQLite production database is stored at `/var/data/optitrade.db`.
6. The persistent disk is mounted at `/var/data`.

The service must use a paid Render instance because the SQLite database needs a persistent disk.

## Step 5 — Enter production secrets in Render

Render will ask for these values:

- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `SUPPORT_EMAIL`
- `RESEND_API_KEY`
- `RESEND_FROM`

Do not place these secret values in GitHub.

Render automatically generates:

- `SESSION_SECRET`
- `OTP_PEPPER`
- `TELEGRAM_ENCRYPTION_KEY`

For `RESEND_FROM`, use the sender from your verified OptiTrade/Resend domain, for example:

```text
OptiTrade <notifications@your-verified-domain>
```

## Step 6 — Test the temporary Render URL first

When the deployment becomes Live, open:

```text
https://YOUR-SERVICE.onrender.com/api/health
```

Then test:

1. Super Admin login
2. Customer registration
3. OTP email
4. Customer login
5. Deposit
6. Investment request
7. Admin notification
8. Help Center
9. OptiTrade Mailer

## Step 7 — Connect optiprotrade.online

In Render:

1. Open the OptiTrade service.
2. Settings → Custom Domains.
3. Add `optiprotrade.online`.

In Cloudflare:

1. SSL/TLS → set encryption mode to **Full**.
2. Remove conflicting `AAAA` records for the domain.
3. Add CNAME `@` pointing to the Render `*.onrender.com` hostname.
4. Set it to **DNS only** initially.
5. Add CNAME `www` pointing to the same Render hostname.
6. Set it to **DNS only** initially.
7. Return to Render and verify the domain.
8. After Render shows the certificate as valid, Cloudflare proxying can optionally be enabled.

Do not remove your Resend verification DNS records.

## Final result

You continue developing and testing **one OptiTrade project**:

`optitrade-v1`

That same project is the one stored on GitHub and deployed by Render.

There is no separate production application to maintain.
