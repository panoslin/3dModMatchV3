# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

3D shoe model matching system that finds optimal pairings between 3D shoe models (鞋模) and blank shoes (粗胚) using a genetic algorithm. The core algorithm runs in C++ with Python bindings, wrapped by a Python business layer, and exposed via a web viewer (Flask) and desktop app (Electron).

## Architecture

```
src/core/          → C++ matching engine (BVH, KD-tree, genetic algorithm, pybind11 bindings)
src/biz/           → Python orchestration layer (CLI, file loading, test runner)
src/viz/           → Flask web preview server (standalone, for Docker-based viewing)
desktop-app/       → Electron desktop app with embedded Flask backend
  backend/         → Flask REST API (server.py: blanks, shoes, categories, matching, history)
  js/              → Frontend modules (api, app, blank-manager, match-manager, history-manager, result-detail-view, 3d-viewer)
  main.js          → Electron main process (spawns Flask backend as child process)
scripts/           → Build helper scripts (build-mac.sh, build-win.ps1)
testcases/         → 4 test case directories (testcase{1-4}/target/ + candidate_set/)
docs/              → Algorithm explanation, debugging parameters, Docker usage
```

The C++ module compiles to `src/biz/mesh_matcher.so` (macOS/Linux) or `.pyd` (Windows) and is imported by `src/biz/matcher.py`.

## Build

**C++ module (required before running matcher):**
```bash
cd src/core
mkdir -p build && cd build
cmake -DCMAKE_BUILD_TYPE=Release ..
make -j$(nproc)
```
Requires: CMake 3.15+, gcc/g++, Eigen3, pybind11, Python 3.8+.

**Docker (preferred, handles all dependencies):**
```bash
docker build -f Dockerfile -t 3dm-matcher:latest .
```

### Desktop App Packaging

`npm run build:mac` / `npm run build:win` only runs `electron-builder`, which packages the Electron app but does **not** compile the C++ module or set up the Python venv. Use the full build scripts instead:

**macOS (must run on Mac):**
```bash
bash scripts/build-mac.sh
# Output: desktop-app/dist/*.dmg
```
Prerequisites: Python 3.10+ (`brew install python@3.10`), CMake (`brew install cmake`), Eigen3 (`brew install eigen`), Xcode Command Line Tools, Node.js 18+.

**Windows (must run on Windows, no cross-compile):**
```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-win.ps1
# Output: desktop-app\dist\*.exe (NSIS installer)
```
Prerequisites: Python 3.10-3.12 (python.org, add to PATH), CMake 3.15+, Visual Studio 2019/2022 with "Desktop development with C++" workload, Node.js 18+.

Both scripts perform the full pipeline:
1. Check prerequisites (Python, CMake, compiler, Node.js)
2. Install pybind11 and locate Eigen3 headers
3. Compile `mesh_matcher.so` (macOS) or `mesh_matcher.pyd` (Windows)
4. Create bundled Python venv with backend dependencies
5. `npm install`
6. `electron-builder` → DMG (macOS) or NSIS installer (Windows)

### CI/CD (GitHub Actions)

`.github/workflows/build-release.yml` builds both platforms in parallel:
- **Tag push** (`git tag v1.0.0 && git push --tags`): builds macOS + Windows, creates draft Release with artifacts
- **Manual trigger**: builds both, artifacts downloadable from Actions page (no Release created)

macOS builds on `macos-14` (ARM), Windows on `windows-latest` (VS2022).

## Running

**Single test case:**
```bash
# Docker
docker-compose run --rm test-3dm-loader python src/biz/matcher.py /app/testcases/testcase1 --verbose

# Direct (after building C++ module)
python src/biz/matcher.py /path/to/testcase --verbose
```

**All test cases:**
```bash
docker-compose run --rm test-3dm-loader \
  python src/biz/test_all_matches.py /app/testcases --verbose \
  --output-csv results.csv --output-html results.html
```

**Web viewer (port 5001):**
```bash
docker-compose up web-viewer
```

**Desktop app (dev mode):**
```bash
cd desktop-app && npm run dev
```

## Desktop App Architecture

The Electron app embeds a Flask backend (`desktop-app/backend/server.py`) that provides REST APIs for:

- **Blank management**: Upload/delete/categorize 3DM blank files, organized in a category tree
- **Shoe management**: Upload shoe model files for matching
- **Matching**: Execute GA-based matching (calls C++ module via `src/biz/matcher.py`), with concurrent task support
- **History**: Grouped-by-shoe match history with detail drill-down, CSV/Excel export

