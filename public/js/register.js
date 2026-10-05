const callingCodes=[
['🇦🇫','+93','Afghanistan'],['🇦🇱','+355','Albania'],['🇩🇿','+213','Algeria'],['🇦🇩','+376','Andorra'],['🇦🇴','+244','Angola'],['🇦🇬','+1-268','Antigua & Barbuda'],['🇦🇷','+54','Argentina'],['🇦🇲','+374','Armenia'],['🇦🇺','+61','Australia'],['🇦🇹','+43','Austria'],['🇦🇿','+994','Azerbaijan'],['🇧🇸','+1-242','Bahamas'],['🇧🇭','+973','Bahrain'],['🇧🇩','+880','Bangladesh'],['🇧🇧','+1-246','Barbados'],['🇧🇾','+375','Belarus'],['🇧🇪','+32','Belgium'],['🇧🇿','+501','Belize'],['🇧🇯','+229','Benin'],['🇧🇹','+975','Bhutan'],['🇧🇴','+591','Bolivia'],['🇧🇦','+387','Bosnia & Herzegovina'],['🇧🇼','+267','Botswana'],['🇧🇷','+55','Brazil'],['🇧🇳','+673','Brunei'],['🇧🇬','+359','Bulgaria'],['🇧🇫','+226','Burkina Faso'],['🇧🇮','+257','Burundi'],['🇰🇭','+855','Cambodia'],['🇨🇲','+237','Cameroon'],['🇨🇦','+1','Canada'],['🇨🇻','+238','Cape Verde'],['🇨🇫','+236','Central African Republic'],['🇹🇩','+235','Chad'],['🇨🇱','+56','Chile'],['🇨🇳','+86','China'],['🇨🇴','+57','Colombia'],['🇰🇲','+269','Comoros'],['🇨🇬','+242','Congo'],['🇨🇩','+243','Congo (DRC)'],['🇨🇷','+506','Costa Rica'],['🇨🇮','+225','Côte d’Ivoire'],['🇭🇷','+385','Croatia'],['🇨🇺','+53','Cuba'],['🇨🇾','+357','Cyprus'],['🇨🇿','+420','Czechia'],['🇩🇰','+45','Denmark'],['🇩🇯','+253','Djibouti'],['🇩🇲','+1-767','Dominica'],['🇩🇴','+1-809','Dominican Republic'],['🇪🇨','+593','Ecuador'],['🇪🇬','+20','Egypt'],['🇸🇻','+503','El Salvador'],['🇬🇶','+240','Equatorial Guinea'],['🇪🇷','+291','Eritrea'],['🇪🇪','+372','Estonia'],['🇸🇿','+268','Eswatini'],['🇪🇹','+251','Ethiopia'],['🇫🇯','+679','Fiji'],['🇫🇮','+358','Finland'],['🇫🇷','+33','France'],['🇬🇦','+241','Gabon'],['🇬🇲','+220','Gambia'],['🇬🇪','+995','Georgia'],['🇩🇪','+49','Germany'],['🇬🇭','+233','Ghana'],['🇬🇷','+30','Greece'],['🇬🇩','+1-473','Grenada'],['🇬🇹','+502','Guatemala'],['🇬🇳','+224','Guinea'],['🇬🇼','+245','Guinea-Bissau'],['🇬🇾','+592','Guyana'],['🇭🇹','+509','Haiti'],['🇭🇳','+504','Honduras'],['🇭🇰','+852','Hong Kong'],['🇭🇺','+36','Hungary'],['🇮🇸','+354','Iceland'],['🇮🇳','+91','India'],['🇮🇩','+62','Indonesia'],['🇮🇷','+98','Iran'],['🇮🇶','+964','Iraq'],['🇮🇪','+353','Ireland'],['🇮🇱','+972','Israel'],['🇮🇹','+39','Italy'],['🇯🇲','+1-876','Jamaica'],['🇯🇵','+81','Japan'],['🇯🇴','+962','Jordan'],['🇰🇿','+7','Kazakhstan'],['🇰🇪','+254','Kenya'],['🇰🇮','+686','Kiribati'],['🇰🇼','+965','Kuwait'],['🇰🇬','+996','Kyrgyzstan'],['🇱🇦','+856','Laos'],['🇱🇻','+371','Latvia'],['🇱🇧','+961','Lebanon'],['🇱🇸','+266','Lesotho'],['🇱🇷','+231','Liberia'],['🇱🇾','+218','Libya'],['🇱🇮','+423','Liechtenstein'],['🇱🇹','+370','Lithuania'],['🇱🇺','+352','Luxembourg'],['🇲🇴','+853','Macao'],['🇲🇬','+261','Madagascar'],['🇲🇼','+265','Malawi'],['🇲🇾','+60','Malaysia'],['🇲🇻','+960','Maldives'],['🇲🇱','+223','Mali'],['🇲🇹','+356','Malta'],['🇲🇭','+692','Marshall Islands'],['🇲🇷','+222','Mauritania'],['🇲🇺','+230','Mauritius'],['🇲🇽','+52','Mexico'],['🇫🇲','+691','Micronesia'],['🇲🇩','+373','Moldova'],['🇲🇨','+377','Monaco'],['🇲🇳','+976','Mongolia'],['🇲🇪','+382','Montenegro'],['🇲🇦','+212','Morocco'],['🇲🇿','+258','Mozambique'],['🇲🇲','+95','Myanmar'],['🇳🇦','+264','Namibia'],['🇳🇷','+674','Nauru'],['🇳🇵','+977','Nepal'],['🇳🇱','+31','Netherlands'],['🇳🇿','+64','New Zealand'],['🇳🇮','+505','Nicaragua'],['🇳🇪','+227','Niger'],['🇳🇬','+234','Nigeria'],['🇰🇵','+850','North Korea'],['🇲🇰','+389','North Macedonia'],['🇳🇴','+47','Norway'],['🇴🇲','+968','Oman'],['🇵🇰','+92','Pakistan'],['🇵🇼','+680','Palau'],['🇵🇸','+970','Palestine'],['🇵🇦','+507','Panama'],['🇵🇬','+675','Papua New Guinea'],['🇵🇾','+595','Paraguay'],['🇵🇪','+51','Peru'],['🇵🇭','+63','Philippines'],['🇵🇱','+48','Poland'],['🇵🇹','+351','Portugal'],['🇶🇦','+974','Qatar'],['🇷🇴','+40','Romania'],['🇷🇺','+7','Russia'],['🇷🇼','+250','Rwanda'],['🇰🇳','+1-869','Saint Kitts & Nevis'],['🇱🇨','+1-758','Saint Lucia'],['🇻🇨','+1-784','Saint Vincent & Grenadines'],['🇼🇸','+685','Samoa'],['🇸🇲','+378','San Marino'],['🇸🇹','+239','São Tomé & Príncipe'],['🇸🇦','+966','Saudi Arabia'],['🇸🇳','+221','Senegal'],['🇷🇸','+381','Serbia'],['🇸🇨','+248','Seychelles'],['🇸🇱','+232','Sierra Leone'],['🇸🇬','+65','Singapore'],['🇸🇰','+421','Slovakia'],['🇸🇮','+386','Slovenia'],['🇸🇧','+677','Solomon Islands'],['🇸🇴','+252','Somalia'],['🇿🇦','+27','South Africa'],['🇰🇷','+82','South Korea'],['🇸🇸','+211','South Sudan'],['🇪🇸','+34','Spain'],['🇱🇰','+94','Sri Lanka'],['🇸🇩','+249','Sudan'],['🇸🇷','+597','Suriname'],['🇸🇪','+46','Sweden'],['🇨🇭','+41','Switzerland'],['🇸🇾','+963','Syria'],['🇹🇼','+886','Taiwan'],['🇹🇯','+992','Tajikistan'],['🇹🇿','+255','Tanzania'],['🇹🇭','+66','Thailand'],['🇹🇱','+670','Timor-Leste'],['🇹🇬','+228','Togo'],['🇹🇴','+676','Tonga'],['🇹🇹','+1-868','Trinidad & Tobago'],['🇹🇳','+216','Tunisia'],['🇹🇷','+90','Türkiye'],['🇹🇲','+993','Turkmenistan'],['🇹🇻','+688','Tuvalu'],['🇺🇬','+256','Uganda'],['🇺🇦','+380','Ukraine'],['🇦🇪','+971','United Arab Emirates'],['🇬🇧','+44','United Kingdom'],['🇺🇸','+1','United States'],['🇺🇾','+598','Uruguay'],['🇺🇿','+998','Uzbekistan'],['🇻🇺','+678','Vanuatu'],['🇻🇦','+39','Vatican City'],['🇻🇪','+58','Venezuela'],['🇻🇳','+84','Vietnam'],['🇾🇪','+967','Yemen'],['🇿🇲','+260','Zambia'],['🇿🇼','+263','Zimbabwe']];
function initModernFields(){
 const dial=$('dialCode');callingCodes.forEach(([flag,code,name])=>{const o=document.createElement('option');o.value=code;o.textContent=`${flag} ${code}`;o.title=name;if(name==='United States')o.selected=true;dial.appendChild(o)});
 for(let d=1;d<=31;d++)$('dobDay').add(new Option(String(d).padStart(2,'0'),d));
 ['January','February','March','April','May','June','July','August','September','October','November','December'].forEach((m,i)=>$('dobMonth').add(new Option(m,i+1)));
 const y=new Date().getFullYear()-18;for(let n=y;n>=1900;n--)$('dobYear').add(new Option(n,n));
 ['dobDay','dobMonth','dobYear'].forEach(id=>$(id).addEventListener('change',syncDob));
 ['dialCode','phone'].forEach(id=>$(id).addEventListener('input',syncPhonePreview));
}
function syncDob(){const d=$('dobDay').value,m=$('dobMonth').value,y=$('dobYear').value;$('dob').value=d&&m&&y?`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`:''}
function syncPhonePreview(){const n=$('phone').value.trim();$('phonePreview').textContent=n?`Full number: ${$('dialCode').value} ${n}`:'Select your country code, then enter your phone number.'}
const $=id=>document.getElementById(id), form=$('f'), msg=$('m'), emailRx=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function showRegistrationAlert(text,type='error'){
 let box=$('registrationAlert');
 if(!box){
  box=document.createElement('div');
  box.id='registrationAlert';
  box.style.cssText='position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:99999;max-width:92vw;width:520px;padding:14px 16px;border-radius:12px;font-weight:700;line-height:1.45;box-shadow:0 14px 40px rgba(0,0,0,.35);background:#101d31;color:#fff;border:1px solid #355273';
  document.body.appendChild(box);
 }
 box.style.borderColor=type==='success'?'#2da66f':'#c44b5f';
 box.style.background=type==='success'?'#0d2a20':'#30151b';
 box.textContent=text;
 box.hidden=false;
 clearTimeout(showRegistrationAlert._t);
 showRegistrationAlert._t=setTimeout(()=>{box.hidden=true},9000);
}

