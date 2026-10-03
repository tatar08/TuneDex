# CarPlay Feasibility and Capability Gates

## สิ่งที่ยืนยันจากแหล่งทางการ

Apple มีแนวทาง audio entitlement และ video บนรถที่รองรับเมื่อจอด; ระบบสามารถทำให้ video unavailable และใช้ audio-only. Templates เป็นแนวทางจัด UI ไม่ใช่การยืนยันว่า arbitrary web browser surface ใช้งานได้ รายละเอียดและ links อยู่ [S04, S06, S07](16-Sources.md)

APTV ระบุ behavior/ช่วง OS ของตนในเว็บไซต์ [S02] ซึ่ง **ไม่ใช่หลักฐานว่า TuneDeck ได้ entitlement หรือใช้ API แบบเดียวกันได้** ห้ามอนุมาน implementation ของคู่แข่งจากภาพหน้าจอ

## R1 audio architecture

Swift CarPlay adapter ส่ง intents เข้า native iOS PlaybackCoordinator เดียวกับ Flutter mobile bridge; root templates สำหรับ Favorites, Recent, Radio ตามจำนวน tabs/items ที่ current SDK อนุญาต; Now Playing ใช้ system template. กรองเฉพาะ radio/audio หรือ content ที่ยืนยัน audio eligibility แล้ว

Import, URL editing, purchase, restore troubleshooting และ privacy settings ทำบนมือถือก่อนใช้รถ. รถไม่แสดง paywall/keyboard/web shortcut grid. Template API availability และ maximum item counts ต้อง lock จาก SDK ใน SP-03 ไม่เดาจาก mockup 16:9

## Capability matrix

| Condition | Audio | Video |
|---|---|---|
| ไม่มี CarPlay connection | เล่นมือถือได้ | เล่นมือถือได้ตาม capability |
| มี audio entitlement + supported session | audio controls | ไม่ทำ custom video surface |
| ไม่มี video entitlement / รถไม่รองรับ | audio ตาม content | ไม่มี video entry point |
| video entitlement + supported OS/car + system allows | audio ตาม content | R2 path ที่ผ่าน test เท่านั้น |
| system บอก video unavailable หรือ state ไม่ทราบ | eligible audio-only หรือ pause | ไม่สร้าง/คงภาพบนจอรถ |
| GPS permission denied/off/accuracy ต่ำ | ไม่มีผลต่อ entitlement | ไม่ใช้ GPS เพื่ออนุมัติวิดีโอ |

ตั้งแต่ requirement นี้ ไม่มี toggle ที่ override safety/capability. GPS speed=0 หรือ <10 km/h ไม่ใช่หลักฐานว่า parked. MVP จึงไม่ขอ location permission และไม่ใช้ location เป็น interlock

## Spike SP-03 — audio (2–4 engineering days หลังเข้าถึง toolchain)

Deliverables: entitlement request record, signed prototype, native template list→audio, lock-screen/remote commands, connect/disconnect log, simulator และ real-car recording. ขอ entitlement early; เวลารอ Apple ไม่นับใน engineering estimate และไม่คาดเดาว่าจะผ่าน

Pass: provisioning ถูกต้อง, ใช้ public APIs, เล่น/หยุด/เปลี่ยนช่องได้ในรถจริง, interruption และ route change ผ่าน. Fail/block: ส่ง internal mobile core ต่อ; full release รอ gate หรือ explicit scope decision; ไม่ซ่อน behavior เพื่อส่ง review

## Spike SP-04 — video (3–5 engineering days หลัง prerequisites)

ตรวจ current SDK declarations/availability, entitlement process, supported vehicle และระบบ presentation/routing ของ Apple; build minimal legal owned video fixture. บันทึก OS/Xcode/car head unit และ capability transitions ไม่คัดลอกวิธี DLNA/VPN ของแอปอื่นโดยไม่มี evidence

Pass ต้องครบ: entitlement มีจริง, app ใช้ public path, video แสดงเฉพาะ supported/allowed state, unavailable แล้วภาพหายตามระบบ, audio fallback ใช้กับ eligible content เท่านั้น, reconnect ไม่ restore ภาพผิด state, source/vehicle compatibility ระบุได้

Stop condition: ไม่มี approved entitlement, ไม่มีรถรองรับให้ทดสอบ หรือใช้ public path ไม่ได้ → คง research status ไม่ทำ browser workaround และไม่ขาย video entitlement ให้ลูกค้า

## Real-device matrix

ก่อน R1 audio release: อย่างน้อย wired และ wireless session, touch และ rotary/focus input หากอยู่ใน support scope; 30 นาทีต่อ case + 2 ชั่วโมง soak ในสภาพแวดล้อมทดสอบปกติ, call/navigation interruption, network drop, disconnect/reconnect, app killed/restored, screen lock. ห้ามให้ผู้ขับเป็นผู้ทำ test interaction ระหว่างเคลื่อนรถ ใช้ test bench หรือผู้โดยสารตามบริบทที่เหมาะสม

สำหรับ R2 video: รองรับ/ไม่รองรับ video, allowed→unavailable→allowed, lost connection, stale callback, app resume, source audio-only/DRM failure. ไม่ทดลอง override ข้อจำกัดของรถเพื่อทำให้ test ผ่าน

## Review packet

แนบ entitlement evidence, capability table, source ที่ reviewer เข้าถึงได้อย่างมีสิทธิ์, demo steps และ known limits. Behavior เดียวกันสำหรับ reviewer และผู้ใช้. Remote rollout ในอนาคตต้องเปิดเผยค่าที่มีผลต่อ feature; ไม่เปิด hidden feature หลังตรวจ

## Flutter lifecycle integration

ตาม [05](05-Technical-Architecture.md), native coordinator และ cached browse snapshot ต้องพร้อมเมื่อ CarPlay scene เริ่มก่อน Flutter UI. Dart bridge attach/detach ไม่สร้าง player ซ้ำ; cold launch, UI engine restart และ Login/account switch เป็น T-CAR เพิ่ม. Android Auto เป็น adapter/service อีกระบบตาม [18](18-Android-Auto-and-Internet-Radio.md) ไม่ reuse CarPlay templates บน Android
