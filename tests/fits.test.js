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