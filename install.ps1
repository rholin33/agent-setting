param(
    [Parameter(Mandatory)][ValidateSet('ccb','orca')][string]$Target,
    [switch]$Force,
    [switch]$QuickCommands,
    [string]$ShellProfile
)
$ErrorActionPreference = 'Stop'
$arguments = @((Join-Path $PSScriptRoot 'scripts/install-config.py'), '--target', $Target)
if ($Force) { $arguments += '--force' }
if ($QuickCommands) { $arguments += '--quick-commands' }
if ($ShellProfile) { $arguments += @('--shell-profile', $ShellProfile) }
& python @arguments
if ($LASTEXITCODE -ne 0) { throw "Installation failed with exit code $LASTEXITCODE" }
