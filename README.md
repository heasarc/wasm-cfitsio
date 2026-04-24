# wasm-cfitsio

A WebAssembly (WASM) port of `cfitsio` and `wcslib` libraries. It is used primarily in the fviewer app.

This package allows you to read, modify, and write FITS files directly in JavaScript and TypeScript. It is designed to work in both Node.js and modern web browsers.

---

## Installation

To use it locally in another project:
```bash
# In this directory:
npm link

# In your target project:
npm link wasm-cfitsio
```

Alternatively, run `npm pack` to package it in a tar file, then install it in other applications with `npm add /path/to/wasm-cfitsio-??.tgz`

---

## Quick Start

### 1. Reading an Image
```typescript
import fs from 'fs';
import { FitsFile } from 'wasm-cfitsio';

async function readImage() {
    // Load the raw FITS file bytes
    const fileData = new Uint8Array(fs.readFileSync('image.fits'));
    
    // Initialize the WebAssembly module and open the file
    const fits = await FitsFile.open(fileData);

    try {
        console.log("Telescope:", fits.readKeyword("TELESCOP"));

        // Move to the image extension if the primary HDU is empty
        if (fits.getNumHDUs() > 1) fits.moveToHDU(2);

        // Read the image data (Zero-copy)
        const image = fits.readImage();
        
        console.log(`FITS BITPIX: ${image.bitpix}`);
        console.log(`JS Array Type: ${image.dataType}`);
        console.log("Pixels:", image.data); // e.g., Float32Array
    } finally {
        // ALWAYS close to free WebAssembly memory!
        fits.close(); 
    }
}
```

### 2. Reading a Table
```typescript
import { FitsFile } from 'wasm-cfitsio';

async function readTable(fileData: Uint8Array) {
    const fits = await FitsFile.open(fileData);

    try {
        fits.moveToHDU(2); // Tables are usually in extensions
        
        console.log(`Table has ${fits.getNumRows()} rows and ${fits.getNumCols()} columns.`);

        // Read column 1 (1-indexed)
        const col1 = fits.readColumn(1);
        console.log(col1.data); // Returns the exact TypedArray or String[]
    } finally {
        fits.close();
    }
}
```

### 3. Modifying and Saving a FITS File
```typescript
import { FitsFile } from 'wasm-cfitsio';

async function modifyFile(fileData: Uint8Array) {
    const fits = await FitsFile.open(fileData);

    try {
        // Modify Header
        fits.updateKeyString("OBSERVER", "John Doe", "Name of observer");
        fits.updateKeyDouble("EXPTIME", 150.5, "Exposure time in seconds");

        // Modify Table Data (Multiply column 1 by 10)
        fits.moveToHDU(2);
        const col = fits.readColumn(1);
        if (col.dataType !== "StringArray") {
            const modifiedData = col.data.map((val: number) => val * 10);
            fits.writeColumn(1, modifiedData);
        }

        // Export the modified FITS file
        const newFileBytes = fits.save();
        // You can now write `newFileBytes` to disk or trigger a browser download!
        
    } finally {
        fits.close();
    }
}
```

---

## Development & Building from Source

This project requires the [Emscripten SDK](https://emscripten.org/) to compile the C++ source code to WebAssembly.

### Prerequisites
1. Install Node.js and NPM.
2. Install Emscripten (`emsdk`) and ensure `emcc` is in your `PATH`.
3. Install CMake (`brew install cmake` or `apt-get install cmake`).

### Build Instructions
The build script automatically downloads the `cfitsio` source code, patches macOS cross-compilation quirks, compiles the static library, and builds the WebAssembly module.

```bash
# 1. Clone the repository
git clone git@sed-gitlab.gsfc.nasa.gov:heasarc/heasoft/cfitsio-wasm.git
cd wasm-cfitsio

# 2. Install dependencies
npm install

# 3. Build the WebAssembly module
npm run build
```
The compiled files will be output to the `dist/` directory.

### Testing
This project uses **Vitest** for highly concurrent ES Module testing.

```bash
npm run test
```

