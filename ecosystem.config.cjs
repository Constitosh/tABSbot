// ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'tabs-bot',
      cwd: '/root/tABSbot/tABSbot',
      script: 'src/bot.js',
      node_args: '--enable-source-maps',
      env: { NODE_ENV: 'production' }
    },
    {
      name: 'tabs-worker',
      cwd: '/root/tABSbot/tABSbot',
      script: 'src/refreshWorker.js',
      node_args: '--enable-source-maps',
      env: { NODE_ENV: 'production' }
    }
  ]
};
