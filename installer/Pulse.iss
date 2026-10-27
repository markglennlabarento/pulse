#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

#define AppName "Pulse System Monitor"
#define AppPublisher "Pulse"
#define AppExeName "PulseTray.ps1"

[Setup]
AppId={{8E5CBDB2-CE8F-4B08-BA9D-1C067F5D9220}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\Pulse
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist\installer
OutputBaseFilename=PulseSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "startup"; Description: "Start Pulse when I sign in to Windows"; GroupDescription: "Startup:"; Flags: checkedonce

[Files]
Source: "..\index.html"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\assets\*"; DestDir: "{app}\assets"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\css\*"; DestDir: "{app}\css"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\js\*"; DestDir: "{app}\js"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\server.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\scripts\PulseTray.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\installer\runtime\node.exe"; DestDir: "{app}\runtime"; Flags: ignoreversion
Source: "..\dist\installer\runtime\LICENSE"; DestDir: "{app}\runtime"; Flags: ignoreversion
Source: "..\dist\installer\runtime\README.md"; DestDir: "{app}\runtime"; Flags: ignoreversion

[Icons]
Name: "{group}\Pulse System Monitor"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\{#AppExeName}"""
Name: "{group}\Uninstall Pulse"; Filename: "{uninstallexe}"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "PulseSystemMonitor"; ValueData: """{sys}\WindowsPowerShell\v1.0\powershell.exe"" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\{#AppExeName}"""; Tasks: startup; Flags: uninsdeletevalue

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\{#AppExeName}"""; Description: "Start Pulse System Monitor"; Flags: postinstall nowait skipifsilent

[Code]
var
  OriginPage: TInputQueryWizardPage;

function NormalizeDashboardOrigin(const Value: String; var Normalized: String): Boolean;
var
  Candidate, Host: String;
  Index: Integer;
  Character: Char;
begin
  Result := False;
  Normalized := '';
  Candidate := Trim(Value);
  if CompareText(Copy(Candidate, 1, 8), 'https://') <> 0 then
    Exit;
  Host := Copy(Candidate, 9, Length(Candidate));
  if (Host <> '') and (Copy(Host, Length(Host), 1) = '/') then
    Delete(Host, Length(Host), 1);
  if (Host = '') or (Pos('/', Host) > 0) then
    Exit;
  for Index := 1 to Length(Host) do
  begin
    Character := Host[Index];
    if not (((Character >= 'a') and (Character <= 'z')) or
      ((Character >= 'A') and (Character <= 'Z')) or
      ((Character >= '0') and (Character <= '9')) or
      (Character = '.') or (Character = '-')) then
      Exit;
  end;
  if (Copy(Host, 1, 1) = '.') or (Copy(Host, Length(Host), 1) = '.') or
    (Copy(Host, 1, 1) = '-') or (Copy(Host, Length(Host), 1) = '-') then
    Exit;
  Normalized := 'https://' + Lowercase(Host);
  Result := True;
end;

procedure InitializeWizard;
begin
  OriginPage := CreateInputQueryPage(wpSelectDir,
    'Dashboard address', 'Connect Pulse to your Netlify site',
    'Paste the exact HTTPS origin shown in your browser address bar. Do not include a page path.');
  OriginPage.Add('HTTPS site origin:', False);
  OriginPage.Values[0] := 'https://pulsesystemmonitoring.netlify.app';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  DashboardOrigin: String;
begin
  Result := True;
  if CurPageID = OriginPage.ID then
  begin
    Result := NormalizeDashboardOrigin(OriginPage.Values[0], DashboardOrigin);
    if not Result then
      MsgBox('Enter an HTTPS website origin only, such as https://your-site.netlify.app. Do not include a path or port.', mbError, MB_OK);
    if Result then
      OriginPage.Values[0] := DashboardOrigin;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ConfigDir: String;
begin
  if CurStep = ssPostInstall then
  begin
    ConfigDir := ExpandConstant('{localappdata}\Pulse');
    if not ForceDirectories(ConfigDir) then
      RaiseException('Could not create the Pulse configuration directory.');
    if not SaveStringToFile(ConfigDir + '\dashboard-origin.txt',
      OriginPage.Values[0], False) then
      RaiseException('Could not save the Pulse dashboard origin.');
  end;
end;
