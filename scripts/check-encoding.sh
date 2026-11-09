#!/usr/bin/env bash
# Claude Code hook (PostToolUse on Edit / Write / Bash / PowerShell, see .claude/settings.json). After every change it checks
# the text files that differ from HEAD for the damage a script edit has done to Cyrillic here (docs/LESSONS.md, checklist 1):
#   - double encoding: UTF-8 read as Latin-1 and written back, so every Cyrillic letter becomes "D-stroke" or "N-tilde"
#     plus a Latin-1 symbol (bytes C3 90/91 C2 80-BF). Text about it should not put a guillemet right after those letters;
#   - invalid UTF-8.
# Only new damage counts: a file is reported when it has more of it than its HEAD copy. Silent when all is well; on damage it
# exits 2, and Claude Code hands the message to Claude. Manual run: bash scripts/check-encoding.sh
cd "$(dirname "$0")" 2>/dev/null && cd "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || exit 0   # the repo this script is in, wherever the hook runs from
export LC_ALL=C
pat=$'\xC3[\x90\x91]\xC2[\x80-\xBF]'
types=('*.html' '*.js' '*.mjs' '*.ts' '*.css' '*.md' '*.sql' '*.json' '*.sh' '*.ps1' '*.yml')
bad=()
while IFS= read -r f; do
  [ -f "$f" ] || continue
  now=$(grep -c "$pat" "$f")
  was=$(git show "HEAD:$f" 2>/dev/null | grep -c "$pat")
  [ "$now" -gt "${was:-0}" ] && bad+=("$f: $((now - ${was:-0})) new lines with double-encoded Cyrillic (Ð/Ñ + a Latin-1 symbol)")
  if ! iconv -f UTF-8 -t UTF-8 "$f" >/dev/null 2>&1; then
    git cat-file -e "HEAD:$f" 2>/dev/null && ! git show "HEAD:$f" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1 || bad+=("$f: not valid UTF-8 any more")
  fi
done < <({ git diff --name-only HEAD -- "${types[@]}"; git ls-files --others --exclude-standard -- "${types[@]}"; } 2>/dev/null | sort -u)
[ ${#bad[@]} -eq 0 ] && exit 0
{
  echo "Encoding check: the last change broke text encoding (docs/LESSONS.md, checklist 1):"
  printf '  - %s\n' "${bad[@]}"
  echo "Undo it before anything else: redo the change with the Edit tool (never perl/sed with non-ASCII text);"
  echo "'git diff <file>' shows the damage, 'git checkout -- <file>' drops every uncommitted change to that file."
} >&2
exit 2
