const redis = require('redis');
const { promisify } = require('util');
const winston = require('winston');

// Logger setup for Redis-specific logs
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/redis-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/redis-combined.log' }),
  ],
});

// Redis client configuration
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379', // Default to localhost if no env var
  socket: {
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        logger.error('Redis reconnection failed after 10 attempts');
        return new Error('Redis reconnection failed');
      }
      return Math.min(retries * 100, 2000); // Exponential backoff, max 2s delay
    },
  },
});

// Handle Redis connection events
redisClient.on('connect', () => {
  logger.info('Connected to Redis');
});

redisClient.on('error', (err) => {
  logger.error('Redis client error', { error: err.message });
});

redisClient.on('reconnecting', () => {
  logger.info('Reconnecting to Redis');
});

redisClient.on('end', () => {
  logger.warn('Redis connection closed');
});

// Promisify Redis methods for async/await usage
const getAsync = promisify(redisClient.get).bind(redisClient);
const setAsync = promisify(redisClient.set).bind(redisClient);
const setexAsync = promisify(redisClient.setex).bind(redisClient);
const delAsync = promisify(redisClient.del).bind(redisClient);
const lpushAsync = promisify(redisClient.lpush).bind(redisClient);
const lrangeAsync = promisify(redisClient.lrange).bind(redisClient);

// Connect to Redis on module load
(async () => {
  try {
    await redisClient.connect();
  } catch (err) {
    logger.error('Failed to connect to Redis on startup', { error: err.message });
  }
})();

// Export promisified methods and raw client for flexibility
module.exports = {
  client: redisClient,
  get: getAsync,
  set: setAsync,
  setex: setexAsync,
  del: delAsync,
  lpush: lpushAsync,
  lrange: lrangeAsync,
  quit: async () => {
    try {
      await redisClient.quit();
      logger.info('Redis connection closed gracefully');
    } catch (err) {
      logger.error('Error closing Redis connection', { error: err.message });
    }
  },
};