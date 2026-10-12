# OptiTrade 2.8.0 — Deployment & End-to-End Test Checklist

## A. Before replacing your local source

Back up the current database:

```bat
npm run backup-db
```

Keep these from your existing installation:

- `.env`
- `database/`
- `node_modules/`

Do not copy a blank database over your current database.

## B. Update and test locally

Run:

```bat
npm run cleanup-legacy
npm run audit
npm run smoke-test
```

Expected smoke-test ending:

```text
Smoke test result: PASSED
```

Then start the real local project:

```bat
npm start
```

### Manual local checks

Test with a normal customer account and an Admin account:

- Registration → email verification
- Login → email OTP
- Forgot Password → reset OTP
- Dashboard Account Value / Total Deposited / Liquid Crypto Value
- Deposit USD-first quote → I've Sent Payment → receipt → Admin review
- Deposit credit correction on a controlled test record
- Withdrawal receiver address remains user-entered and blank by default
- Internal Transfer
- Portfolio / Switch
- 14-day and longer Investment Plans
- Active Investment lifecycle
- Self-Directed Trading
- Trade with OptiTrade
- KYC & Eligibility
- Notification bell
- Rotating Welcome/Testimonial/account-notification banners
- Profile / Security / transaction PIN
- Support / Quick Help
- Admin customer Balance Center and adjustment reversal
- Email & OTP Delivery
- Exchange Integration
- System Readiness
- Final Launch Check

## C. Reconcile old historical test entries

If an older deposit was entered using a crypto amount when the intention was a USD amount, do not reset the database.

Use:

```text
Admin → Deposits → approved deposit → Correct Credited USD
```

Enter the actual USD amount that should have been credited and a correction reason.

If a separate manual Wallet/Trading/Portfolio balance adjustment was entered by mistake, use:

```text
Admin → Users → customer → Transactions → Reverse
```

Do not reverse legitimate transactions. The application keeps an audit record for both correction types.

## D. Production environment

Set secrets in the hosting environment, not in GitHub:

```env
NODE_ENV=production
DB_PATH=/var/data/optitrade.db
APP_BASE_URL=https://your-final-domain
TRUST_PROXY=true
HSTS_ENABLED=true

SESSION_SECRET=
OTP_PEPPER=

ADMIN_EMAIL=
ADMIN_PASSWORD=

SUPPORT_EMAIL=

EMAIL_PROVIDER=auto
EMAIL_SMTP_FALLBACK=true
RESEND_API_KEY=
RESEND_FROM=

SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
MAIL_FROM=

SUMSUB_APP_TOKEN=
SUMSUB_SECRET_KEY=
SUMSUB_WEBHOOK_SECRET=
SUMSUB_LEVEL_NAME=

KRAKEN_API_KEY=
KRAKEN_API_SECRET=
```

Configure only integrations you are ready to use.

## E. Render deployment

1. Put this clean source in a **private GitHub repository**.
2. Do not commit `.env`, a real database or `node_modules`.
3. Create one Render web-service instance initially.
4. Mount a persistent disk at `/var/data`.
5. Set `DB_PATH=/var/data/optitrade.db`.
6. Add environment secrets in Render.
7. Deploy and open `/api/health`.
8. Log in as Super Admin using email OTP.
9. Open **System Readiness**.
10. Open **Final Launch Check** and resolve every Critical item.
11. Connect the final HTTPS domain and set `APP_BASE_URL`.
12. Verify email sender-domain DNS.
13. Configure the Sumsub webhook before enforcing KYC.
14. Keep Kraken at **Disabled** or **Validate Only** during production verification.
15. Create a fresh controlled customer and repeat the customer journey below.

## F. Controlled hosted-domain test

```text
Register
→ receive real email verification code
→ verify
→ log out
→ login
→ receive real login OTP
→ KYC (if enabled)
→ small controlled deposit request
→ Admin Accept & Credit
→ confirm receipt / Total Deposited / Account Value
→ controlled Internal Transfer
→ small withdrawal request
→ Admin review
→ Investment Plan request
→ Admin approve / reject test
→ Self-Directed trade request
→ Admin process
→ transaction history
→ notification/banner update
```

For exchange testing:

```text
Kraken Disabled
→ Validate Only
→ confirm API permissions and pair mapping
→ inspect exchange audit/reconciliation
→ only then consider Live
```

## G. Backups

Before significant production updates:

```bat
npm run backup-db
```

Also copy backups to separate durable storage. A backup stored only on the same server/disk is not sufficient disaster recovery.

## H. Launch boundary

A clean technical audit means the software checks passed. It does not establish regulatory authorization, licensing, custody approval, suitability of an investment product or availability of a service in every country.
