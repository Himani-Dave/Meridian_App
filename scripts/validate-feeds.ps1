<#
    Meridian — feed validator (runs on your machine, not in the cloud session)

    Why this exists: the cloud session's network only reaches an allowlist of hosts,
    and news domains are not on it. Every feed URL in config/sources.json is a
    conventional guess marked "verified": false. This script checks them from your
    own connection and writes a results file to hand back.

    What it does per feed:
      1. GET the URL (follows redirects, real User-Agent, 15s timeout).
      2. Confirm the body actually parses as RSS/Atom/RDF and has items.
      3. On failure, look for the real feed: the site's <link rel="alternate">
         tag, then the common paths (/feed, /rss, /rss.xml, /index.xml, /atom.xml).
      4. Record PASS/FAIL, item count, redirect target, suggested replacement.

    It does NOT touch sources.json. It only reads the web and writes one JSON file.

    Usage (PowerShell 5.1 or 7):
        .\validate-feeds.ps1
        .\validate-feeds.ps1 -NoDiscover        # skip fallback probing, faster
        .\validate-feeds.ps1 -Out C:\path\results.json

    Takes roughly 2-4 minutes for 52 feeds. One request per host per check;
    a 1s pause between feeds keeps it polite.
#>

[CmdletBinding()]
param(
    [string] $Out,
    [switch] $NoDiscover,
    [int]    $TimeoutSec = 15,
    [int]    $DelayMs = 1000
)

$ErrorActionPreference = 'Stop'

if (-not $Out) {
    $base = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
    $Out = Join-Path $base 'meridian-feed-results.json'
}

# Only matters on Windows PowerShell 5.1; harmless (and obsolete) on 7+.
try {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.SecurityProtocolType]::Tls12 -bor [Net.ServicePointManager]::SecurityProtocol
} catch { }

try { Add-Type -AssemblyName System.Net.Http -ErrorAction Stop } catch { }

$UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Meridian/0.1 (personal news briefing; feed validator)'
$FALLBACKS = @('/feed', '/feed/', '/rss', '/rss.xml', '/index.xml', '/atom.xml')

