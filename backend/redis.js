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

// In-memory cache with TTL and queue support
const inMemoryCache = new Map();
const CACHE_TTL = 3600; // 1 hour TTL
const inMemoryQueues = new Map();

const validateRedisConfig = () => {
  const redisHost = process.env.REDIS_HOST || 'localhost';
  const redisPort = process.env.REDIS_PORT || 6379;
  const redisPassword = process.env.REDIS_PASSWORD;
  const redisUser = process.env.REDIS_USER || 'default';
  const redisUrl = process.env.REDIS_URL;
  const redisFallbackUrl = process.env.REDIS_FALLBACK_URL;

  const validateUrl = (url, type) => {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      if (!parsed.hostname || !parsed.port || !['redis:', 'rediss:'].includes(parsed.protocol)) {
        logger.error(`Invalid ${type} URL: missing hostname, port, or protocol`, {
          url: url.replace(/:[^@]+@/, ':****@'),
        });
        return false;
      }
      if (parsed.protocol === 'rediss:' && !parsed.username && !parsed.password) {
        logger.warn(`Rediss protocol requires credentials for ${type} URL`);
        return false;
      }
      return true;
    } catch (err) {
      logger.error(`Invalid ${type} URL format`, {
        url: url.replace(/:[^@]+@/, ':****@'),
        error: err.message,
      });
      return false;
    }
  };

  if (redisUrl && validateUrl(redisUrl, 'primary')) {
    logger.info('Using REDIS_URL from environment', { url: redisUrl.replace(/:[^@]+@/, ':****@') });
    return { primary: redisUrl, fallback: redisFallbackUrl && validateUrl(redisFallbackUrl, 'fallback') ? redisFallbackUrl : null };
  }

  const protocol = redisPassword ? 'rediss' : 'redis';
  const constructedUrl = redisPassword
    ? `${protocol}://${redisUser}:${encodeURIComponent(redisPassword)}@${redisHost}:${redisPort}`
    : `${protocol}://${redisHost}:${redisPort}`;
  if (!validateUrl(constructedUrl, 'constructed')) {
    logger.warn('Constructed Redis URL invalid, using in-memory cache');
    return { primary: null, fallback: null };
  }
  logger.info('Constructed Redis URL', { url: constructedUrl.replace(/:[^@]+@/, ':****@') });
  return { primary: constructedUrl, fallback: redisFallbackUrl && validateUrl(redisFallbackUrl, 'fallback') ? redisFallbackUrl : null };
};

const { primary: REDIS_URL, fallback: REDIS_FALLBACK_URL } = validateRedisConfig();

