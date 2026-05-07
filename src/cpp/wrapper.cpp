// Copyright 2026, University of Maryland, All Rights Reserved

#include <iostream>
#include <string>
#include <vector>
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include "fitsio.h"
#include "wcslib.h"

using namespace emscripten;

class FitsWrapper {
private:
    fitsfile* fptr;
    int status;
    // We keep one vector for each FITS data type. 
    // Only the one matching the current file's BITPIX will be used.
    std::vector<uint8_t> img8;
    std::vector<int16_t> img16;
    std::vector<int32_t> img32;
    std::vector<int64_t> img64;
    std::vector<float> imgF32;
    std::vector<double> imgF64;

    struct wcsprm* wcs;
    int nreject;
    int nwcs;

    // Helper to free memory before reading a new image
    void clearImageVectors() {
        img8.clear(); img8.shrink_to_fit();
        img16.clear(); img16.shrink_to_fit();
        img32.clear(); img32.shrink_to_fit();
        img64.clear(); img64.shrink_to_fit();
        imgF32.clear(); imgF32.shrink_to_fit();
        imgF64.clear(); imgF64.shrink_to_fit();
    }

    // Helper to free memory before reading a new image or column
    void clearDataVectors() {
        img8.clear();   img8.shrink_to_fit();
        img16.clear();  img16.shrink_to_fit();
        img32.clear();  img32.shrink_to_fit();
        img64.clear();  img64.shrink_to_fit();
        imgF32.clear(); imgF32.shrink_to_fit();
        imgF64.clear(); imgF64.shrink_to_fit();
    }

    // Helper to free WCS memory
    void freeWCS() {
        if (wcs != nullptr) {
            wcsvfree(&nwcs, &wcs);
            wcs = nullptr;
        }
    }

public:
    FitsWrapper(std::string filename) {
        fptr = nullptr;
        status = 0;
        wcs = nullptr;
        nwcs = 0;
        fits_open_file(&fptr, filename.c_str(), READWRITE, &status);
        if (status) {
            std::cerr << "Error opening FITS file: " << filename << " (Status: " << status << ")" << std::endl;
        }
    }

    ~FitsWrapper() {
        freeWCS();
        if (fptr != nullptr) {
            int close_status = 0;
            fits_close_file(fptr, &close_status);
        }
    }

    int getStatus() const { return status; }

    // Get the total number of HDUs in the file
    int getNumHDUs() {
        if (status || fptr == nullptr) return 0;
        int num_hdus = 0;
        int local_status = 0;
        fits_get_num_hdus(fptr, &num_hdus, &local_status);
        return num_hdus;
    }

    // Move to a specific HDU (1-indexed: 1 is Primary, 2 is first extension)
    int moveToHDU(int hdu_num) {
        if (status || fptr == nullptr) return -1;
        int hdutype = 0;
        int local_status = 0;
        fits_movabs_hdu(fptr, hdu_num, &hdutype, &local_status);
        return local_status; // 0 means success
    }

    val readKeyword(std::string keyname) {
        if (status || fptr == nullptr) return val::null();
        char value[FLEN_VALUE];
        int local_status = 0;
        fits_read_keyword(fptr, keyname.c_str(), value, NULL, &local_status);
        if (local_status) return val::null();   // keyword does not exist → null

        std::string str_val(value);
        if (str_val.length() >= 2 && str_val.front() == '\'' && str_val.back() == '\'') {
            str_val = str_val.substr(1, str_val.length() - 2);
        }
        str_val.erase(str_val.find_last_not_of(" ") + 1);
        return val(str_val);
    }

    // Update or add a string keyword
    int updateKeyString(std::string keyname, std::string value, std::string comment) {
        if (status || fptr == nullptr) return -1;
        int local_status = 0;
        fits_update_key(fptr, TSTRING, keyname.c_str(), (void*)value.c_str(), comment.c_str(), &local_status);
        return local_status;
    }

    // Update or add a numeric (double) keyword
    int updateKeyDouble(std::string keyname, double value, std::string comment) {
        if (status || fptr == nullptr) return -1;
        int local_status = 0;
        fits_update_key(fptr, TDOUBLE, keyname.c_str(), &value, comment.c_str(), &local_status);
        return local_status;
    }

    // Force cfitsio to write all internal buffers to the virtual disk
    void flush() {
        if (fptr != nullptr) {
            int local_status = 0;
            fits_flush_file(fptr, &local_status);
        }
    }

