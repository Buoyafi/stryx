import { describe, expect, it } from 'vitest';
import { bullConnectionFrom } from '../src/bull-connection.js';

describe('the queue connection built from REDIS_URL', () => {
  it('a plain local URL is just a host and a port', () => {
    expect(bullConnectionFrom('redis://localhost:6379')).toEqual({ host: 'localhost', port: 6379 });
    expect(bullConnectionFrom('redis://cache.internal')).toEqual({ host: 'cache.internal', port: 6379 });
  });

  it('carries the password, username, database and TLS the URL names', () => {
    expect(bullConnectionFrom('rediss://default:p%40ss%2Fword@redis.example.com:6380/2')).toEqual({
      host: 'redis.example.com',
      port: 6380,
      username: 'default',
      password: 'p@ss/word',
      db: 2,
      tls: {},
    });
  });

  it('a password with no username, as most hosted Redis URLs have', () => {
    expect(bullConnectionFrom('redis://:secret@10.0.0.5:6379/0')).toEqual({ host: '10.0.0.5', port: 6379, password: 'secret', db: 0 });
  });
});
