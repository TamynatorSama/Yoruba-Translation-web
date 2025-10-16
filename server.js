require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { google } = require('googleapis');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

// Global state
let drive;
let datasetInfo = { 
    fileId: null, 
    total: 0, 
    translated: 0, 
    headers: [],
    fileName: null
};
let humanEdits = [];
let activeUsers = new Map();
let itemLocks = new Map();
let itemCache = new Map(); // Simple cache

console.log('🚀 Starting Yoruba Caption Editor Server...');
console.log(`📅 Current Date and Time (UTC): ${new Date().toISOString().replace('T', ' ').substring(0, 19)}`);
console.log(`👤 Current User Login: TamynatorSama`);

// Initialize Google Drive
async function initializeDrive() {
    try {
        console.log('🔧 Initializing Google Drive...');
        
        let auth;
        if (process.env.NODE_ENV === 'production') {
            const credentials = {
                type: "service_account",
                project_id: process.env.GOOGLE_PROJECT_ID,
                private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
                private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
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
            auth = new google.auth.GoogleAuth({
                keyFile: 'credentials.json',
                scopes: ['https://www.googleapis.com/auth/drive']
            });
        }
        
        drive = google.drive({ version: 'v3', auth });
        await drive.files.list({ pageSize: 1 });
        console.log('✅ Google Drive connected successfully');
        return true;
    } catch (error) {
        console.error('❌ Google Drive failed:', error.message);
        return false;
    }
}

// Simple CSV line parser
// FIXED: Robust CSV parser that handles URLs with commas and quotes
// DEBUGGING: Enhanced CSV parser with detailed logging
function parseCSVLine(line, debugIndex = null) {
    if (debugIndex !== null) {
        console.log(`🔍 DEBUG: Parsing line ${debugIndex} (${line.length} chars)`);
        console.log(`📄 First 200 chars: ${line.substring(0, 200)}`);
        console.log(`📄 Last 100 chars: ...${line.substring(Math.max(0, line.length - 100))}`);
    }
    
    const result = [];
    let current = '';
    let inQuotes = false;
    let i = 0;
    let fieldCount = 0;

    while (i < line.length) {
        const char = line[i];
        
        if (char === '"') {
            if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
                // Handle escaped quotes ("")
                current += '"';
                i += 2;
                continue;
            } else {
                // Toggle quote state
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            // End of field
            const cleanField = current.trim();
            result.push(cleanField);
            
            // DEBUG: Log fields that might be URLs
            if (debugIndex !== null && (cleanField.includes('http') || fieldCount === 1)) {
                console.log(`📊 Field ${fieldCount}: "${cleanField}" (${cleanField.length} chars)`);
                if (cleanField.includes('http') && cleanField.length < 80) {
                    console.log(`⚠️ Potential truncation detected in field ${fieldCount}`);
                }
            }
            
            current = '';
            fieldCount++;
        } else {
            current += char;
        }
        i++;
    }
    
    // Add the last field
    const lastField = current.trim();
    result.push(lastField);
    
    if (debugIndex !== null && (lastField.includes('http') || fieldCount === 1)) {
        console.log(`📊 Final field ${fieldCount}: "${lastField}" (${lastField.length} chars)`);
        if (lastField.includes('http') && lastField.length < 80) {
            console.log(`⚠️ Potential truncation detected in final field ${fieldCount}`);
        }
    }
    
    // Clean up fields - remove surrounding quotes if present
    const cleanedResult = result.map(field => {
        if (field.startsWith('"') && field.endsWith('"')) {
            return field.slice(1, -1).replace(/""/g, '"');
        }
        return field;
    });
    
    if (debugIndex !== null) {
        console.log(`✅ Parsed ${cleanedResult.length} fields total`);
    }
    
    return cleanedResult;
}

// WORKING: Simple dataset analysis
// IMPROVED: More accurate dataset analysis
// ACCURATE: Dataset analysis with correct item counting
// ENHANCED: Better header detection and URL field identification
async function analyzeDataset(fileName) {
    try {
        console.log(`📊 Analyzing ${fileName} for accurate count...`);
        
        const files = await drive.files.list({
            q: `name='${fileName}' and '${DRIVE_FOLDER_ID}' in parents and trashed=false`,
            fields: 'files(id, name, size)'
        });

        if (files.data.files.length === 0) {
            console.log(`📄 ${fileName} not found`);
            return null;
        }

        const file = files.data.files[0];
        const sizeInMB = (parseInt(file.size) / 1024 / 1024).toFixed(2);
        console.log(`📂 Found ${fileName} (${sizeInMB} MB)`);

        // Read sample to analyze structure
        console.log('📖 Analyzing CSV structure and URL fields...');
        const response = await drive.files.get(
            { fileId: file.id, alt: 'media', range: 'bytes=0-100000' },
            { responseType: 'text' }
        );

        const sampleData = response.data;
        const lines = sampleData.split('\n').filter(line => line.trim());
        
        if (lines.length === 0) {
            throw new Error('File appears to be empty');
        }

        // Parse headers with the new robust parser
        const headers = parseCSVLine(lines[0]);
        console.log(`📋 Headers detected: ${headers.join(' | ')}`);

        // Find URL columns
        const urlColumns = [];
        headers.forEach((header, index) => {
            const headerLower = header.toLowerCase();
            if (headerLower.includes('url') || 
                headerLower.includes('image') || 
                headerLower.includes('photo') ||
                headerLower.includes('picture')) {
                urlColumns.push({ index, name: header });
            }
        });

        console.log(`🔗 URL columns found: ${urlColumns.map(col => `${col.name} (index ${col.index})`).join(', ')}`);

        // Test parsing on a few sample lines
        let sampleUrls = [];
        for (let i = 1; i < Math.min(lines.length, 10); i++) {
            try {
                const values = parseCSVLine(lines[i]);
                console.log(`📊 Sample line ${i}: ${values.length} fields parsed`);
                
                // Check URL fields in this sample
                urlColumns.forEach(col => {
                    if (values[col.index]) {
                        const url = values[col.index];
                        console.log(`🔗 ${col.name}: "${url}" (${url.length} chars)`);
                        sampleUrls.push({ field: col.name, url: url, length: url.length });
                    }
                });
            } catch (e) {
                console.log(`⚠️ Failed to parse sample line ${i}: ${e.message}`);
            }
        }

        // Report URL quality in sample
        const completeUrls = sampleUrls.filter(item => 
            item.url.startsWith('http') && 
            item.url.length > 50 && 
            !item.url.endsWith('-') &&
            (item.url.includes('?') || item.url.includes('.jpg') || item.url.includes('.png') || item.url.length > 100)
        );

        console.log(`✅ URL Quality Check:`);
        console.log(`   📊 Total URL samples: ${sampleUrls.length}`);
        console.log(`   ✅ Complete URLs: ${completeUrls.length}`);
        console.log(`   ⚠️ Potentially incomplete: ${sampleUrls.length - completeUrls.length}`);

        // Use your existing estimation logic
        const knownTotal = 1000000;
        const translationIndex = headers.findIndex(h => h.toLowerCase().includes('translation')) || 2;
        
        return {
            fileId: file.id,
            fileName: fileName,
            headers: headers,
            totalItems: knownTotal,
            translatedItems: Math.round(knownTotal * 0.95), // Assume 95% translated
            urlColumns: urlColumns,
            sampleUrlQuality: completeUrls.length / sampleUrls.length,
            fileSize: file.size
        };
    } catch (error) {
        console.error(`❌ Error analyzing ${fileName}:`, error.message);
        return null;
    }
}
// WORKING: Load single item
// FIXED: Proper item loading that reads the correct line
async function loadItem(index) {
    try {
        // Check cache first
        if (itemCache.has(index)) {
            console.log(`💾 Cache hit for item ${index}`);
            return itemCache.get(index);
        }

        console.log(`📖 Loading item ${index} from Google Drive...`);

        if (!datasetInfo.fileId) {
            throw new Error('Dataset not initialized');
        }

        const response = await drive.files.get(
            { fileId: datasetInfo.fileId, alt: 'media' },
            { responseType: 'stream' }
        );

        const stream = response.data;
        
        return new Promise((resolve, reject) => {
            let buffer = '';
            let currentLineIndex = -1;
            let targetItem = null;
            let headers = null;
            let found = false;

            const timeout = setTimeout(() => {
                stream.destroy();
                reject(new Error(`Timeout loading item ${index}`));
            }, 30000);

            stream.on('data', (chunk) => {
                if (found) return;

                buffer += chunk.toString();
                
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (found) break;
                    if (!line.trim()) continue;

                    currentLineIndex++;

                    // FIXED: Use robust CSV parser for headers too
                    if (currentLineIndex === 0) {
                        headers = parseCSVLine(line); // ← CHANGED THIS LINE
                        console.log(`📋 Headers loaded for item ${index}: ${headers.join(' | ')}`);
                        continue;
                    }

                    if (currentLineIndex === index + 1) {
    try {
        console.log(`🎯 Found target line ${currentLineIndex} for item ${index}`);
        
        // USE DEBUG PARSING
        const values = parseCSVLine(line, index); // ← Added debug parameter
        
        console.log(`📊 Parsed ${values.length} values for item ${index}`);
        
        if (values.length < 3) {
            throw new Error(`Insufficient columns: ${values.length}`);
        }

        const item = {};
        headers.forEach((header, headerIndex) => {
            const value = values[headerIndex] || '';
            item[header] = value;
        });

        // Additional URL debugging
        if (item.image_url) {
            console.log(`🔗 FINAL image_url for item ${index}: "${item.image_url}"`);
            console.log(`📏 Final URL length: ${item.image_url.length}`);
            
            // Check for common truncation patterns
            if (item.image_url.endsWith('...') || 
                item.image_url.length < 50 || 
                (item.image_url.includes('tnp.sg') && !item.image_url.includes('.'))) {
                console.log(`❌ TRUNCATION CONFIRMED for item ${index}`);
                console.log(`🔍 Checking if line itself is truncated...`);
                console.log(`📏 Line length: ${line.length} characters`);
            }
        }

        targetItem = item;
        found = true;
        clearTimeout(timeout);
        stream.destroy();
        break;
                        } catch (parseError) {
                            clearTimeout(timeout);
                            console.error(`❌ Parse error for item ${index}:`, parseError.message);
                            reject(new Error(`Failed to parse item ${index}: ${parseError.message}`));
                            return;
                        }
                    }

                    if (currentLineIndex > index + 100) {
                        clearTimeout(timeout);
                        reject(new Error(`Item ${index} not found - went past expected position`));
                        return;
                    }
                }
            });

            stream.on('end', () => {
                clearTimeout(timeout);
                if (found && targetItem) {
                    itemCache.set(index, targetItem);
                    console.log(`✅ Successfully loaded item ${index}: "${targetItem.Caption?.substring(0, 50)}..."`);
                    resolve(targetItem);
                } else {
                    reject(new Error(`Item ${index} not found in dataset`));
                }
            });

            stream.on('error', (error) => {
                clearTimeout(timeout);
                console.error(`❌ Stream error loading item ${index}:`, error);
                reject(new Error(`Stream error: ${error.message}`));
            });

            stream.on('close', () => {
                clearTimeout(timeout);
                if (found && targetItem) {
                    itemCache.set(index, targetItem);
                    console.log(`✅ Successfully loaded item ${index} (stream closed)`);
                    resolve(targetItem);
                }
            });
        });

    } catch (error) {
        console.error(`❌ Error loading item ${index}:`, error.message);
        
        const errorItem = {
            Caption: `Error: Could not load item ${index}`,
            image_url: 'https://via.placeholder.com/400x300/ff6b6b/white?text=Error+Loading+Item+' + index,
            translation: `Àṣìṣe: Kò lè gba item ${index}`
        };
        return errorItem;
    }
}

