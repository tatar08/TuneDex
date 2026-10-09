# Backend และ Web Console ตามที่สร้างจริง (As-Built)

วันที่ 2026-10-09 · branch `claude/backend-hardening-2` · สถานะ: อ้างอิงจากโค้ด ไม่ใช่ข้อเสนอ

เอกสารนี้บอกว่า TuneDeck backend และ web console ที่อยู่ในโค้ดวันนี้ทำอะไร อยู่ไฟล์ไหน และต่างจาก [17 Backend/Web/Login/Logs](17-Backend-Web-Console.md) ตรงไหน. Doc 17 ยังเป็นสเปก ส่วนไฟล์นี้เป็นสิ่งที่สร้างแล้ว. เอกสาร 31/32 ที่อยู่บนเครื่องอื่นอธิบาย backend รุ่นเก่าที่เลิกใช้แล้ว ห้ามใช้อ้างอิง

ผู้อ่านหลัก: Codex (mobile), ผู้ดูแลระบบรุ่นต่อไป และผู้ทดสอบ. รายละเอียดราย route ที่ละเอียดกว่านี้อยู่ใน `services/api/README.md`, `apps/console/README.md` และ `infra/README.md`. ถ้าเอกสารใดขัดกับโค้ด ให้ถือโค้ดเป็นหลัก

## 1. ภาพรวม

| ส่วน | ที่อยู่ | หน้าที่ |
|---|---|---|
| API | `services/api` (NestJS + `pg`, Node 22) | REST `/v1/*` และ `/health/*` สำหรับแอปมือถือและ console. พอร์ต `3100` |
| Stream checker | `services/api/src/checker.ts` (`npm run checker`) | process แยกที่ไม่มี HTTP server ใช้ตรวจ stream ของสถานีเมื่อ `STATION_CHECK_RUNNER=worker` |
| Web console | `apps/console` (Next.js, BFF ฝั่ง server) | หน้า `/app/*` ของลูกค้าและ `/admin/*` ของ staff. พอร์ต `3200` |
| Keycloak | `keycloak/keycloak:26.4`, realm `tunedeck` | sign-in, สมัคร, reset password, TOTP. realm อยู่ที่ `infra/compose/keycloak/tunedeck-realm.json` |
| PostgreSQL | `postgres:16` | ฐานข้อมูลเดียวของ API, ตาราง session ของ console (`console_sessions`) และ rate-limit counters |
| Caddy | `caddy:2.8` | HTTPS หน้าระบบ (`api.`, `auth.`, `console.<domain>`) |

ใครคุยกับใคร:

- แอปมือถือ sign-in ที่ Keycloak (client `tunedeck-mobile`, PKCE) แล้วเรียก API ด้วย bearer token
- browser คุยกับ console เท่านั้น. console เก็บ token ไว้ฝั่ง server และเรียก API ด้วย token ของผู้ใช้ (BFF) ดังนั้น API ไม่ต้องเปิด CORS ให้ console
- API ตรวจ token กับ JWKS ของ Keycloak และใช้ service account `tunedeck-api-admin` เรียก Keycloak admin API (ลบ user, ปิด session, อ่านรายการ OTP ของ staff)
- API เรียกออกภายนอก: Radio Browser (ถ้าตั้ง `RADIO_BROWSER_BASE_URL`), alert webhook, Apple/Google (ถ้าตั้ง billing) และ stream ของสถานี (เฉพาะ checker หรือ API เมื่อ runner เป็น `api`)

สภาพแวดล้อมสองชุด:

| | `infra/compose` (+ `lan-https.yaml`) | `infra/deploy` |
|---|---|---|
| ใช้ทำอะไร | stack ทดสอบในเครื่อง; overlay `lan-https.yaml` เปิด HTTPS บน LAN ให้มือถือทดสอบใน Wi-Fi เดียวกัน (โดเมน `*.sslip.io`, CA ของ Caddy เอง, ดาวน์โหลด root ที่ `https://api.<EDGE_DOMAIN>/staging-ca.crt`) | เซิร์ฟเวอร์เดียวที่มีโดเมนจริง สำหรับ staging ตาม Doc 17 และ production ช่วงแรก |
| Keycloak | `start-dev`, H2 ใน volume | `start` บน database `keycloak` ใน Postgres เดียวกัน; `/admin` ตอบ 404 จากภายนอก |
| API | `APP_ENV=dev`, `STAFF_MFA_ACR=mfa` | `APP_ENV=staging` หรือ `production`; บังคับ signing key, MFA, Keycloak admin client |
| Stream check | ใน API | service `checker` (`--profile checker`) และ `STATION_CHECK_RUNNER=worker` |
| HTTPS | ไม่มี หรือ CA ของ Caddy บน LAN | Let's Encrypt, HSTS |
| Backup | รัน `infra/backup/backup.sh` เอง | service `backup` ทุก 24 ชั่วโมง เก็บ 35 วัน |

`infra/deploy` พร้อมใช้แต่ยังไม่ได้ deploy จริง เพราะยังไม่มีโดเมนและเครื่อง (ดูข้อ 9)

## 2. โมดูลของ API

ทุก route ใต้ `/v1/admin/*` ผ่าน `AuthGuard` แล้ว `StaffGuard` (`@RequireRoles`). route ที่ไม่มี `@RequireRoles` จะถูกปฏิเสธเสมอ (fail closed)

