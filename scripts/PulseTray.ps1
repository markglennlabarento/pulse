$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$appRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $env:LOCALAPPDATA "Pulse\dashboard-origin.txt"
$dashboardOrigin = (Get-Content -LiteralPath $configPath -Raw).Trim()
$origin = $null
if (
  -not [Uri]::TryCreate($dashboardOrigin, [UriKind]::Absolute, [ref]$origin) -or
  $origin.Scheme -ne "https" -or
  $origin.GetLeftPart([UriPartial]::Authority) -ne $dashboardOrigin
) {
  throw "Pulse has an invalid dashboard origin. Run the installer again."
}

$script:nodePath = Join-Path $appRoot "runtime\node.exe"
if (-not (Test-Path -LiteralPath $script:nodePath)) {
  throw "The bundled Node.js runtime is missing. Reinstall Pulse."
}
$env:PULSE_DASHBOARD_ORIGIN = $dashboardOrigin
$tokenPath = Join-Path $env:LOCALAPPDATA "Pulse\shutdown-token.txt"
$agentProcess = $null
$stdoutPath = Join-Path $env:LOCALAPPDATA "Pulse\agent.out.log"
$stderrPath = Join-Path $env:LOCALAPPDATA "Pulse\agent.err.log"
New-Item -ItemType Directory -Path (Split-Path -Parent $tokenPath) -Force | Out-Null
if (-not (Test-Path -LiteralPath $tokenPath)) {
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  $bytes = New-Object byte[] 32
  try {
    $random.GetBytes($bytes)
  } finally {
    $random.Dispose()
  }
  [Convert]::ToBase64String($bytes) | Set-Content -LiteralPath $tokenPath -NoNewline -Encoding ASCII
}
$env:PULSE_AGENT_STOP_TOKEN = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Application
$icon.Text = "Pulse system monitor"
$icon.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add("Open dashboard")
$restartItem = $menu.Items.Add("Restart monitor")
$menu.Items.Add("-") | Out-Null
$exitItem = $menu.Items.Add("Exit Pulse")
$icon.ContextMenuStrip = $menu

function Start-Agent {
  if ($script:agentProcess -and -not $script:agentProcess.HasExited) {
    return
  }
  Remove-Item -LiteralPath $script:stdoutPath, $script:stderrPath -Force -ErrorAction SilentlyContinue
  $script:agentProcess = Start-Process `
    -FilePath $script:nodePath `
    -ArgumentList ('"{0}"' -f (Join-Path $script:appRoot "server.js")) `
    -WorkingDirectory $script:appRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $script:stdoutPath `
    -RedirectStandardError $script:stderrPath `
    -PassThru
}

function Stop-Agent {
  if (-not $script:agentProcess -or $script:agentProcess.HasExited) {
    return
  }
  try {
    Invoke-WebRequest `
      -UseBasicParsing `
      -Uri "http://127.0.0.1:3000/api/shutdown" `
      -Method Post `
      -Headers @{ Authorization = "Bearer $env:PULSE_AGENT_STOP_TOKEN" } `
      -TimeoutSec 3 | Out-Null
    if (-not $script:agentProcess.WaitForExit(7000)) {
      Stop-Process -Id $script:agentProcess.Id -Force
    }
  } catch {
    Stop-Process -Id $script:agentProcess.Id -Force
  }
}

$openItem.add_Click({ Start-Process $script:dashboardOrigin })
$restartItem.add_Click({
  Stop-Agent
  Start-Agent
})
$exitItem.add_Click({
  Stop-Agent
  $script:icon.Visible = $false
  $script:icon.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
  if ($script:agentProcess -and $script:agentProcess.HasExited) {
    $script:timer.Stop()
    $script:icon.ShowBalloonTip(5000, "Pulse stopped", "Open the Pulse log for details, then choose Restart monitor.", [System.Windows.Forms.ToolTipIcon]::Warning)
  }
})

Start-Agent
$timer.Start()
[System.Windows.Forms.Application]::Run()
$timer.Dispose()
