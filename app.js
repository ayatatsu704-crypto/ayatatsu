// あやたつファイナンス - Firebase Firestore リアルタイム同期版

// ============================================================
// データ構造
// ============================================================
// グローバル設定：名前・カラーのみ
const defaultSettings = {
    person1Name: 'あや',
    person2Name: 'たつ',
    person1Color: '#4f7ef7',
    person2Color: '#ec4899'
};

// 計算用設定（月ごとに保持）
const defaultCalcSettings = {
    livingTarget: 300000,
    rentAmount: 0,
    livingRatio1: 0.4,
    livingRatio2: 0.6
};

const defaultMonthData = {
    bankBalance: 0,
    savings: [],
    advances: [],
    monthSettings: { ...defaultCalcSettings }
};

// ============================================================
// 状態管理
// ============================================================
let settings = { ...defaultSettings };
let lastCalcSettings = { ...defaultCalcSettings }; // 直近の計算設定（新月の初期値に使用）
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
// カラーユーティリティ
// ============================================================
function hexToRgba(hex, alpha) {
    var r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}
function shadeColor(hex, percent) {
    var r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    r = Math.min(255, Math.max(0, r + Math.round(r * percent / 100)));
    g = Math.min(255, Math.max(0, g + Math.round(g * percent / 100)));
    b = Math.min(255, Math.max(0, b + Math.round(b * percent / 100)));
    return '#' + r.toString(16).padStart(2,'0') + g.toString(16).padStart(2,'0') + b.toString(16).padStart(2,'0');
}
function applyPersonColors() {
    var c1 = settings.person1Color || '#4f7ef7';
    var c2 = settings.person2Color || '#ec4899';
    var root = document.documentElement.style;
    root.setProperty('--person1', c1);
    root.setProperty('--primary', c1);
    root.setProperty('--primary-dark', shadeColor(c1, -20));
    root.setProperty('--person1-light', hexToRgba(c1, 0.08));
    root.setProperty('--person1-border', hexToRgba(c1, 0.25));
    root.setProperty('--person2', c2);
    root.setProperty('--person2-dark', shadeColor(c2, -15));
    root.setProperty('--person2-light', hexToRgba(c2, 0.06));
    root.setProperty('--person2-border', hexToRgba(c2, 0.2));
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
            lastCalcSettings: Object.assign({}, defaultCalcSettings),
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
    // padding adjustment no longer needed with sidebar layout
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
        if (settings.person1Name === 'Person 1') settings.person1Name = defaultSettings.person1Name;
        if (settings.person2Name === 'Person 2') settings.person2Name = defaultSettings.person2Name;
        const lcs = localStorage.getItem('demo_lastCalcSettings');
        if (lcs) lastCalcSettings = Object.assign({}, defaultCalcSettings, JSON.parse(lcs));
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
            if (data.settings) {
                settings = Object.assign({}, defaultSettings, data.settings);
                if (settings.person1Name === 'Person 1') settings.person1Name = defaultSettings.person1Name;
                if (settings.person2Name === 'Person 2') settings.person2Name = defaultSettings.person2Name;
            }
            if (data.lastCalcSettings) {
                lastCalcSettings = Object.assign({}, defaultCalcSettings, data.lastCalcSettings);
            }
            if (data.savingsBalances) savingsBalances = data.savingsBalances;
            updateUI();
        });
}

function newMonthData() {
    // 新しい月は直近の計算設定を引き継ぐ
    return Object.assign({}, defaultMonthData, {
        savings: [],
        advances: [],
        monthSettings: Object.assign({}, lastCalcSettings)
    });
}

