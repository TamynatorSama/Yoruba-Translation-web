const express = require('express');
const cors = require('cors');
const path = require('path');
const { google } = require('googleapis');
const https = require('https');
const http = require('http');
const readline = require('readline');

// Load environment variables
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

// MEMORY-OPTIMIZED GLOBAL STATE
let drive;
let datasetInfo = { 
    fileId: null, 
    total: 0, 
    translated: 0, 
    headers: [],
    fileName: null,
    lastSync: null
};
let humanEdits = [];
let activeUsers = new Map();
let itemLocks = new Map();
let systemStats = {
    serverStart: new Date().toISOString(),
    totalRequests: 0,
    errorCount: 0,
    cacheHits: 0,
    cacheMisses: 0
};

// Simple LRU Cache for items (memory-efficient)
class ItemCache {
    constructor(maxSize = 50) { // Reduced to 50 items max
        this.maxSize = maxSize;
        this.cache = new Map();
    }
    
    get(key) {
        if (this.cache.has(key)) {
            const value = this.cache.get(key);
            this.cache.delete(key);
            this.cache.set(key, value);
            systemStats.cacheHits++;
            return value;
        }
        systemStats.cacheMisses++;
        return null;
    }
    
    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }
    
    size() {
        return this.cache.size;
    }
    
    clear() {
        this.cache.clear();
    }
}

const itemCache = new ItemCache(50);

// Logging middleware
app.use((req, res, next) => {
    systemStats.totalRequests++;
    const startTime = Date.now();
    
    console.log(`📥 ${new Date().toISOString().substring(11, 19)} ${req.method} ${req.url}`);
    
    res.on('finish', () => {
        const duration = Date.now() - startTime;
        const emoji = res.statusCode < 400 ? '✅' : '❌';
        console.log(`📤 ${emoji} ${res.statusCode} ${req.method} ${req.url} - ${duration}ms`);
    });
    
    next();
});

console.log('🚀 Starting Yoruba Caption Editor Server...');
console.log(`📅 Current Time (UTC): 2025-10-16 02:15:07`);
console.log(`👤 Current User: TamynatorSama`);

