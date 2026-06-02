const fs = require('fs');
const content = fs.readFileSync('index.js', 'utf8');
const fixed = content.replace(
  `certificates: {
        wwdr: path.join(__dirname, 'wwdr.pem'),
        signerCert: path.join(__dirname, "signerCert.pem"),
        signerKey: path.join(__dirname, "signerKey.pem"),
        signerKeyPassphrase: "Aa112233"
      }`,
  `certificates: {
        wwdr: fs.readFileSync(path.join(__dirname, 'wwdr.pem')),
        signerCert: fs.readFileSync(path.join(__dirname, 'signerCert.pem')),
        signerKey: fs.readFileSync(path.join(__dirname, 'signerKey.pem')),
        signerKeyPassphrase: "Aa112233"
      }`
);
fs.writeFileSync('index.js', fixed);
console.log('تم');
