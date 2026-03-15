import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import express from 'express';
import pino from 'pino';

// 1. Setup Supabase
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// 2. Setup Express for QR Code
const app = express();
const port = process.env.PORT || 3000;
let lastQr = '';

app.listen(port, '0.0.0.0', () => {
    console.log(`✅ Web Server live on port ${port}`);
});

app.get('/', (req, res) => {
    if (!lastQr) {
        res.send('<h1>Bot is starting...</h1><p>Please wait while we generate a new QR code.</p><script>setTimeout(() => location.reload(), 5000)</script>');
        return;
    }
    qrcode.toDataURL(lastQr, (err, url) => {
        res.send(`
            <div style="text-align:center; font-family:sans-serif; margin-top:50px;">
                <h1>Scan to Link Bot (Light Version)</h1>
                <p>Open WhatsApp on your phone > Linked Devices > Link a Device</p>
                <img src="${url}" style="border:10px solid #eee; padding:10px; border-radius:10px;" />
                <p style="color: grey;">Status: Waiting for scan...</p>
                <script>setTimeout(() => location.reload(), 10000)</script>
            </div>
        `);
    });
});

// 3. Initialize WhatsApp Connection (Baileys)
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('session_auth');
    const { version } = await fetchLatestBaileysVersion();

    const sock = (makeWASocket.default || makeWASocket)({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        auth: state,
        browser: ["Marketing Dashboard Bot", "Chrome", "1.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if(qr) {
            console.log('⚡ New QR Code generated.');
            lastQr = qr;
        }

        if(connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            if(shouldReconnect) {
                connectToWhatsApp();
            }
        } else if(connection === 'open') {
            console.log('✅ Bot connected successfully!');
            lastQr = '';
        }
    });

    // 4. Message Handler
    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        const textMessage = msg.message.conversation || 
                            msg.message.extendedTextMessage?.text || 
                            '';
        const body = textMessage.toLowerCase().trim();

        // LOG GROUP ID FOR USER SETUP
        const isGroup = remoteJid.endsWith('@g.us');
        if (isGroup) {
            console.log(`💬 Message in Group ID: ${remoteJid}`);
        }

        // Security: Only respond in a specific group if ID is provided
        const allowedGroup = process.env.ALLOWED_GROUP_ID;
        if (allowedGroup && remoteJid !== allowedGroup) {
            return; 
        }

        // Trigger Menu
        if (body === 'report' || body === '/report') {
            const menuMessage = 
                `📊 *OPERATIONS COMMAND CENTER (LIGHT)*\n\n` +
                `Which report would you like for today?\n\n` +
                `1️⃣ *Today Summary*\n` +
                `2️⃣ *P&L Report*\n` +
                `3️⃣ *Marketing*\n` +
                `4️⃣ *Salaries*\n` +
                `5️⃣ *Vendor Balances*\n\n` +
                `_Reply with the number to generate._`;
            
            await sock.sendMessage(remoteJid, { text: menuMessage });
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
                await sock.sendMessage(remoteJid, { text: '⏳ _Generating report..._' });

                const { data, error } = await supabase.rpc('get_bot_report_content', {
                    report_type: reportType
                });

                if (error) throw error;

                await sock.sendMessage(remoteJid, { text: data || '❌ No data found.' });
            } catch (err) {
                console.error('Bot Error:', err);
                await sock.sendMessage(remoteJid, { text: '❌ Error fetching data.' });
            }
        }
    });
}

connectToWhatsApp();
