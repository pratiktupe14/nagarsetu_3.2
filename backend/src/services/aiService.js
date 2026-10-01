const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { executeWithFailover } = require('./geminiKeyManager');
const { clampScore, calculateRiskAssessment } = require('./riskMatrixService');

// 13 Canonical Allowed Categories
const ALLOWED_CATEGORIES = [
  'Roads',
  'Water',
  'Drainage',
  'Sanitation',
  'Electricity',
  'Traffic',
  'Trees & Parks',
  'Public Infrastructure',
  'Parking',
  'Public Property',
  'Construction',
  'Flooding',
  'Safety Hazards'
];

const CATEGORY_DEPARTMENT_MAP = {
  'Roads': 'Public Works Department',
  'Water': 'Water Supply & Sewerage Board',
  'Drainage': 'Drainage & Sewage Department',
  'Sanitation': 'Sanitation & Waste Management',
  'Electricity': 'Electrical & Street Lighting',
  'Traffic': 'Traffic Management Department',
  'Trees & Parks': 'Maintenance Department',
  'Public Infrastructure': 'Public Works Department',
  'Parking': 'Traffic Management Department',
  'Public Property': 'Maintenance Department',
  'Construction': 'Public Works Department',
  'Flooding': 'Drainage & Sewage Department',
  'Safety Hazards': 'Maintenance Department'
};

function normalizeCategory(cat) {
  if (!cat) return 'Roads';
  const c = String(cat).trim();
  const directMatch = ALLOWED_CATEGORIES.find(a => a.toLowerCase() === c.toLowerCase());
  if (directMatch) return directMatch;

  const lower = c.toLowerCase();
  if (lower.includes('road') || lower.includes('pothole') || lower.includes('asphalt') || lower.includes('pavement')) return 'Roads';
  if (lower.includes('water') || lower.includes('pipe') || lower.includes('leakage') || lower.includes('supply')) return 'Water';
  if (lower.includes('drain') || lower.includes('sewag') || lower.includes('gutter') || lower.includes('manhole')) return 'Drainage';
  if (lower.includes('garbage') || lower.includes('waste') || lower.includes('trash') || lower.includes('sanitat') || lower.includes('dump')) return 'Sanitation';
  if (lower.includes('electr') || lower.includes('light') || lower.includes('wire') || lower.includes('cable') || lower.includes('pole')) return 'Electricity';
  if (lower.includes('traffic') || lower.includes('signal') || lower.includes('signboard') || lower.includes('zebra')) return 'Traffic';
  if (lower.includes('tree') || lower.includes('park') || lower.includes('garden') || lower.includes('branch')) return 'Trees & Parks';
  if (lower.includes('parking') || lower.includes('encroach')) return 'Parking';
  if (lower.includes('flood') || lower.includes('waterlog') || lower.includes('submerg')) return 'Flooding';
  if (lower.includes('hazard') || lower.includes('safety') || lower.includes('danger') || lower.includes('pit') || lower.includes('collapse')) return 'Safety Hazards';
  if (lower.includes('construction') || lower.includes('debris') || lower.includes('demolit')) return 'Construction';
  if (lower.includes('property') || lower.includes('fence') || lower.includes('bench') || lower.includes('monument')) return 'Public Property';
  if (lower.includes('infrastruct') || lower.includes('footpath') || lower.includes('bridge') || lower.includes('railing')) return 'Public Infrastructure';

  return 'Roads';
}

function normalizePriority(p) {
  if (!p) return 'Medium';
  const lower = String(p).toLowerCase().trim();
  if (lower === 'critical') return 'Critical';
  if (lower === 'high') return 'High';
  if (lower === 'low') return 'Low';
  return 'Medium';
}

function normalizeDepartment(cat, dept) {
  if (dept && typeof dept === 'string' && dept.trim().length > 3) {
    return dept.trim();
  }
  return CATEGORY_DEPARTMENT_MAP[cat] || 'Public Works Department';
}

