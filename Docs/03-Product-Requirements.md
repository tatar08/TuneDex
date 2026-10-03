# Product Requirements — TuneDeck R1

สถานะ: Proposed implementation baseline · Owner: Product + Flutter/native + Backend leads · Revision 0.2

## Product contract

TuneDeck ใช้ Flutter รองรับ iOS/iPadOS และ Android phone/tablet พร้อมวิทยุอินเทอร์เน็ต ไม่เป็นผู้ขายสิทธิ์ช่องรายการ. Mobile มี guest local mode; Login เพื่อ sync และตั้งค่าผ่านเว็บ. เว็บ private routes ต้อง Login เสมอ. Working minimum iOS/iPadOS 17 และ Android 10/API 29 ต้องยืนยันใน spike; live radio ต้องมี internet ไม่ใช่ FM hardware

R1 full scope รวม CarPlay audio, Android Auto audio และ Backend/web user+admin console. Capability gates ต้องผ่านก่อนประกาศรองรับ; internal mobile alpha ส่งก่อนได้แต่การตัด platform ออกจาก release ที่ผู้ใช้ขอต้องมี scope decision ใหม่. CarPlay video, AAOS, browser portal, Watch/Vision, recording, catch-up, AI subtitles, DLNA receiver และ multi-view ยังไม่อยู่ R1

## Requirements และ acceptance

| ID | P | Requirement | Acceptance condition |
|---|---|---|---|
| FR-01 | P0 | Onboarding เลือก import หรือ sample ที่มีสิทธิ์ | ผู้ใช้ข้ามได้; ไม่ขอ GPS; sample ล้มเหลวยัง import ได้ |
| FR-02 | P0 | Import M3U จาก file/HTTPS URL และแยก direct stream | แสดง valid/invalid/duplicate ก่อน commit; cancel ไม่เปลี่ยน DB; ทำซ้ำไม่เพิ่มซ้ำ |
| FR-03 | P0 | Library search/filter/favorite/recent | ค้นไทย/อังกฤษ; persisted หลัง relaunch; ไม่เล่นช่องเองเมื่อเปิดแอป |
| FR-04 | P0 | Native audio/video player | play/pause/stop, retry, track selection เมื่อมี; error มีคำอธิบายและ next action |
| FR-05 | P0 | Background audio / interruptions / remote controls | screen lock เล่นต่อ; call interruption/resume เคารพเจตนาผู้ใช้; unplug ไม่ส่งเสียงออกลำโพงเอง |
| FR-06 | P0 | XMLTV now/next | UTC storage, timezone display, stale/no-guide state; manual channel mapping |
| FR-07 | P0 | Source diagnostics + recovery | จำแนก auth/network/format/unsupported; ไม่แสดง secret; refresh fail เก็บ snapshot เดิม |
| FR-08 | P0 | CarPlay audio | native templates, favorites/recent/now playing; ผ่าน real-car gate; scope reduction ต้องบันทึก decision ใหม่ |
| FR-09 | P0 | Settings + accessibility | System/Light/Dark, TH/EN, text scaling, VoiceOver/TalkBack, clear cache/history; setting persist |
| FR-10 | P0 | StoreKit + Google Play Billing | purchase/restore/pending/verified/revoked; server verification/reconciliation และ no replay |
| FR-11 | P0 | Privacy + export/delete | export metadata แบบ redacted; delete local data สำเร็จ; diagnostic sharing เป็น opt-in |
| FR-12 | P0/P1 | Backend sync | R1 account settings/catalog favorites/device state; R1.1 imported library metadata; offline/conflict/delete/account isolation |
| FR-13 | P1 | Controlled live preview | ไม่เกินหนึ่ง active preview, muted, stop เมื่อออกจอ/thermal/network policy ไม่ผ่าน |
| FR-14 | P1 | Curated radio directory | แต่ละรายการมี rights record + owner + expiry; ถ้าไม่ผ่านให้ไม่มี catalog |
| FR-15 | P2 | tvOS/macOS clients | ใช้ core เดิม; ทดสอบ remote/focus และ keyboard บนแต่ละ platform |
| FR-16 | P2/Gate | Parked CarPlay video | ผ่าน public capability/entitlement/vehicle test; unavailable แล้วไม่มีภาพในรถ |
| FR-17 | P0 | Android Auto audio | browse/play via native service เมื่อ Flutter Activity ไม่เปิด; DHU + real-car tests |
| FR-18 | P0 | Internet radio | MP3/AAC/HLS fixtures, optional ICY, cellular policy, bounded reconnect; no FM/offline promise |
| FR-19 | P0 | Login/account/security | mobile PKCE, web BFF session, reset/verify/revoke; staff MFA; user account deletion |
| FR-20 | P0 | Web settings/devices | owner-scoped preferences/favorites, effective revision, conflicts, revoke, sync on next connection |
| FR-21 | P0 | Admin catalog/config | draft/review/publish/rollback + rights gates + immutable change history |
| FR-22 | P0 | Monitoring/logs/audit | redacted search/metrics/alerts, last-seen timestamps, no cross-account access, bounded retention |
| FR-23 | P0 | Backend operations | API authorization/idempotency, queue recovery, backup restore/deletion replay and availability evidence |


