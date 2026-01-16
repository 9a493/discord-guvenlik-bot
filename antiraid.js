// antiraid.js - Gelişmiş Anti-Raid Sistemi
const { EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');

class AntiRaidSystem {
    constructor(client, db) {
        this.client = client;
        this.db = db;
        this.joinTracker = new Map(); // guild_id -> [timestamps]
        this.suspiciousUsers = new Map(); // guild_id -> [user_ids]
        this.raidMode = new Map(); // guild_id -> boolean
        
        this.setupListeners();
    }

    setupListeners() {
        // Yeni üye katıldığında
        this.client.on('guildMemberAdd', async (member) => {
            await this.handleMemberJoin(member);
        });
    }

    async handleMemberJoin(member) {
        const guild = member.guild;
        const settings = this.getGuildSettings(guild.id);
        
        if (!settings.antiraid_enabled) return;

        const now = Date.now();
        const accountAge = now - member.user.createdTimestamp;
        const accountAgeDays = Math.floor(accountAge / (1000 * 60 * 60 * 24));
        
        // Join tracker güncelle
        if (!this.joinTracker.has(guild.id)) {
            this.joinTracker.set(guild.id, []);
        }
        
        const joins = this.joinTracker.get(guild.id);
        joins.push(now);
        
        // Eski kayıtları temizle (son 60 saniye)
        const recentJoins = joins.filter(time => now - time < 60000);
        this.joinTracker.set(guild.id, recentJoins);

        // Şüpheli kullanıcı kontrolü
        let suspicionScore = 0;
        let suspicionReasons = [];

        // 1. Yeni hesap kontrolü
        if (accountAgeDays < settings.min_account_age) {
            suspicionScore += 3;
            suspicionReasons.push(`Yeni hesap (${accountAgeDays} gün)`);
        }

        // 2. Varsayılan avatar kontrolü
        if (!member.user.avatar) {
            suspicionScore += 2;
            suspicionReasons.push('Varsayılan avatar');
        }

        // 3. Username kontrolü (random karakterler)
        if (this.hasRandomUsername(member.user.username)) {
            suspicionScore += 2;
            suspicionReasons.push('Şüpheli kullanıcı adı');
        }

        // 4. Join flood kontrolü
        if (recentJoins.length >= settings.join_threshold) {
            suspicionScore += 5;
            suspicionReasons.push(`Hızlı katılım (${recentJoins.length} kişi/${recentJoins.length} saniye)`);
            
            // Otomatik raid mode
            if (!this.raidMode.get(guild.id)) {
                await this.enableRaidMode(guild, 'auto');
            }
        }

        // Şüpheli kullanıcı işlemleri
        if (suspicionScore >= settings.suspicion_threshold) {
            await this.handleSuspiciousUser(member, suspicionScore, suspicionReasons, settings);
        }

        // Raid mode aktifse sıkı kontrol
        if (this.raidMode.get(guild.id)) {
            if (suspicionScore >= 3) {
                await this.handleRaidModeUser(member, suspicionReasons, settings);
            }
        }

        // Verification sistemi varsa yönlendir
        if (settings.verification_enabled && settings.verification_channel) {
            await this.sendToVerification(member, settings);
        }
    }

    async handleSuspiciousUser(member, score, reasons, settings) {
        const guild = member.guild;
        
        // Suspicious users listesine ekle
        if (!this.suspiciousUsers.has(guild.id)) {
            this.suspiciousUsers.set(guild.id, []);
        }
        this.suspiciousUsers.get(guild.id).push(member.id);

        // Loglama
        await this.logSuspiciousUser(member, score, reasons, settings);

        // Otomatik işlem
        if (score >= 7) {
            // Çok şüpheli - otomatik kick
            if (settings.auto_kick_suspicious) {
                try {
                    await member.kick(`Anti-Raid: Şüphe skoru ${score}/10 - ${reasons.join(', ')}`);
                    await this.logAction(guild, member, 'kick', reasons);
                } catch (error) {
                    console.error('Kick hatası:', error);
                }
            }
        } else if (score >= 5) {
            // Orta şüpheli - quarantine rol
            if (settings.quarantine_role) {
                try {
                    await member.roles.add(settings.quarantine_role);
                    await this.logAction(guild, member, 'quarantine', reasons);
                } catch (error) {
                    console.error('Quarantine hatası:', error);
                }
            }
        }
    }

    async handleRaidModeUser(member, reasons, settings) {
        // Raid mode'da tüm yeni üyeler şüpheli
        if (settings.raid_mode_action === 'kick') {
            try {
                await member.kick(`Raid Mode aktif - ${reasons.join(', ')}`);
                await this.logAction(member.guild, member, 'raid_kick', reasons);
            } catch (error) {
                console.error('Raid kick hatası:', error);
            }
        } else if (settings.raid_mode_action === 'quarantine' && settings.quarantine_role) {
            try {
                await member.roles.add(settings.quarantine_role);
                await this.logAction(member.guild, member, 'raid_quarantine', reasons);
            } catch (error) {
                console.error('Raid quarantine hatası:', error);
            }
        }
    }

    async enableRaidMode(guild, trigger = 'manual') {
        this.raidMode.set(guild.id, true);
        
        const settings = this.getGuildSettings(guild.id);
        
        // Log kanalına bildir
        if (settings.log_channel) {
            const channel = guild.channels.cache.get(settings.log_channel);
            if (channel) {
                const embed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setTitle('🚨 RAID MODE AKTİF')
                    .setDescription(`Raid koruması ${trigger === 'auto' ? 'otomatik olarak' : 'manuel olarak'} aktif edildi!`)
                    .addFields(
                        { name: '⚠️ Durum', value: 'Tüm yeni üyeler sıkı kontrolden geçiyor' },
                        { name: '🛡️ İşlem', value: settings.raid_mode_action === 'kick' ? 'Şüpheli hesaplar otomatik atılıyor' : 'Şüpheli hesaplar karantinaya alınıyor' },
                        { name: '⏱️ Süre', value: settings.raid_mode_duration ? `${settings.raid_mode_duration / 60000} dakika` : 'Manuel kapatılana kadar' }
                    )
                    .setTimestamp();
                
                await channel.send({ embeds: [embed] });
            }
        }

        // Otomatik kapanma
        if (settings.raid_mode_duration) {
            setTimeout(() => {
                this.disableRaidMode(guild, 'auto');
            }, settings.raid_mode_duration);
        }
    }

    async disableRaidMode(guild, trigger = 'manual') {
        this.raidMode.delete(guild.id);
        this.joinTracker.delete(guild.id);
        
        const settings = this.getGuildSettings(guild.id);
        
        if (settings.log_channel) {
            const channel = guild.channels.cache.get(settings.log_channel);
            if (channel) {
                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle('✅ Raid Mode Kapatıldı')
                    .setDescription(`Raid koruması ${trigger === 'auto' ? 'otomatik olarak' : 'manuel olarak'} kapatıldı.`)
                    .setTimestamp();
                
                await channel.send({ embeds: [embed] });
            }
        }
    }

    async sendToVerification(member, settings) {
        const verifyChannel = member.guild.channels.cache.get(settings.verification_channel);
        if (!verifyChannel) return;

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🔐 Hoş Geldin!')
            .setDescription(`**${member.user.username}**, sunucumuza hoş geldin!\n\nDevam etmek için aşağıdaki butona tıklayarak doğrulama yapman gerekiyor.`)
            .addFields(
                { name: '📋 Kurallar', value: settings.rules_channel ? `<#${settings.rules_channel}>` : 'Lütfen kuralları oku' },
                { name: '⏱️ Süre', value: 'Doğrulama için 5 dakikan var' }
            )
            .setThumbnail(member.user.displayAvatarURL())
            .setTimestamp();

        try {
            await verifyChannel.send({ 
                content: `${member}`, 
                embeds: [embed] 
            });
        } catch (error) {
            console.error('Verification mesaj hatası:', error);
        }
    }

    async logSuspiciousUser(member, score, reasons, settings) {
        if (!settings.log_channel) return;

        const channel = member.guild.channels.cache.get(settings.log_channel);
        if (!channel) return;

        const accountAge = Math.floor((Date.now() - member.user.createdTimestamp) / (1000 * 60 * 60 * 24));

        const embed = new EmbedBuilder()
            .setColor(score >= 7 ? 0xFF0000 : score >= 5 ? 0xFFA500 : 0xFFFF00)
            .setTitle('⚠️ Şüpheli Kullanıcı Tespit Edildi')
            .setDescription(`**${member.user.tag}** şüpheli olarak işaretlendi.`)
            .addFields(
                { name: '👤 Kullanıcı', value: `${member} (${member.id})`, inline: true },
                { name: '📊 Şüphe Skoru', value: `${score}/10`, inline: true },
                { name: '📅 Hesap Yaşı', value: `${accountAge} gün`, inline: true },
                { name: '🔍 Sebepler', value: reasons.join('\n') }
            )
            .setThumbnail(member.user.displayAvatarURL())
            .setTimestamp();

        await channel.send({ embeds: [embed] });
    }

    async logAction(guild, member, action, reasons) {
        const settings = this.getGuildSettings(guild.id);
        if (!settings.log_channel) return;

        const channel = guild.channels.cache.get(settings.log_channel);
        if (!channel) return;

        const actionTexts = {
            'kick': '👢 Kick',
            'quarantine': '🔒 Karantina',
            'raid_kick': '🚨 Raid Kick',
            'raid_quarantine': '🚨 Raid Karantina'
        };

        const embed = new EmbedBuilder()
            .setColor(action.includes('kick') ? 0xFF0000 : 0xFFA500)
            .setTitle(`${actionTexts[action]} - Anti-Raid`)
            .addFields(
                { name: '👤 Kullanıcı', value: `${member.user.tag} (${member.id})` },
                { name: '🔍 Sebep', value: reasons.join('\n') }
            )
            .setTimestamp();

        await channel.send({ embeds: [embed] });
    }

    hasRandomUsername(username) {
        // Random username tespiti (çok sayıda rakam/anlamsız karakter)
        const digitCount = (username.match(/\d/g) || []).length;
        const hasMultipleUnderscore = (username.match(/_/g) || []).length >= 3;
        const hasOnlyDigits = /^\d+$/.test(username);
        
        return digitCount > 6 || hasMultipleUnderscore || hasOnlyDigits;
    }

    getGuildSettings(guildId) {
        let settings = this.db.get('SELECT * FROM guild_settings WHERE guild_id = ?', [guildId]);
        
        if (!settings) {
            this.db.run('INSERT INTO guild_settings (guild_id) VALUES (?)', [guildId]);
            settings = this.db.get('SELECT * FROM guild_settings WHERE guild_id = ?', [guildId]);
        }

        // Default değerler
        return {
            antiraid_enabled: settings.antiraid_enabled ?? 1,
            join_threshold: settings.join_threshold ?? 5,
            min_account_age: settings.min_account_age ?? 7,
            suspicion_threshold: settings.suspicion_threshold ?? 5,
            auto_kick_suspicious: settings.auto_kick_suspicious ?? 1,
            quarantine_role: settings.quarantine_role ?? null,
            raid_mode_action: settings.raid_mode_action ?? 'quarantine',
            raid_mode_duration: settings.raid_mode_duration ?? 600000, // 10 dakika
            verification_enabled: settings.verification_enabled ?? 0,
            verification_channel: settings.verification_channel ?? null,
            rules_channel: settings.rules_channel ?? null,
            log_channel: settings.log_channel ?? null,
            ...settings
        };
    }

    // Manuel raid mode kontrolü için komut fonksiyonları
    async toggleRaidMode(guild, enable) {
        if (enable) {
            await this.enableRaidMode(guild, 'manual');
        } else {
            await this.disableRaidMode(guild, 'manual');
        }
    }

    isRaidModeActive(guildId) {
        return this.raidMode.get(guildId) || false;
    }

    getSuspiciousUsers(guildId) {
        return this.suspiciousUsers.get(guildId) || [];
    }

    getJoinStats(guildId) {
        const joins = this.joinTracker.get(guildId) || [];
        const now = Date.now();
        
        return {
            last_minute: joins.filter(t => now - t < 60000).length,
            last_5_minutes: joins.filter(t => now - t < 300000).length,
            last_hour: joins.filter(t => now - t < 3600000).length
        };
    }
}

module.exports = AntiRaidSystem;