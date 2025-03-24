/****************************************************
 * server.js - 
 *   使用三張工作表：
 *     1.「獎項設定」：存放獎項 (name, rate)
 *     2.「抽獎紀錄」：欄位 A=抽獎時間, B=電話號碼, C=中獎獎項, D=到期日, E=兌獎日期
 *     3.「設定」：欄位 name, value (包含 title, deadline等)
 *
 *   僅需在 Render 設定 2 組環境變數：
 *      - GOOGLE_SERVICE_ACCOUNT（整段 JSON）
 *      - GOOGLE_SHEET_ID
 *
 *   寫入抽獎紀錄時：只寫A/B/C，不動D/E
 *   讀取抽獎紀錄時：回傳A～E五欄
 ****************************************************/

const express = require('express');
const bodyParser = require('body-parser');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();
app.use(bodyParser.json());

// 1) 從環境變數讀取
const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT;
const sheetId = process.env.GOOGLE_SHEET_ID;

let serviceAccount;
try {
  serviceAccount = JSON.parse(rawJson);
  // 這步很重要：將字串中的 '\\n' 轉成真正的換行
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
} catch (err) {
  console.error('無法解析或處理 Service Account JSON:', err);
}

// 然後初始化
await doc.useServiceAccountAuth({
  client_email: serviceAccount.client_email,
  private_key: serviceAccount.private_key,
});
await doc.loadInfo();

/**
 * 從「設定」工作表中取出指定 name 的 value
 * 假設表格欄位：A=name, B=value
 */
async function getSettingValue(name) {
  const sheet = doc.sheetsByTitle['設定'];
  if (!sheet) throw new Error("找不到名為「設定」的工作表");

  const rows = await sheet.getRows(); // 讀全部
  const row = rows.find(r => r.name === name);
  return row ? row.value : '';
}

/**
 * 從「獎項設定」工作表讀取獎項清單
 * 假設欄位：A=name, B=rate
 */
async function getPrizesData() {
  const sheet = doc.sheetsByTitle['獎項設定'];
  if (!sheet) throw new Error("找不到名為「獎項設定」的工作表");

  const rows = await sheet.getRows();
  return rows.map(r => ({
    name: r.name,
    rate: r.rate || '0',
  }));
}

/**
 * 檢查是否「在 deadline 那天」已抽過獎
 * - 「抽獎紀錄」A 欄為抽獎時間(字串)
 * - 需比對該時間的 yyyy-mm-dd 與 deadline 是否相同
 */
async function checkDrawOnDeadline(phone) {
  const sheet = doc.sheetsByTitle['抽獎紀錄'];
  if (!sheet) throw new Error("找不到名為「抽獎紀錄」的工作表");

  // 從「設定」表獲得 deadline
  const deadline = await getSettingValue('deadline'); 
  if (!deadline) {
    // 若沒有設定 deadline，就視為沒抽過
    return { exists: false };
  }
  const dlDate = new Date(deadline + 'T00:00:00');  
  const dlStr = dlDate.toISOString().split('T')[0]; // yyyy-mm-dd

  const rows = await sheet.getRows();
  for (const row of rows) {
    // 若電話欄 == phone
    if (row['電話號碼'] === phone) {
      const drawTimeStr = row['抽獎時間']?.trim(); // A欄
      if (!drawTimeStr) continue; // 空就跳過

      // 嘗試 parse
      const parsedDate = new Date(drawTimeStr);
      if (isNaN(parsedDate.getTime())) {
        // 若無法解析就跳過
        continue;
      }
      // 取出 yyyy-mm-dd
      const recordStr = parsedDate.toISOString().split('T')[0];
      if (recordStr === dlStr) {
        // 同一天 => 表示抽過
        return {
          exists: true,
          // 回傳前端所需資訊
          time: row['抽獎時間'], 
          prize: row['中獎獎項']
        };
      }
    }
  }
  return { exists: false };
}

/**
 * 寫入抽獎紀錄到「抽獎紀錄」工作表
 * - 只寫 A(抽獎時間)、B(電話號碼)、C(中獎獎項)，
 *   D(到期日)、E(兌獎日期)不動
 */
