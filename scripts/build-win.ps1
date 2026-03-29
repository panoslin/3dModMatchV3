# =============================================================================
# Windows Release Build Script
# Compiles mesh_matcher.pyd, sets up bundled venv, packages the Electron app.
# Output: desktop-app\dist\*.exe  (NSIS installer)
#
# Requirements:
#   - Python 3.10-3.12  (python.org installer — add to PATH)
#   - CMake 3.15+       (cmake.org or: winget install Kitware.CMake)
#   - Visual Studio 2019/2022 with "Desktop development with C++" workload
#       OR Visual Studio Build Tools (same workload)
#   - Git for Windows   (git-scm.com, for npm/node-gyp)
#   - Node.js 18+       (nodejs.org)
#
# Run from any directory:
#   powershell -ExecutionPolicy Bypass -File scripts\build-win.ps1
# =============================================================================
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot  = Split-Path -Parent $PSScriptRoot
$DesktopDir = Join-Path $RepoRoot "desktop-app"
$SrcCore    = Join-Path $RepoRoot "src\core"
$SrcBiz     = Join-Path $RepoRoot "src\biz"
$VenvDir    = Join-Path $DesktopDir "venv"
$EigenDir   = Join-Path $RepoRoot "build_deps\eigen3"

function Info  { Write-Host "[build-win] $args" -ForegroundColor Green }
function Warn  { Write-Host "[build-win] $args" -ForegroundColor Yellow }
function Fail  { Write-Host "[build-win] ERROR: $args" -ForegroundColor Red; exit 1 }

# ── 1. Prerequisites ──────────────────────────────────────────────────────────
Info "Checking prerequisites..."

# Python
$Python = $null
foreach ($candidate in @("python3.12","python3.11","python3.10","python3","python")) {
    $found = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($found) {
        # Verify it's 3.10+
        $ver = & $found.Source --version 2>&1
        if ($ver -match "Python (3\.(1[0-9]|\d{2,}))") {
            $Python = $found.Source
            break
        }
    }
}
if (-not $Python) { Fail "Python 3.10+ not found. Install from https://python.org (add to PATH)" }
Info "Python: $Python ($(& $Python --version 2>&1))"

# CMake
if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
    Fail "cmake not found. Install from https://cmake.org or: winget install Kitware.CMake"
}

# VS cl.exe — locate via vswhere
$VsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $VsWhere)) {
    Fail "Visual Studio not found. Install VS2022/2019 with 'Desktop development with C++' workload."
}
$VsInstallPath = & $VsWhere -latest -property installationPath
$VcVarsAll = Join-Path $VsInstallPath "VC\Auxiliary\Build\vcvarsall.bat"
if (-not (Test-Path $VcVarsAll)) { Fail "vcvarsall.bat not found at: $VcVarsAll" }
Info "Visual Studio: $VsInstallPath"

# Node / npm
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "node not found. Install from https://nodejs.org" }

# ── 2. Eigen3 (header-only — download if missing) ─────────────────────────────
if (-not (Test-Path (Join-Path $EigenDir "Eigen\Dense"))) {
    Info "Downloading Eigen3 headers..."
    $EigenZip = Join-Path $RepoRoot "build_deps\eigen.zip"
    New-Item -ItemType Directory -Force -Path (Split-Path $EigenDir) | Out-Null
    Invoke-WebRequest `
        -Uri "https://gitlab.com/libeigen/eigen/-/archive/3.4.0/eigen-3.4.0.zip" `
        -OutFile $EigenZip
    Expand-Archive -Path $EigenZip -DestinationPath (Split-Path $EigenDir) -Force
    # Rename extracted folder to eigen3
    $extracted = Get-ChildItem (Split-Path $EigenDir) -Directory | Where-Object { $_.Name -like "eigen-*" } | Select-Object -First 1
    Rename-Item $extracted.FullName $EigenDir
    Remove-Item $EigenZip
    Info "Eigen3 downloaded to: $EigenDir"
} else {
    Info "Eigen3: $EigenDir (already present)"
}

# ── 3. pybind11 for the chosen Python ─────────────────────────────────────────
Info "Installing pybind11..."
& $Python -m pip install pybind11 --quiet
$Pybind11Cmake = (& $Python -c "import pybind11; print(pybind11.get_cmake_dir())").Trim()
Info "pybind11 cmake dir: $Pybind11Cmake"

