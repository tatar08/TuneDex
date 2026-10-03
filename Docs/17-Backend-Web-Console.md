# Backend, Web Portal, Login and Operations Console

Revision 0.2 · Proposed implementation contract · Owner: Backend/web lead + security/operations

## Scope and users

R1 ต้องมี Backend API และเว็บใช้งานจริงใน scope การพัฒนา: customer portal สำหรับตั้งค่าของตน และ staff console สำหรับ catalog/config/monitor/logs. ไม่ใช่เว็บรับชมวิดีโอหรือ remote-control รถ. Stack ตาม [05](05-Technical-Architecture.md); APIs ใช้ mobile และ web ผ่าน BFF

## Login and account lifecycle

OIDC provider (Keycloak default) จัดการ password hashing, verification, password reset และ MFA ไม่ทำ password endpoint เองใน NestJS. Mobile เป็น public client + PKCE S256/state/nonce/system browser/verified app links; web BFF เป็น confidential client พร้อม exact redirect URI allowlist. ห้าม wildcard redirect, implicit flow, password grant หรือเก็บ access/refresh token ใน browser localStorage

Register → verify email → active account; staff ผ่าน invitation + MFA เท่านั้น. Reset response ไม่เปิดเผยว่ามี email ในระบบหรือไม่; rate-limit login/reset; invalid/expired link มี retry path. ไม่มี social login R1 จนประเมิน store requirements และ account linking

Proposed durations: access token 5 นาที; refresh rotation + reuse detection; mobile refresh idle 30 วัน; web user session idle 12 ชั่วโมง; staff idle 30 นาที / absolute 12 ชั่วโมง; privileged config/RBAC/export operations ต้อง recent MFA ภายใน 5 นาที. Session revoke และ staff role changes invalidate BFF session ทันทีและ API privilege cache ≤60s; security-critical writes ตรวจ current role/session กับ server ทุกครั้ง

API validate issuer/audience/signature/expiry จาก JWKS ตาม configured algorithm; JWKS rotation/cache bounded. Unknown key/offline identity ที่ไม่มี verified key ใช้ fail closed สำหรับ auth ไม่รับ token โดย skip validation. Offline mobile playback ไม่ต้องใช้ API auth

Account deletion: re-auth → mark deleting/revoke sessions → async purge profile/sync/device/diagnostic data ภายใน 30 วัน; exports ลบ ≤24h, immutable minimal audit ตาม retention ไม่เก็บ email/content. Backup expiry ≤35 วัน; disaster restore ต้อง replay deletion ledger ก่อนเปิดบริการ. Purchase ledger ที่ต้องคงเพื่อป้องกัน replay เก็บ minimal/pseudonymous และให้ owner ยืนยัน retention. UI บอกว่า deleting/completed/failed ไม่อ้างเสร็จก่อน jobs จบ

## RBAC / ownership

| Role | Allowed | Not allowed |
|---|---|---|
| user | own settings/devices/favorites/diagnostics/export/delete | other users, global logs/config/catalog writes |
| support | redacted case diagnostics ที่ได้รับสิทธิ์, device sync status | private URLs, global security logs, roles, billing grants |
| catalog_editor | station drafts, rights evidence, health results | publish own change, account access |
| operator | operational metrics/redacted logs, approved job retries | change roles, read private user library, grant purchase |
| admin | publish config/catalog, assign scoped staff roles with MFA | bypass verification or read stream secrets that are not stored |
| auditor | audit trail read, audit export with reason | mutate config/catalog or delete audit |

API guards + owner query scopes ทุก endpoint รวม background jobs, exports และ log query facade. ID guessing ต้อง 404/403 ตาม convention เดียวกัน; never rely on hidden frontend buttons. Catalog publish ใช้ actor คนละคนกับ author; emergency single-admin exception ต้อง recent MFA + reason + explicit audit แล้วตาม review ไม่แอบ bypass

## Website information architecture

| Route | Main actions / states | Acceptance |
|---|---|---|
| /login /register /recover | redirect IdP, return, verification, expired/MFA error | no open redirect/session fixation |
| /app/overview | own devices + last successful sync + service status | timestamps/timezone; offline != online |
| /app/settings | theme, language, cellular policy; global/device overrides | validate, preview effective config, save with revision |
| /app/radio | approved catalog + own favorites/order | offline device receives on next sync; no forced play |
| /app/devices | OS/build/lastSeen, revoke/reset override | re-auth revoke; local playback remains possible |
| /app/privacy | diagnostic consent/history/export/delete account | clear scopes, progress/error/retry |
| /admin/overview | error/latency/queue health, incidents | time window + sample count + stale state |
| /admin/stations | search/draft/edit/rights/review/publish/disable | history/version, no unlicensed auto-publish |
| /admin/config | environment/platform/version targeting, diff, publish/rollback | incompatible clients ignored; author/reason/revision logged |
| /admin/logs | time/service/build/severity/error/trace filters | bounded/paginated, redacted, RBAC query and export audit |
| /admin/jobs | pending/retry/dead-letter, age and attempts | idempotent authorized retry; no arbitrary command execution |
| /admin/users | minimal identity/support lookup, staff invitations | private library inaccessible by default |
| /admin/audit | who/what/when/reason/change summary | append-only to app roles; privileged access logged |