const ids=['username','name','email','phone','country','dob','password','confirmPassword','pin','confirmPin'];
function err(id,text){const input=$(id),el=$(id+'Error');if(el){el.textContent=text||'';el.classList.toggle('show',!!text)}const field=input?.closest('.field');if(field){field.classList.toggle('invalid',!!text);if(text)field.classList.remove('valid')}return !text}
function age(d){const b=new Date(d),n=new Date();let a=n.getFullYear()-b.getFullYear();const m=n.getMonth()-b.getMonth();if(m<0||(m===0&&n.getDate()<b.getDate()))a--;return a}
function step1(){syncPhonePreview();return [err('username',/^[A-Za-z0-9_]{3,20}$/.test($('username').value.trim())?'':'Use 3–20 letters, numbers or underscore.'),err('name',$('name').value.trim().length>=2?'':'Please enter your full name.'),err('email',emailRx.test($('email').value.trim())?'':'Please enter a valid email address.'),err('phone',/^[0-9 ()-]{6,18}$/.test($('phone').value.trim())?'':'Please enter a valid phone number.')].every(Boolean)}
function step2(){syncDob();const d=$('dob').value;return [err('country',$('country').value?'':'Please select your country.'),err('dob',d&&age(d)>=18?'':'Enter a valid date of birth. You must be 18 or older.')].every(Boolean)}
function password(){const v=$('password').value;let e=!v?'Please enter a password.':v.length<8?'Password must be at least 8 characters.':!/^[A-Z]/.test(v)?'Password must start with a capital letter.':'';err('password',e);let score=0;if(v.length>=8)score++;if(/^[A-Z]/.test(v))score++;if(/[0-9]/.test(v))score++;if(/[^A-Za-z0-9]/.test(v))score++;$('meterBar').style.width=score*25+'%';$('passwordHint').textContent=e||'Password accepted ✓';$('passwordHint').classList.toggle('accepted',!e);$('password').closest('.field').classList.toggle('valid',!e);$('meterBar').classList.toggle('accepted',!e);return !e}
function step3(){const p=password(),pinOk=/^\d{4}$/.test($('pin').value);return [p,err('confirmPassword',$('confirmPassword').value===$('password').value&&$('confirmPassword').value?'':'Passwords do not match.'),err('pin',pinOk?'':'Create a 4-digit transaction PIN.'),err('confirmPin',$('confirmPin').value===$('pin').value&&$('confirmPin').value?'':'Transaction PINs do not match.'),(()=>{const ok=$('terms').checked;$('termsError').textContent=ok?'':'You must accept the Terms and Privacy Policy.';$('termsError').classList.toggle('show',!ok);return ok})()].every(Boolean)}
function showStep(n){document.querySelectorAll('.form-step').forEach(x=>x.classList.toggle('active',+x.dataset.step===n));document.querySelectorAll('.step-dot').forEach(x=>{const d=+x.dataset.dot;x.classList.toggle('active',d===n);x.classList.toggle('done',d<n)});window.scrollTo({top:0,behavior:'smooth'})}
document.querySelectorAll('[data-next]').forEach(b=>b.onclick=()=>{const n=+b.dataset.next;if((n===2&&step1())||(n===3&&step2()))showStep(n)});document.querySelectorAll('[data-prev]').forEach(b=>b.onclick=()=>showStep(+b.dataset.prev));
$('password').addEventListener('input',password);$('confirmPassword').addEventListener('input',()=>{const ok=$('confirmPassword').value&&$('confirmPassword').value===$('password').value;err('confirmPassword',ok?'':'Passwords do not match.');$('confirmPassword').closest('.field').classList.toggle('valid',!!ok)});document.querySelectorAll('[data-toggle]').forEach(b=>b.onclick=()=>{const i=$(b.dataset.toggle);i.type=i.type==='password'?'text':'password'});

