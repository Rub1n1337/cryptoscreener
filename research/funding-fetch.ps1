# Funding-rate history of Binance USDⓈ-M perpetuals for research/funding.js (docs/RESEARCH-EDGE.md).
# Reads research/data/syms.txt (spot pairs of the research pools, comma-separated; made in the preview with
#   const R = await import('/research/stage05.js'); [...new Set((await R.pools(R.yearsBack())).flat())].sort().join(',')
# without the two pairs with Chinese names), tries the perpetual of the same name and
# the "1000" one (1000PEPEUSDT for PEPEUSDT), writes research/data/funding/<SPOT>.json = {"p": perp, "t": [ms...], "r": [rate...]}
# (an empty "p" = no perpetual) and at the end research/data/funding.json with all of them. Files already there are kept
# (the run resumes). research/data/ is not committed. /fapi/v1/fundingRate shares 500 requests per 5 min per IP: one
# request every 0.65 s. Run: powershell -NoProfile -ExecutionPolicy Bypass -File research/funding-fetch.ps1
# variables are case-insensitive in PowerShell: $t and $T are one variable
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dir = Join-Path $root 'research/data/funding'
New-Item -ItemType Directory -Force $dir | Out-Null
$from = [long]1699400000000   # 2023-11-08, a few days before the first research year
$now = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
$syms = (Get-Content (Join-Path $root 'research/data/syms.txt') -Raw).Trim().Split(',') | Where-Object { $_ }
# a second copy run with "-File … reverse" goes from the end (both stay under the limit: ~0.6 requests a second each)
if ($args -contains 'reverse') { [array]::Reverse($syms) }
if ($args -contains 'middle') { $h = [int]($syms.Count / 2); $syms = $syms[$h..($syms.Count - 1)] + $syms[0..($h - 1)] }   # a third copy from the middle
function Get-Funding($perp) {
  $t = $from; $TT = New-Object System.Collections.Generic.List[long]; $RR = New-Object System.Collections.Generic.List[double]
  while ($t -lt $now) {
    $u = "https://fapi.binance.com/fapi/v1/fundingRate?symbol=$perp&startTime=$t&limit=1000"
    $rows = $null
    for ($a = 0; $a -lt 5; $a++) {
      try { $rows = Invoke-RestMethod -Uri $u -TimeoutSec 20; break }
      catch {
        $code = 0; try { $code = [int]$_.Exception.Response.StatusCode } catch {}
        if ($code -eq 400) { return $null }
        if ($code -eq 429 -or $code -eq 418) { Start-Sleep -Seconds 60 } else { Start-Sleep -Seconds (2 * ($a + 1)) }
      }
    }
    Start-Sleep -Milliseconds 650
    if ($null -eq $rows) { throw "failed $u" }
    $rows = @($rows)
    if ($rows.Count -eq 0) { break }
    foreach ($x in $rows) { $TT.Add([long]$x.fundingTime); $RR.Add([double]$x.fundingRate) }
    $t = [long]$rows[-1].fundingTime + 1
    if ($rows.Count -lt 1000) { break }
  }
  if ($TT.Count -eq 0) { return $null }
  return @{ t = $TT; r = $RR }
}
$n = 0
foreach ($s in $syms) {
  $n++
  $f = Join-Path $dir "$s.json"
  if (Test-Path $f) { continue }
  $base = $s.Substring(0, $s.Length - 4)
  $got = $null; $perp = ''
  foreach ($p in @($s, "1000$($base)USDT")) {
    $got = Get-Funding $p
    if ($got) { $perp = $p; break }
  }
  if ($got) { $json = '{"p":"' + $perp + '","t":[' + ($got.t -join ',') + '],"r":[' + (($got.r | ForEach-Object { $_.ToString('R', [Globalization.CultureInfo]::InvariantCulture) }) -join ',') + ']}' }
  else { $json = '{"p":"","t":[],"r":[]}' }
  [IO.File]::WriteAllText($f, $json)
  Write-Host "$n/$($syms.Count) $s $perp $(if ($got) { $got.t.Count } else { 0 })"
}
$parts = Get-ChildItem $dir -Filter *.json | ForEach-Object { '"' + $_.BaseName + '":' + [IO.File]::ReadAllText($_.FullName) }
[IO.File]::WriteAllText((Join-Path $root 'research/data/funding.json'), '{' + ($parts -join ',') + '}')
Write-Host 'done'
