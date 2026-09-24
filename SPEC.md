# Increment 15 – The login: Steam OpenID, the gate, and the signed-out page

**Scoped:** 2026-09-15 · **Status:** AWAITING JAMES'S APPROVAL
**Tickets:** #7, #8, #3, #15 and #9 (all decided, none built), under map #1.
**Branch:** `experience`. **Base:** `40897af`.
**Baseline measured 2026-09-15 at `40897af`: `npm test` = 830 tests, 830 pass, 0 fail.**

---

## 1. Goal

**Nothing answers without proving who you are, and the page tells you so.**

After this increment, all thirteen unauthenticated route/method pairs in `DEPLOY-BLOCKERS.md`
blocker 1 require a signed session cookie carrying a SteamID64 that is on an allow-list. The three
personal tables are keyed to that SteamID64. Nine places that read `env.STEAM_ID` as "the current
user" read the session instead. The page asks who you are before it asks for anything else, and
shows a pitch instead of a lie when the answer is nobody.

**This closes blocker 1, which is the whole reason `npm run deploy` refuses to run.** It does not
take the stub down – ticket #12 does that last, after the rest of the map.

---

## 2. Why five tickets are one increment

They are mutually blocking. There is no order in which four of them ship and one waits.

| Ticket | What it adds | Why it cannot go alone |
|---|---|---|
| **#7** | The signed cookie, and one default-deny gate at `src/worker.js:2269` | Supplies the SteamID64 that #3 and #15 need. Nothing else can. |
| **#8** | `ALLOWED_STEAM_IDS`, and `STEAM_ID` renamed `OWNER_STEAM_ID` | The rename touches every site #15 rewrites. Doing them apart means touching them twice. |
| **#3** | `steam_id` leading a composite primary key on three tables | Has no correct source for a SteamID64 until #7's session exists. Ticket #3 says so in its own resolution. |
| **#15** | Nine `env.STEAM_ID` reads re-pointed at the session or the owner | The three cache keys become wrong the instant a second identity can exist, which is the instant #7 lands. |
| **#9** | `GET /api/me`, a pitch page, one shared 401 handler, logout | Without it the gate produces a page that says *"the server may still be starting up"* to a signed-out user, forever. |

James ruled on 2026-09-15 that #9 ships with the other four rather than in a follow-up increment.

---

## 3. The four scoping decisions James ruled, 2026-09-15

1. **Size: all five tickets in one diff.** The alternative (server now, page in 15.5) was rejected.
2. **No local sign-in shortcut.** Local dev uses the real Steam login. No bypass path is written, in
   any form, guarded or otherwise. §5 answers the risk this carries.
3. **Every existing test sends a real cookie.** All ten test files that call `worker.fetch` get a
   genuinely signed cookie from a shared helper, and **each of the thirteen route/method pairs gains
   a test that sends no cookie and asserts 401.** Tests reaching handlers beneath the gate was
   rejected: it is the exact shape of the gap increment 14 shipped.
4. **The three tables are dropped, not migrated.** See §4 – this one corrects its own ticket.

---

## 4. The correction this spec makes to its inputs

**Ticket #3's premise is out of date, and its ruling still holds anyway.**

Ticket #3 ruled "one manual `DROP TABLE`, nothing backfilled" on 2026-09-08, on a stated fact:
*"`dismissals` and `game_marks` are **both empty**, verified live"*. **They are no longer empty.**
Measured in local D1 on 2026-09-15:

| Table | Rows | Contents |
|---|---:|---|
| `settings` | 6 | UI preferences (filter bar, recency window) |
| `dismissals` | 1 | Amnesia: The Bunker (`1944430`) |
| `game_marks` | **4** | Portal (`400`), Half-Life 2: Episode Two (`420`), Portal 2 (`620`), Undertale (`391540`) – every one `played=1, finished=1` |

`game_marks` is the table `DEPLOY-BLOCKERS.md` calls **the only unrecoverable table in this
project**. Dropping it is no longer a no-op, and the ticket's reasoning no longer covers the case.

