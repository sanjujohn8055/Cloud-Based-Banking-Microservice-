const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const amqp = require('amqplib');
const Joi = require('joi');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');
const Decimal = require('decimal.js');
const cron = require('node-cron');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3004;

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'payment-service.log' })
  ]
});

// Database connection
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'banking_payments',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'password'
});

// RabbitMQ connection
let channel;
const connectRabbitMQ = async () => {
  try {
    const connection = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://localhost:5672');
    channel = await connection.createChannel();
    
    await channel.assertExchange('banking.events', 'topic', { durable: true });
    await channel.assertQueue('payment.events', { durable: true });
    await channel.assertQueue('payment.processing', { durable: true });
    
    logger.info('Connected to RabbitMQ');
  } catch (error) {
    logger.error(`RabbitMQ connection error: ${error.message}`);
    setTimeout(connectRabbitMQ, 5000);
  }
};

connectRabbitMQ();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Validation schemas
const paymentSchema = Joi.object({
  fromAccountId: Joi.number().integer().positive().required(),
  toAccountId: Joi.number().integer().positive().optional(),
  amount: Joi.number().positive().precision(2).required(),
  currency: Joi.string().length(3).default('USD'),
  paymentType: Joi.string().valid('transfer', 'payment', 'bill_pay').required(),
  description: Joi.string().max(255).required(),
  scheduledAt: Joi.date().optional(),
  externalPayee: Joi.object({
    name: Joi.string().required(),
    accountNumber: Joi.string().required(),
    routingNumber: Joi.string().required(),
    bankName: Joi.string().required()
  }).optional()
});

// JWT middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'your-jwt-secret', (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};

// Event publishing
const publishEvent = async (eventType, data) => {
  if (channel) {
    const event = {
      id: uuidv4(),
      type: eventType,
      timestamp: new Date().toISOString(),
      data
    };
    
    await channel.publish('banking.events', eventType, Buffer.from(JSON.stringify(event)));
    logger.info(`Event published: ${eventType}`, { eventId: event.id });
  }
};

// External payment processor simulation
const processExternalPayment = async (paymentData) => {
  // Simulate external payment processor (Stripe, PayPal, etc.)
  const processorResponse = {
    success: Math.random() > 0.1, // 90% success rate
    transactionId: uuidv4(),
    processorFee: new Decimal(paymentData.amount).mul(0.029).plus(0.30).toNumber(), // 2.9% + $0.30
    processedAt: new Date().toISOString()
  };

  // Simulate processing delay
  await new Promise(resolve => setTimeout(resolve, 1000));

  return processorResponse;
};

// Fraud detection simulation
const detectFraud = async (paymentData, userId) => {
  // Simple fraud detection rules
  const riskFactors = [];
  
  // Large amount check
  if (paymentData.amount > 10000) {
    riskFactors.push('large_amount');
  }
  
  // Frequency check (simplified)
  const recentPayments = await pool.query(
    'SELECT COUNT(*) FROM payments WHERE from_account_id = $1 AND created_at > NOW() - INTERVAL \'1 hour\'',
    [paymentData.fromAccountId]
  );
  
  if (parseInt(recentPayments.rows[0].count) > 5) {
    riskFactors.push('high_frequency');
  }
  
  const riskScore = riskFactors.length * 25; // 0-100 scale
  
  return {
    riskScore,
    riskFactors,
    requiresReview: riskScore > 50
  };
};

// Routes
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'payment-service',
    timestamp: new Date().toISOString()
  });
});

// Create payment
app.post('/', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { error, value } = paymentSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const paymentData = value;
    const paymentId = uuidv4();

    // Verify account ownership
    const ownershipCheck = await client.query(
      'SELECT user_id FROM account_ownership WHERE account_id = $1 AND user_id = $2',
      [paymentData.fromAccountId, req.user.userId]
    );

    if (ownershipCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Account access denied' });
    }

    // Fraud detection
    const fraudCheck = await detectFraud(paymentData, req.user.userId);
    
    if (fraudCheck.requiresReview) {
      logger.warn(`Payment flagged for review: ${paymentId}`, {
        userId: req.user.userId,
        riskScore: fraudCheck.riskScore,
        riskFactors: fraudCheck.riskFactors
      });
    }

    // Determine processing time
    const isScheduled = paymentData.scheduledAt && new Date(paymentData.scheduledAt) > new Date();
    const status = isScheduled ? 'scheduled' : (fraudCheck.requiresReview ? 'pending_review' : 'processing');

    // Create payment record
    const result = await client.query(
      `INSERT INTO payments 
       (id, from_account_id, to_account_id, amount, currency, payment_type, description, 
        status, scheduled_at, external_payee, risk_score, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW()) 
       RETURNING *`,
      [
        paymentId,
        paymentData.fromAccountId,
        paymentData.toAccountId || null,
        paymentData.amount,
        paymentData.currency,
        paymentData.paymentType,
        paymentData.description,
        status,
        paymentData.scheduledAt || null,
        paymentData.externalPayee ? JSON.stringify(paymentData.externalPayee) : null,
        fraudCheck.riskScore
      ]
    );

    const payment = result.rows[0];

    await client.query('COMMIT');

    // Process immediately if not scheduled and not flagged
    if (!isScheduled && !fraudCheck.requiresReview) {
      // Queue for processing
      if (channel) {
        await channel.sendToQueue('payment.processing', Buffer.from(JSON.stringify({
          paymentId: payment.id,
          userId: req.user.userId
        })));
      }
    }

    // Publish payment event
    await publishEvent('payment.created', {
      paymentId: payment.id,
      fromAccountId: payment.from_account_id,
      toAccountId: payment.to_account_id,
      amount: parseFloat(payment.amount),
      status: payment.status,
      userId: req.user.userId
    });

    logger.info(`Payment created: ${payment.id}`, {
      userId: req.user.userId,
      amount: paymentData.amount,
      status: payment.status
    });

    res.status(201).json({
      message: 'Payment created successfully',
      payment: {
        id: payment.id,
        fromAccountId: payment.from_account_id,
        toAccountId: payment.to_account_id,
        amount: parseFloat(payment.amount),
        currency: payment.currency,
        paymentType: payment.payment_type,
        description: payment.description,
        status: payment.status,
        scheduledAt: payment.scheduled_at,
        riskScore: payment.risk_score,
        createdAt: payment.created_at
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`Payment creation error: ${error.message}`);
    res.status(500).json({ error: 'Payment creation failed' });
  } finally {
    client.release();
  }
});

