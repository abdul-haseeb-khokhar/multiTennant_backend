import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { requestStore } from './request-store';

/**
 * Makes the request id, client IP and user agent available to services (the audit log) for the
 * duration of the handler. It is an interceptor rather than part of the Express middleware so the
 * context starts after body parsing, which can drop AsyncLocalStorage context.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const req = context.switchToHttp().getRequest();
    const meta = {
      requestId: req.id as string | undefined,
      ip: req.ip as string | undefined,
      userAgent: req.headers?.['user-agent'] as string | undefined,
    };
    // Returning the inner subscription lets an aborted request cancel the handler's stream.
    return new Observable((subscriber) =>
      requestStore.run(meta, () => next.handle().subscribe(subscriber)),
    );
  }
}
