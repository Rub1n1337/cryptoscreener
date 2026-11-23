# Do the Edge Functions parse, and does every import resolve (files, npm packages, named exports)? Each function is bundled with
# everything it imports, the bundles are thrown away. Types are not checked: `deno check` fails on the current code (23.11.2026).
# Run by deploy-functions.yml before the first deploy and by tests.yml; needs Deno (pinned there).
#   bash scripts/check-functions.sh [folder with the functions, default supabase/functions]
dir=${1:-supabase/functions}
out=$(mktemp -d)
bad=0
for fn in bot tg auth; do
  if deno bundle --no-lock --output "$out/$fn.js" "$dir/$fn/index.ts" > "$out/$fn.log" 2>&1 && [ -s "$out/$fn.js" ]; then
    echo "$fn: ok"
  else
    bad=1
    msg=$(sed 's/\x1b\[[0-9;]*m//g' "$out/$fn.log" | grep -v '^Download')
    echo "$fn: FAILED"; echo "$msg"
    # an annotation can be read through the public API, the run's log needs a login (scripts/ci-result.sh)
    [ -n "$GITHUB_ACTIONS" ] && echo "::error title=function $fn::$(printf '%s' "$msg" | tail -c 2000 | sed 's/%/%25/g' | awk '{printf "%s%%0A",$0}')"
  fi
done
[ $bad = 0 ]
