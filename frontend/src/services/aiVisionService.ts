import { AIVisionResult, PriorityLevel, VisualFeatures, ImageSimilarityResult } from '../types/database.types';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { getApiUrl, getAiServiceUrl } from '../config/apiConfig';

export const CIVIC_CATEGORIES = [
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
] as const;

export type CivicCategory = typeof CIVIC_CATEGORIES[number];

export const OFFICIAL_DEPARTMENTS = [
  'Public Works Department',
  'Sanitation & Waste Management',
  'Water Supply & Sewerage Board',
  'Drainage & Sewage Department',
  'Electrical & Street Lighting',
  'Traffic Management Department',
  'Maintenance Department'
] as const;

export type OfficialDepartment = typeof OFFICIAL_DEPARTMENTS[number];

export function normalizeDepartment(dept?: string, category?: string): string {
  if (dept && (OFFICIAL_DEPARTMENTS as readonly string[]).includes(dept)) {
    return dept;
  }

  const str = (dept || '').toLowerCase();
  const cat = (category || '').toLowerCase();

  if (str.includes('sanitation') || str.includes('garbage') || str.includes('solid waste') || str.includes('waste') || cat.includes('garbage') || cat.includes('waste') || cat === 'sanitation') {
    return 'Sanitation & Waste Management';
  }
  if (str.includes('water supply') || str.includes('water leakage') || str.includes('pipeline') || (str.includes('water') && !str.includes('drain') && !str.includes('sew')) || (cat.includes('water') && !cat.includes('drain'))) {
    return 'Water Supply & Sewerage Board';
  }
  if (str.includes('drain') || str.includes('sewag') || str.includes('sewer') || str.includes('flood') || cat.includes('drainage') || cat.includes('sewage') || cat === 'flooding') {
    return 'Drainage & Sewage Department';
  }
  if (str.includes('electrical') || str.includes('electric') || str.includes('light') || str.includes('street light') || str.includes('lighting') || cat.includes('streetlight') || cat.includes('electrical') || cat === 'electricity') {
    return 'Electrical & Street Lighting';
  }
  if (str.includes('traffic') || str.includes('signal') || str.includes('parking') || cat.includes('traffic') || cat === 'parking') {
    return 'Traffic Management Department';
  }
  if (str.includes('tree') || str.includes('park') || str.includes('maintenance') || cat.includes('trees') || cat.includes('property') || cat.includes('hazard') || cat.includes('other')) {
    return 'Maintenance Department';
  }
  if (str.includes('road') || str.includes('pothole') || str.includes('public works') || str.includes('pwd') || str.includes('footpath') || str.includes('construction') || cat.includes('road') || cat === 'roads' || cat === 'construction' || cat === 'public infrastructure') {
    return 'Public Works Department';
  }

  return 'Public Works Department';
}

