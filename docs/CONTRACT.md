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

# Hybrid timeline V2

In addition to the existing `production_timeline_schema_v1`/`gameplay` input, the Composer
accepts `production_timeline_schema_v2` with a strict `video_segment | static_image` union.
Video segments retain real candidate and trim ranges with playback rate 1. Static images carry
logical project/media/ImageSemanticIndex identity, expected SHA-256, byte size and image MIME,
and explicitly carry no session or source time.

V2 produces `render_manifest_v2` (`video_composer_v2_hybrid_sources`). Image placements include
the frozen presentation selected upstream: `cover|contain`, `black|blurred_fill`, and
`none|slow_zoom_in|slow_zoom_out`. Holds are timeline time and quantize through the same shared
frame-boundary algorithm as video. Final renders remain gap-free and source audio remains muted.
