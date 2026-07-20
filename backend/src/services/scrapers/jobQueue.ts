import { getRedis, redis } from '../../utils/database';
import { logger } from '../../utils/logger';
import { ScrapeJobPayload } from './types';

const PAYLOAD_TTL_SECONDS = 60 * 60 * 24;

// Generic over payload shape so any scraper can get its own queue instance
// without colliding with another scraper's Redis keys (see `namespace` below).
// Defaults to `ScrapeJobPayload` so existing callers of `scrapingJobQueue`
// (the singleton at the bottom of this file) are unaffected.
export class ScrapingJobQueue<TPayload extends { id: string } = ScrapeJobPayload> {
  private readonly memoryQueue: TPayload[] = [];
  private readonly queueKey: string;

  // `namespace` scopes both the Redis list key and the per-payload key so
  // multiple scrapers can share this class without stepping on each other.
  // Defaults to 'concert' to keep the existing singleton's Redis keys
  // byte-identical to before this change.
  constructor(private readonly namespace: string = 'concert') {
    this.queueKey = `${this.namespace}:scrape:queue`;
  }

  async enqueue(payload: TPayload): Promise<void> {
    const client = getRedis();

    if (!client) {
      this.memoryQueue.push(payload);
      return;
    }

    const payloadKey = this.payloadKey(payload.id);
    await redis.setex(payloadKey, PAYLOAD_TTL_SECONDS, JSON.stringify(payload));
    await client.lpush(this.queueKey, payload.id);
  }

  async dequeue(): Promise<TPayload | null> {
    const client = getRedis();

    if (!client) {
      return this.memoryQueue.shift() ?? null;
    }

    const id = await client.rpop(this.queueKey);
    if (!id) return null;

    const payload = await redis.get(this.payloadKey(id));
    if (!payload) {
      logger.warn('Scrape queue payload missing', { id, namespace: this.namespace });
      return null;
    }

    return JSON.parse(payload) as TPayload;
  }

  private payloadKey(id: string): string {
    return `${this.namespace}:scrape:job:${id}`;
  }
}

export const scrapingJobQueue = new ScrapingJobQueue();
