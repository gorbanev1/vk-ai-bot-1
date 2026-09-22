param(
    [string]$ProjectRoot = (Get-Location).Path,
    [string]$OutputName = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path

if ([string]::IsNullOrWhiteSpace($OutputName)) {
    $stamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
    $OutputName = "audit-bundle-$stamp"
}

$OutputDirectory = Join-Path $ProjectRoot $OutputName

$SearchRoots = @(
    $ProjectRoot,
    (Join-Path $ProjectRoot "code"),
    (Join-Path $ProjectRoot "src")
) |
    Where-Object { Test-Path -LiteralPath $_ -PathType Container } |
    Select-Object -Unique

$AllowedExtensions = @(
    ".js",
    ".mjs",
    ".cjs",
    ".json",
    ".md",
    ".txt",
    ".yaml",
    ".yml"
)

$Files = [System.Collections.Generic.Dictionary[string,string]]::new()
$Missing = [System.Collections.Generic.List[string]]::new()

function Is-ExcludedPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $normalized = $Path.Replace("/", "\")

    if ($normalized -match "\\(?:node_modules|\.git|data|dist|build|coverage|logs|browser-profiles|playwright-report)(?:\\|$)") {
        return $true
    }

    $name = [System.IO.Path]::GetFileName($normalized)

    if ($name -match "^\.env(?:\..*)?$" -and $name -ne ".env.example") {
        return $true
    }

    if ($name -match "^(?:cookies|secrets|credentials|auth|token).*\.(json|txt|yaml|yml)$") {
        return $true
    }

    return $false
}

function Get-ProjectRelativePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FullPath
    )

    return ([System.IO.Path]::GetRelativePath(
        $ProjectRoot,
        $FullPath
    )).Replace("\", "/")
}

function Register-File {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FullPath
    )

    if (-not (Test-Path -LiteralPath $FullPath -PathType Leaf)) {
        return
    }

    $item = Get-Item -LiteralPath $FullPath

    if (Is-ExcludedPath -Path $item.FullName) {
        return
    }

    if ($AllowedExtensions -notcontains $item.Extension.ToLowerInvariant()) {
        return
    }

    $relative = Get-ProjectRelativePath -FullPath $item.FullName

    if (-not $Files.ContainsKey($relative.ToLowerInvariant())) {
        $Files.Add($relative.ToLowerInvariant(), $item.FullName)
    }
}

function Resolve-RelativeFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RelativePath
    )

    foreach ($root in $SearchRoots) {
        $candidate = Join-Path $root $RelativePath

        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Get-Item -LiteralPath $candidate).FullName
        }
    }

    return $null
}

function Resolve-RelativeDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RelativePath
    )

    foreach ($root in $SearchRoots) {
        $candidate = Join-Path $root $RelativePath

        if (Test-Path -LiteralPath $candidate -PathType Container) {
            return (Get-Item -LiteralPath $candidate).FullName
        }
    }

    return $null
}

function Add-File {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RelativePath
    )

    $resolved = Resolve-RelativeFile -RelativePath $RelativePath

    if ($null -eq $resolved) {
        $Missing.Add($RelativePath)
        return
    }

    Register-File -FullPath $resolved
}

function Add-Directory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RelativePath
    )

    $resolved = Resolve-RelativeDirectory -RelativePath $RelativePath

    if ($null -eq $resolved) {
        $Missing.Add("$RelativePath/")
        return
    }

    Get-ChildItem -LiteralPath $resolved -Recurse -File -Force |
        Where-Object {
            -not (Is-ExcludedPath -Path $_.FullName) -and
            ($AllowedExtensions -contains $_.Extension.ToLowerInvariant())
        } |
        ForEach-Object {
            Register-File -FullPath $_.FullName
        }
}

function Add-Pattern {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RelativeDirectory,

        [Parameter(Mandatory = $true)]
        [string]$Filter
    )

    $resolved = Resolve-RelativeDirectory -RelativePath $RelativeDirectory

    if ($null -eq $resolved) {
        return
    }

    Get-ChildItem -LiteralPath $resolved -File -Force -Filter $Filter |
        Where-Object {
            -not (Is-ExcludedPath -Path $_.FullName)
        } |
        ForEach-Object {
            Register-File -FullPath $_.FullName
        }
}

Write-Host "Корень проекта: $ProjectRoot"
Write-Host "Каталоги поиска:"
$SearchRoots | ForEach-Object {
    Write-Host "  $_"
}

# --------------------------------------------------------------------
# Основной оркестратор и конфигурация
# --------------------------------------------------------------------

@(
    "botApplication.js",
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "README.md",
    "README.ru.md",
    ".env.example",
    "COMMANDS_RU.md",
    "EVENT_SEARCH_KEYS_V18894.md",
    "EVENT_AI_NORMALIZATION_PROMPT_V78.txt",
    "V18888_CHANGES_RU.md",
    "V18892_CHANGES_RU.md",
    "V18893_CHANGES_RU.md",
    "V18894_CHANGES_RU.md",
    "V18895_ASTROLOGY_FIX_RU.md",
    "V18896_CHANGES_RU.md"
) | ForEach-Object {
    Add-File -RelativePath $_
}

