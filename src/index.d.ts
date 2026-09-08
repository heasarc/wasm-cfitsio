// Copyright 2026, University of Maryland, All Rights Reserved

export interface ImageResult {
    bitpix: number;
    dataType: "Uint8Array" | "Int16Array" | "Int32Array" | "BigInt64Array" | "Float32Array" | "Float64Array";
    data: Uint8Array | Int16Array | Int32Array | BigInt64Array | Float32Array | Float64Array;
    pixScale: PixelScale;
    naxes: number[];
    subsetWidth: number;
    subsetHeight: number;
}

/**
 * TCOMPLEX columns return Float32Array with interleaved (real, imag) pairs.
 * TDBLCOMPLEX columns return Float64Array with interleaved (real, imag) pairs.
 * Unsigned integer columns are promoted: TSBYTE->Int16, TUSHORT->Int32, TULONG->BigInt64, TULONGLONG->Float64.
 */
export interface ColumnResult {
    typecode: number;
    dataType: "Uint8Array" | "Int16Array" | "Int32Array" | "BigInt64Array" | "Float32Array" | "Float64Array" | "StringArray";
    repeat: number;
    data: Uint8Array | Int16Array | Int32Array | BigInt64Array | Float32Array | Float64Array | string[];
}

export interface WCSParams {
    xrval: number; yrval: number;
    xrpix: number; yrpix: number;
    xinc: number;  yinc: number;
    rot: number;   type: string;
}

export interface WorldCoords { ra: number; dec: number; }
export interface PixelCoords { x: number; y: number; }

export interface PixelScale { 
    scaleX: number; 
    scaleY: number; 
    unitX: string; 
    unitY: string; 
}

export class FitsFile {
    /**
     * Initializes the WebAssembly module and opens the FITS file from memory.
     * @param fileData - The raw bytes of the FITS file
     */
    static open(fileData: Uint8Array): Promise<FitsFile>;

    /** Gets the total number of HDUs in the file */
    getNumHDUs(): number;

    /** Moves to a specific HDU (1-indexed) */
    moveToHDU(hduNum: number): number;

    /** Reads a single keyword from the current HDU's header */
    readKeyword(keyword: string): string | null;

    /** Reads the entire header of the current HDU as a single string */
    readHeader(): string;

    /**
     * Reads the image data from the FITS file.
     * Optionally reads a multi-dimensional subset of the image.
     * 
     * @param fpixel Array representing the starting pixel coordinate for each axis (1-indexed).
     * @param lpixel Array representing the ending pixel coordinate for each axis (1-indexed).
     * @param inc Array representing the stride/increment for each axis.
     * @returns An object containing the typed array data and image dimensions, or null if reading fails.
     */
    readImage(
        fpixel?: number[] | null, 
        lpixel?: number[] | null, 
        inc?: number[] | null
    ): ImageResult | null;
    

    /** Gets the total number of rows in the current BINTABLE HDU */
    getNumRows(): number;

    /** Gets the total number of columns in the current BINTABLE HDU */
    getNumCols(): number;

    /** Gets the schema information (name, unit, format, type) for a specific column. */
    getColumnInfo(colNum: number): {
        typecode: number;
        repeat: number;
        width: number;
        name: string;
        unit: string;
        form: string;
    } | null;

    /** Writes a single numeric value to a specific cell in the FITS table. */
    writeCell(colNum: number, rowNum: number, value: number, firstElem: number): number;

    /** Inserts empty rows into the current table HDU. (1-indexed) */
    insertRows(firstRow: number, numRows?: number): number;

    /** Deletes rows from the current table HDU. (1-indexed) */
    deleteRows(firstRow: number, numRows?: number): number;

    /** Inserts a new column into the current table HDU. (1-indexed). 
     *  Format uses cfitsio standard (e.g., '1J' for integer, '1D' for double, '20A' for string). */
    insertColumn(colNum: number, name: string, format: string): number;

    /** Deletes a column from the current table HDU. (1-indexed) */
    deleteColumn(colNum: number): number;

    /** Changes the name (TTYPEn) of an existing column. (1-indexed) */
    changeColumnName(colNum: number, newName: string): number;

    /** Changes the physical unit (TUNITn) of an existing column. (1-indexed) */
    changeColumnUnit(colNum: number, newUnit: string): number;

    /** 
     * Changes the data format (TFORMn) of an existing column. (1-indexed)
     * Warning: Changing physical byte widths without adjusting data can corrupt the table. 
     */
    changeColumnFormat(colNum: number, newFormat: string): number;

    /** 
     * Extracts a specific column (1-indexed) from the current BINTABLE HDU. 
     * You can optionally specify a row range for pagination.
     * Returns null if not a table or if out of bounds.
     */
    readColumn(colNum: number, firstRow?: number, numRows?: number): ColumnResult | null;

    // Write column data
    writeColumn(colNum: number, dataArray: any): number;

    /** Updates or adds a string keyword to the current header */
    updateKeyString(key: string, value: string, comment?: string): number;

    /** Updates or adds a numeric keyword to the current header */
    updateKeyDouble(key: string, value: number, comment?: string): number;

    /** Checks if the current HDU has valid WCSLIB coordinate data */
    hasWCS(): boolean;

    /** Converts Pixel coordinates (X, Y) to Sky coordinates (RA, Dec) */
    pixToWorld(x: number, y: number): WorldCoords | null;

    /** Converts Sky coordinates (RA, Dec) to Pixel coordinates (X, Y) */
    worldToPix(ra: number, dec: number): PixelCoords | null;

    /** Gets the WCS pixel scale (coordinate deltas) and physical units */
    getPixelScale(): PixelScale | null;

    /** Flushes any modifications to memory and returns the updated FITS file bytes */
    save(): Uint8Array;

    /** Flushes all pending writes to the WASM virtual file system */
    flush(): void;

    /**
     * CRITICAL: Cleans up the WebAssembly memory and virtual file system.
     * Always call this when finished with the file to prevent memory leaks.
     */
    close(): void;
}