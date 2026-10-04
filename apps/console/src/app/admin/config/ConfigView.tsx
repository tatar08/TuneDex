"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { formatLogTime, RATE_LIMITED } from "@/lib/admin";
import type {
  AdminConfigView,
  AppConfigPayload,
  ConfigFeature,
  ConfigRelease,
} from "@/lib/bff";
import { useAdmin } from "../AdminShell";

/**
 * App configuration (Doc 17 /admin/config): one draft, a different admin publishes exactly the revision they
 * reviewed, and a rollback re-releases an earlier payload as a new release. The apps receive the newest release
 * signed by the API. Only allowlisted fields exist: minimum build, disable-only feature switches and the catalog
 * refresh interval (Doc 14). Data is shared; each theme lays the page out its own way (Tar, 2026-10-03).
 */
const FEATURES: { id: ConfigFeature; label: string; hint: string }[] = [
  {
    id: "catalogBrowse",
    label: "เลือกสถานีจากแค็ตตาล็อก",
    hint: "ปิดแล้วแอปยังเล่นสถานีที่บันทึกไว้ได้",
  },
  {
    id: "playlistImport",
    label: "นำเข้าเพลย์ลิสต์ M3U/EPG",
    hint: "ปิดเมื่อพบปัญหาในการนำเข้า",
  },
  {
    id: "diagnosticsUpload",
    label: "ส่งรายงานวินิจฉัย",
    hint: "ส่งเฉพาะผู้ใช้ที่ยินยอม",
  },
];
const FIELD_LABEL: Record<string, string> = {
  "minSupportedBuild.ios": "build ขั้นต่ำ iOS",
  "minSupportedBuild.android": "build ขั้นต่ำ Android",
  "features.catalogBrowse": "แค็ตตาล็อก",
  "features.playlistImport": "นำเข้าเพลย์ลิสต์",
  "features.diagnosticsUpload": "รายงานวินิจฉัย",
  catalogRefreshHours: "รอบรีเฟรชแค็ตตาล็อก",
};
const BLOCKER_LABEL: Record<string, string> = {
  admin_role_required: "ต้องเป็นแอดมินจึงจะเผยแพร่ได้",
  own_change: "คุณแก้ร่างนี้เอง ต้องให้แอดมินอีกคนตรวจและเผยแพร่",
  no_changes: "ร่างตรงกับที่แอปใช้อยู่แล้ว ไม่มีอะไรต้องเผยแพร่",
};
const DAYS = [7, 14, 30, 60, 90];

const buildLabel = (b: number | null) =>
  b === null ? "ไม่บังคับ" : `build ${b}`;
function daysLeft(iso: string, now = Date.now()) {
  return Math.ceil((new Date(iso).getTime() - now) / 86_400_000);
}
function expiryText(r: ConfigRelease) {
  const d = daysLeft(r.expiresAt);
  return d <= 0
    ? "หมดอายุแล้ว แอปกลับไปใช้ค่าเริ่มต้น"
    : `หมดอายุใน ${d} วัน (${formatLogTime(r.expiresAt)})`;
}
const expiringSoon = (r: ConfigRelease | null) =>
  !!r && daysLeft(r.expiresAt) < 7;
const changedList = (fields: string[]) =>
  fields.map((f) => FIELD_LABEL[f] ?? f).join(", ");

/** The settings of one payload as short lines, for release cards and the "in use now" summary. */
function Summary({
  config,
  className = "cf-sum",
}: {
  config: AppConfigPayload;
  className?: string;
}) {
  return (
    <ul className={className}>
      <li>
        iOS ขั้นต่ำ <b>{buildLabel(config.minSupportedBuild.ios)}</b>
      </li>
      <li>
        Android ขั้นต่ำ <b>{buildLabel(config.minSupportedBuild.android)}</b>
      </li>
      {FEATURES.map((f) => (
        <li key={f.id} className={config.features[f.id] ? undefined : "cf-off"}>
          {f.label} <b>{config.features[f.id] ? "เปิด" : "ปิด"}</b>
        </li>
      ))}
      <li>
        รีเฟรชแค็ตตาล็อกทุก <b>{config.catalogRefreshHours} ชั่วโมง</b>
      </li>
    </ul>
  );
}

