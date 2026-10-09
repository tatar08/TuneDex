# TuneDeck API: test cases สำหรับทดสอบด้วยมือบน localhost

เวอร์ชันเอกสาร: 2026-10-05 · เขียนจากการอ่านโค้ด `services/api/src/**`, test อัตโนมัติ `services/api/test/*.ts` และสัญญา `services/api/openapi.proposal.yaml` (61 paths, 69 operations)
ผู้ใช้เอกสาร: AI tester (Gemini, Qwen) ที่ยิง request ด้วยมือบนเครื่องของ Tar

ถ้าโค้ดกับ OpenAPI ไม่ตรงกัน เอกสารนี้เขียนตาม **โค้ด** เสมอ และสรุปจุดที่ไม่ตรงไว้ในหัวข้อสุดท้าย "Contract mismatches found"


> **อัปเดต 2026-10-09:** ตอนนี้ staging เป็น HTTPS แล้ว ให้แทน URL ในเอกสารนี้ดังนี้
> `http://localhost:3101` → `https://api.192-168-1-37.sslip.io` · `http://localhost:3201` → `https://console.192-168-1-37.sslip.io` · `http://keycloak.localhost:8080` → Keycloak ของ staging (ดูใน `infra/compose`)
> เครื่องที่ทดสอบต้องติดตั้ง root CA จาก `https://console.192-168-1-37.sslip.io/staging-ca.crt` ก่อน ส่วนที่เพิ่มหลัง PR #22 อยู่ในไฟล์ 02 และ 03

---

## 0. ก่อนเริ่ม

### 0.1 จุดประสงค์

- ตรวจว่า API ทุก route ทำงานตามโค้ดจริง: happy path, validation ทุกข้อ, 401/403/404/409/412/428/429, idempotency, pagination, ETag/If-Match และผลข้างเคียง (audit, ข้อมูลที่อ่านกลับได้)
- ตรวจด้านความปลอดภัยข้ามทุก route: สิทธิ์ตาม role, IDOR, injection, CORS, cache header, error ไม่รั่ว stack/SQL, log ไม่มี token หรือข้อความค้นหา
- ผลการทดสอบใช้ตัดสินว่า backend พร้อมส่งต่อหรือยัง จึงต้องรายงานตามรูปแบบใน 0.5 ให้ครบทุก case

### 0.2 สภาพแวดล้อม (เครื่องของ Tar, localhost เท่านั้น)

| อะไร | ค่า |
|---|---|
| API | `http://localhost:3101` |
| Console (Next.js + BFF) | `http://localhost:3201` |
| Keycloak | `http://keycloak.localhost:8080`, realm `tunedeck`, issuer `http://keycloak.localhost:8080/realms/tunedeck` |
| บัญชีทดสอบ | `tar-test` = staff role `admin` และตั้ง TOTP แล้ว · `tar-noaccess` = ลูกค้า ไม่มี staff role |
| รหัสผ่าน | อยู่ใน `infra/compose/.env.test-account` บนเครื่อง Tar เท่านั้น ห้ามคัดลอกลงเอกสารหรือรายงาน |

ค่าที่ compose ตั้งไว้ (ดู `infra/compose/compose.yaml`) และผลต่อการทดสอบ:

| ค่า | ผลที่ต้องรู้ |
|---|---|
| `APP_ENV=dev` | `GET /v1/config` ส่ง `Cache-Control: no-cache` (ไม่ใช่ `public, max-age=300`) และถ้าไม่ได้ตั้ง `CONFIG_SIGNING_KEY` จะใช้กุญแจชั่วคราวต่อการ start หนึ่งครั้ง (`kid` และ ETag เปลี่ยนเมื่อ API restart) |
| `STAFF_MFA_ACR=mfa` | ทุก `/v1/admin/**` ต้องมี Keycloak session ที่เคยผ่าน MFA ภายใน 12 ชม. และงาน publish/stage/rollback/export ต้องมี token ที่ `acr=mfa` และ `auth_time` ไม่เกิน 300 วินาที |
| `KEYCLOAK_ADMIN_CLIENT_ID=tunedeck-api-admin` | ลบบัญชีแล้ว **ผู้ใช้ใน Keycloak ถูกลบจริง** · sign out อุปกรณ์แล้ว **Keycloak session ของอุปกรณ์นั้นถูกปิดจริง** · คิว `idp_session_end` แสดงใน `/v1/admin/jobs` |
| `RADIO_BROWSER_BASE_URL` | ตั้งไว้ (ตามที่ Tar แจ้ง) จึงค้นหา directory ได้จริงผ่าน API |
| Billing (Apple/Google) | ไม่ได้ตั้ง: `POST /v1/billing/verify` ที่ผ่าน validation จะได้ 503 และ webhook ทุกตัวได้ 401 → case ที่ต้องมี store จริงให้ใส่ **BLOCKED (needs store sandbox)** |
| `STATION_CHECK_ENABLED` | ไม่ได้ตั้ง (ปิด): ไม่มีการตรวจ stream ตามรอบ แต่ "check now" ยังทำงาน โดย API ยิงไปที่ stream เอง (`STATION_CHECK_RUNNER` ค่าเริ่มต้น `api`) |
| `CORS_ALLOWED_ORIGINS` | ไม่ได้ตั้ง: API ไม่ส่ง CORS header เลย |
| Rate limit | ค่าเริ่มต้น: อ่าน 120 / เขียน 30 ครั้งต่อนาทีต่อบัญชี · 60 ครั้งต่อนาทีต่อ IP สำหรับ `/v1/catalog/*`, `/v1/directory/*`, `/v1/account-deletions/*`, `/v1/export-downloads/*` (แยก bucket ต่อกลุ่ม) และ 600 ครั้งต่อนาทีต่อ IP สำหรับ `/v1/webhooks/*` · health และ `/v1/config` ไม่จำกัด · `TRUST_PROXY_HOPS=0` (ไม่เชื่อ `X-Forwarded-For`) |
| Email, แอปมือถือ | ไม่มี: case ที่ต้องใช้ให้ทำเครื่องหมาย BLOCKED |
| `SHUTDOWN_DRAIN_MS` | ค่าเริ่มต้น 5000 (รับ 0..60000) เมื่อ API ได้ SIGTERM/SIGINT `GET /health/ready` ตอบ 503 ตลอดช่วงนี้ แล้วจึงปิด server; request ที่ค้างอยู่ทำต่อจนจบ; สัญญาณครั้งที่สองออกทันที (exit 1) |
| `DB_POOL_MAX` | ขนาด connection pool ค่าเริ่มต้น 20 (รับ 2..200 ค่าอื่นใช้ 20) · ทุก query มี `statement_timeout` 5000 ms เกินแล้วตอบ 503 `DEPENDENCY_UNAVAILABLE` และ log `WARN` `DB_QUERY_TIMEOUT` |

ตรวจค่าจริงก่อนเริ่ม (คำสั่งนี้ไม่พิมพ์ความลับ): `docker compose -f infra/compose/compose.yaml exec api printenv APP_ENV STAFF_MFA_ACR RADIO_BROWSER_BASE_URL CORS_ALLOWED_ORIGINS STATION_CHECK_ENABLED STATION_CHECK_RUNNER SHUTDOWN_DRAIN_MS DB_POOL_MAX RATE_LIMIT_READS_PER_MIN RATE_LIMIT_WRITES_PER_MIN RATE_LIMIT_CATALOG_PER_MIN` ถ้าค่าต่างจากตารางให้บันทึกไว้ต้นรายงาน ห้ามใช้ `printenv` แบบไม่ระบุชื่อ เพราะจะพิมพ์ `DATABASE_URL` และ secret ออกมา

### 0.3 วิธีได้ access token สำหรับเรียก API ตรง

ข้อเท็จจริงจาก realm (`infra/compose/keycloak/tunedeck-realm.json`):
- มี client สำหรับคนเพียงตัวเดียวคือ `tunedeck-console`: confidential, authorization code + PKCE S256, **ไม่เปิด direct access grant (password grant)**, redirect URI `http://localhost:3201/auth/callback`, มี audience mapper ใส่ `tunedeck-api` ใน access token
- `tunedeck-api-admin` เป็น service account ของ API เอง ห้ามใช้
- `accessTokenLifespan` = 300 วินาที, refresh token ใช้ได้ครั้งเดียว (`revokeRefreshToken: true`) ต้องเก็บตัวใหม่ทุกครั้งที่ refresh
- Browser flow `browser with mfa step-up`: ระดับ 1 (`password`) ถามรหัสผ่าน, ระดับ 2 (`mfa`) ถาม TOTP เพิ่ม ขอระดับ 2 ด้วย `acr_values=mfa`

**ทางที่ใช้ (A): authorization code + PKCE ด้วย client `tunedeck-console` แล้วแลก code เองด้วย curl**

ต้องใช้ `CONSOLE_CLIENT_SECRET` จาก `infra/compose/.env` บนเครื่อง Tar (เป็นความลับ อ่านเข้าตัวแปรด้วย `read -rs` ห้ามพิมพ์ออกจอหรือใส่รายงาน)

```sh
export API=http://localhost:3101 CONSOLE=http://localhost:3201 KC=http://keycloak.localhost:8080/realms/tunedeck
REDIRECT=http://localhost:3201/auth/callback

# 1) PKCE + state (ทำใหม่ทุกครั้งที่ login)
VERIFIER=$(openssl rand -base64 48 | tr -d '=+/\n' | cut -c1-64)
CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
STATE=$(openssl rand -hex 16)

# 2) URL สำหรับเปิดใน "หน้าต่างส่วนตัว (private window) ใหม่"
#    MFA: เติม &acr_values=mfa   · บังคับ login ใหม่ (auth_time สด): เติม &prompt=login&max_age=0
echo "$KC/protocol/openid-connect/auth?client_id=tunedeck-console&response_type=code&scope=openid&redirect_uri=$(printf %s "$REDIRECT" | sed 's/:/%3A/g;s#/#%2F#g')&code_challenge=$CHALLENGE&code_challenge_method=S256&state=$STATE&acr_values=mfa&prompt=login&max_age=0"
```

3) เปิด URL, sign in (ใส่ TOTP เมื่อขอ) แล้ว browser จะไปที่ `http://localhost:3201/auth/callback?state=...&code=...` หน้า console จะขึ้นข้อผิดพลาดเพราะไม่มี cookie ของการ login นั้น ซึ่งเป็นเรื่องปกติ (console ตรวจ state ก่อนจึงไม่ใช้ code) ให้คัดลอกค่า `code` จาก address bar แล้วแลกภายใน 60 วินาที:

```sh
read -rs CONSOLE_SECRET   # วางค่า CONSOLE_CLIENT_SECRET จาก infra/compose/.env (ไม่แสดงบนจอ)
read -rs CODE             # วางค่า code จาก address bar
RESP=$(curl -s -u "tunedeck-console:$CONSOLE_SECRET" \
  -d grant_type=authorization_code -d "code=$CODE" -d "redirect_uri=$REDIRECT" -d "code_verifier=$VERIFIER" \
  "$KC/protocol/openid-connect/token")
TOKEN=$(printf '%s' "$RESP" | jq -r .access_token); REFRESH=$(printf '%s' "$RESP" | jq -r .refresh_token)
unset RESP CODE
# refresh เมื่อ access token ใกล้หมดอายุ (refresh token ใช้ได้ครั้งเดียว)
refresh() { local r; r=$(curl -s -u "tunedeck-console:$CONSOLE_SECRET" -d grant_type=refresh_token -d "refresh_token=$REFRESH" "$KC/protocol/openid-connect/token"); TOKEN=$(printf '%s' "$r" | jq -r .access_token); REFRESH=$(printf '%s' "$r" | jq -r .refresh_token); }
# ดู claim ที่ต้องใช้ โดยไม่พิมพ์ token (ไม่แสดง sid)
claims() { printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(Buffer.from(s.split(".")[1],"base64url"));console.log({sub:c.sub,acr:c.acr,auth_time:c.auth_time,aud:c.aud,exp:c.exp,email:c.email?"(present)":"(none)"})})'; }
claims "$TOKEN"   # ต้องเห็น aud มี tunedeck-api และ acr = mfa เมื่อขอ acr_values=mfa
```

ถ้า `auth_time` ไม่มีใน token: ทุก route ที่ต้อง "sign-in ภายใน 5 นาที" จะตอบ 401 `REAUTH_REQUIRED` เสมอ ให้บันทึกเป็นข้อสังเกตต้นรายงาน

**ทาง (B): password grant** ใช้ไม่ได้ใน realm นี้ตามค่าเริ่มต้น เพราะไม่มี client ที่เปิด direct access grant สคริปต์ `infra/load/seed-users.mjs` สร้าง client `tunedeck-loadtest` (password grant + audience `tunedeck-api`) แต่สร้างบัญชี load test ด้วยและเป็นเครื่องมือ load test **ห้ามรันเอง** ถ้า Tar สร้าง client นี้ไว้แล้ว ใช้ได้เฉพาะ case ลูกค้า (`curl -d grant_type=password -d client_id=tunedeck-loadtest -d username=… -d password=… -d scope=openid $KC/protocol/openid-connect/token`) token แบบนี้ไม่มี `acr=mfa` ดังนั้น `/v1/admin/**` จะได้ 401 `MFA_REQUIRED` และบัญชีที่ตั้ง TOTP (`tar-test`) อาจถูกขอ OTP ใน direct grant

**ทาง (C): ผ่าน console (BFF)** console เก็บ token ไว้ฝั่ง server และไม่ส่ง token ให้ browser จึงใช้ทางนี้ยิง API ตรงไม่ได้ ใช้ได้เพื่อเทียบผลบางกรณีผ่าน `/bff/**` (ต้องมี cookie session + header `X-CSRF-Token` ของ session + `Origin: http://localhost:3201`) ไม่ครอบคลุมทุก route ของ API ใช้ในหัวข้อ 26A เพื่อทดสอบพฤติกรรมของ BFF เอง

**token ที่ต้องเตรียม** (ตั้งชื่อตัวแปรตามนี้ ทุกตัวได้จากทาง A):

| ตัวแปร | บัญชี | วิธีได้ | ใช้กับ |
|---|---|---|---|
| `TOKEN` | tar-test | `acr_values=mfa&prompt=login&max_age=0` ขอใหม่ก่อนทำ case ที่ต้อง "ภายใน 5 นาที" | admin ทุก route, publish/stage/rollback/export |
| `TOKEN_OLD` | tar-test | `TOKEN` ที่เก็บ refresh token ไว้ รอเกิน 5 นาที แล้ว `refresh` (auth_time เดิม) | case 401 `REAUTH_REQUIRED` / `MFA_REQUIRED` (300 s) |
| `TOKEN_PW` | tar-test | private window ใหม่ที่ยังไม่เคยผ่าน MFA, **ไม่ใส่** `acr_values` | case 401 `MFA_REQUIRED` scope `session` |
| `TOKEN_NA` | tar-noaccess | ไม่ต้อง MFA, ใส่ `prompt=login&max_age=0` เมื่อต้องการ auth_time สด | ลูกค้า, wrong-role 403 |
| `TOKEN_PHONE` | tar-test หรือ tar-noaccess | login แยกอีก session หนึ่ง (private window อีกอัน) ใช้แทน "โทรศัพท์" | ลงทะเบียนอุปกรณ์ที่จะถูก sign out |
| `TOKEN_T1`, `TOKEN_T2` | บัญชีทิ้งได้ (throwaway) | สมัครเองที่หน้า sign-up ของ Keycloak (ดูด้านล่าง) | case ที่ทำลายข้อมูล: ลบบัญชี, device limit, ลูกค้าคนที่สองสำหรับ IDOR |

**บัญชี throwaway**: realm เปิดให้สมัครเอง (`registrationAllowed`, ใช้อีเมลเป็น username, รหัสผ่านอย่างน้อย 12 ตัว) เปิด URL ในข้อ 2 แต่เปลี่ยน path `/auth` เป็น `/registrations` แล้วสมัครด้วยอีเมลรูปแบบ `qa-<tester>-<yyyymmdd>-<n>@example.test` เก็บรหัสผ่านไว้ในเครื่องเท่านั้น ถ้า Tar ไม่อนุญาตให้สมัคร ให้ทำเครื่องหมาย BLOCKED กับ case ที่ระบุว่าต้องใช้ throwaway

case ที่ทดสอบ role (operator, auditor, support, catalog_editor) ให้ role กับ T1 ผ่าน staff CLI (หัวข้อ 26) ซึ่งจะ**ปฏิเสธ (exit 3) ถ้าบัญชียังไม่ได้ตั้ง TOTP** ดังนั้น T1 ต้องตั้ง TOTP เองก่อน (Keycloak 26 ยังให้ตั้ง TOTP ระหว่างขั้น MFA ได้ แต่ API จะไม่ยอมรับรหัสที่ไม่ได้ pin ดูหัวข้อ 26 เคส 012 ถึง 020)ที่ `$KC/account` → Signing in → Authenticator application แล้วจึงขอ token แบบ `acr_values=mfa` ได้ เก็บ TOTP secret ไว้ในเครื่องเท่านั้น

**คำเตือนเรื่องอุปกรณ์**: `PUT /v1/me/devices/{id}` จำ Keycloak session id (`sid`) ของ token ที่ใช้ลงทะเบียน เมื่อ sign out อุปกรณ์นั้น API จะปฏิเสธ **ทุก token ของ session นั้น** (403 `DEVICE_REVOKED`) และปิด session ที่ Keycloak ด้วย ดังนั้นให้ลงทะเบียนอุปกรณ์ที่จะถูก sign out ด้วย `TOKEN_PHONE` เสมอ ไม่ใช่ `TOKEN` หลัก

### 0.4 ตัวแปรและ helper ที่ใช้ในทุกตาราง

```sh
CT='Content-Type: application/json'
uuid() { uuidgen | tr 'A-F' 'a-f'; }
ik()   { printf 'Idempotency-Key: qa-%s' "$(uuid)"; }      # ใช้เป็น -H "$(ik)"
c0()   { curl -sS -i "$@"; }                                 # ไม่มี token
ca()   { curl -sS -i -H "Authorization: Bearer $TOKEN" "$@"; }       # tar-test admin + MFA สด
cold() { curl -sS -i -H "Authorization: Bearer $TOKEN_OLD" "$@"; }
cpw()  { curl -sS -i -H "Authorization: Bearer $TOKEN_PW" "$@"; }
cn()   { curl -sS -i -H "Authorization: Bearer $TOKEN_NA" "$@"; }    # tar-noaccess
cph()  { curl -sS -i -H "Authorization: Bearer $TOKEN_PHONE" "$@"; }
ct1()  { curl -sS -i -H "Authorization: Bearer $TOKEN_T1" "$@"; }
ct2()  { curl -sS -i -H "Authorization: Bearer $TOKEN_T2" "$@"; }
```

ใช้ `-i` (แสดงเฉพาะ response header) ห้ามใช้ `-v` เพราะจะพิมพ์ header `Authorization` ที่ส่งออกไป

ค่าที่ได้ระหว่างทดสอบ (เก็บในตัวแปร shell):

| ตัวแปร | ได้จาก |
|---|---|
| `UID_NA`, `UID_T1` | `userId` ของ `GET /v1/me` |
| `DEV_NA` | uuid ที่ `cn -X PUT $API/v1/me/devices/$DEV_NA` ลงทะเบียน (API-DEV-001) |
| `DEV_PH` | uuid ที่ลงทะเบียนด้วย `TOKEN_PHONE` (จะถูก sign out) |
| `STN` | `id` ของสถานีทดสอบที่สร้างใน API-STN-020 |
| `REC` | `id` ของ rights record ใน API-RGT-001 |
| `EXP` | `id` ของ export ใน API-EXP-010 |
| `RPT` | `reportId` ของ diagnostic batch ใน API-DIA-001 |

### 0.5 การรายงานผล

เขียนผลลง `handoff/test-results/<tester>-<YYYY-MM-DD>.md` (เช่น `handoff/test-results/gemini-2026-10-06.md`) หนึ่งแถวต่อหนึ่ง case:

```md
| Case | ผล | หลักฐาน | หมายเหตุ |
|---|---|---|---|
| `API-SET-002` | PASS | 200, ETag "4", requestId qa-set-002 | |
| `API-STN-031` | FAIL | ได้ 500 INTERNAL แทน 400, requestId req_… | ขั้นตอนทำซ้ำ: … |
| `API-BIL-020` | BLOCKED | needs store sandbox | |
```

- ผลมี 3 แบบเท่านั้น: **PASS**, **FAIL**, **BLOCKED** (บอกเหตุผล เช่น `needs store sandbox`, `needs throwaway account`, `needs second admin`, `ต้องหยุด service`)
- FAIL ต้องมี: request ที่ส่ง (ปิดบังค่าลับ), status และ `code` ที่ได้, สิ่งที่คาดหวัง, `requestId` (ส่ง `-H 'X-Request-Id: qa-<case-id>'` จะหาใน log ได้ง่าย)
- ต้นรายงานบอก: ชื่อ tester, วันที่, commit/เวอร์ชัน API (`docker compose exec api printenv BUILD_VERSION`), ค่า env ที่ต่างจาก 0.2

### 0.6 กฎความปลอดภัย (บังคับ)

1. ยิงเฉพาะ `localhost:3101`, `localhost:3201`, `keycloak.localhost:8080` เท่านั้น ห้ามเรียก Radio Browser หรือบริการภายนอกเอง (API เป็นคนเรียก)
2. ห้ามพิมพ์หรือแปะสิ่งต่อไปนี้ในรายงาน, ข้อความแชท หรือไฟล์ใด ๆ: access/refresh/ID token, cookie, `CONSOLE_CLIENT_SECRET`, รหัสผ่าน, TOTP secret/QR/รหัส 6 หลัก, deletion ticket, export download path, support code ให้เขียน `<redacted>` แทน
3. ห้ามลบหรือทำให้ `tar-test` และ `tar-noaccess` ใช้งานไม่ได้: `DELETE /v1/me` และ `DELETE /v1/me/account` ใช้กับบัญชี throwaway เท่านั้น ห้าม revoke role `admin` ของ tar-test และห้ามให้ role กับ tar-noaccess
4. ห้ามรัน load test (`infra/load/*`) และห้ามยิงเกินที่ case กำหนด (case rate limit ใช้ไม่เกินประมาณ 65 request ต่อครั้ง)
5. ห้ามหยุด container หรือฐานข้อมูล case ที่ต้องทำแบบนั้นถูกระบุว่า "ข้าม" ยกเว้น case ที่เขียนว่า "ต้องได้รับอนุญาตจาก Tar" (ส่ง SIGTERM ให้ API, ล็อกตารางชั่วคราวด้วย psql) ให้ทำเฉพาะเมื่อ Tar อนุญาตเป็นลายลักษณ์อักษรในรายงาน มิฉะนั้นบันทึก BLOCKED
6. ข้อมูลทดสอบขึ้นต้นด้วย `QA-<tester>-` สถานีลบไม่ได้ (ไม่มี DELETE) จึงสร้างให้น้อยที่สุดและ disable เมื่อจบ ส่วน remote config ให้คืนค่าตาม API-ACF-090

### 0.7 รูปแบบ error ที่ใช้ทุก route

ทุก error เป็น JSON `{ "code", "messageKey", "requestId", "details" }` พร้อม `Cache-Control: no-store` และ header `X-Request-Id` ตรงกับ `requestId` ถ้า `details.retryAfterSeconds` มีค่า จะมี header `Retry-After` ด้วย ไม่มี stack trace, SQL หรือชื่อ class ในตัว body

ลำดับการตรวจของทุก request (สำคัญเวลาอ่านผลที่มีหลาย error พร้อมกัน):
1. Express middleware: request id/traceparent → JSON body parser (JSON เสีย = 400 `malformed_body`, เกินขนาด = 413) **ก่อน** ตรวจ token
2. Guard: `AuthGuard` (401/403) → `StaffGuard` (403 `ROLE_REQUIRED` ก่อน 401 `MFA_REQUIRED` scope session)
3. Interceptor: rate limit (429) → idempotency (428/400/409)
4. Handler: parse path/header/body ตามลำดับในโค้ด → recent sign-in/MFA → ฐานข้อมูล

ขนาด body สูงสุด: 16 KiB ทั่วไป, 128 KiB `/v1/diagnostics/batches`, 64 KiB `/v1/sync/push`, `/v1/billing/verify`, `/v1/webhooks/*`

---

## 1. Health (`/health/*`)

ไม่ต้องใช้ token, ไม่ติด rate limit, บรรทัด log ของ health ไม่ถูกเก็บใน `operational_logs`

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-HLT-001 | liveness | - | `c0 $API/health/live` | 200 `{"status":"ok"}` | ไม่มี header `X-Powered-By` |
| API-HLT-002 | readiness ปกติ | DB ทำงาน | `c0 $API/health/ready` | 200 `{"status":"ok"}` | - |
| API-HLT-003 | readiness เมื่อ DB ล่ม | ต้องหยุด DB | - | 503 `{"status":"unavailable"}` | **ข้าม** (ห้ามหยุด service) บันทึก BLOCKED |
| API-HLT-004 | health ไม่ต้องใช้ token แม้ส่ง token เสีย | - | `c0 -H 'Authorization: Bearer x' $API/health/live` | 200 | - |
| API-HLT-005 | X-Request-Id ที่ถูกรูปแบบถูกใช้ซ้ำ | - | `c0 -H 'X-Request-Id: qa-hlt-005' $API/health/live` | header `X-Request-Id: qa-hlt-005` | - |
| API-HLT-006 | X-Request-Id ผิดรูปแบบ (สั้นกว่า 8 / มีอักขระนอก `[A-Za-z0-9._-]`) ถูกแทนที่ | - | `c0 -H 'X-Request-Id: a b' $API/health/live` | header `X-Request-Id` ขึ้นต้น `req_` + uuid | ทำซ้ำด้วยค่า 65 ตัวอักษร ผลเหมือนกัน |
| API-HLT-007 | route ที่ไม่มี | - | `c0 $API/v1/does-not-exist` | 404 `code: NOT_FOUND`, `Cache-Control: no-store` | body ไม่มี path ของไฟล์หรือ stack |
| API-HLT-008 | readiness ตอบ 503 ระหว่าง drain | **ต้องได้รับอนุญาตจาก Tar** (API จะหยุดและต้อง start ใหม่) · `SHUTDOWN_DRAIN_MS` ค่าเริ่มต้น | terminal 1: `while :; do c0 -o /dev/null -w '%{http_code} ' $API/health/ready; sleep 0.5; done` · terminal 2: `docker compose -f infra/compose/compose.yaml kill -s SIGTERM api` | หลังส่งสัญญาณ `/health/ready` ตอบ 503 `{"status":"unavailable"}` ราว 5 วินาที (ประมาณ 10 ครั้ง) แล้วเชื่อมต่อไม่ได้ · ก่อนส่งเป็น 200 | container ออกด้วย exit 0 (`docker compose ps -a api`) · start ใหม่ด้วย `docker compose -f infra/compose/compose.yaml up -d api` (kid ของ config เปลี่ยน) |
| API-HLT-009 | liveness ยัง 200 ระหว่าง drain | เหมือน 008 | ยิง `/health/live` ในช่วง 5 วินาที | 200 `{"status":"ok"}` (มีเฉพาะ readiness ที่ fail) | - |
| API-HLT-010 | request ที่ค้างอยู่ทำจนจบ | เหมือน 008 | ส่ง `ca $API/v1/admin/overview?window=7d` แล้วส่ง SIGTERM ทันทีขณะยังรอคำตอบ | request นั้นได้ 200 ครบ ไม่ถูกตัด · request ใหม่ภายใน drain ก็ยังได้คำตอบปกติ | - |
| API-HLT-011 | สัญญาณครั้งที่สองออกทันที | เหมือน 008 | ส่ง SIGTERM แล้วส่ง SIGINT (หรือ SIGTERM) อีกครั้งภายใน 5 วินาที | API ออกทันทีไม่รอครบ drain, exit code 1 | start ใหม่ |
| API-HLT-012 | ปรับ `SHUTDOWN_DRAIN_MS` | ต้องแก้ env ของ compose | ตั้ง `0`, `60000`, `-1`/`abc`/`60001` | 0 = ปิดทันที, 60000 = 503 นาน 60 s, ค่านอกช่วงใช้ 5000 | **ข้าม** (ต้องแก้ config) |
| API-HLT-013 | `DB_POOL_MAX` นอกช่วงใช้ 20 | ต้องแก้ env | `1`, `201`, `abc` | API ทำงานปกติ (pool 20) | **ข้าม** (สังเกตไม่ได้จากภายนอก ต้องแก้ config) |

---

