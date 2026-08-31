# Probe 1 – prompt-drift regression (300 slice-0 games)

Compared: 300 of 300. Batches: 12 (0 failed).
Wall-clock: 6.1 min. Mean batch: 30.4s.
CLI-reported list cost: $2.18 (plan route: $0 cash).

## Drift summary
- Mean |Δ|: **2.7** points
- Median |Δ|: **2** | p90: **7** | max: **28**
- Within ±5: 255/300 (85%)
- Within ±10: 291/300 (97%)
- Spearman rank correlation: **0.986**
- has_ending flips: **15**
- Endless count: slice-0 144 → now 145
- low confidence: slice-0 0 → now 3

## Anchors (the eye test)
| Game | slice-0 | now | Δ | ending | slice-0 reason | new reason |
|---|--:|--:|--:|:-:|---|---|
| Portal | 98 | 98 | 0 | ends → ends | Three hours, every minute earns it, perfect ending. | Perfect three hours, no wasted minute, iconic ending. |
| Portal 2 | 97 | 97 | 0 | ends → ends | Perfect authored puzzle comedy, zero padding, clean ending, co-op bonus. | Tight authored puzzles, great writing, zero padding, clean ending. |
| INSIDE | 93 | 93 | 0 | ends → ends | Anchor: flawless short authored ride, no padding at all. | Anchor: flawless short authored ride, zero padding. |
| Journey | 91 | 92 | +1 | ends → ends | Two flawless hours, strong ending, nothing wasted. | Two flawless hours, unforgettable ending, nothing padded at all. |
| Hades | 85 | 85 | 0 | ends → ends | Roguelite with a true authored ending; story pays off each run. | Roguelite that actually resolves its story; good from run one. |
| Baldur's Gate 3 | 40 | 40 | 0 | ends → ends | Outstanding and finite, but the time cost is enormous. | Excellent authored RPG that ends, but 75 hours most adults abandon. |
| Red Dead Redemption 2 | 45 | 45 | 0 | ends → ends | Masterful ending, slow controls and long chore stretches. | Great story buried under slow travel and chore animations. |
| Rocket League | 25 | 25 | 0 | endless → endless | Great single match, but pure endless competitive skill ladder. | Pure competitive ladder, no ending, aerials take many hours. |
| Team Fortress 2 | 15 | 15 | 0 | endless → endless | Endless class shooter, no campaign, aging player base. | Endless class shooter, no campaign, bot-plagued servers now. |
| Rust | 10 | 10 | 0 | endless → endless | Wipes erase progress; hostile grind, no ending at all. | Endless wipe cycle, raided while offline, hostile to newcomers. |
| Stardew Valley | 60 | 60 | 0 | ends → ends | Soft ending only, endless loop after; huge time sink. | Soft ending after year three; loop repeats past that. |

## 15 biggest disagreements
| Game | slice-0 | now | Δ | ending | slice-0 reason | new reason |
|---|--:|--:|--:|:-:|---|---|
| Call of Duty: Modern Warfare 2 (2009) | 40 | 68 | +28 | endless → ends | Multiplayer half of MW2; endless prestige ladder, no conclusion | Same tight MW2 campaign; multiplayer client half is endless |
| VTOL VR | 58 | 40 | -18 | endless → endless | Superb VR jet sim, campaigns end, but steep switchology learning cost | Superb VR jet sim, but campaign is thin and learning is steep |
| A Dance of Fire and Ice | 58 | 74 | +16 | ends → ends | Finite rhythm campaign, but brutal difficulty walls late. | Finite authored rhythm levels, but harsh difficulty walls stop many. |
| STAR WARS Battlefront II (Classic, 2005) | 30 | 45 | +15 | endless → ends | Thin campaign wrapper on endless skirmish battles | Thin campaign; value sits in endless skirmish and dated multiplayer |
| Wallpaper Engine | 5 | 18 | +13 | endless → endless | Wallpaper tool, not a game, no authored experience | Wallpaper tool, not a game. Nice, but nothing to finish. |
| Soundpad | 3 | 15 | +12 | endless → endless | Soundboard utility, not a game at all | Soundboard utility. Useful, but it is not an experience. |
| Blender | 4 | 15 | +11 | endless → endless | Professional 3D software, steep skill ladder, no ending | Free 3D tool. Very steep to learn, and nothing to finish. |
| Age of Empires II: Definitive Edition | 66 | 55 | -11 | ends → ends | Finite historical campaigns you can finish; ladder play optional. | Finite campaigns of high quality, but skill ladder and endless multiplayer pull. |
| The Long Drive | 22 | 33 | +11 | endless → endless | Endless jank road survival sandbox, no destination, no ending. | Open-ended sandbox drive; no goal, no conclusion, jank sustains it. |
| Left 4 Dead 2 | 72 | 62 | -10 | ends → ends | Five tight campaigns that finish; instantly fun, easy to complete. | Five tight finite campaigns, instant fun; needs friends, then loops forever. |
| Divinity: Original Sin 2 - Definitive Edition | 52 | 42 | -10 | ends → ends | Superb tactical RPG, but a huge time bill few finish | Superb tactics, but huge time cost and a rough, complex first act. |
| Firework | 76 | 86 | +10 | ends → ends | Compact horror mystery, strong story, clean finish, no padding. | Compact horror mystery, strong story, clean finish, no padding. |
| 暖雪 Warm Snow | 58 | 68 | +10 | ends → ends | Snappy action roguelite with real endings, but repetitive late runs | Snappy roguelite with real endings; runs repeat but stay short |
| Nioh 2 – The Complete Edition | 48 | 58 | +10 | ends → ends | Excellent combat, but long mission-reuse grind and steep learning wall | Superb combat, real ending, but loot bloat and repeated maps |
| Love Is All Around | 63 | 72 | +9 | ends → ends | Finite FMV romance with real endings; thin outside novelty. | Finite FMV romance, complete branches, but limited replay value. |

