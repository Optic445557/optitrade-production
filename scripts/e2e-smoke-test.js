const fs=require('fs');
const os=require('os');
const path=require('path');
const crypto=require('crypto');
const {spawn}=require('child_process');

const root=path.resolve(__dirname,'..');
const port=Number(process.env.SMOKE_PORT||39771);
const base=`http://127.0.0.1:${port}`;
const tempDir=fs.mkdtempSync(path.join(os.tmpdir(),'optitrade-smoke-'));
const dbPath=path.join(tempDir,'smoke.db');
const started=Date.now();
const adminEmail='smoke-admin@local.test';
const adminPassword='SmokeAdminPass1!';
const stamp=Date.now().toString(36);
const userA={name:'Smoke Customer A',email:`smoke-a-${stamp}@local.test`,username:`smokea${stamp}`.slice(0,20),password:'SmokePass1!',newPassword:'SmokePass2!',phone:'+15550000001',country:'United States',currency:'USD',dob:'1992-01-01',pin:'1234'};
const userB={name:'Smoke Customer B',email:`smoke-b-${stamp}@local.test`,username:`smokeb${stamp}`.slice(0,20),password:'SmokePass1!',phone:'+15550000002',country:'United Kingdom',currency:'USD',dob:'1993-02-02',pin:'5678'};
const results=[];
let child=null,serverLogs='',finished=false;

