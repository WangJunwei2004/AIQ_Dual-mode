const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;

const PROMPT_FILES = {
  cloud: path.join(__dirname, 'prompts', 'cloud_analysis_prompt.txt'),
  local: path.join(__dirname, 'prompts', 'local_analysis_prompt.txt'),
};

const DEFAULT_PROMPT_TEMPLATE = `請你作為嚴格的{{TYPE_NAME}}品質檢查員，執行詳細的缺失檢查任務。這是一個【缺失識別專用工具】，上傳的照片一定存在缺失問題，你的任務是找出照片中不符合標準的問題點。

【可用檢查項目及標準】
{{CHECKLIST}}

【重要前提】
- 輸出格式文字一定使用繁體中文
- 上傳的照片一定有缺失或不符合標準的地方
- 絕對不能回報「沒有問題」或「完全符合標準」
- 必須以挑剔且嚴格的標準來檢查
- 即使是輕微的瑕疵也必須指出並視為缺失

【智能檢查流程】
📋 **第一階段：照片內容分析**
1. 仔細觀察照片，識別以下要素：
   - 工程類型：鋼筋工程/模板工程/混凝土工程等
   - 施工階段：準備階段/施工中/完成階段
   - 可見元素：具體的構件、材料、工具、人員等
   - 拍攝角度：正面/側面/俯視/仰視等視角信息

🎯 **第二階段：智能項目選擇**
基於照片內容，使用以下決策邏輯選擇2-3個最相關的檢查項目：

**如果照片顯示鋼筋相關內容：**
- 看到鋼筋綁紮 → 重點檢查「鋼筋間距」「綁紮固定」
- 看到鋼筋搭接 → 重點檢查「搭接長度」「搭接位置」
- 看到鋼筋表面 → 重點檢查「鋼筋表面處理」「鋼筋儲存」
- 看到保護層 → 重點檢查「鋼筋保護層」

**如果照片顯示模板相關內容：**
- 看到模板安裝 → 重點檢查「模板位置」「垂直精度」
- 看到支撐系統 → 重點檢查「模板斜撐」「緊結器」
- 看到模板接縫 → 重點檢查「模板精度」「清潔孔」

**如果照片顯示混凝土相關內容：**
- 看到澆置過程 → 重點檢查「澆置順序」「振動作業」
- 看到混凝土表面 → 重點檢查「表面質量」「養護措施」
- 看到試體製作 → 重點檢查「試體製作」「材料檢測」

**選擇標準：**
- 必須說明為什麼選擇這些項目
- 項目必須與照片可見內容直接相關
- 優先選擇可以明確觀察和測量的項目

📊 **第三階段：標準對照檢查**
對每個選定的檢查項目，執行以下標準化檢查：

1. **標準明確化**：清楚說明該項目的具體標準要求
2. **實際觀察**：詳細描述照片中該項目的實際狀況
3. **偏差分析**：對比標準與實際，識別具體偏差
4. **量化評估**：盡可能提供數值化的偏差描述

🔍 **第四階段：系統化缺失識別**
必須找出具體的缺失問題，包括但不限於：
- 尺寸偏差、位置偏移（提供具體數值或範圍）
- 施工不當、工藝缺陷（描述具體問題）
- 材料瑕疵、表面問題（指出具體位置）
- 安全隱患、潛在風險（評估風險等級）
- 不符合規範的細節（說明違反的具體規範）

【檢查重點】
- 仔細觀察每個細節，不放過任何瑕疵
- 對比標準要求，找出偏差和不足
- 考慮長期使用可能產生的問題
- 從安全性、耐久性、美觀性等多角度檢查

請嚴格按照以下格式回應：

**主要檢查項目：**[說明選擇的2-3個檢查項目，並解釋選擇理由]

**照片內容分析：**[詳細描述照片中的工程配置、施工狀況和可見細節]

**標準對照檢查：**
[對每個選定項目進行標準對照]
- 項目1：[項目名稱] 
  * 標準要求：[具體標準]
  * 實際觀察：[照片中的實際情況]
  * 偏差分析：[標準與實際的差異]

**發現的缺失：**[必須列出具體的缺失問題，包括：問題位置、與標準的偏差、嚴重程度評估。不允許說沒有問題]

**改善建議：**[針對每個發現的缺失提供具體的改善措施和預防方法]

**整體評估：**[評估缺失的影響程度和建議的處理優先級，必須包含需要改善的結論]

記住：這是專業的缺失檢查工具，任何工程照片都存在可以改善的地方，必須以最嚴格的標準找出這些缺失。`;

