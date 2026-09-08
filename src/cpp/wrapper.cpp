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
    int activeWcsIndex;

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
        activeWcsIndex = 0;
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

    val readImage(val fpixel_js, val lpixel_js, val inc_js) {
        if (status || fptr == nullptr) return val::null();

        int naxis = 0;
        int bitpix = 0;
        
        fits_get_img_param(fptr, 9, &bitpix, &naxis, NULL, &status);
        if (status || naxis == 0) return val::null();

        // Get actual dimensions of the FITS file
        std::vector<long> actual_naxes(naxis);
        fits_get_img_size(fptr, naxis, actual_naxes.data(), &status);

        // Prepare arrays for fits_read_subset
        std::vector<long> fpixel(naxis, 1);
        std::vector<long> lpixel(naxis, 1);
        std::vector<long> inc(naxis, 1);

        long num_pixels = 1;
        val js_naxes = val::array(); // To pass the dimensions back to JS

        // Safely parse the JS arrays and clamp them to the actual image bounds
        for(int i = 0; i < naxis; i++) {
            // Read from JS arrays if provided, otherwise default to full axis
            if (!fpixel_js.isUndefined() && !fpixel_js.isNull() && fpixel_js["length"].as<int>() > i) {
                fpixel[i] = fpixel_js[i].as<long>();
            }
            if (!lpixel_js.isUndefined() && !lpixel_js.isNull() && lpixel_js["length"].as<int>() > i) {
                lpixel[i] = lpixel_js[i].as<long>();
            } else {
                lpixel[i] = actual_naxes[i]; // Default to max size of this axis
            }
            if (!inc_js.isUndefined() && !inc_js.isNull() && inc_js["length"].as<int>() > i) {
                inc[i] = inc_js[i].as<long>();
            }

            // Safety clamps (cfitsio is 1-indexed)
            if (fpixel[i] < 1) fpixel[i] = 1;
            if (lpixel[i] > actual_naxes[i]) lpixel[i] = actual_naxes[i];
            if (inc[i] < 1) inc[i] = 1;

            // Calculate how many pixels we are actually extracting on this axis
            long axis_len = ((lpixel[i] - fpixel[i]) / inc[i]) + 1;
            num_pixels *= axis_len;
            
            // Store the full, original dimensions to send back to JS
            js_naxes.set(i, actual_naxes[i]);
        }

        clearImageVectors();
        int anynul = 0;
        val result = val::object();

        // Use fits_read_subset instead of fits_read_pix
        switch(bitpix) {
            case BYTE_IMG:
                img8.resize(num_pixels);
                fits_read_subset(fptr, TBYTE, fpixel.data(), lpixel.data(), inc.data(), NULL, img8.data(), &anynul, &status);
                result.set("dataType", val("Uint8Array"));
                result.set("data", val(typed_memory_view(img8.size(), img8.data())));
                break;
            case SHORT_IMG:
                img16.resize(num_pixels);
                fits_read_subset(fptr, TSHORT, fpixel.data(), lpixel.data(), inc.data(), NULL, img16.data(), &anynul, &status);
                result.set("dataType", val("Int16Array"));
                result.set("data", val(typed_memory_view(img16.size(), img16.data())));
                break;
            case LONG_IMG:
                img32.resize(num_pixels);
                fits_read_subset(fptr, TINT, fpixel.data(), lpixel.data(), inc.data(), NULL, img32.data(), &anynul, &status);
                result.set("dataType", val("Int32Array"));
                result.set("data", val(typed_memory_view(img32.size(), img32.data())));
                break;
            case LONGLONG_IMG:
                img64.resize(num_pixels);
                fits_read_subset(fptr, TLONGLONG, fpixel.data(), lpixel.data(), inc.data(), NULL, img64.data(), &anynul, &status);
                result.set("dataType", val("BigInt64Array"));
                result.set("data", val(typed_memory_view(img64.size(), img64.data())));
                break;
            case FLOAT_IMG:
                imgF32.resize(num_pixels);
                fits_read_subset(fptr, TFLOAT, fpixel.data(), lpixel.data(), inc.data(), NULL, imgF32.data(), &anynul, &status);
                result.set("dataType", val("Float32Array"));
                result.set("data", val(typed_memory_view(imgF32.size(), imgF32.data())));
                break;
            case DOUBLE_IMG:
                imgF64.resize(num_pixels);
                fits_read_subset(fptr, TDOUBLE, fpixel.data(), lpixel.data(), inc.data(), NULL, imgF64.data(), &anynul, &status);
                result.set("dataType", val("Float64Array"));
                result.set("data", val(typed_memory_view(imgF64.size(), imgF64.data())));
                break;
            default:
                return val::null();
        }

        if (status) return val::null();
        
        result.set("bitpix", val(bitpix));
        result.set("naxes", js_naxes); // Pass the original hypercube size back
        
        // Calculate the physical subset width/height for the Canvas
        long out_width = ((lpixel[0] - fpixel[0]) / inc[0]) + 1;
        long out_height = naxis > 1 ? ((lpixel[1] - fpixel[1]) / inc[1]) + 1 : 1;
        result.set("subsetWidth", val(out_width));
        result.set("subsetHeight", val(out_height));

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
    int writeCellDouble(int colnum, long rownum, long firstelem, double value) {
        if (status || fptr == nullptr) return status;
        
        double array[1] = {value};
        fits_write_col(fptr, TDOUBLE, colnum, rownum, firstelem, 1, array, &status);
        
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
    // Read a specific column, optionally specifying the starting row and number of rows
    val readColumn(int colnum, long firstrow, long numrows) {
        if (status || fptr == nullptr) return val::null();

        int typecode = 0;
        long repeat  = 0;
        long width   = 0;
        int local_status = 0;

        fits_get_coltype(fptr, colnum, &typecode, &repeat, &width, &local_status);
        if (local_status) return val::null();

        long total_rows = 0;
        fits_get_num_rows(fptr, &total_rows, &local_status);
        if (local_status) return val::null();

        // 1-indexed bounds checking and defaults
        if (firstrow < 1) firstrow = 1;
        
        // If numrows is -1 (default), or extends past the end, clamp it to the remaining rows
        if (numrows <= 0 || (firstrow + numrows - 1 > total_rows)) {
            numrows = total_rows - firstrow + 1;
        }
        
        if (numrows <= 0) return val::null(); // Nothing to read

        bool is_vla = (typecode < 0);
        int abs_type = std::abs(typecode);
        
        long total_elements = 0;
        val js_vla_lengths = val::null();
        std::vector<long> vla_lengths;

        // 1. Calculate required memory
        if (is_vla) {
            vla_lengths.resize(numrows);
            val lengths_arr = val::array();
            for (long r = 0; r < numrows; r++) {
                long row_repeat = 0;
                long offset = 0;
                fits_read_descript(fptr, colnum, firstrow + r, &row_repeat, &offset, &local_status);
                vla_lengths[r] = row_repeat;
                total_elements += row_repeat;
                lengths_arr.set(r, val(row_repeat));
            }
            js_vla_lengths = lengths_arr;
        } else {
            total_elements = (abs_type == TSTRING) ? numrows : numrows * repeat;
        }

        int anynul = 0;
        clearDataVectors();
        val result = val::object();

        // Helper macro to read data (handles both VLA and Fixed-Length)
        #define READ_DATA(CFITS_TYPE, VEC, T_ARRAY_STR) \
            VEC.resize(total_elements); \
            if (is_vla) { \
                long current_offset = 0; \
                for (long r = 0; r < numrows; r++) { \
                    long rlen = vla_lengths[r]; \
                    if (rlen > 0) { \
                        fits_read_col(fptr, CFITS_TYPE, colnum, firstrow + r, 1, rlen, NULL, VEC.data() + current_offset, &anynul, &status); \
                        current_offset += rlen; \
                    } \
                } \
            } else { \
                fits_read_col(fptr, CFITS_TYPE, colnum, firstrow, 1, total_elements, NULL, VEC.data(), &anynul, &status); \
            } \
            result.set("dataType", val(T_ARRAY_STR)); \
            result.set("data", val(typed_memory_view(VEC.size(), VEC.data())));

        switch(abs_type) {
            case TBIT:     READ_DATA(TBIT, img8, "Uint8Array"); break;
            case TBYTE:
            case TLOGICAL: READ_DATA(TBYTE, img8, "Uint8Array"); break;
            case TSBYTE:   READ_DATA(TSHORT, img16, "Int16Array"); break;
            case TSHORT:   READ_DATA(TSHORT, img16, "Int16Array"); break;
            case TUSHORT:  READ_DATA(TINT, img32, "Int32Array"); break;
            case TINT:
            case TLONG:    READ_DATA(TINT, img32, "Int32Array"); break;
            case TULONG:   READ_DATA(TLONGLONG, img64, "BigInt64Array"); break;
            case TLONGLONG:READ_DATA(TLONGLONG, img64, "BigInt64Array"); break;
            case TULONGLONG: READ_DATA(TDOUBLE, imgF64, "Float64Array"); break;
            case TFLOAT:   READ_DATA(TFLOAT, imgF32, "Float32Array"); break;
            case TDOUBLE:  READ_DATA(TDOUBLE, imgF64, "Float64Array"); break;
            case TCOMPLEX:
                total_elements *= 2;
                READ_DATA(TFLOAT, imgF32, "Float32Array"); break;
            case TDBLCOMPLEX:
                total_elements *= 2;
                READ_DATA(TDOUBLE, imgF64, "Float64Array"); break;
            case TSTRING: {
                // Strings don't typically use the VLA heap in the same way, but handle standard fixed string columns
                long max_len = width + 1;
                std::vector<char*> str_ptrs(numrows);
                std::vector<char>  str_buffer(numrows * max_len);
                for (long i = 0; i < numrows; ++i) str_ptrs[i] = &str_buffer[i * max_len];
                
                fits_read_col(fptr, TSTRING, colnum, firstrow, 1, numrows, NULL, str_ptrs.data(), &anynul, &local_status);
                if (local_status) return val::null();

                val jsArray = val::array();
                for (long i = 0; i < numrows; ++i) {
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

        if (status) return val::null();
        
        result.set("typecode", val(typecode));
        result.set("repeat", val(repeat));
        result.set("isVLA", val(is_vla));
        if (is_vla) result.set("vlaLengths", js_vla_lengths);
        
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
        int wcs_status = wcspih((char*)header.c_str(), nkeyrec, WCSHDR_all, 0, &nreject, &nwcs, &wcs);
        
        // status 0 means success
        return wcs_status == 0 && nwcs > 0;
    }

    int getWCSCount() {
        if (wcs == nullptr && !initWCS()) return 0;
        return nwcs;
    }

    bool setActiveWCS(int index) {
        if (wcs == nullptr && !initWCS()) return false;
        if (index < 0 || index >= nwcs) return false;
        activeWcsIndex = index;
        return true;
    }

    // 2. Convert Pixel (X, Y) to Sky (RA, Dec)
    val pixToWorld(double xpix, double ypix) {
        if (wcs == nullptr && !initWCS()) return val::null();
        struct wcsprm* active = &wcs[activeWcsIndex];

        double pixcrd[2] = {xpix, ypix};
        double imgcrd[2];
        double phi[1], theta[1];
        double world[2];
        int stat[1];

        int status = wcsp2s(active, 1, 2, pixcrd, imgcrd, phi, theta, world, stat);
        if (status) return val::null();

        val result = val::object();
        result.set("ra", world[0]);
        result.set("dec", world[1]);
        return result;
    }

    // 3. Convert Sky (RA, Dec) to Pixel (X, Y)
    val worldToPix(double ra, double dec) {
        if (wcs == nullptr && !initWCS()) return val::null();
        struct wcsprm* active = &wcs[activeWcsIndex];

        double world[2] = {ra, dec};
        double phi[1], theta[1];
        double imgcrd[2];
        double pixcrd[2];
        int stat[1];

        int status = wcss2p(active, 1, 2, world, phi, theta, imgcrd, pixcrd, stat);
        if (status) return val::null();

        val result = val::object();
        result.set("x", pixcrd[0]);
        result.set("y", pixcrd[1]);
        return result;
    }
    // 4. Get the WCS Pixel Scale
    val getPixelScale() {
        if (wcs == nullptr && !initWCS()) return val::null();
        struct wcsprm* active = &wcs[activeWcsIndex];

        val result = val::object();
        result.set("scaleX", active->cdelt[0]);
        result.set("scaleY", active->cdelt[1]);
        result.set("unitX", val(std::string(active->cunit[0])));
        result.set("unitY", val(std::string(active->cunit[1])));

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
        .function("getWCSCount", &FitsWrapper::getWCSCount)
        .function("setActiveWCS", &FitsWrapper::setActiveWCS)
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
