# Melee stat accolades — research notes

Reference material for writing the stats popup's accolade titles and summary lines: what the Melee community calls things (Part A), and what a Slippi replay can actually measure with the **slippi-js 6.7.0** in `app/node_modules` (Part B). Researched 2026-11-11. Sources are numbered at the end; `[n]` cites one. Anything marked **unverified** wasn't confirmed against a primary source or a real replay.

**Empirical check.** The item ids, death animations and several action states below were checked by a read-only scan of 400 local replays (Slippi 3.17.0 / 3.19.1, mostly Fox, Falco, Sheik, Peach, Falcon, Marth, Puff and Pikachu) [10]. Where a count is quoted, it comes from that scan.

---

## Summary

- **Most "funny" stats need the frames, not `getStats()`.** `stats.actionCounts` covers movement, dodges, grabs, throws, techs and L-cancels. Projectiles, taunts, Rest, shines, turnip faces, star KOs and button habits all come from `game.getFrames()`: per-player `post.actionStateId`, and `frames[f].items` [1].
- **The item type ids are settled.** The Melee decomp, libmelee, py-slippi and the Slippi-linked data sheet all agree [3][6][7][8], and the local scan confirmed the main ones: Fox laser `0x36`, Falco laser `0x37`, Sheik needle `0x4F` thrown / `0x50` held, Peach turnip `0x63`, Pikachu jolt `0x59`/`0x5A`, Samus missile `0x5F`, charge shot `0x5E`, Mewtwo shadow ball `0x70`, Doc pill `0x31`, Mario fireball `0x30`, Luigi fireball `0x69`, Yoshi egg `0x56`. A Peach pull uses the ordinary item ids: Bob-omb `0x06`, Mr. Saturn `0x07` (seen in the scan, owned by Peach, spawned in her Vegetable state 352), Beam Sword `0x0C`.
- **`item.owner` needs Slippi ≥ 3.6.0** (spec [2]). slippi-js 6.7.0 reads it but not the newer `instanceId` (3.16.0). Count a projectile once per `spawnId`. Unowned items exist: Sudden Death Bob-omb rain shows up as `0x06` with owner −1, and Yoshi's Story Shy Guys as `0xD2`.
- **Action states 0–340 are common; 341 and up are character-specific** (the sheet says so outright [3]). Read any id ≥ 341 together with the character. The per-character table [4] gives, for example: Fox/Falco shine 360–369, Puff Rest 369–372, Puff Pound 363/364, G&W Judge 355–372 (the number is `(state − 355) % 9 + 1`), G&W Oil Panic 375–380, Peach Golf club/Frying pan/Tennis racket smashes 349/350/351.
- **Common states worth knowing:** taunt 264/265; ledge catch 252 and hang 253; teeter 245; wall jump or wall-tech jump 203; wall tech 202; missed wall tech 247; wall bonk 249; missed tech bounce 183/191; shield 178–182; shield-break flight 205 and dizzy 211; asleep from Sing 297; dying 0–10; respawn 12/13.
- **How a stock was lost** is `stats.stocks[].deathAnimation`: 0 bottom, 1 left, 2 right, **4 Star KO**, **7 Screen KO**. The scan saw only 0, 1, 2, 4 and 7, and the sources disagree about the labels of 6 to 8 [3][8].
- **Doubles gets no `actionCounts`, `conversions` or `combos`.** slippi-js only computes them for exactly two players. Frame-level stats still work in doubles.
- **Things slippi-js 6.7.0 doesn't expose:** the State Bit Flags (fastfall, powershield, shield active, in hitstun). The raw bytes are still reachable through `iterateEvents` (B9), but that path is untested.
- **Community naming.** Melee's own results-screen bonuses (Poser, Cliff Hanger, Meteor Smash, Star KO, Foresight, Combo King, Butterfingers…) are authentic, friendly and map almost one-to-one onto replay stats [50]. Use them as the backbone, and season with player nods the sources do support: Swedish Sniper, Clutchbox, The Kid, The Robot, God Slayer, I pray to win, Ken combo, wobbling, Amsah tech, Wall of pain, Tournament Winner.
- **Don't use "Mango SD".** No affectionate, widely used meme turned up [search, Sources]. Nor do the sources tie Hungrybox to ledge grabbing: his documented signatures are Rest, bair walls and clutch comebacks [32][33]. For the most ledge grabs, "Cliff Hanger" (the game's own bonus) and the 60-grab ledge-grab-limit rule [24][25] are the better hooks.

---

## Part A — community references tied to measurable actions

"How" points to the Part B section that computes it. Titles are 2–4 words, friendly, and never a dig at a real person. A player nod refers to a well-documented signature habit or nickname only.

### A1. Ledges and recovery

