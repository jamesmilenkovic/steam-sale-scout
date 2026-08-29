// Steam Sale Scout – SteamSpy `appdetails` fixtures, Increment 9.
//
// CAPTURED LIVE on 2026-08-28 from https://steamspy.com/api.php?request=appdetails
// (see scratchpad/probe-findings-9.md for the full probe write-up). These are
// VERBATIM response bodies, not hand-written approximations – the inc-6 lesson
// is that a green test against a wrong-shaped mock proves nothing.
//
// The one fact these fixtures exist to pin down: SteamSpy’s `tags` field has
// TWO live shapes. A populated app returns a name→votes OBJECT; an app it has
// nothing for returns an empty ARRAY (`[]`), never `{}`. Both arrive as HTTP
// 200 with a JSON content-type, so shape is the only signal.

/** Live capture – Terraria. */
export const SPY_TERRARIA = {
    "appid": 105600,
    "name": "Terraria",
    "developer": "Re-Logic",
    "publisher": "Re-Logic",
    "score_rank": "",
    "positive": 1373979,
    "negative": 35494,
    "userscore": 0,
    "owners": "20,000,000 .. 50,000,000",
    "average_forever": 0,
    "average_2weeks": 0,
    "median_forever": 0,
    "median_2weeks": 0,
    "price": "999",
    "initialprice": "999",
    "discount": "0",
    "ccu": 24580,
    "languages": "English, French, Italian, German, Spanish - Spain, Polish, Portuguese - Brazil, Russian, Simplified Chinese",
    "genre": "Action, Adventure, Indie, RPG",
    "tags": {
      "Open World Survival Craft": 16503,
      "Sandbox": 16196,
      "Survival": 12888,
      "2D": 12753,
      "Multiplayer": 12688,
      "Adventure": 11676,
      "Pixel Graphics": 11520,
      "Crafting": 10691,
      "Building": 10202,
      "Exploration": 9018,
      "Co-op": 7947,
      "Open World": 7689,
      "Online Co-Op": 6222,
      "Indie": 6178,
      "Action": 5731,
      "RPG": 5401,
      "Singleplayer": 5245,
      "Replay Value": 4412,
      "Platformer": 4068,
      "Atmospheric": 3602
    }
  };

/** Live capture – Euro Truck Simulator 2. */
export const SPY_EURO_TRUCK_2 = {
    "appid": 227300,
    "name": "Euro Truck Simulator 2",
    "developer": "SCS Software",
    "publisher": "SCS Software",
    "score_rank": "",
    "positive": 844480,
    "negative": 22924,
    "userscore": 0,
    "owners": "10,000,000 .. 20,000,000",
    "average_forever": 0,
    "average_2weeks": 0,
    "median_forever": 0,
    "median_2weeks": 0,
    "price": "1999",
    "initialprice": "1999",
    "discount": "0",
    "ccu": 17281,
    "languages": "English, German, French, Italian, Korean, Spanish - Spain, Simplified Chinese, Russian, Japanese, Portuguese - Portugal, Polish, Danish, Dutch, Finnish, Norwegian, Swedish, Hungarian, Czech, Romanian, Turkish, Portuguese - Brazil, Bulgarian, Greek, Ukrainian, Traditional Chinese, Catalan, Lithuanian, Serbian, Slovak, Slovenian",
    "genre": "Indie, Simulation",
    "tags": {
      "Driving": 12933,
      "Transportation": 12686,
      "Simulation": 12637,
      "Open World": 12555,
      "Automobile Sim": 12444,
      "Realistic": 12419,
      "Moddable": 12286,
      "Relaxing": 12189,
      "Exploration": 12037,
      "Economy": 11998,
      "Immersive Sim": 11987,
      "Management": 11960,
      "Atmospheric": 11922,
      "Multiplayer": 5047,
      "Controller": 4019,
      "Family Friendly": 3897,
      "Third Person": 3887,
      "Adventure": 3855,
      "Casual": 3851,
      "Indie": 3809
    }
  };

