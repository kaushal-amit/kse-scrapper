// The seven checks, at their thresholds and just either side of them.
const sig=require('../../src/signals');
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};
const snap=(o={})=>({symbol:'ABAR',bid:175,bid_qty:50000,offer:177,offer_qty:50000,
  last_price:176,volume:1000000,trades:100,bid_age_secs:3600,captured_at:new Date(),...o});
const names=(r)=>r.map(x=>x.signal).sort();

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
const placed=sig.wallPlaced(snap({offer_qty:50000,volume:1000000}),
                            snap({offer_qty:250000,volume:1000000}));
ck('offer grows with no volume -> WALL_PLACED', !!placed, placed);
ck('added size reported', placed && placed.added===200000, placed&&placed.added);
ck('offer grows WITH volume -> not a wall',
   sig.wallPlaced(snap({offer_qty:50000,volume:1000000}),
                  snap({offer_qty:250000,volume:1005000}))===null);
const pulled=sig.wallPulled(snap({offer_qty:250000,volume:1000000}),
                            snap({offer_qty:50000,volume:1000000}));
ck('offer falls with no volume -> WALL_PULLED', !!pulled, pulled);
ck('offer falls WITH volume -> ordinary trading',
   sig.wallPulled(snap({offer_qty:250000,volume:1000000}),
                  snap({offer_qty:50000,volume:1200000}))===null);

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
   !!sig.frozen(snap({volume:1000000}),snap({bid_qty:150000,offer_qty:150000,volume:1000000})));
ck('both large but TRADING -> not frozen',
   sig.frozen(snap({volume:1000000}),snap({bid_qty:150000,offer_qty:150000,volume:1000500}))===null);
ck('only one side large -> not frozen',
   sig.frozen(snap({volume:1000000}),snap({bid_qty:150000,offer_qty:50000,volume:1000000}))===null);

// ── 16 · BID EMPTY, a small print moved the price DOWN ──
const empty=sig.bidEmpty(snap({last_price:176,volume:1000000}),
                         snap({last_price:175,volume:1000050}));
ck('50 shares moved it down -> BID_EMPTY', !!empty, empty);
ck('share count reported', empty && empty.shares===50, empty&&empty.shares);
ck('a LARGE sell moving it down is the market working',
   sig.bidEmpty(snap({last_price:176,volume:1000000}),
                snap({last_price:175,volume:1050000}))===null);
ck('price UP does not fire',
   sig.bidEmpty(snap({last_price:175,volume:1000000}),
                snap({last_price:176,volume:1000050}))===null);
ck('no trade at all does not fire',
   sig.bidEmpty(snap({last_price:176,volume:1000000}),
                snap({last_price:175,volume:1000000}))===null);

// ── cumulative volume going BACKWARDS is unknown, not negative ──
ck('a volume reset reads as unknown',
   sig.tradedBetween(snap({volume:1000000}),snap({volume:5}))===null);

// ── evaluate(): every check runs, none short-circuits ──
const both=sig.evaluate(
  snap({bid_qty:50000,offer_qty:250000,volume:1000000}),
  snap({bid_qty:15000,offer_qty:50000,volume:1000000}));
ck('a thin bid AND a pulled wall are BOTH reported',
   names(both).join()==='NO_PROTECTION,WALL_PULLED', names(both));
ck('each signal carries the symbol', both.every(s=>s.symbol==='ABAR'));
ck('a quiet book produces nothing', sig.evaluate(snap(),snap()).length===0);
ck('a missing previous snapshot is safe', sig.evaluate(null,snap()).length===0);

console.log(`\nsignals: ${p}/${n}`);
process.exit(p===n?0:1);
