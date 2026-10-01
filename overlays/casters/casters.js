/**
 * Caster name tags, from the store's `casters` section:
 * [{ tag, prefix, pronoun, twitter }]. `?i=N` shows only caster N.
 *
 * Cards are kept once made; a caster with no tag hides its card (it leaves
 * rather than cutting), and filling the tag back in brings it back in.
 */
(function () {
  "use strict";

  const { h, text, swap, presence, squeeze } = Overlay;
  const ov = Overlay.connect({ tag: "casters" });

  const only = Overlay.param("i");
  const pinned = only !== null && /^\d+$/.test(only) ? Number(only) : null;

  const row = document.querySelector(".casters");
  const cards = [];
  let drawn = false;

  function card(i) {
    if (cards[i]) return cards[i];
    const el = h("div", "caster empty");
    // A card made after the first draw has no page entrance to ride: start
    // it hidden, so showing it animates in.
    if (drawn) presence(el, false);
    const mic = h("div", "mic");
    mic.append(h("span", "mic-icon"));
    const name = h("div", "name");
    name.append(h("span", "text"));
    const chip = h("div", "pronoun empty");
    chip.append(h("span", "text"));
    el.append(mic, name, chip);
    row.append(el);
    return (cards[i] = el);
  }

  ov.select("casters", (list) => {
    list = list || [];
    const indices = pinned !== null
      ? [pinned]
      : Array.from({ length: Math.max(list.length, cards.length) }, (_, i) => i);

    for (const i of indices) {
      const c = list[i] || {};
      const el = card(i);
      presence(el, !!c.tag);
      if (!c.tag) continue;

      swap(el.querySelector(".name .text"), JSON.stringify([c.prefix, c.tag]), (node) => {
        node.replaceChildren();
        if (c.prefix) node.append(h("span", "sponsor", c.prefix));
        node.append(h("span", "tag", c.tag));
        squeeze(node);
      });
      const chip = el.querySelector(".pronoun");
      text(chip.querySelector(".text"), c.pronoun, { emptyOn: chip });
    }
    drawn = true;
  });
})();
