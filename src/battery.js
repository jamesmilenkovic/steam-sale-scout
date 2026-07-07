// Steam Sale Scout — battery-friendliness heuristic (Increment 5).
//
// Pure, dependency-free ESM so it can be imported both by src/worker.js and
// by `node --test`, mirroring src/deals.js's seam.
//
// SPEC NOTE: there is no official battery-per-game data source. This is a
// tag heuristic, not measured data — the UI must say so plainly (see
// SPEC.md §3). The community DeckSettings API is a real per-game data
// source but of unknown coverage; it's explicitly backlog, not this
// increment.
//
// ASSUMPTION (flagged, not confirmed by PO): the spec says the heuristic
// looks at "the game's top tags" without defining "top". This reuses the
// same idea as src/profile.js's per-game tag vector (top-N tags by raw
// SteamSpy vote count) rather than importing profile.js's stoplist/vector
// machinery — the LOW_POWER/HIGH_POWER lists below aren't stoplist tags
// (nothing generic like "Singleplayer" would ever collide with them), so a
// separate raw top-N-by-votes cut is simpler and doesn't risk a change to
// profile.js's stoplist silently changing battery results. BATTERY_TOP_TAGS
// = 10 chosen to comfortably cover a game's genre-defining tags without
// reaching so far down the tail that noise tags flip the verdict. Revisit at
// the Phase-2 gate if the badge looks wrong on spot-checked games.

/** Tags that suggest a game is easy on a handheld's battery (low CPU/GPU
 * demand genres) — exact list per SPEC.md §3. */
export const LOW_POWER = [
  "2D",
  "Pixel Graphics",
  "Turn-Based Strategy",
  "Turn-Based Tactics",
  "Card Game",
  "Card Battler",
  "Visual Novel",
  "Puzzle",
  "Point & Click",
  "Roguelike Deckbuilder",
  "Board Game",
];

/** Tags that suggest a game is battery-hungry — exact list per SPEC.md §3. */
export const HIGH_POWER = ["Open World", "Realistic", "Photorealistic", "Racing", "VR", "MMORPG"];

/** How many of a game's top-voted raw SteamSpy tags count as "top tags" for
 * this heuristic (see ASSUMPTION above). */
export const BATTERY_TOP_TAGS = 10;

/**
 * The names of a game's top `topN` tags by raw SteamSpy vote count (no
 * stoplist — see file header). Returns `[]` for missing/malformed tag data
 * rather than throwing.
 * @param {Object<string, number>|undefined|null} tags - SteamSpy `tags` (tagname -> votes).
 * @param {number} topN
 * @returns {string[]}
 */
export function topTagNames(tags, topN = BATTERY_TOP_TAGS) {
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) return [];
  return Object.entries(tags)
    .filter(([, votes]) => Number(votes) > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([name]) => name);
}

/**
 * True when a game's top tags hit the LOW_POWER list and miss the
 * HIGH_POWER list. A game with no tags at all (or none of its top tags
 * appear in LOW_POWER) is false by construction — there's no "hit" to
 * report, so no special-cased edge handling is needed.
 * @param {Object<string, number>|undefined|null} tags - SteamSpy `tags` (tagname -> votes).
 * @param {number} topN
 * @returns {boolean}
 */
export function batteryFriendly(tags, topN = BATTERY_TOP_TAGS) {
  const top = topTagNames(tags, topN);
  const hitsLow = top.some((tag) => LOW_POWER.includes(tag));
  const hitsHigh = top.some((tag) => HIGH_POWER.includes(tag));
  return hitsLow && !hitsHigh;
}