// Initialize Google Drive API
async function initializeGoogleDrive() {
    try {
        console.log('🔧 Initializing Google Drive API...');
        
        let auth;
        
        if (process.env.NODE_ENV === 'production') {
            console.log('🌐 Production mode detected');
            
            if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
                throw new Error('Missing Google credentials in environment variables');
            }
            
            const credentials = {
                type: "service_account",
                project_id: process.env.GOOGLE_PROJECT_ID,
                private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
                private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
                client_email: process.env.GOOGLE_CLIENT_EMAIL,
                client_id: process.env.GOOGLE_CLIENT_ID,
                auth_uri: "https://accounts.google.com/o/oauth2/auth",
                token_uri: "https://oauth2.googleapis.com/token",
                auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
                client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(process.env.GOOGLE_CLIENT_EMAIL)}`
            };
            
            auth = new google.auth.GoogleAuth({
                credentials: credentials,
                scopes: ['https://www.googleapis.com/auth/drive']
            });
        } else {
            console.log('🏠 Development mode detected');
            auth = new google.auth.GoogleAuth({
                keyFile: 'credentials.json',
                scopes: ['https://www.googleapis.com/auth/drive']
            });
        }
        
        drive = google.drive({ version: 'v3', auth });
        
        // Test connection
        console.log('🧪 Testing Google Drive connection...');
        const testResponse = await drive.files.list({ pageSize: 1 });
        console.log(`✅ Connection successful - API responding`);
        
        return true;
    } catch (error) {
        console.error('❌ Google Drive initialization failed:', error.message);
        if (error.message.includes('ENOENT')) {
            console.error('💡 Make sure credentials.json exists or environment variables are set');
        }
        return false;
    }
}

// Utility: Parse single CSV line safely
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

// MEMORY-EFFICIENT: Analyze dataset structure without loading full file
async function analyzeDatasetStructure(fileName) {
    if (!drive) {
        console.error('❌ Drive not initialized');
        return null;
    }

    try {
        console.log(`📊 Analyzing ${fileName} structure...`);
        
        // Find file
        const fileList = await drive.files.list({
            q: `name='${fileName}' and '${DRIVE_FOLDER_ID}' in parents and trashed=false`,
            fields: 'files(id, name, size, modifiedTime)',
        });

        if (fileList.data.files.length === 0) {
            console.log(`📄 ${fileName} not found in Google Drive`);
            return null;
        }

        const file = fileList.data.files[0];
        const sizeInMB = (parseInt(file.size) / 1024 / 1024).toFixed(2);
        console.log(`📂 Found: ${fileName} (${sizeInMB} MB, modified: ${file.modifiedTime})`);
        
        // Stream ONLY first 500 lines to analyze structure
        const stream = await drive.files.get(
            { fileId: file.id, alt: 'media' },
            { responseType: 'stream' }
        );

        let lineCount = 0;
        let translatedCount = 0;
        let headers = null;
        
        const rl = readline.createInterface({
            input: stream,
            crlfDelay: Infinity
        });

        console.log('📖 Sampling file structure (first 500 lines)...');
        
        for await (const line of rl) {
            if (lineCount === 0) {
                // Get headers
                headers = line.split(',').map(h => h.trim().replace(/"/g, ''));
                console.log(`📋 Headers found: [${headers.slice(0, 5).join(', ')}${headers.length > 5 ? '...' : ''}]`);
                lineCount++;
                continue;
            }
            
            // Sample to estimate translation completion
            if (lineCount <= 500) {
                try {
                    const values = parseCSVLine(line);
                    // Look for translation column (usually 3rd column)
                    const translationIndex = headers.findIndex(h => 
                        h.toLowerCase().includes('translation') || 
                        h.toLowerCase() === 'translation'
                    ) || 2;
                    
                    if (values[translationIndex] && values[translationIndex].trim() && 
                        !values[translationIndex].includes('[ERROR]')) {
                        translatedCount++;
                    }
                } catch (e) {
                    // Skip malformed lines
                }
            } else {
                // Stop sampling after 500 lines
                break;
            }
            
            lineCount++;
        }

        // Estimate totals based on file size (rough but memory-efficient)
        const bytesPerLine = parseInt(file.size) / Math.max(lineCount, 1000);
        const estimatedTotal = Math.round(parseInt(file.size) / bytesPerLine) - 1; // -1 for header
        const translationRate = translatedCount / Math.min(lineCount - 1, 500);
        const estimatedTranslated = Math.round(estimatedTotal * translationRate);

        console.log(`✅ Analysis complete:`);
        console.log(`   📊 Estimated total items: ${estimatedTotal.toLocaleString()}`);
        console.log(`   ✔️ Estimated translated: ${estimatedTranslated.toLocaleString()} (${(translationRate * 100).toFixed(1)}%)`);
        console.log(`   💾 Memory used for analysis: ~${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
        
        return {
            fileId: file.id,
            fileName: fileName,
            headers: headers,
            totalItems: estimatedTotal,
            translatedItems: estimatedTranslated,
            fileSize: file.size,
            lastModified: file.modifiedTime
        };
    } catch (error) {
        console.error(`❌ Error analyzing ${fileName}:`, error.message);
        systemStats.errorCount++;
        return null;
    }
}

// MEMORY-EFFICIENT: Load single item by index from Google Drive
async function loadItemByIndex(index) {
    try {
        // Check cache first
        const cached = itemCache.get(index);
        if (cached) {
            return cached;
        }

        if (!datasetInfo.fileId) {
            throw new Error('Dataset not initialized');
        }

        console.log(`📖 Loading item ${index} from Google Drive...`);

        // Create stream to read file line by line
        const stream = await drive.files.get(
            { fileId: datasetInfo.fileId, alt: 'media' },
            { responseType: 'stream' }
        );

        let currentLineNumber = 0;
        let targetItem = null;

        const rl = readline.createInterface({
            input: stream,
            crlfDelay: Infinity
        });

        for await (const line of rl) {
            if (currentLineNumber === 0) {
                // Skip header line
                currentLineNumber++;
                continue;
            }

            // Found our target line
            if (currentLineNumber === index + 1) { // +1 because we skipped header
                try {
                    const values = parseCSVLine(line);
                    const item = {};
                    
                    datasetInfo.headers.forEach((header, headerIndex) => {
                        item[header] = values[headerIndex] || '';
                    });
                    
                    targetItem = item;
                    break;
                } catch (parseError) {
                    throw new Error(`Failed to parse item ${index}: ${parseError.message}`);
                }
            }

            currentLineNumber++;
            
            // Safety: don't read too far past target
            if (currentLineNumber > index + 10) {
                break;
            }
        }

        if (!targetItem) {
            throw new Error(`Item ${index} not found in dataset`);
        }

        // Cache the loaded item
        itemCache.set(index, targetItem);
        console.log(`✅ Item ${index} loaded and cached`);
        
        return targetItem;
    } catch (error) {
        console.error(`❌ Error loading item ${index}:`, error.message);
        systemStats.errorCount++;
        throw error;
    }
}

// Load small files completely (like human edits)
async function loadSmallFileFromDrive(fileName) {
    if (!drive) return null;

    try {
        const fileList = await drive.files.list({
            q: `name='${fileName}' and '${DRIVE_FOLDER_ID}' in parents and trashed=false`,
            fields: 'files(id, name, size)',
        });

        if (fileList.data.files.length === 0) {
            return null;
        }

        const file = fileList.data.files[0];
        const sizeInMB = (parseInt(file.size) / 1024 / 1024).toFixed(2);
        
        // Only load files smaller than 5MB completely
        if (parseFloat(sizeInMB) > 5) {
            console.log(`⚠️ ${fileName} is too large (${sizeInMB}MB) for complete loading`);
            return null;
        }

        console.log(`📥 Loading ${fileName} (${sizeInMB} MB)...`);
        
        const fileContent = await drive.files.get(
            { fileId: file.id, alt: 'media' },
            { responseType: 'text' }
        );

        console.log(`✅ ${fileName} loaded successfully`);
        return fileContent.data;
    } catch (error) {
        console.error(`❌ Error loading ${fileName}:`, error.message);
        return null;
    }
}

// Parse small CSV files
function parseSmallCSV(text) {
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
            
            data.push(row);
        } catch (error) {
            console.warn(`⚠️ Skipping malformed line ${i} in CSV`);
        }
    }

    return data;
}

