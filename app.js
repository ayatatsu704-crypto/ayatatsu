// あやたつファイナンス - Firebase Firestore リアルタイム同期版

// ============================================================
// データ構造
// ============================================================
const defaultSettings = {
    person1Name: 'あや',
    person2Name: 'たつ',
    livingTarget: 300000,
    rentAmount: 0,
    livingRatio1: 0.4,
    livingRatio2: 0.6,
    rentRatio1: 0.45,
    rentRatio2: 0.55
};

const defaultMonthData = {
    bankBalance: 0,
    savings: [],
    advances: []
};

// ============================================================
// 状態管理
// ============================================================
let settings = { ...defaultSettings };
let currentMonth = new Date();
let monthData = { ...defaultMonthData, savings: [], advances: [] };
let savingsBalances = { items: [] };
let editingSavingsIndex = -1;
let editingAdvanceIndex = -1;

// Firebase
let db = null;
let auth = null;
let currentUser = null;
let householdId = null;
let allMonthKeys = [];
let unsubscribeHousehold = null;
let unsubscribeMonth = null;
let eventListenersInitialized = false;
let demoMode = false;

// ============================================================
// ユーティリティ
// ============================================================
function formatCurrency(amount) {
    return '¥' + Math.floor(amount).toLocaleString();
}

function getMonthKey(date) {
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
}

