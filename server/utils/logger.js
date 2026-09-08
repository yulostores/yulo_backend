import pino from 'pino';

const isTest = process.env.NODE_ENV === 'test';
const isDev = process.env.NODE_ENV !== 'production' && !isTest;

let transport;
if (isDev) {
  try {
    transport = pino.transport({ target: 'pino-pretty', options: { colorize: true } });
  } catch {
    // pino-pretty not available — fall back to plain pino
  }
}

// Silent under `node --test` so a run's output is the test report, not request logs.
// Set LOG_LEVEL to override in any environment (e.g. LOG_LEVEL=debug npm test).
const level = process.env.LOG_LEVEL || (isTest ? 'silent' : isDev ? 'debug' : 'info');

const logger = pino({ level }, transport);

export default logger;
