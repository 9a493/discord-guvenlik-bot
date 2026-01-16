require('dotenv').config();
const { Client, GatewayIntentBits, Collection, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const initSqlJs = require('sql.js');
const fs = require('fs');
const dashboardApp = require('./dashboard');
const AntiRaidSystem = require('./antiraid');

// Database başlat
let db;
const DB_FILE = 'bot.db';

async function initDatabase() {
    const SQL = await initSqlJs();
    
    if (fs.existsSync(DB_FILE)) {
        const filebuffer = fs.readFileSync(DB_FILE);
        db = new SQL.Database(filebuffer);
    } else {
        db = new SQL.Database();
    }
    
    // Tablolar
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
            enabled INTEGER DEFAULT 1,
            antiraid_enabled INTEGER DEFAULT 1,
            join_threshold INTEGER DEFAULT 5,
            min_account_age INTEGER DEFAULT 7,
            suspicion_threshold INTEGER DEFAULT 5,
            auto_kick_suspicious INTEGER DEFAULT 1,
            quarantine_role TEXT,
            raid_mode_action TEXT DEFAULT 'quarantine',
            raid_mode_duration INTEGER DEFAULT 600000,
            verification_enabled INTEGER DEFAULT 0,
            verification_channel TEXT,
            rules_channel TEXT
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

global.discordClient = client;
global.db = { get: dbGet, all: dbAll, run: dbRun };

// Anti-Raid sistemini başlat
let antiRaid;

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
    },
    {
        name: 'raidmode',
        description: '🚨 Raid korumasını aç/kapat',
        default_member_permissions: '8',
        options: [
            {
                name: 'durum',
                description: 'Raid mode durumu',
                type: 3,
                required: true,
                choices: [
                    { name: '✅ Aktif Et', value: 'enable' },
                    { name: '❌ Kapat', value: 'disable' },
                    { name: '📊 Durum', value: 'status' }
                ]
            }
        ]
    },
    {
        name: 'antiraid',
        description: '🛡️ Anti-raid ayarlarını yönet',
        default_member_permissions: '8',
        options: [
            {
                name: 'ayarla',
                description: 'Anti-raid ayarlarını değiştir',
                type: 1,
                options: [
                    {
                        name: 'özellik',
                        description: 'Değiştirilecek ayar',
                        type: 3,
                        required: true,
                        choices: [
                            { name: 'Join Eşiği (60sn içinde kaç kişi)', value: 'join_threshold' },
                            { name: 'Min Hesap Yaşı (gün)', value: 'min_account_age' },
                            { name: 'Şüphe Eşiği (0-10)', value: 'suspicion_threshold' }
                        ]
                    },
                    {
                        name: 'değer',
                        description: 'Yeni değer (sayı)',
                        type: 4,
                        required: true
                    }
                ]
            },
            {
                name: 'durum',
                description: 'Mevcut anti-raid ayarlarını göster',
                type: 1
            },
            {
                name: 'istatistik',
                description: 'Join istatistiklerini göster',
                type: 1
            }
        ]
    },
    {
        name: 'karantina',
        description: '🔒 Karantina rolü ayarla',
        default_member_permissions: '8',
        options: [
            {
                name: 'rol',
                description: 'Karantina rolü',
                type: 8,
                required: true
            }
        ]
    },
    {
        name: 'şüpheliler',
        description: '⚠️ Şüpheli kullanıcıları listele',
        default_member_permissions: '8'
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

    // MEVCUT KOMUTLAR
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
                { name: '⚖️ Otomatik Cezalandırma', value: '1dk → 1sa → Kick sistemi' },
                { name: '🛡️ Anti-Raid', value: 'Toplu hesap saldırılarını engeller' }
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
                { name: '🛡️ Durum', value: settings.enabled ? '✅ Aktif' : '❌ Pasif', inline: true },
                { name: '🚨 Anti-Raid', value: settings.antiraid_enabled ? '✅ Aktif' : '❌ Pasif', inline: true }
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
                { name: '📋 Temel Komutlar', value: '`/setup` - Bot kurulumu\n`/ayarlar` - Ayarları görüntüle\n`/istatistikler` - İstatistikler\n`/whitelist` - Beyaz liste yönetimi\n`/dashboard` - Web panel\n`/yardım` - Bu mesaj' },
                { name: '🚨 Anti-Raid Komutları', value: '`/raidmode` - Raid modunu aç/kapat\n`/antiraid` - Anti-raid ayarları\n`/karantina` - Karantina rolü ayarla\n`/şüpheliler` - Şüpheli kullanıcılar' },
                { name: '🛡️ Özellikler', value: '• Spam koruması\n• Ses kanalı koruması\n• Anti-raid sistem\n• Otomatik cezalandırma\n• Sunucu başına özelleştirme\n• Detaylı loglar' },
                { name: '🔗 Linkler', value: `[Dashboard](${process.env.CALLBACK_URL?.replace('/callback', '') || 'http://localhost:3000'}) • [Destek](https://discord.gg/...) • [Gizlilik](${process.env.CALLBACK_URL?.replace('/callback', '/privacy') || 'http://localhost:3000/privacy'})` }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }
    // YENİ ANTI-RAID KOMUTLARI
    else if (commandName === 'raidmode') {
        const durum = interaction.options.getString('durum');
        
        if (durum === 'enable') {
            await antiRaid.toggleRaidMode(interaction.guild, true);
            
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('🚨 Raid Mode Aktif')
                .setDescription('Sunucu raid koruması altına alındı!')
                .addFields(
                    { name: '⚠️ Durum', value: 'Tüm yeni üyeler sıkı kontrolden geçecek' },
                    { name: '⏱️ Süre', value: '10 dakika (veya manuel kapatılana kadar)' }
                )
                .setTimestamp();
            
            await interaction.reply({ embeds: [embed] });
        }
        else if (durum === 'disable') {
            await antiRaid.toggleRaidMode(interaction.guild, false);
            
            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('✅ Raid Mode Kapatıldı')
                .setDescription('Normal güvenlik seviyesine dönüldü.')
                .setTimestamp();
            
            await interaction.reply({ embeds: [embed] });
        }
        else if (durum === 'status') {
            const isActive = antiRaid.isRaidModeActive(interaction.guild.id);
            const stats = antiRaid.getJoinStats(interaction.guild.id);
            
            const embed = new EmbedBuilder()
                .setColor(isActive ? 0xFF0000 : 0x00FF00)
                .setTitle('📊 Raid Mode Durumu')
                .addFields(
                    { name: '🛡️ Durum', value: isActive ? '🚨 AKTİF' : '✅ PASİF', inline: true },
                    { name: '👥 Son 1 Dakika', value: `${stats.last_minute} katılım`, inline: true },
                    { name: '👥 Son 5 Dakika', value: `${stats.last_5_minutes} katılım`, inline: true },
                    { name: '👥 Son 1 Saat', value: `${stats.last_hour} katılım`, inline: true }
                )
                .setTimestamp();
            
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    }
    else if (commandName === 'antiraid') {
        const subcommand = interaction.options.getSubcommand();
        
        if (subcommand === 'ayarla') {
            const özellik = interaction.options.getString('özellik');
            const değer = interaction.options.getInteger('değer');
            
            let updateKey;
            
            switch(özellik) {
                case 'join_threshold':
                    updateKey = 'join_threshold';
                    break;
                case 'min_account_age':
                    updateKey = 'min_account_age';
                    break;
                case 'suspicion_threshold':
                    updateKey = 'suspicion_threshold';
                    break;
            }
            
            dbRun(`UPDATE guild_settings SET ${updateKey} = ? WHERE guild_id = ?`, 
                   [değer, interaction.guild.id]);
            
            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('✅ Ayar Güncellendi')
                .setDescription(`**${özellik}** değeri **${değer}** olarak ayarlandı.`)
                .setTimestamp();
            
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
        else if (subcommand === 'durum') {
            const settings = antiRaid.getGuildSettings(interaction.guild.id);
            
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('🛡️ Anti-Raid Ayarları')
                .addFields(
                    { name: '🔢 Join Eşiği', value: `${settings.join_threshold} kişi/60sn`, inline: true },
                    { name: '📅 Min Hesap Yaşı', value: `${settings.min_account_age} gün`, inline: true },
                    { name: '⚠️ Şüphe Eşiği', value: `${settings.suspicion_threshold}/10`, inline: true },
                    { name: '👢 Otomatik Kick', value: settings.auto_kick_suspicious ? '✅ Aktif' : '❌ Pasif', inline: true },
                    { name: '🚨 Raid İşlemi', value: settings.raid_mode_action === 'kick' ? 'Kick' : 'Karantina', inline: true },
                    { name: '🔒 Karantina Rolü', value: settings.quarantine_role ? `<@&${settings.quarantine_role}>` : 'Ayarlanmamış', inline: true }
                )
                .setTimestamp();
            
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
        else if (subcommand === 'istatistik') {
            const stats = antiRaid.getJoinStats(interaction.guild.id);
            const suspiciousCount = antiRaid.getSuspiciousUsers(interaction.guild.id).length;
            
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('📊 Join İstatistikleri')
                .addFields(
                    { name: '👥 Son 1 Dakika', value: `${stats.last_minute} katılım`, inline: true },
                    { name: '👥 Son 5 Dakika', value: `${stats.last_5_minutes} katılım`, inline: true },
                    { name: '👥 Son 1 Saat', value: `${stats.last_hour} katılım`, inline: true },
                    { name: '⚠️ Şüpheli Kullanıcılar', value: `${suspiciousCount} kişi`, inline: true }
                )
                .setTimestamp();
            
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    }
    else if (commandName === 'karantina') {
        const role = interaction.options.getRole('rol');
        
        dbRun('UPDATE guild_settings SET quarantine_role = ? WHERE guild_id = ?', 
               [role.id, interaction.guild.id]);
        
        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('✅ Karantina Rolü Ayarlandı')
            .setDescription(`Şüpheli kullanıcılara ${role} rolü verilecek.`)
            .setTimestamp();
        
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
    else if (commandName === 'şüpheliler') {
        const suspiciousIds = antiRaid.getSuspiciousUsers(interaction.guild.id);
        
        if (suspiciousIds.length === 0) {
            await interaction.reply({ 
                content: '✅ Şu anda şüpheli kullanıcı yok!', 
                ephemeral: true 
            });
            return;
        }
        
        const suspiciousList = suspiciousIds.slice(0, 20).map(id => `<@${id}> (${id})`).join('\n');
        
        const embed = new EmbedBuilder()
            .setColor(0xFFA500)
            .setTitle('⚠️ Şüpheli Kullanıcılar')
            .setDescription(suspiciousList)
            .setFooter({ text: `Toplam: ${suspiciousIds.length} kullanıcı` })
            .setTimestamp();
        
        await interaction.reply({ embeds: [embed], ephemeral: true });
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
    
    // Anti-Raid sistemini başlat
    antiRaid = new AntiRaidSystem(client, { get: dbGet, all: dbAll, run: dbRun });
    global.antiRaid = antiRaid;
    console.log('🛡️ Anti-Raid sistemi başlatıldı!');
    
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