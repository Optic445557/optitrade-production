(function(){
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let me=null, chatOpen=false, lastState='', poll=null, quickHelpExpanded=false, welcomeExpanded=false;
const initials=n=>String(n||'User').trim().split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase();
const money=n=>'$'+Number(n||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
function portfolio(d){let b=Object.fromEntries((d.balances||[]).map(x=>[x.asset,Number(x.amount)]));return (b.USD||0)+(b.USDT||0);}
async function getMe(){if(window.userData&&window.userData.user)return window.userData;try{let r=await fetch('/api/me');if(!r.ok)return null;return await r.json()}catch(e){return null}}
function addProfile(d){
  if(document.querySelector('.ot-profile-wrap'))return;
  const host=document.querySelector('.top-actions')||document.querySelector('.top-right'); if(!host)return;
  const old=document.querySelector('#avatar'); if(old)old.style.display='none';
  const name=d.user.name||d.user.username||'Trader', user=d.user.username?'@'+d.user.username:'OptiTrade user';
  const wrap=document.createElement('div');wrap.className='ot-profile-wrap';
  wrap.innerHTML=`<button class="ot-profile-trigger"><span class="ot-profile-avatar">${esc(initials(name))}</span><span class="ot-profile-meta"><b>${esc(name)}</b><small>${esc(user)}</small></span><span>⌄</span></button>
  <div class="ot-profile-menu"><div class="ot-profile-card"><span class="ot-profile-avatar">${esc(initials(name))}</span><div><b>${esc(name)}</b><small>${esc(user)}</small><small>${esc(d.user.email||'')}</small><div class="ot-verified">${d.user.email_verified?'● Verified account':'○ Verification pending'}</div></div></div>
  <div class="ot-menu-balance"><span>Account balance</span><b>${money(portfolio(d))}</b></div>
  <div class="ot-profile-links"><a href="/profile.html">♙ My Profile</a><a href="/portfolio.html">◔ My Portfolio</a><a href="/statement.html">▤ Account Statement</a><a href="/security.html">⌾ Security</a><button class="danger" data-ot-logout>↪ Sign Out</button></div></div>`;
  host.insertBefore(wrap,host.firstChild);
  wrap.querySelector('.ot-profile-trigger').onclick=e=>{e.stopPropagation();wrap.querySelector('.ot-profile-menu').classList.toggle('open')};
  wrap.querySelector('[data-ot-logout]').onclick=async()=>{await fetch('/api/auth/logout',{method:'POST'});location='/'};
  document.addEventListener('click',e=>{if(!wrap.contains(e.target))wrap.querySelector('.ot-profile-menu').classList.remove('open')});
}
function addChat(){
 if(document.querySelector('.ot-chat-fab'))return;
 document.body.insertAdjacentHTML('beforeend',`<button class="ot-chat-fab" aria-label="Customer support">◉<span class="ot-chat-badge">0</span></button>
 <section class="ot-chat" aria-label="OptiTrade support chat"><header class="ot-chat-head"><span class="ot-support-dot"></span><div><b>OptiTrade Support</b><small>Quick answers • type your own question anytime</small></div><button class="ot-chat-close">×</button></header><div class="ot-chat-body"><div class="muted">Loading conversation…</div></div><form class="ot-chat-compose"><textarea rows="1" maxlength="2000" placeholder="Ask anything about your OptiTrade account…"></textarea><button title="Send">➤</button></form></section>`);
 const fab=document.querySelector('.ot-chat-fab'), box=document.querySelector('.ot-chat'), close=document.querySelector('.ot-chat-close');
 fab.onclick=()=>{chatOpen=!chatOpen;box.classList.toggle('open',chatOpen);if(chatOpen)loadThread(true)};
 close.onclick=()=>{chatOpen=false;box.classList.remove('open')};
 document.querySelector('.ot-chat-compose').onsubmit=async e=>{e.preventDefault();let ta=e.currentTarget.querySelector('textarea'),body=ta.value.trim();if(!body)return;ta.value='';let r=await fetch('/api/support/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({body})});if(r.ok)loadThread(true)};
}
function quickHelpHtml(faqs,answeredCount,totalFaqs){
 if(Array.isArray(faqs)&&faqs.length){
   const previewCount=3;
   const visibleFaqs=faqs.slice(0,previewCount);
   const extraFaqs=faqs.slice(previewCount);
   const buttonHtml=f=>`<button type="button" class="ot-quick-btn${Number(f.answered)?' viewed':''}" data-faq-id="${Number(f.id)}" data-faq-scope="${esc(f.scope||'global')}">${esc(f.question)}<span>${Number(f.answered)?'↻':'›'}</span></button>`;
   const firstThree=visibleFaqs.map(buttonHtml).join('');
   const extras=extraFaqs.map(buttonHtml).join('');
   const dropdown=extraFaqs.length?`
     <button type="button" class="ot-quick-more${quickHelpExpanded?' open':''}" data-quick-toggle aria-expanded="${quickHelpExpanded?'true':'false'}">
       <span><b>${quickHelpExpanded?'Hide extra questions':'See more questions'}</b><small>${quickHelpExpanded?'Tap to close':`${extraFaqs.length} more available`}</small></span>
       <i>⌄</i>
     </button>
     <div class="ot-quick-more-list" ${quickHelpExpanded?'':'hidden'}>${extras}</div>`:'';
   return `<section class="ot-quick-help${quickHelpExpanded?' expanded':''}">
     <div class="ot-quick-title"><b>How can I help?</b><small>Choose one of the 3 quick questions below or open See more questions.</small></div>
     <div class="ot-quick-list">${firstThree}</div>
     ${dropdown}
     ${answeredCount?`<small class="ot-quick-progress">${answeredCount} quick answer${answeredCount===1?'':'s'} viewed • ${Math.max(0,totalFaqs-answeredCount)} remaining</small>`:''}
   </section>`;
 }
 return '';
}
function compactWelcomeHtml(welcome){
 if(!welcome?.body)return '';
 const body=String(welcome.body||'').trim();
 return `<section class="ot-support-welcome${welcomeExpanded?' expanded':''}">
   <div class="ot-support-welcome-head"><div><b>${esc(welcome.title||'Welcome to OptiTrade Support')}</b><small>Quick guidance is always available here.</small></div><button type="button" data-welcome-toggle>${welcomeExpanded?'Hide':'View welcome'}</button></div>
   <div class="ot-support-welcome-body">${esc(body)}</div>
 </section>`;
}
function renderMessages(msgs,faqs=[],answeredCount=0,totalFaqs=0,welcome=null){
 const body=document.querySelector('.ot-chat-body'); if(!body)return;
 const messages=msgs.map(m=>`<div class="ot-msg ${m.sender_role==='user'?'user':'support'} ${m.kind==='faq_answer'?'quick-answer':''}">${m.kind==='faq_answer'?'<small class="ot-auto-label">Quick answer</small>':''}${esc(m.body)}${m.kind==='welcome'?`<div class="ot-welcome-actions"><a href="/profile.html">Complete Profile</a><a href="/markets.html">Explore Markets</a><a href="/trade.html">Start Trading</a></div>`:''}<time>${new Date((m.created_at||'').replace(' ','T')+'Z').toLocaleString()}</time></div>`).join('');
 body.innerHTML=messages+compactWelcomeHtml(welcome)+quickHelpHtml(faqs,answeredCount,totalFaqs);
 const welcomeToggle=body.querySelector('[data-welcome-toggle]');
 if(welcomeToggle)welcomeToggle.onclick=()=>{
   welcomeExpanded=!welcomeExpanded;
   renderMessages(msgs,faqs,answeredCount,totalFaqs,welcome);
 };
 const quickToggle=body.querySelector('[data-quick-toggle]');
 if(quickToggle)quickToggle.onclick=()=>{
   quickHelpExpanded=!quickHelpExpanded;
   renderMessages(msgs,faqs,answeredCount,totalFaqs,welcome);
   const panel=body.querySelector('.ot-quick-more-list');
   if(panel&&!panel.hidden)panel.scrollIntoView({block:'nearest',behavior:'smooth'});
 };
 body.querySelectorAll('[data-faq-id]').forEach(btn=>btn.onclick=async()=>{
   const id=Number(btn.dataset.faqId),scope=btn.dataset.faqScope==='admin'?'admin':'global';if(!id)return;
   btn.disabled=true;const original=btn.innerHTML;btn.innerHTML='Getting answer…';
   try{
     const r=await fetch('/api/support/faq/'+scope+'/'+id,{method:'POST'});
     const d=await r.json().catch(()=>({}));
     if(!r.ok)throw new Error(d.error||'Could not load that answer.');
     quickHelpExpanded=false;
     await loadThread(true);
   }catch(e){btn.disabled=false;btn.innerHTML=original;appAlert(e.message)}
 });
 body.scrollTop=body.scrollHeight;
}
async function loadThread(force=false){
 try{
   let r=await fetch(chatOpen?'/api/support/thread':'/api/support/unread');if(!r.ok)return;
   if(chatOpen){
     let d=await r.json();
     const state=[d.messages.map(x=>x.id).join(','),(d.faqs||[]).map(x=>(x.scope||'global')+':'+x.id+':'+Number(x.answered||0)).join(','),d.answeredCount,d.totalFaqs,d.faqScope||'global',d.welcome?.body||''].join('|');
     if(force||state!==lastState){lastState=state;renderMessages(d.messages,d.faqs||[],Number(d.answeredCount||0),Number(d.totalFaqs||0),d.welcome||null)}
     document.querySelector('.ot-chat-badge').style.display='none';
   }else{
     let d=await r.json(),b=document.querySelector('.ot-chat-badge');b.textContent=d.unread;b.style.display=d.unread?'block':'none';
   }
 }catch(e){}
}
async function init(){
 me=await getMe();if(!me)return;addProfile(me);addChat();await loadThread();
 if(location.pathname.endsWith('/dashboard.html')||location.pathname==='/'){
   try{let r=await fetch('/api/support/unread');let d=await r.json();if(d.unread>0){setTimeout(()=>{document.querySelector('.ot-chat-fab')?.click()},1200)}}catch(e){}
 }
 poll=setInterval(()=>loadThread(false),2000);
}
document.addEventListener('DOMContentLoaded',init);
})();