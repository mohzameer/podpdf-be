# Image to PDF Conversion - Specification Plan

**Version:** 1.1.0  
**Date:** December 28, 2025  
**Status:** Ready for Implementation

**Key Decisions:**
- **Input Method:** Multipart/form-data (binary upload)
- **Implementation:** Sharp + pdf-lib (no Puppeteer)

---

## Overview

This document outlines the specification plan for adding PNG/JPG to PDF conversion support to PodPDF. The feature will allow users to convert single or multiple images into PDF documents.

---

## 1. Requirements

### 1.1 Supported Image Formats
- **PNG** (`.png`) - Portable Network Graphics
- **JPEG/JPG** (`.jpg`, `.jpeg`) - Joint Photographic Experts Group
- **Future consideration:** WebP, GIF (animated GIFs would be converted to static first frame)

### 1.2 Input Methods

**Option A: Base64 Encoded**
- Images provided as base64-encoded strings in JSON payload
- Pros: Simple, works with existing JSON API structure
- Cons: Increases payload size (~33% overhead), limited by API Gateway payload size

**Option B: Image URLs**
- Images provided as HTTPS URLs
- Pros: Smaller payload, can handle large images
- Cons: Requires Lambda to fetch images (network latency, potential failures)

**Option C: Binary Upload (Multipart) - RECOMMENDED**
- Images uploaded as binary data in multipart/form-data
- Pros: 
  - No base64 overhead (33% more efficient)
  - Standard HTTP file upload pattern
  - Native browser FormData support
  - Better mobile SDK compatibility
  - Larger effective payload (full 10MB vs ~7.5MB with base64)
- Cons: 
  - Requires API Gateway binary media type configuration
  - Different parsing in Lambda (multipart parser needed)

**Recommendation:** Use **Option C (Binary Upload/Multipart)** for optimal efficiency. Image uploads are fundamentally binary operations, and multipart/form-data is the standard approach. The 33% payload savings and native browser/mobile support outweigh the minor configuration changes needed.

### 1.3 Single vs Multiple Images

**Single Image:**
- One image per PDF
- One page per PDF (unless image is very large and needs scaling)

**Multiple Images:**
- Array of images in one request
- Each image becomes one page in the PDF (default behavior)
- Or configurable layout (e.g., 2x2 grid per page)

**Recommendation:** Support both single and multiple images. Default: one image = one page.

---

## 2. API Design

### 2.1 Extend Existing Endpoints

**Approach:** Add new `input_type: "image"` to existing `/quickjob` and `/longjob` endpoints using multipart/form-data.

**Request Format (Multipart/form-data):**

```bash
# cURL example
curl -X POST https://api.podpdf.com/quickjob \
  -H "Authorization: Bearer <token>" \
  -F "input_type=image" \
  -F "images=@photo1.png" \
  -F "images=@photo2.jpg" \
  -F 'options={"format":"A4","margin":{"top":"10mm","right":"10mm","bottom":"10mm","left":"10mm"},"fit":"contain"}'
```

```javascript
// JavaScript/Browser example
const formData = new FormData();
formData.append('input_type', 'image');
formData.append('images', file1);  // File object from input[type=file]
formData.append('images', file2);
formData.append('options', JSON.stringify({
  format: 'A4',
  margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
  fit: 'contain'
}));

const response = await fetch('/quickjob', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` },
  body: formData
});
```

```python
# Python example
import requests

files = [
    ('images', ('photo1.png', open('photo1.png', 'rb'), 'image/png')),
    ('images', ('photo2.jpg', open('photo2.jpg', 'rb'), 'image/jpeg')),
]
data = {
    'input_type': 'image',
    'options': '{"format":"A4","fit":"contain"}'
}