export const VALID_TAXONOMY_MAP: Record<CivicCategory, { department: string; defaultTitle: string; defaultPriority: PriorityLevel }> = {
  'Roads': {
    department: 'Public Works Department',
    defaultTitle: 'Pothole / Road Surface Defect',
    defaultPriority: 'High'
  },
  'Water': {
    department: 'Water Supply & Sewerage Board',
    defaultTitle: 'Municipal Water Pipeline Leakage',
    defaultPriority: 'High'
  },
  'Drainage': {
    department: 'Drainage & Sewage Department',
    defaultTitle: 'Blocked Stormwater Drain & Sewage Overflow',
    defaultPriority: 'High'
  },
  'Sanitation': {
    department: 'Sanitation & Waste Management',
    defaultTitle: 'Uncollected Solid Waste Accumulation',
    defaultPriority: 'Medium'
  },
  'Electricity': {
    department: 'Electrical & Street Lighting',
    defaultTitle: 'Damaged / Inoperative Streetlight Fixture',
    defaultPriority: 'Medium'
  },
  'Traffic': {
    department: 'Traffic Management Department',
    defaultTitle: 'Malfunctioning / Damaged Traffic Signal',
    defaultPriority: 'High'
  },
  'Trees & Parks': {
    department: 'Maintenance Department',
    defaultTitle: 'Fallen Tree / Overgrown Vegetation Hazard',
    defaultPriority: 'Medium'
  },
  'Public Infrastructure': {
    department: 'Public Works Department',
    defaultTitle: 'Damaged Public Footpath / Railing',
    defaultPriority: 'High'
  },
  'Parking': {
    department: 'Traffic Management Department',
    defaultTitle: 'Illegal Parking / Roadway Obstruction',
    defaultPriority: 'Low'
  },
  'Public Property': {
    department: 'Maintenance Department',
    defaultTitle: 'Damaged Municipal Property / Structure',
    defaultPriority: 'Medium'
  },
  'Construction': {
    department: 'Public Works Department',
    defaultTitle: 'Construction Debris / Road Encroachment',
    defaultPriority: 'Medium'
  },
  'Flooding': {
    department: 'Drainage & Sewage Department',
    defaultTitle: 'Severe Waterlogging / Urban Flooding',
    defaultPriority: 'Critical'
  },
  'Safety Hazards': {
    department: 'Maintenance Department',
    defaultTitle: 'Dangerous Hazard / Structural Risk',
    defaultPriority: 'Critical'
  }
};

const AI_ANALYSIS_CACHE_KEY = 'nagarsetu_gemini_analysis_cache_v4';

