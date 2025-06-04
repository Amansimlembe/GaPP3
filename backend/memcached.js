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
    timeout: 1, // Increased timeout
    retries: 10, // More retries
    retry: 3000, // Longer retry delay
    remove: true,
    username: process.env.MEMCACHED_USERNAME,
    password: process.env.MEMCACHED_PASSWORD,
    reconnect: true,
    maxExpiration: 2592000,
    failover: true, // Enable failover to other servers
    failoverTime: 60, // Seconds before retrying failed server
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
    if (!key) {
      logger.warn('Invalid key provided', { key });
      resolve(null);
      return;
    }
    memcached.get(key, (err, data) => {
      if (err) {
        logger.error('Memcached get failed', { key, error: err.message });
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
        cache.put(key, data, 3600 * 1000); // Cache in memory for 1 hour
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
    if (!key || !value || lifetime <= 0) {
      logger.warn('Invalid setex parameters', { key, lifetime });
      reject(new Error('Invalid parameters'));
      return;
    }
    memcached.set(key, value, lifetime, (err) => {
      if (err) {
        logger.error('Memcached setex failed', { key, error: err.message });
        cache.put(key, value, lifetime * 1000);
        logger.info('Stored in memory-cache fallback', { key });
        resolve(); // Resolve to avoid blocking
        return;
      }
      logger.info('Memcached setex success', { key, lifetime });
      cache.put(key, value, lifetime * 1000);
      resolve();
    });
  });
};

const del = (key) => {
  return new Promise((resolve, reject) => {
    if (!key) {
      logger.warn('Invalid key provided', { key });
      reject(new Error('Invalid key'));
      return;
    }
    memcached.del(key, (err) => {
      if (err) {
        logger.error('Memcached del failed', { key, error: err.message });
        cache.del(key);
        logger.info('Deleted from memory-cache fallback', { key });
        resolve(); // Resolve to avoid blocking
        return;
      }
      logger.info('Memcached del success', { key });
      cache.del(key);
      resolve();
    });
  });
};

module.exports = { get, setex, del };