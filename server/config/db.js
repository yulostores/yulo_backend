import mongoose from 'mongoose';
import { env } from './env.js';
import logger from '../utils/logger.js';

const MAX_RETRIES = 5;

export async function connectDB() {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await mongoose.connect(env.MONGODB_URI);
      logger.info('MongoDB connected');
      break;
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        logger.error({ err }, 'MongoDB connection failed after max retries');
        process.exit(1);
      }
      const delay = 1000 * Math.pow(2, attempt);
      logger.warn(
        { err, attempt: attempt + 1, maxRetries: MAX_RETRIES },
        `MongoDB connection failed. Retrying in ${delay / 1000}s...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  mongoose.connection.on('error', (err) => {
    logger.error({ err }, 'MongoDB error');
  });

  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected');
  });
}
