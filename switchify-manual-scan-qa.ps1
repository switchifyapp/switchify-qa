param(
    [Parameter(Position = 0)]
    [ValidateSet("doctor", "prime", "capture", "press", "restore", "report")]
    [string]$Command = "doctor",

    [Parameter(Position = 1)]
    [ValidateSet("", "next", "previous", "select")]
    [string]$Action = "",

    [string]$DeviceId = "",
    [string]$AdbPath = "",
    [string]$RunDir = "",
    [int]$AfterPressDelayMs = 750,
    [string]$PackageName = "com.enaboapps.switchify",
    [string]$ServiceName = "com.enaboapps.switchify/.service.core.SwitchifyAccessibilityService"
)

$ErrorActionPreference = "Stop"

$RemoteTmp = "/sdcard/switchify_qa"
$RemoteDataTmp = "/data/local/tmp/switchify_qa"
$SwitchEventsPath = "/data/user_de/0/$PackageName/files/switch_events.json"
$PrefsPath = "/data/user_de/0/$PackageName/shared_prefs/switchify_preferences.xml"

function Resolve-Adb {
    if ($AdbPath -and (Test-Path -LiteralPath $AdbPath)) {
        return (Resolve-Path -LiteralPath $AdbPath).Path
    }

    $fromPath = Get-Command adb -ErrorAction SilentlyContinue
    if ($fromPath) {
        return $fromPath.Source
    }

    $candidateRoots = @(
        $env:ANDROID_HOME,
        $env:ANDROID_SDK_ROOT,
        (Join-Path $env:LOCALAPPDATA "Android\Sdk")
    ) | Where-Object { $_ }

    foreach ($root in $candidateRoots) {
        $candidate = Join-Path $root "platform-tools\adb.exe"
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }

    throw "ADB was not found. Pass -AdbPath, add adb to PATH, or set ANDROID_HOME/ANDROID_SDK_ROOT."
}

$script:Adb = Resolve-Adb

function Get-RunDir {
    if ($RunDir) {
        $dir = $RunDir
    } else {
        $stamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
        $dir = Join-Path $PSScriptRoot "runs\$stamp"
    }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    return (Resolve-Path -LiteralPath $dir).Path
}

$script:RunPath = Get-RunDir

