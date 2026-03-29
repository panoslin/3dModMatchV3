#!/usr/bin/env bash
# =============================================================================
# macOS Release Build Script
# Compiles mesh_matcher.so, sets up bundled venv, packages the Electron app.
# Output: desktop-app/dist/*.dmg
#
# Requirements:
#   - Python 3.10  (brew install python@3.10)
#   - CMake 3.15+  (brew install cmake)
#   - Eigen3       (brew install eigen)
#   - Xcode Command Line Tools (xcode-select --install)
#   - Node.js 18+  (brew install node)
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="$REPO_ROOT/desktop-app"
SRC_CORE="$REPO_ROOT/src/core"
SRC_BIZ="$REPO_ROOT/src/biz"
VENV_DIR="$DESKTOP_DIR/venv"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[build-mac]${NC} $*"; }
warn()  { echo -e "${YELLOW}[build-mac]${NC} $*"; }
error() { echo -e "${RED}[build-mac] ERROR:${NC} $*"; exit 1; }

# ── 1. Prerequisites ──────────────────────────────────────────────────────────
info "Checking prerequisites..."

PYTHON=""
for candidate in python3.10 python3.11 python3.12; do
    if command -v "$candidate" &>/dev/null; then
        PYTHON=$(command -v "$candidate")
        break
    fi
done
[[ -z "$PYTHON" ]] && error "Python 3.10+ not found. Run: brew install python@3.10"
info "Python: $PYTHON ($($PYTHON --version))"

command -v cmake &>/dev/null  || error "cmake not found. Run: brew install cmake"
command -v node  &>/dev/null  || error "node not found. Run: brew install node"
command -v npm   &>/dev/null  || error "npm not found."

# Eigen3 (header-only — just needs to be findable)
EIGEN_DIR=""
for p in /opt/homebrew/include/eigen3 /usr/local/include/eigen3; do
    [[ -d "$p" ]] && { EIGEN_DIR="$p"; break; }
done
[[ -z "$EIGEN_DIR" ]] && error "Eigen3 not found. Run: brew install eigen"
info "Eigen3: $EIGEN_DIR"

# ── 2. pybind11 for the chosen Python ─────────────────────────────────────────
info "Installing pybind11 for $PYTHON..."
"$PYTHON" -m pip install pybind11 --quiet

PYBIND11_CMAKE=$("$PYTHON" -c "import pybind11; print(pybind11.get_cmake_dir())")
info "pybind11 cmake dir: $PYBIND11_CMAKE"

# ── 3. Compile C++ module ─────────────────────────────────────────────────────
info "Compiling mesh_matcher C++ module..."

# Remove LDFLAGS that may pull in Homebrew LLVM's libunwind (breaks Apple linker)
unset LDFLAGS CPPFLAGS

# Remove any stale build or prior .so files
rm -rf "$SRC_CORE/build"
mkdir -p "$SRC_CORE/build"

cmake -S "$SRC_CORE" -B "$SRC_CORE/build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_COMPILER=/usr/bin/clang \
    -DCMAKE_CXX_COMPILER=/usr/bin/clang++ \
    -DPython3_EXECUTABLE="$PYTHON" \
    -Dpybind11_DIR="$PYBIND11_CMAKE" \
    -DEIGEN3_INCLUDE_DIR="$EIGEN_DIR" \
    2>&1

cmake --build "$SRC_CORE/build" --parallel "$(sysctl -n hw.ncpu)" 2>&1

# Verify and rename if pybind11 omitted the suffix (older pybind11 bug)
EXPECTED_SUFFIX=$("$PYTHON" -c "import sysconfig; print(sysconfig.get_config_var('EXT_SUFFIX'))")
SO_NO_EXT="$SRC_BIZ/mesh_matcher"
SO_WITH_EXT="$SRC_BIZ/mesh_matcher${EXPECTED_SUFFIX}"

if [[ -f "$SO_NO_EXT" ]] && [[ ! -f "$SO_WITH_EXT" ]]; then
    mv "$SO_NO_EXT" "$SO_WITH_EXT"
    info "Renamed: mesh_matcher → mesh_matcher${EXPECTED_SUFFIX}"
fi

[[ -f "$SO_WITH_EXT" ]] || error "mesh_matcher build failed — no .so found in $SRC_BIZ"
info "Built: $(ls -lh "$SO_WITH_EXT" | awk '{print $5, $9}')"

# Quick smoke-test
"$PYTHON" -c "import sys; sys.path.insert(0,'$SRC_BIZ'); import mesh_matcher; print('  import OK:', mesh_matcher.__file__)"

# ── 4. Bundled Python venv ────────────────────────────────────────────────────
info "Creating bundled venv (--copies for relocatability)..."

rm -rf "$VENV_DIR"
"$PYTHON" -m venv --copies "$VENV_DIR"

VENV_PY="$VENV_DIR/bin/python3"

# ── 4.1 Fix Python for portability ───────────────────────────────────────
# macOS framework Python's venv bin/python3 is a stub launcher that execs
# into Python.app inside the framework — it fails outside the framework.
# Fix: replace the stub with the real interpreter binary, bundle the Python
# dylib, and rewrite the dylib reference to a relative path.
info "Fixing Python for portability..."

# Find the framework dylib (e.g. /Library/Frameworks/Python.framework/Versions/3.11/Python)
PYTHON_DYLIB=$(otool -L "$VENV_PY" | grep -oE '/[^ ]*Python\.framework/Versions/[^ ]*Python' | head -1)
FRAMEWORK_VER_DIR=""
REAL_PYTHON_BIN=""