const PROBLEMS: Record<number, string> = {
  400: "ค่าบางช่องไม่ถูกต้อง",
  401: "หมดเวลาใช้งาน เข้าสู่ระบบใหม่แล้วลองอีกครั้ง",
  403: "บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้ (ต้องเป็นแอดมิน)",
  404: "ไม่พบรุ่นที่เลือกแล้ว",
  412: "มีคนแก้ร่างก่อนคุณ โหลดหน้าใหม่เพื่อดูร่างล่าสุดแล้วลองอีกครั้ง",
  429: RATE_LIMITED,
};
const FIELD_PROBLEM: Record<string, string> = {
  reason: "กรอกเหตุผล 10–500 ตัวอักษร",
  "minSupportedBuild.ios":
    "build ขั้นต่ำ iOS ต้องเป็นเลขจำนวนเต็มตั้งแต่ 1 หรือเว้นว่าง",
  "minSupportedBuild.android":
    "build ขั้นต่ำ Android ต้องเป็นเลขจำนวนเต็มตั้งแต่ 1 หรือเว้นว่าง",
  catalogRefreshHours: "รอบรีเฟรชต้องอยู่ระหว่าง 1–168 ชั่วโมง",
  validDays: "อายุของรุ่นต้องอยู่ระหว่าง 7–90 วัน",
};

/** Sends one change through the BFF and turns the API's answer into a Thai message. */
function useSend() {
  const { csrfToken } = useAdmin();
  return async (
    method: "PATCH" | "POST",
    url: string,
    body: unknown,
    ifMatch?: number,
  ): Promise<{ ok: true } | { ok: false; message: string }> => {
    try {
      const res = await fetch(url, {
        method,
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
          ...(ifMatch === undefined ? {} : { "if-match": `"${ifMatch}"` }),
        },
        body: JSON.stringify(body),
      });
      if (res.ok) return { ok: true };
      const b = (await res.json().catch(() => ({}))) as {
        code?: string;
        details?: { field?: string; reasons?: string[] };
      };
      if (b.code === "PUBLISH_BLOCKED") {
        const r = b.details?.reasons ?? [];
        return {
          ok: false,
          message: r.includes("already_current")
            ? "รุ่นนี้คือรุ่นที่ใช้อยู่แล้ว"
            : r.map((x) => BLOCKER_LABEL[x] ?? x).join(" · ") ||
              "ยังเผยแพร่ไม่ได้",
        };
      }
      return {
        ok: false,
        message:
          (b.details?.field && FIELD_PROBLEM[b.details.field]) ||
          PROBLEMS[res.status] ||
          "บันทึกไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง",
      };
    } catch {
      return { ok: false, message: "บันทึกไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง" };
    }
  };
}

/** The last action's outcome, shown above the page so it survives the refresh. */
const Flash = createContext<(msg: string) => void>(() => undefined);

const toBuild = (v: string): number | null | "bad" =>
  v.trim() === ""
    ? null
    : /^\d{1,10}$/.test(v.trim())
      ? Number(v.trim())
      : "bad";