ทุกหน้ามี loading/empty/error/unauthorized/stale/success, keyboard navigation, visible focus และ Thai/English labels. Admin logs ไม่ render HTML จาก message; use escaped plain text; ไม่ใช้ auto-refresh เปลี่ยนแถวจนผู้ใช้อ่านไม่ได้

## REST contract v1

Base `/v1`; JSON camelCase; UUID identifiers; RFC3339 UTC dates; cursor pagination limit default 50/max 100. Error envelope `{code,messageKey,requestId,details}` ที่ไม่มี tokens/PII. GET ไม่ mutate. Browser cookie routes ผ่าน BFF มี CSRF token/Origin check; API CORS allowlist แยก environments

| Method / path | Auth / purpose |
|---|---|
| GET /me | user identity/profile, no provider refresh token |
| GET /me/settings | account revision + allowed preferences |
| PATCH /me/settings | owner; If-Match revision; 412 on stale |
| GET /me/devices | owner list + serverObservedAt |
| PUT /me/devices/{id}/preferences | owner/device; If-Match; allowlist overrides |
| DELETE /me/devices/{id}/session | recent auth; revoke app/IdP session association |
| POST /sync/push | user; changeId/entityId/baseRevision/op/value, idempotent result per change |
| GET /sync/pull?cursor=... | user; changes/tombstones/newCursor; expired cursor 410 reset_required |
| GET /catalog/radio?cursor=... | guest/user; approved public data, rate limit, ETag |
| GET /config | guest/user; schema/revision/platform/min-max build/expiry, ETag |
| POST /diagnostics/batches | user consent scope; capped structured events, dedup eventId |
| GET /me/diagnostics | owner; own report list; delete via DELETE /me/diagnostics/{id} |
| POST /me/exports | recent auth + Idempotency-Key; async job status; signed download link ≤15min |
| DELETE /me | recent auth + Idempotency-Key; 202 deletion job |
| POST /billing/verify | owner; store payload opaque, verified server-side; never log body |
| POST /webhooks/apple, /webhooks/google | verified provider sender + replay dedup; no user JWT substitute |
| POST /admin/stations | catalog_editor/admin; draft validation |
| PATCH /admin/stations/{id} | scoped editor; If-Match |
| POST /admin/stations/{id}/publish | admin/reviewer; rights gate + separate review |
| POST /admin/config-revisions | admin; draft, allowlisted fields |
| POST /admin/config-revisions/{id}/publish | admin/recent MFA; validate compatibility + diff/reason |
| GET /admin/metrics, /admin/logs | operator/admin; query facade, bounded filters |
| GET /admin/audit | auditor/admin; audited export action |
| POST /admin/jobs/{id}/retry | operator/admin; idempotency and retry ceiling |
| GET /health/live, /health/ready | private infrastructure probes; readiness checks dependency timeout |

Mutation idempotency scoped `(actor,route,key)` 24h minimum; same key/different body = 409. API errors: 400 validation, 401 login, 403 forbidden, 409 conflict, 412 revision mismatch, 413 too large, 429 Retry-After, 503 dependency unavailable. Client retry เฉพาะ idempotent/bounded operations ไม่วน 401

Initial limits: telemetry ≤100 events/128KiB per batch, ≤10 batches/min/device; API reads 120/min/user, mutations 30/min/user; log query ≤24h range/≤1,000 rows/page; exports ≤10k rows/job และ audit reason. Public catalog limit 60/min/IP ที่ gateway พร้อม retention exception. Tune หลัง load test ไม่ถือเป็น capacity promise

## PostgreSQL logical model

| Table | Important fields / constraints |
|---|---|
| users | id, oidcSubject unique, status, locale, createdAt; no password hash |
| staff_roles | userId, role, scope, grantActor, revokedAt; no self-service admin |
| devices | id, userId, platform, build, lastSeenAt, revokedAt; owner FK |
| account_preferences / device_preferences | ownerId, schemaVersion, revision, allowlisted JSON |
| synced_entities | userId, entityId, type, revision, value, deletedAt; unique(userId,entityId) |
| sync_changes / dedup | userId, cursor, changeId, entityId, result; bounded retention |
| radio_stations / variants | stationId, name/country/language/genre, publishedRevision, approved public endpoint, bitrateHint |
| rights_records | owner/evidence/territory/expiry/status; private evidence object references |
| station_health | stationId, checkRegion, checkedAt, status, latency; not user-listening data |
| config_revisions | revision, environment, platform range, schema, payload, author, reviewer, reason |
| purchases / entitlements | store, unique external transaction/token digest, owner, verifiedState, checkedAt |
| job_outbox / jobs | stable jobId, kind, payloadRef, status, attempts, availableAt |
| audit_outbox / audit_events | actor, action, targetType/id, redacted diff, reason, requestId, timestamp |
| deletion_jobs / deletion_ledger | subject pseudonymous ID, scopes, progress, retention deadlines |

