// server.js
import express from 'express';
import cors from 'cors';
import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SERVICE_ACCOUNT = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

const auth = new google.auth.GoogleAuth({
  credentials: SERVICE_ACCOUNT,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

const SHEET_NAMES = {
  title: '設定',
  deadline: '設定',
  prizes: '獎項',
  record: '抽獎紀錄',
  history: '歷史紀錄',
};

// 取得活動標題
app.get('/api/title', async (req, res) => {
  try {
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAMES.title}!B2`,
    });
    res.json(result.data.values[0][0]);
  } catch (err) {
    console.error('Error fetching title:', err);
    res.status(500).send('Error fetching title');
  }
});

// 取得截止日期
app.get('/api/deadline', async (req, res) => {
  try {
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAMES.deadline}!B3`,
    });
    res.json(result.data.values[0][0]);
  } catch (err) {
    console.error('Error fetching deadline:', err);
    res.status(500).send('Error fetching deadline');
  }
});

// 取得獎項清單
app.get('/api/prizes', async (req, res) => {
  try {
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAMES.prizes}!A2:B`,
    });
    const prizes = result.data.values.map(row => ({ name: row[0], rate: row[1] }));
    res.json(prizes);
  } catch (err) {
    console.error('Error fetching prizes:', err);
    res.status(500).send('Error fetching prizes');
  }
});

// 檢查當日是否已抽獎
app.post('/api/checkDrawOnDeadline', async (req, res) => {
  const { phone } = req.body;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAMES.record}!A2:D`,
    });
    const rows = result.data.values || [];
    const found = rows.find(row => row[0] === phone && row[1]?.startsWith(today));
    if (found) {
      res.json({ exists: true, time: found[1], prize: found[2] });
    } else {
      res.json({ exists: false });
    }
  } catch (err) {
    console.error('Error checking record:', err);
    res.status(500).send('Error checking draw record');
  }
});

// 寫入抽獎紀錄
app.post('/api/recordDraw', async (req, res) => {
  const { phone, prize } = req.body;
  try {
    const now = new Date();
    const nowStr = now.toLocaleString('zh-TW', { hour12: false });
    const expire = new Date(now);
    expire.setDate(now.getDate() + 6);
    const expireStr = expire.toISOString().split('T')[0];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAMES.record}!A:D`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[phone, nowStr, prize, expireStr]]
      }
    });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAMES.history}!A:E`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[nowStr, phone, prize, expireStr, '']]
      }
    });
    res.send('OK');
  } catch (err) {
    console.error('Error recording draw:', err);
    res.status(500).send('Error recording draw');
  }
});

// 查詢中獎紀錄
app.get('/api/history', async (req, res) => {
  const phone = req.query.phone;
  try {
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAMES.history}!A2:E`,
    });
    const rows = result.data.values || [];
    const matched = rows.filter(row => row[1] === phone);
    const history = matched.map(row => ({
      time: row[0],
      prize: row[2],
      expire: row[3],
      claimed: row[4] || ''
    }));
    res.json(history);
  } catch (err) {
    console.error('Error querying history:', err);
    res.status(500).send('Error querying history');
  }
});

app.listen(PORT, () => {
  console.log(`🎯 Lottery backend running on port ${PORT}`);
});
