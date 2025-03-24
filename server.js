/****************************************************
 * server.js - 使用「獎項設定」「抽獎紀錄」「設定」 三個工作表
 *    儲存與讀取抽獎資料；相容 Node.js 10+ (無頂層 await)
 *
 * 需設定 2 個環境變數：
 *   - GOOGLE_SERVICE_ACCOUNT（整段 JSON 字串）
 *   - GOOGLE_SHEET_ID（試算表 ID）
 ****************************************************/

const express = require('express');
const bodyParser = require('body-parser');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();
app.use(bodyParser.json());

// 從環境變數讀取
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// 解析 Service Account JSON （含 private_key）
let serviceAccount;
try {
  serviceAccount = JSON.parse(SERVICE_ACCOUNT_JSON);
  // 將 private_key 內的 '\\n' 轉成真正的換行 (若還是多行就可省略這步)
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }
} catch (err) {
  console.error('無法解析 GOOGLE_SERVICE_ACCOUNT：', err);
}

// 建立 GoogleSpreadsheet 實例
const doc = new GoogleSpreadsheet(SHEET_ID);

/**
 * 用 async function 包裝初始化流程 (Node 10.x 不允許頂層 await)
 */
async function initSheet() {
  if (!serviceAccount || !serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error('Service Account JSON 格式不正確，請確認環境變數。');
  }
  await doc.useServiceAccountAuth({
    client_email: serviceAccount.client_email,
    private_key: serviceAccount.private_key,
  });
  await doc.loadInfo();
  console.log('✅ 已成功載入 Google 試算表');
}

/**
 * 從「設定」工作表中取出指定 name 的 value
 */
async function getSettingValue(name) {
  const sheet = doc.sheetsByTitle['設定'];
  if (!sheet) throw new Error("找不到名為「設定」的工作表");
  const rows = await sheet.getRows();
  const row = rows.find(r => r.name === name);
  return row ? row.value : '';
}

/**
 * 從「獎項設定」工作表讀取獎項列表
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
 * 檢查是否在 deadline 那天已經抽過獎
 */
async function checkDrawOnDeadline(phone) {
  const sheet = doc.sheetsByTitle['抽獎紀錄'];
  if (!sheet) throw new Error("找不到名為「抽獎紀錄」的工作表");

  const deadline = await getSettingValue('deadline');
  if (!deadline) {
    return { exists: false };
  }
  // 以 yyyy-mm-ddT00:00:00 解析
  const dlDate = new Date(deadline + 'T00:00:00');
  const dlStr = dlDate.toISOString().split('T')[0];

  const rows = await sheet.getRows();
  for (const row of rows) {
    if (row['電話號碼'] === phone) {
      const drawTimeStr = row['抽獎時間'];
      if (!drawTimeStr) continue;

      const parsedDate = new Date(drawTimeStr);
      if (isNaN(parsedDate.getTime())) continue; // 無法解析就略過

      const recordStr = parsedDate.toISOString().split('T')[0];
      if (recordStr === dlStr) {
        return {
          exists: true,
          time: row['抽獎時間'],
          prize: row['中獎獎項'],
        };
      }
    }
  }
  return { exists: false };
}

/**
 * 寫入抽獎紀錄到「抽獎紀錄」工作表
 * 只寫 A(抽獎時間)、B(電話號碼)、C(中獎獎項) 欄位
 */
async function recordDraw(phone, prize) {
  const sheet = doc.sheetsByTitle['抽獎紀錄'];
  if (!sheet) throw new Error("找不到名為「抽獎紀錄」的工作表");

  const now = new Date();
  const recordTimeStr = now.toLocaleString('zh-TW', { hour12: false });

  await sheet.addRow({
    '抽獎時間': recordTimeStr,
    '電話號碼': phone,
    '中獎獎項': prize,
    // D(到期日), E(兌獎日期) 留空
  });
}

/**
 * 查詢紀錄：回傳 A(抽獎時間)、B(電話號碼)、C(中獎獎項)、D(到期日)、E(兌獎日期)
 */
async function queryHistory(phone) {
  const sheet = doc.sheetsByTitle['抽獎紀錄'];
  if (!sheet) throw new Error("找不到名為「抽獎紀錄」的工作表");

  const rows = await sheet.getRows();
  return rows
    .filter(r => r['電話號碼'] === phone)
    .map(r => ({
      time: r['抽獎時間'] || '',
      phone: r['電話號碼'] || '',
      prize: r['中獎獎項'] || '',
      expire: r['到期日'] || '',
      claimed: r['兌獎日期'] || ''
    }));
}

// =============================================
// 先配置好 API 路由
/**
 * GET /api/title
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

// 如果您要同一支服務提供前端 index.html，也可以這樣做：
// app.use(express.static(__dirname));

// =============================================
// 用非同步函式啟動 + 伺服器監聽
initSheet()
  .then(() => {
    // 等待試算表初始化成功後再啟動
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ 初始化 Google Sheet 失敗：', err);
    process.exit(1); // 視需求可結束程式
  });
