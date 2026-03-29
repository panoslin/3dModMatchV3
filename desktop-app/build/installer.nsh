; Post-install hook: patch pyvenv.cfg with the real install path.
; This runs with admin privileges during NSIS installation, so it CAN
; write to C:\Program Files\.  The bundled pyvenv.cfg still contains the
; CI build-machine path; we overwrite it here with $INSTDIR.
!macro customInstall
  FileOpen $0 "$INSTDIR\resources\venv\pyvenv.cfg" w
  FileWrite $0 "home = $INSTDIR\resources\venv\Scripts$\r$\n"
  FileWrite $0 "include-system-site-packages = false$\r$\n"
  FileClose $0
!macroend
