import { EthereumProvider } from '@walletconnect/ethereum-provider';

const $=s=>document.querySelector(s);
const els={
  wcBtn:$('#walletConnect'),
  browserBtn:$('#browserWalletConnect'),
  disconnect:$('#walletDisconnect'),
  state:$('#walletState'),
  message:$('#walletMessage'),
  snapshot:$('#walletSnapshot'),
  address:$('#walletAddress'),
  network:$('#walletNetwork'),
  chain:$('#walletChain'),
  balance:$('#walletBalance'),
  walletName:$('#walletProviderName'),
  tokenList:$('#walletTokenList'),
  historyList:$('#walletHistoryList'),
  historyStatus:$('#walletHistoryStatus'),
  historyRefresh:$('#walletHistoryRefresh'),
  project:$('#walletProjectStatus'),
  relay:$('#walletRelayStatus')
};

const CHAINS={
  1:{name:'Ethereum',symbol:'ETH'},
  10:{name:'Optimism',symbol:'ETH'},
  56:{name:'BNB Smart Chain',symbol:'BNB'},
  137:{name:'Polygon',symbol:'POL'},
  8453:{name:'Base',symbol:'ETH'},
  42161:{name:'Arbitrum One',symbol:'ETH'}
};
const OPTIONAL_CHAINS=Object.keys(CHAINS).map(Number);

const TOKENS={
  1:[{symbol:'USDT',address:'0xdAC17F958D2ee523a2206206994597C13D831ec7',decimals:6}],
  10:[{symbol:'USDT',address:'0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',decimals:6}],
  56:[{symbol:'USDT',address:'0x55d398326f99059fF775485246999027B3197955',decimals:18}],
  137:[{symbol:'USDT',address:'0xc2132D05D31c914a87C6611C10748AaCbFfEFeD',decimals:6}],
  42161:[{symbol:'USDT',address:'0xFd086bC7CD5C481DCC9C85ebe478A1C0b69FCbb9',decimals:6}]
};
function formatUnitsBigInt(v,decimals){
  const n=BigInt(v||0),base=10n**BigInt(decimals),whole=n/base,frac=(n%base).toString().padStart(decimals,'0').slice(0,8).replace(/0+$/,'');
  return frac?`${whole}.${frac}`:String(whole);
}
async function getTokenBalance(provider,address,token){
  const clean=address.toLowerCase().replace(/^0x/,'').padStart(64,'0');
  const data='0x70a08231'+clean;
  const raw=await provider.request({method:'eth_call',params:[{to:token.address,data},'latest']});
  return formatUnitsBigInt(raw,token.decimals);
}
async function loadTrackedTokens(provider,address,chainId){
  if(!els.tokenList)return;
  const list=TOKENS[chainId]||[];
  if(!list.length){els.tokenList.innerHTML='<div class="wallet-empty-mini">No tracked token contracts are configured for this network yet.</div>';return}
  els.tokenList.innerHTML='<div class="wallet-empty-mini">Loading tracked tokens…</div>';
  const rows=[];
  for(const token of list){
    try{rows.push({...token,balance:await getTokenBalance(provider,address,token)})}
    catch{rows.push({...token,balance:'Unavailable'})}
  }
  els.tokenList.innerHTML=rows.map(t=>`<div class="wallet-token-row"><b>${t.symbol}</b><span>${t.balance}</span><small>${t.address.slice(0,8)}…${t.address.slice(-6)}</small></div>`).join('');
}
function historyAmount(x){const n=Number(x.amount);return Number.isFinite(n)?n.toLocaleString(undefined,{maximumFractionDigits:8}):'—'}
async function loadHistory(chainId){
  if(!els.historyList)return;
  els.historyStatus.textContent='Loading on-chain activity…';
  try{
    const d=await api(`/api/integrations/wallet/history?chainId=${encodeURIComponent(chainId)}`);
    if(!d.configured){els.historyStatus.textContent='History provider not configured yet.';els.historyList.innerHTML='<div class="wallet-empty-mini">Add ETHERSCAN_API_KEY on the server to show recent EVM transactions.</div>';return}
    const rows=d.transactions||[];
    els.historyStatus.textContent=rows.length?`Latest ${rows.length} activities`:'No recent activity found';
    els.historyList.innerHTML=rows.length?rows.map(x=>`<div class="wallet-history-row"><span class="wallet-history-dir ${x.direction}">${x.direction==='in'?'↓':'↑'}</span><div><b>${x.direction==='in'?'Received':'Sent'} ${x.symbol}</b><small>${new Date(x.time).toLocaleString()} • ${x.hash.slice(0,10)}…${x.hash.slice(-8)}</small></div><strong>${historyAmount(x)} ${x.symbol}</strong></div>`).join(''):'<div class="wallet-empty-mini">No recent transactions returned by the history provider.</div>';
  }catch(e){
    els.historyStatus.textContent='History unavailable';
    els.historyList.innerHTML=`<div class="wallet-empty-mini">${String(e.message||e).replace(/[<>]/g,'')}</div>`;
  }
}


