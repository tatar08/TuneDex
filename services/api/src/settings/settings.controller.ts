import { Body, Controller, Get, Headers, Patch, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { parseIfMatch, parseSettingsPatch } from './settings.schema';
import { SettingsService, SettingsView } from './settings.service';

function send(res: Response, view: SettingsView): SettingsView {
  res.setHeader('ETag', `"${view.revision}"`);
  res.setHeader('Cache-Control', 'no-store');
  return view;
}

@Controller('v1/me/settings')
@UseGuards(AuthGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  async get(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<SettingsView> {
    return send(res, await this.settings.get(req.actor!.userId));
  }

  @Patch()
  async patch(
    @Req() req: Request,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SettingsView> {
    const expected = parseIfMatch(ifMatch);
    const patch = parseSettingsPatch(body);
    return send(res, await this.settings.patch(req.actor!.userId, expected, patch));
  }
}
