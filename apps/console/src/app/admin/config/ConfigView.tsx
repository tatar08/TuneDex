"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { formatLogTime, RATE_LIMITED } from "@/lib/admin";
import type {
  AdminConfigView,
  AppConfigPayload,
  ConfigFeature,
  ConfigRelease,
  ConfigTargets,
} from "@/lib/bff";
import type { Translate } from "@/lib/admin-i18n";
import { useAdmin, useT } from "../AdminShell";
import { LogoUpload } from "../LogoUpload";
import { isMfaRequired, MfaLink, MFA_NEEDED } from "../MfaPrompt";

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
  {
    id: "radioDirectory",
    label: "ค้นหาสถานีวิทยุทั่วโลก",
    hint: "สถานีจาก Radio Browser ที่ผู้ใช้เพิ่มเอง ปิดแล้วสถานีที่เพิ่มไว้ยังอยู่",
  },
  {
    id: "videoPlayback",
    label: "ดูช่องทีวีจากลิสต์ของผู้ใช้",
    hint: "ช่องวิดีโอจากเพลย์ลิสต์ที่ผู้ใช้นำเข้าเอง",
  },
  {
    id: "webBrowser",
    label: "เบราว์เซอร์ในแอป",
    hint: "เปิดเว็บอย่าง YouTube ภายในแอป",
  },
  {
    id: "carScreenVideo",
    label: "ภาพบนจอรถ",
    hint: "ทีวีและเบราว์เซอร์บน CarPlay / Android Auto ผู้ใช้ปิดเองได้ในตั้งค่าแอป ปิดตรงนี้คือปิดทุกคน",
  },
];
const FIELD_LABEL: Record<string, string> = {
  "minSupportedBuild.ios": "build ขั้นต่ำ iOS",
  "minSupportedBuild.android": "build ขั้นต่ำ Android",
  "features.catalogBrowse": "แค็ตตาล็อก",
  "features.playlistImport": "นำเข้าเพลย์ลิสต์",
  "features.diagnosticsUpload": "รายงานวินิจฉัย",
  "features.radioDirectory": "ค้นหาวิทยุทั่วโลก",
  "features.videoPlayback": "ช่องทีวี",
  "features.webBrowser": "เบราว์เซอร์ในแอป",
  "features.carScreenVideo": "ภาพบนจอรถ",
  catalogRefreshHours: "รอบรีเฟรชแค็ตตาล็อก",
  "targets.ios.include": "ส่งให้ iOS",
  "targets.ios.minBuild": "iOS ตั้งแต่ build",
  "targets.ios.maxBuild": "iOS ถึง build",
  "targets.android.include": "ส่งให้ Android",
  "targets.android.minBuild": "Android ตั้งแต่ build",
  "targets.android.maxBuild": "Android ถึง build",
};
const PLATFORMS = [
  { id: "ios", label: "iOS" },
  { id: "android", label: "Android" },
] as const;
const BLOCKER_LABEL: Record<string, string> = {
  admin_role_required: "ต้องเป็นแอดมินจึงจะเผยแพร่ได้",
  own_change: "คุณแก้ร่างนี้เอง ต้องให้แอดมินอีกคนตรวจและเผยแพร่",
  no_changes: "ร่างตรงกับที่แอปใช้อยู่แล้ว ไม่มีอะไรต้องเผยแพร่",
  not_staged: "ต้องส่งร่างนี้ขึ้น staging ก่อน แล้วจึงเผยแพร่จริงได้",
  already_staged: "ร่างนี้อยู่บน staging แล้ว",
  not_production: "ย้อนกลับได้เฉพาะรุ่นที่เคยใช้จริง ไม่ใช่รุ่น staging",
};

/** One line per platform: who receives the release. */
function targetsText(t: Translate, targets: ConfigTargets) {
  return PLATFORMS.map(({ id, label }) => {
    const r = targets[id];
    if (!r.include) return t("{0}: ไม่ส่ง", label);
    if (r.minBuild === null && r.maxBuild === null) return t("{0}: ทุก build", label);
    return t("{0}: build {1}–{2}", label, r.minBuild ?? t("แรก"), r.maxBuild ?? t("ล่าสุด"));
  }).join(" · ");
}
const DAYS = [7, 14, 30, 60, 90];

const buildLabel = (t: Translate, b: number | null) =>
  b === null ? t("ไม่บังคับ") : `build ${b}`;
