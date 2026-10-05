import { randomBytes, randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { StructuredLogger, Severity, traceScope } from './logger';

export interface Actor {
  userId: string;
  /** When the user last actually authenticated (OIDC `auth_time`, epoch seconds), if the token says. */
  authTime?: number;
  /** Keycloak session id (`sid`), when the token carries one. */
  sid?: string;
  /** When MFA was last proven (auth_time of a token whose acr counts as MFA); `mfaRequired` false in dev without STAFF_MFA_ACR. */
  mfaAt?: number;
  mfaRequired?: boolean;
  /** Staff roles, filled in by StaffGuard on staff routes only. */
  roles?: string[];
}

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
    /** W3C trace id: from a valid inbound `traceparent`, else a new trace. */
    traceId: string;
    actor?: Actor;
  }
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;

export interface TraceParent {
  traceId: string;
  parentId: string;
  flags: string;
}

/**
 * Parses a W3C Trace Context `traceparent` header. Null when absent or invalid: version ff, all-zero ids,
 * uppercase hex, or anything after the flags on version 00. Later versions are read by their 00 prefix.
 */
export function parseTraceparent(header: string | undefined): TraceParent | null {
  const m = header ? TRACEPARENT.exec(header.trim()) : null;
  if (!m) return null;
  const [, version, traceId, parentId, flags, rest] = m;
  if (version === 'ff' || (version === '00' && rest !== undefined)) return null;
  if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) return null;
  return { traceId, parentId, flags };
}

/** Assigns a requestId (reusing a well-formed inbound X-Request-Id) and writes one redacted log line per request. */
export function requestContext(logger: StructuredLogger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const inbound = req.header('x-request-id');
    req.requestId = inbound && SAFE_REQUEST_ID.test(inbound) ? inbound : `req_${randomUUID()}`;
    res.setHeader('X-Request-Id', req.requestId);
    // Join the caller's trace when it sent a valid traceparent, else start one. Our own span id goes back
    // in the response's traceparent so the caller can link to this hop; its flags are kept as sent.
    const parent = parseTraceparent(req.header('traceparent'));
    req.traceId = parent?.traceId ?? randomBytes(16).toString('hex');
    res.setHeader('traceparent', `00-${req.traceId}-${randomBytes(8).toString('hex')}-${parent?.flags ?? '01'}`);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const status = res.statusCode;
      const severity: Severity = status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : 'INFO';
      logger.log(severity, {
        eventCode: 'HTTP_REQUEST',
        requestId: req.requestId,
        traceId: req.traceId,
        method: req.method,
        // Matched route template when known; never the raw URL with its query string.
        route: req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched',
        status,
        durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
        actorId: req.actor?.userId,
      });
    });
    traceScope.run({ traceId: req.traceId }, next);
  };
}
