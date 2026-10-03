# Module Contracts and Error Catalog

สัญญาเชิงออกแบบ ไม่ใช่ code ที่ compile แล้ว; revision 0.2 มี Flutter/native bridge และ Backend REST API ตาม [17](17-Backend-Web-Console.md)

## Internal interfaces

| Interface | Input → output | Invariants |
|---|---|---|
| ImportService.prepare | ImportRequest → progress stream + ImportPreview | cancellable; ไม่เขียน live library; requestId unique |
| ImportService.commit | previewId + selectedValidRows → ImportResult | reject expired preview/source revision mismatch; atomic/idempotent |
| LibraryRepository.query | query + filters + cursor + limit → page | deterministic sort(name,id); max page 100 |
| SourceService.refresh | sourceId + expectedRevision → RefreshResult | 304 = unchanged; previous snapshot survives failure |
| PlaybackCoordinator.send | PlaybackCommand + sessionGeneration → state events | latest user intent wins; serial ordering |
| EPGService.lookup | channelId + instantUTC → now/next + freshness | [start,end); no locale parsing in storage layer |
| DiagnosticService.check | source/channel ID → redacted DiagnosticResult | timeout/cancel; no credentials in result |
| EntitlementProvider | refresh/purchase/restore → entitlement stream | only verified Apple/Google purchase grants entitlement |
| SyncAdapter (R1 + P1 extension) | durable ChangeEnvelope → ack/conflict | idempotency changeId; never silently drop |

`ImportRequest` = kind(file/playlistURL/directStream), user-selected location, optional sourceId, mode(new/refresh). Direct stream ไม่ผ่าน playlist parser. `ImportPreview` = counts, row warnings, proposed changes, baseRevision, expiry(10 minutes). `ImportResult` = committedRevision, inserted/updated/unavailable counts. ข้อมูล URL ส่งภายในแบบ SensitiveValue ที่ debug description redact เสมอ

`PlaybackCommand` = play(channelId), pause, resume, stop, selectVariant, selectAudioTrack, selectSubtitle. `PlaybackState` ระบุ sessionId, channelId, state, reasonCode?, canRetry, mediaCapabilities. ไม่ส่ง raw underlying error description สู่ UI/telemetry

## Network contracts

- HTTPS default; GET import with connection/resource deadlines proposed 10s/60s; respect cancellation and decoded size cap. ETag/Last-Modified ใช้ conditional refresh
- Redirect cap 5; ตรวจ scheme/host/IP ทุก hop. Cross-origin ตัด Authorization/Cookie และ custom secret headers; re-auth กับ origin ใหม่ต้อง explicit
- HTTP source ไม่ fallback จาก HTTPS เงียบ ๆ. Reject by default; legacy compatibility spike ต้องตัดสิน platform transport policy ก่อนเปิด setting เฉพาะ source
- Local/private address source ต้อง user initiated + explicit local-network intent; ไม่ติดตาม URL ใน playlist ไป loopback/link-local/metadata address อัตโนมัติ
- ไม่ fetch EPG/logo URL จาก untrusted playlist ทันที; validate และเปิดเมื่อจำเป็น; จำกัด concurrent fetch (initial 4 metadata, 1 import)
- Backoff สำหรับ 429/503: honor Retry-After สูงสุด 60s ใน foreground job, เกินนั้นให้ deferred state. ไม่ busy loop, ไม่ retry auth/parse โดยอัตโนมัติ
- ไม่ประดิษฐ์ provider API สำหรับ YouTube/Netflix; network scope คือ source ที่รองรับและผู้ใช้เลือก

## Error catalog

| Code | Meaning / user action | Retry |
|---|---|---|
| IMP_INVALID_URL | รูปแบบที่อยู่ไม่ถูกต้อง → edit | Manual |
| IMP_UNSAFE_ENDPOINT | scheme/host ไม่อนุญาต → เลือก source ใหม่ | No |
| IMP_LIMIT_EXCEEDED | file/line/entry เกิน limit → ลดขนาด | No |
| IMP_ENCODING | encoding อ่านไม่ได้ → export UTF-8 | No |
| IMP_NO_VALID_ROWS | ไม่พบรายการ valid → ดูตัวอย่าง error | No |
| IMP_CONFLICT | source เปลี่ยนระหว่าง preview → prepare ใหม่ | Manual |
| NET_OFFLINE | ไม่มี network → รอ/เปิด network | Bounded |
| NET_TIMEOUT | source ไม่ตอบ → retry/diagnose | Bounded |
| SRC_AUTH_REQUIRED | 401/403 → แก้ credentials/URL | No auto |
| SRC_NOT_FOUND | 404/410 → edit/remove source | No auto |
| SRC_RATE_LIMITED | 429 → รอตามเวลาที่ระบุ | Deferred |
| MEDIA_UNSUPPORTED | format/codec/DRM ไม่รองรับ → source อื่น | No |
| MEDIA_STALLED | buffer ไม่เดิน → reconnect | Bounded |
| EPG_INVALID | XML/time invalid → keep cached guide | Next scheduled/manual |
| STORE_PENDING | purchase รอระบบ → pending UI | Transaction updates |
| STORE_UNVERIFIED | ตรวจสิทธิ์ไม่ผ่าน → restore/support | No grant |
| DB_NO_SPACE | storage เต็ม → clear cache/free space | Manual |
| SYNC_UNAVAILABLE | account/network/quota → local mode | Deferred |
| CAR_VIDEO_UNAVAILABLE | capability ไม่พร้อม → audio eligibility check | On system change |

## Diagnostics/event schema

Local event: eventName, schemaVersion=1, monotonic timestamp, sessionRandomId, durationMs?, resultCode?, networkClass(wifi/cellular/offline), appBuild, osMajor, deviceClass. ไม่ส่ง source URL, URL hash, channel name, playlist title, search query, location, IP หรือ customer transaction payload

Allowed names: import_completed, import_failed, playback_start_result, playback_stall, playback_recovered, app_error, purchase_result, carplay_session_result. Collection/export consent อยู่ใน privacy spec. Aggregate numerator/denominator แยก failure class; ไม่ตัด failed attempts ออกเพื่อทำ latency ดูดี

## Native bridge contract v1

Command envelope: `{schemaVersion,commandId,sessionId,generation,type,payload}`; result ack ระบุ accepted/rejected/reason ไม่หมายความว่าเสียงเริ่มแล้ว. Event `{schemaVersion,sequence,sessionId,generation,state,capabilities,errorCode?}`. Dart reconnect เรียก getSnapshot แล้ว subscribe(afterSequence); sequence gap ขอ snapshot ใหม่

Operations: getCapabilities, getPlaybackSnapshot, sendPlaybackCommand, publishBrowseSnapshot(revision,fileRef), readNativeEventJournal(afterSequence), acknowledgeJournal(sequence). Files restricted to app-owned snapshot path; no arbitrary file read. Media bytes/headers/secrets ไม่อยู่ event/log. Native errors map ไป stable catalog ไม่ปล่อย stack trace สู่ UI

Unsupported schema/command คืน BRIDGE_INCOMPATIBLE; detached Flutter ไม่ทำให้ native pending command หาย; duplicate commandId ได้ prior result; pending queue ≤100 entries และไม่ replay play command จาก previous session. API error extensions AUTH_REQUIRED, AUTH_FORBIDDEN, SYNC_CONFLICT, CONFIG_INCOMPATIBLE, API_RATE_LIMITED ตาม backend contract