response = requests.post(
    'https://api.podpdf.com/quickjob',
    headers={'Authorization': 'Bearer <token>'},
    files=files,
    data=data
)
```

**Form Fields:**
- `input_type` (string, required): Must be `"image"`
- `images` (file, required): One or more image files (can repeat field for multiple images)
- `options` (string, optional): JSON string with PDF options

**Options Object:**
```json
{
  "format": "A4",           // Page size: "A4", "Letter", etc.
  "margin": {               // Page margins
    "top": "10mm",
    "right": "10mm",
    "bottom": "10mm",
    "left": "10mm"
  },
  "fit": "contain",         // Image fit: "contain", "cover", "fill", "none"
  "landscape": false        // Page orientation
}
```

### 2.2 New Endpoint (Alternative)

**Approach:** Create dedicated `/image-to-pdf` endpoint.

**Pros:**
- Cleaner separation of concerns
- Can optimize specifically for images
- Different rate limits/pricing if needed

**Cons:**
- More endpoints to maintain
- Duplicate authentication/validation logic

**Recommendation:** Extend existing endpoints (simpler, consistent API).

---

## 3. Implementation Approach

### 3.1 Conversion Method

**Option A: Puppeteer (HTML Canvas)**
- Create HTML page with `<img>` tags
- Use Puppeteer to render and convert to PDF
- Pros: Reuses existing infrastructure, consistent with HTML/Markdown flow
- Cons: Slower (2-4s cold start), high memory usage (~500-800 MB), overkill for images

**Option B: pdf-lib Library**
- Direct PDF creation from image buffers
- Pros: Faster, lighter weight, no browser needed
- Cons: Limited image format support, no image processing

**Option C: Sharp + pdf-lib - RECOMMENDED**
- Use Sharp for image processing (resize, format detection, validation)
- Use pdf-lib for PDF creation
- Pros:
  - **Fast** - No browser startup overhead (~500ms cold start vs 2-4s)
  - **Low memory** - ~100-200 MB vs ~500-800 MB for Puppeteer
  - **Professional quality** - Sharp is industry-standard for image processing
  - **Better control** - Precise image placement, sizing, and page layout
  - **Cost effective** - Faster execution = lower Lambda billing
  - **Smaller package** - No Chromium layer needed (~10 MB vs ~50 MB)
- Cons:
  - Sharp requires Lambda layer for native binaries (well-documented solution)
  - Different code path from HTML/Markdown (but image-to-PDF IS fundamentally different)

**Recommendation:** Use **Option C (Sharp + pdf-lib)** for optimal performance. Image-to-PDF doesn't need browser rendering - it's a direct image → PDF operation. Sharp provides excellent image handling, and pdf-lib offers precise PDF control. This combination delivers significant performance and cost improvements over Puppeteer.

**Performance Comparison:**
| Metric | Puppeteer | Sharp + pdf-lib |
|--------|-----------|-----------------|
| Cold Start | 2-4 seconds | ~500ms |
| Memory Usage | 500-800 MB | 100-200 MB |
| Single Image | 3-5 seconds | 1-2 seconds |
| 10 Images | 10-15 seconds | 3-5 seconds |
| Lambda Cost | Higher | ~60% lower |

### 3.2 Image Processing Flow

1. **Parse Multipart Request:**
   - Parse multipart/form-data using `lambda-multipart-parser` or `busboy`
   - Extract image files (binary buffers)
   - Extract `input_type` and `options` fields
   - Validate content types (must be `image/png` or `image/jpeg`)

2. **Image Validation (using Sharp):**
   - Use Sharp to read image metadata (format, dimensions)
   - Check file size (max 5MB per image, total 10MB for all images)
   - Check dimensions (max 10000x10000 pixels)
   - Verify image is valid and not corrupted (Sharp throws on invalid images)
   - Validate format is PNG or JPEG

3. **Image Processing (using Sharp):**
   - Resize images if needed to fit page dimensions
   - Calculate optimal placement based on `fit` option
   - Convert to consistent format for PDF embedding

4. **PDF Generation (using pdf-lib):**
   - Create new PDF document with pdf-lib
   - For each image:
     - Embed image into PDF (PNG or JPEG)
     - Create new page with specified size (A4, Letter, etc.)
     - Calculate image dimensions based on `fit` option
     - Draw image centered on page with margins
   - Save PDF to buffer

5. **Page Limit Enforcement:**
   - Count images = pages (1 image = 1 page)
   - If more than 100 images, truncate to first 100
   - Return `X-PDF-Truncated: true` header if truncated

### 3.3 Code Structure

**New service file: `src/services/imagePdf.js`:**
```javascript
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');

