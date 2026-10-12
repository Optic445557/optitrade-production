const $=s=>document.querySelector(s), money=n=>'$'+Number(n||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
let userData, withdrawalData=null, prices={BTC:0,ETH:0,USDT:1};
const marketDefs=[['BTC','BTC/USDT','₿'],['ETH','ETH/USDT','◆'],['EUR','EUR/USD','€'],['GBP','GBP/USD','£'],['JPY','USD/JPY','¥'],['USDT','USDT/USD','₮']];
function initials(name='User'){return name.split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase()}
function renderMarkets(fx={}){const vals={BTC:prices.BTC,ETH:prices.ETH,USDT:1,EUR:fx.EUR||0,GBP:fx.GBP||0,JPY:fx.JPY||0};$('#marketGrid').innerHTML=marketDefs.map(d=>{let v=vals[d[0]],display=d[0]==='JPY'?Number(v).toFixed(3):(d[0]==='BTC'||d[0]==='ETH'?money(v):Number(v).toFixed(5));return `<article class="market-card"><div class="market-top"><div class="coin"><span class="coin-icon">${d[2]}</span>${d[1]}</div><span class="change">REFERENCE</span></div><div class="price">${v?display:'—'}</div><small class="market-card-source">Reference market value</small></article>`}).join('')}
function sectionAssetMap(section){
 const out={USD:0,USDT:0,BTC:0,ETH:0};
 for(const x of userData?.sectionBalances||[])if(x.section===section&&Object.prototype.hasOwnProperty.call(out,x.asset))out[x.asset]=Number(x.amount||0);
 if(section==='wallet'&&!(userData?.sectionBalances||[]).some(x=>x.section==='wallet')){
   for(const x of userData?.balances||[])if(Object.prototype.hasOwnProperty.call(out,x.asset))out[x.asset]=Number(x.amount||0);
 }
 return out;
}
function withdrawalReservedMap(){
 const out={USD:0,USDT:0,BTC:0,ETH:0};
 for(const x of withdrawalData?.assets||[])if(Object.prototype.hasOwnProperty.call(out,x.asset))out[x.asset]=Number(x.reserved||0);
 return out;
}
function usdValueOf(balances){
 const p={USD:1,USDT:Number(prices.USDT||1),BTC:Number(prices.BTC||0),ETH:Number(prices.ETH||0)};
 return Object.keys(p).reduce((sum,a)=>sum+Number(balances[a]||0)*p[a],0);
}
function renderAccount(){
 const wallet=sectionAssetMap('wallet'),investment=sectionAssetMap('investment'),trading=sectionAssetMap('trading'),portfolio=sectionAssetMap('portfolio');
 const reserved=withdrawalReservedMap();
 const available={USD:0,USDT:0,BTC:0,ETH:0};
 for(const asset of Object.keys(available))available[asset]=Math.max(0,Number(wallet[asset]||0)-Number(reserved[asset]||0));
 const totalByAsset={USD:0,USDT:0,BTC:0,ETH:0};
 for(const asset of Object.keys(totalByAsset))totalByAsset[asset]=Number(wallet[asset]||0)+Number(investment[asset]||0)+Number(trading[asset]||0)+Number(portfolio[asset]||0);
 const accountValue=usdValueOf(totalByAsset);
 const availableBalanceValue=usdValueOf(available);
 const availableCryptoValue=usdValueOf({USD:0,USDT:available.USDT,BTC:available.BTC,ETH:available.ETH});
 const reservedValue=usdValueOf(reserved);
 const btcAmount=Number(totalByAsset.BTC||0),btcPrice=Number(prices.BTC||0);
 $('#portfolioValue').textContent=money(accountValue);
 $('#portfolioBtcHolding').textContent=`${btcAmount.toLocaleString(undefined,{minimumFractionDigits:8,maximumFractionDigits:8})} BTC`;
 $('#portfolioBtcPrice').textContent=btcPrice>0?money(btcPrice):'Unavailable';
 $('#tickBalance').textContent=money(accountValue);
 $('#drawerBalance').textContent=money(accountValue);
 $('#usdStat').textContent=money(availableBalanceValue);
 $('#cryptoStat').textContent=money(availableCryptoValue);
 const deposited=Number(userData?.fundingSummary?.approvedDepositsUsd||0);const depEl=$('#totalDepositedStat');if(depEl)depEl.textContent=money(deposited);
 const breakdown=$('#availableBreakdown');
 if(breakdown)breakdown.textContent=`Cash ${money(available.USD)} • Crypto ${money(availableCryptoValue)}${reservedValue>0?` • Reserved ${money(reservedValue)}`:''}`;
 $('#balances').innerHTML=Object.entries(wallet).map(([asset,amount])=>`<div class="asset"><b>${asset}</b><span class="balance">${Number(amount).toLocaleString(undefined,{maximumFractionDigits:8})}</span></div>`).join('');
 $('#updated').textContent='Account value updated: '+new Date().toLocaleString();
}
const esc=s=>String(s??'').replace(/[&<>\"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[m]));
function txTitle(x){if(['balance_credit','wallet_adjustment','portfolio_adjustment','trading_adjustment'].includes(x.type)&&x.direction==='credit')return 'Balance Credited';if(['balance_debit','wallet_adjustment','portfolio_adjustment','trading_adjustment'].includes(x.type)&&x.direction==='debit')return 'Balance Debited';const map={withdrawal:'Withdrawal',deposit:'Deposit',self_trade:'Trade',managed_trade:'Trade with OptiTrade',trade_settlement:'Trade Settlement',managed_trade_settlement:'Trade Settlement',investment_plan:'Investment Plan',investment_reserve:'Investment Reserved',investment_release:'Investment Released',investment_settlement:'Investment Settlement',deposit_credit_correction:'Deposit Credit Correction',balance_reversal:'Balance Reversal'};return map[x.type]||String(x.type||'Transaction').replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase())}
function txAmount(x){if(x.kind==='deposit'&&x.usdValue!=null)return money(x.usdValue)+` <small>${Number(x.amount||0).toLocaleString(undefined,{maximumFractionDigits:8})} ${esc(x.asset)}</small>`;const v=x.asset==='USD'?money(x.amount):Number(x.amount||0).toLocaleString(undefined,{maximumFractionDigits:8})+' '+esc(x.asset||'');return v}
async function loadRecentTransactions(){const box=$('#recentTransactions');if(!box)return;try{const r=await fetch('/api/dashboard/recent-transactions?limit=3'),d=await r.json();if(!r.ok)throw 0;box.innerHTML=d.transactions?.length?d.transactions.map(x=>`<article class="recent-tx"><div class="recent-tx-icon ${x.direction==='credit'?'credit':'debit'}">${x.direction==='credit'?'↓':'↑'}</div><div class="recent-tx-copy"><b>${esc(txTitle(x))}</b><span>${esc(x.reference||'')} • ${new Date(String(x.createdAt||'').replace(' ','T')+'Z').toLocaleString()}</span>${x.note?`<small>${esc(x.note)}</small>`:''}</div><div class="recent-tx-value"><b>${txAmount(x)}</b><span class="tx-status ${esc(x.status||'completed')}">${esc(String(x.status||'completed').replace('_',' '))}</span>${x.pnl!=null?`<small class="${Number(x.pnl)>=0?'positive':'negative'}">P/L ${Number(x.pnl)>=0?'+':''}${money(x.pnl)}</small>`:''}</div></article>`).join(''):'<div class="empty"><div>↔</div><b>No transactions yet</b><p>Deposits, withdrawals, trades and balance changes will appear here.</p></div>'}catch{box.innerHTML='<div class="empty"><div>↔</div><b>Could not load transactions</b><p>Refresh the page to try again.</p></div>'}}



async function loadWithdrawalAvailability(){
 try{
  const r=await fetch('/api/withdrawal/status',{cache:'no-store'}),d=await r.json();
  if(r.ok){withdrawalData=d;if(userData)renderAccount()}
 }catch{}
}

async function loadInvestmentSummary(){
 try{
   const r=await fetch('/api/investments/summary',{cache:'no-store'}),d=await r.json();
   if(!r.ok)throw 0;
   $('#activeInvestmentCount').textContent=Number(d.activeCount||0);
   $('#activeInvestmentAllocated').textContent=money(d.allocatedUsd||0);
   $('#activeInvestmentValue').textContent=money(d.currentValueUsd||0);
   if(d.nearestMaturity){
     const dt=new Date(d.nearestMaturity);
     $('#activeInvestmentMaturity').textContent=dt.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
     $('#activeInvestmentPlan').textContent=d.nearestPlan||'Active plan';
   }else{
     $('#activeInvestmentMaturity').textContent='—';
     $('#activeInvestmentPlan').textContent='No active plan';
   }
 }catch{}
}

function syncDashboardTickerClones(){
  document.querySelectorAll('[data-dash-clone]').forEach(clone=>{
    const src=document.getElementById(clone.dataset.dashClone);
    if(src)clone.textContent=src.textContent;
  });
}
let dashTickerFrame=null,dashTickerLast=0,dashTickerOffset=0,dashTickerPaused=false;
function startDashboardTickerMotion(){
  const marquee=document.getElementById('dashTickerMarquee'),first=document.getElementById('dashTickerGroup');
  if(!marquee||!first)return;
  if(dashTickerFrame)cancelAnimationFrame(dashTickerFrame);
  dashTickerLast=0;dashTickerOffset=0;
  const speed=window.innerWidth<760?42:31;
  const step=ts=>{
    if(!dashTickerLast)dashTickerLast=ts;
    const dt=Math.min(50,ts-dashTickerLast);dashTickerLast=ts;
    if(!dashTickerPaused){
      dashTickerOffset+=(speed*dt)/1000;
      const loopWidth=first.getBoundingClientRect().width;
      if(loopWidth>0&&dashTickerOffset>=loopWidth)dashTickerOffset-=loopWidth;
      marquee.style.transform=`translate3d(${-dashTickerOffset}px,0,0)`;
    }
    dashTickerFrame=requestAnimationFrame(step);
  };
  marquee.onmouseenter=()=>dashTickerPaused=true;
  marquee.onmouseleave=()=>dashTickerPaused=false;
  dashTickerFrame=requestAnimationFrame(step);
}
async function loadMarkets(){
  let fx={};
  try{
    const r=await fetch('/api/public/market-ticker',{cache:'no-store'});
    if(!r.ok)throw new Error('Reference market feed unavailable');
    const d=await r.json(),m=d.markets||{};
    prices.BTC=Number(m.BTCUSD)||prices.BTC;
    prices.ETH=Number(m.ETHUSD)||prices.ETH;
    prices.USDT=1;
    fx={EUR:Number(m.EURUSD)||0,GBP:Number(m.GBPUSD)||0,JPY:Number(m.USDJPY)||0};
  }catch(e){}
  $('#tickBtc').textContent=prices.BTC?money(prices.BTC):'Unavailable';
  $('#tickEth').textContent=prices.ETH?money(prices.ETH):'Unavailable';
  $('#tickEur').textContent=fx.EUR?fx.EUR.toFixed(5):'—';
  $('#tickGbp').textContent=fx.GBP?fx.GBP.toFixed(5):'—';
  $('#tickJpy').textContent=fx.JPY?fx.JPY.toFixed(2):'—';
  syncDashboardTickerClones();
  renderMarkets(fx);
  if(userData)renderAccount();
}
(async()=>{const r=await fetch('/api/me');if(!r.ok)return location='/login.html';userData=await r.json();const name=userData.user.name||userData.user.username||'Trader';$('#hello').textContent=`Welcome, ${name}!`;$('#drawerName').textContent=name;$('#avatar').textContent=$('#drawerAvatar').textContent=initials(name);renderAccount();await Promise.all([loadMarkets(),loadWithdrawalAvailability(),loadRecentTransactions(),loadInvestmentSummary()]);startDashboardTickerMotion();setInterval(loadMarkets,60000);setInterval(loadWithdrawalAvailability,30000);setInterval(loadRecentTransactions,30000);setInterval(loadInvestmentSummary,60000)
async function loadConnectionQuickStatus(){
  const btn=document.querySelector('[data-action="connections"]');if(!btn)return;
  const small=btn.querySelector('.qa-copy small');if(!small)return;
  try{
    const w=await fetch('/api/integrations/wallet/status',{cache:'no-store'}).then(r=>r.ok?r.json():{});
    const count=Number(w.count||w.connections?.length||0);
    small.textContent=count?`${count} wallet${count===1?'':'s'} connected`:'Secure wallet link';
    btn.classList.toggle('has-live-connection',count>0);
  }catch{small.textContent='Secure wallet link'}
}
setTimeout(loadConnectionQuickStatus,800);setInterval(loadConnectionQuickStatus,15000);
})();
const drawer=$('#drawer'),shade=$('#shade');function menu(open){drawer.classList.toggle('open',open);shade.classList.toggle('open',open)}$('#menuBtn').onclick=()=>menu(true);$('#closeMenu').onclick=()=>menu(false);shade.onclick=()=>menu(false);document.querySelectorAll('.drawer a').forEach(a=>a.onclick=()=>menu(false));
function toast(t){const e=$('#toast');e.textContent=t;e.classList.add('show');setTimeout(()=>e.classList.remove('show'),2600)}document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>{const map={deposit:'/deposit.html',withdraw:'/withdraw.html',connections:'/integrations.html',switch:'/portfolio.html#switch',plans:'/investments.html',trade:'/trade.html'};location=map[b.dataset.action]||'/dashboard.html'});
$('#logout').onclick=async()=>{await fetch('/api/auth/logout',{method:'POST'});location='/'};$('#themeBtn').onclick=()=>toast('Dark trading theme is active.');
