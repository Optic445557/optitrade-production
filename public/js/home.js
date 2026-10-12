(()=>{
const $=id=>document.getElementById(id);
$('year').textContent=new Date().getFullYear();

const menu=$('mobileMenu'),shade=$('menuShade');
$('menuBtn').onclick=()=>{menu.classList.add('open');shade.classList.add('show')};
$('closeMenu').onclick=()=>{menu.classList.remove('open');shade.classList.remove('show')};
shade.onclick=$('closeMenu').onclick;
menu.querySelectorAll('a').forEach(a=>a.addEventListener('click',$('closeMenu').onclick));

const canvas=$('heroChart'),ctx=canvas.getContext('2d');
let current='BTC',series=[];

function money(v){
  return '$'+Number(v||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
}
function resize(){
  const r=canvas.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,2);
  canvas.width=Math.max(300,Math.floor(r.width*d));
  canvas.height=Math.max(180,Math.floor(r.height*d));
  ctx.setTransform(d,0,0,d,0,0);
}
function draw(){
  resize();
  const w=canvas.clientWidth,h=canvas.clientHeight;
  ctx.clearRect(0,0,w,h);
  if(series.length<2)return;
  const vals=series.map(x=>x[1]),min=Math.min(...vals),max=Math.max(...vals),span=Math.max(max-min,max*.002),lo=min-span*.15,hi=max+span*.15;
  const p={l:8,r:8,t:12,b:18},x=i=>p.l+i/(series.length-1)*(w-p.l-p.r),y=v=>p.t+(1-(v-lo)/(hi-lo))*(h-p.t-p.b);
  ctx.strokeStyle='rgba(122,151,184,.12)';ctx.lineWidth=1;
  for(let i=0;i<4;i++){let yy=p.t+i*(h-p.t-p.b)/3;ctx.beginPath();ctx.moveTo(p.l,yy);ctx.lineTo(w-p.r,yy);ctx.stroke()}
  const grad=ctx.createLinearGradient(0,p.t,0,h-p.b);grad.addColorStop(0,'rgba(34,213,255,.27)');grad.addColorStop(1,'rgba(34,213,255,0)');
  ctx.beginPath();series.forEach((q,i)=>i?ctx.lineTo(x(i),y(q[1])):ctx.moveTo(x(i),y(q[1])));ctx.lineTo(w-p.r,h-p.b);ctx.lineTo(p.l,h-p.b);ctx.closePath();ctx.fillStyle=grad;ctx.fill();
  ctx.beginPath();series.forEach((q,i)=>i?ctx.lineTo(x(i),y(q[1])):ctx.moveTo(x(i),y(q[1])));ctx.strokeStyle='#28d3ff';ctx.lineWidth=2.3;ctx.shadowColor='rgba(40,211,255,.45)';ctx.shadowBlur=8;ctx.stroke();ctx.shadowBlur=0;
}
async function loadHero(symbol=current){
  current=symbol;
  document.querySelectorAll('[data-home-pair]').forEach(b=>b.classList.toggle('active',b.dataset.homePair===symbol));
  const id=symbol==='BTC'?'bitcoin':'ethereum';
  try{
    const r=await fetch(`/api/public/market-history?symbol=${encodeURIComponent(symbol)}`,{cache:'no-store'});
    if(!r.ok)throw 0;
    const d=await r.json();let raw=(d.prices||[]).filter(x=>Array.isArray(x)&&Number.isFinite(x[1]));
    const step=Math.max(1,Math.ceil(raw.length/90));series=raw.filter((_,i)=>i%step===0);
    if(series.at(-1)!==raw.at(-1))series.push(raw.at(-1));
    const first=series[0][1],last=series.at(-1)[1],pct=(last-first)/first*100;
    $('heroPrice').textContent=money(last);$('heroChange').textContent=(pct>=0?'+':'')+pct.toFixed(2)+'% • 24H reference';$('heroChange').style.color=pct>=0?'#64dca4':'#ff7f91';$('heroPair').textContent=symbol+'/USD';draw();
  }catch(e){$('heroPrice').textContent='Market unavailable';$('heroChange').textContent='Reference feed will retry';}
}
document.querySelectorAll('[data-home-pair]').forEach(b=>b.onclick=()=>loadHero(b.dataset.homePair));
window.addEventListener('resize',draw);

let homeTickerFrame=null,homeTickerLast=0,homeTickerOffset=0,homeTickerPaused=false;
function startHomeTickerMotion(){
  const marquee=document.getElementById('homeTickerMarquee');
  const first=marquee?.querySelector('.ticker-group');
  if(!marquee||!first)return;
  if(homeTickerFrame)cancelAnimationFrame(homeTickerFrame);
  homeTickerLast=0;homeTickerOffset=0;
  const speed=window.innerWidth<700?38:30; // pixels per second
  const step=ts=>{
    if(!homeTickerLast)homeTickerLast=ts;
    const dt=Math.min(50,ts-homeTickerLast);homeTickerLast=ts;
    if(!homeTickerPaused){
      homeTickerOffset+=(speed*dt)/1000;
      const loopWidth=first.getBoundingClientRect().width;
      if(loopWidth>0&&homeTickerOffset>=loopWidth)homeTickerOffset-=loopWidth;
      marquee.style.transform=`translate3d(${-homeTickerOffset}px,0,0)`;
    }
    homeTickerFrame=requestAnimationFrame(step);
  };
  marquee.onmouseenter=()=>homeTickerPaused=true;
  marquee.onmouseleave=()=>homeTickerPaused=false;
  marquee.ontouchstart=()=>homeTickerPaused=false;
  homeTickerFrame=requestAnimationFrame(step);
}

function syncTickerClones(){
  document.querySelectorAll('[data-ticker-clone]').forEach(clone=>{
    const src=$(clone.dataset.tickerClone);
    if(src)clone.textContent=src.textContent;
  });
}
async function ticker(){
  try{
    const r=await fetch('/api/public/market-ticker',{cache:'no-store'});
    if(!r.ok)throw new Error('Market feed unavailable');
    const d=await r.json(),m=d.markets||{};
    $('btcTicker').textContent=money(m.BTCUSD);
    $('ethTicker').textContent=money(m.ETHUSD);
    $('eurTicker').textContent=Number.isFinite(Number(m.EURUSD))?Number(m.EURUSD).toFixed(4):'—';
    $('gbpTicker').textContent=Number.isFinite(Number(m.GBPUSD))?Number(m.GBPUSD).toFixed(4):'—';
    $('jpyTicker').textContent=Number.isFinite(Number(m.USDJPY))?Number(m.USDJPY).toFixed(2):'—';
    syncTickerClones();
  }catch(e){
    syncTickerClones();
  }
}
loadHero();ticker();startHomeTickerMotion();setInterval(ticker,60000);setInterval(()=>loadHero(current),300000);window.addEventListener('resize',()=>{homeTickerOffset=0});
})();