**James ruled on 2026-09-15 to drop them anyway**, and rejected a migration script, on the grounds
that new unproven code aimed at the unrecoverable table inside the largest increment of the project
is a worse risk than re-ticking four games. **The five rows above are the record.** They are
reproduced in the handoff and in the review output so re-creating them needs no archaeology.

**Nothing is at risk remotely.** Ticket #6 verified that remote `sqlite_master` holds `fpm_catalog`
and Cloudflare's `_cf_KV` and nothing else. There is no remote `settings`, `dismissals` or
`game_marks` to drop.

---

## 5. Step 0 – two unknowns, answered before a line of feature code

Both are cheap, both are answered by hand, and both can change §6. **Neither may be assumed.**

**5.1 Does Steam redirect back to a loopback address?**
The map's own fog list carries this as the last unknown in the login flow: *"it cannot be probed
without logging in, because Steam does not support `checkid_immediate`."* Ticket #2 established that
Steam OpenID has no registration and validates nothing, so the expected answer is yes.

Test: build `/auth/login` and `/auth/callback` first, nothing else, run `npm run dev`, set
`PUBLIC_ORIGIN=http://127.0.0.1:8787` in `.dev.vars`, and sign in with James's real Steam account.

- **If it works:** local dev is finished. Nothing further is needed.
- **If it does not:** every local session needs `npx wrangler dev --tunnel`, because a cookie set on
  a `trycloudflare.com` host does not apply to `127.0.0.1:8787`. **Report this to James at the diff
  gate as a finding. Do not invent a workaround** – decision 2 forbids a bypass, and inventing one
  quietly is worse than the annoyance.

**5.2 Will a `__Host-` cookie set over plain HTTP on loopback?**
Ticket #7 requires `__Host-sss_session`, and the `__Host-` prefix requires the `Secure` attribute.
Chrome and Firefox treat `http://127.0.0.1` as a secure context and accept it; Safari historically
did not. Test it in the browser James actually uses, in the same sign-in as 5.1.

**If the cookie will not set, stop and report.** Do not fall back to an unprefixed cookie name on
loopback: a cookie whose name depends on the environment is a divergence between local and
production in the one mechanism the whole increment rests on.

---

## 6. The auth module – new file `src/auth.js`

Everything in this section is ticket #7's resolution, written out. **None of it is re-opened.**

### 6.1 The token

Stateless HMAC-SHA256. **There is no session store**, in D1, in KV or anywhere else. Ticket #7
dissolved that question rather than answering it: KV loses on 1,000 writes/day and on eventual
consistency bouncing the read straight after the login write; D1 loses on paying a row read per
request to re-learn what the cookie already proves.

```
token = base64url(JSON.stringify(payload)) + "." + base64url(HMAC_SHA256(SESSION_SECRET, part1))
payload = { sub: "<steamid64 as a STRING>", iat: <epoch ms> }
```

- **`sub` is a string and stays a string.** Ticket #2 carries this: a SteamID64 loses precision as a
  JavaScript number. A numeric `sub` anywhere in this increment is a defect.
- **Verification is timing-safe.** Compare the recomputed signature with `crypto.subtle.timingSafeEqual`
  over the raw bytes, never with `===` on the base64 strings.
- **Verify the signature before parsing the payload.** An attacker controls the payload bytes.
- **180 days, sliding, no absolute cap.** Re-issue the cookie whenever `Date.now() - iat` is past the
  halfway mark (90 days). `iat` ships in the payload so a cap stays a one-line change later.
- **The honest cost, recorded here so no review re-discovers it as a defect:** a sliding stateless
  token can be renewed indefinitely by whoever holds it. **Rotating `SESSION_SECRET` is the
  documented panic button**, and it is the only lever that covers James, because pulling himself off
  the allow-list would lock him out too.

### 6.2 The cookies

Two, both `HttpOnly`, both `SameSite=Lax`, both carrying the `__Host-` prefix, which forces
`Secure`, `Path=/` and no `Domain`.

| Cookie | Life | Job |
|---|---|---|
| `__Host-sss_session` | 180 days | The token above |
| `__Host-sss_oidc_state` | 10 minutes | A random nonce, minted at `/auth/login`, compared at the callback |

