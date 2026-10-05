# Minimal static server: serves index.html on http://localhost:8765/
$root = $PSScriptRoot
$l = New-Object System.Net.HttpListener
$l.Prefixes.Add('http://localhost:8765/')
$l.Start()
Write-Host 'Serving on http://localhost:8765/'
while ($l.IsListening) {
  $ctx = $l.GetContext()
  $p = $ctx.Request.Url.AbsolutePath.TrimStart('/')
  if (-not $p) { $p = 'index.html' }
  $f = Join-Path $root $p
  if (Test-Path $f -PathType Leaf) {
    $b = [IO.File]::ReadAllBytes($f)
    if ($f -like '*.html') { $ctx.Response.ContentType = 'text/html; charset=utf-8' }
    if ($f -like '*.js') { $ctx.Response.ContentType = 'text/javascript; charset=utf-8' }
    $ctx.Response.OutputStream.Write($b, 0, $b.Length)
  } else { $ctx.Response.StatusCode = 404 }
  $ctx.Response.Close()
}
