import { describe, expect, it } from 'vitest';

import { RenderWorker } from '../../src/jobs/worker.js';

describe('render worker', () => {
  it('serializes work and enforces bounded accumulation', async () => {
    let active = 0;
    let maximum = 0;
    const completed: string[] = [];
    const processor = {
      process: async (id: string) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        completed.push(id);
        active -= 1;
      },
    };
    const worker = new RenderWorker(processor as never, 2, 1);
    worker.start();

    expect(worker.enqueue('one')).toBe(true);
    expect(worker.enqueue('two')).toBe(true);
    expect(worker.enqueue('three')).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(maximum).toBe(1);
    expect(completed).toEqual(['one', 'two']);
    await worker.stop();
  });

  it('waits for active work during graceful shutdown', async () => {
    let completed = false;
    const worker = new RenderWorker(
      {
        process: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          completed = true;
        },
      } as never,
      1,
      1,
    );
    worker.start();
    worker.enqueue('active');

    await worker.stop();

    expect(completed).toBe(true);
  });
});
