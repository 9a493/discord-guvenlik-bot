// database-setup.js - Geliştirilmiş Database Kurulumu
const initSqlJs = require('sql.js');
const fs = require('fs');

const DB_FILE = 'bot.db';

async function initDatabase() {
    const SQL = await initSqlJs();
    
    let db;
    if (fs.existsSync(DB_FILE)) {
        const filebuffer = fs.readFileSync(DB_FILE);
        db = new SQL.Database(filebuffer);
    } else {
        db = new SQL.Database();
    }
    
    // ============================================
    // 1. GUILD SETTINGS - Sunucu Ayarları
    // ============================================
    db.run(`
        CREATE TABLE IF NOT EXISTS guild_settings (
            guild_id TEXT PRIMARY KEY,
            
            -- Spam Koruması
            spam_threshold INTEGER DEFAULT 5,
            spam_timewindow INTEGER DEFAULT 5000,
            
            -- Ses Koruması
            voice_threshold INTEGER DEFAULT 3,
            voice_timewindow INTEGER DEFAULT 10000,
            
            -- Ceza Ayarları
            timeout_1 INTEGER DEFAULT 60000,
            timeout_2 INTEGER DEFAULT 3600000,
            
            -- Kanallar
            log_channel TEXT,
            verification_channel TEXT,
            rules_channel TEXT,
            
            -- Genel
            language TEXT DEFAULT 'tr',
            whitelist TEXT DEFAULT '[]',
            enabled INTEGER DEFAULT 1,
            
            -- Anti-Raid
            antiraid_enabled INTEGER DEFAULT 1,
            join_threshold INTEGER DEFAULT 5,
            min_account_age INTEGER DEFAULT 7,
            suspicion_threshold INTEGER DEFAULT 5,
            auto_kick_suspicious INTEGER DEFAULT 1,
            quarantine_role TEXT,
            raid_mode_action TEXT DEFAULT 'quarantine',
            raid_mode_duration INTEGER DEFAULT 600000,
            verification_enabled INTEGER DEFAULT 0,
            
            -- Link Filter
            linkfilter_enabled INTEGER DEFAULT 1,
            block_url_shorteners INTEGER DEFAULT 1,
            check_domain_age INTEGER DEFAULT 0,
            strict_mode INTEGER DEFAULT 0,
            auto_timeout_scam INTEGER DEFAULT 1,
            scam_timeout_duration INTEGER DEFAULT 600000,
            
            -- Auto Moderation (YENİ)
            automod_enabled INTEGER DEFAULT 1,
            profanity_filter INTEGER DEFAULT 1,
            caps_filter INTEGER DEFAULT 1,
            caps_threshold INTEGER DEFAULT 70,
            emoji_spam_limit INTEGER DEFAULT 10,
            mention_spam_limit INTEGER DEFAULT 5,
            duplicate_message_limit INTEGER DEFAULT 3,
            zalgo_filter INTEGER DEFAULT 1,
            
            -- Yeni Özellikler
            warning_system_enabled INTEGER DEFAULT 1,
            max_warnings INTEGER DEFAULT 3,
            webhook_protection INTEGER DEFAULT 1,
            
            created_at INTEGER DEFAULT (strftime('%s', 'now')),
            updated_at INTEGER DEFAULT (strftime('%s', 'now'))
        );
    `);
    
    // ============================================
    // 2. VIOLATIONS - İhlal Kayıtları
    // ============================================
    db.run(`
        CREATE TABLE IF NOT EXISTS violations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            type TEXT NOT NULL,
            reason TEXT,
            action TEXT,
            timestamp INTEGER NOT NULL,
            moderator_id TEXT,
            evidence TEXT
        );
    `);
    
    // ============================================
    // 3. STATS - İstatistikler
    // ============================================
    db.run(`
        CREATE TABLE IF NOT EXISTS stats (
            guild_id TEXT PRIMARY KEY,
            total_violations INTEGER DEFAULT 0,
            spam_detected INTEGER DEFAULT 0,
            voice_abuse_detected INTEGER DEFAULT 0,
            timeouts_issued INTEGER DEFAULT 0,
            kicks_issued INTEGER DEFAULT 0,
            scam_blocked INTEGER DEFAULT 0,
            automod_triggers INTEGER DEFAULT 0,
            warnings_issued INTEGER DEFAULT 0
        );
    `);
    
    // ============================================
    // 4. SCAM LOGS - Scam/Phishing Logları (YENİ)
    // ============================================
    db.run(`
        CREATE TABLE IF NOT EXISTS scam_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            content TEXT NOT NULL,
            reason TEXT NOT NULL,
            threat_level INTEGER DEFAULT 0,
            timestamp INTEGER NOT NULL,
            url TEXT,
            domain TEXT
        );
    `);
    
    // ============================================
    // 5. WARNINGS - Uyarı Sistemi (YENİ)
    // ============================================
    db.run(`
        CREATE TABLE IF NOT EXISTS warnings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            moderator_id TEXT NOT NULL,
            reason TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            active INTEGER DEFAULT 1,
            expires_at INTEGER
        );
    `);
    
    // ============================================
    // 6. AUTOMOD LOGS - Otomatik Moderasyon Logları (YENİ)
    // ============================================
    db.run(`
        CREATE TABLE IF NOT EXISTS automod_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            type TEXT NOT NULL,
            content TEXT,
            action TEXT,
            timestamp INTEGER NOT NULL
        );
    `);
    
    // ============================================
    // 7. BLACKLISTED_DOMAINS - Kara Liste (YENİ)
    // ============================================
    db.run(`
        CREATE TABLE IF NOT EXISTS blacklisted_domains (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            domain TEXT UNIQUE NOT NULL,
            reason TEXT,
            added_by TEXT,
            added_at INTEGER DEFAULT (strftime('%s', 'now')),
            global INTEGER DEFAULT 0
        );
    `);
    
    // ============================================
    // 8. GLOBAL SETTINGS - Global Ayarlar (YENİ)
    // ============================================
    db.run(`
        CREATE TABLE IF NOT EXISTS global_settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at INTEGER DEFAULT (strftime('%s', 'now'))
        );
    `);
    
    // ============================================
    // 9. BACKUP LOGS - Yedekleme Logları (YENİ)
    // ============================================
    db.run(`
        CREATE TABLE IF NOT EXISTS backup_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            backup_type TEXT NOT NULL,
            file_path TEXT,
            size INTEGER,
            created_at INTEGER DEFAULT (strftime('%s', 'now'))
        );
    `);
    
    // ============================================
    // INDEXLER - Performans İçin
    // ============================================
    db.run('CREATE INDEX IF NOT EXISTS idx_violations_guild ON violations(guild_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_violations_user ON violations(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_violations_timestamp ON violations(timestamp)');
    
    db.run('CREATE INDEX IF NOT EXISTS idx_scam_logs_guild ON scam_logs(guild_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_scam_logs_timestamp ON scam_logs(timestamp)');
    
    db.run('CREATE INDEX IF NOT EXISTS idx_warnings_guild ON warnings(guild_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_warnings_user ON warnings(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_warnings_active ON warnings(active)');
    
    db.run('CREATE INDEX IF NOT EXISTS idx_automod_guild ON automod_logs(guild_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_automod_timestamp ON automod_logs(timestamp)');
    
    // ============================================
    // VARSAYILAN GLOBAL AYARLAR
    // ============================================
    const defaultGlobalSettings = [
        ['bot_version', '2.0.0'],
        ['maintenance_mode', '0'],
        ['global_announcement', ''],
        ['premium_enabled', '1']
    ];
    
    defaultGlobalSettings.forEach(([key, value]) => {
        db.run(`
            INSERT OR IGNORE INTO global_settings (key, value)
            VALUES (?, ?)
        `, [key, value]);
    });
    
    // ============================================
    // VARSAYILAN BLACKLIST DOMAINLER
    // ============================================
    const defaultBlacklistedDomains = [
        'discord-nitro.com',
        'discordnitro.com',
        'discord-gift.com',
        'discordapp.ru',
        'grabify.link',
        'iplogger.org'
    ];
    
    defaultBlacklistedDomains.forEach(domain => {
        db.run(`
            INSERT OR IGNORE INTO blacklisted_domains (domain, reason, global)
            VALUES (?, ?, 1)
        `, [domain, 'Bilinen scam/phishing domaini']);
    });
    
    console.log('✅ Veritabanı tabloları oluşturuldu!');
    console.log('✅ Indexler oluşturuldu!');
    console.log('✅ Varsayılan ayarlar yüklendi!');
    
    return db;
}

