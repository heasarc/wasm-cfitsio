import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import { FitsFile } from '../dist/index.js';

// Setup __dirname for ES Modules
const __dirname = new URL('.', import.meta.url).pathname;

// Helper to load files
const loadFixture = (filename) => {
    const filePath = path.resolve(__dirname, './fixtures', filename);
    return new Uint8Array(fs.readFileSync(filePath));
};

describe('FitsFile WASM Library', () => {

    describe('Image FITS (test.fits)', () => {
        it('should read primary header and image data', async () => {
            const fileData = loadFixture('test.fits');
            const fits = await FitsFile.open(fileData);
            
            try {
                // 1. Test Header
                const simple = fits.readKeyword("SIMPLE");
                expect(simple).toBe("T");
                
                // 2. Test Image
                // If there are multiple HDUs, the image is likely in HDU 2
                if (fits.getNumHDUs() > 1) {
                    fits.moveToHDU(2);
                }
                const image = fits.readImage();
                expect(image).not.toBeNull();
                expect(image.dataType).toBeDefined(); // e.g., 'Float32Array', 'Int16Array'
                expect(image.data.length).toBeGreaterThan(0);
            } finally {
                fits.close();
            }
        });

        it('should update a keyword and save', async () => {
            const fileData = loadFixture('test.fits');
            const fits = await FitsFile.open(fileData);
            
            try {
                fits.updateKeyString("WASMTEST", "SUCCESS", "Added by vitest");
                const modifiedBytes = fits.save();
                expect(modifiedBytes.byteLength).toBeGreaterThan(0);

                // Verify by reopening
                const fits2 = await FitsFile.open(modifiedBytes);
                expect(fits2.readKeyword("WASMTEST")).toBe("SUCCESS");
                fits2.close();
            } finally {
                fits.close();
            }
        });
    });

    describe('Binary Tables (btable.fits)', () => {
        it('should read binary table dimensions and columns', async () => {
            const fileData = loadFixture('btable.fits');
            const fits = await FitsFile.open(fileData);
            
            try {
                // Tables are almost always in HDU 2 (the first extension)
                fits.moveToHDU(2);
                
                const numRows = fits.getNumRows();
                const numCols = fits.getNumCols();
                
                expect(numRows).toBeGreaterThan(0);
                expect(numCols).toBeGreaterThan(0);

                // Read the first column
                const col1 = fits.readColumn(1);
                expect(col1).not.toBeNull();
                expect(col1.data.length).toBeGreaterThanOrEqual(numRows);
                expect(col1.dataType).toBeDefined();
            } finally {
                fits.close();
            }
        });

        it('should modify binary table data and save', async () => {
            const fileData = loadFixture('btable.fits');
            const fits = await FitsFile.open(fileData);
            
            try {
                fits.moveToHDU(2);
                const col1 = fits.readColumn(1);
                
                // Skip if it's a StringArray (we only implemented writing for numeric TypedArrays)
                if (col1.dataType !== "StringArray") {
                    // Create a modified copy of the data
                    const modifiedData = col1.data.map(val => val + 1);
                    
                    // Write it back
                    const status = fits.writeColumn(1, modifiedData);
                    expect(status).toBe(0);

                    // Verify it saved
                    const newBytes = fits.save();
                    const fits2 = await FitsFile.open(newBytes);
                    fits2.moveToHDU(2);
                    const modifiedCol1 = fits2.readColumn(1);
                    
                    // Check if the first element actually increased by 1
                    expect(modifiedCol1.data[0]).toBe(modifiedData[0]);
                    fits2.close();
                }
            } finally {
                fits.close();
            }
        });
    });

    describe('ASCII Tables (ascii.fits)', () => {
        it('should transparently parse ASCII table columns', async () => {
            const fileData = loadFixture('ascii.fits');
            const fits = await FitsFile.open(fileData);
            
            try {
                fits.moveToHDU(2);
                
                const numRows = fits.getNumRows();
                expect(numRows).toBeGreaterThan(0);

                // cfitsio handles the text-to-number/string conversion automatically!
                const col1 = fits.readColumn(1);
                expect(col1).not.toBeNull();
                expect(col1.data.length).toBeGreaterThanOrEqual(numRows);
            } finally {
                fits.close();
            }
        });
    });

    it('should parse WCS and perform coordinate transforms', async () => {
        const fileData = loadFixture('test.fits');
        const fits = await FitsFile.open(fileData);
        
        try {
            if (fits.getNumHDUs() > 1) fits.moveToHDU(2);
            
            // initWCS() returns true if wcslib successfully parsed the header
            if (fits.hasWCS()) {
                // Test Pix -> Sky 
                const sky = fits.pixToWorld(210.25, 212.5); // Using the CRPIX values from earlier
                expect(sky).not.toBeNull();
                expect(sky.ra).toBeTypeOf('number');
                expect(sky.dec).toBeTypeOf('number');
                
                // Test Sky -> Pix (Transform back)
                const pix = fits.worldToPix(sky.ra, sky.dec);
                expect(pix).not.toBeNull();
                expect(pix.x).toBeCloseTo(210.25, 4);
                expect(pix.y).toBeCloseTo(212.5, 4);
            } else {
                console.warn("WCSLIB could not parse WCS from this file.");
            }
        } finally {
            fits.close();
        }
    });

});

