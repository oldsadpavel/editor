# Copies the built app (release\win-unpacked) to %LOCALAPPDATA%\Programs\ClaudeEditor
# and creates/refreshes the desktop shortcut. Run after `npm run dist` (or via `npm run install-local`).
$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot '..\release\win-unpacked'
$dst = Join-Path $env:LOCALAPPDATA 'Programs\ClaudeEditor'
if (-not (Test-Path (Join-Path $src 'Claude Editor.exe'))) { throw "No build in $src - run npm run dist first" }
if (Get-Process -Name 'Claude Editor' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$dst*" }) {
  throw "Close Claude Editor before updating"
}
New-Item -ItemType Directory -Force $dst | Out-Null
robocopy $src $dst /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with code $LASTEXITCODE" }

$exe = Join-Path $dst 'Claude Editor.exe'
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut((Join-Path $desktop 'Claude Editor.lnk'))
$lnk.TargetPath = $exe
$lnk.WorkingDirectory = $dst
$lnk.IconLocation = "$exe,0"
$lnk.Description = 'Claude Editor'
$lnk.Save()
Write-Output "Installed to $dst, shortcut: $(Join-Path $desktop 'Claude Editor.lnk')"
