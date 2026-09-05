// CR-2: THE ONE INVARIANT TWO FILES HAVE TO SHARE, pinned by a test that
// imports both of them.
//
// `derivePlayed` in src/marks.js decides played/finished/playedSource on the
// server, on every /api/rank response. `applyMark` in public/rankFilters.js
// re-decides the same three fields in the browser, immediately after a mark is
// written, so the card repaints without a reload. If those two ever disagree,
// the page shows one thing and the next reload shows another - and nothing
// caught it, because marks.test.mjs exercises one function, rankFilters.test.
// mjs the other, and no test crossed the seam. Add a precedence source not
// prefixed `steam-`, or rename the prefix, and this file fails.
//
// Pure functions, no D1, no network.

import test from "node:test";
import assert from "node:assert/strict";
import { derivePlayed } from "../src/marks.js";
import { applyMark } from "../public/rankFilters.js";

// Every shape a library row takes in the wild, including the 297's (no record
// anywhere) and the 45's (last-played only).
const LIBRARY_SHAPES = {
  "playtime_forever": { playtime_forever: 120 },
  "playtime_disconnected only": { playtime_forever: 0, playtime_disconnected: 30 },
  "rtime_last_played only (the 45)": { playtime_forever: 0, rtime_last_played: 1600000000 },
  "all zero (the 297)": { playtime_forever: 0, playtime_disconnected: 0, rtime_last_played: 0 },
  "no library row at all": undefined,
  "not owned / absent fields": {},
};

const MARKS = {
  "played": { played: 1, finished: 0 },
  "finished only": { played: 0, finished: 1 },
  "played + finished": { played: 1, finished: 1 },
  "explicit zeros": { played: 0, finished: 0 },
  // BOTH functions declare they accept 1|true, and only the numeric half was
  // exercised: deleting `mark?.finished === true` from applyMark passed the
  // entire suite. The page only ever hands these functions D1's 0/1 today, so
  // the boolean branch is defensive rather than live - but it is defensive in
  // TWO files, and this is the file whose job is that they never diverge.
  "played (boolean)": { played: true, finished: false },
  "finished (boolean)": { played: false, finished: true },
  "no mark": null,
};

/** The row as /api/rank builds it, for a given library row and mark. */
function rowFromServer(libraryGame, mark) {
  const state = derivePlayed(libraryGame, mark);
  return {
    appid: 400,
    title: "Portal",
    owned: true,
    played: state.played,
    finished: state.finished,
    playedSource: state.playedSource,
    lastPlayedAt: state.lastPlayedAt,
  };
}

const three = (o) => ({ played: o.played, finished: o.finished, playedSource: o.playedSource });

test("applyMark (browser) and derivePlayed (server) agree on every library shape x mark", () => {
  for (const [libName, libraryGame] of Object.entries(LIBRARY_SHAPES)) {
    for (const [markName, mark] of Object.entries(MARKS)) {
      // What the browser paints the instant the write returns: the row it was
      // already holding (no mark yet), with the new mark applied on top.
      const painted = applyMark(rowFromServer(libraryGame, null), mark);
      // What the very next reload returns for the same facts.
      const reloaded = derivePlayed(libraryGame, mark);
      assert.deepEqual(three(painted), three(reloaded), `${libName} + ${markName}`);
    }
  }
});

test("they still agree when a mark REPLACES an earlier mark, including clearing it", () => {
  for (const [libName, libraryGame] of Object.entries(LIBRARY_SHAPES)) {
    for (const [oldName, oldMark] of Object.entries(MARKS)) {
      for (const [newName, newMark] of Object.entries(MARKS)) {
        const painted = applyMark(rowFromServer(libraryGame, oldMark), newMark);
        const reloaded = derivePlayed(libraryGame, newMark);
        assert.deepEqual(three(painted), three(reloaded), `${libName}: ${oldName} -> ${newName}`);
      }
    }
  }
});

test("the seam itself: Steam's evidence outranks a mark in BOTH files, and 'you' is only ever the fallback", () => {
  // Stated as its own assertion rather than left implicit in the loops above,
  // because this is the rule the two files are agreeing ON.
  const measured = { playtime_forever: 120 };
  assert.equal(derivePlayed(measured, { played: 1, finished: 1 }).playedSource, "steam-playtime");
  assert.equal(applyMark(rowFromServer(measured, null), { played: 1, finished: 1 }).playedSource, "steam-playtime");

  assert.equal(derivePlayed({ playtime_forever: 0 }, { played: 1 }).playedSource, "you");
  assert.equal(applyMark(rowFromServer({ playtime_forever: 0 }, null), { played: 1 }).playedSource, "you");

  // And a mark can never turn a measured game unplayed, in either file.
  assert.equal(derivePlayed(measured, { played: 0, finished: 0 }).played, true);
  assert.equal(applyMark(rowFromServer(measured, null), { played: 0, finished: 0 }).played, true);
});