| โมดูล (`services/api/src/…`) | ทำอะไร | route หลัก | สิทธิ์ |
|---|---|---|---|
| `account` | ข้อมูลบัญชี, export, ลบบัญชี, ลบ user ที่ Keycloak (`idp-users.ts`), reconcile หลัง restore (`npm run restore-reconcile`) | `GET /v1/me`, `GET /v1/me/export`, `DELETE /v1/me` (และ `/v1/me/account`), `GET /v1/account-deletions/:ticket`, `POST /v1/me/exports`, `GET /v1/me/exports/:id`, `POST /v1/me/exports/:id/link`, `GET /v1/export-downloads/:token` | เจ้าของบัญชี; สถานะการลบและลิงก์ดาวน์โหลดไม่ต้อง sign-in |
| `app-config` | remote config ที่เซ็นด้วย Ed25519, draft/stage/publish/rollback, `npm run config-key` | `GET /v1/config` (public), `GET /v1/admin/config`, `PATCH /v1/admin/config/draft`, `POST /v1/admin/config/stage`, `POST /v1/admin/config/publish`, `POST /v1/admin/config/releases/:release/rollback` | อ่าน: `operator`, `admin`; แก้ไขทั้งหมด: `admin` |
| `audit` | เขียน `audit_events` (append-only), ค้นหา, export CSV, ลบเกิน 180 วัน | `GET /v1/admin/audit`, `POST /v1/admin/audit/export` | `auditor`, `admin` |
| `auth` | `AuthGuard` ตรวจ token; `requireRecentSignIn` / `requireRecentMfa` | (ไม่มี route) | |
| `billing` | ตรวจการซื้อ Apple/Google, webhook, สิทธิ์ Pro | `GET /v1/me/entitlements`, `POST /v1/billing/verify`, `POST /v1/webhooks/apple`, `POST /v1/webhooks/google` | เจ้าของบัญชี; webhook ตรวจลายเซ็นของ store ไม่ใช้ JWT ผู้ใช้ |
| `devices` | ทะเบียนอุปกรณ์, check-in, override รายเครื่อง, sign-out อุปกรณ์ และปิด session ที่ Keycloak | `GET /v1/me/devices`, `PUT /v1/me/devices/:deviceId`, `DELETE /v1/me/devices/:deviceId/session`, `GET/PUT /v1/me/devices/:deviceId/preferences` | เจ้าของบัญชี |
| `diagnostics` | รับ diagnostic batch แบบ opt-in, รายงานของตัวเอง, support access ด้วยรหัสครั้งเดียว | `POST /v1/diagnostics/batches`, `GET/DELETE /v1/me/diagnostics[/:id]`, `GET /v1/me/support-access`, `POST /v1/me/support-access/codes`, `DELETE /v1/me/support-access/:id`, `POST /v1/admin/users/:userId/diagnostics/access`, `GET /v1/admin/users/:userId/diagnostics` | ผู้ใช้; ฝั่ง admin: `support`, `admin` |
| `directory` | ค้น Radio Browser ผ่าน server ของเรา, รายการบล็อก | `GET /v1/directory/radio`, `GET /v1/directory/radio/countries` (public), `GET/POST /v1/admin/directory/blocks`, `POST /v1/admin/directory/blocks/:id/remove` | public; บล็อก: `catalog_editor`, `admin` |
| `health` | probe ของ infrastructure | `GET /health/live`, `GET /health/ready` | ไม่ต้อง sign-in |
| `jobs` | รวมคิว `account_deletion`, `account_export`, `idp_session_end`; retry policy กลาง (`retry-policy.ts`) | `GET /v1/admin/jobs`, `POST /v1/admin/jobs/:id/retry` | `operator`, `admin` |
| `logs` | เก็บ log ลง `operational_logs` (`log-store.ts`), ค้นหา, export CSV | `GET /v1/admin/logs`, `POST /v1/admin/logs/export` | `operator`, `admin` |
| `overview` | หน้า overview, metrics รายชั่วโมง/วัน, alerts | `GET /v1/admin/overview`, `GET /v1/admin/metrics` | `operator`, `admin` |
| `settings` | ค่าตั้งของบัญชี (theme, language, cellular policy) พร้อม revision | `GET /v1/me/settings`, `PATCH /v1/me/settings` (`If-Match`) | เจ้าของบัญชี |
| `staff` | บทบาท staff, MFA session, pin OTP, CLI | `GET /v1/me/staff` | ผู้ใช้ที่ sign-in (ใช้ให้ console เลือกหน้า) |
| `stations` | catalog สถานี, draft/publish, rights records, health checker, SSRF guard (`stream-probe.ts`) | `GET /v1/catalog/radio` (public), `GET/POST /v1/admin/stations`, `GET /v1/admin/stations/summary`, `GET/PATCH /v1/admin/stations/:id`, `GET .../:id/health`, `POST .../:id/check`, `GET/POST .../:id/rights`, `POST .../:id/rights/:recordId/revoke`, `GET .../:id/history`, `POST .../:id/publish`, `POST .../:id/disable`, `POST .../:id/enable` | `catalog_editor`, `admin`; publish/disable/enable: `admin` เท่านั้น |
| `sync` | sync favorites (Doc 06) แบบ revision CAS | `POST /v1/sync/push`, `GET /v1/sync/pull`, `GET /v1/me/favorites` | เจ้าของบัญชี |
| `users` | สร้าง/หา user จาก `sub` ตอน sign-in (`users.service.ts`), support lookup (`admin-users.ts`) | `POST /v1/admin/users/lookup` | `support`, `admin` |
| `common` | error envelope, rate limit, idempotency, request context/trace, logger, pagination, `bounded-fetch.ts`, `text-safety.ts` | (ไม่มี route) | |
| `db` | pool (`database.ts`), migration runner (`migrate.ts`, ล็อกด้วย advisory lock, forward-only) | (ไม่มี route) | |

## 3. การยืนยันตัวตนและสิทธิ์

