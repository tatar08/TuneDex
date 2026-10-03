# Source Register and Evidence Limits

ตรวจเมื่อ **2026-10-04 (Asia/Bangkok)**. ใช้ official developer/vendor sources; ยังไม่ได้ติดตั้งหรือ benchmark APTV หรือ TuneDeck บนอุปกรณ์จริง. ไม่ใช้ review ของผู้ใช้เป็นข้อเท็จจริงเกี่ยวกับ implementation

| ID | Source | สิ่งที่รองรับ / ขอบเขต |
|---|---|---|
| S00 | [Local HTML](../gemini-code-1791046190658.html) | แนวคิด 13 screens, stack proposals, financial calculator, review-shield/GPS claims; ไม่ใช่ native implementation |
| S01 | [APTV official website](https://aptv.app/) | ผู้พัฒนาระบุ M3U/M3U8, previews, EPG, iCloud และ Apple platforms; ไม่ใช่ measured performance |
| S02 | [APTV CarPlay page](https://aptv.app/carplay) | vendor อธิบาย direct/local video, phone control และ DLNA receiver; หน้าเว็บระบุช่วง iOS 26.4–27.0. ไม่ยืนยันวิธีภายในหรือสิทธิ์ของ TuneDeck |
| S03 | [APTV App Store — China](https://apps.apple.com/cn/app/aptv/id1630403500) | listing ระบุ protocol/codec/PiP/casting/library และหลาย platform; Thai เป็นหนึ่งในภาษา. Storefront นี้ไม่ใช้เป็นราคาไทยหรือ universal rating |
| S04 | [Apple — Rev up your CarPlay app (WWDC26)](https://developer.apple.com/videos/play/wwdc2026/212/) | official video-app direction: supported vehicles, AirPlay video support, CarPlay browsing templates, video-unavailable/audio-only และ entitlement categories; ตรวจ SDK ก่อนลง code |
| S05 | [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) | ข้อ 2.3.1 เรื่อง hidden/undocumented functionality, 2.5.1 public APIs; ต้องตรวจ revision อีกครั้งก่อน submission |
| S06 | [Apple — Requesting CarPlay Entitlements](https://developer.apple.com/documentation/carplay/requesting-carplay-entitlements) | ขอ entitlement ตาม category และ provision/sign app; ไม่ถือว่าบัญชีนี้ได้รับสิทธิ์แล้ว |
| S07 | [Apple CarPlay developer overview](https://developer.apple.com/carplay/) | category/support overview และทางเข้า developer resources; capability ไม่ใช่ generic browser authorization |

## Interpretation boundaries

- “APTV มีความสามารถ X” ในชุดนี้หมายถึง vendor ระบุในหน้าอ้างอิง ไม่ใช่เราตรวจว่าทำงานทุกอุปกรณ์
- เว็บไซต์คู่แข่งและ SDK อาจใช้เงื่อนไข OS/car ต่างกัน จึงไม่เอาช่วง OS ของ APTV มาประกาศเป็น support matrix ของ TuneDeck
- Apple source สนับสนุนแนวทาง platform; class/member availability, entitlement key ของ video และ behavior แต่ละ SDK ยังต้องตรวจใน spike ไม่เติม signature ที่เดาเอง
- Performance, device baseline, limits, privacy retention, pricing, architecture และ timeline ใน Docs เป็นการออกแบบ/สมมติฐานของ TuneDeck ไม่ได้ยกมาจาก APTV หรือ Apple
- ไม่มีข้อสรุปว่าแหล่งวิทยุ/EPG ใดมีสิทธิ์ให้ bundle เพราะยังไม่ได้รับเอกสารสิทธิ์
- ไม่ใช้ download count, star rating หรือ self-score เป็น readiness evidence; ตัวเลขในเว็บ/แต่ละ storefront อาจต่างกัน

## Required future evidence

บันทึก URL + accessedAt + relevant revision ก่อน release; SDK/version references ที่เลือกจริง; fixture license/hash; signed build; device/network benchmark; rights approvals; StoreKit setup; privacy operator; paired usability results. รายการเหล่านี้ยังไม่ถูกสร้างหรืออ้างว่าผ่านในงานประเมินนี้

## Revision 0.2 — Flutter, Android and Backend sources

อ่านเอกสารทางการต่อไปนี้ในงานอัปเดต 2026-10-04; framework versions และ API availability ยังต้อง lock ใน spikes. Backend stack เป็น working design ของ TuneDeck ไม่ใช่ requirement ที่ vendor บังคับ

| ID | Source | Scope |
|---|---|---|
| S08 | [Flutter platform channels](https://docs.flutter.dev/platform-integration/platform-channels) | Flutter ↔ host code integration; ไม่ยืนยันว่า car/background support ฟรีจาก Flutter |
| S09 | [Flutter packages/plugins](https://docs.flutter.dev/packages-and-plugins/developing-packages) | platform/federated plugin organization; actual bridge/plugin versions ยังไม่เลือก |
| S10 | [Android media apps for cars](https://developer.android.com/training/cars/media) | media library/session car integration; Android Auto/AAOS contexts ต้องแยก |
| S11 | [Media3 background playback](https://developer.android.com/media/media3/session/background-playback) | service-owned player/session and lifecycle; current manifest/permissions ตรวจตาม SDK |
| S12 | [Android Auto DHU tests](https://developer.android.com/training/cars/testing/dhu) | Desktop Head Unit development testing; actual head-unit tests ยังต้องทำ |
| S13 | [Keycloak OIDC](https://www.keycloak.org/securing-apps/oidc-layers) | identity endpoints/flows; token/session durations ใน Docs เป็น proposed policy ของเรา |
| S14 | [NestJS authentication](https://docs.nestjs.com/security/authentication) | API auth infrastructure reference; TuneDeck RBAC/ownership ออกแบบเพิ่มเติม |
| S15 | [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/) | observability collection component; retention/SLO/rate limits เป็น proposed policy |
| S16 | [Google Play Billing security](https://developer.android.com/google/play/billing/security) | secure purchase verification guidance; shared store entitlement ไม่ presumed approved |

ยังไม่มี evidence ว่า Flutter package ใดผ่าน cold-start Android Auto/CarPlay, Backend รองรับ declared load หรือ OIDC/RBAC configuration ปลอดภัยจนทำ SP/test gates ครบ
