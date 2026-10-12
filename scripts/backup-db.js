require('dotenv').config();
const path=require('path'),fs=require('fs'),Database=require('better-sqlite3');

const dbPath=String(process.env.DB_PATH||path.join(__dirname,'../database/optitrade.db')).trim();
const backupDir=String(process.env.BACKUP_DIR||path.join(path.dirname(dbPath),'backups')).trim();
if(!fs.existsSync(dbPath)){
 console.error(`[BACKUP] Database not found: ${dbPath}`);
 process.exit(1);
}
fs.mkdirSync(backupDir,{recursive:true});
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const out=path.join(backupDir,`optitrade-${stamp}.db`);
const db=new Database(dbPath,{readonly:true,fileMustExist:true});
(async()=>{
 try{
  const integrity=String(db.pragma('quick_check',{simple:true}));
  if(integrity!=='ok')throw new Error(`SQLite quick_check returned: ${integrity}`);
  await db.backup(out);
  const size=fs.statSync(out).size;
  console.log(`[BACKUP] Created: ${out}`);
  console.log(`[BACKUP] Size: ${(size/1024/1024).toFixed(2)} MB`);
 }catch(e){
  console.error('[BACKUP] Failed:',e.message);
  process.exitCode=1;
 }finally{
  try{db.close()}catch{}
 }
})();