# --------------------------------------------------------------------
# Все event-модули: карточки, validation, media, дедупликация,
# poster matching, provenance, normalization, источники
# --------------------------------------------------------------------

@(
    "features/events",
    "features/scrapers",
    "features/ai"
) | ForEach-Object {
    Add-Directory -RelativePath $_
}

# --------------------------------------------------------------------
# Платформенные скрейперы и browser-интеграция
# --------------------------------------------------------------------

@(
    "platforms/vk",
    "platforms/telegram",
    "platforms/qtickets",
    "infrastructure/browser"
) | ForEach-Object {
    Add-Directory -RelativePath $_
}

# --------------------------------------------------------------------
# База данных.
# Копируем исходники database-модулей, но не data/ и не SQLite-файлы.
# --------------------------------------------------------------------

Add-Directory -RelativePath "infrastructure/database"

# --------------------------------------------------------------------
# Shared-модули, которые нужны для понимания дат, команд, чисел,
# ошибок и нормализации.
# --------------------------------------------------------------------

@(
    "shared"
) | ForEach-Object {
    Add-Directory -RelativePath $_
}

# --------------------------------------------------------------------
# Тесты. Берём event/scraper/infrastructure-тесты целиком.
# --------------------------------------------------------------------

@(
    "tests/events",
    "tests/scrapers",
    "tests/infrastructure"
) | ForEach-Object {
    Add-Directory -RelativePath $_
}

# Если проект хранит тесты в test/ вместо tests/
@(
    "test/events",
    "test/scrapers",
    "test/infrastructure"
) | ForEach-Object {
    Add-Directory -RelativePath $_
}

# --------------------------------------------------------------------
# Дополнительные документы и конфигурации
# --------------------------------------------------------------------

@(
    "docs",
    "documentation"
) | ForEach-Object {
    if (Test-Path -LiteralPath (Join-Path $ProjectRoot $_) -PathType Container) {
        Add-Directory -RelativePath $_
    }
}

Add-Pattern -RelativeDirectory "." -Filter "V188*.md"
Add-Pattern -RelativeDirectory "." -Filter "EVENT*.md"
Add-Pattern -RelativeDirectory "." -Filter "*CHANGE*.md"

# --------------------------------------------------------------------
# Создание отдельной папки и копирование
# --------------------------------------------------------------------

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

$Copied = [System.Collections.Generic.List[object]]::new()

foreach ($entry in $Files.GetEnumerator()) {
    $relativePath = $entry.Value
    $sourcePath = $entry.Value
    $targetPath = Join-Path $OutputDirectory $relativePath

    if (Is-ExcludedPath -Path $sourcePath) {
        continue
    }

    $targetParent = Split-Path -Parent $targetPath

    if (-not (Test-Path -LiteralPath $targetParent -PathType Container)) {
        New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
    }

    Copy-Item `
        -LiteralPath $sourcePath `
        -Destination $targetPath `
        -Force

    $hash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash

    $Copied.Add([PSCustomObject]@{
        Path   = $relativePath
        Bytes  = (Get-Item -LiteralPath $sourcePath).Length
        SHA256 = $hash
    })

    Write-Host "  copied: $relativePath"
}

# --------------------------------------------------------------------
# Manifest и список отсутствующих файлов
# --------------------------------------------------------------------

$Manifest = [PSCustomObject]@{
    CreatedAt       = (Get-Date).ToString("o")
    ProjectRoot     = $ProjectRoot
    OutputDirectory = $OutputDirectory
    FileCount       = $Copied.Count
    Files           = $Copied
}

$Manifest |
    ConvertTo-Json -Depth 6 |
    Set-Content `
        -LiteralPath (Join-Path $OutputDirectory "collection-manifest.json") `
        -Encoding UTF8

$Missing |
    Sort-Object -Unique |
    Set-Content `
        -LiteralPath (Join-Path $OutputDirectory "missing-files.txt") `
        -Encoding UTF8

@"
В этот пакет намеренно НЕ включены:
- .env и реальные секреты;
- node_modules;
- data/ и SQLite-базы;
- cookies и профили Chromium;
- dist/, build/, coverage/;
- временные логи и runtime-файлы.

Для воспроизводимого аудита нужны исходники, тесты и документация.
"@ |
    Set-Content `
        -LiteralPath (Join-Path $OutputDirectory "README-AUDIT-BUNDLE.txt") `
        -Encoding UTF8

Write-Host ""
Write-Host "Готово." -ForegroundColor Green
Write-Host "Папка: $OutputDirectory"
Write-Host "Скопировано файлов: $($Copied.Count)"
Write-Host "Отсутствующих каталогов/файлов: $(($Missing | Sort-Object -Unique).Count)"
Write-Host ""
Write-Host "Проверь:"
Write-Host "  $OutputDirectory\collection-manifest.json"
Write-Host "  $OutputDirectory\missing-files.txt"