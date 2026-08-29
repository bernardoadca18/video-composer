import path from 'node:path';

export const RESOURCE_BENCHMARK_VERSION = 'render_resource_benchmark_v1';

export interface RenderResourceCase {
  concurrency: number;
  outputPath: string;
}

export interface RenderResourcePlan {
  benchmarkVersion: string;
  mode: 'plan' | 'run';
  manifestPath: string;
  outputDirectory: string;
  cases: RenderResourceCase[];
  metricScope: string;
}

export const normalizeConcurrencies = (
  values: readonly string[],
  configuredConcurrency: number,
): number[] => {
  const parsed = values
    .flatMap((value) => value.split(','))
    .map((raw) => {
      const normalized = raw.trim().toLowerCase();
      const result = normalized === 'current' ? configuredConcurrency : Number(normalized);
      if (!Number.isInteger(result) || result < 1 || result > 8) {
        throw new Error(`Invalid Remotion concurrency: ${raw}`);
      }
      return result;
    });
  return [...new Set(parsed)].sort((left, right) => left - right);
};

export const buildRenderResourcePlan = (options: {
  manifestPath: string;
  outputDirectory: string;
  concurrencies: readonly string[];
  configuredConcurrency: number;
  run: boolean;
}): RenderResourcePlan => {
  const manifestPath = path.resolve(options.manifestPath);
  const outputDirectory = path.resolve(options.outputDirectory);
  const concurrencies = normalizeConcurrencies(
    options.concurrencies,
    options.configuredConcurrency,
  );
  if (concurrencies.length === 0) throw new Error('At least one concurrency is required');
  return {
    benchmarkVersion: RESOURCE_BENCHMARK_VERSION,
    mode: options.run ? 'run' : 'plan',
    manifestPath,
    outputDirectory,
    cases: concurrencies.map((concurrency) => ({
      concurrency,
      outputPath: path.join(outputDirectory, `concurrency-${concurrency}.mp4`),
    })),
    metricScope:
      'node_process_and_linux_descendants_peak_rss_plus_system_gpu_memory_when_available',
  };
};