**`SameSite=Lax` is mandatory and `Strict` is forbidden.** Ticket #2 §2.5: the Steam callback arrives
as a cross-site top-level navigation, and `Strict` drops the cookie, so every login fails.

**The nonce cookie is not optional.** Without it an attacker can log James into the attacker's
account. The callback must reject a request whose `state` parameter does not match the cookie, and
must clear the nonce cookie on every exit path, success or failure.

---

## 7. The gate

**One default-deny gate at the top of `export default { async fetch }`, `src/worker.js:2269`,
before any route matching.**

```
Read the session cookie → verify → look up the allow-list → attach `session` → dispatch.
Anything that fails, at any step, returns 401 and dispatches nothing.
```

### 7.1 It fails closed, and that contradicts this project's own convention on purpose

`src/catalogCache.js:30` says **"FAIL-SOFT IS ABSOLUTE"**. That is right for a cache and catastrophic
for auth. Every error path in the gate – a malformed cookie, a thrown `crypto` call, a missing
`SESSION_SECRET`, an unreadable allow-list – returns 401. **A `catch` in the gate that returns
anything other than 401 is a defect, and the review should look for exactly that.**

### 7.2 What sits above the gate, and why the list is exactly this

| Path | Why it is ungated |
|---|---|
| `GET /api/me` | It is the question "am I signed in". Gating it makes it unable to answer no. **It returns `{ signedIn: false }` with a 200, never a 401.** |
| `GET /auth/login` | You cannot be signed in before you sign in. |
| `GET /auth/callback` | Same. |
| `POST /auth/logout` | Clearing a cookie you do not hold is a no-op. |
| `env.ASSETS.fetch(request)` | **The gate cannot reach it.** `[assets]` serves `public/` before the Worker runs. This is fine: the shell holds no data. |

**Everything else is denied, including the `/api/` 501 catch-all**, which stays where it is at
`src/worker.js:2314`, below the gate. A signed-out caller hitting a deleted route gets 401, not 501.
The six tests in `test/router-deleted-routes.test.mjs` therefore send a cookie and still expect 501.

`GET /api/me` returns `{ signedIn: true, steamId: "<id>", owner: <bool> }` when signed in. The
`owner` flag is what increment 16 will use for the sync controls; nothing consumes it yet.

### 7.3 How the identity reaches a handler

**The gate passes it. No handler and no helper reads it out of `env`.** Ticket #15's safety property:
*"a builder that reads `env` internally can be called correctly from anywhere and still be wrong."*

Handler signatures become `handleX(request, env, ctx, session)`, and for the two prefix-dispatched
routes `handleX(request, env, ctx, session, appid)` – the existing fourth positional `appid` at
`src/worker.js:2302` and `:2311` moves to fifth.

---

## 8. The three `/auth` routes

### 8.1 `GET /auth/login`

Mint the nonce, set `__Host-sss_oidc_state`, 302 to `https://steamcommunity.com/openid/login` with:

```
openid.ns          = http://specs.openid.net/auth/2.0
openid.mode        = checkid_setup
openid.identity    = http://specs.openid.net/auth/2.0/identifier_select
openid.claimed_id  = http://specs.openid.net/auth/2.0/identifier_select
openid.return_to   = ${env.PUBLIC_ORIGIN}/auth/callback?state=<nonce>
openid.realm       = ${env.PUBLIC_ORIGIN}
```

**`realm` and `return_to` come from `env.PUBLIC_ORIGIN` and NEVER from `new URL(request.url).origin`.**
This is ruled in `wrangler.toml`'s own comment and in ticket #2 §1.5: one Worker is reachable on more
than one hostname, so a request-derived realm is partly attacker-influenced. **Reject any request
whose `Host` does not match `PUBLIC_ORIGIN`.**

### 8.2 `GET /auth/callback`

In this order, and every failure clears both cookies and shows a plain refusal:

1. `state` matches `__Host-sss_oidc_state`. Reject if not.
2. `POST` every received `openid.*` parameter back to Steam with `openid.mode=check_authentication`.
3. **Parse the body for `is_valid:true`. Do not trust the status code.** Ticket #2 records that
   `check_authentication` returns **HTTP 200 even when the assertion is invalid**. A handler that
   checks `res.ok` here is a complete authentication bypass, and the review must confirm it does not.
