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

let selectedFriend = null;
let activeChatFriend = null;
let studentChatEntries = [];
let friendSearchTimer = 0;
let studentLedgerEntries = [];

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
  const isSuccess = kind === 'ok';
  els.flash.textContent = isSuccess ? '' : (msg || '');
  els.flash.hidden = isSuccess || !msg;
  if (els.flash.hidden) return;
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
  document.getElementById('profile-open').hidden = !['view-student', 'view-merchant'].includes(name);
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

function ledgerTypeLabel(entryType) {
  if (entryType === 'test_topup') return 'Top-up';
  if (entryType === 'qr_sale') return 'QR sale';
  if (entryType === 'student_transfer_out') return 'Sent to friend';
  if (entryType === 'student_transfer_in') return 'Received from friend';
  if (entryType === 'nfc_transfer_out') return 'Sent by NFC';
  if (entryType === 'nfc_transfer_in') return 'Received by NFC';
  return entryType;
}

function ledgerNote(entry) {
  return entry.entry_type === 'test_topup' ? '' : (entry.note || '');
}

function openBalanceDialog() {
  document.getElementById('balance-pin-label').hidden = false;
  document.getElementById('balance-pin').hidden = false;
  document.getElementById('balance-pin').value = '';
  document.getElementById('balance-error').hidden = true;
  document.getElementById('balance-result').hidden = true;
  document.getElementById('balance-dialog').showModal();
  document.getElementById('balance-pin').focus();
}

async function checkStudentBalance(pin) {
  const result = await api('/students/balance', {
    method: 'POST',
    body: { pin },
  });
  document.getElementById('balance-pin').value = '';
  document.getElementById('balance-pin-label').hidden = true;
  document.getElementById('balance-pin').hidden = true;
  document.getElementById('balance-error').hidden = true;
  const balance = document.getElementById('balance-result');
  balance.textContent = `Available balance: ${fmtRupees(result.balancePaise)}`;
  balance.hidden = false;
}

function transactionDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
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
  document.getElementById('s-greeting-name').textContent = profile.name.split(' ')[0];
  document.getElementById('s-freeze-label').textContent = profile.frozen ? 'Unfreeze wallet' : 'Freeze wallet';
  const headerAvatar = document.getElementById('header-profile-avatar');
  headerAvatar.textContent = (profile.name || profile.collegeId).trim().charAt(0).toUpperCase();
  headerAvatar.style.backgroundImage = profile.photoData ? `url("${profile.photoData}")` : '';
  headerAvatar.classList.toggle('has-photo', Boolean(profile.photoData));
  updateSettings(profile, 'student');
  setView('view-student');
  await Promise.all([loadStudentLedger(), loadStudentFriends()]);
}

async function loadStudentLedger() {
  const data = await api('/students/ledger');
  studentLedgerEntries = data.entries || [];
  renderStudentTransactions();
}