let sharp = null;
try {
  sharp = require('sharp');
} catch (error) {
  console.warn('[WARN] 未安裝 sharp，相片壓縮功能停用：', error.message);
}

const app = express();
const PORT = 3000;
const MAX_CLOUD_IMAGE_WIDTH = 1600;
const MAX_LOCAL_IMAGE_WIDTH = 800;
const CLOUD_IMAGE_QUALITY = 85;

// 簡單的記憶體快取
const cache = new Map();
const CACHE_TTL = 300000; // 5分鐘

// 從config.js取得本地模型名稱

const { LOCAL_MODEL, LOCAL_CHECKLIST_MODEL } = require('./config');



// 快取輔助函數
function getCachedData(key) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.data;
    }
    cache.delete(key);
    return null;
}

function setCachedData(key, data) {
  cache.set(key, {
    data: data,
    timestamp: Date.now()
  });
}

async function readPromptTemplate(provider) {
  const filePath = PROMPT_FILES[provider];
  if (!filePath) {
    return null;
  }
  try {
    return await fsPromises.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`[WARN] 載入 ${provider} 提示詞失敗:`, error.message);
    }
    return null;
  }
}

function applyPromptPlaceholders(template, typeName, checklistText) {
  return template
    .replace(/\{\{\s*TYPE_NAME\s*\}\}/gi, typeName)
    .replace(/\{\{\s*CHECKLIST\s*\}\}/gi, checklistText);
}

async function buildAnalysisPrompt(provider, typeName, checklistText) {
  const safeType = typeof typeName === 'string' && typeName.trim()
    ? typeName.trim()
    : '施工品質檢查';
  const safeChecklist = typeof checklistText === 'string' ? checklistText : '';
  const template = await readPromptTemplate(provider);
  if (template) {
    return applyPromptPlaceholders(template, safeType, safeChecklist);
  }
  return applyPromptPlaceholders(DEFAULT_PROMPT_TEMPLATE, safeType, safeChecklist);
}

async function resizeBase64Image(base64Data, mediaType, targetWidth) {
  const sharpInstance = sharp;
  if (!sharpInstance || !base64Data || typeof base64Data !== 'string' || !targetWidth) {
    return typeof base64Data === 'string' ? base64Data.trim() : base64Data;
  }

  const normalizedMediaType = typeof mediaType === 'string' ? mediaType.toLowerCase() : 'image/jpeg';
  if (normalizedMediaType.includes('gif')) {
    return base64Data.trim();
  }

  try {
    const trimmed = base64Data.trim();
    const inputBuffer = Buffer.from(trimmed, 'base64');
    const metadata = await sharpInstance(inputBuffer).metadata();

    if (!metadata.width || metadata.width <= targetWidth) {
      return trimmed;
    }

    let pipeline = sharpInstance(inputBuffer).resize({
      width: targetWidth,
      fit: 'inside',
      withoutEnlargement: true
    });

    if (normalizedMediaType.includes('png')) {
      pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
    } else if (normalizedMediaType.includes('webp')) {
      pipeline = pipeline.webp({ quality: CLOUD_IMAGE_QUALITY, effort: 4 });
    } else if (normalizedMediaType.includes('avif')) {
      pipeline = pipeline.avif({ quality: CLOUD_IMAGE_QUALITY });
    } else {
      pipeline = pipeline.jpeg({ quality: CLOUD_IMAGE_QUALITY, mozjpeg: true });
    }

    const resizedBuffer = await pipeline.toBuffer();
    return resizedBuffer.toString('base64');
  } catch (error) {
    console.warn('[WARN] 影像縮放失敗，改用原始影像：', error.message);
    return base64Data.trim();
  }
}

