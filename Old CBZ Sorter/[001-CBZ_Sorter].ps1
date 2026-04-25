Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ============================================================================
# CBZ SORTER v4.1 - PLAYLIST DISPLAY + SESSION LOGGING
# Major changes from v4.0:
# 1. Added 7-line playlist display showing ±3 files around current position
# 2. Playlist is clickable - jump to any file by clicking it
# 3. Current file shown with >>> and bold formatting
# 4. Session logging on Quit - saves to [004-CBZ_Sorter_SESSIONLOG].txt
# 5. Form height increased to accommodate playlist display
#
# Previous v4.0 changes:
# 1. Fixed file skipping bug (index not adjusted after file removal)
# 2. Fixed double advancement when Skip Viewed is enabled
# 3. Added processing guard to prevent rapid keypress double-firing
# 4. Centralized navigation logic (Advance-ToNextFile, Remove-AndAdjustIndex)
# 5. Added [X/Y] index position logging for easy verification
# 6. Added empty list guard (graceful "No more files" message)
# 7. Reduced AHK sleep from 200ms to 50ms (PS1 has its own guard now)
# ============================================================================

# Enable long paths support (Windows 10+ feature)
try {
    $regPath = "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem"
    $regKey = Get-ItemProperty -Path $regPath -Name "LongPathsEnabled" -ErrorAction SilentlyContinue
    if ($null -eq $regKey -or $regKey.LongPathsEnabled -ne 1) {
        Write-Warning "Long paths not enabled. Some files may fail to open. To fix:"
        Write-Warning "1. Run: New-ItemProperty -Path '$regPath' -Name 'LongPathsEnabled' -Value 1 -PropertyType DWORD -Force"
        Write-Warning "2. Restart your computer"
    }
} catch {
    Write-Warning "Could not check long paths setting: $_"
}

$folder = Split-Path -Parent $MyInvocation.MyCommand.Path
$keepFolder = Join-Path $folder "[00-Keep]"
$translateFolder = Join-Path $folder "[To Be Translated OG]"
$fixFolder = Join-Path $folder "[Needs Fixing]"
$inquireFolder = Join-Path $keepFolder "[00-Inquire]"
$unreadableFolder = Join-Path $folder "[File Name Too Long]"

# Ensure all folders exist
@($keepFolder, $translateFolder, $fixFolder, $inquireFolder, $unreadableFolder) | ForEach-Object {
    try {
        if (-not (Test-Path $_)) { 
            New-Item -ItemType Directory -Path $_ -ErrorAction Stop | Out-Null
        }
    } catch {
        # Folder exists or couldn't be created - proceed anyway
    }
}

# ============================================================================
# SCRIPT-SCOPE VARIABLES
# ============================================================================
[System.Collections.ArrayList]$script:cbzFiles = @(Get-ChildItem -LiteralPath $folder -File | Where-Object { $_.Extension -ieq ".cbz" } | Sort-Object Name)

[System.Collections.ArrayList]$script:viewedThisSession = [System.Collections.ArrayList]@()

$script:currentIndex = -1
$script:lastFile = $null
$script:sessionStartTime = Get-Date
$script:isProcessing = $false

# Stats counters (single hashtable)
$script:stats = @{
    Opened = 0; Skipped = 0; Unreadable = 0; Kept = 0
    Purged = 0; Fixed = 0; Translated = 0; Inquired = 0
}

# UI Elements
$logWindow = New-Object System.Windows.Forms.RichTextBox
$playlistDisplay = $null
$currentFile = $null
$folderPathLabel = $null
$statsLabel = $null
$speedModeToggle = $null
$skipViewedToggle = $null
$timerUpdateTimer = $null

# ============================================================================
# FUNCTION: Move-FileWithRetry
# Attempts to move file with adaptive retry logic
# ============================================================================
function Move-FileWithRetry {
    param(
        $sourceFile,
        $destination,
        [bool]$speedMode = $false,
        [bool]$forceReplace = $false
    )
    
    # Stop CDisplayEx FIRST
    Stop-Process -Name "CDisplayEx" -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 200  # Give it time to release file handle
    
    if ($speedMode) {
        $maxRetries = 1
        $delayMs = 0
    } else {
        $maxRetries = 3
        $delayMs = 100
    }
    
    $retryCount = 0
    
    # If destination file exists and we're not forcing replace, move to dupe folder
    if ((Test-Path -LiteralPath $destination) -and -not $forceReplace) {
        $dupeFolder = Split-Path -Parent $destination
        $fileName = Split-Path -Leaf $destination
        
        # Determine dupe folder name based on parent
        $parentName = Split-Path -Leaf $dupeFolder
        $dupeFolderName = switch ($parentName) {
            "[00-Keep]" { "[Keep Dupes]" }
            "[To Be Translated OG]" { "[To Be TL Dupes]" }
            "[Needs Fixing]" { "[Fix Dupes]" }
            default { "[Dupes]" }
        }
        
        $dupePath = Join-Path $dupeFolder $dupeFolderName
        
        # Create dupe folder if needed
        if (-not (Test-Path $dupePath)) {
            New-Item -ItemType Directory -Path $dupePath -ErrorAction SilentlyContinue | Out-Null
        }
        
        $destination = Join-Path $dupePath $fileName
    }
    
    while ($retryCount -lt $maxRetries) {
        try {
            Move-Item -LiteralPath $sourceFile -Destination $destination -Force -ErrorAction Stop
            return @{ success = $true; destination = $destination }
        } catch {
            if ($retryCount -lt ($maxRetries - 1)) {
                Start-Sleep -Milliseconds $delayMs
                $retryCount++
            } else {
                throw $_
            }
        }
    }
    
    return @{ success = $false; destination = $null }
}

