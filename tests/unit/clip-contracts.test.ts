import { describe, expect, it } from 'vitest';

import {
  type ClipRenderRequest,
  ClipRenderRequestSchema,
  validateClipRenderRequest,
  ClipContractValidationError,
} from '../../src/domain/clip-contracts.js';

const validRequest = (): ClipRenderRequest => ({
  schema_version: 'clip_render_request_v1',
  clip_composition_id: '10000000-0000-4000-8000-000000000001',
  clip_composition_fingerprint: 'a'.repeat(64),
  composition_version: 2,
  workflow_id: '20000000-0000-4000-8000-000000000001',
  source_id: '30000000-0000-4000-8000-000000000001',
  plan_id: '40000000-0000-4000-8000-000000000001',
  candidate_id: '50000000-0000-4000-8000-000000000001',
  analysis_id: '60000000-0000-4000-8000-000000000001',
  media_id: '70000000-0000-4000-8000-000000000001',
  transcription_id: '80000000-0000-4000-8000-000000000001',
  source_sha256: 'b'.repeat(64),
  source_start_seconds: 10.123456,
  source_end_seconds: 47.987654,
  strategy: 'USE_DIRECTLY',
  render_profile: 'vertical_short_v1',
  audio_mode: 'original',
  caption_mode: 'none',
});

describe('ClipRenderRequest V1 schema', () => {
  it('accepts a valid clip render request', () => {
    const request = validRequest();
    const parsed = ClipRenderRequestSchema.parse(request);
    expect(parsed).toEqual(request);
  });

  it('accepts analysis_id as null', () => {
    const request = validRequest();
    request.analysis_id = null;
    const parsed = ClipRenderRequestSchema.parse(request);
    expect(parsed.analysis_id).toBeNull();
  });

  it('accepts all valid strategies', () => {
    for (const strategy of ['USE_DIRECTLY', 'TRIM', 'ADD_CONTEXT'] as const) {
      const request = validRequest();
      request.strategy = strategy;
      const parsed = ClipRenderRequestSchema.parse(request);
      expect(parsed.strategy).toBe(strategy);
    }
  });

  it('rejects invalid UUID', () => {
    const request = validRequest();
    (request as Record<string, unknown>).clip_composition_id = 'not-a-uuid';
    expect(() => ClipRenderRequestSchema.parse(request)).toThrow();
  });

  it('rejects invalid SHA-256', () => {
    const request = validRequest();
    (request as Record<string, unknown>).source_sha256 = 'not-sha256';
    expect(() => ClipRenderRequestSchema.parse(request)).toThrow();
  });

  it('rejects SHA-256 with uppercase', () => {
    const request = validRequest();
    (request as Record<string, unknown>).source_sha256 = 'A'.repeat(64);
    expect(() => ClipRenderRequestSchema.parse(request)).toThrow();
  });

  it('rejects negative start seconds', () => {
    const request = validRequest();
    request.source_start_seconds = -1;
    expect(() => ClipRenderRequestSchema.parse(request)).toThrow();
  });

  it('rejects Infinity in timestamps', () => {
    const request = validRequest();
    request.source_start_seconds = Infinity;
    expect(() => ClipRenderRequestSchema.parse(request)).toThrow();
  });

  it('rejects NaN in timestamps', () => {
    const request = validRequest();
    request.source_end_seconds = NaN;
    expect(() => ClipRenderRequestSchema.parse(request)).toThrow();
  });

  it('rejects unknown render profile', () => {
    const request = validRequest();
    (request as Record<string, unknown>).render_profile = 'unknown_profile';
    expect(() => ClipRenderRequestSchema.parse(request)).toThrow();
  });

  it('rejects unknown schema version', () => {
    const request = validRequest();
    (request as Record<string, unknown>).schema_version = 'clip_render_request_v2';
    expect(() => ClipRenderRequestSchema.parse(request)).toThrow();
  });

  it('rejects composition_version that is not positive', () => {
    const request = validRequest();
    request.composition_version = 0;
    expect(() => ClipRenderRequestSchema.parse(request)).toThrow();
  });
});

describe('validateClipRenderRequest', () => {
  it('accepts valid request with all supported features', () => {
    const request = validRequest();
    expect(() => validateClipRenderRequest(request)).not.toThrow();
  });

  it('rejects end <= start', () => {
    const request = validRequest();
    request.source_start_seconds = 50;
    request.source_end_seconds = 50;
    expect(() => validateClipRenderRequest(request)).toThrow(ClipContractValidationError);
  });

  it('rejects end < start', () => {
    const request = validRequest();
    request.source_start_seconds = 50;
    request.source_end_seconds = 10;
    expect(() => validateClipRenderRequest(request)).toThrow(ClipContractValidationError);
  });

  it('rejects REAUTHOR strategy', () => {
    const request = validRequest();
    (request as Record<string, unknown>).strategy = 'REAUTHOR';
    expect(() => validateClipRenderRequest(request)).toThrow(ClipContractValidationError);
  });

  it('rejects REJECT strategy', () => {
    const request = validRequest();
    (request as Record<string, unknown>).strategy = 'REJECT';
    expect(() => validateClipRenderRequest(request)).toThrow(ClipContractValidationError);
  });

  it('rejects audio_mode=mixed', () => {
    const request = validRequest();
    request.audio_mode = 'mixed';
    expect(() => validateClipRenderRequest(request)).toThrow(ClipContractValidationError);
  });

  it('rejects audio_mode=replaced', () => {
    const request = validRequest();
    request.audio_mode = 'replaced';
    expect(() => validateClipRenderRequest(request)).toThrow(ClipContractValidationError);
  });

  it('rejects caption_mode=burned', () => {
    const request = validRequest();
    request.caption_mode = 'burned';
    expect(() => validateClipRenderRequest(request)).toThrow(ClipContractValidationError);
  });

  it('rejects caption_mode=sidecar', () => {
    const request = validRequest();
    request.caption_mode = 'sidecar';
    expect(() => validateClipRenderRequest(request)).toThrow(ClipContractValidationError);
  });

  it('rejects extra fields', () => {
    const request = validRequest();
    (request as Record<string, unknown>).extra_field = 'not allowed';
    expect(() => ClipRenderRequestSchema.parse(request)).toThrow();
  });
});
