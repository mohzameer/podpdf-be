/**
 * S3 Service
 * Handles PDF uploads and signed URL generation
 */

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const logger = require('../utils/logger');

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'eu-central-1' });
const bucketName = process.env.PDFS_BUCKET;

/**
 * Upload PDF to S3
 * @param {string} jobId - Job ID (used as S3 key)
 * @param {Buffer} pdfBuffer - PDF buffer
 * @returns {Promise<string>} S3 key
 */
async function uploadPDF(jobId, pdfBuffer) {
  try {
    const key = `${jobId}.pdf`;
    
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: pdfBuffer,
      ContentType: 'application/pdf',
      ServerSideEncryption: 'AES256',
    });

    await s3Client.send(command);

    logger.info('PDF uploaded to S3', {
      bucket: bucketName,
      key,
      size_bytes: pdfBuffer.length,
    });

    return key;
  } catch (error) {
    logger.error('S3 upload error', {
      error: error.message,
      stack: error.stack,
      jobId,
    });
    throw new Error(`Failed to upload PDF to S3: ${error.message}`);
  }
}

/**
 * Generate signed URL for S3 object
 * @param {string} s3Key - S3 object key
 * @param {number} expiresIn - Expiration time in seconds (default: 3600 = 1 hour)
 * @returns {Promise<string>} Signed URL
 */
async function generateSignedUrl(s3Key, expiresIn = 3600) {
  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
    });

    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn });

    logger.debug('Generated signed URL', {
      key: s3Key,
      expiresIn,
    });

    return signedUrl;
  } catch (error) {
    logger.error('Signed URL generation error', {
      error: error.message,
      s3Key,
    });
    throw new Error(`Failed to generate signed URL: ${error.message}`);
  }
}

/**
 * Calculate expiration timestamp
 * @param {number} expiresIn - Expiration time in seconds
 * @returns {string} ISO 8601 timestamp
 */
function getExpirationTimestamp(expiresIn = 3600) {
  const expirationDate = new Date();
  expirationDate.setSeconds(expirationDate.getSeconds() + expiresIn);
  return expirationDate.toISOString();
}

module.exports = {
  uploadPDF,
  generateSignedUrl,
  getExpirationTimestamp,
};