# ============================================================================
# FUNCTION: Delete-FileWithRetry
# Attempts to delete file with adaptive retry logic
# ============================================================================
function Delete-FileWithRetry {
    param(
        $filePath,
        [bool]$speedMode = $false
    )
    
    # Stop CDisplayEx FIRST
    Stop-Process -Name "CDisplayEx" -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 200  # Give it time to release file handle
    
    if ($speedMode) {
        $maxRetries = 1
        $delayMs = 0
    } else {
        $maxRetries = 3
        $delayMs = 100
    }
    
    $retryCount = 0
    
    while ($retryCount -lt $maxRetries) {
        try {
            Add-Type -AssemblyName Microsoft.VisualBasic
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($filePath, 'OnlyErrorDialogs', 'SendToRecycleBin')
            return $true  # Success
        } catch {
            if ($retryCount -lt ($maxRetries - 1)) {
                Start-Sleep -Milliseconds $delayMs
                $retryCount++
            } else {
                throw $_
            }
        }
    }
    
    return $false
}

# ============================================================================
# FUNCTION: Open-File
# Opens a CBZ file in CDisplayEx and updates state
# ============================================================================
function Open-File {
    param($file, [string]$reason = "Opened")
    
    if ($file -eq $null) { 
        Log-Event "❌ ERROR: No file to open."
        return 
    }
    
    # Verify file still exists before opening
    if (-not (Test-Path -LiteralPath $file.FullName)) {
        Log-Event "❌ ERROR: File no longer exists - $($file.Name)"
        return
    }
    
    # Stop any running CDisplayEx instance
    Stop-Process -Name "CDisplayEx" -ErrorAction SilentlyContinue
    
    # Launch file
    try {
        Start-Process -FilePath $file.FullName -ErrorAction Stop
    } catch {
        Log-Event "❌ ERROR: Failed to open $($file.Name) - $_"
        return
    }
    
    # Update last file and current index
    $script:lastFile = $file
    $script:currentIndex = $script:cbzFiles.IndexOf($file)

    # Update display with folder path and file name
    $folderPathLabel.Text = $folder
    $currentFile.Text = $file.Name
    $pos = $script:currentIndex + 1
    $total = $script:cbzFiles.Count
    Log-Event "[$pos/$total] ➡️  ${reason}: $($file.Name)"

    # INCREMENT OPENED COUNTER FOR EVERY OPEN (regardless of prior viewing)
    $script:stats.Opened++
    Update-Stats

    # Update viewed list
    if ($file.FullName -notin $script:viewedThisSession) {
        [void]$script:viewedThisSession.Add($file.FullName)
    }

    # Update playlist display
    Update-PlaylistDisplay
}

# ============================================================================
# FUNCTION: Log-Event
# Logs colored messages to the log window
# ============================================================================
function Log-Event {
    param($message)
    
    if ($message -match "^✅\s+Kept") {
        $logWindow.SelectionFont = New-Object System.Drawing.Font($logWindow.Font, [System.Drawing.FontStyle]::Bold)
        $logWindow.SelectionColor = [System.Drawing.Color]::ForestGreen
    } 
    elseif ($message -match "^❌\s+Purged") {
        $logWindow.SelectionFont = New-Object System.Drawing.Font($logWindow.Font, [System.Drawing.FontStyle]::Bold)
        $logWindow.SelectionColor = [System.Drawing.Color]::Red
    }
    elseif ($message -match "^📖\s+To TL") {
        $logWindow.SelectionFont = New-Object System.Drawing.Font($logWindow.Font, [System.Drawing.FontStyle]::Bold)
        $logWindow.SelectionColor = [System.Drawing.Color]::DarkBlue
    }
    elseif ($message -match "^🔧\s+To Fix") {
        $logWindow.SelectionFont = New-Object System.Drawing.Font($logWindow.Font, [System.Drawing.FontStyle]::Bold)
        $logWindow.SelectionColor = [System.Drawing.Color]::Orange
    }
    elseif ($message -match "^❓\s+Inquire") {
        $logWindow.SelectionFont = New-Object System.Drawing.Font($logWindow.Font, [System.Drawing.FontStyle]::Bold)
        $logWindow.SelectionColor = [System.Drawing.Color]::DarkMagenta
    }
    elseif ($message -match "^⚠️\s+Unreadable") {
        $logWindow.SelectionFont = New-Object System.Drawing.Font($logWindow.Font, [System.Drawing.FontStyle]::Bold)
        $logWindow.SelectionColor = [System.Drawing.Color]::DarkRed
    }
    else {
        $logWindow.SelectionFont = $logWindow.Font
        $logWindow.SelectionColor = $logWindow.ForeColor
    }
    
    $logWindow.AppendText("$message `r`n")
    $logWindow.ScrollToCaret()
}

