# OptiTrade — Final Consolidated Build 2.8.0

This package is the consolidated OptiTrade source produced from the full project ZIP that was being run locally. It keeps the current authentication, customer wallet, deposit/withdrawal, trading, investment, KYC, notification/banner, admin, email OTP, exchange-adapter and launch-audit features in one build.

## Important update rule

When replacing an existing local copy, **keep your existing**:

- `.env`
- `database/`
- `node_modules/`

Do not reset the database for this release. Database changes are applied with non-destructive migrations.

Before updating, make a backup:

```bat
npm run backup-db
```

Then replace the source files and run:

```bat
npm run cleanup-legacy
npm run audit
npm run smoke-test
npm start
```

The project requires **Node.js 24.x**.

## Final accounting model

The dashboard now separates these concepts instead of mixing them:

- **Account Value** — current value of balances/allocations across Wallet, Trading, Investment and Portfolio, counted once.
- **Total Deposited** — total USD actually credited from approved deposits.
- **Liquid Crypto Value** — current reference value of liquid BTC/ETH/USDT holdings; it is part of Account Value, not extra money to add again.
- **Profit/Loss** — trading/investment result only.

Moving funds between internal sections does not create new account value.

### Deposit entry is USD-first

For customer deposits, the customer enters the **USD amount they want credited**. OptiTrade then calculates the crypto quantity to send at the reference rate.

Example:

```text
Customer enters: $1,000
Selects: BTC
System calculates: BTC amount to send
Admin verifies payment
Admin Accepts & Credits: $1,000 USD
```

This avoids the old ambiguity where entering `1000` with BTC selected meant **1,000 BTC**.

## Correcting old test/mistaken balances

The final Admin tools intentionally do **not** guess what an old historical entry was supposed to mean.

Super Admin can now:

1. Open **Admin → Deposits** and use **Correct Credited USD** on an approved deposit whose USD credit was wrong.
2. Open **Admin → Users → customer → Transactions** and use **Reverse** on a reversible manual balance adjustment that was entered by mistake.

Both actions preserve an audit trail instead of deleting history.

## Deposit flow

```text
Choose asset/network
→ enter desired USD account credit
→ system calculates crypto amount
→ customer sends crypto
→ click I've Sent Payment
→ pending receipt generated
→ Admin verifies
→ Accept & Credit / Decline
→ receipt + notification + email update
```

A pending receipt confirms only that the customer marked payment as sent; it does not claim blockchain settlement succeeded.

## Notification/banner flow

Recent account notifications can rotate inside the main dashboard banner with Welcome, Testimonials and Admin banners. Notification slides expire from the carousel after the configured 12/24-hour window but remain in notification history.

## Production email OTP

Registration verification, login OTP and password reset codes use the configured email transport. In production, Testing OTP Mode is forced off.

Recommended environment values are documented in `.env.example` and `DEPLOYMENT-TEST-CHECKLIST.md`.

## Kraken execution

Kraken is the first external exchange adapter. Keep it in **Validate Only** until API permissions, order mapping, operational controls and your applicable compliance requirements have been verified. Deposit and withdrawal remain on the existing Admin-reviewed workflow.

## Tests

Use:

```bat
npm test
```

This runs the static production audit and the isolated end-to-end smoke test using a temporary database. It does not use your production database, Sumsub credentials or live Kraken credentials.

## Production launch

Read `DEPLOYMENT-TEST-CHECKLIST.md`, then use **Super Admin → Final Launch Check** after deployment. Resolve every Critical technical item before public use.

Technical readiness is not the same as legal/regulatory authorization to offer a financial, virtual-asset, brokerage, custody or investment service in a jurisdiction.


## Final Production Polish 2.11.0

The cumulative build has completed its UI cleanup pass. Run `npm run audit`, `npm run smoke-test`, then `npm start` before deployment.
