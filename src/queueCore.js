// src/queueCore.js
// Thin facade so other modules can import from one place.
// Keeps refresh/queue logic single-sourced in refreshWorker.js.

export { queue, refreshToken } from './refreshWorker.js';
export const queueName = 'tabs_refresh';
export const queue = new Queue(queueName, { connection: bullRedis });
// (no `export function refreshToken` here)

