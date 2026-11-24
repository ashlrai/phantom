#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: $0 <label> <lockfile> [--omit=dev]" >&2
  exit 64
fi

audit_label=$1
lockfile=$2
omit_arg=${3:-}
if [[ -n "${omit_arg}" && "${omit_arg}" != "--omit=dev" ]]; then
  echo "unsupported npm audit argument: ${omit_arg}" >&2
  exit 64
fi
if [[ ! -f "${lockfile}" ]]; then
  echo "npm audit lockfile is missing: ${lockfile}" >&2
  exit 66
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exception_file="${script_dir}/../.github/dependency-audit-exceptions.json"
npm_command=("${AUDIT_NODE_BIN:-${AUDIT_NPM_BIN:-npm}}")
if [[ -n "${AUDIT_NPM_CLI:-}" ]]; then
  npm_command+=("${AUDIT_NPM_CLI}")
fi
osv_bin=${AUDIT_OSV_BIN:-osv-scanner}
timeout_bin=${AUDIT_TIMEOUT_BIN:-timeout}
audit_tmp=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ashlr-npm-audit.XXXXXX")
cleanup() {
  cleanup_rc=$?
  trap - EXIT
  if ! rm -rf -- "${audit_tmp}" && [[ ${cleanup_rc} -eq 0 ]]; then
    cleanup_rc=74
  fi
  exit "${cleanup_rc}"
}
trap cleanup EXIT
osv_config="${audit_tmp}/osv-scanner.toml"
: > "${osv_config}"
chmod 0600 "${osv_config}"
active_exceptions_file="${audit_tmp}/active-exceptions.json"
used_exceptions_file="${audit_tmp}/used-exceptions.json"
printf '[]\n' > "${used_exceptions_file}"
chmod 0600 "${used_exceptions_file}"

write_summary() {
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf -- '- %s\n' "$1" >> "${GITHUB_STEP_SUMMARY}"
  fi
}

# Exceptions apply to full graphs, plus the Raycast production graph where the
# unpatched advisory arrives only through the @raycast/api CLI toolchain. The
# root production graph never consults the exception file.
exceptions_enabled=false
exception_graph=full
if [[ -z "${omit_arg}" ]]; then
  exceptions_enabled=true
else
  resolved_lockfile=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "${lockfile}")
  raycast_lockfile=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "${script_dir}/../src/raycast/package-lock.json")
  if [[ "${resolved_lockfile}" == "${raycast_lockfile}" ]]; then
    exceptions_enabled=true
    exception_graph=raycast-production
  fi
fi
if [[ "${exceptions_enabled}" == true ]]; then
  if ! node - "${exception_file}" "${active_exceptions_file}" "${osv_config}" "${exception_graph}" <<'NODE'
const fs = require('node:fs');

const [exceptionFile, activeFile, osvConfig, targetGraph] = process.argv.slice(2);
function fail(message) {
  console.error(`dependency audit exception file ${message}`);
  process.exit(1);
}

let exceptions;
try {
  exceptions = JSON.parse(fs.readFileSync(exceptionFile, 'utf8'));
} catch {
  fail(`is missing or malformed: ${exceptionFile}`);
}
if (!Array.isArray(exceptions)) fail('must contain a JSON array.');

const seen = new Set();
for (const [index, entry] of exceptions.entries()) {
  const fields = ['expires', 'graph', 'id', 'package', 'reason'];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      Object.keys(entry).sort().join(',') !== fields.join(',')) {
    fail(`entry ${index + 1} has an invalid shape.`);
  }
  if (typeof entry.id !== 'string' ||
      !/^GHSA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(entry.id)) {
    fail(`entry ${index + 1} has an invalid advisory id.`);
  }
  if (typeof entry.package !== 'string' ||
      !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(entry.package)) {
    fail(`entry ${index + 1} has an invalid package name.`);
  }
  if (entry.graph !== 'full' && entry.graph !== 'raycast-production') {
    fail(`entry ${index + 1} must target the full or raycast-production graph.`);
  }
  if (typeof entry.expires !== 'string' ||
      !Number.isFinite(Date.parse(entry.expires)) ||
      new Date(entry.expires).toISOString().replace(/\.000Z$/, 'Z') !== entry.expires) {
    fail(`entry ${index + 1} has an invalid expiration timestamp.`);
  }
  if (typeof entry.reason !== 'string' || !entry.reason.trim() ||
      /[\u0000-\u001f\u007f]/.test(entry.reason)) {
    fail(`entry ${index + 1} has an invalid reason.`);
  }
  const key = `${entry.graph}\u0000${entry.id}\u0000${entry.package}`;
  if (seen.has(key)) fail(`contains a duplicate exception for ${entry.id} (${entry.package}).`);
  seen.add(key);
  if (Date.parse(entry.expires) <= Date.now()) {
    fail(`${entry.id} for ${entry.package} expired at ${entry.expires}.`);
  }
}

