const state = {
  token: localStorage.getItem('cw_token') || '',
  account: null,
  role: null,
};

const merchantScanner = {
  active: false,
  frame: 0,
  stream: null,
};

const viewNames = [
  'view-home',
  'view-student-auth',
  'view-student',
  'view-merchant-auth',
  'view-merchant',
  'view-admin',
];

const els = {
  flash: document.getElementById('flash'),
  home: document.getElementById('view-home'),
  studentAuth: document.getElementById('view-student-auth'),
  student: document.getElementById('view-student'),
  merchantAuth: document.getElementById('view-merchant-auth'),
  merchant: document.getElementById('view-merchant'),
  admin: document.getElementById('view-admin'),
};

function setFlash(msg, kind = 'error') {
  els.flash.textContent = msg || '';
  els.flash.hidden = !msg;
  els.flash.style.background = kind === 'ok' ? '#eaf8ee' : '#fff4e5';
  els.flash.style.color = kind === 'ok' ? '#1f6b3d' : '#8a4b12';
  els.flash.style.borderColor = kind === 'ok' ? '#b9d9c3' : '#f0d3a8';
}

function setView(name) {
  if (name !== 'view-merchant' && merchantScanner.active) {
    stopMerchantScanner();
  }
  for (const id of viewNames) {
    const node = document.getElementById(id);
    if (node) node.hidden = id !== name;
  }
}

function requireRole(role) {
  if (!state.token) {
    setView(role === 'student' ? 'view-student-auth' : 'view-merchant-auth');
    return false;
  }
  return true;
}

function getHeaders(includeToken = true, extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  if (includeToken && state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }
  return headers;
}

