// Патч для server.js - добавляет referralCount в ответы API
// Запусти: node add-referral-count.js

const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, 'server.js');
let code = fs.readFileSync(serverPath, 'utf8');
let changes = 0;

// 1. Добавляем referralCount в login response
const loginOld = `referralCode: user.referralCode,
          rating: user.rating,
          ratingCount: user.ratingCount,
          emailVerified: user.emailVerified`;

const loginNew = `referralCode: user.referralCode,
          referralCount: user.referralCount || 0,
          rating: user.rating,
          ratingCount: user.ratingCount,
          emailVerified: user.emailVerified`;

if (code.includes(loginOld) && !code.includes('referralCount: user.referralCount')) {
  code = code.replace(loginOld, loginNew);
  changes++;
  console.log('✅ Добавлен referralCount в login');
}

// 2. Добавляем referralCount в register response
const registerOld = `referralCode: newUser.referralCode,
        rating: newUser.rating,
        emailVerified: newUser.emailVerified`;

const registerNew = `referralCode: newUser.referralCode,
        referralCount: 0,
        rating: newUser.rating,
        emailVerified: newUser.emailVerified`;

if (code.includes(registerOld)) {
  code = code.replace(registerOld, registerNew);
  changes++;
  console.log('✅ Добавлен referralCount в register');
}

// 3. Добавляем referralCount в getUser endpoint
const getUserOld = `referralCode: user.referralCode,
        rating: user.rating,
        ratingCount: user.ratingCount`;

const getUserNew = `referralCode: user.referralCode,
        referralCount: user.referralCount || 0,
        rating: user.rating,
        ratingCount: user.ratingCount`;

if (code.includes(getUserOld) && !code.includes('referralCount: user.referralCount || 0')) {
  code = code.replace(new RegExp(getUserOld.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), getUserNew);
  changes++;
  console.log('✅ Добавлен referralCount в getUser');
}

if (changes > 0) {
  fs.writeFileSync(serverPath, code);
  console.log(`\n✅ Готово! Изменений: ${changes}`);
} else {
  console.log('⚠️ Изменения уже применены или не найдены нужные строки');
}
