#!/usr/bin/env node
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';

const candidates = [
  process.env.DOCKER_BIN,
  'docker',
  '/Applications/Docker.app/Contents/Resources/bin/docker',
].filter(Boolean);

let dockerBin = null;
for (const candidate of candidates) {
  if (candidate.includes('/') && !existsSync(candidate)) continue;
  const result = spawnSync(candidate, ['version'], { stdio: 'ignore' });
  if (result.status === 0) {
    dockerBin = candidate;
    break;
  }
}

if (!dockerBin) {
  console.error('Cannot find Docker CLI. Set DOCKER_BIN=/path/to/docker and retry.');
  process.exit(1);
}

const isolatedRunner = String.raw`
set -eu
cd /app/server
TMP_ROOT=$(mktemp -d /tmp/teable-sync-contract-XXXXXX)
SERVER_LOG="$TMP_ROOT/server.log"
SERVER_PID=""
PORT_VALUE="$(printenv API_CONTRACT_PORT || true)"
if [ -z "$PORT_VALUE" ]; then PORT_VALUE=3199; fi
cleanup() {
  status=$?
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  if [ "$status" -ne 0 ] && [ -f "$SERVER_LOG" ]; then
    echo "--- isolated contract server log ---" >&2
    tail -120 "$SERVER_LOG" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$status"
}
trap cleanup EXIT INT TERM
mkdir -p "$TMP_ROOT/data/sync-state"
export DATA_DIR="$TMP_ROOT/data"
export RUNTIME_STORE_DATA_DIR="$TMP_ROOT/data"
export RUNTIME_SQLITE_FILE="$TMP_ROOT/data/runtime.sqlite"
export PORT="$PORT_VALUE"
export API_CONTRACT_BASE="http://127.0.0.1:$PORT_VALUE/api"
export API_CONTRACT_CONFIG_FILE="$TMP_ROOT/data/config.json"
export API_CONTRACT_USERS_FILE="$TMP_ROOT/data/users.json"
export API_CONTRACT_HISTORY_FILE="$TMP_ROOT/data/sync-history.json"
export API_CONTRACT_FAILURES_FILE="$TMP_ROOT/data/sync-failures.json"
export API_CONTRACT_STATE_DIR="$TMP_ROOT/data/sync-state"
node src/index.js > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!
ready=0
for i in $(seq 1 80); do
  if node -e "fetch('http://127.0.0.1:$PORT_VALUE/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.25
done
if [ "$ready" -ne 1 ]; then
  echo "Isolated contract server did not become healthy on port $PORT_VALUE" >&2
  exit 1
fi
node scripts/api-contract-smoke.mjs
`;

const result = spawnSync(dockerBin, [
  'compose',
  'exec',
  '-T',
  'teable-sync',
  'sh',
  '-lc',
  isolatedRunner,
], { stdio: 'inherit' });

process.exit(result.status ?? 1);