// Page dimensions in points (72 points = 1 inch)
const PAGE_SIZES = {
  A4: { width: 595.28, height: 841.89 },
  Letter: { width: 612, height: 792 },
  Legal: { width: 612, height: 1008 },
};

/**
 * Convert images to PDF using Sharp + pdf-lib
 * @param {Array<{buffer: Buffer, contentType: string}>} images - Array of image buffers
 * @param {object} options - PDF options
 * @returns {Promise<{buffer: Buffer, pageCount: number, truncated: boolean}>}
 */
async function imagesToPdf(images, options = {}) {
  const {
    format = 'A4',
    margin = { top: 10, right: 10, bottom: 10, left: 10 },
    fit = 'contain',
    landscape = false,
  } = options;

  // Enforce 100 image limit
  const truncated = images.length > 100;
  const imagesToProcess = images.slice(0, 100);

  // Get page dimensions
  let { width: pageWidth, height: pageHeight } = PAGE_SIZES[format] || PAGE_SIZES.A4;
  if (landscape) {
    [pageWidth, pageHeight] = [pageHeight, pageWidth];
  }

  // Convert margins from mm to points (1mm = 2.835 points)
  const marginPts = {
    top: parseMargin(margin.top),
    right: parseMargin(margin.right),
    bottom: parseMargin(margin.bottom),
    left: parseMargin(margin.left),
  };

  // Create PDF document
  const pdfDoc = await PDFDocument.create();

  for (const imageData of imagesToProcess) {
    // Validate and process image with Sharp
    const metadata = await sharp(imageData.buffer).metadata();
    
    // Embed image in PDF
    let embeddedImage;
    if (metadata.format === 'png') {
      embeddedImage = await pdfDoc.embedPng(imageData.buffer);
    } else {
      embeddedImage = await pdfDoc.embedJpg(imageData.buffer);
    }

    // Create page and draw image
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    const { x, y, width, height } = calculateImagePlacement(
      embeddedImage.width,
      embeddedImage.height,
      pageWidth,
      pageHeight,
      marginPts,
      fit
    );
    
    page.drawImage(embeddedImage, { x, y, width, height });
  }

  const pdfBuffer = await pdfDoc.save();
  
  return {
    buffer: Buffer.from(pdfBuffer),
    pageCount: imagesToProcess.length,
    truncated,
  };
}

/**
 * Validate image buffer using Sharp
 * @param {Buffer} buffer - Image buffer
 * @returns {Promise<{valid: boolean, format: string, width: number, height: number, size: number, error?: string}>}
 */
async function validateImage(buffer) {
  try {
    const metadata = await sharp(buffer).metadata();
    
    if (!['png', 'jpeg', 'jpg'].includes(metadata.format)) {
      return { valid: false, error: 'INVALID_IMAGE_FORMAT' };
    }
    
    if (metadata.width > 10000 || metadata.height > 10000) {
      return { valid: false, error: 'IMAGE_TOO_LARGE' };
    }
    
    if (buffer.length > 5 * 1024 * 1024) {
      return { valid: false, error: 'IMAGE_TOO_LARGE' };
    }
    
    return {
      valid: true,
      format: metadata.format,
      width: metadata.width,
      height: metadata.height,
      size: buffer.length,
    };
  } catch (error) {
    return { valid: false, error: 'INVALID_IMAGE_DATA' };
  }
}

module.exports = { imagesToPdf, validateImage };
```

**Multipart parsing in handler:**
```javascript
const multipart = require('lambda-multipart-parser');

