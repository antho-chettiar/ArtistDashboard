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
    const client = redisUrl
      ? new Redis(redisUrl, {
          lazyConnect: true,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          ...(process.env.REDIS_TLS === 'true' ? { tls: { rejectUnauthorized: false } } : {}),
        })
      : new Redis({
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379'),
          username: process.env.REDIS_USERNAME || 'default',
          password: process.env.REDIS_PASSWORD,
          lazyConnect: true,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
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
