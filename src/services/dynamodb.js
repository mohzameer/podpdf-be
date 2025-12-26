/**
 * DynamoDB service
 * Provides helper functions for DynamoDB operations
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, ScanCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'eu-central-1' });
const docClient = DynamoDBDocumentClient.from(client);

/**
 * Get an item from a table
 */
async function getItem(tableName, key) {
  const command = new GetCommand({
    TableName: tableName,
    Key: key,
  });
  const response = await docClient.send(command);
  return response.Item;
}

/**
 * Put an item into a table
 */
async function putItem(tableName, item) {
  const command = new PutCommand({
    TableName: tableName,
    Item: item,
  });
  await docClient.send(command);
  return item;
}

/**
 * Update an item in a table
 */
async function updateItem(tableName, key, updateExpression, expressionAttributeValues, expressionAttributeNames = {}) {
  const params = {
    TableName: tableName,
    Key: key,
    UpdateExpression: updateExpression,
    ExpressionAttributeValues: expressionAttributeValues,
    ReturnValues: 'ALL_NEW',
  };
  
  // Only include ExpressionAttributeNames if it's not empty
  if (expressionAttributeNames && Object.keys(expressionAttributeNames).length > 0) {
    params.ExpressionAttributeNames = expressionAttributeNames;
  }
  
  const command = new UpdateCommand(params);
  const response = await docClient.send(command);
  return response.Attributes;
}

/**
 * Delete an item from a table
 */
async function deleteItem(tableName, key) {
  const command = new DeleteCommand({
    TableName: tableName,
    Key: key,
  });
  await docClient.send(command);
}

/**
 * Query a table
 */
async function query(tableName, keyConditionExpression, expressionAttributeValues, indexName = null, limit = null, exclusiveStartKey = null, filterExpression = null, expressionAttributeNames = null, scanIndexForward = true) {
  const params = {
    TableName: tableName,
    KeyConditionExpression: keyConditionExpression,
    ExpressionAttributeValues: expressionAttributeValues,
    ScanIndexForward: scanIndexForward,
  };
  if (indexName) {
    params.IndexName = indexName;
  }
  if (limit) {
    params.Limit = limit;
  }
  if (exclusiveStartKey) {
    params.ExclusiveStartKey = exclusiveStartKey;
  }
  if (filterExpression) {
    params.FilterExpression = filterExpression;
  }
  if (expressionAttributeNames) {
    params.ExpressionAttributeNames = expressionAttributeNames;
  }
  const command = new QueryCommand(params);
  const response = await docClient.send(command);
  return {
    Items: response.Items,
    LastEvaluatedKey: response.LastEvaluatedKey,
  };
}

/**
 * Scan a table
 */
async function scan(tableName, filterExpression = null, expressionAttributeValues = {}) {
  const params = {
    TableName: tableName,
  };
  if (filterExpression) {
    params.FilterExpression = filterExpression;
    params.ExpressionAttributeValues = expressionAttributeValues;
  }
  const command = new ScanCommand(params);
  const response = await docClient.send(command);
  return response.Items;
}

/**
 * Batch write items
 */
async function batchWrite(tableName, items) {
  const requests = items.map((item) => ({
    PutRequest: {
      Item: item,
    },
  }));
  
  const command = new BatchWriteCommand({
    RequestItems: {
      [tableName]: requests,
    },
  });
  
  await docClient.send(command);
}

/**
 * Query a table and return only items (backward compatibility)
 */
async function queryItems(tableName, keyConditionExpression, expressionAttributeValues, indexName = null) {
  const result = await query(tableName, keyConditionExpression, expressionAttributeValues, indexName);
  return result.Items;
}

module.exports = {
  getItem,
  putItem,
  updateItem,
  deleteItem,
  query,
  queryItems,
  scan,
  batchWrite,
};