function saveDatabase(db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_FILE, buffer);
}

// Database helper fonksiyonları
function createDbHelpers(db) {
    return {
        get: (sql, params = []) => {
            const stmt = db.prepare(sql);
            stmt.bind(params);
            const result = stmt.step() ? stmt.getAsObject() : null;
            stmt.free();
            return result;
        },
        
        all: (sql, params = []) => {
            const stmt = db.prepare(sql);
            stmt.bind(params);
            const results = [];
            while (stmt.step()) {
                results.push(stmt.getAsObject());
            }
            stmt.free();
            return results;
        },
        
        run: (sql, params = []) => {
            db.run(sql, params);
            saveDatabase(db);
        },
        
        // Yeni: Batch insert için optimize edilmiş fonksiyon
        batchInsert: (table, records) => {
            if (records.length === 0) return;
            
            const keys = Object.keys(records[0]);
            const placeholders = keys.map(() => '?').join(', ');
            const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
            
            records.forEach(record => {
                const values = keys.map(key => record[key]);
                db.run(sql, values);
            });
            
            saveDatabase(db);
        },
        
        // Yeni: Transaction desteği
        transaction: async (callback) => {
            db.run('BEGIN TRANSACTION');
            try {
                await callback();
                db.run('COMMIT');
                saveDatabase(db);
            } catch (error) {
                db.run('ROLLBACK');
                throw error;
            }
        }
    };
}

module.exports = { initDatabase, saveDatabase, createDbHelpers };