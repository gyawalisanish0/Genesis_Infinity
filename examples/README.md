# `examples/` — Experience packages

Ready-to-play **Experience packages**. Each subdirectory here is a complete,
portable world you can play immediately or crack open to learn the format.

## What's inside a package

Every Experience is a directory with the same three-part shape:

```
<experience>/
├── experience.json   # the manifest: identity, ruleset, tuning, cast placement
├── world.json        # the map: regions → nodes → connections
└── characters/       # one CharacterSheet per file
```

A `dtm.sqlite` file appears next to these once a package has been played —
that's the derived event log, created on first run. It isn't authored and
isn't part of the shipped package.

## Playing one

From the repo root, point the CLI at a package directory and pick a character
to play:

```bash
npm run play -- \
  --experience examples/goku-vs-venom \
  --model /path/to/model.gguf \
  --character goku
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
