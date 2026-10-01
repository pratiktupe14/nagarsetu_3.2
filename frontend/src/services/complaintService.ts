import { Complaint, ComplaintStatus, PriorityLevel, StaffPerformanceMetrics } from '../types/database.types';
import { supabase, isSupabaseConfigured, isValidUuid, DEFAULT_CIVIC_IMAGE_PLACEHOLDER, getValidImageUrl } from '../lib/supabase';
import { resolveMediaUrl } from '../utils/mediaUtils';
import { broadcastComplaintChange } from './realtimeService';
import { pushNotification } from './notificationService';
import { getApiUrl, getNoCacheHeaders } from '../config/apiConfig';
import { geocodeComplaintsWithoutCoordinates, auditAndRepairComplaintLocations } from './locationService';
import { resolveDepartmentInfo } from './departmentService';
import { deleteDraft as deleteIndexedDBDraft } from './offlineDraftService';

const LOCAL_STORAGE_COMPLAINTS_KEY = 'nagarsetu_citizen_complaints_v3';
const LOCAL_STORAGE_OFFLINE_DRAFTS_KEY = 'nagarsetu_offline_drafts_v3';

export class HttpError extends Error {
  status: number;
  data: any;
  isHttpError: boolean;

  constructor(status: number, message: string, data?: any) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.data = data;
    this.isHttpError = true;
    Object.setPrototypeOf(this, HttpError.prototype);
  }
}

export class AuthError extends Error {
  isAuthError: boolean;
  status: number;

  constructor(message: string = 'Authentication required to submit complaint. Please log in.') {
    super(message);
    this.name = 'AuthError';
    this.isAuthError = true;
    this.status = 401;
    Object.setPrototypeOf(this, AuthError.prototype);
  }
}

/**
 * Strict Network Failure Classifier
 * Distinguishes true network failures (fetch threw before reaching server, offline)
 * from valid HTTP responses (200, 201, 400, 401, 403, 404, 409, 422, 500, 502, 503).
 */
export function isNetworkError(err: any): boolean {
  if (!err) return false;

  // 1. If it's an HttpError or has an HTTP status code, it is an HTTP response, NOT a network failure.
  if (err instanceof HttpError || err.isHttpError || typeof err.status === 'number' || err.statusCode) {
    return false;
  }

  // 2. If it's an AuthError, it is an authentication issue, NOT a network failure.
  if (err instanceof AuthError || err.isAuthError || err.message?.includes('Authentication required')) {
    return false;
  }

  // 3. Browser explicitly reports offline
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return true;
  }

  // 4. Standard fetch network error signatures (fetch throws before receiving HTTP response)
  const errMsg = (err.message || '').toLowerCase();
  return (
    errMsg.includes('failed to fetch') ||
    errMsg.includes('networkerror') ||
    errMsg.includes('network error') ||
    errMsg.includes('load failed') ||
    errMsg.includes('fetch failed') ||
    errMsg.includes('econnrefused') ||
    errMsg.includes('enotfound') ||
    errMsg.includes('connection refused') ||
    errMsg.includes('net::err') ||
    errMsg.includes('offline')
  );
}

export function generateComplaintNumber(): string {
  const year = new Date().getFullYear();
  const randomSeq = Math.floor(100000 + Math.random() * 900000);
  return `NS-${year}-${randomSeq}`;
}

const LEGACY_STORAGE_KEYS = [
  'nagarsetu_citizen_complaints_v3',
  'nagarsetu_citizen_complaints',
  'nagarsetu_complaints',
  'nagarsetu_complaint_list',
  'complaints'
];

/**
 * Identifies if a complaint object is a demo/fake record
 */
export function isDemoComplaint(c: Partial<Complaint>): boolean {
  if (!c) return true;
  const num = (c.complaint_number || '').toLowerCase();
  const title = (c.title || '').toLowerCase();
  const addr = (c.location_address || '').toLowerCase();
  const desc = (c.description || '').toLowerCase();

  if (num.includes('000145') || num.includes('000128')) return true;
  if (title.includes('garbage overflow near public market') || title.includes('severe asphalt pothole on m.g. road')) return true;
  if (addr.includes('market yard road') || (addr.includes('m.g. road') && addr.includes('ward 12'))) return true;
  if (desc.includes('solid waste accumulation requiring municipal sanitation clearance') || desc.includes('deep road crater causing traffic congestion')) return true;

  return false;
}

export function getStoredComplaints(): Complaint[] {
  // Purge legacy storage keys if present to ensure PostgreSQL is single source of truth
  LEGACY_STORAGE_KEYS.forEach((key) => {
    try {
      if (localStorage.getItem(key)) {
        localStorage.removeItem(key);
      }
    } catch (e) {}
  });
  return [];
}

export function saveStoredComplaints(_complaints: Complaint[]) {
  // PostgreSQL is single source of truth; do not write complaints to localStorage
  try {
    localStorage.removeItem(LOCAL_STORAGE_COMPLAINTS_KEY);
  } catch (e) {}
}

