// Steam Sale Scout — taste-weight module (Increment 1).
//
// Pure, dependency-free ESM so it can be imported both by the browser
// (public/index.html) and by `node --test`. Increment 3 will swap the
// log-hours term for median-playtime normalisation — keep this seam clean.
//
// weight = log2(1 + hours) * recencyMultiplier
// hours  = playtime_forever / 60

const MS_PER_MONTH = (365.25 / 12) * 24 * 60 * 60 * 1000;

/**
 * Months elapsed between a unix timestamp (seconds) and `now`.
 * @param {number} rtimeLastPlayed - unix seconds, 0/missing means "never".
 * @param {number} now - reference time in milliseconds (default: Date.now()).
 * @returns {number} months elapsed, or Infinity if never played.
 */
export function monthsSince(rtimeLastPlayed, now = Date.now()) {
  if (!rtimeLastPlayed) return Infinity;
  const elapsedMs = now - rtimeLastPlayed * 1000;
  return elapsedMs / MS_PER_MONTH;
}

/**
 * Recency multiplier for a game, banded by months since last played.
 * @param {{playtime_2weeks?: number, rtime_last_played?: number}} game
 * @param {number} windowMonths - setting, default 12.
 * @param {number} now - reference time in milliseconds (default: Date.now()).
 * @returns {number} multiplier.
 */
export function recencyMultiplier(game, windowMonths = 12, now = Date.now()) {
  if (game.playtime_2weeks > 0) return 3;

  const months = monthsSince(game.rtime_last_played, now);
  if (months <= windowMonths / 4) return 2;
  if (months <= windowMonths) return 1.5;
  if (months <= 2 * windowMonths) return 1;
  return 0.5;
}

/**
 * Taste weight for a game.
 * @param {{playtime_forever: number, playtime_2weeks?: number, rtime_last_played?: number}} game
 * @param {number} windowMonths - setting, default 12.
 * @param {number} now - reference time in milliseconds (default: Date.now()).
 * @returns {number} weight.
 */
export function weight(game, windowMonths = 12, now = Date.now()) {
  const hours = (game.playtime_forever || 0) / 60;
  return Math.log2(1 + hours) * recencyMultiplier(game, windowMonths, now);
}
