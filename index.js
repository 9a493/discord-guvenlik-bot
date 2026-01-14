require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits, AuditLogEvent, PermissionFlagsBits } = require('discord.js');

// Express web server
const app = express();
const PORT = process.env.PORT || 3000;

// Bot client oluştur
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.MessageContent
    ]
});

// Kullanıcı ihlal kayıtları
const userViolations = new Map();

// İhlal seviyeleri ve cezalar (milisaniye cinsinden)
const VIOLATION_PENALTIES = {
    1: { duration: 60000, type: 'timeout', label: '1 dakika timeout' },
    2: { duration: 3600000, type: 'timeout', label: '1 saat timeout' },
    3: { duration: null, type: 'kick', label: 'sunucudan atılma' }
};

// Spam tespiti için ayarlar
const SPAM_SETTINGS = {
    messageThreshold: 5,
    timeWindow: 5000,
    resetAfter: 300000
};

// Ses kanalı kötüye kullanım ayarları
const VOICE_ABUSE_SETTINGS = {
    actionThreshold: 3,
    timeWindow: 10000,
    resetAfter: 300000
};

// Kullanıcı mesaj geçmişi (spam tespiti için)
const userMessages = new Map();

// Kullanıcı ses eylem geçmişi
const userVoiceActions = new Map();

client.once('ready', () => {
    console.log(`✅ Bot aktif: ${client.user.tag}`);
    console.log(`🔒 Güvenlik sistemi çalışıyor...`);
    console.log(`📊 ${client.guilds.cache.size} sunucuda aktif`);
    
    setInterval(cleanupOldRecords, 300000);
});

// Mesaj spam kontrolü
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;

    const userId = message.author.id;
    const guildId = message.guild.id;
    const key = `${guildId}-${userId}`;
    const now = Date.now();

    if (!userMessages.has(key)) {
        userMessages.set(key, []);
    }

    const messages = userMessages.get(key);
    messages.push(now);

    const recentMessages = messages.filter(time => now - time < SPAM_SETTINGS.timeWindow);
    userMessages.set(key, recentMessages);

    if (recentMessages.length >= SPAM_SETTINGS.messageThreshold) {
        console.log(`⚠️ SPAM TESPİT EDİLDİ: ${message.author.tag} (${userId})`);
        await handleViolation(message.guild, message.author, 'spam', 'Mesaj spamı');
        
        try {
            const channel = message.channel;
            const fetchedMessages = await channel.messages.fetch({ limit: 10 });
            const userSpamMessages = fetchedMessages.filter(m => m.author.id === userId);
            await channel.bulkDelete(userSpamMessages);
        } catch (error) {
            console.error('Mesaj silme hatası:', error);
        }
    }
});

// Audit log izleme (ses kanalı kötüye kullanımı)
client.on('voiceStateUpdate', async (oldState, newState) => {
    setTimeout(async () => {
        try {
            const auditLogs = await newState.guild.fetchAuditLogs({
                limit: 5,
                type: AuditLogEvent.MemberUpdate
            });

            const now = Date.now();
            
            for (const log of auditLogs.entries.values()) {
                const executor = log.executor;
                const target = log.target;
                
                if (!executor || executor.bot) continue;
                if (now - log.createdTimestamp > 3000) continue;

                const key = `${newState.guild.id}-${executor.id}`;
                const changes = log.changes;
                if (!changes) continue;

                const isVoiceAbuse = changes.some(change => 
                    change.key === 'mute' || 
                    change.key === 'deaf' ||
                    (change.key === 'channel_id' && change.new === null && target.id !== executor.id)
                );

                if (isVoiceAbuse) {
                    if (!userVoiceActions.has(key)) {
                        userVoiceActions.set(key, []);
                    }

                    const actions = userVoiceActions.get(key);
                    actions.push(now);

                    const recentActions = actions.filter(time => now - time < VOICE_ABUSE_SETTINGS.timeWindow);
                    userVoiceActions.set(key, recentActions);

                    if (recentActions.length >= VOICE_ABUSE_SETTINGS.actionThreshold) {
                        console.log(`⚠️ SES KANALI KÖTÜYE KULLANIM: ${executor.tag} (${executor.id})`);
                        await handleViolation(newState.guild, executor, 'voice_abuse', 'Ses kanalı kötüye kullanımı');
                    }
                }
            }
        } catch (error) {
            console.error('Audit log okuma hatası:', error);
        }
    }, 1000);
});

