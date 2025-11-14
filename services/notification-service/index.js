const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const amqp = require('amqplib');
const nodemailer = require('nodemailer');
const twilio = require('twilio');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');
const redis = require('redis');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3005;

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'notification-service.log' })
  ]
});

// Redis connection for storing user sessions
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});
redisClient.connect();

// Email transporter
const emailTransporter = nodemailer.createTransporter({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: process.env.SMTP_PORT || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD
  }
});

// Twilio client for SMS
const twilioClient = process.env.TWILIO_ACCOUNT_SID ? 
  twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) : null;

// RabbitMQ connection
let channel;
const connectRabbitMQ = async () => {
  try {
    const connection = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://localhost:5672');
    channel = await connection.createChannel();
    
    await channel.assertExchange('banking.events', 'topic', { durable: true });
    await channel.assertQueue('notifications', { durable: true });
    
    // Bind to all banking events
    await channel.bindQueue('notifications', 'banking.events', '#');
    
    // Start consuming messages
    channel.consume('notifications', handleBankingEvent, { noAck: false });
    
    logger.info('Connected to RabbitMQ and listening for events');
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

// WebSocket authentication middleware
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication error'));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-jwt-secret');
    socket.userId = decoded.userId;
    socket.userEmail = decoded.email;
    
    // Store user socket mapping in Redis
    await redisClient.set(`user:${decoded.userId}:socket`, socket.id);
    
    logger.info(`User ${decoded.userId} connected via WebSocket`);
    next();
  } catch (error) {
    logger.error(`WebSocket auth error: ${error.message}`);
    next(new Error('Authentication error'));
  }
});

// WebSocket connection handling
io.on('connection', (socket) => {
  logger.info(`WebSocket connected: ${socket.id} for user ${socket.userId}`);
  
  // Join user-specific room
  socket.join(`user:${socket.userId}`);
  
  // Send welcome message
  socket.emit('notification', {
    id: uuidv4(),
    type: 'system',
    title: 'Connected',
    message: 'Real-time notifications are now active',
    timestamp: new Date().toISOString()
  });

  socket.on('disconnect', async () => {
    logger.info(`WebSocket disconnected: ${socket.id} for user ${socket.userId}`);
    await redisClient.del(`user:${socket.userId}:socket`);
  });
});

// Notification templates
const notificationTemplates = {
  'transaction.created': {
    title: 'Transaction Processed',
    email: {
      subject: 'Transaction Confirmation',
      template: (data) => `
        <h2>Transaction Confirmation</h2>
        <p>A ${data.type} transaction of $${data.amount} has been processed on your account.</p>
        <p><strong>Transaction ID:</strong> ${data.transactionId}</p>
        <p><strong>Account:</strong> ${data.accountId}</p>
        <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
      `
    },
    sms: (data) => `Banking Alert: ${data.type} transaction of $${data.amount} processed. ID: ${data.transactionId}`,
    push: (data) => ({
      title: 'Transaction Processed',
      message: `${data.type} of $${data.amount} completed`,
      data: { transactionId: data.transactionId }
    })
  },
  'transfer.completed': {
    title: 'Transfer Completed',
    email: {
      subject: 'Transfer Confirmation',
      template: (data) => `
        <h2>Transfer Confirmation</h2>
        <p>Your transfer of $${data.amount} has been completed successfully.</p>
        <p><strong>Transfer ID:</strong> ${data.transferId}</p>
        <p><strong>From Account:</strong> ${data.fromAccountId}</p>
        <p><strong>To Account:</strong> ${data.toAccountId}</p>
        <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
      `
    },
    sms: (data) => `Transfer Alert: $${data.amount} transferred successfully. ID: ${data.transferId}`,
    push: (data) => ({
      title: 'Transfer Completed',
      message: `$${data.amount} transferred successfully`,
      data: { transferId: data.transferId }
    })
  },
  'payment.created': {
    title: 'Payment Initiated',
    email: {
      subject: 'Payment Confirmation',
      template: (data) => `
        <h2>Payment Initiated</h2>
        <p>Your payment of $${data.amount} has been initiated.</p>
        <p><strong>Payment ID:</strong> ${data.paymentId}</p>
        <p><strong>Status:</strong> ${data.status}</p>
        <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
      `
    },
    sms: (data) => `Payment Alert: $${data.amount} payment initiated. Status: ${data.status}`,
    push: (data) => ({
      title: 'Payment Initiated',
      message: `Payment of $${data.amount} is ${data.status}`,
      data: { paymentId: data.paymentId }
    })
  },
  'account.created': {
    title: 'New Account Created',
    email: {
      subject: 'New Account Confirmation',
      template: (data) => `
        <h2>New Account Created</h2>
        <p>Your new ${data.accountType} account has been created successfully.</p>
        <p><strong>Account Number:</strong> ${data.accountNumber}</p>
        <p><strong>Initial Balance:</strong> $${data.balance}</p>
        <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
      `
    },
    sms: (data) => `Banking Alert: New ${data.accountType} account created. Account: ${data.accountNumber}`,
    push: (data) => ({
      title: 'Account Created',
      message: `New ${data.accountType} account is ready`,
      data: { accountId: data.accountId }
    })
  }
};

