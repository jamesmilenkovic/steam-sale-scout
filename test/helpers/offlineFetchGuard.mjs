// QA TC-6 (round-2 review) – the offline fetch guard.
//
// WHY THIS EXISTS. `test/worker-fpm.test.mjs` and `test/worker-hof.test.mjs`
// both open with "NEVER makes a real network call", and both were wrong: four
// tests never assigned `globalThis.fetch` at all, so the real one was live
// underneath them. Measured with a `net.Socket.prototype.connect` probe over
// the whole suite before this guard landed:
//
//   test/worker-fpm.test.mjs  2 outbound TLS connections
//   test/worker-hof.test.mjs  1 outbound TLS connection
//   every other test file     0
//
//   https://steamspy.com/api.php?request=appdetails&appid=200
//     <- src/spyQueue.js:187 fetchAndCacheSpy, via pumpSpyQueue
//   https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?...
//     <- src/deckCompat.js:125 fetchDeckCompatBatch, via resolveDeckCompat
//
// Both call sites are fail-soft, so the suite passed identically online and
// offline and nothing ever flagged it. That is the actual hazard: the tests
// were silently taking whatever SteamSpy and Steam happened to answer with on
// the day, and a lane assertion could have been resting on live data.
//
// HOW IT IS USED. Installed as `globalThis.fetch` in `beforeEach`, so any
// test that forgets its own stub calls THIS instead of the network. It throws
// (matching the "Unexpected fetch URL in test" style the files already use for
// their own stubs) and records the call, and the file's `afterEach` asserts
// the record is empty – so a forgotten stub fails loudly at the exact test
// rather than quietly making a TLS connection.
//
// A second, silent instance is installed by `restoreGlobals()` as the RESTING
// value of `globalThis.fetch` between tests, in place of the real one. That
// covers the other half of the problem: a fire-and-forget `ctx.waitUntil`
// promise that lands after its test has finished cannot reach the network
// either. Nothing in this repo's tests wants the real `fetch`.

/**
 * A `fetch` stand-in that never touches the network. Rejects every call and
 * records the URL on `.calls` so a hook can assert nothing reached it.
 *
 * @param {string} label identifies the file in the thrown message
 */
export function makeOfflineFetchGuard(label) {
  const calls = [];
  const guard = async (input) => {
    const url = String(input?.url ?? input);
    calls.push(url);
    throw new Error(
      `[offline guard] ${label}: unstubbed network call to ${url} – ` +
        "this test did not assign globalThis.fetch, so without the guard it would hit the real internet",
    );
  };
  guard.calls = calls;
  guard.__offlineGuard = true;
  return guard;
}
