import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildRenderResourcePlan,
  normalizeConcurrencies,
} from '../../src/benchmark/resource-plan.js';
import { renderManifest } from '../helpers.js';

describe('render resource benchmark planning', () => {
  it('resolves current, de-duplicates, sorts and bounds concurrency', () => {
    expect(normalizeConcurrencies(['current', '2', '1,2'], 4)).toEqual([1, 2, 4]);
    expect(() => normalizeConcurrencies(['0'], 1)).toThrow(/Invalid Remotion concurrency/);
    expect(() => normalizeConcurrencies(['9'], 1)).toThrow(/Invalid Remotion concurrency/);
  });

  it('is a strict plan unless run is explicit', () => {
    const plan = buildRenderResourcePlan({
      manifestPath: 'manifest.json',
      outputDirectory: 'benchmarks',
      concurrencies: ['1', '2'],
      configuredConcurrency: 1,
      run: false,
    });
    expect(plan.mode).toBe('plan');
    expect(plan.cases.map((item) => item.concurrency)).toEqual([1, 2]);
    expect(plan.metricScope).toContain('linux_descendants_peak_rss');
  });

  it('validates a manifest without creating output or starting a render', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'composer-resource-plan-'));
    const manifestPath = path.join(root, 'manifest.json');
    const outputDirectory = path.join(root, 'outputs');
    writeFileSync(manifestPath, JSON.stringify(renderManifest(root)));

    const output = execFileSync(
      path.resolve('node_modules/.bin/tsx'),
      [
        'scripts/benchmark-resources.ts',
        '--manifest',
        manifestPath,
        '--concurrency',
        '1',
        '2',
        '--output',
        outputDirectory,
      ],
      { cwd: path.resolve('.'), encoding: 'utf8' },
    );

    expect(output).toContain('PLAN ONLY');
    expect(existsSync(outputDirectory)).toBe(false);
  });

  it('keeps the API benchmark plan-only without run', () => {
    const output = execFileSync(
      path.resolve('node_modules/.bin/tsx'),
      ['scripts/benchmark-render.ts', '--workflow-id', '10000000-0000-4000-8000-000000000001'],
      { cwd: path.resolve('.'), encoding: 'utf8' },
    );
    expect(output).toContain('PLAN ONLY');
  });
});