function formatMonthDisplay(date) {
    return date.getFullYear() + '年' + (date.getMonth() + 1) + '月';
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function generateHouseholdId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

// ============================================================
// Firebase 初期化
// ============================================================
function initFirebase() {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    auth = firebase.auth();
    db.enablePersistence({ synchronizeTabs: true }).catch(function() {});
    auth.onAuthStateChanged(handleAuthStateChange);
}

// ============================================================
// 認証
// ============================================================
async function handleAuthStateChange(user) {
    currentUser = user;
    if (!user) {
        showScreen('login');
        return;
    }
    const savedId = localStorage.getItem('ayatatsu_household_id_' + user.uid);
    if (savedId) {
        const doc = await db.collection('households').doc(savedId).get();
        if (doc.exists) {
            householdId = savedId;
            showScreen('app');
            await startApp();
            return;
        }
        localStorage.removeItem('ayatatsu_household_id_' + user.uid);
    }
    showScreen('householdSetup');
}

window.startDemoMode = function() {
    demoMode = true;
    householdId = 'demo';
    currentUser = { uid: 'demo' };
    showScreen('app');
    startApp();
};

window.signInWithGoogle = function() {
    const provider = new firebase.auth.GoogleAuthProvider();
    auth.signInWithPopup(provider).catch(function(err) {
        alert('ログインに失敗しました: ' + err.message);
    });
};

window.confirmSignOut = function() {
    if (confirm('ログアウトしますか？')) {
        if (unsubscribeHousehold) unsubscribeHousehold();
        if (unsubscribeMonth) unsubscribeMonth();
        eventListenersInitialized = false;
        householdId = null;
        auth.signOut();
    }
};

// ============================================================
// 世帯管理
// ============================================================
window.createHousehold = async function() {
    const id = generateHouseholdId();
    try {
        await db.collection('households').doc(id).set({
            members: [currentUser.uid],
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            settings: Object.assign({}, defaultSettings),
            savingsBalances: { items: [] }
        });
        householdId = id;
        localStorage.setItem('ayatatsu_household_id_' + currentUser.uid, id);
        document.getElementById('newHouseholdCode').textContent = id;
        showScreen('householdCreated');
    } catch (err) {
        alert('作成に失敗しました: ' + err.message);
    }
};

window.copyNewHouseholdCode = function() {
    const code = document.getElementById('newHouseholdCode').textContent;
    navigator.clipboard.writeText(code).then(function() { alert('コードをコピーしました: ' + code); });
};

window.finishHouseholdSetup = async function() {
    showScreen('app');
    await startApp();
};

window.joinHousehold = async function() {
    const code = document.getElementById('joinCodeInput').value.trim().toUpperCase();
    if (!code) { alert('コードを入力してください'); return; }
    try {
        const doc = await db.collection('households').doc(code).get();
        if (!doc.exists) {
            alert('コードが見つかりません。正しいコードを確認してください。');
            return;
        }
        await db.collection('households').doc(code).update({
            members: firebase.firestore.FieldValue.arrayUnion(currentUser.uid)
        });
        householdId = code;
        localStorage.setItem('ayatatsu_household_id_' + currentUser.uid, code);
        showScreen('app');
        await startApp();
    } catch (err) {
        alert('参加に失敗しました: ' + err.message);
    }
};

// ============================================================
// 画面切替
// ============================================================
function showScreen(screen) {
    document.getElementById('loginScreen').classList.toggle('hidden', screen !== 'login');
    document.getElementById('householdSetupScreen').classList.toggle('hidden', screen !== 'householdSetup');
    document.getElementById('householdCreatedScreen').classList.toggle('hidden', screen !== 'householdCreated');
    document.getElementById('appContent').classList.toggle('hidden', screen !== 'app');
}

// ============================================================
// アプリ起動
// ============================================================
async function startApp() {
    await loadAllMonthKeys();
    setupHouseholdListener();
    setupMonthListener(getMonthKey(currentMonth));
    if (!eventListenersInitialized) {
        initEventListeners();
        eventListenersInitialized = true;
    }
}

// ============================================================
// Firestore リスナー
// ============================================================
function setupHouseholdListener() {
    if (demoMode) {
        const s = localStorage.getItem('demo_settings');
        if (s) settings = Object.assign({}, defaultSettings, JSON.parse(s));
        const sb = localStorage.getItem('demo_savings_balances');
        if (sb) savingsBalances = JSON.parse(sb);
        updateUI();
        return;
    }
    if (unsubscribeHousehold) unsubscribeHousehold();
    unsubscribeHousehold = db.collection('households').doc(householdId)
        .onSnapshot(function(doc) {
            if (!doc.exists) return;
            const data = doc.data();
            if (data.settings) settings = Object.assign({}, defaultSettings, data.settings);
            if (data.savingsBalances) savingsBalances = data.savingsBalances;
            updateUI();
        });
}

function setupMonthListener(monthKey) {
    if (demoMode) {
        const saved = localStorage.getItem('demo_month_' + monthKey);
        monthData = saved ? Object.assign({}, defaultMonthData, JSON.parse(saved)) : Object.assign({}, defaultMonthData, { savings: [], advances: [] });
        if (!monthData.savings) monthData.savings = [];
        if (!monthData.advances) monthData.advances = [];
        updateUI();
        return;
    }
    if (unsubscribeMonth) unsubscribeMonth();
    monthData = Object.assign({}, defaultMonthData, { savings: [], advances: [] });
    updateUI();
    unsubscribeMonth = db.collection('households').doc(householdId)
        .collection('months').doc(monthKey)
        .onSnapshot(function(doc) {
            if (doc.exists) {
                monthData = Object.assign({}, defaultMonthData, doc.data());
                if (!monthData.savings) monthData.savings = [];
                if (!monthData.advances) monthData.advances = [];
            } else {
                monthData = Object.assign({}, defaultMonthData, { savings: [], advances: [] });
            }
            updateUI();
        });
}

async function loadAllMonthKeys() {
    if (demoMode) {
        allMonthKeys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('demo_month_')) allMonthKeys.push(k.replace('demo_month_', ''));
        }
        allMonthKeys.sort().reverse();
        return;
    }
    const snapshot = await db.collection('households').doc(householdId)
        .collection('months').get();
    allMonthKeys = snapshot.docs.map(function(d) { return d.id; }).sort().reverse();
}

// ============================================================
// Firestore 書き込み
// ============================================================
function saveSettings() {
    if (demoMode) { localStorage.setItem('demo_settings', JSON.stringify(settings)); updateUI(); return; }
    db.collection('households').doc(householdId).update({ settings: settings });
}

