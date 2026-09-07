// Tests for public/rankFilters.js – the answer page's pure logic (Increment 12).
//
// Two things are pinned here and they are pinned for different reasons.
//
//   * THE PREDICATES, because the browse filter bar is ten controls over one
//     in-memory array and each has to be provably independent of the others.
//   * THE COPY, because James ruled on every fixed string at checkpoint 01
//     (SPEC.md §10c) and a ruled string that nothing asserts is a string that
//     drifts. The ruled words appear literally in these assertions.
//
// The rows below are REAL rows from the local catalogue and from
// review/inc-11/03-top50-default.md, trimmed to the fields under test. Using
// invented rows here would let a copy rule pass against a shape /api/rank
// never returns.

import test from "node:test";
import assert from "node:assert/strict";
import {
  PICK_COUNT,
  PICK_STEP,
  LANDING_PRESET,
  LENSES,
  BROWSE_PAGE_SIZE,
  TOP100_MIN_REVIEW_PERCENT,
  TOP100_MIN_REVIEW_COUNT,
  TOP100_LIMIT,
  TASTE_BANDS,
  tasteBand,
  passesHideOwned,
  passesHidePlayed,
  selectPicks,
  OWNERSHIP_ALL,
  OWNERSHIP_HIDE,
  OWNERSHIP_ONLY,
  PLAY_STATE_ALL,
  PLAY_STATE_NOT_PLAYED,
  PLAY_STATE_PLAYING,
  PLAY_STATE_FINISHED,
  PLAY_STATES,
  passesPlayState,
  gamesToCheck,
  GAMES_TO_CHECK_WINDOW,
  applyMark,
  DEFAULT_RANK_FILTERS,
  RANK_FILTERS_SETTINGS_KEY,
  normaliseFilters,
  passesSearch,
  passesOwnership,
  passesOnSaleOnly,
  passesMinDiscount,
  passesMaxPrice,
  passesMinTaste,
  passesMinExperience,
  passesTags,
  selectTop100,
  applyRankFilters,
  computeTopTags,
  formatCount,
  formatPrice,
  statusLine,
  lengthLine,
  experienceLine,
  tagLine,
  perHourCell,
  confidenceTitle,
  steamUrl,
  basisSentence,
  numberWord,
  funnelBreakdown,
  footerLine,
  libraryState,
  libraryBanner,
  similarityLensEnabled,
  similarityDisabledReason,
  SIMILARITY_DISABLED_REASON,
  SIMILARITY_UNAVAILABLE_REASON,
  LIBRARY_STATE_PRESENT,
  LIBRARY_STATE_NO_CREDENTIALS,
  LIBRARY_STATE_FETCH_FAILED,
  OWNED_PREFIX,
  playedFragment,
  ownedCell,
  sortRows,
  STEAM_STORE_ROOT,
  isRenderablePayload,
  unavailableMessage,
  RANK_UNAVAILABLE_LEAD,
  RANK_UNAVAILABLE_FALLBACK,
} from "../public/rankFilters.js";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Real rows.
// ---------------------------------------------------------------------------

/** appid 1043810. **ONE OF THE 45** – owned, zero recorded hours, but Steam
 * holds a real `rtime_last_played` of 23 March 2025. Measured on the live
 * library 2026-09-05, and it sits at rank #5 today wearing the word "never".
 * Increment 12.5 flips it, and this fixture is the proof. */
const TACTICAL_BREACH_WIZARDS = {
  appid: 1043810,
  title: "Tactical Breach Wizards",
  owned: true,
  hoursPlayed: 0,
  played: true,
  finished: false,
  playedSource: "steam-last-played",
  lastPlayedAt: 1742688000,
  experienceScore: 94,
  gameScore: 93,
  hasEnding: 1,
  hoursToValue: 13,
  confidence: "high",
  why: "Perfect puzzle-tactics, sharp comedy writing, zero filler, real ending.",
  similarityNorm: 0.885,
  experienceFpm: 25.9,
  price: null,
  cut: null,
  reviewCount: 9467,
  reviewPercent: 98,
  tagNames: ["Turn-Based Tactics", "Puzzle", "Turn-Based Strategy", "Story Rich"],
};

/** appid 620. Owned AND played, with Steam's own hours – disappears under
 * BOTH chips. */
const PORTAL_2 = {
  appid: 620,
  title: "Portal 2",
  owned: true,
  hoursPlayed: 17,
  played: true,
  finished: false,
  playedSource: "steam-playtime",
  lastPlayedAt: 1750000000,
  experienceScore: 96,
  gameScore: 97,
  hasEnding: 1,
  hoursToValue: 9,
  confidence: "high",
  why: "Flawless authored puzzle comedy, zero padding, clean ending.",
  similarityNorm: 0.87,
  experienceFpm: 32.2,
  price: null,
  cut: null,
  reviewCount: 433510,
  reviewPercent: 98,
  tagNames: ["Platformer", "Puzzle", "First-Person"],
};

/**
 * appid 400. **ONE OF THE 297, AND THE GAME THAT TRIGGERED INCREMENT 12.5.**
 * Owned, and Steam returns zero on every field it has: `playtime_forever`,
 * all four per-platform fields, `playtime_disconnected` and
 * `rtime_last_played`. Steam began recording playtime in March 2009 and
 * Portal shipped in 2007, so that data was never captured and no API call
 * conjures it. It sits at rank #6 today. This is now the fixture the two
 * chips are proved distinct on, because it is the one that is genuinely
 * unplayed-as-far-as-anyone-knows.
 */
const PORTAL = {
  appid: 400,
  title: "Portal",
  owned: true,
  hoursPlayed: 0,
  played: false,
  finished: false,
  playedSource: null,
  lastPlayedAt: null,
  experienceScore: 98,
  gameScore: 95,
  hasEnding: 1,
  hoursToValue: 3,
  confidence: "high",
  why: "Perfect pacing, no filler, and it ends before it outstays itself.",
  similarityNorm: 0.8,
  experienceFpm: 32.6,
  price: null,
  cut: null,
  reviewCount: 120000,
  reviewPercent: 98,
  tagNames: ["Puzzle", "First-Person", "Sci-fi"],
};

/** appid 1671210. ENDLESS – hasEnding 0, hoursToValue null, experienceFpm null. */
const DELTARUNE = {
  appid: 1671210,
  title: "DELTARUNE",
  owned: false,
  hoursPlayed: null,
  played: false,
  finished: false,
  playedSource: null,
  lastPlayedAt: null,
  experienceScore: 88,
  gameScore: 95,
  hasEnding: 0,
  hoursToValue: null,
  confidence: "high",
  why: "Superb writing, music, combat; story incomplete until later chapters",
  similarityNorm: 0.895,
  experienceFpm: null,
  price: null,
  cut: null,
  reviewCount: 2835,
  reviewPercent: 99,
  tagNames: ["Story Rich", "Great Soundtrack", "Pixel Graphics"],
};

/** appid 2878710. LOW CONFIDENCE, 320 reviews, a 1.5-hour game. */
const DESVELADO = {
  appid: 2878710,
  title: "Desvelado",
  owned: false,
  hoursPlayed: null,
  played: false,
  finished: false,
  playedSource: null,
  lastPlayedAt: null,
  experienceScore: 91,
  gameScore: 88,
  hasEnding: 1,
  hoursToValue: 1.5,
  confidence: "low",
  why: "Beautiful hand-drawn precision platformer; sharp, short, complete.",
  similarityNorm: 0.55,
  experienceFpm: 46.2,
  price: null,
  cut: null,
  reviewCount: 320,
  reviewPercent: 99,
  tagNames: ["Indie", "2D", "Precision Platformer"],
};

/** appid 1944430. ON SALE – $7.30, 80% off, regular $36.50. */
const AMNESIA_BUNKER = {
  appid: 1944430,
  title: "Amnesia: The Bunker",
  owned: false,
  hoursPlayed: null,
  played: false,
  finished: false,
  playedSource: null,
  lastPlayedAt: null,
  experienceScore: 90,
  gameScore: 88,
  hasEnding: 1,
  hoursToValue: 6,
  confidence: "high",
  why: "Tense, short, systemic horror; no padding, strong ending",
  similarityNorm: 0.9,
  experienceFpm: 36.3,
  price: 7.3,
  regular: 36.5,
  cut: 80,
  reviewCount: 9094,
  reviewPercent: 93,
  tagNames: ["Horror", "First-Person", "Survival Horror"],
};

const ALL = [PORTAL_2, TACTICAL_BREACH_WIZARDS, PORTAL, DELTARUNE, AMNESIA_BUNKER, DESVELADO];

// ---------------------------------------------------------------------------
// The constants the gates name.
// ---------------------------------------------------------------------------

test("GATE 2: the landing preset is `default` – `sale` can never be the landing state", () => {
  // SPEC.md §4.2. Measured in increment 11: only 1 of 552 owned games carries
  // a discount, so under `sale` an owned game is arithmetically pushed down
  // and the lens cannot answer "what do I play tonight". This is the named
  // constant the spec requires, and this is the assertion that enforces it.
  assert.equal(LANDING_PRESET, "default");
  assert.equal(LENSES[0].preset, LANDING_PRESET, "the first button in the strip is the landing lens");
  assert.equal(LENSES[0].label, "Play next");
});

test("PICK_COUNT is TEN – James's §10b.1 ruling, and one number drives the cards, the button and the sentence", () => {
  assert.equal(PICK_COUNT, 10);
  assert.equal(PICK_STEP, PICK_COUNT);
  assert.equal(basisSentence(13924, LIBRARY_STATE_PRESENT).startsWith("Ten picks from 13,924 games"), true);
});

