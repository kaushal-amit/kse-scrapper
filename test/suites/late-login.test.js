// The master loop must survive a login that happens after startup.
// Extracted as arithmetic — the real loop's shape, run against a clock.
let p=0,n=0;const ck=(t,c,x)=>{n++;if(c)p++;else console.log('  FAIL:',t,JSON.stringify(x))};

function makeLoop() {
  const st = { tries: 0, fetched: false, state: 'starting', fetches: 0 };
  let sampleUrl = null, waitStarted = 0, sawSample = false, now = 0;

  const tick = () => {                      // the 2-second loop
    if (st.fetched) return;
    if (!sampleUrl) { st.state = 'waiting for the terminal'; return; }
    const waited = now - waitStarted;
    if (waited > 60000 && st.tries % 8 !== 0) { st.tries++; return; }
    st.tries++; st.fetches++;
    st.state = 'fetching (attempt ' + st.tries + ')';
  };
  const watch = () => {                     // the 3-second login watcher
    if (sampleUrl && !sawSample) {
      sawSample = true; waitStarted = now; st.tries = 0; st.fetched = false;
    } else if (!sampleUrl && sawSample) {
      sawSample = false; st.fetched = false;
      st.state = 'the terminal stopped responding';
    }
  };
  return {
    st,
    advance(ms) { for (let i = 0; i < ms; i += 1000) { now += 1000;
      if (now % 2000 === 0) tick(); if (now % 3000 === 0) watch(); } },
    login() { sampleUrl = 'https://awsat/quote?VRS=1'; },
    logout() { sampleUrl = null; },
    succeed() { this.st.fetched = true; this.st.state = 'master loaded'; },
  };
}

// ── the failure that was reported: logged in after five minutes ──
const L = makeLoop();
L.advance(300000);                            // 5 minutes, not logged in
ck('after 5 minutes logged out, no fetch was attempted', L.st.fetches === 0, L.st.fetches);
ck('and it says WHY', /waiting for the terminal/.test(L.st.state), L.st.state);
ck('the OLD code would have stopped after 8 tries — this has not stopped',
   L.st.tries === 0, L.st.tries);

L.login();
L.advance(10000);                             // ten seconds later
ck('a LATE login triggers a fetch', L.st.fetches > 0, L.st.fetches);
ck('and the backoff resets, so it retries fast', L.st.tries <= 5, L.st.tries);

// ── it backs off rather than hammering for hours ──
const B = makeLoop();
B.login(); B.advance(3000);
const firstMinute = B.st.fetches;
B.advance(60000);
const afterOne = B.st.fetches;
B.advance(3600000);                           // an hour more
ck('it keeps trying for an hour', B.st.fetches > afterOne, {afterOne, later: B.st.fetches});
ck('but backs off — an hour adds fewer attempts than the first minute would',
   (B.st.fetches - afterOne) < afterOne * 10, {afterOne, hour: B.st.fetches});

// ── a session timeout re-arms it ──
const T = makeLoop();
T.login(); T.advance(6000); T.succeed();
ck('a loaded master stops the loop', T.st.fetched === true);
const before = T.st.fetches;
T.advance(30000);
ck('and it does not keep fetching', T.st.fetches === before, T.st.fetches);

T.logout(); T.advance(6000);
ck('losing the session re-arms it', T.st.fetched === false, T.st);
T.login(); T.advance(6000);
ck('and the NEXT login fetches again', T.st.fetches > before, {before, after: T.st.fetches});

console.log(`\nlate login: ${p}/${n}`);
process.exit(p===n?0:1);
