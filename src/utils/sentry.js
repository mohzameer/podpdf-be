/**
 * Sentry wrapper utility
 * Only initializes Sentry in production when SENTRY_DSN is available
 * Returns no-op wrapper in dev to ensure zero overhead
 */

let wrap = (handler) => handler;

const isProd = process.env.STAGE === 'prod' && !!process.env.SENTRY_DSN;

if (isProd) {
  const Sentry = require('@sentry/serverless');
  
  Sentry.AWSLambda.init({
    dsn: process.env.SENTRY_DSN,
    environment: 'prod',
    tracesSampleRate: 0, // Disable performance monitoring
    integrations: [],
    beforeBreadcrumb: () => null, // Disable breadcrumbs
  });
  
  wrap = Sentry.AWSLambda.wrapHandler;
}

/**
 * Wraps a Lambda handler with Sentry (only in prod)
 * In dev, returns the handler unchanged
 * 
 * @param {Function} handler - Lambda handler function
 * @returns {Function} Wrapped handler (or original in dev)
 */
function wrapHandler(handler) {
  return wrap(handler);
}

module.exports = { wrapHandler };