test("the three lens labels and sub-lines are the ruled copy", () => {
  assert.deepEqual(
    LENSES.map((l) => l.label),
    ["Play next", "Worth buying", "More like what I play"],
  );
  assert.deepEqual(
    LENSES.map((l) => l.preset),
    ["default", "sale", "similarity"],
  );
  assert.equal(LENSES[0].subline, "Games ranked by how much they give back per hour, whether or not you own them.");
  assert.equal(LENSES[1].subline, "Games you don't own, weighted by how deep the discount is.");
  assert.equal(LENSES[2].subline, "Closest to your taste, whether or not you own it.");
});

// ---------------------------------------------------------------------------
// Increment 13 - the six price states, ruled by James at checkpoint 01 before
// any of them was built.
// ---------------------------------------------------------------------------

test("13 GATE 8: statusLine renders all six price_state values, and a price always beats a state", () => {
  // The exhaustive table from SPEC.md §6 as James approved it. Pinned as a
  // table rather than six separate asserts, so a wording change has to be a
  // deliberate edit here and cannot be smuggled in.
  const unowned = { owned: false, price: null, cut: null };
  const cases = [
    [{ ...unowned, price: 14.98, cut: 50 }, "$14.98 – 50% off", "priced and discounted"],
    [{ ...unowned, price: 29.95, cut: 0 }, "$29.95", "priced, no discount"],
    [{ ...unowned, priceState: "free" }, "Free to play", "free"],
    [{ ...unowned, priceState: "delisted" }, "Not sold on Steam any more", "delisted"],
    [{ ...unowned, priceState: "region" }, "Not sold in Australia", "region"],
    [{ ...unowned, priceState: "unknown" }, "Price not known", "checked, nothing to say"],
    [{ ...unowned, priceState: null }, "Price not known", "never checked"],
  ];
  for (const [row, expected, label] of cases) {
    assert.equal(statusLine(row), expected, label);
  }
});

test("13: a real price wins over any state, and an owned game still shows no price at all", () => {
  // The two invariants either side of the new table. A row can legitimately
  // carry a price AND a state - the fill writes both - and the number is the
  // more specific fact. And price stays suppressed entirely for a game you
  // own, which increment 12 ruled and this must not disturb.
  assert.equal(statusLine({ owned: false, price: 5.95, cut: 0, priceState: "priced" }), "$5.95");
  assert.equal(statusLine({ owned: false, price: 5.95, cut: 0, priceState: "free" }), "$5.95",
    "a stored price is not overridden by a stale state");
  assert.equal(statusLine({ owned: true, priceState: "free", price: 5.95 }), "In your library");
});

test("13: an unrecognised price_state falls back to Price not known rather than printing itself", () => {
  // Fail-soft on copy: a state outside the closed vocabulary must never reach
  // the page as raw data.
  assert.equal(statusLine({ owned: false, price: null, priceState: "on_sale_soon" }), "Price not known");
});

test("13 SEC-7: an INHERITED property name is not a price state - `constructor` reads Price not known", () => {
  // `priceState` is server-supplied, and the lookup table was a plain object
  // literal, so a bare bracket read answered "constructor", "toString",
  // "valueOf" and friends with an inherited member - putting a function's
  // source on a card. The table has no prototype now.
  for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"]) {
    const line = statusLine({ owned: false, price: null, priceState: key });
    assert.equal(line, "Price not known", `priceState "${key}" must not resolve to an inherited member`);
  }
});

test("13: the 991 and the 956 are DIFFERENT COUNTS, and this is which is which", () => {
  // Two review lanes reported two numbers for the same thing and both were
  // right. Measured live on 2026-09-06 over the real /api/rank rows:
  //
  //   991  ranked rows whose price_state is `unknown`   (the funnel's count)
  //   956  ranked CARDS that read "Price not known"     (what a reader sees)
  //   -35  the difference: rows James OWNS, where "In your library" wins
  //
  // The funnel counts states; the page renders sentences; owned rows never
  // show a price line at all. Neither number was asserted anywhere, which is
  // how they drifted apart in the artifacts.
  const unknownUnowned = { owned: false, price: null, priceState: "unknown" };
  const unknownOwned = { owned: true, price: null, priceState: "unknown", hoursPlayed: 3 };

  assert.equal(statusLine(unknownUnowned), "Price not known", "counted in BOTH numbers");
  assert.equal(statusLine(unknownOwned), "In your library – 3 hours played",
    "counted in the funnel's 991 and NOT in the page's 956");

  // The same split for a NULL state, which is a different fact from `unknown`
  // in the funnel and the identical sentence on the card.
  assert.equal(statusLine({ owned: false, price: null, priceState: null }), "Price not known");
  assert.equal(statusLine({ owned: true, price: null, priceState: null }), "In your library");
});

test("no copy anywhere in the module uses an em dash", () => {
  // A house rule James restates on every artifact, and the one typographic
  // mistake that is invisible until it is on screen.
  const strings = [
    ...LENSES.map((l) => l.subline),
    statusLine(TACTICAL_BREACH_WIZARDS),
    statusLine(PORTAL),
    statusLine({ ...PORTAL, played: true, playedSource: "you" }),
    statusLine({ ...PORTAL, played: true, finished: true, playedSource: "you" }),
    statusLine({ ...PORTAL_2, finished: true }),
    ...PLAY_STATES.map((s) => s.label),
    statusLine(AMNESIA_BUNKER),
    statusLine({ owned: false, price: null, priceState: "free" }),
    statusLine({ owned: false, price: null, priceState: "delisted" }),
    statusLine({ owned: false, price: null, priceState: "region" }),
    statusLine({ owned: false, price: null, priceState: "unknown" }),
    lengthLine(DELTARUNE),
    lengthLine(PORTAL_2),
    basisSentence(13924, LIBRARY_STATE_PRESENT),
    basisSentence(13924, LIBRARY_STATE_NO_CREDENTIALS),
    footerLine({ ranked: 13924, catalogTotal: 18306 }),
    RANK_UNAVAILABLE_LEAD,
  RANK_UNAVAILABLE_FALLBACK,
    perHourCell(DELTARUNE),
    libraryBanner({ profileAvailable: false, notice: null }),
    libraryBanner({ notice: "x" }),
    SIMILARITY_DISABLED_REASON,
    ...funnelBreakdown({ lowConfidenceSuppressed: 4186 }).map((r) => r.text),
    perHourCell({ experienceFpm: null, hasEnding: null }),
  ];
  for (const s of strings) assert.equal(String(s).includes("—"), false, `em dash in: ${s}`);
});

// ---------------------------------------------------------------------------
// The two chips – proved DISTINCT on the 0-hour owned game (gate 4).
// ---------------------------------------------------------------------------

test("GATE 4: the two chips are distinct, and Portal (owned, no play record) is where that shows", () => {
  // The worked example SPEC.md §4.3 names. An owned game with no play record
  // SURVIVES "hide games I've played" and DISAPPEARS under "hide games I
  // own". If a single predicate served both chips this test could not pass.
  //
  // INCREMENT 12.5 MOVED THIS FIXTURE, and the move is the increment in one
  // line: Tactical Breach Wizards used to play this role as "owned, 0 hours,
  // therefore unplayed", and it turns out James played it on 23 March 2025 –
  // Steam has been sending the date on every library fetch and nothing read
  // it. Portal takes the role because Portal is genuinely unrecorded: it is
  // one of the 297 games Steam has nothing at all for.
  assert.equal(passesHidePlayed(PORTAL, true), true, "no play record, so it survives 'hide played'");
  assert.equal(passesHideOwned(PORTAL, true), false, "owned, so it goes under 'hide owned'");

  // THE TRIGGER FOR THIS INCREMENT, CLOSED. Mark Portal played and the chip
  // finally removes it – which is the entire bug report.
  assert.equal(passesHidePlayed({ ...PORTAL, played: true, playedSource: "you" }, true), false);

  // And the 45: zero recorded hours, but Steam holds a last-played date, so
  // it is played and the chip hides it. Under the old `hoursPlayed <= 0` rule
  // this row survived, which was wrong on 45 owned games.
  assert.equal(passesHidePlayed(TACTICAL_BREACH_WIZARDS, true), false, "one of the 45 – Steam knows it was played");
  assert.equal(passesHideOwned(TACTICAL_BREACH_WIZARDS, true), false, "owned, so it goes under 'hide owned'");

  // Portal 2 is owned AND played, so it disappears under both.
  assert.equal(passesHidePlayed(PORTAL_2, true), false);
  assert.equal(passesHideOwned(PORTAL_2, true), false);

  // DELTARUNE is neither owned nor played, so it survives both.
  assert.equal(passesHidePlayed(DELTARUNE, true), true);
  assert.equal(passesHideOwned(DELTARUNE, true), true);
});

test("both chips off is the landing state and filters nothing", () => {
  assert.deepEqual(selectPicks(ALL, {}), ALL);
  assert.deepEqual(selectPicks(ALL, { hideOwned: false, hidePlayed: false }), ALL);
});

