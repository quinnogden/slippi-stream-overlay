# 012 (idea D) — Crew stock counts roll instead of jumping

- **Status**: DONE
- **Commit**: ada0741 (assumes plans 001–007 applied; independent of 008–011)
- **Severity**: LOW
- **Category**: Missed opportunities (state change that teleports)
- **Estimated scope**: 2 files, ~60 lines

## Problem

During a crew battle, each crew's card lists its members with their stocks
left, and the crew's total in the header. Any change rebuilds the whole list:

```js
/* overlays/side-panel/side-panel.js — renderCrew(), current */
  function renderCrew(i) {
    const panel = document.getElementById(`panel-crew-${i + 1}`);
    const team = crewView(i);
    if (!panel || !team) return;
    const name = panel.querySelector(".crew-name");
    name.textContent = team.name;
    panel.querySelector(".crew-total-num").textContent = String(team.total);

    const list = panel.querySelector(".crew-list");
    list.replaceChildren();
    const tags = [];
    for (const m of team.members) {
      const row = pill("crew-member " + m.status);
      const tag = h("span", "pill-name", m.tag);
      row.append(crewIcon(m.icon), tag, h("span", "crew-stocks", String(m.stocks)));
      list.appendChild(row);
      tags.push(tag);
    }
    fitText(name, 24);
    fitGroup(tags, 16);
  }
```

```js
/* refresh(), current */
    renderIfChanged("crew-1", crewView(0), () => renderCrew(0));
    renderIfChanged("crew-2", crewView(1), () => renderCrew(1));
```

Before plan 007 a stock lost while the card is up made the numbers jump;
after plan 007 it would re-cascade the entire roster for one number — too
much motion for a stock. The scoreboard already has the right motion for a
changing count: `Overlay.swap(el, key, render, { motion: "roll" })`, an
odometer tick inside a clipped box (`overlays/scoreboard/scoreboard.js:90-92`).

## Target

- When the same members are in the same order (ids match row by row) and no member's icon changed, the card on screen is **patched in place**: the total and each member's stocks roll (`motion: "roll"`), the active/in/out state classes update, a changed tag is rewritten (and the tags refitted together). Nothing cascades.
- Otherwise (members added/removed/reordered, an icon changed — e.g. a member played a new character) fall back to the full render, which plan 007 cascades on screen.
- Every stock number and the total are drawn through `Overlay.swap` with `motion: "roll"`, so the swap remembers what it shows. A fresh element's first swap is instant; the total (a persistent element) rolls on later full renders too.
- `.crew-stocks` and `.crew-total-num` clip their content (`overflow: hidden`) with `0.12em` of block padding cancelled by negative margin, so the roll is masked like the scoreboard's score and the glyph's shadow isn't cut.

## Repo conventions to follow

- `Overlay.swap` (`overlays/shared/overlay-client.js:325`): first call for an element is instant; later calls with a new key animate out → render → in; a burst coalesces to the newest.
- `renderIfChanged(key, slice, render, patch)` (from plan 007) — `patch()` returning `true` means "updated in place, don't cascade".
- Crew member view (`app/lib/crew/crew-model.js:230-241`): `{ id, tag, icon, stocks, status: "active" | "in" | "out", … }`.

## Steps

1. `overlays/side-panel/side-panel.css` — after the `.crew-stocks { … }` rule (ends line ~1165), add:
   ```css

   /* Clipped so a change rolls like the scoreboard's score (Overlay.swap
      "roll"); the padding keeps the glyph and its shadow inside the clip
      without moving it. */
   .crew-stocks,
   .crew-total-num {
     overflow:      hidden;
     padding-block: 0.12em;
     margin-block:  -0.12em;
   }
   ```

