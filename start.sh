#!/usr/bin/env bash
#
# start.sh — one-shot setup / install / enable for @deepseek-ai/dsh-peak-pricing.
#
# Interactively (default) or from flags/env (non-interactive, CI-friendly), it
# collects the plugin configuration — timezone, peak windows, effective date,
# peak preset, and an optional tariff override — renders a validated cordis.yml
# entry, verifies the config against the plugin's own schema, installs and
# builds the package when run inside this repository, and can append the entry
# to a deepseek-harness deployment's cordis.yml.
#
# Usage:
#   ./start.sh                          # interactive wizard, writes ./cordis.yml
#   ./start.sh --out peak.cordis.yml    # non-interactive, all defaults
#   ./start.sh --timezone UTC --windows 09:00-12:00,14:00-18:00 \
#              --provider deepseek --model deepseek-v4-flash \
#              --effective-from 2026-08-17T00:00:00+08:00
#   ./start.sh --harness ~/deepseek-harness/examples/headless-agent
#
# Flags:
#   --timezone <zone>       IANA timezone (default: Asia/Shanghai)
#   --windows <list>        comma-separated HH:mm-HH:mm ranges (default: 09:00-12:00,14:00-18:00)
#   --effective-from <rfc>  RFC 3339 instant before which the switch never engages
#   --provider <route>      peak preset provider (default: deepseek)
#   --model <id>            peak preset model (default: deepseek-v4-flash)
#   --effort <id>           optional peak reasoning effort
#   --tariff <spec>         optional per-model overrides; "model:peakHit,peakIn,peakOut,offHit,offIn,offOut[;...]"
#   --out <file>            where to write the cordis.yml (default: ./cordis.yml)
#   --harness <dir>         deepseek-harness deployment dir; append the entry to its cordis.yml
#   --install               run pnpm install + pnpm build after writing (repo runs)
#   --no-install            skip install/build even inside this repository
#   --force                 overwrite --out without asking
#   --quiet                 print only the final summary
#   -h, --help              show this help and exit
#
# Environment: every flag has a START_* twin (START_TZ, START_WINDOWS,
# START_EFFECTIVE_FROM, START_PROVIDER, START_MODEL, START_EFFORT, START_TARIFF,
# START_OUT, START_HARNESS, START_INSTALL=0|1); flags win over environment.
# Exits non-zero when the config fails the plugin's own validation.
#
set -euo pipefail

# --- defaults ---------------------------------------------------------------
DEFAULT_TZ="Asia/Shanghai"
DEFAULT_WINDOWS="09:00-12:00,14:00-18:00"
DEFAULT_PROVIDER="deepseek"
DEFAULT_MODEL="deepseek-v4-flash"

TZ_VAL="${START_TZ:-}"
WINDOWS_VAL="${START_WINDOWS:-}"
FROM_VAL="${START_EFFECTIVE_FROM:-}"
PROVIDER_VAL="${START_PROVIDER:-}"
MODEL_VAL="${START_MODEL:-}"
EFFORT_VAL="${START_EFFORT:-}"
TARIFF_VAL="${START_TARIFF:-}"
OUT_VAL="${START_OUT:-}"
HARNESS_VAL="${START_HARNESS:-}"
INSTALL_VAL="${START_INSTALL:-}"
FORCE_VAL=0
QUIET_VAL=0