const SYSTEM_PROMPT = `You are NAGARSETU's civic defect vision analyzer.
Analyze ONLY the actual physical image provided.
Determine the civic issue visible in the image.

Allowed categories ONLY:
- Roads
- Water
- Drainage
- Sanitation
- Electricity
- Traffic
- Trees & Parks
- Public Infrastructure
- Parking
- Public Property
- Construction
- Flooding
- Safety Hazards

Assess 4 risk quadrants based STRICTLY on visible evidence (each score must be an integer from 0 to 3):
- human_safety: Threat to human safety / life (0 = none, 1 = low hazard, 2 = serious hazard/open obstacle, 3 = immediate threat to life/live electric wire/deep open manhole/severe accident risk)
- public_disruption: Scale of public disruption (0 = none, 1 = minor local inconvenience, 2 = lane blockage/affecting many citizens, 3 = major road block/area-wide paralysis)
- health_environment: Public health & environmental hazard (0 = none, 1 = mild odor/litter, 2 = contaminated water/drainage overflow, 3 = severe biohazard/epidemic risk/toxic chemical)
- physical_severity: Defect physical severity / structural depth (0 = cosmetic, 1 = small crack/shallow hole, 2 = deep pothole/burst main pipeline/broken structure, 3 = catastrophic structural collapse)

Priority must be one of: "Low", "Medium", "High", "Critical".

Respond ONLY with a valid JSON object matching this exact structure:
{
  "category": "One of the allowed categories above",
  "title": "Short descriptive title of the defect",
  "description": "Factual description based strictly on visible evidence.",
  "priority": "Low or Medium or High or Critical",
  "department": "Appropriate municipal department",
  "confidence": 0.95,
  "risk_quadrants": {
    "human_safety": 0,
    "public_disruption": 0,
    "health_environment": 0,
    "physical_severity": 0
  },
  "visual_evidence": {
    "issue_detected": true,
    "issue_type": "Specific defect name",
    "visible_hazards": ["List of visible hazards"],
    "severity_notes": "Observations on physical severity"
  }
}
If no civic issue is visible in the image, set visual_evidence.issue_detected = false.`;

function normalizeModelName(m) {
  if (!m) return 'gemini-1.5-flash';
  return String(m).replace(/^models\//, '').trim();
}

let verifiedModel = null;
let supportedModelsCache = null;
const failedModels = new Set();

async function fetchLiveModels(apiKey) {
  if (supportedModelsCache && supportedModelsCache.length > 0) {
    return supportedModelsCache;
  }

  return new Promise((resolve) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const req = https.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const body = JSON.parse(data);
            const models = (body.models || [])
              .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
              .map(m => normalizeModelName(m.name));

            if (models.length > 0) {
              supportedModelsCache = models;
              console.log('[GEMINI] Live Google models supporting generateContent:', models);
              return resolve(models);
            }
          } catch (e) {
            console.warn('[GEMINI] Failed to parse live models:', e.message);
          }
        }
        resolve([]);
      });
    });

    req.on('error', (e) => {
      console.warn('[GEMINI] Failed to query live models:', e.message);
      resolve([]);
    });

    req.on('timeout', () => {
      req.destroy();
      resolve([]);
    });
  });
}

function pickCandidateModels(liveModels) {
  const list = [];
  if (verifiedModel && !failedModels.has(verifiedModel)) {
    list.push(verifiedModel);
  }

  const preferences = [
    'gemini-1.5-flash',
    'gemini-2.0-flash',
    'gemini-2.5-flash',
    'gemini-flash-latest',
    'gemini-1.5-pro',
    'gemini-2.5-pro'
  ];

  if (liveModels && liveModels.length > 0) {
    for (const p of preferences) {
      if (liveModels.includes(p) && !list.includes(p) && !failedModels.has(p)) {
        list.push(p);
      }
    }
    for (const m of liveModels) {
      if (m.includes('flash') && !m.includes('embedding') && !list.includes(m) && !failedModels.has(m)) {
        list.push(m);
      }
    }
    for (const m of liveModels) {
      if (!m.includes('embedding') && !list.includes(m) && !failedModels.has(m)) {
        list.push(m);
      }
    }
  } else {
    for (const p of preferences) {
      if (!list.includes(p) && !failedModels.has(p)) list.push(p);
    }
  }

  return list;
}

function getCurrentModel() {
  return verifiedModel || 'gemini-2.5-flash';
}

