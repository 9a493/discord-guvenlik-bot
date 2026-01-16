// linkfilter.js - Gelişmiş Link ve Scam Koruması
const { EmbedBuilder } = require('discord.js');

class LinkFilterSystem {
    constructor(client, db) {
        this.client = client;
        this.db = db;
        
        // Kara liste - Bilinen scam/phishing domainleri
        this.blacklistedDomains = [
            // Discord Nitro Scams
            'discord-nitro.com', 'discordnitro.com', 'discord-gift.com', 'discordgift.ru',
            'discordapp.ru', 'discordapp.info', 'discord-app.com', 'discrod.com',
            'discordapp.click', 'discord-give.com', 'free-nitro.com', 'steamcommunitv.com',
            
            // Steam Scams
            'steamcommunity.ru', 'steamcommunity-login.com', 'steamcommunitv.com',
            'steamcommunlty.com', 'steampowered.ru', 'steamcommunity.us',
            
            // IP Grabbers
            'grabify.link', 'iplogger.org', 'iplogger.com', '2no.co', 'yip.su',
            'blasze.tk', 'blasze.com', 'cutt.ly', 'bit.do', 'tiny.cc',
            
            // Genel Scam
            'bit.ly/discord', 'tinyurl.com/discord', 'cutt.ly/discord'
        ];
        
        // Şüpheli kelimeler
        this.suspiciousKeywords = [
            'free nitro', 'free discord nitro', 'claim nitro', 'get nitro',
            '@everyone', 'steam gift', 'free steam', 'click here now',
            'limited time', 'expires soon', 'verify account', 'urgent action',
            'congratulations you won', 'claim prize', 'free robux', 'free vbucks'
        ];
        
        // Yaygın phishing desenleri
        this.phishingPatterns = [
            /disc[o0][r]?d[-.]?(app|nitro|gift)/i,
            /steam[-.]?comm[u]?nit[yi]/i,
            /free[-.]?(nitro|discord|steam)/i,
            /nitro[-.]?(free|gift|giveaway)/i,
            /click[-.]?here[-.]?(now|fast|urgent)/i
        ];
    }

    async checkMessage(message) {
        const settings = this.getGuildSettings(message.guild.id);
        
        if (!settings.linkfilter_enabled) return;
        if (settings.whitelist?.includes(message.author.id)) return;

        const content = message.content.toLowerCase();
        
        // URL'leri bul
        const urlRegex = /(https?:\/\/[^\s]+)/gi;
        const urls = content.match(urlRegex) || [];
        
        if (urls.length === 0) return;

        let isMalicious = false;
        let reason = '';
        let threatLevel = 0; // 0-10 arası

        // Her URL'yi kontrol et
        for (const url of urls) {
            try {
                const urlObj = new URL(url);
                const domain = urlObj.hostname.toLowerCase();
                
                // 1. Kara liste kontrolü
                for (const blacklisted of this.blacklistedDomains) {
                    if (domain.includes(blacklisted)) {
                        isMalicious = true;
                        reason = `Kara listeli domain: ${blacklisted}`;
                        threatLevel = 10;
                        break;
                    }
                }
                
                // 2. Phishing pattern kontrolü
                if (!isMalicious) {
                    for (const pattern of this.phishingPatterns) {
                        if (pattern.test(url)) {
                            isMalicious = true;
                            reason = 'Phishing pattern tespit edildi';
                            threatLevel = 9;
                            break;
                        }
                    }
                }
                
                // 3. URL shortener kontrolü (şüpheli)
                if (!isMalicious && this.isUrlShortener(domain)) {
                    if (settings.block_url_shorteners) {
                        isMalicious = true;
                        reason = 'URL kısaltıcı tespit edildi';
                        threatLevel = 5;
                    }
                }
                
                // 4. Yeni domain kontrolü (48 saatten yeni)
                if (!isMalicious && settings.check_domain_age) {
                    const domainAge = await this.checkDomainAge(domain);
                    if (domainAge !== null && domainAge < 2) {
                        isMalicious = true;
                        reason = `Çok yeni domain (${domainAge} gün)`;
                        threatLevel = 7;
                    }
                }

            } catch (error) {
                // Geçersiz URL, şüpheli olarak işaretle
                if (settings.strict_mode) {
                    isMalicious = true;
                    reason = 'Geçersiz URL formatı';
                    threatLevel = 6;
                }
            }

            if (isMalicious) break;
        }

        // 5. Şüpheli kelime kontrolü
        if (!isMalicious) {
            for (const keyword of this.suspiciousKeywords) {
                if (content.includes(keyword)) {
                    if (urls.length > 0) { // Hem şüpheli kelime hem link varsa
                        isMalicious = true;
                        reason = `Şüpheli kelime: "${keyword}"`;
                        threatLevel = 8;
                        break;
                    }
                }
            }
        }

        // Tehdit tespit edildiyse işlem yap
        if (isMalicious) {
            await this.handleMaliciousLink(message, reason, threatLevel, settings);
        }
    }

