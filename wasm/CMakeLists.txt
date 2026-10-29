cmake_minimum_required(VERSION 3.24)
project(doom3_bfg_web LANGUAGES CXX)

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "Configure with the Emscripten CMake toolchain. See CMakePresets.json.")
endif()

add_executable(doom3_bfg_web src/main.cpp)
set_target_properties(doom3_bfg_web PROPERTIES
  CXX_STANDARD 17
  CXX_STANDARD_REQUIRED YES
  SUFFIX ".js"
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../web/public/engine"
)

target_compile_options(doom3_bfg_web PRIVATE
  "-sUSE_SDL=2"
)

target_link_options(doom3_bfg_web PRIVATE
  "-sUSE_SDL=2"
  "-sMIN_WEBGL_VERSION=2"
  "-sMAX_WEBGL_VERSION=2"
  "-sFULL_ES3=1"
  "-sMODULARIZE=1"
  "-sEXPORT_ES6=1"
  "-sEXPORT_NAME=createDoom3BfgEngine"
  "-sALLOW_MEMORY_GROWTH=1"
  "-sENVIRONMENT=web"
  "-sEXIT_RUNTIME=0"
)
