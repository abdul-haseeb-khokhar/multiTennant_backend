import { LogLevel, LoggerService } from '@nestjs/common';

/**
 * Nest `LoggerService` that prints one JSON object per line (F3). A string message becomes
 * `{ message }`; an object message is merged in, so callers can attach `requestId`, `tenantId`,
 * `conversationId`, etc. Errors go to stderr, everything else to stdout.
 */
export class JsonLogger implements LoggerService {
  log(message: unknown, ...rest: unknown[]) {
    this.write('log', message, rest);
  }
  error(message: unknown, ...rest: unknown[]) {
    this.write('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]) {
    this.write('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]) {
    this.write('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]) {
    this.write('verbose', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]) {
    this.write('fatal', message, rest);
  }

  private write(level: LogLevel, message: unknown, rest: unknown[]) {
    // Nest passes the context name as the last string argument.
    const last = rest[rest.length - 1];
    const context = typeof last === 'string' ? last : undefined;
    const extra =
      typeof message === 'object' && message !== null
        ? (message as Record<string, unknown>)
        : { message };

    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      context,
      ...extra,
    });
    (level === 'error' || level === 'fatal'
      ? process.stderr
      : process.stdout
    ).write(`${line}\n`);
  }
}
