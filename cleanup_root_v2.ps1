# cleanup_root_v2.ps1
# Put this file in the PROJECT ROOT and run it.
# It performs real moves after an explicit Y confirmation.
# Nothing is permanently deleted.

$ErrorActionPreference = "Stop"

$ScriptPath = $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptPath
$Data = Join-Path $Root "data"
$Docs = Join-Path $Root "docs"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$ManifestDir = Join-Path $Data "_cleanup_manifests"
$Manifest = Join-Path $ManifestDir "root-cleanup-$Stamp.csv"
$Moves = New-Object System.Collections.Generic.List[object]

Set-Location -LiteralPath $Root

function Ensure-Dir([string]$p) {
    if (-not (Test-Path -LiteralPath $p)) {
        New-Item -ItemType Directory -Path $p -Force | Out-Null
    }
}

function Rel([string]$p) {
    try { return [IO.Path]::GetRelativePath($Root, $p) } catch { return $p }
}

function Same-File([string]$a, [string]$b) {
    if (-not (Test-Path -LiteralPath $a) -or -not (Test-Path -LiteralPath $b)) { return $false }
    $ia = Get-Item -LiteralPath $a
    $ib = Get-Item -LiteralPath $b
    if ($ia.PSIsContainer -or $ib.PSIsContainer) { return $false }
    if ($ia.Length -ne $ib.Length) { return $false }
    try {
        return ((Get-FileHash -Algorithm SHA256 -LiteralPath $a).Hash -eq
                (Get-FileHash -Algorithm SHA256 -LiteralPath $b).Hash)
    } catch {
        return $false
    }
}

function Move-Safe([System.IO.FileSystemInfo]$item, [string]$destDir, [string]$reason) {
    Ensure-Dir $destDir
    $dest = Join-Path $destDir $item.Name

    if (Test-Path -LiteralPath $dest) {
        if (-not $item.PSIsContainer -and (Same-File $item.FullName $dest)) {
            $dupDir = Join-Path $Data "_cleanup_quarantine\root-identical-$Stamp"
            Ensure-Dir $dupDir
            $dest = Join-Path $dupDir $item.Name
            $reason = "$reason; identical duplicate already exists at target"
        } else {
            Write-Host "[SKIP-CONFLICT] $(Rel $item.FullName) -> $(Rel $dest)" -ForegroundColor Yellow
            return
        }
    }

    Move-Item -LiteralPath $item.FullName -Destination $dest
    $Moves.Add([pscustomobject]@{
        source = $item.FullName
        destination = $dest
        reason = $reason
        moved_at = (Get-Date).ToString("o")
    })
    Write-Host "[MOVED] $(Rel $item.FullName) -> $(Rel $dest)" -ForegroundColor Green
}

function Move-RootFiles([string]$regex, [string]$destRel, [string]$reason) {
    $items = @(Get-ChildItem -LiteralPath $Root -File -Force | Where-Object { $_.Name -match $regex })
    foreach ($item in $items) {
        Move-Safe $item (Join-Path $Root $destRel) $reason
    }
}

Write-Host ""
Write-Host "PROJECT ROOT CLEANUP" -ForegroundColor Cyan
Write-Host "Root: $Root"
Write-Host ""
Write-Host "This WILL move historical notes/install/checksum/audit clutter out of the root."
Write-Host "It will NOT touch src, scripts, tests, assets, miniapps, node_modules, package.json,"
Write-Host "pnpm-lock.yaml, .git, .idea, .env, README.md, PROJECT_MANIFEST.json, or unknown files."
Write-Host ""
$answer = Read-Host "Proceed? Type Y and press Enter"
if ($answer -notmatch '^(?i:y|yes|д|да)$') {
    Write-Host "Cancelled."
    exit 0
}

Ensure-Dir $Data
Ensure-Dir $Docs
Ensure-Dir $ManifestDir

# ---- Huge historical text clutter visible in your screenshots ----
Move-RootFiles '^INSTALL_V.*\.txt$' 'docs\archive\install' 'historical install note'
Move-RootFiles '^PATCH_INSTALL_.*\.txt$' 'docs\archive\patch-install' 'historical patch install note'
Move-RootFiles '^PATCH_FILE_LIST.*\.txt$' 'docs\archive\patch-file-lists' 'historical patch file list'
Move-RootFiles '^PATCH_MANIFEST_.*\.txt$' 'docs\archive\manifests' 'historical patch manifest'
Move-RootFiles '^PATCH_NOTES.*\.(?:txt|md)$' 'docs\archive\patch-notes' 'historical patch note'
Move-RootFiles '^PATCH_NOTICE_.*\.txt$' 'docs\archive\notices' 'historical patch notice'
Move-RootFiles '^HOTFIX_NOTES.*\.(?:txt|md)$' 'docs\archive\hotfix' 'historical hotfix note'
Move-RootFiles '^RELEASE_NOTES_INDEX_.*\.(?:txt|md)$' 'docs\archive\release-notes' 'historical release-note index'

