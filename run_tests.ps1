# run_tests.ps1 — Run the full test suite for grocery_agent
#
# Usage:  .\run_tests.ps1
#         .\run_tests.ps1 -backend   (Flask tests only)
#         .\run_tests.ps1 -js        (JS logic tests only)

param(
    [switch]$backend,
    [switch]$js
)

$runAll = -not ($backend -or $js)
$rootDir = $PSScriptRoot
$backendFailed = $false
$jsFailed = $false

$GREEN  = "`e[32m"
$RED    = "`e[31m"
$YELLOW = "`e[33m"
$BOLD   = "`e[1m"
$RESET  = "`e[0m"

function Write-Header($text) {
    Write-Host ""
    Write-Host "${BOLD}$text${RESET}"
    Write-Host ("-" * $text.Length)
}

# ── Check dependencies ────────────────────────────────────────────────────────

if ($runAll -or $backend) {
    $pytestOk = $null -ne (Get-Command pytest -ErrorAction SilentlyContinue)
    if (-not $pytestOk) {
        Write-Host "${YELLOW}pytest not found — install with: pip install pytest${RESET}"
        $backendFailed = $true
    }
}

if ($runAll -or $js) {
    $nodeOk = $null -ne (Get-Command node -ErrorAction SilentlyContinue)
    if (-not $nodeOk) {
        Write-Host "${YELLOW}node not found — install Node.js to run JS tests${RESET}"
        $jsFailed = $true
    }
}

# ── Backend tests (pytest) ────────────────────────────────────────────────────

if (($runAll -or $backend) -and -not $backendFailed) {
    Write-Header "Backend tests  (pytest)"
    Push-Location $rootDir
    pytest tests/test_backend.py -v --tb=short 2>&1
    if ($LASTEXITCODE -ne 0) { $backendFailed = $true }
    Pop-Location
}

# ── JS logic tests (node) ─────────────────────────────────────────────────────

if (($runAll -or $js) -and -not $jsFailed) {
    Write-Header "JS logic tests  (node)"
    Push-Location $rootDir
    node tests/test_js_logic.js 2>&1
    if ($LASTEXITCODE -ne 0) { $jsFailed = $true }
    Pop-Location
}

# ── Summary ───────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "${BOLD}Results${RESET}"
Write-Host "-------"

if ($runAll -or $backend) {
    if ($backendFailed) {
        Write-Host "  ${RED}✗${RESET} Backend (pytest) — FAILED"
    } else {
        Write-Host "  ${GREEN}✓${RESET} Backend (pytest) — passed"
    }
}
if ($runAll -or $js) {
    if ($jsFailed) {
        Write-Host "  ${RED}✗${RESET} JS logic (node)  — FAILED"
    } else {
        Write-Host "  ${GREEN}✓${RESET} JS logic (node)  — passed"
    }
}

Write-Host ""
if ($backendFailed -or $jsFailed) { exit 1 } else { exit 0 }
