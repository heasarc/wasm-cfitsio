#!/bin/bash
## Copyright 2026, University of Maryland, All Rights Reserved

set -e # Stop the script immediately if any command fails

CFITSIO_VERSION="4.6.3"
CFITSIO_DIR="cfitsio-${CFITSIO_VERSION}"
CFITSIO_BUILD_DIR="${CFITSIO_DIR}/build"
LIBCFITSIO="${CFITSIO_BUILD_DIR}/libcfitsio.a"

WCSLIB_VERSION="8.6"
WCSLIB_DIR="wcslib-${WCSLIB_VERSION}"
LIBWCS="${WCSLIB_DIR}/C/libwcs-${WCSLIB_VERSION}.a"

# Neutralize macOS C/C++ environment variables to prevent Apple SDK conflicts
unset SDKROOT CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH LIBRARY_PATH MACOSX_DEPLOYMENT_TARGET

echo "=== WASM-CFITSIO + WCSLIB BUILD SCRIPT ==="

# Step 1: Download and extract cfitsio
if [ ! -d "$CFITSIO_DIR" ]; then
    echo "[1/4] Downloading cfitsio..."
    curl -O https://heasarc.gsfc.nasa.gov/FTP/software/fitsio/c/cfitsio-${CFITSIO_VERSION}.tar.gz
    tar -zxvf cfitsio-${CFITSIO_VERSION}.tar.gz
    rm cfitsio-${CFITSIO_VERSION}.tar.gz
fi

# Step 2: Compile libcfitsio.a
if [ ! -f "$LIBCFITSIO" ]; then
    echo "[2/3] Compiling libcfitsio.a for WebAssembly..."
    
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
fi

# Step 3: Download and Compile wcslib
if [ ! -d "$WCSLIB_DIR" ]; then
    echo "[3/4] Downloading wcslib..."
    # ATNF provides the official WCSLIB distributions via HTTPS
    curl -O https://www.atnf.csiro.au/computing/software/wcs/wcslib-releases/wcslib-${WCSLIB_VERSION}.tar.bz2
    tar -xjvf wcslib-${WCSLIB_VERSION}.tar.bz2
    rm wcslib-${WCSLIB_VERSION}.tar.bz2
fi

if [ ! -f "$LIBWCS" ]; then
    echo "[3/4] Compiling libwcs.a..."
    cd "$WCSLIB_DIR"

    echo "Updating GNU config scripts for WASM support..."
    
    # Configure specifically for WebAssembly
    # We disable Fortran, utilities, and pgplot to keep it lightweight
    emconfigure ./configure \
        --host=i686-pc-linux-gnu \
        --disable-fortran \
        --disable-utils \
        --disable-shared \
        --without-pgplot \
        --without-cfitsio \
        CFLAGS="-O3"
        
    # Build ONLY the C library (avoids building tests that fail to link in WASM)
    emmake make -C C -j4
    
    cd ../
fi

# Step 4: Build the final WebAssembly module
echo "[4/4] Compiling JavaScript/WASM wrapper..."
mkdir -p dist

emcc src/cpp/wrapper.cpp "$LIBCFITSIO" "$LIBWCS" \
  -o dist/fits.js \
  -I "$CFITSIO_DIR" \
  -I "$WCSLIB_DIR/C" -I "$WCSLIB_DIR" \
  -O3 \
  -s USE_ZLIB=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s EXPORT_ES6=1 \
  -s MODULARIZE=1 \
  -s SINGLE_FILE=1 \
  -s ENVIRONMENT='web,worker' \
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