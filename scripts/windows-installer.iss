#ifndef SourceRoot
  #define SourceRoot ".."
#endif
#ifndef AppVersion
  #define AppVersion "0.5.0"
#endif
[Setup]
AppId={{B3812C15-7947-4C66-8CE0-64A7CDE9B2C0}
AppName=PaperDesk
AppVersion={#AppVersion}
AppPublisher=PaperDesk
DefaultDirName={localappdata}\Programs\PaperDesk
DefaultGroupName=PaperDesk
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#SourceRoot}\artifacts
OutputBaseFilename=PaperDesk-{#AppVersion}-Windows-x64-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\paperdesk.exe
SetupIconFile={#SourceRoot}\client\windows\runner\resources\app_icon.ico
[Files]
Source: "{#SourceRoot}\client\build\windows\x64\runner\Release\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
[Icons]
Name: "{group}\PaperDesk"; Filename: "{app}\paperdesk.exe"
Name: "{autodesktop}\PaperDesk"; Filename: "{app}\paperdesk.exe"; Tasks: desktopicon
[Tasks]
Name: desktopicon; Description: "Create a desktop shortcut"; Flags: unchecked
[Run]
Filename: "{app}\paperdesk.exe"; Description: "Open PaperDesk"; Flags: nowait postinstall skipifsilent