## 2. Auth guard และ token (ใช้ `GET /v1/me` เป็นตัวแทน)

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-AUTH-001 | ไม่มี header Authorization | - | `c0 $API/v1/me` | 401 `AUTH_REQUIRED` | `Cache-Control: no-store` |
| API-AUTH-002 | scheme ตัวเล็ก `bearer` | - | `c0 -H "Authorization: bearer $TOKEN" $API/v1/me` | 401 `AUTH_REQUIRED` (regex ตรวจ `Bearer` ตัวพิมพ์ใหญ่) | - |
| API-AUTH-003 | `Basic` scheme | - | `c0 -H 'Authorization: Basic dXNlcjpwYXNz' $API/v1/me` | 401 `AUTH_REQUIRED` | - |
| API-AUTH-004 | token มีช่องว่าง/อักขระนอก base64url | - | `c0 -H 'Authorization: Bearer abc def' $API/v1/me` | 401 `AUTH_REQUIRED` | - |
| API-AUTH-005 | token ไม่ใช่ JWT | - | `c0 -H 'Authorization: Bearer not.a.jwt' $API/v1/me` | 401 `AUTH_REQUIRED` | - |
| API-AUTH-006 | ลายเซ็นถูกแก้ | `TOKEN` | แก้ตัวอักษรสุดท้ายของ `$TOKEN` แล้วยิง `/v1/me` | 401 `AUTH_REQUIRED` | - |
| API-AUTH-007 | payload ถูกแก้ (เปลี่ยน sub) โดยลายเซ็นเดิม | `TOKEN` | สร้าง token ใหม่จาก header.payload-ที่แก้.signature | 401 `AUTH_REQUIRED` | - |
| API-AUTH-008 | `alg: none` | - | `c0 -H "Authorization: Bearer $(printf '{"alg":"none"}' \| base64 \| tr -d '=').$(printf '{"sub":"x","exp":9999999999}' \| base64 \| tr -d '=')." $API/v1/me` | 401 `AUTH_REQUIRED` (อนุญาตเฉพาะ RS256) | - |
| API-AUTH-009 | token หมดอายุ | `TOKEN` ที่เก่ากว่า 5 นาที 5 วินาที (exp + clock tolerance 5 s) | `ca $API/v1/me` | 401 `AUTH_REQUIRED` | - |
| API-AUTH-010 | ID token แทน access token (aud ไม่ใช่ `tunedeck-api`) | `id_token` จาก response ทาง A | `c0 -H "Authorization: Bearer $IDTOKEN" $API/v1/me` | 401 `AUTH_REQUIRED` | - |
| API-AUTH-011 | token จาก realm อื่น/issuer อื่น (เช่น realm `master`) | ถ้ามี | ยิง `/v1/me` | 401 `AUTH_REQUIRED` | ถ้าไม่มีให้ BLOCKED |
| API-AUTH-012 | ผู้ใช้ใหม่ถูกสร้างอัตโนมัติเมื่อเรียกครั้งแรก | `TOKEN_T1` ใหม่ | `ct1 $API/v1/me` | 200 `{userId, email, status:"active", createdAt}` | เรียกครั้งที่สอง `userId` เดิม |
| API-AUTH-013 | Keycloak (JWKS) ล่ม | ต้องหยุด Keycloak | - | 503 `DEPENDENCY_UNAVAILABLE` | **ข้าม** |
| API-AUTH-014 | บัญชีสถานะ `deleting` | `TOKEN_T1` ของบัญชีที่ทำ API-DEL-001 แล้ว (token เดิมยังไม่หมดอายุ) | `ct1 $API/v1/me` | 403 `ACCOUNT_DELETING` | - |
| API-AUTH-015 | token จาก session ที่ถูก sign out อุปกรณ์ | `DEV_PH` ถูก revoke แล้ว (API-DEV-040) | `cph $API/v1/me` | 403 `DEVICE_REVOKED` | `ca $API/v1/me` ของ session อื่นยังได้ 200 |
| API-AUTH-016 | malformed JSON ถูกตรวจก่อน token | - | `c0 -X PATCH -H "$CT" -d '{bad' $API/v1/me/settings` | 400 `VALIDATION_FAILED` `details.reason: malformed_body` (ไม่ใช่ 401) | - |
| API-AUTH-017 | body เกิน 16 KiB ถูกตรวจก่อน token | - | `c0 -X PATCH -H "$CT" --data-binary "{\"a\":\"$(head -c 17000 /dev/zero \| tr '\0' a)\"}" $API/v1/me/settings` | 413 `PAYLOAD_TOO_LARGE` | - |
| API-AUTH-018 | header ใหญ่เกิน 16 KB | - | `c0 -H "X-Big: $(head -c 20000 /dev/zero \| tr '\0' a)" $API/health/live` | 431 จาก Node (ไม่ใช่ JSON envelope) ไม่มี stack | บันทึกเป็นข้อสังเกต ไม่ใช่ FAIL |
| API-AUTH-019 | token ของ tar-noaccess ที่ไม่ได้ MFA ใช้ route ลูกค้าได้ | `TOKEN_NA` | `cn $API/v1/me` | 200 | - |

---

## 3. บัญชีของฉัน (`/v1/me`, `/v1/me/staff`, `/v1/me/export`)

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-ME-001 | ข้อมูลบัญชี | `TOKEN_NA` | `cn $API/v1/me` | 200 `{userId (uuid), email, status:"active", createdAt}`, `Cache-Control: no-store` | เก็บ `UID_NA=userId` |
| API-ME-002 | ไม่มี token | - | `c0 $API/v1/me` | 401 `AUTH_REQUIRED` | - |
| API-ME-003 | staff ของ admin | `TOKEN` | `ca $API/v1/me/staff` | 200 `{roles:["admin"], mfa:true, rolesVersion}` (`rolesVersion` ยาว 16 ตัว) | - |
| API-ME-004 | staff ของลูกค้า | `TOKEN_NA` | `cn $API/v1/me/staff` | 200 `{roles:[], mfa:false, rolesVersion}` | - |
| API-ME-005 | staff ของ admin ที่ session ยังไม่ผ่าน MFA | `TOKEN_PW` (session ใหม่, ไม่เคย MFA ใน 12 ชม.) | `cpw $API/v1/me/staff` | 200 `roles:["admin"], mfa:false` | - |
| API-ME-006 | export แบบเก่า (synchronous) | `TOKEN_NA` | `cn $API/v1/me/export` | 200 `format:"tunedeck-account-export"`, `version:1`, มี `account, settings, devices, favorites, purchases, diagnostics, diagnosticsTruncated, staffRoles`; `settings` เป็น `null` ถ้ายังไม่เคยบันทึก settings; `Content-Disposition: attachment`; `Cache-Control: no-store` | audit `account.export` ทุกครั้ง (ดูด้วย API-AUD-001 `action=account.export`) |
| API-ME-007 | export แบบเก่าไม่มี token | - | `c0 $API/v1/me/export` | 401 `AUTH_REQUIRED` | - |
| API-ME-008 | export ไม่มีข้อมูลของผู้ใช้อื่น | `TOKEN_NA` | ดู body ของ API-ME-006 | `devices`, `favorites`, `diagnostics` เป็นของ tar-noaccess เท่านั้น ไม่มี id จาก tar-test | - |

---

## 4. Settings (`GET/PATCH /v1/me/settings`)

ค่าที่อนุญาต: `theme` = `system`/`light`/`dark` · `language` = `th`/`en` · `cellularPolicy` = `allow`/`wifi_only` · ค่าเริ่มต้น `system`/`th`/`allow`, `revision` 0, `updatedAt` null
PATCH ตรวจ `If-Match` ก่อน body · ETag = `"<revision>"` · ใช้ `TOKEN_NA` ยกเว้นระบุ

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-SET-001 | อ่านค่าเริ่มต้น | บัญชีที่ไม่เคยบันทึก (`TOKEN_T1`) | `ct1 $API/v1/me/settings` | 200 `{theme:"system", language:"th", cellularPolicy:"allow", revision:0, updatedAt:null}`, `ETag: "0"`, `Cache-Control: no-store` | - |
| API-SET-002 | บันทึกครั้งแรก | revision 0 | `ct1 -X PATCH -H "$CT" -H 'If-Match: "0"' -d '{"theme":"dark"}' $API/v1/me/settings` | 200 `theme:"dark"`, `revision:1`, `ETag: "1"`, `updatedAt` มีค่า | GET ได้ revision 1 |
| API-SET-003 | บันทึกหลายช่อง | revision 1 | `ct1 -X PATCH -H "$CT" -H 'If-Match: "1"' -d '{"language":"en","cellularPolicy":"wifi_only"}' $API/v1/me/settings` | 200 revision 2 | - |
| API-SET-004 | ค่าเดิมก็เพิ่ม revision | revision 2 | PATCH `{"language":"en"}` If-Match `"2"` | 200 revision 3 | - |
| API-SET-005 | ไม่มี If-Match | - | `cn -X PATCH -H "$CT" -d '{"theme":"dark"}' $API/v1/me/settings` | 428 `PRECONDITION_REQUIRED` | - |
| API-SET-006 | If-Match ว่าง | - | `... -H 'If-Match;' ...` (curl ส่ง header ว่าง) | 428 `PRECONDITION_REQUIRED` | - |
| API-SET-007 | If-Match ไม่มี quote | - | `-H 'If-Match: 3'` | 400 `VALIDATION_FAILED` `{field:"If-Match", reason:"malformed"}` | - |
| API-SET-008 | If-Match weak | - | `-H 'If-Match: W/"3"'` | 400 `If-Match` `malformed` | - |
| API-SET-009 | If-Match `*` | - | `-H 'If-Match: *'` | 400 `If-Match` `malformed` | - |
| API-SET-010 | If-Match ตัวเลข 16 หลัก | - | `-H 'If-Match: "1234567890123456"'` | 400 `If-Match` `malformed` | - |
| API-SET-011 | If-Match ติดลบ | - | `-H 'If-Match: "-1"'` | 400 `If-Match` `malformed` | - |
| API-SET-012 | If-Match ตรวจก่อน body | - | ไม่มี If-Match + body `[]` | 428 (ไม่ใช่ 400) | - |
| API-SET-013 | revision เก่า | revision ปัจจุบัน N | PATCH `{"theme":"light"}` If-Match `"0"` บนบัญชีที่ N>0 | 412 `REVISION_MISMATCH` `details.currentRevision: N` | GET ค่าไม่เปลี่ยน |
| API-SET-014 | revision สูงกว่าเซิร์ฟเวอร์ | revision N | If-Match `"999"` | 412 `REVISION_MISMATCH` `currentRevision: N` | - |
| API-SET-015 | body เป็น array | - | `-d '[]'` If-Match ถูก | 400 `reason: body_must_be_object` | - |
| API-SET-016 | body เป็น string | - | `-d '"dark"'` | 400 `VALIDATION_FAILED` `reason: malformed_body` (JSON parser แบบ strict รับเฉพาะ object/array ที่ระดับบนสุด) | - |
| API-SET-017 | body เป็น null | - | `-d 'null'` | 400 `malformed_body` (strict parser) | - |
| API-SET-018 | body ว่าง `{}` | - | `-d '{}'` | 400 `reason: empty_patch` | - |
| API-SET-019 | field ไม่รู้จัก | - | `-d '{"theme":"dark","fontSize":3}'` | 400 `{field:"fontSize", reason:"unknown_field"}` | - |
| API-SET-020 | field ไม่รู้จักแบบ prototype | - | `-d '{"__proto__":{"x":1}}'` | 400 `unknown_field` (ไม่ใช่ 500) | - |
| API-SET-021 | theme ไม่อยู่ในรายการ | - | `-d '{"theme":"blue"}'` | 400 `{field:"theme", reason:"value_not_allowed", allowed:["system","light","dark"]}` | - |
| API-SET-022 | theme ตัวพิมพ์ใหญ่ | - | `-d '{"theme":"Dark"}'` | 400 `value_not_allowed` | - |
| API-SET-023 | theme null | - | `-d '{"theme":null}'` | 400 `value_not_allowed` | - |
| API-SET-024 | language นอกรายการ | - | `-d '{"language":"ja"}'` | 400 `{field:"language", reason:"value_not_allowed", allowed:["th","en"]}` | - |
| API-SET-025 | cellularPolicy นอกรายการ | - | `-d '{"cellularPolicy":"never"}'` | 400 `{field:"cellularPolicy", value_not_allowed, allowed:["allow","wifi_only"]}` | - |
| API-SET-026 | ค่าเป็นตัวเลข | - | `-d '{"theme":1}'` | 400 `value_not_allowed` | - |
| API-SET-027 | Content-Type ไม่ใช่ JSON | - | `cn -X PATCH -H 'Content-Type: text/plain' -H 'If-Match: "N"' -d '{"theme":"dark"}' ...` | 400 `VALIDATION_FAILED` (body ไม่ถูก parse จึงเป็น `{}` → `empty_patch`) ไม่ใช่ 200 | - |
| API-SET-028 | ไม่มี token | - | `c0 -X PATCH -H "$CT" -H 'If-Match: "0"' -d '{"theme":"dark"}' $API/v1/me/settings` | 401 `AUTH_REQUIRED` | - |
| API-SET-029 | idempotency replay | revision N | PATCH `{"theme":"light"}` If-Match `"N"` + `-H 'Idempotency-Key: qa-set-029-aaaa'` สองครั้ง | ครั้งแรก 200 revision N+1; ครั้งที่สองได้ body เดิม + `Idempotent-Replayed: true` + ETag เดิม | revision ยังเป็น N+1 |
| API-SET-030 | key เดิม body ต่างกัน | หลัง 029 | key `qa-set-029-aaaa` + body `{"theme":"dark"}` | 409 `IDEMPOTENCY_KEY_REUSED` | - |
| API-SET-031 | key เดิม If-Match ต่างกัน | หลัง 029 | key เดิม, body เดิม, If-Match `"N+1"` | 409 `IDEMPOTENCY_KEY_REUSED` (hash รวม If-Match) | - |
| API-SET-032 | key รูปแบบผิด | - | `-H 'Idempotency-Key: short'` | 400 `{field:"Idempotency-Key"}` | - |
| API-SET-033 | key ที่ error แล้วใช้ซ้ำได้ | - | key ใหม่ + If-Match เก่า → 412 แล้วส่ง key เดียวกันด้วย If-Match ถูก | ครั้งที่สอง 200 (error ปล่อย key) | - |
| API-SET-034 | settings แยกตามบัญชี | `TOKEN_NA` และ `TOKEN_T1` | GET ของทั้งสอง | ค่าไม่ปนกัน | - |
| API-SET-035 | export สะท้อน settings | หลัง SET-002 | `ct1 $API/v1/me/export` | `settings.theme` ตรงกับล่าสุด | - |

---

## 5. อุปกรณ์ (`/v1/me/devices`)

`deviceId` ต้องเป็น UUID เวอร์ชัน 1-8 (`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, ไม่สนตัวพิมพ์, เก็บเป็นตัวเล็ก) · อุปกรณ์ active สูงสุด 20 ต่อบัญชี · body PUT: `platform` (`ios`/`android`), `osMajor` (int 0..99), `appBuild` (`^[0-9A-Za-z.+-]{1,32}$`), `appliedSettingsRevision` (int ≥0, ค่าเริ่มต้น 0, ห้ามเกิน revision ของ settings)

### 5.1 `PUT /v1/me/devices/{deviceId}` (ลงทะเบียน/อัปเดต)

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-DEV-001 | ลงทะเบียนใหม่ | `DEV_NA=$(uuid)` | `cn -X PUT -H "$CT" -d '{"platform":"ios","osMajor":17,"appBuild":"1.4.0+120"}' $API/v1/me/devices/$DEV_NA` | 200 Device `{id:DEV_NA, platform:"ios", osMajor:17, appBuild:"1.4.0+120", appliedSettingsRevision:0, lastSeenAt, lastSyncedAt:null, revokedAt:null, overrides:{}, preferencesRevision:0}` | ปรากฏใน `GET /v1/me/devices` |
| API-DEV-002 | อัปเดตอุปกรณ์เดิม | หลัง 001 | PUT เดิม `{"platform":"ios","osMajor":18,"appBuild":"1.5.0"}` | 200 `osMajor:18`, `lastSeenAt` ใหม่ | ไม่มีรายการซ้ำใน GET |
| API-DEV-003 | id ตัวพิมพ์ใหญ่เก็บเป็นตัวเล็ก | - | PUT ด้วย `$(uuid \| tr a-f A-F)` | 200 `id` เป็นตัวเล็ก | - |
| API-DEV-004 | ลงทะเบียน "โทรศัพท์" สำหรับ sign out | `TOKEN_PHONE`, `DEV_PH=$(uuid)` | `cph -X PUT -H "$CT" -d '{"platform":"android","osMajor":14,"appBuild":"88"}' $API/v1/me/devices/$DEV_PH` | 200 | ใช้ใน API-DEV-040 |
| API-DEV-005 | appliedSettingsRevision เท่ากับของเซิร์ฟเวอร์ | settings revision N | body + `"appliedSettingsRevision":N` | 200 `appliedSettingsRevision:N` | - |
| API-DEV-006 | appliedSettingsRevision ไม่ถอยหลัง | หลัง 005 (N>0) | body + `"appliedSettingsRevision":0` | 200 `appliedSettingsRevision` ยังเป็น N | - |
| API-DEV-007 | appliedSettingsRevision เกินเซิร์ฟเวอร์ | revision N | `"appliedSettingsRevision":N+1` | 400 `{field:"appliedSettingsRevision", reason:"ahead_of_server", settingsRevision:N}` | - |
| API-DEV-008 | appliedSettingsRevision ติดลบ | - | `-1` | 400 `{field:"appliedSettingsRevision", reason:"out_of_range"}` | - |
| API-DEV-009 | appliedSettingsRevision ทศนิยม/สตริง | - | `1.5` และ `"1"` | 400 `out_of_range` | - |
| API-DEV-010 | id ไม่ใช่ UUID | - | `cn -X PUT -H "$CT" -d '{"platform":"ios","osMajor":17,"appBuild":"1"}' $API/v1/me/devices/phone-1` | 400 `{field:"deviceId", reason:"must_be_uuid"}` | - |
| API-DEV-011 | UUID เวอร์ชัน 0 | - | id `00000000-0000-0000-0000-000000000000` | 400 `must_be_uuid` | - |
| API-DEV-012 | UUID variant ผิด | - | id `11111111-1111-4111-c111-111111111111` | 400 `must_be_uuid` | - |
| API-DEV-013 | platform นอกรายการ | - | `"platform":"web"` | 400 `{field:"platform", reason:"value_not_allowed"}` | - |
| API-DEV-014 | platform ตัวใหญ่ | - | `"platform":"iOS"` | 400 `value_not_allowed` | - |
| API-DEV-015 | ขาด platform | - | body ไม่มี platform | 400 field `platform` (`value_not_allowed`) | - |
| API-DEV-016 | osMajor 100 | - | `"osMajor":100` | 400 `{field:"osMajor", reason:"out_of_range"}` | - |
| API-DEV-017 | osMajor -1 / 17.2 / "17" | - | ทีละค่า | 400 `out_of_range` | - |
| API-DEV-018 | osMajor 0 และ 99 (ขอบ) | - | ทีละค่า | 200 | - |
| API-DEV-019 | appBuild 33 ตัว | - | `"appBuild":"123456789012345678901234567890123"` | 400 `{field:"appBuild", reason:"malformed"}` | - |
| API-DEV-020 | appBuild มีช่องว่าง/`/`/`_` | - | `"1 0"`, `"1/0"`, `"1_0"` | 400 `malformed` | - |
| API-DEV-021 | appBuild ว่าง | - | `""` | 400 `malformed` | - |
| API-DEV-022 | appBuild 32 ตัว (ขอบ) | - | 32 ตัว `[0-9A-Za-z.+-]` | 200 | - |
| API-DEV-023 | field ไม่รู้จัก | - | body + `"name":"My phone"` | 400 `{field:"name", reason:"unknown_field"}` | - |
| API-DEV-024 | body ไม่ใช่ object | - | `-d '[]'` | 400 `reason: body_must_be_object` | - |
| API-DEV-025 | ไม่มี token | - | `c0 -X PUT ...` | 401 `AUTH_REQUIRED` | - |
| API-DEV-026 | PUT อุปกรณ์ที่ถูก sign out แล้ว | หลัง API-DEV-040, token session อื่นของเจ้าของเดียวกัน | PUT `$DEV_PH` ด้วย token อื่นของบัญชีนั้น | 403 `DEVICE_REVOKED` | ลงทะเบียนกลับไม่ได้ |
| API-DEV-027 | id เดียวกันในอีกบัญชีเป็นอุปกรณ์แยก | `DEV_NA` ของ tar-noaccess | `ct1 -X PUT ... $API/v1/me/devices/$DEV_NA` | 200 (อุปกรณ์ของ T1) | `cn GET /v1/me/devices` ของ tar-noaccess ไม่เปลี่ยน (osMajor ไม่ถูกเขียนทับ) |
| API-DEV-028 | จำกัด 20 อุปกรณ์ active | `TOKEN_T1` ลงทะเบียนครบ 20 (`for i in $(seq 20); do ct1 -o /dev/null -X PUT -H "$CT" -d '{"platform":"ios","osMajor":17,"appBuild":"1"}' $API/v1/me/devices/$(uuid); done`) | PUT อุปกรณ์ที่ 21 | 409 `DEVICE_LIMIT` `{maxActiveDevices:20}` | การ PUT อุปกรณ์เดิมที่มีอยู่ยังได้ 200 · ใช้ 22 writes (อยู่ใต้ 30/นาที) |
| API-DEV-029 | idempotent replay | - | PUT เดิม + `-H 'Idempotency-Key: qa-dev-029-aaaa'` สองครั้ง | ครั้งที่สอง `Idempotent-Replayed: true` body เดิม | - |

### 5.2 `GET /v1/me/devices`

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-DEV-030 | รายการอุปกรณ์ | หลัง 001 | `cn $API/v1/me/devices` | 200 `{settingsRevision, serverObservedAt, devices:[...], nextCursor}`, `Cache-Control: no-store` | - |
| API-DEV-031 | ลำดับ | มีทั้ง active และ revoked | ดู `devices` | active มาก่อน, แล้ว `lastSeenAt` ใหม่→เก่า, แล้ว id | - |
| API-DEV-032 | pagination | T1 มี 20 อุปกรณ์ | `ct1 "$API/v1/me/devices?limit=5"` แล้วตาม `nextCursor` | หน้าละ 5 ไม่ซ้ำ ไม่ขาด หน้าสุดท้าย `nextCursor:null` | - |
| API-DEV-033 | limit 0 / 101 / abc / 00001 | - | ทีละค่า | 0, 101 → 400 `{field:"limit", reason:"out_of_range", max:100}` · `abc` → 400 · `00001` (5 หลัก) → 400 | - |
| API-DEV-034 | limit 1 และ 100 | - | ทีละค่า | 200 | - |
| API-DEV-035 | cursor เสีย | - | `cursor=%%%`, `cursor=abc` , cursor base64url ของ `["a"]` (1 ส่วน แทน 3) | 400 `{field:"cursor", reason:"malformed"}` | - |
| API-DEV-036 | cursor ยาว 1025 ตัว | - | `cursor=$(head -c 1025 /dev/zero \| tr '\0' A)` | 400 `malformed` | - |
| API-DEV-037 | ไม่มี token | - | `c0 $API/v1/me/devices` | 401 | - |
| API-DEV-038 | ไม่เห็นอุปกรณ์ของผู้อื่น | - | `cn $API/v1/me/devices` | ไม่มี id ที่ T1 ลงทะเบียน (ยกเว้น id ซ้ำใน 027 ซึ่งเป็นของตัวเอง) | - |

### 5.3 `DELETE /v1/me/devices/{deviceId}/session` (sign out อุปกรณ์)

ตรวจ id ก่อน แล้วต้อง sign in ภายใน 300 วินาที (`auth_time`)

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-DEV-040 | sign out อุปกรณ์ | `DEV_PH` (ของ tar-test ผ่าน `TOKEN_PHONE`), `TOKEN` sign in < 5 นาที | `ca -X DELETE $API/v1/me/devices/$DEV_PH/session` | 200 Device ที่มี `revokedAt` | audit `device.revoke` details `{platform:"android"}` · `cph $API/v1/me` → 403 `DEVICE_REVOKED` · `ca $API/v1/me` ยัง 200 · ใน jobs มีงาน `se_<hex64>` (idp_session_end) · session ใน Keycloak ถูกปิด (refresh ของ TOKEN_PHONE ล้มเหลว) |
| API-DEV-041 | sign out ซ้ำ | หลัง 040 | ยิงซ้ำ | 200 `revokedAt` เท่าเดิม | ไม่มี audit `device.revoke` แถวที่สอง |
| API-DEV-042 | sign in เก่ากว่า 5 นาที | `TOKEN_OLD`, อุปกรณ์ active | `cold -X DELETE $API/v1/me/devices/<id>/session` | 401 `REAUTH_REQUIRED` `{maxAgeSeconds:300}` | อุปกรณ์ยัง active |
| API-DEV-043 | id ผิดรูปแบบตรวจก่อน re-auth | `TOKEN_OLD` | `cold -X DELETE $API/v1/me/devices/abc/session` | 400 `must_be_uuid` (ไม่ใช่ 401) | - |
| API-DEV-044 | อุปกรณ์ที่ไม่มี | `TOKEN` สด | `ca -X DELETE $API/v1/me/devices/$(uuid)/session` | 404 `NOT_FOUND` | - |
| API-DEV-045 | IDOR: อุปกรณ์ของคนอื่น | `DEV_NA` ของ tar-noaccess, `TOKEN` สด | `ca -X DELETE $API/v1/me/devices/$DEV_NA/session` | 404 (ไม่ใช่ 403) | `cn GET /v1/me/devices` → DEV_NA ยัง active |
| API-DEV-046 | ไม่มี token | - | `c0 -X DELETE $API/v1/me/devices/$DEV_NA/session` | 401 | - |
| API-DEV-047 | token ไม่มี `auth_time` | ถ้าเจอ | - | 401 `REAUTH_REQUIRED` | ปกติ Keycloak ใส่ให้เสมอ |

---

## 6. ค่าเฉพาะอุปกรณ์ (`/v1/me/devices/{deviceId}/preferences`)

Body PUT: `{"overrides":{...}}` ใช้ key ชุดเดียวกับ settings (`theme`, `language`, `cellularPolicy`) แทนที่ทั้งชุด · `{}` = กลับไปใช้ค่าบัญชี · key อื่นที่ระดับบนสุดนอกจาก `overrides` ถูกเพิกเฉย · ETag = revision ของ preferences · PUT ตรวจ If-Match ก่อน body (ครั้งแรกใช้ `"0"`)

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-DPF-001 | อ่านค่าเริ่มต้น | `DEV_NA` active | `cn $API/v1/me/devices/$DEV_NA/preferences` | 200 `{deviceId, revision:0, schemaVersion, overrides:{}, effective:{theme,language,cellularPolicy ของบัญชี}, accountRevision, updatedAt:null}`, `ETag: "0"`, no-store | - |
| API-DPF-002 | ตั้ง override | revision 0 | `cn -X PUT -H "$CT" -H 'If-Match: "0"' -d '{"overrides":{"theme":"light"}}' $API/v1/me/devices/$DEV_NA/preferences` | 200 `revision:1`, `overrides:{theme:"light"}`, `effective.theme:"light"`, ETag `"1"` | `GET /v1/me/devices` → `overrides`, `preferencesRevision:1` |
| API-DPF-003 | effective รวมค่าบัญชี | หลัง 002, เปลี่ยน settings language เป็น en | GET preferences | `effective.language:"en"`, `effective.theme:"light"`, `accountRevision` ใหม่ | - |
| API-DPF-004 | รีเซ็ตด้วย `{}` | revision 1 | PUT `{"overrides":{}}` If-Match `"1"` | 200 `revision:2`, `overrides:{}` | - |
| API-DPF-005 | ค่าเดิมก็เพิ่ม revision | revision 2 | PUT `{"overrides":{}}` If-Match `"2"` | 200 `revision:3` | - |
| API-DPF-006 | ไม่มี If-Match | - | PUT ไม่มี If-Match | 428 `PRECONDITION_REQUIRED` | - |
| API-DPF-007 | If-Match ผิดรูปแบบ | - | `If-Match: 1` | 400 `{field:"If-Match", reason:"malformed"}` | - |
| API-DPF-008 | revision เก่า | revision N | If-Match `"0"` | 412 `REVISION_MISMATCH` `{currentRevision:N}` | - |
| API-DPF-009 | ไม่มี key overrides | - | `-d '{"theme":"dark"}'` | 400 `{field:"overrides", reason:"must_be_object"}` | - |
| API-DPF-010 | overrides เป็น array/null/string | - | `{"overrides":[]}`, `{"overrides":null}`, `{"overrides":"dark"}` | 400 `overrides` `must_be_object` | - |
| API-DPF-011 | body เป็น array | - | `-d '[]'` | 400 `overrides` `must_be_object` | - |
| API-DPF-012 | key ไม่รู้จักใน overrides | - | `{"overrides":{"volume":"high"}}` | 400 `{field:"volume", reason:"unknown_field"}` | - |
| API-DPF-013 | ค่าไม่อยู่ในรายการ | - | `{"overrides":{"language":"fr"}}` | 400 `{field:"language", reason:"value_not_allowed", allowed:["th","en"]}` | - |
| API-DPF-014 | ค่า null | - | `{"overrides":{"theme":null}}` | 400 `value_not_allowed` | - |
| API-DPF-015 | key ระดับบนเพิ่มเติมถูกเพิกเฉย | - | `{"overrides":{"theme":"dark"},"extra":1}` If-Match ถูก | 200 (ไม่ใช่ 400; OpenAPI ระบุว่า key อื่นระดับบนถูกเพิกเฉย) | - |
| API-DPF-016 | อุปกรณ์ที่ไม่มี | - | GET/PUT `$(uuid)` | 404 | - |
| API-DPF-017 | IDOR GET | `DEV_NA` ของ tar-noaccess | `ca $API/v1/me/devices/$DEV_NA/preferences` | 404 | - |
| API-DPF-018 | IDOR PUT | - | `ca -X PUT -H "$CT" -H 'If-Match: "0"' -d '{"overrides":{}}' $API/v1/me/devices/$DEV_NA/preferences` | 404 | revision ของ tar-noaccess ไม่เปลี่ยน |
| API-DPF-019 | อุปกรณ์ที่ sign out แล้ว | `DEV_PH` revoked, ใช้ token session อื่นของเจ้าของ | GET และ PUT | 403 `DEVICE_REVOKED` | - |
| API-DPF-020 | id ไม่ใช่ UUID | - | GET `/v1/me/devices/abc/preferences` | 400 `must_be_uuid` | - |
| API-DPF-021 | ไม่มี token | - | `c0 $API/v1/me/devices/$DEV_NA/preferences` | 401 | - |

---

## 7. Export ข้อมูลบัญชี (`/v1/me/exports`, `/v1/export-downloads`)

POST ต้องมี `Idempotency-Key` และ sign in ภายใน 300 วินาที · export ใช้ได้ 24 ชม. · ลิงก์ดาวน์โหลดใช้ได้ไม่เกิน 15 นาที และลิงก์ใหม่ทำให้ลิงก์เก่าใช้ไม่ได้ · `POST .../link` **ไม่สนใจ** `Idempotency-Key` เลย · ใช้ `TOKEN_NA` ที่ขอด้วย `prompt=login&max_age=0`

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-EXP-001 | ไม่มี Idempotency-Key | - | `cn -X POST $API/v1/me/exports` | 428 `IDEMPOTENCY_KEY_REQUIRED` `{header:"Idempotency-Key"}` | - |
| API-EXP-002 | key รูปแบบผิด (7 ตัว) | - | `cn -X POST -H 'Idempotency-Key: abcdefg' $API/v1/me/exports` | 400 `{field:"Idempotency-Key"}` | - |
| API-EXP-003 | key มีอักขระต้องห้าม | - | `-H 'Idempotency-Key: abc/defgh'` | 400 | - |
| API-EXP-004 | key 129 ตัว | - | 129 ตัว `a` | 400 | - |
| API-EXP-005 | sign in เก่า | `TOKEN_NA` เก่ากว่า 5 นาที | `curl ... -X POST -H "$(ik)" $API/v1/me/exports` | 401 `REAUTH_REQUIRED` `{maxAgeSeconds:300}` | - |
| API-EXP-006 | ไม่มี token | - | `c0 -X POST -H "$(ik)" $API/v1/me/exports` | 401 `AUTH_REQUIRED` | - |
| API-EXP-010 | ขอ export | token สด | `cn -X POST -H 'Idempotency-Key: qa-exp-010-aaaa' $API/v1/me/exports` | 202 `{id (uuid), status:"pending", requestedAt, readyAt:null, expiresAt}` | เก็บ `EXP=id` · jobs มีงาน `ex_<id>` |
| API-EXP-011 | replay key เดิม | หลัง 010 | ยิงซ้ำ key เดิม | 202 body เดิม + `Idempotent-Replayed: true` | ไม่มี export ใหม่ |
| API-EXP-012 | key ใหม่ระหว่างกำลังสร้าง | export ยัง pending | key ใหม่ | 202 `id` เดิม (คืน export ที่กำลังสร้าง) | - |
| API-EXP-013 | สถานะ | - | `cn $API/v1/me/exports/$EXP` | 200 `status` `pending` → `ready` (รอไม่กี่วินาที), `readyAt` มีค่า | audit `account.export` เมื่อสร้างเสร็จ |
| API-EXP-014 | id ไม่ใช่ UUID | - | `cn $API/v1/me/exports/abc` | 404 | - |
| API-EXP-015 | id ที่ไม่มี | - | `cn $API/v1/me/exports/$(uuid)` | 404 | - |
| API-EXP-016 | IDOR GET | `EXP` ของ tar-noaccess | `ca $API/v1/me/exports/$EXP` | 404 | - |
| API-EXP-017 | ลิงก์ก่อนพร้อม | export ใหม่ที่ยัง pending | `cn -X POST $API/v1/me/exports/<id>/link` | 409 `EXPORT_NOT_READY` `{status:"pending"}` | ทำทันทีหลังสร้าง ถ้าเสร็จเร็วเกินให้ BLOCKED |
| API-EXP-018 | สร้างลิงก์ | `ready` | `cn -X POST $API/v1/me/exports/$EXP/link` | 201 `{path:"/v1/export-downloads/<43 ตัว>", expiresAt}` (`expiresAt` ≤ 15 นาทีจากตอนนี้) | เก็บ `LINK1` ห้ามใส่รายงาน |
| API-EXP-019 | ดาวน์โหลด | `LINK1` | `c0 $API$LINK1 -o /tmp/qa-export.json -D -` | 200 JSON export, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `Content-Disposition: attachment` | ลบไฟล์หลังตรวจ |
| API-EXP-020 | ลิงก์ใหม่ทำให้ลิงก์เก่าตาย | หลัง 018 | สร้าง `LINK2` แล้ว `c0 $API$LINK1` | 404 · `LINK2` ได้ 200 | - |
| API-EXP-021 | link ไม่สนใจ Idempotency-Key | - | POST link ด้วย `-H 'Idempotency-Key: qa-exp-021-aaaa'` สองครั้ง | ทั้งสองได้ 201 path ต่างกัน ไม่มี `Idempotent-Replayed` · key `bad` (ผิดรูปแบบ) ก็ได้ 201 | ดู mismatch ข้อ 1 |
| API-EXP-022 | IDOR link | `EXP` ของ tar-noaccess | `ca -X POST $API/v1/me/exports/$EXP/link` | 404 | - |
| API-EXP-023 | token ดาวน์โหลดผิดรูปแบบ | - | `c0 $API/v1/export-downloads/short` | 404 | - |
| API-EXP-024 | token 43 ตัวที่ไม่มี | - | `c0 $API/v1/export-downloads/$(head -c 43 /dev/zero \| tr '\0' A)` | 404 | - |
| API-EXP-025 | ดาวน์โหลดไม่ต้องใช้ token แต่ติด rate limit ต่อ IP | - | ดู API-RL-006 | - | - |
| API-EXP-026 | export หมดอายุ | อายุ > 24 ชม. | GET export | 404 | ทำได้เฉพาะถ้ามี export เก่า มิฉะนั้น BLOCKED |
| API-EXP-027 | เนื้อหา export ไม่มีความลับ | ไฟล์จาก 019 | ตรวจเนื้อหา | ไม่มี token, sid, IP, รหัสผ่าน; มีเฉพาะข้อมูลของ tar-noaccess | - |

---

## 8. ลบบัญชี (`DELETE /v1/me`, `DELETE /v1/me/account`, `GET /v1/account-deletions/{ticket}`)

**ใช้บัญชี throwaway (`TOKEN_T2`) เท่านั้น** · ต้อง sign in ภายใน 300 วินาที · `DELETE /v1/me` บังคับ Idempotency-Key, `DELETE /v1/me/account` ไม่บังคับ · การลบจริงเกิดใน background: ลบผู้ใช้ใน Keycloak, ลบข้อมูล, audit `account.deleted` โดย `system:account-deletion`

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-DEL-001 | ลบบัญชี | `TOKEN_T2` สด, มีอุปกรณ์ 1 เครื่อง | `ct2 -X DELETE -H 'Idempotency-Key: qa-del-001-aaaa' $API/v1/me` | 202 `{ticket (43 ตัว), status:"deleting"}` | เก็บ `TICKET` (ความลับ) · audit `account.delete_requested` · อุปกรณ์ทั้งหมดถูก revoke |
| API-DEL-002 | ไม่มี key บน `/v1/me` | throwaway อื่น | `ctX -X DELETE $API/v1/me` | 428 `IDEMPOTENCY_KEY_REQUIRED` | บัญชียัง active |
| API-DEL-003 | sign in เก่า | throwaway, token > 5 นาที | DELETE `/v1/me` + key | 401 `REAUTH_REQUIRED` | บัญชียัง active |
| API-DEL-004 | ไม่มี token | - | `c0 -X DELETE -H "$(ik)" $API/v1/me` | 401 | - |
| API-DEL-005 | ยิงซ้ำ key เดิม | หลัง 001 | ซ้ำ 001 | 403 `ACCOUNT_DELETING` (guard ปฏิเสธก่อน replay) | ดู mismatch ข้อ 6 |
| API-DEL-006 | ใช้งานหลังสั่งลบ | หลัง 001 | `ct2 $API/v1/me/settings` | 403 `ACCOUNT_DELETING` | - |
| API-DEL-007 | สถานะ ticket | `TICKET` | `c0 $API/v1/account-deletions/$TICKET` | 200 `{status:"deleting" หรือ "completed", requestedAt, deadline (= requestedAt + 30 วัน), completedAt}`, `Cache-Control: no-store` | หลังเสร็จ `status:"completed"`, `completedAt` มีค่า |
| API-DEL-008 | ticket ผิดรูปแบบ | - | `c0 $API/v1/account-deletions/short` | 404 | - |
| API-DEL-009 | ticket 43 ตัวที่ไม่มี | - | `c0 $API/v1/account-deletions/$(head -c 43 /dev/zero \| tr '\0' a)` | 404 | - |
| API-DEL-010 | ticket 44 ตัว / มี `.` | - | ทีละค่า | 404 | - |
| API-DEL-011 | ผล purge | หลัง completed | login T2 ใหม่ใน Keycloak | ผู้ใช้ไม่มีใน Keycloak แล้ว | audit `account.deleted` actor `system:account-deletion` · `POST /v1/admin/users/lookup` ด้วย userId เดิมแสดง `status` ถูกลบ หรือ 404 |
| API-DEL-012 | `DELETE /v1/me/account` ไม่มี key | throwaway ที่สาม (ถ้ามี) | `ctX -X DELETE $API/v1/me/account` | 202 `{ticket, status:"deleting"}` | ถ้าไม่มีบัญชีที่สามให้ BLOCKED |
| API-DEL-013 | `DELETE /v1/me/account` sign in เก่า | throwaway | token > 5 นาที | 401 `REAUTH_REQUIRED` | - |
| API-DEL-014 | การลบล้มเหลว (Keycloak ล่ม) | ต้องหยุด Keycloak | - | `status:"failed"` และ incident `account_deletion_failed` | **ข้าม** |

---

## 9. Remote config สาธารณะ (`GET /v1/config`)

ไม่ต้องใช้ token, ไม่ติด rate limit · query: `channel` = `production` (ค่าเริ่มต้น) / `staging`, `platform` = `ios` / `android`, `build` = `^[1-9]\d{0,9}$` และไม่เกิน 2147483647 (ต้องมี `platform` ด้วย) · query อื่นถูกเพิกเฉย
Response: `{jws, schemaVersion, release (0 = ค่าเริ่มต้น), environment, targets, publishedAt, expiresAt, issuedAt, validUntil, config}` · JWS header `{alg:"EdDSA", kid, typ:"tunedeck-config+jws"}` · ETag `"r<release>-<kid>-<เวลาเซ็น base36>"` หรือ `"d-<channel>-<kid>-<เวลา>"` (เซ็นใหม่ทุก 1 ชม. หรือเมื่อ API restart) · `Cache-Control: no-cache` ใน dev

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-CFG-001 | config production | - | `c0 $API/v1/config` | 200 มีทุก field ข้างบน, `environment:"production"`, `Cache-Control: no-cache`, มี ETag | `release` = release production ล่าสุดที่ target ครอบคลุมทุก platform/build หรือ 0 |
| API-CFG-002 | JWS ตรงกับข้อมูลที่ส่ง | หลัง 001 | `c0 -s $API/v1/config \| jq -r .jws \| cut -d. -f1,2 \| tr . '\n' \| while read p; do printf '%s' "$p" \| node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Buffer.from(s,"base64url").toString()))'; done` | header `alg:"EdDSA"`, `typ:"tunedeck-config+jws"`, `kid` = `signingKeyId` ของ API-ACF-001 · payload เท่ากับ field ภายนอก (`release`, `config`, `targets`, `expiresAt`) | - |
| API-CFG-003 | ลายเซ็นตรวจได้ด้วยกุญแจสาธารณะ | ต้องมี public key (ไม่มี endpoint ให้) | - | - | BLOCKED ถ้าไม่มี public key (dev ใช้กุญแจชั่วคราว) |
| API-CFG-004 | If-None-Match ตรง | ETag จาก 001 | `c0 -H "If-None-Match: $ETAG" $API/v1/config` | 304 ไม่มี body | - |
| API-CFG-005 | If-None-Match ไม่ตรง | - | `-H 'If-None-Match: "x"'` | 200 | - |
| API-CFG-006 | If-None-Match weak/หลายค่า | ETag | `-H "If-None-Match: W/$ETAG"` และ `-H "If-None-Match: \"x\", $ETAG"` | 200 ทั้งคู่ (เทียบแบบตรงตัวเท่านั้น) | ข้อสังเกต ไม่ใช่ FAIL |
| API-CFG-007 | channel staging | - | `c0 "$API/v1/config?channel=staging"` | 200 `environment:"staging"` | - |
| API-CFG-008 | channel ผิด | - | `?channel=prod`, `?channel=Production` | 400 `{field:"channel", reason:"value_not_allowed"}` | - |
| API-CFG-009 | platform ผิด | - | `?platform=web` | 400 `{field:"platform", reason:"value_not_allowed"}` | - |
| API-CFG-010 | build ไม่มี platform | - | `?build=120` | 400 `{field:"platform", reason:"required"}` | - |
| API-CFG-011 | build ผิดรูปแบบ | - | `?platform=ios&build=0`, `build=012`, `build=-1`, `build=1.5`, `build=abc`, `build=12345678901` | 400 `{field:"build", reason:"must_be_build_number"}` | - |
| API-CFG-012 | build เกินขอบ | - | `?platform=ios&build=2147483648` | 400 `must_be_build_number` | `build=2147483647` → 200 |
| API-CFG-013 | query ซ้ำ (array) | - | `?channel=staging&channel=production` | 400 `channel` `value_not_allowed` (ไม่ใช่ 500) | - |
| API-CFG-014 | query ไม่รู้จักถูกเพิกเฉย | - | `?foo=bar` | 200 | ข้อสังเกต: route สาธารณะอื่นตอบ 400 unknown_field |
| API-CFG-015 | targeting: client นอก target ได้ release เก่ากว่าที่เข้ากัน | หลัง API-ACF-060 (release ที่ `android.minBuild=200`) | `?platform=android&build=150` เทียบ `build=250` | `build=250` ได้ release ใหม่ · `build=150` ได้ release ก่อนหน้าที่เข้ากัน หรือ `release:0` | - |
| API-CFG-016 | client ไม่บอก platform ได้เฉพาะ release ที่ครอบคลุมทุกอย่าง | หลัง ACF-060 | `c0 $API/v1/config` | ไม่ได้ release ที่มี minBuild | - |
| API-CFG-017 | kid เปลี่ยนเมื่อ restart (dev) | - | - | - | **ข้าม** (ห้าม restart) |
| API-CFG-018 | ไม่ใช้ token ก็ได้ แต่ส่ง token เสียก็ไม่ error | - | `c0 -H 'Authorization: Bearer x' $API/v1/config` | 200 | - |

