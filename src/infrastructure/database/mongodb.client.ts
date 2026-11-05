import mongoose from 'mongoose';
import { logger } from '../../shared/logging/logger';
import { MONGODB_DATABASE, MONGODB_URI } from './mongodb.env';

/** [monitorCommands] lets telemetry time each command (telemetry/gauges.ts). */
export const connect = async (options: { monitorCommands?: boolean } = {}) => {
  let connectionString = MONGODB_URI;
  const url = new URL(MONGODB_URI);
  url.pathname = `/${MONGODB_DATABASE}`;
  connectionString = url.toString();

  logger.info(`Connecting to MongoDB`);

  await mongoose.connect(connectionString, { monitorCommands: options.monitorCommands ?? false });

  logger.info('MongoDB connected!');

  mongoose.connection.on('error', (error) => {
    logger.error('MongoDB error:', error);
  });

  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected');
  });

  mongoose.connection.on('reconnected', () => {
    logger.info('MongoDB reconnected!');
  });
}

export const disconnect = async () => {
  try {
    await mongoose.disconnect();
    logger.info('MongoDB disconnected');
  } catch (error) {
    logger.error('Error disconnecting MongoDB:', error);
  }
}