require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Session
app.use(session({
    secret: process.env.SESSION_SECRET || 'super-secret-key-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 gün
}));

// Passport setup
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL || 'http://localhost:3000/callback',
    scope: ['identify', 'guilds']
}, (accessToken, refreshToken, profile, done) => {
    profile.accessToken = accessToken;
    return done(null, profile);
}));

app.use(passport.initialize());
app.use(passport.session());

// Auth middleware
function checkAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/login');
}

// Routes

// Ana sayfa
app.get('/', (req, res) => {
    const stats = {
        guilds: global.discordClient ? global.discordClient.guilds.cache.size : 0,
        users: global.discordClient ? global.discordClient.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0) : 0,
        uptime: global.discordClient ? Math.floor(process.uptime() / 60) : 0
    };
    
    res.render('index', { user: req.user, stats });
});

// Login
app.get('/login', passport.authenticate('discord'));

// Callback
app.get('/callback', 
    passport.authenticate('discord', { failureRedirect: '/' }),
    (req, res) => res.redirect('/dashboard')
);

// Logout
app.get('/logout', (req, res) => {
    req.logout(() => res.redirect('/'));
});

// Dashboard - Sunucu seçimi
app.get('/dashboard', checkAuth, async (req, res) => {
    try {
        const fetch = (await import('node-fetch')).default;
        const response = await fetch('https://discord.com/api/users/@me/guilds', {
            headers: { Authorization: `Bearer ${req.user.accessToken}` }
        });
        
        let userGuilds = await response.json();
        
        // Bot'un olduğu sunucuları filtrele ve yönetici yetkisi kontrol et
        if (global.discordClient) {
            const botGuilds = global.discordClient.guilds.cache;
            userGuilds = userGuilds.filter(guild => {
                const hasManagePermission = (guild.permissions & 0x20) === 0x20; // MANAGE_GUILD
                const botInGuild = botGuilds.has(guild.id);
                return hasManagePermission && botInGuild;
            });
        }
        
        res.render('dashboard', { user: req.user, guilds: userGuilds });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.redirect('/');
    }
});

// Sunucu kontrol paneli
app.get('/dashboard/:guildId', checkAuth, async (req, res) => {
    const guildId = req.params.guildId;
    
    if (!global.discordClient) {
        return res.send('Bot henüz başlatılmadı!');
    }
    
    const guild = global.discordClient.guilds.cache.get(guildId);
    if (!guild) {
        return res.send('Bu sunucuya erişiminiz yok veya bot bu sunucuda değil!');
    }
    
    const db = global.db;
    
    // Sunucu ayarlarını al
    const settings = db.get('SELECT * FROM guild_settings WHERE guild_id = ?', [guildId]);
    
    // İstatistikleri al
    let stats = db.get('SELECT * FROM stats WHERE guild_id = ?', [guildId]);
    if (!stats) {
        stats = { total_violations: 0, spam_detected: 0, voice_abuse_detected: 0, timeouts_issued: 0, kicks_issued: 0, scam_blocked: 0 };
    }
    
    // Son ihlalleri al
    const recentViolations = db.all(`
        SELECT * FROM violations 
        WHERE guild_id = ? 
        ORDER BY timestamp DESC 
        LIMIT 10
    `, [guildId]);
    
    // Kanalları al
    const channels = guild.channels.cache
        .filter(c => c.type === 0) // Text channels
        .map(c => ({ id: c.id, name: c.name }));
    
    res.render('guild', {
        user: req.user,
        guild: {
            id: guild.id,
            name: guild.name,
            icon: guild.iconURL(),
            memberCount: guild.memberCount
        },
        settings: settings || {},
        stats,
        violations: recentViolations,
        channels
    });
});

// API Endpoints

