/**
 * ecosystem.config.cjs — PM2 cluster config
 * 5 workers, porta 3457, restart em 1500M
 */

module.exports = {
  apps: [
    {
      name:             'movidesk-mcp',
      script:           'server.js',
      instances:        5,
      exec_mode:        'cluster',
      watch:            false,
      max_memory_restart: '1500M',

      // Porta declarada aqui para referência; o bind real fica em server.js
      env: {
        NODE_ENV: 'production',
        PORT:     '3457',
      },

      // Graceful shutdown
      kill_timeout:    5000,
      wait_ready:      true,
      listen_timeout:  10000,

      // Logs
      out_file:   '/home/node/app/logs/out.log',
      error_file: '/home/node/app/logs/error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
