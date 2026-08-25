import { spawn } from 'node:child_process';

import { ComposerError } from '../core/errors.js';

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export const runProcess = async (
  command: string,
  args: readonly string[],
  category: string,
): Promise<ProcessResult> =>
  await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (value: Buffer) => stdout.push(value));
    child.stderr.on('data', (value: Buffer) => stderr.push(value));
    child.on('error', () => reject(new ComposerError(category, `${command} is unavailable`)));
    child.on('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8');
      const errorOutput = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        reject(new ComposerError(category, `${command} failed`));
        return;
      }
      resolve({ stdout: output, stderr: errorOutput });
    });
  });