$handler = New-Object System.Net.Http.HttpClientHandler
$handler.AllowAutoRedirect = $true
$handler.MaximumAutomaticRedirections = 8
try {
    $handler.AutomaticDecompression = [System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate
} catch { }

$client = New-Object System.Net.Http.HttpClient($handler)
$client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
$client.DefaultRequestHeaders.Add('User-Agent', $UA)
$client.DefaultRequestHeaders.Add('Accept', 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*')

function Get-Url {
    param([string] $Url)
    $resp = $client.GetAsync($Url).GetAwaiter().GetResult()
    try {
        $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    } catch {
        $body = ''
    }
    $ctype = ''
    if ($resp.Content.Headers.ContentType) { $ctype = $resp.Content.Headers.ContentType.ToString() }
    [PSCustomObject]@{
        Status   = [int] $resp.StatusCode
        FinalUrl = $resp.RequestMessage.RequestUri.AbsoluteUri
        Type     = $ctype
        Body     = $body
    }
}

function Test-Feed {
    # Is this actually a feed, and does it have items?
    param([string] $Body, [string] $ContentType)
    $head = ''
    if ($Body) { $head = $Body.Substring(0, [Math]::Min(4000, $Body.Length)).ToLowerInvariant() }
    $isFeed = $head.Contains('<rss') -or $head.Contains('<feed') -or $head.Contains('<rdf:rdf') `
              -or ($ContentType -match 'application/(rss|atom)\+xml')
    if (-not $isFeed) { return [PSCustomObject]@{ IsFeed = $false; Items = 0 } }
    $items = ([regex]::Matches($Body, '<item[\s>]', 'IgnoreCase')).Count +
             ([regex]::Matches($Body, '<entry[\s>]', 'IgnoreCase')).Count
    [PSCustomObject]@{ IsFeed = $true; Items = $items }
}

function Find-FeedLink {
    # Pull <link rel="alternate" type="application/rss+xml" href="..."> off a homepage.
    param([string] $Html, [string] $Base)
    foreach ($m in [regex]::Matches($Html, '<link[^>]+type=["'']application/(?:rss|atom)\+xml["''][^>]*>', 'IgnoreCase')) {
        $href = [regex]::Match($m.Value, 'href=["'']([^"'']+)["'']', 'IgnoreCase')
        if ($href.Success) {
            try { return ([Uri]::new([Uri]$Base, $href.Groups[1].Value)).AbsoluteUri } catch { }
        }
    }
    return $null
}

function Find-Feed {
    param([string] $OriginalUrl, $FirstResponse)
    $origin = ([Uri]$OriginalUrl).GetLeftPart([UriPartial]::Authority)

    if ($FirstResponse -and $FirstResponse.Type -notmatch 'xml') {
        $sniffed = Find-FeedLink -Html $FirstResponse.Body -Base $origin
        if ($sniffed -and $sniffed -ne $OriginalUrl) {
            try {
                $r = Get-Url $sniffed
                if ($r.Status -eq 200) {
                    $i = Test-Feed -Body $r.Body -ContentType $r.Type
                    if ($i.IsFeed -and $i.Items -gt 0) {
                        return [PSCustomObject]@{ Url = $sniffed; Items = $i.Items; How = 'via homepage <link> tag' }
                    }
                }
            } catch { }
        }
    }

    foreach ($path in $FALLBACKS) {
        $candidate = $origin + $path
        if ($candidate -eq $OriginalUrl) { continue }
        try {
            $r = Get-Url $candidate
            if ($r.Status -ne 200) { continue }
            $i = Test-Feed -Body $r.Body -ContentType $r.Type
            if ($i.IsFeed -and $i.Items -gt 0) {
                return [PSCustomObject]@{ Url = $candidate; Items = $i.Items; How = "at $path" }
            }
        } catch { }
        Start-Sleep -Milliseconds 300
    }
    return $null
}

# ---------------------------------------------------------------------------

$FeedsJson = @'
[
 {
  "id": "democracynow",
  "name": "Democracy Now!",
  "bucket": "outlets",
  "lean": "left",
  "country": "US",
  "url": "https://www.democracynow.org/democracynow.rss"
 },
 {
  "id": "motherjones",
  "name": "Mother Jones",
  "bucket": "outlets",
  "lean": "left",
  "country": "US",
  "url": "https://www.motherjones.com/feed/"
 },
 {
  "id": "guardian-us",
  "name": "Guardian US",
  "bucket": "outlets",
  "lean": "lean_left",
  "country": "US",
  "url": "https://www.theguardian.com/us-news/rss"
 },
 {
  "id": "npr",
  "name": "NPR",
  "bucket": "outlets",
  "lean": "lean_left",
  "country": "US",
  "url": "https://feeds.npr.org/1004/rss.xml"
 },
 {
  "id": "ap",
  "name": "Associated Press",
  "bucket": "outlets",
  "lean": "centre",
  "country": "US",
  "url": "https://apnews.com/hub/ap-top-news/rss"
 },
 {
  "id": "bbc",
  "name": "BBC News",
  "bucket": "outlets",
  "lean": "centre",
  "country": "UK",
  "url": "https://feeds.bbci.co.uk/news/world/rss.xml"
 },
 {
  "id": "axios",
  "name": "Axios",
  "bucket": "outlets",
  "lean": "centre",
  "country": "US",
  "url": "https://api.axios.com/feed/"
 },
 {
  "id": "csmonitor",
  "name": "Christian Science Monitor",
  "bucket": "outlets",
  "lean": "centre",
  "country": "US",
  "url": "https://rss.csmonitor.com/feeds/world"
 },
 {
  "id": "wsj",
  "name": "WSJ (news pages)",
  "bucket": "outlets",
  "lean": "lean_right",
  "country": "US",
  "url": "https://feeds.a.dj.com/rss/RSSWorldNews.xml"
 },
 {
  "id": "washexaminer",
  "name": "Washington Examiner",
  "bucket": "outlets",
  "lean": "lean_right",
  "country": "US",
  "url": "https://www.washingtonexaminer.com/feed"
 },
 {
  "id": "foxnews",
  "name": "Fox News",
  "bucket": "outlets",
  "lean": "right",
  "country": "US",
  "url": "https://moxie.foxnews.com/google-publisher/world.xml"
 },
 {
  "id": "nypost",
  "name": "New York Post",
  "bucket": "outlets",
  "lean": "right",
  "country": "US",
  "url": "https://nypost.com/feed/"
 },
 {
  "id": "dailycaller",
  "name": "The Daily Caller",
  "bucket": "outlets",
  "lean": "right",
  "country": "US",
  "url": "https://dailycaller.com/feed/"
 },
 {
  "id": "washtimes",
  "name": "Washington Times",
  "bucket": "outlets",
  "lean": "right",
  "country": "US",
  "url": "https://www.washingtontimes.com/rss/headlines/news/world/"
 },
 {
  "id": "torstar",
  "name": "Toronto Star",
  "bucket": "outlets",
  "lean": "lean_left",
  "country": "CA",
  "url": "https://www.thestar.com/feed/"
 },
 {
  "id": "cbc",
  "name": "CBC News",
  "bucket": "outlets",
  "lean": "centre",
  "country": "CA",
  "url": "https://www.cbc.ca/webfeed/rss/rss-world"
 },
 {
  "id": "globemail",
  "name": "Globe and Mail",
  "bucket": "outlets",
  "lean": "centre",
  "country": "CA",
  "url": "https://www.theglobeandmail.com/arc/outboundfeeds/rss/category/world/"
 },
 {
  "id": "natpost",
  "name": "National Post",
  "bucket": "outlets",
  "lean": "lean_right",
  "country": "CA",
  "url": "https://nationalpost.com/feed/"
 },
 {
  "id": "thehub-ca",
  "name": "The Hub",
  "bucket": "outlets",
  "lean": "lean_right",
  "country": "CA",
  "url": "https://thehub.ca/feed/"
 },
 {
  "id": "westernstd",
  "name": "Western Standard",
  "bucket": "outlets",
  "lean": "right",
  "country": "CA",
  "url": "https://www.westernstandard.news/feed"
 },
 {
  "id": "ledevoir",
  "name": "Le Devoir",
  "bucket": "outlets",
  "lean": "lean_left",
  "country": "CA",
  "url": "https://www.ledevoir.com/rss/manchettes.xml"
 },
 {
  "id": "thewire-in",
  "name": "The Wire",
  "bucket": "outlets",
  "lean": "left",
  "country": "IN",
  "url": "https://thewire.in/rss"
 },
 {
  "id": "scroll-in",
  "name": "Scroll.in",
  "bucket": "outlets",
  "lean": "left",
  "country": "IN",
  "url": "https://scroll.in/feed"
 },
 {
  "id": "thehindu",
  "name": "The Hindu",
  "bucket": "outlets",
  "lean": "lean_left",
  "country": "IN",
  "url": "https://www.thehindu.com/news/national/feeder/default.rss"
 },
 {
  "id": "indianexp",
  "name": "Indian Express",
  "bucket": "outlets",
  "lean": "centre",
  "country": "IN",
  "url": "https://indianexpress.com/feed/"
 },
 {
  "id": "theprint",
  "name": "The Print",
  "bucket": "outlets",
  "lean": "centre",
  "country": "IN",
  "url": "https://theprint.in/feed/"
 },
 {
  "id": "bstandard",
  "name": "Business Standard",
  "bucket": "outlets",
  "lean": "centre",
  "country": "IN",
  "url": "https://www.business-standard.com/rss/home_page_top_stories.rss"
 },
 {
  "id": "swarajya",
  "name": "Swarajya",
  "bucket": "outlets",
  "lean": "right",
  "country": "IN",
  "url": "https://swarajyamag.com/feed"
 },
 {
  "id": "opindia",
  "name": "OpIndia",
  "bucket": "outlets",
  "lean": "right",
  "country": "IN",
  "url": "https://www.opindia.com/feed/"
 },
 {
  "id": "organiser",
  "name": "Organiser",
  "bucket": "outlets",
  "lean": "right",
  "country": "IN",
  "url": "https://organiser.org/feed/"
 },
 {
  "id": "euronews",
  "name": "Euronews",
  "bucket": "outlets",
  "lean": "centre",
  "country": "EU",
  "url": "https://www.euronews.com/rss"
 },
 {
  "id": "politico-eu",
  "name": "Politico Europe",
  "bucket": "outlets",
  "lean": "centre",
  "country": "EU",
  "url": "https://www.politico.eu/feed/"
 },
 {
  "id": "euobserver",
  "name": "EUobserver",
  "bucket": "outlets",
  "lean": "lean_left",
  "country": "EU",
  "url": "https://euobserver.com/rss.xml"
 },
 {
  "id": "dw",
  "name": "Deutsche Welle",
  "bucket": "outlets",
  "lean": "centre",
  "country": "DE",
  "url": "https://rss.dw.com/rdf/rss-en-world"
 },
 {
  "id": "lefigaro",
  "name": "Le Figaro",
  "bucket": "outlets",
  "lean": "lean_right",
  "country": "FR",
  "url": "https://www.lefigaro.fr/rss/figaro_actualites.xml"
 },
 {
  "id": "faz",
  "name": "FAZ",
  "bucket": "outlets",
  "lean": "lean_right",
  "country": "DE",
  "url": "https://www.faz.net/rss/aktuell/"
 },
 {
  "id": "brusselssig",
  "name": "Brussels Signal",
  "bucket": "outlets",
  "lean": "right",
  "country": "EU",
  "url": "https://brusselssignal.eu/feed/"
 },
 {
  "id": "remixnews",
  "name": "Remix News",
  "bucket": "outlets",
  "lean": "right",
  "country": "EU",
  "url": "https://rmx.news/feed/"
 },
 {
  "id": "haaretz",
  "name": "Haaretz",
  "bucket": "outlets",
  "lean": "left",
  "country": "IL",
  "url": "https://www.haaretz.com/srv/htz--all-articles"
 },
 {
  "id": "timesofisrael",
  "name": "Times of Israel",
  "bucket": "outlets",
  "lean": "centre",
  "country": "IL",
  "url": "https://www.timesofisrael.com/feed/"
 },
 {
  "id": "jpost",
  "name": "Jerusalem Post",
  "bucket": "outlets",
  "lean": "lean_right",
  "country": "IL",
  "url": "https://www.jpost.com/rss/rssfeedsheadlines.aspx"
 },
 {
  "id": "jns",
  "name": "JNS",
  "bucket": "outlets",
  "lean": "right",
  "country": "IL",
  "url": "https://www.jns.org/feed/"
 },
 {
  "id": "aljazeera",
  "name": "Al Jazeera",
  "bucket": "outlets",
  "lean": "varies",
  "country": "QA",
  "url": "https://www.aljazeera.com/xml/rss/all.xml"
 },
 {
  "id": "middleeasteye",
  "name": "Middle East Eye",
  "bucket": "outlets",
  "lean": "left",
  "country": "UK",
  "url": "https://www.middleeasteye.net/rss"
 },
 {
  "id": "arabnews",
  "name": "Arab News",
  "bucket": "outlets",
  "lean": "varies",
  "country": "SA",
  "url": "https://www.arabnews.com/rss.xml"
 },
 {
  "id": "globaltimes",
  "name": "Global Times",
  "bucket": "outlets",
  "lean": "state",
  "country": "CN",
  "url": "https://www.globaltimes.cn/rss/outbrain.xml"
 },
 {
  "id": "scmp",
  "name": "South China Morning Post",
  "bucket": "outlets",
  "lean": "varies",
  "country": "HK",
  "url": "https://www.scmp.com/rss/91/feed"
 },
 {
  "id": "focustaiwan",
  "name": "Focus Taiwan (CNA)",
  "bucket": "outlets",
  "lean": "centre",
  "country": "TW",
  "url": "https://focustaiwan.tw/rss/politics"
 },
 {
  "id": "taipeitimes",
  "name": "Taipei Times",
  "bucket": "outlets",
  "lean": "pro_sovereignty",
  "country": "TW",
  "url": "https://www.taipeitimes.com/xml/index.rss"
 },
 {
  "id": "nikkeiasia",
  "name": "Nikkei Asia",
  "bucket": "outlets",
  "lean": "centre",
  "country": "JP",
  "url": "https://asia.nikkei.com/rss/feed/nar"
 },
 {
  "id": "ec-press",
  "name": "European Commission press corner",
  "bucket": "primary",
  "lean": null,
  "country": "Europe",
  "url": "https://ec.europa.eu/commission/presscorner/api/rss"
 },
 {
  "id": "unnews",
  "name": "UN News / OHCHR",
  "bucket": "primary",
  "lean": null,
  "country": "Global",
  "url": "https://news.un.org/feed/subscribe/en/news/all/rss.xml"
 }
]
'@

$feeds = $FeedsJson | ConvertFrom-Json
$results = @()
$n = 0

Write-Host ""
Write-Host "Meridian feed validator - $($feeds.Count) feeds$(if ($NoDiscover) { '' } else { ' (with fallback discovery)' })" -ForegroundColor Cyan
Write-Host ""

foreach ($f in $feeds) {
    $n++
    Write-Progress -Activity 'Checking feeds' -Status "$($f.name)" -PercentComplete (100 * $n / $feeds.Count)

    $r = [ordered]@{
        id = $f.id; name = $f.name; bucket = $f.bucket; lean = $f.lean; country = $f.country
        url = $f.url; ok = $false; items = 0; status = $null
        note = ''; suggested = $null; redirected = $null
    }

    $first = $null
    try {
        $first = Get-Url $f.url
        $r.status = $first.Status
        $insp = Test-Feed -Body $first.Body -ContentType $first.Type

        if ($first.Status -eq 200 -and $insp.IsFeed) {
            $r.ok = $true
            $r.items = $insp.Items
            if ($first.FinalUrl -ne $f.url) { $r.redirected = $first.FinalUrl; $r.note = 'redirected' }
            if ($insp.Items -eq 0) { $r.ok = $false; $r.note = 'parses as a feed but has 0 items' }
        }
        else {
            $r.note = if ($first.Status -ne 200) { "HTTP $($first.Status)" }
                      elseif ($insp.IsFeed) { 'unexpected' }
                      else { '200 but not a feed (probably an HTML page)' }
        }
    }
    catch {
        $msg = $_.Exception.Message
        if ($_.Exception.InnerException) { $msg = "$msg - $($_.Exception.InnerException.Message)" }
        $r.note = $msg
    }

    if (-not $r.ok -and -not $NoDiscover) {
        try {
            $found = Find-Feed -OriginalUrl $f.url -FirstResponse $first
            if ($found) {
                $r.ok = $true
                $r.suggested = $found.Url
                $r.items = $found.Items
                $r.note = "original failed ($($r.note)); found $($found.How)"
            }
        } catch { }
    }

    $obj = [PSCustomObject]$r
    $results += $obj

    $mark  = if ($obj.ok) { 'PASS' } else { 'FAIL' }
    $color = if ($obj.ok) { 'Green' } else { 'Yellow' }
    $extra = if ($obj.suggested) { "  -> USE: $($obj.suggested)" }
             elseif ($obj.redirected) { "  -> $($obj.redirected)" }
             else { '' }
    $tail  = if ($obj.ok) { "$($obj.items) items" } else { $obj.note }
    Write-Host ("{0}  {1} {2}{3}" -f $mark, $obj.name.PadRight(26), $tail, $extra) -ForegroundColor $color

    Start-Sleep -Milliseconds $DelayMs
}

Write-Progress -Activity 'Checking feeds' -Completed

$ok     = @($results | Where-Object { $_.ok })
$failed = @($results | Where-Object { -not $_.ok })

Write-Host ""
Write-Host "$($ok.Count)/$($results.Count) feeds verified" -ForegroundColor Cyan
Write-Host ""

# --- balance check: the guardrail, not a nicety --------------------------
Write-Host "Balance by lean (verified / total):"
$empty = @()
$byLean = @{}
foreach ($r in $results | Where-Object { $_.bucket -ne 'primary' -and $_.lean }) {
    if (-not $byLean.ContainsKey($r.lean)) { $byLean[$r.lean] = @{ total = 0; ok = 0 } }
    $byLean[$r.lean].total++
    if ($r.ok) { $byLean[$r.lean].ok++ }
}
foreach ($lean in ($byLean.Keys | Sort-Object)) {
    $c = $byLean[$lean]
    Write-Host ("  {0} {1}/{2}" -f $lean.PadRight(20), $c.ok, $c.total)
    if ($c.ok -eq 0 -and $c.total -gt 0) { $empty += $lean }
}

$payload = [ordered]@{
    tool      = 'meridian-validate-feeds.ps1'
    run       = (Get-Date).ToUniversalTime().ToString('o')
    host      = $env:COMPUTERNAME
    psVersion = $PSVersionTable.PSVersion.ToString()
    discover  = (-not $NoDiscover.IsPresent)
    verified  = $ok.Count
    total     = $results.Count
    balance   = ($byLean.Keys | Sort-Object | ForEach-Object { [ordered]@{ lean = $_; ok = $byLean[$_].ok; total = $byLean[$_].total } })
    results   = $results
}

$payload | ConvertTo-Json -Depth 6 | Set-Content -Path $Out -Encoding UTF8

Write-Host ""
Write-Host "Results written to: $Out" -ForegroundColor Cyan
Write-Host "Attach that file to the Claude conversation and it will apply the fixes to config/sources.json."

if ($empty.Count) {
    Write-Host ""
    Write-Host "BALANCE FAILURE: no working feeds for lean: $($empty -join ', ')" -ForegroundColor Red
    Write-Host "Fix these before ingesting. A missing side is a silent bias, not a missing feature." -ForegroundColor Red
}
