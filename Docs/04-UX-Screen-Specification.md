# UX and Screen Specification

Owner: Product/design · ทุกหน้าด้านล่างเป็น behavior specification ยังไม่ใช่ visual design ที่ทดสอบแล้ว

## Navigation

มือถือ: Library / Favorites / Radio / Settings และ persistent mini-player ที่เปิด Now Playing; recent อยู่ใน Library. iPad ใช้ sidebar + detail โดยข้อมูล/selection เดียวกัน ไม่ lock ทั้งแอปเป็น portrait. Import, source detail, diagnostics, guide และ paywall เป็น secondary routes

## Mapping จาก 13 หน้าจอเดิม

| เดิม | สถานะใหม่ | Behavior |
|---|---|---|
| M1 Home | ปรับเป็น Library | search, group filter, recent, mini-player, add source |
| M2 Import | แยก input → validate → preview → commit | นับผลจริง; inspect invalid rows; cancel/retry |
| M3 PiP Player | Now Playing + Guide detail | PiP เมื่อ device/source รองรับ; quality ระบุ auto/manual เท่าที่ engine รองรับ |
| M4 In-Car Hub | Connection help | บอก audio/video capability และวิธีแก้; ไม่ควบคุม browser |
| M5 Paywall | Pro library tools | localized store price (Apple/Google), restore, pending/error state |
| M6 Settings | Settings sections | appearance/language/data/privacy/purchase/help |
| C1 Quick shell | CarPlay root | Favorites / Recent / Radio ผ่าน templates ตามข้อจำกัด OS |
| C2 Web launcher | ตัดออก R1 | ห้ามใช้ภาพนี้เป็น platform contract |
| C3 Embedded YouTube | ตัดออก R1 | ไม่มี provider integration ที่พิสูจน์แล้ว |
| C4 Fullscreen video | R2 gated | OS-supported presentation, capability changes handled |
| C5 Audio | Native Now Playing | TuneDeck identity, artwork/metadata fallback, remote controls |
| C6 TV grid + EPG | บนมือถือ R1; รถ R2 gated | CarPlay R1 แสดงเฉพาะ audio-eligible content |
| C7 Master Settings | ย้าย editing/billing มามือถือ | รถมีเฉพาะ supported actions ที่ไม่ต้อง typing |

## Screens ที่ต้องเพิ่ม

| Route | Empty/loading | Failure | Success/action |
|---|---|---|---|
| First launch | ไม่มี library → Import / Try demo | demo ไม่พร้อม → Import | อธิบายว่าไม่มี bundled TV subscription |
| Import input | file picker / paste URL แบบ user action | URL invalid, insecure HTTP, private host | validate ก่อน request |
| Import preview | progress + cancel | invalid rows/count, over-limit, encoding | เลือก commit valid rows; all-invalid commit ไม่ได้ |
| Source detail | last refresh / channel count | stale/auth required/removed source | refresh, edit URL, delete พร้อมจำนวนที่กระทบ |
| Diagnostics | checking แบบ cancellable | reason code และข้อความคนอ่านรู้เรื่อง | test again / edit source / copy redacted report |
| EPG detail | no guide / stale badge | parse/timezone mismatch | now/next, manual map/reset mapping |
| Purchase/restore | fetching localized product | offline/pending/revoked/verification fail | verified entitlement แล้ว dismiss |
| Data & Privacy | local usage summary | export failed/disk full | preview export; delete history หรือ all local data |
| Account/sync (R1 + R1.1 extension) | guest/login/queued/syncing | auth expired/backend down/conflict/quota | login, retry, pause, choose revision |

## Critical journeys

**Import:** Add → URL/file/direct-stream → validate → preview summary → confirm → library filtered to new source → select channel → player. Validation/download ไม่เริ่ม playback. Duplicate source เสนอ refresh เดิมหรือสร้างแยกโดยตั้งชื่อชัดเจน