function renderStudentTransactions() {
  const list = document.getElementById('s-ledger');
  const filter = document.querySelector('[data-ledger-filter].active')?.dataset.ledgerFilter || 'all';
  const filtered = studentLedgerEntries.filter((entry) => {
    if (filter === 'sent') return ['student_transfer_out', 'nfc_transfer_out'].includes(entry.entry_type);
    if (filter === 'received') return ['student_transfer_in', 'nfc_transfer_in'].includes(entry.entry_type);
    if (filter === 'wallet') {
      return !['student_transfer_out', 'student_transfer_in', 'nfc_transfer_out', 'nfc_transfer_in']
        .includes(entry.entry_type);
    }
    return true;
  });
  list.replaceChildren();
  for (const entry of filtered) {
    const row = document.createElement('li');
    row.className = 'transaction-row';
    const icon = document.createElement('span');
    icon.className = `transaction-icon ${entry.amount_paise < 0 ? 'debit' : 'credit'}`;
    icon.textContent = entry.amount_paise < 0 ? '↗' : '↙';
    const details = document.createElement('span');
    details.className = 'transaction-details';
    const title = document.createElement('strong');
    title.textContent = ledgerTypeLabel(entry.entry_type);
    const note = document.createElement('span');
    note.textContent = ledgerNote(entry) || 'Wallet transaction';
    const date = document.createElement('time');
    date.textContent = transactionDate(entry.created_at);
    details.append(title, note, date);
    const amount = document.createElement('strong');
    amount.className = `transaction-amount ${entry.amount_paise < 0 ? 'debit' : 'credit'}`;
    const sign = entry.amount_paise < 0 ? '− ' : '+ ';
    amount.textContent = `${sign}${fmtRupees(Math.abs(entry.amount_paise))}`;
    row.append(icon, details, amount);
    list.appendChild(row);
  }

  const sentEntries = studentLedgerEntries.filter((entry) =>
    ['student_transfer_out', 'nfc_transfer_out'].includes(entry.entry_type));
  const sentTotal = sentEntries.reduce((sum, entry) => sum + Math.abs(entry.amount_paise), 0);
  document.getElementById('transaction-summary').replaceChildren();
  const summaryLabel = document.createElement('span');
  summaryLabel.textContent = `${sentEntries.length} friend payment${sentEntries.length === 1 ? '' : 's'} sent`;
  const summaryTotal = document.createElement('strong');
  summaryTotal.textContent = fmtRupees(sentTotal);
  document.getElementById('transaction-summary').append(summaryLabel, summaryTotal);
  document.getElementById('transactions-empty').hidden = filtered.length > 0;
  const titles = { all: 'All transactions', sent: 'Payments sent', received: 'Payments received', wallet: 'Wallet activity' };
  document.getElementById('transaction-filter-title').textContent = titles[filter];
}

async function loadStudentFriends(query = '') {
  const data = await api(`/students/directory?q=${encodeURIComponent(query)}`);
  const list = document.getElementById('friends-list');
  list.replaceChildren();
  for (const student of data.students || []) {
    const button = document.createElement('button');
    button.className = 'friend-profile';
    button.type = 'button';
    button.setAttribute('aria-label', `Open chat with ${student.name}`);

    if (student.photoData) {
      const photo = document.createElement('img');
      photo.className = 'friend-avatar';
      photo.src = student.photoData;
      photo.alt = '';
      button.appendChild(photo);
    } else {
      const avatar = document.createElement('span');
      avatar.className = 'friend-avatar friend-avatar-fallback';
      avatar.textContent = student.name.trim().charAt(0).toUpperCase();
      button.appendChild(avatar);
    }

    const name = document.createElement('span');
    name.className = 'friend-name';
    name.textContent = student.name;
    button.appendChild(name);
    const collegeId = document.createElement('span');
    collegeId.className = 'friend-id';
    collegeId.textContent = student.collegeId;
    button.appendChild(collegeId);
    button.addEventListener('click', () => {
      openFriendChat(student).catch((e) => setFlash(e.message));
    });
    list.appendChild(button);
  }
  document.getElementById('friends-count').textContent = data.students.length ? `${data.students.length} shown` : '';
  document.getElementById('friends-empty').hidden = data.students.length > 0;
}