4. Extract the SteamID64 from `openid.claimed_id`, which has the form
   `https://steamcommunity.com/openid/id/<steamid64>`. **Keep it as a string.**
5. **Check the allow-list here, before the cookie is minted**, so a refused stranger gets an honest
   answer instead of looping through Steam forever. §9 covers what they see.
6. Mint the session cookie, clear the nonce cookie, 302 to `/`.

### 8.3 `POST /auth/logout`

**POST, never GET.** A GET logout is fireable from any `<img>` tag – the same lesson the router's
`:appid` DELETE comment at `src/worker.js:2296` already records in this file.

Clears both cookies with **identical attributes** to the ones that set them, then 302 to `/`.

**It is a client-side act only.** Nothing server-side exists to delete, so a captured cookie survives
a logout. This is not a defect to fix here; it is the cost ticket #7 accepted, and `SESSION_SECRET`
rotation remains the only real revocation.

---

## 9. The allow-list (ticket #8)

**One Worker secret, `ALLOWED_STEAM_IDS`, a comma-separated list of SteamID64 strings. No admin
route, no table, no roles.**

**It is checked twice, not once.** Ticket #8's own item 5 said "once at login" and was corrected by
ticket #7: the session store was traded away *on the grounds that this list is the revocation*, so a
login-only check would leave a removed mate working for 180 days.

1. At the callback, before the cookie is minted – an honest refusal.
2. In the gate, on every request – revocation. Removing a mate kills their next request.

**`[vars]` is forbidden. This repository is PUBLIC**, so a committed list would publish James's
SteamID64 and every mate's, each of which resolves to a live `steamcommunity.com/profiles/` page.

**The owner is implicitly allowed even if absent from the list.** A deliberate guard against a paste
typo locking James out of his own app.

**A refused stranger is a distinct third state**, not a signed-out one, and must be told plainly or
they loop through Steam forever. **Their SteamID64 is logged**, because that is how James gets the
id to paste into the secret. This state is served **server-side at the callback**, not by the SPA.

---

## 10. The schema re-key (ticket #3)

`steam_id TEXT NOT NULL` leads a composite primary key on all three tables, created by extending the
existing `CREATE TABLE IF NOT EXISTS` convention. **No `migrations/` mechanism is introduced.**

```sql
CREATE TABLE IF NOT EXISTS settings (
  steam_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT, updated_at INTEGER,
  PRIMARY KEY (steam_id, key)
)
CREATE TABLE IF NOT EXISTS dismissals (
  steam_id TEXT NOT NULL, appid INTEGER NOT NULL, name TEXT, dismissed_at INTEGER,
  PRIMARY KEY (steam_id, appid)
)
CREATE TABLE IF NOT EXISTS game_marks (
  steam_id TEXT NOT NULL, appid INTEGER NOT NULL, name TEXT,
  played INTEGER NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0,
  marked_at INTEGER, updated_at INTEGER,
  PRIMARY KEY (steam_id, appid)
)
```

**`TEXT` is forced, not preferred.** D1 returns rows to JS as numbers, and a SteamID64 loses
precision as one.

**Ten exported functions gain an explicit `steamId` argument** and every one of them puts
`WHERE steam_id = ?` on its statement:

- `src/settings.js` – `getAllSettings`, `putSettings`
- `src/dismissals.js` – `listDismissals`, `getDismissedAppIdSet`, `addDismissal`, `removeDismissal`
- `src/marks.js` – `listMarks`, `getMarksByAppid`, `setMark`, `removeMark`

The three `ensure*Schema(env)` functions are unchanged in signature. The two private wrappers
`getDismissedAppIds` (`src/worker.js:357`) and `getGameMarks` (`:382`) gain the argument and pass it
through. **`excludeDismissed`, `normaliseMark` and `derivePlayed` are pure and do not change.**

**A statement that reaches D1 without a `steam_id` predicate is the defect this section exists to
prevent.** The review should grep for it directly.

**James runs this once, by hand, before the first sign-in.** It is not on the request path – ticket
#3 rejected an automatic version-stamped drop for putting a live `DROP` there.