test("selectPicks composes the two chips and caps at PICK_COUNT", () => {
  assert.deepEqual(
    selectPicks(ALL, { hideOwned: true }).map((r) => r.title),
    ["DELTARUNE", "Amnesia: The Bunker", "Desvelado"],
  );
  assert.deepEqual(
    selectPicks(ALL, { hidePlayed: true }).map((r) => r.title),
    ["Portal", "DELTARUNE", "Amnesia: The Bunker", "Desvelado"],
  );
  assert.deepEqual(
    selectPicks(ALL, { hideOwned: true, hidePlayed: true }).map((r) => r.title),
    ["DELTARUNE", "Amnesia: The Bunker", "Desvelado"],
  );
  const many = Array.from({ length: 40 }, (_, i) => ({ ...DELTARUNE, appid: i }));
  assert.equal(selectPicks(many, {}).length, PICK_COUNT);
  assert.equal(selectPicks(many, {}, 20).length, 20);
});

test("a null hoursPlayed is treated as unplayed, not as an error", () => {
  // /api/rank returns hoursPlayed: null for anything not in the live library
  // join, which is every unowned row.
  assert.equal(passesHidePlayed({ owned: false, hoursPlayed: null }, true), true);
});

// ---------------------------------------------------------------------------
// The browse filter bar – each predicate independently (gate 5).
// ---------------------------------------------------------------------------

test("1. search is a case-insensitive title substring and an empty search is a no-op", () => {
  assert.equal(passesSearch(PORTAL_2, "portal"), true);
  assert.equal(passesSearch(PORTAL_2, "PORTAL"), true);
  assert.equal(passesSearch(PORTAL_2, "tal 2"), true);
  assert.equal(passesSearch(PORTAL_2, "half-life"), false);
  assert.equal(passesSearch(PORTAL_2, ""), true);
  assert.equal(passesSearch(PORTAL_2, "   "), true);
});

test("2. ownership is a TRI-state, and 'all' is not the same predicate as either other", () => {
  for (const row of ALL) assert.equal(passesOwnership(row, OWNERSHIP_ALL), true);
  assert.equal(passesOwnership(PORTAL_2, OWNERSHIP_HIDE), false);
  assert.equal(passesOwnership(PORTAL_2, OWNERSHIP_ONLY), true);
  assert.equal(passesOwnership(DELTARUNE, OWNERSHIP_HIDE), true);
  assert.equal(passesOwnership(DELTARUNE, OWNERSHIP_ONLY), false);
});

test("4. on-sale-only keeps rows with a real discount and drops priceless rows", () => {
  assert.equal(passesOnSaleOnly(AMNESIA_BUNKER, true), true);
  assert.equal(passesOnSaleOnly(DELTARUNE, true), false, "no price means no discount");
  assert.equal(passesOnSaleOnly(DELTARUNE, false), true);
});

test("5. minimum discount is a floor on `cut`", () => {
  assert.equal(passesMinDiscount(AMNESIA_BUNKER, 75), true);
  assert.equal(passesMinDiscount(AMNESIA_BUNKER, 90), false);
  assert.equal(passesMinDiscount(AMNESIA_BUNKER, 0), true);
  assert.equal(passesMinDiscount(DELTARUNE, 25), false);
});

test("6. a row with NO PRICE cannot satisfy a price ceiling", () => {
  // ~16,600 of 18,306 rows have no price. Letting them through an "under $10"
  // filter would be a lie about what the filter did.
  assert.equal(passesMaxPrice(AMNESIA_BUNKER, 10), true);
  assert.equal(passesMaxPrice(AMNESIA_BUNKER, 5), false);
  assert.equal(passesMaxPrice(DELTARUNE, 10), false, "no price is not 'free'");
  assert.equal(passesMaxPrice(DELTARUNE, null), true, "no ceiling set is a no-op");
  assert.equal(passesMaxPrice(DELTARUNE, ""), true);
});

test("7 + 8. taste and experience floors read the fields the API already returns", () => {
  assert.equal(passesMinTaste(DESVELADO, 0.5), true);
  assert.equal(passesMinTaste(DESVELADO, 0.75), false);
  assert.equal(passesMinTaste(DESVELADO, 0), true);
  assert.equal(passesMinExperience(DESVELADO, 90), true);
  assert.equal(passesMinExperience(DELTARUNE, 90), false);
  assert.equal(passesMinExperience(DELTARUNE, 0), true);
});

test("9. tags are include-only and two chips read as EITHER, not both", () => {
  assert.equal(passesTags(PORTAL_2, ["Puzzle"]), true);
  assert.equal(passesTags(PORTAL_2, ["Horror"]), false);
  assert.equal(passesTags(PORTAL_2, ["Horror", "Puzzle"]), true, "any, not all");
  assert.equal(passesTags(PORTAL_2, []), true);
  assert.equal(passesTags({ tagNames: [] }, ["Puzzle"]), false, "a tagless row cannot match a tag filter");
});

test("10. top 100 of all time is the Best-of rule with the discount gate removed, and it can return fewer than 100", () => {
  const set = selectTop100(ALL);
  // Only Portal 2 and Portal clear 95% AND 10,000 reviews in this fixture;
  // Amnesia has 9,094 reviews at 93%, DELTARUNE 2,835. The label must say the
  // real size, and the order is review count descending.
  assert.deepEqual(set.map((r) => r.title), ["Portal 2", "Portal"]);
  assert.equal(set.length < TOP100_LIMIT, true);
  assert.equal(TOP100_MIN_REVIEW_PERCENT, 95);
  assert.equal(TOP100_MIN_REVIEW_COUNT, 10000);

  // Ordered by review count descending, capped at 100.
  const big = Array.from({ length: 150 }, (_, i) => ({ ...PORTAL_2, appid: i, title: `G${i}`, reviewCount: 10000 + i }));
  const capped = selectTop100(big);
  assert.equal(capped.length, TOP100_LIMIT);
  assert.equal(capped[0].reviewCount, 10149);
  assert.equal(capped[99].reviewCount, 10050);
});

test("the chain composes, and the picks are NOT reachable from it", () => {
  // applyRankFilters is the browse list's chain and nothing else calls it.
  // selectPicks does not consult a single filter field, which is what makes
  // the landing state un-poisonable by a stale saved filter (SPEC.md §4.5).
  const out = applyRankFilters(ALL, { ownership: OWNERSHIP_HIDE, minExperience: 90 });
  assert.deepEqual(out.map((r) => r.title), ["Amnesia: The Bunker", "Desvelado"]);

  const picks = selectPicks(ALL, {});
  assert.deepEqual(picks, ALL, "the same filter object changed nothing about the picks");
});

test("filter state normalises a partial, an older or a corrupt saved blob without throwing", () => {
  assert.deepEqual(normaliseFilters(null), { ...DEFAULT_RANK_FILTERS });
  assert.deepEqual(normaliseFilters("not an object"), { ...DEFAULT_RANK_FILTERS });
  assert.equal(normaliseFilters({ ownership: "nonsense" }).ownership, OWNERSHIP_ALL);
  assert.deepEqual(normaliseFilters({ includeTags: "Puzzle" }).includeTags, []);
  assert.deepEqual(normaliseFilters({ includeTags: ["Puzzle", 7] }).includeTags, ["Puzzle"]);
  assert.equal(normaliseFilters({ search: "portal" }).search, "portal");
  assert.equal(RANK_FILTERS_SETTINGS_KEY, "rankFilters");
});

test("tag chips are ranked by how many rows in the pool carry them", () => {
  const tags = computeTopTags(ALL, 3);
  // "First-Person" and "Puzzle" both appear three times; ties break
  // alphabetically so the chip order is stable across reloads rather than
  // hash-order.
  assert.deepEqual(tags.slice(0, 2), [
    { name: "First-Person", count: 3 },
    { name: "Puzzle", count: 3 },
  ]);
  assert.equal(tags.length, 3);
});

// ---------------------------------------------------------------------------
// Increment 12.5 – the play-state select and "Games to check".
// ---------------------------------------------------------------------------

test("12.5 gate 3: the play-state select is four values and they partition the pool", () => {
  const FINISHED = { ...PORTAL, played: true, finished: true, playedSource: "you" };
  const rows = [PORTAL_2, TACTICAL_BREACH_WIZARDS, PORTAL, FINISHED, DELTARUNE];

  assert.deepEqual(PLAY_STATES.map((s) => s.value), ["all", "not-played", "played-not-finished", "finished"]);
  assert.deepEqual(PLAY_STATES.map((s) => s.label), ["All", "Not played", "Played, not finished", "Finished"]);

  const under = (v) => rows.filter((r) => passesPlayState(r, v)).map((r) => r.title);
  assert.deepEqual(under(PLAY_STATE_ALL), ["Portal 2", "Tactical Breach Wizards", "Portal", "Portal", "DELTARUNE"]);
  assert.deepEqual(under(PLAY_STATE_NOT_PLAYED), ["Portal", "DELTARUNE"]);
  // THE BACKLOG QUERY. Everything played that is not yet finished.
  assert.deepEqual(under(PLAY_STATE_PLAYING), ["Portal 2", "Tactical Breach Wizards"]);
  assert.deepEqual(under(PLAY_STATE_FINISHED), ["Portal"]);

  // The four are a partition of the pool: every row lands in exactly one of
  // the three non-"all" buckets.
  for (const row of rows) {
    const hits = [PLAY_STATE_NOT_PLAYED, PLAY_STATE_PLAYING, PLAY_STATE_FINISHED]
      .filter((v) => passesPlayState(row, v));
    assert.equal(hits.length, 1, `${row.title} landed in ${hits.length} buckets`);
  }
});