['pin','confirmPin'].forEach(id=>$(id).addEventListener('input',()=>{$(id).value=$(id).value.replace(/\D/g,'').slice(0,4);if(id==='pin')err('pin',$(id).value&&!/^\d{4}$/.test($(id).value)?'Use exactly 4 digits.':'');if(id==='confirmPin'&&$(id).value)err('confirmPin',$(id).value===$('pin').value?'':'Transaction PINs do not match.')}));


let registrationVerifyEmail='',registrationOtpExpiryTimer,registrationResendTimer;
const registerOtpModal=$('registerOtpModal'),registerOtpEmail=$('registerOtpEmail'),registerOtpForm=$('registerOtpForm'),
 registerOtpInputs=[...document.querySelectorAll('#registerOtpInputs input')],registerOtpError=$('registerOtpError'),
 registerOtpVerify=$('registerOtpVerify'),registerOtpResend=$('registerOtpResend'),registerOtpStatus=$('registerOtpStatus');

function clearRegisterOtpError(){registerOtpError.textContent='';registerOtpError.classList.remove('show');registerOtpInputs.forEach(x=>x.classList.remove('invalid'))}
function showRegisterOtpError(t){registerOtpError.textContent=t;registerOtpError.classList.add('show');registerOtpInputs.forEach(x=>x.classList.add('invalid'))}
function startRegistrationExpiry(){
 clearInterval(registrationOtpExpiryTimer);let left=600;
 registrationOtpExpiryTimer=setInterval(()=>{left--;const m=Math.max(0,Math.floor(left/60)),s=Math.max(0,left%60);$('registerOtpTimer').textContent=left>0?`Code expires in ${m}:${String(s).padStart(2,'0')}`:'Code expired — request a new one.';if(left<=0)clearInterval(registrationOtpExpiryTimer)},1000);
}
function startRegistrationResend(seconds=60){
 clearInterval(registrationResendTimer);let left=Math.max(1,Number(seconds)||60);registerOtpResend.disabled=true;
 const draw=()=>{registerOtpResend.textContent=`Resend in ${left}s`;if(left--<=0){clearInterval(registrationResendTimer);registerOtpResend.disabled=false;registerOtpResend.textContent='Resend code'}};
 draw();registrationResendTimer=setInterval(draw,1000);
}
function openRegistrationOtp(email,{warning='',cooldown=60}={}){
 registrationVerifyEmail=String(email||'').trim().toLowerCase();
 localStorage.verifyEmail=registrationVerifyEmail;sessionStorage.verifyEmail=registrationVerifyEmail;
 sessionStorage.setItem('verifyCooldown',String(Number(cooldown)||60));
 if(warning)sessionStorage.setItem('verifyNotice',warning);
 // Fallback to the dedicated verification page if an older cached register.html
 // is missing the new modal. This prevents registration from silently reloading.
 if(!registerOtpModal||!registerOtpEmail||!registerOtpForm||registerOtpInputs.length!==6){
   location.assign('/verify.html?email='+encodeURIComponent(registrationVerifyEmail));
   return;
 }
 registerOtpEmail.textContent=registrationVerifyEmail;
 registerOtpInputs.forEach(x=>x.value='');clearRegisterOtpError();
 registerOtpStatus.textContent=warning||'Verification code requested. Check your email.';
 registerOtpModal.hidden=false;startRegistrationExpiry();startRegistrationResend(cooldown);
 setTimeout(()=>registerOtpInputs[0]?.focus(),30);
}
registerOtpInputs.forEach((input,i)=>{
 input.addEventListener('input',()=>{input.value=input.value.replace(/\D/g,'').slice(0,1);clearRegisterOtpError();if(input.value&&i<5)registerOtpInputs[i+1].focus()});
 input.addEventListener('keydown',e=>{if(e.key==='Backspace'&&!input.value&&i>0)registerOtpInputs[i-1].focus()});
 input.addEventListener('paste',e=>{e.preventDefault();const v=e.clipboardData.getData('text').replace(/\D/g,'').slice(0,6);v.split('').forEach((n,j)=>registerOtpInputs[j].value=n);registerOtpInputs[Math.min(v.length,5)]?.focus()});
});
if($('closeRegisterOtp'))$('closeRegisterOtp').onclick=()=>{if(registerOtpModal)registerOtpModal.hidden=true};
if(registerOtpModal)registerOtpModal.onclick=e=>{if(e.target===registerOtpModal)registerOtpModal.hidden=true};
if(registerOtpForm)registerOtpForm.onsubmit=async e=>{
 e.preventDefault();clearRegisterOtpError();const code=registerOtpInputs.map(x=>x.value).join('');
 if(code.length!==6)return showRegisterOtpError('Enter all 6 digits.');
 registerOtpVerify.disabled=true;const original=registerOtpVerify.innerHTML;registerOtpVerify.innerHTML='Verifying…';
 try{
  const r=await fetch('/api/auth/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:registrationVerifyEmail,code})});
  const d=await r.json();if(!r.ok)return showRegisterOtpError(d.error||'Verification failed.');
  sessionStorage.removeItem('verifyEmail');localStorage.removeItem('verifyEmail');
  location.assign(['admin','super_admin','sub_admin'].includes(d.role)?'/admin/dashboard.html':'/dashboard.html');
 }catch{showRegisterOtpError('Could not reach OptiTrade. Please try again.')}
 finally{registerOtpVerify.disabled=false;registerOtpVerify.innerHTML=original}
};
if(registerOtpResend)registerOtpResend.onclick=async()=>{
 clearRegisterOtpError();registerOtpStatus.textContent='Requesting a new code…';registerOtpResend.disabled=true;
 try{
  const r=await fetch('/api/auth/resend',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:registrationVerifyEmail})});
  const d=await r.json();
  if(!r.ok){showRegisterOtpError(d.error||'Could not resend code.');startRegistrationResend(d.retryAfter||60);return}
  registerOtpStatus.textContent='A new code was requested. Check Inbox, Spam or Junk.';startRegistrationExpiry();startRegistrationResend(d.cooldown||60);
 }catch{showRegisterOtpError('Could not reach OptiTrade.');startRegistrationResend(60)}
};

