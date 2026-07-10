module.exports = {
  apps: [
    {
      name: 'survey',
      script: 'server/server.js',
      cwd: '/opt/apps/survey',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
