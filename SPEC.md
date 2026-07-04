# Increment 1 — Library in, ranked by "what I actually play"

**Project:** Steam Sale Scout · **Phase 1, slice 1 of 3**
**PRD:** `PRDs/2-in-progress/2026-07-04-steam-sale-recommender.md`
**Status:** Build-ready (scoped 2026-07-04)

## Goal

Prove the plumbing and the weighting inputs end-to-end: Worker proxy + Steam
Web API + a frontend that shows James's library ranked by a first-pass
taste weight (hours × recency). **Success = James looks at his top-20 and says
"yes, that's my taste, in order."**

No deals, no recommendations, no SteamSpy yet. Just library → weight → ranked list.

## Stack (fixed for the project)

1. **Cloudflare Worker** serving both the API proxy routes and the static
   frontend (Workers static assets). One `wrangler deploy`, free tier,
   workers.dev URL. Local dev via `wrangler dev`.
2. **Frontend: vanilla HTML/JS/CSS, single page** (house style — same as
   metronome/drum-trainer). No framework unless the loop argues for one later.
3. **Secrets:** `STEAM_API_KEY` and `STEAM_ID` (SteamID64) as Worker secrets;
   locally in `.dev.vars` (gitignored). **Never in the repo, never in client JS.**

## Build

### 1. Worker route `GET /api/library`

- Calls `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/` with
  `key`, `steamid`, `include_appinfo=1`, `include_played_free_games=1`.
- Returns trimmed JSON per game: `appid`, `name`, `img_icon_url`,
  `playtime_forever` (min), `playtime_2weeks` (min, may be absent),
  `rtime_last_played` (unix; present because own key + own account).
- **Cache the upstream response 24h** (Worker Cache API or KV). Add
  `?refresh=1` to bypass.
- Errors surfaced clearly: missing secrets, private-profile/empty response
  (privacy hint in the message), upstream non-200.

### 2. Weight function (shared module, unit-tested)

`weight = log2(1 + hours) × recencyMultiplier`

- `hours = playtime_forever / 60`.
- `recencyMultiplier`, given `windowMonths` (setting, default 12) and months
  since `rtime_last_played`:
  - played in last 2 weeks (`playtime_2weeks` > 0): **×3**
  - within `windowMonths/4`: **×2**
  - within `windowMonths`: **×1.5**
  - within `2 × windowMonths`: **×1**
  - older / never (`rtime_last_played` 0 or missing): **×0.5**
- Pure function in its own module (`weight.js`) — increment 3 replaces log-hours
  with median-playtime normalisation, so keep the seam clean.

### 3. UI

- Single page: header, **recency-window setting** (months; default 12,
  persisted to localStorage), ranked table.
- Table: rank, icon, name, hours (1 dp), last played ("3 months ago" style),
  weight bar. Sorted by weight desc. Toggle to sort by raw hours for
  comparison ("did the recency weighting actually change the order?").
- Show totals: game count, games never played.
- No styling ambitions beyond readable — this page is diagnostic, not the product.

## Out of scope (this increment)

Deals/ITAD, SteamSpy tags, wishlist, filters, similarity, any recommendation.
Also: no accounts, SteamID stays a secret-config value.

## Testing

- Unit tests (node `--test`): weight function across all recency bands, edge
  cases (0 minutes, missing `rtime_last_played`, `playtime_2weeks` present),
  window-setting variations (e.g. 3-month window reshuffles vs 12).
- Worker route test with a mocked upstream response (trimming + cache headers).
- Manual acceptance (James): `wrangler dev` with real key → top-20 sanity check;
  then `wrangler deploy` → same on the workers.dev URL.