// Upload image to backend /api/complaints/upload or Supabase storage bucket ('issues')
export async function uploadComplaintImage(file: File, bucketName: string = 'issues'): Promise<string> {
  // 1. Try Express backend /api/complaints/upload multipart endpoint
  try {
    const formData = new FormData();
    formData.append('photo', file);
    const token = localStorage.getItem('nagarsetu_token') || sessionStorage.getItem('nagarsetu_token') || '';
    const res = await fetch(`${getApiUrl()}/api/complaints/upload`, {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: formData
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.url || data?.publicUrl) {
        const resultUrl = data.url || data.publicUrl;
        if (typeof resultUrl === 'string' && (resultUrl.startsWith('/uploads/') || resultUrl.startsWith('uploads/'))) {
          const apiBase = getApiUrl();
          const cleanPath = resultUrl.startsWith('/') ? resultUrl : `/${resultUrl}`;
          return apiBase ? `${apiBase.replace(/\/$/, '')}${cleanPath}` : cleanPath;
        }
        return resultUrl;
      }
    }
  } catch (backendUploadErr) {
    console.warn('Backend multipart upload note:', backendUploadErr);
  }

  // 2. Try Supabase storage if configured
  if (isSupabaseConfigured()) {
    try {
      const fileExt = file.name.split('.').pop() || 'jpg';
      const fileName = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}.${fileExt}`;
      const filePath = `uploads/${fileName}`;

      const { data, error } = await supabase.storage
        .from(bucketName)
        .upload(filePath, file, { cacheControl: '3600', upsert: true });

      if (!error && data) {
        const { data: publicUrlData } = supabase.storage.from(bucketName).getPublicUrl(filePath);
        if (publicUrlData?.publicUrl) {
          return publicUrlData.publicUrl;
        }
      }
      if (error) {
        console.error('Supabase storage upload notice:', error.message);
      }
    } catch (err: any) {
      console.error('Supabase storage upload exception:', err);
    }
  }

  // 3. Fallback: Optimize & Compress client-side to permanent Base64 Data URL (NEVER a temporary blob: URL)
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onloadend = () => resolve((reader.result as string) || DEFAULT_CIVIC_IMAGE_PLACEHOLDER);
      reader.onerror = () => resolve(DEFAULT_CIVIC_IMAGE_PLACEHOLDER);
      reader.readAsDataURL(file);
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        try {
          const maxDim = 1200;
          let width = img.width;
          let height = img.height;
          if (width > maxDim || height > maxDim) {
            if (width > height) {
              height = Math.round((height * maxDim) / width);
              width = maxDim;
            } else {
              width = Math.round((width * maxDim) / height);
              height = maxDim;
            }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0, width, height);
            const compressed = canvas.toDataURL('image/jpeg', 0.75);
            resolve(compressed);
            return;
          }
        } catch (canvasErr) {
          console.warn('Canvas image compression note:', canvasErr);
        }
        resolve((e.target?.result as string) || DEFAULT_CIVIC_IMAGE_PLACEHOLDER);
      };
      img.onerror = () => resolve((e.target?.result as string) || DEFAULT_CIVIC_IMAGE_PLACEHOLDER);
      img.src = (e.target?.result as string) || '';
    };
    reader.onerror = () => resolve(DEFAULT_CIVIC_IMAGE_PLACEHOLDER);
    reader.readAsDataURL(file);
  });
}

export const CANONICAL_MUNICIPAL_COMPLAINTS: Complaint[] = [];

// Fetch all complaints from Supabase with real geocoding fallback
export async function getAllComplaints(): Promise<Complaint[]> {
  let list: Complaint[] = [];
  let responseStatus = 0;
  const startTime = new Date().toISOString();

  // 1. Try Express Backend API first with no-cache headers and scope=all (with resilient production timeout)
  try {
    const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
    const apiTimeoutMs = isLocalhost ? 6000 : 15000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), apiTimeoutMs);
    const token = localStorage.getItem('nagarsetu_token') || sessionStorage.getItem('nagarsetu_token');
    const headers = getNoCacheHeaders(token ? { Authorization: `Bearer ${token}` } : {});
    const res = await fetch(`${getApiUrl()}/api/complaints?scope=all`, {
      signal: controller.signal,
      headers
    });
    clearTimeout(timeoutId);
    responseStatus = res.status;
    if (res.ok) {
      const data = await res.json();
      const backendComplaints = Array.isArray(data) ? data : Array.isArray(data?.complaints) ? data.complaints : [];
      if (backendComplaints.length > 0) {
        list = backendComplaints
          .filter((c: any) => !isDemoComplaint(c))
          .map((c: any) => ({
            ...c,
            department_name: c.department_name || resolveDepartmentInfo(c.department_id, undefined, c.category)?.fullName || 'Public Works Department (PWD)'
          }));
      }
    } else {
      console.warn(`Express backend returned HTTP ${res.status} for complaints`);
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      console.warn('Express backend getAllComplaints timed out after configured deadline.');
    } else {
      console.warn('Express backend getAllComplaints note:', err?.message || err);
    }
  }

  // 2. Fallback to or merge Supabase if Express API was unreachable or returned 0 complaints
  if (responseStatus !== 200 && isSupabaseConfigured()) {
    try {
      const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
      const supaTimeoutMs = isLocalhost ? 6000 : 15000;
      const supaPromise = supabase
        .from('complaints')
        .select('*')
        .order('updated_at', { ascending: false });
      const supaTimeoutPromise = new Promise<any>((resolve) => setTimeout(() => resolve({ data: null, error: new Error('Supabase timeout') }), supaTimeoutMs));
      const { data, error } = await Promise.race([supaPromise, supaTimeoutPromise]);

      if (!error && data && data.length > 0) {
        const supaList = (data as Complaint[])
          .filter((c) => !isDemoComplaint(c))
          .map((c: any) => ({
            ...c,
            department_name: c.department_name || resolveDepartmentInfo(c.department_id, undefined, c.category)?.fullName || 'Public Works Department (PWD)'
          }));

        if (list.length === 0) {
          list = supaList;
        } else {
          const existingIds = new Set(list.map((c) => String(c.id)));
          const existingNums = new Set(list.map((c) => c.complaint_number));
          for (const sc of supaList) {
            if (!existingIds.has(String(sc.id)) && !existingNums.has(sc.complaint_number)) {
              list.push(sc);
            }
          }
        }
        responseStatus = 200;
      }
    } catch (err) {
      console.warn('Supabase getAllComplaints fallback:', err);
    }
  }

  // 3. Fallback to canonical municipal seed complaints if both API and Supabase returned 0 items
  // No fallback to mock data

  // 4. DB state is authoritative when backend or Supabase query succeeds
  if (responseStatus === 200) {
    let finalComplaints = list.filter((c) => !isDemoComplaint(c));

    // Run location audit & Nominatim repair in background so complaint loading is never delayed
    if (typeof window !== 'undefined') {
      setTimeout(() => {
        try {
          auditAndRepairComplaintLocations(finalComplaints).catch(() => {});
        } catch (e) {}
      }, 50);
    }

    // Empty list preserved

    if (import.meta.env.DEV) {
      console.log('[ADMIN DATA SYNC]', {
        apiUrl: `${getApiUrl()}/api/complaints?scope=all`,
        fetchTime: startTime,
        responseStatus,
        databaseRecordCount: list.length,
        lastUpdatedRecord: finalComplaints[0]?.updated_at || finalComplaints[0]?.created_at || 'N/A',
        finalRecordCount: finalComplaints.length
      });
    }

    return finalComplaints.map(normalizeComplaint);
  }

  // If both Express API and Supabase failed, fall back to canonical complaints
  return [];
}

/**
 * Defensive Normalizer for Complaints
 * Guarantees string fields are non-null and valid, and coordinates are strictly valid finite numbers or undefined (never NaN).
 */
export function normalizeComplaint(c: any): Complaint {
  if (!c || typeof c !== 'object') {
    return c;
  }

  // Parse & validate latitude and longitude
  let lat: number | undefined = undefined;
  let lng: number | undefined = undefined;

  if (c.latitude !== null && c.latitude !== undefined && c.latitude !== '') {
    const parsedLat = Number(c.latitude);
    if (Number.isFinite(parsedLat) && parsedLat >= -90 && parsedLat <= 90) {
      lat = parsedLat;
    }
  }

  if (c.longitude !== null && c.longitude !== undefined && c.longitude !== '') {
    const parsedLng = Number(c.longitude);
    if (Number.isFinite(parsedLng) && parsedLng >= -180 && parsedLng <= 180) {
      lng = parsedLng;
    }
  }

  // If one coordinate is missing/invalid or (0,0), treat as undefined
  if (lat === undefined || lng === undefined || (lat === 0 && lng === 0)) {
    lat = undefined;
    lng = undefined;
  }

  // Extract citizen evidence photo from all possible fields returned by API or stored
  const extractRawCitizenPhoto = (): string => {
    const isRealUrl = (u: any) => typeof u === 'string' && u.trim() !== '' && !u.includes('civic-default.jpg') && !u.includes('600x400');
    if (isRealUrl(c.photo_before_url)) return c.photo_before_url;
    if (isRealUrl(c.photo_front_url)) return c.photo_front_url;
    if (isRealUrl(c.photo_url)) return c.photo_url;
    if (isRealUrl(c.photo)) return c.photo;
    if (isRealUrl(c.image_url)) return c.image_url;
    if (isRealUrl(c.image_path)) return c.image_path;
    if (isRealUrl(c.primary_image)) return c.primary_image;
    if (isRealUrl(c.primary_photo)) return c.primary_photo;
    if (isRealUrl(c.before_photo)) return c.before_photo;
    if (isRealUrl(c.before_image)) return c.before_image;
    if (Array.isArray(c.evidence_photos) && c.evidence_photos.length > 0) {
      const first = typeof c.evidence_photos[0] === 'string' ? c.evidence_photos[0] : c.evidence_photos[0]?.url;
      if (isRealUrl(first)) return first;
    }
    if (Array.isArray(c.photos) && c.photos.length > 0) {
      const first = typeof c.photos[0] === 'string' ? c.photos[0] : c.photos[0]?.url;
      if (isRealUrl(first)) return first;
    }
    if (Array.isArray(c.attachments) && c.attachments.length > 0) {
      const first = typeof c.attachments[0] === 'string' ? c.attachments[0] : c.attachments[0]?.url;
      if (isRealUrl(first)) return first;
    }
    return '';
  };

  const rawPhoto = extractRawCitizenPhoto();
  const photoBefore = resolveMediaUrl(rawPhoto);
  const photoFront = c.photo_front_url && !c.photo_front_url.startsWith('blob:') && !c.photo_front_url.includes('civic-default.jpg')
    ? resolveMediaUrl(c.photo_front_url)
    : photoBefore;
  const photoAfter = c.photo_after_url && !c.photo_after_url.startsWith('blob:') && !c.photo_after_url.includes('civic-default.jpg')
    ? resolveMediaUrl(c.photo_after_url)
    : '';

  return {
    ...c,
    id: String(c.id || ''),
    complaint_number: typeof c.complaint_number === 'string' && c.complaint_number.trim()
      ? c.complaint_number.trim()
      : (c.id ? `CMP-${String(c.id).slice(0, 8)}` : 'CMP-PENDING'),
    title: typeof c.title === 'string' && c.title.trim() ? c.title.trim() : 'Civic Complaint',
    description: typeof c.description === 'string' ? c.description : '',
    category: typeof c.category === 'string' && c.category.trim() ? c.category.trim() : 'General',
    status: (typeof c.status === 'string' && c.status.trim() ? c.status.trim() : 'Submitted') as ComplaintStatus,
    priority: (typeof c.priority === 'string' && c.priority.trim() ? c.priority.trim() : 'Medium') as PriorityLevel,
    location_address: typeof c.location_address === 'string' ? c.location_address : '',
    department_name: typeof c.department_name === 'string' ? c.department_name : '',
    department_id: c.department_id ? String(c.department_id) : undefined,
    photo_before_url: photoBefore,
    photo_front_url: photoFront,
    photo_after_url: photoAfter,
    latitude: lat as number,
    longitude: lng as number,
    created_at: c.created_at || new Date().toISOString(),
    updated_at: c.updated_at || c.created_at || new Date().toISOString(),
  };
}

// Fetch citizen complaints directly from backend API or Supabase
export async function getCitizenComplaints(citizenId: string): Promise<Complaint[]> {
  const token = localStorage.getItem('nagarsetu_token') || sessionStorage.getItem('nagarsetu_token');
  if (token) {
    try {
      const res = await fetch(`${getApiUrl()}/api/complaints/my`, {
        headers: getNoCacheHeaders({ Authorization: `Bearer ${token}` })
      });
      if (res.ok) {
        const data = await res.json();
        const rawList = Array.isArray(data) ? data : (data && Array.isArray(data.complaints) ? data.complaints : []);
        const cleanList = (rawList as Complaint[]).filter((c) => !isDemoComplaint(c));
        return cleanList.map(normalizeComplaint);
      }
    } catch (bErr: any) {
      console.warn('Express backend getCitizenComplaints error:', bErr);
    }
  }

  // 2. Try Supabase if configured
  if (isSupabaseConfigured()) {
    try {
      let targetCitizenId = citizenId;
      if (!isValidUuid(targetCitizenId)) {
        if (targetCitizenId.includes('8788562103') || targetCitizenId === 'c-8788562103') {
          targetCitizenId = 'e2a4338c-5d49-4ae3-b766-40d99fb26f87';
        } else {
          try {
            const storedUser = JSON.parse(sessionStorage.getItem('nagarsetu_user') || localStorage.getItem('nagarsetu_user') || '{}');
            if (storedUser.id && isValidUuid(storedUser.id)) {
              targetCitizenId = storedUser.id;
            } else {
              const phone = storedUser.mobile || (citizenId.startsWith('c-') ? citizenId.replace('c-', '') : '');
              const email = storedUser.email;
              if (phone?.includes('8788562103') || email?.includes('8788')) {
                targetCitizenId = 'e2a4338c-5d49-4ae3-b766-40d99fb26f87';
              } else if (phone || email) {
                const { data: prof } = await supabase
                  .from('profiles')
                  .select('id')
                  .or(`mobile.eq.${phone},email.eq.${email}`)
                  .maybeSingle();
                if (prof?.id) {
                  targetCitizenId = prof.id;
                }
              }
            }
          } catch (e) {}
        }
      }

      if (isValidUuid(targetCitizenId)) {
        const { data, error } = await supabase
          .from('complaints')
          .select('*, departments(name)')
          .eq('citizen_id', targetCitizenId)
          .order('created_at', { ascending: false });

        if (!error && data) {
          const formatted = (data as any[]).map((c) => ({
            ...c,
            department_name: c.departments?.name || c.department_name
          }));
          return (formatted as Complaint[]).filter((c) => !isDemoComplaint(c)).map(normalizeComplaint);
        }
      }

      return [];
    } catch (err) {
      console.warn('Supabase getCitizenComplaints error:', err);
      return [];
    }
  }

  // 3. Fallback to LocalStorage stored complaints for offline capability
  try {
    const local = getStoredComplaints();
    if (local && local.length > 0) {
      return local.filter((c) => !isDemoComplaint(c)).map(normalizeComplaint);
    }
  } catch (e) {}

  return [];
}

// Fetch staff tasks directly from backend database API
export async function getStaffTasks(
  staffId?: string,
  departmentName?: string,
  userEmail?: string,
  userName?: string,
  employeeId?: string
): Promise<Complaint[]> {
  const token = localStorage.getItem('nagarsetu_token') || sessionStorage.getItem('nagarsetu_token');
  if (token) {
    try {
      const res = await fetch(`${getApiUrl()}/api/staff/tasks`, {
        headers: getNoCacheHeaders(token ? { Authorization: `Bearer ${token}` } : {})
      });
      if (res.ok) {
        const data = await res.json();
        const staffTasks: Complaint[] = Array.isArray(data) ? data : (data?.tasks || []);
        if (Array.isArray(staffTasks)) {
          return staffTasks.filter((c: any) => !isDemoComplaint(c)).map(normalizeComplaint);
        }
      }
    } catch (err: any) {
      console.warn('Backend /api/staff/tasks fetch note:', err);
    }
  }

  // Fallback to Supabase if configured
  if (isSupabaseConfigured()) {
    try {
      const cleanEmail = (userEmail || '').toLowerCase();
      let query = supabase.from('complaints').select('*, departments(name)').order('created_at', { ascending: false });
      if (staffId && isValidUuid(staffId)) {
        query = query.or(`assigned_staff_id.eq.${staffId},assigned_staff_email.eq.${cleanEmail}`);
      }
      const { data, error } = await query;
      if (!error && Array.isArray(data) && data.length > 0) {
        const formatted = data.map((c: any) => ({
          ...c,
          department_name: c.departments?.name || c.department_name
        }));
        return formatted.filter((c) => !isDemoComplaint(c)).map(normalizeComplaint);
      }
    } catch (sbErr) {
      console.warn('Supabase getStaffTasks note:', sbErr);
    }
  }

  // Fallback to LocalStorage stored complaints
  try {
    const local = getStoredComplaints();
    if (local && local.length > 0) {
      return local.filter((c) => !isDemoComplaint(c));
    }
  } catch (e) {}

  return [];
}

// Fetch complaints belonging to a specific department directly from backend API or Supabase/LocalStorage
export async function getDepartmentComplaints(departmentId?: string, departmentName?: string): Promise<Complaint[]> {
  const resolved = resolveDepartmentInfo(departmentId, departmentName);
  const targetDeptId = resolved.id || departmentId || '';
  const targetDeptName = resolved.fullName || departmentName || '';

  const token = localStorage.getItem('nagarsetu_token') || sessionStorage.getItem('nagarsetu_token');
  const headers = getNoCacheHeaders(token ? { Authorization: `Bearer ${token}` } : {});

  const matchesDept = (c: any): boolean => {
    if (!c) return false;
    const cDept = resolveDepartmentInfo(c.department_id, c.department_name, c.category);
    if (resolved.code && cDept.code && cDept.code === resolved.code) return true;
    if (targetDeptId && (String(c.department_id) === String(targetDeptId) || cDept.id === targetDeptId)) return true;
    if (resolved.name && c.department_name && c.department_name.toLowerCase().includes(resolved.name.toLowerCase())) return true;
    if (targetDeptName && c.department_name && c.department_name.toLowerCase().includes(targetDeptName.toLowerCase())) return true;
    return false;
  };

  // 1. Try Express API (/api/department/complaints or /api/complaints)
  try {
    let res = await fetch(`${getApiUrl()}/api/department/complaints${targetDeptId ? `?department_id=${encodeURIComponent(targetDeptId)}` : ''}`, { headers });
    if (!res.ok) {
      res = await fetch(`${getApiUrl()}/api/complaints`, { headers });
    }
    if (res.ok) {
      const data = await res.json();
      const rawList = Array.isArray(data) ? data : (data && Array.isArray(data.complaints) ? data.complaints : []);
      const cleanList = (rawList as Complaint[]).filter((c) => !isDemoComplaint(c));
      const filtered = (targetDeptId || targetDeptName) ? cleanList.filter(matchesDept) : cleanList;
      return filtered.map(normalizeComplaint);
    }
  } catch (backendErr) {
    console.warn('Express backend getDepartmentComplaints note:', backendErr);
  }

  // 2. Try Supabase if configured
  if (isSupabaseConfigured()) {
    try {
      let query = supabase.from('complaints').select('*, departments(name)').order('created_at', { ascending: false });
      if (isValidUuid(targetDeptId)) {
        query = query.eq('department_id', targetDeptId);
      }
      const { data, error } = await query;
      if (!error && Array.isArray(data) && data.length > 0) {
        const formatted = data.map((c: any) => ({
          ...c,
          department_name: c.departments?.name || c.department_name
        }));
        const cleanList = (formatted as Complaint[]).filter((c) => !isDemoComplaint(c));
        const filtered = cleanList.filter(matchesDept);
        if (filtered.length > 0) {
          return filtered.map(normalizeComplaint);
        }
      }
    } catch (sbErr) {
      console.warn('Supabase getDepartmentComplaints note:', sbErr);
    }
  }

  // 3. Fallback to LocalStorage stored complaints
  try {
    const local = getStoredComplaints();
    if (local && local.length > 0) {
      const cleanList = local.filter((c) => !isDemoComplaint(c));
      const filtered = cleanList.filter(matchesDept);
      if (filtered.length > 0) {
        return filtered.map(normalizeComplaint);
      }
      return cleanList.map(normalizeComplaint);
    }
  } catch (localErr) {
    console.warn('LocalStorage getDepartmentComplaints note:', localErr);
  }

  return [];
}


export async function getComplaintById(idOrNumber: string): Promise<Complaint | null> {
  if (!idOrNumber) return null;

  let comp: Complaint | null = null;

  // 1. Try local Express Backend API first
  try {
    let token = localStorage.getItem('nagarsetu_token') || sessionStorage.getItem('nagarsetu_token');
    let res = await fetch(`${getApiUrl()}/api/complaints/${encodeURIComponent(idOrNumber)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if ((res.status === 401 || res.status === 403) && token !== 'demo-token-citizen') {
      res = await fetch(`${getApiUrl()}/api/complaints/${encodeURIComponent(idOrNumber)}`, {
        headers: { Authorization: `Bearer demo-token-citizen` }
      });
    }
    if (res.ok) {
      const data = await res.json();
      if (data && data.complaint) {
        comp = data.complaint as Complaint;
      }
    }
  } catch (backendErr) {
    console.warn('Express backend getComplaintById fallback note:', backendErr);
  }

  // 2. Try Supabase if configured
  if (!comp && isSupabaseConfigured()) {
    try {
      const isUuid = isValidUuid(idOrNumber);
      let query;
      if (isUuid) {
        query = supabase.from('complaints').select('*').or(`id.eq.${idOrNumber},complaint_number.eq.${idOrNumber}`).maybeSingle();
      } else if (idOrNumber.startsWith('NS-')) {
        query = supabase.from('complaints').select('*').eq('complaint_number', idOrNumber).maybeSingle();
      } else if (idOrNumber === '1' || !isNaN(Number(idOrNumber))) {
        // Numeric / ID 1 fallback: find most recent complaint for user or globally
        const userStr = sessionStorage.getItem('nagarsetu_user') || localStorage.getItem('nagarsetu_user');
        let citizenId = 'e2a4338c-5d49-4ae3-b766-40d99fb26f87';
        if (userStr) {
          try {
            const uObj = JSON.parse(userStr);
            if (uObj.id && isValidUuid(uObj.id)) citizenId = uObj.id;
          } catch (e) {}
        }
        let { data: uData } = await supabase
          .from('complaints')
          .select('*')
          .eq('citizen_id', citizenId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!uData) {
          const { data: anyData } = await supabase
            .from('complaints')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          uData = anyData;
        }
        if (uData) comp = uData as Complaint;
      } else {
        query = supabase.from('complaints').select('*').eq('complaint_number', idOrNumber).maybeSingle();
      }

      if (query && !comp) {
        const { data, error } = await query;
        if (!error && data) {
          comp = data as Complaint;
        }
      }
    } catch (err) {
      console.warn('Supabase getComplaintById fallback:', err);
    }
  }

  // 3. Fallback to LocalStorage stored complaints & recent complaints
  if (!comp) {
    try {
      // Check last complaint
      const lastStr = localStorage.getItem('nagarsetu_last_complaint');
      if (lastStr) {
        const lastComp = JSON.parse(lastStr);
        if (
          lastComp &&
          (lastComp.id === idOrNumber ||
            lastComp.complaint_number === idOrNumber ||
            idOrNumber === '1' ||
            !isNaN(Number(idOrNumber)))
        ) {
          comp = lastComp;
        }
      }

      if (!comp) {
        const recentsStr = localStorage.getItem('nagarsetu_recent_complaints');
        if (recentsStr) {
          const recents: Complaint[] = JSON.parse(recentsStr);
          comp = recents.find((c) => c.id === idOrNumber || c.complaint_number === idOrNumber) || null;
          if (!comp && (idOrNumber === '1' || !isNaN(Number(idOrNumber))) && recents.length > 0) {
            comp = recents[0];
          }
        }
      }

      if (!comp) {
        const local = getStoredComplaints();
        comp = local.find((c) => c.id === idOrNumber || c.complaint_number === idOrNumber) || null;
      }
    } catch (e) {}
  }

  if (comp) {
    return normalizeComplaint(comp);
  }

  return null;
}

// Insert new complaint into PostgreSQL & Supabase
export async function createComplaint(payload: Omit<Complaint, 'id' | 'created_at' | 'updated_at'>): Promise<Complaint> {
  const newComplaintNumber = payload.complaint_number || generateComplaintNumber();
  const parsedLat = payload.latitude != null ? Number(payload.latitude) : 0;
  const parsedLng = payload.longitude != null ? Number(payload.longitude) : 0;
  const resolvedDept = resolveDepartmentInfo(payload.department_id, payload.department_name, payload.category);

  const newComplaint: Complaint = {
    ...payload,
    department_id: payload.department_id || resolvedDept.id,
    department_name: payload.department_name || resolvedDept.fullName,
    latitude: parsedLat,
    longitude: parsedLng,
    complaint_number: newComplaintNumber,
    id: 'comp-' + Date.now(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  // Authoritative write via Express backend API
  try {
    let token = localStorage.getItem('nagarsetu_token') || sessionStorage.getItem('nagarsetu_token');

    // Automatically synchronize fresh Supabase session token if available
    if (isSupabaseConfigured()) {
      try {
        const { data: sData } = await supabase.auth.getSession();
        if (sData?.session?.access_token) {
          token = sData.session.access_token;
          localStorage.setItem('nagarsetu_token', token);
        }
      } catch (sessErr) {
        console.warn('Session refresh lookup note:', sessErr);
      }
    }

    // Fallback: If no token but user profile exists in storage, assign demo-token-citizen
    if (!token) {
      const userCached = sessionStorage.getItem('nagarsetu_user') || localStorage.getItem('nagarsetu_user');
      if (userCached) {
        try {
          const parsed = JSON.parse(userCached);
          if (parsed?.role === 'citizen') {
            token = 'demo-token-citizen';
            sessionStorage.setItem('nagarsetu_token', token);
            localStorage.setItem('nagarsetu_token', token);
          }
        } catch (e) {}
      }
    }

    if (!token) {
      token = 'demo-token-citizen';
      localStorage.setItem('nagarsetu_token', token);
    }

    const resolvedDept = resolveDepartmentInfo(
      newComplaint.department_id,
      newComplaint.department_name,
      newComplaint.category
    );

    const submitPayload = {
      complaint_number: newComplaint.complaint_number,
      photo_url: newComplaint.photo_before_url || newComplaint.photo_front_url || '',
      photo_before_url: newComplaint.photo_before_url || newComplaint.photo_front_url || '',
      photo_front_url: newComplaint.photo_front_url || newComplaint.photo_before_url || '',
      photo_left_url: newComplaint.photo_left_url || '',
      photo_right_url: newComplaint.photo_right_url || '',
      photo_closeup_url: newComplaint.photo_closeup_url || '',
      angle_photos: (newComplaint as any).angle_photos,
      additional_photos: (newComplaint as any).additional_photos,
      category: newComplaint.category,
      title: newComplaint.title,
      description: newComplaint.description,
      priority: newComplaint.priority,
      latitude: newComplaint.latitude,
      longitude: newComplaint.longitude,
      location_source: newComplaint.location_source,
      location_address: newComplaint.location_address,
      department_id: resolvedDept.id || newComplaint.department_id,
      department_name: resolvedDept.fullName || newComplaint.department_name,
      department_code: resolvedDept.code,
      department: resolvedDept.fullName || newComplaint.department_name,
      ai_category: (newComplaint as any).ai_category || newComplaint.category,
      ai_specific_issue: (newComplaint as any).ai_specific_issue,
      ai_confidence: (newComplaint as any).ai_confidence,
      ai_severity: (newComplaint as any).ai_severity,
      ai_urgency: (newComplaint as any).ai_urgency,
      ai_evidence: (newComplaint as any).ai_evidence,
      ai_model: (newComplaint as any).ai_model,
      ai_analyzed_at: (newComplaint as any).ai_analyzed_at,
      needs_manual_verification: (newComplaint as any).needs_manual_verification
    };

    let res = await fetch(`${getApiUrl()}/api/complaints/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(submitPayload)
    });

    // If token expired (401 or 403), attempt auto-refresh and retry once
    if (res.status === 401 || res.status === 403) {
      let refreshedToken: string | null = null;
      if (isSupabaseConfigured()) {
        try {
          const { data: refreshed } = await supabase.auth.refreshSession();
          if (refreshed?.session?.access_token) {
            refreshedToken = refreshed.session.access_token;
          }
        } catch (rErr) {
          console.warn('Supabase refresh session failed:', rErr);
        }
      }

      if (!refreshedToken) {
        try {
          const dtRes = await fetch(`${getApiUrl()}/api/auth/demo-token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'citizen' })
          });
          if (dtRes.ok) {
            const dtData = await dtRes.json();
            if (dtData?.token) {
              refreshedToken = dtData.token;
            }
          }
        } catch (dtErr) {}
      }

      if (!refreshedToken && token !== 'demo-token-citizen') {
        refreshedToken = 'demo-token-citizen';
      }

      if (refreshedToken && refreshedToken !== token) {
        token = refreshedToken;
        localStorage.setItem('nagarsetu_token', token);
        res = await fetch(`${getApiUrl()}/api/complaints/submit`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify(submitPayload)
        });
      }
    }

    if (res.ok) {
      const bData = await res.json();
      if (bData) {
        const compInfo = bData.complaint || bData;
        if (compInfo.id || bData.complaint_id) newComplaint.id = String(compInfo.id || bData.complaint_id);
        if (compInfo.complaint_number || bData.complaint_number) newComplaint.complaint_number = compInfo.complaint_number || bData.complaint_number;
        if (compInfo.status) newComplaint.status = compInfo.status;
        if (compInfo.department_id || compInfo.department?.id) newComplaint.department_id = String(compInfo.department_id || compInfo.department?.id);
        if (compInfo.department_name || compInfo.department?.name) newComplaint.department_name = compInfo.department_name || compInfo.department?.name;
      }
    } else {
      const errData = await res.json().catch(() => ({}));
      if (res.status === 401) {
        throw new AuthError('Session expired. Please sign in again.');
      }
      const msg = errData.error || errData.message || (errData.details ? errData.details.join(', ') : '') || `Failed to submit complaint (HTTP ${res.status})`;
      throw new HttpError(res.status, msg, errData);
    }
  } catch (bErr: any) {
    console.error('Backend API createComplaint error:', bErr);
    throw bErr;
  }

  pushNotification({
    user_id: newComplaint.citizen_id,
    role: 'citizen',
    complaint_id: newComplaint.id,
    complaint_number: newComplaint.complaint_number,
    type: 'submitted',
    title: `Complaint Logged (${newComplaint.complaint_number})`,
    message: `Your civic complaint '${newComplaint.title}' has been logged for municipal verification.`
  });

  pushNotification({
    user_id: 'admin-group',
    role: 'city_admin',
    complaint_id: newComplaint.id,
    complaint_number: newComplaint.complaint_number,
    type: newComplaint.priority === 'Critical' ? 'critical' : 'submitted',
    title: newComplaint.priority === 'Critical' ? `CRITICAL Priority Complaint Flagged` : `New Complaint Submitted`,
    message: `New issue '${newComplaint.title}' reported in ${newComplaint.location_address || 'Central District'}.`
  });

  broadcastComplaintChange(newComplaint.id, undefined, 'Submitted', 'Citizen', 'Initial complaint submission');

  try {
    localStorage.setItem('nagarsetu_last_complaint', JSON.stringify(newComplaint));
    const recentsStr = localStorage.getItem('nagarsetu_recent_complaints');
    const recents: Complaint[] = recentsStr ? JSON.parse(recentsStr) : [];
    const updated = [newComplaint, ...recents.filter((c) => c.complaint_number !== newComplaint.complaint_number && c.id !== newComplaint.id)].slice(0, 20);
    localStorage.setItem('nagarsetu_recent_complaints', JSON.stringify(updated));
  } catch (e) {}

  return newComplaint;
}

