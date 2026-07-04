#!/bin/bash
set -e

DATA_DIR="/var/lib/postgresql/data"

# Jika direktori data kosong, lakukan base backup dari master (streaming replication).
if [ -z "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; then
    echo "[replica] Menunggu postgres-master siap..."
    until pg_isready -h postgres-master -p 5432 -U tiketfast; do
        sleep 2
    done

    echo "[replica] Menjalankan pg_basebackup dari master..."
    PGPASSWORD=replicator_pass pg_basebackup \
        -h postgres-master -p 5432 -U replicator \
        -D "$DATA_DIR" -Fp -Xs -P -R

    cp /etc/postgresql/postgresql.conf "$DATA_DIR/postgresql.auto.conf.custom" 2>/dev/null || true
fi

exec docker-entrypoint.sh postgres -c config_file=/etc/postgresql/postgresql.conf
