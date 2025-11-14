#!/bin/bash

# Build Docker images for all services
echo "Building Docker images for Banking Microservice..."

# Build API Gateway
echo "Building API Gateway..."
docker build -t banking/api-gateway:latest ./services/api-gateway

# Build User Service
echo "Building User Service..."
docker build -t banking/user-service:latest ./services/user-service

# Build Account Service
echo "Building Account Service..."
docker build -t banking/account-service:latest ./services/account-service

# Build Transaction Service
echo "Building Transaction Service..."
docker build -t banking/transaction-service:latest ./services/transaction-service

# Build Payment Service
echo "Building Payment Service..."
docker build -t banking/payment-service:latest ./services/payment-service

# Build Notification Service
echo "Building Notification Service..."
docker build -t banking/notification-service:latest ./services/notification-service

echo "All images built successfully!"
echo ""
echo "To run the services:"
echo "docker-compose up -d"
echo ""
echo "To deploy to Kubernetes:"
echo "kubectl apply -f k8s/"