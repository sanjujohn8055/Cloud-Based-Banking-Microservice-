# Banking Microservice Makefile

.PHONY: help install build up down logs clean test deploy-k8s

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Targets:'
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-15s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install dependencies for all services
	@echo "Installing dependencies..."
	@cd services/api-gateway && npm install
	@cd services/user-service && npm install
	@cd services/account-service && npm install
	@echo "Dependencies installed!"

build: ## Build Docker images for all services
	@echo "Building Docker images..."
	@chmod +x scripts/build-images.sh
	@./scripts/build-images.sh

up: ## Start all services with Docker Compose
	@echo "Starting services..."
	@docker-compose up -d
	@echo "Services started! API Gateway available at http://localhost:3000"

down: ## Stop all services
	@echo "Stopping services..."
	@docker-compose down

logs: ## Show logs from all services
	@docker-compose logs -f

clean: ## Clean up Docker containers and images
	@echo "Cleaning up..."
	@docker-compose down -v
	@docker system prune -f

test: ## Run tests (placeholder)
	@echo "Running tests..."
	@echo "Tests not implemented yet"

deploy-k8s: build ## Deploy to Kubernetes
	@echo "Deploying to Kubernetes..."
	@chmod +x scripts/deploy-k8s.sh
	@./scripts/deploy-k8s.sh

dev: ## Start development environment
	@echo "Starting development environment..."
	@docker-compose -f docker-compose.yml up -d postgres redis rabbitmq
	@echo "Infrastructure started. Run services individually with 'npm run dev' in each service directory."

status: ## Check service status
	@echo "Service Status:"
	@docker-compose ps