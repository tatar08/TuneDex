# Claude + Codex — แบ่งงานพัฒนา TuneDeck

วันที่ 2026-10-04 · สถานะ: แผนแบ่งงานและ prompt พร้อมใช้ ยังไม่ได้ส่งงานให้ Claude หรือเริ่ม implementation

## แนวทางที่แนะนำ

ให้ Claude รับผิดชอบ Backend และเว็บ Console; Codex รับผิดชอบ Flutter, native media/CarPlay/Android Auto และการรวมระบบ. ผู้ใช้กำหนดเป้าหมาย/ลำดับงาน และใช้ผลตรวจรับประกอบการตัดสินใจ. การแบ่งนี้อิงขอบเขตไฟล์และ dependencies ไม่ได้อ้างว่าโมเดลใดเก่งกว่ากัน

เริ่มจากงานเล็กที่ทดสอบได้: **เว็บแก้ theme/language → API บันทึก revision → แอปโหลดค่าเดียวกัน**. หลัง flow นี้ผ่านจึงเพิ่ม device overrides, catalog, sync, logs และ integrations ของรถ. Login ใช้ OIDC จริงใน integration environment; mock auth ใช้ใน tests เท่านั้น

ทั้งสอง assistant ต้องอ่าน Docs จาก repository revision เดียวกัน; ไม่ถือว่ารู้ข้อความจากอีกแชทโดยอัตโนมัติ. ส่ง branch/commit, diff และ handoff report ระหว่างกันทุกครั้ง

## แบ่ง owner และขอบเขตไฟล์

Paths ด้านล่างเป็น proposed project layout ตาม [architecture](05-Technical-Architecture.md); ยังไม่ถือว่ามี source code อยู่แล้ว

| Workstream | Implementation owner | Paths | Backlog / review |
|---|---|---|---|
| API, PostgreSQL, OIDC guards, RBAC, settings | Claude | `services/api/**` | TD-20, FR-19/20/23; Codex review contract/auth isolation |
| Customer/admin web + BFF | Claude | `apps/console/**` | TD-21/24; Codex review UX/API integration |
| Worker/catalog/logs/operations | Claude หลัง API baseline | `services/worker/**`, scoped infra files | TD-25/26; Codex review privacy/failure behavior |
| Flutter UI/domain/import/library/sync client | Codex | `apps/mobile/lib/**`, `packages/dart_domain/**`, `packages/dart_persistence/**` | TD-01–05/08/09/11/13/15/23; Claude review API usage |
| Native playback and car bridges | Codex | `apps/mobile/ios/**`, `apps/mobile/android/**`, `packages/tunedeck_media/**` | TD-06/07/10/22; Claude review event/error contract |
| OpenAPI, bridge schema, shared fixtures | Codex integration owner; Claude proposes API changes | `packages/api_contracts/**`, shared `fixtures/**` | contract version agreed before dependent changes |
| Root manifests/lockfiles/CI/compose/shared Docs | Codex integration owner; changes via agreed ticket | root and `infra/**`, `Docs/**` | no concurrent root edits; migration/release review |
| Billing | Claude: verification/webhooks; Codex: store/mobile adapter | API billing module vs mobile store module | TD-12; joint acceptance/replay tests |

Owner หมายถึงคนลงมือแก้ไฟล์ในรอบนั้น อีกคน review ได้. เมื่อ ticket ต้องแตะ shared path ให้ระบุ path และย้าย ownership ชั่วคราวก่อนเริ่ม ไม่ให้ทั้งคู่แก้พร้อมกัน

## งานที่ต้องตกลงก่อนทำคู่ขนาน — COL-00

Codex เตรียม integration baseline และ Claude ตรวจข้อเสนอ API ก่อน lock:

- Repository/bootstrap, package manager, toolchain versions, start/test commands และ root scripts
- OpenAPI endpoints สำหรับ first slice: `GET /v1/me/settings`, `PATCH /v1/me/settings`, `GET /health/live`, `GET /health/ready`
- Settings schema, allowed values, revision/ETag/If-Match semantics และ error envelope; stale revision → 412 ตาม [Backend contract](17-Backend-Web-Console.md)
- OIDC dev issuer/audience/client IDs, exact redirects, test users/roles และแหล่ง secrets ผ่าน `.env.example` ที่ไม่มี secret จริง
- PostgreSQL migration owner, DB schema, account identity จาก verified token; ไม่รับ userId จาก body
- Shared fixture สำหรับ valid/invalid preference, stale revision, anonymous/other-account requests
- แยก process และ ports ที่ไม่ชนกัน; environment names แยก dev/staging/production

Deliverable: baseline commit + versioned contract + written decisions. ยังไม่ lock library/hosting version ที่ไม่มีผล spike. Claude scaffold nested packages และ Codex mobile prototype ทำคู่ขนานได้ก่อน contract lock แต่ integration code ต้องใช้ contract ที่ยืนยันแล้ว