function saveMonthData() {
    const key = getMonthKey(currentMonth);
    if (demoMode) {
        localStorage.setItem('demo_month_' + key, JSON.stringify(monthData));
        if (!allMonthKeys.includes(key)) { allMonthKeys.unshift(key); allMonthKeys.sort().reverse(); }
        updateUI();
        return;
    }
    db.collection('households').doc(householdId)
        .collection('months').doc(key)
        .set(monthData);
    if (!allMonthKeys.includes(key)) {
        allMonthKeys.unshift(key);
        allMonthKeys.sort().reverse();
    }
}

function saveSavingsBalances() {
    if (demoMode) { localStorage.setItem('demo_savings_balances', JSON.stringify(savingsBalances)); updateUI(); return; }
    db.collection('households').doc(householdId).update({ savingsBalances: savingsBalances });
}

function getAllMonthKeys() {
    return allMonthKeys;
}

// ============================================================
// 積立残高操作
// ============================================================
function addSavingsBalance(name, initialBalance) {
    initialBalance = initialBalance || 0;
    const item = {
        id: generateId(), name: name, balance: initialBalance,
        history: [{ date: new Date().toISOString(), type: 'create', amount: initialBalance, description: '作成' }]
    };
    savingsBalances.items.push(item);
    saveSavingsBalances();
    return item;
}

function depositToSavings(id, amount, description) {
    const item = savingsBalances.items.find(function(i) { return i.id === id; });
    if (item && amount > 0) {
        item.balance += amount;
        item.history.push({ date: new Date().toISOString(), type: 'deposit', amount: amount, description: description || '入金' });
        saveSavingsBalances();
        return true;
    }
    return false;
}

function withdrawFromSavings(id, amount, description) {
    const item = savingsBalances.items.find(function(i) { return i.id === id; });
    if (item && amount > 0 && item.balance >= amount) {
        item.balance -= amount;
        item.history.push({ date: new Date().toISOString(), type: 'withdraw', amount: amount, description: description || '取り崩し' });
        saveSavingsBalances();
        return true;
    }
    return false;
}

function transferSavings(fromId, toId, amount, description) {
    const fromItem = savingsBalances.items.find(function(i) { return i.id === fromId; });
    const toItem = savingsBalances.items.find(function(i) { return i.id === toId; });
    if (fromItem && toItem && amount > 0 && fromItem.balance >= amount) {
        const desc = description || (fromItem.name + ' から ' + toItem.name + ' へ振替');
        fromItem.balance -= amount;
        toItem.balance += amount;
        fromItem.history.push({ date: new Date().toISOString(), type: 'transfer_out', amount: amount, to: toItem.name, description: desc });
        toItem.history.push({ date: new Date().toISOString(), type: 'transfer_in', amount: amount, from: fromItem.name, description: desc });
        saveSavingsBalances();
        return true;
    }
    return false;
}

function getTotalSavingsBalance() {
    return savingsBalances.items.reduce(function(sum, item) { return sum + item.balance; }, 0);
}

// ============================================================
// 計算ロジック
// ============================================================
function calculateResults() {
    const bankBalance = monthData.bankBalance || 0;
    const livingTarget = settings.livingTarget || 0;
    const shortage = Math.max(0, livingTarget - bankBalance);
    const person1Savings = monthData.savings.reduce(function(sum, s) { return sum + (s.person1 || 0); }, 0);
    const person2Savings = monthData.savings.reduce(function(sum, s) { return sum + (s.person2 || 0); }, 0);
    const totalSavings = person1Savings + person2Savings;
    const person1Advance = monthData.advances.filter(function(a) { return a.person === 1; }).reduce(function(sum, a) { return sum + (a.amount || 0); }, 0);
    const person2Advance = monthData.advances.filter(function(a) { return a.person === 2; }).reduce(function(sum, a) { return sum + (a.amount || 0); }, 0);
    const person1Living = shortage * settings.livingRatio1;
    const person2Living = shortage * settings.livingRatio2;
    const person1Rent = settings.rentAmount * settings.rentRatio1;
    const person2Rent = settings.rentAmount * settings.rentRatio2;
    const person1Total = person1Living + person1Rent + person1Savings - person1Advance;
    const person2Total = person2Living + person2Rent + person2Savings - person2Advance;
    const requiredTotal = livingTarget + totalSavings;
    const balanceDifference = bankBalance - requiredTotal;
    return {
        bankBalance: bankBalance, livingTarget: livingTarget, shortage: shortage,
        totalSavings: totalSavings, requiredTotal: requiredTotal, balanceDifference: balanceDifference,
        totalBalance: bankBalance,
        person1: { living: person1Living, rent: person1Rent, savings: person1Savings, advance: person1Advance, total: person1Total },
        person2: { living: person2Living, rent: person2Rent, savings: person2Savings, advance: person2Advance, total: person2Total }
    };
}