# --- helpers ----------------------------------------------------------------
log()  { [ "$QUIET_VAL" -ne 1 ] && printf '%s\n' "$*" >&2; }
die()  { printf 'start.sh: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }

have_node() { command -v node >/dev/null 2>&1; }

# --- argument parsing -------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --timezone)        TZ_VAL="$2"; shift 2 ;;
    --windows)         WINDOWS_VAL="$2"; shift 2 ;;
    --effective-from)  FROM_VAL="$2"; shift 2 ;;
    --provider)        PROVIDER_VAL="$2"; shift 2 ;;
    --model)           MODEL_VAL="$2"; shift 2 ;;
    --effort)          EFFORT_VAL="$2"; shift 2 ;;
    --tariff)          TARIFF_VAL="$2"; shift 2 ;;
    --out)             OUT_VAL="$2"; shift 2 ;;
    --harness)         HARNESS_VAL="$2"; shift 2 ;;
    --install)         INSTALL_VAL=1; shift ;;
    --no-install)      INSTALL_VAL=0; shift ;;
    --force)           FORCE_VAL=1; shift ;;
    --quiet)           QUIET_VAL=1; shift ;;
    -h|--help)         sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

# --- interactive collection -------------------------------------------------
ask() { # ask <var> <prompt> <default>  — empty answer keeps the default
  local __var="$1" __prompt="$2" __default="$3" __answer
  printf '%s [%s]: ' "$__prompt" "$__default" >&2
  IFS= read -r __answer
  [ -n "$__answer" ] && eval "$__var=\$(printf '%s' \"\$__answer\")" || eval "$__var=\$(printf '%s' \"\$__default\")"
}

interactive=0
if [ -z "$TZ_VAL" ] && [ -z "$WINDOWS_VAL" ] && [ -z "$FROM_VAL" ] && \
   [ -z "$PROVIDER_VAL" ] && [ -z "$MODEL_VAL" ] && [ -z "$EFFORT_VAL" ] && \
   [ -z "$TARIFF_VAL" ] && [ -z "$OUT_VAL" ] && [ -z "$HARNESS_VAL" ] && \
   [ -z "$INSTALL_VAL" ]; then
  interactive=1
  echo "=== @deepseek-ai/dsh-peak-pricing setup ===" >&2
  echo "Peak windows: the preset model is used inside these daily wall-clock ranges." >&2
  echo "Off-peak (the rest of the day), the session/user model selection applies unchanged." >&2
  ask TZ_VAL "IANA timezone of the peak windows" "$DEFAULT_TZ"
  ask WINDOWS_VAL "Peak windows (HH:mm-HH:mm, comma separated)" "$DEFAULT_WINDOWS"
  ask FROM_VAL "Effective from (RFC 3339, empty = immediately)" ""
  [ -z "$FROM_VAL" ] && FROM_VAL=""
  echo "Peak preset: the model requests are routed to inside the windows." >&2
  ask PROVIDER_VAL "Preset provider (registered route)" "$DEFAULT_PROVIDER"
  ask MODEL_VAL "Preset model (route-served id)" "$DEFAULT_MODEL"
  ask EFFORT_VAL "Optional peak reasoning effort (empty = provider default)" ""
  [ -z "$EFFORT_VAL" ] && EFFORT_VAL=""
  ask TARIFF_VAL "Tariff overrides (empty = built-in DeepSeek tariff)" ""
  [ -z "$TARIFF_VAL" ] && TARIFF_VAL=""
  ask OUT_VAL "Output file" "cordis.yml"
  ask HARNESS_VAL "deepseek-harness deployment dir (empty = skip mounting)" ""
  [ -z "$HARNESS_VAL" ] && HARNESS_VAL=""
  ask INSTALL_VAL "Run install + build inside this repo? (y/N)" "N"
  case "$INSTALL_VAL" in y|Y|yes|YES|1) INSTALL_VAL=1 ;; *) INSTALL_VAL=0 ;; esac
fi

# --- normalize --------------------------------------------------------------
TZ_VAL="${TZ_VAL:-$DEFAULT_TZ}"
WINDOWS_VAL="${WINDOWS_VAL:-$DEFAULT_WINDOWS}"
PROVIDER_VAL="${PROVIDER_VAL:-$DEFAULT_PROVIDER}"
MODEL_VAL="${MODEL_VAL:-$DEFAULT_MODEL}"
OUT_VAL="${OUT_VAL:-cordis.yml}"

