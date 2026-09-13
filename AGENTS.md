# Video Composer agent guide

Video Composer executes frozen ProductionTimeline decisions. It may quantize frames, materialize
trusted assets, prepare technical proxies, render static Remotion components and validate outputs.
It must never perform Media Search, reinterpret VisualQueries, choose footage, call an LLM, modify
upstream artifacts or accept arbitrary paths/URLs.

Use Node 20+, TypeScript strict mode and the pinned Remotion packages. Run `npm ci`, `npm test`,
`npm run lint`, `npm run format:check`, `npm run typecheck` and `npm run build`. Real Chromium work
belongs in the explicit `npm run smoke:render` smoke, not unit tests. Keep SQLite job state, caches
and outputs under the configured data root. Publish outputs atomically and fail closed.

Stage 17 end-to-end orchestration is not part of this repository yet.

# Durable hybrid-source rules

- Timeline V2 visual sources are a strict `video_segment | static_image` union; images are
  non-temporal and must never receive fake sessions or source ranges.
- Keep Timeline/Manifest V1 behavior replayable while accepting V2 through versioned payloads.
- The Composer materializes logical assets and renders the frozen presentation; it never searches
  for media or changes the upstream editorial source choice.