let wc=null;
let activeProvider=null;
let activeMode=null;
let currentAddress=null;

function setMessage(msg,bad=false){
  if(!els.message)return;
  els.message.textContent=msg||'';
  els.message.classList.toggle('negative',!!bad);
  els.message.classList.toggle('positive',!bad && !!msg);
}
function setState(connected,label){
  if(!els.state)return;
  els.state.textContent=label||(connected?'Connected':'Not connected');
  els.state.classList.toggle('connected',!!connected);
}
function parseChainId(value){
  if(typeof value==='number')return value;
  const s=String(value||'');
  if(s.startsWith('0x'))return parseInt(s,16);
  if(s.includes(':'))return Number(s.split(':').pop());
  return Number(s)||0;
}
function shortAddress(a){
  return a?`${a.slice(0,8)}…${a.slice(-6)}`:'—';
}
async function api(url,opt={}){
  const r=await fetch(url,{...opt,headers:{accept:'application/json',...(opt.headers||{})}});
  let d={};try{d=await r.json()}catch{}
  if(!r.ok)throw new Error(d.error||`Request failed (${r.status})`);
  return d;
}
async function savePublic(address,chainId,walletName,providerType){
  await api('/api/integrations/wallet/status',{
    method:'PUT',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      address,
      namespace:'eip155',
      chainId:String(chainId||''),
      walletName:walletName||'Wallet',
      providerType:providerType||'walletconnect'
    })
  });
}
async function deletePublic(){
  try{await api('/api/integrations/wallet/status',{method:'DELETE'})}catch{}
}
async function getBalance(provider,address,chainId){
  try{
    const hex=await provider.request({method:'eth_getBalance',params:[address,'latest']});
    const wei=BigInt(hex);
    const whole=Number(wei)/1e18;
    const symbol=CHAINS[chainId]?.symbol||'ETH';
    return `${whole.toLocaleString(undefined,{maximumFractionDigits:6})} ${symbol}`;
  }catch{
    return 'Unavailable';
  }
}
async function renderConnected(provider,address,chainId,walletName,providerType){
  if(!address)return;
  currentAddress=address;
  activeProvider=provider;
  const cid=parseChainId(chainId);
  const meta=CHAINS[cid]||{name:'EVM Network',symbol:'ETH'};
  const bal=await getBalance(provider,address,cid);
  els.snapshot.hidden=false;
  els.address.textContent=address;
  els.address.title=address;
  els.network.textContent=meta.name;
  els.chain.textContent=cid?`Chain ID ${cid}`:'Connected network';
  els.balance.textContent=bal;
  els.walletName.textContent=walletName||'Wallet';
  els.disconnect.hidden=false;
  setState(true,'Connected');
  setMessage(`Connected ${shortAddress(address)} on ${meta.name}.`);
  await savePublic(address,cid,walletName,providerType);
  await Promise.all([loadTrackedTokens(provider,address,cid),loadHistory(cid)]);
}
function clearView(message='Wallet disconnected.'){
  currentAddress=null;
  activeProvider=null;
  activeMode=null;
  els.snapshot.hidden=true;
  if(els.tokenList)els.tokenList.innerHTML='';
  if(els.historyList)els.historyList.innerHTML='';
  if(els.historyStatus)els.historyStatus.textContent='Connect a wallet to load activity.';
  els.disconnect.hidden=true;
  setState(false);
  setMessage(message);
}
function wireProvider(provider,walletName,providerType){
  if(!provider?.on)return;
  provider.on('accountsChanged',async accounts=>{
    if(accounts?.[0]){
      const chainId=parseChainId(provider.chainId || await provider.request({method:'eth_chainId'}));
      await renderConnected(provider,accounts[0],chainId,walletName,providerType);
    }else{
      await deletePublic();
      clearView('Wallet account disconnected.');
    }
  });
  provider.on('chainChanged',async value=>{
    if(!currentAddress)return;
    await renderConnected(provider,currentAddress,parseChainId(value),walletName,providerType);
  });
  provider.on('disconnect',async()=>{
    await deletePublic();
    clearView('WalletConnect session disconnected.');
  });
}

