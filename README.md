# JARVIS

Autonomous web agent with voice/text commands, hybrid read/browser execution, goal tracking, multi-step autonomy, and real-time 3D execution UI.

## Current core stack

- Next.js / React / TypeScript
- Playwright
- OmniRoute (multi-provider LLM routing)
- Server-Sent Events (SSE) for live task streaming
- React Three Fiber / Three.js for the execution UI
- Deterministic browser skills (navigation, search, extraction, interaction)
- CapabilityRouter (read vs. browser capability selection)
- Structured page/content understanding
- TaskProgress / TaskPlan (goal evaluation and multi-step subgoal execution)
- Voice input

## Local startup

**Terminal 1:**
```bash
npx omniroute serve --no-open
```

**Terminal 2:**
```bash
npm install
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

Browser microphone permission is required for voice input.

Copy `.env.example` to `.env.local` and fill in your own keys before running.

## Current limitations

- Dynamic commerce workflows are still being hardened
- Planner structured-output failures can occur on complex tasks
- No purchases / checkout automation
- Authenticated integrations such as Gmail/Calendar are not added yet
- Generic read-capability fallback availability can depend on upstream services
- Not production ready
