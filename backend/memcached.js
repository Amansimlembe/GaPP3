const Memcached = require('memcached');
const winston = require('winston');
const cache = require('memory-cache');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/memcached-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/memcached-combined.log' }),
  ],
});

const memcachedConfig = {
  servers: process.env.MEMCACHED_SERVERS || 'localhost:11211',
  options: {
    timeout: 0.5, // Connection timeout in seconds
    retries: 5,   // Increased retries
    retry: 2000,  // Increased retry delay in ms
    remove: true, // Remove failed servers from pool
    username: process.env.MEMCACHED_USERNAME,
    password: process.env.MEMCACHED_PASSWORD,
    reconnect: true, // Enable automatic reconnection
    maxExpiration: 2592000, // 30 days max expiration
  },
};

const memcached = new Memcached(memcachedConfig.servers, memcachedConfig.options);

memcached.on('failure', (details) => {
  logger.error('Memcached server failure', { server: details.server, error: details.message });
});

memcached.on('reconnecting', (details) => {
  logger.info('Memcached reconnecting', { server: details.server, attempts: details.totalAttempts });
});

memcached.on('reconnect', (details) => {
  logger.info('Memcached reconnected', { server: details.server });
});

const get = (key) => {
  return new Promise((resolve) => {
    memcached.get(key, (err, data) => {
      if (err) {
        logger.error('Memcached get failed', { key, error: err.message });
        // Fallback to memory-cache
        const fallback = cache.get(key);
        if (fallback) {
          logger.info('Served from memory-cache fallback', { key });
          resolve(fallback);
        } else {
          logger.warn('No cache hit, falling back to MongoDB', { key });
          resolve(null);
        }
        return;
      }
      if (data) {
        logger.info('Memcached get success', { key });
        resolve(data);
      } else {
        const fallback = cache.get(key);
        if (fallback) {
          logger.info('Served from memory-cache fallback', { key });
          resolve(fallback);
        } else {
          logger.info('Cache miss, falling back to MongoDB', { key });
          resolve(null);
        }
      }
    });
  });
};

const setex = (key, lifetime, value) => {
  return new Promise((resolve, reject) => {
    memcached.set(key, value, lifetime, (err) => {
      if (err) {
        logger.error('Memcached setex failed', { key, error: err.message });
        cache.put(key, value, lifetime * 1000); // Fallback to memory-cache
        return reject(err);
      }
      logger.info('Memcached setex success', { key, lifetime });
      cache.put(key, value, lifetime * 1000); // Sync with memory-cache
      resolve();
    });
  });
};

const del = (key) => {
  return new Promise((resolve, reject) => {
    memcached.del(key, (err) => {
      if (err) {
        logger.error('Memcached del failed', { key, error: err.message });
        cache.del(key); // Fallback to memory-cache
        return reject(err);
      }
      logger.info('Memcached del success', { key });
      cache.del(key); // Sync with memory-cache
      resolve();
    });
  });
};

module.exports = { get, setex, del };