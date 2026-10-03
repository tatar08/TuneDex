# Release, Operations and Support Runbook

## CI pipeline ที่ต้องสร้าง

PR: format/lint → core unit/integration → parser fixtures → secret scan → simulator build/UI smoke. Main: archive signed staging build → device/beta tests → release candidate packet. Pin Flutter/Dart/Xcode/Swift/JDK/Gradle/Android SDK/Node/dependencies; Apple tooling jobs ต้องใช้ macOS runner ไม่ถือว่า Linux environment นี้ทำ native QA ได้

Signing certificates, App Store Connect keys และ passwords อยู่ secrets manager; least privilege; rotate และ revoke เมื่อมีเหตุ. Fastlane เป็น optional automation wrapper ไม่ใช่ข้อกำหนดให้เพิ่ม dependency ก่อนจำเป็น

## Release packet

- Build/commit/version/toolchain, supported OS/device/capabilities, migration notes
- Requirement/test report links, open P2 exceptions, performance + beta metrics
- CarPlay entitlement evidence และ real-car tests ถ้า scope มี CarPlay
- Rights ledger สำหรับ bundled sample/logo/EPG; privacy inventory และ network audit
- Apple/Google product configuration/restore/verification proof, localized price และ screenshots ตรง build
- Public privacy/support URLs, contact จริง, App Review instructions และ licensed demo source
- Rollout owner, incident owner, rollback/data compatibility decision

App Review notes อธิบายทุก feature ที่ใช้งานได้จริงและข้อจำกัด ไม่มี reviewer-detection, hidden menu หรือเปลี่ยน flag ให้ behavior ต่างจากลูกค้า [S05](16-Sources.md)

## Proposed App Review notes template

```text
TuneDeck is a user-supplied media playlist player.
Test import/playback using the licensed demo source included in this build.
Steps: Launch > Try demo > Select demo audio/video > Play.
Pro enables: [actual shipped capabilities only]. Restore: Settings > Purchases.
CarPlay: [include only approved category, supported configurations and test steps].
No source credentials are required for the supplied demo.
Contact: [replace with real owner contact before submission].
```

Template เป็น draft; unresolved brackets block submission

## Rollout and rollback

Internal → small TestFlight cohort → broader beta → App Store phased release ถ้าใช้ได้กับ release นั้น. Gate ทุกขั้นจาก QA ไม่ตั้ง production date จน evidence พร้อม

Trigger halt: data loss, exposed credentials, purchase rights incorrect, crash/session regression เกิน gate, CarPlay invalid capability behavior. Pause rollout, triage, create fixed build; App Store ไม่รับประกันย้อน binary ของทุกคนทันที จึงใช้ forward fix + backward-compatible data migration. Remote kill switch ถ้าไม่มีใน build จะอ้างใช้แก้ไม่ได้

ถ้าเพิ่ม remote config ในอนาคต: signed payload, version/expiry, allowlisted fields, last-known-safe default, disable-only critical gates. ห้ามใช้เปิดฟีเจอร์ที่ reviewer ไม่เห็น

## Monitoring แบบไม่เก็บเนื้อหาผู้ใช้

เริ่มจาก platform crash reports + opt-in diagnostic export และ beta test metrics; revision 0.2 เพิ่ม Backend operational telemetry และ opt-in client diagnostics ตาม [17](17-Backend-Web-Console.md). Production dashboard ที่ไม่มียอด sample ต้องแสดง unknown ไม่ใช่ 100% success

Monitor: crash-free rate, startup failures by error class, restore failures, catalog expiry, known OS regressions, support volume ต่อ 100 active testers/users เมื่อวัด denominator ได้. ถ้าเพิ่ม remote analytics ต้อง ADR/consent/data inventory ใหม่

## Incident playbooks

