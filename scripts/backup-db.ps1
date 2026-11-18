# Creates a compressed backup of the database in DATABASE_URL (or -DatabaseUrl).
# Usage: powershell -File scripts/backup-db.ps1 [-DatabaseUrl "postgresql://..."]
# The connection string is never printed; only the output path is.
param(
  [string]$DatabaseUrl,
  [string]$OutputDirectory = "backups"
)

$ErrorActionPreference = 'Stop'

if (-not $DatabaseUrl) {
  $line = (Get-Content (Join-Path $PSScriptRoot '..\.env') | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1)
  if (-not $line) { throw 'DATABASE_URL is not set in the environment or .env.' }
  $DatabaseUrl = ($line -replace '^DATABASE_URL=', '').Trim('"')
}

$uri = [System.Uri]$DatabaseUrl
$credentials = $uri.UserInfo.Split(':', 2)
$env:PGPASSWORD = [System.Uri]::UnescapeDataString($credentials[1])
$database = $uri.AbsolutePath.Trim('/')
$port = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }

$pgDump = (Get-Command pg_dump -ErrorAction SilentlyContinue).Source
if (-not $pgDump) {
  $pgDump = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\pg_dump.exe' -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $pgDump) { throw 'pg_dump was not found on PATH or under C:\Program Files\PostgreSQL.' }

$directory = Join-Path $PSScriptRoot "..\$OutputDirectory"
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$target = Join-Path $directory "$database-$stamp.dump"

& $pgDump --format=custom --no-owner --no-privileges --host $uri.Host --port $port `
  --username $credentials[0] --dbname $database --file $target
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE." }

Write-Output "Backup written to $((Resolve-Path $target).Path)"