2. `overlays/side-panel/side-panel.js`:
   - Line 30: `const { h, fitText, fitGroup, icon, param } = Overlay;` → `const { h, fitText, fitGroup, icon, param, swap } = Overlay;`
   - Replace the whole `renderCrew(i)` function (with its doc comment) with:
     ```js
       /** A count that rolls when it changes, like the scoreboard's score (a new element's first draw is instant). */
       const rollNum = (el, n) => swap(el, String(n), (node) => { node.textContent = String(n); }, { motion: "roll" });

       /** A crew's card: its name and stocks left, then a row per member in roster order. */
       function renderCrew(i) {
         const panel = document.getElementById(`panel-crew-${i + 1}`);
         const team = crewView(i);
         if (!panel || !team) return;
         const name = panel.querySelector(".crew-name");
         name.textContent = team.name;
         rollNum(panel.querySelector(".crew-total-num"), team.total);

         const list = panel.querySelector(".crew-list");
         list.replaceChildren();
         const tags = [];
         for (const m of team.members) {
           const row = pill("crew-member " + m.status);
           row.dataset.memberId = String(m.id);
           row.dataset.icon = icon(m.icon) || "";
           const tag = h("span", "pill-name", m.tag);
           const stocks = h("span", "crew-stocks");
           row.append(crewIcon(m.icon), tag, stocks);
           rollNum(stocks, m.stocks);
           list.appendChild(row);
           tags.push(tag);
         }
         fitText(name, 24);
         fitGroup(tags, 16);
       }

       /**
        * The same members in the same order, wearing the same icons: update the
        * card in place — a stock lost rolls its number instead of rebuilding
        * (and re-cascading) the roster. False when the roster itself changed.
        */
       function patchCrew(i) {
         const panel = document.getElementById(`panel-crew-${i + 1}`);
         const team = crewView(i);
         const list = panel?.querySelector(".crew-list");
         if (!list || !team) return false;
         const rows = elementsOf(list);
         const same = rows.length === team.members.length && team.members.every((m, k) =>
           rows[k].dataset.memberId === String(m.id) && rows[k].dataset.icon === (icon(m.icon) || ""));
         if (!same) return false;

         const name = panel.querySelector(".crew-name");
         if (name.textContent !== team.name) { name.textContent = team.name; fitText(name, 24); }
         rollNum(panel.querySelector(".crew-total-num"), team.total);
         const tags = [];
         team.members.forEach((m, k) => {
           const row = rows[k];
           for (const s of ["active", "in", "out"]) row.classList.toggle(s, s === m.status);
           const tag = row.querySelector(".pill-name");
           if (tag.textContent !== m.tag) tag.textContent = m.tag;
           tags.push(tag);
           rollNum(row.querySelector(".crew-stocks"), m.stocks);
         });
         fitGroup(tags, 16);
         return true;
       }
     ```
   - In `refresh()`, replace:
     ```js
         renderIfChanged("crew-1", crewView(0), () => renderCrew(0));
         renderIfChanged("crew-2", crewView(1), () => renderCrew(1));
     ```
     with:
     ```js
         renderIfChanged("crew-1", crewView(0), () => renderCrew(0), () => patchCrew(0));
         renderIfChanged("crew-2", crewView(1), () => renderCrew(1), () => patchCrew(1));
     ```

## Boundaries

- Only these two files, only the crew card. Do NOT change the roster's look, the crew rotation, `crewIcon()`, or the scoreboard.
- Do NOT add tests or dependencies. Do NOT edit docs.
- If a quoted block doesn't match, STOP and report.

## Verification

- **Mechanical**: `node tests/run.js` passes — especially `side-panel.test.js` "crew battle: the logos and the two rosters only…" (its texts must still read e.g. `["ACRES", "5", "Stocks"]` and `"Zodd 2"`).
- **Feel check** (start a crew battle from the dock's Crew tab; hold the card with `/o/side-panel?panel=crew-1`): press the strip's − for the player in: their stock count and the crew total tick down like an odometer; nothing else on the card moves. Send a different member in: the lit row moves, no cascade. Add a member from the Crew tab: the card re-cascades (roster changed).
- **Done when**: stock changes roll in place, roster changes still rebuild, tests pass.
