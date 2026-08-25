import { loadConfig } from './core/config.js';
import { startRuntime } from './runtime.js';

await startRuntime(loadConfig());
