// Step 2: the duplicate classes, the resolution rule, and stable pagination.
process.env.AWSAT_MODE='client';
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

const DATA_FIELDS=['last_price','last_qty','chg','pct_chg','volume','bid','bid_qty',
  'offer','offer_qty','trades','open_price','high_price','low_price',
  'intrinsic_value','session','nms','code','description'];
const fingerprint=(r)=>DATA_FIELDS.map(f=>(r[f]==null?'':String(r[f]))).join('\u0001');
const richness=(r)=>DATA_FIELDS.filter(f=>r[f]!=null&&r[f]!=='').length;
// richest -> highest volume -> last id
function resolve(rows){
  const rank=(r)=>[richness(r), r.volume==null?-1:Number(r.volume), Number(r.id??0)];
  let best=rows[0];
  for(let i=1;i<rows.length;i++){
    const a=rank(rows[i]), b=rank(best);
    if(a[0]>b[0] || (a[0]===b[0]&&a[1]>b[1]) || (a[0]===b[0]&&a[1]===b[1]&&a[2]>b[2])) best=rows[i];
  }
  return best;}
const classify=(rows)=>new Set(rows.map(fingerprint)).size===1?'identical':'conflicting';

// ── the two classes must be told apart ──
const same=[{last_price:100,volume:5,id:1},{last_price:100,volume:5,id:2}];
ck('identical duplicates classified', classify(same)==='identical');
const diff=[{last_price:100,volume:5,id:1},{last_price:901,volume:9999,id:2}];
ck('conflicting duplicates classified', classify(diff)==='conflicting');
ck('a null and an empty string are the same absence',
   classify([{last_price:null,id:1},{last_price:undefined,id:2}])==='identical');

// ── the resolution rule ──
const partial={last_price:100,id:1};                       // price only
const full={last_price:100,volume:5000,bid:99,offer:101,trades:7,id:2};
ck('RICHEST wins over a partial capture', resolve([full,partial]).id===2, resolve([full,partial]));
ck('order does not change that', resolve([partial,full]).id===2);
// THE REAL CONFLICT SHAPE — AAYAN 27 Jul 10:06:21, both rows complete.
const A={last_price:288,bid:287,bid_qty:175000,trades:19,volume:264251,id:1};
const B={last_price:287,bid:286,bid_qty:402100,trades:22,volume:439251,id:2};
ck('equal richness -> HIGHER VOLUME wins, not last id',
   resolve([A,B]).id===2, resolve([A,B]));
ck('and it wins regardless of arrival order',
   resolve([B,A]).id===2, resolve([B,A]));
// The discriminating test: the later observation has the LOWER id.
const Aлate={...A,id:9};
ck('a higher id does NOT beat a higher volume',
   resolve([Aлate,B]).id===2, resolve([Aлate,B]));
ck('the kept row always has the higher volume',
   Number(resolve([Aлate,B]).volume)===439251, resolve([Aлate,B]).volume);
ck('equal volume falls through to last id',
   resolve([{last_price:1,volume:500,id:1},{last_price:2,volume:500,id:2}]).id===2);
ck('a missing volume loses to a present one',
   resolve([{last_price:1,volume:null,id:9},{last_price:2,volume:100,id:1}]).id===1);
ck('a three-way group resolves to the richest',
   resolve([partial,{last_price:100,volume:1,id:3},full]).id===2);

// ── the rule is stated, not accidental ──
ck('a later but POORER row does not win',
   resolve([full,{last_price:999,id:9}]).id===2, resolve([full,{last_price:999,id:9}]));

// ── stable pagination ──
//
// The bug: ORDER BY created_at, symbol over duplicates leaves their order
// undefined, and OFFSET paging over an unstable sort can skip or repeat rows.
function page(rows, sortKeys, size){
  const seen=[];
  for(let off=0;off<rows.length;off+=size){
    // Postgres may order ties differently per page; model the worst case.
    const sorted=[...rows].sort((a,b)=>{
      for(const k of sortKeys){ if(a[k]<b[k])return -1; if(a[k]>b[k])return 1; }
      return sortKeys.includes('id') ? 0 : (Math.random()-0.5);
    });
    seen.push(...sorted.slice(off,off+size));
  }
  return seen;
}
const dupes=[];
for(let i=0;i<20;i++) dupes.push({created_at:'T1',symbol:'S',id:i,v:i});

const unstable=page(dupes,['created_at','symbol'],5);
const stable=page(dupes,['created_at','symbol','id'],5);
ck('WITHOUT a unique tiebreak, rows are lost or repeated',
   new Set(unstable.map(r=>r.id)).size<20, new Set(unstable.map(r=>r.id)).size);
ck('WITH the primary key, every row is seen exactly once',
   new Set(stable.map(r=>r.id)).size===20 && stable.length===20,
   {distinct:new Set(stable.map(r=>r.id)).size,total:stable.length});
ck('and in a repeatable order', page(dupes,['created_at','symbol','id'],5)
   .map(r=>r.id).join()===stable.map(r=>r.id).join());

// ── unusable rows are counted, never guessed at ──
const usable=(r)=>Boolean(r.symbol && (r.created_at||r.minute_bucket) && r.market);
ck('no symbol -> unusable', !usable({market:'M',created_at:'T'}));
ck('no timestamp -> unusable', !usable({market:'M',symbol:'S'}));
ck('no market -> unusable', !usable({symbol:'S',created_at:'T'}));
ck('complete row -> usable', usable({market:'M',symbol:'S',created_at:'T'}));

console.log(`\nquote migration: ${p}/${n}`);
process.exit(p===n?0:1);