    // Read the entire header of the current HDU as a single string
    std::string readHeader() {
        if (status || fptr == nullptr) return "";

        char* header_str = nullptr;
        int nkeys = 0;
        int local_status = 0;

        // fits_hdr2str returns the raw 80-char padded cards, including END
        fits_hdr2str(fptr, 0, nullptr, 0, &header_str, &nkeys, &local_status);
        
        if (local_status || header_str == nullptr) return "";

        // fits_hdr2str returns a continuous string without newlines.
        // We will insert newlines every 80 characters so it matches JS expectations.
        std::string formatted_header = "";
        std::string raw_header(header_str);
        
        for (size_t i = 0; i < raw_header.length(); i += 80) {
            formatted_header += raw_header.substr(i, 80) + "\n";
        }

        // cfitsio allocated header_str, we must free it
        fits_free_memory(header_str, &local_status);

        return formatted_header;
    }

    val readImage() {
        if (status || fptr == nullptr) return val::null();

        int naxis = 0;
        int bitpix = 0;
        
        // Get number of axes and BITPIX type
        fits_get_img_param(fptr, 9, &bitpix, &naxis, NULL, &status);
        if (status || naxis == 0) return val::null();

        // Get actual dimensions
        std::vector<long> naxes(naxis);
        fits_get_img_size(fptr, naxis, naxes.data(), &status);

        long num_pixels = 1;
        for(int i = 0; i < naxis; i++) num_pixels *= naxes[i];

        clearImageVectors();
        
        int anynul = 0;
        std::vector<long> fpixel(naxis, 1); // FITS starts at coordinates 1,1,1...
        val result = val::object();         // We will return a JS object

        // Switch based on BITPIX to use the exact data type
        switch(bitpix) {
            case BYTE_IMG: // 8
                img8.resize(num_pixels);
                fits_read_pix(fptr, TBYTE, fpixel.data(), num_pixels, NULL, img8.data(), &anynul, &status);
                result.set("dataType", val("Uint8Array"));
                result.set("data", val(typed_memory_view(img8.size(), img8.data())));
                break;
            case SHORT_IMG: // 16
                img16.resize(num_pixels);
                fits_read_pix(fptr, TSHORT, fpixel.data(), num_pixels, NULL, img16.data(), &anynul, &status);
                result.set("dataType", val("Int16Array"));
                result.set("data", val(typed_memory_view(img16.size(), img16.data())));
                break;
            case LONG_IMG: // 32
                img32.resize(num_pixels);
                fits_read_pix(fptr, TINT, fpixel.data(), num_pixels, NULL, img32.data(), &anynul, &status);
                result.set("dataType", val("Int32Array"));
                result.set("data", val(typed_memory_view(img32.size(), img32.data())));
                break;
            case LONGLONG_IMG: // 64
                img64.resize(num_pixels);
                fits_read_pix(fptr, TLONGLONG, fpixel.data(), num_pixels, NULL, img64.data(), &anynul, &status);
                result.set("dataType", val("BigInt64Array"));
                result.set("data", val(typed_memory_view(img64.size(), img64.data())));
                break;
            case FLOAT_IMG: // -32
                imgF32.resize(num_pixels);
                fits_read_pix(fptr, TFLOAT, fpixel.data(), num_pixels, NULL, imgF32.data(), &anynul, &status);
                result.set("dataType", val("Float32Array"));
                result.set("data", val(typed_memory_view(imgF32.size(), imgF32.data())));
                break;
            case DOUBLE_IMG: // -64
                imgF64.resize(num_pixels);
                fits_read_pix(fptr, TDOUBLE, fpixel.data(), num_pixels, NULL, imgF64.data(), &anynul, &status);
                result.set("dataType", val("Float64Array"));
                result.set("data", val(typed_memory_view(imgF64.size(), imgF64.data())));
                break;
            default:
                return val::null();
        }

        if (status) return val::null();
        result.set("bitpix", val(bitpix)); // Pass the original BITPIX back to JS
        return result;
    }

        // Get number of rows in the current table HDU
    long getNumRows() {
        if (status || fptr == nullptr) return 0;
        long nrows = 0;
        int local_status = 0;
        fits_get_num_rows(fptr, &nrows, &local_status);
        return nrows;
    }

    // Get number of columns in the current table HDU
    int getNumCols() {
        if (status || fptr == nullptr) return 0;
        int ncols = 0;
        int local_status = 0;
        fits_get_num_cols(fptr, &ncols, &local_status);
        return ncols;
    }