function getAnalysisCache(): Record<string, AIVisionResult> {
  try {
    const raw = localStorage.getItem(AI_ANALYSIS_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function setAnalysisCache(key: string, result: AIVisionResult) {
  try {
    const cache = getAnalysisCache();
    cache[key] = result;
    localStorage.setItem(AI_ANALYSIS_CACHE_KEY, JSON.stringify(cache));
  } catch (e) {}
}

export async function computeImageHash(file: File): Promise<string> {
  try {
    const buffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch (err) {
    return `${file.name}-${file.size}-${file.lastModified}`;
  }
}

/**
 * Real Gemini Health Check Endpoint
 * GET /api/ai/health
 */
export async function checkAiHealth(): Promise<{ configured: boolean; model: string; reachable: boolean; reply?: string; error?: string }> {
  try {
    const baseUrl = getApiUrl();
    const endpoint = baseUrl ? `${baseUrl}/api/ai/health` : '/api/ai/health';
    const res = await fetch(endpoint);
    if (res.ok) {
      const data = await res.json();
      const isConfigured = Boolean(data.configured ?? data.aiConfigured ?? data.geminiConfigured);
      return {
        configured: isConfigured,
        reachable: data.reachable !== undefined ? Boolean(data.reachable) : isConfigured,
        model: data.model || 'gemini-2.5-flash',
        reply: data.reply
      };
    } else {
      const errText = await res.text();
      return { configured: true, model: 'gemini-2.5-flash', reachable: false, error: `Backend returned status ${res.status}: ${errText}` };
    }
  } catch (err: any) {
    return {
      configured: false,
      model: 'gemini-2.5-flash',
      reachable: false,
      error: `Express Backend server is not reachable (${err.message}).`
    };
  }
}

/**
 * Loads an image from URL or File into an HTMLImageElement
 */
function loadImage(source: File | string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error('Failed to load image for visual analysis: ' + e));

    if (source instanceof File) {
      img.src = URL.createObjectURL(source);
    } else {
      img.src = source;
    }
  });
}

/**
 * Converts File or image URL to Base64 string for API payloads
 */
export async function fileToBase64(file: File | string): Promise<string> {
  if (typeof file === 'string') {
    if (file.startsWith('data:')) {
      return file;
    }
    const response = await fetch(file);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export async function extractVisualFeatures(imageInput: File | string): Promise<VisualFeatures> {
  try {
    const img = await loadImage(imageInput);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    if (!ctx) {
      throw new Error('Canvas 2D context unavailable');
    }

    canvas.width = 9;
    canvas.height = 8;
    ctx.drawImage(img, 0, 0, 9, 8);
    const hashData = ctx.getImageData(0, 0, 9, 8).data;

    let dHashBits = '';
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const idxLeft = (row * 9 + col) * 4;
        const idxRight = (row * 9 + col + 1) * 4;
        const lumLeft = (hashData[idxLeft] * 299 + hashData[idxLeft + 1] * 587 + hashData[idxLeft + 2] * 114) / 1000;
        const lumRight = (hashData[idxRight] * 299 + hashData[idxRight + 1] * 587 + hashData[idxRight + 2] * 114) / 1000;
        dHashBits += lumLeft > lumRight ? '1' : '0';
      }
    }
    let dHash = '';
    for (let i = 0; i < 64; i += 4) {
      dHash += parseInt(dHashBits.substring(i, i + 4), 2).toString(16);
    }

    canvas.width = 32;
    canvas.height = 32;
    ctx.drawImage(img, 0, 0, 32, 32);
    const sample = ctx.getImageData(0, 0, 32, 32).data;
    const totalPixels = 32 * 32;

    let totalLuminance = 0;
    let minLum = 255;
    let maxLum = 0;
    const rgbBins = new Array(32).fill(0);
    let edgeDiffSum = 0;

    for (let i = 0; i < sample.length; i += 4) {
      const r = sample[i];
      const g = sample[i + 1];
      const b = sample[i + 2];
      const lum = (r * 299 + g * 587 + b * 114) / 1000;

      totalLuminance += lum;
      if (lum < minLum) minLum = lum;
      if (lum > maxLum) maxLum = lum;

      rgbBins[Math.floor(r / 32)] += 1;
      rgbBins[8 + Math.floor(g / 32)] += 1;
      rgbBins[16 + Math.floor(b / 32)] += 1;
      rgbBins[24 + Math.floor(lum / 32)] += 1;
    }

    for (let y = 0; y < 31; y++) {
      for (let x = 0; x < 31; x++) {
        const curr = ((y * 32) + x) * 4;
        const right = ((y * 32) + (x + 1)) * 4;
        const down = (((y + 1) * 32) + x) * 4;
        const diffH = Math.abs(sample[curr] - sample[right]);
        const diffV = Math.abs(sample[curr] - sample[down]);
        edgeDiffSum += (diffH + diffV) / 2;
      }
    }

    const avgBrightness = Math.round(totalLuminance / totalPixels);
    const contrast = Math.round(((maxLum - minLum) / 255) * 100);
    const edgeDensity = Math.min(1, Math.round((edgeDiffSum / (totalPixels * 128)) * 100) / 100);
    const vector = rgbBins.map((val) => val / totalPixels);

    const dominantColors = [
      `#${sample[0].toString(16).padStart(2, '0')}${sample[1].toString(16).padStart(2, '0')}${sample[2].toString(16).padStart(2, '0')}`,
      `#${sample[2048].toString(16).padStart(2, '0')}${sample[2049].toString(16).padStart(2, '0')}${sample[2050].toString(16).padStart(2, '0')}`
    ];

    return {
      dHash,
      brightness: avgBrightness,
      contrast,
      dominantColors,
      edgeDensity,
      vector
    };
  } catch (err) {
    const fallbackSeed = typeof imageInput === 'string' && imageInput.length > 5 
      ? imageInput.substring(imageInput.length - 16) 
      : `${Date.now().toString(16)}${Math.floor(Math.random() * 0xffffff).toString(16)}`.substring(0, 16);
    return {
      dHash: fallbackSeed.padStart(16, '0'),
      brightness: 120,
      contrast: 65,
      dominantColors: ['#475569', '#059669'],
      edgeDensity: 0.45,
      vector: new Array(32).fill(1 / 32)
    };
  }
}

export function calculateCosineSimilarity(vecA: number[], vecB: number[]): number {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return Math.max(0, Math.min(1, dot / (Math.sqrt(normA) * Math.sqrt(normB))));
}

export function compareImageSimilarity(
  featuresA: VisualFeatures,
  featuresB: VisualFeatures,
  distanceMeters?: number
): ImageSimilarityResult {
  if (featuresA.dHash && featuresB.dHash && featuresA.dHash === featuresB.dHash) {
    return {
      isExactDuplicate: true,
      similarityScore: 1.0,
      confidenceLevel: 'High',
      relation: 'exact_duplicate',
      reason: 'Exact identical photo detected via 64-bit difference hash.'
    };
  }

  const cosSim = calculateCosineSimilarity(featuresA.vector, featuresB.vector);
  const isNearby = distanceMeters == null || distanceMeters <= 150;

  if (cosSim >= 0.82 && isNearby) {
    return {
      isExactDuplicate: false,
      similarityScore: Math.round(cosSim * 100) / 100,
      confidenceLevel: 'High',
      relation: 'same_issue_different_angle',
      reason: `Matching visual defect pattern (${Math.round(cosSim * 100)}% visual match) in the same geographic radius. Recommended as additional angle evidence.`
    };
  }

  return {
    isExactDuplicate: false,
    similarityScore: Math.round(cosSim * 100) / 100,
    confidenceLevel: 'Low',
    relation: 'different_issue',
    reason: `Distinct visual patterns detected (${Math.round(cosSim * 100)}% similarity).`
  };
}

/**
 * Compress and resize uploaded image client-side before sending to Gemini API
 * Reduces payload size and token usage while preserving visual defect details.
 */
export async function compressImageFile(file: File, maxDimension: number = 1280, quality: number = 0.85): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  if (file.size < 500 * 1024) return file; // Skip compression for small images (< 500KB)

  try {
    const img = await loadImage(file);
    let width = img.width;
    let height = img.height;

    if (width > maxDimension || height > maxDimension) {
      if (width > height) {
        height = Math.round((height * maxDimension) / width);
        width = maxDimension;
      } else {
        width = Math.round((width * maxDimension) / height);
        height = maxDimension;
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;

    ctx.drawImage(img, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', quality);
    });

    if (!blob || blob.size >= file.size) return file; // If larger, keep original

    const newFilename = file.name.replace(/\.[^/.]+$/, '') + '.jpg';
    return new File([blob], newFilename, { type: 'image/jpeg', lastModified: Date.now() });
  } catch (e) {
    return file; // Fallback to original file on failure
  }
}

/**
 * 1. Calls Express Backend API (/api/ai/analyze) on port 5000
 */
async function callExpressBackendAiAnalyze(file: File): Promise<any> {
  const formData = new FormData();
  formData.append('photo', file, file.name);

  const baseUrl = getApiUrl();
  const endpoint = baseUrl ? `${baseUrl}/api/ai/analyze` : '/api/ai/analyze';

  let token = localStorage.getItem('nagarsetu_token') ||
              sessionStorage.getItem('nagarsetu_token') ||
              localStorage.getItem('token') || 
              localStorage.getItem('access_token') || 
              localStorage.getItem('authToken') ||
              localStorage.getItem('nagarsetu_auth_token');

  if (!token && isSupabaseConfigured()) {
    try {
      const { data } = await supabase.auth.getSession();
      token = data.session?.access_token || null;
    } catch (e) {}
  }

  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: formData
    });

    const json = await res.json().catch(() => ({}));

    if (res.ok && (json.success || json.ai)) {
      const rawAi = json.ai || json;
      const risk = json.risk || rawAi.risk || {};
      return {
        ...rawAi,
        category: rawAi.category || json.category,
        title: rawAi.title || json.title,
        description: rawAi.description || json.description,
        priority: rawAi.priority || json.priority,
        department: rawAi.department || rawAi.recommended_department || json.department,
        recommended_department: rawAi.department || rawAi.recommended_department || json.department,
        confidence: rawAi.confidence ?? json.confidence,
        risk: {
          human_safety: risk.human_safety ?? rawAi.human_safety ?? json.human_safety ?? 0,
          public_disruption: risk.public_disruption ?? rawAi.public_disruption ?? json.public_disruption ?? 0,
          health_environment: risk.health_environment ?? rawAi.health_environment ?? json.health_environment ?? 0,
          physical_severity: risk.physical_severity ?? rawAi.physical_severity ?? json.physical_severity ?? 0,
          risk_score: risk.risk_score ?? rawAi.risk_score ?? json.risk_score ?? 0,
          severity: risk.severity || rawAi.severity || json.severity || 'Medium'
        },
        risk_quadrants: rawAi.risk_quadrants || json.risk_quadrants || {
          human_safety: risk.human_safety ?? 0,
          public_disruption: risk.public_disruption ?? 0,
          health_environment: risk.health_environment ?? 0,
          physical_severity: risk.physical_severity ?? 0
        },
        human_safety: risk.human_safety ?? rawAi.human_safety ?? json.human_safety,
        public_disruption: risk.public_disruption ?? rawAi.public_disruption ?? json.public_disruption,
        health_environment: risk.health_environment ?? rawAi.health_environment ?? json.health_environment,
        physical_severity: risk.physical_severity ?? rawAi.physical_severity ?? json.physical_severity,
        risk_score: risk.risk_score ?? rawAi.risk_score ?? json.risk_score,
        severity: risk.severity || rawAi.severity || json.severity,
        risk_assessment: rawAi.risk_assessment || json.risk_assessment
      };
    }

    if (json.ai && json.ai.success !== false) {
      return json.ai;
    }

    const errorCode = json.error || (res.status === 429 ? 'AI_QUOTA_EXCEEDED' : 'AI_SERVER_ERROR');
    const errorMessage = json.message || `Express Backend API returned status ${res.status}`;
    const errObj: any = new Error(errorMessage);
    errObj.statusCode = res.status;
    errObj.errorCode = errorCode;
    errObj.backendJson = json;
    throw errObj;
  } catch (err: any) {
    if (err.statusCode || (err.message && !err.message.includes('Failed to fetch') && !err.message.includes('NetworkError'))) {
      throw err;
    }

    const netErr: any = new Error('Backend server is offline or unreachable.');
    netErr.statusCode = 503;
    netErr.errorCode = 'AI_NETWORK_ERROR';
    throw netErr;
  }
}