async function callDirectGeminiVision(fileInput, targetModel = null) {
  let fileBuffer;
  let mimeType = 'image/jpeg';
  let originalName = 'uploaded-photo.jpg';

  if (Buffer.isBuffer(fileInput)) {
    fileBuffer = fileInput;
  } else if (fileInput && typeof fileInput === 'object') {
    if (Buffer.isBuffer(fileInput.buffer)) {
      fileBuffer = fileInput.buffer;
    } else if (fileInput.path && fs.existsSync(fileInput.path)) {
      fileBuffer = fs.readFileSync(fileInput.path);
    }
    if (fileInput.mimetype) mimeType = fileInput.mimetype;
    if (fileInput.originalname) originalName = fileInput.originalname;
  } else if (typeof fileInput === 'string') {
    if (!fs.existsSync(fileInput)) {
      const errObj = new Error(`Gemini analysis failed: Image file not found at ${fileInput}`);
      errObj.statusCode = 400;
      errObj.errorCode = 'INVALID_IMAGE';
      throw errObj;
    }
    fileBuffer = fs.readFileSync(fileInput);
    const ext = path.extname(fileInput).toLowerCase();
    if (ext === '.png') mimeType = 'image/png';
    if (ext === '.webp') mimeType = 'image/webp';
    originalName = path.basename(fileInput);
  } else {
    const errObj = new Error('Gemini analysis failed: Invalid image payload provided.');
    errObj.statusCode = 400;
    errObj.errorCode = 'INVALID_IMAGE';
    throw errObj;
  }

  if (!fileBuffer || fileBuffer.length === 0) {
    const errObj = new Error('Gemini analysis failed: Image payload is empty (0 bytes).');
    errObj.statusCode = 400;
    errObj.errorCode = 'INVALID_IMAGE';
    throw errObj;
  }

  const base64Image = fileBuffer.toString('base64');
  const imageHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const analysisId = crypto.randomUUID();

  const payload = JSON.stringify({
    contents: [
      {
        parts: [
          { text: SYSTEM_PROMPT },
          {
            inlineData: {
              mimeType: mimeType,
              data: base64Image
            }
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json'
    }
  });

  return await executeWithFailover(async (apiKey, slot) => {
    const liveModels = await fetchLiveModels(apiKey);
    const candidateModels = targetModel
      ? [normalizeModelName(targetModel)]
      : pickCandidateModels(liveModels);

    let lastCandidateErr = null;

    for (const model of candidateModels) {
      if (failedModels.has(model)) continue;

      console.log(`[GEMINI] Attempting Vision Request with model: ${model} (Key Slot: ${slot})`);

      try {
        const result = await sendGenerateContentRequest(model, payload, analysisId, imageHash, apiKey);
        verifiedModel = model;
        return result;
      } catch (err) {
        if (err.statusCode === 404 || err.errorCode === 'AI_MODEL_NOT_FOUND') {
          failedModels.add(model);
          console.warn(`[GEMINI] Model ${model} returned 404, attempting next model from live list...`);
          lastCandidateErr = err;
          continue;
        }
        // Non-404 error (e.g. 401, 403, 429, 500) must be handled by executeWithFailover
        throw err;
      }
    }

    if (lastCandidateErr) {
      throw lastCandidateErr;
    }
    throw new Error('No working Gemini vision model found among candidate list.');
  });
}

function sendGenerateContentRequest(model, payload, analysisId, imageHash, apiKey) {
  const cleanModel = normalizeModelName(model);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent?key=${apiKey}`;

  return new Promise((resolve, reject) => {
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 35000
    };

    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            const rawText = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!rawText) throw new Error('Empty response payload from Gemini model.');

            let cleanText = rawText.trim();
            if (cleanText.startsWith('```')) {
              cleanText = cleanText.replace(/^```(json)?\s*/i, '').replace(/\s*```$/, '').trim();
            }

            const resultObj = JSON.parse(cleanText);

            // 1. Civic Issue Classification
            const category = normalizeCategory(resultObj.category);
            const title = resultObj.title || `${category} Issue`;
            const description = resultObj.description || `Physical civic defect identified visually: ${category}.`;
            const priority = normalizePriority(resultObj.priority);
            const department = normalizeDepartment(category, resultObj.department);
            const confidence = typeof resultObj.confidence === 'number' ? resultObj.confidence : 0.95;

            // 2. 4-Quadrant Risk Calculation via existing riskMatrixService
            const rawQuadrants = resultObj.risk_quadrants || {};
            const human_safety = clampScore(rawQuadrants.human_safety ?? 1);
            const public_disruption = clampScore(rawQuadrants.public_disruption ?? 1);
            const health_environment = clampScore(rawQuadrants.health_environment ?? 0);
            const physical_severity = clampScore(rawQuadrants.physical_severity ?? 1);

            const riskAssessment = calculateRiskAssessment({
              safety_score: human_safety,
              disruption_score: public_disruption,
              health_environment_score: health_environment,
              defect_severity_score: physical_severity,
              category,
              priority,
              support_count: 1
            });

            // Canonical risk severity formatted as Low | Medium | High | Critical
            const canonicalSeverity = riskAssessment.severity.charAt(0).toUpperCase() + riskAssessment.severity.slice(1).toLowerCase();
            // Step 10: If Gemini priority conflicts with canonical risk severity, use canonical risk result
            const finalPriority = canonicalSeverity;

            const riskObj = {
              human_safety,
              public_disruption,
              health_environment,
              physical_severity,
              risk_score: riskAssessment.risk_score,
              severity: canonicalSeverity
            };

            resolve({
              success: true,
              analysis_id: analysisId,
              image_hash: imageHash,
              model: cleanModel,
              category,
              title,
              description,
              priority: finalPriority,
              department,
              recommended_department: department,
              confidence,
              risk: riskObj,
              risk_quadrants: {
                human_safety,
                public_disruption,
                health_environment,
                physical_severity
              },
              human_safety,
              public_disruption,
              health_environment,
              physical_severity,
              risk_score: riskAssessment.risk_score,
              severity: canonicalSeverity,
              risk_assessment: riskAssessment,
              visual_evidence: resultObj.visual_evidence || {
                issue_detected: true,
                issue_type: title,
                visible_hazards: [],
                severity_notes: description
              },
              detected_features: [category, finalPriority, `${canonicalSeverity} Severity`],
              is_civic_issue: resultObj.visual_evidence?.issue_detected !== false,
              needs_manual_verification: confidence < 0.75
            });
          } catch (e) {
            const errObj = new Error(`Structured JSON parse error: ${e.message}`);
            errObj.statusCode = 422;
            errObj.errorCode = 'AI_PARSE_ERROR';
            reject(errObj);
          }
        } else {
          let errorCode = 'AI_SERVER_ERROR';
          let errorReason = `Gemini API returned status ${res.statusCode}`;

          try {
            const errBody = JSON.parse(data);
            const errMsg = errBody.error?.message || '';
            if (
              errMsg.toLowerCase().includes('api key') ||
              errMsg.toLowerCase().includes('api_key_invalid') ||
              (errBody.error?.status === 'INVALID_ARGUMENT' && errMsg.toLowerCase().includes('key'))
            ) {
              errorCode = 'API_KEY_INVALID';
              errorReason = `Gemini API Key Invalid: ${errMsg}`;
            }
          } catch (e) {}

          if (errorCode === 'API_KEY_INVALID') {
            // Handled
          } else if (res.statusCode === 429) {
            errorCode = 'AI_QUOTA_EXCEEDED';
            errorReason = 'AI Vision temporarily unavailable because quota has been reached.';
          } else if (res.statusCode === 401) {
            errorCode = 'API_KEY_INVALID';
            errorReason = 'Gemini API Authentication Failed (HTTP 401).';
          } else if (res.statusCode === 403) {
            errorCode = 'API_KEY_INVALID';
            errorReason = 'Gemini API Permission Denied (HTTP 403).';
          } else if (res.statusCode === 404) {
            errorCode = 'AI_MODEL_NOT_FOUND';
            errorReason = 'Configured Gemini Model Not Found (HTTP 404).';
          } else if (res.statusCode === 400) {
            errorCode = 'AI_INVALID_PAYLOAD';
            errorReason = 'Invalid Image Payload or Request (HTTP 400 Bad Request).';
          }

          const errObj = new Error(errorReason);
          errObj.statusCode = res.statusCode;
          errObj.errorCode = errorCode;
          reject(errObj);
        }
      });
    });

    req.on('error', (err) => {
      const errObj = new Error(`Network transport error: ${err.message}`);
      errObj.statusCode = 500;
      errObj.errorCode = 'AI_NETWORK_ERROR';
      reject(errObj);
    });

    req.on('timeout', () => {
      req.destroy();
      const errObj = new Error('API connection timeout (35s)');
      errObj.statusCode = 504;
      errObj.errorCode = 'AI_TIMEOUT';
      reject(errObj);
    });

    req.write(payload);
    req.end();
  });
}

