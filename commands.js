// commands.js - Tüm Slash Commands Tanımları

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
    
    // ==========================================
    // ANTI-RAID KOMUTLARI
    // ==========================================
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
    },
    
    // ==========================================
    // AUTO-MODERATION KOMUTLARI (YENİ)
    // ==========================================
    {
        name: 'automod',
        description: '🤖 Otomatik moderasyon ayarları',
        default_member_permissions: '8',
        options: [
            {
                name: 'durum',
                description: 'AutoMod durumunu görüntüle',
                type: 1
            },
            {
                name: 'ayarla',
                description: 'AutoMod ayarlarını değiştir',
                type: 1,
                options: [
                    {
                        name: 'özellik',
                        description: 'Değiştirilecek özellik',
                        type: 3,
                        required: true,
                        choices: [
                            { name: 'Küfür Filtresi', value: 'profanity_filter' },
                            { name: 'CAPS Filtresi', value: 'caps_filter' },
                            { name: 'CAPS Eşiği (%)', value: 'caps_threshold' },
                            { name: 'Emoji Spam Limiti', value: 'emoji_spam_limit' },
                            { name: 'Mention Spam Limiti', value: 'mention_spam_limit' },
                            { name: 'Duplicate Mesaj Limiti', value: 'duplicate_message_limit' },
                            { name: 'Zalgo Filtresi', value: 'zalgo_filter' }
                        ]
                    },
                    {
                        name: 'değer',
                        description: 'Yeni değer (boolean için 1/0, sayısal için sayı)',
                        type: 4,
                        required: true
                    }
                ]
            },
            {
                name: 'küfür',
                description: 'Küfür listesi yönetimi',
                type: 1,
                options: [
                    {
                        name: 'işlem',
                        description: 'Yapılacak işlem',
                        type: 3,
                        required: true,
                        choices: [
                            { name: 'Liste', value: 'list' },
                            { name: 'Ekle', value: 'add' },
                            { name: 'Çıkar', value: 'remove' }
                        ]
                    },
                    {
                        name: 'kelime',
                        description: 'Eklenecek/çıkarılacak kelime',
                        type: 3,
                        required: false
                    }
                ]
            },
            {
                name: 'test',
                description: 'Bir mesajı AutoMod ile test et',
                type: 1,
                options: [
                    {
                        name: 'mesaj',
                        description: 'Test edilecek mesaj',
                        type: 3,
                        required: true
                    }
                ]
            }
        ]
    },
    
    // ==========================================
    // WARNING SİSTEMİ (YENİ)
    // ==========================================
    {
        name: 'warn',
        description: '⚠️ Kullanıcıya uyarı ver',
        default_member_permissions: '8',
        options: [
            {
                name: 'kullanıcı',
                description: 'Uyarılacak kullanıcı',
                type: 6,
                required: true
            },
            {
                name: 'sebep',
                description: 'Uyarı sebebi',
                type: 3,
                required: true
            }
        ]
    },
    {
        name: 'warnings',
        description: '📋 Kullanıcının uyarılarını görüntüle',
        options: [
            {
                name: 'kullanıcı',
                description: 'Uyarıları görüntülenecek kullanıcı',
                type: 6,
                required: true
            }
        ]
    },
    {
        name: 'unwarn',
        description: '✅ Uyarıyı kaldır',
        default_member_permissions: '8',
        options: [
            {
                name: 'warning_id',
                description: 'Uyarı ID numarası',
                type: 4,
                required: true
            }
        ]
    },
    {
        name: 'clearwarnings',
        description: '🗑️ Kullanıcının tüm uyarılarını temizle',
        default_member_permissions: '8',
        options: [
            {
                name: 'kullanıcı',
                description: 'Uyarıları temizlenecek kullanıcı',
                type: 6,
                required: true
            }
        ]
    },
    
    // ==========================================
    // LINK FİLTER KOMUTLARI
    // ==========================================
    {
        name: 'linkfilter',
        description: '🔗 Link filter yönetimi',
        default_member_permissions: '8',
        options: [
            {
                name: 'blacklist',
                description: 'Kara liste yönetimi',
                type: 1,
                options: [
                    {
                        name: 'işlem',
                        description: 'Yapılacak işlem',
                        type: 3,
                        required: true,
                        choices: [
                            { name: 'Liste', value: 'list' },
                            { name: 'Ekle', value: 'add' },
                            { name: 'Çıkar', value: 'remove' }
                        ]
                    },
                    {
                        name: 'domain',
                        description: 'Domain adı (örn: scamsite.com)',
                        type: 3,
                        required: false
                    }
                ]
            },
            {
                name: 'kontrol',
                description: 'Bir URL\'i güvenlik kontrolünden geçir',
                type: 1,
                options: [
                    {
                        name: 'url',
                        description: 'Kontrol edilecek URL',
                        type: 3,
                        required: true
                    }
                ]
            },
            {
                name: 'istatistik',
                description: 'Engellenen scam istatistikleri',
                type: 1
            }
        ]
    },
    
    // ==========================================
    // LOGLAR VE RAPORLAR
    // ==========================================
    {
        name: 'logs',
        description: '📜 İhlal ve güvenlik logları',
        default_member_permissions: '8',
        options: [
            {
                name: 'tip',
                description: 'Log tipi',
                type: 3,
                required: true,
                choices: [
                    { name: 'Tüm İhlaller', value: 'all' },
                    { name: 'Spam', value: 'spam' },
                    { name: 'Ses Kötüye Kullanım', value: 'voice' },
                    { name: 'AutoMod', value: 'automod' },
                    { name: 'Scam/Phishing', value: 'scam' },
                    { name: 'Raid', value: 'raid' }
                ]
            },
            {
                name: 'limit',
                description: 'Gösterilecek kayıt sayısı',
                type: 4,
                required: false,
                min_value: 5,
                max_value: 50
            }
        ]
    },
    {
        name: 'rapor',
        description: '📊 Detaylı güvenlik raporu oluştur',
        default_member_permissions: '8',
        options: [
            {
                name: 'süre',
                description: 'Rapor süresi',
                type: 3,
                required: true,
                choices: [
                    { name: 'Son 24 Saat', value: '24h' },
                    { name: 'Son 7 Gün', value: '7d' },
                    { name: 'Son 30 Gün', value: '30d' },
                    { name: 'Tüm Zamanlar', value: 'all' }
                ]
            }
        ]
    },
    
    // ==========================================
    // YÖNETİM VE BAKIM
    // ==========================================
    {
        name: 'temizle',
        description: '🧹 Bot verilerini temizle',
        default_member_permissions: '8',
        options: [
            {
                name: 'tip',
                description: 'Temizlenecek veri',
                type: 3,
                required: true,
                choices: [
                    { name: 'Logları Temizle', value: 'logs' },
                    { name: 'İstatistikleri Sıfırla', value: 'stats' },
                    { name: 'Uyarıları Temizle', value: 'warnings' },
                    { name: 'Tüm Verileri Sıfırla (Dikkat!)', value: 'all' }
                ]
            }
        ]
    },
    {
        name: 'yedekle',
        description: '💾 Sunucu ayarlarını yedekle',
        default_member_permissions: '8'
    },
    {
        name: 'yükle',
        description: '📥 Yedekten ayarları geri yükle',
        default_member_permissions: '8',
        options: [
            {
                name: 'backup_id',
                description: 'Yedek ID numarası',
                type: 3,
                required: true
            }
        ]
    },
    
    // ==========================================
    // KULLANICI BİLGİLERİ
    // ==========================================
    {
        name: 'kullanıcı',
        description: '👤 Kullanıcı güvenlik profili',
        options: [
            {
                name: 'hedef',
                description: 'Bilgileri görüntülenecek kullanıcı',
                type: 6,
                required: false
            }
        ]
    },
    {
        name: 'sunucu',
        description: '🏰 Sunucu güvenlik bilgileri',
        default_member_permissions: '8'
    }
];

module.exports = commands;