# ── 4. Compile C++ module (inside a VS environment) ───────────────────────────
Info "Compiling mesh_matcher C++ module..."

$BuildDir = Join-Path $SrcCore "build"
if (Test-Path $BuildDir) { Remove-Item -Recurse -Force $BuildDir }
New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null

# Write a helper batch script that activates MSVC and runs cmake + msbuild
$BuildBat = Join-Path $env:TEMP "3dmatch_build.bat"
@"
@echo off
call "$VcVarsAll" x64
if errorlevel 1 exit /b 1

cmake -S "$SrcCore" -B "$BuildDir" ^
    -G "Visual Studio 17 2022" -A x64 ^
    -DCMAKE_BUILD_TYPE=Release ^
    -DPython3_EXECUTABLE="$Python" ^
    -Dpybind11_DIR="$Pybind11Cmake" ^
    -DEIGEN3_INCLUDE_DIR="$EigenDir"
if errorlevel 1 exit /b 1

cmake --build "$BuildDir" --config Release --parallel
if errorlevel 1 exit /b 1
"@ | Set-Content $BuildBat

cmd /c $BuildBat
if ($LASTEXITCODE -ne 0) { Fail "C++ build failed (see output above)" }
Remove-Item $BuildBat

# Verify output — pybind11 names it mesh_matcher.cpython-3XX-win_amd64.pyd
# CMakeLists.txt should place it in src/biz directly, but MSVC may still land it
# in build/Release/ — search both locations.
$PydFile = Get-ChildItem $SrcBiz -Filter "mesh_matcher*.pyd" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $PydFile) {
    # Fallback: search the build tree
    $PydFile = Get-ChildItem $BuildDir -Filter "mesh_matcher*.pyd" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
}
if (-not $PydFile) { Fail "mesh_matcher.pyd not found in $SrcBiz or $BuildDir after build" }
# If it landed outside $SrcBiz, move it there
if ($PydFile.DirectoryName -ne $SrcBiz) {
    $dest = Join-Path $SrcBiz $PydFile.Name
    Move-Item $PydFile.FullName $dest -Force
    $PydFile = Get-Item $dest
    Info "Moved .pyd to $SrcBiz"
}
Info "Built: $($PydFile.Name) ($([math]::Round($PydFile.Length/1KB))KB)"

