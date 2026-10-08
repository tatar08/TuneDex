import { Pool } from 'pg';
import { IdpUsersService } from '../account/idp-users';
import { writeAudit } from '../audit/audit';
import { loadConfig } from '../config';
import { Database } from '../db/database';
import { STAFF_ROLES, StaffRole } from './staff';

/**
 * Operator tool for granting and revoking staff roles. There is no self-service path:
 * someone with database access runs this, and every change is audited.
 *
 *   node dist/staff/staff-cli.js list
 *   node dist/staff/staff-cli.js grant  <oidc-subject> <role> --by <operator> --reason "<why>"
 *   node dist/staff/staff-cli.js revoke <oidc-subject> <role> --by <operator> --reason "<why>"
 *   node dist/staff/staff-cli.js pin-mfa <oidc-subject> --by <operator> --reason "<why>"
 *
 * A grant needs the person to have set up a one-time code (TOTP) at Keycloak first, and pins the codes they have
 * then (staff_mfa_pins). Keycloak lets anyone who knows the password enroll another code, so staff requests are
 * refused while the account holds a code that is not pinned. After a legitimate change (new phone, reset), an
 * operator who has checked with the person runs pin-mfa. Where Keycloak cannot be asked (local dev without the
 * admin client), a grant goes ahead with a warning and pins nothing.
 */
export type OtpLookup = (subject: string) => Promise<string[]>;

const USAGE = 'usage: staff-cli list | grant|revoke <oidc-subject> <role> --by <operator> --reason "<why>" | pin-mfa <oidc-subject> --by <operator> --reason "<why>"';
const NO_CODE = (subject: string) =>
  `${subject} has no one-time code yet: they set one up first (Keycloak account page → Signing in → Authenticator application), then grant again`;

export async function runStaffCli(argv: string[], db: Database, out: (line: string) => void = console.log, otpLookup?: OtpLookup): Promise<number> {
  const [command, subject, role] = argv;
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  if (command === 'list') {
    const rows = await db.query<{ oidc_subject: string; role: string; scope: string; granted_by: string; granted_at: Date }>(
      `SELECT u.oidc_subject, r.role, r.scope, r.granted_by, r.granted_at FROM staff_roles r JOIN users u ON u.id = r.user_id
        WHERE r.revoked_at IS NULL ORDER BY u.oidc_subject, r.role`,
    );
    for (const r of rows) out(`${r.oidc_subject}\t${r.role}\t${r.scope}\tgranted by ${r.granted_by} at ${r.granted_at.toISOString()}`);
    return 0;
  }

  const by = flag('by');
  const reason = flag('reason');
  if (command === 'pin-mfa' && subject && !subject.startsWith('--') && by && reason) return pinMfa(db, out, subject, by, reason, otpLookup);
  if ((command !== 'grant' && command !== 'revoke') || !subject || !role || !by || !reason) {
    out(USAGE);
    return 2;
  }
  if (!(STAFF_ROLES as readonly string[]).includes(role)) {
    out(`unknown role "${role}"; one of: ${STAFF_ROLES.join(', ')}`);
    return 2;
  }

  let codes: string[] | null = null;
  if (command === 'grant') {
    if (!otpLookup) {
      out('warning: Keycloak admin client not configured, so the one-time code was not checked');
    } else {
      codes = await otpLookup(subject);
      if (codes.length === 0) {
        out(NO_CODE(subject));
        return 3;
      }
    }
  }

  return db.transaction(async (query) => {
    // The account may not have signed in yet; create it so the role is ready on first sign-in.
    await query('INSERT INTO users (oidc_subject) VALUES ($1) ON CONFLICT (oidc_subject) DO NOTHING', [subject]);
    const [user] = await query<{ id: string }>('SELECT id FROM users WHERE oidc_subject = $1', [subject]);
    if (codes) {
      const [pin] = await query<{ credential_ids: string[] }>('SELECT credential_ids FROM staff_mfa_pins WHERE user_id = $1 FOR UPDATE', [user.id]);
      if (!pin) {
        await query('INSERT INTO staff_mfa_pins (user_id, credential_ids, pinned_by) VALUES ($1, $2, $3)', [user.id, codes, by]);
      } else if (!codes.every((c) => pin.credential_ids.includes(c))) {
        out(`${subject} has a one-time code that was not pinned: check with them, then run pin-mfa before granting`);
        return 4;
      }
    }
    const changed =
      command === 'grant'
        ? await query('INSERT INTO staff_roles (user_id, role, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id', [user.id, role as StaffRole, by])
        : await query('UPDATE staff_roles SET revoked_at = now(), revoked_by = $3 WHERE user_id = $1 AND role = $2 AND revoked_at IS NULL RETURNING id', [user.id, role, by]);
    if (changed.length === 0) {
      out(command === 'grant' ? `already has ${role}` : `does not have ${role}`);
      return 1;
    }
    await writeAudit(query, {
      actor: `operator:${by}`,
      action: `staff_role.${command}`,
      targetType: 'user',
      targetId: user.id,
      reason,
      changes: { role },
    });
    out(`${command === 'grant' ? 'granted' : 'revoked'} ${role}`);
    return 0;
  });
}

/** Pins the one-time codes the account has now, after an operator checked the change with the person. */
async function pinMfa(db: Database, out: (line: string) => void, subject: string, by: string, reason: string, otpLookup?: OtpLookup): Promise<number> {
  if (!otpLookup) {
    out('pin-mfa needs the Keycloak admin client (KEYCLOAK_ADMIN_CLIENT_ID / _SECRET) to read the one-time codes');
    return 2;
  }
  const codes = await otpLookup(subject);
  if (codes.length === 0) {
    out(NO_CODE(subject));
    return 3;
  }
  return db.transaction(async (query) => {
    const [user] = await query<{ id: string }>('SELECT id FROM users WHERE oidc_subject = $1', [subject]);
    if (!user) {
      out(`no account for ${subject}`);
      return 1;
    }
    const [before] = await query<{ credential_ids: string[] }>('SELECT credential_ids FROM staff_mfa_pins WHERE user_id = $1 FOR UPDATE', [user.id]);
    await query(
      `INSERT INTO staff_mfa_pins (user_id, credential_ids, pinned_by) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET credential_ids = EXCLUDED.credential_ids, pinned_at = now(), pinned_by = EXCLUDED.pinned_by`,
      [user.id, codes, by],
    );
    await writeAudit(query, {
      actor: `operator:${by}`,
      action: 'staff_mfa.pin',
      targetType: 'user',
      targetId: user.id,
      reason,
      changes: { codes: codes.length, previously: before?.credential_ids.length ?? 0 },
    });
    out(`pinned ${codes.length} one-time code${codes.length === 1 ? '' : 's'}`);
    return 0;
  });
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const pool = new Pool({ connectionString: url });
  let otpLookup: OtpLookup | undefined;
  try {
    const config = loadConfig();
    if (config.idpAdmin) {
      const idp = new IdpUsersService(config, fetch);
      otpLookup = (subject) => idp.otpCredentialIds(subject);
    }
  } catch {
    // Only DATABASE_URL set (local dev): no Keycloak to ask.
  }
  runStaffCli(process.argv.slice(2), new Database(pool), console.log, otpLookup)
    .then((code) => (process.exitCode = code))
    .catch((err: Error) => {
      console.error(`staff-cli failed: ${err.message}`);
      process.exitCode = 1;
    })
    .finally(() => void pool.end());
}
