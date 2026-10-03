# Security, Privacy and Content Readiness

นี่คือ engineering/product checklist และ draft data policy ยังไม่ใช่นโยบายเผยแพร่ฉบับลงนาม เจ้าของธุรกิจต้องยืนยันนิติบุคคล ช่องทางติดต่อ ประเทศที่ให้บริการ และการปฏิบัติจริงก่อน release

## Trust boundaries and threats

| Boundary / threat | Control | Verification |
|---|---|---|
| Untrusted playlist/XML | bounds, no external entities, non-executable metadata | malformed/oversize/entity fixtures |
| Embedded URLs → network | scheme/redirect/private-address validation; local intent explicit | redirect and endpoint tests |
| URL credentials / headers | Keychain/Keystore-backed encrypted secret references; redact debug/log/export | canary token scan |
| Cached source/EPG/logo | protected app storage, size/TTL caps | backup/cache/delete tests |
| Artwork attack | type validation, bounded decode, no raw remote SVG execution | malformed and oversized assets |
| Imported UI text | plain text rendering, control-char cleanup, length limits | HTML/script/Unicode fixtures |
| Purchase spoofing | verified Apple/Google purchases, server webhook dedup/reconciliation | sandbox/unverified cases |
| Sync cross-account mixing | private namespace and explicit account switch | two-account isolation test |
| Dependency/supply chain | pinned versions/licenses, minimal SDKs, reviewed updates | SBOM/license record |

Backend มี account/catalog/operations แต่ไม่ส่ง user's private source ไป server เพื่อ “ตรวจ URL”; ไม่มี private media proxy. อย่างไรก็ดี on-device fetch ยังเข้าถึง network ภายในได้ จึงต้องควบคุม untrusted embedded requests

## Data inventory and retention (proposed defaults)

| Data | Storage / recipient | Retention / deletion |
|---|---|---|
| Source URL/auth | local encrypted secret store with Keychain/Keystore key; source host receives request | source delete/all-data delete; explicitly remove secret items |
| Library/favorites/settings | local DB; R1 account settings/catalog favorites sync; R1.1 imported metadata | until user deletion |
| Recent history | local only | last 100 entries, clear anytime |
| EPG/artwork | local caches; source provider sees fetch | programme window/size cap; clear cache |
| Diagnostics | local ring buffer + opt-in redacted upload | 7 days or 5MiB, whichever first; shared copy controlled by recipient |
| Purchase state | Apple/Google + backend verification ledger + local verified cache | transaction record managed by store; backend minimal ledger retention per policy; local reset doesn't refund purchase |
| Location/contacts/mic/IDFA | not collected in R1 | no permission prompt |
| Support messages | designated support channel after launch | proposed 90 days; owner confirms actual retention |

“ไม่เก็บ GPS” ไม่ได้แปลว่า “ไม่มีข้อมูลออกจากเครื่อง”: stream hosts ได้รับ IP/request; purchases ติดต่อ Apple/Google และ verification Backend; Login ติดต่อ IdP, settings/device/diagnostics ติดต่อ API. Inventory สำหรับ account/server logs อยู่ [17](17-Backend-Web-Console.md). หากเพิ่ม SDK/recipient อื่นต้องปรับ inventory ก่อน merge

## Consent and permission UX

ไม่มี permission wall ตอนเริ่ม. File access ผ่าน system picker; clipboard อ่านเฉพาะ user Paste. Diagnostics sharing เปิด preview และขอ consent ต่อ export; ส่งเฉพาะข้อมูลจำเป็น. Local network prompt เพิ่มต่อเมื่อ feature ที่ใช้จริงและมี purpose string; R1 ไม่มี DLNA discovery

## Draft public privacy content

ข้อความที่ publish ต้องตอบ: ใครเป็นผู้ให้บริการ, เราเก็บอะไร, เหตุผล, ที่เก็บ/ผู้รับ, อายุข้อมูล, วิธี export/delete/contact, การเปลี่ยนนโยบาย. ใส่ชื่อจริงและ contact URL ก่อน release. ห้ามเผยแพร่ placeholder หรืออ้าง “data not collected” โดยไม่ตรวจ network ของ build จริง

Delete local data ต้องลบ DB/cache/temporary export/logs/Keychain/Keystore secret references และ reset preferences; แสดงว่าซื้อผ่าน store ยัง restore ได้ตามสถานะการซื้อ. Sync delete อยู่ใน [data spec](06-Data-and-Sync.md) และต้องแยก local กับ cloud result

## Content rights workflow

Public URL ไม่ได้เป็นหลักฐานว่าเราแจกจ่าย/รวมใน commercial catalog ได้. ก่อน bundle สถานี/โลโก้/EPG/demo ต้องมี RightsRecord: เจ้าของ, URL หลักฐาน/หนังสืออนุญาต, permitted use, territory, expiry, attribution, reviewer, checked date

State: proposed → evidence collected → approved → active → expired/suspended. Catalog release process ตัดรายการ expired; owner รับ complaint และระงับรายการที่เราแจกจ่ายก่อนตรวจ ไม่ลบ user library โดยพลการ

R1 default: user-supplied playlists + owned/cleared demo เท่านั้น หากสถานีวิทยุ 20+ รายการยังไม่มีหลักฐาน ให้ส่งโดยไม่มี bundled radio catalog และปรับ onboarding. ไม่มีตัวเลข 40,000 stations ใน marketing จนตรวจข้อมูลและสิทธิ์ได้จริง

## Store review alignment

เปิดเผย features และใช้ public APIs; App Review Guidelines เป็น release input [S05](16-Sources.md). Store screenshots/description/purchase claims ต้องตรงกับ build. การตรวจเอกสารนี้ไม่แทนการตรวจสิทธิ์ของแต่ละ provider หรือข้อกำหนดในประเทศที่จะให้บริการ

## Release evidence

Network capture ไม่มี unexpected recipient, exported diagnostics ผ่าน canary secrets, all-data deletion verified, rights ledger ครบสำหรับ bundled assets, privacy/support URLs ใช้งานจริง, SDK privacy declarations ตรวจตาม toolchain ปัจจุบัน, reviewer steps ใช้ได้. เก็บผลใน release packet ไม่ใส่เพียง checkbox ว่า “PDPA compliant”

## Backend/account threat model extension

เพิ่ม identity profile/email ที่ IdP และ minimal account reference ใน API, device IDs/OS/build/lastSeen, account settings และ public catalog favorites. Email ใช้เพื่อ account operation เท่านั้น; application logs ไม่บันทึก email. Private library/stream URLs ไม่เปิดให้ support โดยปริยาย

Controls เพิ่ม: OIDC PKCE/BFF/CSRF, staff MFA, API object ownership+RBAC, signed/verified purchase webhook, append-only audit, log query isolation, catalog-checker SSRF/egress controls, encrypted DB/backups และ deletion ledger. Retention/roles/limits ที่เป็น source of truth อยู่ [17](17-Backend-Web-Console.md)

Client diagnostic upload opt-in และผู้ใช้ถอน consent/ลบ report ได้. Essential server security/audit processing ต้องอธิบายใน public policy แยกจาก optional telemetry; ห้ามถือว่า login เท่ากับยินยอมส่ง listening history. Location/contacts/mic ยังไม่เก็บ; Android Auto host voice ไม่ทำให้ app ต้องบันทึก microphone เอง

Gate ใหม่: test IDOR ทั้ง GET/PATCH/export/logs/jobs, token replay/session revoke, MFA escalation, account deletionรวม IdP/DB/object/log scopes, stale account snapshot บนรถ และ restore backup พร้อม deletion replay
