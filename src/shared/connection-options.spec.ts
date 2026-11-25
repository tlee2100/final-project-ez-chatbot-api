import {
  resolvePostgresSslConfig,
  resolveRedisConnectionOptions,
} from './connection-options';

describe('connection-options', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DB_SSL;
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;
    delete process.env.REDIS_PASSWORD;
    delete process.env.REDIS_TLS;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('resolvePostgresSslConfig', () => {
    it('returns false when DB_SSL is not set or false', () => {
      expect(resolvePostgresSslConfig()).toBe(false);

      process.env.DB_SSL = 'false';
      expect(resolvePostgresSslConfig()).toBe(false);
    });

    it('returns rejectUnauthorized: false when DB_SSL is true', () => {
      process.env.DB_SSL = 'true';
      expect(resolvePostgresSslConfig()).toEqual({
        rejectUnauthorized: false,
      });
    });
  });

  describe('resolveRedisConnectionOptions', () => {
    it('uses defaults and omits tls when REDIS_TLS is not true', () => {
      const options = resolveRedisConnectionOptions();
      expect(options).toEqual({
        host: 'localhost',
        port: 6379,
        password: undefined,
      });
      expect('tls' in options).toBe(false);
    });

    it('includes tls: {} when REDIS_TLS is true', () => {
      process.env.REDIS_HOST = 'redis.example.com';
      process.env.REDIS_PORT = '12345';
      process.env.REDIS_PASSWORD = 'secret';
      process.env.REDIS_TLS = 'true';

      expect(resolveRedisConnectionOptions()).toEqual({
        host: 'redis.example.com',
        port: 12345,
        password: 'secret',
        tls: {},
      });
    });
  });
});