# ============================================================================
# FUNCTION: Update-Stats
# Updates the stats display
# ============================================================================
function Update-Stats {
    $elapsed = (Get-Date) - $script:sessionStartTime
    $sessionTime = "$($elapsed.Hours.ToString('00')):$($elapsed.Minutes.ToString('00')):$($elapsed.Seconds.ToString('00'))"
    $statsLabel.Text = "⏱️  $sessionTime | 📊 Opened: $($script:stats.Opened) | ⏭️  Skipped: $($script:stats.Skipped) | ⚠️  Unreadable: $($script:stats.Unreadable) | ✅ Kept: $($script:stats.Kept) | 🔧 To Fix: $($script:stats.Fixed) | 📖 To TL: $($script:stats.Translated) | ❌ Purged: $($script:stats.Purged) | 🕐 $(Get-Date -Format 'HH:mm')"
}

# ============================================================================
# FUNCTION: Update-PlaylistDisplay
# Updates the 7-line playlist showing ±3 files around current position
# ============================================================================
function Update-PlaylistDisplay {
    if ($null -eq $playlistDisplay) { return }

    $playlistDisplay.Clear()

    if ($script:cbzFiles.Count -eq 0) {
        $playlistDisplay.AppendText("No CBZ files in playlist")
        return
    }

    # Calculate range: ±3 files around current index
    $startIndex = [Math]::Max(0, $script:currentIndex - 3)
    $endIndex = [Math]::Min($script:cbzFiles.Count - 1, $script:currentIndex + 3)

    # Display up to 7 files
    for ($i = $startIndex; $i -le $endIndex; $i++) {
        $file = $script:cbzFiles[$i]
        $fileName = $file.Name

        if ($i -eq $script:currentIndex) {
            # Current file - bold, blue text, green background
            $playlistDisplay.SelectionFont = New-Object System.Drawing.Font($playlistDisplay.Font, [System.Drawing.FontStyle]::Bold)
            $playlistDisplay.SelectionColor = [System.Drawing.Color]::DarkBlue
            $playlistDisplay.SelectionBackColor = [System.Drawing.Color]::LightGreen
            $playlistDisplay.AppendText(">>> $fileName")
        } else {
            # Other files - normal style
            $playlistDisplay.SelectionFont = $playlistDisplay.Font
            $playlistDisplay.SelectionColor = $playlistDisplay.ForeColor
            $playlistDisplay.SelectionBackColor = $playlistDisplay.BackColor
            $playlistDisplay.AppendText("    $fileName")
        }

        $playlistDisplay.AppendText("`r`n")
    }

    # Reset selection to avoid unwanted highlighting
    $playlistDisplay.Select(0, 0)
}

# ============================================================================
# FUNCTION: Get-NextFile
# Returns the next file based on shuffle mode
# ============================================================================
function Get-NextFile {
    if ($script:cbzFiles.Count -eq 0) { return $null }

    if ($shuffle.Checked) {
        return Get-Random -InputObject $script:cbzFiles
    }
    else {
        $nextIndex = $script:currentIndex + 1

        if ($nextIndex -ge $script:cbzFiles.Count) {
            $nextIndex = 0
        }

        $script:currentIndex = $nextIndex
        return $script:cbzFiles[$nextIndex]
    }
}

# ============================================================================
# FUNCTION: Get-FirstFile
# Returns the first file to load on startup
# ============================================================================
function Get-FirstFile {
    if ($shuffle.Checked) {
        return Get-Random -InputObject $script:cbzFiles
    } 
    else {
        $script:currentIndex = 0
        return $script:cbzFiles[0]
    }
}

# ============================================================================
# FUNCTION: Get-PreviousFile
# Returns the previous file in folder order (linear backwards)
# ============================================================================
function Get-PreviousFile {
    if ($script:currentIndex -le 0) {
        $script:currentIndex = $script:cbzFiles.Count - 1
    } else {
        $script:currentIndex--
    }
    
    return $script:cbzFiles[$script:currentIndex]
}

# ============================================================================
# FUNCTION: Get-UnviewedFile
# Finds next unviewed file
# ============================================================================
function Get-UnviewedFile {
    param([System.Collections.ArrayList]$skipList)
    
    if ($shuffle.Checked) {
        $unviewed = $script:cbzFiles | Where-Object { $_.FullName -notin $skipList }
        if ($unviewed.Count -gt 0) {
            return Get-Random -InputObject $unviewed
        }
        return $null
    }
    else {
        $maxAttempts = $script:cbzFiles.Count
        $attempts = 0
        $nextFile = Get-NextFile
        
        while ($nextFile.FullName -in $skipList -and $attempts -lt $maxAttempts) {
            $nextFile = Get-NextFile
            $attempts++
        }
        
        if ($attempts -ge $maxAttempts) {
            return $null
        }
        
        return $nextFile
    }
}

# ============================================================================
# FUNCTION: Reset-ViewedList
# Resets viewed list when all files viewed
# ============================================================================
function Reset-ViewedList {
    $script:viewedThisSession.Clear()
    Log-Event "🔄 All files viewed! Resetting viewed list..."
}

# ============================================================================
# FUNCTION: Remove-AndAdjustIndex
# Removes a file from the list and adjusts currentIndex to prevent skipping
# ============================================================================
function Remove-AndAdjustIndex {
    param($file)
    $removedIndex = $script:cbzFiles.IndexOf($file)
    $script:cbzFiles.Remove($file)
    # After removal, elements shift down. Set index to one BEFORE the removed
    # position so that Get-NextFile's +1 lands on the element that slid into place.
    if ($removedIndex -ge 0) {
        $script:currentIndex = $removedIndex - 1
    }
}