// İhlal yönetimi
async function handleViolation(guild, user, type, reason) {
    const key = `${guild.id}-${user.id}`;
    
    if (!userViolations.has(key)) {
        userViolations.set(key, {
            count: 0,
            lastViolation: Date.now(),
            history: []
        });
    }

    const violation = userViolations.get(key);
    violation.count++;
    violation.lastViolation = Date.now();
    violation.history.push({
        type,
        reason,
        timestamp: Date.now()
    });

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return;

    if (member.permissions.has(PermissionFlagsBits.Administrator)) {
        console.log(`⚠️ UYARI: ${user.tag} yönetici olduğu için cezalandırılamadı`);
        return;
    }

    const penalty = VIOLATION_PENALTIES[Math.min(violation.count, 3)];
    
    try {
        if (penalty.type === 'timeout') {
            await member.timeout(penalty.duration, `${reason} - ${violation.count}. ihlal`);
            console.log(`⏱️ TIMEOUT: ${user.tag} → ${penalty.label}`);
            
            await sendLogMessage(guild, {
                title: '⏱️ Timeout Uygulandı',
                user: user.tag,
                userId: user.id,
                reason,
                penalty: penalty.label,
                violationCount: violation.count
            });
            
        } else if (penalty.type === 'kick') {
            await member.kick(`${reason} - ${violation.count}. ihlal (tekrarlayan)`);
            console.log(`👢 KICK: ${user.tag} → sunucudan atıldı`);
            
            await sendLogMessage(guild, {
                title: '👢 Üye Atıldı',
                user: user.tag,
                userId: user.id,
                reason,
                penalty: penalty.label,
                violationCount: violation.count
            });
            
            userViolations.delete(key);
        }
    } catch (error) {
        console.error(`Ceza uygulama hatası (${user.tag}):`, error);
    }
}

// Log mesajı gönder
async function sendLogMessage(guild, data) {
    const logChannel = guild.channels.cache.find(ch => 
        ch.name === 'security-logs' || ch.name === 'mod-logs' || ch.name === 'bot-logs'
    );

    if (logChannel && logChannel.isTextBased()) {
        const embed = {
            color: data.title.includes('Timeout') ? 0xFFA500 : 0xFF0000,
            title: data.title,
            fields: [
                { name: '👤 Kullanıcı', value: `${data.user} (${data.userId})`, inline: true },
                { name: '⚠️ Sebep', value: data.reason, inline: true },
                { name: '🔨 Ceza', value: data.penalty, inline: true },
                { name: '📊 İhlal Sayısı', value: data.violationCount.toString(), inline: true }
            ],
            timestamp: new Date().toISOString(),
            footer: { text: 'Güvenlik Botu' }
        };

        await logChannel.send({ embeds: [embed] }).catch(console.error);
    }
}

// Eski kayıtları temizle
function cleanupOldRecords() {
    const now = Date.now();
    
    for (const [key, messages] of userMessages.entries()) {
        const recent = messages.filter(time => now - time < SPAM_SETTINGS.resetAfter);
        if (recent.length === 0) {
            userMessages.delete(key);
        } else {
            userMessages.set(key, recent);
        }
    }
    
    for (const [key, actions] of userVoiceActions.entries()) {
        const recent = actions.filter(time => now - time < VOICE_ABUSE_SETTINGS.resetAfter);
        if (recent.length === 0) {
            userVoiceActions.delete(key);
        } else {
            userVoiceActions.set(key, recent);
        }
    }
    
    for (const [key, violation] of userViolations.entries()) {
        if (now - violation.lastViolation > SPAM_SETTINGS.resetAfter) {
            userViolations.delete(key);
        }
    }
    
    console.log('🧹 Eski kayıtlar temizlendi');
}