    async handleMaliciousLink(message, reason, threatLevel, settings) {
        try {
            // Mesajı sil
            await message.delete();
            
            // Kullanıcıya uyarı gönder
            const warningEmbed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('⛔ Tehlikeli Link Tespit Edildi')
                .setDescription(`${message.author}, mesajınız zararlı içerik tespit edildiği için silindi!`)
                .addFields(
                    { name: '🔍 Sebep', value: reason },
                    { name: '⚠️ Tehdit Seviyesi', value: `${threatLevel}/10`, inline: true }
                )
                .setFooter({ text: 'Hata olduğunu düşünüyorsanız yetkililere ulaşın' })
                .setTimestamp();

            const warnMsg = await message.channel.send({ embeds: [warningEmbed] });
            
            // 10 saniye sonra uyarı mesajını sil
            setTimeout(() => warnMsg.delete().catch(() => {}), 10000);

            // Logla
            await this.logMaliciousLink(message, reason, threatLevel, settings);

            // İstatistikleri güncelle
            this.updateStats(message.guild.id, 'scam_blocked');

            // Tehdit seviyesi yüksekse otomatik ceza
            if (threatLevel >= 8) {
                const member = await message.guild.members.fetch(message.author.id);
                
                if (settings.auto_timeout_scam && !member.permissions.has('Administrator')) {
                    await member.timeout(settings.scam_timeout_duration || 600000, `Scam link paylaşımı: ${reason}`);
                    console.log(`⏱️ TIMEOUT: ${message.author.tag} - Scam link`);
                }
            }

        } catch (error) {
            console.error('Malicious link handle error:', error);
        }
    }

