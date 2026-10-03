# QA, Benchmarks and Acceptance Plan

สถานะทุก test: **Not run** — repository ยังไม่มี native app ให้ทดสอบ เอกสารนี้ไม่ใช่รายงานผลผ่าน

## Test strategy and traceability

| Test ID | Requirement | Layer / coverage |
|---|---|---|
| T-IMPORT | FR-02, NFR-01/08 | unit malformed/encoding/limits + integration atomic commit/cancel/refresh |
| T-LIB | FR-03, NFR-02 | persistence/search + UI Thai query/favorite/relaunch |
| T-PLAY | FR-04, NFR-03/04 | adapter fixtures + device startup/stall/unsupported/rapid switch |
| T-AUDIO | FR-05 | lock/call/route change/user pause + steering remote |
| T-EPG | FR-06 | timestamp offset/DST/no-zone/overlap/manual mapping/stale |
| T-DIAG | FR-07, NFR-06 | failure mapping + expired credential + redaction |
| T-CAR | FR-08 | entitlement + wired/wireless/focus/connect lifecycle |
| T-UX | FR-01, FR-09, NFR-07 | onboarding + TH/EN + VoiceOver/large text/rotation |
| T-IAP | FR-10 | verified/pending/cancel/unverified/refund/revoke/restore/reinstall/offline |
| T-PRIV | FR-11, NFR-06 | export preview + secrets + delete DB/cache/Keychain/Keystore/logs |
| T-DB | NFR-08 | migration old→new, disk-full, rollback, import process death |
| T-SYNC | FR-12 | conflict/replay/tombstone/account switch/offline delete/quota |
| T-PREVIEW | FR-13 | primary session priority/cellular policy/background/thermal |
| T-CATALOG | FR-14 | rights approved/unexpired, attribution, disabled/offline source |
| T-PLATFORM | FR-15 | tvOS focus/remote, macOS keyboard/window/permissions |
| T-VIDEO | FR-16 | supported/unsupported/unavailable transition; no custom bypass |

## Minimum device matrix

Working baseline: iPhone 12-class physical device + deployment-minimum OS ที่ทีมเข้าถึงได้ และ current supported iOS บนอุปกรณ์รุ่นใหม่หนึ่งเครื่อง; iPad หนึ่งเครื่องทั้ง orientations. Record exact hardware/OS ไม่ใช้ simulator เป็นหลักฐาน performance. OS ที่หาเครื่องจริงไม่ได้ต้องระบุ unsupported/unverified scope ก่อน release

CarPlay: wired + wireless, touch + rotary ตาม support scope, simulator สำหรับ transitions และรถ/head unit จริงสำหรับ release. Network: stable Wi-Fi, cellular, offline, Wi-Fi→cellular handoff, high latency/loss, IPv6-only/NAT64 และ DNS failure. ทดสอบ app-owned endpoints และ compatible fixtures บน IPv6-only; source ภายนอกที่ไม่รองรับต้องมี diagnostics แยกจาก app defect. No CarPlay capability evidence = no CarPlay claim

## Reproducible benchmark protocol

1. ใช้ Release build, ระบุ commit/build hash, OS, device, battery/thermal state, fixture checksum และ test date
2. Controlled media fixture ที่มีสิทธิ์ใช้; profile A: 20Mbps down / 50ms RTT / 0% packet loss; profile B: 5Mbps / 150ms / 1% loss; บันทึกว่า network shaping ทำด้วยเครื่องมือใด
3. NFR-01: synthetic UTF-8 50k entries ≤25MiB, local file cached, measure parse+index+atomic commit; exclude download และ label ให้ชัด. Run 30 ครั้ง cold DB แล้วรายงาน p50/p95/max/RSS
4. NFR-02: warm index, 100 Thai/Latin queries รวม no-result/long-name; วัด query execution แยก debounce/render
5. NFR-03/04: อย่างน้อย 200 play attempts ต่อ primary format class บน profile A; วัด tap → first audible/frame, success window 15s, report failures และ latency percentiles ของ successes แยกกัน
6. Recovery: 30 Wi-Fi↔cellular และ 30 outage events; time recovery ตั้งแต่ network ใช้งานได้อีกครั้ง → media output. Controlled outage 3s และ 10s เพื่อเช็ค retry budget
7. 2-hour soak ในอุณหภูมิห้องปกติบน real device: memory trend, thermal transitions, energy, stalls. ทดสอบ thermal warning โดยวิธีที่ปลอดภัย/รองรับ; ไม่ต้องเอารถตากแดดเพื่อพิสูจน์ CPU

ถ้า p95 target ไม่ผ่าน ให้ profile และเสนอแก้ target/scope ใน ADR ห้ามเลือกตัดข้อมูลช้าออก. Consumer stream outage แยกจาก controlled-engine test และรายงานทั้งสอง ไม่โทษ network ทุกครั้ง

## APTV comparison

ใช้ version/storefront/device/fixture/network เดียวกันและสลับ order ของ runs; cache cold/warm แยก; ไม่มีการเปรียบกับตัวเลขโฆษณา. Sample paired startup/recovery ≥30 คู่ต่อ task สำหรับ exploratory benchmark แล้วเพิ่ม sample ตาม variance; report median/p95/count/intervals

