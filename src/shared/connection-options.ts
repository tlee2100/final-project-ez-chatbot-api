/**
 * Builds Postgres SSL configuration from DB_SSL environment variable.
 * Enables encrypted connections for cloud Postgres (e.g. Azure Flexible Server)
 * while keeping non-SSL local development unchanged.
 */
export function resolvePostgresSslConfig():
  | {
      rejectUnauthorized: boolean;
    }
  | false {
  return process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false;
}

/**
 * Builds shared Redis connection options supporting optional REDIS_TLS=true.
 */
export function resolveRedisConnectionOptions() {
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    ...(process.env.REDIS_TLS === 'true' ? { tls: {} } : {}),
  };
}
