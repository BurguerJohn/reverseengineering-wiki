#!/bin/bash
# Daily backup of ReverseEngineering.wiki: MediaWiki database, gateway accounts and index,
# and the two config files that hold the secrets. Keeps the last 7 days.
# Install: cp deploy/linux/rewiki-backup.sh /usr/local/sbin/rewiki-backup && chmod 700 /usr/local/sbin/rewiki-backup
#          echo '30 3 * * * root /usr/local/sbin/rewiki-backup' > /etc/cron.d/rewiki-backup
# Restore: see the README.txt written into each backup.
set -euo pipefail

SITE=/srv/rewiki
DEST=/var/backups/rewiki
KEEP_DAYS=7
STAMP=$(date -u +%F)
OUT="$DEST/$STAMP"

umask 077
mkdir -p "$OUT"
chmod 700 "$DEST"

# MediaWiki database (consistent snapshot without locking the wiki).
mysqldump --single-transaction --quick --routines --default-character-set=binary rewiki | gzip -9 > "$OUT/rewiki-db.sql.gz"

# Gateway SQLite databases (online backups, safe while the gateway writes).
for db in gateway index; do
  sqlite3 "$SITE/gateway/data/$db.sqlite" ".backup '$OUT/$db.sqlite'"
  gzip -9 "$OUT/$db.sqlite"
done

# Secrets: the gateway's encrypted data is unreadable without GATEWAY_SECRET.
tar -czf "$OUT/config.tar.gz" -C "$SITE" LocalSettings.php gateway/.env

cat > "$OUT/README.txt" <<EOF
ReverseEngineering.wiki backup $STAMP (UTC)
Restore:
  systemctl stop rewiki-gateway
  gunzip -c rewiki-db.sql.gz | mysql rewiki
  gunzip -c gateway.sqlite.gz > $SITE/gateway/data/gateway.sqlite   (same for index)
  rm -f $SITE/gateway/data/*.sqlite-wal $SITE/gateway/data/*.sqlite-shm
  tar -xzf config.tar.gz -C $SITE      (only when rebuilding the server)
  chown -R rewiki:www-data $SITE/gateway/data && systemctl start rewiki-gateway
EOF

find "$DEST" -mindepth 1 -maxdepth 1 -type d -mtime +$((KEEP_DAYS - 1)) -exec rm -rf {} +
echo "backup $OUT: $(du -sh "$OUT" | cut -f1)"
