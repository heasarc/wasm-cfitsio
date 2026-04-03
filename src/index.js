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
    
    readKeyword(keyword) { return this.fits.readKeyword(keyword); }
    readHeader() { return this.fits.readHeader(); }

    hasWCS() { return this.fits.initWCS(); }
    pixToWorld(x, y) { return this.fits.pixToWorld(Number(x), Number(y)); }
    worldToPix(ra, dec) { return this.fits.worldToPix(Number(ra), Number(dec)); }
    
    readImage() { 
        const result = this.fits.readImage();
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

        return {
            bitpix: result.bitpix,
            dataType: result.dataType,
            data: safeData
        };
    }

    getNumRows() { return this.fits.getNumRows(); }
    getNumCols() { return this.fits.getNumCols(); }
    
    readColumn(colNum) { 
        const result = this.fits.readColumn(colNum);
        if (!result || !result.data) return null;
        
        let safeData;
        switch(result.dataType) {
            case "Uint8Array": safeData = new Uint8Array(result.data.slice()); break;
            case "Int16Array": safeData = new Int16Array(result.data.slice()); break;
            case "Int32Array": safeData = new Int32Array(result.data.slice()); break;
            case "BigInt64Array": safeData = new BigInt64Array(result.data.slice()); break;
            case "Float32Array": safeData = new Float32Array(result.data.slice()); break;
            case "Float64Array": safeData = new Float64Array(result.data.slice()); break;
            case "StringArray": safeData = result.data; break;
            default: safeData = new Float64Array(result.data.slice());
        }

        return {
            typecode: result.typecode,
            dataType: result.dataType,
            repeat: result.repeat,
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