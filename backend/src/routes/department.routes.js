const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { query } = require('../config/db');
const { authenticateToken, requireRole, normalizeRole } = require('../middleware/auth');

// No-cache middleware for dynamic department data
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

/**
 * Canonical Department Mapping
 * Maps integer ID, code, UUID, and partial terms to authoritative department objects
 */
function getCanonicalDepartment(val) {
  if (!val) return null;
  const s = String(val).trim().toLowerCase();

  // 1. PWD
  if (
    s === '1' || s === 'pwd' || s === 'dept-pwd' || s === 'dept-1' ||
    s.includes('pwd') || s.includes('public works') || s.includes('road') || s.includes('pothole') || s.includes('8ed9f760')
  ) {
    return { id: 1, code: 'PWD', name: 'Public Works Department (PWD)', uuid: '8ed9f760-1314-427c-a515-c2a54d6df6d8' };
  }
  // 2. SAN
  if (
    s === '2' || s === 'san' || s === 'dept-san' || s === 'dept-2' ||
    s.includes('san') || s.includes('waste') || s.includes('garbage') || s.includes('clean') || s.includes('9cabc1f2')
  ) {
    return { id: 2, code: 'SAN', name: 'Sanitation & Waste Management', uuid: '9cabc1f2-fd10-48dd-a5cb-01d05197de22' };
  }
  // 3. WTR
  if (
    s === '3' || s === 'wtr' || s === 'dept-wtr' || s === 'dept-3' ||
    s.includes('wtr') || s.includes('water') || s.includes('pipeline') || s.includes('sewerage board') || s.includes('ead370cc')
  ) {
    return { id: 3, code: 'WTR', name: 'Water Supply & Sewerage Board', uuid: 'ead370cc-459c-44f0-899f-8a97f0928beb' };
  }
  // 4. DRN
  if (
    s === 'drn' || s === 'dept-drn' ||
    s.includes('drn') || s.includes('drain') || s.includes('sewage') || s.includes('sewer') || s.includes('gutter') || s.includes('ee73cb82')
  ) {
    return { id: 4, code: 'DRN', name: 'Drainage & Sewage Department', uuid: 'ee73cb82-cc47-4333-b7d6-4491353c1354' };
  }
  // 5. ELE
  if (
    s === 'ele' || s === 'dept-ele' ||
    s.includes('ele') || s.includes('electric') || s.includes('light') || s.includes('streetlight') || s.includes('31842723')
  ) {
    return { id: 5, code: 'ELE', name: 'Electrical & Street Lighting', uuid: '31842723-23ac-490b-912b-9f6d9afbdfb3' };
  }
  // 6. TRF
  if (
    s === 'trf' || s === 'tra' || s === 'dept-trf' || s === 'dept-tra' ||
    s.includes('trf') || s.includes('tra') || s.includes('traffic') || s.includes('signal') || s.includes('ae5e4d0c')
  ) {
    return { id: 6, code: 'TRF', name: 'Traffic Management Department', uuid: 'ae5e4d0c-996f-4d81-9528-d642664c93ae' };
  }
  // 7. MNT
  if (
    s === 'mnt' || s === 'dept-mnt' ||
    s.includes('mnt') || s.includes('maint') || s.includes('facility') || s.includes('park') || s.includes('71542723')
  ) {
    return { id: 7, code: 'MNT', name: 'Maintenance Department', uuid: '71542723-23ac-490b-912b-9f6d9afbdfb7' };
  }

  // Handle direct numeric IDs
  if (s === '4') return { id: 4, code: 'DRN', name: 'Drainage & Sewage Department', uuid: 'ee73cb82-cc47-4333-b7d6-4491353c1354' };
  if (s === '5') return { id: 5, code: 'ELE', name: 'Electrical & Street Lighting', uuid: '31842723-23ac-490b-912b-9f6d9afbdfb3' };
  if (s === '6') return { id: 6, code: 'TRF', name: 'Traffic Management Department', uuid: 'ae5e4d0c-996f-4d81-9528-d642664c93ae' };
  if (s === '7') return { id: 7, code: 'MNT', name: 'Maintenance Department', uuid: '71542723-23ac-490b-912b-9f6d9afbdfb7' };

  return null;
}

const DEPT_HEAD_EMAIL_MAP = {
  'rahul.kumar@nagarsetu.gov.in': 'PWD',
  'amit.sharma@nagarsetu.gov.in': 'SAN',
  'vikram.patil@nagarsetu.gov.in': 'WTR',
  'sanjay.more@nagarsetu.gov.in': 'DRN',
  'aditya.joshi@nagarsetu.gov.in': 'ELE',
  'kunal.kulkarni@nagarsetu.gov.in': 'MNT',
  'rohan.deshmukh@nagarsetu.gov.in': 'TRF'
};

function staffMatchesDept(staff, targetDept) {
  if (!targetDept) return true;
  if (!staff) return false;

  const staffDept =
    getCanonicalDepartment(staff.employee_id) ||
    getCanonicalDepartment(staff.department_code) ||
    getCanonicalDepartment(staff.department_name) ||
    getCanonicalDepartment(staff.department_id) ||
    getCanonicalDepartment(staff.department);

  if (staffDept && staffDept.code === targetDept.code) return true;
  if (String(staff.department_id) === String(targetDept.id)) return true;
  if (String(staff.department_id) === String(targetDept.uuid)) return true;
  return false;
}

/**
 * Helper: Authoritatively resolve canonical department for authenticated user from session/database
 */
