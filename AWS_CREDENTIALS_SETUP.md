# AWS Credentials Setup Guide

## Overview

AWS credentials (Access Key ID and Secret Access Key) are used to authenticate with AWS services. How many sets you need depends on your AWS account setup.

---

## Option 1: Same AWS Account (Recommended for MVP)

**Use case:** Dev and prod stacks in the same AWS account

**Credentials needed:** **ONE set** (one Access Key ID, one Secret Access Key)

### Setup Steps:

1. **Create IAM User in AWS Console:**
   - Go to AWS Console → IAM → Users → Create User
   - Give it a name (e.g., `podpdf-deployer`)
   - Attach policies with deployment permissions (or create custom policy)

2. **Create Access Keys:**
   - In the IAM user, go to "Security credentials" tab
   - Click "Create access key"
   - Choose "Command Line Interface (CLI)"
   - **Save the Access Key ID and Secret Access Key** (you can only see the secret once!)

3. **Configure AWS CLI on Mac:**
   ```bash
   aws configure
   ```
   - Enter your Access Key ID
   - Enter your Secret Access Key
   - Default region: `eu-central-1`
   - Default output format: `json`

   This creates a **default profile** in `~/.aws/credentials`

4. **Verify:**
   ```bash
   aws sts get-caller-identity
   ```

5. **Deploy:**
   ```bash
   # Deploy to dev (uses default credentials)
   serverless deploy --stage dev
   
   # Deploy to prod (uses same default credentials)
   serverless deploy --stage prod
   ```

**Note:** Serverless Framework automatically uses the default AWS credentials from `~/.aws/credentials`

---

## Option 2: Separate AWS Accounts (Recommended for Production)

**Use case:** Dev stack in one AWS account, prod stack in separate AWS account (better isolation)

**Credentials needed:** **TWO sets** (one for dev account, one for prod account)

### Setup Steps:

1. **Create IAM Users in each AWS account:**
   - Dev account: Create user `podpdf-dev-deployer`
   - Prod account: Create user `podpdf-prod-deployer`
   - Create access keys for each

2. **Create AWS CLI Profiles on Mac:**
   ```bash
   # Configure dev profile
   aws configure --profile podpdf-dev
   # Enter dev account Access Key ID
   # Enter dev account Secret Access Key
   # Region: eu-central-1
   # Output: json
   
   # Configure prod profile
   aws configure --profile podpdf-prod
   # Enter prod account Access Key ID
   # Enter prod account Secret Access Key
   # Region: eu-central-1
   # Output: json
   ```

   This creates profiles in `~/.aws/credentials`:
   ```ini
   [podpdf-dev]
   aws_access_key_id = YOUR_DEV_ACCESS_KEY
   aws_secret_access_key = YOUR_DEV_SECRET_KEY
   region = eu-central-1
   
   [podpdf-prod]
   aws_access_key_id = YOUR_PROD_ACCESS_KEY
   aws_secret_access_key = YOUR_PROD_SECRET_KEY
   region = eu-central-1
   ```

3. **Deploy using profiles:**
   ```bash
   # Deploy to dev (uses podpdf-dev profile)
   serverless deploy --stage dev --aws-profile podpdf-dev
   
   # Deploy to prod (uses podpdf-prod profile)
   serverless deploy --stage prod --aws-profile podpdf-prod
   ```

   Or set environment variable:
   ```bash
   export AWS_PROFILE=podpdf-dev
   serverless deploy --stage dev
   ```

---

## Where Are Credentials Stored on Mac?

AWS CLI stores credentials in:
- **Location:** `~/.aws/credentials` (hidden file in your home directory)
- **Format:**
  ```ini
  [default]
  aws_access_key_id = YOUR_ACCESS_KEY
  aws_secret_access_key = YOUR_SECRET_KEY
  region = eu-central-1
  
  [podpdf-dev]
  aws_access_key_id = DEV_ACCESS_KEY
  aws_secret_access_key = DEV_SECRET_KEY
  region = eu-central-1
  ```

---

## Recommended Setup for This Project

**For MVP/Development:** Use **Option 1** (same AWS account)
- Simpler setup
- One set of credentials
- Dev and prod stacks are isolated by naming (different resource names)
- Can separate later if needed

**For Production:** Consider **Option 2** (separate accounts)
- Better security isolation
- Separate billing
- Easier to manage permissions

---

## Quick Setup Commands

### Same Account (Default Profile):
```bash
aws configure
# Enter credentials when prompted

# Verify
aws sts get-caller-identity

# Deploy
serverless deploy --stage dev
```

### Separate Accounts (Named Profiles):
```bash
# Setup dev profile
aws configure --profile podpdf-dev

# Setup prod profile  
aws configure --profile podpdf-prod

# Deploy dev
serverless deploy --stage dev --aws-profile podpdf-dev

# Deploy prod
serverless deploy --stage prod --aws-profile podpdf-prod
```

---

## Security Best Practices

1. **Never commit credentials to git** - They're in `~/.aws/credentials` which should never be committed
2. **Use IAM roles with least privilege** - Only grant permissions needed for deployment
3. **Rotate access keys regularly** - Change them every 90 days
4. **Use separate accounts for prod** - Better isolation and security
5. **Enable MFA** - Add multi-factor authentication to IAM users

---

## Troubleshooting

### "Unable to locate credentials"
- Run `aws configure` to set up credentials
- Check `~/.aws/credentials` exists
- Verify credentials are correct

### "Access Denied"
- Check IAM user has required permissions
- Verify you're using the correct profile
- Check region is correct

### "Profile not found"
- Verify profile name matches exactly
- Check `~/.aws/credentials` has the profile
- Use `aws configure list-profiles` to see all profiles

---

## Required IAM Permissions

Your IAM user/role needs permissions for:
- Lambda (create, update, delete functions)
- API Gateway (create, update, delete APIs)
- DynamoDB (create, update, delete tables)
- Cognito (create, update user pools)
- IAM (create roles and policies)
- CloudFormation (create, update, delete stacks)
- CloudWatch (create log groups)

You can use the managed policy `AdministratorAccess` for development, or create a custom policy with only these permissions.

