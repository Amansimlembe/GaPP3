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

const redisClient = redis.createClient({
  url: `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`,
  password: process.env.REDIS_PASSWORD,
  socket: {
    connectTimeout: 10000, // Increased from default 5000ms to 10000ms
    keepAlive: 1000, // Enable keep-alive every 1s to detect issues early
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
});

redisClient.on('connect', () => logger.info('Connected to Redis'));
redisClient.on('error', (err) => logger.error('Redis client error', { error: err.message, stack: err.stack }));
redisClient.on('reconnecting', () => logger.info('Reconnecting to Redis'));
redisClient.on('end', () => logger.warn('Redis connection closed'));

// Graceful startup
(async () => {
  try {
    await redisClient.connect();
    logger.info('Redis client initialized successfully');
  } catch (err) {
    logger.error('Failed to connect to Redis on startup', { error: err.message, stack: err.stack });
  }
})();

// Handle uncaught errors during runtime
redisClient.on('error', async (err) => {
  logger.error('Unhandled Redis error', { error: err.message });
  if (!redisClient.isOpen) {
    try {
      await redisClient.connect();
      logger.info('Redis reconnected after unhandled error');
    } catch (reconnectErr) {
      logger.error('Reconnection attempt failed', { error: reconnectErr.message });
    }
  }
});

module.exports = {
  client: redisClient,
  get: async (key) => {
    try {
      return await redisClient.get(key);
    } catch (err) {
      logger.error('Redis get error', { key, error: err.message });
      throw err;
    }
  },
  set: async (key, value) => {
    try {
      return await redisClient.set(key, value);
    } catch (err) {
      logger.error('Redis set error', { key, error: err.message });
      throw err;
    }
  },
  setex: async (key, seconds, value) => {
    try {
      return await redisClient.setEx(key, seconds, value);
    } catch (err) {
      logger.error('Redis setex error', { key, seconds, error: err.message });
      throw err;
    }
  },
  del: async (key) => {
    try {
      return await redisClient.del(key);
    } catch (err) {
      logger.error('Redis del error', { key, error: err.message });
      throw err;
    }
  },
  lpush: async (key, value) => {
    try {
      return await redisClient.lPush(key, value);
    } catch (err) {
      logger.error('Redis lpush error', { key, error: err.message });
      throw err;
    }
  },
  lrange: async (key, start, stop) => {
    try {
      return await redisClient.lRange(key, start, stop);
    } catch (err) {
      logger.error('Redis lrange error', { key, start, stop, error: err.message });
      throw err;
    }
  },
  quit: async () => {
    try {
      if (redisClient.isOpen) {
        await redisClient.quit();
        logger.info('Redis connection closed gracefully');
      }
    } catch (err) {
      logger.error('Error closing Redis connection', { error: err.message, stack: err.stack });
    }
  },
};