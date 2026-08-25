# JARVIS DESIGN BRIEF

Based on deep study of downloaded design resources: taste-skill, vercel-labs/agent-skills, awesome-design-md.

---

## Visual Character

Operational, precise, premium. JARVIS is a serious autonomous agent controller—not a chatbot, not an entertainment interface, not a game. The aesthetic draws from:
- **Taste-Skill Creativity Level 8:** Clean with personality, balanced density
- **Stripe Dashboard Philosophy:** Dark shell for operational dashboards with high-contrast data
- **Superhuman Execution Precision:** Every element earns its place through function

Think: **control room operator interface**, not **AI marketing landing page**.

No purple neon gradients. No Sentry-style playfulness. No sleek-but-empty surfaces.

---

## Typography

**System Fonts (No Custom Fonts Required)**
- Display: `-apple-system`, `system-ui`, fallback to `San Francisco` / `Segoe UI` / Helvetica
- Body: Same system stack, weight-driven hierarchy
- Mono: `ui-monospace`, fallback to `Courier New`
- Banned: Inter, any serif, custom display fonts

**Font Weights for Hierarchy:**
- Headers: 600–700 (bold, not bigger)
- Labels: 600 (semibold uppercase)
- Body: 400 (regular)
- Annotations: 400 italic or 500 (muted color)

**Sizes:**
- Page title: 28px / 1.75rem
- Section header: 14px / 0.875rem (uppercase, semibold)
- Body: 14px / 0.875rem (line-height 1.6)
- Metadata/mono: 12px / 0.75rem (tabular figures for numbers)

**Line Heights:**
- Headers: 1.2
- Body: 1.6
- Mono/metrics: 1.4

---

## Color Palette

**Light Mode (Default)**
- Canvas: #ffffff (clean background)
- Text Primary: #0f172a (slate-900, never pure black)
- Text Secondary: #475569 (slate-600, annotations)
- Text Tertiary: #94a3b8 (slate-400, timestamps, disabled)
- Borders: #e2e8f0 (slate-200, structural)
- Accent (action): #3b82f6 (blue-500, buttons, links)
- Success: #10b981 (emerald-600, completion, checkmarks)
- Warning: #f59e0b (amber-500, retries, degraded)
- Error: #ef4444 (red-600, failures)
- Surface (card/panel): #f8fafc (slate-50, subtle elevation)

**Dark Mode**
- Canvas: #0f172a (slate-900)
- Text Primary: #f1f5f9 (slate-100)
- Text Secondary: #cbd5e1 (slate-300)
- Text Tertiary: #64748d (slate-500)
- Borders: #334155 (slate-700)
- Accent: #3b82f6 (same blue)
- Success: #10b981 (same emerald)
- Warning: #f59e0b (same amber)
- Error: #ef4444 (same red)
- Surface: #1e293b (slate-800)

