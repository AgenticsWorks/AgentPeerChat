# AgentPeerChat brand icon redesign — "Peer Bot" avatar

## The mark

A chibi robot head — the **Peer Bot** — centered on a near-black squircle tile.

It is the smallest possible "agent you'd want to talk to":

- **Face**: mint gradient (`#63EAB1 → #47CE94`, around the site accent `#55e0a5`) on
  the site's card color `#0B100D`, with a hairline `rgba(255,255,255,.09)` tile border
  so the tile keeps its edge on any background.
- **Eyes**: two vertical dark capsules (`#0A0F0C`) with white specular highlights —
  the classic anime "alive" cue. They are the load-bearing shapes at favicon size.
- **Smile + blush**: a small filled crescent and two dim mint cheek dots carry the
  cartoon charm at 64 px and above.
- **Ear pods**: darker-mint (`#2EA87B`) capsules flanking the head — a headset vibe,
  "always on the line".
- **Antenna speech bubble**: the antenna terminates in a tiny speech bubble with an
  ellipsis (typing dots). This is the product tie: a peer that is always mid-message.
  The bubble reads as a simple antenna tip at 16–32 px and reveals its detail at 180 px+.

## Palette

| Role | Value | Origin |
| --- | --- | --- |
| Tile | `#0B100D` | site `--card` |
| Face / bubble | `#63EAB1 → #47CE94` | site `--accent` `#55e0a5` family |
| Details (pods, cheeks, stem) | `#2EA87B` | accent, darkened |
| Eyes / smile / typing dots | `#0A0F0C` | site ink-dark (`#0a0f0c`) |

The old forest-green tile (`#173F35`) and the lime (`#DDF0BD`) + peach (`#F4A77C`)
bubble duo are gone. Mint is the only accent, matching the redesigned dark site.

## Size behavior

- **16 px favicon**: dark tile + mint face + two eye capsules stay clearly readable
  (verified via renders at 16/32 px).
- **32 px**: eyes, smile, ear pods and antenna bubble resolve.
- **180 px apple-touch / 512 px PWA**: highlights, blush, typing dots all land.

## Files

- `icon.svg` — source of truth (also copied to `website/assets/icon.svg`,
  `website/assets/app-icon.svg`, `public/icon.svg`, `public/app-icon.svg`,
  `website/assets/orbit/agentpeerchat-ff97fe1c56fe.svg`, both `wordmark.svg` files).
- `icon-16/32/64/180/512.png` — renders for review; `180/192/512` are committed to
  `website/assets/` and `public/` as before.
- `avatar-face.svg` + `avatar-face-512.png` — the character without the tile, for
  large previews and any non-squircle usage.

## How PNGs are generated

Each size is rasterized directly from `icon.svg` with headless Chrome
(`Emulation.setDeviceMetricsOverride` + `Page.captureScreenshot` with transparent
background), so the vector is re-anti-aliased per size rather than downsampled.
Corners are alpha-transparent, matching the previous assets.
