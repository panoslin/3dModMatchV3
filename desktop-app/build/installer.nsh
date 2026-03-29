; Post-install hook: create pyvenv.cfg with the correct install path.
; Python 3.11 requires pyvenv.cfg to exist when it detects a venv structure
; (exit code 106 if missing).  The ._pth file handles actual path resolution;
; pyvenv.cfg just needs to exist with a valid "home" directory.
; This runs as admin so it CAN write to C:\Program Files\.
!macro customInstall
  FileOpen $0 "$INSTDIR\resources\venv\pyvenv.cfg" w
  FileWrite $0 "home = $INSTDIR\resources\venv\Scripts$\r$\n"
  FileWrite $0 "include-system-site-packages = false$\r$\n"
  FileClose $0
!macroend
