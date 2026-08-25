import type { RenderJobProcessor } from './processor.js';

export class RenderWorker {
  private readonly pending: string[] = [];
  private readonly known = new Set<string>();
  private active = 0;
  private stopped = true;

  constructor(
    private readonly processor: RenderJobProcessor,
    private readonly maxQueueSize: number,
    private readonly concurrency: number,
  ) {}

  get queueDepth(): number {
    return this.pending.length + this.active;
  }

  get hasCapacity(): boolean {
    return this.queueDepth < this.maxQueueSize;
  }

  start(): void {
    this.stopped = false;
    this.pump();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    while (this.active > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  enqueue(jobId: string, recovery = false): boolean {
    if (this.known.has(jobId)) return true;
    if (!recovery && !this.hasCapacity) return false;
    this.pending.push(jobId);
    this.known.add(jobId);
    this.pump();
    return true;
  }

  private pump(): void {
    if (this.stopped) return;
    while (this.active < this.concurrency && this.pending.length > 0) {
      const jobId = this.pending.shift();
      if (!jobId) return;
      this.active += 1;
      void this.processor.process(jobId).finally(() => {
        this.active -= 1;
        this.known.delete(jobId);
        this.pump();
      });
    }
  }
}