test("12.5: playState joins the saved blob and an older saved shape still loads", () => {
  assert.equal(DEFAULT_RANK_FILTERS.playState, PLAY_STATE_ALL);
  // A blob saved before increment 12.5 has no playState at all.
  assert.equal(normaliseFilters({ search: "portal", ownership: "only" }).playState, PLAY_STATE_ALL);
  // And a corrupt or hostile value falls back rather than filtering to nothing.
  assert.equal(normaliseFilters({ playState: "played" }).playState, PLAY_STATE_ALL);
  assert.equal(normaliseFilters({ playState: null }).playState, PLAY_STATE_ALL);
  assert.equal(normaliseFilters({ playState: PLAY_STATE_PLAYING }).playState, PLAY_STATE_PLAYING);
  // It is a BROWSE filter, so it must never reach the picks.
  assert.deepEqual(selectPicks(ALL, { playState: PLAY_STATE_FINISHED }), ALL);
});

test("12.5 gate 10: 'Games to check' is the top 50, owned, with no play record and no mark", () => {
  assert.equal(GAMES_TO_CHECK_WINDOW, 50, "James ruled the top 50 over 200 and 1,000");

  // Portal is the only row in ALL that qualifies: owned, and neither Steam nor
  // James can say it was played.
  assert.deepEqual(gamesToCheck(ALL).map((r) => r.title), ["Portal"]);

  // Marking it - by either toggle - takes it off the list, and that is the
  // whole mechanism by which 297 becomes a finite job.
  assert.deepEqual(gamesToCheck([{ ...PORTAL, played: true, playedSource: "you" }]), []);

  // The 45 are already off it without anyone lifting a finger.
  assert.deepEqual(gamesToCheck([TACTICAL_BREACH_WIZARDS]), []);
  // An unowned game is never "yours to check", however unplayed it is.
  assert.deepEqual(gamesToCheck([DELTARUNE]), []);

  // THE WINDOW IS THE POINT. A game at rank 51 is not in your way, so it is
  // not on the list - the work is bounded by the top of the ranking, not by
  // the size of the library.
  const deep = [...Array.from({ length: 50 }, (_, i) => ({ ...PORTAL_2, appid: i })), PORTAL];
  assert.deepEqual(gamesToCheck(deep), []);
  assert.deepEqual(gamesToCheck(deep, 51).map((r) => r.title), ["Portal"]);
  assert.deepEqual(gamesToCheck(null), []);
});

test("12.5 TC-3: a row with NO `played` key at all is treated as no-play-record, not as played", () => {
  // Every other 12.5 fixture sets `played` explicitly, so the three predicates
  // that read it survived `!== true` being rewritten to `=== false` – the
  // absent-key case was never exercised. It is a real shape: the page holds
  // rows across a cache version bump and a fail-soft /api/rank, and the source
  // uses `row?.played` optional chaining precisely because it may be missing.
  // The rule is the same one derivePlayed follows: absence is "no record",
  // and "no record" is NOT "played".
  const NO_KEY = { appid: 400, title: "Portal (no derived fields)", owned: true, hoursPlayed: 0 };
  assert.equal("played" in NO_KEY, false, "the fixture must genuinely lack the key");
  assert.equal("finished" in NO_KEY, false);

  // The chip keeps it: we have no basis for hiding it.
  assert.equal(passesHidePlayed(NO_KEY, true), true);
  // The select puts it in "Not played" and nowhere else – still a partition.
  assert.equal(passesPlayState(NO_KEY, PLAY_STATE_NOT_PLAYED), true);
  assert.equal(passesPlayState(NO_KEY, PLAY_STATE_PLAYING), false);
  assert.equal(passesPlayState(NO_KEY, PLAY_STATE_FINISHED), false);
  assert.equal(passesPlayState(NO_KEY, PLAY_STATE_ALL), true);
  // And it IS a game to check – an owned row with nothing saying it was played
  // is exactly what the list exists to surface.
  assert.deepEqual(gamesToCheck([NO_KEY]).map((r) => r.title), ["Portal (no derived fields)"]);

  // The same for an unowned row with no key: not played, and never "yours to
  // check", so the ownership term still does its own work.
  const UNOWNED_NO_KEY = { appid: 1671210, title: "DELTARUNE (no derived fields)", owned: false };
  assert.equal(passesHidePlayed(UNOWNED_NO_KEY, true), true);
  assert.equal(passesPlayState(UNOWNED_NO_KEY, PLAY_STATE_NOT_PLAYED), true);
  assert.deepEqual(gamesToCheck([UNOWNED_NO_KEY]), []);

  // An explicit `played: false` and an absent key must agree – if they ever
  // stop agreeing, the page has two meanings for "no record".
  assert.equal(passesHidePlayed({ ...NO_KEY, played: false }, true), passesHidePlayed(NO_KEY, true));
  assert.equal(
    gamesToCheck([{ ...NO_KEY, played: false }]).length,
    gamesToCheck([NO_KEY]).length,
  );
});

test("12.5: applyMark re-derives a row after a toggle, and a mark never overrides Steam", () => {
  // What the page does after a successful write, instead of re-fetching 10 MB.

  // The 297: the mark is the only evidence there is, so it becomes the source.
  const marked = applyMark(PORTAL, { played: 1, finished: 0 });
  assert.equal(marked.played, true);
  assert.equal(marked.finished, false);
  assert.equal(marked.playedSource, "you");
  assert.equal(statusLine(marked), "In your library – played (you said so)");

  // Finished implies played, exactly as the server stores it.
  const finished = applyMark(PORTAL, { played: 0, finished: 1 });
  assert.equal(finished.played, true);
  assert.equal(finished.finished, true);

  // Clearing removes the assertion and nothing else.
  assert.equal(applyMark(marked, { played: 0, finished: 0 }).played, false);
  assert.equal(applyMark(marked, { played: 0, finished: 0 }).playedSource, null);
  assert.equal(statusLine(applyMark(marked, { played: 0, finished: 0 })), "In your library – no play recorded");

  // STEAM ALWAYS KEEPS ITS SOURCE. Marking, or clearing a mark on, a game
  // Steam measured cannot make it unplayed - that is the refusal in §4.2.
  assert.equal(applyMark(PORTAL_2, { played: 0, finished: 0 }).played, true);
  assert.equal(applyMark(PORTAL_2, { played: 0, finished: 0 }).playedSource, "steam-playtime");
  assert.equal(applyMark(TACTICAL_BREACH_WIZARDS, { played: 0, finished: 0 }).played, true);
  assert.equal(applyMark(PORTAL_2, { played: 1, finished: 1 }).playedSource, "steam-playtime");
  assert.equal(statusLine(applyMark(PORTAL_2, { finished: 1 })), "In your library – finished · 17 hours played");

  // It is a copy, not a mutation - the caller replaces the row.
  const before = { ...PORTAL };
  applyMark(PORTAL, { played: 1 });
  assert.deepEqual(PORTAL, before);
});

test("BROWSE_PAGE_SIZE renders a window, not the pool", () => {
  assert.equal(BROWSE_PAGE_SIZE, 100);
});

// ---------------------------------------------------------------------------
// The copy James ruled on (SPEC.md §10c). The ruled words, literally.
// ---------------------------------------------------------------------------

test("§10c: the status line, in evaluation order, with price SUPPRESSED for an owned game", () => {
  assert.equal(statusLine(PORTAL), "In your library – no play recorded");
  assert.equal(statusLine(TACTICAL_BREACH_WIZARDS), "In your library – played, hours not recorded");
  assert.equal(statusLine(PORTAL_2), "In your library – 17 hours played");
  assert.equal(statusLine({ owned: true, hoursPlayed: 1 }), "In your library – 1 hour played");
  assert.equal(statusLine({ owned: true, hoursPlayed: 0.4 }), "In your library – under an hour played");
  assert.equal(statusLine(AMNESIA_BUNKER), "$7.30 – 80% off");
  assert.equal(statusLine({ owned: false, price: 29.99, cut: 0 }), "$29.99");

  // §10c.4: "No price on file" was rewritten without "on file". This renders
  // on roughly 16,600 of 18,306 rows.
  assert.equal(statusLine(DELTARUNE), "Price not known");

  // An owned game never shows a price, even when it has one.
  assert.equal(statusLine({ owned: true, hoursPlayed: 0, price: 12.5, cut: 50 }), "In your library – no play recorded");
});

test("12.5 gate 4: all SEVEN status-line cases, and no line disguises a mark as a measurement", () => {
  // James's ruled copy, literally, each against the real game that produces
  // it on the live page. The requirement every one of them serves: Steam's
  // number and James's verdict may both appear, and neither is ever dressed
  // up as the other.
  const marked = (extra) => ({ ...PORTAL, played: true, playedSource: "you", ...extra });

  // 1. Steam has hours. Unchanged from increment 12.
  assert.equal(statusLine(PORTAL_2), "In your library – 17 hours played");
  // 2. THE 45. Zero hours, but Steam holds a last-played date.
  assert.equal(statusLine(TACTICAL_BREACH_WIZARDS), "In your library – played, hours not recorded");
  assert.equal(
    statusLine({ owned: true, hoursPlayed: 0, played: true, playedSource: "steam-disconnected" }),
    "In your library – played, hours not recorded",
  );
  // 3. THE 297, marked played by James.
  assert.equal(statusLine(marked()), "In your library – played (you said so)");
  // 4. Finished, with Steam's hours beside it - BOTH facts, one line.
  assert.equal(
    statusLine({ ...PORTAL_2, finished: true }),
    "In your library – finished · 17 hours played",
  );
  // 5. Finished, Steam has nothing.
  assert.equal(statusLine(marked({ finished: true })), "In your library – finished (you said so)");
  // 6. THE CHANGED LINE. Owned, Steam has nothing, no mark.
  assert.equal(statusLine(PORTAL), "In your library – no play recorded");
  // 7. The seventh case, ruled at checkpoint 01: finished, and Steam knows a
  //    last-played date but no hours. One consistent rule, not a special case.
  assert.equal(
    statusLine({ ...TACTICAL_BREACH_WIZARDS, finished: true }),
    "In your library – finished · played, hours not recorded",
  );

  // THE INVARIANT THE COPY RESTS ON: a user assertion always carries "(you
  // said so)", and a Steam measurement never does.
  for (const row of [marked(), marked({ finished: true })]) {
    assert.equal(statusLine(row).includes("(you said so)"), true);
  }
  for (const row of [PORTAL_2, TACTICAL_BREACH_WIZARDS, PORTAL, { ...PORTAL_2, finished: true }]) {
    assert.equal(statusLine(row).includes("(you said so)"), false, `${row.title} presented a measurement as a mark`);
  }

  // And the browse column is the same fragment, still composed rather than
  // carved out of the sentence.
  assert.equal(ownedCell(marked()), "played (you said so)");
  assert.equal(ownedCell({ ...PORTAL_2, finished: true }), "finished · 17 hours played");
});

