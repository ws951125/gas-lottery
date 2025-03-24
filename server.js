/**************************************************
 * server.js (精簡兩個環境變數版本)
 **************************************************/
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

// 從環境變數讀取
// GOOGLE_SERVICE_ACCOUNT: 整個 Service Account JSON 的內容
// GOOGLE_SHEET_ID: 目標 Sheet ID
const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT || '';
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID || '';

// 解析 Service Account JSON
let clientEmail = '';
let privateKey = '';

try {
  const parsed = JSON.parse(serviceAccountJson);
  clientEmail = parsed.client_email;
  // 若 \n 被轉義，需要再 replace 一次
  // privateKey = parsed.private_key.replace(/\\n/g, '\n'); 
  privateKey = parsed.private_key;
} catch (err) {
  console.error('Service Account JSON parse error:', err);
}

// Google Sheet 表名 (可自行調整)
const SHEET_NAME_PRIZES = '設定';
const SHEET_NAME_RECORD = '紀錄';

// 建立 Express App
const app = express();
app.use(cors());
app.use(express.json());

// 建立 Google Auth
const auth = new google.auth.JWT({
  email: clientEmail,
  key: privateKey,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// 建立 Sheets API Client
const sheets = google.sheets({ version: 'v4', auth });

// ===== 1) 取得獎項與中獎率 =====
app.get('/prizes', async (req, res) => {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME_PRIZES}!A:B`, // A欄獎項, B欄中獎率
    });
    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      return res.json([]); // 沒資料就回傳空陣列
    }

    // 假設第一列是標題，從第二列開始解析
    const prizes = rows.slice(1).map((row) => ({
      name: row[0],
      rate: parseFloat(row[1]) || 0,
    }));

    return res.json(prizes);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch prizes' });
  }
});

// ===== 2) 抽獎 =====
app.post('/draw', async (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ error: '電話號碼必填' });
  }

  try {
    // (a) 檢查電話是否已抽過
    const recordData = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME_RECORD}!A:C`, // A:時間, B:電話, C:獎項
    });

    let records = recordData.data.values || [];
    const dataRows = records.slice(1); // 假設第一列是標題

    let found = dataRows.find((row) => row[1] === phone);
    if (found) {
      // 已抽過 -> 回傳上次抽獎結果
      const drawTime = found[0];
      const prizeName = found[2];
      return res.json({
        alreadyDrawn: true,
        drawTime,
        prizeName,
      });
    }

    // (b) 若未抽過 -> 進行抽獎
    const prizeResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME_PRIZES}!A:B`,
    });
    const prizeRows = prizeResp.data.values;
    if (!prizeRows || prizeRows.length <= 1) {
      return res.status(400).json({ error: '尚未設定任何獎項' });
    }
    const prizes = prizeRows.slice(1).map((row) => ({
      name: row[0],
      rate: parseFloat(row[1]) || 0,
    }));

    // 用加權隨機方式抽出獎項
    const sumRate = prizes.reduce((acc, p) => acc + p.rate, 0);
    let rand = Math.random() * sumRate;
    let selectedPrize = null;
    for (let p of prizes) {
      if (rand < p.rate) {
        selectedPrize = p;
        break;
      }
      rand -= p.rate;
    }
    // 若沒抽到 (例如所有 rate=0)，就預設第 1 項
    if (!selectedPrize) {
      selectedPrize = prizes[0];
    }

    const now = new Date().toISOString();
    const newRecord = [[now, phone, selectedPrize.name]];

    // 寫入紀錄
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME_RECORD}!A:C`,
      valueInputOption: 'RAW',
      requestBody: {
        values: newRecord,
      },
    });

    return res.json({
      alreadyDrawn: false,
      prizeName: selectedPrize.name,
      drawTime: now,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '抽獎失敗，請稍後再試。' });
  }
});

// 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