// ============================================================
// UI 更新
// ============================================================
function updateUI() {
    document.getElementById('currentMonth').textContent = formatMonthDisplay(currentMonth);
    updateNames();
    updateBalanceSheet();
    renderSavingsList();
    renderSavingsBalancesList();
    renderAdvanceList();
    updateSettingsForm();
    renderHistory();
}

function updateNames() {
    const p1 = settings.person1Name || 'Person 1';
    const p2 = settings.person2Name || 'Person 2';
    document.getElementById('person1Name').textContent = p1;
    document.getElementById('person2Name').textContent = p2;
    document.getElementById('savingsPerson1Label').textContent = p1;
    document.getElementById('savingsPerson2Label').textContent = p2;
    document.getElementById('ratioLabel1').textContent = p1;
    document.getElementById('ratioLabel2').textContent = p2;
    document.getElementById('rentRatioLabel1').textContent = p1;
    document.getElementById('rentRatioLabel2').textContent = p2;
    const advanceSelect = document.getElementById('advancePerson');
    advanceSelect.innerHTML = '<option value="1">' + p1 + '</option><option value="2">' + p2 + '</option>';
}

function updateBalanceSheet() {
    const results = calculateResults();
    const bankBalanceInput = document.getElementById('bankBalance');
    if (document.activeElement !== bankBalanceInput) {
        bankBalanceInput.value = monthData.bankBalance || '';
    }
    document.getElementById('targetAmount').textContent = formatCurrency(results.livingTarget);
    document.getElementById('currentBalance').textContent = formatCurrency(results.bankBalance);
    document.getElementById('shortage').textContent = formatCurrency(results.shortage);
    document.getElementById('person1Living').textContent = formatCurrency(results.person1.living);
    document.getElementById('person1Rent').textContent = formatCurrency(results.person1.rent);
    document.getElementById('person1Savings').textContent = formatCurrency(results.person1.savings);
    document.getElementById('person1Advance').textContent = formatCurrency(results.person1.advance);
    document.getElementById('person1Total').textContent = formatCurrency(results.person1.total);
    document.getElementById('person2Living').textContent = formatCurrency(results.person2.living);
    document.getElementById('person2Rent').textContent = formatCurrency(results.person2.rent);
    document.getElementById('person2Savings').textContent = formatCurrency(results.person2.savings);
    document.getElementById('person2Advance').textContent = formatCurrency(results.person2.advance);
    document.getElementById('person2Total').textContent = formatCurrency(results.person2.total);
    document.getElementById('targetLiving').textContent = formatCurrency(results.livingTarget);
    document.getElementById('totalSavings').textContent = formatCurrency(results.totalSavings);
    document.getElementById('requiredTotal').textContent = formatCurrency(results.requiredTotal);
    document.getElementById('totalBalance').textContent = formatCurrency(results.totalBalance);
    const diffEl = document.getElementById('balanceDifference');
    if (results.balanceDifference >= 0) {
        diffEl.textContent = '+' + formatCurrency(results.balanceDifference);
        diffEl.className = 'value positive';
    } else {
        diffEl.textContent = formatCurrency(results.balanceDifference);
        diffEl.className = 'value negative';
    }
}