**ตรวจ token (`auth/auth.guard.ts`).** รับเฉพาะ `Authorization: Bearer …`. ตรวจ signature กับ JWKS (`OIDC_JWKS_URI`), `iss`, `aud`, `exp`, อัลกอริทึมใน `OIDC_ALGORITHMS` (ห้าม `none` และ `HS*`), ต้องมี `sub` และ `exp`, clock tolerance 5 วินาที. token ผิดเป็น 401 `AUTH_REQUIRED`; JWKS ติดต่อไม่ได้เป็น 503 (fail closed). JWKS cache 10 นาที, cooldown 30 วินาที, timeout 5 วินาที (`main.ts`). บัญชีมาจาก `sub` เท่านั้น ไม่มาจาก body หรือ URL. บัญชีสถานะ `deleting` หรือ sign-in ก่อนบัญชีถูกลบ เป็น 403 `ACCOUNT_DELETING`; สถานะอื่นที่ไม่ใช่ `active` เป็น 403 `AUTH_FORBIDDEN`. ถ้า token มี `sid` ที่ตรงกับอุปกรณ์ที่ถูก revoke เป็น 403 `DEVICE_REVOKED`. ไม่มีสวิตช์ข้าม auth ใน `src/`; identity ปลอมมีเฉพาะใน `test/`

**บทบาท staff.** `support`, `catalog_editor`, `operator`, `admin`, `auditor` เก็บในตาราง `staff_roles` และอ่านทุก request จึงมีผลทันทีเมื่อ revoke. ให้สิทธิ์ได้ทางเดียวคือ CLI บนเครื่องที่เข้าถึง database:

```
npm run staff -- grant <oidc-subject> <role> --by <operator> --reason "<why>"
npm run staff -- revoke <oidc-subject> <role> --by <operator> --reason "<why>"
npm run staff -- list
npm run staff -- pin-mfa <oidc-subject> --by <operator> --reason "<why>"
```

grant ต้องให้คนนั้นตั้ง TOTP ที่ Keycloak ก่อน และจะ pin รหัส OTP ที่มีตอนนั้นไว้ใน `staff_mfa_pins`. ถ้าภายหลังบัญชีมี OTP ที่ไม่ได้ pin ทุก route ของ staff ตอบ 403 `STAFF_MFA_CHANGED` (ตรวจกับ Keycloak อย่างมากนาทีละครั้งต่อ session; Keycloak ติดต่อไม่ได้เป็น 503). ทุก grant/revoke/pin ถูก audit. ไม่มีหน้าเว็บสำหรับให้สิทธิ์

**MFA ของ staff session.** ทุก `/v1/admin/*` ต้องมาจาก Keycloak session ที่ sign-in ด้วย MFA (`acr` อยู่ใน `STAFF_MFA_ACR`) ภายใน 12 ชั่วโมง (`staff_mfa_sessions`) มิฉะนั้น 401 `MFA_REQUIRED` พร้อม `details.scope: "session"`. ใน dev ที่ไม่ได้ตั้ง `STAFF_MFA_ACR` การตรวจนี้ปิด

**กฎ "sign-in ล่าสุด" และ "MFA ล่าสุด"** (`auth/recent-sign-in.ts`, ทั้งคู่ 300 วินาที):

| กฎ | ดูจาก | route ที่ใช้ | error |
|---|---|---|---|
| recent sign-in | `auth_time` ภายใน 5 นาที | `DELETE /v1/me/devices/:deviceId/session`, `DELETE /v1/me` และ `/v1/me/account`, `POST /v1/me/exports`, `POST /v1/me/exports/:id/link`, `GET /v1/me/export` | 401 `REAUTH_REQUIRED` |
| recent MFA | `acr` ใน `STAFF_MFA_ACR` และ `auth_time` ภายใน 5 นาที | `POST /v1/admin/stations/:id/publish`, `POST /v1/admin/config/stage`, `/publish`, `/releases/:release/rollback`, `POST /v1/admin/audit/export`, `POST /v1/admin/logs/export` | 401 `MFA_REQUIRED` |

console จัดการให้เอง: `REAUTH_REQUIRED` พาไป `/auth/login?reauth=1` (`prompt=login`, `max_age=0`) และ `MFA_REQUIRED` พาไป `/auth/login?mfa=1` (ส่ง `acr_values` จาก `OIDC_MFA_ACR`). แอปมือถือต้องทำแบบเดียวกันก่อน revoke อุปกรณ์หรือลบบัญชี

**Revoke อุปกรณ์.** `DELETE /v1/me/devices/:deviceId/session` ตั้ง `revoked_at` และ audit `device.revoke`. ตั้งแต่วินาทีนั้น API ปฏิเสธ token ที่มี `sid` ของอุปกรณ์นั้น (อุปกรณ์ส่ง `sid` มาตอน check-in, migration 014). แล้ว API ปิด session ที่ Keycloak (`DELETE /admin/realms/<realm>/sessions/<sid>` และแบบ `isOffline=true`) เป็นงานเบื้องหลังที่ retry ได้ (คิว `idp_session_end`). อุปกรณ์ที่ถูก revoke check-in หรือ sync จะได้ 403 `DEVICE_REVOKED` และแอปควร sign out. จำกัด 20 อุปกรณ์ที่ active ต่อบัญชี (409 `DEVICE_LIMIT`)

**ลบบัญชี.** `DELETE /v1/me` ต้อง recent sign-in และ `Idempotency-Key` แล้วตอบ 202 พร้อม `ticket`. ใน transaction เดียว: ตั้ง user เป็น `deleting`, revoke ทุกอุปกรณ์, สร้างแถวใน `account_deletions`. worker (`account/account.ts`) ลบ user ที่ Keycloak ก่อน (404 ถือว่าลบแล้ว) แล้วจึงลบข้อมูล local ทั้งหมด (diagnostics, sync, devices, preferences, staff roles, idempotency keys, exports, support access) และเหลือ `users` แบบ tombstone ที่ `oidc_subject` เป็น `deleted:<id>`. แถว `purchases` ถูกเก็บไว้ (digest, สถานะ, วันที่) เพื่อจับคู่ refund. ถ้า Keycloak ล้มเหลว ข้อมูล local ไม่ถูกแตะและ retry ตามนโยบายกลาง; ครบ 5 ครั้งเป็น dead letter และบัญชียังล็อกอยู่. ผู้ใช้ติดตามที่ `GET /v1/account-deletions/:ticket` (`deleting` / `completed` / `failed`) พร้อม deadline 30 วัน. console ส่งไปหน้า `/account-deleted` โดยเก็บ ticket ใน URL fragment

