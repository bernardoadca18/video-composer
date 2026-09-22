#!/bin/bash
set -euo pipefail

# Video Composer Entrypoint
# Prepares data directories with correct ownership when running as root,
# then drops privileges to run as the 'node' user.

DATA_ROOT="${DATA_ROOT:-/data}"
NODE_UID="${NODE_UID:-1000}"
NODE_GID="${NODE_GID:-1000}"

# Required directories under /data that must be writable
REQUIRED_DIRS=(
  "db"
  "cache"
  "cache/source"
  "cache/proxies"
  "cache/narration"
  "cache/music"
  "cache/program-audio"
  "work"
  "outputs"
  "recovery"
)

log() {
  echo "[entrypoint] $1"
}

log "Starting Video Composer entrypoint"
log "DATA_ROOT=${DATA_ROOT}"
log "Running as: $(id)"

# If running as root, prepare directories and drop privileges
if [ "$(id -u)" = "0" ]; then
  log "Running as root, preparing data directories..."

  # Create data root if it doesn't exist
  if [ ! -d "${DATA_ROOT}" ]; then
    log "Creating ${DATA_ROOT}"
    mkdir -p "${DATA_ROOT}"
  fi

  # Create each required directory with correct ownership
  for dir in "${REQUIRED_DIRS[@]}"; do
    full_path="${DATA_ROOT}/${dir}"
    if [ ! -d "${full_path}" ]; then
      log "Creating ${full_path}"
      mkdir -p "${full_path}"
    fi
  done

  # Set ownership of data root and subdirectories
  # We use explicit ownership rather than recursive chown
  # to avoid touching large cache directories unnecessarily
  log "Setting ownership of ${DATA_ROOT} to ${NODE_UID}:${NODE_GID}"
  chown "${NODE_UID}:${NODE_GID}" "${DATA_ROOT}"

  for dir in "${REQUIRED_DIRS[@]}"; do
    full_path="${DATA_ROOT}/${dir}"
    log "Setting ownership of ${full_path} to ${NODE_UID}:${NODE_GID}"
    chown "${NODE_UID}:${NODE_GID}" "${full_path}"
  done

  # Verify critical directories are writable
  log "Verifying critical directories are writable..."
  for dir in "db" "work" "outputs" "recovery"; do
    test_file="${DATA_ROOT}/${dir}/.write_test_$$"
    if ! gosu node touch "${test_file}" 2>/dev/null; then
      log "ERROR: Directory ${DATA_ROOT}/${dir} is not writable by node user"
      exit 1
    fi
    rm -f "${test_file}"
  done

  log "Dropping privileges to node user"

  # Use gosu to drop privileges and exec the command
  exec gosu node "$@"
else
  # Already running as non-root user
  log "Running as non-root user $(id -un), skipping privilege setup"
  exec "$@"
fi