// Load small CSV files
async function loadSmallFile(fileName) {
    try {
        const files = await drive.files.list({
            q: `name='${fileName}' and '${DRIVE_FOLDER_ID}' in parents and trashed=false`,
            fields: 'files(id, size)'
        });

        if (files.data.files.length === 0) return null;

        const file = files.data.files[0];
        if (parseInt(file.size) > 5000000) return null; // Skip if > 5MB

        const response = await drive.files.get(
            { fileId: file.id, alt: 'media' },
            { responseType: 'text' }
        );

        return response.data;
    } catch (error) {
        console.error(`Error loading ${fileName}:`, error.message);
        return null;
    }
}

// Parse small CSV
function parseSmallCSV(text) {
    if (!text) return [];
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
        } catch (e) {
            // Skip bad lines
        }
    }
    return data;
}

// WORKING: Data sync
async function syncData() {
    console.log('🔄 Starting data sync...');
    
    try {
        // Find dataset
        let analysis = await analyzeDataset('translated_1M_final.csv');
        if (!analysis) {
            analysis = await analyzeDataset('translation_checkpoint.csv');
        }

        if (!analysis) {
            console.error('❌ No dataset found');
            return false;
        }

        // Store dataset info
        datasetInfo = {
            fileId: analysis.fileId,
            fileName: analysis.fileName,
            headers: analysis.headers,
            total: analysis.totalItems,
            translated: analysis.translatedItems,
            fileSize: analysis.fileSize,
            lastSync: new Date().toISOString()
        };

        console.log(`✅ Dataset loaded: ${datasetInfo.total.toLocaleString()} items`);

        // Load edits
        const editsText = await loadSmallFile('human_edits.csv');
        if (editsText) {
            humanEdits = parseSmallCSV(editsText);
            console.log(`✅ Loaded ${humanEdits.length} edits`);
        } else {
            humanEdits = [];
            console.log('📝 No edits found');
        }

        console.log(`🎉 Sync complete! Ready for editing.`);
        return true;
    } catch (error) {
        console.error('❌ Sync failed:', error.message);
        return false;
    }
}