function Write-JsonFile {
    param(
        [Parameter(Mandatory = $true)] [object]$Data,
        [Parameter(Mandatory = $true)] [string]$Path
    )
    $Data | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Add-JsonLine {
    param(
        [Parameter(Mandatory = $true)] [string]$Path,
        [Parameter(Mandatory = $true)] [object]$Data
    )
    $Data | ConvertTo-Json -Compress -Depth 12 | Add-Content -LiteralPath $Path -Encoding UTF8
}

function Set-SharedPreferenceString {
    param(
        [Parameter(Mandatory = $true)] [string]$XmlPath,
        [Parameter(Mandatory = $true)] [string]$Name,
        [Parameter(Mandatory = $true)] [string]$Value
    )

    [xml]$doc = Get-Content -LiteralPath $XmlPath -Raw
    if (-not $doc.map) {
        $doc.RemoveAll()
        [void]$doc.AppendChild($doc.CreateElement("map"))
    }

    $node = $doc.SelectSingleNode("/map/string[@name='$Name']")
    if (-not $node) {
        $node = $doc.CreateElement("string")
        $attr = $doc.CreateAttribute("name")
        $attr.Value = $Name
        [void]$node.Attributes.Append($attr)
        [void]$doc.map.AppendChild($node)
    }
    $node.InnerText = $Value
    $doc.Save($XmlPath)
}

function Get-SharedPreferenceMap {
    param(
        [Parameter(Mandatory = $true)] [string]$XmlPath
    )

    [xml]$doc = Get-Content -LiteralPath $XmlPath -Raw
    $map = @{}
    if (-not $doc.map) {
        return $map
    }

    foreach ($node in $doc.map.ChildNodes) {
        $nameAttr = $node.Attributes["name"]
        $name = if ($nameAttr) { $nameAttr.Value } else { $null }
        if (-not $name) {
            continue
        }
        $elementType = $node.LocalName
        $value = switch ($elementType) {
            "string" { $node.InnerText }
            default {
                $valueAttr = $node.Attributes["value"]
                if ($valueAttr) { $valueAttr.Value } else { $node.InnerText }
            }
        }
        $map[$name] = [pscustomobject]@{
            type = $elementType
            value = $value
        }
    }
    return $map
}

function Assert-OnlyExpectedPreferenceChanges {
    param(
        [Parameter(Mandatory = $true)] [string]$BeforePath,
        [Parameter(Mandatory = $true)] [string]$AfterPath,
        [Parameter(Mandatory = $true)] [hashtable]$ExpectedStringOverrides
    )

    $before = Get-SharedPreferenceMap -XmlPath $BeforePath
    $after = Get-SharedPreferenceMap -XmlPath $AfterPath
    $allKeys = @($before.Keys + $after.Keys | Select-Object -Unique)
    $unexpected = @()
    $expected = @()

    foreach ($key in $allKeys) {
        $beforeValue = $before[$key]
        $afterValue = $after[$key]
        if (-not $before.ContainsKey($key) -or -not $after.ContainsKey($key)) {
            $unexpected += $key
            continue
        }
        if (
            $ExpectedStringOverrides.ContainsKey($key) -and
            $afterValue.value -eq $ExpectedStringOverrides[$key]
        ) {
            if ($beforeValue.value -ne $afterValue.value) {
                $expected += [pscustomobject]@{
                    key = $key
                    before = $beforeValue.value
                    after = $afterValue.value
                }
            }
            continue
        }
        if ($beforeValue.type -ne $afterValue.type) {
            $unexpected += $key
            continue
        }
        if ($beforeValue.value -eq $afterValue.value) {
            continue
        }
        $unexpected += $key
    }

    if ($unexpected.Count -gt 0) {
        throw "Prime generated unexpected preference changes: $($unexpected -join ', ')"
    }

    return [pscustomobject]@{
        beforeKeyCount = $before.Count
        afterKeyCount = $after.Count
        expectedChanges = $expected
    }
}

function Invoke-Adb {
    param(
        [Parameter(Mandatory = $true)] [string[]]$Args,
        [switch]$AllowFailure
    )

    $fullArgs = @()
    if ($DeviceId) {
        $fullArgs += @("-s", $DeviceId)
    }
    $fullArgs += $Args

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $script:Adb
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    if ($psi.ArgumentList -ne $null) {
        foreach ($arg in $fullArgs) {
            [void]$psi.ArgumentList.Add($arg)
        }
    } else {
        $escapedArgs = @()
        foreach ($arg in $fullArgs) {
            if ($arg -match '[\s"]') {
                $escapedArgs += '"' + ($arg -replace '"', '\"') + '"'
            } else {
                $escapedArgs += $arg
            }
        }
        $psi.Arguments = $escapedArgs -join " "
    }
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    $exit = $process.ExitCode
    $text = (($stdout, $stderr) | Where-Object { $_ }) -join [Environment]::NewLine
    if ($exit -ne 0 -and -not $AllowFailure) {
        throw "adb $($fullArgs -join ' ') failed with exit $exit`n$text"
    }
    [pscustomobject]@{
        ExitCode = $exit
        Output = $text
        Args = $fullArgs
    }
}

function Invoke-AdbShell {
    param(
        [Parameter(Mandatory = $true)] [string]$ShellCommand,
        [switch]$AllowFailure
    )
    Invoke-Adb -Args @("shell", $ShellCommand) -AllowFailure:$AllowFailure
}

function Get-AdbDevices {
    $result = Invoke-Adb -Args @("devices", "-l")
    $lines = $result.Output -split "\r?\n"
    $devices = @()
    foreach ($line in $lines) {
        if ($line -match "^(\S+)\s+(device|unauthorized|offline)(?:\s+(.*))?$") {
            $devices += [pscustomobject]@{
                Id = $Matches[1]
                State = $Matches[2]
                Detail = if ($Matches.Count -ge 4) { $Matches[3] } else { "" }
            }
        }
    }
    return $devices
}

function Confirm-Device {
    $devices = Get-AdbDevices
    if ($DeviceId) {
        $match = $devices | Where-Object { $_.Id -eq $DeviceId } | Select-Object -First 1
        if (-not $match) {
            throw "Device '$DeviceId' was not found. Connected devices:`n$($devices | Format-Table | Out-String)"
        }
        if ($match.State -ne "device") {
            throw "Device '$DeviceId' is $($match.State), not ready."
        }
        return $match
    }

    $ready = @($devices | Where-Object { $_.State -eq "device" })
    if ($ready.Count -eq 0) {
        throw "No authorized Android devices are connected."
    }
    if ($ready.Count -gt 1) {
        throw "Multiple Android devices are connected. Re-run with -DeviceId. Devices:`n$($devices | Format-Table | Out-String)"
    }
    $script:DeviceId = $ready[0].Id
    return $ready[0]
}

function Test-RunAs {
    $result = Invoke-AdbShell -ShellCommand "run-as $PackageName id" -AllowFailure
    return $result.ExitCode -eq 0
}

function Get-ForegroundState {
    $window = Invoke-Adb -Args @("shell", "dumpsys", "window") -AllowFailure
    $focusLines = @($window.Output -split "\r?\n" | Where-Object {
        $_ -match "mCurrentFocus|mFocusedApp|topResumedActivity|mTopFullscreenOpaqueWindowState"
    })
    return [pscustomobject]@{
        Lines = $focusLines
        Raw = ($focusLines -join [Environment]::NewLine)
    }
}

function Get-AccessibilityEnabled {
    $enabled = Invoke-Adb -Args @("shell", "settings", "get", "secure", "enabled_accessibility_services") -AllowFailure
    $value = $enabled.Output.Trim()
    $expandedServiceName = "$PackageName/com.enaboapps.switchify.service.core.SwitchifyAccessibilityService"
    return [pscustomobject]@{
        Enabled = ($value -like "*$ServiceName*") -or ($value -like "*$expandedServiceName*")
        Raw = $value
    }
}

function Get-UiTexts {
    param([string]$XmlPath)

    if (-not (Test-Path -LiteralPath $XmlPath)) {
        return @()
    }

    try {
        [xml]$doc = Get-Content -LiteralPath $XmlPath -Raw
        $nodes = $doc.SelectNodes("//node")
        $texts = New-Object System.Collections.Generic.List[string]
        foreach ($node in $nodes) {
            $text = $node.text
            $desc = $node."content-desc"
            if ($text -and $text.Trim().Length -gt 0) {
                $texts.Add($text.Trim())
            }
            if ($desc -and $desc.Trim().Length -gt 0) {
                $texts.Add("desc: " + $desc.Trim())
            }
        }
        return @($texts | Select-Object -Unique | Select-Object -First 80)
    } catch {
        return @("Failed to parse window.xml: $($_.Exception.Message)")
    }
}

function Get-RecentLogcat {
    $logcat = Invoke-Adb -Args @("logcat", "-d", "-t", "900") -AllowFailure
    $lines = $logcat.Output -split "\r?\n"
    $interesting = @($lines | Where-Object {
        $_ -match "Switchify|AndroidRuntime|ANR|FATAL EXCEPTION|Accessibility|ActivityManager|WindowManager|InputDispatcher"
    } | Select-Object -Last 250)
    return $interesting -join [Environment]::NewLine
}

function Invoke-Doctor {
    $device = Confirm-Device
    $pkg = Invoke-Adb -Args @("shell", "pm", "path", $PackageName) -AllowFailure
    $accessibility = Get-AccessibilityEnabled
    $foreground = Get-ForegroundState
    $screencap = Invoke-Adb -Args @("shell", "screencap", "-p", "$RemoteTmp-doctor.png") -AllowFailure
    Invoke-Adb -Args @("shell", "rm", "-f", "$RemoteTmp-doctor.png") -AllowFailure | Out-Null
    $ui = Invoke-Adb -Args @("shell", "uiautomator", "dump", "$RemoteTmp-doctor.xml") -AllowFailure
    Invoke-Adb -Args @("shell", "rm", "-f", "$RemoteTmp-doctor.xml") -AllowFailure | Out-Null
    $logcat = Invoke-Adb -Args @("logcat", "-d", "-t", "5") -AllowFailure
    $runAs = Test-RunAs

    $state = [pscustomobject]@{
        timestamp = (Get-Date).ToString("o")
        adb = $script:Adb
        device = $device
        packageInstalled = $pkg.ExitCode -eq 0
        packagePath = $pkg.Output.Trim()
        accessibilityServiceEnabled = $accessibility.Enabled
        accessibilityServicesRaw = $accessibility.Raw
        foreground = $foreground.Lines
        screencapWorks = $screencap.ExitCode -eq 0
        uiautomatorWorks = $ui.ExitCode -eq 0
        logcatWorks = $logcat.ExitCode -eq 0
        runAsWorks = $runAs
    }

    Write-JsonFile -Data $state -Path (Join-Path $script:RunPath "doctor.json")
    $state | Format-List | Out-String | Set-Content -LiteralPath (Join-Path $script:RunPath "doctor.txt") -Encoding UTF8
    $state | Format-List
}

function Invoke-Capture {
    Confirm-Device | Out-Null
    Invoke-Adb -Args @("shell", "mkdir", "-p", $RemoteTmp) | Out-Null

    $screenRemote = "$RemoteTmp/screen.png"
    $xmlRemote = "$RemoteTmp/window.xml"
    $screenLocal = Join-Path $script:RunPath "screen.png"
    $xmlLocal = Join-Path $script:RunPath "window.xml"
    $logLocal = Join-Path $script:RunPath "logcat.txt"
    $windowLocal = Join-Path $script:RunPath "dumpsys-window.txt"
    $stateJson = Join-Path $script:RunPath "state.json"
    $stateMd = Join-Path $script:RunPath "state.md"

    Invoke-Adb -Args @("shell", "screencap", "-p", $screenRemote) | Out-Null
    Invoke-Adb -Args @("pull", $screenRemote, $screenLocal) | Out-Null
    Invoke-Adb -Args @("shell", "uiautomator", "dump", $xmlRemote) -AllowFailure | Out-Null
    Invoke-Adb -Args @("pull", $xmlRemote, $xmlLocal) -AllowFailure | Out-Null

    $window = Invoke-Adb -Args @("shell", "dumpsys", "window") -AllowFailure
    $window.Output | Set-Content -LiteralPath $windowLocal -Encoding UTF8

    $logcat = Get-RecentLogcat
    $logcat | Set-Content -LiteralPath $logLocal -Encoding UTF8

    $foreground = Get-ForegroundState
    $accessibility = Get-AccessibilityEnabled
    $size = Invoke-Adb -Args @("shell", "wm", "size") -AllowFailure
    $texts = Get-UiTexts -XmlPath $xmlLocal
    $warnings = @($logcat -split "\r?\n" | Where-Object {
        $_ -match " E | W |FATAL EXCEPTION|ANR|Exception|Error"
    } | Select-Object -Last 80)

    $state = [pscustomobject]@{
        timestamp = (Get-Date).ToString("o")
        deviceId = $script:DeviceId
        packageName = $PackageName
        accessibilityServiceEnabled = $accessibility.Enabled
        foreground = $foreground.Lines
        screenSize = $size.Output.Trim()
        uiText = $texts
        warnings = $warnings
        screenshot = $screenLocal
        windowXml = $xmlLocal
        logcat = $logLocal
        dumpsysWindow = $windowLocal
    }

    Write-JsonFile -Data $state -Path $stateJson

    $md = @()
    $md += "# Switchify Manual Scan QA State"
    $md += ""
    $md += "- Timestamp: $($state.timestamp)"
    $md += "- Device: $($state.deviceId)"
    $md += "- Accessibility service enabled: $($state.accessibilityServiceEnabled)"
    $md += "- Screen: $($state.screenSize)"
    $md += "- Screenshot: $($state.screenshot)"
    $md += "- UI XML: $($state.windowXml)"
    $md += ""
    $md += "## Foreground"
    $md += '```'
    $md += ($state.foreground -join [Environment]::NewLine)
    $md += '```'
    $md += ""
    $md += "## UI Text"
    foreach ($text in $texts) {
        $md += "- $text"
    }
    $md += ""
    $md += "## Recent Warnings / Errors"
    $md += '```'
    $md += ($warnings -join [Environment]::NewLine)
    $md += '```'
    $md | Set-Content -LiteralPath $stateMd -Encoding UTF8

    [pscustomobject]@{
        RunDir = $script:RunPath
        Screenshot = $screenLocal
        State = $stateMd
        Logcat = $logLocal
    } | Format-List
}

function Invoke-Press {
    if (-not $Action) {
        throw "press requires an action: next, previous, or select."
    }

    $keyCode = switch ($Action) {
        "next" { "131" }
        "previous" { "132" }
        "select" { "133" }
        default { throw "Unknown press action '$Action'." }
    }

    Confirm-Device | Out-Null
    $result = Invoke-Adb -Args @(
        "shell",
        "am",
        "broadcast",
        "-a",
        "com.enaboapps.switchify.debug.PERFORM_SWITCH_ACTION",
        "-p",
        $PackageName,
        "--es",
        "action",
        $Action
    ) -AllowFailure
    $event = [pscustomobject]@{
        timestamp = (Get-Date).ToString("o")
        action = $Action
        keyCode = [int]$keyCode
        transport = "adb_testing_bridge"
        exitCode = $result.ExitCode
        output = $result.Output
    }
    Add-JsonLine -Path (Join-Path $script:RunPath "events.jsonl") -Data $event
    Start-Sleep -Milliseconds $AfterPressDelayMs
    $event | Format-List
}

function Backup-RemoteFile {
    param(
        [Parameter(Mandatory = $true)] [string]$RemotePath,
        [Parameter(Mandatory = $true)] [string]$Name
    )

    $backupDir = Join-Path $script:RunPath "backup"
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    $localPath = Join-Path $backupDir $Name
    $check = Invoke-AdbShell -ShellCommand "run-as $PackageName sh -c `"test -f '$RemotePath'`"" -AllowFailure
    if ($check.ExitCode -eq 0) {
        $content = Invoke-AdbShell -ShellCommand "run-as $PackageName cat '$RemotePath'"
        $content.Output | Set-Content -LiteralPath $localPath -Encoding UTF8
        return [pscustomobject]@{ Exists = $true; LocalPath = $localPath; RemotePath = $RemotePath }
    }
    return [pscustomobject]@{ Exists = $false; LocalPath = $localPath; RemotePath = $RemotePath }
}

function Invoke-Prime {
    Confirm-Device | Out-Null
    if (-not (Test-RunAs)) {
        throw "run-as $PackageName is not available. Configure the QA profile manually in Switchify: key 131=Next, 132=Previous, 133=Select; scan mode=Manual; access technique=Item Scan."
    }

    Invoke-AdbShell -ShellCommand "mkdir -p '$RemoteDataTmp'" | Out-Null

    $switchBackup = Backup-RemoteFile -RemotePath $SwitchEventsPath -Name "switch_events.json"
    $prefsBackup = Backup-RemoteFile -RemotePath $PrefsPath -Name "switchify_preferences.xml"

    $manifest = [pscustomobject]@{
        timestamp = (Get-Date).ToString("o")
        packageName = $PackageName
        switchEvents = $switchBackup
        preferences = $prefsBackup
    }
    Write-JsonFile -Data $manifest -Path (Join-Path $script:RunPath "backup\manifest.json")

    $switchEventsJson = @'
[
  {
    "type": "external",
    "name": "QA Next",
    "code": "131",
    "press_action": { "id": 4 },
    "hold_actions": []
  },
  {
    "type": "external",
    "name": "QA Previous",
    "code": "132",
    "press_action": { "id": 5 },
    "hold_actions": []
  },
  {
    "type": "external",
    "name": "QA Select",
    "code": "133",
    "press_action": { "id": 1 },
    "hold_actions": []
  }
]
'@

    $fallbackPrefsXml = @'
<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="scan_mode">manual</string>
    <string name="access_technique">item_scan</string>
</map>
'@

    $localSwitch = Join-Path $script:RunPath "qa-switch_events.json"
    $localPrefs = Join-Path $script:RunPath "qa-switchify_preferences.xml"
    $switchEventsJson | Set-Content -LiteralPath $localSwitch -Encoding UTF8
    $qaPreferenceOverrides = @{
        "scan_mode" = "manual"
        "access_technique" = "item_scan"
    }
    if ($prefsBackup.Exists -eq $true -and (Test-Path -LiteralPath $prefsBackup.LocalPath)) {
        Copy-Item -LiteralPath $prefsBackup.LocalPath -Destination $localPrefs -Force
        foreach ($key in $qaPreferenceOverrides.Keys) {
            Set-SharedPreferenceString -XmlPath $localPrefs -Name $key -Value $qaPreferenceOverrides[$key]
        }
        $preferenceDelta = Assert-OnlyExpectedPreferenceChanges `
            -BeforePath $prefsBackup.LocalPath `
            -AfterPath $localPrefs `
            -ExpectedStringOverrides $qaPreferenceOverrides
        Write-JsonFile -Data $preferenceDelta -Path (Join-Path $script:RunPath "qa-preference-delta.json")
    } else {
        $fallbackPrefsXml | Set-Content -LiteralPath $localPrefs -Encoding UTF8
        Write-JsonFile -Data ([pscustomobject]@{
                beforeKeyCount = 0
                afterKeyCount = 2
                expectedChanges = @(
                    [pscustomobject]@{ key = "scan_mode"; before = $null; after = "manual" },
                    [pscustomobject]@{ key = "access_technique"; before = $null; after = "item_scan" }
                )
                warning = "No existing preferences file was found; generated minimal fallback preferences."
            }) -Path (Join-Path $script:RunPath "qa-preference-delta.json")
    }

    Invoke-Adb -Args @("push", $localSwitch, "$RemoteDataTmp/qa-switch_events.json") | Out-Null
    Invoke-Adb -Args @("push", $localPrefs, "$RemoteDataTmp/qa-switchify_preferences.xml") | Out-Null

    $installCmd = "mkdir -p '/data/user_de/0/$PackageName/files' '/data/user_de/0/$PackageName/shared_prefs' && cp '$RemoteDataTmp/qa-switch_events.json' '$SwitchEventsPath' && cp '$RemoteDataTmp/qa-switchify_preferences.xml' '$PrefsPath'"
    Invoke-AdbShell -ShellCommand "run-as $PackageName sh -c `"$installCmd`"" | Out-Null
    Invoke-Adb -Args @("shell", "am", "broadcast", "-a", "com.enaboapps.switchify.EVENTS_UPDATED", "-p", $PackageName) -AllowFailure | Out-Null

    [pscustomobject]@{
        RunDir = $script:RunPath
        SwitchProfile = "131=next, 132=previous, 133=select"
        ScanMode = "manual"
        AccessTechnique = "item_scan"
        Note = "If the service does not pick this up immediately, restart the Switchify accessibility service."
    } | Format-List
}

function Restore-RemoteFile {
    param(
        [Parameter(Mandatory = $true)] [object]$Item,
        [Parameter(Mandatory = $true)] [string]$RemotePath,
        [Parameter(Mandatory = $true)] [string]$RemoteName
    )

    if ($Item.Exists -eq $true -and (Test-Path -LiteralPath $Item.LocalPath)) {
        Invoke-Adb -Args @("push", $Item.LocalPath, "$RemoteDataTmp/restore-$RemoteName") | Out-Null
        Invoke-AdbShell -ShellCommand "run-as $PackageName sh -c `"cp '$RemoteDataTmp/restore-$RemoteName' '$RemotePath'`"" | Out-Null
        return "restored"
    }

    Invoke-AdbShell -ShellCommand "run-as $PackageName sh -c `"rm -f '$RemotePath'`"" -AllowFailure | Out-Null
    return "removed"
}

function Invoke-Restore {
    Confirm-Device | Out-Null
    $manifestPath = Join-Path $script:RunPath "backup\manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath)) {
        Write-Output "No backup manifest found in $script:RunPath; nothing to restore."
        return
    }
    if (-not (Test-RunAs)) {
        throw "run-as $PackageName is not available, cannot restore app-data backup automatically."
    }

    Invoke-AdbShell -ShellCommand "mkdir -p '$RemoteDataTmp'" | Out-Null
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $switchStatus = Restore-RemoteFile -Item $manifest.switchEvents -RemotePath $SwitchEventsPath -RemoteName "switch_events.json"
    $prefsStatus = Restore-RemoteFile -Item $manifest.preferences -RemotePath $PrefsPath -RemoteName "switchify_preferences.xml"
    Invoke-Adb -Args @("shell", "am", "broadcast", "-a", "com.enaboapps.switchify.EVENTS_UPDATED", "-p", $PackageName) -AllowFailure | Out-Null

    [pscustomobject]@{
        SwitchEvents = $switchStatus
        Preferences = $prefsStatus
        Note = "If the service still shows QA state, restart the Switchify accessibility service."
    } | Format-List
}

function Invoke-Report {
    $reportPath = Join-Path $script:RunPath "report.md"
    $eventsPath = Join-Path $script:RunPath "events.jsonl"
    $statePath = Join-Path $script:RunPath "state.json"
    $logPath = Join-Path $script:RunPath "logcat.txt"
    $doctorPath = Join-Path $script:RunPath "doctor.json"

    $events = @()
    if (Test-Path -LiteralPath $eventsPath) {
        $events = @(Get-Content -LiteralPath $eventsPath | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
    }
    $state = $null
    if (Test-Path -LiteralPath $statePath) {
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    }
    $doctor = $null
    if (Test-Path -LiteralPath $doctorPath) {
        $doctor = Get-Content -LiteralPath $doctorPath -Raw | ConvertFrom-Json
    }
    $logFindings = @()
    if (Test-Path -LiteralPath $logPath) {
        $logFindings = @(Get-Content -LiteralPath $logPath | Where-Object {
            $_ -match "FATAL EXCEPTION|ANR|AndroidRuntime| E |Exception|Error"
        } | Select-Object -Last 100)
    }

    $lines = @()
    $lines += "# Switchify Manual Scan QA Report"
    $lines += ""
    $lines += "- Run directory: $script:RunPath"
    $lines += "- Generated: $((Get-Date).ToString("o"))"
    $lines += "- Events sent: $($events.Count)"
    if ($doctor) {
        $lines += "- Device: $($doctor.device.Id)"
        $lines += "- Package installed: $($doctor.packageInstalled)"
        $lines += "- Accessibility enabled at doctor: $($doctor.accessibilityServiceEnabled)"
        $lines += "- run-as available: $($doctor.runAsWorks)"
    }
    if ($state) {
        $lines += "- Last screenshot: $($state.screenshot)"
        $lines += "- Last UI XML: $($state.windowXml)"
        $lines += "- Accessibility enabled at last capture: $($state.accessibilityServiceEnabled)"
    }
    $lines += ""
    $lines += "## Event Timeline"
    if ($events.Count -eq 0) {
        $lines += "No switch events were recorded."
    } else {
        foreach ($event in $events) {
            $lines += "- $($event.timestamp): $($event.action) / keyCode $($event.keyCode) / exit $($event.exitCode)"
        }
    }
    $lines += ""
    $lines += "## Suspected Issues From Logs"
    if ($logFindings.Count -eq 0) {
        $lines += "No fatal, ANR, or obvious error lines were found in the latest captured logcat sample."
    } else {
        $lines += '```'
        $lines += ($logFindings -join [Environment]::NewLine)
        $lines += '```'
    }
    $lines += ""
    $lines += "## Artifacts"
    Get-ChildItem -LiteralPath $script:RunPath -File -ErrorAction SilentlyContinue | ForEach-Object {
        $lines += "- $($_.FullName)"
    }
    $lines | Set-Content -LiteralPath $reportPath -Encoding UTF8

    [pscustomobject]@{
        Report = $reportPath
        Events = $events.Count
        LogFindings = $logFindings.Count
    } | Format-List
}

switch ($Command) {
    "doctor" { Invoke-Doctor }
    "prime" { Invoke-Prime }
    "capture" { Invoke-Capture }
    "press" { Invoke-Press }
    "restore" { Invoke-Restore }
    "report" { Invoke-Report }
}
