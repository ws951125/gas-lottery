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

  // 從「設定」表抓取「活動截止日」(可能是 "2025/3/25" 或 "2025/03/25"...)
  const deadlineRaw = await getSettingValue('活動截止日');
  if (!deadlineRaw) {
    return { exists: false };
  }

  // 先用 new Date(...) 解析，再轉成同樣的台灣日期格式 "YYYY/MM/DD"
  const deadlineDate = new Date(deadlineRaw); 
  if (isNaN(deadlineDate.getTime())) {
    // 如果解析失敗，直接視為沒有截止日
    return { exists: false };
  }
  const dlStr = deadlineDate.toLocaleDateString('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // dlStr 例如 "2025/03/25"

  // 讀取「抽獎紀錄」的所有列
  const rows = await sheet.getRows();
  for (const row of rows) {
    if (row['電話號碼'] === normalizedPhone) {
      // 假設您剛剛只存 "2025/03/25"；沒有時分秒
      const drawDateStr = row['抽獎時間'];
      if (!drawDateStr) continue;

      // 直接用字串比對：只要同一天就視為已抽過
      if (drawDateStr === dlStr) {
        return {
          exists: true,
          time: drawDateStr,         // "2025/03/25"
          prize: row['中獎獎項'],
        };
      }
    }
  }
  return { exists: false };
}

  // 讀取「抽獎紀錄」的所有列
  const rows = await sheet.getRows();
  for (const row of rows) {
    if (row['電話號碼'] === normalizedPhone) {
      const drawDateStr = row['抽獎時間']; 
      if (!drawDateStr) continue;

      // ★ 直接用字串比對：只要同一天就視為已抽過
      if (drawDateStr === dlStr) {
        return {
          exists: true,
          time: row['抽獎時間'], // 這裡就是 '2025-03-25'
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
  // 使用台灣時區轉換，並產生固定格式的時間字串
  const recordTimeStr = new Date().toLocaleDateString('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  

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

  const normalizedPhone = normalizePhone(phone);

  const rows = await sheet.getRows();
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



function parseAndFormatAsYYYYMMDD(str) {
  // 嘗試用 new Date() 先把字串解析出來（如果表格是 2025/3/25、2025/03/25 或 2025-03-25 都能解析）
  // 然後再用 getTaiwanDateString() 轉成 YYYY-MM-DD (台灣日期)
  const tempDate = new Date(str);
  if (isNaN(tempDate.getTime())) {
    // 如果真的解析失敗，就回傳空字串或直接 throw error
    return '';
  }
  return getTaiwanDateString(tempDate);
}


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
