# Router modes

The planner backend is resolved in `src/core/router/mode.ts`. Normal startup uses
the real OmniRoute client. Every mock requires an explicit opt-in flag, logs a
warning on the server, and is surfaced in the UI as a banner + `Router` readout.
Mocks are refused when `NODE_ENV=production`.

| Mode | Command | Behaviour |
|---|---|---|
| **OMNIROUTE** (default) | `npm run dev` | Real LLM planning via OmniRoute |
| MOCK | `USE_MOCK_ROUTER=true npm run dev` | Fast scripted actions |
| SLOW MOCK | `USE_SLOW_MOCK_ROUTER=true npm run dev` | 5s planner delays — cancellation / UI-state testing |
| FAILING MOCK | `USE_FAILING_MOCK_ROUTER=true npm run dev` | Deterministic planner fault — FAILED-state testing |

Precedence if several are set: `failing-mock` > `slow-mock` > `mock` > `omniroute`.

## Mocks and the user's task

Mocks are scripted, but they derive the **destination from the real task**
(`destinationFromTask` in `src/core/router/mock-slow.ts`). A mock will not
silently navigate somewhere the user did not ask for. They fall back to
`example.com` only when the task names no domain at all.

## Checking which mode is live

```bash
curl -s localhost:3000/api/omniroute/health
```

Returns `routerMode`, `routerLabel`, `isMock` alongside health. No secrets.
