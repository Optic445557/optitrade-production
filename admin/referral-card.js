(()=>{
async function initAdminReferralCard(){
 const host=document.getElementById('adminReferralCard'); if(!host)return;
 try{
  const r=await fetch('/api/admin/referral-info'); if(r.status===401)return location='/login.html';
  const d=await r.json(); if(!r.ok)return;
  if(d.role==='super_admin'){host.innerHTML='<h2>Customer Registration Links</h2><p class="muted">Create a Sub-Admin from Admin Management. Each Sub-Admin receives a permanent customer registration link.</p>';return}
  if(!d.referralCode){host.innerHTML='<h2>My Customer Registration Link</h2><p class="muted">No active referral code is assigned to this admin.</p>';return}
  const url=location.origin+'/register.html?ref='+encodeURIComponent(d.referralCode);
  host.innerHTML=`<h2>My Customer Registration Link</h2><p class="muted">Send this link to customers you want assigned to your OptiTrade admin account.</p><div class="referral-link-row"><input id="customerReferralUrl" readonly><button class="btn" id="copyReferral">Copy Link</button><button class="btn ghost" id="shareReferral">Share</button></div><small class="muted">Referral: ${d.referralCode} • This link assigns registrations only; it does not grant admin access.</small>`;
  document.getElementById('customerReferralUrl').value=url;
  document.getElementById('copyReferral').onclick=async()=>{try{await navigator.clipboard.writeText(url);let b=document.getElementById('copyReferral');b.textContent='Copied ✓';setTimeout(()=>b.textContent='Copy Link',1500)}catch(e){let x=document.getElementById('customerReferralUrl');x.select();document.execCommand('copy')}};
  document.getElementById('shareReferral').onclick=async()=>{if(navigator.share)try{await navigator.share({title:'Join OptiTrade',text:'Create your OptiTrade account',url})}catch(e){}else document.getElementById('copyReferral').click()};
 }catch(e){host.innerHTML='<h2>My Customer Registration Link</h2><p class="muted">Could not load referral link.</p>'}
}
document.addEventListener('DOMContentLoaded',initAdminReferralCard);
})();