---

## 10. Remote config ฝั่ง admin (`/v1/admin/config/**`)

บทบาท: `GET` = `operator` หรือ `admin` · `PATCH draft`, `stage`, `publish`, `rollback` = `admin` เท่านั้น · ทุก route ต้องมี session MFA (12 ชม.) · `stage`/`publish`/`rollback` ต้อง MFA สด ≤300 วินาที
ลำดับตรวจ: PATCH = If-Match → body · stage/publish = If-Match → MFA สด → body → blockers · rollback = release id → MFA สด → body
ETag = `"<draft revision>"` · body ของ stage/rollback: `{reason (10..500 ตัว หลัง NFC+trim, ห้าม U+0000-001F และ U+007F-009F), validDays? (7..90, ค่าเริ่มต้น 30)}` · publish เพิ่ม `emergency` (boolean; ถ้า true ต้อง reason ≥20 ตัว)
field ของ draft: `minSupportedBuild.{ios,android}` (null หรือ int 1..2147483647), `features.{catalogBrowse, playlistImport, diagnosticsUpload, radioDirectory, videoPlayback, webBrowser, carScreenVideo}` (boolean), `catalogRefreshHours` (int 1..168), `targets.{ios,android}.{include, minBuild, maxBuild}`

**ข้อจำกัดบนเครื่อง Tar**: มี admin คนเดียว (tar-test) จึงต้อง publish แบบ `emergency:true` ส่วน publish ปกติ (ผู้ตรวจคนละคน) ต้องมี admin คนที่สองที่ตั้ง TOTP แล้ว ถ้าไม่มีให้ BLOCKED (`needs second admin`)

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-ACF-001 | อ่านหน้าจัดการ | `TOKEN` | `ca $API/v1/admin/config` | 200 `{draft{...,revision,updatedAt,changedSinceRelease}, current, staged, stagedIsDraft, stageBlockers, releases (≤20), publishBlockers, defaults, signingKeyId}`, `ETag: "<draft.revision>"`, no-store | เก็บ `CREV=draft.revision`, สำเนา `draft` ไว้คืนค่าตอนจบ |
| API-ACF-002 | ไม่มี token | - | `c0 $API/v1/admin/config` | 401 `AUTH_REQUIRED` | - |
| API-ACF-003 | ลูกค้า | `TOKEN_NA` | `cn $API/v1/admin/config` | 403 `ROLE_REQUIRED` | - |
| API-ACF-004 | admin ที่ session ไม่ได้ MFA | `TOKEN_PW` | `cpw $API/v1/admin/config` | 401 `MFA_REQUIRED` `{maxAgeSeconds:43200, scope:"session"}` | - |
| API-ACF-005 | operator อ่านได้แต่แก้ไม่ได้ | T1 ได้ role operator (CLI-002) + MFA | `ct1 $API/v1/admin/config` แล้ว `ct1 -X PATCH ... draft` | GET 200 (`publishBlockers` มี `admin_role_required`) · PATCH 403 `ROLE_REQUIRED` | revoke role หลังจบ · ถ้า T1 ทำ MFA ไม่ได้ให้ BLOCKED |
| API-ACF-010 | แก้ draft | `CREV` | `ca -X PATCH -H "$CT" -H "If-Match: \"$CREV\"" -d '{"catalogRefreshHours":12}' $API/v1/admin/config/draft` | 200 `draft.catalogRefreshHours:12`, revision +1, ETag ใหม่ | audit `config.update` changes `{fields:["catalogRefreshHours"], revision, values:{catalogRefreshHours:12}}` · `publishBlockers` มี `own_change`, `not_staged` |
| API-ACF-011 | ไม่เปลี่ยนอะไร | revision R | PATCH `{"catalogRefreshHours":12}` If-Match R | 200 revision ยังเป็น R | ไม่มี audit ใหม่ |
| API-ACF-012 | `{}` | revision R | PATCH `{}` | 200 revision R | ไม่มี audit |
| API-ACF-013 | ไม่มี If-Match | - | PATCH ไม่มี If-Match | 428 `PRECONDITION_REQUIRED` | - |
| API-ACF-014 | If-Match ผิดรูปแบบ | - | `If-Match: R` | 400 `{field:"If-Match", reason:"malformed"}` | - |
| API-ACF-015 | revision เก่า | - | If-Match `"0"` (ถ้า R>0) | 412 `REVISION_MISMATCH` `{currentRevision:R}` | - |
| API-ACF-016 | field ไม่รู้จัก | - | `{"maintenanceMode":true}` | 400 `{field:"maintenanceMode", reason:"unknown_field"}` | - |
| API-ACF-017 | body เป็น array | - | `-d '[]'` | 400 `{field:"body", reason:"unknown_field"}` | ดู mismatch ข้อ 5 |
| API-ACF-018 | feature ไม่รู้จัก | - | `{"features":{"darkMode":false}}` | 400 `{field:"features.darkMode", reason:"unknown_field"}` | - |
| API-ACF-019 | feature ไม่ใช่ boolean | - | `{"features":{"webBrowser":"false"}}` | 400 `{field:"features.webBrowser", reason:"must_be_boolean"}` | - |
| API-ACF-020 | features ไม่ใช่ object | - | `{"features":true}` | 400 `{field:"features", reason:"must_be_object"}` | - |
| API-ACF-021 | catalogRefreshHours นอกช่วง | - | `0`, `169`, `1.5`, `"12"` | 400 `{field:"catalogRefreshHours", reason:"out_of_range"}` | `1` และ `168` → 200 |
| API-ACF-022 | minSupportedBuild ผิด | - | `{"minSupportedBuild":{"ios":0}}`, `2147483648`, `"100"`, `1.5` | 400 `{field:"minSupportedBuild.ios", reason:"must_be_build_number"}` | `null` → 200 |
| API-ACF-023 | minSupportedBuild key ไม่รู้จัก | - | `{"minSupportedBuild":{"web":1}}` | 400 `{field:"minSupportedBuild.web", reason:"unknown_field"}` | - |
| API-ACF-024 | minSupportedBuild ไม่ใช่ object | - | `{"minSupportedBuild":100}` | 400 `{field:"minSupportedBuild", reason:"must_be_object"}` | - |
| API-ACF-025 | targets platform ไม่รู้จัก | - | `{"targets":{"web":{"include":true}}}` | 400 `{field:"targets.web", reason:"unknown_field"}` | - |
| API-ACF-026 | targets ไม่ใช่ object | - | `{"targets":[]}` และ `{"targets":{"ios":true}}` | 400 `targets` / `targets.ios` `must_be_object` | - |
| API-ACF-027 | include ไม่ใช่ boolean | - | `{"targets":{"ios":{"include":1}}}` | 400 `{field:"targets.ios.include", reason:"must_be_boolean"}` | - |
| API-ACF-028 | maxBuild < minBuild | - | `{"targets":{"android":{"minBuild":200,"maxBuild":100}}}` | 400 `{field:"targets.android.maxBuild", reason:"below_min_build"}` | - |
| API-ACF-029 | ไม่มี platform เลย | - | `{"targets":{"ios":{"include":false},"android":{"include":false}}}` | 400 `{field:"targets", reason:"no_platform"}` | - |
| API-ACF-030 | target key ไม่รู้จัก | - | `{"targets":{"ios":{"channel":"beta"}}}` | 400 `{field:"targets.ios.channel", reason:"unknown_field"}` | - |
| API-ACF-031 | ลูกค้า PATCH | - | `cn -X PATCH ... draft` | 403 `ROLE_REQUIRED` | - |
| API-ACF-040 | stage | draft มีการเปลี่ยน, `TOKEN` MFA สด, revision R | `ca -X POST -H "$CT" -H "If-Match: \"$R\"" -d '{"reason":"QA stage catalogRefreshHours 12","validDays":7}' $API/v1/admin/config/stage` | 200 `staged.environment:"staging"`, `stagedIsDraft:true`, `stageBlockers:["already_staged"]` | audit `config.stage` (targetId = release, reason, changes `{draftRevision, fields, validDays:7}`) · `c0 "$API/v1/config?channel=staging"` ได้ release นี้ |
| API-ACF-041 | stage ซ้ำ | หลัง 040 | ซ้ำ | 409 `PUBLISH_BLOCKED` `{reasons:["already_staged"]}` | - |
| API-ACF-042 | stage เมื่อไม่มีการเปลี่ยนจาก production | draft เท่ากับ current | stage | 409 `reasons` มี `no_changes` | - |
| API-ACF-043 | stage MFA เก่า | `TOKEN_OLD` (acr mfa แต่ > 300 s) | stage | 401 `MFA_REQUIRED` `{maxAgeSeconds:300}` | - |
| API-ACF-044 | stage If-Match ตรวจก่อน MFA | `TOKEN_OLD` | stage ไม่มี If-Match | 428 (ไม่ใช่ 401) | - |
| API-ACF-045 | stage reason สั้น | - | `{"reason":"short"}` | 400 `{field:"reason", reason:"length"}` | - |
| API-ACF-046 | reason 501 ตัว / มี `\n` / มี `\u0085` / ไม่มี reason / body ไม่ใช่ object | - | ทีละแบบ | 400 `reason` `length` | reason 500 ตัว → ผ่าน validation |
| API-ACF-047 | reason มี bidi `‮` | - | `{"reason":"QA ‮reason test"}` | ผ่าน validation (bidi ไม่ถูกห้าม) | บันทึกเป็นข้อสังเกตความปลอดภัย (ดู SEC) |
| API-ACF-048 | validDays นอกช่วง | - | `6`, `91`, `7.5`, `"30"` | 400 `{field:"validDays", reason:"out_of_range"}` | - |
| API-ACF-049 | key ไม่รู้จักใน body stage | - | `{"reason":"QA stage reason ok","emergency":true}` | 400 `{field:"emergency", reason:"unknown_field"}` (stage ไม่รับ emergency) | - |
| API-ACF-050 | publish ปกติโดยผู้แก้เอง | หลัง 040 | `ca -X POST -H "$CT" -H "If-Match: \"$R\"" -d '{"reason":"QA publish refresh hours"}' $API/v1/admin/config/publish` | 409 `PUBLISH_BLOCKED` `{reasons:["own_change"]}` | - |
| API-ACF-051 | publish emergency reason < 20 | - | `{"reason":"QA emergency pub","emergency":true}` (16 ตัว) | 400 `{field:"reason", reason:"too_short"}` | - |
| API-ACF-052 | emergency ไม่ใช่ boolean | - | `{"reason":"QA emergency publish test","emergency":"yes"}` | 400 `{field:"emergency", reason:"must_be_boolean"}` | - |
| API-ACF-053 | publish emergency | หลัง 040, MFA สด | `{"reason":"QA emergency publish of refresh hours","emergency":true,"validDays":7}` | 200 `current.environment:"production"`, `current.emergency:true`, `current.reviewed:false`, `current.stagedRelease` = release ของ stage | audit `config.publish_emergency` changes มี `emergency:true, reviewer:"none", previousRelease` · `c0 $API/v1/config` ได้ release ใหม่ `config.catalogRefreshHours:12` · `publishBlockers` ไม่มี `own_change` แล้ว |
| API-ACF-054 | publish เมื่อยังไม่ stage | แก้ draft ใหม่แต่ไม่ stage | publish emergency | 409 `reasons:["not_staged"]` | - |
| API-ACF-055 | publish revision เก่า | - | If-Match `"0"` | 412 `REVISION_MISMATCH` | - |
| API-ACF-056 | publish MFA เก่า | `TOKEN_OLD` | publish | 401 `MFA_REQUIRED` `{maxAgeSeconds:300}` | - |
| API-ACF-057 | publish ปกติโดย admin คนที่สอง | admin คนที่สองที่ไม่ได้แก้ draft, stage แล้ว | publish ไม่มี emergency | 200 `current.reviewed:true`, `emergency:false` | audit `config.publish` · ไม่มีคนที่สองให้ BLOCKED |
| API-ACF-058 | publish ไม่มีการเปลี่ยน | draft = current | publish | 409 `reasons` มี `no_changes` | - |
| API-ACF-059 | Idempotency replay ของ publish | - | stage+publish ใหม่ด้วย `-H 'Idempotency-Key: qa-acf-059-aaaa'` แล้วยิงซ้ำ | ครั้งที่สอง 200 + `Idempotent-Replayed: true` (ไม่ใช่ 409 already) | มี release เดียว |
| API-ACF-060 | targeting release | - | PATCH `{"targets":{"android":{"minBuild":200}},"features":{"webBrowser":false}}` → stage → publish emergency | 200 `current.targets.android.minBuild:200` | ใช้กับ API-CFG-015/016 |
| API-ACF-070 | rollback | มี production release P เก่ากว่า current | `ca -X POST -H "$CT" -d '{"reason":"QA rollback to previous release"}' $API/v1/admin/config/releases/$P/rollback` | 200 `current.rollbackOf:P`, `current.draftRevision:null` | audit `config.rollback` `{rollbackOf:P, previousRelease, validDays:30}` · draft ไม่เปลี่ยน · `GET /v1/config` ได้ release ใหม่ที่ payload เท่ากับ P |
| API-ACF-071 | rollback ไปยัง release ปัจจุบัน | current = C | rollback C | 409 `reasons:["already_current"]` | - |
| API-ACF-072 | rollback ไปยัง release staging | release staging S | rollback S | 409 `reasons:["not_production"]` | - |
| API-ACF-073 | rollback release ไม่มี | - | `/releases/999999/rollback` | 404 `NOT_FOUND` | - |
| API-ACF-074 | release id ผิดรูปแบบ | - | `/releases/0/rollback`, `/releases/01/`, `/releases/abc/`, `/releases/1234567890123456/` | 400 `{field:"release", reason:"must_be_number"}` | - |
| API-ACF-075 | rollback MFA เก่า | `TOKEN_OLD` | rollback P | 401 `MFA_REQUIRED` `{maxAgeSeconds:300}` | - |
| API-ACF-076 | rollback id ผิดตรวจก่อน MFA | `TOKEN_OLD` | `/releases/abc/rollback` | 400 (ไม่ใช่ 401) | - |
| API-ACF-077 | rollback ไม่ใช้ If-Match | - | rollback ไม่มี If-Match | 200 | - |
| API-ACF-078 | schema เปลี่ยน | release schema เก่า | - | 409 `schema_changed` | BLOCKED (ไม่มี release schema อื่นบนเครื่อง) |
| API-ACF-079 | ลูกค้า/operator stage, publish, rollback | `TOKEN_NA` | ทั้งสาม route | 403 `ROLE_REQUIRED` | - |
| API-ACF-090 | คืนค่า | จบทุก case | PATCH draft กลับเป็นค่าที่บันทึกใน ACF-001 (รวม `targets` เป็น include true, min/max null) → stage → publish emergency (reason ≥20) | `current.config` เท่ากับก่อนทดสอบ | บันทึก release สุดท้ายในรายงาน |