Business mutation + job/audit outbox ใน DB transaction เดียว. Worker at-least-once processing + dedup; retry exponential capped 5 ครั้งแล้ว dead-letter. RBAC/publish/revoke writes ต้องมี durable audit record ก่อนตอบ success; logs outage ไม่ทำให้ audit หาย

R1 sync ใช้ server revision CAS: baseRevision ตรงจึง apply; stale update ให้ conflict + current redacted value; independent fields rebase ได้แต่ same-field ให้ user เลือก. Delete ชนะ stale updates; restore เป็น explicit new op. ไม่ใช้ wall clock หรือ client logicalCounter ที่ดันสูงเองเป็น authority

## Monitoring, logs and alerts

แยกสามชุด: **operational** (API/jobs/errors), **audit** (who changed what), **client diagnostics** (opt-in media/bridge failure). เว็บรวมผ่าน query facade; ไม่เปิด Grafana/Loki admin token ให้ลูกค้า. หากเปิด Grafana สำหรับ staff ให้ใช้ SSO และ datasource scopes เดียวกัน

Targets proposed: API availability ≥99.9%/30วัน, ordinary metadata reads p95 ≤300ms, writes ≤500ms (server boundary, exclude IdP/external jobs), queue oldest age <60s. ทดสอบ initial envelope 100 API req/s + 20 client diagnostic batches/s เป็นเวลา 30 นาทีบน declared staging sizing ก่อน claim

Alerts: 5xx >2%/5min และ ≥100 requests, p95 >1s/10min, queue oldest >5min, dead-letter >0, DB pool >80%/10min, disk >80%, backups ไม่สำเร็จ >24h. Missing traffic/samples = unknown ไม่ใช่ pass. Incident acknowledge target 30min ใน staffed hours; 24/7 SLA ต้องมี on-call จริงก่อนขาย

Log schema: timestamp, severity, service, environment, build, eventCode, requestId/traceId, durationMs, pseudonymous actor/device ID เมื่อจำเป็น. ห้าม Authorization/Cookie/reset codes/payment body/URL query/content title/email. Log redaction ทั้ง producer และ collector; scrub crash breadcrumbs และ reverse-proxy URLs. Metrics labels ห้าม userId/stationId/requestId เพื่อคุม cardinality

Proposed retention: operational 14 วัน, traces 7 วัน, metrics 90 วัน, client diagnostics 7 วัน, audit 180 วัน, security edge IP ≤24h เฉพาะ security role, user exports 24h, backups ≤35 วัน. Limit storage/quota และ deletion jobs; legal/business owner ต้องยืนยันก่อน publish privacy policy

## Catalog checker and SSRF boundary

Check เฉพาะ publisher-reviewed public endpoints; ไม่มี API fetch arbitrary customer URL. Worker แยก network egress, block private/loopback/link-local/metadata IP ทั้ง IPv4/IPv6 ทุก DNS resolution/redirect และ connect ไป validated destination กัน DNS rebinding; cap redirect 3/timeout 10s/body 64KiB/concurrency 4. ตรวจ headers/bounded content พอ ไม่ record stream หรือ download ทั้งรายการ

Proposed cadence ทุก 15 นาที + jitter/cache; provider terms/rate limits มาก่อน. Health เป็น point-in-time จาก region หนึ่ง ไม่รับรองทุกประเทศ/device. Fail 3 รอบค่อย suspect; admin review ก่อน disable; publish rights expiration block ทันทีตาม policy. ไม่ใส่ private endpoints ลง log เมื่อ reject

## Configuration rollout and operations

Draft → schema validation → staging → reviewer approval → production revision. Store previous revision; rollback สร้าง revision ใหม่ที่อ้าง payload เดิม ไม่แก้ history. Invalid/expired config ใช้ last-known-safe ภายใน 7 วันสำหรับ ordinary settings แล้ว defaults; safety/entitlement constraints ไม่รับมาจาก config เลย. Client clock ไม่เป็น security authority

RPO target 15min (DB PITR); RTO target 4h หลัง authorized restore; ทดลอง restore quarterly และก่อน first release. Secrets encrypted/rotated, DB/queue/object buckets private, TLS and backup keys managed. Budget alerts รวม logs/egress/identity ไม่ใช่ media bandwidth อย่างเดียว

## Acceptance gates

T-AUTH: verified login/reset/logout/PKCE/session revoke/MFA, no token in browser storage/logs.
T-RBAC: two customers + each role across CRUD/log search/export/direct ID access; no cross-account read/write.
T-CONFIG: conflicting edits/stale revision/rollback/unsupported client/invalid payload; safety cannot be enabled remotely.
T-OPS: seeded errors searchable by requestId, trace linking, log redaction, absent data shown unknown, injected alert, retention deletion.
T-BE: load envelope, idempotent jobs/webhooks, Redis outage replay, DB restore/deletion-ledger replay.
T-WEB: login→settings→phone sync→device revoke, admin draft→review→publish, session expiry/errors/accessibility.

ยังไม่มี test results หรือ cloud provisioned; gates ทั้งหมด Not run
