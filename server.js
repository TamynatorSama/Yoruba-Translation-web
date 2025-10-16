const express = require('express');
const cors = require('cors');
const path = require('path');
const { google } = require('googleapis');
const https = require('https');
const http = require('http');

// Load environment variables
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Global state
let drive;
let translatedData = [];
let humanEdits = [];
let activeUsers = new Map();
let itemLocks = new Map();
let systemStats = {
    serverStartTime: new Date().toISOString(),
    totalRequests: 0,
    lastSyncTime: null,
    errorCount: 0,
    imageProxyRequests: 0,
    successfulImageLoads: 0
};

// Logging middleware
app.use((req, res, next) => {
    const startTime = Date.now();
    systemStats.totalRequests++;
    
    console.log(`📥 ${new Date().toISOString()} - ${req.method} ${req.url}`);
    
    res.on('finish', () => {
        const duration = Date.now() - startTime;
        const statusEmoji = res.statusCode < 400 ? '✅' : '❌';
        console.log(`📤 ${statusEmoji} ${res.statusCode} ${req.method} ${req.url} - ${duration}ms`);
    });
    
    next();
});

// Initialize Google Drive API
async function initializeGoogleDrive() {
    try {
        console.log('🔧 Initializing Google Drive API...');
        
        let auth;
        
        if (process.env.NODE_ENV === 'production') {
            // Use environment variables in production
            const credentials = {
                type: process.env.GOOGLE_TYPE,
                project_id: process.env.GOOGLE_PROJECT_ID,
                private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
                private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
                client_email: process.env.GOOGLE_CLIENT_EMAIL,
                client_id: process.env.GOOGLE_CLIENT_ID,
                auth_uri: "https://accounts.google.com/o/oauth2/auth",
                token_uri: "https://oauth2.googleapis.com/token",
                auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
                client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${process.env.GOOGLE_CLIENT_EMAIL}`
            };
            
            auth = new google.auth.GoogleAuth({
                credentials: credentials,
                scopes: ['https://www.googleapis.com/auth/drive']
            });
        } else {
            // Use credentials.json in development
            auth = new google.auth.GoogleAuth({
                keyFile: 'credentials.json',
                scopes: ['https://www.googleapis.com/auth/drive']
            });
        }
        
        drive = google.drive({ version: 'v3', auth });
        
        // Test connection
        await drive.files.list({ pageSize: 1 });
        
        console.log('✅ Google Drive API initialized successfully');
        return true;
    } catch (error) {
        console.error('❌ Failed to initialize Google Drive API:', error.message);
        return false;
    }
}

// Utility: Parse CSV
function parseCSV(text) {
    if (!text || !text.trim()) return [];
    
    const lines = text.split('\n').filter(line => line.trim());
    if (lines.length === 0) return [];
    
    const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
    const data = [];

    for (let i = 1; i < lines.length; i++) {
        try {
            const values = parseCSVLine(lines[i]);
            const row = {};
            
            headers.forEach((header, index) => {
                row[header] = values[index] || '';
            });
            
            if (row.Caption || row.image_url || row.translation) {
                data.push(row);
            }
        } catch (error) {
            console.warn(`⚠️ Skipping malformed CSV line ${i}: ${lines[i].substring(0, 50)}...`);
        }
    }

    return data;
}

function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(current.trim().replace(/^"|"$/g, ''));
            current = '';
        } else {
            current += char;
        }
    }
    
    result.push(current.trim().replace(/^"|"$/g, ''));
    return result;
}

// Load file from Google Drive
async function loadFromDrive(fileName) {
    if (!drive) {
        console.error('❌ Google Drive not initialized');
        return null;
    }

    try {
        console.log(`📥 Loading ${fileName} from Google Drive...`);
        
        const response = await drive.files.list({
            q: `name='${fileName}' and '${DRIVE_FOLDER_ID}' in parents and trashed=false`,
            fields: 'files(id, name, modifiedTime, size)',
            orderBy: 'modifiedTime desc'
        });

        if (response.data.files.length === 0) {
            console.log(`📄 ${fileName} not found in Google Drive`);
            return null;
        }

        const file = response.data.files[0];
        const sizeInMB = file.size ? (parseInt(file.size) / 1024 / 1024).toFixed(2) : 'unknown';
        console.log(`📂 Found ${fileName} (${sizeInMB} MB, modified: ${file.modifiedTime})`);
        
        const fileContent = await drive.files.get(
            { fileId: file.id, alt: 'media' },
            { responseType: 'text' }
        );

        console.log(`✅ Successfully loaded ${fileName}`);
        return fileContent.data;
    } catch (error) {
        console.error(`❌ Error loading ${fileName}:`, error.message);
        systemStats.errorCount++;
        return null;
    }
}

// Save edits to Google Drive
async function saveEditsToDrive() {
    if (!drive || humanEdits.length === 0) return false;

    try {
        const headers = [
            'index', 'original_translation', 'edited_translation', 
            'editor', 'timestamp', 'notes', 'quality_score'
        ];
        
        let csv = headers.join(',') + '\n';
        
        humanEdits.forEach(edit => {
            const row = headers.map(header => {
                const value = String(edit[header] || '');
                return '"' + value.replace(/"/g, '""') + '"';
            });
            csv += row.join(',') + '\n';
        });

        // Check if file exists
        const existingFiles = await drive.files.list({
            q: `name='human_edits.csv' and '${DRIVE_FOLDER_ID}' in parents and trashed=false`,
            fields: 'files(id)',
        });

        const media = {
            mimeType: 'text/csv',
            body: csv,
        };

        if (existingFiles.data.files.length > 0) {
            await drive.files.update({
                fileId: existingFiles.data.files[0].id,
                media: media,
            });
        } else {
            await drive.files.create({
                requestBody: {
                    name: 'human_edits.csv',
                    parents: [DRIVE_FOLDER_ID],
                },
                media: media,
            });
        }

        console.log(`💾 Saved ${humanEdits.length} edits to Google Drive`);
        return true;
    } catch (error) {
        console.error('❌ Error saving edits to Google Drive:', error.message);
        systemStats.errorCount++;
        return false;
    }
}

// Sync data from Google Drive
async function syncData() {
    console.log('🔄 Syncing data from Google Drive...');
    const syncStart = Date.now();

    try {
        // Load main dataset
        let dataLoaded = false;
        
        // Try final dataset first
        const finalData = await loadFromDrive('translated_1M_final.csv');
        if (finalData) {
            translatedData = parseCSV(finalData);
            console.log(`✅ Loaded ${translatedData.length} items from final dataset`);
            dataLoaded = true;
        }
        
        // Fallback to checkpoint
        if (!dataLoaded) {
            const checkpointData = await loadFromDrive('translation_checkpoint.csv');
            if (checkpointData) {
                translatedData = parseCSV(checkpointData);
                console.log(`✅ Loaded ${translatedData.length} items from checkpoint`);
                dataLoaded = true;
            }
        }

        if (!dataLoaded) {
            console.error('❌ No translation data found in Google Drive');
            return false;
        }

        // Load existing edits
        const editsData = await loadFromDrive('human_edits.csv');
        if (editsData) {
            humanEdits = parseCSV(editsData);
            console.log(`✅ Loaded ${humanEdits.length} human edits`);
        } else {
            humanEdits = [];
            console.log('📝 No existing edits found');
        }

        systemStats.lastSyncTime = new Date().toISOString();
        const syncDuration = Date.now() - syncStart;
        
        console.log(`🎉 Sync completed in ${syncDuration}ms`);
        console.log(`📊 Dataset: ${translatedData.length} items, Edits: ${humanEdits.length}`);
        
        return true;
    } catch (error) {
        console.error('❌ Sync failed:', error.message);
        systemStats.errorCount++;
        return false;
    }
}

// Image proxy with proper error handling
app.get('/api/image-proxy', (req, res) => {
    const imageUrl = req.query.url;
    
    if (!imageUrl) {
        return res.status(400).json({ error: 'Image URL parameter required' });
    }

    console.log(`🖼️ Image proxy request: ${imageUrl.substring(0, 60)}...`);
    systemStats.imageProxyRequests++;
    
    let responseEnded = false;
    
    const endResponse = (statusCode, data) => {
        if (responseEnded) return;
        responseEnded = true;
        
        if (typeof data === 'object') {
            res.status(statusCode).json(data);
        } else {
            res.status(statusCode).send(data);
        }
    };

    try {
        const protocol = imageUrl.startsWith('https:') ? https : http;
        
        const request = protocol.get(imageUrl, (imageResponse) => {
            if (responseEnded) return;
            
            console.log(`📡 Image response: ${imageResponse.statusCode} for ${imageUrl.substring(0, 40)}...`);
            
            // Handle redirects
            if (imageResponse.statusCode >= 300 && imageResponse.statusCode < 400) {
                const location = imageResponse.headers.location;
                if (location) {
                    return endResponse(302, { redirect: location });
                }
            }
            
            // Handle errors
            if (imageResponse.statusCode !== 200) {
                return endResponse(imageResponse.statusCode, { 
                    error: `Image server returned ${imageResponse.statusCode}` 
                });
            }
            
            // Set headers for successful response
            if (!responseEnded) {
                try {
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    res.setHeader('Content-Type', imageResponse.headers['content-type'] || 'image/jpeg');
                    res.setHeader('Cache-Control', 'public, max-age=3600');
                    
                    responseEnded = true;
                    systemStats.successfulImageLoads++;
                    
                    imageResponse.pipe(res);
                    
                    imageResponse.on('end', () => {
                        console.log(`✅ Image delivered: ${imageUrl.substring(0, 40)}...`);
                    });
                    
                } catch (headerError) {
                    endResponse(500, { error: 'Failed to set response headers' });
                }
            }
            
            imageResponse.on('error', (streamError) => {
                console.error('Image stream error:', streamError.message);
                endResponse(500, { error: 'Image stream failed' });
            });
        });

        // Set timeout
        request.setTimeout(10000, () => {
            request.destroy();
            endResponse(408, { error: 'Image request timeout' });
        });

        // Handle request errors
        request.on('error', (error) => {
            console.error('Image request error:', error.message);
            
            let errorMessage = 'Failed to fetch image';
            if (error.code === 'ENOTFOUND') errorMessage = 'Image server not found';
            else if (error.code === 'ECONNREFUSED') errorMessage = 'Connection refused';
            else if (error.code === 'ETIMEDOUT') errorMessage = 'Connection timeout';
            
            endResponse(500, { error: errorMessage, code: error.code });
        });

        // Handle client disconnect
        req.on('close', () => {
            if (!responseEnded) {
                request.destroy();
                responseEnded = true;
                console.log('🔌 Client disconnected during image proxy');
            }
        });

    } catch (error) {
        console.error('Image proxy setup error:', error);
        endResponse(500, { error: 'Image proxy internal error' });
    }
});

// API Routes

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
        },
        stats: systemStats,
        data: {
            translated_items: translatedData.length,
            human_edits: humanEdits.length,
            active_users: activeUsers.size,
            locked_items: itemLocks.size
        }
    });
});

// Get statistics
app.get('/api/stats', (req, res) => {
    try {
        const totalItems = translatedData.length;
        const translatedItems = translatedData.filter(item => item.translation && item.translation.trim()).length;
        const editedItems = humanEdits.length;
        
        const activeUsersList = Array.from(activeUsers.entries()).map(([username, data]) => ({
            username: username,
            current_item: data.current_item || 0,
            last_active: data.last_active,
            session_duration: data.session_start ? 
                Math.floor((Date.now() - new Date(data.session_start)) / 1000 / 60) : 0
        }));

        res.json({
            total: totalItems,
            translated: translatedItems,
            edited: editedItems,
            completion_rate: totalItems > 0 ? ((translatedItems / totalItems) * 100).toFixed(1) : '0',
            edit_rate: totalItems > 0 ? ((editedItems / totalItems) * 100).toFixed(1) : '0',
            active_users: activeUsersList,
            locked_items: Array.from(itemLocks.entries()).map(([index, user]) => ({ index, user })),
            system_stats: {
                server_uptime_minutes: Math.floor(process.uptime() / 60),
                total_requests: systemStats.totalRequests,
                last_sync: systemStats.lastSyncTime,
                error_count: systemStats.errorCount,
                image_proxy_requests: systemStats.imageProxyRequests,
                successful_image_loads: systemStats.successfulImageLoads
            }
        });
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ error: 'Failed to get statistics' });
    }
});

// Get single item
app.get('/api/item/:index', (req, res) => {
    try {
        const index = parseInt(req.params.index);
        
        if (isNaN(index) || index < 0 || index >= translatedData.length) {
            return res.status(404).json({ 
                error: 'Item not found',
                valid_range: `0 to ${translatedData.length - 1}`,
                requested: index
            });
        }

        const item = translatedData[index];
        const edit = humanEdits.find(e => parseInt(e.index) === index);
        const lockedBy = itemLocks.get(index);

        res.json({
            index: index,
            Caption: item.Caption || '',
            image_url: item.image_url || '',
            translation: item.translation || '',
            edited_translation: edit ? edit.edited_translation : (item.translation || ''),
            human_edited: !!edit,
            editor: edit ? edit.editor : null,
            edit_timestamp: edit ? edit.timestamp : null,
            quality_score: edit ? parseInt(edit.quality_score) || 5 : 5,
            notes: edit ? edit.notes || '' : '',
            locked: !!lockedBy,
            locked_by: lockedBy || null,
            translation_complete: !!(item.translation && item.translation.trim()),
            has_potential_issues: item.translation && (
                item.translation.includes('[ERROR]') || 
                item.translation.length < 5 ||
                item.translation === item.Caption
            )
        });
    } catch (error) {
        console.error('Get item error:', error);
        res.status(500).json({ error: 'Failed to get item data' });
    }
});

// Lock item
app.post('/api/lock/:index', (req, res) => {
    try {
        const index = parseInt(req.params.index);
        const { username } = req.body;

        if (!username || typeof username !== 'string') {
            return res.status(400).json({ error: 'Valid username required' });
        }

        if (isNaN(index) || index < 0 || index >= translatedData.length) {
            return res.status(404).json({ error: 'Item not found' });
        }

        const currentLock = itemLocks.get(index);

        if (currentLock && currentLock !== username) {
            return res.status(423).json({ 
                error: 'Item locked by another user',
                locked_by: currentLock
            });
        }

        itemLocks.set(index, username);
        
        // Auto-unlock after 10 minutes
        setTimeout(() => {
            if (itemLocks.get(index) === username) {
                itemLocks.delete(index);
                console.log(`🔓 Auto-unlocked item ${index} for ${username}`);
            }
        }, 10 * 60 * 1000);

        console.log(`🔒 Locked item ${index} for ${username}`);
        res.json({ 
            success: true,
            locked_until: new Date(Date.now() + 10 * 60 * 1000).toISOString()
        });
    } catch (error) {
        console.error('Lock item error:', error);
        res.status(500).json({ error: 'Failed to lock item' });
    }
});

// Unlock item
app.post('/api/unlock/:index', (req, res) => {
    try {
        const index = parseInt(req.params.index);
        const { username } = req.body;

        if (itemLocks.get(index) === username) {
            itemLocks.delete(index);
            console.log(`🔓 Unlocked item ${index} by ${username}`);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Unlock item error:', error);
        res.status(500).json({ error: 'Failed to unlock item' });
    }
});

// Save edit
app.post('/api/save', async (req, res) => {
    try {
        const { index, edited_translation, editor, notes, quality_score } = req.body;

        // Validation
        if (index === undefined || !edited_translation || !editor) {
            return res.status(400).json({ 
                error: 'Missing required fields: index, edited_translation, editor' 
            });
        }

        const actualIndex = parseInt(index);
        if (isNaN(actualIndex) || actualIndex < 0 || actualIndex >= translatedData.length) {
            return res.status(404).json({ error: 'Item not found' });
        }

        const item = translatedData[actualIndex];
        
        // Find or create edit
        const existingEditIndex = humanEdits.findIndex(e => parseInt(e.index) === actualIndex);

        const editData = {
            index: actualIndex,
            original_translation: item.translation || '',
            edited_translation: edited_translation.trim(),
            editor: editor.trim(),
            timestamp: new Date().toISOString(),
            notes: notes ? notes.trim() : '',
            quality_score: Math.max(1, Math.min(5, parseInt(quality_score) || 5))
        };

        if (existingEditIndex !== -1) {
            humanEdits[existingEditIndex] = editData;
            console.log(`✏️ Updated edit for item ${actualIndex} by ${editor}`);
        } else {
            humanEdits.push(editData);
            console.log(`✅ New edit for item ${actualIndex} by ${editor} (${editData.quality_score}⭐)`);
        }

        // Unlock item
        itemLocks.delete(actualIndex);

        // Save to Drive asynchronously
        saveEditsToDrive().catch(err => 
            console.error('Background save to Drive failed:', err.message)
        );

        res.json({ 
            success: true, 
            edit: editData,
            total_edits: humanEdits.length
        });
    } catch (error) {
        console.error('Save edit error:', error);
        res.status(500).json({ error: 'Failed to save edit' });
    }
});

// Track user activity
app.post('/api/activity', (req, res) => {
    try {
        const { username, current_item } = req.body;

        if (!username || typeof username !== 'string') {
            return res.status(400).json({ error: 'Valid username required' });
        }

        const existingUser = activeUsers.get(username);
        const now = new Date().toISOString();

        activeUsers.set(username, {
            username: username,
            current_item: parseInt(current_item) || 0,
            last_active: now,
            session_start: existingUser ? existingUser.session_start : now
        });

        res.json({ success: true });
    } catch (error) {
        console.error('Activity tracking error:', error);
        res.status(500).json({ error: 'Failed to track activity' });
    }
});

// Export data
app.get('/api/export', (req, res) => {
    try {
        const format = req.query.format || 'complete';
        
        let exportData;
        let filename;
        
        if (format === 'edits_only') {
            exportData = humanEdits;
            filename = `yoruba_human_edits_${Date.now()}.csv`;
        } else {
            // Complete merged dataset
            exportData = translatedData.map((item, index) => {
                const edit = humanEdits.find(e => parseInt(e.index) === index);
                return {
                    index: index,
                    Caption: item.Caption || '',
                    image_url: item.image_url || '',
                    original_translation: item.translation || '',
                    final_translation: edit ? edit.edited_translation : (item.translation || ''),
                    human_edited: !!edit,
                    editor: edit ? edit.editor : '',
                    edit_timestamp: edit ? edit.timestamp : '',
                    quality_score: edit ? edit.quality_score : '',
                    notes: edit ? edit.notes : ''
                };
            });
            filename = `yoruba_final_dataset_${Date.now()}.csv`;
        }

        if (exportData.length === 0) {
            return res.status(404).json({ error: 'No data to export' });
        }

        // Convert to CSV
        const headers = Object.keys(exportData[0]);
        let csv = headers.join(',') + '\n';

        exportData.forEach(row => {
            const values = headers.map(header => {
                const value = String(row[header] || '');
                return '"' + value.replace(/"/g, '""') + '"';
            });
            csv += values.join(',') + '\n';
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csv);

        console.log(`📥 Export generated: ${filename} (${exportData.length} rows)`);
    } catch (error) {
        console.error('Export error:', error);
        res.status(500).json({ error: 'Export failed' });
    }
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('🚨 Unhandled error:', {
        message: error.message,
        stack: error.stack,
        url: req.url,
        method: req.method,
        timestamp: new Date().toISOString()
    });
    
    systemStats.errorCount++;
    
    if (!res.headersSent) {
        res.status(500).json({ 
            error: 'Internal server error',
            timestamp: new Date().toISOString()
        });
    }
});

// 404 handler
app.use((req, res) => {
    if (!res.headersSent) {
        res.status(404).json({ 
            error: 'Endpoint not found',
            method: req.method,
            url: req.url
        });
    }
});

// Cleanup functions
function cleanupInactiveUsers() {
    const now = Date.now();
    let removedCount = 0;
    
    for (const [username, data] of activeUsers.entries()) {
        const lastActive = new Date(data.last_active).getTime();
        if (now - lastActive > 15 * 60 * 1000) { // 15 minutes
            activeUsers.delete(username);
            removedCount++;
        }
    }
    
    if (removedCount > 0) {
        console.log(`🧹 Cleaned up ${removedCount} inactive users`);
    }
}

// Periodic tasks
setInterval(cleanupInactiveUsers, 5 * 60 * 1000); // Every 5 minutes
setInterval(syncData, 10 * 60 * 1000); // Every 10 minutes
setInterval(() => {
    if (humanEdits.length > 0) {
        saveEditsToDrive().catch(err => 
            console.error('Scheduled save failed:', err.message)
        );
    }
}, 5 * 60 * 1000); // Every 5 minutes

// Graceful shutdown
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

async function gracefulShutdown() {
    console.log('\n📴 Shutting down gracefully...');
    
    // Save any pending edits
    if (humanEdits.length > 0) {
        console.log('💾 Saving final edits...');
        await saveEditsToDrive();
    }
    
    console.log('✅ Shutdown complete');
    process.exit(0);
}

// Start server
async function startServer() {
    console.log('🚀 Starting Yoruba Caption Editor Server...');
    console.log(`📅 Date: ${new Date().toISOString()}`);
    console.log(`👤 User: TamynatorSama`);
    
    // Validate environment
    if (!DRIVE_FOLDER_ID) {
        console.error('❌ DRIVE_FOLDER_ID not set in .env file');
        process.exit(1);
    }
    
    // Initialize Google Drive
    const driveInitialized = await initializeGoogleDrive();
    if (!driveInitialized) {
        console.error('❌ Failed to initialize Google Drive. Check credentials.json');
        process.exit(1);
    }
    
    // Load initial data
    const syncSuccess = await syncData();
    if (!syncSuccess) {
        console.warn('⚠️ Initial data sync failed. Server will start with limited functionality.');
    }
    
    // Start server
    app.listen(PORT, () => {
        console.log('\n' + '='.repeat(70));
        console.log(`🌟 YORUBA CAPTION EDITOR SERVER RUNNING`);
        console.log(`🌐 URL: http://localhost:${PORT}`);
        console.log(`📊 Dataset: ${translatedData.length.toLocaleString()} items`);
        console.log(`✏️ Edits: ${humanEdits.length.toLocaleString()}`);
        console.log(`📁 Drive Folder: ${DRIVE_FOLDER_ID}`);
        console.log(`🔄 Auto-sync: Every 10 minutes`);
        console.log(`💾 Auto-save: Every 5 minutes`);
        console.log('='.repeat(70));
    });
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
    systemStats.errorCount++;
});

// Start the application
startServer().catch((error) => {
    console.error('💥 Failed to start server:', error);
    process.exit(1);
});