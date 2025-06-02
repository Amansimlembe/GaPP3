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

// In-memory cache as fallback
const inMemoryCache = new Map();
const CACHE_TTL = 3600; // 1 hour TTL for in-memory cache

// Validate and construct REDIS_URL
const validateRedisConfig = () => {
  const redisUrl = process.env.REDIS_URL;
  const redisHost = process.env.REDIS_HOST || 'localhost';
  const redisPort = process.env.REDIS_PORT || 6379;
  const redisPassword = process.env.REDIS_PASSWORD;
  const redisUser = process.env.REDIS_USER || 'default';

  if (redisUrl) {
    try {
      const url = new URL(redisUrl);
      if (!url.hostname || !url.port) {
        throw new Error('Invalid REDIS_URL: missing hostname or port');
      }
      logger.info('Using REDIS_URL from environment', { url: url.toString().replace(/:[^@]+@/, ':****@') });
      return redisUrl;
    } catch (err) {
      logger.error('Invalid REDIS_URL format', { error: err.message });
    }
  }

  if (!redisHost || !redisPort) {
    logger.error('Missing REDIS_HOST or REDIS_PORT, using fallback localhost');
    return 'redis://localhost:6379';
  }

  const protocol = redisPassword ? 'rediss' : 'redis';
  const url = redisPassword
    ? `${protocol}://${redisUser}:${redisPassword}@${redisHost}:${redisPort}`
    : `${protocol}://${redisHost}:${redisPort}`;
  logger.info('Constructed Redis URL', { url: url.replace(/:[^@]+@/, ':****@') });
  return url;
};

const REDIS_URL = validateRedisConfig();

const redisClient = redis.createClient({
  url: REDIS_URL,
  socket: {
    connectTimeout: 10000, // Reduced timeout for faster failure detection
    keepAlive: 500, // More frequent keep-alive for active connections
    reconnectStrategy: (retries) => {
      if (retries > 10) { // Reduced max retries to avoid long delays
        logger.error('Redis reconnection failed after 10 attempts', { retries });
        return new Error('Redis reconnection failed');
      }
      const delay = Math.min(100 + retries * 50, 2000); // Start at 100ms, cap at 2s
      logger.info('Reconnect attempt', { retries, delay });
      return delay;
    },
  },
  disableOfflineQueue: true, // Prevent queuing during disconnections
});

redisClient.on('connect', () => {
  logger.info('Connected to Redis', { url: REDIS_URL.replace(/:[^@]+@/, ':****@') });
  isRedisAvailable = true;
});
redisClient.on('reconnecting', () => logger.info('Reconnecting to Redis'));
redisClient.on('end', () => {
  logger.warn('Redis connection closed');
  isRedisAvailable = false;
});
redisClient.on('error', (err) => {
  logger.error('Redis client error', { error: err.message, stack: err.stack });
  isRedisAvailable = false;
});

let isRedisAvailable = false;

// Initialize Redis connection
(async () => {
  let attempts = 0;
  const maxAttempts = 5; // Reduced attempts for faster fallback
  while (attempts < maxAttempts) {
    try {
      await redisClient.connect();
      logger.info('Redis client initialized successfully', { url: REDIS_URL.replace(/:[^@]+@/, ':****@') });
      isRedisAvailable = true;
      break;
    } catch (err) {
      attempts++;
      logger.error(`Failed to connect to Redis on startup, attempt ${attempts}`, {
        error: err.message,
        stack: err.stack,
      });
      if (attempts === maxAttempts) {
        logger.warn('Redis connection failed after max attempts, using in-memory cache');
        isRedisAvailable = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempts));
    }
  }
})();

// In-memory cache operations
const setInMemory = (key, value, ttl = CACHE_TTL) => {
  inMemoryCache.set(key, { value, expires: Date.now() + ttl * 1000 });
  logger.info('In-memory cache set', { key });
};

const getInMemory = (key) => {
  const entry = inMemoryCache.get(key);
  if (!entry || entry.expires < Date.now()) {
    inMemoryCache.delete(key);
    return null;
  }
  logger.info('In-memory cache get', { key, result: 'found' });
  return entry.value;
};

const delInMemory = (key) => {
  inMemoryCache.delete(key);
  logger.info('In-memory cache del', { key });
};

// Redis operation with retry and fallback
const withRetry = async (operation, maxRetries = 2) => {
  if (!isRedisAvailable) {
    logger.warn('Redis unavailable, using in-memory cache');
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
        logger.warn('Redis operation failed after max retries, using in-memory cache');
        isRedisAvailable = false;
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt)); // Reduced delay
    }
  }
};

module.exports = {
  client: redisClient,
  isAvailable: () => isRedisAvailable,
  get: async (key) => {
    if (!isRedisAvailable) {
      return getInMemory(key);
    }
    return await withRetry(async () => {
      const result = await redisClient.get(key);
      logger.info('Redis get', { key, result: result ? 'found' : 'not found' });
      return result;
    }) || getInMemory(key);
  },
  set: async (key, value) => {
    if (!isRedisAvailable) {
      setInMemory(key, value);
      return null;
    }
    return await withRetry(async () => {
      const result = await redisClient.set(key, value);
      logger.info('Redis set', { key });
      return result;
    }) || (setInMemory(key, value), null);
  },
  setex: async (key, seconds, value) => {
    if (!isRedisAvailable) {
      setInMemory(key, value, seconds);
      return null;
    }
    return await withRetry(async () => {
      const result = await redisClient.setEx(key, seconds, value);
      logger.info('Redis setex', { key, seconds });
      return result;
    }) || (setInMemory(key, value, seconds), null);
  },
  del: async (key) => {
    if (!isRedisAvailable) {
      delInMemory(key);
      return null;
    }
    return await withRetry(async () => {
      const result = await redisClient.del(key);
      logger.info('Redis del', { key });
      return result;
    }) || (delInMemory(key), null);
  },
  lpush: async (key, value) => {
    if (!isRedisAvailable) {
      logger.warn('In-memory cache does not support lpush', { key });
      return null;
    }
    return await withRetry(async () => {
      const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
      const result = await redisClient.lPush(key, stringValue);
      logger.info('Redis lpush', { key });
      return result;
    });
  },
  lrange: async (key, start, stop) => {
    if (!isRedisAvailable) {
      logger.warn('In-memory cache does not support lrange', { key });
      return [];
    }
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
    }) || [];
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