function daysLeft(iso: string, now = Date.now()) {
  return Math.ceil((new Date(iso).getTime() - now) / 86_400_000);
}
function expiryText(t: Translate, r: ConfigRelease) {
  const d = daysLeft(r.expiresAt);
  return d <= 0
    ? t("หมดอายุแล้ว แอปกลับไปใช้ค่าเริ่มต้น")
    : t("หมดอายุใน {0} วัน ({1})", d, formatLogTime(r.expiresAt, t.lang));
}
const expiringSoon = (r: ConfigRelease | null) =>
  !!r && daysLeft(r.expiresAt) < 7;
const changedList = (t: Translate, fields: string[]) =>
  fields.map((f) => t(FIELD_LABEL[f] ?? f)).join(", ");

/** The settings of one payload as short lines, for release cards and the "in use now" summary. */
function Summary({
  config,
  className = "cf-sum",
}: {
  config: AppConfigPayload;
  className?: string;
}) {
  const t = useT();
  return (
    <ul className={className}>
      <li>
        {t("iOS ขั้นต่ำ")} <b>{buildLabel(t, config.minSupportedBuild.ios)}</b>
      </li>
      <li>
        {t("Android ขั้นต่ำ")} <b>{buildLabel(t, config.minSupportedBuild.android)}</b>
      </li>
      {FEATURES.map((f) => (
        <li key={f.id} className={config.features[f.id] ? undefined : "cf-off"}>
          {t(f.label)} <b>{config.features[f.id] ? t("เปิด") : t("ปิด")}</b>
        </li>
      ))}
      <li>
        {t("รีเฟรชแค็ตตาล็อกทุก")} <b>{t("{0} ชั่วโมง", config.catalogRefreshHours)}</b>
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
  targets: "ต้องส่งให้อย่างน้อยหนึ่งแพลตฟอร์ม",
};
const TARGET_PROBLEM: Record<"minBuild" | "maxBuild", string> = {
  minBuild: "build เริ่มต้นของ {0} ต้องเป็นเลขจำนวนเต็มตั้งแต่ 1 หรือเว้นว่าง",
  maxBuild: "build สุดท้ายของ {0} ต้องเป็นเลขตั้งแต่ 1 และไม่น้อยกว่า build เริ่มต้น หรือเว้นว่าง",
};
/** The message for one field the API (or the form) refused, in the viewer's language. */
function fieldProblem(t: Translate, field: string): string | undefined {
  const m = /^targets\.(ios|android)\.(minBuild|maxBuild)$/.exec(field);
  if (m) return t(TARGET_PROBLEM[m[2] as "minBuild" | "maxBuild"], PLATFORMS.find((p) => p.id === m[1])!.label);
  return FIELD_PROBLEM[field] ? t(FIELD_PROBLEM[field]) : undefined;
}

/** Sends one change through the BFF and turns the API's answer into a message in the viewer's language. */
function useSend() {
  const { csrfToken, t } = useAdmin();
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
      if (isMfaRequired(res.status, b))
        return { ok: false, message: t(MFA_NEEDED) };
      if (b.code === "PUBLISH_BLOCKED") {
        const r = b.details?.reasons ?? [];
        return {
          ok: false,
          message: r.includes("already_current")
            ? t("รุ่นนี้คือรุ่นที่ใช้อยู่แล้ว")
            : r.map((x) => t(BLOCKER_LABEL[x] ?? x)).join(" · ") ||
              t("ยังเผยแพร่ไม่ได้"),
        };
      }
      return {
        ok: false,
        message:
          (b.details?.field && fieldProblem(t, b.details.field)) ||
          (PROBLEMS[res.status] && t(PROBLEMS[res.status])) ||
          t("บันทึกไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง"),
      };
    } catch {
      return { ok: false, message: t("บันทึกไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง") };
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
  const { isAdmin, t } = useAdmin();
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
  const tg = view.draft.targets;
  const [targets, setTargets] = useState({
    ios: { include: tg.ios.include, min: tg.ios.minBuild?.toString() ?? "", max: tg.ios.maxBuild?.toString() ?? "" },
    android: { include: tg.android.include, min: tg.android.minBuild?.toString() ?? "", max: tg.android.maxBuild?.toString() ?? "" },
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  async function save(ev: React.FormEvent) {
    ev.preventDefault();
    const nextTargets = {} as ConfigTargets;
    for (const { id } of PLATFORMS) {
      const min = toBuild(targets[id].min);
      const max = toBuild(targets[id].max);
      if (min === "bad") return setProblem(fieldProblem(t, `targets.${id}.minBuild`)!);
      if (max === "bad") return setProblem(fieldProblem(t, `targets.${id}.maxBuild`)!);
      nextTargets[id] = { include: targets[id].include, minBuild: min, maxBuild: max };
    }
    const i = toBuild(ios);
    const a = toBuild(android);
    if (i === "bad" || a === "bad")
      return setProblem(
        t(
          FIELD_PROBLEM[
            i === "bad" ? "minSupportedBuild.ios" : "minSupportedBuild.android"
          ],
        ),
      );
    if (!/^\d{1,3}$/.test(hours.trim()))
      return setProblem(t(FIELD_PROBLEM.catalogRefreshHours));
    setBusy(true);
    setProblem("");
    const r = await send(
      "PATCH",
      "/bff/admin/config/draft",
      {
        minSupportedBuild: { ios: i, android: a },
        features,
        catalogRefreshHours: Number(hours),
        targets: nextTargets,
      },
      view.draft.revision,
    );
    setBusy(false);
    if (!r.ok) return setProblem(r.message);
    flash(t("บันทึกร่างแล้ว แอปยังไม่เห็นจนกว่าจะส่งขึ้น staging และแอดมินอีกคนเผยแพร่"));
    router.refresh();
  }

  return (
    <form
      className={`cf-form ${className}`}
      onSubmit={save}
      aria-label={t("ร่างตั้งค่าแอป")}
    >
      <fieldset disabled={!isAdmin || busy}>
        <legend className="sr-only">{t("ร่างตั้งค่าแอป")}</legend>
        <div className="cf-fs">
          <div className="cf-builds">
            <label className="fld">
              <span>{t("build ขั้นต่ำ iOS")}</span>
              <input
                id="cf-ios"
                inputMode="numeric"
                value={ios}
                onChange={(e) => setIos(e.target.value)}
                placeholder={t("ไม่บังคับ")}
              />
            </label>
            <label className="fld">
              <span>{t("build ขั้นต่ำ Android")}</span>
              <input
                id="cf-android"
                inputMode="numeric"
                value={android}
                onChange={(e) => setAndroid(e.target.value)}
                placeholder={t("ไม่บังคับ")}
              />
            </label>
            <label className="fld">
              <span>{t("รีเฟรชแค็ตตาล็อกทุก (ชั่วโมง)")}</span>
              <input
                id="cf-refresh"
                inputMode="numeric"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
              />
            </label>
          </div>
          <small className="dim">
            {t("แอปที่ build ต่ำกว่านี้จะขอให้อัปเดตก่อนใช้งานออนไลน์ เว้นว่างได้")}
          </small>
          <div className="cf-feats" role="group" aria-label={t("ฟีเจอร์")}>
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
                  <b>{t(f.label)}</b>
                  <small className="dim">{t(f.hint)}</small>
                </span>
              </label>
            ))}
          </div>
          <small className="dim">
            {t("ปิดได้เฉพาะฟีเจอร์ที่มีอยู่ในแอปแล้ว ใช้เปิดฟีเจอร์ใหม่ที่แอปไม่มีไม่ได้")}
          </small>
          <div className="cf-targets" role="group" aria-label={t("ส่งให้แอปไหน")}>
            {PLATFORMS.map(({ id, label }) => (
              <div key={id} className="cf-target">
                <label className="cf-feat">
                  <input
                    type="checkbox"
                    checked={targets[id].include}
                    onChange={(e) => setTargets({ ...targets, [id]: { ...targets[id], include: e.target.checked } })}
                  />
                  <span>
                    <b>{t("ส่งให้ {0}", label)}</b>
                  </span>
                </label>
                <label className="fld">
                  <span>{t("{0} ตั้งแต่ build", label)}</span>
                  <input
                    inputMode="numeric"
                    value={targets[id].min}
                    disabled={!targets[id].include}
                    onChange={(e) => setTargets({ ...targets, [id]: { ...targets[id], min: e.target.value } })}
                    placeholder={t("ทุก build")}
                  />
                </label>
                <label className="fld">
                  <span>{t("{0} ถึง build", label)}</span>
                  <input
                    inputMode="numeric"
                    value={targets[id].max}
                    disabled={!targets[id].include}
                    onChange={(e) => setTargets({ ...targets, [id]: { ...targets[id], max: e.target.value } })}
                    placeholder={t("ทุก build")}
                  />
                </label>
              </div>
            ))}
          </div>
          <small className="dim">
            {t("แอปที่อยู่นอกช่วงนี้จะไม่สนใจรุ่นนี้ และใช้รุ่นล่าสุดที่ตรงกับตัวเองต่อไป")}
          </small>
        </div>
      </fieldset>
      {problem && (
        <p role="alert" className="au-export-err">
          {problem}
          {problem === t(MFA_NEEDED) && (
            <>
              {" "}
              <MfaLink />
            </>
          )}
        </p>
      )}
      {isAdmin ? (
        <button type="submit" className="btn" disabled={busy}>
          {busy ? t("กำลังบันทึก…") : t("บันทึกร่าง")}
        </button>
      ) : (
        <p className="dim">{t("ดูได้อย่างเดียว เฉพาะแอดมินแก้ไขได้")}</p>
      )}
    </form>
  );
}

