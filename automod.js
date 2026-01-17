// automod.js - Gelişmiş Otomatik Moderasyon Sistemi
const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');

class AutoModSystem {
    constructor(client, db) {
        this.client = client;
        this.db = db;
        
        // Küfür/Argo kelimeleri (örnek liste - genişletilebilir)
        this.profanityList = [
            'amk', 'amq', 'aq', 'orospu', 'piç', 'sik', 'yarrak', 
            'göt', 'am', 'fuck', 'shit', 'bitch', 'damn'
        ];
        
        // Zalgo karakterleri (unicode spam)
        this.zalgoPattern = /[\u0300-\u036f\u0489]/g;
        
        // Mesaj geçmişi (duplicate detection için)
        this.messageHistory = new Map(); // guild_id-user_id -> [messages]
        
        this.setupListeners();
    }

    setupListeners() {
        this.client.on('messageCreate', async (message) => {
            await this.checkMessage(message);
        });
        
        this.client.on('messageUpdate', async (oldMessage, newMessage) => {
            if (newMessage.content !== oldMessage.content) {
                await this.checkMessage(newMessage);
            }
        });
    }

    async checkMessage(message) {
        // Botları ve DM'leri atla
        if (message.author.bot || !message.guild) return;
        
        const settings = this.getGuildSettings(message.guild.id);
        
        // AutoMod kapalıysa veya whitelist'te ise atla
        if (!settings.automod_enabled) return;
        if (settings.whitelist?.includes(message.author.id)) return;
        
        // Admin yetkisi varsa atla
        const member = message.member;
        if (member?.permissions.has(PermissionFlagsBits.Administrator)) return;

        const violations = [];
        
        // 1. Küfür/Argo Kontrolü
        if (settings.profanity_filter) {
            const profanityCheck = this.checkProfanity(message.content);
            if (profanityCheck.found) {
                violations.push({
                    type: 'profanity',
                    severity: 8,
                    reason: `Küfür/argo tespit edildi: ${profanityCheck.words.join(', ')}`,
                    words: profanityCheck.words
                });
            }
        }
        
        // 2. CAPS LOCK Spam Kontrolü
        if (settings.caps_filter) {
            const capsCheck = this.checkCaps(message.content, settings.caps_threshold);
            if (capsCheck.isSpam) {
                violations.push({
                    type: 'caps_spam',
                    severity: 5,
                    reason: `Aşırı büyük harf kullanımı: %${capsCheck.percentage}`,
                    percentage: capsCheck.percentage
                });
            }
        }
        
        // 3. Emoji Spam Kontrolü
        if (settings.emoji_spam_limit) {
            const emojiCheck = this.checkEmojiSpam(message.content, settings.emoji_spam_limit);
            if (emojiCheck.isSpam) {
                violations.push({
                    type: 'emoji_spam',
                    severity: 6,
                    reason: `Aşırı emoji kullanımı: ${emojiCheck.count} emoji`,
                    count: emojiCheck.count
                });
            }
        }
        
        // 4. Mention Spam Kontrolü
        if (settings.mention_spam_limit) {
            const mentionCheck = this.checkMentionSpam(message, settings.mention_spam_limit);
            if (mentionCheck.isSpam) {
                violations.push({
                    type: 'mention_spam',
                    severity: 9,
                    reason: `Aşırı mention: ${mentionCheck.count} kişi`,
                    count: mentionCheck.count
                });
            }
        }
        
        // 5. Duplicate Mesaj Kontrolü
        if (settings.duplicate_message_limit) {
            const duplicateCheck = this.checkDuplicateMessages(message, settings.duplicate_message_limit);
            if (duplicateCheck.isDuplicate) {
                violations.push({
                    type: 'duplicate_spam',
                    severity: 7,
                    reason: `Aynı mesaj ${duplicateCheck.count} kez gönderildi`,
                    count: duplicateCheck.count
                });
            }
        }
        
        // 6. Zalgo Text Kontrolü
        if (settings.zalgo_filter) {
            const zalgoCheck = this.checkZalgo(message.content);
            if (zalgoCheck.isZalgo) {
                violations.push({
                    type: 'zalgo_spam',
                    severity: 8,
                    reason: 'Zalgo/Unicode spam tespit edildi',
                    charCount: zalgoCheck.charCount
                });
            }
        }
        
        // 7. Token/Şifre Leak Kontrolü (güvenlik)
        const sensitiveCheck = this.checkSensitiveInfo(message.content);
        if (sensitiveCheck.found) {
            violations.push({
                type: 'sensitive_info',
                severity: 10,
                reason: `Hassas bilgi tespit edildi: ${sensitiveCheck.type}`,
                infoType: sensitiveCheck.type
            });
        }

        // İhlal varsa işlem yap
        if (violations.length > 0) {
            await this.handleViolations(message, violations, settings);
        }
    }

