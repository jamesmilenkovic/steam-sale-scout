// Steam Sale Scout – per-game "I played this / I finished this" marks
// (Increment 12.5).
//
// WHY THIS TABLE EXISTS AT ALL. Measured against the live Steam API on
// 2026-09-05: of 659 owned games, 342 report zero playtime. 45 of those are
// OUR bug – Steam sends `rtime_last_played` on every library fetch and
// nothing read it. The other **297 have no record anywhere**: zero on
// `playtime_forever`, every per-platform field, `playtime_disconnected` and
// `rtime_last_played`. Steam began recording playtime in March 2009 and
// Portal shipped in 2007. That data was never captured, no API call conjures
// it, and marking a game yourself is the ONLY mechanism that can know the
// truth about it. Portal sitting at pick #6 with "never played" on it is what
// triggered this increment.
//
// WHY IT IS NOT AN EXTENSION OF `dismissals`, which it otherwise mirrors
// line for line. Three structural differences, not cosmetic ones:
//
//   1. THEY MEAN OPPOSITE THINGS. A dismissal is "not interested" – a verdict
//      about a game you have NOT played. A mark is "I have played this".
//   2. THEY HAVE OPPOSITE LIFECYCLES. Un-dismissing DELETEs the row, by
//      design (src/dismissals.js: "data IS allowed to go away here"). A mark
//      is a durable record of personal history and is **the only data in this
//      project that cannot be re-fetched from anywhere** – the catalogue,
//      prices, tags, the LLM scores and the library can all be rebuilt from an
//      API or a fill. A shared table makes an undo-dismiss delete a play
//      history. (This is also why `game_marks` joins TABLES in
//      tools/backup-catalog.mjs.)
//   3. THEY ACT AT DIFFERENT LAYERS. Dismissals filter /api/rank's pool
//      server-side, so a dismissal frees a slot. **Marks must never touch the
//      pool** (SPEC.md §2, §7.3) – they ride on the row as data and only the
//      browser acts on them. One table with two opposite server-side
//      behaviours invites exactly the leak gate 5 exists to catch.
//
// WHAT IS DELIBERATELY NOT HERE: a `rating` column (a personal score is a
// later increment – deciding what a personal 78 means beside an
// experience_score of 98 IS a ranking change, and ranking is frozen), a
// `user_id` column (untested scaffolding on a single-user app), and any
// third state (abandoned/playing/shelved – named in the prior-art survey,
// costs one nullable column when it is wanted).
//
// Same D1 database as everything else (env.FPM_DB), per the project's single
// persistence story. Fail-soft posture identical to src/dismissals.js.

