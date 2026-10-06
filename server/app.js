require('dotenv').config();
const express=require('express'), path=require('path'), fs=require('fs'), crypto=require('crypto'), bcrypt=require('bcryptjs'), Database=require('better-sqlite3'), nodemailer=require('nodemailer'), cookieParser=require('cookie-parser'), rateLimit=require('express-rate-limit'), QRCode=require('qrcode');
const app=express();
const dbPath=String(process.env.DB_PATH||path.join(__dirname,'../database/optitrade.db')).trim();
fs.mkdirSync(path.dirname(dbPath),{recursive:true});
const db=new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');
console.log(`[DB] SQLite database: ${dbPath}`);
db.exec(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,email_verified INTEGER DEFAULT 0,role TEXT DEFAULT 'user',created_at TEXT DEFAULT CURRENT_TIMESTAMP);CREATE TABLE IF NOT EXISTS otps(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,code_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,used INTEGER DEFAULT 0);CREATE TABLE IF NOT EXISTS password_reset_otps(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL,
 code_hash TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 used INTEGER DEFAULT 0,
 attempts INTEGER DEFAULT 0,
 created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS password_reset_sessions(
 token_hash TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 used INTEGER DEFAULT 0,
 created_at INTEGER NOT NULL
);CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL,expires_at INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS balances(user_id INTEGER NOT NULL,asset TEXT NOT NULL,amount REAL DEFAULT 0,PRIMARY KEY(user_id,asset));CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,admin_id INTEGER,user_id INTEGER,action TEXT,asset TEXT,amount REAL,before_amount REAL,after_amount REAL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
db.exec(`CREATE TABLE IF NOT EXISTS human_challenges(
 challenge_hash TEXT PRIMARY KEY,
 answer_hash TEXT NOT NULL,
 question TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 used INTEGER DEFAULT 0,
 created_at INTEGER NOT NULL
);`);
const registrationOtpColumns=db.prepare('PRAGMA table_info(otps)').all().map(c=>c.name);
for(const [column,type] of Object.entries({
 attempts:'INTEGER DEFAULT 0',
 resend_count:'INTEGER DEFAULT 0',
 last_sent_at:'INTEGER',
 created_at:'INTEGER'
})) if(!registrationOtpColumns.includes(column)) db.exec(`ALTER TABLE otps ADD COLUMN ${column} ${type}`);
db.prepare('UPDATE otps SET attempts=COALESCE(attempts,0),resend_count=COALESCE(resend_count,0),last_sent_at=COALESCE(last_sent_at,expires_at-600000),created_at=COALESCE(created_at,expires_at-600000)').run();

const passwordResetOtpColumns=db.prepare('PRAGMA table_info(password_reset_otps)').all().map(c=>c.name);
for(const [column,type] of Object.entries({
 resend_count:'INTEGER DEFAULT 0',
 last_sent_at:'INTEGER'
})) if(!passwordResetOtpColumns.includes(column)) db.exec(`ALTER TABLE password_reset_otps ADD COLUMN ${column} ${type}`);
db.prepare('UPDATE password_reset_otps SET resend_count=COALESCE(resend_count,0),last_sent_at=COALESCE(last_sent_at,created_at)').run();

db.exec(`CREATE TABLE IF NOT EXISTS email_delivery_logs(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER,
 category TEXT NOT NULL DEFAULT 'transactional',
 recipient_masked TEXT,
 provider TEXT,
 status TEXT NOT NULL,
 provider_message_id TEXT,
 error TEXT,
 reference TEXT,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_email_delivery_logs_category ON email_delivery_logs(category,id DESC);
CREATE INDEX IF NOT EXISTS idx_email_delivery_logs_user ON email_delivery_logs(user_id,id DESC);
CREATE TABLE IF NOT EXISTS test_password_reset_otp_codes(
 user_id INTEGER PRIMARY KEY,
 code TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL
);`);



// Persistent support conversations and messages.
db.exec(`CREATE TABLE IF NOT EXISTS support_threads(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE NOT NULL,
  status TEXT DEFAULT 'open',
  unread_user INTEGER DEFAULT 0,
  unread_admin INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS support_messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL,
  sender_role TEXT NOT NULL,
  sender_id INTEGER,
  body TEXT NOT NULL,
  kind TEXT DEFAULT 'text',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);`);

// Super Admin-managed quick help questions shown inside customer support.
db.exec(`CREATE TABLE IF NOT EXISTS support_faqs(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 question TEXT NOT NULL,
 answer TEXT NOT NULL,
 active INTEGER DEFAULT 1,
 sort_order INTEGER DEFAULT 0,
 updated_by INTEGER,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS support_faq_reads(
 user_id INTEGER NOT NULL,
 faq_id INTEGER NOT NULL,
 clicked_at TEXT DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(user_id,faq_id)
);
CREATE TABLE IF NOT EXISTS support_faq_meta(
 id INTEGER PRIMARY KEY CHECK(id=1),
 seeded INTEGER DEFAULT 0
);`);
db.prepare('INSERT OR IGNORE INTO support_faq_meta(id,seeded) VALUES(1,0)').run();
if(Number(db.prepare('SELECT seeded FROM support_faq_meta WHERE id=1').get()?.seeded||0)===0){
 const defaults=[
  ['How can I trade?',`Open Trade from your dashboard. Choose the trading option available to your account, review the asset, amount and reference market information, then submit the request.

The current OptiTrade trading workflow is an internal platform workflow unless external execution is specifically enabled. Trading can produce profits or losses, so review every request carefully and never assume a return is guaranteed.`],
  ['How do I make profits?',`There is no guaranteed way to make a profit from trading or investing. Market prices can move in either direction and losses are possible.

Use the market information and risk controls available in OptiTrade, understand the trade before submitting it, and review your account activity after settlement. Never treat a projected or previous result as a guaranteed future return.`],
  ['How can I deposit?',`Open Deposit from the dashboard, choose the asset and the exact network, then copy the receiving address shown by OptiTrade.

Send only on the matching network. After sending, enter the amount and transaction ID (TXID) and submit the deposit for review. The request remains Pending until it is reviewed. Sending to the wrong address or network can cause permanent loss.`],
  ['How can I withdraw?',`Open Withdraw, select the asset, enter the amount and the receiving wallet address, then submit the request.

The withdrawal will show as Pending while it is reviewed. Check the receiving address carefully before submitting. Pending withdrawal amounts may be reserved from your available balance until the request is completed or declined.`],
  ['How do I connect my crypto wallet?',`Open Connect Wallet from the dashboard. Choose the wallet family you use: EVM/WalletConnect, Bitcoin, Solana or TRON, then approve the connection inside your wallet app.

OptiTrade should only receive public wallet connection information. Never enter a seed phrase, recovery phrase or private key into OptiTrade or send one to support.`],
  ['How do I keep my account secure?',`Use a unique password and keep access to your verified email secure. OptiTrade requires a login OTP after your password is accepted.

Never share your password, OTP, seed phrase, private key or recovery phrase with anyone, including someone claiming to be support. If you notice an unexpected login or account activity, contact support immediately.`]
 ];
 const insert=db.prepare('INSERT INTO support_faqs(question,answer,active,sort_order) VALUES(?,?,1,?)');
 db.transaction(()=>{defaults.forEach((x,i)=>insert.run(x[0],x[1],i+1));db.prepare('UPDATE support_faq_meta SET seeded=1 WHERE id=1').run()})();
}

// Fresh-database bootstrap for FAQ override tables.
// These must exist BEFORE the feature FAQ migrations below query them.
db.exec(`CREATE TABLE IF NOT EXISTS support_faq_admin_meta(
 admin_id INTEGER PRIMARY KEY,
 has_override INTEGER DEFAULT 0,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS support_faq_admin_items(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 admin_id INTEGER NOT NULL,
 question TEXT NOT NULL,
 answer TEXT NOT NULL,
 active INTEGER DEFAULT 1,
 sort_order INTEGER DEFAULT 0,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_support_faq_admin_items_admin ON support_faq_admin_items(admin_id,sort_order,id);
CREATE TABLE IF NOT EXISTS support_faq_reads_v2(
 user_id INTEGER NOT NULL,
 scope TEXT NOT NULL,
 faq_key INTEGER NOT NULL,
 clicked_at TEXT DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(user_id,scope,faq_key)
);`);

// Non-destructive feature FAQ migrations. These append new platform help topics
// without resetting Super Admin content or existing Sub-Admin customer overrides.
db.exec(`CREATE TABLE IF NOT EXISTS support_faq_feature_migrations(
 migration_key TEXT PRIMARY KEY,
 applied_at TEXT DEFAULT CURRENT_TIMESTAMP
);`);
if(!db.prepare('SELECT migration_key FROM support_faq_feature_migrations WHERE migration_key=?').get('bot_copy_help_v1')){
 const additions=[
  ['Can I use Bot Trading?',`Bot Trading can automate trading activity on your behalf only when the feature has been enabled for your account.

To request access, open the Help Center and send a message asking for Bot Trading. Support can explain the available automation profile, the amount you want to allocate, risk limits, and how to pause or disable the automation.

Bot Trading does not guarantee profit and losses are possible. In the current OptiProTrade build, automated activity is an internal platform workflow unless a genuine external broker or exchange execution integration is specifically enabled. Never give support your wallet seed phrase, recovery phrase or private key.`],
  ['How does Copy Trading work?',`Copy Trading is designed to let an account follow an approved trading strategy or trader profile under limits chosen for that account.

You can ask about Copy Trading from the Help Center. Before it is enabled, review the amount to allocate, the strategy or profile being followed, risk limits, and how to stop copying. Past performance or another trader's result does not guarantee future profit, and losses are possible.

In the current OptiProTrade build, Copy Trading uses the internal account workflow unless external execution is specifically integrated and enabled for your account.`]
 ];
 db.transaction(()=>{
   let next=Number(db.prepare('SELECT COALESCE(MAX(sort_order),0) n FROM support_faqs').get()?.n||0)+1;
   for(const [question,answer] of additions){
     const exists=db.prepare('SELECT id FROM support_faqs WHERE lower(question)=lower(?)').get(question);
     if(!exists)db.prepare('INSERT INTO support_faqs(question,answer,active,sort_order) VALUES(?,?,1,?)').run(question,answer,next++);
   }

   // Existing Sub-Admins with a local Quick Help override receive local copies
   // so they can edit the wording for only their own customers.
   for(const meta of db.prepare('SELECT admin_id FROM support_faq_admin_meta WHERE has_override=1').all()){
     let localNext=Number(db.prepare('SELECT COALESCE(MAX(sort_order),0) n FROM support_faq_admin_items WHERE admin_id=?').get(meta.admin_id)?.n||0)+1;
     for(const [question,answer] of additions){
       const exists=db.prepare('SELECT id FROM support_faq_admin_items WHERE admin_id=? AND lower(question)=lower(?)').get(meta.admin_id,question);
       if(!exists)db.prepare('INSERT INTO support_faq_admin_items(admin_id,question,answer,active,sort_order) VALUES(?,?,?,1,?)').run(meta.admin_id,question,answer,localNext++);
     }
   }
   db.prepare('INSERT INTO support_faq_feature_migrations(migration_key) VALUES(?)').run('bot_copy_help_v1');
 })();
}

if(!db.prepare('SELECT migration_key FROM support_faq_feature_migrations WHERE migration_key=?').get('investment_plan_help_v1')){
 const additions=[
  ['How do Investment Plans work?',`Investment Plans are managed strategy models configured by OptiProTrade. Open Investment Plans from your dashboard, choose a plan, and review its market focus, minimum allocation, available durations, risk level and any target return range configured for that plan.

You can enter the amount of BTC, ETH or USDT you want to allocate. OptiProTrade converts it to a USD reference value so the plan minimum and projected range can be shown consistently. A submitted plan request is reviewed before activation.`],
  ['What is the minimum amount for an Investment Plan?',`Each Investment Plan can have a different minimum allocation set by the Super Admin. Open the plan and you will see the current minimum before you enter an amount.

Because funding is crypto-based, the amount you enter in BTC, ETH or USDT is converted to a USD reference value when checking whether it meets the plan minimum.`],
  ['Can I choose how long an Investment Plan runs?',`Yes. Each plan can have one or more available periods, such as 30, 60 or 90 days. The periods are configured by the Super Admin and are shown on the plan details page.

Select the period you want before reviewing the allocation. Any target range shown for that period is an estimate or target, not a guaranteed result.`],
  ['How is an Investment Plan return calculated?',`If a plan has a target return range, OptiProTrade applies that configured percentage range to the USD reference value of the amount you want to allocate. This produces an estimated low-to-high outcome for the selected period.

A target or projected return is not guaranteed. Market performance can be higher or lower, including a loss. Always review the plan details before submitting a request.`]
 ];
 db.transaction(()=>{
   let next=Number(db.prepare('SELECT COALESCE(MAX(sort_order),0) n FROM support_faqs').get()?.n||0)+1;
   for(const [question,answer] of additions){
     if(!db.prepare('SELECT id FROM support_faqs WHERE lower(question)=lower(?)').get(question))
       db.prepare('INSERT INTO support_faqs(question,answer,active,sort_order) VALUES(?,?,1,?)').run(question,answer,next++);
   }
   for(const meta of db.prepare('SELECT admin_id FROM support_faq_admin_meta WHERE has_override=1').all()){
     let localNext=Number(db.prepare('SELECT COALESCE(MAX(sort_order),0) n FROM support_faq_admin_items WHERE admin_id=?').get(meta.admin_id)?.n||0)+1;
     for(const [question,answer] of additions){
       if(!db.prepare('SELECT id FROM support_faq_admin_items WHERE admin_id=? AND lower(question)=lower(?)').get(meta.admin_id,question))
         db.prepare('INSERT INTO support_faq_admin_items(admin_id,question,answer,active,sort_order) VALUES(?,?,?,1,?)').run(meta.admin_id,question,answer,localNext++);
     }
   }
   db.prepare('INSERT INTO support_faq_feature_migrations(migration_key) VALUES(?)').run('investment_plan_help_v1');
 })();
}


if(!db.prepare('SELECT migration_key FROM support_faq_feature_migrations WHERE migration_key=?').get('internal_transfer_help_v1')){
 const additions=[
  ['How do Internal Transfers work?',`Internal Transfer lets you send supported crypto balances directly to another OptiProTrade customer using their exact username or verified email address.

Open Internal Transfer, choose BTC, ETH or USDT, verify the recipient, enter the amount and review the transfer. Your 4-digit transaction PIN is required before the transfer can be completed. The recipient's OptiProTrade balance is credited inside the platform after a successful transfer.`],
  ['Are Internal Transfers instant and is there a fee?',`A completed Internal Transfer updates the sender and recipient OptiProTrade account balances immediately inside the platform. The current internal-transfer fee is 0.

Internal Transfer is not an external blockchain withdrawal. If you want to send crypto to an outside wallet address, use the Withdrawal section instead.`]
 ];
 db.transaction(()=>{
   let next=Number(db.prepare('SELECT COALESCE(MAX(sort_order),0) n FROM support_faqs').get()?.n||0)+1;
   for(const [question,answer] of additions){
     if(!db.prepare('SELECT id FROM support_faqs WHERE lower(question)=lower(?)').get(question))
       db.prepare('INSERT INTO support_faqs(question,answer,active,sort_order) VALUES(?,?,1,?)').run(question,answer,next++);
   }
   for(const meta of db.prepare('SELECT admin_id FROM support_faq_admin_meta WHERE has_override=1').all()){
     let localNext=Number(db.prepare('SELECT COALESCE(MAX(sort_order),0) n FROM support_faq_admin_items WHERE admin_id=?').get(meta.admin_id)?.n||0)+1;
     for(const [question,answer] of additions){
       if(!db.prepare('SELECT id FROM support_faq_admin_items WHERE admin_id=? AND lower(question)=lower(?)').get(meta.admin_id,question))
         db.prepare('INSERT INTO support_faq_admin_items(admin_id,question,answer,active,sort_order) VALUES(?,?,?,1,?)').run(meta.admin_id,question,answer,localNext++);
     }
   }
   db.prepare('INSERT INTO support_faq_feature_migrations(migration_key) VALUES(?)').run('internal_transfer_help_v1');
 })();
}


if(!db.prepare('SELECT migration_key FROM support_faq_feature_migrations WHERE migration_key=?').get('investment_lifecycle_help_v1')){
 const additions=[
  ['Where can I see my active investment?',`Open Investment Plans from the dashboard. The Active Investments section shows plans that have been approved, including the allocated crypto, starting reference value, start date, maturity date, progress and the latest performance update entered for the investment.

Use View Investment to open the full investment record and review its plan terms, timeline and latest result.`],
  ['What happens when my Investment Plan matures?',`When an active plan reaches its maturity date, it becomes ready for settlement. The final result is recorded by the assigned administrator and the settlement value is returned to your account in the plan's funding asset using the settlement reference price.

The final result can be higher or lower than the original allocation. Any target range shown on the plan is a target or projection and is not a guaranteed return.`],
  ['Can I cancel an Investment Plan?',`A Pending investment request can be cancelled before it is approved. If the request had reserved funds, the reserved BTC, ETH or USDT is released back to your available wallet balance.

After a request becomes Active, it cannot be cancelled from the customer page. Contact Support if you need help with an active plan.`]
 ];
 db.transaction(()=>{
   let next=Number(db.prepare('SELECT COALESCE(MAX(sort_order),0) n FROM support_faqs').get()?.n||0)+1;
   for(const [question,answer] of additions){
     if(!db.prepare('SELECT id FROM support_faqs WHERE lower(question)=lower(?)').get(question))
       db.prepare('INSERT INTO support_faqs(question,answer,active,sort_order) VALUES(?,?,1,?)').run(question,answer,next++);
   }
   for(const meta of db.prepare('SELECT admin_id FROM support_faq_admin_meta WHERE has_override=1').all()){
     let localNext=Number(db.prepare('SELECT COALESCE(MAX(sort_order),0) n FROM support_faq_admin_items WHERE admin_id=?').get(meta.admin_id)?.n||0)+1;
     for(const [question,answer] of additions){
       if(!db.prepare('SELECT id FROM support_faq_admin_items WHERE admin_id=? AND lower(question)=lower(?)').get(meta.admin_id,question))
         db.prepare('INSERT INTO support_faq_admin_items(admin_id,question,answer,active,sort_order) VALUES(?,?,?,1,?)').run(meta.admin_id,question,answer,localNext++);
     }
   }
   db.prepare('INSERT INTO support_faq_feature_migrations(migration_key) VALUES(?)').run('investment_lifecycle_help_v1');
 })();
}


if(!db.prepare('SELECT migration_key FROM support_faq_feature_migrations WHERE migration_key=?').get('kyc_help_v1')){
 const additions=[
  ['How do I verify my identity?',`Open Identity Verification from your Profile. OptiProTrade launches the configured verification provider in a secure embedded flow. The provider will show the identity and liveness steps required for your country and verification level.\n\nOptiProTrade stores the verification status and provider identifiers, and this integration does not store copies of your identity-document images in the OptiProTrade database.`],
  ['Why is KYC required?',`Identity verification helps establish who controls an account and supports compliance, fraud prevention and account security. Depending on the platform settings, KYC can be required before certain trading or investment features are available.\n\nVerification requirements can vary by country and by the verification level configured for the account.`]
 ];
 db.transaction(()=>{
  let next=Number(db.prepare('SELECT COALESCE(MAX(sort_order),0) n FROM support_faqs').get()?.n||0)+1;
  for(const [q,a] of additions)if(!db.prepare('SELECT id FROM support_faqs WHERE lower(question)=lower(?)').get(q))db.prepare('INSERT INTO support_faqs(question,answer,active,sort_order) VALUES(?,?,1,?)').run(q,a,next++);
  for(const meta of db.prepare('SELECT admin_id FROM support_faq_admin_meta WHERE has_override=1').all()){
   let n=Number(db.prepare('SELECT COALESCE(MAX(sort_order),0) n FROM support_faq_admin_items WHERE admin_id=?').get(meta.admin_id)?.n||0)+1;
   for(const [q,a] of additions)if(!db.prepare('SELECT id FROM support_faq_admin_items WHERE admin_id=? AND lower(question)=lower(?)').get(meta.admin_id,q))db.prepare('INSERT INTO support_faq_admin_items(admin_id,question,answer,active,sort_order) VALUES(?,?,?,1,?)').run(meta.admin_id,q,a,n++);
  }
  db.prepare('INSERT INTO support_faq_feature_migrations(migration_key) VALUES(?)').run('kyc_help_v1');
 })();
}


if(!db.prepare('SELECT migration_key FROM support_faq_feature_migrations WHERE migration_key=?').get('exchange_execution_help_v1')){
 const additions=[
  ['How are my trades executed?',`A trade is first submitted from your OptiProTrade account and assigned for review. The trade history shows whether the request is being handled through the platform workflow or routed to a configured external exchange.

For eligible crypto markets, an administrator can route the trade through the connected exchange when external execution is enabled. Forex or unsupported markets remain in the platform workflow until a compatible execution provider is connected.`],
  ['What does Exchange execution mean?',`Exchange execution means an eligible trade order was submitted to the connected external exchange and linked to your OptiProTrade trade reference.

The trade record can show exchange submission, fill status and reconciliation details. Exchange execution can fail because of market availability, exchange account balance, API permissions, provider maintenance, minimum order rules or other provider restrictions. A submitted request is not treated as externally filled until the exchange reports execution.`]
 ];
 db.transaction(()=>{
  let next=Number(db.prepare('SELECT COALESCE(MAX(sort_order),0) n FROM support_faqs').get()?.n||0)+1;
  for(const [q,a] of additions){
   if(!db.prepare('SELECT id FROM support_faqs WHERE lower(question)=lower(?)').get(q))
    db.prepare('INSERT INTO support_faqs(question,answer,active,sort_order) VALUES(?,?,1,?)').run(q,a,next++);
  }
  for(const meta of db.prepare('SELECT admin_id FROM support_faq_admin_meta WHERE has_override=1').all()){
   let localNext=Number(db.prepare('SELECT COALESCE(MAX(sort_order),0) n FROM support_faq_admin_items WHERE admin_id=?').get(meta.admin_id)?.n||0)+1;
   for(const [q,a] of additions){
    if(!db.prepare('SELECT id FROM support_faq_admin_items WHERE admin_id=? AND lower(question)=lower(?)').get(meta.admin_id,q))
     db.prepare('INSERT INTO support_faq_admin_items(admin_id,question,answer,active,sort_order) VALUES(?,?,?,1,?)').run(meta.admin_id,q,a,localNext++);
   }
  }
  db.prepare('INSERT INTO support_faq_feature_migrations(migration_key) VALUES(?)').run('exchange_execution_help_v1');
 })();
}


if(!db.prepare('SELECT migration_key FROM support_faq_feature_migrations WHERE migration_key=?').get('compliance_eligibility_help_v1')){
 const additions=[
  ['Why is a feature unavailable after identity verification?',`Identity verification is one part of account eligibility. A feature can also be temporarily unavailable if the account is under manual compliance review or if an eligibility rule applies to the account country.

Open Identity Verification to see your current verification and eligibility status. If the page says Manual Review or Restricted, contact Support if you need clarification.`],
  ['Can verification or feature availability vary by country?',`Yes. Verification requirements and available services can vary by country, provider coverage and the platform's configured eligibility policy.

OptiProTrade does not automatically assume one country's rules apply everywhere. Country eligibility controls are configured separately and can require review or restrict specific account features.`]
 ];
 db.transaction(()=>{
  let next=Number(db.prepare('SELECT COALESCE(MAX(sort_order),0) n FROM support_faqs').get()?.n||0)+1;
  for(const [q,a] of additions){
   if(!db.prepare('SELECT id FROM support_faqs WHERE lower(question)=lower(?)').get(q))
    db.prepare('INSERT INTO support_faqs(question,answer,active,sort_order) VALUES(?,?,1,?)').run(q,a,next++);
  }
  for(const meta of db.prepare('SELECT admin_id FROM support_faq_admin_meta WHERE has_override=1').all()){
   let localNext=Number(db.prepare('SELECT COALESCE(MAX(sort_order),0) n FROM support_faq_admin_items WHERE admin_id=?').get(meta.admin_id)?.n||0)+1;
   for(const [q,a] of additions){
    if(!db.prepare('SELECT id FROM support_faq_admin_items WHERE admin_id=? AND lower(question)=lower(?)').get(meta.admin_id,q))
     db.prepare('INSERT INTO support_faq_admin_items(admin_id,question,answer,active,sort_order) VALUES(?,?,?,1,?)').run(meta.admin_id,q,a,localNext++);
   }
  }
  db.prepare('INSERT INTO support_faq_feature_migrations(migration_key) VALUES(?)').run('compliance_eligibility_help_v1');
 })();
}

function supportFaqScopeForUser(user){
 const adminId=customerAdminId(user);
 if(adminId){
   const meta=db.prepare('SELECT has_override FROM support_faq_admin_meta WHERE admin_id=?').get(adminId);
   if(Number(meta?.has_override||0)===1)return {scope:'admin',adminId};
 }
 return {scope:'global',adminId:null};
}
function supportFaqsForUser(user){
 const source=supportFaqScopeForUser(user);
 if(source.scope==='admin'){
   return db.prepare(`SELECT f.id,f.question,f.sort_order,'admin' scope,
     CASE WHEN EXISTS(
       SELECT 1 FROM support_faq_reads_v2 r
       WHERE r.user_id=? AND r.scope='admin' AND r.faq_key=f.id
     ) THEN 1 ELSE 0 END answered
     FROM support_faq_admin_items f
     WHERE f.admin_id=? AND f.active=1
     ORDER BY f.sort_order ASC,f.id ASC`).all(user.id,source.adminId);
 }
 return db.prepare(`SELECT f.id,f.question,f.sort_order,'global' scope,
   CASE WHEN EXISTS(SELECT 1 FROM support_faq_reads old WHERE old.user_id=? AND old.faq_id=f.id)
          OR EXISTS(SELECT 1 FROM support_faq_reads_v2 r WHERE r.user_id=? AND r.scope='global' AND r.faq_key=f.id)
        THEN 1 ELSE 0 END answered
   FROM support_faqs f
   WHERE f.active=1
   ORDER BY f.sort_order ASC,f.id ASC`).all(user.id,user.id);
}
function supportFaqCountsForUser(user){
 const source=supportFaqScopeForUser(user);
 if(source.scope==='admin'){
   const total=Number(db.prepare('SELECT COUNT(*) n FROM support_faq_admin_items WHERE admin_id=? AND active=1').get(source.adminId)?.n||0);
   const answered=Number(db.prepare(`SELECT COUNT(*) n FROM support_faq_reads_v2 r JOIN support_faq_admin_items f ON f.id=r.faq_key AND f.admin_id=? WHERE r.user_id=? AND r.scope='admin' AND f.active=1`).get(source.adminId,user.id)?.n||0);
   return {total,answered,scope:'admin'};
 }
 const total=Number(db.prepare('SELECT COUNT(*) n FROM support_faqs WHERE active=1').get()?.n||0);
 const answered=Number(db.prepare(`SELECT COUNT(DISTINCT f.id) n FROM support_faqs f LEFT JOIN support_faq_reads old ON old.faq_id=f.id AND old.user_id=? LEFT JOIN support_faq_reads_v2 r ON r.faq_key=f.id AND r.user_id=? AND r.scope='global' WHERE f.active=1 AND (old.user_id IS NOT NULL OR r.user_id IS NOT NULL)`).get(user.id,user.id)?.n||0);
 return {total,answered,scope:'global'};
}


// Super Admin-managed global welcome messaging.
db.exec(`CREATE TABLE IF NOT EXISTS welcome_settings(
 id INTEGER PRIMARY KEY CHECK(id=1),
 active INTEGER DEFAULT 1,
 email_subject TEXT NOT NULL,
 email_body TEXT NOT NULL,
 notification_title TEXT NOT NULL,
 notification_body TEXT NOT NULL,
 support_body TEXT NOT NULL,
 updated_by INTEGER,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS welcome_deliveries(
 user_id INTEGER PRIMARY KEY,
 notification_sent_at TEXT,
 email_sent_at TEXT,
 email_status TEXT,
 support_sent_at TEXT,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);`);

db.exec(`CREATE TABLE IF NOT EXISTS welcome_admin_overrides(
 admin_id INTEGER PRIMARY KEY,
 active INTEGER DEFAULT 1,
 email_subject TEXT NOT NULL,
 email_body TEXT NOT NULL,
 notification_title TEXT NOT NULL,
 notification_body TEXT NOT NULL,
 support_body TEXT NOT NULL,
 updated_by INTEGER,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS support_faq_admin_meta(
 admin_id INTEGER PRIMARY KEY,
 has_override INTEGER DEFAULT 0,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS support_faq_admin_items(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 admin_id INTEGER NOT NULL,
 question TEXT NOT NULL,
 answer TEXT NOT NULL,
 active INTEGER DEFAULT 1,
 sort_order INTEGER DEFAULT 0,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_support_faq_admin_items_admin ON support_faq_admin_items(admin_id,sort_order,id);
CREATE TABLE IF NOT EXISTS support_faq_reads_v2(
 user_id INTEGER NOT NULL,
 scope TEXT NOT NULL,
 faq_key INTEGER NOT NULL,
 clicked_at TEXT DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(user_id,scope,faq_key)
);`);


db.prepare(`INSERT OR IGNORE INTO welcome_settings
(id,active,email_subject,email_body,notification_title,notification_body,support_body)
VALUES(1,1,?,?,?,?,?)`).run(
 'Welcome to OptiTrade, {{first_name}}',
 `Hello {{first_name}},

Welcome to OptiTrade. Your account has been successfully verified and is ready to use.

Trading username: {{username}}
Account created: {{created_date}}

You can now explore your dashboard, market reference data, trading tools, portfolio and account activity.

Deposit and withdrawal approval updates the OptiTrade account ledger. External blockchain settlement is separate unless a connected execution/custody integration is explicitly enabled.

Never share your password, OTP, private key, recovery phrase or reset code with anyone.

— OptiTrade Support`,
 'Welcome to OptiTrade',
 `Welcome {{first_name}}. Your OptiTrade account is ready. Explore your dashboard, markets, trading tools and account activity.`,
 `👋 Welcome to OptiTrade, {{first_name}}!

Your account is ready. You can explore Live Markets, Trading, Portfolio, Account Activity and Support.

Quick start:
• Review your profile and security settings.
• Review market reference data before submitting a trade.
• Review whether each trade is handled internally or through an enabled external execution provider.
• Review your Portfolio and Account Activity regularly.
• Never share your password, OTP, private key, recovery phrase or reset code.

Trading involves risk and profits are never guaranteed. Internal workflow results are account-ledger results unless external execution is explicitly enabled.

Need help? Reply here and OptiTrade Support can continue the conversation.`
);
try{
 db.prepare(`UPDATE welcome_settings SET
   email_body=REPLACE(email_body,'Deposit, withdrawal and trading workflows marked Demo use the platform internal ledger until external execution and settlement integrations are enabled.','Deposit and withdrawal approval updates the OptiTrade account ledger. External blockchain settlement is separate unless a connected execution/custody integration is explicitly enabled.'),
   notification_body=REPLACE(notification_body,'demo trading tools','trading tools'),
   support_body=REPLACE(REPLACE(REPLACE(REPLACE(support_body,'Live Markets, Demo Trading, Portfolio','Live Markets, Trading, Portfolio'),'placing demo trades','submitting a trade'),'Use Demo Trading to practice with simulated funds.','Review whether each trade is handled internally or through an enabled external execution provider.'),'Demo balances and demo trades are simulated.','Internal workflow results are account-ledger results unless external execution is explicitly enabled.')
   WHERE id=1`).run();
 db.prepare(`UPDATE support_faqs SET answer=REPLACE(answer,'internal/demo workflow','internal workflow') WHERE lower(question)=lower('How does Copy Trading work?')`).run();
}catch(e){console.warn('[COPY CLEANUP MIGRATION]',e.message)}


const WELCOME_KEYS=new Set(['first_name','full_name','username','email','created_date','platform_name']);
function welcomeValues(u){
 const full=String(u.name||'Trader').trim()||'Trader';
 return {
  first_name:full.split(/\s+/)[0]||'Trader',
  full_name:full,
  username:String(u.username||''),
  email:String(u.email||''),
  created_date:new Date(String(u.created_at||new Date().toISOString()).replace(' ','T')+'Z').toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}),
  platform_name:'OptiTrade'
 };
}
function renderWelcomeTemplate(tpl,u){
 const values=welcomeValues(u);
 return String(tpl||'').replace(/\{\{([a-z_]+)\}\}/g,(m,k)=>WELCOME_KEYS.has(k)?values[k]:m);
}
function welcomeSettingsForUser(user){
 const adminId=customerAdminId(user);
 if(adminId){
   const local=db.prepare('SELECT * FROM welcome_admin_overrides WHERE admin_id=?').get(adminId);
   if(local)return {...local,scope:'admin',source_admin_id:adminId};
 }
 const global=db.prepare('SELECT * FROM welcome_settings WHERE id=1').get();
 return global?{...global,scope:'global',source_admin_id:superAdminId()}:null;
}
function ensureWelcomeDeliveryRow(userId){
 db.prepare('INSERT OR IGNORE INTO welcome_deliveries(user_id) VALUES(?)').run(userId);
 return db.prepare('SELECT * FROM welcome_deliveries WHERE user_id=?').get(userId);
}
function ensureWelcome(userId){
 let thread=db.prepare('SELECT * FROM support_threads WHERE user_id=?').get(userId);
 if(!thread){
   const info=db.prepare("INSERT INTO support_threads(user_id,status,unread_user,unread_admin) VALUES(?,'open',0,0)").run(userId);
   thread={id:info.lastInsertRowid,user_id:userId,unread_user:0,unread_admin:0,status:'open'};
 }
 const u=db.prepare('SELECT id,name,email,username,created_at,owner_admin_id FROM users WHERE id=?').get(userId);
 const settings=u?welcomeSettingsForUser(u):null;
 if(settings?.active && u){
   const d=ensureWelcomeDeliveryRow(userId);
   if(!d.support_sent_at){
     const body=renderWelcomeTemplate(settings.support_body,u);
     if(body.trim()){
       db.prepare("INSERT INTO support_messages(thread_id,sender_role,sender_id,body,kind) VALUES(?,'support',NULL,?,'welcome')").run(thread.id,body);
       db.prepare("UPDATE support_threads SET unread_user=unread_user+1,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(thread.id);
       db.prepare("UPDATE welcome_deliveries SET support_sent_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE user_id=?").run(userId);
     }
   }
 }
 return db.prepare('SELECT * FROM support_threads WHERE user_id=?').get(userId);
}
function deliverWelcomeOnce(userId){
 const u=db.prepare('SELECT id,name,email,username,created_at,role,owner_admin_id FROM users WHERE id=?').get(userId);
 const settings=u?welcomeSettingsForUser(u):null;
 if(!settings?.active||!u||u.role!=='user')return;
 let d=ensureWelcomeDeliveryRow(userId);
 if(!d.notification_sent_at){
   const title=renderWelcomeTemplate(settings.notification_title,u);
   const body=renderWelcomeTemplate(settings.notification_body,u);
   if(title.trim()&&body.trim())notifyUser(userId,'welcome',title,body,'/dashboard.html');
   db.prepare("UPDATE welcome_deliveries SET notification_sent_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE user_id=?").run(userId);
 }
 ensureWelcome(userId);
 d=ensureWelcomeDeliveryRow(userId);
 if(!d.email_sent_at){
   const subject=renderWelcomeTemplate(settings.email_subject,u);
   const body=renderWelcomeTemplate(settings.email_body,u);
   setImmediate(async()=>{
     let status='failed';
     try{const r=await sendGeneralEmail(u.email,subject,body);status=r.dev?'dev_logged':'delivered'}catch(e){console.error('[WELCOME EMAIL]',e.message)}
     db.prepare("UPDATE welcome_deliveries SET email_sent_at=CURRENT_TIMESTAMP,email_status=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?").run(status,userId);
   });
 }
}

// Admin Dashboard v2 persistent events.
db.exec(`CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,type TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,href TEXT,is_read INTEGER DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS account_activity(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,actor_id INTEGER,type TEXT NOT NULL,summary TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS demo_transactions(id INTEGER PRIMARY KEY AUTOINCREMENT,reference TEXT UNIQUE NOT NULL,user_id INTEGER NOT NULL,actor_id INTEGER,type TEXT NOT NULL,asset TEXT NOT NULL,amount REAL NOT NULL,direction TEXT NOT NULL,status TEXT DEFAULT 'completed',note TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
function notifyUser(uid,type,title,body,href=null){db.prepare('INSERT INTO notifications(user_id,type,title,body,href) VALUES(?,?,?,?,?)').run(uid,type,title,body,href)}

db.exec(`CREATE TABLE IF NOT EXISTS telegram_admin_settings(
 admin_id INTEGER PRIMARY KEY,
 bot_token_enc TEXT NOT NULL,
 chat_id TEXT NOT NULL,
 bot_username TEXT,
 enabled INTEGER DEFAULT 1,
 events TEXT DEFAULT '["registration","deposit","withdrawal","trade","support"]',
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);`);

function telegramCryptoKey(){
 const seed=String(process.env.TELEGRAM_ENCRYPTION_KEY||process.env.SESSION_SECRET||'').trim();
 if(!seed)return null;
 return crypto.createHash('sha256').update(seed).digest();
}
function encryptTelegramToken(value){
 const key=telegramCryptoKey();if(!key)throw new Error('TELEGRAM_ENCRYPTION_KEY or SESSION_SECRET is required.');
 const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
 const encrypted=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]),tag=cipher.getAuthTag();
 return ['v1',iv.toString('base64'),tag.toString('base64'),encrypted.toString('base64')].join(':');
}
function decryptTelegramToken(value){
 const key=telegramCryptoKey();if(!key)throw new Error('Telegram encryption key is unavailable.');
 const parts=String(value||'').split(':');if(parts.length!==4||parts[0]!=='v1')throw new Error('Telegram token data is invalid.');
 const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(parts[1],'base64'));
 decipher.setAuthTag(Buffer.from(parts[2],'base64'));
 return Buffer.concat([decipher.update(Buffer.from(parts[3],'base64')),decipher.final()]).toString('utf8');
}
function telegramEvents(value){
 try{const a=JSON.parse(value||'[]');return Array.isArray(a)?a:[]}catch{return []}
}
try{
 for(const row of db.prepare('SELECT admin_id,events FROM telegram_admin_settings').all()){
   const events=telegramEvents(row.events);
   if(!events.includes('referral_click')){
     events.push('referral_click');
     db.prepare('UPDATE telegram_admin_settings SET events=?,updated_at=CURRENT_TIMESTAMP WHERE admin_id=?').run(JSON.stringify(events),row.admin_id);
   }
 }
}catch(e){console.error('[TELEGRAM EVENT MIGRATION]',e.message)}
async function telegramBotRequest(token,method,payload){
 const r=await fetch(`https://api.telegram.org/bot${token}/${method}`,{
   method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload||{})
 });
 let d={};try{d=await r.json()}catch{}
 if(!r.ok||!d.ok)throw new Error(d.description||`Telegram request failed (${r.status})`);
 return d.result;
}
function urgentAdminEvent(event){return ['deposit','withdrawal','trade'].includes(String(event||''))}
async function sendTelegramAdminAlert(adminId,event,title,body,href=null){
 const s=db.prepare('SELECT * FROM telegram_admin_settings WHERE admin_id=? AND enabled=1').get(adminId);
 if(!s)return {skipped:true};
 const urgent=urgentAdminEvent(event),events=telegramEvents(s.events);
 if(!urgent&&!events.includes(event))return {skipped:true};
 const token=decryptTelegramToken(s.bot_token_enc);
 let action='';
 try{
  const base=productionBaseUrl();
  if(base&&href)action=`\n\nTake action: ${base}${String(href).startsWith('/')?'':'/'}${String(href)}`;
 }catch{}
 const text=`🚨 OptiTrade — ${title}\n\n${body}${action}\n\n${new Date().toISOString().replace('T',' ').replace(/\.\d{3}Z$/,' UTC')}`;
 const message=await telegramBotRequest(token,'sendMessage',{chat_id:s.chat_id,text});
 return {ok:true,messageId:message?.message_id||null};
}
function notifyAdminEvent(adminId,event,title,body,href=null){
 if(!adminId)return;
 notifyUser(adminId,event,title,body,href);
 setImmediate(()=>sendTelegramAdminAlert(adminId,event,title,body,href).catch(e=>console.error('[TELEGRAM ALERT]',e.message)));
}
function notifyUrgentAdminEvent(adminId,event,title,body,href=null){
 const recipients=new Set();
 if(adminId)recipients.add(Number(adminId));
 const superId=superAdminId();if(superId)recipients.add(Number(superId));
 for(const id of recipients){
  notifyUser(id,event,title,body,href);
  setImmediate(()=>sendTelegramAdminAlert(id,event,title,body,href).catch(e=>console.error('[URGENT TELEGRAM ALERT]',e.message)));
 }
}

function logActivity(uid,actor,type,summary){db.prepare('INSERT INTO account_activity(user_id,actor_id,type,summary) VALUES(?,?,?,?)').run(uid,actor||null,type,summary)}
function ledgerRef(){return 'OT-LEDGER-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(3).toString('hex').toUpperCase()}

// Admin Email / In-App Message Center.
db.exec(`CREATE TABLE IF NOT EXISTS message_campaigns(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 sender_admin_id INTEGER NOT NULL,
 subject TEXT NOT NULL,
 body TEXT NOT NULL,
 send_email INTEGER DEFAULT 1,
 send_inapp INTEGER DEFAULT 1,
 audience TEXT DEFAULT 'all',
 status TEXT DEFAULT 'queued',
 total INTEGER DEFAULT 0,
 delivered INTEGER DEFAULT 0,
 failed INTEGER DEFAULT 0,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 completed_at TEXT
);
CREATE TABLE IF NOT EXISTS message_deliveries(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 campaign_id INTEGER NOT NULL,
 user_id INTEGER NOT NULL,
 email TEXT NOT NULL,
 email_status TEXT DEFAULT 'pending',
 inapp_status TEXT DEFAULT 'pending',
 error TEXT,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(campaign_id,user_id)
);`);
const messageCampaignColumns=db.prepare('PRAGMA table_info(message_campaigns)').all().map(c=>c.name);
if(!messageCampaignColumns.includes('message_type'))db.exec("ALTER TABLE message_campaigns ADD COLUMN message_type TEXT DEFAULT 'notification'");
if(!messageCampaignColumns.includes('action_href'))db.exec("ALTER TABLE message_campaigns ADD COLUMN action_href TEXT");
if(!messageCampaignColumns.includes('action_label'))db.exec("ALTER TABLE message_campaigns ADD COLUMN action_label TEXT");


function emailHtmlEscape(value){
 return String(value??'').replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
}
function absoluteOptiUrl(href=null){
 const base=productionBaseUrl();
 if(!base)return null;
 if(!href)return base;
 try{
  return new URL(String(href).startsWith('/')?String(href):'/'+String(href), base+'/').toString();
 }catch{return base}
}
function optiEmailTheme(kind='notification'){
 const key=String(kind||'notification').toLowerCase();
 const themes={
  notification:{label:'Account notification',accent:'#22c7ff',accent2:'#176cff',soft:'#0b2943',border:'#235b86',icon:'↗'},
  warning:{label:'Important warning',accent:'#ffbf5a',accent2:'#ff7a18',soft:'#3a260c',border:'#80541c',icon:'!'},
  security:{label:'Security alert',accent:'#bd8cff',accent2:'#7547ff',soft:'#241a43',border:'#57418b',icon:'◆'},
  deposit:{label:'Deposit update',accent:'#4de0a0',accent2:'#1aa96d',soft:'#103a2d',border:'#276e56',icon:'↓'},
  withdrawal:{label:'Withdrawal update',accent:'#59dbff',accent2:'#1984d8',soft:'#10314a',border:'#2b668f',icon:'↑'},
  trade:{label:'Trading update',accent:'#55b6ff',accent2:'#2767ff',soft:'#102846',border:'#315d91',icon:'↗'},
  investment:{label:'Investment update',accent:'#9d8cff',accent2:'#5c48df',soft:'#221d43',border:'#52488a',icon:'◈'},
  system:{label:'System update',accent:'#9fb3c9',accent2:'#65788e',soft:'#1b2734',border:'#415267',icon:'•'},
  announcement:{label:'OptiTrade announcement',accent:'#4fd8ff',accent2:'#2676ff',soft:'#0d2b46',border:'#2b668f',icon:'✦'}
 };
 return themes[key]||themes.notification;
}
function optiEmailFrame({kind='notification',eyebrow=null,title='',intro='',bodyHtml='',buttonText='Open OptiTrade',buttonHref=null,footerText='This is an automated OptiTrade message.'}={}){
 const esc=emailHtmlEscape;
 const theme=optiEmailTheme(kind);
 const safeHref=buttonHref?esc(buttonHref):null;
 const support=configuredSupportEmail();
 const badge=eyebrow||theme.label;
 return `<!doctype html>
<html>
<head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"></head>
<body style="margin:0;padding:0;background:#050b14;font-family:Arial,Helvetica,sans-serif;color:#eef7ff;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#050b14;margin:0;padding:0;">
    <tr><td align="center" style="padding:26px 12px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;border-collapse:separate;">
        <tr><td style="background:linear-gradient(135deg,#07192b 0%,#0d3158 58%,#0a6aa3 100%);border:1px solid #24557f;border-radius:24px 24px 0 0;padding:24px;">
          <div style="font-size:11px;line-height:1.4;letter-spacing:1.8px;text-transform:uppercase;color:#8fe8ff;font-weight:800;">OFFICIAL OPTITRADE™ COMMUNICATION</div>
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:12px;">
            <tr>
              <td valign="middle"><div style="width:50px;height:50px;line-height:50px;text-align:center;border-radius:15px;background:linear-gradient(135deg,#1bd4ff,#176cff);color:#fff;font-size:26px;font-weight:900;box-shadow:0 8px 24px rgba(23,108,255,.28);">↗</div></td>
              <td valign="middle" style="padding-left:12px;">
                <div style="font-size:28px;font-weight:900;letter-spacing:-.6px;color:#fff;">Opti<span style="color:#7be6ff;">Trade</span><span style="font-size:11px;vertical-align:top;color:#8fe8ff;margin-left:2px;">™</span></div>
                <div style="font-size:12px;color:#b8d0e4;margin-top:3px;">Secure account communication</div>
              </td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="background:#0b1726;border-left:1px solid #1c3c5c;border-right:1px solid #1c3c5c;padding:28px 24px 18px;">
          <div style="display:inline-block;padding:6px 10px;border-radius:999px;background:${theme.soft};border:1px solid ${theme.border};color:${theme.accent};font-size:11px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;">${esc(badge)}</div>
          <h1 style="margin:14px 0 10px;font-size:26px;line-height:1.25;color:#ffffff;">${esc(title)}</h1>
          ${intro?`<p style="margin:0 0 18px;color:#b8c8d9;font-size:15px;line-height:1.75;">${esc(intro)}</p>`:''}
          <div style="background:#07111e;border:1px solid #1d3853;border-left:4px solid ${theme.accent};border-radius:18px;padding:20px 18px 8px;box-shadow:inset 0 1px 0 rgba(255,255,255,.02);">
            ${bodyHtml}
          </div>
          ${safeHref?`<div style="margin:22px 0 4px;"><a href="${safeHref}" style="display:inline-block;background:linear-gradient(135deg,${theme.accent},${theme.accent2});color:#ffffff;text-decoration:none;font-weight:900;padding:14px 20px;border-radius:12px;box-shadow:0 10px 24px rgba(23,108,255,.20);">${esc(buttonText)} →</a></div>`:''}
        </td></tr>
        <tr><td style="background:#08121f;border:1px solid #1c3c5c;border-top:0;border-radius:0 0 24px 24px;padding:18px 24px 22px;">
          <div style="color:#8399ad;font-size:12px;line-height:1.7;">${esc(footerText)}${support?` Need help? Contact <span style="color:#9fe9ff;">${esc(support)}</span>.`:''}</div>
          <div style="margin-top:16px;padding-top:14px;border-top:1px solid #18314a;color:#60768b;font-size:11px;line-height:1.65;">
            OptiTrade™ Support Team<br>
            <span style="color:#7f94a8;">Never share your password, PIN or verification code by email.</span>
          </div>
        </td></tr>
      </table>
      <div style="max-width:640px;margin:14px auto 0;text-align:center;color:#536a80;font-size:10px;line-height:1.6;">© ${new Date().getFullYear()} OptiTrade™. Official account communication.</div>
    </td></tr>
  </table>
</body>
</html>`;
}
function plainTextToEmailHtml(text){
 const esc=emailHtmlEscape;
 return String(text||'').trim().split(/\n\s*\n/).filter(Boolean).map(p=>
   `<p style="margin:0 0 14px;color:#e7eef7;font-size:15px;line-height:1.72;">${esc(p).replace(/\n/g,'<br>')}</p>`
 ).join('')||`<p style="margin:0;color:#e7eef7;font-size:15px;line-height:1.72;">No message content.</p>`;
}
function sendGeneralEmail(email,subject,body,{href=null,eyebrow=null,kind='notification',intro=null,buttonText=null,category='transactional',userId=null,reference=null}={}){
 const theme=optiEmailTheme(kind);
 const html=optiEmailFrame({
  kind,
  eyebrow:eyebrow||theme.label,
  title:subject,
  intro:intro||'You have a new OptiTrade account update.',
  bodyHtml:plainTextToEmailHtml(body),
  buttonText:buttonText||(href?'View in OptiTrade':'Open OptiTrade'),
  buttonHref:absoluteOptiUrl(href),
  footerText:kind==='warning'||kind==='security'
   ?'Please review this message carefully and sign in directly to OptiTrade if action is required.'
   :'Sign in to OptiTrade to review the latest activity on your account.'
 });
 return sendOutboundEmail(email,subject,body,{html,category,userId,reference});
}

function notifyAndEmail(uid,type,title,body,href=null,{email=true}={}){
 notifyUser(uid,type,title,body,href);
 if(!email)return;
 const u=db.prepare("SELECT email,name,role FROM users WHERE id=?").get(uid);
 if(!u?.email || u.role!=='user')return;
 const first=String(u.name||'Trader').trim().split(/\s+/)[0]||'Trader';
 const kindMap={
  deposit:'deposit',withdrawal:'withdrawal',trade:'trade',investment_plan:'investment',
  investment:'investment',security:'security',warning:'warning',system:'system',
  announcement:'announcement'
 };
 const kind=kindMap[String(type||'').toLowerCase()]||'notification';
 const text=`Hello ${first},

${body}

You can sign in to OptiTrade to review the latest account activity.

If you did not expect this message, please contact OptiTrade Support${configuredSupportEmail()?` at ${configuredSupportEmail()}`:''}.

— OptiTrade Support`;
 setImmediate(()=>sendGeneralEmail(u.email,title,text,{
  href,kind,userId:uid,reference:`notification:${type||'general'}:${uid}`
 }).catch(e=>console.error('[TRANSACTIONAL EMAIL]',e.message)));
}
async function processCampaign(campaignId){
 const c=db.prepare('SELECT * FROM message_campaigns WHERE id=?').get(campaignId);
 if(!c||!['queued','sending'].includes(c.status))return;
 db.prepare("UPDATE message_campaigns SET status='sending' WHERE id=?").run(campaignId);
 const rows=db.prepare("SELECT d.*,u.name FROM message_deliveries d JOIN users u ON u.id=d.user_id WHERE d.campaign_id=? AND (d.email_status='pending' OR d.inapp_status='pending') ORDER BY d.id").all(campaignId);
 const kind=String(c.message_type||'notification');
 const href=String(c.action_href||'').trim()||'/dashboard.html';
 const buttonText=String(c.action_label||'').trim()||'Open OptiTrade';
 for(const d of rows){
   let emailStatus=d.email_status,inappStatus=d.inapp_status,err='';
   if(c.send_inapp && inappStatus==='pending'){
     try{notifyUser(d.user_id,kind==='warning'?'warning':'admin_message',c.subject,c.body,href);inappStatus='delivered'}catch(e){inappStatus='failed';err+='In-app: '+e.message+' '}
   } else if(!c.send_inapp && inappStatus==='pending') inappStatus='skipped';
   if(c.send_email && emailStatus==='pending'){
     try{
       const first=String(d.name||'Trader').trim().split(/\s+/)[0]||'Trader';
       const personalized=`Hello ${first},\n\n${c.body}`;
       const r=await sendGeneralEmail(d.email,c.subject,personalized,{
         kind,href,buttonText,category:`campaign_${kind}`,userId:d.user_id,reference:`campaign:${campaignId}`
       });
       emailStatus=r.dev?'dev_logged':'delivered';
     }catch(e){emailStatus='failed';err+='Email: '+e.message}
   } else if(!c.send_email && emailStatus==='pending') emailStatus='skipped';
   db.prepare("UPDATE message_deliveries SET email_status=?,inapp_status=?,error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(emailStatus,inappStatus,err.trim()||null,d.id);
 }
 const summary=db.prepare(`SELECT COUNT(*) total,
 SUM(CASE WHEN email_status IN ('delivered','dev_logged','skipped') AND inapp_status IN ('delivered','skipped') THEN 1 ELSE 0 END) delivered,
 SUM(CASE WHEN email_status='failed' OR inapp_status='failed' THEN 1 ELSE 0 END) failed
 FROM message_deliveries WHERE campaign_id=?`).get(campaignId);
 db.prepare("UPDATE message_campaigns SET status='completed',total=?,delivered=?,failed=?,completed_at=CURRENT_TIMESTAMP WHERE id=?").run(summary.total||0,summary.delivered||0,summary.failed||0,campaignId);
}


// Multi-admin ownership, expirable invitations, and sectioned account balances.
db.exec(`CREATE TABLE IF NOT EXISTS admin_invites(
 id INTEGER PRIMARY KEY AUTOINCREMENT,code_hash TEXT UNIQUE NOT NULL,label TEXT,
 expires_at INTEGER NOT NULL,max_uses INTEGER DEFAULT 1,uses INTEGER DEFAULT 0,
 created_by INTEGER,revoked INTEGER DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS section_balances(
 user_id INTEGER NOT NULL,section TEXT NOT NULL,asset TEXT NOT NULL,amount REAL DEFAULT 0,
 PRIMARY KEY(user_id,section,asset)
);`);
const uc2=db.prepare('PRAGMA table_info(users)').all().map(c=>c.name);
if(!uc2.includes('owner_admin_id')) db.exec('ALTER TABLE users ADD COLUMN owner_admin_id INTEGER');
if(!uc2.includes('referral_code')) db.exec('ALTER TABLE users ADD COLUMN referral_code TEXT');
if(!uc2.includes('admin_active')) db.exec('ALTER TABLE users ADD COLUMN admin_active INTEGER DEFAULT 1');
if(!uc2.includes('admin_permissions')) db.exec("ALTER TABLE users ADD COLUMN admin_permissions TEXT DEFAULT '[\"customers\",\"support\",\"balances\"]'");
try{db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code) WHERE referral_code IS NOT NULL')}catch(e){}

function isSuper(u){return u && u.role==='super_admin'}
function isStaff(u){return u && ['super_admin','sub_admin','admin'].includes(u.role)}
function ownsUser(actor,userId){
 if(isSuper(actor)||actor.role==='admin') return !!db.prepare("SELECT id FROM users WHERE id=? AND role='user'").get(userId);
 return !!db.prepare("SELECT id FROM users WHERE id=? AND role='user' AND owner_admin_id=?").get(userId,actor.id);
}
function scopedUserWhere(actor,alias='u'){
 return (isSuper(actor)||actor.role==='admin') ? `${alias}.role='user'` : `${alias}.role='user' AND ${alias}.owner_admin_id=${Number(actor.id)}`;
}
function seedSectionBalances(userId){
 const legacy=Object.fromEntries(db.prepare('SELECT asset,amount FROM balances WHERE user_id=?').all(userId).map(x=>[x.asset,Number(x.amount||0)]));
 for(const asset of ['USD','USDT','BTC','ETH'])
   db.prepare('INSERT OR IGNORE INTO section_balances(user_id,section,asset,amount) VALUES(?,?,?,?)').run(userId,'wallet',asset,Number(legacy[asset]||0));
 for(const section of ['portfolio','trading','investment'])
   for(const asset of ['USD','USDT','BTC','ETH'])
     db.prepare('INSERT OR IGNORE INTO section_balances(user_id,section,asset,amount) VALUES(?,?,?,0)').run(userId,section,asset);
}
for(const u of db.prepare("SELECT id FROM users WHERE role='user'").all()) seedSectionBalances(u.id);
function makeReferral(name){
 const base=String(name||'ADMIN').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8)||'ADMIN';
 let code; do{code=base+'-'+crypto.randomBytes(3).toString('hex').toUpperCase()}while(db.prepare('SELECT id FROM users WHERE referral_code=?').get(code));
 return code;
}

// Admin-configurable public receiving addresses and manually reviewed deposits.
db.exec(`CREATE TABLE IF NOT EXISTS deposit_wallets(
 id INTEGER PRIMARY KEY AUTOINCREMENT,admin_id INTEGER NOT NULL,asset TEXT NOT NULL,network TEXT NOT NULL,address TEXT NOT NULL,
 active INTEGER DEFAULT 1,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(admin_id,asset,network)
);
CREATE TABLE IF NOT EXISTS deposit_requests(
 id INTEGER PRIMARY KEY AUTOINCREMENT,reference TEXT UNIQUE NOT NULL,user_id INTEGER NOT NULL,owner_admin_id INTEGER,
 wallet_admin_id INTEGER,asset TEXT NOT NULL,network TEXT NOT NULL,wallet_address TEXT NOT NULL,amount REAL NOT NULL,
 txid TEXT,status TEXT DEFAULT 'pending',user_note TEXT,review_reason TEXT,reviewed_by INTEGER,reviewed_at TEXT,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);`);
// V2 deposit-wallet storage supports multiple addresses for the same asset + network.
db.exec(`CREATE TABLE IF NOT EXISTS deposit_wallet_addresses(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 admin_id INTEGER NOT NULL,
 label TEXT,
 asset TEXT NOT NULL,
 network TEXT NOT NULL,
 address TEXT NOT NULL,
 active INTEGER DEFAULT 1,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);`);
try{
  db.prepare(`INSERT INTO deposit_wallet_addresses(admin_id,label,asset,network,address,active,updated_at)
    SELECT d.admin_id,'Imported wallet',d.asset,d.network,d.address,d.active,d.updated_at
    FROM deposit_wallets d
    WHERE d.asset IN ('BTC','USDT','ETH')
      AND NOT EXISTS(
        SELECT 1 FROM deposit_wallet_addresses v
        WHERE v.admin_id=d.admin_id AND v.asset=d.asset AND v.network=d.network AND v.address=d.address
      )`).run();
}catch(e){console.warn('[DEPOSIT WALLET MIGRATION]',e.message)}
try{db.prepare("UPDATE deposit_wallet_addresses SET network='BITCOIN' WHERE asset='BTC' AND upper(network)='BTC'").run()}catch(e){console.warn('[DEPOSIT WALLET NETWORK]',e.message)}

const depositRequestColumns=db.prepare('PRAGMA table_info(deposit_requests)').all().map(c=>c.name);
if(!depositRequestColumns.includes('usd_value')) db.exec('ALTER TABLE deposit_requests ADD COLUMN usd_value REAL');
if(!depositRequestColumns.includes('usd_rate')) db.exec('ALTER TABLE deposit_requests ADD COLUMN usd_rate REAL');
if(!depositRequestColumns.includes('source')) db.exec("ALTER TABLE deposit_requests ADD COLUMN source TEXT DEFAULT 'customer'");
if(!depositRequestColumns.includes('chain_verification_status')) db.exec("ALTER TABLE deposit_requests ADD COLUMN chain_verification_status TEXT DEFAULT 'not_checked'");
if(!depositRequestColumns.includes('chain_verified_amount')) db.exec("ALTER TABLE deposit_requests ADD COLUMN chain_verified_amount REAL");
if(!depositRequestColumns.includes('chain_id')) db.exec("ALTER TABLE deposit_requests ADD COLUMN chain_id TEXT");
if(!depositRequestColumns.includes('chain_verification_note')) db.exec("ALTER TABLE deposit_requests ADD COLUMN chain_verification_note TEXT");
if(!depositRequestColumns.includes('chain_verified_at')) db.exec("ALTER TABLE deposit_requests ADD COLUMN chain_verified_at TEXT");
if(!depositRequestColumns.includes('payment_marked_sent_at')) db.exec("ALTER TABLE deposit_requests ADD COLUMN payment_marked_sent_at TEXT");
if(!depositRequestColumns.includes('receipt_issued_at')) db.exec("ALTER TABLE deposit_requests ADD COLUMN receipt_issued_at TEXT");
if(!depositRequestColumns.includes('credited_usd')) db.exec("ALTER TABLE deposit_requests ADD COLUMN credited_usd REAL");
if(!depositRequestColumns.includes('credited_rate')) db.exec("ALTER TABLE deposit_requests ADD COLUMN credited_rate REAL");
if(!depositRequestColumns.includes('credit_note')) db.exec("ALTER TABLE deposit_requests ADD COLUMN credit_note TEXT");
if(!depositRequestColumns.includes('requested_usd')) db.exec("ALTER TABLE deposit_requests ADD COLUMN requested_usd REAL");
if(!depositRequestColumns.includes('amount_input_mode')) db.exec("ALTER TABLE deposit_requests ADD COLUMN amount_input_mode TEXT DEFAULT 'crypto_legacy'");
if(!depositRequestColumns.includes('credit_corrected_at')) db.exec("ALTER TABLE deposit_requests ADD COLUMN credit_corrected_at TEXT");
if(!depositRequestColumns.includes('credit_corrected_by')) db.exec("ALTER TABLE deposit_requests ADD COLUMN credit_corrected_by INTEGER");
if(!depositRequestColumns.includes('credit_correction_reason')) db.exec("ALTER TABLE deposit_requests ADD COLUMN credit_correction_reason TEXT");
if(!depositRequestColumns.includes('client_request_id')) db.exec("ALTER TABLE deposit_requests ADD COLUMN client_request_id TEXT");
try{db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_deposit_client_request ON deposit_requests(user_id,client_request_id) WHERE client_request_id IS NOT NULL")}catch(e){console.warn('[DEPOSIT IDEMPOTENCY INDEX]',e.message)}

db.exec(`CREATE TABLE IF NOT EXISTS deposit_credit_corrections(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 deposit_id INTEGER NOT NULL,
 user_id INTEGER NOT NULL,
 previous_usd REAL NOT NULL,
 corrected_usd REAL NOT NULL,
 delta_usd REAL NOT NULL,
 reason TEXT NOT NULL,
 corrected_by INTEGER NOT NULL,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS balance_adjustment_reversals(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 original_reference TEXT NOT NULL UNIQUE,
 reversal_reference TEXT NOT NULL UNIQUE,
 user_id INTEGER NOT NULL,
 section TEXT NOT NULL,
 asset TEXT NOT NULL,
 amount REAL NOT NULL,
 original_direction TEXT NOT NULL,
 reversed_by INTEGER NOT NULL,
 reason TEXT NOT NULL,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);`);

function depositRef(){return 'OT-DEP-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(3).toString('hex').toUpperCase()}

const EVM_DEPOSIT_NETWORKS={
 ETHEREUM:{chainId:1,rpcEnv:'RPC_ETHEREUM'},
 ERC20:{chainId:1,rpcEnv:'RPC_ETHEREUM'},
 OPTIMISM:{chainId:10,rpcEnv:'RPC_OPTIMISM'},
 BEP20:{chainId:56,rpcEnv:'RPC_BSC'},
 BSC:{chainId:56,rpcEnv:'RPC_BSC'},
 POLYGON:{chainId:137,rpcEnv:'RPC_POLYGON'},
 BASE:{chainId:8453,rpcEnv:'RPC_BASE'},
 ARBITRUM:{chainId:42161,rpcEnv:'RPC_ARBITRUM'}
};
const USDT_EVM_CONTRACTS={
 1:{address:'0xdac17f958d2ee523a2206206994597c13d831ec7',decimals:6},
 10:{address:'0x94b008aa00579c1307b0ef2c499ad98a8ce58e58',decimals:6},
 56:{address:'0x55d398326f99059ff775485246999027b3197955',decimals:18},
 137:{address:'0xc2132d05d31c914a87c6611c10748aacbffefeD'.toLowerCase(),decimals:6},
 42161:{address:'0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',decimals:6}
};
const TRANSFER_TOPIC='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function evmDepositConfig(asset,network){
 const n=EVM_DEPOSIT_NETWORKS[String(network||'').toUpperCase()];
 if(!n)return {supported:false,status:'unsupported',note:'Automatic on-chain verification is not available for this network.'};
 if(asset==='ETH')return {...n,supported:true,kind:'native',decimals:18};
 if(asset==='USDT'){
   const token=USDT_EVM_CONTRACTS[n.chainId];
   if(!token)return {...n,supported:false,status:'unsupported',note:'Automatic USDT verification is not configured for this EVM network.'};
   return {...n,supported:true,kind:'erc20',token};
 }
 return {...n,supported:false,status:'unsupported',note:'Automatic verification is currently limited to ETH and USDT on configured EVM networks.'};
}
async function jsonRpc(url,method,params){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
 try{
   const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:controller.signal});
   if(!r.ok)throw new Error(`RPC HTTP ${r.status}`);
   const d=await r.json();
   if(d.error)throw new Error(d.error.message||'RPC request failed');
   return d.result;
 }finally{clearTimeout(timer)}
}
function bigintToNumberUnits(v,decimals){
 const n=BigInt(v||0),base=10n**BigInt(decimals),whole=n/base,frac=(n%base).toString().padStart(decimals,'0').slice(0,Math.min(decimals,10)).replace(/0+$/,'');
 return Number(frac?`${whole}.${frac}`:String(whole));
}
function topicAddress(topic){return topic&&topic.length>=42?'0x'+topic.slice(-40).toLowerCase():''}
async function verifyDepositOnChain({asset,network,walletAddress,amount,txid}){
 asset=String(asset||'').toUpperCase(); network=String(network||'').toUpperCase(); txid=String(txid||'').trim();
 const cfg=evmDepositConfig(asset,network);
 if(!cfg.supported)return {status:cfg.status||'unsupported',chainId:cfg.chainId||null,note:cfg.note,verifiedAmount:null};
 if(!/^0x[a-fA-F0-9]{64}$/.test(txid))return {status:'not_checked',chainId:cfg.chainId,note:'A valid 0x transaction hash is required for EVM verification.',verifiedAmount:null};
 const rpc=String(process.env[cfg.rpcEnv]||'').trim();
 if(!rpc)return {status:'unavailable',chainId:cfg.chainId,note:`${cfg.rpcEnv} is not configured on the server. Manual review is still available.`,verifiedAmount:null};
 try{
   const [tx,receipt]=await Promise.all([
     jsonRpc(rpc,'eth_getTransactionByHash',[txid]),
     jsonRpc(rpc,'eth_getTransactionReceipt',[txid])
   ]);
   if(!tx)return {status:'pending',chainId:cfg.chainId,note:'Transaction was not found yet on the configured RPC.',verifiedAmount:null};
   if(!receipt)return {status:'pending',chainId:cfg.chainId,note:'Transaction is known but does not have a receipt yet.',verifiedAmount:null};
   if(String(receipt.status).toLowerCase()!=='0x1')return {status:'reverted',chainId:cfg.chainId,note:'The blockchain transaction reverted and cannot be treated as a successful deposit.',verifiedAmount:null};
   const expected=String(walletAddress||'').toLowerCase();
   let verifiedAmount=0;
   if(cfg.kind==='native'){
     if(String(tx.to||'').toLowerCase()!==expected)return {status:'mismatch',chainId:cfg.chainId,note:'Transaction recipient does not match the configured receiving address.',verifiedAmount:null};
     verifiedAmount=bigintToNumberUnits(tx.value||'0x0',18);
   }else{
     const contract=cfg.token.address.toLowerCase();
     const logs=Array.isArray(receipt.logs)?receipt.logs:[];
     const hit=logs.find(l=>String(l.address||'').toLowerCase()===contract &&
       String(l.topics?.[0]||'').toLowerCase()===TRANSFER_TOPIC &&
       topicAddress(l.topics?.[2])===expected);
     if(!hit)return {status:'mismatch',chainId:cfg.chainId,note:'No matching USDT transfer to the configured receiving address was found in this transaction.',verifiedAmount:null};
     verifiedAmount=bigintToNumberUnits(hit.data||'0x0',cfg.token.decimals);
   }
   const claimed=Number(amount);
   const tolerance=Math.max(1e-10,Math.abs(claimed)*1e-8);
   if(!(verifiedAmount+tolerance>=claimed))return {status:'mismatch',chainId:cfg.chainId,note:`Verified on-chain amount (${verifiedAmount}) is lower than the submitted amount (${claimed}).`,verifiedAmount};
   return {status:'verified',chainId:cfg.chainId,note:`Verified on-chain receipt to the configured receiving address. Amount detected: ${verifiedAmount} ${asset}.`,verifiedAmount};
 }catch(e){
   return {status:'unavailable',chainId:cfg.chainId,note:`On-chain verification could not complete: ${String(e.message||e).slice(0,220)}`,verifiedAmount:null};
 }
}
function saveDepositVerification(id,v){
 db.prepare(`UPDATE deposit_requests SET chain_verification_status=?,chain_verified_amount=?,chain_id=?,chain_verification_note=?,chain_verified_at=CASE WHEN ?='verified' THEN CURRENT_TIMESTAMP ELSE chain_verified_at END WHERE id=?`)
   .run(v.status||'not_checked',v.verifiedAmount??null,v.chainId!=null?String(v.chainId):null,String(v.note||'').slice(0,500),v.status||'not_checked',id);
}

function walletOwnerForUser(user){
 if(user.owner_admin_id){const a=db.prepare("SELECT id FROM users WHERE id=? AND role='sub_admin' AND admin_active=1").get(user.owner_admin_id);if(a)return a.id}
 const sa=db.prepare("SELECT id FROM users WHERE role='super_admin' ORDER BY id LIMIT 1").get();return sa?.id||null;
}

function superAdminId(){return db.prepare("SELECT id FROM users WHERE role='super_admin' ORDER BY id LIMIT 1").get()?.id||null}
function customerAdminId(user){
 if(user?.owner_admin_id){
   const a=db.prepare("SELECT id FROM users WHERE id=? AND role='sub_admin' AND admin_active=1").get(user.owner_admin_id);
   if(a)return a.id;
 }
 return null;
}

// Non-destructive profile migrations for existing OptiTrade databases.
const userColumns=db.prepare('PRAGMA table_info(users)').all().map(c=>c.name);
const profileColumns={
 username:'TEXT',phone:'TEXT',country:'TEXT',currency:"TEXT DEFAULT 'USD'",dob:'TEXT',terms_accepted_at:'TEXT',
 pin_hash:'TEXT',pin_fail_count:'INTEGER DEFAULT 0',pin_locked_until:'INTEGER DEFAULT 0'
};
for(const [column,type] of Object.entries(profileColumns)) if(!userColumns.includes(column)) db.exec(`ALTER TABLE users ADD COLUMN ${column} ${type}`);
try{db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL');}catch(e){console.warn('[USERNAME INDEX]',e.message)}
const adminEmail=String(process.env.ADMIN_EMAIL||'').trim().toLowerCase();
const adminPassword=String(process.env.ADMIN_PASSWORD||'');
if(adminEmail && adminPassword){
  const existingAdmin=db.prepare('SELECT * FROM users WHERE lower(email)=?').get(adminEmail);
  const passwordHash=bcrypt.hashSync(adminPassword,12);
  if(existingAdmin){
    db.prepare("UPDATE users SET email=?,password_hash=?,role='super_admin',email_verified=1 WHERE id=?")
      .run(adminEmail,passwordHash,existingAdmin.id);
    console.log(`[ADMIN] Synchronized admin account: ${adminEmail}`);
  }else{
    const info=db.prepare("INSERT INTO users(name,email,password_hash,email_verified,role) VALUES(?,?,?,?,?)")
      .run('OptiTrade Admin',adminEmail,passwordHash,1,'super_admin');
    for(const asset of ['USD','BTC','ETH','USDT'])
      db.prepare('INSERT OR IGNORE INTO balances(user_id,asset,amount) VALUES(?,?,0)').run(info.lastInsertRowid,asset);
    console.log(`[ADMIN] Created admin account: ${adminEmail}`);
  }
}else{
  console.warn('[ADMIN] ADMIN_EMAIL or ADMIN_PASSWORD is missing in .env.');
}

// Customer product uses public wallet connections only.
db.exec(`CREATE TABLE IF NOT EXISTS wallet_public_connections(
 user_id INTEGER PRIMARY KEY,
 address TEXT NOT NULL,
 namespace TEXT,
 chain_id TEXT,
 provider_type TEXT,
 wallet_name TEXT,
 last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS wallet_public_connections_v2(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL,
 namespace TEXT NOT NULL,
 address TEXT NOT NULL,
 chain_id TEXT,
 provider_type TEXT,
 wallet_name TEXT,
 last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(user_id,namespace,address)
);`);
try{
 db.prepare(`INSERT OR IGNORE INTO wallet_public_connections_v2(user_id,namespace,address,chain_id,provider_type,wallet_name,last_seen_at,updated_at)
   SELECT user_id,COALESCE(NULLIF(namespace,''),'eip155'),address,chain_id,provider_type,wallet_name,last_seen_at,updated_at
   FROM wallet_public_connections WHERE address IS NOT NULL AND trim(address)<>''`).run();
}catch(e){console.warn('[WALLET CONNECTION MIGRATION]',e.message)}


db.exec(`CREATE TABLE IF NOT EXISTS referral_click_alerts(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 admin_id INTEGER NOT NULL,
 referral_code TEXT NOT NULL,
 ip_hash TEXT NOT NULL,
 alerted_at INTEGER NOT NULL,
 UNIQUE(admin_id,referral_code,ip_hash)
);`);

function referralClientIp(req){
 let ip=String(req.ip||req.socket?.remoteAddress||'').trim();
 if(ip.startsWith('::ffff:'))ip=ip.slice(7);
 return ip.slice(0,80)||'unknown';
}
function referralPreviewBot(req){
 const ua=String(req.get('user-agent')||'');
 return /(bot|crawler|spider|preview|facebookexternalhit|slackbot|discordbot|telegrambot|whatsapp|skypeuripreview|linkedinbot)/i.test(ua);
}
function privateOrLocalIp(ip){
 if(!ip||ip==='unknown'||ip==='::1'||ip==='127.0.0.1')return true;
 if(/^10\./.test(ip)||/^192\.168\./.test(ip)||/^169\.254\./.test(ip))return true;
 const m=ip.match(/^172\.(\d+)\./);if(m&&Number(m[1])>=16&&Number(m[1])<=31)return true;
 return /^fc|^fd|^fe80/i.test(ip);
}
async function referralApproxLocation(ip){
 if(String(process.env.IP_GEOLOCATION_ENABLED||'true').toLowerCase()==='false')return 'IP geolocation disabled';
 if(privateOrLocalIp(ip))return 'Local/private network';
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),2500);
 try{
   const r=await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`,{signal:controller.signal,headers:{accept:'application/json'}});
   if(!r.ok)return 'Unavailable';
   const d=await r.json();
   if(d.success===false)return 'Unavailable';
   const parts=[d.city,d.region,d.country].map(v=>String(v||'').trim()).filter(Boolean);
   return parts.length?parts.join(', '):'Unavailable';
 }catch{return 'Unavailable'}finally{clearTimeout(timer)}
}
function shouldAlertReferralClick(adminId,code,ip){
 const ipHash=hash(`${adminId}|${code}|${ip}`),now=Date.now();
 const row=db.prepare('SELECT alerted_at FROM referral_click_alerts WHERE admin_id=? AND referral_code=? AND ip_hash=?').get(adminId,code,ipHash);
 if(row&&now-Number(row.alerted_at||0)<10*60*1000)return false;
 db.prepare(`INSERT INTO referral_click_alerts(admin_id,referral_code,ip_hash,alerted_at) VALUES(?,?,?,?)
   ON CONFLICT(admin_id,referral_code,ip_hash) DO UPDATE SET alerted_at=excluded.alerted_at`).run(adminId,code,ipHash,now);
 return true;
}
async function alertReferralVisit(req,owner,code){
 if(referralPreviewBot(req))return;
 const ip=referralClientIp(req);
 if(!shouldAlertReferralClick(owner.id,code,ip))return;
 const location=await referralApproxLocation(ip);
 const title='Registration link opened';
 const body=`Referral: ${code}\nIP: ${ip}\nApprox. IP location: ${location}`;
 notifyUser(owner.id,'referral_click',title,body,'/admin/dashboard.html');
 try{
   const sent=await sendTelegramAdminAlert(owner.id,'referral_click',title,body);
   if(sent?.skipped){
     const fallback=superAdminId();
     if(fallback&&Number(fallback)!==Number(owner.id))await sendTelegramAdminAlert(fallback,'referral_click',title,`${body}\nAssigned admin: ${owner.name||owner.username||owner.email}`);
   }
 }catch(e){console.error('[REFERRAL CLICK ALERT]',e.message)}
}


// -----------------------------------------------------------------------------
// Stage 17 — Global KYC / AML provider framework + exchange connector framework.
// KYC is provider-assisted so OptiProTrade does not store identity-document images.
// Exchange credentials remain server-side environment secrets.
// -----------------------------------------------------------------------------
db.exec(`CREATE TABLE IF NOT EXISTS kyc_settings(
 id INTEGER PRIMARY KEY CHECK(id=1),
 provider TEXT NOT NULL DEFAULT 'sumsub',
 enabled INTEGER NOT NULL DEFAULT 1,
 level_name TEXT NOT NULL DEFAULT 'basic-kyc-level',
 require_self_trade INTEGER NOT NULL DEFAULT 0,
 require_managed_trade INTEGER NOT NULL DEFAULT 0,
 require_investment INTEGER NOT NULL DEFAULT 0,
 require_internal_transfer INTEGER NOT NULL DEFAULT 0,
 require_withdrawal INTEGER NOT NULL DEFAULT 0,
 country_rules_enabled INTEGER NOT NULL DEFAULT 0,
 updated_by INTEGER,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS kyc_profiles(
 user_id INTEGER PRIMARY KEY,
 provider TEXT NOT NULL DEFAULT 'sumsub',
 external_user_id TEXT UNIQUE,
 applicant_id TEXT,
 level_name TEXT,
 status TEXT NOT NULL DEFAULT 'not_started',
 provider_review_status TEXT,
 provider_review_answer TEXT,
 country_snapshot TEXT,
 last_error TEXT,
 started_at TEXT,
 submitted_at TEXT,
 reviewed_at TEXT,
 last_synced_at TEXT,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS compliance_country_rules(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 country_key TEXT NOT NULL UNIQUE,
 country_label TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'allowed',
 reason TEXT,
 updated_by INTEGER,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS compliance_customer_status(
 user_id INTEGER PRIMARY KEY,
 status TEXT NOT NULL DEFAULT 'clear',
 reason TEXT,
 updated_by INTEGER,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS exchange_settings(
 id INTEGER PRIMARY KEY CHECK(id=1),
 provider TEXT NOT NULL DEFAULT 'kraken',
 enabled INTEGER NOT NULL DEFAULT 0,
 default_quote TEXT NOT NULL DEFAULT 'USD',
 execution_mode TEXT NOT NULL DEFAULT 'disabled',
 emergency_stop INTEGER NOT NULL DEFAULT 1,
 route_self_trade INTEGER NOT NULL DEFAULT 0,
 route_managed_trade INTEGER NOT NULL DEFAULT 0,
 max_order_usd REAL NOT NULL DEFAULT 25000,
 updated_by INTEGER,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS exchange_orders(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 provider TEXT NOT NULL,
 request_kind TEXT NOT NULL,
 request_id INTEGER NOT NULL,
 user_id INTEGER NOT NULL,
 local_reference TEXT NOT NULL,
 leg TEXT NOT NULL DEFAULT 'open',
 userref INTEGER,
 external_order_id TEXT,
 symbol TEXT NOT NULL,
 provider_pair TEXT NOT NULL,
 side TEXT NOT NULL,
 order_type TEXT NOT NULL DEFAULT 'market',
 requested_usd REAL,
 requested_volume REAL,
 validation_only INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'created',
 filled_volume REAL,
 avg_price REAL,
 cost REAL,
 fee REAL,
 description TEXT,
 last_error TEXT,
 submitted_at TEXT,
 last_synced_at TEXT,
 closed_at TEXT,
 created_by INTEGER,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_exchange_orders_request ON exchange_orders(request_kind,request_id,id DESC);
CREATE INDEX IF NOT EXISTS idx_exchange_orders_external ON exchange_orders(external_order_id);
CREATE INDEX IF NOT EXISTS idx_exchange_orders_userref ON exchange_orders(userref);
`);
db.prepare(`INSERT OR IGNORE INTO kyc_settings(id,provider,enabled,level_name,require_self_trade,require_managed_trade,require_investment)
 VALUES(1,'sumsub',1,?,0,0,0)`).run(String(process.env.SUMSUB_LEVEL_NAME||'basic-kyc-level').trim()||'basic-kyc-level');
const kycSettingColumns=db.prepare('PRAGMA table_info(kyc_settings)').all().map(c=>c.name);
for(const [column,type] of Object.entries({
 require_internal_transfer:'INTEGER NOT NULL DEFAULT 0',
 require_withdrawal:'INTEGER NOT NULL DEFAULT 0',
 country_rules_enabled:'INTEGER NOT NULL DEFAULT 0'
})) if(!kycSettingColumns.includes(column)) db.exec(`ALTER TABLE kyc_settings ADD COLUMN ${column} ${type}`);

db.prepare("INSERT OR IGNORE INTO exchange_settings(id,provider,enabled,default_quote) VALUES(1,'kraken',0,'USD')").run();
const exchangeSettingColumns=db.prepare('PRAGMA table_info(exchange_settings)').all().map(c=>c.name);
for(const [column,type] of Object.entries({
 execution_mode:"TEXT NOT NULL DEFAULT 'disabled'",
 emergency_stop:"INTEGER NOT NULL DEFAULT 1",
 route_self_trade:"INTEGER NOT NULL DEFAULT 0",
 route_managed_trade:"INTEGER NOT NULL DEFAULT 0",
 max_order_usd:"REAL NOT NULL DEFAULT 25000"
})) if(!exchangeSettingColumns.includes(column)) db.exec(`ALTER TABLE exchange_settings ADD COLUMN ${column} ${type}`);


function sumsubConfig(){
 return {
  base:String(process.env.SUMSUB_API_BASE||'https://api.sumsub.com').replace(/\/$/,''),
  appToken:String(process.env.SUMSUB_APP_TOKEN||'').trim(),
  secret:String(process.env.SUMSUB_SECRET_KEY||'').trim(),
  webhookSecret:String(process.env.SUMSUB_WEBHOOK_SECRET||'').trim()
 };
}
function sumsubReady(){const c=sumsubConfig();return !!(c.appToken&&c.secret)}
function kycSettings(){return db.prepare('SELECT * FROM kyc_settings WHERE id=1').get()||{
 provider:'sumsub',enabled:1,level_name:'basic-kyc-level',
 require_self_trade:0,require_managed_trade:0,require_investment:0,
 require_internal_transfer:0,require_withdrawal:0,country_rules_enabled:0
}}
function kycExternalUserId(userId){return `optiprotrade-user-${Number(userId)}`}
function ensureKycProfile(user){
 const external=kycExternalUserId(user.id),settings=kycSettings();
 db.prepare(`INSERT OR IGNORE INTO kyc_profiles(user_id,provider,external_user_id,level_name,country_snapshot,status)
   VALUES(?,?,?,?,?,'not_started')`).run(user.id,settings.provider,external,settings.level_name,user.country||null);
 db.prepare(`UPDATE kyc_profiles SET provider=?,external_user_id=COALESCE(external_user_id,?),level_name=COALESCE(level_name,?),country_snapshot=COALESCE(country_snapshot,?),updated_at=CURRENT_TIMESTAMP WHERE user_id=?`)
   .run(settings.provider,external,settings.level_name,user.country||null,user.id);
 return db.prepare('SELECT * FROM kyc_profiles WHERE user_id=?').get(user.id);
}
function mapSumsubState(reviewStatus,reviewAnswer){
 const s=String(reviewStatus||'').toLowerCase(),a=String(reviewAnswer||'').toUpperCase();
 if(a==='GREEN')return 'verified';
 if(a==='RED')return 'rejected';
 if(['pending','queued','prechecked'].includes(s))return 'pending';
 if(['completed'].includes(s))return a==='GREEN'?'verified':(a==='RED'?'rejected':'pending');
 if(['init','onhold'].includes(s))return s==='onhold'?'on_hold':'in_progress';
 return 'in_progress';
}
async function sumsubRequest(method,uri,bodyObj=null){
 const cfg=sumsubConfig();if(!cfg.appToken||!cfg.secret)throw new Error('Sumsub credentials are not configured.');
 const ts=Math.floor(Date.now()/1000).toString(),body=bodyObj==null?'':JSON.stringify(bodyObj),verb=String(method).toUpperCase();
 const signature=crypto.createHmac('sha256',cfg.secret).update(ts+verb+uri+body).digest('hex');
 const response=await fetch(cfg.base+uri,{method:verb,headers:{'Accept':'application/json','Content-Type':'application/json','X-App-Token':cfg.appToken,'X-App-Access-Ts':ts,'X-App-Access-Sig':signature},body:bodyObj==null?undefined:body});
 const text=await response.text();let data={};try{data=text?JSON.parse(text):{}}catch{data={description:text}}
 if(!response.ok){const msg=data?.description||data?.message||data?.error||`Sumsub request failed (${response.status}).`;const e=new Error(msg);e.status=response.status;throw e}
 return data;
}
async function syncKycUser(user){
 const profile=ensureKycProfile(user);if(!sumsubReady())return profile;
 const external=profile.external_user_id||kycExternalUserId(user.id),uri=`/resources/applicants/-;externalUserId=${encodeURIComponent(external)}/one`;
 try{
  const data=await sumsubRequest('GET',uri);
  const review=data.review||{},reviewStatus=review.reviewStatus||'',reviewAnswer=review.reviewResult?.reviewAnswer||'',status=mapSumsubState(reviewStatus,reviewAnswer);
  db.prepare(`UPDATE kyc_profiles SET applicant_id=?,level_name=COALESCE(?,level_name),status=?,provider_review_status=?,provider_review_answer=?,last_error=NULL,
    submitted_at=CASE WHEN ? IN ('pending','verified','rejected') THEN COALESCE(submitted_at,CURRENT_TIMESTAMP) ELSE submitted_at END,
    reviewed_at=CASE WHEN ? IN ('verified','rejected') THEN COALESCE(reviewed_at,CURRENT_TIMESTAMP) ELSE reviewed_at END,
    last_synced_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE user_id=?`)
    .run(data.id||profile.applicant_id,data.levelName||null,status,reviewStatus||null,reviewAnswer||null,status,status,user.id);
 }catch(e){
  if(Number(e.status)===404)return profile;
  db.prepare('UPDATE kyc_profiles SET last_error=?,last_synced_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE user_id=?').run(String(e.message||e).slice(0,500),user.id);
 }
 return db.prepare('SELECT * FROM kyc_profiles WHERE user_id=?').get(user.id);
}
function normalizeComplianceCountry(v){return String(v||'').trim().toLowerCase().replace(/\s+/g,' ')}
function customerCompliance(userId){
 return db.prepare('SELECT status,reason,updated_at FROM compliance_customer_status WHERE user_id=?').get(userId)||{status:'clear',reason:null,updated_at:null};
}
function countryCompliance(country){
 const key=normalizeComplianceCountry(country);if(!key)return null;
 return db.prepare('SELECT id,country_key,country_label,status,reason,updated_at FROM compliance_country_rules WHERE country_key=?').get(key)||null;
}
function kycRequirementFor(settings,feature){
 return feature==='self_trade'?settings.require_self_trade:
  feature==='managed_trade'?settings.require_managed_trade:
  feature==='investment'?settings.require_investment:
  feature==='internal_transfer'?settings.require_internal_transfer:
  feature==='withdrawal'?settings.require_withdrawal:0;
}
function featureLabel(feature){
 return ({self_trade:'Self-Directed Trading',managed_trade:'Trade with OptiTrade',investment:'Investment Plans',internal_transfer:'Internal Transfer',withdrawal:'Withdrawal'})[feature]||'This feature';
}
function complianceGate(user,feature){
 const settings=kycSettings(),customer=customerCompliance(user.id),countryRule=Number(settings.country_rules_enabled)?countryCompliance(user.country):null;
 if(customer.status==='restricted'){
  return {ok:false,complianceRestricted:true,complianceStatus:'restricted',feature,error:customer.reason||`${featureLabel(feature)} is unavailable while your account is restricted. Contact Support for assistance.`};
 }
 if(customer.status==='manual_review'){
  return {ok:false,manualReviewRequired:true,complianceStatus:'manual_review',feature,error:customer.reason||`${featureLabel(feature)} is temporarily unavailable while your account is under compliance review.`};
 }
 if(countryRule?.status==='restricted'){
  return {ok:false,complianceRestricted:true,complianceStatus:'country_restricted',feature,error:countryRule.reason||`${featureLabel(feature)} is not currently available for accounts in your country.`};
 }
 if(countryRule?.status==='review'){
  return {ok:false,manualReviewRequired:true,complianceStatus:'country_review',feature,error:countryRule.reason||`${featureLabel(feature)} requires an account eligibility review for your country.`};
 }
 if(Number(settings.enabled)&&Number(kycRequirementFor(settings,feature))){
  const p=ensureKycProfile(user);
  if(p.status!=='verified')return {ok:false,status:p.status||'not_started',feature,error:`Identity verification is required before using ${featureLabel(feature)}.`,kycRequired:true};
 }
 return {ok:true,feature};
}
function kycGate(user,feature){return complianceGate(user,feature)}
function publicEligibility(user){
 const settings=kycSettings(),customer=customerCompliance(user.id),countryRule=Number(settings.country_rules_enabled)?countryCompliance(user.country):null;
 const features=['self_trade','managed_trade','investment','internal_transfer','withdrawal'];
 return {
  accountStatus:customer.status||'clear',
  accountReason:customer.reason||null,
  countryRulesEnabled:!!settings.country_rules_enabled,
  countryRule:countryRule?{status:countryRule.status,reason:countryRule.reason||null,country:countryRule.country_label}:null,
  features:Object.fromEntries(features.map(f=>[f,complianceGate(user,f)]))
 };
}
function publicKycProfile(user,profile){
 const settings=kycSettings();return {
  status:profile?.status||'not_started',provider:settings.provider,enabled:!!settings.enabled,configured:sumsubReady(),levelName:settings.level_name,
  applicantId:profile?.applicant_id||null,reviewStatus:profile?.provider_review_status||null,reviewAnswer:profile?.provider_review_answer||null,
  country:user.country||profile?.country_snapshot||null,startedAt:profile?.started_at||null,submittedAt:profile?.submitted_at||null,reviewedAt:profile?.reviewed_at||null,lastSyncedAt:profile?.last_synced_at||null,lastError:profile?.last_error||null,
  requirements:{
   selfTrade:!!settings.require_self_trade,managedTrade:!!settings.require_managed_trade,investment:!!settings.require_investment,
   internalTransfer:!!settings.require_internal_transfer,withdrawal:!!settings.require_withdrawal
  },
  eligibility:publicEligibility(user)
 };
}

function exchangeSettings(){
 return db.prepare('SELECT * FROM exchange_settings WHERE id=1').get()||{
  provider:'kraken',enabled:0,default_quote:'USD',execution_mode:'disabled',
  emergency_stop:1,route_self_trade:0,route_managed_trade:0,max_order_usd:25000
 };
}
function krakenConfig(){
 return {
  base:String(process.env.KRAKEN_API_BASE||'https://api.kraken.com').replace(/\/$/,''),
  apiKey:String(process.env.KRAKEN_API_KEY||'').trim(),
  apiSecret:String(process.env.KRAKEN_API_SECRET||'').trim()
 };
}
function krakenPrivateReady(){const c=krakenConfig();return !!(c.apiKey&&c.apiSecret)}
async function krakenPublic(uri){
 const c=krakenConfig(),r=await fetch(c.base+uri,{headers:{Accept:'application/json'}}),d=await r.json();
 if(!r.ok||d?.error?.length)throw new Error((d?.error||[]).join(', ')||`Kraken request failed (${r.status}).`);
 return d.result||{};
}
async function krakenPrivate(uri,params={}){
 const c=krakenConfig();if(!c.apiKey||!c.apiSecret)throw new Error('Kraken API credentials are not configured.');
 const nonce=(Date.now()*1000+crypto.randomInt(0,999)).toString();
 const normalized={nonce};
 for(const [k,v] of Object.entries(params||{}))if(v!==undefined&&v!==null&&v!=='')normalized[k]=String(v);
 const form=new URLSearchParams(normalized),body=form.toString();
 const digest=crypto.createHash('sha256').update(nonce+body).digest();
 const message=Buffer.concat([Buffer.from(uri),digest]);
 const signature=crypto.createHmac('sha512',Buffer.from(c.apiSecret,'base64')).update(message).digest('base64');
 const r=await fetch(c.base+uri,{method:'POST',headers:{'API-Key':c.apiKey,'API-Sign':signature,'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body});
 const text=await r.text();let d={};try{d=text?JSON.parse(text):{}}catch{d={error:[text||`HTTP ${r.status}`]}}
 if(!r.ok||d?.error?.length)throw new Error((d?.error||[]).join(', ')||`Kraken private request failed (${r.status}).`);
 return d.result||{};
}
function krakenPair(symbol){
 const s=String(symbol||'BTCUSD').toUpperCase().replace(/[^A-Z]/g,'');
 return ({BTCUSD:'XBTUSD',XBTUSD:'XBTUSD',ETHUSD:'ETHUSD',USDTUSD:'USDTUSD'})[s]||null;
}
function localSymbolFromKraken(pair){
 const s=String(pair||'').toUpperCase().replace(/[^A-Z]/g,'');
 return s==='XBTUSD'?'BTC/USD':s==='ETHUSD'?'ETH/USD':s==='USDTUSD'?'USDT/USD':pair;
}
async function testKrakenConnection(){
 const system=await krakenPublic('/0/public/SystemStatus');
 let privateConnected=false,assetCount=0,privateError=null,permissions=[];
 if(krakenPrivateReady()){
  try{
   const [b,keyInfo]=await Promise.all([
    krakenPrivate('/0/private/Balance'),
    krakenPrivate('/0/private/GetApiKeyInfo').catch(()=>null)
   ]);
   privateConnected=true;assetCount=Object.keys(b||{}).length;
   permissions=Array.isArray(keyInfo?.permissions)?keyInfo.permissions:[];
  }catch(e){privateError=e.message}
 }
 return {
  publicConnected:true,systemStatus:system.status||null,systemTimestamp:system.timestamp||null,
  privateCredentialsReady:krakenPrivateReady(),privateConnected,assetCount,privateError,permissions,
  canCreateOrders:permissions.includes('modify-trades'),
  canQueryOpen:permissions.includes('query-open-trades'),
  canQueryClosed:permissions.includes('query-closed-trades'),
  canCancelOrders:permissions.includes('close-trades')
 };
}
async function krakenTicker(symbol){
 const pair=krakenPair(symbol);if(!pair)throw new Error('Kraken routing currently supports BTC/USD, ETH/USD and USDT/USD.');
 const result=await krakenPublic('/0/public/Ticker?pair='+encodeURIComponent(pair)),key=Object.keys(result)[0],row=result[key];
 if(!row)throw new Error('Ticker is unavailable.');
 return {symbol:String(symbol).toUpperCase(),providerSymbol:key,last:Number(row.c?.[0]||0),bid:Number(row.b?.[0]||0),ask:Number(row.a?.[0]||0),updatedAt:new Date().toISOString()};
}
async function krakenAddMarketOrder({symbol,side,notionalUsd,baseVolume=null,userref,validate=false}){
 const pair=krakenPair(symbol);if(!pair)throw new Error('This market is not supported by the configured Kraken adapter.');
 const direction=String(side||'buy').toLowerCase()==='sell'?'sell':'buy';
 const quote=await krakenTicker(symbol);
 const px=direction==='buy'?Number(quote.ask||quote.last):Number(quote.bid||quote.last);
 if(!(px>0))throw new Error('A usable exchange quote is unavailable.');
 let volume,oflags;
 if(baseVolume!=null){
  volume=Number(baseVolume);
 }else if(direction==='buy'){
  // Kraken supports quote-currency volume for market BUY orders via viqc.
  volume=Number(notionalUsd);
  oflags='viqc';
 }else{
  // Market SELL orders use base-asset volume.
  volume=Number(notionalUsd)/px;
 }
 if(!(volume>0))throw new Error('Order volume is invalid.');
 const params={
  pair,type:direction,ordertype:'market',
  volume:Number(volume).toFixed(baseVolume!=null?10:8),
  userref:Number(userref),
  validate:validate?'true':'false',
  deadline:new Date(Date.now()+20000).toISOString()
 };
 if(oflags)params.oflags=oflags;
 const result=await krakenPrivate('/0/private/AddOrder',params);
 return {
  result,pair,side:direction,requestedVolume:volume,referencePrice:px,
  externalOrderId:Array.isArray(result?.txid)?result.txid[0]||null:null,
  description:result?.descr?.order||null
 };
}
async function krakenQueryOrder(txid){
 if(!txid)throw new Error('External order ID is missing.');
 const result=await krakenPrivate('/0/private/QueryOrders',{txid,trades:'true'});
 const key=Object.keys(result||{})[0],row=key?result[key]:null;
 if(!row)throw new Error('Kraken order was not found.');
 return {txid:key,row};
}
async function krakenFindOrderByUserref(userref){
 const [openResult,closedResult]=await Promise.all([
  krakenPrivate('/0/private/OpenOrders',{userref:Number(userref)}).catch(()=>({open:{}})),
  krakenPrivate('/0/private/ClosedOrders',{userref:Number(userref)}).catch(()=>({closed:{}}))
 ]);
 const open=openResult?.open||{},closed=closedResult?.closed||{};
 const openId=Object.keys(open)[0];if(openId)return {txid:openId,row:open[openId]};
 const closedId=Object.keys(closed)[0];if(closedId)return {txid:closedId,row:closed[closedId]};
 return null;
}
async function krakenCancelAll(){return await krakenPrivate('/0/private/CancelAll')}
function exchangeAdapter(){
 const s=exchangeSettings();
 if(s.provider==='kraken')return {
  provider:'kraken',test:testKrakenConnection,ticker:krakenTicker,
  addMarketOrder:krakenAddMarketOrder,queryOrder:krakenQueryOrder,
  findOrderByUserref:krakenFindOrderByUserref,cancelAll:krakenCancelAll
 };
 throw new Error('Configured exchange provider is not implemented yet.');
}
function externalStatusFromKraken(status){
 const s=String(status||'').toLowerCase();
 if(s==='closed')return 'filled';
 if(s==='open')return 'open';
 if(s==='pending')return 'submitted';
 if(s==='canceled')return 'canceled';
 if(s==='expired')return 'expired';
 return s||'unknown';
}
function exchangeOrderRow(kind,requestId,leg='open'){
 return db.prepare(`SELECT * FROM exchange_orders WHERE request_kind=? AND request_id=? AND leg=? ORDER BY id DESC LIMIT 1`).get(kind,requestId,leg);
}
function exchangeOrderPublic(row){
 if(!row)return null;
 return {
  id:row.id,provider:row.provider,leg:row.leg,externalOrderId:row.external_order_id||null,
  symbol:row.symbol,providerPair:row.provider_pair,side:row.side,status:row.status,
  validationOnly:!!row.validation_only,filledVolume:row.filled_volume==null?null:Number(row.filled_volume),
  avgPrice:row.avg_price==null?null:Number(row.avg_price),cost:row.cost==null?null:Number(row.cost),
  fee:row.fee==null?null:Number(row.fee),description:row.description||null,lastError:row.last_error||null,
  submittedAt:row.submitted_at||null,lastSyncedAt:row.last_synced_at||null,closedAt:row.closed_at||null
 };
}
async function reconcileExchangeOrder(row){
 if(!row)return null;
 if(row.validation_only)return row;
 let found=null;
 try{
  if(row.external_order_id)found=await exchangeAdapter().queryOrder(row.external_order_id);
  else if(row.userref)found=await exchangeAdapter().findOrderByUserref(row.userref);
  if(!found){
   db.prepare("UPDATE exchange_orders SET status='submission_unknown',last_error=?,last_synced_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run('No matching exchange order found yet.',row.id);
   return db.prepare('SELECT * FROM exchange_orders WHERE id=?').get(row.id);
  }
  const x=found.row||{},status=externalStatusFromKraken(x.status);
  db.prepare(`UPDATE exchange_orders SET external_order_id=COALESCE(?,external_order_id),status=?,filled_volume=?,avg_price=?,cost=?,fee=?,description=COALESCE(?,description),
    last_error=NULL,last_synced_at=CURRENT_TIMESTAMP,closed_at=CASE WHEN ? IN ('filled','canceled','expired') THEN COALESCE(closed_at,CURRENT_TIMESTAMP) ELSE closed_at END,updated_at=CURRENT_TIMESTAMP
    WHERE id=?`).run(
      found.txid||null,status,Number(x.vol_exec||0),Number(x.price||0),Number(x.cost||0),Number(x.fee||0),
      x.descr?.order||null,status,row.id
    );
 }catch(e){
  db.prepare("UPDATE exchange_orders SET last_error=?,last_synced_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(String(e.message||e).slice(0,500),row.id);
 }
 return db.prepare('SELECT * FROM exchange_orders WHERE id=?').get(row.id);
}
function exchangeExecutionAllowed(kind,amount){
 const s=exchangeSettings();
 if(!s.enabled)return {ok:false,error:'Exchange connector is disabled.'};
 if(!krakenPrivateReady())return {ok:false,error:'Exchange API credentials are not configured.'};
 if(!['validate','live'].includes(String(s.execution_mode)))return {ok:false,error:'External execution mode is disabled.'};
 if(kind==='self'&&!Number(s.route_self_trade))return {ok:false,error:'External routing for Self-Directed trades is disabled.'};
 if(kind==='managed'&&!Number(s.route_managed_trade))return {ok:false,error:'External routing for Trade with OptiTrade is disabled.'};
 if(Number(amount)>Number(s.max_order_usd||0))return {ok:false,error:`This request exceeds the configured external order limit of $${Number(s.max_order_usd||0).toLocaleString()}.`};
 if(s.execution_mode==='live'&&Number(s.emergency_stop))return {ok:false,error:'Exchange emergency stop is ON. New live orders are blocked.'};
 return {ok:true,settings:s,validationOnly:s.execution_mode==='validate'};
}
async function createExchangeOpeningOrder({kind,trade,user,actor,symbol,side}){
 const principal=kind==='self'?Number(trade.notional_usd):Number(trade.amount),allowed=exchangeExecutionAllowed(kind,principal);
 if(!allowed.ok)throw new Error(allowed.error);
 const normalized=String(symbol||'').trim().toUpperCase(),providerPair=krakenPair(normalized);
 if(!providerPair)throw new Error('Kraken external routing currently supports BTC/USD, ETH/USD and USDT/USD only.');
 const direction=String(side||'buy').toLowerCase()==='sell'?'sell':'buy';
 const info=db.prepare(`INSERT INTO exchange_orders(provider,request_kind,request_id,user_id,local_reference,leg,symbol,provider_pair,side,requested_usd,validation_only,status,created_by)
   VALUES(?,?,?,?,?,'open',?,?,?,?,?,?,?)`).run(
    'kraken',kind,trade.id,trade.user_id,trade.reference,normalized,providerPair,direction,principal,
    allowed.validationOnly?1:0,'submitting',actor.id
   );
 const orderId=Number(info.lastInsertRowid);
 db.prepare('UPDATE exchange_orders SET userref=? WHERE id=?').run(orderId,orderId);
 try{
  const placed=await exchangeAdapter().addMarketOrder({symbol:normalized,side:direction,notionalUsd:principal,userref:orderId,validate:allowed.validationOnly});
  const status=allowed.validationOnly?'validated':'submitted';
  db.prepare(`UPDATE exchange_orders SET external_order_id=?,requested_volume=?,status=?,description=?,submitted_at=CURRENT_TIMESTAMP,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
   .run(placed.externalOrderId||null,Number(placed.requestedVolume||0),status,placed.description||null,orderId);
  let row=db.prepare('SELECT * FROM exchange_orders WHERE id=?').get(orderId);
  if(!allowed.validationOnly)row=await reconcileExchangeOrder(row);
  return {row,validationOnly:allowed.validationOnly,settings:allowed.settings};
 }catch(e){
  db.prepare(`UPDATE exchange_orders SET status='submission_unknown',last_error=?,submitted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
   .run(String(e.message||e).slice(0,500),orderId);
  const err=new Error(`Exchange submission needs review: ${e.message||e}`);err.exchangeOrderId=orderId;throw err;
 }
}
async function createExchangeClosingOrder({kind,trade,actor}){
 let open=exchangeOrderRow(kind,trade.id,'open');
 if(!open)throw new Error('No opening exchange order is linked to this trade.');
 open=await reconcileExchangeOrder(open);
 if(!open||Number(open.filled_volume||0)<=0)throw new Error('Opening exchange order does not have an executed quantity yet.');
 if(!['filled','open'].includes(open.status))throw new Error(`Opening exchange order status is ${open.status}.`);
 let close=exchangeOrderRow(kind,trade.id,'close');
 if(close){
  close=await reconcileExchangeOrder(close);
  return {open,close,existing:true};
 }
 const closeSide=open.side==='buy'?'sell':'buy';
 const info=db.prepare(`INSERT INTO exchange_orders(provider,request_kind,request_id,user_id,local_reference,leg,symbol,provider_pair,side,requested_usd,requested_volume,validation_only,status,created_by)
   VALUES(?,?,?,?,?,'close',?,?,?,?,?,?,0,'submitting',?)`).run(
    'kraken',kind,trade.id,trade.user_id,trade.reference,open.symbol,open.provider_pair,closeSide,
    Number(open.cost||trade.notional_usd||trade.amount||0),Number(open.filled_volume||0),actor.id
   );
 const id=Number(info.lastInsertRowid);db.prepare('UPDATE exchange_orders SET userref=? WHERE id=?').run(id,id);
 try{
  const placed=await exchangeAdapter().addMarketOrder({
   symbol:open.symbol,side:closeSide,notionalUsd:Number(open.cost||0),
   baseVolume:Number(open.filled_volume||0),userref:id,validate:false
  });
  db.prepare(`UPDATE exchange_orders SET external_order_id=?,requested_volume=?,status='submitted',description=?,submitted_at=CURRENT_TIMESTAMP,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
   .run(placed.externalOrderId||null,Number(placed.requestedVolume||0),placed.description||null,id);
  close=await reconcileExchangeOrder(db.prepare('SELECT * FROM exchange_orders WHERE id=?').get(id));
  return {open,close,existing:false};
 }catch(e){
  db.prepare(`UPDATE exchange_orders SET status='submission_unknown',last_error=?,submitted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
   .run(String(e.message||e).slice(0,500),id);
  throw new Error(`Closing order needs review: ${e.message||e}`);
 }
}
function externalPnl(open,close){
 const openCost=Number(open.cost||0),closeCost=Number(close.cost||0),fees=Number(open.fee||0)+Number(close.fee||0);
 return open.side==='buy'?(closeCost-openCost-fees):(openCost-closeCost-fees);
}


function money(value){
 const n=Number(value);
 if(!Number.isFinite(n))return '$0.00';
 return '$'+n.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
}

function productionBaseUrl(){
 const raw=String(process.env.APP_BASE_URL||'').trim().replace(/\/+$/,'');
 if(!raw)return null;
 try{
  const u=new URL(raw);
  return /^https?:$/.test(u.protocol)?u.toString().replace(/\/$/,''):null;
 }catch{return null}
}
function launchAuditChecks(){
 const production=String(process.env.NODE_ENV||'development').toLowerCase()==='production';
 const sessionSecret=String(process.env.SESSION_SECRET||'').trim();
 const otpPepperValue=String(process.env.OTP_PEPPER||'').trim();
 const email=emailRuntimeStatus(),kyc=kycSettings(),exchange=exchangeSettings(),baseUrl=productionBaseUrl();
 const superAdmins=Number(db.prepare("SELECT COUNT(*) n FROM users WHERE role='super_admin' AND admin_active<>0").get()?.n||0);
 const activeWallets=Number(db.prepare("SELECT COUNT(*) n FROM deposit_wallet_addresses WHERE active=1").get()?.n||0);
 const pendingDeposits=Number(db.prepare("SELECT COUNT(*) n FROM deposit_requests WHERE status='pending'").get()?.n||0);
 const pendingWithdrawals=Number(db.prepare("SELECT COUNT(*) n FROM withdrawal_requests WHERE status IN ('pending','on_hold')").get()?.n||0);
 const pendingTrades=Number(db.prepare("SELECT COUNT(*) n FROM paper_trade_orders WHERE status IN ('pending','active')").get()?.n||0)
   +Number(db.prepare("SELECT COUNT(*) n FROM managed_trade_requests WHERE status IN ('pending','active')").get()?.n||0);
 const activeInvestments=Number(db.prepare("SELECT COUNT(*) n FROM investment_plan_requests WHERE status IN ('pending','active','on_hold')").get()?.n||0);
 const emailFailures24h=Number(db.prepare("SELECT COUNT(*) n FROM email_delivery_logs WHERE status='failed' AND created_at>=datetime('now','-1 day')").get()?.n||0);
 const testOtp=otpTestModeEnabled();
 const countryRules=Number(db.prepare('SELECT COUNT(*) n FROM compliance_country_rules').get()?.n||0);
 const kycRequired=!!(kyc.require_self_trade||kyc.require_managed_trade||kyc.require_investment||kyc.require_internal_transfer||kyc.require_withdrawal);
 const exchangeLive=exchange.execution_mode==='live';
 const persistentDb=dbPath.startsWith('/var/data/')||String(process.env.DB_PATH||'').trim().startsWith('/var/data/');
 const checks=[
  {id:'environment',level:'critical',ok:production,title:'Production environment',detail:`NODE_ENV=${process.env.NODE_ENV||'development'}`,fix:'Set NODE_ENV=production on the hosted service.'},
  {id:'session-secret',level:'critical',ok:sessionSecret.length>=32,title:'Session secret',detail:sessionSecret.length>=32?'Strong server session secret configured.':'SESSION_SECRET is missing or too short.',fix:'Use a randomly generated SESSION_SECRET of at least 32 characters.'},
  {id:'otp-pepper',level:'warning',ok:otpPepperValue.length>=32,title:'Dedicated OTP pepper',detail:otpPepperValue.length>=32?'Dedicated OTP_PEPPER configured.':'OTP hashes currently fall back to SESSION_SECRET.',fix:'Set a separate random OTP_PEPPER of at least 32 characters.'},
  {id:'database-persistence',level:'critical',ok:!production||persistentDb,title:'Persistent SQLite storage',detail:`Database path: ${dbPath}`,fix:'On Render use DB_PATH=/var/data/optitrade.db with a persistent disk.'},
  {id:'database-integrity',level:'critical',ok:String(db.pragma('integrity_check',{simple:true}))==='ok',title:'SQLite integrity',detail:'PRAGMA integrity_check completed.',fix:'Restore from a known-good backup before launch.'},
  {id:'super-admin',level:'critical',ok:superAdmins>0,title:'Super Admin account',detail:`${superAdmins} active Super Admin account(s).`,fix:'Configure/create at least one active Super Admin account.'},
  {id:'base-url',level:'warning',ok:!!baseUrl&&(!production||baseUrl.startsWith('https://')),title:'Public application URL',detail:baseUrl||'APP_BASE_URL is not configured.',fix:'Set APP_BASE_URL to the final HTTPS domain.'},
  {id:'trust-proxy',level:'warning',ok:!production||String(process.env.TRUST_PROXY||'').toLowerCase()==='true',title:'Trusted reverse proxy',detail:`TRUST_PROXY=${process.env.TRUST_PROXY||'false'}`,fix:'Enable TRUST_PROXY only on the trusted hosted reverse proxy.'},
  {id:'email-transport',level:'critical',ok:email.productionReady,title:'Production email transport',detail:email.productionReady?`Mode ${email.provider}; production transport ready.`:'Neither Resend nor SMTP is ready.',fix:'Configure Resend or SMTP before customer OTP/login use.'},
  {id:'support-email',level:'warning',ok:!!configuredSupportEmail(),title:'Support email',detail:configuredSupportEmail()||'SUPPORT_EMAIL is missing.',fix:'Configure SUPPORT_EMAIL.'},
  {id:'sender',level:'critical',ok:!!String(process.env.RESEND_FROM||process.env.MAIL_FROM||'').trim(),title:'Verified sender',detail:String(process.env.RESEND_FROM||process.env.MAIL_FROM||'').trim()?'Sender value configured.':'No mail sender configured.',fix:'Set RESEND_FROM or MAIL_FROM to a verified sender.'},
  {id:'otp-testing',level:'critical',ok:!testOtp,title:'Testing OTP mode',detail:testOtp?'Testing OTP Mode is ON.':'Testing OTP Mode is OFF.',fix:'Disable Testing OTP Mode before public use.'},
  {id:'email-failures',level:'warning',ok:emailFailures24h===0,title:'Recent email failures',detail:`${emailFailures24h} failed email delivery record(s) in the last 24 hours.`,fix:'Review Email & OTP Delivery failures before launch.'},
  {id:'deposit-wallets',level:'warning',ok:activeWallets>0,title:'Deposit receiving wallets',detail:`${activeWallets} active receiving address(es).`,fix:'Configure the public deposit addresses customers should use.'},
  {id:'kyc-provider',level:kycRequired?'critical':'info',ok:!kycRequired||sumsubReady(),title:'KYC provider',detail:kycRequired?(sumsubReady()?'KYC is required and provider credentials are ready.':'KYC is required but provider credentials are missing.'):'KYC provider readiness is optional while all KYC gates remain off.',fix:'Configure Sumsub credentials or disable KYC enforcement gates.'},
  {id:'kyc-webhook',level:kycRequired?'critical':'info',ok:!kycRequired||!!sumsubConfig().webhookSecret,title:'KYC webhook signature',detail:sumsubConfig().webhookSecret?'Webhook signature secret configured.':'Webhook signature secret is missing.',fix:'Configure SUMSUB_WEBHOOK_SECRET if KYC is enforced.'},
  {id:'country-rules',level:'info',ok:true,title:'Country eligibility policy',detail:`Country rules ${kyc.country_rules_enabled?'ON':'OFF'} • ${countryRules} configured rule(s).`,fix:'Review jurisdiction eligibility with qualified counsel before enabling restrictions.'},
  {id:'exchange-credentials',level:exchangeLive?'critical':'info',ok:!exchangeLive||krakenPrivateReady(),title:'Exchange credentials',detail:exchangeLive?(krakenPrivateReady()?'Live execution credentials configured.':'Live execution selected but credentials are unavailable.'):`Execution mode: ${exchange.execution_mode||'disabled'}.`,fix:'Configure the minimum Kraken API permissions before Live mode.'},
  {id:'exchange-emergency',level:'warning',ok:!exchangeLive||Number(exchange.emergency_stop)===1,title:'Exchange emergency control',detail:exchangeLive?`Live mode • emergency stop ${Number(exchange.emergency_stop)?'ON':'OFF'}.`:'Live exchange execution is not active.',fix:'Keep the emergency procedure documented and test Cancel All before public live execution.'},
  {id:'pending-operations',level:'info',ok:true,title:'Outstanding operations',detail:`Deposits ${pendingDeposits} • Withdrawals ${pendingWithdrawals} • Trades ${pendingTrades} • Investments ${activeInvestments}`,fix:'Review outstanding customer operations before migrations, restores, or launch changes.'}
 ];
 const criticalFailed=checks.filter(x=>x.level==='critical'&&!x.ok).length;
 const warningsFailed=checks.filter(x=>x.level==='warning'&&!x.ok).length;
 return {
  generatedAt:new Date().toISOString(),
  version:String(require('../package.json').version||''),
  production,
  baseUrl,
  counts:{criticalFailed,warningsFailed,total:checks.length},
  readyForTechnicalLaunch:criticalFailed===0,
  checks
 };
}
function logStartupReadiness(){
 try{
  const audit=launchAuditChecks();
  const failed=audit.checks.filter(x=>!x.ok&&['critical','warning'].includes(x.level));
  console.log(`[LAUNCH AUDIT] ${audit.counts.criticalFailed} critical issue(s), ${audit.counts.warningsFailed} warning(s).`);
  for(const x of failed)console.warn(`[LAUNCH ${x.level.toUpperCase()}] ${x.title}: ${x.detail}`);
 }catch(e){console.warn('[LAUNCH AUDIT]',e.message)}
}

app.disable('x-powered-by');
if(String(process.env.TRUST_PROXY||'').toLowerCase()==='true') app.set('trust proxy',1);
app.use((req,res,next)=>{
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('X-Frame-Options','DENY');
 res.setHeader('Referrer-Policy','same-origin');
 if(String(process.env.NODE_ENV||'development').toLowerCase()==='production' && String(process.env.HSTS_ENABLED||'true').toLowerCase()!=='false')
   res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
 // Sumsub WebSDK needs browser camera/microphone access on the KYC page.
 // Other customer/admin pages keep those permissions disabled.
 if(req.path==='/kyc.html'||req.path.startsWith('/api/kyc/'))res.setHeader('Permissions-Policy','geolocation=()');
 else res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
 next();
});
app.use(express.json({limit:'256kb',verify:(req,res,buf)=>{req.rawBody=Buffer.from(buf)}}));
app.use(cookieParser());

app.get('/register.html',(req,res)=>{
 res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
 res.set('Pragma','no-cache');res.set('Expires','0');
 const code=String(req.query.ref||'').trim().toUpperCase().slice(0,80);
 if(code){
  const owner=db.prepare("SELECT id,name,username,email,referral_code FROM users WHERE referral_code=? AND role='sub_admin' AND admin_active=1").get(code);
  if(owner)setImmediate(()=>alertReferralVisit(req,owner,code).catch(e=>console.error('[REFERRAL VISIT]',e.message)));
 }
 return res.sendFile(path.join(__dirname,'../public/register.html'));
});
app.get('/js/register.js',(req,res)=>{
 res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
 res.set('Pragma','no-cache');res.set('Expires','0');
 return res.sendFile(path.join(__dirname,'../public/js/register.js'));
});
app.get('/verify.html',(req,res)=>{
 res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
 res.set('Pragma','no-cache');res.set('Expires','0');
 return res.sendFile(path.join(__dirname,'../public/verify.html'));
});
app.get('/js/verify.js',(req,res)=>{
 res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
 res.set('Pragma','no-cache');res.set('Expires','0');
 return res.sendFile(path.join(__dirname,'../public/js/verify.js'));
});
app.use(express.static(path.join(__dirname,'../public')));
app.use('/admin',express.static(path.join(__dirname,'../admin')));
const apiLimiter=rateLimit({windowMs:60*1000,limit:180,standardHeaders:'draft-7',legacyHeaders:false});
app.use('/api',apiLimiter);
const limiter=rateLimit({windowMs:60*1000,limit:20,standardHeaders:'draft-7',legacyHeaders:false});
app.use('/api/auth',limiter);
app.get('/api/health',(req,res)=>{
 try{
   db.prepare('SELECT 1 ok').get();
   const integrity=String(db.pragma('quick_check',{simple:true}));
   const ok=integrity==='ok';
   res.status(ok?200:503).json({
    ok,service:'OptiTrade',database:ok?'ok':'integrity_check_failed',
    version:String(require('../package.json').version||''),environment:String(process.env.NODE_ENV||'development'),
    uptimeSeconds:Math.floor(process.uptime()),time:new Date().toISOString()
   });
 }catch(e){
   res.status(503).json({ok:false,service:'OptiTrade',database:'unavailable',time:new Date().toISOString()});
 }
});

// KYC customer APIs.
app.get('/api/kyc/status',auth,async(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required.'});
 const p=ensureKycProfile(req.user);res.set('Cache-Control','no-store');res.json(publicKycProfile(req.user,p));
});
app.get('/api/compliance/status',auth,(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required.'});
 res.set('Cache-Control','no-store');res.json(publicEligibility(req.user));
});
app.post('/api/kyc/sdk-token',auth,async(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required.'});
 const settings=kycSettings();if(!settings.enabled)return res.status(423).json({error:'Identity verification is temporarily unavailable.'});
 if(settings.provider!=='sumsub')return res.status(503).json({error:'The configured KYC provider is not available.'});
 if(!sumsubReady())return res.status(503).json({error:'Identity verification provider credentials are not configured yet.'});
 const profile=ensureKycProfile(req.user),body={ttlInSecs:600,userId:profile.external_user_id,levelName:settings.level_name,applicantIdentifiers:{email:req.user.email,phone:req.user.phone||undefined}};
 try{
  const d=await sumsubRequest('POST','/resources/accessTokens/sdk',body);
  db.prepare("UPDATE kyc_profiles SET status=CASE WHEN status='not_started' THEN 'in_progress' ELSE status END,started_at=COALESCE(started_at,CURRENT_TIMESTAMP),level_name=?,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE user_id=?").run(settings.level_name,req.user.id);
  logActivity(req.user.id,req.user.id,'kyc_started','Identity verification session started');
  res.set('Cache-Control','no-store');res.json({token:d.token,userId:d.userId||profile.external_user_id,expiresIn:600,provider:'sumsub'});
 }catch(e){db.prepare('UPDATE kyc_profiles SET last_error=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?').run(String(e.message||e).slice(0,500),req.user.id);res.status(502).json({error:e.message||'Could not start identity verification.'})}
});
app.post('/api/kyc/sync',auth,async(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required.'});
 const before=ensureKycProfile(req.user),after=await syncKycUser(req.user);
 if(after.status!==before.status){
  logActivity(req.user.id,req.user.id,'kyc_status',`Identity verification status: ${after.status}`);
  if(after.status==='verified')notifyAndEmail(req.user.id,'security','Identity verification completed','Your OptiProTrade identity verification has been completed successfully.','/kyc.html');
  if(after.status==='rejected')notifyAndEmail(req.user.id,'security','Identity verification needs attention','Your identity verification needs attention. Open Identity Verification to review the provider instructions and resubmit if requested.','/kyc.html');
 }
 res.set('Cache-Control','no-store');res.json(publicKycProfile(req.user,after));
});

// Sumsub webhook. Configure the production HTTPS URL as /api/kyc/sumsub/webhook.
app.post('/api/kyc/sumsub/webhook',(req,res)=>{
 const cfg=sumsubConfig();if(!cfg.webhookSecret)return res.status(503).json({error:'KYC webhook secret is not configured.'});
 const alg=String(req.headers['x-payload-digest-alg']||''),given=String(req.headers['x-payload-digest']||'');
 const algo=({HMAC_SHA256_HEX:'sha256',HMAC_SHA512_HEX:'sha512',HMAC_SHA1_HEX:'sha1'})[alg];if(!algo||!given)return res.status(401).json({error:'Missing or unsupported webhook signature.'});
 const raw=req.rawBody||Buffer.from(JSON.stringify(req.body||{})),calc=crypto.createHmac(algo,cfg.webhookSecret).update(raw).digest('hex');
 try{if(!crypto.timingSafeEqual(Buffer.from(calc),Buffer.from(given)))return res.status(401).json({error:'Invalid webhook signature.'})}catch{return res.status(401).json({error:'Invalid webhook signature.'})}
 const payload=req.body||{},external=String(payload.externalUserId||'');const m=external.match(/^optiprotrade-user-(\d+)$/);if(!m)return res.json({ok:true,ignored:true});
 const userId=Number(m[1]),user=db.prepare("SELECT id,name,email,username,phone,country,role,owner_admin_id FROM users WHERE id=? AND role='user'").get(userId);if(!user)return res.json({ok:true,ignored:true});
 const reviewStatus=payload.reviewStatus||'',reviewAnswer=payload.reviewResult?.reviewAnswer||'',status=mapSumsubState(reviewStatus,reviewAnswer);
 ensureKycProfile(user);db.prepare(`UPDATE kyc_profiles SET applicant_id=COALESCE(?,applicant_id),level_name=COALESCE(?,level_name),status=?,provider_review_status=?,provider_review_answer=?,last_error=NULL,
  submitted_at=CASE WHEN ? IN ('pending','verified','rejected') THEN COALESCE(submitted_at,CURRENT_TIMESTAMP) ELSE submitted_at END,
  reviewed_at=CASE WHEN ? IN ('verified','rejected') THEN COALESCE(reviewed_at,CURRENT_TIMESTAMP) ELSE reviewed_at END,last_synced_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE user_id=?`)
  .run(payload.applicantId||null,payload.levelName||null,status,reviewStatus||null,reviewAnswer||null,status,status,userId);
 logActivity(userId,userId,'kyc_webhook',`Identity verification status: ${status}`);
 if(status==='verified')notifyAndEmail(userId,'security','Identity verification completed','Your OptiProTrade identity verification has been completed successfully.','/kyc.html');
 if(status==='rejected')notifyAndEmail(userId,'security','Identity verification needs attention','Your identity verification needs attention. Open Identity Verification to review the verification instructions.','/kyc.html');
 res.json({ok:true});
});

// Admin KYC center.
app.get('/api/admin/kyc',admin,(req,res)=>{
 const settings=kycSettings(),where=scopedUserWhere(req.user,'u');
 const rows=db.prepare(`SELECT u.id,u.name,u.username,u.email,u.country,u.owner_admin_id,k.provider,k.applicant_id,k.level_name,k.status,k.provider_review_status,k.provider_review_answer,k.started_at,k.submitted_at,k.reviewed_at,k.last_synced_at,k.last_error,k.updated_at,
   COALESCE(c.status,'clear') compliance_status,c.reason compliance_reason,c.updated_at compliance_updated_at
   FROM users u LEFT JOIN kyc_profiles k ON k.user_id=u.id LEFT JOIN compliance_customer_status c ON c.user_id=u.id
   WHERE ${where} ORDER BY CASE COALESCE(c.status,'clear') WHEN 'restricted' THEN 0 WHEN 'manual_review' THEN 1 ELSE 2 END,
   CASE COALESCE(k.status,'not_started') WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'verified' THEN 3 ELSE 4 END,u.id DESC LIMIT 500`).all();
 const countryRules=isSuper(req.user)?db.prepare('SELECT id,country_label,status,reason,updated_at FROM compliance_country_rules ORDER BY country_label COLLATE NOCASE').all():[];
 const availableCountries=isSuper(req.user)?db.prepare("SELECT DISTINCT TRIM(country) country FROM users WHERE role='user' AND country IS NOT NULL AND TRIM(country)<>'' ORDER BY country COLLATE NOCASE").all().map(x=>x.country):[];
 const customers=rows.map(x=>({
  ...x,status:x.status||'not_started',
  country_rule:Number(settings.country_rules_enabled)?countryCompliance(x.country):null
 }));
 res.set('Cache-Control','no-store');res.json({
  role:req.user.role,canManage:isSuper(req.user),configured:sumsubReady(),webhookReady:!!sumsubConfig().webhookSecret,
  settings,customers,countryRules,availableCountries
 });
});
app.post('/api/admin/kyc/:userId/sync',admin,async(req,res)=>{
 const user=db.prepare("SELECT id,name,email,username,phone,country,role,owner_admin_id FROM users WHERE id=? AND role='user'").get(req.params.userId);if(!user||!ownsUser(req.user,user.id))return res.status(403).json({error:'Customer unavailable.'});
 if(!sumsubReady())return res.status(503).json({error:'Sumsub credentials are not configured.'});const p=await syncKycUser(user);res.json({ok:true,profile:publicKycProfile(user,p)});
});
app.put('/api/super/kyc/settings',superAdmin,(req,res)=>{
 const provider=String(req.body.provider||'sumsub').toLowerCase(),enabled=req.body.enabled!==false?1:0,levelName=String(req.body.levelName||'').trim().slice(0,120);
 const self=req.body.requireSelfTrade===true?1:0,managed=req.body.requireManagedTrade===true?1:0,investment=req.body.requireInvestment===true?1:0;
 const transfer=req.body.requireInternalTransfer===true?1:0,withdrawal=req.body.requireWithdrawal===true?1:0,countryRules=req.body.countryRulesEnabled===true?1:0;
 if(provider!=='sumsub')return res.status(400).json({error:'Sumsub is the currently implemented KYC provider.'});
 if(levelName.length<2)return res.status(400).json({error:'Enter the Sumsub verification level name.'});
 if((self||managed||investment||transfer||withdrawal)&&(!enabled||!sumsubReady()))
  return res.status(409).json({error:'Keep KYC enabled and configure SUMSUB_APP_TOKEN plus SUMSUB_SECRET_KEY before requiring verification for customer features.'});
 db.prepare(`UPDATE kyc_settings SET provider=?,enabled=?,level_name=?,require_self_trade=?,require_managed_trade=?,require_investment=?,require_internal_transfer=?,require_withdrawal=?,country_rules_enabled=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=1`)
  .run(provider,enabled,levelName,self,managed,investment,transfer,withdrawal,countryRules,req.user.id);
 logActivity(req.user.id,req.user.id,'compliance_policy','KYC and customer eligibility policy updated');
 res.json({ok:true,settings:kycSettings()});
});
app.put('/api/super/compliance/countries',superAdmin,(req,res)=>{
 const incoming=Array.isArray(req.body.rules)?req.body.rules:[];
 if(incoming.length>250)return res.status(400).json({error:'Use no more than 250 country rules.'});
 const clean=[];
 const seen=new Set();
 for(const row of incoming){
  const country=String(row.country||row.country_label||'').trim().replace(/\s+/g,' ').slice(0,120),key=normalizeComplianceCountry(country);
  const status=String(row.status||'allowed').toLowerCase(),reason=String(row.reason||'').trim().slice(0,500);
  if(!country||!key)continue;
  if(!['allowed','review','restricted'].includes(status))return res.status(400).json({error:`Invalid eligibility status for ${country}.`});
  if((status==='review'||status==='restricted')&&reason.length<5)return res.status(400).json({error:`Add a clear reason for ${country}.`});
  if(seen.has(key))return res.status(400).json({error:`Duplicate country rule: ${country}.`});
  seen.add(key);clean.push({country,key,status,reason:reason||null});
 }
 db.transaction(()=>{
  db.prepare('DELETE FROM compliance_country_rules').run();
  const ins=db.prepare('INSERT INTO compliance_country_rules(country_key,country_label,status,reason,updated_by) VALUES(?,?,?,?,?)');
  for(const row of clean)ins.run(row.key,row.country,row.status,row.reason,req.user.id);
 })();
 logActivity(req.user.id,req.user.id,'country_eligibility_rules',`${clean.length} country eligibility rule(s) saved`);
 res.json({ok:true,rules:db.prepare('SELECT id,country_label,status,reason,updated_at FROM compliance_country_rules ORDER BY country_label COLLATE NOCASE').all()});
});
app.put('/api/super/compliance/customer/:userId',superAdmin,(req,res)=>{
 const user=db.prepare("SELECT id,name,username,email,country FROM users WHERE id=? AND role='user'").get(req.params.userId);
 if(!user)return res.status(404).json({error:'Customer not found.'});
 const status=String(req.body.status||'clear').toLowerCase(),reason=String(req.body.reason||'').trim().slice(0,500);
 if(!['clear','manual_review','restricted'].includes(status))return res.status(400).json({error:'Choose Clear, Manual Review, or Restricted.'});
 if(status!=='clear'&&reason.length<5)return res.status(400).json({error:'Enter a clear customer-visible compliance reason.'});
 db.prepare(`INSERT INTO compliance_customer_status(user_id,status,reason,updated_by,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)
   ON CONFLICT(user_id) DO UPDATE SET status=excluded.status,reason=excluded.reason,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`)
   .run(user.id,status,status==='clear'?null:reason,req.user.id);
 logActivity(user.id,req.user.id,'customer_eligibility',`Customer eligibility set to ${status}${reason?' • '+reason:''}`);
 notifyAndEmail(user.id,'security','Account eligibility updated',status==='clear'?'Your account eligibility review is clear. Features remain available according to the current verification policy.':reason,'/kyc.html',{email:false});
 res.json({ok:true,status,reason:status==='clear'?null:reason});
});

// Exchange connector control plane and Stage 18 execution controls.
app.get('/api/super/exchange',superAdmin,(req,res)=>{
 const settings=exchangeSettings(),k=krakenConfig();
 const orders=db.prepare(`SELECT e.*,u.name customer_name,u.username customer_username FROM exchange_orders e LEFT JOIN users u ON u.id=e.user_id ORDER BY e.id DESC LIMIT 80`).all().map(x=>({...exchangeOrderPublic(x),requestKind:x.request_kind,requestId:x.request_id,localReference:x.local_reference,customerName:x.customer_name||x.customer_username||'Customer'}));
 res.set('Cache-Control','no-store');
 res.json({
  settings,implementedProviders:['kraken'],supportedSymbols:['BTC/USD','ETH/USD','USDT/USD'],
  credentials:{apiKey:!!k.apiKey,apiSecret:!!k.apiSecret},
  executionWired:true,orders
 });
});
app.put('/api/super/exchange',superAdmin,(req,res)=>{
 const provider=String(req.body.provider||'kraken').toLowerCase(),enabled=req.body.enabled===true?1:0,quote=String(req.body.defaultQuote||'USD').toUpperCase();
 const mode=String(req.body.executionMode||'disabled').toLowerCase(),emergency=req.body.emergencyStop!==false?1:0;
 const routeSelf=req.body.routeSelfTrade===true?1:0,routeManaged=req.body.routeManagedTrade===true?1:0,maxOrder=Number(req.body.maxOrderUsd);
 if(provider!=='kraken')return res.status(400).json({error:'Kraken is the currently implemented exchange provider. Additional providers can use the same adapter framework later.'});
 if(quote!=='USD')return res.status(400).json({error:'USD is the supported default quote in the current Kraken adapter.'});
 if(!['disabled','validate','live'].includes(mode))return res.status(400).json({error:'Choose Disabled, Validate only, or Live execution mode.'});
 if(!Number.isFinite(maxOrder)||maxOrder<1000||maxOrder>10000000)return res.status(400).json({error:'External max order must be between $1,000 and $10,000,000.'});
 if((enabled||mode!=='disabled')&&!krakenPrivateReady())return res.status(409).json({error:'Add KRAKEN_API_KEY and KRAKEN_API_SECRET before enabling exchange execution.'});
 if(mode==='live'&&String(req.body.liveConfirm||'')!=='ENABLE LIVE')return res.status(409).json({error:'Type ENABLE LIVE to activate live exchange execution.'});
 db.prepare(`UPDATE exchange_settings SET provider=?,enabled=?,default_quote=?,execution_mode=?,emergency_stop=?,route_self_trade=?,route_managed_trade=?,max_order_usd=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=1`)
  .run(provider,enabled,quote,mode,emergency,routeSelf,routeManaged,maxOrder,req.user.id);
 logActivity(req.user.id,req.user.id,'exchange_settings',`Exchange ${provider} • mode ${mode} • emergency stop ${emergency?'ON':'OFF'}`);
 res.json({ok:true,settings:exchangeSettings()});
});
app.post('/api/super/exchange/test',superAdmin,async(req,res)=>{
 try{const adapter=exchangeAdapter(),result=await adapter.test();res.set('Cache-Control','no-store');res.json({ok:true,provider:adapter.provider,...result})}
 catch(e){res.status(502).json({error:e.message||'Exchange connection test failed.'})}
});
app.get('/api/super/exchange/quote',superAdmin,async(req,res)=>{
 try{const adapter=exchangeAdapter(),quote=await adapter.ticker(req.query.symbol||'BTCUSD');res.set('Cache-Control','no-store');res.json({ok:true,provider:adapter.provider,quote})}
 catch(e){res.status(502).json({error:e.message||'Exchange quote test failed.'})}
});
app.post('/api/super/exchange/reconcile',superAdmin,async(req,res)=>{
 const rows=db.prepare(`SELECT * FROM exchange_orders WHERE validation_only=0 AND status IN ('submitting','submitted','open','submission_unknown') ORDER BY id ASC LIMIT 100`).all();
 let updated=0,errors=0;
 for(const row of rows){try{await reconcileExchangeOrder(row);updated++}catch{errors++}}
 res.json({ok:true,checked:rows.length,updated,errors});
});
app.post('/api/super/exchange/cancel-all',superAdmin,async(req,res)=>{
 if(String(req.body.confirm||'')!=='CANCEL ALL')return res.status(409).json({error:'Type CANCEL ALL to cancel all open Kraken orders.'});
 try{
  const result=await exchangeAdapter().cancelAll();
  db.prepare("UPDATE exchange_settings SET emergency_stop=1,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=1").run(req.user.id);
  logActivity(req.user.id,req.user.id,'exchange_cancel_all','Kraken CancelAll requested and emergency stop enabled');
  res.json({ok:true,count:Number(result?.count||0),pending:result?.pending||false,emergencyStop:true});
 }catch(e){res.status(502).json({error:e.message||'Could not cancel open exchange orders.'})}
});


app.get('/api/public/support-contact',(req,res)=>{
 res.set('Cache-Control','no-store');
 res.json({email:configuredSupportEmail()});
});
app.get('/api/public/human-challenge',(req,res)=>{
 const c=makeHumanChallenge();
 res.set('Cache-Control','no-store');
 res.json({challenge:c.token,question:c.question,expiresIn:600});
});
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
function otpPepper(){
 const explicit=String(process.env.OTP_PEPPER||'').trim();
 const sessionSecret=String(process.env.SESSION_SECRET||'').trim();
 return explicit||sessionSecret||'optitrade-development-otp-pepper';
}
function otpCodeHash(purpose,userId,code,context=''){
 return crypto.createHmac('sha256',otpPepper()).update(`${purpose}|${Number(userId)}|${String(context)}|${String(code)}`).digest('hex');
}
function otpCodeMatches(stored,purpose,userId,code,context=''){
 const value=String(stored||''),modern=otpCodeHash(purpose,userId,code,context),legacy=hash(String(code));
 try{
  if(value.length===modern.length&&crypto.timingSafeEqual(Buffer.from(value),Buffer.from(modern)))return true;
  if(value.length===legacy.length&&crypto.timingSafeEqual(Buffer.from(value),Buffer.from(legacy)))return true;
 }catch{}
 return false;
}


function makeHumanChallenge(){
 const mode=crypto.randomInt(0,3);
 let a,b,answer,question;
 if(mode===0){a=crypto.randomInt(2,20);b=crypto.randomInt(2,20);answer=a+b;question=`What is ${a} + ${b}?`;}
 else if(mode===1){a=crypto.randomInt(8,30);b=crypto.randomInt(2,a);answer=a-b;question=`What is ${a} - ${b}?`;}
 else{a=crypto.randomInt(2,10);b=crypto.randomInt(2,10);answer=a*b;question=`What is ${a} × ${b}?`;}
 const token=crypto.randomBytes(24).toString('hex'),challengeHash=hash(token),expiresAt=Date.now()+10*60*1000;
 db.prepare('DELETE FROM human_challenges WHERE expires_at<? OR used=1').run(Date.now()-60000);
 db.prepare('INSERT INTO human_challenges(challenge_hash,answer_hash,question,expires_at,used,created_at) VALUES(?,?,?,?,0,?)')
   .run(challengeHash,hash(String(answer)),question,expiresAt,Date.now());
 return {token,question,expiresAt};
}
function consumeHumanChallenge(token,answer){
 const t=String(token||'').trim(),a=String(answer||'').trim();
 if(!/^[a-f0-9]{48}$/i.test(t)||!/^-?\d+$/.test(a))return {ok:false,error:'Human verification is missing or invalid.'};
 const key=hash(t),row=db.prepare('SELECT * FROM human_challenges WHERE challenge_hash=? AND used=0').get(key);
 if(!row||row.expires_at<Date.now())return {ok:false,error:'Human verification expired. Please solve the new question.'};
 db.prepare('UPDATE human_challenges SET used=1 WHERE challenge_hash=?').run(key);
 return row.answer_hash===hash(a)?{ok:true}:{ok:false,error:'That answer is not correct. Please solve the new question.'};
}
function pinFormat(pin){return /^\d{4}$/.test(String(pin||''))}
function sensitivePinCheck(userId,pin){
 const u=db.prepare('SELECT pin_hash,pin_fail_count,pin_locked_until FROM users WHERE id=?').get(userId);
 if(!u?.pin_hash)return {ok:false,status:428,error:'Set your 4-digit transaction PIN in Security before continuing.',needsPinSetup:true};
 const lockedUntil=Number(u.pin_locked_until||0);
 if(lockedUntil>Date.now()){
   const mins=Math.max(1,Math.ceil((lockedUntil-Date.now())/60000));
   return {ok:false,status:429,error:`Transaction PIN is temporarily locked. Try again in about ${mins} minute${mins===1?'':'s'}.`};
 }
 if(!pinFormat(pin))return {ok:false,status:400,error:'Enter your 4-digit transaction PIN.'};
 if(!bcrypt.compareSync(String(pin),u.pin_hash)){
   const next=Number(u.pin_fail_count||0)+1;
   const lock=next>=5?Date.now()+15*60*1000:0;
   db.prepare('UPDATE users SET pin_fail_count=?,pin_locked_until=? WHERE id=?').run(lock?0:next,lock,userId);
   return {ok:false,status:lock?429:401,error:lock?'Too many incorrect PIN attempts. Transaction PIN is locked for 15 minutes.':`Incorrect transaction PIN. ${Math.max(0,5-next)} attempt${5-next===1?'':'s'} remaining before a temporary lock.`};
 }
 db.prepare('UPDATE users SET pin_fail_count=0,pin_locked_until=0 WHERE id=?').run(userId);
 return {ok:true};
}

function configuredSupportEmail(){
 const e=String(process.env.SUPPORT_EMAIL||'').trim().toLowerCase();
 return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)?e:null;
}
function mailer(){
 const host=(process.env.SMTP_HOST||'').trim();
 const user=(process.env.SMTP_USER||'').trim();
 const pass=(process.env.SMTP_PASS||'').trim();
 if(!host || host==='smtp.example.com' || !user || user==='your-smtp-user' || !pass || pass==='your-smtp-password')return null;
 return nodemailer.createTransport({host,port:+process.env.SMTP_PORT||587,secure:String(process.env.SMTP_SECURE)==='true',auth:{user,pass},connectionTimeout:12000,greetingTimeout:12000,socketTimeout:15000});
}
function emailApiConfig(){
 const provider=String(process.env.EMAIL_PROVIDER||'auto').trim().toLowerCase();
 const apiKey=String(process.env.RESEND_API_KEY||'').trim();
 const from=String(process.env.RESEND_FROM||process.env.MAIL_FROM||'').trim();
 if(['auto','resend'].includes(provider)&&apiKey&&from)return {provider:'resend',apiKey,from};
 return null;
}
function emailRecipientMask(email){
 const parts=String(email||'').trim().toLowerCase().split('@'),local=parts[0]||'',domain=parts[1]||'';
 if(!domain)return 'hidden';
 const left=local.length<=2?(local[0]||'*'):local.slice(0,2);
 return `${left}${'*'.repeat(Math.max(3,Math.min(8,local.length-left.length)))}@${domain}`;
}
function logEmailDelivery({userId=null,category='transactional',email='',provider=null,status='failed',messageId=null,error=null,reference=null}={}){
 try{
  db.prepare(`INSERT INTO email_delivery_logs(user_id,category,recipient_masked,provider,status,provider_message_id,error,reference)
    VALUES(?,?,?,?,?,?,?,?)`).run(
      userId||null,String(category||'transactional').slice(0,80),emailRecipientMask(email),
      provider?String(provider).slice(0,40):null,String(status||'failed').slice(0,40),
      messageId?String(messageId).slice(0,220):null,error?String(error).slice(0,600):null,
      reference?String(reference).slice(0,160):null
    );
 }catch(e){console.error('[EMAIL DELIVERY LOG]',e.message)}
}
async function sendViaEmailApi(email,subject,text,{html=null}={}){
 const cfg=emailApiConfig();
 if(!cfg)return null;
 if(cfg.provider==='resend'){
  const payload={from:cfg.from,to:[email],subject,text,...(configuredSupportEmail()?{reply_to:configuredSupportEmail()}:{})};
  if(html)payload.html=html;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
  let r;
  try{
   r=await fetch('https://api.resend.com/emails',{
    method:'POST',
    headers:{'Authorization':`Bearer ${cfg.apiKey}`,'Content-Type':'application/json'},
    body:JSON.stringify(payload),
    signal:controller.signal
   });
  }finally{clearTimeout(timer)}
  let d={};try{d=await r.json()}catch{}
  if(!r.ok)throw new Error(d.message||d.error||`Email API rejected request (${r.status})`);
  return {dev:false,provider:'resend',accepted:true,id:d.id||null};
 }
 return null;
}
async function sendOutboundEmail(email,subject,text,{html=null,category='transactional',userId=null,reference=null}={}){
 const provider=String(process.env.EMAIL_PROVIDER||'auto').trim().toLowerCase();
 const smtpFallback=String(process.env.EMAIL_SMTP_FALLBACK||'true').trim().toLowerCase()!=='false';
 let apiError=null;
 const recordSuccess=result=>{
  logEmailDelivery({userId,category,email,provider:result.provider,status:result.dev?'dev':'accepted',messageId:result.id||null,reference});
  console.log(`[EMAIL ACCEPTED] category=${String(category||'transactional')} recipient=${emailRecipientMask(email)} provider=${result.provider||'unknown'} message=${result.id||'none'}`);
  return result;
 };
 const recordFailure=(error,providerName=null)=>{
  logEmailDelivery({userId,category,email,provider:providerName||provider,status:'failed',error:error?.message||String(error),reference});
 };
 const trySmtp=async()=>{
  const t=mailer();
  if(!t)return null;
  const msg={from:process.env.MAIL_FROM||process.env.RESEND_FROM,to:email,subject,text,...(configuredSupportEmail()?{replyTo:configuredSupportEmail()}:{})};
  if(html)msg.html=html;
  const info=await t.sendMail(msg);
  return {dev:false,provider:'smtp',accepted:true,id:info?.messageId||null};
 };
 try{
  if(provider==='smtp'){
   const smtp=await trySmtp();
   if(smtp)return recordSuccess(smtp);
  }else{
   try{
    const api=await sendViaEmailApi(email,subject,text,{html});
    if(api)return recordSuccess(api);
   }catch(e){
    apiError=e;
    console.error('[EMAIL API]',e.message);
    if(!smtpFallback||(provider==='resend'&&String(process.env.EMAIL_SMTP_FALLBACK||'true').toLowerCase()==='false')){
     recordFailure(e,'resend');throw e;
    }
   }
   if(provider==='auto'||smtpFallback){
    try{
     const smtp=await trySmtp();
     if(smtp)return recordSuccess(smtp);
    }catch(e){
     const combined=apiError?new Error(`Resend failed: ${apiError.message}; SMTP failed: ${e.message}`):e;
     recordFailure(combined,'smtp');throw combined;
    }
   }
  }
  if(String(process.env.NODE_ENV||'development').toLowerCase()==='production'){
   const e=new Error('No production email transport is configured.');
   recordFailure(e,provider);throw e;
  }
  console.log(`[DEV EMAIL] To: ${email}
Subject: ${subject}
${text}`);
  return recordSuccess({dev:true,provider:'dev',accepted:false,id:null});
 }catch(e){
  // Failures already recorded where possible. Record uncaught configuration/provider failures once.
  const recent=db.prepare(`SELECT id FROM email_delivery_logs WHERE recipient_masked=? AND category=? AND status='failed' ORDER BY id DESC LIMIT 1`).get(emailRecipientMask(email),String(category||'transactional'));
  if(!recent)recordFailure(e,provider);
  throw e;
 }
}

function emailRuntimeStatus(){
 const provider=String(process.env.EMAIL_PROVIDER||'auto').trim().toLowerCase();
 const resendKey=String(process.env.RESEND_API_KEY||'').trim();
 const resendFrom=String(process.env.RESEND_FROM||process.env.MAIL_FROM||'').trim();
 const smtpHost=String(process.env.SMTP_HOST||'').trim();
 const smtpUser=String(process.env.SMTP_USER||'').trim();
 const smtpPass=String(process.env.SMTP_PASS||'').trim();
 const smtpPort=Number(process.env.SMTP_PORT||587);
 const smtpSecure=String(process.env.SMTP_SECURE||'false').trim().toLowerCase()==='true';
 const smtpReady=!!smtpHost && smtpHost!=='smtp.example.com' && !!smtpUser && smtpUser!=='your-smtp-user' && !!smtpPass && smtpPass!=='your-smtp-password';
 const resendReady=!!resendKey && !!resendFrom;
 const fallback=String(process.env.EMAIL_SMTP_FALLBACK||'true').trim().toLowerCase()!=='false';
 const production=String(process.env.NODE_ENV||'development').toLowerCase()==='production';
 return {
   provider:['auto','resend','smtp'].includes(provider)?provider:'auto',
   resendReady,
   smtpReady,
   smtpFallback:fallback,
   resendFrom:resendFrom||null,
   smtpHost:smtpReady?smtpHost:null,
   smtpPort:smtpReady?smtpPort:null,
   smtpSecure:smtpReady?smtpSecure:null,
   mailFrom:String(process.env.MAIL_FROM||process.env.RESEND_FROM||'').trim()||null,
   supportEmail:configuredSupportEmail(),
   production,
   productionReady:production?(resendReady||smtpReady):(resendReady||smtpReady),
   otpPepperDedicated:!!String(process.env.OTP_PEPPER||'').trim(),
   otpPepperAvailable:!!otpPepper()
 };
}

function otpEmailHtml({title,code,intro,warning='Never share this code with anyone.',expiryMinutes=10}){
 const esc=emailHtmlEscape;
 const bodyHtml=`
  <p style="margin:0 0 14px;color:#dfeaf5;font-size:15px;line-height:1.7;">${esc(intro)}</p>
  <div style="letter-spacing:9px;text-align:center;font-size:34px;font-weight:900;background:#06111f;border:1px solid #2f557a;border-radius:16px;padding:18px 10px;margin:16px 0 14px;color:#ffffff;">${esc(code)}</div>
  <p style="margin:0 0 14px;color:#b6c7d8;font-size:14px;line-height:1.7;">This code expires in ${Number(expiryMinutes)} minutes.</p>
  <p style="margin:0;color:#89a8c3;font-size:13px;line-height:1.7;">${esc(warning)}</p>`;
 return optiEmailFrame({
  kind:'security',
  eyebrow:'Security verification',
  title,
  intro:'Use the secure code below to continue in OptiTrade.',
  bodyHtml,
  footerText:'This is an automated OptiTrade security verification message.'
 });
}
async function sendRegistrationOtp(email,code,userId){
 const subject='Your OptiTrade verification code';
 const text=`Your OptiTrade email verification code is ${code}.

It expires in 10 minutes. Never share this code with anyone.

If you requested the code but do not see the email in your inbox, check your Spam or Junk folder.`;
 const html=otpEmailHtml({title:'Verify your email',code,intro:'Use this 6-digit code to finish creating your OptiTrade account.'});
 const r=await sendOutboundEmail(email,subject,text,{html,category:'registration_otp',userId,reference:`registration:${userId}`});
 if(r.dev)console.log(`[DEV REGISTRATION OTP] ${email}: ${code}`);
 return r;
}

db.exec(`CREATE TABLE IF NOT EXISTS otp_test_settings(
 id INTEGER PRIMARY KEY CHECK(id=1),
 enabled INTEGER DEFAULT 0,
 updated_by INTEGER,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS test_otp_codes(
 user_id INTEGER PRIMARY KEY,
 code TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL
);`);
db.prepare('INSERT OR IGNORE INTO otp_test_settings(id,enabled) VALUES(1,0)').run();
if(String(process.env.NODE_ENV||'development').toLowerCase()==='production'){
 db.prepare('UPDATE otp_test_settings SET enabled=0 WHERE id=1').run();
 db.prepare('DELETE FROM test_otp_codes').run();
 db.prepare('DELETE FROM test_password_reset_otp_codes').run();
 console.log('[SECURITY] Testing OTP Mode forced OFF in production.');
}
db.exec(`CREATE TABLE IF NOT EXISTS login_otp_challenges(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 challenge_hash TEXT UNIQUE NOT NULL,
 user_id INTEGER NOT NULL,
 code_hash TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 attempts INTEGER DEFAULT 0,
 resend_count INTEGER DEFAULT 0,
 last_sent_at INTEGER NOT NULL,
 used INTEGER DEFAULT 0,
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_otp_user ON login_otp_challenges(user_id,used,expires_at);
CREATE TABLE IF NOT EXISTS test_login_otp_codes(
 challenge_hash TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL,
 code TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL
);`);
function otpTestModeEnabled(){
 if(String(process.env.NODE_ENV||'development').toLowerCase()==='production')return false;
 return Number(db.prepare('SELECT enabled FROM otp_test_settings WHERE id=1').get()?.enabled||0)===1;
}
function saveTestOtp(userId,code,expiresAt){
 if(!otpTestModeEnabled()){db.prepare('DELETE FROM test_otp_codes WHERE user_id=?').run(userId);return;}
 db.prepare(`INSERT INTO test_otp_codes(user_id,code,expires_at,created_at) VALUES(?,?,?,?)
  ON CONFLICT(user_id) DO UPDATE SET code=excluded.code,expires_at=excluded.expires_at,created_at=excluded.created_at`)
  .run(userId,String(code),Number(expiresAt),Date.now());
}
function saveTestPasswordResetOtp(userId,code,expiresAt){
 if(!otpTestModeEnabled()){db.prepare('DELETE FROM test_password_reset_otp_codes WHERE user_id=?').run(userId);return;}
 db.prepare(`INSERT INTO test_password_reset_otp_codes(user_id,code,expires_at,created_at) VALUES(?,?,?,?)
  ON CONFLICT(user_id) DO UPDATE SET code=excluded.code,expires_at=excluded.expires_at,created_at=excluded.created_at`)
  .run(userId,String(code),Number(expiresAt),Date.now());
}
async function deliverRegistrationOtp(email,code,userId){
 try{return await sendRegistrationOtp(email,code,userId)}catch(e){
  if(otpTestModeEnabled()){
   console.warn('[TEST OTP MODE] Registration email failed; Super Admin can read the temporary test code:',e.message);
   logEmailDelivery({userId,category:'registration_otp',email,provider:'test_mode',status:'test_mode',error:e.message,reference:`registration:${userId}`});
   return {dev:true,provider:'test_mode',accepted:false,id:null};
  }
  throw e;
 }
}

async function sendLoginOtp(email,code,user,challengeHash){
 const support=configuredSupportEmail(),first=String(user?.name||'Trader').trim().split(/\s+/)[0]||'Trader';
 const subject='Your OptiTrade login code';
 const text=`Hello ${first},

Your OptiTrade login verification code is ${code}.

It expires in 10 minutes. Never share this code with anyone.

If you did not try to sign in, change your password and contact OptiTrade Support${support?` at ${support}`:''}.

— OptiTrade Support`;
 const html=otpEmailHtml({title:'Login verification',code,intro:`Hello ${first}. Use this code to complete your OptiTrade sign-in.`,warning:'If you did not try to sign in, change your password and contact Support.'});
 const r=await sendOutboundEmail(email,subject,text,{html,category:'login_otp',userId:user?.id||null,reference:challengeHash?`login:${challengeHash}`:null});
 if(r.dev)console.log(`[DEV LOGIN OTP] ${email}: ${code}`);
 return r;
}
function saveTestLoginOtp(challengeHash,userId,code,expiresAt){
 if(!otpTestModeEnabled()){
  db.prepare('DELETE FROM test_login_otp_codes WHERE challenge_hash=?').run(challengeHash);return;
 }
 db.prepare(`INSERT INTO test_login_otp_codes(challenge_hash,user_id,code,expires_at,created_at)
  VALUES(?,?,?,?,?)
  ON CONFLICT(challenge_hash) DO UPDATE SET code=excluded.code,expires_at=excluded.expires_at,created_at=excluded.created_at`)
  .run(challengeHash,userId,String(code),Number(expiresAt),Date.now());
}
function createLoginChallenge(userId){
 db.prepare('UPDATE login_otp_challenges SET used=1 WHERE user_id=? AND used=0').run(userId);
 const challenge=crypto.randomBytes(32).toString('hex'),challengeHash=hash(challenge),code=String(crypto.randomInt(100000,1000000)),expiresAt=Date.now()+600000,now=Date.now();
 db.prepare(`INSERT INTO login_otp_challenges(challenge_hash,user_id,code_hash,expires_at,attempts,resend_count,last_sent_at,used,created_at)
  VALUES(?,?,?,?,0,0,?,0,?)`).run(challengeHash,userId,otpCodeHash('login',userId,code,challengeHash),expiresAt,now,now);
 saveTestLoginOtp(challengeHash,userId,code,expiresAt);
 return {challenge,challengeHash,code,expiresAt};
}
function maskEmail(email){return emailRecipientMask(email)}

function latestRegistrationOtp(userId){
 return db.prepare('SELECT * FROM otps WHERE user_id=? ORDER BY id DESC LIMIT 1').get(userId);
}
function issueRegistrationOtp(userId,{resend=false}={}){
 const previous=latestRegistrationOtp(userId),now=Date.now();
 if(resend&&previous){
  const last=Number(previous.last_sent_at||previous.created_at||0);
  if(last&&now-last<60000)return {ok:false,reason:'cooldown',retryAfter:Math.max(1,Math.ceil((60000-(now-last))/1000))};
  if(Number(previous.resend_count||0)>=5)return {ok:false,reason:'limit'};
 }
 db.prepare('UPDATE otps SET used=1 WHERE user_id=? AND used=0').run(userId);
 const code=String(crypto.randomInt(100000,1000000)),expiresAt=now+600000,resendCount=resend?Number(previous?.resend_count||0)+1:0;
 const info=db.prepare(`INSERT INTO otps(user_id,code_hash,expires_at,used,attempts,resend_count,last_sent_at,created_at)
  VALUES(?,?,?,0,0,?,?,?)`).run(userId,otpCodeHash('registration',userId,code),expiresAt,resendCount,now,now);
 saveTestOtp(userId,code,expiresAt);
 return {ok:true,id:Number(info.lastInsertRowid),code,expiresAt,resendCount};
}

async function sendPasswordResetOtp(email,code,userId){
 const subject='Your OptiTrade password reset code';
 const text=`Your OptiTrade password reset code is ${code}.

It expires in 10 minutes. If you did not request a password reset, you can ignore this email.

Never share this code with anyone. If you do not see the email in your inbox, check your Spam or Junk folder.`;
 const html=otpEmailHtml({title:'Reset your password',code,intro:'Use this 6-digit code to continue your OptiTrade password reset.',warning:'If you did not request a password reset, you can ignore this message.'});
 const r=await sendOutboundEmail(email,subject,text,{html,category:'password_reset_otp',userId,reference:`reset:${userId}`});
 if(r.dev)console.log(`[DEV PASSWORD RESET OTP] ${email}: ${code}`);
 return r;
}
function issuePasswordResetOtp(userId){
 const now=Date.now(),latest=db.prepare('SELECT * FROM password_reset_otps WHERE user_id=? ORDER BY id DESC LIMIT 1').get(userId);
 const last=Number(latest?.last_sent_at||latest?.created_at||0);
 if(last&&now-last<60000)return {ok:false,reason:'cooldown',retryAfter:Math.max(1,Math.ceil((60000-(now-last))/1000))};
 const windowCount=Number(db.prepare('SELECT COUNT(*) n FROM password_reset_otps WHERE user_id=? AND created_at>?').get(userId,now-30*60*1000)?.n||0);
 if(windowCount>=5)return {ok:false,reason:'limit'};
 db.prepare('UPDATE password_reset_otps SET used=1 WHERE user_id=? AND used=0').run(userId);
 const code=String(crypto.randomInt(100000,1000000)),expiresAt=now+600000,resendCount=Number(latest?.resend_count||0)+1;
 const info=db.prepare(`INSERT INTO password_reset_otps(user_id,code_hash,expires_at,used,attempts,created_at,resend_count,last_sent_at)
  VALUES(?,?,?,0,0,?,?,?)`).run(userId,otpCodeHash('reset',userId,code),expiresAt,now,resendCount,now);
 saveTestPasswordResetOtp(userId,code,expiresAt);
 return {ok:true,id:Number(info.lastInsertRowid),code,expiresAt,resendCount};
}

function sessionFor(userId,res){
 const token=crypto.randomBytes(32).toString('hex'),expiresAt=Date.now()+86400000;
 db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
 db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hash(token),userId,expiresAt);
 res.cookie('ot_session',token,{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:86400000,path:'/'});
}
function auth(req,res,next){
 const t=req.cookies.ot_session;
 if(!t)return res.status(401).json({error:'Login required'});
 const tokenHash=hash(t),s=db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(tokenHash,Date.now());
 if(!s){db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash);res.clearCookie('ot_session',{path:'/'});return res.status(401).json({error:'Session expired'});}
 const user=db.prepare('SELECT id,name,email,username,phone,country,currency,dob,role,email_verified,owner_admin_id,referral_code,admin_active,admin_permissions FROM users WHERE id=?').get(s.user_id);
 if(!user){db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash);res.clearCookie('ot_session',{path:'/'});return res.status(401).json({error:'Account unavailable'});}
 req.user=user;next();
}
function admin(req,res,next){auth(req,res,()=>isStaff(req.user)&&req.user.admin_active!==0?next():res.status(403).json({error:'Admin access required'}));}
function superAdmin(req,res,next){auth(req,res,()=>isSuper(req.user)?next():res.status(403).json({error:'Super Admin required'}));}
app.use('/api/auth/register',(req,res,next)=>{
 const started=Date.now();
 const email=String(req.body?.email||'').trim().toLowerCase();
 const username=String(req.body?.username||'').trim().toLowerCase();
 const mask=email.includes('@')?(email.slice(0,2)+'***@'+email.split('@')[1]):'missing-email';
 console.log(`[REGISTER REQUEST] ${mask} username=${username||'missing'} client=${req.get('X-OptiTrade-Client')||'unknown'}`);
 res.on('finish',()=>console.log(`[REGISTER RESPONSE] status=${res.statusCode} email=${mask} ${Date.now()-started}ms`));
 next();
});
app.post('/api/auth/register',async(req,res)=>{
  try{
    let{name,email,password,username,phone,country,currency,dob,confirmPassword,pin,confirmPin,termsAccepted,referral}=req.body;
    email=(email||'').trim().toLowerCase(); name=(name||'').trim(); username=(username||'').trim().toLowerCase(); phone=(phone||'').trim(); country=(country||'').trim(); currency=(currency||'USD').trim().toUpperCase(); dob=(dob||'').trim();
    if(!/^[a-z0-9_]{3,20}$/.test(username))return res.status(400).json({field:'username',error:'Username must be 3–20 characters using letters, numbers or underscore.'});
    if(name.length<2)return res.status(400).json({field:'name',error:'Please enter your full name.'});
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))return res.status(400).json({field:'email',error:'Please enter a valid email address.'});
    if(!/^\+?[0-9 ()-]{7,20}$/.test(phone))return res.status(400).json({field:'phone',error:'Please enter a valid phone number.'});
    if(!country)return res.status(400).json({field:'country',error:'Please select your country.'});
    if(!['USD','EUR','GBP','NGN'].includes(currency))return res.status(400).json({field:'currency',error:'Please select a supported currency.'});
    if(dob){const d=new Date(dob),now=new Date();let userAge=now.getFullYear()-d.getFullYear();const mm=now.getMonth()-d.getMonth();if(mm<0||(mm===0&&now.getDate()<d.getDate()))userAge--;if(!Number.isFinite(d.getTime())||userAge<18)return res.status(400).json({field:'dob',error:'You must be at least 18 years old to create an account.'});}
    if(!password||password.length<8)return res.status(400).json({field:'password',error:'Password must be at least 8 characters.'});
    if(!/^[A-Z]/.test(password))return res.status(400).json({field:'password',error:'Password must start with a capital letter.'});
    if(password!==confirmPassword)return res.status(400).json({field:'confirmPassword',error:'Passwords do not match.'});
    if(!pinFormat(pin))return res.status(400).json({field:'pin',error:'Create a 4-digit transaction PIN.'});
    if(String(pin)!==String(confirmPin||''))return res.status(400).json({field:'confirmPin',error:'Transaction PINs do not match.'});
    if(termsAccepted!==true)return res.status(400).json({field:'terms',error:'You must accept the Terms and Privacy Policy.'});
    const pinHash=bcrypt.hashSync(String(pin),12);
    const existing=db.prepare('SELECT id,email_verified,username FROM users WHERE email=?').get(email);
    if(existing?.email_verified)return res.status(409).json({error:'This email is already registered. Please log in.',alreadyRegistered:true});
    const usernameOwner=db.prepare('SELECT id FROM users WHERE username=?').get(username);
    if(usernameOwner && (!existing || Number(usernameOwner.id)!==Number(existing.id)))
      return res.status(409).json({field:'username',error:'That trading username is already taken.'});
    if(existing){
      db.prepare(`UPDATE users SET name=?,password_hash=?,username=?,phone=?,country=?,currency=?,dob=?,pin_hash=?,pin_fail_count=0,pin_locked_until=0 WHERE id=?`)
        .run(name,bcrypt.hashSync(password,12),username,phone,country,currency,dob||null,pinHash,existing.id);
      const issued=issueRegistrationOtp(existing.id,{resend:true});
      if(!issued.ok){
       if(issued.reason==='cooldown')return res.status(202).json({ok:true,email,needsVerification:true,emailQueued:false,retryAfter:issued.retryAfter||60,cooldown:issued.retryAfter||60,
        warning:'Your account is waiting for verification. Use the current code, or resend when the countdown finishes.'});
       return res.status(202).json({ok:true,email,needsVerification:true,emailQueued:false,cooldown:60,
        warning:'Your account is waiting for verification. Verification-code resend limit is temporarily active.'});
      }
      try{
       const delivery=await deliverRegistrationOtp(email,issued.code,existing.id);
       console.log(`[REGISTRATION OTP SENT] user=${existing.id} provider=${delivery?.provider||'email'} message=${delivery?.id||'accepted'}`);
       return res.status(202).json({ok:true,email,resent:true,needsVerification:true,emailQueued:true,emailProvider:delivery?.provider||'email',expiresIn:600,cooldown:60});
      }catch(e){
       console.error('[REGISTRATION OTP EMAIL]',e.message);
       return res.status(202).json({ok:true,email,resent:true,needsVerification:true,emailQueued:false,expiresIn:600,cooldown:60,
        warning:'Your account is waiting for verification, but the verification email was not accepted by the email provider. Use Resend after the countdown or check the Admin Email Delivery monitor.'});
      }
    }
    let ownerAdminId=null;
    referral=String(referral||'').trim().toUpperCase();
    if(referral){
      const owner=db.prepare("SELECT id FROM users WHERE referral_code=? AND role='sub_admin' AND admin_active=1").get(referral);
      if(!owner)return res.status(400).json({error:'This admin referral link is invalid or inactive.'});
      ownerAdminId=owner.id;
    }
    const info=db.prepare('INSERT INTO users(name,email,password_hash,username,phone,country,currency,dob,terms_accepted_at,owner_admin_id,pin_hash,pin_fail_count,pin_locked_until) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,0)')
      .run(name,email,bcrypt.hashSync(password,12),username,phone,country,currency,dob||null,new Date().toISOString(),ownerAdminId,pinHash);
    ['USD','BTC','ETH','USDT'].forEach(a=>db.prepare('INSERT INTO balances(user_id,asset,amount) VALUES(?,?,0)').run(info.lastInsertRowid,a));
    seedSectionBalances(info.lastInsertRowid);
    const issued=issueRegistrationOtp(info.lastInsertRowid,{resend:false});
    try{
     const delivery=await deliverRegistrationOtp(email,issued.code,info.lastInsertRowid);
     console.log(`[REGISTRATION OTP SENT] user=${info.lastInsertRowid} provider=${delivery?.provider||'email'} message=${delivery?.id||'accepted'}`);
     return res.status(202).json({ok:true,email,needsVerification:true,emailQueued:true,emailProvider:delivery?.provider||'email',expiresIn:600,cooldown:60});
    }catch(e){
     console.error('[REGISTRATION OTP EMAIL]',e.message);
     return res.status(202).json({ok:true,email,needsVerification:true,emailQueued:false,expiresIn:600,cooldown:60,
      warning:'Account created, but the verification email was not accepted by the email provider. Use Resend after the countdown or check the Admin Email Delivery monitor.'});
    }
  }catch(e){
    console.error('[REGISTER ERROR]',e);
    res.status(500).json({error:'Registration failed on the server. Check the OptiTrade CMD window for details.'});
  }
});
app.post('/api/auth/verify',(req,res)=>{
 const email=String(req.body.email||'').trim().toLowerCase(),code=String(req.body.code||'').trim();
 if(!email||!/^[0-9]{6}$/.test(code))return res.status(400).json({error:'Enter the email and 6-digit verification code.'});
 const u=db.prepare('SELECT * FROM users WHERE lower(email)=?').get(email);
 if(!u)return res.status(404).json({error:'Account not found'});
 if(u.email_verified){sessionFor(u.id,res);return res.json({ok:true,role:u.role,alreadyVerified:true});}
 const o=db.prepare('SELECT * FROM otps WHERE user_id=? AND used=0 ORDER BY id DESC LIMIT 1').get(u.id);
 if(!o||o.expires_at<Date.now()||Number(o.attempts||0)>=5)return res.status(400).json({error:'Invalid or expired code'});
 if(!otpCodeMatches(o.code_hash,'registration',u.id,code)){
  db.prepare('UPDATE otps SET attempts=attempts+1,used=CASE WHEN attempts+1>=5 THEN 1 ELSE used END WHERE id=?').run(o.id);
  return res.status(400).json({error:'Invalid or expired code'});
 }
 db.transaction(()=>{
   db.prepare('UPDATE otps SET used=1 WHERE id=?').run(o.id);
   db.prepare('UPDATE users SET email_verified=1 WHERE id=?').run(u.id);
   db.prepare('DELETE FROM test_otp_codes WHERE user_id=?').run(u.id);
 })();
 deliverWelcomeOnce(u.id);
 const owner=walletOwnerForUser(u);
 if(owner)notifyAdminEvent(owner,'registration','New registration',`${u.name||u.username||'New customer'} (${u.email}) verified a new OptiTrade account.`,'/admin/user-v2.html?id='+u.id);
 sessionFor(u.id,res);
 res.json({ok:true,role:u.role});
});
app.post('/api/auth/resend',async(req,res)=>{
 const email=String(req.body.email||'').trim().toLowerCase();
 const u=db.prepare('SELECT * FROM users WHERE lower(email)=?').get(email);
 if(!u||u.email_verified)return res.json({ok:true,cooldown:60});
 const issued=issueRegistrationOtp(u.id,{resend:true});
 if(!issued.ok){
  if(issued.reason==='cooldown')return res.status(429).json({error:'Please wait before requesting another verification code.',retryAfter:issued.retryAfter||60});
  return res.status(429).json({error:'Too many verification-code requests. Wait before trying again.'});
 }
 try{
  await deliverRegistrationOtp(u.email,issued.code,u.id);
  res.json({ok:true,expiresIn:600,cooldown:60});
 }catch(e){
  console.error('[RESEND OTP]',e.message);
  res.status(503).json({error:'Verification email could not be sent right now. Check Email Delivery settings or try again shortly.'});
 }
});

// Password recovery: generic request response prevents account/email enumeration.
app.post('/api/auth/forgot/request',async(req,res)=>{
 const email=String(req.body.email||'').trim().toLowerCase();
 const generic={ok:true,message:'If an account exists for this email, a password reset code has been sent.',cooldown:60};
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))return res.json(generic);
 const u=db.prepare('SELECT id,email,email_verified FROM users WHERE lower(email)=?').get(email);
 if(!u||!u.email_verified)return res.json(generic);
 const issued=issuePasswordResetOtp(u.id);
 if(!issued.ok)return res.json(generic);
 try{await sendPasswordResetOtp(u.email,issued.code,u.id)}
 catch(e){
  console.error('[PASSWORD RESET EMAIL]',e.message);
  if(otpTestModeEnabled())logEmailDelivery({userId:u.id,category:'password_reset_otp',email:u.email,provider:'test_mode',status:'test_mode',error:e.message,reference:`reset:${u.id}`});
 }
 res.json(generic);
});

app.post('/api/auth/forgot/verify',(req,res)=>{
 const email=String(req.body.email||'').trim().toLowerCase();
 const code=String(req.body.code||'').trim();
 const u=db.prepare('SELECT id,email FROM users WHERE lower(email)=?').get(email);
 if(!u)return res.status(400).json({error:'Invalid or expired reset code.'});
 const o=db.prepare('SELECT * FROM password_reset_otps WHERE user_id=? AND used=0 ORDER BY id DESC LIMIT 1').get(u.id);
 if(!o||o.expires_at<Date.now()||o.attempts>=5)return res.status(400).json({error:'Invalid or expired reset code.'});
 if(!otpCodeMatches(o.code_hash,'reset',u.id,code)){
   db.prepare('UPDATE password_reset_otps SET attempts=attempts+1,used=CASE WHEN attempts+1>=5 THEN 1 ELSE used END WHERE id=?').run(o.id);
   return res.status(400).json({error:'Invalid or expired reset code.'});
 }
 db.prepare('UPDATE password_reset_otps SET used=1 WHERE id=?').run(o.id);
 db.prepare('UPDATE password_reset_sessions SET used=1 WHERE user_id=? AND used=0').run(u.id);
 const token=crypto.randomBytes(32).toString('hex');
 db.prepare('INSERT INTO password_reset_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(hash(token),u.id,Date.now()+900000,Date.now());
 res.cookie('ot_reset',token,{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production',maxAge:900000});
 res.json({ok:true});
});

app.post('/api/auth/forgot/reset',async(req,res)=>{
 const token=req.cookies.ot_reset;
 if(!token)return res.status(401).json({error:'Your password reset session has expired. Request a new code.'});
 const s=db.prepare('SELECT * FROM password_reset_sessions WHERE token_hash=? AND used=0 AND expires_at>?').get(hash(token),Date.now());
 if(!s)return res.status(401).json({error:'Your password reset session has expired. Request a new code.'});
 const password=String(req.body.password||'');
 const confirmPassword=String(req.body.confirmPassword||'');
 if(password.length<8)return res.status(400).json({error:'Password must be at least 8 characters.'});
 if(!/^[A-Z]/.test(password))return res.status(400).json({error:'Password must start with a capital letter.'});
 if(password!==confirmPassword)return res.status(400).json({error:'Passwords do not match.'});
 const u=db.prepare('SELECT id,email,name FROM users WHERE id=?').get(s.user_id);
 if(!u)return res.status(404).json({error:'Account unavailable.'});
 const passwordHash=bcrypt.hashSync(password,12);
 const tx=db.transaction(()=>{
   db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash,u.id);
   db.prepare('UPDATE password_reset_sessions SET used=1 WHERE user_id=?').run(u.id);
   db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
   logActivity(u.id,u.id,'password_reset','Password changed using email recovery');
 });
 tx();
 res.clearCookie('ot_reset',{path:'/'});
 notifyAndEmail(u.id,'security','Password changed','Your OptiTrade password was changed successfully. If you did not make this change, contact OptiTrade Support immediately.','/security.html');
 res.json({ok:true,message:'Password changed successfully. You can now sign in.'});
});

app.post('/api/auth/login',async(req,res)=>{
 const identifier=String(req.body.identifier||req.body.email||'').trim().toLowerCase();
 const password=String(req.body.password||'');
 const u=db.prepare('SELECT * FROM users WHERE lower(email)=? OR lower(username)=?').get(identifier,identifier);
 if(!u||!bcrypt.compareSync(password,u.password_hash))
   return res.status(401).json({error:'Invalid email/username or password'});
 if(!u.email_verified)
   return res.status(403).json({error:'Verify your email first',needsVerification:true,email:u.email});
 if(isStaff(u)&&u.admin_active===0)
   return res.status(403).json({error:'This admin account is inactive.'});
 console.log(`[LOGIN OTP REQUEST] user=${u.id} role=${u.role} recipient=${emailRecipientMask(u.email)}`);
 const c=createLoginChallenge(u.id);
 try{
   const delivery=await sendLoginOtp(u.email,c.code,u,c.challengeHash);
   console.log(`[LOGIN OTP SENT] user=${u.id} role=${u.role} recipient=${emailRecipientMask(u.email)} provider=${delivery?.provider||'unknown'} message=${delivery?.id||'none'}`);
 }catch(e){
   console.error(`[LOGIN OTP FAILED] user=${u.id} role=${u.role} recipient=${emailRecipientMask(u.email)} error=${e.message}`);
   db.prepare('UPDATE login_otp_challenges SET used=1 WHERE challenge_hash=?').run(c.challengeHash);
   db.prepare('DELETE FROM test_login_otp_codes WHERE challenge_hash=?').run(c.challengeHash);
   return res.status(503).json({error:'Your login code could not be sent. Check Email Delivery settings or try again shortly.'});
 }
 res.json({ok:true,requiresOtp:true,challenge:c.challenge,emailMasked:maskEmail(u.email),expiresIn:600});
});

app.post('/api/auth/login/verify',(req,res)=>{
 const challenge=String(req.body.challenge||'').trim(),code=String(req.body.code||'').trim();
 if(!/^[a-f0-9]{64}$/i.test(challenge)||!/^[0-9]{6}$/.test(code))
   return res.status(400).json({error:'Enter the 6-digit login code.'});
 const challengeHash=hash(challenge);
 const c=db.prepare(`SELECT c.*,u.email,u.name,u.role,u.admin_active FROM login_otp_challenges c
   JOIN users u ON u.id=c.user_id WHERE c.challenge_hash=? AND c.used=0`).get(challengeHash);
 if(!c||c.expires_at<Date.now()||c.attempts>=5)
   return res.status(400).json({error:'This login code is invalid or expired. Return to login and try again.'});
 if(!otpCodeMatches(c.code_hash,'login',c.user_id,code,challengeHash)){
   db.prepare('UPDATE login_otp_challenges SET attempts=attempts+1,used=CASE WHEN attempts+1>=5 THEN 1 ELSE used END WHERE id=?').run(c.id);
   return res.status(400).json({error:'Incorrect or expired login code.'});
 }
 if(['admin','super_admin','sub_admin'].includes(c.role)&&c.admin_active===0)
   return res.status(403).json({error:'This admin account is inactive.'});
 db.transaction(()=>{
   db.prepare('UPDATE login_otp_challenges SET used=1 WHERE id=?').run(c.id);
   db.prepare('DELETE FROM test_login_otp_codes WHERE challenge_hash=?').run(challengeHash);
 })();
 sessionFor(c.user_id,res);
 logActivity(c.user_id,c.user_id,'login','Login completed with password + email OTP');
 notifyAndEmail(c.user_id,'security','New login','Your OptiTrade account was signed in using password and email verification. If this was not you, review your security settings.','/security.html');
 res.json({ok:true,role:c.role});
});

app.post('/api/auth/login/resend',async(req,res)=>{
 const challenge=String(req.body.challenge||'').trim();
 if(!/^[a-f0-9]{64}$/i.test(challenge))
   return res.status(400).json({error:'Login verification session is missing. Return to login.'});
 const challengeHash=hash(challenge);
 const c=db.prepare(`SELECT c.*,u.email,u.name,u.role FROM login_otp_challenges c
   JOIN users u ON u.id=c.user_id WHERE c.challenge_hash=? AND c.used=0`).get(challengeHash);
 if(!c||c.expires_at<Date.now())return res.status(400).json({error:'Login verification expired. Return to login.'});
 if(Date.now()-Number(c.last_sent_at||0)<60000)
   return res.status(429).json({error:'Please wait one minute before requesting another code.'});
 if(Number(c.resend_count||0)>=5)
   return res.status(429).json({error:'Too many login code requests. Return to login and start again.'});
 const code=String(crypto.randomInt(100000,1000000)),expiresAt=Date.now()+600000;
 try{
   const delivery=await sendLoginOtp(c.email,code,{...c,id:c.user_id},challengeHash);
   console.log(`[LOGIN OTP RESEND SENT] user=${c.user_id} role=${c.role} recipient=${emailRecipientMask(c.email)} provider=${delivery?.provider||'unknown'} message=${delivery?.id||'none'}`);
 }catch(e){
   console.error(`[LOGIN OTP RESEND FAILED] user=${c.user_id} role=${c.role} recipient=${emailRecipientMask(c.email)} error=${e.message}`);
   return res.status(503).json({error:'Could not resend the login code right now.'});
 }
 db.prepare(`UPDATE login_otp_challenges SET code_hash=?,expires_at=?,attempts=0,resend_count=resend_count+1,last_sent_at=? WHERE id=?`)
   .run(otpCodeHash('login',c.user_id,code,challengeHash),expiresAt,Date.now(),c.id);
 saveTestLoginOtp(challengeHash,c.user_id,code,expiresAt);
 res.json({ok:true,emailMasked:maskEmail(c.email),expiresIn:600,cooldown:60});
});
app.post('/api/auth/logout',auth,(req,res)=>{db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(req.cookies.ot_session));res.clearCookie('ot_session',{path:'/'});res.json({ok:true});});
app.get('/api/me',auth,(req,res)=>{
 seedSectionBalances(req.user.id);
 const balances=db.prepare('SELECT asset,amount FROM balances WHERE user_id=?').all(req.user.id);
 const sectionBalances=db.prepare('SELECT section,asset,amount FROM section_balances WHERE user_id=? ORDER BY section,asset').all(req.user.id);
 const kycProfile=ensureKycProfile(req.user);
 const approvedDepositsUsd=Number(db.prepare(`SELECT COALESCE(SUM(CASE WHEN status='approved' THEN COALESCE(credited_usd,usd_value,0) ELSE 0 END),0) total FROM deposit_requests WHERE user_id=?`).get(req.user.id)?.total||0);
 const approvedWithdrawalsUsd=Number(db.prepare(`SELECT COALESCE(SUM(CASE WHEN status='approved' AND asset='USD' THEN amount ELSE 0 END),0) total FROM withdrawal_requests WHERE user_id=?`).get(req.user.id)?.total||0);
 res.json({
   user:req.user,balances,sectionBalances,
   fundingSummary:{approvedDepositsUsd,approvedWithdrawalsUsd},
   kyc:{status:kycProfile.status||'not_started',enabled:!!kycSettings().enabled}
 });
});
app.get('/api/security/status',auth,(req,res)=>{
 const u=db.prepare('SELECT pin_hash,pin_fail_count,pin_locked_until FROM users WHERE id=?').get(req.user.id);
 res.set('Cache-Control','no-store');
 res.json({hasPin:!!u?.pin_hash,pinLockedUntil:Number(u?.pin_locked_until||0),loginOtp:true});
});
app.post('/api/security/pin',auth,(req,res)=>{
 const currentPassword=String(req.body.currentPassword||''),currentPin=String(req.body.currentPin||''),newPin=String(req.body.newPin||''),confirmPin=String(req.body.confirmPin||'');
 const u=db.prepare('SELECT password_hash,pin_hash FROM users WHERE id=?').get(req.user.id);
 if(!u||!bcrypt.compareSync(currentPassword,u.password_hash))return res.status(401).json({error:'Current password is incorrect.'});
 if(!pinFormat(newPin))return res.status(400).json({error:'New transaction PIN must be exactly 4 digits.'});
 if(newPin!==confirmPin)return res.status(400).json({error:'New transaction PINs do not match.'});
 if(u.pin_hash){const chk=sensitivePinCheck(req.user.id,currentPin);if(!chk.ok)return res.status(chk.status).json(chk);}
 db.prepare('UPDATE users SET pin_hash=?,pin_fail_count=0,pin_locked_until=0 WHERE id=?').run(bcrypt.hashSync(newPin,12),req.user.id);
 logActivity(req.user.id,req.user.id,'pin_changed',u.pin_hash?'Transaction PIN changed':'Transaction PIN created');
 notifyAndEmail(req.user.id,'security','Transaction PIN updated','Your OptiTrade transaction PIN was updated. If you did not make this change, contact support immediately.','/security.html');
 res.json({ok:true,message:u.pin_hash?'Transaction PIN changed successfully.':'Transaction PIN created successfully.'});
});
app.post('/api/security/change-password',auth,(req,res)=>{
 const currentPassword=String(req.body.currentPassword||''),pin=String(req.body.pin||''),newPassword=String(req.body.newPassword||''),confirmPassword=String(req.body.confirmPassword||'');
 const u=db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id);
 if(!u||!bcrypt.compareSync(currentPassword,u.password_hash))return res.status(401).json({error:'Current password is incorrect.'});
 const chk=sensitivePinCheck(req.user.id,pin);if(!chk.ok)return res.status(chk.status).json(chk);
 if(newPassword.length<8)return res.status(400).json({error:'New password must be at least 8 characters.'});
 if(!/^[A-Z]/.test(newPassword))return res.status(400).json({error:'New password must start with a capital letter.'});
 if(newPassword!==confirmPassword)return res.status(400).json({error:'New passwords do not match.'});
 if(bcrypt.compareSync(newPassword,u.password_hash))return res.status(400).json({error:'Choose a new password different from your current password.'});
 const currentTokenHash=hash(String(req.cookies.ot_session||''));
 db.transaction(()=>{
   db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(newPassword,12),req.user.id);
   db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(req.user.id,currentTokenHash);
   logActivity(req.user.id,req.user.id,'password_change','Password changed from Security using transaction PIN');
 })();
 notifyAndEmail(req.user.id,'security','Password changed','Your OptiTrade password was changed from Security. Other active sessions were signed out. If you did not make this change, contact support immediately.','/security.html');
 res.json({ok:true,message:'Password changed successfully. Other active sessions were signed out.'});
});
app.put('/api/profile',auth,(req,res)=>{
 const chk=sensitivePinCheck(req.user.id,String(req.body.pin||''));if(!chk.ok)return res.status(chk.status).json(chk);
 const name=String(req.body.name||'').trim(),phone=String(req.body.phone||'').trim(),country=String(req.body.country||'').trim(),currency=String(req.body.currency||'USD').trim().toUpperCase(),dob=String(req.body.dob||'').trim();
 if(name.length<2||name.length>120)return res.status(400).json({error:'Enter your full name.'});
 if(!/^\+?[0-9 ()-]{7,20}$/.test(phone))return res.status(400).json({error:'Enter a valid phone number including country code.'});
 if(country.length<2||country.length>100)return res.status(400).json({error:'Enter a valid country.'});
 if(!['USD','EUR','GBP','NGN'].includes(currency))return res.status(400).json({error:'Choose a supported preferred currency.'});
 if(dob){const d=new Date(dob),now=new Date();let userAge=now.getFullYear()-d.getFullYear();const mm=now.getMonth()-d.getMonth();if(mm<0||(mm===0&&now.getDate()<d.getDate()))userAge--;if(!Number.isFinite(d.getTime())||userAge<18)return res.status(400).json({error:'Date of birth must show an age of 18 or older.'});}
 db.prepare('UPDATE users SET name=?,phone=?,country=?,currency=?,dob=? WHERE id=?').run(name,phone,country,currency,dob||null,req.user.id);
 logActivity(req.user.id,req.user.id,'profile_update','Personal profile information updated using transaction PIN');
 notifyAndEmail(req.user.id,'security','Profile information updated','Your OptiTrade personal profile information was updated. If you did not make this change, contact support immediately.','/profile.html');
 res.json({ok:true,user:{...req.user,name,phone,country,currency,dob:dob||null}});
});

app.get('/api/auth/session',(req,res)=>{
 const t=req.cookies.ot_session;
 if(!t)return res.json({authenticated:false});
 const s=db.prepare('SELECT user_id,expires_at FROM sessions WHERE token_hash=? AND expires_at>?').get(hash(t),Date.now());
 if(!s)return res.json({authenticated:false});
 const u=db.prepare('SELECT id,role,email_verified FROM users WHERE id=?').get(s.user_id);
 res.json({authenticated:!!u,user:u?{id:u.id,role:u.role,emailVerified:!!u.email_verified}:null});
});
app.get('/api/admin/users',admin,(req,res)=>{const where=scopedUserWhere(req.user,'u');res.json(db.prepare(`SELECT u.id,u.name,u.email,u.username,u.phone,u.country,u.currency,u.email_verified,u.created_at FROM users u WHERE ${where} ORDER BY u.id DESC`).all())});


// External Connections: MetaTrader 5 read-only account data.
// Customer product uses wallet connections only.

// Customer wallet connection API: public connection metadata only.
app.get('/api/integrations/wallet/config',auth,(req,res)=>{
  const projectId=String(process.env.WALLETCONNECT_PROJECT_ID||'').trim();
  res.set('Cache-Control','no-store');
  res.json({projectId:projectId||null,configured:!!projectId});
});
app.post('/api/integrations/wallet/qr',auth,async(req,res)=>{
 const uri=String(req.body?.uri||'').trim();
 if(!uri.startsWith('wc:')||uri.length>4096)return res.status(400).json({error:'Invalid WalletConnect pairing URI.'});
 try{
   const png=await QRCode.toBuffer(uri,{type:'png',width:320,margin:2,errorCorrectionLevel:'M'});
   res.set('Cache-Control','no-store');
   res.type('png').send(png);
 }catch(e){
   console.error('[WALLET QR]',e.message);
   res.status(500).json({error:'Could not generate WalletConnect QR code.'});
 }
});

function normalizeWalletNamespace(v){
 const n=String(v||'eip155').trim().toLowerCase();
 return ['eip155','bip122','solana','tron'].includes(n)?n:null;
}
function validWalletAddress(namespace,address){
 const a=String(address||'').trim();
 if(namespace==='eip155')return /^0x[a-fA-F0-9]{40}$/.test(a);
 if(namespace==='solana')return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
 if(namespace==='tron')return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a);
 if(namespace==='bip122'){
   if(/\s/.test(a)||a.length<20||a.length>100)return false;
   return /^(bc1|tb1|bcrt1)[a-zA-Z0-9]{10,90}$/.test(a)||/^[123mn2][1-9A-HJ-NP-Za-km-z]{20,60}$/.test(a);
 }
 return false;
}
app.get('/api/integrations/wallet/status',auth,(req,res)=>{
  const rows=db.prepare(`SELECT id,address,namespace,chain_id,provider_type,wallet_name,last_seen_at,updated_at
    FROM wallet_public_connections_v2 WHERE user_id=? ORDER BY datetime(updated_at) DESC,id DESC`).all(req.user.id);
  res.set('Cache-Control','no-store');
  res.json({connection:rows[0]||null,connections:rows,count:rows.length});
});
app.put('/api/integrations/wallet/status',auth,(req,res)=>{
  const address=String(req.body.address||'').trim();
  const namespace=normalizeWalletNamespace(req.body.namespace);
  const chainId=String(req.body.chainId||'').trim().slice(0,100);
  const providerType=String(req.body.providerType||'').trim().slice(0,80);
  const walletName=String(req.body.walletName||'Wallet').trim().slice(0,120);
  if(!namespace)return res.status(400).json({error:'Unsupported wallet network namespace.'});
  if(!validWalletAddress(namespace,address))return res.status(400).json({error:'Wallet address format is invalid for this network.'});
  db.prepare(`INSERT INTO wallet_public_connections_v2(user_id,namespace,address,chain_id,provider_type,wallet_name,last_seen_at,updated_at)
    VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    ON CONFLICT(user_id,namespace,address) DO UPDATE SET chain_id=excluded.chain_id,provider_type=excluded.provider_type,
      wallet_name=excluded.wallet_name,last_seen_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP`)
    .run(req.user.id,namespace,address,chainId,providerType,walletName);
  res.json({ok:true});
});
app.delete('/api/integrations/wallet/status',auth,(req,res)=>{
  const namespace=normalizeWalletNamespace(req.query.namespace);
  const address=String(req.query.address||'').trim();
  if(namespace&&address){
    db.prepare('DELETE FROM wallet_public_connections_v2 WHERE user_id=? AND namespace=? AND address=?').run(req.user.id,namespace,address);
  }else{
    db.prepare('DELETE FROM wallet_public_connections_v2 WHERE user_id=?').run(req.user.id);
  }
  res.json({ok:true});
});

app.get('/api/integrations/wallet/native-balance',auth,async(req,res)=>{
 const namespace=normalizeWalletNamespace(req.query.namespace);
 const address=String(req.query.address||'').trim();
 if(!namespace||!validWalletAddress(namespace,address))return res.status(400).json({error:'Invalid wallet address/network.'});
 const owned=db.prepare('SELECT id FROM wallet_public_connections_v2 WHERE user_id=? AND namespace=? AND address=?').get(req.user.id,namespace,address);
 if(!owned)return res.status(403).json({error:'Connect this wallet to OptiTrade first.'});
 if(namespace!=='solana')return res.status(400).json({error:'Server balance lookup is currently used only for Solana.'});
 const rpc=String(process.env.SOLANA_RPC_URL||'https://api.mainnet-beta.solana.com').trim();
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
 try{
   const r=await fetch(rpc,{method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getBalance',params:[address,{commitment:'confirmed'}]}),signal:controller.signal});
   if(!r.ok)throw new Error(`Solana RPC HTTP ${r.status}`);
   const d=await r.json();
   if(d.error)throw new Error(d.error.message||'Solana RPC error');
   const lamports=Number(d.result?.value||0);
   res.set('Cache-Control','no-store');
   res.json({ok:true,namespace,address,symbol:'SOL',amount:lamports/1e9,lamports});
 }catch(e){
   res.status(502).json({error:`Solana balance unavailable: ${String(e.message||e).slice(0,220)}`});
 }finally{clearTimeout(timer)}
});

app.get('/api/integrations/wallet/history',auth,async(req,res)=>{
 const key=String(process.env.ETHERSCAN_API_KEY||'').trim();
 if(!key)return res.json({configured:false,transactions:[],message:'ETHERSCAN_API_KEY is not configured.'});
 const requestedAddress=String(req.query.address||'').trim();
 const saved=requestedAddress
   ? db.prepare("SELECT address,chain_id FROM wallet_public_connections_v2 WHERE user_id=? AND namespace='eip155' AND lower(address)=lower(?)").get(req.user.id,requestedAddress)
   : db.prepare("SELECT address,chain_id FROM wallet_public_connections_v2 WHERE user_id=? AND namespace='eip155' ORDER BY datetime(updated_at) DESC,id DESC LIMIT 1").get(req.user.id);
 if(!saved)return res.status(404).json({error:'Connect a wallet first.'});
 const chainId=Number(req.query.chainId||saved.chain_id);
 const allowed=[1,10,56,137,8453,42161];
 if(!allowed.includes(chainId))return res.status(400).json({error:'Transaction history is not enabled for this network.'});
 if(saved.chain_id && Number(saved.chain_id)!==chainId)return res.status(400).json({error:'Reconnect the wallet on this network before requesting history.'});
 const address=String(saved.address||'').toLowerCase();
 const base='https://api.etherscan.io/v2/api';
 const call=async(action)=>{
   const qs=new URLSearchParams({chainid:String(chainId),module:'account',action,address,startblock:'0',endblock:'9999999999',page:'1',offset:'12',sort:'desc',apikey:key});
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),9000);
   try{
     const r=await fetch(`${base}?${qs}`,{signal:controller.signal});
     if(!r.ok)throw new Error(`History provider HTTP ${r.status}`);
     const d=await r.json();
     if(d.status==='0' && !/no transactions/i.test(String(d.result||d.message||'')))throw new Error(String(d.result||d.message||'History provider error'));
     return Array.isArray(d.result)?d.result:[];
   }finally{clearTimeout(timer)}
 };
 try{
   const [native,erc20]=await Promise.all([call('txlist'),call('tokentx')]);
   const rows=[];
   for(const x of native){
     const value=Number(BigInt(x.value||'0'))/1e18;
     rows.push({kind:'native',hash:x.hash,time:Number(x.timeStamp||0)*1000,from:x.from,to:x.to,direction:String(x.from||'').toLowerCase()===address?'out':'in',symbol:'NATIVE',amount:value,status:x.isError==='1'?'failed':'confirmed'});
   }
   for(const x of erc20){
     const decimals=Math.max(0,Math.min(36,Number(x.tokenDecimal||0)));
     const amount=bigintToNumberUnits(x.value||'0',decimals);
     rows.push({kind:'token',hash:x.hash,time:Number(x.timeStamp||0)*1000,from:x.from,to:x.to,direction:String(x.from||'').toLowerCase()===address?'out':'in',symbol:String(x.tokenSymbol||'TOKEN').slice(0,20),amount,status:x.isError==='1'?'failed':'confirmed'});
   }
   rows.sort((a,b)=>b.time-a.time);
   const unique=[];const seen=new Set();
   for(const r of rows){const k=`${r.hash}:${r.kind}:${r.symbol}:${r.direction}:${r.amount}`;if(!seen.has(k)){seen.add(k);unique.push(r)}if(unique.length>=15)break}
   res.set('Cache-Control','no-store');
   res.json({configured:true,chainId,address,transactions:unique});
 }catch(e){
   res.status(502).json({error:`On-chain history unavailable: ${String(e.message||e).slice(0,240)}`});
 }
});

app.get('/api/support/thread',auth,(req,res)=>{
  const t=ensureWelcome(req.user.id);
  db.prepare('UPDATE support_threads SET unread_user=0 WHERE id=?').run(t.id);
  const messages=db.prepare('SELECT id,sender_role,body,kind,created_at FROM support_messages WHERE thread_id=? ORDER BY id ASC').all(t.id);
  const faqs=supportFaqsForUser(req.user);
  const counts=supportFaqCountsForUser(req.user);
  const welcomeSettings=welcomeSettingsForUser(req.user);
  const welcome=welcomeSettings?.active?{
    title:'Welcome to OptiTrade Support',
    body:renderWelcomeTemplate(welcomeSettings.support_body,req.user)
  }:null;
  res.json({thread:{...t,unread_user:0},messages,faqs,totalFaqs:counts.total,answeredCount:counts.answered,faqScope:counts.scope,welcome});
});
app.get('/api/support/unread',auth,(req,res)=>{
  const t=ensureWelcome(req.user.id);
  res.json({unread:Number(t.unread_user||0)});
});

function answerSupportFaq(req,res,scope,faqId){
  if(!Number.isInteger(faqId)||faqId<1)return res.status(400).json({error:'Quick help topic is invalid.'});
  const expected=supportFaqScopeForUser(req.user);
  if(scope!==expected.scope)return res.status(409).json({error:'Quick help settings changed. Refresh Support to load the current questions.'});
  let faq=null;
  if(scope==='admin')faq=db.prepare('SELECT id,question,answer,active FROM support_faq_admin_items WHERE id=? AND admin_id=?').get(faqId,expected.adminId);
  else faq=db.prepare('SELECT id,question,answer,active FROM support_faqs WHERE id=?').get(faqId);
  if(!faq||!faq.active)return res.status(404).json({error:'That quick help topic is no longer available.'});
  const t=ensureWelcome(req.user.id);
  const alreadyV2=db.prepare('SELECT 1 FROM support_faq_reads_v2 WHERE user_id=? AND scope=? AND faq_key=?').get(req.user.id,scope,faqId);
  const alreadyOld=scope==='global'?db.prepare('SELECT 1 FROM support_faq_reads WHERE user_id=? AND faq_id=?').get(req.user.id,faqId):null;
  const already=alreadyV2||alreadyOld;
  db.transaction(()=>{
    db.prepare("INSERT INTO support_messages(thread_id,sender_role,sender_id,body,kind) VALUES(?,'user',?,?,'faq_question')").run(t.id,req.user.id,faq.question);
    db.prepare("INSERT INTO support_messages(thread_id,sender_role,sender_id,body,kind) VALUES(?,'support',NULL,?,'faq_answer')").run(t.id,faq.answer);
    if(!already)db.prepare('INSERT OR IGNORE INTO support_faq_reads_v2(user_id,scope,faq_key) VALUES(?,?,?)').run(req.user.id,scope,faqId);
    db.prepare("UPDATE support_threads SET status='open',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(t.id);
  })();
  logActivity(req.user.id,req.user.id,'support_quick_help',`${already?'Reopened':'Viewed'} ${scope} quick help: ${faq.question.slice(0,120)}`);
  res.json({ok:true,alreadyAnswered:!!already,question:faq.question,answer:faq.answer,scope});
}
app.post('/api/support/faq/:scope/:id',auth,(req,res)=>{
 const scope=req.params.scope==='admin'?'admin':'global';
 return answerSupportFaq(req,res,scope,Number(req.params.id));
});
app.post('/api/support/faq/:id',auth,(req,res)=>answerSupportFaq(req,res,'global',Number(req.params.id)));

app.post('/api/support/message',auth,(req,res)=>{
  const body=String(req.body.body||'').trim();
  if(body.length<1||body.length>2000)return res.status(400).json({error:'Message must be between 1 and 2000 characters.'});
  const t=ensureWelcome(req.user.id);
  const info=db.prepare("INSERT INTO support_messages(thread_id,sender_role,sender_id,body) VALUES(?,'user',?,?)").run(t.id,req.user.id,body);
  db.prepare("UPDATE support_threads SET unread_admin=unread_admin+1,status='open',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(t.id);
  const supportAdmin=walletOwnerForUser(req.user);
  if(supportAdmin)notifyAdminEvent(supportAdmin,'support','New customer help message',`${req.user.name||req.user.username||'Customer'}: ${body.slice(0,220)}`,'/admin/support.html?thread='+t.id);
  res.json({ok:true,id:info.lastInsertRowid});
});
// Scoped admin support routes are defined later with ownership checks.

app.get('/api/admin/telegram-settings',admin,(req,res)=>{
 const s=db.prepare('SELECT chat_id,bot_username,enabled,events,updated_at FROM telegram_admin_settings WHERE admin_id=?').get(req.user.id);
 res.json({
   configured:!!s,
   chatId:s?.chat_id||'',
   botUsername:s?.bot_username||null,
   enabled:s?!!s.enabled:false,
   events:s?telegramEvents(s.events):['registration','deposit','withdrawal','trade','support','referral_click'],
   updatedAt:s?.updated_at||null
 });
});
app.put('/api/admin/telegram-settings',admin,async(req,res)=>{
 const existing=db.prepare('SELECT * FROM telegram_admin_settings WHERE admin_id=?').get(req.user.id);
 const tokenInput=String(req.body.botToken||'').trim();
 const chatId=String(req.body.chatId||existing?.chat_id||'').trim();
 const enabled=req.body.enabled!==false;
 const allowed=['registration','deposit','withdrawal','trade','support','referral_click'];
 const events=Array.isArray(req.body.events)?req.body.events.filter(x=>allowed.includes(x)):allowed;
 if(!(/^[-]?\d{5,20}$/.test(chatId)||/^@[A-Za-z0-9_]{5,}$/.test(chatId)))return res.status(400).json({error:'Enter a valid Telegram chat ID or @channel username.'});
 let encrypted=existing?.bot_token_enc,botUsername=existing?.bot_username||null;
 if(tokenInput){
   if(!/^\d{5,15}:[A-Za-z0-9_-]{20,}$/.test(tokenInput))return res.status(400).json({error:'That Telegram bot token format does not look valid.'});
   try{
     const bot=await telegramBotRequest(tokenInput,'getMe',{});
     encrypted=encryptTelegramToken(tokenInput);
     botUsername=bot?.username||botUsername;
   }catch(e){return res.status(400).json({error:'Telegram could not verify this bot token: '+e.message})}
 }
 if(!encrypted)return res.status(400).json({error:'Enter your Telegram bot token.'});
 db.prepare(`INSERT INTO telegram_admin_settings(admin_id,bot_token_enc,chat_id,bot_username,enabled,events,updated_at)
   VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP)
   ON CONFLICT(admin_id) DO UPDATE SET bot_token_enc=excluded.bot_token_enc,chat_id=excluded.chat_id,
   bot_username=excluded.bot_username,enabled=excluded.enabled,events=excluded.events,updated_at=CURRENT_TIMESTAMP`)
   .run(req.user.id,encrypted,chatId,botUsername,enabled?1:0,JSON.stringify(events));
 res.json({ok:true,configured:true,botUsername,chatId,enabled,events});
});
app.post('/api/admin/telegram-settings/test',admin,async(req,res)=>{
 const s=db.prepare('SELECT * FROM telegram_admin_settings WHERE admin_id=?').get(req.user.id);
 if(!s)return res.status(400).json({error:'Save Telegram settings first.'});
 try{
   const token=decryptTelegramToken(s.bot_token_enc);
   await telegramBotRequest(token,'sendMessage',{chat_id:s.chat_id,text:`✅ OptiTrade Telegram alerts are connected.\n\nAdmin: ${req.user.name||req.user.username||req.user.email}\nTime: ${new Date().toISOString()}`});
   res.json({ok:true});
 }catch(e){res.status(400).json({error:'Telegram test failed: '+e.message})}
});
app.delete('/api/admin/telegram-settings',admin,(req,res)=>{
 db.prepare('DELETE FROM telegram_admin_settings WHERE admin_id=?').run(req.user.id);
 res.json({ok:true});
});


app.get('/api/admin/email-status',admin,(req,res)=>{
 const provider=String(process.env.EMAIL_PROVIDER||'auto').trim().toLowerCase();
 const resendReady=!!String(process.env.RESEND_API_KEY||'').trim() && !!String(process.env.RESEND_FROM||process.env.MAIL_FROM||'').trim();
 const smtpReady=!!String(process.env.SMTP_HOST||'').trim() && !!String(process.env.SMTP_USER||'').trim() && !!String(process.env.SMTP_PASS||'').trim();
 res.json({
   provider,
   resendReady,
   smtpReady,
   smtpFallback:String(process.env.EMAIL_SMTP_FALLBACK||'true').trim().toLowerCase()!=='false',
   from:String(process.env.RESEND_FROM||process.env.MAIL_FROM||'').trim()||null
 });
});

app.get('/api/super/launch-audit',superAdmin,(req,res)=>{
 try{res.set('Cache-Control','no-store');res.json(launchAuditChecks())}
 catch(e){res.status(500).json({error:e.message||'Launch audit failed.'})}
});
app.get('/api/super/launch-audit/export',superAdmin,(req,res)=>{
 try{
  const audit=launchAuditChecks();
  res.set('Cache-Control','no-store');
  res.set('Content-Type','application/json; charset=utf-8');
  res.set('Content-Disposition',`attachment; filename="optitrade-launch-audit-${new Date().toISOString().slice(0,10)}.json"`);
  res.send(JSON.stringify(audit,null,2));
 }catch(e){res.status(500).json({error:e.message||'Launch audit export failed.'})}
});

app.get('/api/super/readiness',superAdmin,(req,res)=>{
 const email=emailRuntimeStatus();
 const rpcNames=['RPC_ETHEREUM','RPC_BASE','RPC_ARBITRUM','RPC_OPTIMISM','RPC_BSC','RPC_POLYGON'];
 const rpc=Object.fromEntries(rpcNames.map(k=>[k,!!String(process.env[k]||'').trim()]));
 const tg=db.prepare('SELECT COUNT(*) n FROM telegram_admin_settings WHERE enabled=1').get()?.n||0;
 const otp=db.prepare('SELECT enabled FROM otp_test_settings WHERE id=1').get();
 res.set('Cache-Control','no-store');
 res.json({
   environment:String(process.env.NODE_ENV||'development'),
   database:'SQLite',
   databasePersistentPath:dbPath.startsWith('/var/data/')||dbPath==='/var/data/optitrade.db',
   walletConnect:!!String(process.env.WALLETCONNECT_PROJECT_ID||'').trim(),
   etherscanHistory:!!String(process.env.ETHERSCAN_API_KEY||'').trim(),
   rpc,
   email:{mode:email.provider,resendReady:email.resendReady,smtpReady:email.smtpReady,fallback:email.smtpFallback,productionReady:email.productionReady,otpPepperDedicated:email.otpPepperDedicated},
   supportEmail:configuredSupportEmail(),
   loginOtpRequired:true,
   telegramAdmins:Number(tg),
   testingOtp:!!otp?.enabled,
   trustProxy:String(process.env.TRUST_PROXY||'').toLowerCase()==='true',
   compliance:{
     kycEnabled:!!kycSettings().enabled,
     requireSelfTrade:!!kycSettings().require_self_trade,
     requireManagedTrade:!!kycSettings().require_managed_trade,
     requireInvestment:!!kycSettings().require_investment,
     requireInternalTransfer:!!kycSettings().require_internal_transfer,
     requireWithdrawal:!!kycSettings().require_withdrawal,
     countryRulesEnabled:!!kycSettings().country_rules_enabled,
     countryRuleCount:Number(db.prepare('SELECT COUNT(*) n FROM compliance_country_rules').get()?.n||0),
     manualReviewCount:Number(db.prepare("SELECT COUNT(*) n FROM compliance_customer_status WHERE status='manual_review'").get()?.n||0),
     restrictedCustomerCount:Number(db.prepare("SELECT COUNT(*) n FROM compliance_customer_status WHERE status='restricted'").get()?.n||0)
   },
   otpDelivery:{
     registrationFailures24h:Number(db.prepare("SELECT COUNT(*) n FROM email_delivery_logs WHERE category='registration_otp' AND status='failed' AND created_at>=datetime('now','-1 day')").get()?.n||0),
     loginFailures24h:Number(db.prepare("SELECT COUNT(*) n FROM email_delivery_logs WHERE category='login_otp' AND status='failed' AND created_at>=datetime('now','-1 day')").get()?.n||0),
     resetFailures24h:Number(db.prepare("SELECT COUNT(*) n FROM email_delivery_logs WHERE category='password_reset_otp' AND status='failed' AND created_at>=datetime('now','-1 day')").get()?.n||0),
     testingLockedOff:String(process.env.NODE_ENV||'development').toLowerCase()==='production'
   },
   runtimeConfig:{
     supportEmailConfigured:!!configuredSupportEmail(),
     senderConfigured:!!String(process.env.RESEND_FROM||process.env.MAIL_FROM||'').trim(),
     withdrawalDestinationUserSupplied:true,
     customerIdentityHardcoded:false
   },
   kyc:{provider:kycSettings().provider,enabled:!!kycSettings().enabled,credentialsReady:sumsubReady(),webhookReady:!!sumsubConfig().webhookSecret,levelName:kycSettings().level_name},
   exchange:{provider:exchangeSettings().provider,enabled:!!exchangeSettings().enabled,apiKeyReady:!!krakenConfig().apiKey,apiSecretReady:!!krakenConfig().apiSecret,executionWired:true,executionMode:exchangeSettings().execution_mode,emergencyStop:!!exchangeSettings().emergency_stop,routeSelfTrade:!!exchangeSettings().route_self_trade,routeManagedTrade:!!exchangeSettings().route_managed_trade,maxOrderUsd:Number(exchangeSettings().max_order_usd||0)}
 });
});

app.get('/api/super/email-config',superAdmin,(req,res)=>{
 res.set('Cache-Control','no-store');
 res.json(emailRuntimeStatus());
});
app.get('/api/super/email-delivery-monitor',superAdmin,(req,res)=>{
 const limit=Math.max(10,Math.min(100,Number(req.query.limit)||50)),since=new Date(Date.now()-24*60*60*1000).toISOString();
 const rows=db.prepare(`SELECT id,user_id,category,recipient_masked,provider,status,provider_message_id,error,reference,created_at
   FROM email_delivery_logs WHERE category IN ('registration_otp','login_otp','password_reset_otp','email_test')
   ORDER BY id DESC LIMIT ?`).all(limit);
 const categories=['registration_otp','login_otp','password_reset_otp'];
 const health={};
 for(const category of categories){
  const accepted=Number(db.prepare("SELECT COUNT(*) n FROM email_delivery_logs WHERE category=? AND status='accepted' AND created_at>=?").get(category,since)?.n||0);
  const failed=Number(db.prepare("SELECT COUNT(*) n FROM email_delivery_logs WHERE category=? AND status='failed' AND created_at>=?").get(category,since)?.n||0);
  const testMode=Number(db.prepare("SELECT COUNT(*) n FROM email_delivery_logs WHERE category=? AND status='test_mode' AND created_at>=?").get(category,since)?.n||0);
  health[category]={accepted,failed,testMode};
 }
 const latestFailure=db.prepare("SELECT category,recipient_masked,provider,error,created_at FROM email_delivery_logs WHERE status='failed' ORDER BY id DESC LIMIT 1").get()||null;
 res.set('Cache-Control','no-store');res.json({health,rows,latestFailure,windowHours:24});
});


app.get('/api/super/otp-test-mode',superAdmin,(req,res)=>{
 db.prepare('DELETE FROM test_otp_codes WHERE expires_at<=?').run(Date.now());
 db.prepare('DELETE FROM test_login_otp_codes WHERE expires_at<=?').run(Date.now());
 db.prepare('DELETE FROM test_password_reset_otp_codes WHERE expires_at<=?').run(Date.now());
 const production=String(process.env.NODE_ENV||'development').toLowerCase()==='production',enabled=otpTestModeEnabled();
 const pending=enabled?db.prepare(`SELECT t.user_id,t.code,t.expires_at,t.created_at,u.email,u.name,u.username
   FROM test_otp_codes t JOIN users u ON u.id=t.user_id
   WHERE u.email_verified=0 AND t.expires_at>? ORDER BY t.created_at DESC LIMIT 30`).all(Date.now()):[];
 const loginPending=enabled?db.prepare(`SELECT t.user_id,t.code,t.expires_at,t.created_at,u.email,u.name,u.username,u.role
   FROM test_login_otp_codes t JOIN users u ON u.id=t.user_id
   WHERE t.expires_at>? ORDER BY t.created_at DESC LIMIT 30`).all(Date.now()):[];
 const resetPending=enabled?db.prepare(`SELECT t.user_id,t.code,t.expires_at,t.created_at,u.email,u.name,u.username
   FROM test_password_reset_otp_codes t JOIN users u ON u.id=t.user_id
   WHERE t.expires_at>? ORDER BY t.created_at DESC LIMIT 30`).all(Date.now()):[];
 res.set('Cache-Control','no-store');res.json({enabled,production,pending,loginPending,resetPending});
});
app.put('/api/super/otp-test-mode',superAdmin,(req,res)=>{
 if(String(process.env.NODE_ENV||'development').toLowerCase()==='production' && req.body.enabled===true)
   return res.status(403).json({error:'Testing OTP Mode cannot be enabled in production.'});
 const enabled=req.body.enabled===true?1:0;
 db.prepare(`INSERT INTO otp_test_settings(id,enabled,updated_by,updated_at) VALUES(1,?,?,CURRENT_TIMESTAMP)
   ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`).run(enabled,req.user.id);
 if(!enabled){db.prepare('DELETE FROM test_otp_codes').run();db.prepare('DELETE FROM test_login_otp_codes').run();db.prepare('DELETE FROM test_password_reset_otp_codes').run();}
 res.json({ok:true,enabled:!!enabled});
});

app.post('/api/super/email-config/test',superAdmin,async(req,res)=>{
 const to=String(req.body.to||'').trim().toLowerCase();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to))
   return res.status(400).json({error:'Enter a valid test email address.'});
 const status=emailRuntimeStatus();
 if(status.provider==='resend'&&!status.resendReady&&!status.smtpFallback)
   return res.status(400).json({error:'Resend is selected but RESEND_API_KEY / sender is not configured.'});
 if(status.provider==='smtp'&&!status.smtpReady)
   return res.status(400).json({error:'SMTP is selected but SMTP credentials are not configured.'});
 if(status.provider==='auto'&&!status.resendReady&&!status.smtpReady)
   return res.status(400).json({error:'No email transport is configured yet.'});
 try{
   const testText=`This is a test from OptiTrade.

If you received this message, the configured email delivery path accepted the send request.

Mode: ${status.provider}
Time: ${new Date().toISOString()}

— OptiTrade`;
   const testHtml=optiEmailFrame({
     eyebrow:'Email delivery test',
     title:'OptiTrade email delivery test',
     intro:'This confirms that your configured OptiTrade email delivery path is working.',
     bodyHtml:plainTextToEmailHtml(testText),
     buttonText:'Open OptiTrade',
     buttonHref:absoluteOptiUrl('/login.html'),
     footerText:'This message was triggered from the OptiTrade Super Admin email settings.'
   });
   const result=await sendOutboundEmail(
     to,
     'OptiTrade email delivery test',
     testText,
     {html:testHtml,category:'email_test',reference:'admin-email-test'}
   );
   if(result.dev)return res.status(400).json({error:'Email is still in DEV mode. Add Resend or SMTP credentials first.'});
   res.json({ok:true,provider:result.provider,id:result.id||null});
 }catch(e){
   console.error('[EMAIL TEST]',e);
   res.status(502).json({error:e.message||'Email test failed.'});
 }
});

app.post('/api/super/email-config/verify-smtp',superAdmin,async(req,res)=>{
 const status=emailRuntimeStatus();
 if(!status.smtpReady)return res.status(400).json({error:'SMTP credentials are not configured.'});
 try{
   const transport=mailer();
   if(!transport)return res.status(400).json({error:'SMTP is still using placeholder or incomplete credentials.'});
   await transport.verify();
   res.json({ok:true,host:status.smtpHost,port:status.smtpPort,secure:status.smtpSecure});
 }catch(e){
   console.error('[SMTP VERIFY]',e);
   res.status(502).json({error:e.message||'SMTP connection verification failed.'});
 }
});

app.get('/api/notifications',auth,(req,res)=>{const n=db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50').all(req.user.id);res.json({unread:n.filter(x=>!x.is_read).length,notifications:n})});
app.post('/api/notifications/read-all',auth,(req,res)=>{db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(req.user.id);res.json({ok:true})});
app.post('/api/notifications/:id/read',auth,(req,res)=>{db.prepare('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?').run(req.params.id,req.user.id);res.json({ok:true})});
app.get('/api/dashboard/quick-notice',auth,(req,res)=>{
 const latest=db.prepare(`SELECT id,type,title,body,href,is_read,created_at
   FROM notifications WHERE user_id=? AND is_read=0
   ORDER BY CASE type WHEN 'deposit' THEN 0 WHEN 'withdrawal' THEN 1 WHEN 'security' THEN 2 ELSE 3 END,id DESC
   LIMIT 1`).get(req.user.id);
 const unread=Number(db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND is_read=0').get(req.user.id)?.n||0);
 res.set('Cache-Control','no-store');
 res.json({unread,notice:latest||null});
});
app.get('/api/transactions',auth,(req,res)=>res.json(db.prepare('SELECT * FROM demo_transactions WHERE user_id=? ORDER BY id DESC LIMIT 100').all(req.user.id)));
app.get('/api/dashboard/recent-transactions',auth,(req,res)=>{
 const uid=req.user.id,limit=Math.max(1,Math.min(50,Number(req.query.limit)||3)),rows=[];
 const add=(x)=>rows.push(x);
 for(const x of db.prepare(`SELECT reference,type,asset,amount,direction,status,note,created_at FROM demo_transactions WHERE user_id=? ORDER BY id DESC LIMIT 30`).all(uid))
   add({reference:x.reference,kind:'ledger',type:x.type,asset:x.asset,amount:Number(x.amount),direction:x.direction,status:x.status||'completed',note:x.note||'',createdAt:x.created_at});
 try{for(const x of db.prepare(`SELECT reference,asset,amount,status,destination,review_reason,created_at,updated_at FROM withdrawal_requests WHERE user_id=? ORDER BY id DESC LIMIT 20`).all(uid))
   add({reference:x.reference,kind:'withdrawal',type:'withdrawal',asset:x.asset,amount:Number(x.amount),direction:'debit',status:x.status,note:x.review_reason||('Receiver: '+x.destination),createdAt:x.updated_at||x.created_at});}catch{}
 try{for(const x of db.prepare(`SELECT reference,asset,amount,usd_value,credited_usd,status,network,source,review_reason,created_at,reviewed_at FROM deposit_requests WHERE user_id=? ORDER BY id DESC LIMIT 20`).all(uid))
   add({reference:x.reference,kind:'deposit',type:'deposit',asset:x.asset,amount:Number(x.amount),usdValue:x.status==='approved'&&x.credited_usd!=null?Number(x.credited_usd):(x.usd_value==null?null:Number(x.usd_value)),direction:'credit',status:x.status,note:x.review_reason||((x.source==='admin_manual'?'Admin recorded • ':'')+(x.network||'')),createdAt:x.reviewed_at||x.created_at});}catch{}
 try{for(const x of db.prepare(`SELECT reference,pair,side,notional_usd,status,pnl_usd,admin_note,created_at,updated_at FROM paper_trade_orders WHERE user_id=? ORDER BY id DESC LIMIT 20`).all(uid))
   add({reference:x.reference,kind:'trade',type:'self_trade',asset:'USD',amount:Number(x.notional_usd),direction:'debit',status:x.status,pnl:x.pnl_usd==null?null:Number(x.pnl_usd),note:(x.side||'').toUpperCase()+' '+(x.pair||'')+(x.admin_note?' • '+x.admin_note:''),createdAt:x.updated_at||x.created_at});}catch{}
 try{for(const x of db.prepare(`SELECT reference,amount,status,pnl_amount,traded_symbol,preferred_symbol,market_preference,admin_note,created_at,updated_at FROM managed_trade_requests WHERE user_id=? ORDER BY id DESC LIMIT 20`).all(uid))
   add({reference:x.reference,kind:'managed_trade',type:'managed_trade',asset:'USD',amount:Number(x.amount),direction:'debit',status:x.status,pnl:x.pnl_amount==null?null:Number(x.pnl_amount),note:(x.traded_symbol||x.preferred_symbol||x.market_preference||'Trade with OptiTrade')+(x.admin_note?' • '+x.admin_note:''),createdAt:x.updated_at||x.created_at});}catch{}
 try{for(const x of db.prepare(`SELECT reference,plan_name,source_asset,source_amount,status,current_result_usd,final_result_usd,admin_note,rejection_reason,created_at,updated_at,settled_at FROM investment_plan_requests WHERE user_id=? ORDER BY id DESC LIMIT 20`).all(uid))
   add({reference:x.reference,kind:'investment',type:'investment_plan',asset:x.source_asset,amount:Number(x.source_amount),direction:x.status==='settled'?'credit':'debit',status:x.status,pnl:x.status==='settled'?(x.final_result_usd==null?null:Number(x.final_result_usd)):(x.current_result_usd==null?null:Number(x.current_result_usd)),note:(x.plan_name||'Investment Plan')+(x.rejection_reason?' • '+x.rejection_reason:(x.admin_note?' • '+x.admin_note:'')),createdAt:x.settled_at||x.updated_at||x.created_at});}catch{}
 // Prefer the business request row over its initial reserve ledger row. Settlement/adjustment ledger rows remain distinct.
 const requestRefs=new Set(rows.filter(x=>x.kind!=='ledger').map(x=>x.reference));
 const cleaned=rows.filter(x=>!(x.kind==='ledger'&&requestRefs.has(x.reference)&&['trade_reserve','managed_trade_reserve','investment_reserve','withdrawal','approved_deposit','manual_crypto_deposit'].includes(x.type)));
 cleaned.sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
 res.json({transactions:cleaned.slice(0,limit)});
});
app.get('/api/activity',auth,(req,res)=>{const rows=db.prepare('SELECT id,type,summary,created_at FROM account_activity WHERE user_id=? ORDER BY id DESC LIMIT 100').all(req.user.id);res.json({activity:rows})});



// Super Admin-managed dashboard banners / announcements / genuine testimonials.
db.exec(`CREATE TABLE IF NOT EXISTS banners(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 title TEXT NOT NULL,
 body TEXT NOT NULL,
 kind TEXT DEFAULT 'info',
 image_url TEXT,
 button_text TEXT,
 button_url TEXT,
 audience_type TEXT DEFAULT 'all',
 audience_admin_id INTEGER,
 active INTEGER DEFAULT 1,
 starts_at TEXT,
 ends_at TEXT,
 sort_order INTEGER DEFAULT 0,
 is_testimonial INTEGER DEFAULT 0,
 attribution TEXT,
 consent_confirmed INTEGER DEFAULT 0,
 created_by INTEGER,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);`);
db.exec(`CREATE TABLE IF NOT EXISTS banner_settings(
 id INTEGER PRIMARY KEY CHECK(id=1),
 rotation_seconds INTEGER NOT NULL DEFAULT 3,
 notification_hours INTEGER NOT NULL DEFAULT 24,
 updated_by INTEGER,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);`);
db.exec(`CREATE TABLE IF NOT EXISTS banner_admin_overrides(
 banner_id INTEGER NOT NULL,
 admin_id INTEGER NOT NULL,
 title TEXT NOT NULL,
 body TEXT NOT NULL,
 kind TEXT DEFAULT 'info',
 image_url TEXT,
 button_text TEXT,
 button_url TEXT,
 active INTEGER DEFAULT 1,
 ends_at TEXT,
 sort_order INTEGER DEFAULT 0,
 is_testimonial INTEGER DEFAULT 0,
 attribution TEXT,
 consent_confirmed INTEGER DEFAULT 0,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(banner_id,admin_id)
);
CREATE TABLE IF NOT EXISTS banner_admin_settings(
 admin_id INTEGER PRIMARY KEY,
 rotation_seconds INTEGER NOT NULL DEFAULT 3,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);`);

db.prepare('INSERT OR IGNORE INTO banner_settings(id,rotation_seconds) VALUES(1,3)').run();
const bannerSettingColumns=db.prepare('PRAGMA table_info(banner_settings)').all().map(c=>c.name);
if(!bannerSettingColumns.includes('notification_hours')) db.exec("ALTER TABLE banner_settings ADD COLUMN notification_hours INTEGER NOT NULL DEFAULT 24");
db.prepare("UPDATE banner_settings SET notification_hours=24 WHERE notification_hours IS NULL OR notification_hours NOT IN (12,24)").run();

// Give a fresh installation one safe, editable information banner.
// Existing installations with any banner records are left untouched.
try{
 const bannerCount=db.prepare('SELECT COUNT(*) n FROM banners').get().n;
 if(!bannerCount){
   const sa=db.prepare("SELECT id FROM users WHERE role='super_admin' ORDER BY id LIMIT 1").get();
   db.prepare(`INSERT INTO banners(
     title,body,kind,button_text,button_url,audience_type,active,sort_order,created_by
   ) VALUES(?,?,?,?,?,'all',1,0,?)`).run(
     'Welcome to OptiTrade',
     'Explore reference market data, trading tools and your latest account activity from one dashboard.',
     'info',
     'Explore Markets',
     '/markets.html',
     sa?.id||null
   );
 }
}catch(e){console.warn('[BANNER SEED]',e.message)}


function cleanBannerUrl(value,{allowRelative=true}={}){
 const v=String(value||'').trim();
 if(!v)return null;
 if(allowRelative && v.startsWith('/') && !v.startsWith('//'))return v;
 try{
   const u=new URL(v);
   return ['http:','https:'].includes(u.protocol)?u.toString():null;
 }catch{return null}
}
function bannerAudienceWhere(user){
 // Banners are controlled only by Super Admin and are global for all customers.
 return {sql:"b.audience_type='all'",args:[]};
}
function effectiveBannersForUser(user){
 const now=new Date().toISOString();
 return db.prepare(`SELECT b.* FROM banners b WHERE b.audience_type='all' ORDER BY b.sort_order ASC,b.id DESC`).all()
   .filter(b=>Number(b.active||0)===1
     && (!b.starts_at||Date.parse(b.starts_at)<=Date.now())
     && (!b.ends_at||Date.parse(b.ends_at)>=Date.now()))
   .map(b=>({...b,scope:'global'}))
   .sort((a,b)=>Number(a.sort_order||0)-Number(b.sort_order||0)||Number(b.id)-Number(a.id));
}
function bannerRotationForUser(user){
 return Number(db.prepare('SELECT rotation_seconds FROM banner_settings WHERE id=1').get()?.rotation_seconds||3);
}
function bannerNotificationHours(){
 const n=Number(db.prepare('SELECT notification_hours FROM banner_settings WHERE id=1').get()?.notification_hours||24);
 return n===12?12:24;
}
function recentNotificationBannerRows(user){
 const hours=bannerNotificationHours();
 const cutoff=new Date(Date.now()-hours*60*60*1000).toISOString().slice(0,19).replace('T',' ');
 const rows=db.prepare(`SELECT id,type,title,body,href,is_read,created_at
   FROM notifications WHERE user_id=? AND created_at>=?
   ORDER BY id DESC LIMIT 5`).all(user.id,cutoff);
 return rows.map(n=>({
   id:`notification-${n.id}`,
   source:'notification',
   notification_id:n.id,
   title:n.title,
   body:n.body,
   kind:String(n.type||'account').toLowerCase(),
   image_url:null,
   button_text:'View Update',
   button_url:n.href||'/activity.html',
   is_testimonial:0,
   attribution:null,
   notification_created_at:n.created_at,
   notification_is_read:Number(n.is_read||0)
 }));
}

app.get('/api/banners',auth,(req,res)=>{
 res.set('Cache-Control','no-store');
 const managed=effectiveBannersForUser(req.user).map(b=>({id:b.id,source:'managed',title:b.title,body:b.body,kind:b.kind,image_url:b.image_url,button_text:b.button_text,button_url:b.button_url,is_testimonial:b.is_testimonial,attribution:b.attribution}));
 const notices=recentNotificationBannerRows(req.user);
 // Recent account notices join the same rotating carousel as welcome/testimonial/admin banners.
 // They leave the carousel after 12/24 hours but remain in the normal notification history.
 const rows=[...notices,...managed];
 res.json({banners:rows,count:rows.length,rotationSeconds:bannerRotationForUser(req.user),notificationHours:bannerNotificationHours()});
});


function bannerVisibleToAdmin(actor,b){
 if(isSuper(actor)||actor.role==='admin')return true;
 return actor.role==='sub_admin'&&(b.audience_type==='all'||(b.audience_type==='admin'&&Number(b.audience_admin_id)===Number(actor.id)));
}
function bannerManagerRows(actor){
 if(isSuper(actor)){
   return db.prepare(`SELECT b.*,u.name audience_admin_name,'global' effective_scope,0 has_override
     FROM banners b LEFT JOIN users u ON u.id=b.audience_admin_id ORDER BY b.sort_order ASC,b.id DESC`).all();
 }
 return db.prepare(`SELECT b.*,NULL audience_admin_name,'global_readonly' effective_scope,0 has_override
   FROM banners b WHERE b.audience_type='all' ORDER BY b.sort_order ASC,b.id DESC`).all();
}
app.get('/api/admin/banner-manager',admin,(req,res)=>{
 const row=db.prepare('SELECT rotation_seconds,notification_hours FROM banner_settings WHERE id=1').get()||{};
 const settingsGlobal=Number(row.rotation_seconds||3),notificationHours=Number(row.notification_hours)===12?12:24;
 res.set('Cache-Control','no-store');
 res.json({role:req.user.role,canManageGlobal:isSuper(req.user),banners:bannerManagerRows(req.user),settings:{rotation_seconds:settingsGlobal,global_rotation_seconds:settingsGlobal,notification_hours:notificationHours,is_override:false}});
});
app.put('/api/admin/banner-manager/settings',superAdmin,(req,res)=>{
 const seconds=Math.round(Number(req.body.rotationSeconds)),notificationHours=Math.round(Number(req.body.notificationHours||24));
 if(!Number.isFinite(seconds)||seconds<1||seconds>60)return res.status(400).json({error:'Banner rotation timer must be between 1 and 60 seconds.'});
 if(![12,24].includes(notificationHours))return res.status(400).json({error:'Notification banner lifetime must be 12 or 24 hours.'});
 db.prepare(`INSERT INTO banner_settings(id,rotation_seconds,notification_hours,updated_by,updated_at) VALUES(1,?,?,?,CURRENT_TIMESTAMP)
   ON CONFLICT(id) DO UPDATE SET rotation_seconds=excluded.rotation_seconds,notification_hours=excluded.notification_hours,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`).run(seconds,notificationHours,req.user.id);
 res.json({ok:true,rotationSeconds:seconds,notificationHours,scope:'global'});
});
app.delete('/api/admin/banner-manager/settings',superAdmin,(req,res)=>{
 res.status(405).json({error:'The banner timer is global and controlled only by Super Admin.'});
});
function cleanAdminBannerPayload(body,current={}){
 const title=String(body.title??current.title??'').trim().slice(0,140),message=String(body.body??current.body??'').trim().slice(0,1200);
 const kind=['content','info','announcement','security','market','promotion','education','testimonial'].includes(body.kind)?body.kind:(current.kind||'info');
 const imageRaw=body.imageUrl??current.image_url??'',imageUrl=cleanBannerUrl(imageRaw,{allowRelative:true});
 const buttonText=String(body.buttonText??current.button_text??'').trim().slice(0,60)||null,buttonRaw=body.buttonUrl??current.button_url??'',buttonUrl=cleanBannerUrl(buttonRaw,{allowRelative:true});
 const endsAt=String(body.endsAt??current.ends_at??'').trim()||null,sortOrder=Math.max(-9999,Math.min(9999,Number(body.sortOrder??current.sort_order)||0));
 const active=body.active===undefined?Number(current.active??1):(body.active===false?0:1),isTestimonial=kind==='testimonial'?1:0;
 const attribution=String(body.attribution??current.attribution??'').trim().slice(0,160)||null,consentConfirmed=body.consentConfirmed===undefined?Number(current.consent_confirmed||0):(body.consentConfirmed?1:0);
 if(title.length<2||message.length<4)throw new Error('Enter a banner title and message.');
 if(imageRaw&&!imageUrl)throw new Error('Image URL must be an HTTPS/HTTP URL or an internal /path.');
 if(buttonRaw&&!buttonUrl)throw new Error('Button link must be an HTTPS/HTTP URL or an internal /path.');
 if(buttonText&&!buttonUrl)throw new Error('Add a button link or remove the button text.');
 if(endsAt&&!Number.isFinite(Date.parse(endsAt)))throw new Error('Choose a valid optional banner end date.');
 if(isTestimonial&&(!attribution||!consentConfirmed))throw new Error('Testimonials require attribution and confirmation that permission was obtained.');
 return {title,body:message,kind,imageUrl,buttonText,buttonUrl,endsAt,sortOrder,active,isTestimonial,attribution,consentConfirmed};
}
app.post('/api/admin/banner-manager',superAdmin,(req,res)=>{
 let p;try{p=cleanAdminBannerPayload(req.body)}catch(e){return res.status(400).json({error:e.message})}
 const info=db.prepare(`INSERT INTO banners(title,body,kind,image_url,button_text,button_url,audience_type,audience_admin_id,active,starts_at,ends_at,sort_order,is_testimonial,attribution,consent_confirmed,created_by) VALUES(?,?,?,?,?,?,'all',NULL,?,NULL,?,?,?,?,?,?)`)
   .run(p.title,p.body,p.kind,p.imageUrl,p.buttonText,p.buttonUrl,p.active,p.endsAt,p.sortOrder,p.isTestimonial,p.attribution,p.consentConfirmed,req.user.id);
 res.json({ok:true,id:Number(info.lastInsertRowid),scope:'global'});
});
app.put('/api/admin/banner-manager/:id',superAdmin,(req,res)=>{
 const b=db.prepare('SELECT * FROM banners WHERE id=?').get(req.params.id);if(!b)return res.status(404).json({error:'Banner not found.'});
 if(!bannerVisibleToAdmin(req.user,b))return res.status(403).json({error:'Banner is outside your customer scope.'});
 let p;try{p=cleanAdminBannerPayload(req.body,b)}catch(e){return res.status(400).json({error:e.message})}
 db.prepare(`UPDATE banners SET title=?,body=?,kind=?,image_url=?,button_text=?,button_url=?,active=?,ends_at=?,sort_order=?,is_testimonial=?,attribution=?,consent_confirmed=?,audience_type='all',audience_admin_id=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
   .run(p.title,p.body,p.kind,p.imageUrl,p.buttonText,p.buttonUrl,p.active,p.endsAt,p.sortOrder,p.isTestimonial,p.attribution,p.consentConfirmed,b.id);
 db.prepare('DELETE FROM banner_admin_overrides WHERE banner_id=?').run(b.id);
 res.json({ok:true,scope:'global'});
});
app.delete('/api/admin/banner-manager/:id',superAdmin,(req,res)=>{
 const b=db.prepare('SELECT * FROM banners WHERE id=?').get(req.params.id);if(!b)return res.status(404).json({error:'Banner not found.'});
 db.prepare('DELETE FROM banner_admin_overrides WHERE banner_id=?').run(b.id);
 db.prepare('DELETE FROM banners WHERE id=?').run(b.id);
 res.json({ok:true,deleted:'global'});
});
app.post('/api/admin/banner-manager/:id/reset',superAdmin,(req,res)=>{
 res.status(405).json({error:'Banner overrides are disabled. Banners are controlled only by Super Admin.'});
});

app.get('/api/super/banners',superAdmin,(req,res)=>{
 res.set('Cache-Control','no-store');
 const rows=db.prepare(`SELECT b.*,u.name audience_admin_name
 FROM banners b
 LEFT JOIN users u ON u.id=b.audience_admin_id
 ORDER BY b.sort_order ASC,b.id DESC`).all();
 const admins=db.prepare("SELECT id,name,username FROM users WHERE role='sub_admin' AND admin_active=1 ORDER BY name COLLATE NOCASE").all();
 const settings=db.prepare('SELECT rotation_seconds,updated_at FROM banner_settings WHERE id=1').get()||{rotation_seconds:3,updated_at:null};
 res.json({banners:rows,admins,settings});
});


// Admin dashboard banner summary. Super Admin sees all platform banners.
// Sub-Admins can see only a read-only summary of banners that can reach their customers.
app.get('/api/admin/banner-summary',admin,(req,res)=>{
 const now=new Date().toISOString();
 let rows=[];
 if(isSuper(req.user)||req.user.role==='admin'){
   rows=db.prepare(`SELECT b.id,b.title,b.kind,b.active,b.audience_type,b.audience_admin_id,b.starts_at,b.ends_at,b.sort_order,
     u.name audience_admin_name
     FROM banners b LEFT JOIN users u ON u.id=b.audience_admin_id
     ORDER BY b.sort_order ASC,b.id DESC`).all();
 }else{
   rows=bannerManagerRows(req.user).map(b=>({
     id:b.id,title:b.title,kind:b.kind,active:b.active,audience_type:b.audience_type,audience_admin_id:b.audience_admin_id,
     starts_at:b.starts_at,ends_at:b.ends_at,sort_order:b.sort_order,audience_admin_name:b.audience_admin_name,
     effective_scope:b.effective_scope,has_override:b.has_override
   }));
 }
 const isLive=b=>!!b.active
   && (!b.starts_at||Date.parse(b.starts_at)<=Date.now())
   && (!b.ends_at||Date.parse(b.ends_at)>=Date.now());
 const active=rows.filter(isLive);
 const scheduled=rows.filter(b=>!!b.active && b.starts_at && Date.parse(b.starts_at)>Date.now());
 const inactive=rows.filter(b=>!b.active || (b.ends_at && Date.parse(b.ends_at)<Date.now()));
 res.json({
   role:req.user.role,
   canManage:isSuper(req.user),
   counts:{total:rows.length,active:active.length,scheduled:scheduled.length,inactive:inactive.length},
   active:active.slice(0,6).map(b=>({
     id:b.id,title:b.title,kind:b.kind,audienceType:b.audience_type,
     audienceAdminName:b.audience_admin_name||null,startsAt:b.starts_at,endsAt:b.ends_at
   }))
 });
});

app.put('/api/super/banner-settings',superAdmin,(req,res)=>{
 const seconds=Math.round(Number(req.body.rotationSeconds));
 if(!Number.isFinite(seconds)||seconds<1||seconds>60)
   return res.status(400).json({error:'Banner rotation timer must be between 1 and 60 seconds.'});
 db.prepare(`INSERT INTO banner_settings(id,rotation_seconds,updated_by,updated_at)
   VALUES(1,?,?,CURRENT_TIMESTAMP)
   ON CONFLICT(id) DO UPDATE SET rotation_seconds=excluded.rotation_seconds,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`)
   .run(seconds,req.user.id);
 res.json({ok:true,rotationSeconds:seconds});
});

app.post('/api/super/banners',superAdmin,(req,res)=>{
 const title=String(req.body.title||'').trim().slice(0,140);
 const body=String(req.body.body||'').trim().slice(0,1200);
 const kind=['content','info','announcement','security','market','promotion','education','testimonial'].includes(req.body.kind)?req.body.kind:'info';
 const imageUrl=cleanBannerUrl(req.body.imageUrl,{allowRelative:true});
 const buttonText=String(req.body.buttonText||'').trim().slice(0,60)||null;
 const buttonUrl=cleanBannerUrl(req.body.buttonUrl,{allowRelative:true});
 const audienceType=req.body.audienceType==='admin'?'admin':'all';
 const audienceAdminId=audienceType==='admin'?Number(req.body.audienceAdminId)||null:null;
 const startsAt=null; // banners start immediately
 const endsAt=String(req.body.endsAt||'').trim()||null;
 const sortOrder=Math.max(-9999,Math.min(9999,Number(req.body.sortOrder)||0));
 const active=req.body.active===false?0:1;
 const isTestimonial=kind==='testimonial'?1:0;
 const attribution=String(req.body.attribution||'').trim().slice(0,160)||null;
 const consentConfirmed=req.body.consentConfirmed?1:0;
 if(title.length<2||body.length<4)return res.status(400).json({error:'Enter a banner title and message.'});
 if(req.body.imageUrl && !imageUrl)return res.status(400).json({error:'Image URL must be an HTTPS/HTTP URL or an internal /path.'});
 if(req.body.buttonUrl && !buttonUrl)return res.status(400).json({error:'Button link must be an HTTPS/HTTP URL or an internal /path.'});
 if(buttonText && !buttonUrl)return res.status(400).json({error:'Add a button link or remove the button text.'});
 if(audienceType==='admin'){
   const a=db.prepare("SELECT id FROM users WHERE id=? AND role='sub_admin' AND admin_active=1").get(audienceAdminId);
   if(!a)return res.status(400).json({error:'Choose an active Sub-Admin audience.'});
 }
 if(endsAt&&!Number.isFinite(Date.parse(endsAt)))return res.status(400).json({error:'Choose a valid optional banner end date.'});
 if(isTestimonial && (!attribution||!consentConfirmed))return res.status(400).json({error:'Testimonials require attribution and confirmation that permission was obtained.'});
 const info=db.prepare(`INSERT INTO banners(title,body,kind,image_url,button_text,button_url,audience_type,audience_admin_id,active,starts_at,ends_at,sort_order,is_testimonial,attribution,consent_confirmed,created_by)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(title,body,kind,imageUrl,buttonText,buttonUrl,audienceType,audienceAdminId,active,startsAt,endsAt,sortOrder,isTestimonial,attribution,consentConfirmed,req.user.id);
 res.json({ok:true,id:info.lastInsertRowid});
});

app.put('/api/super/banners/:id',superAdmin,(req,res)=>{
 const current=db.prepare('SELECT * FROM banners WHERE id=?').get(req.params.id);
 if(!current)return res.status(404).json({error:'Banner not found.'});
 const title=String(req.body.title??current.title).trim().slice(0,140);
 const body=String(req.body.body??current.body).trim().slice(0,1200);
 const kind=['content','info','announcement','security','market','promotion','education','testimonial'].includes(req.body.kind)?req.body.kind:current.kind;
 const imageRaw=req.body.imageUrl??current.image_url;
 const imageUrl=cleanBannerUrl(imageRaw,{allowRelative:true});
 const buttonText=String(req.body.buttonText??current.button_text??'').trim().slice(0,60)||null;
 const buttonRaw=req.body.buttonUrl??current.button_url;
 const buttonUrl=cleanBannerUrl(buttonRaw,{allowRelative:true});
 const audienceType=(req.body.audienceType??current.audience_type)==='admin'?'admin':'all';
 const audienceAdminId=audienceType==='admin'?Number(req.body.audienceAdminId??current.audience_admin_id)||null:null;
 const startsAt=null; // editing/publishing starts immediately
 const endsAt=String(req.body.endsAt??current.ends_at??'').trim()||null;
 const sortOrder=Math.max(-9999,Math.min(9999,Number(req.body.sortOrder??current.sort_order)||0));
 const active=req.body.active===undefined?Number(current.active||0):(req.body.active===false?0:1);
 const isTestimonial=kind==='testimonial'?1:0;
 const attribution=String(req.body.attribution??current.attribution??'').trim().slice(0,160)||null;
 const consentConfirmed=req.body.consentConfirmed===undefined?Number(current.consent_confirmed||0):(req.body.consentConfirmed?1:0);
 if(title.length<2||body.length<4)return res.status(400).json({error:'Enter a banner title and message.'});
 if(imageRaw && !imageUrl)return res.status(400).json({error:'Image URL must be an HTTPS/HTTP URL or an internal /path.'});
 if(buttonRaw && !buttonUrl)return res.status(400).json({error:'Button link must be an HTTPS/HTTP URL or an internal /path.'});
 if(buttonText && !buttonUrl)return res.status(400).json({error:'Add a button link or remove the button text.'});
 if(audienceType==='admin'){
   const a=db.prepare("SELECT id FROM users WHERE id=? AND role='sub_admin' AND admin_active=1").get(audienceAdminId);
   if(!a)return res.status(400).json({error:'Choose an active Sub-Admin audience.'});
 }
 if(endsAt&&!Number.isFinite(Date.parse(endsAt)))return res.status(400).json({error:'Choose a valid optional banner end date.'});
 if(isTestimonial && (!attribution||!consentConfirmed))return res.status(400).json({error:'Testimonials require attribution and permission confirmation.'});
 db.prepare(`UPDATE banners SET title=?,body=?,kind=?,image_url=?,button_text=?,button_url=?,audience_type=?,audience_admin_id=?,active=?,starts_at=?,ends_at=?,sort_order=?,is_testimonial=?,attribution=?,consent_confirmed=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
   .run(title,body,kind,imageUrl,buttonText,buttonUrl,audienceType,audienceAdminId,active,startsAt,endsAt,sortOrder,isTestimonial,attribution,consentConfirmed,current.id);
 res.json({ok:true});
});

app.post('/api/super/banners/:id/status',superAdmin,(req,res)=>{
 const b=db.prepare('SELECT id FROM banners WHERE id=?').get(req.params.id);
 if(!b)return res.status(404).json({error:'Banner not found.'});
 db.prepare('UPDATE banners SET active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(req.body.active?1:0,b.id);
 res.json({ok:true});
});

app.delete('/api/super/banners/:id',superAdmin,(req,res)=>{
 const b=db.prepare('SELECT id FROM banners WHERE id=?').get(req.params.id);
 if(!b)return res.status(404).json({error:'Banner not found.'});
 db.transaction(()=>{db.prepare('DELETE FROM banner_admin_overrides WHERE banner_id=?').run(b.id);db.prepare('DELETE FROM banners WHERE id=?').run(b.id)})();
 res.json({ok:true});
});



// Withdrawal requests are open by default. Admins can pause new requests or place
// individual requests on hold with a customer-visible reason.
// Withdrawal approval updates the account ledger; external transfer processing is separate.
db.exec(`CREATE TABLE IF NOT EXISTS withdrawal_global_settings(
 id INTEGER PRIMARY KEY CHECK(id=1),
 paused INTEGER DEFAULT 0,
 reason TEXT,
 updated_by INTEGER,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS withdrawal_admin_settings(
 admin_id INTEGER PRIMARY KEY,
 paused INTEGER DEFAULT 0,
 reason TEXT,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS withdrawal_requests(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 reference TEXT UNIQUE NOT NULL,
 user_id INTEGER NOT NULL,
 owner_admin_id INTEGER,
 asset TEXT NOT NULL,
 amount REAL NOT NULL,
 destination TEXT NOT NULL,
 status TEXT DEFAULT 'pending',
 review_reason TEXT,
 reviewed_by INTEGER,
 reviewed_at TEXT,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);`);
db.prepare("INSERT OR IGNORE INTO withdrawal_global_settings(id,paused,reason) VALUES(1,0,NULL)").run();

function withdrawalRef(){
 return 'OT-WD-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(3).toString('hex').toUpperCase();
}
function withdrawalControlForUser(user){
 const global=db.prepare('SELECT paused,reason FROM withdrawal_global_settings WHERE id=1').get()||{paused:0,reason:null};
 let adminSetting={paused:0,reason:null};
 if(user.owner_admin_id){
   adminSetting=db.prepare('SELECT paused,reason FROM withdrawal_admin_settings WHERE admin_id=?').get(user.owner_admin_id)||adminSetting;
 }
 const paused=!!global.paused||!!adminSetting.paused;
 return {
   paused,
   reason:global.paused?(global.reason||'Withdrawals are temporarily paused by OptiTrade.'):(adminSetting.reason||'Withdrawals are temporarily paused by your account administrator.'),
   globalPaused:!!global.paused,
   adminPaused:!!adminSetting.paused
 };
}
function withdrawalReserved(userId,asset){
 const r=db.prepare("SELECT COALESCE(SUM(amount),0) n FROM withdrawal_requests WHERE user_id=? AND asset=? AND status IN ('pending','on_hold')").get(userId,asset);
 return Number(r?.n||0);
}
function withdrawalWalletAmount(userId,asset){
 seedSectionBalances(userId);
 const r=db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='wallet' AND asset=?").get(userId,asset);
 return Number(r?.amount||0);
}

app.get('/api/withdrawal/status',auth,(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required'});
 const control=withdrawalControlForUser(req.user);
 const assets=['USD','USDT','BTC','ETH'].map(asset=>{
   const balance=withdrawalWalletAmount(req.user.id,asset);
   const reserved=withdrawalReserved(req.user.id,asset);
   return {asset,balance,reserved,available:Math.max(0,balance-reserved)};
 });
 res.json({open:!control.paused,...control,assets,eligibility:kycGate(req.user,'withdrawal')});
});

app.get('/api/withdrawal/requests',auth,(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required'});
 const rows=db.prepare(`SELECT id,reference,asset,amount,destination,status,review_reason,created_at,updated_at
 FROM withdrawal_requests WHERE user_id=? ORDER BY id DESC LIMIT 50`).all(req.user.id);
 res.json({requests:rows});
});

app.post('/api/withdrawal/requests',auth,(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required'});
 const eligibility=kycGate(req.user,'withdrawal');if(!eligibility.ok)return res.status(403).json(eligibility);
 const control=withdrawalControlForUser(req.user);
 if(control.paused)return res.status(423).json({error:control.reason});
 const asset=String(req.body.asset||'').toUpperCase();
 const amount=Number(req.body.amount);
 const destination=String(req.body.destination||'').trim().slice(0,300);
 const destinationIdentity=destination.toLowerCase();
 if(destinationIdentity===String(req.user.email||'').trim().toLowerCase()||destinationIdentity===String(req.user.username||'').trim().toLowerCase())
   return res.status(400).json({error:'Enter the actual external receiver address. Your OptiProTrade email or username cannot be used as the withdrawal destination.'});
 const pinCheck=sensitivePinCheck(req.user.id,String(req.body.pin||''));if(!pinCheck.ok)return res.status(pinCheck.status).json(pinCheck);
 if(!['USD','USDT','BTC','ETH'].includes(asset)||!Number.isFinite(amount)||amount<=0)
   return res.status(400).json({error:'Choose a valid asset and withdrawal amount.'});
 if(destination.length<3)return res.status(400).json({error:'Enter the receiver address.'});
 const balance=withdrawalWalletAmount(req.user.id,asset);
 const reserved=withdrawalReserved(req.user.id,asset);
 const available=Math.max(0,balance-reserved);
 if(amount>available)return res.status(400).json({error:'Amount exceeds your available account balance after pending withdrawals.'});
 const reference=withdrawalRef();
 db.prepare(`INSERT INTO withdrawal_requests(reference,user_id,owner_admin_id,asset,amount,destination,status)
 VALUES(?,?,?,?,?,?,'pending')`).run(reference,req.user.id,req.user.owner_admin_id||null,asset,amount,destination);
 logActivity(req.user.id,req.user.id,'withdrawal_request',`Withdrawal ${reference} submitted for ${amount} ${asset} • Pending`);
 notifyAndEmail(req.user.id,'withdrawal','Withdrawal Pending',`Your withdrawal request ${reference} for ${amount} ${asset} is Pending and awaiting admin review.`,'/withdraw.html');
 const owner=req.user.owner_admin_id||db.prepare("SELECT id FROM users WHERE role='super_admin' ORDER BY id LIMIT 1").get()?.id;
 notifyUrgentAdminEvent(owner,'withdrawal','Withdrawal Pending',`${req.user.name||req.user.username||'Customer'} submitted ${amount} ${asset}. Status: Pending.`,'/admin/withdrawals.html');
 res.json({ok:true,reference,status:'pending'});
});

app.get('/api/admin/withdrawals',admin,(req,res)=>{
 const where=scopedUserWhere(req.user,'u');
 const rows=db.prepare(`SELECT w.*,u.name,u.username,u.email
 FROM withdrawal_requests w JOIN users u ON u.id=w.user_id
 WHERE ${where}
 ORDER BY CASE w.status WHEN 'pending' THEN 0 WHEN 'on_hold' THEN 1 ELSE 2 END,w.id DESC LIMIT 250`).all();
 const global=db.prepare('SELECT paused,reason,updated_at FROM withdrawal_global_settings WHERE id=1').get();
 const local=isSuper(req.user)?null:(db.prepare('SELECT paused,reason,updated_at FROM withdrawal_admin_settings WHERE admin_id=?').get(req.user.id)||{paused:0,reason:null});
 res.json({role:req.user.role,global,local,requests:rows});
});

app.post('/api/admin/withdrawals/pause',admin,(req,res)=>{
 const paused=!!req.body.paused;
 const reason=String(req.body.reason||'').trim().slice(0,500);
 if(paused&&reason.length<5)return res.status(400).json({error:'Enter a clear reason customers will see while withdrawals are paused.'});
 if(isSuper(req.user)||req.user.role==='admin'){
   db.prepare('UPDATE withdrawal_global_settings SET paused=?,reason=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=1')
     .run(paused?1:0,paused?reason:null,req.user.id);
 }else{
   db.prepare(`INSERT INTO withdrawal_admin_settings(admin_id,paused,reason,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP)
   ON CONFLICT(admin_id) DO UPDATE SET paused=excluded.paused,reason=excluded.reason,updated_at=CURRENT_TIMESTAMP`)
     .run(req.user.id,paused?1:0,paused?reason:null);
 }
 res.json({ok:true,paused});
});

app.post('/api/admin/withdrawals/:id/review',admin,(req,res)=>{
 const w=db.prepare('SELECT * FROM withdrawal_requests WHERE id=?').get(req.params.id);
 if(!w)return res.status(404).json({error:'Withdrawal request not found.'});
 if(!ownsUser(req.user,w.user_id))return res.status(403).json({error:'You do not have access to this customer.'});
 const action=String(req.body.action||'').toLowerCase();
 const reason=String(req.body.reason||'').trim().slice(0,500);
 if(!['approve','hold','reject','resume'].includes(action))return res.status(400).json({error:'Choose a valid review action.'});
 if(['hold','reject'].includes(action)&&reason.length<5)return res.status(400).json({error:'A clear customer-visible reason is required.'});
 if(['approved','rejected'].includes(w.status))return res.status(409).json({error:'This withdrawal has already been finalized.'});

 if(action==='hold'){
   db.prepare("UPDATE withdrawal_requests SET status='on_hold',review_reason=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?")
     .run(reason,req.user.id,w.id);
   notifyAndEmail(w.user_id,'withdrawal','Withdrawal placed on hold',`Your withdrawal request ${w.reference} is on hold. Reason: ${reason}`,'/withdraw.html');
   logActivity(w.user_id,req.user.id,'withdrawal_hold',`Withdrawal ${w.reference} placed on hold: ${reason}`);
   return res.json({ok:true,status:'on_hold'});
 }
 if(action==='resume'){
   db.prepare("UPDATE withdrawal_requests SET status='pending',review_reason=NULL,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?")
     .run(req.user.id,w.id);
   notifyAndEmail(w.user_id,'withdrawal','Withdrawal review resumed',`Your withdrawal request ${w.reference} has returned to pending review.`,'/withdraw.html');
   return res.json({ok:true,status:'pending'});
 }
 if(action==='reject'){
   db.prepare("UPDATE withdrawal_requests SET status='rejected',review_reason=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?")
     .run(reason,req.user.id,w.id);
   notifyAndEmail(w.user_id,'withdrawal','Withdrawal declined',`Your withdrawal request ${w.reference} was declined. Reason: ${reason}`,'/withdraw.html');
   logActivity(w.user_id,req.user.id,'withdrawal_rejected',`Withdrawal ${w.reference} declined: ${reason}`);
   return res.json({ok:true,status:'rejected'});
 }

 // Approval finalizes the request and deducts the account wallet balance once.
 const balance=withdrawalWalletAmount(w.user_id,w.asset);
 if(balance<w.amount)return res.status(409).json({error:'The customer no longer has enough available wallet balance to approve this request.'});
 const tx=db.transaction(()=>{
   const fresh=db.prepare('SELECT status FROM withdrawal_requests WHERE id=?').get(w.id);
   if(!fresh||!['pending','on_hold'].includes(fresh.status))throw new Error('Request has already been finalized.');
   const current=withdrawalWalletAmount(w.user_id,w.asset);
   if(current<w.amount)throw new Error('Insufficient available wallet balance.');
   const after=current-w.amount;
   db.prepare("UPDATE section_balances SET amount=? WHERE user_id=? AND section='wallet' AND asset=?").run(after,w.user_id,w.asset);
   // Keep legacy balances synchronized.
   db.prepare("UPDATE balances SET amount=? WHERE user_id=? AND asset=?").run(after,w.user_id,w.asset);
   db.prepare("UPDATE withdrawal_requests SET status='approved',review_reason=NULL,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.user.id,w.id);
   db.prepare(`INSERT INTO demo_transactions(reference,user_id,actor_id,type,asset,amount,direction,status,note)
   VALUES(?,?,?,?,?,?,?,'completed',?)`).run(w.reference,w.user_id,req.user.id,'withdrawal',w.asset,w.amount,'debit','Approved account withdrawal; external transfer processing is handled separately.');
   logActivity(w.user_id,req.user.id,'withdrawal_approved',`Withdrawal ${w.reference} approved for ${w.amount} ${w.asset}`);
   return after;
 });
 let after;
 try{after=tx()}catch(e){return res.status(409).json({error:e.message})}
 notifyAndEmail(w.user_id,'withdrawal','Withdrawal approved',`Your withdrawal request ${w.reference} for ${w.amount} ${w.asset} was approved in the OptiTrade account ledger. External transfer processing is handled separately.`,'/withdraw.html');
 res.json({ok:true,status:'approved',balance:after});
});

app.get('/api/admin/referral-info',admin,(req,res)=>{
 const u=db.prepare('SELECT id,name,username,email,role,referral_code,admin_active FROM users WHERE id=?').get(req.user.id);
 if(!u)return res.status(404).json({error:'Admin not found'});
 res.json({name:u.name,username:u.username,email:u.email,role:u.role,referralCode:u.referral_code||null,active:u.admin_active!==0});
});


app.get('/api/admin/attention',admin,(req,res)=>{
 const broad=isSuper(req.user)||req.user.role==='admin',aid=req.user.id;
 const deposits=broad
  ?db.prepare(`SELECT d.id,d.reference,d.amount,d.requested_usd,d.usd_value,d.asset,d.network,d.created_at,u.name,u.username,u.email FROM deposit_requests d JOIN users u ON u.id=d.user_id WHERE d.status='pending' ORDER BY d.id DESC LIMIT 80`).all()
  :db.prepare(`SELECT d.id,d.reference,d.amount,d.requested_usd,d.usd_value,d.asset,d.network,d.created_at,u.name,u.username,u.email FROM deposit_requests d JOIN users u ON u.id=d.user_id WHERE d.status='pending' AND d.owner_admin_id=? ORDER BY d.id DESC LIMIT 80`).all(aid);
 const withdrawals=broad
  ?db.prepare(`SELECT w.id,w.reference,w.amount,w.asset,w.status,w.destination,w.created_at,u.name,u.username,u.email FROM withdrawal_requests w JOIN users u ON u.id=w.user_id WHERE w.status IN ('pending','on_hold') ORDER BY w.id DESC LIMIT 80`).all()
  :db.prepare(`SELECT w.id,w.reference,w.amount,w.asset,w.status,w.destination,w.created_at,u.name,u.username,u.email FROM withdrawal_requests w JOIN users u ON u.id=w.user_id WHERE w.status IN ('pending','on_hold') AND w.owner_admin_id=? ORDER BY w.id DESC LIMIT 80`).all(aid);
 const managed=broad
  ?db.prepare(`SELECT m.id,m.reference,m.amount,m.market_preference,m.created_at,u.name,u.username,u.email FROM managed_trade_requests m JOIN users u ON u.id=m.user_id WHERE m.status='pending' ORDER BY m.id DESC LIMIT 80`).all()
  :db.prepare(`SELECT m.id,m.reference,m.amount,m.market_preference,m.created_at,u.name,u.username,u.email FROM managed_trade_requests m JOIN users u ON u.id=m.user_id WHERE m.status='pending' AND m.owner_admin_id=? ORDER BY m.id DESC LIMIT 80`).all(aid);
 const self=broad
  ?db.prepare(`SELECT p.id,p.reference,p.notional_usd,p.pair,p.side,p.created_at,u.name,u.username,u.email FROM paper_trade_orders p JOIN users u ON u.id=p.user_id WHERE p.status='pending' ORDER BY p.id DESC LIMIT 80`).all()
  :db.prepare(`SELECT p.id,p.reference,p.notional_usd,p.pair,p.side,p.created_at,u.name,u.username,u.email FROM paper_trade_orders p JOIN users u ON u.id=p.user_id WHERE p.status='pending' AND u.owner_admin_id=? ORDER BY p.id DESC LIMIT 80`).all(aid);
 const items=[];
 for(const x of deposits){
  const requested=Number(x.requested_usd??x.usd_value??0);
  items.push({kind:'deposit',id:x.id,reference:x.reference,status:'pending',title:'Deposit needs review',customer:x.name||x.username||x.email,
   detail:`${requested>0?'$'+requested.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})+' requested • ':''}${Number(x.amount).toLocaleString(undefined,{maximumFractionDigits:10})} ${x.asset} • ${x.network}`,
   href:`/admin/deposits.html?focus=${x.id}&action=review`,createdAt:x.created_at});
 }
 for(const x of withdrawals)items.push({kind:'withdrawal',id:x.id,reference:x.reference,status:x.status,title:x.status==='on_hold'?'Withdrawal on hold':'Withdrawal needs review',customer:x.name||x.username||x.email,
  detail:`${Number(x.amount).toLocaleString(undefined,{maximumFractionDigits:10})} ${x.asset} • ${x.destination}`,href:`/admin/withdrawals.html?focus=${x.id}&action=review`,createdAt:x.created_at});
 for(const x of managed)items.push({kind:'trade',tradeKind:'managed',id:x.id,reference:x.reference,status:'pending',title:'Trade with OptiTrade request',customer:x.name||x.username||x.email,
  detail:`$${Number(x.amount).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} • ${x.market_preference||'Managed market'}`,href:`/admin/managed-trades.html?kind=managed&focus=${x.id}&action=review`,createdAt:x.created_at});
 for(const x of self)items.push({kind:'trade',tradeKind:'self',id:x.id,reference:x.reference,status:'pending',title:'Self-Directed trade request',customer:x.name||x.username||x.email,
  detail:`${String(x.side||'').toUpperCase()} ${x.pair} • $${Number(x.notional_usd).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`,href:`/admin/managed-trades.html?kind=self&focus=${x.id}&action=review`,createdAt:x.created_at});
 items.sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
 const counts={deposits:deposits.length,withdrawals:withdrawals.length,trades:managed.length+self.length};
 counts.total=counts.deposits+counts.withdrawals+counts.trades;
 res.set('Cache-Control','no-store');res.json({counts,items:items.slice(0,120)});
});

app.get('/api/admin/overview',admin,(req,res)=>{
 const where=scopedUserWhere(req.user,'u');
 const users=db.prepare(`SELECT COUNT(*) n FROM users u WHERE ${where}`).get().n;
 const verified=db.prepare(`SELECT COUNT(*) n FROM users u WHERE ${where} AND u.email_verified=1`).get().n;
 const unreadSupport=db.prepare(`SELECT COALESCE(SUM(t.unread_admin),0) n FROM support_threads t JOIN users u ON u.id=t.user_id WHERE ${where}`).get().n;
 const transactions=db.prepare(`SELECT COUNT(*) n FROM demo_transactions d JOIN users u ON u.id=d.user_id WHERE ${where}`).get().n;
 const pendingDeposits=(isSuper(req.user)||req.user.role==='admin')?db.prepare("SELECT COUNT(*) n FROM deposit_requests WHERE status='pending'").get().n:db.prepare("SELECT COUNT(*) n FROM deposit_requests WHERE status='pending' AND owner_admin_id=?").get(req.user.id).n;
 const pendingWithdrawals=(isSuper(req.user)||req.user.role==='admin')
   ?db.prepare("SELECT COUNT(*) n FROM withdrawal_requests WHERE status IN ('pending','on_hold')").get().n
   :db.prepare("SELECT COUNT(*) n FROM withdrawal_requests WHERE status IN ('pending','on_hold') AND owner_admin_id=?").get(req.user.id).n;
 const managedOpen=(isSuper(req.user)||req.user.role==='admin')?db.prepare("SELECT COUNT(*) n FROM managed_trade_requests WHERE status IN ('pending','active')").get().n:db.prepare("SELECT COUNT(*) n FROM managed_trade_requests WHERE status IN ('pending','active') AND owner_admin_id=?").get(req.user.id).n;
 const selfOpen=(isSuper(req.user)||req.user.role==='admin')?db.prepare("SELECT COUNT(*) n FROM paper_trade_orders WHERE status IN ('pending','active')").get().n:db.prepare("SELECT COUNT(*) n FROM paper_trade_orders p JOIN users u ON u.id=p.user_id WHERE p.status IN ('pending','active') AND u.owner_admin_id=?").get(req.user.id).n;
 const openManagedTrades=managedOpen+selfOpen;
 const kycPending=Number(db.prepare(`SELECT COUNT(*) n FROM users u LEFT JOIN kyc_profiles k ON k.user_id=u.id WHERE ${where} AND COALESCE(k.status,'not_started') IN ('pending','in_progress','on_hold')`).get()?.n||0);
 const kycVerified=Number(db.prepare(`SELECT COUNT(*) n FROM users u JOIN kyc_profiles k ON k.user_id=u.id WHERE ${where} AND k.status='verified'`).get()?.n||0);
 const recentUsers=db.prepare(`SELECT u.id,u.name,u.username,u.email,u.email_verified,u.created_at FROM users u WHERE ${where} ORDER BY u.id DESC LIMIT 6`).all();
 const recentActivity=db.prepare(`SELECT a.*,u.name,u.username FROM account_activity a JOIN users u ON u.id=a.user_id WHERE ${where} ORDER BY a.id DESC LIMIT 12`).all();
 res.json({role:req.user.role,counts:{users,verified,unreadSupport,transactions,pendingDeposits,pendingWithdrawals,openManagedTrades,kycPending,kycVerified},recentUsers,recentActivity});
});
app.get('/api/admin/inheritance-summary',admin,(req,res)=>{
 const saId=superAdminId();
 const globalWallets=saId?Number(db.prepare('SELECT COUNT(*) n FROM deposit_wallet_addresses WHERE admin_id=? AND active=1').get(saId)?.n||0):0;
 const globalBanners=Number(db.prepare("SELECT COUNT(*) n FROM banners WHERE audience_type='all'").get()?.n||0);
 const globalFaqs=Number(db.prepare('SELECT COUNT(*) n FROM support_faqs WHERE active=1').get()?.n||0);
 if(req.user.role==='sub_admin'){
   const localWallets=Number(db.prepare('SELECT COUNT(*) n FROM deposit_wallet_addresses WHERE admin_id=? AND active=1').get(req.user.id)?.n||0);
   const bannerOverrides=Number(db.prepare('SELECT COUNT(*) n FROM banner_admin_overrides WHERE admin_id=?').get(req.user.id)?.n||0);
   const localBanners=Number(db.prepare("SELECT COUNT(*) n FROM banners WHERE created_by=? AND audience_type='admin' AND audience_admin_id=?").get(req.user.id,req.user.id)?.n||0);
   const welcomeOverride=!!db.prepare('SELECT 1 FROM welcome_admin_overrides WHERE admin_id=?').get(req.user.id);
   const faqOverride=Number(db.prepare('SELECT has_override FROM support_faq_admin_meta WHERE admin_id=?').get(req.user.id)?.has_override||0)===1;
   const timerOverride=!!db.prepare('SELECT 1 FROM banner_admin_settings WHERE admin_id=?').get(req.user.id);
   return res.json({role:req.user.role,global:{wallets:globalWallets,banners:globalBanners,faqs:globalFaqs},local:{wallets:localWallets,bannerOverrides,localBanners,welcomeOverride,faqOverride,timerOverride}});
 }
 res.json({role:req.user.role,global:{wallets:globalWallets,banners:globalBanners,faqs:globalFaqs},local:null});
});
app.get('/api/admin/users-v2',admin,(req,res)=>{
 const q='%'+String(req.query.q||'').trim().toLowerCase()+'%',where=scopedUserWhere(req.user,'u');
 const rows=db.prepare(`SELECT u.id,u.name,u.username,u.email,u.phone,u.country,u.currency,u.email_verified,u.created_at,
   COALESCE((SELECT amount FROM section_balances s WHERE s.user_id=u.id AND s.section='wallet' AND s.asset='USD'),0) wallet_usd,
   COALESCE((SELECT SUM(amount) FROM withdrawal_requests w WHERE w.user_id=u.id AND w.asset='USD' AND w.status IN ('pending','on_hold')),0) reserved_usd,
   MAX(0,COALESCE((SELECT amount FROM section_balances s WHERE s.user_id=u.id AND s.section='wallet' AND s.asset='USD'),0)-COALESCE((SELECT SUM(amount) FROM withdrawal_requests w WHERE w.user_id=u.id AND w.asset='USD' AND w.status IN ('pending','on_hold')),0)) available_usd,
   COALESCE((SELECT amount FROM section_balances s WHERE s.user_id=u.id AND s.section='portfolio' AND s.asset='USD'),0) portfolio_usd,
   COALESCE((SELECT amount FROM section_balances s WHERE s.user_id=u.id AND s.section='trading' AND s.asset='USD'),0) trading_usd,
   (SELECT COUNT(*) FROM withdrawal_requests w WHERE w.user_id=u.id AND w.status IN ('pending','on_hold')) open_withdrawals,
   ((SELECT COUNT(*) FROM managed_trade_requests m WHERE m.user_id=u.id AND m.status IN ('pending','active')) + (SELECT COUNT(*) FROM paper_trade_orders p WHERE p.user_id=u.id AND p.status IN ('pending','active'))) open_managed_trades
   FROM users u WHERE ${where}
   AND (lower(u.name) LIKE ? OR lower(u.email) LIKE ? OR lower(COALESCE(u.username,'')) LIKE ?)
   ORDER BY u.id DESC`).all(q,q,q);
 res.json(rows);
});
app.get('/api/admin/users-v2/:id',admin,(req,res)=>{
 if(!ownsUser(req.user,+req.params.id))return res.status(403).json({error:'You do not have access to this customer'});
 const u=db.prepare("SELECT id,name,username,email,phone,country,currency,dob,email_verified,created_at,owner_admin_id FROM users WHERE id=? AND role='user'").get(req.params.id);
 if(!u)return res.status(404).json({error:'User not found'});
 seedSectionBalances(u.id);
 const sectionBalances=db.prepare('SELECT section,asset,amount FROM section_balances WHERE user_id=? ORDER BY section,asset').all(u.id);
 const withdrawals=db.prepare(`SELECT id,reference,asset,amount,destination,status,review_reason,reviewed_by,reviewed_at,created_at,updated_at
   FROM withdrawal_requests WHERE user_id=? ORDER BY id DESC LIMIT 100`).all(u.id);
 const deposits=db.prepare(`SELECT id,reference,asset,network,amount,usd_value,usd_rate,source,txid,status,review_reason,created_at
   FROM deposit_requests WHERE user_id=? ORDER BY id DESC LIMIT 20`).all(u.id);
 const managedTrades=db.prepare(`SELECT id,reference,funding_asset,amount,market_preference,preferred_symbol,traded_symbol,status,pnl_percent,pnl_amount,return_amount,created_at,opened_at,settled_at
   FROM managed_trade_requests WHERE user_id=? ORDER BY id DESC LIMIT 20`).all(u.id);
 const walletAvailability=['USD','USDT','BTC','ETH'].map(asset=>{
   const balance=Number(sectionBalances.find(x=>x.section==='wallet'&&x.asset===asset)?.amount||0);
   const reserved=withdrawals.filter(x=>x.asset===asset&&['pending','on_hold'].includes(x.status)).reduce((n,x)=>n+Number(x.amount||0),0);
   return {asset,balance,reserved,available:Math.max(0,balance-reserved)};
 });
 const usd=walletAvailability.find(x=>x.asset==='USD')||{balance:0,reserved:0,available:0};
 const tradingUsd=Number(sectionBalances.find(x=>x.section==='trading'&&x.asset==='USD')?.amount||0);
 const approvedDepositsUsd=Number(db.prepare(`SELECT COALESCE(SUM(CASE WHEN status='approved' THEN COALESCE(credited_usd,usd_value,0) ELSE 0 END),0) total FROM deposit_requests WHERE user_id=?`).get(u.id)?.total||0);
 const reversedAdjustments=new Set(db.prepare('SELECT original_reference FROM balance_adjustment_reversals WHERE user_id=?').all(u.id).map(x=>x.original_reference));
 const summary={
   openWithdrawals:withdrawals.filter(x=>['pending','on_hold'].includes(x.status)).length,
   pendingDeposits:deposits.filter(x=>x.status==='pending').length,
   openManagedTrades:managedTrades.filter(x=>['pending','active'].includes(x.status)).length,
   walletUsd:usd.balance,reservedUsd:usd.reserved,availableUsd:usd.available,tradingUsd,approvedDepositsUsd
 };
 const transactions=db.prepare('SELECT * FROM demo_transactions WHERE user_id=? ORDER BY id DESC LIMIT 40').all(u.id).map(x=>({...x,reversible:['balance_credit','balance_debit'].includes(x.type)&&/^(Wallet|Portfolio|Trading) balance\b/i.test(String(x.note||''))&&!reversedAdjustments.has(x.reference),reversed:reversedAdjustments.has(x.reference)}));
 res.json({
   user:u,sectionBalances,walletAvailability,withdrawals,deposits,managedTrades,summary,
   transactions,
   activity:db.prepare('SELECT * FROM account_activity WHERE user_id=? ORDER BY id DESC LIMIT 40').all(u.id)
 });
});
app.post('/api/admin/users-v2/:id/adjust-balance',admin,(req,res)=>{
 const uid=+req.params.id;if(!ownsUser(req.user,uid))return res.status(403).json({error:'You do not have access to this customer'});
 const section=String(req.body.section||'wallet').toLowerCase(),asset=String(req.body.asset||'USD').toUpperCase(),amount=+req.body.amount,direction=req.body.direction==='debit'?'debit':'credit';
 const reason=String(req.body.reason||'').trim().slice(0,300),internalNote=String(req.body.internalNote||'').trim().slice(0,500);
 if(!['wallet','portfolio','trading'].includes(section)||!['USD','USDT','BTC','ETH'].includes(asset)||!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:'Choose a valid balance section, asset and amount'});
 if(reason.length<5)return res.status(400).json({error:'Enter a clear reason for the customer notification'});
 seedSectionBalances(uid);
 const row=db.prepare('SELECT amount FROM section_balances WHERE user_id=? AND section=? AND asset=?').get(uid,section,asset),before=Number(row?.amount||0),after=direction==='credit'?before+amount:before-amount;
 if(after<0)return res.status(400).json({error:'Debit would make this balance negative'});
 const reserved=section==='wallet'?withdrawalReserved(uid,asset):0;
 if(section==='wallet'&&direction==='debit'&&after<reserved)return res.status(409).json({error:`This debit would use funds already reserved for pending withdrawals. Reserved: ${reserved} ${asset}.`});
 const ref=ledgerRef(),txType=direction==='credit'?'balance_credit':'balance_debit',title=direction==='credit'?'Balance Credited':'Balance Debited';
 db.transaction(()=>{
   db.prepare('UPDATE section_balances SET amount=? WHERE user_id=? AND section=? AND asset=?').run(after,uid,section,asset);
   if(section==='wallet')db.prepare('UPDATE balances SET amount=? WHERE user_id=? AND asset=?').run(after,uid,asset);
   db.prepare("INSERT INTO demo_transactions(reference,user_id,actor_id,type,asset,amount,direction,status,note) VALUES(?,?,?,?,?,?,?,'completed',?)")
     .run(ref,uid,req.user.id,txType,asset,amount,direction,`${section[0].toUpperCase()+section.slice(1)} balance • ${reason}`+(internalNote?` | Internal: ${internalNote}`:''));
   logActivity(uid,req.user.id,txType,`${title}: ${amount} ${asset} • ${section} balance`);
   notifyAndEmail(uid,txType,title,`${amount} ${asset} was ${direction==='credit'?'credited to':'debited from'} your ${section} balance. Reason: ${reason}. Reference: ${ref}`,'/statement.html');
 })();
 res.json({ok:true,reference:ref,balance:after,reserved,available:section==='wallet'?Math.max(0,after-reserved):after,section,asset,direction,title});
});


app.post('/api/admin/users-v2/:id/reverse-adjustment',admin,(req,res)=>{
 const uid=Number(req.params.id);
 if(!ownsUser(req.user,uid))return res.status(403).json({error:'You do not have access to this customer'});
 const reference=String(req.body.reference||'').trim();
 const reason=String(req.body.reason||'').trim().slice(0,500);
 if(reason.length<5)return res.status(400).json({error:'Enter a clear reversal reason.'});
 if(db.prepare('SELECT id FROM balance_adjustment_reversals WHERE original_reference=?').get(reference))
   return res.status(409).json({error:'This adjustment has already been reversed.'});
 const tx=db.prepare(`SELECT * FROM demo_transactions WHERE user_id=? AND reference=? AND type IN ('balance_credit','balance_debit')`).get(uid,reference);
 if(!tx)return res.status(404).json({error:'Only recent balance credit/debit adjustments can be reversed from this tool.'});
 const m=String(tx.note||'').match(/^(Wallet|Portfolio|Trading) balance\b/i);
 if(!m)return res.status(409).json({error:'This older adjustment does not contain enough section information for an automatic reversal.'});
 const section=m[1].toLowerCase(),asset=String(tx.asset).toUpperCase(),amount=Number(tx.amount),reverseDirection=tx.direction==='credit'?'debit':'credit';
 seedSectionBalances(uid);
 const current=Number(db.prepare('SELECT amount FROM section_balances WHERE user_id=? AND section=? AND asset=?').get(uid,section,asset)?.amount||0);
 const after=reverseDirection==='debit'?current-amount:current+amount;
 if(after<0)return res.status(409).json({error:`The ${section} ${asset} balance is lower than the amount required to reverse this adjustment.`});
 const reserved=section==='wallet'?withdrawalReserved(uid,asset):0;
 if(section==='wallet'&&after<reserved-1e-12)return res.status(409).json({error:'Reversal would use funds reserved for a pending withdrawal.'});
 const reversalRef='OT-REV-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(3).toString('hex').toUpperCase();
 db.transaction(()=>{
   db.prepare('UPDATE section_balances SET amount=? WHERE user_id=? AND section=? AND asset=?').run(after,uid,section,asset);
   if(section==='wallet')db.prepare('UPDATE balances SET amount=? WHERE user_id=? AND asset=?').run(after,uid,asset);
   db.prepare(`INSERT INTO balance_adjustment_reversals(original_reference,reversal_reference,user_id,section,asset,amount,original_direction,reversed_by,reason)
     VALUES(?,?,?,?,?,?,?,?,?)`).run(reference,reversalRef,uid,section,asset,amount,tx.direction,req.user.id,reason);
   db.prepare("INSERT INTO demo_transactions(reference,user_id,actor_id,type,asset,amount,direction,status,note) VALUES(?,?,?,?,?,?,?,'completed',?)")
     .run(reversalRef,uid,req.user.id,'balance_reversal',asset,amount,reverseDirection,`Reversal of ${reference} • ${section} balance • ${reason}`);
   logActivity(uid,req.user.id,'balance_reversal',`Reversed ${reference}: ${amount} ${asset} ${section} balance.`);
 })();
 notifyAndEmail(uid,'balance_reversal','Balance adjustment reversed',`${amount} ${asset} ${section} adjustment ${reference} was reversed. Reason: ${reason}. Reference: ${reversalRef}`,'/statement.html');
 res.json({ok:true,reference:reversalRef,originalReference:reference,section,asset,balance:after,direction:reverseDirection});
});

// Scoped support: sub-admins can only access their own customers.
app.post('/api/admin/support/start/:uid',admin,(req,res)=>{const uid=+req.params.uid;if(!ownsUser(req.user,uid))return res.status(403).json({error:'You do not have access to this customer'});const t=ensureWelcome(uid);res.json({ok:true,threadId:t.id})});
app.get('/api/admin/support/threads',admin,(req,res)=>{const where=scopedUserWhere(req.user,'u');res.json(db.prepare(`SELECT t.id,t.user_id,t.status,t.unread_admin,t.updated_at,u.name,u.username,u.email,(SELECT body FROM support_messages m WHERE m.thread_id=t.id ORDER BY m.id DESC LIMIT 1) last_message FROM support_threads t JOIN users u ON u.id=t.user_id WHERE ${where} ORDER BY t.unread_admin DESC,t.updated_at DESC`).all())});
app.get('/api/admin/support/threads/:id',admin,(req,res)=>{const t=db.prepare(`SELECT t.*,u.name,u.username,u.email,u.owner_admin_id FROM support_threads t JOIN users u ON u.id=t.user_id WHERE t.id=?`).get(req.params.id);if(!t)return res.status(404).json({error:'Conversation not found'});if(!ownsUser(req.user,t.user_id))return res.status(403).json({error:'You do not have access to this conversation'});db.prepare('UPDATE support_threads SET unread_admin=0 WHERE id=?').run(t.id);res.json({thread:{...t,unread_admin:0},messages:db.prepare('SELECT id,sender_role,body,kind,created_at FROM support_messages WHERE thread_id=? ORDER BY id').all(t.id)})});
app.post('/api/admin/support/threads/:id/message',admin,(req,res)=>{const body=String(req.body.body||'').trim();if(body.length<1||body.length>2000)return res.status(400).json({error:'Message must be between 1 and 2000 characters.'});const t=db.prepare('SELECT * FROM support_threads WHERE id=?').get(req.params.id);if(!t||!ownsUser(req.user,t.user_id))return res.status(403).json({error:'Conversation unavailable'});const info=db.prepare("INSERT INTO support_messages(thread_id,sender_role,sender_id,body) VALUES(?,'support',?,?)").run(t.id,req.user.id,body);db.prepare("UPDATE support_threads SET unread_user=unread_user+1,status='open',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(t.id);notifyAndEmail(t.user_id,'support','New support reply','OptiTrade Support replied to your conversation.','/support.html');logActivity(t.user_id,req.user.id,'support_reply','OptiTrade Support replied to your conversation');res.json({ok:true,id:info.lastInsertRowid,status:'sent'})});
app.post('/api/admin/support/threads/:id/status',admin,(req,res)=>{const t=db.prepare('SELECT * FROM support_threads WHERE id=?').get(req.params.id);if(!t||!ownsUser(req.user,t.user_id))return res.status(403).json({error:'Conversation unavailable'});const status=req.body.status==='closed'?'closed':'open';db.prepare('UPDATE support_threads SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status,t.id);res.json({ok:true,status})});

// Deposit wallet settings. Sub-admin manages own addresses; Super Admin manages default addresses.

app.get('/api/admin/deposit-wallets',admin,(req,res)=>{
 const ownWallets=db.prepare(`SELECT id,label,asset,network,address,active,created_at,updated_at
   FROM deposit_wallet_addresses WHERE admin_id=? ORDER BY active DESC,asset,network,id DESC`).all(req.user.id);
 const saId=superAdminId();
 const inheritedWallets=req.user.role==='sub_admin'&&saId?db.prepare(`SELECT id,label,asset,network,address,active,created_at,updated_at
   FROM deposit_wallet_addresses WHERE admin_id=? ORDER BY active DESC,asset,network,id DESC`).all(saId).map(w=>({...w,shadowed:ownWallets.some(x=>x.active&&x.asset===w.asset&&x.network===w.network)})):[];
 res.json({role:req.user.role,isGlobal:isSuper(req.user)||req.user.role==='admin',wallets:ownWallets,ownWallets,inheritedWallets});
});
app.post('/api/admin/deposit-wallets',admin,(req,res)=>{
 const label=String(req.body.label||'').trim().slice(0,80)||null;
 const asset=String(req.body.asset||'').toUpperCase();
 const network=String(req.body.network||'').trim().toUpperCase().slice(0,30);
 const address=String(req.body.address||'').trim();
 if(!['BTC','USDT','ETH'].includes(asset))return res.status(400).json({error:'Deposit wallets support BTC, USDT or ETH.'});
 const allowedNetworks=asset==='BTC'?['BITCOIN']:asset==='ETH'?['ERC20','ARBITRUM','BASE','OPTIMISM']:['TRC20','ERC20','BEP20','SOL','POLYGON'];
 if(!allowedNetworks.includes(network))return res.status(400).json({error:`Choose a supported ${asset} network.`});
 if(address.length<8||address.length>180)return res.status(400).json({error:'Enter a valid public receiving address.'});
 const duplicate=db.prepare(`SELECT id FROM deposit_wallet_addresses WHERE admin_id=? AND asset=? AND network=? AND address=?`).get(req.user.id,asset,network,address);
 if(duplicate)return res.status(409).json({error:'This receiving address is already configured.'});
 const info=db.prepare(`INSERT INTO deposit_wallet_addresses(admin_id,label,asset,network,address,active)
   VALUES(?,?,?,?,?,1)`).run(req.user.id,label,asset,network,address);
 logActivity(req.user.id,req.user.id,'deposit_wallet_added',`${asset} ${network} public receiving address added`);
 res.json({ok:true,id:info.lastInsertRowid});
});
app.put('/api/admin/deposit-wallets/:id',admin,(req,res)=>{
 const w=db.prepare('SELECT * FROM deposit_wallet_addresses WHERE id=?').get(req.params.id);
 if(!w||w.admin_id!==req.user.id)return res.status(403).json({error:'Wallet unavailable'});
 const label=String(req.body.label??w.label??'').trim().slice(0,80)||null;
 const asset=String(req.body.asset??w.asset).toUpperCase();
 const network=String(req.body.network??w.network).trim().toUpperCase().slice(0,30);
 const address=String(req.body.address??w.address).trim();
 if(!['BTC','USDT','ETH'].includes(asset))return res.status(400).json({error:'Deposit wallets support BTC, USDT or ETH.'});
 const allowedNetworks=asset==='BTC'?['BITCOIN']:asset==='ETH'?['ERC20','ARBITRUM','BASE','OPTIMISM']:['TRC20','ERC20','BEP20','SOL','POLYGON'];
 if(!allowedNetworks.includes(network)||address.length<8||address.length>180)return res.status(400).json({error:'Enter a valid wallet type, network and public address.'});
 db.prepare(`UPDATE deposit_wallet_addresses SET label=?,asset=?,network=?,address=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(label,asset,network,address,w.id);
 res.json({ok:true});
});
app.post('/api/admin/deposit-wallets/:id/status',admin,(req,res)=>{
 const w=db.prepare('SELECT * FROM deposit_wallet_addresses WHERE id=?').get(req.params.id);
 if(!w||w.admin_id!==req.user.id)return res.status(403).json({error:'Wallet unavailable'});
 db.prepare('UPDATE deposit_wallet_addresses SET active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(req.body.active?1:0,w.id);
 res.json({ok:true});
});
app.delete('/api/admin/deposit-wallets/:id',admin,(req,res)=>{
 const w=db.prepare('SELECT * FROM deposit_wallet_addresses WHERE id=?').get(req.params.id);
 if(!w||w.admin_id!==req.user.id)return res.status(403).json({error:'Wallet unavailable'});
 db.prepare('DELETE FROM deposit_wallet_addresses WHERE id=?').run(w.id);
 res.json({ok:true});
});

// Reference conversion used only to display/credit the platform USD ledger.
// It does not verify a blockchain transaction.
async function depositUsdQuote(asset,amount){
 const a=String(asset||'').toUpperCase(),n=Number(amount);
 if(!['BTC','USDT','ETH'].includes(a)||!Number.isFinite(n)||n<=0)throw new Error('Invalid deposit amount');
 if(a==='USDT')return {rate:1,usd:n};
 let timer;
 try{
   const rows=await Promise.race([
     cryptoCatalog(),
     new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Reference price provider timed out.')),6000)})
   ]);
   const market=rows.find(x=>x.symbol===a);
   if(!market?.price)throw new Error(a+' reference price is temporarily unavailable');
   return {rate:Number(market.price),usd:Number(market.price)*n};
 }finally{if(timer)clearTimeout(timer)}
}
function depositQuoteSigningSecret(){
 return String(process.env.SESSION_SECRET||process.env.OTP_PEPPER||'optitrade-development-deposit-quote').trim();
}
function signDepositQuote(payload){
 const body=Buffer.from(JSON.stringify(payload)).toString('base64url');
 const sig=crypto.createHmac('sha256',depositQuoteSigningSecret()).update(body).digest('base64url');
 return body+'.'+sig;
}
function verifyDepositQuoteToken(token){
 try{
  const parts=String(token||'').split('.');
  if(parts.length!==2)return null;
  const [body,sig]=parts;
  const expected=crypto.createHmac('sha256',depositQuoteSigningSecret()).update(body).digest('base64url');
  const a=Buffer.from(sig),b=Buffer.from(expected);
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return null;
  const p=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
  if(!p||Number(p.exp)<Date.now())return null;
  if(!['BTC','USDT','ETH'].includes(String(p.asset||'').toUpperCase()))return null;
  if(!(Number(p.usd)>0)||!(Number(p.rate)>0)||!(Number(p.cryptoAmount)>0))return null;
  return p;
 }catch{return null}
}
app.get('/api/deposit/quote',auth,async(req,res)=>{
 const asset=String(req.query.asset||'').toUpperCase(),amount=Number(req.query.amount),usd=Number(req.query.usd);
 try{
   if(Number.isFinite(usd)&&usd>0){
     const one=await depositUsdQuote(asset,1);
     const cryptoAmount=usd/Number(one.rate);
     const exp=Date.now()+10*60*1000;
     const quoteToken=signDepositQuote({asset,usd,rate:Number(one.rate),cryptoAmount,exp});
     return res.json({asset,usdValue:usd,usdRate:Number(one.rate),cryptoAmount,quoteToken,quoteExpiresAt:exp,reference:true,updatedAt:new Date().toISOString()});
   }
   const q=await depositUsdQuote(asset,amount);
   res.json({asset,amount,usdValue:q.usd,usdRate:q.rate,cryptoAmount:amount,reference:true,updatedAt:new Date().toISOString()});
 }catch(e){res.status(503).json({error:e.message||'Deposit reference price unavailable'})}
});

function effectiveDepositWalletsForUser(user){
 const saId=superAdminId();
 const global=saId?db.prepare(`SELECT id,label,asset,network,address,admin_id FROM deposit_wallet_addresses WHERE admin_id=? AND active=1 AND asset IN ('BTC','USDT','ETH') ORDER BY asset,network,id`).all(saId):[];
 const adminId=customerAdminId(user);
 if(!adminId)return global.map(w=>({...w,scope:'global'}));
 const local=db.prepare(`SELECT id,label,asset,network,address,admin_id FROM deposit_wallet_addresses WHERE admin_id=? AND active=1 AND asset IN ('BTC','USDT','ETH') ORDER BY asset,network,id`).all(adminId);
 const overridden=new Set(local.map(w=>`${w.asset}|${w.network}`));
 return [...global.filter(w=>!overridden.has(`${w.asset}|${w.network}`)).map(w=>({...w,scope:'global'})),...local.map(w=>({...w,scope:'admin'}))]
   .sort((a,b)=>String(a.asset).localeCompare(String(b.asset))||String(a.network).localeCompare(String(b.network))||Number(a.id)-Number(b.id));
}
function effectiveDepositWalletByIdForUser(user,walletId,asset=null,network=null){
 return effectiveDepositWalletsForUser(user).find(w=>Number(w.id)===Number(walletId)&&(!asset||w.asset===asset)&&(!network||w.network===network))||null;
}

// Customer sees Super Admin global receiving wallets, with per-network Sub-Admin overrides for assigned customers.
app.get('/api/deposit/options',auth,(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required'});
 const wallets=effectiveDepositWalletsForUser(req.user).map(w=>({id:w.id,label:w.label,asset:w.asset,network:w.network,address:w.address,scope:w.scope}));
 res.json({wallets});
});
app.get('/api/deposit/qr',auth,async(req,res)=>{
 if(req.user.role!=='user')return res.status(403).end();
 const walletId=Number(req.query.walletId);
 if(!walletId)return res.status(400).end();
 const w=effectiveDepositWalletByIdForUser(req.user,walletId);
 if(!w)return res.status(404).end();
 try{
   const png=await QRCode.toBuffer(w.address,{type:'png',width:260,margin:2,errorCorrectionLevel:'M'});
   res.set('Cache-Control','no-store');
   res.type('png').send(png);
 }catch(e){res.status(500).end()}
});
app.get('/api/deposits',auth,(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required'});
 res.json({deposits:db.prepare(`SELECT id,reference,asset,network,wallet_address,amount,usd_value,usd_rate,source,txid,status,review_reason,created_at,reviewed_at,
   chain_verification_status,chain_verified_amount,chain_id,chain_verification_note,chain_verified_at,
   payment_marked_sent_at,receipt_issued_at,credited_usd,credited_rate,credit_note,requested_usd,amount_input_mode,
   credit_corrected_at,credit_correction_reason
   FROM deposit_requests WHERE user_id=? ORDER BY id DESC LIMIT 80`).all(req.user.id)});
});
app.get('/api/deposits/:id/receipt',auth,(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required'});
 const d=db.prepare(`SELECT id,reference,asset,network,wallet_address,amount,usd_value,usd_rate,source,txid,status,review_reason,created_at,reviewed_at,
   payment_marked_sent_at,receipt_issued_at,credited_usd,credited_rate,credit_note,requested_usd,amount_input_mode,
   credit_corrected_at,credit_correction_reason,
   chain_verification_status,chain_verified_amount,chain_id,chain_verification_note,chain_verified_at
   FROM deposit_requests WHERE id=? AND user_id=?`).get(req.params.id,req.user.id);
 if(!d)return res.status(404).json({error:'Deposit receipt not found.'});
 res.set('Cache-Control','no-store');
 res.json({receipt:{
   ...d,
   receiptNumber:d.reference,
   receiptStatus:d.status==='approved'?'Approved & Credited':d.status==='rejected'?'Declined':'Payment Submitted • Pending Review'
 }});
});
app.post('/api/deposits',auth,async(req,res)=>{
 const startedAt=Date.now();
 try{
  if(req.user.role!=='user')return res.status(403).json({error:'Customer account required'});
  const asset=String(req.body.asset||'').toUpperCase();
  const network=String(req.body.network||'').trim().toUpperCase();
  const requestedUsd=Number(req.body.requestedUsd);
  const legacyAmount=Number(req.body.amount);
  const walletId=Number(req.body.walletId);
  const txid=String(req.body.txid||'').trim().slice(0,180);
  const note=String(req.body.note||'').trim().slice(0,300);
  const clientRequestId=String(req.body.clientRequestId||'').trim().slice(0,100)||null;

  console.log(`[DEPOSIT REQUEST] user=${req.user.id} asset=${asset||'missing'} network=${network||'missing'} usd=${Number.isFinite(requestedUsd)?requestedUsd:'n/a'} request=${clientRequestId||'none'}`);

  if(!['BTC','USDT','ETH'].includes(asset)||!network||!walletId)
    return res.status(400).json({error:'Choose a BTC/USDT/ETH receiving wallet.'});

  // If a prior browser request timed out after the receipt was already created,
  // return the original receipt instead of creating a duplicate.
  if(clientRequestId){
    const existing=db.prepare(`SELECT id,reference,status,requested_usd,amount,usd_value FROM deposit_requests
      WHERE user_id=? AND client_request_id=? LIMIT 1`).get(req.user.id,clientRequestId);
    if(existing){
      console.log(`[DEPOSIT IDEMPOTENT] user=${req.user.id} receipt=${existing.reference}`);
      return res.status(200).json({
        ok:true,id:Number(existing.id),reference:existing.reference,receiptNumber:existing.reference,
        receiptHref:`/deposit-receipt.html?id=${existing.id}`,status:existing.status||'pending',
        requestedUsd:existing.requested_usd==null?null:Number(existing.requested_usd),
        expectedCryptoAmount:Number(existing.amount||0),estimatedUsd:existing.usd_value==null?null:Number(existing.usd_value),
        duplicateSafe:true
      });
    }
  }

  const w=effectiveDepositWalletByIdForUser(req.user,walletId,asset,network);
  if(!w)return res.status(400).json({error:'That deposit wallet is not currently available for your account.'});

  let amount,quote,inputMode;
  if(Number.isFinite(requestedUsd)&&requestedUsd>0){
    if(requestedUsd<1||requestedUsd>10000000)
      return res.status(400).json({error:'Enter a USD deposit amount between $1 and $10,000,000.'});

    // The browser already received this signed quote when it displayed the crypto amount.
    // Do not block receipt creation on another external market-price request.
    const signed=verifyDepositQuoteToken(req.body.quoteToken);
    if(!signed||String(signed.asset).toUpperCase()!==asset||Math.abs(Number(signed.usd)-requestedUsd)>0.01){
      return res.status(409).json({error:'Your deposit quote expired. Close the deposit window, reopen it, and try again.'});
    }
    amount=Number(signed.cryptoAmount);
    quote={usd:requestedUsd,rate:Number(signed.rate)};
    inputMode='usd';
  }else{
    if(!Number.isFinite(legacyAmount)||legacyAmount<=0)
      return res.status(400).json({error:'Enter the USD amount you want to deposit.'});
    amount=legacyAmount;
    inputMode='crypto_legacy';
    // Legacy records should not hold the submit request open on an external price provider.
    quote=null;
  }

  if(!(Number(amount)>0)||!(Number(quote?.rate||1)>0))
    return res.status(400).json({error:'The displayed deposit quote is invalid. Reopen the deposit window and try again.'});

  const ref=depositRef();
  const ins=db.prepare(`INSERT INTO deposit_requests(
      reference,user_id,owner_admin_id,wallet_admin_id,asset,network,wallet_address,amount,
      usd_value,usd_rate,source,txid,status,user_note,payment_marked_sent_at,receipt_issued_at,
      requested_usd,amount_input_mode,client_request_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?, 'customer',?,'pending',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?,?,?)`).run(
      ref,req.user.id,req.user.owner_admin_id||null,w.admin_id,asset,network,w.address,amount,
      quote?.usd||null,quote?.rate||null,txid||null,note,
      inputMode==='usd'?requestedUsd:null,inputMode,clientRequestId
    );

  const depositId=Number(ins.lastInsertRowid);
  const receiptHref=`/deposit-receipt.html?id=${depositId}`;
  const moneyLabel=inputMode==='usd'
    ?`$${requestedUsd.toFixed(2)} deposit request • expected ${amount.toLocaleString(undefined,{maximumFractionDigits:10})} ${asset}`
    :`${amount} ${asset}`;

  // IMPORTANT: respond to the customer immediately after the receipt is safely stored.
  // Blockchain verification, emails, notifications, and activity logging happen afterward.
  console.log(`[DEPOSIT RECEIPT] ${ref} created in ${Date.now()-startedAt}ms`);
  res.status(202).json({
    ok:true,id:depositId,reference:ref,receiptNumber:ref,receiptHref,status:'pending',
    requestedUsd:inputMode==='usd'?requestedUsd:null,
    expectedCryptoAmount:amount,estimatedUsd:quote?.usd||null,
    chainVerification:{status:txid?'checking':'not_checked',chainId:null,note:txid?'Verification continues in the background.':'No transaction hash supplied for automatic verification.',verifiedAmount:null}
  });

  // Snapshot values before the request object is released.
  const userId=Number(req.user.id);
  const userName=String(req.user.name||req.user.username||'Customer');
  const ownerAdminId=req.user.owner_admin_id||null;
  const walletAdminId=w.admin_id||null;

  setImmediate(async()=>{
    try{
      if(txid){
        const verification=await verifyDepositOnChain({asset,network,walletAddress:w.address,amount,txid});
        saveDepositVerification(depositId,verification);
        console.log(`[DEPOSIT CHAIN] ${ref} ${verification.status}`);
      }
    }catch(e){
      console.error(`[DEPOSIT CHAIN] ${ref}`,e.message||e);
    }

    try{
      notifyAndEmail(userId,'deposit','Deposit receipt created',
        `${moneyLabel} on ${network} was marked as sent and is now pending administrator review. Receipt: ${ref}.`,
        receiptHref);
    }catch(e){console.error(`[DEPOSIT CUSTOMER NOTICE] ${ref}`,e.message||e)}

    try{
      const reviewer=ownerAdminId||walletAdminId;
      notifyUrgentAdminEvent(reviewer,'deposit','Payment marked sent',
        `${userName} marked ${moneyLabel} on ${network} as sent. Review the payment and Accept & Credit or Decline. Receipt: ${ref}`,
        '/admin/deposits.html');
    }catch(e){console.error(`[DEPOSIT ADMIN NOTICE] ${ref}`,e.message||e)}

    try{
      logActivity(userId,userId,'deposit_submitted',`${moneyLabel} marked sent • receipt ${ref} • pending review`);
    }catch(e){console.error(`[DEPOSIT ACTIVITY] ${ref}`,e.message||e)}
  });
 }catch(e){
  console.error('[DEPOSIT SUBMIT ERROR]',e);
  if(!res.headersSent)res.status(500).json({error:'OptiTrade could not create the deposit receipt. Please try again.'});
 }
});
function canReviewDeposit(actor,d){return isSuper(actor)||actor.role==='admin'||(actor.role==='sub_admin'&&d.owner_admin_id===actor.id)}
app.get('/api/admin/deposits',admin,(req,res)=>{
 const full=isSuper(req.user)||req.user.role==='admin';
 const sql=`SELECT d.*,u.name,u.username,u.email FROM deposit_requests d JOIN users u ON u.id=d.user_id
   ${full?'':'WHERE d.owner_admin_id=?'} ORDER BY CASE d.status WHEN 'pending' THEN 0 ELSE 1 END,d.id DESC`;
 const rows=full?db.prepare(sql).all():db.prepare(sql).all(req.user.id);
 res.json({deposits:rows,canCorrect:isSuper(req.user)});
});
app.post('/api/admin/deposits/:id/verify-chain',admin,async(req,res)=>{
 const d=db.prepare('SELECT * FROM deposit_requests WHERE id=?').get(req.params.id);
 if(!d||!canReviewDeposit(req.user,d))return res.status(403).json({error:'Deposit request unavailable'});
 if(!d.txid)return res.status(400).json({error:'This request has no transaction hash to verify.'});
 const v=await verifyDepositOnChain({asset:d.asset,network:d.network,walletAddress:d.wallet_address,amount:d.amount,txid:d.txid});
 saveDepositVerification(d.id,v);
 res.json({ok:true,verification:v});
});

app.post('/api/admin/deposits/:id/review',admin,async(req,res)=>{
 const d=db.prepare('SELECT * FROM deposit_requests WHERE id=?').get(req.params.id);
 if(!d||!canReviewDeposit(req.user,d))return res.status(403).json({error:'Deposit request unavailable'});
 if(d.status!=='pending')return res.status(409).json({error:`This deposit is already ${d.status}. It cannot be credited twice.`});
 const decision=req.body.decision==='approve'?'approved':req.body.decision==='reject'?'rejected':null;
 const reason=String(req.body.reason||'').trim().slice(0,300);
 const creditNote=String(req.body.creditNote||'').trim().slice(0,300);
 if(!decision)return res.status(400).json({error:'Choose Accept & Credit or Decline.'});
 if(decision==='rejected'&&reason.length<4)return res.status(400).json({error:'Enter a decline reason for the customer.'});
 if(decision==='approved'&&['mismatch','reverted'].includes(String(d.chain_verification_status||'')))
   return res.status(409).json({error:'On-chain verification found a mismatch or reverted transaction. Decline this request or correct/resubmit the transaction instead of crediting it.'});

 let storedUsd=Number(d.requested_usd||d.usd_value),storedRate=Number(d.usd_rate);
 if(decision==='approved'&&(!(storedUsd>0)||!(storedRate>0))){
   try{const q=await depositUsdQuote(d.asset,d.amount);storedUsd=q.usd;storedRate=q.rate}
   catch(e){return res.status(503).json({error:'Could not obtain a USD reference value for this deposit. Try again shortly.'})}
 }
 let creditUsd=null,creditRate=null;
 if(decision==='approved'){
   const requestedCredit=Number(req.body.creditUsd);
   creditUsd=Number.isFinite(requestedCredit)&&requestedCredit>0?requestedCredit:storedUsd;
   if(!(creditUsd>0))return res.status(400).json({error:'Enter the USD amount to credit to the customer account.'});
   if(creditUsd>100000000)return res.status(400).json({error:'Credit amount is outside the supported range.'});
   creditRate=creditUsd/Number(d.amount);
 }
 const receiptHref=`/deposit-receipt.html?id=${d.id}`;
 try{
  db.transaction(()=>{
   const changed=db.prepare(`UPDATE deposit_requests SET status=?,review_reason=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,
     usd_value=COALESCE(usd_value,?),usd_rate=COALESCE(usd_rate,?),credited_usd=?,credited_rate=?,credit_note=?
     WHERE id=? AND status='pending'`)
     .run(decision,reason||null,req.user.id,storedUsd||null,storedRate||null,creditUsd,creditRate,creditNote||null,d.id);
   if(changed.changes!==1)throw new Error('ALREADY_REVIEWED');
   if(decision==='approved'){
     seedSectionBalances(d.user_id);
     const b=db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='wallet' AND asset='USD'").get(d.user_id);
     const after=Number(b?.amount||0)+creditUsd;
     db.prepare("UPDATE section_balances SET amount=? WHERE user_id=? AND section='wallet' AND asset='USD'").run(after,d.user_id);
     db.prepare("UPDATE balances SET amount=? WHERE user_id=? AND asset='USD'").run(after,d.user_id);
     db.prepare("INSERT INTO demo_transactions(reference,user_id,actor_id,type,asset,amount,direction,status,note) VALUES(?,?,?,?,?,?,'credit','completed',?)")
       .run(d.reference,d.user_id,req.user.id,'approved_deposit','USD',creditUsd,`Accepted ${d.amount} ${d.asset} deposit • ${d.network} • credited $${creditUsd.toFixed(2)} USD`);
     logActivity(d.user_id,req.user.id,'deposit_approved',`Deposit ${d.reference} accepted • $${creditUsd.toFixed(2)} USD credited`);
   }else{
     logActivity(d.user_id,req.user.id,'deposit_rejected',`Deposit ${d.reference} declined • ${reason}`);
   }
  })();
 }catch(e){
  if(e.message==='ALREADY_REVIEWED')return res.status(409).json({error:'This deposit was reviewed by another administrator.'});
  throw e;
 }
 if(decision==='approved'){
   notifyAndEmail(d.user_id,'deposit','Deposit accepted & credited',`Your deposit receipt ${d.reference} was accepted. $${creditUsd.toFixed(2)} USD has been credited to your wallet for ${d.amount} ${d.asset} on ${d.network}.${creditNote?` Note: ${creditNote}`:''}`,receiptHref);
 }else{
   notifyAndEmail(d.user_id,'deposit','Deposit declined',`Your deposit receipt ${d.reference} was declined. Reason: ${reason}. No account credit was applied.`,receiptHref);
 }
 res.json({ok:true,status:decision,creditUsd:decision==='approved'?creditUsd:null,receiptHref});
});


app.post('/api/admin/deposits/:id/correct-credit',superAdmin,(req,res)=>{
 const d=db.prepare('SELECT * FROM deposit_requests WHERE id=?').get(req.params.id);
 if(!d)return res.status(404).json({error:'Deposit not found.'});
 if(d.status!=='approved')return res.status(409).json({error:'Only an approved deposit can have its credited USD corrected.'});
 const previous=Number(d.credited_usd??d.usd_value??0),corrected=Number(req.body.correctedUsd),reason=String(req.body.reason||'').trim().slice(0,500);
 if(!(corrected>0)||corrected>10000000)return res.status(400).json({error:'Enter the correct USD credit between $0.01 and $10,000,000.'});
 if(reason.length<5)return res.status(400).json({error:'Enter a clear correction reason.'});
 if(Math.abs(corrected-previous)<0.005)return res.status(400).json({error:'The corrected amount is the same as the current credited amount.'});
 seedSectionBalances(d.user_id);
 const delta=Number((corrected-previous).toFixed(8));
 const wallet=Number(db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='wallet' AND asset='USD'").get(d.user_id)?.amount||0);
 const reserved=withdrawalReserved(d.user_id,'USD');
 const after=wallet+delta;
 if(after<reserved-1e-8)return res.status(409).json({error:`The wallet does not have enough free USD to apply this correction. Available after withdrawal reserves: $${Math.max(0,wallet-reserved).toFixed(2)}. Reverse/move other balances first.`});
 const ref='OT-COR-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(3).toString('hex').toUpperCase();
 db.transaction(()=>{
   db.prepare("UPDATE section_balances SET amount=? WHERE user_id=? AND section='wallet' AND asset='USD'").run(after,d.user_id);
   db.prepare("UPDATE balances SET amount=? WHERE user_id=? AND asset='USD'").run(after,d.user_id);
   db.prepare(`UPDATE deposit_requests SET credited_usd=?,credited_rate=?,credit_corrected_at=CURRENT_TIMESTAMP,credit_corrected_by=?,credit_correction_reason=? WHERE id=?`)
     .run(corrected,corrected/Number(d.amount||1),req.user.id,reason,d.id);
   db.prepare(`INSERT INTO deposit_credit_corrections(deposit_id,user_id,previous_usd,corrected_usd,delta_usd,reason,corrected_by) VALUES(?,?,?,?,?,?,?)`)
     .run(d.id,d.user_id,previous,corrected,delta,reason,req.user.id);
   db.prepare("INSERT INTO demo_transactions(reference,user_id,actor_id,type,asset,amount,direction,status,note) VALUES(?,?,?,?,?,?,?,'completed',?)")
     .run(ref,d.user_id,req.user.id,'deposit_credit_correction','USD',Math.abs(delta),delta>=0?'credit':'debit',`Deposit ${d.reference} corrected from $${previous.toFixed(2)} to $${corrected.toFixed(2)} • ${reason}`);
   logActivity(d.user_id,req.user.id,'deposit_credit_correction',`Deposit ${d.reference} credit corrected from $${previous.toFixed(2)} to $${corrected.toFixed(2)}.`);
 })();
 notifyAndEmail(d.user_id,'deposit','Deposit credit corrected',`The USD credit for deposit receipt ${d.reference} was corrected from $${previous.toFixed(2)} to $${corrected.toFixed(2)}. Reason: ${reason}` ,`/deposit-receipt.html?id=${d.id}`);
 res.json({ok:true,previousUsd:previous,correctedUsd:corrected,deltaUsd:delta,walletUsd:after,reference:ref});
});

// Admin manual crypto deposit: BTC or USDT in, USD ledger credit out.
app.post('/api/admin/users-v2/:id/manual-deposit',admin,async(req,res)=>{
 const uid=Number(req.params.id);
 if(!ownsUser(req.user,uid))return res.status(403).json({error:'You do not have access to this customer'});
 const user=db.prepare("SELECT id,name,owner_admin_id FROM users WHERE id=? AND role='user'").get(uid);
 if(!user)return res.status(404).json({error:'Customer not found'});
 const asset=String(req.body.asset||'').toUpperCase();
 const network=String(req.body.network||'').trim().toUpperCase().slice(0,30);
 const amount=Number(req.body.amount);
 const txid=String(req.body.txid||'').trim().slice(0,180);
 const note=String(req.body.note||'').trim().slice(0,300);
 if(!['BTC','USDT'].includes(asset)||!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:'Manual deposits accept BTC or USDT only.'});
 const allowed=asset==='BTC'?['BITCOIN']:['TRC20','ERC20','BEP20','SOL','POLYGON'];
 if(!allowed.includes(network))return res.status(400).json({error:'Choose a supported network.'});
 let quote;try{quote=await depositUsdQuote(asset,amount)}catch(e){return res.status(503).json({error:e.message||'USD reference value unavailable'})}
 const ref=depositRef();
 db.transaction(()=>{
   db.prepare(`INSERT INTO deposit_requests(reference,user_id,owner_admin_id,wallet_admin_id,asset,network,wallet_address,amount,usd_value,usd_rate,source,txid,status,user_note,review_reason,reviewed_by,reviewed_at,credited_usd,credited_rate,receipt_issued_at,amount_input_mode)
     VALUES(?,?,?,?,?,?,?,?,?,?, 'admin_manual',?,'approved',?,?,?,CURRENT_TIMESTAMP,?,?,CURRENT_TIMESTAMP,'crypto_admin')`)
     .run(ref,uid,user.owner_admin_id||null,req.user.id,asset,network,'ADMIN MANUAL CREDIT',amount,quote.usd,quote.rate,txid||null,note||null,note||'Admin-recorded crypto deposit',req.user.id,quote.usd,quote.rate);
   seedSectionBalances(uid);
   const b=db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='wallet' AND asset='USD'").get(uid);
   const after=Number(b?.amount||0)+quote.usd;
   db.prepare("UPDATE section_balances SET amount=? WHERE user_id=? AND section='wallet' AND asset='USD'").run(after,uid);
   db.prepare("UPDATE balances SET amount=? WHERE user_id=? AND asset='USD'").run(after,uid);
   db.prepare("INSERT INTO demo_transactions(reference,user_id,actor_id,type,asset,amount,direction,status,note) VALUES(?,?,?,?,?,?,'credit','completed',?)")
     .run(ref,uid,req.user.id,'manual_crypto_deposit','USD',quote.usd,`${amount} ${asset} • ${network} • reference rate ${quote.rate}`);
   logActivity(uid,req.user.id,'manual_deposit',`$${quote.usd.toFixed(2)} USD credited from ${amount} ${asset} manual deposit`);
 });
 notifyAndEmail(uid,'deposit','Deposit recorded',`$${quote.usd.toFixed(2)} was credited to your USD wallet. Crypto deposit: ${amount} ${asset} on ${network}. Reference: ${ref}`,'/deposit.html');
 res.json({ok:true,reference:ref,asset,amount,usdValue:quote.usd,usdRate:quote.rate});
});

function validateWelcomePayload(body){
 const active=body.active?1:0;
 const emailSubject=String(body.emailSubject||'').trim().slice(0,180),emailBody=String(body.emailBody||'').trim().slice(0,8000),notificationTitle=String(body.notificationTitle||'').trim().slice(0,120),notificationBody=String(body.notificationBody||'').trim().slice(0,1000),supportBody=String(body.supportBody||'').trim().slice(0,5000);
 if(active&&(!emailSubject||!emailBody||!notificationTitle||!notificationBody||!supportBody))throw new Error('Complete all welcome message fields before activating the welcome workflow.');
 const combined=[emailSubject,emailBody,notificationTitle,notificationBody,supportBody].join('\n');
 const tokens=[...combined.matchAll(/\{\{([^}]+)\}\}/g)].map(m=>m[1]),bad=tokens.filter(k=>!WELCOME_KEYS.has(k));
 if(bad.length)throw new Error(`Unsupported placeholder: {{${bad[0]}}}`);
 return {active,emailSubject,emailBody,notificationTitle,notificationBody,supportBody};
}
app.get('/api/admin/customer-welcome',admin,(req,res)=>{
 const global=db.prepare('SELECT id,active,email_subject,email_body,notification_title,notification_body,support_body,updated_by,updated_at FROM welcome_settings WHERE id=1').get();
 const local=req.user.role==='sub_admin'?db.prepare('SELECT * FROM welcome_admin_overrides WHERE admin_id=?').get(req.user.id):null;
 res.json({role:req.user.role,isOverride:!!local,settings:local||global,globalSettings:global,placeholders:[...WELCOME_KEYS].map(k=>`{{${k}}}`)});
});
app.put('/api/admin/customer-welcome',admin,(req,res)=>{
 let p;try{p=validateWelcomePayload(req.body)}catch(e){return res.status(400).json({error:e.message})}
 if(isSuper(req.user)||req.user.role==='admin'){
   db.prepare(`UPDATE welcome_settings SET active=?,email_subject=?,email_body=?,notification_title=?,notification_body=?,support_body=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=1`).run(p.active,p.emailSubject,p.emailBody,p.notificationTitle,p.notificationBody,p.supportBody,req.user.id);
   return res.json({ok:true,scope:'global'});
 }
 db.prepare(`INSERT INTO welcome_admin_overrides(admin_id,active,email_subject,email_body,notification_title,notification_body,support_body,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
   ON CONFLICT(admin_id) DO UPDATE SET active=excluded.active,email_subject=excluded.email_subject,email_body=excluded.email_body,notification_title=excluded.notification_title,notification_body=excluded.notification_body,support_body=excluded.support_body,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`)
   .run(req.user.id,p.active,p.emailSubject,p.emailBody,p.notificationTitle,p.notificationBody,p.supportBody,req.user.id);
 res.json({ok:true,scope:'admin'});
});
app.delete('/api/admin/customer-welcome',admin,(req,res)=>{
 if(req.user.role!=='sub_admin')return res.status(400).json({error:'Only Sub-Admin welcome overrides can be reset.'});
 db.prepare('DELETE FROM welcome_admin_overrides WHERE admin_id=?').run(req.user.id);res.json({ok:true});
});
app.post('/api/admin/customer-welcome/preview',admin,(req,res)=>{
 const where=scopedUserWhere(req.user,'u');
 const customer=db.prepare(`SELECT u.name,u.username,u.email,u.created_at FROM users u WHERE ${where} ORDER BY u.id DESC LIMIT 1`).get();
 const sample=customer||{name:'Customer',username:'',email:'',created_at:new Date().toISOString()};
 res.json({emailSubject:renderWelcomeTemplate(String(req.body.emailSubject||''),sample),emailBody:renderWelcomeTemplate(String(req.body.emailBody||''),sample),notificationTitle:renderWelcomeTemplate(String(req.body.notificationTitle||''),sample),notificationBody:renderWelcomeTemplate(String(req.body.notificationBody||''),sample),supportBody:renderWelcomeTemplate(String(req.body.supportBody||''),sample)});
});
app.get('/api/admin/customer-faqs',admin,(req,res)=>{
 const global=db.prepare('SELECT id,question,answer,active,sort_order,updated_at FROM support_faqs ORDER BY sort_order,id').all();
 if(req.user.role!=='sub_admin')return res.json({role:req.user.role,isOverride:false,faqs:global,globalFaqs:global,maxItems:30});
 const meta=db.prepare('SELECT has_override FROM support_faq_admin_meta WHERE admin_id=?').get(req.user.id),isOverride=Number(meta?.has_override||0)===1;
 const local=isOverride?db.prepare('SELECT id,question,answer,active,sort_order,updated_at FROM support_faq_admin_items WHERE admin_id=? ORDER BY sort_order,id').all(req.user.id):global;
 res.json({role:req.user.role,isOverride,faqs:local,globalFaqs:global,maxItems:30});
});
app.put('/api/admin/customer-faqs',admin,(req,res)=>{
 const incoming=Array.isArray(req.body.faqs)?req.body.faqs:[];if(incoming.length>30)return res.status(400).json({error:'Use no more than 30 quick help questions.'});
 const clean=incoming.map((x,i)=>({question:String(x.question||'').trim().slice(0,180),answer:String(x.answer||'').trim().slice(0,3000),active:x.active!==false?1:0,sortOrder:i+1}));
 if(clean.some(x=>!x.question||!x.answer))return res.status(400).json({error:'Every quick help item needs both a question and an answer.'});
 if(isSuper(req.user)||req.user.role==='admin'){
   db.transaction(()=>{db.prepare('DELETE FROM support_faqs').run();const ins=db.prepare('INSERT INTO support_faqs(question,answer,active,sort_order,updated_by) VALUES(?,?,?,?,?)');for(const x of clean)ins.run(x.question,x.answer,x.active,x.sortOrder,req.user.id);db.prepare('DELETE FROM support_faq_reads').run();db.prepare('DELETE FROM support_faq_reads_v2 WHERE scope=\'global\'').run();db.prepare('UPDATE support_faq_meta SET seeded=1 WHERE id=1').run()})();
   return res.json({ok:true,scope:'global',faqs:db.prepare('SELECT id,question,answer,active,sort_order,updated_at FROM support_faqs ORDER BY sort_order,id').all()});
 }
 db.transaction(()=>{db.prepare('DELETE FROM support_faq_admin_items WHERE admin_id=?').run(req.user.id);const ins=db.prepare('INSERT INTO support_faq_admin_items(admin_id,question,answer,active,sort_order) VALUES(?,?,?,?,?)');for(const x of clean)ins.run(req.user.id,x.question,x.answer,x.active,x.sortOrder);db.prepare(`INSERT INTO support_faq_admin_meta(admin_id,has_override,updated_at) VALUES(?,1,CURRENT_TIMESTAMP) ON CONFLICT(admin_id) DO UPDATE SET has_override=1,updated_at=CURRENT_TIMESTAMP`).run(req.user.id);db.prepare(`DELETE FROM support_faq_reads_v2 WHERE scope='admin' AND user_id IN (SELECT id FROM users WHERE owner_admin_id=? AND role='user')`).run(req.user.id)})();
 res.json({ok:true,scope:'admin',faqs:db.prepare('SELECT id,question,answer,active,sort_order,updated_at FROM support_faq_admin_items WHERE admin_id=? ORDER BY sort_order,id').all(req.user.id)});
});
app.delete('/api/admin/customer-faqs',admin,(req,res)=>{
 if(req.user.role!=='sub_admin')return res.status(400).json({error:'Only Sub-Admin quick-help overrides can be reset.'});
 db.transaction(()=>{db.prepare('DELETE FROM support_faq_admin_items WHERE admin_id=?').run(req.user.id);db.prepare(`INSERT INTO support_faq_admin_meta(admin_id,has_override,updated_at) VALUES(?,0,CURRENT_TIMESTAMP) ON CONFLICT(admin_id) DO UPDATE SET has_override=0,updated_at=CURRENT_TIMESTAMP`).run(req.user.id);db.prepare(`DELETE FROM support_faq_reads_v2 WHERE scope='admin' AND user_id IN (SELECT id FROM users WHERE owner_admin_id=? AND role='user')`).run(req.user.id)})();
 res.json({ok:true});
});

// Super Admin: manage customer Support quick questions.
app.get('/api/super/support-faqs',superAdmin,(req,res)=>{
 const faqs=db.prepare('SELECT id,question,answer,active,sort_order,updated_at FROM support_faqs ORDER BY sort_order ASC,id ASC').all();
 res.set('Cache-Control','no-store');
 res.json({faqs,maxItems:30});
});
app.put('/api/super/support-faqs',superAdmin,(req,res)=>{
 const incoming=Array.isArray(req.body.faqs)?req.body.faqs:[];
 if(incoming.length>30)return res.status(400).json({error:'Use no more than 30 quick help questions.'});
 const clean=incoming.map((x,i)=>({
   id:Number(x.id)||null,
   question:String(x.question||'').trim().slice(0,180),
   answer:String(x.answer||'').trim().slice(0,3000),
   active:x.active!==false?1:0,
   sortOrder:i+1
 }));
 for(const x of clean){
   if(!x.question||!x.answer)return res.status(400).json({error:'Every quick help item needs both a question and an answer. Remove empty items instead.'});
 }
 db.transaction(()=>{
   const kept=[];
   for(const x of clean){
     const existing=x.id?db.prepare('SELECT id FROM support_faqs WHERE id=?').get(x.id):null;
     if(existing){
       db.prepare(`UPDATE support_faqs SET question=?,answer=?,active=?,sort_order=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
         .run(x.question,x.answer,x.active,x.sortOrder,req.user.id,x.id);
       kept.push(x.id);
     }else{
       const info=db.prepare(`INSERT INTO support_faqs(question,answer,active,sort_order,updated_by) VALUES(?,?,?,?,?)`)
         .run(x.question,x.answer,x.active,x.sortOrder,req.user.id);
       kept.push(Number(info.lastInsertRowid));
     }
   }
   if(kept.length){
     const placeholders=kept.map(()=>'?').join(',');
     db.prepare(`DELETE FROM support_faqs WHERE id NOT IN (${placeholders})`).run(...kept);
   }else{
     db.prepare('DELETE FROM support_faqs').run();
   }
   db.prepare('DELETE FROM support_faq_reads WHERE faq_id NOT IN (SELECT id FROM support_faqs)').run();
   db.prepare('UPDATE support_faq_meta SET seeded=1 WHERE id=1').run();
 })();
 res.json({ok:true,faqs:db.prepare('SELECT id,question,answer,active,sort_order,updated_at FROM support_faqs ORDER BY sort_order,id').all()});
});

// Super Admin: manage the platform-wide welcome message.
app.get('/api/super/welcome-settings',superAdmin,(req,res)=>{
 const s=db.prepare('SELECT id,active,email_subject,email_body,notification_title,notification_body,support_body,updated_by,updated_at FROM welcome_settings WHERE id=1').get();
 res.json({settings:s,placeholders:[...WELCOME_KEYS].map(k=>`{{${k}}}`)});
});
app.put('/api/super/welcome-settings',superAdmin,(req,res)=>{
 const active=req.body.active?1:0;
 const emailSubject=String(req.body.emailSubject||'').trim().slice(0,180);
 const emailBody=String(req.body.emailBody||'').trim().slice(0,8000);
 const notificationTitle=String(req.body.notificationTitle||'').trim().slice(0,120);
 const notificationBody=String(req.body.notificationBody||'').trim().slice(0,1000);
 const supportBody=String(req.body.supportBody||'').trim().slice(0,5000);
 if(active && (!emailSubject||!emailBody||!notificationTitle||!notificationBody||!supportBody))
   return res.status(400).json({error:'Complete all welcome message fields before activating the welcome workflow.'});
 const combined=[emailSubject,emailBody,notificationTitle,notificationBody,supportBody].join('\n');
 const tokens=[...combined.matchAll(/\{\{([^}]+)\}\}/g)].map(m=>m[1]);
 const bad=tokens.filter(k=>!WELCOME_KEYS.has(k));
 if(bad.length)return res.status(400).json({error:`Unsupported placeholder: {{${bad[0]}}}`});
 db.prepare(`UPDATE welcome_settings SET active=?,email_subject=?,email_body=?,notification_title=?,notification_body=?,support_body=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=1`)
   .run(active,emailSubject,emailBody,notificationTitle,notificationBody,supportBody,req.user.id);
 res.json({ok:true});
});
app.post('/api/super/welcome-settings/preview',superAdmin,(req,res)=>{
 const customer=db.prepare("SELECT name,username,email,created_at FROM users WHERE role='user' ORDER BY id DESC LIMIT 1").get();
 const sample=customer||{name:'Customer',username:'',email:'',created_at:new Date().toISOString()};
 const body={
  emailSubject:String(req.body.emailSubject||''),
  emailBody:String(req.body.emailBody||''),
  notificationTitle:String(req.body.notificationTitle||''),
  notificationBody:String(req.body.notificationBody||''),
  supportBody:String(req.body.supportBody||'')
 };
 res.json({
  emailSubject:renderWelcomeTemplate(body.emailSubject,sample),
  emailBody:renderWelcomeTemplate(body.emailBody,sample),
  notificationTitle:renderWelcomeTemplate(body.notificationTitle,sample),
  notificationBody:renderWelcomeTemplate(body.notificationBody,sample),
  supportBody:renderWelcomeTemplate(body.supportBody,sample)
 });
});


// Admin Message Center: Super Admin can message all customers; Sub-Admins are scoped to their own customers.
app.get('/api/admin/message-center/customers',admin,(req,res)=>{
 const where=scopedUserWhere(req.user,'u');
 const rows=db.prepare(`SELECT u.id,u.name,u.username,u.email,u.email_verified,u.owner_admin_id FROM users u WHERE ${where} ORDER BY u.name COLLATE NOCASE`).all();
 res.json({role:req.user.role,customers:rows});
});
app.get('/api/admin/message-center/campaigns',admin,(req,res)=>{
 const rows=(isSuper(req.user)||req.user.role==='admin')
   ? db.prepare(`SELECT c.*,a.name sender_name FROM message_campaigns c LEFT JOIN users a ON a.id=c.sender_admin_id ORDER BY c.id DESC LIMIT 50`).all()
   : db.prepare(`SELECT c.*,a.name sender_name FROM message_campaigns c LEFT JOIN users a ON a.id=c.sender_admin_id WHERE c.sender_admin_id=? ORDER BY c.id DESC LIMIT 50`).all(req.user.id);
 res.json({campaigns:rows});
});
app.get('/api/admin/message-center/campaigns/:id',admin,(req,res)=>{
 const c=db.prepare('SELECT * FROM message_campaigns WHERE id=?').get(req.params.id);
 if(!c || (!(isSuper(req.user)||req.user.role==='admin') && c.sender_admin_id!==req.user.id))return res.status(403).json({error:'Campaign unavailable'});
 const deliveries=db.prepare(`SELECT d.*,u.name,u.username FROM message_deliveries d JOIN users u ON u.id=d.user_id WHERE d.campaign_id=? ORDER BY d.id`).all(c.id);
 res.json({campaign:c,deliveries});
});
app.post('/api/admin/message-center/send',admin,(req,res)=>{
 const subject=String(req.body.subject||'').trim().slice(0,150);
 const body=String(req.body.body||'').trim().slice(0,5000);
 const sendEmail=req.body.sendEmail!==false,sendInapp=req.body.sendInapp!==false;
 const mode=String(req.body.mode||'all');
 const allowedTypes=new Set(['notification','warning','security','deposit','withdrawal','trade','investment','system','announcement']);
 const messageType=allowedTypes.has(String(req.body.messageType||'').toLowerCase())?String(req.body.messageType).toLowerCase():'notification';
 let actionHref=String(req.body.actionHref||'/dashboard.html').trim().slice(0,220);
 if(!actionHref)actionHref='/dashboard.html';
 if(!actionHref.startsWith('/')||actionHref.startsWith('//'))return res.status(400).json({error:'Choose an OptiTrade internal action link.'});
 const actionLabel=String(req.body.actionLabel||'Open OptiTrade').trim().slice(0,40)||'Open OptiTrade';
 const ids=Array.isArray(req.body.userIds)?[...new Set(req.body.userIds.map(Number).filter(Number.isInteger))]:[];
 if(subject.length<3)return res.status(400).json({error:'Enter a subject of at least 3 characters.'});
 if(body.length<5)return res.status(400).json({error:'Enter a message of at least 5 characters.'});
 if(!sendEmail&&!sendInapp)return res.status(400).json({error:'Choose Email, In-App Notification, or both.'});
 let recipients=[];
 if(mode==='selected'){
   if(!ids.length)return res.status(400).json({error:'Select at least one customer.'});
   recipients=ids.map(id=>db.prepare("SELECT id,name,email FROM users WHERE id=? AND role='user'").get(id)).filter(Boolean).filter(u=>ownsUser(req.user,u.id));
 }else{
   const where=scopedUserWhere(req.user,'u');
   recipients=db.prepare(`SELECT u.id,u.name,u.email FROM users u WHERE ${where}`).all();
 }
 if(!recipients.length)return res.status(400).json({error:'No eligible customers were found for this message.'});
 const info=db.prepare(`INSERT INTO message_campaigns(sender_admin_id,subject,body,send_email,send_inapp,audience,status,total,message_type,action_href,action_label)
 VALUES(?,?,?,?,?,?,'queued',?,?,?,?)`).run(req.user.id,subject,body,sendEmail?1:0,sendInapp?1:0,mode,recipients.length,messageType,actionHref,actionLabel);
 const ins=db.prepare("INSERT OR IGNORE INTO message_deliveries(campaign_id,user_id,email,email_status,inapp_status) VALUES(?,?,?,?,?)");
 const tx=db.transaction(()=>{for(const u of recipients)ins.run(info.lastInsertRowid,u.id,u.email,sendEmail?'pending':'skipped',sendInapp?'pending':'skipped')});tx();
 setImmediate(()=>processCampaign(info.lastInsertRowid).catch(e=>{console.error('[MESSAGE CAMPAIGN]',e);db.prepare("UPDATE message_campaigns SET status='failed' WHERE id=?").run(info.lastInsertRowid)}));
 res.json({ok:true,campaignId:info.lastInsertRowid,queued:recipients.length,messageType});
});


// Super Admin: create/revoke one-time expirable invitations and manage sub-admins.
app.get('/api/super/admins',superAdmin,(req,res)=>{res.json({admins:db.prepare("SELECT id,name,username,email,referral_code,admin_active,created_at,(SELECT COUNT(*) FROM users c WHERE c.owner_admin_id=users.id AND c.role='user') customer_count FROM users WHERE role='sub_admin' ORDER BY id DESC").all(),invites:db.prepare("SELECT id,label,expires_at,max_uses,uses,revoked,created_at FROM admin_invites ORDER BY id DESC LIMIT 50").all()})});
app.post('/api/super/admin-invites',superAdmin,(req,res)=>{
 const days=Math.min(365,Math.max(7,Math.floor(+req.body.days||30)));
 const label=String(req.body.label||'New Admin').trim().slice(0,80);
 const code='OT-ADM-'+crypto.randomBytes(6).toString('hex').toUpperCase();
 const expiresAt=Date.now()+days*86400000;
 db.prepare('INSERT INTO admin_invites(code_hash,label,expires_at,created_by) VALUES(?,?,?,?)').run(hash(code),label,expiresAt,req.user.id);
 res.json({ok:true,code,label,days,expiresAt});
});
app.post('/api/super/admin-invites/:id/revoke',superAdmin,(req,res)=>{db.prepare('UPDATE admin_invites SET revoked=1 WHERE id=?').run(req.params.id);res.json({ok:true})});
app.post('/api/super/admins/:id/status',superAdmin,(req,res)=>{const active=req.body.active?1:0;db.prepare("UPDATE users SET admin_active=? WHERE id=? AND role='sub_admin'").run(active,req.params.id);res.json({ok:true,active})});
app.post('/api/super/admins/:id/reassign/:userId',superAdmin,(req,res)=>{const a=db.prepare("SELECT id FROM users WHERE id=? AND role='sub_admin' AND admin_active=1").get(req.params.id),u=db.prepare("SELECT id FROM users WHERE id=? AND role='user'").get(req.params.userId);if(!a||!u)return res.status(404).json({error:'Admin or customer not found'});db.prepare('UPDATE users SET owner_admin_id=? WHERE id=?').run(a.id,u.id);res.json({ok:true})});

// One-time invitation activation. Secret is never stored in plaintext.
app.post('/api/admin/activate',async(req,res)=>{try{
 const code=String(req.body.code||'').trim().toUpperCase(),name=String(req.body.name||'').trim(),email=String(req.body.email||'').trim().toLowerCase(),username=String(req.body.username||'').trim().toLowerCase(),password=String(req.body.password||'');
 const inv=db.prepare('SELECT * FROM admin_invites WHERE code_hash=?').get(hash(code));
 if(!inv||inv.revoked||inv.expires_at<Date.now()||inv.uses>=inv.max_uses)return res.status(400).json({error:'This admin invitation is invalid, expired, revoked or already used.'});
 if(name.length<2||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!/^[a-z0-9_]{3,20}$/.test(username)||password.length<8||!/^[A-Z]/.test(password))return res.status(400).json({error:'Enter a valid name, email, username and a password of 8+ characters starting with a capital letter.'});
 if(db.prepare('SELECT id FROM users WHERE lower(email)=? OR lower(username)=?').get(email,username))return res.status(409).json({error:'Email or username is already in use.'});
 const ref=makeReferral(name),info=db.prepare("INSERT INTO users(name,email,password_hash,email_verified,role,username,referral_code,admin_active,admin_permissions) VALUES(?,?,?,1,'sub_admin',?,?,1,'[\"customers\",\"support\",\"balances\"]')").run(name,email,bcrypt.hashSync(password,12),username,ref);
 db.prepare('UPDATE admin_invites SET uses=uses+1 WHERE id=?').run(inv.id);sessionFor(info.lastInsertRowid,res);res.json({ok:true,referralCode:ref,role:'sub_admin'});
 }catch(e){console.error('[ADMIN ACTIVATE]',e);res.status(500).json({error:'Could not activate admin account.'})}});



// Expanded market catalog + managed trading.
// Market feeds are reference data only; no order is routed to a broker/exchange here.
db.exec(`CREATE TABLE IF NOT EXISTS portfolio_switches(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 reference TEXT UNIQUE NOT NULL,
 user_id INTEGER NOT NULL,
 from_asset TEXT NOT NULL,
 from_amount REAL NOT NULL,
 to_asset TEXT NOT NULL,
 to_amount REAL NOT NULL,
 from_usd_price REAL NOT NULL,
 to_usd_price REAL NOT NULL,
 usd_value REAL NOT NULL,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);`);
const marketCache={crypto:{at:0,data:[]},forex:{at:0,data:[]}};
function marketPairRef(){return 'OT-MGD-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(3).toString('hex').toUpperCase()}
async function cryptoCatalog(){
 const now=Date.now();if(now-marketCache.crypto.at<60000&&marketCache.crypto.data.length)return marketCache.crypto.data;
 const url='https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false&price_change_percentage=24h';
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),6000);
 try{
   const r=await fetch(url,{headers:{accept:'application/json'},signal:controller.signal});
   if(!r.ok)throw new Error('Crypto market provider unavailable');
   const rows=await r.json();
   const data=rows.map(x=>({type:'crypto',symbol:String(x.symbol||'').toUpperCase(),pair:String(x.symbol||'').toUpperCase()+'/USD',name:x.name,price:Number(x.current_price||0),change24h:Number(x.price_change_percentage_24h||0),high24h:Number(x.high_24h||0),low24h:Number(x.low_24h||0),marketCap:Number(x.market_cap||0),rank:Number(x.market_cap_rank||0),image:x.image||null})).filter(x=>x.symbol&&x.price>0);
   marketCache.crypto={at:now,data};return data;
 }catch(e){
   if(marketCache.crypto.data.length)return marketCache.crypto.data;
   throw new Error(e?.name==='AbortError'?'Crypto market provider timed out':'Crypto market provider unavailable');
 }finally{clearTimeout(timer)}
}

async function portfolioReferencePrices(){
 const rows=await cryptoCatalog();
 const find=s=>Number(rows.find(x=>x.symbol===s)?.price||0);
 const prices={USD:1,USDT:find('USDT')||1,BTC:find('BTC'),ETH:find('ETH')};
 if(!(prices.BTC>0)||!(prices.ETH>0))throw new Error('BTC/ETH reference prices are unavailable.');
 return prices;
}
function portfolioSwitchRef(){return 'OT-SW-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(3).toString('hex').toUpperCase()}
function portfolioAssetAmount(userId,asset){
 const balance=withdrawalWalletAmount(userId,asset);
 const reserved=withdrawalReserved(userId,asset);
 return {balance,reserved,available:Math.max(0,balance-reserved)};
}
app.get('/api/portfolio/switch/quote',auth,async(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required.'});
 const from=String(req.query.from||'').toUpperCase(),to=String(req.query.to||'').toUpperCase(),amount=Number(req.query.amount);
 const supported=['USD','USDT','BTC','ETH'];
 if(!supported.includes(from)||!supported.includes(to)||from===to||!Number.isFinite(amount)||amount<=0)
   return res.status(400).json({error:'Choose two different supported assets and enter a valid amount.'});
 seedSectionBalances(req.user.id);
 const source=portfolioAssetAmount(req.user.id,from),available=source.available;
 if(amount>available+1e-12)return res.status(400).json({error:`Insufficient available ${from} balance. Available: ${available}.`});
 try{
   const p=await portfolioReferencePrices(),usdValue=amount*p[from],toAmount=usdValue/p[to],rate=p[from]/p[to];
   res.set('Cache-Control','no-store');
   res.json({
     ok:true,referenceOnly:true,from,to,amount,available,balance:source.balance,reserved:source.reserved,
     fromUsdPrice:p[from],toUsdPrice:p[to],usdValue,rate,toAmount,
     updatedAt:new Date().toISOString(),
     notice:'Reference conversion only. Final internal-ledger amount is recalculated when you confirm.'
   });
 }catch(e){
   res.status(503).json({error:'Reference prices are temporarily unavailable. Please try again.'});
 }
});
app.post('/api/portfolio/switch',auth,async(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required.'});
 const from=String(req.body.from||'').toUpperCase(),to=String(req.body.to||'').toUpperCase(),amount=Number(req.body.amount),pin=String(req.body.pin||'');
 const supported=['USD','USDT','BTC','ETH'];
 if(!supported.includes(from)||!supported.includes(to)||from===to||!Number.isFinite(amount)||amount<=0)
   return res.status(400).json({error:'Choose two different supported assets and enter a valid amount.'});
 const pinCheck=sensitivePinCheck(req.user.id,pin);
 if(!pinCheck.ok)return res.status(pinCheck.status).json(pinCheck);
 seedSectionBalances(req.user.id);
 let p;
 try{p=await portfolioReferencePrices()}catch(e){return res.status(503).json({error:'Reference prices are temporarily unavailable. Please try again.'})}
 const usdValue=amount*p[from],toAmount=usdValue/p[to];
 if(!(usdValue>0)||!(toAmount>0)||!Number.isFinite(toAmount))return res.status(400).json({error:'Could not calculate this asset switch.'});
 const ref=portfolioSwitchRef();
 try{
   db.transaction(()=>{
     const fromRow=db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='wallet' AND asset=?").get(req.user.id,from);
     const toRow=db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='wallet' AND asset=?").get(req.user.id,to);
     const fromBefore=Number(fromRow?.amount||0),toBefore=Number(toRow?.amount||0);
     const reserved=withdrawalReserved(req.user.id,from),available=Math.max(0,fromBefore-reserved);
     if(amount>available+1e-12)throw new Error(`Insufficient available ${from} balance. Available: ${available}.`);
     const fromAfter=Math.max(0,fromBefore-amount),toAfter=toBefore+toAmount;
     db.prepare("UPDATE section_balances SET amount=? WHERE user_id=? AND section='wallet' AND asset=?").run(fromAfter,req.user.id,from);
     db.prepare("UPDATE section_balances SET amount=? WHERE user_id=? AND section='wallet' AND asset=?").run(toAfter,req.user.id,to);
     db.prepare("UPDATE balances SET amount=? WHERE user_id=? AND asset=?").run(fromAfter,req.user.id,from);
     db.prepare("UPDATE balances SET amount=? WHERE user_id=? AND asset=?").run(toAfter,req.user.id,to);
     db.prepare(`INSERT INTO portfolio_switches(reference,user_id,from_asset,from_amount,to_asset,to_amount,from_usd_price,to_usd_price,usd_value)
       VALUES(?,?,?,?,?,?,?,?,?)`).run(ref,req.user.id,from,amount,to,toAmount,p[from],p[to],usdValue);
     db.prepare("INSERT INTO demo_transactions(reference,user_id,actor_id,type,asset,amount,direction,status,note) VALUES(?,?,?,?,?,?,?,'completed',?)")
       .run(ref,req.user.id,req.user.id,'portfolio_conversion',from,amount,'debit',`Account asset switch: ${amount} ${from} → ${toAmount} ${to} using reference prices`);
     logActivity(req.user.id,req.user.id,'portfolio_conversion',`Switched ${amount} ${from} to ${toAmount} ${to} in account portfolio`);
     notifyUser(req.user.id,'portfolio_conversion','Portfolio assets switched',`${amount} ${from} was switched to ${toAmount} ${to}. Reference: ${ref}`,'/portfolio.html');
   })();
 }catch(e){
   return res.status(400).json({error:e.message||'Could not complete portfolio switch.'});
 }
 res.json({
   ok:true,reference:ref,from,to,fromAmount:amount,toAmount,usdValue,
   fromUsdPrice:p[from],toUsdPrice:p[to],referenceOnly:true,
   message:`Portfolio switched from ${from} to ${to}.`
 });
});
app.get('/api/portfolio/switch/history',auth,(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required.'});
 const rows=db.prepare(`SELECT reference,from_asset,from_amount,to_asset,to_amount,from_usd_price,to_usd_price,usd_value,created_at
   FROM portfolio_switches WHERE user_id=? ORDER BY id DESC LIMIT 25`).all(req.user.id);
 res.set('Cache-Control','no-store');
 res.json({switches:rows});
});

async function forexCatalog(){
 const now=Date.now();if(now-marketCache.forex.at<300000&&marketCache.forex.data.length)return marketCache.forex.data;
 const [rr,cr]=await Promise.all([fetch('https://api.frankfurter.app/latest?from=USD'),fetch('https://api.frankfurter.app/currencies')]);
 if(!rr.ok)throw new Error('FX reference provider unavailable');
 const latest=await rr.json(),currencies=cr.ok?await cr.json():{};
 const perUsd={USD:1,...latest.rates};
 const bases=['USD','EUR','GBP','JPY','CHF','AUD','CAD','NZD'];
 const quotes=['USD','EUR','GBP','JPY','CHF','AUD','CAD','NZD','SEK','NOK','DKK','PLN','CZK','SGD','HKD','MXN','ZAR','BRL','CNY','INR','KRW'];
 const data=[];
 for(const base of bases)for(const quote of quotes){
   if(base===quote||!perUsd[base]||!perUsd[quote])continue;
   const rate=perUsd[quote]/perUsd[base];
   data.push({type:'forex',symbol:base+quote,pair:base+'/'+quote,name:(currencies[base]||base)+' / '+(currencies[quote]||quote),price:Number(rate),change24h:null,high24h:null,low24h:null,marketCap:null,rank:null,image:null});
 }
 marketCache.forex={at:now,data};return data;
}

const homeHistoryCache={BTC:{at:0,prices:[]},ETH:{at:0,prices:[]}};
app.get('/api/public/market-ticker',async(req,res)=>{
 try{
   const [crypto,forex]=await Promise.all([cryptoCatalog(),forexCatalog()]);
   const c=s=>crypto.find(x=>x.symbol===s)?.price||null;
   const f=p=>forex.find(x=>x.pair===p)?.price||null;
   res.set('Cache-Control','public, max-age=15, stale-while-revalidate=45');
   res.json({
     reference:true,
     markets:{BTCUSD:c('BTC'),ETHUSD:c('ETH'),EURUSD:f('EUR/USD'),GBPUSD:f('GBP/USD'),USDJPY:f('USD/JPY')},
     updatedAt:new Date().toISOString()
   });
 }catch(e){
   const crypto=marketCache.crypto.data||[],forex=marketCache.forex.data||[];
   const c=s=>crypto.find(x=>x.symbol===s)?.price||null;
   const f=p=>forex.find(x=>x.pair===p)?.price||null;
   const markets={BTCUSD:c('BTC'),ETHUSD:c('ETH'),EURUSD:f('EUR/USD'),GBPUSD:f('GBP/USD'),USDJPY:f('USD/JPY')};
   if(Object.values(markets).some(v=>v!=null)){
     return res.json({reference:true,stale:true,markets,updatedAt:new Date().toISOString()});
   }
   res.status(503).json({error:'Reference market feed is temporarily unavailable.',markets:{}});
 }
});
app.get('/api/public/market-history',async(req,res)=>{
 const symbol=String(req.query.symbol||'BTC').toUpperCase()==='ETH'?'ETH':'BTC';
 const cached=homeHistoryCache[symbol];
 if(Date.now()-cached.at<300000&&cached.prices.length){
   res.set('Cache-Control','public, max-age=30, stale-while-revalidate=120');
   return res.json({symbol,prices:cached.prices,reference:true,cached:true,updatedAt:new Date(cached.at).toISOString()});
 }
 const id=symbol==='ETH'?'ethereum':'bitcoin';
 try{
   const r=await fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=1`,{headers:{accept:'application/json'}});
   if(!r.ok)throw new Error(`Market history provider HTTP ${r.status}`);
   const d=await r.json();
   const raw=(d.prices||[]).filter(x=>Array.isArray(x)&&Number.isFinite(Number(x[0]))&&Number.isFinite(Number(x[1])));
   const step=Math.max(1,Math.ceil(raw.length/120));
   const prices=raw.filter((_,i)=>i%step===0).map(x=>[Number(x[0]),Number(x[1])]);
   if(raw.length&&prices.at(-1)?.[0]!==Number(raw.at(-1)[0]))prices.push([Number(raw.at(-1)[0]),Number(raw.at(-1)[1])]);
   homeHistoryCache[symbol]={at:Date.now(),prices};
   res.set('Cache-Control','public, max-age=30, stale-while-revalidate=120');
   res.json({symbol,prices,reference:true,updatedAt:new Date().toISOString()});
 }catch(e){
   if(cached.prices.length)return res.json({symbol,prices:cached.prices,reference:true,stale:true,updatedAt:new Date(cached.at).toISOString()});
   res.status(503).json({error:'Reference chart feed is temporarily unavailable.',prices:[]});
 }
});

app.get('/api/market/catalog',auth,async(req,res)=>{
 if(req.user.role!=='user'&&!isStaff(req.user))return res.status(403).json({error:'Account required'});
 const type=String(req.query.type||'crypto').toLowerCase();
 try{
   const markets=type==='forex'?await forexCatalog():await cryptoCatalog();
   res.json({type:type==='forex'?'forex':'crypto',markets,reference:true,updatedAt:new Date().toISOString()});
 }catch(e){
   console.error('[MARKET CATALOG]',e.message);
   const cached=type==='forex'?marketCache.forex.data:marketCache.crypto.data;
   if(cached.length)return res.json({type,markets:cached,reference:true,stale:true,updatedAt:new Date().toISOString()});
   res.status(503).json({error:'Reference market data is temporarily unavailable.',markets:[]});
 }
});

db.exec(`CREATE TABLE IF NOT EXISTS paper_trade_orders(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 reference TEXT UNIQUE NOT NULL,
 user_id INTEGER NOT NULL,
 market_type TEXT NOT NULL,
 pair TEXT NOT NULL,
 side TEXT NOT NULL,
 notional_usd REAL NOT NULL,
 entry_price REAL NOT NULL,
 units REAL,
 status TEXT DEFAULT 'open',
 close_price REAL,
 pnl_usd REAL,
 return_usd REAL,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 closed_at TEXT
);`);
const paperTradeColumns=db.prepare('PRAGMA table_info(paper_trade_orders)').all().map(c=>c.name);
for(const [column,type] of Object.entries({
 owner_admin_id:'INTEGER',admin_note:'TEXT',started_by:'INTEGER',started_at:'TEXT',settled_by:'INTEGER',settled_at:'TEXT',updated_at:'TEXT',
 execution_source:"TEXT DEFAULT 'internal'",exchange_provider:'TEXT',exchange_open_order_id:'TEXT',exchange_close_order_id:'TEXT',external_status:'TEXT'
}))
 if(!paperTradeColumns.includes(column)) db.exec(`ALTER TABLE paper_trade_orders ADD COLUMN ${column} ${type}`);
// Legacy open positions remain manageable by staff as active positions.
try{db.prepare("UPDATE paper_trade_orders SET status='active' WHERE status='open'").run()}catch{}
function paperTradeRef(){return 'OT-TRD-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(3).toString('hex').toUpperCase()}
async function referenceMarket(type,pair){
 const rows=type==='forex'?await forexCatalog():await cryptoCatalog();
 return rows.find(x=>String(x.pair).toUpperCase()===String(pair).toUpperCase())||null;
}
app.get('/api/trades',auth,(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required'});
 seedSectionBalances(req.user.id);
 const trading=Number(db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='trading' AND asset='USD'").get(req.user.id)?.amount||0);
 const wallet=Number(db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='wallet' AND asset='USD'").get(req.user.id)?.amount||0);
 const orders=db.prepare('SELECT * FROM paper_trade_orders WHERE user_id=? ORDER BY id DESC LIMIT 100').all(req.user.id).map(x=>({
  ...x,execution_source:x.execution_source||'internal',
  exchange:exchangeOrderPublic(exchangeOrderRow('self',x.id,'open'))
 }));
 res.json({orders,availableTradingUsd:trading,walletUsd:wallet,minimum:1000,exchange:{enabled:!!exchangeSettings().enabled,mode:exchangeSettings().execution_mode}});
});
app.post('/api/trades',auth,async(req,res)=>{
 const kyc=kycGate(req.user,'self_trade');if(!kyc.ok)return res.status(403).json(kyc);
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required'});
 const type=String(req.body.marketType||'crypto').toLowerCase();
 const pair=String(req.body.pair||'').trim().toUpperCase().slice(0,30);
 const side=String(req.body.side||'Buy').toLowerCase()==='sell'?'sell':'buy';
 const amount=Number(req.body.amount);
 if(!['crypto','forex'].includes(type)||pair.length<3||!Number.isFinite(amount)||amount<1000)return res.status(400).json({error:'Self-Directed Trading starts from a minimum of $1,000.'});
 let market;try{market=await referenceMarket(type,pair)}catch(e){return res.status(503).json({error:'Reference market price is temporarily unavailable.'})}
 if(!market?.price)return res.status(400).json({error:'That market is not currently available.'});
 seedSectionBalances(req.user.id);
 const assignedAdminId=walletOwnerForUser(req.user);
 if(!assignedAdminId)return res.status(503).json({error:'No trade administrator is currently available.'});
 const ref=paperTradeRef(),units=amount/Number(market.price);
 try{
   db.transaction(()=>{
     const wallet=Number(db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='wallet' AND asset='USD'").get(req.user.id)?.amount||0);
     if(wallet<amount)throw new Error('Insufficient USD wallet balance for this trade.');
     const trading=Number(db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='trading' AND asset='USD'").get(req.user.id)?.amount||0);
     db.prepare("UPDATE section_balances SET amount=? WHERE user_id=? AND section='wallet' AND asset='USD'").run(wallet-amount,req.user.id);
     db.prepare("UPDATE balances SET amount=? WHERE user_id=? AND asset='USD'").run(wallet-amount,req.user.id);
     db.prepare("UPDATE section_balances SET amount=? WHERE user_id=? AND section='trading' AND asset='USD'").run(trading+amount,req.user.id);
     db.prepare(`INSERT INTO paper_trade_orders(reference,user_id,owner_admin_id,market_type,pair,side,notional_usd,entry_price,units,status,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,'pending',CURRENT_TIMESTAMP)`).run(ref,req.user.id,assignedAdminId,type,pair,side,amount,Number(market.price),units);
     db.prepare("INSERT INTO demo_transactions(reference,user_id,actor_id,type,asset,amount,direction,status,note) VALUES(?,?,?,?,?,?,'debit','completed',?)")
       .run(ref,req.user.id,req.user.id,'trade_reserve','USD',amount,`Reserved for ${side.toUpperCase()} ${pair} trade request at reference price ${market.price}`);
   })();
 }catch(e){return res.status(400).json({error:e.message})}
 logActivity(req.user.id,req.user.id,'trade_submitted',`${side.toUpperCase()} ${pair} trade submitted • ${ref}`);
 notifyAndEmail(req.user.id,'trade','Trade submitted',`Your ${side.toUpperCase()} ${pair} trade request ${ref} for $${amount.toFixed(2)} has been submitted and assigned for review.`,'/trade.html');
 notifyUrgentAdminEvent(assignedAdminId,'trade','New trade submitted',`${req.user.name||req.user.username||'Customer'} submitted ${side.toUpperCase()} ${pair} for $${amount.toFixed(2)}.`,'/admin/managed-trades.html');
 res.json({ok:true,reference:ref,status:'pending',entryPrice:Number(market.price),assignedAdminId});
});
// Backward-compatible close endpoint for legacy positions only. New trade submissions are staff-settled.
app.post('/api/trades/:id/close',auth,(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required'});
 const order=db.prepare("SELECT * FROM paper_trade_orders WHERE id=? AND user_id=?").get(req.params.id,req.user.id);
 if(!order)return res.status(404).json({error:'Trade not found.'});
 return res.status(409).json({error:'Submitted trades are handled and settled by your assigned OptiTrade admin.'});
});

// Trade with OptiTrade: customer reserves USD, assigned staff manages and settles the request.
db.exec(`CREATE TABLE IF NOT EXISTS managed_trade_requests(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 reference TEXT UNIQUE NOT NULL,
 user_id INTEGER NOT NULL,
 owner_admin_id INTEGER,
 funding_asset TEXT NOT NULL,
 amount REAL NOT NULL,
 market_preference TEXT DEFAULT 'mixed',
 preferred_symbol TEXT,
 traded_symbol TEXT,
 status TEXT DEFAULT 'pending',
 pnl_percent REAL,
 pnl_amount REAL,
 return_amount REAL,
 customer_note TEXT,
 admin_note TEXT,
 opened_by INTEGER,
 opened_at TEXT,
 settled_by INTEGER,
 settled_at TEXT,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);`);
const managedTradeColumns=db.prepare('PRAGMA table_info(managed_trade_requests)').all().map(c=>c.name);
for(const [column,type] of Object.entries({
 execution_source:"TEXT DEFAULT 'internal'",exchange_provider:'TEXT',exchange_open_order_id:'TEXT',exchange_close_order_id:'TEXT',
 external_status:'TEXT',external_side:'TEXT',
 wallet_funded_amount:'REAL DEFAULT 0',reserve_funded_amount:'REAL DEFAULT 0'
})) if(!managedTradeColumns.includes(column)) db.exec(`ALTER TABLE managed_trade_requests ADD COLUMN ${column} ${type}`);
function managedTradeForActor(actor,id){
 const t=db.prepare('SELECT * FROM managed_trade_requests WHERE id=?').get(id);if(!t)return null;
 return ownsUser(actor,t.user_id)?t:null;
}

function tradingReserveSnapshot(userId){
 seedSectionBalances(userId);
 const total=Number(db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='trading' AND asset='USD'").get(userId)?.amount||0);
 const managedCommitted=Number(db.prepare("SELECT COALESCE(SUM(amount),0) n FROM managed_trade_requests WHERE user_id=? AND status IN ('pending','active')").get(userId)?.n||0);
 const selfCommitted=Number(db.prepare("SELECT COALESCE(SUM(notional_usd),0) n FROM paper_trade_orders WHERE user_id=? AND status IN ('pending','active')").get(userId)?.n||0);
 const committed=managedCommitted+selfCommitted;
 const available=Math.max(0,Number((total-committed).toFixed(8)));
 const realizedPnl=Number(db.prepare("SELECT COALESCE(SUM(pnl_amount),0) n FROM managed_trade_requests WHERE user_id=? AND status='settled'").get(userId)?.n||0);
 const pendingManaged=Number(db.prepare("SELECT COUNT(*) n FROM managed_trade_requests WHERE user_id=? AND status='pending'").get(userId)?.n||0);
 const activeManaged=Number(db.prepare("SELECT COUNT(*) n FROM managed_trade_requests WHERE user_id=? AND status='active'").get(userId)?.n||0);
 return {total,committed,available,managedCommitted,selfCommitted,realizedPnl,pendingManaged,activeManaged};
}
function moveSectionBalance(userId,fromSection,toSection,asset,amount){
 seedSectionBalances(userId);
 const from=db.prepare('SELECT amount FROM section_balances WHERE user_id=? AND section=? AND asset=?').get(userId,fromSection,asset);
 const to=db.prepare('SELECT amount FROM section_balances WHERE user_id=? AND section=? AND asset=?').get(userId,toSection,asset);
 const a=Number(amount);if(!from||Number(from.amount)<a)throw new Error('Insufficient balance.');
 db.prepare('UPDATE section_balances SET amount=? WHERE user_id=? AND section=? AND asset=?').run(Number(from.amount)-a,userId,fromSection,asset);
 db.prepare('UPDATE section_balances SET amount=? WHERE user_id=? AND section=? AND asset=?').run(Number(to?.amount||0)+a,userId,toSection,asset);
 if(fromSection==='wallet')db.prepare('UPDATE balances SET amount=? WHERE user_id=? AND asset=?').run(Number(from.amount)-a,userId,asset);
 if(toSection==='wallet')db.prepare('UPDATE balances SET amount=? WHERE user_id=? AND asset=?').run(Number(to?.amount||0)+a,userId,asset);
}
app.get('/api/managed-trades',auth,(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required'});
 seedSectionBalances(req.user.id);
 const wallet=Number(db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='wallet' AND asset='USD'").get(req.user.id)?.amount||0);
 const trading=Number(db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='trading' AND asset='USD'").get(req.user.id)?.amount||0);
 const reserve=tradingReserveSnapshot(req.user.id);
 const requests=db.prepare('SELECT * FROM managed_trade_requests WHERE user_id=? ORDER BY id DESC LIMIT 100').all(req.user.id).map(x=>({
  ...x,execution_source:x.execution_source||'internal',
  exchange:exchangeOrderPublic(exchangeOrderRow('managed',x.id,'open'))
 }));
 res.json({wallet:[{asset:'USD',amount:wallet}],trading:[{asset:'USD',amount:trading}],reserve,requests,minimum:500,exchange:{enabled:!!exchangeSettings().enabled,mode:exchangeSettings().execution_mode}});
});
app.post('/api/managed-trades',auth,(req,res)=>{
 const kyc=kycGate(req.user,'managed_trade');if(!kyc.ok)return res.status(403).json(kyc);
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required'});
 const amount=Number(req.body.amount),pref=String(req.body.marketPreference||'mixed').toLowerCase(),preferred=String(req.body.preferredSymbol||'').trim().toUpperCase().slice(0,30),note=String(req.body.note||'').trim().slice(0,500);
 if(!Number.isFinite(amount)||amount<500)return res.status(400).json({error:'The minimum Trade with OptiTrade amount is $500.'});
 if(!['mixed','crypto','forex'].includes(pref))return res.status(400).json({error:'Choose Managed Mix, Crypto or Forex.'});
 const assignedAdminId=walletOwnerForUser(req.user);if(!assignedAdminId)return res.status(503).json({error:'No trade administrator is currently available.'});
 const before=tradingReserveSnapshot(req.user.id);
 const wallet=Number(db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='wallet' AND asset='USD'").get(req.user.id)?.amount||0);
 const reserveFunded=Math.min(amount,before.available),walletFunded=Number((amount-reserveFunded).toFixed(8));
 if(walletFunded>wallet+1e-8)return res.status(400).json({error:`Insufficient funds. Trade Reserve available: $${before.available.toFixed(2)}. Available USD wallet: $${wallet.toFixed(2)}.`});
 const ref=marketPairRef();
 try{db.transaction(()=>{
   if(walletFunded>0)moveSectionBalance(req.user.id,'wallet','trading','USD',walletFunded);
   db.prepare(`INSERT INTO managed_trade_requests(reference,user_id,owner_admin_id,funding_asset,amount,market_preference,preferred_symbol,customer_note,status,wallet_funded_amount,reserve_funded_amount)
     VALUES(?,?,?,?,?,?,?,?, 'pending',?,?)`).run(ref,req.user.id,assignedAdminId,'USD',amount,pref,preferred||null,note||null,walletFunded,reserveFunded);
   db.prepare("INSERT INTO demo_transactions(reference,user_id,actor_id,type,asset,amount,direction,status,note) VALUES(?,?,?,?,?,?,'debit','completed',?)")
     .run(ref,req.user.id,req.user.id,'managed_trade_reserve','USD',amount,`Reserved for Trade with OptiTrade request. Trade Reserve used $${reserveFunded.toFixed(2)} • Wallet added $${walletFunded.toFixed(2)}.`);
 })()}catch(e){return res.status(400).json({error:e.message})}
 const after=tradingReserveSnapshot(req.user.id);
 logActivity(req.user.id,req.user.id,'managed_trade_submitted',`Trade with OptiTrade submitted for $${amount.toFixed(2)} • Reserve used $${reserveFunded.toFixed(2)} • Wallet added $${walletFunded.toFixed(2)} • ${ref}`);
 notifyAndEmail(req.user.id,'managed_trade','Trade with OptiTrade submitted',`Your $${amount.toFixed(2)} Trade with OptiTrade request ${ref} has been submitted. $${reserveFunded.toFixed(2)} came from free Trade Reserve and $${walletFunded.toFixed(2)} came from Available Balance.`,'/trade.html');
 notifyUrgentAdminEvent(assignedAdminId,'trade','Trade with OptiTrade submitted',`${req.user.name||req.user.username||'Customer'} submitted $${amount.toFixed(2)} for Trade with OptiTrade.`,'/admin/managed-trades.html');
 res.json({ok:true,reference:ref,status:'pending',assignedAdminId,funding:{reserve:reserveFunded,wallet:walletFunded},reserve:after});
});
app.post('/api/managed-trades/:id/cancel',auth,(req,res)=>{
 return res.status(409).json({error:'Submitted Trade with OptiTrade requests are handled by your assigned administrator.'});
});

app.post('/api/managed-trades/reserve-to-wallet',auth,(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required'});
 const amount=Number(req.body.amount),pin=String(req.body.pin||'');
 if(!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:'Enter the Trade Reserve amount to move.'});
 const pinCheck=sensitivePinCheck(req.user.id,pin);if(!pinCheck.ok)return res.status(pinCheck.status).json(pinCheck);
 let after;
 try{
  db.transaction(()=>{
   const snap=tradingReserveSnapshot(req.user.id);
   if(amount>snap.available+1e-8)throw new Error(`Only $${snap.available.toFixed(2)} is free in Trade Reserve. Funds committed to pending/active trades cannot be moved.`);
   moveSectionBalance(req.user.id,'trading','wallet','USD',amount);
   const ref=ledgerRef();
   db.prepare("INSERT INTO demo_transactions(reference,user_id,actor_id,type,asset,amount,direction,status,note) VALUES(?,?,?,?,?,?,'credit','completed',?)")
     .run(ref,req.user.id,req.user.id,'trade_reserve_release','USD',amount,'Moved from free Trade Reserve to Available Balance.');
   logActivity(req.user.id,req.user.id,'trade_reserve_release',`$${amount.toFixed(2)} moved from Trade Reserve to Available Balance • ${ref}`);
   after=tradingReserveSnapshot(req.user.id);
  })();
 }catch(e){return res.status(409).json({error:e.message})}
 notifyAndEmail(req.user.id,'trade','Trade Reserve moved to Available Balance',`$${amount.toFixed(2)} was moved from your free Trade Reserve to your Available USD balance. Your remaining free Trade Reserve is $${after.available.toFixed(2)}.`,'/trade.html');
 const wallet=Number(db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='wallet' AND asset='USD'").get(req.user.id)?.amount||0);
 res.json({ok:true,moved:amount,walletUsd:wallet,reserve:after});
});

function staffPaperTrade(actor,id){
 const t=db.prepare('SELECT * FROM paper_trade_orders WHERE id=?').get(id);if(!t)return null;
 return ownsUser(actor,t.user_id)?t:null;
}
app.get('/api/admin/trade-requests',admin,(req,res)=>{
 const where=scopedUserWhere(req.user,'u');
 const self=db.prepare(`SELECT p.*,u.name,u.username,u.email,'self' request_kind FROM paper_trade_orders p JOIN users u ON u.id=p.user_id WHERE ${where} ORDER BY p.id DESC LIMIT 250`).all();
 const managed=db.prepare(`SELECT m.*,u.name,u.username,u.email,'managed' request_kind FROM managed_trade_requests m JOIN users u ON u.id=m.user_id WHERE ${where} ORDER BY m.id DESC LIMIT 250`).all();
 const requests=[...self,...managed].map(x=>({
   ...x,execution_source:x.execution_source||'internal',
   exchangeOpen:exchangeOrderPublic(exchangeOrderRow(x.request_kind,x.id,'open')),
   exchangeClose:exchangeOrderPublic(exchangeOrderRow(x.request_kind,x.id,'close'))
 })).sort((a,b)=>{
   const rank=s=>s==='pending'?0:(s==='active'?1:2);const r=rank(a.status)-rank(b.status);if(r)return r;
   return String(b.created_at||'').localeCompare(String(a.created_at||''));
 });
 const es=exchangeSettings();
 res.json({requests,role:req.user.role,exchange:{enabled:!!es.enabled,mode:es.execution_mode,emergencyStop:!!es.emergency_stop,routeSelfTrade:!!es.route_self_trade,routeManagedTrade:!!es.route_managed_trade,supportedSymbols:['BTC/USD','ETH/USD','USDT/USD']}});

});
app.post('/api/admin/trade-requests/:kind/:id/start',admin,async(req,res)=>{
 const kind=req.params.kind,note=String(req.body.note||'').trim().slice(0,500),execution=String(req.body.execution||'internal').toLowerCase();
 if(!['internal','exchange'].includes(execution))return res.status(400).json({error:'Choose Internal workflow or Exchange execution.'});
 let t;
 if(kind==='self')t=staffPaperTrade(req.user,+req.params.id);else if(kind==='managed')t=managedTradeForActor(req.user,+req.params.id);
 if(!t)return res.status(403).json({error:'Trade request unavailable.'});
 if(t.status!=='pending')return res.status(409).json({error:'Only pending trade requests can be started.'});

 if(execution==='exchange'){
  const symbol=kind==='self'?t.pair:String(req.body.symbol||t.preferred_symbol||'').trim().toUpperCase().slice(0,40);
  const side=kind==='self'?t.side:String(req.body.side||'buy').toLowerCase();
  if(kind==='managed'&&!['buy','sell'].includes(side))return res.status(400).json({error:'Choose Buy or Sell for the managed exchange order.'});
  try{
   const routed=await createExchangeOpeningOrder({kind,trade:t,user:null,actor:req.user,symbol,side});
   const order=routed.row;
   if(routed.validationOnly){
    logActivity(t.user_id,req.user.id,'exchange_validation',`${t.reference} passed Kraken order validation • ${side.toUpperCase()} ${symbol}`);
    return res.json({ok:true,status:'pending',exchangeValidated:true,exchange:exchangeOrderPublic(order),message:'Kraken validation passed. No live order was placed.'});
   }
   if(kind==='self'){
    db.prepare(`UPDATE paper_trade_orders SET status='active',execution_source='exchange',exchange_provider='kraken',exchange_open_order_id=?,external_status=?,admin_note=?,started_by=?,started_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'`)
      .run(order.external_order_id||null,order.status,note||null,req.user.id,t.id);
   }else{
    db.prepare(`UPDATE managed_trade_requests SET status='active',execution_source='exchange',exchange_provider='kraken',exchange_open_order_id=?,external_status=?,external_side=?,traded_symbol=?,admin_note=?,opened_by=?,opened_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'`)
      .run(order.external_order_id||null,order.status,side,symbol,note||null,req.user.id,t.id);
   }
   notifyAndEmail(t.user_id,'trade','Trade routed to exchange',`Trade ${t.reference} was routed to Kraken for ${side.toUpperCase()} ${symbol}. Exchange status: ${order.status}.`,'/trade.html');
   logActivity(t.user_id,req.user.id,'exchange_trade_started',`${t.reference} routed to Kraken • ${side.toUpperCase()} ${symbol} • ${order.status}`);
   return res.json({ok:true,status:'active',executionSource:'exchange',exchange:exchangeOrderPublic(order)});
  }catch(e){
   logActivity(t.user_id,req.user.id,'exchange_trade_error',`${t.reference} exchange routing needs review: ${String(e.message||e).slice(0,250)}`);
   return res.status(502).json({error:e.message||'Exchange execution failed.',needsReview:true});
  }
 }

 if(kind==='self'){
  db.prepare("UPDATE paper_trade_orders SET status='active',execution_source='internal',admin_note=?,started_by=?,started_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(note||null,req.user.id,t.id);
  notifyAndEmail(t.user_id,'trade','Trade now active',`Your ${t.side.toUpperCase()} ${t.pair} trade ${t.reference} is now active under administrator supervision.`,'/trade.html');
  logActivity(t.user_id,req.user.id,'trade_started',`${t.reference} started internally by admin`);
  return res.json({ok:true,status:'active',executionSource:'internal'});
 }
 if(kind==='managed'){
  const symbol=String(req.body.symbol||t.preferred_symbol||'OptiTrade Managed').trim().toUpperCase().slice(0,40);
  db.prepare("UPDATE managed_trade_requests SET status='active',execution_source='internal',traded_symbol=?,admin_note=?,opened_by=?,opened_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(symbol,note||null,req.user.id,t.id);
  notifyAndEmail(t.user_id,'managed_trade','Trade with OptiTrade active',`Your Trade with OptiTrade request ${t.reference} is now active${symbol?' on '+symbol:''}.`,'/trade.html');
  logActivity(t.user_id,req.user.id,'managed_trade_started',`${t.reference} started internally by admin`);
  return res.json({ok:true,status:'active',executionSource:'internal'});
 }
 res.status(400).json({error:'Unknown trade request type.'});
});

app.post('/api/admin/trade-requests/:kind/:id/reject',admin,(req,res)=>{
 const kind=req.params.kind,reason=String(req.body.reason||'').trim().slice(0,500);
 if(reason.length<3)return res.status(400).json({error:'Enter a customer-visible reason.'});
 let t;
 if(kind==='self')t=staffPaperTrade(req.user,+req.params.id);else if(kind==='managed')t=managedTradeForActor(req.user,+req.params.id);
 if(!t)return res.status(403).json({error:'Trade request unavailable.'});
 if(t.status!=='pending')return res.status(409).json({error:'Only pending requests can be declined.'});
 const amount=kind==='self'?Number(t.notional_usd):Number(t.amount);
 try{db.transaction(()=>{
   if(kind==='self')moveSectionBalance(t.user_id,'trading','wallet','USD',amount);
   if(kind==='self')db.prepare("UPDATE paper_trade_orders SET status='rejected',admin_note=?,settled_by=?,settled_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(reason,req.user.id,t.id);
   else db.prepare("UPDATE managed_trade_requests SET status='rejected',admin_note=?,settled_by=?,settled_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(reason,req.user.id,t.id);
 })()}catch(e){return res.status(409).json({error:e.message})}
 if(kind==='managed'){
  const reserve=tradingReserveSnapshot(t.user_id);
  notifyAndEmail(t.user_id,'trade','Trade with OptiTrade request declined',`Your Trade with OptiTrade request ${t.reference} was declined. Reason: ${reason}. The reserved $${amount.toFixed(2)} is now free in your Trade Reserve and can be reused or moved to Available Balance.`,'/trade.html');
  logActivity(t.user_id,req.user.id,'trade_rejected',`${t.reference} declined • $${amount.toFixed(2)} released to Trade Reserve`);
  return res.json({ok:true,status:'rejected',reserve});
 }
 notifyAndEmail(t.user_id,'trade','Trade request declined',`Your trade request ${t.reference} was declined. Reason: ${reason}. The reserved $${amount.toFixed(2)} was returned to your wallet.`,'/trade.html');
 logActivity(t.user_id,req.user.id,'trade_rejected',`${t.reference} declined`);
 res.json({ok:true,status:'rejected'});
});
app.post('/api/admin/trade-requests/:kind/:id/settle',admin,(req,res)=>{
 const kind=req.params.kind,note=String(req.body.note||'').trim().slice(0,500),pnl=Number(req.body.pnlAmount);
 if(!Number.isFinite(pnl))return res.status(400).json({error:'Enter the profit/loss amount in USD. Use a negative number for a loss.'});
 if(note.length<3)return res.status(400).json({error:'Enter a short settlement note.'});
 let t;
 if(kind==='self')t=staffPaperTrade(req.user,+req.params.id);else if(kind==='managed')t=managedTradeForActor(req.user,+req.params.id);
 if(!t)return res.status(403).json({error:'Trade request unavailable.'});
 if(t.status!=='active')return res.status(409).json({error:'Only an active trade can be settled.'});
 if(String(t.execution_source||'internal')==='exchange')return res.status(409).json({error:'This trade is linked to live exchange execution. Use Close & Reconcile Exchange instead of entering manual P/L.'});
 const principal=kind==='self'?Number(t.notional_usd):Number(t.amount);
 if(pnl < -principal)return res.status(400).json({error:'Loss cannot exceed the reserved trade amount.'});
 const returned=Number((principal+pnl).toFixed(8)),pct=principal?Number((pnl/principal*100).toFixed(4)):0;

 if(kind==='managed'){
  let reserveAfter;
  try{db.transaction(()=>{
    seedSectionBalances(t.user_id);
    const tr=Number(db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='trading' AND asset='USD'").get(t.user_id)?.amount||0);
    if(tr+1e-8<principal)throw new Error('Trade Reserve is lower than this trade principal.');
    const next=Number((tr+pnl).toFixed(8));
    const otherCommitted=Math.max(0,tradingReserveSnapshot(t.user_id).committed-principal);
    if(next+1e-8<otherCommitted)throw new Error('This settlement would use funds committed to another open trade.');
    db.prepare("UPDATE section_balances SET amount=? WHERE user_id=? AND section='trading' AND asset='USD'").run(next,t.user_id);
    db.prepare("UPDATE managed_trade_requests SET status='settled',pnl_percent=?,pnl_amount=?,return_amount=?,admin_note=?,settled_by=?,settled_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'").run(pct,pnl,returned,note,req.user.id,t.id);
    if(Math.abs(pnl)>1e-12){
      db.prepare("INSERT INTO demo_transactions(reference,user_id,actor_id,type,asset,amount,direction,status,note) VALUES(?,?,?,?,?,?,?,'completed',?)")
       .run(t.reference+'-SET',t.user_id,req.user.id,'managed_trade_result','USD',Math.abs(pnl),pnl>=0?'credit':'debit',`Managed trade realized P/L ${pnl>=0?'+':''}${pnl.toFixed(2)} USD retained in Trade Reserve. ${note}`);
    }
    reserveAfter=tradingReserveSnapshot(t.user_id);
  })()}catch(e){return res.status(409).json({error:e.message})}
  const resultWord=pnl>=0?'profit':'loss';
  notifyAndEmail(t.user_id,'trade','Trade with OptiTrade settled',`Trade ${t.reference} was settled with a ${resultWord} of ${pnl>=0?'+':''}$${Math.abs(pnl).toFixed(2)}. The resulting $${returned.toFixed(2)} remains in your Trade Reserve. Free reserve: $${reserveAfter.available.toFixed(2)}. Move it to Available Balance whenever you choose.`,'/trade.html');
  logActivity(t.user_id,req.user.id,'managed_trade_settled',`${t.reference} settled • P/L ${pnl>=0?'+':''}${pnl.toFixed(2)} USD • retained in Trade Reserve`);
  return res.json({ok:true,status:'settled',pnlAmount:pnl,returnAmount:returned,pnlPercent:pct,reserve:reserveAfter});
 }

 try{db.transaction(()=>{
   seedSectionBalances(t.user_id);
   const tr=Number(db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='trading' AND asset='USD'").get(t.user_id)?.amount||0);
   if(tr<principal)throw new Error('Reserved trading balance is lower than this trade principal.');
   db.prepare("UPDATE section_balances SET amount=? WHERE user_id=? AND section='trading' AND asset='USD'").run(tr-principal,t.user_id);
   const w=Number(db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='wallet' AND asset='USD'").get(t.user_id)?.amount||0);
   db.prepare("UPDATE section_balances SET amount=? WHERE user_id=? AND section='wallet' AND asset='USD'").run(w+returned,t.user_id);
   db.prepare("UPDATE balances SET amount=? WHERE user_id=? AND asset='USD'").run(w+returned,t.user_id);
   db.prepare("UPDATE paper_trade_orders SET status='settled',pnl_usd=?,return_usd=?,admin_note=?,settled_by=?,settled_at=CURRENT_TIMESTAMP,closed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'").run(pnl,returned,note,req.user.id,t.id);
   db.prepare("INSERT INTO demo_transactions(reference,user_id,actor_id,type,asset,amount,direction,status,note) VALUES(?,?,?,?,?,?,'credit','completed',?)")
     .run(t.reference+'-SET',t.user_id,req.user.id,'trade_settlement','USD',returned,`Trade settlement. P/L ${pnl>=0?'+':''}${pnl.toFixed(2)} USD. ${note}`);
 })()}catch(e){return res.status(409).json({error:e.message})}
 const resultWord=pnl>=0?'profit':'loss';
 notifyAndEmail(t.user_id,'trade','Trade settled',`Trade ${t.reference} was settled with a ${resultWord} of ${pnl>=0?'+':''}$${Math.abs(pnl).toFixed(2)}. $${returned.toFixed(2)} was applied to your USD wallet. ${note}`,'/trade.html');
 logActivity(t.user_id,req.user.id,'trade_settled',`${t.reference} settled • P/L ${pnl>=0?'+':''}${pnl.toFixed(2)} USD`);
 res.json({ok:true,status:'settled',pnlAmount:pnl,returnAmount:returned,pnlPercent:pct});
});

app.post('/api/admin/trade-requests/:kind/:id/sync-exchange',admin,async(req,res)=>{
 const kind=req.params.kind;let t;
 if(kind==='self')t=staffPaperTrade(req.user,+req.params.id);else if(kind==='managed')t=managedTradeForActor(req.user,+req.params.id);
 if(!t)return res.status(403).json({error:'Trade request unavailable.'});
 const open=exchangeOrderRow(kind,t.id,'open'),close=exchangeOrderRow(kind,t.id,'close');
 if(!open)return res.status(404).json({error:'No exchange order is linked to this trade.'});
 const syncedOpen=await reconcileExchangeOrder(open),syncedClose=close?await reconcileExchangeOrder(close):null;
 const extStatus=syncedClose?.status||syncedOpen?.status||'unknown';
 if(kind==='self')db.prepare('UPDATE paper_trade_orders SET external_status=?,exchange_open_order_id=COALESCE(?,exchange_open_order_id),exchange_close_order_id=COALESCE(?,exchange_close_order_id),updated_at=CURRENT_TIMESTAMP WHERE id=?')
  .run(extStatus,syncedOpen?.external_order_id||null,syncedClose?.external_order_id||null,t.id);
 else db.prepare('UPDATE managed_trade_requests SET external_status=?,exchange_open_order_id=COALESCE(?,exchange_open_order_id),exchange_close_order_id=COALESCE(?,exchange_close_order_id),updated_at=CURRENT_TIMESTAMP WHERE id=?')
  .run(extStatus,syncedOpen?.external_order_id||null,syncedClose?.external_order_id||null,t.id);
 res.json({ok:true,open:exchangeOrderPublic(syncedOpen),close:exchangeOrderPublic(syncedClose)});
});

app.post('/api/admin/trade-requests/:kind/:id/close-exchange',admin,async(req,res)=>{
 const kind=req.params.kind,note=String(req.body.note||'Exchange position closed and reconciled.').trim().slice(0,500);let t;
 if(kind==='self')t=staffPaperTrade(req.user,+req.params.id);else if(kind==='managed')t=managedTradeForActor(req.user,+req.params.id);
 if(!t)return res.status(403).json({error:'Trade request unavailable.'});
 if(t.status!=='active'||String(t.execution_source||'internal')!=='exchange')return res.status(409).json({error:'Only an active exchange-routed trade can be closed through this endpoint.'});
 const es=exchangeSettings();
 if(es.execution_mode!=='live')return res.status(409).json({error:'Exchange execution is not in Live mode.'});
 if(Number(es.emergency_stop))return res.status(423).json({error:'Exchange emergency stop is ON. Closing via API is blocked; use the exchange console if an urgent manual close is required.'});
 let legs;
 try{legs=await createExchangeClosingOrder({kind,trade:t,actor:req.user})}
 catch(e){return res.status(502).json({error:e.message||'Could not submit the exchange closing order.'})}
 let {open,close}=legs;
 open=await reconcileExchangeOrder(open);close=await reconcileExchangeOrder(close);
 if(!close||close.status!=='filled'||Number(close.filled_volume||0)<=0){
  const extStatus=close?.status||'closing';
  if(kind==='self')db.prepare("UPDATE paper_trade_orders SET external_status=?,exchange_close_order_id=COALESCE(?,exchange_close_order_id),updated_at=CURRENT_TIMESTAMP WHERE id=?").run(extStatus,close?.external_order_id||null,t.id);
  else db.prepare("UPDATE managed_trade_requests SET external_status=?,exchange_close_order_id=COALESCE(?,exchange_close_order_id),updated_at=CURRENT_TIMESTAMP WHERE id=?").run(extStatus,close?.external_order_id||null,t.id);
  return res.status(202).json({ok:true,status:'closing',message:'Closing order was submitted. Reconcile again after the exchange reports the fill.',open:exchangeOrderPublic(open),close:exchangeOrderPublic(close)});
 }
 const principal=kind==='self'?Number(t.notional_usd):Number(t.amount),pnl=Number(externalPnl(open,close).toFixed(8)),returned=Math.max(0,Number((principal+pnl).toFixed(8))),pct=principal?Number((pnl/principal*100).toFixed(4)):0;

 if(kind==='managed'){
  let reserveAfter;
  try{
   db.transaction(()=>{
    seedSectionBalances(t.user_id);
    const tr=Number(db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='trading' AND asset='USD'").get(t.user_id)?.amount||0);
    if(tr+1e-8<principal)throw new Error('Trade Reserve is lower than this trade principal.');
    const next=Number((tr+pnl).toFixed(8));
    const otherCommitted=Math.max(0,tradingReserveSnapshot(t.user_id).committed-principal);
    if(next+1e-8<otherCommitted)throw new Error('This exchange settlement would use funds committed to another open trade.');
    db.prepare("UPDATE section_balances SET amount=? WHERE user_id=? AND section='trading' AND asset='USD'").run(next,t.user_id);
    db.prepare(`UPDATE managed_trade_requests SET status='settled',pnl_percent=?,pnl_amount=?,return_amount=?,execution_source='exchange',external_status='filled',exchange_close_order_id=?,admin_note=?,settled_by=?,settled_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'`)
     .run(pct,pnl,returned,close.external_order_id||null,note,req.user.id,t.id);
    if(Math.abs(pnl)>1e-12){
      db.prepare("INSERT INTO demo_transactions(reference,user_id,actor_id,type,asset,amount,direction,status,note) VALUES(?,?,?,?,?,?,?,'completed',?)")
       .run(t.reference+'-EXTSET',t.user_id,req.user.id,'managed_trade_result','USD',Math.abs(pnl),pnl>=0?'credit':'debit',`Kraken realized P/L ${pnl>=0?'+':''}${pnl.toFixed(2)} USD retained in Trade Reserve. ${note}`);
    }
    reserveAfter=tradingReserveSnapshot(t.user_id);
   })();
  }catch(e){return res.status(409).json({error:e.message})}
  const resultWord=pnl>=0?'profit':'loss';
  notifyAndEmail(t.user_id,'trade','Exchange Trade with OptiTrade settled',`Trade ${t.reference} was closed and reconciled from Kraken with a ${resultWord} of ${pnl>=0?'+':''}$${Math.abs(pnl).toFixed(2)}. The resulting $${returned.toFixed(2)} remains in your Trade Reserve. Free reserve: $${reserveAfter.available.toFixed(2)}.`,'/trade.html');
  logActivity(t.user_id,req.user.id,'exchange_managed_trade_settled',`${t.reference} Kraken settlement • P/L ${pnl>=0?'+':''}${pnl.toFixed(2)} USD • retained in Trade Reserve`);
  return res.json({ok:true,status:'settled',pnlAmount:pnl,returnAmount:returned,pnlPercent:pct,reserve:reserveAfter,open:exchangeOrderPublic(open),close:exchangeOrderPublic(close)});
 }

 try{
  db.transaction(()=>{
   seedSectionBalances(t.user_id);
   const tr=Number(db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='trading' AND asset='USD'").get(t.user_id)?.amount||0);
   if(tr+1e-8<principal)throw new Error('Reserved trading balance is lower than this trade principal.');
   db.prepare("UPDATE section_balances SET amount=? WHERE user_id=? AND section='trading' AND asset='USD'").run(Math.max(0,tr-principal),t.user_id);
   const w=Number(db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='wallet' AND asset='USD'").get(t.user_id)?.amount||0);
   db.prepare("UPDATE section_balances SET amount=? WHERE user_id=? AND section='wallet' AND asset='USD'").run(w+returned,t.user_id);
   db.prepare("UPDATE balances SET amount=? WHERE user_id=? AND asset='USD'").run(w+returned,t.user_id);
   db.prepare(`UPDATE paper_trade_orders SET status='settled',pnl_usd=?,return_usd=?,close_price=?,execution_source='exchange',external_status='filled',exchange_close_order_id=?,admin_note=?,settled_by=?,settled_at=CURRENT_TIMESTAMP,closed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'`)
    .run(pnl,returned,Number(close.avg_price||0),close.external_order_id||null,note,req.user.id,t.id);
   db.prepare("INSERT INTO demo_transactions(reference,user_id,actor_id,type,asset,amount,direction,status,note) VALUES(?,?,?,?,?,?,'credit','completed',?)")
    .run(t.reference+'-EXTSET',t.user_id,req.user.id,'trade_settlement','USD',returned,`Exchange settlement. Kraken P/L ${pnl>=0?'+':''}${pnl.toFixed(2)} USD. ${note}`);
  })();
 }catch(e){return res.status(409).json({error:e.message})}
 const resultWord=pnl>=0?'profit':'loss';
 notifyAndEmail(t.user_id,'trade','Exchange trade settled',`Trade ${t.reference} was closed and reconciled from Kraken with a ${resultWord} of ${pnl>=0?'+':''}$${Math.abs(pnl).toFixed(2)}. $${returned.toFixed(2)} was applied to your USD wallet.`,'/trade.html');
 logActivity(t.user_id,req.user.id,'exchange_trade_settled',`${t.reference} Kraken settlement • P/L ${pnl>=0?'+':''}${pnl.toFixed(2)} USD`);
 res.json({ok:true,status:'settled',pnlAmount:pnl,returnAmount:returned,pnlPercent:pct,open:exchangeOrderPublic(open),close:exchangeOrderPublic(close)});
});

// Legacy admin managed-trade endpoint now points to the unified queue.
app.get('/api/admin/managed-trades',admin,(req,res)=>{
 const where=scopedUserWhere(req.user,'u');
 const rows=db.prepare(`SELECT m.*,u.name,u.username,u.email FROM managed_trade_requests m JOIN users u ON u.id=m.user_id WHERE ${where} ORDER BY CASE m.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,m.id DESC LIMIT 300`).all();
 res.json({requests:rows,role:req.user.role});
});


// -----------------------------------------------------------------------------
// Investment Plan Center
// Global plan definitions are controlled by Super Admin.
// Customer funding remains crypto-based (BTC / ETH / USDT).
// A submitted plan request records intent for review; it does not itself claim
// an external market execution or guaranteed return.
// -----------------------------------------------------------------------------
db.exec(`CREATE TABLE IF NOT EXISTS investment_plans(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 subtitle TEXT,
 description TEXT NOT NULL,
 market_focus TEXT NOT NULL,
 risk_level TEXT DEFAULT 'Balanced',
 min_usd REAL NOT NULL DEFAULT 1000,
 active INTEGER DEFAULT 1,
 sort_order INTEGER DEFAULT 0,
 updated_by INTEGER,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS investment_plan_terms(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 plan_id INTEGER NOT NULL,
 duration_days INTEGER NOT NULL,
 target_min_pct REAL,
 target_max_pct REAL,
 sort_order INTEGER DEFAULT 0,
 UNIQUE(plan_id,duration_days)
);
CREATE TABLE IF NOT EXISTS investment_plan_requests(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 reference TEXT UNIQUE NOT NULL,
 user_id INTEGER NOT NULL,
 owner_admin_id INTEGER,
 plan_id INTEGER NOT NULL,
 plan_name TEXT NOT NULL,
 source_asset TEXT NOT NULL,
 source_amount REAL NOT NULL,
 usd_reference_value REAL NOT NULL,
 usd_reference_rate REAL NOT NULL,
 duration_days INTEGER NOT NULL,
 target_min_pct REAL,
 target_max_pct REAL,
 projected_low_usd REAL,
 projected_high_usd REAL,
 status TEXT DEFAULT 'pending',
 customer_note TEXT,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);`);

const investmentRequestColumns=db.prepare('PRAGMA table_info(investment_plan_requests)').all().map(c=>c.name);
const investmentRequestColumnDefs={
 funds_reserved:"INTEGER DEFAULT 0",
 reserved_at:"TEXT",
 approved_by:"INTEGER",
 approved_at:"TEXT",
 started_at:"TEXT",
 maturity_at:"TEXT",
 hold_reason:"TEXT",
 admin_note:"TEXT",
 current_result_pct:"REAL",
 current_result_usd:"REAL",
 current_value_usd:"REAL",
 performance_updated_by:"INTEGER",
 performance_updated_at:"TEXT",
 rejected_by:"INTEGER",
 rejected_at:"TEXT",
 rejection_reason:"TEXT",
 settled_by:"INTEGER",
 settled_at:"TEXT",
 final_result_pct:"REAL",
 final_result_usd:"REAL",
 final_value_usd:"REAL",
 settlement_asset_amount:"REAL",
 settlement_reference_rate:"REAL",
 maturity_soon_notified:"INTEGER DEFAULT 0",
 matured_notified:"INTEGER DEFAULT 0"
};
for(const [name,def] of Object.entries(investmentRequestColumnDefs)){
 if(!investmentRequestColumns.includes(name))db.exec(`ALTER TABLE investment_plan_requests ADD COLUMN ${name} ${def}`);
}


try{
 const count=Number(db.prepare('SELECT COUNT(*) n FROM investment_plans').get()?.n||0);
 if(!count){
   const seed=db.prepare(`INSERT INTO investment_plans(name,subtitle,description,market_focus,risk_level,min_usd,active,sort_order)
     VALUES(?,?,?,?,?,?,1,?)`);
   const terms=db.prepare(`INSERT OR IGNORE INTO investment_plan_terms(plan_id,duration_days,target_min_pct,target_max_pct,sort_order)
     VALUES(?,?,?,?,?)`);
   const seeded=[
    ['Crypto Basket','Crypto allocation strategy','A strategy model focused on major crypto assets with allocations that can be configured around BTC, ETH and stablecoin exposure.','BTC • ETH • USDT','High',1000,1],
    ['Market Growth','Multi-market growth strategy','A broader strategy model designed around major market opportunities and a flexible managed allocation approach.','Crypto • FX reference markets','Medium-High',1000,2],
    ['Balanced Portfolio','Diversified allocation strategy','A balanced strategy model intended to spread exposure across growth assets and more stable allocations.','BTC • ETH • USDT mix','Balanced',1000,3]
   ];
   db.transaction(()=>{
     for(const x of seeded){
       const info=seed.run(...x);
       for(const [idx,days] of [14,30,60,90].entries())terms.run(info.lastInsertRowid,days,null,null,idx+1);
     }
   })();
 }
}catch(e){console.warn('[INVESTMENT PLAN SEED]',e.message)}

// Stage 15: investment periods start from 14 days.
// Existing plan terms are preserved; a 14-day option is appended once where missing.
if(!db.prepare('SELECT migration_key FROM support_faq_feature_migrations WHERE migration_key=?').get('investment_14day_terms_v1')){
 db.transaction(()=>{
   const insert14=db.prepare(`INSERT OR IGNORE INTO investment_plan_terms(
     plan_id,duration_days,target_min_pct,target_max_pct,sort_order
   ) VALUES(?,14,NULL,NULL,0)`);
   for(const p of db.prepare('SELECT id FROM investment_plans').all())insert14.run(p.id);

   // Keep the global Help Center wording aligned with the new minimum period.
   db.prepare(`UPDATE support_faqs
     SET answer=replace(answer,'such as 30, 60 or 90 days','starting from 14 days, with longer periods such as 30, 60 or 90 days'),
         updated_at=CURRENT_TIMESTAMP
     WHERE lower(question)=lower('Can I choose how long an Investment Plan runs?')`).run();

   // Update only the old seeded wording in local Quick Help copies; custom wording otherwise stays untouched.
   db.prepare(`UPDATE support_faq_admin_items
     SET answer=replace(answer,'such as 30, 60 or 90 days','starting from 14 days, with longer periods such as 30, 60 or 90 days'),
         updated_at=CURRENT_TIMESTAMP
     WHERE lower(question)=lower('Can I choose how long an Investment Plan runs?')
       AND answer LIKE '%such as 30, 60 or 90 days%'`).run();

   db.prepare('INSERT INTO support_faq_feature_migrations(migration_key) VALUES(?)').run('investment_14day_terms_v1');
 })();
}

function investmentPlanRow(id,activeOnly=false){
 const p=db.prepare(`SELECT * FROM investment_plans WHERE id=? ${activeOnly?'AND active=1':''}`).get(id);
 if(!p)return null;
 p.terms=db.prepare('SELECT id,duration_days,target_min_pct,target_max_pct,sort_order FROM investment_plan_terms WHERE plan_id=? ORDER BY sort_order,id').all(p.id);
 return p;
}
function investmentPlanRows(activeOnly=false){
 const rows=db.prepare(`SELECT * FROM investment_plans ${activeOnly?'WHERE active=1':''} ORDER BY sort_order,id`).all();
 return rows.map(p=>({...p,terms:db.prepare('SELECT id,duration_days,target_min_pct,target_max_pct,sort_order FROM investment_plan_terms WHERE plan_id=? ORDER BY sort_order,id').all(p.id)}));
}
function investmentRef(){return 'OT-INV-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(3).toString('hex').toUpperCase()}
function investmentAssetPrice(prices,asset){
 if(asset==='USD')return 1;
 if(asset==='USDT')return Number(prices.USDT||1);
 if(asset==='BTC')return Number(prices.BTC||0);
 if(asset==='ETH')return Number(prices.ETH||0);
 return 0;
}
async function investmentQuoteFor(user,plan,asset,amount,duration){
 if(!['USD','BTC','ETH','USDT'].includes(asset))throw new Error('Choose an available funding balance.');
 const term=plan.terms.find(x=>Number(x.duration_days)===Number(duration));
 if(!term)throw new Error('Choose one of the available plan periods.');
 let price=1;
 if(asset!=='USD'){
   const prices=await portfolioReferencePrices();
   price=investmentAssetPrice(prices,asset);
   if(!(price>0))throw new Error(`${asset} reference price is unavailable.`);
 }
 const usdValue=Number(amount)*price;
 const balance=withdrawalWalletAmount(user.id,asset);
 const reserved=withdrawalReserved(user.id,asset);
 const available=Math.max(0,balance-reserved);
 if(Number(amount)>available+1e-12)throw new Error(`Insufficient available ${asset} balance.`);
 if(usdValue+1e-8<Number(plan.min_usd||0))throw new Error(`This plan requires at least $${Number(plan.min_usd||0).toLocaleString()} equivalent.`);
 const minPct=term.target_min_pct==null?null:Number(term.target_min_pct);
 const maxPct=term.target_max_pct==null?null:Number(term.target_max_pct);
 return {
   term,price,usdValue,balance,reserved,available,
   targetMinPct:minPct,targetMaxPct:maxPct,
   projectedLowUsd:minPct==null?null:usdValue*(1+minPct/100),
   projectedHighUsd:maxPct==null?null:usdValue*(1+maxPct/100)
 };
}

function investmentRequestForActor(actor,id){
 const r=db.prepare('SELECT * FROM investment_plan_requests WHERE id=?').get(id);
 if(!r)return null;
 return ownsUser(actor,r.user_id)?r:null;
}
function investmentReservedBalance(userId,asset){
 seedSectionBalances(userId);
 return Number(db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='investment' AND asset=?").get(userId,asset)?.amount||0);
}
function reserveInvestmentFunds(userId,asset,amount){
 seedSectionBalances(userId);
 const wallet=Number(db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='wallet' AND asset=?").get(userId,asset)?.amount||0);
 const reservedWithdrawal=withdrawalReserved(userId,asset);
 const available=Math.max(0,wallet-reservedWithdrawal);
 if(Number(amount)>available+1e-12)throw new Error(`Insufficient available ${asset} balance.`);
 moveSectionBalance(userId,'wallet','investment',asset,Number(amount));
}
function releaseInvestmentFunds(userId,asset,amount){
 seedSectionBalances(userId);
 const inv=Number(db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='investment' AND asset=?").get(userId,asset)?.amount||0);
 if(inv+1e-12<Number(amount))throw new Error('Reserved investment balance is unavailable.');
 moveSectionBalance(userId,'investment','wallet',asset,Number(amount));
}
function investmentIsoNow(){return new Date().toISOString()}
function investmentMaturityDate(days,start=new Date()){
 const d=new Date(start);d.setUTCDate(d.getUTCDate()+Number(days||0));return d.toISOString();
}
function investmentProgress(row){
 if(!row.started_at||!row.maturity_at)return 0;
 const start=Date.parse(row.started_at),end=Date.parse(row.maturity_at),now=Date.now();
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return 0;
 return Math.max(0,Math.min(100,((now-start)/(end-start))*100));
}
function investmentDaysRemaining(row){
 if(!row.maturity_at)return null;
 const ms=Date.parse(row.maturity_at)-Date.now();
 return Math.max(0,Math.ceil(ms/86400000));
}
function publicInvestmentRequest(row){
 return {
   ...row,
   source_amount:Number(row.source_amount||0),
   usd_reference_value:Number(row.usd_reference_value||0),
   usd_reference_rate:Number(row.usd_reference_rate||0),
   target_min_pct:row.target_min_pct==null?null:Number(row.target_min_pct),
   target_max_pct:row.target_max_pct==null?null:Number(row.target_max_pct),
   projected_low_usd:row.projected_low_usd==null?null:Number(row.projected_low_usd),
   projected_high_usd:row.projected_high_usd==null?null:Number(row.projected_high_usd),
   current_result_pct:row.current_result_pct==null?null:Number(row.current_result_pct),
   current_result_usd:row.current_result_usd==null?null:Number(row.current_result_usd),
   current_value_usd:row.current_value_usd==null?null:Number(row.current_value_usd),
   final_result_pct:row.final_result_pct==null?null:Number(row.final_result_pct),
   final_result_usd:row.final_result_usd==null?null:Number(row.final_result_usd),
   final_value_usd:row.final_value_usd==null?null:Number(row.final_value_usd),
   settlement_asset_amount:row.settlement_asset_amount==null?null:Number(row.settlement_asset_amount),
   settlement_reference_rate:row.settlement_reference_rate==null?null:Number(row.settlement_reference_rate),
   progress:investmentProgress(row),
   daysRemaining:investmentDaysRemaining(row),
   matured:!!row.maturity_at&&Date.parse(row.maturity_at)<=Date.now()
 };
}
function maybeNotifyInvestmentMaturity(userId){
 const now=Date.now(),soon=now+3*86400000;
 const rows=db.prepare(`SELECT * FROM investment_plan_requests
   WHERE user_id=? AND status IN ('active','on_hold') AND maturity_at IS NOT NULL`).all(userId);
 for(const r of rows){
   const maturity=Date.parse(r.maturity_at);if(!Number.isFinite(maturity))continue;
   if(maturity<=now && !Number(r.matured_notified||0)){
     db.prepare('UPDATE investment_plan_requests SET matured_notified=1 WHERE id=?').run(r.id);
     notifyAndEmail(userId,'investment_plan','Investment reached maturity',`${r.plan_name} (${r.reference}) has reached its maturity date and is ready for settlement.`,'/investment-position.html?id='+r.id);
   }else if(maturity>now&&maturity<=soon&&!Number(r.maturity_soon_notified||0)){
     db.prepare('UPDATE investment_plan_requests SET maturity_soon_notified=1 WHERE id=?').run(r.id);
     notifyAndEmail(userId,'investment_plan','Investment maturity approaching',`${r.plan_name} (${r.reference}) is approaching maturity on ${new Date(maturity).toLocaleDateString()}.`,'/investment-position.html?id='+r.id);
   }
 }
}

app.get('/api/investment-plans',auth,(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required.'});
 res.set('Cache-Control','no-store');
 res.json({plans:investmentPlanRows(true)});
});
app.get('/api/investment-plans/:id',auth,(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required.'});
 const plan=investmentPlanRow(Number(req.params.id),true);
 if(!plan)return res.status(404).json({error:'Investment plan not found or unavailable.'});
 res.set('Cache-Control','no-store');res.json({plan});
});
app.get('/api/investment-plans/:id/quote',auth,async(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required.'});
 const plan=investmentPlanRow(Number(req.params.id),true);
 if(!plan)return res.status(404).json({error:'Investment plan not found or unavailable.'});
 const asset=String(req.query.asset||'').toUpperCase(),amount=Number(req.query.amount),duration=Number(req.query.duration);
 if(!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:'Enter a valid funding amount.'});
 try{
   const q=await investmentQuoteFor(req.user,plan,asset,amount,duration);
   res.set('Cache-Control','no-store');
   res.json({
     ok:true,planId:plan.id,planName:plan.name,asset,amount,durationDays:Number(duration),
     usdValue:q.usdValue,assetUsdPrice:q.price,available:q.available,
     targetMinPct:q.targetMinPct,targetMaxPct:q.targetMaxPct,
     projectedLowUsd:q.projectedLowUsd,projectedHighUsd:q.projectedHighUsd,
     updatedAt:new Date().toISOString()
   });
 }catch(e){res.status(400).json({error:e.message||'Could not prepare this plan quote.'})}
});
app.post('/api/investment-plans/:id/request',auth,async(req,res)=>{
 const kyc=kycGate(req.user,'investment');if(!kyc.ok)return res.status(403).json(kyc);
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required.'});
 const plan=investmentPlanRow(Number(req.params.id),true);
 if(!plan)return res.status(404).json({error:'Investment plan not found or unavailable.'});
 const asset=String(req.body.asset||'').toUpperCase(),amount=Number(req.body.amount),duration=Number(req.body.duration),pin=String(req.body.pin||''),note=String(req.body.note||'').trim().slice(0,500);
 if(!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:'Enter a valid funding amount.'});
 const pinCheck=sensitivePinCheck(req.user.id,pin);if(!pinCheck.ok)return res.status(pinCheck.status).json(pinCheck);
 let q;try{q=await investmentQuoteFor(req.user,plan,asset,amount,duration)}catch(e){return res.status(400).json({error:e.message||'Could not validate this plan request.'})}
 const ref=investmentRef(),owner=walletOwnerForUser(req.user);
 try{
   db.transaction(()=>{
     reserveInvestmentFunds(req.user.id,asset,amount);
     db.prepare(`INSERT INTO investment_plan_requests(
       reference,user_id,owner_admin_id,plan_id,plan_name,source_asset,source_amount,usd_reference_value,usd_reference_rate,
       duration_days,target_min_pct,target_max_pct,projected_low_usd,projected_high_usd,status,customer_note,funds_reserved,reserved_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,1,CURRENT_TIMESTAMP)`).run(
       ref,req.user.id,owner||null,plan.id,plan.name,asset,amount,q.usdValue,q.price,duration,
       q.targetMinPct,q.targetMaxPct,q.projectedLowUsd,q.projectedHighUsd,note||null
     );
     db.prepare("INSERT INTO demo_transactions(reference,user_id,actor_id,type,asset,amount,direction,status,note) VALUES(?,?,?,?,?,?,'debit','completed',?)")
       .run(ref,req.user.id,req.user.id,'investment_reserve',asset,amount,`Reserved for ${plan.name} investment request.`);
   })();
 }catch(e){return res.status(400).json({error:e.message||'Could not reserve funds for this investment request.'})}
 logActivity(req.user.id,req.user.id,'investment_plan_request',`${plan.name} request ${ref} submitted and ${amount} ${asset} reserved • ${duration} days`);
 notifyAndEmail(req.user.id,'investment_plan','Investment plan request submitted',`Your ${plan.name} request ${ref} has been submitted for review. ${amount} ${asset} is now reserved for the request.`,'/investments.html');
 if(owner){
   try{
     notifyAdminEvent(owner,'trade','Investment plan request',`${req.user.name||req.user.username||'Customer'} submitted ${plan.name}: ${amount} ${asset} (${money(q.usdValue)} reference value), ${duration} days.`,'/admin/investment-plans.html');
   }catch(e){
     console.error('[INVESTMENT ADMIN NOTICE]',e.message||e);
   }
 }
 const availableBalanceAfter=Math.max(0,withdrawalWalletAmount(req.user.id,asset)-withdrawalReserved(req.user.id,asset));
 const investmentReservedAfter=investmentReservedBalance(req.user.id,asset);
 res.json({
   ok:true,reference:ref,status:'pending',reserved:true,
   fundingAsset:asset,
   availableBalanceAfter,
   investmentReservedAfter
 });
});

app.get('/api/investment-requests',auth,(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required.'});
 maybeNotifyInvestmentMaturity(req.user.id);
 const requests=db.prepare(`SELECT * FROM investment_plan_requests WHERE user_id=? ORDER BY id DESC LIMIT 100`).all(req.user.id).map(publicInvestmentRequest);
 res.set('Cache-Control','no-store');res.json({requests});
});
app.get('/api/investment-requests/:id',auth,(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required.'});
 maybeNotifyInvestmentMaturity(req.user.id);
 const row=db.prepare('SELECT * FROM investment_plan_requests WHERE id=? AND user_id=?').get(req.params.id,req.user.id);
 if(!row)return res.status(404).json({error:'Investment record not found.'});
 res.set('Cache-Control','no-store');res.json({investment:publicInvestmentRequest(row)});
});
app.post('/api/investment-requests/:id/cancel',auth,(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required.'});
 const row=db.prepare('SELECT * FROM investment_plan_requests WHERE id=? AND user_id=?').get(req.params.id,req.user.id);
 if(!row)return res.status(404).json({error:'Investment request not found.'});
 if(row.status!=='pending')return res.status(409).json({error:'Only a pending investment request can be cancelled.'});
 try{
   db.transaction(()=>{
     if(Number(row.funds_reserved||0)===1){
       releaseInvestmentFunds(row.user_id,row.source_asset,Number(row.source_amount));
       db.prepare("INSERT INTO demo_transactions(reference,user_id,actor_id,type,asset,amount,direction,status,note) VALUES(?,?,?,?,?,?,'credit','completed',?)")
         .run(row.reference+'-CAN',row.user_id,row.user_id,'investment_release',row.source_asset,Number(row.source_amount),'Investment request cancelled; reserved funds released.');
     }
     db.prepare("UPDATE investment_plan_requests SET status='cancelled',funds_reserved=0,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
   })();
 }catch(e){return res.status(409).json({error:e.message||'Could not cancel this investment request.'})}
 logActivity(row.user_id,row.user_id,'investment_cancelled',`${row.reference} cancelled; ${row.source_amount} ${row.source_asset} released.`);
 notifyAndEmail(row.user_id,'investment_plan','Investment request cancelled',`${row.plan_name} request ${row.reference} was cancelled and the reserved ${row.source_asset} was released back to your wallet.`,'/investments.html');
 res.json({ok:true,status:'cancelled'});
});

app.get('/api/investments/summary',auth,(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required.'});
 maybeNotifyInvestmentMaturity(req.user.id);
 const active=db.prepare(`SELECT * FROM investment_plan_requests WHERE user_id=? AND status IN ('active','on_hold') ORDER BY maturity_at ASC,id DESC`).all(req.user.id).map(publicInvestmentRequest);
 const allocatedUsd=active.reduce((s,x)=>s+Number(x.usd_reference_value||0),0);
 const currentValueUsd=active.reduce((s,x)=>s+Number(x.current_value_usd==null?x.usd_reference_value:x.current_value_usd),0);
 const nearest=active.find(x=>x.maturity_at)||null;
 res.set('Cache-Control','no-store');
 res.json({activeCount:active.length,allocatedUsd,currentValueUsd,nearestMaturity:nearest?.maturity_at||null,nearestPlan:nearest?.plan_name||null,active});
});

// Admin center: everyone can manage requests in their customer scope;
// only Super Admin edits global plan definitions.
app.get('/api/admin/investment-center',admin,(req,res)=>{
 const plans=investmentPlanRows(false),where=scopedUserWhere(req.user,'u');
 const requests=db.prepare(`SELECT r.*,u.name customer_name,u.username customer_username,u.email customer_email
   FROM investment_plan_requests r JOIN users u ON u.id=r.user_id WHERE ${where}
   ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 WHEN 'on_hold' THEN 2 ELSE 3 END,
   COALESCE(r.maturity_at,r.created_at) ASC,r.id DESC LIMIT 300`).all().map(publicInvestmentRequest);
 res.set('Cache-Control','no-store');
 res.json({role:req.user.role,canManagePlans:isSuper(req.user),plans,requests});
});

app.post('/api/admin/investment-requests/:id/action',admin,(req,res)=>{
 const row=investmentRequestForActor(req.user,Number(req.params.id));
 if(!row)return res.status(403).json({error:'Investment request unavailable.'});
 const action=String(req.body.action||'').toLowerCase(),reason=String(req.body.reason||'').trim().slice(0,500);
 if(!['approve','reject','hold','resume'].includes(action))return res.status(400).json({error:'Choose a valid investment action.'});

 if(action==='approve'){
   if(row.status!=='pending')return res.status(409).json({error:'Only pending requests can be approved.'});
   const started=investmentIsoNow(),maturity=investmentMaturityDate(row.duration_days,new Date(started));
   try{
     db.transaction(()=>{
       if(Number(row.funds_reserved||0)!==1){
         reserveInvestmentFunds(row.user_id,row.source_asset,Number(row.source_amount));
         db.prepare("INSERT INTO demo_transactions(reference,user_id,actor_id,type,asset,amount,direction,status,note) VALUES(?,?,?,?,?,?,'debit','completed',?)")
           .run(row.reference,row.user_id,req.user.id,'investment_reserve',row.source_asset,Number(row.source_amount),'Reserved when legacy investment request was approved.');
       }
       db.prepare(`UPDATE investment_plan_requests SET status='active',funds_reserved=1,approved_by=?,approved_at=?,started_at=?,maturity_at=?,admin_note=?,updated_at=CURRENT_TIMESTAMP
         WHERE id=? AND status='pending'`).run(req.user.id,started,started,maturity,reason||null,row.id);
     })();
   }catch(e){return res.status(409).json({error:e.message||'Could not activate this investment.'})}
   logActivity(row.user_id,req.user.id,'investment_activated',`${row.reference} activated • matures ${maturity}`);
   notifyAndEmail(row.user_id,'investment_plan','Investment now active',`${row.plan_name} (${row.reference}) is now active. Start: ${new Date(started).toLocaleDateString()}. Maturity: ${new Date(maturity).toLocaleDateString()}.`,'/investment-position.html?id='+row.id);
   return res.json({ok:true,status:'active',startedAt:started,maturityAt:maturity});
 }

 if(action==='reject'){
   if(row.status!=='pending')return res.status(409).json({error:'Only pending requests can be rejected.'});
   if(reason.length<3)return res.status(400).json({error:'Enter a customer-visible rejection reason.'});
   try{
     db.transaction(()=>{
       if(Number(row.funds_reserved||0)===1){
         releaseInvestmentFunds(row.user_id,row.source_asset,Number(row.source_amount));
         db.prepare("INSERT INTO demo_transactions(reference,user_id,actor_id,type,asset,amount,direction,status,note) VALUES(?,?,?,?,?,?,'credit','completed',?)")
           .run(row.reference+'-REL',row.user_id,req.user.id,'investment_release',row.source_asset,Number(row.source_amount),`Investment request rejected: ${reason}`);
       }
       db.prepare(`UPDATE investment_plan_requests SET status='rejected',funds_reserved=0,rejected_by=?,rejected_at=CURRENT_TIMESTAMP,rejection_reason=?,admin_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
         .run(req.user.id,reason,reason,row.id);
     })();
   }catch(e){return res.status(409).json({error:e.message||'Could not reject this investment request.'})}
   logActivity(row.user_id,req.user.id,'investment_rejected',`${row.reference} rejected; reserved funds released.`);
   notifyAndEmail(row.user_id,'investment_plan','Investment request declined',`${row.plan_name} request ${row.reference} was declined. Reason: ${reason}. Reserved ${row.source_asset} has been released back to your wallet.`,'/investments.html');
   return res.json({ok:true,status:'rejected'});
 }

 if(action==='hold'){
   if(row.status!=='active')return res.status(409).json({error:'Only an active investment can be placed on hold.'});
   if(reason.length<3)return res.status(400).json({error:'Enter a customer-visible hold reason.'});
   db.prepare("UPDATE investment_plan_requests SET status='on_hold',hold_reason=?,admin_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(reason,reason,row.id);
   logActivity(row.user_id,req.user.id,'investment_hold',`${row.reference} placed on hold: ${reason}`);
   notifyAndEmail(row.user_id,'investment_plan','Investment placed on hold',`${row.plan_name} (${row.reference}) is on hold. Reason: ${reason}`,'/investment-position.html?id='+row.id);
   return res.json({ok:true,status:'on_hold'});
 }

 if(action==='resume'){
   if(row.status!=='on_hold')return res.status(409).json({error:'Only an investment on hold can be resumed.'});
   db.prepare("UPDATE investment_plan_requests SET status='active',hold_reason=NULL,admin_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(reason||null,row.id);
   logActivity(row.user_id,req.user.id,'investment_resumed',`${row.reference} resumed.`);
   notifyAndEmail(row.user_id,'investment_plan','Investment resumed',`${row.plan_name} (${row.reference}) is active again.`,'/investment-position.html?id='+row.id);
   return res.json({ok:true,status:'active'});
 }
});

app.put('/api/admin/investment-requests/:id/performance',admin,(req,res)=>{
 const row=investmentRequestForActor(req.user,Number(req.params.id));
 if(!row)return res.status(403).json({error:'Investment request unavailable.'});
 if(!['active','on_hold'].includes(row.status))return res.status(409).json({error:'Performance can only be updated for an active investment.'});
 const pct=Number(req.body.resultPct),note=String(req.body.note||'').trim().slice(0,500);
 if(!Number.isFinite(pct)||pct<-100||pct>1000)return res.status(400).json({error:'Result must be between -100% and 1000%.'});
 const resultUsd=Number(row.usd_reference_value)*(pct/100),valueUsd=Math.max(0,Number(row.usd_reference_value)+resultUsd);
 db.prepare(`UPDATE investment_plan_requests SET current_result_pct=?,current_result_usd=?,current_value_usd=?,admin_note=?,performance_updated_by=?,performance_updated_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
   .run(pct,resultUsd,valueUsd,note||row.admin_note||null,req.user.id,row.id);
 logActivity(row.user_id,req.user.id,'investment_performance_update',`${row.reference} performance updated to ${pct>=0?'+':''}${pct}%`);
 notifyAndEmail(row.user_id,'investment_plan','Investment performance updated',`${row.plan_name} (${row.reference}) has a new performance update: ${pct>=0?'+':''}${pct}% (${money(resultUsd)} result on the starting reference value).`,'/investment-position.html?id='+row.id,{email:false});
 res.json({ok:true,currentResultPct:pct,currentResultUsd:resultUsd,currentValueUsd:valueUsd});
});

app.post('/api/admin/investment-requests/:id/settle',admin,async(req,res)=>{
 const row=investmentRequestForActor(req.user,Number(req.params.id));
 if(!row)return res.status(403).json({error:'Investment request unavailable.'});
 if(!['active','on_hold'].includes(row.status))return res.status(409).json({error:'Only an active or on-hold investment can be settled.'});
 const mature=!!row.maturity_at&&Date.parse(row.maturity_at)<=Date.now();
 const allowEarly=req.body.allowEarly===true&&isSuper(req.user);
 if(!mature&&!allowEarly)return res.status(409).json({error:'This investment has not reached maturity yet. Only Super Admin can explicitly authorize an early settlement.'});
 const pct=Number(req.body.finalResultPct),note=String(req.body.note||'').trim().slice(0,500);
 if(!Number.isFinite(pct)||pct<-100||pct>1000)return res.status(400).json({error:'Final result must be between -100% and 1000%.'});
 const finalResultUsd=Number(row.usd_reference_value)*(pct/100),finalValueUsd=Math.max(0,Number(row.usd_reference_value)+finalResultUsd);
 let settlementRate=1;
 if(row.source_asset!=='USD'){
   let prices;try{prices=await portfolioReferencePrices()}catch{return res.status(503).json({error:'Reference market prices are unavailable for settlement.'})}
   settlementRate=investmentAssetPrice(prices,row.source_asset);
   if(!(settlementRate>0))return res.status(503).json({error:`${row.source_asset} settlement reference price is unavailable.`});
 }
 const settlementAssetAmount=finalValueUsd/settlementRate;
 try{
   db.transaction(()=>{
     seedSectionBalances(row.user_id);
     const inv=Number(db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='investment' AND asset=?").get(row.user_id,row.source_asset)?.amount||0);
     if(inv+1e-12<Number(row.source_amount))throw new Error('Reserved investment principal is unavailable.');
     const wallet=Number(db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='wallet' AND asset=?").get(row.user_id,row.source_asset)?.amount||0);
     db.prepare("UPDATE section_balances SET amount=? WHERE user_id=? AND section='investment' AND asset=?").run(Math.max(0,inv-Number(row.source_amount)),row.user_id,row.source_asset);
     db.prepare("UPDATE section_balances SET amount=? WHERE user_id=? AND section='wallet' AND asset=?").run(wallet+settlementAssetAmount,row.user_id,row.source_asset);
     db.prepare("UPDATE balances SET amount=? WHERE user_id=? AND asset=?").run(wallet+settlementAssetAmount,row.user_id,row.source_asset);
     db.prepare(`UPDATE investment_plan_requests SET status='settled',funds_reserved=0,final_result_pct=?,final_result_usd=?,final_value_usd=?,settlement_asset_amount=?,settlement_reference_rate=?,settled_by=?,settled_at=CURRENT_TIMESTAMP,admin_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
       .run(pct,finalResultUsd,finalValueUsd,settlementAssetAmount,settlementRate,req.user.id,note||row.admin_note||null,row.id);
     db.prepare("INSERT INTO demo_transactions(reference,user_id,actor_id,type,asset,amount,direction,status,note) VALUES(?,?,?,?,?,?,'credit','completed',?)")
       .run(row.reference+'-SET',row.user_id,req.user.id,'investment_settlement',row.source_asset,settlementAssetAmount,`Investment settlement. Final result ${pct>=0?'+':''}${pct}% (${money(finalResultUsd)}).`);
   })();
 }catch(e){return res.status(409).json({error:e.message||'Could not settle this investment.'})}
 logActivity(row.user_id,req.user.id,'investment_settled',`${row.reference} settled • ${pct>=0?'+':''}${pct}% • ${settlementAssetAmount} ${row.source_asset}`);
 notifyAndEmail(row.user_id,'investment_plan','Investment settled',`${row.plan_name} (${row.reference}) has been settled. Final result: ${pct>=0?'+':''}${pct}% (${money(finalResultUsd)}). ${settlementAssetAmount.toLocaleString(undefined,{maximumFractionDigits:10})} ${row.source_asset} was applied to your wallet at the settlement reference price.`,'/investment-position.html?id='+row.id);
 res.json({ok:true,status:'settled',finalResultPct:pct,finalResultUsd,finalValueUsd,settlementAssetAmount,settlementReferenceRate:settlementRate});
});

app.put('/api/super/investment-plans',superAdmin,(req,res)=>{
 const incoming=Array.isArray(req.body.plans)?req.body.plans:[];
 if(incoming.length>12)return res.status(400).json({error:'Use no more than 12 investment plans.'});
 const clean=incoming.map((x,i)=>({
   id:Number(x.id)||null,
   name:String(x.name||'').trim().slice(0,100),
   subtitle:String(x.subtitle||'').trim().slice(0,160),
   description:String(x.description||'').trim().slice(0,1800),
   marketFocus:String(x.marketFocus||'').trim().slice(0,180),
   riskLevel:String(x.riskLevel||'Balanced').trim().slice(0,60),
   minUsd:Number(x.minUsd),
   active:x.active!==false?1:0,
   sortOrder:i+1,
   terms:(Array.isArray(x.terms)?x.terms:[]).slice(0,8).map((t,j)=>({
     days:Math.round(Number(t.days)),
     minPct:t.minPct===''||t.minPct==null?null:Number(t.minPct),
     maxPct:t.maxPct===''||t.maxPct==null?null:Number(t.maxPct),
     sortOrder:j+1
   }))
 }));
 for(const p of clean){
   if(!p.name||!p.description||!p.marketFocus)return res.status(400).json({error:'Every plan needs a name, description and market focus.'});
   if(!Number.isFinite(p.minUsd)||p.minUsd<1)return res.status(400).json({error:`${p.name}: minimum allocation must be at least $1.`});
   if(!p.terms.length)return res.status(400).json({error:`${p.name}: add at least one duration.`});
   const seen=new Set();
   for(const t of p.terms){
     if(!Number.isFinite(t.days)||t.days<14||t.days>3650)return res.status(400).json({error:`${p.name}: investment duration must be between 14 and 3650 days.`});
     if(seen.has(t.days))return res.status(400).json({error:`${p.name}: each duration must be unique.`});seen.add(t.days);
     if((t.minPct!=null&&!Number.isFinite(t.minPct))||(t.maxPct!=null&&!Number.isFinite(t.maxPct)))return res.status(400).json({error:`${p.name}: target percentages must be numeric.`});
     if(t.minPct!=null&&t.maxPct!=null&&t.minPct>t.maxPct)return res.status(400).json({error:`${p.name}: minimum target cannot exceed maximum target.`});
   }
 }
 db.transaction(()=>{
   const kept=[];
   for(const p of clean){
     let id=p.id;
     const existing=id?db.prepare('SELECT id FROM investment_plans WHERE id=?').get(id):null;
     if(existing){
       db.prepare(`UPDATE investment_plans SET name=?,subtitle=?,description=?,market_focus=?,risk_level=?,min_usd=?,active=?,sort_order=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
         .run(p.name,p.subtitle||null,p.description,p.marketFocus,p.riskLevel,p.minUsd,p.active,p.sortOrder,req.user.id,id);
     }else{
       const info=db.prepare(`INSERT INTO investment_plans(name,subtitle,description,market_focus,risk_level,min_usd,active,sort_order,updated_by)
         VALUES(?,?,?,?,?,?,?,?,?)`).run(p.name,p.subtitle||null,p.description,p.marketFocus,p.riskLevel,p.minUsd,p.active,p.sortOrder,req.user.id);
       id=Number(info.lastInsertRowid);
     }
     kept.push(id);
     db.prepare('DELETE FROM investment_plan_terms WHERE plan_id=?').run(id);
     const ins=db.prepare('INSERT INTO investment_plan_terms(plan_id,duration_days,target_min_pct,target_max_pct,sort_order) VALUES(?,?,?,?,?)');
     for(const t of p.terms)ins.run(id,t.days,t.minPct,t.maxPct,t.sortOrder);
   }
   if(kept.length){
     const ph=kept.map(()=>'?').join(',');
     db.prepare(`UPDATE investment_plans SET active=0 WHERE id NOT IN (${ph})`).run(...kept);
   }else db.prepare('UPDATE investment_plans SET active=0').run();
 })();
 res.json({ok:true,plans:investmentPlanRows(false)});
});



// -----------------------------------------------------------------------------
// Internal Transfer
// Customer-to-customer transfers inside OptiProTrade.
// Supported assets: BTC, ETH, USDT. No external blockchain transaction occurs.
// -----------------------------------------------------------------------------
db.exec(`CREATE TABLE IF NOT EXISTS internal_transfers(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 reference TEXT UNIQUE NOT NULL,
 sender_user_id INTEGER NOT NULL,
 recipient_user_id INTEGER NOT NULL,
 asset TEXT NOT NULL,
 amount REAL NOT NULL,
 fee_amount REAL NOT NULL DEFAULT 0,
 note TEXT,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);`);
try{db.exec('CREATE INDEX IF NOT EXISTS idx_internal_transfers_sender ON internal_transfers(sender_user_id,id DESC)')}catch{}
try{db.exec('CREATE INDEX IF NOT EXISTS idx_internal_transfers_recipient ON internal_transfers(recipient_user_id,id DESC)')}catch{}

function internalTransferRef(){
 return 'OT-TRF-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(3).toString('hex').toUpperCase();
}
function findTransferRecipient(identifier){
 const v=String(identifier||'').trim();
 if(!v)return null;
 return db.prepare(`SELECT id,name,username,email,email_verified
   FROM users
   WHERE role='user' AND (lower(username)=lower(?) OR lower(email)=lower(?))
   LIMIT 1`).get(v,v);
}
function internalTransferAssetState(userId,asset){
 seedSectionBalances(userId);
 const row=db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='wallet' AND asset=?").get(userId,asset);
 const balance=Number(row?.amount||0);
 const reserved=withdrawalReserved(userId,asset);
 return {balance,reserved,available:Math.max(0,balance-reserved)};
}
function publicTransferRecipient(u){
 return {
   id:u.id,
   name:String(u.name||'OptiProTrade Customer'),
   username:u.username||null,
   emailMasked:maskEmail(u.email||''),
   verified:!!u.email_verified
 };
}

app.get('/api/internal-transfer/status',auth,(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required.'});
 const assets=['BTC','ETH','USDT'].map(asset=>({asset,...internalTransferAssetState(req.user.id,asset)}));
 res.set('Cache-Control','no-store');
 res.json({eligibility:kycGate(req.user,'internal_transfer'),enabled:true,feePercent:0,feeAmount:0,assets});
});

app.get('/api/internal-transfer/recipient',auth,(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required.'});
 const recipient=findTransferRecipient(req.query.identifier);
 if(!recipient)return res.status(404).json({error:'No OptiProTrade customer was found with that exact username or email.'});
 if(Number(recipient.id)===Number(req.user.id))return res.status(400).json({error:'You cannot transfer funds to your own account.'});
 if(!recipient.email_verified)return res.status(409).json({error:'This recipient account has not completed email verification.'});
 res.set('Cache-Control','no-store');
 res.json({ok:true,recipient:publicTransferRecipient(recipient)});
});

app.get('/api/internal-transfer/history',auth,(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required.'});
 const rows=db.prepare(`SELECT t.*,
   su.name sender_name,su.username sender_username,
   ru.name recipient_name,ru.username recipient_username
   FROM internal_transfers t
   JOIN users su ON su.id=t.sender_user_id
   JOIN users ru ON ru.id=t.recipient_user_id
   WHERE t.sender_user_id=? OR t.recipient_user_id=?
   ORDER BY t.id DESC LIMIT 50`).all(req.user.id,req.user.id);
 const transfers=rows.map(x=>({
   id:x.id,reference:x.reference,asset:x.asset,amount:Number(x.amount),feeAmount:Number(x.fee_amount||0),
   note:x.note||'',createdAt:x.created_at,
   direction:Number(x.sender_user_id)===Number(req.user.id)?'sent':'received',
   counterparty:Number(x.sender_user_id)===Number(req.user.id)
     ? {name:x.recipient_name,username:x.recipient_username}
     : {name:x.sender_name,username:x.sender_username}
 }));
 res.set('Cache-Control','no-store');res.json({transfers});
});

app.post('/api/internal-transfer',auth,(req,res)=>{
 if(req.user.role!=='user')return res.status(403).json({error:'Customer account required.'});
 const eligibility=kycGate(req.user,'internal_transfer');if(!eligibility.ok)return res.status(403).json(eligibility);
 const identifier=String(req.body.recipient||'').trim();
 const asset=String(req.body.asset||'').toUpperCase();
 const amount=Number(req.body.amount);
 const note=String(req.body.note||'').trim().slice(0,300);
 const pin=String(req.body.pin||'');
 if(!['BTC','ETH','USDT'].includes(asset))return res.status(400).json({error:'Choose BTC, ETH or USDT.'});
 if(!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:'Enter a valid transfer amount.'});
 const recipient=findTransferRecipient(identifier);
 if(!recipient)return res.status(404).json({error:'Recipient account was not found.'});
 if(Number(recipient.id)===Number(req.user.id))return res.status(400).json({error:'You cannot transfer funds to your own account.'});
 if(!recipient.email_verified)return res.status(409).json({error:'The recipient account has not completed email verification.'});
 const pinCheck=sensitivePinCheck(req.user.id,pin);if(!pinCheck.ok)return res.status(pinCheck.status).json(pinCheck);

 const reference=internalTransferRef(),fee=0;
 try{
   db.transaction(()=>{
     seedSectionBalances(req.user.id);
     seedSectionBalances(recipient.id);
     const sender=db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='wallet' AND asset=?").get(req.user.id,asset);
     const receiver=db.prepare("SELECT amount FROM section_balances WHERE user_id=? AND section='wallet' AND asset=?").get(recipient.id,asset);
     const senderBefore=Number(sender?.amount||0),receiverBefore=Number(receiver?.amount||0);
     const reserved=withdrawalReserved(req.user.id,asset),available=Math.max(0,senderBefore-reserved);
     if(amount>available+1e-12)throw new Error(`Insufficient available ${asset} balance. Available: ${available}.`);
     const senderAfter=Math.max(0,senderBefore-amount-fee),receiverAfter=receiverBefore+amount;
     db.prepare("UPDATE section_balances SET amount=? WHERE user_id=? AND section='wallet' AND asset=?").run(senderAfter,req.user.id,asset);
     db.prepare("UPDATE section_balances SET amount=? WHERE user_id=? AND section='wallet' AND asset=?").run(receiverAfter,recipient.id,asset);
     db.prepare("UPDATE balances SET amount=? WHERE user_id=? AND asset=?").run(senderAfter,req.user.id,asset);
     db.prepare("UPDATE balances SET amount=? WHERE user_id=? AND asset=?").run(receiverAfter,recipient.id,asset);
     db.prepare(`INSERT INTO internal_transfers(reference,sender_user_id,recipient_user_id,asset,amount,fee_amount,note)
       VALUES(?,?,?,?,?,?,?)`).run(reference,req.user.id,recipient.id,asset,amount,fee,note||null);
     db.prepare("INSERT INTO demo_transactions(reference,user_id,actor_id,type,asset,amount,direction,status,note) VALUES(?,?,?,?,?,?,'debit','completed',?)")
       .run(reference+'-S',req.user.id,req.user.id,'internal_transfer_sent',asset,amount,`Sent to ${recipient.username||recipient.name}. ${note||''}`.trim());
     db.prepare("INSERT INTO demo_transactions(reference,user_id,actor_id,type,asset,amount,direction,status,note) VALUES(?,?,?,?,?,?,'credit','completed',?)")
       .run(reference+'-R',recipient.id,req.user.id,'internal_transfer_received',asset,amount,`Received from ${req.user.username||req.user.name}. ${note||''}`.trim());
   })();
 }catch(e){return res.status(400).json({error:e.message||'Could not complete the internal transfer.'})}

 logActivity(req.user.id,req.user.id,'internal_transfer_sent',`${amount} ${asset} sent to ${recipient.username||recipient.name} • ${reference}`);
 logActivity(recipient.id,req.user.id,'internal_transfer_received',`${amount} ${asset} received from ${req.user.username||req.user.name} • ${reference}`);
 notifyAndEmail(req.user.id,'internal_transfer','Internal transfer sent',`${amount} ${asset} was sent to ${recipient.username||recipient.name}. Reference: ${reference}`,'/transfer.html');
 notifyAndEmail(recipient.id,'internal_transfer','Internal transfer received',`${amount} ${asset} was received from ${req.user.username||req.user.name}. Reference: ${reference}`,'/transfer.html');

 res.json({
   ok:true,reference,status:'completed',asset,amount,fee,
   recipient:publicTransferRecipient(recipient)
 });
});


const port=Number(process.env.PORT||3000);
const server=app.listen(port,'0.0.0.0',()=>{
 console.log(`OptiTrade listening on 0.0.0.0:${port}`);
 logStartupReadiness();
});
process.on('SIGTERM',()=>{console.log('[SHUTDOWN] SIGTERM received');server.close(()=>{try{db.close()}catch{}process.exit(0)})});
process.on('SIGINT',()=>{console.log('[SHUTDOWN] SIGINT received');server.close(()=>{try{db.close()}catch{}process.exit(0)})});
