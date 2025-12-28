# Image to PDF Conversion - Specification Plan

**Version:** 1.0.0 (Draft)  
**Date:** December 21, 2025  
**Status:** Planning Phase

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

**Option A: Base64 Encoded (Recommended)**
- Images provided as base64-encoded strings in JSON payload
- Pros: Simple, works with existing JSON API structure
- Cons: Increases payload size (~33% overhead), limited by API Gateway payload size

**Option B: Image URLs**
- Images provided as HTTPS URLs
- Pros: Smaller payload, can handle large images
- Cons: Requires Lambda to fetch images (network latency, potential failures)

**Option C: Binary Upload (Multipart)**
- Images uploaded as binary data in multipart/form-data
- Pros: Efficient for large images, standard HTTP approach
- Cons: Requires API Gateway configuration changes, more complex parsing

**Recommendation:** Support **Option A (Base64)** initially, with **Option B (URLs)** as a future enhancement.

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

**Approach:** Add new `input_type: "image"` to existing `/quickjob` and `/longjob` endpoints.

**Request Format:**
```json
{
  "input_type": "image",
  "images": [
    {
      "data": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
      "format": "png"
    },
    {
      "data": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ...",
      "format": "jpeg"
    }
  ],
  "options": {
    "format": "A4",
    "margin": {
      "top": "10mm",
      "right": "10mm",
      "bottom": "10mm",
      "left": "10mm"
    },
    "fit": "contain",  // "contain" (fit whole image) or "cover" (fill page)
    "orientation": "portrait",  // "portrait" or "landscape"
    "pages_per_image": 1  // Number of pages per image (for very large images)
  }
}
```

**Alternative: Simpler format with data URLs:**
```json
{
  "input_type": "image",
  "images": [
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
    "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ..."
  ],
  "options": {
    "format": "A4",
    "margin": {
      "top": "10mm",
      "right": "10mm",
      "bottom": "10mm",
      "left": "10mm"
    },
    "fit": "contain"
  }
}
```

**Recommendation:** Use simpler format with data URLs (auto-detect format from data URL).

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
- Cons: Slightly slower, requires Chromium launch

**Option B: pdf-lib Library**
- Direct PDF creation from image buffers
- Pros: Faster, lighter weight, no browser needed
- Cons: Additional dependency, different code path

**Option C: Sharp + pdf-lib**
- Use Sharp for image processing (resize, format conversion)
- Use pdf-lib for PDF creation
- Pros: Best image handling, professional quality
- Cons: Additional dependencies, more complex

**Recommendation:** **Option A (Puppeteer)** initially for consistency, evaluate **Option C** for performance if needed.

### 3.2 Image Processing Flow

1. **Parse Input:**
   - Extract base64 data from data URLs
   - Decode base64 to image buffer
   - Validate image format (PNG/JPEG)
   - Validate image size (max dimensions, file size)

2. **Image Validation:**
   - Check file size (max 5MB per image, total 10MB for multiple images)
   - Check dimensions (max 10000x10000 pixels)
   - Verify image is valid (not corrupted)

3. **PDF Generation:**
   - For each image:
     - Create HTML page with image
     - Set page size based on options
     - Render with Puppeteer
     - Add to PDF (one page per image, or multiple pages if image is very large)
   - Combine all pages into single PDF

4. **Page Counting:**
   - Count pages in generated PDF
   - Apply same page limit (100 pages) as HTML/Markdown
   - Reject if exceeds limit (same as current behavior)

### 3.3 Code Structure

**New function in `pdf.js`:**
```javascript
/**
 * Convert images to PDF
 * @param {Array<string>} images - Array of base64 data URLs
 * @param {object} options - PDF options
 * @returns {Promise<Buffer>} PDF buffer
 */
async function imagesToPdf(images, options = {}) {
  // Implementation
}
```

**Update `generatePDF` function:**
```javascript
async function generatePDF(inputType, content, options) {
  if (inputType === 'image') {
    return await imagesToPdf(content, options);
  }
  // Existing HTML/Markdown logic
}
```

---

## 4. Validation Rules

### 4.1 Input Validation

- `input_type` must be `"image"` (in addition to existing `"html"` and `"markdown"`)
- `images` must be an array (can be single element for one image)
- Each image must be a valid data URL: `data:image/{format};base64,{data}`
- Supported formats: `png`, `jpeg`, `jpg`
- Maximum images per request: 100 (to prevent abuse)
- Maximum total payload size: 10MB (API Gateway limit consideration)

### 4.2 Image Validation