# ============================================================================
# FUNCTION: Advance-ToNextFile
# Centralized navigation — gets next file respecting Skip Viewed, opens it
# ============================================================================
function Advance-ToNextFile {
    if ($script:cbzFiles.Count -eq 0) {
        Log-Event "📭 No more CBZ files remaining."
        $currentFile.Text = "No more files."
        return
    }

    if ($skipViewedToggle.Checked) {
        $next = Get-UnviewedFile $script:viewedThisSession
        if ($null -eq $next) {
            Reset-ViewedList
            $next = Get-NextFile
        }
    } else {
        $next = Get-NextFile
    }

    if ($null -ne $next) {
        Open-File $next
    } else {
        Log-Event "📭 No more CBZ files remaining."
        $currentFile.Text = "No more files."
    }
}

# ============================================================================
# FUNCTION: Refresh-FileList
# Reloads CBZ files from folder
# ============================================================================
function Refresh-FileList {
    $script:cbzFiles.Clear()
    @(Get-ChildItem -LiteralPath $folder -File | Where-Object { $_.Extension -ieq ".cbz" } | Sort-Object Name) | ForEach-Object {
        [void]$script:cbzFiles.Add($_)
    }

    $script:currentIndex = -1
    Log-Event "🔄 File list refreshed - Found $($script:cbzFiles.Count) CBZ files"
    Update-PlaylistDisplay
}

# ============================================================================
# FUNCTION: Save-SessionLog
# Saves session statistics to log file on quit
# ============================================================================
function Save-SessionLog {
    $logFilePath = Join-Path $folder "[004-CBZ_Sorter_SESSIONLOG].txt"

    $sessionEndTime = Get-Date
    $elapsed = $sessionEndTime - $script:sessionStartTime

    $logEntry = @"

[$($script:sessionStartTime.ToString('yyyy-MM-dd'))]
Time: $($script:sessionStartTime.ToString('HH:mm:ss')) - $($sessionEndTime.ToString('HH:mm:ss'))
Duration: $($elapsed.Hours.ToString('00')):$($elapsed.Minutes.ToString('00')):$($elapsed.Seconds.ToString('00'))
Keep: $($script:stats.Kept) | Purged: $($script:stats.Purged) | Opened: $($script:stats.Opened) | Skipped: $($script:stats.Skipped)
Fix: $($script:stats.Fixed) | Translate: $($script:stats.Translated) | Inquire: $($script:stats.Inquired) | Unreadable: $($script:stats.Unreadable)

"@

    try {
        Add-Content -LiteralPath $logFilePath -Value $logEntry -ErrorAction Stop
        Log-Event "💾 Session log saved to $logFilePath"
    } catch {
        Log-Event "❌ ERROR: Failed to save session log - $_"
    }
}

# ============================================================================
# FUNCTION: Invoke-SortAction
# Centralized handler for all sort/move/delete button actions
# ============================================================================
function Invoke-SortAction {
    param(
        [string]$ActionName,       # Display name: "Kept", "To Fix", "To TL", etc.
        [string]$LogEmoji,         # Emoji prefix: "✅", "🔧", "📖", etc.
        [string]$DestFolder,       # Target folder path (ignored if IsPurge)
        [string]$DupePattern,      # Wildcard to detect dupe redirect, e.g. "*[Keep Dupes]*"
        [string]$StatName,         # Key in $script:stats to increment
        [bool]$ForceReplace,       # true = overwrite destination (Inquire/Unreadable)
        [bool]$IsPurge = $false,   # true = delete to Recycle Bin instead of move
        [bool]$AlsoCountKept = $false  # true = also increment Kept counter (for Inquire)
    )

    if ($script:isProcessing) { return }
    if (-not $script:lastFile) { return }

    $script:isProcessing = $true
    try {
        $speedMode = $speedModeToggle.Checked

        if ($IsPurge) {
            Delete-FileWithRetry $script:lastFile.FullName $speedMode
            Log-Event "$LogEmoji  ${ActionName}: $($script:lastFile.Name)"
        } else {
            $destination = Join-Path $DestFolder $script:lastFile.Name
            $result = Move-FileWithRetry $script:lastFile.FullName $destination $speedMode $ForceReplace

            if (-not $result.success) { return }

            $dupeIndicator = ""
            if ($DupePattern -and $result.destination -like $DupePattern) {
                $dupeIndicator = " (DUPE)"
            }
            Log-Event "$LogEmoji  ${ActionName}: $($script:lastFile.Name)$dupeIndicator"
        }

        $script:stats[$StatName]++
        if ($AlsoCountKept) { $script:stats.Kept++ }
        Update-Stats

        Remove-AndAdjustIndex $script:lastFile
        Advance-ToNextFile
    } catch {
        Log-Event "❌ ERROR: Failed to process ($ActionName) - $_"
    } finally {
        $script:isProcessing = $false
    }
}

# ============================================================================
# FORM CREATION
# ============================================================================
$form = New-Object System.Windows.Forms.Form
$form.Text = "CBZ Sorter v4.1"
$form.Size = New-Object System.Drawing.Size(750, 720)
$form.MinimumSize = New-Object System.Drawing.Size(750, 720)
$form.StartPosition = "CenterScreen"
$form.KeyPreview = $true
$form.Font = New-Object System.Drawing.Font("Segoe UI", 12)