if [[ -n "$PYTHON_DYLIB" ]]; then
    FRAMEWORK_VER_DIR=$(dirname "$PYTHON_DYLIB")
    REAL_PYTHON_BIN="$FRAMEWORK_VER_DIR/Resources/Python.app/Contents/MacOS/Python"
fi

if [[ -n "$REAL_PYTHON_BIN" ]] && [[ -f "$REAL_PYTHON_BIN" ]]; then
    # Replace the stub launcher with the real Python interpreter binary
    cp "$REAL_PYTHON_BIN" "$VENV_PY"
    info "Replaced stub with real Python binary from Python.app"

    # Bundle the Python dylib
    DYLIB_NAME=$(basename "$PYTHON_DYLIB")
    mkdir -p "$VENV_DIR/lib"
    cp "$PYTHON_DYLIB" "$VENV_DIR/lib/$DYLIB_NAME"

    # Rewrite dylib reference to relative path
    install_name_tool -change "$PYTHON_DYLIB" "@executable_path/../lib/$DYLIB_NAME" "$VENV_PY"

    # Copy stdlib into venv (the real binary has hardcoded prefix pointing to
    # the framework; we bundle the stdlib so PYTHONHOME can override the prefix)
    PY_VER=$("$PYTHON" -c "import sys; print(f'python{sys.version_info.major}.{sys.version_info.minor}')")
    FRAMEWORK_STDLIB="$FRAMEWORK_VER_DIR/lib/$PY_VER"
    if [[ -d "$FRAMEWORK_STDLIB" ]]; then
        info "Copying stdlib ($PY_VER) into venv..."
        rsync -a --exclude='site-packages' --exclude='__pycache__' --exclude='test' \
            --exclude='tests' --exclude='idle_test' --exclude='tkinter' \
            "$FRAMEWORK_STDLIB/" "$VENV_DIR/lib/$PY_VER/"
        info "Stdlib copied ($(du -sh "$VENV_DIR/lib/$PY_VER" | cut -f1) total)"
    else
        warn "Could not find stdlib at $FRAMEWORK_STDLIB"
    fi

    # Ad-hoc sign both (required on Apple Silicon)
    codesign --force --sign - "$VENV_DIR/lib/$DYLIB_NAME"
    codesign --force --sign - "$VENV_PY"
    info "Bundled $DYLIB_NAME and updated dylib reference"
elif [[ -n "$PYTHON_DYLIB" ]] && [[ -f "$PYTHON_DYLIB" ]]; then
    # Non-framework fallback: just bundle the dylib and fix reference
    DYLIB_NAME=$(basename "$PYTHON_DYLIB")
    mkdir -p "$VENV_DIR/lib"
    cp "$PYTHON_DYLIB" "$VENV_DIR/lib/$DYLIB_NAME"
    install_name_tool -change "$PYTHON_DYLIB" "@executable_path/../lib/$DYLIB_NAME" "$VENV_PY"
    codesign --force --sign - "$VENV_DIR/lib/$DYLIB_NAME"
    codesign --force --sign - "$VENV_PY"
    info "Bundled $DYLIB_NAME and updated dylib reference (non-framework)"
else
    warn "Could not find Python dylib to bundle — app may not be portable"
fi

"$VENV_PY" -m pip install --upgrade pip --quiet
"$VENV_PY" -m pip install -r "$DESKTOP_DIR/backend/requirements.txt" --quiet
info "Python packages installed into venv."

# ── 4.2 Patch pyvenv.cfg for portability ─────────────────────────────────
# pyvenv.cfg records the build machine's Python "home" path (e.g.
# /opt/homebrew/...).  On end-user machines that path won't exist.
# Rewrite "home" to point to the venv's own bin/ directory.
# The Electron main process will patch it again at runtime to the actual
# install path, but the file MUST exist (Python exit code 106 if missing).
PYVENV_CFG="$VENV_DIR/pyvenv.cfg"
VENV_BIN_ABS="$VENV_DIR/bin"
if [[ -f "$PYVENV_CFG" ]]; then
    sed -i '' "s|^home *=.*|home = ${VENV_BIN_ABS}|" "$PYVENV_CFG"
    info "Patched pyvenv.cfg: home = ${VENV_BIN_ABS}"
else
    printf 'home = %s\ninclude-system-site-packages = false\n' "$VENV_BIN_ABS" > "$PYVENV_CFG"
    info "Created pyvenv.cfg: home = ${VENV_BIN_ABS}"
fi

# ── 5. Node dependencies ──────────────────────────────────────────────────────
info "Installing Node.js dependencies..."
cd "$DESKTOP_DIR"
npm install --ignore-scripts 2>&1

# ── 6. Electron-builder ───────────────────────────────────────────────────────
info "Packaging macOS app..."

# Build for current architecture only (arm64 on Apple Silicon, x64 on Intel)
ARCH=$(uname -m)
[[ "$ARCH" == "arm64" ]] && EB_ARCH="arm64" || EB_ARCH="x64"

npx electron-builder --mac --$EB_ARCH 2>&1

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
info "============================================================"
info "  Build complete!"
info "  Output:"
ls -lh "$DESKTOP_DIR/dist/"*.dmg 2>/dev/null | awk '{print "    "$5, $9}' || true
info "============================================================"