function renderSavingsList() {
    const container = document.getElementById('savingsList');
    const p1 = settings.person1Name || 'Person 1';
    const p2 = settings.person2Name || 'Person 2';
    if (!monthData.savings || monthData.savings.length === 0) {
        container.innerHTML = '<div class="empty-state">積み立て項目がありません</div>';
        return;
    }
    container.innerHTML = monthData.savings.map(function(s, i) {
        return '<div class="savings-item"><div class="savings-item-info"><div class="savings-item-name">' + s.name + '</div><div class="savings-item-amounts">' + p1 + ': ' + formatCurrency(s.person1) + ' / ' + p2 + ': ' + formatCurrency(s.person2) + '</div></div><div class="item-actions"><button class="btn btn-small" onclick="editSavings(' + i + ')">編集</button><button class="btn btn-small btn-danger" onclick="deleteSavings(' + i + ')">削除</button></div></div>';
    }).join('');
}

function renderSavingsBalancesList() {
    const container = document.getElementById('savingsBalancesList');
    if (!container) return;
    if (savingsBalances.items.length === 0) {
        container.innerHTML = '<div class="empty-state">積立残高がありません</div>';
        return;
    }
    const totalBalance = getTotalSavingsBalance();
    let html = '<div class="savings-balance-total"><span>合計残高</span><span class="total-amount">' + formatCurrency(totalBalance) + '</span></div>';
    savingsBalances.items.forEach(function(item) {
        html += '<div class="savings-balance-item"><div class="savings-balance-info"><div class="savings-balance-name">' + item.name + '</div><div class="savings-balance-amount">' + formatCurrency(item.balance) + '</div></div><div class="item-actions"><button class="btn btn-small btn-success" onclick="openDepositModal('' + item.id + '')">入金</button><button class="btn btn-small btn-warning" onclick="openWithdrawModal('' + item.id + '')">取崩</button><button class="btn btn-small" onclick="openTransferModal('' + item.id + '')">振替</button><button class="btn btn-small" onclick="viewSavingsHistory('' + item.id + '')">履歴</button><button class="btn btn-small btn-danger" onclick="deleteSavingsBalance('' + item.id + '')">削除</button></div></div>';
    });
    container.innerHTML = html;
}

function renderAdvanceList() {
    const container = document.getElementById('advanceList');
    const p1 = settings.person1Name || 'Person 1';
    const p2 = settings.person2Name || 'Person 2';
    if (!monthData.advances || monthData.advances.length === 0) {
        container.innerHTML = '<div class="empty-state">立替払いがありません</div>';
        return;
    }
    container.innerHTML = monthData.advances.map(function(a, i) {
        return '<div class="advance-item"><div class="advance-item-info"><div class="advance-item-desc">' + a.description + '</div><div class="advance-item-detail">' + formatCurrency(a.amount) + ' - ' + (a.person === 1 ? p1 : p2) + 'が立替</div></div><div class="item-actions"><button class="btn btn-small" onclick="editAdvance(' + i + ')">編集</button><button class="btn btn-small btn-danger" onclick="deleteAdvance(' + i + ')">削除</button></div></div>';
    }).join('');
}

function updateSettingsForm() {
    const fields = ['person1NameInput', 'person2NameInput', 'livingTarget', 'rentAmount', 'livingRatio1', 'livingRatio2', 'rentRatio1', 'rentRatio2'];
    const keys   = ['person1Name', 'person2Name', 'livingTarget', 'rentAmount', 'livingRatio1', 'livingRatio2', 'rentRatio1', 'rentRatio2'];
    fields.forEach(function(id, i) {
        const el = document.getElementById(id);
        if (document.activeElement !== el) el.value = settings[keys[i]] || '';
    });
}

function renderHistory() {
    const container = document.getElementById('historyList');
    const monthKeys = getAllMonthKeys();
    if (monthKeys.length === 0) {
        container.innerHTML = '<div class="empty-state">履歴がありません</div>';
        return;
    }
    container.innerHTML = monthKeys.map(function(key) {
        const parts = key.split('-');
        const year = parts[0], month = parts[1];
        const isCurrent = key === getMonthKey(currentMonth);
        return '<div class="history-item' + (isCurrent ? ' current' : '') + '" onclick="goToMonth('' + key + '')"><div class="history-month">' + year + '年' + parseInt(month) + '月' + (isCurrent ? ' ◀ 現在' : '') + '</div></div>';
    }).join('');
}

