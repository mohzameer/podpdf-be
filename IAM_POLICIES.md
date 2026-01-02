# IAM Policies for PodPDF Deployment

This document explains what IAM policies you need to attach to your IAM user for deploying PodPDF.

---

## Quick Start (Development)

**For development/testing:** Use the managed policy `AdministratorAccess` (simplest, but gives full access)

1. Go to AWS Console → IAM → Users
2. Select your user (or create a new one)
3. Click "Add permissions" → "Attach policies directly"
4. Search for and select `AdministratorAccess`
5. Click "Add permissions"

**Note:** This gives full AWS access. For production, use the custom policy below.

---

## Custom Policy (Recommended for Production)

For production or if you want least-privilege access, use this custom policy that grants only the permissions needed for PodPDF deployment:

### Policy JSON

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudFormationAccess",
      "Effect": "Allow",
      "Action": [
        "cloudformation:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "LambdaAccess",
      "Effect": "Allow",
      "Action": [
        "lambda:*",
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:PassRole",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:GetRolePolicy",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:TagRole",
        "iam:UntagRole"
      ],
      "Resource": "*"
    },
    {
      "Sid": "APIGatewayReadAccessGlobal",
      "Effect": "Allow",
      "Action": [
        "apigateway:GET"
      ],
      "Resource": "*"
    },
    {
      "Sid": "APIGatewayAccess",
      "Effect": "Allow",
      "Action": [
        "apigateway:*",
        "execute-api:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "DynamoDBAccess",
      "Effect": "Allow",
      "Action": [
        "dynamodb:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CognitoAccess",
      "Effect": "Allow",
      "Action": [
        "cognito-idp:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CloudWatchAccess",
      "Effect": "Allow",
      "Action": [
        "logs:*",
        "cloudwatch:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "S3AccessForDeployment",
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:GetBucketLocation",
        "s3:ListBucket",
        "s3:DeleteBucket",
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:PutEncryptionConfiguration",
        "s3:GetEncryptionConfiguration",
        "s3:PutLifecycleConfiguration",
        "s3:GetLifecycleConfiguration",
        "s3:PutBucketPolicy",
        "s3:GetBucketPolicy",
        "s3:DeleteBucketPolicy",
        "s3:PutBucketVersioning",
        "s3:PutBucketPublicAccessBlock",
        "s3:GetBucketVersioning",
        "s3:PutBucketTagging",
        "s3:GetBucketTagging"
      ],
      "Resource": [
        "arn:aws:s3:::*-serverlessdeploymentbucket-*",
        "arn:aws:s3:::*-serverlessdeploymentbucket-*/*",
        "arn:aws:s3:::serverless-deployment-*",
        "arn:aws:s3:::serverless-deployment-*/*",
        "arn:aws:s3:::podpdf-*-pdfs",
        "arn:aws:s3:::podpdf-*-pdfs/*"
      ]
    },
    {
      "Sid": "SQSAccess",
      "Effect": "Allow",
      "Action": [
        "sqs:CreateQueue",
        "sqs:DeleteQueue",
        "sqs:GetQueueAttributes",
        "sqs:SetQueueAttributes",
        "sqs:TagQueue",
        "sqs:UntagQueue",
        "sqs:ListQueues"
      ],
      "Resource": [
        "arn:aws:sqs:eu-central-1:*:podpdf-*"
      ]
    },
    {
      "Sid": "STSAccess",
      "Effect": "Allow",
      "Action": [
        "sts:GetCallerIdentity"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ACMAccess",
      "Effect": "Allow",
      "Action": [
        "acm:ListCertificates",
        "acm:DescribeCertificate",
        "acm:GetCertificate"
      ],
      "Resource": "*"
    },
    {
      "Sid": "Route53Access",
      "Effect": "Allow",
      "Action": [
        "route53:ListHostedZones",
        "route53:GetHostedZone",
        "route53:ChangeResourceRecordSets",
        "route53:GetChange"
      ],
      "Resource": "*"
    }
  ]
}
```

---

## How to Create and Attach the Custom Policy

### Step 1: Create the Policy

1. Go to AWS Console → IAM → Policies
2. Click "Create policy"
3. Click the "JSON" tab
4. Paste the policy JSON above
5. Click "Next"
6. Name it: `PodPDFDeploymentPolicy`
7. Description: `Permissions for deploying PodPDF serverless application`
8. Click "Create policy"

### Step 2: Attach Policy to User

1. Go to AWS Console → IAM → Users
2. Select your user (the one you created access keys for)
3. Click "Add permissions" → "Attach policies directly"
4. Search for `PodPDFDeploymentPolicy`
5. Select it and click "Add permissions"

---

## Policy Breakdown (What Each Permission Does)

### CloudFormation (`cloudformation:*`)
- **Why:** Serverless Framework uses CloudFormation to create/update/delete AWS resources
- **Needed for:** Creating stacks, updating resources, deleting stacks

### Lambda (`lambda:*`)
- **Why:** Deploy Lambda functions
- **Needed for:** Creating, updating, deleting Lambda functions, managing layers, aliases

### IAM (`iam:*` for roles)
- **Why:** Create IAM roles that Lambda functions use
- **Needed for:** Lambda execution roles, API Gateway authorizer roles

### API Gateway (`apigateway:*`, `apigatewayv2:*`, `execute-api:*`)
- **Why:** Create and manage HTTP API endpoints and custom domains
- **Needed for:** Creating APIs, routes, integrations, authorizers, CORS, custom domain management
- **Note:** `apigateway:GET` with `Resource: "*"` is required for the domain manager plugin to check if domains exist globally

### DynamoDB (`dynamodb:*`)
- **Why:** Create and manage DynamoDB tables
- **Needed for:** Creating tables (Users, JobDetails, etc.), indexes, managing capacity

### Cognito (`cognito-idp:*`)
- **Why:** Create and manage Cognito User Pools
- **Needed for:** Creating user pools, app clients, managing authentication

### CloudWatch (`logs:*`, `cloudwatch:*`)
- **Why:** Create log groups and monitor resources
- **Needed for:** Lambda logs, CloudWatch metrics, alarms


### S3 (`s3:*` for deployment buckets)
- **Why:** Serverless Framework stores deployment artifacts in S3
- **Needed for:** Uploading Lambda code packages, CloudFormation templates

### STS (`sts:GetCallerIdentity`)
- **Why:** Verify AWS credentials and account
- **Needed for:** Authentication checks

### ACM (`acm:ListCertificates`, `acm:DescribeCertificate`, `acm:GetCertificate`)
- **Why:** Serverless domain manager needs to find and use SSL certificates for custom domains
- **Needed for:** Custom domain configuration (api.podpdf.com)

### Route53 (`route53:*` for hosted zones)
- **Why:** Create DNS records for custom domains (if createRoute53Record is true)
- **Needed for:** Custom domain DNS configuration

---

## More Restrictive Policy (Advanced - Optional)

If you want even more restrictive permissions, you can limit resources by stage/stack name:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudFormationAccess",
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DeleteStack",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResources",
        "cloudformation:GetTemplate",
        "cloudformation:ValidateTemplate",
        "cloudformation:ListStackResources"
      ],
      "Resource": [
        "arn:aws:cloudformation:eu-central-1:*:stack/podpdf-*/*"
      ]
    },
    {
      "Sid": "LambdaAccess",
      "Effect": "Allow",
      "Action": [
        "lambda:CreateFunction",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:DeleteFunction",
        "lambda:GetFunction",
        "lambda:ListFunctions",
        "lambda:AddPermission",
        "lambda:RemovePermission",
        "lambda:CreateAlias",
        "lambda:UpdateAlias",
        "lambda:DeleteAlias",
        "lambda:GetAlias",
        "lambda:ListAliases",
        "lambda:PublishVersion",
        "lambda:ListVersionsByFunction",
        "lambda:TagResource",
        "lambda:UntagResource"
      ],
      "Resource": [
        "arn:aws:lambda:eu-central-1:*:function:podpdf-*"
      ]
    },
    {
      "Sid": "IAMRoleAccess",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:PassRole",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:GetRolePolicy",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies"
      ],
      "Resource": [
        "arn:aws:iam::*:role/podpdf-*"
      ]
    },
    {
      "Sid": "DynamoDBAccess",
      "Effect": "Allow",
      "Action": [
        "dynamodb:CreateTable",
        "dynamodb:UpdateTable",
        "dynamodb:DeleteTable",
        "dynamodb:DescribeTable",
        "dynamodb:ListTables",
        "dynamodb:TagResource",
        "dynamodb:UntagResource"
      ],
      "Resource": [
        "arn:aws:dynamodb:eu-central-1:*:table/podpdf-*"
      ]
    },
    {
      "Sid": "CognitoAccess",
      "Effect": "Allow",
      "Action": [
        "cognito-idp:CreateUserPool",
        "cognito-idp:UpdateUserPool",
        "cognito-idp:DeleteUserPool",
        "cognito-idp:DescribeUserPool",
        "cognito-idp:ListUserPools",
        "cognito-idp:CreateUserPoolClient",
        "cognito-idp:UpdateUserPoolClient",
        "cognito-idp:DeleteUserPoolClient",
        "cognito-idp:DescribeUserPoolClient",
        "cognito-idp:ListUserPoolClients"
      ],
      "Resource": [
        "arn:aws:cognito-idp:eu-central-1:*:userpool/podpdf-*"
      ]
    },
    {
      "Sid": "APIGatewayReadAccessGlobal",
      "Effect": "Allow",
      "Action": [
        "apigateway:GET"
      ],
      "Resource": "*"
    },
    {
      "Sid": "APIGatewayAccess",
      "Effect": "Allow",
      "Action": [
        "apigateway:*"
      ],
      "Resource": [
        "arn:aws:apigateway:eu-central-1::/apis/*",
        "arn:aws:apigateway:eu-central-1::/apis/*/*",
        "arn:aws:apigateway:eu-central-1::/domainnames/*",
        "arn:aws:apigateway:eu-central-1::/domainnames/*/*"
      ]
    },
    {
      "Sid": "CloudWatchLogsAccess",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:DeleteLogGroup",
        "logs:DescribeLogGroups",
        "logs:PutRetentionPolicy"
      ],
      "Resource": [
        "arn:aws:logs:eu-central-1:*:log-group:/aws/lambda/podpdf-*"
      ]
    },
    {
      "Sid": "S3DeploymentBucketAccess",
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:GetBucketLocation",
        "s3:ListBucket",
        "s3:DeleteBucket",
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:PutEncryptionConfiguration",
        "s3:GetEncryptionConfiguration",
        "s3:PutLifecycleConfiguration",
        "s3:GetLifecycleConfiguration",
        "s3:PutBucketPolicy",
        "s3:GetBucketPolicy",
        "s3:DeleteBucketPolicy"
      ],
      "Resource": [
        "arn:aws:s3:::*-serverlessdeploymentbucket-*",
        "arn:aws:s3:::*-serverlessdeploymentbucket-*/*",
        "arn:aws:s3:::serverless-deployment-*",
        "arn:aws:s3:::serverless-deployment-*/*",
        "arn:aws:s3:::podpdf-*-pdfs",
        "arn:aws:s3:::podpdf-*-pdfs/*"
      ]
    },
    {
      "Sid": "SQSAccess",
      "Effect": "Allow",
      "Action": [
        "sqs:CreateQueue",
        "sqs:DeleteQueue",
        "sqs:GetQueueAttributes",
        "sqs:SetQueueAttributes",
        "sqs:TagQueue",
        "sqs:UntagQueue",
        "sqs:ListQueues"
      ],
      "Resource": [
        "arn:aws:sqs:eu-central-1:*:podpdf-*"
      ]
    },
    {
      "Sid": "STSAccess",
      "Effect": "Allow",
      "Action": [
        "sts:GetCallerIdentity"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ACMAccess",
      "Effect": "Allow",
      "Action": [
        "acm:ListCertificates",
        "acm:DescribeCertificate",
        "acm:GetCertificate"
      ],
      "Resource": "*"
    },
    {
      "Sid": "Route53Access",
      "Effect": "Allow",
      "Action": [
        "route53:ListHostedZones",
        "route53:GetHostedZone",
        "route53:ChangeResourceRecordSets",
        "route53:GetChange"
      ],
      "Resource": "*"
    }
  ]
}
```

**Note:** This restrictive policy limits actions to resources with `podpdf-*` prefix, but may need adjustments if Serverless Framework creates resources with different naming.

---

## Testing Your Policy

After attaching the policy, test it:

```bash
# Verify you can authenticate
aws sts get-caller-identity

# Try a dry-run deployment (won't actually deploy)
cd /Users/mfmz/podpdf-be
serverless deploy --stage dev --verbose
```

If you get permission errors, check which service is failing and ensure the policy includes those permissions.

---

## Common Permission Errors

### "AccessDenied: User is not authorized to perform: cloudformation:CreateStack"
- **Fix:** Add `cloudformation:*` or specific CloudFormation permissions

### "AccessDenied: User is not authorized to perform: iam:PassRole"
- **Fix:** Add IAM role permissions, especially `iam:PassRole`

### "AccessDenied: User is not authorized to perform: lambda:CreateFunction"
- **Fix:** Add Lambda permissions

### "AccessDenied: User is not authorized to perform: s3:PutObject"
- **Fix:** Add S3 permissions for deployment bucket

---

## Best Practices

1. **Development:** Use `AdministratorAccess` for simplicity
2. **Production:** Use the custom policy with least-privilege access
3. **Separate Users:** Use different IAM users for dev and prod deployments
4. **Rotate Keys:** Rotate access keys every 90 days
5. **Enable MFA:** Add multi-factor authentication to IAM users

---

## Summary

**For Quick Start (Development):**
- Attach `AdministratorAccess` managed policy

**For Production:**
- Create custom policy using the JSON above
- Attach to IAM user
- Test deployment

The custom policy grants all necessary permissions while being more restrictive than `AdministratorAccess`.