/** Live capture – The Witcher 3: Wild Hunt - Complete Edition. */
export const SPY_WITCHER_3 = {
    "appid": 292030,
    "name": "The Witcher 3: Wild Hunt - Complete Edition",
    "developer": "CD PROJEKT RED",
    "publisher": "CD PROJEKT RED",
    "score_rank": "",
    "positive": 802993,
    "negative": 32356,
    "userscore": 0,
    "owners": "20,000,000 .. 50,000,000",
    "average_forever": 0,
    "average_2weeks": 0,
    "median_forever": 0,
    "median_2weeks": 0,
    "price": "4999",
    "initialprice": "4999",
    "discount": "0",
    "ccu": 15893,
    "languages": "English, French, Italian, German, Spanish - Spain, Arabic, Czech, Hungarian, Japanese, Korean, Polish, Portuguese - Brazil, Russian, Traditional Chinese, Turkish, Simplified Chinese, Spanish - Latin America",
    "genre": "RPG",
    "tags": {
      "Open World": 12801,
      "RPG": 10801,
      "Story Rich": 10011,
      "Atmospheric": 6881,
      "Mature": 6825,
      "Fantasy": 6585,
      "Adventure": 6454,
      "Singleplayer": 6287,
      "Nudity": 6129,
      "Choices Matter": 5788,
      "Great Soundtrack": 4732,
      "Third Person": 4702,
      "Medieval": 4576,
      "Action": 4412,
      "Multiple Endings": 3967,
      "Action RPG": 3905,
      "Dark Fantasy": 3734,
      "Magic": 3717,
      "Dark": 2220,
      "Sandbox": 1335
    }
  };

/** Live capture – Stardew Valley. */
export const SPY_STARDEW_VALLEY = {
    "appid": 413150,
    "name": "Stardew Valley",
    "developer": "ConcernedApe",
    "publisher": "ConcernedApe",
    "score_rank": "",
    "positive": 872384,
    "negative": 13811,
    "userscore": 0,
    "owners": "20,000,000 .. 50,000,000",
    "average_forever": 0,
    "average_2weeks": 0,
    "median_forever": 0,
    "median_2weeks": 0,
    "price": "1499",
    "initialprice": "1499",
    "discount": "0",
    "ccu": 50662,
    "languages": "English, German, Spanish - Spain, Japanese, Portuguese - Brazil, Russian, Simplified Chinese, French, Italian, Hungarian, Korean, Turkish",
    "genre": "Indie, RPG, Simulation",
    "tags": {
      "Farming Sim": 7935,
      "Pixel Graphics": 7389,
      "Multiplayer": 7278,
      "Life Sim": 7246,
      "RPG": 6530,
      "Relaxing": 6286,
      "Agriculture": 5335,
      "Simulation": 5307,
      "Crafting": 4480,
      "Sandbox": 4378,
      "Indie": 4324,
      "Building": 3620,
      "Singleplayer": 3359,
      "Casual": 3356,
      "Open World": 3328,
      "2D": 2997,
      "Dating Sim": 2824,
      "Cute": 2814,
      "Great Soundtrack": 2561,
      "Fishing": 2287
    }
  };

/** Live capture – Celeste. */
export const SPY_CELESTE = {
    "appid": 504230,
    "name": "Celeste",
    "developer": "Maddy Makes Games Inc., Extremely OK Games, Ltd.",
    "publisher": "Maddy Makes Games Inc.",
    "score_rank": "",
    "positive": 117545,
    "negative": 3057,
    "userscore": 0,
    "owners": "2,000,000 .. 5,000,000",
    "average_forever": 0,
    "average_2weeks": 0,
    "median_forever": 0,
    "median_2weeks": 0,
    "price": "1999",
    "initialprice": "1999",
    "discount": "0",
    "ccu": 1174,
    "languages": "English, French, Italian, German, Spanish - Spain, Japanese, Portuguese - Brazil, Russian, Simplified Chinese",
    "genre": "Action, Adventure, Indie",
    "tags": {
      "Precision Platformer": 1432,
      "Difficult": 1415,
      "Pixel Graphics": 1406,
      "Great Soundtrack": 1405,
      "Indie": 1329,
      "Platformer": 1266,
      "2D Platformer": 1126,
      "Female Protagonist": 980,
      "Singleplayer": 830,
      "2D": 805,
      "Story Rich": 766,
      "Adventure": 609,
      "Cute": 602,
      "Puzzle-Platformer": 494,
      "LGBTQ+": 483,
      "Atmospheric": 480,
      "Action": 386,
      "Side Scroller": 326,
      "Retro": 323,
      "Exploration": 308
    }
  };

