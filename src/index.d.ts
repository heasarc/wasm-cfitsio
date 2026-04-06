export interface ImageResult {
    bitpix: number;
    dataType: "Uint8Array" | "Int16Array" | "Int32Array" | "BigInt64Array" | "Float32Array" | "Float64Array";
    data: Uint8Array | Int16Array | Int32Array | BigInt64Array | Float32Array | Float64Array;
}

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

    /** Extracts the 2D image data from the current HDU. Returns null if not an image. */
    readImage(): ImageResult | null;

    /** Gets the total number of rows in the current BINTABLE HDU */
    getNumRows(): number;

    /** Gets the total number of columns in the current BINTABLE HDU */
    getNumCols(): number;

    /** Extracts a specific column (1-indexed) from the current BINTABLE HDU. Returns null if not a table. */
    readColumn(colNum: number): ColumnResult | null;

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

    /** Flushes any modifications to memory and returns the updated FITS file bytes */
    save(): Uint8Array;

    /**
     * CRITICAL: Cleans up the WebAssembly memory and virtual file system.
     * Always call this when finished with the file to prevent memory leaks.
     */
    close(): void;
}