---

## 11. สถานีวิทยุฝั่ง admin (`/v1/admin/stations/**`)

บทบาท: ทุก route = `catalog_editor` หรือ `admin` ยกเว้น `publish`, `disable`, `enable` = `admin` เท่านั้น · ต้องมี session MFA (12 ชม.) · publish ต้อง MFA สด ≤300 วินาที · ไม่มี endpoint ลบสถานี
`id`/`recordId` ต้องเป็น UUID v1-8 มิฉะนั้น 400 `{field:"stationId" หรือ "recordId", reason:"must_be_uuid"}` · ETag = `"<revision>"` · ทุก response `Cache-Control: no-store`
body สถานี: `name` (NFC+trim, 1..80, ห้าม control char และ bidi U+202A-202E, U+2066-2069), `country` (`^[A-Z]{2}$`), `language` (`^[a-z]{2,3}$`), `streamUrl` (https เท่านั้น ดูกฎใน 11.2), `codec` (`mp3`/`aac`/`hls`), `genres?` (≤5, แต่ละตัว `^[a-z0-9-]{2,24}$`, ตัดซ้ำ), `bitrateKbps?` (null หรือ int 8..512)
ทุกสถานีที่สร้างตั้งชื่อ `QA-<tester>-...` และ disable เมื่อจบ (API-STN-090)

```sh
STATION='{"name":"QA-gemini-Jazz FM","country":"TH","language":"th","streamUrl":"https://stream.example.org/jazz.mp3","codec":"mp3","genres":["jazz"],"bitrateKbps":128}'
```

### 11.1 สร้างและอ่าน

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-STN-001 | สรุปจำนวน | `TOKEN` | `ca $API/v1/admin/stations/summary` | 200 `{total, visible, pending, drafts, disabled}` (ตัวเลขทั้งหมด) | - |
| API-STN-002 | รายการ | - | `ca $API/v1/admin/stations` | 200 `{stations:[AdminStation+health], nextCursor}` | - |
| API-STN-003 | ไม่มี token | - | `c0 $API/v1/admin/stations` | 401 `AUTH_REQUIRED` | - |
| API-STN-004 | ลูกค้า | `TOKEN_NA` | `cn $API/v1/admin/stations` | 403 `ROLE_REQUIRED` | - |
| API-STN-005 | admin ไม่ได้ MFA | `TOKEN_PW` | `cpw $API/v1/admin/stations` | 401 `MFA_REQUIRED` `{maxAgeSeconds:43200, scope:"session"}` | - |
| API-STN-006 | role ผิด (operator, auditor, support) | T1 ได้ role นั้นผ่าน CLI + MFA | `ct1 $API/v1/admin/stations` | 403 `ROLE_REQUIRED` | revoke หลังจบ · ถ้าทำไม่ได้ BLOCKED |
| API-STN-007 | catalog_editor ใช้ได้ | T1 = catalog_editor + MFA | GET list, POST create | 200 / 201 · `publishBlockers` มี `admin_role_required` | - |
| API-STN-008 | ค้นด้วย q | มีสถานี `QA-...` | `ca "$API/v1/admin/stations?q=QA-gemini"` | 200 เฉพาะชื่อที่มีข้อความนี้ | - |
| API-STN-009 | q มี `%` `_` ถูก escape | - | `ca "$API/v1/admin/stations?q=%25"` และ `?q=_` | 200 เฉพาะสถานีที่ชื่อมี `%` หรือ `_` จริง (ไม่ใช่ทั้งหมด) | - |
| API-STN-010 | q ยาว 81 ตัว | - | `q=$(printf 'a%.0s' {1..81})` | 400 `{field:"q", reason:"out_of_range", max:80}` | 80 ตัว → 200 |
| API-STN-011 | q เป็นช่องว่าง | - | `?q=%20%20` | 400 `q` `out_of_range` | `?q=` (ว่าง) → 200 ไม่กรอง |
| API-STN-012 | q แบบ SQL injection | - | `?q=%27%20OR%201%3D1--` | 200 รายการว่างหรือเฉพาะที่ตรง ไม่มี 500 | - |
| API-STN-013 | กรอง status | - | `?status=draft`, `published`, `changes_pending`, `disabled` | 200 ทุกตัวมี `status` ตรง | - |
| API-STN-014 | status ผิด | - | `?status=live`, `?status=DRAFT` | 400 `{field:"status", reason:"invalid"}` | - |
| API-STN-015 | pagination | > 2 สถานี | `?limit=1` แล้วตาม `nextCursor` | ไม่ซ้ำ ไม่ขาด | - |
| API-STN-016 | limit/cursor ผิด | - | `limit=0`, `limit=101`, `cursor=bad!` | 400 `limit` `out_of_range` / `cursor` `malformed` | - |
| API-STN-020 | สร้างสถานี | - | `ca -X POST -H "$CT" -d "$STATION" $API/v1/admin/stations` | 201 `{id, revision:1, status:"draft", draft:{...}, published:null, publishedRevision:null, publishBlockers:[..."own_change","rights_missing"], rights:{state:"missing"}}`, `ETag: "1"` | เก็บ `STN` · audit `station.create` · summary `drafts` +1 |
| API-STN-021 | อ่านสถานี | `STN` | `ca $API/v1/admin/stations/$STN` | 200 view เดียวกัน + `health`, `ETag: "1"` | - |
| API-STN-022 | id ไม่มี | - | `ca $API/v1/admin/stations/$(uuid)` | 404 `NOT_FOUND` | - |
| API-STN-023 | id ไม่ใช่ UUID | - | `ca $API/v1/admin/stations/abc` | 400 `{field:"stationId", reason:"must_be_uuid"}` | - |
| API-STN-024 | genres ซ้ำถูกตัด | - | `genres:["jazz","jazz","pop"]` | 201 `draft.genres:["jazz","pop"]` | - |
| API-STN-025 | name ถูก trim/NFC | - | `name:"  QA-gemini-Café  "` | 201 `draft.name:"QA-gemini-Café"` (NFC, ไม่มีช่องว่างหัวท้าย) | - |
| API-STN-026 | idempotent create | - | POST `$STATION` (ชื่อใหม่) + `-H 'Idempotency-Key: qa-stn-026-aaaa'` สองครั้ง | ครั้งที่สอง 201 body เดิม + `Idempotent-Replayed: true` | สร้างสถานีเดียว (เช็กด้วย q) |

### 11.2 Validation ของ body สร้าง/แก้

ใช้ `ca -X POST -H "$CT" -d '<body>' $API/v1/admin/stations` โดยแก้ทีละ field จาก `$STATION` (ใช้ `jq -c '.name="..."' <<<"$STATION"`)

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-STN-030 | body ไม่ใช่ object | - | `-d '[]'` | 400 `reason: body_must_be_object` | - |
| API-STN-031 | ขาด field บังคับ | - | ตัด `name`, `country`, `language`, `streamUrl`, `codec` ทีละตัว | 400 `{field:<ชื่อ>, reason:"required"}` | - |
| API-STN-032 | field ไม่รู้จัก | - | + `"logoUrl":"https://x.org/a.png"` | 400 `{field:"logoUrl", reason:"unknown_field"}` | - |
| API-STN-033 | name ไม่ใช่ string | - | `"name":123` | 400 `{field:"name", reason:"must_be_string"}` | - |
| API-STN-034 | name ว่างหลัง trim | - | `"name":"   "` | 400 `{field:"name", reason:"length"}` | - |
| API-STN-035 | name 81 ตัว | - | 81 ตัว | 400 `name` `length` | 80 ตัว → 201 |
| API-STN-036 | name มี control char | - | `"QA-\u0007bell"`, `"QA-\ttab"`, `"QA-\u007f"` | 400 `{field:"name", reason:"control_characters"}` | - |
| API-STN-037 | name มี bidi | - | `"QA-‮gnp.exe"`, `"QA-⁦x⁩"` | 400 `name` `control_characters` | - |
| API-STN-038 | name มีอักขระไทย/emoji | - | `"QA-gemini-สถานีทดสอบ"` | 201 | - |
| API-STN-039 | country ผิด | - | `"th"`, `"THA"`, `"T1"` | 400 `{field:"country", reason:"iso_3166_alpha2"}` | - |
| API-STN-040 | language ผิด | - | `"TH"`, `"t"`, `"thai"` | 400 `{field:"language", reason:"iso_639"}` | `"fil"` → 201 |
| API-STN-041 | codec ผิด | - | `"ogg"`, `"MP3"` | 400 `{field:"codec", reason:"value_not_allowed"}` | - |
| API-STN-042 | bitrate นอกช่วง | - | `7`, `513`, `128.5`, `"128"` | 400 `{field:"bitrateKbps", reason:"out_of_range"}` | `8`, `512`, `null` → 201 |
| API-STN-043 | genres เกิน 5 | - | 6 ตัว | 400 `{field:"genres", reason:"max_5"}` | - |
| API-STN-044 | genre ผิดรูปแบบ | - | `["Jazz"]`, `["j"]`, `["a b"]`, 25 ตัว | 400 `genres` `slug` | - |
| API-STN-045 | streamUrl ไม่ใช่ URL | - | `"not a url"`, `123` | 400 `{field:"streamUrl", reason:"must_be_url"}` | - |
| API-STN-046 | streamUrl ยาวเกิน 2048 | - | `https://a.org/` + 2040 ตัว | 400 `must_be_url` | - |
| API-STN-047 | http | - | `"http://stream.example.org/a.mp3"` | 400 `https_required` | - |
| API-STN-048 | scheme อื่น | - | `"ftp://x.org/a"`, `"javascript:alert(1)"`, `"file:///etc/passwd"` | 400 `https_required` หรือ `must_be_url` | - |
| API-STN-049 | มี user/password | - | `"https://u:p@stream.example.org/a"` | 400 `credentials_not_allowed` | - |
| API-STN-050 | มี fragment | - | `"https://stream.example.org/a#x"` | 400 `fragment_not_allowed` | - |
| API-STN-051 | IP literal | - | `"https://127.0.0.1/a"`, `"https://[::1]/a"`, `"https://169.254.169.254/a"`, `"https://8.8.8.8/a"` | 400 `ip_literal_not_allowed` | - |
| API-STN-052 | host ภายใน | - | `https://localhost/a`, `https://radio/a`, `https://a.local/a`, `https://a.internal/a`, `https://a.localdomain/a`, `https://a.home.arpa/a` | 400 `private_host` | - |
| API-STN-053 | port ไม่ใช่ 443 | - | `"https://stream.example.org:8443/a"` | 400 `nonstandard_port` | `:443` → 201 |
| API-STN-054 | host ที่ resolve เป็น IP ภายใน (DNS rebinding) | - | `"https://127.0.0.1.nip.io/a"` | 201 (ผ่าน validation) แต่ API-SHC-001 ต้องได้ `reason:"blocked_address"` | ห้ามยิงออก ถ้า API ไม่มีอินเทอร์เน็ตจะได้ `dns_failed` |

### 11.3 แก้ไข (`PATCH /v1/admin/stations/{id}`)

ลำดับตรวจ: id → If-Match → body · ใช้ field rule เดียวกัน ไม่มี field บังคับ

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-STN-060 | แก้ชื่อ | `STN` revision 1 | `ca -X PATCH -H "$CT" -H 'If-Match: "1"' -d '{"name":"QA-gemini-Jazz FM 2"}' $API/v1/admin/stations/$STN` | 200 `revision:2`, `ETag: "2"` | audit `station.update` · history มี event |
| API-STN-061 | patch ที่ไม่เปลี่ยน | revision 2 | PATCH `{"name":"QA-gemini-Jazz FM 2"}` If-Match `"2"` | 200 revision 2 | ไม่มี audit ใหม่ |
| API-STN-062 | `{}` | - | PATCH `{}` | 400 `reason: empty_patch` | - |
| API-STN-063 | ไม่มี If-Match | - | PATCH ไม่มี If-Match | 428 `PRECONDITION_REQUIRED` | - |
| API-STN-064 | revision เก่า | revision 2 | If-Match `"1"` | 412 `REVISION_MISMATCH` `{currentRevision:2}` | - |
| API-STN-065 | id ไม่มี | - | PATCH `$(uuid)` If-Match `"1"` | 404 | - |
| API-STN-066 | field ไม่รู้จัก | - | `{"status":"published"}` | 400 `{field:"status", reason:"unknown_field"}` | - |
| API-STN-067 | validation เหมือนตอนสร้าง | - | `{"streamUrl":"http://x.org/a"}` | 400 `https_required` | - |
| API-STN-068 | ลูกค้า | - | `cn -X PATCH ...` | 403 `ROLE_REQUIRED` | - |

### 11.4 Publish, disable, enable (admin เท่านั้น)

ลำดับตรวจ publish: id → If-Match → body (`reason` 1..500, `emergency?` boolean; emergency ต้อง reason ≥20) → MFA สด → สถานี/blockers
blockers ที่เป็นไปได้: `admin_role_required`, `own_change`, `already_published`, `rights_missing`, `rights_territory`, `rights_not_yet_valid`, `rights_expired` · emergency ข้ามได้เฉพาะ `own_change`

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-STN-070 | publish ไม่มี rights | `STN` ไม่มี rights | `ca -X POST -H "$CT" -H 'If-Match: "2"' -d '{"reason":"QA publish without rights test","emergency":true}' $API/v1/admin/stations/$STN/publish` | 409 `PUBLISH_BLOCKED` `{reasons:["rights_missing"]}` | - |
| API-STN-071 | publish ผู้แก้เองแบบปกติ | มี rights ที่ครอบคลุม TH (API-RGT-001) | `-d '{"reason":"QA normal publish"}'` | 409 `reasons:["own_change"]` | - |
| API-STN-072 | publish emergency | หลัง RGT-001, MFA สด | `-d '{"reason":"QA emergency publish for test run","emergency":true}'` | 200 `status:"published"`, `publishedRevision` = revision, `publishBlockers` มี `already_published` | audit `station.publish_emergency` changes `{revision, previousPublishedRevision:null, emergency:true, reviewer:"none"}` · ปรากฏใน `GET /v1/catalog/radio` · summary `visible` +1 |
| API-STN-073 | publish ซ้ำ | หลัง 072 | publish emergency เดิม | 409 `reasons:["already_published"]` | - |
| API-STN-074 | rights คนละประเทศ | สถานีที่สอง country `JP`, rights territories `["TH"]` | publish emergency | 409 `reasons:["rights_territory"]` | - |
| API-STN-075 | rights ยังไม่เริ่ม | rights `validFrom` อนาคต | publish emergency | 409 `reasons:["rights_not_yet_valid"]` | - |
| API-STN-076 | rights หมดอายุ | rights `validFrom:"2020-01-01", expiresAt:"2020-12-31"` | publish emergency | 409 `reasons:["rights_expired"]` | - |
| API-STN-077 | emergency reason สั้น | - | `{"reason":"too short reason","emergency":true}` (16 ตัว) | 400 `{field:"reason", reason:"too_short"}` | - |
| API-STN-078 | emergency ไม่ใช่ boolean | - | `"emergency":"true"` | 400 `{field:"emergency", reason:"must_be_boolean"}` | - |
| API-STN-079 | reason ว่าง/ไม่มี/501 ตัว/key อื่น | - | `{}`, `{"reason":""}`, 501 ตัว, `{"reason":"x","note":1}` | `{}` → 400 `{field:"reason", reason:"must_be_string"}` · `""`/501 ตัว → `length` · key อื่น → `{field:"note", reason:"unknown_field"}` | - |
| API-STN-080 | publish MFA เก่า | `TOKEN_OLD` | publish ถูกต้อง | 401 `MFA_REQUIRED` `{maxAgeSeconds:300}` | - |
| API-STN-081 | body ผิดตรวจก่อน MFA | `TOKEN_OLD` | body `{}` | 400 (ไม่ใช่ 401) | - |
| API-STN-082 | publish ไม่มี If-Match / เก่า | - | ไม่มี / `"1"` | 428 / 412 `{currentRevision}` | - |
| API-STN-083 | catalog_editor publish | T1 = catalog_editor | publish | 403 `ROLE_REQUIRED` | - |
| API-STN-084 | publish ปกติโดย admin คนที่สอง | admin คนที่สองที่ไม่ได้แก้ | publish ไม่มี emergency | 200 | audit `station.publish` · ไม่มีให้ BLOCKED |
| API-STN-085 | แก้หลัง publish | หลัง 072 | PATCH ชื่อใหม่ | 200 `status:"changes_pending"`, catalog สาธารณะยังเป็นชื่อเดิม (snapshot ที่ publish) | - |
| API-STN-086 | disable | published | `ca -X POST -H "$CT" -d '{"reason":"QA disable test"}' $API/v1/admin/stations/$STN/disable` | 200 `status:"disabled"`, `disabledAt` มีค่า | audit `station.disable` (reason) · หายจาก `/v1/catalog/radio` |
| API-STN-087 | disable ซ้ำ | หลัง 086 | ซ้ำ | 200 `disabledAt` เดิม | audit `station.disable` อีกแถว |
| API-STN-088 | enable | หลัง 086 | `.../enable` `{"reason":"QA enable test"}` | 200 `disabledAt:null` | audit `station.enable` · กลับมาใน catalog |
| API-STN-089 | disable/enable validation | - | body `{}`, `{"reason":""}`, `{"reason":"QA \u202Ex"}`, `{"reason":"x","why":1}`, id ไม่มี, ลูกค้า, catalog_editor | 400 `reason` `must_be_string` / `length` / `control_characters` / 400 `{field:"why", reason:"unknown_field"}` / 404 / 403 / 403 | ไม่ต้อง MFA สด |
| API-STN-090 | เก็บกวาด | จบทุก case | disable ทุกสถานี `QA-<tester>-` | 200 | summary `disabled` ตรง |

### 11.5 ประวัติ (`GET /v1/admin/stations/{id}/history`)

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-STN-095 | ประวัติ | หลัง 060-088 | `ca $API/v1/admin/stations/$STN/history` | 200 `{events:[{id, occurredAt, action, actorSubject, actor, reason, revision, changes}], nextCursor}` ใหม่→เก่า มีเฉพาะ `station.*` และ `rights.*` | `rights.add` ไม่มี `holder` และ evidence keys |
| API-STN-096 | pagination | > 2 events | `?limit=1` แล้วตาม cursor | ไม่ซ้ำ ไม่ขาด | - |
| API-STN-097 | cursor/limit ผิด | - | `cursor=bad!`, `limit=0` | 400 `malformed` / `out_of_range` | - |
| API-STN-098 | id ไม่มี | - | `$(uuid)/history` | 404 `NOT_FOUND` | - |

---

## 12. สิทธิ์เผยแพร่ (rights records)

`GET /v1/admin/stations/{id}/rights`, `POST /v1/admin/stations/{id}/rights`, `POST /v1/admin/stations/{id}/rights/{recordId}/revoke` · บทบาท `catalog_editor` หรือ `admin` · ไม่ต้อง MFA สด
body: `holder` (1..200), `basis` (`owner_permission`/`broadcaster_terms`/`licensed_aggregator`/`owned_demo`), `reference` (1..200), `territories` (1..250 รหัส `^[A-Z]{2}$`, ตัดซ้ำ, เรียง), `validFrom?` (`YYYY-MM-DD`, ค่าเริ่มต้นวันนี้ UTC), `expiresAt?` (`YYYY-MM-DD` หรือ null, ห้ามก่อน validFrom), `evidenceRefs?` (≤10, แต่ละตัว ≤200 ตัว `^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9._-]+)*$` ไม่มี segment `.`/`..`)

```sh
RIGHTS='{"holder":"QA Holder Co","basis":"owned_demo","reference":"QA-REF-001","territories":["TH","LA"],"expiresAt":"2027-12-31","evidenceRefs":["qa/contract-001.pdf"]}'
```

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-RGT-001 | เพิ่ม rights | `STN` | `ca -X POST -H "$CT" -d "$RIGHTS" $API/v1/admin/stations/$STN/rights` | 201 `{id, holder, basis, reference, territories:["LA","TH"], validFrom:<วันนี้>, expiresAt:"2027-12-31", status:"active", effectiveStatus:"active", evidenceCount:1, createdBy, createdAt, ...}` **ไม่มี** `evidenceRefs` | เก็บ `REC` · audit `rights.add` changes มี `recordId, basis, reference, territories, validFrom, expiresAt, evidenceCount` ไม่มี `holder`/evidence · `GET station` → `rights.state:"current"` |
| API-RGT-002 | รายการ rights | - | `ca $API/v1/admin/stations/$STN/rights` | 200 `{records:[...]}` ใหม่→เก่า มี `evidenceRefs` | - |
| API-RGT-003 | ไม่มี token / ลูกค้า | - | `c0` / `cn` | 401 / 403 `ROLE_REQUIRED` | - |
| API-RGT-004 | สถานีไม่มี | - | POST/GET `$(uuid)/rights` | 404 | - |
| API-RGT-005 | ขาด field บังคับ | - | ตัด `holder`, `basis`, `reference`, `territories` ทีละตัว | 400 `{field, reason:"required"}` | - |
| API-RGT-006 | field ไม่รู้จัก | - | + `"notes":"x"` | 400 `{field:"notes", reason:"unknown_field"}` | - |
| API-RGT-007 | basis ผิด | - | `"basis":"fair_use"` | 400 `{field:"basis", reason:"value_not_allowed"}` | - |
| API-RGT-008 | territories ว่าง/251 | - | `[]`, 251 รายการ | 400 `{field:"territories", reason:"length"}` | - |
| API-RGT-009 | territory ผิดรูปแบบ | - | `["th"]`, `["THA"]`, `["WW"]`? | `th`/`THA` → 400 `iso_3166_alpha2` · `WW` → 201 (ตรวจแค่รูปแบบ) | - |
| API-RGT-010 | territories ซ้ำ/เรียง | - | `["TH","LA","TH"]` | 201 `territories:["LA","TH"]` | - |
| API-RGT-011 | วันที่ผิด | - | `validFrom:"2026-02-30"`, `"2026/01/01"`, `"20260101"`, `expiresAt:"2026-13-01"` | 400 `{field, reason:"date_yyyy_mm_dd"}` | - |
| API-RGT-012 | expiresAt ก่อน validFrom | - | `validFrom:"2026-06-01", expiresAt:"2026-05-31"` | 400 `{field:"expiresAt", reason:"before_valid_from"}` | เท่ากันได้ |
| API-RGT-013 | expiresAt null | - | `"expiresAt":null` | 201 `expiresAt:null` | - |
| API-RGT-014 | evidence เกิน 10 | - | 11 รายการ | 400 `{field:"evidenceRefs", reason:"max_10"}` | - |
| API-RGT-015 | evidence key ผิด | - | `["../etc/passwd"]`, `["a/../b"]`, `["/abs"]`, `["a//b"]`, `["https://x.org/a"]`, `["a/./b"]`, 201 ตัว | 400 `evidenceRefs` `opaque_key` | - |
| API-RGT-016 | holder/reference ยาว/ว่าง/control | - | 201 ตัว, `""`, `"QA\u0000"` | 400 `holder`/`reference` (`length`/`control_characters`) | - |
| API-RGT-017 | rights เริ่มอนาคต | - | `validFrom` = พรุ่งนี้ | 201 `effectiveStatus:"scheduled"` | - |
| API-RGT-018 | rights หมดอายุ | - | `validFrom:"2020-01-01", expiresAt:"2020-12-31"` | 201 `effectiveStatus:"expired"` | - |
| API-RGT-020 | revoke | `REC` | `ca -X POST -H "$CT" -d '{"reason":"QA revoke rights test"}' $API/v1/admin/stations/$STN/rights/$REC/revoke` | 200 record `status:"revoked"`, `effectiveStatus:"revoked"`, `revokedAt`, `revokedBy` | audit `rights.revoke` changes `{recordId, hidden}` · ถ้าไม่มี rights อื่นครอบคลุม สถานีหายจาก catalog ทันที (`hidden:true`) |
| API-RGT-021 | revoke ซ้ำ | หลัง 020 | ซ้ำ | 409 `RIGHTS_ALREADY_REVOKED` | - |
| API-RGT-022 | record ของสถานีอื่น | record ของสถานีที่สอง | revoke ผ่าน path `$STN` | 404 | - |
| API-RGT-023 | recordId ผิด | - | `/rights/abc/revoke` | 400 `{field:"recordId", reason:"must_be_uuid"}` | - |
| API-RGT-024 | reason ผิด | - | `{}`, `{"reason":""}`, 501 ตัว, `{"reason":"x","y":1}` | 400 `reason` `must_be_string` / `length` / `length` / `{field:"y", reason:"unknown_field"}` | - |
| API-RGT-025 | สร้าง rights ใหม่หลัง revoke เพื่อคืนสถานะ | - | POST `$RIGHTS` | 201 | catalog กลับมาแสดง (ถ้า published และไม่ disabled) |

---

## 13. ตรวจสุขภาพ stream (`/v1/admin/stations/{id}/health`, `/check`)

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-SHC-001 | check now | `STN` | `ca -X POST $API/v1/admin/stations/$STN/check` | 200 `{region, checkedAt, target:"published" หรือ "draft", ok, reason, httpStatus, latencyMs}` · `reason` เป็นหนึ่งใน `ok, invalid_url, dns_failed, blocked_address, timeout, connect_failed, http_status, too_many_redirects, not_audio` | audit `station.check` · `stream.example.org` ไม่มีจริงจึงคาด `dns_failed` หรือ `connect_failed` |
| API-SHC-002 | check ถี่เกิน | ภายใน 60 วินาทีหลัง 001 | ซ้ำ | 429 `CHECK_TOO_SOON` `{retryAfterSeconds}` + header `Retry-After` | ไม่มี audit ใหม่ |
| API-SHC-003 | ประวัติ | หลัง 001 | `ca $API/v1/admin/stations/$STN/health` | 200 `{checks:[...]}` ≤20 รายการ ใหม่→เก่า | - |
| API-SHC-004 | สถานีไม่มี | - | POST `$(uuid)/check` | 404 | - |
| API-SHC-005 | id ผิด | - | `abc/check` | 400 `must_be_uuid` | - |
| API-SHC-006 | ลูกค้า / ไม่มี token | - | `cn`/`c0` | 403 / 401 | - |
| API-SHC-007 | SSRF ผ่าน DNS ภายใน | สถานี `https://127.0.0.1.nip.io/a` (STN-054) | check | `ok:false`, `reason:"blocked_address"` (หรือ `dns_failed` ถ้าไม่มีอินเทอร์เน็ต) ห้ามได้ `http_status` จาก service ภายใน | - |
| API-SHC-008 | stream จริงที่เป็นเสียง | สถานีที่มี URL stream จริง (ถ้า Tar ให้) | check | `ok:true`, `reason:"ok"` | ถ้าไม่มี BLOCKED |
| API-SHC-009 | check อัตโนมัติตามรอบ | `STATION_CHECK_ENABLED` ปิด | - | - | BLOCKED (ปิดอยู่) |

---

## 14. Catalog สาธารณะ (`GET /v1/catalog/radio`)

ไม่ต้องใช้ token · rate limit 60 ครั้งต่อนาทีต่อ IP · แสดงเฉพาะสถานีที่ publish แล้ว ไม่ถูก disable และ rights ยังไม่หมด · เรียงตาม id · `limit` ต้องตรง `^\d{1,3}$` แล้วถูก **บีบ** เข้า 1..100 (ค่าเริ่มต้น 50) · `cursor` = base64url ของ UUID · ETag แบบ weak `W/"..."` · `Cache-Control: public, max-age=300`

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-CAT-001 | หน้าแรก | มีสถานี published (STN-072) | `c0 $API/v1/catalog/radio` | 200 `{stations:[{id, revision, name, country, language, genres, streamUrl, codec, bitrateKbps}], nextCursor}`, `ETag: W/"..."`, `Cache-Control: public, max-age=300` | ไม่มี field ภายใน (draft, rights, holder, publishedBy) |
| API-CAT-002 | If-None-Match ตรง | ETag จาก 001 | `c0 -H "If-None-Match: $ETAG" $API/v1/catalog/radio` | 304 ไม่มี body | - |
| API-CAT-003 | ETag เปลี่ยนเมื่อข้อมูลเปลี่ยน | หลัง disable สถานี (STN-086) | GET ด้วย ETag เดิม | 200 ETag ใหม่ | - |
| API-CAT-004 | pagination | ≥2 สถานี | `?limit=1` แล้วตาม `nextCursor` | หน้าละ 1 เรียงตาม id ไม่ซ้ำ หน้าสุดท้าย `nextCursor:null` | - |
| API-CAT-005 | limit 0 ถูกบีบเป็น 1 | - | `?limit=0` | 200 ≤1 รายการ | ข้อสังเกต: endpoint อื่นตอบ 400 |
| API-CAT-006 | limit 999 ถูกบีบเป็น 100 | - | `?limit=999` | 200 ≤100 รายการ | - |
| API-CAT-007 | limit ผิดรูปแบบ | - | `?limit=abc`, `?limit=1000`, `?limit=-1`, `?limit=1.5` | 400 `{field:"limit", reason:"out_of_range"}` | - |
| API-CAT-008 | cursor ผิด | - | `?cursor=abc`, `?cursor=$(printf notauuid \| base64)` | 400 `{field:"cursor", reason:"malformed"}` | - |
| API-CAT-009 | cursor เป็น array | - | `?cursor=a&cursor=b` | 400 `cursor` `malformed` | - |
| API-CAT-010 | สถานีที่ revoke rights ไม่แสดง | หลัง RGT-020 (ไม่มี rights อื่น) | GET | ไม่มี `STN` | - |
| API-CAT-011 | แสดง snapshot ที่ publish ไม่ใช่ draft | หลัง STN-085 | GET | `name` เป็นชื่อตอน publish | - |
| API-CAT-012 | token ไม่จำเป็น | - | `cn $API/v1/catalog/radio` | 200 เหมือน c0 | - |
| API-CAT-013 | rate limit ต่อ IP | - | ดู API-RL-004 | - | - |

