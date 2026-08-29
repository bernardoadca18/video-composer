const baseUrl = (process.env.VIDEO_COMPOSER_BASE_URL ?? 'http://localhost:8013').replace(/\/$/, '');
const workflowIndex = process.argv.indexOf('--workflow-id');
if (workflowIndex < 0 || !process.argv[workflowIndex + 1]) {
  throw new Error('Usage: npm run benchmark -- --workflow-id UUID [--mode preview|final]');
}
const workflowId = process.argv[workflowIndex + 1]!;
const modeIndex = process.argv.indexOf('--mode');
const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : 'final';
const run = process.argv.includes('--run');
if (!run) {
  process.stdout.write(
    `${JSON.stringify(
      {
        benchmark_version: 'render_benchmark_v2_opt_in',
        mode: 'plan',
        workflow_id: workflowId,
        render_mode: mode,
        base_url: baseUrl,
      },
      null,
      2,
    )}\nPLAN ONLY: no render request was submitted. Add --run to execute.\n`,
  );
  process.exit(0);
}
const started = performance.now();
const createdResponse = await fetch(`${baseUrl}/v1/renders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ workflow_id: workflowId, render_profile: 'youtube_1080p30_v1', mode }),
});
const created = (await createdResponse.json()) as Record<string, unknown>;
if (createdResponse.status !== 202) throw new Error(JSON.stringify(created));
let result = created;
while (!['completed', 'failed'].includes(String(result.status))) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  result = (await (await fetch(`${baseUrl}/v1/renders/${String(created.id)}`)).json()) as Record<
    string,
    unknown
  >;
}
process.stdout.write(
  `${JSON.stringify({
    benchmark_version: 'render_benchmark_v2_opt_in',
    measured_wall_seconds: (performance.now() - started) / 1000,
    ...result,
  })}\n`,
);