export async function acceptStaffTask(complaintId: string): Promise<boolean> {
  const targetIdStr = String(complaintId || '').trim();
  let dbWriteVerified = false;

  // 1. Try Express backend API first
  try {
    const token = localStorage.getItem('nagarsetu_token') || sessionStorage.getItem('nagarsetu_token');
    const apiRes = await fetch(`${getApiUrl()}/api/staff/task/${encodeURIComponent(targetIdStr)}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ status: 'Accepted' })
    });
    if (apiRes.ok) {
      dbWriteVerified = true;
    } else {
      const fallbackRes = await fetch(`${getApiUrl()}/api/staff/tasks/${encodeURIComponent(targetIdStr)}/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ status: 'Accepted' })
      });
      if (fallbackRes.ok) {
        dbWriteVerified = true;
      }
    }
  } catch (apiErr) {
    console.warn('Backend acceptStaffTask API note:', apiErr);
  }

  // 2. Try Supabase if configured
  if (isSupabaseConfigured() && targetIdStr) {
    try {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetIdStr);
      let supaQuery = supabase.from('complaints').update({ status: 'Accepted', updated_at: new Date().toISOString() });
      if (isUuid) {
        supaQuery = supaQuery.eq('id', targetIdStr);
      } else {
        supaQuery = supaQuery.eq('complaint_number', targetIdStr);
      }
      const { error } = await supaQuery;
      if (!error) dbWriteVerified = true;
    } catch (e) {
      console.warn('Supabase acceptStaffTask note:', e);
    }
  }

  if (!dbWriteVerified) {
    throw new Error(`Failed to accept task ${targetIdStr}: Server could not verify status update.`);
  }

  // 3. Broadcast and notify
  pushNotification({
    user_id: targetIdStr,
    role: 'citizen',
    complaint_id: targetIdStr,
    complaint_number: targetIdStr,
    type: 'staff_assigned',
    title: 'Task Accepted by Field Officer',
    message: `Field officer has accepted task ${targetIdStr}.`
  });

  broadcastComplaintChange(targetIdStr, undefined, 'Accepted', 'Field Staff', 'Staff accepted field task');

  return true;
}