// Handle banking events from RabbitMQ
const handleBankingEvent = async (msg) => {
  try {
    const event = JSON.parse(msg.content.toString());
    logger.info(`Processing event: ${event.type}`, { eventId: event.id });

    const template = notificationTemplates[event.type];
    if (!template) {
      logger.warn(`No template found for event type: ${event.type}`);
      channel.ack(msg);
      return;
    }

    // Get user information (in real app, this would be from user service)
    const userId = event.data.userId;
    if (!userId) {
      logger.warn(`No userId found in event data for event: ${event.id}`);
      channel.ack(msg);
      return;
    }

    // Send real-time notification via WebSocket
    await sendRealtimeNotification(userId, {
      id: uuidv4(),
      type: event.type,
      title: template.title,
      message: template.push(event.data).message,
      data: event.data,
      timestamp: event.timestamp
    });

    // Send email notification
    if (template.email) {
      await sendEmailNotification(userId, {
        subject: template.email.subject,
        html: template.email.template(event.data)
      });
    }

    // Send SMS notification (if enabled)
    if (template.sms && process.env.SMS_ENABLED === 'true') {
      await sendSMSNotification(userId, template.sms(event.data));
    }

    channel.ack(msg);
    logger.info(`Event processed successfully: ${event.id}`);

  } catch (error) {
    logger.error(`Error processing event: ${error.message}`);
    channel.nack(msg, false, true); // Requeue the message
  }
};

// Send real-time notification via WebSocket
const sendRealtimeNotification = async (userId, notification) => {
  try {
    io.to(`user:${userId}`).emit('notification', notification);
    
    // Store notification in Redis for offline users
    await redisClient.lpush(
      `notifications:${userId}`, 
      JSON.stringify(notification)
    );
    await redisClient.ltrim(`notifications:${userId}`, 0, 99); // Keep last 100 notifications
    
    logger.info(`Real-time notification sent to user ${userId}`);
  } catch (error) {
    logger.error(`Error sending real-time notification: ${error.message}`);
  }
};

// Send email notification
const sendEmailNotification = async (userId, emailData) => {
  try {
    // In real app, get user email from user service
    const userEmail = `user${userId}@example.com`; // Placeholder
    
    if (process.env.SMTP_USER) {
      await emailTransporter.sendMail({
        from: process.env.SMTP_USER,
        to: userEmail,
        subject: emailData.subject,
        html: emailData.html
      });
      
      logger.info(`Email notification sent to ${userEmail}`);
    } else {
      logger.info(`Email notification would be sent to ${userEmail}: ${emailData.subject}`);
    }
  } catch (error) {
    logger.error(`Error sending email notification: ${error.message}`);
  }
};

// Send SMS notification
const sendSMSNotification = async (userId, message) => {
  try {
    // In real app, get user phone from user service
    const userPhone = `+1555000${userId.toString().padStart(4, '0')}`; // Placeholder
    
    if (twilioClient && process.env.TWILIO_PHONE_NUMBER) {
      await twilioClient.messages.create({
        body: message,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: userPhone
      });
      
      logger.info(`SMS notification sent to ${userPhone}`);
    } else {
      logger.info(`SMS notification would be sent to ${userPhone}: ${message}`);
    }
  } catch (error) {
    logger.error(`Error sending SMS notification: ${error.message}`);
  }
};

// Routes
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'notification-service',
    timestamp: new Date().toISOString(),
    connectedUsers: io.engine.clientsCount
  });
});

// JWT middleware for REST endpoints
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

// Get user notifications
app.get('/notifications', authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const start = (page - 1) * limit;
    const end = start + limit - 1;

    const notifications = await redisClient.lrange(
      `notifications:${req.user.userId}`, 
      start, 
      end
    );

    const parsedNotifications = notifications.map(n => JSON.parse(n));

    res.json({
      notifications: parsedNotifications,
      page: parseInt(page),
      limit: parseInt(limit)
    });

  } catch (error) {
    logger.error(`Get notifications error: ${error.message}`);
    res.status(500).json({ error: 'Failed to retrieve notifications' });
  }
});

// Mark notification as read
app.put('/notifications/:notificationId/read', authenticateToken, async (req, res) => {
  try {
    // In a real implementation, you'd update the notification status
    logger.info(`Notification ${req.params.notificationId} marked as read by user ${req.user.userId}`);
    res.json({ message: 'Notification marked as read' });
  } catch (error) {
    logger.error(`Mark notification read error: ${error.message}`);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

// Send test notification
app.post('/test', authenticateToken, async (req, res) => {
  try {
    const testNotification = {
      id: uuidv4(),
      type: 'test',
      title: 'Test Notification',
      message: 'This is a test notification',
      timestamp: new Date().toISOString()
    };

    await sendRealtimeNotification(req.user.userId, testNotification);

    res.json({ message: 'Test notification sent' });
  } catch (error) {
    logger.error(`Test notification error: ${error.message}`);
    res.status(500).json({ error: 'Failed to send test notification' });
  }
});

// Error handler
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

server.listen(PORT, () => {
  logger.info(`Notification Service running on port ${PORT}`);
});