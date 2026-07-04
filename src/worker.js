// Steam Sale Scout — Cloudflare Worker.
// Implements /api/library: GetOwnedGames proxy, trimmed response, 24h cache,
// ?refresh=1 bypass, clear errors. Non-asset requests reach here; static
// files are served from ./public.

const STEAM_API_URL =
  "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/";
const CACHE_TTL_SECONDS = 24 * 60 * 60;

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function trimGame(game) {
  return {
    appid: game.appid,
    name: game.name,
    img_icon_url: game.img_icon_url,
    playtime_forever: game.playtime_forever,
    playtime_2weeks: game.playtime_2weeks,
    rtime_last_played: game.rtime_last_played,
  };
}

async function handleLibrary(request, env, ctx) {
  if (!env.STEAM_API_KEY || !env.STEAM_ID) {
    return jsonError(
      "Missing STEAM_API_KEY or STEAM_ID — set them as Worker secrets (see .dev.vars locally).",
      500,
    );
  }

  const url = new URL(request.url);
  const refresh = url.searchParams.get("refresh") === "1";

  // Cache key is stable per steamid, independent of the ?refresh= param, so
  // a refresh both bypasses and repopulates the same cache entry.
  const cache = caches.default;
  const cacheKey = new Request(
    `https://steam-sale-scout.cache/api/library?steamid=${env.STEAM_ID}`,
  );

  if (!refresh) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  const upstreamUrl = new URL(STEAM_API_URL);
  upstreamUrl.searchParams.set("key", env.STEAM_API_KEY);
  upstreamUrl.searchParams.set("steamid", env.STEAM_ID);
  upstreamUrl.searchParams.set("include_appinfo", "1");
  upstreamUrl.searchParams.set("include_played_free_games", "1");

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamUrl.toString());
  } catch (err) {
    return jsonError(`Failed to reach Steam API: ${err.message}`, 502);
  }

  if (!upstreamResponse.ok) {
    return jsonError(
      `Steam API returned ${upstreamResponse.status}`,
      502,
    );
  }

  let upstreamBody;
  try {
    upstreamBody = await upstreamResponse.json();
  } catch (err) {
    return jsonError("Steam API returned an unparsable response.", 502);
  }

  const games = upstreamBody?.response?.games;
  if (!games || games.length === 0) {
    return jsonError(
      "No games returned — profile or game-details privacy may be blocking playtime. Set them to Public in Steam privacy settings.",
      502,
    );
  }

  const trimmed = games.map(trimGame);
  const responseBody = JSON.stringify({ games: trimmed });
  const response = new Response(responseBody, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${CACHE_TTL_SECONDS}`,
    },
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));

  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/library") {
      return handleLibrary(request, env, ctx);
    }
    if (url.pathname.startsWith("/api/")) {
      return jsonError("not implemented", 501);
    }
    // Fall back to the static asset handler for everything else.
    return env.ASSETS.fetch(request);
  },
};