async function parseImageRequest(event) {
  const parsed = await multipart.parse(event);
  
  return {
    inputType: parsed.input_type,
    images: parsed.files.filter(f => f.fieldname === 'images').map(f => ({
      buffer: f.content,
      contentType: f.contentType,
      filename: f.filename,
    })),
    options: parsed.options ? JSON.parse(parsed.options) : {},
  };
}
```

---

## 4. Validation Rules

### 4.1 Input Validation

- Request must be `multipart/form-data` content type
- `input_type` field must be `"image"` (in addition to existing `"html"` and `"markdown"`)
- `images` field must contain at least one file
- Each image must have valid content type: `image/png`, `image/jpeg`, or `image/jpg`
- Supported formats: PNG, JPEG/JPG
- Maximum images per request: 100 (enforced via truncation, not rejection)
- Maximum total payload size: 10MB (API Gateway limit)
- `options` field (if provided) must be valid JSON string

### 4.2 Image Validation (using Sharp)

- Maximum file size per image: 5MB (binary size, no base64 overhead)
- Maximum total size: 10MB for all images combined
- Maximum dimensions: 10000x10000 pixels
- Must be valid PNG or JPEG (Sharp validates on metadata read)
- Must not be corrupted (Sharp throws error on invalid images)
- Image format auto-detected from binary data (not relying on content-type header)

### 4.3 Page Limit

- Same 100-page limit applies
- Each image = 1 page (default)
- Very large images may span multiple pages (if `pages_per_image > 1` in options)
- If total pages exceed 100, reject with `PAGE_LIMIT_EXCEEDED` error

---

## 5. Options & Configuration

### 5.1 PDF Options (Same as HTML/Markdown)

- `format`: Page size (`"A4"`, `"Letter"`, etc.)
- `margin`: Page margins (`top`, `right`, `bottom`, `left`)
- `landscape`: Boolean (default: `false`)
- `printBackground`: Boolean (default: `true`)

### 5.2 Image-Specific Options

- `fit`: How to fit image on page
  - `"contain"` (default): Fit whole image, maintain aspect ratio, may have whitespace
  - `"cover"`: Fill entire page, may crop image
  - `"fill"`: Stretch image to fill page (may distort)
  - `"none"`: Use image's natural size (may exceed page)

- `pages_per_image`: Number of pages per image (default: `1`)
  - For very large images that need to be split across pages
  - Each page shows portion of image

- `image_quality`: JPEG quality if re-encoding (1-100, default: 90)

---

## 6. Error Handling

### 6.1 New Error Codes

- `INVALID_IMAGE_FORMAT`: Image format not supported (not PNG/JPEG)
- `INVALID_IMAGE_DATA`: Image data is corrupted or invalid (Sharp validation failed)
- `IMAGE_TOO_LARGE`: Image exceeds size limit (5MB) or dimension limit (10000x10000)
- `MISSING_IMAGES`: No image files in multipart request
- `INVALID_MULTIPART`: Malformed multipart/form-data request
- `INVALID_OPTIONS_JSON`: Options field is not valid JSON

### 6.2 Existing Error Codes (Reused)

- `INVALID_INPUT_TYPE`: `input_type` is not `"html"`, `"markdown"`, or `"image"`
- `MISSING_INPUT_TYPE`: `input_type` field is missing
- `PAYLOAD_TOO_LARGE`: Total request payload exceeds 10MB

**Note:** Unlike HTML/Markdown, images exceeding 100 are **truncated** (not rejected). The first 100 images are processed and `X-PDF-Truncated: true` header is returned.

---

## 7. Performance Considerations

### 7.1 Lambda Execution Time (Sharp + pdf-lib)

- **Single image (small):** ~0.5-1 second
- **Single image (large, 5MB):** ~1-2 seconds
- **Multiple images (10 images):** ~2-4 seconds
- **Multiple images (50 images):** ~10-15 seconds
- **Multiple images (100 images):** ~20-30 seconds (within QuickJob limit)

**Comparison vs Puppeteer:**
| Scenario | Puppeteer | Sharp + pdf-lib | Improvement |
|----------|-----------|-----------------|-------------|
| Single small image | 2-3s | 0.5-1s | ~3x faster |
| Single large image | 5-8s | 1-2s | ~4x faster |
| 10 images | 10-15s | 2-4s | ~4x faster |
| Cold start | 2-4s | ~500ms | ~5x faster |

**Recommendation:** 
- QuickJob: Up to 100 images (all within 30s limit with Sharp)
- LongJob: For very large images or when guaranteed delivery is needed

### 7.2 Memory Usage

- **No base64 overhead** - Binary uploads use actual file size
- **Sharp is memory-efficient** - Streams images, doesn't load full buffer
- **Recommended Lambda memory:** 1024 MB (vs 10,240 MB for Puppeteer)
- **Peak memory:** ~200-400 MB for 100 images

### 7.3 Cost Impact

- **Significantly lower than HTML/Markdown conversion**
- **Faster execution** = lower Lambda billing (~60% cost reduction)
- **Smaller Lambda** = less memory-time billing
- **No Chromium** = faster cold starts
- **Pricing:** Same as HTML/Markdown (no additional charge to user)

---

## 8. Testing Strategy

### 8.1 Unit Tests

- Base64 decoding
- Image format validation
- Image size validation
- PDF generation from single image
- PDF generation from multiple images
- Page counting for image PDFs
- Error handling for invalid images

### 8.2 Integration Tests

- QuickJob with single image
- QuickJob with multiple images
- LongJob with images
- Page limit enforcement
- Large image handling
- Invalid image rejection

### 8.3 Edge Cases

- Very large images (approaching 5MB limit)
- Very small images (1x1 pixel)
- Corrupted image data
- Invalid content-type headers (rely on Sharp detection, not headers)
- Empty images field (no files uploaded)
- 100 images (maximum before truncation)
- 101+ images (truncation behavior)
- Mixed valid/invalid images in same request
- Malformed multipart request
- Missing input_type field
- Invalid options JSON

---

## 9. Future Enhancements

### 9.1 Phase 2 Features

- **Image URLs:** Support fetching images from HTTPS URLs
- **Image Processing:** Resize, crop, rotate images before PDF conversion
- **Watermarks:** Add text or image watermarks
- **Image Quality:** Adjust JPEG quality, PNG compression
- **Layout Options:** Multiple images per page (grid layouts)

### 9.2 Phase 3 Features

- **WebP Support:** Add WebP image format
- **GIF Support:** Convert animated GIFs (first frame or all frames)
- **TIFF Support:** Add TIFF format support
- **PDF to PDF:** Re-format existing PDFs (merge, split, etc.)

---

## 10. Migration & Rollout

### 10.1 Implementation Steps

1. **Phase 1: Infrastructure Setup**
   - Add Sharp Lambda layer to serverless.yml
   - Add dependencies: `sharp`, `pdf-lib`, `lambda-multipart-parser`
   - Configure API Gateway for `multipart/form-data` binary media type
   - Create `src/services/imagePdf.js` service

2. **Phase 2: Core Implementation**
   - Implement multipart request parsing
   - Implement `validateImage()` function using Sharp
   - Implement `imagesToPdf()` function using Sharp + pdf-lib
   - Add `input_type: "image"` to validation in `validation.js`
   - Update `quickjob.js` handler to detect and handle multipart requests
   - Update `longjob.js` and `longjob-processor.js` handlers
   - Add new error codes to `errors.js`

3. **Phase 3: Testing**
   - Unit tests for image validation
   - Unit tests for PDF generation
   - Integration tests for QuickJob with images
   - Integration tests for LongJob with images
   - Edge case testing (large images, 100 images, invalid images)
   - Performance benchmarking

4. **Phase 4: Documentation**
   - Update SPEC.md with image input type
   - Update ENDPOINTS.md with examples
   - Update error documentation

5. **Phase 5: Deployment**
   - Deploy to dev environment
   - Integration testing in dev
   - Deploy to prod
   - Monitor performance and costs

### 10.2 Backward Compatibility

- Existing `input_type: "html"` and `input_type: "markdown"` continue to work
- No breaking changes to existing API
- New feature is additive only

---

## 11. Decisions Made

1. **Input Method:** Use multipart/form-data (Option C)
   - **Rationale:** No base64 overhead, standard file upload pattern, 33% more payload capacity

2. **Implementation:** Use Sharp + pdf-lib (Option C)
   - **Rationale:** ~4x faster, ~60% lower cost, better image quality, lower memory

3. **Image URLs:** Defer to v2
   - **Rationale:** Simpler initial implementation, multipart handles direct uploads well

4. **Multiple Images Layout:** Defer to v2
   - **Rationale:** One image per page is sufficient for MVP

5. **Image Processing (resize, crop):** Defer to v2
   - **Rationale:** Focus on core conversion first; Sharp makes this easy to add later

6. **Pricing:** Same as HTML/Markdown
   - **Rationale:** Simpler, consistent pricing; actually costs less to run

7. **Rate Limits:** Same as HTML/Markdown
   - **Rationale:** Consistent user experience

---

## 12. Dependencies

### 12.1 New Dependencies (Required)

- **sharp** - Image processing and validation
  - npm: `sharp`
  - Lambda Layer: Use `sharp-layer` for AWS Lambda (pre-compiled for Amazon Linux 2)
  - Purpose: Image validation, format detection, metadata extraction, resizing
  
- **pdf-lib** - PDF generation
  - npm: `pdf-lib`
  - Purpose: Create PDF documents, embed images, set page sizes
  - Note: Pure JavaScript, no native dependencies
  
- **lambda-multipart-parser** - Multipart/form-data parsing
  - npm: `lambda-multipart-parser`
  - Purpose: Parse multipart requests in Lambda
  - Alternative: `busboy` (more control, slightly more complex)

### 12.2 Lambda Layer for Sharp

Sharp requires native binaries compiled for Amazon Linux 2. Options:

1. **Pre-built Layer (Recommended):**
   - Use community Sharp layer: `arn:aws:lambda:{region}:764866452798:layer:sharp-layer:1`
   - Or build custom layer using Docker

2. **Docker-based Lambda:**
   - Use `public.ecr.aws/lambda/nodejs:20` base image
   - Sharp auto-compiles for correct platform

3. **Serverless Plugin:**
   - Use `serverless-plugin-layer-manager` to auto-build Sharp layer

### 12.3 Existing Dependencies (Unchanged)

- `puppeteer-core`: Still used for HTML/Markdown conversion
- `@sparticuz/chromium`: Still used for Chromium binary (HTML/Markdown only)
- Image-to-PDF does NOT use Puppeteer or Chromium

---

## 13. Success Metrics

- **Adoption:** % of requests using image-to-PDF
- **Performance:** Average conversion time for images
- **Error Rate:** % of failed image conversions
- **User Satisfaction:** Feedback on image quality and conversion speed

---

## Summary

This plan outlines adding PNG/JPG to PDF conversion support by:

1. **Extending existing `/quickjob` and `/longjob` endpoints** with `input_type: "image"`
2. **Using multipart/form-data** for efficient binary image uploads (no base64 overhead)
3. **Using Sharp + pdf-lib** for fast, memory-efficient conversion (no Puppeteer/Chromium)
4. **Applying same validation, rate limits, and page limits** as HTML/Markdown
5. **Maintaining backward compatibility** - existing HTML/Markdown endpoints unchanged

**Key Benefits of This Approach:**
- **~4x faster** than Puppeteer-based approach
- **~60% lower Lambda costs** due to faster execution and lower memory
- **33% more payload capacity** without base64 overhead
- **Standard file upload UX** familiar to developers
- **Professional image quality** using industry-standard Sharp library

The implementation introduces new dependencies (Sharp, pdf-lib, multipart parser) but delivers significant performance and cost improvements that justify the added complexity.

