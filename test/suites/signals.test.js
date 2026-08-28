// The seven checks, at their thresholds and just either side of them.
const sig=require('../../src/signals');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};
// ─── THE FIXTURE IS BUILT FROM THE TABLE, NOT WRITTEN BY HAND ──────────────
//
// The previous version returned an object with `volume` — a column
// symbol_minute does not have. Every one of these 32 assertions passed while
// WALL_PLACED, WALL_PULLED and FROZEN could never fire on a real row.
//
//   A test that constructs its own input proves the logic.
//   It proves nothing about the wiring.
//
// snap() now starts from the ACTUAL column list, so a property that does not
// exist cannot be introduced by a fixture.
const db=require('../../src/db/pool');
let COLS=[];
const snap=(o={})=>{
  const r={};
  for(const c of COLS) r[c]=null;
  Object.assign(r,{symbol:'ABAR',bid:175,bid_qty:50000,offer:177,offer_qty:50000,
    last_price:176,volume_delta:0,bid_age_secs:3600,ts:new Date()});
  for(const k of Object.keys(o)){
    if(!(k in r)) throw new Error(`fixture used \`${k}\`, which is not a symbol_minute column`);
    r[k]=o[k];
  }
  return r;
};
const names=(r)=>r.map(x=>x.signal).sort();