# --- validate windows syntax ------------------------------------------------
[ -n "$WINDOWS_VAL" ] || die "--windows must not be empty"
IFS=',' read -r -a WINDOW_LIST <<< "$WINDOWS_VAL"
for w in "${WINDOW_LIST[@]}"; do
  case "$w" in
    [0-2][0-9]:[0-5][0-9]-[0-2][0-9]:[0-5][0-9]) ;;
    *) die "invalid window '$w': expected HH:mm-HH:mm" ;;
  esac
done

# --- tariff spec parsing ----------------------------------------------------
# --tariff "model:peakHit,peakIn,peakOut,offHit,offIn,offOut[;model:...]"
TARIFF_YAML=""
if [ -n "$TARIFF_VAL" ]; then
  IFS=';' read -r -a TARIFF_ITEMS <<< "$TARIFF_VAL"
  for item in "${TARIFF_ITEMS[@]}"; do
    model="${item%%:*}"
    prices="${item#*:}"
    [ -n "$model" ] || die "--tariff item missing model name: '$item'"
    IFS=',' read -r -a p <<< "$prices"
    [ "${#p[@]}" -eq 6 ] || die "--tariff for '$model' needs 6 prices: peakHit,peakIn,peakOut,offHit,offIn,offOut"
    for n in "${p[@]}"; do
      case "$n" in
        *[!0-9.]*|''|.*) die "--tariff for '$model' has non-numeric price '$n'" ;;
      esac
    done
    TARIFF_YAML="${TARIFF_YAML}      ${model}:
        peak:
          inputCacheHit: ${p[0]}
          input: ${p[1]}
          output: ${p[2]}
        offPeak:
          inputCacheHit: ${p[3]}
          input: ${p[4]}
          output: ${p[5]}
"
  done
fi

# --- build config JSON for the validator ------------------------------------
CONFIG_JSON="$(CFG_TZ="$TZ_VAL" CFG_WINDOWS="$WINDOWS_VAL" CFG_PROVIDER="$PROVIDER_VAL" \
  CFG_MODEL="$MODEL_VAL" CFG_FROM="$FROM_VAL" CFG_EFFORT="$EFFORT_VAL" CFG_TARIFF="$TARIFF_VAL" \
  node -e '
const tz = process.env.CFG_TZ;
const windows = process.env.CFG_WINDOWS.split(",").map(w => {
  const [start, end] = w.split("-");
  return { start, end };
});
const out = { timezone: tz, peakWindows: windows, peak: { provider: process.env.CFG_PROVIDER, model: process.env.CFG_MODEL } };
if (process.env.CFG_FROM) out.effectiveFrom = process.env.CFG_FROM;
if (process.env.CFG_EFFORT) out.peak.reasoningEffort = process.env.CFG_EFFORT;
const tariff = process.env.CFG_TARIFF;
if (tariff) {
  out.tariff = {};
  for (const item of tariff.split(";")) {
    const [model, prices] = item.split(":");
    const [peakHit, peakIn, peakOut, offHit, offIn, offOut] = prices.split(",").map(Number);
    out.tariff[model] = { peak: { inputCacheHit: peakHit, input: peakIn, output: peakOut }, offPeak: { inputCacheHit: offHit, input: offIn, output: offOut } };
  }
}
process.stdout.write(JSON.stringify(out));
')"

# --- validate against the plugin's own schema --------------------------------
validate_config() {
  need node
  node --input-type=module -e '
import { apply, Config } from "./lib/index.js";
import { Context } from "@deepseek-ai/cordis";
import { readFileSync } from "node:fs";
const config = JSON.parse(readFileSync(process.argv[1], "utf8"));
try {
  const parsed = Config(config);
  const ctx = new Context();
  try { apply(ctx, parsed); } finally { await ctx.fiber.dispose(); }
} catch (err) {
  console.error("config validation failed: " + (err && err.message ? err.message : err));
  process.exit(1);
}
' "$CONFIG_JSON_FILE"
}