## 4. ข้อมูล

Migrations อยู่ที่ `services/api/src/db/migrations` (forward-only, รันด้วย `npm run migrate`):

| ไฟล์ | สาระ |
|---|---|
| `001_users_and_account_preferences.sql` | `users` (OIDC subject, status, ไม่มี password) และ `account_preferences` |
| `002_devices.sql` | `devices` keyed by (owner, device id) |
| `003_staff_stations_audit.sql` | `staff_roles`, `radio_stations`, `audit_events` แบบ append-only |
| `004_operational_logs.sql` | `operational_logs` |
| `005_station_health.sql` | `station_health` |
| `006_rate_limits.sql` | `rate_limit_counters` (unlogged) |
| `007_client_diagnostics.sql` | `diagnostic_reports`, `diagnostic_events` |
| `008_account_deletion.sql` | `account_deletions` |
| `009_user_email.sql` | คอลัมน์ email ของ user |
| `010_app_config.sql` | `app_config_draft`, `app_config_releases` (append-only) |
| `011_sync.sql` | `synced_entities`, `sync_changes`, `sync_horizons`, `devices.last_synced_at` |
| `012_audit_retention.sql` | ให้งาน retention ลบ audit ที่เกิน 180 วันได้ผ่าน session switch `tunedeck.audit_retention` |
| `013_purchases.sql` | `purchases`, `store_notifications` |
| `014_device_idp_sessions.sql` | `devices.idp_session_id` และสถานะการปิด session ที่ Keycloak |
| `015_alerts.sql` | `alerts` หนึ่งแถวต่อการเกิดหนึ่งครั้ง |
| `016_idempotency_keys.sql` | `idempotency_keys` (เก็บ digest เท่านั้น) |
| `017_account_exports.sql` | `account_exports` และ digest ของลิงก์ดาวน์โหลด |
| `018_api_metrics_hourly.sql` | `api_metrics_hourly` สรุปรายชั่วโมงต่อ route template |
| `019_support_access.sql` | `support_access_codes`, `support_access_grants` |
| `020_device_preferences.sql` | `device_preferences` (override รายเครื่อง) |
| `021_job_retries.sql` | คอลัมน์ retry และ dead letter ของคิวทั้งสาม |
| `022_log_trace.sql` | `operational_logs.trace_id` |
| `023_staff_mfa_sessions.sql` | `staff_mfa_sessions` |
| `024_rights_records.sql` | `rights_records`, `station_rights_until()`, ย้าย rights เดิมจาก draft |
| `025_config_targeting.sql` | channel `staging`, targets ราย platform/build, author และ reviewer ของ release |
| `026_staff_role_scope.sql` | `staff_roles.revoked_by` และ `scope` (R1 มีแค่ `global`) |
| `027_station_check_requests.sql` | `station_check_requests` สำหรับ checker แยก process |
| `028_backup_runs.sql` | `backup_runs` ที่ `backup.sh` บันทึก |
| `029_directory_blocks.sql` | `directory_blocks` |
| `030_purchase_revocations.sql` | `purchase_revocations` (refund ก่อนการ verify ครั้งแรก) |
| `031_performance_indexes.sql` | index จากการทบทวน performance 2026-10-05 |
| `032_rights_sweep_index.sql` | index สำหรับ rights sweep |
| `033_staff_mfa_pins.sql` | `staff_mfa_pins` |
| `034_station_health_variant.sql` | `station_health.variant` (0 = stream หลัก, 1-3 = variant) |

ระยะเก็บข้อมูลตามโค้ด:

| ข้อมูล | ระยะ | ที่กำหนด |
|---|---|---|
| operational logs | 14 วัน | `LOG_RETENTION_DAYS` ใน `logs/log-store.ts` |
| metrics รายชั่วโมง | 90 วัน | `METRICS_RETENTION_DAYS` ใน `overview/metrics.ts` |
| client diagnostics | 7 วัน | `DIAGNOSTICS_RETENTION_DAYS` ใน `diagnostics/diagnostics.ts` |
| support access | รหัส 60 นาที; สิทธิ์อ่าน 7 วัน | `diagnostics/support-access.ts` |
| idempotency keys | 24 ชั่วโมง | `IDEMPOTENCY_TTL_HOURS` ใน `common/idempotency.ts` |
| account exports | ลิงก์ 15 นาที; ไฟล์ 24 ชั่วโมงหลังขอ | `account/exports.ts` |
| sync tombstones และ replay | 90 วัน | `SYNC_RETENTION_DAYS` ใน `sync/sync.ts` |
| station health | 30 วัน | `HEALTH_RETENTION_DAYS` ใน `stations/station-health.ts` |
| store notification ids | 30 วัน | `NOTIFICATION_RETENTION_DAYS` ใน `billing/billing.ts` |
| audit events | 180 วัน | `AUDIT_RETENTION_DAYS` ใน `audit/audit-retention.ts` |
| deletion tickets ที่เสร็จแล้ว | 35 วัน | `TICKET_KEEP_DAYS` ใน `account/account.ts` |
| rate-limit counters | 2 นาที | `common/rate-limit.ts` |
| Keycloak events | 30 วัน | `eventsExpiration: 2592000` ใน `tunedeck-realm.json` |
| backup dumps (`infra/deploy`) | 35 วัน | `BACKUP_KEEP_DAYS` |

## 5. ความปลอดภัยที่มีอยู่

