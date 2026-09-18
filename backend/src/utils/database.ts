import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
});

// Redis client (optional - used for caching)
let redisClient: Redis | null = null;

export const connectRedis = async (): Promise<void> => {
  try {
    const redisUrl = process.env.REDIS_URL;
    // A capped retryStrategy: up to 3 quick retries (200ms apart) tolerate a
    // flaky first connection attempt (e.g. right after a database is newly
    // provisioned), then give up for good. Without ANY limit, ioredis's
    // default retries forever against a truly dead host, hanging
    // `await connectRedis()` below indefinitely and blocking the whole server
    // from ever reaching app.listen() -- returning null after a few tries
    // avoids that while still surviving a one-off transient hiccup.
    const retryStrategy = (times: number) => (times <= 3 ? 200 : null);
    // enableOfflineQueue: false was removed -- against some Redis Cloud
    // endpoints (proxied, slightly slower handshake), ioredis's own automatic
    // AUTH command fires before the socket is confirmed writable, and with
    // the offline queue disabled that write fails outright instead of being
    // buffered ("Stream isn't writeable and enableOfflineQueue options is
    // false"), reproduced consistently against the current instance.
    // maxRetriesPerRequest: 1 already gives the same "fail fast instead of
    // hanging" guarantee for commands issued while Redis is unreachable, so
    // dropping enableOfflineQueue costs nothing on that front (verified: a
    // dead host still rejects in under half a second).
    const client = redisUrl
      ? new Redis(redisUrl, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          retryStrategy,
          connectTimeout: 5000,
          ...(process.env.REDIS_TLS === 'true' ? { tls: { rejectUnauthorized: false } } : {}),
        })
      : new Redis({
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379'),
          username: process.env.REDIS_USERNAME || 'default',
          password: process.env.REDIS_PASSWORD,
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          retryStrategy,
          connectTimeout: 5000,
          ...(process.env.REDIS_TLS === 'true' ? { tls: { rejectUnauthorized: false } } : {}),
        });

    client.on('error', () => {
      // ioredis emits connection errors even when we fall back to no-cache mode.
      // Swallow them here so the app can keep running without noisy stderr output.
    });

    redisClient = client;
    await client.ping();
    console.log('✅ Redis connected successfully');
  } catch (error) {
    const redisConfigured = Boolean(process.env.REDIS_URL || process.env.REDIS_HOST || process.env.REDIS_PORT);
    if (redisConfigured) {
      console.warn('⚠️  Redis connection failed, caching disabled:', error instanceof Error ? error.message : error);
    }
    if (redisClient) {
      redisClient.removeAllListeners();
      redisClient.disconnect();
    }
    redisClient = null;
  }
};

export const getRedis = (): Redis | null => {
  return redisClient;
};

// Proxy redis methods to avoid null errors
export const redis = {
  get: async (key: string): Promise<string | null> => {
    if (!redisClient) return null;
    return redisClient.get(key);
  },
  setex: async (key: string, ttl: number, value: string): Promise<boolean> => {
    if (!redisClient) return false;
    const result = await redisClient.setex(key, ttl, value);
    return result === 'OK';
  },
  keys: async (pattern: string): Promise<string[]> => {
    if (!redisClient) return [];
    return redisClient.keys(pattern);
  },
  del: async (...keys: string[]): Promise<number> => {
    if (!redisClient || keys.length === 0) return 0;
    return redisClient.del(...keys);
  },
  // Add other methods as needed (keys, etc.)
};

export const connectDatabase = async (): Promise<void> => {
  try {
    await prisma.$connect();
    console.log('✅ Database connected successfully');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  }
};

export const disconnectDatabase = async (): Promise<void> => {
  await prisma.$disconnect();
  if (redisClient) {
    await redisClient.quit();
  }
};

export const enableShutdownHooks = (prismaClient: PrismaClient): void => {
  process.on('beforeExit', async () => {
    await prismaClient.$disconnect();
    if (redisClient) await redisClient.quit();
  });

  process.on('SIGINT', async () => {
    await prismaClient.$disconnect();
    if (redisClient) await redisClient.quit();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await prismaClient.$disconnect();
    if (redisClient) await redisClient.quit();
    process.exit(0);
  });
};

enableShutdownHooks(prisma);
