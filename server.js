/****************************************************
 * server.js - 分開儲存 client_email / private_key
 *   使用三個工作表：
 *     - 獎項設定: name, rate
 *     - 抽獎紀錄: A=抽獎時間, B=電話號碼, C=中獎獎項, D=到期日, E=兌獎日期
 *     - 設定: name, value (包含 title / deadline)
 *
 * 環境變數需設：
 *   - GOOGLE_CLIENT_EMAIL (e.g. lottery-service@xxx.iam.gserviceaccount.com)
 *   - GOOGLE_PRIVATE_KEY  (帶整個 PEM)
 *   - GOOGLE_SHEET_ID     (您的試算表ID)
 ****************************************************/

const express = require('express');
const bodyParser = require('body-parser');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const cors = require('cors');

const app = express();
app.use(bodyParser.json());


//app.use(cors());  //所有網域都可以連
app.use(cors({ origin: 'https://pro6899.onrender.com' })); //限制網域可連


// 從環境變數讀取：email / private_key / sheetId
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
let PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// 如果 Render 後台把真正換行變成 \n，您可再 replace 回來
// （若本身就已經是多行 PEM，則可省略這行）
if (PRIVATE_KEY) {
  PRIVATE_KEY = PRIVATE_KEY.replace(/\\n/g, '\n');
}

// 建立 GoogleSpreadsheet 實例
const doc = new GoogleSpreadsheet(SHEET_ID);

/**
 * 初始化 Google Sheet (Node.js 10.x 不允許頂層 await，所以用函式包裝)
 */
async function initSheet() {
  if (!CLIENT_EMAIL || !PRIVATE_KEY) {
    throw new Error('缺少 GOOGLE_CLIENT_EMAIL 或 GOOGLE_PRIVATE_KEY');
  }

  await doc.useServiceAccountAuth({
    client_email: CLIENT_EMAIL,
    private_key: PRIVATE_KEY,
  });
  await doc.loadInfo();
  console.log('✅ 已成功載入 Google 試算表：', doc.title);
}

/**
 * 讀取「設定」表中指定 name 的 value
 */
async function getSettingValue(name) {
  const sheet = doc.sheetsByTitle['設定'];
  if (!sheet) throw new Error("找不到名為「設定」的工作表");

  const rows = await sheet.getRows();
  // ✅ 如果原本是 r.name === name，就得改成 r["項目"] === name
  const row = rows.find(r => r["項目"] === name);

  // ✅ 回傳 r["設定值"] 而非 r.value
  return row ? row["設定值"] : '';
}



/**
 * 讀取「獎項設定」表的獎項 (name, rate)
 */
async function getPrizesData() {
  const sheet = doc.sheetsByTitle['獎項設定'];
  if (!sheet) throw new Error("找不到名為「獎項設定」的工作表");
  const rows = await sheet.getRows();
  return rows.map(r => ({
    name: r['獎項名稱'],
    rate: r['中獎率'] || '0',
  }));
}

/**
 * 檢查是否在 deadline 那天已經抽過獎 (抽獎紀錄)
 */
async function checkDrawOnDeadline(phone) {
  const sheet = doc.sheetsByTitle['抽獎紀錄'];
  if (!sheet) throw new Error("找不到名為「抽獎紀錄」的工作表");

  const normalizedPhone = normalizePhone(phone);

  const deadline = await getSettingValue('活動截止日');
  if (!deadline) {
    return { exists: false };
  }
  const dlDate = new Date(deadline + 'T00:00:00');
  const dlStr = dlDate.toISOString().split('T')[0];

  const rows = await sheet.getRows();
  for (const row of rows) {
    // 以正規化後的號碼比對
    if (row['電話號碼'] === normalizedPhone) {
      const drawTimeStr = row['抽獎時間'];
      if (!drawTimeStr) continue;

      const parsedDate = new Date(drawTimeStr);
      if (isNaN(parsedDate.getTime())) continue;

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
 * 寫入抽獎紀錄 (只寫 A/B/C 三欄)
 */
function normalizePhone(phone) {
  // 移除前面所有 0
  return phone.replace(/^0+/, '');
}

async function recordDraw(phone, prize) {
  const sheet = doc.sheetsByTitle['抽獎紀錄'];
  if (!sheet) throw new Error("找不到名為「抽獎紀錄」的工作表");

  const now = new Date();
  const recordTimeStr = now.toISOString();

  const normalizedPhone = normalizePhone(phone);

  await sheet.addRow({
    '抽獎時間': recordTimeStr,
    '電話號碼': normalizedPhone,
    '中獎獎項': prize
  });
}

/**
 * 查詢指定 phone 的紀錄 (回傳 A~E 欄)
 */
async function queryHistory(phone) {
  const sheet = doc.sheetsByTitle['抽獎紀錄'];
  if (!sheet) throw new Error("找不到名為「抽獎紀錄」的工作表");

  const rows = await sheet.getRows();
  
  const normalizedPhone = phone.replace(/^0+/, '');
  
  return rows
    .filter(r => r['電話號碼'] === normalizedPhone)
    .map(r => ({
      time: r['抽獎時間'] || '',
      phone: r['電話號碼'] || '',
      prize: r['中獎獎項'] || '',
      expire: r['到期日'] || '',
      claimed: r['兌獎日期'] || ''
    }));
}

/******************************************
 * 下方為 Express 路由
 ******************************************/
app.get('/api/title', async (req, res) => {
  try {
    const title = await getSettingValue('抽獎活動標題');
    res.send(title || '(未設定)');
  } catch (err) {
    console.error(err);
    res.status(500).send('後端錯誤：無法取得標題');
  }
});

app.get('/api/deadline', async (req, res) => {
  try {
    const deadline = await getSettingValue('活動截止日');
    res.send(deadline || '');
  } catch (err) {
    console.error(err);
    res.status(500).send('');
  }
});

app.get('/api/prizes', async (req, res) => {
  try {
    const prizes = await getPrizesData();
    res.json(prizes);
  } catch (err) {
    console.error(err);
    res.status(500).json([]);
  }
});

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

// server.js 範例 (部分)
app.get('/api/activity-description', async (req, res) => {
  try {
    // 使用 getSettingValue('活動說明')
    const description = await getSettingValue('活動說明');
    // 回傳給前端
    res.send(description || '');
  } catch (err) {
    console.error(err);
    res.status(500).send('');
  }
});


// 若要在同一服務中提供 index.html，也可：
// app.use(express.static(__dirname));

// 初始化並啟動
async function startServer() {
  try {
    await initSheet(); // 完成 Google Sheet 驗證 & 載入
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (err) {
    console.error('初始化 Google Sheet 失敗：', err);
    process.exit(1);
  }
}
startServer();
