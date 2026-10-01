/**
 * NAGARSETU Centralized Gemini API Key Manager & Automatic Failover Service
 * Manages deterministic rotation, health tracking, cooldown, and recovery across Gemini API keys.
 */

const COOLDOWN_INVALID_MS = 10 * 60 * 1000; // 10 minutes for 401 / 403 / API_KEY_INVALID
const COOLDOWN_QUOTA_MS = 5 * 60 * 1000;   // 5 minutes for 429 / RESOURCE_EXHAUSTED
const COOLDOWN_TEMP_MS = 60 * 1000;        // 60 seconds for 5xx / timeout / network failure

// Process-level in-memory state
let currentIndex = 0;
const keyHealth = new Map(); // slotIndex -> { unavailableUntil: number, reason: string }
let overrideKeys = null; // Used for isolated unit testing

function getAvailableKeys() {
  if (overrideKeys && Array.isArray(overrideKeys)) {
    return overrideKeys;
  }

  const keys = [];
  for (let i = 1; i <= 6; i++) {
    const raw = process.env[`GEMINI_API_KEY_${i}`];
    if (raw) {
      const k = raw.trim().replace(/^["']|["']$/g, '');
      if (k && k !== 'your_gemini_api_key_here' && !k.includes('placeholder') && !keys.includes(k)) {
        keys.push(k);
      }
    }
  }

  // Fallback to legacy single or comma-separated GEMINI_API_KEY only if no numbered keys found
  if (keys.length === 0 && process.env.GEMINI_API_KEY) {
    const raw = process.env.GEMINI_API_KEY.trim().replace(/^["']|["']$/g, '');
    if (raw.includes(',')) {
      raw.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean).forEach(k => {
        if (k && k !== 'your_gemini_api_key_here' && !k.includes('placeholder') && !keys.includes(k)) {
          keys.push(k);
        }
      });
    } else if (raw && raw !== 'your_gemini_api_key_here' && !raw.includes('placeholder') && !keys.includes(raw)) {
      keys.push(raw);
    }
  }

  return keys;
}

function isInvalidKeyError(err) {
  if (!err) return false;
  const status = err.statusCode || err.status || (err.response && err.response.status);
  const msg = String(err.message || err.error || '').toLowerCase();
  const code = String(err.errorCode || err.code || '').toLowerCase();

  return (
    status === 401 ||
    status === 403 ||
    code.includes('api_key_invalid') ||
    code.includes('invalid_api_key') ||
    code.includes('ai_authentication_error') ||
    code.includes('ai_permission_error') ||
    msg.includes('api_key_invalid') ||
    msg.includes('api key not valid') ||
    msg.includes('invalid api key') ||
    msg.includes('api_key_expired') ||
    msg.includes('authentication failed') ||
    msg.includes('permission denied')
  );
}

function isQuotaError(err) {
  if (!err) return false;
  const status = err.statusCode || err.status || (err.response && err.response.status);
  const msg = String(err.message || err.error || '').toLowerCase();
  const code = String(err.errorCode || err.code || '').toLowerCase();

  return (
    status === 429 ||
    code === 'ai_quota_exceeded' ||
    msg.includes('resource_exhausted') ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests')
  );
}

function isRetryableError(err) {
  if (!err) return false;
  const status = err.statusCode || err.status || (err.response && err.response.status);
  const msg = String(err.message || err.error || '').toLowerCase();
  const code = String(err.errorCode || err.code || '').toLowerCase();

  // Invalid API key / Auth / Forbidden (401, 403, API_KEY_INVALID)
  if (isInvalidKeyError(err)) return true;

  // Quota / Rate limit / RESOURCE_EXHAUSTED (429)
  if (isQuotaError(err)) return true;

  // Server errors (500, 502, 503, 504)
  if (status >= 500 && status <= 504) return true;

  // Network transport / timeouts
  if (
    code === 'ai_network_error' ||
    code === 'ai_timeout' ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('network transport error') ||
    msg.includes('temporarily unavailable')
  ) {
    return true;
  }

  return false;
}

/**
 * Execute an arbitrary Gemini operation with automatic failover across all configured keys.
 *
 * @param {Function} apiCallFn - async (apiKey, slotIndex) => Promise<any>
 * @returns {Promise<any>}
 */
async function executeWithFailover(apiCallFn) {
  const keys = getAvailableKeys();

  if (keys.length === 0) {
    const unconfiguredErr = new Error('Gemini analysis failed: GEMINI_API_KEY is not configured in server environment.');
    unconfiguredErr.statusCode = 503;
    unconfiguredErr.errorCode = 'AI_SERVICE_UNCONFIGURED';
    throw unconfiguredErr;
  }

  const maxAttempts = Math.min(keys.length, 6);
  const now = Date.now();
  let attemptsMade = 0;
  let lastRetryableError = null;

  for (let i = 0; i < maxAttempts; i++) {
    // Find next eligible slot starting from currentIndex
    let selectedSlot = -1;
    for (let offset = 0; offset < keys.length; offset++) {
      const candidateSlot = (currentIndex + offset) % keys.length;
      const health = keyHealth.get(candidateSlot);

      if (!health || health.unavailableUntil <= Date.now()) {
        selectedSlot = candidateSlot;
        currentIndex = candidateSlot;
        break;
      }
    }

    if (selectedSlot === -1) {
      // Closed loop: Recover the key slot with the earliest expiry
      let earliestSlot = 0;
      let earliestTime = Infinity;
      for (let s = 0; s < keys.length; s++) {
        const h = keyHealth.get(s);
        if (h && h.unavailableUntil < earliestTime) {
          earliestTime = h.unavailableUntil;
          earliestSlot = s;
        }
      }
      selectedSlot = earliestSlot;
      currentIndex = earliestSlot;
      console.warn(`[GEMINI FAILOVER] Keys in cooldown; recovering slot ${selectedSlot + 1} (closed loop)`);
    }

    const currentKey = keys[selectedSlot];
    const slotHumanNumber = selectedSlot + 1;
    attemptsMade++;

    try {
      const result = await apiCallFn(currentKey, selectedSlot);
      console.log(`[GEMINI FAILOVER] Gemini request succeeded using key slot ${slotHumanNumber}`);
      // Key succeeded, clear any past transient health status
      keyHealth.delete(selectedSlot);
      return result;
    } catch (err) {
      // Non-retryable errors (e.g. 400 Bad Request, malformed prompt, invalid image payload) must NOT rotate keys
      if (!isRetryableError(err)) {
        throw err;
      }

      lastRetryableError = err;
      const nextSlotHumanNumber = ((selectedSlot + 1) % keys.length) + 1;

      if (isInvalidKeyError(err)) {
        keyHealth.set(selectedSlot, {
          unavailableUntil: Date.now() + COOLDOWN_INVALID_MS,
          reason: 'API_KEY_INVALID'
        });
        console.warn(`[GEMINI FAILOVER] Gemini key ${slotHumanNumber} invalid/unauthorized (status ${err.statusCode || err.status}); switching to key ${nextSlotHumanNumber}`);
      } else if (isQuotaError(err)) {
        keyHealth.set(selectedSlot, {
          unavailableUntil: Date.now() + COOLDOWN_QUOTA_MS,
          reason: 'QUOTA_EXHAUSTED'
        });
        console.warn(`[GEMINI FAILOVER] Gemini key ${slotHumanNumber} exhausted; switching to key ${nextSlotHumanNumber}`);
      } else {
        keyHealth.set(selectedSlot, {
          unavailableUntil: Date.now() + COOLDOWN_TEMP_MS,
          reason: 'TEMPORARY_ERROR'
        });
        console.warn(`[GEMINI FAILOVER] Gemini key ${slotHumanNumber} temporarily unavailable; switching to key ${nextSlotHumanNumber}`);
      }

      // Advance currentIndex to the next slot
      currentIndex = (selectedSlot + 1) % keys.length;
    }
  }

  // If loop completes without success, all available keys failed
  console.error(`[GEMINI FAILOVER] All ${attemptsMade} Gemini keys attempted and failed.`);
  const fatalErr = new Error('Gemini service is temporarily unavailable. Please try again later.');
  fatalErr.error = 'AI_TEMPORARILY_UNAVAILABLE';
  fatalErr.errorCode = 'AI_TEMPORARILY_UNAVAILABLE';
  fatalErr.message = 'AI Vision analysis is temporarily unavailable.';
  fatalErr.statusCode = 503;
  throw fatalErr;
}

// Internal testing utilities
function _resetState() {
  currentIndex = 0;
  keyHealth.clear();
  overrideKeys = null;
}

function _setKeysForTesting(keys) {
  overrideKeys = keys;
  currentIndex = 0;
  keyHealth.clear();
}

function _getKeyHealth(slotIndex) {
  return keyHealth.get(slotIndex);
}

module.exports = {
  executeWithFailover,
  isRetryableError,
  isInvalidKeyError,
  isQuotaError,
  getAvailableKeys,
  COOLDOWN_QUOTA_MS,
  COOLDOWN_TEMP_MS,
  _resetState,
  _setKeysForTesting,
  _getKeyHealth
};