    async logMaliciousLink(message, reason, threatLevel, settings) {
        if (!settings.log_channel) return;

        const logChannel = message.guild.channels.cache.get(settings.log_channel);
        if (!logChannel) return;

        const embed = new EmbedBuilder()
            .setColor(threatLevel >= 8 ? 0xFF0000 : 0xFFA500)
            .setTitle('🚨 Zararlı Link Engellendi')
            .addFields(
                { name: '👤 Kullanıcı', value: `${message.author.tag} (${message.author.id})`, inline: true },
                { name: '📍 Kanal', value: `${message.channel}`, inline: true },
                { name: '⚠️ Tehdit', value: `${threatLevel}/10`, inline: true },
                { name: '🔍 Sebep', value: reason },
                { name: '📝 Mesaj', value: message.content.substring(0, 1000) }
            )
            .setTimestamp();

        await logChannel.send({ embeds: [embed] });

        // Database'e kaydet
        this.db.run(`
            INSERT INTO scam_logs (guild_id, user_id, channel_id, content, reason, threat_level, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [message.guild.id, message.author.id, message.channel.id, message.content, reason, threatLevel, Date.now()]);
    }

    isUrlShortener(domain) {
        const shorteners = [
            'bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'ow.ly',
            'short.link', 'cutt.ly', 'rebrand.ly', 'is.gd', 'buff.ly'
        ];
        
        return shorteners.some(s => domain.includes(s));
    }

    async checkDomainAge(domain) {
        // Bu basit bir kontrol - gerçek uygulamada WHOIS API kullanılabilir
        // Şimdilik null dönüyoruz (devre dışı)
        return null;
        
        // Gelecekte WHOIS API entegrasyonu:
        // const response = await fetch(`https://api.whoisxml.com/...`);
        // const data = await response.json();
        // return calculateDaysOld(data.createdDate);
    }

    updateStats(guildId, type) {
        const stats = this.db.get('SELECT * FROM stats WHERE guild_id = ?', [guildId]);
        
        if (!stats) {
            this.db.run('INSERT INTO stats (guild_id, scam_blocked) VALUES (?, 1)', [guildId]);
        } else {
            this.db.run('UPDATE stats SET scam_blocked = scam_blocked + 1 WHERE guild_id = ?', [guildId]);
        }
    }

    getGuildSettings(guildId) {
        let settings = this.db.get('SELECT * FROM guild_settings WHERE guild_id = ?', [guildId]);
        
        if (!settings) {
            this.db.run('INSERT INTO guild_settings (guild_id) VALUES (?)', [guildId]);
            settings = this.db.get('SELECT * FROM guild_settings WHERE guild_id = ?', [guildId]);
        }

        return {
            linkfilter_enabled: settings.linkfilter_enabled ?? 1,
            block_url_shorteners: settings.block_url_shorteners ?? 1,
            check_domain_age: settings.check_domain_age ?? 0,
            strict_mode: settings.strict_mode ?? 0,
            auto_timeout_scam: settings.auto_timeout_scam ?? 1,
            scam_timeout_duration: settings.scam_timeout_duration ?? 600000, // 10 dakika
            whitelist: JSON.parse(settings.whitelist || '[]'),
            log_channel: settings.log_channel,
            ...settings
        };
    }

    // Manuel kontrol fonksiyonu (komut için)
    async checkUrl(url) {
        try {
            const urlObj = new URL(url);
            const domain = urlObj.hostname.toLowerCase();
            
            const results = {
                url: url,
                domain: domain,
                safe: true,
                threats: [],
                threatLevel: 0
            };

            // Kara liste kontrolü
            for (const blacklisted of this.blacklistedDomains) {
                if (domain.includes(blacklisted)) {
                    results.safe = false;
                    results.threats.push(`Kara listeli: ${blacklisted}`);
                    results.threatLevel = 10;
                }
            }

            // Phishing kontrolü
            for (const pattern of this.phishingPatterns) {
                if (pattern.test(url)) {
                    results.safe = false;
                    results.threats.push('Phishing pattern tespit edildi');
                    results.threatLevel = Math.max(results.threatLevel, 9);
                }
            }

            // URL shortener
            if (this.isUrlShortener(domain)) {
                results.threats.push('URL kısaltıcı tespit edildi');
                results.threatLevel = Math.max(results.threatLevel, 5);
            }

            return results;

        } catch (error) {
            return {
                url: url,
                safe: false,
                threats: ['Geçersiz URL formatı'],
                threatLevel: 6
            };
        }
    }

    // Kara listeye domain ekle
    addBlacklistedDomain(domain) {
        if (!this.blacklistedDomains.includes(domain)) {
            this.blacklistedDomains.push(domain.toLowerCase());
            return true;
        }
        return false;
    }

    // Kara listeden domain kaldır
    removeBlacklistedDomain(domain) {
        const index = this.blacklistedDomains.indexOf(domain.toLowerCase());
        if (index > -1) {
            this.blacklistedDomains.splice(index, 1);
            return true;
        }
        return false;
    }

    // Tüm kara listeyi al
    getBlacklist() {
        return [...this.blacklistedDomains];
    }
}

module.exports = LinkFilterSystem;