// ============================================================
// イベントリスナー
// ============================================================
function initEventListeners() {
    document.querySelectorAll('.tab-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
            document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
            btn.classList.add('active');
            document.getElementById(btn.dataset.tab).classList.add('active');
        });
    });

    document.getElementById('prevMonth').addEventListener('click', function() {
        currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
        setupMonthListener(getMonthKey(currentMonth));
    });

    document.getElementById('nextMonth').addEventListener('click', function() {
        currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
        setupMonthListener(getMonthKey(currentMonth));
    });

    document.getElementById('bankBalance').addEventListener('input', function(e) {
        monthData.bankBalance = parseFloat(e.target.value) || 0;
        saveMonthData();
        updateBalanceSheet();
    });

    document.getElementById('saveSettings').addEventListener('click', function() {
        settings.person1Name = document.getElementById('person1NameInput').value || 'Person 1';
        settings.person2Name = document.getElementById('person2NameInput').value || 'Person 2';
        settings.livingTarget = parseFloat(document.getElementById('livingTarget').value) || 0;
        settings.rentAmount = parseFloat(document.getElementById('rentAmount').value) || 0;
        settings.livingRatio1 = parseFloat(document.getElementById('livingRatio1').value) || 0;
        settings.livingRatio2 = parseFloat(document.getElementById('livingRatio2').value) || 0;
        settings.rentRatio1 = parseFloat(document.getElementById('rentRatio1').value) || 0;
        settings.rentRatio2 = parseFloat(document.getElementById('rentRatio2').value) || 0;
        saveSettings();
        alert('設定を保存しました');
    });

    document.getElementById('addSavings').addEventListener('click', function() {
        editingSavingsIndex = -1;
        document.getElementById('savingsName').value = '';
        document.getElementById('savingsPerson1').value = '';
        document.getElementById('savingsPerson2').value = '';
        document.getElementById('savingsModal').classList.add('active');
    });

    document.getElementById('cancelSavings').addEventListener('click', function() {
        document.getElementById('savingsModal').classList.remove('active');
    });

    document.getElementById('saveSavings').addEventListener('click', function() {
        const name = document.getElementById('savingsName').value;
        const person1 = parseFloat(document.getElementById('savingsPerson1').value) || 0;
        const person2 = parseFloat(document.getElementById('savingsPerson2').value) || 0;
        if (!name) { alert('目的を入力してください'); return; }
        if (editingSavingsIndex >= 0) {
            monthData.savings[editingSavingsIndex] = { name: name, person1: person1, person2: person2 };
        } else {
            monthData.savings.push({ name: name, person1: person1, person2: person2 });
        }
        saveMonthData();
        document.getElementById('savingsModal').classList.remove('active');
    });

    document.getElementById('addAdvance').addEventListener('click', function() {
        editingAdvanceIndex = -1;
        document.getElementById('advanceDescription').value = '';
        document.getElementById('advanceAmount').value = '';
        document.getElementById('advancePerson').value = '1';
        document.getElementById('advanceModal').classList.add('active');
    });

    document.getElementById('cancelAdvance').addEventListener('click', function() {
        document.getElementById('advanceModal').classList.remove('active');
    });

    document.getElementById('saveAdvance').addEventListener('click', function() {
        const description = document.getElementById('advanceDescription').value;
        const amount = parseFloat(document.getElementById('advanceAmount').value) || 0;
        const person = parseInt(document.getElementById('advancePerson').value);
        if (!description) { alert('内容を入力してください'); return; }
        if (editingAdvanceIndex >= 0) {
            monthData.advances[editingAdvanceIndex] = { description: description, amount: amount, person: person };
        } else {
            monthData.advances.push({ description: description, amount: amount, person: person });
        }
        saveMonthData();
        document.getElementById('advanceModal').classList.remove('active');
    });
}

// ============================================================
// グローバル関数（HTML onclick 用）
// ============================================================
window.editSavings = function(index) {
    editingSavingsIndex = index;
    const s = monthData.savings[index];
    document.getElementById('savingsName').value = s.name;
    document.getElementById('savingsPerson1').value = s.person1;
    document.getElementById('savingsPerson2').value = s.person2;
    document.getElementById('savingsModal').classList.add('active');
};

