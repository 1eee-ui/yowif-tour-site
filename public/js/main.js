(function(){
var d=document,reduce=matchMedia('(prefers-reduced-motion:reduce)').matches;
function $(s,r){return (r||d).querySelector(s)}
function $$(s,r){return [].slice.call((r||d).querySelectorAll(s))}

// 1. burger menu (phones)
var nav=$('nav'),bg=$('.burger');
if(bg)bg.onclick=function(){nav.classList.toggle('open');bg.setAttribute('aria-expanded',nav.classList.contains('open'))};

// 2. big titles: letters fly in from the sides (hover = replay)
function split(el){
  var s=el.textContent;el.textContent='';
  [].forEach.call(s,function(c,i){var e=d.createElement('span');e.textContent=c===' '?'\u00a0':c;e.style.animationDelay=(i*140)+'ms';e.style.setProperty('--dir',i%2?1:-1);el.appendChild(e)});
  var busy=false;
  el.addEventListener('mouseenter',function(){if(busy)return;busy=true;var sp=$$('span',el);sp.forEach(function(x){x.style.animation='none'});void el.offsetWidth;sp.forEach(function(x){x.style.animation=''});setTimeout(function(){busy=false},2200)});
}
if(!reduce)$$('.title,.page-h').forEach(split);

// 3. counting numbers
function run(fn,dur){var st=null;function f(x){if(!st)st=x;var p=Math.min((x-st)/dur,1);fn(1-Math.pow(1-p,3));if(p<1)requestAnimationFrame(f)}requestAnimationFrame(f)}
function pad(n){return n<10?'0'+n:''+n}
var dt=$('.date');
if(dt&&!reduce){dt.textContent='00.00';setTimeout(function(){run(function(e){dt.textContent=pad(Math.round(13*e))+'.'+pad(Math.round(11*e))},1500)},1300)}
function count(el){var b=$('b',el);if(!b||reduce)return;var to=parseInt(b.textContent,10),suf=b.textContent.replace(/[0-9]/g,'');run(function(e){b.textContent=Math.round(to*e)+suf},1400)}

// 4. reveal on scroll
var els=[];
[['h2',0],['.about p',1],['.stat',1],['.tour li',1],['.member',1],['.track',1],['.lead',0],['.cta',0],['footer',0]].forEach(function(g){
  $$(g[0]).forEach(function(el,i){el.classList.add('rv');el.style.setProperty('--i',g[1]?Math.min(i,6):0);els.push(el)})});
if('IntersectionObserver' in window){
  var io=new IntersectionObserver(function(en){en.forEach(function(x){if(x.isIntersecting){x.target.classList.add('in');if(x.target.classList.contains('stat'))count(x.target);io.unobserve(x.target)}})},{threshold:.15});
  els.forEach(function(el){io.observe(el)});
}else{els.forEach(function(el){el.classList.add('in')})}

// 5. "Add to calendar" (.ics file) on every tour row
function ics(city,date){
  var s=date.replace(/-/g,'');
  var t='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:yowif-'+s+'@yowif\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:'+s+'T190000\r\nDTEND:'+s+'T230000\r\nSUMMARY:YoWif live in '+city+'\r\nEND:VEVENT\r\nEND:VCALENDAR';
  var a=d.createElement('a');a.href=URL.createObjectURL(new Blob([t],{type:'text/calendar'}));a.download='yowif-'+date+'.ics';a.click();
}
window.yowifIcs=ics; // used by checkout.js
$$('.tour li[data-date]').forEach(function(li){
  var b=d.createElement('button');b.className='rem';b.type='button';b.textContent='Add to calendar';
  b.onclick=function(){ics($('.city',li).textContent,li.dataset.date)};
  li.appendChild(b);
});

// 6. tour search filter
var q=$('#q');
if(q)q.addEventListener('input',function(){
  var v=q.value.trim().toLowerCase(),n=0;
  $$('.tour li').forEach(function(li){var ok=li.textContent.toLowerCase().indexOf(v)>-1;li.style.display=ok?'':'none';if(ok)n++});
  $('#empty').style.display=n?'none':'block';
});

// 7. contact form -> real server, POST /api/contact
var f=$('#contact');
if(f)f.addEventListener('submit',function(e){
  e.preventDefault();
  var m=$('#msg'),name=f.name.value.trim(),mail=f.email.value.trim(),txt=f.message.value.trim();
  if(!name||!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)||txt.length<5){m.className='msg err';m.textContent='Please fill in your name, a valid email and a message.';return}
  var btn=f.querySelector('.form-btn');btn.disabled=true;
  fetch('/api/contact',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,email:mail,topic:f.topic.value,message:txt})})
    .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})})
    .then(function(res){
      btn.disabled=false;
      if(!res.ok){m.className='msg err';m.textContent=res.j.error||'Something went wrong. Please try again.';return}
      m.className='msg';m.textContent='Thanks, '+name+'! Your message has been sent.';f.reset();
    })
    .catch(function(){btn.disabled=false;m.className='msg err';m.textContent='Could not reach the server. Is it running?'});
});

// 8. newsletter form -> real server, POST /api/subscribe
var nf=$('#newsletter');
if(nf)nf.addEventListener('submit',function(e){
  e.preventDefault();
  var m=$('#nmsg'),mail=nf.email.value.trim();
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)){m.className='msg err';m.textContent='Please enter a valid email.';return}
  var btn=nf.querySelector('.form-btn');btn.disabled=true;
  fetch('/api/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:mail})})
    .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})})
    .then(function(res){
      btn.disabled=false;
      if(!res.ok){m.className='msg err';m.textContent=res.j.error||'Something went wrong.';return}
      m.className='msg';m.textContent='Subscribed! See you at the show.';nf.reset();
    })
    .catch(function(){btn.disabled=false;m.className='msg err';m.textContent='Could not reach the server. Is it running?'});
});
})();
