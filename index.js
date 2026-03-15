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

// START LISTENING IMMEDIATELY (Satisfies Render Health Check)
app.listen(port, '0.0.0.0', () => {
    console.log(`✅ Web Server live on port ${port}`);
});

app.get('/', (req, res) => {
    if (isConnected) {
        res.send(`
            <div style="text-align:center; font-family:sans-serif; margin-top:50px;">
                <h1 style="color: #25D366;">✅ Bot is Connected & Live!</h1>
                <p>You can now go to your WhatsApp group and type <b>"Report"</b>.</p>
                <p style="color: grey; font-size: 12px;">The bot is running 24/7 in the cloud.</p>
            </div>
        `);
        return;
    }
    
    if (!lastQr) {
        res.send('<h1>Bot is starting...</h1><p>Please wait 30-60 seconds for the QR code to appear.</p><script>setTimeout(() => location.reload(), 5000)</script>');
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
            isConnected = true;
        }
    });

    // State management for user sessions (Temporary in-memory)
    const userState = new Map();

    // 4. Message Handler
    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        const participant = msg.key.participant || remoteJid;
        
        // Handle Poll Updates (Votes)
        if (msg.message.pollUpdateMessage) {
            const pollKey = msg.message.pollUpdateMessage.pollCreationMessageKey;
            const vote = msg.message.pollUpdateMessage.vote; 
            // Note: Baileys poll handling is complex, for simplicity we listen to the 'poll' event below
            return;
        }

        const textMessage = msg.message.conversation || 
                            msg.message.extendedTextMessage?.text || 
                            '';
        const body = textMessage.toLowerCase().trim();

        // Security: Only respond in a specific group if ID is provided
        const allowedGroup = process.env.ALLOWED_GROUP_ID;
        if (allowedGroup && remoteJid !== allowedGroup) return;

        // Trigger Step 1: Date Selection
        if (body === 'report' || body === '/report') {
            const today = new Date();
            const yesterday = new Date();
            yesterday.setDate(today.getDate() - 1);

            const todayStr = today.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
            const ydayStr = yesterday.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

            await sock.sendMessage(remoteJid, {
                poll: {
                    name: "📅 Select Report Date",
                    values: [`Today (${todayStr})`, `Yesterday (${ydayStr})`],
                    selectableCount: 1
                }
            });
            return;
        }
    });

    // Handle Poll selections specifically
    sock.ev.on('messages.update', async updates => {
        for (const update of updates) {
            if (update.update.pollUpdates && update.key.remoteJid) {
                const pollUpdate = update.update.pollUpdates[0];
                const vote = pollUpdate.vote;
                if (!vote || !vote.selectedOptions) continue;

                // Simple check for which button was pressed based on index
                const selectedIndex = vote.selectedOptions[0];
                const remoteJid = update.key.remoteJid;
                
                // Get user current state
                let state = userState.get(remoteJid) || { step: 'date' };

                if (state.step === 'date') {
                    const selectedDate = selectedIndex === 0 ? 'today' : 'yesterday';
                    userState.set(remoteJid, { step: 'report', date: selectedDate });

                    await sock.sendMessage(remoteJid, {
                        poll: {
                            name: `📋 Select Report (${selectedDate.toUpperCase()})`,
                            values: ["Owner Summary", "P&L Report", "Marketing", "Salaries", "Vendor Balances"],
                            selectableCount: 1
                        }
                    });
                } 
                else if (state.step === 'report') {
                    const dateOffset = state.date === 'today' ? 0 : 1;
                    const reportOptions = ['rep_daily', 'rep_pnl', 'rep_mkt', 'rep_sal', 'rep_ven'];
                    const reportType = reportOptions[selectedIndex];
                    
                    userState.delete(remoteJid); // Reset state

                    const targetDate = new Date();
                    targetDate.setDate(targetDate.getDate() - dateOffset);
                    const formattedDate = targetDate.toISOString().split('T')[0];

                    await sock.sendMessage(remoteJid, { text: `⏳ _Generating ${reportType.replace('rep_', '')} for ${formattedDate}..._` });

                    const { data, error } = await supabase.rpc('get_bot_report_content', {
                        report_type: reportType,
                        p_date: formattedDate
                    });

                    await sock.sendMessage(remoteJid, { text: data || '❌ No data found.' });
                }
            }
        }
    });
}

connectToWhatsApp();
