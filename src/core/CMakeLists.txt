cmake_minimum_required(VERSION 3.15)
project(mesh_matcher)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Find Python
find_package(Python3 COMPONENTS Interpreter Development REQUIRED)

# Find pybind11 - use pybind11's own cmake tools
# pybind11 installed via pip provides cmake tools in site-packages
execute_process(
    COMMAND ${Python3_EXECUTABLE} -c "import pybind11; print(pybind11.get_cmake_dir())"
    OUTPUT_VARIABLE pybind11_DIR
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET
)

if(pybind11_DIR)
    list(APPEND CMAKE_PREFIX_PATH ${pybind11_DIR})
    message(STATUS "Found pybind11 at: ${pybind11_DIR}")
endif()

find_package(pybind11 REQUIRED)

# Find Eigen3
find_package(Eigen3 QUIET)
if(NOT Eigen3_FOUND)
    # Try to find Eigen3 in common locations
    find_path(EIGEN3_INCLUDE_DIR
        NAMES Eigen/Dense
        PATHS
            /usr/include/eigen3
            /usr/local/include/eigen3
            /opt/homebrew/include/eigen3
    )
    if(EIGEN3_INCLUDE_DIR)
        message(STATUS "Found Eigen3: ${EIGEN3_INCLUDE_DIR}")
    else()
        message(FATAL_ERROR "Eigen3 not found. Please install libeigen3-dev")
    endif()
else()
    set(EIGEN3_INCLUDE_DIR ${EIGEN3_INCLUDE_DIRS})
endif()

# Include directories
include_directories(${EIGEN3_INCLUDE_DIR})

# Source files
set(SOURCES
    matcher.cpp
    bvh.cpp
    pybind_wrapper.cpp
    kdtree.h
    bvh.h
)

# Create Python module
pybind11_add_module(mesh_matcher ${SOURCES})

# Include Eigen headers
target_include_directories(mesh_matcher PRIVATE ${EIGEN3_INCLUDE_DIR})

# Set output directory — let pybind11 set PREFIX/SUFFIX automatically
set_target_properties(mesh_matcher PROPERTIES
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../biz"
)

# Find OpenMP
find_package(OpenMP)
if(OpenMP_CXX_FOUND)
    message(STATUS "OpenMP found, enabling parallel processing")
    target_link_libraries(mesh_matcher PUBLIC OpenMP::OpenMP_CXX)
else()
    message(WARNING "OpenMP not found, parallel processing disabled")
endif()

# Compiler flags for optimization (cross-platform)
if(MSVC)
    target_compile_options(mesh_matcher PRIVATE $<$<CONFIG:Release>:/O2 /GL>)
else()
    target_compile_options(mesh_matcher PRIVATE
        $<$<CONFIG:Release>:-O3 -march=native -ffast-math>
        $<$<CONFIG:Debug>:-g -O0>
    )
endif()

# Add Eigen include to source files
target_compile_definitions(mesh_matcher PRIVATE EIGEN_DONT_PARALLELIZE)
