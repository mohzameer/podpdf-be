#!/bin/bash

# Script to clean up old Lambda function versions
# This helps prevent "Code storage limit exceeded" errors
# Usage: ./scripts/cleanup-lambda-versions.sh [stage]
# Example: ./scripts/cleanup-lambda-versions.sh dev

set -e

STAGE=${1:-dev}
REGION="eu-central-1"

echo "Cleaning up old Lambda versions for stage: $STAGE"
echo "Region: $REGION"
echo ""

# List all functions for this stage
echo "Finding Lambda functions..."
FUNCTIONS=$(aws lambda list-functions \
  --region $REGION \
  --query "Functions[?starts_with(FunctionName, \`podpdf-${STAGE}-\`)].FunctionName" \
  --output text)

if [ -z "$FUNCTIONS" ]; then
  echo "No functions found for stage: $STAGE"
  exit 0
fi

echo "Found functions:"
echo "$FUNCTIONS" | tr '\t' '\n'
echo ""

# Process each function
TOTAL_DELETED=0
for func in $FUNCTIONS; do
  echo "Processing function: $func"
  
  # List all versions (excluding $LATEST)
  VERSIONS=$(aws lambda list-versions-by-function \
    --function-name "$func" \
    --region $REGION \
    --query 'Versions[?Version!=`$LATEST`].Version' \
    --output text)
  
  if [ -z "$VERSIONS" ]; then
    echo "  No old versions to delete"
    continue
  fi
  
  VERSION_COUNT=$(echo "$VERSIONS" | tr '\t' '\n' | wc -l | tr -d ' ')
  echo "  Found $VERSION_COUNT old version(s) to delete"
  
  # Delete each version
  for version in $VERSIONS; do
    echo "    Deleting version: $version"
    aws lambda delete-function \
      --function-name "$func" \
      --qualifier "$version" \
      --region $REGION \
      --output text > /dev/null 2>&1 || echo "    Warning: Failed to delete version $version"
    TOTAL_DELETED=$((TOTAL_DELETED + 1))
  done
  
  echo "  Done with $func"
  echo ""
done

echo "Cleanup complete!"
echo "Total versions deleted: $TOTAL_DELETED"