Frontend modules:
- `result-detail-view.js` — Shared detail view used by both match results and history pages
- `3d-viewer.js` — Three.js-based 3D model viewer (STL rendering with orbit controls)

All timestamps use China timezone (UTC+8). SQLite database stores blanks, shoes, categories, and completed match tasks.

## Key CLI Parameters

Defined in `src/biz/matcher.py` and mapped to C++ `GeneticAlgorithmParams`:

| Parameter | Default | Description |
|---|---|---|
| `--verbose` | off | Enable detailed logging |
| `--wrapping-threshold` | 0.96 | Minimum wrapping ratio to accept a match (final pass/fail authority) |
| `--inside-tolerance-mm` | 0.1 | Signed distance ≤ this counts as "inside" for wrap/clearance |
| `--icp-warmstart` / `--no-icp-warmstart` | on | PCA-seeded 16-start ICP path, competes with PCA path (higher wrap wins) |
| `--containment-refine` / `--no-containment-refine` | on | scipy L-BFGS-B + multi-scale Nelder-Mead refine after ICP (adaptive budget, SDF-grid accelerated) |
| `--no-early-exit` | off | Disable ascending-volume early exit (early exit is exactly equivalent to full scan for the winner; disable only for full comparison reports) |
| `--ga-population-size` | 50 | GA population size |
| `--ga-max-generations` | 30 | GA max generations |
| `--ga-target-wrapping-ratio` | 0.96 | GA early-stop only (does NOT affect final pass/fail) |
| `--ga-crossover-rate` | 0.8 | Crossover probability |
| `--ga-mutation-rate` | 0.1 | Mutation probability |
| `--ga-mutation-scale` | 0.1 | Mutation perturbation scale |
| `--ga-selection-rate` | 0.5 | Elite retention fraction |
| `--ga-translation-range` | 50.0 mm | Longitudinal displacement search range |
| `--ga-rotation-range` | 180.0° | Roll (around longitudinal axis) search range |
| `--ga-lateral-range` | 30.0 mm | Lateral displacement search range |
| `--ga-vertical-range` / `--ga-pitch-range` / `--ga-yaw-range` | 0 | 6-DOF extension; any >0 enables 6-DOF mode |
| `--ga-6dof` | off | Shortcut: vertical=10mm, pitch=yaw=5° |
| `--num-sample-points` | 500 | GA fitness sample count (promising candidates auto-bump to 2000); final wrap/clearance metrics use max(this, 5000) |

## Algorithm Summary

1. Load mesh files (`load_mesh.py`: .3dm via rhino3dm, .stl via trimesh with normal/winding repair)
2. Path A (PCA): compute longitudinal (PCA 1st component) / vertical (principal normal or global Z) axes, auto-rotate target into candidate frame (angles are recorded but not validated — alignment is automatic, not checked against a tolerance)
3. Path B (default-on, skipped if Path A wrap ≥0.97): 16-seed PCA-initialized ICP warm-start → containment-refine (scipy, penalizes only outside points, adaptive restart budget) → count-polish (soft-count Nelder-Mead in 6-DOF for borderline candidates, refine wrap 0.90–0.97: the quadratic hinge optimum ≠ count optimum) → GA with `skip_align_directions=True` and small 6-DOF polish windows
4. Genetic algorithm (deterministic seed; population seeded with centroid-aligned + identity individuals so a pre-aligned pose can never regress) optimizes longitudinal translation, roll, lateral offset (+ optional vertical/pitch/yaw in 6-DOF mode); fitness = BVH containment ratio of area-uniform surface samples
5. Final metrics on the GA-optimized pose: wrapping ratio and 96th-percentile clearance from one batch of ≥5000 area-uniform BVH signed distances (exact point-triangle distance + 3-orthogonal-ray parity voting with shared-edge t-deduplication); area-uniform sampling replaces vertex-stride sampling so unevenly tessellated meshes (e.g. dense scans) are not over-weighted
6. A candidate passes if wrap ≥ `--wrapping-threshold`; among passing candidates the minimum-volume one wins

Spatial acceleration: BVH (`src/core/bvh.cpp`) for all containment/distance queries. Parallelism via OpenMP; pybind releases the GIL during matching so concurrent Python threads stay responsive.

## Output Formats

Results can be exported as CSV, JSON, or HTML from `test_all_matches.py`. Match results include: volume, wrapping ratio, clearance (mm), direction alignment, generation history, and timing.

Desktop app additionally supports Excel export via XLSX.js.