# Folder path label
$folderPathLabel = New-Object System.Windows.Forms.Label
$folderPathLabel.Location = New-Object System.Drawing.Point(20, 15)
$folderPathLabel.Size = New-Object System.Drawing.Size(700, 20)
$folderPathLabel.Text = $folder
$folderPathLabel.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Regular)
$folderPathLabel.ForeColor = [System.Drawing.Color]::Gray
$form.Controls.Add($folderPathLabel)

# Current file label (EXPANDED - 3 lines capability)
$currentFile = New-Object System.Windows.Forms.Label
$currentFile.Location = New-Object System.Drawing.Point(20, 35)
$currentFile.Size = New-Object System.Drawing.Size(700, 65)
$currentFile.Text = "Click Next to begin."
$currentFile.Font = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Regular)
$currentFile.AutoSize = $false
$currentFile.MaximumSize = New-Object System.Drawing.Size(700, 65)
$form.Controls.Add($currentFile)

# Shuffle checkbox
$shuffle = New-Object System.Windows.Forms.CheckBox
$shuffle.Location = New-Object System.Drawing.Point(20, 105)
$shuffle.Text = "Shuffle CBZ Playlist (Ctrl+S)"
$shuffle.AutoSize = $true
$form.Controls.Add($shuffle)

# Skip viewed checkbox (default OFF)
$skipViewedToggle = New-Object System.Windows.Forms.CheckBox
$skipViewedToggle.Location = New-Object System.Drawing.Point(280, 105)
$skipViewedToggle.Text = "Skip Already Viewed (Ctrl+V)"
$skipViewedToggle.Checked = $false
$skipViewedToggle.AutoSize = $true
$form.Controls.Add($skipViewedToggle)

# Speed mode toggle
$speedModeToggle = New-Object System.Windows.Forms.CheckBox
$speedModeToggle.Location = New-Object System.Drawing.Point(560, 105)
$speedModeToggle.Text = "⚡ Speed Mode"
$speedModeToggle.Checked = $true
$speedModeToggle.AutoSize = $true
$speedModeToggle.Add_CheckedChanged({
    if ($speedModeToggle.Checked) {
        Log-Event "⚡ Speed Mode ON - Instant operations"
    } else {
        Log-Event "🛡️ Reliability Mode ON - Safe with retries"
    }
})
$form.Controls.Add($speedModeToggle)

# ============================================================================
# HELPER FUNCTION: Add-Button
# ============================================================================
function Add-Button {
    param($text, $x, $y, $callback, $color, [bool]$enabled = $true, [float]$fontSizeMultiplier = 1.0)
    $btn = New-Object System.Windows.Forms.Button
    $btn.Text = $text
    $btn.Size = New-Object System.Drawing.Size(90, 30)
    $btn.Location = New-Object System.Drawing.Point($x, $y)
    $btn.Enabled = $enabled
    
    # Apply font size multiplier
    if ($fontSizeMultiplier -ne 1.0) {
        $btn.Font = New-Object System.Drawing.Font("Segoe UI", 12 * $fontSizeMultiplier)
    }
    
    if ($color) { $btn.BackColor = $color }
    if ($enabled) { $btn.Add_Click($callback) }
    $form.Controls.Add($btn)
    return $btn
}

# ============================================================================
# BUTTON DEFINITIONS - ROW 1: Random | To Fix | Translate | Inquire | Help
# ============================================================================

$btnRandom = Add-Button "(R)andom" 20 145 {
    $randomFile = Get-Random -InputObject $script:cbzFiles
    Open-File $randomFile "Random Pick"
} ([System.Drawing.Color]::LightYellow)

$btnFix = Add-Button "To (F)ix" 120 145 {
    Invoke-SortAction "To Fix" "🔧" $fixFolder "*[Fix Dupes]*" "Fixed" $false
} ([System.Drawing.Color]::Khaki)

$btnTranslate = Add-Button "(T)ranslate" 220 145 {
    Invoke-SortAction "To TL" "📖" $translateFolder "*[To Be TL Dupes]*" "Translated" $false
} ([System.Drawing.Color]::LightSkyBlue)

$btnInquire = Add-Button "(I)nquire" 320 145 {
    Invoke-SortAction "Inquire" "❓" $inquireFolder "" "Inquired" $true -AlsoCountKept $true
} ([System.Drawing.Color]::Plum)