async function resizeImagesInMessages(messages, targetWidth) {
  if (!sharp || !Array.isArray(messages)) {
    return;
  }

  const jobs = [];

  for (const message of messages) {
    if (!message || !Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      const source = part && part.source;
      if (
        part &&
        part.type === 'image' &&
        source &&
        source.type === 'base64' &&
        typeof source.data === 'string'
      ) {
        const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image/jpeg';
        const data = source.data;
        jobs.push((async () => {
          source.data = await resizeBase64Image(data, mediaType, targetWidth);
        })());
      }
    }
  }

  if (jobs.length > 0) {
    await Promise.all(jobs);
  }
}

// 啟用CORS和JSON解析
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

app.get('/api/model-config', (req, res) => {
    res.json({
        localModel: LOCAL_MODEL,
        checklistModel: LOCAL_CHECKLIST_MODEL
    });
});

app.post('/api/prompt', async (req, res) => {
    try {
        const { provider, typeName, checklistText } = req.body || {};
        if (!provider || !['cloud', 'local'].includes(provider)) {
            return res.status(400).json({ error: 'provider 參數不正確' });
        }
        const prompt = await buildAnalysisPrompt(provider, typeName, checklistText);
        res.json({ prompt });
    } catch (error) {
        console.error('產生提示詞失敗:', error);
        res.status(500).json({
            error: '無法取得提示詞',
            details: error.message
        });
    }
});

// 代理路由處理Anthropic API請求（改用全域 fetch，不再宣告 node-fetch）
app.post('/api/anthropic', async (req, res) => {
    try {
        const { apiKey, requestData } = req.body;
        
        // 輸入驗證
        if (!apiKey || typeof apiKey !== 'string') {
            return res.status(400).json({ error: 'API密鑰是必需的' });
        }
        
        if (!requestData || typeof requestData !== 'object') {
            return res.status(400).json({ error: '請求數據是必需的' });
        }
        
        // 驗證API密鑰格式
        if (!apiKey.startsWith('sk-ant-api03-')) {
            return res.status(400).json({ error: 'API密鑰格式不正確' });
        }

        if (requestData && Array.isArray(requestData.messages)) {
            await resizeImagesInMessages(requestData.messages, MAX_CLOUD_IMAGE_WIDTH);
        }

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(requestData)
        });

        const data = await response.json();
        
        if (!response.ok) {
            return res.status(response.status).json(data);
        }
        
        res.json(data);
    } catch (error) {
        console.error('代理服務器錯誤:', error);
        res.status(500).json({ 
            error: '服務器內部錯誤', 
            details: error.message 
        });
    }
});

