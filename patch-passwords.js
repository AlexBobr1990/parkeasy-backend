#!/usr/bin/env node
/**
 * Скрипт для добавления bcrypt хеширования паролей в server.js
 * 
 * Использование:
 * 1. Положи этот файл в папку backend
 * 2. Запусти: node patch-passwords.js
 * 3. Проверь что server.js изменился корректно
 * 4. Задеплой
 */

const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, 'server.js');

if (!fs.existsSync(serverPath)) {
  console.error('❌ Файл server.js не найден!');
  process.exit(1);
}

let code = fs.readFileSync(serverPath, 'utf8');
let changes = 0;

// 1. Добавляем импорт bcrypt после crypto
if (!code.includes("require('bcrypt')")) {
  code = code.replace(
    "const crypto = require('crypto');",
    "const crypto = require('crypto');\nconst bcrypt = require('bcrypt');"
  );
  changes++;
  console.log('✅ Добавлен импорт bcrypt');
}

// 2. Хешируем пароль при регистрации
if (code.includes('password,\n      name: name.trim(),')) {
  code = code.replace(
    /const newUser = new User\(\{\s*\n\s*email: lowerEmail,\s*\n\s*password,/,
    `// Хешируем пароль
    const hashedPassword = await bcrypt.hash(password, 12);
    
    const newUser = new User({
      email: lowerEmail,
      password: hashedPassword,`
  );
  changes++;
  console.log('✅ Регистрация: пароль теперь хешируется');
}

// 3. Меняем логин на безопасную версию с миграцией
const oldLogin = `app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: email.toLowerCase(), password });
    
    if (user) {
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
    }
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});`;

const newLogin = `app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: email.toLowerCase() });
    
    if (!user) {
      return res.status(401).json({ success: false, message: 'Неверный email или пароль' });
    }
    
    let isValidPassword = false;
    
    // Проверяем: если пароль начинается с $2b$ - это bcrypt хеш
    if (user.password && user.password.startsWith('$2b$')) {
      isValidPassword = await bcrypt.compare(password, user.password);
    } else if (user.password) {
      // Старый пароль в открытом виде - проверяем и мигрируем
      if (user.password === password) {
        isValidPassword = true;
        // Мигрируем старый пароль на bcrypt
        user.password = await bcrypt.hash(password, 12);
        await user.save();
        console.log(\`🔐 Пароль пользователя \${user.email} мигрирован на bcrypt\`);
      }
    }
    
    if (isValidPassword) {
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
    }
  } catch (error) {
    console.log("Login error:", error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});`;

if (code.includes('const user = await User.findOne({ email: email.toLowerCase(), password });')) {
  code = code.replace(oldLogin, newLogin);
  changes++;
  console.log('✅ Логин: добавлена проверка bcrypt + автомиграция старых паролей');
}

// 4. Хешируем пароль при сбросе
if (code.includes('user.password = newPassword;')) {
  code = code.replace(
    'user.password = newPassword;',
    'user.password = await bcrypt.hash(newPassword, 12);'
  );
  changes++;
  console.log('✅ Сброс пароля: новый пароль хешируется');
}

// 5. Хешируем пароль админа
if (code.includes("password: 'admin123',")) {
  code = code.replace(
    /if \(!admin\) \{\s*\n\s*admin = new User\(\{\s*\n\s*email: 'admin@parkbro\.com',\s*\n\s*password: 'admin123',/,
    `if (!admin) {
      const adminHashedPassword = await bcrypt.hash('admin123', 12);
      admin = new User({
        email: 'admin@parkbro.com',
        password: adminHashedPassword,`
  );
  changes++;
  console.log('✅ Админ: пароль хешируется при создании');
}

// 6. Убираем пароль из экспорта
if (code.includes('password: user.password,')) {
  code = code.replace(
    'password: user.password,',
    "password: '[PROTECTED]',"
  );
  changes++;
  console.log('✅ Экспорт: пароли больше не видны');
}

if (changes === 0) {
  console.log('ℹ️  Похоже, патч уже применён или файл имеет другую структуру');
  process.exit(0);
}

// Создаём бэкап
const backupPath = serverPath + '.backup-' + Date.now();
fs.copyFileSync(serverPath, backupPath);
console.log(`\n📦 Бэкап создан: ${path.basename(backupPath)}`);

// Сохраняем изменения
fs.writeFileSync(serverPath, code);

console.log(`\n✅ Готово! Внесено ${changes} изменений`);
console.log('\n📋 Не забудь:');
console.log('   1. npm install bcrypt');
console.log('   2. Проверить что всё работает локально');
console.log('   3. Задеплоить на сервер');