**Broken source:** player timeout → ข้อความ “เชื่อมต่อแหล่งสตรีมไม่สำเร็จ” → retry bounded → diagnostics → edit/re-auth → revalidate → play. แสดง source display name แทน URL ที่มี token

**Background:** play audio → lock screen → pause ผ่าน remote → return → ยังคง paused. ห้าม reload หน้าจอแล้ว autoplay ทับเจตนาผู้ใช้

**Offline:** เปิด library/favorites/recent ได้, EPG cached มีเวลาที่ update ล่าสุด, play บอกไม่มี network; network กลับไม่เล่นเองเว้นแต่ยังอยู่ใน retry ของ session ที่ผู้ใช้เริ่ม

**Car connection:** เชื่อมรถ → แสดง favorite audio → select → Now Playing; disconnect → pause ถ้า route ใหม่เป็น speaker และไม่ resume อัตโนมัติ

## Interaction and accessibility

มือถือ hit target เป้าหมาย ≥44×44 pt, normal text contrast ≥4.5:1 เป็น design targets. รองรับ Dynamic Type จนระดับ accessibility; ห้าม truncate action ที่จำเป็น; icon ทุกตัวมี label; status ไม่ใช้สีอย่างเดียว; Reduce Motion ลด animation

TH/EN ใช้ string catalog ไม่ต่อประโยคด้วย string fragments; เวลา/วันที่/ราคา format ตาม locale. ชื่อช่องและ EPG เป็นข้อมูลจาก source ไม่อ้างว่า app แปลเนื้อหาให้ กำหนด fallback English เฉพาะ UI keys ที่ขาดและให้ CI ตรวจ missing translation

Theme เป็น System/Light/Dark; CarPlay appearance ตาม platform templates. ไม่สัญญา custom Amber HUD หรือ pixel-perfect 16:9 เพราะรถมีขนาดและ input ต่างกัน

## Copy examples

- Empty: “เพิ่มเพลย์ลิสต์ของคุณเพื่อเริ่มรับชม”
- Unsupported: “แอปรุ่นนี้ยังไม่รองรับรูปแบบสตรีมนี้ ลองแหล่ง HLS หรือแก้ที่มาของช่อง”
- Auth: “แหล่งสตรีมต้องการสิทธิ์เข้าถึงใหม่”
- EPG: “ยังไม่มีผังรายการสำหรับช่องนี้”
- Car video unavailable: “รถหรือระบบนี้ยังไม่รองรับวิดีโอ ใช้งานเสียงต่อได้เมื่อเนื้อหารองรับ”

## UX acceptance

QA walkthrough ต้องครอบคลุมทุก route ด้วย loading/empty/error/success, long Thai titles, no artwork, 50k library, reduced motion, VoiceOver, text scaling, iPad rotation และ CarPlay rotary focus. ห้ามยืนยันหน้าจอจาก screenshot happy path เพียงภาพเดียว

## Flutter, Android Auto and website UX additions

Mobile เพิ่ม Login/Register/Verify/Recover, account/device sessions, sync status และ diagnostic consent;ใช้ system browser auth แล้วกลับ app. Guest→Login มี merge preview; Logout แยก account namespace และถาม keep/purge local account metadata. Android ใช้ TalkBack/back navigation/notification state; settings persist ทั้งสอง OS

Radio tab เป็น internet catalog + user sources, genres/languages/favorites, optional ICY now-playing, cellular/data saver control. ไม่มีปุ่ม FM tuning หรือ offline listening. Android Auto host แสดง Favorites/Recent/Radio จาก native media library ตาม [18](18-Android-Auto-and-Internet-Radio.md)

เว็บ screens/states และ user/admin routes ระบุครบใน [17](17-Backend-Web-Console.md). เปลี่ยน setting บนเว็บต้องเห็น saved revision และ device last-applied revision; offline device แสดง pending ไม่กล่าวว่า apply แล้ว