```
npx wrangler d1 execute fpm-catalog --local --command "DROP TABLE IF EXISTS settings; DROP TABLE IF EXISTS dismissals; DROP TABLE IF EXISTS game_marks;"
```

---

## 11. The identity clean-up (ticket #15)

**Nine code reads of `env.STEAM_ID` remain at `40897af`**, down from thirteen because four died with
increment 14. They split four ways.

### 11.1 Three cache keys take the id as an argument – the dangerous ones

| Builder | Line | Callers |
|---|---|---|
| `libraryCacheKey` | `src/worker.js:241` | `getOwnedAppIds:315`, `loadLibraryForRank:1417` |
| `wishlistCacheKey` | `:648` | `loadWishlistCandidates:822` |
| `wishlistPricesCacheKey` | `:659` | `loadWishlistPrices:850` |

**Ticket #15 corrected its own audit here: there are three per-user cache keys, not one.** The two
wishlist keys were listed as read sites and never identified as keys, so they were never analysed –
and `/api/wishlist` is called by the front end and survived the route cut, so that is a live path.

Three changes, all three required:

1. **Each builder takes `steamId` as an explicit argument and never reads `env`.**
2. **Each throws on an absent or malformed id.** Interpolating `steamid=undefined` would create one
   shared bucket that every buggy caller reads and writes – the cache-layer twin of a
   `WHERE steam_id = undefined`.
3. **Both wishlist keys gain `v=1`.** Unlike the library key they carry no version parameter today,
   so they cannot be evicted at all. The shape is changing anyway.

### 11.2 Two upstream calls take the session id

`src/worker.js:253` (`fetchOwnedGames`, the Steam `GetOwnedGames` call) and `src/wishlist.js:38`.

### 11.3 Four guards drop `STEAM_ID` from the test entirely

This is the largest and cheapest reduction in the ticket. Each of these asks *"can this deployment
talk to Steam"*, which is a question about `STEAM_API_KEY`. After the gate a session id always
exists, so testing it is meaningless.

| Line | Now | Becomes |
|---|---|---|
| `:312` `getOwnedAppIds` | `!env.STEAM_API_KEY \|\| !env.STEAM_ID` | `!env.STEAM_API_KEY` |
| `:1002` `handleWishlist` | `!env.STEAM_ID \|\| !env.ITAD_API_KEY` | `!env.ITAD_API_KEY` |
| `:1416` `loadLibraryForRank` | `!env.STEAM_API_KEY \|\| !env.STEAM_ID` | `!env.STEAM_API_KEY` |
| `:1591` `steamConfigured` | `Boolean(env.STEAM_API_KEY && env.STEAM_ID)` | `Boolean(env.STEAM_API_KEY)` |

`src/wishlist.js:30` is right that the wishlist endpoint needs no API key – that is why `:1002` keeps
only the ITAD test.

### 11.4 The sync pipeline keeps the OWNER id, and says why

`fpmSyncDeps` (`src/worker.js:1213`) legitimately uses `env.OWNER_STEAM_ID`. **It needs a comment
saying so**, or it reads as the very bug this section removes.

### 11.5 The fail-soft ambiguity does not arise

Ticket #15 feared that dropping the guards makes an empty result ambiguous. It does not: the
default-deny gate means "no session" cannot reach these functions at all, so an empty result now
means exactly one thing – the upstream failed. **Fail-soft is kept unchanged and becomes more
honest.**

### 11.6 The rename

`STEAM_ID` becomes `OWNER_STEAM_ID` everywhere, including `.dev.vars`. It splits two jobs that shared
one name: who the current user is (the session, per request) and whose app this is (a deploy-time
constant).

**`tools/rank-review.mjs` reads `STEAM_ID` at `:387`, `:455` and `:627` and must be renamed with it.**
Pre-existing and separate, recorded by ticket #5 and still unfixed: `:387` omits `&v=2` from the
library cache key, so it silently reads an empty library. **Do not fix that here** – note it again.

---

## 12. The signed-out page (ticket #9)

### 12.1 `GET /api/me` is called before anything else, so the page never guesses

`public/index.html`'s `main()` at `:1104` currently opens with `restoreFilters()`. It opens with
`/api/me` instead. Signed in, boot continues exactly as it does today. Signed out, it paints the
pitch and stops – **no other fetch is fired**.

