import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Database } from '../db/database';

/** Infrastructure probes; expose only up/down, never dependency details. */
@Controller('health')
export class HealthController {
  constructor(private readonly db: Database) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<{ status: 'ok' | 'unavailable' }> {
    const ok = await this.db.ping();
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ok' : 'unavailable' };
  }
}
