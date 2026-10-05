const fs=require('fs');
const path=require('path');

const root=path.resolve(__dirname,'..');
const staleFiles=[
  'admin/applicants.html',
  'admin/employees.html',
  'admin/messages.html',
  'admin/users.html',
  'admin/user.html',
  'server/mt5_bridge.py',
  'server/requirements-mt5.txt',
  'setup-mt5.bat',
  'setup-wallet.bat',
  'scripts/build-wallet.js',
  'smoke-result.txt'
];

const obsoleteRootPatterns=[
  /^PRODUCTION-STAGE-.*\.txt$/i,
  /-README\.txt$/i,
  /^INSTALL(?:-.*)?\.txt$/i,
  /^STAGE-23\..*\.txt$/i,
  /^CURRENT-BUILD-AUDIT\.txt$/i,
  /^EMAIL-CONFIG\.example\.txt$/i,
  /^PRODUCTION-CONFIG\.example\.txt$/i,
  /^PIN-HUMAN-SECURITY-UPDATE\.txt$/i,
  /^RECENT-TRANSACTIONS-LOGOUT-BALANCE-FIX\.txt$/i,
  /^HOMEPAGE-LIVE-TICKER-UPDATE\.txt$/i,
  /^OPTITRADE-FINALIZATION-README\.txt$/i,
  /^FRESH-TEST-README\.txt$/i,
  /^MOVE-TO-NEW-COMPUTER-README\.txt$/i
];

let removed=0;
for(const rel of staleFiles){
 const file=path.join(root,rel);
 if(fs.existsSync(file)){
  fs.rmSync(file,{force:true});
  console.log(`[CLEANUP] Removed stale file: ${rel}`);
  removed++;
 }
}
for(const name of fs.readdirSync(root)){
 if(name==='FINAL-RELEASE-NOTES.txt')continue;
 if(obsoleteRootPatterns.some(rx=>rx.test(name))){
  fs.rmSync(path.join(root,name),{force:true});
  console.log(`[CLEANUP] Removed obsolete release note: ${name}`);
  removed++;
 }
}
if(!removed)console.log('[CLEANUP] No stale legacy files found.');
console.log('[CLEANUP] Complete.');