/** The error line under a form, with the MFA link when that is what is missing. */
function FormProblem({ problem }: { problem: string }) {
  const t = useT();
  if (!problem) return null;
  return (
    <p role="alert" className="au-export-err">
      {problem}
      {problem === t(MFA_NEEDED) && (
        <>
          {" "}
          <MfaLink />
        </>
      )}
    </p>
  );
}

/**
 * Doc 17 rollout: send the draft to staging (test builds) first, then a different admin publishes exactly that
 * staged draft to everyone. An admin who changed the draft may publish alone only as an explained emergency.
 */
function Publish({ view }: { view: AdminConfigView }) {
  const t = useT();
  const router = useRouter();
  const send = useSend();
  const flash = useContext(Flash);
  const [stageReason, setStageReason] = useState("");
  const [reason, setReason] = useState("");
  const [emergencyReason, setEmergencyReason] = useState("");
  const [emergencyOk, setEmergencyOk] = useState(false);
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const { changedSinceRelease, revision } = view.draft;
  const blocked = view.publishBlockers.length > 0;
  // "No changes" is already said by the line above, and "not staged" by the staging step.
  const shown = view.publishBlockers.filter((b) => b !== "no_changes" && b !== "not_staged");
  const canStage = view.stageBlockers.length === 0;
  const emergencyOnly = view.publishBlockers.length === 1 && view.publishBlockers[0] === "own_change";

  async function run(url: string, body: unknown, done: string) {
    setBusy(true);
    setProblem("");
    const r = await send("POST", url, body, revision);
    setBusy(false);
    if (!r.ok) return setProblem(r.message);
    flash(done);
    setStageReason("");
    setReason("");
    setEmergencyReason("");
    setEmergencyOk(false);
    router.refresh();
  }

  return (
    <div className="cf-publish">
      <p>
        {changedSinceRelease.length ? (
          <>
            {t("ร่าง r{0} ต่างจากที่ใช้อยู่:", revision)}{" "}
            <b>{changedList(t, changedSinceRelease)}</b>
          </>
        ) : (
          <>{t("ร่าง r{0} ตรงกับที่แอปใช้อยู่", revision)}</>
        )}
      </p>
      <p className="dim">
        {view.staged
          ? view.stagedIsDraft
            ? t("Staging: รุ่น {0} จากร่าง r{1} (ตรงกับร่างนี้)", view.staged.release, String(view.staged.draftRevision))
            : t("Staging: รุ่น {0} จากร่าง r{1} (เก่ากว่าร่างนี้)", view.staged.release, String(view.staged.draftRevision))
          : t("Staging: ยังไม่มีรุ่นทดสอบ")}
      </p>
      {canStage && (
        <form
          aria-label={t("ส่งขึ้น staging")}
          onSubmit={(e) => {
            e.preventDefault();
            void run("/bff/admin/config/stage", { reason: stageReason, validDays: days }, t("ส่งขึ้น staging แล้ว แอปรุ่นทดสอบจะได้รับเมื่อเชื่อมต่อครั้งถัดไป"));
          }}
        >
          <label className="fld">
            <span>{t("1. ส่งร่าง r{0} ขึ้น staging ให้แอปรุ่นทดสอบลองก่อน (เหตุผล)", revision)}</span>
            <textarea
              id="cf-stage-reason"
              value={stageReason}
              onChange={(e) => setStageReason(e.target.value)}
              minLength={10}
              maxLength={500}
              rows={2}
              required
            />
          </label>
          <button type="submit" className="btn secondary" disabled={busy}>
            {busy ? t("กำลังส่ง…") : t("ส่งร่าง r{0} ขึ้น staging", revision)}
          </button>
        </form>
      )}
      {blocked ? (
        <>
          {shown.length > 0 && (
            <ul className="cf-blockers">
              {shown.map((b) => (
                <li key={b}>{t(BLOCKER_LABEL[b] ?? b)}</li>
              ))}
            </ul>
          )}
          {emergencyOnly && (
            <details className="emergency">
              <summary>{t("กรณีฉุกเฉิน: เผยแพร่โดยไม่มีแอดมินคนที่สอง")}</summary>
              <form
                aria-label={t("เผยแพร่ฉุกเฉิน")}
                onSubmit={(e) => {
                  e.preventDefault();
                  void run("/bff/admin/config/publish", { reason: emergencyReason, validDays: days, emergency: true }, t("เผยแพร่แบบฉุกเฉินแล้ว บันทึกใน audit ให้ทีมตรวจย้อนหลัง"));
                }}
              >
                <p className="dim">
                  {t("ใช้เมื่อรอแอดมินคนอื่นไม่ได้ ต้องยืนยัน MFA ภายใน 5 นาที และบันทึกใน audit แยกเป็น “เผยแพร่แบบฉุกเฉิน”")}
                </p>
                <label className="fld">
                  <span>{t("เหตุผลที่ต้องเผยแพร่ทันที (อย่างน้อย 20 ตัวอักษร)")}</span>
                  <textarea value={emergencyReason} onChange={(e) => setEmergencyReason(e.target.value)} maxLength={500} rows={2} />
                </label>
                <label className="fld check">
                  <input type="checkbox" checked={emergencyOk} onChange={(e) => setEmergencyOk(e.target.checked)} />
                  <span>{t("ฉันตรวจร่างนี้แล้ว และเข้าใจว่าไม่มีผู้ตรวจคนที่สอง")}</span>
                </label>
                <button type="submit" className="btn danger" disabled={busy || !emergencyOk || emergencyReason.trim().length < 20}>
                  {t("เผยแพร่ฉุกเฉิน r{0}", revision)}
                </button>
              </form>
            </details>
          )}
        </>
      ) : (
        <form
          aria-label={t("เผยแพร่ร่าง")}
          onSubmit={(e) => {
            e.preventDefault();
            void run("/bff/admin/config/publish", { reason, validDays: days }, t("เผยแพร่แล้ว แอปจะได้รับเมื่อเปิดแอปหรือเชื่อมต่อครั้งถัดไป"));
          }}
        >
          <label className="fld">
            <span>{t("2. เผยแพร่ให้ทุกคน · เหตุผล (จะถูกบันทึกไว้ในประวัติ)")}</span>
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
          <button type="submit" className="btn" disabled={busy}>
            {busy ? t("กำลังเผยแพร่…") : t("เผยแพร่ร่าง r{0}", revision)}
          </button>
        </form>
      )}
      {(canStage || !blocked || emergencyOnly) && (
        <label className="fld cf-days">
          <span>{t("ใช้ได้นาน")}</span>
          <select id="cf-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {DAYS.map((d) => (
              <option key={d} value={d}>
                {t("{0} วัน", d)}
              </option>
            ))}
          </select>
        </label>
      )}
      <FormProblem problem={problem} />
    </div>
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
  const t = useT();
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
      t("ย้อนกลับไปใช้ค่าของรุ่น {0} แล้ว (เป็นรุ่นใหม่ในประวัติ)", release.release),
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
        {t("ย้อนไปใช้รุ่น {0}", release.release)}
      </button>
      {open && (
        <form
          className="au-export-panel"
          onSubmit={submit}
          aria-label={t("ย้อนไปใช้รุ่น {0}", release.release)}
        >
          <label className="fld">
            <span>{t("เหตุผล (จะถูกบันทึกไว้ในประวัติ)")}</span>
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
            {t("ร่างไม่เปลี่ยน ระบบจะออกรุ่นใหม่ที่ใช้ค่าเดียวกับรุ่น {0}", release.release)}
          </small>
          {problem && (
            <p role="alert" className="au-export-err">
              {problem}
              {problem === t(MFA_NEEDED) && (
                <>
                  {" "}
                  <MfaLink />
                </>
              )}
            </p>
          )}
          <div className="row">
            <button type="submit" className="btn" disabled={busy}>
              {busy ? t("กำลังย้อน…") : t("ย้อนกลับ")}
            </button>
            <button
              type="button"
              className="btn secondary"
              onClick={() => setOpen(false)}
            >
              {t("ยกเลิก")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function ReleaseMeta({ r }: { r: ConfigRelease }) {
  const t = useT();
  return (
    <small className="dim">
      {formatLogTime(r.publishedAt, t.lang)}
      {" · "}
      {r.rollbackOf
        ? t("ย้อนจากรุ่น {0}", r.rollbackOf)
        : t("จากร่าง r{0}", String(r.draftRevision))}
      {r.stagedRelease ? " · " + t("ผ่าน staging รุ่น {0}", r.stagedRelease) : ""}
      {r.emergency ? " · " + t("เผยแพร่ฉุกเฉิน ไม่มีผู้ตรวจ") : r.reviewed ? " · " + t("ผ่านผู้ตรวจ") : ""}
      {r.publishedByYou ? " · " + t("คุณเผยแพร่") : ""}
      <br />
      {targetsText(t, r.targets)}
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
  const { isAdmin, t } = useAdmin();
  if (view.releases.length === 0)
    return <p className="dim">{t("ยังไม่เคยเผยแพร่ แอปใช้ค่าเริ่มต้นของแอปเอง")}</p>;
  return (
    <ol className={className}>
      {view.releases.map((r) => (
        <li key={r.release}>
          <div className="cf-rel-head">
            <b>{t("รุ่น {0}", r.release)}</b>
            {r.environment === "staging" && <span className="tag jb-pending">staging</span>}
            {r.release === view.current?.release && (
              <span className="tag jb-completed">{t("ใช้อยู่")}</span>
            )}
          </div>
          <ReleaseMeta r={r} />
          <p className="cf-reason">{r.reason}</p>
          {isAdmin && r.environment === "production" && r.release !== view.current?.release && (
            <Rollback release={r} />
          )}
        </li>
      ))}
    </ol>
  );
}

function Current({ view }: { view: AdminConfigView }) {
  const t = useT();
  const c = view.current;
  return (
    <div className="cf-current">
      {c ? (
        <>
          <p>
            {t("แอปใช้")} <b>{t("รุ่น {0}", c.release)}</b> ·{" "}
            <span className={expiringSoon(c) ? "jb-late" : undefined}>
              {expiryText(t, c)}
            </span>
          </p>
          <Summary config={c.config} />
          <small className="dim">{targetsText(t, c.targets)}</small>
        </>
      ) : (
        <>
          <p>{t("ยังไม่เคยเผยแพร่ แอปใช้ค่าเริ่มต้นของแอปเอง")}</p>
          <Summary config={view.defaults} />
        </>
      )}
    </div>
  );
}

function Note({ view }: { view: AdminConfigView }) {
  const t = useT();
  return (
    <p className="ov-foot dim">
      {t(
        "แอปรับค่าใหม่ตอนเปิดแอปหรือเชื่อมต่อใหม่ ไม่ใช่ทันที · ทุกรุ่นมีลายเซ็นจากเซิร์ฟเวอร์ (กุญแจ {0}) แอปจะเชื่อเฉพาะค่าที่ลายเซ็นถูกต้อง · รุ่นที่หมดอายุแล้ว แอปจะกลับไปใช้ค่าเริ่มต้น",
        view.signingKeyId,
      )}
    </p>
  );
}

function Problem({ status }: { status: number }) {
  const t = useT();
  return (
    <div className="adm-alert" role="alert">
      {status === 403
        ? t("บัญชีนี้ไม่มีสิทธิ์ดูตั้งค่าแอป (ต้องเป็นโอเปอเรเตอร์หรือแอดมิน)")
        : status === 429
          ? t(RATE_LIMITED)
          : t("โหลดตั้งค่าแอปไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง")}
    </div>
  );
}

/** TuneDeck's logo for stations without one (Tar 2026-10-10). Admins only; the same panel in every theme. */
function BrandLogo({ brand }: { brand: { custom: boolean; version?: string } }) {
  const t = useT();
  return (
    <section className="adm-note lg-brand" aria-label={t("โลโก้ TuneDeck สำหรับสถานีที่ไม่มีโลโก้")}>
      <h2>{t("โลโก้ TuneDeck สำหรับสถานีที่ไม่มีโลโก้")}</h2>
      <p className="dim">{t("แสดงบนแผนที่และในรายการแทนสถานีที่ไม่มีโลโก้ของตัวเอง เปลี่ยนแล้วมีผลภายในไม่กี่นาที")}</p>
      <LogoUpload
        src={`/bff/logos/default?r=${brand.version ?? "built-in"}`}
        note={brand.custom ? t("โลโก้ที่แอดมินอัปโหลด") : t("โลโก้มาตรฐานของ TuneDeck")}
        uploaded={brand.custom}
        path="/bff/admin/brand/station-logo"
        name="TuneDeck"
        label={t("อัปโหลดโลโก้ใหม่")}
      />
    </section>
  );
}

export function ConfigView(props: { view?: AdminConfigView; status: number; brand?: { custom: boolean; version?: string } | null }) {
  const [flash, setFlash] = useState("");
  if (!props.view) return <Problem status={props.status} />;
  return (
    <Flash.Provider value={setFlash}>
      {props.brand && <BrandLogo brand={props.brand} />}
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
  const { theme, t } = useAdmin();
  const c = view.current;

  if (theme === "control-room") {
    return (
      <div className="cr-page cf">
        <div className="top">
          <div className="crumb">
            Operations<b>{t("ตั้งค่าแอป")}</b>
          </div>
        </div>
        <div className="ov-kpis jb-kpis">
          <div className="pn">
            <small>{t("รุ่นที่ใช้")}</small>
            <b className="mo">{c ? c.release : "—"}</b>
          </div>
          <div className={`pn${expiringSoon(c) ? " warn" : ""}`}>
            <small>{t("หมดอายุใน")}</small>
            <b className="mo">
              {c ? t("{0} วัน", Math.max(daysLeft(c.expiresAt), 0)) : "—"}
            </b>
          </div>
          <div
            className={`pn${view.draft.changedSinceRelease.length ? " warn" : ""}`}
          >
            <small>{t("รอเผยแพร่")}</small>
            <b className="mo">{t("{0} ค่า", view.draft.changedSinceRelease.length)}</b>
          </div>
        </div>
        <div className="cf-cols">
          <div className="pn">
            <h3>{t("ร่าง r{0}", view.draft.revision)}</h3>
            <DraftForm view={view} />
          </div>
          <div className="pn">
            <h3>{t("เผยแพร่")}</h3>
            <Publish view={view} />
            <h3>{t("ที่แอปใช้อยู่")}</h3>
            <Current view={view} />
          </div>
        </div>
        <div className="pn">
          <h3>{t("ประวัติรุ่น")}</h3>
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
          <h3>{t("ตั้งค่าแอป")} · Remote config</h3>
          <span>
            {c
              ? t("ON AIR รุ่น {0} · {1}", c.release, expiryText(t, c))
              : t("ยังไม่ออกอากาศ ใช้ค่าเริ่มต้น")}
          </span>
        </div>
        <div className="cf-rack">
          <section className="adm-panel">
            <h4>
              <i className="lamp jb-pending" aria-hidden="true" /> {t("ร่าง r{0}", view.draft.revision)}
            </h4>
            <DraftForm view={view} />
          </section>
          <section className="adm-panel">
            <h4>
              <i
                className={`lamp ${c ? "jb-completed" : "jb-pending"}`}
                aria-hidden="true"
              />{" "}
              {t("ออกอากาศ")}
            </h4>
            <Current view={view} />
            <Publish view={view} />
          </section>
        </div>
        <section className="adm-panel">
          <h4>{t("ประวัติรุ่น")}</h4>
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
            <h3>{t("ตั้งค่าแอป")}</h3>
            <p>
              {t("เวอร์ชันขั้นต่ำ ฟีเจอร์ที่ปิดชั่วคราว และรอบรีเฟรช ที่แอปจะได้รับ")}
            </p>
          </div>
        </div>
        <div className="cf-bento">
          <section className="b-kpi">
            <small>{t("รุ่นที่แอปใช้")}</small>
            <b>{c ? c.release : "—"}</b>
          </section>
          <section className={`b-kpi${expiringSoon(c) ? " warn" : ""}`}>
            <small>{t("หมดอายุใน")}</small>
            <b>{c ? t("{0} วัน", Math.max(daysLeft(c.expiresAt), 0)) : "—"}</b>
          </section>
          <section className="b-wide cf-b-draft">
            <h4>{t("ร่าง r{0}", view.draft.revision)}</h4>
            <DraftForm view={view} />
          </section>
          <section className="cf-b-pub">
            <h4>{t("เผยแพร่")}</h4>
            <Publish view={view} />
          </section>
          <section className="cf-b-cur">
            <h4>{t("ที่แอปใช้อยู่")}</h4>
            <Current view={view} />
          </section>
          <section className="b-wide">
            <h4>{t("ประวัติรุ่น")}</h4>
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
        <section className="list" aria-label={t("ประวัติรุ่น")}>
          <div className="lh">
            <h3>
              {t("ตั้งค่าแอป")} <span>{view.releases.length}</span>
            </h3>
          </div>
          <div className="cf-wb-list">
            <Releases view={view} />
          </div>
        </section>
        <section className="det" aria-label={t("ร่างและการเผยแพร่")}>
          <div className="lg-detail">
            <p className="crumb">{t("ตั้งค่าแอป")} / {t("ร่าง r{0}", view.draft.revision)}</p>
            <h2>{c ? t("แอปใช้รุ่น {0}", c.release) : t("ยังไม่เคยเผยแพร่")}</h2>
            {c && (
              <p className={expiringSoon(c) ? "jb-late" : "dim"}>
                {expiryText(t, c)}
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
          <small className="fv-label">{t("รุ่นที่แอปใช้")}</small>
          <p className="fv-amount">{c ? c.release : "—"}</p>
          <small>
            {c ? formatLogTime(c.publishedAt, t.lang) : t("ใช้ค่าเริ่มต้นของแอป")}
          </small>
        </section>
        <section className="fv-card">
          <small className="fv-label">{t("หมดอายุใน")}</small>
          <p className={`fv-amount${expiringSoon(c) ? " hot" : ""}`}>
            {c ? t("{0} วัน", Math.max(daysLeft(c.expiresAt), 0)) : "—"}
          </p>
          <small>{t("เผยแพร่ใหม่ก่อนหมดอายุ")}</small>
        </section>
        <section className="fv-card">
          <small className="fv-label">{t("รอเผยแพร่")}</small>
          <p className="fv-amount">{view.draft.changedSinceRelease.length}</p>
          <small>
            {view.draft.changedSinceRelease.length
              ? changedList(t, view.draft.changedSinceRelease)
              : t("ร่างตรงกับที่ใช้อยู่")}
          </small>
        </section>
      </div>
      <div className="cf-cols">
        <section className="fv-card" aria-labelledby="fv-cf-draft">
          <div className="fv-card-head">
            <div>
              <h2 id="fv-cf-draft">{t("ร่าง r{0}", view.draft.revision)}</h2>
              <small>
                {view.draft.updatedAt
                  ? t("แก้ล่าสุด {0}", formatLogTime(view.draft.updatedAt, t.lang))
                  : t("ยังไม่เคยแก้")}
              </small>
            </div>
          </div>
          <DraftForm view={view} />
        </section>
        <section className="fv-card" aria-labelledby="fv-cf-pub">
          <div className="fv-card-head">
            <div>
              <h2 id="fv-cf-pub">{t("เผยแพร่")}</h2>
              <small>{t("ต้องให้แอดมินอีกคนตรวจ")}</small>
            </div>
          </div>
          <Publish view={view} />
          <h3 className="cf-sub">{t("ที่แอปใช้อยู่")}</h3>
          <Current view={view} />
        </section>
      </div>
      <section className="fv-card" aria-labelledby="fv-cf-rel">
        <div className="fv-card-head">
          <div>
            <h2 id="fv-cf-rel">{t("ประวัติรุ่น")}</h2>
            <small>{t("ย้อนกลับได้โดยออกรุ่นใหม่ ไม่แก้ประวัติ")}</small>
          </div>
        </div>
        <Releases view={view} />
      </section>
      <Note view={view} />
    </div>
  );
}