---

## 15. ค้นหาวิทยุทั่วโลก (`GET /v1/directory/radio`)

ไม่ต้องใช้ token · rate limit 60/นาที/IP · API เรียก Radio Browser ให้ (cache 10 นาที, ใช้ข้อมูลเก่าได้ถึง 1 ชม. เมื่อ upstream ล่ม) · query ที่อนุญาต: `q`, `country`, `language`, `tag`, `limit`, `offset` เท่านั้น
`q`: NFC แล้ว **ลบ** control char, zero-width U+200B-200F, bidi U+202A-202E/U+2066-2069 แล้ว trim; 1..80 · `country` `^[A-Za-z]{2}$` · `language` `^[\p{L} -]{2,40}$` · `tag` `^[\p{L}\p{N} &+-]{1,30}$` · `limit` 1..50 (ค่าเริ่มต้น 30) · `offset` 0..1000
Response: `{stations:[{id, name, country, language, genres, streamUrl, codec, bitrateKbps, logoUrl, homepageUrl}], nextOffset, attribution:"Radio Browser (www.radio-browser.info), community data"}` · `Cache-Control: public, max-age=300`

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-DIR-001 | ค้นด้วยชื่อ | `RADIO_BROWSER_BASE_URL` ตั้งแล้ว | `c0 "$API/v1/directory/radio?q=jazz"` | 200 `stations` ≤30, `attribution` ตามข้างบน, `nextOffset` เป็นตัวเลขหรือ null | ทุก `streamUrl` เป็น https, `codec` เป็น mp3/aac/hls |
| API-DIR-002 | กรองประเทศ | - | `?country=th` | 200 ทุกรายการ `country` เป็นไทย (ตัวพิมพ์เล็กถูกแปลงเป็น TH) | - |
| API-DIR-003 | กรองภาษา/แท็ก | - | `?language=thai`, `?tag=pop`, `?tag=r%26b` | 200 | - |
| API-DIR-004 | ภาษาไทยใน q | - | `?q=%E0%B8%A5%E0%B8%B9%E0%B8%81%E0%B8%97%E0%B8%B8%E0%B9%88%E0%B8%87` (ลูกทุ่ง) | 200 | - |
| API-DIR-005 | offset/nextOffset | 001 มี `nextOffset` | `?q=jazz&offset=30` | 200 รายการต่อจากหน้าแรก | - |
| API-DIR-006 | ไม่มี q เลย | - | `c0 $API/v1/directory/radio` | 200 (ค้นทั้งหมด) | - |
| API-DIR-007 | query ไม่รู้จัก | - | `?name=jazz`, `?order=votes` | 400 `{field:"name", reason:"unknown_field"}` | - |
| API-DIR-008 | q ยาว 81 ตัว | - | 81 ตัว `a` | 400 `{field:"q", reason:"out_of_range", max:80}` | 80 ตัว → 200 |
| API-DIR-009 | q เหลือว่างหลังลบอักขระอันตราย | - | `?q=%E2%80%8B%E2%80%AE` (zero-width + RLO) | 400 `q` `out_of_range` | - |
| API-DIR-010 | q มี bidi ถูกลบทิ้ง | - | `?q=ja%E2%80%AEzz` | 200 ผลเหมือน `q=jazz` | - |
| API-DIR-011 | q ซ้ำ (array) | - | `?q=a&q=b` | 400 `{field:"q", reason:"must_be_string"}` | - |
| API-DIR-012 | country ผิด | - | `?country=THA`, `?country=1A` | 400 `{field:"country", reason:"iso_3166_alpha2"}` | - |
| API-DIR-013 | language ผิด | - | `?language=t`, `?language=th1`, 41 ตัว | 400 `{field:"language", reason:"out_of_range"}` | - |
| API-DIR-014 | tag ผิด | - | `?tag=a/b`, `?tag=%3Cscript%3E`, 31 ตัว | 400 `{field:"tag", reason:"out_of_range"}` | - |
| API-DIR-015 | limit ผิด | - | `0`, `51`, `abc`, `1000` | 400 `{field:"limit", reason:"out_of_range", max:50}` | `1`, `50` → 200 |
| API-DIR-016 | offset ผิด | - | `-1`, `1001`, `10000`, `abc` | 400 `{field:"offset", reason:"out_of_range", max:1000}` | `1000` → 200 |
| API-DIR-017 | SQL/LIKE ใน q | - | `?q=%27%20OR%201%3D1--`, `?q=%25`, `?q=_` | 200 (ส่งต่อเป็นข้อความ) ไม่มี 500 | - |
| API-DIR-018 | สถานีที่ถูก block ไม่แสดง | block station id จากผล 001 (DBL-001) | ค้นซ้ำ | id นั้นหายไป | - |
| API-DIR-019 | host ที่ถูก block ไม่แสดง (รวม subdomain) | block host ของ streamUrl ในผล 001 (DBL-002) | ค้นซ้ำ | ไม่มี stream จาก host นั้นหรือ subdomain | - |
| API-DIR-020 | ไม่ได้ตั้งค่า upstream | ต้องลบ `RADIO_BROWSER_BASE_URL` | - | 503 `DEPENDENCY_UNAVAILABLE` `{dependency:"radio_directory", reason:"not_configured"}` | **ข้าม** |
| API-DIR-021 | upstream ล่มและไม่มี cache | ต้องตัดเน็ต | - | 503 `{dependency:"radio_directory", reason:"unreachable"}` | **ข้าม** |
| API-DIR-022 | ข้อความค้นหาไม่อยู่ใน log | หลัง 001 ด้วย `-H 'X-Request-Id: qa-dir-022-a'` | `ca "$API/v1/admin/logs?requestId=qa-dir-022-a"` | log มี route `/v1/directory/radio` แต่ไม่มีคำว่า `jazz` ในทุก field | - |
| API-DIR-023 | cache | ยิงคำค้นเดิมสองครั้ง | ดูเวลาตอบ | ครั้งที่สองเร็วกว่ามาก | ข้อสังเกตเท่านั้น |

---

## 16. รายการ block ของ directory (`/v1/admin/directory/blocks`)

บทบาท `catalog_editor` หรือ `admin` · body POST `{kind, value, reason}`: `kind` = `station`/`host`; `value` ถูก trim, ตัวเล็ก, ตัด `.` ท้าย แล้วต้องเป็น UUID (station) หรือ hostname ที่มีจุดและ TLD ตัวอักษร (host); `reason` 10..500 หลัง NFC+trim ห้าม U+0000-001F และ U+007F-009F · remove: id `^[1-9]\d{0,17}$`, body `{reason}` 10..500

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-DBL-001 | block สถานี | station id จาก DIR-001 (`$RB_ID`) | `ca -X POST -H "$CT" -d "{\"kind\":\"station\",\"value\":\"$RB_ID\",\"reason\":\"QA block station test\"}" $API/v1/admin/directory/blocks` | 201 `{id, kind:"station", value, reason, createdBy, createdAt}` | audit `directory.block.add` · DIR-018 |
| API-DBL-002 | block host | host จาก DIR-001 | `{"kind":"host","value":"  Stream.Example.COM.  ","reason":"QA block host test"}` (ใช้ host จริงจากผล) | 201 `value` ตัวเล็ก ไม่มีจุดท้าย ไม่มีช่องว่าง | audit `directory.block.add` |
| API-DBL-003 | รายการ | - | `ca $API/v1/admin/directory/blocks` | 200 `{blocks:[...]}` ใหม่→เก่า, no-store | - |
| API-DBL-004 | ซ้ำ | หลัง 001 | POST เดิม | 409 `DIRECTORY_BLOCK_EXISTS` | - |
| API-DBL-005 | ซ้ำหลัง normalize | หลัง 002 | value เดิมแต่ตัวใหญ่ | 409 `DIRECTORY_BLOCK_EXISTS` | - |
| API-DBL-006 | body ไม่ใช่ object | - | `-d '[]'` | 400 `{field:"body", reason:"must_be_object"}` | - |
| API-DBL-007 | field ไม่รู้จัก | - | + `"note":"x"` | 400 `{field:"note", reason:"unknown_field"}` | - |
| API-DBL-008 | kind ผิด | - | `"kind":"url"` | 400 `{field:"kind", reason:"value_not_allowed"}` | - |
| API-DBL-009 | station ไม่ใช่ UUID | - | `{"kind":"station","value":"abc",...}` | 400 `{field:"value", reason:"must_be_uuid"}` | - |
| API-DBL-010 | host ผิด | - | `"localhost"`, `"1.2.3.4"`, `"https://x.org"`, `"a_b.org"`, `"x.org/path"`, `"*.x.org"` | 400 `{field:"value", reason:"must_be_host"}` | - |
| API-DBL-011 | reason สั้น/ยาว/control | - | `"short"`, 501 ตัว, `"QA reason\nnewline"`, ไม่มี reason | 400 `{field:"reason", reason:"length"}` | `"QA reason ‮ bidi"` ผ่าน (ดู SEC) |
| API-DBL-012 | ลูกค้า / ไม่มี token / operator | - | `cn` / `c0` / T1 operator | 403 / 401 / 403 | - |
| API-DBL-013 | ยกเลิก block | id จาก 001 | `ca -X POST -H "$CT" -d '{"reason":"QA unblock station test"}' $API/v1/admin/directory/blocks/$BID/remove` | 204 ไม่มี body | audit `directory.block.remove` · สถานีกลับมาในผลค้น (หลัง cache หมด หรือทันที) |
| API-DBL-014 | ยกเลิกซ้ำ / id ไม่มี | หลัง 013 | ซ้ำ, `/999999999/remove` | 404 `NOT_FOUND` | - |
| API-DBL-015 | id ผิดรูปแบบ | - | `/0/remove`, `/abc/remove`, `/1234567890123456789/remove` | 400 `{field:"id", reason:"must_be_number"}` | - |
| API-DBL-016 | remove reason สั้น | - | `{"reason":"short"}` | 400 `{field:"reason", reason:"length"}` (ต้อง ≥10) | ดู mismatch ข้อ 2 |
| API-DBL-017 | remove key อื่น | - | `{"reason":"QA unblock reason","x":1}` | 400 `{field:"x", reason:"unknown_field"}` | - |
| API-DBL-018 | ค้น audit ของ block | หลัง 001 | `ca "$API/v1/admin/audit?action=directory.block.add"` | 400 `{field:"action", reason:"invalid"}` (pattern รับสูงสุด 2 ส่วน) · `?action=directory` → 200 เห็นทั้ง add/remove | ดู mismatch ข้อ 3 |
| API-DBL-019 | เก็บกวาด | จบ | remove ทุก block ที่สร้าง | 204 | - |

---

## 17. Sync รายการโปรด (`POST /v1/sync/push`, `GET /v1/sync/pull`, `GET /v1/me/favorites`)

ต้องใช้ token ลูกค้า · body push ≤64 KiB: `{deviceId?, changes:[1..100]}` · แต่ละ change: `changeId` (UUID ทุกเวอร์ชัน), `entityId` (UUID), `type:"favorite"`, `op` = `upsert`/`delete`/`restore`, `baseRevision` (int ≥0; 0 = สร้างใหม่; delete/restore ห้าม 0), `value` (`{stationId (UUID), order (int 0..9999)}`; delete ต้องเป็น null หรือไม่ส่ง)
ผลต่อ change: `applied {revision}` · `conflict {reason, current}` (`exists`, `not_found`, `revision_mismatch`, `deleted`, `not_deleted`, `station_already_favorite` + `existingEntityId`) · `rejected {reason}` (`unknown_station`, `change_id_reused`)
`stationId` ต้องเป็นสถานีที่อยู่ใน catalog สาธารณะ (`$PUB` = id จาก API-CAT-001)

```sh
E1=$(uuid); push() { cn -X POST -H "$CT" -d "$1" $API/v1/sync/push; }
```

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-SYN-001 | เพิ่มรายการโปรด | `$PUB`, `DEV_NA` | `push "{\"deviceId\":\"$DEV_NA\",\"changes\":[{\"changeId\":\"$(uuid)\",\"entityId\":\"$E1\",\"type\":\"favorite\",\"op\":\"upsert\",\"baseRevision\":0,\"value\":{\"stationId\":\"$PUB\",\"order\":0}}]}"` | 200 `{results:[{changeId, entityId:E1, status:"applied", revision:1}]}`, no-store | `GET /v1/me/favorites` มี E1 · `GET /v1/me/devices` → `lastSyncedAt` ของ DEV_NA มีค่า |
| API-SYN-002 | replay changeId เดิม body เดิม | ใช้ body เดียวกับ 001 (เก็บ changeId) | ส่งซ้ำ | 200 ผลเดิม `applied revision:1` | revision ไม่เพิ่ม |
| API-SYN-003 | changeId เดิม เนื้อหาต่าง | - | changeId จาก 001, `order:5` | `status:"rejected", reason:"change_id_reused"` | - |
| API-SYN-004 | สร้างซ้ำ entity เดิม | - | changeId ใหม่, E1, base 0 | `conflict` `exists` `current.revision:1` | - |
| API-SYN-005 | upsert revision ถูก | - | E1 base 1 `order:3` | `applied revision:2` | - |
| API-SYN-006 | upsert revision เก่า | - | E1 base 1 | `conflict` `revision_mismatch` | - |
| API-SYN-007 | entity ไม่มี | - | entity ใหม่ base 1 | `conflict` `not_found` `current:null` | - |
| API-SYN-008 | สถานีเดียวกันสองรายการ | E1 ชี้ `$PUB` | entity ใหม่ base 0 stationId `$PUB` | `conflict` `station_already_favorite` `existingEntityId:E1` | - |
| API-SYN-009 | สถานีไม่มี / ไม่ publish / disabled | - | stationId `$(uuid)` หรือ `$STN` ที่ disabled | `rejected` `unknown_station` | - |
| API-SYN-010 | ลบ | E1 rev 2 | `{"op":"delete","baseRevision":2}` (ไม่มี value) | `applied revision:3` | favorites ไม่มี E1 · pull มี `deleted:true` |
| API-SYN-011 | ลบซ้ำ | rev 3 | delete base 3 | `conflict` `deleted` | - |
| API-SYN-012 | restore | rev 3 | `{"op":"restore","baseRevision":3,"value":{"stationId":"$PUB","order":0}}` | `applied revision:4` | กลับมาใน favorites |
| API-SYN-013 | restore ตัวที่ไม่ได้ลบ | rev 4 | restore base 4 | `conflict` `not_deleted` | - |
| API-SYN-014 | ลำดับใน request เดียว | - | 3 changes ต่อกัน (create, upsert base 1, delete base 2) ใน entity ใหม่ | ทั้งสาม `applied` revision 1, 2, 3 | - |
| API-SYN-015 | body ไม่ใช่ object | - | `-d '[]'` | 400 `{field:"body", reason:"must_be_object"}` | - |
| API-SYN-016 | key ระดับบนไม่รู้จัก | - | `{"changes":[...],"since":1}` | 400 `{field:"since", reason:"unknown_field"}` | - |
| API-SYN-017 | changes ว่าง/ไม่ใช่ array | - | `{"changes":[]}`, `{"changes":{}}`, ไม่มี changes | 400 `{field:"changes", reason:"must_be_non_empty_array"}` | - |
| API-SYN-018 | 101 changes | - | 101 รายการ (สร้างด้วย jq) | 400 `{field:"changes", reason:"too_many"}` | - |
| API-SYN-019 | change ไม่ใช่ object | - | `{"changes":[1]}` | 400 `{field:"changes[0]", reason:"must_be_object"}` | - |
| API-SYN-020 | key ไม่รู้จักใน change | - | + `"clientTime":1` | 400 `{field:"changes[0].clientTime", reason:"unknown_field"}` | - |
| API-SYN-021 | changeId/entityId ไม่ใช่ UUID | - | `"changeId":"1"` | 400 `{field:"changes[0].changeId", reason:"must_be_uuid"}` | - |
| API-SYN-022 | changeId ซ้ำใน request | - | 2 changes changeId เดียวกัน | 400 `{field:"changes[1].changeId", reason:"duplicate_in_request"}` | ไม่มี change ใดถูก apply |
| API-SYN-023 | type ผิด | - | `"type":"playlist"` | 400 `{field:"changes[0].type", reason:"unsupported"}` | - |
| API-SYN-024 | op ผิด | - | `"op":"insert"` | 400 `changes[0].op` `unsupported` | - |
| API-SYN-025 | baseRevision ผิด | - | `-1`, `1.5`, `"1"` | 400 `changes[0].baseRevision` `must_be_non_negative_integer` | - |
| API-SYN-026 | delete/restore base 0 | - | delete base 0 | 400 `changes[0].baseRevision` `must_name_current_revision` | - |
| API-SYN-027 | delete มี value | - | delete + value | 400 `changes[0].value` `not_allowed_on_delete` | - |
| API-SYN-028 | value ผิด | - | value `null` บน upsert, `{"stationId":"x","order":0}`, `order:10000`, `order:-1`, `{"stationId":..,"order":0,"name":"x"}` | 400 `changes[0].value` `must_be_object` / `changes[0].value.stationId` `must_be_uuid` / `.order` `out_of_range` / `.name` `unknown_field` | - |
| API-SYN-029 | deviceId ผิด/ของคนอื่น/ถูก revoke | - | `"deviceId":"x"` / deviceId ของ T1 / `DEV_PH` (token อื่นของเจ้าของ) | 400 `deviceId` `must_be_uuid` / 404 `{field:"deviceId", reason:"device_not_registered"}` / 403 `DEVICE_REVOKED` | - |
| API-SYN-030 | body > 64 KiB | - | 65 KiB | 413 `PAYLOAD_TOO_LARGE` | - |
| API-SYN-031 | ไม่มี token | - | `c0 -X POST ...` | 401 | - |
| API-SYN-040 | pull ทั้งหมด | หลัง 001-014 | `cn $API/v1/sync/pull` | 200 `{changes:[{entityId, type, revision, value, deleted, updatedAt}], cursor, hasMore}`, no-store | - |
| API-SYN-041 | pull ต่อจาก cursor | cursor จาก 040 | `?cursor=$C` | 200 `changes:[]` ถ้าไม่มีอะไรใหม่, cursor เดิม | - |
| API-SYN-042 | pagination | > 2 changes | `?limit=1` วนตาม cursor จน `hasMore:false` | ครบไม่ซ้ำ | - |
| API-SYN-043 | limit ผิด | - | `0`, `101`, `abc`, `1.5` | 400 `{field:"limit", reason:"out_of_range"}` | - |
| API-SYN-044 | limit ที่ Number() รับ | - | `?limit=1e1`, `?limit=0x10`, `?limit=%205` | 200 (รับเป็น 10, 16, 5) | ดู mismatch ข้อ 4 |
| API-SYN-045 | cursor ผิด | - | `?cursor=abc`, `?cursor=$(printf x1 \| base64)`, 33 ตัว | 400 `{field:"cursor", reason:"malformed"}` | - |
| API-SYN-046 | query ไม่รู้จัก | - | `?since=1` | 400 `{field:"since", reason:"unknown_field"}` | - |
| API-SYN-047 | deviceId ใน pull | - | `?deviceId=$DEV_NA` / ของคนอื่น / `x` | 200 / 404 `device_not_registered` / 400 `must_be_uuid` | - |
| API-SYN-048 | cursor เก่ากว่า horizon ที่ถูกล้าง | ต้องมี tombstone ที่ถูก purge | - | 410 `SYNC_RESET_REQUIRED` | BLOCKED ถ้าไม่มี purge |
| API-SYN-049 | ข้อมูลแยกตามบัญชี | - | `ct1 $API/v1/sync/pull` | ไม่มี entity ของ tar-noaccess | - |
| API-SYN-050 | รายการโปรด | หลัง 012 | `cn $API/v1/me/favorites` | 200 `{favorites:[{entityId, revision, stationId, order, updatedAt}]}` เฉพาะที่ยังไม่ลบ เรียงตาม order | - |
| API-SYN-051 | favorites ไม่มี token | - | `c0 $API/v1/me/favorites` | 401 | - |

---

## 18. Billing (`GET /v1/me/entitlements`, `POST /v1/billing/verify`, `POST /v1/webhooks/{apple,google}`)

บนเครื่อง Tar ไม่มีการตั้งค่า Apple/Google: verify ที่ผ่าน validation → 503 `DEPENDENCY_UNAVAILABLE`; webhook ทุกตัว → 401 `AUTH_REQUIRED` ก่อนตรวจ body · flow ที่ต้องมี store จริงให้บันทึก **BLOCKED (needs store sandbox)**
body verify (≤64 KiB): Apple `{store:"apple", signedTransaction}` (JWS 3 ส่วน base64url, ≤32768 ตัว) · Google `{store:"google", productId (^[A-Za-z0-9._]{1,100}$), purchaseToken (^[A-Za-z0-9._:-]{10,4096}$)}`

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-BIL-001 | entitlements ไม่มีการซื้อ | `TOKEN_NA` | `cn $API/v1/me/entitlements` | 200 `{pro:{apple:"none", google:"none"}, purchases:[]}`, no-store | - |
| API-BIL-002 | entitlements ไม่มี token | - | `c0 $API/v1/me/entitlements` | 401 | - |
| API-BIL-003 | verify ไม่มี token | - | `c0 -X POST -H "$CT" -d '{"store":"apple","signedTransaction":"a.b.c"}' $API/v1/billing/verify` | 401 `AUTH_REQUIRED` | - |
| API-BIL-004 | body ไม่ใช่ object | - | `cn -X POST -H "$CT" -d '[]' $API/v1/billing/verify` | 400 `{field:"body", reason:"must_be_object"}` | - |
| API-BIL-005 | store ไม่รองรับ | - | `{"store":"amazon"}`, `{}` , `{"store":"Apple"}` | 400 `{field:"store", reason:"unsupported"}` | - |
| API-BIL-006 | Apple field ไม่รู้จัก | - | `{"store":"apple","signedTransaction":"a.b.c","productId":"x"}` | 400 `{field:"productId", reason:"unknown_field"}` | - |
| API-BIL-007 | Apple JWS ผิด | - | `"signedTransaction":"abc"`, `"a.b"`, `"a.b.c.d"`, `"a.b.c="`, 32769 ตัว, `123` | 400 `{field:"signedTransaction", reason:"must_be_jws"}` | - |
| API-BIL-008 | Apple รูปแบบถูก | - | `{"store":"apple","signedTransaction":"eyJhbGciOiJFUzI1NiJ9.e30.c2ln"}` | 503 `DEPENDENCY_UNAVAILABLE` (ไม่ได้ตั้งค่า Apple) | ไม่มีแถว purchase |
| API-BIL-009 | Google field ไม่รู้จัก | - | `{"store":"google","productId":"pro.monthly","purchaseToken":"abcdefghij","orderId":"x"}` | 400 `{field:"orderId", reason:"unknown_field"}` | - |
| API-BIL-010 | Google productId ผิด | - | `"productId":""`, `"pro-monthly"`, `"pro monthly"`, 101 ตัว | 400 `{field:"productId", reason:"invalid"}` | - |
| API-BIL-011 | Google purchaseToken ผิด | - | 9 ตัว, 4097 ตัว, มี `/` หรือ `=` | 400 `{field:"purchaseToken", reason:"invalid"}` | - |
| API-BIL-012 | Google รูปแบบถูก | - | `{"store":"google","productId":"pro.monthly","purchaseToken":"abcdefghij"}` | 503 `DEPENDENCY_UNAVAILABLE` | - |
| API-BIL-013 | body > 64 KiB | - | 65 KiB | 413 `PAYLOAD_TOO_LARGE` | - |
| API-BIL-014 | webhook Apple ไม่ได้ตั้งค่า | - | `c0 -X POST -H "$CT" -d '{"signedPayload":"a.b.c"}' $API/v1/webhooks/apple` | 401 `AUTH_REQUIRED` (ก่อนตรวจ body) | log `STORE_WEBHOOK_NOT_CONFIGURED` |
| API-BIL-015 | webhook Apple body ผิด | - | `-d '[]'` | 401 `AUTH_REQUIRED` (ยังไม่ถึง validation) | - |
| API-BIL-016 | webhook Google ไม่ได้ตั้งค่า | - | `c0 -X POST -H "$CT" -H 'Authorization: Bearer x' -d '{"message":{}}' $API/v1/webhooks/google` | 401 `AUTH_REQUIRED` | - |
| API-BIL-017 | webhook มี limit สูงกว่า route สาธารณะอื่น | - | 5 ครั้งติด | ทุกครั้ง 401 ไม่มี 429 (limit ของ `/v1/webhooks/*` = 600 ครั้ง/นาที/IP, 10 เท่าของ catalog ห้ามยิงให้ถึง) | - |
| API-BIL-020 | Apple verify สำเร็จ | **needs store sandbox** | JWS จาก StoreKit sandbox | 200 `{store:"apple", productId, state:"verified", environment:"sandbox", purchasedAt, verifiedAt, revokedAt:null}` | audit `purchase.verified` · entitlements `pro.apple:"verified"` |
| API-BIL-021 | Apple ลายเซ็นผิด | **needs store sandbox** | JWS แก้ไข | 400 `PURCHASE_INVALID` `{reason:"signature"}` | - |
| API-BIL-022 | Apple bundle/product/environment ผิด | **needs store sandbox** | - | 400 `PURCHASE_INVALID` reason `wrong_app` / `unknown_product` / `environment` / `malformed` | - |
| API-BIL-023 | Google verify สำเร็จ / pending | **needs store sandbox** | - | 200 `state:"verified"` หรือ `"pending"` | audit `purchase.verified` / `purchase.pending` |
| API-BIL-024 | Google token ไม่รู้จัก/ยกเลิก | **needs store sandbox** | - | 400 `PURCHASE_INVALID` `unknown_purchase` / `cancelled` / `unknown_product` | - |
| API-BIL-025 | การซื้อผูกกับบัญชีอื่น | **needs store sandbox** | - | 400 `PURCHASE_INVALID` `account_unbound` / `account_mismatch` หรือ 409 `PURCHASE_CONFLICT` | - |
| API-BIL-026 | verify ซ้ำ idempotent | **needs store sandbox** | ส่งหลักฐานเดิมสองครั้ง | 200 ทั้งคู่ ไม่มีแถวซ้ำ | - |
| API-BIL-027 | Apple REFUND/REVOKE | **needs store sandbox** | notification ที่เซ็นแล้ว | 200 `{ok:true}` | audit `purchase.revoked` · entitlements `revoked` |
| API-BIL-028 | Apple REFUND_REVERSED | **needs store sandbox** | - | 200 | audit `purchase.restored` |
| API-BIL-029 | Apple notification ลายเซ็นผิด | **needs store sandbox** | - | 401 `AUTH_REQUIRED` | - |
| API-BIL-030 | Apple notification ซ้ำ (notificationUUID เดิม) | **needs store sandbox** | - | 200 ไม่ทำซ้ำ | - |
| API-BIL-031 | Google Pub/Sub ที่ OIDC ถูก | **needs store sandbox** | - | 204 | - |
| API-BIL-032 | Google message ผิด | **needs store sandbox** | `{"message":{}}` ด้วย token ถูก | 400 `{field:"message", reason:"malformed"}` / `message.data` `malformed` | - |

---

## 19. Diagnostics (`POST /v1/diagnostics/batches`, `/v1/me/diagnostics`)

ต้องใช้ token · body ≤128 KiB: `{batchId (UUID v1-8), deviceId (UUID v1-8 ของอุปกรณ์ตัวเองที่ active), consent:true, events:[1..100]}` · event: `eventId` (UUID), `eventName` (`import_completed`, `import_failed`, `playback_start_result`, `playback_stall`, `playback_recovered`, `app_error`, `purchase_result`, `carplay_session_result`), `schemaVersion:1`, `monotonicMs` (safe int ≥0), `sessionRandomId` (`^[A-Za-z0-9_-]{8,64}$`), `durationMs?` (null หรือ 0..86400000), `resultCode?` (null หรือ `^[A-Z][A-Z0-9_]{1,47}$`), `networkClass` (`wifi`/`cellular`/`offline`), `appBuild` (`^[0-9A-Za-z.+-]{1,32}$`), `osMajor` (0..99), `deviceClass` (`phone`/`tablet`) · เก็บ 7 วัน · ≤10 batch ต่อนาทีต่ออุปกรณ์

