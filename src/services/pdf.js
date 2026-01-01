/**
 * PDF Generation Service
 * Handles PDF generation using Puppeteer and Chromium
 */

const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const { marked } = require('marked');
const logger = require('../utils/logger');

const MAX_PAGES = parseInt(process.env.MAX_PAGES || '100', 10);

/**
 * Convert Markdown to HTML
 * @param {string} markdown - Markdown content
 * @returns {string} HTML content
 */
function markdownToHtml(markdown) {
  try {
    return marked.parse(markdown, {
      gfm: true, // GitHub Flavored Markdown
      breaks: false,
    });
  } catch (error) {
    logger.error('Markdown conversion error', { error: error.message });
    throw new Error(`Failed to convert Markdown to HTML: ${error.message}`);
  }
}

/**
 * Count pages in a PDF buffer
 * @param {Buffer} pdfBuffer - PDF buffer
 * @returns {number} Number of pages
 */
function countPages(pdfBuffer) {
  try {
    // PDF page count: search for /Count in the document
    // This is a simple heuristic - look for /Count followed by a number
    const pdfString = pdfBuffer.toString('binary');
    const matches = pdfString.match(/\/Count\s+(\d+)/g);
    if (matches && matches.length > 0) {
      // Get the last match (document page count)
      const lastMatch = matches[matches.length - 1];
      const count = parseInt(lastMatch.match(/\d+/)[0], 10);
      return count;
    }
    // Fallback: count page objects
    const pageMatches = pdfString.match(/\/Type\s*\/Page[^s]/g);
    if (pageMatches) {
      return pageMatches.length;
    }
    // If we can't determine, return 0 (will be handled by truncation logic)
    return 0;
  } catch (error) {
    logger.error('Page counting error', { error: error.message });
    // Return 0 if we can't count - truncation will handle it
    return 0;
  }
}

/**
 * Truncate PDF to first N pages
 * @param {Buffer} pdfBuffer - Original PDF buffer
 * @param {number} maxPages - Maximum number of pages to keep
 * @returns {Promise<Buffer>} Truncated PDF buffer
 */
async function truncatePdf(pdfBuffer, maxPages) {
  try {
    const { PDFDocument } = require('pdf-lib');
    
    // Load the PDF document
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const totalPages = pdfDoc.getPageCount();
    
    // If already within limit, return original
    if (totalPages <= maxPages) {
      return pdfBuffer;
    }
    
    // Create a new PDF with only the first N complete pages
    // copyPages ensures we only copy complete pages, not partial content
    // IMPORTANT: We do NOT add any labels, text, or indicators to the PDF
    // The truncated PDF contains only the original content from the first N pages
    const newPdfDoc = await PDFDocument.create();
    
    // Copy only the first maxPages complete pages (0-indexed, so 0 to maxPages-1)
    // This copies pages as-is without any modifications or added text
    const pageIndices = Array.from({ length: maxPages }, (_, i) => i);
    const pages = await newPdfDoc.copyPages(pdfDoc, pageIndices);
    
    // Add complete pages to new document in order
    // No text, labels, or truncation indicators are added to the pages
    pages.forEach((page) => {
      newPdfDoc.addPage(page);
    });
    
    // Serialize the truncated PDF (contains only complete pages, no labels)
    const truncatedPdfBytes = await newPdfDoc.save();
    const truncatedBuffer = Buffer.from(truncatedPdfBytes);
    
    // Verify the truncated PDF has the correct number of pages
    const verificationDoc = await PDFDocument.load(truncatedBuffer);
    const verifiedPageCount = verificationDoc.getPageCount();
    
    if (verifiedPageCount !== maxPages) {
      logger.warn('Page count mismatch after truncation', {
        expected: maxPages,
        actual: verifiedPageCount,
      });
    }
    
    logger.info('PDF truncation completed successfully', {
      originalPages: totalPages,
      truncatedPages: verifiedPageCount,
      originalSize: pdfBuffer.length,
      truncatedSize: truncatedBuffer.length,
    });
    
    return truncatedBuffer;
  } catch (error) {
    logger.error('PDF truncation error', {
      error: error.message,
      stack: error.stack,
      maxPages,
    });
    // If truncation fails, return original (fail open)
    logger.warn('Returning original PDF due to truncation error');
    return pdfBuffer;
  }
}

/**
 * Generate PDF from HTML or Markdown
 * @param {string} content - HTML or Markdown content
 * @param {string} inputType - 'html' or 'markdown'
 * @param {object} options - Puppeteer PDF options
 * @param {number} maxPages - Maximum number of pages allowed (optional, defaults to MAX_PAGES)
 * @returns {Promise<{pdf: Buffer, pages: number, truncated: boolean}>}
 */
async function generatePDF(content, inputType, options = {}, maxPages = null) {
  let browser = null;
  let startTime = Date.now();

  try {
    // Convert Markdown to HTML if needed
    let htmlContent = content;
    if (inputType === 'markdown') {
      htmlContent = markdownToHtml(content);
      // Wrap in a basic HTML structure if not already wrapped
      if (!htmlContent.includes('<!DOCTYPE') && !htmlContent.includes('<html')) {
        htmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }
    pre { background-color: #f4f4f4; padding: 1em; border-radius: 4px; }
    code { background-color: #f4f4f4; padding: 0.2em 0.4em; border-radius: 3px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background-color: #f2f2f2; }
  </style>
</head>
<body>
${htmlContent}
</body>
</html>`;
      }
    } else {
      // Ensure HTML has DOCTYPE for best results
      if (!htmlContent.includes('<!DOCTYPE')) {
        if (!htmlContent.includes('<html')) {
          htmlContent = `<!DOCTYPE html>\n<html>\n<head><meta charset="UTF-8"></head>\n<body>\n${htmlContent}\n</body>\n</html>`;
        } else {
          htmlContent = `<!DOCTYPE html>\n${htmlContent}`;
        }
      }
    }

    // Configure Chromium for Lambda
    const executablePath = await chromium.executablePath();

    // Launch browser
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();

    // Set content
    await page.setContent(htmlContent, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    // Default PDF options
    const pdfOptions = {
      format: 'A4',
      printBackground: true,
      scale: 1.0,
      ...options,
    };

    // Generate PDF
    let pdfBuffer = await page.pdf(pdfOptions);

    // Count pages
    let pageCount = countPages(pdfBuffer);

    // Check if page count exceeds limit - reject instead of truncating
    // Use provided maxPages or fall back to global MAX_PAGES
    const effectiveMaxPages = (maxPages !== null ? maxPages : MAX_PAGES) + 1;
    const limitMaxPages = maxPages !== null ? maxPages : MAX_PAGES;
    if (pageCount > effectiveMaxPages) {
      logger.warn('PDF exceeds page limit', {
        pageCount,
        maxPages: limitMaxPages,
        effectiveMaxPages,
      });
      throw new Error(`PAGE_LIMIT_EXCEEDED:${pageCount}:${limitMaxPages}`);
    }

    const duration = Date.now() - startTime;
    logger.info('PDF generated successfully', {
      inputType,
      pages: pageCount,
      duration_ms: duration,
      pdf_size_bytes: pdfBuffer.length,
    });

    return {
      pdf: pdfBuffer,
      pages: pageCount,
      truncated: false,
    };
  } catch (error) {
    logger.error('PDF generation error', {
      error: error.message,
      stack: error.stack,
      inputType,
    });
    throw new Error(`PDF generation failed: ${error.message}`);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = {
  generatePDF,
  markdownToHtml,
  countPages,
};

