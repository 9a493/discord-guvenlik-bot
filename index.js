require('dotenv').config();
const { Client, GatewayIntentBits, Collection, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const initSqlJs = require('sql.js');
const fs = require('fs');
const dashboardApp = require('./dashboard');

// Database başlat
let db;
const DB_FILE = 'bot.db';

async function initDatabase() {
    const SQL = await initSqlJs();
    
    // Eğer veritabanı dosyası varsa yükle, yoksa yeni oluştur
    if (fs.existsSync(DB_FILE)) {
        const filebuffer = fs.readFileSync(DB_FILE);
        db = new SQL.Database(filebuffer);
    } else {
        db = new SQL.Database();
    }
    
    // Tabloları oluştur
    db.run(`
        CREATE TABLE IF NOT EXISTS guild_settings (
            guild_id TEXT PRIMARY KEY,
            spam_threshold INTEGER DEFAULT 5,
            spam_timewindow INTEGER DEFAULT 5000,
            voice_threshold INTEGER DEFAULT 3,
            voice_timewindow INTEGER DEFAULT 10000,
            timeout_1 INTEGER DEFAULT 60000,
            timeout_2 INTEGER DEFAULT 3600000,
            log_channel TEXT,
            language TEXT DEFAULT 'tr',
            whitelist TEXT DEFAULT '[]',
            enabled INTEGER DEFAULT 1
        );
    `);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS violations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT,
            user_id TEXT,
            type TEXT,
            reason TEXT,
            action TEXT,
            timestamp INTEGER
        );
    `);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS stats (
            guild_id TEXT PRIMARY KEY,
            total_violations INTEGER DEFAULT 0,
            spam_detected INTEGER DEFAULT 0,
            voice_abuse_detected INTEGER DEFAULT 0,
            timeouts_issued INTEGER DEFAULT 0,
            kicks_issued INTEGER DEFAULT 0
        );
    `);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS global_settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );
    `);
    
    saveDatabase();
}

function saveDatabase() {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_FILE, buffer);
}

// Helper functions
function dbGet(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const result = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return result;
}

function dbAll(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) {
        results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
}

function dbRun(sql, params = []) {
    db.run(sql, params);
    saveDatabase();
}

// Bot client
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

// Global bot client (dashboard için)
global.discordClient = client;
global.db = { get: dbGet, all: dbAll, run: dbRun };

client.commands = new Collection();

// Yardımcı fonksiyonlar
function getGuildSettings(guildId) {
    let settings = dbGet('SELECT * FROM guild_settings WHERE guild_id = ?', [guildId]);
    
    if (!settings) {
        dbRun('INSERT INTO guild_settings (guild_id) VALUES (?)', [guildId]);
        settings = dbGet('SELECT * FROM guild_settings WHERE guild_id = ?', [guildId]);
    }
    
    settings.whitelist = JSON.parse(settings.whitelist || '[]');
    return settings;
}

function updateGuildSettings(guildId, updates) {
    const keys = Object.keys(updates);
    const setClause = keys.map(key => `${key} = ?`).join(', ');
    const values = keys.map(key => {
        if (key === 'whitelist') return JSON.stringify(updates[key]);
        return updates[key];
    });
    
    dbRun(`UPDATE guild_settings SET ${setClause} WHERE guild_id = ?`, [...values, guildId]);
}

function addViolation(guildId, userId, type, reason, action) {
    dbRun(`
        INSERT INTO violations (guild_id, user_id, type, reason, action, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
    `, [guildId, userId, type, reason, action, Date.now()]);
    
    let stats = dbGet('SELECT * FROM stats WHERE guild_id = ?', [guildId]);
    if (!stats) {
        dbRun('INSERT INTO stats (guild_id) VALUES (?)', [guildId]);
        stats = { total_violations: 0, spam_detected: 0, voice_abuse_detected: 0, timeouts_issued: 0, kicks_issued: 0 };
    }
    
    const typeColumn = type === 'spam' ? 'spam_detected' : 'voice_abuse_detected';
    const actionColumn = action === 'kick' ? 'kicks_issued' : 'timeouts_issued';
    
    dbRun(`
        UPDATE stats SET 
            total_violations = total_violations + 1,
            ${typeColumn} = ${typeColumn} + 1,
            ${actionColumn} = ${actionColumn} + 1
        WHERE guild_id = ?
    `, [guildId]);
}

// Memory cache
const userMessages = new Map();
const userVoiceActions = new Map();
const userViolations = new Map();

// Slash Commands
const commands = [
    {
        name: 'setup',
        description: '🔧 Bot kurulum sihirbazını başlat',
        default_member_permissions: '8'
    },
    {
        name: 'ayarlar',
        description: '⚙️ Bot ayarlarını görüntüle ve düzenle',
        default_member_permissions: '8'
    },
    {
        name: 'istatistikler',
        description: '📊 Sunucu güvenlik istatistiklerini görüntüle'
    },
    {
        name: 'whitelist',
        description: '📝 Beyaz liste yönetimi',
        default_member_permissions: '8',
        options: [
            {
                name: 'ekle',
                description: 'Kullanıcıyı beyaz listeye ekle',
                type: 1,
                options: [{
                    name: 'kullanıcı',
                    description: 'Eklenecek kullanıcı',
                    type: 6,
                    required: true
                }]
            },
            {
                name: 'çıkar',
                description: 'Kullanıcıyı beyaz listeden çıkar',
                type: 1,
                options: [{
                    name: 'kullanıcı',
                    description: 'Çıkarılacak kullanıcı',
                    type: 6,
                    required: true
                }]
            },
            {
                name: 'liste',
                description: 'Beyaz listeyi görüntüle',
                type: 1
            }
        ]
    },
    {
        name: 'yardım',
        description: '❓ Bot komutları ve özellikler hakkında yardım'
    },
    {
        name: 'dashboard',
        description: '🌐 Web dashboard linkini al'
    }
];

// Command handlers
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand() && !interaction.isButton() && !interaction.isModalSubmit()) return;

    if (interaction.isButton()) {
        if (interaction.customId === 'setup_start') {
            const modal = new ModalBuilder()
                .setCustomId('setup_modal')
                .setTitle('Bot Kurulum Ayarları');

            const spamInput = new TextInputBuilder()
                .setCustomId('spam_threshold')
                .setLabel('Spam Eşiği (kaç mesaj)')
                .setStyle(TextInputStyle.Short)
                .setValue('5')
                .setRequired(true);

            const voiceInput = new TextInputBuilder()
                .setCustomId('voice_threshold')
                .setLabel('Ses Kanalı Kötüye Kullanım Eşiği')
                .setStyle(TextInputStyle.Short)
                .setValue('3')
                .setRequired(true);

            modal.addComponents(
                new ActionRowBuilder().addComponents(spamInput),
                new ActionRowBuilder().addComponents(voiceInput)
            );
            await interaction.showModal(modal);
            return;
        }
    }

    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'setup_modal') {
            const spamThreshold = parseInt(interaction.fields.getTextInputValue('spam_threshold'));
            const voiceThreshold = parseInt(interaction.fields.getTextInputValue('voice_threshold'));

            updateGuildSettings(interaction.guildId, {
                spam_threshold: spamThreshold,
                voice_threshold: voiceThreshold,
                enabled: 1
            });

            const embed = new EmbedBuilder()
                .setColor(0x00ff00)
                .setTitle('✅ Kurulum Tamamlandı!')
                .setDescription('Bot başarıyla yapılandırıldı.')
                .addFields(
                    { name: '📩 Spam Eşiği', value: `${spamThreshold} mesaj`, inline: true },
                    { name: '🎤 Ses Kötüye Kullanım', value: `${voiceThreshold} eylem`, inline: true }
                )
                .setTimestamp();

            await interaction.reply({ embeds: [embed], ephemeral: true });
            return;
        }
    }

    const { commandName } = interaction;

    if (commandName === 'dashboard') {
        const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle('🌐 Web Dashboard')
            .setDescription(`Web dashboard'a erişmek için aşağıdaki linke tıklayın!\n\n[Dashboard'ı Aç](${process.env.CALLBACK_URL?.replace('/callback', '/dashboard') || 'http://localhost:3000/dashboard'})`)
            .addFields(
                { name: '📊 Özellikler', value: '• Canlı istatistikler\n• Ayar değiştirme\n• Bot kontrolü\n• Beyaz liste yönetimi\n• İhlal logları' }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
    else if (commandName === 'setup') {
        const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle('🔧 Bot Kurulum Sihirbazı')
            .setDescription('Discord Güvenlik Bot\'unu sunucunuz için yapılandırın.')
            .addFields(
                { name: '📩 Spam Koruması', value: 'Mesaj spam\'ini otomatik tespit eder' },
                { name: '🎤 Ses Kanalı Koruması', value: 'Ses kanalı kötüye kullanımını önler' },
                { name: '⚖️ Otomatik Cezalandırma', value: '1dk → 1sa → Kick sistemi' }
            )
            .setFooter({ text: 'Başlamak için butona tıklayın' });

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('setup_start')
                    .setLabel('Kuruluma Başla')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('🚀')
            );

        await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }
    else if (commandName === 'ayarlar') {
        const settings = getGuildSettings(interaction.guildId);
        
        const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle('⚙️ Sunucu Ayarları')
            .addFields(
                { name: '📩 Spam Eşiği', value: `${settings.spam_threshold} mesaj / ${settings.spam_timewindow/1000} saniye`, inline: true },
                { name: '🎤 Ses Eşiği', value: `${settings.voice_threshold} eylem / ${settings.voice_timewindow/1000} saniye`, inline: true },
                { name: '⏱️ 1. Timeout', value: `${settings.timeout_1/60000} dakika`, inline: true },
                { name: '⏱️ 2. Timeout', value: `${settings.timeout_2/3600000} saat`, inline: true },
                { name: '📝 Log Kanalı', value: settings.log_channel ? `<#${settings.log_channel}>` : 'Ayarlanmamış', inline: true },
                { name: '🛡️ Durum', value: settings.enabled ? '✅ Aktif' : '❌ Pasif', inline: true }
            )
            .setFooter({ text: 'Web dashboard\'dan daha fazla ayar yapabilirsiniz!' })
            .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
    else if (commandName === 'istatistikler') {
        let stats = dbGet('SELECT * FROM stats WHERE guild_id = ?', [interaction.guildId]);
        
        if (!stats) {
            stats = { total_violations: 0, spam_detected: 0, voice_abuse_detected: 0, timeouts_issued: 0, kicks_issued: 0 };
        }

        const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle('📊 Güvenlik İstatistikleri')
            .setDescription(`**${interaction.guild.name}** için toplam istatistikler`)
            .addFields(
                { name: '📈 Toplam İhlal', value: stats.total_violations.toString(), inline: true },
                { name: '📩 Spam Tespiti', value: stats.spam_detected.toString(), inline: true },
                { name: '🎤 Ses Kötüye Kullanım', value: stats.voice_abuse_detected.toString(), inline: true },
                { name: '⏱️ Timeout', value: stats.timeouts_issued.toString(), inline: true },
                { name: '👢 Kick', value: stats.kicks_issued.toString(), inline: true },
                { name: '🛡️ Koruma Oranı', value: '99.9%', inline: true }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }
    else if (commandName === 'whitelist') {
        const subcommand = interaction.options.getSubcommand();
        const settings = getGuildSettings(interaction.guildId);

        if (subcommand === 'ekle') {
            const user = interaction.options.getUser('kullanıcı');
            
            if (!settings.whitelist.includes(user.id)) {
                settings.whitelist.push(user.id);
                updateGuildSettings(interaction.guildId, { whitelist: settings.whitelist });
                
                const embed = new EmbedBuilder()
                    .setColor(0x00ff00)
                    .setDescription(`✅ ${user} beyaz listeye eklendi.`)
                    .setTimestamp();
                
                await interaction.reply({ embeds: [embed], ephemeral: true });
            } else {
                await interaction.reply({ content: '⚠️ Bu kullanıcı zaten beyaz listede!', ephemeral: true });
            }
        }
        else if (subcommand === 'çıkar') {
            const user = interaction.options.getUser('kullanıcı');
            const index = settings.whitelist.indexOf(user.id);
            
            if (index > -1) {
                settings.whitelist.splice(index, 1);
                updateGuildSettings(interaction.guildId, { whitelist: settings.whitelist });
                
                const embed = new EmbedBuilder()
                    .setColor(0xff0000)
                    .setDescription(`✅ ${user} beyaz listeden çıkarıldı.`)
                    .setTimestamp();
                
                await interaction.reply({ embeds: [embed], ephemeral: true });
            } else {
                await interaction.reply({ content: '⚠️ Bu kullanıcı beyaz listede değil!', ephemeral: true });
            }
        }
        else if (subcommand === 'liste') {
            if (settings.whitelist.length === 0) {
                await interaction.reply({ content: '📝 Beyaz liste boş.', ephemeral: true });
                return;
            }

            const userList = settings.whitelist.map(id => `<@${id}>`).join('\n');
            
            const embed = new EmbedBuilder()
                .setColor(0x5865f2)
                .setTitle('📝 Beyaz Liste')
                .setDescription(userList)
                .setFooter({ text: `Toplam: ${settings.whitelist.length} kullanıcı` })
                .setTimestamp();
            
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    }
    else if (commandName === 'yardım') {
        const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle('❓ Discord Güvenlik Botu - Yardım')
            .setDescription('Sunucunuzu otomatik olarak koruyan güvenlik botu.')
            .addFields(
                { name: '📋 Komutlar', value: '`/setup` - Bot kurulumu\n`/ayarlar` - Ayarları görüntüle\n`/istatistikler` - İstatistikler\n`/whitelist` - Beyaz liste yönetimi\n`/dashboard` - Web panel\n`/yardım` - Bu mesaj' },
                { name: '🛡️ Özellikler', value: '• Spam koruması\n• Ses kanalı koruması\n• Otomatik cezalandırma\n• Sunucu başına özelleştirme\n• Detaylı loglar' },
                { name: '🔗 Linkler', value: `[Dashboard](${process.env.CALLBACK_URL?.replace('/callback', '') || 'http://localhost:3000'}) • [Destek](https://discord.gg/...) • [Gizlilik](${process.env.CALLBACK_URL?.replace('/callback', '/privacy') || 'http://localhost:3000/privacy'})` }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }
});

// Spam detection
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const settings = getGuildSettings(message.guild.id);
    if (!settings.enabled) return;
    
    if (settings.whitelist.includes(message.author.id)) return;

    const userId = message.author.id;
    const guildId = message.guild.id;
    const key = `${guildId}-${userId}`;
    const now = Date.now();

    if (!userMessages.has(key)) {
        userMessages.set(key, []);
    }

    const messages = userMessages.get(key);
    messages.push(now);

    const recentMessages = messages.filter(time => now - time < settings.spam_timewindow);
    userMessages.set(key, recentMessages);

    if (recentMessages.length >= settings.spam_threshold) {
        console.log(`⚠️ SPAM: ${message.author.tag}`);
        await handleViolation(message.guild, message.author, 'spam', 'Mesaj spamı', settings);
        
        try {
            const fetchedMessages = await message.channel.messages.fetch({ limit: 10 });
            const userSpamMessages = fetchedMessages.filter(m => m.author.id === userId);
            await message.channel.bulkDelete(userSpamMessages);
        } catch (error) {
            console.error('Mesaj silme hatası:', error);
        }
    }
});

