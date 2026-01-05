/**
 * Unit tests for business.js - checkQuota and checkCredits logic
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
process.env.FREE_TIER_QUOTA = '100';
process.env.RATE_LIMIT_PER_MINUTE = '20';

// Import modules after mocks are set up
let checkQuota;
let checkCredits;

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
  checkQuota = businessModule.checkQuota;
  checkCredits = businessModule.checkCredits;
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

describe('checkCredits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetItem.mockResolvedValue({});
    
    // Re-patch the module cache in case it was cleared
    const dynamodbPath = require.resolve('./dynamodb.js');
    if (require.cache[dynamodbPath]) {
      require.cache[dynamodbPath].exports.getItem = mockGetItem;
    }
  });

  describe('Free Tier Users', () => {
    it('should allow free tier users (no plan)', async () => {
      const userId = 'test-user-id';
      const result = await checkCredits(userId, null, 0.01);

      expect(result.allowed).toBe(true);
      expect(result.error).toBeNull();
      expect(result.currentBalance).toBeNull();
      expect(mockGetItem).not.toHaveBeenCalled();
    });

    it('should allow free plan users', async () => {
      const userId = 'test-user-id';
      const freePlan = {
        plan_id: 'free-basic',
        type: 'free',
        price_per_pdf: 0,
      };

      const result = await checkCredits(userId, freePlan, 0);

      expect(result.allowed).toBe(true);
      expect(result.error).toBeNull();
      expect(result.currentBalance).toBeNull();
      expect(mockGetItem).not.toHaveBeenCalled();
    });

    it('should allow when costPerPdf is 0', async () => {
      const userId = 'test-user-id';
      const paidPlan = {
        plan_id: 'paid-standard',
        type: 'paid',
        price_per_pdf: 0,
      };

      const result = await checkCredits(userId, paidPlan, 0);

      expect(result.allowed).toBe(true);
      expect(result.error).toBeNull();
      expect(result.currentBalance).toBeNull();
      expect(mockGetItem).not.toHaveBeenCalled();
    });

    it('should allow when costPerPdf is negative', async () => {
      const userId = 'test-user-id';
      const paidPlan = {
        plan_id: 'paid-standard',
        type: 'paid',
        price_per_pdf: -0.01,
      };

      const result = await checkCredits(userId, paidPlan, -0.01);

      expect(result.allowed).toBe(true);
      expect(result.error).toBeNull();
      expect(result.currentBalance).toBeNull();
      expect(mockGetItem).not.toHaveBeenCalled();
    });
  });

  describe('Paid Plan Users - User Not Found', () => {
    it('should reject when user is not found', async () => {
      const userId = 'test-user-id';
      const paidPlan = {
        plan_id: 'paid-standard',
        type: 'paid',
        price_per_pdf: 0.01,
      };

      mockGetItem.mockResolvedValue(null);

      const result = await checkCredits(userId, paidPlan, 0.01);

      expect(result.allowed).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error.statusCode).toBe(403);
      expect(result.currentBalance).toBeNull();
      expect(mockGetItem).toHaveBeenCalledWith('test-users-table', { user_id: userId });
    });
  });

  describe('Paid Plan Users - Free Credits', () => {
    it('should allow when user has free credits remaining', async () => {
      const userId = 'test-user-id';
      const paidPlan = {
        plan_id: 'paid-standard',
        type: 'paid',
        price_per_pdf: 0.01,
        free_credits: 100,
      };

      const user = {
        user_id: userId,
        free_credits_remaining: 50,
        credits_balance: 5.0,
      };

      mockGetItem.mockResolvedValue(user);

      const result = await checkCredits(userId, paidPlan, 0.01);

      expect(result.allowed).toBe(true);
      expect(result.error).toBeNull();
      expect(result.currentBalance).toBe(5.0);
    });

    it('should allow when free credits remaining is exactly 1', async () => {
      const userId = 'test-user-id';
      const paidPlan = {
        plan_id: 'paid-standard',
        type: 'paid',
        price_per_pdf: 0.01,
        free_credits: 100,
      };

      const user = {
        user_id: userId,
        free_credits_remaining: 1,
        credits_balance: 0,
      };

      mockGetItem.mockResolvedValue(user);

      const result = await checkCredits(userId, paidPlan, 0.01);

      expect(result.allowed).toBe(true);
      expect(result.error).toBeNull();
      expect(result.currentBalance).toBe(0);
    });

    it('should check prepaid credits when free credits are exhausted', async () => {
      const userId = 'test-user-id';
      const paidPlan = {
        plan_id: 'paid-standard',
        type: 'paid',
        price_per_pdf: 0.01,
        free_credits: 100,
      };

      const user = {
        user_id: userId,
        free_credits_remaining: 0, // Exhausted
        credits_balance: 0.05,
      };

      mockGetItem.mockResolvedValue(user);

      const result = await checkCredits(userId, paidPlan, 0.01);

      expect(result.allowed).toBe(true);
      expect(result.error).toBeNull();
      expect(result.currentBalance).toBe(0.05);
    });

    it('should check prepaid credits when free credits are negative', async () => {
      const userId = 'test-user-id';
      const paidPlan = {
        plan_id: 'paid-standard',
        type: 'paid',
        price_per_pdf: 0.01,
        free_credits: 100,
      };

      const user = {
        user_id: userId,
        free_credits_remaining: -5, // Negative (concurrent requests)
        credits_balance: 0.10,
      };

      mockGetItem.mockResolvedValue(user);

      const result = await checkCredits(userId, paidPlan, 0.01);

      expect(result.allowed).toBe(true);
      expect(result.error).toBeNull();
      expect(result.currentBalance).toBe(0.10);
    });

    it('should check prepaid credits when plan has no free_credits', async () => {
      const userId = 'test-user-id';
      const paidPlan = {
        plan_id: 'paid-standard',
        type: 'paid',
        price_per_pdf: 0.01,
        // No free_credits
      };

      const user = {
        user_id: userId,
        credits_balance: 0.10,
      };

      mockGetItem.mockResolvedValue(user);

      const result = await checkCredits(userId, paidPlan, 0.01);

      expect(result.allowed).toBe(true);
      expect(result.error).toBeNull();
      expect(result.currentBalance).toBe(0.10);
    });
  });

  describe('Paid Plan Users - Insufficient Credits', () => {
    it('should reject when credits_balance is less than costPerPdf', async () => {
      const userId = 'test-user-id';
      const paidPlan = {
        plan_id: 'paid-standard',
        type: 'paid',
        price_per_pdf: 0.01,
      };

      const user = {
        user_id: userId,
        credits_balance: 0.005, // Less than 0.01
      };

      mockGetItem.mockResolvedValue(user);

      const result = await checkCredits(userId, paidPlan, 0.01);

      expect(result.allowed).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error.statusCode).toBe(403);
      expect(result.currentBalance).toBe(0.005);
      
      const errorBody = JSON.parse(result.error.body);
      expect(errorBody.error.code).toBe('INSUFFICIENT_CREDITS');
      expect(errorBody.error.details.current_balance).toBe(0.005);
      expect(errorBody.error.details.required_amount).toBe(0.01);
    });

    it('should reject when credits_balance is 0', async () => {
      const userId = 'test-user-id';
      const paidPlan = {
        plan_id: 'paid-standard',
        type: 'paid',
        price_per_pdf: 0.01,
      };

      const user = {
        user_id: userId,
        credits_balance: 0,
      };

      mockGetItem.mockResolvedValue(user);

      const result = await checkCredits(userId, paidPlan, 0.01);

      expect(result.allowed).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error.statusCode).toBe(403);
      expect(result.currentBalance).toBe(0);
    });

    it('should allow when credits_balance is exactly costPerPdf (edge case)', async () => {
      const userId = 'test-user-id';
      const paidPlan = {
        plan_id: 'paid-standard',
        type: 'paid',
        price_per_pdf: 0.01,
      };

      const user = {
        user_id: userId,
        credits_balance: 0.01, // Exactly equal (should pass because check is < not <=)
      };

      mockGetItem.mockResolvedValue(user);

      const result = await checkCredits(userId, paidPlan, 0.01);

      expect(result.allowed).toBe(true);
      expect(result.error).toBeNull();
      expect(result.currentBalance).toBe(0.01);
    });

    it('should reject when credits_balance is undefined (defaults to 0)', async () => {
      const userId = 'test-user-id';
      const paidPlan = {
        plan_id: 'paid-standard',
        type: 'paid',
        price_per_pdf: 0.01,
      };

      const user = {
        user_id: userId,
        // credits_balance is undefined
      };

      mockGetItem.mockResolvedValue(user);

      const result = await checkCredits(userId, paidPlan, 0.01);

      expect(result.allowed).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error.statusCode).toBe(403);
      expect(result.currentBalance).toBe(0);
    });
  });

  describe('Paid Plan Users - Sufficient Credits', () => {
    it('should allow when credits_balance is greater than costPerPdf', async () => {
      const userId = 'test-user-id';
      const paidPlan = {
        plan_id: 'paid-standard',
        type: 'paid',
        price_per_pdf: 0.01,
      };

      const user = {
        user_id: userId,
        credits_balance: 0.10,
      };

      mockGetItem.mockResolvedValue(user);

      const result = await checkCredits(userId, paidPlan, 0.01);

      expect(result.allowed).toBe(true);
      expect(result.error).toBeNull();
      expect(result.currentBalance).toBe(0.10);
    });

    it('should allow when credits_balance is slightly greater than costPerPdf', async () => {
      const userId = 'test-user-id';
      const paidPlan = {
        plan_id: 'paid-standard',
        type: 'paid',
        price_per_pdf: 0.01,
      };

      const user = {
        user_id: userId,
        credits_balance: 0.0101, // Just slightly more
      };

      mockGetItem.mockResolvedValue(user);

      const result = await checkCredits(userId, paidPlan, 0.01);

      expect(result.allowed).toBe(true);
      expect(result.error).toBeNull();
      expect(result.currentBalance).toBe(0.0101);
    });

    it('should handle different costPerPdf values', async () => {
      const userId = 'test-user-id';
      const paidPlan = {
        plan_id: 'paid-premium',
        type: 'paid',
        price_per_pdf: 0.05,
      };

      const user = {
        user_id: userId,
        credits_balance: 0.10,
      };

      mockGetItem.mockResolvedValue(user);

      const result = await checkCredits(userId, paidPlan, 0.05);

      expect(result.allowed).toBe(true);
      expect(result.error).toBeNull();
      expect(result.currentBalance).toBe(0.10);
    });
  });

  describe('Edge Cases', () => {
    it('should handle errors gracefully without throwing (fail open)', async () => {
      const userId = 'test-user-id';
      const paidPlan = {
        plan_id: 'paid-standard',
        type: 'paid',
        price_per_pdf: 0.01,
      };

      mockGetItem.mockRejectedValue(new Error('Database error'));

      const result = await checkCredits(userId, paidPlan, 0.01);

      // Should fail open (allow request)
      expect(result.allowed).toBe(true);
      expect(result.error).toBeNull();
      expect(result.currentBalance).toBeNull();
    });

    it('should handle user with null credits_balance', async () => {
      const userId = 'test-user-id';
      const paidPlan = {
        plan_id: 'paid-standard',
        type: 'paid',
        price_per_pdf: 0.01,
      };

      const user = {
        user_id: userId,
        credits_balance: null,
      };

      mockGetItem.mockResolvedValue(user);

      const result = await checkCredits(userId, paidPlan, 0.01);

      expect(result.allowed).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.currentBalance).toBe(0); // null defaults to 0
    });

    it('should handle user with undefined free_credits_remaining', async () => {
      const userId = 'test-user-id';
      const paidPlan = {
        plan_id: 'paid-standard',
        type: 'paid',
        price_per_pdf: 0.01,
        free_credits: 100,
      };

      const user = {
        user_id: userId,
        // free_credits_remaining is undefined
        credits_balance: 0.10,
      };

      mockGetItem.mockResolvedValue(user);

      const result = await checkCredits(userId, paidPlan, 0.01);

      expect(result.allowed).toBe(true);
      expect(result.error).toBeNull();
      expect(result.currentBalance).toBe(0.10);
    });
  });
});
