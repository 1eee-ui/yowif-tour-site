// Demo checkout. Flow:
// 1. read ?date=... from the address bar
// 2. load the tour from the server (GET /api/tour) and find that show
// 3. the user picks a quantity and fills the form
// 4. POST /api/orders sends ONLY date, qty, name, email.
//    Card fields are just for looks and are never sent anywhere.
// 5. the server checks everything, calculates the total and returns the order
(function(){
var d=document;
function $(s){return d.querySelector(s)}
var MAX=6;
var date=new URLSearchParams(location.search).get('date');
var show=null;
var f=$('#order'),m=$('#omsg'),payBtn=$('#pay');

function dm(iso){var p=iso.split('-');return p[2]+'.'+p[1]}
function euro(n){return '€'+n}

function update(){
  var q=+f.qty.value;
  $('#s-qty').textContent=q;
  $('#s-total').textContent=euro(show.price*q);
  payBtn.textContent='Pay '+euro(show.price*q);
}

fetch('/api/tour').then(function(r){return r.json()}).then(function(tour){
  show=tour.filter(function(t){return t.date===date})[0];
  if(show&&typeof show.price!=='number'){
    // the server is running old code without prices
    $('#notfound').textContent='Prices are not available. Restart the server (Ctrl+C, then npm start) and reload this page.';
    $('#notfound').hidden=false;return;
  }
  if(!show||show.soldOut){
    $('#notfound').innerHTML=(show?'Sorry, '+show.city+' is sold out. ':'Show not found. ')+'<a class="more" style="margin:0" href="tour.html">Pick another date</a>';
    $('#notfound').hidden=false;return;
  }
  $('#s-date').textContent=dm(show.date);
  $('#s-city').textContent=show.city;
  $('#s-venue').textContent=show.venue+', '+show.country;
  $('#s-price').textContent=euro(show.price);
  $('#checkout').hidden=false;
  update();
}).catch(function(){
  $('#notfound').textContent='Could not reach the server. Open the site through http://localhost:3000 (npm start).';
  $('#notfound').hidden=false;
});

// quantity - / +
[].forEach.call(d.querySelectorAll('.qty button'),function(b){
  b.onclick=function(){
    var q=Math.min(MAX,Math.max(1,+f.qty.value+ +b.dataset.step));
    f.qty.value=q;update();
  };
});

// card number: "4242424242424242" -> "4242 4242 4242 4242"
f.card.addEventListener('input',function(){
  var v=f.card.value.replace(/\D/g,'').slice(0,16);
  f.card.value=v.replace(/(.{4})(?=.)/g,'$1 ');
});
// expiry: "1228" -> "12/28"
f.exp.addEventListener('input',function(){
  var v=f.exp.value.replace(/\D/g,'').slice(0,4);
  f.exp.value=v.length>2?v.slice(0,2)+'/'+v.slice(2):v;
});
f.cvc.addEventListener('input',function(){f.cvc.value=f.cvc.value.replace(/\D/g,'').slice(0,3)});

function err(t){m.className='msg err';m.textContent=t}

f.addEventListener('submit',function(e){
  e.preventDefault();
  var name=f.name.value.trim(),mail=f.email.value.trim();
  if(!name)return err('Please enter your name.');
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail))return err('Please enter a valid email.');
  if(f.card.value.replace(/\s/g,'').length!==16)return err('Card number must have 16 digits (demo: 4242 4242 4242 4242).');
  var ex=f.exp.value.split('/');
  if(ex.length!==2||+ex[0]<1||+ex[0]>12||ex[1].length!==2)return err('Expiry must look like MM/YY.');
  if(f.cvc.value.length!==3)return err('CVC must have 3 digits.');

  payBtn.disabled=true;payBtn.textContent='Processing...';m.textContent='';
  fetch('/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({date:show.date,qty:+f.qty.value,name:name,email:mail})})
    .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})})
    .then(function(res){
      if(!res.ok){payBtn.disabled=false;update();return err(res.j.error||'Something went wrong.')}
      showTicket(res.j.order);
    })
    .catch(function(){payBtn.disabled=false;update();err('Could not reach the server. Is it running?')});
});

function showTicket(o){
  $('#t-city').textContent=o.city;
  $('#t-venue').textContent=o.venue;
  $('#t-date').textContent=dm(o.date)+'.'+o.date.slice(0,4);
  $('#t-qty').textContent=o.qty;
  $('#t-total').textContent=euro(o.total);
  $('#t-name').textContent=o.name+' · '+o.email;
  $('#t-code').textContent=o.code;
  $('#t-cal').onclick=function(){if(window.yowifIcs)window.yowifIcs(o.city,o.date)};
  $('#checkout').hidden=true;
  $('.demo-note').hidden=true;
  $('#ticket').hidden=false;
  $('#t-after').hidden=false;
  window.scrollTo({top:0,behavior:'smooth'});
}
})();
