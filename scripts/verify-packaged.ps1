param(
    [string]$Executable = ".\out\AIUsageMonitor-win32-x64\AIUsageMonitor.exe"
)

$ErrorActionPreference = "Stop"
$resolvedExecutable = (Resolve-Path -LiteralPath $Executable).Path
$bytes = [System.IO.File]::ReadAllBytes($resolvedExecutable)
$peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
$optionalHeaderOffset = $peOffset + 24
$magic = [BitConverter]::ToUInt16($bytes, $optionalHeaderOffset)

if ($magic -eq 0x10b) {
    $subsystemOffset = $optionalHeaderOffset + 68
} elseif ($magic -eq 0x20b) {
    $subsystemOffset = $optionalHeaderOffset + 68
} else {
    throw "Unknown PE optional-header magic: 0x$($magic.ToString('x'))"
}

$subsystem = [BitConverter]::ToUInt16($bytes, $subsystemOffset)
if ($subsystem -ne 2) {
    throw "Expected Windows GUI subsystem (2), got $subsystem"
}

Write-Output "PASS: $resolvedExecutable uses the Windows GUI subsystem (no console window)."
