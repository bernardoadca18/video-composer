# Stage 16 input and output contract

## Accepted upstream artifact

The service reads `GET /workflow/{workflow_id}/production-timeline` and supports only:

- schema `production_timeline_schema_v1`;
- status `completed` or `completed_with_gaps`;
- source type `gameplay`;
- playback rate `1.0`;
- transition `cut`;
- half-open `[start,end)` second ranges;
- one complete narration track starting at zero.

Timeline seconds remain authoritative. Candidate ranges authorize footage; exact source ranges are
the only visible gameplay interval. These fields are never interchanged.

## Quantization

Stage 15 seconds are converted once to integer microseconds. Every unique shared boundary is mapped
once using nearest-frame, half-up rounding. Frame zero is fixed. Final duration uses ceiling rounding
so narration is not truncated. Any placement or gap collapsing to zero frames is rejected.

## Render manifest

`render_manifest_v1` is a normalized immutable snapshot containing timeline identity, profile,
source SHA-256 identities, exact source microseconds, frame ranges, proxy keys and controlled local
asset URLs. Its canonical SHA-256 differs from the upstream ProductionTimeline fingerprint.

## Output guarantee

`youtube_1080p30_v1` produces MP4, 1920x1080, 30 fps, H.264/yuv420p and exactly one AAC 48 kHz
narration stream. Visual fit is `contain` on black. Final mode rejects all gaps; preview mode renders
declared gaps as deterministic black diagnostic frames. Output duration stays within one frame of
the authoritative timeline.

Unsupported future source types, transitions or playback rates fail explicitly. The Composer never
selects an alternative source.
