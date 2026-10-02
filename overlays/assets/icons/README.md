# Stock icons

Every costume for all 26 Melee characters, used by the scoreboard, the bracket and the dock's character picker.

## File names

```text
chara_2_{codename}_{NN}.png
```

| Part | Meaning | Example |
|---|---|---|
| `codename` | The character's codename from [`app/lib/char_map.js`](../../../app/lib/char_map.js) | `fox`, `captain_falcon` |
| `NN` | Slippi's `characterColor` (the costume), zero-padded to two digits | `00`, `03` |

So Fox's default costume is `chara_2_fox_00.png`.

> [!NOTE]
> **One rename from TSH:** Game & Watch is `game_and_watch` here, not TSH's `game_&_watch`. This matches `char_map` and keeps `&` out of URLs.

## Where they came from

Copied from TSH's `user_data/games/ssbm/base_files/icon/`, keeping only Melee's characters. TSH credits them as downloaded from [spriters-resource.com](https://www.spriters-resource.com).

`tests/icons.test.js` checks that every character and costume Slippi can report has an icon here.
