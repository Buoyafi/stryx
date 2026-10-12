import type { ConnectionOptions } from 'bullmq';

/** BullMQ's connection, from the same REDIS_URL the rest of the app uses. */
export function bullConnectionFrom(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  const db = Number(url.pathname.slice(1));
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.pathname.length > 1 && Number.isInteger(db) && db >= 0 ? { db } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}