async function initWalletConnect(){
  const cfg=await api('/api/integrations/wallet/config');
  if(!cfg.projectId)throw new Error('WalletConnect Project ID is not configured.');
  els.project.textContent='Project ID loaded';
  els.relay.textContent='Provider ready';

  wc=await EthereumProvider.init({
    projectId:cfg.projectId,
    optionalChains:OPTIONAL_CHAINS,
    showQrModal:true,
    metadata:{
      name:'OptiTrade',
      description:'OptiTrade crypto wallet connection',
      url:location.origin,
      icons:[]
    },
    methods:[
      'eth_accounts','eth_requestAccounts','eth_sendTransaction',
      'personal_sign','eth_signTypedData','eth_signTypedData_v4'
    ],
    events:['chainChanged','accountsChanged']
  });

  wireProvider(wc,'WalletConnect','walletconnect');

  if(wc.session && Array.isArray(wc.accounts) && wc.accounts.length){
    const raw=wc.accounts[0];
    const address=String(raw).includes(':')?String(raw).split(':').pop():raw;
    const chainId=parseChainId(wc.chainId);
    activeMode='walletconnect';
    await renderConnected(wc,address,chainId,'WalletConnect','walletconnect');
  }
}

async function connectWalletConnect(){
  els.wcBtn.disabled=true;
  setMessage('Opening WalletConnect. Approve the connection inside your wallet.');
  try{
    if(!wc)await initWalletConnect();
    await wc.connect({optionalChains:OPTIONAL_CHAINS});
    const accounts=wc.accounts||[];
    if(!accounts.length)throw new Error('Wallet connected without returning an account.');
    const raw=accounts[0];
    const address=String(raw).includes(':')?String(raw).split(':').pop():raw;
    activeMode='walletconnect';
    await renderConnected(wc,address,parseChainId(wc.chainId),'WalletConnect','walletconnect');
  }catch(e){
    const msg=e?.message||String(e);
    setMessage(msg,true);
    els.relay.textContent='Connection failed';
  }finally{
    els.wcBtn.disabled=false;
  }
}

async function connectBrowserWallet(){
  const provider=window.ethereum;
  if(!provider){
    setMessage('No compatible browser wallet was detected. Use WalletConnect instead.',true);
    return;
  }
  els.browserBtn.disabled=true;
  setMessage('Waiting for browser-wallet approval…');
  try{
    const accounts=await provider.request({method:'eth_requestAccounts'});
    if(!accounts?.[0])throw new Error('Wallet did not return an account.');
    const chainId=parseChainId(await provider.request({method:'eth_chainId'}));
    const name=provider.isMetaMask?'MetaMask':'Browser Wallet';
    activeMode='browser';
    wireProvider(provider,name,'injected');
    await renderConnected(provider,accounts[0],chainId,name,'injected');
  }catch(e){
    setMessage(e?.message||String(e),true);
  }finally{
    els.browserBtn.disabled=false;
  }
}

async function disconnectWallet(){
  els.disconnect.disabled=true;
  try{
    if(activeMode==='walletconnect' && wc){
      try{await wc.disconnect()}catch{}
    }
    await deletePublic();
    clearView('Wallet disconnected from OptiTrade.');
  }finally{
    els.disconnect.disabled=false;
  }
}

async function restoreServerStatus(){
  try{
    const d=await api('/api/integrations/wallet/status');
    if(d.connection && !currentAddress){
      const c=d.connection;
      els.snapshot.hidden=false;
      els.address.textContent=c.address;
      els.network.textContent='Saved connection';
      els.chain.textContent=c.chain_id?`Chain ID ${c.chain_id}`:'—';
      els.balance.textContent='Reconnect wallet for live balance';
      els.walletName.textContent=c.wallet_name||'Wallet';
      setState(true,'Reconnect');
      els.disconnect.hidden=false;
      setMessage('A previous public wallet address is saved. Reconnect the wallet to restore the live session.');
    }
  }catch{}
}

els.wcBtn?.addEventListener('click',connectWalletConnect);
els.browserBtn?.addEventListener('click',connectBrowserWallet);
els.disconnect?.addEventListener('click',disconnectWallet);
els.historyRefresh?.addEventListener('click',async()=>{
  if(!activeProvider||!currentAddress)return setMessage('Reconnect the wallet to refresh live history.',true);
  let cid=0;try{cid=parseChainId(activeProvider.chainId||await activeProvider.request({method:'eth_chainId'}))}catch{}
  if(cid)await loadHistory(cid);
});

(async()=>{
  try{
    const me=await fetch('/api/me',{cache:'no-store'});
    if(!me.ok){location='/login.html';return}
    await restoreServerStatus();
    await initWalletConnect();
  }catch(e){
    els.project.textContent='Setup error';
    els.relay.textContent='Unavailable';
    setMessage(`Wallet connection setup failed: ${e?.message||e}`,true);
  }
})();
