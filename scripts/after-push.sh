#!/usr/bin/env bash
# After `git push`: waits for Vercel to serve the site version and for the GitHub Actions run of this commit (functions deploy),
# and prints one line for each. usage: scripts/after-push.sh 2.51   (no version: the functions only)
v="$1"; sha=$(git rev-parse HEAD); site=https://cryptoscreener-topaz.vercel.app; api=https://api.github.com/repos/Rub1n1337/cryptoscreener
wait10() { timeout 10 tail -f /dev/null; }
if [ -n "$v" ]; then
  for i in $(seq 1 18); do
    got=$(curl -s "$site/?nc=$RANDOM" | grep -o "v:'[0-9.]*'" | head -1)
    [ "$got" = "v:'$v'" ] && { echo "vercel: $v"; break; }
    [ "$i" = 18 ] && echo "vercel: still $got after 3 min — redeploy by hand (create_deployment withLatestCommit)"; wait10
  done
fi
for i in $(seq 1 24); do
  runs=$(curl -s "$api/actions/runs?head_sha=$sha")
  echo "$runs" | grep -q '"total_count": 0' && { [ "$i" -ge 3 ] && { echo "actions: no run for this commit (functions unchanged)"; break; }; wait10; continue; }
  st=$(echo "$runs" | grep -o '"status": "[a-z_]*"' | head -1 | cut -d'"' -f4); co=$(echo "$runs" | grep -o '"conclusion": "[a-z_]*"' | head -1 | cut -d'"' -f4)
  [ "$st" = completed ] && { echo "actions: $co"; break; }
  [ "$i" = 24 ] && echo "actions: still $st after 4 min"; wait10
done
