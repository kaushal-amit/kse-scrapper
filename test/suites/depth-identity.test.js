// The exact failure from the video: the search box updates before the book does.
process.env.AWSAT_MODE='client';
const {chromium}=require('playwright');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

const PAGE=`<html><body>
<div class="widget_new">
  <div class="quote-page-second-row-wght" id="book">
    <div class="pos-rel table-row-up"><span class="cursor-pointer up-fore-color">175</span><span class="h-right">5000</span></div>
    <div class="pos-rel table-row-down"><span class="cursor-pointer down-fore-color">177</span><span class="h-right">3000</span></div>
  </div>
  <span class="symbol-fore-color" id="label">ABAR - 101</span>
</div>
<script>
// Reproduce the terminal's behaviour: the LABEL updates immediately, the BOOK
// repaints ~700ms later, briefly empty in between.
window.selectSymbol = function(sym, code, bid, offer){
  document.getElementById('label').textContent = sym + ' - ' + code;
  setTimeout(function(){ document.getElementById('book').innerHTML = ''; }, 200);
  setTimeout(function(){
    document.getElementById('book').innerHTML =
      '<div class="pos-rel table-row-up"><span class="cursor-pointer up-fore-color">'+bid+'</span><span class="h-right">1111</span></div>'+
      '<div class="pos-rel table-row-down"><span class="cursor-pointer down-fore-color">'+offer+'</span><span class="h-right">2222</span></div>';
  }, 700);
};
</script></body></html>`;

(async()=>{
  const b=await chromium.launch({headless:true,executablePath:'/tmp/chrtest/bin/chromium',timeout:90000,
    args:['--no-sandbox','--no-zygote','--single-process','--disable-gpu','--disable-software-rasterizer']});
  const page=await(await b.newContext()).newPage();
  await page.setContent(PAGE);

  // The verification logic, verbatim from the userscript.
  const probe = async (wanted, waitMs) => page.evaluate(async (args) => {
    function ladderSymbol(){
      var scope=document.querySelector('.quote-page-second-row-wght');
      var root=scope?(scope.closest('.widget_new')||scope.parentElement):null;
      if(!root) return null;
      var el=root.querySelector('.symbol-fore-color');
      if(el){var t=(el.textContent||'').trim(); if(t) return t.split(/\s*-\s*/)[0].trim().toUpperCase();}
      return null;
    }
    function readLadder(){
      var scope=document.querySelector('.quote-page-second-row-wght');
      if(!scope) return [];
      var bids=[],offers=[];
      scope.querySelectorAll('.pos-rel').forEach(function(r){
        var pe=r.querySelector('.cursor-pointer'); if(!pe) return;
        var price=parseFloat((pe.textContent||'').trim()); if(isNaN(price)) return;
        var q=r.querySelector('.h-right');
        var cls=(pe.className||'')+' '+(r.className||'');
        var qty=q?parseFloat((q.textContent||'').trim()):null;
        if(/up-fore-color/.test(cls)) bids.push({price:price,qty:qty});
        else if(/down-fore-color/.test(cls)) offers.push({price:price,qty:qty});
      });
      var nn=Math.max(bids.length,offers.length),out=[];
      for(var i=0;i<nn;i++) out.push({level:i+1,
        bid:bids[i]?bids[i].price:null,bidQty:bids[i]?bids[i].qty:null,
        offer:offers[i]?offers[i].price:null,offerQty:offers[i]?offers[i].qty:null});
      return out;
    }
    return await new Promise(function(resolve){
      var waited=0,stableFor=0,lastSeen=null;
      var poll=setInterval(function(){
        waited+=120;
        var shown=ladderSymbol(), levels=readLadder(), snap=JSON.stringify(levels);
        var right=shown&&shown===args.wanted;
        var stable=snap===lastSeen; lastSeen=snap;
        if(right&&levels.length&&stable) stableFor++; else stableFor=0;
        if(stableFor<2&&waited<args.waitMs) return;
        clearInterval(poll);
        if(stableFor<2) return resolve({ok:false,shown:shown,levels:levels});
        resolve({ok:true,shown:ladderSymbol(),levels:readLadder()});
      },120);
    });
  }, {wanted:wanted, waitMs:waitMs});

  // Switch to ZAIN: label flips instantly, book arrives at ~700ms.
  await page.evaluate(()=>window.selectSymbol('ZAIN','205',540,542));
  const r=await probe('ZAIN',2500);
  ck('waited for the BOOK, not the label', r.ok===true, r);
  ck('label matches the requested symbol', r.shown==='ZAIN', r.shown);
  ck('got ZAIN prices, not the old ABAR ones', r.levels[0]&&r.levels[0].bid===540, r.levels[0]);
  ck('not the stale 175/177', !(r.levels[0]&&r.levels[0].bid===175), r.levels[0]);
  ck('quantities are the new book\'s', r.levels[0]&&r.levels[0].bidQty===1111, r.levels[0]);

  // Ask for a symbol the widget will never show -> must REFUSE, not post stale.
  const wrong=await probe('NBK',900);
  ck('refuses when the widget shows another symbol', wrong.ok===false, wrong.shown);
  ck('reports what it actually saw', wrong.shown==='ZAIN', wrong.shown);

  // Read DURING the empty repaint window -> must not accept an empty book.
  await page.evaluate(()=>window.selectSymbol('KFH','108',776,777));
  const early=await probe('KFH',350);   // gives up before the book lands
  ck('does not accept a half-drawn ladder', early.ok===false, early);

  // And with enough time it succeeds.
  const late=await probe('KFH',2500);
  ck('succeeds once the book settles', late.ok===true && late.levels[0].bid===776, late.levels&&late.levels[0]);

  console.log(`\ndepth identity: ${p}/${n}`);
  await b.close(); process.exit(p===n?0:1);
})().catch(e=>{console.error('CRASH:',e.message);process.exit(1)});