describe('readKeyword contract', () => {
    it('should return null for a keyword that does not exist', async () => {
        const fileData = loadFixture('test.fits');
        const fits = await FitsFile.open(fileData);

        try {
            const val = fits.readKeyword('DOESNOTEXIST');
            // Must be null — never "ERROR_202" or any other error string
            expect(val).toBeNull();
        } finally {
            fits.close();
        }
    });

    it('should return null for a missing keyword in a table HDU', async () => {
        const fileData = loadFixture('btable.fits');
        const fits = await FitsFile.open(fileData);

        try {
            fits.moveToHDU(2);
            // OBJECT is an image keyword — unlikely to exist in a table HDU
            const val = fits.readKeyword('OBJECT');
            // May be null or a real string — but must never be "ERROR_*"
            if (val !== null) {
                expect(typeof val).toBe('string');
                expect(val).not.toMatch(/^ERROR_/);
            } else {
                expect(val).toBeNull();
            }
        } finally {
            fits.close();
        }
    });

    it('should return a string for a keyword that exists', async () => {
        const fileData = loadFixture('test.fits');
        const fits = await FitsFile.open(fileData);

        try {
            // SIMPLE is always present in a primary HDU
            const val = fits.readKeyword('SIMPLE');
            expect(val).not.toBeNull();
            expect(typeof val).toBe('string');
            expect(val.length).toBeGreaterThan(0);
        } finally {
            fits.close();
        }
    });

    it('should return an empty string for a keyword with an empty value', async () => {
        const fileData = loadFixture('test.fits');
        const fits = await FitsFile.open(fileData);

        try {
            // Write a keyword with an empty value, then read it back
            fits.updateKeyString('EMPTYVAL', '', 'test empty value');
            const val = fits.readKeyword('EMPTYVAL');
            // Empty string is valid — distinct from null (missing)
            expect(val).not.toBeNull();
            expect(val).toBe('');
        } finally {
            fits.close();
        }
    });

    it('should not return ERROR_ strings for any standard keyword absence', async () => {
        const fileData = loadFixture('btable.fits');
        const fits = await FitsFile.open(fileData);

        try {
            fits.moveToHDU(2);
            // These image-specific keywords are absent in table HDUs
            const imageOnlyKeywords = ['BZERO', 'BSCALE', 'BLANK', 'DATAMAX', 'DATAMIN'];
            for (const kw of imageOnlyKeywords) {
                const val = fits.readKeyword(kw);
                if (val !== null) {
                    expect(val).not.toMatch(/^ERROR_/);
                }
            }
        } finally {
            fits.close();
        }
    });
});

