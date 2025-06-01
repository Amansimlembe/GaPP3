const redis = require('redis');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/redis-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/redis-combined.log' }),
  ],
});

// Construct REDIS_URL from REDIS_HOST, REDIS_PORT, and REDIS_PASSWORD
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || '';
const REDIS_URL = REDIS_PASSWORD
  ? `rediss://default:${REDIS_PASSWORD}@${REDIS_HOST}:${REDIS_PORT}`
  : `redis://${REDIS_HOST}:${REDIS_PORT}`;

const redisClient = redis.createClient({
  url: REDIS_URL,
  socket: {
    connectTimeout: 10000,
    keepAlive: 1000,
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        logger.error('Redis reconnection failed after 10 attempts', { retries });
        return new Error('Redis reconnection failed');
      }
      const delay = Math.min(retries * 100, 2000);
      logger.info('Reconnect attempt', { retries, delay });
      return delay;
    },
  },
  disableOfflineQueue: true, // Prevent queuing commands when disconnected
});

redisClient.on('connect', () => logger.info('Connected to Redis'));
redisClient.on('reconnecting', () => logger.info('Reconnecting to Redis'));
redisClient.on('end', () => logger.warn('Redis connection closed'));
redisClient.on('error', (err) => logger.error('Redis client error', { error: err.message, stack: err.stack }));

let isRedisAvailable = false;

(async () => {
  let attempts = 0;
  const maxAttempts = 5;
  while (attempts < maxAttempts) {
    try {
      await redisClient.connect();
      logger.info('Redis client initialized successfully');
      isRedisAvailable = true;
      break;
    } catch (err) {
      attempts++;
      logger.error(`Failed to connect to Redis on startup, attempt ${attempts}`, { error: err.message, stack: err.stack });
      if (attempts === maxAttempts) {
        logger.warn('Redis connection failed after max attempts, continuing without caching');
        isRedisAvailable = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempts));
    }
  }
})();

const withRetry = async (operation, maxRetries = 3) => {
  if (!isRedisAvailable) {
    logger.warn('Redis unavailable, bypassing cache operation');
    return null;
  }
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await operation();
    } catch (err) {
      attempt++;
      logger.error(`Redis operation failed, attempt ${attempt}`, { error: err.message });
      if (attempt === maxRetries) {
        logger.warn('Redis operation failed after max retries, bypassing cache');
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
};

module.exports = {
  client: redisClient,
  isAvailable: () => isRedisAvailable,
  get: async (key) => {
    return await withRetry(async () => {
      const result = await redisClient.get(key);
      logger.info('Redis get', { key, result: result ? 'found' : 'not found' });
      return result;
    });
  },
  set: async (key, value) => {
    return await withRetry(async () => {
      const result = await redisClient.set(key, value);
      logger.info('Redis set', { key });
      return result;
    });
  },
  setex: async (key, seconds, value) => {
    return await withRetry(async () => {
      const result = await redisClient.setEx(key, seconds, value);
      logger.info('Redis setex', { key, seconds });
      return result;
    });
  },
  del: async (key) => {
    return await withRetry(async () => {
      const result = await redisClient.del(key);
      logger.info('Redis del', { key });
      return result;
    });
  },
  lpush: async (key, value) => {
    return await withRetry(async () => {
      const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
      const result = await redisClient.lPush(key, stringValue);
      logger.info('Redis lpush', { key });
      return result;
    });
  },
  lrange: async (key, start, stop) => {
    return await withRetry(async () => {
      const result = await redisClient.lRange(key, start, stop);
      logger.info('Redis lrange', { key, start, stop });
      return result.map((item) => {
        try {
          return JSON.parse(item);
        } catch {
          return item;
        }
      });
    });
  },
  quit: async () => {
    try {
      if (redisClient.isOpen) {
        await redisClient.quit();
        logger.info('Redis connection closed gracefully');
        isRedisAvailable = false;
      }
    } catch (err) {
      logger.error('Error closing Redis connection', { error: err.message });
    }
  },
};