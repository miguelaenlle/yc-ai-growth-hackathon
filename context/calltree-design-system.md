# CallTree — design system

The visual language for the CallTree frontend. The product is an **instrument** for
reading sales calls: a dark canvas where the only loud color is the win-rate/EV signal,
so the eye always goes to "how good is this path." Everything else stays neutral and calm.

> Companion to [`calltree-product-overview.md`](calltree-product-overview.md) (what we're
> building) and [`calltree-api-contract.md`](calltree-api-contract.md) (the data). This file
> governs how it looks.

## 1. Principles

1. **One signal color.** Red → amber → green is reserved for win-rate / EV. It is the only
   saturated color in the UI, so it always means the same thing: how good is this path.
2. **One cool accent.** A single teal / electric-blue for interactive & AI elements
   (selected node, live indicators, primary buttons). Used sparingly — it never competes
   with the signal ramp.
3. **Everything else is neutral.** Grays carry structure, text, and chrome.
4. **Flat and sharp.** Thin hairline borders, subtle elevation, small radii. No big
   shadows, no gradients, no bubbliness.
5. **Dense but calm.** Tight spacing and lots of small labels, but a clear hierarchy so the
   tree canvas breathes.

## 2. Color

### Canvas & neutrals (dark theme, default)

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#0D1014` | Near-black app canvas — makes the EV spectrum pop |
| `--surface` | `#141920` | Panels, cards, node bodies |
| `--surface-2` | `#1B212A` | Raised surface (hover, popovers, headers) |
| `--border` | `#222A34` | Hairline borders (1px) |
| `--border-strong` | `#2E3845` | Dividers, focused field outlines |
| `--text` | `#E6EAF0` | Primary text |
| `--text-muted` | `#9AA5B1` | Secondary text, labels |
| `--text-faint` | `#5C6673` | Tertiary — captions, disabled, placeholder |

### Signal ramp — win-rate / EV (the ONLY loud color)

Map `successProbability` (0→1) along this ramp; reuse for EV since `expectedValue =
round(successProbability * 48000)`.

| Stop | Hex | Meaning |
|---|---|---|
| `--signal-low` | `#E5484D` | Red — low win-rate / low EV |
| `--signal-mid` | `#F5A623` | Amber — middling |
| `--signal-high` | `#30A46C` | Green — high win-rate / high EV |

Interpolate in between (0.0 = red, 0.5 = amber, 1.0 = green). Keep nodes' fill neutral and
let this ramp drive **borders, the EV figure, and a thin status bar** on each node so the
spectrum reads across the whole tree at a glance.

### Accent — interactive / AI (cool, sparing)

| Token | Hex | Use |
|---|---|---|
| `--accent` | `#3DD6D0` | Teal/electric-blue — selected node, live dots, primary buttons, focus |
| `--accent-quiet` | `#1E3A3A` | Accent-tinted fill for selected/active backgrounds |

> Rule of thumb: if it's clickable, live, or AI-driven, it can carry the accent. If it's
> communicating quality, it carries the signal ramp. Nothing else is saturated.

## 3. Typography

| Role | Font | Notes |
|---|---|---|
| UI / body | **Inter** | Primary geometric sans for all interface text |
| Data | **JetBrains Mono** | Numbers, percentages, IDs, transcript timestamps, EV figures — the mono on data is what sells the "instrument" feel |
| Logo / wordmark | **Space Grotesk** | The CallTree logo only |

- Use the mono for *any* figure that's a measurement: `$45,600`, `72%`, `call_convex`,
  `17:04:12`. This is deliberate and consistent — measurements always look like measurements.
- Type scale (tight): 11 / 12 / 13 / 14 (base) / 16 / 20 / 28. Small labels at 11–12 in
  `--text-muted`, often uppercase with slight letter-spacing.
- Weights: 400 body, 500 labels/UI emphasis, 600 headings. Avoid heavier — keep it calm.

## 4. Shape, elevation & spacing

- **Radii:** 6–8px on cards, nodes, buttons, inputs. Nothing more rounded. `0` for hairline
  dividers and inline tags if they read better sharp.
- **Borders:** 1px hairline `--border` everywhere; `--border-strong` for dividers and
  focused inputs. Borders do most of the structural work — not shadows.
- **Elevation:** subtle only. e.g. `0 1px 2px rgba(0,0,0,0.4)` for popovers/menus. No large,
  soft, or colored shadows. No gradients.
- **Spacing:** tight 4px base grid (4 / 8 / 12 / 16 / 24). Dense panels, but give the tree
  canvas generous breathing room so it remains the focal point.
- **Focus:** 1px `--accent` outline (or ring) — visible but quiet.

## 5. Component cues

- **Tree node:** neutral `--surface` body, hairline border, a thin signal-colored bar/edge
  driven by `successProbability`, EV shown in JetBrains Mono. Selected → `--accent` border +
  `--accent-quiet` tint.
- **Buttons:** primary = `--accent` fill on dark text or accent outline; secondary =
  neutral hairline. Small radius, flat.
- **Live indicator:** small pulsing `--accent` dot.
- **Labels & tags:** 11–12px mono or uppercase sans in `--text-muted`, hairline-bordered
  chips, sharp or 6px.
- **Transcript:** timestamps in JetBrains Mono `--text-faint`; speaker text in Inter.

## 6. Fonts — loading

Inter, JetBrains Mono, and Space Grotesk are all on Google Fonts. Load via `<link>` in
`index.html` or `@import`/`@fontsource` — only the weights above. Wire the three into the
Tailwind theme as `font-sans` (Inter), `font-mono` (JetBrains Mono), and a `font-logo`
(Space Grotesk) utility.
