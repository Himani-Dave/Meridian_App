<#
    Meridian — trim the MBFC payload to the outlets we actually use.

    MBFC's /fetch-data returns every rated source in one array (9,000-11,000
    records, typically several MB). Only ~52 of them are in Meridian's roster.
    This keeps the records whose domain or name matches the roster, plus any
    near-miss worth eyeballing, and writes a much smaller file to hand back.

    It does not alter any record. It only selects.

    Usage:
        .\filter-mbfc.ps1 -In .\mbfc-full.json
        .\filter-mbfc.ps1 -In .\mbfc-full.json -Out .\mbfc-meridian.json
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $In,
    [string] $Out
)

$ErrorActionPreference = 'Stop'

if (-not $Out) {
    $base = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
    $Out = Join-Path $base 'mbfc-meridian.json'
}

$TargetsJson = @'
{
 "domains": [
  "aljazeera.com",
  "apnews.com",
  "arabnews.com",
  "asia.nikkei.com",
  "axios.com",
  "bbc.co.uk",
  "bbc.com",
  "bbci.co.uk",
  "brusselssignal.eu",
  "business-standard.com",
  "cbc.ca",
  "cna.com.tw",
  "csmonitor.com",
  "dailycaller.com",
  "democracynow.org",
  "dj.com",
  "dw.com",
  "euobserver.com",
  "euronews.com",
  "faz.net",
  "focustaiwan.tw",
  "foxnews.com",
  "globaltimes.cn",
  "haaretz.com",
  "indianexpress.com",
  "jns.org",
  "jpost.com",
  "ledevoir.com",
  "lefigaro.fr",
  "middleeasteye.net",
  "motherjones.com",
  "nationalpost.com",
  "news.cn",
  "nikkei.com",
  "npr.org",
  "nypost.com",
  "opindia.com",
  "organiser.org",
  "politico.eu",
  "reuters.com",
  "rmx.news",
  "scmp.com",
  "scroll.in",
  "swarajyamag.com",
  "taipeitimes.com",
  "theglobeandmail.com",
  "theguardian.com",
  "thehindu.com",
  "thehub.ca",
  "theprint.in",
  "thestar.com",
  "thewire.in",
  "timesofisrael.com",
  "washingtonexaminer.com",
  "washingtontimes.com",
  "westernstandard.news",
  "wsj.com",
  "xinhuanet.com"
 ],
 "names": [
  "Al Jazeera",
  "Arab News",
  "Associated Press",
  "Axios",
  "BBC News",
  "Brussels Signal",
  "Business Standard",
  "CBC News",
  "Christian Science Monitor",
  "Democracy Now!",
  "Deutsche Welle",
  "EUobserver",
  "Euronews",
  "FAZ",
  "Focus Taiwan (CNA)",
  "Fox News",
  "Global Times",
  "Globe and Mail",
  "Guardian US",
  "Haaretz",
  "Indian Express",
  "JNS",
  "Jerusalem Post",
  "Le Devoir",
  "Le Figaro",
  "Middle East Eye",
  "Mother Jones",
  "NPR",
  "National Post",
  "New York Post",
  "Nikkei Asia",
  "OpIndia",
  "Organiser",
  "Politico Europe",
  "Remix News",
  "Reuters",
  "Scroll.in",
  "South China Morning Post",
  "Swarajya",
  "Taipei Times",
  "The Daily Caller",
  "The Hindu",
  "The Hub",
  "The Print",
  "The Wire",
  "Times of Israel",
  "Toronto Star",
  "WSJ (news pages)",
  "Washington Examiner",
  "Washington Times",
  "Western Standard",
  "Xinhua"
 ]
}
'@

$targets = $TargetsJson | ConvertFrom-Json
$domains = @{}
foreach ($d in $targets.domains) { $domains[$d.ToLowerInvariant()] = $true }

$MULTI = @('co.uk','org.uk','gov.uk','ac.uk','co.in','net.in','org.in','co.il','org.il',
           'com.au','net.au','org.au','co.jp','or.jp','com.hk','com.tw','org.tw',
           'com.sa','com.cn','com.br','co.kr','co.za','com.mx','com.sg')

function Get-Registrable {
    param([string] $Value)
    if (-not $Value) { return $null }
    $h = $Value.Trim().ToLowerInvariant()
    if ($h -match '://') {
        try { $h = ([Uri]$h).Host } catch { return $null }
    } else {
        $h = ($h -replace '^/+', '') -split '/' | Select-Object -First 1
    }
    $h = $h -replace '^www\d?\.', ''
    $h = $h.TrimEnd('.')
    $parts = @($h -split '\.' | Where-Object { $_ })
    if ($parts.Count -lt 2) { return $null }
    $lastTwo = ($parts[-2..-1]) -join '.'
    if ($parts.Count -ge 3 -and $MULTI -contains $lastTwo) { return ($parts[-3..-1]) -join '.' }
    return $lastTwo
}

function Get-Field {
    param($Record, [string[]] $Names)
    foreach ($n in $Names) {
        $p = $Record.PSObject.Properties | Where-Object {
            ($_.Name -replace '[^a-zA-Z]', '').ToLowerInvariant() -eq ($n -replace '[^a-zA-Z]', '').ToLowerInvariant()
        } | Select-Object -First 1
        if ($p -and $p.Value -and "$($p.Value)".Trim()) { return "$($p.Value)".Trim() }
    }
    return $null
}

function Get-NameKey {
    param([string] $S)
    if (-not $S) { return '' }
    $x = $S.ToLowerInvariant()
    $x = [regex]::Replace($x, '\(.*?\)', ' ')
    $x = [regex]::Replace($x, '\b(the|news|online|daily|post|times|com)\b', ' ')
    return ([regex]::Replace($x, '[^a-z0-9]+', ''))
}

$nameKeys = @{}
foreach ($n in $targets.names) { $nameKeys[(Get-NameKey $n)] = $true }

Write-Host "Reading $In ..." -ForegroundColor Cyan
$raw = Get-Content -Path $In -Raw | ConvertFrom-Json

$records = $null
foreach ($candidate in @($raw, $raw.data, $raw.sources, $raw.results)) {
    if ($candidate -is [System.Array]) { $records = $candidate; break }
}
if (-not $records) {
    Write-Host "Could not find the records array. Top-level properties:" -ForegroundColor Red
    $raw.PSObject.Properties.Name -join ', '
    exit 2
}

Write-Host "$($records.Count) records in payload." -ForegroundColor Cyan

$kept = @()
foreach ($rec in $records) {
    $url  = Get-Field $rec @('Source URL', 'sourceurl', 'url', 'domain')
    $name = Get-Field $rec @('Source', 'name')
    $dom  = Get-Registrable $url

    $hit = $false
    if ($dom -and $domains.ContainsKey($dom)) { $hit = $true }
    elseif ($name -and $nameKeys.ContainsKey((Get-NameKey $name))) { $hit = $true }

    if ($hit) { $kept += $rec }
}

Write-Host "Kept $($kept.Count) records matching the Meridian roster." -ForegroundColor Green

[ordered]@{
    tool     = 'meridian-filter-mbfc.ps1'
    run      = (Get-Date).ToUniversalTime().ToString('o')
    fullSize = $records.Count
    kept     = $kept.Count
    data     = $kept
} | ConvertTo-Json -Depth 8 | Set-Content -Path $Out -Encoding UTF8

Write-Host ""
Write-Host "Written to: $Out" -ForegroundColor Cyan
Write-Host "Attach that file to the Claude conversation."