```sh
ev() { printf '{"eventId":"%s","eventName":"playback_stall","schemaVersion":1,"monotonicMs":1200,"sessionRandomId":"qaSess0001","durationMs":350,"resultCode":"MEDIA_STALLED","networkClass":"wifi","appBuild":"1.4.0","osMajor":17,"deviceClass":"phone"}' "$(uuid)"; }
BATCH="{\"batchId\":\"$(uuid)\",\"deviceId\":\"$DEV_NA\",\"consent\":true,\"events\":[$(ev),$(ev)]}"
```

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-DIA-001 | ส่ง batch | `DEV_NA` active | `cn -X POST -H "$CT" -d "$BATCH" $API/v1/diagnostics/batches` | 200 `{reportId, accepted:2, duplicates:0}`, no-store | เก็บ `RPT` · `GET /v1/me/diagnostics` มีรายงาน |
| API-DIA-002 | batchId ซ้ำ | หลัง 001 | ส่ง `$BATCH` เดิม | 200 `{reportId (เดิม), accepted:0, duplicates:2}` | ไม่มีรายงานใหม่ |
| API-DIA-003 | ไม่มี token | - | `c0 -X POST ...` | 401 | - |
| API-DIA-004 | body ไม่ใช่ object | - | `-d '[]'` | 400 `reason: body_must_be_object` | - |
| API-DIA-005 | key ไม่รู้จัก | - | + `"userEmail":"a@b.c"` | 400 `{field:"userEmail", reason:"unknown_field"}` | - |
| API-DIA-006 | ไม่ยินยอม | - | `"consent":false`, `"consent":"true"`, ไม่มี consent | 400 `{field:"consent", reason:"consent_required"}` | - |
| API-DIA-007 | batchId/deviceId ผิด | - | `"batchId":"x"`, `"deviceId":"x"` | 400 `batchId` / `deviceId` `must_be_uuid` | - |
| API-DIA-008 | events ว่าง/ไม่ใช่ array | - | `[]`, `{}` | 400 `{field:"events", reason:"must_be_non_empty_array"}` | - |
| API-DIA-009 | 101 events | - | 101 รายการ | 400 `{field:"events", reason:"too_many"}` | - |
| API-DIA-010 | eventId ซ้ำ | - | 2 events eventId เดียวกัน | 400 `{field:"events", reason:"duplicate_event_id"}` | - |
| API-DIA-011 | event ไม่ใช่ object | - | `"events":[1]` | 400 `{field:"events[0]", reason:"must_be_object"}` | - |
| API-DIA-012 | event key ไม่รู้จัก | - | + `"message":"free text"` | 400 `{field:"events[0].message", reason:"unknown_field"}` | ห้ามรับข้อความอิสระ |
| API-DIA-013 | eventName ผิด | - | `"crash"` | 400 `events[0].eventName` `value_not_allowed` | - |
| API-DIA-014 | schemaVersion ผิด | - | `2`, `"1"` | 400 `events[0].schemaVersion` `unsupported` | - |
| API-DIA-015 | monotonicMs ผิด | - | `-1`, `1.5`, `9007199254740992` | 400 `events[0].monotonicMs` `out_of_range` | - |
| API-DIA-016 | sessionRandomId ผิด | - | `"short"`, 65 ตัว, `"a b c d e f"` | 400 `events[0].sessionRandomId` `malformed` | - |
| API-DIA-017 | durationMs ผิด | - | `-1`, `86400001`, `1.5` | 400 `events[0].durationMs` `out_of_range` | `null` และไม่ส่ง → 200 |
| API-DIA-018 | resultCode ผิด | - | `"media_stalled"`, `"A"`, `"1ERR"`, 49 ตัว, `"ERR; DROP TABLE"` | 400 `events[0].resultCode` `malformed` | - |
| API-DIA-019 | networkClass/deviceClass ผิด | - | `"5g"`, `"watch"` | 400 `value_not_allowed` | - |
| API-DIA-020 | appBuild/osMajor ผิด | - | `"1 0"`, `100` | 400 `malformed` / `out_of_range` | - |
| API-DIA-021 | อุปกรณ์ของคนอื่น | `deviceId` ของ T1 | ส่งด้วย `cn` | 404 `{field:"deviceId", reason:"device_not_registered"}` | - |
| API-DIA-022 | อุปกรณ์ถูก revoke | `DEV_PH` revoked, token อื่นของเจ้าของ | ส่ง | 403 `DEVICE_REVOKED` | - |
| API-DIA-023 | body > 128 KiB | - | events ใหญ่จน > 128 KiB (100 events ไม่ถึง ให้เติม key ใหญ่ที่ระดับบน) | 413 `PAYLOAD_TOO_LARGE` | - |
| API-DIA-024 | 11 batch ต่อนาทีต่ออุปกรณ์ | อุปกรณ์ใหม่ `DEV_D` ของ tar-noaccess | ส่ง batch ใหม่ (batchId ใหม่) 11 ครั้งในนาทีเดียว | ครั้งที่ 11 → 429 `API_RATE_LIMITED` `{retryAfterSeconds:60, scope:"device_batches"}` + `Retry-After: 60` | ใช้ 11 writes |
| API-DIA-025 | batchId เดียวกันจากสองอุปกรณ์พร้อมกัน | tar-noaccess มีอุปกรณ์ active สองเครื่อง `DEV_A`, `DEV_B` · `BID=$(uuid)`; `BA="{\"batchId\":\"$BID\",\"deviceId\":\"$DEV_A\",\"consent\":true,\"events\":[$(ev)]}"`; `BB` เหมือนกันแต่ `deviceId` = `DEV_B` และ `$(ev)` ใหม่ | `cn -X POST -H "$CT" -d "$BA" $API/v1/diagnostics/batches & cn -X POST -H "$CT" -d "$BB" $API/v1/diagnostics/batches & wait` | ทั้งคู่ 200 (ไม่มี 500) · ตัวหนึ่ง `{reportId:R, accepted:1, duplicates:0}` อีกตัว `{reportId:R (เดียวกัน), accepted:0, duplicates:1}` | `GET /v1/me/diagnostics` มีรายงาน R เพียงรายงานเดียว · ทำซ้ำได้ 3 รอบด้วย BID ใหม่เพื่อให้ชนกันจริง (6 writes) |
| API-DIA-026 | batchId เดิมจากอุปกรณ์อื่นแบบต่อกัน | หลัง 025 | ส่ง `BID` อีกครั้งจาก `DEV_B` | 200 `{reportId:R, accepted:0, duplicates:n}` | batchId ไม่ซ้ำกันได้ภายในผู้ใช้เดียวกัน |
| API-DIA-030 | รายการรายงาน | หลัง 001 | `cn $API/v1/me/diagnostics` | 200 `{reports:[{id, receivedAt, expiresAt (= receivedAt + 7 วัน), deviceId, platform, eventCount, events}], nextCursor, retentionDays:7}` | - |
| API-DIA-031 | pagination | > 1 รายงาน | `?limit=1` ตาม cursor | ไม่ซ้ำ | - |
| API-DIA-032 | limit/cursor ผิด | - | `limit=0`, `cursor=bad!` | 400 | - |
| API-DIA-033 | อ่านรายงาน | `RPT` | `cn $API/v1/me/diagnostics/$RPT` | 200 summary + `items:[{eventId, eventName, schemaVersion, monotonicMs, sessionRandomId, durationMs, resultCode, networkClass, appBuild, osMajor, deviceClass}]` | - |
| API-DIA-034 | id ผิด | - | `/v1/me/diagnostics/abc` | 400 `{field:"id", reason:"must_be_uuid"}` | - |
| API-DIA-035 | id ไม่มี / ของคนอื่น (IDOR) | `RPT` ของ tar-noaccess | `ca $API/v1/me/diagnostics/$RPT`, `ca -X DELETE ...` | 404 ทั้งคู่ | รายงานของ tar-noaccess ยังอยู่ |
| API-DIA-036 | ลบรายงาน | `RPT` | `cn -X DELETE $API/v1/me/diagnostics/$RPT` | 204 | GET → 404 |
| API-DIA-037 | ลบซ้ำ | หลัง 036 | ซ้ำ | 404 | - |
| API-DIA-038 | ไม่มี token | - | `c0 $API/v1/me/diagnostics` | 401 | - |

---

## 20. Support access (`/v1/me/support-access/**`, `/v1/admin/users/{userId}/diagnostics/**`)

ฝั่งลูกค้า: ต้องใช้ token · code อายุ 60 นาที ใช้ได้ครั้งเดียว รูปแบบ `XXXX-XXXX` จากตัวอักษร `ABCDEFGHJKMNPQRSTVWXYZ23456789` · access อายุ 7 วัน · `POST codes` **ไม่สนใจ** Idempotency-Key
ฝั่ง staff: `support` หรือ `admin` + session MFA · body `{code, reason}` ลำดับตรวจ: reason (10..500 หลัง trim, ห้าม U+0000-001F และ U+007F) → userId (ไม่ใช่ UUID = 404) → code (ไม่สนตัวพิมพ์, ตัด `-` และช่องว่าง, ต้องได้ 8 ตัวจากชุดตัวอักษร)

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-SUP-001 | ดูสถานะ | `TOKEN_NA` | `cn $API/v1/me/support-access` | 200 `{grants:[], codeMinutes:60, accessDays:7}`, no-store | - |
| API-SUP-002 | สร้าง code | - | `cn -X POST $API/v1/me/support-access/codes` | 201 `{code:"XXXX-XXXX", expiresAt (+60 นาที)}`, no-store | เก็บ `SCODE` (ความลับ) · audit `support.code_created` |
| API-SUP-003 | code ใหม่แทนที่ code เดิมที่ยังไม่ใช้ | หลัง 002 | สร้างอีกครั้ง (`SCODE2`) | 201 code ใหม่ | redeem `SCODE` (เก่า) → 404 |
| API-SUP-004 | ไม่สนใจ Idempotency-Key | - | POST codes ด้วย `-H 'Idempotency-Key: qa-sup-004-aaaa'` สองครั้ง และ key `bad` | ได้ 201 code ต่างกันทุกครั้ง ไม่มี `Idempotent-Replayed` ไม่มี 400 | ดู mismatch ข้อ 1 |
| API-SUP-005 | ไม่มี token | - | `c0 -X POST $API/v1/me/support-access/codes` | 401 | - |
| API-SUP-010 | staff ใช้ code | `SCODE2`, `UID_NA`, `TOKEN` | `ca -X POST -H "$CT" -d "{\"code\":\"$SCODE2\",\"reason\":\"QA support ticket 123\"}" $API/v1/admin/users/$UID_NA/diagnostics/access` | 201 `{id, grantedAt, expiresAt (+7 วัน)}` | audit `support.access_granted` (reason, changes `{grantId, expiresAt}`) · `cn GET /v1/me/support-access` → grants มีรายการ |
| API-SUP-011 | code ตัวเล็ก/ไม่มีขีด/มีช่องว่าง | code ใหม่ | `"abcd efgh"` รูปแบบของ code จริง | 201 | - |
| API-SUP-012 | code ใช้แล้ว | หลัง 010 | ใช้ `SCODE2` ซ้ำ | 404 `NOT_FOUND` | audit `support.access_refused` |
| API-SUP-013 | code ผิด (ถูกรูปแบบ) | - | `"ABCD-EFGH"` | 404 | audit `support.access_refused` |
| API-SUP-014 | code ของลูกค้าอื่น | code ของ T1 | ใช้กับ `UID_NA` | 404 | audit `support.access_refused` · code ของ T1 ยังใช้ได้กับ T1 |
| API-SUP-015 | code ผิดรูปแบบ | - | `"ABC"`, `"ABCD-EFG1"` (`1` ไม่อยู่ในชุด), `"ABCD-EFGI"` (`I`), `12345678` (ตัวเลข), ไม่มี code | 400 `{field:"code", reason:"invalid"}` | - |
| API-SUP-016 | reason ผิด | - | ไม่มี reason, `"short"`, 501 ตัว, `"QA reason\tTAB"` | 400 `reason` `required` / `length` / `length` / `control_characters` | reason ตรวจก่อน userId และ code |
| API-SUP-017 | userId ไม่ใช่ UUID | - | `/v1/admin/users/abc/diagnostics/access` (reason ถูก) | 404 | - |
| API-SUP-018 | ลูกค้า/บทบาทอื่น | `TOKEN_NA`, T1 operator/catalog_editor/auditor | POST access | 403 `ROLE_REQUIRED` | - |
| API-SUP-019 | ไม่ได้ MFA | `TOKEN_PW` | POST access | 401 `MFA_REQUIRED` scope session | - |
| API-SUP-020 | staff อ่าน diagnostics | หลัง 010, tar-noaccess มีรายงาน | `ca $API/v1/admin/users/$UID_NA/diagnostics` | 200 `{access:{id, grantedAt, expiresAt}, retentionDays:7, reports:[... items:[{eventName, monotonicMs, durationMs, resultCode, networkClass, appBuild, osMajor, deviceClass}]]}` ≤20 รายงาน · items **ไม่มี** `eventId`, `sessionRandomId` | audit `support.diagnostics_read` `{grantId, reports}` ทุกครั้ง |
| API-SUP-021 | อ่านโดยไม่มี access | ลูกค้าอื่น (T1) | `ca $API/v1/admin/users/$UID_T1/diagnostics` | 403 `SUPPORT_ACCESS_REQUIRED` | - |
| API-SUP-022 | access เป็นรายคน | staff คนที่สอง (T1 = support) ที่ไม่ได้ redeem | อ่านของ `UID_NA` | 403 `SUPPORT_ACCESS_REQUIRED` | ถ้าไม่มี role ให้ BLOCKED |
| API-SUP-023 | userId ผิด | - | `/v1/admin/users/abc/diagnostics` | 404 | - |
| API-SUP-030 | ลูกค้าถอน access | grant id จาก 010 (`GID`) | `cn -X DELETE $API/v1/me/support-access/$GID` | 204 | audit `support.access_revoked` · staff อ่าน → 403 `SUPPORT_ACCESS_REQUIRED` |
| API-SUP-031 | ถอนซ้ำ | หลัง 030 | ซ้ำ | 404 | - |
| API-SUP-032 | id ผิด/ไม่มี | - | `/abc`, `/$(uuid)` | 404 ทั้งคู่ | - |
| API-SUP-033 | IDOR ถอน grant ของคนอื่น | `GID` ของ tar-noaccess (ยัง active) | `ct1 -X DELETE $API/v1/me/support-access/$GID` | 404 | grant ของ tar-noaccess ยัง active |
| API-SUP-034 | code หมดอายุ | รอ > 60 นาที | redeem | 404 | ถ้าไม่สะดวกให้ BLOCKED |
| API-SUP-035 | code ที่หมดอายุถูกลบหลัง 1 วัน | code ที่หมดอายุเกิน 1 วัน (`expires_at < now() - 1 day`) และรอบล้างรายชั่วโมงของ diagnostics ผ่านไปแล้ว | ตรวจด้วย psql (ต้องได้รับอนุญาตจาก Tar): `SELECT count(*) FROM support_access_codes WHERE expires_at < now() - interval '1 day'` | 0 | ไม่มี API ที่ให้เห็น ถ้าไม่ได้รับอนุญาตหรือไม่มีข้อมูลเก่าพอให้ BLOCKED |
| API-SUP-036 | grant ที่จบแล้วถูกลบหลัง 7 วัน | grant ที่ถอนหรือหมดอายุเกิน 7 วัน | psql (ต้องได้รับอนุญาตจาก Tar) `SELECT count(*) FROM support_access_grants WHERE coalesce(revoked_at, expires_at) < now() - interval '7 days'` | count = 0 · grant (`GET /v1/me/support-access` แสดงเฉพาะ grant ที่ยัง active อยู่แล้ว จึงใช้ยืนยันไม่ได้) · grant ที่ถอนภายใน 7 วันยังอยู่ในตาราง | audit `support.access_granted`/`support.access_revoked` ยังอยู่ (audit ไม่ถูกลบ) · BLOCKED ถ้าไม่มีข้อมูลเก่าพอ |

---

## 21. Audit trail (`GET /v1/admin/audit`, `POST /v1/admin/audit/export`)

บทบาท `auditor` หรือ `admin` + session MFA · export ต้อง MFA สด ≤300 วินาที · query ที่ไม่รู้จักถูกเพิกเฉย
query: `from`/`to` (`^\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d{2}:\d{2})$`, ค่าเริ่มต้น 7 วันล่าสุด, ช่วงไม่เกิน 90 วัน), `limit` (`^\d{1,3}$`, 1..100, ค่าเริ่มต้น 50), `cursor` (`^[A-Za-z0-9_-]{1,120}$`), `actor` (`^[A-Za-z0-9._:@|-]{1,128}$` = OIDC subject หรือ `operator:<ชื่อ>`), `action` (`^[a-z_]{1,40}(\.[a-z_]{1,40})?$`; ไม่มีจุด = ทั้งตระกูล), `targetType` (`^[a-z_]{1,40}$`), `targetId` (`^[A-Za-z0-9._*-]{1,64}$`), `requestId` (`^[A-Za-z0-9._-]{8,64}$`), `includeReads` (`0`/`1`/`true`/`false`) · ค่าผิด → 400 `{field, reason:"invalid"}`
ทุกการค้นเขียน audit `audit.search`; แถว `audit.search` และ `logs.search` ถูกซ่อนเว้นแต่ `includeReads=1`

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-AUD-001 | ค้นค่าเริ่มต้น | `TOKEN` | `ca $API/v1/admin/audit` | 200 `{events:[{id, occurredAt, actor, actorSubject, action, targetLabel, targetType, targetId, reason, changes, requestId}], nextCursor}` ใหม่→เก่า, no-store · ไม่มีแถว `audit.search` | - |
| API-AUD-002 | การค้นถูกบันทึก | หลัง 001 | `ca "$API/v1/admin/audit?action=audit.search&includeReads=1"` | มีแถว `audit.search` ของ 001 `targetId:"*"`, changes มี `from`, `to` | - |
| API-AUD-003 | กรองตาม action ตระกูล | - | `?action=station` | ทุกแถว action ขึ้นต้น `station.` | - |
| API-AUD-004 | กรองตาม action เต็ม | - | `?action=station.create` | เฉพาะ `station.create` | - |
| API-AUD-005 | action 3 ส่วนกรองไม่ได้ | - | `?action=directory.block.add` | 400 `{field:"action", reason:"invalid"}` | mismatch ข้อ 3 |
| API-AUD-006 | กรอง actor (subject) | `sub` ของ tar-test | `?actor=<sub>` | เฉพาะการกระทำของ tar-test | - |
| API-AUD-007 | กรอง actor operator | หลัง CLI-002 | `?actor=operator:qa-gemini` | แถว `staff_role.grant` | - |
| API-AUD-008 | กรอง targetType/targetId/requestId | - | `?targetType=station&targetId=$STN`, `?requestId=qa-stn-020` | ตรงตามที่กรอง | - |
| API-AUD-009 | pagination | - | `?limit=2` ตาม `nextCursor` | ไม่ซ้ำ; หน้าถัดไปบันทึก `audit.search` พร้อม `page:"next"` | - |
| API-AUD-010 | from ≥ to | - | `?from=2026-10-05T00:00:00Z&to=2026-10-04T00:00:00Z` | 400 `{field:"from", reason:"after_to"}` | - |
| API-AUD-011 | ช่วงเกิน 90 วัน | - | `?from=2026-01-01T00:00:00Z&to=2026-10-01T00:00:00Z` | 400 `{field:"from", reason:"window_too_long"}` | - |
| API-AUD-012 | วันที่ผิดรูปแบบ | - | `?from=2026-10-01`, `?to=2026-10-01T00:00:00`, `?from=2026-13-45T00:00:00Z` | 400 `{field, reason:"invalid"}` | - |
| API-AUD-013 | limit ผิด | - | `0`, `101`, `1000`, `abc` | 400 `{field:"limit", reason:"invalid"}` | - |
| API-AUD-014 | cursor ผิด | - | `?cursor=abc` (decode แล้วไม่ใช่ `<เวลา>` คั่นด้วยไปป์ตามด้วย id), `?cursor=$(printf 'x\|1' \| base64)` | 400 `{field:"cursor", reason:"malformed"}` · cursor 121 ตัว หรือมี `=` → `invalid` | - |
| API-AUD-015 | filter ผิดรูปแบบ | - | `actor=a b`, `action=Station`, `targetType=a.b`, `targetId=a/b`, `requestId=short`, `includeReads=yes` | 400 `invalid` ตาม field | - |
| API-AUD-016 | injection ใน filter | - | `?targetId=%27%20OR%201%3D1--` | 400 `invalid` (pattern ไม่ยอม) | - |
| API-AUD-017 | ไม่มี token / ลูกค้า / operator / support / catalog_editor | - | `c0` / `cn` / T1 role อื่น | 401 / 403 `ROLE_REQUIRED` | - |
| API-AUD-018 | auditor อ่านได้ | T1 = auditor + MFA | `ct1 $API/v1/admin/audit` | 200 | revoke หลังจบ |
| API-AUD-020 | export CSV | `TOKEN` สด | `ca -X POST -H "$CT" -d '{"reason":"QA audit export test"}' "$API/v1/admin/audit/export?action=station"` | 200 `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="tunedeck-audit-YYYY-MM-DD.csv"`, no-store · body ขึ้นต้น BOM `EF BB BF`, บรรทัดคั่น CRLF, หัวตาราง `id,occurredAt,actor,actorSubject,action,targetType,targetId,targetLabel,reason,changes,requestId` | audit `audit.export` (reason, changes มี filters และ `rows`) |
| API-AUD-021 | ป้องกัน CSV formula | สถานีชื่อ `=HYPERLINK("http://x","QA")` (สร้างผ่าน STN-020) หรือ reason ขึ้นต้น `@`/`+`/`-` | export `?targetType=station` | cell ขึ้นต้นด้วย `'` เช่น `'=HYPERLINK(...)` | - |
| API-AUD-022 | export reason ผิด | - | ไม่มี reason, `"short"`, 501 ตัว, `"QA reason\u0007"` | 400 `reason` `required` / `length` / `length` / `control_characters` | - |
| API-AUD-023 | export MFA เก่า | `TOKEN_OLD` | export ถูกต้อง | 401 `MFA_REQUIRED` `{maxAgeSeconds:300}` | - |
| API-AUD-024 | filter ผิดตรวจก่อน reason และ MFA | `TOKEN_OLD` | `?limit=0` + body `{}` | 400 `limit` (ไม่ใช่ reason หรือ 401) | - |
| API-AUD-025 | เกิน 10000 แถว | ต้องมี audit > 10000 แถวในช่วง | export 90 วัน | 400 `{field:"from", reason:"too_many_rows"}` | ถ้าแถวไม่พอให้ BLOCKED |
| API-AUD-026 | export ไม่เก็บ idempotency | - | export + `-H 'Idempotency-Key: qa-aud-026-aaaa'` สองครั้ง | ทั้งคู่ 200 CSV ไม่มี `Idempotent-Replayed` (CSV ไม่ถูกเก็บ) | audit `audit.export` 2 แถว |
| API-AUD-027 | ลูกค้า export | - | `cn -X POST ...export` | 403 | - |

---

## 22. Operational logs (`GET /v1/admin/logs`, `POST /v1/admin/logs/export`)

บทบาท `operator` หรือ `admin` + session MFA · export ต้อง MFA สด · เก็บ 14 วัน
query: `from`/`to` (รูปแบบเดียวกับ audit, ค่าเริ่มต้น 1 ชม., ช่วงไม่เกิน 24 ชม.), `severity` (`^[A-Z,]{1,40}$` แต่ละตัว `DEBUG`/`INFO`/`WARN`/`ERROR`), `service` (`api`), `build` (`^[A-Za-z0-9._+-]{1,64}$`), `eventCode` (`^[A-Z][A-Z0-9_]{0,63}$`), `requestId`, `traceId` (`^[0-9a-f]{32}$`), `errorCode` (`^[A-Za-z0-9_.-]{1,64}$`), `status` (`^[1-5]\d\d$`), `limit`, `cursor`

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-LOG-001 | ค้น 1 ชม. ล่าสุด | `TOKEN` | `ca $API/v1/admin/logs` | 200 `{logs:[{id, timestamp, severity, service, environment, build, eventCode, requestId, traceId, method, route, status, durationMs, actorId, errorName, errorCode}], nextCursor, retentionDays:14}` | audit `logs.search` |
| API-LOG-002 | หาด้วย requestId | ยิง `ca -H 'X-Request-Id: qa-log-002-x' $API/v1/me` ก่อน | `?requestId=qa-log-002-x` | 1 แถว `eventCode:"HTTP_REQUEST"`, `route:"/v1/me"`, `status:200`, `actorId` = internal user id (ไม่ใช่ email/sub) | - |
| API-LOG-003 | route เป็น template ไม่มี query/id จริง | ยิง `cn "$API/v1/me/devices/$DEV_NA/preferences?x=secret"` ด้วย requestId | ค้นด้วย requestId | `route` = `/v1/me/devices/:deviceId/preferences` (template) ไม่มี `secret` ไม่มี device id | - |
| API-LOG-004 | traceparent ถูกเชื่อม | ยิงด้วย `-H 'traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'` | `?traceId=0af7651916cd43dd8448eb211c80319c` | พบแถวนั้น | response มี `traceparent` ที่ trace id เดียวกัน |
| API-LOG-005 | traceparent ผิดเริ่ม trace ใหม่ | `ff-...`, trace id ศูนย์ล้วน, ตัวพิมพ์ใหญ่ | ยิงแล้วค้นด้วย requestId | `traceId` ไม่ใช่ค่าที่ส่ง | - |
| API-LOG-006 | กรอง severity/status/errorCode | - | `?severity=WARN,ERROR`, `?status=404`, `?errorCode=NOT_FOUND` | ตรงตามกรอง | - |
| API-LOG-007 | health ไม่ถูกเก็บ | ยิง `/health/live` ด้วย requestId | ค้น requestId | 0 แถว | - |
| API-LOG-008 | ช่วงเกิน 24 ชม. | - | `from` ห่าง `to` 25 ชม. | 400 `{field:"from", reason:"window_too_long"}` | - |
| API-LOG-009 | from ≥ to | - | - | 400 `after_to` | - |
| API-LOG-010 | severity ผิด | - | `severity=FATAL`, `severity=warn`, `severity=WARN;ERROR` | 400 `{field:"severity", reason:"invalid"}` | - |
| API-LOG-011 | service ผิด | - | `service=worker` | 400 `{field:"service", reason:"invalid"}` | - |
| API-LOG-012 | filter อื่นผิด | - | `traceId=XYZ`, `eventCode=http_request`, `status=600`, `status=20`, `build=a b`, `errorCode=a/b`, `limit=0`, `cursor=abc` | 400 ตาม field (`invalid` หรือ cursor `malformed`) | - |
| API-LOG-013 | pagination | - | `?limit=2` ตาม cursor | ไม่ซ้ำ | - |
| API-LOG-014 | สิทธิ์ | - | `c0`, `cn`, T1 auditor/support/catalog_editor, `cpw` | 401 / 403 / 403 / 401 `MFA_REQUIRED` scope session | - |
| API-LOG-015 | log ไม่มีความลับ | หลังทำ case อื่นทั้งหมด | export 24 ชม. ล่าสุด (LOG-020) แล้วค้นในไฟล์ | ไม่มี `Bearer`, `eyJ` (JWT), อีเมล, คำค้น directory, support code, deletion ticket, export path, query string | ดู SEC-040 |
| API-LOG-020 | export CSV | `TOKEN` สด | `ca -X POST -H "$CT" -d '{"reason":"QA logs export test"}' "$API/v1/admin/logs/export"` | 200 `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="tunedeck-logs-YYYY-MM-DD.csv"` | audit `logs.export` |
| API-LOG-021 | export reason ผิด / MFA เก่า | - | `{"reason":"short"}` / `TOKEN_OLD` | 400 `reason` `length` / 401 `MFA_REQUIRED` `{maxAgeSeconds:300}` | - |
| API-LOG-022 | export เกิน 10000 แถว | ต้องมี log > 10000 ใน 24 ชม. | - | 400 `{field:"from", reason:"too_many_rows"}` | ห้ามสร้าง traffic เพื่อให้ถึง ถ้าไม่ถึงให้ BLOCKED |
| API-LOG-023 | query เกิน 5 วินาทีตอบ 503 และ log แยก | **ต้องได้รับอนุญาตจาก Tar** · terminal 1 ล็อกตาราง: `docker compose -f infra/compose/compose.yaml exec postgres psql -U tunedeck -d tunedeck -c "BEGIN; LOCK TABLE app_config_draft IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(15); ROLLBACK;"` | terminal 2 ภายใน 15 วินาที: `ca -H 'X-Request-Id: qa-log-023-a' $API/v1/admin/config` | ประมาณ 5 วินาทีแล้วได้ 503 `DEPENDENCY_UNAVAILABLE` (body เป็น envelope ปกติ ไม่มี SQL) | `ca "$API/v1/admin/logs?requestId=qa-log-023-a"` → มีแถว `severity:"WARN"`, `eventCode:"DB_QUERY_TIMEOUT"`, `method:"GET"`, `route:"/v1/admin/config"`, `errorCode:"57014"` และ **ไม่มี** `UNHANDLED_ERROR` · ล็อกหายเองเมื่อ pg_sleep จบ |
| API-LOG-024 | ค้น timeout ด้วย eventCode | หลัง 023 | `ca "$API/v1/admin/logs?eventCode=DB_QUERY_TIMEOUT"` และ `?severity=ERROR` | แถวจาก 023 อยู่ในผลแรก ไม่อยู่ในผล `ERROR` | - |

