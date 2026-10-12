const fs=require('fs'),path=require('path'),{execFileSync}=require('child_process');
const root=path.resolve(__dirname,'..');
const ignored=new Set(['node_modules','.git','backups','database']);
const textExt=new Set(['.js','.html','.css','.json','.yaml','.yml','.example']);
const findings=[];
function add(level,file,message){findings.push({level,file,message})}
function walk(dir){
 for(const name of fs.readdirSync(dir)){
  if(ignored.has(name))continue;
  const p=path.join(dir,name),st=fs.statSync(p);
  if(st.isDirectory())walk(p);
  else if(textExt.has(path.extname(p).toLowerCase())||name==='.env.example'){
   const txt=fs.readFileSync(p,'utf8'),rel=path.relative(root,p).replace(/\\/g,'/');
   if(rel.startsWith('public/')||rel.startsWith('admin/')){
    if(/class=["'][^"']*\bdemo\b/i.test(txt))add('error',rel,'Legacy demo visual class remains.');
    if(/>[^<>]*\bComing soon\b[^<>]*</i.test(txt))add('error',rel,'Unfinished Coming soon UI remains.');
    if(rel==='public/trade.html'&&/class=["'][^"']*notice\s+red/i.test(txt))add('error',rel,'Non-critical red trade notice remains.');
   }
   if(rel!=='scripts/production-audit.js'){
    if(/\b(?:jordan@example\.com|sarah@example\.com|michael@example\.com)\b/i.test(txt))add('error',rel,'Legacy sample customer email remains.');
    if(/\b(?:Jordan Taylor|Sarah Johnson|Michael James)\b/.test(txt))add('error',rel,'Legacy sample customer identity remains.');
    if(/OT-DEMO-/i.test(txt))add('error',rel,'Legacy demo transaction reference remains.');
    if(/simulated wallet balance/i.test(txt))add('error',rel,'Stale simulated-balance wording remains.');
   }
   if(rel!=='scripts/e2e-smoke-test.js'&&/https?:\/\/(?:localhost|127\.0\.0\.1)/i.test(txt))add('warning',rel,'Runtime source contains localhost URL.');
   if(rel==='public/dashboard.html'&&/class=["']badge["'][^>]*>\s*\d+/i.test(txt))add('error',rel,'Hard-coded notification badge remains.');
   if(/\bMT5\b/i.test(txt)&&!['scripts/cleanup-legacy.js','scripts/production-audit.js'].includes(rel))add('warning',rel,'Legacy MT5 wording remains in runtime source.');
  }
 }
}
walk(root);
for(const rel of ['admin/users.html','admin/user.html','admin/applicants.html','admin/employees.html','admin/messages.html']){
 if(fs.existsSync(path.join(root,rel)))add('error',rel,'Obsolete admin page remains. Run npm run cleanup-legacy.');
}
try{execFileSync(process.execPath,['--check',path.join(root,'server','app.js')],{stdio:'pipe'})}
catch(e){add('error','server/app.js','Server JavaScript syntax check failed.')}
const errors=findings.filter(x=>x.level==='error'),warnings=findings.filter(x=>x.level==='warning');
console.log(`[PRODUCTION AUDIT] ${errors.length} error(s), ${warnings.length} warning(s).`);
for(const f of findings)console.log(`[${f.level.toUpperCase()}] ${f.file}: ${f.message}`);
if(errors.length)process.exit(1);