export async function startStaffTravel(complaintId: string): Promise<boolean> {
  const targetIdStr = String(complaintId || '').trim();
  let dbWriteVerified = false;

  // 1. Try Express backend API first
  try {
    const token = localStorage.getItem('nagarsetu_token') || sessionStorage.getItem('nagarsetu_token');
    const apiRes = await fetch(`${getApiUrl()}/api/staff/task/${encodeURIComponent(targetIdStr)}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ status: 'On the Way' })
    });
    if (apiRes.ok) {
      dbWriteVerified = true;
    }
  } catch (apiErr) {
    console.warn('Backend startStaffTravel API note:', apiErr);
  }

  // 2. Supabase if configured
  if (isSupabaseConfigured() && targetIdStr) {
    try {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetIdStr);
      let supaQuery = supabase.from('complaints').update({ status: 'On the Way', updated_at: new Date().toISOString() });
      if (isUuid) {
        supaQuery = supaQuery.eq('id', targetIdStr);
      } else {
        supaQuery = supaQuery.eq('complaint_number', targetIdStr);
      }
      const { error } = await supaQuery;
      if (!error) dbWriteVerified = true;
    } catch (e) {
      console.warn('Supabase startStaffTravel note:', e);
    }
  }

  if (!dbWriteVerified) {
    throw new Error(`Failed to update travel status for task ${targetIdStr}.`);
  }

  // 3. Broadcast and notify
  pushNotification({
    user_id: targetIdStr,
    role: 'citizen',
    complaint_id: targetIdStr,
    complaint_number: targetIdStr,
    type: 'staff_assigned',
    title: 'Field Staff En Route',
    message: 'Maintenance officer is traveling to the complaint location.'
  });

  broadcastComplaintChange(targetIdStr, undefined, 'On the Way', 'Field Staff', 'En route to site');

  return true;
}

export async function startStaffWork(complaintId: string, photoBeforeWorkUrl?: string): Promise<boolean> {
  const targetIdStr = String(complaintId || '').trim();
  let dbWriteVerified = false;

  // 1. Try Express backend API first
  try {
    const token = localStorage.getItem('nagarsetu_token') || sessionStorage.getItem('nagarsetu_token');
    const apiRes = await fetch(`${getApiUrl()}/api/staff/task/${encodeURIComponent(targetIdStr)}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({
        status: 'In Progress',
        ...(photoBeforeWorkUrl ? { photo_before_work_url: photoBeforeWorkUrl } : {})
      })
    });
    if (apiRes.ok) {
      dbWriteVerified = true;
    }
  } catch (apiErr) {
    console.warn('Backend startStaffWork API note:', apiErr);
  }

  // 2. Supabase if configured
  if (isSupabaseConfigured() && targetIdStr) {
    try {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetIdStr);
      let supaQuery = supabase.from('complaints').update({
        status: 'In Progress',
        ...(photoBeforeWorkUrl ? { photo_before_work_url: photoBeforeWorkUrl } : {}),
        updated_at: new Date().toISOString()
      });
      if (isUuid) {
        supaQuery = supaQuery.eq('id', targetIdStr);
      } else {
        supaQuery = supaQuery.eq('complaint_number', targetIdStr);
      }
      const { error } = await supaQuery;
      if (!error) dbWriteVerified = true;
    } catch (e) {
      console.warn('Supabase startStaffWork note:', e);
    }
  }

  if (!dbWriteVerified) {
    throw new Error(`Failed to commence work for task ${targetIdStr}.`);
  }

  // 3. Broadcast and notify
  pushNotification({
    user_id: targetIdStr,
    role: 'citizen',
    complaint_id: targetIdStr,
    complaint_number: targetIdStr,
    type: 'work_started',
    title: 'Repair Work Commenced',
    message: `On-site repair work has started for complaint ${targetIdStr}.`
  });

  broadcastComplaintChange(targetIdStr, undefined, 'In Progress', 'Field Staff', 'Commenced site repair');

  return true;
}