window.deleteSavings = function(index) {
    if (confirm('この積み立て項目を削除しますか？')) {
        monthData.savings.splice(index, 1);
        saveMonthData();
    }
};

window.editAdvance = function(index) {
    editingAdvanceIndex = index;
    const a = monthData.advances[index];
    document.getElementById('advanceDescription').value = a.description;
    document.getElementById('advanceAmount').value = a.amount;
    document.getElementById('advancePerson').value = a.person;
    document.getElementById('advanceModal').classList.add('active');
};

window.deleteAdvance = function(index) {
    if (confirm('この立替払いを削除しますか？')) {
        monthData.advances.splice(index, 1);
        saveMonthData();
    }
};

window.goToMonth = function(key) {
    const parts = key.split('-');
    currentMonth = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, 1);
    setupMonthListener(getMonthKey(currentMonth));
    document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
    document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
    document.querySelector('[data-tab="balance"]').classList.add('active');
    document.getElementById('balance').classList.add('active');
};

// ============================================================
// 積立残高操作モーダル
// ============================================================
let currentSavingsBalanceId = null;

window.openAddBalanceModal = function() {
    document.getElementById('newBalanceName').value = '';
    document.getElementById('newBalanceAmount').value = '';
    document.getElementById('addBalanceModal').classList.add('active');
};

window.closeAddBalanceModal = function() {
    document.getElementById('addBalanceModal').classList.remove('active');
};

window.saveNewBalance = function() {
    const name = document.getElementById('newBalanceName').value;
    const amount = parseFloat(document.getElementById('newBalanceAmount').value) || 0;
    if (!name) { alert('名前を入力してください'); return; }
    addSavingsBalance(name, amount);
    closeAddBalanceModal();
};

window.openDepositModal = function(id) {
    currentSavingsBalanceId = id;
    const item = savingsBalances.items.find(function(i) { return i.id === id; });
    document.getElementById('depositModalTitle').textContent = item.name + ' に入金';
    document.getElementById('depositAmount').value = '';
    document.getElementById('depositDescription').value = '';
    document.getElementById('depositModal').classList.add('active');
};

window.closeDepositModal = function() {
    document.getElementById('depositModal').classList.remove('active');
    currentSavingsBalanceId = null;
};

window.saveDeposit = function() {
    const amount = parseFloat(document.getElementById('depositAmount').value) || 0;
    const description = document.getElementById('depositDescription').value;
    if (amount <= 0) { alert('金額を入力してください'); return; }
    depositToSavings(currentSavingsBalanceId, amount, description);
    closeDepositModal();
};

window.openWithdrawModal = function(id) {
    currentSavingsBalanceId = id;
    const item = savingsBalances.items.find(function(i) { return i.id === id; });
    document.getElementById('withdrawModalTitle').textContent = item.name + ' から取り崩し';
    document.getElementById('withdrawCurrentBalance').textContent = formatCurrency(item.balance);
    document.getElementById('withdrawAmount').value = '';
    document.getElementById('withdrawDescription').value = '';
    document.getElementById('withdrawModal').classList.add('active');
};

window.closeWithdrawModal = function() {
    document.getElementById('withdrawModal').classList.remove('active');
    currentSavingsBalanceId = null;
};

window.saveWithdraw = function() {
    const amount = parseFloat(document.getElementById('withdrawAmount').value) || 0;
    const item = savingsBalances.items.find(function(i) { return i.id === currentSavingsBalanceId; });
    if (amount <= 0) { alert('金額を入力してください'); return; }
    if (amount > item.balance) { alert('残高を超える金額は取り崩せません'); return; }
    withdrawFromSavings(currentSavingsBalanceId, amount, document.getElementById('withdrawDescription').value);
    closeWithdrawModal();
};

