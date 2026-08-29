# Increment 9 – live probe findings (SteamSpy tags)

**Run:** 2026-08-28, from `~/code/steam-sale-scout` on branch `tags` (base `aac0f87`).
**Purpose:** SPEC.md §4 – mandatory live probes before any code is written. Fixtures in
`test/fixtures/spy-appdetails.mjs` are built from the raw responses captured here.

Raw captures live in the session scratchpad (not committed):
`probe-celeste-504230.json`, `probe-appid-5.json`, `probe-appid-999999999.json`,
`probe-all-page0.json`, `probe-spotcheck-raw.json`, `probe-throttle-*.log`.

---

## Probe 1 – `appdetails` tag shape

**Endpoint:** `https://steamspy.com/api.php?request=appdetails&appid=N`

### 1a. Populated case – Celeste (504230)

HTTP 200, `content-type: application/json`, 896 bytes.
Response headers of note: `cache-control: max-age=86400`, `cf-cache-status: HIT`,
`server: cloudflare`. SteamSpy sits behind Cloudflare with a 24h edge cache.

`tags` is a **name → vote-count object**, exactly as the spec assumed:

```json
"tags":{"Precision Platformer":1432,"Difficult":1415,"Pixel Graphics":1406,
        "Great Soundtrack":1405,"Indie":1329, ...}
```

Every populated game sampled returned **exactly 20 tags** (SteamSpy truncates to a top-20).

### 1b. Empty case – the array/dict duality is REAL and still live

Two independent empty shapes, both HTTP 200:

| appid | what it is | `tags` value |
|---|---|---|
| 5 | "Dedicated Server" (real, non-game app) | `[]` – an **ARRAY** |
| 999999999 | nonexistent appid | `[]` – an **ARRAY** |
| 1969360 | an **unknown appid** (see correction below) | `[]` – an **ARRAY** |

The 999999999 case additionally returns `"name":null` and `"price":null` – a synthesised
row, not a 404. There is no error status to key off: **the only signal is body shape.**

> **CORRECTION (round-1 review, major 3).** This table originally listed 1969360 as
> *"A Castle Full of Cats* – a real game, in James's own spot-check list", and a paragraph
> here argued that `1969360` mattered because "it is a genuine, floor-passing game in the
> catalog that SteamSpy has no tags for… the empty case is not confined to junk appids".
> **Both claims were false.** Appid 1969360 returns `name: null`, is not in the catalog, and
> is the same class of thing as 999999999. A Castle Full of Cats is **appid 2070550**; it is
> in the catalog (`app_type='game'`, `main_hours` 1.05) and SteamSpy returns a **full 20-tag
> dict** for it. The corrected capture is `scratchpad/probe-castle-2070550-CORRECTED.json`.
>
> What this changes: **the empty outcome has only ever been witnessed on non-game or
> unknown appids.** No catalogued game has been observed returning empty. "Empty" still has
> to be a first-class recorded outcome (appid 5 is a real Steam app and DLC/bundles land in
> the catalog too), but there is no measured basis for predicting how many rows will land
> there. Nothing in the code changes: `fetchSpyTags` keys purely on response shape and has
> never cared which appid was asked about.

### 1c. Sizing

Populated responses are 849–1096 bytes whole; the `tags` object alone is ~400–700 bytes.
Across ~18.3k rows that is roughly **8–12 MB** of new `TEXT` in D1 – comfortably inside
D1's 5 GB free-tier storage.

---

## Probe 2 – the bulk `all` feed carries NO tags (spec assumption CONFIRMED)

`https://steamspy.com/api.php?request=all&page=0` → HTTP 200, 354,899 bytes, 1000 entries.

Keys present on every entry:

```
appid, name, developer, publisher, score_rank, positive, negative, userscore,
owners, average_forever, average_2weeks, median_forever, median_2weeks,
price, initialprice, discount, ccu
```

`"tags" in entry` was **false for all 1000 entries**. There is no bulk shortcut. The
per-appid fill in §3 of the spec is the only route.

---

## Probe 3 – throttle behaviour: NOT reproducible today, detection kept anyway

Attempted three ways:

1. 20 sequential `appdetails` calls with no pacing → 20/20 valid JSON.
2. **30 parallel** `appdetails` calls on cache-cold appids (1000010–1000300)
   → 30/30 HTTP 200, 30/30 valid JSON, zero non-JSON bodies.
3. 6 parallel `all`-endpoint page fetches → 6/6 valid JSON, ~343 KB each.

**No throttle was triggered on 2026-08-28.** The likely reason is probe 1a's
`cf-cache-status: HIT` / `max-age=86400` – Cloudflare is absorbing a large share of these
requests before they reach SteamSpy's origin.

**This is a "could not reproduce", not a "does not exist".** The throttle shape recorded
by the increment-7.7 probes is still the contract this increment codes against:

> HTTP **200** with a **plain-text** body containing `Too many connections`
> (also seen: `Connection failed`), plus a bare HTTP 500 with an empty body.

