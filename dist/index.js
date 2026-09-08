// Copyright 2026, University of Maryland, All Rights Reserved

import createFitsModule from './fits.js';

let wasmModule = null;
let fileCounter = 0; // Ensures unique virtual filenames if opening multiple files

export class FitsFile {
    constructor(wasmModule, virtualFilename, fitsInstance) {
        this.module = wasmModule;
        this.filename = virtualFilename;
        this.fits = fitsInstance;
    }

    /**
     * Opens a FITS file from a Uint8Array
     * @param {Uint8Array} fileData 
     * @returns {Promise<FitsFile>}
     */
    static async open(fileData) {
        if (!wasmModule) {
            wasmModule = await createFitsModule();
        }

        const virtualFilename = `/file_${fileCounter++}.fits`;
        wasmModule.FS.writeFile(virtualFilename, fileData);

        const fitsInstance = new wasmModule.FitsWrapper(virtualFilename);
        
        if (fitsInstance.getStatus() !== 0) {
            fitsInstance.delete();
            wasmModule.FS.unlink(virtualFilename);
            throw new Error(`Failed to open FITS file. Status: ${fitsInstance.getStatus()}`);
        }

        return new FitsFile(wasmModule, virtualFilename, fitsInstance);
    }

    getNumHDUs() { return this.fits.getNumHDUs(); }
    moveToHDU(hduNum) { return this.fits.moveToHDU(hduNum); }
    
    readKeyword(keyword) { return this.fits.readKeyword(keyword) ?? null; }
    readHeader() { return this.fits.readHeader(); }

    hasWCS() { return this.fits.initWCS(); }
    getWCSCount() { return this.fits.getWCSCount(); }
    setActiveWCS(index) { return this.fits.setActiveWCS(index); }
    pixToWorld(x, y) { return this.fits.pixToWorld(Number(x), Number(y)); }
    worldToPix(ra, dec) { return this.fits.worldToPix(Number(ra), Number(dec)); }
    getPixelScale() { return this.fits.getPixelScale() ?? null; }
    
    /**
     * Reads an image or a subset/slice of an image. 
     * If no params are provided, reads the entire image at 1:1 scale.
     * @param {number[]|null} fpixel - 1-indexed start coordinates [x, y, z...]
     * @param {number[]|null} lpixel - 1-indexed end coordinates [x, y, z...]
     * @param {number[]|null} inc - step size [x, y, z...]
     */
    readImage(fpixel = null, lpixel = null, inc = null) { 
        // Pass the arguments down to C++ (Emscripten will see 3 arguments)
        const result = this.fits.readImage(fpixel, lpixel, inc);
        if (!result || !result.data) return null;
        
        // We slice() it to copy it out of WASM memory before it gets freed,
        // dynamically creating the exact right JS TypedArray!
        let safeData;
        switch(result.dataType) {
            case "Uint8Array": safeData = new Uint8Array(result.data.slice()); break;
            case "Int16Array": safeData = new Int16Array(result.data.slice()); break;
            case "Int32Array": safeData = new Int32Array(result.data.slice()); break;
            case "BigInt64Array": safeData = new BigInt64Array(result.data.slice()); break;
            case "Float32Array": safeData = new Float32Array(result.data.slice()); break;
            case "Float64Array": safeData = new Float64Array(result.data.slice()); break;
            default: safeData = new Float32Array(result.data.slice());
        }
        const pixScale = this.fits.getPixelScale();

        return {
            bitpix: result.bitpix,
            dataType: result.dataType,
            data: safeData,
            pixScale: pixScale,
            naxes: result.naxes,             // The full size of the hypercube
            subsetWidth: result.subsetWidth, // The width of the extracted slice
            subsetHeight: result.subsetHeight// The height of the extracted slice
        };
    }

    getNumRows() { return this.fits.getNumRows(); }
    getNumCols() { return this.fits.getNumCols(); }

    /**
     * Gets the schema information (name, unit, format, type) for a specific column.
     * @param {number} colNum - The 1-indexed column number
     * @returns {Object|null}
     */
    getColumnInfo(colNum) {
        const info = this.fits.getColumnInfo(colNum);
        if (!info) return null;
        
        // Clean up cfitsio string formatting (removes trailing spaces and quotes)
        const cleanString = (str) => str ? str.replace(/^'|'$/g, '').trim() : "";
        
        return {
            typecode: info.typecode,
            repeat: info.repeat,
            width: info.width,
            name: cleanString(info.name),
            unit: cleanString(info.unit),
            form: cleanString(info.form)
        };
    }

    /**
     * Writes a single numeric value to a specific cell in the FITS table.
     * @param {number} colNum - The 1-indexed column number
     * @param {number} rowNum - The 1-indexed row number
     * @param {number} value - The numeric value to write
     */
    writeCell(colNum, rowNum, value, firstElem = 1) {
        const status = this.fits.writeCellDouble(colNum, rowNum, firstElem, Number(value));
        if (status !== 0) {
            throw new Error(`Failed to write cell. Status: ${status}`);
        }
        return status;
    }

    // --- Table Mutations ---
    insertRows(firstRow, numRows = 1) { 
        return this.fits.insertRows(firstRow, numRows); 
    }
    
