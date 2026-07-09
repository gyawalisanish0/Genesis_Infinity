# `examples/` — Experience packages

Ready-to-play **Experience packages**. Each subdirectory here is a complete,
portable world you can play immediately or crack open to learn the format.

## Included experiences

Six original, self-contained experiences, one per genre — each a small,
complete world (one region, three connected locations, two characters) that
demonstrates the format for its genre:

| Package | Genre | Premise | Play as |
|---|---|---|---|
| [`blackline-action/`](blackline-action/) | Action | A rooftop infiltration of a corporate tower — the operative Kestrel vs. the security chief Warden. | `kestrel` |
| [`emberwood-fantasy/`](emberwood-fantasy/) | Fantasy | A forest lit by a buried fallen star; the apprentice Aldric reaches the hex-witch Morvath's shrine. | `aldric` |
| [`kepler-scifi/`](kepler-scifi/) | Sci-fi | A salvage dive on a dead orbital station guarded by a drone still running its last kill order. | `vega` |
| [`aoshima-romance/`](aoshima-romance/) | Romance | A seaside lantern festival, and one evening for Rin to find her words with Haru. *(Non-combat, dialogue-driven.)* | `rin` |
| [`blackmoor-medieval/`](blackmoor-medieval/) | Medieval | A fallen keep held by one knight, Sir Cedric, against the sellsword who took it. Steel and smoke, no magic. | `cedric` |
| [`neon-debt-cyberpunk/`](neon-debt-cyberpunk/) | Cyberpunk | A rain-slick sprawl chase — the netrunner Nyx owes the arcology, and Kade has come to collect. | `nyx` |

All six are original content (no third-party characters). See the note on
content & IP at the bottom.

## What's inside a package

Every Experience is a directory with the same three-part shape:

```
<experience>/
├── experience.json   # the manifest: identity, ruleset, tuning, cast placement
├── world.json        # the map: regions → nodes → connections
└── characters/       # one CharacterSheet per file
```

A `dtm.json` file appears next to these once a package has been played —
that's the derived event log, created on first run. It isn't authored and
isn't part of the shipped package.

## Playing one

From the repo root, point the CLI at a package directory and pick a character
to play:

```bash
npm run play -- \
  --experience examples/blackline-action \
  --model /path/to/model.gguf \
  --character kestrel
```

(Swap in `--backend api …` to play against a hosted model instead — see the
[root README](../README.md#quickstart).) You can also load a package from the
web client's Experiences dialog, including importing one as a `.zip`.

## Authoring your own

The three files above are the entire contract. Start from the
**[minimal complete example](../docs/EXPERIENCE_SCHEMA.md#a-minimal-complete-example)**
in the authoring guide, then grow it with a custom ruleset, techniques,
items, effects, and environmental hazards.

**Read [docs/EXPERIENCE_SCHEMA.md](../docs/EXPERIENCE_SCHEMA.md)** for the
full field reference and the cross-file contracts the loader enforces.

## A note on content & IP

The **engine** is MIT-licensed, but the **Experience content** here — the
worlds, characters, settings, and narrative — is © 2026 Sanish Gyawali, all
rights reserved, and is **not** covered by that license (see the
[root README](../README.md#license)). Study the packages to learn the format,
but the story IP itself isn't licensed for redistribution or reuse. Worlds
you author are, of course, entirely your own.
