# PodPDF Deployment Guide

**Framework:** Serverless Framework 3.x+  
**Last Updated:** December 21, 2025

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Initial Setup](#initial-setup)
3. [Development Stack](#development-stack)
4. [Production Stack](#production-stack)
5. [Environment Configuration](#environment-configuration)
6. [Deployment Commands](#deployment-commands)
7. [Stack Management](#stack-management)
8. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Required Tools

1. **Node.js 20.x**
   ```bash
   node --version  # Should be v20.x or higher
   ```

2. **Serverless Framework 3.x+**
   ```bash
   npm install -g serverless@latest
   serverless --version  # Should be 3.x or higher
   ```

3. **AWS CLI**
   ```bash
   aws --version
   ```

4. **AWS Account Access**
   - AWS account with appropriate permissions
   - IAM user or role with deployment capabilities
   - AWS credentials configured (`aws configure`)

### Required AWS Permissions

The deployment requires permissions for:
- Lambda (create, update, delete functions)
- API Gateway (create, update, delete APIs)
- DynamoDB (create, update, delete tables)
- Cognito (create, update user pools and app clients)
- IAM (create roles and policies)
- CloudWatch (create log groups)
- WAF (AWS free tier features only - basic rate-based rules, applies to all users)

---

## Initial Setup

### 1. Clone and Install Dependencies

```bash
# Navigate to project directory
cd podpdf-be

# Install project dependencies
npm install
```

### 2. Configure AWS Credentials

```bash
# Configure AWS CLI (if not already done)
aws configure

# Or use environment variables
export AWS_ACCESS_KEY_ID=your_access_key
export AWS_SECRET_ACCESS_KEY=your_secret_key
export AWS_DEFAULT_REGION=us-east-1
```

### 3. Verify Serverless Framework Installation

```bash
serverless --version
# Should output: Framework Core: 3.x.x
```

---

## Development Stack

### Overview

The development stack is designed for:
- Local testing and iteration
- Lower cost thresholds
- Lower throttling limits
- Detailed logging

### Configuration

Development stack uses the following naming convention:
- Stack name: `podpdf-dev`
- API Gateway: `podpdf-dev-api`
- Lambda function: `podpdf-dev-generate`
- DynamoDB tables: `podpdf-dev-users`, `podpdf-dev-user-rate-limits`, `podpdf-dev-job-details`, `podpdf-dev-analytics`
- Cognito User Pool: `podpdf-dev-user-pool`
- WAF: Basic rate-based rule (AWS free tier features only, applies to all users)

### Environment Variables

Development-specific environment variables (set in `serverless.yml` or `.env.dev`):

```yaml
environment:
  STAGE: dev
  LOG_LEVEL: debug
  FREE_TIER_QUOTA: 100
  RATE_LIMIT_PER_MINUTE: 20  # Applied to free tier only; paid tier unlimited
  MAX_PAGES: 100
  MAX_INPUT_SIZE_MB: 5
```

### Deployment Steps

1. **Set Development Stage**
   ```bash
   export STAGE=dev
   ```

2. **Deploy Development Stack**
   ```bash
   serverless deploy --stage dev
   ```

3. **Verify Deployment**
   ```bash
   serverless info --stage dev
   ```

4. **Get API Endpoint**
   ```bash
   serverless info --stage dev | grep "endpoints:"
   ```

### Development Stack Features

- **Lower Throttling:** 100 requests/second (vs 1000 in prod)
- **Extended Logging:** Debug-level CloudWatch logs
- **WAF:** Basic rate-based rule (AWS free tier features only, applies to all users, optional in dev)
- **Per-User Rate Limiting:** 20 requests/minute (free tier only; paid tier unlimited)
- **Cost Alerts:** Lower thresholds ($5, $10)
- **Test User Pool:** Separate Cognito pool for development

---

## Production Stack

### Overview

The production stack is designed for:
- High availability and performance
- Strict security and rate limiting
- Cost optimization
- Production-grade monitoring

### Configuration

Production stack uses the following naming convention:
- Stack name: `podpdf-prod`
- API Gateway: `podpdf-prod-api`
- Lambda function: `podpdf-prod-generate`
- DynamoDB tables: `podpdf-prod-users`, `podpdf-prod-user-rate-limits`, `podpdf-prod-job-details`, `podpdf-prod-analytics`
- Cognito User Pool: `podpdf-prod-user-pool`
- WAF: Basic rate-based rule (AWS free tier features only, applies to all users)

### Environment Variables

Production-specific environment variables:

```yaml
environment:
  STAGE: prod
  LOG_LEVEL: info
  FREE_TIER_QUOTA: 100
  RATE_LIMIT_PER_MINUTE: 20  # Applied to free tier only; paid tier unlimited
  MAX_PAGES: 100
  MAX_INPUT_SIZE_MB: 5
```

### Pre-Deployment Checklist

Before deploying to production:

- [ ] All tests passing
- [ ] Development stack tested and verified
- [ ] Environment variables reviewed
- [ ] AWS Budget alerts configured
- [ ] WAF configured (AWS free tier features only - basic rate-based rules, applies to all users)
- [ ] Cognito user pool configured
- [ ] DynamoDB backup strategy in place
- [ ] CloudWatch alarms configured
- [ ] API Gateway throttling limits set
- [ ] CORS configuration reviewed and origins whitelisted

### Deployment Steps

1. **Set Production Stage**
   ```bash
   export STAGE=prod
   ```

2. **Review Configuration**
   ```bash
   # Dry run to see what will be deployed
   serverless deploy --stage prod --verbose
   ```

3. **Deploy Production Stack**
   ```bash
   serverless deploy --stage prod
   ```

4. **Verify Deployment**
   ```bash
   serverless info --stage prod
   ```

5. **Test Endpoint**
   ```bash
   # Get the API endpoint
   API_URL=$(serverless info --stage prod | grep "endpoints:" | awk '{print $2}')
   echo "API URL: $API_URL"
   ```

### Production Stack Features

- **High Throttling:** 1000 requests/second with 2000 burst
- **WAF Enabled:** Basic rate-based rule (AWS free tier features only, no additional cost, applies to all users)
- **Per-User Rate Limiting:** 20 requests/minute (free tier only; paid tier unlimited, only limited by WAF and API Gateway)
- **Optimized Logging:** Info-level logs (reduced verbosity)
- **Cost Alerts:** Production thresholds ($10, $50, $100)
- **Enhanced Monitoring:** Custom CloudWatch metrics and alarms
- **Backup Strategy:** DynamoDB point-in-time recovery enabled

---

## Environment Configuration

### Serverless.yml Structure

The `serverless.yml` file should support multiple stages:

```yaml
service: podpdf

frameworkVersion: '3'

provider:
  name: aws
  runtime: nodejs20.x
  stage: ${opt:stage, 'dev'}
  region: ${opt:region, 'us-east-1'}
  memorySize: 10240
  timeout: 720
  environment:
    STAGE: ${self:provider.stage}
    # ... other environment variables
  httpApi:
    throttling:
      burstLimit: ${self:custom.throttling.${self:provider.stage}.burst}
      rateLimit: ${self:custom.throttling.${self:provider.stage}.rate}

custom:
  stages:
    dev:
      throttling:
        rate: 100
        burst: 200
      logLevel: debug
    prod:
      throttling:
        rate: 1000
        burst: 2000
      logLevel: info

functions:
  generate:
    handler: src/handler.generate
    # ... function configuration

resources: ${file(resources.yml)}  # All AWS resources (DynamoDB tables, Cognito, WAF, etc.)
```

### Environment-Specific Files

Create separate configuration files if needed:

- `.env.dev` - Development environment variables
- `.env.prod` - Production environment variables

Load them using `serverless-dotenv-plugin`:

```yaml
plugins:
  - serverless-dotenv-plugin

custom:
  dotenv:
    path: .env.${self:provider.stage}
```

### CORS Configuration

CORS (Cross-Origin Resource Sharing) must be configured in `serverless.yml` for the HTTP API:

```yaml
provider:
  httpApi:
    cors:
      allowedOrigins:
        - https://yourdomain.com
        - https://www.yourdomain.com
        - https://app.yourdomain.com
      allowedHeaders:
        - Content-Type
        - Authorization
      allowedMethods:
        - POST
        - OPTIONS
      allowCredentials: true
      maxAge: 86400  # 24 hours
```

**Development Configuration:**
```yaml
custom:
  stages:
    dev:
      cors:
        allowedOrigins:
          - http://localhost:3000
          - http://localhost:3001
          - http://127.0.0.1:3000
          - https://dev.yourdomain.com
```

**Production Configuration:**
```yaml
custom:
  stages:
    prod:
      cors:
        allowedOrigins:
          - https://yourdomain.com
          - https://www.yourdomain.com
          - https://app.yourdomain.com
```

**CORS Configuration Details:**
- **Allowed Origins:** Whitelist of domains that can make requests to the API
  - Development: Include localhost URLs for local testing
  - Production: Only production domains
- **Allowed Headers:** 
  - `Content-Type`: Required for JSON request bodies
  - `Authorization`: Required for JWT Bearer token authentication
- **Allowed Methods:**
  - `POST`: Required for `/generate` endpoint
  - `OPTIONS`: Required for CORS preflight requests
- **Allow Credentials:** Set to `true` to allow cookies/credentials in requests
- **Max Age:** Cache duration for preflight requests (in seconds)

**Note:** Update the `allowedOrigins` list based on your actual frontend domains. Never use `*` (wildcard) in production for security reasons.

---

## Deployment Commands

### Basic Deployment

```bash
# Deploy to development
serverless deploy --stage dev

# Deploy to production
serverless deploy --stage prod
```

### Deployment with Options

```bash
# Deploy with verbose output
serverless deploy --stage dev --verbose

# Deploy specific function only
serverless deploy function --function generate --stage dev

# Deploy without CloudFormation changes (faster, function code only)
serverless deploy function --function generate --stage dev --update-config false
```

### View Stack Information

```bash
# Get stack info
serverless info --stage dev

# List all functions
serverless deploy list functions --stage dev

# View logs
serverless logs --function generate --stage dev --tail
```

### Remove Stack

```bash
# Remove entire stack (use with caution!)
serverless remove --stage dev

# Remove production stack (requires confirmation)
serverless remove --stage prod
```

---

## Stack Management

### Updating a Stack

1. **Make Changes**
   - Update `serverless.yml` or function code
   - Test locally if possible

2. **Deploy Updates**
   ```bash
   serverless deploy --stage dev
   ```

3. **Verify Changes**
   ```bash
   serverless info --stage dev
   ```

### Managing Environment Variables

```bash
# Set environment variable via AWS CLI (if not in serverless.yml)
aws lambda update-function-configuration \
  --function-name podpdf-dev-generate \
  --environment "Variables={NEW_VAR=value}"
```

### Viewing Stack Resources

```bash
# List all resources in stack
aws cloudformation describe-stack-resources \
  --stack-name podpdf-dev \
  --region us-east-1
```

### Monitoring Deployments

```bash
# Watch CloudFormation events
aws cloudformation describe-stack-events \
  --stack-name podpdf-dev \
  --region us-east-1 \
  --max-items 10
```

---

## Troubleshooting

### Common Issues

#### 1. Deployment Fails: Insufficient Permissions

**Error:** `AccessDenied` or `UnauthorizedOperation`

**Solution:**
- Verify AWS credentials: `aws sts get-caller-identity`
- Check IAM permissions for the user/role
- Ensure required AWS service permissions are granted

#### 2. Lambda Timeout During Deployment

**Error:** `The Lambda function timed out`

**Solution:**
- Check Lambda timeout setting (should be 720 seconds)
- Verify Chromium layer is properly attached
- Review CloudWatch logs for specific errors

#### 3. API Gateway Not Created

**Error:** API endpoint not found

**Solution:**
- Verify `httpApi` configuration in `serverless.yml`
- Check API Gateway service permissions
- Ensure `serverless-offline` is not interfering

#### 4. DynamoDB Table Creation Fails

**Error:** `ResourceAlreadyExistsException`

**Solution:**
- Table may already exist from previous deployment
- Either remove the table manually or update the configuration
- Check table name conflicts between stages

#### 5. Cognito User Pool Issues

**Error:** Cognito configuration errors

**Solution:**
- Verify Cognito service permissions
- Check user pool naming conflicts
- Ensure email-based sign-up is configured correctly

### Debugging Commands

```bash
# View detailed deployment logs
serverless deploy --stage dev --verbose

# Check Lambda function logs
serverless logs --function generate --stage dev --tail

# Test Lambda function locally
serverless invoke local --function generate --stage dev --path test-event.json

# Validate serverless.yml syntax
serverless print --stage dev
```

### Getting Help

1. **Check CloudWatch Logs**
   ```bash
   serverless logs --function generate --stage dev --tail
   ```

2. **View Stack Events**
   ```bash
   aws cloudformation describe-stack-events \
     --stack-name podpdf-dev \
     --region us-east-1
   ```

3. **Test API Endpoint**
   ```bash
   curl -X POST https://your-api-id.execute-api.us-east-1.amazonaws.com/generate \
     -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"html": "<html><body>Test</body></html>"}'
   ```

---

## Best Practices

### Development Workflow

1. **Always test in dev first**
   ```bash
   serverless deploy --stage dev
   # Test thoroughly
   ```

2. **Use version control**
   - Commit `serverless.yml` changes
   - Tag releases before production deployment

3. **Monitor costs**
   - Set up AWS Budget alerts
   - Review CloudWatch metrics regularly

### Production Deployment

1. **Deploy during low-traffic periods**
   - Minimize impact on users
   - Easier rollback if needed

2. **Use blue-green deployment pattern**
   - Deploy to new alias/version
   - Test before switching traffic

3. **Have rollback plan ready**
   ```bash
   # Rollback to previous version
   serverless rollback --stage prod --timestamp <timestamp>
   ```

### Security

1. **Never commit secrets**
   - Use AWS Secrets Manager or Parameter Store
   - Use environment variables for sensitive data

2. **Rotate credentials regularly**
   - Update AWS access keys periodically
   - Rotate Cognito app client secrets

3. **Enable CloudTrail**
   - Monitor all API calls
   - Track deployment activities

---

## Quick Reference

### Development Stack

```bash
# Deploy
serverless deploy --stage dev

# View info
serverless info --stage dev

# View logs
serverless logs --function generate --stage dev --tail

# Remove
serverless remove --stage dev
```

### Production Stack

```bash
# Deploy
serverless deploy --stage prod

# View info
serverless info --stage prod

# View logs
serverless logs --function generate --stage prod --tail

# Remove (use with extreme caution!)
serverless remove --stage prod
```

---

**Document Version:** 1.0.0  
**Last Updated:** December 21, 2025