    // Get comprehensive metadata for a specific column (1-indexed)
    val getColumnInfo(int colnum) {
        if (status || fptr == nullptr) return val::null();

        int typecode = 0;
        long repeat = 0;
        long width = 0;
        int local_status = 0;

        // Get fundamental column structure
        fits_get_coltype(fptr, colnum, &typecode, &repeat, &width, &local_status);
        if (local_status) return val::null();

        // Read Name, Unit, and Format keywords (ignoring errors if they don't exist)
        char ttype[FLEN_VALUE] = "";
        char tunit[FLEN_VALUE] = "";
        char tform[FLEN_VALUE] = "";
        char keyname[FLEN_KEYWORD];

        local_status = 0;
        snprintf(keyname, sizeof(keyname), "TTYPE%d", colnum);
        fits_read_key(fptr, TSTRING, keyname, ttype, NULL, &local_status);

        local_status = 0;
        snprintf(keyname, sizeof(keyname), "TUNIT%d", colnum);
        fits_read_key(fptr, TSTRING, keyname, tunit, NULL, &local_status);

        local_status = 0;
        snprintf(keyname, sizeof(keyname), "TFORM%d", colnum);
        fits_read_key(fptr, TSTRING, keyname, tform, NULL, &local_status);

        // Return as a JS object
        val info = val::object();
        info.set("typecode", typecode);
        info.set("repeat", repeat);
        info.set("width", width);
        
        // Convert char arrays to std::string for Emscripten val
        info.set("name", val(std::string(ttype)));
        info.set("unit", val(std::string(tunit)));
        info.set("form", val(std::string(tform)));

        return info;
    }

    // Write a single numeric value to a specific cell
    int writeCellDouble(int colnum, long rownum, double value) {
        if (status || fptr == nullptr) return status;
        
        double array[1] = {value};
        fits_write_col(fptr, TDOUBLE, colnum, rownum, 1, 1, array, &status);
        
        return status;
    }

    // Insert empty rows (1-indexed)
    int insertRows(long firstrow, long nrows) {
        if (fptr == nullptr) return -1;
        int local_status = 0;
        fits_insert_rows(fptr, firstrow, nrows, &local_status);
        status = local_status;
        return status;
    }

    // Delete rows (1-indexed)
    int deleteRows(long firstrow, long nrows) {
        if (fptr == nullptr) return -1;
        int local_status = 0;
        fits_delete_rows(fptr, firstrow, nrows, &local_status);
        status = local_status;
        return status;
    }

    // Insert a new column (1-indexed)
    // tform uses cfitsio formats (e.g., "1J" for Int32, "1D" for Float64, "20A" for String)
    int insertColumn(int colnum, std::string ttype, std::string tform) {
        if (fptr == nullptr) return -1;
        int local_status = 0;
        fits_insert_col(fptr, colnum, (char*)ttype.c_str(), (char*)tform.c_str(), &local_status);
        status = local_status;
        return status;
    }

    // Delete a column (1-indexed)
    int deleteColumn(int colnum) {
        if (fptr == nullptr) return -1;
        int local_status = 0;
        fits_delete_col(fptr, colnum, &local_status);
        status = local_status;
        return status;
    }

    // --- Table Column Modifications ---

// Change the name of an existing column (1-indexed)
    int changeColumnName(int colnum, std::string newName) {
        if (fptr == nullptr) return -1;
        int local_status = 0;
        char keyname[FLEN_KEYWORD];
        snprintf(keyname, sizeof(keyname), "TTYPE%d", colnum);
        fits_update_key(fptr, TSTRING, keyname, (void*)newName.c_str(), "column name", &local_status);
        status = local_status;
        return status;
    }

    // Change the physical units of a column (1-indexed)
    int changeColumnUnit(int colnum, std::string newUnit) {
        if (fptr == nullptr) return -1;
        int local_status = 0;
        char keyname[FLEN_KEYWORD];
        snprintf(keyname, sizeof(keyname), "TUNIT%d", colnum);
        fits_update_key(fptr, TSTRING, keyname, (void*)newUnit.c_str(), "physical unit", &local_status);
        status = local_status;
        return status;
    }

    // Change the data format of a column (1-indexed)
    // Note: Changing physical byte widths can corrupt table data if not careful.
    int changeColumnFormat(int colnum, std::string newFormat) {
        if (fptr == nullptr) return -1;
        int local_status = 0;
        char keyname[FLEN_KEYWORD];
        snprintf(keyname, sizeof(keyname), "TFORM%d", colnum);
        fits_update_key(fptr, TSTRING, keyname, (void*)newFormat.c_str(), "data format", &local_status);
        status = local_status;
        return status;
    }

