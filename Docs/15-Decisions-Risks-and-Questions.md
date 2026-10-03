# Decisions, Risks and Open Questions

Revision 0.2 · 2026-10-04 · ผู้ใช้ยืนยัน Flutter iOS/Android, CarPlay/Android Auto, internet radio และ Backend website/Login/Settings/Monitor/Logs แล้ว. Stack backend/vendor/versions และข้อจำกัดที่เหลือเป็น working defaults ตามเอกสาร ไม่ใช่ผลทดสอบ

## Active decisions

| ADR | Decision | Reason / consequence | Revisit trigger |
|---|---|---|---|
| ADR-01 | Flutter mobile iOS/Android | ตามคำขอผู้ใช้; Dart UI/domain + native car/media adapters | ข้อจำกัดจาก prototype ต้องแก้ adapter ก่อนเปลี่ยน stack |
| ADR-02 | AVPlayer iOS + Media3 Android | native-owned playback/background lifecycle, typed bridge | required codec/metadata fixture ไม่รองรับ |
| ADR-03 | SQLite single writer + atomic native snapshot | offline library, cold car start โดย Flutter UI ไม่ต้องเปิด | measured resource/migration problems |
| ADR-04 | CarPlay + Android Auto audio R1; CarPlay video gated R2 | ทั้งสอง platform เป็น required scope; distinct capability gates | separate verified video research |
| ADR-05 | disclosed config, no review shield/GPS unlock | system/platform restrictions ไม่อยู่ใน mutable config | public API guidance changes |
| ADR-06 | Backend + OIDC accounts + web Login | customer settings/device sync; staff console scopes/MFA | identity/hosting decision from SP-08 |
| ADR-07 | Backend metadata sync แทน CloudKit-only | iOS/Android/Web; R1 settings/catalog favorites, R1.1 private-library metadata | secure full-source transfer requirement |
| ADR-08 | Internet radio catalog publishes only approved rights | owned demo/user sources available; no unverified bundled stations | RightsRecord approved |
| ADR-09 | TH/EN, System/Light/Dark; native car appearance | shared Flutter UX, accessible mobile/web | user research supports more locales |
| ADR-10 | Next.js web + NestJS modular monolith + PostgreSQL | user/admin forms/log search + API contracts; concrete working stack | SP-08 measured requirements |
| ADR-11 | Direct media from origins | backend controls config/catalog not audio/video egress | explicit licensed proxy use case and budget |
| ADR-12 | StoreKit/Play Billing + server verify, store-scoped Pro R1 | account settings cross-platform; paid entitlement linking must be verified | approved shared entitlement commercial policy |
| ADR-13 | Operational logs/audit + opt-in client diagnostics | monitor without leaking private source/listening content | added telemetry requirement with privacy review |

ADR-01/02/04/06/07 แทน revision 0.1 Swift-first/Apple-only/no-backend/CloudKit decisions ตาม steering ของผู้ใช้ ไม่รออนุมัติ Flutter หรือ Android ซ้ำ

## Risk register

H/M/L เป็น qualitative estimate ไม่ใช่ readiness score

| ID | Risk / likelihood / impact | Mitigation / stop condition | Owner |
|---|---|---|---|
| R-01 | CarPlay entitlement delayed M/H | request early; internal mobile alpha ต่อได้, full scope release รอ evidence | Native/iOS |
| R-02 | Car video varies by car H/H | SP-04 + support matrix; defer video | Native/iOS |
| R-03 | Catalog/EPG rights unclear H/H | user sources + owned demo; publish gate | Product/content |
| R-04 | Parser/network resource abuse M/H | limits, redirect/IP checks, malformed fixtures | Core/security |
| R-05 | Dual-engine codec/ICY differences M/H | SP-02/07 + per-platform capability results | Media lead |
| R-06 | Tokens/PII leak M/H | encrypted secret refs, redacted logs, token canary tests | Security |
| R-07 | Sync conflict/data loss M/H | server CAS, tombstones, namespaces, reconciliation | Backend/core |
| R-08 | Lifetime support + backend costs M/H | recurring budget/reserve/cohort economics | Product/finance |
| R-09 | Expanded scope exceeds team H/H | revised roadmap capacity, re-estimate after G0 | Product/engineering |
| R-10 | Superiority claim unsupported M/H | paired usability/performance study | Product/QA |
| R-11 | Flutter detach/cold Auto service failure M/H | native ownership/snapshot + SP-06, real head unit | Android/native |
| R-12 | Cross-account/admin privilege leak M/H | object-scoped API, RBAC/MFA and IDOR tests | Backend/security |
| R-13 | Identity/API outage M/H | cached local settings/direct playback, bounded queues, fail-closed auth | Operations |
| R-14 | Catalog checker SSRF M/H | reviewed public endpoints, validated DNS/IP+restricted egress | Backend/security |
| R-15 | Observability cost/storage growth M/M | bounded ingest/query/retention, budget alerts | Operations |
| R-16 | Backup restores deleted accounts M/H | deletion ledger replay + restore drill | Operations/privacy |

