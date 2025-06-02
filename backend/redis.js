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

// In-memory cache with TTL and basic queue support
const inMemoryCache = new Map();
const CACHE_TTL = 3600; // 1 hour TTL
const inMemoryQueues = new Map(); // For lpush/lrange fallback

// Validate and construct REDIS_URL
const validateRedisConfig = () => {
  const redisUrl = process.env.REDIS_URL;
  const redisHost = process.env.REDIS_HOST || 'localhost';
  const redisPort = process.env.REDIS_PORT || 6379;
  const redisPassword = process.env.REDIS_PASSWORD;
  const redisUser = process.env.REDIS_USER || 'default';
  const redisFallbackUrl = process.env.REDIS_FALLBACK_URL;

  const validateUrl = (url, type) => {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      if (!parsed.hostname || !parsed.port || !['redis:', 'rediss:'].includes(parsed.protocol)) {
        logger.error(`Invalid ${type} URL: missing hostname, port, or invalid protocol`, {
          url: url.replace(/:[^@]+@/, ':****@'),
        });
        return false;
      }
      return true;
    } catch (err) {
      logger.error(`Invalid ${type} URL format`, { url: url.replace(/:[^@]+@/, ':****@'), error: err.message });
      return false;
    }
  };

  if (redisUrl && validateUrl(redisUrl, 'primary')) {
    logger.info('Using REDIS_URL from environment', { url: redisUrl.replace(/:[^@]+@/, ':****@') });
    return { primary: redisUrl, fallback: redisFallbackUrl && validateUrl(redisFallbackUrl, 'fallback') ? redisFallbackUrl : null };
  }

  if (!redisHost || !redisPort) {
    logger.warn('Missing REDIS_HOST or REDIS_PORT, using in-memory cache only');
    return { primary: null, fallback: null };
  }

  const protocol = redisPassword ? 'rediss' : 'redis';
  const url = redisPassword
    ? `${protocol}://${redisUser}:${redisPassword}@${redisHost}:${redisPort}`
    : `${protocol}://${redisHost}:${redisPort}`;
  if (!validateUrl(url, 'constructed')) {
    logger.warn('Constructed Redis URL invalid, using in-memory cache only');
    return { primary: null, fallback: null };
  }
  logger.info('Constructed Redis URL', { url: url.replace(/:[^@]+@/, ':****@') });
  return { primary: url, fallback: redisFallbackUrl && validateUrl(redisFallbackUrl, 'fallback') ? redisFallbackUrl : null };
};

const { primary: REDIS_URL, fallback: REDIS_FALLBACK_URL } = validateRedisConfig();

const createRedisClient = (url) => redis.createClient({
  url,
  socket: {
    connectTimeout: 5000,
    keepAlive: 300,
    reconnectStrategy: (retries) => {
      if (retries > 3) {
        logger.error('Redis reconnection failed after 3 attempts', { retries, url: url.replace(/:[^@]+@/, ':****@') });
        return new Error('Redis reconnection failed');
      }
      const delay = 50 + retries * 25;
      logger.info('Reconnect attempt', { retries, delay, url: url.replace(/:[^@]+@/, ':****@') });
      return delay;
    },
  },
  disableOfflineQueue: true,
});

let redisClient = REDIS_URL ? createRedisClient(REDIS_URL) : null;
let isRedisAvailable = false;

if (redisClient) {
  redisClient.on('connect', () => {
    logger.info('Connected to Redis', { url: redisClient.options.url.replace(/:[^@]+@/, ':****@') });
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

  // Initialize Redis connection with fallback
  (async () => {
    let attempts = 0;
    const maxAttempts = 3;
    let usingFallback = false;

    while (attempts < maxAttempts) {
      try {
        await redisClient.connect();
        logger.info('Redis client initialized successfully', { url: redisClient.options.url.replace(/:[^@]+@/, ':****@') });
        isRedisAvailable = true;
        break;
      } catch (err) {
        attempts++;
        logger.error(`Failed to connect to Redis on startup, attempt ${attempts}`, {
          error: err.message,
          stack: err.stack,
          url: redisClient.options.url.replace(/:[^@]+@/, ':****@'),
        });

        if (attempts === maxAttempts && REDIS_FALLBACK_URL && !usingFallback) {
          logger.info('Switching to fallback Redis URL', { url: REDIS_FALLBACK_URL.replace(/:[^@]+@/, ':****@') });
          redisClient = createRedisClient(REDIS_FALLBACK_URL);
          attempts = 0;
          usingFallback = true;
          continue;
        }

        if (attempts === maxAttempts) {
          logger.warn('Redis connection failed after max attempts, using in-memory cache');
          isRedisAvailable = false;
          redisClient = null;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500 * attempts));
      }
    }
  })();
}

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

// In-memory queue operations (basic lpush/lrange fallback)
const lpushInMemory = (key, value) => {
  const queue = inMemoryQueues.get(key) || [];
  queue.unshift(typeof value === 'string' ? value : JSON.stringify(value));
  inMemoryQueues.set(key, queue.slice(0, 1000)); // Limit queue size
  logger.info('In-memory queue lpush', { key });
  return queue.length;
};

const lrangeInMemory = (key, start, stop) => {
  const queue = inMemoryQueues.get(key) || [];
  const end = stop < 0 ? queue.length + stop : stop;
  const result = queue.slice(start, end + 1).map((item) => {
    try {
      return JSON.parse(item);
    } catch {
      return item;
    }
  });
  logger.info('In-memory queue lrange', { key, start, stop });
  return result;
};

// Redis operation with minimal retry
const withRetry = async (operation) => {
  if (!isRedisAvailable || !redisClient) {
    logger.warn('Redis unavailable, using in-memory cache');
    return null;
  }
  try {
    return await operation();
  } catch (err) {
    logger.error('Redis operation failed', { error: err.message });
    isRedisAvailable = false;
    return null;
  }
};

module.exports = {
  client: redisClient,
  isAvailable: () => isRedisAvailable,
  get: async (key) => {
    if (!isRedisAvailable || !redisClient) return getInMemory(key);
    return await withRetry(async () => {
      const result = await redisClient.get(key);
      logger.info('Redis get', { key, result: result ? 'found' : 'not found' });
      return result;
    }) || getInMemory(key);
  },
  set: async (key, value) => {
    if (!isRedisAvailable || !redisClient) {
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
    if (!isRedisAvailable || !redisClient) {
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
    if (!isRedisAvailable || !redisClient) {
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
    if (!isRedisAvailable || !redisClient) return lpushInMemory(key, value);
    return await withRetry(async () => {
      const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
      const result = await redisClient.lPush(key, stringValue);
      logger.info('Redis lpush', { key });
      return result;
    }) || lpushInMemory(key, value);
  },
  lrange: async (key, start, stop) => {
    if (!isRedisAvailable || !redisClient) return lrangeInMemory(key, start, stop);
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
    }) || lrangeInMemory(key, start, stop);
  },
  quit: async () => {
    try {
      if (redisClient && redisClient.isOpen) {
        await redisClient.quit();
        logger.info('Redis connection closed gracefully');
        isRedisAvailable = false;
      }
    } catch (err) {
      logger.error('Error closing Redis connection', { error: err.message });
    }
  },
};