async function loadStudentQr() {
  const data = await api('/students/qr');
  const token = data.token || '';
  const qrEl = document.getElementById('s-qr-img');
  const textEl = document.getElementById('s-qr-text');
  textEl.textContent = token;
  qrEl.src = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(token)}`;
  qrEl.hidden = false;
}

async function openStudentQr() {
  if (state.account && state.account.frozen) {
    setFlash('Unfreeze your wallet to show your payment QR.');
    return;
  }
  try {
    document.getElementById('my-qr-dialog').showModal();
    await loadStudentQr();
  } catch (e) {
    document.getElementById('my-qr-dialog').close();
    setFlash(e.message);
  }
}

function openFriendPayment(student) {
  selectedFriend = student;
  const recipient = document.getElementById('payment-recipient');
  recipient.replaceChildren();
  if (student.photoData) {
    const photo = document.createElement('img');
    photo.className = 'friend-avatar';
    photo.src = student.photoData;
    photo.alt = '';
    recipient.appendChild(photo);
  } else {
    const avatar = document.createElement('span');
    avatar.className = 'friend-avatar friend-avatar-fallback';
    avatar.textContent = student.name.trim().charAt(0).toUpperCase();
    recipient.appendChild(avatar);
  }
  const details = document.createElement('div');
  const name = document.createElement('strong');
  name.textContent = student.name;
  const id = document.createElement('span');
  id.textContent = student.collegeId;
  details.append(name, id);
  recipient.appendChild(details);
  document.getElementById('payment-amount').value = '';
  document.getElementById('payment-note').value = '';
  document.getElementById('payment-pin').value = '';
  document.getElementById('payment-error').hidden = true;
  document.getElementById('friend-payment-dialog').showModal();
  document.getElementById('payment-amount').focus();
}

function chatTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function renderStudentChat(messages) {
  const list = document.getElementById('chat-messages');
  list.replaceChildren();
  studentChatEntries = [...messages];
  if (!messages.length) {
    const empty = document.createElement('p');
    empty.className = 'chat-empty';
    empty.textContent = `Say hello to ${activeChatFriend.name} or send them money.`;
    list.appendChild(empty);
    return;
  }

  const timeline = [...studentChatEntries].sort((first, second) =>
    first.createdAt.localeCompare(second.createdAt) || first.id.localeCompare(second.id));
  for (const item of timeline) {
    const line = document.createElement('div');
    if (item.type === 'payment') {
      const sent = item.direction === 'out';
      line.className = `chat-line ${sent ? 'chat-line-sent' : 'chat-line-received'} chat-line-payment`;
      const card = document.createElement('article');
      card.className = 'chat-payment-card';
      const check = document.createElement('span');
      check.className = 'chat-payment-check';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = '✓';
      const copy = document.createElement('div');
      copy.className = 'chat-payment-copy';
      const title = document.createElement('strong');
      title.textContent = `${sent ? 'Sent' : 'Received'} ${fmtRupees(item.amountPaise)}`;
      const status = document.createElement('span');
      status.textContent = sent ? 'Payment sent successfully' : 'Payment received successfully';
      copy.append(title, status);
      const time = document.createElement('time');
      time.textContent = chatTimestamp(item.createdAt);
      card.append(check, copy, time);
      line.appendChild(card);
    } else {
      const ownMessage = item.senderId === state.account?.id;
      line.className = `chat-line ${ownMessage ? 'chat-line-sent' : 'chat-line-received'}`;
      const bubble = document.createElement('article');
      bubble.className = 'chat-message-bubble';
      const text = document.createElement('p');
      text.textContent = item.body;
      const time = document.createElement('time');
      time.textContent = chatTimestamp(item.createdAt);
      bubble.append(text, time);
      line.appendChild(bubble);
    }
    list.appendChild(line);
  }
  list.scrollTop = list.scrollHeight;
}

async function loadStudentChat(student = activeChatFriend) {
  if (!student) return;
  const data = await api(`/students/chat/${encodeURIComponent(student.collegeId)}`);
  activeChatFriend = { ...student, ...data.friend };
  renderStudentChat(data.messages || []);
}

async function openFriendChat(student) {
  activeChatFriend = student;
  document.getElementById('student-home-content').hidden = true;
  document.getElementById('student-money-content').hidden = true;
  document.getElementById('student-chat-content').hidden = false;
  document.getElementById('chat-friend-name').textContent = student.name;
  document.getElementById('chat-friend-id').textContent = student.collegeId;
  const avatar = document.getElementById('chat-friend-avatar');
  avatar.replaceChildren();
  if (student.photoData) {
    const image = document.createElement('img');
    image.src = student.photoData;
    image.alt = '';
    avatar.appendChild(image);
  } else {
    avatar.textContent = student.name.trim().charAt(0).toUpperCase();
  }
  document.getElementById('chat-error').hidden = true;
  await loadStudentChat(student);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  document.getElementById('chat-message-input').focus();
}

async function sendChatMessage(message) {
  if (!activeChatFriend) throw new Error('Choose a friend to message');
  const saved = await api('/students/messages', {
    method: 'POST',
    body: {
      collegeId: activeChatFriend.collegeId,
      message,
    },
  });
  renderStudentChat([...studentChatEntries, { ...saved, type: 'message' }]);
}

async function sendFriendPayment() {
  if (!selectedFriend) throw new Error('Choose a student first');
  const recipient = selectedFriend;
  const amount = Number(document.getElementById('payment-amount').value);
  const amountPaise = Math.round(amount * 100);
  if (!Number.isFinite(amount) || amountPaise <= 0 || Math.abs(amount * 100 - amountPaise) > 1e-6) {
    throw new Error('Enter a valid amount in rupees');
  }
  const result = await api('/students/transfer', {
    method: 'POST',
    body: {
      collegeId: selectedFriend.collegeId,
      amountPaise,
      note: document.getElementById('payment-note').value.trim(),
      pin: document.getElementById('payment-pin').value,
    },
  });
  document.getElementById('friend-payment-dialog').close();
  try {
    await Promise.all([loadStudentLedger(), loadStudentChat(activeChatFriend)]);
  } catch (e) {
    const message = `Payment sent to ${recipient.name}, but the chat could not refresh: ${e.message}`;
    document.getElementById('chat-error').textContent = message;
    document.getElementById('chat-error').hidden = false;
  }
}

async function loadMerchantProfile() {
  const profile = await api('/merchants/me');
  state.account = profile;
  state.role = 'merchant';
  document.getElementById('m-who').textContent = `${profile.collegeId} · ${profile.name}`;
  document.getElementById('m-bal').textContent = fmtRupees(profile.balancePaise);
  const headerAvatar = document.getElementById('header-profile-avatar');
  headerAvatar.textContent = (profile.name || profile.collegeId).trim().charAt(0).toUpperCase();
  headerAvatar.style.backgroundImage = profile.photoData ? `url("${profile.photoData}")` : '';
  headerAvatar.classList.toggle('has-photo', Boolean(profile.photoData));
  updateSettings(profile, 'merchant');
  setView('view-merchant');
  await loadMerchantLedger();
}

function updateSettings(profile, role) {
  document.getElementById('settings-balance-row').hidden = role !== 'student';
  const photo = document.getElementById('settings-avatar');
  photo.src = profile.photoData || '';
  photo.hidden = !profile.photoData;
  const fallback = document.getElementById('settings-avatar-fallback');
  fallback.textContent = (profile.name || profile.collegeId || 'C').trim().charAt(0).toUpperCase();
  fallback.hidden = Boolean(profile.photoData);
  document.getElementById('settings-name').textContent = profile.name || profile.collegeId;
  document.getElementById('settings-role').textContent = `${profile.collegeId} · ${role === 'student' ? 'Student' : 'Canteen'}`;
  document.getElementById('settings-id').textContent = profile.collegeId;
  document.getElementById('settings-account-type').textContent = role === 'student' ? 'Student' : 'Canteen';
  document.getElementById('settings-wallet-status').textContent = profile.frozen ? 'Frozen' : 'Active';
  document.getElementById('settings-wallet-status').classList.toggle('status-frozen', Boolean(profile.frozen));
}

async function loadMerchantLedger() {
  const data = await api('/merchants/ledger');
  const list = document.getElementById('m-ledger');
  list.innerHTML = '';
  for (const row of data.entries || []) {
    const li = document.createElement('li');
    li.textContent = [ledgerTypeLabel(row.entry_type), fmtRupees(row.amount_paise), ledgerNote(row)].filter(Boolean).join(' · ');
    list.appendChild(li);
  }
}

async function loadAdmin() {
  const summary = await api('/admin/summary');
  const cards = document.getElementById('a-cards');
  cards.innerHTML = [
    ['Students', summary.students],
    ['Merchants', summary.merchants],
    ['Frozen', summary.frozen],
    ['Top-ups', fmtRupees(summary.testTopupsPaise)],
    ['QR sales', fmtRupees(summary.qrSalesPaise)],
  ].map(([label, value]) => `<div class="card"><span>${label}</span><strong>${value}</strong></div>`).join('');

  const accounts = await api('/admin/accounts');
  state.adminAccounts = accounts.accounts;
  const ledger = await api('/admin/ledger');

  const rows = accounts.accounts.map((a) => `
    <tr>
      <td>${a.photoData ? `<img class="account-thumb" src="${a.photoData}" alt="">` : '<span class="avatar-fallback">CW</span>'}</td>
      <td>${a.role === 'merchant' ? 'Canteen' : 'Student'}</td>
      <td>${a.collegeId}</td>
      <td>${a.name}</td>
      <td>${a.frozen ? 'yes' : 'no'}</td>
      <td>${fmtRupees(a.balancePaise)}</td>
      <td><button class="ghost" data-edit="${a.collegeId}">Edit</button> <button class="ghost" data-freeze="${a.collegeId}">${a.frozen ? 'Unfreeze' : 'Freeze'}</button></td>
    </tr>
  `).join('');

  const ledgerRows = ledger.entries.map((e) => `
    <tr>
      <td>${new Date(e.created_at).toLocaleString()}</td>
      <td>${e.college_id} (${e.role})</td>
      <td>${ledgerTypeLabel(e.entry_type)}</td>
      <td>${e.amount_paise}</td>
      <td>${ledgerNote(e)}</td>
    </tr>
  `).join('');

  document.getElementById('a-tables').innerHTML = `
    <h3>Accounts</h3>
    <table>
      <thead><tr><th>Photo</th><th>Type</th><th>ID</th><th>Name</th><th>Frozen</th><th>Balance</th><th></th></tr></thead>
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