async function recordDraw(phone, prize) {
  const sheet = doc.sheetsByTitle['抽獎紀錄'];
  if (!sheet) throw new Error("找不到名為「抽獎紀錄」的工作表");

  // 取目前時間字串 (例如 2025/03/28 上午 1:00:27)
  const now = new Date();
  // 語系/格式若要與您表格相同，可以再細調
  const recordTimeStr = now.toLocaleString('zh-TW', { hour12: false });

  await sheet.addRow({
    '抽獎時間': recordTimeStr,  // A 欄
    '電話號碼': phone,         // B 欄
    '中獎獎項': prize,         // C 欄
    // 不寫 D、E
  });
}

/**
 * 查詢 phone 的抽獎紀錄：
 * 回傳時要包含 A(抽獎時間)、B(電話號碼)、C(中獎獎項)、D(到期日)、E(兌獎日期)
 */
async function queryHistory(phone) {
  const sheet = doc.sheetsByTitle['抽獎紀錄'];
  if (!sheet) throw new Error("找不到名為「抽獎紀錄」的工作表");

  const rows = await sheet.getRows();
  const result = [];
  for (const row of rows) {
    if (row['電話號碼'] === phone) {
      result.push({
        time: row['抽獎時間'],       // A 欄
        phone: row['電話號碼'],      // B 欄
        prize: row['中獎獎項'],      // C 欄
        expire: row['到期日'] || '', // D 欄
        claimed: row['兌獎日期'] || '' // E 欄
      });
    }
  }
  return result;
}

// --------------------------------------------------
// 伺服器啟動時初始化
initSheet()
  .then(() => console.log('✅ 已成功載入 Google 試算表'))
  .catch(err => {
    console.error('❌ 初始化失敗：', err);
    // 視需求可 process.exit(1)
  });

// 提供 API 給前端呼叫

/**
 * GET /api/title
 * 取得活動標題
 */
app.get('/api/title', async (req, res) => {
  try {
    const title = await getSettingValue('title');
    res.send(title || '(未設定)');
  } catch (err) {
    console.error(err);
    res.status(500).send('後端錯誤：無法取得標題');
  }
});

/**
 * GET /api/deadline
 * 取得活動截止日 (yyyy-mm-dd)
 */
app.get('/api/deadline', async (req, res) => {
  try {
    const deadline = await getSettingValue('deadline');
    res.send(deadline || '');
  } catch (err) {
    console.error(err);
    res.status(500).send('');
  }
});

/**
 * GET /api/prizes
 * 取得獎項清單 (從「獎項設定」)
 */
app.get('/api/prizes', async (req, res) => {
  try {
    const prizes = await getPrizesData();
    res.json(prizes);
  } catch (err) {
    console.error(err);
    res.status(500).json([]);
  }
});

/**
 * POST /api/check-draw-on-deadline
 * 檢查是否在截止日那天已抽過獎
 */
app.post('/api/check-draw-on-deadline', async (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ error: "No phone provided" });
  }
  try {
    const result = await checkDrawOnDeadline(phone);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Check failed" });
  }
});

/**
 * POST /api/record-draw
 * 寫入抽獎紀錄 (只寫 A/B/C 欄)
 */
app.post('/api/record-draw', async (req, res) => {
  const { phone, prize } = req.body;
  if (!phone || !prize) {
    return res.status(400).send("FAIL");
  }
  try {
    await recordDraw(phone, prize);
    res.send("OK");
  } catch (err) {
    console.error(err);
    res.status(500).send("FAIL");
  }
});

/**
 * POST /api/query-history
 * 查詢中獎紀錄 (回傳 A~E 欄內容)
 */
app.post('/api/query-history', async (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.json([]);
  }
  try {
    const records = await queryHistory(phone);
    res.json(records);
  } catch (err) {
    console.error(err);
    res.status(500).json([]);
  }
});

// 同層目錄若有 index.html，即可直接訪問
app.use(express.static(__dirname));

// 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
