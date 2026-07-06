# Increment 2 — Steam deep-sale feed (AUD)

**Project:** Steam Sale Scout · **Phase 1, slice 2 of 3**
**PRD:** `PRDs/2-in-progress/2026-07-04-steam-sale-recommender.md`
**Status:** Build-ready (scoped 2026-07-04, after inc-1 acceptance)

## Goal

A working "all current Steam discounts ≥ X%, in AUD" view with owned games
excluded and historical-low flags. Standalone-useful as a sale browser, and it
becomes the candidate pool the increment-3 engine scores.

## Decision carried in from James (2026-07-04): local-only

**No deploy.** The app runs via `wrangler dev` on `localhost` — the Worker is
purely a CORS/keys proxy, not hosting. Remove/skip any deploy steps; acceptance
happens on the local URL. Deploying is a Phase 3 question (other devices,
scheduled digest), not before.

## Prerequisite (James, ~5 min)

Register a free ITAD app at **isthereanydeal.com/apps/my/** → API key →
`ITAD_API_KEY` in `.dev.vars`. Optional courtesy email to ITAD re private
personal use (their ToS asks private apps to get in touch; local single-user
usage is the definition of low-impact, but the email is polite insurance).

## Build

### 1. Worker route `GET /api/deals?minCut=60`

- ITAD **`GET /deals/v2`** with `country=AU`, `shops=61` (Steam), `sort=-cut`,
  `limit=200`, paginate `offset` until exhausted (cap ~1,000 deals), server-side
  filter `minCut` (default 60; accept 40–90).
- Per deal, extract: title, ITAD game id, **Steam appid** (parse from the deal's
  Steam store URL — deals on shop 61 carry it), price (AUD), regular price,
  `cut` %, deal flags/expiry if present.
- **Historical low:** batch the filtered set through **`POST /games/historylow/v1`**
  (`country=AU`, ≤200 ids/call). Flag `atHistoricalLow` (deal price ≤ recorded
  low + a few cents tolerance) and include the low for display.
- **Exclude owned:** reuse the cached library (inc 1) by appid before returning.
- **Cache 6h** (deals) / 7 days (history lows), `?refresh=1` bypass. Respect
  ITAD's 1,000 req/5min limit trivially via the cache.
- Clear errors: missing `ITAD_API_KEY`, upstream 429 (surface Retry-After).

### 2. UI — "Deals" section alongside the inc-1 library view

- Simple two-tab nav: **Library** (inc 1) · **Deals** (new).
- Controls: **minimum discount** (default 60%, range 40–90, persisted to
  localStorage like the recency setting) · sort by **% off / price / title**.
- Table: name, AUD price, regular price (struck through), % off badge,
  **HISTORICAL LOW** badge where flagged, link out to the Steam store page
  (`store.steampowered.com/app/<appid>`).
- Totals: deal count at current threshold, count at historical lows.
- Still diagnostic-grade styling; the product UI comes after the Phase 1 gate.

## Out of scope (this increment)

Recommendations/similarity (inc 3), SteamSpy, wishlist, genre/price/similarity
filters (Phase 2 — minCut is the only control now), any deploy.

## Testing

- Unit: appid parsing from deal URLs, minCut filtering, owned-exclusion,
  historical-low flagging (incl. tolerance), pagination assembly — all against
  mocked ITAD fixtures shaped from the real v2 responses.
- Worker route test: mocked ITAD upstream, cache behaviour, 429 handling.
- Manual acceptance (James): localhost → Deals tab at 60% shows a plausible
  sale list in AUD, owned games absent, spot-check 2–3 prices against the
  Steam store, historical-low badges sane.