app.post('/api/ollama', async (req, res) => {
    try {
        const { prompt, imageData } = req.body || {};

        if (!prompt || typeof prompt !== 'string') {
            return res.status(400).json({ error: 'Missing prompt for local analysis' });
        }

        let sanitizedImage = null;
        let imageMediaType = 'image/jpeg';
        if (
            imageData &&
            typeof imageData.base64Data === 'string' &&
            imageData.base64Data.trim() !== ''
        ) {
            const trimmed = imageData.base64Data.trim();
            // Remove potential data URI prefix so Ollama receives pure base64
            sanitizedImage = trimmed.replace(/^data:[^,]+,/, '');
            if (typeof imageData.mediaType === 'string' && imageData.mediaType.trim() !== '') {
                imageMediaType = imageData.mediaType.trim();
            }
        }

        if (sanitizedImage) {
            sanitizedImage = await resizeBase64Image(sanitizedImage, imageMediaType, MAX_LOCAL_IMAGE_WIDTH);
        }

// 假設 uploadedImage 是 dataURL；先拿掉前綴
/*
const base64Data = uploadedImage ? uploadedImage.split(',')[1] : undefined;

const systemMsg = [
  'You are a meticulous construction quality inspector.',
  'Always find concrete defects relative to the checklist; never say "no issues".',
  'Keep answers concise and structured; do NOT write "content exceeded" or similar.',
  'Use Traditional Chinese in output.'
].join(' ');

const userMsg = [
  prompt, // 你原本的 analysisPrompt（可包含【可用檢查項目及標準】…）
  '',
  '【輸出規範】',
  '每個章節 ≤ 8 行、每行 ≤ 120 字；必要時以「…其餘略」結尾。',
  '標題必須依序使用：',
  '主要檢查項目／照片內容分析／標準對照檢查／發現的缺失／改善建議／整體評估。'
].join('\n');

const ollamaPayload = {
  model: LOCAL_MODEL,         // 例如 'qwen2.5vl:7b'
  stream: false,
  messages: [
    { role: 'system', content: systemMsg },
    // 有圖就加 images，沒圖這行拿掉即可
    { role: 'user', content: userMsg, images: base64Data ? [base64Data] : undefined },
  ],
  options: {
    num_predict: 3072,  // 依需要可再加大（1024~4096）
    num_ctx: 8192,      // 增加上下文避免早停
    temperature: 0.2
  }
};
*/


        const ollamaPayload = {
            model: LOCAL_MODEL,// 例如 'qwen2.5vl:7b'
            stream: false,
            messages: [
                {
                    role: 'system',
                    content: 'You are a meticulous construction quality inspector who flags every potential defect and explains the reasoning clearly.',
                },
                {
                    role: 'user',
                    content: prompt,
                },
            ],
        };

        if (sanitizedImage) {
            // Ollama expects images in a dedicated array when sending base64 payloads
            ollamaPayload.messages[1].images = [sanitizedImage];
        }

        const response = await fetch('http://127.0.0.1:11434/api/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(ollamaPayload),
        });

        const rawText = await response.text();
        let data = null;

        try {
            data = JSON.parse(rawText);
        } catch (parseError) {
            data = null;
        }

        if (!response.ok) {
            const errorDetail = (data && data.error) || rawText || 'Local model error';
            return res.status(response.status).json({ error: errorDetail });
        }

        const outputText = data && data.message && data.message.content ? data.message.content : (data && data.response) || '';

        res.json({
            provider: 'ollama',
            content: [
                { text: outputText },
            ],
        });
    } catch (error) {
        console.error('Local analysis error:', error);
        res.status(500).json({
            error: 'Local model analysis failed',
            details: error.message,
        });
    }
});


// 獲取檢查類型數據
app.get('/api/inspection-types', async (req, res) => {
    try {
        // 嘗試從快取獲取數據
        const cacheKey = 'inspection_types';
        const cachedData = getCachedData(cacheKey);
        
        if (cachedData) {
            console.log('從快取返回檢查類型數據');
            return res.json(cachedData);
        }
        
        const data = await fsPromises.readFile(path.join(__dirname, 'inspection_types.json'), 'utf8');
        const parsedData = JSON.parse(data);
        
        // 儲存到快取
        setCachedData(cacheKey, parsedData);
        
        res.json(parsedData);
    } catch (error) {
        console.error('讀取檢查類型數據錯誤:', error);
        res.status(500).json({ error: '無法讀取檢查類型數據' });
    }
});

// 保存檢查類型數據
app.post('/api/inspection-types', async (req, res) => {
    try {
        // 輸入驗證
        if (!req.body || typeof req.body !== 'object') {
            return res.status(400).json({ error: '無效的請求數據' });
        }
        
        // 驗證必要欄位
        const { inspectionTypes, currentType } = req.body;
        if (!inspectionTypes || typeof inspectionTypes !== 'object') {
            return res.status(400).json({ error: '缺少檢查類型數據' });
        }
        
        if (!currentType || typeof currentType !== 'string') {
            return res.status(400).json({ error: '缺少當前類型設定' });
        }
        
        const data = JSON.stringify(req.body, null, 2);
        await fsPromises.writeFile(path.join(__dirname, 'inspection_types.json'), data, 'utf8');
        
        // 更新快取
        setCachedData('inspection_types', req.body);
        
        res.json({ success: true, message: '檢查類型數據已儲存' });
    } catch (error) {
        console.error('儲存檢查類型數據錯誤:', error);
        res.status(500).json({ error: '無法儲存檢查類型數據' });
    }
});

