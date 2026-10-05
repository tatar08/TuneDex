import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiError, ErrorCode, MESSAGE_KEYS } from './api-error';
import { StructuredLogger } from './logger';

@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  constructor(private readonly logger: StructuredLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const { status, code, details } = this.classify(exception, req);
    if (status >= 500 && code === 'INTERNAL') {
      const err = exception as { name?: string; code?: string };
      this.logger.log('ERROR', {
        eventCode: 'UNHANDLED_ERROR',
        requestId: req.requestId,
        traceId: req.traceId,
        errorName: err?.name,
        errorCode: typeof err?.code === 'string' ? err.code : undefined,
      });
    }
    res
      .status(status)
      .setHeader('Cache-Control', 'no-store')
      .json({ code, messageKey: MESSAGE_KEYS[code], requestId: req.requestId, details });
  }

  private classify(
    exception: unknown,
    req: Request,
  ): { status: number; code: ErrorCode; details: Record<string, unknown> } {
    if (exception instanceof ApiError) {
      return { status: exception.status, code: exception.code, details: exception.details };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status === HttpStatus.NOT_FOUND) return { status, code: 'NOT_FOUND', details: {} };
      if (status === HttpStatus.PAYLOAD_TOO_LARGE) return { status, code: 'PAYLOAD_TOO_LARGE', details: {} };
      if (status === HttpStatus.BAD_REQUEST) return { status, code: 'VALIDATION_FAILED', details: {} };
    }
    // Body-parser errors (malformed JSON, oversize body) arrive as plain errors carrying a status.
    const parserStatus = (exception as { status?: number; type?: string })?.status;
    if (parserStatus === 413) return { status: 413, code: 'PAYLOAD_TOO_LARGE', details: {} };
    if (parserStatus === 400) return { status: 400, code: 'VALIDATION_FAILED', details: { reason: 'malformed_body' } };
    void req;
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, code: 'INTERNAL', details: {} };
  }
}
