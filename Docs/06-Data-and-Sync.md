# Data Model, Persistence and Sync

## Logical schema v1

UUID คือ stable application identity; วันที่เก็บ UTC; ทุก table ที่ sync ได้มี revision, updatedAt, deletedAt. Schema นี้เป็น logical contract ก่อนสร้าง migration SQL

| Entity | Key / fields | Constraints |
|---|---|---|
| Source | id, displayName, kind(playlist/direct/demo), endpointSecretRef, sanitizedHost, etag, lastModified, lastSuccessAt, activeRevision | source endpoint ไม่เก็บ plaintext ใน logs/export; unique id |
| Channel | id, sourceId, providerId?, identityKey, name, normalizedName, groupId?, logoURL?, mediaKind, missingSince? | unique(sourceId, identityKey); FK source |
| StreamVariant | id, channelId, endpointSecretRef, transportHint, headerSecretRef?, priority | FK channel; URL/header credentials secret store |
| Group | id, sourceId, rawName, displayOrder | unique(sourceId, rawName) |
| Favorite | channelId, isFavorite, userOrder | one/channel; ไม่หายเพราะ playlist reordering |
| Recent | channelId, lastPlayedAt, mediaPosition? | cap 100; live ไม่เก็บ resume position ที่ไร้ความหมาย |
| EPGSource | id, endpointSecretRef, lastSuccessAt, contentHash | R1 one source per playlist |
| ChannelEPGMapping | channelId, epgSourceId, epgChannelId, mode(auto/manual) | manual mapping มาก่อน auto |
| Programme | id, epgSourceId, epgChannelId, startUTC, endUTC, title, summary? | end>start; index(channel,startUTC) |
| Preference | key, typedValue, revision | allowlist keys; no purchase rights or secrets |
| RightsRecord | catalogItemId, owner, evidenceRef, territory, expiresAt?, verifiedAt, status | required ก่อน bundle catalog item |
| ImportJob | id, sourceId?, generation, status, valid/invalid/duplicate counts | ephemeral/staging;ไม่ sync |
| EntitlementCache | productId, verifiedTransactionRef, state, checkedAt | cache เท่านั้น; ไม่ใช่ตัวอนุมัติเอง |

## Identity, duplicate และ refresh

ใช้ `tvg-id` เป็น provider hint ไม่ assume unique. ถ้า provider ID unique ใน source ใช้เป็น identityKey; ถ้าซ้ำ/ไม่มี ใช้ normalized full endpoint + group + normalized name ผ่าน keyed local digest. เก็บ URL original ไม่ sort query parameters หรือเปลี่ยน case ของ path เพราะ signed URL อาจเสีย

ชื่อช่องเหมือนกันไม่ใช่เหตุผล merge ข้าม source. ภายใน import เดียวกัน duplicate exact identity รวมเป็นรายการเดียวพร้อม warning; duplicate provider ID ต่าง endpoint เก็บเป็น separate channels และเตือน

เมื่อ URL token เปลี่ยน: provider ID ที่ unique ใช้คง channel identity; ถ้า fallback key เปลี่ยน ให้เสนอ remap จาก orphan favorites ไม่ auto merge จากชื่ออย่างเดียว. Old channel ที่หายจาก refresh ทำเครื่องหมาย unavailable และคง favorite/history จนผู้ใช้ล้าง

Staging → validate → diff → atomic transaction. Refresh ล้มเหลวเก็บ data และ lastSuccessAt เดิมพร้อม stale error. Source delete ต้องยืนยัน cascade จำนวน channels; ลบ credential reference หลัง transaction และ cleanup orphan secrets แบบ retryable

## Export/import backup