**Rate limits** (`common/rate-limit.ts`, นับต่อนาทีใน Postgres ทุก instance ใช้ร่วมกัน; ที่อยู่ IP เก็บเป็น hash):

| bucket | ใช้กับ | ค่า default |
|---|---|---|
| `user:<id>:read` | GET ของผู้ใช้ที่ sign-in | 120/นาที (`RATE_LIMIT_READS_PER_MIN`) |
| `user:<id>:write` | mutation ของผู้ใช้ | 30/นาที (`RATE_LIMIT_WRITES_PER_MIN`) |
| `user:<id>:admin-write` | mutation ใต้ `/v1/admin/` แยกงบจากแอป | 30/นาที |
| `ip:<hash>:catalog` / `:directory` / `:deletion` / `:export` | `/v1/catalog/`, `/v1/directory/`, `/v1/account-deletions/`, `/v1/export-downloads/` | 60/นาที (`RATE_LIMIT_CATALOG_PER_MIN`) |
| `ip:<hash>:webhook` | `/v1/webhooks/` | 600/นาที (10 เท่าของ catalog) |

เกินเป็น 429 `API_RATE_LIMITED` พร้อม `Retry-After`. ถ้านับไม่ได้ request ผ่านไปและ log `RATE_LIMIT_UNAVAILABLE`. มีขีดจำกัดเฉพาะเพิ่ม: diagnostics 10 batch/นาที/อุปกรณ์, ตรวจสถานีด้วยมือ 1 ครั้ง/นาที/สถานี (`CHECK_TOO_SOON`), job retry ห่าง 60 วินาทีและไม่เกิน 3 ครั้ง/24 ชั่วโมง. `TRUST_PROXY_HOPS` บอกจำนวน proxy ที่เชื่อ `X-Forwarded-For`

**Idempotency** (`common/idempotency.ts`). mutation ที่ sign-in แล้วส่ง `Idempotency-Key` (8-128 ตัว `A-Z a-z 0-9 _ . : -`) จะรันครั้งเดียวต่อ (บัญชี, method+path, key) ใน 24 ชั่วโมง. ซ้ำ body เดิมได้คำตอบเดิมพร้อม `Idempotent-Replayed: true`; body ต่างเป็น 409 `IDEMPOTENCY_KEY_REUSED`; ยังรันอยู่เป็น 409 `IDEMPOTENCY_IN_PROGRESS`. บังคับ (428 `IDEMPOTENCY_KEY_REQUIRED`) สำหรับ `POST /v1/me/exports` และ `DELETE /v1/me`. ไม่เก็บคำตอบของ `POST /v1/me/exports/:id/link`, `POST /v1/me/support-access/codes` และ `POST /v1/admin/users/lookup`. ถ้า store ล่มเป็น 503 (ไม่ fail open)

**Case-sensitive routing** (`app.module.ts`). เปิด `case sensitive routing` ทั้งที่ Express app และ router ของ Nest เพื่อให้ `/V1/...` ไม่หลุด rate limit และ idempotency ที่เทียบ path ตามตัวอักษร

**ขนาด body.** default 16 KiB (เกินเป็น 413); `/v1/diagnostics/batches` 128 KiB (และ ≤100 events); `/v1/sync/push` 64 KiB (≤100 changes); `/v1/billing/verify` และ `/v1/webhooks` 64 KiB

**SSRF guard** (`stations/stream-probe.ts`). รับเฉพาะ `https` พอร์ต 443 ที่เป็นชื่อโฮสต์. ทุกคำตอบ DNS และทุก redirect ต้องเป็นที่อยู่ public (บล็อก loopback, private, link-local, metadata, CGNAT, documentation, multicast, reserved, IPv6 ULA/link-local/mapped/NAT64). เชื่อมต่อไปยังที่อยู่ที่ตรวจแล้วโดยตรงเพื่อกัน DNS rebinding. redirect ≤3, timeout 10 วินาที, อ่าน ≤64 KiB (จริงคือหัวข้อและ ~1 KiB แรก). ไม่บันทึก URL ลงผลตรวจ

**Radio Browser** (`directory/directory.ts` ผ่าน `common/bounded-fetch.ts`). ไม่ตาม redirect, อ่านไม่เกิน 2 MiB, timeout 5 วินาที, cache 10 นาที (ใช้ของเก่าได้ถึง 1 ชั่วโมงเมื่อ upstream ล่ม), offset ≤1000, ไม่ log ข้อความค้นหา. alert webhook ก็ใช้ `boundedFetch` (64 KiB)

**Remote config ที่เซ็น** (`app-config/app-config.ts`). `GET /v1/config` คืน `jws` แบบ compact (`alg: EdDSA`, `typ: tunedeck-config+jws`, `kid`) และ payload เดียวกัน. `kid` คือ 16 ตัวแรกของ base64url SHA-256 ของ public key (SPKI DER) จึงเปลี่ยนเองเมื่อเปลี่ยนกุญแจ. API เซ็นด้วยกุญแจเดียวคือ `CONFIG_SIGNING_KEY`. การหมุนกุญแจ: `npm run config-key` ออกคู่ใหม่, ใส่ public key ใหม่ในแอปก่อน (แอปเลือก key ตาม `kid`), แล้วจึงเปลี่ยน secret ที่ API. staging และ production ใช้กุญแจต่างกัน. config เปิด feature ที่ซ่อนไว้ไม่ได้ (มีแต่ switch ปิด, `minSupportedBuild`, `catalogRefreshHours`)

**CSV injection.** `csvCell()` ใน `audit/audit-search.ts` (ใช้ทั้ง audit และ logs export) ใส่ `'` นำหน้าค่าที่ขึ้นต้นด้วย `=`, `+`, `-`, `@`, tab หรือ CR และไฟล์เป็น UTF-8 BOM. export ≤10,000 แถว ต้องมีเหตุผลและถูก audit