---

## 23. Background jobs (`GET /v1/admin/jobs`, `POST /v1/admin/jobs/{id}/retry`)

บทบาท `operator` หรือ `admin` + session MFA · ชนิดงาน: `account_deletion` (id = hex 64), `account_export` (id = `ex_<uuid>`), `idp_session_end` (id = `se_<hex64>`) · retry body `{reason}` (10..500, ตรวจก่อน id) · รอ 60 วินาทีหลังความพยายามล่าสุด · ไม่เกิน 3 ครั้งต่องานใน 24 ชม.

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-JOB-001 | รายการงานที่เปิดอยู่ | `TOKEN` | `ca $API/v1/admin/jobs` | 200 `{jobs:[{id, kind, status, requestedAt, attempts, maxAttempts, lastAttemptAt, nextAttemptAt, lastErrorCode, completedAt, deadline}], counts, queues:[{kind, pending, retrying, deadLetter, oldestOpenAt}], truncated}`, no-store · `jobs` ≤100 | id ไม่มี user id หรือ ticket |
| API-JOB-002 | กรอง status | - | `?status=open`, `failed`, `dead_letter`, `completed`, `all` | 200 | `completed` เห็นงาน export (EXP-010) และ se_ (DEV-040) |
| API-JOB-003 | status ผิด | - | `?status=done`, `?status=OPEN` | 400 `{field:"status", reason:"invalid"}` | - |
| API-JOB-004 | retry งานที่เสร็จแล้ว | id `ex_...` ที่ completed | `ca -X POST -H "$CT" -d '{"reason":"QA retry completed job"}' $API/v1/admin/jobs/ex_$EXP/retry` | 200 `{status:"completed"}` | **ไม่มี** audit `job.retry` · response ไม่มี `Cache-Control: no-store` (ดู SEC-031) |
| API-JOB-005 | id ผิดรูปแบบ | - | `/jobs/abc/retry`, `/jobs/ex_123/retry`, `/jobs/<HEX64 ตัวใหญ่>/retry` | 404 `NOT_FOUND` | - |
| API-JOB-006 | id ถูกรูปแบบแต่ไม่มี | - | `/jobs/$(printf '0%.0s' {1..64})/retry` | 404 | - |
| API-JOB-007 | reason ผิด (ตรวจก่อน id) | - | `/jobs/abc/retry` body `{}` | 400 `{field:"reason", reason:"required"}` (ไม่ใช่ 404) | - |
| API-JOB-008 | retry ถี่เกิน | งานที่ fail/dead_letter และพยายามล่าสุด < 60 วินาที | retry | 429 `JOB_RETRY_TOO_SOON` `{retryAfterSeconds}` + `Retry-After` | ถ้าไม่มีงานที่ fail ให้ BLOCKED |
| API-JOB-009 | retry เกิน 3 ครั้งใน 24 ชม. | งานที่ fail อยู่ | retry 4 ครั้ง (ห่างกัน > 60 วินาที) | ครั้งที่ 4 → 409 `JOB_RETRY_LIMIT` `{limit:3, windowHours:24}` | audit `job.retry` 3 แถว · BLOCKED ถ้าไม่มีงาน fail |
| API-JOB-010 | retry export ที่มีใหม่กว่า | export เก่าที่ถูกแทน | retry | 409 `JOB_SUPERSEDED` | BLOCKED ถ้าทำไม่ได้ |
| API-JOB-011 | retry dead-letter สำเร็จ | งาน dead_letter | retry | 200 `{status:"completed" หรือ "pending"/"retrying"}` | audit `job.retry` changes `{kind, stateBefore, attemptsBefore, result}` · BLOCKED ถ้าไม่มี |
| API-JOB-012 | สิทธิ์ | - | `c0`, `cn`, T1 support/auditor/catalog_editor | 401 / 403 | - |

---

## 24. ค้นหาผู้ใช้ (`POST /v1/admin/users/lookup`)

บทบาท `support` หรือ `admin` + session MFA · body `{query, reason}`: `query` ถูก trim แล้วต้องเป็น UUID (ทุกเวอร์ชัน) หรืออีเมล (≤320 ตัว `^[^\s@]+@[^\s@]+$`) แล้วแปลงเป็นตัวเล็ก (ตรวจก่อน reason) · ลำดับจับคู่: user id → device id (เจ้าของคนเดียว) → อีเมล (ตรงคนเดียว) · audit ทุกครั้งรวมที่ไม่พบ ไม่บันทึกอีเมลที่ค้น

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-USR-001 | ค้นด้วย user id | `UID_NA` | `ca -X POST -H "$CT" -d "{\"query\":\"$UID_NA\",\"reason\":\"QA support ticket 123\"}" $API/v1/admin/users/lookup` | 200 `{matchedBy:"user", user:{id, email, emailVerified, status, createdAt, deletedAt}, settings:{revision, updatedAt}, devices:[{id, platform, osMajor, appBuild, appliedSettingsRevision, inSync, createdAt, lastSeenAt, revokedAt}], diagnostics:{reportsLast7Days, access}, deletion}`, no-store · ไม่มีค่า settings, favorites, roles | audit `user.lookup` targetId = UID_NA, changes `{matchedBy:"user", found:true}`, reason |
| API-USR-002 | ค้นด้วย device id | `DEV_NA` | query = `DEV_NA` | 200 `matchedBy:"device"` user = tar-noaccess | - |
| API-USR-003 | device id ที่มีสองเจ้าของ | id ที่ลงทะเบียนทั้ง tar-noaccess และ T1 (DEV-027) | query = id นั้น | 404 | audit `found:false`, targetId `none` |
| API-USR-004 | ค้นด้วยอีเมล ตัวพิมพ์ต่าง มีช่องว่าง | อีเมลของ tar-noaccess | `"query":"  TAR-NOACCESS@...  "` | 200 `matchedBy:"email"` | audit ไม่มีอีเมลใน changes |
| API-USR-005 | ไม่พบ | - | `"query":"$(uuid)"` และ `"nobody@example.test"` | 404 `NOT_FOUND` | audit `user.lookup` targetId `none`, `{matchedBy:null, found:false}` |
| API-USR-006 | query ผิด | - | `"abc"`, `""`, ไม่มี query, `"a@b c"`, อีเมล 321 ตัว, `123` | 400 `{field:"query", reason:"invalid"}` | - |
| API-USR-007 | query wildcard/SQL | - | `"%@%"`, `"*@*"`, `"' OR 1=1--@x"` | 404 (จับคู่แบบตรงตัว ไม่ใช่ LIKE) ไม่ใช่ 200 รายการแรก ไม่ใช่ 500 | - |
| API-USR-008 | reason ผิด | query ถูก | ไม่มี reason, `"short"`, 501 ตัว, `"QA\u0000reason text"` | 400 `reason` `required` / `length` / `length` / `control_characters` | ไม่มี audit |
| API-USR-009 | UUID เวอร์ชันใดก็ได้ | - | `"query":"00000000-0000-0000-0000-000000000000"` | 404 (ไม่ใช่ 400) | ข้อสังเกต |
| API-USR-010 | inSync | tar-noaccess มีอุปกรณ์ที่ applied < revision | ดูผล 001 | `inSync:false` สำหรับอุปกรณ์นั้น | - |
| API-USR-011 | deletion ของบัญชีที่ถูกลบ | userId ของ T2 (DEL-001) | lookup | 200 `deletion.status` (`pending`/`completed`) หรือ 404 ถ้าแถว user ถูกลบแล้ว | - |
| API-USR-012 | สิทธิ์ | - | `c0`, `cn`, T1 operator/auditor/catalog_editor, `cpw` | 401 / 403 / 403 / 401 scope session | - |
| API-USR-013 | ไม่สนใจ Idempotency-Key | - | lookup เดิมด้วย `-H 'Idempotency-Key: qa-usr-013-aaaa'` สองครั้ง และ key `bad` | 200 ทุกครั้ง ไม่มี `Idempotent-Replayed` ไม่มี 400 | audit `user.lookup` ทุกครั้ง · ดู mismatch ข้อ 1 |

---

## 25. Overview, metrics และ alerts

ทั้งหมด `operator` หรือ `admin` + session MFA · ข้อมูลรวม ไม่มี user/device/request/station id · alert ไม่มี endpoint แยก แสดงเป็น `incidents` ใน overview (มี `since` เมื่อเป็น alert ที่เปิดอยู่)

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-OVR-001 | overview ค่าเริ่มต้น | `TOKEN` | `ca $API/v1/admin/overview` | 200 `{window:{id:"24h", from, to}, generatedAt, api:{requests, serverErrors, clientErrors, errorRate, p50Ms, p95Ms, lastRequestAt, stale, buckets, topErrors}, stations:{published, disabled, health, checkerEnabled:false, lastCheckAt}, queues, clients, incidents:[...]}`, no-store | - |
| API-OVR-002 | window อื่น | - | `?window=1h`, `?window=7d` | 200 `window.id` ตรง | - |
| API-OVR-003 | window ผิด | - | `?window=30d`, `?window=24H` | 400 `{field:"window", reason:"invalid"}` | - |
| API-OVR-004 | incident codes | - | ดู `incidents` | `code` อยู่ในชุด `api_error_rate, api_latency, stations_suspect, station_checker_stale, account_deletion_failed, account_deletion_stuck, account_deletion_late, account_export_stuck, idp_session_end_stuck, job_dead_letter, station_rights_expiring, backup_stale, no_recent_traffic`, `severity` = `critical`/`warning`, มี `count` | บันทึก incident ที่เห็น |
| API-OVR-005 | station_rights_expiring | สถานีที่ publish มี rights `expiresAt` ภายใน 14 วัน | overview (รอรอบประเมิน alert 1 นาที) | มี incident `station_rights_expiring` `severity:"warning"` | incident นี้มาจากตัวประเมิน alert ถ้า alerts ปิดอยู่จะไม่เห็น ให้บันทึก BLOCKED พร้อมเหตุผล |
| API-OVR-006 | topErrors เป็น route template | หลังทำ case 4xx หลายตัว | ดู `api.topErrors` | `route` เป็น template, `status`, `count` ไม่มี id จริง | - |
| API-OVR-007 | clients จาก diagnostics | หลัง DIA-001 | `?window=1h` | `clients.byEvent` มี `playback_stall`, `topFailures` มี `MEDIA_STALLED` | - |
| API-OVR-008 | สิทธิ์ | - | `c0`, `cn`, T1 support/auditor/catalog_editor, `cpw` | 401 / 403 / 403 / 401 | - |
| API-MET-001 | metrics ค่าเริ่มต้น | - | `ca $API/v1/admin/metrics` | 200 `{from, to, bucket:"1h", latencyBoundsMs:[50,100,250,500,1000,2500,5000], totals, series, routes (≤50), retentionDays:90}` | - |
| API-MET-002 | bucket 1d 90 วัน | - | `?bucket=1d&from=<now-90d>` | 200 | - |
| API-MET-003 | bucket ผิด | - | `?bucket=1w`, `?bucket=1H` | 400 `{field:"bucket", reason:"invalid"}` | - |
| API-MET-004 | 1h เกิน 14 วัน | - | `?bucket=1h&from=<now-15d>` | 400 `{field:"from", reason:"window_too_long"}` | - |
| API-MET-005 | 1d เกิน 90 วัน | - | `?bucket=1d&from=<now-91d+1h>` (ช่วง > 90 วัน) | 400 `window_too_long` | - |
| API-MET-006 | ก่อน retention | - | `?bucket=1d&from=<now-100d>&to=<now-95d>` | 400 `{field:"from", reason:"past_retention"}` | - |
| API-MET-007 | from ≥ to / วันที่ผิด | - | - | 400 `after_to` / `invalid` | - |
| API-MET-008 | กรอง method/route | - | `?method=GET&route=/v1/me` | 200 `routes` เฉพาะที่ตรง | - |
| API-MET-009 | method/route ผิด | - | `method=get`, `method=HEAD`, `route=v1/me`, `route=/v1/me?x=1`, route 202 ตัว | 400 `invalid` | - |
| API-MET-010 | สิทธิ์ | - | `c0`, `cn`, T1 support/auditor | 401 / 403 | - |
| API-MET-011 | alert ส่ง webhook | ต้องตั้ง alert webhook | - | - | BLOCKED (ไม่ใช่ API สาธารณะ) |

---

## 26. Staff CLI (ให้สิทธิ์/ถอนสิทธิ์)

