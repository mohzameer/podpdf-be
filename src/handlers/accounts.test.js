/**
 * Unit tests for accounts.js - Monthly bill creation logic
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { createRequire } from 'module';

// Create mocks that will be used
const mockUpdateItem = vi.fn();
const mockQueryItems = vi.fn();
const mockGetItem = vi.fn();
const mockPutItem = vi.fn();

// Create require function for CommonJS modules
const require = createRequire(import.meta.url);

// Mock dependencies
vi.mock('../services/dynamodb', () => ({
  updateItem: vi.fn(),
  queryItems: vi.fn(),
  getItem: vi.fn(),
  putItem: vi.fn(),
}));

vi.mock('../utils/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock environment variables
process.env.BILLS_TABLE = 'test-bills-table';

// Import modules after mocks are set up
let getLatestActiveBill;

beforeAll(async () => {
  // CRITICAL: First, ensure the dynamodb module is loaded and cached
  const dynamodbPath = require.resolve('../services/dynamodb.js');
  require(dynamodbPath); // Load it into cache
  
  // Patch the cache with our mocks BEFORE importing accounts
  if (require.cache[dynamodbPath]) {
    require.cache[dynamodbPath].exports.updateItem = mockUpdateItem;
    require.cache[dynamodbPath].exports.queryItems = mockQueryItems;
    require.cache[dynamodbPath].exports.getItem = mockGetItem;
    require.cache[dynamodbPath].exports.putItem = mockPutItem;
  }
  
  // Also patch the ESM export
  const dynamodbModule = await import('../services/dynamodb.js');
  dynamodbModule.updateItem = mockUpdateItem;
  dynamodbModule.queryItems = mockQueryItems;
  dynamodbModule.getItem = mockGetItem;
  dynamodbModule.putItem = mockPutItem;
  
  // Now import accounts module
  const accountsModule = await import('./accounts.js');
  getLatestActiveBill = accountsModule.getLatestActiveBill;
});

describe('Monthly Bill Creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateItem.mockResolvedValue({});
    mockQueryItems.mockResolvedValue([]);
    mockGetItem.mockResolvedValue(null);
    mockPutItem.mockResolvedValue({});
    
    // Re-patch the module cache
    const dynamodbPath = require.resolve('../services/dynamodb.js');
    if (require.cache[dynamodbPath]) {
      require.cache[dynamodbPath].exports.updateItem = mockUpdateItem;
      require.cache[dynamodbPath].exports.queryItems = mockQueryItems;
      require.cache[dynamodbPath].exports.getItem = mockGetItem;
      require.cache[dynamodbPath].exports.putItem = mockPutItem;
    }
  });

  describe('getLatestActiveBill - New Month Bill Creation', () => {
    it('should create a new bill for paid plan user when no active bill exists', async () => {
      const userId = 'test-user-id';
      const isPaidPlan = true;
      
      // No existing bills
      mockQueryItems.mockResolvedValue([]);
      
      const result = await getLatestActiveBill(userId, isPaidPlan);
      
      // Assertions
      expect(mockPutItem).toHaveBeenCalledTimes(1);
      const putCall = mockPutItem.mock.calls[0];
      expect(putCall[0]).toBe('test-bills-table');
      const billItem = putCall[1];
      
      const currentMonth = new Date().toISOString().slice(0, 7);
      expect(billItem.user_id).toBe(userId);
      expect(billItem.billing_month).toBe(currentMonth);
      expect(billItem.monthly_pdf_count).toBe(0);
      expect(billItem.monthly_billing_amount).toBe(0);
      expect(billItem.is_paid).toBe(false);
      expect(billItem.is_active).toBe(true);
      expect(billItem.created_at).toBeDefined();
      expect(billItem.updated_at).toBeDefined();
      expect(new Date(billItem.created_at).getTime()).toBeLessThanOrEqual(Date.now());
      
      // Should return the created bill
      expect(result).toBeDefined();
      expect(result.user_id).toBe(userId);
      expect(result.billing_month).toBe(currentMonth);
    });

    it('should mark previous month bills as inactive when creating new bill', async () => {
      const userId = 'test-user-id';
      const previousMonth = new Date();
      previousMonth.setMonth(previousMonth.getMonth() - 1);
      const previousMonthStr = `${previousMonth.getFullYear()}-${String(previousMonth.getMonth() + 1).padStart(2, '0')}`;
      
      // Return previous month's bill
      mockQueryItems.mockResolvedValue([
        {
          user_id: userId,
          billing_month: previousMonthStr,
          monthly_pdf_count: 10,
          monthly_billing_amount: 0.10,
          is_active: true,
        },
      ]);
      
      await getLatestActiveBill(userId, true);
      
      // Assertions
      expect(mockUpdateItem).toHaveBeenCalled();
      const updateCalls = mockUpdateItem.mock.calls.filter(call => 
        call[0] === 'test-bills-table' && 
        call[1].billing_month === previousMonthStr
      );
      
      expect(updateCalls.length).toBeGreaterThan(0);
      const updateCall = updateCalls[0];
      expect(updateCall[2]).toContain('is_active = :false');
      
      expect(mockPutItem).toHaveBeenCalledTimes(1);
    });

    it('should return existing bill if active bill for current month exists', async () => {
      const userId = 'test-user-id';
      const currentMonth = new Date().toISOString().slice(0, 7);
      
      const existingBill = {
        user_id: userId,
        billing_month: currentMonth,
        monthly_pdf_count: 5,
        monthly_billing_amount: 0.05,
        is_paid: false,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      
      mockQueryItems.mockResolvedValue([existingBill]);
      
      const result = await getLatestActiveBill(userId, true);
      
      // Should not create new bill
      expect(mockPutItem).not.toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(result.billing_month).toBe(currentMonth);
      expect(result.monthly_pdf_count).toBe(5);
    });

    it('should not create bill for free plan users', async () => {
      const userId = 'test-user-id';
      
      mockQueryItems.mockResolvedValue([]);
      
      const result = await getLatestActiveBill(userId, false);
      
      // Should not create bill for free plan
      expect(mockPutItem).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it('should handle errors gracefully when marking previous bills inactive', async () => {
      const userId = 'test-user-id';
      const previousMonth = new Date();
      previousMonth.setMonth(previousMonth.getMonth() - 1);
      const previousMonthStr = `${previousMonth.getFullYear()}-${String(previousMonth.getMonth() + 1).padStart(2, '0')}`;
      
      mockQueryItems.mockResolvedValue([
        {
          user_id: userId,
          billing_month: previousMonthStr,
          monthly_pdf_count: 10,
          monthly_billing_amount: 0.10,
          is_active: true,
        },
      ]);
      
      // Simulate error when updating previous bill
      mockUpdateItem.mockRejectedValueOnce(new Error('Update failed'));
      mockPutItem.mockResolvedValue({});
      
      const result = await getLatestActiveBill(userId, true);
      
      // Should still create new bill even if marking inactive failed
      expect(mockPutItem).toHaveBeenCalledTimes(1);
      expect(result).toBeDefined();
      expect(result.billing_month).toBe(new Date().toISOString().slice(0, 7));
    });

    it('should create bill with correct billing month format (YYYY-MM)', async () => {
      const userId = 'test-user-id';
      
      mockQueryItems.mockResolvedValue([]);
      
      await getLatestActiveBill(userId, true);
      
      expect(mockPutItem).toHaveBeenCalledTimes(1);
      const putCall = mockPutItem.mock.calls[0];
      const billItem = putCall[1];
      
      // Verify billing_month format is YYYY-MM
      expect(billItem.billing_month).toMatch(/^\d{4}-\d{2}$/);
      const [year, month] = billItem.billing_month.split('-');
      expect(parseInt(year, 10)).toBeGreaterThan(2020);
      expect(parseInt(month, 10)).toBeGreaterThanOrEqual(1);
      expect(parseInt(month, 10)).toBeLessThanOrEqual(12);
    });
  });
});