| Action / stat | Reference (one line) | Candidate titles | How | Src |
|---|---|---|---|---|
| Ledge grabs (`actionCounts.ledgegrabCount` = entries into CliffCatch 252) | Melee's results screen counts **"Cliffhangers"**, and majors forfeit a timed-out game for more than 60 (15 in a 1-stock tiebreak). Melee's bonus list has "Cliff Hanger" and "Rock Climber" | Cliff Hanger · Rock Climber · Ledge Loyalist · Sixty Club (only near 60) | B2 | [24][25][50] |
| Ledge stalling / planking (re-grabbing with no grounded frame between) | Planking: abusing ledge invincibility by re-grabbing. A Brawl-era name, but Melee's LGL exists for the same reason | Professional Planker · Ledge Lounger · Hang Time | B7, B8 | [23][24] |
| Ledge jump (CliffJump 260–263) | The ledge jump's joke name is **"Tournament Winner"** (for how risky it is) | Tournament Winner · Bold Ledge Jumper | B7 | [51] |
| Ledgedash (ledge → drop → airdodge → special landing on stage) | A named technique (SmashWiki "Ledgedash") | Ledgedash Legend · Invincible Return | B7 | [54] |
| Teeter (Ottotto 245/246) | The edge-balance animation ("Ottotto" = "whoops") | Balancing Act · Living on the Edge | B7 | [3] |
| Wall jumps (203; it's also the wall-tech jump, so Marth and Puff appear in the data too) | **Doraki walljump** — named after Doraki (Zef Klop), a Fox player | Wall Crawler · Doraki Disciple · Parkour! | B7 | [46] |
| Wall bonk (StopWall 249) | Melee bonus **"Head Banger"** (hitting walls) | Head Banger · Wall Inspector | B7 | [50] |
| Platform drop-throughs (Pass 244) | Melee bonus **"Floor Diver"** | Floor Diver · Platform Hopper | B7 | [50] |
| Falling off the ledge (CliffWait → fall, no jump) | Melee bonuses **"Cliff Diver"** / **"Quitter"** | Cliff Diver (avoid "Quitter") | B7 | [50] |

### A2. Projectiles

| Action / stat | Reference | Candidate titles | How | Src |
|---|---|---|---|---|
| Fox lasers (item `0x36`, owner = Fox) | Fox's Blaster; short-hop lasers are basic spacie play | Pew Pew Pilot · Laser Show · Trigger-Happy Fox | B6 | [6][10][54] |
| Falco lasers (`0x37`) | Falco laser pressure, also the start of a **pillar** | Laser Lord · Bird With a Blaster · Pew Pew Pigeon | B6 | [6][10] |
| Sheik needles thrown (`0x4F`; `0x50` is held, don't count it) | Needle Storm; needle camping | Needle Point · Pincushion Maker · Sewing Circle | B6 | [6][10][54] |
| Samus missiles (`0x5F`; `missileType` 0 homing / 1 super) | Super Missile | Missile Command · Homing Instinct · Super Missile Fan | B6 | [2][6][54] |
| Samus charge shot (`0x5E`, `chargeShotLaunched`/`chargePower`) | Charge Shot | Fully Charged · Big Blast | B6 | [2][6] |
| Samus bombs (`0x5D`); bomb jumps (Samus 341/342) | Bomb jump (SmashWiki) | Bomb Squad · Bomb Jumper | B6, B7 | [4][54] |
| Link / Young Link arrows, boomerangs, bombs (`0x40`/`0x41` arrows, `0x3C`/`0x3D` boomerangs, `0x3A`/`0x3B` bombs) | **Armada's Young Link**, his counterpick to Hungrybox's Puff from Pound V | Arrow Storm · Boomerang Return · Counterpick Special | B6 | [6][31] |
| Peach turnips pulled (`0x63`, or Vegetable 352) | **"Swedish Sniper"**: Armada's nickname, from his precision with projectiles / turnips | Swedish Sniper · Turnip Farmer · Farm to Table | B6 | [22][30][31] |
| Stitch Face turnip (`turnipFace` 7; 1 in 58 turnips, 30% damage) | The rare 30% turnip | Stitch Face! · Lucky Stitch | B6 | [2][22] |
| Dot-eyes turnip (`turnipFace` 6; 1 in 58, 12%) | The second-rarest face | Dot Eyes Delivery | B6 | [2][22] |
| Mr. Saturn pull (`0x07` owned by Peach) | 1 in 256 pulls | Friend of Saturn · Boing! | B6 | [22][10] |
| Bob-omb pull (`0x06` owned by Peach; owner −1 = Sudden Death rain) | 1 in 384 pulls | Explosive Harvest · Bob-omb Squad | B6 | [22][10] |
| Beam Sword pull (`0x0C` owned by Peach; its swings are attack ids 63–66) | 1 in 768 pulls, the rarest | Sword in the Garden · Saber Harvest | B5, B6 | [5][22] |
| Mario fireballs (`0x30`) / Doc pills (`0x31`) / Luigi fireballs (`0x69`) | Megavitamins; fireballs | Fireball Frenzy · Doctor's Orders · Green Fireballer | B6 | [6][10] |
| Pikachu thunder jolts (`0x59` + `0x5A`); Thunder (`0x51`) | Thunder Jolt; Thunder | Static Shock · Thunder Jolter · Thunder Calling | B6 | [6][10] |
| Mewtwo shadow balls (`0x70`; `chargePower`) | Shadow Ball | Shadow Ball Pitcher · Psychic Charger | B6 | [2][6] |
| Yoshi eggs thrown (`0x56`) | Egg Throw; aMSa stalls ledges with it | Egg Toss Champ · Breakfast Is Served | B6 | [6][40] |
| Sniping only (every hit is a projectile) | Melee bonus **"Sniper"** | Sniper | B5 | [50] |

### A3. Spacie tech (Fox / Falco)

| Action / stat | Reference | Candidate titles | How | Src |
|---|---|---|---|---|
| Shines (entries into 360 ground or 365 air) | "Shine" = Reflector, the community's name for it | Shine On · Shine Enthusiast | B7 | [4][18] |
| Multishine (≥ 3 shines, each jump-cancelled into the next: Fox's cycle is 8 frames, Falco's 11) | Multishine / double shine | Multishine Maestro · Shine Machine | B7 | [18] |
| Waveshine (shine → KneeBend 24 → airdodge → LandingFallSpecial 43) | Waveshine | Waveshine Wizard · Surf's Up | B7 | [18] |
| Shine spike kill (Fox/Falco down-B hit, move id 21, on an offstage victim who then dies) | Shine spike (a semi-spike; works at 0%) | Shine Spiker · Downward Shine | B4, B8 | [19] |
| Pillar (Falco dair 17 → shine 21, repeated in one conversion) | **Pillaring**, popularised by Bombsoldier | Pillar Builder · Pillar of Society | B4 | [42] |
| Blaster uses (Fox/Falco 341–346) vs lasers (`0x36`/`0x37`): the gun `0x4A`/`0x4B` is not a shot | — | (use lasers) | B6 | [4][10] |

### A4. Movement

| Action / stat | Reference | Candidate titles | How | Src |
|---|---|---|---|---|
| Wavedashes (`wavedashCount`) | Wavedash | Wavedash Wizard · Slip 'n' Slide · Surf's Up | B2 | [54] |
| Wavelands (`wavelandCount`) | Waveland | Smooth Landing · Platform Surfer | B2 | [54] |
| Dash dances (`dashDanceCount`: Dash→Turn→Dash) | Dash dance | Dash Dancer · Fancy Footwork · Dance Floor Regular | B2 | [54] |
| Rolls (`rollCount`) | Star Fox's "Do a barrel roll!" (a general gaming meme; a fit for Fox/Falco) | Do a Barrel Roll · Roll Model | B2 | [54] |
| Spotdodges (`spotDodgeCount`) | Spot dodge | Now You See Me · Spot On | B2 | [54] |
| Airdodges (`airDodgeCount`, wavedash airdodges excluded) | — | Air Dodger · Untouchable | B2 | [1] |
| Most time airborne (`post.isAirborne`) | Melee bonus **"Eagle"**; "Aerialist" (only midair jumps) | Eagle · Frequent Flyer | B9 | [50] |
| Never jumped / never crouched / never walked | Melee bonuses **"Cement Shoes"**, **"Stiff Knees"**, **"Run, Don't Walk"** | (the bonus names) | B7 | [50] |
| Stayed near the centre (`positionX` near 0) / close to the opponent | Melee bonuses **"Center Stage"**, **"In the Fray"** | Center Stage · In the Fray | B8 | [50] |
| Puff's / Kirby's extra jumps (Puff 341–345) | — | Floaty Puffball · Frequent Flyer | B7 | [4] |
| Peach floats (Peach 341) | Peach's float | Float Like a Butterfly · Hover Mode | B7 | [4] |

### A5. Defence: shield, techs, crouch

| Action / stat | Reference | Candidate titles | How | Src |
|---|---|---|---|---|
| Shield time / shield hits taken (178–181; `post.shieldSize` 0–60) | Shield pressure | Shield Hugger · Turtle Mode · Safe & Sound | B7, B9 | [54] |
| Shield pressure dealt (the opponent entering GuardSetOff 181 from your hits) | Shield pressure | Pressure Cooker · Shield Crusher | B7 | [54] |
| Shield broken (205–210, dizzy 211) | Melee bonuses **"Shield Buster"** (you broke it) and **"Shattered Shield"** (yours broke) | Shield Buster · Seeing Stars | B7 | [50] |
| Puff's shield broken (instant KO on every legal stage) | Puff's shield break sends her straight off the top | Balloon Pop · Up, Up and Away | B7 | [47] |
| Hit while crouching (39–41) with no tumble after | Crouch cancel / ASDI down | Crouch Potato · Low Rider | B7 | [54] |
| Techs (`groundTechCount` in / away / neutral) | Teching; **Amsah tech** (ASDI down + tech) named after Amsah | Tech Wizard · Stay Put (neutral tech) · Tech Savvy | B2 | [16][54] |
| Missed techs (`groundTechCount.fail`: DownBound 183/191) | Missed tech → jab reset (185/193) | Floor Inspector · Nap on the Floor · Reset Button | B2, B7 | [3] |
| Wall techs (`wallTechCount.success`, 202) / missed (247) | Wall tech | Bounce House · Wall Splat | B2 | [3] |
| Tech chase (a hit landing within ~30 frames of the victim's tech or getup) | Tech chasing, e.g. Sheik and Falcon tech chases | Tech Chaser · Read the Room | B4, B7 | [54] |

### A6. Grabs, throws, chaingrabs

| Action / stat | Reference | Candidate titles | How | Src |
|---|---|---|---|---|
| Grabs landed (`grabCount.success`) | — | Free Hugs · Grab Bag | B2 | [1] |
| Missed grabs (`grabCount.fail`) | Melee bonus **"Butterfingers"** (most grabs fail; teasing, use gently) | Butterfingers · Reach Exceeds Grasp | B2 | [50] |
| All four throws used (`throwCount`) | Melee bonus **"Compass Tosser"** | Compass Tosser | B2 | [50] |
| Grabs and throws only | Melee bonus **"Pitcher"** | Pitcher | B5 | [50] |
| Pummels (Catch Attack 217; attack id 52) | — | Pummel Party | B5 | [5] |
| Chaingrab (≥ 3 throws, ids 53–56, in one conversion) | Chain grab: Sheik's down throw chains most of the cast; Marth's up throw chains spacies; ICs hand-offs | Chain Reaction · Regrab Royalty | B4 | [27] |
| Sheik down throw (move 56 by Sheik opening a conversion) | "Sheik downthrow" chains | Downthrow Specialist | B4 | [27] |
| Sheik chain (side-B, move 19 by Sheik; Sheik 349–354) on a ledge-hanging opponent | **Mew2King** is known for using the chain on opponents on the ledge | Chain on the Ledge · Chain Gang | B4, B7 | [28] |
| Wobbling (ICs: grab + many pummels / alternating hits in one conversion) | Named after **Wobbles**; banned at most events since 2019 | (probably skip: it's usually against the rules) | B4 | [11] |

### A7. Signature moves by character

| Action / stat | Reference | Candidate titles | How | Src |
|---|---|---|---|---|
| Puff Rest kill (kill conversion ending in move 21 by Puff) | Hungrybox's signature; "**The Rest heard around the world**" (EVO 2016) | Rest in Peace · Nap Time · Lights Out | B4 | [32][33] |
| Missed Rest, punished (Puff in 369–372, then a stock lost) | — | Bad Time for a Nap · Snooze Button | B7 | [4] |
| Puff Pound (363/364; move 19) | Pound, Puff's side-B; also **Pound**, the long-running Melee series (founded 2006) | Pound for Pound · Pound It | B5, B7 | [47][52] |
| Puff Sing (opponent in DamageSong 297) | Sing puts nearby foes to sleep | Lullaby · Sing-Along | B7 | [47] |
| Puff bair wall (≥ 3 bair hits, move 15, offstage in one conversion) | **"Wall of pain"**; Hungrybox's bair blockades | Wall of Pain · Bair Wall | B4, B8 | [33][47] |
| Falcon knee (fair, move 14, one hit ≥ ~15%: the clean hit is up to 18%, less when stale) | **"Knee of Justice"** / "hard knee" | Knee of Justice · Hard Knee | B4 | [21] |
| Falcon Punch kill (Falcon move 18 on a kill) | "Falcon Punch!" | FALCON PUNCH! · Show-Stopper | B4 | [20] |
| Falcon taunt (264/265 by Falcon) | His taunt line: **"Show me your moves!"** | Show Me Your Moves! | B7 | [20] |
| Falcon / Ganon stomp (dair, move 17) | Falcon's dair is "Step On It", a meteor | Step On It · Stomp Club | B4 | [20] |
| Ganon Warlock Punch kill (Ganon move 18 on a kill) | Warlock Punch | Warlock Punch! | B4 | [54] |
| Marth Ken combo (fair 14 → dair 17 in one conversion, ending in a bottom death) | **Ken combo**, named after Ken; the dair is a spike | Ken Combo! · Spike Delivery | B4 | [12] |
| Marth tipper (fsmash / fair hits above a damage threshold) | Tipper = the sword's sweet spot. **Damage cut-offs unverified**, and staling lowers damage up to 45% | Sweet Tip · Tipper Tapper | B4 | [53] |
| Marth vs spacies: big punishes | **Zain**: SmashWiki singles out his punish game on Fox and Falco as especially deadly | Spacie Punisher | B4 | [38] |
| Peach float cancel (float aerial 344–348 → landing) | Float cancel: landing lag cut to 4 frames | Float Canceller · Floating Point | B7 | [45] |
| Peach smash item (349 golf club, 350 frying pan, 351 tennis racket) | — | Fore! · Frying Pan Fan · Tennis Ace | B7 | [4][10] |
| G&W Judge number (355–372 → 1–9) | Judge; a 9 is the big one | Judge Nine! · Lucky Number | B7 | [4] |
| G&W Oil Panic (absorb 376/379, spill 377/380) | Oil Panic (the bucket) | Oil Panic! · Bucket Brigade | B7 | [4] |
| Yoshi egg-lay capture (opponent in YoshiEgg 277) | Egg Lay; aMSa's **"I play to win"**, cheered as "I pray to win" | Egg-cellent · I Pray to Win (for a Yoshi win) | B7 | [40] |
| ICs Nana lost, Popo carries on | **Sopo**: Popo alone after Nana's KO | Solo Popo · Sopo Survivor | B7, B9 | [15] |
| ICs desync (Popo and Nana in different states, neither in hitstun; **heuristic unverified**) | Desynching | Out of Sync | B9 | [43] |
| Zelda ⇄ Sheik mid-game (`post.internalCharacterId` changes; Sheik 361/363, Zelda 355/357) | Transform | Quick Change | B7, B9 | [4] |
| Luigi taunt hit (Luigi move 1; the taunt is non-staling, attack id 1) | Luigi's taunt has a hitbox | Taunt Spike! | B5 | [5] |
| Young Link taunt (YL 342/343; item `0x7B` "milk") | YL drinks milk in his taunt | Milk Break · Lon Lon Refresher | B6, B7 | [4][6] |
| DK cargo throw (DK 361–368) | Kong Karry | Special Delivery | B7 | [4] |
| Pikachu: up-air chains to a top-platform up-smash | **Axe**'s Pikachu (uairs to edgeguard and set up top-platform usmash kills) | Top Platform Special | B4 | [39] |

### A8. Taunts

| Action / stat | Reference | Candidate titles | How | Src |
|---|---|---|---|---|
| Taunt count (264/265; YL 342/343, Doc 341 are character-specific) | Melee bonus **"Poser"** (6+ taunts a minute) | Poser · Style Points · Show-Off | B7 | [4][50] |
| Taunt within ~1 s of a KO | Melee bonus **"Instant Poser"** | Instant Poser | B7 | [50] |
| Taunt right after the opponent taunts | Melee bonus **"Poser Poseur"** | Poser Poseur | B7 | [50] |
| Hitting a taunting opponent | Melee bonus **"Pose Breaker"** | Pose Breaker | B7 | [50] |
| Game ends mid-taunt | Melee bonus **"Fighter Stance"** | Fighter Stance | B7 | [50] |

### A9. KOs, combos, comebacks

| Action / stat | Reference | Candidate titles | How | Src |
|---|---|---|---|---|
| Self-destructs (stock lost with no opponent kill conversion: `game-stats.js` `sd`) | SD; there's no affectionate player meme for this (see Summary) | Gravity Check · Oops! · Self-Destruct Sequence | B4 | [54] |
| Earliest kill (`stats.stocks[].endPercent` low) | — | Early Bird · Quick Exit | B4 | [1] |
| Survived to a high percent (`stocks[].endPercent` high) | — (Melee's "Immortal" means never knocked off at all) | Iron Will · Survivor · Unkillable | B4 | [1][50] |
| Spike / meteor KO (death 0 = bottom after an attacker's dair, shine or stomp) | Melee bonus **"Meteor Smash"**; a meteor can be meteor-cancelled, a spike can't | Meteor Smash · Spike Ball | B4, B7 | [44][50] |
| Meteor cancel survived (hit by a meteor, then jump / up-B within ~8 frames after hitlag; **unverified detection**) | Meteor cancel; Melee bonus **"Meteor Survivor"** | Meteor Survivor | B7, B9 | [44][50] |
| Star KO dealt (death animation 4) | Melee bonus **"Star KO"** | Star KO · Twinkle Twinkle · Shooting Star | B7 | [49][50] |
| Screen KO taken (death animation 7) | Melee bonus **"Foresight"** (for being Screen KO'd) | Foresight · Window Washer · Face the Camera | B7 | [49][50] |
| Edgeguard kills (victim offstage when the killing conversion started) | Edgeguarding | Gatekeeper · Edgeguard Expert · Bouncer | B4, B8 | [54] |
| Killing an opponent hanging on the ledge | Melee bonus **"Hangman's KO"** | Hangman's KO | B4, B7 | [50] |
| KO within 5 s of being KO'd | Melee bonus **"Avenger KO"** | Avenger KO | B4 | [50] |
| KO'd off all four sides in one game | Melee bonus **"World Traveler"** | World Traveler | B7 | [50] |
| Zero-to-death (conversion `startPercent` 0 and `didKill`) | Zero-to-death | Zero to Hero · Full Combo | B4 | [48] |
| Longest combo (`combos[].moves.length`) | Melee bonus **"Combo King"**; the **Wombo Combo** ("Happy feet! Wombo combo!", a 2008 doubles combo) | Combo King · Wombo Combo · Where You At?! | B4 | [13][14][50] |
| Comeback from 2+ stocks down (`game-stats.js` `maxDeficit`) | **"Clutchbox" / "Clutchgod"** (Hungrybox); Mango's nickname **"The Kid"** and his comeback runs | Clutch Factor · Comeback Kid · Clutchbox Energy (Puff) | B4 | [32][34] |
| Last-stock game (both on their last stock) | — | Down to the Wire · Photo Finish | B4 | [1] |
| First hit of the game / first stock | Melee bonus **"First Strike"** | First Strike · First Blood | B4 | [50] |
| Led the whole game / trailed the whole game | Melee bonuses **"Wire to Wire"** / "Whipping Boy" (skip the second) | Wire to Wire | B4 | [50] |
| Final percent with one repeated digit (e.g. 111%) | Melee bonus **"Jackpot"** | Jackpot | B9 | [50] |
| A KO at exactly 64% | Melee bonus **"KO 64"** | KO 64 | B4 | [50] |
| Won after the opponent's SD | **"No Johns"**: no excuses for a loss; "John" from a Texas player known for them | No Johns | B4 | [17] |

### A10. Inputs and technical play

| Action / stat | Reference | Candidate titles | How | Src |
|---|---|---|---|---|
| L-cancel % (`lCancelCount`) | L-canceling; **Mew2King "The Robot"** (methodical, frame-data deep) for a near-perfect rate | The Robot · Clean Landings · L-Cancel Lord | B2 | [35][54] |
| Missed L-cancels | — | Heavy Landings | B2 | [1] |
| Inputs per minute (`overall.inputsPerMinute`) | APM | Fast Fingers · Hands of Fury | B3 | [1] |
| Very low IPM | — | Zen Master · Economy of Motion | B3 | [1] |
| X vs Y jumper (physical X `0x0400` / Y `0x0800` presses) | — | Team X · Team Y | B9 | [2] |
| Tap jumper (KneeBend 24 with no X/Y held) | — | Tap Jumper | B9 | [2] |
| C-stick usage (`overall.inputCounts.cstick`) | — | C-Stick Specialist | B3 | [1] |
| Z presses (`0x0010`) | Z = grab, or an aerial with L-cancel | Z Enthusiast | B9 | [2] |

### A11. Catchphrases and player nods — when to use them

| Phrase | What it is | A natural trigger | Src |
|---|---|---|---|
| "No items, Fox only, Final Destination" | A meme parodying strict tournament rules (origin unclear; MS Paint comics, 2007) | A Fox ditto on Final Destination (stage 32) | [29] |
| "No Johns" | No excuses | A win after an SD, or a clean set | [17] |
| "Pound" | Puff's side-B and the Pound series | Puff Pound hits | [52] |
| "Wombo Combo" / "Where you at?!" | A 2008 doubles combo (SilentSpectre and Tang) and its commentary | Very long or high-damage combos | [13][14] |
| "Ken combo" | Marth fair → dair spike | Marth spike kills | [12] |
| "Swedish Sniper" | Armada's precision nickname | Turnip hits / turnip kills | [30] |
| "God Slayer" / "Godslayer" | Leffen, who beat each of the **Five Gods** (Armada, Hungrybox, Mango, Mew2King, PPMD) | Beating a higher seed (seed is in the scoreboard, not the replay) | [36][37] |
| "Clutchbox", "Clutchgod" | Hungrybox's nicknames | A last-stock win or a comeback, especially as Puff | [32] |
| "The Kid" | Mango's nickname; aggressive, high-risk, famous comebacks | Comebacks | [34] |
| "The Robot" | Mew2King's nickname | Near-perfect L-cancels or consistency | [35] |
| "I play / pray to win" | aMSa's line, cheered by fans | Yoshi wins | [40] |
| "Wall of pain" | Puff bair offstage | Bair-wall kills | [47] |
| "Show me your moves!" | Falcon's taunt line | Falcon taunts | [20] |
| "Knee of Justice" | The Falcon knee | Knee kills | [21] |
| "Tournament Winner" | The risky ledge jump | Ledge jumps | [51] |
| Amsah tech / Doraki walljump / Pillar | Techniques named after or credited to players (Amsah, Doraki, Bombsoldier) | ASDI-down techs (hard to detect) / wall jumps / Falco pillars | [16][42][46] |
| Sopo | Popo without Nana | ICs after Nana dies | [15] |
| **Not used:** "Mango SD", "Swedish Fox" (Leffen), "Hbox = ledge" | No community source found; not documented | — | Sources (search) |

### A12. Melee's own bonus names (results screen / Bonus mode)

Melee has 249 bonuses, awarded for feats in a match [50]. These replay-measurable ones make ready-made, on-brand accolades. The requirements here are paraphrased:

| Bonus | Paraphrased requirement | Replay signal |
|---|---|---|
| Poser / Instant Poser / Poser Poseur / Pose Breaker / Fighter Stance | Taunting often, right after a KO, after the opponent's taunt, hitting a taunter, ending mid-taunt | 264/265 entries + timing |
| Cliff Hanger / Rock Climber / Edge Hog / Cliff Diver | Lots of ledge hangs; ledge grabs per minute; grabbing the ledge to block; dropping off it | 252/253, positions |
| Eagle / Aerialist / Cement Shoes / Acrobat | Lots of air time; only midair jumps; never jumps; always uses the midair jump | `isAirborne`, `jumpsRemaining`, 24 |
| Stiff Knees / Run, Don't Walk / Marathon Man / Never Look Back / Statue | Never crouches / walks; runs a lot; never turns; barely moves | 39–41, 15–17, 20–22, `facingDirection`, `positionX` |
| Head Banger / Floor Diver | Wall bonks; platform drop-throughs | 249, 244 |
| Bird of Prey / Smash Maniac / Smash-less / Specialist / Brawler / Sniper | Only aerials / smashes / no smashes / only specials / no projectiles / only projectiles | move ids (B5) |
| Combo King / Juggler / Backstabber / First Strike | Long combos; keeps a foe airborne; hits from behind; lands the first hit | combos, `facingDirection` vs relative x |
| Meteor Smash / Meteor Master / Meteor Survivor | KO with a meteor; every meteor hits; recovers from a meteor | death 0 + move; B7 |
| Shield Buster / Shield Saver / Shattered Shield / Power Shielder | Breaks a shield; drops shield just before it breaks; shield broken; powershields (needs bit flags, B9) | 205, `shieldSize`, B9 |
| Compass Tosser / Pitcher / Butterfingers / Close Call | All four throws; only grabs and throws; most grabs miss; throws just before the escape | `throwCount`, `grabCount` |
| Merciful Master / Impervious / Immortal / Full Power | Wins with no KOs (timeout); takes no damage; never knocked off; ends at 0% | stocks, percent |
| Star KO / Foresight / Hangman's KO / Wimpy KO / Special KO / KO 64 / Avenger KO / World Traveler / Shameful Fall | KO types (see A9) | `deathAnimation`, moves, percents |
| Jackpot / Wire to Wire / Center Stage / In the Fray | Final percent one repeated digit; led all game; middle of the stage; close to the foe | percent, stocks, positions |

---

## Part B — what slippi-js 6.7.0 can compute

### B1. The API surface

```js
const { SlippiGame, moves, characters, stages, animations, State, Timers,
        iterateEvents, openSlpFile, closeSlpFile } = require("@slippi/slippi-js");
const game = new SlippiGame(file);           // or a Buffer
game.getSettings();    // GameStartType: players[{playerIndex, characterId(external), characterColor, startStocks, teamId, …}], stageId, slpVersion
game.getStats();       // StatsType (below); cached once the game is complete
game.getFrames();      // { [frame]: { players: { [idx]: { pre, post } }, followers: { [idx]: { pre, post } }, items?: ItemUpdateType[] } }
game.getLatestFrame(); game.getGameEnd(); game.getMetadata(); game.getItems(); game.getWinners();
```

Runtime exports were checked with `node` against the installed package. There is no top-level `getWinners`; use the method. Frames run from −123 (`Frames.FIRST`); −39 is `Frames.FIRST_PLAYABLE`; 60 frames = 1 s [1].

`getStats()` → `{ gameComplete, lastFrame, playableFrameCount, stocks, conversions, combos, actionCounts, overall }`. **`actionCounts`, `conversions`, `combos` and `stocks` only exist for exactly two players** (`getSinglesPlayerPermutationsFromSettings` returns `[]` otherwise), so they're empty in doubles. `overall` is per player, but its conversion-based numbers are 0 in doubles [1].

### B2. `stats.actionCounts[]` — every field, and how it's counted

Source: `dist/stats/actions.esm.js` [1]. A count goes up only on a **new action**: the action state changed, or `actionStateCounter` went down (the same action repeated).

| Field | Counted when | Notes |
|---|---|---|
| `playerIndex` | — | port − 1 |
| `wavedashCount` / `wavelandCount` | LandingFallSpecial (43) right after an airdodge (236) or a jump state (24–34). A KneeBend (24) in the last 8 frames → wavedash; otherwise waveland. Skipped when the last 8 frames are only airdodge + landing (a late airdodge) | The used airdodge is subtracted from `airDodgeCount` |
| `airDodgeCount` | Enter EscapeAir 236 | Minus the wavedash/waveland ones |
| `dashDanceCount` | The last 3 frames are exactly Dash 20 → Turn 18 → Dash 20 | |
| `spotDodgeCount` | Enter Escape 235 | |
| `ledgegrabCount` | Enter CliffCatch 252 | Equal to the results screen's "Cliffhangers"? **unverified** |
| `rollCount` | Enter EscapeF 233 / EscapeB 234 | |
| `lCancelCount.{success,fail}` | While in an aerial (65–74): `post.lCancelStatus` 1 = success, 2 = fail | |
| `attackCount.{jab1,jab2,jab3,jabm,dash,ftilt,utilt,dtilt,fsmash,usmash,dsmash,nair,fair,bair,uair,dair}` | Enter 44, 45, 46, 47, 50, 51–55, 56, 57, 58–62, 63, 64, 65–69 | G&W uses 341, 342, 345–349; Peach fsmash 349–351. A boost grab (dash attack → DashGrab 214) takes 1 off `dash`. slippi-js counts G&W 342 as `jabm`, but the sheet calls 342 "Jab 2" and 343 "Rapid Jabs" [4] |
| `grabCount.{success,fail}` | The previous state was Catch 212 / CatchDash 214, and the new one is (success) or isn't (fail) in 213–222, not counting 214 | |
| `throwCount.{up,forward,back,down}` | Enter 221 / 219 / 220 / 222 | |
| `groundTechCount.{away,in,neutral,fail}` | 200/201, read against facing **toward the opponent** (not the stage); neutral 199; fail = DownBound 183/191 | "in"/"away" are relative to the opponent |
| `wallTechCount.{success,fail}` | 202 / 247 | |

### B3. `stats.overall[]`

`{ playerIndex, inputCounts{buttons,triggers,joystick,cstick,total}, conversionCount, totalDamage, killCount, successfulConversions, inputsPerMinute, digitalInputsPerMinute, openingsPerKill, damagePerOpening, neutralWinRatio, counterHitRatio, beneficialTradeRatio }`. Each ratio is `{ count, total, ratio|null }`. Notes, from `overall.esm.js` / `inputs.esm.js` [1]:

- Inputs count physical buttons going 0→1, stick and C-stick moving into a new region (deadzone ±0.2875; going back to the deadzone isn't counted), and triggers crossing 0.3.
- Minutes = `playableFrameCount / 3600`.
- `killCount` = conversions with `didKill` and `lastHitBy === me`. `totalDamage` = the sum of `moves[].damage` for my moves.

### B4. `conversions[]`, `combos[]`, `stocks[]`

- **`ComboType`**: `{ playerIndex /* VICTIM */, lastHitBy /* attacker */, startFrame, endFrame, startPercent, currentPercent, endPercent, moves: MoveLandedType[], didKill }`. **`ConversionType`** adds `openingType: "neutral-win" | "counter-attack" | "trade" | "unknown"` [1].
- **`MoveLandedType`**: `{ playerIndex /* attacker */, frame, moveId /* attacker's post.lastAttackLanded */, hitCount, damage }`. A move is a new move once the attacker's action state changes, or its counter resets, after a hit, so multi-hit moves (drill, rapid jabs) are one move with a `hitCount` [1].
- **Ending:** a conversion ends after the victim is back in control for 45 frames (`Timers.PUNISH_RESET_FRAMES`) or loses a stock. A combo ends after 45 frames out of hitstun, grab, tech, downed or dying (`COMBO_STRING_RESET_FRAMES`). So a conversion is a longer "punish"; a combo is stricter [1].
- **`StockType`**: `{ playerIndex, count, startFrame, endFrame, startPercent, currentPercent, endPercent, deathAnimation }`. `deathAnimation` is the action state on the frame `stocksRemaining` dropped. `animations.getDeathDirection(id)` → 0 "down", 1 "left", 2 "right", anything else ≤ 10 "up" [1]. See B7 for Star and Screen KO.

### B5. Move / attack ids (`moveId`, `post.lastAttackLanded`)

slippi-js's own table (`dist/melee/moves.esm.js`), read with `moves.getMoveInfo(id)` → `{id, name, shortName}`, or `getMoveName` / `getMoveShortName`. An unknown id gives `{ id: -1, name: "Unknown Move", shortName: "unknown" }` [1].

| id | name / shortName | id | name / shortName |
|---|---|---|---|
| 1 | Miscellaneous / misc | 13–17 | Neutral/Forward/Back/Up/Down Air · nair fair bair uair dair |
| 2, 3, 4 | Jab / jab | 18 | Neutral B / neutral-b |
| 5 | Rapid Jabs / rapid-jabs | 19 | Side B / side-b |
| 6 | Dash Attack / dash | 20 | Up B / up-b |
| 7 | Forward Tilt / ftilt | 21 | Down B / down-b |
| 8 | Up Tilt / utilt | 50 | Getup Attack / getup |
| 9 | Down Tilt / dtilt | 51 | Getup Attack (Slow) / getup-slow |
| 10 | Forward Smash / fsmash | 52 | Grab Pummel / pummel |
| 11 | Up Smash / usmash | 53–56 | Forward / Back / Up / Down Throw · fthrow bthrow uthrow dthrow |
| 12 | Down Smash / dsmash | 61 / 62 | Edge Attack (Slow) / Edge Attack · edge-slow / edge |

The full table, from the Slippi-linked Attack IDs sheet [5], adds: **0** none; **1 = non-staling**; **22–46** Kirby hat neutral-Bs (by character); **57–60** DK cargo throws; **63–66** Beam Sword jab / tilt / smash / dash swings (a Peach sword pull); **67–93** other items. The sheet calls 50 "Get Up Attack (From Back)" and 51 "(From Front)", while slippi-js labels them as normal/slow; 61 is the 100%+ ledge attack.

**Special-move rules** from the sheet's "Specials" and "Non-Staling" tabs [5]. These matter for "which move did it":
- Neutral B (18) includes Fox/Falco lasers, Sheik needles, Samus charge shot, Pikachu jolt, Mario/Luigi fireballs and Doc pills, Mewtwo shadow ball, ICs ice, Link/YL arrows, G&W bacon, Ness PK Flash, Bowser fire.
- Side B (19) includes Samus missiles (both kinds), Link/YL boomerangs, all G&W Judges, Sheik chain, Din's Fire, PK Fire, Luigi missile, Marth/Roy side-Bs.
- Up B (20) includes Yoshi's egg toss, PK Thunder, Peach parasol, Kirby's cutter projectile.
- Down B (21) includes Samus bombs, the G&W bucket, Pikachu Thunder, ICs blizzard, Marth/Roy counter, Mewtwo disable, Puff Rest (by elimination; **unverified** in the sheet text), and the shine when it hits with its own hitbox.
- **Peach turnips, Link/YL bombs and Luigi's taunt are non-staling (1).** So does every thrown item (Peach's Bob-omb / Mr. Saturn / Beam Sword thrown).
- A **reflected** projectile carries the projectile's id, not the reflector's.
- `post.lastAttackLanded` resets to 0 on death [2].

### B6. Items — `frames[f].items[]`

`ItemUpdateType` (parsed in `slpReader.esm.js` [1]; offsets and versions from the spec [2]):

| Field | Type | Added | Meaning |
|---|---|---|---|
| `frame` | int32 | 3.0.0 | |
| `typeId` | uint16 | 3.0.0 | Item kind (table below) |
| `state` | uint8 | 3.0.0 | Item state, mostly undocumented |
| `facingDirection`, `velocityX/Y`, `positionX/Y` | float | 3.0.0 | |
| `damageTaken` | uint16 | 3.0.0 | |
| `expirationTimer` | float | 3.0.0 | Frames left; can go negative (Link arrows) |
| `spawnId` | uint32 | 3.0.0 | Goes up by one for each spawn: **dedupe on this** |
| `missileType` | uint8 | 3.2.0 | Samus: 0 homing, 1 super |
| `turnipFace` | uint8 | 3.2.0 | 0 Smile, 1 T Eyes, 2 Line Eyes, 3 Circle Eyes, 4 Upward Curve, 5 Wink, 6 Dot Eyes, 7 Stitch Face |
| `chargeShotLaunched` | uint8 | 3.2.0 | Samus / Mewtwo charge shot fired |
| `chargePower` | uint8 | 3.2.0 | Samus / Mewtwo charge level |
| `owner` | int8 | **3.6.0** | 0–3 = the owning player index, −1 = none |
| `instanceId` | uint16 | 3.16.0 | **Not read by slippi-js 6.7.0** |

Fields missing from an older replay read as `null` (`canReadFromView`) [1]. Items are only recorded from 3.0.0.

**Item type ids** (hex). The decomp `ItemKind` enum [6] is the authority. libmelee [7], py-slippi [8] and the Slippi-linked sheet [3] agree on every id here. "Seen" = first sightings (distinct `spawnId`) by owner in the 400-replay scan [10].

| id | Item | Owner seen in scan |
|---|---|---|
| `0x06` | Bob-omb (Peach pull 1/384; also Sudden Death rain) | 8 × owner −1 (bomb rain, one game, items off) |
| `0x07` | Mr. Saturn (Peach pull 1/256) | 1 × Peach, spawned in Peach's Vegetable state 352 |
| `0x0C` | Beam Sword (Peach pull 1/768) | — |
| `0x30` | Mario fireball | — |
| `0x31` | Dr. Mario pill (Megavitamin) | Doc 12 |
| `0x32` | Kirby cutter beam | Kirby 1 |
| `0x36` / `0x37` | **Fox laser / Falco laser** | Fox 2742 / Falco 3444 |
| `0x38` / `0x39` | Fox Illusion / Falco Phantasm afterimage | Fox 243 / Falco 472 |
| `0x3A` / `0x3B` | Link bomb / Young Link bomb | — |
| `0x3C` / `0x3D` | Link / YL boomerang | — |
| `0x3E` / `0x3F` | Link / YL hookshot | — |
| `0x40` / `0x41` | Link arrow / YL fire arrow (the flying projectile, per the decomp's `Link_Arrow`/`CLink_Arrow`) | — (**unverified in a replay**) |
| `0x42`–`0x49`, `0x4E` | Ness PK Fire, PK Flash, PK Thunder (head + trail) | — |
| `0x4A` / `0x4B` | Fox / Falco Blaster: **the gun, not a shot** | Fox 1525 / Falco 3349 |
| `0x4C` / `0x4D` | Link / YL bow (decomp `Link_Bow`; libmelee calls it "Link's Arrow") | — |
| `0x4F` / `0x50` | **Sheik needle thrown / held** | Sheik 2397 / 2875 |
| `0x51` / `0x52` | Pikachu / Pichu Thunder (down-B bolt) | Pikachu 256 |
| `0x53` / `0x54` | Mario cape / Doc sheet | Doc 1 (`0x54`) |
| `0x55` | Sheik Vanish smoke | Sheik 2384 |
| `0x56` | **Yoshi egg (thrown)** | — |
| `0x57` | Yoshi egg-lay (decomp `Yoshi_EggLay`, marked "???"; libmelee / py-slippi call it "tongue") | — |
| `0x58` | Yoshi star (down-B) | — |
| `0x59` / `0x5A` | **Pikachu Thunder Jolt** (decomp: ground / air) | Pikachu 96 / 44. A jolt keeps one type for its whole life |
| `0x5B` / `0x5C` | Pichu Thunder Jolt | — |
| `0x5D` | **Samus bomb** | — |
| `0x5E` | **Samus charge shot** | — |
| `0x5F` | **Samus missile** | — |
| `0x60` | Samus grapple beam | — |
| `0x61` | Sheik chain | Sheik 23 |
| `0x62` | Peach bomber explosion (decomp, "?") | — |
| `0x63` | **Peach turnip** | Peach 173 (faces 0:110, 1:23, 2:13, 3:10, 4:1, 5:9, 6:3, 7:4) |
| `0x64` | Bowser flame | — |
| `0x65` / `0x66` | Ness bat / yo-yo | — |
| `0x67` / `0x68` / `0x6F` | Peach parasol / Toad / Toad spore | Peach 96 / 1 / — |
| `0x69` | **Luigi fireball** | Luigi 3 |
| `0x6A` / `0x6B` / `0x71` | ICs ice / blizzard / belay rope | — |
| `0x6C` / `0x6D` | Zelda Din's Fire / explosion | — |
| `0x6E` | Mewtwo Disable | — |
| `0x70` | **Mewtwo Shadow Ball** | — |
| `0x72`–`0x7C` | G&W: `0x72` insecticide (jab), `0x73` manhole (dtilt), `0x74` torch (fsmash), `0x75` parachute (nair), `0x76` turtle (bair), `0x77` Sparky (uair), `0x78` Judge, `0x79` Oil Panic, `0x7A` Chef sausage, `0x7C` firefighter (up-B) | G&W 8 / 68 / 15 / 25 / 7 / 3 / 2 / — / 5 / 20 (each matches the move's action-state count) |
| `0x7B` | Young Link's milk (taunt) | — |
| `0x82`–`0x9D` | Kirby's copied projectiles | — |
| `0xD2` | Shy Guy (Yoshi's Story hazard) | 1245 × owner −1 |

**Counting gotchas:**
1. Every item appears on every frame it exists. Count a projectile **on its first frame** (a new `spawnId`).
2. Filter on **both** `owner` and the typeId's own character. A few first sightings had an unexpected owner: a needle owned by Fox, and a Falco laser owned by Peach and by Sheik, each once in 400 games. They're probably reflections or same-frame interactions (**unverified**).
3. Before 3.6.0 there's no `owner`. Attribute by character, which only works when the two players are different characters. Or count action-state entries instead (Fox/Falco Blaster 341/344, Sheik needle fire 344/348, Peach Vegetable 352).
4. Held items (`0x50` needle, `0x4A`/`0x4B` blaster) and afterimages (`0x38`/`0x39`) are not shots.

### B7. Action state ids (`post.actionStateId`)

**Common states** (0–340). Sources: the Slippi-linked Action State sheet [3], py-slippi `ActionState` [8], slippi-js `State` [1]. At id 341 the sheet notes that no general states are used from there on, only character-specific ones.

| Range / id | Name(s) | Use |
|---|---|---|
| 0–10 | DeadDown 0, DeadLeft 1, DeadRight 2, DeadUp 3, **DeadUpStar 4**, DeadUpStarIce 5, 6 (unused per sheet), **7** (screen KO: py-slippi `DEAD_UP_FALL_HIT_CAMERA`; the only non-star upward death in the scan, 30 times), 8–10 hit-camera / ice variants (sheet and py-slippi disagree on 7 vs 8) | `isDead()` = 0–10. Scan: 0 ×947, 1 ×227, 2 ×213, 4 ×215, 7 ×30 |
| 11 | Sleep / "nothing" state: the off-screen Zelda/Sheik, Nana during Sopo (sheet labels it Rebirth; py-slippi SLEEP) | Sopo detection (**unverified in a replay**) |
| 12, 13 | Rebirth (respawn halo), RebirthWait | Respawns |
| 14–23 | Wait, Walk ×3, Turn 18, TurnRun, Dash 20, Run, RunDirect, RunBrake | `isInControl` grounded range |
| 24 | KneeBend (jumpsquat) | Jumps; wavedash detection |
| 25–34 | Jump / fall states | |
| 35–37 | FallSpecial (helpless) | |
| 38 | DamageFall (tumble) | |
| 39–41 | Squat, SquatWait, SquatRv | Crouch / CC |
| 42, 43 | Landing, **LandingFallSpecial** (wavedash landing) | |
| 44–64 | Ground attacks (B2 table) | |
| 65–69 / 70–74 | Aerials / aerial landings | L-cancel window |
| 75–91 | Damage (hitstun) | `isDamaged()` |
| 178–182 | **GuardOn 178, Guard 179, GuardOff 180, GuardSetOff 181 (shield stun), GuardReflect 182** | 182 is entered often (Sheik 1757 times in 400 games), so it isn't only powershields; meaning **unverified** |
| 183–198 | Down states: **DownBoundU 183 / DownBoundD 191 = missed tech**, DownWait, **DownDamage 185/193 = jab reset**, getup options | `isDown()` |
| 199–204 | **Passive 199 (neutral tech), PassiveStandF 200, PassiveStandB 201, PassiveWall 202 (wall tech), PassiveWallJump 203 (wall jump *or* wall-tech jump), PassiveCeil 204** | `isTeching()` = 199–204 |
| 205–210, 211 | **ShieldBreak** fly / fall / down / stand; **FuraFura 211** (dizzy) | Shield breaks; Puff's 205 is a KO |
| 212–222 | Catch 212, CatchPull, CatchDash 214, CatchDashPull, CatchWait 216, CatchAttack 217 (pummel), CatchCut 218 (grab release), ThrowF 219, ThrowB 220, ThrowHi 221, ThrowLw 222 | Grabs and throws |
| 223–232 | Capture* (being held) | `isGrabbed()` |
| 233–236 | EscapeF / EscapeB (rolls), Escape (spotdodge), EscapeAir (airdodge) | |
| 239–243 | Thrown F / B / Hi / Lw / LwWomen | Being thrown |
| 244 | Pass (drop through a platform) | |
| **245, 246** | **Ottotto, OttottoWait (teeter)** | |
| 247–250 | FlyReflectWall (missed wall tech), FlyReflectCeil, **StopWall 249 (wall bonk)**, StopCeil | |
| 251 | MissFoot (shield slide-off) | |
| **252, 253** | **CliffCatch, CliffWait (ledge hang)** | Ledge grabs |
| 254–263 | Ledge getup slow/quick 254/255, ledge attack 256/257, ledge roll 258/259, **ledge jump 260–263 ("tournament winner")** | |
| **264, 265** | **AppealR, AppealL (taunt)** | Taunts |
| 266–270 | Shouldered (DK cargo) | |
| 275–304 | Command-grab captures: Falcon 275, Yoshi 276, **YoshiEgg 277**, Bowser 278–287, Kirby 288–292, BarrelWait 293, Bury 294–296, **DamageSong 297–299 (Sing)**, DamageBind 300, Mewtwo 301–304 | `isCommandGrabbed()` = 266–304 and 327–338, except 293 |
| 322–324 | Entry (start of the match) | |
| 341+ | **Character-specific**: see below | Read with the character |

**Character-specific states** (sheet [4]; "entries" = how often the scan saw each [10]):

| Character | States |
|---|---|
| Fox, Falco | Blaster 341–346 (ground start 341, air start 344); Illusion/Phantasm 347–352; Firefox/Firebird 353–359; **Reflector (shine): ground 360 start, 361 loop, 362 reflect, 363 end, 364 turn; air 365–369 likewise**; 370–375 a "smash taunt" (**unverified** in normal play). Scan: Fox entered 360 2342 times and 365 959 times |
| Jigglypuff | Extra jumps 341–345 (Jump 2–6); Rollout 346–362; **Pound 363 ground / 364 air**; **Sing 365–368**; **Rest: 369 ground L, 370 air L, 371 ground R, 372 air R** |
| Captain Falcon / Ganondorf | 341–346 unknown; **Falcon / Warlock Punch 347 ground, 348 air**; Raptor Boost / Gerudo Dragon 349–352; Falcon / Dark Dive 353–356 (355 = catch); Falcon Kick / Wizard's Foot 357–363 |
| Mr. Game & Watch | His own normals 341–352 (jab 341, jab 2 342, rapid 343–344, dtilt 345, fsmash 346, nair 347, bair 348, uair 349, landings 350–352); Chef 353/354; **Judgment 1–9 ground 355–363, air 364–372**; Fire 373/374; **Oil Panic 375 ground, 376 absorb, 377 spill; 378–380 air** |
| Peach | **Float 341**, float end 342/343, **float aerials 344 nair, 345 fair, 346 bair, 347 uair, 348 dair**; **fsmash 349 golf club, 350 frying pan, 351 tennis racket**; **Vegetable 352 ground**, 353 air (only from a run-off pull); Bomber 354–360; Parasol 361–364, 369/370; Toad 365–368 |
| Sheik | **Needle Storm** ground 341–344 (fire 344), air 345–348 (fire 348); **Chain 349–354**; Vanish 355–360; Transform 361–364 |
| Zelda | Nayru's Love 341/342; Din's Fire 343–348; Farore's Wind 349–354; Transform 355–358 |
| Samus | **Bomb jump 341/342**; Charge Shot 343–348; **Missile 349 ground, 350 super ground, 351 air, 352 super air**; Screw Attack 353/354; Bomb 355/356; Zair 357/358 |
| Marth (Roy the same, with his own names) | Shield Breaker 341–348; Dancing Blade 349–366; Dolphin Slash 367/368; **Counter 369 ground, 370 ground hit, 371 air, 372 air hit** |
| Mewtwo | **Shadow Ball 341–350** (fire 345/350); Confusion 351/352; Teleport 353–358; Disable 359/360 |
| Pikachu (Pichu the same) | **Thunder Jolt 341 ground, 342 air**; Skull Bash 343–352; Quick Attack 353–358; **Thunder 359–366** (hit 361/365) |
| Yoshi | **His shield is character-specific: 341–345**; Egg Lay 346–355; Egg Roll 356–363; **Egg Throw 364/365**; Bomb 366–368 |
| Ice Climbers | Ice Shot 341/342; Squall Hammer 343–346, 359/360; Belay 347–356, 361–365; Blizzard 357/358 |
| Link / Young Link | 341 fsmash 2; YL **taunt 342 R / 343 L**; Bow 344–349; Boomerang 350–355; Spin Attack 356/357; **Bomb 358/359**; Zair 360/361 |
| Mario / Dr. Mario / Luigi | Mario/Doc: fireball/pill 343/344, cape/sheet 345/346, up-B 347/348, tornado 349/350; Doc 341 = "Taunt R". Luigi: fireball 341/342, Green Missile 343–354, up-B 355/356, Cyclone 357/358 |
| DK / Bowser / Ness | DK: Kong Karry 351–368, Giant Punch 369–378, Headbutt 379/380, Spinning Kong 381/382, Hand Slap 383–385. Bowser: fire breath 341–346, **Koopa Klaw 347–358**, Whirling Fortress 359/360, Bomb 361–363. Ness: PK Flash 348–355, PK Fire 356/357, PK Thunder 358–366, PSI Magnet 367–375 |

**Helpers in slippi-js** (`State` enum + functions, all exported) [1]: `isDead` (0–10), `isDamaged` (75–91, 38, 185, 193), `isGrabbed` (223–232), `isCommandGrabbed`, `isTeching` (199–204), `isDown` (183–198), `isInControl` (14–24, 39–41, 45–64, 212), `didLoseStock`, `calcDamageTaken`.

### B8. Stage geometry: ledges, blast zones, "offstage"

From libmelee `stages.py` [9]. The edge values are symmetric (the left edge is the negative). The blast zones are credited there to Magus420.

| Stage (id) | Ledge-hang x (`EDGE_POSITION`) | Ground edge x (`EDGE_GROUND_POSITION`, teeter) | Blast zones (L, R, top, bottom) | Platforms (height; x range) |
|---|---|---|---|---|
| Battlefield (31) | 71.3078 | 68.4 | −224, 224, 200, −108.8 | sides 27.2; ±(20–57.6); top 54.4; −18.8…18.8 |
| Final Destination (32) | 88.4735 | 85.5657 | −246, 246, 188, −140 | none |
| Dream Land (28) | 80.1792 | 77.2713 | −255, 255, 250, −123 | sides ~30.1/30.2; L −61.39…−31.73, R 31.70…63.07; top 51.43; ±19.02 |
| Fountain of Dreams (2) | 66.2554 | 63.3475 | −198.75, 198.75, 202.5, −146.25 | sides move (height dynamic); ±(21–49.5); top 42.75; ±14.25 |
| Pokémon Stadium (3) | 90.6579 | 87.75 | −230, 230, 180, −111 | sides 25.0; ±(25–55) (neutral form) |
| Yoshi's Story (8) | 58.9078 | 56 | −175.7, 173.6, 168, −91 | sides 23.45; ±(28–59.5); top 42.0; ±15.75 |

**Practical rules.** None of these were tested against replays here:
- *Offstage* = `Math.abs(post.positionX) > EDGE_GROUND_POSITION[stage]`, or `post.positionY < -5` while `post.isAirborne`.
- *Hanging on the ledge* = 252/253, which needs no geometry.
- *Edgeguard kill* = the victim was offstage at the conversion's `startFrame` and the conversion `didKill`.
- Caveats: Fountain's side platforms move. Stadium transforms change the layout. Yoshi's Story's main stage slopes near the edges. `post.lastGroundId` names the last surface stood on, but its per-stage ids aren't documented here (**unverified**).

### B9. Frame fields useful for fun stats

**`post` (PostFrameUpdateType)**, read by slippi-js 6.7.0 [1], versions per the spec [2]:

| Field | Added | Use |
|---|---|---|
| `actionStateId`, `actionStateCounter` (0.2.0) | 0.1.0 | Everything in B7. The counter resets when an action repeats |
| `positionX/Y`, `facingDirection` (−1 / +1) | 0.1.0 | Offstage, centre stage, backstabs |
| `percent` | 0.1.0 | Kill percents, "Jackpot" |
| `shieldSize` (0–60) | 0.1.0 | Shield nearly broken, "Shield Saver" |
| `lastAttackLanded` | 0.1.0 | The attack id this player last landed (B5); 0 after death |
| `currentComboCount` | 0.1.0 | The game's own combo counter ("Combo King" averages it) |
| `lastHitBy` | 0.1.0 | Who last hit this player (the sentinel for "nobody" is **unverified**) |
| `stocksRemaining` | 0.1.0 | Stocks from the last frame (the `game-stats.js` gotcha) |
| `internalCharacterId` | 0.1.0 | **Internal** ids: Mario 0, Fox 1, Falcon 2, DK 3, Kirby 4, Bowser 5, Link 6, **Sheik 7**, Ness 8, **Peach 9**, Popo 10, Nana 11, Pikachu 12, Samus 13, Yoshi 14, Puff 15, Mewtwo 16, Luigi 17, Marth 18, **Zelda 19**, YL 20, Doc 21, Falco 22, Pichu 23, **G&W 24**, Ganon 25, Roy 26 [8]. A Zelda ⇄ Sheik switch changes it mid-game |
| `miscActionState` | 2.0.0 | Hitstun frames left while in hitstun |
| `isAirborne` | 2.0.0 | Air time ("Eagle") |
| `lastGroundId` | 2.0.0 | The surface last stood on |
| `jumpsRemaining` | 2.0.0 | "Acrobat" / "Aerialist" |
| `lCancelStatus` | 2.0.0 | 0 none, 1 success, 2 fail |
| `hurtboxCollisionState` | 2.1.0 | 0 vulnerable, 1 invulnerable, 2 intangible (ledge invincibility, intangible dodges) |
| `selfInducedSpeeds{airX,y,attackX,attackY,groundX}` | 3.5.0 | Speeds (a fastfall shows as a sharp drop in `y`; **heuristic**) |
| `hitlagRemaining` | 3.8.0 | Freeze frames ("big hit" moments) |
| `animationIndex` | 3.11.0 | Idle animation variants (Wait1/2/3) |
| *not read by 6.7.0:* State Bit Flags 1–5 (0x26–0x2A), `instanceHitBy`, `instanceId` | 2.0.0 / 3.16.0 | See below |

**State Bit Flags** (spec [2]), not exposed by slippi-js 6.7.0:

| Flags | Masks |
|---|---|
| Flags 1 | 0x02 absorber active (G&W bucket), 0x10 reflect active |
| Flags 2 | 0x08 **fastfalling**, 0x20 in hitlag |
| Flags 3 | 0x04 holding another character, 0x80 **shield active** |
| Flags 4 | 0x02 in hitstun, 0x20 **powershield active** |
| Flags 5 | 0x08 follower (Nana), 0x40 dead, 0x80 **offscreen** |

They can be read raw with `iterateEvents(openSlpFile(path), (cmd, payload, buf) => { if (cmd === 0x38) { const flags2 = buf[0x27]; … } })`: the callback gets the event's raw buffer, with the command byte at offset 0 (`slpReader.esm.js` [1]). The buffer is reused for every event, so read it inside the callback, and `closeSlpFile` afterwards. **Untested.**

**`pre` (PreFrameUpdateType)** [1][2]: `joystickX/Y`, `cStickX/Y` (processed, −1..1), `trigger` (processed 0..1), `buttons` (processed uint32), `physicalButtons` (uint16), `physicalLTrigger/RTrigger` (0..1), `rawJoystickX` (int8, 1.2.0), `percent` (1.4.0), plus `actionStateId`, positions and `seed`.

| `physicalButtons` mask | Button | `buttons` (processed) extra bits | Meaning |
|---|---|---|---|
| 0x0001 / 0x0002 / 0x0004 / 0x0008 | D-pad L / R / Down / **Up (the taunt button)** | 0x00010000–0x00080000 | Stick up / down / left / right |
| 0x0010 | Z | 0x00100000–0x00800000 | C-stick up / down / left / right |
| 0x0020 / 0x0040 | R / L digital | 0x80000000 | Any trigger |
| 0x0100 / 0x0200 | A / B | | |
| 0x0400 / 0x0800 | **X / Y** | | |
| 0x1000 | Start | | |

**Ice Climbers:** Nana is in `frames[f].followers[idx]` (`pre`/`post`, `isFollower: true`). Popo is in `players[idx]` [1][2].

### B10. Tested recipes

Run against local replays [10]:

```js
// One entry per spawn; first sighting carries owner/turnipFace/missileType.
function itemSpawns(frames) {
  const seen = new Map();
  for (const k of Object.keys(frames)) for (const it of frames[k].items ?? []) if (!seen.has(it.spawnId)) seen.set(it.spawnId, it);
  return [...seen.values()];
}
const owned = (spawns, idx, ...types) => spawns.filter((it) => it.owner === idx && types.includes(it.typeId));
// lasers = owned(spawns, i, 0x36, 0x37).length; stitch = owned(spawns, i, 0x63).filter((t) => t.turnipFace === 7).length

// Entries into an action state, counted like slippi-js (new state, or the counter going backwards).
function stateEntries(frames, idx, pred) {
  let n = 0, prev = null, prevCtr = null;
  for (const k of Object.keys(frames).map(Number).sort((a, b) => a - b)) {
    const p = frames[k].players?.[idx]?.post; if (!p) continue;
    const isNew = p.actionStateId !== prev || (prevCtr != null && p.actionStateCounter < prevCtr);
    if (isNew && pred(p.actionStateId, p)) n++;
    prev = p.actionStateId; prevCtr = p.actionStateCounter;
  }
  return n;
}
const isTaunt = (s) => s === 264 || s === 265;
const judgeNumber = (s) => (s >= 355 && s <= 372 ? ((s - 355) % 9) + 1 : null);   // G&W only

// How a stock was lost.
const DEATH = { 0: "bottom", 1: "left", 2: "right", 3: "up", 4: "star", 7: "screen" };

// Button presses (0→1 edges) from physical buttons.
function presses(frames, idx, mask) {
  let n = 0, prev = 0;
  for (const k of Object.keys(frames).map(Number).sort((a, b) => a - b)) {
    const b = frames[k].players?.[idx]?.pre?.physicalButtons ?? 0;
    if (b & mask && !(prev & mask)) n++; prev = b;
  }
  return n;
}
```

Cost: `getFrames()` plus a pass over every frame is ~0.4 s per game (400 games in 2.5 min in the scan). `fun-stats.js` runs this walk in the worker (`lib/set-stats/worker.js`, via `game-stats.js`).

---

## Sources

Primary sources were read directly unless marked otherwise. "Search" = taken from a web-search summary, not a page read.

1. slippi-js 6.7.0, as installed: `app/node_modules/@slippi/slippi-js/dist/` — `types.d.ts`, `stats/common.d.ts` + `common.esm.js` (State enum, Timers, helpers), `stats/actions.esm.js`, `stats/conversions.esm.js`, `stats/combos.esm.js`, `stats/overall.esm.js`, `stats/stocks.esm.js`, `stats/inputs.esm.js`, `melee/moves.esm.js`, `melee/moveUtils.esm.js`, `melee/animationUtils.esm.js`, `melee/types.d.ts`, `utils/slpReader.esm.js` (field offsets, `iterateEvents`), `utils/slpParser.esm.js` (items per frame), `SlippiGame.esm.js`. Runtime exports checked with `node`.
2. Slippi replay spec — https://github.com/project-slippi/slippi-wiki/blob/master/SPEC.md (Item Update, Post/Pre-Frame Update, State Bit Flags, buttons, Turnip Faces, Game End).
3. SSBM data sheet linked from the spec, "Character/Stage/Item IDs" (gid 20) and "Action State IDs" (gid 13) — https://docs.google.com/spreadsheets/d/1JX2w-r2fuvWuNgGb6D3Cs4wHQKLFegZe2jhbBuIhCG8/ (read as CSV export).
4. Character-Specific Action State IDs (spec-linked), one tab per character — https://docs.google.com/spreadsheets/d/1Nu3hSc1U6apOhU4JIJaWRC4Lj0S1inN8BFsq3Y8cFjI/ (CSV export of each tab).
5. Attack IDs (spec-linked), tabs Attack IDs / Non-Staling Attacks / Specials / Not Attacks — https://docs.google.com/spreadsheets/d/1spibzWaitiA22s7db1AEw1hqQXzPDNFZHYjc4czv2dc/
6. Melee decompilation, `ItemKind` enum — https://github.com/doldecomp/melee/blob/master/src/melee/it/forward.h
7. libmelee `enums.py` (`ProjectileType`, `Action`) — https://github.com/altf4/libmelee/blob/master/melee/enums.py
8. py-slippi `id.py` (`Item`, `ActionState`, `InGameCharacter`) — https://github.com/hohav/py-slippi/blob/master/slippi/id.py
9. libmelee `stages.py` (edges, blast zones, platforms) — https://github.com/altf4/libmelee/blob/master/melee/stages.py
10. Local empirical scan, 2026-11-11: 400 replays from the operator's Slippi folder (versions 3.17.0 / 3.19.1), read with slippi-js 6.7.0. The scan scripts were kept out of the repo.
11. SmashWiki, Wobbling — https://www.ssbwiki.com/Wobbling
12. SmashWiki, Ken combo — https://www.ssbwiki.com/Ken_combo
13. SmashWiki, Wombo Combo — https://www.ssbwiki.com/Wombo_Combo
14. Know Your Meme, Wombo Combo — https://knowyourmeme.com/memes/wombo-combo
15. SmashWiki, Sopo — https://www.ssbwiki.com/Sopo
16. SmashWiki, Amsah tech — https://www.ssbwiki.com/Amsah_tech
17. SmashWiki, John — https://www.ssbwiki.com/John
18. SmashWiki, Multishine — https://www.ssbwiki.com/Multishine
19. SmashWiki, Shine spike — https://www.ssbwiki.com/Shine_spike
20. SmashWiki, Captain Falcon (SSBM) — https://www.ssbwiki.com/Captain_Falcon_(SSBM)
21. SmashWiki, Knee Smash — https://www.ssbwiki.com/Knee_Smash
22. SmashWiki, Turnip (Melee faces, odds, item pulls) — https://www.ssbwiki.com/Turnip
23. SmashWiki, Plank — https://www.ssbwiki.com/Plank
24. SmashWiki, Stalling (the 60 ledge-grab limit in Melee majors) — https://www.ssbwiki.com/Stalling
25. Smashladder, Super Smash Bros. Melee ruleset ("Cliffhangers" > 60 forfeits on timeout; 15 in a 1-stock tiebreak) — https://www.smashladder.com/blogs/view/27mh/2022-09-18/super-smash-bros-melee-ruleset
26. Dexerto on Super Smash Con's Melee ledge-grab rule — https://www.dexerto.com/smash/super-smash-con-debat-major-rule-change-melee-834986 (search)
27. SmashWiki, Chain grab — https://www.ssbwiki.com/Chain_grab
28. SmashWiki, Chain (Sheik; Mew2King on ledge) — https://www.ssbwiki.com/Chain
29. Know Your Meme, No Items, Fox Only, Final Destination — https://knowyourmeme.com/memes/no-items-fox-only-final-destination (search)
30. Wikipedia, Armada (gamer) — https://en.wikipedia.org/wiki/Armada_(gamer)
31. Liquipedia, Armada (Young Link vs Hungrybox, first used at Pound V) — https://liquipedia.net/smash/Armada (search; the page refuses automated fetches)
32. Wikipedia, Hungrybox — https://en.wikipedia.org/wiki/Hungrybox
33. SmashWiki, HBox (bair blockades, "The Rest heard around the world") — https://www.ssbwiki.com/HBox
34. Wikipedia, Mang0 ("The Kid", comebacks) — https://en.wikipedia.org/wiki/Mang0
35. Wikipedia, Mew2King ("The Robot") — https://en.wikipedia.org/wiki/Mew2King
36. Wikipedia, Leffen ("God Slayer") — https://en.wikipedia.org/wiki/Leffen
37. SmashWiki, Five Gods — https://www.ssbwiki.com/Five_Gods
38. SmashWiki, Zain — https://www.ssbwiki.com/Smasher:Zain
39. SmashWiki, Axe — https://www.ssbwiki.com/Smasher:Axe
40. SmashWiki, aMSa ("I play to win" / "I pray to win") — https://www.ssbwiki.com/Smasher:aMSa
41. SmashWiki, Jmook — https://www.ssbwiki.com/Smasher:Jmook (nothing stat-related found)
42. SmashWiki, Pillar (Bombsoldier) — https://www.ssbwiki.com/Pillar
43. SmashWiki, Desynchronization — https://www.ssbwiki.com/Desynchronization
44. SmashWiki, Meteor cancel — https://www.ssbwiki.com/Meteor_cancel
45. SmashWiki, Float cancel — https://www.ssbwiki.com/Float_cancel
46. SmashWiki, Doraki walljump — https://www.ssbwiki.com/Doraki_walljump
47. SmashWiki, Jigglypuff (SSBM) (shield break KO, Rest, Wall of pain, Pound, Sing) — https://www.ssbwiki.com/Jigglypuff_(SSBM)
48. SmashWiki, Zero-to-death — https://www.ssbwiki.com/Zero-to-death
49. SmashWiki, Screen KO (Star KO vs Screen KO, the "Foresight" bonus) — https://www.ssbwiki.com/Screen_KO
50. SmashWiki, List of bonuses (Melee, 249 bonuses) — https://www.ssbwiki.com/Points
51. SmashWiki, Tournament Winner (ledge jump) — https://www.ssbwiki.com/Tournament_Winner
52. SmashWiki, Pound (tournament) — https://www.ssbwiki.com/Pound_(tournament)
53. SmashWiki, Tipper (no Melee damage figures given) — https://www.ssbwiki.com/Tipper
54. SmashWiki technique and move pages, **checked to exist but not read individually** (cited for the term only): Wavedash, Waveland, Dash dance, L-canceling, Crouch cancel, ASDI, Tech chase, Edgeguard, Self-destruct, Laser, Needle Storm, Super Missile, Charge Shot, Vegetable, Thunder Jolt, Shadow Ball, Egg Lay, Egg Throw, Judge, Oil Panic, Rest, Sing, Falcon Punch, Warlock Punch, Taunt, Wall of pain, Ledgedash, Shield pressure, Powershield, Spot dodge, Roll, Jab reset, Wall jump, Wall tech, Shield break, SHFFL, Meteor smash, Spike, Tech, Bomb jump, Star KO — all at `https://www.ssbwiki.com/<Name>`.

Search with no supporting result: "Mango SD" as a community meme (no affectionate, widely used source found); a Mew2King–Marth chaingrab signature (SmashWiki ties him to Sheik's chain instead [28]).
