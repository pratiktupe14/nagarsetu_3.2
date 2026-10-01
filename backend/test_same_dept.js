const { query } = require('./src/config/db');

async function runTests() {
  // 1. Fetch complaints
  const compRes = await query(`SELECT * FROM complaints LIMIT 10`);
  if (!compRes.rows || compRes.rows.length === 0) {
    console.error('No complaints found');
    process.exit(1);
  }

  // Find or set a PWD complaint
  let pwdComp = compRes.rows.find(c => {
    const s = String(c.department_id || c.category || '').toLowerCase();
    return s.includes('pwd') || s.includes('road') || s.includes('pothole') || s === '1' || s.includes('8ed9f760');
  });

  if (!pwdComp) {
    pwdComp = compRes.rows[0];
    await query(`UPDATE complaints SET department_id = '8ed9f760-1314-427c-a515-c2a54d6df6d8' WHERE id = ?`, [pwdComp.id]);
  }

  // Ensure status is reviewable: 'Resolution Submitted'
  await query(`UPDATE complaints SET status = 'Resolution Submitted' WHERE id = ?`, [pwdComp.id]);

  console.log(`[TEST 1: Same-Dept PWD HOD -> PWD Complaint ID: ${pwdComp.id}, dept_id: ${pwdComp.department_id}]`);

  const sameDeptRes = await fetch('http://localhost:5000/api/department/verify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer demo-token-dept-head'
    },
    body: JSON.stringify({
      complaint_id: pwdComp.id,
      status: 'Resolved'
    })
  });

  const sameDeptData = await sameDeptRes.json();
  console.log(`TEST 1 Status: ${sameDeptRes.status}`);
  console.log('TEST 1 Response:', JSON.stringify(sameDeptData));

  // Find or set a cross-department complaint (e.g. Water department = 3 or ead370cc)
  let wtrComp = compRes.rows.find(c => c.id !== pwdComp.id);
  if (!wtrComp) {
    console.error('Need at least 2 complaints');
    process.exit(1);
  }

  await query(`UPDATE complaints SET department_id = 'ead370cc-459c-44f0-899f-8a97f0928beb', category = 'Water Supply' WHERE id = ?`, [wtrComp.id]);
  await query(`UPDATE complaints SET status = 'Resolution Submitted' WHERE id = ?`, [wtrComp.id]);

  console.log(`\n[TEST 2: Cross-Dept PWD HOD -> Water Complaint ID: ${wtrComp.id}, dept_id: ead370cc...]`);

  const crossDeptRes = await fetch('http://localhost:5000/api/department/verify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer demo-token-dept-head'
    },
    body: JSON.stringify({
      complaint_id: wtrComp.id,
      status: 'Resolved'
    })
  });

  const crossDeptData = await crossDeptRes.json();
  console.log(`TEST 2 Status: ${crossDeptRes.status}`);
  console.log('TEST 2 Response:', JSON.stringify(crossDeptData));

  const test1Pass = sameDeptRes.status === 200 && sameDeptData.status === 'Resolved';
  const test2Pass = crossDeptRes.status === 403;

  console.log(`\nRESULTS: TEST 1 Pass = ${test1Pass}, TEST 2 Pass = ${test2Pass}`);
  process.exit(test1Pass && test2Pass ? 0 : 1);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
