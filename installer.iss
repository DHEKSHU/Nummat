; NUMMAT Windows installer (like a PopCap-style game install).
; 1. Run build.bat first (it creates the "NUMMAT Game" folder).  2. Install Inno Setup (free): https://jrsoftware.org/isinfo.php
; 3. Open this file in Inno Setup and press Compile -> Output\NUMMAT-Setup.exe
; The installer adds Start-menu and desktop shortcuts with the NUMMAT icon and an uninstaller.

#define AppName "NUMMAT"
#define AppVersion "2.0"

[Setup]
AppId={{6A1F3C2E-8D4B-4F7A-9C11-5E2B7D0A4F21}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=NUMMAT
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
UninstallDisplayIcon={app}\NUMMAT.exe
SetupIconFile=assets\nummat.ico
WizardStyle=modern
OutputDir=Output
OutputBaseFilename=NUMMAT-Setup
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=lowest

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "NUMMAT Game\*"; DestDir: "{app}"; Excludes: "saves\*"; Flags: ignoreversion recursesubdirs createallsubdirs

[Dirs]
Name: "{app}\saves"

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\NUMMAT.exe"
Name: "{group}\How to Play"; Filename: "{app}\How to Play.txt"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\NUMMAT.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\NUMMAT.exe"; Description: "Play {#AppName} now"; Flags: nowait postinstall skipifsilent
