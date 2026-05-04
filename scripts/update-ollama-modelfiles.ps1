# Update Ollama Modelfiles for Unsloth models so they advertise tools (and reasoning where applicable).
# Uses official Qwen3 template for Qwen3.5 models and Devstral template for Ministral/Devstral.
# Run from repo root: .\scripts\update-ollama-modelfiles.ps1

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$OutDir = Join-Path $ScriptDir "ollama-modelfiles"
$Qwen3TemplatePath = Join-Path $ScriptDir "ollama-qwen3.template"
$DevstralTemplatePath = Join-Path $ScriptDir "ollama-devstral.template"

if (-not (Test-Path $Qwen3TemplatePath)) { Write-Error "Missing $Qwen3TemplatePath" }
if (-not (Test-Path $DevstralTemplatePath)) { Write-Error "Missing $DevstralTemplatePath" }
$Qwen3Template = Get-Content -Raw -Path $Qwen3TemplatePath
$DevstralTemplate = Get-Content -Raw -Path $DevstralTemplatePath

$UnslothModels = @(
    "hf.co/unsloth/Ministral-3-14B-Instruct-2512-GGUF:UD-Q4_K_XL",
    "hf.co/unsloth/Qwen3.5-9B-GGUF:UD-Q4_K_XL",
    "hf.co/unsloth/Qwen3.5-35B-A3B-GGUF:UD-IQ3_S",
    "hf.co/unsloth/Qwen3.5-27B-GGUF:UD-Q2_K_XL",
    "hf.co/unsloth/Ministral-3-14B-Reasoning-2512-GGUF:UD-Q4_K_XL",
    "hf.co/unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL",
    "hf.co/unsloth/Qwen3.5-2B-GGUF:BF16",
    "hf.co/unsloth/Qwen3.5-2B-GGUF:UD-Q4_K_XL",
    "hf.co/unsloth/Qwen3.5-0.8B-GGUF:BF16",
    "hf.co/unsloth/Qwen3.5-0.8B-GGUF:UD-Q4_K_XL",
    "hf.co/unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF:UD-Q4_K_XL",
    "hf.co/unsloth/GLM-4.7-Flash-GGUF:UD-Q3_K_XL",
    "hf.co/unsloth/Qwen3.5-27B-GGUF:Q3_K_M"
)

function Get-TemplateFamily {
    param([string]$ModelName)
    if ($ModelName -match "Qwen3\.5") { return "qwen3" }
    if ($ModelName -match "Ministral|Devstral") { return "devstral" }
    if ($ModelName -match "GLM-4\.7") { return "glm" }
    return $null
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

foreach ($model in $UnslothModels) {
    $family = Get-TemplateFamily -ModelName $model
    if (-not $family) {
        Write-Host "Skip (no template): $model"
        continue
    }

    Write-Host "Updating $model (family: $family) ..."
    $modelfileRaw = ollama show $model --modelfile 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "  ollama show failed: $modelfileRaw"
        continue
    }

    $safeName = $model -replace '[\\/:*?"<>|]', '_'
    $modelfilePath = Join-Path $OutDir "$safeName.modelfile"

    if ($family -eq "glm") {
        # GLM: keep existing Modelfile intact (multiline TEMPLATE etc.), append PARSER/RENDERER for thinking (Ollama #14212).
        $rawStr = if ($modelfileRaw -is [string]) { $modelfileRaw } else { $modelfileRaw | Out-String }
        $out = $rawStr.TrimEnd()
        if ($out -notmatch "PARSER\s+glm") {
            $out += "`n# Updated by update-ollama-modelfiles.ps1 (thinking)`nPARSER glm-4.7`nRENDERER glm-4.7"
        }
        [System.IO.File]::WriteAllText($modelfilePath, $out + "`n", [System.Text.UTF8Encoding]::new($false))
    } else {
        $fromLines = @()
        $modelfileStr = if ($modelfileRaw -is [string]) { $modelfileRaw } else { $modelfileRaw | Out-String }
        foreach ($line in ($modelfileStr -split "`n")) {
            $t = $line.Trim()
            if ($t.StartsWith("FROM ")) { $fromLines += $line }
        }
        if ($fromLines.Count -eq 0) {
            Write-Warning "  No FROM lines found"
            continue
        }

        if ($family -eq "qwen3") {
            # Merge from official qwen3.5 so the manifest gets thinking capability (avoids 400 "does not support thinking").
            $officialModelfile = $null
            foreach ($officialModel in @("qwen3.5")) {
                $officialRaw = ollama show $officialModel --modelfile 2>&1
                if ($LASTEXITCODE -eq 0) {
                    $officialModelfile = if ($officialRaw -is [string]) { $officialRaw } else { $officialRaw | Out-String }
                    break
                }
            }
            if ($officialModelfile) {
                $nonFromLines = @()
                foreach ($line in ($officialModelfile -split "`n")) {
                    $t = $line.Trim()
                    if ($t.StartsWith("FROM ")) { continue }
                    $nonFromLines += $line
                }
                $content = @()
                $content += "# Updated by update-ollama-modelfiles.ps1 (merge from official qwen3.5 for thinking)"
                $content += $fromLines
                $content += $nonFromLines
                $content | Set-Content -Path $modelfilePath -Encoding UTF8
            } else {
                # Fallback: hand-written template + PARSER/RENDERER (thinking may still 400 until user pulls qwen3.5 and re-runs).
                Write-Host "  (qwen3.5 not installed; using built-in template; pull qwen3.5 for full thinking support)"
                $template = $Qwen3Template
                $stopParams = @('PARAMETER stop "<|im_start|>"', 'PARAMETER stop "<|im_end|>"')
                $parserRenderer = @('PARSER qwen3', 'RENDERER qwen3')
                $content = @()
                $content += "# Updated by update-ollama-modelfiles.ps1 for tools/reasoning"
                $content += $fromLines
                $content += "TEMPLATE """ + $template.TrimEnd() + """"
                $content += $stopParams
                $content += $parserRenderer
                $content | Set-Content -Path $modelfilePath -Encoding UTF8
            }
        } else {
            $template = $DevstralTemplate
            $stopParams = @('PARAMETER stop <s>', 'PARAMETER stop [INST]')
            $content = @()
            $content += "# Updated by update-ollama-modelfiles.ps1 for tools/reasoning"
            $content += $fromLines
            $content += "TEMPLATE """ + $template.TrimEnd() + """"
            $content += $stopParams
            $content | Set-Content -Path $modelfilePath -Encoding UTF8
        }
    }

    ollama create $model -f $modelfilePath
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "  ollama create failed for $model"
    } else {
        Write-Host "  OK: $model"
    }
}

Write-Host "Done."
