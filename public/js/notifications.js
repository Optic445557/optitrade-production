(()=>{
let panel,count,wrap,loading=false;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const when=s=>{try{return new Date(String(s||'').replace(' ','T')+'Z').toLocaleString()}catch{return ''}};
async function load(){
 if(!panel||loading)return;loading=true;
 try{
  const r=await fetch('/api/notifications');
  if(r.status===401)return;
  if(!r.ok)return;
  const d=await r.json();
  count.textContent=d.unread>99?'99+':d.unread;
  count.hidden=!d.unread;
  const list=panel.querySelector('.ot-notif-list');
  list.innerHTML=d.notifications.length?d.notifications.map(n=>`
   <a class="ot-notif-item ${n.is_read?'':'unread'}" href="${esc(n.href||'#')}" data-id="${n.id}">
    <span class="ot-notif-dot"></span><span class="ot-notif-copy"><b>${esc(n.title)}</b><p>${esc(n.body)}</p><small>${when(n.created_at)}</small></span>
   </a>`).join(''):'<div class="ot-notif-empty">No notifications yet.</div>';
  list.querySelectorAll('[data-id]').forEach(a=>a.addEventListener('click',()=>fetch('/api/notifications/'+a.dataset.id+'/read',{method:'POST'})));
 }finally{loading=false}
}
function init(){
 const host=document.querySelector('.top-actions')||document.querySelector('.top-right');
 if(!host)return;
 // remove old hard-coded/fake dashboard notification button
 const fake=[...host.querySelectorAll('button')].find(b=>/Notifications/i.test(b.getAttribute('aria-label')||''));
 if(fake)fake.remove();
 wrap=document.createElement('div');wrap.className='ot-notif-wrap';
 wrap.innerHTML=`<button class="ot-notif-btn" aria-label="Notifications">🔔<span class="ot-notif-count" hidden>0</span></button>
 <div class="ot-notif-panel">
   <div class="ot-notif-head"><div><b>Notifications</b><small>Account updates and important messages</small></div><button data-read>Mark all read</button></div>
   <div class="ot-notif-list"><div class="ot-notif-empty">Loading…</div></div>
   <a class="ot-notif-foot" href="/activity.html">View all account activity →</a>
 </div>`;
 host.insertBefore(wrap,host.firstChild);
 panel=wrap.querySelector('.ot-notif-panel');count=wrap.querySelector('.ot-notif-count');
 wrap.querySelector('.ot-notif-btn').onclick=e=>{e.stopPropagation();panel.classList.toggle('open');if(panel.classList.contains('open'))load()};
 wrap.querySelector('[data-read]').onclick=async()=>{await fetch('/api/notifications/read-all',{method:'POST'});load()};
 document.addEventListener('click',e=>{if(!wrap.contains(e.target))panel.classList.remove('open')});
 load();setInterval(load,7000);
}
document.addEventListener('DOMContentLoaded',init);
})();