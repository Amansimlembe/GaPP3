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
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        logger.error('Redis reconnection failed after 10 attempts');
        return new Error('Redis reconnection failed');
      }
      return Math.min(retries * 100, 2000);
    },
  },
});

redisClient.on('connect', () => logger.info('Connected to Redis'));
redisClient.on('error', (err) => logger.error('Redis client error', { error: err.message }));
redisClient.on('reconnecting', () => logger.info('Reconnecting to Redis'));
redisClient.on('end', () => logger.warn('Redis connection closed'));

(async () => {
  try {
    await redisClient.connect();
  } catch (err) {
    logger.error('Failed to connect to Redis on startup', { error: err.message });
  }
})();

module.exports = {
  client: redisClient,
  get: async (key) => await redisClient.get(key),
  set: async (key, value) => await redisClient.set(key, value),
  setex: async (key, seconds, value) => await redisClient.setEx(key, seconds, value),
  del: async (key) => await redisClient.del(key),
  lpush: async (key, value) => await redisClient.lPush(key, value),
  lrange: async (key, start, stop) => await redisClient.lRange(key, start, stop),
  quit: async () => {
    try {
      await redisClient.quit();
      logger.info('Redis connection closed gracefully');
    } catch (err) {
      logger.error('Error closing Redis connection', { error: err.message });
    }
  },
};