window.openTransferModal = function(id) {
    currentSavingsBalanceId = id;
    const item = savingsBalances.items.find(function(i) { return i.id === id; });
    document.getElementById('transferModalTitle').textContent = item.name + ' から振り替え';
    document.getElementById('transferCurrentBalance').textContent = formatCurrency(item.balance);
    document.getElementById('transferAmount').value = '';
    document.getElementById('transferDescription').value = '';
    const select = document.getElementById('transferTo');
    select.innerHTML = savingsBalances.items
        .filter(function(i) { return i.id !== id; })
        .map(function(i) { return '<option value="' + i.id + '">' + i.name + ' (' + formatCurrency(i.balance) + ')</option>'; })
        .join('');
    if (select.options.length === 0) {
        alert('振替先がありません。先に別の積立項目を作成してください。');
        return;
    }
    document.getElementById('transferModal').classList.add('active');
};

window.closeTransferModal = function() {
    document.getElementById('transferModal').classList.remove('active');
    currentSavingsBalanceId = null;
};

window.saveTransfer = function() {
    const toId = document.getElementById('transferTo').value;
    const amount = parseFloat(document.getElementById('transferAmount').value) || 0;
    const item = savingsBalances.items.find(function(i) { return i.id === currentSavingsBalanceId; });
    if (amount <= 0) { alert('金額を入力してください'); return; }
    if (amount > item.balance) { alert('残高を超える金額は振り替えできません'); return; }
    transferSavings(currentSavingsBalanceId, toId, amount, document.getElementById('transferDescription').value);
    closeTransferModal();
};

window.viewSavingsHistory = function(id) {
    const item = savingsBalances.items.find(function(i) { return i.id === id; });
    document.getElementById('historyModalTitle').textContent = item.name + ' の履歴';
    const container = document.getElementById('savingsHistoryList');
    if (item.history.length === 0) {
        container.innerHTML = '<div class="empty-state">履歴がありません</div>';
    } else {
        container.innerHTML = item.history.slice().reverse().map(function(h) {
            const date = new Date(h.date);
            const dateStr = date.getFullYear() + '/' + (date.getMonth() + 1) + '/' + date.getDate();
            let typeLabel = '', amountClass = '';
            if (h.type === 'create')       { typeLabel = '作成';   amountClass = 'positive'; }
            else if (h.type === 'deposit') { typeLabel = '入金';   amountClass = 'positive'; }
            else if (h.type === 'withdraw'){ typeLabel = '取崩';   amountClass = 'negative'; }
            else if (h.type === 'transfer_out') { typeLabel = '振替出'; amountClass = 'negative'; }
            else if (h.type === 'transfer_in')  { typeLabel = '振替入'; amountClass = 'positive'; }
            else { typeLabel = h.type; }
            return '<div class="history-entry"><div class="history-entry-date">' + dateStr + '</div><div class="history-entry-type">' + typeLabel + '</div><div class="history-entry-amount ' + amountClass + '">' + (amountClass === 'positive' ? '+' : '-') + formatCurrency(h.amount) + '</div><div class="history-entry-desc">' + (h.description || '') + '</div></div>';
        }).join('');
    }
    document.getElementById('historyModal').classList.add('active');
};

window.closeHistoryModal = function() {
    document.getElementById('historyModal').classList.remove('active');
};

window.deleteSavingsBalance = function(id) {
    const item = savingsBalances.items.find(function(i) { return i.id === id; });
    if (confirm('「' + item.name + '」を削除しますか？\n残高: ' + formatCurrency(item.balance))) {
        savingsBalances.items = savingsBalances.items.filter(function(i) { return i.id !== id; });
        saveSavingsBalances();
    }
};

// ============================================================
// 参加コード表示
// ============================================================
window.showHouseholdCode = function() {
    document.getElementById('householdCodeDisplay').textContent = householdId;
    document.getElementById('householdCodeModal').classList.add('active');
};

window.closeHouseholdCodeModal = function() {
    document.getElementById('householdCodeModal').classList.remove('active');
};

window.copyHouseholdCode = function() {
    navigator.clipboard.writeText(householdId).then(function() { alert('コードをコピーしました: ' + householdId); });
};

// ============================================================
// 初期化
// ============================================================
document.addEventListener('DOMContentLoaded', initFirebase);