async function analyzeComplaintPhoto(fileInput) {
  let imageHash = '';
  try {
    let buf;
    if (Buffer.isBuffer(fileInput)) buf = fileInput;
    else if (fileInput && fileInput.buffer) buf = fileInput.buffer;
    else if (typeof fileInput === 'string' && fs.existsSync(fileInput)) buf = fs.readFileSync(fileInput);
    if (buf) imageHash = crypto.createHash('sha256').update(buf).digest('hex');
  } catch (e) {}

  try {
    const aiResult = await callDirectGeminiVision(fileInput);
    return aiResult;
  } catch (err) {
    console.error('[NAGARSETU Backend Error]', err.message);
    return {
      success: false,
      statusCode: err.statusCode || 500,
      error: err.errorCode || 'AI_SERVER_ERROR',
      message: err.message || 'Gemini Vision AI Analysis failed.',
      retryable: (err.statusCode === 429 || err.statusCode === 504 || err.statusCode === 500),
      analysis_id: crypto.randomUUID(),
      image_hash: imageHash,
      model: verifiedModel || 'none',
      is_civic_issue: false,
      category: 'Roads',
      title: 'Civic Defect',
      description: 'Civic issue reported for municipal review and inspection.',
      priority: 'Medium',
      department: 'Public Works Department',
      recommended_department: 'Public Works Department',
      confidence: 0.0,
      risk_quadrants: {
        human_safety: 1,
        public_disruption: 1,
        health_environment: 0,
        physical_severity: 1
      },
      human_safety: 1,
      public_disruption: 1,
      health_environment: 0,
      physical_severity: 1,
      risk_score: 3,
      severity: 'MEDIUM',
      detected_features: [],
      needs_manual_verification: true
    };
  }
}