// 刪除檢查類型
app.delete('/api/inspection-types/:typeId', async (req, res) => {
    try {
        const typeId = req.params.typeId;
        
        // 輸入驗證
        if (!typeId || typeof typeId !== 'string' || typeId.trim() === '') {
            return res.status(400).json({ error: '無效的檢查類型ID' });
        }
        
        const data = await fsPromises.readFile(path.join(__dirname, 'inspection_types.json'), 'utf8');
        const inspectionData = JSON.parse(data);
        
        if (!inspectionData.inspectionTypes[typeId]) {
            return res.status(404).json({ error: '檢查類型不存在' });
        }
        
        // 不允許刪除預設的鋼筋檢查類型
        if (typeId === 'rebar') {
            return res.status(400).json({ error: '無法刪除預設的鋼筋檢查類型' });
        }
        
        delete inspectionData.inspectionTypes[typeId];
        
        // 如果刪除的是當前類型，切換到鋼筋檢查
        if (inspectionData.currentType === typeId) {
            inspectionData.currentType = 'rebar';
        }
        
        const newData = JSON.stringify(inspectionData, null, 2);
        await fsPromises.writeFile(path.join(__dirname, 'inspection_types.json'), newData, 'utf8');
        
        // 更新快取
        setCachedData('inspection_types', inspectionData);
        
        res.json({ success: true, message: '檢查類型已刪除' });
    } catch (error) {
        console.error('刪除檢查類型錯誤:', error);
        res.status(500).json({ error: '無法刪除檢查類型' });
    }
});

function extractJsonFromText(text) {
    if (!text || typeof text !== 'string') {
        return null;
    }

    const cleaned = text
        .replace(/```json/gi, '```')
        .replace(/```/g, '')
        .trim();

    try {
        return JSON.parse(cleaned);
    } catch (error) {
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) {
            try {
                return JSON.parse(match[0]);
            } catch (innerErr) {
                return null;
            }
        }
        return null;
    }
}

function extractOllamaText(localData) {
    const textSegments = [];

    const collect = (value) => {
        if (!value) {
            return;
        }
        if (typeof value === 'string') {
            textSegments.push(value);
        } else if (Array.isArray(value)) {
            value.forEach(collect);
        } else if (typeof value === 'object') {
            if (typeof value.text === 'string') {
                textSegments.push(value.text);
            }
            if (Array.isArray(value.content)) {
                collect(value.content);
            }
        }
    };

    collect(localData?.message?.content);
    collect(localData?.response);
    collect(localData?.output_text);
    collect(localData?.output);
    collect(localData?.content);

    return textSegments.join('\n').trim();
}

function sanitizeText(text) {
    if (!text || typeof text !== 'string') return '';
    return text.replace(/\s+/g, ' ').trim();
}

const FALLBACK_ICONS = ['📌', '🛠️', '🔍', '✅', '📏', '🏗️', '🧱', '🔧', '📐', '🧰'];

function normalizeChecklistData(rawChecklist, fallbackName, providerLabel) {
    if (!rawChecklist || typeof rawChecklist !== 'object') {
        return null;
    }

    const nowTag = new Date().toISOString().split('T')[0];
    const fallback = (() => {
        const trimmed = sanitizeText(fallbackName);
        if (!trimmed || trimmed === '自訂檢查項目') {
            const suffix = Math.floor(Date.now() % 100000);
            return `自訂檢查類型 ${nowTag}#${suffix}`;
        }
        return trimmed;
    })();

    const normalizedName = (() => {
        const name = sanitizeText(rawChecklist.name);
        if (!name || name === '自訂檢查項目') {
            return fallback;
        }
        return name;
    })();

    const normalizedDescription = sanitizeText(rawChecklist.description) ||
        `${normalizedName} 的檢查項目 (${providerLabel} 產出於 ${nowTag})`;

    const rawItems = Array.isArray(rawChecklist.items) ? rawChecklist.items : [];
    const normalizedItems = rawItems
        .map((item, idx) => {
            if (!item || typeof item !== 'object') return null;
            const name = sanitizeText(item.name);
            const standard = sanitizeText(item.standard || item.criteria || item.requirement);
            if (!name || !standard) return null;

            const icon = sanitizeText(item.icon);
            const fallbackIcon = FALLBACK_ICONS[idx % FALLBACK_ICONS.length];

            return {
                name,
                icon: icon || fallbackIcon,
                standard
            };
        })
        .filter(Boolean);

    if (normalizedItems.length === 0) {
        return null;
    }

    return {
        name: normalizedName,
        description: normalizedDescription,
        items: normalizedItems
    };
}

