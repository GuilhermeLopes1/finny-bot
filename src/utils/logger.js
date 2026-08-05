'use strict';

let logger;
try {
  const winston = require('winston');
  const { combine, timestamp, printf, colorize, errors } = winston.format;
  const logFormat = printf(({ level, message, timestamp: at, stack }) => `${at} [${level}]: ${stack || message}`);
  logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), errors({ stack: true }), logFormat),
    transports: [
      new winston.transports.Console({ format: combine(colorize(), timestamp({ format: 'HH:mm:ss' }), logFormat) }),
      new winston.transports.File({ filename: 'logs/error.log', level: 'error', maxsize: 5242880, maxFiles: 5 }),
      new winston.transports.File({ filename: 'logs/combined.log', maxsize: 5242880, maxFiles: 5 }),
    ],
  });
} catch (error) {
  // Mantém testes, scripts de migração e ambientes mínimos funcionais quando
  // as dependências ainda não foram instaladas. Em produção, Winston continua
  // sendo usado normalmente pelo package.json.
  const write=(method,...args)=>console[method]?.(...args);
  logger={
    error:(...args)=>write('error',...args),warn:(...args)=>write('warn',...args),
    info:(...args)=>write('info',...args),debug:(...args)=>write('debug',...args),
  };
}

module.exports = logger;