Versioned JSON metadata: schemaVersion, exportedAt, sources ที่ระบุชื่อ/host, channel identity labels, favorites/preferences. Default ไม่รวม URL/auth headers/EPG เนื้อหาเต็ม. การย้าย source URL ต้องผู้ใช้เลือก explicit sensitive export พร้อมเตือนว่ามี credentials; R1 ไม่รองรับ sensitive export เพื่อจำกัดความเสี่ยง ใช้ re-import source แทน

Restore metadata ใช้ preview + ID remap; ห้าม overwrite library ทั้งชุดโดยอัตโนมัติ; unknown future schema แจ้ง unsupported ไม่เดา. Privacy export สำหรับข้อมูลผู้ใช้ต้องฟรี

## Migrations and backup

Schema version เพิ่มแบบ monotonic. Test fresh install และ previous released version → current. ก่อน destructive migration ทำ local backup ใน protected app storage; disk ไม่พอให้หยุด ไม่ลบ DB แล้วสร้างใหม่เงียบ ๆ. Backup TTL 7 วันและลบเมื่อผู้ใช้ delete all. Cache rebuild ได้; favorites/credentials rebuild จาก network ไม่ได้

## Backend sync contract — R1 account settings, R1.1 imported library

Backend PostgreSQL + account-scoped API แทน CloudKit. R1 sync account preferences, public catalog station favorites/order และ device settings; native browse snapshots รับผลหลัง local commit. R1.1 เพิ่ม private library metadata แต่ไม่ส่ง credentials/stream URLs/programmes/history โดย default; อุปกรณ์ใหม่ต้อง re-enter private source URL. Web แก้ source label ได้เมื่อ phase นั้นพร้อม ไม่ได้ remote stream proxy

Cloud identity เป็น opaque entity UUID; local keyed URL digest ไม่ใช้เป็น cross-device matching key. Public catalog ใช้ stable stationId; imported source ต้อง explicit source identity mapping ไม่ merge จากชื่อช่อง. PostgreSQL schema และ endpoint contracts ใน [17](17-Backend-Web-Console.md)

Per-entity server revision CAS: request มี baseRevision/changeId. current revision ตรงจึง apply; stale update ส่ง conflict/current value ให้ client rebase independent fields หรือ user choose same-field conflict. ไม่มี wall-clock last-write-wins. Concurrent delete ชนะ stale updates; restore เป็น explicit mutation ที่อ้าง current tombstone revision

Durable local outbox namespaced by account/device; unique changeId replay ได้ผลเดิม. Server changes/cursor durable; save cursor หลัง local transaction สำเร็จ. Tombstone/change retention 90 วัน; expired cursor 410 ต้อง full reconciliation ก่อนส่ง queued writes; stale create ใช้ ID เดิมที่ลบแล้วไม่ได้

Logout/account switch cancel in-flight requests, invalidate generation, แยก DB namespace/snapshot; ไม่ publish account เดิมให้รถหลังสลับบัญชี. Guest merge ใช้ preview และ explicit selected records เท่านั้น

Delete cloud metadata ต้อง acknowledgement; offline local delete แสดง pending และห้ามอ้าง remote deleted. Account deletion/revoke/backup purge ตาม [17](17-Backend-Web-Console.md). Web/device settings conflict ไม่อัปเดต active playback เอง

## Data acceptance

Import replay idempotent, interrupted import ไม่เสีย snapshot, reorder คง favorite, duplicate IDs ไม่รวมผิดช่อง, timezone offset ถูก, migration lossless, sync replay/delete/offline concurrent edit/account switch ผ่าน tests ก่อนเปิด FR-12

## Native snapshot and storage update

Flutter repository เป็น single writer; native service อ่าน atomic browse snapshot version + secure endpoint references. Secret store ใช้ encrypted blobs สำหรับ URLs จำนวนมากและ Keychain/Keystore สำหรับ encryption keys. Snapshot schema/version migration ต้อง test cold process และ account switch; write temp→fsync/atomic replace แล้ว publish revision. Purchase cache รองรับ Apple/Google แต่ entitlement source คือ verified store state