**CORS.** ปิดถ้าไม่ตั้ง `CORS_ALLOWED_ORIGINS`. ถ้าตั้ง รับเฉพาะ origin ตรงตัว (`https://`; `http://` เฉพาะ dev), `credentials: false`

**Console** (`apps/console/src/lib/*`, `src/proxy.ts`):

- cookie session เดียว `__Host-td_session` (HttpOnly, `SameSite=Lax`, Secure นอก localhost); token อยู่ฝั่ง server เข้ารหัส AES-256-GCM ด้วยกุญแจจาก `SESSION_SECRET` ใน `console_sessions`
- session ผู้ใช้ idle 12 ชั่วโมง / absolute 7 วัน; staff idle 30 นาที / absolute 12 ชั่วโมง; เปลี่ยนบทบาทแล้ว session จบ (`rolesVersion`)
- login: authorization code + PKCE S256 + `state` + `nonce` ใน cookie `td_login` อายุ 10 นาที; redirect หลัง login ไปได้เฉพาะ `/app/...` และ `/admin...`
- CSRF: ทุก mutation ของ BFF ต้องมี `Origin` เท่ากับ `CONSOLE_BASE_URL` และ `X-CSRF-Token` (หรือ field `csrf`) ตรงกับ session มิฉะนั้น 403 `CSRF_REJECTED`
- CSP ต่อ request: `script-src 'self' 'nonce-…' 'strict-dynamic'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`; `connect-src`/`media-src https:` เปิดเฉพาะ `/app/radio` และ `/app/explore`. HSTS เมื่อ `CONSOLE_BASE_URL` เป็น https

## 6. ตัวแปรสภาพแวดล้อม

ไม่มีค่า secret ในเอกสารนี้. ค่าจริงอยู่ใน `.env` ของแต่ละ stack หรือ secret manager. "บังคับนอก dev" หมายถึงบังคับเมื่อ `APP_ENV` เป็น `staging` หรือ `production`

API (`services/api/src/config.ts` และที่อ่านตรงจาก `process.env`):