## ลำดับส่งงานที่แนะนำ

| Wave | Claude | Codex | Exit |
|---|---|---|---|
| 0 | review API schema/auth plan, inventory backend tools | bootstrap/contract baseline, Flutter/native toolchain check | COL-00 accepted; instructions reproducible |
| 1 | COL-01 API settings/auth/persistence slice | COL-02 Flutter settings client against same fixtures | independent tests + API contract pass |
| 2 | COL-03 web Login/settings/BFF | mobile account flow + live API integration | web save → app reload; conflict/login expiry handled |
| 3 | device config/catalog/diagnostic ingest | internet radio/native service + sync | valid station plays; backend outage doesn't break direct playback |
| 4 | logs/metrics/audit/jobs/backup | CarPlay/Android Auto + store adapters | platform and operations gates pass |
| 5 | server/web hardening + cross-review | combined regression and release evidence | full R1 acceptance from QA docs |

Native car spikes SP-03/SP-06 เริ่มเร็วระหว่าง waves ได้เพื่อรู้ blockers ก่อน โดยอยู่ใน branch ของ owner ไม่ต้องรอ Backend เสร็จ. ปัจจุบันยังไม่มี signed/native test evidence

## Git / workspace workflow

ใช้ Git branches และ separate worktrees หรือ separate clones จาก base commit เดียวกัน. หาก repository ยังไม่พร้อม ให้ integration owner bootstrap ก่อน. ตัวอย่างชื่อ branch: `claude/col-01-settings-api`, `codex/col-02-flutter-settings`, `claude/col-03-web-settings`

1. ระบุ ticket, owner, base commit, allowed paths และ acceptance ก่อนเริ่ม
2. อีก agent ใช้ committed contract revision เดียวกัน; test fixtures ทำให้ไม่ต้องรอ server ตลอดเวลา
3. ทำ commit เล็กเฉพาะ ticket พร้อม tests และ handoff report
4. Integration owner review diff แล้ว merge ทีละ branch; ห้ามต่างคนต่าง merge/push integration branch พร้อมกัน
5. หลัง merge รัน contract + integration tests จาก combined commit; tests ของ branch เดียวไม่พิสูจน์ flow ทั้งระบบ
6. ส่ง combined commit ให้ทั้งคู่ update base ก่อน wave ถัดไป

Claude และ Codex ไม่ควรเปิดแก้ checkout เดียวกันพร้อมกัน เพราะ edits/lockfiles อาจปนก่อน commit. ไม่ใช้ force-push/reset/delete worktree ของอีกคน. การเชื่อม repository/private account เป็นสิ่งที่ผู้ใช้ต้องให้ access ใน environment ของ Claude; เอกสารนี้ไม่ได้สร้าง connection หรือส่งข้อความแทนผู้ใช้

## Prompt พร้อมส่งให้ Claude — COL-01

แทน `[BASE_COMMIT]` และ `[WORKSPACE]` ด้วยค่าจริงหลัง COL-00; หากยังไม่มี ให้เริ่มด้วยการตรวจและเสนอ contract/bootstrap ไม่อ้างว่ามีอยู่แล้ว

```text
คุณรับผิดชอบ COL-01: Backend settings API slice ของ TuneDeck
Workspace: [WORKSPACE]
Base commit/contract revision: [BASE_COMMIT]
Branch: claude/col-01-settings-api

อ่าน Docs/README.md, 03-Product-Requirements.md,
05-Technical-Architecture.md, 07-Contracts-and-Errors.md,
17-Backend-Web-Console.md, 19-Claude-Codex-Collaboration.md

Stack: TypeScript + NestJS + PostgreSQL; OIDC auth ตามเอกสาร
Allowed writes: services/api/** และ backend-specific tests
Root/lockfile/shared OpenAPI/infra changes ให้เสนอ diff ให้ integration owner ก่อนแก้

ทำเฉพาะ first slice:
1. API scaffold และ health/live/ready
2. GET /v1/me/settings และ PATCH /v1/me/settings
3. persistence/migration และ allowlisted theme/language validation
4. verified OIDC auth guard + ownership จาก actor token
5. optimistic concurrency/If-Match/revision ตาม shared OpenAPI
6. redacted structured request logs และ requestId/error envelope
7. meaningful tests: unauthorized, isolation สองบัญชี,
   invalid value, persisted reload, stale revision, DB failure

Mock identity ใช้ได้เฉพาะ test harness; ห้าม dev bypass เปิดใน runtime build
ถ้า contract/environment ยังไม่พร้อม ให้ทำ proposal และ unaffected scaffold ต่อ
อย่าทำ worker/catalog/billing/web ทั้งหมดใน ticket นี้
อย่า deploy production หรือเปลี่ยน requirements โดยพลการ

ส่งกลับ: commit/branch, changed files, commands+actual results,
run instructions, migrations/env keys, contract changes,
known limits และ tests ที่ not-run พร้อมเหตุผล
```