const active = exceptions.filter(entry => entry.graph === targetGraph);
fs.writeFileSync(activeFile, `${JSON.stringify(active)}\n`, { mode: 0o600 });
const toml = active.map(({ id, expires, reason }) => [
  '[[IgnoredVulns]]',
  `id = ${JSON.stringify(id)}`,
  `ignoreUntil = ${expires}`,
  `reason = ${JSON.stringify(reason)}`,
].join('\n')).join('\n\n');
fs.writeFileSync(osvConfig, toml ? `${toml}\n` : '');
NODE
  then
    write_summary "${audit_label}: dependency audit exception file is invalid or expired; failed closed."
    exit 70
  fi
fi

is_fully_exempt_npm_report() {
  node - "$1" "${active_exceptions_file}" "${used_exceptions_file}" <<'NODE'
const fs = require('node:fs');

let report;
let exceptions;
try {
  report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  exceptions = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
} catch {
  process.exit(1);
}
const vulnerabilities = report?.vulnerabilities;
if (!vulnerabilities || typeof vulnerabilities !== 'object' || Array.isArray(vulnerabilities)) {
  process.exit(1);
}

const used = new Set();
// npm lists a package that is vulnerable only through another vulnerable
// package as a string `via` entry naming that package, and those references
// can be cyclic (vitest <-> @vitest/coverage-v8). Start by assuming every
// package is exempt, then repeatedly drop any package with a `via` entry that
// is neither an excepted advisory nor a package still assumed exempt.
const names = Object.keys(vulnerabilities);
const exempt = new Set(names);
const usedByPackage = new Map();
let changed = true;
while (changed) {
  changed = false;
  for (const packageKey of names) {
    if (!exempt.has(packageKey)) continue;
    const vulnerability = vulnerabilities[packageKey];
    let ok = Boolean(vulnerability) && typeof vulnerability === 'object' &&
      vulnerability.name === packageKey && Array.isArray(vulnerability.via) &&
      vulnerability.via.length > 0;
    const found = [];
    if (ok) {
      const packageExceptions = exceptions.filter(exception => exception.package === vulnerability.name);
      ok = vulnerability.via.every(advisory => {
        if (typeof advisory === 'string') return advisory !== packageKey && exempt.has(advisory);
        if (!advisory || typeof advisory !== 'object' || typeof advisory.url !== 'string') {
          return false;
        }
        const ids = advisory.url.match(/GHSA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/gi) ?? [];
        const id = ids.length === 1 ? ids[0].toUpperCase() : '';
        const exception = packageExceptions.find(candidate => candidate.id.toUpperCase() === id);
        if (!exception) return false;
        found.push(`${exception.id}\u0000${exception.package}`);
        return true;
      });
    }
    if (!ok) {
      exempt.delete(packageKey);
      changed = true;
    } else {
      usedByPackage.set(packageKey, found);
    }
  }
}
const allAllowed = names.length > 0 && exempt.size === names.length;
for (const found of usedByPackage.values()) for (const key of found) used.add(key);
fs.writeFileSync(process.argv[4], `${JSON.stringify([...used])}\n`);
process.exit(allAllowed ? 0 : 1);
NODE
}

write_exception_usage_summary() {
  [[ "${exceptions_enabled}" == true ]] || return 0
  local usage
  usage=$(node - "${active_exceptions_file}" "${used_exceptions_file}" <<'NODE'
const fs = require('node:fs');
const [activePath, usedPath] = process.argv.slice(2);
const active = JSON.parse(fs.readFileSync(activePath, 'utf8'));
const used = new Set(JSON.parse(fs.readFileSync(usedPath, 'utf8')));
for (const exception of active) {
  const key = `${exception.id}\u0000${exception.package}`;
  const state = used.has(key) ? 'used' : 'unused';
  console.log(`${state}\t${exception.id}\t${exception.package}`);
}
NODE
  ) || return 1
  while IFS=$'\t' read -r state id package_name; do
    [[ -n "${id}" ]] || continue
    if [[ "${state}" == "used" ]]; then
      write_summary "${audit_label}: applied dependency audit exception ${id} for ${package_name}."
    else
      write_summary "WARNING: ${audit_label}: dependency audit exception ${id} for ${package_name} was unused."
    fi
  done <<< "${usage}"
}