$btnHelp = Add-Button "Help" 420 145 {
    $msg = @"
Made and Debugged by SHIONEKO
Last Update: 2026-02-10 (v4.1 - Playlist Display + Session Logging)
Dependencies: CDisplayEX as default CBZ Viewer

BUTTONS & SHORTCUTS:
  R       = (R)andom
  F       = To (F)ix → [Needs Fixing]
  T       = (T)ranslate → [To Be Translated OG]
  I       = (I)nquire → [00-Keep]/[00-Inquire]
  K       = (K)eep → [00-Keep]
  P       = (P)urge → Recycle Bin
  N       = (N)ext (Skip)
  B       = (B)ack (Previous)
  U       = (U)nrdbl → [File Name Too Long]
  C       = (C)lear Logs
  Refresh = Reload files + reset timers/counters
  Q       = (Q)uit
  Ctrl+S  = Toggle Shuffle
  Ctrl+V  = Toggle Skip Viewed
  Ctrl+R  = Refresh File List
  Ctrl+F5 = Refresh File List (Alternative)

LAYOUT:
Row 1: Random | To Fix | Translate | Inquire | Help
Row 2: Purge | Keep | Next | Back | Clear Logs
Row 3: Unreadable | Refresh | [Reserved] | Quit

FEATURES:
  ⚡ Speed Mode: Instant operations (default ON)
  🛡️  Reliability Mode: Safe with retries

  📂 Folder path displayed at top
  📄 CBZ title shown below path (3-line display)

  🎵 Playlist Display (7 lines):
  • Shows ±3 files around current position
  • Current file marked with >>> and BOLD
  • Click any filename to jump to it
  • Always based on sorted order (even in shuffle)

  ⏱️  Session timer tracks elapsed time (HH:MM:SS)
  🕐 24-hour clock display

  📊 Counters:
  • Opened: ALL files opened (counts repeats)
  • Skipped: Files skipped
  • Unreadable: Files with long names
  • Kept: Files to keep (includes Inquire)
  • To Fix: Files needing fixing
  • To TL: Files to translate
  • Purged: Files deleted

  💾 Session Logging (on Quit):
  • Saves to [004-CBZ_Sorter_SESSIONLOG].txt
  • Logs date, time range, duration, and all stats

  📍 Log shows [X/Y] position (e.g. [3/97])
     to verify no files are skipped

COLOR CODING:
  🟨 Random = Light Yellow
  🟧 To Fix = Khaki
  🟦 Translate = Light Sky Blue
  🟪 Inquire = Plum
  🟥 Purge = Tomato
  🟩 Keep = Light Green
  🟣 Next = Medium Purple
  🟨 Back = Wheat
  🟦 Clear Logs = Light Cyan
  🟥 Unreadable = Light Coral
  🟨 Refresh = Light Goldenrod Yellow
  🟥 Quit = Misty Rose

DUPE HANDLING:
  • [00-Keep] → [Keep Dupes]
  • [To Be Translated OG] → [To Be TL Dupes]
  • [Needs Fixing] → [Fix Dupes]
  • [00-Inquire] → Force replace
  • [File Name Too Long] → Force replace

v4.1 Updates (2026-02-10):
  ✓ NEW: 7-line playlist display (±3 files around current)
  ✓ NEW: Clickable playlist - jump to any file
  ✓ NEW: Session logging on Quit
  ✓ Current file shows >>> and bold formatting
  ✓ Form height increased to 720px

v4.0 Updates:
  ✓ Fixed file skipping bug after Keep/Purge/Fix/etc
  ✓ Fixed double-skip when Skip Viewed is enabled
  ✓ Added rapid keypress guard (no more double-firing)
  ✓ Added [X/Y] position tracking in log
  ✓ Graceful "No more files" when list is empty
  ✓ Faster AHK response (50ms vs 200ms)

  /\_/\     /\_/\     /\_/\
 ( o.o )   ( -.- )   ( ^.^ )

Keep sorting, nyaa!! 🐾
"@
    [System.Windows.Forms.MessageBox]::Show($msg, "CBZ Sorter Help")
}

# ============================================================================
# BUTTON DEFINITIONS - ROW 2: Purge | Keep | Next | Back | Clear Logs
# ============================================================================

$btnPurge = Add-Button "(P)urge" 20 185 {
    Invoke-SortAction "Purged" "❌" "" "" "Purged" $false -IsPurge $true
} ([System.Drawing.Color]::Tomato)

$btnKeep = Add-Button "(K)eep" 120 185 {
    Invoke-SortAction "Kept" "✅" $keepFolder "*[Keep Dupes]*" "Kept" $false
} ([System.Drawing.Color]::LightGreen)

$btnNext = Add-Button "(N)ext" 220 185 {
    if ($script:isProcessing) { return }
    $script:isProcessing = $true
    try {
        Stop-Process -Name "CDisplayEx" -ErrorAction SilentlyContinue

        if ($script:lastFile) {
            Log-Event "➡️  Skipped: $($script:lastFile.Name)"
            $script:stats.Skipped++
            Update-Stats
        }

        Advance-ToNextFile
    } finally {
        $script:isProcessing = $false
    }
} ([System.Drawing.Color]::MediumPurple)

$btnBack = Add-Button "(B)ack" 320 185 {
    Stop-Process -Name "CDisplayEx" -ErrorAction SilentlyContinue
    
    $prevFile = Get-PreviousFile
    Open-File $prevFile "Previous"
} ([System.Drawing.Color]::Wheat)

$btnClear = Add-Button "Clear Logs" 420 185 { 
    $logWindow.Clear() 
} ([System.Drawing.Color]::LightCyan)

# ============================================================================
# BUTTON DEFINITIONS - ROW 3: Unreadable | Refresh | Placeholder 2 | Quit
# ============================================================================

$btnUnreadable = Add-Button "(U)nrdbl" 20 225 {
    Invoke-SortAction "Unreadable" "⚠️" $unreadableFolder "" "Unreadable" $true
} ([System.Drawing.Color]::LightCoral)