// Get payment status
app.get('/:paymentId', authenticateToken, async (req, res) => {
  try {
    const { paymentId } = req.params;

    const result = await pool.query(
      `SELECT p.*, ao.user_id 
       FROM payments p 
       JOIN account_ownership ao ON p.from_account_id = ao.account_id 
       WHERE p.id = $1 AND ao.user_id = $2`,
      [paymentId, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    const payment = result.rows[0];

    res.json({
      payment: {
        id: payment.id,
        fromAccountId: payment.from_account_id,
        toAccountId: payment.to_account_id,
        amount: parseFloat(payment.amount),
        currency: payment.currency,
        paymentType: payment.payment_type,
        description: payment.description,
        status: payment.status,
        scheduledAt: payment.scheduled_at,
        processedAt: payment.processed_at,
        riskScore: payment.risk_score,
        createdAt: payment.created_at
      }
    });

  } catch (error) {
    logger.error(`Get payment error: ${error.message}`);
    res.status(500).json({ error: 'Failed to retrieve payment' });
  }
});

// Get user payments
app.get('/', authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT p.* FROM payments p 
      JOIN account_ownership ao ON p.from_account_id = ao.account_id 
      WHERE ao.user_id = $1
    `;
    const params = [req.user.userId];

    if (status) {
      query += ` AND p.status = $${params.length + 1}`;
      params.push(status);
    }

    query += ` ORDER BY p.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    const payments = result.rows.map(payment => ({
      id: payment.id,
      fromAccountId: payment.from_account_id,
      toAccountId: payment.to_account_id,
      amount: parseFloat(payment.amount),
      currency: payment.currency,
      paymentType: payment.payment_type,
      description: payment.description,
      status: payment.status,
      scheduledAt: payment.scheduled_at,
      processedAt: payment.processed_at,
      createdAt: payment.created_at
    }));

    res.json({ payments });

  } catch (error) {
    logger.error(`Get payments error: ${error.message}`);
    res.status(500).json({ error: 'Failed to retrieve payments' });
  }
});

// Cancel payment (only if not processed)
app.delete('/:paymentId', authenticateToken, async (req, res) => {
  try {
    const { paymentId } = req.params;

    const result = await pool.query(
      `UPDATE payments p 
       SET status = 'cancelled', updated_at = NOW() 
       FROM account_ownership ao 
       WHERE p.id = $1 AND p.from_account_id = ao.account_id AND ao.user_id = $2 
       AND p.status IN ('scheduled', 'pending_review') 
       RETURNING p.*`,
      [paymentId, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found or cannot be cancelled' });
    }

    const payment = result.rows[0];

    await publishEvent('payment.cancelled', {
      paymentId: payment.id,
      userId: req.user.userId
    });

    logger.info(`Payment cancelled: ${payment.id}`, { userId: req.user.userId });

    res.json({ message: 'Payment cancelled successfully' });

  } catch (error) {
    logger.error(`Cancel payment error: ${error.message}`);
    res.status(500).json({ error: 'Failed to cancel payment' });
  }
});

// Scheduled payment processor (runs every minute)
cron.schedule('* * * * *', async () => {
  try {
    const result = await pool.query(
      `SELECT * FROM payments 
       WHERE status = 'scheduled' AND scheduled_at <= NOW()`
    );

    for (const payment of result.rows) {
      if (channel) {
        await channel.sendToQueue('payment.processing', Buffer.from(JSON.stringify({
          paymentId: payment.id,
          scheduled: true
        })));
      }
    }

    if (result.rows.length > 0) {
      logger.info(`Queued ${result.rows.length} scheduled payments for processing`);
    }

  } catch (error) {
    logger.error(`Scheduled payment processing error: ${error.message}`);
  }
});

// Error handler
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  logger.info(`Payment Service running on port ${PORT}`);
});