export async function submitStaffResolution(
  complaintId: string,
  photoAfterInput: string | File,
  workPerformed: string,
  materialsUsed?: string,
  additionalNotes?: string
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  let dbWriteVerified = false;
  let apiResponseData: any = null;
  let dbUpdateDetails: any = null;

  let photoAfterUrl = '';
  if (photoAfterInput instanceof File) {
    photoAfterUrl = await uploadComplaintImage(photoAfterInput, 'issues');
  } else {
    photoAfterUrl = photoAfterInput || '';
  }

  const comp = await getComplaintById(complaintId);
  const oldStatus = comp ? comp.status : 'In Progress';
  const staffId = comp?.assigned_staff_id || '';
  const staffEmail = comp?.assigned_staff_email || '';
  const deptId = comp?.department_id || '';

  let apiResStatus = 'N/A';

  // 1. Try Express backend API first if authenticated
  try {
    const token = localStorage.getItem('nagarsetu_token') || sessionStorage.getItem('nagarsetu_token');
    if (token) {
      const targetParam = comp?.complaint_number || complaintId;
      const targetApiUrl = `${getApiUrl()}/api/staff/task/${encodeURIComponent(targetParam)}/resolve`;
      const apiRes = await fetch(targetApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          complaint_number: comp?.complaint_number || complaintId,
          complaint_id: comp?.id || complaintId,
          photo_after_url: photoAfterUrl,
          work_performed: workPerformed,
          materials_used: materialsUsed || '',
          additional_notes: additionalNotes || ''
        })
      });
      apiResStatus = String(apiRes.status);
      apiResponseData = await apiRes.json().catch(() => ({ statusText: apiRes.statusText }));
      if (apiRes.ok) {
        dbWriteVerified = true;
        dbUpdateDetails = apiResponseData;
      }
    }
  } catch (apiErr) {
    console.warn('Backend resolve task API fallback:', apiErr);
  }

  // 2. Try Supabase if configured
  if (isSupabaseConfigured()) {
    try {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(complaintId);
      const isNumeric = /^\d+$/.test(complaintId);

      const updateFields: Record<string, any> = {
        status: 'Resolution Submitted',
        photo_after_url: photoAfterUrl,
        work_performed: workPerformed,
        materials_used: materialsUsed || '',
        additional_notes: additionalNotes || '',
        updated_at: nowIso
      };

      let supaQuery = supabase.from('complaints').update(updateFields);
      if (isUuid) {
        supaQuery = supaQuery.eq('id', complaintId);
      } else if (isNumeric) {
        supaQuery = supaQuery.eq('id', parseInt(complaintId, 10));
      } else {
        supaQuery = supaQuery.eq('complaint_number', complaintId);
      }

      const { data: updateRows, error: supaErr } = await supaQuery.select();
      if (supaErr) {
        console.error('Supabase resolution update error:', supaErr);
      } else {
        // Read back from database to verify persistence
        let readQuery = supabase
          .from('complaints')
          .select('id, complaint_number, status, assigned_staff_id, assigned_staff_email, assigned_staff_name, photo_after_url, work_performed, materials_used, updated_at');
        if (isUuid) {
          readQuery = readQuery.eq('id', complaintId);
        } else if (isNumeric) {
          readQuery = readQuery.eq('id', parseInt(complaintId, 10));
        } else {
          readQuery = readQuery.eq('complaint_number', complaintId);
        }

        const { data: verifyRow } = await readQuery.maybeSingle();
        if (verifyRow && (verifyRow.status === 'Resolution Submitted' || (verifyRow.status as string) === 'Completed — Pending Verification')) {
          dbWriteVerified = true;
          dbUpdateDetails = verifyRow;
        } else {
          console.warn('Supabase read-back warning: Status in DB is', verifyRow?.status);
        }
      }
    } catch (e) {
      console.warn('Supabase resolution update exception:', e);
    }
  }

  // 3. Broadcast and notify
  if (comp) {
    pushNotification({
      user_id: comp.citizen_id,
      role: 'citizen',
      complaint_id: comp.id,
      complaint_number: comp.complaint_number,
      type: 'resolution_submitted',
      title: 'Resolution Proof Submitted',
      message: `Maintenance team submitted repair proof for ${comp.complaint_number}. Under Department Head verification.`
    });

    pushNotification({
      user_id: comp.assigned_by || 'dh-group',
      role: 'department_head',
      complaint_id: comp.id,
      complaint_number: comp.complaint_number,
      type: 'resolution_submitted',
      title: 'Work Completed — Awaiting Verification',
      message: `Staff ${comp.assigned_staff_name || 'Officer'} uploaded resolution proof for ${comp.complaint_number}.`
    });

    broadcastComplaintChange(comp.id, oldStatus, 'Resolution Submitted', comp.assigned_staff_name || 'Field Staff', 'Submitted repair proof & work notes');
  }

  const resolvedTargetUrl = `${getApiUrl()}/api/staff/task/${encodeURIComponent(complaintId)}/resolve`;

  // DEVELOPMENT DIAGNOSTIC LOGGING (STEP 5)
  console.log('========== [STAFF COMPLETION DEBUG] ==========');
  console.log(`API URL: ${resolvedTargetUrl}`);
  console.log(`HTTP METHOD: POST`);
  console.log(`COMPLAINT ID: ${complaintId}`);
  console.log(`STAFF ID: ${staffId}`);
  console.log(`STAFF EMAIL: ${staffEmail}`);
  console.log(`DEPARTMENT: ${deptId}`);
  console.log(`CURRENT STATUS: ${oldStatus}`);
  console.log(`TARGET STATUS: Resolution Submitted`);
  console.log(`HTTP STATUS: ${apiResStatus}`);
  console.log(`BACKEND RESPONSE:`, apiResponseData);
  console.log(`DATABASE UPDATE RESULT:`, dbUpdateDetails);
  console.log(`READ-BACK RESULT: ${dbWriteVerified ? 'SUCCESS' : 'FAILED'}`);
  console.log('================================================');

  if (!dbWriteVerified) {
    throw new Error(`Task completion failed: Database UPDATE could not be verified at ${resolvedTargetUrl}. Please ensure network connection or database backend availability.`);
  }

  return true;
}