    // Read a specific column (1-indexed) as a Float64Array
    val readColumn(int colnum) {
        if (status || fptr == nullptr) return val::null();

        int typecode = 0;
        long repeat  = 0;
        long width   = 0;
        int local_status = 0;

        fits_get_coltype(fptr, colnum, &typecode, &repeat, &width, &local_status);
        if (local_status) return val::null();

        if (typecode < 0) return val::null();

        long nrows = 0;
        fits_get_num_rows(fptr, &nrows, &local_status);
        if (local_status) return val::null();

        // For TSTRING: repeat = number of chars per cell, NOT number of elements
        // num_elements is always nrows for string columns (one string per row)
        // For numeric: repeat > 1 means array-valued cell
        int abs_type = std::abs(typecode);
        long num_elements = (abs_type == TSTRING) ? nrows : nrows * repeat;

        int anynul = 0;
        clearDataVectors();
        val result = val::object();

        switch(abs_type) {
            case TBYTE:
            case TLOGICAL:
                img8.resize(num_elements);
                fits_read_col(fptr, TBYTE, colnum, 1, 1, num_elements, NULL, img8.data(), &anynul, &status);
                result.set("dataType", val("Uint8Array"));
                result.set("data", val(typed_memory_view(img8.size(), img8.data())));
                break;
            case TSHORT:
                img16.resize(num_elements);
                fits_read_col(fptr, TSHORT, colnum, 1, 1, num_elements, NULL, img16.data(), &anynul, &status);
                result.set("dataType", val("Int16Array"));
                result.set("data", val(typed_memory_view(img16.size(), img16.data())));
                break;
            case TINT:
            case TLONG:
                img32.resize(num_elements);
                fits_read_col(fptr, TINT, colnum, 1, 1, num_elements, NULL, img32.data(), &anynul, &status);
                result.set("dataType", val("Int32Array"));
                result.set("data", val(typed_memory_view(img32.size(), img32.data())));
                break;
            case TLONGLONG:
                img64.resize(num_elements);
                fits_read_col(fptr, TLONGLONG, colnum, 1, 1, num_elements, NULL, img64.data(), &anynul, &status);
                result.set("dataType", val("BigInt64Array"));
                result.set("data", val(typed_memory_view(img64.size(), img64.data())));
                break;
            case TFLOAT:
                imgF32.resize(num_elements);
                fits_read_col(fptr, TFLOAT, colnum, 1, 1, num_elements, NULL, imgF32.data(), &anynul, &status);
                result.set("dataType", val("Float32Array"));
                result.set("data", val(typed_memory_view(imgF32.size(), imgF32.data())));
                break;
            case TDOUBLE:
                imgF64.resize(num_elements);
                fits_read_col(fptr, TDOUBLE, colnum, 1, 1, num_elements, NULL, imgF64.data(), &anynul, &status);
                result.set("dataType", val("Float64Array"));
                result.set("data", val(typed_memory_view(imgF64.size(), imgF64.data())));
                break;
            case TSTRING: {
                long max_len = width + 1;  // width = chars per string from fits_get_coltype
                std::vector<char*> str_ptrs(nrows);
                std::vector<char>  str_buffer(nrows * max_len);

                for (long i = 0; i < nrows; ++i) {
                    str_ptrs[i] = &str_buffer[i * max_len];
                }

                fits_read_col(fptr, TSTRING, colnum, 1, 1, nrows, NULL,
                            str_ptrs.data(), &anynul, &local_status);
                if (local_status) return val::null();

                val jsArray = val::array();
                for (long i = 0; i < nrows; ++i) {
                    std::string s(str_ptrs[i]);
                    s.erase(s.find_last_not_of(" ") + 1);
                    jsArray.set(i, val(s));
                }

                result.set("dataType", val("StringArray"));
                result.set("data", jsArray);
                break;
            }
            default:
                return val::null();
        }

        if (local_status) return val::null();
        
        result.set("typecode", val(typecode));
        result.set("repeat", val(repeat));
        return result;
    }

    // Write an entire column of data using a raw memory pointer
    int writeColumn(int colnum, int typecode, intptr_t dataPtr, long numElements) {
        if (status || fptr == nullptr) return -1;
        int local_status = 0;
        fits_write_col(fptr, typecode, colnum, 1, 1, numElements, (void*)dataPtr, &local_status);
        return local_status;
    }

