/**
 * Start scripts of a PostgreSQL database's pooler and replica containers. Kept apart from the code
 * that runs them, so tests can check them on their own.
 */
import { pgRequireHba, TLS_DIR, TLS_SOURCE } from "./options";

export const POOLER_ROLE = "serve_pooler";
export const REPLICA_ROLE = "serve_replicator";

/**
 * PgBouncer's configuration, written by the container at start from its environment. It starts as
 * root to set up its files, then runs as postgres. With public access (PUBLIC=1) it speaks TLS, and
 * its access rules let plain connections in from private networks only: the gateway (Docker's
 * proxy for the public port) and everyone else must use TLS.
 */
export const POOLER_SCRIPT = `set -e
EXTRA="auth_type = scram-sha-256"
if [ "$PUBLIC" = 1 ]; then
  T=/etc/pgbouncer/tls
  mkdir -p $T
  cp /etc/serve-tls/server.crt /etc/serve-tls/server.key $T/
  if [ -n "$DOMAIN_CERT" ]; then cp -L "$DOMAIN_CERT" $T/server.crt && cp -L "$DOMAIN_KEY" $T/server.key; fi
  chown -R postgres $T && chmod 600 $T/server.key
  GW=$(awk 'function h(s) { return (index("0123456789ABCDEF", substr(s, 1, 1)) - 1) * 16 + index("0123456789ABCDEF", substr(s, 2, 1)) - 1 } NR > 1 && $2 == "00000000" && $3 != "00000000" { printf "%d.%d.%d.%d", h(substr($3, 7, 2)), h(substr($3, 5, 2)), h(substr($3, 3, 2)), h(substr($3, 1, 2)); exit }' /proc/net/route)
  {
    if [ -n "$GW" ]; then echo "hostnossl all all $GW/32 reject"; fi
    for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do echo "hostnossl all all $net scram-sha-256"; done
    echo "hostssl all all 0.0.0.0/0 scram-sha-256"
    echo "hostssl all all ::/0 scram-sha-256"
  } > /etc/pgbouncer/hba.conf
  EXTRA="auth_type = hba
auth_hba_file = /etc/pgbouncer/hba.conf
client_tls_sslmode = allow
client_tls_cert_file = $T/server.crt
client_tls_key_file = $T/server.key"
fi
cat > /etc/pgbouncer/pgbouncer.ini <<EOF
[databases]
* = host=$DB_HOST port=5432 auth_dbname=postgres

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 5432
$EXTRA
auth_file = /etc/pgbouncer/userlist.txt
auth_user = ${POOLER_ROLE}
auth_query = SELECT usename, passwd FROM ${POOLER_ROLE}.lookup(\\$1)
pool_mode = $POOL_MODE
default_pool_size = $POOL_SIZE
max_client_conn = $MAX_CLIENTS
max_prepared_statements = 200
ignore_startup_parameters = extra_float_digits,options,search_path
server_tls_sslmode = prefer
EOF
printf '"${POOLER_ROLE}" "%s"\\n' "$AUTH_PASSWORD" > /etc/pgbouncer/userlist.txt
chown postgres /etc/pgbouncer/pgbouncer.ini /etc/pgbouncer/userlist.txt
exec /usr/bin/pgbouncer -u postgres /etc/pgbouncer/pgbouncer.ini`;

/** PostgreSQL's TLS settings, the database's own (required mode: pg_hba.conf from the start step). */
const PG_TLS_ARGS = [
  "-c ssl=on",
  `-c ssl_cert_file=${TLS_DIR}/server.crt`,
  `-c ssl_key_file=${TLS_DIR}/server.key`,
  `-c ssl_ca_file=${TLS_DIR}/ca.crt`,
  `-c hba_file=${TLS_DIR}/pg_hba.conf`,
].join(" ");

/**
 * A replica's start: copy the database once (pg_basebackup over its replication slot), then run
 * as a hot standby that follows it. Runs as root, like the image's own entrypoint.
 */
export const REPLICA_SCRIPT = `set -e
D="\${PGDATA:-/var/lib/postgresql/data}"
AS="$(command -v gosu || command -v su-exec)"
if [ ! -s "$D/PG_VERSION" ]; then
  mkdir -p "$D" && chown -R postgres:postgres "$D" && chmod 700 "$D"
  echo "Waiting for $PRIMARY_HOST"
  until "$AS" postgres pg_isready -q -h "$PRIMARY_HOST" -p 5432; do sleep 2; done
  echo "Copying the database from $PRIMARY_HOST"
  "$AS" postgres env PGPASSWORD="$REPLICA_PASSWORD" pg_basebackup -h "$PRIMARY_HOST" -p 5432 -U ${REPLICA_ROLE} -D "$D" -X stream -S "$REPLICA_SLOT" -R -P
  echo "Copy finished"
fi
touch "$D/standby.signal" && chown postgres:postgres "$D/standby.signal"
# Public access: TLS like the database's own, required from outside the container's networks.
if [ "$PUBLIC" = 1 ]; then
  mkdir -p ${TLS_DIR} && cp ${TLS_SOURCE}/* ${TLS_DIR}/ && rm -f ${TLS_DIR}/ca.key
  if [ -n "$DOMAIN_CERT" ]; then cp -L "$DOMAIN_CERT" ${TLS_DIR}/server.crt && cp -L "$DOMAIN_KEY" ${TLS_DIR}/server.key; fi
  ${pgRequireHba(TLS_DIR)}
  chown -R postgres:postgres ${TLS_DIR} && chmod 600 ${TLS_DIR}/server.key
  set -- ${PG_TLS_ARGS}
fi
exec "$AS" postgres postgres "$@" -c hot_standby=on -c "primary_slot_name=$REPLICA_SLOT" \\
  -c "primary_conninfo=host=$PRIMARY_HOST port=5432 user=${REPLICA_ROLE} password=$REPLICA_PASSWORD application_name=$REPLICA_SLOT"`;
