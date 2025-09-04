// CJS wrapper for pm2 so it can load our ESM worker without choking on `export`
(async () => {
  await import('./pnlWorker.js');     // this file has the BullMQ Worker side-effects
})();
