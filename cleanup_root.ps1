[CmdletBinding()]
param(
    [switch]$Apply,
    [string]$RestoreManifest
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Data = Join-Path $Root "data"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$ManifestDir = Join-Path $Data "_cleanup_manifests"
$Manifest = Join-Path $ManifestDir "root-cleanup-$Stamp.csv"
$Moves = New-Object System.Collections.Generic.List[object]

function Ensure-Dir([string]$Path) {
    if ($Apply -and -not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Rel([string]$Path) {
    try { return [IO.Path]::GetRelativePath($Root, $Path) } catch { return $Path }
}

function Same-File([string]$A, [string]$B) {
    if (-not (Test-Path -LiteralPath $A) -or -not (Test-Path -LiteralPath $B)) { return $false }
    $ia = Get-Item -LiteralPath $A
    $ib = Get-Item -LiteralPath $B
    if ($ia.PSIsContainer -or $ib.PSIsContainer) { return $false }
    if ($ia.Length -ne $ib.Length) { return $false }
    return ((Get-FileHash -Algorithm SHA256 -LiteralPath $A).Hash -eq
            (Get-FileHash -Algorithm SHA256 -LiteralPath $B).Hash)
}

function Add-Move([string]$Source, [string]$DestDir, [string]$Reason) {
    if (-not (Test-Path -LiteralPath $Source)) { return }

    $Name = Split-Path -Leaf $Source
    $Dest = Join-Path $DestDir $Name

    if (Test-Path -LiteralPath $Dest) {
        if ((Get-Item -LiteralPath $Source).PSIsContainer) {
            Write-Host "[SKIP] destination exists: $(Rel $Dest)"
            return
        }
        if (Same-File $Source $Dest) {
            $DupDir = Join-Path $Data "_cleanup_quarantine\root-duplicates\$Stamp"
            $Dest = Join-Path $DupDir $Name
            $Reason = "$Reason; identical duplicate"
        } else {
            Write-Host "[SKIP] conflict, different contents: $(Rel $Source) -> $(Rel $Dest)"
            return
        }
    }

    Write-Host ("[{0}] {1} -> {2}  ({3})" -f ($(if($Apply){"MOVE"}else{"DRY"})), (Rel $Source), (Rel $Dest), $Reason)

    if ($Apply) {
        Ensure-Dir (Split-Path -Parent $Dest)
        Move-Item -LiteralPath $Source -Destination $Dest
        $Moves.Add([pscustomobject]@{
            source = $Source
            destination = $Dest
            reason = $Reason
            moved_at = (Get-Date).ToString("o")
        })
    }
}

function Move-MatchingFiles([string]$Regex, [string]$DestRel, [string]$Reason) {
    $DestDir = Join-Path $Root $DestRel
    Get-ChildItem -LiteralPath $Root -File -Force | Where-Object {
        $_.Name -match $Regex
    } | ForEach-Object {
        Add-Move $_.FullName $DestDir $Reason
    }
}

# ---- RESTORE MODE -----------------------------------------------------------
if ($RestoreManifest) {
    if (-not (Test-Path -LiteralPath $RestoreManifest)) {
        throw "Manifest not found: $RestoreManifest"
    }
    $rows = @(Import-Csv -LiteralPath $RestoreManifest)
    [array]::Reverse($rows)

    foreach ($r in $rows) {
        if (-not (Test-Path -LiteralPath $r.destination)) {
            Write-Host "[SKIP] moved file missing: $($r.destination)"
            continue
        }
        if (Test-Path -LiteralPath $r.source) {
            Write-Host "[SKIP] original path already exists: $($r.source)"
            continue
        }
        Write-Host "[RESTORE] $($r.destination) -> $($r.source)"
        if ($Apply) {
            $parent = Split-Path -Parent $r.source
            if (-not (Test-Path -LiteralPath $parent)) {
                New-Item -ItemType Directory -Path $parent -Force | Out-Null
            }
            Move-Item -LiteralPath $r.destination -Destination $r.source
        }
    }
    exit 0
}

Write-Host ""
Write-Host "ROOT CLEANUP"
Write-Host "Project: $Root"
Write-Host ("Mode: " + $(if($Apply){"APPLY"}else{"DRY-RUN (nothing will be changed)"}))
Write-Host ""

# Runtime artifacts that clearly do not belong in project root.
Move-MatchingFiles '^bot\(\d{8}-\d{6}\)\.sqlite(?:-(?:wal|shm))?$' 'data\backups\db' 'timestamped database snapshot'
Move-MatchingFiles '^logs(?:\(\d{8}-\d{6}\))?\.zip$|^logs[-_].*\.zip$' 'data\archives\logs' 'archived logs'
Move-MatchingFiles '^(?:crash|debug|trace|diagnostic|dump)[-_].*\.(?:log|txt|json|html|zip)$' 'data\diagnostics\root' 'runtime diagnostic'

$diagDir = Join-Path $Root "_diagnostics"
if (Test-Path -LiteralPath $diagDir) {
    Add-Move $diagDir (Join-Path $Data "diagnostics") 'diagnostic directory'
}

# Historical release/patch paperwork.
Move-MatchingFiles '^INSTALL_V.*\.txt$' 'docs\archive\install' 'historical install instructions'
Move-MatchingFiles '^PATCH_INSTALL_.*\.txt$' 'docs\archive\patch-install' 'historical patch installer notes'
Move-MatchingFiles '^PATCH_FILE_LIST.*\.txt$' 'docs\archive\patch-file-lists' 'historical patch file list'
Move-MatchingFiles '^PATCH_MANIFEST_.*\.txt$' 'docs\archive\manifests' 'historical patch manifest'
Move-MatchingFiles '^PATCH_NOTES.*\.(?:txt|md)$' 'docs\archive\patch-notes' 'historical patch notes'
Move-MatchingFiles '^HOTFIX_NOTES.*\.(?:txt|md)$' 'docs\archive\hotfix' 'historical hotfix notes'
Move-MatchingFiles '^RELEASE_NOTES_INDEX_.*\.txt$' 'docs\archive\release-notes' 'historical release index'
Move-MatchingFiles '^V\d+.*_RELEASE_NOTES(?:_RU)?\.(?:txt|md)$' 'docs\archive\release-notes' 'historical release notes'
Move-MatchingFiles '^V\d+.*_VERIFICATION\.(?:txt|md)$' 'docs\archive\verification' 'historical verification report'
Move-MatchingFiles '^V\d+.*_(?:PATCH_)?SHA256SUMS\.txt$' 'docs\archive\checksums' 'historical version checksum'
Move-MatchingFiles '^V\d+.*_TEST_LOG\.(?:txt|md)$' 'docs\archive\test-logs' 'historical test log'
Move-MatchingFiles '^V\d+.*(?:AUDIT|STATUS).*\.(?:txt|md|csv)$' 'docs\archive\audits' 'historical audit/status report'
Move-MatchingFiles '.*_AUDIT_\d{4}-\d{2}-\d{2}\.(?:txt|md|csv)$' 'docs\archive\audits' 'dated audit report'
Move-MatchingFiles '^PARSER_LOG_AUDIT_.*\.(?:txt|md|csv)$' 'docs\archive\audits' 'parser audit'
Move-MatchingFiles '^AI_QUEUE_AUDIT_.*\.(?:txt|md|csv)$' 'docs\archive\audits' 'AI queue audit'

# Old guides/command matrices/prompts.
Move-MatchingFiles '^NVIDIA_.*\.(?:txt|md)$' 'docs\archive\guides\nvidia' 'historical NVIDIA guide/commands'
Move-MatchingFiles '^AI_KEY_.*\.(?:txt|md)$' 'docs\archive\guides\ai' 'historical AI key guide'
Move-MatchingFiles '^IMAGE_MODEL_.*\.(?:txt|md)$' 'docs\archive\guides\ai' 'historical image model guide'
Move-MatchingFiles '^EVENT_AI_NORMALIZATION_PROMPT_.*\.txt$' 'docs\archive\prompts' 'historical AI prompt'
Move-MatchingFiles '^V\d+_LAST_AUDIT_ANALYSIS_.*\.txt$' 'docs\archive\audits' 'historical audit analysis'

# Secondary/readme documents: keep README.md in root; move old companions.
Move-MatchingFiles '^README_FIRST\.txt$|^README\.txt$' 'docs\archive\readme' 'legacy readme'
Move-MatchingFiles '^PATCH_NOTICE_.*\.txt$' 'docs\archive\notices' 'patch notice'

# These are documentation, not runtime. Keep their content but remove root clutter.
Move-MatchingFiles '^APPLY_PATCH_WINDOWS\.txt$|^PUBLIC_COMMANDS\.txt$|^DEVELOPER_HANDOFF\.md$' 'docs\current' 'current documentation'

if ($Apply -and $Moves.Count -gt 0) {
    if (-not (Test-Path -LiteralPath $ManifestDir)) {
        New-Item -ItemType Directory -Path $ManifestDir -Force | Out-Null
    }
    $Moves | Export-Csv -LiteralPath $Manifest -NoTypeInformation -Encoding UTF8
    Write-Host ""
    Write-Host "Manifest: $Manifest"
    Write-Host "Rollback preview:"
    Write-Host "  powershell -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -RestoreManifest `"$Manifest`""
    Write-Host "Rollback apply:"
    Write-Host "  powershell -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -RestoreManifest `"$Manifest`" -Apply"
}

Write-Host ""
Write-Host "Protected by design: src, scripts, tests, miniapps, assets, package.json, pnpm-lock.yaml,"
Write-Host "PROJECT_MANIFEST.json, README.md, .gitignore, recovery .mjs files, unknown root files."
Write-Host "Unknown files are never moved automatically."
