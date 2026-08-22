# Theme Forge Terminal Nova brand assets

## Mark ownership and software-license separation

Copyright (c) 2026 Samuel Leighton Lair and Knowledge Forge AI contributors.

The Nova Ingot symbol, lockups, and favicon artwork are project brand assets.
They are not automatically licensed under the project's software license unless
a separate brand license expressly says so. Distribution of source code under
GNU Affero General Public License v3.0 or later, MIT License or another
open-source license does not by itself grant trademark rights or permission to
imply endorsement.

## Upstream-brand separation

Theme Forge Terminal Nova is a maintained fork of Starlight Theme Terminal but
uses an independent visual identity.

The upstream rounded terminal-window mark and its face-like expression are not
part of this brand. Do not reproduce, adapt, combine, or imply continuity with
that upstream symbol in Theme Forge Terminal Nova assets.

## Lettering status

The Theme Forge Terminal Nova wordmark uses custom geometric uppercase
lettering created specifically for the project. The lettering is stored as
closed SVG path geometry and has no dependency on an external font.

The lettering paths, Nova Ingot mark, favicons, and complete lockups are Theme
Forge Terminal Nova brand assets governed by the project's brand-use policy.
They are not separately released as a font or under CC0.

## Approved production assets

### Full-color marks

- `theme-forge-terminal-nova-mark-on-light.svg`
- `theme-forge-terminal-nova-mark-on-dark.svg`

### Horizontal lockups

- `theme-forge-terminal-nova-horizontal-on-light.svg`
- `theme-forge-terminal-nova-horizontal-on-dark.svg`

### Stacked lockups

- `theme-forge-terminal-nova-stacked-on-light.svg`
- `theme-forge-terminal-nova-stacked-on-dark.svg`

### Monochrome marks

- `mark-monochrome-light.svg` — Warm White artwork for dark surfaces
- `mark-monochrome-dark.svg` — Near Black artwork for light surfaces

### Favicons

- `favicon-on-light.svg`
- `favicon-on-dark.svg`

Use the surface-specific asset rather than expecting one transparent file to
work on every background.

## Permitted usage

Theme Forge Terminal Nova brand assets may be used:

- in the official project repository, website, documentation, package pages,
  release notes, and social accounts;
- in factual articles, tutorials, compatibility listings, and community pages
  referring to the project;
- at unmodified proportions and in the approved light, dark, full-color, or
  monochrome treatments;
- with enough surrounding space to keep the mark distinct from nearby content.

Usage must not imply sponsorship, certification, partnership, or official
status without authorization.

## Minimum sizes

Recommended digital minimums:

- standalone full mark: 24 px;
- favicon: 16 px using the dedicated favicon files;
- horizontal lockup: 240 px wide;
- stacked lockup: 160 px wide.

Recommended print minimums:

- standalone mark: 8 mm wide;
- horizontal lockup: 55 mm wide;
- stacked lockup: 38 mm wide.

Below these sizes, use the standalone mark or dedicated favicon rather than
compressing a full lockup.

## Clear space

Maintain clear space of at least **one-sixth of the mark width** on every side.

For lockups, apply the same measurement using the displayed mark inside the
lockup. No text, rule, border, crop, or competing graphic should enter this
area.

## Color palette

- Molten Orange: `#FF8A3D`
- Intermediate Rose: `#E45A9E`
- Deep Violet: `#8B5CF6`
- Gunmetal: `#262A33`
- Warm White: `#FFF8F0`
- Near Black: `#111318`
- Black: `#000000`

The gradient direction is Molten Orange → Intermediate Rose → Deep Violet.
Flat Molten Orange is the approved small-size fallback for the dark favicon.

## Prohibited modifications

Do not:

- redraw or substantially alter the approved Nova Ingot silhouette;
- change the six-facet enclosure or replace the four-point nova;
- add terminal faces, prompt symbols, `>_`, `>_<`, brackets, windows, or mascots;
- add circuit traces, dots, engraving, texture, scratches, bevels, shadows,
  metallic rendering, or glow effects;
- rearrange or respell Theme Forge or Terminal Nova;
- distort, rotate, skew, crop, stretch, or outline the mark;
- recolor the assets outside approved full-color or monochrome treatments;
- place the on-light asset on a dark surface, or the on-dark asset on a light
  surface, when contrast is insufficient;
- place the identity inside a permanent rounded-square container;
- combine it with the inherited upstream visual identity.

## Production notes

All distributed SVGs use transparent canvases and vector geometry only. They
contain one accessible title and description, collision-safe IDs, and no
external dependencies.

The files in `dist/` are flattened production outputs. The builder retained in
`source/` is the editable parametric source. The favicon uses dedicated small-size
geometry rather than mechanically scaling the full mark.