# write the config to a temp JSON so the validator imports the built lib
CONFIG_JSON_FILE="$(mktemp)"
trap 'rm -f "$CONFIG_JSON_FILE"' EXIT
printf '%s' "$CONFIG_JSON" > "$CONFIG_JSON_FILE"

if have_node; then
  if [ -f "$PWD/lib/index.js" ] || [ -f "lib/index.js" ]; then
    log "validating config against the plugin schema…"
    (cd "$PWD" && validate_config) || die "config validation failed"
  else
    log "lib/ not built; skipping in-place schema validation (run --install or pnpm run build)"
  fi
fi

# --- render the cordis.yml ----------------------------------------------------
entry=""
entry="${entry}- name: '@deepseek-ai/dsh-peak-pricing'"$'\n'
entry="${entry}  config:"$'\n'
entry="${entry}    timezone: ${TZ_VAL}"$'\n'
entry="${entry}    peakWindows:"$'\n'
for w in "${WINDOW_LIST[@]}"; do
  entry="${entry}      - start: '${w%%-*}'"$'\n'
  entry="${entry}        end: '${w#*-}'"$'\n'
done
[ -n "$FROM_VAL" ] && entry="${entry}    effectiveFrom: '${FROM_VAL}'"$'\n'
entry="${entry}    peak:"$'\n'
entry="${entry}      provider: ${PROVIDER_VAL}"$'\n'
entry="${entry}      model: ${MODEL_VAL}"$'\n'
[ -n "$EFFORT_VAL" ] && entry="${entry}      reasoningEffort: ${EFFORT_VAL}"$'\n'
if [ -n "$TARIFF_YAML" ]; then
  entry="${entry}    tariff:"$'\n'
  entry="${entry}${TARIFF_YAML}"
fi

# --- write output ------------------------------------------------------------
if [ -e "$OUT_VAL" ] && [ "$FORCE_VAL" -ne 1 ]; then
  die "--out $OUT_VAL exists; pass --force to overwrite (or pick another --out)"
fi
printf '%s\n' "$entry" > "$OUT_VAL"
log "wrote $OUT_VAL"

# --- mount into a harness deployment ------------------------------------------
if [ -n "$HARNESS_VAL" ]; then
  [ -d "$HARNESS_VAL" ] || die "--harness $HARNESS_VAL is not a directory"
  harness_yaml="$HARNESS_VAL/cordis.yml"
  if [ -f "$harness_yaml" ]; then
    printf '\n%s\n' "$entry" >> "$harness_yaml"
    log "appended the plugin entry to $harness_yaml"
  else
    printf '%s\n' "$entry" > "$harness_yaml"
    log "created $harness_yaml with the plugin entry"
  fi
fi

# --- install / build ----------------------------------------------------------
do_install=0
if [ -n "$INSTALL_VAL" ]; then
  case "$INSTALL_VAL" in 1|y|Y|yes|YES) do_install=1 ;; *) do_install=0 ;; esac
fi
if [ "$do_install" -eq 1 ]; then
  need pnpm
  log "installing dependencies…"
  pnpm install
  log "building…"
  pnpm run build
fi

# --- summary -------------------------------------------------------------------
echo "Done." >&2
echo "Plugin entry written to: $OUT_VAL" >&2
if [ -n "$HARNESS_VAL" ]; then
  echo "Mounted into: $HARNESS_VAL/cordis.yml" >&2
fi
echo "Peak windows: $WINDOWS_VAL ($TZ_VAL); preset: $PROVIDER_VAL/$MODEL_VAL" >&2
if [ -n "$FROM_VAL" ]; then
  echo "Effective from: $FROM_VAL" >&2
fi
if [ -n "$TARIFF_VAL" ]; then
  echo "Tariff overrides: $TARIFF_VAL" >&2
fi