test("12.5: a mark on a row the live library never returned still reads honestly", () => {
  // Steam down, or no credentials: hoursPlayed is null on every row. A mark is
  // still the user's own assertion and is still true, so it renders - and an
  // UNMARKED row in that state still says nothing at all rather than "no play
  // recorded", because zero and unknown are different (the increment 12 bug).
  assert.equal(statusLine({ owned: true, hoursPlayed: null }), "In your library");
  assert.equal(
    statusLine({ owned: true, hoursPlayed: null, played: true, playedSource: "you" }),
    "In your library – played (you said so)",
  );
  assert.equal(playedFragment({ owned: true, hoursPlayed: null }), null);
});

test("§10c: the length line reads all THREE hasEnding states differently", () => {
  assert.equal(lengthLine(PORTAL_2), "About 9 hours to finish");
  assert.equal(lengthLine(DESVELADO), "About 1.5 hours to finish", "halves are kept, not rounded up");
  assert.equal(lengthLine({ hasEnding: 1, hoursToValue: 1 }), "About 1 hour to finish");

  // RULED BY JAMES 2026-09-05, replacing "No ending yet – it goes on as long as
  // you want". He rejected "yet": it implies an ending is coming later, which
  // is the opposite of the fact. His words were "No ending - game is endless.
  // Won't be able to factor into FPM" – and the FPM half of that ruling is
  // NOT on this card, because a pick card shows no per-hour figure to explain.
  // It is asserted on perHourCell instead. 4,799 of 13,924 ranked rows.
  assert.equal(lengthLine(DELTARUNE), "No ending – the game is endless");
  assert.equal(lengthLine(DELTARUNE).includes("yet"), false, "\"yet\" implies an ending is coming");

  // null is a THIRD state, not "endless".
  assert.equal(lengthLine({ hasEnding: null, hoursToValue: null }), "Length not known");
  assert.equal(lengthLine({ hasEnding: 1, hoursToValue: null }), "Length not known");
});

test("the card's remaining slots", () => {
  assert.equal(experienceLine(PORTAL_2), "Experience value 96/100");
  assert.equal(experienceLine({ experienceScore: null }), "");
  assert.equal(tagLine(PORTAL_2), "Platformer · Puzzle · First-Person");
  assert.equal(tagLine(TACTICAL_BREACH_WIZARDS), "Turn-Based Tactics · Puzzle · Turn-Based Strategy", "first three only");
  assert.equal(steamUrl(620), "https://store.steampowered.com/app/620/");
  assert.equal(steamUrl("620"), "https://store.steampowered.com/app/620/", "a numeric string is still an appid");
  assert.equal(confidenceTitle(DESVELADO), "Only 320 reviews, so this score is a rough guess rather than a confident one.");
});

test("the browse 'per hour' cell distinguishes endless from unknown", () => {
  // The obligation increment 11 §8 shipped experienceFpm to satisfy: an
  // endless game shows "endless" rather than a blank cell.
  assert.equal(perHourCell(PORTAL_2), "32.2");

  // The second half of James's 2026-09-05 ruling lands HERE, in the one cell
  // where the number is genuinely missing, and it says why in a reader's words.
  assert.equal(perHourCell(DELTARUNE), "endless – no per-hour figure");
  assert.equal(perHourCell(DELTARUNE).toLowerCase().includes("fpm"), false, "FPM is our word, not the reader's");

  // "Not known" and "cannot exist" stay different facts and must not read the
  // same – that distinction is the whole reason this function exists.
  assert.equal(perHourCell({ experienceFpm: null, hasEnding: null }), "–");
  assert.equal(perHourCell({ experienceFpm: null, hasEnding: 1 }), "–");
});

test("numbers are formatted for a reader, never printed raw", () => {
  assert.equal(formatCount(13924), "13,924");
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(null), "0");
  assert.equal(formatPrice(7.3), "$7.30");
  assert.equal(formatPrice(29.99), "$29.99");
  assert.equal(numberWord(10), "Ten");
  assert.equal(numberWord(5), "Five");
  assert.equal(numberWord(99), "99");
});

test("§10c.5: the footer generates from `funnel` and SUPPRESSES every zero row", () => {
  // The real funnel from review/inc-11/07-funnel-and-suppression.md. `unscored`
  // and `dismissed` are both 0 today, so four rows print and not six –
  // "0 you dismissed" is noise dressed as disclosure.
  const funnel = {
    catalogTotal: 18306,
    nonGame: 85,
    checkedNoScore: 2,
    unscored: 0,
    rankExcluded: 109,
    dismissed: 0,
    lowConfidenceSuppressed: 4186,
    ranked: 13924,
  };
  assert.equal(footerLine(funnel), "Ranked 13,924 of 18,306 games in the catalogue.");

  const rows = funnelBreakdown(funnel);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.text), [
    "4,186 hidden – too few reviews to trust the score",
    "109 hidden – prologues and demos of other games",
    "85 hidden – not games (soundtracks, tools, videos)",
    "2 hidden – checked but not scorable",
  ]);

  // And the arithmetic the footer implies actually holds.
  const subtracted = rows.reduce((sum, r) => sum + r.count, 0);
  assert.equal(funnel.catalogTotal - subtracted, funnel.ranked, "18306 - 85 - 2 - 109 - 4186 = 13924");
});

// ---------------------------------------------------------------------------
// The three first-run states (gate 3).
// ---------------------------------------------------------------------------

test("GATE 3: the three first-run states are detected from the fields /api/rank returns for exactly this", () => {
  const present = { profileAvailable: true, profileGames: 164, notice: null };
  const noCreds = { profileAvailable: false, profileGames: 0, notice: null };
  const steamDown = { profileAvailable: false, profileGames: 0, notice: "Steam library unavailable – …" };

  assert.equal(libraryState(present), LIBRARY_STATE_PRESENT);
  assert.equal(libraryState(noCreds), LIBRARY_STATE_NO_CREDENTIALS);
  assert.equal(libraryState(steamDown), LIBRARY_STATE_FETCH_FAILED);

  // A notice WINS over profileAvailable: credentials-present-but-Steam-failed
  // must not be reported as "no account connected".
  assert.equal(libraryState({ profileAvailable: true, notice: "x" }), LIBRARY_STATE_FETCH_FAILED);

  assert.equal(libraryBanner(present), null, "a working library says nothing");
  // ROUND-2 REVIEW (CR-7). The old wording was "No Steam account is
  // connected", which `libraryState` cannot actually know: credentials
  // PRESENT with zero contributing games produces exactly this same shape
  // (profileAvailable false, no notice) and would have been told, falsely,
  // that no account was connected. /api/rank exposes no credentials flag and
  // src/ is frozen, so the sentence describes what the page HAS rather than
  // diagnosing why. James rules on this string at the gate.
  assert.equal(
    libraryBanner(noCreds),
    "No Steam library is behind these picks, so they are not matched to your taste. They are ranked on experience value alone.",
  );
  assert.equal(libraryBanner(noCreds).includes("account"), false, "the page cannot see whether an account is configured");
  assert.equal(
    libraryBanner(steamDown),
    "Your Steam library could not be loaded, so these picks are not matched to your taste. They are ranked on experience value alone.",
  );

  assert.equal(similarityLensEnabled(present), true);
  assert.equal(similarityLensEnabled(noCreds), false);
  assert.equal(similarityLensEnabled(steamDown), false);
  // The two reasons are DIFFERENT, and telling a Steam-down user their
  // account is not connected would be false.
  assert.equal(similarityDisabledReason(noCreds), "No Steam library is loaded.");
  assert.equal(similarityDisabledReason(steamDown), "Your Steam library could not be loaded.");
  assert.equal(SIMILARITY_DISABLED_REASON, "No Steam library is loaded.");
  assert.equal(SIMILARITY_UNAVAILABLE_REASON, "Your Steam library could not be loaded.");
});

// ---------------------------------------------------------------------------
// Round-2 review fixes. Each test names the finding it closes.
// ---------------------------------------------------------------------------