รันบนเครื่อง Tar: `docker compose -f infra/compose/compose.yaml exec api node dist/staff/staff-cli.js ...` · `<subject>` = OIDC `sub` ของบัญชี (ดูจาก `claims`) · ผล: exit 0 = สำเร็จ, 1 = มีอยู่แล้ว/ไม่มีอยู่, 2 = ใช้ผิด/role ไม่รู้จัก, 3 = ผู้ใช้ยังไม่ได้ตั้ง TOTP (เมื่อ API มี Keycloak admin client ซึ่ง compose ตั้งไว้), 4 = มี TOTP ใหม่ที่ยังไม่ได้ pin (ใช้ `pin-mfa`) · role: `support`, `catalog_editor`, `operator`, `admin`, `auditor`
**ใช้กับบัญชี throwaway เท่านั้น** และ revoke ทุก role ที่ให้เมื่อจบ ห้ามแตะ role ของ tar-test และห้ามให้ role กับ tar-noaccess · throwaway ต้องตั้ง TOTP เองก่อนที่หน้า account ของ Keycloak (`$KC/account` → Signing in → Authenticator application) จึงจะได้ role และผ่าน MFA

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-CLI-001 | list | - | `... staff-cli.js list` | exit 0 แต่ละบรรทัด `<subject>\t<role>\t<scope>\tgranted by <op> at <time>` มี tar-test `admin` | - |
| API-CLI-002 | grant | T1 ตั้ง TOTP แล้ว, `SUB_T1` | `... grant $SUB_T1 operator --by qa-gemini --reason "QA role test"` | stdout `granted operator`, exit 0 | audit `staff_role.grant` actor `operator:qa-gemini`, targetType `user`, changes `{role:"operator"}` · `ct1 $API/v1/me/staff` → `roles:["operator"]` และ `rolesVersion` เปลี่ยน |
| API-CLI-003 | grant ซ้ำ | หลัง 002 | ซ้ำ | `already has operator`, exit 1 | ไม่มี audit ใหม่ |
| API-CLI-004 | ผู้ใช้ไม่มี TOTP | T2 หรือ throwaway ที่ไม่ได้ตั้ง TOTP | grant | ข้อความ `... has no one-time code yet ...`, exit 3 | ไม่มี role |
| API-CLI-005 | role ไม่รู้จัก | - | `grant $SUB_T1 superadmin --by qa --reason x` | `unknown role "superadmin"; one of: ...`, exit 2 | - |
| API-CLI-006 | ขาด --by หรือ --reason | - | `grant $SUB_T1 operator` | `usage: ...`, exit 2 | - |
| API-CLI-007 | คำสั่งผิด | - | `... staff-cli.js promote` | usage, exit 2 | - |
| API-CLI-008 | สิทธิ์มีผลทันที | หลัง 002 | `ct1 $API/v1/admin/overview` (T1 MFA) | 200 | - |
| API-CLI-009 | revoke | หลัง 002 | `... revoke $SUB_T1 operator --by qa-gemini --reason "QA cleanup"` | `revoked operator`, exit 0 | audit `staff_role.revoke` · `ct1 $API/v1/admin/overview` → 403 `ROLE_REQUIRED` |
| API-CLI-010 | revoke ซ้ำ | หลัง 009 | ซ้ำ | `does not have operator`, exit 1 | - |
| API-CLI-011 | grant subject ที่ยังไม่เคย sign in | subject สมมติ `qa-unknown-subject` | grant | exit 3 (Keycloak ไม่รู้จัก) หรือสร้างแถว user ล่วงหน้า | บันทึกผลจริง · ถ้าสำเร็จให้ revoke ทันที |
| API-CLI-012 | grant บันทึก (pin) TOTP | หลัง 002 | `docker compose ... exec postgres psql -U tunedeck -c "SELECT cardinality(credential_ids), pinned_by FROM staff_mfa_pins p JOIN users u ON u.id=p.user_id WHERE u.oidc_subject='$SUB_T1'"` | 1 แถว, `cardinality` = จำนวน TOTP ของ T1, `pinned_by` = `qa-gemini` | ห้ามพิมพ์ค่า `credential_ids` ในรายงาน |
| API-CLI-013 | TOTP ใหม่ที่ไม่ได้ pin ถูกปฏิเสธ | หลัง 002, T1 ได้ token MFA | ที่ `$KC/account` ของ T1 → Signing in → เพิ่ม Authenticator application ตัวที่สอง แล้วรอ 60 วินาที · `ct1 $API/v1/admin/overview` | 403 `STAFF_MFA_CHANGED` | ทุก `/v1/admin/**` ได้ 403 เดียวกัน |
| API-CLI-014 | `/v1/me/staff` บอกสถานะ | หลัง 013 | `ct1 $API/v1/me/staff` | 200, `mfa:true`, `mfaChanged:true` | - |
| API-CLI-015 | หน้าเว็บ staff อธิบาย | หลัง 013 | เปิด `$CONSOLE/admin` ด้วย T1 (MFA) | หัวข้อ "รหัสยืนยันตัวตน (TOTP) ของบัญชีนี้มีการเปลี่ยนแปลง" ไม่มีเมนู staff (ภาษาอังกฤษ: "This account's one-time code (TOTP) has changed") | - |
| API-CLI-016 | grant เพิ่มถูกปฏิเสธ | หลัง 013 | `... grant $SUB_T1 support --by qa-gemini --reason "QA pin test"` | `... has a one-time code that was not pinned ...`, exit 4 | ไม่มี role ใหม่, ไม่มี audit ใหม่ |
| API-CLI-017 | pin-mfa ยืนยันรหัสใหม่ | หลัง 013 | `... pin-mfa $SUB_T1 --by qa-gemini --reason "QA confirmed new code"` | `pinned 2 one-time codes`, exit 0 | audit `staff_mfa.pin` actor `operator:qa-gemini`, changes `{codes:2, previously:1}` · รอ 60 วินาที แล้ว `ct1 $API/v1/admin/overview` → 200, `/v1/me/staff` → `mfaChanged:false` |
| API-CLI-018 | ลบ TOTP ทั้งหมด | หลัง 017 | ลบ Authenticator ทั้งสองตัวที่ `$KC/account` · รอ 60 วินาที · `ct1 $API/v1/admin/overview` ด้วย token MFA เดิม | 403 `STAFF_MFA_CHANGED` | `pin-mfa` ตอนนี้ได้ exit 3 (`no one-time code yet`) |
| API-CLI-019 | pin-mfa ใช้ผิด | - | `... pin-mfa --by qa --reason x` และ `... pin-mfa qa-no-such-subject --by qa --reason x` | ตัวแรก usage, exit 2 · ตัวที่สอง exit 3 (ไม่มี TOTP) หรือ 1 (`no account for ...`) | ไม่มี audit |
| API-CLI-020 | staff เดิมได้ pin อัตโนมัติ | ทำบน DB ที่ upgrade จาก 032 เท่านั้น (เช่น tar-test หลัง deploy PR #18) | `tt $API/v1/admin/overview` ด้วย MFA ครั้งแรกหลัง upgrade | 200 | audit `staff_mfa.pin` actor `system:staff`, changes `{codes:N, firstUse:true}` หนึ่งครั้ง · แถว `staff_mfa_pins` `pinned_by` = `system:first_use` |

---

## 26A. Console BFF (`/bff/**` ที่ `http://localhost:3201`)

เฉพาะพฤติกรรมของ BFF ที่เปลี่ยนล่าสุด (ไม่ใช่การทดสอบ console ทั้งหมด) · BFF ถือ access token ไว้ฝั่ง server; browser มีเพียง cookie `td_session` (HttpOnly, ไม่มี prefix `__Host-` บน http) · mutation ต้องมี `Origin: http://localhost:3201` ตรงตัว และ CSRF token ของ session (header `X-CSRF-Token` หรือ form field `csrf`) มิฉะนั้น 403 `CSRF_REJECTED` · ลำดับตรวจ: session (401 `SESSION_EXPIRED`) → CSRF (403) → Content-Type (415 `UNSUPPORTED_MEDIA_TYPE`) → ขนาด body (413 `PAYLOAD_TOO_LARGE`, สูงสุด 16 KiB) · error body `{code, messageKey, requestId, details:{}}`

การเตรียม (ค่าทั้งสองเป็นความลับ ห้ามใส่รายงาน): sign in ที่ `$CONSOLE` ด้วย tar-noaccess ใน private window แล้วจาก DevTools คัดค่า cookie `td_session` และค่า `<input type="hidden" name="csrf">` ในหน้า (เช่นหน้า Privacy) เข้าตัวแปรด้วย `read -rs SID` และ `read -rs CSRF`

```sh
cb()  { curl -sS -i -b "td_session=$SID" "$@"; }                                    # มี session ไม่มี CSRF
cbm() { curl -sS -i -b "td_session=$SID" -H "Origin: $CONSOLE" -H "X-CSRF-Token: $CSRF" "$@"; }   # mutation ครบ
```

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-BFF-001 | ดาวน์โหลด export ด้วย POST form | export `ready` ของ tar-noaccess (`EXP`, ทำผ่านหน้า Privacy หรือ API-EXP-010) | `cb -X POST -H "Origin: $CONSOLE" -H 'Content-Type: application/x-www-form-urlencoded' --data-urlencode "csrf=$CSRF" $CONSOLE/bff/account/exports/$EXP/file -o /tmp/qa-bff-export.json -D -` | 200 `Content-Type: application/json`, `Cache-Control: no-store`, `Content-Disposition: attachment; filename="tunedeck-export-YYYY-MM-DD.json"`, ไฟล์เป็น export JSON | ลิงก์เดิมของ export (ถ้ามี) ใช้ไม่ได้แล้วเพราะ BFF สร้างลิงก์ใหม่ (API-EXP-020) · ลบไฟล์หลังตรวจ |
| API-BFF-002 | GET ไม่รองรับ | - | `cb $CONSOLE/bff/account/exports/$EXP/file` | 405 | ไม่มีการสร้างลิงก์ใหม่ |
| API-BFF-003 | POST ไม่มี csrf | - | `cb -X POST -H "Origin: $CONSOLE" -H 'Content-Type: application/x-www-form-urlencoded' -d '' $CONSOLE/bff/account/exports/$EXP/file` | 403 `CSRF_REJECTED` | - |
| API-BFF-004 | csrf ผิด | - | `--data-urlencode 'csrf=wrong'` | 403 `CSRF_REJECTED` | - |
| API-BFF-005 | Origin ต่าง หรือไม่มี Origin | - | csrf ถูก + `-H 'Origin: http://evil.localhost'` และแบบไม่ส่ง Origin | 403 `CSRF_REJECTED` ทั้งคู่ | - |
| API-BFF-006 | csrf ใน header แทน form | - | `cbm -X POST $CONSOLE/bff/account/exports/$EXP/file` | 200 (header ก็ใช้ได้) | - |
| API-BFF-007 | ไม่มี session | - | `curl -sS -i -X POST -H "Origin: $CONSOLE" --data-urlencode "csrf=$CSRF" $CONSOLE/bff/account/exports/$EXP/file` | 401 `SESSION_EXPIRED` | - |
| API-BFF-008 | id ไม่ใช่ UUID / ไม่มี / ของคนอื่น | - | `/bff/account/exports/abc/file`, `$(uuid)`, EXP ของบัญชีอื่น | 404 ทั้งหมด | - |
| API-BFF-009 | export ยังไม่พร้อม | export `pending` | POST form | 409 `EXPORT_NOT_READY` (ส่งต่อจาก API) | - |
| API-BFF-010 | body เกิน 16 KiB | - | `cbm -X PATCH -H "$CT" -H 'If-Match: "0"' --data-binary "{\"theme\":\"$(head -c 17000 /dev/zero \| tr '\0' a)\"}" $CONSOLE/bff/settings` | 413 `PAYLOAD_TOO_LARGE` | settings ไม่เปลี่ยน |
| API-BFF-011 | body ขนาดพอดี 16 KiB | - | body 16384 ไบต์พอดี | ผ่านไปถึง API (ได้ 400 `value_not_allowed` จาก API ไม่ใช่ 413) | - |
| API-BFF-012 | Content-Length ประกาศเกินแต่ส่งน้อย | - | `cbm -X PATCH -H "$CT" -H 'If-Match: "0"' -H 'Content-Length: 20000' --data-binary '{"theme":"dark"}' --max-time 5 $CONSOLE/bff/settings` | 413 ทันที (ไม่รอ body) | ถ้า curl ค้างจนหมดเวลา 5 s ให้ FAIL |
| API-BFF-013 | chunked ที่ใหญ่เกิน | - | `head -c 20000 /dev/zero \| tr '\0' a > /tmp/qa-big.txt; cbm -X PATCH -H "$CT" -H 'If-Match: "0"' -H 'Transfer-Encoding: chunked' --data-binary @/tmp/qa-big.txt $CONSOLE/bff/settings` | 413 `PAYLOAD_TOO_LARGE` | ลบไฟล์ |
| API-BFF-014 | ตรวจ CSRF ก่อนขนาด | - | body 20 KiB ไม่มี X-CSRF-Token | 403 `CSRF_REJECTED` (ไม่ใช่ 413) | - |
| API-BFF-015 | Content-Type ผิดตรวจก่อนขนาด | - | `cbm -X PATCH -H 'Content-Type: text/plain' ...` body 20 KiB | 415 `UNSUPPORTED_MEDIA_TYPE` | - |
| API-BFF-016 | 413 ที่ route admin | session ของ tar-test (MFA) | `cbm -X POST -H "$CT" --data-binary "{\"query\":\"a@b.c\",\"reason\":\"$(head -c 17000 /dev/zero \| tr '\0' a)\"}" $CONSOLE/bff/admin/users/lookup` | 413 `PAYLOAD_TOO_LARGE` | ไม่มี audit `user.lookup` |
| API-BFF-017 | refresh ร่วมกันเมื่อ token หมดอายุ | session ของ tar-noaccess ที่ sign in แล้วรอ > 5 นาที (access token 300 s หมดแล้ว) โดยไม่ใช้ console ระหว่างนั้น | `for i in 1 2 3 4 5; do cb -o /dev/null -w '%{http_code}\n' $CONSOLE/bff/settings & done; wait` | ทั้ง 5 ได้ 200 | `cb $CONSOLE/bff/settings` อีกครั้ง → 200 (session ไม่ถูก sign out, cookie ไม่ถูกลบ: ไม่มี `Set-Cookie: td_session=;`) |
| API-BFF-018 | refresh ร่วมกันกับ mutation ผสม | เหมือน 017 (รออีก > 5 นาที) | 3 × GET `/bff/settings` + 2 × GET `/bff/devices` พร้อมกัน | ทั้ง 5 ได้ 200 | session ยังใช้ได้ |
| API-BFF-019 | step-up ไม่ทำให้ session หลุด | session tar-test ที่ MFA เก่ากว่า 5 นาที | `cbm -X POST -H "$CT" -d '{"reason":"QA logs export test"}' $CONSOLE/bff/admin/logs/export` | 401 `MFA_REQUIRED` (ส่งต่อจาก API) | session ยังใช้ได้ (GET `/bff/settings` → 200) |
---

## 27. Idempotency (ข้ามทุก route)

ใช้กับ POST/PUT/PATCH/DELETE ที่มี token · บังคับใน `POST /v1/me/exports` และ `DELETE /v1/me` (ไม่มี → 428 `IDEMPOTENCY_KEY_REQUIRED` `{header:"Idempotency-Key"}`) · **ไม่สนใจเลย** ใน `POST /v1/me/exports/{id}/link`, `POST /v1/me/support-access/codes` และ `POST /v1/admin/users/lookup` · key `^[A-Za-z0-9_.:-]{8,128}$` · ขอบเขต = ผู้ใช้ + method + path · hash = body + query + If-Match · เก็บ 24 ชม. · error ปล่อย key · response ที่ไม่ใช่ JSON (CSV) ไม่ถูกเก็บ · route สาธารณะไม่มี idempotency

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-IDM-001 | replay คืนผลเดิม | - | `ca -X POST -H "$CT" -H 'Idempotency-Key: qa-idm-001-aaaa' -d "$STATION" $API/v1/admin/stations` สองครั้ง | ครั้งที่สอง status, body, `ETag` เดิม + `Idempotent-Replayed: true` | สร้างสถานีเดียว |
| API-IDM-002 | body ต่าง key เดิม | หลัง 001 | key เดิม body อื่น | 409 `IDEMPOTENCY_KEY_REUSED` | - |
| API-IDM-003 | query ต่าง key เดิม | หลัง 001 | key เดิม + `?x=1` | 409 `IDEMPOTENCY_KEY_REUSED` | - |
| API-IDM-004 | key เดิมคนละ path | หลัง 001 | key เดิมบน `PATCH /v1/me/settings` | ประมวลผลปกติ (ขอบเขตต่อ path) | - |
| API-IDM-005 | key เดิมคนละผู้ใช้ | - | `cn` ใช้ key `qa-idm-001-aaaa` บน `POST /v1/sync/push` | ประมวลผลปกติ | - |
| API-IDM-006 | key กำลังประมวลผล | ส่งสองคำขอพร้อมกันด้วย key เดียว (`&` ใน shell) บน `POST /v1/me/exports` | - | ตัวหนึ่ง 202, อีกตัว 202 replay หรือ 409 `IDEMPOTENCY_IN_PROGRESS` + `Retry-After: 1` | ยิงแค่ 2 คำขอ |
| API-IDM-007 | key สั้น/ยาว/อักขระผิด | - | `abc`, 129 ตัว, `qa idm 007 x`, `qa/idm/007` | 400 `{field:"Idempotency-Key"}` | - |
| API-IDM-008 | key ตรวจหลัง auth | - | `c0 -X POST -H 'Idempotency-Key: x' $API/v1/me/exports` | 401 (ไม่ใช่ 400) | - |
| API-IDM-009 | key บน GET ถูกเพิกเฉย | - | `ca -H 'Idempotency-Key: bad' $API/v1/me` | 200 | - |
| API-IDM-010 | ไม่มี key ที่ route ไม่บังคับ | - | `PATCH /v1/me/settings` ไม่มี key | ประมวลผลปกติ | - |
| API-IDM-011 | key บน route ที่ไม่สนใจ | - | ดู API-EXP-021, API-SUP-004, API-USR-013 | - | - |

---

## 28. Rate limit (ข้ามทุก route)

หน้าต่าง = นาทีตามนาฬิกา (`date_trunc('minute')`) · `Retry-After` = วินาทีถึงนาทีถัดไป · 429 `API_RATE_LIMITED` `{retryAfterSeconds}` · ถ้า DB นับไม่ได้ให้ผ่าน · **วิธีทดสอบโดยไม่ hammer**: เริ่มต้นนาทีใหม่ (`date +%S` ใกล้ 00), ยิงตามจำนวนที่ระบุแบบต่อเนื่องครั้งเดียว ห้ามวนซ้ำ ถ้าข้ามนาทีกลางคันให้รอนาทีใหม่แล้วทำใหม่ครั้งเดียว

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-RL-001 | write 30/นาที/บัญชี | `TOKEN_T1`, ต้นนาที | `for i in $(seq 31); do ct1 -o /dev/null -w '%{http_code}\n' -X PATCH -H "$CT" -H 'If-Match: "0"' -d '{"theme":"dark"}' $API/v1/me/settings; done` | 30 ครั้งแรกได้ 200/412 ตามปกติ ครั้งที่ 31 → 429 `API_RATE_LIMITED` + `Retry-After` (1..60) และ `details.retryAfterSeconds` เท่ากัน | write ที่ 412 ก็นับ · 31 คำขอ |
| API-RL-002 | read แยกจาก write | ทันทีหลัง 001 | `ct1 $API/v1/me` | 200 | - |
| API-RL-003 | หลังนาทีใหม่กลับมาใช้ได้ | รอตาม Retry-After | PATCH อีกครั้ง | ไม่ใช่ 429 | - |
| API-RL-004 | catalog 60/นาที/IP | ต้นนาที | `for i in $(seq 61); do c0 -o /dev/null -w '%{http_code}\n' $API/v1/catalog/radio; done` | 60 ครั้งแรก 200 ครั้งที่ 61 → 429 + `Retry-After` | 61 คำขอ |
| API-RL-005 | bucket แยกต่อกลุ่ม | ทันทีหลัง 004 | `c0 "$API/v1/directory/radio?q=jazz"` และ `c0 $API/v1/config` | 200 ทั้งคู่ | - |
| API-RL-006 | directory/deletion/export-download 60/นาที/IP | ต้นนาทีแยกกันทีละกลุ่ม | ยิง 61 ครั้ง `c0 "$API/v1/directory/radio?q=jazz"` (คำค้นเดิม = ใช้ cache), หรือ `c0 $API/v1/account-deletions/short` | ครั้งที่ 61 → 429 | 404 ก็นับ · ทำทีละกลุ่ม ไม่ต้องครบทุกกลุ่ม |
| API-RL-007 | X-Forwarded-For ไม่ช่วยหลบ | หลัง 004 ภายในนาทีเดียวกัน | `c0 -H 'X-Forwarded-For: 1.2.3.4' $API/v1/catalog/radio` | 429 (`TRUST_PROXY_HOPS=0`) | - |
| API-RL-008 | token บน route สาธารณะไม่เปลี่ยน bucket | หลัง 004 | `cn $API/v1/catalog/radio` | 429 (นับต่อ IP) | - |
| API-RL-009 | read 120/นาที/บัญชี | ต้นนาที | 121 × `ct1 -o /dev/null $API/v1/me` | ครั้งที่ 121 → 429 | 121 คำขอ: เกินแนวทาง 65 ให้ทำเฉพาะถ้า Tar อนุญาต มิฉะนั้น BLOCKED |
| API-RL-010 | 429 ตรวจหลัง auth | - | ระหว่างที่ T1 ถูกจำกัด ยิง `c0 -X PATCH ... /v1/me/settings` | 401 (ไม่มี actor จึงไม่ถูกนับ) | - |
| API-RL-011 | limit ของ endpoint เฉพาะ | - | ดู API-SHC-002, API-DIA-024, API-JOB-008 | - | - |

---

## 29. ความปลอดภัยข้ามทุก route

### 29.1 ตารางสิทธิ์ (route × role)

สัญลักษณ์: `P` = สาธารณะ ไม่ต้อง token · `U` = ผู้ใช้ที่ sign in ทุกคน · `R` = ต้อง sign in ภายใน 300 วินาที · `S` = staff ต้องมี session MFA 12 ชม. · `M` = ต้อง MFA สด 300 วินาที · คอลัมน์ role: `Y` = ได้, `-` = 403 `ROLE_REQUIRED`

| Route | เงื่อนไข | support | catalog_editor | operator | admin | auditor | ลูกค้า |
|---|---|---|---|---|---|---|---|
| `GET /health/live`, `GET /health/ready` | P | Y | Y | Y | Y | Y | Y |
| `GET /v1/config`, `GET /v1/catalog/radio`, `GET /v1/directory/radio` | P | Y | Y | Y | Y | Y | Y |
| `GET /v1/account-deletions/{ticket}`, `GET /v1/export-downloads/{token}` | P | Y | Y | Y | Y | Y | Y |
| `POST /v1/webhooks/apple`, `POST /v1/webhooks/google` | P (ลายเซ็น store) | Y | Y | Y | Y | Y | Y |
| `GET /v1/me`, `GET /v1/me/staff`, `GET /v1/me/export` | U | Y | Y | Y | Y | Y | Y |
| `GET/PATCH /v1/me/settings` | U | Y | Y | Y | Y | Y | Y |
| `GET /v1/me/devices`, `PUT /v1/me/devices/{id}`, `GET/PUT .../preferences` | U | Y | Y | Y | Y | Y | Y |
| `DELETE /v1/me/devices/{id}/session` | U+R | Y | Y | Y | Y | Y | Y |
| `POST /v1/me/exports` | U+R + key | Y | Y | Y | Y | Y | Y |
| `GET /v1/me/exports/{id}`, `POST .../link` | U | Y | Y | Y | Y | Y | Y |
| `DELETE /v1/me`, `DELETE /v1/me/account` | U+R (+ key บน `/v1/me`) | Y | Y | Y | Y | Y | Y |
| `POST /v1/sync/push`, `GET /v1/sync/pull`, `GET /v1/me/favorites` | U | Y | Y | Y | Y | Y | Y |
| `GET /v1/me/entitlements`, `POST /v1/billing/verify` | U | Y | Y | Y | Y | Y | Y |
| `POST /v1/diagnostics/batches`, `GET /v1/me/diagnostics`, `GET/DELETE /v1/me/diagnostics/{id}` | U | Y | Y | Y | Y | Y | Y |
| `GET /v1/me/support-access`, `POST .../codes`, `DELETE .../{id}` | U | Y | Y | Y | Y | Y | Y |
| `GET /v1/admin/stations`, `/summary`, `/{id}`, `/{id}/health`, `/{id}/history`, `/{id}/rights` | S | - | Y | - | Y | - | - |
| `POST /v1/admin/stations`, `PATCH /{id}`, `POST /{id}/check`, `POST /{id}/rights`, `POST .../rights/{recordId}/revoke` | S | - | Y | - | Y | - | - |
| `POST /v1/admin/stations/{id}/publish` | S+M | - | - | - | Y | - | - |
| `POST /v1/admin/stations/{id}/disable`, `/enable` | S | - | - | - | Y | - | - |
| `GET/POST /v1/admin/directory/blocks`, `POST .../{id}/remove` | S | - | Y | - | Y | - | - |
| `GET /v1/admin/config` | S | - | - | Y | Y | - | - |
| `PATCH /v1/admin/config/draft` | S | - | - | - | Y | - | - |
| `POST /v1/admin/config/stage`, `/publish`, `/releases/{r}/rollback` | S+M | - | - | - | Y | - | - |
| `GET /v1/admin/audit` | S | - | - | - | Y | Y | - |
| `POST /v1/admin/audit/export` | S+M | - | - | - | Y | Y | - |
| `GET /v1/admin/logs` | S | - | - | Y | Y | - | - |
| `POST /v1/admin/logs/export` | S+M | - | - | Y | Y | - | - |
| `GET /v1/admin/jobs`, `POST .../{id}/retry` | S | - | - | Y | Y | - | - |
| `GET /v1/admin/overview`, `GET /v1/admin/metrics` | S | - | - | Y | Y | - | - |
| `POST /v1/admin/users/lookup` | S | Y | - | - | Y | - | - |
| `POST /v1/admin/users/{userId}/diagnostics/access`, `GET /v1/admin/users/{userId}/diagnostics` | S (+ code จากลูกค้า) | Y | - | - | Y | - | - |

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-SEC-001 | ทุก `/v1/admin/**` ไม่มี token | - | วนทุก route admin ในตาราง ด้วย `c0` | 401 `AUTH_REQUIRED` ทุกตัว | - |
| API-SEC-002 | ทุก `/v1/admin/**` ด้วยลูกค้า | `TOKEN_NA` | วนทุก route admin | 403 `ROLE_REQUIRED` ทุกตัว (ไม่ใช่ 404/500/200) | ไม่มี audit การเปลี่ยนแปลง |
| API-SEC-003 | admin ที่ไม่ได้ MFA | `TOKEN_PW` | วนทุก route admin | 401 `MFA_REQUIRED` `{scope:"session", maxAgeSeconds:43200}` | - |
| API-SEC-004 | ลำดับ role ก่อน MFA | `TOKEN_NA` ที่ไม่มี MFA | route admin | 403 (ไม่ใช่ 401 MFA) | - |
| API-SEC-005 | ตาราง role ด้วยบัญชี throwaway | T1 ได้ทีละ role ผ่าน CLI (ตั้ง TOTP แล้ว) | วนทุก route ตามคอลัมน์ | ตรงตาราง: `Y` ไม่ใช่ 403, `-` = 403 `ROLE_REQUIRED` | revoke ทุก role · BLOCKED ถ้า T1 ตั้ง TOTP ไม่ได้ |
| API-SEC-006 | session MFA ข้าม token ใน session เดียวกัน | sign in ด้วย `acr_values=mfa` แล้วขอ token ใหม่ใน browser session เดิมโดยไม่ใส่ acr_values | route admin GET | 200 (sid เคยผ่าน MFA ภายใน 12 ชม.) | - |
| API-SEC-007 | X-HTTP-Method-Override ไม่มีผล | - | `cn -X POST -H 'X-HTTP-Method-Override: DELETE' $API/v1/me` | 404 `NOT_FOUND` (ไม่มี POST /v1/me) และบัญชีไม่ถูกลบ | - |
| API-SEC-008 | path ตัวพิมพ์/ทับซ้อน | - | `ca $API/V1/ADMIN/AUDIT`, `cn $API/v1/admin/../admin/audit`, `cn "$API/v1/admin/audit%2F"` | ไม่มี response ใดเลี่ยงการตรวจสิทธิ์ (404 หรือ 403) | - |

### 29.2 IDOR (เข้าถึงข้อมูลของคนอื่นด้วย id)

บัญชี A = tar-noaccess (`cn`), บัญชี B = T1 (`ct1`) · คาดหวังเสมอ: **404** (ไม่ใช่ 403 ที่บอกว่ามีอยู่) และข้อมูลของ A ไม่เปลี่ยน

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-SEC-010 | sign out อุปกรณ์ของ A | `DEV_NA` | `ct1 -X DELETE $API/v1/me/devices/$DEV_NA/session` (T1 สด) | 404 | `cn GET /v1/me/devices` DEV_NA ยัง active |
| API-SEC-011 | อ่าน/เขียน preferences ของ A | `DEV_NA` | `ct1 $API/v1/me/devices/$DEV_NA/preferences` และ PUT | 404 ทั้งคู่ | - |
| API-SEC-012 | PUT อุปกรณ์ด้วย id ของ A | `DEV_NA` | `ct1 -X PUT ... $API/v1/me/devices/$DEV_NA` | 200 แต่เป็นอุปกรณ์ใหม่ของ B | ข้อมูลของ A ไม่ถูกเขียนทับ (API-DEV-027) |
| API-SEC-013 | export ของ A | `EXP` | `ct1 $API/v1/me/exports/$EXP`, `ct1 -X POST .../link` | 404 | ลิงก์ของ A ยังใช้ได้ |
| API-SEC-014 | diagnostics ของ A | `RPT` | `ct1 GET` และ `DELETE /v1/me/diagnostics/$RPT` | 404 | รายงาน A ยังอยู่ |
| API-SEC-015 | support grant ของ A | `GID` | `ct1 -X DELETE $API/v1/me/support-access/$GID` | 404 | - |
| API-SEC-016 | sync ด้วย deviceId / entityId ของ A | `DEV_NA`, entity E1 ของ A | `ct1` push ด้วย `deviceId:DEV_NA` / upsert E1 base 1 | 404 `device_not_registered` / `conflict not_found` (entity แยกตามผู้ใช้) | favorites ของ A ไม่เปลี่ยน |
| API-SEC-017 | diagnostics batch ด้วย deviceId ของ A | `DEV_NA` | `ct1` POST batch | 404 `device_not_registered` | - |
| API-SEC-018 | staff อ่าน diagnostics ของ A โดยไม่มี code | `UID_NA` | admin GET `/v1/admin/users/$UID_NA/diagnostics` | 403 `SUPPORT_ACCESS_REQUIRED` | - |
| API-SEC-019 | เดา ticket / download token | - | ticket/token 43 ตัวสุ่ม 3 ครั้ง | 404 ทั้งหมด ไม่มีความต่างของเวลาตอบที่เห็นชัด | - |
| API-SEC-020 | rights record ข้ามสถานี | ดู API-RGT-022 | - | 404 | - |

### 29.3 Injection ในทุก field ข้อความอิสระ

ชุดข้อความ (ส่งเป็น JSON string ให้ escape ถูกต้อง หรือ URL-encode ใน query):
`S1` = `' OR '1'='1` · `S2` = `'; DROP TABLE users;--` · `S3` = `%` · `S4` = `_` · `S5` = `\` · `S6` = `QA ‮gnp.exe` (RLO) · `S7` = `QA ⁦x⁩` (isolate) · `S8` = `QA ​zero` (zero-width) · `S9` = `QA \u0000nul` · `S10` = `QA \u0085nel` (C1) · `S11` = `QA\r\nX-Injected: 1` · `S12` = `<script>alert(1)</script>` · `S13` = `=HYPERLINK("http://x","y")` · `S14` = 10000 ตัว `a` · `S15` = `{"$ne":null}` (ข้อความ) · `S16` = `../../etc/passwd`
คาดหวังทั่วไป: ไม่มี 500 ทุกกรณี · ข้อความที่ผ่านถูกเก็บและคืนตรงตัว (ไม่ถูกตีความ) · ไม่มี SQL error ใน body

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-SEC-021 | station `name` | - | POST station ด้วย S1-S16 ทีละตัว (เติม `QA-` นำหน้า) | S1-S5, S12, S13, S15, S16 → 201 คืนตรงตัว · S6, S7, S9, S10, S11 → 400 `control_characters` · S8 → 201 (zero-width ไม่ถูกห้ามใน name) · S14 → 400 `length` | บันทึก S8 เป็นข้อสังเกต · ห้าม publish สถานีเหล่านี้ · disable หลังจบ |
| API-SEC-022 | admin stations `q` | - | `?q=` S1-S5, S12 | 200 ไม่มี 500 · `%` และ `_` ตรงตัวอักษร ไม่ใช่ wildcard | - |
| API-SEC-023 | rights `holder`/`reference`/station reasons | - | S1-S16 | เหมือน SEC-021 (ใช้ `text()` ชุดเดียวกัน, ยาวสุด 200/500) | - |
| API-SEC-024 | reason ของ export/lookup/jobs/support (`parseExportReason`) | - | S6, S7, S8, S10 ในข้อความยาว ≥10 | **ผ่าน** (ห้ามเฉพาะ U+0000-001F และ U+007F) | ข้อสังเกตความปลอดภัย: bidi และ C1 เก็บลง audit ได้ แสดงผลกลับด้านใน console |
| API-SEC-025 | reason ของ config/directory block | - | S6, S7, S8 | **ผ่าน** (ห้ามเฉพาะ C0/C1) · S10 → 400 `length` | ข้อสังเกตเดียวกัน |
| API-SEC-026 | directory `q` | - | S1-S8, S12, S14 | ผ่าน (อักขระอันตรายถูกลบก่อนส่งต่อ) · S14 → 400 `out_of_range` | log ไม่มีคำค้น |
| API-SEC-027 | users lookup `query` | - | `%@%`, `_@_`, S1+`@x` | 404 (จับคู่ตรงตัว) | - |
| API-SEC-028 | audit/logs filter | - | S1, S3 ใน `targetId`, `actor`, `errorCode` | 400 `invalid` (pattern ห้าม) | - |
| API-SEC-029 | header injection ผ่านค่าที่สะท้อนกลับ | - | `-H 'X-Request-Id: qa%0d%0aX: 1'` และ Idempotency-Key ที่มี CRLF | X-Request-Id ถูกแทนด้วย `req_...` · key → 400 · ไม่มี header แปลกใน response | - |
| API-SEC-030 | ข้อความยาวมากใน JSON | - | body ใหญ่ใกล้ 16 KiB ด้วย S14 ใน field ต่าง ๆ | 400 ตาม field หรือ 413 ถ้าเกิน · ไม่มี 500 | - |

### 29.4 CORS และ cache header

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-SEC-031 | private response มี no-store | - | ตรวจ header ของทุก GET/POST ที่มี token ใน case ข้างบน | `Cache-Control: no-store` ทุกตัว · **ยกเว้นที่รู้แล้ว**: `POST /v1/admin/jobs/{id}/retry` 200 ไม่มี Cache-Control, `DELETE` ที่ตอบ 204 ไม่มี body | บันทึกตัวที่ขาดนอกเหนือจากนี้เป็น FAIL |
| API-SEC-032 | public response | - | `/v1/catalog/radio`, `/v1/directory/radio` | `Cache-Control: public, max-age=300` · `/v1/config` → `no-cache` (dev) | - |
| API-SEC-033 | error มี no-store | - | error ใดก็ได้ (401/400/404/429) | `Cache-Control: no-store` | - |
| API-SEC-034 | ไม่มี CORS header (ไม่ได้ตั้ง allowlist) | - | `c0 -H 'Origin: https://evil.example' $API/v1/catalog/radio` | ไม่มี `Access-Control-Allow-Origin` | - |
| API-SEC-035 | preflight | - | `c0 -X OPTIONS -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: DELETE' -H 'Access-Control-Request-Headers: authorization' $API/v1/me` | ไม่มี `Access-Control-Allow-*` (ได้ 404 หรือ 204 ที่ไม่มี header CORS) | - |
| API-SEC-036 | Origin ของ console เองก็ไม่ได้ | - | `-H 'Origin: http://localhost:3201'` | ไม่มี `Access-Control-Allow-Origin` (console เรียกผ่าน BFF ฝั่ง server) | - |
| API-SEC-037 | ไม่มี header ที่บอกเทคโนโลยี | - | response ใดก็ได้ | ไม่มี `X-Powered-By` | - |
| API-SEC-038 | export download header | ดู API-EXP-019 | - | `Referrer-Policy: no-referrer`, `Content-Disposition: attachment`, no-store | - |

### 29.5 Error body และ log

| ID | จุดประสงค์ | ก่อนทดสอบ | Request | คาดหวัง | ผลข้างเคียง/ตรวจต่อ |
|---|---|---|---|---|---|
| API-SEC-040 | log ไม่มี token/ความลับ/คำค้น | ทำ case ส่วนใหญ่แล้ว | export logs 24 ชม. (API-LOG-020) แล้ว `grep -Eci 'bearer\|eyJ[A-Za-z0-9_-]{10,}\|@example\.test\|jazz\|password\|totp'` บนไฟล์ | 0 แถว (ยกเว้นคำที่เป็นชื่อ route/eventCode) · ไม่มี query string · `actorId` เป็น id ภายใน | ลบไฟล์หลังตรวจ |
| API-SEC-041 | audit ไม่มีความลับ | - | `ca "$API/v1/admin/audit?includeReads=1&limit=100"` | ไม่มี token, support code, ticket, download path, อีเมลที่ค้น, `holder`, evidence keys | - |
| API-SEC-042 | error ไม่รั่ว stack/SQL | - | ส่งค่าประหลาดหลายแบบ: JSON ซ้อนลึก 1000 ชั้น (`python3 -c 'print("["*1000+"]"*1000)'`), ตัวเลข `1e400`, UUID ที่ถูก regex แต่ผิด version ในทุก path, If-Match `"999999999999999"` | ทุก body มีแค่ `code, messageKey, requestId, details` · ไม่มี `stack`, `at `, `SELECT`, `pg`, `node_modules`, `Error:` | - |
| API-SEC-043 | 500 แบบทั่วไป | ถ้าพบ 500 ใด | - | body `{code:"INTERNAL", messageKey, requestId, details:{}}` | รายงานทุก 500 เป็น FAIL พร้อม requestId |
| API-SEC-044 | messageKey ตรงรหัส | - | สุ่ม error 10 แบบ | `messageKey` เป็น key (เช่น `errors.request.tooLarge`) ไม่ใช่ข้อความภาษาคน | - |
| API-SEC-045 | เวลาตอบของ 404 ต่อ id ที่มี/ไม่มี | - | API-SEC-010 vs `$(uuid)` | ไม่ต่างกันจนเดาได้ (ข้อสังเกต) | - |

---

## 30. ลำดับการทำงานที่แนะนำ

1. 0.2 ตรวจ env → เตรียม token ทุกตัว → HLT, AUTH (ยกเว้น 014/015), ME
2. SET → DEV (001-038, ไม่รวม 040+) → DPF → SYN (ต้องมีสถานี published: ทำ STN-020, RGT-001, STN-072 ก่อน) → DIA → SUP → EXP
3. Admin: STN, RGT, SHC, CAT, DIR, DBL, ACF/CFG, AUD, LOG, JOB, USR, OVR, MET
4. BFF (หัวข้อ 26A; BFF-017/018 ต้องรอ token หมดอายุ) → CLI + SEC-005 (ต้องมี throwaway ที่ตั้ง TOTP) → IDM → RL (ทำท้ายสุดเพราะทำให้บัญชีติด limit 1 นาที)
5. case ที่ต้องได้รับอนุญาตจาก Tar: LOG-023, SUP-035/036 แล้ว HLT-008..011 (หยุด API แล้ว start ใหม่) → ท้ายสุด: DEV-040 (sign out "โทรศัพท์") → AUTH-015 → DEL (บัญชี throwaway) → AUTH-014
6. เก็บกวาด: STN-090, DBL-019, ACF-090, CLI revoke ทุก role, ลบไฟล์ export/CSV ในเครื่อง

---

## 31. Contract mismatches found

> **อัปเดต (Claude, PR #17):** แก้ครบทั้ง 8 ข้อแล้ว ถ้าทดสอบบนโค้ดที่รวม PR #17 แล้ว ให้ใช้ผลที่คาดหวังตามนี้แทนตาราง:
> 1. OpenAPI แก้ให้ตรงโค้ด: 3 route นี้ไม่สนใจ `Idempotency-Key` (คำตอบมีความลับ จึงไม่เก็บและไม่ replay)
> 2. OpenAPI แก้เป็น reason 10..500 ตัว
> 3. โค้ดรับ action 3 ส่วนแล้ว: `action=directory.block.add` กรองตรงตัวได้
> 4. โค้ดรับ `limit` เป็นตัวเลขฐานสิบล้วนเท่านั้น: `1e1`, `0x10`, ` 5` ได้ 400 `out_of_range`
> 5. โค้ดตอบ `{field:"body", reason:"must_be_object"}` แล้ว
> 6, 7, 8. OpenAPI แก้ให้ตรงโค้ด (ลบซ้ำได้ 403 `ACCOUNT_DELETING`, ETag มีเวลาเซ็นต่อท้าย, webhook จำกัด 600 ครั้ง/นาที/IP)
>
> ข้อสังเกตที่แก้ด้วย: job retry มี `Cache-Control: no-store` แล้ว; reason ทุกแบบและชื่อสถานีปฏิเสธ bidi, zero-width และ C1 แล้ว (400)

สิ่งที่โค้ดทำไม่ตรงกับ `services/api/openapi.proposal.yaml` (เอกสารนี้เขียนตามโค้ด):

| # | Route | OpenAPI บอก | โค้ดทำจริง | Case |
|---|---|---|---|---|
| 1 | `POST /v1/me/support-access/codes`, `POST /v1/me/exports/{id}/link`, `POST /v1/admin/users/lookup` | รับ `Idempotency-Key` (replay + `Idempotent-Replayed`, 400 key ผิดรูปแบบ, 409 key ซ้ำ body ต่าง) | ไม่สนใจ header เลย (อยู่ในรายการ SECRET_ANSWERS): ไม่ replay, ไม่ 400, ไม่ 409 ทุกครั้งได้ code/ลิงก์ใหม่ และ lookup ถูก audit ทุกครั้ง | API-SUP-004, API-EXP-021, API-USR-013 |
| 2 | `POST /v1/admin/directory/blocks/{blockId}/remove` | body ใช้ schema `Reason` (`minLength: 1`) | `parseBlockReason`: reason ต้อง 10..500 ตัว ห้าม C0/C1 | API-DBL-016 |
| 3 | `GET /v1/admin/audit` `action` | pattern รับสูงสุด 2 ส่วน | โค้ดเขียน action 3 ส่วน (`directory.block.add`, `directory.block.remove`) จึงกรองแบบตรงตัวไม่ได้ กรองได้แค่ทั้งตระกูล `directory` | API-AUD-005, API-DBL-018 |
| 4 | `GET /v1/sync/pull` `limit` | integer 1..100 | ใช้ `Number()` จึงรับ `1e1`, `0x10`, ` 5` | API-SYN-044 |
| 5 | `PATCH /v1/admin/config/draft` | body ที่ไม่ใช่ object → `must_be_object` | array/primitive ถูกห่อเป็น `{body}` จึงได้ `{field:"body", reason:"unknown_field"}` | API-ACF-017 |
| 6 | `DELETE /v1/me/account` | มี header `Idempotent-Replayed` ใน response | replay เกิดไม่ได้ เพราะคำขอที่สองถูก AuthGuard ปฏิเสธ 403 `ACCOUNT_DELETING` ก่อนถึง idempotency (เช่นเดียวกับ `DELETE /v1/me`) | API-DEL-005 |
| 7 | `GET /v1/config` ETag | `"r<release>-<kid>"` หรือ `"d-<channel>-<kid>"` | ต่อท้ายด้วยเวลาที่เซ็นแบบ base36: `"r<release>-<kid>-<signedAt>"` และเปลี่ยนทุกครั้งที่เซ็นใหม่ (ทุก 1 ชม.) | API-CFG-001, API-CFG-004 |
| 8 | `POST /v1/webhooks/apple`, `/google` | "Not rate limited" | rate limit 600 ครั้ง/นาที/IP (`catalogPerMinutePerIp × 10`) | API-BIL-017 |

ข้อสังเกตที่ไม่ใช่ mismatch แต่ควรแจ้งทีม:
- `POST /v1/admin/jobs/{id}/retry` ตอบ 200 โดยไม่มี `Cache-Control: no-store` (route admin อื่นมีทุกตัว)
- `parseExportReason` (export, lookup, jobs, support access) และ reason ของ config/directory block ไม่ห้าม bidi (U+202A-202E, U+2066-2069) และ zero-width ส่วน `parseExportReason` ไม่ห้าม C1 ด้วย ในขณะที่ข้อความของสถานีห้าม bidi
- station `name` ไม่ห้าม zero-width (U+200B-200F) ซึ่ง directory `q` ลบทิ้ง
- `POST /v1/admin/users/lookup` รับ UUID ทุกเวอร์ชัน ส่วน path อื่นรับเฉพาะ v1-8
- `GET /v1/catalog/radio` บีบ `limit` 0 และ 101-999 แทนที่จะตอบ 400 (ตรงกับ OpenAPI แต่ต่างจาก endpoint อื่น)
- header ใหญ่เกิน 16 KB ได้ 431 จาก Node ไม่ใช่ error envelope
- JSON ระดับบนสุดที่เป็น string/number/null ได้ 400 `malformed_body` จาก parser แบบ strict ไม่ใช่ `body_must_be_object`
