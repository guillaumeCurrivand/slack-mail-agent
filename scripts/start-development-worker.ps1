param(
    [string]$Configuration = 'development-worker.local.json',
    [string]$NodePath = (Join-Path $env:LOCALAPPDATA 'nvm/v25.8.1/node.exe'),
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$previousPath = $env:PATH
$previousNodeOptions = $env:NODE_OPTIONS
$workerExit = 0
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    $nodeExecutable = (Resolve-Path -LiteralPath $NodePath).Path
    $runtimeJson = & $nodeExecutable -p "JSON.stringify({path:require('fs').realpathSync(process.execPath),version:process.version,major:Number(process.versions.node.split('.')[0]),fetch:typeof fetch})"
    if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect the selected Node runtime.' }
    $runtime = $runtimeJson | ConvertFrom-Json
    if ($runtime.major -lt 24 -or $runtime.fetch -ne 'function') {
        throw "Mayassistant requires Node 24+ with fetch. Selected: $($runtime.version). Pass -NodePath with a compatible node.exe."
    }
    # Resolve the physical executable once, even if the supplied path is an NVM junction.
    $nodeExecutable = $runtime.path
    $env:PATH = (Split-Path -Parent $nodeExecutable) + ';' + $previousPath
    Write-Output "Mayassistant worker: $($runtime.version) ($nodeExecutable)"
    if ($Check) { return }
    & $nodeExecutable --import tsx (Join-Path $PWD 'src/modules/development/worker-main.ts') $Configuration
    $workerExit = $LASTEXITCODE
} finally {
    $env:PATH = $previousPath
    if ($null -eq $previousNodeOptions) {
        Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    } else {
        $env:NODE_OPTIONS = $previousNodeOptions
    }
    Pop-Location
}
exit $workerExit
