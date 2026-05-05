#!/bin/bash
# ============================================================
# NepalgGig — Fresh Contabo VPS Setup (Ubuntu 22.04)
# Run ONCE as root: bash scripts/setup-vps.sh
# ============================================================

set -euo pipefail

echo "🇳🇵 NepalgGig VPS Initial Setup"
echo "================================="

# ── System update ────────────────────────────────────────
echo "📦 Updating system..."
apt update && apt upgrade -y

# ── Install Docker ───────────────────────────────────────
echo "🐳 Installing Docker..."
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker

# ── Install Nginx ────────────────────────────────────────
echo "🌐 Installing Nginx..."
apt install -y nginx certbot python3-certbot-nginx

# ── Install Node.js 20 ───────────────────────────────────
echo "📗 Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# ── Install PM2 ──────────────────────────────────────────
npm install -g pm2
pm2 startup systemd

# ── Firewall setup ───────────────────────────────────────
echo "🔒 Configuring UFW firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# ── Create app user ──────────────────────────────────────
echo "👤 Creating app user..."
id -u nepalgig &>/dev/null || useradd -m -s /bin/bash nepalgig
usermod -aG docker nepalgig

# ── Nginx config ─────────────────────────────────────────
echo "⚙️  Setting up Nginx..."
cp nginx/nepalgig.conf /etc/nginx/sites-available/nepalgig.conf
ln -sf /etc/nginx/sites-available/nepalgig.conf /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# ── SSL (Let's Encrypt) ──────────────────────────────────
echo "🔐 Setting up SSL..."
echo "Run this after DNS points to this server:"
echo "  certbot --nginx -d nepalgig.com -d www.nepalgig.com --email admin@nepalgig.com --agree-tos"

# ── Set up app directory ─────────────────────────────────
mkdir -p /var/www/nepalgig
chown -R nepalgig:nepalgig /var/www/nepalgig

echo ""
echo "✅ VPS setup complete!"
echo ""
echo "Next steps:"
echo "  1. Point DNS to this VPS IP"
echo "  2. Run: certbot --nginx -d nepalgig.com -d www.nepalgig.com"
echo "  3. Clone repo to /var/www/nepalgig"
echo "  4. Copy .env.example to .env and fill in values"
echo "  5. Run: bash scripts/deploy.sh"
