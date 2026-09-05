// Steam Sale Scout – the answer page's pure logic (Increment 12).
//
// Pure, dependency-free ESM so it is imported by both the browser
// (public/index.html) and `node --test`, mirroring public/filters.js's
// existing seam. Nothing here touches the DOM, the network or storage.
//
// TWO KINDS OF THING LIVE HERE, DELIBERATELY.
//
//   1. PREDICATES over `/api/rank` rows (SPEC.md §4.3, §4.5). Each one is
//      independently testable, and the chain is a `.filter()` per predicate
//      over the one in-memory array – §2's "filters as a chain of pure
//      predicates" technique, taken without the dependency.
//
//   2. THE ON-SCREEN COPY BUILDERS (SPEC.md §10c). The status line, the
//      length line and the taste band are strings James ruled on at the
//      01 checkpoint, and a string a stranger reads is as load-bearing as a
//      number. Putting them here rather than inline in the page means each
//      ruling has a test with the ruled words in it.
//
// WHAT IS NOT HERE, AND MUST NEVER BE: any part of the rank blend. The
// browser never computes a rank (SPEC.md §4.2). `rankScore`, `base`,
// `similarityNorm` and the preset weights arrive already computed from
// src/rank.js and are only ever read, sorted on, or compared against a
// threshold. There is no `wE * E + wS * S` in this file and there is not one
// anywhere else under public/ – that is a reviewer grep, not a promise.

// ---------------------------------------------------------------------------
// The two constants the gates name.
// ---------------------------------------------------------------------------

/** How many picks the landing state shows. TEN, ruled by James (SPEC.md
 * §10b.1) over the spec body's five. One number to change, used by the page,
 * the "Show me N more" label and the basis sentence's number word. */
export const PICK_COUNT = 10;

/** How many more picks each press of "Show me 10 more" reveals. */
export const PICK_STEP = PICK_COUNT;

/**
 * The landing lens, and it is enforced rather than intended (SPEC.md §4.2).
 * `sale` can never be the landing state: only 1 of 552 owned games carries a
 * discount, so under `sale` an owned game is arithmetically pushed down and
 * the lens cannot answer "what do I play tonight". A unit test asserts this
 * is `default`.
 */
export const LANDING_PRESET = "default";

/** The three lenses, in the order the strip shows them. `label` and `subline`
 * are James's ruled copy (checkpoint 01 §C.2). */
export const LENSES = Object.freeze([
  Object.freeze({
    preset: "default",
    label: "Play next",
    subline: "Games ranked by how much they give back per hour, whether or not you own them.",
  }),
  Object.freeze({
    preset: "sale",
    label: "Worth buying",
    subline: "Games you don't own, weighted by how deep the discount is.",
  }),
  Object.freeze({
    preset: "similarity",
    label: "More like what I play",
    subline: "Closest to your taste, whether or not you own it.",
  }),
]);

/** How many tag chips the browse filter offers, ranked by how many rows in
 * the ranked pool carry them. Same idea as filters.js's TOP_TAGS_COUNT. */
export const TOP_TAGS_COUNT = 30;

/** How many browse rows are put in the DOM at a time (SPEC.md §4.4). The pool
 * is ~13,924 rows and rendering all of them is the only genuinely slow thing
 * this page could do. Filtering still runs over the FULL array. */
export const BROWSE_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Top 100 of all time – the PRD's named replacement for the Best of Steam tab.
// ---------------------------------------------------------------------------

/** The existing Best-of rule with the discount gate removed (SPEC.md §4.5.10). */
export const TOP100_MIN_REVIEW_PERCENT = 95;
export const TOP100_MIN_REVIEW_COUNT = 10000;
export const TOP100_LIMIT = 100;

// ---------------------------------------------------------------------------
// Taste match – word bands, never a percentage.
// ---------------------------------------------------------------------------
//
// `similarityNorm` is a PERCENTILE under `default` and `sale` and a MIN-MAX
// distance under `similarity` (src/rank.js PRESET_NORMALISERS), so "89%"
// would mean two different things depending on which button is lit.
//
// SPEC.md §10c.1: the band is OFF the pick cards. Measured on the real top
// ten it read "Strong" six times and "Very strong" four times – the top of
// the list IS the best-matching set, so the slot repeated itself while
// looking like information. The thresholds were NOT moved to manufacture
// variety, which would have been the dishonest fix. The bands survive here
// because the browse filter's "at least this close to my taste" dropdown
// needs them and because the browse table shows the raw number beside them.

/** Band thresholds, highest first. Shared by the filter dropdown and the
 * browse column, so a threshold change is one number in one place. */
export const TASTE_BANDS = Object.freeze([
  Object.freeze({ key: "very-strong", min: 0.9, label: "Very strong" }),
  Object.freeze({ key: "strong", min: 0.75, label: "Strong" }),
  Object.freeze({ key: "some", min: 0.5, label: "Some" }),
  Object.freeze({ key: "weak", min: 0, label: "Not much" }),
]);

