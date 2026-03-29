; Post-install hook: ensure pyvenv.cfg is removed (._pth file handles paths).
; The ._pth file is created at build time with relative paths, so it works
; regardless of install location.  pyvenv.cfg would trigger Python's venv
; detection and cause path resolution issues.
!macro customInstall
  Delete "$INSTDIR\resources\venv\pyvenv.cfg"
!macroend
