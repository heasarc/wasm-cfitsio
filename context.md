**Project Overview:**
I have built a high-performance WebAssembly (WASM) library named `wasm-cfitsio` that ports the NASA/HEASARC `cfitsio` library and the ATNF `wcslib` library to JavaScript/TypeScript. It allows Node.js and Browser applications to read, modify, and write FITS (Flexible Image Transport System) files using zero-copy memory transfers and dynamic JS `TypedArrays`.

**Current Project State & Features:**
1. **Universal Compatibility:** Compiled with Emscripten's `-s SINGLE_FILE=1` flag. The WASM binary is Base64-inlined into `fits.js`, meaning no bundler config or `.wasm` file serving is required. It works flawlessly in Node.js, React, Vite, and Vanilla JS.
2. **Virtual File System (MEMFS):** Files are passed from JS as `Uint8Array` into Emscripten's virtual file system, isolating the library from the host OS and preventing path traversal vulnerabilities.
3. **Dynamic Typing & Vector Support:** Reads FITS images (`BITPIX`) and table columns (`TFORM`) and automatically maps them to the exact JavaScript TypedArray (`Int16Array`, `Float32Array`, `BigInt64Array`, etc.) or `StringArray` for ASCII/String tables. **Also supports Fixed-Length Vector columns (e.g., `3D`, where `repeat > 1`) and Variable-Length Arrays (VLAs, e.g., `1PJ`, where `typecode < 0`). Vector and VLA data is passed across the WASM boundary as a single flat buffer, then sliced using zero-copy `.subarray()` views into a standard JS Array of `TypedArrays` mapped to each row.**
4. **Modifying & Writing:** Supports opening files in `READWRITE`, updating header keywords, overwriting table column data (by writing safely to `HEAPU8` memory), and flushing the modified file back out to a JS `Uint8Array` to save to disk.
5. **WCS Support:** The C++ wrapper links against `wcslib`. It parses FITS headers (`wcspih`) and performs Sky-to-Pixel and Pixel-to-Sky spherical coordinate transformations (`worldToPix`, `pixToWorld` and `getPixelScale`).
6. **API & Testing:** Wrapped in a clean TypeScript/JavaScript class (`FitsFile`) with a `Vitest` test suite verifying Images, Binary Tables (Scalars, Vectors, and VLAs), and ASCII Tables.

**Project Structure:**
```text
wasm-cfitsio/
├── build.sh            # Automated bash script to download, compile, and package the libraries
├── package.json        # NPM package config (type: module, test: vitest)
├── .gitignore          # Ignores downloaded C code and build outputs
├── src/
│   ├── index.js        # The clean JS API wrapper (FitsFile class)
│   ├── index.d.ts      # TypeScript definitions
│   └── cpp/
│       └── wrapper.cpp # The C++ Embind wrapper bridging cfitsio/wcslib to JS (uses fits_read_descript for VLA parsing)
├── tests/
│   ├── fits.test.js    # Vitest suite
│   └── fixtures/       # test.fits, btable.fits, ascii.fits, vector_table.fits
└── dist/               # Final output folder (index.js, index.d.ts, fits.js)
```

**Crucial Build Quirks & Workarounds (Do not change these):**
* **Mac OS C++ Conflicts:** The `build.sh` explicitly runs `unset SDKROOT CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH LIBRARY_PATH MACOSX_DEPLOYMENT_TARGET` to prevent Apple's native headers from crashing the WASM cross-compilation.
* **Byte-swapping (cfitsio):** Emscripten compile commands explicitly pass `-D__i386__` so `cfitsio` recognizes a Little-Endian 32-bit architecture and correctly applies byte-swapping logic.
* **Memory Management:** Modifying arrays from JS into C++ uses `Module.HEAPU8.set()` to safely bypass Emscripten's aggressive minifier. `-s EXPORTED_RUNTIME_METHODS="['FS', 'HEAPU8']"` and `-s EXPORTED_FUNCTIONS="['_malloc', '_free']"` are strictly required in the `emcc` command.

**My Goal for this Session:**
*(State what you want the AI to do next here, e.g., "I want to add support for FITS Data Cubes (3D arrays)" or "Help me integrate this into a React hook.")*