    // 1. Initialize WCSLIB directly from the FITS header
    bool initWCS() {
        freeWCS();
        std::string header = readHeader();
        if (header.empty()) return false;

        // Count how many 80-char "cards" are in the header
        int nkeyrec = header.length() / 81; 
        
        // Let WCSLIB parse the raw header string into its powerful structs!
        int wcs_status = wcspih((char*)header.c_str(), nkeyrec, WCSHDR_all, 2, &nreject, &nwcs, &wcs);
        
        // status 0 means success
        return wcs_status == 0 && nwcs > 0;
    }

    // 2. Convert Pixel (X, Y) to Sky (RA, Dec)
    val pixToWorld(double xpix, double ypix) {
        if (wcs == nullptr && !initWCS()) return val::null();

        double pixcrd[2] = {xpix, ypix};
        double imgcrd[2];
        double phi[1], theta[1];
        double world[2];
        int stat[1];

        // wcss2p is the core mathematical engine for Sky to Pixel
        int status = wcsp2s(wcs, 1, 2, pixcrd, imgcrd, phi, theta, world, stat);
        if (status) return val::null();

        val result = val::object();
        result.set("ra", world[0]);
        result.set("dec", world[1]);
        return result;
    }

    // 3. Convert Sky (RA, Dec) to Pixel (X, Y)
    val worldToPix(double ra, double dec) {
        if (wcs == nullptr && !initWCS()) return val::null();

        double world[2] = {ra, dec};
        double phi[1], theta[1];
        double imgcrd[2];
        double pixcrd[2];
        int stat[1];

        // wcsp2s is the core mathematical engine for Pixel to Sky
        int status = wcss2p(wcs, 1, 2, world, phi, theta, imgcrd, pixcrd, stat);
        if (status) return val::null();

        val result = val::object();
        result.set("x", pixcrd[0]);
        result.set("y", pixcrd[1]);
        return result;
    }
    // 4. Get the WCS Pixel Scale
    val getPixelScale() {
        if (wcs == nullptr && !initWCS()) return val::null();

        val result = val::object();
        // wcs->cdelt contains the parsed coordinate increments (scale)
        result.set("scaleX", wcs->cdelt[0]);
        result.set("scaleY", wcs->cdelt[1]);
        
        // wcs->cunit contains the unit strings (usually "deg")
        result.set("unitX", val(std::string(wcs->cunit[0])));
        result.set("unitY", val(std::string(wcs->cunit[1])));

        return result;
    }
};

EMSCRIPTEN_BINDINGS(fits_module) {
    class_<FitsWrapper>("FitsWrapper")
        .constructor<std::string>()
        .function("getStatus", &FitsWrapper::getStatus)
        .function("readKeyword", &FitsWrapper::readKeyword)
        .function("readImage", &FitsWrapper::readImage)
        .function("getNumHDUs", &FitsWrapper::getNumHDUs)
        .function("moveToHDU", &FitsWrapper::moveToHDU)
        .function("readHeader", &FitsWrapper::readHeader)
        .function("getNumRows", &FitsWrapper::getNumRows)
        .function("getNumCols", &FitsWrapper::getNumCols)
        .function("readColumn", &FitsWrapper::readColumn)
        .function("writeColumn", &FitsWrapper::writeColumn)
        .function("updateKeyString", &FitsWrapper::updateKeyString)
        .function("updateKeyDouble", &FitsWrapper::updateKeyDouble)
        .function("initWCS", &FitsWrapper::initWCS)
        .function("pixToWorld", &FitsWrapper::pixToWorld)
        .function("worldToPix", &FitsWrapper::worldToPix)
        .function("getPixelScale", &FitsWrapper::getPixelScale)
        .function("getColumnInfo", &FitsWrapper::getColumnInfo)
        .function("writeCellDouble", &FitsWrapper::writeCellDouble)
        .function("insertRows", &FitsWrapper::insertRows)
        .function("deleteRows", &FitsWrapper::deleteRows)
        .function("insertColumn", &FitsWrapper::insertColumn)
        .function("deleteColumn", &FitsWrapper::deleteColumn)
        .function("changeColumnName", &FitsWrapper::changeColumnName)
        .function("changeColumnUnit", &FitsWrapper::changeColumnUnit)
        .function("changeColumnFormat", &FitsWrapper::changeColumnFormat)
        .function("flush", &FitsWrapper::flush);
}