/** The draft form. Admins edit; everyone else sees the same fields read-only. Saves with If-Match. */
function DraftForm({
  view,
  className = "",
}: {
  view: AdminConfigView;
  className?: string;
}) {
  const { isAdmin } = useAdmin();
  const router = useRouter();
  const send = useSend();
  const flash = useContext(Flash);
  const d = view.draft.config;
  const [ios, setIos] = useState(d.minSupportedBuild.ios?.toString() ?? "");
  const [android, setAndroid] = useState(
    d.minSupportedBuild.android?.toString() ?? "",
  );
  const [features, setFeatures] = useState(d.features);
  const [hours, setHours] = useState(String(d.catalogRefreshHours));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  async function save(ev: React.FormEvent) {
    ev.preventDefault();
    const i = toBuild(ios);
    const a = toBuild(android);
    if (i === "bad" || a === "bad")
      return setProblem(
        FIELD_PROBLEM[
          i === "bad" ? "minSupportedBuild.ios" : "minSupportedBuild.android"
        ],
      );
    if (!/^\d{1,3}$/.test(hours.trim()))
      return setProblem(FIELD_PROBLEM.catalogRefreshHours);
    setBusy(true);
    setProblem("");
    const r = await send(
      "PATCH",
      "/bff/admin/config/draft",
      {
        minSupportedBuild: { ios: i, android: a },
        features,
        catalogRefreshHours: Number(hours),
      },
      view.draft.revision,
    );
    setBusy(false);
    if (!r.ok) return setProblem(r.message);
    flash("บันทึกร่างแล้ว แอปยังไม่เห็นจนกว่าแอดมินอีกคนจะเผยแพร่");
    router.refresh();
  }

  return (
    <form
      className={`cf-form ${className}`}
      onSubmit={save}
      aria-label="ร่างตั้งค่าแอป"
    >
      <fieldset disabled={!isAdmin || busy}>
        <legend className="sr-only">ร่างตั้งค่าแอป</legend>
        <div className="cf-fs">
          <div className="cf-builds">
            <label className="fld">
              <span>build ขั้นต่ำ iOS</span>
              <input
                id="cf-ios"
                inputMode="numeric"
                value={ios}
                onChange={(e) => setIos(e.target.value)}
                placeholder="ไม่บังคับ"
              />
            </label>
            <label className="fld">
              <span>build ขั้นต่ำ Android</span>
              <input
                id="cf-android"
                inputMode="numeric"
                value={android}
                onChange={(e) => setAndroid(e.target.value)}
                placeholder="ไม่บังคับ"
              />
            </label>
            <label className="fld">
              <span>รีเฟรชแค็ตตาล็อกทุก (ชั่วโมง)</span>
              <input
                id="cf-refresh"
                inputMode="numeric"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
              />
            </label>
          </div>
          <small className="dim">
            แอปที่ build ต่ำกว่านี้จะขอให้อัปเดตก่อนใช้งานออนไลน์ เว้นว่างได้
          </small>
          <div className="cf-feats" role="group" aria-label="ฟีเจอร์">
            {FEATURES.map((f) => (
              <label key={f.id} className="cf-feat">
                <input
                  type="checkbox"
                  checked={features[f.id]}
                  onChange={(e) =>
                    setFeatures({ ...features, [f.id]: e.target.checked })
                  }
                />
                <span>
                  <b>{f.label}</b>
                  <small className="dim">{f.hint}</small>
                </span>
              </label>
            ))}
          </div>
          <small className="dim">
            ปิดได้เฉพาะฟีเจอร์ที่มีอยู่ในแอปแล้ว
            ใช้เปิดฟีเจอร์ใหม่ที่แอปไม่มีไม่ได้
          </small>
        </div>
      </fieldset>
      {problem && (
        <p role="alert" className="au-export-err">
          {problem}
        </p>
      )}
      {isAdmin ? (
        <button type="submit" className="btn" disabled={busy}>
          {busy ? "กำลังบันทึก…" : "บันทึกร่าง"}
        </button>
      ) : (
        <p className="dim">ดูได้อย่างเดียว เฉพาะแอดมินแก้ไขได้</p>
      )}
    </form>
  );
}

/** Publish the reviewed draft revision with a reason and a validity period. */
function Publish({ view }: { view: AdminConfigView }) {
  const router = useRouter();
  const send = useSend();
  const flash = useContext(Flash);
  const [reason, setReason] = useState("");
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const { changedSinceRelease, revision } = view.draft;
  const blocked = view.publishBlockers.length > 0;
  // "No changes" is already said by the line above; list only the blockers that need someone to act.
  const shown = view.publishBlockers.filter((b) => b !== "no_changes");

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setProblem("");
    const r = await send(
      "POST",
      "/bff/admin/config/publish",
      { reason, validDays: days },
      revision,
    );
    setBusy(false);
    if (!r.ok) return setProblem(r.message);
    flash("เผยแพร่แล้ว แอปจะได้รับเมื่อเปิดแอปหรือเชื่อมต่อครั้งถัดไป");
    setReason("");
    router.refresh();
  }

  return (
    <form className="cf-publish" onSubmit={submit} aria-label="เผยแพร่ร่าง">
      <p>
        {changedSinceRelease.length ? (
          <>
            ร่าง r{revision} ต่างจากที่ใช้อยู่:{" "}
            <b>{changedList(changedSinceRelease)}</b>
          </>
        ) : (
          <>ร่าง r{revision} ตรงกับที่แอปใช้อยู่</>
        )}
      </p>
      {blocked ? (
        shown.length > 0 && (
          <ul className="cf-blockers">
            {shown.map((b) => (
              <li key={b}>{BLOCKER_LABEL[b] ?? b}</li>
            ))}
          </ul>
        )
      ) : (
        <>
          <label className="fld">
            <span>เหตุผล (จะถูกบันทึกไว้ในประวัติ)</span>
            <textarea
              id="cf-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              minLength={10}
              maxLength={500}
              rows={2}
              required
            />
          </label>
          <label className="fld cf-days">
            <span>ใช้ได้นาน</span>
            <select
              id="cf-days"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              {DAYS.map((d) => (
                <option key={d} value={d}>
                  {d} วัน
                </option>
              ))}
            </select>
          </label>
          {problem && (
            <p role="alert" className="au-export-err">
              {problem}
            </p>
          )}
          <button type="submit" className="btn" disabled={busy}>
            {busy ? "กำลังเผยแพร่…" : `เผยแพร่ร่าง r${revision}`}
          </button>
        </>
      )}
    </form>
  );
}

