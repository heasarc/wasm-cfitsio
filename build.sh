#!/bin/bash
set -e # Stop the script immediately if any command fails

CFITSIO_VERSION="4.6.3"
CFITSIO_DIR="cfitsio-${CFITSIO_VERSION}"
CFITSIO_BUILD_DIR="${CFITSIO_DIR}/build"
LIBCFITSIO="${CFITSIO_BUILD_DIR}/libcfitsio.a"

echo "=== WASM-CFITSIO BUILD SCRIPT ==="

# Step 1: Download and extract cfitsio if it doesn't exist
if [ ! -d "$CFITSIO_DIR" ]; then
    echo "[1/3] Downloading cfitsio source code..."
    curl -O https://heasarc.gsfc.nasa.gov/FTP/software/fitsio/c/cfitsio-${CFITSIO_VERSION}.tar.gz
    tar -zxvf cfitsio-${CFITSIO_VERSION}.tar.gz
    rm cfitsio-${CFITSIO_VERSION}.tar.gz
else
    echo "[1/3] cfitsio source already exists. Skipping download."
fi

# Step 2: Compile libcfitsio.a if it doesn't exist
if [ ! -f "$LIBCFITSIO" ]; then
    echo "[2/3] Compiling libcfitsio.a for WebAssembly..."
    
    # Neutralize macOS C/C++ environment variables to prevent Apple SDK conflicts
    unset SDKROOT CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH LIBRARY_PATH MACOSX_DEPLOYMENT_TARGET
    
    mkdir -p "$CFITSIO_BUILD_DIR"
    cd "$CFITSIO_BUILD_DIR"

    emcmake cmake .. \
      -DUSE_CURL=OFF \
      -DUSE_BZIP2=OFF \
      -DBUILD_SHARED_LIBS=OFF \
      -DCMAKE_C_FLAGS="-s USE_ZLIB=1 -O3 -DgFortran -D__i386__" \
      -DM_LIB=m

    emmake make cfitsio -j4
    
    # Go back to the root project folder
    cd ../../
else
    echo "[2/3] libcfitsio.a already compiled. Skipping."
fi

# Step 3: Build the final WebAssembly JS module
echo "[3/3] Compiling JavaScript/WASM wrapper..."
mkdir -p dist

emcc src/cpp/wrapper.cpp "$LIBCFITSIO" \
  -o dist/fits.js \
  -I "$CFITSIO_DIR" \
  -O3 \
  -s USE_ZLIB=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s EXPORT_ES6=1 \
  -s MODULARIZE=1 \
  -s EXPORT_NAME="createFitsModule" \
  -s FORCE_FILESYSTEM=1 \
  -s EXPORTED_RUNTIME_METHODS="['FS', 'HEAPU8']" \
  -s EXPORTED_FUNCTIONS="['_malloc', '_free']" \
  -s WASM_BIGINT=1 \
  -D__i386__ \
  --bind

echo "Copying API wrappers to dist..."
cp src/index.js dist/
cp src/index.d.ts dist/

echo "=== BUILD COMPLETE! Output is in the dist/ folder ==="