| ตัวแปร | บังคับ / default | ความหมาย |
|---|---|---|
| `APP_ENV` | บังคับ | `dev`, `staging` หรือ `production` |
| `BUILD_VERSION` | `unknown` | ป้าย build ใน log |
| `PORT` | `3100` | พอร์ต HTTP |
| `DATABASE_URL` | บังคับ | PostgreSQL ของ API (CLI `staff`, `migrate` ก็อ่าน) |
| `DB_POOL_MAX` | `20` (2-200) | ขนาด pool; statement timeout 5 วินาที |
| `SHUTDOWN_DRAIN_MS` | `5000` | เวลาที่ `/health/ready` ตอบ 503 ก่อนปิด |
| `OIDC_ISSUER` | บังคับ | issuer ของ realm (`…/realms/<realm>`) |
| `OIDC_AUDIENCE` | บังคับ | audience ที่ token ต้องมี (`tunedeck-api`) |
| `OIDC_JWKS_URI` | บังคับ | URL ของ JWKS |
| `OIDC_ALGORITHMS` | `RS256` | อัลกอริทึมที่รับ (asymmetric เท่านั้น) |
| `KEYCLOAK_ADMIN_CLIENT_ID` | บังคับนอก dev | service account สำหรับลบ user, ปิด session, อ่าน OTP |
| `KEYCLOAK_ADMIN_CLIENT_SECRET` | บังคับคู่กับข้างบน | secret ของ client นั้น |
| `CONFIG_SIGNING_KEY` | บังคับนอก dev | Ed25519 private key (PKCS#8 PEM) ที่เซ็น `GET /v1/config`; dev ไม่ตั้งได้กุญแจชั่วคราว |
| `STAFF_MFA_ACR` | บังคับนอก dev | ค่า `acr` ที่ถือว่าเป็น MFA (realm ใช้ `mfa`) |
| `CORS_ALLOWED_ORIGINS` | ว่าง | origin ที่เรียก API ตรงจาก browser ได้ |
| `TRUST_PROXY_HOPS` | `0` (0-5) | จำนวน proxy ที่เชื่อ `X-Forwarded-For` |
| `RATE_LIMIT_READS_PER_MIN` | `120` | งบอ่านต่อผู้ใช้ต่อนาที |
| `RATE_LIMIT_WRITES_PER_MIN` | `30` | งบเขียนต่อผู้ใช้ต่อนาที |
| `RATE_LIMIT_CATALOG_PER_MIN` | `60` | งบต่อ IP สำหรับ route public |
| `AUDIT_RETENTION_ENABLED` | `true` | ลบ audit เกิน 180 วันวันละครั้ง |
| `ALERTS_ENABLED` | `true` | ประเมิน alert ทุกนาที |
| `ALERT_WEBHOOK_URL` | ว่าง | webhook แบบ Slack/Discord (https); เป็น secret ไม่ถูก log |
| `STATION_CHECK_ENABLED` | `false` | เปิดการตรวจ stream ตามรอบ |
| `STATION_CHECK_INTERVAL_MIN` | `15` (5-1440) | รอบการตรวจ (บวก jitter ≤10%) |
| `STATION_CHECK_REGION` | `default` | ป้าย region ของผลตรวจ |
| `STATION_CHECK_RUNNER` | `api` | `api` หรือ `worker` (ให้ `npm run checker` ตรวจแทน) |
| `RADIO_BROWSER_BASE_URL` | ว่าง (ปิด) | Radio Browser server หนึ่งตัว (https) |
| `APPLE_BUNDLE_ID` | ว่าง (ปิด Apple) | bundle id ของแอป iOS |
| `APPLE_ROOT_CA_PEM` | บังคับเมื่อเปิด Apple | Apple Root CA - G3 |
| `APPLE_PRO_PRODUCT_IDS` | บังคับเมื่อเปิด Apple | product id ของ Pro (คั่นด้วย comma) |
| `APPLE_ENVIRONMENTS` | `Production` | `Production` และ/หรือ `Sandbox` |
| `GOOGLE_PLAY_PACKAGE_NAME` | ว่าง (ปิด Google) | package name ของแอป Android |
| `GOOGLE_PLAY_PRO_PRODUCT_IDS` | บังคับเมื่อเปิด Google | product id ของ Pro |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | บังคับเมื่อเปิด Google | service account key JSON (secret) |
| `GOOGLE_PUBSUB_PUSH_AUDIENCE` | บังคับเมื่อเปิด Google | audience ของ Pub/Sub push token |
| `GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT` | บังคับเมื่อเปิด Google | service account ที่ Google ใช้เซ็น push |

Console (`apps/console/src/lib/config.ts`, `src/proxy.ts`):

| ตัวแปร | บังคับ / default | ความหมาย |
|---|---|---|
| `CONSOLE_BASE_URL` | บังคับ | origin ของ console; ต้อง https นอก localhost; ใช้ตรวจ `Origin` และเปิด HSTS |
| `API_BASE_URL` | บังคับ | origin ของ API ที่ BFF เรียก |
| `OIDC_ISSUER` | บังคับ | issuer ของ realm |
| `OIDC_CLIENT_ID` | บังคับ | client `tunedeck-console` |
| `OIDC_CLIENT_SECRET` | บังคับ | secret ของ confidential client |
| `OIDC_SCOPES` | `openid` | scope ที่ขอ |
| `OIDC_ALGORITHMS` | `RS256` | อัลกอริทึมของ ID token |
| `OIDC_MFA_ACR` | ว่าง | `acr_values` ที่ส่งตอน step-up MFA (ควรตรงกับ `STAFF_MFA_ACR`) |
| `SESSION_SECRET` | บังคับ (≥32 ตัว) | กุญแจต้นทางสำหรับเข้ารหัส session |
| `SESSION_DATABASE_URL` | บังคับนอก localhost | PostgreSQL สำหรับ `console_sessions` |
| `APP_ENV` | `unknown` | ชื่อ environment ใน log |
| `BUILD_VERSION` | `unknown` | ป้าย build ใน log |
| `NODE_ENV` | (ตั้งโดย Next.js) | `development` เพิ่ม `'unsafe-eval'` ใน CSP |

## 7. งานเบื้องหลัง

ทุก worker อยู่ใน process ของ API (ยกเว้น checker เมื่อแยก) และใช้ advisory lock หรือ claim แถว เพื่อไม่ให้หลาย instance ทำซ้ำกัน

- **Retry policy กลาง** (`jobs/retry-policy.ts`): ล้มแล้วรอ 1, 5, 15, 60 นาที; ครั้งที่ 5 เป็น `dead_letter` รอ operator กด retry ที่ `/admin/jobs` (เริ่มรอบใหม่ 5 ครั้ง). worker ดูงานทุก 60 วินาที. เก็บแค่ `last_error_code` เช่น `IDP_DELETE_FAILED`, `DB_40001`, `SYS_ECONNREFUSED`, `TIMEOUT`
- **ลบบัญชี** (`account/account.ts`): คิว `account_deletion` ตามข้อ 3. dead letter ยังล็อกบัญชีไว้
- **Export** (`account/exports.ts`): คิว `account_export` สร้างไฟล์ JSON ≤10,000 events, ลบหลัง 24 ชั่วโมง
- **ปิด session ที่ Keycloak** (`devices/devices.service.ts`): คิว `idp_session_end` สำหรับอุปกรณ์ที่ revoke ใน 30 วัน; ไม่มี admin client ก็ไม่ทำและไม่แสดงคิวนี้
- **ตรวจ stream** (`stations/station-health.ts`): ปิดโดย default (`STATION_CHECK_ENABLED=false`). เมื่อเปิด ตรวจทุกสถานีที่ publish และเปิดอยู่ ทุก 15 นาที, ครั้งละ 4, instance เดียว. ล้ม 3 ครั้งติดหลัง publish ล่าสุดเป็น `suspect` ให้ admin ดู ไม่ปิดสถานีเอง. "check now" ของ staff เมื่อ runner เป็น `worker` จะเขียน `station_check_requests` และรอ checker ≤15 วินาที (มิฉะนั้น 503 `CHECKER_UNAVAILABLE`)
- **Rights sweep** (`stations/stations.service.ts`): ทุก 15 นาที คำนวณ `rights_expires_at` ใหม่ สถานีหลุด catalog เองเมื่อ rights หมด
- **Pruning**: logs ทุกชั่วโมง, diagnostics และ support grants ทุกชั่วโมง, idempotency ทุกชั่วโมง, sync tombstones ทุกชั่วโมง, station health, rate-limit counters ทุก 5 นาที, store notifications วันละครั้ง, audit วันละครั้ง (เริ่มหลัง start 1 นาที)
- **Metrics rollup** (`overview/metrics.ts`): ทุก 5 นาที สรุป log เป็น `api_metrics_hourly`
- **Alerts** (`overview/alerts.ts`): ทุกนาที instance เดียว. กฎ: 5xx >2% ของ ≥100 request ใน 5 นาที; p95 >1 วินาที ของ ≥20 request ใน 10 นาที; การลบที่ล้มหรือเกิน 25 วัน; งานในคิวที่ค้างเกิน 5 นาที; `job_dead_letter`; checker หยุด; rights ของสถานีจะหมดใน 14 วัน; `backup_stale` เมื่อ backup ล่าสุดเก่า ≥26 ชั่วโมง. ข้อมูลน้อยเกินอ่านเป็น unknown. ส่งไป log และ `ALERT_WEBHOOK_URL` (ข้อความภาษาไทย ไม่มีข้อมูลรายบุคคล)

## 8. การทดสอบและ CI

| ชุด | เครื่องมือ | จำนวนล่าสุด | รัน |
|---|---|---|---|
| API | Jest กับ PostgreSQL จริง (แต่ละไฟล์สร้าง database ของตัวเอง) | 391 tests ใน 36 suites (`services/api/test`) | `cd services/api && TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres npm test` |
| Console unit/component/BFF integration | Vitest (jsdom) กับ API build จริง | 132 tests (`apps/console/test`) | `cd apps/console && npm test` (build API ก่อน) |
| Console end-to-end | Playwright (Chromium) กับ `next start` + API จริง + mock IdP | 27 tests (`apps/console/e2e`) | `npm run build && npm run test:e2e` |

identity ในเทสมาจาก `apps/console/test/mock-idp.ts` และ key set ใน `services/api/test` เท่านั้น. `test/openapi.test.ts` ตรวจว่า `openapi.proposal.yaml` ตรงกับ route จริง. ก่อน push ควรรัน `npm run typecheck` ทั้งสองโฟลเดอร์ด้วย

`.github/workflows/ci.yml`: รันเมื่อเปิด pull request ที่แตะ `services/api/**`, `apps/console/**` หรือไฟล์ workflow เอง (และ `workflow_dispatch`); push ใหม่ยกเลิก run เก่าของ PR เดียวกัน. job `api`: Postgres 16 ที่พอร์ต 54329, Node 22, `npm ci`, `typecheck`, `build`, `test`. job `console`: build API, แล้ว `npm ci`, `typecheck`, `npm test`, `build`, ติดตั้ง Chromium, `test:e2e`. ไม่มี job deploy

## 9. จุดที่ต่างจาก Doc 17 และสิ่งที่ยังไม่มี

ยังไม่มี:

- **Production deploy**: `infra/deploy` พร้อมแต่รอโดเมนและเครื่อง. ตอนนี้มีแค่ stack ในเครื่องและ LAN (`APP_ENV=dev`, Keycloak `start-dev`). load test 30 นาทีและ restore drill บน staging จริงยังไม่ได้ทำ
- **Email/SMTP จริง**: realm ไม่มี `smtpServer` และไม่ได้เปิด `verifyEmail`. จึงยังไม่มีขั้น "verify email" และ reset password ทางอีเมลใช้จริงไม่ได้
- **การสมัครเปิดเผยอีเมลที่มีอยู่แล้ว**: realm ตั้ง `registrationAllowed: true` และ `duplicateEmailsAllowed: false` หน้าสมัครของ Keycloak จึงบอกว่าอีเมลนี้มีบัญชีแล้ว ขัดกับหลัก "ไม่เปิดเผยว่ามี email ในระบบ" ของ Doc 17. จะแก้ได้เมื่อมี email verification
- **Store product IDs**: ยังไม่ได้ตั้ง `APPLE_*` / `GOOGLE_PLAY_*` ทุกที่ `POST /v1/billing/verify` จึงตอบ 503 และไม่มีใครได้ Pro
- **RPO 15 นาที (PITR)**: backup ทุก 24 ชั่วโมง; alert DB pool และ disk เป็นหน้าที่ของ hosting
- **outbox tables และ Redis**: ไม่มี; audit เขียนใน transaction เดียวกับการเปลี่ยนแปลง และงานใช้ตารางของแต่ละคิว. traces ไม่มีที่เก็บแยก มีแค่ `trace_id` ใน log 14 วัน

ต่างจาก Doc 17:

- **Staff**: ให้สิทธิ์ด้วย `npm run staff` เท่านั้น ไม่มี invitation หรือหน้าจัดการบทบาทบนเว็บ (`/admin/users` เป็น support lookup อย่างเดียว). grant ต้องมี TOTP ก่อนและ pin OTP ไว้ ซึ่ง Doc 17 ไม่ได้เขียน
- **Remote config**: route จริงคือ `/v1/admin/config` (draft, stage, publish, rollback) ไม่ใช่ `/admin/config-revisions`. `GET /v1/config` เซ็น Ed25519 และมี `channel`, `platform`, `build`; แอปต้อง verify `jws` ด้วย public key ที่ pin
- **Publish สถานี**: เฉพาะ `admin` และต้องไม่ใช่คนที่แก้ draft. emergency ข้ามได้แค่กฎสองคน ไม่ข้าม rights
- **Re-auth**: ฝั่งลูกค้าใช้ "sign-in ภายใน 5 นาที" (`auth_time`) ไม่ใช่ MFA. MFA บังคับเฉพาะ staff. `GET /v1/me/export` แบบเก่าก็ต้อง recent sign-in (README ของ API ยังเขียนว่าไม่ต้อง ซึ่งไม่ตรงกับโค้ด)
- **Rate limit public catalog** ทำใน API (Postgres) ไม่ใช่ gateway. log search ให้ ≤100 แถวต่อหน้า (Doc 17 ≤1,000)
- **Support access**: ลูกค้าออกรหัสครั้งเดียว (60 นาที) ให้ support คนนั้นอ่าน diagnostics ได้ 7 วัน
- **ที่เพิ่มนอก Doc 17**: Radio Browser directory (`/v1/directory/radio`, `/app/explore`, `/admin/directory`), stream variants ≤3 ต่อสถานี, checker แยก process, five themes ของ staff console
- **README ที่ล้าสมัย**: ส่วน "Not in this slice" ของ `services/api/README.md` และ "Not in this ticket" ของ `apps/console/README.md` ยังบอกว่าไม่มี CI, variants และการปิด session ที่ Keycloak แต่ทั้งหมดมีแล้ว. comment บน `AuditRetentionService` บอกว่าปิดโดย default แต่ `config.ts` เปิดโดย default
