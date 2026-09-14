# Increment 12 – The answer page (UX overhaul)

> **Note added 2026-09-14 (increment 14):** this spec refers to routes that no longer exist.
> `/api/library`, `/api/deals`, `/api/recs`, `/api/best-of` and `GET /api/fpm` were deleted at
> increment 14 and now answer `501 not implemented`. Nothing below has been rewritten - this
> file stays the record of what was true when it was approved.

**Scoped:** 2026-09-04 · **Status:** APPROVED by James 2026-09-04 (see §10b)
**Base:** `experience` @ `a4167bd` (increment 11, eye test passed 2026-09-04)
**PRD:** `PRDs/2-in-progress/2026-07-04-steam-sale-recommender.md` – **Rev 3, Phase 5, increment 12**,
plus the seven **increment 10 rulings**, the **increment 11 outcome** block, the new **increment
12.5** entry, and Rev 2's **UX direction** section. All binding. None re-opened here.

---

## 1. Problem, and the one sentence

`/api/rank` answers the product's question correctly and nothing renders it. The front end is
still six tabs over six retired lanes, ranking by a formula the project abandoned three
increments ago, and the only way anyone has ever seen the real answer is a throwaway artifact
page James was handed once.

**This increment builds the page. One screen that answers "what should I play next" before
anyone touches anything on it.**

**User story.** As someone opening this app for the first time – James on a Tuesday night, or a
person who has never heard of it – I want the page to already be showing me a handful of games
with a reason attached to each, so that I can pick one without learning what a preset is.

**The gate, and it governs every decision below:** *a stranger can land on the front page and get
a usable answer without touching a single control.* A page that needs a control touched before
it answers anything has failed, however good the controls are. Where this spec cuts something,
that sentence is the reason.

**What "stranger" means here, stated plainly so nobody assumes hosting.** A real person sitting
at James's Mac mini, in front of `http://localhost:8787/`, with James in the room. There is no
authentication in this project and `/api/rank` returns his library and his playtimes; increment
11's security review made auth a precondition for **any** deploy, and that stands. Nothing in
this increment is exposed beyond loopback. Hosting is the deploy epic; auth is its first item.

---

## 2. Prior art / what already exists

**TLDR:** the browse list is a filterable table over 13,924 rows already in browser memory, and
half a dozen mature libraries do that well – but every one of them arrives through a bundler or
a CDN tag, and this project ships a single static HTML file to a Worker with no build step and a
provably offline-clean test suite. **Build. Take the technique, not the dependency.** For the
part the gate actually tests – five cards with a sentence each – there is nothing to adopt,
because there is no library for "five cards".

The product-level landscape (Valve's Interactive Recommender and Play Next, ITAD, GG.deals,
SteamDB, SteamPeek, Deku Deals) is surveyed in the PRD's Landscape table and Rev 3 evidence item
10. Per the prior-art protocol's per-capability rule, that ground is cited, not re-walked. This
section covers the new capability only: **presenting a ranked answer, and browsing the pool
behind it.**

### 2a. The browse list – table/grid libraries