async function resolveUserDepartment(req) {
  const userRole = normalizeRole(req.user.role);
  if (['admin', 'city_admin'].includes(userRole)) {
    return {
      userDeptId: null,
      userDeptName: 'City Administration',
      canonicalDept: null
    };
  }

  let rawDept = req.user.department_id || req.user.department_code || req.user.department_name;
  let canonical = getCanonicalDepartment(rawDept);

  const cleanEmail = (req.user.email || '').toLowerCase().trim();

  // If not resolved from token, check email map
  if (!canonical && cleanEmail) {
    if (DEPT_HEAD_EMAIL_MAP[cleanEmail]) {
      canonical = getCanonicalDepartment(DEPT_HEAD_EMAIL_MAP[cleanEmail]);
    } else if (cleanEmail.includes('pwd') || cleanEmail.includes('rahul')) {
      canonical = getCanonicalDepartment('PWD');
    } else if (cleanEmail.includes('san') || cleanEmail.includes('amit.sharma')) {
      canonical = getCanonicalDepartment('SAN');
    } else if (cleanEmail.includes('wtr') || cleanEmail.includes('vikram')) {
      canonical = getCanonicalDepartment('WTR');
    } else if (cleanEmail.includes('drn') || cleanEmail.includes('sanjay.more')) {
      canonical = getCanonicalDepartment('DRN');
    } else if (cleanEmail.includes('ele')) {
      canonical = getCanonicalDepartment('ELE');
    } else if (cleanEmail.includes('trf') || cleanEmail.includes('rohan')) {
      canonical = getCanonicalDepartment('TRF');
    } else if (cleanEmail.includes('mnt')) {
      canonical = getCanonicalDepartment('MNT');
    }
  }

  if (!canonical && req.user.id) {
    try {
      const uRes = await query('SELECT department_id, department_name, department_code FROM users WHERE id = ?', [req.user.id]);
      if (uRes.rows && uRes.rows[0]) {
        canonical = getCanonicalDepartment(uRes.rows[0].department_id || uRes.rows[0].department_code || uRes.rows[0].department_name);
      }
    } catch (e) {}
  }

  // If still not resolved, query database
  if (!canonical && req.user.id) {
    try {
      const dhRes = await query(
        `SELECT dh.department_id, d.name as department_name
         FROM department_heads dh 
         LEFT JOIN departments d ON d.id = dh.department_id 
         WHERE (dh.user_id = $1 OR LOWER(dh.email) = $2) AND dh.status = 'active'`,
        [req.user.id, cleanEmail]
      );
      if (dhRes.rows && dhRes.rows.length > 0) {
        canonical = getCanonicalDepartment(dhRes.rows[0].department_id || dhRes.rows[0].department_name);
      }
    } catch (e) {
      console.warn('DB resolve department note:', e);
    }
  }

  // Default fallback for department head if somehow still unresolved
  if (!canonical && req.user.role === 'department_head') {
    canonical = getCanonicalDepartment('PWD');
  }

  return {
    userDeptId: canonical ? canonical.id : null,
    userDeptName: canonical ? canonical.name : '',
    userDeptCode: canonical ? canonical.code : '',
    userDeptUuid: canonical ? canonical.uuid : '',
    canonicalDept: canonical
  };
}

