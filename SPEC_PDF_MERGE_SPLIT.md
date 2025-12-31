# PDF Merge and Split Specification - Quick Job Only

**Version:** 1.0.0  
**Date:** December 2025  
**Endpoint:** `POST /quickjob`  
**Job Type:** Quick Job (Synchronous, <30 seconds)

---

## Table of Contents

1. [Overview](#overview)
2. [Size Constraints and Limits](#size-constraints-and-limits)
3. [PDF Merge Specification](#pdf-merge-specification)
4. [PDF Split Specification](#pdf-split-specification)
5. [Request Format](#request-format)
6. [Response Format](#response-format)
7. [Error Handling](#error-handling)
8. [Implementation Details](#implementation-details)
9. [Performance Considerations](#performance-considerations)

---

## Overview

This specification defines the implementation of PDF merging and splitting operations via the Quick Job endpoint. These operations are designed to complete synchronously within 30 seconds and return the result directly in the HTTP response.

### Supported Operations

1. **PDF Merge** - Combine multiple PDFs into a single PDF
2. **PDF Split** - Extract specific pages or page ranges from a PDF

### Key Constraints

- **Quick Job Only**: These operations are only available via `/quickjob` endpoint
- **Synchronous Processing**: Results returned directly in HTTP response (no webhooks)
- **30-Second Timeout**: Operations must complete within 30 seconds
- **Payload Size Limit**: Total request/response must fit within Lambda's 6 MB payload limit
- **Page Limit**: Output PDFs must not exceed 25 pages (MAX_QUICKJOB_PAGES in prod)

---

## Size Constraints and Limits

### Lambda Payload Constraints

**Request Payload Limit:** 6 MB (Lambda hard limit)  
**Response Payload Limit:** 6 MB (Lambda hard limit)  
**Total Working Memory:** 3008 MB (Lambda memory allocation)

### Practical Size Limits for PDF Operations

#### PDF Merge

**Input Constraints:**
- Maximum number of input PDFs: **5-10 PDFs** (depending on size)
- Total input size: **~4-5 MB** (leaving ~1-2 MB for processing overhead and response)
- Maximum pages per input PDF: **No hard limit per PDF**, but total output must be ≤ 25 pages
- Maximum total pages across all inputs: **25 pages** (enforced by MAX_QUICKJOB_PAGES)

**Output Constraints:**
- Maximum output size: **~5-6 MB** (must fit in response payload)
- Maximum pages: **25 pages** (MAX_QUICKJOB_PAGES)

**Recommended Limits:**
- **Small PDFs (<500 KB each):** Up to 10 PDFs, total ≤ 25 pages
- **Medium PDFs (500 KB - 1 MB each):** Up to 5 PDFs, total ≤ 25 pages
- **Large PDFs (1-2 MB each):** Up to 2-3 PDFs, total ≤ 25 pages

#### PDF Split

**Input Constraints:**
- Maximum input PDF size: **~5 MB** (must fit in request payload)
- Maximum input pages: **No hard limit**, but output must be ≤ 25 pages

**Output Constraints:**
- Maximum output size: **~5-6 MB** (must fit in response payload)
- Maximum pages: **25 pages** (MAX_QUICKJOB_PAGES)

**Recommended Limits:**
- **Input PDF:** Up to 5 MB
- **Output pages:** Up to 25 pages per split operation

### Time Constraints

- **Processing Timeout:** 30 seconds (28 seconds Lambda timeout + 2 seconds buffer)
- **Expected Processing Time:**
  - **Merge (5 PDFs, 25 pages total):** 1-5 seconds
  - **Split (1 PDF, 25 pages):** 1-3 seconds
  - **Complex operations:** Up to 10-15 seconds

### Memory Constraints

- **Available Memory:** 3008 MB
- **pdf-lib Memory Usage:** 
  - Loading PDF: ~2-3x PDF size in memory
  - Processing: Additional ~1-2x PDF size
  - **Safe working limit:** ~10-15 MB total PDF data in memory simultaneously

---

## PDF Merge Specification

### Operation Type

`input_type: "pdf_merge"`

### Request Format

#### JSON Request (Recommended)

```json
{
  "input_type": "pdf_merge",
  "pdfs": [
    {
      "data": "base64_encoded_pdf_1",
      "filename": "document1.pdf"
    },
    {
      "data": "base64_encoded_pdf_2",
      "filename": "document2.pdf"
    }
  ],
  "options": {
    "page_order": "sequential",
    "remove_duplicates": false
  }
}
```

#### Multipart Request (Alternative)

```
Content-Type: multipart/form-data

input_type: pdf_merge
pdfs: [binary PDF file 1]
pdfs: [binary PDF file 2]
pdfs: [binary PDF file 3]
options: {"page_order": "sequential"}
```

### Request Fields

#### `input_type` (required)
- **Type:** String
- **Value:** `"pdf_merge"`
- **Description:** Identifies this as a PDF merge operation

#### `pdfs` (required)
- **Type:** Array of objects (JSON) or Array of files (multipart)
- **Min Length:** 2 PDFs
- **Max Length:** 10 PDFs (recommended), no hard limit but constrained by payload size
- **Description:** Array of PDFs to merge

**JSON Format:**
```json
{
  "data": "base64_encoded_pdf_string",
  "filename": "optional_filename.pdf"
}
```

**Multipart Format:**
- Field name: `pdfs`
- Content-Type: `application/pdf`
- Multiple files with same field name

#### `options` (optional)

**`page_order`** (optional)
- **Type:** String
- **Values:** `"sequential"` (default), `"reverse"`
- **Description:** Order in which pages from each PDF are added
  - `"sequential"`: PDFs merged in order, pages added sequentially
  - `"reverse"`: PDFs merged in reverse order

**`remove_duplicates`** (optional)
- **Type:** Boolean
- **Default:** `false`
- **Description:** If `true`, attempts to remove duplicate pages (exact content match)

### Processing Logic

1. **Validation:**
   - Verify at least 2 PDFs provided
   - Validate each PDF is valid (using pdf-lib)
   - Count total pages across all PDFs
   - Reject if total pages > 25 (MAX_QUICKJOB_PAGES)

2. **Merge Process:**
   - Load all PDFs into memory using pdf-lib
   - Create new PDFDocument
   - Copy pages from each PDF in specified order
   - If `remove_duplicates: true`, compare page content and skip duplicates
   - Save merged PDF

3. **Output:**
   - Return merged PDF as binary response
   - Include `X-PDF-Pages` header with total page count

### Example Request

```bash
curl -X POST https://api.podpdf.com/quickjob \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "input_type": "pdf_merge",
    "pdfs": [
      {
        "data": "JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PAovVHlwZSAvQ2F0YWxvZwovUGFnZXMgMiAwIFIKPj4KZW5kb2JqCjIgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFszIDAgUl0KL0NvdW50IDEKPD4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL1BhZ2UKL1BhcmVudCAyIDAgUgovTWVkaWFCb3ggWzAgMCA2MTIgNzkyXQovUmVzb3VyY2VzIDw8Ci9Gb250IDw8Ci9GMSA0IDAgUgo+Pgo+PgovQ29udGVudHMgNSAwIFIKPj4KZW5kb2JqCjQgMCBvYmoKPDwKL1R5cGUgL0ZvbnQKL1N1YnR5cGUgL1R5cGUxCi9CYXNlRm9udCAvSGVsdmV0aWNhCj4+CmVuZG9iagoxIDAgb2JqCjw8Ci9UeXBlIC9DYXRhbG9nCi9QYWdlcyAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovTGVuZ3RoIDQ0Cj4+CnN0cmVhbQpCVAovRjEgMTIgVGYKNzAgNzIwIFRkCihIZWxsbyBXb3JsZCkgVGoKRVQKZW5kc3RyZWFtCmVuZG9iago=",
        "filename": "doc1.pdf"
      },
      {
        "data": "JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PAovVHlwZSAvQ2F0YWxvZwovUGFnZXMgMiAwIFIKPj4KZW5kb2JqCjIgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFszIDAgUl0KL0NvdW50IDEKPD4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL1BhZ2UKL1BhcmVudCAyIDAgUgovTWVkaWFCb3ggWzAgMCA2MTIgNzkyXQovUmVzb3VyY2VzIDw8Ci9Gb250IDw8Ci9GMSA0IDAgUgo+Pgo+PgovQ29udGVudHMgNSAwIFIKPj4KZW5kb2JqCjQgMCBvYmoKPDwKL1R5cGUgL0ZvbnQKL1N1YnR5cGUgL1R5cGUxCi9CYXNlRm9udCAvSGVsdmV0aWNhCj4+CmVuZG9iagoxIDAgb2JqCjw8Ci9UeXBlIC9DYXRhbG9nCi9QYWdlcyAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovTGVuZ3RoIDQ0Cj4+CnN0cmVhbQpCVAovRjEgMTIgVGYKNzAgNzIwIFRkCihIZWxsbyBXb3JsZCkgVGoKRVQKZW5kc3RyZWFtCmVuZG9iago=",
        "filename": "doc2.pdf"
      }
    ],
    "options": {
      "page_order": "sequential"
    }
  }'
```

---

## PDF Split Specification

### Operation Type

`input_type: "pdf_split"`

### Request Format

#### JSON Request (Recommended)

```json
{
  "input_type": "pdf_split",
  "pdf": {
    "data": "base64_encoded_pdf",
    "filename": "document.pdf"
  },
  "options": {
    "pages": [1, 3, 5],
    "page_ranges": ["1-3", "5-7"],
    "mode": "pages"
  }
}
```

#### Multipart Request (Alternative)

```
Content-Type: multipart/form-data

input_type: pdf_split
pdf: [binary PDF file]
options: {"pages": [1, 3, 5], "mode": "pages"}
```

### Request Fields

#### `input_type` (required)
- **Type:** String
- **Value:** `"pdf_split"`
- **Description:** Identifies this as a PDF split operation

#### `pdf` (required)
- **Type:** Object (JSON) or File (multipart)
- **Description:** The PDF to split

**JSON Format:**
```json
{
  "data": "base64_encoded_pdf_string",
  "filename": "optional_filename.pdf"
}
```

**Multipart Format:**
- Field name: `pdf`
- Content-Type: `application/pdf`

#### `options` (required)

**`mode`** (required)
- **Type:** String
- **Values:** `"pages"`, `"ranges"`, `"both"`
- **Description:** How to specify which pages to extract
  - `"pages"`: Use `pages` array (individual page numbers)
  - `"ranges"`: Use `page_ranges` array (page ranges like "1-3")
  - `"both"`: Use both `pages` and `page_ranges`

**`pages`** (optional, required if `mode` is `"pages"` or `"both"`)
- **Type:** Array of integers
- **Description:** Array of 1-indexed page numbers to extract
- **Example:** `[1, 3, 5, 7]` extracts pages 1, 3, 5, and 7

**`page_ranges`** (optional, required if `mode` is `"ranges"` or `"both"`)
- **Type:** Array of strings
- **Description:** Array of page ranges in format `"start-end"` (inclusive)
- **Example:** `["1-3", "5-7"]` extracts pages 1, 2, 3, 5, 6, and 7
- **Note:** Ranges are inclusive on both ends

**`sort_order`** (optional)
- **Type:** String
- **Values:** `"original"` (default), `"ascending"`, `"descending"`
- **Description:** Order of pages in output PDF
  - `"original"`: Pages in order specified (may be out of order)
  - `"ascending"`: Pages sorted in ascending order
  - `"descending"**: Pages sorted in descending order

### Processing Logic

1. **Validation:**
   - Verify PDF is valid (using pdf-lib)
   - Count total pages in input PDF
   - Parse and validate page numbers/ranges
   - Reject if requested pages exceed 25 (MAX_QUICKJOB_PAGES)
   - Reject if any page number > total pages in PDF

2. **Split Process:**
   - Load PDF into memory using pdf-lib
   - Extract requested pages based on mode
   - Create new PDFDocument
   - Copy requested pages in specified order
   - Apply sorting if specified
   - Save split PDF

3. **Output:**
   - Return split PDF as binary response
   - Include `X-PDF-Pages` header with extracted page count

### Example Requests

#### Extract Specific Pages

```json
{
  "input_type": "pdf_split",
  "pdf": {
    "data": "base64_encoded_pdf"
  },
  "options": {
    "mode": "pages",
    "pages": [1, 3, 5, 7, 9],
    "sort_order": "ascending"
  }
}
```

#### Extract Page Ranges

```json
{
  "input_type": "pdf_split",
  "pdf": {
    "data": "base64_encoded_pdf"
  },
  "options": {
    "mode": "ranges",
    "page_ranges": ["1-5", "10-15", "20-25"],
    "sort_order": "original"
  }
}
```

#### Extract Both Individual Pages and Ranges

```json
{
  "input_type": "pdf_split",
  "pdf": {
    "data": "base64_encoded_pdf"
  },
  "options": {
    "mode": "both",
    "pages": [1, 50],
    "page_ranges": ["5-10", "20-25"],
    "sort_order": "ascending"
  }
}
```

---

## Request Format

### Authentication

Both JWT tokens and API keys are supported (same as existing `/quickjob` endpoint).

**JWT Token:**
```
Authorization: Bearer <jwt_token>
```

**API Key:**
```
X-API-Key: <api_key>
```

### Content Types

1. **JSON Request:**
   - `Content-Type: application/json`
   - PDFs encoded as base64 strings in JSON

2. **Multipart Request:**
   - `Content-Type: multipart/form-data`
   - PDFs sent as binary files

### Request Size Validation

- **JSON:** Total request body size must be < 6 MB
- **Multipart:** Total multipart payload must be < 6 MB
- **Base64 Overhead:** Base64 encoding adds ~33% size overhead
  - 5 MB PDF → ~6.7 MB base64 encoded
  - **Practical limit:** ~4-4.5 MB total PDF data in JSON format

---

## Response Format

### Success Response

**Status Code:** `200 OK`

**Headers:**
```
Content-Type: application/pdf
Content-Disposition: inline; filename="merged.pdf" (or "split.pdf")
X-PDF-Pages: 15
X-Job-Id: <job_id>
```

**Body:** Binary PDF content (base64 encoded if using API Gateway)

### Error Responses

#### 400 Bad Request

**Invalid Input Type:**
```json
{
  "error": {
    "code": "INVALID_INPUT_TYPE",
    "message": "input_type must be 'pdf_merge' or 'pdf_split'"
  }
}
```

**Missing PDFs (Merge):**
```json
{
  "error": {
    "code": "MISSING_PDFS",
    "message": "At least 2 PDFs required for merge operation"
  }
}
```

**Missing PDF (Split):**
```json
{
  "error": {
    "code": "MISSING_PDF",
    "message": "PDF is required for split operation"
  }
}
```

**Invalid PDF:**
```json
{
  "error": {
    "code": "INVALID_PDF",
    "message": "One or more PDFs are invalid or corrupted",
    "details": {
      "index": 1,
      "filename": "document2.pdf"
    }
  }
}
```

**Page Limit Exceeded:**
```json
{
  "error": {
    "code": "PAGE_LIMIT_EXCEEDED",
    "message": "Total pages (30) exceeds maximum allowed pages (25)",
    "details": {
      "total_pages": 30,
      "max_pages": 25
    }
  }
}
```

**Invalid Page Numbers (Split):**
```json
{
  "error": {
    "code": "INVALID_PAGE_NUMBERS",
    "message": "Page numbers must be between 1 and total pages",
    "details": {
      "requested_pages": [1, 5, 50],
      "total_pages": 20,
      "invalid_pages": [50]
    }
  }
}
```

**Payload Too Large:**
```json
{
  "error": {
    "code": "PAYLOAD_TOO_LARGE",
    "message": "Request payload exceeds 6 MB limit"
  }
}
```

#### 408 Request Timeout

```json
{
  "error": {
    "code": "QUICKJOB_TIMEOUT",
    "message": "Job processing exceeded 30-second timeout. Please use /longjob endpoint for larger documents.",
    "details": {
      "job_id": "<job_id>",
      "timeout_seconds": 30,
      "suggestion": "use_longjob_endpoint"
    }
  }
}
```

#### 500 Internal Server Error

```json
{
  "error": {
    "code": "PDF_PROCESSING_FAILED",
    "message": "Failed to process PDF: <error_message>"
  }
}
```

---

## Implementation Details

### Library

**pdf-lib** (already installed: `^1.17.1`)

### Service Module

Create new service: `src/services/pdfOperations.js`

### Key Functions

#### `mergePdfs(pdfs, options)`
- **Input:** Array of PDF buffers, merge options
- **Output:** `{buffer: Buffer, pages: number}`
- **Process:**
  1. Load all PDFs using `PDFDocument.load()`
  2. Count total pages, reject if > 25
  3. Create new `PDFDocument`
  4. Copy pages from each PDF in order
  5. Save and return buffer

#### `splitPdf(pdfBuffer, options)`
- **Input:** PDF buffer, split options
- **Output:** `{buffer: Buffer, pages: number}`
- **Process:**
  1. Load PDF using `PDFDocument.load()`
  2. Parse page numbers/ranges
  3. Validate page numbers
  4. Create new `PDFDocument`
  5. Copy requested pages
  6. Apply sorting if specified
  7. Save and return buffer

### Handler Integration

Modify `src/handlers/quickjob.js` to:
1. Detect `input_type: "pdf_merge"` or `"pdf_split"`
2. Route to appropriate service function
3. Apply same validation, rate limiting, quota checks
4. Return PDF binary response

### Validation

- **PDF Validation:** Use `PDFDocument.load()` - throws error if invalid
- **Page Count:** Use `pdfDoc.getPageCount()`
- **Page Number Validation:** Ensure 1-indexed, within valid range
- **Size Validation:** Check request body size before processing

---

## Performance Considerations

### Memory Usage

**PDF Merge:**
- Loading N PDFs: ~2-3x total PDF size
- Processing: Additional ~1-2x for output
- **Example:** 5 PDFs × 1 MB = 5 MB input → ~15-20 MB memory usage

**PDF Split:**
- Loading 1 PDF: ~2-3x PDF size
- Processing: Additional ~1x for output
- **Example:** 5 MB PDF → ~15 MB memory usage

### Processing Time Estimates

**PDF Merge:**
- 2 PDFs, 10 pages total: ~0.5-1 second
- 5 PDFs, 25 pages total: ~1-3 seconds
- 10 PDFs, 25 pages total: ~2-5 seconds

**PDF Split:**
- 1 PDF, extract 5 pages: ~0.5-1 second
- 1 PDF, extract 25 pages: ~1-2 seconds
- Complex ranges: ~1-3 seconds

### Optimization Strategies

1. **Streaming (Future):** For very large operations, consider streaming
2. **Parallel Loading:** Load PDFs in parallel (Promise.all)
3. **Early Validation:** Validate page counts before loading all PDFs
4. **Memory Management:** Release PDF documents after copying pages

### Recommended Limits Summary

| Operation | Max Input PDFs | Max Input Size | Max Output Pages | Max Output Size |
|-----------|---------------|----------------|------------------|-----------------|
| **Merge** | 5-10 PDFs | ~4-5 MB total | 25 pages | ~5-6 MB |
| **Split** | 1 PDF | ~5 MB | 25 pages | ~5-6 MB |

**Conservative Limits (Recommended):**
- **Merge:** 5 PDFs, 3 MB total, 20 pages output
- **Split:** 1 PDF, 4 MB, 20 pages output

**Aggressive Limits (May timeout):**
- **Merge:** 10 PDFs, 5 MB total, 25 pages output
- **Split:** 1 PDF, 5 MB, 25 pages output

---

## Testing Considerations

### Unit Tests

- Test PDF merge with 2, 5, 10 PDFs
- Test PDF split with various page selections
- Test error cases (invalid PDFs, page limits, etc.)
- Test edge cases (empty PDFs, single page, etc.)

### Integration Tests

- Test with real PDFs of various sizes
- Test timeout scenarios (large PDFs)
- Test payload size limits
- Test authentication (JWT and API key)

### Performance Tests

- Measure processing time for various PDF sizes
- Monitor memory usage
- Test concurrent requests
- Verify 30-second timeout handling

---

## Future Enhancements

1. **Multiple Split Outputs:** Return multiple PDFs (would require different response format)
2. **Page Rotation:** Rotate pages during merge/split
3. **Metadata Preservation:** Preserve PDF metadata (author, title, etc.)
4. **Watermarking:** Add watermarks during merge/split
5. **Compression:** Optimize output PDF size
6. **Long Job Support:** Extend to long job for larger operations

---

## Summary

### Size Limits for Quick Job PDF Operations

**PDF Merge:**
- **Recommended:** 5 PDFs, ~3 MB total, ≤20 pages output
- **Maximum:** 10 PDFs, ~5 MB total, ≤25 pages output
- **Constraint:** Must complete in <30 seconds, fit in 6 MB payload

**PDF Split:**
- **Recommended:** 1 PDF, ~4 MB, ≤20 pages output
- **Maximum:** 1 PDF, ~5 MB, ≤25 pages output
- **Constraint:** Must complete in <30 seconds, fit in 6 MB payload

**Key Factors:**
1. Lambda payload limit: 6 MB (request + response)
2. Quick job timeout: 30 seconds
3. Page limit: 25 pages (MAX_QUICKJOB_PAGES)
4. Memory: 3008 MB (sufficient for operations)
5. Base64 overhead: ~33% for JSON requests

**Practical Recommendation:**
- Keep total PDF data under 4 MB for JSON requests
- Keep total PDF data under 5 MB for multipart requests
- Limit output to 20 pages for reliable performance
- Test with actual PDFs to validate performance