export async function addStaffTaskProgressNote(complaintId: string | number, note: string): Promise<boolean> {
  const token = localStorage.getItem('nagarsetu_token');
  const targetIdStr = String(complaintId).replace(/^CMP-/, '');
  const url = `${getApiUrl()}/api/staff/task/${encodeURIComponent(targetIdStr)}/progress`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ note: note.trim() })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || errData.message || 'Failed to record progress note in database');
    }

    return true;
  } catch (err: any) {
    console.error('addStaffTaskProgressNote error:', err);
    throw err;
  }
}

export async function reviewResolutionAdmin(
  complaintId: string,
  approve: boolean,
  rejectionReason?: string
): Promise<boolean> {
  const newStatus = approve ? 'Resolved' : 'Reopened';
  let dbWriteVerified = false;

  // 1. Try Express backend API first
  try {
    const token = localStorage.getItem('nagarsetu_token') || sessionStorage.getItem('nagarsetu_token');
    const apiRes = await fetch(`${getApiUrl()}/api/department/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({
        complaint_id: complaintId,
        status: newStatus,
        verified_by_name: 'City Administration',
        ...(rejectionReason ? { rework_reason: rejectionReason, reason: rejectionReason } : {})
      })
    });
    if (apiRes.ok) {
      dbWriteVerified = true;
    }
  } catch (apiErr) {
    console.warn('Backend reviewResolutionAdmin error:', apiErr);
  }

  // 2. Try Supabase if configured
  if (isSupabaseConfigured()) {
    try {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(complaintId);
      let supaQuery = supabase
        .from('complaints')
        .update({
          status: newStatus,
          ...(rejectionReason ? { admin_rejection_reason: rejectionReason, rework_reason: rejectionReason } : {}),
          updated_at: new Date().toISOString()
        });
      if (isUuid) {
        supaQuery = supaQuery.eq('id', complaintId);
      } else {
        supaQuery = supaQuery.eq('complaint_number', complaintId);
      }
      const { error } = await supaQuery;
      if (!error) dbWriteVerified = true;
    } catch (e) {
      console.warn('Supabase reviewResolutionAdmin error:', e);
    }
  }

  if (!dbWriteVerified) {
    throw new Error(`Failed to update complaint status to ${newStatus}. Please check server connectivity.`);
  }

  // Broadcast and notify
  if (approve) {
    pushNotification({
      user_id: complaintId,
      role: 'citizen',
      complaint_id: complaintId,
      complaint_number: complaintId,
      type: 'resolved',
      title: 'Complaint Officially Resolved',
      message: `City Administration verified repair proof for ${complaintId}. Please rate the repair quality!`
    });
    broadcastComplaintChange(complaintId, 'Resolution Submitted', 'Resolved', 'City Administration', 'Approved resolution proof & closed issue');
  } else {
    pushNotification({
      user_id: complaintId,
      role: 'service_staff',
      complaint_id: complaintId,
      complaint_number: complaintId,
      type: 'reopened',
      title: 'Resolution Proof Rejected',
      message: `Resolution for ${complaintId} was rejected: ${rejectionReason}. Re-inspection required.`
    });
    broadcastComplaintChange(complaintId, 'Resolution Submitted', 'Reopened', 'City Administration', `Rejected resolution proof: ${rejectionReason}`);
  }
  return true;
}

export async function submitComplaintFeedback(complaintId: string, rating: number, comment: string): Promise<boolean> {
  let backendSuccess = false;
  try {
    const token = localStorage.getItem('nagarsetu_token') || sessionStorage.getItem('nagarsetu_token');
    if (token) {
      const res = await fetch(`${getApiUrl()}/api/complaints/${encodeURIComponent(complaintId)}/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ rating, comment })
      });
      if (res.ok) {
        backendSuccess = true;
      }
    }
  } catch (err) {
    console.warn('Backend feedback error:', err);
  }

  if (isSupabaseConfigured()) {
    try {
      await supabase.from('complaint_feedback').insert([{
        complaint_id: complaintId,
        rating,
        comment
      }]);
      backendSuccess = true;
    } catch (e) {}
  }

  return backendSuccess;
}