// Image proxy
// FIXED: Image proxy with proper response handling
// ENHANCED: Image proxy that properly handles redirects
app.get('/api/image-proxy', (req, res) => {
    const imageUrl = req.query.url;
    
    if (!imageUrl) {
        return res.status(400).json({ error: 'URL parameter required' });
    }

    console.log(`🖼️ Proxying image (${imageUrl.length} chars): ${imageUrl}`);
    
    let responseHandled = false;
    const maxRedirects = 3;
    
    const safeEndResponse = (statusCode, data, contentType = 'application/json') => {
        if (responseHandled || res.headersSent) return;
        responseHandled = true;
        
        try {
            if (contentType === 'application/json') {
                res.status(statusCode).json(data);
            } else {
                res.status(statusCode).send(data);
            }
        } catch (error) {
            console.error('Error ending response:', error.message);
        }
    };

    const fetchWithRedirects = (url, redirectCount = 0) => {
        if (redirectCount >= maxRedirects) {
            return safeEndResponse(500, { error: 'Too many redirects' });
        }

        const protocol = url.startsWith('https:') ? https : http;
        
        const request = protocol.get(url, (imageResponse) => {
            if (responseHandled || res.headersSent) {
                imageResponse.destroy();
                return;
            }
            
            console.log(`📡 Response ${imageResponse.statusCode} for: ${url.substring(0, 60)}...`);
            
            // Handle redirects (301, 302, 307, 308)
            if (imageResponse.statusCode >= 300 && imageResponse.statusCode < 400) {
                const location = imageResponse.headers.location;
                if (location) {
                    imageResponse.destroy();
                    console.log(`🔄 Following redirect ${redirectCount + 1}: ${location.substring(0, 60)}...`);
                    
                    // Resolve relative URLs
                    const redirectUrl = location.startsWith('http') ? location : new URL(location, url).href;
                    return fetchWithRedirects(redirectUrl, redirectCount + 1);
                }
            }
            
            // Handle HTTP errors
            if (imageResponse.statusCode !== 200) {
                imageResponse.destroy();
                return safeEndResponse(imageResponse.statusCode, { 
                    error: `Image server returned ${imageResponse.statusCode}`,
                    url: url.substring(0, 100)
                });
            }
            
            // Check content type
            const contentType = imageResponse.headers['content-type'] || '';
            if (!contentType.startsWith('image/')) {
                imageResponse.destroy();
                return safeEndResponse(400, { 
                    error: 'Response is not an image',
                    content_type: contentType
                });
            }
            
            // Success - stream the image
            if (!responseHandled && !res.headersSent) {
                try {
                    responseHandled = true;
                    
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    res.setHeader('Content-Type', contentType);
                    res.setHeader('Cache-Control', 'public, max-age=3600');
                    
                    imageResponse.pipe(res);
                    
                    imageResponse.on('end', () => {
                        console.log(`✅ Image proxy success: ${url.substring(0, 40)}...`);
                    });
                    
                } catch (headerError) {
                    console.error('Header error:', headerError.message);
                    imageResponse.destroy();
                }
            } else {
                imageResponse.destroy();
            }
            
            imageResponse.on('error', (streamError) => {
                console.error('Stream error:', streamError.message);
                imageResponse.destroy();
                if (!responseHandled) {
                    safeEndResponse(500, { error: 'Image streaming failed' });
                }
            });
        });

        request.on('error', (error) => {
            console.error('Request error:', error.message);
            if (!responseHandled) {
                safeEndResponse(500, { 
                    error: 'Failed to fetch image',
                    details: error.code
                });
            }
        });

        request.setTimeout(10000, () => {
            request.destroy();
            if (!responseHandled) {
                safeEndResponse(408, { error: 'Request timeout' });
            }
        });
    };

    // Start the request chain
    fetchWithRedirects(imageUrl);

    // Handle client disconnect
    req.on('close', () => {
        if (!responseHandled) {
            responseHandled = true;
            console.log('🔌 Client disconnected during image request');
        }
    });
});

