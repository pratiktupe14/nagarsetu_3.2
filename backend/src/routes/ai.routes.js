const express = require('express');
const router = express.Router();
const fs = require('fs');
const { upload } = require('../middleware/upload');
const { analyzeComplaintPhoto, getCurrentModel } = require('../services/aiService');
const { authenticateToken } = require('../middleware/auth');

/**
 * Lightweight Gemini Health Check Endpoint
 * GET /api/ai/health
 */
router.get('/health', (req, res) => {
  let configuredKeyCount = 0;
  for (let i = 1; i <= 6; i++) {
    const k = process.env[`GEMINI_API_KEY_${i}`];
    if (k && k.trim() !== '' && k !== 'your_gemini_api_key_here' && !k.includes('placeholder')) {
      configuredKeyCount++;
    }
  }

  // Fallback to legacy single or comma-separated GEMINI_API_KEY
  if (configuredKeyCount === 0 && process.env.GEMINI_API_KEY) {
    const raw = process.env.GEMINI_API_KEY.trim();
    if (raw && raw !== 'your_gemini_api_key_here' && !raw.includes('placeholder')) {
      if (raw.includes(',')) {
        configuredKeyCount = raw.split(',').map(s => s.trim()).filter(k => k && k !== 'your_gemini_api_key_here' && !k.includes('placeholder')).length;
      } else {
        configuredKeyCount = 1;
      }
    }
  }

  const aiConfigured = configuredKeyCount > 0;

  return res.status(200).json({
    status: 'ok',
    aiConfigured,
    geminiConfigured: aiConfigured,
    configured: aiConfigured,
    reachable: aiConfigured,
    configuredKeyCount,
    model: (typeof getCurrentModel === 'function' && getCurrentModel()) || 'gemini-2.5-flash'
  });
});

/**
 * Direct Image Vision Analysis Endpoint
 * POST /api/ai/analyze
 * Accepts multipart photo file and returns Gemini classification with 4-quadrant risk matrix
 */
router.post('/analyze', (req, res, next) => {
  if (req.headers['authorization']) {
    return authenticateToken(req, res, next);
  }
  next();
}, (req, res, next) => {
  upload.single('photo')(req, res, (err) => {
    if (err) {
      if (err.name === 'MulterError') {
        return res.status(400).json({
          success: false,
          error: 'INVALID_IMAGE',
          message: `Multer upload error: ${err.message}. Expected multipart field "photo".`
        });
      }
      return next(err);
    }
    next();
  });
}, async (req, res) => {
  const reqTime = new Date().toISOString();
  console.log(`[${reqTime}] [NAGARSETU AI] Request received: POST /api/ai/analyze`);

  try {
    if (!req.file || (!req.file.buffer && !req.file.path)) {
      console.error(`[${reqTime}] [NAGARSETU AI] Error: No photo file provided.`);
      return res.status(400).json({
        success: false,
        error: 'INVALID_IMAGE',
        message: 'No photo file provided in request. Expected multipart field "photo".'
      });
    }

    console.log(`[${reqTime}] [NAGARSETU AI] Image received: name="${req.file.originalname}", size=${req.file.size || req.file.buffer?.length} bytes, mimetype="${req.file.mimetype}"`);

    let buffer = req.file.buffer;
    if (!buffer && req.file.path && fs.existsSync(req.file.path)) {
      buffer = fs.readFileSync(req.file.path);
    }

    if (!buffer || buffer.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_IMAGE',
        message: 'Uploaded photo file is empty (0 bytes).'
      });
    }

    // Call Gemini Vision AI Service with actual image bytes
    const aiAnalysis = await analyzeComplaintPhoto({
      buffer,
      mimetype: req.file.mimetype || 'image/jpeg',
      originalname: req.file.originalname || 'photo.jpg',
      size: buffer.length
    });

    if (aiAnalysis.success === false) {
      const statusCode = aiAnalysis.statusCode || 500;
      console.error(`[${reqTime}] [NAGARSETU AI] Vision analysis returned error:`, aiAnalysis.error || aiAnalysis.message);
      return res.status(statusCode).json({
        success: false,
        error: aiAnalysis.error || 'AI_SERVER_ERROR',
        message: aiAnalysis.message || 'AI Vision analysis is temporarily unavailable.',
        retryable: aiAnalysis.retryable ?? true
      });
    }

    const photoUrl = req.file?.publicUrl || req.file?.supabaseUrl || (req.file?.filename ? `/uploads/${req.file.filename}` : undefined);
    if (photoUrl) {
      aiAnalysis.photo_url = photoUrl;
    }

    const riskObject = {
      human_safety: aiAnalysis.risk?.human_safety ?? aiAnalysis.human_safety ?? 0,
      public_disruption: aiAnalysis.risk?.public_disruption ?? aiAnalysis.public_disruption ?? 0,
      health_environment: aiAnalysis.risk?.health_environment ?? aiAnalysis.health_environment ?? 0,
      physical_severity: aiAnalysis.risk?.physical_severity ?? aiAnalysis.physical_severity ?? 0,
      risk_score: aiAnalysis.risk?.risk_score ?? aiAnalysis.risk_score ?? 0,
      severity: aiAnalysis.risk?.severity || (aiAnalysis.severity ? (aiAnalysis.severity.charAt(0).toUpperCase() + aiAnalysis.severity.slice(1).toLowerCase()) : 'Medium')
    };

    return res.status(200).json({
      success: true,
      category: aiAnalysis.category,
      title: aiAnalysis.title,
      description: aiAnalysis.description,
      priority: aiAnalysis.priority,
      department: aiAnalysis.department || aiAnalysis.recommended_department,
      confidence: aiAnalysis.confidence,
      risk: riskObject,
      // Compatibility fields for client components:
      recommended_department: aiAnalysis.department || aiAnalysis.recommended_department,
      risk_quadrants: aiAnalysis.risk_quadrants || {
        human_safety: riskObject.human_safety,
        public_disruption: riskObject.public_disruption,
        health_environment: riskObject.health_environment,
        physical_severity: riskObject.physical_severity
      },
      human_safety: riskObject.human_safety,
      public_disruption: riskObject.public_disruption,
      health_environment: riskObject.health_environment,
      physical_severity: riskObject.physical_severity,
      risk_score: riskObject.risk_score,
      severity: riskObject.severity,
      risk_assessment: aiAnalysis.risk_assessment,
      photo_url: photoUrl,
      ai: aiAnalysis
    });
  } catch (err) {
    console.error(`[${reqTime}] [NAGARSETU AI] Express analyze route error:`, err.message);
    const statusCode = err.statusCode || 503;
    const errorCode = err.errorCode || err.error || (statusCode === 503 ? 'AI_TEMPORARILY_UNAVAILABLE' : 'AI_SERVER_ERROR');
    return res.status(statusCode).json({
      success: false,
      error: errorCode,
      message: err.message || 'AI Vision analysis is temporarily unavailable.'
    });
  }
});

module.exports = router;
