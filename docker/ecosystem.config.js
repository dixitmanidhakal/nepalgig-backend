// PM2 ecosystem config for NepalgGig production
module.exports = {
  apps: [
    {
      name: 'nepalgig',
      script: 'server.js',
      instances: 'max',          // use all CPU cores
      exec_mode: 'cluster',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      // Graceful shutdown
      kill_timeout: 5000,
      listen_timeout: 10000,
      shutdown_with_message: true,
      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '/app/logs/nepalgig-error.log',
      out_file: '/app/logs/nepalgig-out.log',
      merge_logs: true,
      // Exponential backoff restart
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      restart_delay: 4000,
    },
  ],
};