// Web dashboard
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="tr">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Discord Güvenlik Botu</title>
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: #fff;
                    padding: 20px;
                }
                .container {
                    background: rgba(255, 255, 255, 0.1);
                    backdrop-filter: blur(10px);
                    border-radius: 20px;
                    padding: 40px;
                    max-width: 600px;
                    width: 100%;
                    box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.37);
                    border: 1px solid rgba(255, 255, 255, 0.18);
                }
                h1 {
                    font-size: 2.5em;
                    margin-bottom: 10px;
                    text-align: center;
                }
                .status {
                    display: inline-block;
                    width: 12px;
                    height: 12px;
                    border-radius: 50%;
                    background: #43b581;
                    margin-right: 8px;
                    animation: pulse 2s infinite;
                }
                @keyframes pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.5; }
                }
                .card {
                    background: rgba(255, 255, 255, 0.05);
                    border-radius: 15px;
                    padding: 20px;
                    margin: 20px 0;
                }
                .stat {
                    display: flex;
                    justify-content: space-between;
                    padding: 10px 0;
                    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                }
                .stat:last-child { border-bottom: none; }
                .stat-label { opacity: 0.8; }
                .stat-value { font-weight: bold; }
                .footer {
                    text-align: center;
                    margin-top: 30px;
                    opacity: 0.7;
                    font-size: 0.9em;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🔒 Discord Güvenlik Botu</h1>
                <p style="text-align: center; opacity: 0.8; margin-bottom: 30px;">
                    <span class="status"></span>
                    Aktif ve Çalışıyor
                </p>
                
                <div class="card">
                    <h2 style="margin-bottom: 15px;">📊 İstatistikler</h2>
                    <div class="stat">
                        <span class="stat-label">🖥️ Sunucu Sayısı</span>
                        <span class="stat-value">${client.guilds.cache.size}</span>
                    </div>
                    <div class="stat">
                        <span class="stat-label">👥 Toplam Kullanıcı</span>
                        <span class="stat-value">${client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0)}</span>
                    </div>
                    <div class="stat">
                        <span class="stat-label">⏱️ Çalışma Süresi</span>
                        <span class="stat-value" id="uptime">${Math.floor(process.uptime() / 60)} dakika</span>
                    </div>
                    <div class="stat">
                        <span class="stat-label">🔧 Durum</span>
                        <span class="stat-value" style="color: #43b581;">✓ Online</span>
                    </div>
                </div>

                <div class="card">
                    <h3 style="margin-bottom: 10px;">🛡️ Güvenlik Özellikleri</h3>
                    <p style="opacity: 0.9; line-height: 1.6;">
                        ✓ Spam koruması<br>
                        ✓ Ses kanalı kötüye kullanım tespiti<br>
                        ✓ Otomatik cezalandırma sistemi<br>
                        ✓ Audit log izleme<br>
                        ✓ 7/24 aktif koruma
                    </p>
                </div>

                <div class="footer">
                    Son güncelleme: <span id="time">${new Date().toLocaleString('tr-TR')}</span>
                </div>
            </div>

            <script>
                setInterval(() => {
                    fetch('/health')
                        .then(r => r.json())
                        .then(data => {
                            document.getElementById('uptime').textContent = 
                                Math.floor(data.uptime / 60) + ' dakika';
                            document.getElementById('time').textContent = 
                                new Date().toLocaleString('tr-TR');
                        })
                        .catch(() => {});
                }, 5000);
            </script>
        </body>
        </html>
    `);
});

app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        uptime: process.uptime(),
        guilds: client.guilds.cache.size,
        users: client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0),
        timestamp: new Date()
    });
});

app.listen(PORT, () => {
    console.log(`🌐 Web dashboard çalışıyor: http://localhost:${PORT}`);
});

client.login(process.env.DISCORD_TOKEN);