/** Live capture – Slay the Spire. */
export const SPY_SLAY_THE_SPIRE = {
    "appid": 646570,
    "name": "Slay the Spire",
    "developer": "Mega Crit",
    "publisher": "Mega Crit",
    "score_rank": "",
    "positive": 178250,
    "negative": 4027,
    "userscore": 0,
    "owners": "5,000,000 .. 10,000,000",
    "average_forever": 0,
    "average_2weeks": 0,
    "median_forever": 0,
    "median_2weeks": 0,
    "price": "2499",
    "initialprice": "2499",
    "discount": "0",
    "ccu": 15038,
    "languages": "English, Simplified Chinese, French, German, Korean, Russian, Japanese, Polish, Ukrainian, Spanish - Spain, Italian, Dutch, Traditional Chinese, Turkish, Thai, Portuguese - Brazil, Vietnamese",
    "genre": "Indie, Strategy",
    "tags": {
      "Roguelike Deckbuilder": 1728,
      "Card Game": 1588,
      "Card Battler": 1535,
      "Rogue-like": 1398,
      "Deckbuilding": 1123,
      "Turn-Based": 998,
      "Strategy": 809,
      "Singleplayer": 689,
      "Rogue-lite": 655,
      "Replay Value": 548,
      "Indie": 519,
      "Difficult": 363,
      "Dungeon Crawler": 328,
      "RPG": 255,
      "Mouse only": 249,
      "2D": 159,
      "Great Soundtrack": 143,
      "Procedural Generation": 141,
      "Fantasy": 141,
      "Casual": 92
    }
  };

/** Live capture – Hades. */
export const SPY_HADES = {
    "appid": 1145360,
    "name": "Hades",
    "developer": "Supergiant Games",
    "publisher": "Supergiant Games",
    "score_rank": "",
    "positive": 274829,
    "negative": 4912,
    "userscore": 0,
    "owners": "5,000,000 .. 10,000,000",
    "average_forever": 0,
    "average_2weeks": 0,
    "median_forever": 0,
    "median_2weeks": 0,
    "price": "2499",
    "initialprice": "2499",
    "discount": "0",
    "ccu": 2253,
    "languages": "English, French, Italian, German, Spanish - Spain, Korean, Portuguese - Brazil, Russian, Simplified Chinese, Polish, Japanese",
    "genre": "Action, Indie, RPG",
    "tags": {
      "Action Roguelike": 1330,
      "Rogue-lite": 954,
      "Hack and Slash": 936,
      "Indie": 928,
      "Mythology": 877,
      "Action": 816,
      "Rogue-like": 747,
      "Singleplayer": 701,
      "Great Soundtrack": 696,
      "Story Rich": 669,
      "RPG": 648,
      "Dungeon Crawler": 638,
      "Replay Value": 565,
      "Isometric": 432,
      "Difficult": 397,
      "Action RPG": 305,
      "Hand-drawn": 297,
      "Atmospheric": 284,
      "Perma Death": 102,
      "LGBTQ+": 93
    }
  };

/** Live capture – Vampire Survivors. */
export const SPY_VAMPIRE_SURVIVORS = {
    "appid": 1794680,
    "name": "Vampire Survivors",
    "developer": "poncle",
    "publisher": "poncle",
    "score_rank": "",
    "positive": 246479,
    "negative": 3855,
    "userscore": 0,
    "owners": "5,000,000 .. 10,000,000",
    "average_forever": 0,
    "average_2weeks": 0,
    "median_forever": 0,
    "median_2weeks": 0,
    "price": "499",
    "initialprice": "499",
    "discount": "0",
    "ccu": 2966,
    "languages": "English, French, Italian, German, Spanish - Spain, Japanese, Korean, Polish, Portuguese - Brazil, Russian, Simplified Chinese, Turkish, Ukrainian, Traditional Chinese",
    "genre": "Action, Casual, Indie, RPG",
    "tags": {
      "Action Roguelike": 911,
      "Bullet Hell": 848,
      "Pixel Graphics": 660,
      "Rogue-lite": 627,
      "Vampire": 506,
      "2D": 494,
      "Indie": 479,
      "Singleplayer": 444,
      "Casual": 371,
      "Arcade": 364,
      "Action": 329,
      "Rogue-like": 313,
      "RPG": 254,
      "Controller": 248,
      "Retro": 241,
      "Score Attack": 234,
      "Local Co-Op": 228,
      "Dark Fantasy": 226,
      "Action RPG": 215,
      "1980s": 111
    }
  };

