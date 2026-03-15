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
let isConnected = false;

app.listen(port, '0.0.0.0', () => {
    console.log(`✅ Web Server live on port ${port}`);
});

app.get('/', (req, res) => {
    if (isConnected) {
        res.send(`
            <div style="text-align:center; font-family:sans-serif; margin-top:50px;">
                <h1 style="color: #25D366;">✅ Bot is Connected & Live!</h1>
                <p>You can now go to your WhatsApp group and type <b>"Report"</b>.</p>
                <script>setTimeout(() => location.reload(), 30000)</script>
            </div>
        `);
        return;
    }
    if (!lastQr) {
        res.send('<h1>Bot is starting...</h1><p>Wait 30s for QR code.</p><script>setTimeout(() => location.reload(), 5000)</script>');
        return;
    }
    qrcode.toDataURL(lastQr, (err, url) => {
        res.send(`
            <div style="text-align:center; font-family:sans-serif; margin-top:50px;">
                <h1>Scan to Link Bot</h1>
                <img src="${url}" style="border:10px solid #eee; padding:10px; border-radius:10px;" />
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
        if(qr) lastQr = qr;
        if(connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if(shouldReconnect) connectToWhatsApp();
        } else if(connection === 'open') {
            console.log('✅ Bot connected successfully!');
            lastQr = '';
            isConnected = true;
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

        // Security: Only respond in a specific group if ID is provided
        const allowedGroup = process.env.ALLOWED_GROUP_ID;
        if (allowedGroup && remoteJid !== allowedGroup) return;

        // Trigger Menu
        if (body === 'report' || body === '/report') {
            const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
            const menuMessage = 
                `📊 *OPERATIONS COMMAND CENTER*\n_Date: ${today}_\n\n` +
                `*TODAY:*\n` +
                `1️⃣ Summary\n` +
                `2️⃣ P&L Report\n` +
                `3️⃣ Marketing\n\n` +
                `*YESTERDAY:*\n` +
                `4️⃣ Summary\n` +
                `5️⃣ P&L Report\n` +
                `6️⃣ Marketing\n\n` +
                `*OTHERS:*\n` +
                `7️⃣ Salaries (Month)\n` +
                `8️⃣ Vendor Balances\n\n` +
                `_Reply with the number to get report._`;
            
            await sock.sendMessage(remoteJid, { text: menuMessage });
            return;
        }

        // Handle Map
        const optionsMap = {
            '1': { type: 'rep_daily', offset: 0 },
            '2': { type: 'rep_pnl', offset: 0 },
            '3': { type: 'rep_mkt', offset: 0 },
            '4': { type: 'rep_daily', offset: 1 },
            '5': { type: 'rep_pnl', offset: 1 },
            '6': { type: 'rep_mkt', offset: 1 },
            '7': { type: 'rep_sal', offset: 0 },
            '8': { type: 'rep_ven', offset: 0 }
        };

        if (optionsMap[body]) {
            const { type, offset } = optionsMap[body];
            
            try {
                const targetDate = new Date();
                targetDate.setDate(targetDate.getDate() - offset);
                // Adjust for local timezone YYYY-MM-DD
                const offsetDate = targetDate.toLocaleDateString('en-CA'); 

                await sock.sendMessage(remoteJid, { text: `⏳ _Generating report for ${offset === 0 ? 'Today' : 'Yesterday'} (${offsetDate})..._` });

                const { data, error } = await supabase.rpc('get_bot_report_content', {
                    report_type: type,
                    p_date: offsetDate
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