| What | Type | State | What it does well | Why it isn't the answer |
|---|---|---|---|---|
| [Tabulator](https://github.com/olifolkerd/tabulator) | JS table, MIT | Mature, actively maintained | Closest single-drop-in match: virtual DOM row rendering, per-column filters, multi-sort, no framework required | Needs the bundle on disk. Vendoring ~400 KB of minified JS into `public/` to replace ~150 lines of predicates and a `slice()` is a bad trade, and it becomes a thing to keep updated. |
| [AG Grid Community](https://github.com/ag-grid/ag-grid) | Data grid, MIT core | Mature, commercial upstream | Best-in-class virtualisation and filtering at 100k+ rows | Built for a bundler and a framework wrapper. The community/enterprise split means half the documented features are not the ones we would get. Far larger than the problem. |
| [TanStack Table](https://github.com/TanStack/table) | Headless table logic, MIT | Mature | Headless is the right shape – it gives sorting/filtering/pagination state and leaves rendering alone | Headless means we still write all the markup, which is the part we were going to write anyway. What is left is a state machine we do not need for one list. |
| [Grid.js](https://github.com/grid-js/gridjs) | Table, MIT | Maintained | Small, framework-free, search and pagination out of the box | Its filtering model is search-plus-pagination, not a nine-predicate filter bar. We would fight it. |
| [List.js](https://github.com/javve/list.js) | List filter/sort, MIT | Low activity | Tiny, no dependencies, exactly the "filter and sort an existing list" shape | Operates on rendered DOM, so it wants all 13,924 rows in the document first. That is the one thing we must not do. |
| [Clusterize.js](https://github.com/NeXTs/Clusterize.js) | Virtual scroll, GPL/MIT | Low activity | Solves the only genuinely hard part – rendering a huge list without killing the DOM | We sidestep the hard part instead: render 100 rows with a "show more". Zero lines, zero dependency. |

### 2b. The picks – what the product shape borrows from

Not code, and there is nothing to adopt. Worth naming because the interaction pattern is
solved elsewhere and the lessons are cheap:

1. **Spotify Discover Weekly / Netflix "Top picks for you".** A small fixed set, presented as
   the answer, with the machinery hidden. The lesson taken: no filter bar in the first screenful.
2. **Steam's Discovery Queue.** One game at a time with a reason. Too slow for our case – James
   wants to compare a handful, not click through 20.
3. **Valve's Play Next shelf** (PRD Rev 3, evidence 10). Recommends unplayed games from your own
   library and knows nothing about length, session fit or Deck. It is the closest existing thing
   to our picks section and it is why owned-and-never-launched is treated as a first-class state
   on the pick card.
4. **[Backloggd](https://backloggd.com) / [HowLongToBeat](https://howlongtobeat.com) backlog
   tools.** Both are catalogues you curate by hand. Neither ranks anything for you. They are the
   reason increment 12.5 exists as a separate increment rather than as a feature here.

**Reusable pieces:** none as code. As technique, three things, all free: **render a capped
window** rather than virtualising; **filters as a chain of pure predicates** over one in-memory
array, so each is independently unit-testable (this is exactly `public/filters.js`'s existing
seam, and the new module copies it); **debounce the search input**, not the filter chain.

**Why no measured probe was run, per the protocol's build-vs-adopt rule.** The candidates are
not separated by capability – Tabulator would do the browse list well. They are separated by
delivery: no bundler, no CDN (the suite is provably offline-clean and the app must run with the
network down), and a single-file `public/index.html`. That constraint decides it before any
benchmark would, and a probe that cannot change the answer is not worth the increment.

**The trigger that reopens this:** column resize, column grouping, CSV export, or server-side
pagination. Any one of those and Tabulator becomes the right call, with a build step added
consciously.

**What nobody has done:** present a Steam catalogue as *an answer* – five games with a reason
line, mixing games you own with games you do not, ranked by judged complete-experience value per
hour against your own playtime. Every product in the Landscape table presents a grid and asks
you to filter it. The PRD's white space is intact and this increment is the part of it a person
can see.

**Build vs adopt: build.** Vanilla JS, no framework, no dependency – a conscious ruling under
Rev 2's UX direction clause, not a default. See §6.

---

## 3. Scope – exactly what gets built

**The headline constraint, and it is the cleanest boundary this project has had: increment 12
does not touch `src/`.** Every field the page needs is already on `/api/rank`, including `appid`.
No new route, no new parameter, no schema change, no ranking change. The reviewer's zero-diff
check is `git diff a4167bd -- src/` returning nothing.

1. **`public/index.html`, rewritten.** The answer page: picks, lens strip, two quick chips,
   browse list, filter bar, honest footer. The six tabs are gone from the UI.
2. **`public/rankFilters.js`, new.** Pure ESM filter predicates over `/api/rank` rows, importable
   by both the browser and `node --test`, mirroring `public/filters.js`'s existing seam.
3. ~~`scripts/backup-catalog.mjs`~~ **Already shipped as `tools/backup-catalog.mjs` + `tools/restore-catalog.mjs` in `a4167bd`. Not work for this increment.** (Was: a one-shot backup of the local D1. Not a page
   feature; it is insurance on the asset the page depends on, flagged in increment 11's result
   file as *"worth fixing before increment 12"*.
4. **The port-8788 test hermeticity fix**, in `test/` only.

Nothing else. Nine API surfaces stay byte-identical – §6.

---

## 4. What the page shows

### 4.1 Before any click – the landing state

Loading `http://localhost:8787/` with no query string and no interaction renders, top to bottom:

1. **One question as the heading.** Recommended copy: *"What should I play next?"*
2. **One sentence of basis.** Recommended: *"Ranked from 13,924 games on Steam by how much
   complete experience each one gives per hour you put in, matched to what you actually play."*
   The number comes from `funnel.ranked`, not a constant.
3. **Five picks.** Five, not three and not ten: three is too thin to contain both an owned and an
   unowned candidate, ten is a list rather than an answer, and five fits above the fold on a
   laptop with every reason line readable. Below them, one **"Show me 5 more"**.
4. **The lens strip** (§4.2) – visible, not touched.
5. **The two quick chips** (§4.3) – visible, both off.
6. **"Browse all 13,924 games"** – one click below the picks, collapsed. This is the PRD's
   "full filterable list one click below", and collapsing it is what keeps the filter bar out of
   the first screenful.
7. **The honest footer**, one line: *"Ranked 13,924 of 18,306 games. 4,209 hidden as
   low-confidence, 111 prologues, 87 not games, 2 unscored."* Straight from `funnel`, expandable
   to the full table. It costs one line and it is the cheapest trust the page can buy.

**Each pick card carries, and nothing else:**

| Slot | Source | Rendered as |
|---|---|---|
| Title, linked to its Steam page | `title`, `appid` | `https://store.steampowered.com/app/<appid>/` |
| Status | `owned`, `hoursPlayed`, `price`, `cut` | "In your library · never played" / "In your library · 3h played" / "$7.30 · 80% off" / "$29.99" / "No price on file" |
| Length | `hoursToValue`, `hasEnding` | "About 9 hours" / "Endless – no ending, so no per-hour figure" (`hasEnding === 0`) / "Length not known" (`hasEnding === null`) |
| Why | `why` | The LLM reason line, verbatim. This is the single most load-bearing string on the page. |
| Experience value | `experienceScore` | "Experience value 92 / 100" |
| Taste match | `similarityNorm` | A **word band** – Very strong / Strong / Moderate / Weak / None. Words, not a number, because `similarityNorm` is a percentile under two lenses and a min-max distance under the third, and "89%" would mean two different things depending on which button is lit. The number lives in the browse table where James is reading columns, not sentences. |
| Tags | `tagNames`, first three | "Puzzle · First-Person · Sci-fi" |
| Confidence | `confidence === 'low'` | A small "low-confidence score" mark. Honesty about a bluffed score is not optional on the front page. |
| Actions | – | "View on Steam" (primary) · "Not interested" (dismiss, §4.6) |

**Why this satisfies the gate.** A stranger reads a question, a sentence saying what the ranking
means, then five games each with a name, a reason, a length and whether it is already owned.
"Why these" is answered by the sentence and the reason lines. "What do I do next" is answered by
a link to the store page and a game they already own that they never launched.

### 4.2 The lenses – and the landing state

**The landing state is `default`, and `sale` can never be it.** Measured in increment 11: only 1
of 552 owned games carries a discount, so under `sale` an owned game is arithmetically pushed
down and the lens cannot answer "what do I play tonight". This is enforced, not merely intended –
the landing preset is a named constant in the page module with a unit test asserting it is
`default`.

Three buttons, labelled in product language rather than preset names:

| Button | Preset | Sub-line shown when active |
|---|---|---|
| **Play next** (active on load) | `default` | – |
| **Worth buying** | `sale` | "Games you don't own, weighted by how deep the discount is." |
| **More like what I play** | `similarity` | "Closest to your taste, whether or not you own it." |

Switching lens **re-fetches `/api/rank?preset=…`** and caches the response in memory for the
session. **Hard rule: the browser never computes a rank.** The blend and the similarity
normaliser are properties of the lens and live in `src/rank`; reimplementing them in JS would
create a second source of truth for the product's headline number. Client-side *sorting* of the
browse list on returned fields is presentation and is allowed; recomputing `rankScore` is not.
The reviewer checks this by grepping `public/` for the blend arithmetic and finding none.

### 4.3 The two quick chips – exclude owned, exclude played

James's carried-forward ask (PRD, increment 11 outcome, item 2), and they are distinct.

| Chip | Predicate | Default |
|---|---|---|
| **Hide games I own** | `owned === true` | off |
| **Hide games I've played** | `(hoursPlayed ?? 0) > 0` | off |

They sit under the lens strip and apply to **the picks**, because that is where they are useful.
Worked example the gate checks: an owned game with 0 hours survives "hide played" and disappears
under "hide owned"; an owned game with 3 hours disappears under both.

**Neither is persisted, and both default off.** Reason: a persisted filter would let a previous
session poison the landing state, and the gate is a sentence about landing on the page with
nothing touched. This is the one place where "remember my settings" is the wrong behaviour, and
it is deliberate.

**"Finished" does not exist** and is not faked from playtime. That is increment 12.5.

### 4.4 The browse list – one click below

"Browse all N games" expands the full ranked list under the current lens. A table, **100 rows
rendered** with a "Show 100 more" – the pool is 13,924 rows and putting them all in the DOM is
the only genuinely slow thing the page could do. Filtering runs over the full in-memory array,
not the rendered window, so a filter finds matches at rank 9,000.

Columns: rank · title · experience · quality · hours · taste match (the number here) · FPM ·
owned/hours · price/discount · why. Column sorts are client-side over returned fields, including
`experienceFpm` for "shortest to finish" – nulls last, endless games shown as "endless" rather
than blank, which is the obligation increment 11 §8 shipped the field to satisfy.

### 4.5 The filter bar – and none of it is load-bearing for the gate

It lives inside the collapsed browse section, so it costs the first screenful nothing. Every
predicate below operates on a field already on the row. No new fetch, no new API parameter.

1. **Search** – title substring, case-insensitive, debounced.
2. **Ownership tri-state** – all / hide owned / only owned.
3. **Hide games I've played** – `hoursPlayed > 0`.
4. **On sale only** – `cut > 0`.
5. **Minimum discount** – on `cut`.
6. **Maximum price (AUD)** – on `price`.
7. **Minimum taste match** – on `similarityNorm`.
8. **Minimum experience score** – on `experienceScore`.
9. **Tags** – include only, chips built from `tagNames` across the pool, ranked by frequency.
   Exclude-tags is cut; nobody has asked for it and it doubles the control.
10. **Top 100 of all time** – the PRD's named replacement for the Best of Steam tab. Precisely:
    rows with `reviewPercent >= 95` and `reviewCount >= 10000`, ordered by `reviewCount`
    descending, first 100 – the existing Best-of rule with the discount gate removed. Computed
    over the *ranked* pool, so it can return slightly fewer than 100; the label says how many it
    found rather than claiming 100.

**Filter state persists** across reloads through the existing increment-8 settings lane, under
one new key holding a JSON blob. `GET /api/settings` returns only what is stored, so an untouched
store yields an unchanged response and there is no zero-diff breach. Persistence failure is
silent and never blocks a render.

**The filter bar never touches the picks.** Picks respond to the lens and the two chips, nothing
else. This is what makes the gate un-poisonable by a stale saved filter, and it gives the page a
clean division: picks are the answer, browse is the exploration.

### 4.6 The no-library case – the first-run failure this page must not have

`/api/rank` returns `profileAvailable`, `profileGames` and `notice` precisely so this can be
honest. Three states, three behaviours:

| State | Detected by | What the page does |
|---|---|---|
| Library present | `profileAvailable === true` | Normal. The footer notes how many owned games are behind the ranking. |
| **No Steam credentials configured** | `profileAvailable === false`, `notice === null` | Picks **still render** – the best games on Steam by experience value alone – above a banner: *"No Steam account connected, so these picks are not matched to your taste. They are ranked by experience value alone."* The **More like what I play** button is disabled with that reason on it. |
| **Credentials present, Steam fetch failed** | `notice !== null` | Renders `notice` verbatim, same treatment. |

The failure mode increment 11's security review caught is a taste-blind ranking that looks
normal. The page's job is to make that state impossible to mistake for the normal one, while
still answering the question – a stranger with no credentials is a real first-run case and
"configure your API key" is not an answer.

### 4.7 Dismissals, wishlist, Deck

**Dismissals – in.** A "Not interested" action on every pick and every browse row, POSTing to the
existing `/api/dismissals`. The card is removed locally and the next pick slides in without a
reload. `/api/rank` already excludes dismissed rows server-side, so a reload keeps it gone. The
retiring Dismissed tab becomes a small **"Dismissed (N)"** link in the footer that lists them
from `GET /api/dismissals` – which already stores titles – with a restore button per row. No API
change.

**Wishlist – folded in as a badge, and that closes PRD open question 2.** After the picks paint,
a non-blocking `GET /api/wishlist` builds a Set of appids and badges matching rows "wishlisted".
Failure is silent. The tab retires. **What is explicitly NOT done: no wishlist lane, no wishlist
filter, and no wishlist boost in the ranking** – a boost is a ranking change and ranking is
frozen this increment. If this threatens the gate at any point in the build it is the first thing
cut.

**Deck compat – out, and here is the reason.** `resolveDeckCompat` is a live batched `GetItems`
fetch and is not on `/api/rank`. Surfacing a Deck badge or filter means a new upstream call in the
page's load path, which is a new failure mode on the one screen whose gate is "it answers when you
land on it". It buys the gate nothing. Increment 13 or later, when it can ride on a cached
catalogue column rather than a page-load fetch.

---

## 5. 13,924 rows, 10 MB – what the page does, and what it does not do

**Pagination and `?limit=` do not land here. Increment 13 owns this.** The honest arithmetic:
`/api/rank` costs ~0.9 s warm and ~30 s cold, and that cost is dominated by an 18,306-row D1 read
plus a live Steam fetch, not by serialising the response. Wiring `limit` would shrink the payload
and save perhaps a few hundred milliseconds of transfer and parse; it would not touch the 30 s.
The real fix is caching the user-independent catalogue computation (`src/catalog.js:493`), which
is already scoped as increment 13.

**So the page does three things instead:**

1. **One fetch, held in memory.** All rows, filtered and sorted client-side. Filters are then
   instant, which is worth more than a smaller first payload.
2. **An honest loading state.** Not a spinner: *"Reading 18,306 games…"*, replaced by the picks
   the moment the payload lands. First load after a `wrangler dev` restart says so.
3. **Renders 100 rows, not 13,924.** §4.4.

**Gate 6 measures warm first paint rather than assuming it.** Target under 3 seconds. If it
misses, the **single pre-authorised `src/` change in this increment** is wiring `?limit=` for a
fast picks call with the full list fetched behind it – and it comes back to James before the line
is written, because it breaches §3's "does not touch `src/`" boundary.

**The drive script runs against a warm server** – James loads the page once before the stranger
sits down. Stated here rather than discovered at the gate: cold start is increment 13's problem
and this gate is not a test of it.

---

## 6. How the old tabs retire, and the zero-diff boundary

**The UI retires. The routes do not. These are two decisions and only the first happens here.**

| Thing | This increment | When |
|---|---|---|
| The six tabs in `public/index.html` | **Deleted.** The file is rewritten. | Now |
| `/api/fpm`, `/api/recs`, `/api/deals`, `/api/best-of`, `/api/wishlist`, `/api/library` | **Untouched, still serving, still tested.** | Increment 13 cleanup |
| Their exhaustive key-set tests | **Untouched.** | With the routes |
| `public/filters.js`, `public/weight.js` and their tests | **Untouched**, orphaned but passing | With the routes |

**Why the routes survive a round.** Deleting six handlers and their key-set tests in the same
increment that rewrites the entire front end doubles the diff and removes the safety net at
exactly the moment the new page is being built against the same data. It also means that if the
new page is wrong about a field, the old page is still there to compare against. `/api/wishlist`
is not even a retirement candidate this round – the badge in §4.7 consumes it.

**Orphaned `public/filters.js` is a conscious decision, not an oversight.** Its predicates target
the old sale-lane row shapes (deck mode, battery, quality floors) which do not exist on
`/api/rank` rows. Rewriting it means rewriting its tests, which turns a UI increment into a test
refactor. New module, old one left alone, both deleted together at 13.

**Framework: none. Ruled consciously under Rev 2's UX direction clause.** The page is a list of
cards and a table over an array. A framework adds a build step to a project that has none, and
§2 explains why a CDN tag is not available to us either.

### The zero-diff boundary

**Deliberately changed:** `public/index.html` (full rewrite), `public/rankFilters.js` (new) and
its tests, one test-harness file for the port-8788 fix.

`scripts/backup-catalog.mjs` was listed here in an earlier draft and **is not work for this
increment**. The tool exists, it is `tools/backup-catalog.mjs` (plus `tools/restore-catalog.mjs`),
and it shipped in `a4167bd` – the same commit gate 7's zero-diff check measures against. §10b.3
already says so; this table did not, and gate 7 is scored off this table.

**Must stay byte-identical vs `a4167bd`:**

| Surface | Proof |
|---|---|
| Everything in `src/` – all nine routes | `git diff a4167bd -- src/` is empty. One command, one second. |
| `public/filters.js`, `public/weight.js` | Same diff check |
| Every existing lane's key-set test, including `/api/rank`'s | Untouched files, suite green |

That is a stronger claim than increment 11 could make and it is checkable in a second, which is
the point.

**Suite:** stays at **757 passing or more, 0 skipped, provably offline-clean**, plus new coverage
for `rankFilters.js` (each predicate, and the two owned/played predicates proven distinct on the
0-hour case). The port fix must not reduce the count – if it removes the branching test, a
deterministic one replaces it.

**The port-8788 bug is fixed here.** Running `npm test` while a `claude-bridge` listens on 8788
turns the suite red at 756/757, because a test probes the real port and branches on the answer.
Increment 12 is the increment where the app gets driven live, repeatedly, on James's own machine
with whatever else he has running – a red suite at the diff gate costs more to explain than the
fix costs to make. Fix: stub the health probe or bind an ephemeral port. `test/` only.

---

## 7. Out of scope – hard, and where I refused

Every deferred idea in this project will try to land on this page. These are the refusals, each
with its reason.

1. **The "all-time greats on deep sale" alert strip** (PRD open question 6). **Refused.** It is a
   second attention-competing surface at the top of the one page whose gate is "one answer,
   nothing touched" – the exact "squished ideas" failure Rev 3 exists to fix. The top-100-of-all-
   time filter (§4.5) covers the browsing need now. Revisit once the gate has passed and we know
   what the page feels like.
2. **Marking a game played, finished, or scoring it** – increment **12.5**, already ruled a
   separate increment in the PRD. Not folded in. "Finished" is not synthesised from playtime.
3. **Any ranking change.** Weights, presets, normalisers, the `experience_score` /`game_score`
   overlap James flagged, the rubric, `hasEnding`, `hoursToValue`. All frozen. The overlap is
   parked for a tuning pass and this is not it.
4. **A wishlist lane, filter or ranking boost.** Badge only – §4.7.
5. **Deck badge and Deck filter.** §4.7 – it needs an upstream fetch that is not on `/api/rank`.
6. **Deleting the six retiring routes and their tests.** §6 – increment 13.
7. **Pagination, `?limit=`, and catalogue caching.** §5 – increment 13, with one stated lever.
8. **The name change.** The PRD parks it "until the answer page exists". It exists at the *end*
   of this increment, so the decision belongs to the next one, with the page in hand.
9. **A JS framework or any new dependency.** §2, §6.
10. **Mobile layout.** Readable at laptop width. Responsive polish is not a gate item and nobody
    is opening this on a phone at localhost.
11. **Any change to `src/`, `src/profile.js`, or the taste vector.** §3.
12. **Hosting, auth, Steam OpenID.** The deploy epic. §1 says what "stranger" means without it.
13. **Any re-fill of the 18,219 LLM-scored rows.** Nothing here triggers one. If something in the
    build would, it stops and reports.
14. **HLTB edition-suffix normalisation, price coverage for the ~16,600 priceless rows, the
    `fpm_catalog` → `game_catalog` rename.** Still parked, still increment 13 or later.

---

## 8. Gates

| # | Gate | Pass condition |
|--:|---|---|
| 0 | **Catalogue backup** | **ALREADY DONE - commit `a4167bd`, 2026-09-04, before this spec was written.** Not work for this increment. `npm run backup` writes `backups/catalog.sql.gz` (3.2 MB, tracked in git so a copy lives off this machine); `npm run restore` refuses without `--force` and verifies every count against a header the dump carries. The round trip was exercised, not assumed: restored into a throwaway database and compared by SHA-256 across all 18,306 rows on appid, experience_score, game_score, has_ending, hours_to_value, experience_reason, tags and rank_exclude_reason - identical. See `backups/README.md`. |
| 1 | **Layout and copy ruled before a page is built** | `01-page-layout-and-copy.md` in the review folder: a wireframe of the landing state, the pick-card anatomy, the **exact on-screen copy for every fixed string**, and the three first-run states. **The build stops for James's ruling.** The words on this page are as load-bearing as the layout, and neither should be discovered at the gate. |
| 2 | **The landing state answers, with nothing touched** | `http://localhost:8787/` with no query string and no clicks renders five picks under `default`, each carrying every slot in §4.1's table. The landing preset is a named constant with a unit test asserting it is `default`. `sale` is unreachable without a click. |
| 3 | **The no-library case is honest** | With `STEAM_API_KEY`/`STEAM_ID` unset: picks still render, the "not matched to your taste" banner shows, the similarity lens is disabled with its reason visible. With credentials set and Steam failing: `notice` rendered verbatim. All three states captured in `03-first-run-states.md`. |
| 4 | **The lenses move, and the browser computes no rank** | Each lens button re-fetches with `?preset=` and the picks change. `public/` contains no blend arithmetic – reviewer-checkable by grep. The two chips behave distinctly on the worked example in §4.3, both named games shown. |
| 5 | **Browse and filters – nothing lost** | The browse section opens one click below the picks. Every filter in §4.5 works over the full pool, with before/after counts per filter in the artifact. Top-100-of-all-time returns the Best-of rule's set and labels its real size. Filter state survives a reload. **The picks are provably unaffected by any filter.** |
| 6 | **Performance, measured not asserted** | Warm first paint of the picks recorded; target under 3 s. Cold time recorded and attributed to increment 13. Payload size recorded. If warm misses, `?limit=` is **proposed to James, not taken**. |
| 7 | **Zero diff** | `git diff a4167bd -- src/` is empty. `public/filters.js` and `public/weight.js` unchanged. All nine routes' key-set tests untouched and green. |
| 8 | **Suite and hermeticity** | Full suite green, ≥757 passing, 0 skipped, offline-clean – **and green with a `claude-bridge` listening on 8788**, proven by running it both ways and showing both counts. |
| 9 | **The stranger drive** | The 10-minute script (§9) run twice: once by James, once by someone who has never seen the app. Pass: the stranger names a game they would play, and says roughly why the page picked it, **before touching any control**. Their words recorded verbatim, including anything they got wrong. |

---

## 9. The 10-minute drive script

Written into `02-drive-script.md` before either run, and both runs recorded in it.

| # | Step | What it tests |
|--:|---|---|
| 1 | Open `localhost:8787`. Say nothing. Ask: *what is this page for, and which of these would you play?* | **The gate.** No control touched. |
| 2 | Ask why they think it picked the first one. | Whether the reason lines and the basis sentence do their job. |
| 3 | Click **Worth buying**. Which would you buy? | The sale lens, and that it is reachable but not the landing state. |
| 4 | Click **More like what I play**. | The third lens. |
| 5 | Tick **Hide games I own**. What changed? | The chip James asked for, and whether the change is legible. |
| 6 | Open **Browse all**. Find a game under $10 at 75% off or better. | Filter bar, and the old Deals tab's job. |
| 7 | Tick **Top 100 of all time**. | The Best of Steam tab's replacement. |
| 8 | Dismiss one game. Reload. | Dismissals persist – the old Dismissed tab's job. |
| 9 | Search a game they know by name. | Search, and whether the numbers on that row read as sane to someone who knows the game. |
| 10 | Ask: *would you use this?* | The thing no assertion encodes. |

Steps 6 to 9 are the "nothing lost" check against the retiring tabs. Step 1 is the gate; the
other nine are the increment.

---

## 10. Open questions – each with a recommendation

1. **Five picks.** *Recommend five*, per §4.1's reasoning. Settled at checkpoint 01 with the
   wireframe in front of you – three and eight are both one number change.
2. **The three lens labels.** *Recommend "Play next" / "Worth buying" / "More like what I play".*
   Ruled at checkpoint 01 along with the rest of the copy.
3. **Word bands instead of a taste-match percentage on the picks.** *Recommend as written* – the
   number means two different things under two different normalisers, and the browse table
   carries the raw number for when you want it.
4. **The wishlist badge.** *Recommend in, badge only, non-blocking.* It closes PRD open question 2
   at near-zero cost and kills a tab. It is also the first thing cut if the build runs long.
5. **Does the stranger see your library and playtimes?** *Recommend yes* – it is your machine,
   you are in the room, and the personalised page is the one the gate is about. The alternative
   (run the stranger pass with credentials unset) tests the taste-blind page, which is a weaker
   test of a weaker thing.
6. **Should the two quick chips persist between sessions?** *Recommend no*, per §4.3 – a
   persisted filter can poison the landing state, and the landing state is the gate.
7. ~~**Does the backup script belong in this increment?**~~ **CLOSED - it was built and committed
   on 2026-09-04 (`a4167bd`) before this spec existed, and the restore was exercised.** The
   approach differs from what this spec proposed and is stronger: a gzipped SQL dump **tracked in
   git**, so a copy leaves the machine, rather than a timestamped sqlite copy sitting on the same
   disk as the thing it protects. No work here.

---

## 11. Constraints

1. **Local-only** (`wrangler dev`, port 8787). No deploy, nothing bound beyond loopback.
   Authentication does not exist; `/api/rank` returns the owner's library and playtimes. Auth is a
   precondition for any deploy and that is the deploy epic, not this.
2. **No ranking changes.** Frozen, §7 item 3.
3. **Nothing that requires re-filling the 18,219 LLM-scored rows.**
4. Suite stays ≥757 passing, 0 skipped, provably offline-clean – and hermetic with respect to
   port 8788 by the end.
5. **No new dependency, no bundler, no CDN.** §2.
6. Fail-soft everywhere: a missing `FPM_DB`, absent credentials, a failed Steam fetch or a failed
   settings write degrades the page to an honest state, never a blank screen and never a lie.
7. Claude Design remains available as design input per Rev 2. Optional – checkpoint 01 is a
   markdown wireframe plus a copy deck either way, so the loop stays self-contained.
8. Append **"use context7"** on any task touching a third-party library API.
9. **En dashes, never em dashes**, in every artifact.
10. Stop before commit. An explicit in-session "commit"/"push" from James is sufficient
    authorisation; never initiate one.

---

## 10b. Rulings – James, 2026-09-04, at scoping

These override the spec text above where they conflict.

**1. TEN picks, not five.** §4.1 argued for five on the grounds that they fit above the fold
with every reason line readable. James chose ten. **Consequence, stated rather than
discovered:** ten cards each carrying a reason line will not fit one laptop screen, so the
landing state now involves scrolling. That does not breach the gate - scrolling is not touching
a control - but the "one screenful" argument in §4.1 no longer holds and should not be quoted as
though it does. The card design should be tightened accordingly: ten tall cards is a list, and
the thing that keeps ten reading as an answer is that each card stays scannable. Make the count
a named constant so it is one number to change at the checkpoint.

**2. The stranger sees the real library and playtimes.** Open question 5, recommended and
accepted. It is James's machine and he is in the room. The personalised page is the one the gate
is about; running the pass with credentials unset would test the taste-blind fallback, which is
a weaker test of a weaker thing. The no-library states in §4.6 still get built and still get
verified - just not by the stranger pass.

**3. Gate 0 is closed before this increment starts.** The catalogue backup and its exercised
restore shipped in `a4167bd` on 2026-09-04, before this spec was written. See §8 and open
question 7.

---

## 10c. Copy rulings – James, 2026-09-05, at the layout checkpoint

**1. Taste match comes OFF the pick cards.** Measured on the real top ten under `default`:
six read "Strong" and four read "Very strong". Across the top 60 it is 36 / 23 / 1. It cannot
be otherwise - the top of the list **is** the best-matching set, so the slot repeats itself and
reads as filler while looking like information. The raw `similarityNorm` stays in the browse
table, where the full 0-to-1 range is visible and a column of numbers is what the reader is
there for. The thresholds were NOT moved to manufacture variety, which would have been the
dishonest fix. Frees a line on a card §10b already requires to stay scannable.

**2. The Steam-down banner gets a plain sentence first, with the verbatim `notice` beneath it
as technical detail.** §4.6 said render `notice` verbatim and `src/` is frozen, so the string
cannot be rewritten at source - but it says "taste profile", "similarity is 0" and "lens",
three phrases a first-time reader has never met. Gate 3 still finds the exact string on the
page, so nothing is hidden; it is just no longer the first thing a stranger reads.

**3. Loading copy is "Reading the game catalogue…" with no count.** The spec's
"Reading 18,306 games…" needs a number that only arrives with the payload, so it would have to
be hardcoded and would drift at the next crawl.

**4. Four copy corrections the Coder raised, all accepted.**
- The basis sentence is rewritten in a reader's words. "Complete experience per hour" is this
  project's vocabulary, not a stranger's.
- "About 9 hours" becomes "About 9 hours to finish", so it cannot be misread as playtime.
- "Endless - no ending, so no per-hour figure" drops the second clause; it explains arithmetic
  the reader never saw.
- "No price on file" is rewritten without "on file", which describes our filing system rather
  than the game. **This string renders on roughly 16,600 of 18,306 rows**, so it is the most
  frequently read sentence on the site after the reason lines.

**5. The footer numbers in §4.1 were illustrative and are wrong.** The real funnel is
4,186 low-confidence / 109 prologues / 85 non-game / 2 unscored, summing exactly to 13,924 of
18,306. The footer generates from `funnel` and suppresses any zero row.

---

## ⛩ REVIEW

**Gate TLDR:** someone who has never seen this app opens `localhost:8787`, touches nothing, and
can name a game they would play tonight and say roughly why the page picked it – and the same
page, with no Steam library behind it, says so plainly instead of quietly serving taste-blind
picks that look normal.

**Output (what James holds while reviewing):**

1. `01-page-layout-and-copy.md` – the wireframe, the pick-card anatomy, and the exact on-screen
   copy for every fixed string. **Pre-build checkpoint: opened before a line of the page is
   written, and the build stops here for your ruling.**
2. **The running page at `http://localhost:8787/`** – the landing state, nothing touched. Five
   picks, the lens strip, the footer.
3. `02-drive-script.md` – the 10-minute script, with both runs written into it: yours, and the
   stranger's, verbatim including whatever they got wrong. **The gate artifact.**
4. `03-first-run-states.md` – the three first-run states side by side: library present, no
   credentials, Steam down.
5. `04-lens-and-chips.md` – the five picks under each of the three lenses, and the worked
   owned/played example naming the 0-hour game that survives one chip and not the other.
6. `05-browse-and-filters.md` – the browse list, each filter's before/after row count, and the
   top-100-of-all-time set with its real size.
7. `06-performance-and-diff.md` – warm and cold first-paint timings, payload size, and the empty
   `git diff a4167bd -- src/`.
8. `07-catalogue-backup.md` – where the backup lives, its size, and the restore that was actually
   run.

Item 1 is a pre-build checkpoint. Per review protocol Rule 3 the Coder writes it into the review
folder as part of the work and halts – James is never asked to review from a chat message, a
scratchpad or a code block.

**Review folder:** `~/code/review/steam-sale-scout/inc-12/`
**Index:** `/AI/projects/personal-projects/steam-sale-scout/reviews/inc-12.md`

**Decision this gate needs:** the answer page becomes the product's front door and the old tabs
are gone for good – or the picks section goes back for another pass before the routes are deleted
at increment 13.
