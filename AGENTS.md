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

# Program Audio V1 rules

- The Orchestrator alone resolves `audio_intent`. Execute `audio_mix_plan_v1`; never select music.
- Program renders use `composer_render_input_v2`, `render_manifest_v4`,
  `video_composer_v4_program_audio`, and the explicit stereo program profile. With no plan,
  preserve V1/V2/V3 and historical mono semantics exactly.
- Materialize music only from the controlled Orchestrator endpoint and verify SHA, size, format,
  duration, sample rate, and channels. Never accept an upstream path, URL, filtergraph, or shell
  fragment.
- Keep source gameplay proxies silent. Program Audio V1 contains narration plus one controlled
  instrumental music track only; SFX remains out of scope.
- Keep narration mastering and program mastering semantically separate. Use lossless PCM caches,
  render V4 video-only, and perform at most one final AAC encode.
- Cache keys include all audible plan decisions and FFmpeg identity; validate sidecars and rebuild
  corrupt entries atomically. Program-audio failures must not mutate upstream narration.
- Candidate mix/master settings require human review and must not be called human-frozen.

# Deterministic presentation rules

- Read the versioned Composer render-input package; do not fetch transcription/script fragments.
- presentation_spec_v1 is already resolved upstream. Never segment captions, derive section
  titles, choose branding, or infer transitions here.
- Presentation-bearing renders use render_manifest_v3 and video_composer_v3_presentation; absence
  must preserve the exact V1/V2 path.
- Validate the canonical PresentationSpec fingerprint and quantize overlay boundaries once before
  Remotion. Closed presets only; no arbitrary URL, path, base64, HTML, or CSS input.
- Source-image presentation and video overlay presentation are independent layers.
- CUT remains the source-edit default. V1 overlay transitions support only bounded fade_to_black,
  preserving total duration.
- During active Media Indexer corpus ingestion, run unit/contract/type/build checks only. Defer
  SMOKE_HYBRID=1 SMOKE_PRESENTATION=1 npm run smoke:render.

# Durable hybrid-source rules

- Timeline V2 visual sources are a strict `video_segment | static_image` union; images are
  non-temporal and must never receive fake sessions or source ranges.
- Keep Timeline/Manifest V1 behavior replayable while accepting V2 through versioned payloads.
- The Composer materializes logical assets and renders the frozen presentation; it never searches
  for media or changes the upstream editorial source choice.
