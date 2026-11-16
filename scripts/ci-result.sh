# Waits for the Tests run (.github/workflows/tests.yml) of a commit and prints its result without logging in to GitHub:
# the run's link and conclusion, then the annotations — smoke writes one line per width and sign-in state (::notice:: when
# clean, ::error:: with what broke), the public API shows them while the run's log needs a login.
#   bash scripts/ci-result.sh            # the commit at HEAD
#   bash scripts/ci-result.sh <sha>
# A push that touches none of the workflow's paths has no Tests run: after ~3 min it says so.
R=https://api.github.com/repos/Rub1n1337/cryptoscreener
SHA=${1:-$(git rev-parse HEAD)}
id=''
for i in $(seq 1 60); do
  j=$(curl -s "$R/actions/runs?head_sha=$SHA&per_page=10" | tr -d '\n' | grep -o '"id": *[0-9]*, *"name": *"Tests"[^}]*' | head -1)
  id=$(echo "$j" | grep -o '^"id": *[0-9]*' | grep -o '[0-9]*$')
  st=$(echo "$j" | grep -o '"status": *"[a-z_]*"' | grep -o '"[a-z_]*"$' | tr -d '"')
  [ -z "$id" ] && [ "$i" -ge 9 ] && { echo "no Tests run for ${SHA:0:7} (no matching paths?)"; exit 0; }
  [ "$st" = completed ] && break
  sleep 20
done
co=$(curl -s "$R/actions/runs/$id" | grep -o '"conclusion": *"\?[a-z_]*' | grep -o '[a-z_]*$')
echo "Tests ${SHA:0:7}: ${co:-$st} https://github.com/Rub1n1337/cryptoscreener/actions/runs/$id"
for cr in $(curl -s "$R/actions/runs/$id/jobs" | grep -o '"check_run_url": *"[^"]*"' | grep -o '[0-9]*"$' | tr -d '"'); do
  curl -s "$R/check-runs/$cr/annotations?per_page=100" | tr -d '\n' | grep -o '"title": *"[^"]*", *"message": *"[^"]*"' \
    | grep -v 'Node.js 20' | sed 's/"title": *"\([^"]*\)", *"message": *"\([^"]*\)"/  \1: \2/'
done
[ "$co" = success ]
