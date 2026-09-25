// Checkout. Flow:
// 1. read ?date=... from the address bar, load the tour from the server
// 2. the buyer picks a quantity and fills in name and email
// 3. POST /api/orders sends ONLY date, qty, name, email
// 4. Stripe mode: the server answers with Stripe's payment page -> we go there.
//    The card is typed on Stripe's page, never on ours.
//    Demo mode (no Stripe key): the server confirms the order at once.
// 5. After paying, Stripe sends the buyer back with ?session_id=...,
//    and we ask OUR server to check with Stripe that the payment went through.
(function(){
var d=document;
function $(s){return d.querySelector(s)}
var MAX=6;
var params=new URLSearchParams(location.search);
var date=params.get('date'),sessionId=params.get('session_id');
var show=null,mode='demo';
var f=$('#order'),m=$('#omsg'),payBtn=$('#pay');

function dm(iso){var p=iso.split('-');return p[2]+'.'+p[1]}
function euro(n){return '€'+n}
function err(t){m.className='msg err';m.textContent=t}
function notFound(html){$('#notfound').innerHTML=html;$('#notfound').hidden=false}
function json(r){return r.json().then(function(j){return {ok:r.ok,j:j}})}

function update(){
  var q=+f.qty.value,sum=euro(show.price*q);
  $('#s-qty').textContent=q;
  $('#s-total').textContent=sum;
  payBtn.textContent=(mode==='demo'?'Get tickets ':'Pay ')+sum;
}

function showMode(){
  var note=$('#mode-note');
  if(mode==='demo')note.textContent='Demo mode: no payment is taken, the order is confirmed right away.';
  else if(mode==='test')note.textContent='Test payments: use card 4242 4242 4242 4242, any future date, any CVC. No real money is charged.';
  note.hidden=mode==='live';
  $('#secure-note').hidden=mode==='demo';
}

// back from Stripe
if(sessionId){
  $('#t-mail').textContent='Checking your payment...';
  fetch('/api/orders/confirm?session_id='+encodeURIComponent(sessionId)).then(json).then(function(res){
    if(!res.ok)return notFound(res.j.error+' <a class="more" style="margin:0" href="tour.html">Back to tour</a>');
    showTicket(res.j.order,res.j.emailSent);
  }).catch(function(){notFound('Could not reach the server. Please reload this page.')});
  return;
}

Promise.all([fetch('/api/tour').then(function(r){return r.json()}),fetch('/api/payment-mode').then(function(r){return r.json()})])
.then(function(r){
  var tour=r[0];mode=r[1].mode;showMode();
  show=tour.filter(function(t){return t.date===date})[0];
  if(show&&typeof show.price!=='number')return notFound('Prices are not available. Restart the server (Ctrl+C, then npm start) and reload this page.');
  if(!show||show.soldOut)return notFound((show?'Sorry, '+show.city+' is sold out. ':'Show not found. ')+'<a class="more" style="margin:0" href="tour.html">Pick another date</a>');
  $('#s-date').textContent=dm(show.date);
  $('#s-city').textContent=show.city;
  $('#s-venue').textContent=show.venue+', '+show.country;
  $('#s-price').textContent=euro(show.price);
  $('#checkout').hidden=false;
  update();
  if(params.get('cancelled'))err('Payment was cancelled. Nothing was charged, you can try again.');
}).catch(function(){
  notFound('Could not reach the server. Open the site through http://localhost:3000 (npm start).');
});

// quantity - / +
[].forEach.call(d.querySelectorAll('.qty button'),function(b){
  b.onclick=function(){
    f.qty.value=Math.min(MAX,Math.max(1,+f.qty.value+ +b.dataset.step));update();
  };
});

f.addEventListener('submit',function(e){
  e.preventDefault();
  var name=f.name.value.trim(),mail=f.email.value.trim();
  if(!name)return err('Please enter your name.');
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail))return err('Please enter a valid email.');

  payBtn.disabled=true;payBtn.textContent=mode==='demo'?'Processing...':'Opening payment...';m.textContent='';
  fetch('/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({date:show.date,qty:+f.qty.value,name:name,email:mail})})
    .then(json)
    .then(function(res){
      if(!res.ok){payBtn.disabled=false;update();return err(res.j.error||'Something went wrong.')}
      if(res.j.redirect){location.href=res.j.redirect;return}
      showTicket(res.j.order,res.j.emailSent);
    })
    .catch(function(){payBtn.disabled=false;update();err('Could not reach the server. Is it running?')});
});

function showTicket(o,sent){
  // be honest about the e-mail: only claim it was sent if the server says so
  $('#t-mail').textContent=sent===true
    ?'Thank you! Your ticket has been sent to '+o.email+'.'
    :sent===false
    ?'Thank you! We could not e-mail your ticket, so please save it or take a screenshot.'
    :'Thank you! Your order is confirmed.';
  $('#t-city').textContent=o.city;
  $('#t-venue').textContent=o.venue;
  $('#t-date').textContent=dm(o.date)+'.'+o.date.slice(0,4);
  $('#t-qty').textContent=o.qty;
  $('#t-total').textContent=euro(o.total);
  $('#t-name').textContent=o.name+' · '+o.email;
  $('#t-code').textContent=o.code;
  $('#t-cal').onclick=function(){if(window.yowifIcs)window.yowifIcs(o.city,o.date)};
  $('#checkout').hidden=true;
  $('#mode-note').hidden=true;
  $('#ticket').hidden=false;
  $('#t-after').hidden=false;
  window.scrollTo({top:0,behavior:'smooth'});
}
})();