## Non-functional targets

| ID | Target | วิธีตรวจ |
|---|---|---|
| NFR-01 | Import 50k entries ≤3s p95, peak RSS ≤250MB | local fixture ≤25MiB, release build, baseline device; ไม่รวม download |
| NFR-02 | Search 50k ≤150ms p95 หลัง debounce 200ms | 100 mixed Thai/Latin queries; warm index |
| NFR-03 | Tap-to-audible ≤3s p95 / video ≤5s p95 | controlled legal fixtures, network profile ระบุใน QA |
| NFR-04 | ≥99% successful starts ใน 200 valid fixture attempts | แยก source outage กับ app regression; รายงาน raw count |
| NFR-05 | Crash-free sessions ≥99.5% ใน beta ≥1,000 sessions | ไม่พอ sample = gate ค้าง; ไม่มี known P0/P1 bug |
| NFR-06 | No source token/URL/content name ใน diagnostic export อัตโนมัติ | automated redaction tests + manual inspection |
| NFR-07 | VoiceOver/TalkBack/web keyboard และ text scaling | ทุก critical flow ใช้งานได้; focus ไม่หายหลัง reload |
| NFR-08 | Offline data consistent, no destructive partial import | cancellation/failure/crash-injection/migration tests |

ไม่มีสิ่งใดข้างต้นเป็นผลวัดแล้ว CPU “<25%” จาก HTML ถูกแทนด้วย thermal/session test ที่กำหนดสภาพแวดล้อม

## Plan และ free/pro default

Free: import 1 playlist สูงสุด 50k entries, playback ไม่จำกัดเวลา, favorites/recent/EPG, diagnostics, account preferences/catalog favorites sync และ CarPlay/Android Auto audio เมื่อผ่าน gates

Pro non-consumable: หลาย playlist (working cap 20), advanced library organization, metadata export ชุดใหญ่; advanced imported-library sync ในอนาคตขายได้หลังส่งจริงเท่านั้น การกู้ข้อมูลพื้นฐานและ privacy export ต้องใช้ได้ฟรี

เมื่อลดสิทธิ์จาก refund/revocation เก็บข้อมูลทั้งหมด; playlist ที่ pin เป็น active ยังเล่นได้ อีกชุดอ่าน/export/delete ได้และกลับมาใช้เมื่อมีสิทธิ์ ไม่หยุด stream กลางคันเพื่อแสดง paywall ปุ่มซื้อ/restore อยู่มือถือ

## Definition of Done

แต่ละ requirement มี implementation, meaningful tests, UI success/error/empty states, accessibility pass และ evidence link; R1 ต้องผ่าน P0 ทุกข้อที่ยังอยู่ใน release scope, ไม่มี unresolved critical risk และมี release packet ครบ การเลื่อน FR-08/FR-17 หรือ Backend ต้องยืนยัน scope decision และแก้ PRD/release notes/marketing พร้อมกัน

## Backend quality targets

NFR-09: API availability ≥99.9%/30 days; ordinary metadata p95 read ≤300ms/write ≤500ms ที่ declared load. NFR-10: authorization isolation + token/log redaction + revocation tests ผ่านทุก role. NFR-11: backup RPO ≤15min/RTO ≤4h พร้อม restore evidence. ทั้งหมดเป็น proposed targets ไม่ใช่ผลผ่าน; methodology ใน [17](17-Backend-Web-Console.md)