// 解析檢查表（改用全域 fetch，不再宣告 node-fetch）
app.post('/api/parse-checklist', async (req, res) => {
    try {
        const { apiKey, imageData, checklistName, provider } = req.body || {};
        const selectedProvider = provider === 'local' ? 'local' : 'cloud';

        if (!imageData || typeof imageData !== 'object' || typeof imageData.base64Data !== 'string' || imageData.base64Data.trim() === '') {
            return res.status(400).json({ error: '檢查表影像數據是必需的' });
        }

        const sanitizedImage = imageData.base64Data.trim().replace(/^data:[^,]+,/, '');
        const mediaType = typeof imageData.mediaType === 'string' && imageData.mediaType.trim() !== ''
            ? imageData.mediaType.trim()
            : 'image/jpeg';
        let preparedImage = sanitizedImage;

        if (selectedProvider === 'cloud') {
            if (!apiKey || typeof apiKey !== 'string') {
                return res.status(400).json({ error: 'API密鑰是必需的' });
            }

            preparedImage = await resizeBase64Image(sanitizedImage, mediaType, MAX_CLOUD_IMAGE_WIDTH);

            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-3-7-sonnet-20250219',
                    max_tokens: 4000,
                    messages: [{
                        role: 'user',
                        content: [{
                            type: 'text',
                            text: `請仔細分析這份品質檢查表，提取出所有的檢查項目和對應的檢查標準。

請按照以下JSON格式回應，不要包含任何其他文字：

{
  "name": "${checklistName || '自訂檢查項目'}",
  "description": "從檢查表中提取的檢查項目",
  "items": [
    {
      "name": "檢查項目名稱",
      "icon": "🔧",
      "standard": "具體的檢查標準或要求"
    }
  ]
}

注意事項：
1. 請提取所有能識別的檢查項目
2. 為每個項目選擇合適的emoji圖標
3. 檢查標準要具體明確
4. 只回應JSON格式，不要額外說明`
                        }, {
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: mediaType,
                                data: preparedImage
                            }
                        }]
                    }]
                })
            });

            const data = await response.json();

            if (!response.ok) {
                return res.status(response.status).json(data);
            }

            const textContent = Array.isArray(data?.content)
                ? data.content
                    .filter(part => part && typeof part.text === 'string')
                    .map(part => part.text)
                    .join('\n')
                : '';

            const parsedChecklist = extractJsonFromText(textContent);
            if (!parsedChecklist) {
                return res.status(502).json({
                    error: '無法從Claude回應中解析檢查表JSON',
                    raw: textContent || data
                });
            }

            const normalized = normalizeChecklistData(parsedChecklist, checklistName, 'Claude 雲端');

            if (!normalized) {
                return res.status(502).json({
                    error: 'Claude 雲端未產生任何檢查項目，請重新拍攝或改用本地模型',
                    raw: textContent
                });
            }

            return res.json({
                provider: 'cloud',
                checklist: normalized
            });
        }

        // 本地模型解析
        const preparedLocalImage = sanitizedImage
            ? await resizeBase64Image(sanitizedImage, mediaType, MAX_LOCAL_IMAGE_WIDTH)
            : null;

        const preferredLocalModel = typeof req.body.localModel === 'string' && req.body.localModel.trim() !== ''
            ? req.body.localModel.trim()
            : (LOCAL_CHECKLIST_MODEL || LOCAL_MODEL);

        const localRequestBody = {
            model: preferredLocalModel,
            stream: false,
            messages: [
                {
                    role: 'system',
                    content: `你是一位專精於土建工程的品質檢查助理，負責從掃描影像或文件中精準抽取檢查表。
嚴格遵守以下規範：
1. 只能輸出符合指定結構的 JSON，禁止任何額外文字、註解或 markdown。
2. "name" 欄位必須填入文件最上方的正式標題文字（例如「瀝青混凝土鋪築工程自主檢查表」），若文件沒有標題才可使用使用者提供的名稱。
3. "items" 陣列必須完整列出表格中所有檢查項目，不得省略；若影像品質差無法讀取，也要根據資料合理推測列出至少 8 項。
4. 每個項目需包含：emoji 圖示（單一 emoji）、簡潔的項目名稱，以及以繁體中文描述的具體檢查標準。
5. 若文件包含多列表格，須逐列解析並組合為完整的檢查項目列表。`
                },
                {
                    role: 'user',
                    content: `請仔細分析這份品質檢查表，提取出所有的檢查項目和對應的檢查標準。

請按照以下JSON格式回應，不要包含任何其他文字：

{
  "name": "${checklistName || '自訂檢查項目'}",
  "description": "從檢查表中提取的檢查項目",
  "items": [
    {
      "name": "檢查項目名稱",
      "icon": "🔧",
      "standard": "具體的檢查標準或要求"
    }
  ]
}

注意事項：
1. 請提取所有能識別的檢查項目
2. 為每個項目選擇合適的emoji圖標
3. 檢查標準要具體明確，使用繁體中文描述
4. 只回應JSON格式，不要額外說明
5. 若影像資訊有限，仍需根據此類工程常見規範列出所有應檢項目，至少 8 項`
                }
            ]
        };

        if (preparedLocalImage) {
            localRequestBody.messages[1].images = [preparedLocalImage];
        }

        const localResponse = await fetch('http://127.0.0.1:11434/api/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(localRequestBody)
        });

        const rawLocal = await localResponse.text();
        let localData = null;

        try {
            localData = JSON.parse(rawLocal);
        } catch (parseError) {
            return res.status(502).json({ error: '本地模型回傳格式無法解析', details: parseError.message, raw: rawLocal });
        }

        if (!localResponse.ok) {
            const errorDetail = (localData && localData.error) || rawLocal || 'Local model error';
            return res.status(localResponse.status).json({ error: errorDetail });
        }

        const localText = extractOllamaText(localData);

        if (!localText) {
            return res.status(502).json({ error: '無法取得本地模型輸出內容' });
        }

        const parsedChecklist = extractJsonFromText(localText);

        if (!parsedChecklist) {
            return res.status(502).json({
                error: '無法從本地模型輸出解析檢查表JSON',
                raw: localText
            });
        }

        const normalized = normalizeChecklistData(parsedChecklist, checklistName, 'Ollama ');

        if (!normalized) {
            return res.status(502).json({
                error: '本地模型未產生任何檢查項目，請重新拍攝或改用雲端模式',
                raw: localText
            });
        }

        if (!Array.isArray(normalized.items) || normalized.items.length < 8) {
            return res.status(502).json({
                error: '本地模型產生的檢查項目數量不足（少於 8 項），請重新上傳或改用雲端模式',
                raw: normalized
            });
        }

        return res.json({
            provider: 'local',
            checklist: normalized
        });
    } catch (error) {
        console.error('解析檢查表錯誤:', error);
        res.status(500).json({ 
            error: '解析檢查表失敗', 
            details: error.message 
        });
    }
});

// 提供靜態文件
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'rebar_inspection_tool.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 代理服務器運行在 http://localhost:${PORT}`);
    console.log(`📝 打開瀏覽器訪問 http://localhost:${PORT} 來使用鋼筋檢查工具`);
});