| Incident | Immediate action | Recovery / evidence |
|---|---|---|
| Stream provider outage | ตรวจ licensed fixture เทียบ affected source; อย่า retry fleet พร้อมกัน | แจ้ง source unavailable; library เดิมยังอยู่ |
| Import/data loss | halt rollout, preserve redacted diagnostics, ห้ามแนะนำ reinstall ก่อน backup | migration/restore fix + regression fixture |
| Credential leak | stop affected logging/export, restrict/delete exposed copies, rotate credentials ที่เราควบคุม | impact scope, remediation, owner determines notifications |
| Purchase/restore failure | verify Apple/Google environment/product/server state; ไม่ขายซ้ำให้แก้ปัญหา | fixed entitlement path + sandbox/production check |
| CarPlay crash/capability bug | halt affected rollout; disable เฉพาะมี documented control จริง | real-device reproduce + corrected build |
| Catalog rights complaint | ระงับรายการที่เราแจกจ่ายและเก็บหลักฐาน | rights owner review before reinstatement |

## Support flow

Support อยู่ Settings มี build/OS และ “สร้างรายงานที่ปิดบังข้อมูลส่วนตัว”. ผู้ใช้ตรวจรายงานก่อนส่ง. ไม่ขอ full playlist/token/password ใน public issue. Template ถาม error code, เวลาเกิด, device/OS, network class, steps โดยไม่บังคับส่งช่องที่ดู

## Maintenance cadence

Weekly beta bug triage; monthly dependency/source rights review; ทุก OS major update ทำ device/CarPlay/player regression; catalog expiry ตรวจอัตโนมัติเมื่อมี catalog pipeline. ผู้รับผิดชอบต้องมีคนจริงก่อน launch ไม่ใช้คำว่า “zero-ops 100%”

## User help content ที่ต้องมีในแอป

เริ่ม import, playlist vs stream ต่างกันอย่างไร, ทำไมบางช่องเล่นไม่ได้, EPG ไม่ตรงเวลา, restore purchases, CarPlay ไม่แสดง, วิธีลบข้อมูล, วิธีส่ง redacted diagnostic. ทุกหัวข้อควรอ้างข้อจำกัดจริงของ build และใช้ได้ offline สำหรับขั้นตอนพื้นฐาน

## Revision 0.2 — Flutter + Backend deployment runbook

CI lanes: Flutter analyze/unit/widget + iOS macOS build/Swift/bridge + Android Kotlin/Gradle/instrumented/bridge + Next.js browser E2E + NestJS API/schema/RBAC + OpenAPI Dart/TS generation drift check. Physical car/background tests remain separate from simulator CI

Services: console/BFF, API, worker, OIDC, PostgreSQL, Redis, object storage, OTel/metrics/logs. Stage identities/domains/buckets/keys แยก production. Migrate แบบ expand→dual-compatible code→backfill→contract หลัง old clients พ้น support window. Minimum API compatibility current+previous released mobile schema อย่างน้อย 90 วัน; major breaking contract ใช้ new API version

Deploy server canary → health/readiness/synthetic login+settings checks → gradual increase; rollback code ต้อง compatible migrated DB. User-facing failures ไม่เปิด bypass auth. Job queue loss replay จาก transactional outbox; IdP outage แสดง login unavailable แต่ public cached mobile playback ใช้ได้

Incident additions: RBAC/PII leak → restrict endpoint/export + preserve minimal evidence + review impact; auth compromise → revoke sessions/rotate keys; log overload → rate-limit/drop optional diagnostic batches ก่อน essential audit; station checker SSRF → stop checker/restrict egress. Audit write failures block privileged mutations ไม่ discard silently

Before launch: staff MFA, seeded-role isolation tests, actual alert delivery ในช่องทางที่ owner ตั้งค่า, RPO/RTO restore drill, deletion ledger replay, rights expiry job, tested Apple/Google callbacks และ rollback. Logs/alerts ไม่ส่งไป external Slack/email จากเอกสารนี้; integration destinations ยังต้องกำหนดใน implementation

Support instructions เพิ่ม Android Auto setup, internet-radio data usage, account/web settings sync, device revocation, diagnostic consent และ account deletion. เจ้าของ operations/on-call, cloud region/domain และ recurring budget ต้องกำหนดก่อน production