**Banned Colors:**
- Pure black (#000000)
- Neon gradients
- Purple/violet for primary actions
- Oversaturated accents (>85% saturation)
- Mixed warm/cool grays

---

## Spacing

**Base Unit:** 4px (via Tailwind spacing scale)

**Vertical Spacing (sections):**
- Between major sections: `clamp(2rem, 5vw, 4rem)` (responsive)
- Between cards: `1.5rem`
- Between items in a list: `0.75rem`

**Horizontal Padding:**
- Desktop (1440px+): `2rem`
- Tablet (768px): `1.5rem`
- Mobile (< 768px): `1rem`

**Internal Component Padding:**
- Card/panel interior: `1.5rem`
- Button: `0.75rem vertical`, `1rem horizontal` (responsive to `0.5rem / 0.75rem` on mobile)
- Input/control: `0.5rem padding`, `0.75rem gap` between label-input-error

**Touch Targets:** All interactive elements minimum `44px` (mobile)

---

## Layout

**Grid-First Architecture (CSS Grid, never Flexbox percentage math):**
- Desktop: max-width `1400px`, 2–3 column layouts where possible
- Tablet: max-width `100%`, 2-column collapse
- Mobile: single column, full-width elements

**Pattern: COMMAND → STATUS → RESULTS**
- Command input (full-width, prominent)
- Live status panel (running indicators, real events only)
- Results display (result is visually dominant)

**Responsive Collapse:**
- No horizontal scroll (critical failure)
- Multi-column collapses to single at < 768px
- Images/rich content stack vertically
- Sidebar/secondary panels move below main content on mobile

**No Overlapping Elements:**
- Every element occupies its own space
- Clean separation via borders or negative space
- Never stack text over images or other content
- Z-index used only for navigation, modals, overlays

---

## Interaction Principles

**Input States:**
- Default: calm, subtle border
- Focus: blue ring (2px, 2px offset)
- Error: red border + error message below
- Disabled: reduced opacity (50%), cursor-not-allowed
- Loading: placeholder shimmer (skeleton matching layout)

**Button States:**
- Primary (blue): solid fill, white text, hover: slightly darker
- Secondary (outline): white/light fill, colored border, hover: subtle background shift
- Active: slight scale-down (`scale(0.98)`) or vertical offset (`-1px translateY`)
- Disabled: desaturated, no hover effect

**Transitions:**
- All interactive: `transition: all 150ms ease-out`
- Spring physics NOT required (no perpetual motion)
- Only animate: `color`, `background-color`, `transform`, `opacity`
- Never animate: `top`, `left`, `width`, `height`

**Micro-interactions:**
- Status dot pulse on "Running" state (subtle, not distracting)
- Smooth fade-in for result display
- No loading spinners (use skeleton shimmer instead)
- No bouncing chevrons or "scroll down" affordances

---

## Information Hierarchy

**What Matters Most (In Order):**
1. **The Answer** — If task completed, the result is the visual focus
2. **Status** — Is it running, done, or failed?
3. **Metrics** — Duration, steps, tokens (secondary context)
4. **Timeline** — What did the agent actually do? (collapsed by default)
5. **Debug Info** — Developer Inspector (hidden until toggled)

**Layout Consequence:**
- Large, clear result display when complete
- Metrics in a compact row or grid below
- Timeline collapsed or in a separate section
- Developer Inspector toggleable, not always visible

---

## Patterns Deliberately Avoided

**From taste-skill anti-patterns:**
- ~~No emojis~~ (anywhere)
- ~~No overlapping elements~~
- ~~No centered Hero layouts~~ (use asymmetric)
- ~~No generic 3-column card layouts~~ (use asymmetric grids or 2-column)
- ~~No filler UI~~ ("Scroll to explore", scroll arrows, etc.)
- ~~Circular loading spinners~~ (skeleton shimmer only)
- ~~Generic names~~ ("Task 1", "Agent Status", etc.)
- ~~Fake data~~ (no placeholder "Example Domain" if not real)

**From Sentry/Stripe learnings:**
- ~~No playful mascots or stickers~~ (Sentry style, wrong for JARVIS)
- ~~No decorative gradients~~ on backgrounds
- ~~No marketing-page aesthetics~~ on dashboards
- ~~No oversized hero sections~~ (JARVIS is operational tool, not product launch)

---

## Ideas from Design Resources

### From taste-skill:
- **Weight-driven hierarchy:** Use font weights (400/600/700), not size jumps
- **Responsive testing mandatory:** 375px, 768px, 1440px (not "just mobile/desktop")
- **Spring physics optional:** Motion must feel premium but doesn't need custom libraries
- **No Inter font:** Use system fonts instead (simpler, faster)
- **Clean separation of elements:** Borders or negative space, never overlap

### From agent-skills / vercel-labs:
- **Progressive disclosure:** Hide developer details until requested (Dev Inspector toggle)
- **Context efficiency:** Show only relevant information for the current state
- **Clear taxonomy:** Use specific names ("Task ID", "Browser State") not generic labels
- **Scalable architecture:** Components that can grow with more data

### From awesome-design-md (Stripe Dashboard Pattern):
- **Dark shell for operations:** Dark mode by default for 24/7 operational contexts
- **Light mode alternative:** Keep light mode for accessibility and varied preferences
- **Tabular numerics:** Use monospace for metrics (tokens, duration, timestamps)
- **Data clarity over decoration:** Every visual element serves information, none are ornamental
- **Tight radius pills:** Buttons are slightly rounded, not huge  (`0.375rem` radius)
- **High contrast dark surfaces:** Don't use true black, but deep slate for readability

---

## Key Differentiators from Previous Approach

**Before (Placeholder UI):**
- Simulated activity ("Initializing browser" hardcoded)
- Hardcoded browser URL (example.com after every task)
- Fake connection status (just showed Running/Ready)
- All UI in one 322-line file
- Light-only mode

**After (Real Event-Driven UI):**
- Activity timeline from **actual backend events** (no fabrication)
- Browser state from **real BrowserController state** (URL, title, actual page)
- OmniRoute health from **actual health check** (not hardcoded)
- Proper component separation (7+ components)
- Dark/light mode support (from taste-skill principles)
- Developer Inspector with **real data** (task ID, tokens, model, retries)

---

## Implementation Priority

1. **Real event streaming** (SSE from backend)
2. **Component structure** (separate files)
3. **Light mode first** (clean baseline)
4. **Dark mode** (from Stripe example)
5. **Mobile responsiveness** (375px, 768px, 1440px testing)
6. **Visual polish** (2+ review passes)
7. **Developer Inspector** (real data only)

---

**Design frozen for implementation. No additions during coding phase.**
