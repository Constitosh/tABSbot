module.exports = {
  apps: [
    {
      name: 'tabs-bot',
      script: 'src/bot.js',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'tabs-worker',
      script: 'src/refreshWorker.js',
      env: {
        NODE_ENV: 'production',
        CRON: 'true'
      }
    }
  ]
};