async function loginWithId() {
  const collegeId = document.getElementById('login-id').value.trim();
  const pin = document.getElementById('login-password').value;
  const data = await api('/login', { method: 'POST', token: false, body: { collegeId, pin } });
  rememberToken(data.token);
  state.role = data.role;
  if (data.role === 'student') await loadStudentProfile();
  else if (data.role === 'merchant') await loadMerchantProfile();
  else if (data.role === 'admin') await loadAdmin();
  else throw new Error('Account role is not supported');
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
  setFlash('₹100 added.', 'ok');
}

function openFreezeDialog() {
  const frozen = Boolean(state.account && state.account.frozen);
  document.getElementById('freeze-title').textContent = frozen ? 'Unfreeze wallet?' : 'Freeze wallet?';
  document.getElementById('freeze-description').textContent = frozen
    ? 'Enter your password or PIN to restore wallet payments.'
    : 'Enter your password or PIN to pause wallet payments.';
  document.getElementById('freeze-confirm').textContent = frozen ? 'Unfreeze wallet' : 'Freeze wallet';
  document.getElementById('freeze-password').value = '';
  document.getElementById('freeze-error').hidden = true;
  document.getElementById('freeze-dialog').showModal();
  document.getElementById('freeze-password').focus();
}

async function freezeStudent(pin) {
  const frozen = !(state.account && state.account.frozen);
  const result = await api('/students/freeze', { method: 'POST', body: { frozen, pin } });
  state.account = result;
  document.getElementById('freeze-dialog').close();
  await loadStudentProfile();
  setFlash(frozen ? 'Wallet frozen.' : 'Wallet unfrozen.', 'ok');
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
  const image = await createImageBitmap(file);
  let decodedText = '';
  try {
    if ('BarcodeDetector' in window) {
      try {
        const formats = await BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) {
          const codes = await new BarcodeDetector({ formats: ['qr_code'] }).detect(image);
          decodedText = codes[0]?.rawValue?.trim() || '';
        }
      } catch {
        decodedText = '';
      }
    }

    if (!decodedText) {
      if (typeof window.jsQR !== 'function') {
        throw new Error('QR photo scanning needs an internet connection. You can enter the QR text manually.');
      }
      const maxDimension = Math.max(image.width, image.height);
      const scales = [...new Set([
        Math.min(1, 1600 / maxDimension),
        Math.min(1, 3200 / maxDimension),
      ])];
      for (const scale of scales) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Could not read the camera photo. Try again or enter the QR text manually.');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const result = window.jsQR(
          context.getImageData(0, 0, canvas.width, canvas.height).data,
          canvas.width,
          canvas.height,
          { inversionAttempts: 'attemptBoth' },
        );
        if (result?.data) {
          decodedText = result.data.trim();
          break;
        }
      }
      if (!decodedText && typeof window.ZXing?.BrowserQRCodeReader === 'function') {
        const imageUrl = URL.createObjectURL(file);
        try {
          const photo = new Image();
          photo.src = imageUrl;
          await photo.decode();
          const reader = new window.ZXing.BrowserQRCodeReader();
          const result = await reader.decodeFromImageElement(photo);
          decodedText = result?.getText()?.trim() || '';
        } catch {
          decodedText = '';
        } finally {
          URL.revokeObjectURL(imageUrl);
        }
      }
    }
  } finally {
    image.close();
  }
  if (!decodedText) {
    throw new Error('No QR code found in that photo. Try again with the QR clearly in frame.');
  }

  document.getElementById('m-token').value = decodedText;
  document.getElementById('m-scan-status').textContent = 'QR scanned. Confirm the amount, then tap Charge.';
}