`src/catalog.js`'s existing `isThrottledBody()` already encodes exactly this and is reused
unchanged. Consequences for the build:

- Detect by **body shape first**, never by status alone. A 200 whose body does not parse as
  a JSON object is treated as a throttle, not as data.
- Cool down **>60 s** on detection. The tag fill reuses the established doubling backoff.
- Keep the ~1 req/sec ceiling regardless of today's tolerance. The probe shows what
  SteamSpy *permits* under Cloudflare caching, not what it is *willing* to serve for a
  3-hour unattended walk of the whole catalog.

---

## Probe 4 – KV seed size (spec §3.3) – the headline finding

Local `wrangler dev` state, read directly out of
`.wrangler/state/v3/kv/` and `.wrangler/state/v3/d1/`:

| Measure | Count |
|---|---|
| Catalog rows (`fpm_catalog`) | 18,306 |
| …of which `app_type='game'` | 18,221 |
| KV `v2:spytag:` entries, unexpired | 15,770 |
| …holding a usable tag dict | 12,839 |
| …cached as `null` (checked, no usable tags) | 2,931 |
| **KV entries that map to a catalog row AND hold tags** | **6,493** |
| KV entries for appids with no catalog row | 9,277 |
| Catalog rows with a usable KV tag dict but a `null` cache | 0 |

**Read:** the KV seed covers **6,493 of 18,306 rows (35%) for free**, leaving **11,813
rows needing a live SteamSpy call ≈ 3.3 h** at 1 req/sec, down from ~5.1 h cold. The
9,277 non-catalog KV entries are deal-feed/rec-pool appids that never cleared the quality
floor, so they have no catalog row to seed – they are correctly ignored.

Average 15.5 tags per cached game (below the live 20 because the cache predates
SteamSpy's current top-20 truncation for some entries).

**Design consequence – a KV `null` must NOT be written to D1 as a definitive "empty".**
`spyQueue.js` caches `null` for three different reasons (genuine no-tags, non-2xx, network
error) and the cached value cannot tell them apart. Seeding a `null` into
`tags_checked_at` would permanently bake a transient network blip into the catalog. A KV
`null` is therefore treated as a **seed miss** and the row goes to the live SteamSpy fill,
where the outcome is honestly classified.

---

## Probe 5 – spot-check fixture capture (SPEC.md §7 output)

All ten of James's named games, fetched at 1.1 s spacing:

| appid | game | tags |
|---|---|---|
| 504230 | Celeste | DICT, 20 |
| 1145360 | Hades | DICT, 20 |
| 646570 | Slay the Spire | DICT, 20 |
| 2379780 | Balatro | DICT, 20 |
| 413150 | Stardew Valley | DICT, 20 |
| 105600 | Terraria | DICT, 20 |
| 292030 | The Witcher 3 | DICT, 20 |
| 1794680 | Vampire Survivors | DICT, 20 |
| 2070550 | A Castle Full of Cats | DICT, 20 |
| 227300 | Euro Truck Simulator 2 | DICT, 20 |

**All ten populated.** *(Corrected in the round-1 review, major 3: this row originally read
`1969360 | A Castle Full of Cats | ARRAY, empty`, and the line below it read "9 populated,
1 genuinely empty… the one miss is the live proof of the array/dict duality". The appid was
wrong – 1969360 is an unknown appid, not this game. At the correct appid 2070550 the game
returns a full 20-tag dict. The array/dict duality is still live and still proven, but by
appid 5 and appid 999999999 only – see probe 1b.)*

---

## Probe 6 – Context7 (D1 / wrangler)

Queried `/llmstxt/developers_cloudflare_d1_llms-full_txt`. Confirms the two API facts this
increment leans on, both already the project's established pattern:

1. `ALTER TABLE <t> ADD COLUMN <c> <type>` is supported on an existing D1 table. SQLite has
   no `IF NOT EXISTS` for it, so the existing try/catch-per-statement idempotence in
   `ensureCatalogSchema` stays the right shape.
2. JSON in a `TEXT` column is bound as an ordinary string parameter –
   `.prepare(sql).bind(JSON.stringify(obj))`. No D1-specific JSON type is needed.

---

## What the build must therefore do

1. Accept **both** `tags` shapes. A dict with keys → tags. `[]`, `{}`, a missing field, or
   a non-object → the **empty** outcome, recorded and stamped, never an error.
2. Never trust HTTP status alone. Non-JSON-object body → throttle → back off >60 s.
3. Seed from KV first, and only from entries holding a real tag dict. A KV `null` is a
   miss, not an empty.
4. Hold ~1 req/sec on the live fill despite today's non-reproduction of the throttle.
5. Expect roughly 6,493 kv_seeded on a first full walk (probe 4, measured). The split of
   the remaining ~11,813 rows between `tagged` and `empty` is **NOT predicted** – the
   original "~11,300 tagged, ~500 empty" here rested on the mistaken belief that a real
   catalogued game had been seen returning empty (see the correction in probe 1b), and no
   such row has actually been observed. The live fill produces the first real number.
   Record it in the result file.