(async()=>{
COLS=(await db.query(
  "select column_name from information_schema.columns where table_name='symbol_minute' order by ordinal_position"
)).rows.map(r=>r.column_name);
ck('the fixture is built from '+COLS.length+' real columns', COLS.length===18, COLS.length);
ck('and symbol_minute has NO `volume` column — the bug', !COLS.includes('volume'));
ck('it has volume_delta instead', COLS.includes('volume_delta'));


// ── 10 · NO PROTECTION, bid < 20,000 ──
ck('19,999 fires', !!sig.noProtection(snap(),snap({bid_qty:19999})));
ck('20,000 does NOT (threshold is <)', sig.noProtection(snap(),snap({bid_qty:20000}))===null);
ck('null bid_qty does not fire', sig.noProtection(snap(),snap({bid_qty:null}))===null);

// ── 11 · BUYERS 8:5, ratio >= 1.6 AND PRICE RISING ──
const up=sig.buyersRatio(snap({bid_qty:80000,offer_qty:50000,last_price:176}),
                         snap({bid_qty:80000,offer_qty:50000,last_price:177}));
ck('1.6 with the price rising fires', !!up, up);
ck('ratio reported', up && up.ratio===1.6, up&&up.ratio);
ck('1.59 does not fire',
   sig.buyersRatio(snap({last_price:176}),snap({bid_qty:79500,offer_qty:50000,last_price:177}))===null);
// The correction: the condition is the PRICE, not the ratio.
ck('a strong ratio with the price FALLING does not fire',
   sig.buyersRatio(snap({bid_qty:80000,offer_qty:50000,last_price:177}),
                   snap({bid_qty:80000,offer_qty:50000,last_price:176}))===null);
ck('a strong ratio with a FLAT price does not fire',
   sig.buyersRatio(snap({bid_qty:80000,offer_qty:50000,last_price:176}),
                   snap({bid_qty:80000,offer_qty:50000,last_price:176}))===null);
ck('a FALLING ratio still fires if the price rises — the spec asks for price',
   !!sig.buyersRatio(snap({bid_qty:200000,offer_qty:50000,last_price:176}),
                     snap({bid_qty:80000,offer_qty:50000,last_price:177})));
ck('zero offer_qty does not divide by zero',
   sig.buyersRatio(snap({offer_qty:0}),snap({offer_qty:0}))===null);

// ── 12/13 · WALL PLACED / PULLED, only WITHOUT volume ──
const placed=sig.wallPlaced(snap({offer_qty:50000,volume_delta:0}),
                            snap({offer_qty:250000,volume_delta:0}));
ck('offer grows with no volume -> WALL_PLACED', !!placed, placed);
ck('added size reported', placed && placed.added===200000, placed&&placed.added);
ck('offer grows WITH volume -> not a wall',
   sig.wallPlaced(snap({offer_qty:50000,volume_delta:0}),
                  snap({offer_qty:250000,volume_delta:5000}))===null);
const pulled=sig.wallPulled(snap({offer_qty:250000,volume_delta:0}),
                            snap({offer_qty:50000,volume_delta:0}));
ck('offer falls with no volume -> WALL_PULLED', !!pulled, pulled);
ck('offer falls WITH volume -> ordinary trading',
   sig.wallPulled(snap({offer_qty:250000,volume_delta:0}),
                  snap({offer_qty:50000,volume_delta:200000}))===null);

// ── 14 · BAIT BID, > 100,000 and < 5 minutes old ──
ck('150k at 60s fires', !!sig.baitBid(snap(),snap({bid_qty:150000,bid_age_secs:60})));
ck('150k at 300s does NOT (5 min boundary)',
   sig.baitBid(snap(),snap({bid_qty:150000,bid_age_secs:300}))===null);
ck('100,000 exactly does not fire (threshold is >)',
   sig.baitBid(snap(),snap({bid_qty:100000,bid_age_secs:60}))===null);
ck('an OLD big bid is a real buyer, not bait',
   sig.baitBid(snap(),snap({bid_qty:500000,bid_age_secs:3600}))===null);

// ── 15 · FROZEN, both > 100,000 with no volume ──
ck('both large, nothing traded -> FROZEN',
   !!sig.frozen(snap({volume_delta:0}),snap({bid_qty:150000,offer_qty:150000,volume_delta:0})));
ck('both large but TRADING -> not frozen',
   sig.frozen(snap({volume_delta:0}),snap({bid_qty:150000,offer_qty:150000,volume_delta:500}))===null);
ck('only one side large -> not frozen',
   sig.frozen(snap({volume_delta:0}),snap({bid_qty:150000,offer_qty:50000,volume_delta:0}))===null);

// ── 16 · BID EMPTY, a small print moved the price DOWN ──
const empty=sig.bidEmpty(snap({last_price:176,volume_delta:0}),
                         snap({last_price:175,volume_delta:50}));
ck('50 shares moved it down -> BID_EMPTY', !!empty, empty);
ck('share count reported', empty && empty.shares===50, empty&&empty.shares);
ck('a LARGE sell moving it down is the market working',
   sig.bidEmpty(snap({last_price:176,volume_delta:0}),
                snap({last_price:175,volume_delta:50000}))===null);
ck('price UP does not fire',
   sig.bidEmpty(snap({last_price:175,volume_delta:0}),
                snap({last_price:176,volume_delta:50}))===null);
ck('no trade at all does not fire',
   sig.bidEmpty(snap({last_price:176,volume_delta:0}),
                snap({last_price:175,volume_delta:0}))===null);

// ── a NEGATIVE delta is unknown, not negative trading ──
//
// A counter reset or a bad read. Treated as unknown so the wall checks, which
// require traded === 0, do not fire on nonsense.
ck('a negative volume_delta reads as unknown, so no wall fires',
   sig.wallPlaced(snap({offer_qty:50000,volume_delta:0}),
                  snap({offer_qty:250000,volume_delta:-1}))===null);
ck('and FROZEN does not fire on it either',
   sig.frozen(snap({volume_delta:0}),
              snap({bid_qty:150000,offer_qty:150000,volume_delta:-1}))===null);


// ── evaluate(): every check runs, none short-circuits ──
const both=sig.evaluate(
  snap({bid_qty:50000,offer_qty:250000,volume_delta:0}),
  snap({bid_qty:15000,offer_qty:50000,volume_delta:0}));
ck('a thin bid AND a pulled wall are BOTH reported',
   names(both).join()==='NO_PROTECTION,WALL_PULLED', names(both));
ck('each signal carries the symbol', both.every(s=>s.symbol==='ABAR'));
ck('a quiet book produces nothing', sig.evaluate(snap(),snap()).length===0);
ck('a missing previous snapshot is safe', sig.evaluate(null,snap()).length===0);

// ── EVERY column signals.js reads must exist on the table ──
//
// The general form of the bug: not "does it read volume", but "does it read
// anything the table does not have". The next phantom property fails here.
for(const c of sig.REQUIRED_COLUMNS){
  ck('signals.js reads `'+c+'` — and the table has it', COLS.includes(c), {column:c});
}
ck('a wrong-shaped row THROWS rather than returning nothing',
   (()=>{try{sig.evaluate({last_price:1},{last_price:1});return false;}catch(e){return e.shapeError===true;}})());

console.log(`\nsignals: ${p}/${n}`);
await db.close();
process.exit(p===n?0:1);
})();
