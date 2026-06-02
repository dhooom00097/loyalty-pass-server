const express = require('express');
const { PKPass } = require('passkit-generator');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const admin = require('firebase-admin');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const serviceAccount = require('./firebase-key.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

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
      return res.json({ customerId: doc.id, ...doc.data(), exists: true });
    }
    const customerId = uuidv4();
    const customerData = { customerId, phone, name, merchantId, stamps: 0, totalGifts: 0, createdAt: admin.firestore.FieldValue.serverTimestamp() };
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
    const passJson = {
      formatVersion: 1,
      passTypeIdentifier: PASS_TYPE_ID,
      serialNumber: customerId,
      teamIdentifier: TEAM_ID,
      organizationName: merchantName,
      description: 'بطاقة الولاء',
      backgroundColor: merchantColor,
      foregroundColor: 'rgb(245, 196, 122)',
      labelColor: 'rgb(245, 196, 122)',
      logoText: merchantName,
      storeCard: {
        primaryFields: [{ key: 'balance', label: 'الختمات', value: stampsText }],
        secondaryFields: [{ key: 'name', label: 'مرحباً', value: customer.name }, { key: 'remaining', label: 'متبقي للهدية', value: String(remaining) }],
        auxiliaryFields: [{ key: 'gifts', label: 'هدايا مستلمة', value: String(customer.totalGifts || 0) }]
      },
      barcodes: [{ message: customerId, format: 'PKBarcodeFormatQR', messageEncoding: 'iso-8859-1' }]
    };
    const pass = await PKPass.from({
      model: path.join(__dirname, 'pass-model.pass'),
      certificates: {
        wwdr: fs.readFileSync(path.join(__dirname, 'wwdr.pem')),
        signerCert: fs.readFileSync(path.join(__dirname, 'signerCert.pem')),
        signerKey: fs.readFileSync(path.join(__dirname, 'signerKey.pem')),
        signerKeyPassphrase: "Aa112233"
      }
    }, passJson);
    const buffer = pass.getAsBuffer();
    res.set({ 'Content-Type': 'application/vnd.apple.pkpass', 'Content-Disposition': 'attachment; filename="loyalty.pkpass"' });
    res.send(buffer);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ السيرفر شغال على http://localhost:${PORT}`));
