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

# ── 5. Bundled Python (flat distribution — NOT a venv) ───────────────────────
# We create a temporary venv to install pip packages, then restructure into a
# flat Python distribution.  The "Scripts/" directory in a venv triggers
# Python's venv detection at the C level, which requires pyvenv.cfg validation
# BEFORE any flags (-I, -S) or ._pth files take effect.  A flat layout avoids
# this entirely.
Info "Creating bundled Python distribution..."

$PythonDir = Split-Path $Python
$PyVerShort = (& $Python -c "import sys; print(f'{sys.version_info.major}{sys.version_info.minor}')").Trim()

# 5a. Create temporary venv for pip installs
$TempVenv = Join-Path $DesktopDir "_tmpvenv"
if (Test-Path $TempVenv) { Remove-Item -Recurse -Force $TempVenv }
& $Python -m venv --copies $TempVenv
if ($LASTEXITCODE -ne 0) { Fail "venv creation failed" }

$TempVenvPy = Join-Path $TempVenv "Scripts\python.exe"
& $TempVenvPy -m pip install --upgrade pip --quiet
& $TempVenvPy -m pip install -r "$DesktopDir\backend\requirements.txt" --quiet
if ($LASTEXITCODE -ne 0) { Fail "pip install failed" }
Info "Python packages installed."

# 5b. Build flat distribution: python-dist/
$DistDir = Join-Path $DesktopDir "python-dist"
if (Test-Path $DistDir) { Remove-Item -Recurse -Force $DistDir }
New-Item -ItemType Directory -Force -Path $DistDir | Out-Null

# Copy executables from the SYSTEM Python (not the venv copy)
Copy-Item (Join-Path $PythonDir "python.exe") $DistDir -Force
Copy-Item (Join-Path $PythonDir "pythonw.exe") $DistDir -Force -ErrorAction SilentlyContinue
# Copy all required DLLs next to python.exe
Get-ChildItem $PythonDir -Filter "python3*.dll" | Copy-Item -Destination $DistDir -Force
Get-ChildItem $PythonDir -Filter "vcruntime*.dll" -ErrorAction SilentlyContinue | Copy-Item -Destination $DistDir -Force

# Bundle VC++ runtime DLLs that mesh_matcher.pyd depends on.
# The .pyd is compiled with VS2022 and may link OpenMP — these DLLs are
# present on the build machine (VS installed) but NOT on end-user machines
# without the VC++ Redistributable.  Copy from the VS redist directory.
$VcToolsRedistDir = & $VsWhere -latest -find "VC\Redist\MSVC\*\x64" 2>$null |
    Sort-Object -Descending | Select-Object -First 1
$RuntimeDlls = @("msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll",
                  "vcomp140.dll", "concrt140.dll", "vcruntime140_1.dll")
$copied = @()
foreach ($dll in $RuntimeDlls) {
    # Skip if already present in python-dist (e.g. vcruntime140_1 from Python)
    if (Test-Path (Join-Path $DistDir $dll)) { continue }
    # Try VS redist directory first
    if ($VcToolsRedistDir) {
        $src = Get-ChildItem $VcToolsRedistDir -Recurse -Filter $dll -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($src) { Copy-Item $src.FullName $DistDir -Force; $copied += $dll; continue }
    }
    # Fallback: System32
    $sys32 = Join-Path $env:SystemRoot "System32\$dll"
    if (Test-Path $sys32) { Copy-Item $sys32 $DistDir -Force; $copied += $dll }
}
if ($copied.Count -gt 0) { Info "Bundled VC++ runtime DLLs: $($copied -join ', ')" }

Info "Copied python.exe and DLLs to python-dist\"

# DLLs/ directory (extension modules + shared libs)
$DllDest = Join-Path $DistDir "DLLs"
New-Item -ItemType Directory -Force -Path $DllDest | Out-Null
$SysDlls = Join-Path $PythonDir "DLLs"
if (Test-Path $SysDlls) {
    Get-ChildItem $SysDlls -Filter "*.pyd" | Copy-Item -Destination $DllDest -Force
    Get-ChildItem $SysDlls -Filter "*.dll" | Copy-Item -Destination $DllDest -Force
    Info "Copied system DLLs/ to python-dist\DLLs\"
}

# Lib/ directory — stdlib from system Python
$SysLib = Join-Path $PythonDir "Lib"
$DistLib = Join-Path $DistDir "Lib"
New-Item -ItemType Directory -Force -Path $DistLib | Out-Null
if (Test-Path $SysLib) {
    Info "Copying stdlib into python-dist\Lib\ ..."
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
        $destPath = Join-Path $DistLib $relPath
        if ($_.PSIsContainer) {
            New-Item -ItemType Directory -Force -Path $destPath | Out-Null
        } else {
            $destDir = Split-Path $destPath
            if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
            Copy-Item $_.FullName $destPath -Force
        }
    }
    Info "Stdlib copied."
} else {
    Warn "Could not find stdlib at $SysLib — app may not be portable"
}

# site-packages from the temp venv
$TempSitePkg = Join-Path $TempVenv "Lib\site-packages"
$DistSitePkg = Join-Path $DistLib "site-packages"
if (Test-Path $TempSitePkg) {
    Copy-Item $TempSitePkg $DistSitePkg -Recurse -Force
    Info "Copied site-packages."
}

# 5c. Create ._pth file (paths relative to python.exe directory)
$PthFile = Join-Path $DistDir "python${PyVerShort}._pth"
@"
Lib
Lib/site-packages
DLLs
import site
"@ | Set-Content $PthFile -Encoding ASCII
Info "Created python${PyVerShort}._pth"

# 5d. Clean up temp venv
Remove-Item -Recurse -Force $TempVenv
Info "Python distribution ready: python-dist\"

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
