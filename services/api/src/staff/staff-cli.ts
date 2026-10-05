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
 *
 * A grant needs the person to have set up a one-time code (TOTP) at Keycloak first: the realm does not let a
 * password-only sign-in enroll a code during the MFA step, so a stolen password cannot become staff MFA.
 * Where Keycloak cannot be asked (local dev without the admin client), the grant goes ahead with a warning.
 */
export type OtpCheck = (subject: string) => Promise<boolean>;

export async function runStaffCli(argv: string[], db: Database, out: (line: string) => void = console.log, otpCheck?: OtpCheck): Promise<number> {
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
  if ((command !== 'grant' && command !== 'revoke') || !subject || !role || !by || !reason) {
    out('usage: staff-cli list | grant|revoke <oidc-subject> <role> --by <operator> --reason "<why>"');
    return 2;
  }
  if (!(STAFF_ROLES as readonly string[]).includes(role)) {
    out(`unknown role "${role}"; one of: ${STAFF_ROLES.join(', ')}`);
    return 2;
  }

  if (command === 'grant') {
    if (!otpCheck) {
      out('warning: Keycloak admin client not configured, so the one-time code was not checked');
    } else if (!(await otpCheck(subject))) {
      out(`${subject} has no one-time code yet: they set one up first (Keycloak account page → Signing in → Authenticator application), then grant again`);
      return 3;
    }
  }

  return db.transaction(async (query) => {
    // The account may not have signed in yet; create it so the role is ready on first sign-in.
    await query('INSERT INTO users (oidc_subject) VALUES ($1) ON CONFLICT (oidc_subject) DO NOTHING', [subject]);
    const [user] = await query<{ id: string }>('SELECT id FROM users WHERE oidc_subject = $1', [subject]);
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

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const pool = new Pool({ connectionString: url });
  let otpCheck: OtpCheck | undefined;
  try {
    const config = loadConfig();
    if (config.idpAdmin) {
      const idp = new IdpUsersService(config, fetch);
      otpCheck = (subject) => idp.hasOtp(subject);
    }
  } catch {
    // Only DATABASE_URL set (local dev): no Keycloak to ask.
  }
  runStaffCli(process.argv.slice(2), new Database(pool), console.log, otpCheck)
    .then((code) => (process.exitCode = code))
    .catch((err: Error) => {
      console.error(`staff-cli failed: ${err.message}`);
      process.exitCode = 1;
    })
    .finally(() => void pool.end());
}
