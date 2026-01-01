/**
 * Image to PDF Service
 * Converts PNG/JPEG images to PDF using Sharp + pdf-lib
 */

const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const logger = require('../utils/logger');

const MAX_IMAGES = parseInt(process.env.MAX_IMAGES || '100', 10);
const MAX_IMAGE_SIZE_MB = parseInt(process.env.MAX_IMAGE_SIZE_MB || '5', 10);
const MAX_IMAGE_SIZE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 10000;

// Page dimensions in points (72 points = 1 inch)
const PAGE_SIZES = {
  A4: { width: 595.28, height: 841.89 },
  Letter: { width: 612, height: 792 },
  Legal: { width: 612, height: 1008 },
  A3: { width: 841.89, height: 1190.55 },
  A5: { width: 419.53, height: 595.28 },
  Tabloid: { width: 792, height: 1224 },
};

/**
 * Parse margin value from string (e.g., "10mm", "1in", "72pt") to points
 * @param {string|number} value - Margin value
 * @returns {number} Margin in points
 */
function parseMargin(value) {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value !== 'string') {
    return 0;
  }
  
  const num = parseFloat(value);
  if (isNaN(num)) {
    return 0;
  }
  
  if (value.includes('mm')) {
    return num * 2.835; // 1mm = 2.835 points
  } else if (value.includes('in')) {
    return num * 72; // 1 inch = 72 points
  } else if (value.includes('cm')) {
    return num * 28.35; // 1cm = 28.35 points
  } else if (value.includes('pt')) {
    return num;
  }
  
  // Default: assume points
  return num;
}

/**
 * Calculate image placement on page based on fit option
 * @param {number} imgWidth - Image width in pixels
 * @param {number} imgHeight - Image height in pixels
 * @param {number} pageWidth - Page width in points
 * @param {number} pageHeight - Page height in points
 * @param {object} margins - Page margins in points
 * @param {string} fit - Fit option: 'contain', 'cover', 'fill', 'none'
 * @returns {object} Image placement { x, y, width, height }
 */
function calculateImagePlacement(imgWidth, imgHeight, pageWidth, pageHeight, margins, fit) {
  const availableWidth = pageWidth - margins.left - margins.right;
  const availableHeight = pageHeight - margins.top - margins.bottom;
  
  let width, height, x, y;
  
  switch (fit) {
    case 'cover':
      // Fill entire available area, may crop
      const coverScale = Math.max(availableWidth / imgWidth, availableHeight / imgHeight);
      width = imgWidth * coverScale;
      height = imgHeight * coverScale;
      x = margins.left + (availableWidth - width) / 2;
      y = margins.bottom + (availableHeight - height) / 2;
      break;
      
    case 'fill':
      // Stretch to fill, may distort
      width = availableWidth;
      height = availableHeight;
      x = margins.left;
      y = margins.bottom;
      break;
      
    case 'none':
      // Use natural size
      width = imgWidth * 0.75; // Convert pixels to points (assuming 96 DPI)
      height = imgHeight * 0.75;
      x = margins.left + (availableWidth - width) / 2;
      y = margins.bottom + (availableHeight - height) / 2;
      break;
      
    case 'contain':
    default:
      // Fit entire image, maintain aspect ratio
      const containScale = Math.min(availableWidth / imgWidth, availableHeight / imgHeight);
      width = imgWidth * containScale;
      height = imgHeight * containScale;
      x = margins.left + (availableWidth - width) / 2;
      y = margins.bottom + (availableHeight - height) / 2;
      break;
  }
  
  return { x, y, width, height };
}

/**
 * Validate a single image buffer using Sharp
 * @param {Buffer} buffer - Image buffer
 * @param {number} index - Image index (for error reporting)
 * @returns {Promise<{valid: boolean, format?: string, width?: number, height?: number, size?: number, error?: string}>}
 */
async function validateImage(buffer, index = 0) {
  try {
    // Check file size
    if (buffer.length > MAX_IMAGE_SIZE_BYTES) {
      return {
        valid: false,
        error: 'IMAGE_TOO_LARGE',
        details: {
          index,
          size: buffer.length,
          maxSize: MAX_IMAGE_SIZE_BYTES,
          message: `Image ${index + 1} exceeds maximum size of ${MAX_IMAGE_SIZE_MB}MB`,
        },
      };
    }
    
    // Use Sharp to read metadata
    const metadata = await sharp(buffer).metadata();
    
    // Check format
    if (!['png', 'jpeg', 'jpg'].includes(metadata.format)) {
      return {
        valid: false,
        error: 'INVALID_IMAGE_FORMAT',
        details: {
          index,
          format: metadata.format,
          message: `Image ${index + 1} has unsupported format: ${metadata.format}. Only PNG and JPEG are supported.`,
        },
      };
    }
    
    // Check dimensions
    if (metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION) {
      return {
        valid: false,
        error: 'IMAGE_TOO_LARGE',
        details: {
          index,
          width: metadata.width,
          height: metadata.height,
          maxDimension: MAX_IMAGE_DIMENSION,
          message: `Image ${index + 1} exceeds maximum dimensions of ${MAX_IMAGE_DIMENSION}x${MAX_IMAGE_DIMENSION} pixels`,
        },
      };
    }
    
    return {
      valid: true,
      format: metadata.format,
      width: metadata.width,
      height: metadata.height,
      size: buffer.length,
    };
  } catch (error) {
    return {
      valid: false,
      error: 'INVALID_IMAGE_DATA',
      details: {
        index,
        message: `Image ${index + 1} is corrupted or invalid: ${error.message}`,
      },
    };
  }
}