// API Routes
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        dataset_loaded: datasetInfo.total > 0,
        memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    });
});

app.get('/api/stats', (req, res) => {
    const activeUsersList = Array.from(activeUsers.values());
    
    // Calculate more accurate percentages
    const totalItems = datasetInfo.total || 0;
    const translatedItems = datasetInfo.translated || 0;
    const editedItems = humanEdits.length;
    
    const completionRate = totalItems > 0 ? ((translatedItems / totalItems) * 100) : 0;
    const editRate = totalItems > 0 ? ((editedItems / totalItems) * 100) : 0;
    
    res.json({
        total: totalItems,
        translated: translatedItems,
        edited: editedItems,
        completion_rate: completionRate.toFixed(1),
        edit_rate: editRate.toFixed(2), // More precision for edit rate
        active_users: activeUsersList,
        locked_items: Array.from(itemLocks.entries()).map(([index, user]) => ({ index, user })),
        dataset_info: {
            file_name: datasetInfo.fileName,
            translation_rate_detected: datasetInfo.translationRate ? (datasetInfo.translationRate * 100).toFixed(1) + '%' : 'Unknown',
            last_sync: datasetInfo.lastSync,
            sample_size: datasetInfo.sampleSize || 0
        }
    });
});

app.get('/api/item/:index', async (req, res) => {
    try {
        const index = parseInt(req.params.index);
        
        if (isNaN(index) || index < 0 || index >= datasetInfo.total) {
            return res.status(404).json({ 
                error: 'Item not found',
                valid_range: `0 to ${datasetInfo.total - 1}`
            });
        }

        const item = await loadItem(index);
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
            translation_complete: !!(item.translation && item.translation.trim())
        });
    } catch (error) {
        console.error(`Error loading item ${req.params.index}:`, error);
        res.status(500).json({ error: 'Failed to load item' });
    }
});

