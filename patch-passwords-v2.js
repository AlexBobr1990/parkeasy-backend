const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, 'server.js');
let code = fs.readFileSync(serverPath, 'utf8');

// 1. Добавляем bcrypt
if (!code.includes("require('bcrypt')")) {
  code = code.replace(
    "const crypto = require('crypto');",
    "const crypto = require('crypto');\nconst bcrypt = require('bcrypt');"
  );
  console.log('1. Добавлен импорт bcrypt');
}

// 2. Хешируем при регистрации
code = code.replace(
  'email: lowerEmail,\n      password,',
  'email: lowerEmail,\n      password: await bcrypt.hash(password, 12),'
);
console.log('2. Регистрация: пароль хешируется');

// 3. Меняем логин - ищем по пароль в запросе
code = code.replace(
  "const user = await User.findOne({ email: email.toLowerCase(), password });",
  "const user = await User.findOne({ email: email.toLowerCase() });"
);

// Меняем проверку if (user) на новую логику
code = code.replace(
  `if (user) {
      // Generate referral code if missing
      if (!user.referralCode) {
        user.referralCode = user.name.substring(0, 3).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
        await user.save();
      }
      res.json({
        success: true,
        user: {
          id: user._id.toString(),
          email: user.email,
          name: user.name,
          balance: user.balance,
          car: user.car,
          avatar: user.avatar,
          language: user.language || 'ru',
          isAdmin: user.isAdmin || false,
          referralCode: user.referralCode,
          rating: user.rating,
          ratingCount: user.ratingCount,
          emailVerified: user.emailVerified
        }
      });
    } else {
      res.status(401).json({ success: false, message: 'Неверный email или пароль' });
    }`,
  `if (!user) {
      return res.status(401).json({ success: false, message: 'Неверный email или пароль' });
    }
    
    let isValidPassword = false;
    
    // Проверяем bcrypt хеш или старый пароль
    if (user.password && user.password.startsWith('$2b$')) {
      isValidPassword = await bcrypt.compare(password, user.password);
    } else if (user.password === password) {
      // Миграция старого пароля
      isValidPassword = true;
      user.password = await bcrypt.hash(password, 12);
      await user.save();
      console.log('Password migrated for:', user.email);
    }
    
    if (isValidPassword) {
      if (!user.referralCode) {
        user.referralCode = user.name.substring(0, 3).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
        await user.save();
      }
      res.json({
        success: true,
        user: {
          id: user._id.toString(),
          email: user.email,
          name: user.name,
          balance: user.balance,
          car: user.car,
          avatar: user.avatar,
          language: user.language || 'ru',
          isAdmin: user.isAdmin || false,
          referralCode: user.referralCode,
          rating: user.rating,
          ratingCount: user.ratingCount,
          emailVerified: user.emailVerified
        }
      });
    } else {
      res.status(401).json({ success: false, message: 'Неверный email или пароль' });
    }`
);
console.log('3. Логин: добавлена проверка bcrypt + миграция');

// 4. Сброс пароля
code = code.replace(
  'user.password = newPassword;',
  'user.password = await bcrypt.hash(newPassword, 12);'
);
console.log('4. Сброс пароля: хешируется');

// 5. Админ
code = code.replace(
  `if (!admin) {
      admin = new User({
        email: 'admin@parkbro.com',
        password: 'admin123',`,
  `if (!admin) {
      admin = new User({
        email: 'admin@parkbro.com',
        password: await bcrypt.hash('admin123', 12),`
);
console.log('5. Админ: пароль хешируется');

// 6. Экспорт - убираем пароль
code = code.replace(
  'password: user.password,',
  "password: '[HIDDEN]',"
);
console.log('6. Экспорт: пароль скрыт');

// Сохраняем
fs.writeFileSync(serverPath, code);
console.log('\nГотово! Теперь: npm start');