/** "Roll back to this release" with a required reason. One admin may do this alone. */
function Rollback({
  release,
  className = "btn secondary",
}: {
  release: ConfigRelease;
  className?: string;
}) {
  const router = useRouter();
  const send = useSend();
  const flash = useContext(Flash);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setProblem("");
    const r = await send(
      "POST",
      `/bff/admin/config/releases/${release.release}/rollback`,
      { reason },
    );
    setBusy(false);
    if (!r.ok) return setProblem(r.message);
    flash(
      `ย้อนกลับไปใช้ค่าของรุ่น ${release.release} แล้ว (เป็นรุ่นใหม่ในประวัติ)`,
    );
    setOpen(false);
    router.refresh();
  }

  return (
    <div className="jb-retry">
      <button
        type="button"
        className={className}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ย้อนไปใช้รุ่น {release.release}
      </button>
      {open && (
        <form
          className="au-export-panel"
          onSubmit={submit}
          aria-label={`ย้อนไปใช้รุ่น ${release.release}`}
        >
          <label className="fld">
            <span>เหตุผล (จะถูกบันทึกไว้ในประวัติ)</span>
            <textarea
              ref={ref}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              minLength={10}
              maxLength={500}
              rows={2}
              required
            />
          </label>
          <small className="dim">
            ร่างไม่เปลี่ยน ระบบจะออกรุ่นใหม่ที่ใช้ค่าเดียวกับรุ่น{" "}
            {release.release}
          </small>
          {problem && (
            <p role="alert" className="au-export-err">
              {problem}
            </p>
          )}
          <div className="row">
            <button type="submit" className="btn" disabled={busy}>
              {busy ? "กำลังย้อน…" : "ย้อนกลับ"}
            </button>
            <button
              type="button"
              className="btn secondary"
              onClick={() => setOpen(false)}
            >
              ยกเลิก
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function ReleaseMeta({ r }: { r: ConfigRelease }) {
  return (
    <small className="dim">
      {formatLogTime(r.publishedAt)}
      {r.rollbackOf
        ? ` · ย้อนจากรุ่น ${r.rollbackOf}`
        : ` · จากร่าง r${r.draftRevision}`}
      {r.publishedByYou ? " · คุณเผยแพร่" : ""}
    </small>
  );
}

/** Earlier releases, newest first, each with its reason and (for admins) a rollback. */
function Releases({
  view,
  className = "cf-rel",
}: {
  view: AdminConfigView;
  className?: string;
}) {
  const { isAdmin } = useAdmin();
  if (view.releases.length === 0)
    return <p className="dim">ยังไม่เคยเผยแพร่ แอปใช้ค่าเริ่มต้นของแอปเอง</p>;
  return (
    <ol className={className}>
      {view.releases.map((r) => (
        <li key={r.release}>
          <div className="cf-rel-head">
            <b>รุ่น {r.release}</b>
            {r.release === view.current?.release && (
              <span className="tag jb-completed">ใช้อยู่</span>
            )}
          </div>
          <ReleaseMeta r={r} />
          <p className="cf-reason">{r.reason}</p>
          {isAdmin && r.release !== view.current?.release && (
            <Rollback release={r} />
          )}
        </li>
      ))}
    </ol>
  );
}

function Current({ view }: { view: AdminConfigView }) {
  const c = view.current;
  return (
    <div className="cf-current">
      {c ? (
        <>
          <p>
            แอปใช้ <b>รุ่น {c.release}</b> ·{" "}
            <span className={expiringSoon(c) ? "jb-late" : undefined}>
              {expiryText(c)}
            </span>
          </p>
          <Summary config={c.config} />
        </>
      ) : (
        <>
          <p>ยังไม่เคยเผยแพร่ แอปใช้ค่าเริ่มต้นของแอปเอง</p>
          <Summary config={view.defaults} />
        </>
      )}
    </div>
  );
}

const Note = ({ view }: { view: AdminConfigView }) => (
  <p className="ov-foot dim">
    แอปรับค่าใหม่ตอนเปิดแอปหรือเชื่อมต่อใหม่ ไม่ใช่ทันที ·
    ทุกรุ่นมีลายเซ็นจากเซิร์ฟเวอร์ (กุญแจ {view.signingKeyId})
    แอปจะเชื่อเฉพาะค่าที่ลายเซ็นถูกต้อง · รุ่นที่หมดอายุแล้ว
    แอปจะกลับไปใช้ค่าเริ่มต้น
  </p>
);

function Problem({ status }: { status: number }) {
  return (
    <div className="adm-alert" role="alert">
      {status === 403
        ? "บัญชีนี้ไม่มีสิทธิ์ดูตั้งค่าแอป (ต้องเป็นโอเปอเรเตอร์หรือแอดมิน)"
        : status === 429
          ? RATE_LIMITED
          : "โหลดตั้งค่าแอปไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง"}
    </div>
  );
}

export function ConfigView(props: { view?: AdminConfigView; status: number }) {
  const [flash, setFlash] = useState("");
  if (!props.view) return <Problem status={props.status} />;
  return (
    <Flash.Provider value={setFlash}>
      {flash && (
        <p className="adm-ok jb-flash" role="status">
          {flash}
        </p>
      )}
      {/* Keyed by revision so the form picks up the saved draft after a refresh. */}
      <Layout key={props.view.draft.revision} view={props.view} />
    </Flash.Provider>
  );
}

function Layout({ view }: { view: AdminConfigView }) {
  const { theme } = useAdmin();
  const c = view.current;

  if (theme === "control-room") {
    return (
      <div className="cr-page cf">
        <div className="top">
          <div className="crumb">
            Operations<b>ตั้งค่าแอป</b>
          </div>
        </div>
        <div className="ov-kpis jb-kpis">
          <div className="pn">
            <small>รุ่นที่ใช้</small>
            <b className="mo">{c ? c.release : "—"}</b>
          </div>
          <div className={`pn${expiringSoon(c) ? " warn" : ""}`}>
            <small>หมดอายุใน</small>
            <b className="mo">
              {c ? `${Math.max(daysLeft(c.expiresAt), 0)} วัน` : "—"}
            </b>
          </div>
          <div
            className={`pn${view.draft.changedSinceRelease.length ? " warn" : ""}`}
          >
            <small>รอเผยแพร่</small>
            <b className="mo">{view.draft.changedSinceRelease.length} ค่า</b>
          </div>
        </div>
        <div className="cf-cols">
          <div className="pn">
            <h3>ร่าง r{view.draft.revision}</h3>
            <DraftForm view={view} />
          </div>
          <div className="pn">
            <h3>เผยแพร่</h3>
            <Publish view={view} />
            <h3>ที่แอปใช้อยู่</h3>
            <Current view={view} />
          </div>
        </div>
        <div className="pn">
          <h3>ประวัติรุ่น</h3>
          <Releases view={view} />
        </div>
        <Note view={view} />
      </div>
    );
  }

  if (theme === "broadcast-rack") {
    return (
      <div className="br-page cf">
        <div className="ttl">
          <h3>ตั้งค่าแอป · Remote config</h3>
          <span>
            {c
              ? `ON AIR รุ่น ${c.release} · ${expiryText(c)}`
              : "ยังไม่ออกอากาศ ใช้ค่าเริ่มต้น"}
          </span>
        </div>
        <div className="cf-rack">
          <section className="adm-panel">
            <h4>
              <i className="lamp jb-pending" aria-hidden="true" /> ร่าง r
              {view.draft.revision}
            </h4>
            <DraftForm view={view} />
          </section>
          <section className="adm-panel">
            <h4>
              <i
                className={`lamp ${c ? "jb-completed" : "jb-pending"}`}
                aria-hidden="true"
              />{" "}
              ออกอากาศ
            </h4>
            <Current view={view} />
            <Publish view={view} />
          </section>
        </div>
        <section className="adm-panel">
          <h4>ประวัติรุ่น</h4>
          <Releases view={view} />
        </section>
        <Note view={view} />
      </div>
    );
  }

  if (theme === "daylight-bento") {
    return (
      <div className="db-page cf">
        <div className="hello">
          <div>
            <h3>ตั้งค่าแอป</h3>
            <p>
              เวอร์ชันขั้นต่ำ ฟีเจอร์ที่ปิดชั่วคราว และรอบรีเฟรช ที่แอปจะได้รับ
            </p>
          </div>
        </div>
        <div className="cf-bento">
          <section className="b-kpi">
            <small>รุ่นที่แอปใช้</small>
            <b>{c ? c.release : "—"}</b>
          </section>
          <section className={`b-kpi${expiringSoon(c) ? " warn" : ""}`}>
            <small>หมดอายุใน</small>
            <b>{c ? `${Math.max(daysLeft(c.expiresAt), 0)} วัน` : "—"}</b>
          </section>
          <section className="b-wide cf-b-draft">
            <h4>ร่าง r{view.draft.revision}</h4>
            <DraftForm view={view} />
          </section>
          <section className="cf-b-pub">
            <h4>เผยแพร่</h4>
            <Publish view={view} />
          </section>
          <section className="cf-b-cur">
            <h4>ที่แอปใช้อยู่</h4>
            <Current view={view} />
          </section>
          <section className="b-wide">
            <h4>ประวัติรุ่น</h4>
            <Releases view={view} className="cf-rel cf-rel-grid" />
          </section>
        </div>
        <Note view={view} />
      </div>
    );
  }

  if (theme === "workbench") {
    return (
      <div className="split">
        <section className="list" aria-label="ประวัติรุ่น">
          <div className="lh">
            <h3>
              ตั้งค่าแอป <span>{view.releases.length}</span>
            </h3>
          </div>
          <div className="cf-wb-list">
            <Releases view={view} />
          </div>
        </section>
        <section className="det" aria-label="ร่างและการเผยแพร่">
          <div className="lg-detail">
            <p className="crumb">ตั้งค่าแอป / ร่าง r{view.draft.revision}</p>
            <h2>{c ? `แอปใช้รุ่น ${c.release}` : "ยังไม่เคยเผยแพร่"}</h2>
            {c && (
              <p className={expiringSoon(c) ? "jb-late" : "dim"}>
                {expiryText(c)}
              </p>
            )}
            <DraftForm view={view} />
            <hr />
            <Publish view={view} />
            <Note view={view} />
          </div>
        </section>
      </div>
    );
  }

  // Minimal (FinVault cards)
  return (
    <div className="fv-dash cf">
      <div className="fv-logstats">
        <section className="fv-card">
          <small className="fv-label">รุ่นที่แอปใช้</small>
          <p className="fv-amount">{c ? c.release : "—"}</p>
          <small>
            {c ? formatLogTime(c.publishedAt) : "ใช้ค่าเริ่มต้นของแอป"}
          </small>
        </section>
        <section className="fv-card">
          <small className="fv-label">หมดอายุใน</small>
          <p className={`fv-amount${expiringSoon(c) ? " hot" : ""}`}>
            {c ? `${Math.max(daysLeft(c.expiresAt), 0)} วัน` : "—"}
          </p>
          <small>เผยแพร่ใหม่ก่อนหมดอายุ</small>
        </section>
        <section className="fv-card">
          <small className="fv-label">รอเผยแพร่</small>
          <p className="fv-amount">{view.draft.changedSinceRelease.length}</p>
          <small>
            {view.draft.changedSinceRelease.length
              ? changedList(view.draft.changedSinceRelease)
              : "ร่างตรงกับที่ใช้อยู่"}
          </small>
        </section>
      </div>
      <div className="cf-cols">
        <section className="fv-card" aria-labelledby="fv-cf-draft">
          <div className="fv-card-head">
            <div>
              <h2 id="fv-cf-draft">ร่าง r{view.draft.revision}</h2>
              <small>
                {view.draft.updatedAt
                  ? `แก้ล่าสุด ${formatLogTime(view.draft.updatedAt)}`
                  : "ยังไม่เคยแก้"}
              </small>
            </div>
          </div>
          <DraftForm view={view} />
        </section>
        <section className="fv-card" aria-labelledby="fv-cf-pub">
          <div className="fv-card-head">
            <div>
              <h2 id="fv-cf-pub">เผยแพร่</h2>
              <small>ต้องให้แอดมินอีกคนตรวจ</small>
            </div>
          </div>
          <Publish view={view} />
          <h3 className="cf-sub">ที่แอปใช้อยู่</h3>
          <Current view={view} />
        </section>
      </div>
      <section className="fv-card" aria-labelledby="fv-cf-rel">
        <div className="fv-card-head">
          <div>
            <h2 id="fv-cf-rel">ประวัติรุ่น</h2>
            <small>ย้อนกลับได้โดยออกรุ่นใหม่ ไม่แก้ประวัติ</small>
          </div>
        </div>
        <Releases view={view} />
      </section>
      <Note view={view} />
    </div>
  );
}