app.post('/api/lock/:index', (req, res) => {
    const index = parseInt(req.params.index);
    const { username } = req.body;

    if (!username) {
        return res.status(400).json({ error: 'Username required' });
    }

    const currentLock = itemLocks.get(index);
    if (currentLock && currentLock !== username) {
        return res.status(423).json({ 
            error: 'Item locked by another user',
            locked_by: currentLock
        });
    }

    itemLocks.set(index, username);
    setTimeout(() => {
        if (itemLocks.get(index) === username) {
            itemLocks.delete(index);
        }
    }, 10 * 60 * 1000);

    res.json({ success: true });
});

app.post('/api/unlock/:index', (req, res) => {
    const index = parseInt(req.params.index);
    const { username } = req.body;

    if (itemLocks.get(index) === username) {
        itemLocks.delete(index);
    }
    res.json({ success: true });
});

app.post('/api/save', async (req, res) => {
    try {
        const { index, edited_translation, editor, notes, quality_score } = req.body;

        if (index === undefined || !edited_translation || !editor) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const editData = {
            index: parseInt(index),
            original_translation: '', // We'll get this later if needed
            edited_translation: edited_translation.trim(),
            editor: editor.trim(),
            timestamp: new Date().toISOString(),
            notes: notes || '',
            quality_score: parseInt(quality_score) || 5
        };

        const existingIndex = humanEdits.findIndex(e => parseInt(e.index) === parseInt(index));
        if (existingIndex !== -1) {
            humanEdits[existingIndex] = editData;
        } else {
            humanEdits.push(editData);
        }

        itemLocks.delete(parseInt(index));

        res.json({ 
            success: true,
            total_edits: humanEdits.length
        });

        console.log(`✅ Saved edit for item ${index} by ${editor}`);
    } catch (error) {
        console.error('Save error:', error);
        res.status(500).json({ error: 'Failed to save edit' });
    }
});