const createRedisClient = (url) => redis.createClient({
  url,
  socket: {
    connectTimeout: 10000,
    keepAlive: 1000,
    reconnectStrategy: (retries) => {
      if (retries > 5) {
        logger.error('Redis reconnection failed after 5 attempts', {
          retries,
          url: url.replace(/:[^@]+@/, ':****@'),
        });
        return new Error('Redis reconnection failed');
      }
      const delay = Math.min(100 * Math.pow(2, retries), 5000);
      logger.info('Reconnect attempt', { retries, delay, url: url.replace(/:[^@]+@/, ':****@') });
      return delay;
    },
    tls: url.startsWith('rediss:') ? { rejectUnauthorized: true } : undefined,
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
  redisClient.on('ready', () => {
    logger.info('Redis client ready', { url: redisClient.options.url.replace(/:[^@]+@/, ':****@') });
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

  (async () => {
    let attempts = 0;
    const maxAttempts = 5;
    let usingFallback = false;

    while (attempts < maxAttempts) {
      try {
        await redisClient.connect();
        logger.info('Redis client initialized', { url: redisClient.options.url.replace(/:[^@]+@/, ':****@') });
        isRedisAvailable = true;
        break;
      } catch (err) {
        attempts++;
        logger.error(`Failed to connect to Redis, attempt ${attempts}`, {
          error: err.message,
          stack: err.stack,
          url: redisClient.options.url.replace(/:[^@]+@/, ':****@'),
        });

        if (attempts === maxAttempts && REDIS_FALLBACK_URL && !usingFallback) {
          logger.info('Switching to fallback Redis URL', {
            url: REDIS_FALLBACK_URL.replace(/:[^@]+@/, ':****@'),
          });
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
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempts));
      }
    }
  })();
}

const setInMemory = (key, value, ttl = CACHE_TTL) => {
  if (!key || value === undefined) {
    logger.warn('Invalid in-memory cache set attempt', { key });
    return;
  }
  inMemoryCache.set(key, { value, expires: Date.now() + ttl * 1000 });
  logger.info('In-memory cache set', { key });
};

const getInMemory = (key) => {
  if (!key) {
    logger.warn('Invalid in-memory cache get attempt', { key });
    return null;
  }
  const entry = inMemoryCache.get(key);
  if (!entry || entry.expires < Date.now()) {
    inMemoryCache.delete(key);
    logger.info('In-memory cache get', { key, result: 'not found' });
    return null;
  }
  logger.info('In-memory cache get', { key, result: 'found' });
  return entry.value;
};

const delInMemory = (key) => {
  if (!key) {
    logger.warn('Invalid in-memory cache delete attempt', { key });
    return;
  }
  inMemoryCache.delete(key);
  logger.info('In-memory cache del', { key });
};

const lpushInMemory = (key, value) => {
  if (!key || value === undefined) {
    logger.warn('Invalid in-memory queue lpush attempt', { key });
    return 0;
  }
  const queue = inMemoryQueues.get(key) || [];
  queue.unshift(typeof value === 'string' ? value : JSON.stringify(value));
  inMemoryQueues.set(key, queue.slice(0, 1000));
  logger.info('In-memory queue lpush', { key });
  return queue.length;
};

const lrangeInMemory = (key, start, stop) => {
  if (!key) {
    logger.warn('Invalid in-memory queue lrange attempt', { key });
    return [];
  }
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

const withRetry = async (operation) => {
  if (!isRedisAvailable || !redisClient) {
    logger.warn('Redis unavailable, using in-memory cache');
    return null;
  }
  try {
    const result = await operation();
    return result;
  } catch (err) {
    logger.error('Redis operation failed', { error: err.message, stack: err.stack });
    isRedisAvailable = false;
    return null;
  }
};

module.exports = {
  client: redisClient,
  isAvailable: () => isRedisAvailable,
  get: async (key) => {
    if (!key) {
      logger.warn('Invalid Redis get attempt', { key });
      return null;
    }
    if (!isRedisAvailable || !redisClient) return getInMemory(key);
    return await withRetry(async () => {
      const result = await redisClient.get(key);
      logger.info('Redis get', { key, result: result ? 'found' : 'not found' });
      return result;
    }) || getInMemory(key);
  },
  set: async (key, value) => {
    if (!key || value === undefined) {
      logger.warn('Invalid Redis set attempt', { key });
      return null;
    }
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
    if (!key || value === undefined || seconds <= 0) {
      logger.warn('Invalid Redis setex attempt', { key, seconds });
      return null;
    }
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
    if (!key) {
      logger.warn('Invalid Redis del attempt', { key });
      return null;
    }
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
    if (!key || value === undefined) {
      logger.warn('Invalid Redis lpush attempt', { key });
      return 0;
    }
    if (!isRedisAvailable || !redisClient) return lpushInMemory(key, value);
    return await withRetry(async () => {
      const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
      const result = await redisClient.lPush(key, stringValue);
      logger.info('Redis lpush', { key });
      return result;
    }) || lpushInMemory(key, value);
  },
  lrange: async (key, start, stop) => {
    if (!key) {
      logger.warn('Invalid Redis lrange attempt', { key });
      return [];
    }
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
        redisClient = null;
      }
    } catch (err) {
      logger.error('Error closing Redis connection', { error: err.message, stack: err.stack });
    }
  },
};