$btnRefresh = Add-Button "Refresh" 120 225 {
    # Reset timer
    $script:sessionStartTime = Get-Date

    # Reset counters
    foreach ($key in @($script:stats.Keys)) { $script:stats[$key] = 0 }

    # Refresh file list
    Refresh-FileList

    # Clear logs
    $logWindow.Clear()

    # Reset viewed list
    $script:viewedThisSession.Clear()

    Log-Event "🔄 Refresh: All counters reset, timer reset, file list reloaded"
    Update-Stats
} ([System.Drawing.Color]::LightGoldenrodYellow)

$btnPlaceholder2 = Add-Button "[Reserved]" 220 225 { } $null $false
$btnPlaceholder2.BackColor = [System.Drawing.Color]::LightGray
$btnPlaceholder2.Text = "[Reserved]"

$btnQuit = Add-Button "(Q)uit" 320 225 {
    Stop-Process -Name "CDisplayEx" -ErrorAction SilentlyContinue

    # Save session log before quitting
    Save-SessionLog

    [System.Windows.Forms.SendKeys]::SendWait("^+q")
    $form.Close()
    Start-Sleep -Milliseconds 100
    [System.Environment]::Exit(0)
} ([System.Drawing.Color]::MistyRose)

# ============================================================================
# PLAYLIST DISPLAY SETUP (7-line clickable playlist)
# ============================================================================
$playlistDisplay = New-Object System.Windows.Forms.RichTextBox
$playlistDisplay.Multiline = $true
$playlistDisplay.ScrollBars = "None"
$playlistDisplay.ReadOnly = $true
$playlistDisplay.WordWrap = $false
$playlistDisplay.Location = New-Object System.Drawing.Point(20, 265)
$playlistDisplay.Size = New-Object System.Drawing.Size(710, 120)
$playlistDisplay.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$playlistDisplay.BackColor = [System.Drawing.Color]::White
$playlistDisplay.BorderStyle = "Fixed3D"
$playlistDisplay.Cursor = [System.Windows.Forms.Cursors]::Arrow

# Track hover state
$script:lastHoveredLine = -1

# Add mouse move handler for hover effect
$playlistDisplay.Add_MouseMove({
    param($sender, $e)

    $charIndex = $playlistDisplay.GetCharIndexFromPosition($e.Location)
    $lineIndex = $playlistDisplay.GetLineFromCharIndex($charIndex)
    $lineCount = $playlistDisplay.Lines.Count

    if ($lineIndex -ne $script:lastHoveredLine -and $lineIndex -ge 0 -and $lineIndex -lt $lineCount) {
        $prevLine = $script:lastHoveredLine
        $script:lastHoveredLine = $lineIndex

        # Calculate which display line corresponds to the current file
        $startFileIndex = [Math]::Max(0, $script:currentIndex - 3)
        $currentDisplayLine = $script:currentIndex - $startFileIndex

        # Helper: select an entire line's text range for background color change
        # Reset previous hovered line to its default background
        if ($prevLine -ge 0 -and $prevLine -lt $lineCount) {
            $prevStart = $playlistDisplay.GetFirstCharIndexFromLine($prevLine)
            $prevEnd = if ($prevLine -lt $lineCount - 1) { $playlistDisplay.GetFirstCharIndexFromLine($prevLine + 1) } else { $playlistDisplay.TextLength }
            $playlistDisplay.Select($prevStart, $prevEnd - $prevStart)
            if ($prevLine -eq $currentDisplayLine) {
                $playlistDisplay.SelectionBackColor = [System.Drawing.Color]::LightGreen
            } else {
                $playlistDisplay.SelectionBackColor = $playlistDisplay.BackColor
            }
        }

        # Highlight new hovered line with SkyBlue
        $newStart = $playlistDisplay.GetFirstCharIndexFromLine($lineIndex)
        $newEnd = if ($lineIndex -lt $lineCount - 1) { $playlistDisplay.GetFirstCharIndexFromLine($lineIndex + 1) } else { $playlistDisplay.TextLength }
        $playlistDisplay.Select($newStart, $newEnd - $newStart)
        $playlistDisplay.SelectionBackColor = [System.Drawing.Color]::SkyBlue

        # Clear selection to avoid visible highlight
        $playlistDisplay.Select(0, 0)
    }
})

# Add mouse leave handler to clear hover
$playlistDisplay.Add_MouseLeave({
    $script:lastHoveredLine = -1
    Update-PlaylistDisplay
})

# Add click handler for jumping to files
$playlistDisplay.Add_MouseClick({
    param($sender, $e)

    # Get the line index that was clicked
    $charIndex = $playlistDisplay.GetCharIndexFromPosition($e.Location)
    $lineIndex = $playlistDisplay.GetLineFromCharIndex($charIndex)

    # Get the text of the clicked line
    $lineStart = $playlistDisplay.GetFirstCharIndexFromLine($lineIndex)
    $lineEnd = if ($lineIndex -lt $playlistDisplay.Lines.Count - 1) {
        $playlistDisplay.GetFirstCharIndexFromLine($lineIndex + 1) - 1
    } else {
        $playlistDisplay.TextLength
    }

    if ($lineStart -ge 0 -and $lineEnd -ge $lineStart) {
        $playlistDisplay.Select($lineStart, $lineEnd - $lineStart)
        $lineText = $playlistDisplay.SelectedText.Trim()

        # Remove the >>> prefix if present
        $fileName = $lineText -replace '^>>>\s*', ''

        # Find the file in the list
        $targetFile = $script:cbzFiles | Where-Object { $_.Name -eq $fileName } | Select-Object -First 1

        if ($targetFile) {
            Open-File $targetFile "Playlist Jump"
        }
    }
})

