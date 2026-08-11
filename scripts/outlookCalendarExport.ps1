<#
  Reads upcoming Calendar appointments via classic Outlook's COM Automation
  object model — same rationale as outlookExport.ps1 (email): works
  regardless of whether the mailbox is Exchange Online or on-premises/
  hybrid, since it rides the desktop client's own existing connection.
  Requires classic desktop Outlook (not "New Outlook").

  Emits a single JSON array on stdout, one object per appointment within
  [now, now + WindowMinutes], so src/integrations/outlookDesktopCalendar.ts
  can just JSON.parse the whole output.
#>
param(
  [Parameter(Mandatory = $true)][int]$WindowMinutes
)

$ErrorActionPreference = "Stop"

$now = Get-Date
$windowEnd = $now.AddMinutes($WindowMinutes)

$outlook = New-Object -ComObject Outlook.Application
$namespace = $outlook.GetNamespace("MAPI")
$calendar = $namespace.GetDefaultFolder(9) # olFolderCalendar
$items = $calendar.Items
# Recurring series are stored as one master item by default — expanding
# occurrences is required to see actual upcoming instances, not just the
# series' original start date. IncludeRecurrences + Sort MUST happen before
# Restrict for a date-range restriction to correctly apply to expanded
# occurrences (Microsoft's documented ordering) — confirmed empirically too:
# a naive foreach+break over the sorted-but-unrestricted collection took over
# a minute on a calendar with years of recurring meetings, since it still has
# to walk every past occurrence from the earliest one before reaching "now."
# Restrict lets Outlook filter internally instead, which is what actually
# fixes the slowness (not a change in what gets returned).
$items.IncludeRecurrences = $true
$items.Sort("[Start]")
# Outlook's Restrict() date filter syntax is locale-dependent (expects the
# current user's short date/time format, not ISO) — an accepted, documented
# tradeoff here, unlike the email export's deliberately locale-proof
# iterate-and-break approach, because Calendar's recurrence expansion makes
# Restrict a practical necessity, not just an optimization.
$filter = "[Start] >= '" + $now.ToString("g") + "' AND [Start] <= '" + $windowEnd.ToString("g") + "'"
$restricted = $items.Restrict($filter)

$results = New-Object System.Collections.ArrayList

foreach ($item in $restricted) {
  try {
    if ($item.Class -ne 26) { continue } # olAppointmentItem

    [void]$results.Add([PSCustomObject]@{
      id            = $item.EntryID
      subject       = $item.Subject
      # Body can be large — a few hundred chars is plenty for keyword-based
      # meeting-type classification (see classifyMeetingType), same
      # rationale as msGraphSync.ts capping snippet lengths elsewhere.
      description   = if ($item.Body) { $item.Body.Substring(0, [Math]::Min(500, $item.Body.Length)) } else { "" }
      startTime     = ([DateTimeOffset]$item.Start).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
      attendeeCount = $item.Recipients.Count
      isRecurring   = [bool]$item.IsRecurring
    })
  } catch {
    Write-Error "Skipping one appointment: $($_.Exception.Message)" -ErrorAction Continue
  }
}

# See outlookExport.ps1 for why Windows PowerShell 5.1's ConvertTo-Json needs
# this explicit 0/1/2+ branching rather than a single array-preserving idiom.
if ($results.Count -eq 0) {
  Write-Output "[]"
} elseif ($results.Count -eq 1) {
  Write-Output "[$($results[0] | ConvertTo-Json -Depth 5 -Compress)]"
} else {
  $results | ConvertTo-Json -Depth 5 -Compress
}
