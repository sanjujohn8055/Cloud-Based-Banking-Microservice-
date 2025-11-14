#!/bin/bash

# Deploy Banking Microservice to Kubernetes
echo "Deploying Banking Microservice to Kubernetes..."

# Create namespace
echo "Creating namespace..."
kubectl apply -f k8s/namespace.yaml

# Deploy infrastructure components
echo "Deploying PostgreSQL..."
kubectl apply -f k8s/postgres.yaml

echo "Deploying Redis..."
kubectl apply -f k8s/redis.yaml

# Wait for infrastructure to be ready
echo "Waiting for infrastructure to be ready..."
kubectl wait --for=condition=ready pod -l app=postgres -n banking-system --timeout=300s
kubectl wait --for=condition=ready pod -l app=redis -n banking-system --timeout=300s

# Deploy services
echo "Deploying User Service..."
kubectl apply -f k8s/user-service.yaml

echo "Deploying API Gateway..."
kubectl apply -f k8s/api-gateway.yaml

# Wait for services to be ready
echo "Waiting for services to be ready..."
kubectl wait --for=condition=ready pod -l app=user-service -n banking-system --timeout=300s
kubectl wait --for=condition=ready pod -l app=api-gateway -n banking-system --timeout=300s

echo "Deployment completed!"
echo ""
echo "To check the status:"
echo "kubectl get pods -n banking-system"
echo ""
echo "To get the API Gateway URL:"
echo "kubectl get service api-gateway -n banking-system"