test("CR-1: the basis sentence stops claiming a library match in the two states where there is no library", () => {
  // The bug: the sentence ended "then matched against what is already in your
  // Steam library" UNCONDITIONALLY, and in both no-library states it rendered
  // directly above a banner saying these picks are NOT matched to your taste.
  // Two stacked sentences contradicting each other, on the exact screen the
  // gate exists to test ("says so plainly instead of quietly serving
  // taste-blind picks that look normal").
  const withLibrary = basisSentence(13924, LIBRARY_STATE_PRESENT);
  const noCreds = basisSentence(13924, LIBRARY_STATE_NO_CREDENTIALS);
  const steamDown = basisSentence(13924, LIBRARY_STATE_FETCH_FAILED);

  assert.equal(
    withLibrary,
    "Ten picks from 13,924 games on Steam, scored on how much a game gives back for the hours it takes, then matched against what is already in your Steam library.",
  );
  assert.equal(
    noCreds,
    "Ten picks from 13,924 games on Steam, scored on how much a game gives back for the hours it takes.",
  );
  assert.equal(steamDown, noCreds, "both no-library states read the same, because they are the same claim");

  for (const [name, sentence] of [["no-credentials", noCreds], ["steam-down", steamDown]]) {
    assert.equal(sentence.includes("your Steam library"), false, `${name} still claims a library match`);
    assert.equal(sentence.includes("matched"), false, `${name} still claims a match`);
  }

  // Both halves survive: the count is generated and the number word tracks
  // PICK_COUNT in the SHORT sentence too, not just the long one.
  assert.equal(noCreds.startsWith(`${numberWord(PICK_COUNT)} picks from 13,924 games`), true);
  assert.equal(basisSentence(7, LIBRARY_STATE_NO_CREDENTIALS).includes("from 7 games"), true);

  // An omitted state UNDER-claims rather than lying. A caller who forgets the
  // argument gets the honest short sentence, not the confident long one.
  assert.equal(basisSentence(13924, undefined).includes("your Steam library"), true, "the default is the present state");
  assert.equal(basisSentence(13924, "something-unrecognised").includes("your Steam library"), false);
});

test("CR-3 / TC-3: nulls sort LAST in BOTH directions, so an endless game is never mistaken for a zero", () => {
  // §4.4's named obligation, and it had no assertion at all while the
  // comparator lived in public/index.html. DELTARUNE is endless: hoursToValue
  // is null, and null is not 0.
  const rows = [PORTAL_2, DESVELADO, DELTARUNE, AMNESIA_BUNKER];   // 9h, 1.5h, null, 6h

  const desc = sortRows(rows, { key: "hoursToValue", dir: "desc" });
  assert.deepEqual(desc.map((r) => r.hoursToValue), [9, 6, 1.5, null]);

  const asc = sortRows(rows, { key: "hoursToValue", dir: "asc" });
  assert.deepEqual(asc.map((r) => r.hoursToValue), [1.5, 6, 9, null]);

  // THE ASYMMETRY IS THE POINT. Ascending, the shortest real game leads; the
  // endless one is still at the bottom rather than at the top where a
  // null-as-zero would put it.
  assert.equal(asc[0].title, "Desvelado");
  assert.equal(asc.at(-1).title, "DELTARUNE", "endless sorts last ascending too");
  assert.equal(desc.at(-1).title, "DELTARUNE");

  // Strings compare as strings, numbers as numbers.
  assert.deepEqual(
    sortRows(rows, { key: "title", dir: "asc" }).map((r) => r.title),
    ["Amnesia: The Bunker", "DELTARUNE", "Desvelado", "Portal 2"],
  );

  // No column sorted is a pass-through, and the input array is never mutated.
  const original = [...rows];
  assert.equal(sortRows(rows, { key: null, dir: "desc" }), rows);
  sortRows(rows, { key: "hoursToValue", dir: "asc" });
  assert.deepEqual(rows, original, "sorting returns a new array");

  // Two nulls tie rather than throwing.
  assert.equal(sortRows([DELTARUNE, { ...DELTARUNE, title: "Other" }], { key: "hoursToValue", dir: "desc" }).length, 2);
});

test("CR-4 / TC-4: the browse 'Yours' cell is COMPOSED from the status line, never carved out of it", () => {
  // The bug: the cell did `statusLine(r).replace("In your library – ", "")`,
  // hard-coding another module's separator. §10c is a live document – James
  // has already re-ruled two of these strings once – and the next time he
  // touches that separator the replace silently no-ops and the column prints
  // the whole sentence instead of the fragment.
  assert.equal(ownedCell(PORTAL_2), "17 hours played");
  assert.equal(ownedCell(PORTAL), "no play recorded");
  assert.equal(ownedCell(TACTICAL_BREACH_WIZARDS), "played, hours not recorded");
  assert.equal(ownedCell({ owned: true, hoursPlayed: 0.4 }), "under an hour played");
  assert.equal(ownedCell({ owned: true, hoursPlayed: 1 }), "1 hour played");
  assert.equal(ownedCell(DELTARUNE), "", "a game you do not own has nothing in the Yours column");

  // Unknown playtime falls back to the bare prefix – the same thing the old
  // replace produced, because "In your library – " never matched it.
  assert.equal(ownedCell({ owned: true, hoursPlayed: null }), OWNED_PREFIX);
  assert.equal(playedFragment({ owned: true, hoursPlayed: null }), null);

  // THE COUPLING ITSELF, asserted. If the separator or the prefix is re-ruled,
  // this fails rather than the column quietly changing shape.
  for (const row of [PORTAL_2, TACTICAL_BREACH_WIZARDS, PORTAL, { owned: true, hoursPlayed: 0.4 }]) {
    assert.equal(statusLine(row), `${OWNED_PREFIX} – ${playedFragment(row)}`);
    assert.equal(statusLine(row).endsWith(ownedCell(row)), true);
  }
  assert.equal(statusLine({ owned: true, hoursPlayed: null }), OWNED_PREFIX);
});

test("SEC-2 / TC-6: a fail-soft HTTP 200 from /api/rank is NOT a payload, and it is not a cold start either", () => {
  // src/worker.js rankUnavailableResponse: a missing FPM_DB binding or a D1
  // throw returns this, at status 200, with no funnel and no rank. `res.ok`
  // is true for it. Storing it made renderAll throw on `p.funnel.ranked`, and
  // the boot catch then told the reader the server "may still be starting up.
  // Reload to try again" – a database failure reported as a slow start, with
  // a remedy that can never work.
  const failSoft = { available: false, notice: "Ranking unavailable" };
  const noDb = { available: false, notice: "FPM_DB not configured" };
  const real = { available: true, funnel: { ranked: 13924, catalogTotal: 18306 }, rank: ALL, notice: null };

  assert.equal(isRenderablePayload(real), true);
  assert.equal(isRenderablePayload(failSoft), false);
  assert.equal(isRenderablePayload(noDb), false);

  // Every field renderAll dereferences, checked.
  assert.equal(isRenderablePayload({ ...real, funnel: undefined }), false, "no funnel");
  assert.equal(isRenderablePayload({ ...real, funnel: {} }), false, "a funnel with no ranked count");
  assert.equal(isRenderablePayload({ ...real, rank: undefined }), false, "no rank array");
  assert.equal(isRenderablePayload({ ...real, rank: {} }), false, "rank must be an ARRAY");
  assert.equal(isRenderablePayload({ ...real, available: undefined }), false, "available must be explicitly true");
  assert.equal(isRenderablePayload(null), false);
  assert.equal(isRenderablePayload("{}"), false);

  // An EMPTY rank array is renderable: zero picks after a dismissal spree is a
  // real state with its own honest copy, not a failure.
  assert.equal(isRenderablePayload({ ...real, rank: [], funnel: { ranked: 0 } }), true);

  // §10c.2's pattern: the plain sentence leads, the SERVER'S OWN WORDS follow
  // verbatim as technical detail. "FPM_DB not configured" is true and is also
  // four words of ours that mean nothing to a reader.
  assert.equal(unavailableMessage(failSoft), "Ranking unavailable");
  assert.equal(unavailableMessage(noDb), "FPM_DB not configured");
  assert.equal(unavailableMessage({ available: false, notice: "  padded  " }), "padded");
  assert.equal(unavailableMessage({ available: false }), RANK_UNAVAILABLE_FALLBACK);
  assert.equal(unavailableMessage({ available: false, notice: "" }), RANK_UNAVAILABLE_FALLBACK);
  assert.equal(unavailableMessage(null), RANK_UNAVAILABLE_FALLBACK);

  // THE LEAD MUST NOT REPEAT THE COLD-START LIE. This is the whole finding: a
  // database failure was being reported as a slow first load, with a remedy
  // that can never work.
  assert.equal(
    RANK_UNAVAILABLE_LEAD,
    "There are no picks to show, because the ranking could not be read. This is not a slow first load, and reloading will not fix it.",
  );
  assert.equal(/starting up/i.test(RANK_UNAVAILABLE_LEAD), false);
  assert.equal(/reload to try again/i.test(RANK_UNAVAILABLE_LEAD), false);
  assert.equal(RANK_UNAVAILABLE_LEAD.includes("reloading will not fix it"), true);
});

test("SEC-4: a hostile appid cannot escape the only attribute this page interpolates into", () => {
  // steamUrl is the ONE place upstream data reaches an href rather than
  // textContent, which makes it the only interpolation on the page with
  // anywhere to go. `appid` is a D1 integer today; that is a fact about the
  // current schema, not a guarantee about the JSON the browser is handed.
  const hostile = [
    "javascript:alert(1)",
    "620/../../../evil",
    "620\" onmouseover=\"alert(1)",
    "620?x=1",
    "//evil.example.com",
    "",
    null,
    undefined,
    NaN,
    -620,
    0,
    1.5,
    {},
    [],
  ];
  for (const appid of hostile) {
    const url = steamUrl(appid);
    assert.equal(url, STEAM_STORE_ROOT, `steamUrl(${JSON.stringify(String(appid))}) escaped to ${url}`);
    assert.equal(url.startsWith("https://store.steampowered.com/"), true);
    assert.equal(/javascript:/i.test(url), false);
  }
  // The fallback is a real, harmless destination – an empty href would
  // re-navigate to this page, which reads as a broken link rather than a
  // rejected one.
  assert.equal(STEAM_STORE_ROOT, "https://store.steampowered.com/");
});

