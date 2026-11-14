# Serves the Dot Scale app at http://localhost:8737 (Web Bluetooth needs localhost or HTTPS).
# Listens on 127.0.0.1 only. To reach it from your phone, put `tailscale serve` in front (see README).
# Usage: powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 8737] [-Open]
param([int]$Port = 8737, [switch]$Open)

$root = (Resolve-Path $PSScriptRoot).Path
$types = @{ '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.svg' = 'image/svg+xml';
            '.webmanifest' = 'application/manifest+json'; '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json';
            '.md' = 'text/plain; charset=utf-8' }

# Plain TCP listener: unlike HttpListener it doesn't reject proxied requests whose Host isn't "localhost".
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
Write-Host "Dot Scale running at http://localhost:$Port/  (Ctrl+C to stop)"
if ($Open) { Start-Process "http://localhost:$Port/" }

function Send($stream, [int]$code, [string]$status, [string]$type, [byte[]]$body) {
  $head = "HTTP/1.1 $code $status`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
  $h = [Text.Encoding]::ASCII.GetBytes($head)
  $stream.Write($h, 0, $h.Length)
  if ($body.Length) { $stream.Write($body, 0, $body.Length) }
}

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $client.ReceiveTimeout = 5000
      $stream = $client.GetStream()
      $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII, $false, 4096, $true)
      $requestLine = $reader.ReadLine()
      while (($line = $reader.ReadLine())) { }   # skip headers
      $parts = "$requestLine".Split(' ')
      if ($parts.Length -lt 2 -or $parts[0] -notin 'GET', 'HEAD') {
        Send $stream 405 'Method Not Allowed' 'text/plain' ([byte[]]@())
      } else {
        $path = [Uri]::UnescapeDataString($parts[1].Split('?')[0].TrimStart('/'))
        if ($path -eq '' -or $path.EndsWith('/')) { $path += 'index.html' }
        $file = [IO.Path]::GetFullPath((Join-Path $root $path))
        if ($file.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path $file -PathType Leaf)) {
          $ext = [IO.Path]::GetExtension($file)
          $type = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
          $body = if ($parts[0] -eq 'HEAD') { [byte[]]@() } else { [IO.File]::ReadAllBytes($file) }
          Send $stream 200 'OK' $type $body
        } else {
          Send $stream 404 'Not Found' 'text/plain' ([Text.Encoding]::UTF8.GetBytes('Not found'))
        }
      }
    } catch { Write-Warning $_ } finally { $client.Close() }
  }
} finally { $listener.Stop() }