async function photoDataFromFile(file) {
  const image = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 320 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not process this photo.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.78);
  } finally {
    image.close();
  }
}

function resetAdminForm() {
  state.editingCollegeId = '';
  document.getElementById('a-form-title').textContent = 'Add account';
  document.getElementById('a-role').disabled = false;
  document.getElementById('a-id').value = '';
  document.getElementById('a-name').value = '';
  document.getElementById('a-pin').value = '';
  document.getElementById('a-photo').value = '';
  document.getElementById('a-photo-data').value = '';
  document.getElementById('a-photo-preview').hidden = true;
  document.getElementById('a-save').textContent = 'Save account';
  document.getElementById('a-cancel').hidden = true;
}

function editAdminAccount(collegeId) {
  const account = (state.adminAccounts || []).find((item) => item.collegeId === collegeId);
  if (!account) return;
  state.editingCollegeId = account.collegeId;
  document.getElementById('a-form-title').textContent = `Edit ${account.collegeId}`;
  document.getElementById('a-role').value = account.role;
  document.getElementById('a-role').disabled = Boolean(account.balancePaise);
  document.getElementById('a-id').value = account.collegeId;
  document.getElementById('a-name').value = account.name;
  document.getElementById('a-pin').value = '';
  document.getElementById('a-photo').value = '';
  document.getElementById('a-photo-data').value = account.photoData || '';
  const preview = document.getElementById('a-photo-preview');
  preview.src = account.photoData || '';
  preview.hidden = !account.photoData;
  document.getElementById('a-save').textContent = 'Save changes';
  document.getElementById('a-cancel').hidden = false;
  document.getElementById('a-form-title').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function saveAdminAccount() {
  const editingCollegeId = state.editingCollegeId || '';
  const body = {
    collegeId: document.getElementById('a-id').value.trim(),
    role: document.getElementById('a-role').value,
    name: document.getElementById('a-name').value.trim(),
    pin: document.getElementById('a-pin').value.trim(),
    photoData: document.getElementById('a-photo-data').value || null,
  };
  if (editingCollegeId) body.originalCollegeId = editingCollegeId;
  await api('/admin/accounts', { method: editingCollegeId ? 'PATCH' : 'POST', body });
  resetAdminForm();
  await loadAdmin();
  setFlash(editingCollegeId ? 'Account updated.' : 'Account added.', 'ok');
}

async function toggleFreezeAccount(collegeId) {
  const currentState = await api('/admin/accounts');
  const match = currentState.accounts.find((a) => a.collegeId === collegeId);
  if (!match) return;
  await api('/admin/freeze', {
    method: 'POST',
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
  openFreezeDialog();
});

document.getElementById('s-qr-shortcut').addEventListener('click', () => {
  openStudentQr();
});

document.getElementById('s-history-shortcut').addEventListener('click', () => {
  setStudentTab('money');
});

document.getElementById('campus-art-check-balance').addEventListener('click', openBalanceDialog);
document.getElementById('check-balance').addEventListener('click', openBalanceDialog);
document.getElementById('settings-balance-check').addEventListener('click', openBalanceDialog);

document.getElementById('wallet-score-open').addEventListener('click', () => {
  const now = Date.now();
  const recentEntries = studentLedgerEntries.filter((entry) => {
    const createdAt = new Date(entry.created_at).getTime();
    return Number.isFinite(createdAt) && createdAt <= now && createdAt >= now - 30 * 24 * 60 * 60 * 1000;
  });
  const activeDays = new Set(recentEntries.map((entry) =>
    new Date(entry.created_at).toISOString().slice(0, 10)));
  const statusPoints = state.account?.frozen === true ? 0 : 38;
  const activityPoints = Math.min(recentEntries.length, 6) * 5;
  const daysPoints = Math.min(activeDays.size, 8) * 4;
  document.getElementById('wallet-score-value').textContent = statusPoints + activityPoints + daysPoints;
  document.getElementById('wallet-score-status-points').textContent = `${statusPoints} points`;
  document.getElementById('wallet-score-activity-points').textContent = `${activityPoints} points`;
  document.getElementById('wallet-score-days-points').textContent = `${daysPoints} points`;
  document.getElementById('wallet-score-dialog').showModal();
});

document.getElementById('wallet-score-close').addEventListener('click', () => {
  document.getElementById('wallet-score-dialog').close();
});

document.getElementById('friend-search').addEventListener('input', (event) => {
  window.clearTimeout(friendSearchTimer);
  friendSearchTimer = window.setTimeout(() => {
    loadStudentFriends(event.target.value.trim()).catch((e) => setFlash(e.message));
  }, 180);
});

document.getElementById('s-refresh').addEventListener('click', async () => {
  try {
    await loadStudentProfile();
    setFlash('Wallet updated.', 'ok');
  } catch (e) {
    setFlash(e.message);
  }
});

document.querySelector('.transaction-filters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-ledger-filter]');
  if (!button) return;
  document.querySelectorAll('[data-ledger-filter]').forEach((filterButton) => {
    filterButton.classList.toggle('active', filterButton === button);
  });
  renderStudentTransactions();
});