// Save edits to Google Drive
async function saveEditsToGoogleDrive() {
    if (!drive || humanEdits.length === 0) {
        console.log('📝 No edits to save');
        return false;
    }

    try {
        console.log(`💾 Saving ${humanEdits.length} edits to Google Drive...`);
        
        // Convert edits to CSV
        const headers = [
            'index', 'original_translation', 'edited_translation', 
            'editor', 'timestamp', 'notes', 'quality_score'
        ];
        
        let csvContent = headers.join(',') + '\n';
        
        humanEdits.forEach(edit => {
            const row = headers.map(header => {
                const value = String(edit[header] || '');
                return '"' + value.replace(/"/g, '""') + '"';
            });
            csvContent += row.join(',') + '\n';
        });

        // Check if file exists
        const existingFiles = await drive.files.list({
            q: `name='human_edits.csv' and '${DRIVE_FOLDER_ID}' in parents and trashed=false`,
            fields: 'files(id)',
        });

        const media = {
            mimeType: 'text/csv',
            body: csvContent,
        };

        if (existingFiles.data.files.length > 0) {
            // Update existing file
            await drive.files.update({
                fileId: existingFiles.data.files[0].id,
                media: media,
            });
            console.log(`✅ Updated existing human_edits.csv with ${humanEdits.length} edits`);
        } else {
            // Create new file
            await drive.files.create({
                requestBody: {
                    name: 'human_edits.csv',
                    parents: [DRIVE_FOLDER_ID],
                },
                media: media,
            });
            console.log(`✅ Created new human_edits.csv with ${humanEdits.length} edits`);
        }

        return true;
    } catch (error) {
        console.error('❌ Failed to save edits to Google Drive:', error.message);
        systemStats.errorCount++;
        return false;
    }
}

// MEMORY-OPTIMIZED SYNC FUNCTION
async function performDataSync() {
    console.log('🔄 Performing memory-optimized data sync...');
    const syncStartTime = Date.now();

    try {
        // Step 1: Analyze main dataset structure (don't load data)
        let analysis = await analyzeDatasetStructure('translated_1M_final.csv');
        
        if (!analysis) {
            console.log('📁 Final dataset not found, trying checkpoint...');
            analysis = await analyzeDatasetStructure('translation_checkpoint.csv');
        }

        if (!analysis) {
            console.error('❌ No translation dataset found in Google Drive');
            return false;
        }

        // Step 2: Store dataset metadata only
        datasetInfo = {
            fileId: analysis.fileId,
            fileName: analysis.fileName,
            headers: analysis.headers,
            total: analysis.totalItems,
            translated: analysis.translatedItems,
            fileSize: analysis.fileSize,
            lastModified: analysis.lastModified,
            lastSync: new Date().toISOString()
        };

        console.log(`✅ Dataset metadata stored: ${datasetInfo.total.toLocaleString()} items`);

        // Step 3: Load human edits (small file, safe to load completely)
        const editsFileContent = await loadSmallFileFromDrive('human_edits.csv');
        if (editsFileContent) {
            humanEdits = parseSmallCSV(editsFileContent);
            console.log(`✅ Loaded ${humanEdits.length} human edits`);
        } else {
            humanEdits = [];
            console.log('📝 No existing human edits found');
        }

        // Step 4: Clear cache to free memory
        itemCache.clear();
        console.log('🧹 Cleared item cache');

        const syncDuration = Date.now() - syncStartTime;
        const memoryUsage = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        
        console.log(`🎉 Sync completed successfully in ${syncDuration}ms`);
        console.log(`💾 Current memory usage: ${memoryUsage}MB`);
        console.log(`📊 Cache stats: ${systemStats.cacheHits} hits, ${systemStats.cacheMisses} misses`);
        
        return true;
    } catch (error) {
        console.error('❌ Data sync failed:', error.message);
        systemStats.errorCount++;
        return false;
    }
}

// Image proxy with enhanced error handling
app.get('/api/image-proxy', (req, res) => {
    const imageUrl = req.query.url;
    
    if (!imageUrl) {
        return res.status(400).json({ error: 'Image URL parameter is required' });
    }

    console.log(`🖼️ Proxying image: ${imageUrl.substring(0, 50)}...`);
    
    let responseHandled = false;
    
    const handleResponse = (statusCode, data, contentType = 'application/json') => {
        if (responseHandled) return;
        responseHandled = true;
        
        if (contentType === 'application/json') {
            res.status(statusCode).json(data);
        } else {
            res.status(statusCode).send(data);
        }
    };

    try {
        const protocol = imageUrl.startsWith('https:') ? https : http;
        
        const request = protocol.get(imageUrl, (imageResponse) => {
            if (responseHandled) return;
            
            console.log(`📡 Image response status: ${imageResponse.statusCode}`);
            
            // Handle redirects
            if (imageResponse.statusCode >= 300 && imageResponse.statusCode < 400) {
                const location = imageResponse.headers.location;
                if (location) {
                    return handleResponse(302, { redirect: location });
                }
            }
            
            // Handle HTTP errors
            if (imageResponse.statusCode !== 200) {
                return handleResponse(imageResponse.statusCode, { 
                    error: `Image server responded with ${imageResponse.statusCode}` 
                });
            }
            
            // Success - stream the image
            if (!responseHandled) {
                try {
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    res.setHeader('Content-Type', imageResponse.headers['content-type'] || 'image/jpeg');
                    res.setHeader('Cache-Control', 'public, max-age=3600');
                    
                    responseHandled = true;
                    imageResponse.pipe(res);
                    
                    imageResponse.on('end', () => {
                        console.log(`✅ Image successfully delivered`);
                    });
                    
                } catch (headerError) {
                    handleResponse(500, { error: 'Failed to set response headers' });
                }
            }
            
            imageResponse.on('error', (streamError) => {
                console.error('Image stream error:', streamError.message);
                handleResponse(500, { error: 'Image streaming failed' });
            });
        });

        // Set timeout
        request.setTimeout(8000, () => {
            request.destroy();
            handleResponse(408, { error: 'Image request timeout' });
        });

        // Handle request errors
        request.on('error', (error) => {
            console.error('Image request error:', error.message);
            
            let errorMessage = 'Failed to fetch image';
            if (error.code === 'ENOTFOUND') errorMessage = 'Image server not found';
            else if (error.code === 'ECONNREFUSED') errorMessage = 'Image server refused connection';
            else if (error.code === 'ETIMEDOUT') errorMessage = 'Image server connection timeout';
            
            handleResponse(500, { error: errorMessage, code: error.code });
        });

        // Handle client disconnect
        req.on('close', () => {
            if (!responseHandled) {
                request.destroy();
                responseHandled = true;
                console.log('🔌 Client disconnected during image request');
            }
        });

    } catch (setupError) {
        console.error('Image proxy setup error:', setupError);
        handleResponse(500, { error: 'Image proxy internal error' });
    }
});

// API ROUTES

// Health check endpoint
app.get('/api/health', (req, res) => {
    const memoryUsage = process.memoryUsage();
    
    res.json({
        status: 'healthy',
        timestamp: '2025-10-16 02:15:07',
        server_time: new Date().toISOString(),
        uptime_seconds: Math.floor(process.uptime()),
        memory: {
            used_mb: Math.round(memoryUsage.heapUsed / 1024 / 1024),
            total_mb: Math.round(memoryUsage.heapTotal / 1024 / 1024),
            system_mb: Math.round(memoryUsage.rss / 1024 / 1024)
        },
        dataset: {
            total_items: datasetInfo.total,
            translated_items: datasetInfo.translated,
            human_edits: humanEdits.length,
            cache_size: itemCache.size()
        },
        system_stats: systemStats
    });
});

// Get dataset statistics
app.get('/api/stats', (req, res) => {
    try {
        const activeUsersList = Array.from(activeUsers.entries()).map(([username, userData]) => ({
            username: username,
            current_item: userData.current_item || 0,
            last_active: userData.last_active,
            session_duration_minutes: userData.session_start ? 
                Math.floor((Date.now() - new Date(userData.session_start)) / 1000 / 60) : 0
        }));

        const memoryUsage = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

        res.json({
            total: datasetInfo.total,
            translated: datasetInfo.translated,
            edited: humanEdits.length,
            completion_rate: datasetInfo.total > 0 ? 
                ((datasetInfo.translated / datasetInfo.total) * 100).toFixed(1) : '0.0',
            edit_rate: datasetInfo.total > 0 ? 
                ((humanEdits.length / datasetInfo.total) * 100).toFixed(1) : '0.0',
            active_users: activeUsersList,
            locked_items: Array.from(itemLocks.entries()).map(([index, user]) => ({ 
                index: parseInt(index), 
                user: user 
            })),
            system_info: {
                server_uptime_minutes: Math.floor(process.uptime() / 60),
                memory_usage_mb: memoryUsage,
                total_requests: systemStats.totalRequests,
                error_count: systemStats.errorCount,
                cache_hits: systemStats.cacheHits,
                cache_misses: systemStats.cacheMisses,
                cache_size: itemCache.size(),
                last_sync: datasetInfo.lastSync,
                dataset_file: datasetInfo.fileName
            }
        });
    } catch (error) {
        console.error('Stats endpoint error:', error);
        res.status(500).json({ error: 'Failed to retrieve statistics' });
    }
});

// Get single item by index
app.get('/api/item/:index', async (req, res) => {
    try {
        const index = parseInt(req.params.index);
        
        if (isNaN(index) || index < 0 || index >= datasetInfo.total) {
            return res.status(404).json({ 
                error: 'Item index out of range',
                valid_range: `0 to ${datasetInfo.total - 1}`,
                requested_index: index
            });
        }

        // Load item on-demand from Google Drive
        const item = await loadItemByIndex(index);
        const existingEdit = humanEdits.find(edit => parseInt(edit.index) === index);
        const lockedByUser = itemLocks.get(index);

        res.json({
            index: index,
            Caption: item.Caption || '',
            image_url: item.image_url || '',
            translation: item.translation || '',
            edited_translation: existingEdit ? existingEdit.edited_translation : (item.translation || ''),
            human_edited: !!existingEdit,
            editor: existingEdit ? existingEdit.editor : null,
            edit_timestamp: existingEdit ? existingEdit.timestamp : null,
            quality_score: existingEdit ? parseInt(existingEdit.quality_score) || 5 : 5,
            notes: existingEdit ? existingEdit.notes || '' : '',
            locked: !!lockedByUser,
            locked_by: lockedByUser || null,
            translation_complete: !!(item.translation && item.translation.trim()),
            has_potential_issues: item.translation && (
                item.translation.includes('[ERROR]') || 
                item.translation.length < 5 ||
                item.translation === item.Caption
            ),
            metadata: {
                cached: systemStats.cacheHits > 0,
                load_source: itemCache.get(index) ? 'cache' : 'google_drive'
            }
        });
    } catch (error) {
        console.error(`Error loading item ${req.params.index}:`, error);
        res.status(500).json({ 
            error: 'Failed to load item', 
            details: error.message,
            index: parseInt(req.params.index) 
        });
    }
});

// Lock item for editing
app.post('/api/lock/:index', (req, res) => {
    try {
        const index = parseInt(req.params.index);
        const { username } = req.body;

        if (!username || typeof username !== 'string' || username.trim() === '') {
            return res.status(400).json({ error: 'Valid username is required' });
        }

        if (isNaN(index) || index < 0 || index >= datasetInfo.total) {
            return res.status(404).json({ error: 'Invalid item index' });
        }

        const currentLock = itemLocks.get(index);

        if (currentLock && currentLock !== username) {
            return res.status(423).json({ 
                error: 'Item is locked by another user',
                locked_by: currentLock,
                message: `Item ${index} is currently being edited by ${currentLock}`
            });
        }

        itemLocks.set(index, username);
        console.log(`🔒 Item ${index} locked by ${username}`);
        
        // Auto-unlock after 10 minutes of inactivity
        setTimeout(() => {
            if (itemLocks.get(index) === username) {
                itemLocks.delete(index);
                console.log(`🔓 Auto-unlocked item ${index} (10 minute timeout)`);
            }
        }, 10 * 60 * 1000);

        res.json({ 
            success: true,
            locked_by: username,
            auto_unlock_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()
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
            console.log(`🔓 Item ${index} unlocked by ${username}`);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Unlock item error:', error);
        res.status(500).json({ error: 'Failed to unlock item' });
    }
});

// Save human edit
app.post('/api/save', async (req, res) => {
    try {
        const { index, edited_translation, editor, notes, quality_score } = req.body;

        // Validation
        if (index === undefined || !edited_translation || !editor) {
            return res.status(400).json({ 
                error: 'Missing required fields',
                required: ['index', 'edited_translation', 'editor']
            });
        }

        const itemIndex = parseInt(index);
        if (isNaN(itemIndex) || itemIndex < 0 || itemIndex >= datasetInfo.total) {
            return res.status(404).json({ error: 'Invalid item index' });
        }

        // Load original item to get original translation
        const originalItem = await loadItemByIndex(itemIndex);
        
        // Find existing edit or create new one
        const existingEditIndex = humanEdits.findIndex(edit => parseInt(edit.index) === itemIndex);

        const editRecord = {
            index: itemIndex,
            original_translation: originalItem.translation || '',
            edited_translation: edited_translation.trim(),
            editor: editor.trim(),
            timestamp: new Date().toISOString(),
            notes: notes ? notes.trim() : '',
            quality_score: Math.max(1, Math.min(5, parseInt(quality_score) || 5))
        };

        if (existingEditIndex !== -1) {
            humanEdits[existingEditIndex] = editRecord;
            console.log(`✏️ Updated edit for item ${itemIndex} by ${editor} (${editRecord.quality_score}⭐)`);
        } else {
            humanEdits.push(editRecord);
            console.log(`✅ New edit for item ${itemIndex} by ${editor} (${editRecord.quality_score}⭐)`);
        }

        // Unlock the item
        itemLocks.delete(itemIndex);

        // Save to Google Drive asynchronously
        saveEditsToGoogleDrive().catch(saveError => 
            console.error('Background save to Drive failed:', saveError.message)
        );

        res.json({ 
            success: true, 
            edit: editRecord,
            total_edits: humanEdits.length,
            message: `Edit saved successfully for item ${itemIndex}`
        });
    } catch (error) {
        console.error('Save edit error:', error);
        res.status(500).json({ 
            error: 'Failed to save edit', 
            details: error.message 
        });
    }
});

// Track user activity
app.post('/api/activity', (req, res) => {
    try {
        const { username, current_item } = req.body;

        if (!username || typeof username !== 'string') {
            return res.status(400).json({ error: 'Valid username is required' });
        }

        const existingUser = activeUsers.get(username);
        const currentTime = new Date().toISOString();

        activeUsers.set(username, {
            username: username,
            current_item: parseInt(current_item) || 0,
            last_active: currentTime,
            session_start: existingUser ? existingUser.session_start : currentTime
        });

        res.json({ 
            success: true,
            logged_activity: {
                username: username,
                current_item: parseInt(current_item) || 0,
                timestamp: currentTime
            }
        });
    } catch (error) {
        console.error('Activity tracking error:', error);
        res.status(500).json({ error: 'Failed to track user activity' });
    }
});

// Export data
app.get('/api/export', (req, res) => {
    try {
        const format = req.query.format || 'edits_only';
        
        if (format === 'edits_only') {
            // Export human edits only (memory-safe)
            if (humanEdits.length === 0) {
                return res.status(404).json({ 
                    error: 'No human edits available for export',
                    suggestion: 'Start editing some items first'
                });
            }

            const headers = [
                'index', 'original_translation', 'edited_translation', 
                'editor', 'timestamp', 'notes', 'quality_score'
            ];
            let csvContent = headers.join(',') + '\n';

            humanEdits.forEach(edit => {
                const row = headers.map(header => {
                    const value = String(edit[header] || '');
                    return '"' + value.replace(/"/g, '""') + '"';
                });
                csvContent += row.join(',') + '\n';
            });

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `yoruba_human_edits_${timestamp}.csv`;
            
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.send(csvContent);

            console.log(`📥 Export completed: ${filename} (${humanEdits.length} edits)`);
        } else {
            // For complete dataset, recommend downloading from Google Drive
            res.json({
                message: 'Complete dataset export not available via web interface',
                reason: 'Dataset is too large (250+ MB) for web export',
                alternatives: {
                    human_edits_only: `${req.protocol}://${req.get('host')}/api/export?format=edits_only`,
                    google_drive_access: `https://drive.google.com/drive/folders/${DRIVE_FOLDER_ID}`,
                    files_available: [
                        'translated_1M_final.csv - Complete dataset with machine translations',
                        'human_edits.csv - Human corrections and improvements'
                    ]
                },
                instructions: 'Download both files from Google Drive and merge them locally for complete dataset'
            });
        }
    } catch (error) {
        console.error('Export error:', error);
        res.status(500).json({ error: 'Export operation failed' });
    }
});

// Serve main application
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler
app.use((error, req, res, next) => {
    console.error('🚨 Unhandled server error:', {
        message: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
        url: req.url,
        method: req.method,
        timestamp: new Date().toISOString()
    });
    
    systemStats.errorCount++;
    
    if (!res.headersSent) {
        res.status(500).json({ 
            error: 'Internal server error',
            message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong',
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
            url: req.url,
            available_endpoints: [
                'GET /',
                'GET /api/health',
                'GET /api/stats',
                'GET /api/item/:index',
                'POST /api/lock/:index',
                'POST /api/unlock/:index',
                'POST /api/save',
                'POST /api/activity',
                'GET /api/export',
                'GET /api/image-proxy?url=...'
            ]
        });
    }
});

// Cleanup functions
function cleanupInactiveUsers() {
    const now = Date.now();
    let cleanedUp = 0;
    
    for (const [username, userData] of activeUsers.entries()) {
        const lastActiveTime = new Date(userData.last_active).getTime();
        const inactiveMinutes = (now - lastActiveTime) / 1000 / 60;
        
        if (inactiveMinutes > 15) { // 15 minutes of inactivity
            activeUsers.delete(username);
            cleanedUp++;
        }
    }
    
    if (cleanedUp > 0) {
        console.log(`🧹 Cleaned up ${cleanedUp} inactive users`);
    }
}

// Periodic maintenance tasks
setInterval(cleanupInactiveUsers, 5 * 60 * 1000); // Every 5 minutes
setInterval(performDataSync, 15 * 60 * 1000); // Every 15 minutes
setInterval(() => {
    // Auto-save edits
    if (humanEdits.length > 0) {
        saveEditsToGoogleDrive().catch(error => 
            console.error('Scheduled save failed:', error.message)
        );
    }
}, 10 * 60 * 1000); // Every 10 minutes

// Graceful shutdown handlers
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

async function gracefulShutdown(signal) {
    console.log(`\n📴 Received ${signal}. Shutting down gracefully...`);
    
    // Save any pending edits
    if (humanEdits.length > 0) {
        console.log('💾 Saving final edits before shutdown...');
        await saveEditsToGoogleDrive();
    }
    
    console.log('✅ Graceful shutdown completed');
    process.exit(0);
}

// Start the server
async function startServer() {
    console.log('🔧 Initializing server components...');
    
    // Validate environment
    if (!DRIVE_FOLDER_ID) {
        console.error('❌ DRIVE_FOLDER_ID not configured in environment variables');
        console.error('💡 Set DRIVE_FOLDER_ID in your .env file or hosting platform');
        process.exit(1);
    }
    
    // Initialize Google Drive
    const driveReady = await initializeGoogleDrive();
    if (!driveReady) {
        console.error('❌ Google Drive initialization failed');
        console.error('💡 Check your credentials and network connection');
        process.exit(1);
    }
    
    // Perform initial data sync
    const syncSuccessful = await performDataSync();
    if (!syncSuccessful) {
        console.warn('⚠️ Initial data sync failed');
        console.warn('💡 Server will start with limited functionality');
    }
    
    // Start HTTP server
    const server = app.listen(PORT, () => {
        const memoryUsage = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        
        console.log('\n' + '='.repeat(80));
        console.log('🌟 YORUBA CAPTION EDITOR - SERVER READY');
        console.log(`📅 Started: 2025-10-16 02:15:07 UTC`);
        console.log(`👤 Primary User: TamynatorSama`);
        console.log(`🌐 Server URL: http://localhost:${PORT}`);
        console.log(`📊 Dataset: ${datasetInfo.total?.toLocaleString() || 0} items`);
        console.log(`✏️ Human Edits: ${humanEdits.length.toLocaleString()}`);
        console.log(`💾 Memory Usage: ${memoryUsage}MB (optimized)`);
        console.log(`📁 Google Drive Folder: ${DRIVE_FOLDER_ID}`);
        console.log(`🔄 Auto-sync: Every 15 minutes`);
        console.log(`💾 Auto-save: Every 10 minutes`);
        console.log(`🧹 Cleanup: Every 5 minutes`);
        console.log('='.repeat(80));
        console.log('✅ Ready for collaborative Yoruba caption editing!');
    });
    
    // Handle server errors
    server.on('error', (error) => {
        console.error('❌ Server error:', error);
        if (error.code === 'EADDRINUSE') {
            console.error(`💡 Port ${PORT} is already in use. Try a different port.`);
        }
        process.exit(1);
    });
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', error);
    console.error('Stack:', error.stack);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Promise Rejection:', reason);
    console.error('Promise:', promise);
    systemStats.errorCount++;
});

// Initialize and start the server
startServer().catch((error) => {
    console.error('💥 Server startup failed:', error);
    process.exit(1);
});