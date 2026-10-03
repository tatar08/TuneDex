# Roadmap, Backlog and Handoff

Owner: Engineering lead + Product · Estimates เป็นช่วงวางแผน ไม่ใช่ commitment

## Delivery assumptions — revised scope 0.2

Scope เพิ่ม Flutter Android/iOS + native car adapters + web/API/identity/observability. ช่วง 9–14 สัปดาห์และทีม iOS คนเดียวจาก revision 0.1 **ยกเลิกเป็น commitment ของ scope ใหม่**. Working team: Flutter engineer + native Swift/Kotlin capability, backend/web engineer, part-time QA/design/operations; ถ้าคนเดียวต้อง estimate ใหม่อย่างมีนัยสำคัญ

| Phase | Planning envelope (ไม่ใช่ commitment) | Exit |
|---|---|---|
| G0 | 2–3 สัปดาห์ | dual native playback/cold car start + OIDC/RBAC prototype + deployment sizing |
| Core | 4–6 สัปดาห์เพิ่ม | Flutter library/radio/TV baseline ทั้งสอง OS + API/schema/login foundation |
| Integration | 4–6 สัปดาห์เพิ่ม | CarPlay/Auto, web settings/config/catalog/logs, sync + stores |
| Hardening | 3–4 สัปดาห์เพิ่ม | dual-platform beta, web/RBAC/load/restore tests, real-car gates |
| R1.1 | re-estimate | imported-library metadata sync/preview/catalog expansion |
| R2+ | discovery gated | tvOS/macOS exploration, parked CarPlay video |

Full R1 initial envelope 13–19 สัปดาห์เฉพาะเมื่อทีมข้างต้นมี capacity และ workstreams overlap ได้; external entitlement/store wait ไม่รวม. ต้อง re-estimate หลัง G0. Tickets ด้านล่างเปลี่ยนเป็น re-estimate แล้ว เพราะ native adapters และ Backend เพิ่มงานจากประมาณการเดิม

## Spikes

| ID | Question | Timebox | Deliverable / exit | Owner |
|---|---|---|---|---|
| SP-01 | Flutter/native bridge/toolchain/deployment targets | 1–2 days | signed iOS+Android Flutter build + bridge/cold-start snapshot + SQLite migration + pinned dependency choice | Flutter/native lead |
| SP-02 | AVPlayer + Media3 + ICY + parser limits | 2–3 days | codec matrix, 50k parse profile, metadata test; revise unachievable targets | Media lead |
| SP-03 | CarPlay audio | 2–4 days + entitlement wait | evidence ตาม CarPlay doc | Flutter/native lead |
| SP-04 | CarPlay video | 3–5 days หลัง prerequisites, R2 | capability proof หรือ documented no-go | Flutter/native lead |
| SP-05 | source/catalog rights | 1–2 days initial review | rights ledger + ship/no-catalog decision | Product/content |
| SP-06 | Android Auto cold-start service | 3–5 days | DHU + actual head-unit browse/play with Flutter UI closed | Android/native |
| SP-07 | Internet radio parity | 2–3 days | MP3/AAC/HLS/ICY/variants fixtures both OS | Media lead |
| SP-08 | Backend/identity/console | 3–5 days | PKCE+BFF+MFA, two-user RBAC isolation, config sync, logs, sizing | Backend/web |

## Implementation tickets