- Maximum file size per image: 5MB (decoded)
- Maximum dimensions: 10000x10000 pixels
- Must be valid PNG or JPEG (not corrupted)
- Must decode successfully from base64

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
- `INVALID_IMAGE_DATA`: Image data is corrupted or invalid
- `IMAGE_TOO_LARGE`: Image exceeds size/dimension limits
- `TOO_MANY_IMAGES`: More than 100 images in request
- `IMAGE_DECODE_ERROR`: Failed to decode base64 image data

### 6.2 Existing Error Codes (Reused)

- `PAGE_LIMIT_EXCEEDED`: PDF exceeds 100 pages
- `INVALID_INPUT_TYPE`: `input_type` is not `"html"`, `"markdown"`, or `"image"`
- `MISSING_INPUT_TYPE`: `input_type` field is missing
- `PAYLOAD_TOO_LARGE`: Total request payload exceeds 10MB

---

## 7. Performance Considerations

### 7.1 Lambda Execution Time

- **Single image (small):** ~2-3 seconds
- **Single image (large, 5MB):** ~5-8 seconds
- **Multiple images (10 images):** ~10-15 seconds
- **Multiple images (100 images):** May exceed 30-second QuickJob limit → use LongJob

**Recommendation:** 
- QuickJob: Max 10 images or 5MB total
- LongJob: Unlimited (within page limit)

### 7.2 Memory Usage

- Base64 decoding increases memory usage (~33% overhead)
- Large images require significant memory
- Current Lambda memory (3008 MB) should be sufficient

### 7.3 Cost Impact

- Similar to HTML/Markdown conversion
- Slightly faster (no HTML rendering complexity)
- May use less CPU for simple images
- **Pricing:** Same as HTML/Markdown (no additional charge)

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
- Invalid base64 encoding
- Empty images array
- 100 images (maximum)
- Images exceeding page limit

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

1. **Phase 1: Core Implementation**
   - Add `input_type: "image"` validation
   - Implement `imagesToPdf` function
   - Add image validation logic
   - Update `generatePDF` to handle images
   - Add error handling

2. **Phase 2: Testing**
   - Unit tests
   - Integration tests
   - Load testing with multiple images
   - Error scenario testing

3. **Phase 3: Documentation**
   - Update SPEC.md
   - Update ENDPOINTS.md
   - Add examples
   - Update error documentation

4. **Phase 4: Deployment**
   - Deploy to dev environment
   - Test in dev
   - Deploy to prod
   - Monitor performance

### 10.2 Backward Compatibility

- Existing `input_type: "html"` and `input_type: "markdown"` continue to work
- No breaking changes to existing API
- New feature is additive only

---

## 11. Open Questions

1. **Image URLs:** Should we support image URLs in v1, or defer to v2?
   - **Decision:** Defer to v2 (simpler initial implementation)

2. **Multiple Images Layout:** Should we support grid layouts (multiple images per page) in v1?
   - **Decision:** Defer to v2 (one image per page is sufficient for MVP)

3. **Image Processing:** Should we support image manipulation (resize, crop) in v1?
   - **Decision:** Defer to v2 (focus on core conversion first)

4. **Pricing:** Should image-to-PDF have different pricing than HTML/Markdown?
   - **Decision:** Same pricing (simpler, consistent)

5. **Rate Limits:** Should image-to-PDF have different rate limits?
   - **Decision:** Same rate limits (consistent user experience)

---

## 12. Dependencies

### 12.1 New Dependencies

- **None required** (Puppeteer can handle images via HTML)
- **Optional:** `sharp` for advanced image processing (future)

### 12.2 Existing Dependencies

- `puppeteer-core`: Already used for HTML/Markdown
- `@sparticuz/chromium`: Already used for Chromium binary
- `pdf-lib`: Already used for PDF manipulation (if needed for advanced features)

---

## 13. Success Metrics

- **Adoption:** % of requests using image-to-PDF
- **Performance:** Average conversion time for images
- **Error Rate:** % of failed image conversions
- **User Satisfaction:** Feedback on image quality and conversion speed

---

## Summary

This plan outlines adding PNG/JPG to PDF conversion support by:
1. Extending existing `/quickjob` and `/longjob` endpoints with `input_type: "image"`
2. Supporting base64-encoded images in data URL format
3. Using Puppeteer (existing infrastructure) for conversion
4. Applying same validation, rate limits, and page limits as HTML/Markdown
5. Maintaining backward compatibility

The implementation is straightforward and leverages existing infrastructure, making it a low-risk, high-value addition to the PodPDF service.