### 12.2 The pitch page, not a bare sentence

James chose this over a one-line "please sign in" because step 1 of ticket #13's stranger run tests
whether the landing state explains itself, and that question gets sharper the moment the app is on a
URL. A short pitch: what the app does, a "Sign in through Steam" button pointing at `/auth/login`,
and **an "Invite only" line that warns a mate before the round trip**, so a refusal reads as expected
rather than as a broken app.

### 12.3 Two live defects this must fix

Both were found by ticket #9 and both are in the code today.

1. **`restoreFilters()` swallows a 401.** `public/index.html:991` catches everything, so boot
   continues and `/api/rank` then throws, and `showFailure` at `:350` paints *"The page could not
   read the game catalogue. Reloading may help"* – **a reload can never help an expired session.**
   This is the same class of lie increment 12's review removed once already, returning through a
   different door.
2. **Four fetch sites swallow a 401 entirely**, two with a bare `.catch(() => {})` – `:986`
   (`saveFilters`) and `:1084` (`paintWishlist`).

**This is why the answer is one shared guard and not per-fetch handling: per-fetch handling already
exists, and it is already wrong.**

### 12.4 One shared 401 handler over ten fetch sites

`public/index.html:324, 678, 698, 828, 829, 904, 928, 982, 992, 1078`.

**It behaves differently for reads and writes, and that difference is the whole design.**

| | Behaviour |
|---|---|
| **A read 401** | Flip the page to a "your session ended" variant. There is no unsaved data to preserve. |
| **A write 401** | **Do not nuke the page.** Reuse `showMarkFailure` (`:871`) – spring the control back and toast. |

The write case is **increment 12.5's gate 6 answer reused rather than reinvented**. Its expected
behaviour is already written down, which is why ticket #14 never blocked this.

### 12.5 Logout

A small button at the bottom, next to the persona name, POSTing to `/auth/logout`. **Small and out of
the way on purpose: a 180-day session means logout is used approximately never.**

### 12.6 What the SPA does NOT do

**The refused-invite state is not the SPA's job.** Ticket #8 placed it server-side at the callback.
A refused stranger never loads the app.

---

## 13. Tests

### 13.1 The shared cookie helper

A new `test/helpers/` export that mints a genuinely valid signed cookie from a fixed test
`SESSION_SECRET` and a fixed test SteamID64. **It signs for real. It does not stub the verifier.**

### 13.2 Ten existing files send it

`catalog-experience`, `router-deleted-routes`, `worker-library-plumbing`, `worker-bestof-sourcing`,
`worker-fpm`, `worker-marks`, `worker-dismissals`, `worker-wishlist`, `worker-settings`,
`worker-rank`.

**No existing test is deleted and no existing assertion is weakened.** If a test's expectation
changes, the change is listed by name in the report with its reason. This is the arithmetic that
proves nothing was quietly dropped, and increment 14 established it.

### 13.3 Thirteen new gate tests, one per route/method pair

Send no cookie. Assert **401**. The thirteen pairs are `DEPLOY-BLOCKERS.md` blocker 1's table:
`GET /api/rank`, `GET /api/wishlist`, `GET|PUT /api/settings`, `GET|POST /api/dismissals`,
`DELETE /api/dismissals/:appid`, `GET|POST /api/marks`, `DELETE /api/marks/:appid`,
`POST /api/fpm/sync`, `POST /api/fpm/sync/stop`, `GET /api/fpm/sync/status`.

**This is the test increment 14 shipped without.** Its headline claim rested on a manual curl.

### 13.4 New auth tests

A new `test/auth.test.mjs` covering, at minimum:

- A tampered payload is rejected. A tampered signature is rejected. A token signed with a different
  secret is rejected.
- `sub` survives as a string through a full round trip. **A SteamID64 that would lose precision as a
  number comes back byte-identical.**
- The sliding re-issue fires past 90 days and does not fire before it.
- `check_authentication` returning **HTTP 200 with a body that is not `is_valid:true`** is rejected.
  This is the authentication-bypass test.