document.querySelector('.student-bottom-nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-student-tab]');
  if (!button) return;
  document.querySelectorAll('[data-student-tab]').forEach((tab) => {
    tab.classList.toggle('active', tab === button);
  });
  const tab = button.dataset.studentTab;
  if (tab === 'you') {
    document.getElementById('profile-dialog').showModal();
  } else if (tab === 'money') {
    setStudentTab('money');
  } else {
    setStudentTab('home');
  }
});

function setStudentTab(tabName) {
  const showingMoney = tabName === 'money';
  document.getElementById('student-home-content').hidden = showingMoney;
  document.getElementById('student-money-content').hidden = !showingMoney;
  document.getElementById('student-chat-content').hidden = true;
  document.querySelectorAll('[data-student-tab]').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.studentTab === tabName);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.getElementById('money-back').addEventListener('click', () => setStudentTab('home'));

document.getElementById('chat-back').addEventListener('click', () => {
  activeChatFriend = null;
  document.getElementById('student-chat-content').hidden = true;
  setStudentTab('home');
});

document.getElementById('chat-send-money').addEventListener('click', () => {
  if (activeChatFriend) openFriendPayment(activeChatFriend);
});

document.getElementById('chat-compose').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = document.getElementById('chat-message-input');
  const send = document.getElementById('chat-message-send');
  const error = document.getElementById('chat-error');
  const message = input.value.trim();
  if (!message) return;
  send.disabled = true;
  error.hidden = true;
  try {
    await sendChatMessage(message);
    input.value = '';
  } catch (e) {
    error.textContent = e.message;
    error.hidden = false;
  } finally {
    send.disabled = false;
  }
});