# Quick smoke-test (use forward slashes to avoid Python interpreting \b, \n, etc.)
$SrcBizFwd = $SrcBiz.Replace('\','/')
& $Python -c "import sys; sys.path.insert(0,'$SrcBizFwd'); import mesh_matcher; print('  import OK:', mesh_matcher.__file__)"
if ($LASTEXITCODE -ne 0) { Fail "Module import smoke-test failed" }

# ── 5. Bundled Python venv ────────────────────────────────────────────────────
Info "Creating bundled venv..."

if (Test-Path $VenvDir) { Remove-Item -Recurse -Force $VenvDir }
& $Python -m venv --copies $VenvDir
if ($LASTEXITCODE -ne 0) { Fail "venv creation failed" }

$VenvPy = Join-Path $VenvDir "Scripts\python.exe"
& $VenvPy -m pip install --upgrade pip --quiet
& $VenvPy -m pip install -r "$DesktopDir\backend\requirements.txt" --quiet
if ($LASTEXITCODE -ne 0) { Fail "pip install failed" }
Info "Python packages installed into venv."

# Copy Python DLLs next to the venv for portability
$PythonDir = Split-Path $Python
$DllDest   = Join-Path $VenvDir "DLLs"
New-Item -ItemType Directory -Force -Path $DllDest | Out-Null
# Copy python3X.dll and any vc_redist DLLs from the Python install
Get-ChildItem $PythonDir -Filter "python3*.dll" | Copy-Item -Destination $DllDest -Force
Get-ChildItem $PythonDir -Filter "vcruntime*.dll" -ErrorAction SilentlyContinue | Copy-Item -Destination $DllDest -Force
# Also copy DLLs from the system Python DLLs directory (sqlite3, ssl, etc.)
$SysDlls = Join-Path $PythonDir "DLLs"
if (Test-Path $SysDlls) {
    Get-ChildItem $SysDlls -Filter "*.pyd" | Copy-Item -Destination $DllDest -Force
    Get-ChildItem $SysDlls -Filter "*.dll" | Copy-Item -Destination $DllDest -Force
    Info "Copied system Python DLLs to venv\DLLs\"
}
Info "Copied Python DLLs to venv\DLLs\"

# Bundle stdlib into the venv for portability (end-user may not have Python installed)
$PyVer = & $Python -c "import sys; print(f'python{sys.version_info.major}{sys.version_info.minor}')"
$SysLib = Join-Path $PythonDir "Lib"
$VenvLib = Join-Path $VenvDir "Lib"
if (Test-Path $SysLib) {
    Info "Copying stdlib into venv\Lib\ ..."
    # Copy stdlib .py files (excluding site-packages, test, tkinter to save space)
    $excludeDirs = @("site-packages", "test", "tests", "tkinter", "turtledemo", "idlelib", "__pycache__")
    Get-ChildItem $SysLib -Recurse | Where-Object {
        $relPath = $_.FullName.Substring($SysLib.Length + 1)
        $skip = $false
        foreach ($ex in $excludeDirs) {
            if ($relPath -like "$ex\*" -or $relPath -eq $ex) { $skip = $true; break }
        }
        -not $skip
    } | ForEach-Object {
        $relPath = $_.FullName.Substring($SysLib.Length + 1)
        $destPath = Join-Path $VenvLib $relPath
        if ($_.PSIsContainer) {
            New-Item -ItemType Directory -Force -Path $destPath | Out-Null
        } else {
            $destDir = Split-Path $destPath
            if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
            Copy-Item $_.FullName $destPath -Force
        }
    }
    Info "Stdlib copied to venv\Lib\"
} else {
    Warn "Could not find stdlib at $SysLib — app may not be portable"
}

# ── 5.1 Make venv fully self-contained (no reference to build-host Python) ────
# pyvenv.cfg records the build machine's Python path in the "home" key.
# On the end-user machine that path won't exist, causing:
#   "No Python at C:\hostedtoolcache\..."
# Rewrite "home" to point to the venv's own Scripts/ directory.
# The Electron main process will patch it again at runtime to the actual
# install path, but the file MUST exist (Python exit code 106 if missing).
Info "Patching pyvenv.cfg home to venv-relative path..."

$PyvenvCfg = Join-Path $VenvDir "pyvenv.cfg"
$VenvScriptsAbs = Join-Path $VenvDir "Scripts"
if (Test-Path $PyvenvCfg) {
    $content = Get-Content $PyvenvCfg -Raw
    $content = $content -replace '(?m)^home\s*=.*', "home = $VenvScriptsAbs"
    Set-Content $PyvenvCfg $content -NoNewline
    Info "Patched pyvenv.cfg: home = $VenvScriptsAbs"
} else {
    "home = $VenvScriptsAbs`ninclude-system-site-packages = false`n" | Set-Content $PyvenvCfg -NoNewline
    Info "Created pyvenv.cfg: home = $VenvScriptsAbs"
}

# Python needs python3.dll and python3XX.dll next to (or above) the executable.
# They were copied to DLLs/ earlier; also place them alongside Scripts\python.exe.
$VenvScriptsDir = Join-Path $VenvDir "Scripts"
Get-ChildItem $PythonDir -Filter "python3*.dll" | Copy-Item -Destination $VenvScriptsDir -Force
Get-ChildItem $PythonDir -Filter "vcruntime*.dll" -ErrorAction SilentlyContinue | Copy-Item -Destination $VenvScriptsDir -Force
Info "Copied python DLLs to venv\Scripts\"

# ── 6. Node dependencies ──────────────────────────────────────────────────────
Info "Installing Node.js dependencies..."
Set-Location $DesktopDir
npm install --ignore-scripts 2>&1
if ($LASTEXITCODE -ne 0) { Fail "npm install failed" }

# ── 7. Electron-builder ───────────────────────────────────────────────────────
Info "Packaging Windows app..."
npx electron-builder --win 2>&1
if ($LASTEXITCODE -ne 0) { Fail "electron-builder failed" }

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host ""
Info "============================================================"
Info "  Build complete!"
Info "  Output:"
Get-ChildItem "$DesktopDir\dist" -Filter "*.exe" | ForEach-Object {
    Info "    $($_.Name)  ($([math]::Round($_.Length/1MB))MB)"
}
Info "============================================================"
