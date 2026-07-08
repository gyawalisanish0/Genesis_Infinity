# Genesis Infinity — Brand

The visual and verbal identity of Genesis Infinity. Keep new surfaces
(docs, UI, READMEs, release notes) consistent with what's defined here.

---

## Essence

**Genesis Infinity is an engine for worlds that run themselves.** You author
the world, its characters, and its rules; the engine runs the turns,
adjudicates every action, and keeps the story consistent. The name pairs
*genesis* (creation, a beginning) with *infinity* (endless worlds, endless
play).

**Tagline:** *Author the world. The engine plays it.*

Use the tagline under the wordmark on landing surfaces (root README, the
app's disconnected state). Don't reword it per surface — it's fixed.

---

## Wordmark

The wordmark is the full name **GENESIS INFINITY** set in the display
typeface, with **every letter "I" rendered as a vertical glyph** — a thin
luminous pillar in the brand gradient. The pillars read as sparks/axes of
creation standing inside the name.

```
GENES│S  INF│N│TY
```
*(the `│` marks stand in for the four glyph-`I`s: one in GENES·I·S, three in
INF·I·N·I·TY)*

Rules:
- Every "I" — all four — becomes a glyph. Never some but not others.
- The glyph is a vertical bar filled with the violet→cyan gradient
  (`--brand-violet` at top, `--brand-cyan` at bottom), slightly taller than
  cap height.
- The rest of the letters use `--text-primary` (near-white).
- The wordmark is always accessible: the underlying text is still the real
  string "Genesis Infinity" (the glyph is styling, not an image), and the
  element carries `aria-label="Genesis Infinity"`.

In the app this appears as the topbar brand mark (see `.brandmark` /
`.brandmark .gi` in `frontend/style.css`). In plain-text contexts (CLI
banners, commit trailers) just write "Genesis Infinity".

---

## Color

Dark-first. The base is a warm near-black; the identity color is a
violet→cyan cosmic gradient.

| Token | Hex | Use |
|---|---|---|
| `--page` | `#0d0d0d` | App background. |
| `--surface` | `#1a1a19` | Bars, panels. |
| `--surface-raised` | `#232322` | Inputs, raised tiles. |
| `--brand-violet` | `#7c5cff` | Primary accent — buttons, active states, the glyph top. |
| `--brand-cyan` | `#22d3ee` | Secondary accent — links, highlights, the glyph bottom. |
| `--accent` | `#7c5cff` | Alias of `--brand-violet` (existing components reference `--accent`). |
| `--text-primary` | `#ffffff` | Primary text, wordmark letters. |
| `--text-secondary` | `#c3c2b7` | Secondary text. |
| `--text-muted` | `#898781` | Muted/meta text. |

The **brand gradient** is `linear-gradient(180deg, #7c5cff, #22d3ee)` —
used for the glyph, and sparingly for accent flourishes (a hairline under
the wordmark, focus rings). Don't flood large areas with it; it's a signature,
not a background.

Status colors (HP meter, connection dots) are unchanged and independent of
the brand accent: good `#0ca30c`, warning `#fab219`, serious `#ec835a`,
critical `#d03b3b`.

---

## Typography

- **Display (wordmark, headings):** **Space Grotesk** — a geometric sans with
  character. Loaded from Google Fonts at the app root (`frontend/index.html`),
  with a `system-ui` fallback so nothing breaks if the font is blocked or
  offline.
- **Body / UI:** `system-ui, -apple-system, "Segoe UI", sans-serif` — fast,
  native, unchanged.

Headings use Space Grotesk with tight tracking; body stays system sans for
legibility and zero cost.

---

## Voice

Three principles, in priority order:

1. **Precise.** It's an engine — say what it does, name the mechanism, skip
   the hype. "The engine runs the turns and adjudicates actions" beats
   "unleash limitless adventures."
2. **Evocative.** It's for storytelling — examples and copy should read like
   the worlds it builds. A node description in a doc can have atmosphere.
3. **Creator-first.** Speak to authors building worlds, not only to
   developers reading code. Lead with what a creator can make, then how.

Avoid: exclamation-driven marketing, "revolutionary/next-gen" filler,
walls of jargon before the reader knows what the thing is.

---

## Favicon / logomark

The compact mark is the infinity glyph **∞** rendered in the brand gradient
(or, where a single emoji is required, ♾️). It stands in for the wordmark at
small sizes (browser tab, topbar on narrow screens).