document.getElementById('profile-open').addEventListener('click', () => {
  document.getElementById('profile-dialog').showModal();
});

document.getElementById('profile-close').addEventListener('click', () => {
  document.getElementById('profile-dialog').close();
});

document.getElementById('profile-history').addEventListener('click', () => {
  document.getElementById('profile-dialog').close();
  if (state.role === 'student') {
    setStudentTab('money');
  } else {
    document.getElementById('merchant-activity').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

document.getElementById('my-qr-close').addEventListener('click', () => {
  document.getElementById('my-qr-dialog').close();
});

document.getElementById('friend-payment-close').addEventListener('click', () => {
  document.getElementById('friend-payment-dialog').close();
});

document.getElementById('friend-payment-cancel').addEventListener('click', () => {
  document.getElementById('friend-payment-dialog').close();
});

document.getElementById('friend-payment-dialog').addEventListener('close', () => {
  document.getElementById('payment-pin').value = '';
  document.getElementById('payment-error').hidden = true;
  selectedFriend = null;
});

document.getElementById('friend-payment-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = document.getElementById('friend-payment-submit');
  const error = document.getElementById('payment-error');
  submit.disabled = true;
  error.hidden = true;
  try {
    await sendFriendPayment();
  } catch (e) {
    document.getElementById('payment-pin').value = '';
    error.textContent = e.message;
    error.hidden = false;
  } finally {
    submit.disabled = false;
  }
});

document.getElementById('freeze-close').addEventListener('click', () => {
  document.getElementById('freeze-dialog').close();
});

document.getElementById('freeze-cancel').addEventListener('click', () => {
  document.getElementById('freeze-dialog').close();
});

document.getElementById('freeze-dialog').addEventListener('close', () => {
  document.getElementById('freeze-password').value = '';
  document.getElementById('freeze-error').hidden = true;
});

document.getElementById('balance-close').addEventListener('click', () => {
  document.getElementById('balance-dialog').close();
});

document.getElementById('balance-cancel').addEventListener('click', () => {
  document.getElementById('balance-dialog').close();
});

document.getElementById('balance-dialog').addEventListener('close', () => {
  document.getElementById('balance-pin-label').hidden = false;
  document.getElementById('balance-pin').hidden = false;
  document.getElementById('balance-pin').value = '';
  document.getElementById('balance-error').hidden = true;
  document.getElementById('balance-result').hidden = true;
});

document.getElementById('balance-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const pin = document.getElementById('balance-pin');
  const error = document.getElementById('balance-error');
  const submit = document.getElementById('balance-submit');
  submit.disabled = true;
  error.hidden = true;
  try {
    await checkStudentBalance(pin.value);
  } catch (e) {
    pin.value = '';
    error.textContent = e.message;
    error.hidden = false;
    pin.focus();
  } finally {
    submit.disabled = false;
  }
});

document.getElementById('freeze-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = document.getElementById('freeze-password');
  const error = document.getElementById('freeze-error');
  const confirm = document.getElementById('freeze-confirm');
  confirm.disabled = true;
  error.hidden = true;
  try {
    await freezeStudent(password.value);
    password.value = '';
  } catch (e) {
    password.value = '';
    error.textContent = e.message;
    error.hidden = false;
    password.focus();
  } finally {
    confirm.disabled = false;
  }
});

