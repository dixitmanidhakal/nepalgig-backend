#!/bin/bash
# ============================================================
# NepalgGig — VPS Deploy Script (Contabo)
# Run: bash scripts/deploy.sh
# ============================================================

set -euo pipefail

echo "🇳🇵 NepalgGig Deployment Script"
echo "================================="

# ── 1. Check required env ────────────────────────────────
if [ ! -f ".env" ]; then
  echo "❌ .env file not found. Copy .env.example to .env and configure."
  exit 1
fi
source .env

# ── 2. Pull latest code ──────────────────────────────────
echo "📦 Pulling latest code..."
git pull origin main

# ── 3. Build Docker images ───────────────────────────────
echo "🐳 Building Docker images..."
docker compose -f docker/docker-compose.yml build --no-cache

# ── 4. Run DB migrations ─────────────────────────────────
echo "🗄️  Running database migrations..."
docker compose -f docker/docker-compose.yml run --rm app npm run db:migrate

# ── 5. Start services ────────────────────────────────────
echo "🚀 Starting services..."
docker compose -f docker/docker-compose.yml up -d

# ── 6. Health check ──────────────────────────────────────
echo "⏳ Waiting for app to be healthy..."
sleep 10
STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/health)
if [ "$STATUS" = "200" ]; then
  echo "✅ App is healthy! (HTTP $STATUS)"
else
  echo "❌ Health check failed (HTTP $STATUS)"
  docker compose -f docker/docker-compose.yml logs app --tail=50
  exit 1
fi

echo ""
echo "🎉 Deployment complete!"
echo "   App:      https://nepalgig.com"
echo "   Health:   http://localhost:3000/api/health"
