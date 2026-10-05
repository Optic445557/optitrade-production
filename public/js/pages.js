
const $=s=>document.querySelector(s), $$=s=>document.querySelectorAll(s);
const money=n=>'$'+Number(n||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
let OT={user:null,balances:{},sectionBalances:[],portfolioBalances:{USD:0,USDT:0,BTC:0,ETH:0},prices:{BTC:0,ETH:0,USDT:1},fx:{}};
function toast(t){let e=$('#toast');if(!e){e=document.createElement('div');e.id='toast';e.className='toast';document.body.appendChild(e)}e.textContent=t;e.classList.add('show');setTimeout(()=>e.classList.remove('show'),2600)}
async function auth(){const r=await fetch('/api/me',{cache:'no-store'});if(!r.ok){location='/login.html';return false}const d=await r.json();OT.user=d.user;OT.balances=Object.fromEntries((d.balances||[]).map(x=>[x.asset,Number(x.amount)]));OT.sectionBalances=d.sectionBalances||[];OT.portfolioBalances={USD:0,USDT:0,BTC:0,ETH:0};for(const x of OT.sectionBalances)if(x.section==='portfolio')OT.portfolioBalances[x.asset]=Number(x.amount||0);$$('[data-user-name]').forEach(e=>e.textContent=d.user.name||d.user.username||'Trader');$$('[data-user-email]').forEach(e=>e.textContent=d.user.email||'');return true}
async function markets(){try{const d=await fetch('/api/public/market-ticker',{cache:'no-store'}).then(r=>r.json());const m=d.markets||{};OT.prices.BTC=Number(m.BTCUSD)||0;OT.prices.ETH=Number(m.ETHUSD)||0;OT.prices.USDT=1;OT.fx={EUR:Number(m.EURUSD)||0,GBP:Number(m.GBPUSD)||0,JPY:Number(m.USDJPY)||0}}catch(e){}}
function totalAccountAsset(asset){const rows=OT.sectionBalances||[];if(rows.length)return rows.filter(x=>x.asset===asset).reduce((s,x)=>s+Number(x.amount||0),0);return Number(OT.balances?.[asset]||0)}
function portfolioValue(){return totalAccountAsset('USD')+totalAccountAsset('USDT')*OT.prices.USDT+totalAccountAsset('BTC')*OT.prices.BTC+totalAccountAsset('ETH')*OT.prices.ETH}
function portfolioBtcValue(){const usd=portfolioValue(),btc=Number(OT.prices.BTC||0);return btc>0?usd/btc:totalAccountAsset('BTC')}
async function logout(){await fetch('/api/auth/logout',{method:'POST'});location='/'}
document.addEventListener('click',e=>{if(e.target.closest('[data-logout]'))logout()});


/* Unified OptiTrade dialog system — replaces browser confirm/prompt/alert */
(()=>{
 if(window.appConfirm&&window.appPrompt&&window.appAlert)return;
 function esc(s){return String(s??'').replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]))}
 function showDialog({title='Please confirm',message='',confirmText='Confirm',cancelText='Cancel',danger=false,prompt=false,placeholder='',value='',required=false,alertOnly=false}={}){
  return new Promise(resolve=>{
   const overlay=document.createElement('div');
   overlay.className='ot-dialog-overlay';
   overlay.innerHTML=`<div class="ot-dialog-card" role="dialog" aria-modal="true">
      <button class="ot-dialog-x" type="button" aria-label="Close">×</button>
      <div class="ot-dialog-icon ${danger?'danger':''}">${danger?'!':'✓'}</div>
      <div class="ot-dialog-copy"><span>${danger?'PLEASE CHECK':'OPTITRADE'}</span><h3>${esc(title)}</h3><p>${esc(message)}</p></div>
      ${prompt?`<div class="ot-dialog-input-wrap"><textarea class="ot-dialog-input" rows="3" placeholder="${esc(placeholder)}">${esc(value)}</textarea></div>`:''}
      <div class="ot-dialog-actions">
        ${alertOnly?'':`<button class="ot-dialog-cancel" type="button">${esc(cancelText)}</button>`}
        <button class="ot-dialog-confirm ${danger?'danger':''}" type="button">${esc(confirmText)}</button>
      </div>
    </div>`;
   document.body.appendChild(overlay);
   const input=overlay.querySelector('.ot-dialog-input');
   const done=v=>{overlay.remove();resolve(v)};
   overlay.querySelector('.ot-dialog-x').onclick=()=>done(prompt?null:false);
   overlay.onclick=e=>{if(e.target===overlay)done(prompt?null:false)};
   overlay.querySelector('.ot-dialog-cancel')?.addEventListener('click',()=>done(prompt?null:false));
   overlay.querySelector('.ot-dialog-confirm').onclick=()=>{
    if(prompt){
      const v=String(input?.value||'').trim();
      if(required&&!v){input?.focus();input?.classList.add('invalid');return}
      done(v);
    }else done(true);
   };
   const onKey=e=>{if(e.key==='Escape'&&document.body.contains(overlay)){document.removeEventListener('keydown',onKey);done(prompt?null:false)}};
   document.addEventListener('keydown',onKey);
   setTimeout(()=>prompt?input?.focus():overlay.querySelector('.ot-dialog-confirm')?.focus(),20);
  });
 }
 window.appConfirm=(message,opts={})=>showDialog({title:opts.title||'Confirm action',message,confirmText:opts.confirmText||'Confirm',cancelText:opts.cancelText||'Cancel',danger:!!opts.danger});
 window.appPrompt=(message,opts={})=>showDialog({title:opts.title||'Enter details',message,confirmText:opts.confirmText||'Continue',cancelText:opts.cancelText||'Cancel',danger:!!opts.danger,prompt:true,placeholder:opts.placeholder||'',value:opts.value||'',required:opts.required!==false});
 window.appAlert=(message,opts={})=>showDialog({title:opts.title||'OptiTrade',message,confirmText:opts.confirmText||'OK',danger:!!opts.danger,alertOnly:true});
})();
