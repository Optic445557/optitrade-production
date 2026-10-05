(()=>{
const esc=s=>String(s??'').replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
function ensurePlatformNav(){
 const nav=document.querySelector('.nav');if(!nav)return;
 const mailerLink=nav.querySelector('a[href="/admin/message-center.html"]');if(mailerLink)mailerLink.textContent='OptiTrade Mailer';
 const overview=nav.querySelector('a[href="/admin/dashboard.html"]');
 let attention=nav.querySelector('a[href="/admin/attention.html"]');
 if(!attention){attention=document.createElement('a');attention.href='/admin/attention.html';attention.innerHTML='Attention Center <span class="nav-attention-count" id="navAttentionCount" hidden>0</span>';if(overview&&overview.nextSibling)nav.insertBefore(attention,overview.nextSibling);else nav.prepend(attention)}
 const trade=nav.querySelector('a[href="/admin/managed-trades.html"]');let after=trade;
 for(const [href,label] of [['/admin/investment-plans.html','Investment Plans'],['/admin/kyc.html','KYC Center'],['/admin/exchange.html','Exchange Integration']]){
  let a=nav.querySelector(`a[href="${href}"]`);if(!a){a=document.createElement('a');a.href=href;a.textContent=label;if(after&&after.nextSibling)nav.insertBefore(a,after.nextSibling);else nav.appendChild(a)}after=a;
 }
}
function ensureAttentionBell(){
 const top=document.querySelector('.top');if(!top||document.getElementById('adminAttentionBell'))return;
 const wrap=document.createElement('div');wrap.className='admin-attention-wrap';
 wrap.innerHTML=`<button id="adminAttentionBell" class="admin-attention-bell" type="button" aria-label="Urgent requests"><span class="admin-attention-bell-icon">🔔</span><b id="adminAttentionBadge" hidden>0</b></button><div id="adminAttentionDropdown" class="admin-attention-dropdown" hidden><div class="admin-attention-head"><div><b>Needs Attention</b><small id="adminAttentionSummary">Checking…</small></div><a href="/admin/attention.html">Open Center</a></div><div id="adminAttentionItems" class="admin-attention-items"><span class="muted">Loading…</span></div></div>`;
 const actions=top.querySelector('.admin-top-actions');if(actions)actions.prepend(wrap);else top.appendChild(wrap);
 const bell=document.getElementById('adminAttentionBell'),drop=document.getElementById('adminAttentionDropdown');
 bell.onclick=e=>{e.stopPropagation();drop.hidden=!drop.hidden;if(!drop.hidden)refreshAdminAttention()};drop.onclick=e=>e.stopPropagation();document.addEventListener('click',()=>drop.hidden=true);
}
async function refreshAdminAttention(){
 const bell=document.getElementById('adminAttentionBell');if(!bell)return;
 try{
  const r=await fetch('/api/admin/attention',{cache:'no-store'});if(r.status===401||r.status===403||!r.ok)return;const d=await r.json(),total=Number(d.counts?.total||0);
  const badge=document.getElementById('adminAttentionBadge'),nav=document.getElementById('navAttentionCount');badge.textContent=total;badge.hidden=!total;bell.classList.toggle('has-urgent',total>0);if(nav){nav.textContent=total;nav.hidden=!total}
  const summary=document.getElementById('adminAttentionSummary');if(summary)summary.textContent=total?`${d.counts.deposits} deposit • ${d.counts.withdrawals} withdrawal • ${d.counts.trades} trade`:'Nothing pending right now';
  const box=document.getElementById('adminAttentionItems');if(box)box.innerHTML=total?(d.items||[]).slice(0,8).map(x=>`<a class="admin-attention-item ${esc(x.kind)}" href="${esc(x.href)}"><span class="admin-attention-type">${x.kind==='deposit'?'↓':x.kind==='withdrawal'?'↑':'↗'}</span><span><b>${esc(x.title)}</b><small>${esc(x.customer)} • ${esc(x.detail)}</small></span><em>Review</em></a>`).join(''):'<div class="admin-attention-empty">✓ No pending deposit, withdrawal or trade request.</div>';
 }catch{}
}
function ensureLogout(){
 if(document.getElementById('adminLogout'))return;
 const side=document.querySelector('.side');if(side){const wrap=document.createElement('div');wrap.className='admin-session-actions';wrap.innerHTML='<button id="adminLogout" class="admin-logout-btn" type="button"><span class="admin-logout-icon">↪</span><span>Log Out</span></button>';side.appendChild(wrap)}
 if(!document.getElementById('adminMobileLogout')){const m=document.createElement('button');m.id='adminMobileLogout';m.className='admin-mobile-logout';m.type='button';m.innerHTML='↪ <span>Log Out</span>';document.body.appendChild(m)}
 const out=async b=>{if(b)b.disabled=true;try{await fetch('/api/auth/logout',{method:'POST'})}catch{}location.href='/'};document.getElementById('adminLogout')?.addEventListener('click',e=>out(e.currentTarget));document.getElementById('adminMobileLogout')?.addEventListener('click',e=>out(e.currentTarget));
}
function boot(){ensurePlatformNav();ensureAttentionBell();ensureLogout();refreshAdminAttention();setInterval(()=>{if(!document.hidden)refreshAdminAttention()},12000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshAdminAttention()})}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();

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