## Prompt พร้อมใช้กับ Codex — COL-02

```text
ทำ COL-02: Flutter settings client ของ TuneDeck จาก [BASE_COMMIT]
อ่าน Docs/03, 04, 05, 07, 13 และ 19 ที่ชื่อไฟล์ตรงใน repository
Allowed writes: apps/mobile/** และ Dart domain/persistence packages
Backend/API contract ใช้ revision ที่ Claude/Codex ตกลงใน COL-00

ทำ Flutter settings screen สำหรับ theme/language, typed API adapter,
loading/error/saved/stale-revision states และ isolated account cache
ใช้ fake adapter ใน tests เพื่อทำคู่ขนานกับ Backend; runtime ไม่อ้าง sync สำเร็จจาก mock
เตรียม interface สำหรับ verified account session; account token expiry
ต้องไม่หยุด direct radio session

ส่ง tests ที่ตรวจ request/response contract, persist/reload,
unauthorized/conflict และ UI states; ระบุ actual/not-run ตาม toolchain
อย่าแก้ services/api, web หรือ shared root manifests พร้อม Claude
ส่ง commit, handoff report และ integration steps
```

## Prompt ส่งให้ Claude รอบถัดไป — COL-03

```text
ทำ COL-03: Next.js user portal Login + settings + BFF
Base: [COMBINED_COMMIT_AFTER_COL_01]
Allowed writes: apps/console/** และ web tests
อ่าน Docs/04, 05, 17, 19 และ versioned OpenAPI

ใช้ OIDC server-side BFF; HttpOnly/Secure/SameSite session cookie,
CSRF defense; ไม่เก็บ tokens ใน browser localStorage
ทำ Login/session expiry/Logout, own settings theme/language,
saved revision, conflict 412 และ pending device-apply state
ใช้ Backend จริงใน integration test; unit/component tests ใช้ fixtures ได้
ทดสอบ cross-account isolation, expired session, invalid/stale save,
keyboard accessibility และ token redaction
ไม่เพิ่ม admin catalog/logs/billing ใน ticket นี้
ส่ง handoff ตาม template ด้านล่าง
```

## Handoff report — ต้องมีทุก ticket

```text
Ticket / owner:
Base commit / contract revision:
Branch / completed commit:
Changed paths:
Behavior delivered:
How to run locally:
Environment keys required (no secret values):
Migration + compatibility/rollback notes:
Test commands / actual outcomes:
Not-run or blocked checks + reasons:
API/bridge changes and downstream impact:
Known limitations:
Next ticket / integration steps:
```

Review ใช้ผลจริง: test pass ต้องมี command/result ไม่เพียงคำว่า “ผ่านทั้งหมด”. ไม่มี Mac/Flutter/รถทดสอบ ให้ระบุ not-run และทำส่วนที่ไม่พึ่งเครื่องต่อ ห้ามสร้าง screenshot/mock log แล้วเรียกว่า native/production evidence

## ปัญหาที่มักทำให้งานรวมกันไม่ได้

- ต่างคนอ่านคนละ revision → ส่ง base commit และ contract revision ทุกครั้ง
- API field/error/enum ไม่ตรง → generated clients + conformance fixtures; เปลี่ยน contract ก่อนแก้ dependent code
- ต่างคนแก้ root lockfile/migrations → owner เดียวต่อ ticket; separate worktrees ยังต้อง merge review
- frontend สำเร็จจาก mock แต่ไม่มี server behavior → acceptance ต้องมี combined end-to-end flow
- Claude เปลี่ยน scope/backend stackเอง → ใช้ PRD/ADR เป็นฐานและส่ง proposal เมื่อจำเป็น
- ซื้อ/CarPlay/Auto ถูก claim ผ่านจาก simulator → เก็บ gate status ตาม [QA](13-QA-and-Benchmarks.md)
- ส่งงานใหญ่ “ทำ Backend ทั้งหมด” → เริ่ม COL-01 แล้วส่ง COL-03 หลัง API baseline มีจริง

## เริ่มอย่างไรตอนนี้

ให้ Claude เข้าถึง repository และ Docs revision เดียวกันก่อน จากนั้นใช้ COL-00 เพื่อตกลง contract/bootstrap. ส่ง prompt COL-01 ให้ Claude และ COL-02 ให้ Codex หลัง baseline พร้อม. ผู้ใช้ไม่ต้องคัดลอกโค้ดด้วยมือทุกครั้งถ้าทั้งสองใช้ Git repository เดียวกันคนละ branch; handoff ผ่าน commit/diff พร้อม report

ตอนนี้มีเอกสารและแผนส่งงาน ยังไม่มี COL-00 baseline หรือ implementation commit. ขั้นที่ต้องทำต่อคือ bootstrap repository/toolchain และ versioned API contract เพื่อให้ทั้งสองเริ่มพัฒนาได้จากฐานเดียวกัน