/** Live capture – appid 1969360, an UNKNOWN appid. Third independent witness to
 * the empty-ARRAY shape, alongside appid 5 and appid 999999999.
 *
 * CORRECTED in the round-1 review (major 3). This was exported as
 * `SPY_CASTLE_FULL_OF_CATS` with the comment "the EMPTY-tags ARRAY shape, on a
 * real, floor-passing game (not junk)". That was wrong: 1969360 is not A Castle
 * Full of Cats, it returns `name: null`, and it has no catalog row – it is the
 * same class of thing as 999999999. The real game is appid 2070550 (see
 * SPY_CASTLE_FULL_OF_CATS below), it IS in the catalog, and it returns a full
 * 20-tag dict.
 *
 * The consequence matters for how the fill's results are read: the empty
 * outcome has NEVER been witnessed on a real catalogued game. Any prediction
 * about how many rows land in the "empty" leg of the funnel is therefore
 * unmeasured – the live fill produces the first real number. */
export const SPY_EMPTY_UNKNOWN_APPID = {
    "appid": 1969360,
    "name": null,
    "developer": "",
    "publisher": "",
    "score_rank": "",
    "positive": 0,
    "negative": 0,
    "userscore": 0,
    "owners": "0 .. 20,000",
    "average_forever": 0,
    "average_2weeks": 0,
    "median_forever": 0,
    "median_2weeks": 0,
    "price": null,
    "initialprice": null,
    "discount": null,
    "ccu": 0,
    "languages": null,
    "genre": null,
    "tags": []
  };

/** Live capture – A Castle Full of Cats, appid 2070550 (the real one; see
 * SPY_EMPTY_UNKNOWN_APPID above for the round-1 correction). One of SPEC.md
 * §7's ten spot-check games, and the smallest/most obscure of them – so it is
 * the proof that the populated 20-tag OBJECT shape is not confined to
 * blockbusters. In the catalog with app_type='game' and main_hours 1.05. */
export const SPY_CASTLE_FULL_OF_CATS = {
      "appid": 2070550,
      "name": "A Castle Full of Cats",
      "developer": "Devcats",
      "publisher": "Devcats",
      "score_rank": "",
      "positive": 3986,
      "negative": 23,
      "userscore": 0,
      "owners": "100,000 .. 200,000",
      "average_forever": 0,
      "average_2weeks": 0,
      "median_forever": 0,
      "median_2weeks": 0,
      "price": "399",
      "initialprice": "399",
      "discount": "0",
      "ccu": 6,
      "languages": "English, French, German, Spanish - Spain, Japanese, Korean, Polish, Portuguese - Brazil, Russian, Simplified Chinese, Spanish - Latin America, Traditional Chinese, Turkish, Italian, Hungarian",
      "genre": "Adventure, Casual",
      "tags": {
        "Cats": 126,
        "Hidden Object": 116,
        "Wholesome": 106,
        "Point & Click": 90,
        "Cozy": 87,
        "Creature Collector": 85,
        "Relaxing": 85,
        "Puzzle": 84,
        "Minimalist": 81,
        "Adventure": 71,
        "Casual": 64,
        "Exploration": 58,
        "Vampire": 46,
        "Singleplayer": 42,
        "Cute": 40,
        "Hand-drawn": 36,
        "Metroidvania": 34,
        "Cartoony": 32,
        "Horror": 27,
        "Collectathon": 23
      }
    };