function safeLogs(text){
 return String(text||'')
  .replace(/\b\d{6}\b/g,'******')
  .replace(/(OTP\]\s+[^:\n]+:\s*)\d+/gi,'$1******');
}
function pass(name,detail=''){results.push({name,ok:true,detail});console.log(`✓ ${name}${detail?' — '+detail:''}`)}
function fail(name,error){results.push({name,ok:false,detail:error?.message||String(error)});console.error(`✗ ${name} — ${error?.message||error}`)}
function assert(cond,msg){if(!cond)throw new Error(msg)}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function solveHuman(question){
 let m=String(question).match(/What is\s+(\d+)\s*\+\s*(\d+)/i);if(m)return String(Number(m[1])+Number(m[2]));
 m=String(question).match(/What is\s+(\d+)\s*-\s*(\d+)/i);if(m)return String(Number(m[1])-Number(m[2]));
 m=String(question).match(/What is\s+(\d+)\s*[×x*]\s*(\d+)/i);if(m)return String(Number(m[1])*Number(m[2]));
 throw new Error(`Could not solve human challenge: ${question}`);
}
class Jar{
 constructor(){this.values={}}
 absorb(headers){
  let rows=[];
  if(typeof headers.getSetCookie==='function')rows=headers.getSetCookie();
  else{const raw=headers.get('set-cookie');if(raw)rows=[raw]}
  for(const row of rows){
   const first=String(row).split(';')[0],i=first.indexOf('=');
   if(i>0){const k=first.slice(0,i).trim(),v=first.slice(i+1).trim();if(v)this.values[k]=v;else delete this.values[k]}
  }
 }
 header(){return Object.entries(this.values).map(([k,v])=>`${k}=${v}`).join('; ')}
}
async function http(route,{method='GET',body,jar,ok=[200],headers={}}={}){
 const h={accept:'application/json',...headers};
 if(body!==undefined){h['content-type']='application/json'}
 if(jar&&jar.header())h.cookie=jar.header();
 const r=await fetch(base+route,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body)});
 if(jar)jar.absorb(r.headers);
 const type=r.headers.get('content-type')||'';
 const data=type.includes('application/json')?await r.json():await r.text();
 if(!ok.includes(r.status)){
  const message=typeof data==='object'?(data.error||JSON.stringify(data)):String(data).slice(0,300);
  const e=new Error(`${method} ${route} -> ${r.status}: ${message}`);e.status=r.status;e.data=data;throw e;
 }
 return {status:r.status,data,headers:r.headers};
}
async function waitHealth(){
 const until=Date.now()+20000;
 while(Date.now()<until){
  try{const r=await fetch(base+'/api/health');if(r.ok)return await r.json()}catch{}
  await sleep(180);
 }
 throw new Error('Smoke server did not become healthy within 20 seconds.');
}
async function waitOtp(kind,email,afterIndex=0){
 const labels={
  registration:'DEV REGISTRATION OTP',
  login:'DEV LOGIN OTP',
  reset:'DEV PASSWORD RESET OTP'
 };
 const label=labels[kind];if(!label)throw new Error('Unknown OTP log kind.');
 const escaped=email.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const rx=new RegExp(`\\[${label}\\]\\s+${escaped}:\\s+(\\d{6})`,'i');
 const until=Date.now()+8000;
 while(Date.now()<until){
  const text=serverLogs.slice(afterIndex),m=text.match(rx);
  if(m)return m[1];
  await sleep(60);
 }
 throw new Error(`${kind} OTP was not emitted for ${email}.`);
}
async function register(user){
 const jar=new Jar();
 const hc=(await http('/api/public/human-challenge')).data;
 const answer=solveHuman(hc.question);
 const logAt=serverLogs.length;
 const reg=(await http('/api/auth/register',{method:'POST',body:{
  name:user.name,email:user.email,password:user.password,confirmPassword:user.password,username:user.username,
  phone:user.phone,country:user.country,currency:user.currency,dob:user.dob,pin:user.pin,confirmPin:user.pin,
  termsAccepted:true,humanChallenge:hc.challenge,humanAnswer:answer
 }})).data;
 assert(reg.ok===true,'Registration did not return ok=true.');
 const code=await waitOtp('registration',user.email,logAt);
 const verify=(await http('/api/auth/verify',{method:'POST',body:{email:user.email,code},jar})).data;
 assert(verify.ok===true,'Email verification failed.');
 const me=(await http('/api/me',{jar})).data;
 assert(me.user?.email===user.email,'Verified session belongs to the wrong customer.');
 return {jar,id:me.user.id,me};
}
async function login(identifier,password,email){
 const jar=new Jar(),logAt=serverLogs.length;
 const first=(await http('/api/auth/login',{method:'POST',body:{identifier,password}})).data;
 assert(first.requiresOtp===true&&first.challenge,'Login did not request OTP.');
 const code=await waitOtp('login',email,logAt);
 const done=(await http('/api/auth/login/verify',{method:'POST',body:{challenge:first.challenge,code},jar})).data;
 assert(done.ok===true,'Login OTP verification failed.');
 return {jar,role:done.role};
}
async function passwordReset(user){
 const jar=new Jar(),logAt=serverLogs.length;
 const req=(await http('/api/auth/forgot/request',{method:'POST',body:{email:user.email}})).data;
 assert(req.ok===true,'Forgot-password request failed.');
 const code=await waitOtp('reset',user.email,logAt);
 const verified=(await http('/api/auth/forgot/verify',{method:'POST',body:{email:user.email,code},jar})).data;
 assert(verified.ok===true,'Password-reset OTP verification failed.');
 const reset=(await http('/api/auth/forgot/reset',{method:'POST',body:{password:user.newPassword,confirmPassword:user.newPassword},jar})).data;
 assert(reset.ok===true,'Password reset did not finish.');
}
async function run(){
 const buildVersion=require('../package.json').version||'current';
 console.log(`OptiTrade ${buildVersion} isolated end-to-end smoke test`);
 console.log(`Temporary database: ${dbPath}`);
 console.log('No production database, email provider, KYC provider, or live exchange credentials are used.\n');

 const env={
  ...process.env,
  NODE_ENV:'development',
  PORT:String(port),
  DB_PATH:dbPath,
  SESSION_SECRET:crypto.randomBytes(48).toString('hex'),
  OTP_PEPPER:crypto.randomBytes(48).toString('hex'),
  ADMIN_EMAIL:adminEmail,
  ADMIN_PASSWORD:adminPassword,
  EMAIL_PROVIDER:'auto',
  EMAIL_SMTP_FALLBACK:'false',
  RESEND_API_KEY:'',
  RESEND_FROM:'',
  SMTP_HOST:'',
  SMTP_USER:'',
  SMTP_PASS:'',
  SUPPORT_EMAIL:'',
  TRUST_PROXY:'false',
  IP_GEOLOCATION_ENABLED:'false',
  SUMSUB_APP_TOKEN:'',
  SUMSUB_SECRET_KEY:'',
  SUMSUB_WEBHOOK_SECRET:'',
  KRAKEN_API_KEY:'',
  KRAKEN_API_SECRET:'',
  APP_BASE_URL:base
 };
 child=spawn(process.execPath,[path.join(root,'server','app.js')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
 const capture=b=>{serverLogs+=String(b);if(serverLogs.length>800000)serverLogs=serverLogs.slice(-500000)};
 child.stdout.on('data',capture);child.stderr.on('data',capture);
 child.on('exit',code=>{if(!finished&&code!==0)console.error(`Smoke server exited unexpectedly with code ${code}.`)});

 const health=await waitHealth();
 assert(health.ok&&health.database==='ok','Health endpoint is not healthy.');
 pass('Server boot + /api/health',`v${health.version||'unknown'}`);

 // 1. Registration and email verification.
 const a=await register(userA);pass('Customer A registration + email verification',`user #${a.id}`);
 const b=await register(userB);pass('Customer B registration + email verification',`user #${b.id}`);

 // 2. Customer baseline APIs.
 const kyc=(await http('/api/kyc/status',{jar:a.jar})).data;
 assert(['not_started','in_progress','pending','verified','rejected','on_hold'].includes(kyc.status),'Unexpected KYC status.');
 const compliance=(await http('/api/compliance/status',{jar:a.jar})).data;
 assert(compliance.features?.withdrawal?.ok===true,'Withdrawal should be available with KYC gates off by default.');
 const plans=(await http('/api/investment-plans',{jar:a.jar})).data;
 assert(Array.isArray(plans.plans)&&plans.plans.length>=1,'Investment plans are missing.');
 assert(plans.plans.some(p=>(p.terms||[]).some(t=>Number(t.duration_days)===14)),'14-day investment term is missing.');
 await http('/api/trades',{jar:a.jar});
 await http('/api/managed-trades',{jar:a.jar});
 await http('/api/investments/summary',{jar:a.jar});
 pass('Customer account/KYC/trading/investment read APIs');

 // 3. Password recovery invalidates old session, then new password login works.
 await passwordReset(userA);
 const oldSession=await http('/api/me',{jar:a.jar,ok:[401]});
 assert(oldSession.status===401,'Password reset should invalidate existing sessions.');
 pass('Password reset + session invalidation');
 const relogin=await login(userA.email,userA.newPassword,userA.email);
 a.jar=relogin.jar;
 const meAfter=(await http('/api/me',{jar:a.jar})).data;
 assert(meAfter.user?.id===a.id,'Re-login after password reset failed.');
 pass('Password + email login OTP with new password');

 // 4. Super Admin login and control-plane APIs.
 const admin=await login(adminEmail,adminPassword,adminEmail);
 assert(admin.role==='super_admin','Bootstrap admin did not log in as Super Admin.');
 const adminUsersResponse=(await http('/api/admin/users',{jar:admin.jar})).data;
 const adminUsers=Array.isArray(adminUsersResponse)?adminUsersResponse:(adminUsersResponse?.users||[]);
 assert(Array.isArray(adminUsers)&&adminUsers.some(x=>Number(x.id)===Number(a.id))&&adminUsers.some(x=>Number(x.id)===Number(b.id)),'Admin customer list failed.');
 await http('/api/admin/kyc',{jar:admin.jar});
 await http('/api/super/exchange',{jar:admin.jar});
 await http('/api/super/email-config',{jar:admin.jar});
 const launch=(await http('/api/super/launch-audit',{jar:admin.jar})).data;
 assert(Array.isArray(launch.checks)&&launch.checks.length>5,'Final Launch Check did not return checks.');
 pass('Super Admin login + control-plane APIs');

 // 5. Balance credit through real admin endpoint.
 for(const [asset,amount] of [['USDT',100],['USD',1500]]){
  const d=(await http(`/api/admin/users-v2/${a.id}/adjust-balance`,{method:'POST',jar:admin.jar,body:{section:'wallet',asset,direction:'credit',amount,reason:'Smoke setup credit',internalNote:'Temporary smoke-test funding'}})).data;
  assert(d.ok===true,`Could not credit ${asset}.`);
 }
 pass('Admin section-aware wallet balance adjustment');

 const adj=(await http(`/api/admin/users-v2/${a.id}/adjust-balance`,{method:'POST',jar:admin.jar,body:{section:'trading',asset:'USDT',direction:'credit',amount:10,reason:'Smoke reconciliation test',internalNote:'Temporary reversible adjustment'}})).data;
 assert(adj.ok===true&&adj.reference,'Could not create reversible balance adjustment.');
 const rev=(await http(`/api/admin/users-v2/${a.id}/reverse-adjustment`,{method:'POST',jar:admin.jar,body:{reference:adj.reference,reason:'Smoke test reversal'}})).data;
 assert(rev.ok===true&&rev.originalReference===adj.reference,'Balance adjustment reversal failed.');
 pass('Balance adjustment reversal');

 // 6. Internal transfer A -> B.
 const recipient=(await http(`/api/internal-transfer/recipient?identifier=${encodeURIComponent(userB.username)}`,{jar:a.jar})).data;
 assert(recipient.recipient?.id===b.id,'Internal-transfer recipient verification failed.');
 const transfer=(await http('/api/internal-transfer',{method:'POST',jar:a.jar,body:{recipient:userB.username,asset:'USDT',amount:5,note:'Final smoke test',pin:userA.pin}})).data;
 assert(transfer.ok===true&&transfer.status==='completed','Internal transfer failed.');
 const bh=(await http('/api/internal-transfer/history',{jar:b.jar})).data;
 assert((bh.transfers||[]).some(x=>x.reference===transfer.reference&&x.direction==='received'),'Receiver history does not contain transfer.');
 pass('Internal Transfer end-to-end',transfer.reference);
 const availability=(await http('/api/withdrawal/status',{jar:a.jar})).data;
 const av=Object.fromEntries((availability.assets||[]).map(x=>[x.asset,x]));
 assert(Number(av.USD?.available)===1500,'Available USD source balance is incorrect after admin credit.');
 assert(Math.abs(Number(av.USDT?.available)-95)<1e-9,'Available USDT source balance is incorrect after internal transfer.');
 pass('Dashboard available-balance source API');

 // 6b. Trade with OptiTrade Reserve lifecycle:
 // wallet funds a first trade, settlement remains in reserve, next trade reuses reserve,
 // then customer moves only free reserve back to Available Balance using PIN.
 const managed1=(await http('/api/managed-trades',{method:'POST',jar:a.jar,body:{amount:500,marketPreference:'crypto',preferredSymbol:'BTC/USD',note:'Reserve lifecycle smoke test'}})).data;
 assert(managed1.ok===true&&managed1.funding?.wallet===500&&managed1.funding?.reserve===0,'First managed trade should be funded from USD wallet.');
 let queue=(await http('/api/admin/trade-requests',{jar:admin.jar})).data;
 let managedRow=(queue.requests||[]).find(x=>x.request_kind==='managed'&&x.reference===managed1.reference);
 assert(managedRow,'Managed trade request is missing from Admin queue.');
 await http(`/api/admin/trade-requests/managed/${managedRow.id}/start`,{method:'POST',jar:admin.jar,body:{execution:'internal',symbol:'BTC/USD',note:'Smoke managed start'}});
 const settled1=(await http(`/api/admin/trade-requests/managed/${managedRow.id}/settle`,{method:'POST',jar:admin.jar,body:{pnlAmount:50,note:'Smoke managed settlement'}})).data;
 assert(settled1.status==='settled'&&Math.abs(Number(settled1.reserve?.total)-550)<1e-9&&Math.abs(Number(settled1.reserve?.available)-550)<1e-9,'Managed settlement did not remain in Trade Reserve.');
 let managedStatus=(await http('/api/managed-trades',{jar:a.jar})).data;
 assert(Math.abs(Number(managedStatus.reserve?.realizedPnl)-50)<1e-9,'Managed realized P/L summary is incorrect.');
 const managed2=(await http('/api/managed-trades',{method:'POST',jar:a.jar,body:{amount:500,marketPreference:'mixed',preferredSymbol:'',note:'Reuse free reserve'}})).data;
 assert(managed2.ok===true&&Math.abs(Number(managed2.funding?.reserve)-500)<1e-9&&Math.abs(Number(managed2.funding?.wallet))<1e-9,'Second managed trade did not reuse free Trade Reserve first.');
 queue=(await http('/api/admin/trade-requests',{jar:admin.jar})).data;
 managedRow=(queue.requests||[]).find(x=>x.request_kind==='managed'&&x.reference===managed2.reference);
 await http(`/api/admin/trade-requests/managed/${managedRow.id}/reject`,{method:'POST',jar:admin.jar,body:{reason:'Smoke reserve release'}});
 managedStatus=(await http('/api/managed-trades',{jar:a.jar})).data;
 assert(Math.abs(Number(managedStatus.reserve?.available)-550)<1e-9,'Declined managed request did not release funds back to free Trade Reserve.');
 const moved=(await http('/api/managed-trades/reserve-to-wallet',{method:'POST',jar:a.jar,body:{amount:200,pin:userA.pin}})).data;
 assert(moved.ok===true&&Math.abs(Number(moved.reserve?.available)-350)<1e-9&&Math.abs(Number(moved.walletUsd)-1200)<1e-9,'Trade Reserve move to Available Balance failed.');
 pass('Trade with OptiTrade persistent reserve + P/L + reuse + internal release');


 // 7. Withdrawal destination safety + admin rejection.
 const selfDestination=await http('/api/withdrawal/requests',{method:'POST',jar:a.jar,body:{asset:'USDT',amount:1,destination:userA.email,pin:userA.pin},ok:[400]});
 assert(/email|username|receiver/i.test(selfDestination.data.error||''),'Account-email withdrawal destination was not rejected clearly.');
 const wd=(await http('/api/withdrawal/requests',{method:'POST',jar:a.jar,body:{asset:'USDT',amount:1,destination:'0x1111111111111111111111111111111111111111',pin:userA.pin}})).data;
 assert(wd.status==='pending','Valid withdrawal request did not become Pending.');
 const attentionAfterWithdrawal=(await http('/api/admin/attention',{jar:admin.jar})).data;
 assert(attentionAfterWithdrawal.counts?.withdrawals>=1&&attentionAfterWithdrawal.items?.some(x=>x.kind==='withdrawal'&&x.reference===wd.reference),'Attention Center did not surface the withdrawal.');
 const adminWd=(await http('/api/admin/withdrawals',{jar:admin.jar})).data;
 const wdRow=(adminWd.requests||[]).find(x=>x.reference===wd.reference);assert(wdRow,'Admin cannot see customer withdrawal.');
 const wdRejected=(await http(`/api/admin/withdrawals/${wdRow.id}/review`,{method:'POST',jar:admin.jar,body:{action:'reject',reason:'Final isolated smoke-test cleanup'}})).data;
 assert(wdRejected.status==='rejected','Admin withdrawal rejection failed.');
 pass('Withdrawal receiver protection + admin review',wd.reference);

 // 8. Deposit address -> customer request -> admin review.
 const wallet=(await http('/api/admin/deposit-wallets',{method:'POST',jar:admin.jar,body:{label:'Final Smoke USDT',asset:'USDT',network:'TRC20',address:'TSmokeTestWallet111111111111111111111'}})).data;
 assert(wallet.ok===true&&wallet.id,'Could not configure temporary deposit wallet.');
 const opts=(await http('/api/deposit/options',{jar:a.jar})).data;
 const option=(opts.wallets||[]).find(x=>Number(x.id)===Number(wallet.id));assert(option,'Customer did not inherit Super Admin deposit wallet.');
 const dep=(await http('/api/deposits',{method:'POST',jar:a.jar,body:{asset:'USDT',network:'TRC20',requestedUsd:25,walletId:wallet.id,txid:'',note:'Final isolated smoke test'}})).data;
 assert(dep.status==='pending'&&dep.id&&dep.receiptHref&&Math.abs(Number(dep.requestedUsd)-25)<1e-9,'USD-first deposit request did not create a pending receipt.');
 assert(Math.abs(Number(dep.expectedCryptoAmount)-25)<1e-9,'USDT crypto equivalent should match the requested USD amount in the smoke test.');
 const receipt=(await http(`/api/deposits/${dep.id}/receipt`,{jar:a.jar})).data;
 assert(receipt.receipt?.receiptNumber===dep.reference&&receipt.receipt?.status==='pending'&&Math.abs(Number(receipt.receipt?.requested_usd)-25)<1e-9,'Instant USD-first deposit receipt is unavailable.');
 const attentionAfterDeposit=(await http('/api/admin/attention',{jar:admin.jar})).data;
 assert(attentionAfterDeposit.counts?.deposits>=1&&attentionAfterDeposit.items?.some(x=>x.kind==='deposit'&&x.reference===dep.reference),'Attention Center did not surface the deposit.');
 const adminDeps=(await http('/api/admin/deposits',{jar:admin.jar})).data;
 const depRow=(adminDeps.deposits||[]).find(x=>x.reference===dep.reference);assert(depRow,'Admin cannot see customer deposit.');
 const depReview=(await http(`/api/admin/deposits/${depRow.id}/review`,{method:'POST',jar:admin.jar,body:{decision:'approve',creditUsd:25,creditNote:'Smoke approval'}})).data;
 assert(depReview.status==='approved'&&Math.abs(Number(depReview.creditUsd)-25)<1e-9,'Deposit approval/credit failed.');
 const corrected=(await http(`/api/admin/deposits/${depRow.id}/correct-credit`,{method:'POST',jar:admin.jar,body:{correctedUsd:20,reason:'Smoke test correction'}})).data;
 assert(corrected.ok===true&&Math.abs(Number(corrected.correctedUsd)-20)<1e-9,'Deposit credit correction failed.');
 const meFunding=(await http('/api/me',{jar:a.jar})).data;
 assert(Math.abs(Number(meFunding.fundingSummary?.approvedDepositsUsd)-20)<1e-9,'Approved deposit funding summary did not follow corrected credit.');
 pass('USD-first deposit + instant receipt + approval + correction',dep.reference);
 const bannerFeed=(await http('/api/banners',{jar:a.jar})).data;
 assert(Number(bannerFeed.notificationHours)===24,'Default notification banner lifetime should be 24 hours.');
 assert((bannerFeed.banners||[]).some(x=>x.source==='notification'&&/deposit/i.test(String(x.title||''))),'Recent deposit notification did not join the dashboard banner carousel.');
 pass('Recent notification joins rotating dashboard banner');

 // 9. Transaction/notification views after activity.
 const tx=(await http('/api/dashboard/recent-transactions?limit=20',{jar:a.jar})).data;
 assert(Array.isArray(tx.transactions||tx),'Recent-transactions endpoint returned an unexpected shape.');
 const notifications=(await http('/api/notifications',{jar:a.jar})).data;
 assert(Array.isArray(notifications.notifications),'Notifications endpoint failed.');
 pass('Transactions + notifications after account activity');

 // 10. Static customer/admin pages.
 for(const route of ['/','/register.html','/login.html','/dashboard.html','/investments.html','/withdraw.html','/admin/readiness.html','/admin/launch-check.html']){
  const r=await fetch(base+route);assert(r.status===200,`${route} returned HTTP ${r.status}`);
 }
 pass('Core static pages return HTTP 200');

 // 11. Logout.
 await http('/api/auth/logout',{method:'POST',jar:a.jar});
 const afterLogout=await http('/api/me',{jar:a.jar,ok:[401]});assert(afterLogout.status===401,'Logout did not invalidate customer session.');
 pass('Logout invalidates session');

 const failed=results.filter(x=>!x.ok);
 console.log('\n----------------------------------------');
 console.log(`Smoke test result: ${failed.length?'FAILED':'PASSED'}`);
 console.log(`Checks passed: ${results.filter(x=>x.ok).length}`);
 console.log(`Duration: ${((Date.now()-started)/1000).toFixed(1)}s`);
 console.log('Temporary test data will be removed.');
 if(failed.length)process.exitCode=1;
}
async function cleanup(){
 finished=true;
 if(child&&!child.killed){
  child.kill('SIGTERM');
  await Promise.race([new Promise(r=>child.once('exit',r)),sleep(3000)]);
  if(!child.killed)try{child.kill('SIGKILL')}catch{}
 }
 try{fs.rmSync(tempDir,{recursive:true,force:true})}catch{}
}
(async()=>{
 try{await run()}
 catch(e){
  fail('Smoke test stopped',e);
  console.error('\nSanitized server log tail:\n'+safeLogs(serverLogs.slice(-5000)));
  process.exitCode=1;
 }finally{await cleanup()}
})();