$form.Controls.Add($playlistDisplay)

# ============================================================================
# LOG WINDOW SETUP
# ============================================================================
$logWindow.Multiline = $true
$logWindow.ScrollBars = "Vertical"
$logWindow.ReadOnly = $true
$logWindow.WordWrap = $true
$logWindow.Location = New-Object System.Drawing.Point(20, 395)
$logWindow.Size = New-Object System.Drawing.Size(710, 265)
$logWindow.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$form.Controls.Add($logWindow)

# ============================================================================
# STATS BAR AT BOTTOM (Docked - Fixed for fullscreen)
# ============================================================================
$statsLabel = New-Object System.Windows.Forms.Label
$statsLabel.Location = New-Object System.Drawing.Point(0, 675)
$statsLabel.Size = New-Object System.Drawing.Size(750, 25)
$statsLabel.Text = "⏱️  00:00:00 | 📊 Opened: 0 | ⏭️  Skipped: 0 | ⚠️  Unreadable: 0 | ✅ Kept: 0 | 🔧 To Fix: 0 | 📖 To TL: 0 | ❌ Purged: 0 | 🕐 00:00"
$statsLabel.Font = New-Object System.Drawing.Font("Segoe UI", 8, [System.Drawing.FontStyle]::Bold)
$statsLabel.BackColor = [System.Drawing.Color]::LightGray
$statsLabel.TextAlign = "MiddleCenter"
$statsLabel.Dock = "Bottom"
$form.Controls.Add($statsLabel)

# ============================================================================
# FORM EVENTS
# ============================================================================

$form.Add_Resize({
    $playlistDisplay.Width = $form.ClientSize.Width - 40
    $logWindow.Width = $form.ClientSize.Width - 40
    $logWindow.Height = $form.ClientSize.Height - $logWindow.Top - 50
})

$form.Add_KeyDown({
    param($sender, $e)
    
    $handled = $false
    
    if ($e.Control -and -not $e.Shift) {
        switch ($e.KeyCode) {
            'S' { 
                $shuffle.Checked = -not $shuffle.Checked
                $handled = $true
            }
            'V' { 
                $skipViewedToggle.Checked = -not $skipViewedToggle.Checked
                $handled = $true
            }
            'R' {
                $btnRefresh.PerformClick()
                $handled = $true
            }
            'F5' {
                $btnRefresh.PerformClick()
                $handled = $true
            }
        }
    } 
    elseif (-not $e.Control -and -not $e.Shift -and -not $e.Alt) {
        switch ($e.KeyCode) {
            'K' { $btnKeep.PerformClick() }
            'P' { $btnPurge.PerformClick() }
            'N' { $btnNext.PerformClick() }
            'Q' { $btnQuit.PerformClick() }
            'R' { $btnRandom.PerformClick() }
            'B' { $btnBack.PerformClick() }
            'T' { $btnTranslate.PerformClick() }
            'F' { $btnFix.PerformClick() }
            'I' { $btnInquire.PerformClick() }
            'U' { $btnUnreadable.PerformClick() }
            'C' { $btnClear.PerformClick() }
        }
    }

    # Suppress all keypresses to prevent WinForms system beep
    $e.SuppressKeyPress = $true
})

$form.Add_FormClosing({
    Stop-Process -Name "CDisplayEx" -ErrorAction SilentlyContinue
    if ($timerUpdateTimer) { $timerUpdateTimer.Stop() }
})

# ============================================================================
# STARTUP
# ============================================================================

$form.Topmost = $true
$form.Add_Shown({
    if ($script:cbzFiles.Count -eq 0) {
        [System.Windows.Forms.MessageBox]::Show("No .cbz files found in this folder.")
        $form.Close()
        return
    }

    # Check if CDisplayEx is available
    $cdexFound = $false
    if (Get-Command "CDisplayEx" -ErrorAction SilentlyContinue) {
        $cdexFound = $true
    } else {
        # Check common install locations
        $commonPaths = @(
            "$env:ProgramFiles\CDisplayEx\CDisplayEx.exe",
            "${env:ProgramFiles(x86)}\CDisplayEx\CDisplayEx.exe",
            "$env:LOCALAPPDATA\Programs\CDisplayEx\CDisplayEx.exe"
        )
        $cdexFound = ($commonPaths | Where-Object { Test-Path $_ } | Select-Object -First 1) -ne $null
    }
    if (-not $cdexFound) {
        [System.Windows.Forms.MessageBox]::Show(
            "CDisplayEx not found. CBZ files may open in the wrong application.`n`nInstall CDisplayEx and set it as the default .cbz viewer.",
            "CBZ Sorter Warning",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Warning
        )
        Log-Event "⚠️ WARNING: CDisplayEx not detected - files may open in wrong viewer"
    }

    # Start timer that updates every second
    $timerUpdateTimer = New-Object System.Windows.Forms.Timer
    $timerUpdateTimer.Interval = 1000
    $timerUpdateTimer.Add_Tick({ Update-Stats })
    $timerUpdateTimer.Start()
    
    Log-Event "⚡ Speed Mode ON - Instant operations"
    Update-Stats
    Open-File (Get-FirstFile)
})

[void]$form.ShowDialog()