# Vxx / V18xxx reports, verifications, release notes, audits, checksums.
Move-RootFiles '^V\d+.*_RELEASE_NOTES(?:_RU)?\.(?:txt|md)$' 'docs\archive\release-notes' 'historical release note'
Move-RootFiles '^V\d+.*_VERIFICATION\.(?:txt|md)$' 'docs\archive\verification' 'historical verification'
Move-RootFiles '^V\d+.*(?:SHA256SUMS|CHECKSUMS).*\.(?:txt|md)$' 'docs\archive\checksums' 'historical checksum'
Move-RootFiles '^V\d+.*_TEST_LOG\.(?:txt|md)$' 'docs\archive\test-logs' 'historical test log'
Move-RootFiles '^V\d+.*(?:AUDIT|STATUS).*\.(?:txt|md|csv)$' 'docs\archive\audits' 'historical audit/status'
Move-RootFiles '^V\d+.*(?:CANDIDATE|FINAL).*\.(?:txt|md|csv)$' 'docs\archive\verification' 'historical candidate/final report'

# Named audit/report junk.
Move-RootFiles '^AI_QUEUE_AUDIT_.*\.(?:txt|md|csv)$' 'docs\archive\audits' 'AI queue audit'
Move-RootFiles '^PARSER_LOG_AUDIT_.*\.(?:txt|md|csv)$' 'docs\archive\audits' 'parser log audit'
Move-RootFiles '^.*FORENSIC.*\.(?:txt|md|csv)$' 'docs\archive\audits' 'forensic report'
Move-RootFiles '^.*EVENT_POSTER_AUDIT.*\.(?:txt|md|csv)$' 'docs\archive\audits' 'event poster audit'
Move-RootFiles '^.*SOURCE_MEDIA_AUDIT.*\.(?:txt|md|csv)$' 'docs\archive\audits' 'source media audit'
Move-RootFiles '^.*DEDUPE_AUDIT.*\.(?:txt|md|csv)$' 'docs\archive\audits' 'dedupe audit'
Move-RootFiles '^.*INPUT_DB_AUDIT.*\.(?:txt|md|csv)$' 'docs\archive\audits' 'database audit'

# Old guidance/docs.
Move-RootFiles '^NVIDIA_.*\.(?:txt|md)$' 'docs\archive\guides\nvidia' 'historical NVIDIA guide'
Move-RootFiles '^AI_KEY_.*\.(?:txt|md)$' 'docs\archive\guides\ai' 'historical AI guide'
Move-RootFiles '^IMAGE_MODEL_.*\.(?:txt|md)$' 'docs\archive\guides\ai' 'historical image-model guide'
Move-RootFiles '^EVENT_AI_NORMALIZATION_PROMPT_.*\.txt$' 'docs\archive\prompts' 'historical AI prompt'
Move-RootFiles '^README_FIRST\.txt$|^README\.txt$' 'docs\archive\readme' 'legacy README'
Move-RootFiles '^PUBLIC_COMMANDS\.txt$|^APPLY_PATCH_WINDOWS\.txt$|^DEVELOPER_HANDOFF\.md$' 'docs\current' 'current project documentation'

# Old helper/recovery scripts that are documentation/history, not active source.
# We ONLY move exact historical filename patterns, not arbitrary .ps1/.cmd files.
Move-RootFiles '^APPLY_V\d+_.*\.(?:ps1|cmd)$' 'scripts\archive\migration-history' 'historical apply/migration helper'
Move-RootFiles '^RECOVER_.*\.(?:ps1|cmd|mjs)$' 'scripts\archive\recovery-history' 'historical recovery helper'

# Root runtime/export artifacts.
Move-RootFiles '^bot\(\d{8}-\d{6}\)\.sqlite(?:-(?:wal|shm))?$' 'data\backups\db' 'timestamped DB snapshot'
Move-RootFiles '^logs(?:\(\d{8}-\d{6}\))?\.zip$|^logs[-_].*\.zip$' 'data\archives\logs' 'archived logs'
Move-RootFiles '^(?:debug|trace|dump|diagnostic)[-_].*\.(?:log|txt|json|jsonl|html|zip)$' 'data\diagnostics\root' 'runtime diagnostic'

# Special root directories that are clearly generated/diagnostic.
foreach ($name in @("_diagnostics")) {
    $p = Join-Path $Root $name
    if (Test-Path -LiteralPath $p) {
        Move-Safe (Get-Item -LiteralPath $p -Force) (Join-Path $Data "diagnostics") 'generated diagnostics directory'
    }
}

# Old audit-result directories: move only explicit pattern.
Get-ChildItem -LiteralPath $Root -Directory -Force | Where-Object {
    $_.Name -match '^AI_FULL_AUDIT_RESULTS(?:\.old.*)?$'
} | ForEach-Object {
    Move-Safe $_ (Join-Path $Data "archives\audits") 'generated audit-results directory'
}

if ($Moves.Count -gt 0) {
    $Moves | Export-Csv -LiteralPath $Manifest -NoTypeInformation -Encoding UTF8
    Write-Host ""
    Write-Host "Moved: $($Moves.Count) item(s)" -ForegroundColor Cyan
    Write-Host "Rollback manifest: $Manifest"
} else {
    Write-Host ""
    Write-Host "Nothing matched. If the root still contains junk, send the filenames and I will add exact patterns." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done. Explorer may need F5 / Refresh." -ForegroundColor Cyan