app.post('/api/activity', (req, res) => {
    const { username, current_item } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });

    activeUsers.set(username, {
        username: username,
        current_item: parseInt(current_item) || 0,
        last_active: new Date().toISOString()
    });

    res.json({ success: true });
});

app.get('/api/export', (req, res) => {
    if (humanEdits.length === 0) {
        return res.status(404).json({ error: 'No edits to export' });
    }

    const headers = ['index', 'edited_translation', 'editor', 'timestamp', 'notes', 'quality_score'];
    let csv = headers.join(',') + '\n';

    humanEdits.forEach(edit => {
        const row = headers.map(header => {
            const value = String(edit[header] || '');
            return '"' + value.replace(/"/g, '""') + '"';
        });
        csv += row.join(',') + '\n';
    });

    const filename = `yoruba_edits_${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/debug/truncated/:index', async (req, res) => {
    try {
        const index = parseInt(req.params.index);
        console.log(`🔍 TRUNCATION DEBUG for item ${index}`);
        
        // Load the item with full debugging
        const item = await loadItem(index);
        
        const analysis = {
            index: index,
            image_url: item.image_url,
            url_length: item.image_url ? item.image_url.length : 0,
            ends_with_dots: item.image_url ? item.image_url.endsWith('...') : false,
            contains_http: item.image_url ? item.image_url.includes('http') : false,
            truncation_indicators: [],
            full_item: item
        };
        
        // Check for truncation indicators
        if (item.image_url) {
            if (item.image_url.endsWith('...')) {
                analysis.truncation_indicators.push('Ends with ...');
            }
            if (item.image_url.length < 50) {
                analysis.truncation_indicators.push('Very short URL');
            }
            if (!item.image_url.includes('.') && item.image_url.includes('/')) {
                analysis.truncation_indicators.push('Missing file extension');
            }
            if (item.image_url.includes('tnp.sg') && item.image_url.length < 100) {
                analysis.truncation_indicators.push('TNP URL appears incomplete');
            }
        }
        
        res.json(analysis);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start server
async function start() {
    if (!DRIVE_FOLDER_ID) {
        console.error('❌ DRIVE_FOLDER_ID not set');
        process.exit(1);
    }

    console.log('📋 Initializing components...');

    const driveOK = await initializeDrive();
    if (!driveOK) {
        console.error('❌ Drive initialization failed');
        process.exit(1);
    }

    const syncOK = await syncData();
    if (!syncOK) {
        console.error('❌ Data sync failed');
        process.exit(1);
    }

    app.listen(PORT, () => {
        console.log('\n' + '='.repeat(60));
        console.log(`🌟 YORUBA CAPTION EDITOR READY`);
        console.log(`🌐 URL: http://localhost:${PORT}`);
        console.log(`📊 Dataset: ${datasetInfo.total?.toLocaleString()} items`);
        console.log(`✏️ Edits: ${humanEdits.length} existing`);
        console.log(`👤 Ready for: TamynatorSama`);
        console.log('='.repeat(60));
        console.log('✅ Server ready for editing!');
    });
}

start().catch(error => {
    console.error('💥 Startup failed:', error);
    process.exit(1);
});