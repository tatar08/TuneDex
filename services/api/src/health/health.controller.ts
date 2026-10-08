import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Database } from '../db/database';

/** Infrastructure probes; expose only up/down, never dependency details. */
@Controller('health')
export class HealthController {
  private draining = false;

  constructor(private readonly db: Database) {}

  /** On shutdown: readiness turns 503 so the load balancer stops sending new requests before the server closes. */
  drain(): void {
    this.draining = true;
  }

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<{ status: 'ok' | 'unavailable' }> {
    const ok = !this.draining && (await this.db.ping());
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ok' : 'unavailable' };
  }
}