// INCREMENT 15, SPEC.md §10 – `steam_id` leads a composite primary key.
//
// NOTE WHAT THE HEADER ABOVE SAYS THIS TABLE IS: the only data in this project
// that cannot be re-fetched from anywhere. That is exactly why it must not be
// shared. Before this increment one un-keyed row meant one play history for
// whoever asked; a second signed-in identity would have read and overwritten
// James's. `steam_id` is TEXT because a SteamID64 does not survive as a
// JavaScript number – see src/settings.js's header.
//
// The `user_id` column this file's own "deliberately not here" list rejected as
// "untested scaffolding on a single-user app" is now this column, and the
// reason it is no longer scaffolding is that the app stopped being
// single-user the moment the allow-list existed.
const CREATE_MARKS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS game_marks (
  steam_id TEXT NOT NULL, appid INTEGER NOT NULL, name TEXT,
  played INTEGER NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0,
  marked_at INTEGER, updated_at INTEGER,
  PRIMARY KEY (steam_id, appid)
)`;

/** Create the game_marks table if it doesn't exist yet. Safe to call on every
 * request (idempotent, cheap), same convention as ensureDismissalsSchema/
 * ensureSettingsSchema. */
export async function ensureMarksSchema(env) {
  await env.FPM_DB.prepare(CREATE_MARKS_TABLE_SQL).run();
}

/** ONE user's marks, most-recently-updated first – backs GET /api/marks.
 *
 * `steamId` comes from the session and never from `env` (SPEC.md §7.3).
 * @param {object} env - needs env.FPM_DB.
 * @param {string} steamId - the signed-in user's SteamID64, AS A STRING.
 * @returns {Promise<Array<{appid: number, name: string|null, played: number, finished: number, updated_at: number|null}>>}
 */
export async function listMarks(env, steamId) {
  const result = await env.FPM_DB.prepare(
    "SELECT appid, name, played, finished, updated_at FROM game_marks WHERE steam_id = ? ORDER BY updated_at DESC",
  )
    .bind(steamId)
    .all();
  return result.results || [];
}

/** ONE user's marks keyed by appid, as a Map – the shape /api/rank's row build
 * needs to join a mark onto each row in one pass.
 * @param {object} env - needs env.FPM_DB.
 * @param {string} steamId - the signed-in user's SteamID64, AS A STRING.
 * @returns {Promise<Map<number, {appid: number, played: number, finished: number}>>}
 */
export async function getMarksByAppid(env, steamId) {
  const result = await env.FPM_DB.prepare(
    "SELECT appid, played, finished FROM game_marks WHERE steam_id = ?",
  )
    .bind(steamId)
    .all();
  return new Map((result.results || []).map((row) => [row.appid, row]));
}

// The CONFLICT TARGET names BOTH key columns. `ON CONFLICT(appid)` against the
// composite key would mean "one play history per game across all users" –
// i.e. one identity's mark silently overwriting another's, on the one table
// that cannot be rebuilt from any API.
const UPSERT_MARK_SQL = `INSERT INTO game_marks (steam_id, appid, name, played, finished, marked_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(steam_id, appid) DO UPDATE SET
  name = excluded.name,
  played = excluded.played,
  finished = excluded.finished,
  updated_at = excluded.updated_at`;

/**
 * THE ONE INVARIANT: `finished = 1` implies `played = 1`. You cannot finish a
 * game you never played. Normalised HERE, on write, rather than trusted from
 * the client, so the impossible row cannot exist in the table no matter what
 * posts to it. Pure, so the invariant is testable without a database.
 * @param {{played?: unknown, finished?: unknown}} input
 * @returns {{played: 0|1, finished: 0|1}}
 */
export function normaliseMark(input) {
  const finished = input?.finished ? 1 : 0;
  const played = finished === 1 || input?.played ? 1 : 0;
  return { played, finished };
}

/**
 * Write one mark. A FULL-STATE UPSERT, NOT A TOGGLE – idempotent, so a
 * double-click, a retry or two tabs cannot flip the state to the opposite of
 * what the user pressed. `marked_at` is only set the first time (ON CONFLICT
 * leaves it alone); `updated_at` moves on every write.
 */
export async function setMark(env, steamId, appid, name, state, nowMs = Date.now()) {
  const { played, finished } = normaliseMark(state);
  await env.FPM_DB.prepare(UPSERT_MARK_SQL)
    .bind(steamId, appid, name ?? null, played, finished, nowMs, nowMs)
    .run();
  return { played, finished };
}

/** Clear one appid's mark. A no-op (not an error) if it wasn't marked. This
 * is the third state of the two toggles: it removes the assertion, it does
 * NOT assert "never played" (see derivePlayed's header). */
export async function removeMark(env, steamId, appid) {
  await env.FPM_DB.prepare("DELETE FROM game_marks WHERE steam_id = ? AND appid = ?")
    .bind(steamId, appid)
    .run();
}

// ---------------------------------------------------------------------------
// The pure part – who wins, Steam or the user.
// ---------------------------------------------------------------------------

/**
 * THE RULE, IN ONE SENTENCE: the user can add a fact Steam does not have, and
 * never contradicts one Steam does have.
 *
 * `played` is true if ANY of four things is true, and the order they are
 * checked in is also the order that decides `playedSource`, so the page can
 * always say WHERE the answer came from and never dress a user mark up as a
 * measurement:
 *
 *   1. playtime_forever > 0        -> "steam-playtime"
 *   2. playtime_disconnected > 0   -> "steam-disconnected"
 *   3. rtime_last_played > 0       -> "steam-last-played"
 *   4. the mark                    -> "you"
 *
 * `finished` comes from the mark and from NOTHING else. Steam cannot know it
 * and never will.
 *
 * THERE IS NO "MARK AS NOT PLAYED" that overrides a positive Steam playtime,
 * and that is a refusal rather than an omission. We cannot tell a deliberate
 * denial from a mis-click, the case it would serve (a family member played it,
 * it was left running) is far rarer than the 297, and a user-asserted negative
 * over a measured positive is the one direction in which this feature could
 * make the data WORSE.
 *
 * ON `playtime_disconnected`, MEASURED SO NOBODY HAS TO GUESS LATER: all 42
 * rows carrying it are already inside the 45 that `rtime_last_played` recovers,
 * so **it recovers zero additional games today**. It is kept because it is a
 * genuinely independent signal that costs one field on a request we already
 * make and Steam gives no guarantee the two always travel together – not
 * because it earned its place by finding anything. It is a played SIGNAL only
 * and is never added into `hoursPlayed`: we do not know whether Steam's
 * disconnected figure sits inside `playtime_forever` or beside it, and adding
 * an unverified number to a figure the page renders as "17 hours played" is
 * the class of quiet lie increment 12's review caught four times.
 *
 * Pure – no D1, no network, no clock. Both arguments may be null/undefined:
 * a game with no library row and no mark simply has no play record, which is
 * exactly the 297's situation and is NOT the same as "never played".
 *
 * @param {{playtime_forever?: number, playtime_disconnected?: number, rtime_last_played?: number}|null|undefined} libraryGame
 * @param {{played?: number, finished?: number}|null|undefined} mark
 * @returns {{played: boolean, finished: boolean, playedSource: string|null, lastPlayedAt: number|null}}
 */
export function derivePlayed(libraryGame, mark) {
  const finished = mark?.finished === 1 || mark?.finished === true;
  const markedPlayed = finished || mark?.played === 1 || mark?.played === true;
  const lastPlayed = Number(libraryGame?.rtime_last_played) || 0;

  let playedSource = null;
  if (Number(libraryGame?.playtime_forever) > 0) playedSource = "steam-playtime";
  else if (Number(libraryGame?.playtime_disconnected) > 0) playedSource = "steam-disconnected";
  else if (lastPlayed > 0) playedSource = "steam-last-played";
  else if (markedPlayed) playedSource = "you";

  return {
    played: playedSource !== null,
    finished,
    playedSource,
    lastPlayedAt: lastPlayed > 0 ? lastPlayed : null,
  };
}