## has_ending flips (15)
| Game | slice-0 | now | Δ | ending | slice-0 reason | new reason |
|---|--:|--:|--:|:-:|---|---|
| Left 4 Dead | 45 | 45 | 0 | endless → ends | Campaigns end, but designed for endless replay with friends | Four short campaigns end, but replay loop needs friends. |
| STAR WARS Battlefront II (Classic, 2005) | 30 | 45 | +15 | endless → ends | Thin campaign wrapper on endless skirmish battles | Thin campaign; value sits in endless skirmish and dated multiplayer |
| Call of Duty: Modern Warfare 2 (2009) | 40 | 68 | +28 | endless → ends | Multiplayer half of MW2; endless prestige ladder, no conclusion | Same tight MW2 campaign; multiplayer client half is endless |
| Plague Inc: Evolved | 52 | 58 | +6 | ends → endless | Clever sim, finishable campaign, but repeats itself quickly. | Clever finite scenarios, but unlock grind and repeat runs. |
| Mount & Blade II: Bannerlord | 30 | 30 | 0 | ends → endless | Sandbox campaign ends weakly, repetitive sieges and menus. | Sandbox campaign fizzles out; empty repetition after conquest. |
| RimWorld | 40 | 42 | +2 | endless → ends | Sandbox colony sim; escape ship is token, loop is endless. | Escape ship is an ending, but sandbox loops forever and starts opaque. |
| Rivals of Aether | 33 | 29 | -4 | ends → endless | Small story mode; real value is long competitive skill ladder. | Story mode is slight; real game is endless competitive ladder. |
| Hearts of Iron IV | 28 | 25 | -3 | ends → endless | Sandbox war sim, ends at 1948, punishing wiki homework. | Sandbox war with hard tutorial wall; DLC treadmill, no story. |
| Deep Rock Galactic | 30 | 30 | 0 | endless → ends | Endless co-op mission treadmill with promotion grind, no real conclusion. | Endless mission grind, no authored conclusion, needs friends. |
| Barotrauma | 30 | 22 | -8 | ends → endless | Needs a crew, brutal learning wall, mostly endless sandbox. | Endless co-op sub sim, needs a crew, steep systems |
| Valheim | 40 | 42 | +2 | ends → endless | Final boss exists, but grinding and unfinished later biomes. | Boss list is not an ending; early access, long grind. |
| Total War: WARHAMMER III | 30 | 22 | -8 | ends → endless | Campaigns end, but huge time sink and steep learning. | Sandbox campaigns rarely finish; huge systems wall for newcomers. |
| GUILTY GEAR -STRIVE- | 20 | 22 | +2 | endless → ends | Story mode is a movie; real game is endless ranked ladder | Short story mode, but the real game is an endless PvP ladder. |
| Palworld | 34 | 38 | +4 | ends → endless | Fun opening, thin authored content, early-access ending. | Fun first ten hours, then base grind with no real end. |
| Poppy Playtime | 62 | 58 | -4 | endless → ends | Short sharp horror, but story is unfinished across paid chapters | Short, sharp scares. Episodic, so the full story stays unfinished. |

