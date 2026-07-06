// Steam Sale Scout — the "why" explanation line (Increment 3).
//
// Pure, dependency-free ESM so it can be imported both by src/worker.js and
// by `node --test`.

/** How many overlapping tags to name in a why-line. */
export const WHY_TOP_TAGS = 3;

/** How many owned games to credit in a why-line. */
export const WHY_TOP_GAMES = 2;

/**
 * The top overlapping tags between the profile and a candidate, ranked by
 * their approximate contribution to the cosine similarity (profile-weight x
 * candidate-share, for tags present in both).
 * @param {Object<string, number>} profile - L2-normalised taste profile.
 * @param {Object<string, number>} candidateTagVector
 * @param {number} topN
 * @returns {string[]} tag names, highest-contribution first.
 */
export function selectTopTags(profile, candidateTagVector, topN = WHY_TOP_TAGS) {
  return Object.keys(candidateTagVector)
    .filter((tag) => (profile[tag] || 0) > 0)
    .map((tag) => ({ tag, contribution: profile[tag] * candidateTagVector[tag] }))
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, topN)
    .map((entry) => entry.tag);
}

/**
 * The owned games that contributed the most weight to the given tags,
 * summed across all of them.
 * @param {Array<{appid: number, name: string, hours: number, tagWeights: Object<string, number>}>} contributions
 *   as returned by profile.js's buildProfile.
 * @param {string[]} topTags
 * @param {number} topN
 * @returns {Array<{appid: number, name: string, hours: number}>}
 */
export function selectTopGames(contributions, topTags, topN = WHY_TOP_GAMES) {
  return contributions
    .map((game) => {
      const gameScore = topTags.reduce((sum, tag) => sum + (game.tagWeights[tag] || 0), 0);
      return { game, gameScore };
    })
    .filter((entry) => entry.gameScore > 0)
    .sort((a, b) => b.gameScore - a.gameScore)
    .slice(0, topN)
    .map((entry) => entry.game);
}

/**
 * Format the why-line, e.g.
 * "Roguelike Deckbuilder, Turn-Based, Strategy — because Slay the Spire
 * (180h) and Balatro (42h)". Returns null if there's nothing to say (no
 * overlapping tags, or no owned game contributed to them).
 * @param {string[]} topTags
 * @param {Array<{name: string, hours: number}>} topGames
 * @returns {string|null}
 */
export function formatWhyLine(topTags, topGames) {
  if (topTags.length === 0 || topGames.length === 0) return null;
  const tagsPart = topTags.join(", ");
  const gamesPart = topGames.map((g) => `${g.name} (${Math.round(g.hours)}h)`).join(" and ");
  return `${tagsPart} — because ${gamesPart}`;
}

/**
 * Build the full why-line for one candidate.
 * @param {Object<string, number>} profile
 * @param {Object<string, number>} candidateTagVector
 * @param {Array<object>} contributions - from profile.js's buildProfile.
 * @param {{topTagsN?: number, topGamesN?: number}} [options]
 * @returns {string|null}
 */
export function buildWhy(
  profile,
  candidateTagVector,
  contributions,
  { topTagsN = WHY_TOP_TAGS, topGamesN = WHY_TOP_GAMES } = {},
) {
  const topTags = selectTopTags(profile, candidateTagVector, topTagsN);
  const topGames = selectTopGames(contributions, topTags, topGamesN);
  return formatWhyLine(topTags, topGames);
}