- A `state` mismatch at the callback is rejected.
- An allow-list miss is refused at the callback, and a signed cookie for a since-removed id is
  refused at the gate.
- The gate returns 401, not 500 and not 200, when `SESSION_SECRET` is missing.

### 13.5 Per-user isolation tests

For each of the three tables: write as identity A, read as identity B, **assert B sees nothing**.
Three tests. They are the only proof the composite key actually works.

### 13.6 The local OpenID stub

The suite stubs the identity provider, per ticket #2. **No test calls `steamcommunity.com`.**

### 13.7 Expected count

**830 existing tests still pass, plus the new ones.** There is no target number, because this
increment deletes nothing. **Any existing test that fails is a stop, not a number to adjust.**

---

## 14. New secrets and config

| Name | Where | Note |
|---|---|---|
| `SESSION_SECRET` | `.dev.vars` now, Worker secret at ticket #12 | New. High-entropy random. **Rotating it is the panic button.** |
| `ALLOWED_STEAM_IDS` | `.dev.vars` now, Worker secret at ticket #12 | New. Comma-separated SteamID64 strings. |
| `OWNER_STEAM_ID` | `.dev.vars` | **Renamed from `STEAM_ID`.** |
| `PUBLIC_ORIGIN` | `wrangler.toml` `[vars]`, overridden in `.dev.vars` for local dev | Exists. **This increment is the first thing that consumes it.** |

`.dev.vars` is gitignored and stays that way. **Ticket #12 moves these to real Worker secrets. This
increment does not deploy and does not touch `package.json`'s deploy stub.**

---

## 15. What this increment does NOT do

- **Does not take down the deploy stub.** Ticket #12, last on the map. `npm run deploy` still
  hard-fails, and `test/deploy-stub.test.mjs` still passes unchanged.
- **Does not deploy.** The live proof is local, through the tunnel if §5.1 needs it.
- **Does not build ticket #10** (sync routes owner-only, 403). **SEC-1, the cross-site sync trigger
  increment 14 left open, dies here anyway as a side effect:** an `<img src=".../api/fpm/sync">` is a
  subresource request, `SameSite=Lax` does not attach the cookie to it, and the gate returns 401.
  #10's remaining subject is a signed-in *mate*, and no mate exists during this epic. **Increment 16.**
- **Does not build ticket #4** (`source_owned` out of the shared snapshot). It is independent of auth
  and its leak needs a second signed-in user to matter. **Increment 16.**
- **Does not build ticket #11** (`tools/push-catalog.mjs`).
- **Does not touch the ranking.** `src/profile.js`, `src/rank.js`, `src/score.js` and
  `public/weight.js` get **zero** diff. Anything that moves the ranking re-opens increment 11.
- **Does not prune the caller-less exports** in `src/deals.js` and `src/hltb.js`, still unruled from
  increment 14 §6.
- **Does not write `CONTEXT.md` or `docs/adr/`.** Ruled out of this epic by map #1.
- **Does not fix `tools/rank-review.mjs:387`'s missing `&v=2`.** Renaming the variable there is in
  scope; fixing the bug is not.

---

## 16. Verification, in order

1. **§5.1 and §5.2 answered by a real sign-in, and written down.** Before anything else.
2. James has run the `DROP TABLE` command from §10.
3. `npm test` → **830 existing tests pass**, plus the new ones. Any existing failure stops the
   increment.
4. `npm run dev` starts.
5. **Signed out**, every one of the thirteen route/method pairs returns **401**, by `curl` with no
   cookie. Captured with request and full response body.
6. **Signed out**, `GET /api/me` returns **200** with `{ signedIn: false }`. Not a 401.
7. **Signed out**, loading `/` in a browser paints the **pitch page** and fires **no other** `/api/`
   request. Proven from the network panel, not from the code.
8. **A real Steam sign-in completes**, end to end, against real `steamcommunity.com`.
9. **Signed in**, `GET /api/rank` returns real data. **Assert a row count, not a 200** – an empty
   database returns 200 all day. Expect `catalogTotal: 18306`.
10. **Signed in**, all thirteen pairs answer, each asserted on **content**, never on status.
11. **The tables are keyed.** Write a mark signed in, then query D1 directly and show the
    `steam_id` column holding James's SteamID64 as **text**.
