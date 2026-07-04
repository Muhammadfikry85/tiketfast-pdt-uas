#!/bin/bash
set -e

# User khusus untuk streaming replication
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replicator_pass';
EOSQL

# pg_hba.conf: izinkan replica melakukan streaming replication
echo "host replication replicator 0.0.0.0/0 md5" >> "$PGDATA/pg_hba.conf"
echo "host all all 0.0.0.0/0 md5" >> "$PGDATA/pg_hba.conf"

# Skema TiketFast
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE TABLE IF NOT EXISTS venues (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        city        VARCHAR(100) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS seats_festival (
        seat_id     VARCHAR(50) PRIMARY KEY,
        venue_id    INTEGER REFERENCES venues(id),
        status      VARCHAR(20) NOT NULL DEFAULT 'available',
        locked_by   VARCHAR(100),
        locked_at   TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS seats_vip (
        seat_id     VARCHAR(50) PRIMARY KEY,
        venue_id    INTEGER REFERENCES venues(id),
        status      VARCHAR(20) NOT NULL DEFAULT 'available',
        locked_by   VARCHAR(100),
        locked_at   TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS seats_tribune (
        seat_id     VARCHAR(50) PRIMARY KEY,
        venue_id    INTEGER REFERENCES venues(id),
        status      VARCHAR(20) NOT NULL DEFAULT 'available',
        locked_by   VARCHAR(100),
        locked_at   TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS bookings (
        id          SERIAL PRIMARY KEY,
        seat_id     VARCHAR(50) NOT NULL,
        category    VARCHAR(20) NOT NULL,
        user_id     VARCHAR(100) NOT NULL,
        node_id     VARCHAR(50) NOT NULL,
        booked_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    INSERT INTO venues (name, city) VALUES ('Gelora Arena', 'Jakarta')
        ON CONFLICT DO NOTHING;

    INSERT INTO seats_festival (seat_id, venue_id)
        SELECT 'F-' || g, 1 FROM generate_series(1, 50) g
        ON CONFLICT DO NOTHING;

    INSERT INTO seats_vip (seat_id, venue_id)
        SELECT 'V-' || g, 1 FROM generate_series(1, 20) g
        ON CONFLICT DO NOTHING;

    INSERT INTO seats_tribune (seat_id, venue_id)
        SELECT 'T-' || g, 1 FROM generate_series(1, 100) g
        ON CONFLICT DO NOTHING;
EOSQL
