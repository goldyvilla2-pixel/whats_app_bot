import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode';
import express from 'express';

// 1. Setup Supabase
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// 2. Setup Express for QR Code (Cloud Access)
const app = express();
const port = process.env.PORT || 3000;
let lastQr = '';

app.get('/', (req, res) => {
    if (!lastQr) {
        res.send('<h1>QR Code not generated yet. Please wait...</h1><script>setTimeout(() => location.reload(), 2000)</script>');
        return;
    }
    qrcode.toDataURL(lastQr, (err, url) => {
        res.send(`
            <div style="text-align:center; font-family:sans-serif; margin-top:50px;">
                <h1>Scan to Link Bot</h1>
                <p>Open WhatsApp on your phone > Linked Devices > Link a Device</p>
                <img src="${url}" style="border:10px solid #eee; padding:10px; border-radius:10px;" />
                <p style="color: grey;">Status: Waiting for scan...</p>
                <script>setTimeout(() => location.reload(), 5000)</script>
            </div>
        `);
    });
});

app.listen(port, () => {
    console.log(`🔗 QR Code available at: http://localhost:${port}`);
});

// 3. Initialize WhatsApp Client
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './session' }),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        executablePath: '/usr/bin/google-chrome-stable',
        headless: true
    }
});

client.on('qr', (qr) => {
    console.log('⚡ New QR Code generated. Scan in browser.');
    lastQr = qr;
});

client.on('ready', () => {
    console.log('✅ Bot is connected and ready!');
    lastQr = ''; // Clear QR on success
});

client.on('authenticated', () => {
    console.log('🔓 Authenticated successfully.');
});

// 4. Message Handler
client.on('message', async (msg) => {
    const chat = await msg.getChat();
    const body = msg.body.toLowerCase().trim();

    // LOG GROUP ID FOR USER SETUP (Helps find the ID to lock the bot)
    if (chat.isGroup) {
        console.log(`💬 Message in Group: "${chat.name}" | ID: ${msg.from}`);
    }

    // Security: Only respond in a specific group if ID is provided
    const allowedGroup = process.env.ALLOWED_GROUP_ID;
    if (allowedGroup && msg.from !== allowedGroup) {
        return; 
    }

    // Trigger Menu
    if (body === 'report' || body === '/report') {
        const menuMessage = 
            `📊 *OPERATIONS COMMAND CENTER*\n\n` +
            `Which report would you like to see for today?\n\n` +
            `1️⃣ *Today Summary* (Net Snapshot)\n` +
            `2️⃣ *P&L Report* (Brand Wise)\n` +
            `3️⃣ *Marketing* (Brand Spend)\n` +
            `4️⃣ *Salaries* (Monthly Paid)\n` +
            `5️⃣ *Vendor Balances* (Owed/Receivable)\n\n` +
            `_Type the number to generate report._`;
        
        await client.sendMessage(msg.chat.id, menuMessage);
        return;
    }

    // Handle Selection
    const optionsMap = {
        '1': 'rep_daily',
        '2': 'rep_pnl',
        '3': 'rep_mkt',
        '4': 'rep_sal',
        '5': 'rep_ven'
    };

    if (optionsMap[body]) {
        const reportType = optionsMap[body];
        
        try {
            await client.sendMessage(msg.chat.id, '⏳ _Generating your report..._');

            // Call the SQL Function in Supabase
            const { data, error } = await supabase.rpc('get_bot_report_content', {
                report_type: reportType
            });

            if (error) throw error;

            await client.sendMessage(msg.chat.id, data || '❌ No data found for this report.');
        } catch (err) {
            console.error('Bot Error:', err);
            await client.sendMessage(msg.chat.id, '❌ Error fetching data. Please check Supabase logs.');
        }
    }
});

client.initialize();
