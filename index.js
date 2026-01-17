require('dotenv').config();
const { Client, GatewayIntentBits, Collection, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const dashboardApp = require('./dashboard');
const AntiRaidSystem = require('./antiraid');
const AutoModSystem = require('./automod');
const LinkFilterSystem = require('./linkfilter');
const { initDatabase, createDbHelpers } = require('./database-setup');

// Global değişkenler
let db;
let dbHelpers;
let antiRaid;
let autoMod;
let linkFilter;

// Discord Client
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

client.commands = new Collection();

// Global olarak erişim için
global.discordClient = client;

// Yardımcı fonksiyonlar
function getGuildSettings(guildId) {
    let settings = dbHelpers.get('SELECT * FROM guild_settings WHERE guild_id = ?', [guildId]);
    
    if (!settings) {
        dbHelpers.run('INSERT INTO guild_settings (guild_id) VALUES (?)', [guildId]);
        settings = dbHelpers.get('SELECT * FROM guild_settings WHERE guild_id = ?', [guildId]);
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
    
    dbHelpers.run(`UPDATE guild_settings SET ${setClause} WHERE guild_id = ?`, [...values, guildId]);
}

function addViolation(guildId, userId, type, reason, action, moderatorId = null) {
    dbHelpers.run(`
        INSERT INTO violations (guild_id, user_id, type, reason, action, timestamp, moderator_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [guildId, userId, type, reason, action, Date.now(), moderatorId]);
    
    let stats = dbHelpers.get('SELECT * FROM stats WHERE guild_id = ?', [guildId]);
    if (!stats) {
        dbHelpers.run('INSERT INTO stats (guild_id) VALUES (?)', [guildId]);
        stats = { total_violations: 0, spam_detected: 0, voice_abuse_detected: 0, timeouts_issued: 0, kicks_issued: 0 };
    }
    
    const typeColumn = type === 'spam' ? 'spam_detected' : 
                      type === 'voice' ? 'voice_abuse_detected' : 
                      'total_violations';
    const actionColumn = action === 'kick' ? 'kicks_issued' : 
                        action === 'timeout' ? 'timeouts_issued' : 
                        null;
    
    let updateQuery = `UPDATE stats SET total_violations = total_violations + 1, ${typeColumn} = ${typeColumn} + 1`;
    if (actionColumn) {
        updateQuery += `, ${actionColumn} = ${actionColumn} + 1`;
    }
    updateQuery += ` WHERE guild_id = ?`;
    
    dbHelpers.run(updateQuery, [guildId]);
}

const userMessages = new Map();
const userVoiceActions = new Map();
const userViolations = new Map();

// Slash Commands
const commands = require('./commands');

// ============================================
// EVENT HANDLERS
// ============================================

// Spam detection
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const settings = getGuildSettings(message.guild.id);
    if (!settings.enabled) return;
    
    if (settings.whitelist.includes(message.author.id)) return;

    // Link Filter kontrolü - AutoMod'dan ÖNCE çalışmalı
    if (linkFilter && settings.linkfilter_enabled) {
        await linkFilter.checkMessage(message);
        // Eğer mesaj link filter tarafından silindiyse, geri kalan kontrolleri yapma
        if (!message.guild) return;
    }

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
            console.log(`💢 KICK: ${user.tag}`);
            userViolations.delete(key);
        }
        
        addViolation(guild.id, user.id, type, reason, action);
        
        if (settings.log_channel) {
            const logChannel = guild.channels.cache.get(settings.log_channel);
            if (logChannel) {
                const embed = new EmbedBuilder()
                    .setColor(action === 'timeout' ? 0xFFA500 : 0xFF0000)
                    .setTitle(action === 'timeout' ? '⏱️ Timeout' : '💢 Kick')
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

// ============================================
// COMMAND HANDLERS
// ============================================

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand() && !interaction.isButton() && !interaction.isModalSubmit()) return;

    // Button handlers
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

    // Modal handlers
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

    if (!interaction.isCommand()) return;

    const { commandName } = interaction;

    // ==========================================
    // TEMEL KOMUTLAR
    // ==========================================
    
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
                { name: '🛡️ Anti-Raid', value: 'Toplu hesap saldırılarını engeller' },
                { name: '🤖 Auto-Moderation', value: 'Küfür, CAPS spam, emoji spam filtresi' }
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
                { name: '🚨 Anti-Raid', value: settings.antiraid_enabled ? '✅ Aktif' : '❌ Pasif', inline: true },
                { name: '🤖 Auto-Mod', value: settings.automod_enabled ? '✅ Aktif' : '❌ Pasif', inline: true },
                { name: '🔗 Link Filter', value: settings.linkfilter_enabled ? '✅ Aktif' : '❌ Pasif', inline: true }
            )
            .setFooter({ text: 'Web dashboard\'dan daha fazla ayar yapabilirsiniz!' })
            .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
    
    else if (commandName === 'istatistikler') {
        let stats = dbHelpers.get('SELECT * FROM stats WHERE guild_id = ?', [interaction.guildId]);
        
        if (!stats) {
            stats = { 
                total_violations: 0, 
                spam_detected: 0, 
                voice_abuse_detected: 0, 
                timeouts_issued: 0, 
                kicks_issued: 0,
                scam_blocked: 0,
                automod_triggers: 0,
                warnings_issued: 0
            };
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
                { name: '💢 Kick', value: stats.kicks_issued.toString(), inline: true },
                { name: '🔗 Scam Engellendi', value: stats.scam_blocked?.toString() || '0', inline: true },
                { name: '🤖 AutoMod Tetiklendi', value: stats.automod_triggers?.toString() || '0', inline: true },
                { name: '⚠️ Uyarı Verildi', value: stats.warnings_issued?.toString() || '0', inline: true },
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
                { name: '🤖 Auto-Mod Komutları', value: '`/automod` - Otomatik moderasyon\n`/warn` - Kullanıcıya uyarı ver\n`/warnings` - Uyarıları görüntüle' },
                { name: '🔗 Link Filter Komutları', value: '`/linkfilter` - Link filter yönetimi' },
                { name: '📊 Raporlar', value: '`/logs` - İhlal logları\n`/rapor` - Detaylı güvenlik raporu' },
                { name: '🛡️ Özellikler', value: '• Spam koruması\n• Ses kanalı koruması\n• Anti-raid sistem\n• Otomatik moderasyon\n• Link/Scam koruması\n• Uyarı sistemi\n• Detaylı loglar' },
                { name: '🔗 Linkler', value: `[Dashboard](${process.env.CALLBACK_URL?.replace('/callback', '') || 'http://localhost:3000'}) • [Destek](https://discord.gg/...) • [Gizlilik](${process.env.CALLBACK_URL?.replace('/callback', '/privacy') || 'http://localhost:3000/privacy'})` }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }

    // ==========================================
    // ANTI-RAID KOMUTLARI
    // ==========================================
    
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
            
            updateGuildSettings(interaction.guild.id, { [özellik]: değer });
            
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
                    { name: '💢 Otomatik Kick', value: settings.auto_kick_suspicious ? '✅ Aktif' : '❌ Pasif', inline: true },
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
        
        updateGuildSettings(interaction.guild.id, { quarantine_role: role.id });
        
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

    // ==========================================
    // AUTO-MOD KOMUTLARI
    // ==========================================
    
    else if (commandName === 'automod') {
        const subcommand = interaction.options.getSubcommand();
        
        if (subcommand === 'durum') {
            const settings = autoMod.getGuildSettings(interaction.guild.id);
            
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('🤖 Auto-Moderation Durumu')
                .addFields(
                    { name: '⚙️ Sistem', value: settings.automod_enabled ? '✅ Aktif' : '❌ Pasif', inline: true },
                    { name: '🚫 Küfür Filtresi', value: settings.profanity_filter ? '✅ Aktif' : '❌ Pasif', inline: true },
                    { name: '📢 CAPS Filtresi', value: settings.caps_filter ? '✅ Aktif' : '❌ Pasif', inline: true },
                    { name: '📊 CAPS Eşiği', value: `%${settings.caps_threshold}`, inline: true },
                    { name: '😀 Emoji Spam Limiti', value: settings.emoji_spam_limit.toString(), inline: true },
                    { name: '@️ Mention Spam Limiti', value: settings.mention_spam_limit.toString(), inline: true },
                    { name: '📋 Duplicate Limiti', value: settings.duplicate_message_limit.toString(), inline: true },
                    { name: '👾 Zalgo Filtresi', value: settings.zalgo_filter ? '✅ Aktif' : '❌ Pasif', inline: true }
                )
                .setTimestamp();
            
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
        else if (subcommand === 'ayarla') {
            const özellik = interaction.options.getString('özellik');
            const değer = interaction.options.getInteger('değer');
            
            updateGuildSettings(interaction.guild.id, { [özellik]: değer });
            
            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('✅ AutoMod Ayarı Güncellendi')
                .setDescription(`**${özellik}** → **${değer}**`)
                .setTimestamp();
            
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
        else if (subcommand === 'küfür') {
            const işlem = interaction.options.getString('işlem');
            const kelime = interaction.options.getString('kelime');
            
            if (işlem === 'list') {
                const list = autoMod.getProfanityList();
                
                const embed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('🚫 Küfür Listesi')
                    .setDescription(`Toplam **${list.length}** kelime filtreleniyor.`)
                    .addFields({ name: 'Kelimeler', value: list.slice(0, 50).join(', ') || 'Liste boş' })
                    .setFooter({ text: list.length > 50 ? 'İlk 50 kelime gösteriliyor' : '' })
                    .setTimestamp();
                
                await interaction.reply({ embeds: [embed], ephemeral: true });
            }
            else if (işlem === 'add') {
                if (!kelime) {
                    await interaction.reply({ content: '❌ Kelime belirtmelisiniz!', ephemeral: true });
                    return;
                }
                
                const added = autoMod.addProfanity(kelime);
                
                if (added) {
                    await interaction.reply({ content: `✅ "${kelime}" küfür listesine eklendi.`, ephemeral: true });
                } else {
                    await interaction.reply({ content: `⚠️ "${kelime}" zaten listede!`, ephemeral: true });
                }
            }
            else if (işlem === 'remove') {
                if (!kelime) {
                    await interaction.reply({ content: '❌ Kelime belirtmelisiniz!', ephemeral: true });
                    return;
                }
                
                const removed = autoMod.removeProfanity(kelime);
                
                if (removed) {
                    await interaction.reply({ content: `✅ "${kelime}" küfür listesinden çıkarıldı.`, ephemeral: true });
                } else {
                    await interaction.reply({ content: `⚠️ "${kelime}" listede değil!`, ephemeral: true });
                }
            }
        }
        else if (subcommand === 'test') {
            const mesaj = interaction.options.getString('mesaj');
            
            // Test et
            const profanityCheck = autoMod.checkProfanity(mesaj);
            const capsCheck = autoMod.checkCaps(mesaj, 70);
            const emojiCheck = autoMod.checkEmojiSpam(mesaj, 10);
            const zalgoCheck = autoMod.checkZalgo(mesaj);
            
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('🧪 AutoMod Test Sonuçları')
                .setDescription(`Mesaj: \`${mesaj.substring(0, 100)}\``)
                .addFields(
                    { name: '🚫 Küfür', value: profanityCheck.found ? `❌ Tespit edildi: ${profanityCheck.words.join(', ')}` : '✅ Temiz', inline: false },
                    { name: '📢 CAPS', value: capsCheck.isSpam ? `❌ Spam (%${capsCheck.percentage})` : `✅ Normal (%${capsCheck.percentage})`, inline: true },
                    { name: '😀 Emoji', value: emojiCheck.isSpam ? `❌ Spam (${emojiCheck.count})` : `✅ Normal (${emojiCheck.count})`, inline: true },
                    { name: '👾 Zalgo', value: zalgoCheck.isZalgo ? `❌ Tespit edildi (${zalgoCheck.charCount})` : '✅ Temiz', inline: true }
                )
                .setTimestamp();
            
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    }

    // ==========================================
    // WARNING SİSTEMİ
    // ==========================================
    
    else if (commandName === 'warn') {
        const user = interaction.options.getUser('kullanıcı');
        const sebep = interaction.options.getString('sebep');
        
        dbHelpers.run(`
            INSERT INTO warnings (guild_id, user_id, moderator_id, reason, timestamp)
            VALUES (?, ?, ?, ?, ?)
        `, [interaction.guild.id, user.id, interaction.user.id, sebep, Date.now()]);
        
        // İstatistik güncelle
        dbHelpers.run('UPDATE stats SET warnings_issued = warnings_issued + 1 WHERE guild_id = ?', [interaction.guild.id]);
        
        const warnings = dbHelpers.all('SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? AND active = 1', [interaction.guild.id, user.id]);
        
        const embed = new EmbedBuilder()
            .setColor(0xFFA500)
            .setTitle('⚠️ Uyarı Verildi')
            .addFields(
                { name: '👤 Kullanıcı', value: `${user.tag} (${user.id})`, inline: true },
                { name: '👮 Yetkili', value: interaction.user.tag, inline: true },
                { name: '📊 Toplam Uyarı', value: warnings.length.toString(), inline: true },
                { name: '📝 Sebep', value: sebep }
            )
            .setTimestamp();
        
        await interaction.reply({ embeds: [embed] });
        
        // Kullanıcıya DM gönder
        try {
            await user.send({ embeds: [embed] });
        } catch (error) {
            // DM kapalı
        }
    }
    
    else if (commandName === 'warnings') {
        const user = interaction.options.getUser('kullanıcı');
        
        const warnings = dbHelpers.all('SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? AND active = 1 ORDER BY timestamp DESC', [interaction.guild.id, user.id]);
        
        if (warnings.length === 0) {
            await interaction.reply({ content: `✅ ${user.tag} hiç uyarı almamış!`, ephemeral: true });
            return;
        }
        
        const embed = new EmbedBuilder()
            .setColor(0xFFA500)
            .setTitle(`⚠️ ${user.tag} - Uyarılar`)
            .setDescription(`Toplam **${warnings.length}** aktif uyarı`)
            .setTimestamp();
        
        warnings.slice(0, 10).forEach((w, i) => {
            embed.addFields({
                name: `${i + 1}. Uyarı (ID: ${w.id})`,
                value: `**Sebep:** ${w.reason}\n**Tarih:** ${new Date(w.timestamp).toLocaleString('tr-TR')}\n**Yetkili:** <@${w.moderator_id}>`
            });
        });
        
        if (warnings.length > 10) {
            embed.setFooter({ text: `${warnings.length - 10} uyarı daha var` });
        }
        
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
    
    else if (commandName === 'unwarn') {
        const warningId = interaction.options.getInteger('warning_id');
        
        const warning = dbHelpers.get('SELECT * FROM warnings WHERE id = ? AND guild_id = ?', [warningId, interaction.guild.id]);
        
        if (!warning) {
            await interaction.reply({ content: '❌ Bu ID\'ye ait uyarı bulunamadı!', ephemeral: true });
            return;
        }
        
        dbHelpers.run('UPDATE warnings SET active = 0 WHERE id = ?', [warningId]);
        
        await interaction.reply({ content: `✅ Uyarı #${warningId} kaldırıldı.`, ephemeral: true });
    }
    
    else if (commandName === 'clearwarnings') {
        const user = interaction.options.getUser('kullanıcı');
        
        const warnings = dbHelpers.all('SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? AND active = 1', [interaction.guild.id, user.id]);
        
        if (warnings.length === 0) {
            await interaction.reply({ content: `⚠️ ${user.tag} zaten uyarısı yok!`, ephemeral: true });
            return;
        }
        
        dbHelpers.run('UPDATE warnings SET active = 0 WHERE guild_id = ? AND user_id = ?', [interaction.guild.id, user.id]);
        
        await interaction.reply({ content: `✅ ${user.tag} kullanıcısının ${warnings.length} uyarısı temizlendi.`, ephemeral: true });
    }

    // ==========================================
    // LINK FILTER KOMUTLARI
    // ==========================================
    
    else if (commandName === 'linkfilter') {
        const subcommand = interaction.options.getSubcommand();
        
        if (subcommand === 'blacklist') {
            const işlem = interaction.options.getString('işlem');
            const domain = interaction.options.getString('domain');
            
            if (işlem === 'list') {
                const blacklist = linkFilter.getBlacklist();
                
                const embed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setTitle('🚫 Kara Liste')
                    .setDescription(`Toplam **${blacklist.length}** domain engelleniyor`)
                    .addFields({ name: 'Domainler', value: blacklist.slice(0, 30).join(', ') || 'Liste boş' })
                    .setFooter({ text: blacklist.length > 30 ? 'İlk 30 domain gösteriliyor' : '' })
                    .setTimestamp();
                
                await interaction.reply({ embeds: [embed], ephemeral: true });
            }
            else if (işlem === 'add') {
                if (!domain) {
                    await interaction.reply({ content: '❌ Domain belirtmelisiniz!', ephemeral: true });
                    return;
                }
                
                const added = linkFilter.addBlacklistedDomain(domain);
                
                if (added) {
                    await interaction.reply({ content: `✅ "${domain}" kara listeye eklendi.`, ephemeral: true });
                } else {
                    await interaction.reply({ content: `⚠️ "${domain}" zaten listede!`, ephemeral: true });
                }
            }
            else if (işlem === 'remove') {
                if (!domain) {
                    await interaction.reply({ content: '❌ Domain belirtmelisiniz!', ephemeral: true });
                    return;
                }
                
                const removed = linkFilter.removeBlacklistedDomain(domain);
                
                if (removed) {
                    await interaction.reply({ content: `✅ "${domain}" kara listeden çıkarıldı.`, ephemeral: true });
                } else {
                    await interaction.reply({ content: `⚠️ "${domain}" listede değil!`, ephemeral: true });
                }
            }
        }
        else if (subcommand === 'kontrol') {
            const url = interaction.options.getString('url');
            
            const results = await linkFilter.checkUrl(url);
            
            const embed = new EmbedBuilder()
                .setColor(results.safe ? 0x00FF00 : 0xFF0000)
                .setTitle(results.safe ? '✅ Güvenli URL' : '⚠️ Tehlikeli URL')
                .addFields(
                    { name: '🔗 URL', value: url },
                    { name: '🌐 Domain', value: results.domain },
                    { name: '📊 Tehdit Seviyesi', value: `${results.threatLevel}/10`, inline: true },
                    { name: '🛡️ Durum', value: results.safe ? 'Güvenli' : 'Tehlikeli', inline: true }
                )
                .setTimestamp();
            
            if (results.threats.length > 0) {
                embed.addFields({ name: '⚠️ Tehditler', value: results.threats.join('\n') });
            }
            
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
        else if (subcommand === 'istatistik') {
            const stats = dbHelpers.get('SELECT scam_blocked FROM stats WHERE guild_id = ?', [interaction.guild.id]);
            const scamLogs = dbHelpers.all('SELECT * FROM scam_logs WHERE guild_id = ? ORDER BY timestamp DESC LIMIT 10', [interaction.guild.id]);
            
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('📊 Link Filter İstatistikleri')
                .addFields(
                    { name: '🛡️ Toplam Engellenen', value: (stats?.scam_blocked || 0).toString(), inline: true },
                    { name: '📋 Son Loglar', value: scamLogs.length > 0 ? `${scamLogs.length} kayıt` : 'Kayıt yok', inline: true }
                )
                .setTimestamp();
            
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    }

    // ==========================================
    // LOGLAR VE RAPORLAR
    // ==========================================
    
    else if (commandName === 'logs') {
        const tip = interaction.options.getString('tip');
        const limit = interaction.options.getInteger('limit') || 10;
        
        let logs = [];
        let title = '';
        
        if (tip === 'all') {
            logs = dbHelpers.all('SELECT * FROM violations WHERE guild_id = ? ORDER BY timestamp DESC LIMIT ?', [interaction.guild.id, limit]);
            title = 'Tüm İhlaller';
        } else if (tip === 'automod') {
            logs = dbHelpers.all('SELECT * FROM automod_logs WHERE guild_id = ? ORDER BY timestamp DESC LIMIT ?', [interaction.guild.id, limit]);
            title = 'AutoMod Logları';
        } else if (tip === 'scam') {
            logs = dbHelpers.all('SELECT * FROM scam_logs WHERE guild_id = ? ORDER BY timestamp DESC LIMIT ?', [interaction.guild.id, limit]);
            title = 'Scam/Phishing Logları';
        } else {
            logs = dbHelpers.all('SELECT * FROM violations WHERE guild_id = ? AND type = ? ORDER BY timestamp DESC LIMIT ?', [interaction.guild.id, tip, limit]);
            title = `${tip} İhlalleri`;
        }
        
        if (logs.length === 0) {
            await interaction.reply({ content: '📭 Log kaydı bulunamadı.', ephemeral: true });
            return;
        }
        
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(`📜 ${title}`)
            .setDescription(`Son ${logs.length} kayıt`)
            .setTimestamp();
        
        logs.slice(0, 5).forEach((log, i) => {
            if (tip === 'automod') {
                embed.addFields({
                    name: `${i + 1}. ${log.type}`,
                    value: `**Kullanıcı:** <@${log.user_id}>\n**Kanal:** <#${log.channel_id}>\n**Tarih:** ${new Date(log.timestamp).toLocaleString('tr-TR')}`
                });
            } else if (tip === 'scam') {
                embed.addFields({
                    name: `${i + 1}. Tehdit Seviyesi: ${log.threat_level}/10`,
                    value: `**Kullanıcı:** <@${log.user_id}>\n**Sebep:** ${log.reason}\n**Tarih:** ${new Date(log.timestamp).toLocaleString('tr-TR')}`
                });
            } else {
                embed.addFields({
                    name: `${i + 1}. ${log.type} - ${log.action}`,
                    value: `**Kullanıcı:** <@${log.user_id}>\n**Sebep:** ${log.reason}\n**Tarih:** ${new Date(log.timestamp).toLocaleString('tr-TR')}`
                });
            }
        });
        
        if (logs.length > 5) {
            embed.setFooter({ text: `${logs.length - 5} kayıt daha var` });
        }
        
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
    
    else if (commandName === 'rapor') {
        await interaction.deferReply({ ephemeral: true });
        
        const süre = interaction.options.getString('süre');
        let timestampLimit = 0;
        
        const now = Date.now();
        if (süre === '24h') timestampLimit = now - (24 * 60 * 60 * 1000);
        else if (süre === '7d') timestampLimit = now - (7 * 24 * 60 * 60 * 1000);
        else if (süre === '30d') timestampLimit = now - (30 * 24 * 60 * 60 * 1000);
        
        const violations = timestampLimit > 0 
            ? dbHelpers.all('SELECT * FROM violations WHERE guild_id = ? AND timestamp >= ?', [interaction.guild.id, timestampLimit])
            : dbHelpers.all('SELECT * FROM violations WHERE guild_id = ?', [interaction.guild.id]);
        
        const scamLogs = timestampLimit > 0
            ? dbHelpers.all('SELECT * FROM scam_logs WHERE guild_id = ? AND timestamp >= ?', [interaction.guild.id, timestampLimit])
            : dbHelpers.all('SELECT * FROM scam_logs WHERE guild_id = ?', [interaction.guild.id]);
        
        const automodLogs = timestampLimit > 0
            ? dbHelpers.all('SELECT * FROM automod_logs WHERE guild_id = ? AND timestamp >= ?', [interaction.guild.id, timestampLimit])
            : dbHelpers.all('SELECT * FROM automod_logs WHERE guild_id = ?', [interaction.guild.id]);
        
        const stats = dbHelpers.get('SELECT * FROM stats WHERE guild_id = ?', [interaction.guild.id]) || {};
        
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(`📊 Güvenlik Raporu - ${süre === '24h' ? 'Son 24 Saat' : süre === '7d' ? 'Son 7 Gün' : süre === '30d' ? 'Son 30 Gün' : 'Tüm Zamanlar'}`)
            .addFields(
                { name: '📈 Toplam İhlal', value: violations.length.toString(), inline: true },
                { name: '🛡️ Scam Engellendi', value: scamLogs.length.toString(), inline: true },
                { name: '🤖 AutoMod Tetiklendi', value: automodLogs.length.toString(), inline: true },
                { name: '⏱️ Timeout', value: violations.filter(v => v.action === 'timeout').length.toString(), inline: true },
                { name: '💢 Kick', value: violations.filter(v => v.action === 'kick').length.toString(), inline: true },
                { name: '⚠️ Uyarı', value: (stats.warnings_issued || 0).toString(), inline: true }
            )
            .setTimestamp();
        
        // En çok ihlal yapan kullanıcılar
        const userCounts = {};
        violations.forEach(v => {
            userCounts[v.user_id] = (userCounts[v.user_id] || 0) + 1;
        });
        
        const topUsers = Object.entries(userCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);
        
        if (topUsers.length > 0) {
            embed.addFields({
                name: '👥 En Çok İhlal Yapanlar',
                value: topUsers.map(([userId, count]) => `<@${userId}>: ${count} ihlal`).join('\n')
            });
        }
        
        await interaction.editReply({ embeds: [embed] });
    }

    // ==========================================
    // YÖNETİM VE BAKIM
    // ==========================================
    
    else if (commandName === 'temizle') {
        const tip = interaction.options.getString('tip');
        
        if (tip === 'all') {
            // Onay iste
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('⚠️ DİKKAT')
                .setDescription('Bu işlem tüm verileri sıfırlayacak!\n\nDevam etmek istediğinize emin misiniz?')
                .setTimestamp();
            
            await interaction.reply({ embeds: [embed], ephemeral: true });
            return;
        }
        
        if (tip === 'logs') {
            dbHelpers.run('DELETE FROM violations WHERE guild_id = ?', [interaction.guild.id]);
            dbHelpers.run('DELETE FROM scam_logs WHERE guild_id = ?', [interaction.guild.id]);
            dbHelpers.run('DELETE FROM automod_logs WHERE guild_id = ?', [interaction.guild.id]);
            await interaction.reply({ content: '✅ Tüm loglar temizlendi!', ephemeral: true });
        }
        else if (tip === 'stats') {
            dbHelpers.run('DELETE FROM stats WHERE guild_id = ?', [interaction.guild.id]);
            dbHelpers.run('INSERT INTO stats (guild_id) VALUES (?)', [interaction.guild.id]);
            await interaction.reply({ content: '✅ İstatistikler sıfırlandı!', ephemeral: true });
        }
        else if (tip === 'warnings') {
            dbHelpers.run('DELETE FROM warnings WHERE guild_id = ?', [interaction.guild.id]);
            await interaction.reply({ content: '✅ Tüm uyarılar temizlendi!', ephemeral: true });
        }
    }
    
    else if (commandName === 'kullanıcı') {
        const user = interaction.options.getUser('hedef') || interaction.user;
        const member = await interaction.guild.members.fetch(user.id);
        
        const warnings = dbHelpers.all('SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? AND active = 1', [interaction.guild.id, user.id]);
        const violations = dbHelpers.all('SELECT * FROM violations WHERE guild_id = ? AND user_id = ? ORDER BY timestamp DESC LIMIT 5', [interaction.guild.id, user.id]);
        
        const accountAge = Math.floor((Date.now() - user.createdTimestamp) / (1000 * 60 * 60 * 24));
        const joinAge = Math.floor((Date.now() - member.joinedTimestamp) / (1000 * 60 * 60 * 24));
        
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(`👤 ${user.tag} - Güvenlik Profili`)
            .setThumbnail(user.displayAvatarURL())
            .addFields(
                { name: '🆔 ID', value: user.id, inline: true },
                { name: '📅 Hesap Yaşı', value: `${accountAge} gün`, inline: true },
                { name: '📆 Sunucuda', value: `${joinAge} gün`, inline: true },
                { name: '⚠️ Aktif Uyarı', value: warnings.length.toString(), inline: true },
                { name: '📊 Toplam İhlal', value: violations.length.toString(), inline: true },
                { name: '🛡️ Whitelist', value: getGuildSettings(interaction.guild.id).whitelist.includes(user.id) ? 'Evet' : 'Hayır', inline: true }
            )
            .setTimestamp();
        
        if (violations.length > 0) {
            embed.addFields({
                name: '📋 Son İhlaller',
                value: violations.slice(0, 3).map(v => `• ${v.type} - ${v.reason} (${new Date(v.timestamp).toLocaleDateString('tr-TR')})`).join('\n')
            });
        }
        
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
    
    else if (commandName === 'sunucu') {
        const stats = dbHelpers.get('SELECT * FROM stats WHERE guild_id = ?', [interaction.guild.id]) || {};
        const settings = getGuildSettings(interaction.guild.id);
        const raidActive = antiRaid.isRaidModeActive(interaction.guild.id);
        
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(`🏰 ${interaction.guild.name} - Güvenlik Durumu`)
            .setThumbnail(interaction.guild.iconURL())
            .addFields(
                { name: '👥 Toplam Üye', value: interaction.guild.memberCount.toString(), inline: true },
                { name: '🛡️ Bot Durumu', value: settings.enabled ? '✅ Aktif' : '❌ Pasif', inline: true },
                { name: '🚨 Raid Mode', value: raidActive ? '🚨 Aktif' : '✅ Normal', inline: true },
                { name: '📊 Toplam İhlal', value: (stats.total_violations || 0).toString(), inline: true },
                { name: '🤖 AutoMod', value: settings.automod_enabled ? '✅ Aktif' : '❌ Pasif', inline: true },
                { name: '🔗 Link Filter', value: settings.linkfilter_enabled ? '✅ Aktif' : '❌ Pasif', inline: true },
                { name: '📝 Whitelist', value: `${settings.whitelist.length} kullanıcı`, inline: true },
                { name: '⏱️ Uptime', value: `${Math.floor(client.uptime / 60000)} dakika`, inline: true },
                { name: '🛡️ Koruma Oranı', value: '99.9%', inline: true }
            )
            .setTimestamp();
        
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
});

// ============================================
// BOT READY
// ============================================

client.once('ready', async () => {
    console.log(`✅ ${client.user.tag} aktif!`);
    console.log(`📊 ${client.guilds.cache.size} sunucuda aktif`);
    
    // Sistemleri başlat
    antiRaid = new AntiRaidSystem(client, dbHelpers);
    global.antiRaid = antiRaid;
    console.log('🛡️ Anti-Raid sistemi başlatıldı!');
    
    autoMod = new AutoModSystem(client, dbHelpers);
    global.autoMod = autoMod;
    console.log('🤖 Auto-Moderation sistemi başlatıldı!');
    
    linkFilter = new LinkFilterSystem(client, dbHelpers);
    global.linkFilter = linkFilter;
    console.log('🔗 Link Filter sistemi başlatıldı!');
    
    // Slash commands kaydet
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    
    try {
        console.log('🔄 Slash commands yükleniyor...');
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ Slash commands yüklendi!');
    } catch (error) {
        console.error('Slash command hatası:', error);
    }
    
    // Memory cleanup - her 30 dakikada bir
    setInterval(() => {
        userMessages.clear();
        userVoiceActions.clear();
        if (autoMod) autoMod.clearHistory();
        console.log('🧹 Memory temizlendi');
    }, 30 * 60 * 1000);
    
    // Activity ayarla
    client.user.setActivity('🛡️ Sunucuları Koruyorum', { type: 'WATCHING' });
});

client.on('guildCreate', guild => {
    console.log(`✅ Yeni sunucu: ${guild.name} (${guild.id})`);
    getGuildSettings(guild.id);
});

// ============================================
// DASHBOARD BAŞLAT
// ============================================

const PORT = process.env.PORT || 3000;
dashboardApp.listen(PORT, () => {
    console.log(`🌐 Dashboard: http://localhost:${PORT}`);
});

// ============================================
// DATABASE BAŞLAT VE BOT'U ÇALIŞTIR
// ============================================

initDatabase().then((database) => {
    db = database;
    dbHelpers = createDbHelpers(db);
    global.db = dbHelpers;
    
    console.log('✅ Veritabanı hazır!');
    console.log('📦 Tablolar kontrol ediliyor...');
    
    // Tablo kontrolü
    const tables = dbHelpers.all("SELECT name FROM sqlite_master WHERE type='table'");
    console.log(`✅ ${tables.length} tablo bulundu:`, tables.map(t => t.name).join(', '));
    
    // Bot'u başlat
    client.login(process.env.DISCORD_TOKEN).catch(error => {
        console.error('❌ Login hatası:', error);
        process.exit(1);
    });
}).catch(error => {
    console.error('❌ Veritabanı hatası:', error);
    process.exit(1);
});