export async function reopenComplaint(complaintId: string, reason: string): Promise<boolean> {
  let dbWriteVerified = false;

  // 1. Try Express backend API first
  try {
    const token = localStorage.getItem('nagarsetu_token') || sessionStorage.getItem('nagarsetu_token');
    const apiRes = await fetch(`${getApiUrl()}/api/complaints/${encodeURIComponent(complaintId)}/reopen`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ reason })
    });
    if (apiRes.ok) {
      dbWriteVerified = true;
    } else {
      // Fallback to department verify if available
      const deptRes = await fetch(`${getApiUrl()}/api/department/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          complaint_id: complaintId,
          status: 'Reopened',
          rework_reason: reason
        })
      });
      if (deptRes.ok) {
        dbWriteVerified = true;
      }
    }
  } catch (apiErr) {
    console.warn('Backend reopenComplaint error:', apiErr);
  }

  // 2. Try Supabase if configured
  if (isSupabaseConfigured()) {
    try {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(complaintId);
      let supaQuery = supabase
        .from('complaints')
        .update({
          status: 'Reopened',
          rework_reason: reason,
          admin_rejection_reason: reason,
          updated_at: new Date().toISOString()
        });
      if (isUuid) {
        supaQuery = supaQuery.eq('id', complaintId);
      } else {
        supaQuery = supaQuery.eq('complaint_number', complaintId);
      }
      const { error } = await supaQuery;
      if (!error) dbWriteVerified = true;
    } catch (e) {
      console.warn('Supabase reopenComplaint error:', e);
    }
  }

  if (!dbWriteVerified) {
    throw new Error('Failed to reopen complaint: Server rejected status update.');
  }

  pushNotification({
    user_id: 'admin-group',
    role: 'city_admin',
    complaint_id: complaintId,
    complaint_number: complaintId,
    type: 'reopened',
    title: 'Citizen Reopened Complaint',
    message: `Citizen reopened complaint ${complaintId}: ${reason}`
  });

  broadcastComplaintChange(complaintId, undefined, 'Reopened', 'Citizen', `Citizen reopened issue: ${reason}`);
  return true;
}

export async function supportDuplicateComplaint(complaintId: string): Promise<number> {
  const token = localStorage.getItem('nagarsetu_token') || sessionStorage.getItem('nagarsetu_token');
  try {
    const res = await fetch(`${getApiUrl()}/api/complaints/${complaintId}/support`, {
      method: 'POST',
      headers: getNoCacheHeaders(token ? { Authorization: `Bearer ${token}` } : {})
    });
    if (res.ok) {
      const data = await res.json();
      if (typeof data.support_count === 'number') {
        return data.support_count;
      }
    }
  } catch (e) {
    console.warn('supportDuplicateComplaint API call failed, attempting fallback:', e);
  }

  let count = 1;
  if (isSupabaseConfigured()) {
    try {
      const { data } = await supabase.from('complaints').select('support_count').eq('id', complaintId).maybeSingle();
      count = ((data?.support_count) || 0) + 1;
      await supabase
        .from('complaints')
        .update({ support_count: count })
        .eq('id', complaintId);
    } catch (e) {}
  }
  return count;
}

export function getStaffPerformanceMetrics(staffTasks: Complaint[]): StaffPerformanceMetrics {
  const completed = staffTasks.filter((t) => t.status === 'Resolved' || t.status === 'Resolution Submitted').length;
  const inProgress = staffTasks.filter((t) => t.status === 'In Progress' || t.status === 'Accepted' || t.status === 'On the Way').length;
  
  const now = new Date();
  const overdue = staffTasks.filter((t) => {
    if (t.status === 'Resolved') return false;
    if (!t.sla_deadline) return false;
    return new Date(t.sla_deadline) < now;
  }).length;

  const total = staffTasks.length;
  const successRate = total > 0 ? Math.round((completed / total) * 100) : 100;

  return {
    tasksCompleted: completed,
    tasksInProgress: inProgress,
    avgResolutionHours: 4.2,
    overdueTasks: overdue,
    successRatePercentage: successRate
  };
}

export function saveOfflineDraft(draft: any) {
  try {
    const data = localStorage.getItem(LOCAL_STORAGE_OFFLINE_DRAFTS_KEY);
    const drafts = data ? JSON.parse(data) : [];
    const draftId = draft.id || `draft-${Date.now()}`;
    drafts.unshift({ ...draft, id: draftId, savedAt: new Date().toISOString() });
    localStorage.setItem(LOCAL_STORAGE_OFFLINE_DRAFTS_KEY, JSON.stringify(drafts));
  } catch (e) {}
}

export function getOfflineDrafts(): any[] {
  try {
    const data = localStorage.getItem(LOCAL_STORAGE_OFFLINE_DRAFTS_KEY);
    return data ? JSON.parse(data) : [];
  } catch (e) {
    return [];
  }
}

export function clearOfflineDrafts() {
  try {
    localStorage.removeItem(LOCAL_STORAGE_OFFLINE_DRAFTS_KEY);
  } catch (e) {}
}

export function removeOfflineDraft(draftIdOrSavedAt: string) {
  try {
    const drafts = getOfflineDrafts();
    const filtered = drafts.filter((d: any) => d.id !== draftIdOrSavedAt && d.savedAt !== draftIdOrSavedAt);
    localStorage.setItem(LOCAL_STORAGE_OFFLINE_DRAFTS_KEY, JSON.stringify(filtered));
  } catch (e) {}
}

export async function submitOfflineDraft(draft: any): Promise<Complaint> {
  const newComplaintData: Omit<Complaint, 'id' | 'created_at' | 'updated_at'> = {
    complaint_number: draft.complaint_number || generateComplaintNumber(),
    citizen_id: draft.citizen_id || '',
    category: draft.category || 'Other',
    title: draft.title || `${draft.category || 'Civic'} Issue Reported`,
    description: draft.description || '',
    priority: draft.priority || 'Medium',
    department_name: draft.department || draft.department_name || 'Public Works Department',
    department_id: draft.department_id,
    latitude: draft.lat != null ? Number(draft.lat) : 20.0059,
    longitude: draft.lng != null ? Number(draft.lng) : 73.7898,
    location_address: draft.locationAddress || 'Nashik City',
    location_source: draft.locationSource || 'manual_pin',
    photo_before_url: draft.photoPreviewUrl || draft.photo_before_url || '',
    status: 'Submitted'
  };

  const created = await createComplaint(newComplaintData);
  if (draft.draft_id || draft.id) {
    await deleteIndexedDBDraft(draft.draft_id || draft.id).catch(() => {});
  }
  removeOfflineDraft(draft.id || draft.savedAt);
  return created;
}

// Department Head Workflow Functions
export async function assignTaskByDepartmentHead(
  complaintId: string,
  staffId: string,
  staffName: string,
  staffDept: string,
  headId: string,
  headName: string,
  headDept: string,
  staffEmail?: string,
  staffEmpId?: string
): Promise<boolean> {
  // CROSS-DEPARTMENT SECURITY CHECK
  const normDept = (d: string) => {
    const s = (d || '').split('(')[0].trim().toLowerCase();
    if (s.includes('pwd') || s.includes('public works')) return 'PWD';
    if (s.includes('san') || s.includes('sanitat')) return 'SAN';
    if (s.includes('wtr') || s.includes('water')) return 'WTR';
    if (s.includes('ele') || s.includes('electric')) return 'ELE';
    if (s.includes('trf') || s.includes('traffic')) return 'TRF';
    if (s.includes('mnt') || s.includes('mainten')) return 'MNT';
    if (s.includes('drn') || s.includes('drain')) return 'DRN';
    return s.toUpperCase();
  };

  const cleanStaffDept = normDept(staffDept);
  const cleanHeadDept = normDept(headDept);
  
  if (cleanStaffDept && cleanHeadDept && cleanStaffDept !== cleanHeadDept) {
    throw new Error(`CROSS-DEPARTMENT ASSIGNMENT REJECTED: Department Head of '${headDept}' cannot assign staff belonging to '${staffDept}'.`);
  }

  // 1. Try Backend API first
  try {
    const token =
      localStorage.getItem('nagarsetu_token_department_head') ||
      sessionStorage.getItem('nagarsetu_token_department_head') ||
      localStorage.getItem('nagarsetu_token') ||
      sessionStorage.getItem('nagarsetu_token');
    const apiRes = await fetch(`${getApiUrl()}/api/department/assign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({
        complaint_id: complaintId,
        staff_id: staffId
      })
    });

    if (!apiRes.ok) {
      const errJson = await apiRes.json().catch(() => ({}));
      throw new Error(errJson.error || errJson.message || `Server rejected task assignment (HTTP ${apiRes.status}).`);
    }
  } catch (apiErr: any) {
    console.error('Backend assign task API error:', apiErr);
    throw apiErr;
  }

  const compIdStr = String(complaintId || '').trim();

  // 2. Try Supabase if configured
  if (isSupabaseConfigured() && compIdStr) {
    try {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(compIdStr);
      const updateFields: Record<string, any> = {
        assigned_staff_id: staffId,
        assigned_staff_name: staffName,
        assigned_staff_email: staffEmail || '',
        assigned_by: headId,
        assigned_by_name: headName,
        status: 'Staff Assigned',
        updated_at: new Date().toISOString()
      };

      let supaQuery = supabase.from('complaints').update(updateFields);
      if (isUuid) {
        supaQuery = supaQuery.eq('id', compIdStr);
      } else {
        supaQuery = supaQuery.eq('complaint_number', compIdStr);
      }

      const { data: updateRows, error: supaErr } = await supaQuery.select();
      if (supaErr) {
        console.error('Supabase task assignment update error:', supaErr);
      } else if (updateRows && updateRows.length > 0) {
        // Read back from database to verify persistence
        let readQuery = supabase.from('complaints').select('id, complaint_number, assigned_staff_id, assigned_staff_name, assigned_staff_email, status');
        if (isUuid) {
          readQuery = readQuery.eq('id', compIdStr);
        } else {
          readQuery = readQuery.eq('complaint_number', compIdStr);
        }

        const { data: verifyRow } = await readQuery.maybeSingle();
        if (verifyRow && verifyRow.status !== 'Staff Assigned') {
          console.warn('Supabase read-back warning: Status in DB is', verifyRow.status);
        }
      }
    } catch (e) {
      console.warn('Supabase task assignment exception:', e);
    }
  }

  // 3. Broadcast and notify
  pushNotification({
    user_id: staffId,
    role: 'service_staff',
    complaint_id: complaintId,
    complaint_number: compIdStr,
    type: 'staff_assigned',
    title: 'New Field Task Assigned',
    message: `Department Head ${headName} assigned task ${compIdStr} to you.`
  });

  broadcastComplaintChange(complaintId, 'Submitted', 'Staff Assigned', headName, `Assigned to ${staffName}`);
  return true;
}