// Public or authenticated list of municipal departments
router.get('/', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM departments ORDER BY id ASC`);
    return res.json({ departments: result.rows });
  } catch (err) {
    console.error('Fetch departments error:', err);
    return res.status(500).json({ error: 'Failed to fetch departments' });
  }
});

/**
 * GET /api/department/complaints
 * Fetch complaints strictly belonging to authenticated Department Head's department (or specified for Admin)
 */
router.get('/complaints', authenticateToken, async (req, res) => {
  try {
    const { canonicalDept } = await resolveUserDepartment(req);
    const userRole = (req.user.role || '').toLowerCase();
    const isAdmin = ['admin', 'city_admin', 'super_admin', 'municipal_admin'].includes(userRole);

    // SECURITY RULE: Department Head CANNOT override department filter with query params
    let filterDept = null;
    if (!isAdmin) {
      filterDept = canonicalDept;
    } else if (req.query.department_id || req.query.department || req.query.department_code) {
      filterDept = getCanonicalDepartment(req.query.department_id || req.query.department || req.query.department_code);
    }

    let sql = `
      SELECT c.*, d.name as department_name, f.rating, f.comment as feedback_comment,
             u.name as citizen_name, u.mobile as citizen_mobile
      FROM complaints c
      LEFT JOIN departments d ON c.department_id = d.id
      LEFT JOIN feedback f ON f.complaint_id = c.id
      LEFT JOIN users u ON c.citizen_id = u.id
      WHERE 1=1
    `;
    const params = [];

    if (filterDept) {
      sql += ` AND (c.department_id = $1 OR c.department_id = $2 OR d.code = $3 OR d.name LIKE $4)`;
      params.push(filterDept.id, filterDept.uuid, filterDept.code, `%${filterDept.name}%`);
    }

    sql += ` ORDER BY c.created_at DESC`;

    const result = await query(sql, params);
    let compRows = result.rows || [];

    if (filterDept) {
      compRows = compRows.filter(c => staffMatchesDept(c, filterDept));
    }

    // Enrich complaints with structured assigned_staff details
    const staffIds = Array.from(new Set(compRows.map(c => c.assigned_staff_id).filter(Boolean)));
    let staffMap = {};
    if (staffIds.length > 0) {
      try {
        const placeholders = staffIds.map((_, i) => `$${i + 1}`).join(',');
        const sRes = await query(
          `SELECT u.id, u.name, u.email, u.mobile, u.employee_id, u.status, u.department_id, d.name as department_name
           FROM users u
           LEFT JOIN departments d ON u.department_id = d.id
           WHERE u.id IN (${placeholders}) OR u.employee_id IN (${placeholders})`,
          staffIds
        );
        if (sRes.rows) {
          sRes.rows.forEach(s => {
            staffMap[String(s.id)] = s;
            if (s.employee_id) staffMap[String(s.employee_id)] = s;
            if (s.name) staffMap[s.name.toLowerCase()] = s;
          });
        }
      } catch (err) {}
    }

    compRows = compRows.map(c => {
      const s = c.assigned_staff_id ? (staffMap[String(c.assigned_staff_id)] || staffMap[String(c.assigned_staff_name || '').toLowerCase()]) : null;
      const staffName = c.assigned_staff_name || s?.name || null;
      const empId = s?.employee_id || (c.assigned_staff_id ? (String(c.assigned_staff_id).startsWith('STF-') || String(c.assigned_staff_id).includes('-') ? c.assigned_staff_id : `STF-${c.assigned_staff_id}`) : null);
      const staffDept = s?.department_name || c.department_name || (filterDept ? filterDept.name : 'Public Works Department (PWD)');

      const assignedStaffObj = staffName ? {
        id: c.assigned_staff_id || s?.id,
        name: staffName,
        employee_id: empId,
        department: staffDept,
        mobile: s?.mobile || c.assigned_staff_mobile || null,
        status: c.status || 'Staff Assigned',
        assigned_at: c.assigned_at || c.updated_at
      } : null;

      return {
        ...c,
        assigned_staff: assignedStaffObj
      };
    });

    return res.json({ complaints: compRows });
  } catch (err) {
    console.error('Fetch department complaints error:', err);
    return res.status(500).json({ error: 'Failed to fetch department complaints', complaints: [] });
  }
});

/**
 * GET /api/department/staff
 * Fetch service staff.
 * SECURITY REQUIREMENT:
 * - Department Head sees ONLY field staff belonging to their department.
 * - Department Head CANNOT bypass filter by changing query parameters.
 * - City Admin sees ALL field staff (or can filter by query parameter).
 */
router.get('/staff', authenticateToken, requireRole(['department_head', 'admin', 'city_admin']), async (req, res) => {
  try {
    const { canonicalDept } = await resolveUserDepartment(req);
    const userRole = (req.user.role || '').toLowerCase();
    const isAdmin = ['admin', 'city_admin', 'super_admin', 'municipal_admin'].includes(userRole);
    const filterStatus = (req.query.status || 'all').toLowerCase();
    const searchQuery = (req.query.search || '').toLowerCase().trim();

    // SECURITY ENFORCEMENT:
    // Department Head: strictly locked to server-side authenticated department.
    // Query params (?department_id=, ?department=, ?department_code=) are strictly IGNORED for Dept Heads.
    // City Admin: can see all staff, or optionally filter by query params.
    let filterDept = null;
    if (!isAdmin) {
      filterDept = canonicalDept;
    } else if (req.query.department_id || req.query.department || req.query.department_code) {
      filterDept = getCanonicalDepartment(req.query.department_id || req.query.department || req.query.department_code);
    }

    let sql = `
      SELECT u.id, u.name, u.email, u.mobile, u.employee_id, u.role, u.department_id,
             COALESCE(u.designation, 'Field Service Staff') as designation,
             COALESCE(u.status, 'active') as status,
             u.language_pref, u.created_at,
             d.name as department_name,
             (
               SELECT COUNT(DISTINCT c.id)
               FROM complaints c
               WHERE (c.assigned_staff_id = CAST(u.id AS TEXT) OR LOWER(c.assigned_staff_email) = LOWER(u.email) OR c.assigned_staff_name = u.name)
                 AND c.status IN ('Assigned', 'Staff Assigned', 'Department Assigned', 'In Progress', 'Accepted', 'On the Way', 'Resolution Submitted', 'Verified')
             ) as active_tasks,
             (
               SELECT COUNT(DISTINCT c.id)
               FROM complaints c
               WHERE (c.assigned_staff_id = CAST(u.id AS TEXT) OR LOWER(c.assigned_staff_email) = LOWER(u.email) OR c.assigned_staff_name = u.name)
                 AND c.status = 'Resolved'
             ) as completed_tasks,
             (
               SELECT COUNT(DISTINCT c.id)
               FROM complaints c
               WHERE (c.assigned_staff_id = CAST(u.id AS TEXT) OR LOWER(c.assigned_staff_email) = LOWER(u.email) OR c.assigned_staff_name = u.name)
                 AND (c.status = 'Overdue' OR (c.status NOT IN ('Resolved', 'Rejected') AND c.sla_deadline IS NOT NULL AND c.sla_deadline < CURRENT_TIMESTAMP))
             ) as overdue_tasks
      FROM users u
      LEFT JOIN departments d ON u.department_id = d.id
      WHERE (u.role = 'service_staff' OR u.role = 'staff')
    `;

    const params = [];

    if (filterDept) {
      sql += ` AND (u.department_id = $1 OR u.department_id = $2 OR UPPER(COALESCE(u.employee_id, '')) LIKE $3)`;
      params.push(filterDept.id, filterDept.uuid, `${filterDept.code}%`);
    }

    if (filterStatus === 'active') {
      sql += ` AND LOWER(u.status) = 'active'`;
    } else if (filterStatus === 'inactive') {
      sql += ` AND LOWER(u.status) = 'inactive'`;
    } else if (filterStatus !== 'all') {
      sql += ` AND LOWER(u.status) != 'archived'`;
    }

    if (searchQuery) {
      const idx = params.length + 1;
      sql += ` AND (LOWER(u.name) LIKE $${idx} OR LOWER(u.email) LIKE $${idx} OR LOWER(u.mobile) LIKE $${idx} OR LOWER(COALESCE(u.employee_id, '')) LIKE $${idx})`;
      params.push(`%${searchQuery}%`);
    }

    sql += ` ORDER BY u.created_at DESC`;

    const result = await query(sql, params);
    let staffRows = result.rows || [];

    // CRITICAL: Guarantee server-side department isolation even if query engine returned unfiltered rows (e.g. SQLite runMemQuery)
    if (filterDept) {
      staffRows = staffRows.filter(s => staffMatchesDept(s, filterDept));
    }

    // Supabase fallback if local DB returned 0 rows
    if (staffRows.length === 0) {
      try {
        const { getSupabaseClient } = require('../middleware/auth');
        const sb = getSupabaseClient();
        if (sb) {
          const { data: sbProfiles } = await sb.from('profiles').select('*').eq('role', 'service_staff');
          if (sbProfiles && sbProfiles.length > 0) {
            staffRows = sbProfiles.map((p) => {
              const pDept = getCanonicalDepartment(p.department_id) || getCanonicalDepartment(p.employee_id) || getCanonicalDepartment(p.department_name);
              return {
                id: p.id,
                name: p.full_name || p.name || 'Staff Member',
                email: p.email || '',
                mobile: p.mobile || '',
                employee_id: p.employee_id || `STF-${String(p.id).slice(0, 4).toUpperCase()}`,
                designation: 'Field Service Staff',
                department_id: pDept ? pDept.id : null,
                department_name: pDept ? pDept.name : 'Municipal Department',
                status: p.status || 'active',
                language_pref: p.language_pref || 'en',
                created_at: p.created_at,
                active_tasks: 0,
                completed_tasks: 0,
                overdue_tasks: 0
              };
            });

            if (filterDept) {
              staffRows = staffRows.filter(s => staffMatchesDept(s, filterDept));
            }
          }
        }
      } catch (sbErr) {
        console.warn('Supabase fallback staff query note:', sbErr);
      }
    }

    // MemStore fallback (from db.js seed) if still 0 rows
    if (staffRows.length === 0) {
      try {
        const { getMemStore } = require('../config/db');
        const memStore = getMemStore ? getMemStore() : null;
        if (memStore && Array.isArray(memStore.users)) {
          const seedStaff = memStore.users.filter(u => u.role === 'service_staff' || u.role === 'staff');
          staffRows = filterDept ? seedStaff.filter(s => staffMatchesDept(s, filterDept)) : seedStaff;
        }
      } catch (e) {}
    }

    // Apply status and search filters on final in-memory rows if needed
    if (filterStatus === 'active') {
      staffRows = staffRows.filter(s => (s.status || '').toLowerCase() === 'active');
    } else if (filterStatus === 'inactive') {
      staffRows = staffRows.filter(s => (s.status || '').toLowerCase() === 'inactive');
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      staffRows = staffRows.filter(s =>
        (s.name || '').toLowerCase().includes(q) ||
        (s.email || '').toLowerCase().includes(q) ||
        (s.mobile || '').toLowerCase().includes(q) ||
        (s.employee_id || '').toLowerCase().includes(q)
      );
    }

    const staffList = staffRows.map((row) => {
      const sDept = getCanonicalDepartment(row.department_id) || getCanonicalDepartment(row.employee_id) || getCanonicalDepartment(row.department_name);
      return {
        id: String(row.id),
        name: row.name,
        email: row.email || '',
        mobile: row.mobile || '',
        contact_number: row.mobile || '',
        employee_id: row.employee_id || `STF-${String(row.id).padStart(3, '0')}`,
        designation: row.designation || 'Field Service Staff',
        department_id: sDept ? String(sDept.id) : (row.department_id ? String(row.department_id) : null),
        department_name: sDept ? sDept.name : (row.department_name || (canonicalDept ? canonicalDept.name : 'Municipal Department')),
        status: (row.status || 'active').toLowerCase() === 'active' ? 'Active' : (row.status || 'inactive').toLowerCase() === 'inactive' ? 'Inactive' : 'Archived',
        active_tasks: parseInt(row.active_tasks || 0, 10),
        completed_tasks: parseInt(row.completed_tasks || 0, 10),
        overdue_tasks: parseInt(row.overdue_tasks || 0, 10),
        language: row.language_pref || 'en',
        joined_date: row.created_at,
        created_at: row.created_at
      };
    });

    // Summary reflects ONLY the returned staff records for strict isolation
    const summary = {
      totalStaff: staffList.length,
      activeStaff: staffList.filter((s) => s.status === 'Active').length,
      inactiveStaff: staffList.filter((s) => s.status === 'Inactive').length,
      activeTasks: staffList.reduce((acc, s) => acc + (s.active_tasks || 0), 0)
    };

    return res.json({ staff: staffList, summary });
  } catch (err) {
    console.error('Fetch department staff error:', err);
    return res.status(500).json({ error: 'Failed to fetch department staff', staff: [], summary: { totalStaff: 0, activeStaff: 0, inactiveStaff: 0, activeTasks: 0 } });
  }
});

/**
 * GET /api/department/staff/assignable
 * Fetch ONLY ACTIVE staff members for complaint task assignment dropdowns
 * Department Head sees ONLY active staff from their own department.
 */
router.get('/staff/assignable', authenticateToken, requireRole(['department_head', 'admin', 'city_admin', 'officer']), async (req, res) => {
  try {
    const { canonicalDept } = await resolveUserDepartment(req);
    const userRole = (req.user.role || '').toLowerCase();
    const isAdmin = ['admin', 'city_admin'].includes(userRole);

    let filterDept = !isAdmin ? canonicalDept : (req.query.department_id ? getCanonicalDepartment(req.query.department_id) : null);

    let sql = `
      SELECT id, name, mobile, email, employee_id, department_id, designation
      FROM users
      WHERE (role = 'service_staff' OR role = 'staff')
        AND LOWER(status) = 'active'
    `;
    const params = [];

    if (filterDept) {
      sql += ` AND (department_id = $1 OR department_id = $2 OR UPPER(COALESCE(employee_id, '')) LIKE $3)`;
      params.push(filterDept.id, filterDept.uuid, `${filterDept.code}%`);
    }

    sql += ` ORDER BY name ASC`;

    const result = await query(sql, params);
    let rows = result.rows || [];

    if (filterDept) {
      rows = rows.filter(s => staffMatchesDept(s, filterDept));
    }

    if (rows.length === 0) {
      try {
        const { getMemStore } = require('../config/db');
        const memStore = getMemStore ? getMemStore() : null;
        if (memStore && Array.isArray(memStore.users)) {
          const seedStaff = memStore.users.filter(u => (u.role === 'service_staff' || u.role === 'staff') && (u.status || 'active').toLowerCase() === 'active');
          rows = filterDept ? seedStaff.filter(s => staffMatchesDept(s, filterDept)) : seedStaff;
        }
      } catch (e) {}
    }

    return res.json({ staff: rows });
  } catch (err) {
    console.error('Fetch assignable staff error:', err);
    return res.status(500).json({ error: 'Failed to fetch assignable staff' });
  }
});

/**
 * POST /api/department/staff
 * Create a new Service Staff member (Department Head locked to own department)
 */
router.post('/staff', authenticateToken, requireRole(['department_head', 'admin', 'city_admin']), async (req, res) => {
  try {
    const { name, email, mobile, password, employee_id, designation, language } = req.body;

    if (!name || !mobile || !password) {
      return res.status(400).json({ error: 'Name, mobile number, and password are required.' });
    }

    const { userDeptId, userDeptName } = await resolveUserDepartment(req);
    const userRole = req.user.role || 'citizen';
    const isAdmin = ['admin', 'city_admin'].includes(userRole);

    // SECURITY RULE: Department Head is strictly locked to their own department
    let targetDeptId = userDeptId;
    if (isAdmin && req.body.department_id) {
      targetDeptId = req.body.department_id;
    }

    if (!targetDeptId) {
      return res.status(400).json({ error: 'Department assignment could not be resolved.' });
    }

    // Check existing email or mobile
    const checkSql = `SELECT id FROM users WHERE mobile = $1 OR (email IS NOT NULL AND email = $2)`;
    const existing = await query(checkSql, [mobile, email || '']);
    if (existing.rows && existing.rows.length > 0) {
      return res.status(400).json({ error: 'A staff member or user with this mobile number or email already exists.' });
    }

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);
    const empId = employee_id || `STF-${Date.now().toString().slice(-4)}`;
    const desig = designation || 'Field Service Staff';
    const lang = language || 'en';

    const insertSql = `
      INSERT INTO users (name, mobile, email, password_hash, role, department_id, employee_id, designation, status, language_pref)
      VALUES ($1, $2, $3, $4, 'service_staff', $5, $6, $7, 'active', $8)
      RETURNING *
    `;

    const result = await query(insertSql, [name, mobile, email || null, password_hash, targetDeptId, empId, desig, lang]);
    const created = result.rows[0];

    return res.status(201).json({
      success: true,
      message: 'Staff member created successfully',
      staff: {
        id: String(created.id),
        name: created.name,
        email: created.email || '',
        mobile: created.mobile,
        employee_id: created.employee_id,
        designation: created.designation,
        department_id: String(created.department_id),
        department_name: userDeptName,
        status: 'Active',
        active_tasks: 0,
        completed_tasks: 0,
        overdue_tasks: 0,
        language: created.language_pref,
        created_at: created.created_at
      }
    });
  } catch (err) {
    console.error('Error creating staff:', err);
    return res.status(500).json({ error: 'Failed to create staff member' });
  }
});

/**
 * PUT /api/department/staff/:id
 * Update staff profile information
 */
router.put('/staff/:id', authenticateToken, requireRole(['department_head', 'admin', 'city_admin']), async (req, res) => {
  try {
    const staffId = req.params.id;
    const { name, mobile, designation, language, employee_id } = req.body;

    const { userDeptId, canonicalDept } = await resolveUserDepartment(req);
    const isAdmin = ['admin', 'city_admin'].includes(req.user.role);

    // SECURITY CHECK: Ensure staff member belongs to Department Head's department
    if (!isAdmin) {
      const verifyRes = await query('SELECT * FROM users WHERE id = $1', [staffId]);
      if (verifyRes.rows.length === 0) {
        return res.status(404).json({ error: 'Staff member not found' });
      }
      if (canonicalDept && !staffMatchesDept(verifyRes.rows[0], canonicalDept)) {
        return res.status(403).json({ error: 'Forbidden: You can only edit staff members in your department' });
      }
    }

    await query(
      `UPDATE users
       SET name = COALESCE($1, name),
           mobile = COALESCE($2, mobile),
           designation = COALESCE($3, designation),
           language_pref = COALESCE($4, language_pref),
           employee_id = COALESCE($5, employee_id)
       WHERE id = $6 AND (role = 'service_staff' OR role = 'staff')`,
      [name, mobile, designation, language, employee_id, staffId]
    );

    return res.json({ success: true, message: 'Staff profile updated successfully' });
  } catch (err) {
    console.error('Error updating staff:', err);
    return res.status(500).json({ error: 'Failed to update staff member' });
  }
});

/**
 * POST /api/department/staff/:id/deactivate
 * Deactivate staff member (status -> 'inactive')
 */
router.post('/staff/:id/deactivate', authenticateToken, requireRole(['department_head', 'admin', 'city_admin']), async (req, res) => {
  try {
    const staffId = req.params.id;
    const { userDeptId, canonicalDept } = await resolveUserDepartment(req);
    const isAdmin = ['admin', 'city_admin'].includes(req.user.role);

    if (!isAdmin) {
      const verifyRes = await query('SELECT * FROM users WHERE id = $1', [staffId]);
      if (verifyRes.rows.length === 0) {
        return res.status(404).json({ error: 'Staff member not found' });
      }
      if (canonicalDept && !staffMatchesDept(verifyRes.rows[0], canonicalDept)) {
        return res.status(403).json({ error: 'Forbidden: You can only deactivate staff members in your department' });
      }
    }

    await query("UPDATE users SET status = 'inactive' WHERE id = $1", [staffId]);

    return res.json({ success: true, message: 'Staff member deactivated successfully' });
  } catch (err) {
    console.error('Error deactivating staff:', err);
    return res.status(500).json({ error: 'Failed to deactivate staff member' });
  }
});

/**
 * POST /api/department/staff/:id/activate
 * Activate staff member (status -> 'active')
 */
router.post('/staff/:id/activate', authenticateToken, requireRole(['department_head', 'admin', 'city_admin']), async (req, res) => {
  try {
    const staffId = req.params.id;
    const { userDeptId, canonicalDept } = await resolveUserDepartment(req);
    const isAdmin = ['admin', 'city_admin'].includes(req.user.role);

    if (!isAdmin) {
      const verifyRes = await query('SELECT * FROM users WHERE id = $1', [staffId]);
      if (verifyRes.rows.length === 0) {
        return res.status(404).json({ error: 'Staff member not found' });
      }
      if (canonicalDept && !staffMatchesDept(verifyRes.rows[0], canonicalDept)) {
        return res.status(403).json({ error: 'Forbidden: You can only activate staff members in your department' });
      }
    }

    await query("UPDATE users SET status = 'active' WHERE id = $1", [staffId]);

    return res.json({ success: true, message: 'Staff member activated successfully' });
  } catch (err) {
    console.error('Error activating staff:', err);
    return res.status(500).json({ error: 'Failed to activate staff member' });
  }
});

/**
 * DELETE /api/department/staff/:id
 * Soft delete / Archive staff member (status -> 'archived'), preserving all historical data
 */
router.delete('/staff/:id', authenticateToken, requireRole(['department_head', 'admin', 'city_admin']), async (req, res) => {
  try {
    const staffId = req.params.id;
    const { userDeptId, canonicalDept } = await resolveUserDepartment(req);
    const isAdmin = ['admin', 'city_admin'].includes(req.user.role);

    if (!isAdmin) {
      const verifyRes = await query('SELECT * FROM users WHERE id = $1', [staffId]);
      if (verifyRes.rows.length === 0) {
        return res.status(404).json({ error: 'Staff member not found' });
      }
      if (canonicalDept && !staffMatchesDept(verifyRes.rows[0], canonicalDept)) {
        return res.status(403).json({ error: 'Forbidden: You can only remove staff members in your department' });
      }
    }

    // Soft delete -> Set status = 'archived'
    await query("UPDATE users SET status = 'archived' WHERE id = $1", [staffId]);

    return res.json({ success: true, message: 'Staff member removed successfully (Historical records preserved)' });
  } catch (err) {
    console.error('Error removing staff:', err);
    return res.status(500).json({ error: 'Failed to remove staff member' });
  }
});

/**
 * POST /api/department/assign
 * Assign complaint to active service staff member with department isolation authorization
 */
router.post('/assign', authenticateToken, requireRole(['department_head', 'admin', 'city_admin', 'officer']), async (req, res) => {
  try {
    const { complaint_id, staff_id } = req.body;
    if (!complaint_id || !staff_id) {
      return res.status(400).json({ error: 'Complaint ID and Staff ID are required.' });
    }

    const { userDeptId, canonicalDept } = await resolveUserDepartment(req);
    const userRole = normalizeRole(req.user.role || 'citizen');
    const isAdmin = ['admin', 'city_admin'].includes(userRole);

    // 1. Fetch Complaint by ID or Complaint Number
    const compRes = await query(`SELECT * FROM complaints WHERE id = $1 OR complaint_number = $1`, [complaint_id]);
    if (!compRes.rows || compRes.rows.length === 0) {
      return res.status(404).json({ error: 'Complaint record not found.' });
    }
    const complaint = compRes.rows[0];

    // 2. Fetch Selected Staff Member by ID, Employee ID or Email
    const staffRes = await query(`SELECT id, name, email, mobile, department_id, employee_id, status FROM users WHERE (id = $1 OR employee_id = $1 OR email = $1) AND (role = 'service_staff' OR role = 'staff')`, [staff_id]);
    let staff = (staffRes.rows && staffRes.rows.length > 0) ? staffRes.rows[0] : null;

    if (!staff) {
      try {
        const { getMemStore } = require('../config/db');
        const memStore = getMemStore ? getMemStore() : null;
        if (memStore && Array.isArray(memStore.users)) {
          staff = memStore.users.find(u =>
            (String(u.id) === String(staff_id) || u.employee_id === String(staff_id) || (u.email && u.email.toLowerCase() === String(staff_id).toLowerCase())) &&
            (u.role === 'service_staff' || u.role === 'staff')
          ) || null;
        }
      } catch (e) {}
    }

    if (!staff) {
      return res.status(404).json({ error: 'Selected service staff member not found.' });
    }

    // 3. Status Check: Staff must be active
    if ((staff.status || 'active').toLowerCase() !== 'active') {
      return res.status(400).json({ error: `Cannot assign task: Staff member '${staff.name}' is currently inactive.` });
    }

    // 4. Department Isolation Security Check
    if (!isAdmin) {
      if (canonicalDept && !staffMatchesDept(complaint, canonicalDept)) {
        return res.status(403).json({ error: 'Forbidden: You cannot assign complaints outside your department.' });
      }
      if (canonicalDept && !staffMatchesDept(staff, canonicalDept)) {
        return res.status(403).json({ error: 'Forbidden: You cannot assign staff members belonging to another department.' });
      }
    } else {
      const complaintDept = getCanonicalDepartment(complaint.department_id || complaint.department);
      if (complaintDept && !staffMatchesDept(staff, complaintDept)) {
        return res.status(400).json({ error: 'Invalid assignment: Selected staff member does not belong to the complaint department.' });
      }
    }

    // 5. Update Complaint in Database with affected row verification
    const updateRes = await query(
      `UPDATE complaints
       SET assigned_staff_id = $1,
           assigned_staff_name = $2,
           assigned_staff_email = $3,
           assigned_by = $4,
           assigned_by_name = $5,
           status = 'Staff Assigned',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $6 OR complaint_number = $6`,
      [staff.id, staff.name, staff.email || '', req.user.id, req.user.name || 'Department Head', complaint.id]
    );

    if (updateRes && updateRes.rowCount !== undefined && updateRes.rowCount === 0) {
      return res.status(500).json({ error: 'Assignment failed: Database UPDATE affected 0 rows.' });
    }

    // 6. Database Read-back Verification
    const verifyRes = await query(
      `SELECT id, complaint_number, assigned_staff_id, assigned_staff_name, assigned_staff_email, status, updated_at FROM complaints WHERE id = $1`,
      [complaint.id]
    );

    if (!verifyRes.rows || verifyRes.rows.length === 0 || verifyRes.rows[0].status !== 'Staff Assigned') {
      return res.status(500).json({ error: 'Assignment failed: Database read-back verification failed.' });
    }

    const verifiedRecord = verifyRes.rows[0];

    // 7. Record Assignment History (into assignments & task_assignments tables)
    await query(
      `INSERT INTO assignments (complaint_id, staff_id, assigned_by, assigned_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
      [complaint.id, staff.id, req.user.id]
    ).catch(() => {});

    await query(
      `INSERT INTO task_assignments (complaint_id, staff_id, assigned_by, created_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
      [complaint.id, staff.id, req.user.id]
    ).catch(() => {});

    // 8. Record Status History
    await query(
      `INSERT INTO complaint_status_history (complaint_id, status, remark, department, updated_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [complaint.id, 'Staff Assigned', `Task assigned to field staff ${staff.name}.`, 'Department Operations', req.user.name || 'Department Head']
    ).catch(() => {});

    return res.json({
      success: true,
      message: `Task successfully assigned to ${staff.name}`,
      complaint_id: verifiedRecord.id,
      complaint_number: verifiedRecord.complaint_number,
      staff_id: staff.id,
      staff_name: staff.name,
      staff_email: staff.email,
      status: verifiedRecord.status,
      updated_at: verifiedRecord.updated_at
    });
  } catch (err) {
    console.error('Error assigning staff in department route:', err);
    return res.status(500).json({ error: 'Server error assigning staff to task.' });
  }
});

