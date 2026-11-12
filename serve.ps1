# Minimal static server: serves index.html on http://localhost:8765/
$root = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\'
$l = New-Object System.Net.HttpListener
$l.Prefixes.Add('http://localhost:8765/')
$l.Start()
Write-Host 'Serving on http://localhost:8765/'
while ($l.IsListening) {
  $ctx = $l.GetContext()
  $p = $ctx.Request.Url.AbsolutePath.TrimStart('/')
  if (-not $p) { $p = 'index.html' }
  # only files inside the project: a path that resolves outside it (..) is a 404, whatever the client sent
  $f = [IO.Path]::GetFullPath((Join-Path $root ([Uri]::UnescapeDataString($p))))
  if ($f.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $f -PathType Leaf)) {
    $b = [IO.File]::ReadAllBytes($f)
    if ($f -like '*.html') { $ctx.Response.ContentType = 'text/html; charset=utf-8' }
    if ($f -like '*.js') { $ctx.Response.ContentType = 'text/javascript; charset=utf-8' }
    $ctx.Response.OutputStream.Write($b, 0, $b.Length)
  } else { $ctx.Response.StatusCode = 404 }
  $ctx.Response.Close()
}
