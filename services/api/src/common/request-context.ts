import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { StructuredLogger, Severity } from './logger';

export interface Actor {
  userId: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
    actor?: Actor;
  }
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Assigns a requestId (reusing a well-formed inbound X-Request-Id) and writes one redacted log line per request. */
export function requestContext(logger: StructuredLogger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const inbound = req.header('x-request-id');
    req.requestId = inbound && SAFE_REQUEST_ID.test(inbound) ? inbound : `req_${randomUUID()}`;
    res.setHeader('X-Request-Id', req.requestId);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const status = res.statusCode;
      const severity: Severity = status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : 'INFO';
      logger.log(severity, {
        eventCode: 'HTTP_REQUEST',
        requestId: req.requestId,
        method: req.method,
        // Matched route template when known; never the raw URL with its query string.
        route: req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched',
        status,
        durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
        actorId: req.actor?.userId,
      });
    });
    next();
  };
}
