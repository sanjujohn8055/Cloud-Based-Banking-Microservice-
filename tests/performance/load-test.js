const autocannon = require('autocannon');
const { Pool } = require('pg');

// Load test configuration
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const DURATION = 30; // seconds
const CONNECTIONS = 10;
const PIPELINING = 1;

// Test user credentials
const TEST_USER = {
  email: 'loadtest@example.com',
  password: 'loadtestpassword123',
  firstName: 'Load',
  lastName: 'Test'
};

async function setupTestUser() {
  console.log('Setting up test user...');
  
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'banking_users',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'password'
  });

  try {
    // Clean up existing test user
    await pool.query('DELETE FROM users WHERE email = $1', [TEST_USER.email]);
    
    // Register test user
    const response = await fetch(`${API_BASE_URL}/api/users/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(TEST_USER)
    });

    if (!response.ok) {
      throw new Error(`Failed to register test user: ${response.statusText}`);
    }

    // Login to get token
    const loginResponse = await fetch(`${API_BASE_URL}/api/users/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: TEST_USER.email,
        password: TEST_USER.password
      })
    });

    if (!loginResponse.ok) {
      throw new Error(`Failed to login test user: ${loginResponse.statusText}`);
    }

    const loginData = await loginResponse.json();
    return loginData.token;
  } finally {
    await pool.end();
  }
}

async function runLoadTest(endpoint, options = {}) {
  console.log(`\n🚀 Running load test for ${endpoint}`);
  console.log(`Duration: ${DURATION}s, Connections: ${CONNECTIONS}, Pipelining: ${PIPELINING}`);
  
  const result = await autocannon({
    url: `${API_BASE_URL}${endpoint}`,
    connections: CONNECTIONS,
    pipelining: PIPELINING,
    duration: DURATION,
    ...options
  });

  console.log(`\n📊 Results for ${endpoint}:`);
  console.log(`Average Latency: ${result.latency.average}ms`);
  console.log(`Requests/sec: ${result.requests.average}`);
  console.log(`Throughput: ${result.throughput.average} bytes/sec`);
  console.log(`Total Requests: ${result.requests.total}`);
  console.log(`2xx responses: ${result['2xx']}`);
  console.log(`4xx responses: ${result['4xx']}`);
  console.log(`5xx responses: ${result['5xx']}`);
  
  return result;
}

async function main() {
  console.log('🔧 Banking Microservice Load Testing');
  console.log('=====================================');

  try {
    // Setup test user and get auth token
    const authToken = await setupTestUser();
    console.log('✅ Test user setup complete');

    // Test 1: Health check endpoint
    await runLoadTest('/health');

    // Test 2: User login endpoint
    await runLoadTest('/api/users/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: TEST_USER.email,
        password: TEST_USER.password
      })
    });

    // Test 3: Get user profile (authenticated)
    await runLoadTest('/api/users/profile', {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });

    // Test 4: Get user accounts (authenticated)
    await runLoadTest('/api/accounts', {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });

    // Test 5: Create account (authenticated)
    await runLoadTest('/api/accounts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        accountType: 'checking',
        initialDeposit: 100
      })
    });

    console.log('\n✅ Load testing completed successfully!');

  } catch (error) {
    console.error('❌ Load testing failed:', error.message);
    process.exit(1);
  }
}

// Performance thresholds
const PERFORMANCE_THRESHOLDS = {
  maxLatency: 1000, // ms
  minThroughput: 100, // requests/sec
  maxErrorRate: 0.01 // 1%
};

function validatePerformance(results) {
  const issues = [];

  if (results.latency.average > PERFORMANCE_THRESHOLDS.maxLatency) {
    issues.push(`High latency: ${results.latency.average}ms > ${PERFORMANCE_THRESHOLDS.maxLatency}ms`);
  }

  if (results.requests.average < PERFORMANCE_THRESHOLDS.minThroughput) {
    issues.push(`Low throughput: ${results.requests.average} < ${PERFORMANCE_THRESHOLDS.minThroughput} req/s`);
  }

  const errorRate = (results['4xx'] + results['5xx']) / results.requests.total;
  if (errorRate > PERFORMANCE_THRESHOLDS.maxErrorRate) {
    issues.push(`High error rate: ${(errorRate * 100).toFixed(2)}% > ${PERFORMANCE_THRESHOLDS.maxErrorRate * 100}%`);
  }

  return issues;
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { runLoadTest, validatePerformance };