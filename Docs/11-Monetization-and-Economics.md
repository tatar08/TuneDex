# Monetization and Unit Economics

ทุกตัวเลขเป็น **scenario inputs สำหรับวางแผน** ไม่ใช่ราคา/ค่าธรรมเนียมปัจจุบันที่ยืนยันแล้วหรือผลประกอบการคาดการณ์ที่รับรอง

## Offer ที่เสนอ

R1 free/pro ตาม PRD: คุณค่าที่ขายคือการจัดการหลาย playlist และ organization; playback พื้นฐานและ diagnostics ไม่จำกัดเวลา. Product type เริ่มจาก non-consumable lifetime เพื่อลด billing complexity; ยังไม่ขาย subscription $1.99 ที่อยู่ใน mockup จนมี recurring value ที่ส่งจริงและต้นทุนชัดเจน

ราคา $24.99 เป็น test anchor เดิม ให้ Product owner เปรียบเทียบ willingness-to-pay และ storefront purchasing power; UI โหลด localized display price จาก StoreKit/Google Play Billing ห้าม hardcode dollar price ทุกประเทศ. ไม่เปรียบเทียบราคาคู่แข่งจากคนละ storefront/currency

## Purchase state contract

notPurchased → purchasing → pending / cancelled / failed / verified. Only verified → entitlement unlocked. Listen for transaction updates; finish transaction หลังส่งมอบสิทธิ์สำเร็จ. Restore เริ่มจาก user action; ไม่มี “RevenueCat synced” label ถ้าไม่ได้ใช้จริง

Offline ใช้ last verified local state ตาม store/native behavior ที่ทดสอบบน iOS/Android; ไม่ใช้ boolean ใน preferences เป็นหลักฐาน. Unverified transaction ไม่ grant ใหม่; revoked/refunded จัดการตาม read/export policy ใน PRD. Reinstall/relaunch/restore ต้องไม่คิดเงินซ้ำเพื่อคืนสิทธิ์เดิม

ถ้าเพิ่ม subscription ภายหลังต้องมี expired/grace/billing-retry states, cancellation disclosure และ recurrence value จริง; ไม่ใช้คำว่า lifetime สำหรับ subscription

## Model ที่แก้จาก HTML

กำหนด D=downloads, c=paid conversion, P=average paid price, r=refund fraction, f=store-fee scenario, v=variable support/service cost per payer, F=fixed operating costs, A=marketing, L=labor, T=tax/other adjustment

```text
payers = D × c
bookings = payers × P
refunds = bookings × r
net_sales = bookings - refunds
store_fees = net_sales × f
contribution = net_sales - store_fees - payers × v
operating_result_before_tax = contribution - F - A - L
planning_result_after_adjustments = operating_result_before_tax - T
break_even_payers = (F + A + L) / (P × (1-r) × (1-f) - v)
```

หาก denominator ≤0 ไม่มี break-even จาก volume ในโมเดลนี้. สูตร planning ตัด fee หลัง refunds เป็นสมมติฐาน simplified; settlement/tax/refund จริงต้องกระทบยอดจาก statement. **ห้าม clamp กำไรที่ศูนย์** และห้ามเรียก contribution ว่า net profit

## Scenario ตัวอย่าง 1 ปี (USD)

Inputs ร่วม: P=24.99, r=5%, v=1.50, F=1,500, A=3,000, L=18,000, T ไม่รวม; จำนวน downloads/fees เป็น assumption

| Scenario | D | c | f | Payers | Bookings | Operating result before tax |
|---|---:|---:|---:|---:|---:|---:|
| Low | 10,000 | 2% | 30% | 200 | 4,998.00 | -19,476.33 |
| Base | 50,000 | 4% | 15% | 2,000 | 49,980.00 | 14,858.85 |
| High | 100,000 | 6% | 15% | 6,000 | 149,940.00 | 89,576.55 |

Base contribution/payer = $18.679425; break-even ≈1,205 payers หรือ ≈30,113 downloads ที่ conversion 4%. เป้าหมาย gross $60,000 ที่ P=24.99 ต้องอย่างน้อย 2,401 payers ก่อน refunds ไม่ใช่หลักฐานว่าจะได้ยอดนั้น

ค่าแรง $18,000 และต้นทุนอื่นเป็น budget placeholders ต้องเปลี่ยนเป็นงบทีมจริง ไม่ควรนำไปอ้าง expected margin. Lifetime revenue มีภาระ support หลายปี; reserve และ cohort retention เป็นสิ่งต้องประเมินแม้ไม่มี streaming proxy

## Cost ledger ที่ต้องติดตาม

Developer membership/tooling, CI Mac minutes, test devices/car access, catalog/EPG rights, customer support, storage/metadata egress, crash diagnostics, localization, refunds, tax/accounting และ acquisition. BYO-stream ลด media egress ของเราแต่ไม่ทำให้ค่าใช้จ่ายทุกประเภทเป็นศูนย์

## Business gates

ก่อนขาย: products approved/configured, purchase/restore/revocation ผ่าน, free/pro copy ตรงกับ build. ก่อน paid campaign: actual activation funnel + support cost + conversion cohorts เพียงพอ; ห้ามตัดสิน CAC/LTV จาก lifetime gross margin ปีเดียว. Revenue dashboards aggregate เท่านั้น ไม่ต้องรับ source URL ของผู้ใช้

## Revision 0.2 — backend costs and cross-platform billing

ตารางตัวอย่างข้างต้นเป็น historical planning scenario ก่อนมี Backend ไม่ใช่งบ scope ใหม่. เพิ่ม F สำหรับ API/worker/PostgreSQL/identity/Redis/monitoring/backups/domains, v สำหรับ ingest/log retention/storage/egress/email/support และ L สำหรับ Flutter+Swift/Kotlin+web/backend+operations. ประเมินจาก regions/traffic/retention จริงก่อนตั้ง fixed budget ไม่ใช้ $1,500 เป็น validated server budget

Mobile iOS ใช้ StoreKit และ Android ใช้ Google Play Billing; server verify และรับ provider notifications แบบ idempotent/replay-safe. Backend ไม่ grant จาก client boolean หรือ user-supplied transaction ID อย่างเดียว. Android acknowledgement/Apple transaction completion ทำหลัง validated delivery ตาม platform flow ที่ทดสอบ; recover เมื่อ server retry/webhook ซ้ำ

Working policy: paid access store-scoped ใน R1; Login เดียวกัน sync settings ได้ทั้งสอง OS แต่ไม่สัญญาว่าซื้อบน Apple แล้วได้ Android อัตโนมัติ. ถ้าจะเพิ่ม shared entitlement ต้องตัดสิน commercial/store policy และ account-link anti-replay ก่อน. Guest purchase ยังใช้/restore ใน store account เดิมได้; linking ต้อง authenticated account + verified unique purchase และ conflict flow ไม่ย้ายสิทธิ์เงียบ ๆ

Web ไม่มี checkout ใน R1; แสดงสถานะ entitlement/support และไม่ตั้ง paid flag ผ่าน admin. Server-side store verification payload/identifiers อยู่ restricted billing storage และห้ามเข้า logs; provider outage ไม่ grant ใหม่จาก unverified data และไม่หยุด public radio ที่เล่นอยู่