/**
 * Convert images to PDF using Sharp + pdf-lib
 * @param {Array<{buffer: Buffer, contentType?: string, filename?: string}>} images - Array of image data
 * @param {object} options - PDF options
 * @returns {Promise<{buffer: Buffer, pageCount: number, truncated: boolean}>}
 */
async function imagesToPdf(images, options = {}) {
  const startTime = Date.now();
  
  const {
    format = 'A4',
    margin = { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
    fit = 'contain',
    landscape = false,
  } = options;
  
  // Enforce image limit (truncate, don't reject)
  const truncated = images.length > MAX_IMAGES;
  const imagesToProcess = images.slice(0, MAX_IMAGES);
  
  if (truncated) {
    logger.info('Image list truncated', {
      originalCount: images.length,
      processedCount: imagesToProcess.length,
      maxImages: MAX_IMAGES,
    });
  }
  
  // Get page dimensions
  let { width: pageWidth, height: pageHeight } = PAGE_SIZES[format] || PAGE_SIZES.A4;
  if (landscape) {
    [pageWidth, pageHeight] = [pageHeight, pageWidth];
  }
  
  // Parse margins
  const marginPts = {
    top: parseMargin(margin.top || margin),
    right: parseMargin(margin.right || margin),
    bottom: parseMargin(margin.bottom || margin),
    left: parseMargin(margin.left || margin),
  };
  
  // Create PDF document
  const pdfDoc = await PDFDocument.create();
  
  // Process each image
  for (let i = 0; i < imagesToProcess.length; i++) {
    const imageData = imagesToProcess[i];
    const buffer = imageData.buffer;
    
    try {
      // Validate image
      const validation = await validateImage(buffer, i);
      if (!validation.valid) {
        logger.warn('Skipping invalid image', {
          index: i,
          error: validation.error,
          details: validation.details,
        });
        continue; // Skip invalid images
      }
      
      // Embed image in PDF
      let embeddedImage;
      if (validation.format === 'png') {
        embeddedImage = await pdfDoc.embedPng(buffer);
      } else {
        embeddedImage = await pdfDoc.embedJpg(buffer);
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
      
    } catch (error) {
      logger.error('Error processing image', {
        index: i,
        error: error.message,
      });
      // Skip this image and continue
    }
  }
  
  // Ensure at least one page was created
  if (pdfDoc.getPageCount() === 0) {
    throw new Error('No valid images to convert to PDF');
  }
  
  // Save PDF
  const pdfBytes = await pdfDoc.save();
  const pdfBuffer = Buffer.from(pdfBytes);
  
  const duration = Date.now() - startTime;
  logger.info('Image to PDF conversion completed', {
    inputImages: images.length,
    processedImages: imagesToProcess.length,
    pages: pdfDoc.getPageCount(),
    truncated,
    duration_ms: duration,
    pdf_size_bytes: pdfBuffer.length,
  });
  
  return {
    buffer: pdfBuffer,
    pageCount: pdfDoc.getPageCount(),
    truncated,
  };
}

/**
 * Validate all images in array
 * @param {Array<{buffer: Buffer}>} images - Array of image data
 * @returns {Promise<{valid: boolean, errors: Array, validCount: number}>}
 */
async function validateImages(images) {
  const errors = [];
  let validCount = 0;
  
  // Check if images array is empty
  if (!images || images.length === 0) {
    return {
      valid: false,
      errors: [{ error: 'MISSING_IMAGES', message: 'No images provided in request' }],
      validCount: 0,
    };
  }
  
  // Calculate total size
  let totalSize = 0;
  for (const img of images) {
    totalSize += img.buffer?.length || 0;
  }
  
  // Check total size (10MB limit)
  const MAX_TOTAL_SIZE = 10 * 1024 * 1024;
  if (totalSize > MAX_TOTAL_SIZE) {
    return {
      valid: false,
      errors: [{
        error: 'PAYLOAD_TOO_LARGE',
        message: `Total image size (${(totalSize / 1024 / 1024).toFixed(2)}MB) exceeds maximum of 10MB`,
      }],
      validCount: 0,
    };
  }
  
  // Validate each image
  for (let i = 0; i < images.length; i++) {
    const validation = await validateImage(images[i].buffer, i);
    if (validation.valid) {
      validCount++;
    } else {
      errors.push(validation);
    }
  }
  
  // If no valid images, return error
  if (validCount === 0) {
    return {
      valid: false,
      errors: errors.length > 0 ? errors : [{ error: 'INVALID_IMAGE_DATA', message: 'No valid images found' }],
      validCount: 0,
    };
  }
  
  // Return success (some images may be invalid but we have at least one valid)
  return {
    valid: true,
    errors,
    validCount,
  };
}

module.exports = {
  imagesToPdf,
  validateImage,
  validateImages,
  parseMargin,
  calculateImagePlacement,
  PAGE_SIZES,
  MAX_IMAGES,
  MAX_IMAGE_SIZE_BYTES,
  MAX_IMAGE_SIZE_MB,
};