/**
 * POST /api/department/verify
 * Department Head verifies & approves completion -> status = 'Resolved'
 */
router.post('/verify', authenticateToken, requireRole(['department_head', 'admin', 'city_admin', 'overseer']), async (req, res) => {
  try {
    const { complaint_id, verified_by, verified_by_name, status } = req.body;
    const targetStatus = status || 'Resolved';

    if (!complaint_id) {
      return res.status(400).json({ error: 'Complaint ID is required' });
    }

    const userRole = normalizeRole(req.user?.role);
    const isAdmin = ['admin', 'city_admin'].includes(userRole);
    const isDeptHead = userRole === 'department_head';

    // 1. Fetch target complaint
    const compRes = await query(
      `SELECT * FROM complaints 
       WHERE CAST(id AS TEXT) = $1 OR complaint_number = $1`,
      [complaint_id]
    );

    if (!compRes.rows || compRes.rows.length === 0) {
      return res.status(404).json({ error: 'Complaint not found' });
    }

    const complaint = compRes.rows[0];

    // 2. Department Head Isolation & Status Validation
    let userDept = null;
    if (isDeptHead) {
      const { canonicalDept } = await resolveUserDepartment(req);
      userDept =
        canonicalDept ||
        getCanonicalDepartment(req.user.department_id) ||
        getCanonicalDepartment(req.user.department_code) ||
        getCanonicalDepartment(req.user.department_name) ||
        getCanonicalDepartment(req.user.department) ||
        getCanonicalDepartment(req.user.email);

      if (!userDept && req.user.department_id) {
        try {
          const dRes = await query(
            `SELECT id, name, code FROM departments WHERE CAST(id AS TEXT) = $1`,
            [String(req.user.department_id)]
          );
          if (dRes.rows && dRes.rows[0]) {
            userDept = getCanonicalDepartment(dRes.rows[0].code || dRes.rows[0].name || dRes.rows[0].id);
          }
        } catch (dErr) {}
      }

      let complaintDept =
        getCanonicalDepartment(complaint.department_id) ||
        getCanonicalDepartment(complaint.department_code) ||
        getCanonicalDepartment(complaint.department_name) ||
        getCanonicalDepartment(complaint.department) ||
        getCanonicalDepartment(complaint.category);

      if (!complaintDept && complaint.department_id) {
        try {
          const dRes = await query(
            `SELECT id, name, code FROM departments WHERE CAST(id AS TEXT) = $1`,
            [String(complaint.department_id)]
          );
          if (dRes.rows && dRes.rows[0]) {
            complaintDept = getCanonicalDepartment(dRes.rows[0].code || dRes.rows[0].name || dRes.rows[0].id);
          }
        } catch (dErr) {}
      }

      if (!userDept || !complaintDept || userDept.code !== complaintDept.code) {
        return res.status(403).json({
          error: 'Forbidden: You cannot verify complaints outside your department.',
          userDepartment: userDept?.code || null,
          complaintDepartment: complaintDept?.code || null
        });
      }

      // Reviewable state check (Resolution Submitted, Pending Review, etc.)
      const reviewableStates = [
        'resolution submitted',
        'pending review',
        'under review',
        'pending verification',
        'in progress',
        'staff assigned'
      ];
      const curStatus = String(complaint.status || '').toLowerCase().trim();
      if (!reviewableStates.includes(curStatus) && curStatus !== targetStatus.toLowerCase()) {
        return res.status(400).json({
          error: `Complaint status "${complaint.status}" cannot be verified. Must be in a reviewable state (Resolution Submitted, Pending Review).`
        });
      }
    } else if (!isAdmin && userRole !== 'overseer') {
      return res.status(403).json({ error: 'Forbidden: Access denied for user role' });
    }

    // 3. Update complaint to targetStatus (Resolved)
    try {
      await query(
        `UPDATE complaints 
         SET status = $1, 
             verified_by = $2, 
             verified_at = CURRENT_TIMESTAMP, 
             resolved_at = CURRENT_TIMESTAMP, 
             updated_at = CURRENT_TIMESTAMP 
         WHERE CAST(id AS TEXT) = $3 OR complaint_number = $3`,
        [targetStatus, req.user.id || verified_by || 1, complaint_id]
      );
    } catch (colErr1) {
      try {
        await query(
          `UPDATE complaints 
           SET status = $1, 
               verified_by = $2, 
               verified_at = CURRENT_TIMESTAMP, 
               updated_at = CURRENT_TIMESTAMP 
           WHERE CAST(id AS TEXT) = $3 OR complaint_number = $3`,
          [targetStatus, req.user.id || verified_by || 1, complaint_id]
        );
      } catch (colErr2) {
        await query(
          `UPDATE complaints 
           SET status = $1, 
               updated_at = CURRENT_TIMESTAMP 
           WHERE CAST(id AS TEXT) = $2 OR complaint_number = $2`,
          [targetStatus, complaint_id]
        );
      }
    }

    try {
      await query(
        `UPDATE complaint_assignments 
         SET status = 'completed', completed_at = CURRENT_TIMESTAMP 
         WHERE CAST(complaint_id AS TEXT) = $1 OR complaint_id = (SELECT id FROM complaints WHERE complaint_number = $1 LIMIT 1)`,
        [complaint_id]
      );
    } catch (assignErr) {}

    const verifyRes = await query(
      `SELECT id, complaint_number, status, updated_at FROM complaints WHERE CAST(id AS TEXT) = $1 OR complaint_number = $1`,
      [complaint_id]
    );

    if (!verifyRes.rows || verifyRes.rows.length === 0 || verifyRes.rows[0].status !== targetStatus) {
      return res.status(500).json({ error: 'Verification failed: Database read-back failed' });
    }

    try {
      await query(
        `INSERT INTO complaint_status_history (complaint_id, status, remark, department, updated_by) VALUES ($1, $2, $3, $4, $5)`,
        [complaint.id || complaint_id, targetStatus, `Department Head verified repair proof and approved resolution.`, userDept?.name || 'Department Operations', req.user.name || 'Department Head']
      );
    } catch (histErr) {}

    return res.status(200).json({
      success: true,
      message: `Complaint verified and approved as ${targetStatus}`,
      status: targetStatus,
      complaint: verifyRes.rows[0]
    });
  } catch (err) {
    console.error('Verify complaint error:', err);
    return res.status(500).json({ error: 'Failed to verify complaint' });
  }
});

module.exports = router;