| ID | Scope / requirements | Depends | Estimate (eng days) | Acceptance / evidence |
|---|---|---|---:|---|
| TD-01 | App scaffold, CI, module boundaries | SP-01 | re-estimate | simulator build/unit job, environment config checked |
| TD-02 | DB schema, migrations, secret store | TD-01 | re-estimate | T-DB, NFR-06/08; rollback + token redaction |
| TD-03 | M3U parser + staging importer FR-02 | TD-02, SP-02 | re-estimate | T-IMPORT; 50k fixture report |
| TD-04 | Onboarding/import UI FR-01/02 | TD-03 | re-estimate | valid/error/cancel/duplicate walkthrough |
| TD-05 | Library/search/favorites/recent FR-03 | TD-02 | re-estimate | T-LIB, NFR-02; relaunch persistence |
| TD-06 | Native session/AVPlayer+Media3 bridge FR-04 | TD-01, SP-02 | re-estimate | T-PLAY; stale callback/rapid switch tests |
| TD-07 | Background/remote/interruption FR-05 | TD-06 | re-estimate | T-AUDIO real-device trace |
| TD-08 | XMLTV + guide mapping FR-06 | TD-02/03 | re-estimate | T-EPG; timezone/no-guide cases |
| TD-09 | Diagnostics/retry FR-07 | TD-03/06 | re-estimate | T-DIAG; redacted actionable errors |
| TD-10 | CarPlay audio FR-08 | TD-05/07, SP-03 pass | re-estimate | T-CAR real-car matrix; scope gate |
| TD-11 | Settings/localization/a11y FR-09 | TD-04/05/06 | re-estimate | T-UX TH/EN/VoiceOver/TalkBack/large text |
| TD-12 | Apple/Google stores + server verification FR-10 | TD-05, TD-20, products configured | re-estimate | T-IAP sandbox + refund/reinstall |
| TD-13 | Privacy/export/delete FR-11 | TD-02/09 | re-estimate | T-PRIV; secret scan/delete proof |
| TD-14 | Beta/benchmark/release | P0 tickets + SP-05 | re-estimate | R1 gate and packet from QA/ops |
| TD-15 | Backend settings/catalog favorites sync FR-12 | TD-20/21, API ready | re-estimate | T-SYNC conflict/account-switch/delete |
| TD-16 | Controlled preview FR-13 | R1 stable | re-estimate | T-PREVIEW resource policy |
| TD-17 | Catalog FR-14 | SP-05 pass | re-estimate | rights ledger + broken source fallback |
| TD-18 | tvOS/macOS FR-15 | R1 core stable | re-estimate | platform-specific focus/remote/input QA |
| TD-19 | Parked video FR-16 | SP-04 pass | re-estimate | T-VIDEO and source rights |
| TD-20 | Backend schema/API/OIDC/login FR-19/23 | SP-08 | re-estimate | T-AUTH, T-RBAC, T-BE |
| TD-21 | Web user settings/devices FR-20 | TD-20 | re-estimate | T-WEB, T-CONFIG, two-device sync |
| TD-22 | Native Android Auto FR-17 | SP-06, TD-05/06/07 | re-estimate | T-AUTO cold process/head-unit |
| TD-23 | Internet radio UX + variants FR-18 | SP-07, TD-05/06 | re-estimate | T-RADIO cross-platform fixtures |
| TD-24 | Admin catalog/config FR-21 | TD-20, SP-05 | re-estimate | T-RBAC/T-CONFIG/T-CATALOG |
| TD-25 | Logs/metrics/audit/alerts FR-22 | TD-20 | re-estimate | T-OPS and retention/redaction |
| TD-26 | Infra/jobs/backup/delete pipeline FR-23 | TD-20/25 | re-estimate | T-BE restore/outbox/load evidence |
| TD-27 | Imported metadata sync extension FR-12 P1 | R1 stable | re-estimate | T-SYNC full reconcile/tombstones |

TD-14 full-release gate ขึ้นกับ P0 tickets รวม TD-15 และ TD-20 ถึง TD-26. SP-04/TD-19 และ TD-27 เป็น deferred scope. Engineering lead จัด sprint capacity หลัง G0; ไม่ assume native work หายไปเพราะ Flutter

## Sprint 1 ที่เริ่มได้

ทำ SP-01/02/06/08, เปิด entitlement request SP-03 และสิทธิ์ SP-05 แล้วส่ง vertical slice “Flutter iOS/Android → play owned internet radio → background controls → web Login เปลี่ยน preference → sync → redacted event ใน console”. Deliver runnable build และ test report ไม่ใช้ mock screenshot แทน

เอกสารชุดนี้ไม่ได้เปิด ticket ใน external tracker หรือส่งข้อความหาใคร; IDs เป็น local backlog ที่นำไปสร้าง issue ได้

## Cut rules เมื่อเวลาไม่พอ

เลื่อน preview, imported-library advanced sync, catalog expansion, advanced track UI, CarPlay video และ platform เพิ่ม. Android Auto, internet radio และ Backend/web เป็น requested R1 scope ไม่ตัดทิ้งเงียบ ๆ; scope reduction ต้องมี decision ยืนยัน. ห้ามตัด integrity/RBAC/redaction/purchase verification/privacy deletion/crash fixes

## Handoff ticket template

```text
ID / title:
Requirement IDs:
Owner / reviewer:
Inputs / outputs / error codes:
Data migration:
UI loading / empty / error / success:
Dependencies / capability gate:
Acceptance test IDs:
Evidence artifact / build / device:
Known limits:
```

การเปลี่ยน scope ต้อง update PRD, ticket, tests, paywall/marketing และ ADR ใน PR เดียวกัน

## Claude + Codex work allocation

ใช้ [คู่มือแบ่งงาน](19-Claude-Codex-Collaboration.md): Claude ทำ Backend/web/worker, Codex ทำ Flutter/native media และรวมระบบ. เริ่ม COL-00 shared contract/bootstrap → COL-01 API กับ COL-02 mobile → COL-03 web. COL IDs เป็นชุดย่อยของ TD tickets ไม่ได้แทน release backlog; ทุกงานมี separate branch, owner paths และ handoff evidence. ยังไม่ได้ assign ผ่าน external system หรือเริ่ม implementation