function setupMonthListener(monthKey) {
    if (demoMode) {
        const saved = localStorage.getItem('demo_month_' + monthKey);
        if (saved) {
            monthData = Object.assign({}, defaultMonthData, JSON.parse(saved));
            if (!monthData.monthSettings) monthData.monthSettings = Object.assign({}, lastCalcSettings);
        } else {
            monthData = newMonthData();
        }
        if (!monthData.savings) monthData.savings = [];
        if (!monthData.advances) monthData.advances = [];
        updateUI();
        return;
    }
    if (unsubscribeMonth) unsubscribeMonth();
    monthData = newMonthData();
    updateUI();
    unsubscribeMonth = db.collection('households').doc(householdId)
        .collection('months').doc(monthKey)
        .onSnapshot(function(doc) {
            if (doc.exists) {
                monthData = Object.assign({}, defaultMonthData, doc.data());
                if (!monthData.monthSettings) monthData.monthSettings = Object.assign({}, lastCalcSettings);
                if (!monthData.savings) monthData.savings = [];
                if (!monthData.advances) monthData.advances = [];
            } else {
                monthData = newMonthData();
            }
            applyMonthlySavingsContributions();
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

// 計算用設定は monthData.monthSettings を常に使用する（月ごとに独立）
function getCalcSettings() {
    return Object.assign({}, defaultCalcSettings, monthData.monthSettings || {});
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

function applyMonthlySavingsContributions() {
    var mk = getMonthKey(currentMonth);
    if (!monthData.savings || monthData.savings.length === 0) return;
    var changed = false;
    savingsBalances.items.forEach(function(item) {
        if (!item.transactions) item.transactions = [];
        // Check if monthly contribution for this month already recorded
        var alreadyDone = item.transactions.some(function(t) { return t.type === 'monthly' && t.monthKey === mk; });
        if (alreadyDone) return;
        var saving = monthData.savings.find(function(s) { return s.name === item.name; });
        if (!saving) return;
        var contribution = (saving.person1 || 0) + (saving.person2 || 0);
        if (contribution === 0) return;
        item.transactions.push({ id: generateId(), date: new Date().toISOString().split('T')[0], monthKey: mk, type: 'monthly', amount: contribution, desc: mk + ' 月次積立' });
        changed = true;
    });
    if (changed) saveSavingsBalances();
}

function getAllMonthKeys() {
    return allMonthKeys;
}

// ============================================================
// 積立残高操作
// ============================================================
function addSavingsBalance(name, initialBalance) {
    initialBalance = initialBalance || 0;
    var mk = getMonthKey(currentMonth);
    var item = {
        id: generateId(), name: name,
        transactions: initialBalance > 0 ? [{ id: generateId(), date: new Date().toISOString().split('T')[0], monthKey: mk, type: 'create', amount: initialBalance, desc: '作成' }] : []
    };
    savingsBalances.items.push(item);
    saveSavingsBalances();
    return item;
}

function depositToSavings(id, amount, description) {
    const item = savingsBalances.items.find(function(i) { return i.id === id; });
    if (item && amount > 0) {
        if (!item.transactions) item.transactions = [];
        item.transactions.push({ id: generateId(), date: new Date().toISOString().split('T')[0], monthKey: getMonthKey(currentMonth), type: 'deposit', amount: amount, desc: description || '入金' });
        saveSavingsBalances();
        return true;
    }
    return false;
}

function withdrawFromSavings(id, amount, description) {
    const item = savingsBalances.items.find(function(i) { return i.id === id; });
    if (item && amount > 0) {
        if (!item.transactions) item.transactions = [];
        item.transactions.push({ id: generateId(), date: new Date().toISOString().split('T')[0], monthKey: getMonthKey(currentMonth), type: 'withdraw', amount: amount, desc: description || '取り崩し' });
        saveSavingsBalances();
        return true;
    }
    return false;
}

function transferSavings(fromId, toId, amount, description) {
    const fromItem = savingsBalances.items.find(function(i) { return i.id === fromId; });
    const toItem = savingsBalances.items.find(function(i) { return i.id === toId; });
    if (fromItem && toItem && amount > 0) {
        const desc = description || (fromItem.name + ' から ' + toItem.name + ' へ振替');
        var mk = getMonthKey(currentMonth);
        var today = new Date().toISOString().split('T')[0];
        if (!fromItem.transactions) fromItem.transactions = [];
        if (!toItem.transactions) toItem.transactions = [];
        fromItem.transactions.push({ id: generateId(), date: today, monthKey: mk, type: 'transfer_out', amount: amount, to: toItem.name, desc: desc });
        toItem.transactions.push({ id: generateId(), date: today, monthKey: mk, type: 'transfer_in', amount: amount, from: fromItem.name, desc: desc });
        saveSavingsBalances();
        return true;
    }
    return false;
}

function getTotalSavingsBalance() {
    var mk = getMonthKey(currentMonth);
    return savingsBalances.items.reduce(function(sum, item) { return sum + computeBalance(item, mk); }, 0);
}

// Balance Sheet用：今月の月次積立を除いた残高（二重計上防止）
function getTotalSavingsBalanceForBS() {
    var mk = getMonthKey(currentMonth);
    return savingsBalances.items.reduce(function(sum, item) {
        return sum + computeBalanceExcludeCurrentMonthly(item, mk);
    }, 0);
}

function computeBalance(item, upToMonthKey) {
    return (item.transactions || [])
        .filter(function(t) { return !upToMonthKey || t.monthKey <= upToMonthKey; })
        .reduce(function(sum, t) {
            if (t.type === 'withdraw' || t.type === 'transfer_out') return sum - Math.abs(t.amount || 0);
            return sum + Math.abs(t.amount || 0);
        }, 0);
}

function computeBalanceExcludeCurrentMonthly(item, mk) {
    return (item.transactions || [])
        .filter(function(t) {
            if (!mk || t.monthKey > mk) return false;
            if (t.type === 'monthly' && t.monthKey === mk) return false; // 今月の月次積立は除外
            return true;
        })
        .reduce(function(sum, t) {
            if (t.type === 'withdraw' || t.type === 'transfer_out') return sum - Math.abs(t.amount || 0);
            return sum + Math.abs(t.amount || 0);
        }, 0);
}

// ============================================================
// 計算ロジック
// ============================================================
function calculateResults() {
    const eff = getCalcSettings();
    const bankBalance = monthData.bankBalance || 0;
    const livingTarget = eff.livingTarget || 0;
    const person1Savings = monthData.savings.reduce(function(sum, s) { return sum + (s.person1 || 0); }, 0);
    const person2Savings = monthData.savings.reduce(function(sum, s) { return sum + (s.person2 || 0); }, 0);
    const totalSavings = person1Savings + person2Savings;
    const cumulativeSavings = getTotalSavingsBalanceForBS();
    const person1Advance = monthData.advances.filter(function(a) { return a.person === 1; }).reduce(function(sum, a) { return sum + (a.amount || 0); }, 0);
    const person2Advance = monthData.advances.filter(function(a) { return a.person === 2; }).reduce(function(sum, a) { return sum + (a.amount || 0); }, 0);
    const totalAdvances = person1Advance + person2Advance;
    const person1Rent = eff.rentAmount * eff.livingRatio1;
    const person2Rent = eff.rentAmount * eff.livingRatio2;
    const requiredTotal = livingTarget + totalSavings + cumulativeSavings;
    const shortage = Math.max(0, requiredTotal - bankBalance);
    // 生活費負担 = 不足額から家賃・積み立て・立替を除いた残差を負担割合で分担
    const livingShortage = shortage - eff.rentAmount - totalSavings + totalAdvances;
    const person1Living = livingShortage * eff.livingRatio1;
    const person2Living = livingShortage * eff.livingRatio2;
    const person1Total = person1Living + person1Rent + person1Savings - person1Advance;
    const person2Total = person2Living + person2Rent + person2Savings - person2Advance;
    const balanceDifference = bankBalance - requiredTotal;
    return {
        bankBalance: bankBalance, livingTarget: livingTarget, shortage: shortage,
        totalSavings: totalSavings, cumulativeSavings: cumulativeSavings,
        requiredTotal: requiredTotal, balanceDifference: balanceDifference,
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
    const p1 = settings.person1Name || 'あや';
    const p2 = settings.person2Name || 'たつ';
    document.getElementById('person1Name').textContent = p1;
    document.getElementById('person2Name').textContent = p2;
    document.getElementById('summaryPerson1Name').textContent = p1;
    document.getElementById('summaryPerson2Name').textContent = p2;
    document.getElementById('savingsPerson1Label').textContent = p1;
    document.getElementById('savingsPerson2Label').textContent = p2;
    document.getElementById('ratioLabel1').textContent = p1;
    document.getElementById('ratioLabel2').textContent = p2;
    document.getElementById('colorLabel1').textContent = p1;
    document.getElementById('colorLabel2').textContent = p2;
    const advanceSelect = document.getElementById('advancePerson');
    advanceSelect.innerHTML = '<option value="1">' + p1 + '</option><option value="2">' + p2 + '</option>';
    applyPersonColors();
}

function updateBalanceSheet() {
    const results = calculateResults();
    const bankBalanceInput = document.getElementById('bankBalance');
    if (document.activeElement !== bankBalanceInput) {
        bankBalanceInput.value = monthData.bankBalance || '';
    }
    document.getElementById('targetAmount').textContent = formatCurrency(results.requiredTotal);
    document.getElementById('currentBalance').textContent = formatCurrency(results.bankBalance);
    document.getElementById('shortage').textContent = formatCurrency(results.shortage);
    document.getElementById('person1Living').textContent = formatCurrency(results.person1.living);
    document.getElementById('person1Savings').textContent = formatCurrency(results.person1.savings);
    var p1AdvEl = document.getElementById('person1Advance');
    p1AdvEl.textContent = results.person1.advance > 0 ? '-' + formatCurrency(results.person1.advance) : formatCurrency(0);
    p1AdvEl.className = results.person1.advance > 0 ? 'negative' : '';
    document.getElementById('person1Total').textContent = formatCurrency(results.person1.total);
    document.getElementById('person2Living').textContent = formatCurrency(results.person2.living);
    document.getElementById('person2Savings').textContent = formatCurrency(results.person2.savings);
    var p2AdvEl = document.getElementById('person2Advance');
    p2AdvEl.textContent = results.person2.advance > 0 ? '-' + formatCurrency(results.person2.advance) : formatCurrency(0);
    p2AdvEl.className = results.person2.advance > 0 ? 'negative' : '';
    document.getElementById('person2Total').textContent = formatCurrency(results.person2.total);
    renderAdvanceDetail(1);
    renderAdvanceDetail(2);
    document.getElementById('summaryPerson1Total').textContent = formatCurrency(results.person1.total);
    document.getElementById('summaryPerson2Total').textContent = formatCurrency(results.person2.total);
    document.getElementById('summaryPerson1Burden').textContent = formatCurrency(results.person1.total + results.person1.advance);
    document.getElementById('summaryPerson2Burden').textContent = formatCurrency(results.person2.total + results.person2.advance);
    document.getElementById('targetLiving').textContent = formatCurrency(results.livingTarget);
    document.getElementById('totalSavings').textContent = formatCurrency(results.totalSavings);
    document.getElementById('cumulativeSavings').textContent = formatCurrency(results.cumulativeSavings);
    document.getElementById('totalBalance').textContent = formatCurrency(results.totalBalance);
    renderTotalSavingsDetail();
    renderCumulativeSavingsDetail();
    var bsDiff = results.balanceDifference; // bankBalance - requiredTotal
    var balancedTotal = Math.max(results.totalBalance, results.requiredTotal);
    document.getElementById('totalBalanceSum').textContent = formatCurrency(balancedTotal);
    document.getElementById('requiredTotal').textContent = formatCurrency(balancedTotal);
    var deficitRow = document.getElementById('bsDeficitRow');
    var surplusRow = document.getElementById('bsSurplusRow');
    if (bsDiff < 0) {
        deficitRow.style.display = '';
        surplusRow.style.display = 'none';
        document.getElementById('bsDeficit').textContent = formatCurrency(-bsDiff);
    } else if (bsDiff > 0) {
        deficitRow.style.display = 'none';
        surplusRow.style.display = '';
        document.getElementById('bsSurplus').textContent = formatCurrency(bsDiff);
    } else {
        deficitRow.style.display = 'none';
        surplusRow.style.display = 'none';
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
        var total = (s.person1 || 0) + (s.person2 || 0);
        return '<div class="savings-item"><div class="savings-item-info"><div class="savings-item-name">' + s.name + '<span class="savings-item-total">' + formatCurrency(total) + '</span></div><div class="savings-item-amounts">' + p1 + ': ' + formatCurrency(s.person1) + ' / ' + p2 + ': ' + formatCurrency(s.person2) + '</div></div><div class="item-actions"><button class="btn btn-small" onclick="editSavings(' + i + ')">編集</button><button class="btn btn-small btn-danger" onclick="deleteSavings(' + i + ')">削除</button></div></div>';
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
    var currentMk = getMonthKey(currentMonth);
    let html = '<div class="savings-balance-total"><span>合計残高</span><span class="total-amount">' + formatCurrency(totalBalance) + '</span></div>';
    savingsBalances.items.forEach(function(item) {
        var itemBalance = computeBalance(item, currentMk);
        html += '<div class="savings-balance-item">';
        html += '<div class="savings-balance-header"><div class="savings-balance-info"><div class="savings-balance-name">' + item.name + '</div><div class="savings-balance-amount">' + formatCurrency(itemBalance) + '</div></div>';
        html += '<div class="item-actions"><button class="btn btn-small btn-warning" onclick="openWithdrawModal(\'' + item.id + '\')">取崩</button><button class="btn btn-small" onclick="openTransferModal(\'' + item.id + '\')">振替</button><button class="btn btn-small btn-danger" onclick="deleteSavingsBalance(\'' + item.id + '\')">削除</button></div></div>';
        var monthTxns = (item.transactions || []).filter(function(t) { return t.monthKey === currentMk; });
        if (monthTxns.length > 0) {
            html += '<div class="savings-history-inline">';
            monthTxns.slice().reverse().forEach(function(t) {
                var dateStr = t.date || '';
                var typeLabel = { create: '作成', deposit: '入金', withdraw: '取崩', transfer_out: '振替出', transfer_in: '振替入', monthly: '月次積立' }[t.type] || t.type;
                var amountClass = (t.type === 'withdraw' || t.type === 'transfer_out') ? 'negative' : 'positive';
                var sign = amountClass === 'negative' ? '-' : '+';
                var cancelBtn = t.type !== 'create' && t.type !== 'monthly' ? '<button class="btn btn-small btn-cancel" onclick="cancelSavingsTransaction(\'' + item.id + '\',\'' + t.id + '\')">取消</button>' : '';
                var descHtml = (t.desc || t.description) ? '<span class="hi-desc">' + (t.desc || t.description) + '</span>' : '';
                html += '<div class="history-inline-row">'
                    + '<div class="hi-left"><span class="hi-date">' + dateStr + '</span><span class="hi-type ' + amountClass + '">' + typeLabel + '</span>' + descHtml + '</div>'
                    + '<div class="hi-right"><span class="hi-amount ' + amountClass + '">' + sign + formatCurrency(t.amount) + '</span>' + cancelBtn + '</div>'
                    + '</div>';
            });
            html += '</div>';
        }
        html += '</div>';
    });
    container.innerHTML = html;
}

function populateSavingsNameSelect(selectedName) {
    var sel = document.getElementById('savingsName');
    if (savingsBalances.items.length === 0) {
        sel.innerHTML = '<option value="">（先に積立口座を追加してください）</option>';
        return;
    }
    sel.innerHTML = savingsBalances.items.map(function(item) {
        var selected = item.name === selectedName ? ' selected' : '';
        return '<option value="' + item.name + '"' + selected + '>' + item.name + '</option>';
    }).join('');
}

function renderTotalSavingsDetail() {
    var container = document.getElementById('totalSavingsDetail');
    if (!container) return;
    if (!monthData.savings || monthData.savings.length === 0) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = monthData.savings.map(function(s) {
        return '<div class="bs-row bs-detail-row"><span>' + s.name + '</span><span>' + formatCurrency((s.person1 || 0) + (s.person2 || 0)) + '</span></div>';
    }).join('');
}

function renderCumulativeSavingsDetail() {
    const container = document.getElementById('cumulativeSavingsDetail');
    if (!container) return;
    if (!savingsBalances.items || savingsBalances.items.length === 0) {
        container.innerHTML = '';
        return;
    }
    var mk = getMonthKey(currentMonth);
    container.innerHTML = savingsBalances.items.map(function(item) {
        return '<div class="bs-row bs-detail-row"><span>' + item.name + '</span><span>' + formatCurrency(computeBalanceExcludeCurrentMonthly(item, mk)) + '</span></div>';
    }).join('');
}

function renderAdvanceDetail(person) {
    const container = document.getElementById('person' + person + 'AdvanceDetail');
    const advances = (monthData.advances || []).filter(function(a) { return a.person === person; });
    if (advances.length === 0) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = advances.map(function(a) {
        return '<div class="breakdown-item breakdown-detail"><span>' + a.description + '</span><span class="negative">-' + formatCurrency(a.amount) + '</span></div>';
    }).join('');
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
    const calc = getCalcSettings();
    // グローバル設定（名前・カラー）
    ['person1NameInput', 'person2NameInput'].forEach(function(id, i) {
        const el = document.getElementById(id);
        const key = ['person1Name', 'person2Name'][i];
        if (document.activeElement !== el) el.value = settings[key] || '';
    });
    document.getElementById('person1ColorInput').value = settings.person1Color || '#4f7ef7';
    document.getElementById('person2ColorInput').value = settings.person2Color || '#ec4899';
    // 月別設定（計算用）
    ['livingTarget', 'rentAmount', 'livingRatio1', 'livingRatio2'].forEach(function(key) {
        const el = document.getElementById(key);
        if (el && document.activeElement !== el) el.value = calc[key] !== undefined ? calc[key] : '';
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
        return '<div class="history-item' + (isCurrent ? ' current' : '') + '" onclick="goToMonth(\'' + key + '\')"><div class="history-month">' + year + '年' + parseInt(month) + '月' + (isCurrent ? ' ◀ 現在' : '') + '</div></div>';
    }).join('');
}

// ============================================================
// イベントリスナー
// ============================================================
function initEventListeners() {
    document.querySelectorAll('.tab-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var tab = btn.dataset.tab;
            document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
            document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
            document.querySelectorAll('.tab-btn[data-tab="' + tab + '"]').forEach(function(b) { b.classList.add('active'); });
            document.getElementById(tab).classList.add('active');
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
        // グローバル設定（名前・カラー）を更新
        settings.person1Name = document.getElementById('person1NameInput').value || 'あや';
        settings.person2Name = document.getElementById('person2NameInput').value || 'たつ';
        settings.person1Color = document.getElementById('person1ColorInput').value;
        settings.person2Color = document.getElementById('person2ColorInput').value;
        saveSettings();

        // 計算設定は当月にのみ保存（過去月は変更しない）
        const newCalc = {
            livingTarget: parseFloat(document.getElementById('livingTarget').value) || 0,
            rentAmount: parseFloat(document.getElementById('rentAmount').value) || 0,
            livingRatio1: parseFloat(document.getElementById('livingRatio1').value) || 0,
            livingRatio2: parseFloat(document.getElementById('livingRatio2').value) || 0
        };
        monthData.monthSettings = newCalc;
        saveMonthData();

        // 次の新しい月がこの設定を引き継げるよう lastCalcSettings を更新
        lastCalcSettings = Object.assign({}, newCalc);
        if (demoMode) {
            localStorage.setItem('demo_lastCalcSettings', JSON.stringify(lastCalcSettings));
        } else {
            db.collection('households').doc(householdId).update({ lastCalcSettings: lastCalcSettings });
        }

        alert('設定を保存しました');
    });

    document.getElementById('addSavings').addEventListener('click', function() {
        editingSavingsIndex = -1;
        populateSavingsNameSelect();
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
        if (!name) { alert('積立口座を選択してください'); return; }
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
    populateSavingsNameSelect(s.name);
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
    document.querySelectorAll('.tab-btn[data-tab="balance"]').forEach(function(b) { b.classList.add('active'); });
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
    document.getElementById('withdrawCurrentBalance').textContent = formatCurrency(computeBalance(item, getMonthKey(currentMonth)));
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
    if (amount > computeBalance(item, getMonthKey(currentMonth))) { alert('残高を超える金額は取り崩せません'); return; }
    withdrawFromSavings(currentSavingsBalanceId, amount, document.getElementById('withdrawDescription').value);
    closeWithdrawModal();
};

window.openTransferModal = function(id) {
    currentSavingsBalanceId = id;
    const item = savingsBalances.items.find(function(i) { return i.id === id; });
    document.getElementById('transferModalTitle').textContent = item.name + ' から振り替え';
    document.getElementById('transferCurrentBalance').textContent = formatCurrency(computeBalance(item, getMonthKey(currentMonth)));
    document.getElementById('transferAmount').value = '';
    document.getElementById('transferDescription').value = '';
    const select = document.getElementById('transferTo');
    select.innerHTML = savingsBalances.items
        .filter(function(i) { return i.id !== id; })
        .map(function(i) { return '<option value="' + i.id + '">' + i.name + ' (' + formatCurrency(computeBalance(i, getMonthKey(currentMonth))) + ')</option>'; })
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
    if (amount > computeBalance(item, getMonthKey(currentMonth))) { alert('残高を超える金額は振り替えできません'); return; }
    transferSavings(currentSavingsBalanceId, toId, amount, document.getElementById('transferDescription').value);
    closeTransferModal();
};

window.viewSavingsHistory = function(id) {
    const item = savingsBalances.items.find(function(i) { return i.id === id; });
    document.getElementById('historyModalTitle').textContent = item.name + ' の履歴';
    const container = document.getElementById('savingsHistoryList');
    var txns = item.transactions || [];
    if (txns.length === 0) {
        container.innerHTML = '<div class="empty-state">履歴がありません</div>';
    } else {
        container.innerHTML = txns.slice().reverse().map(function(h) {
            var dateStr = h.date || '';
            let typeLabel = '', amountClass = '';
            if (h.type === 'create')            { typeLabel = '作成';     amountClass = 'positive'; }
            else if (h.type === 'deposit')      { typeLabel = '入金';     amountClass = 'positive'; }
            else if (h.type === 'monthly')      { typeLabel = '月次積立'; amountClass = 'positive'; }
            else if (h.type === 'withdraw')     { typeLabel = '取崩';     amountClass = 'negative'; }
            else if (h.type === 'transfer_out') { typeLabel = '振替出';   amountClass = 'negative'; }
            else if (h.type === 'transfer_in')  { typeLabel = '振替入';   amountClass = 'positive'; }
            else { typeLabel = h.type; amountClass = 'positive'; }
            return '<div class="history-entry"><div class="history-entry-date">' + dateStr + '</div><div class="history-entry-type">' + typeLabel + '</div><div class="history-entry-amount ' + amountClass + '">' + (amountClass === 'positive' ? '+' : '-') + formatCurrency(h.amount) + '</div><div class="history-entry-desc">' + (h.desc || h.description || '') + '</div></div>';
        }).join('');
    }
    document.getElementById('historyModal').classList.add('active');
};

window.closeHistoryModal = function() {
    document.getElementById('historyModal').classList.remove('active');
};

window.cancelSavingsTransaction = function(itemId, txnId) {
    var item = savingsBalances.items.find(function(i) { return i.id === itemId; });
    if (!item) return;
    var txns = item.transactions || [];
    var txnIndex = txns.findIndex(function(t) { return t.id === txnId; });
    if (txnIndex < 0) return;
    var t = txns[txnIndex];
    if (!t || t.type === 'create') return;
    if (!confirm('この取引を取り消しますか？\n' + (t.desc || t.description || '') + ' ' + formatCurrency(t.amount))) return;
    if (t.type === 'transfer_out') {
        var toItem = savingsBalances.items.find(function(i) { return i.name === t.to; });
        if (toItem && toItem.transactions) {
            var pairedIdx = toItem.transactions.findIndex(function(x) { return x.type === 'transfer_in' && x.monthKey === t.monthKey && x.amount === t.amount; });
            if (pairedIdx >= 0) toItem.transactions.splice(pairedIdx, 1);
        }
    } else if (t.type === 'transfer_in') {
        var fromItem = savingsBalances.items.find(function(i) { return i.name === t.from; });
        if (fromItem && fromItem.transactions) {
            var pairedIdx = fromItem.transactions.findIndex(function(x) { return x.type === 'transfer_out' && x.monthKey === t.monthKey && x.amount === t.amount; });
            if (pairedIdx >= 0) fromItem.transactions.splice(pairedIdx, 1);
        }
    }
    txns.splice(txnIndex, 1);
    saveSavingsBalances();
};

window.deleteSavingsBalance = function(id) {
    const item = savingsBalances.items.find(function(i) { return i.id === id; });
    if (confirm('「' + item.name + '」を削除しますか？\n残高: ' + formatCurrency(computeBalance(item, getMonthKey(currentMonth))))) {
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
function adjustMainPadding() {
    // No longer needed with sidebar layout
    var mainEl = document.querySelector('main');
    if (mainEl) {
        mainEl.style.paddingTop = '';
    }
}

document.addEventListener('DOMContentLoaded', function() {
    initFirebase();
    window.addEventListener('resize', adjustMainPadding);
});
