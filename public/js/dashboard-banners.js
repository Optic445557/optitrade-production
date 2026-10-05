(()=>{
let timer=0,refreshTimer=0,index=0,slides=[],host,track,dots,startX=null,lastSignature='',rotationSeconds=3,notificationHours=24;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeHref=h=>{let v=String(h||'').trim();if(v.startsWith('/')&&!v.startsWith('//'))return v;try{let u=new URL(v,location.origin);return ['http:','https:'].includes(u.protocol)?u.href:'#'}catch{return '#'}};

function go(i){
  if(!slides.length||!track)return;
  index=(i+slides.length)%slides.length;
  track.style.transform=`translateX(-${index*100}%)`;
  track.querySelectorAll('.ot-banner-slide').forEach((s,j)=>s.classList.toggle('active',j===index));
  dots?.querySelectorAll('button').forEach((b,j)=>b.classList.toggle('active',j===index));
}
function cycle(){
  clearInterval(timer);
  const ms=Math.max(1,Math.min(60,Number(rotationSeconds)||3))*1000;
  if(slides.length>1)timer=setInterval(()=>go(index+1),ms);
}
function slideHtml(b){
  const img=b.image_url?`style="background-image:linear-gradient(90deg,rgba(3,14,28,.96),rgba(3,14,28,.72)),url('${esc(b.image_url)}')"`:'';
  const notificationId=Number(b.notification_id)||0;
  const cta=b.button_text&&b.button_url?`<a class="ot-banner-cta" href="${esc(safeHref(b.button_url))}" ${notificationId?`data-notification-link="${notificationId}"`:''} ${/^https?:\/\//.test(b.button_url)?'target="_blank" rel="noopener noreferrer"':''}>${esc(b.button_text)} →</a>`:'';
  const attr=b.is_testimonial&&b.attribution?`<small class="ot-banner-attr">— ${esc(b.attribution)}</small>`:'';
  const age=b.source==='notification'?`<small class="ot-banner-notice-life">Quick account update • stays here up to ${notificationHours}h</small>`:'';
  const kind=b.source==='notification'?`${String(b.kind||'account').toUpperCase()} UPDATE`:String(b.kind||'info').toUpperCase();
  return `<article class="ot-banner-slide ${b.source==='notification'?'notification-slide':''}" ${notificationId?`data-notification-id="${notificationId}"`:''} ${img}><div class="ot-banner-copy"><span class="ot-banner-kind">${esc(kind)}</span><h2>${esc(b.title)}</h2><p>${esc(b.body)}</p>${attr}${age}${cta}</div></article>`;
}
function bind(){
  track=host.querySelector('.ot-banner-track');
  dots=host.querySelector('.ot-banner-dots');
  dots?.querySelectorAll('button').forEach((b,i)=>b.onclick=()=>{go(i);cycle()});
  host.querySelectorAll('[data-notification-link]').forEach(a=>a.addEventListener('click',()=>{
    const id=Number(a.dataset.notificationLink);if(id)fetch('/api/notifications/'+id+'/read',{method:'POST'}).catch(()=>{});
  }));
  host.addEventListener('touchstart',e=>{startX=e.touches[0].clientX},{passive:true});
  host.addEventListener('touchend',e=>{
    if(startX!=null){
      const dx=e.changedTouches[0].clientX-startX;
      if(Math.abs(dx)>40)go(index+(dx<0?1:-1));
      startX=null;
      cycle();
    }
  },{passive:true});
  go(Math.min(index,slides.length-1));
  cycle();
}
function signature(rows){
  return JSON.stringify(rows.map(x=>[x.id,x.source,x.notification_id,x.title,x.body,x.kind,x.image_url,x.button_text,x.button_url,x.is_testimonial,x.attribution]));
}
function render(mount,rows){
  slides=rows;
  if(!slides.length)return;
  const oldIndex=index;
  host=document.createElement('section');
  host.className='ot-banner-carousel';
  host.innerHTML=`<div class="ot-banner-track">${slides.map(slideHtml).join('')}</div><div class="ot-banner-dots">${slides.map((_,i)=>`<button aria-label="Show banner ${i+1}"></button>`).join('')}</div>`;
  mount.replaceChildren(host);
  index=Math.min(oldIndex,slides.length-1);
  bind();
}
async function loadFeed(mount,{initial=false}={}){
  try{
    const r=await fetch('/api/banners?ts='+Date.now(),{headers:{accept:'application/json'},cache:'no-store'});
    if(!r.ok)throw new Error('Banner feed unavailable');
    const d=await r.json();
    const rows=Array.isArray(d.banners)?d.banners:[];
    rotationSeconds=Math.max(1,Math.min(60,Number(d.rotationSeconds)||3));
    notificationHours=Number(d.notificationHours)===12?12:24;
    const sig=signature(rows)+'|timer:'+rotationSeconds+'|noticeHours:'+notificationHours;
    if(!rows.length){
      // Keep built-in fallback on the very first load. If published banners are later removed,
      // leave the last rendered banner until the next page load instead of showing a blank area.
      if(initial)slides=[];
      return;
    }
    if(sig!==lastSignature){
      lastSignature=sig;
      render(mount,rows);
    }else if(slides.length>1&&!timer){
      cycle();
    }
  }catch(e){
    if(initial)console.warn('[DASHBOARD BANNER]',e.message);
  }
}
async function init(){
  const mount=document.querySelector('[data-dashboard-banner]');
  if(!mount)return;
  await loadFeed(mount,{initial:true});
  clearInterval(refreshTimer);
  // Pick up new/edited banners without requiring the customer to refresh the dashboard.
  refreshTimer=setInterval(()=>loadFeed(mount),5000);
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible')loadFeed(mount);
  });
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
