// Steam Sale Scout — taste-profile builder (Increment 3).
//
// Pure, dependency-free ESM (aside from weight.js) so it can be imported both
// by src/worker.js and by `node --test`, mirroring the src/deals.js seam.
//
// This replaces the log-hours term flagged in public/weight.js as the
// per-game "how much did James like this" signal with median-playtime
// normalisation, while still reusing weight.js's `weight()` to pick which
// 200 owned games are even worth considering, and `recencyMultiplier()` for
// the recency half of the new per-game weight.
//
// ASSUMPTION (flagged, not confirmed by PO): per-game tag vectors are built
// by removing the stoplist FIRST, then taking the top 15 tags by votes from
// what's left, then normalising those to sum to 1. The spec's wording ("top
// 15 tags by votes ... minus the stoplist") could also be read as "take the
// top 15, then strip any stoplist entries from within that set" (leaving
// fewer than 15, un-renormalised). Stoplist-first was chosen because it
// avoids wasting a top-15 slot on a generic/troll tag (e.g. "Singleplayer")
// that would otherwise just get thrown away, and keeps every game's vector
// summing to 1 regardless of how many stoplist tags it had. Tune/revisit at
// the Phase-1 gate if the why-lines look off.

import { weight, recencyMultiplier } from "../public/weight.js";

/** Tags suppressed from every per-game vector — generic/troll tags that
 * dominate vote counts without saying anything about taste (SteamPeek-style
 * suppression). Configurable; tune at the Phase-1 gate. */
export const STOPLIST = [
  "Singleplayer",
  "Multiplayer",
  "Great Soundtrack",
  "Early Access",
  "Free to Play",
  "Controller",
  "Steam Achievements",
  "Atmospheric",
];

/** How many of a game's top-voted tags (after stoplist removal) contribute
 * to its tag vector. */
export const TOP_TAGS_PER_GAME = 15;

/** How many owned games (ranked by inc-1 `weight()`) are considered at all —
 * the tail is noise. */
export const TOP_OWNED_GAMES = 200;

/** Owned games played less than this many minutes are skipped entirely —
 * not enough signal to trust. */
export const MIN_PLAYTIME_MINUTES = 30;

/** playtimeNorm clamp bounds — keeps one mega-played game from swamping the
 * profile, and one just-started game from contributing near-zero. */
export const PLAYTIME_NORM_MIN = 0.1;
export const PLAYTIME_NORM_MAX = 4;

/**
 * Rank owned games by increment 1's `weight()` (log-hours x recency) and
 * keep the top `topN`. This is deliberately the OLD weight, used only to
 * decide which games are worth profiling — the profile's own per-game
 * weight (`gameWeight` below) uses median-normalised playtime instead.
 * @param {Array<object>} games - trimmed library games (as from /api/library).
 * @param {number} windowMonths
 * @param {number} now - reference time in ms.
 * @param {number} topN
 * @returns {Array<object>}
 */
export function selectTopOwnedGames(games, windowMonths, now = Date.now(), topN = TOP_OWNED_GAMES) {
  return [...(games || [])]
    .map((game) => ({ game, w: weight(game, windowMonths, now) }))
    .sort((a, b) => b.w - a.w)
    .slice(0, topN)
    .map((entry) => entry.game);
}

/**
 * Playtime-based half of a game's profile weight.
 * `clamp(playtime_forever / median, 0.1, 4)` when a usable SteamSpy median
 * is available; falls back to increment 1's unclamped `log2(1+hours)` term
 * when the median is missing or 0 (SteamSpy doesn't have one for every app).
 * @param {{playtime_forever?: number}} game
 * @param {number|null|undefined} median - SteamSpy `median_forever`, minutes.
 * @returns {number}
 */
export function playtimeNorm(game, median) {
  const playtimeForever = game.playtime_forever || 0;
  if (median && median > 0) {
    const ratio = playtimeForever / median;
    return Math.min(PLAYTIME_NORM_MAX, Math.max(PLAYTIME_NORM_MIN, ratio));
  }
  const hours = playtimeForever / 60;
  return Math.log2(1 + hours);
}

/**
 * A game's full profile-building weight: playtimeNorm x recencyMultiplier.
 * @param {object} game
 * @param {number|null|undefined} median
 * @param {number} windowMonths
 * @param {number} now
 * @returns {number}
 */
export function gameWeight(game, median, windowMonths, now = Date.now()) {
  return playtimeNorm(game, median) * recencyMultiplier(game, windowMonths, now);
}

/**
 * Build one game's (or candidate's) tag vector: strip the stoplist, keep the
 * top `topN` remaining tags by vote count, normalise those votes to sum to 1.
 * @param {Object<string, number>|undefined|null} tags - SteamSpy `tags` (tagname -> votes).
 * @param {string[]} stoplist
 * @param {number} topN
 * @returns {Object<string, number>} sparse tag -> share-of-1 map (possibly empty).
 */
export function buildTagVector(tags, stoplist = STOPLIST, topN = TOP_TAGS_PER_GAME) {
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) return {};

  const stopSet = new Set(stoplist);
  const entries = Object.entries(tags)
    .filter(([name, votes]) => !stopSet.has(name) && Number(votes) > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);

  const total = entries.reduce((sum, [, votes]) => sum + votes, 0);
  if (total <= 0) return {};

  const vector = {};
  for (const [name, votes] of entries) vector[name] = votes / total;
  return vector;
}

