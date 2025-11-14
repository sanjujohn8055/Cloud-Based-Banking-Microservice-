const request = require('supertest');
const { Pool } = require('pg');

// Test configuration
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const TEST_USER = {
  email: 'test@example.com',
  password: 'testpassword123',
  firstName: 'Test',
  lastName: 'User'
};

describe('Banking Microservice API Integration Tests', () => {
  let authToken;
  let userId;
  let accountId;

  beforeAll(async () => {
    // Setup test database connection
    const pool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'banking_test',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'password'
    });

    // Clean up test data
    await pool.query('DELETE FROM users WHERE email = $1', [TEST_USER.email]);
    await pool.end();
  });

  describe('User Management', () => {
    test('POST /api/users/register - should register a new user', async () => {
      const response = await request(API_BASE_URL)
        .post('/api/users/register')
        .send(TEST_USER)
        .expect(201);

      expect(response.body).toHaveProperty('message', 'User registered successfully');
      expect(response.body.user).toHaveProperty('email', TEST_USER.email);
      userId = response.body.user.id;
    });

    test('POST /api/users/register - should not register duplicate user', async () => {
      await request(API_BASE_URL)
        .post('/api/users/register')
        .send(TEST_USER)
        .expect(409);
    });

    test('POST /api/users/login - should login with valid credentials', async () => {
      const response = await request(API_BASE_URL)
        .post('/api/users/login')
        .send({
          email: TEST_USER.email,
          password: TEST_USER.password
        })
        .expect(200);

      expect(response.body).toHaveProperty('token');
      expect(response.body).toHaveProperty('message', 'Login successful');
      authToken = response.body.token;
    });

    test('POST /api/users/login - should reject invalid credentials', async () => {
      await request(API_BASE_URL)
        .post('/api/users/login')
        .send({
          email: TEST_USER.email,
          password: 'wrongpassword'
        })
        .expect(401);
    });

    test('GET /api/users/profile - should get user profile with valid token', async () => {
      const response = await request(API_BASE_URL)
        .get('/api/users/profile')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.user).toHaveProperty('email', TEST_USER.email);
    });

    test('GET /api/users/profile - should reject request without token', async () => {
      await request(API_BASE_URL)
        .get('/api/users/profile')
        .expect(401);
    });
  });

  describe('Account Management', () => {
    test('POST /api/accounts - should create a new account', async () => {
      const response = await request(API_BASE_URL)
        .post('/api/accounts')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          accountType: 'checking',
          initialDeposit: 1000
        })
        .expect(201);

      expect(response.body).toHaveProperty('message', 'Account created successfully');
      expect(response.body.account).toHaveProperty('accountType', 'checking');
      expect(response.body.account).toHaveProperty('balance', 1000);
      accountId = response.body.account.id;
    });

    test('GET /api/accounts - should get user accounts', async () => {
      const response = await request(API_BASE_URL)
        .get('/api/accounts')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('accounts');
      expect(Array.isArray(response.body.accounts)).toBe(true);
      expect(response.body.accounts.length).toBeGreaterThan(0);
    });

    test('GET /api/accounts/:accountId - should get specific account', async () => {
      const response = await request(API_BASE_URL)
        .get(`/api/accounts/${accountId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.account).toHaveProperty('id', accountId);
      expect(response.body.account).toHaveProperty('accountType', 'checking');
    });

    test('GET /api/accounts/:accountId/balance - should get account balance', async () => {
      const response = await request(API_BASE_URL)
        .get(`/api/accounts/${accountId}/balance`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('balance', 1000);
      expect(response.body).toHaveProperty('currency', 'USD');
    });
  });

  describe('Health Checks', () => {
    test('GET /health - API Gateway health check', async () => {
      const response = await request(API_BASE_URL)
        .get('/health')
        .expect(200);

      expect(response.body).toHaveProperty('status', 'OK');
    });
  });

  afterAll(async () => {
    // Clean up test data
    const pool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'banking_test',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'password'
    });

    await pool.query('DELETE FROM accounts WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE email = $1', [TEST_USER.email]);
    await pool.end();
  });
});