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

// Validate and construct REDIS_URL
const validateRedisConfig = () => {
  const redisUrl = process.env.REDIS_URL;
  const redisHost = process.env.REDIS_HOST || 'localhost';
  const redisPort = process.env.REDIS_PORT || 6379;
  const redisPassword = process.env.REDIS_PASSWORD;

  if (redisUrl) {
    try {
      new URL(redisUrl);
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
    ? `${protocol}://default:${redisPassword}@${redisHost}:${redisPort}`
    : `${protocol}://${redisHost}:${redisPort}`;
  logger.info('Constructed Redis URL', { url: url.replace(/:[^@]+@/, ':****@') });
  return url;
};

const REDIS_URL = validateRedisConfig();

const redisClient = redis.createClient({
  url: REDIS_URL,
  socket: {
    connectTimeout: 15000,
    keepAlive: 1000,
    reconnectStrategy: (retries) => {
      if (retries > 20) {
        logger.error('Redis reconnection failed after 20 attempts', { retries });
        return new Error('Redis reconnection failed');
      }
      const delay = Math.min(retries * 200, 5000);
      logger.info('Reconnect attempt', { retries, delay });
      return delay;
    },
    // Enhanced DNS resolution with fallback servers
    lookup: (hostname, opts, callback) => {
      const dns = require('dns');
      const dnsServers = ['8.8.8.8', '1.1.1.1']; // Google and Cloudflare DNS
      let lastError = null;

      const tryResolve = (index) => {
        if (index >= dnsServers.length) {
          logger.error('DNS resolution failed for all servers', { hostname, error: lastError?.message });
          return callback(lastError);
        }

        dns.resolve4(hostname, { ttl: true, resolver: dnsServers[index] }, (err, addresses) => {
          if (err) {
            lastError = err;
            logger.warn('DNS resolution attempt failed', {
              hostname,
              dnsServer: dnsServers[index],
              error: err.message,
            });
            return tryResolve(index + 1);
          }
          logger.info('DNS resolved', { hostname, address: addresses[0], dnsServer: dnsServers[index] });
          callback(null, addresses[0], 4);
        });
      };

      tryResolve(0);
    },
  },
  disableOfflineQueue: true,
});

redisClient.on('connect', () => logger.info('Connected to Redis'));
redisClient.on('reconnecting', () => logger.info('Reconnecting to Redis'));
redisClient.on('end', () => logger.warn('Redis connection closed'));
redisClient.on('error', (err) => logger.error('Redis client error', { error: err.message, stack: err.stack }));

let isRedisAvailable = false;

(async () => {
  let attempts = 0;
  const maxAttempts = 10;
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
        logger.warn('Redis connection failed after max attempts, continuing without caching');
        isRedisAvailable = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempts));
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