async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = getHeaders(options.token !== false, options.headers || {});
  const res = await fetch(path, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const body = await res.text();
  let data = {};
  try { data = body ? JSON.parse(body) : {}; } catch { data = {}; }

  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function fmtRupees(paise) {
  const value = Number(paise || 0) / 100;
  return `₹${value.toFixed(2)}`;
}

function clearToken() {
  state.token = '';
  state.account = null;
  state.role = null;
  localStorage.removeItem('cw_token');
}

function rememberToken(token) {
  state.token = token;
  localStorage.setItem('cw_token', token);
}

async function loadStudentProfile() {
  const profile = await api('/students/me');
  state.account = profile;
  state.role = 'student';
  document.getElementById('s-who').textContent = `${profile.collegeId} · ${profile.name}`;
  document.getElementById('s-bal').textContent = fmtRupees(profile.balancePaise);
  document.getElementById('s-status').textContent = profile.frozen ? 'Frozen' : 'Active test wallet';
  setView('view-student');
  await loadStudentLedger();
  await loadStudentQr();
}

async function loadStudentLedger() {
  const data = await api('/students/ledger');
  const list = document.getElementById('s-ledger');
  list.innerHTML = '';
  for (const row of data.entries || []) {
    const li = document.createElement('li');
    li.textContent = `${row.entry_type} · ${fmtRupees(row.amount_paise)} · ${row.note || ''}`;
    list.appendChild(li);
  }
}

async function loadStudentQr() {
  const data = await api('/students/qr');
  const token = data.token || '';
  const qrEl = document.getElementById('s-qr-img');
  const textEl = document.getElementById('s-qr-text');
  textEl.textContent = token;
  qrEl.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(token)}`;
  qrEl.hidden = false;
}

async function loadMerchantProfile() {
  const profile = await api('/merchants/me');
  state.account = profile;
  state.role = 'merchant';
  document.getElementById('m-who').textContent = `${profile.collegeId} · ${profile.name}`;
  document.getElementById('m-bal').textContent = fmtRupees(profile.balancePaise);
  setView('view-merchant');
  await loadMerchantLedger();
}

async function loadMerchantLedger() {
  const data = await api('/merchants/ledger');
  const list = document.getElementById('m-ledger');
  list.innerHTML = '';
  for (const row of data.entries || []) {
    const li = document.createElement('li');
    li.textContent = `${row.entry_type} · ${fmtRupees(row.amount_paise)} · ${row.note || ''}`;
    list.appendChild(li);
  }
}

async function loadAdmin() {
  const key = document.getElementById('a-key').value.trim();
  const summary = await api('/admin/summary', { headers: { 'x-admin-key': key }, token: false });
  const cards = document.getElementById('a-cards');
  cards.innerHTML = [
    ['Students', summary.students],
    ['Merchants', summary.merchants],
    ['Frozen', summary.frozen],
    ['Test top-ups', fmtRupees(summary.testTopupsPaise)],
    ['QR sales', fmtRupees(summary.qrSalesPaise)],
  ].map(([label, value]) => `<div class="card"><span>${label}</span><strong>${value}</strong></div>`).join('');

  const accounts = await api('/admin/accounts', { headers: { 'x-admin-key': key }, token: false });
  const ledger = await api('/admin/ledger', { headers: { 'x-admin-key': key }, token: false });

  const rows = accounts.accounts.map((a) => `
    <tr>
      <td>${a.role}</td>
      <td>${a.collegeId}</td>
      <td>${a.name}</td>
      <td>${a.frozen ? 'yes' : 'no'}</td>
      <td>${fmtRupees(a.balancePaise)}</td>
      <td><button class="ghost" data-freeze="${a.collegeId}">${a.frozen ? 'Unfreeze' : 'Freeze'}</button></td>
    </tr>
  `).join('');

  const ledgerRows = ledger.entries.map((e) => `
    <tr>
      <td>${new Date(e.created_at).toLocaleString()}</td>
      <td>${e.college_id} (${e.role})</td>
      <td>${e.entry_type}</td>
      <td>${e.amount_paise}</td>
      <td>${e.note || ''}</td>
    </tr>
  `).join('');

  document.getElementById('a-tables').innerHTML = `
    <h3>Accounts</h3>
    <table>
      <thead><tr><th>Role</th><th>ID</th><th>Name</th><th>Frozen</th><th>Balance</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <h3>Recent ledger</h3>
    <table>
      <thead><tr><th>When</th><th>Account</th><th>Type</th><th>Paise</th><th>Note</th></tr></thead>
      <tbody>${ledgerRows}</tbody>
    </table>
  `;

  setView('view-admin');
}

async function loginStudent() {
  const payload = {
    collegeId: document.getElementById('s-id').value.trim(),
    pin: document.getElementById('s-pin').value.trim(),
  };
  const data = await api('/students/login', { method: 'POST', body: payload });
  rememberToken(data.token);
  await loadStudentProfile();
  setFlash('Student login successful.', 'ok');
}

async function signupStudent() {
  const payload = {
    collegeId: document.getElementById('s-id').value.trim(),
    name: document.getElementById('s-name').value.trim(),
    pin: document.getElementById('s-pin').value.trim(),
  };
  const data = await api('/students/signup', { method: 'POST', body: payload });
  rememberToken(data.token);
  await loadStudentProfile();
  setFlash('Student account created.', 'ok');
}

async function loginMerchant() {
  const payload = {
    collegeId: document.getElementById('m-id').value.trim(),
    pin: document.getElementById('m-pin').value.trim(),
  };
  const data = await api('/merchants/login', { method: 'POST', body: payload });
  rememberToken(data.token);
  await loadMerchantProfile();
  setFlash('Merchant login successful.', 'ok');
}

async function topupStudent() {
  await api('/students/test-topup', { method: 'POST', body: { amountPaise: 10000 } });
  await loadStudentProfile();
  setFlash('₹100 added to test wallet.', 'ok');
}

async function freezeStudent() {
  const pin = prompt('Enter your PIN to continue');
  if (pin === null) return;
  await api('/students/freeze', { method: 'POST', body: { frozen: !(state.account && state.account.frozen), pin } });
  await loadStudentProfile();
  setFlash('Account update applied.', 'ok');
}

async function chargeMerchant() {
  const payload = {
    token: document.getElementById('m-token').value.trim(),
    amountPaise: Math.round(Number(document.getElementById('m-amt').value) * 100),
  };
  await api('/merchants/charge', { method: 'POST', body: payload });
  document.getElementById('m-token').value = '';
  await loadMerchantProfile();
  setFlash('Charge completed.', 'ok');
}

function stopMerchantScanner(status) {
  merchantScanner.active = false;
  cancelAnimationFrame(merchantScanner.frame);
  if (merchantScanner.stream) {
    merchantScanner.stream.getTracks().forEach((track) => track.stop());
    merchantScanner.stream = null;
  }
  const video = document.getElementById('m-camera');
  video.srcObject = null;
  video.hidden = true;
  document.getElementById('m-scan-start').hidden = false;
  document.getElementById('m-scan-stop').hidden = true;
  if (status) document.getElementById('m-scan-status').textContent = status;
}

async function startMerchantScanner() {
  if (!window.isSecureContext) {
    document.getElementById('m-camera-file').click();
    document.getElementById('m-scan-status').textContent = 'Take a clear photo of the student QR.';
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    document.getElementById('m-camera-file').click();
    return;
  }
  if (!('BarcodeDetector' in window)) {
    document.getElementById('m-camera-file').click();
    return;
  }

  const formats = await BarcodeDetector.getSupportedFormats();
  if (!formats.includes('qr_code')) {
    throw new Error('QR scanning is not supported by this browser. Use Chrome on Android or enter the QR text manually.');
  }

  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  const video = document.getElementById('m-camera');
  merchantScanner.stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' } },
  });
  video.srcObject = merchantScanner.stream;
  video.hidden = false;
  await video.play();
  merchantScanner.active = true;
  document.getElementById('m-scan-start').hidden = true;
  document.getElementById('m-scan-stop').hidden = false;
  document.getElementById('m-scan-status').textContent = 'Point the camera at the student QR.';

  const scanFrame = async () => {
    if (!merchantScanner.active) return;
    if (video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
      try {
        const codes = await detector.detect(video);
        if (codes.length && codes[0].rawValue) {
          document.getElementById('m-token').value = codes[0].rawValue.trim();
          stopMerchantScanner('QR scanned. Confirm the amount, then tap Charge.');
          return;
        }
      } catch {
        stopMerchantScanner('Could not read that QR. Try again or enter its text manually.');
        return;
      }
    }
    merchantScanner.frame = requestAnimationFrame(scanFrame);
  };
  merchantScanner.frame = requestAnimationFrame(scanFrame);
}

async function scanMerchantPhoto(file) {
  if (!file) return;
  if (typeof window.jsQR !== 'function') {
    throw new Error('QR photo scanning needs an internet connection. You can enter the QR text manually.');
  }

  const image = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not read the camera photo. Try again or enter the QR text manually.');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close();

  const result = window.jsQR(
    context.getImageData(0, 0, canvas.width, canvas.height).data,
    canvas.width,
    canvas.height,
    { inversionAttempts: 'attemptBoth' },
  );
  if (!result?.data) {
    throw new Error('No QR code found in that photo. Try again with the QR clearly in frame.');
  }

  document.getElementById('m-token').value = result.data.trim();
  document.getElementById('m-scan-status').textContent = 'QR scanned. Confirm the amount, then tap Charge.';
}

async function createMerchant() {
  const key = document.getElementById('a-key').value.trim();
  await api('/admin/create-merchant', {
    method: 'POST',
    headers: { 'x-admin-key': key },
    token: false,
    body: {
      collegeId: document.getElementById('a-mid').value.trim(),
      name: document.getElementById('a-mname').value.trim(),
      pin: document.getElementById('a-mpin').value.trim(),
    },
  });
  await loadAdmin();
  setFlash('Merchant created.', 'ok');
}

async function toggleFreezeAccount(collegeId) {
  const key = document.getElementById('a-key').value.trim();
  const currentState = await api('/admin/accounts', { headers: { 'x-admin-key': key }, token: false });
  const match = currentState.accounts.find((a) => a.collegeId === collegeId);
  if (!match) return;
  await api('/admin/freeze', {
    method: 'POST',
    headers: { 'x-admin-key': key },
    token: false,
    body: { collegeId, frozen: !match.frozen },
  });
  await loadAdmin();
}

document.querySelectorAll('[data-go]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.getAttribute('data-go');
    if (target === 'home') {
      setView('view-home');
      setFlash('');
      return;
    }
    if (target === 'student-auth') {
      setView('view-student-auth');
      setFlash('');
      return;
    }
    if (target === 'merchant-auth') {
      setView('view-merchant-auth');
      setFlash('');
      return;
    }
    if (target === 'admin') {
      setView('view-admin');
      setFlash('');
      return;
    }
  });
});

document.getElementById('s-login').addEventListener('click', async () => {
  try {
    await loginStudent();
  } catch (e) {
    setFlash(e.message);
  }
});

document.getElementById('s-signup').addEventListener('click', async () => {
  try {
    await signupStudent();
  } catch (e) {
    setFlash(e.message);
  }
});

document.getElementById('m-login').addEventListener('click', async () => {
  try {
    await loginMerchant();
  } catch (e) {
    setFlash(e.message);
  }
});

document.getElementById('s-topup').addEventListener('click', async () => {
  try {
    await topupStudent();
  } catch (e) {
    setFlash(e.message);
  }
});

document.getElementById('s-freeze').addEventListener('click', async () => {
  try {
    await freezeStudent();
  } catch (e) {
    setFlash(e.message);
  }
});

document.getElementById('s-out').addEventListener('click', () => {
  clearToken();
  setView('view-home');
  setFlash('Logged out.', 'ok');
});

document.getElementById('m-out').addEventListener('click', () => {
  clearToken();
  setView('view-home');
  setFlash('Logged out.', 'ok');
});

document.getElementById('m-charge').addEventListener('click', async () => {
  try {
    await chargeMerchant();
  } catch (e) {
    setFlash(e.message);
  }
});

document.getElementById('m-scan-start').addEventListener('click', async () => {
  try {
    await startMerchantScanner();
  } catch (e) {
    stopMerchantScanner();
    setFlash(e.message);
  }
});

document.getElementById('m-scan-stop').addEventListener('click', () => {
  stopMerchantScanner('Camera stopped.');
});

document.getElementById('m-camera-file').addEventListener('change', async (event) => {
  try {
    await scanMerchantPhoto(event.target.files[0]);
  } catch (e) {
    document.getElementById('m-scan-status').textContent = e.message;
  } finally {
    event.target.value = '';
  }
});

window.addEventListener('pagehide', () => stopMerchantScanner());

document.getElementById('s-copy').addEventListener('click', async () => {
  const token = document.getElementById('s-qr-text').textContent;
  if (!token) return;
  try {
    await navigator.clipboard.writeText(token);
    setFlash('QR text copied.', 'ok');
  } catch {
    setFlash('Copy failed. You can still copy the QR text manually.');
  }
});

document.getElementById('a-load').addEventListener('click', async () => {
  try {
    await loadAdmin();
  } catch (e) {
    setFlash(e.message);
  }
});

document.getElementById('a-create').addEventListener('click', async () => {
  try {
    await createMerchant();
  } catch (e) {
    setFlash(e.message);
  }
});

document.getElementById('a-tables').addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-freeze]');
  if (!btn) return;
  try {
    await toggleFreezeAccount(btn.getAttribute('data-freeze'));
  } catch (e) {
    setFlash(e.message);
  }
});

if (state.token) {
  const payload = JSON.parse(atob(state.token.split('.')[1] || ''));
  state.role = payload.role;
  if (payload.role === 'student') {
    loadStudentProfile().catch(() => { clearToken(); setView('view-home'); });
  } else if (payload.role === 'merchant') {
    loadMerchantProfile().catch(() => { clearToken(); setView('view-home'); });
  }
} else {
  setView('view-home');
}
