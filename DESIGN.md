---
name: JARVIS
description: A full-screen autonomous-agent control environment. Void-black canvas, a single electric-cyan accent, and a layered 3D intelligence core as the visual hero. HUD panels are angular clipped instruments with hairline illuminated borders — never rounded SaaS cards. Every readout is real agent telemetry; unavailable values render as an em dash rather than being invented.
---

## Tokens

```
--j-void   #04070d   canvas
--j-deep   #070c15
--j-panel  #080e1a

--j-accent #35e0ff   single accent — all interactive + structural chrome
--j-ok     #38e08a   completed
--j-warn   #ffb020   retrying / stopping / throttled
--j-bad    #ff4d5e   failed
--j-dormant #5a6a7d  idle / stopped / unavailable

--j-ink  #e8f5fb  --j-body #93aec0  --j-mute #5d7488
--j-mono ui-monospace…   --j-sans ui-sans-serif…
--j-cut  9px      angular corner cut
```

**Colour rule.** One accent, locked. Semantic colours are earned by real agent
outcomes only — never used decoratively. Phase tone propagates to every panel
border simultaneously, so the whole instrument set responds to state, not just
the core.

## Type

Monospace carries all telemetry (`.j-num`, `tabular-nums`) so digits never
jitter as values tick. Micro labels are 10.5 px uppercase at 0.14em tracking
(`.j-label`). Body copy is 12.5–13.5 px. No serif. No display face.

## HUD panels

Angular clip (`.j-clip`) + 1 px gradient shell (`.j-frame`) + corner markers +
lit top bevel + fine grid texture. Fill is `rgba(8,17,29,0.90)` — deliberately
above the void so panels read as surfaces, not film. A sweep line appears only
on panels bound to live execution.

## Motion

Three tiers, per the brief:

- **Ambient** — always on: slow orbit drift, particle flow, starfield rotation.
- **State** — eased toward a per-phase behaviour contract (`BEHAVIOUR` in
  `JarvisCore3D.tsx`): spin, orbit rate, particle direction, scan, arcs,
  breathe, camera distance.
- **Transition** — a one-shot `burst` on every real state change, decaying over
  ~0.6 s, plus `.j-enter` / `.j-wave` on the result panel.

Colour and behaviour are **lerped**, never cut, so phase changes read as motion.
Only `transform` / `opacity` are animated in CSS. `prefers-reduced-motion`
freezes rotation, breathing, parallax, and all keyframes.

## 3D layers

```
0 starfield        4 three independent orbit systems + rider arcs
1 platform grid    5 orbiting data nodes
2 lat/long shell   6 GPU particle streams (shader-driven)
3 nucleus+fresnel  7 energy arcs + vertical scan ring
```

Geometry and materials are built once and disposed on unmount. Per-frame work is
refs and uniform writes only — no React state, no allocations in the loop.
Particle motion is entirely in the vertex shader (`uTime`/`uFlow`), so
convergence during `planning` costs nothing on the CPU.

Camera fits the space actually left for the core: at ≥1024 the rails occupy the
flanks, so the fit divides by the centre width, not the viewport width.

## Data honesty

Only render what the backend reports. Real: OmniRoute status + `latencyMs`,
task ID, step number, event tallies (`router.retry`, `agent.recovery`,
`agent.action.failed`, `agent.observing`), browser URL/title/status, duration,
steps, tokens. `model` / `provider` are rendered **only if** present on
`TaskMetrics` — they are currently never populated, so that block stays hidden
rather than showing placeholder values.

## Breakpoints

| Width | Layout |
|---|---|
| `<768` | core + command deck + collapsed trace; DPR ≤1.25, 700 particles |
| `768–1023` | as above, wider deck; DPR ≤1.75, 1500 particles |
| `1024–1439` | both instrument rails at 268 px; 2600 particles |
| `≥1440` | rails at 300 px |

## Anti-patterns

No purple. No rounded SaaS cards. No glassmorphism-for-its-own-sake. No
chromatic aberration. No infinite CSS pulsing. No fabricated telemetry. No
unlayered global resets — they outrank Tailwind v4 utilities and silently break
them.