/**
 * L2-normalise a sparse vector (tag -> weight). Returns `{}` for a zero
 * vector rather than dividing by zero.
 * @param {Object<string, number>} vector
 * @returns {Object<string, number>}
 */
export function l2Normalize(vector) {
  const magnitude = Math.sqrt(Object.values(vector).reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return {};
  const out = {};
  for (const [tag, v] of Object.entries(vector)) out[tag] = v / magnitude;
  return out;
}

/**
 * Document frequency -> IDF (Increment 4). Given the working corpus of tag
 * sets — one per document (game), each either an array of tag names or a
 * SteamSpy-style tag object (tagname -> votes, in which case only the keys
 * matter) — compute `idf(tag) = ln(N / df(tag))`, where N is the number of
 * documents and df(tag) is how many of them contain it at least once.
 *
 * A tag in every document (df === N) gets idf 0 (ln(1) === 0) — maximally
 * generic, contributes nothing. A tag in only one document out of many gets
 * the highest idf. With a single-document corpus (N === 1), every tag it
 * has gets idf 0 too (ln(1/1) === 0) — there's no basis yet to call
 * anything distinctive.
 * @param {Array<string[]|Object<string, number>>} tagSets
 * @returns {Object<string, number>} tag -> idf weight.
 */
export function computeIdf(tagSets) {
  const docs = (tagSets || []).map((doc) => {
    if (!doc) return [];
    return Array.isArray(doc) ? doc : Object.keys(doc);
  });

  const n = docs.length;
  const idf = {};
  if (n === 0) return idf;

  const df = new Map();
  for (const doc of docs) {
    for (const tag of new Set(doc)) {
      df.set(tag, (df.get(tag) || 0) + 1);
    }
  }

  for (const [tag, count] of df) idf[tag] = Math.log(n / count);
  return idf;
}

/**
 * Apply IDF weights to a tag vector, multiplying each tag's value by its
 * idf (0 for a tag absent from `idfMap` — i.e. absent from the corpus this
 * idfMap was computed over) and L2-normalising the result. Used on both the
 * profile vector and each candidate's tag vector before cosine similarity,
 * so a generic tag (idf ~= 0) stops contributing to similarity on either
 * side, while a distinctive tag (high idf) dominates it.
 * @param {Object<string, number>} vector
 * @param {Object<string, number>} idfMap
 * @returns {Object<string, number>}
 */
export function applyIdf(vector, idfMap) {
  const weighted = {};
  for (const [tag, value] of Object.entries(vector)) {
    weighted[tag] = value * (idfMap[tag] ?? 0);
  }
  return l2Normalize(weighted);
}

/**
 * Build the taste profile from an owned-games library and whatever SteamSpy
 * tag data is currently cached (partial cache is fine — a game with no
 * cached/usable tag data simply doesn't contribute, same as a game that
 * SteamSpy has no tags for at all).
 *
 * @param {Array<object>} ownedGames - trimmed library games (as from /api/library).
 * @param {Map<number, {tags: Object<string,number>, median: number, reviews: object}|null|undefined>} spyDataByAppid
 *   appid -> SteamSpy trio, or `null` (fetched, no usable tags) or `undefined` (not fetched yet).
 * @param {number} windowMonths
 * @param {number} now - reference time in ms.
 * @param {Object<string, number>|null} [idfMap] - tag -> idf weight (Increment 4, see computeIdf).
 *   Applied to the summed profile vector before normalisation instead of
 *   per-game (equivalent, since idf is a per-tag constant and summation is
 *   linear). Omit to build the profile unweighted (pre-inc-4 behaviour).
 * @returns {{profile: Object<string, number>, contributions: Array<{appid: number, name: string, hours: number, tagWeights: Object<string, number>}>}}
 */
export function buildProfile(ownedGames, spyDataByAppid, windowMonths = 12, now = Date.now(), idfMap = null) {
  const topGames = selectTopOwnedGames(ownedGames, windowMonths, now, TOP_OWNED_GAMES);
  const summed = {};
  const contributions = [];

  for (const game of topGames) {
    if ((game.playtime_forever || 0) < MIN_PLAYTIME_MINUTES) continue;

    const spy = spyDataByAppid.get(game.appid);
    if (!spy || !spy.tags) continue; // not fetched yet, or fetched with no usable tags

    const tagVector = buildTagVector(spy.tags);
    if (Object.keys(tagVector).length === 0) continue;

    const w = gameWeight(game, spy.median, windowMonths, now);
    const tagWeights = {};
    for (const [tag, share] of Object.entries(tagVector)) {
      const contribution = w * share;
      summed[tag] = (summed[tag] || 0) + contribution;
      tagWeights[tag] = contribution;
    }

    contributions.push({
      appid: game.appid,
      name: game.name,
      hours: (game.playtime_forever || 0) / 60,
      tagWeights,
    });
  }

  const profile = idfMap ? applyIdf(summed, idfMap) : l2Normalize(summed);
  return { profile, contributions };
}
