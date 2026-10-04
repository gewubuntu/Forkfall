#!/usr/bin/env bash
# Back up Forkfall's data volume (matches, running state, sessions, quests, profiles) to ~/backups/forkfall.
# Keeps the last 14. Run nightly from the deploy user's crontab:
#   15 3 * * * /home/forkfall/Forkfall/deploy/backup.sh >> /home/forkfall/backup.log 2>&1
# Copy the archives off the server too (e.g. rclone/restic to object storage); Hetzner's own backups are a second layer.
# deploy/.env (the referee key) is NOT in the volume: keep a copy of it somewhere safe and offline.
set -euo pipefail
umask 077   # archives hold match secrets and session hashes: owner-only
DEST="${BACKUP_DIR:-$HOME/backups/forkfall}"
KEEP="${KEEP:-14}"
VOLUME="${VOLUME:-forkfall_forkfall-data}"
mkdir -p "$DEST" && chmod 700 "$DEST"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
# Files are written atomically (temp + rename), so a live copy never holds a half-written file.
docker run --rm -v "$VOLUME":/data:ro -v "$DEST":/backup alpine:3 \
  sh -c "umask 077 && tar czf /backup/forkfall-$STAMP.tgz -C /data . && chown $(id -u):$(id -g) /backup/forkfall-$STAMP.tgz"
ls -1t "$DEST"/forkfall-*.tgz | tail -n +$((KEEP + 1)) | xargs -r rm --
echo "backup: $DEST/forkfall-$STAMP.tgz ($(du -h "$DEST/forkfall-$STAMP.tgz" | cut -f1))"
