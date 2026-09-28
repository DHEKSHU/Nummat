@echo off
REM ================================================================
REM  Build the NUMMAT game.  Just double-click this file.
REM
REM  Result:  "NUMMAT Game" folder next to this file
REM             NUMMAT.exe        <- the game (double-click to play)
REM             _internal\        <- game files, keep next to the exe
REM             saves\            <- players & progress (created on first run)
REM             How to Play.txt
REM  + a NUMMAT shortcut on your desktop.
REM
REM  Copy the whole "NUMMAT Game" folder to any Windows PC and play -
REM  no Python or install needed there. Rebuilding never touches saves\.
REM ================================================================
cd /d "%~dp0"
set "GAME=%~dp0NUMMAT Game"

echo [1/5] Installing build tools...
python -m pip install --upgrade pip setuptools wheel altgraph >nul
python -m pip install -r requirements.txt pyinstaller pywebview pillow
if errorlevel 1 goto :fail

echo [2/5] Drawing the icon...
python scripts\make_icon.py
if errorlevel 1 goto :fail

echo [3/5] Building NUMMAT.exe (takes a minute)...
python -m PyInstaller desktop.py --name NUMMAT --onedir --windowed --noconfirm --clean ^
  --icon assets\nummat.ico ^
  --add-data "templates;templates" --add-data "static;static" --add-data "engine;engine" --add-data "assets;assets" ^
  --hidden-import api --hidden-import services --hidden-import models
if errorlevel 1 goto :fail

echo [4/5] Creating the "NUMMAT Game" folder...
REM /MIR mirrors the fresh build but /XD keeps your saves folder safe
robocopy "dist\NUMMAT" "%GAME%" /MIR /XD saves /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 goto :fail
copy /Y "How to Play.txt" "%GAME%\How to Play.txt" >nul
rmdir /S /Q build 2>nul
rmdir /S /Q dist 2>nul
del /Q NUMMAT.spec 2>nul

echo [5/5] Adding a desktop shortcut...
powershell -NoProfile -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\NUMMAT.lnk');" ^
  "$s.TargetPath='%GAME%\NUMMAT.exe'; $s.WorkingDirectory='%GAME%';" ^
  "$s.IconLocation='%GAME%\NUMMAT.exe,0'; $s.Description='NUMMAT - Think. Match. Clear.'; $s.Save()"

echo.
echo  ============================================================
echo   Done!  Your game is in:  "NUMMAT Game\NUMMAT.exe"
echo   A NUMMAT shortcut is on your desktop.
echo   To share it, copy the whole "NUMMAT Game" folder.
echo  ============================================================
explorer "%GAME%"
pause
exit /b 0

:fail
echo.
echo  Build failed - scroll up for the error message.
pause
exit /b 1
