const TokenManager = require('../../src/auth/tokenManager');
const storage = require('../../src/config/storage');

describe('TokenManager', () => {
  beforeEach(() => {
    storage.clear();
  });

  test('should persist and retrieve token', () => {
    const token = 'test-token-123';
    TokenManager.setToken(token);
    expect(TokenManager.getToken()).toBe(token);
  });

  test('should clear token', () => {
    TokenManager.setToken('temp-token');
    TokenManager.clearToken();
    expect(TokenManager.getToken()).toBeUndefined();
  });
});