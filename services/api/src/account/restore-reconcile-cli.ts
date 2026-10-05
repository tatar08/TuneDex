import { loadConfig } from '../config';
import { createPool, Database } from '../db/database';
import { IdpError, IdpUsersService } from './idp-users';
import { reconcileAfterRestore } from './restore-reconcile';

/**
 * Run once after restoring the database, before the API serves traffic again (see infra/README.md).
 *
 *   node dist/account/restore-reconcile-cli.js                                   # report only
 *   node dist/account/restore-reconcile-cli.js --apply --by <operator> --reason "<why>" [--allow-many]
 *
 * If more than 5% of accounts (and more than 3) look deleted, `--apply` refuses without `--allow-many`: that
 * pattern usually means the database and Keycloak are from different environments, not a few late deletions.
 * Uses the API's own environment (DATABASE_URL, OIDC_ISSUER, KEYCLOAK_ADMIN_CLIENT_*).
 */
export async function runReconcileCli(argv: string[], db: Database, idp: IdpUsersService, out: (line: string) => void = console.log): Promise<number> {
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const apply = argv.includes('--apply');
  const by = flag('by');
  const reason = flag('reason');
  if (apply && (!by || !reason || reason.length < 10)) {
    out('usage: restore-reconcile-cli [--apply --by <operator> --reason "<why, 10+ characters>"]');
    return 2;
  }
  try {
    if (apply && !argv.includes('--allow-many')) {
      const preview = await reconcileAfterRestore(db, idp, { apply: false });
      if (preview.missing.length > 3 && preview.missing.length > preview.checked * 0.05) {
        out(`${preview.missing.length} of ${preview.checked} accounts have no Keycloak user. Check that OIDC_ISSUER is this environment's realm; nothing changed. Add --allow-many if this is expected.`);
        return 1;
      }
    }
    const r = await reconcileAfterRestore(db, idp, apply ? { apply: true, by: by!, reason: reason! } : { apply: false });
    out(`checked ${r.checked} accounts; ${r.missing.length} have no Keycloak user`);
    for (const id of r.missing) out(`  ${id}`);
    if (apply) out(`queued ${r.queued} for deletion; the API completes them within 10 minutes (or retry on /admin/jobs)`);
    else if (r.missing.length > 0) out('nothing changed; run again with --apply --by <operator> --reason "<why>" to delete them again');
    return 0;
  } catch (err) {
    out(err instanceof IdpError ? `Keycloak ${err.step} failed (${err.status}); nothing changed` : `failed: ${(err as Error).message}; nothing changed`);
    return 1;
  }
}

if (require.main === module) {
  const config = loadConfig();
  if (!config.idpAdmin) {
    console.error('KEYCLOAK_ADMIN_CLIENT_ID and KEYCLOAK_ADMIN_CLIENT_SECRET are required');
    process.exit(2);
  }
  const pool = createPool(config.databaseUrl);
  runReconcileCli(process.argv.slice(2), new Database(pool), new IdpUsersService(config, fetch))
    .then((code) => (process.exitCode = code))
    .finally(() => void pool.end());
}