document.getElementById('s-out').addEventListener('click', () => {
  document.getElementById('profile-dialog').close();
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

document.getElementById('login-submit').addEventListener('click', async () => {
  try {
    await loginWithId();
  } catch (e) {
    setFlash(e.message);
  }
});

document.getElementById('login-password').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') document.getElementById('login-submit').click();
});

document.getElementById('a-save').addEventListener('click', async () => {
  try {
    await saveAdminAccount();
  } catch (e) {
    setFlash(e.message);
  }
});

document.getElementById('a-cancel').addEventListener('click', resetAdminForm);

document.getElementById('a-photo').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const data = await photoDataFromFile(file);
    document.getElementById('a-photo-data').value = data;
    const preview = document.getElementById('a-photo-preview');
    preview.src = data;
    preview.hidden = false;
  } catch (e) {
    setFlash(e.message);
  }
});

document.getElementById('a-out').addEventListener('click', () => {
  clearToken();
  resetAdminForm();
  setView('view-home');
  setFlash('Signed out.', 'ok');
});

document.getElementById('a-tables').addEventListener('click', async (event) => {
  const editButton = event.target.closest('[data-edit]');
  if (editButton) {
    editAdminAccount(editButton.getAttribute('data-edit'));
    return;
  }
  const btn = event.target.closest('[data-freeze]');
  if (!btn) return;
  try {
    await toggleFreezeAccount(btn.getAttribute('data-freeze'));
  } catch (e) {
    setFlash(e.message);
  }
});

if (state.token) {
  try {
    const encodedPayload = (state.token.split('.')[1] || '').replace(/-/g, '+').replace(/_/g, '/');
    const paddedPayload = encodedPayload.padEnd(Math.ceil(encodedPayload.length / 4) * 4, '=');
    const payload = JSON.parse(atob(paddedPayload));
    if (!['student', 'merchant', 'admin'].includes(payload.role)) throw new Error('Invalid saved session');
    state.role = payload.role;
    if (payload.role === 'student') {
      loadStudentProfile().catch(() => { clearToken(); setView('view-home'); });
    } else if (payload.role === 'merchant') {
      loadMerchantProfile().catch(() => { clearToken(); setView('view-home'); });
    } else {
      loadAdmin().catch(() => { clearToken(); setView('view-home'); });
    }
  } catch {
    clearToken();
    setView('view-home');
  }
} else {
  setView('view-home');
}
