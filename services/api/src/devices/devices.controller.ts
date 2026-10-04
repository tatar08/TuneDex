import { Body, Controller, Delete, Get, HttpStatus, Param, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { ApiError } from '../common/api-error';
import { parseDeviceId, parseDeviceReport, REAUTH_MAX_AGE_SECONDS } from './devices.schema';
import { DevicesService, DeviceView } from './devices.service';

@Controller('v1/me/devices')
@UseGuards(AuthGuard)
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  async list(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.devices.list(req.actor!.userId);
  }

  /** Called by the phone app at sign-in and on each sync to report its build and applied settings revision. */
  @Put(':deviceId')
  async report(
    @Req() req: Request,
    @Param('deviceId') deviceId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeviceView> {
    res.setHeader('Cache-Control', 'no-store');
    return this.devices.report(req.actor!.userId, parseDeviceId(deviceId), parseDeviceReport(body));
  }

  /** Signs a device out of the account. Requires the user to have signed in within the last 5 minutes. */
  @Delete(':deviceId/session')
  async revoke(@Req() req: Request, @Param('deviceId') deviceId: string): Promise<DeviceView> {
    const id = parseDeviceId(deviceId);
    const authTime = req.actor!.authTime;
    if (authTime === undefined || Date.now() / 1000 - authTime > REAUTH_MAX_AGE_SECONDS) {
      throw new ApiError(HttpStatus.UNAUTHORIZED, 'REAUTH_REQUIRED', { maxAgeSeconds: REAUTH_MAX_AGE_SECONDS });
    }
    return this.devices.revoke(req.actor!.userId, id, req.requestId);
  }
}