test("SEC-6: nothing under public/ ever builds DOM from a string – the whole XSS defence, pinned", () => {
  // THE PROPERTY THIS ASSERTS IS THE ENTIRE DEFENCE. Every insertion on the
  // page is createElement + textContent, which is why a game title, a tag and
  // an LLM-authored reason line can all be rendered without escaping anything.
  // Nothing enforced it, so one convenient `innerHTML =` in a future increment
  // would reopen the surface silently. Same idiom as catalog-experience's
  // HERMETICITY guard: read the real file, assert the real property.
  const SINKS = ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "createContextualFragment", "eval("];
  for (const file of ["index.html", "rankFilters.js"]) {
    const source = readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8");
    for (const sink of SINKS) {
      assert.equal(source.includes(sink), false, `public/${file} uses ${sink} – the no-markup rule is broken`);
    }
    // The positive half: the page really does insert text the safe way.
    if (file === "index.html") {
      assert.equal(source.includes("textContent"), true);
      assert.equal(source.includes("createElement"), true);
    }
  }
});

test("a NULL hoursPlayed on an owned row says nothing about playtime - it is not 'no play recorded'", () => {
  // Caught while capturing the first-run states. With no credentials, or with
  // Steam down, the LIVE library join is empty so every hoursPlayed is null -
  // but `owned` survives on D1's own source_owned stamp. Portal 2 has 17
  // hours on it and was being rendered "never played".
  assert.equal(statusLine({ owned: true, hoursPlayed: null }), "In your library");
  assert.equal(statusLine({ owned: true, hoursPlayed: undefined }), "In your library");

  // Increment 12.5: 0 is not null and neither of them is "never". A LIVE zero
  // means Steam holds no record - true of 297 owned games, of which Portal is
  // one - and an ABSENT hoursPlayed means the library join did not happen at
  // all, which says nothing about anything.
  assert.equal(statusLine({ owned: true, hoursPlayed: 0 }), "In your library – no play recorded");
  // The string that used to render there, gone from the module entirely.
  assert.equal(/never played/.test(statusLine({ owned: true, hoursPlayed: 0 })), false);
  assert.equal(statusLine({ owned: true, hoursPlayed: 17 }), "In your library – 17 hours played");
});

test("with no library every similarityNorm is 0, which is why the band reads None and the slot is dropped", () => {
  // Both normalisers return 0 for every row when the profile is empty:
  // percentileRankNormalise's strictly-below rule gives a whole tie block 0,
  // and minMaxNormalise returns zeros on a zero span. Ten identical "None"
  // chips would be honest per row and misleading as a page.
  assert.equal(tasteBand(0), "None");
  assert.equal(tasteBand(null), "None");
  assert.equal(tasteBand(undefined), "None");
});

test("the taste bands, at their exact boundaries", () => {
  assert.equal(tasteBand(0.99), "Very strong");
  assert.equal(tasteBand(0.9), "Very strong");
  assert.equal(tasteBand(0.8999), "Strong");
  assert.equal(tasteBand(0.75), "Strong");
  assert.equal(tasteBand(0.7499), "Some");
  assert.equal(tasteBand(0.5), "Some");
  assert.equal(tasteBand(0.4999), "Not much");
  assert.equal(tasteBand(0.0001), "Not much");
  assert.deepEqual(TASTE_BANDS.map((b) => b.label), ["Very strong", "Strong", "Some", "Not much"]);
});

// ---------------------------------------------------------------------------
// QA round, post-gate. TC-1 and TC-2: the two properties the audit found were
// ASSERTED but not PROVEN. Both survived mutation at 788/788 green, and each
// was re-run red against the bug before being written here.
// ---------------------------------------------------------------------------

test("TC-1: the footer, the breakdown and the basis sentence are GENERATED from the payload, proved on a second funnel that is not today's", () => {
  // THE HOLE THIS CLOSES. Every funnel assertion in this file used the one
  // real production funnel (18,306 / 13,924 / 4,186 / 109 / 85 / 2), so a
  // funnelBreakdown or footerLine rewritten to `return` those numbers as
  // constants passed every test. That is precisely the property SPEC.md
  // §4.1.2 states ("the number comes from `funnel.ranked`, not a constant")
  // and the drift §10c.3 cited when James took the count out of the loading
  // copy. Proved by mutation: hardcoding both functions to today's values
  // left 36/36 green before this test existed, and fails here.
  //
  // A SECOND funnel, sharing no number with the first, and with all six rows
  // non-zero so the two the real funnel suppresses are exercised for the
  // first time.
  const synthetic = {
    catalogTotal: 9001,
    lowConfidenceSuppressed: 1234,
    rankExcluded: 57,
    nonGame: 8,
    checkedNoScore: 3,
    unscored: 11,
    dismissed: 4,
    ranked: 7684,
  };

  assert.equal(footerLine(synthetic), "Ranked 7,684 of 9,001 games in the catalogue.");

  const rows = funnelBreakdown(synthetic);
  assert.equal(rows.length, 6, "no row is zero in this funnel, so none is suppressed");
  assert.deepEqual(rows.map((r) => r.text), [
    "1,234 hidden – too few reviews to trust the score",
    "57 hidden – prologues and demos of other games",
    "8 hidden – not games (soundtracks, tools, videos)",
    "3 hidden – checked but not scorable",
    "11 hidden – not scored yet",
    "4 hidden – you dismissed",
  ]);
  assert.deepEqual(rows.map((r) => r.count), [1234, 57, 8, 3, 11, 4]);

  // The arithmetic the footer implies holds on this funnel too, which is the
  // only reason a reader should believe the four numbers under it.
  assert.equal(
    synthetic.catalogTotal - rows.reduce((sum, r) => sum + r.count, 0),
    synthetic.ranked,
    "9001 - 1234 - 57 - 8 - 3 - 11 - 4 = 7684",
  );

  // Not one of today's numbers appears anywhere in the output.
  const printed = [footerLine(synthetic), ...rows.map((r) => r.text)].join(" | ");
  for (const stale of ["18,306", "13,924", "4,186", "109", "85"]) {
    assert.equal(printed.includes(stale), false, `the footer printed today's ${stale} from a funnel that does not contain it`);
  }

  // Zero-suppression is per ROW, not a fixed shape: a funnel where only the
  // two normally-suppressed rows are non-zero prints exactly those two.
  const onlyTheSuppressedOnes = { catalogTotal: 20, ranked: 5, unscored: 9, dismissed: 6 };
  assert.deepEqual(funnelBreakdown(onlyTheSuppressedOnes).map((r) => r.text), [
    "9 hidden – not scored yet",
    "6 hidden – you dismissed",
  ]);
  assert.equal(footerLine(onlyTheSuppressedOnes), "Ranked 5 of 20 games in the catalogue.");

  // THE BASIS SENTENCE, in the LIBRARY-PRESENT state – the one a stranger
  // reads on the landing page, and the only branch the CR-1 test did not pin
  // a generated count on. Hardcoding just this branch survived 36/36.
  assert.equal(
    basisSentence(synthetic.ranked, LIBRARY_STATE_PRESENT),
    "Ten picks from 7,684 games on Steam, scored on how much a game gives back for the hours it takes, then matched against what is already in your Steam library.",
  );
  assert.equal(basisSentence(synthetic.ranked, LIBRARY_STATE_PRESENT).includes("13,924"), false);
  assert.equal(
    basisSentence(synthetic.ranked, LIBRARY_STATE_NO_CREDENTIALS),
    "Ten picks from 7,684 games on Steam, scored on how much a game gives back for the hours it takes.",
  );

  // And the count is the count it was handed, not a rounding or a re-derivation.
  assert.equal(basisSentence(1, LIBRARY_STATE_PRESENT).includes("from 1 games"), true);
  assert.equal(basisSentence(0, LIBRARY_STATE_PRESENT).includes("from 0 games"), true);
});

