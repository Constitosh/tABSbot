module.exports = {
  apps: [
    { name: 'tabs-bot', script: 'src/bot.js', watch: false, env: { NODE_ENV: 'production' } },
    { name: 'tabs-worker', script: 'src/refreshWorker.js', watch: false, env: { NODE_ENV: 'production' } }
  ]
};