    // ========================================
    // Kontrol Fonksiyonları
    // ========================================

    checkProfanity(content) {
        const words = content.toLowerCase().split(/\s+/);
        const foundWords = [];
        
        for (const word of words) {
            // Tam eşleşme
            if (this.profanityList.includes(word)) {
                foundWords.push(word);
                continue;
            }
            
            // Karakter değiştirme (örn: "amk" -> "4mk", "a_m_k")
            const normalized = word.replace(/[^a-z]/g, '');
            if (this.profanityList.some(bad => normalized.includes(bad))) {
                foundWords.push(word);
            }
        }
        
        return {
            found: foundWords.length > 0,
            words: [...new Set(foundWords)]
        };
    }

    checkCaps(content, threshold) {
        // Çok kısa mesajları atla
        if (content.length < 10) return { isSpam: false, percentage: 0 };
        
        const upperCount = (content.match(/[A-Z]/g) || []).length;
        const letterCount = (content.match(/[A-Za-z]/g) || []).length;
        
        if (letterCount === 0) return { isSpam: false, percentage: 0 };
        
        const percentage = Math.round((upperCount / letterCount) * 100);
        
        return {
            isSpam: percentage >= threshold,
            percentage
        };
    }

    checkEmojiSpam(content, limit) {
        // Discord emoji pattern: <:name:id> veya <a:name:id>
        const customEmojis = (content.match(/<a?:\w+:\d+>/g) || []).length;
        
        // Unicode emoji pattern (basitleştirilmiş)
        const unicodeEmojis = (content.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu) || []).length;
        
        const totalEmojis = customEmojis + unicodeEmojis;
        