describe('Mixed column types (btable.fits)', () => {

    it('should return non-null for every column', async () => {
        const fileData = loadFixture('btable.fits');
        const fits = await FitsFile.open(fileData);

        try {
            fits.moveToHDU(2);
            const numCols = fits.getNumCols();
            expect(numCols).toBeGreaterThan(0);

            for (let i = 1; i <= numCols; i++) {
                const col = fits.readColumn(i);
                // Core fix — no column should return null regardless of type
                expect(col).not.toBeNull();
                expect(col.data).not.toBeNull();
                expect(col.data.length).toBeGreaterThan(0);
            }
        } finally {
            fits.close();
        }
    });

    it('should read string columns as StringArray with correct length', async () => {
        const fileData = loadFixture('btable.fits');
        const fits = await FitsFile.open(fileData);

        try {
            fits.moveToHDU(2);
            const numRows = fits.getNumRows();
            const numCols = fits.getNumCols();

            let stringColFound = false;

            for (let i = 1; i <= numCols; i++) {
                const col = fits.readColumn(i);
                if (col?.dataType !== 'StringArray') continue;

                stringColFound = true;

                // Length must equal nrows — not nrows * repeat
                expect(col.data.length).toBe(numRows);

                // Every element must be a string, not null, not 'ERROR_*'
                for (const val of col.data) {
                    expect(typeof val).toBe('string');
                    expect(val).not.toMatch(/^ERROR_/);
                    // No trailing spaces — cfitsio padding must be stripped
                    expect(val).toBe(val.trimEnd());
                }
            }

            // Ensure the fixture actually has string columns
            expect(stringColFound).toBe(true);

        } finally {
            fits.close();
        }
    });

    it('should read float32 columns as Float32Array with finite values', async () => {
        const fileData = loadFixture('btable.fits');
        const fits = await FitsFile.open(fileData);

        try {
            fits.moveToHDU(2);
            const numRows = fits.getNumRows();
            const numCols = fits.getNumCols();

            let float32ColFound = false;

            for (let i = 1; i <= numCols; i++) {
                const col = fits.readColumn(i);
                if (col?.dataType !== 'Float32Array') continue;

                float32ColFound = true;

                expect(col.data.length).toBe(numRows);
                for (const val of col.data) {
                    expect(typeof val).toBe('number');
                    expect(isFinite(val)).toBe(true);
                }
            }

            if (!float32ColFound) {
                console.warn('btable.fits has no Float32Array columns — skipping float32 check');
            }

        } finally {
            fits.close();
        }
    });

    it('should read numeric columns with correct row count', async () => {
        const fileData = loadFixture('btable.fits');
        const fits = await FitsFile.open(fileData);

        try {
            fits.moveToHDU(2);
            const numRows = fits.getNumRows();
            const numCols = fits.getNumCols();

            const numericTypes = [
                'Int16Array', 'Int32Array', 'Float32Array',
                'Float64Array', 'Uint8Array', 'BigInt64Array'
            ];

            for (let i = 1; i <= numCols; i++) {
                const col = fits.readColumn(i);
                if (!col || !numericTypes.includes(col.dataType)) continue;

                // Numeric columns: length = nrows (repeat=1)
                // or nrows * repeat for array-valued cells
                expect(col.data.length).toBeGreaterThanOrEqual(numRows);
            }

        } finally {
            fits.close();
        }
    });

    it('should read a specific range of rows (pagination)', async () => {
        const fileData = loadFixture('btable.fits');
        const fits = await FitsFile.open(fileData);

        try {
            fits.moveToHDU(2);
            
            // 1. Read the entire column
            const fullCol = fits.readColumn(1);
            expect(fullCol).not.toBeNull();
            
            const totalRows = fits.getNumRows();
            expect(fullCol.data.length).toBeGreaterThanOrEqual(totalRows);

            if (totalRows > 3) {
                // 2. Read just rows 2, 3, and 4 (Note: FITS is 1-indexed!)
                const pagedCol = fits.readColumn(1, 2, 3);
                
                expect(pagedCol).not.toBeNull();
                
                // length should be 3 rows * repeat
                const expectedLength = 3 * pagedCol.repeat;
                expect(pagedCol.data.length).toBe(expectedLength);
                
                // 3. Verify the data perfectly matches the sliced original data
                // Row 2 in FITS (1-indexed) corresponds to elements starting at index `1 * repeat` in JS (0-indexed)
                const startIdx = 1 * pagedCol.repeat;
                
                expect(pagedCol.data[0]).toBe(fullCol.data[startIdx]);
                expect(pagedCol.data[pagedCol.data.length - 1]).toBe(fullCol.data[startIdx + expectedLength - 1]);
            }
        } finally {
            fits.close();
        }
    });
});

