# Nightly backups for infra/deploy: the TuneDeck database through infra/backup/backup.sh (checked, recorded in
# backup_runs for the backup_stale alert) and Keycloak's database with a plain checked dump. Build context: infra/.
FROM postgres:16
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
COPY backup/backup.sh backup/pg-env.sh backup/restore-drill.sh /opt/tunedeck-backup/
COPY deploy/backup/loop.sh /opt/tunedeck-backup/loop.sh
RUN chmod 0755 /opt/tunedeck-backup/*.sh && mkdir -p /backups && chown postgres:postgres /backups && chmod 0700 /backups
USER postgres
ENTRYPOINT ["/opt/tunedeck-backup/loop.sh"]