const SAME_ISSUE_CONFIDENCE_THRESHOLD = 85;

function computeImageHash(fileInput) {
  try {
    let buf = null;
    if (Buffer.isBuffer(fileInput)) {
      buf = fileInput;
    } else if (fileInput && typeof fileInput === 'object' && Buffer.isBuffer(fileInput.buffer)) {
      buf = fileInput.buffer;
    } else if (typeof fileInput === 'string') {
      if (fileInput.startsWith('data:image')) {
        const base64Data = fileInput.split(',')[1];
        if (base64Data) buf = Buffer.from(base64Data, 'base64');
      } else if (fs.existsSync(fileInput)) {
        buf = fs.readFileSync(fileInput);
      } else if (fileInput.trim() !== '') {
        buf = Buffer.from(fileInput.trim());
      }
    }
    if (buf && buf.length > 0) {
      return crypto.createHash('sha256').update(buf).digest('hex');
    }
  } catch (e) {}
  return '';
}

async function compareImagesForSamePhysicalIssue(img1, img2, options = {}) {
  if (options.simulatedVisualMatch) {
    return {
      same_physical_issue: Boolean(options.simulatedVisualMatch.same_physical_issue),
      confidence: Number(options.simulatedVisualMatch.confidence || 0),
      match_type: 'visual',
      reason: options.simulatedVisualMatch.reason || 'Simulated angle-invariant visual match'
    };
  }

  const hash1 = computeImageHash(img1);
  const hash2 = computeImageHash(img2);
  if (hash1 && hash2 && hash1 === hash2) {
    return {
      same_physical_issue: true,
      confidence: 100,
      match_type: 'exact',
      reason: 'Exact image binary hash match (SHA-256)'
    };
  }

  return {
    same_physical_issue: false,
    confidence: 0,
    match_type: 'visual',
    reason: 'Distinct images'
  };
}

module.exports = {
  analyzeComplaintPhoto,
  computeImageHash,
  compareImagesForSamePhysicalIssue,
  SAME_ISSUE_CONFIDENCE_THRESHOLD,
  getCurrentModel,
  ALLOWED_CATEGORIES,
  CATEGORY_DEPARTMENT_MAP,
  normalizeCategory,
  normalizePriority
};