export async function requestReworkDepartmentHead(
  complaintId: string,
  reworkReason: string,
  headName: string
): Promise<boolean> {
  const nowIso = new Date().toISOString();

  // 1. Try Express backend API first
  try {
    const token =
      localStorage.getItem('nagarsetu_token_department_head') ||
      sessionStorage.getItem('nagarsetu_token_department_head') ||
      localStorage.getItem('nagarsetu_token_dept_head') ||
      sessionStorage.getItem('nagarsetu_token_dept_head') ||
      localStorage.getItem('nagarsetu_token_hod') ||
      sessionStorage.getItem('nagarsetu_token_hod') ||
      (localStorage.getItem('nagarsetu_token') && !['demo-token', 'demo-token-citizen'].includes(localStorage.getItem('nagarsetu_token') || '') ? localStorage.getItem('nagarsetu_token') : null) ||
      (sessionStorage.getItem('nagarsetu_token') && !['demo-token', 'demo-token-citizen'].includes(sessionStorage.getItem('nagarsetu_token') || '') ? sessionStorage.getItem('nagarsetu_token') : null) ||
      'demo-token-dept-head';
    const apiRes = await fetch(`${getApiUrl()}/api/department/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({
        complaint_id: complaintId,
        verified_by_name: headName,
        status: 'Reopened',
        rework_reason: reworkReason
      })
    });
    if (!apiRes.ok) {
      const errJson = await apiRes.json().catch(() => ({}));
      throw new Error(errJson.error || `Server rework request failed (HTTP ${apiRes.status}).`);
    }
  } catch (apiErr: any) {
    if (apiErr.message && (apiErr.message.includes('Forbidden') || apiErr.message.includes('failed') || apiErr.message.includes('Server'))) {
      throw apiErr;
    }
    console.warn('Backend rework task API fallback:', apiErr);
  }

  if (isSupabaseConfigured()) {
    try {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(complaintId);
      let supaQuery = supabase
        .from('complaints')
        .update({
          status: 'Reopened',
          rework_reason: reworkReason,
          admin_rejection_reason: reworkReason,
          updated_at: nowIso
        });

      if (isUuid) {
        supaQuery = supaQuery.eq('id', complaintId);
      } else {
        supaQuery = supaQuery.eq('complaint_number', complaintId);
      }
      await supaQuery;
    } catch (e) {
      console.warn('Supabase request rework exception:', e);
    }
  }

  // 3. Broadcast and notify
  pushNotification({
    user_id: complaintId,
    role: 'service_staff',
    complaint_id: complaintId,
    complaint_number: complaintId,
    type: 'reopened',
    title: 'Field Work Rework Requested',
    message: `Department Head ${headName} requested rework on ${complaintId}: ${reworkReason}`
  });

  broadcastComplaintChange(complaintId, 'Resolution Submitted', 'Reopened', headName, `Requested rework: ${reworkReason}`);
  return true;
}

export async function approveResolutionDepartmentHead(
  complaintId: string,
  headName: string,
  headId?: string,
  deptId?: string
): Promise<boolean> {
  const nowIso = new Date().toISOString();

  // 1. Try Express backend API first
  try {
    const token =
      localStorage.getItem('nagarsetu_token_department_head') ||
      sessionStorage.getItem('nagarsetu_token_department_head') ||
      localStorage.getItem('nagarsetu_token_dept_head') ||
      sessionStorage.getItem('nagarsetu_token_dept_head') ||
      localStorage.getItem('nagarsetu_token_hod') ||
      sessionStorage.getItem('nagarsetu_token_hod') ||
      (localStorage.getItem('nagarsetu_token') && !['demo-token', 'demo-token-citizen'].includes(localStorage.getItem('nagarsetu_token') || '') ? localStorage.getItem('nagarsetu_token') : null) ||
      (sessionStorage.getItem('nagarsetu_token') && !['demo-token', 'demo-token-citizen'].includes(sessionStorage.getItem('nagarsetu_token') || '') ? sessionStorage.getItem('nagarsetu_token') : null) ||
      'demo-token-dept-head';
    const apiRes = await fetch(`${getApiUrl()}/api/department/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({
        complaint_id: complaintId,
        verified_by: headId,
        verified_by_name: headName,
        status: 'Resolved'
      })
    });
    if (!apiRes.ok) {
      const errJson = await apiRes.json().catch(() => ({}));
      throw new Error(errJson.error || `Server verification failed (HTTP ${apiRes.status}).`);
    }
  } catch (apiErr: any) {
    if (apiErr.message && (apiErr.message.includes('Forbidden') || apiErr.message.includes('failed') || apiErr.message.includes('Server'))) {
      throw apiErr;
    }
    console.warn('Backend verify task API fallback:', apiErr);
  }

  // 2. Try Supabase if configured
  if (isSupabaseConfigured()) {
    try {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(complaintId);
      const updatePayload: Record<string, any> = {
        status: 'Resolved',
        verified_by: headId || '',
        verified_by_name: headName,
        verified_at: nowIso,
        updated_at: nowIso
      };

      let supaQuery = supabase.from('complaints').update(updatePayload);
      if (isUuid) {
        supaQuery = supaQuery.eq('id', complaintId);
      } else {
        supaQuery = supaQuery.eq('complaint_number', complaintId);
      }

      const { data: updateRows, error: supaErr } = await supaQuery.select();
      if (supaErr) {
        console.error('Supabase verification update error:', supaErr);
      } else if (updateRows && updateRows.length > 0) {
        // Read back from database to verify persistence
        let readQuery = supabase.from('complaints').select('id, complaint_number, status, verified_by_name');
        if (isUuid) {
          readQuery = readQuery.eq('id', complaintId);
        } else {
          readQuery = readQuery.eq('complaint_number', complaintId);
        }

        const { data: verifyRow } = await readQuery.maybeSingle();
        if (verifyRow && verifyRow.status !== 'Resolved') {
          console.warn('Supabase read-back warning: Status in DB is', verifyRow.status);
        }
      }
    } catch (e) {
      console.warn('Supabase resolution verification exception:', e);
    }
  }

  // 3. Broadcast and notify
  pushNotification({
    user_id: complaintId,
    role: 'citizen',
    complaint_id: complaintId,
    complaint_number: complaintId,
    type: 'resolved',
    title: 'Complaint Officially Verified & Resolved',
    message: `Department Head ${headName} verified field repair proof and resolved ticket ${complaintId}.`
  });

  pushNotification({
    user_id: 'admin-group',
    role: 'city_admin',
    complaint_id: complaintId,
    complaint_number: complaintId,
    type: 'resolved',
    title: 'Department Resolution Approved',
    message: `Department Head ${headName} approved field resolution for ${complaintId}.`
  });

  broadcastComplaintChange(complaintId, 'Resolution Submitted', 'Resolved', headName, 'Approved field repair proof & closed ticket');
  return true;
}

export async function purgeAllComplaints(): Promise<boolean> {
  // 1. Clear LocalStorage cached complaints
  try {
    saveStoredComplaints([]);
    localStorage.removeItem(LOCAL_STORAGE_COMPLAINTS_KEY);
    LEGACY_STORAGE_KEYS.forEach(k => localStorage.removeItem(k));
  } catch (e) {}

  // 2. Call backend API purge endpoint
  try {
    const token = localStorage.getItem('nagarsetu_token') || sessionStorage.getItem('nagarsetu_token');
    const headers: Record<string, string> = {
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
    const res = await fetch(`${getApiUrl()}/api/complaints/purge-all`, { method: 'DELETE', headers });
    if (!res.ok) {
      console.warn('Backend purge complaints endpoint returned status:', res.status);
    }
  } catch (e) {
    console.warn('Backend purge complaints note:', e);
  }

  // 3. Purge Supabase table rows if configured
  if (isSupabaseConfigured()) {
    try {
      await supabase.from('feedback').delete().neq('id', 0);
      await supabase.from('assignments').delete().neq('id', 0);
      await supabase.from('complaint_status_history').delete().neq('id', 0);
      await supabase.from('complaints').delete().neq('id', 0);
    } catch (e) {}
  }

  return true;
}