        return {
            isSpam: totalEmojis > limit,
            count: totalEmojis
        };
    }

    checkMentionSpam(message, limit) {
        const mentions = message.mentions.users.size + message.mentions.roles.size;
        const hasEveryone = message.mentions.everyone;
        
        return {
            isSpam: mentions > limit || hasEveryone,
            count: mentions,
            hasEveryone
        };
    }

    checkDuplicateMessages(message, limit) {
        const key = `${message.guild.id}-${message.author.id}`;
        
        if (!this.messageHistory.has(key)) {
            this.messageHistory.set(key, []);
        }
        
        const history = this.messageHistory.get(key);
        const now = Date.now();
        
        // Eski mesajları temizle (son 60 saniye)
        const recentMessages = history.filter(msg => now - msg.timestamp < 60000);
        
        // Aynı içeriğe sahip mesajları say
        const sameContent = recentMessages.filter(msg => msg.content === message.content).length;
        
        // Yeni mesajı ekle
        recentMessages.push({
            content: message.content,
            timestamp: now
        });
        
        this.messageHistory.set(key, recentMessages);
        
        return {
            isDuplicate: sameContent >= limit,
            count: sameContent + 1
        };
    }

    checkZalgo(content) {
        const zalgoChars = content.match(this.zalgoPattern) || [];
        
        return {
            isZalgo: zalgoChars.length > 5,
            charCount: zalgoChars.length
        };
    }

    checkSensitiveInfo(content) {
        // Discord token pattern
        const tokenPattern = /[MN][A-Za-z\d]{23}\.[\w-]{6}\.[\w-]{27}/;
        if (tokenPattern.test(content)) {
            return { found: true, type: 'Discord Token' };
        }
        
        // Kredi kartı pattern (basitleştirilmiş)
        const cardPattern = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/;
        if (cardPattern.test(content)) {
            return { found: true, type: 'Kredi Kartı' };
        }
        
        // Email pattern (basit)
        const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
        const passwordKeywords = ['password', 'şifre', 'pass:', 'pw:'];
        if (emailPattern.test(content) && passwordKeywords.some(kw => content.toLowerCase().includes(kw))) {
            return { found: true, type: 'Email/Şifre' };
        }
        
        return { found: false };
    }

    // ========================================
    // İhlal İşleme
    // ========================================

    async handleViolations(message, violations, settings) {
        try {
            // En yüksek severity'yi bul
            const maxSeverity = Math.max(...violations.map(v => v.severity));
            const violationTypes = violations.map(v => v.type).join(', ');
            const reasons = violations.map(v => v.reason).join(' | ');
            
            // Mesajı sil
            await message.delete().catch(() => {});
            
            // Kullanıcıya uyarı gönder
            const warningEmbed = new EmbedBuilder()
                .setColor(maxSeverity >= 8 ? 0xFF0000 : 0xFFA500)
                .setTitle('⚠️ Otomatik Moderasyon')
                .setDescription(`${message.author}, mesajınız otomatik moderasyon tarafından silindi!`)
                .addFields(
                    { name: '📋 İhlal Tipi', value: violationTypes, inline: true },
                    { name: '📊 Ciddiyet', value: `${maxSeverity}/10`, inline: true },
                    { name: '📝 Sebep', value: reasons }
                )
                .setFooter({ text: 'Kuralları okumayı unutmayın!' })
                .setTimestamp();

            const warnMsg = await message.channel.send({ embeds: [warningEmbed] });
            
            // 10 saniye sonra uyarı mesajını sil
            setTimeout(() => warnMsg.delete().catch(() => {}), 10000);

            // Loglama
            await this.logAutoMod(message, violations, maxSeverity, settings);
            
            // İstatistikleri güncelle
            this.updateStats(message.guild.id, 'automod_triggers');
            
            // Ciddi ihlallerde otomatik ceza
            if (maxSeverity >= 9) {
                const member = message.member;
                if (member && !member.permissions.has(PermissionFlagsBits.Administrator)) {
                    // Timeout uygula
                    await member.timeout(300000, `AutoMod: ${reasons}`).catch(() => {});
                    console.log(`⏱️ TIMEOUT (AutoMod): ${message.author.tag} - ${reasons}`);
                }
            }

        } catch (error) {
            console.error('AutoMod handle error:', error);
        }
    }

    async logAutoMod(message, violations, severity, settings) {
        // Database'e kaydet
        this.db.run(`
            INSERT INTO automod_logs (guild_id, user_id, channel_id, type, content, action, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
            message.guild.id,
            message.author.id,
            message.channel.id,
            violations.map(v => v.type).join(','),
            message.content.substring(0, 500),
            severity >= 9 ? 'timeout' : 'delete',
            Date.now()
        ]);

        // Log kanalına bildir
        if (!settings.log_channel) return;

        const logChannel = message.guild.channels.cache.get(settings.log_channel);
        if (!logChannel) return;

        const embed = new EmbedBuilder()
            .setColor(severity >= 8 ? 0xFF0000 : 0xFFA500)
            .setTitle('🤖 Otomatik Moderasyon Tetiklendi')
            .addFields(
                { name: '👤 Kullanıcı', value: `${message.author.tag} (${message.author.id})`, inline: true },
                { name: '📍 Kanal', value: `${message.channel}`, inline: true },
                { name: '📊 Ciddiyet', value: `${severity}/10`, inline: true }
            )
            .setTimestamp();

        violations.forEach((v, i) => {
            embed.addFields({
                name: `⚠️ İhlal ${i + 1}: ${v.type}`,
                value: v.reason
            });
        });

        if (message.content.length > 0) {
            embed.addFields({
                name: '📄 Mesaj İçeriği',
                value: `\`\`\`${message.content.substring(0, 200)}${message.content.length > 200 ? '...' : ''}\`\`\``
            });
        }

        await logChannel.send({ embeds: [embed] });
    }

    updateStats(guildId, statType) {
        const stats = this.db.get('SELECT * FROM stats WHERE guild_id = ?', [guildId]);
        
        if (!stats) {
            this.db.run('INSERT INTO stats (guild_id, automod_triggers) VALUES (?, 1)', [guildId]);
        } else {
            this.db.run(`UPDATE stats SET ${statType} = ${statType} + 1 WHERE guild_id = ?`, [guildId]);
        }
    }

    getGuildSettings(guildId) {
        let settings = this.db.get('SELECT * FROM guild_settings WHERE guild_id = ?', [guildId]);
        
        if (!settings) {
            this.db.run('INSERT INTO guild_settings (guild_id) VALUES (?)', [guildId]);
            settings = this.db.get('SELECT * FROM guild_settings WHERE guild_id = ?', [guildId]);
        }

        return {
            automod_enabled: settings.automod_enabled ?? 1,
            profanity_filter: settings.profanity_filter ?? 1,
            caps_filter: settings.caps_filter ?? 1,
            caps_threshold: settings.caps_threshold ?? 70,
            emoji_spam_limit: settings.emoji_spam_limit ?? 10,
            mention_spam_limit: settings.mention_spam_limit ?? 5,
            duplicate_message_limit: settings.duplicate_message_limit ?? 3,
            zalgo_filter: settings.zalgo_filter ?? 1,
            whitelist: JSON.parse(settings.whitelist || '[]'),
            log_channel: settings.log_channel,
            ...settings
        };
    }

    // Küfür listesine kelime ekle
    addProfanity(word) {
        if (!this.profanityList.includes(word.toLowerCase())) {
            this.profanityList.push(word.toLowerCase());
            return true;
        }
        return false;
    }

    // Küfür listesinden kelime çıkar
    removeProfanity(word) {
        const index = this.profanityList.indexOf(word.toLowerCase());
        if (index > -1) {
            this.profanityList.splice(index, 1);
            return true;
        }
        return false;
    }

    // Küfür listesini getir
    getProfanityList() {
        return [...this.profanityList];
    }

    // Mesaj geçmişini temizle (memory leak önleme)
    clearHistory() {
        this.messageHistory.clear();
    }
}

module.exports = AutoModSystem;