/**
 * 2. Calls Python AI Microservice (http://localhost:8000/analyze)
 */
async function callPythonAiServiceDirect(file: File): Promise<any> {
  const formData = new FormData();
  formData.append('file', file, file.name);

  const res = await fetch(`${getAiServiceUrl()}/analyze`, {
    method: 'POST',
    body: formData
  });

  if (!res.ok) {
    throw new Error(`Python AI service returned status ${res.status}`);
  }

  return await res.json();
}

/**
 * 3. Calls Supabase Edge Function with base64 image data
 */
async function callGeminiVisionEdgeFunction(file: File): Promise<any> {
  if (!isSupabaseConfigured()) return null;

  const base64Data = await fileToBase64(file);

  const { data, error } = await supabase.functions.invoke('analyze-civic-image', {
    body: {
      image_base64: base64Data,
      mime_type: file.type || 'image/jpeg'
    }
  });

  if (error || !data || !data.success || !data.data) {
    return null;
  }

  return data.data;
}

/**
 * Main Civic Image Classifier executing real Gemini Vision API via Node Express backend
 */
export async function detectCivicIssue(inputFile: File, bypassCache: boolean = false): Promise<AIVisionResult> {
  const startTime = performance.now();
  const file = await compressImageFile(inputFile);
  const imageHash = await computeImageHash(file);

  // Check local cache by exact image hash unless bypassCache is requested
  if (!bypassCache) {
    const cache = getAnalysisCache();
    if (cache[imageHash] && cache[imageHash].is_available !== false && cache[imageHash].confidence > 0) {
      return cache[imageHash];
    }
  }

  const visualFeatures = await extractVisualFeatures(file);

  let rawRes: any = null;
  let lastErrorObj: any = null;

  // Layer 1: Call Express Backend API (/api/ai/analyze on port 5000)
  try {
    rawRes = await callExpressBackendAiAnalyze(file);
  } catch (err: any) {
    lastErrorObj = err;
    console.log('[NAGARSETU AI] Express Backend API error:', err.message);
  }

  // Layer 2: Call Python FastAPI microservice (http://localhost:8000/analyze)
  if (!rawRes || rawRes.success === false) {
    try {
      rawRes = await callPythonAiServiceDirect(file);
    } catch (err: any) {
      if (!lastErrorObj) lastErrorObj = err;
      console.log('[NAGARSETU AI] Python service unavailable:', err.message);
    }
  }

  // Layer 3: Call Supabase Edge Function
  if (!rawRes || rawRes.success === false) {
    try {
      rawRes = await callGeminiVisionEdgeFunction(file);
    } catch (err: any) {
      if (!lastErrorObj) lastErrorObj = err;
      console.log('[NAGARSETU AI] Supabase Edge Function unavailable:', err.message);
    }
  }

  const endTime = performance.now();

  // If real successful Gemini response obtained:
  if (rawRes && rawRes.category && rawRes.success !== false && !rawRes.error) {
    const rawCategory = String(rawRes.category || '').trim();
    let category: CivicCategory = 'Roads';
    if ((CIVIC_CATEGORIES as readonly string[]).includes(rawCategory)) {
      category = rawCategory as CivicCategory;
    } else {
      const lower = rawCategory.toLowerCase();
      if (lower.includes('road') || lower.includes('pothole') || lower.includes('asphalt')) {
        category = 'Roads';
      } else if (lower.includes('water') || lower.includes('leak') || lower.includes('pipe')) {
        category = 'Water';
      } else if (lower.includes('garbage') || lower.includes('waste') || lower.includes('trash') || lower.includes('sanitat')) {
        category = 'Sanitation';
      } else if (lower.includes('drain') || lower.includes('sewag') || lower.includes('gutter')) {
        category = 'Drainage';
      } else if (lower.includes('street') || lower.includes('light') || lower.includes('electr')) {
        category = 'Electricity';
      } else if (lower.includes('traffic') || lower.includes('signal')) {
        category = 'Traffic';
      } else if (lower.includes('tree') || lower.includes('park')) {
        category = 'Trees & Parks';
      } else if (lower.includes('flood')) {
        category = 'Flooding';
      } else if (lower.includes('hazard') || lower.includes('danger')) {
        category = 'Safety Hazards';
      } else if (lower.includes('parking')) {
        category = 'Parking';
      } else if (lower.includes('construction') || lower.includes('debris')) {
        category = 'Construction';
      } else if (lower.includes('property')) {
        category = 'Public Property';
      } else if (lower.includes('infrastruct') || lower.includes('footpath') || lower.includes('damage') || lower.includes('public')) {
        category = 'Public Infrastructure';
      }
    }

    const meta = VALID_TAXONOMY_MAP[category] || VALID_TAXONOMY_MAP['Roads'];
    const confidence = typeof rawRes.confidence === 'number' ? rawRes.confidence : 0.94;
    const confidenceLevel: 'High' | 'Medium' | 'Low' =
      confidence >= 0.85 ? 'High' : confidence >= 0.60 ? 'Medium' : 'Low';

    const result: AIVisionResult = {
      mode: 'production',
      analysis_id: rawRes.analysis_id || crypto.randomUUID(),
      image_hash: imageHash,
      category,
      issue_type: rawRes.title || meta.defaultTitle,
      confidence: Math.round(confidence * 100) / 100,
      confidence_level: confidenceLevel,
      priority: (rawRes.priority as PriorityLevel) || meta.defaultPriority,
      department: normalizeDepartment(rawRes.department || rawRes.recommended_department || meta.department, category),
      title: rawRes.title || meta.defaultTitle,
      description: rawRes.description || `Civic issue detected visually by Gemini Vision.`,
      is_available: true,
      visual_features: visualFeatures,
      detected_objects: rawRes.detected_features || [],
      quality_check: {
        isUsable: true,
        brightness: visualFeatures.brightness,
        contrast: visualFeatures.contrast
      },
      analysis_time_ms: Math.round(endTime - startTime),
      ...((rawRes.risk_quadrants || rawRes.risk_score !== undefined) ? {
        risk_quadrants: rawRes.risk_quadrants,
        human_safety: rawRes.human_safety,
        public_disruption: rawRes.public_disruption,
        health_environment: rawRes.health_environment,
        physical_severity: rawRes.physical_severity,
        risk_score: rawRes.risk_score,
        severity: rawRes.severity,
        risk_assessment: rawRes.risk_assessment
      } : {})
    } as any;

    setAnalysisCache(imageHash, result);
    return result;
  }

  // Map exact error status and code cleanly without setting error text in title/description
  let errorCode = lastErrorObj?.errorCode || rawRes?.error || 'AI_TEMPORARY_ERROR';
  let errorMessage = lastErrorObj?.message || rawRes?.message || 'AI Vision analysis is temporarily unavailable.';

  if (lastErrorObj?.statusCode === 429 || errorCode === 'AI_QUOTA_EXCEEDED') {
    errorCode = 'AI_QUOTA_EXCEEDED';
    errorMessage = 'AI Vision temporarily unavailable because the AI service quota has been reached.';
  } else if (lastErrorObj?.statusCode === 401 || errorCode === 'AI_AUTHENTICATION_ERROR') {
    errorCode = 'AI_AUTHENTICATION_ERROR';
    errorMessage = 'AI Vision authentication failed. Please verify API key configuration.';
  } else if (lastErrorObj?.statusCode === 403 || errorCode === 'AI_PERMISSION_ERROR') {
    errorCode = 'AI_PERMISSION_ERROR';
    errorMessage = 'AI service permission denied.';
  } else if (lastErrorObj?.statusCode === 404 || errorCode === 'AI_MODEL_NOT_FOUND') {
    errorCode = 'AI_MODEL_NOT_FOUND';
    errorMessage = 'Configured Gemini Vision model was not found.';
  } else if (lastErrorObj?.statusCode === 504 || errorCode === 'AI_TIMEOUT') {
    errorCode = 'AI_TIMEOUT';
    errorMessage = 'AI Vision service connection timed out.';
  } else if (
    lastErrorObj?.statusCode === 500 ||
    errorCode === 'AI_SERVER_ERROR' ||
    errorMessage.includes('FUNCTION_INVOCATION_FAILED') ||
    errorMessage.includes('500') ||
    errorMessage.includes('server error')
  ) {
    errorCode = 'AI_SERVER_ERROR';
    errorMessage = 'AI Vision analysis is temporarily unavailable. You can retry or continue manually.';
  } else if (errorCode === 'AI_NETWORK_ERROR' || errorMessage.includes('offline')) {
    errorCode = 'AI_NETWORK_ERROR';
    errorMessage = 'Backend server is offline or unreachable.';
  }

  const fallbackResult: AIVisionResult = {
    mode: 'production',
    analysis_id: crypto.randomUUID(),
    image_hash: imageHash,
    category: 'Other Civic Issue',
    issue_type: 'Manual Selection Required',
    confidence: 0,
    confidence_level: 'Low',
    priority: 'Medium',
    department: 'Maintenance Department',
    title: '',
    description: '',
    error_code: errorCode,
    error_message: errorMessage,
    is_available: false,
    visual_features: visualFeatures,
    detected_objects: [],
    quality_check: {
      isUsable: true,
      brightness: visualFeatures.brightness,
      contrast: visualFeatures.contrast
    },
    analysis_time_ms: Math.round(endTime - startTime)
  };

  return fallbackResult;
}
