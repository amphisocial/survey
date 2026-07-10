# Athena Survey

AI-powered live polls and surveys for `survey.athenabot.ai`.

## What is included

Phases 1-13 of the web-based MVP:

1. Marketing homepage with AI positioning
2. Google OAuth registration/login
3. Postgres data model
4. Survey dashboard and list
5. Create survey manually or with AI
6. Single choice, multi-select, and tag-cloud questions
7. Survey/question activation, inactivation, completion, and closing
8. Public survey and question links
9. QR code generation/regeneration/unshare
10. Live results with Socket.IO
11. Email send via SMTP config from `.env`
12. Stripe Basic/Pro/Enterprise subscription wiring
13. Enterprise org admin and global app admin pages

Platform-native chat adapters are intentionally deferred.

## Local setup

```bash
cp .env.example .env
npm install
createdb surveydb
psql "$DATABASE_URL" -f db/schema.sql
npm run dev
```

Visit `http://localhost:3010`.

## Production setup: survey.athenabot.ai

### 1. Clone

```bash
sudo mkdir -p /opt/apps/survey
sudo chown -R $USER:$USER /opt/apps/survey
cd /opt/apps/survey
git clone https://github.com/amphisocial/survey.git .
```

Or copy this package into `/opt/apps/survey`.

### 2. Install

```bash
cd /opt/apps/survey
npm install
```

### 3. Postgres

```bash
sudo -u postgres psql
```

```sql
CREATE USER survey_user WITH PASSWORD 'REPLACE_WITH_STRONG_PASSWORD';
CREATE DATABASE surveydb OWNER survey_user;
GRANT ALL PRIVILEGES ON DATABASE surveydb TO survey_user;
\q
```

```bash
psql "postgres://survey_user:REPLACE_WITH_STRONG_PASSWORD@127.0.0.1:5432/surveydb" -f db/schema.sql
```

### 4. Environment

```bash
cp .env.example .env
nano .env
chmod 600 .env
```

Minimum production values:

```bash
NODE_ENV=production
PORT=3010
APP_BASE_URL=https://survey.athenabot.ai
DATABASE_URL=postgres://survey_user:REPLACE_WITH_STRONG_PASSWORD@127.0.0.1:5432/surveydb
SESSION_SECRET=REPLACE_WITH_LONG_RANDOM_SECRET
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
SMTP_HOST=...
SMTP_USER=...
SMTP_PASS=...
CONTACT_FORM_TO=anu@threadwire.ai
APP_ADMIN_EMAILS=anuranjanm@gmail.com,anu@threadwire.ai
```

Set AI and Stripe variables when ready.

### 5. Google OAuth

Authorized redirect URI:

```text
https://survey.athenabot.ai/auth/google/callback
```

### 6. PM2

```bash
cd /opt/apps/survey
pm2 start server/server.js --name survey
pm2 save
pm2 status
```

Or:

```bash
pm2 start ecosystem.config.js --only survey
pm2 save
```

### 7. Nginx

Create `/etc/nginx/sites-available/survey.athenabot.ai`:

```nginx
server {
    listen 80;
    server_name survey.athenabot.ai;

    location / {
        proxy_pass http://127.0.0.1:3010;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Enable and reload:

```bash
sudo ln -s /etc/nginx/sites-available/survey.athenabot.ai /etc/nginx/sites-enabled/survey.athenabot.ai
sudo nginx -t
sudo systemctl reload nginx
```

### 8. SSL

```bash
sudo certbot --nginx -d survey.athenabot.ai
```

### 9. Verify

```bash
curl https://survey.athenabot.ai/api/health
pm2 logs survey
```

Expected:

```json
{"status":"ok","app":"athena-survey"}
```

## Notes

- `ENABLE_FREE_BASIC=true` lets Basic creation work without Stripe during MVP testing. Set it to `false` when you want to require paid checkout.
- SMTP providers may reject a user email as the actual `From` address unless that sender/domain is verified. The code sets `replyTo` to the user email as a fallback-friendly pattern.
- Public participants do not need accounts.
