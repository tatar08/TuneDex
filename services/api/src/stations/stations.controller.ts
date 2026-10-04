import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { requireRecentMfa } from '../auth/recent-sign-in';
import { ApiError } from '../common/api-error';
import { decodeCursor, parseLimit } from '../common/pagination';
import { parseIfMatch } from '../settings/settings.schema';
import { RequireRoles, StaffGuard } from '../staff/staff';
import { parseRightsRecord, RightsRecordView } from './rights';
import { parseNewStation, parsePublish, parseReason, parseStationId, parseStationPatch } from './stations.schema';
import { HealthCheck, StationHealth, StationHealthService } from './station-health';
import { AdminStationView, HistoryEntry, StationActor, StationsService } from './stations.service';

const actorOf = (req: Request): StationActor => ({ userId: req.actor!.userId, roles: req.actor!.roles ?? [], requestId: req.requestId });

type WithHealth = AdminStationView & { health: StationHealth };

/** Staff catalog management (Doc 17 /admin/stations). Editors draft; a different admin publishes. */
@Controller('v1/admin/stations')
@UseGuards(AuthGuard, StaffGuard)
@RequireRoles('catalog_editor', 'admin')
export class AdminStationsController {
  constructor(
    private readonly stations: StationsService,
    private readonly health: StationHealthService,
  ) {}

  private async send(res: Response, view: AdminStationView): Promise<WithHealth> {
    res.setHeader('ETag', `"${view.revision}"`);
    res.setHeader('Cache-Control', 'no-store');
    return { ...view, health: await this.health.summary(view.id) };
  }

  @Get()
  async list(@Req() req: Request, @Query('cursor') cursor: unknown, @Query('limit') limit: unknown, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const page = await this.stations.list(actorOf(req), decodeCursor(cursor, 2), parseLimit(limit));
    const health = await this.health.summaries(page.stations.map((v) => v.id));
    return {
      stations: page.stations.map((v): WithHealth => ({ ...v, health: health.get(v.id) ?? { state: 'unknown', regions: [] } })),
      nextCursor: page.nextCursor,
    };
  }

  @Get(':id')
  async get(@Req() req: Request, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    return this.send(res, await this.stations.get(actorOf(req), parseStationId(id)));
  }

  /** The last checks of this station's stream, newest first, with result codes only. */
  @Get(':id/health')
  async healthHistory(@Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<{ checks: HealthCheck[] }> {
    res.setHeader('Cache-Control', 'no-store');
    return { checks: await this.health.history(parseStationId(id)) };
  }

  /** Checks the stream now (Doc 17 bounds apply). At most once a minute per station; audited. */
  @Post(':id/check')
  @HttpCode(HttpStatus.OK)
  async check(@Req() req: Request, @Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<HealthCheck> {
    res.setHeader('Cache-Control', 'no-store');
    return this.health.checkNow(actorOf(req), parseStationId(id));
  }

  /** The station's rights records, newest first, with private evidence keys (staff only, never in the catalog). */
  @Get(':id/rights')
  async rights(@Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<{ records: RightsRecordView[] }> {
    res.setHeader('Cache-Control', 'no-store');
    return { records: await this.stations.listRights(parseStationId(id)) };
  }

  /** Adds a rights record; the publish gate and the public catalog follow it at once. Audited as rights.add. */
  @Post(':id/rights')
  @HttpCode(HttpStatus.CREATED)
  async addRights(@Req() req: Request, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<RightsRecordView> {
    res.setHeader('Cache-Control', 'no-store');
    const stationId = parseStationId(id);
    return this.stations.addRights(actorOf(req), stationId, parseRightsRecord(body));
  }

  /** Revokes a rights record with `{ reason }`. Audited as rights.revoke. */
  @Post(':id/rights/:recordId/revoke')
  @HttpCode(HttpStatus.OK)
  async revokeRights(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('recordId') recordId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RightsRecordView> {
    res.setHeader('Cache-Control', 'no-store');
    const stationId = parseStationId(id);
    const record = parseStationId(recordId, 'recordId');
    return this.stations.revokeRights(actorOf(req), stationId, record, parseReason(body));
  }

  /** Version history: the station's station.* and rights.* audit events, newest first, in cursor pages (50, max 100). */
  @Get(':id/history')
  async history(
    @Param('id') id: string,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ events: HistoryEntry[]; nextCursor: string | null }> {
    res.setHeader('Cache-Control', 'no-store');
    const stationId = parseStationId(id);
    const after = decodeCursor(cursor, 1);
    return this.stations.history(stationId, after ? after[0] : null, parseLimit(limit));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Req() req: Request, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.send(res, await this.stations.create(actorOf(req), parseNewStation(body)));
  }

  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const stationId = parseStationId(id);
    const expected = parseIfMatch(ifMatch);
    return this.send(res, await this.stations.update(actorOf(req), stationId, expected, parseStationPatch(body)));
  }

  /** If-Match names the draft revision the admin reviewed, so a later edit cannot slip into the publish. */
  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @RequireRoles('admin')
  async publish(
    @Req() req: Request,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const stationId = parseStationId(id);
    const expected = parseIfMatch(ifMatch);
    const { reason, emergency } = parsePublish(body);
    requireRecentMfa(req);
    return this.send(res, await this.stations.publish(actorOf(req), stationId, expected, reason, emergency));
  }

  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  @RequireRoles('admin')
  async disable(@Req() req: Request, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.send(res, await this.stations.setDisabled(actorOf(req), parseStationId(id), true, parseReason(body)));
  }

  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  @RequireRoles('admin')
  async enable(@Req() req: Request, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.send(res, await this.stations.setDisabled(actorOf(req), parseStationId(id), false, parseReason(body)));
  }
}

/** Public, sign-in-free catalog for the apps (Doc 17 GET /catalog/radio). Rate limiting belongs at the gateway. */
@Controller('v1/catalog/radio')
export class CatalogController {
  constructor(private readonly stations: StationsService) {}

  @Get()
  async page(
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (cursor !== undefined && typeof cursor !== 'string') throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field: 'cursor', reason: 'malformed' });
    if (limit !== undefined && (typeof limit !== 'string' || !/^\d{1,3}$/.test(limit))) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field: 'limit', reason: 'out_of_range' });
    }
    const result = await this.stations.publicPage(cursor || undefined, limit ? Number(limit) : 50);
    res.setHeader('ETag', result.etag);
    res.setHeader('Cache-Control', 'public, max-age=300');
    if (ifNoneMatch === result.etag) {
      res.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }
    return { stations: result.stations, nextCursor: result.nextCursor };
  }
}
