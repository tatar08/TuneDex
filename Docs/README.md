# TuneDeck — Implementation Docs

วันที่ประเมิน: **4 ตุลาคม 2026** · ภาษาเอกสาร: ไทย · Revision: 0.2

**ข้อสรุป: HTML เดิมยังไม่พร้อมเป็น implementation specification และยังไม่พร้อมส่งแอปจริง** เอกสารชุดนี้เติมข้อกำหนดและแผนทำงานให้เริ่มพัฒนา foundation / technical spikes ได้ แต่ไม่ได้ยืนยันว่า capability ของ CarPlay, สิทธิ์เนื้อหา หรือผล benchmark ผ่านแล้ว

เป้าหมาย: ทำ TuneDeck ให้ดีกว่า APTV ในงานที่ผู้ใช้ทำจริง โดยเริ่มจากนำเข้า playlist ง่าย เล่นเสถียร แก้ปัญหา source ได้เอง และใช้งานวิทยุในรถได้สะดวก จากนั้นขยายความสามารถตามหลักฐาน ไม่ประกาศเหนือกว่าทุกด้านตั้งแต่ MVP

## วิธีใช้

1. อ่าน [ผลประเมินและรายการแก้ blueprint](01-Readiness-Audit.md) และ [คู่แข่ง / เกณฑ์ชนะ](02-Competitive-Strategy.md)
2. ใช้ [PRD](03-Product-Requirements.md), [สเปก UX](04-UX-Screen-Specification.md), [สถาปัตยกรรม](05-Technical-Architecture.md) เป็นฐาน implementation
3. ลงรายละเอียดด้วย [ข้อมูลและ sync](06-Data-and-Sync.md), [สัญญาระหว่างโมดูล](07-Contracts-and-Errors.md), [media engine](08-Media-Engine.md)
4. ตรวจ [CarPlay](09-CarPlay-Feasibility.md), [security/privacy/content](10-Security-Privacy-Content.md), [รายได้](11-Monetization-and-Economics.md)
5. เริ่มงานจาก [roadmap/backlog](12-Roadmap-and-Backlog.md); ตรวจรับด้วย [QA](13-QA-and-Benchmarks.md) และ [release/operations](14-Release-and-Operations.md)
6. บันทึกหลักฐานใน [decision/risk register](15-Decisions-Risks-and-Questions.md) และ [source register](16-Sources.md)
7. แบ่งงานและส่งต่อให้ Claude ตาม [Claude + Codex collaboration](19-Claude-Codex-Collaboration.md) ซึ่งมี ownership, ลำดับงาน และ prompt พร้อมใช้

## สถานะและลำดับความสำคัญ

- `Observed`: ตรวจจากไฟล์หรือแหล่งข้อมูลที่ระบุแล้ว ไม่เท่ากับทดสอบแอปจริง
- `Proposed`: ข้อเสนอออกแบบในเอกสารนี้ ให้ใช้เป็น working default จนมี decision ใหม่
- `Gate`: ต้องมีหลักฐานก่อนปล่อย capability ที่เกี่ยวข้อง
- `P0 / R1`: Flutter iOS/Android, internet radio, CarPlay/Android Auto audio, Backend/Login/web settings และ monitoring/logs
- `P1 / R1.1`: imported-library metadata sync เพิ่มเติม, preview และ catalog expansion หลัง baseline เสถียร; account settings/catalog favorites sync อยู่ R1
- `P2 / R2+`: tvOS/macOS, CarPlay video ที่ผ่าน capability gate และ platform เพิ่มเติมภายหลัง

ชุดนี้เป็นเอกสารใน repository ตามคำขอเก็บ `Docs` ไม่มีการสร้าง living doc ภายนอก และไม่มีการ implement แอปหรือส่ง App Store ในงานครั้งนี้

## Source of truth

ข้อกำหนดใน Docs เป็น **ข้อเสนอฉบับปรับปรุง** ที่ให้ใช้แทนส่วนขัดแย้งของ HTML โดยมี mapping ใน audit; HTML ต้นฉบับเก็บไว้เป็นหลักฐานแนวคิด ห้ามใช้คะแนน “READY TO SHIP” เป็น release gate

ทุกตัวเลข performance, conversion, ราคา และระยะเวลาในสเปกเป็น **เป้าหมายหรือสมมติฐาน** จนมีผลทดลองแนบ เจ้าของงานระบุเป็น role เพราะยังไม่มีรายชื่อทีม ประเด็นค้างที่ต้องตอบมี owner และผลกระทบใน decision register

## ความพร้อม ณ ตอนนี้

| ขั้น | สถานะ | หลักฐานที่จะทำให้ผ่าน |
|---|---|---|
| เริ่ม foundation / parser prototype | พร้อมเริ่มตามข้อเสนอ | ใช้ PRD และ backlog |
| เริ่ม Flutter/native integration | มีสเปก แต่ยังต้อง provision toolchain | iOS+Android signed builds + native bridge + fixture playback |
| CarPlay audio release | ยังไม่ผ่าน gate | entitlement + real-car test |
| CarPlay video | research gate | public API + OS/vehicle support + entitlement + actual test |
| Claim “ดีกว่า APTV” | ยังไม่พิสูจน์ | benchmark และ usability study แบบเทียบกัน |
| Android Auto audio | ยังไม่ผ่าน gate | media service cold start + DHU + real head unit |
| Backend/Login/web/ops | มีสเปก ยังไม่ deploy | API/RBAC/MFA + config/logs + load/restore evidence |
| Production release | ยังไม่พร้อม | implementation + QA + content/privacy + all platform/server gates |

## Revision 0.2 — scope ที่ผู้ใช้เพิ่ม

ใช้ [05 — Flutter architecture](05-Technical-Architecture.md) เป็นสถาปัตยกรรมล่าสุด และอ่าน [17 — Backend/Web/Login/Logs](17-Backend-Web-Console.md), [18 — Android Auto/Internet Radio](18-Android-Auto-and-Internet-Radio.md) เพิ่มเติม. เว็บมี customer settings และ staff operations แยกสิทธิ์; mobile guest เล่น local radio ได้และ Login เพื่อ sync กับเว็บ

Swift-first/CloudKit-only/no-backend ใน revision 0.1 ถูกแทนแล้ว. Audit HTML ใน 01 เป็น historical assessment; เอกสารนี้เป็นการออกแบบ ยังไม่ได้ build/deploy Backend หรือแอป. Android Auto, auth/RBAC, backup/restore และ server load tests ยัง Not run
