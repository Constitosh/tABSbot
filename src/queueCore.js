// src/queueCore.js
import './configEnv.js';
import Redis from 'ioredis';
import { Queue } from 'bullmq';

export const bullRedis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const queueName = 'tabs_refresh';
export const queue = new Queue(queueName, { connection: bullRedis });
