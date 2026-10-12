# OptiTrade v2.11.19 — Render Production Deployment

This folder is prepared for GitHub + Render + Cloudflare with:

- Node/Express production start command
- Render `PORT` support through the existing server
- SQLite on a Render persistent disk
- Health check at `/api/health`
- Production HTTPS/cookie settings
- OptiTrade branded Resend mailer
- `optiprotrade.online` as the production application URL
- `.env`, local SQLite databases, and `node_modules` excluded

## Important: database

This deployment package intentionally does **not** include your local `database/optitrade.db`.

The first Render deployment creates a fresh production database at:

`/var/data/optitrade.db`

This avoids publishing test users, test balances, local sessions, or local secrets by accident.

If you later decide that specific local production data must be migrated, migrate it separately after the Render service and persistent disk are working.

## 1. Create a GitHub repository

Create a private GitHub repository, for example:

`optitrade-production`

Upload the **contents of this folder** to the repository root. `render.yaml` and `package.json` must be at the repository root.

Do not upload a real `.env` file.

## 2. Create the Render service

Recommended path: Render Dashboard -> New -> Blueprint.

Connect the GitHub repository and select its `render.yaml`.

The Blueprint creates:

- Web service: `optitrade`
- Runtime: Node
- Build: `npm ci --omit=dev`
- Start: `npm start`
- Health check: `/api/health`
- Persistent disk: `/var/data`, 1 GB
- Database: `/var/data/optitrade.db`

A persistent disk requires a paid Render web-service compute plan.

## 3. Enter the secret environment values

Render will prompt for the values marked `sync: false`.

Enter:

### ADMIN_EMAIL
The email used to sign into the OptiTrade Super Admin account.

### ADMIN_PASSWORD
Use a new strong production-only password. Do not reuse the password from the local test server.

### SUPPORT_EMAIL
Your official customer-support email.

### RESEND_API_KEY
The production Resend API key for the verified OptiTrade sending domain.

### RESEND_FROM
Use the verified sender format, for example:

`OptiTrade <notifications@your-verified-domain>`

Do not paste these secret values into GitHub.

`SESSION_SECRET` and `OTP_PEPPER` are generated automatically by Render.

## 4. First Render test

Wait for the first deploy to become Live.

Open:

`https://YOUR-RENDER-SERVICE.onrender.com/api/health`

Expected result includes:

- `"ok": true`
- `"service": "OptiTrade"`
- `"database": "ok"`
- `"environment": "production"`

Then test the temporary Render URL before changing the public domain:

1. Super Admin login
2. Customer registration
3. Registration OTP email
4. Login
5. Deposit flow
6. Investment request and balance reservation
7. Admin notification
8. Help Center / quick answers
9. OptiTrade Mailer
10. Logout and login again

## 5. Connect optiprotrade.online

In Render:

Service -> Settings -> Custom Domains -> Add Custom Domain

Add:

`optiprotrade.online`

Render also supports the matching `www` domain.

In Cloudflare:

1. SSL/TLS -> Overview -> set encryption mode to **Full**.
2. Remove any old `AAAA` records for the domain.
3. DNS -> create a CNAME:
   - Name: `@`
   - Target: your Render `*.onrender.com` hostname
   - Proxy: **DNS only**
4. Create another CNAME:
   - Name: `www`
   - Target: the same Render hostname
   - Proxy: **DNS only**
5. Return to Render and Verify the domain.
6. Wait until Render shows the TLS certificate as valid.
7. After verification, Cloudflare proxying can optionally be enabled.

Do not remove the existing Resend DNS verification records.

## 6. Final domain test

After the custom domain is verified, confirm:

`https://optiprotrade.online/api/health`

Then test registration and email again so all email links point to:

`https://optiprotrade.online`

## Production notes

- Keep one Render instance while using SQLite + persistent disk.
- Do not deploy the SQLite database inside the GitHub repository.
- Do not commit `.env`.
- Do not expose Render/Resend/admin secrets in screenshots.
- The app already listens on `process.env.PORT` and `0.0.0.0`.
- Render daily disk snapshots add infrastructure protection, but also keep your own planned database backup routine.