/**
 * The word band for a normalised similarity.
 * @param {number|null|undefined} similarityNorm - 0..1 off `/api/rank`.
 * @returns {string} one of the TASTE_BANDS labels, or "None" at exactly 0.
 *   Exactly 0 is a real state, not a rounding: percentileRankNormalise's
 *   strictly-below tie rule gives 0 to every game sharing no distinctive tag
 *   with the profile, and BOTH normalisers return 0 for every row when there
 *   is no library at all.
 */
export function tasteBand(similarityNorm) {
  const v = Number(similarityNorm);
  if (!Number.isFinite(v) || v <= 0) return "None";
  for (const band of TASTE_BANDS) {
    if (v >= band.min) return band.label;
  }
  return "None";
}

// ---------------------------------------------------------------------------
// The two quick chips (SPEC.md §4.3). They apply to the PICKS.
// ---------------------------------------------------------------------------
//
// THEY ARE DISTINCT, AND THE 0-HOUR OWNED GAME IS WHERE THAT IS PROVED.
// An owned game with 0 hours SURVIVES "hide games I've played" and
// DISAPPEARS under "hide games I own". An owned game with 3 hours disappears
// under both. Gate 4 checks exactly this, and so does the test file.

/** @param {object} row @returns {boolean} true = keep. */
export function passesHideOwned(row, hideOwned) {
  if (!hideOwned) return true;
  return row?.owned !== true;
}

/**
 * THE CHIP THAT TRIGGERED INCREMENT 12.5.
 *
 * This used to be `(row?.hoursPlayed ?? 0) <= 0` – "played" meaning "Steam
 * recorded some minutes". James ticked it and **Portal stayed on screen**,
 * because Steam began recording playtime in March 2009 and Portal shipped in
 * 2007. 297 owned games are in that position: zero on `playtime_forever`,
 * zero on every per-platform field, zero on `playtime_disconnected` and zero
 * on `rtime_last_played`. Steam's 0 there means "no record", not "never".
 *
 * It now reads `played`, the field src/marks.js's derivePlayed builds from
 * ALL the evidence – any Steam signal, or the user's own mark. That is the
 * whole fix, and it is what makes Portal disappear.
 * @param {object} row @returns {boolean} true = keep.
 */
export function passesHidePlayed(row, hidePlayed) {
  if (!hidePlayed) return true;
  return row?.played !== true;
}

/**
 * The picks: the two chips, then the first `count` rows. Nothing else touches
 * the picks – not the filter bar, not a saved setting. That is what makes the
 * landing state un-poisonable by a stale filter (SPEC.md §4.5).
 * @param {object[]} rows - the ranked array, already in rank order.
 * @param {{hideOwned?: boolean, hidePlayed?: boolean}} chips
 * @param {number} [count]
 * @returns {object[]}
 */
export function selectPicks(rows, chips = {}, count = PICK_COUNT) {
  const list = (rows || [])
    .filter((r) => passesHideOwned(r, chips.hideOwned))
    .filter((r) => passesHidePlayed(r, chips.hidePlayed));
  return list.slice(0, Math.max(0, count));
}

// ---------------------------------------------------------------------------
// The browse filter bar (SPEC.md §4.5). Ten controls, every one of them a
// predicate over a field already on the row. No new fetch, no new parameter.
// ---------------------------------------------------------------------------

/**
 * The browse section's play-state select (increment 12.5 §6.4). Four values,
 * and the third one is the point: **"Played, not finished" is the backlog
 * query** – the single thing every backlog tracker surveyed exists to answer,
 * arriving here as one option in one select over a list that is already ranked
 * by what a game gives back per hour. It lives inside the collapsed browse
 * section, so it costs the landing gate nothing.
 */
export const PLAY_STATE_ALL = "all";
export const PLAY_STATE_NOT_PLAYED = "not-played";
export const PLAY_STATE_PLAYING = "played-not-finished";
export const PLAY_STATE_FINISHED = "finished";

export const PLAY_STATES = Object.freeze([
  { value: PLAY_STATE_ALL, label: "All" },
  { value: PLAY_STATE_NOT_PLAYED, label: "Not played" },
  { value: PLAY_STATE_PLAYING, label: "Played, not finished" },
  { value: PLAY_STATE_FINISHED, label: "Finished" },
]);

export const OWNERSHIP_ALL = "all";
export const OWNERSHIP_HIDE = "hide";
export const OWNERSHIP_ONLY = "only";

export const RANK_FILTERS_SETTINGS_KEY = "rankFilters";

export const DEFAULT_RANK_FILTERS = Object.freeze({
  search: "",
  ownership: OWNERSHIP_ALL,
  playState: PLAY_STATE_ALL,
  hidePlayed: false,
  onSaleOnly: false,
  minDiscount: 0,
  maxPrice: null,
  minTaste: 0,
  minExperience: 0,
  includeTags: [],
  top100: false,
});

