# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

3D shoe model matching system that finds optimal pairings between 3D shoe models (鞋模) and blank shoes (粗胚) using a genetic algorithm. The core algorithm runs in C++ with Python bindings, wrapped by a Python business layer, and exposed via a web viewer (Flask) and desktop app (Electron).

## Architecture

```
src/core/          → C++ matching engine (BVH, KD-tree, genetic algorithm, pybind11 bindings)
src/biz/           → Python orchestration layer (CLI, file loading, test runner)
src/viz/           → Flask web preview server
desktop-app/       → Electron desktop app with embedded Flask backend
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

**Desktop app:**
```bash
cd desktop-app && npm install
npm run build:mac   # or build:win
```

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

## Key CLI Parameters

Defined in `src/biz/matcher.py` and mapped to C++ `GeneticAlgorithmParams`:

| Parameter | Default | Description |
|---|---|---|
| `--verbose` | off | Enable detailed logging |
| `--wrapping-threshold` | 1.0 | Minimum wrapping ratio to accept a match |
| `--ga-population-size` | 50 | GA population size |
| `--ga-max-generations` | 30 | GA max generations |
| `--ga-target-wrapping-ratio` | 0.96 | Stop early when this wrapping ratio is reached |

## Algorithm Summary

1. Load 3DM files (rhino3dm) → extract meshes
2. PCA to compute longitudinal/vertical axes for both target and candidate
3. Validate axis alignment (≤0.1° tolerance)
4. Genetic algorithm simultaneously optimizes: longitudinal translation (±50mm), rotation around longitudinal axis (±180°), lateral offset (±30mm)
5. Compute wrapping ratio (volume-based containment) and 96th-percentile surface clearance
6. Return minimum-volume valid match

Spatial acceleration: BVH (`src/core/bvh.cpp`) + KD-tree (`src/core/kdtree.h`). Parallelism via OpenMP.

## Output Formats

Results can be exported as CSV, JSON, or HTML from `test_all_matches.py`. Match results include: volume, wrapping ratio, clearance (mm), direction alignment, generation history, and timing.
