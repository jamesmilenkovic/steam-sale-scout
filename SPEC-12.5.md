# Increment 12.5 – Played and finished

> **Note added 2026-09-14 (increment 14):** this spec refers to routes that no longer exist.
> `/api/library`, `/api/deals`, `/api/recs`, `/api/best-of` and `GET /api/fpm` were deleted at
> increment 14 and now answer `501 not implemented`. Nothing below has been rewritten - this
> file stays the record of what was true when it was approved.

**Scoped:** 2026-09-05 · **Status:** APPROVED by James 2026-09-05 
**Base:** `experience` @ `ecd500e` (increment 12, stranger gate passed 2026-09-05)
**PRD:** `PRDs/2-in-progress/2026-07-04-steam-sale-recommender.md` – **Rev 3, Phase 5, increment
12.5**, the **"Increment 12.5 evidence, measured 2026-09-05"** block and its two rulings, the
seven **increment 10 rulings**, and the **increment 11 outcome** block. All binding. None
re-opened here.

---

## 1. The one sentence, and the number that justifies the increment

James clicked "Hide games I've played" and Portal stayed on screen, because Steam has no record
that he ever played it and never will.

**297 owned games return `playtime_forever: 0`, `rtime_last_played: 0` and zero on every
platform.** Steam began recording playtime in March 2009; Portal shipped in 2007. That data was
never captured. No API work conjures it, no vendor fixes it, and it is roughly 45% of the 342
zero-hour games in an 18-year-old library. **Marking a game played is the only mechanism that can
know the truth about those 297.** That is the whole argument for this increment and everything
below is subordinate to it.

A second, smaller thing is also true and is our own fault. `GetOwnedGames` returns
`rtime_last_played` and `playtime_disconnected` without being asked. **45 owned games have zero
playtime and a real last-played date** – *NieR:Automata* (March 2025), *Sundered* (June 2025),
*The Sexy Brutale* (April 2026) – and a further 42 carry `playtime_disconnected > 0`.
`src/worker.js`'s `trimGame` already carries `rtime_last_played` and nothing reads it;
`playtime_disconnected` is not carried at all. **Per James's ruling of 2026-09-05, that fix lands
here rather than as a separate patch**, because this increment owns the question "have I played
this" and would otherwise answer it two different ways in two different places over the same code.

**User story.** As someone with an eighteen-year-old Steam library, I want to tell the app that I
played a game and whether I finished it, so that the games it recommends to me tonight are not
games I finished in 2008 and the answer page stops being wrong about my own history.

---

## 2. What this increment is NOT, stated before anything else

**`src/profile.js` is not touched, and `finished` does not feed the taste vector this round.**

This is the loudest thing in the spec because question 3 was the one most likely to be answered
by drifting into it. Three reasons, in order of weight:

1. **On day one of this increment the `finished` column has zero rows in it.** Wiring an empty
   signal into the taste engine is a change with no measurable benefit and a real risk. There is
   nothing yet to tune against, and the increment 10 rulings are the standard here: every ranking
   decision this project has made well was made against measured evidence from a filled column.
2. **Touching `buildProfile` moves every similarity number under all three lenses**, which
   invalidates the increment 11 eye test the entire product currently rests on ("*the DATA looks
   good … the recommendations are all games I'd be interested in checking out*"). `src/profile.js`
   has been explicitly out of bounds in SPEC-11 §4.3 and SPEC.md §7.11 for three increments. It
   stays out of bounds.
3. **It is a clean product boundary, not just caution.** This increment records **facts** – did I
   play it, did I finish it. Feeding a personal opinion into ranking is the **opinions** increment,
   and a personal score belongs there too (§8, question 1). Splitting on facts-versus-opinions
   keeps this increment small and gives the later one a filled column and a real before/after.

**What the later increment must show before it changes a weight:** at least ~50 real marks in the
database, a top-50 diff under all three lenses with James's eye on it, and a stated rule for what
"finished" is worth relative to playtime. None of that exists today.

**Consequence, enforced not intended:** marks never filter `/api/rank`'s pool and never enter any
score. Unlike dismissals, which are excluded server-side so a dismissal frees a slot, a mark rides
on the row as data and only the browser acts on it. Gate 5 proves this by diffing the top 50 with
and without twenty marks present in the database.

---

## 3. Prior art / what already exists

Per the prior-art protocol's per-capability rule, the product landscape (Valve's Interactive
Recommender and Play Next, ITAD, GG.deals, SteamDB, SteamPeek, Deku Deals) is in the PRD's
Landscape table and Rev 3 evidence item 10, and increment 12 §2 covered table and list libraries.
Neither is re-walked. **This section covers the new capability only: per-game user state and a
personal backlog.** It is well-trodden ground and it deserves an honest look rather than a
sentence.

