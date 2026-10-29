# WebAssembly target

The CMake target is an Emscripten/SDL2 canvas smoke scaffold. It requests an OpenGL ES 3.0 context, which Emscripten maps to WebGL 2. It does not contain or call the RBDOOM-3-BFG engine yet.

Install the project-local Emscripten SDK as shown in the root README, then dot-source `scripts/emsdk-env.ps1` before building. Configure from the repository root with `cmake --preset web-debug`, then build with `cmake --build --preset web-debug`. The smoke module has been compiled and loaded in the local WebGL2 browser shell. Generated files go to `web/public/engine/` and are ignored by Git.

The actual engine integration must preserve the JS module boundary in `web/src/main.ts` or replace it deliberately. Do not preload or commit commercial game data.