/**
 * Merge a stored blob over the defaults, so a partial or older saved shape
 * still yields every field and a corrupt one falls back rather than throwing.
 * @param {unknown} stored
 * @returns {object}
 */
export function normaliseFilters(stored) {
  if (!stored || typeof stored !== "object") return { ...DEFAULT_RANK_FILTERS };
  const merged = { ...DEFAULT_RANK_FILTERS, ...stored };
  merged.includeTags = Array.isArray(merged.includeTags) ? merged.includeTags.filter((t) => typeof t === "string") : [];
  if (![OWNERSHIP_ALL, OWNERSHIP_HIDE, OWNERSHIP_ONLY].includes(merged.ownership)) merged.ownership = OWNERSHIP_ALL;
  // `playState` joins the SAME saved settings blob rather than taking a new
  // settings key, so a blob saved before increment 12.5 still loads and simply
  // gets the default – which is what the merge above already does for every
  // other field, and why nothing had to change in src/settings.js.
  if (!PLAY_STATES.some((s) => s.value === merged.playState)) merged.playState = PLAY_STATE_ALL;
  return merged;
}

/** 1. Title substring, case-insensitive. Debouncing is the page's job. */
export function passesSearch(row, search) {
  const needle = String(search ?? "").trim().toLowerCase();
  if (!needle) return true;
  return String(row?.title ?? "").toLowerCase().includes(needle);
}

/** 2. Ownership tri-state – all / hide owned / only owned. */
export function passesOwnership(row, ownership) {
  if (ownership === OWNERSHIP_HIDE) return row?.owned !== true;
  if (ownership === OWNERSHIP_ONLY) return row?.owned === true;
  return true;
}

/**
 * 3b. Play state. Reads the two derived fields and nothing else, so it agrees
 * with the chip and the status line by construction. `finished` implies
 * `played` server-side, which is what lets "Played, not finished" be a plain
 * two-term test rather than a special case.
 */
export function passesPlayState(row, playState) {
  if (playState === PLAY_STATE_NOT_PLAYED) return row?.played !== true;
  if (playState === PLAY_STATE_PLAYING) return row?.played === true && row?.finished !== true;
  if (playState === PLAY_STATE_FINISHED) return row?.finished === true;
  return true;
}

/** 4. On sale only. `cut` is a percentage off, null when there is no price. */
export function passesOnSaleOnly(row, onSaleOnly) {
  if (!onSaleOnly) return true;
  return (row?.cut ?? 0) > 0;
}

/** 5. Minimum discount. */
export function passesMinDiscount(row, minDiscount) {
  const floor = Number(minDiscount) || 0;
  if (floor <= 0) return true;
  return (row?.cut ?? 0) >= floor;
}

/** 6. Maximum price (AUD). A row with no price CANNOT satisfy a price
 * ceiling – ~16,600 rows have no price and letting them all through a "under
 * $10" filter would be a lie about what the filter did. */
export function passesMaxPrice(row, maxPrice) {
  if (maxPrice == null || maxPrice === "") return true;
  const ceiling = Number(maxPrice);
  if (!Number.isFinite(ceiling)) return true;
  const price = row?.price;
  if (price == null) return false;
  return price <= ceiling;
}

/** 7. Minimum taste match, as a similarityNorm floor. */
export function passesMinTaste(row, minTaste) {
  const floor = Number(minTaste) || 0;
  if (floor <= 0) return true;
  return (row?.similarityNorm ?? 0) >= floor;
}

/** 8. Minimum experience score. */
export function passesMinExperience(row, minExperience) {
  const floor = Number(minExperience) || 0;
  if (floor <= 0) return true;
  return (row?.experienceScore ?? 0) >= floor;
}

/** 9. Tags, include-only. A row passes if it carries ANY selected tag, which
 * is what makes two chips read as "either of these" rather than "both". */
export function passesTags(row, includeTags) {
  if (!includeTags || includeTags.length === 0) return true;
  const tags = row?.tagNames;
  if (!Array.isArray(tags) || tags.length === 0) return false;
  return includeTags.some((t) => tags.includes(t));
}

/**
 * 10. Top 100 of all time. The existing Best-of rule with the discount gate
 * removed, computed over the RANKED pool – so it can honestly return fewer
 * than 100 and the label says how many it found rather than claiming 100.
 * @param {object[]} rows
 * @returns {object[]} up to TOP100_LIMIT rows, ordered by review count desc.
 */
export function selectTop100(rows) {
  return (rows || [])
    .filter((r) => (r?.reviewPercent ?? 0) >= TOP100_MIN_REVIEW_PERCENT && (r?.reviewCount ?? 0) >= TOP100_MIN_REVIEW_COUNT)
    .slice()
    .sort((a, b) => (b.reviewCount ?? 0) - (a.reviewCount ?? 0))
    .slice(0, TOP100_LIMIT);
}