**TLDR:** every serious backlog tracker independently landed on **more than two states**
(Playing / Completed / Retired / Abandoned / Shelved) and on a **personal rating**, which says
James's played-plus-finished ruling is the right floor rather than the finished shape. Nothing is
adoptable as code, because every candidate is a hosted service with no writable API and the thing
we are storing is definitionally ours. **Build.** The one finding that could have changed the plan
is Steam's own `GetPlayerAchievements`, and it is a probe for a later increment, not a build for
this one.

| What | Type | State | What it does well | Why it isn't the answer |
|---|---|---|---|---|
| [Backloggd](https://backloggd.com) | Hosted web app | Live, active, large community | The closest existing product by a distance. Per-game log with **five** states (Playing, Completed, Retired, Shelved, Abandoned), a 0–5 half-star personal rating, a review field, and a Steam library import. The vocabulary is proven at scale. | It is a social catalogue you curate by hand. It ranks nothing for you, knows no prices and has no taste model. No public write API, so it cannot be a store for us – and even if it had one, it would put the only irreplaceable data in this project behind someone else's account. |
| [HowLongToBeat](https://howlongtobeat.com) user lists | Hosted web app | Live; we already consume its unofficial `/api/bleed` for length | Per-game states (Playing / Completed / Retired / Backlog) **plus your own reported completion time**, which is directly adjacent to `hours_to_value`. Proof that "how long it took *you*" is a thing people will type in. | Community-times database first, tracker second. No recommender, no prices, no taste. The API is unofficial, IP- and UA-bound and drifts – the PRD's standing risk section already flags it as hobby-grade, and writing user state to it would be worse than reading length from it. |
| [GG.deals](https://gg.deals) collection | Deal site | Live | The only deal site that syncs Steam **playtime**, per the PRD Landscape row. Nearest thing to per-game user state on a price tool. | Playtime is bookkeeping used to sort your own shelf. No played/finished distinction, no way to assert play the platform did not record – it has exactly our bug and no fix for it. |
| [Grouvee](https://grouvee.com) / [IGDB](https://igdb.com) lists | Hosted web apps | Live | Shelf model plus rating; IGDB has a real API and a game identity graph. | Both are catalogues you curate. IGDB's API is read-first for game metadata, not a user-state store for a third-party app, and we already have game identity from Steam appids. |
| **Steam itself – "mark as played"** | Platform | **Does not exist** | Steam offers library categories, favourites and "hide this game", none of which is a play assertion and none of which `GetOwnedGames` returns. | **This is the load-bearing negative finding.** There is no upstream fix. The 297 cannot be repaired at the source, which is why this feature is a data mechanism rather than a convenience. |
| Valve's **Play Next** shelf | Platform feature | Live since 2020 | Surfaces unplayed owned games – closest platform feature to our picks section. | Infers "unplayed" from the same zero-playtime field that is wrong for our 297, so it has the identical blind spot. PRD Rev 3, evidence 10. |
| Steam Web API [`GetPlayerAchievements`](https://partner.steamgames.com/doc/webapi/ISteamUserStats) / `GetUserStatsForGame` | Official API, keyed, our own account | Live | **The one genuinely tempting automatic source.** One unlocked achievement is hard evidence of play; 100% unlocked is strong evidence of finished. Free, official, documented, our own data. | Three problems, and the third is fatal for our use. It is a **per-appid rate-limited crawl** over 552 games with its own resumability, coverage funnel and gate – the exact shape of increments 9 and 10, and folding it in doubles this increment. It errors for any game with no achievement schema. And **achievements are a post-2007 mechanism that most of the 297 pre-date**, so predicted coverage is worst precisely where the gap is. **Probe-first candidate for a later increment (§8, question 5). Predicted-poor, unmeasured – that prediction is the thing a probe would settle.** |

**Reusable pieces: none as code. Two things as knowledge, both free.**

1. **The state vocabulary.** Backloggd and HLTB converged independently on Playing / Completed /
   Retired-or-Abandoned / Backlog. James's two states are the correct **floor** – played and
   finished are the two that change what to play next – but "started and abandoned" is the likely
   third state, and the schema in §5 is shaped so it costs one nullable column when he wants it.
   Named, not built.
2. **A rating always ships alongside the states, never instead of them.** Every tracker surveyed
   has both. That is evidence the personal score is a real ask, and also evidence it is a
   *companion* to the states rather than a substitute – which is exactly why it can wait one
   increment without stranding anything (§8, question 1).

**What nobody has done:** use a played/finished mark as an **input to a ranking that also knows
what a game is worth per hour and what it costs today**. Every tracker surveyed is a shelf you
curate; every deal site is a grid you filter. The PRD's white space is intact, and this increment
is the piece of it that repairs the app's single largest factual error about its own user.

**Build vs adopt: build.** No measured probe was run and none could change the answer, per the
protocol's build-vs-adopt rule: the candidates are hosted services with no writable API, and the
storage is one D1 table that mirrors `dismissals` almost line for line. A probe that cannot change
the decision is not worth the increment. **The trigger that reopens this:** wanting a personal
rating with reviews and a public profile, or wanting import from an existing Backloggd/HLTB
account. Either one and the survey gets re-run with import in mind.

---

## 4. Scope – exactly what gets built

Four things. **This increment does touch `src/`**, unlike increment 12, and the boundary is drawn
by key-set diffs instead (§7).

1. **`src/marks.js`, new.** The D1 CRUD for per-game marks plus one pure `derivePlayed()`
   function, mirroring `src/dismissals.js` in shape, header-comment discipline and fail-soft
   posture.
2. **`src/worker.js`.** Four edits, nothing else: `trimGame` carries `playtime_disconnected`; the
   library cache key gets a version segment; `/api/rank`'s row build gains four derived fields;
   two new routes are wired.
3. **`public/index.html` + `public/rankFilters.js`.** The two per-card toggles, the changed
   meaning of "Hide games I've played", the play-state select in the browse filter bar, the new
   status-line strings, and the "Games to check" list.
4. **`tools/backup-catalog.mjs`.** One word: `game_marks` joins `TABLES`. **Marks are the only
   data in this project that cannot be re-fetched from anywhere** – the catalogue, prices, tags,
   the LLM scores and the library can all be rebuilt from an API or a fill, and a mark cannot.
   Leaving it out of the backup would be the one genuinely unrecoverable data loss the project is
   capable of.

### 4.1 The 45 – our bug, fixed

| Step | Change |
|---|---|
| `trimGame` (`src/worker.js:115`) | Add `playtime_disconnected`. `rtime_last_played` is already carried and already unread. |
| The library cache | `libraryCacheKey` gains a version segment. **A 24h-cached payload written before this change has no `playtime_disconnected` field**, and a stale cache would silently produce "no play recorded" for a game we just learned about. A version bump is one line and removes the trap; asking James to remember `?refresh=1` does not. |
| `derivePlayed()` in `src/marks.js` | Pure, taking `(libraryGame, mark)` and returning `{played, finished, playedSource, lastPlayedAt}`. Testable without D1 or a network. |

**`playtime_disconnected` is used as a played SIGNAL only and is never added to `hoursPlayed`.**
Deliberate refusal. We do not know whether Steam's disconnected figure is already inside
`playtime_forever` or additional to it, and adding an unverified number to a figure the page
already renders ("17 hours played") is exactly the class of quiet lie increment 12's review caught
four times. **Gate 1 measures whether the 42 disconnected rows sit inside or outside the 45**, and
that measurement is an artifact James reads, not an assumption the code makes.

### 4.2 Who wins – Steam versus the user

The rule, and it is one sentence: **the user can add a fact Steam does not have, and never
contradicts one Steam does have.**

`played` is true if **any** of these is true, checked in this order, which is also the order that
decides `playedSource`:

| Order | Condition | `playedSource` |
|--:|---|---|
| 1 | `playtime_forever > 0` | `steam-playtime` |
| 2 | `playtime_disconnected > 0` | `steam-disconnected` |
| 3 | `rtime_last_played > 0` | `steam-last-played` |
| 4 | mark `played = 1` or `finished = 1` | `you` |

`finished` comes from the mark and from nothing else. Steam cannot know it and never will.

**There is no "mark as not played" that overrides a positive Steam playtime.** The control's third
state clears the mark rather than asserting a negative. Reason: we cannot tell a deliberate denial
from a mis-click, the case it would serve (a family member played it, it was left running) is far
rarer than the 297, and a user-asserted negative over a measured positive is the one direction
where this feature could make the data *worse*. **Named as a refusal.** If it turns out to matter,
it is one more state later.

**Does the page ever show both? Yes, always, when both exist.** §6's status-line table is the
concrete answer, and the case that matters is `In your library – finished · 17 hours played`:
Steam's number and James's verdict on one line, neither hidden.

### 4.3 The API – two paths, the pair dismissals already has

| Route | Behaviour |
|---|---|
| `GET /api/marks` | `{ marks: [{appid, name, played, finished, updated_at}] }`, newest first. |
| `POST /api/marks` | Body `{appid, name, played, finished}`. **A full-state upsert, not a toggle** – idempotent, so a double-click or a retry cannot flip the state. |
| `DELETE /api/marks/:appid` | Clears the mark. A no-op, not an error, if none exists. |

Fail-soft exactly as `/api/dismissals` does: a missing `FPM_DB` binding or a D1 throw returns
HTTP 200 with an honest empty/false body rather than a 500. **But the write path must not fail
silently in the UI** – increment 12's review caught "Undo failed / said nothing at all", and the
same defect here would let James believe a game is marked when it is not. A failed mark reverts
the toggle on screen and says so.

---

## 5. Schema

One new table, in the same D1 as everything else (`env.FPM_DB`), per the project's single
persistence story.

```sql
CREATE TABLE IF NOT EXISTS game_marks (
  appid      INTEGER PRIMARY KEY,
  name       TEXT,
  played     INTEGER NOT NULL DEFAULT 0,
  finished   INTEGER NOT NULL DEFAULT 0,
  marked_at  INTEGER,
  updated_at INTEGER
)
```

`ensureMarksSchema(env)` on the request path, idempotent and cheap, same convention as
`ensureDismissalsSchema` and `ensureSettingsSchema`.

**Why a new table and not an extension of `dismissals`.** Three overlapping-but-distinct user
verdicts now exist and the differences are structural, not cosmetic:

1. **They mean opposite things.** A dismissal is *"not interested"* – a verdict about a game you
   have **not** played. A mark is *"I have played this"*. Merging them makes NULL mean three
   different things in one row.
2. **They have opposite lifecycles.** Un-dismissing DELETEs the row, by design
   (`src/dismissals.js` header: *"data IS allowed to go away here"*). A mark is a durable record
   of personal history and is the one irreplaceable thing in the database. A shared table makes an
   undo-dismiss delete a play history.
3. **They act at different layers.** Dismissals filter `/api/rank`'s pool server-side so a
   dismissal frees a slot. Marks must not touch the pool at all (§2). One table with two opposite
   server-side behaviours invites exactly the leak gate 5 exists to catch.

Two lanes, two tables, one module each is also the existing convention – `settings` and
`dismissals` both landed that way in increment 8.

**Why two columns and not one status enum.** James ruled played and finished are *"two separate
states, not one flag"*. An enum is one flag with three values. Two columns reads as the ruling
does, and the prior-art finding that every mature tracker ends up with four or five states says
the third one arrives eventually – as one more nullable column, not a re-encoding of an enum.

**One invariant, enforced server-side and tested: `finished = 1` implies `played = 1`.** You
cannot finish a game you never played. `POST /api/marks` normalises this on write rather than
trusting the client, so the impossible row cannot exist in the table.

**No `rating` column and no speculative `user_id` column.** Both refused. The rating is a later
increment with an unanswered design question (§8, question 1) and SQLite adds a nullable column in
one statement when it is wanted. `user_id` is untested scaffolding on a single-user app; when auth
lands, `settings`, `dismissals` and `game_marks` all take the same key in the same migration and
one shape is designed once against a real auth model rather than three times against a guess.

---

## 6. What the UI shows

**The constraint governing all of it: increment 12's gate must still pass.** *A stranger can land
on the front page and get a usable answer without touching a single control.* Marking games is the
opposite kind of feature, so every control below is either secondary weight on a card or inside
the collapsed browse section.

### 6.1 The pick card – one row gains two words

The card carries title, status, why, length, experience value, tags and two actions. It gains
**two toggle buttons in the existing actions row**, at secondary weight, smaller than "View on
Steam":

```
View on Steam  ·  Played  ·  Finished  ·  Not interested
```

Pressing **Finished** sets both (the invariant). Pressing an active toggle clears it. The card is
not otherwise restructured – §10b.1 of increment 12 requires ten cards to stay scannable and this
must not be what breaks that.

**Two alternatives considered and refused.** A hidden "Mark…" menu (worse discoverability, an
extra component, one more click on the interaction this increment exists to make cheap). Marks in
the browse table only (refused because the 297 problem is *discovered* on the front page – that is
literally how this increment got triggered, with Portal sitting in James's picks).

### 6.2 The status line – six cases, and one of them is currently a lie

`statusLine()` in `public/rankFilters.js` is where this lands, next to the strings James already
ruled on at the increment 12 checkpoint.

| Case | Renders |
|---|---|
| Owned, Steam hours > 0, no mark | `In your library – 17 hours played` *(unchanged)* |
| Owned, Steam hours 0, `rtime_last_played` set | `In your library – played, hours not recorded` |
| Owned, Steam has nothing, marked played | `In your library – played (you said so)` |
| Owned, marked finished, Steam hours known | `In your library – finished · 17 hours played` |
| Owned, marked finished, Steam has nothing | `In your library – finished (you said so)` |
| Owned, Steam has nothing, no mark | `In your library – no play recorded` ← **changed** |

**That last line is a copy fix and it is the honest one.** Today the page says *"never played"*
for a game with zero playtime, and for **297 owned games that is a false assertion the app has no
basis for**. Steam's 0 means "no record", not "never played" – the 297 are the proof. This is the
same defect class the Coder caught during increment 12, where `hoursPlayed: null` rendered as
"never played" and Portal 2 with 17 hours on it read *"In your library – never played"*: null is
*unknown*, 0 is *no record*, and neither is *never*. **James rules on this string at checkpoint 01
(§8, question 2).**

`"(you said so)"` is a first draft and is deliberately in the checkpoint rather than settled here.
Whatever it becomes, the requirement is fixed: **the page must never present a user mark as though
Steam measured it.**

### 6.3 "Hide games I've played" – the chip that started this

`passesHidePlayed` changes from `(row?.hoursPlayed ?? 0) <= 0` to `row?.played !== true`, reading
the derived field from §4.2. That is the whole fix, and it is what makes Portal disappear.

**Still two chips on the landing state, not three.** No "hide finished" chip: `finished` implies
`played`, so hiding played already hides finished, and a third control in the first screenful buys
almost nothing against a gate that is a sentence about touching nothing. The finer question lives
one click below.

### 6.4 The browse filter bar – one new control

A **play-state select**, four values, inside the collapsed browse section where it costs the
landing gate nothing:

| Value | Meaning |
|---|---|
| All *(default)* | – |
| Not played | `played !== true` |
| **Played, not finished** | `played === true && finished !== true` |
| Finished | `finished === true` |

**"Played, not finished" is the backlog query** – the one thing every tracker in §3 exists to
answer, arriving here as one option in one select over a list that is already ranked. It joins the
existing `rankFilters` settings blob as `playState`, so there is no new settings key and
`normaliseFilters` handles an older saved shape as it already does.

The browse table's "Yours" column reads from `playedFragment`, which already exists and already
distinguishes null from 0 – it gains the mark-derived cases and the two toggles per row.

### 6.5 "Games to check" – making 297 tractable

**The honest answer to "does he mark them one at a time forever" is: one at a time, but he only
ever needs to mark the ones that reach the top.**

An unmarked game costs exactly one thing: it can appear as a pick for a game he has already
played. So the work is bounded by the top of the ranking, not by the size of the library. A small
list inside the browse section – **owned games with no play record and no mark, in current rank
order** – turns "297 games" into "the fifteen of them that are actually in your way".

**The Coder measures the real number at build time and it goes in the artifact:** how many of the
297 appear in the top 50, the top 200 and the top 1,000 under the `default` lens. That number, not
297, is the size of the job, and gate 10 has James run it with a stopwatch.

**Refused: bulk import, CSV, and achievement inference.** §3 covers the trackers (no writable API,
and importing means putting the one irreplaceable table behind someone else's account).
`GetPlayerAchievements` is the tempting one and it is a probe for a later increment, not a build
for this one – §8, question 5.

---

## 7. Out of scope – hard, and where I refused

1. **Any change to `src/profile.js` or the taste vector.** §2. The loudest line in this spec.
2. **Any ranking change** – weights, presets, normalisers, the blend, pool membership, the
   `experience_score`/`game_score` overlap. Frozen, and gate 5 proves it rather than asserting it.
3. **Marks filtering `/api/rank`'s pool server-side.** They ride on the row; the browser filters.
   This is the specific leak that would break item 2 by a side door.
4. **A personal score or rating.** §8 question 1. No column, no UI, no route.
5. **A third state** (abandoned / playing / shelved / backlog). §3 says it is coming; not now.
6. **Achievement-based inference.** §6.5, §8 question 5.
7. **Import from Backloggd, HowLongToBeat, Grouvee, or a CSV.** §3.
8. **A user-asserted "not played" that overrides positive Steam playtime.** §4.2.
9. **Adding `playtime_disconnected` into `hoursPlayed`.** §4.1 – measured first, in gate 1, and
   still not merged into a displayed number this round.
10. **A speculative `user_id` column.** §5.
11. **Auth, hosting, deploy, Steam OpenID.** §9.
12. **Any re-fill of the 18,219 LLM-scored rows.** Nothing here triggers one. If something in the
    build would, it stops and reports.
13. **`?limit=`, catalogue caching (`src/catalog.js:493`), price coverage for the ~16,600
    priceless rows, the `fpm_catalog` → `game_catalog` rename.** Increment 13.
14. **Deleting the six retiring routes and their tests.** Increment 13, as increment 12 ruled.
15. **The three open items from increment 12** – a failed lens click wiping the picks, the undo
    toast sitting under the tenth card, `/api/rank`'s 10.1 MB payload. Known, captured, not this.
16. **The name change.** Still parked.
17. **Mobile layout.** Readable at laptop width, as before.

**Where I refused, in one place, because James asked for it explicitly:** items 1, 3, 4, 6, 8 and
9. Items 1 and 3 are the same refusal seen from two sides and are the reason this increment can be
approved without re-opening increment 11. Item 4 is the one James might overturn, and §8 question
1 is where he does it.

---

## 8. Open questions – each with a recommendation

1. **Is the personal score in this increment?** *(James's original words: "possibly give a score
   directly as well later".)* **Recommend OUT, as its own increment.** Four reasons. His own
   framing was "possibly" and "later". A score pays nothing back until dozens of games carry one,
   whereas played/finished pays back on the first click. It has a genuinely unanswered design
   question – what a personal 78 means sitting beside `experience_score` 98 and `game_score` 93,
   which is three opinions from three judges on one card, and deciding which wins in the ranking
   **is** a ranking change, which is frozen. And the score's real value is as a taste-vector input,
   which is deferred anyway, so the two belong in the same later increment against filled columns.
   **Overturn cost if he disagrees:** one nullable column, one control, and this increment stops
   being small.
2. **Does `"never played"` become `"no play recorded"` for owned zero-record games?**
   **Recommend yes.** It is a false assertion on 297 rows today and it is the same null-versus-zero
   defect class already caught once in this codebase. The counter-argument is real and worth
   hearing: for a 2019 game with zero hours, "never played" is almost certainly true and is the
   friendlier sentence. We cannot cheaply tell the two apart, and the safe wording is the honest
   one. **Ruled at checkpoint 01, with both strings on screen.**
3. **Two toggles on the card, or a menu?** **Recommend two toggles**, §6.1. A menu hides the
   interaction this increment exists to make cheap. Ruled at checkpoint 01 with the before/after
   card side by side.
4. **Does marking a game finished hide it from the picks by default?** **Recommend NO – off by
   default.** James's standing ruling from the increment 11 eye test is that owned games are
   first-class and anything hiding them by default breaks a stated requirement. A finished game is
   also the strongest future taste signal, so it must stay visible. The chip is there for when he
   wants it.
5. **Probe `GetPlayerAchievements` as an automatic backfill?** **Recommend: not now, and not as a
   probe inside this increment either – defer to a later probe-first increment.** A probe cannot
   change what gets built here, and predicted coverage is worst on the 297 because they pre-date
   achievements. But the prediction is unmeasured, and if James wants the number before committing
   to hand-marking, a half-day probe over 50 named owned games would settle it. **His call; the
   recommendation is defer, and either way the finding goes in the result file so it is not lost.**
6. **Should the marks table be exportable beyond the git-tracked backup?** **Recommend no, the
   backup is enough** – `game_marks` joins `TABLES` in `tools/backup-catalog.mjs` (§4.4), the dump
   is gzipped and tracked in git so a copy leaves the machine, and the restore verifies counts
   against the header. A separate export is a second mechanism for the same job.
7. **Is the increment 12 stranger drive re-run in full?** **Recommend no – a card-level check
   instead.** The stranger's job was to prove the page answers without controls touched, and two
   secondary toggles on a card cannot make it answer less. Gate 9 pays the honest cost with a
   before/after card capture and James's own re-run of steps 1 and 2 of the existing drive script.
   Booking a second stranger for two buttons is gold-plating.

---

## 9. Constraints

1. **Local-only** (`wrangler dev`, port 8787). No deploy, nothing bound beyond loopback, no CORS
   headers, `npm run deploy` still hard-exits.
2. **Auth remains a precondition for any deploy, and this increment hardens that rather than
   changing it.** Restated plainly because this increment adds per-user data: `/api/marks` is an
   **unauthenticated write endpoint**, the same class as `/api/dismissals` and `/api/settings`
   before it. The risk class does not change – it was already true that anyone reaching
   `localhost:8787` can read James's library, playtimes and dismissals and write dismissals. The
   blast radius grows by one table, and that table holds the only unrecoverable data in the
   project. **The condition therefore does not change but its stakes do**, and that sentence
   belongs in the deploy epic's first item alongside Steam OpenID.
3. **No ranking changes.** §7 item 2.
4. **No re-fill** of the 18,219 LLM-scored rows.
5. **Suite stays at ≥798 passing, 0 skipped, provably offline-clean, with no subprocess spawns**,
   plus the new coverage in §10 gate 8. Nothing here weakens any of those four properties.
   **AMENDED by James 2026-09-05.** This originally read *"`tools/backup-catalog.mjs` spawns
   `sqlite3` and is exercised by hand at gate 0, never by the suite."* QA added
   `test/backup-restore.test.mjs`, which does spawn it - and those four tests are the only
   automated proof that the backup protecting 18,219 LLM-scored rows still works, including
   the SEC-3 regression where adding a lazily-created table made the whole backup write
   nothing. **The rule was protecting fast and hermetic, not "no binary ever", and these
   tests are both** - they copy the tools into a temp directory whose `.wrangler/` and
   `backups/` are their own, so nothing touches the real state. The property now reads:
   **no NETWORK access and no spawning of the app's own services; `sqlite3` is permitted
   where a tool under test genuinely shells out to it.** Those tests **fail loudly** without
   the binary rather than skipping, because a skip renders as green and "0 skipped" is a
   number reviewers rely on.
6. **`public/index.html` has no test coverage of its own, by design.** The seam is
   `public/rankFilters.js`, and every testable thing in §6 lands the right side of it:
   `passesHidePlayed`, the play-state predicate, `statusLine`, `playedFragment`, `ownedCell`.
   Render order, the toggle's position on the card and the toast are provable only by live capture.
7. Fail-soft everywhere: a missing `FPM_DB`, an absent mark, a stale library cache or a failed mark
   write degrades to an honest state, never a blank screen and never a lie.
8. Append **"use context7"** on any task touching a third-party library API.
9. **En dashes, never em dashes**, in every artifact.
10. Stop before commit. An explicit in-session "commit"/"push" from James is sufficient
    authorisation; never initiate one.

---

## 10. Gates

| # | Gate | Pass condition |
|--:|---|---|
| 0 | **Catalogue backup taken first** | `npm run backup` run against the current database **before any schema change**, and the dump's row counts recorded. One command. The increment adds a table to a database that holds 18,219 LLM-scored rows. |
| 1 | **The 45 come back, and the 42 are explained** | `02-the-45.md`: the named list of owned games recovered by reading `rtime_last_played`, each with its date, including *NieR:Automata*, *Sundered* and *The Sexy Brutale*. Plus the measurement §4.1 demands: **are the 42 `playtime_disconnected > 0` rows inside the 45 or additional to them?** Before/after counts of owned games reading "no play recorded". |
| 2 | **Portal disappears** | The literal trigger, closed. `03-portal-disappears.md`: Portal in the picks, marked played, "Hide games I've played" ticked, Portal gone. Reload – still gone. Captured, not described. |
| 3 | **Played and finished are two states** | `04-played-vs-finished.md`: one named game marked played and one marked finished behave differently under the browse play-state select, all four values exercised with before/after row counts. The `finished ⇒ played` invariant proven at the API, including a `POST` of `{played: 0, finished: 1}` that stores `played = 1`. |
| 4 | **Steam and the user are both shown, and neither is disguised as the other** | `05-status-lines.md`: all six §6.2 cases rendered live, side by side, each with the named game producing it. No line presents a mark as a measurement. |
| 5 | **The ranking is frozen, and the marks cannot reach it** | `06-ranking-frozen.md`: `/api/rank?preset=` captured for all three lenses **before any mark exists** and again **with twenty marks in the database**, same `wrangler dev` session, `ITAD_API_KEY` unset so the historical-low premium cannot make the run non-deterministic. Identical appid sequence and identical `rankScore` for the top 50 under each lens. Plus `git diff ecd500e -- src/profile.js` empty, and `src/rank.js` unchanged. |
| 6 | **A failed write says so** | The mark toggle reverted on screen with a visible message when `POST /api/marks` fails, proven by forcing the failure. Increment 12's review caught this class four ways; it does not come back. |
| 7 | **The diff is bounded to two key sets** | `08-diff-and-suite.md`: exactly **two** route key-set tests change – `/api/library` (gains `playtime_disconnected`) and `/api/rank` (gains `played`, `finished`, `playedSource`, `lastPlayedAt`). The other eight routes' key-set tests are untouched and green, shown by an empty diff on those files. The library cache-key version bump is in the diff. |
| 8 | **Suite and its four properties** | Full suite green, **≥798 passing, 0 skipped, offline-clean, no subprocess spawns**, plus new coverage: `derivePlayed()` over all four precedence cases and the Portal all-zeros case; the `finished ⇒ played` invariant; `passesHidePlayed` on the derived field; the play-state predicate on all four values; every new string in §6.2. |
| 9 | **The landing state still answers with nothing touched** | `09-card-before-after.md`: the pick card before and after, side by side, and James's own re-run of steps 1 and 2 of increment 12's drive script. Pass = the page still answers, and the ten cards are still scannable per §10b.1. |
| 10 | **The backlog is tractable, measured not asserted** | `07-backlog-pass.md`: how many of the 297 appear in the top 50, top 200 and top 1,000 under `default`. James marks twenty games from the "Games to check" list, **timed**. The same three counts re-measured after. Pass = the top 50 is clean and the elapsed time is one sitting, not a project. |

---

## Rulings – James, 2026-09-05, at scoping

**1. `"never played"` becomes `"no play recorded"`.** The current string is **flatly false on
45 owned games** Steam holds a `rtime_last_played` for, and **unknowable on the other 297**
where Steam has no data at all. It is the same null-versus-zero mistake the Coder already
caught once in increment 12 (`hoursPlayed: null` rendering as "never played", so *Portal 2*
with 17 hours on it read "In your library - never played"), one layer up: there the bug was
confusing *unknown* with *zero*, here it is confusing *no record* with *did not happen*.
"No play recorded" is true in both cases and claims nothing the page cannot support.

**2. A personal score is OUT of this increment.** Accepted as recommended. James's original
words were *"possibly give a score directly as well later"* - "possibly" and "later". It pays
nothing back until dozens of games carry one, and deciding what a personal 78 means beside an
`experience_score` of 98 **is a ranking change**, which every ruling since increment 11 has
frozen. This increment records facts; opinions and their effect on ranking are a later,
separate decision.

**3. Approved to build**, 2026-09-05, including the §2 freeze on `src/profile.js` and the
`game_marks` table as specified rather than an extension of `dismissals`.

---

## ⛩ REVIEW

**Gate TLDR:** the app stops being wrong about James's own history – Portal disappears when he
hides games he has played, the 45 games Steam could always have told us about come back for free,
and the 297 it never recorded are markable in one click as *played* or *finished* as two distinct
states, with the ranking provably unmoved by any of it.

**Output (what James holds while reviewing):**

1. `01-mark-controls-and-copy.md` – the pick card before and after, the two toggles in position,
   and **every new on-screen string**, including the `"never played"` → `"no play recorded"`
   change and the `"(you said so)"` wording. **Pre-build checkpoint: written into the review folder
   before a line of this increment is built, and the build stops here for your ruling.**
2. `02-the-45.md` – the named list of recovered games with their real last-played dates, and the
   measurement of whether the 42 disconnected rows are inside the 45 or additional to them.
3. **The running page at `http://localhost:8787/`** – the landing state, nothing touched, with a
   pick card for an owned game reading "no play recorded" and its two toggles.
4. `03-portal-disappears.md` – the trigger that started this increment, closed and captured.
5. `04-played-vs-finished.md` – the two states proven distinct, with the named games and the four
   play-state row counts.
6. `05-status-lines.md` – all six status-line cases live, side by side, each with the game that
   produced it.
7. `06-ranking-frozen.md` – the three top-50 captures before and after twenty marks, identical, and
   the empty `git diff ecd500e -- src/profile.js`.
8. `07-backlog-pass.md` – the "Games to check" list, the count of the 297 in the top 50 / 200 /
   1,000 before and after, and the timed twenty-game pass.
9. `08-diff-and-suite.md` – the two changed key sets, the eight unchanged ones, and the suite count
   with all four properties named. `09-card-before-after.md` sits beside it for gate 9.

Item 1 is a pre-build checkpoint. Per review protocol Rule 3 the Coder writes it into the review
folder as part of the work and halts – James is never asked to review from a chat message, a
scratchpad or a code block. Every mid-build ruling in §8 lands in that same file before it is
asked for.

**Review folder:** `~/code/review/steam-sale-scout/inc-12.5/`
**Index:** `/AI/projects/personal-projects/steam-sale-scout/reviews/inc-12.5.md`

**Decision this gate needs:** whether per-game marks are now a first-class input the project keeps
and backs up – and therefore whether the next increment is the one that lets a *finished* mark
move the ranking, or whether the taste engine stays frozen for longer.