    deleteRows(firstRow, numRows = 1) { 
        return this.fits.deleteRows(firstRow, numRows); 
    }
    
    insertColumn(colNum, name, format) { 
        return this.fits.insertColumn(colNum, name, format); 
    }
    
    deleteColumn(colNum) { 
        return this.fits.deleteColumn(colNum); 
    }
    
    changeColumnName(colNum, newName) {
        return this.fits.changeColumnName(colNum, newName);
    }

    changeColumnUnit(colNum, newUnit) {
        return this.fits.changeColumnUnit(colNum, newUnit);
    }

    changeColumnFormat(colNum, newFormat) {
        return this.fits.changeColumnFormat(colNum, newFormat);
    }
    
    /**
     * Extracts a specific column from the table.
     * @param {number} colNum - The 1-indexed column number
     * @param {number} [firstRow=1] - The 1-indexed starting row (default: 1)
     * @param {number} [numRows=-1] - The number of rows to read (default: all remaining)
     */
    readColumn(colNum, firstRow = 1, numRows = -1) { 
        const result = this.fits.readColumn(colNum, Number(firstRow), Number(numRows));
        if (!result || !result.data) return null;
        
        let safeData;
        switch(result.dataType) {
            case "Uint8Array": safeData = new Uint8Array(result.data.slice()); break;
            case "Int16Array": safeData = new Int16Array(result.data.slice()); break;
            case "Int32Array": safeData = new Int32Array(result.data.slice()); break;
            case "BigInt64Array": safeData = new BigInt64Array(result.data.slice()); break;
            case "Float32Array": safeData = new Float32Array(result.data.slice()); break;
            case "Float64Array": safeData = new Float64Array(result.data.slice()); break;
            case "StringArray": safeData = result.data; break; // Strings already arrive as a JS Array of strings
            default: safeData = new Float64Array(result.data.slice());
        }

        // Unify Fixed-Length Vectors (repeat > 1) and Variable-Length Arrays (VLAs)
        if ((result.isVLA || result.repeat > 1) && result.dataType !== "StringArray") {
            const rowArrays = [];
            let currentOffset = 0;
            
            // Determine how many rows we have
            const calculatedNumRows = result.isVLA ? result.vlaLengths.length : (safeData.length / result.repeat);
            
            for (let i = 0; i < calculatedNumRows; i++) {
                const len = result.isVLA ? result.vlaLengths[i] : result.repeat;
                rowArrays.push(safeData.subarray(currentOffset, currentOffset + len));
                currentOffset += len;
            }
            safeData = rowArrays;
        }

        return {
            typecode: result.typecode,
            dataType: result.dataType,
            repeat: result.repeat,
            isVLA: result.isVLA,
            data: safeData
        };
    }

    /**
     * Overwrites a column with new data. 
     * @param {number} colNum - The 1-indexed column number
     * @param {TypedArray} dataArray - The modified TypedArray (e.g., Float64Array)
     */
    writeColumn(colNum, dataArray) {
        let typecode;

        if (dataArray instanceof Uint8Array)      { typecode = 11; }  
        else if (dataArray instanceof Int16Array) { typecode = 21; }  
        else if (dataArray instanceof Int32Array) { typecode = 31; }  
        else if (dataArray instanceof BigInt64Array){ typecode = 81;} 
        else if (dataArray instanceof Float32Array){ typecode = 42; } 
        else if (dataArray instanceof Float64Array){ typecode = 82; } 
        else throw new Error("Unsupported array type for writing. Please use a TypedArray.");

        // Allocate memory
        const byteSize = dataArray.byteLength;
        const ptr = this.module._malloc(byteSize);
        
        // Grab the raw bytes from your TypedArray
        const dataBytes = new Uint8Array(dataArray.buffer, dataArray.byteOffset, byteSize);
        
        // Copy the bytes into WebAssembly memory using the explicitly exported HEAPU8
        this.module.HEAPU8.set(dataBytes, ptr);
        
        // Write it
        const status = this.fits.writeColumn(colNum, typecode, ptr, dataArray.length);
        
        // Free it
        this.module._free(ptr);
        
        if (status !== 0) throw new Error(`Failed to write column. Status: ${status}`);
        return status;
    }

    updateKeyString(key, value, comment = "") { 
        return this.fits.updateKeyString(key, value, comment); 
    }
    
    updateKeyDouble(key, value, comment = "") { 
        return this.fits.updateKeyDouble(key, Number(value), comment); 
    }

    /**
     * Flushes changes to the virtual disk and returns the updated file as a Uint8Array.
     * @returns {Uint8Array}
     */
    save() {
        this.fits.flush(); 
        // Read the file straight out of the WASM virtual file system!
        const modifiedData = this.module.FS.readFile(this.filename);
        return new Uint8Array(modifiedData);
    }

    flush() {
        this.fits.flush();
    }

    /**
     * VERY IMPORTANT: Cleans up WebAssembly memory and virtual files.
     */
    close() {
        if (this.fits) {
            this.fits.delete(); // Call C++ Destructor
            this.fits = null;
        }
        if (this.filename) {
            this.module.FS.unlink(this.filename); // Delete virtual file
            this.filename = null;
        }
    }
}