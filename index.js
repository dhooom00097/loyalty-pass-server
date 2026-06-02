const express = require('express');
const { PKPass } = require('passkit-generator');
const { v4: uuidv4 } = require('uuid');
const admin = require('firebase-admin');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Firebase - يقرأ من Environment Variable أو من الملف
let firebaseConfig;
if (process.env.FIREBASE_KEY_BASE64) {
  firebaseConfig = JSON.parse(Buffer.from(process.env.FIREBASE_KEY_BASE64, 'base64').toString());
} else {
  firebaseConfig = require('./firebase-key.json');
}
admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
const db = admin.firestore();

// الشهادات
function getCert(envVar, filePath) {
  const secretPath = '/etc/secrets/' + path.basename(filePath);
  if (fs.existsSync(secretPath)) {
    return fs.readFileSync(secretPath, 'utf8');
  }
  if (process.env[envVar]) {
    return Buffer.from(process.env[envVar], 'base64').toString('utf8');
  }
  return fs.readFileSync(path.join(__dirname, filePath), 'utf8');
}

const PASS_TYPE_ID = 'pass.com.alharbi.loyalty';
const TEAM_ID = 'VGKLVKKXX6';
const STAMPS_REQUIRED = 4;

app.post('/api/register', async (req, res) => {
  try {
    const { phone, name, merchantId } = req.body;
    if (!phone || !name || !merchantId) return res.status(400).json({ error: 'بيانات ناقصة' });
    const existing = await db.collection('customers').where('phone', '==', phone).where('merchantId', '==', merchantId).get();
    if (!existing.empty) {
      const doc = existing.docs[0];
      const data = doc.data();
      if (!data.shortCode) {
        const shortCode = Math.floor(1000000 + Math.random() * 9000000).toString();
        await db.collection('customers').doc(doc.id).update({ shortCode });
        data.shortCode = shortCode;
      }
      return res.json({ customerId: doc.id, ...data, exists: true });
    }
    const customerId = uuidv4();
    const shortCode = Math.floor(1000000 + Math.random() * 9000000).toString();
    const customerData = { customerId, phone, name, merchantId, stamps: 0, totalGifts: 0, shortCode, authToken: "loyalty2024secure", createdAt: admin.firestore.FieldValue.serverTimestamp() };
    await db.collection('customers').doc(customerId).set(customerData);
    res.json({ customerId, ...customerData, exists: false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/scan', async (req, res) => {
  try {
    const { customerId, merchantId } = req.body;
    if (!customerId || !merchantId) return res.status(400).json({ error: 'بيانات ناقصة' });
    const customerRef = db.collection('customers').doc(customerId);
    const customerDoc = await customerRef.get();
    if (!customerDoc.exists) return res.status(404).json({ error: 'العميل غير موجود' });
    const customer = customerDoc.data();
    if (customer.merchantId !== merchantId) return res.status(403).json({ error: 'هذه البطاقة لتاجر آخر' });
    let newStamps = customer.stamps + 1;
    let giftEarned = false;
    let totalGifts = customer.totalGifts || 0;
    if (newStamps >= STAMPS_REQUIRED) { newStamps = 0; giftEarned = true; totalGifts += 1; }
    await customerRef.update({ stamps: newStamps, totalGifts, lastVisit: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true, name: customer.name, stamps: newStamps, stampsRequired: STAMPS_REQUIRED, giftEarned, totalGifts });
    if (customer.pushToken) sendPushToApple(customer.pushToken).catch(console.error);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/scan-by-code', async (req, res) => {
  try {
    const { code, merchantId } = req.body;
    const snapshot = await db.collection('customers').where('shortCode', '==', code).where('merchantId', '==', merchantId).get();
    if (snapshot.empty) return res.status(404).json({ error: 'رقم البطاقة غير موجود' });
    const doc = snapshot.docs[0];
    const customerRef = db.collection('customers').doc(doc.id);
    const customer = doc.data();
    let newStamps = customer.stamps + 1;
    let giftEarned = false;
    let totalGifts = customer.totalGifts || 0;
    if (newStamps >= STAMPS_REQUIRED) { newStamps = 0; giftEarned = true; totalGifts += 1; }
    await customerRef.update({ stamps: newStamps, totalGifts, lastVisit: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true, name: customer.name, stamps: newStamps, stampsRequired: STAMPS_REQUIRED, giftEarned, totalGifts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/pass/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const customerDoc = await db.collection('customers').doc(customerId).get();
    if (!customerDoc.exists) return res.status(404).json({ error: 'العميل غير موجود' });
    const customer = customerDoc.data();
    const merchantDoc = await db.collection('merchants').doc(customer.merchantId).get();
    const merchantName = merchantDoc.exists ? merchantDoc.data().name : 'بطاقة الولاء';
    const merchantColor = merchantDoc.exists ? merchantDoc.data().color : 'rgb(133, 17, 9)';
    const stampsText = `${customer.stamps} من ${STAMPS_REQUIRED}`;
    const remaining = STAMPS_REQUIRED - customer.stamps;

    const wwdrVal = getCert('WWDR_BASE64', 'wwdr.pem');
    const certVal = getCert('SIGNER_CERT_BASE64', 'signerCert.pem');
    const keyVal = getCert('SIGNER_KEY_BASE64', 'signerKey.pem');
    console.log('WWDR type:', typeof wwdrVal, JSON.stringify(wwdrVal.substring(0,50)));
const lines = wwdrVal.split('\n'); console.log('WWDR lines:', lines.length, 'first:', lines[0], 'last:', lines[lines.length-1]);
    const certLines = certVal.split('\n'); console.log('CERT lines:', certLines.length, 'first:', certLines[0]);
    const keyLines = keyVal.split('\n'); console.log('KEY lines:', keyLines.length, 'first:', keyLines[0]);
    const pass = await PKPass.from({
      model: path.join(__dirname, 'pass-model.pass'),
      certificates: {
        wwdr: wwdrVal,
        signerCert: certVal,
        signerKey: keyVal,
        signerKeyPassphrase: process.env.SIGNER_KEY_PASSPHRASE || 'Aa112233'
      }
    }, {
      serialNumber: customerId,
      description: 'بطاقة الولاء',
      backgroundColor: merchantColor,
      foregroundColor: 'rgb(245, 196, 122)',
      labelColor: 'rgb(245, 196, 122)',
      logoText: merchantName,
      webServiceURL: process.env.SERVICE_URL || 'https://loyalty-pass-server.onrender.com',
      authenticationToken: 'loyalty2024secure'
    });

    pass.primaryFields.push({ key: 'balance', label: 'الختمات', value: stampsText });
    pass.secondaryFields.push({ key: 'name', label: 'مرحباً', value: customer.name });
    pass.secondaryFields.push({ key: 'remaining', label: 'متبقي للهدية', value: String(remaining) });
    pass.auxiliaryFields.push({ key: 'gifts', label: 'هدايا مستلمة', value: String(customer.totalGifts || 0) });
    pass.auxiliaryFields.push({ key: 'code', label: 'رقم البطاقة', value: customer.shortCode || '' });
    pass.setBarcodes({ message: customerId, format: 'PKBarcodeFormatQR', messageEncoding: 'iso-8859-1' });

    const buffer = pass.getAsBuffer();
    res.set({ 'Content-Type': 'application/vnd.apple.pkpass', 'Content-Transfer-Encoding': 'binary', 'Last-Modified': new Date().toUTCString(), 'Content-Disposition': 'attachment; filename="loyalty.pkpass"' });
    res.send(buffer);
  } catch (err) { console.error('PASS ERROR FULL:', JSON.stringify({msg: err.message, stack: err.stack, name: err.name})); res.status(500).json({ error: err.message }); }
});

app.post('/api/merchant/register', async (req, res) => {
  try {
    const { name, color, stampsRequired } = req.body;
    const merchantId = uuidv4();
    await db.collection('merchants').doc(merchantId).set({ merchantId, name: name || 'كافيه', color: color || 'rgb(133, 17, 9)', stampsRequired: stampsRequired || 4, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ merchantId, name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/customer/:customerId', async (req, res) => {
  try {
    const doc = await db.collection('customers').doc(req.params.customerId).get();
    if (!doc.exists) return res.status(404).json({ error: 'غير موجود' });
    res.json(doc.data());
} catch (err) { console.error('PASS ERROR:', err); res.status(500).json({ error: err.message, stack: err.stack }); }});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ السيرفر شغال على http://localhost:${PORT}`));

app.get('/api/debug-certs', (req, res) => {
  try {
    const wwdr = getCert('WWDR_BASE64', 'wwdr.pem').toString().substring(0, 30);
    const cert = getCert('SIGNER_CERT_BASE64', 'signerCert.pem').toString().substring(0, 30);
    const key = getCert('SIGNER_KEY_BASE64', 'signerKey.pem').toString().substring(0, 30);
    res.json({ wwdr, cert, key });
  } catch(e) { res.json({ error: e.message }); }
});

// ===== Apple Wallet Push Notification Endpoints =====

// تسجيل جهاز العميل
app.post('/v1/devices/:deviceId/registrations/:passType/:serial', async (req, res) => {
  console.log('DEVICE REGISTER:', req.params, req.body, req.headers.authorization);
  try {
    const { deviceId, serial } = req.params;
    const { pushToken } = req.body;
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('ApplePass ')) {
      return res.status(401).send();
    }

    await db.collection('devices').doc(deviceId).set({
      deviceId,
      pushToken,
      serial,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await db.collection('customers').doc(serial).update({
      deviceId,
      pushToken,
      authToken: 'loyalty2024'
    });

    res.status(201).send();
  } catch (err) {
    console.error('Register device error:', err.message);
    res.status(500).send();
  }
});

// إرجاع الـ pass المحدث
app.get('/v1/passes/:passType/:serial', async (req, res) => {
  try {
    const { serial } = req.params;
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('ApplePass ')) {
      return res.status(401).send();
    }

    res.redirect(`/api/pass/${serial}`);
  } catch (err) {
    res.status(500).send();
  }
});

// حذف تسجيل الجهاز
app.delete('/v1/devices/:deviceId/registrations/:passType/:serial', async (req, res) => {
  try {
    const { deviceId } = req.params;
    await db.collection('devices').doc(deviceId).delete();
    res.status(200).send();
  } catch (err) {
    res.status(500).send();
  }
});

// قائمة الـ passes المحدثة
app.get('/v1/devices/:deviceId/registrations/:passType', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const deviceDoc = await db.collection('devices').doc(deviceId).get();
    if (!deviceDoc.exists) return res.status(404).send();
    const { serial } = deviceDoc.data();
    res.json({ serialNumbers: [serial], lastUpdated: new Date().toISOString() });
  } catch (err) {
    res.status(500).send();
  }
});

// ===== إرسال Push Notification لـ Apple =====
async function sendPushToApple(pushToken) {
  try {
    const http2 = require('http2');
    const cert = getCert('SIGNER_CERT_BASE64', 'signerCert.pem');
    const key = getCert('SIGNER_KEY_BASE64', 'signerKey.pem');

    const client = http2.connect('https://api.push.apple.com', { cert, key });

    return new Promise((resolve, reject) => {
      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${pushToken}`,
        'apns-topic': 'pass.com.alharbi.loyalty',
        'apns-push-type': 'background',
        'content-type': 'application/json'
      });

      req.write(JSON.stringify({}));
      req.end();

      req.on('response', (headers) => {
        console.log('Push sent, status:', headers[':status']);
        client.close();
        resolve();
      });

      req.on('error', (err) => {
        console.error('Push error:', err.message);
        client.close();
        reject(err);
      });
    });
  } catch (err) {
    console.error('Push setup error:', err.message);
  }
}

// Apple Wallet log endpoint
app.post('/v1/log', (req, res) => {
  console.log('Apple Wallet Log:', JSON.stringify(req.body));
  res.status(200).send();
});