describe('Table Schema Mutations (Phase 3)', () => {
    it('should read standard column metadata correctly', async () => {
        const fileData = loadFixture('btable.fits');
        const fits = await FitsFile.open(fileData);
        
        try {
            fits.moveToHDU(2);
            
            // Get info for the first column
            const info = fits.getColumnInfo(1);
            
            expect(info).not.toBeNull();
            expect(info).toHaveProperty('typecode');
            expect(info).toHaveProperty('repeat');
            expect(info).toHaveProperty('width');
            expect(info).toHaveProperty('name');
            expect(typeof info.name).toBe('string');
            
            // Ensure cfitsio's quotes and padding were stripped properly by your JS wrapper
            expect(info.name).not.toMatch(/^'/);
            expect(info.name).not.toMatch(/'$/);
            expect(info.name).toBe(info.name.trim());
        } finally {
            fits.close();
        }
    });

    it('should change column name and units successfully', async () => {
        const fileData = loadFixture('btable.fits');
        const fits = await FitsFile.open(fileData);
        
        try {
            fits.moveToHDU(2);
            
            // Change metadata
            fits.changeColumnName(1, "NEW_NAME");
            fits.changeColumnUnit(1, "m/s");
            
            // Save and reopen to verify changes persisted to the FITS header
            const newBytes = fits.save();
            const fits2 = await FitsFile.open(newBytes);
            
            try {
                fits2.moveToHDU(2);
                const info = fits2.getColumnInfo(1);
                
                expect(info.name).toBe("NEW_NAME");
                expect(info.unit).toBe("m/s");
            } finally {
                fits2.close();
            }
        } finally {
            fits.close();
        }
    });

    it('should insert and delete columns conforming to FITS standards', async () => {
        const fileData = loadFixture('btable.fits');
        const fits = await FitsFile.open(fileData);
        
        try {
            fits.moveToHDU(2);
            const initialCols = fits.getNumCols();
            const targetCol = initialCols + 1; // Append to end
            
            // Insert a standard 64-bit float (1D) column
            const status = fits.insertColumn(targetCol, "TEST_COL", "1D");
            expect(status).toBe(0);
            expect(fits.getNumCols()).toBe(initialCols + 1);
            
            // Verify the column info
            const info = fits.getColumnInfo(targetCol);
            expect(info.name).toBe("TEST_COL");
            expect(info.form).toBe("1D"); // 1D is the FITS standard for Float64
            
            // Write a cell to the new column to prove it allocated correctly
            fits.writeCell(targetCol, 1, 99.9);
            const colData = fits.readColumn(targetCol);
            expect(colData.dataType).toBe("Float64Array");
            expect(colData.data[0]).toBeCloseTo(99.9);

            // Now delete the column
            const delStatus = fits.deleteColumn(targetCol);
            expect(delStatus).toBe(0);
            expect(fits.getNumCols()).toBe(initialCols); // Back to original
        } finally {
            fits.close();
        }
    });

    it('should insert and delete rows accurately', async () => {
        const fileData = loadFixture('btable.fits');
        const fits = await FitsFile.open(fileData);
        
        try {
            fits.moveToHDU(2);
            const initialRows = fits.getNumRows();
            
            // Insert 5 rows at the end of the table
            // FITS row insertion is 1-indexed. Inserting at initialRows appends them.
            fits.insertRows(initialRows, 5);
            expect(fits.getNumRows()).toBe(initialRows + 5);
            
            // The new rows should be initialized to zeros/nulls. 
            // Let's write to the last newly created row (initialRows + 5)
            fits.writeCell(1, initialRows + 5, 42);
            
            // Delete 2 rows starting from the end
            fits.deleteRows(initialRows + 4, 2);
            
            // Verify final row count
            expect(fits.getNumRows()).toBe(initialRows + 3);
        } finally {
            fits.close();
        }
    });
});

describe('Header Compliance & Mandatory Keywords', () => {
    it('should contain mandatory primary header keywords', async () => {
        const fileData = loadFixture('test.fits');
        const fits = await FitsFile.open(fileData);
        
        try {
            fits.moveToHDU(1); // Primary HDU
            
            // FITS Standard 4.0: First three keywords MUST be SIMPLE, BITPIX, and NAXIS
            const simple = fits.readKeyword('SIMPLE');
            const bitpix = fits.readKeyword('BITPIX');
            const naxis = fits.readKeyword('NAXIS');
            
            expect(simple).toBe('T'); // Booleans are represented as 'T' or 'F'
            expect(bitpix).not.toBeNull();
            expect(naxis).not.toBeNull();
            
            // BITPIX and NAXIS should parse as numbers
            expect(!isNaN(Number(bitpix))).toBe(true);
            expect(!isNaN(Number(naxis))).toBe(true);
        } finally {
            fits.close();
        }
    });

    it('should return exactly 80-character header cards and end with END', async () => {
        const fileData = loadFixture('test.fits');
        const fits = await FitsFile.open(fileData);
        
        try {
            fits.moveToHDU(1);
            const fullHeader = fits.readHeader();
            
            // We split by newline, dropping the final empty string
            const cards = fullHeader.split('\n').filter(line => line.length > 0);
            
            expect(cards.length).toBeGreaterThan(0);
            
            let foundEnd = false;
            for (const card of cards) {
                // STRICT FITS STANDARD: Every card must be exactly 80 chars
                expect(card.length).toBe(80);
                if (card.startsWith('END ')) {
                    foundEnd = true;
                }
            }
            
            expect(foundEnd).toBe(true);
        } finally {
            fits.close();
        }
    });

    it('should accurately write and read standard 8-character keywords', async () => {
        const fileData = loadFixture('test.fits');
        const fits = await FitsFile.open(fileData);
        
        try {
            // FITS standard keyword limit is 8 characters.
            // We'll test both string and numeric types.
            fits.updateKeyString("TESTSTR", "VALUE", "A string comment");
            fits.updateKeyDouble("TESTNUM", 123.456, "A double comment");
            
            // Read them back from memory
            const strVal = fits.readKeyword("TESTSTR");
            const numVal = fits.readKeyword("TESTNUM");
            
            expect(strVal).toBe("VALUE");
            // readKeyword returns strings, so we cast to compare the double
            expect(Number(numVal)).toBeCloseTo(123.456);
        } finally {
            fits.close();
        }
    });
});

describe('Explicit BITPIX Verification', () => {
    it('should map the fixture BITPIX to the correct JS TypedArray', async () => {
        // Standard FITS BITPIX to JS TypedArray mappings
        const expectedMappings = {
            8:   { type: "Uint8Array",    buffer: Uint8Array },
            16:  { type: "Int16Array",    buffer: Int16Array },
            32:  { type: "Int32Array",    buffer: Int32Array },
            64:  { type: "BigInt64Array", buffer: BigInt64Array },
            "-32": { type: "Float32Array",  buffer: Float32Array },
            "-64": { type: "Float64Array",  buffer: Float64Array }
        };

        const fileData = loadFixture('test.fits');
        const fits = await FitsFile.open(fileData);
        
        try {
            // Find the image HDU
            if (fits.getNumHDUs() > 1) {
                fits.moveToHDU(2);
            } else {
                fits.moveToHDU(1);
            }
            
            const image = fits.readImage();
            expect(image).not.toBeNull();
            
            const bitpixStr = String(image.bitpix);
            const expected = expectedMappings[bitpixStr];
            
            // Assert that the wrapper mapped it perfectly
            expect(expected).toBeDefined();
            expect(image.dataType).toBe(expected.type);
            expect(image.data).toBeInstanceOf(expected.buffer);
            
            // Ensure the data array actually has content
            expect(image.data.length).toBeGreaterThan(0);
            
        } finally {
            fits.close();
        }
    });
});

describe('WCS & Coordinate Transformations', () => {
    it('should safely propagate invalid coordinate inputs without crashing WASM', async () => {
        const fileData = loadFixture('test.fits');
        const fits = await FitsFile.open(fileData);
        
        try {
            if (fits.getNumHDUs() > 1) fits.moveToHDU(2);
            
            if (fits.hasWCS()) {
                // Feed it NaN. WCSLIB will perform the math, propagate the NaN, 
                // and safely return it without crashing the WASM memory.
                const sky = fits.pixToWorld(NaN, NaN);
                
                expect(sky).not.toBeNull();
                expect(Number.isNaN(sky.ra)).toBe(true);
                expect(Number.isNaN(sky.dec)).toBe(true);
                
                // Infinity should similarly propagate or be rejected mathematically
                const pix = fits.worldToPix(Infinity, Infinity);
                expect(pix).not.toBeNull();
                expect(Number.isNaN(pix.x) || !Number.isFinite(pix.x)).toBe(true);
            }
        } finally {
            fits.close();
        }
    });

    it('should maintain extreme sub-pixel precision in round-trip transforms', async () => {
        const fileData = loadFixture('test.fits');
        const fits = await FitsFile.open(fileData);
        
        try {
            if (fits.getNumHDUs() > 1) {
                fits.moveToHDU(2);
            } else {
                fits.moveToHDU(1);
            }
            
            if (fits.hasWCS()) {
                // Highly specific floating point pixel coordinates
                const originalX = 153.78912;
                const originalY = 88.12345;
                
                // Pixel -> Sky
                const sky = fits.pixToWorld(originalX, originalY);
                
                expect(sky).not.toBeNull();
                expect(sky).toHaveProperty('ra');
                expect(sky).toHaveProperty('dec');
                expect(isFinite(sky.ra)).toBe(true);
                expect(isFinite(sky.dec)).toBe(true);
                
                // Sky -> Pixel
                const pix = fits.worldToPix(sky.ra, sky.dec);
                
                expect(pix).not.toBeNull();
                
                // FITS WCS standards require high floating point accuracy.
                // We expect the round-trip to be identical down to at least 5 decimal places.
                expect(pix.x).toBeCloseTo(originalX, 5);
                expect(pix.y).toBeCloseTo(originalY, 5);
            } else {
                console.warn("Skipping WCS precision test: 'test.fits' lacks WCS headers.");
            }
        } finally {
            fits.close();
        }
    });
    it('should extract the WCS pixel scale', async () => {
        const fileData = loadFixture('test.fits');
        const fits = await FitsFile.open(fileData);
        
        try {
            if (fits.getNumHDUs() > 1) fits.moveToHDU(2);
            else fits.moveToHDU(1);
            
            if (fits.hasWCS()) {
                const scale = fits.getPixelScale();
                
                expect(scale).not.toBeNull();
                expect(scale).toHaveProperty('scaleX');
                expect(scale).toHaveProperty('scaleY');
                expect(scale).toHaveProperty('unitX');
                expect(scale).toHaveProperty('unitY');
                
                // Most astronomical FITS files use degrees
                expect(typeof scale.scaleX).toBe('number');
                expect(typeof scale.unitX).toBe('string');
            }
        } finally {
            fits.close();
        }
    });
});

describe('Data Scaling: BSCALE / BZERO', () => {
    it('should automatically apply BSCALE and BZERO when reading image data', async () => {
        const fileData = loadFixture('test.fits');
        
        // 1. Open the original file and grab a baseline pixel value
        let fits = await FitsFile.open(fileData);
        let origVal;
        let bitpix;
        
        try {
            if (fits.getNumHDUs() > 1) fits.moveToHDU(2);
            else fits.moveToHDU(1);
            
            const origImage = fits.readImage();
            expect(origImage).not.toBeNull();
            
            origVal = origImage.data[0];
            bitpix = origImage.bitpix;
            
            // Add scaling keywords: FITS standard says Physical = (Raw * BSCALE) + BZERO
            fits.updateKeyDouble('BSCALE', 2.0, 'Test Scale');
            fits.updateKeyDouble('BZERO', 100.0, 'Test Offset');
            
        } catch(e) {
            fits.close();
            throw e;
        }

        // Save the modifications to a new byte array and close the original
        const modifiedBytes = fits.save();
        fits.close();
        
        // 2. Reopen the modified file. 
        // cfitsio should parse the new header and automatically apply the math 
        // during fits_read_pix.
        const scaledFits = await FitsFile.open(modifiedBytes);
        try {
            if (scaledFits.getNumHDUs() > 1) scaledFits.moveToHDU(2);
            else scaledFits.moveToHDU(1);
            
            const scaledImage = scaledFits.readImage();
            const scaledVal = scaledImage.data[0];
            
            // Calculate the expected value using FITS standard formula
            let expectedVal = (origVal * 2.0) + 100.0;
            
            // IMPORTANT CATCH: If the original image was an integer (e.g., BITPIX 16 or 32), 
            // your wrapper forces fits_read_pix to output TSHORT or TINT.
            // This means cfitsio will mathematically calculate the float, but then TRUNCATE 
            // it back to an integer before handing it to your Int16Array!
            if (bitpix > 0) {
                expectedVal = Math.trunc(expectedVal);
            }
            
            // We use toBeCloseTo in case of floating point precision drift
            expect(scaledVal).toBeCloseTo(expectedVal, 4);
            
        } finally {
            scaledFits.close();
        }
    });
});

describe('File Writing and Export Integrity (Phase 6)', () => {
        it('should correctly overwrite a full column using WASM HEAPU8 memory', async () => {
            const fileData = loadFixture('btable.fits');
            const fits = await FitsFile.open(fileData);
            
            try {
                fits.moveToHDU(2);
                
                let targetCol = 1;
                let colInfo = fits.getColumnInfo(targetCol);
                
                if (colInfo.form.includes('A')) {
                    targetCol = 2; 
                }
                
                const origCol = fits.readColumn(targetCol);
                expect(origCol).not.toBeNull();
                expect(origCol.data.length).toBeGreaterThan(0);
                
                const newArray = new origCol.data.constructor(origCol.data.length);
                for (let i = 0; i < newArray.length; i++) {
                    newArray[i] = i * 2.5; 
                }
                
                const writeStatus = fits.writeColumn(targetCol, newArray);
                expect(writeStatus).toBe(0);
                
                const modifiedBytes = fits.save();
                fits.close(); 
                
                const fits2 = await FitsFile.open(modifiedBytes);
                try {
                    fits2.moveToHDU(2);
                    const modifiedCol = fits2.readColumn(targetCol);
                    
                    expect(modifiedCol.data.length).toBe(newArray.length);
                    // Dynamically test the first and last elements so we don't go out of bounds
                    expect(modifiedCol.data[0]).toBeCloseTo(0);
                    
                    const lastIndex = modifiedCol.data.length - 1;
                    expect(modifiedCol.data[lastIndex]).toBeCloseTo(lastIndex * 2.5);
                } finally {
                    fits2.close();
                }
            } catch (e) {
                if (fits.fits) fits.close();
                throw e;
            }
        });

        it('should reject invalid array types in writeColumn', async () => {
            const fileData = loadFixture('btable.fits');
            const fits = await FitsFile.open(fileData);
            
            try {
                fits.moveToHDU(2);
                const badData = [1, 2, 3, 4, 5]; 
                
                expect(() => {
                    fits.writeColumn(1, badData);
                }).toThrow("Unsupported array type for writing");
                
            } finally {
                fits.close();
            }
        });

        it('should preserve unmodified HDUs when saving changes', async () => {
            const fileData = loadFixture('btable.fits');
            const fits = await FitsFile.open(fileData);
            
            try {
                // 1. Read a baseline from the primary HDU
                fits.moveToHDU(1);
                const originalSimple = fits.readKeyword('SIMPLE');
                
                // 2. Move to HDU 2 (Table) and make a safe modification (adding a keyword)
                fits.moveToHDU(2);
                fits.updateKeyString("TESTSAVE", "MODIFIED", "Testing HDU isolation");
                
                // 3. Save the changes
                const modifiedBytes = fits.save();
                fits.close();
                
                // 4. Reopen and verify HDU 1 was untouched while HDU 2 kept the change
                const fits2 = await FitsFile.open(modifiedBytes);
                try {
                    fits2.moveToHDU(1);
                    expect(fits2.readKeyword('SIMPLE')).toBe(originalSimple);
                    
                    fits2.moveToHDU(2);
                    expect(fits2.readKeyword('TESTSAVE')).toBe("MODIFIED");
                    
                    // Verify the table can still be read safely
                    const col = fits2.readColumn(1); 
                    expect(col).not.toBeNull();
                    expect(col.data.length).toBeGreaterThan(0);
                } finally {
                    fits2.close();
                }
            } catch (e) {
                if (fits.fits) fits.close();
                throw e;
            }
        });
    });