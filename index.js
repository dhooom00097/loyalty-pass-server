const express = require('express');
const { PKPass } = require('passkit-generator');
const { v4: uuidv4 } = require('uuid');
const admin = require('firebase-admin');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.set('trust proxy', 1);
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: { error: 'طلبات كثيرة، انتظر قليلاً' } });
const scanLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'طلبات كثيرة' } });
const pinLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 3, message: { error: 'محاولات كثيرة، انتظر 15 دقيقة' } });
app.use('/api/admin', limiter);
app.use('/api/scan', scanLimiter);
app.use('/api/scan-by-code', scanLimiter);
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
    const mCheck = await db.collection('merchants').doc(merchantId).get();
    if (!mCheck.exists || !mCheck.data().active) return res.status(403).json({ error: 'الاشتراك غير فعال' });
    const customerRef = db.collection('customers').doc(customerId);
    const customerDoc = await customerRef.get();
    if (!customerDoc.exists) return res.status(404).json({ error: 'العميل غير موجود' });
    const customer = customerDoc.data();
    if (customer.merchantId !== merchantId) return res.status(403).json({ error: 'هذه البطاقة لتاجر آخر' });
    const STAMPS_REQUIRED = mCheck.data().stampsRequired || 4;
    let newStamps = customer.stamps + 1;
    let giftEarned = false;
    let totalGifts = customer.totalGifts || 0;
    if (newStamps >= STAMPS_REQUIRED) { newStamps = 0; giftEarned = true; totalGifts++; }
    await customerRef.update({ stamps: newStamps, totalGifts, lastVisit: admin.firestore.FieldValue.serverTimestamp() });
    if (customer.pushToken) sendPushToApple(customer.pushToken).catch(console.error);
    res.json({ success: true, name: customer.name, stamps: newStamps, stampsRequired: STAMPS_REQUIRED, giftEarned, totalGifts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/scan-by-code', async (req, res) => {
  try {
    const { code, merchantId } = req.body;
    const mCheck = await db.collection('merchants').doc(merchantId).get();
    if (!mCheck.exists || !mCheck.data().active) return res.status(403).json({ error: 'الاشتراك غير فعال' });
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
    if (customer.pushToken) sendPushToApple(customer.pushToken).catch(console.error);
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
    const lines = wwdrVal.split('\n');     const certLines = certVal.split('\n');     const keyLines = keyVal.split('\n');     // تحميل صور التاجر من Cloudinary
    const passModelPath = path.join(__dirname, 'pass-model.pass');
    
    async function downloadImage(url) {
      return new Promise((resolve, reject) => {
        const https = require('https');
        const http = require('http');
        const client = url.startsWith('https') ? https : http;
        client.get(url, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            return downloadImage(res.headers.location).then(resolve).catch(reject);
          }
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        }).on('error', reject);
      });
    }

    if (merchantDoc.exists) {
      const merchant = merchantDoc.data();
      if (merchant.logoUrl) {
        try {
          const logoData = await downloadImage(merchant.logoUrl);
          const logo2x = await downloadImage(merchant.logoUrl.replace('/upload/', '/upload/w_320,h_100,c_fill/'));
          fs.writeFileSync(path.join(passModelPath, 'logo.png'), logoData);
          fs.writeFileSync(path.join(passModelPath, 'logo@2x.png'), logo2x);
                  } catch(e) { console.log('logo error:', e.message); }
      }
      if (merchant.stripUrl) {
        try {
          const stripData = await downloadImage(merchant.stripUrl);
          const strip2x = await downloadImage(merchant.stripUrl.replace('/upload/', '/upload/w_750,h_288,c_fill/'));
          fs.writeFileSync(path.join(passModelPath, 'strip.png'), stripData);
          fs.writeFileSync(path.join(passModelPath, 'strip@2x.png'), strip2x);
                  } catch(e) { console.log('strip error:', e.message); }
      }
    }

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

app.get('/api/merchant/:merchantId', async (req, res) => {
  try {
    const doc = await db.collection('merchants').doc(req.params.merchantId).get();
    if (!doc.exists) return res.status(404).json({ error: 'غير موجود' });
    const data = doc.data();
    const customersSnap = await db.collection('customers').where('merchantId', '==', req.params.merchantId).get();
    const stampsToday = customersSnap.docs.filter(d => {
      const last = d.data().lastVisit;
      if (!last) return false;
      const today = new Date();
      const visit = last.toDate();
      return visit.toDateString() === today.toDateString();
    }).length;
    res.json({ ...data, customersCount: customersSnap.size, stampsToday });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/merchant/:merchantId', async (req, res) => {
  try {
    const { name, color, stampsRequired, icon } = req.body;
    await db.collection('merchants').doc(req.params.merchantId).update({ name, color, stampsRequired, icon });
    // نرسل push لكل عملاء التاجر
    const customersSnap = await db.collection('customers').where('merchantId', '==', req.params.merchantId).get();
    const pushPromises = [];
    customersSnap.forEach(doc => {
      const customer = doc.data();
      if (customer.pushToken) pushPromises.push(sendPushToApple(customer.pushToken).catch(console.error));
    });
    await Promise.all(pushPromises);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/customer/:customerId', async (req, res) => {
  try {
    const doc = await db.collection('customers').doc(req.params.customerId).get();
    if (!doc.exists) return res.status(404).json({ error: 'غير موجود' });
    res.json(doc.data());
} catch (err) { console.error('PASS ERROR:', err); res.status(500).json({ error: err.message, stack: err.stack }); }});


// قائمة عملاء التاجر
app.get('/api/merchant/:merchantId/customers', async (req, res) => {
  try {
    const pin = req.headers['x-merchant-pin'] || req.query.pin;
    const merchantDoc = await db.collection('merchants').doc(req.params.merchantId).get();
    if (!merchantDoc.exists) return res.status(404).json({ error: 'غير موجود' });
    if (merchantDoc.data().pin && merchantDoc.data().pin !== pin) return res.status(401).json({ error: 'غير مصرح' });
    const snapshot = await db.collection('customers')
      .where('merchantId', '==', req.params.merchantId)
      .get();
    const customers = snapshot.docs.map(doc => {
      const d = doc.data();
      return {
        customerId: doc.id,
        name: d.name,
        phone: d.phone,
        stamps: d.stamps,
        totalGifts: d.totalGifts || 0,
        shortCode: d.shortCode,
        lastVisit: d.lastVisit ? d.lastVisit.toDate() : null,
        createdAt: d.createdAt ? d.createdAt.toDate() : null
      };
    });
    customers.sort((a, b) => (b.lastVisit || 0) - (a.lastVisit || 0));
    res.json(customers);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// استرداد هدية
app.post('/api/redeem', async (req, res) => {
  try {
    const { code, merchantId } = req.body;
    const snapshot = await db.collection('customers')
      .where('shortCode', '==', code)
      .where('merchantId', '==', merchantId)
      .get();
    if (snapshot.empty) return res.status(404).json({ error: 'رقم البطاقة غير موجود' });
    const doc = snapshot.docs[0];
    const customer = doc.data();
    if (!customer.totalGifts || customer.totalGifts < 1) {
      return res.status(400).json({ error: 'لا يوجد رصيد هدايا' });
    }
    const newGifts = customer.totalGifts - 1;
    await db.collection('customers').doc(doc.id).update({
      totalGifts: newGifts,
      lastVisit: admin.firestore.FieldValue.serverTimestamp()
    });
    if (customer.pushToken) sendPushToApple(customer.pushToken).catch(console.error);
    res.json({ success: true, name: customer.name, remainingGifts: newGifts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// التحقق من PIN التاجر
app.post('/api/merchant/:merchantId/verify-pin', pinLimiter, async (req, res) => {
  try {
    const { pin } = req.body;
    const doc = await db.collection('merchants').doc(req.params.merchantId).get();
    if (!doc.exists) return res.status(404).json({ error: 'غير موجود' });
    const merchant = doc.data();
    if (!merchant.pin) return res.status(400).json({ error: 'لم يتم تعيين PIN' });
    if (merchant.pin !== pin) return res.status(401).json({ error: 'PIN غير صحيح' });
    res.json({ success: true, name: merchant.name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/register/:merchantId', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'register.html'));
});

app.get('/merchant/:merchantId', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'merchant-dashboard.html'));
});

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


// إرسال إشعار لكل عملاء التاجر
app.post('/api/merchant/:merchantId/notify', async (req, res) => {
  try {
    const { message, pin } = req.body;
    const merchantDoc = await db.collection('merchants').doc(req.params.merchantId).get();
    if (!merchantDoc.exists) return res.status(404).json({ error: 'التاجر غير موجود' });
    if (merchantDoc.data().pin && merchantDoc.data().pin !== pin) return res.status(401).json({ error: 'PIN غير صحيح' });
    if (!message) return res.status(400).json({ error: 'الرسالة مطلوبة' });
    
    const customersSnap = await db.collection('customers').where('merchantId', '==', req.params.merchantId).get();
    let sent = 0;
    const promises = [];
    customersSnap.forEach(doc => {
      const customer = doc.data();
      if (customer.pushToken) {
        promises.push(sendPushToApple(customer.pushToken, message).catch(console.error));
        sent++;
      }
    });
    await Promise.all(promises);
    res.json({ success: true, sent });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== Apple Wallet Push Notification Endpoints =====

// تسجيل جهاز العميل
app.post('/v1/devices/:deviceId/registrations/:passType/:serial', async (req, res) => {
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
async function sendPushToApple(pushToken, message = null) {
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

      req.write(JSON.stringify(message ? { aps: { alert: message, sound: 'default' } } : {}));
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
    res.status(200).send();
});


// ===== Cloudinary Image Upload =====
const cloudinary = require('cloudinary').v2;
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME ,
  api_key: process.env.CLOUDINARY_API_KEY ,
  api_secret: process.env.CLOUDINARY_API_SECRET 
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// رفع لوجو التاجر
app.post('/api/merchant/:merchantId/upload-logo', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'لا يوجد ملف' });
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'loyalty/logos', public_id: req.params.merchantId + '_logo', overwrite: true, width: 160, height: 50, crop: 'fill' },
        (error, result) => error ? reject(error) : resolve(result)
      );
      stream.end(req.file.buffer);
    });
    await db.collection('merchants').doc(req.params.merchantId).update({ logoUrl: result.secure_url });
    res.json({ url: result.secure_url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// رفع صورة strip للبطاقة
app.post('/api/merchant/:merchantId/upload-strip', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'لا يوجد ملف' });
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'loyalty/strips', public_id: req.params.merchantId + '_strip', overwrite: true, width: 750, height: 288, crop: 'fill' },
        (error, result) => error ? reject(error) : resolve(result)
      );
      stream.end(req.file.buffer);
    });
    await db.collection('merchants').doc(req.params.merchantId).update({ stripUrl: result.secure_url });
    res.json({ url: result.secure_url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== ADMIN PANEL =====
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'admin-super-secret-2024';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@loyalty.com';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync('Admin@2024!', 10);

// Middleware تحقق من الـ JWT
function adminAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'غير مصرح' });
  try {
    const decoded = jwt.verify(auth.split(' ')[1], ADMIN_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'token منتهي أو غير صحيح' });
  }
}

// تسجيل دخول Admin
app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (email !== ADMIN_EMAIL) return res.status(401).json({ error: 'بيانات غلط' });
    const valid = bcrypt.compareSync(password, ADMIN_PASSWORD_HASH);
    if (!valid) return res.status(401).json({ error: 'بيانات غلط' });
    const token = jwt.sign({ email, role: 'admin' }, ADMIN_SECRET, { expiresIn: '24h' });
    res.json({ token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// إضافة تاجر جديد
app.post('/api/admin/merchants', adminAuth, async (req, res) => {
  try {
    const { name, phone, color, stampsRequired, subscriptionPrice, subscriptionDate } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'اسم ورقم الجوال مطلوبان' });
    const merchantId = uuidv4();
    const merchantData = {
      merchantId,
      name,
      phone,
      color: color || 'rgb(133, 17, 9)',
      stampsRequired: stampsRequired || 4,
      subscriptionPrice: subscriptionPrice || 0,
      subscriptionDate: subscriptionDate || new Date().toISOString(),
      subscriptionExpiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      active: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    await db.collection('merchants').doc(merchantId).set(merchantData);
    res.json({ merchantId, ...merchantData });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// قائمة التجار
app.get('/api/admin/merchants', adminAuth, async (req, res) => {
  try {
    const snapshot = await db.collection('merchants').get();
    const merchants = [];
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const customersSnap = await db.collection('customers').where('merchantId', '==', doc.id).get();
      merchants.push({ ...data, customersCount: customersSnap.size });
    }
    res.json(merchants);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// تعديل تاجر
app.put('/api/admin/merchants/:merchantId', adminAuth, async (req, res) => {
  try {
    const { merchantId } = req.params;
    const updates = req.body;
    await db.collection('merchants').doc(merchantId).update(updates);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// تفعيل/إيقاف تاجر
app.patch('/api/admin/merchants/:merchantId/toggle', adminAuth, async (req, res) => {
  try {
    const { merchantId } = req.params;
    const doc = await db.collection('merchants').doc(merchantId).get();
    if (!doc.exists) return res.status(404).json({ error: 'التاجر غير موجود' });
    const newStatus = !doc.data().active;
    await db.collection('merchants').doc(merchantId).update({ active: newStatus });
    res.json({ active: newStatus });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// إحصائيات عامة
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const merchants = await db.collection('merchants').get();
    const customers = await db.collection('customers').get();
    const activeMerchants = merchants.docs.filter(d => d.data().active).length;
    res.json({
      totalMerchants: merchants.size,
      activeMerchants,
      totalCustomers: customers.size
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== Google Wallet =====
const { GoogleAuth } = require('google-auth-library');

const GOOGLE_ISSUER_ID = '3388000000023152531';

function getGoogleAuth() {
  const keyFile = '/etc/secrets/google-service-account.json';
  return new GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/wallet_object.issuer']
  });
}

app.get('/api/google-pass/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const customerDoc = await db.collection('customers').doc(customerId).get();
    if (!customerDoc.exists) return res.status(404).json({ error: 'العميل غير موجود' });
    const customer = customerDoc.data();

    const merchantDoc = await db.collection('merchants').doc(customer.merchantId).get();
    const merchantName = merchantDoc.exists ? merchantDoc.data().name : 'بطاقة الولاء';
    const stampsRequired = merchantDoc.exists ? (merchantDoc.data().stampsRequired || 4) : 4;

    const classId = `${GOOGLE_ISSUER_ID}.loyalty_class`;
    const objectId = `${GOOGLE_ISSUER_ID}.${customerId}`;

    const auth = getGoogleAuth();
    const client = await auth.getClient();

    // إنشاء أو تحديث الـ Class
    try {
      await client.request({
        url: `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyClass/${classId}`,
        method: 'GET'
      });
    } catch (e) {
      await client.request({
        url: 'https://walletobjects.googleapis.com/walletobjects/v1/loyaltyClass',
        method: 'POST',
        data: {
          id: classId,
          issuerName: merchantName,
          programName: 'بطاقة الولاء',
          programLogo: { sourceUri: { uri: 'https://www.gstatic.com/images/branding/product/2x/googleg_48dp.png' } },
          reviewStatus: 'UNDER_REVIEW'
        }
      });
    }

    // إنشاء أو تحديث الـ Object
    const loyaltyObject = {
      id: objectId,
      classId,
      state: 'ACTIVE',
      accountId: customer.shortCode || customerId,
      accountName: customer.name,
      loyaltyPoints: {
        label: 'الختمات',
        balance: { int: customer.stamps || 0 }
      },
      textModulesData: [
        { header: 'متبقي للهدية', body: String(stampsRequired - (customer.stamps || 0)) },
        { header: 'هدايا مستلمة', body: String(customer.totalGifts || 0) }
      ],
      barcode: { type: 'QR_CODE', value: customerId }
    };

    try {
      await client.request({
        url: `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/${objectId}`,
        method: 'PUT',
        data: loyaltyObject
      });
    } catch (e) {
      await client.request({
        url: 'https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject',
        method: 'POST',
        data: loyaltyObject
      });
    }

    // توليد JWT
    const jwtPayload = {
      iss: (await auth.getCredentials()).client_email,
      aud: 'google',
      typ: 'savetowallet',
      payload: { loyaltyObjects: [{ id: objectId }] }
    };

    const token = require('jsonwebtoken').sign(jwtPayload, (await auth.getCredentials()).private_key, { algorithm: 'RS256' });
    const saveUrl = `https://pay.google.com/gp/v/save/${token}`;

    res.json({ saveUrl });
  } catch (err) {
    console.error('Google Wallet Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
