#!/bin/zsh

set -eu
setopt pipefail

fail() {
  print -u2 -r -- "JUDGE_DEMO_PREFLIGHT_FAILED: $1"
  exit 1
}

script_dir=${0:A:h}
repository_root=${script_dir:h}
api_port=${NERVELOOP_DEMO_API_PORT:-3100}
web_port=${NERVELOOP_DEMO_WEB_PORT:-5173}
synthetic_default_token="nerveloop-local-judge-demo-2026"

if [[ -v APP_AUTH_TOKEN ]]; then
  demo_token=${APP_AUTH_TOKEN}
  token_source="caller supplied; value not printed"
else
  demo_token=${synthetic_default_token}
  token_source="documented synthetic local default"
fi

[[ ${api_port} =~ '^[0-9]+$' ]] || fail "NERVELOOP_DEMO_API_PORT must be numeric."
[[ ${web_port} =~ '^[0-9]+$' ]] || fail "NERVELOOP_DEMO_WEB_PORT must be numeric."
(( api_port >= 1024 && api_port <= 65535 )) || fail "API port must be between 1024 and 65535."
(( web_port >= 1024 && web_port <= 65535 )) || fail "Web port must be between 1024 and 65535."
(( api_port != web_port )) || fail "API and web ports must differ."
[[ ${demo_token} =~ '^[A-Za-z0-9._~-]{24,}$' ]] || fail "APP_AUTH_TOKEN must be 24+ URL-safe characters."

server_runtime=${repository_root}/node_modules/.bin/tsx
web_runtime=${repository_root}/node_modules/.bin/vite
curl_runtime=$(command -v curl 2>/dev/null || true)
[[ -x ${server_runtime} ]] || fail "tsx is missing; restore the locked dependencies before launching."
[[ -x ${web_runtime} ]] || fail "vite is missing; restore the locked dependencies before launching."
[[ -n ${curl_runtime} ]] || fail "curl is required for the bounded API readiness check."
[[ -f ${repository_root}/apps/server/src/index.ts ]] || fail "Server entrypoint is missing."
[[ -f ${repository_root}/apps/web/index.html ]] || fail "Web entrypoint is missing."

if (( $# > 1 )); then
  fail "Expected no argument or --check."
fi

if (( $# == 1 )); then
  [[ $1 == "--check" ]] || fail "Unknown argument: $1"
  print -r -- "JUDGE_DEMO_PREFLIGHT_PASS"
  print -r -- "api=http://127.0.0.1:${api_port}"
  print -r -- "web=http://127.0.0.1:${web_port}/"
  print -r -- "runner=fixed-no-model"
  print -r -- "token=${token_source}"
  print -r -- "launch_performed=false"
  exit 0
fi

server_pid=""
web_pid=""

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  for owned_pid in ${web_pid} ${server_pid}; do
    if [[ -n ${owned_pid} ]] && kill -0 ${owned_pid} 2>/dev/null; then
      kill -TERM ${owned_pid} 2>/dev/null || true
    fi
  done
  for owned_pid in ${web_pid} ${server_pid}; do
    if [[ -n ${owned_pid} ]]; then
      wait ${owned_pid} 2>/dev/null || true
    fi
  done
  exit ${exit_code}
}

trap 'exit 130' INT
trap 'exit 143' TERM
trap cleanup EXIT

(
  cd ${repository_root}
  HOST=127.0.0.1 \
    PORT=${api_port} \
    LOG_LEVEL=silent \
    DEMO_RUNNER=1 \
    APP_AUTH_TOKEN=${demo_token} \
    exec ${server_runtime} apps/server/src/index.ts
) &
server_pid=$!

api_ready=0
for attempt in {1..200}; do
  if ! kill -0 ${server_pid} 2>/dev/null; then
    wait ${server_pid}
    exit $?
  fi
  if ${curl_runtime} --fail --silent --max-time 0.25 \
    http://127.0.0.1:${api_port}/api/auth >/dev/null 2>&1; then
    api_ready=1
    break
  fi
  sleep 0.1
done
(( api_ready == 1 )) || fail "API did not become ready within 20 seconds."

(
  cd ${repository_root}/apps/web
  LOCAL_API_PROXY_TARGET=http://127.0.0.1:${api_port} \
    exec ${web_runtime} --host 127.0.0.1 --port ${web_port} --strictPort
) &
web_pid=$!

print -r -- "NerveLoop local judge demo starting"
print -r -- "web=http://127.0.0.1:${web_port}/"
print -r -- "api=http://127.0.0.1:${api_port}"
print -r -- "api_ready=true"
print -r -- "runner=fixed-no-model"
print -r -- "token=${token_source}"
if [[ ${token_source} == "documented synthetic local default" ]]; then
  print -r -- "synthetic_token=${synthetic_default_token}"
fi
print -r -- "Press Ctrl+C to stop both owned processes."

while true; do
  if ! kill -0 ${server_pid} 2>/dev/null; then
    wait ${server_pid}
    exit $?
  fi
  if ! kill -0 ${web_pid} 2>/dev/null; then
    wait ${web_pid}
    exit $?
  fi
  sleep 1
done
