module.exports = {
  apps: [
    {
      name: 'tabs-worker',
      script: 'src/refreshWorker.js',
      cwd: '/root/tABSbot/tABSbot',
      args: '',                 // add '--cron' if you want DEFAULT_TOKENS auto-refresh
      watch: false,
      autorestart: true,
      max_memory_restart: '300M',
      env: { NODE_ENV: 'production' }
    },
    {
      name: 'tabs-bot',
      script: 'src/bot.js',
      cwd: '/root/tABSbot/tABSbot',
      watch: false,
      autorestart: true,
      max_memory_restart: '300M',
      env: { NODE_ENV: 'production' }
    }
  ]
};