12. **A cookie signed with a different secret returns 401**, by `curl`. The gate is not decorative.
13. `POST /auth/logout`, then a reload paints the pitch page again.
14. `npm run deploy` still refuses to run.

---

## 17. Done means

The diff is shown to James and the increment stops. **No commit, no push.**

The report states the new test count against the **830** baseline and accounts for every new test by
name. It states the answers to §5.1 and §5.2 plainly, including "we do not know" if a sign-in could
not be completed. It lists the five dropped rows from §4 so James can re-tick them. And it flags
anything found that contradicts this spec – **every ticket on this map so far has corrected
something, and this spec has already corrected ticket #3's premise in §4.**

---

## ⛩ REVIEW

**Gate TLDR:** the thirteen route/method pairs that served James's ranked library, wishlist, settings,
dismissals and play history to anyone who asked now answer **401 without a signed cookie**, the three
personal tables are keyed to a SteamID64 that cannot be forged, the page shows a pitch instead of a
lie when nobody is signed in, and **blocker 1 – the entire reason `npm run deploy` refuses to run –
is closed.** The deploy stub stays up, because ticket #12 takes it down last.

**Output (what James holds while reviewing):**

1. `01-the-gate-is-shut.md` – live `curl` with **no cookie** against all thirteen route/method pairs,
   each answering **401**, request and full body captured. Then the same thirteen **with** a cookie,
   each asserted on **content**. The single artifact that proves the increment's headline claim,
   and the one increment 14 did not have.
2. `02-a-real-steam-login.md` – the whole round trip against real `steamcommunity.com`, captured:
   the redirect out, the callback in, the `check_authentication` body, the `Set-Cookie` header with
   its attributes, and `/api/me` answering `signedIn: true`. **Plus the plain answers to §5.1
   (loopback redirect) and §5.2 (`__Host-` on loopback)**, which are two unknowns the map has been
   carrying and this increment closes.
3. `03-the-cookie-cannot-be-forged.md` – four `curl` runs, each getting **401**: a tampered payload,
   a tampered signature, a token signed with a different secret, and a valid cookie for a SteamID64
   that is not on the allow-list. **Revocation proven, not asserted.**
4. `04-the-tables-are-keyed.md` – the three new `CREATE TABLE` statements, a live D1 query showing
   `steam_id` holding a SteamID64 as **text**, and the three isolation tests: written as A, invisible
   to B. Plus a grep showing **no statement reaches D1 without a `steam_id` predicate**.
5. `05-the-signed-out-page.md` – the pitch page rendered, the network panel showing `/api/me` and
   **nothing else**, and both live defects from §12.3 shown fixed: the swallowed 401 in
   `restoreFilters`, and the four silent catches. **Includes the write-401 path springing a control
   back rather than nuking the page.**
6. `06-the-nine-reads-are-gone.md` – each of the nine `env.STEAM_ID` sites before and after, with the
   three cache keys shown taking an explicit argument and **throwing** on a bad id, the two wishlist
   keys shown gaining `v=1`, and `fpmSyncDeps` shown keeping `OWNER_STEAM_ID` **with its comment**.
7. `07-the-test-arithmetic.md` – 830 → 830 + N, every new test named, **and confirmation that no
   existing test was deleted or weakened.** Any changed expectation listed with its reason.
8. `08-nothing-else-moved.md` – the empty `git diff` for `src/rank.js`, `src/profile.js`,
   `src/score.js` and `public/weight.js`, and `npm run deploy` still refusing to run.
9. `09-deploy-blockers.md` – blocker 1 **closed**, blocker 3 rewritten: its text says only "no rate
   limit" today and must now record that SEC-1's cross-site trigger is closed by the gate, with
   ticket #10's owner check named as increment 16's remaining work.
10. `10-needs-your-eyes.md` – the five rows to re-tick from §4, and anything perceptual: the pitch
    page's wording, the logout button's placement, and the "your session ended" variant.

**Review folder:** `~/code/review/steam-sale-scout/inc-15/`
**Index:** `/AI/projects/personal-projects/steam-sale-scout/reviews/inc-15.md`
