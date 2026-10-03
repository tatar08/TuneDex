# ผลตรวจความพร้อมและการแก้ Blueprint

วันที่ 2026-10-04 · Input: [gemini-code-1791046190658.html](../gemini-code-1791046190658.html)

## ผลตรวจจาก repository

พบ HTML blueprint, ไฟล์ design export และภาพ reference; `Docs` ว่างก่อนงานนี้ ไม่พบ Swift source, Xcode project, native player, parser package, tests หรือ CI ในไฟล์ที่มองเห็นของ workspace จึงประเมินว่าเป็นแนวคิดและ prototype ของเอกสาร ไม่ใช่แอปที่พร้อม implement ต่อจาก production code

JavaScript ใน HTML มีการสลับแท็บ, คำนวณการเงิน และเปลี่ยน label/CSS ของ settings เท่านั้น: `setSystemTheme` ไม่ใช่ theme engine, `setSystemLanguage` ไม่ได้แปลแอป, `toggleLocationPermission` ไม่ได้ขอสิทธิ์ OS ไม่มี player/import/purchase/sync integration จริง ค่าจำนวนช่อง, stream quality และผล parser เป็นข้อมูลจำลอง

## สิ่งที่มีและสิ่งที่ยังขาด

| ด้าน | สิ่งที่มี | ช่องว่าง | เอกสารปิดช่องว่าง |
|---|---|---|---|
| Product | แนวคิด TV + Radio + Car | ไม่มี persona/validation/นิยามความเหนือกว่า | 02, 03 |
| UX | C1–C7, M1–M6 | ขาด onboarding, loading/error/empty, accessibility | 04 |
| Architecture | ชื่อ Swift/KMP/Supabase/RevenueCat | ยังไม่เลือก stack และไม่มี boundary | 05, 15 |
| Data | M3U/EPG/iCloud ถูกกล่าวถึง | ไม่มี schema, dedup, migration, conflict rule | 06, 07 |
| Playback | ภาพ UI 1080p/4K | ไม่มี protocol matrix, retry, lifecycle | 08 |
| CarPlay | custom web/video mockups | entitlement และความเป็นไปได้บน public API ยังไม่พิสูจน์ | 09 |
| Security | อ้าง on-device GPS | ขาด secret handling, import validation, data lifecycle | 10 |
| Business | calculator และ lifetime | สมมติฐานไม่ validate, ตัด loss ออก | 11 |
| Delivery | 8-week outline | ไม่มี dependency/acceptance/release gates | 12–14 |

## รายการแก้ที่ต้องใช้แทนข้อความเดิม

ตำแหน่งบรรทัดอ้างอิงจากไฟล์ต้นฉบับก่อนแก้ไข ไม่มีการแก้ HTML ในงานนี้

| จุดเดิม | ปัญหา | ข้อกำหนดใหม่ |
|---|---|---|
| บรรทัด 97–99, 1205–1210: Review Shield | remote flag สำหรับพรางฟีเจอร์ไม่ใช่ risk mitigation ที่ใช้ส่งจริงได้ | เปิดเผย behavior ให้ review; flags ใช้ rollout/disable เฉพาะ behavior ที่ตรวจแล้ว [S05] |
| C1–C4: shell → web portal → YouTube → full-screen | layout ไม่ยืนยันว่า CarPlay รองรับ browser หรือบริการนั้นให้ใช้ | เปลี่ยน MVP เป็น native audio templates; video เป็น gated extension [S04] |
| C5: “APTV CarPlay” | branding คู่แข่งค้างใน mockup | ใช้ TuneDeck และ asset ที่มีสิทธิ์ |
| C6: 0.8s / 4K / in-memory cache | ไม่มี fixture/device/measurement | กำหนด benchmark reproducible; database แบบ persistent |
| บรรทัด 787: GPS >10 km/h | ต่ำกว่า threshold ไม่ได้แปลว่าจอด; ปิด permission แล้วปลดล็อกไม่ได้ | video ต้องขึ้นกับ OS/vehicle capability ไม่ใช่ GPS หรือ toggle |
| M2: 142 / 40,000 ช่อง | ไม่ใช่ผลนำเข้าจริง; presets 20+ กับ directory 40k ขัดกัน | แสดงจำนวนจาก import; directory จำกัดตามรายการที่ตรวจสิทธิ์แล้ว |
| M5, settings: Pro ปลดล็อก YouTube | ไม่ได้พิสูจน์สิทธิ์/compatibility | ขาย library tools ตาม PRD; ไม่ขายสิ่งที่ capability gate ยังไม่ผ่าน |
| บรรทัด 844: Swift / KMP, Supabase / iCloud | stack และระบบ sync ซ้ำหน้าที่ | Flutter + native media adapters, local DB + Backend sync ตาม revision 0.2 |
| คะแนน 9.8/10, 38/40, READY TO SHIP | self-score ไม่มี evidence | readiness gates แทนคะแนน |
| `Math.max(0, grossBillings-storeFee-fixedCostsUSD)` | ซ่อนผลขาดทุน; “net profit” ขาดค่าแรง/marketing/refunds | รายงาน contribution / operating result และอนุญาตค่าติดลบ |
| 84%+, zero variable cost, zero-ops | ยังไม่รวมภาระ support/catalog/monitoring | cost ledger + runbook; ไม่สัญญาไร้ต้นทุน |
| 8 weeks + หลาย Apple platforms + Android | scope ไม่สัมพันธ์กับทรัพยากร | แบ่ง R1/R1.1/R2 และประมาณใหม่หลัง spikes |

## Readiness decision

**Go:** เริ่ม parser, local library, iPhone player และ audio lifecycle prototype ตาม backlog ได้

**Conditional:** CarPlay audio รอ entitlement/signing; catalog รอ source rights; monetization รอ product configuration

**No-go สำหรับ production:** ไม่มี implementation/test evidence; ไม่มี real-device playback/CarPlay proof; ไม่มี privacy/content release packet

การมี Docs ครบช่วยลดความคลุมเครือ ไม่ได้เปลี่ยนสถานะเป็น ready-to-ship อัตโนมัติ

## Definition of Ready ต่อ ticket

ต้องระบุ requirement ID, input/output, UI states, data changes, dependency, acceptance test และ failure recovery; ถ้าพึ่ง capability ที่ยังไม่พิสูจน์ ให้เป็น spike ที่มี stop condition แทน feature ticket

แหล่งอ้างอิงนโยบายและข้อเท็จจริงภายนอก: [Source register](16-Sources.md)

## Scope update 0.2

ผลตรวจ HTML ข้างต้นคงเป็นหลักฐานต้นฉบับ แต่ scope implementation ล่าสุดรวม Android/Android Auto, internet radio และ web Backend ตาม [05](05-Technical-Architecture.md). Foundation tasks ต้องใช้ Flutter และมี API/auth spikes เพิ่ม; ข้อเสนอ Apple-only เดิมไม่ใช่ active architecture แล้ว
