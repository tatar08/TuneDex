# Competitive Strategy — นิยาม “ดีกว่า APTV”

## Baseline ที่ตรวจได้

ตรวจเว็บไซต์และ App Store ณ 2026-10-04; เป็นความสามารถที่ผู้พัฒนา APTV ระบุ ไม่ใช่ผล hands-on ของเรา ดู [S01–S03](16-Sources.md)

| ด้าน | APTV ระบุไว้ | TuneDeck ที่เสนอ | ระยะ |
|---|---|---|---|
| Library | M3U, categories/favorites/history | import preview, diagnostics, stable identity | R1 |
| Playback | HLS, PiP, casting, หลาย protocol | AVPlayer-supported sources ก่อน พร้อม error recovery | R1; protocol อื่น R2 |
| EPG | programme guide | now/next + timezone correctness + manual mapping | R1 |
| Preview | live previews | ควบคุม bandwidth/thermal และหยุดเมื่อ background | R1.1 |
| Sync | iCloud | Backend account settings/catalog favorites R1; imported metadata R1.1 | R1 → R1.1 |
| Devices | iPhone/iPad/Mac/TV/Watch/Vision | Flutter iOS/Android; desktop/TV ยัง deferred | R1 → R2+ |
| CarPlay | เว็บไซต์ระบุ video และ DLNA | audio ที่ตรวจจริงก่อน; supported parked-video ภายหลัง | R1 → gated R2 |
| ภาษา | App Store ระบุภาษาไทยอยู่แล้ว | Thai UX ที่ทดสอบกับผู้ใช้จริง + English | R1 |

ภาษาไทยและ CarPlay เพียงอย่างเดียวจึงไม่ใช่จุดต่างที่พิสูจน์แล้ว เว็บไซต์คู่แข่งไม่บอกว่าไม่มี diagnostics หรือ recovery ที่เราคิดจะทำ ต้อง hands-on ก่อนอ้างว่าคู่แข่งขาดความสามารถใด

## กลุ่มแรกและงานที่ต้องทำให้ดี

กลุ่มแรก: ผู้ใช้ iPhone/iPad ในไทยที่มี playlist ของตน หรือฟังวิทยุออนไลน์ และต้องการต่อเนื่องระหว่างมือถือกับรถ

- เริ่มใช้ครั้งแรกได้โดยไม่สับสนระหว่าง playlist กับช่องเดี่ยว
- ช่องเสียแล้วรู้ว่าแก้ URL, สิทธิ์เข้าถึง, codec หรือ network ตรงไหน
- เปลี่ยน Wi-Fi/cellular หรือถูกโทรศัพท์ขัดจังหวะแล้วกู้ playback ได้
- กลับไปช่องโปรดได้เร็วโดยใช้ปุ่มในรถ

ไม่วางเป้าหมาย MVP เป็น “มีทุก feature มากกว่า APTV” เพราะยังไม่มีทีม/เวลา/ผลทดลองรองรับ

## Winning scorecard — ยังไม่มีผลวัด

| ID | งาน/ตัววัด | เป้าหมาย TuneDeck | เงื่อนไขอ้างว่าเหนือกว่า |
|---|---|---|---|
| WIN-01 | first successful play จาก playlist ที่ให้ | ผู้ทดลอง ≥80% ทำได้ใน 2 นาที | median time ต่ำกว่า APTV ≥20%, completion ไม่ด้อยกว่า |
| WIN-02 | แก้ URL หมดอายุ / malformed import | ≥80% เลือกวิธีแก้ถูกโดยไม่ถาม support | completion สูงกว่า ≥15 percentage points |
| WIN-03 | startup p95 ของ fixture | audio ≤3s; HLS video ≤5s | paired test เร็วกว่า ≥20%, success rate ไม่ด้อยกว่า |
| WIN-04 | handoff recovery | กลับมาเล่น ≤8s p95 หลัง network ใช้ได้ | stall duration ต่ำกว่า ≥20% |
| WIN-05 | CarPlay favorite → audio | ≤2 selections หลังหน้า Favorites เปิด | ไม่มากกว่า APTV ในงานเทียบเท่าที่รองรับ |

Threshold เป็น proposed targets ไม่ใช่ benchmark ของคู่แข่ง หาก sample น้อยหรือช่วงความเชื่อมั่นทับซ้อน ให้รายงานว่า inconclusive ไม่ใช้เป็นข้อความการตลาด

## วิธี validate

Product owner สัมภาษณ์ 8–12 คนก่อน beta: อุปกรณ์/รถ, แหล่ง playlist, เหตุการณ์ล้มเหลวล่าสุด, สิ่งที่ยอมจ่าย แล้วทำ paired usability study 12–20 คนสลับลำดับแอปเพื่อลด learning effect ให้ source/task/network เดียวกัน ขออนุญาตก่อนเก็บ screen recording

วัด objective metrics ตาม [QA](13-QA-and-Benchmarks.md) บันทึกเวอร์ชัน APTV/storefront, build TuneDeck, OS, device และข้อจำกัดทุกครั้ง คะแนนความชอบใช้ประกอบ ไม่แทน success rate

## Claim policy

R1 ใช้ข้อความ “จัดการทีวีและวิทยุของคุณ พร้อมเครื่องมือแก้ปัญหาแหล่งสตรีม” ได้เมื่อทำจริง ห้ามอ้างเร็วที่สุด, รองรับทุกช่อง, ดูทุกเว็บบนรถ, วิทยุถูกลิขสิทธิ์ทั้งหมด หรือดีกว่าทุกด้าน

ก่อนแคมเปญเปรียบเทียบต้องผ่าน WIN-01 และอย่างน้อยหนึ่งใน WIN-02/03/04 โดย playback reliability ไม่ถอย ถ้าไม่ผ่าน ให้ปรับ product ตามผล ไม่เพิ่ม feature count เพื่อกลบปัญหา

## Additional differentiation hypotheses

Android Auto + internet radio + web configuration/operations เป็น scope ที่ผู้ใช้เพิ่ม ไม่ใช่ผลยืนยันว่าชนะ APTV แล้ว. วัด journey “แก้ favorite บนเว็บ → sync มือถือ → เลือกฟังในรถ” โดย Android Auto ใช้ own acceptance baseline หาก APTV ไม่มี comparable platform; ไม่สร้าง benchmark ข้าม OS แล้วเรียกว่าเร็วกว่า
