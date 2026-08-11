<#
  Reads recent Inbox mail via classic Outlook's COM Automation object model —
  works regardless of whether the mailbox is Exchange Online or on-premises/
  hybrid, since it rides the desktop client's own existing connection instead
  of calling a cloud API. Requires classic desktop Outlook (not "New
  Outlook", which has no COM automation support) to be installed/configured.

  Outlook's "Object Model Guard" will likely show a one-time security prompt
  ("A program is trying to access e-mail address information...") the first
  time this runs in a session — that's expected, not a bug; approve it.

  Emits a single JSON array on stdout, one object per mail item, so
  src/integrations/outlookDesktop.ts can just JSON.parse the whole output.
#>
param(
  [Parameter(Mandatory = $true)][string]$SinceIso
)

$ErrorActionPreference = "Stop"

$sinceLocal = ([DateTimeOffset]::Parse($SinceIso)).UtcDateTime.ToLocalTime()

function Get-SmtpAddress($addressEntry) {
  if ($null -eq $addressEntry) { return $null }
  try {
    # olExchangeUserAddressEntry / olExchangeRemoteUserAddressEntry — resolve
    # the real SMTP address rather than an internal Exchange DN.
    if ($addressEntry.AddressEntryUserType -eq 0 -or $addressEntry.AddressEntryUserType -eq 5) {
      $exUser = $addressEntry.GetExchangeUser()
      if ($null -ne $exUser -and $exUser.PrimarySmtpAddress) { return $exUser.PrimarySmtpAddress }
    }
  } catch {}
  return $addressEntry.Address
}

$outlook = New-Object -ComObject Outlook.Application
$namespace = $outlook.GetNamespace("MAPI")
$inbox = $namespace.GetDefaultFolder(6) # olFolderInbox
$items = $inbox.Items
$items.Sort("[ReceivedTime]", $true) # descending, so we can break early once past the cutoff

$results = New-Object System.Collections.ArrayList

foreach ($item in $items) {
  try {
    if ($item.Class -ne 43) { continue } # olMail — Inbox can also hold meeting requests/receipts, skip those
    if ($item.ReceivedTime -lt $sinceLocal) { break }

    $participants = New-Object System.Collections.ArrayList
    $senderSmtp = Get-SmtpAddress $item.Sender
    if ($senderSmtp) { [void]$participants.Add($senderSmtp) }
    foreach ($recipient in $item.Recipients) {
      $smtp = Get-SmtpAddress $recipient.AddressEntry
      if ($smtp) { [void]$participants.Add($smtp) }
    }

    [void]$results.Add([PSCustomObject]@{
      id           = $item.EntryID
      subject      = $item.Subject
      # "o" (round-trip) gives 7 fractional digits, e.g. ".3620000Z" — that
      # sorts incorrectly as TEXT against other sources' 3-digit-or-none
      # timestamps (e.g. Graph's), since a longer digit string isn't a valid
      # continuation for lexicographic ISO-8601 comparison. Match JS's
      # toISOString() shape (3-digit ms) instead, for consistent text sort
      # order across every ingestion path writing into external_messages.
      receivedTime = ([DateTimeOffset]$item.ReceivedTime).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
      participants = @($participants)
      bodyText     = $item.Body
    })
  } catch {
    # One malformed item shouldn't abort the whole export — same
    # per-item-resilience convention the rest of Speako's integrations use.
    Write-Error "Skipping one item: $($_.Exception.Message)" -ErrorAction Continue
  }
}

# Windows PowerShell 5.1's ConvertTo-Json (powershell.exe, used for the
# widest compatibility across machines) has no reliable single idiom for
# "always serialize as a JSON array" — confirmed empirically:
#   - piping a 2+-item array directly: correct, e.g. "[1,2,3]"
#   - piping a 1-item array directly: unwrapped to a bare scalar, "1"
#   - piping an empty array directly: empty output, not "[]"
#   - prefixing ANY array with the usual ",$arr" trick (which fixes the
#     0/1-item case on PowerShell 6.2+/pwsh): instead serializes the array as
#     an object, {"value":[...],"Count":n} — the opposite problem
# So this handles 0/1/2+ explicitly rather than trusting one idiom to cover
# all three.
if ($results.Count -eq 0) {
  Write-Output "[]"
} elseif ($results.Count -eq 1) {
  Write-Output "[$($results[0] | ConvertTo-Json -Depth 5 -Compress)]"
} else {
  $results | ConvertTo-Json -Depth 5 -Compress
}