/**
 * The whole chain, in one place, over the FULL in-memory array – never over
 * the rendered window, so a filter finds a match at rank 9,000 (SPEC.md §4.4).
 * @param {object[]} rows
 * @param {object} filters
 * @returns {object[]}
 */
export function applyRankFilters(rows, filters) {
  const f = normaliseFilters(filters);
  let list = f.top100 ? selectTop100(rows) : rows || [];
  return list
    .filter((r) => passesSearch(r, f.search))
    .filter((r) => passesOwnership(r, f.ownership))
    .filter((r) => passesPlayState(r, f.playState))
    .filter((r) => passesHidePlayed(r, f.hidePlayed))
    .filter((r) => passesOnSaleOnly(r, f.onSaleOnly))
    .filter((r) => passesMinDiscount(r, f.minDiscount))
    .filter((r) => passesMaxPrice(r, f.maxPrice))
    .filter((r) => passesMinTaste(r, f.minTaste))
    .filter((r) => passesMinExperience(r, f.minExperience))
    .filter((r) => passesTags(r, f.includeTags));
}

/** Tag chips for the filter bar, most common in the pool first. */
export function computeTopTags(rows, limit = TOP_TAGS_COUNT) {
  const counts = new Map();
  for (const row of rows || []) {
    for (const tag of row?.tagNames || []) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

/**
 * Client-side sorting of the browse table on a RETURNED field.
 *
 * THIS IS THE LINE SPEC.md §4.2 DRAWS. Sorting on what the API already sent is
 * presentation and is allowed; recomputing `rankScore` in the browser is not,
 * and there is no blend arithmetic here or anywhere else under public/.
 *
 * NULLS SORT LAST IN BOTH DIRECTIONS, which is §4.4's named obligation and the
 * reason this moved out of index.html at round-2 review (CR-3 / TC-3): an
 * endless game has a null `hoursToValue` and must never be mistaken for a
 * zero-hour one. Ascending by Hours, the shortest real game leads and the
 * endless ones sit at the bottom; descending, the longest leads and the
 * endless ones are STILL at the bottom. That asymmetry is the whole point and
 * nothing asserted it while it lived in an untested file.
 *
 * @param {object[]} list
 * @param {{key: string|null, dir: string}} sort
 * @returns {object[]} a new array, or `list` itself when no column is sorted.
 */
export function sortRows(list, sort) {
  const key = sort?.key;
  if (!key) return list;
  const sign = sort?.dir === "asc" ? 1 : -1;
  return (list || []).slice().sort((a, b) => {
    const av = a?.[key], bv = b?.[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "string") return sign * av.localeCompare(bv);
    return sign * (av - bv);
  });
}

// ---------------------------------------------------------------------------
// The copy builders – James's ruled strings (checkpoint 01, SPEC.md §10c).
// ---------------------------------------------------------------------------

/** en dash, never an em dash. */
const EN = "–";

/** "1,234" – the page never prints a bare five-digit number at a reader. */
export function formatCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0";
  return Math.round(v).toLocaleString("en-AU");
}

/** "$7.30" / "$29.99". AUD, as the column holds it. */
export function formatPrice(price) {
  const v = Number(price);
  if (!Number.isFinite(v)) return "";
  return `$${v.toFixed(2)}`;
}

/**
 * The status slot (checkpoint 01 §C.5), in evaluation order.
 *
 * PRICE IS SUPPRESSED ENTIRELY FOR AN OWNED GAME. You own it, so price is not
 * a fact about your decision.
 *
 * "Price not known" is §10c.4's rewrite of "No price on file" – "on file"
 * describes our filing system rather than the game, and this string renders
 * on roughly 16,600 of 18,306 rows, making it the most frequently read
 * sentence on the page after the reason lines.
 */
export const OWNED_PREFIX = "In your library";

/** How far down the ranking "Games to check" looks. Ruled by James at
 * checkpoint 01 over 200 and 1,000: five games, one sitting. */
export const GAMES_TO_CHECK_WINDOW = 50;

/**
 * How much of a game you have played, as the fragment that follows the owned
 * prefix - and NOTHING ELSE. The browse table's "Yours" column wants exactly
 * this fragment without the prefix, and it used to get it by doing
 * `statusLine(row).replace("In your library - ", "")` up in the page: string
 * surgery that hard-codes another function's separator. The next time James
 * re-rules that separator (§10c is a live document, and he has already rewritten
 * two of these strings once) the replace would silently no-op and the column
 * would print the whole sentence. One source, two callers, and the composition
 * itself is asserted.
 *
 * `hoursPlayed` IS NULL AND 0 IS NOT THE SAME THING, and collapsing them was a
 * real defect caught while capturing the first-run states. null means the row
 * was not in the LIVE library join - with no credentials, or with Steam down,
 * that is every row, including a game with 17 hours on it. `owned` survives
 * because D1 carries its own `source_owned` stamp from an earlier sync.
 * Printing "never played" there asserts a fact the page does not have.
 *
 * INCREMENT 12.5 – THE SAME DEFECT, ONE LAYER UP, AND JAMES'S RULING ON IT.
 * The line above caught null-mistaken-for-zero. This one is
 * no-record-mistaken-for-did-not-happen: `hoursPlayed === 0` used to render
 * **"never played"**, and on **297 owned games that is a false assertion the
 * page has no basis for** (Steam started recording playtime in March 2009;
 * Portal is from 2007), while on **45 more it is flatly wrong** because Steam
 * holds a real `rtime_last_played` for them. Ruled 2026-09-05: 0 becomes
 * **"no play recorded"**, which is true in both cases and claims nothing.
 *
 * THE OTHER RULE THIS FUNCTION ENFORCES: the page must never present a user's
 * mark as though Steam measured it, and must never hide Steam's number behind
 * the mark. So a user assertion always carries **"(you said so)"**, and when
 * both exist they are stacked - `finished · 17 hours played` - Steam's number
 * and James's verdict on one line, neither disguised as the other.
 *
 * Seven cases, all six from SPEC.md §6.2 plus the stacked-evidence one James
 * ruled on at checkpoint 01:
 *
 *   hoursPlayed null, no mark          -> null            ("In your library")
 *   hours > 0                          -> "17 hours played"
 *   hours 0, Steam has a play signal   -> "played, hours not recorded"
 *   hours 0, Steam has nothing, marked -> "played (you said so)"
 *   finished + hours > 0               -> "finished · 17 hours played"
 *   finished + Steam signal only       -> "finished · played, hours not recorded"
 *   finished, Steam has nothing        -> "finished (you said so)"
 *   hours 0, Steam has nothing, unmarked -> "no play recorded"
 *
 * @returns {string|null} null when nothing at all is known about play.
 */
export function playedFragment(row) {
  const hours = row?.hoursPlayed == null ? null : Number(row.hoursPlayed);

  // What STEAM can support, in derivePlayed's own precedence order. A source
  // of "you" is deliberately NOT evidence here - that is the whole point.
  let evidence = null;
  if (hours != null && hours > 0) {
    if (hours < 1) evidence = "under an hour played";
    else {
      const whole = Math.round(hours);
      evidence = `${formatCount(whole)} hour${whole === 1 ? "" : "s"} played`;
    }
  } else if (row?.playedSource === "steam-disconnected" || row?.playedSource === "steam-last-played") {
    // THE 45. Zero recorded minutes but a real last-played date - the field
    // has been arriving on every library fetch since increment 1 and nothing
    // read it. "Played, hours not recorded" is the honest reading of it.
    evidence = "played, hours not recorded";
  }

  if (row?.finished === true) return evidence ? `finished · ${evidence}` : "finished (you said so)";
  if (evidence) return evidence;
  if (row?.played === true) return "played (you said so)";
  // Nothing known at all: no live library row AND no mark. Unknown, not zero.
  if (hours == null) return null;
  return "no play recorded";
}

/**
 * Re-derive a row's four play fields after the user presses a toggle, WITHOUT
 * a re-fetch of /api/rank (10.1 MB) and WITHOUT the browser inventing its own
 * precedence rule.
 *
 * The row already encodes Steam's verdict in `playedSource`: anything starting
 * `steam-` means Steam has evidence, which the user can never contradict
 * (SPEC.md §4.2). So Steam's source is kept if it exists, and the mark only
 * fills the gap - which is src/marks.js's derivePlayed, expressed over the one
 * row the page is holding.
 * @param {object} row
 * @param {{played?: unknown, finished?: unknown}} mark - the state now stored.
 * @returns {object} a new row; the caller replaces the old one.
 */
export function applyMark(row, mark) {
  const steamSource = typeof row?.playedSource === "string" && row.playedSource.startsWith("steam-")
    ? row.playedSource
    : null;
  const finished = mark?.finished === 1 || mark?.finished === true;
  const marked = finished || mark?.played === 1 || mark?.played === true;
  const playedSource = steamSource ?? (marked ? "you" : null);
  return { ...row, played: playedSource !== null, finished, playedSource };
}

/**
 * "GAMES TO CHECK" (SPEC.md §6.5) - what turns 297 into a tractable list.
 *
 * An unmarked game costs exactly ONE thing: it can appear as a pick for a game
 * you have already played. So the work is bounded by the top of the ranking,
 * not by the size of the library. Measured against the live ranking on
 * 2026-09-05: of the 297 owned games Steam has no record of, **5 are in the
 * top 50**, 16 in the top 200 and 62 in the top 1,000. James ruled the window
 * at the top 50 - a list finishable in one sitting rather than a chore.
 * @param {object[]} rows - the ranked array, in rank order.
 * @param {number} [window]
 * @returns {object[]} owned rows in that window with no play record and no mark.
 */
export function gamesToCheck(rows, window = GAMES_TO_CHECK_WINDOW) {
  return (rows || [])
    .slice(0, Math.max(0, window))
    .filter((r) => r?.owned === true && r?.played !== true);
}

/** The browse table's "Yours" cell: the fragment alone, or the bare prefix when
 * playtime is unknown, or nothing at all for a game you do not own. */
export function ownedCell(row) {
  if (row?.owned !== true) return "";
  return playedFragment(row) ?? OWNED_PREFIX;
}

export function statusLine(row) {
  if (row?.owned === true) {
    const fragment = playedFragment(row);
    return fragment == null ? OWNED_PREFIX : `${OWNED_PREFIX} ${EN} ${fragment}`;
  }
  const price = row?.price;
  if (price == null) return "Price not known";
  const cut = Number(row?.cut ?? 0);
  if (cut > 0) return `${formatPrice(price)} ${EN} ${Math.round(cut)}% off`;
  return formatPrice(price);
}

/**
 * The length slot (checkpoint 01 §C.6). `hasEnding` is a TRI-STATE – 1 ends,
 * 0 endless, null not yet known – and all three read differently.
 *
 * THE ENDLESS STRING, RULED BY JAMES 2026-09-05: *"No ending - game is
 * endless. Won't be able to factor into FPM"*. Two things, and they land in
 * two different places.
 *
 *   1. HERE, on the pick card: "yet" is gone. It implied an ending was coming
 *      later, which is the opposite of the fact. The card says the game ends
 *      never, plainly, and stops.
 *   2. NOT HERE, the per-hour consequence. A pick card carries no per-hour
 *      figure at all (the slot is lengthLine · experienceLine · tagLine), so
 *      explaining a missing number on a card that never shows one points at
 *      nothing. It moved to `perHourCell`, which is the cell that is actually
 *      empty, in a reader's words rather than "FPM".
 *
 * This renders on 4,799 of 13,924 ranked rows, which makes it one of the most
 * read lines on the site.
 *
 * "to finish" was added to the hours string so it cannot be misread as how
 * long YOU have played.
 */
export function lengthLine(row) {
  const hasEnding = row?.hasEnding;
  if (hasEnding === 0) return `No ending ${EN} the game is endless`;
  const hours = Number(row?.hoursToValue);
  if (hasEnding !== 1 || !Number.isFinite(hours) || hours <= 0) return "Length not known";
  // Halves are kept: a 1.5-hour game rounded to 2 overstates it by a third.
  const shown = Math.round(hours * 2) / 2;
  return `About ${shown} hour${shown === 1 ? "" : "s"} to finish`;
}

/** The experience-value slot. The one number that keeps its digits on a card. */
export function experienceLine(row) {
  const v = row?.experienceScore;
  if (v == null) return "";
  return `Experience value ${Math.round(v)}/100`;
}

/** The first three tags, already ordered by SteamSpy vote count. */
export function tagLine(row, limit = 3) {
  const tags = Array.isArray(row?.tagNames) ? row.tagNames.slice(0, limit) : [];
  return tags.join(` · `);
}

/**
 * The "per hour" browse cell. `null` is two different things and they read
 * differently: endless by construction, or hours simply not known.
 *
 * THE ENDLESS CELL CARRIES THE SECOND HALF OF JAMES'S 2026-09-05 RULING. This
 * is the column where the number is genuinely missing, so this is where it is
 * worth a reader's time to say why it is missing. "FPM" is our word, not his
 * reader's, and it does not appear.
 *
 * The unknown case keeps the bare dash deliberately: "not known" and "cannot
 * exist" are different facts, and the whole reason this function exists is
 * that they must not read the same.
 */
export function perHourCell(row) {
  const v = row?.experienceFpm;
  if (v == null) return row?.hasEnding === 0 ? `endless ${EN} no per-hour figure` : EN;
  return v.toFixed(1);
}

/** The hover on the low-confidence mark. */
export function confidenceTitle(row) {
  return `Only ${formatCount(row?.reviewCount ?? 0)} reviews, so this score is a rough guess rather than a confident one.`;
}

export const STEAM_STORE_ROOT = "https://store.steampowered.com/";

/**
 * The Steam store URL for a row. The only outbound link on a pick card, and
 * the only place upstream data is ever interpolated into an ATTRIBUTE rather
 * than into textContent - so it is the one string on this page where a
 * `javascript:` payload or a path traversal would have somewhere to go.
 *
 * `appid` is a D1 integer today. That is a fact about the current schema, not
 * a guarantee about the JSON the browser is handed, and the whole XSS posture
 * of this page is "never trust the payload". A non-integer falls back to the
 * store front page: a link that goes somewhere harmless and obviously wrong
 * beats a link that goes nowhere (an empty href re-navigates to this page) or
 * one that runs.
 */
export function steamUrl(appid) {
  const id = Number(appid);
  if (!Number.isInteger(id) || id <= 0) return STEAM_STORE_ROOT;
  return `https://store.steampowered.com/app/${id}/`;
}

/**
 * The basis sentence (checkpoint 01 §C.1, ruled at §10c.4). The count comes
 * from `funnel.ranked` on the payload, never from a constant, and the number
 * word comes from PICK_COUNT so changing the constant changes the sentence.
 *
 * THE LIBRARY CLAUSE IS CONDITIONAL, and round-2 review (CR-1) is why. The
 * sentence used to end "then matched against what is already in your Steam
 * library" unconditionally - including in both no-library states, where it
 * renders DIRECTLY ABOVE the banner saying these picks are not matched to your
 * taste. Two stacked sentences contradicting each other, and the gate this
 * whole page exists for is that it "says so plainly instead of quietly serving
 * taste-blind picks that look normal".
 *
 * The second argument is a LIBRARY STATE, not a boolean, and an omitted one
 * drops the clause rather than keeping it: a caller who forgets to pass it
 * under-claims instead of lying.
 *
 * @param {number} rankedCount
 * @param {string} [libState] - one of the LIBRARY_STATE_* constants.
 * @returns {string}
 */
export function basisSentence(rankedCount, libState = LIBRARY_STATE_PRESENT) {
  const lead =
    `${numberWord(PICK_COUNT)} picks from ${formatCount(rankedCount)} games on Steam, ` +
    `scored on how much a game gives back for the hours it takes`;
  if (libState !== LIBRARY_STATE_PRESENT) return `${lead}.`;
  return `${lead}, then matched against what is already in your Steam library.`;
}

const NUMBER_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"];

/** Capitalised English for the small counts the copy uses. */
export function numberWord(n) {
  return NUMBER_WORDS[n] ?? formatCount(n);
}

/**
 * The footer's "what was left out" rows, built from `funnel`, with any ZERO
 * ROW SUPPRESSED (SPEC.md §10c.5). Today `unscored` and `dismissed` are both
 * 0, so this returns four rows and not six – printing "0 you dismissed" would
 * be noise dressed as disclosure.
 * @param {object} funnel
 * @returns {Array<{count: number, text: string}>}
 */
export function funnelBreakdown(funnel) {
  const f = funnel || {};
  const rows = [
    { count: f.lowConfidenceSuppressed || 0, text: "too few reviews to trust the score" },
    { count: f.rankExcluded || 0, text: "prologues and demos of other games" },
    { count: f.nonGame || 0, text: "not games (soundtracks, tools, videos)" },
    { count: f.checkedNoScore || 0, text: "checked but not scorable" },
    { count: f.unscored || 0, text: "not scored yet" },
    { count: f.dismissed || 0, text: "you dismissed" },
  ];
  return rows.filter((r) => r.count > 0).map((r) => ({ count: r.count, text: `${formatCount(r.count)} hidden ${EN} ${r.text}` }));
}

/** The one-line footer above the breakdown. */
export function footerLine(funnel) {
  return `Ranked ${formatCount(funnel?.ranked ?? 0)} of ${formatCount(funnel?.catalogTotal ?? 0)} games in the catalogue.`;
}

// ---------------------------------------------------------------------------
// The three first-run states (SPEC.md §4.6, §10c.2).
// ---------------------------------------------------------------------------

export const LIBRARY_STATE_PRESENT = "present";
export const LIBRARY_STATE_NO_CREDENTIALS = "no-credentials";
export const LIBRARY_STATE_FETCH_FAILED = "fetch-failed";

/** Which of the three states a payload is in. */
export function libraryState(payload) {
  if (payload?.notice != null) return LIBRARY_STATE_FETCH_FAILED;
  if (payload?.profileAvailable === true) return LIBRARY_STATE_PRESENT;
  return LIBRARY_STATE_NO_CREDENTIALS;
}

/**
 * The plain sentence a stranger reads first.
 *
 * §10c.2: the Steam-down state renders this ABOVE the payload's own `notice`,
 * which is then shown verbatim beneath as technical detail. `src/` is frozen
 * so the notice cannot be rewritten at source, and it says "taste profile",
 * "similarity is 0" and "lens" – three phrases a first-time reader has never
 * met. Gate 3 still finds the exact string on the page.
 *
 * @returns {string|null} null when there is a library and nothing to say.
 */
export function libraryBanner(payload) {
  switch (libraryState(payload)) {
    case LIBRARY_STATE_NO_CREDENTIALS:
      // ROUND-2 REVIEW (CR-7), AND THIS IS A COPY FIX BECAUSE IT CANNOT BE A
      // LOGIC FIX. `libraryState` infers "no credentials" from
      // `profileAvailable === false` with no notice, but that is also what
      // credentials-present-with-zero-contributions looks like: a configured
      // Steam account whose owned games all failed to contribute tag weight
      // gets no notice (src/worker.js only sets one when the library came back
      // EMPTY). "No Steam account is connected" would then be flatly false.
      // /api/rank exposes no credentials flag and src/ is frozen this
      // increment, so the sentence is worded to be true in BOTH cases: it
      // describes what the page has (no library behind these picks) rather
      // than diagnosing why. James rules on this string at the gate.
      return "No Steam library is behind these picks, so they are not matched to your taste. They are ranked on experience value alone.";
    case LIBRARY_STATE_FETCH_FAILED:
      return "Your Steam library could not be loaded, so these picks are not matched to your taste. They are ranked on experience value alone.";
    default:
      return null;
  }
}

/** Whether the similarity lens can be offered at all. */
export function similarityLensEnabled(payload) {
  return libraryState(payload) === LIBRARY_STATE_PRESENT;
}

/** JAMES, 2026-09-05. Was "Needs a connected Steam account." - which claims
 * something this page cannot know. `/api/rank` reports `profileAvailable` and
 * `profileGames`, never whether credentials exist, so credentials-present-with-
 * zero-contributions produces a payload identical to credentials-absent. The
 * banner four lines up the same screen was corrected for exactly this reason
 * (CR-7); leaving the button saying the opposite left two sentences on one
 * screen disagreeing about whether an account is connected. Says only what the
 * payload actually supports. */
export const SIMILARITY_DISABLED_REASON = "No Steam library is loaded.";

/** ...and the same button when the account IS connected and Steam is the
 * thing that failed. Saying "needs a connected Steam account" there would be
 * false, and the whole point of §4.6 is that this page does not lie about
 * why it has no taste to match against. */
export const SIMILARITY_UNAVAILABLE_REASON = "Your Steam library could not be loaded.";

/** Which of the two reasons belongs on the disabled similarity button. */
export function similarityDisabledReason(payload) {
  return libraryState(payload) === LIBRARY_STATE_FETCH_FAILED ? SIMILARITY_UNAVAILABLE_REASON : SIMILARITY_DISABLED_REASON;
}

// ---------------------------------------------------------------------------
// Is this payload renderable at all? (round-2 review SEC-2 / SEC-3 / TC-6)
// ---------------------------------------------------------------------------
//
// /api/rank FAIL-SOFTS AT HTTP 200. A missing FPM_DB binding or a D1 throw
// returns `{available: false, notice: "Ranking unavailable"}` with no `funnel`
// and no `rank` (src/worker.js rankUnavailableResponse), because a 500 on the
// front page is worse than an honest body. The page therefore CANNOT use
// `res.ok` to decide whether it has an answer.
//
// What used to happen: that body was stored as a valid payload, the render
// dereferenced `payload.funnel.ranked`, threw, and the boot catch told the
// reader "The server may still be starting up. Reload to try again." A
// DATABASE FAILURE REPORTED AS A COLD START, with a suggested remedy that can
// never work. That is the same lie the library banner exists to prevent, in
// the state the gate exists to test.

/**
 * The plain sentence a stranger reads when there is nothing to show, and the
 * ONE thing it must not say is what it used to say: "the server may still be
 * starting up. Reload to try again." A missing FPM_DB is not a cold start and
 * no number of reloads fixes it, so the copy says so.
 *
 * §10c.2's pattern, unchanged: the plain sentence LEADS and the payload's own
 * `notice` follows verbatim underneath as technical detail. "FPM_DB not
 * configured" is true, and it is also four words of ours that mean nothing to
 * a reader - exactly the problem the library banner already solved this way.
 */
export const RANK_UNAVAILABLE_LEAD =
  "There are no picks to show, because the ranking could not be read. This is not a slow first load, and reloading will not fix it.";

/** Shown in place of the server's notice when it did not send one. */
export const RANK_UNAVAILABLE_FALLBACK = "No reason was given.";

/**
 * Everything the page dereferences without checking, checked once.
 * @param {unknown} payload
 * @returns {boolean} true only if `renderAll` can safely run against it.
 */
export function isRenderablePayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.available !== true) return false;
  if (!payload.funnel || typeof payload.funnel !== "object") return false;
  if (!Number.isFinite(Number(payload.funnel.ranked))) return false;
  return Array.isArray(payload.rank);
}

/**
 * The TECHNICAL DETAIL line, under the lead. The payload's OWN notice wins,
 * verbatim - src/ is frozen, it is the only true thing anyone has about why,
 * and §10c.2 already established that this page prints the server's words
 * rather than guessing at them.
 * @param {unknown} payload
 * @returns {string}
 */
export function unavailableMessage(payload) {
  const notice = payload && typeof payload === "object" ? payload.notice : null;
  return typeof notice === "string" && notice.trim() ? notice.trim() : RANK_UNAVAILABLE_FALLBACK;
}
