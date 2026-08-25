# JARVIS development specialists

Eight agents from [agency-agents](https://github.com/msitarzewski/agency-agents),
installed **project-scoped** (not into `~/.claude/agents`) and trimmed from a
roster of 315.

## These are build-time only

They help Claude build, review and verify JARVIS. They are **not** part of the
JARVIS runtime and must never appear in it. The runtime stays:

```
User → Text/Voice → UI → SSE → AgentExecutor → Observe/Plan/Act
     → Planner → OmniRoute → Skills → BrowserController → Playwright → Web
```

Nothing here may replace the Planner, OmniRoute, the skills architecture, the
Observe→Plan→Act loop, Playwright execution, or SSE. No swarm/multi-agent
topology is introduced into JARVIS.

## Roster

| Slug | Used for |
|---|---|
| `frontend-developer` | Next.js / React 19 / R3F HUD and scene work |
| `prompt-engineer` | Planner prompt reliability — schema-valid JSON, task-type routing |
| `minimal-change-engineer` | Keeping fixes scoped; refusing refactor creep |
| `code-reviewer` | Independent review of code the implementer wrote |
| `test-automation-engineer` | Playwright resilience, flake elimination |
| `reality-checker` | Verification gate — defaults to NEEDS WORK |
| `evidence-collector` | Executed/visual proof before any claim |
| `appsec-engineer` | Safety boundaries, credential handling, future auth |

## Working rules

1. **Separation of authority.** The specialist that implements a change does not
   also certify it. Review and verification go to different specialists.
2. **Executed evidence only.** Code existing, typecheck passing and build
   passing are not verification. Runtime features are proven by running them:
   real browser commands, real cancellation, real SSE frames, real screenshots.
3. **Narrow context.** Each specialist receives the specific subsystem and files
   it needs — never "read the repo". Use Graphify to locate before reading.
4. **Protect what works.** Existing behaviour is not modified to accommodate a
   specialist's preference.