test("GATE 5, TC-2: the picks are provably unaffected by a REAL filter object, not an empty one", () => {
  // THE HOLE THIS CLOSES. The existing chain test asserted "the picks are NOT
  // reachable from it" while calling `selectPicks(ALL, {})` – an EMPTY object,
  // which cannot detect the coupling it claims to rule out. Proved by
  // mutation: adding `passesMinExperience` and `passesOwnership` to
  // selectPicks left 36/36 green. The page is safe today only because
  // `state.chips` and `state.filters` are separate objects in index.html,
  // which no test reaches. This is SPEC.md §4.5's closing rule and gate 5's
  // last clause: "the picks are provably unaffected by any filter".
  const filterShaped = {
    ownership: OWNERSHIP_HIDE,
    minExperience: 90,
    top100: true,
  };
  assert.deepEqual(selectPicks(ALL, filterShaped), ALL, "a filter-shaped object changed nothing about the picks");

  // The same filter really does bite on the browse chain, so the assertion
  // above is a statement about selectPicks and not about a filter that does
  // nothing. OWNERSHIP_HIDE alone removes the two owned rows.
  // Portal 2 is the only row clearing the top-100 rule and it is owned, so
  // hide-owned plus top-100 empties the browse list entirely – while the same
  // object leaves all five picks standing.
  assert.deepEqual(applyRankFilters(ALL, filterShaped), [], "the filter really does bite in browse");
  assert.equal(selectPicks(ALL, filterShaped).length, ALL.length);

  // EVERY non-chip key of the saved filter blob, one at a time, set to a
  // value that DOES bite in browse. A future eleventh filter added to
  // DEFAULT_RANK_FILTERS and wired into selectPicks fails here.
  const CHIP_KEYS = new Set(["hideOwned", "hidePlayed"]);
  const BITING = {
    search: "portal",
    ownership: OWNERSHIP_ONLY,
    onSaleOnly: true,
    minDiscount: 90,
    maxPrice: 1,
    minTaste: 0.99,
    minExperience: 97,
    includeTags: ["Horror"],
    top100: true,
    // Increment 12.5. "Finished" bites hard on this fixture: nothing in ALL
    // is marked finished, so the browse list empties while the picks must not
    // move by a single row.
    playState: PLAY_STATE_FINISHED,
  };
  for (const key of Object.keys(DEFAULT_RANK_FILTERS)) {
    if (CHIP_KEYS.has(key)) continue;
    assert.ok(key in BITING, `DEFAULT_RANK_FILTERS gained "${key}" and this test does not exercise it`);
    const one = { [key]: BITING[key] };
    assert.deepEqual(selectPicks(ALL, one), ALL, `selectPicks consulted the browse filter "${key}"`);
    assert.equal(applyRankFilters(ALL, one).length < ALL.length, true, `the browse filter "${key}" did not bite, so the check above proves nothing`);
  }

  // The whole saved blob at once, and the defaults, both no-ops on the picks.
  assert.deepEqual(selectPicks(ALL, normaliseFilters(BITING)), ALL);
  assert.deepEqual(selectPicks(ALL, { ...DEFAULT_RANK_FILTERS }), ALL);

  // The two chips are the ONLY keys selectPicks reads, and they still work –
  // otherwise "ignores everything" could be satisfied by ignoring everything.
  assert.deepEqual(
    selectPicks(ALL, { ...filterShaped, hideOwned: true }).map((r) => r.title),
    ["DELTARUNE", "Amnesia: The Bunker", "Desvelado"],
  );
  assert.deepEqual(
    selectPicks(ALL, { ...filterShaped, hidePlayed: true }).map((r) => r.title),
    ["Portal", "DELTARUNE", "Amnesia: The Bunker", "Desvelado"],
  );

  // NOTE FOR THE NEXT CHANGE, and it is the one live hazard here: the browse
  // blob carries its own `hidePlayed`, the same NAME as a chip. Handing the
  // saved filter object to selectPicks would therefore silently move the
  // picks through that one key. index.html keeps `state.chips` and
  // `state.filters` apart, which is what makes the landing state
  // un-poisonable by a stale saved filter – and that separation lives in the
  // untested file.
  assert.equal("hidePlayed" in DEFAULT_RANK_FILTERS, true);
  assert.equal("hideOwned" in DEFAULT_RANK_FILTERS, false);
  assert.deepEqual(
    selectPicks(ALL, { ...DEFAULT_RANK_FILTERS, hidePlayed: true }).map((r) => r.title),
    ["Portal", "DELTARUNE", "Amnesia: The Bunker", "Desvelado"],
    "the collision, stated: this is the one key of the blob that would move the picks",
  );
});

test("QA guard: the four round-2 failure paths still exist in public/index.html – a smoke alarm, NOT a behavioural proof", () => {
  // WHAT THIS TEST IS AND IS NOT. `public/index.html` is one inline module
  // against a live DOM and it has no importable seam – that seam is
  // `rankFilters.js`, deliberately (SPEC.md §6). Four behaviours from the
  // round-2 fix list therefore live ONLY in that file and were verified by
  // driving a real browser against a real server (06-review-fixes.md), which
  // is a thing no assertion in this suite repeats. This reads the real file
  // and checks the four are still present, in the same idiom as the SEC-6
  // no-markup guard. It catches DELETION and it does not catch BREAKAGE: a
  // rewrite that keeps the shape and loses the behaviour passes here and only
  // a re-drive would find it. Whoever touches those four paths owes a re-drive.
  const source = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

  // SEC-3: the lens rollback. `state.preset` moves before the fetch so the lit
  // button and the loading state agree; leaving it moved after a failed fetch
  // made the next chip toggle overwrite a network error with "No picks left
  // with those filters on" – a filter explanation for a network failure.
  assert.match(source, /const previous = state\.preset;/, "the lens rollback's saved preset is gone");
  assert.match(source, /catch[\s\S]{0,120}state\.preset = previous;/, "state.preset is no longer restored on a failed lens fetch");

  // SEC-1: the undo. DELETE /api/dismissals fail-softs at HTTP 200 with
  // `{restored:false}`, so the failure neither threw nor was checked.
  assert.match(source, /method: "DELETE"/, "the undo's DELETE is gone");
  assert.match(source, /restored\s*=\s*res\.ok && \(await res\.json\(\)\)\?\.restored === true/, "the {restored:false} flag is no longer checked");
  assert.match(source, /if \(!restored\)/, "a failed undo is no longer branched on");
  assert.equal(source.includes("Couldn't undo that – it is still dismissed."), true, "the user is no longer told the undo failed");
  assert.equal(source.includes('undo.textContent = "Try again"'), true);

  // CR-2: a restore goes into the ORIGINATING lens only; the others are
  // dropped so they re-fetch their own honest order rather than being
  // re-sorted by a score their blend never produced.
  assert.match(source, /if \(key !== origin\) state\.payloads\.delete\(key\);/, "undo pushes the row into every lens again");

  // SEC-2: the fail-soft 200 is validated before it is stored as a payload.
  assert.match(source, /if \(!isRenderablePayload\(body\)\) throw new RankUnavailable\(body\);/);

  // SEC-5: the global handler. Without it a thrown error or a rejected promise
  // left a half-painted page and a console entry nobody opens.
  assert.match(source, /window\.addEventListener\("error", reportCrash\);/);
  assert.match(source, /window\.addEventListener\("unhandledrejection", reportCrash\);/);
  assert.equal(
    source.includes("Something on this page stopped working, so what you are looking at may be incomplete. Reload to try again."),
    true,
  );

  // The cold-start claim must not come back anywhere on the page, in any file.
  //
  // This assertion was inverted on 2026-09-05. QA scoped the cold-start copy to
  // the fetch-never-landed branch and pinned that it stayed there - but that
  // branch also catches an HTTP 500, and a 500 means the server ANSWERED, so
  // "may still be starting up" was false there too. It was the same lie A2
  // removed from the database-down path, one rung down and quieter. The page
  // cannot tell a cold start from a crash, so it now claims neither. Asserting
  // ABSENCE is what this test's own comment always said it was for.
  // Comments are stripped first. Two of them quote the retired string while
  // explaining why it went, and a guard that cannot tell a code comment from
  // rendered copy would either fail on its own documentation or force the
  // history out of the file. What matters is what a reader SEES.
  const rendered = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.equal(
    /may still be starting up/.test(rendered), false,
    "the page must never claim the server is starting up - it cannot know that, and an HTTP 500 proves the opposite",
  );
  assert.match(source, /Reloading may help; if it does not, the server is not answering properly\./);
  assert.equal(source.includes(RANK_UNAVAILABLE_LEAD), false, "the lead is imported from rankFilters.js, never duplicated as a literal");
  assert.match(source, /RANK_UNAVAILABLE_LEAD/);
});

test("QA: SIMILARITY_DISABLED_REASON is one string, used for the button and consistent with the banner four lines above it", () => {
  // James's post-gate ruling, 2026-09-05: the disabled similarity button said
  // "Needs a connected Steam account.", which is the same claim CR-7 removed
  // from the banner on the same screen in the same state – and the page
  // cannot know it (credentials PRESENT with zero contributing games produces
  // the identical payload shape). It now describes what the page HAS.
  assert.equal(SIMILARITY_DISABLED_REASON, "No Steam library is loaded.");
  assert.equal(/account/i.test(SIMILARITY_DISABLED_REASON), false, "the page cannot see whether an account is configured");
  assert.equal(/connect/i.test(SIMILARITY_DISABLED_REASON), false);

  // The button's reason and the banner's opening clause make the SAME claim
  // in each of the two no-library states – that consistency is the finding.
  const noCreds = { profileAvailable: false, profileGames: 0, notice: null };
  const steamDown = { profileAvailable: false, profileGames: 0, notice: "Steam library unavailable – …" };
  for (const payload of [noCreds, steamDown]) {
    const reason = similarityDisabledReason(payload);
    assert.equal(/account/i.test(reason), false, `the disabled-lens reason claims an account in ${libraryState(payload)}`);
    assert.equal(/library/i.test(reason), true);
    assert.equal(/library/i.test(libraryBanner(payload)), true);
  }
  assert.notEqual(similarityDisabledReason(noCreds), similarityDisabledReason(steamDown), "the two states still read differently");

  // Nothing under public/ can still RENDER the retired string. It survives in
  // one comment in rankFilters.js recording the ruling, which is the point of
  // a comment, so only non-comment lines are checked.
  for (const file of ["index.html", "rankFilters.js"]) {
    const source = readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8");
    const live = source
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    assert.equal(live.includes("Needs a connected Steam account"), false, `public/${file} still carries the retired reason`);
  }
});
