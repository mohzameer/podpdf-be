/**
 * Unit tests for business.js - incrementPdfCount logic
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

// Mock dependencies - must be hoisted before any imports
vi.mock('./dynamodb', () => ({
  updateItem: vi.fn(),
  queryItems: vi.fn(),
  getItem: vi.fn(),
  putItem: vi.fn(),
  deleteItem: vi.fn(),
  query: vi.fn(),
  scan: vi.fn(),
  batchWrite: vi.fn(),
}));

vi.mock('../utils/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock environment variables
process.env.USERS_TABLE = 'test-users-table';
process.env.USER_RATE_LIMITS_TABLE = 'test-rate-limits-table';
process.env.PLANS_TABLE = 'test-plans-table';
process.env.BILLS_TABLE = 'test-bills-table';
process.env.FREE_TIER_QUOTA = '100';
process.env.RATE_LIMIT_PER_MINUTE = '20';

// Import modules after mocks are set up
let incrementPdfCount;
let checkQuota;

beforeAll(async () => {
  // CRITICAL: First, ensure the dynamodb module is loaded and cached
  // This must happen before we import business.js
  const dynamodbPath = require.resolve('./dynamodb.js');
  require(dynamodbPath); // Load it into cache
  
  // Now patch the cache with our mocks BEFORE importing business
  if (require.cache[dynamodbPath]) {
    require.cache[dynamodbPath].exports.updateItem = mockUpdateItem;
    require.cache[dynamodbPath].exports.queryItems = mockQueryItems;
    require.cache[dynamodbPath].exports.getItem = mockGetItem;
    require.cache[dynamodbPath].exports.putItem = mockPutItem;
  }
  
  // Also patch the ESM export
  const dynamodbModule = await import('./dynamodb.js');
  dynamodbModule.updateItem = mockUpdateItem;
  dynamodbModule.queryItems = mockQueryItems;
  dynamodbModule.getItem = mockGetItem;
  dynamodbModule.putItem = mockPutItem;
  
  // Now import business module - it will use the mocked dynamodb from cache
  const businessModule = await import('./business.js');
  incrementPdfCount = businessModule.incrementPdfCount;
  checkQuota = businessModule.checkQuota;
});

describe('incrementPdfCount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mocks to return resolved values by default
    mockUpdateItem.mockResolvedValue({});
    mockQueryItems.mockResolvedValue([]);
    mockGetItem.mockResolvedValue(null); // No existing bill by default
    mockPutItem.mockResolvedValue({});
    
    // Re-patch the module cache in case it was cleared
    const dynamodbPath = require.resolve('./dynamodb.js');
    if (require.cache[dynamodbPath]) {
      require.cache[dynamodbPath].exports.updateItem = mockUpdateItem;
      require.cache[dynamodbPath].exports.queryItems = mockQueryItems;
      require.cache[dynamodbPath].exports.getItem = mockGetItem;
      require.cache[dynamodbPath].exports.putItem = mockPutItem;
    }
  });

  describe('Free Plan Users', () => {
    it('should increment total_pdf_count only for free plan users', async () => {
      const userSub = 'test-user-sub';
      const userId = 'test-user-id';
      const freePlan = {
        plan_id: 'free-basic',
        type: 'free',
        price_per_pdf: 0,
      };
      
      const user = {
        user_id: userId,
        user_sub: userSub,
        total_pdf_count: 5,
        billing_month: '2025-12',
      };

      mockQueryItems.mockResolvedValue([user]);
      mockUpdateItem.mockResolvedValue({});

      await incrementPdfCount(userSub, userId, freePlan);

      expect(mockUpdateItem).toHaveBeenCalledTimes(1);
      expect(mockUpdateItem).toHaveBeenCalledWith(
        'test-users-table',
        { user_id: userId },
        'SET total_pdf_count = if_not_exists(total_pdf_count, :zero) + :inc',
        { ':zero': 0, ':inc': 1 }
      );
    });

    it('should not track billing for free plan users', async () => {
      const userSub = 'test-user-sub';
      const userId = 'test-user-id';
      const freePlan = {
        plan_id: 'free-basic',
        type: 'free',
        price_per_pdf: 0,
      };
      
      const user = {
        user_id: userId,
        user_sub: userSub,
        total_pdf_count: 10,
      };

      mockQueryItems.mockResolvedValue([user]);
      mockUpdateItem.mockResolvedValue({});

      await incrementPdfCount(userSub, userId, freePlan);

      const updateCall = mockUpdateItem.mock.calls[0];
      const updateExpression = updateCall[2];
      
      // Should not include billing fields
      expect(updateExpression).not.toContain('monthly_billing_amount');
      expect(updateExpression).not.toContain('monthly_pdf_count');
      expect(updateExpression).not.toContain('billing_month');
    });

    it('should handle user with no existing total_pdf_count', async () => {
      const userSub = 'test-user-sub';
      const userId = 'test-user-id';
      const freePlan = {
        plan_id: 'free-basic',
        type: 'free',
        price_per_pdf: 0,
      };
      
      const user = {
        user_id: userId,
        user_sub: userSub,
        // No total_pdf_count
      };

      mockQueryItems.mockResolvedValue([user]);
      mockUpdateItem.mockResolvedValue({});

      await incrementPdfCount(userSub, userId, freePlan);

      expect(mockUpdateItem).toHaveBeenCalledWith(
        'test-users-table',
        { user_id: userId },
        'SET total_pdf_count = if_not_exists(total_pdf_count, :zero) + :inc',
        { ':zero': 0, ':inc': 1 }
      );
    });
  });

  describe('Paid Plan Users - Same Month', () => {
    it('should increment total_pdf_count and monthly billing for paid users in same month', async () => {
      const userSub = 'test-user-sub';
      const userId = 'test-user-id';
      const paidPlan = {
        plan_id: 'paid-standard',
        type: 'paid',
        price_per_pdf: 0.005,
      };
      
      const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
      const user = {
        user_id: userId,
        user_sub: userSub,
        total_pdf_count: 50,
      };

      // Existing bill for current month
      const existingBill = {
        user_id: userId,
        billing_month: currentMonth,
        monthly_pdf_count: 20,
        monthly_billing_amount: 0.1,
      };

      mockQueryItems.mockResolvedValue([user]);
      mockGetItem.mockResolvedValue(existingBill);
      mockUpdateItem.mockResolvedValue({});

      await incrementPdfCount(userSub, userId, paidPlan);

      // Should update Users table first
      expect(mockUpdateItem).toHaveBeenCalledTimes(2);
      const usersUpdateCall = mockUpdateItem.mock.calls[0];
      expect(usersUpdateCall[0]).toBe('test-users-table');
      
      // Then update Bills table
      const billsUpdateCall = mockUpdateItem.mock.calls[1];
      expect(billsUpdateCall[0]).toBe('test-bills-table');
      const updateExpression = billsUpdateCall[2];
      const expressionValues = billsUpdateCall[3];

      // Should include billing fields
      expect(updateExpression).toContain('monthly_billing_amount');
      expect(updateExpression).toContain('monthly_pdf_count');
      expect(expressionValues[':billing']).toBe(0.005);
      expect(expressionValues[':inc']).toBe(1);
    });

    it('should increment existing monthly billing amount', async () => {
      const userSub = 'test-user-sub';
      const userId = 'test-user-id';
      const paidPlan = {
        plan_id: 'paid-standard',
        type: 'paid',
        price_per_pdf: 0.005,
      };
      
      const currentMonth = new Date().toISOString().slice(0, 7);
      const user = {
        user_id: userId,
        user_sub: userSub,
        total_pdf_count: 100,
      };

      // Existing bill for current month
      const existingBill = {
        user_id: userId,
        billing_month: currentMonth,
        monthly_pdf_count: 50,
        monthly_billing_amount: 0.25,
      };

      mockQueryItems.mockResolvedValue([user]);
      mockGetItem.mockResolvedValue(existingBill);
      mockUpdateItem.mockResolvedValue({});

      await incrementPdfCount(userSub, userId, paidPlan);

      // Should update Bills table (second call)
      const billsUpdateCall = mockUpdateItem.mock.calls[1];
      const updateExpression = billsUpdateCall[2];
      
      // Should use increment expression, not reset
      expect(updateExpression).toContain('monthly_billing_amount + :billing');
      expect(updateExpression).toContain('monthly_pdf_count + :inc');
      // Should NOT reset billing_month (same month)
      expect(updateExpression).not.toContain('billing_month');
    });
  });

  describe('Paid Plan Users - New Month', () => {
    it('should reset monthly billing when month changes', async () => {
      const userSub = 'test-user-sub';
      const userId = 'test-user-id';
      const paidPlan = {
        plan_id: 'paid-standard',
        type: 'paid',
        price_per_pdf: 0.005,
      };
      
      const user = {
        user_id: userId,
        user_sub: userSub,
        total_pdf_count: 100,
      };

      // No existing bill for current month (new month)
      mockQueryItems.mockResolvedValue([user]);
      mockGetItem.mockResolvedValue(null); // No bill exists
      mockPutItem.mockResolvedValue({});
      mockUpdateItem.mockResolvedValue({});

      await incrementPdfCount(userSub, userId, paidPlan);

      // Should create new bill with putItem
      expect(mockPutItem).toHaveBeenCalledTimes(1);
      const putCall = mockPutItem.mock.calls[0];
      expect(putCall[0]).toBe('test-bills-table');
      const billItem = putCall[1];
      const currentMonth = new Date().toISOString().slice(0, 7);

      // Should create new bill for new month
      expect(billItem.billing_month).toBe(currentMonth);
      expect(billItem.monthly_pdf_count).toBe(1);
      expect(billItem.monthly_billing_amount).toBe(0.005);
    });

    it('should set billing_month to current month on reset', async () => {
      const userSub = 'test-user-sub';
      const userId = 'test-user-id';
      const paidPlan = {
        plan_id: 'paid-standard',
        type: 'paid',
        price_per_pdf: 0.005,
      };
      
      const user = {
        user_id: userId,
        user_sub: userSub,
      };

      // No existing bill (new month)
      mockQueryItems.mockResolvedValue([user]);
      mockGetItem.mockResolvedValue(null);
      mockPutItem.mockResolvedValue({});
      mockUpdateItem.mockResolvedValue({});

      await incrementPdfCount(userSub, userId, paidPlan);

      const putCall = mockPutItem.mock.calls[0];
      const billItem = putCall[1];
      const currentMonth = new Date().toISOString().slice(0, 7);

      expect(billItem.billing_month).toBe(currentMonth);
    });
  });

  describe('Edge Cases', () => {
    it('should handle user with no billing_month set', async () => {
      const userSub = 'test-user-sub';
      const userId = 'test-user-id';
      const paidPlan = {
        plan_id: 'paid-standard',
        type: 'paid',
        price_per_pdf: 0.005,
      };
      
      const user = {
        user_id: userId,
        user_sub: userSub,
        total_pdf_count: 10,
      };

      // No existing bill - will create new one
      mockQueryItems.mockResolvedValue([user]);
      mockGetItem.mockResolvedValue(null);
      mockPutItem.mockResolvedValue({});
      mockUpdateItem.mockResolvedValue({});

      await incrementPdfCount(userSub, userId, paidPlan);

      // Should create new bill with putItem
      expect(mockPutItem).toHaveBeenCalledTimes(1);
      const putCall = mockPutItem.mock.calls[0];
      const billItem = putCall[1];
      expect(billItem.monthly_pdf_count).toBe(1);
      expect(billItem.monthly_billing_amount).toBe(0.005);
    });

    it('should handle null plan gracefully', async () => {
      const userSub = 'test-user-sub';
      const userId = 'test-user-id';
      
      const user = {
        user_id: userId,
        user_sub: userSub,
        total_pdf_count: 5,
      };

      mockQueryItems.mockResolvedValue([user]);
      mockUpdateItem.mockResolvedValue({});

      await incrementPdfCount(userSub, userId, null);

      // Should only increment total_pdf_count
      const updateCall = mockUpdateItem.mock.calls[0];
      const updateExpression = updateCall[2];
      expect(updateExpression).not.toContain('monthly_billing_amount');
    });

    it('should handle plan with no price_per_pdf', async () => {
      const userSub = 'test-user-sub';
      const userId = 'test-user-id';
      const planWithoutPrice = {
        plan_id: 'paid-standard',
        type: 'paid',
        // No price_per_pdf
      };
      
      const user = {
        user_id: userId,
        user_sub: userSub,
        total_pdf_count: 10,
      };

      mockQueryItems.mockResolvedValue([user]);
      mockUpdateItem.mockResolvedValue({});

      await incrementPdfCount(userSub, userId, planWithoutPrice);

      // Should not track billing if no price_per_pdf
      const updateCall = mockUpdateItem.mock.calls[0];
      const updateExpression = updateCall[2];
      expect(updateExpression).not.toContain('monthly_billing_amount');
    });

    it('should fallback to user_sub lookup if user_id update fails', async () => {
      const userSub = 'test-user-sub';
      const userId = 'test-user-id';
      const freePlan = {
        plan_id: 'free-basic',
        type: 'free',
        price_per_pdf: 0,
      };
      
      const user = {
        user_id: 'actual-user-id',
        user_sub: userSub,
        total_pdf_count: 5,
      };

      mockQueryItems.mockResolvedValue([user]);
      // First call fails, second succeeds
      mockUpdateItem
        .mockRejectedValueOnce(new Error('Update failed'))
        .mockResolvedValueOnce({});

      await incrementPdfCount(userSub, userId, freePlan);

      // Should retry with actual user_id
      expect(mockUpdateItem).toHaveBeenCalledTimes(2);
      expect(mockUpdateItem).toHaveBeenLastCalledWith(
        'test-users-table',
        { user_id: 'actual-user-id' },
        expect.any(String),
        expect.any(Object)
      );
    });

    it('should handle errors gracefully without throwing', async () => {
      const userSub = 'test-user-sub';
      const userId = 'test-user-id';
      const freePlan = {
        plan_id: 'free-basic',
        type: 'free',
        price_per_pdf: 0,
      };
      
      mockQueryItems.mockRejectedValue(new Error('Database error'));
      mockUpdateItem.mockRejectedValue(new Error('Update error'));

      // Should not throw
      await expect(incrementPdfCount(userSub, userId, freePlan)).resolves.not.toThrow();
    });
  });

  describe('Billing Calculation', () => {
    it('should calculate billing amount correctly', async () => {
      const userSub = 'test-user-sub';
      const userId = 'test-user-id';
      const paidPlan = {
        plan_id: 'paid-standard',
        type: 'paid',
        price_per_pdf: 0.005,
      };
      
      const currentMonth = new Date().toISOString().slice(0, 7);
      const user = {
        user_id: userId,
        user_sub: userSub,
      };

      // Existing bill
      const existingBill = {
        user_id: userId,
        billing_month: currentMonth,
        monthly_pdf_count: 10,
        monthly_billing_amount: 0.05,
      };

      mockQueryItems.mockResolvedValue([user]);
      mockGetItem.mockResolvedValue(existingBill);
      mockUpdateItem.mockResolvedValue({});

      await incrementPdfCount(userSub, userId, paidPlan);

      const billsUpdateCall = mockUpdateItem.mock.calls[1];
      const expressionValues = billsUpdateCall[3];
      
      expect(expressionValues[':billing']).toBe(0.005);
    });

    it('should handle different price_per_pdf values', async () => {
      const userSub = 'test-user-sub';
      const userId = 'test-user-id';
      const paidPlan = {
        plan_id: 'paid-premium',
        type: 'paid',
        price_per_pdf: 0.01, // Different price
      };
      
      const currentMonth = new Date().toISOString().slice(0, 7);
      const user = {
        user_id: userId,
        user_sub: userSub,
      };

      // Existing bill
      const existingBill = {
        user_id: userId,
        billing_month: currentMonth,
        monthly_pdf_count: 5,
        monthly_billing_amount: 0.05,
      };

      mockQueryItems.mockResolvedValue([user]);
      mockGetItem.mockResolvedValue(existingBill);
      mockUpdateItem.mockResolvedValue({});

      await incrementPdfCount(userSub, userId, paidPlan);

      const billsUpdateCall = mockUpdateItem.mock.calls[1];
      const expressionValues = billsUpdateCall[3];
      
      expect(expressionValues[':billing']).toBe(0.01);
    });
  });
});

describe('checkQuota', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateItem.mockResolvedValue({});
    mockQueryItems.mockResolvedValue([]);
    
    // Re-patch the module cache in case it was cleared
    const dynamodbPath = require.resolve('./dynamodb.js');
    if (require.cache[dynamodbPath]) {
      require.cache[dynamodbPath].exports.updateItem = mockUpdateItem;
      require.cache[dynamodbPath].exports.queryItems = mockQueryItems;
      require.cache[dynamodbPath].exports.getItem = mockGetItem;
      require.cache[dynamodbPath].exports.putItem = mockPutItem;
    }
  });

  describe('Paid Plan Users', () => {
    it('should allow paid plan users (no quota)', async () => {
      const userSub = 'test-user-sub';
      const user = {
        user_id: 'test-user-id',
        user_sub: userSub,
        total_pdf_count: 1000,
        quota_exceeded: true,
      };
      const paidPlan = {
        plan_id: 'paid-standard',
        type: 'paid',
        monthly_quota: null, // No quota for paid plans
      };

      const result = await checkQuota(userSub, user, paidPlan);

      expect(result.allowed).toBe(true);
      expect(result.error).toBeNull();
      // Should clear quota_exceeded flag for paid users
      expect(mockUpdateItem).toHaveBeenCalledWith(
        'test-users-table',
        { user_id: 'test-user-id' },
        'SET quota_exceeded = :false',
        { ':false': false }
      );
    });

    it('should allow paid plan users with undefined monthly_quota', async () => {
      const userSub = 'test-user-sub';
      const user = {
        user_id: 'test-user-id',
        user_sub: userSub,
        total_pdf_count: 1000,
      };
      const paidPlan = {
        plan_id: 'paid-standard',
        type: 'paid',
        // monthly_quota is undefined
      };

      const result = await checkQuota(userSub, user, paidPlan);

      expect(result.allowed).toBe(true);
      expect(result.error).toBeNull();
    });
  });

  describe('Free Plan Users', () => {
    it('should use quota from plan.monthly_quota', async () => {
      const userSub = 'test-user-sub';
      const user = {
        user_id: 'test-user-id',
        user_sub: userSub,
        total_pdf_count: 49, // Under quota
        quota_exceeded: false,
      };
      const freePlan = {
        plan_id: 'free-basic',
        type: 'free',
        monthly_quota: 50, // Custom quota from Plans table
      };

      const result = await checkQuota(userSub, user, freePlan);

      expect(result.allowed).toBe(true);
      expect(result.error).toBeNull();
    });

    it('should reject when user exceeds plan.monthly_quota', async () => {
      const userSub = 'test-user-sub';
      const user = {
        user_id: 'test-user-id',
        user_sub: userSub,
        total_pdf_count: 50,
        quota_exceeded: false,
      };
      const freePlan = {
        plan_id: 'free-basic',
        type: 'free',
        monthly_quota: 50, // Custom quota from Plans table
      };

      const result = await checkQuota(userSub, user, freePlan);

      // At exactly 50 (>= quota), should be rejected
      expect(result.allowed).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error.statusCode).toBe(403);

      // At 51, should also be rejected
      user.total_pdf_count = 51;
      const result2 = await checkQuota(userSub, user, freePlan);
      expect(result2.allowed).toBe(false);
      expect(result2.error).toBeDefined();
      expect(result2.error.statusCode).toBe(403);
    });

    it('should fallback to FREE_TIER_QUOTA if plan.monthly_quota is missing', async () => {
      const userSub = 'test-user-sub';
      const user = {
        user_id: 'test-user-id',
        user_sub: userSub,
        total_pdf_count: 99, // Under fallback quota
        quota_exceeded: false,
      };
      const freePlan = {
        plan_id: 'free-basic',
        type: 'free',
        // monthly_quota is missing - should fallback to FREE_TIER_QUOTA (100)
      };

      const result = await checkQuota(userSub, user, freePlan);

      // At 99, should be allowed
      expect(result.allowed).toBe(true);
      expect(result.error).toBeNull();

      // At exactly 100, should be rejected (>= check)
      user.total_pdf_count = 100;
      const result2 = await checkQuota(userSub, user, freePlan);
      expect(result2.allowed).toBe(false);
      expect(result2.error).toBeDefined();
      expect(result2.error.statusCode).toBe(403);
    });

    it('should set quota_exceeded flag when quota is exceeded', async () => {
      const userSub = 'test-user-sub';
      const user = {
        user_id: 'test-user-id',
        user_sub: userSub,
        total_pdf_count: 101,
        quota_exceeded: false,
      };
      const freePlan = {
        plan_id: 'free-basic',
        type: 'free',
        monthly_quota: 100,
      };

      await checkQuota(userSub, user, freePlan);

      // Should set quota_exceeded flag
      expect(mockUpdateItem).toHaveBeenCalledWith(
        'test-users-table',
        { user_id: 'test-user-id' },
        'SET quota_exceeded = :true',
        { ':true': true }
      );
    });

    it('should clear quota_exceeded flag when user is under quota', async () => {
      const userSub = 'test-user-sub';
      const user = {
        user_id: 'test-user-id',
        user_sub: userSub,
        total_pdf_count: 50,
        quota_exceeded: true, // Previously exceeded
      };
      const freePlan = {
        plan_id: 'free-basic',
        type: 'free',
        monthly_quota: 100,
      };

      await checkQuota(userSub, user, freePlan);

      // Should clear quota_exceeded flag
      expect(mockUpdateItem).toHaveBeenCalledWith(
        'test-users-table',
        { user_id: 'test-user-id' },
        'SET quota_exceeded = :false',
        { ':false': false }
      );
    });

    it('should use custom quota from plan instead of FREE_TIER_QUOTA', async () => {
      const userSub = 'test-user-sub';
      const user = {
        user_id: 'test-user-id',
        user_sub: userSub,
        total_pdf_count: 75,
        quota_exceeded: false,
      };
      const freePlan = {
        plan_id: 'free-premium',
        type: 'free',
        monthly_quota: 75, // Custom quota different from FREE_TIER_QUOTA (100)
      };

      const result = await checkQuota(userSub, user, freePlan);

      // At exactly 75 (plan quota), should be rejected
      expect(result.allowed).toBe(false);
      expect(result.error).toBeDefined();
      
      // Error should contain the plan quota (75), not FREE_TIER_QUOTA (100)
      const errorBody = JSON.parse(result.error.body);
      expect(errorBody.error.details.quota).toBe(75);
    });
  });

  describe('Edge Cases', () => {
    it('should handle errors gracefully without throwing', async () => {
      const userSub = 'test-user-sub';
      const user = {
        user_id: 'test-user-id',
        user_sub: userSub,
        total_pdf_count: 50,
      };
      const freePlan = {
        plan_id: 'free-basic',
        type: 'free',
        monthly_quota: 100,
      };

      mockUpdateItem.mockRejectedValue(new Error('Database error'));

      // Should not throw
      await expect(checkQuota(userSub, user, freePlan)).resolves.not.toThrow();
    });

    it('should allow request on error (fail open)', async () => {
      const userSub = 'test-user-sub';
      const user = {
        user_id: 'test-user-id',
        user_sub: userSub,
        total_pdf_count: 50,
      };
      const freePlan = {
        plan_id: 'free-basic',
        type: 'free',
        monthly_quota: 100,
      };

      mockUpdateItem.mockRejectedValue(new Error('Database error'));

      const result = await checkQuota(userSub, user, freePlan);

      // Should fail open (allow request)
      expect(result.allowed).toBe(true);
      expect(result.error).toBeNull();
    });
  });
});