User study 12–20 คนตาม strategy: same tasks, counterbalanced order, neutral prompts, completion/time/error/help requests. หากความต่างไม่ชัดเจนไม่ประกาศ winner. สิ่งที่ APTV/TuneDeck ไม่รองรับให้บันทึก coverage gap ไม่ให้ score performance เทียม

## Representative Given/When/Then

- Given library A, เมื่อ refresh ตัด network กลางทาง → A ยังอยู่ครบ, lastSuccess ไม่เปลี่ยน, retry ได้
- Given 401, เมื่อ reconnect loop จะเริ่ม → ไม่ยิงซ้ำอัตโนมัติ; มี action edit credentials
- Given user pause ระหว่าง interruption, เมื่อ call จบ → ยัง paused
- Given old play callback หลังเลือกช่องใหม่ → ไม่เปลี่ยน now playing/เสียงกลับไปช่องเก่า
- Given malformed XML with entity expansion → reject ตาม limit โดยไม่ network fetch external entity
- Given Backend account เปลี่ยน → ไม่เอา source metadata บัญชีเดิมไป sync อีกบัญชี
- Given revoked Pro → ข้อมูลยัง export/delete ได้และไม่มี forced playback interruption
- Given car video unavailable → ไม่มีภาพรถ แม้ GPS=0 หรือ source เพิ่ง reconnect

## Severity and release gates

P0: data loss/security leak/unsafe capability handling → block release. P1: core flow ใช้ไม่ได้/crash/reliability critical → block. P2: recoverable secondary issue → owner-approved documented exception พร้อม fix target

R1 exit: selected P0 FR tests ผ่าน, NFR evidence ครบ, zero open P0/P1 defects, crash-free ≥99.5% ใน ≥1,000 beta sessions, content/privacy/store packet ผ่าน, accessibility critical flows ผ่าน. Sample ไม่ถึงให้ขยาย beta ไม่เรียก gate ผ่าน. WIN metrics ใช้สำหรับ superiority claims แยกจาก technical release gate

## Report template

```text
Test ID / requirement / status (not-run/pass/fail/blocked):
Build + fixture checksum:
Device / OS / network / date:
Steps + expected + actual:
Sample count / p50 / p95 / failures:
Evidence location:
Defect ID / owner / retest build:
```

เก็บ real evidence ใน `Docs/evidence/<build>/` เมื่อมีผลจริง; ยังไม่สร้างไฟล์ผลทดสอบปลอมในงานนี้

## Revision 0.2 — additional traceability and gates

| Test ID | Requirement | Coverage |
|---|---|---|
| T-BRIDGE | FR-04, FR-05, FR-08, FR-17 | Swift/Kotlin contract parity, sequence gaps, attach/detach, cold snapshot, no duplicate player |
| T-AUTO | FR-17 | DHU + real head unit, activity closed/process recreation/user force-stop/focus |
| T-RADIO | FR-18 | internet MP3/AAC/HLS/ICY/variant/cellular/recovery both OS |
| T-AUTH | FR-19 | registration/verification/reset/login/PKCE/BFF/MFA/revoke/delete |
| T-RBAC | FR-19, FR-20, FR-21, FR-22, NFR-10 | own/other account + role matrix, direct endpoint/export/log access |
| T-WEB | FR-20, FR-21 | settings saved vs applied, device offline, session expiry, keyboard/a11y |
| T-CONFIG | FR-20, FR-21 | CAS/stale revision/schema/rollback/publish approval/safety constraints |
| T-OPS | FR-22, NFR-10 | seeded logs→search→alert, redaction/consent/retention, stale state |
| T-BE | FR-23, NFR-09, NFR-11 | API load, queue outage/replay, backup restore/deletion ledger, quotas |

Run original T-IMPORT/LIB/PLAY/AUDIO/EPG/IAP/DB/PRIV/UX บน Flutter iOS และ Android. T-IAP เพิ่ม Google verification/acknowledgement/pending/revoke/webhook replay/linked account conflicts. T-SYNC ใช้ Backend accounts แทน iCloud. Full R1 ต้องผ่าน T-AUTO/AUTH/RBAC/WEB/CONFIG/OPS/BE/RADIO เพิ่ม ไม่ถือแค่ mobile tests เพียงพอ

Physical Android baseline: proposed Android 10+ 4GB RAM และ current Android บนอย่างน้อยสอง OEM, battery optimization/Doze, notification denial ตาม OS behavior, force-stop, screen lock. Web: current Chrome/Safari/Firefox desktop + mobile viewport, no tokens in browser storage, expired auth, CSRF/XSS/IDOR, long/paginated logs. Record exact versions/toolchain

Backend load/availability targets วิธีวัดและ retention ตาม [17](17-Backend-Web-Console.md); API/UI stale state ที่ไม่มี telemetry sample เป็น unknown. Beta crash-free target ≥1,000 sessions ต้องรายงานแยก iOS/Android ไม่ให้ platform หนึ่งกลบอีก platform. Reprofile NFR-01 memory/time ภายใต้ Flutter runtime รวม native memory

ทุก test ใหม่ยัง **Not run**