async function submitRegistration(){
 msg.textContent='';
 // Validate every registration layer before talking to the server.
 if(!step1()){showStep(1);showRegistrationAlert('Please correct the highlighted Personal Details fields before creating the account.');return}
 if(!step2()){showStep(2);showRegistrationAlert('Please correct the highlighted Regional Profile fields before creating the account.');return}
 if(!step3()){showStep(3);showRegistrationAlert('Please correct the highlighted Account Security fields before creating the account.');return}

 const body={
  username:$('username').value.trim(),
  name:$('name').value.trim(),
  email:$('email').value.trim(),
  phone:($('dialCode').value+' '+$('phone').value.trim()).trim(),
  country:$('country').value,
  currency:$('currency').value,
  dob:$('dob').value,
  password:$('password').value,
  confirmPassword:$('confirmPassword').value,
  pin:$('pin').value,
  confirmPin:$('confirmPin').value,
  termsAccepted:$('terms').checked,
  referral:new URLSearchParams(location.search).get('ref')||''
 };
 const btn=$('submitBtn'),original=btn.innerHTML;
 btn.disabled=true;btn.innerHTML='Creating account…';
 showRegistrationAlert('Submitting your registration…','success');

 try{
  const r=await fetch('/api/auth/register',{
   method:'POST',
   headers:{'Content-Type':'application/json','Cache-Control':'no-cache','X-OptiTrade-Client':'register-v2.11.6'},
   cache:'no-store',
   body:JSON.stringify(body)
  });
  const raw=await r.text();
  let d={};
  try{d=raw?JSON.parse(raw):{}}catch{d={error:r.ok?'Unexpected server response.':'Registration request could not be completed.'}}

  if(d.needsVerification || (r.ok&&d.ok===true)){
   const verifyEmail=String(d.email||body.email).trim().toLowerCase();
   localStorage.verifyEmail=verifyEmail;
   sessionStorage.verifyEmail=verifyEmail;
   sessionStorage.setItem('verifyCooldown',String(Number(d.retryAfter||d.cooldown||60)));
   const notice=d.warning||(d.emailQueued===false
     ?'Your account was created, but the verification email was not accepted. Use Resend on the next page after the countdown.'
     :'Verification code sent. Check Inbox, Spam or Junk.');
   sessionStorage.setItem('verifyNotice',notice);
   showRegistrationAlert(notice,d.emailQueued===false?'error':'success');
   // Use the dedicated verification page so registration can never appear to "jump back".
   setTimeout(()=>location.assign('/verify.html?email='+encodeURIComponent(verifyEmail)),350);
   return;
  }

  const reason=d.error||'Could not create account.';
  showRegistrationAlert(reason);
  msg.textContent=reason;

  if(d.alreadyRegistered){
   msg.innerHTML='This email is already registered. <a href="/login.html">Log in instead</a>.';
   return;
  }
  if(d.field&&$(d.field+'Error')){
   err(d.field,reason);
   if(['username','name','email','phone'].includes(d.field))showStep(1);
   else if(['country','currency','dob'].includes(d.field))showStep(2);
   else showStep(3);
  }
 }catch(e){
  console.error('[REGISTER]',e);
  const reason='Could not connect to OptiTrade. Check that the server/tunnel is running, then try again.';
  msg.textContent=reason;
  showRegistrationAlert(reason);
 }finally{
  btn.disabled=false;
  btn.innerHTML=original;
 }
}
form.onsubmit=e=>{e.preventDefault();submitRegistration()};
$('submitBtn').onclick=submitRegistration;

initModernFields();syncPhonePreview();
