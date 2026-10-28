# Installs the built app (release\win-unpacked) next to the running one, so updating never needs the editor closed:
#   %LOCALAPPDATA%\Programs\ClaudeEditor\app-<timestamp>\   new version
#   %LOCALAPPDATA%\Programs\ClaudeEditor\current.txt         path of the current exe (the running editor watches it
#                                                            and offers "restart to update")
# The desktop shortcut is pointed at the new exe. Old versions are removed unless still running.
# Run after `npm run dist` (or via `npm run install-local`).
$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot '..\release\win-unpacked'
$root = Join-Path $env:LOCALAPPDATA 'Programs\ClaudeEditor'
if (-not (Test-Path (Join-Path $src 'Claude Editor.exe'))) { throw "No build in $src - run npm run dist first" }

$dst = Join-Path $root ('app-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force $dst | Out-Null
robocopy $src $dst /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with code $LASTEXITCODE" }

$exe = Join-Path $dst 'Claude Editor.exe'
Set-Content -Path (Join-Path $root 'current.txt') -Value $exe -Encoding utf8 -NoNewline

$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut((Join-Path $desktop 'Claude Editor.lnk'))
$lnk.TargetPath = $exe
$lnk.WorkingDirectory = $dst
$lnk.IconLocation = "$exe,0"
$lnk.Description = 'Claude Editor'
$lnk.Save()

# Clean up: versions that are not current and not running.
$running = @(Get-Process -Name 'Claude Editor' -ErrorAction SilentlyContinue | ForEach-Object { $_.Path } | Where-Object { $_ })
$inUse = { param($dir) $running | Where-Object { $_.StartsWith($dir + '\', [StringComparison]::OrdinalIgnoreCase) } }
Get-ChildItem $root -Directory -Filter 'app-*' | Where-Object { $_.FullName -ne $dst -and -not (& $inUse $_.FullName) } |
  ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
# The old flat install (exe directly in the root) goes away once it is not running.
$flatExe = Join-Path $root 'Claude Editor.exe'
if ((Test-Path $flatExe) -and -not ($running | Where-Object { $_ -ieq $flatExe })) {
  Get-ChildItem $root | Where-Object { $_.Name -notlike 'app-*' -and $_.Name -ne 'current.txt' } |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}
Write-Output "Installed to $dst"
Write-Output "Shortcut: $(Join-Path $desktop 'Claude Editor.lnk')"
