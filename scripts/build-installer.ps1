param(
  [string]$Compiler = "ISCC.exe",
  [string]$CertificateThumbprint = $env:PULSE_SIGN_CERT_SHA1
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$compilerCommand = Get-Command $Compiler -ErrorAction SilentlyContinue
if ($compilerCommand) {
  $compilerPath = $compilerCommand.Source
} elseif ($Compiler -eq "ISCC.exe") {
  $compilerPath = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
    (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe")
  ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $compilerPath) {
    throw "Install Inno Setup 6, then run this script again."
  }
} else {
  throw "Could not find the Inno Setup compiler: $Compiler"
}
$package = Get-Content (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json
$source = Join-Path $projectRoot "installer\Pulse.iss"
$outputFolder = Join-Path $projectRoot "dist\installer"
$nodeVersion = "v24.22.0"
$archiveName = "node-$nodeVersion-win-x64.zip"
$buildTemp = Join-Path $env:TEMP ("pulse-installer-" + [Guid]::NewGuid().ToString("N"))
$archivePath = Join-Path $buildTemp $archiveName
$runtimeFolder = Join-Path $outputFolder "runtime"
New-Item -ItemType Directory -Path $outputFolder -Force | Out-Null

New-Item -ItemType Directory -Path $buildTemp -Force | Out-Null
try {
  $distributionUrl = "https://nodejs.org/dist/$nodeVersion"
  Invoke-WebRequest -Uri "$distributionUrl/$archiveName" -OutFile $archivePath
  $checksums = (Invoke-WebRequest -Uri "$distributionUrl/SHASUMS256.txt").Content
  $checksumLine = $checksums -split "`n" |
    Where-Object { $_ -match ("\s" + [Regex]::Escape($archiveName) + "$") } |
    Select-Object -First 1
  if (-not $checksumLine) {
    throw "The official Node.js checksum list does not contain $archiveName."
  }
  $expectedHash = ($checksumLine -split "\s+")[0].ToLowerInvariant()
  $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) {
    throw "The downloaded Node.js archive failed its SHA-256 check."
  }

  $extractFolder = Join-Path $buildTemp "extract"
  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractFolder
  if (Test-Path -LiteralPath $runtimeFolder) {
    Remove-Item -LiteralPath $runtimeFolder -Recurse -Force
  }
  New-Item -ItemType Directory -Path $runtimeFolder -Force | Out-Null
  $nodeFolder = Join-Path $extractFolder "node-$nodeVersion-win-x64"
  foreach ($file in @("node.exe", "LICENSE", "README.md")) {
    Copy-Item -LiteralPath (Join-Path $nodeFolder $file) -Destination $runtimeFolder -Force
  }

  & $compilerPath "/DAppVersion=$($package.version)" $source
  if ($LASTEXITCODE -ne 0) {
    throw "Inno Setup compilation failed with exit code $LASTEXITCODE."
  }

  if ($CertificateThumbprint) {
    $signTool = Get-Command signtool.exe -ErrorAction Stop
    $installerPath = Join-Path $projectRoot "dist\installer\PulseSetup.exe"
    & $signTool.Source sign /sha1 $CertificateThumbprint /fd SHA256 /tr "http://timestamp.digicert.com" /td SHA256 $installerPath
    if ($LASTEXITCODE -ne 0) {
      throw "Installer signing failed with exit code $LASTEXITCODE."
    }
  } else {
    Write-Warning "Installer is unsigned. Set PULSE_SIGN_CERT_SHA1 to a code-signing certificate installed in the Windows certificate store to sign it."
  }
} finally {
  Remove-Item -LiteralPath $buildTemp -Recurse -Force -ErrorAction SilentlyContinue
}
