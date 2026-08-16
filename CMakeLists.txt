cmake_minimum_required(VERSION 3.16)

project(NetPulse-DPI VERSION 2.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Header files
include_directories(${CMAKE_SOURCE_DIR}/include)

# ============================================================
# DPI Engine - Multi-threaded version
# Same implementation that is currently working with dpi_mt.cpp
# ============================================================

set(DPI_ENGINE_SOURCES
    src/dpi_mt.cpp
    src/pcap_reader.cpp
    src/packet_parser.cpp
    src/sni_extractor.cpp
    src/types.cpp
)

add_executable(dpi_engine ${DPI_ENGINE_SOURCES})

target_include_directories(dpi_engine PRIVATE
    ${CMAKE_SOURCE_DIR}/include
)

# Enable multithreading
if(MSVC)
    target_compile_options(dpi_engine PRIVATE /O2 /EHsc)
else()
    target_compile_options(dpi_engine PRIVATE -O2 -pthread)
    target_link_options(dpi_engine PRIVATE -pthread)
endif()