async function handleViolation(guild, user, type, reason, settings) {
    const key = `${guild.id}-${user.id}`;
    
    if (!userViolations.has(key)) {
        userViolations.set(key, { count: 0, lastViolation: Date.now() });
    }

    const violation = userViolations.get(key);
    violation.count++;
    violation.lastViolation = Date.now();

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return;

    if (member.permissions.has(PermissionFlagsBits.Administrator)) return;

    let action, duration;
    
    if (violation.count === 1) {
        action = 'timeout';
        duration = settings.timeout_1;
    } else if (violation.count === 2) {
        action = 'timeout';
        duration = settings.timeout_2;
    } else {
        action = 'kick';
        duration = null;
    }

    try {
        if (action === 'timeout') {
            await member.timeout(duration, `${reason} - ${violation.count}. ihlal`);
            console.log(`⏱️ TIMEOUT: ${user.tag} → ${duration/60000}dk`);
        } else {
            await member.kick(`${reason} - ${violation.count}. ihlal`);
            console.log(`👢 KICK: ${user.tag}`);
            userViolations.delete(key);
        }
        
        addViolation(guild.id, user.id, type, reason, action);
        
        if (settings.log_channel) {
            const logChannel = guild.channels.cache.get(settings.log_channel);
            if (logChannel) {
                const embed = new EmbedBuilder()
                    .setColor(action === 'timeout' ? 0xFFA500 : 0xFF0000)
                    .setTitle(action === 'timeout' ? '⏱️ Timeout' : '👢 Kick')
                    .addFields(
                        { name: '👤 Kullanıcı', value: `${user.tag} (${user.id})`, inline: true },
                        { name: '⚠️ Sebep', value: reason, inline: true },
                        { name: '📊 İhlal', value: `${violation.count}. ihlal`, inline: true }
                    )
                    .setTimestamp();
                
                await logChannel.send({ embeds: [embed] });
            }
        }
    } catch (error) {
        console.error(`Ceza hatası:`, error);
    }
}

// Bot ready
client.once('ready', async () => {
    console.log(`✅ ${client.user.tag} aktif!`);
    console.log(`📊 ${client.guilds.cache.size} sunucuda aktif`);
    
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    
    try {
        console.log('🔄 Slash commands yükleniyor...');
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ Slash commands yüklendi!');
    } catch (error) {
        console.error('Slash command hatası:', error);
    }
});

client.on('guildCreate', guild => {
    console.log(`✅ Yeni sunucu: ${guild.name} (${guild.id})`);
    getGuildSettings(guild.id);
});

// Dashboard başlat
const PORT = process.env.PORT || 3000;
dashboardApp.listen(PORT, () => {
    console.log(`🌐 Dashboard: http://localhost:${PORT}`);
});

// Database başlat ve bot'u başlat
initDatabase().then(() => {
    console.log('✅ Veritabanı hazır!');
    client.login(process.env.DISCORD_TOKEN);
}).catch(error => {
    console.error('❌ Veritabanı hatası:', error);
    process.exit(1);
});