## Open decisions and working defaults

| ID | Question | Working default | Deadline / scope impact | Owner |
|---|---|---|---|---|
| Q-01 | Public product name | TuneDeck | before bundle/store setup | Product |
| Q-02 | Team/budget/launch date | Flutter+native capability, backend/web, part-time QA/ops; no committed date | after G0 for delivery commitment | Product |
| Q-03 | Mac/iOS/Android devices, developer accounts and car access | unknown availability | signed builds/real-device gates | Engineering |
| Q-04 | Car video mandatory in first version? | audio R1; gated video R2 | separate scope decision if changed | Product |
| Q-05 | Which station/logo/EPG rights are cleared? | no presumed approval; owned demo | catalog publish gate | Content |
| Q-06 | Price/storefront/shared purchase policy | $24.99 test anchor; store-scoped R1 | product configuration/marketing | Product/finance |
| Q-07 | Deployment minima | proposed iOS 17 / Android 10 API29; target SDK current release rules | SP-01 | Native leads |
| Q-08 | Source secrets on web / full-source sync needed? | metadata only, private URL per-device | before advanced sync implementation | Product/security |
| Q-09 | Privacy/support/operator identity | unknown | public policies/submission | Business |
| Q-10 | Cloud region/provider/domain and monthly budget | vendor-neutral containers, PostgreSQL, Keycloak default | SP-08 sizing before provision | Backend/operations |
| Q-11 | Staff memberships and support access | invite-only/MFA/least privilege | first admin deployment | Business/security |
| Q-12 | 24/7 support/alert destinations | staffed hours; destination not yet configured | before promised SLA | Operations |

คำถามเหล่านี้ไม่ block การเขียน foundation/contract prototypes; items ที่มี release impact ต้องปิดด้วย evidence ก่อน launch. ไม่ถือว่าเวลารอแปลเป็นคำอนุมัติ

## Evidence gates — current status

| Gate | Evidence | Status |
|---|---|---|
| G-01 Flutter/native toolchain | signed iOS+Android builds, pinned deps/bridge | Not run |
| G-02 Media/import parity | AVPlayer/Media3 fixtures/profiles | Not run |
| G-03 CarPlay audio | entitlement + real car | Unknown / not run |
| G-04 Content/privacy | rights ledger, actual inventory/policy/network audit | Not approved |
| G-05 Store billing | Apple/Google/server verification/restore/replay | Not run |
| G-06 Beta quality | platform-specific QA/NFR reports | Not run |
| G-07 Competitive claims | WIN scorecard and limitations | Not run |
| G-08 CarPlay video | SP-04 | Deferred |
| G-09 Android Auto | SP-06, DHU+real head unit, UI closed | Not run |
| G-10 Account and permissions | PKCE/BFF/MFA/revoke/IDOR/RBAC | Not run |
| G-11 Backend/web/operations | config sync/logs/alerts/load/restore/delete | Not run |

## Change process

ADR changes include context, options, decision, owner/date, consequences and evidence. Update PRD/backlog/QA/privacy/paywall when scope/data collection/config/billing changes. เอกสารครบไม่ทำให้ Not run กลายเป็น Pass; release evidence ต้องมาจาก build/services ที่ทำจริง