/** Live capture – Balatro. */
export const SPY_BALATRO = {
    "appid": 2379780,
    "name": "Balatro",
    "developer": "LocalThunk",
    "publisher": "Playstack",
    "score_rank": "",
    "positive": 150524,
    "negative": 3042,
    "userscore": 0,
    "owners": "2,000,000 .. 5,000,000",
    "average_forever": 0,
    "average_2weeks": 0,
    "median_forever": 0,
    "median_2weeks": 0,
    "price": "1499",
    "initialprice": "1499",
    "discount": "0",
    "ccu": 17123,
    "languages": "English, French, Italian, German, Spanish - Spain, Dutch, Japanese, Polish, Portuguese - Brazil, Simplified Chinese, Spanish - Latin America, Traditional Chinese",
    "genre": "Casual, Indie, Strategy",
    "tags": {
      "Card Game": 567,
      "Roguelike Deckbuilder": 550,
      "Rogue-like": 550,
      "Deckbuilding": 477,
      "Singleplayer": 463,
      "Strategy": 427,
      "Pixel Graphics": 422,
      "Replay Value": 399,
      "Rogue-lite": 365,
      "Turn-Based": 348,
      "Card Battler": 338,
      "Casual": 322,
      "Difficult": 307,
      "Choices Matter": 305,
      "2D": 286,
      "Turn-Based Strategy": 277,
      "Indie": 272,
      "Relaxing": 261,
      "Arcade": 250,
      "Procedural Generation": 227
    }
  };

/** Live capture – appid 5 (“Dedicated Server”), a real non-game app.
 * Second independent witness to the empty-ARRAY shape. */
export const SPY_DEDICATED_SERVER = {
    "appid": 5,
    "name": "Dedicated Server",
    "developer": "",
    "publisher": "",
    "score_rank": "",
    "positive": 0,
    "negative": 0,
    "userscore": 0,
    "owners": "0 .. 20,000",
    "average_forever": 0,
    "average_2weeks": 0,
    "median_forever": 0,
    "median_2weeks": 0,
    "price": "0",
    "initialprice": "0",
    "discount": "0",
    "ccu": 0,
    "languages": "",
    "genre": "",
    "tags": []
  };

/** Live capture – appid 999999999, which does not exist. SteamSpy synthesises a
 * row (HTTP 200, `name: null`) rather than 404ing, and still returns `tags: []`. */
export const SPY_NONEXISTENT_APPID = {
    "appid": 999999999,
    "name": null,
    "developer": "",
    "publisher": "",
    "score_rank": "",
    "positive": 0,
    "negative": 0,
    "userscore": 0,
    "owners": "0 .. 20,000",
    "average_forever": 0,
    "average_2weeks": 0,
    "median_forever": 0,
    "median_2weeks": 0,
    "price": null,
    "initialprice": null,
    "discount": null,
    "ccu": 0,
    "languages": null,
    "genre": null,
    "tags": []
  };

/** Live capture – two entries from `request=all&page=0`, kept to pin the spec
 * assumption that the BULK feed carries no `tags` field at all (probe 2:
 * `"tags" in entry` was false for all 1000 entries on the page). */
export const SPY_BULK_ALL_ENTRIES = [
    {
      "appid": 10,
      "name": "Counter-Strike",
      "developer": "Valve",
      "publisher": "Valve",
      "score_rank": "",
      "positive": 243818,
      "negative": 6427,
      "userscore": 0,
      "owners": "10,000,000 .. 20,000,000",
      "average_forever": 0,
      "average_2weeks": 0,
      "median_forever": 0,
      "median_2weeks": 0,
      "price": "999",
      "initialprice": "999",
      "discount": "0",
      "ccu": 7323
    },
    {
      "appid": 30,
      "name": "Day of Defeat",
      "developer": "Valve",
      "publisher": "Valve",
      "score_rank": "",
      "positive": 6414,
      "negative": 688,
      "userscore": 0,
      "owners": "5,000,000 .. 10,000,000",
      "average_forever": 0,
      "average_2weeks": 0,
      "median_forever": 0,
      "median_2weeks": 0,
      "price": "499",
      "initialprice": "499",
      "discount": "0",
      "ccu": 87
    }
  ];

/** The throttle body shape recorded by the increment-7.7 live probes: HTTP 200
 * with a PLAIN-TEXT body. Not reproducible on 2026-08-28 (Cloudflare edge cache
 * absorbed the burst – see probe 3), so this stays a captured-then constant
 * rather than a fresh capture. `isThrottledBody()` keys off exactly this text. */
export const SPY_THROTTLE_BODY = "Too many connections";

/** The other observed throttle body from the same increment-7.7 probes. */
export const SPY_THROTTLE_BODY_ALT = "Connection failed";