// Ayarları güncelle
app.post('/api/guild/:guildId/settings', checkAuth, (req, res) => {
    const guildId = req.params.guildId;
    const updates = req.body;
    const db = global.db;
    
    try {
        const allowedFields = [
            'spam_threshold', 'spam_timewindow', 'voice_threshold', 'voice_timewindow',
            'timeout_1', 'timeout_2', 'log_channel', 'enabled', 'antiraid_enabled',
            'join_threshold', 'min_account_age', 'suspicion_threshold', 'quarantine_role',
            'linkfilter_enabled', 'block_url_shorteners', 'strict_mode', 'auto_timeout_scam',
            'verification_channel', 'rules_channel'
        ];
        
        const setClause = [];
        const values = [];
        
        for (const [key, value] of Object.entries(updates)) {
            if (allowedFields.includes(key)) {
                setClause.push(`${key} = ?`);
                values.push(value);
            }
        }
        
        if (setClause.length > 0) {
            values.push(guildId);
            db.run(`UPDATE guild_settings SET ${setClause.join(', ')} WHERE guild_id = ?`, values);
        }
        
        res.json({ success: true, message: 'Ayarlar güncellendi!' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Bot durumunu değiştir
app.post('/api/guild/:guildId/toggle', checkAuth, (req, res) => {
    const guildId = req.params.guildId;
    const { enabled } = req.body;
    const db = global.db;
    
    try {
        db.run('UPDATE guild_settings SET enabled = ? WHERE guild_id = ?', [enabled ? 1 : 0, guildId]);
        res.json({ success: true, message: enabled ? 'Bot aktif edildi!' : 'Bot pasif edildi!' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// İstatistikler API
app.get('/api/guild/:guildId/stats', checkAuth, (req, res) => {
    const guildId = req.params.guildId;
    const db = global.db;
    
    let stats = db.get('SELECT * FROM stats WHERE guild_id = ?', [guildId]);
    if (!stats) {
        stats = { total_violations: 0, spam_detected: 0, voice_abuse_detected: 0, timeouts_issued: 0, kicks_issued: 0, scam_blocked: 0 };
    }
    
    res.json(stats);
});

// Son ihlaller
app.get('/api/guild/:guildId/violations', checkAuth, (req, res) => {
    const guildId = req.params.guildId;
    const limit = parseInt(req.query.limit) || 50;
    const db = global.db;
    
    const violations = db.all(`
        SELECT * FROM violations 
        WHERE guild_id = ? 
        ORDER BY timestamp DESC 
        LIMIT ?
    `, [guildId, limit]);
    
    res.json(violations);
});

// Whitelist yönetimi
app.get('/api/guild/:guildId/whitelist', checkAuth, (req, res) => {
    const guildId = req.params.guildId;
    const db = global.db;
    const settings = db.get('SELECT whitelist FROM guild_settings WHERE guild_id = ?', [guildId]);
    
    res.json({ whitelist: JSON.parse(settings?.whitelist || '[]') });
});

app.post('/api/guild/:guildId/whitelist/add', checkAuth, (req, res) => {
    const guildId = req.params.guildId;
    const { userId } = req.body;
    const db = global.db;
    
    try {
        const settings = db.get('SELECT whitelist FROM guild_settings WHERE guild_id = ?', [guildId]);
        const whitelist = JSON.parse(settings?.whitelist || '[]');
        
        if (!whitelist.includes(userId)) {
            whitelist.push(userId);
            db.run('UPDATE guild_settings SET whitelist = ? WHERE guild_id = ?', [JSON.stringify(whitelist), guildId]);
        }
        
        res.json({ success: true, whitelist });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/guild/:guildId/whitelist/remove', checkAuth, (req, res) => {
    const guildId = req.params.guildId;
    const { userId } = req.body;
    const db = global.db;
    
    try {
        const settings = db.get('SELECT whitelist FROM guild_settings WHERE guild_id = ?', [guildId]);
        let whitelist = JSON.parse(settings?.whitelist || '[]');
        
        whitelist = whitelist.filter(id => id !== userId);
        db.run('UPDATE guild_settings SET whitelist = ? WHERE guild_id = ?', [JSON.stringify(whitelist), guildId]);
        
        res.json({ success: true, whitelist });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Blacklist yönetimi (Link Filter için)
app.get('/api/guild/:guildId/blacklist', checkAuth, (req, res) => {
    if (!global.linkFilter) {
        return res.json({ blacklist: [] });
    }
    res.json({ blacklist: global.linkFilter.getBlacklist() });
});

app.post('/api/guild/:guildId/blacklist/add', checkAuth, (req, res) => {
    const { domain } = req.body;
    
    if (!global.linkFilter) {
        return res.status(500).json({ success: false, message: 'Link filter sistem başlatılmadı!' });
    }
    
    try {
        const success = global.linkFilter.addBlacklistedDomain(domain);
        if (success) {
            res.json({ success: true, message: 'Domain kara listeye eklendi!' });
        } else {
            res.json({ success: false, message: 'Domain zaten kara listede!' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/guild/:guildId/blacklist/remove', checkAuth, (req, res) => {
    const { domain } = req.body;
    
    if (!global.linkFilter) {
        return res.status(500).json({ success: false, message: 'Link filter sistem başlatılmadı!' });
    }
    
    try {
        const success = global.linkFilter.removeBlacklistedDomain(domain);
        if (success) {
            res.json({ success: true, message: 'Domain kara listeden çıkarıldı!' });
        } else {
            res.json({ success: false, message: 'Domain kara listede değil!' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Logları temizle
app.post('/api/guild/:guildId/logs/clear', checkAuth, (req, res) => {
    const guildId = req.params.guildId;
    const db = global.db;
    
    try {
        db.run('DELETE FROM violations WHERE guild_id = ?', [guildId]);
        if (db.get('SELECT * FROM scam_logs LIMIT 1')) {
            db.run('DELETE FROM scam_logs WHERE guild_id = ?', [guildId]);
        }
        res.json({ success: true, message: 'Loglar temizlendi!' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Tüm verileri sıfırla
app.post('/api/guild/:guildId/reset', checkAuth, (req, res) => {
    const guildId = req.params.guildId;
    const db = global.db;
    
    try {
        // Violations sil
        db.run('DELETE FROM violations WHERE guild_id = ?', [guildId]);
        
        // Stats sıfırla
        db.run('DELETE FROM stats WHERE guild_id = ?', [guildId]);
        db.run('INSERT INTO stats (guild_id) VALUES (?)', [guildId]);
        
        // Scam logs sil
        if (db.get('SELECT * FROM scam_logs LIMIT 1')) {
            db.run('DELETE FROM scam_logs WHERE guild_id = ?', [guildId]);
        }
        
        // Settings'i default'a döndür
        db.run('DELETE FROM guild_settings WHERE guild_id = ?', [guildId]);
        db.run('INSERT INTO guild_settings (guild_id) VALUES (?)', [guildId]);
        
        res.json({ success: true, message: 'Tüm veriler sıfırlandı!' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = app;