is_valid_npm_report() {
  node -e '
    const fs = require("node:fs");
    try {
      const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const counts = report?.metadata?.vulnerabilities;
      if (report?.auditReportVersion !== 2 || typeof counts !== "object") process.exit(1);
      for (const severity of ["info", "low", "moderate", "high", "critical", "total"]) {
        if (!Number.isInteger(counts[severity]) || counts[severity] < 0) process.exit(1);
      }
    } catch {
      process.exit(1);
    }
  ' "$1"
}

is_clean_npm_report() {
  node -e '
    const fs = require("node:fs");
    try {
      const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const counts = report?.metadata?.vulnerabilities;
      for (const severity of ["info", "low", "moderate", "high", "critical", "total"]) {
        if (counts?.[severity] !== 0) process.exit(1);
      }
    } catch {
      process.exit(1);
    }
  ' "$1"
}

npm_args=(audit --json --ignore-scripts --audit-level=low --fetch-retries=0 --fetch-timeout=30000)
if [[ -n "${omit_arg}" ]]; then
  npm_args+=("${omit_arg}")
fi

transport_pattern='network timeout|service unavailable|ECONN|EAI_AGAIN|ENETUNREACH|ETIMEDOUT|socket hang up|audit endpoint returned an error|request to .* failed|HTTP (408|429|5[0-9]{2})'
for attempt in 1 2 3; do
  stdout_file="${audit_tmp}/npm-${attempt}.json"
  stderr_file="${audit_tmp}/npm-${attempt}.stderr"
  if "${timeout_bin}" --signal=TERM --kill-after=5s 40s \
    "${npm_command[@]}" "${npm_args[@]}" > "${stdout_file}" 2> "${stderr_file}"; then
    audit_rc=0
  else
    audit_rc=$?
  fi

  cat "${stdout_file}"
  cat "${stderr_file}" >&2

  if [[ ${audit_rc} -eq 0 ]]; then
    if ! is_valid_npm_report "${stdout_file}"; then
      write_summary "${audit_label}: npm returned success without a valid audit v2 report; failed closed."
      exit 70
    fi
    if ! is_clean_npm_report "${stdout_file}"; then
      if [[ "${exceptions_enabled}" == true ]] &&
        is_fully_exempt_npm_report "${stdout_file}"; then
        write_exception_usage_summary
        write_summary "${audit_label}: npm audit passed with only active, explicitly excepted advisories."
        exit 0
      fi
      write_exception_usage_summary
      write_summary "${audit_label}: npm returned success with nonzero vulnerability counts; failed closed."
      exit 1
    fi
    write_exception_usage_summary
    write_summary "${audit_label}: primary npm audit passed with a valid audit v2 report."
    exit 0
  fi

  # A valid nonzero audit report is a vulnerability result, not a transport
  # failure. Never route it through the fallback provider.
  if is_valid_npm_report "${stdout_file}"; then
    if [[ "${exceptions_enabled}" == true ]] &&
      is_fully_exempt_npm_report "${stdout_file}"; then
      write_exception_usage_summary
      write_summary "${audit_label}: npm audit passed with only active, explicitly excepted advisories."
      exit 0
    fi
    write_exception_usage_summary
    write_summary "${audit_label}: primary npm audit reported vulnerabilities; failed closed."
    exit "${audit_rc}"
  fi

  if [[ ${audit_rc} -ne 124 && ${audit_rc} -ne 137 ]] &&
    ! grep -Eiq "${transport_pattern}" "${stdout_file}" "${stderr_file}"; then
    write_summary "${audit_label}: npm failed for a non-transport reason; fallback was not authorized."
    exit "${audit_rc}"
  fi

  if [[ ${attempt} -lt 3 ]]; then
    sleep "$((attempt * 5))"
  fi
done

write_summary "${audit_label}: npm transport failed after 3 bounded attempts; invoking pinned OSV-Scanner."
if "${timeout_bin}" --signal=TERM --kill-after=5s 60s \
  "${osv_bin}" scan source --config "${osv_config}" --lockfile "${lockfile}" --format table; then
  if [[ "${exceptions_enabled}" == true ]]; then
    write_summary "${audit_label}: active dependency audit exceptions were supplied to OSV-Scanner fallback."
  fi
  write_summary "${audit_label}: pinned OSV-Scanner fallback passed for ${lockfile}."
  exit 0
else
  audit_rc=$?
  write_summary "${audit_label}: pinned OSV-Scanner fallback failed; no provider returned a clean result."
  exit "${audit_rc}"
fi
