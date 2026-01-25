const express = require('express');
const sgMail = require("@sendgrid/mail");
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const cors = require('cors');
const mongoose = require('mongoose');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

// ==================== PUSH NOTIFICATIONS ====================
const sendPushNotification = async (pushToken, title, body, data = {}) => {
  if (!pushToken) return;
  try {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: pushToken, sound: 'default', title, body, data }),
    });
    console.log('Push sent to:', pushToken);
  } catch (error) {
    console.log('Push error:', error);
  }
};

// Push notification translations (ru, en, es, uk)
const pushTexts = {
  booking: {
    title: { ru: '🚗 Парковка забронирована!', en: '🚗 Parking booked!', es: '🚗 ¡Parking reservado!', uk: '🚗 Парковку заброньовано!' },
    body: { ru: '{name} едет к вашему месту', en: '{name} is coming to your spot', es: '{name} viene a tu lugar', uk: '{name} їде до вашого місця' }
  },
  arrived: {
    title: { ru: '📍 Водитель приехал!', en: '📍 Driver arrived!', es: '📍 ¡Conductor llegó!', uk: '📍 Водій приїхав!' },
    body: { ru: '{name} ждёт вас на месте', en: '{name} is waiting at the spot', es: '{name} está esperando', uk: '{name} чекає на місці' }
  },
  message: {
    title: { ru: '💬 Новое сообщение', en: '💬 New message', es: '💬 Nuevo mensaje', uk: '💬 Нове повідомлення' },
    body: { ru: '{name}: {text}', en: '{name}: {text}', es: '{name}: {text}', uk: '{name}: {text}' }
  },
  waitRequest: {
    title: { ru: '⏳ Просьба подождать', en: '⏳ Wait request', es: '⏳ Solicitud de espera', uk: '⏳ Прохання зачекати' },
    body: { ru: '{name} просит подождать {min} мин', en: '{name} asks to wait {min} min', es: '{name} pide esperar {min} min', uk: '{name} просить зачекати {min} хв' }
  },
  completed: {
    title: { ru: '🎉 Сделка завершена!', en: '🎉 Deal completed!', es: '🎉 ¡Trato completado!', uk: '🎉 Угоду завершено!' },
    body: { ru: 'Вы получили {amount} баллов', en: 'You earned {amount} points', es: 'Ganaste {amount} puntos', uk: 'Ви отримали {amount} балів' }
  },
  completedBooker: {
    title: { ru: '🎉 Сделка завершена!', en: '🎉 Deal completed!', es: '🎉 ¡Trato completado!', uk: '🎉 Угоду завершено!' },
    body: { ru: 'Парковка успешно передана. Спасибо!', en: 'Parking spot handed over. Thank you!', es: 'Lugar entregado con éxito. ¡Gracias!', uk: 'Парковку успішно передано. Дякуємо!' }
  }
};

const getPushText = (type, field, lang, vars = {}) => {
  const text = pushTexts[type]?.[field]?.[lang] || pushTexts[type]?.[field]?.en || '';
  return Object.entries(vars).reduce((t, [k, v]) => t.replace(`{${k}}`, v), text);
};

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://parkingapp:wmoU4mDhWsRb4VaQ@eazypark.xhy0jyi.mongodb.net/parkingapp?retryWrites=true&w=majority';
const PORT = process.env.PORT || 3001;

// ==================== SCHEMAS ====================

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String },
  name: { type: String, required: true },
  balance: { type: Number, default: 50 },
  car: {
    brand: String, model: String, color: String, plate: String,
    size: String, length: Number, width: Number, year: String
  },
  avatar: String,
  language: { type: String, default: 'ru' },
  isAdmin: { type: Boolean, default: false },
  
  // Верификация email
  emailVerified: { type: Boolean, default: false },
  verificationCode: String,
  verificationExpires: Date,
  resetCode: String,
  resetCodeExpires: Date,
  
  // OAuth
  googleId: String,
  appleId: String,
  authProvider: { type: String, enum: ['email', 'google', 'apple'], default: 'email' },
  
  // Реферальная система
  referralCode: { type: String, unique: true },
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  referralCount: { type: Number, default: 0 },
  
  // Рейтинг
  rating: { type: Number, default: 5.0 },
  ratingCount: { type: Number, default: 0 },
  totalRatingSum: { type: Number, default: 0 },
  
  // Соглашение
  acceptedTerms: { type: Boolean, default: false },
  acceptedTermsAt: Date,
  
  // Push notifications
  pushToken: String,
  
  lastActivity: { type: Date, default: Date.now },
  lastLocation: { lat: Number, lng: Number },
  
  // Друзья и приватность
  hideOnline: { type: Boolean, default: false },
  
  // Статистика
  parkingsGiven: { type: Number, default: 0 },
  parkingsReceived: { type: Number, default: 0 },
  
  // Достижения
  achievements: [{
    id: String,
    unlockedAt: Date
  }],
  
  createdAt: { type: Date, default: Date.now }
});

const parkingSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  location: { lat: Number, lng: Number },
  address: { type: String, required: true },
  price: { type: Number, required: true },
  timeToLeave: { type: Number, required: true },
  expiresAt: { type: Date },
  status: { type: String, enum: ['available', 'booked', 'expired', 'cancelled', 'completed'], default: 'available' },
  bookedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  bookedAt: Date,
  arrivedAt: Date,
  confirmedAt: Date,
  ownerCar: { brand: String, model: String, color: String, plate: String, size: String, length: Number, width: Number },
  ownerAvatar: String,
  ownerRating: Number,
  bookerCar: { brand: String, model: String, color: String, plate: String, size: String, length: Number, width: Number },
  bookerName: String,
  bookerAvatar: String,
  bookerRating: Number,
  bookerLocation: { lat: Number, lng: Number },
  comment: { type: String, default: '' },
  extensionsUsed: { type: Number, default: 0 },
  messages: [{
    userId: mongoose.Schema.Types.ObjectId,
    senderName: String,
    text: String,
    isOwner: Boolean,
    time: String,
    createdAt: Date
  }],
  waitRequest: {
    minutes: Number,
    fromUserId: mongoose.Schema.Types.ObjectId,
    createdAt: Date
  },
  waitResponse: {
    accepted: Boolean,
    respondedAt: Date
  },
  lastActivity: { type: Date, default: Date.now },
  lastLocation: { lat: Number, lng: Number },
  createdAt: { type: Date, default: Date.now }
});

const bookingSchema = new mongoose.Schema({
  parkingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Parking' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  address: String,
  price: Number,
  ownerEarnings: Number,
  platformFee: Number,
  status: { type: String, default: 'active' },
  
  // Рейтинги после завершения
  ownerRatedBooker: { type: Boolean, default: false },
  bookerRatedOwner: { type: Boolean, default: false },
  
  completedAt: Date,
  lastActivity: { type: Date, default: Date.now },
  lastLocation: { lat: Number, lng: Number },
  createdAt: { type: Date, default: Date.now }
});

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, enum: ['deposit', 'payment', 'earning', 'bonus', 'commission', 'cancellation', 'penalty', 'referral', 'help_payment', 'help_reward'], required: true },
  amount: { type: Number, required: true },
  description: { type: String, required: true },
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
  metadata: mongoose.Schema.Types.Mixed,
  lastActivity: { type: Date, default: Date.now },
  lastLocation: { lat: Number, lng: Number },
  createdAt: { type: Date, default: Date.now }
});

const ratingSchema = new mongoose.Schema({
  fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  toUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', required: true },
  rating: { type: Number, required: true, min: 1, max: 5 },
  problems: [{ type: String, enum: ['left_early', 'spot_taken', 'long_wait', 'wrong_location', 'no_show', 'rude', 'other'] }],
  comment: String,
  fromRole: String,
  lastActivity: { type: Date, default: Date.now },
  lastLocation: { lat: Number, lng: Number },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Parking = mongoose.model('Parking', parkingSchema);
const Booking = mongoose.model('Booking', bookingSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const Rating = mongoose.model('Rating', ratingSchema);

// Сообщения между друзьями
const friendMessageSchema = new mongoose.Schema({
  fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  toUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

// Запрос парковки от друга
const parkingRequestSchema = new mongoose.Schema({
  fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  toUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  message: String,
  status: { type: String, enum: ['pending', 'accepted', 'declined', 'expired'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 30 * 60 * 1000) }
});

const FriendMessage = mongoose.model('FriendMessage', friendMessageSchema);
const ParkingRequest = mongoose.model('ParkingRequest', parkingRequestSchema);

// Дружба между пользователями (помимо рефералов)
const friendshipSchema = new mongoose.Schema({
  user1: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  user2: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['pending', 'accepted', 'declined'], default: 'pending' },
  initiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  // Избранный друг
  favorite1: { type: Boolean, default: false }, // user1 добавил user2 в избранные
  favorite2: { type: Boolean, default: false }, // user2 добавил user1 в избранные
  // Статистика между друзьями
  exchangeCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

// Блокировка пользователей
const blockedUserSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  blockedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now }
});

const Friendship = mongoose.model('Friendship', friendshipSchema);
const BlockedUser = mongoose.model('BlockedUser', blockedUserSchema);

// Заглушенные пользователи (не получают пуш от них)
const mutedUserSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  mutedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now }
});

const MutedUser = mongoose.model('MutedUser', mutedUserSchema);

const helpRequestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  location: {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true }
  },
  address: String,
  problemType: { type: String, required: true },
  description: String,
  reward: { type: Number, default: 10 },
  status: { type: String, default: 'active' },
  helperId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  helperLocation: { lat: Number, lng: Number },
  helperArrived: { type: Boolean, default: false },
  lastActivity: { type: Date, default: Date.now },
  lastLocation: { lat: Number, lng: Number },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date }
});
const HelpRequest = mongoose.model('HelpRequest', helpRequestSchema);

// ==================== HELPERS ====================

function generateReferralCode() {
  return 'PB' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ==================== CONNECT ====================
// Send verification email
const sendVerificationEmail = async (email, code) => {
  try {
    await sgMail.send({
      to: email,
      from: "noreply@park-bro.com",
      subject: "ParkBro - Verification Code",
      text: `Your verification code is: ${code}`,
      html: `<div style="font-family: Arial, sans-serif; max-width: 400px; margin: 0 auto; padding: 20px;"><h2 style="color: #4a5568; text-align: center;">🚗 ParkBro</h2><p style="text-align: center; color: #666;">Your verification code:</p><div style="background: #f0f4f8; border-radius: 10px; padding: 20px; text-align: center; margin: 20px 0;"><span style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #4a5568;">${code}</span></div><p style="text-align: center; color: #999; font-size: 12px;">This code expires in 10 minutes.</p></div>`
    });
    console.log(`📧 Email sent to ${email}`);
    return true;
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    console.error("Email error:", error);
    return false;
  }
};



mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('✅ MongoDB подключена!');
    createAdminIfNeeded();
  })
  .catch(err => console.error('❌ Ошибка MongoDB:', err));

// ==================== TIMER ====================


setInterval(async () => {
  try {
    await Parking.updateMany(
      { status: 'available', expiresAt: { $lte: new Date() } },
      { status: 'expired' }
    );
  } catch (error) {
    console.log("Timer check error:", error);
  }
}, 60000);

// ==================== ROUTES ====================

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'ParkBro API is running!', version: '2.0' });
});

// ==================== AUTH ====================

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, car, referralCode, acceptedTerms } = req.body;
    
    if (!acceptedTerms) {
      return res.status(400).json({ success: false, message: 'Необходимо принять пользовательское соглашение' });
    }
    
    const lowerEmail = email.toLowerCase().trim();
    
    if (await User.findOne({ email: lowerEmail })) {
      return res.status(400).json({ success: false, message: 'Email уже зарегистрирован' });
    }
    
    let bonusAmount = 50;
    let referrer = null;
    
    // Проверяем реферальный код
    if (referralCode) {
      referrer = await User.findOne({ referralCode: referralCode.toUpperCase() });
      if (referrer) {
        bonusAmount = 70; // Бонус за использование реф кода
      }
    }
    
    const verificationCode = generateVerificationCode();
    
    // Хешируем пароль
    const hashedPassword = await bcrypt.hash(password, 12);
    
    const newUser = new User({
      email: lowerEmail,
      password: hashedPassword,
      name: name.trim(),
      balance: bonusAmount,
      car,
      language: 'ru',
      referralCode: generateReferralCode(),
      referredBy: referrer?._id,
      acceptedTerms: true,
      acceptedTermsAt: new Date(),
      verificationCode,
      verificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 часа
      emailVerified: false
    });
    
    await newUser.save();
    
    // Начисляем бонус рефереру
    if (referrer) {
      referrer.balance += 20;
      referrer.referralCount += 1;
      await referrer.save();
      
      await new Transaction({
        userId: referrer._id,
        type: 'referral',
        amount: 20,
        description: `Реферальный бонус за ${name.trim()}`
      }).save();
    }
    
    // Транзакция бонуса за регистрацию
    await new Transaction({
      userId: newUser._id,
      type: 'bonus',
      amount: bonusAmount,
      description: referrer ? 'Бонус за регистрацию по реферальному коду' : 'Бонус за регистрацию'
    }).save();
    
    // TODO: Отправить email с кодом верификации
    await sendVerificationEmail(lowerEmail, verificationCode);
    
    res.json({
      success: true,
      message: 'Регистрация успешна! Проверьте email для подтверждения.',
      user: {
        id: newUser._id.toString(),
        email: newUser.email,
        name: newUser.name,
        balance: newUser.balance,
        car: newUser.car,
        language: 'ru',
        referralCode: newUser.referralCode,
        referralCount: 0,
        rating: newUser.rating,
        emailVerified: newUser.emailVerified
      },
      verificationRequired: true
    });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    console.error('Register error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

app.post('/api/auth/verify-email', async (req, res) => {
  try {
    const { email, code } = req.body;
    const user = await User.findOne({ email: email.toLowerCase() });
    
    if (!user) {
      return res.status(404).json({ success: false, message: 'Пользователь не найден' });
    }
    
    if (user.emailVerified) {
      return res.json({ success: true, message: 'Email уже подтверждён' });
    }
    
    if (user.verificationCode !== code) {
      return res.status(400).json({ success: false, message: 'Неверный код' });
    }
    
    if (user.verificationExpires < new Date()) {
      return res.status(400).json({ success: false, message: 'Код истёк. Запросите новый.' });
    }
    
    user.emailVerified = true;
    user.verificationCode = null;
    user.verificationExpires = null;
    await user.save();
    
    res.json({ success: true, message: 'Email подтверждён!' });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

app.post('/api/auth/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email: email.toLowerCase() });
    
    if (!user) {
      return res.status(404).json({ success: false, message: 'Пользователь не найден' });
    }
    
    if (user.emailVerified) {
      return res.json({ success: true, message: 'Email уже подтверждён' });
    }
    
    const verificationCode = generateVerificationCode();
    user.verificationCode = verificationCode;
    user.verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await user.save();
    
    // TODO: Отправить email
    await sendVerificationEmail(email, verificationCode);
    
    res.json({ success: true, message: 'Код отправлен повторно' });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// Forgot password - send reset code
app.post("/api/auth/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email: email.toLowerCase() });
    
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    
    const resetCode = generateVerificationCode();
    user.resetCode = resetCode;
    user.resetCodeExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    await user.save();
    
    await sgMail.send({
      to: email,
      from: "noreply@park-bro.com",
      subject: "ParkBro - Password Reset Code",
      text: `Your password reset code is: ${resetCode}. Valid for 10 minutes.`,
      html: `<h2>Password Reset</h2><p>Your code: <strong>${resetCode}</strong></p><p>Valid for 10 minutes.</p>`
    });
    
    res.json({ success: true, message: "Reset code sent" });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    console.log("Forgot password error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Reset password with code
app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    const user = await User.findOne({ email: email.toLowerCase() });
    
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    
    if (user.resetCode !== code) {
      return res.status(400).json({ success: false, message: "Invalid code" });
    }
    
    if (new Date() > user.resetCodeExpires) {
      return res.status(400).json({ success: false, message: "Code expired" });
    }
    
    user.password = await bcrypt.hash(newPassword, 12);
    user.resetCode = null;
    user.resetCodeExpires = null;
    await user.save();
    
    res.json({ success: true, message: "Password updated" });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    console.log("Reset password error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ==================== CHECK REFERRAL CODE ====================
app.get('/api/referral/check/:code', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const user = await User.findOne({ referralCode: code });
    
    if (user) {
      res.json({ valid: true, ownerName: user.name });
    } else {
      res.json({ valid: false });
    }
  } catch (error) {
    console.log("CHECK REFERRAL ERROR:", error);
    res.json({ valid: false });
  }
});

// ==================== FRIENDS SYSTEM ====================

// Проверить являются ли пользователи друзьями
app.get('/api/friends/check/:userId1/:userId2', async (req, res) => {
  try {
    const { userId1, userId2 } = req.params;
    
    // Проверяем через рефералы
    const user1 = await User.findById(userId1);
    const user2 = await User.findById(userId2);
    
    if (!user1 || !user2) {
      return res.json({ areFriends: false });
    }
    
    // Друзья через рефералы?
    if (user1.referredBy?.toString() === userId2 || user2.referredBy?.toString() === userId1) {
      return res.json({ areFriends: true, via: 'referral' });
    }
    
    // Проверяем Friendship (любой статус)
    const friendship = await Friendship.findOne({
      $or: [
        { user1: userId1, user2: userId2 },
        { user1: userId2, user2: userId1 }
      ]
    });
    
    if (friendship) {
      if (friendship.status === 'accepted') {
        return res.json({ areFriends: true, via: 'friendship' });
      }
      if (friendship.status === 'pending') {
        // Кто инициатор запроса?
        const iAmInitiator = friendship.initiatedBy?.toString() === userId1;
        return res.json({ 
          areFriends: false, 
          pendingRequest: true,
          iAmInitiator,
          friendshipId: friendship._id
        });
      }
    }
    
    res.json({ areFriends: false });
  } catch (error) {
    console.log("CHECK FRIENDSHIP ERROR:", error);
    res.json({ areFriends: false });
  }
});

// Получить список друзей (рефералы + Friendship)
app.get('/api/users/:id/friends', async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await User.findById(userId);
    if (!user) return res.json([]);
    
    // Получаем блокированных
    const blockedUsers = await BlockedUser.find({ 
      $or: [{ userId }, { blockedUserId: userId }]
    });
    const blockedIds = blockedUsers.map(b => 
      b.userId.toString() === userId ? b.blockedUserId.toString() : b.userId.toString()
    );
    
    // 1. Друзья через рефералы
    const friendsWhoUsedMyCode = await User.find({ 
      referredBy: userId,
      _id: { $nin: blockedIds }
    }).select('name avatar lastActivity hideOnline rating ratingCount pushToken');
    
    let myReferrer = null;
    if (user.referredBy && !blockedIds.includes(user.referredBy.toString())) {
      myReferrer = await User.findById(user.referredBy)
        .select('name avatar lastActivity hideOnline rating ratingCount pushToken');
    }
    
    // 2. Друзья через Friendship
    const friendships = await Friendship.find({
      $or: [{ user1: userId }, { user2: userId }],
      status: 'accepted'
    });
    
    const friendshipFriends = [];
    for (const f of friendships) {
      const friendId = f.user1.toString() === userId ? f.user2 : f.user1;
      if (blockedIds.includes(friendId.toString())) continue;
      
      const friendUser = await User.findById(friendId)
        .select('name avatar lastActivity hideOnline rating ratingCount pushToken');
      
      if (friendUser) {
        const isFavorite = f.user1.toString() === userId ? f.favorite1 : f.favorite2;
        friendshipFriends.push({ 
          user: friendUser, 
          isFavorite, 
          friendshipId: f._id,
          exchangeCount: f.exchangeCount || 0
        });
      }
    }
    
    // Собираем всех друзей
    const allFriendsRaw = [];
    
    // Добавляем реферера первым
    if (myReferrer) {
      allFriendsRaw.push({ user: myReferrer, isReferral: true, isMyReferrer: true });
    }
    
    // Добавляем тех кто использовал мой код
    for (const f of friendsWhoUsedMyCode) {
      allFriendsRaw.push({ user: f, isReferral: true, usedMyCode: true });
    }
    
    // Добавляем друзей через Friendship (избегая дубликатов)
    for (const f of friendshipFriends) {
      const exists = allFriendsRaw.find(fr => fr.user._id.toString() === f.user._id.toString());
      if (!exists) {
        allFriendsRaw.push(f);
      } else {
        // Обновляем isFavorite если уже есть
        exists.isFavorite = f.isFavorite;
        exists.friendshipId = f.friendshipId;
        exists.exchangeCount = f.exchangeCount;
      }
    }
    
    // Добавляем информацию об онлайн статусе и непрочитанных
    const friendsWithStatus = await Promise.all(allFriendsRaw.map(async (friendData) => {
      const friend = friendData.user;
      const now = new Date();
      const lastActivity = new Date(friend.lastActivity);
      const diffMs = now - lastActivity;
      const diffMins = Math.floor(diffMs / 60000);
      
      const isOnline = friend.hideOnline ? false : diffMins < 5;
      
      const unreadCount = await FriendMessage.countDocuments({
        fromUserId: friend._id,
        toUserId: userId,
        read: false
      });
      
      // Последний визит
      let lastSeenText = null;
      if (!friend.hideOnline && !isOnline) {
        if (diffMins < 60) {
          lastSeenText = `${diffMins}m`;
        } else if (diffMins < 1440) {
          lastSeenText = `${Math.floor(diffMins / 60)}h`;
        } else {
          lastSeenText = `${Math.floor(diffMins / 1440)}d`;
        }
      }
      
      return {
        _id: friend._id,
        name: friend.name,
        avatar: friend.avatar,
        rating: friend.rating,
        ratingCount: friend.ratingCount,
        isOnline,
        lastSeenText,
        unreadCount,
        isFavorite: friendData.isFavorite || false,
        friendshipId: friendData.friendshipId || null,
        isReferral: friendData.isReferral || false,
        exchangeCount: friendData.exchangeCount || 0
      };
    }));
    
    // Сортируем: избранные сверху, потом онлайн, потом по имени
    friendsWithStatus.sort((a, b) => {
      if (a.isFavorite && !b.isFavorite) return -1;
      if (!a.isFavorite && b.isFavorite) return 1;
      if (a.isOnline && !b.isOnline) return -1;
      if (!a.isOnline && b.isOnline) return 1;
      return a.name.localeCompare(b.name);
    });
    
    res.json(friendsWithStatus);
  } catch (error) {
    console.log("GET FRIENDS ERROR:", error);
    res.json([]);
  }
});

// Отправить сообщение другу
app.post('/api/friends/message', async (req, res) => {
  try {
    const { fromUserId, toUserId, text } = req.body;
    
    // Проверяем блокировку
    const blocked = await BlockedUser.findOne({
      $or: [
        { userId: fromUserId, blockedUserId: toUserId },
        { userId: toUserId, blockedUserId: fromUserId }
      ]
    });
    if (blocked) {
      return res.status(403).json({ success: false, message: 'User is blocked' });
    }
    
    const message = new FriendMessage({ fromUserId, toUserId, text });
    await message.save();
    
    // Проверяем mute перед отправкой push
    const muted = await MutedUser.findOne({
      userId: toUserId,
      mutedUserId: fromUserId
    });
    
    // Отправляем push уведомление только если не заглушен
    if (!muted) {
      const recipient = await User.findById(toUserId);
      const sender = await User.findById(fromUserId);
      
      if (recipient && recipient.pushToken) {
        const lang = recipient.language || 'en';
        const titles = {
          en: '💬 New message',
          ru: '💬 Новое сообщение',
          es: '💬 Nuevo mensaje',
          uk: '💬 Нове повідомлення'
        };
        const bodies = {
          en: `${sender?.name || 'Friend'}: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`,
          ru: `${sender?.name || 'Друг'}: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`,
          es: `${sender?.name || 'Amigo'}: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`,
          uk: `${sender?.name || 'Друг'}: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`
        };
        
        sendPushNotification(recipient.pushToken, titles[lang] || titles.en, bodies[lang] || bodies.en, {
          type: 'friend_message',
          fromUserId: fromUserId.toString()
        });
      }
    }
    
    res.json({ success: true, message });
  } catch (error) {
    console.log("SEND FRIEND MESSAGE ERROR:", error);
    res.status(500).json({ success: false });
  }
});

// Получить историю чата с другом
app.get('/api/friends/messages/:friendId/:userId', async (req, res) => {
  try {
    const { friendId, userId } = req.params;
    
    const messages = await FriendMessage.find({
      $or: [
        { fromUserId: userId, toUserId: friendId },
        { fromUserId: friendId, toUserId: userId }
      ]
    }).sort({ createdAt: 1 }).limit(100);
    
    res.json(messages);
  } catch (error) {
    console.log("GET FRIEND MESSAGES ERROR:", error);
    res.json([]);
  }
});

// Пометить сообщения прочитанными
app.post('/api/friends/mark-read', async (req, res) => {
  try {
    const { friendId, userId } = req.body;
    
    await FriendMessage.updateMany(
      { fromUserId: friendId, toUserId: userId, read: false },
      { read: true }
    );
    
    res.json({ success: true });
  } catch (error) {
    console.log("MARK READ ERROR:", error);
    res.status(500).json({ success: false });
  }
});

// Общее количество непрочитанных сообщений от друзей
app.get('/api/users/:id/unread-messages', async (req, res) => {
  try {
    const count = await FriendMessage.countDocuments({
      toUserId: req.params.id,
      read: false
    });
    res.json({ count });
  } catch (error) {
    res.json({ count: 0 });
  }
});

// Скрыть/показать онлайн статус
app.patch('/api/users/:id/hide-online', async (req, res) => {
  try {
    const { hideOnline } = req.body;
    await User.findByIdAndUpdate(req.params.id, { hideOnline });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// Попросить парковку у друга
app.post('/api/friends/request-parking', async (req, res) => {
  try {
    const { fromUserId, toUserId, message } = req.body;
    
    // Проверяем нет ли уже активного запроса
    const existingRequest = await ParkingRequest.findOne({
      fromUserId,
      toUserId,
      status: 'pending',
      expiresAt: { $gt: new Date() }
    });
    
    if (existingRequest) {
      return res.status(400).json({ success: false, message: 'Request already sent' });
    }
    
    const request = new ParkingRequest({ fromUserId, toUserId, message });
    await request.save();
    
    // Push уведомление
    const recipient = await User.findById(toUserId);
    const sender = await User.findById(fromUserId);
    
    if (recipient && recipient.pushToken) {
      const lang = recipient.language || 'en';
      const titles = {
        en: '🅿️ Parking request',
        ru: '🅿️ Запрос парковки',
        es: '🅿️ Solicitud de estacionamiento',
        uk: '🅿️ Запит парковки'
      };
      const bodies = {
        en: `${sender?.name || 'Friend'} is looking for parking nearby. Can you help?`,
        ru: `${sender?.name || 'Друг'} ищет парковку рядом. Можешь помочь?`,
        es: `${sender?.name || 'Amigo'} busca estacionamiento cerca. ¿Puedes ayudar?`,
        uk: `${sender?.name || 'Друг'} шукає парковку поруч. Можеш допомогти?`
      };
      
      sendPushNotification(recipient.pushToken, titles[lang] || titles.en, bodies[lang] || bodies.en, {
        type: 'parking_request',
        requestId: request._id.toString(),
        fromUserId: fromUserId.toString()
      });
    }
    
    res.json({ success: true, request });
  } catch (error) {
    console.log("REQUEST PARKING ERROR:", error);
    res.status(500).json({ success: false });
  }
});

// Ответить на запрос парковки
app.post('/api/friends/respond-parking-request', async (req, res) => {
  try {
    const { requestId, accepted } = req.body;
    
    const request = await ParkingRequest.findByIdAndUpdate(
      requestId,
      { status: accepted ? 'accepted' : 'declined' },
      { new: true }
    );
    
    // Push уведомление отправителю запроса
    const sender = await User.findById(request.fromUserId);
    const responder = await User.findById(request.toUserId);
    
    if (sender && sender.pushToken) {
      const lang = sender.language || 'en';
      const titles = {
        en: accepted ? '✅ Request accepted' : '❌ Request declined',
        ru: accepted ? '✅ Запрос принят' : '❌ Запрос отклонён',
        es: accepted ? '✅ Solicitud aceptada' : '❌ Solicitud rechazada',
        uk: accepted ? '✅ Запит прийнято' : '❌ Запит відхилено'
      };
      const bodies = {
        en: accepted ? `${responder?.name} will share their parking soon!` : `${responder?.name} can't help right now`,
        ru: accepted ? `${responder?.name} скоро поделится парковкой!` : `${responder?.name} не может помочь сейчас`,
        es: accepted ? `${responder?.name} compartirá su estacionamiento pronto!` : `${responder?.name} no puede ayudar ahora`,
        uk: accepted ? `${responder?.name} скоро поділиться парковкою!` : `${responder?.name} не може допомогти зараз`
      };
      
      sendPushNotification(sender.pushToken, titles[lang] || titles.en, bodies[lang] || bodies.en, {
        type: 'parking_request_response',
        accepted
      });
    }
    
    res.json({ success: true });
  } catch (error) {
    console.log("RESPOND PARKING REQUEST ERROR:", error);
    res.status(500).json({ success: false });
  }
});

// Отправить парковку конкретному другу (приоритетный пуш)
app.post('/api/parkings/:id/send-to-friend', async (req, res) => {
  try {
    const { friendId } = req.body;
    const parking = await Parking.findById(req.params.id).populate('ownerId', 'name');
    const friend = await User.findById(friendId);
    
    if (!parking || !friend) {
      return res.status(404).json({ success: false });
    }
    
    // Добавляем друга в приоритетный список
    parking.priorityUser = friendId;
    await parking.save();
    
    // Push уведомление другу
    if (friend.pushToken) {
      const lang = friend.language || 'en';
      const titles = {
        en: '🎁 Parking from friend!',
        ru: '🎁 Парковка от друга!',
        es: '🎁 ¡Estacionamiento de amigo!',
        uk: '🎁 Парковка від друга!'
      };
      const bodies = {
        en: `${parking.ownerId?.name || 'Friend'} is leaving a spot for you at ${parking.address}`,
        ru: `${parking.ownerId?.name || 'Друг'} оставляет место для тебя: ${parking.address}`,
        es: `${parking.ownerId?.name || 'Amigo'} te deja un lugar en ${parking.address}`,
        uk: `${parking.ownerId?.name || 'Друг'} залишає місце для тебе: ${parking.address}`
      };
      
      sendPushNotification(friend.pushToken, titles[lang] || titles.en, bodies[lang] || bodies.en, {
        type: 'friend_parking',
        parkingId: parking._id.toString()
      });
    }
    
    res.json({ success: true });
  } catch (error) {
    console.log("SEND TO FRIEND ERROR:", error);
    res.status(500).json({ success: false });
  }
});

// Получить статистику пользователя
app.get('/api/users/:id/stats', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false });
    
    // Считаем достижения
    const achievements = [];
    
    // Достижения за отданные парковки
    if (user.parkingsGiven >= 1) achievements.push({ id: 'first_give', name: 'First Give', emoji: '🌱' });
    if (user.parkingsGiven >= 10) achievements.push({ id: 'helper', name: 'Helper', emoji: '🤝' });
    if (user.parkingsGiven >= 50) achievements.push({ id: 'generous', name: 'Generous', emoji: '💝' });
    if (user.parkingsGiven >= 100) achievements.push({ id: 'legend', name: 'Legend', emoji: '🏆' });
    
    // Достижения за полученные парковки
    if (user.parkingsReceived >= 1) achievements.push({ id: 'first_park', name: 'First Park', emoji: '🚗' });
    if (user.parkingsReceived >= 25) achievements.push({ id: 'regular', name: 'Regular', emoji: '⭐' });
    
    // За высокий рейтинг
    if (user.rating >= 4.8 && user.ratingCount >= 10) achievements.push({ id: 'trusted', name: 'Trusted', emoji: '💎' });
    
    // За друзей (рефералов)
    if (user.referralCount >= 5) achievements.push({ id: 'networker', name: 'Networker', emoji: '🌐' });
    if (user.referralCount >= 20) achievements.push({ id: 'influencer', name: 'Influencer', emoji: '👑' });
    
    res.json({
      parkingsGiven: user.parkingsGiven || 0,
      parkingsReceived: user.parkingsReceived || 0,
      rating: user.rating,
      ratingCount: user.ratingCount,
      referralCount: user.referralCount || 0,
      achievements
    });
  } catch (error) {
    console.log("GET STATS ERROR:", error);
    res.status(500).json({ success: false });
  }
});

// ==================== ДОПОЛНИТЕЛЬНЫЕ ФИЧИ ДРУЗЕЙ ====================

// Добавить в избранные
app.post('/api/friends/favorite', async (req, res) => {
  try {
    const { userId, friendId, favorite } = req.body;
    
    // Ищем существующую дружбу
    let friendship = await Friendship.findOne({
      $or: [
        { user1: userId, user2: friendId },
        { user1: friendId, user2: userId }
      ]
    });
    
    if (!friendship) {
      // Создаём новую дружбу
      friendship = new Friendship({ 
        user1: userId, 
        user2: friendId, 
        status: 'accepted',
        favorite1: true
      });
    } else {
      // Обновляем избранное
      if (friendship.user1.toString() === userId) {
        friendship.favorite1 = favorite;
      } else {
        friendship.favorite2 = favorite;
      }
    }
    
    await friendship.save();
    res.json({ success: true });
  } catch (error) {
    console.log("FAVORITE ERROR:", error);
    res.status(500).json({ success: false });
  }
});

// Проверить является ли друг избранным
app.get('/api/friends/is-favorite/:userId/:friendId', async (req, res) => {
  try {
    const { userId, friendId } = req.params;
    
    const friendship = await Friendship.findOne({
      $or: [
        { user1: userId, user2: friendId },
        { user1: friendId, user2: userId }
      ]
    });
    
    if (!friendship) return res.json({ favorite: false });
    
    const isFavorite = friendship.user1.toString() === userId 
      ? friendship.favorite1 
      : friendship.favorite2;
    
    res.json({ favorite: isFavorite });
  } catch (error) {
    res.json({ favorite: false });
  }
});

// Заблокировать пользователя
app.post('/api/users/block', async (req, res) => {
  try {
    const { userId, blockedUserId } = req.body;
    
    // Проверяем нет ли уже блокировки
    const existing = await BlockedUser.findOne({ userId, blockedUserId });
    if (existing) return res.json({ success: true, message: 'Already blocked' });
    
    const block = new BlockedUser({ userId, blockedUserId });
    await block.save();
    
    // Удаляем из друзей если есть
    await Friendship.deleteOne({
      $or: [
        { user1: userId, user2: blockedUserId },
        { user1: blockedUserId, user2: userId }
      ]
    });
    
    res.json({ success: true });
  } catch (error) {
    console.log("BLOCK USER ERROR:", error);
    res.status(500).json({ success: false });
  }
});

// Разблокировать пользователя
app.delete('/api/users/unblock/:userId/:blockedUserId', async (req, res) => {
  try {
    const { userId, blockedUserId } = req.params;
    await BlockedUser.deleteOne({ userId, blockedUserId });
    res.json({ success: true });
  } catch (error) {
    console.log("UNBLOCK ERROR:", error);
    res.status(500).json({ success: false });
  }
});

// Получить список заблокированных
app.get('/api/users/:id/blocked', async (req, res) => {
  try {
    const blocked = await BlockedUser.find({ userId: req.params.id })
      .populate('blockedUserId', 'name avatar');
    res.json(blocked.map(b => b.blockedUserId));
  } catch (error) {
    res.json([]);
  }
});

// Проверить заблокирован ли пользователь
app.get('/api/users/is-blocked/:userId/:targetId', async (req, res) => {
  try {
    const { userId, targetId } = req.params;
    
    // Проверяем блокировку в обе стороны
    const blocked = await BlockedUser.findOne({
      $or: [
        { userId, blockedUserId: targetId },
        { userId: targetId, blockedUserId: userId }
      ]
    });
    
    res.json({ blocked: !!blocked });
  } catch (error) {
    res.json({ blocked: false });
  }
});

// ==================== MUTE ====================

// Заглушить пользователя
app.post('/api/users/mute', async (req, res) => {
  try {
    const { userId, mutedUserId } = req.body;
    
    const existing = await MutedUser.findOne({ userId, mutedUserId });
    if (existing) return res.json({ success: true, message: 'Already muted' });
    
    const mute = new MutedUser({ userId, mutedUserId });
    await mute.save();
    
    res.json({ success: true });
  } catch (error) {
    console.log("MUTE ERROR:", error);
    res.status(500).json({ success: false });
  }
});

// Снять заглушку
app.delete('/api/users/unmute/:userId/:mutedUserId', async (req, res) => {
  try {
    const { userId, mutedUserId } = req.params;
    await MutedUser.deleteOne({ userId, mutedUserId });
    res.json({ success: true });
  } catch (error) {
    console.log("UNMUTE ERROR:", error);
    res.status(500).json({ success: false });
  }
});

// Проверить заглушен ли пользователь
app.get('/api/users/is-muted/:userId/:targetId', async (req, res) => {
  try {
    const { userId, targetId } = req.params;
    const muted = await MutedUser.findOne({ userId, mutedUserId: targetId });
    res.json({ muted: !!muted });
  } catch (error) {
    res.json({ muted: false });
  }
});

// Поиск пользователя по email
app.get('/api/users/search-by-email/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase();
    
    const user = await User.findOne({ email }).select('_id name email avatar');
    
    if (user) {
      res.json({ success: true, user });
    } else {
      res.json({ success: false, message: 'User not found' });
    }
  } catch (error) {
    console.log("SEARCH BY EMAIL ERROR:", error);
    res.json({ success: false });
  }
});

// Отправить запрос на дружбу (после успешного обмена)
app.post('/api/friends/request', async (req, res) => {
  try {
    const { fromUserId, toUserId } = req.body;
    console.log("=== FRIEND REQUEST ===");
    console.log("Body:", JSON.stringify(req.body));
    console.log("fromUserId:", fromUserId, "type:", typeof fromUserId);
    console.log("toUserId:", toUserId, "type:", typeof toUserId);
    
    if (!fromUserId || !toUserId) {
      console.log("MISSING IDS");
      return res.status(400).json({ success: false, message: 'Missing user IDs' });
    }
    
    // Проверяем блокировку
    const blocked = await BlockedUser.findOne({
      $or: [
        { userId: fromUserId, blockedUserId: toUserId },
        { userId: toUserId, blockedUserId: fromUserId }
      ]
    });
    if (blocked) {
      console.log("BLOCKED");
      return res.status(400).json({ success: false, message: 'User is blocked' });
    }
    
    // Проверяем не друзья ли они уже через рефералы
    const user = await User.findById(fromUserId);
    const targetUser = await User.findById(toUserId);
    
    console.log("User found:", !!user, user?._id);
    console.log("Target found:", !!targetUser, targetUser?._id);
    
    if (!user || !targetUser) {
      console.log("USER NOT FOUND - fromUserId:", fromUserId, "toUserId:", toUserId);
      return res.status(400).json({ success: false, message: 'User not found' });
    }
    
    if (user.referredBy?.toString() === toUserId || targetUser.referredBy?.toString() === fromUserId) {
      console.log("ALREADY FRIENDS VIA REFERRAL");
      return res.json({ success: false, message: 'Already friends via referral' });
    }
    
    // Проверяем существует ли уже дружба или запрос
    const existingFriendship = await Friendship.findOne({
      $or: [
        { user1: fromUserId, user2: toUserId },
        { user1: toUserId, user2: fromUserId }
      ]
    });
    
    console.log("Existing friendship:", existingFriendship);
    
    if (existingFriendship) {
      if (existingFriendship.status === 'accepted') {
        return res.json({ success: false, message: 'Already friends' });
      }
      
      // Если есть pending запрос ОТ ДРУГОГО пользователя - автоматически принимаем!
      if (existingFriendship.status === 'pending' && existingFriendship.user1.toString() === toUserId) {
        console.log("AUTO ACCEPTING - other user sent request first");
        existingFriendship.status = 'accepted';
        await existingFriendship.save();
        
        // Push обоим что теперь друзья
        const lang1 = user.language || 'en';
        const lang2 = targetUser.language || 'en';
        
        const titles = {
          en: '🎉 New friend!',
          ru: '🎉 Новый друг!',
          es: '🎉 ¡Nuevo amigo!',
          uk: '🎉 Новий друг!'
        };
        
        if (user.pushToken) {
          sendPushNotification(user.pushToken, titles[lang1] || titles.en, 
            `${targetUser.name} - ${lang1 === 'ru' ? 'теперь ваш друг!' : lang1 === 'uk' ? 'тепер ваш друг!' : 'is now your friend!'}`,
            { type: 'friend_accepted' });
        }
        if (targetUser.pushToken) {
          sendPushNotification(targetUser.pushToken, titles[lang2] || titles.en,
            `${user.name} - ${lang2 === 'ru' ? 'теперь ваш друг!' : lang2 === 'uk' ? 'тепер ваш друг!' : 'is now your friend!'}`,
            { type: 'friend_accepted' });
        }
        
        return res.json({ success: true, message: 'Now friends', autoAccepted: true });
      }
      
      // Если pending запрос от меня - уже отправлен
      if (existingFriendship.status === 'pending') {
        console.log("REQUEST ALREADY SENT");
        return res.json({ success: false, message: 'Request already sent' });
      }
    }
    
    // Создаём новый запрос на дружбу
    console.log("CREATING NEW FRIENDSHIP");
    const friendship = new Friendship({
      user1: fromUserId,
      user2: toUserId,
      status: 'pending',
      initiatedBy: fromUserId
    });
    await friendship.save();
    console.log("FRIENDSHIP SAVED:", friendship._id);
    
    // Push уведомление
    if (targetUser && targetUser.pushToken) {
      const sender = await User.findById(fromUserId);
      const lang = targetUser.language || 'en';
      const titles = {
        en: '👋 Friend request',
        ru: '👋 Запрос в друзья',
        es: '👋 Solicitud de amistad',
        uk: '👋 Запит на дружбу'
      };
      const bodies = {
        en: `${sender?.name || 'Someone'} wants to be your friend!`,
        ru: `${sender?.name || 'Кто-то'} хочет добавить вас в друзья!`,
        es: `${sender?.name || 'Alguien'} quiere ser tu amigo!`,
        uk: `${sender?.name || 'Хтось'} хоче додати вас у друзі!`
      };
      
      sendPushNotification(targetUser.pushToken, titles[lang] || titles.en, bodies[lang] || bodies.en, {
        type: 'friend_request',
        fromUserId: fromUserId.toString()
      });
    }
    
    res.json({ success: true });
  } catch (error) {
    console.log("FRIEND REQUEST ERROR:", error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Принять/отклонить запрос дружбы
app.post('/api/friends/respond', async (req, res) => {
  try {
    const { friendshipId, accept } = req.body;
    
    const friendship = await Friendship.findById(friendshipId);
    if (!friendship) return res.status(404).json({ success: false });
    
    friendship.status = accept ? 'accepted' : 'declined';
    await friendship.save();
    
    // Push уведомление инициатору
    if (accept) {
      const initiator = await User.findById(friendship.initiatedBy);
      const responder = await User.findById(
        friendship.user1.toString() === friendship.initiatedBy.toString() 
          ? friendship.user2 
          : friendship.user1
      );
      
      if (initiator && initiator.pushToken) {
        const lang = initiator.language || 'en';
        const titles = {
          en: '🎉 Friend request accepted!',
          ru: '🎉 Запрос принят!',
          es: '🎉 ¡Solicitud aceptada!',
          uk: '🎉 Запит прийнято!'
        };
        const bodies = {
          en: `${responder?.name || 'Someone'} is now your friend!`,
          ru: `${responder?.name || 'Кто-то'} теперь ваш друг!`,
          es: `${responder?.name || 'Alguien'} ahora es tu amigo!`,
          uk: `${responder?.name || 'Хтось'} тепер ваш друг!`
        };
        
        sendPushNotification(initiator.pushToken, titles[lang] || titles.en, bodies[lang] || bodies.en, {
          type: 'friend_accepted'
        });
      }
    }
    
    res.json({ success: true });
  } catch (error) {
    console.log("RESPOND FRIEND ERROR:", error);
    res.status(500).json({ success: false });
  }
});

// Получить входящие запросы на дружбу
app.get('/api/users/:id/friend-requests', async (req, res) => {
  try {
    const userId = req.params.id;
    console.log("GET FRIEND REQUESTS for userId:", userId);
    
    // user2 - это всегда получатель запроса
    const requests = await Friendship.find({
      user2: userId,
      status: 'pending'
    }).populate('user1', 'name avatar rating ratingCount');
    
    console.log("Found requests:", requests.length, requests.map(r => ({ id: r._id, user1: r.user1?._id, user2: r.user2 })));
    
    // user1 - это отправитель
    res.json(requests.map(r => ({
      friendshipId: r._id,
      user: r.user1,
      createdAt: r.createdAt
    })));
  } catch (error) {
    console.log("GET FRIEND REQUESTS ERROR:", error);
    res.json([]);
  }
});

// Получить исходящие запросы на дружбу (которые я отправил)
app.get('/api/users/:id/outgoing-requests', async (req, res) => {
  try {
    const userId = req.params.id;
    
    // user1 - это всегда отправитель запроса
    const requests = await Friendship.find({
      user1: userId,
      status: 'pending'
    }).populate('user2', 'name avatar rating ratingCount');
    
    // user2 - это получатель
    res.json(requests.map(r => ({
      friendshipId: r._id,
      user: r.user2,
      createdAt: r.createdAt
    })));
  } catch (error) {
    console.log("GET OUTGOING REQUESTS ERROR:", error);
    res.json([]);
  }
});

// Удалить из друзей
app.delete('/api/friends/:friendshipId', async (req, res) => {
  try {
    await Friendship.findByIdAndDelete(req.params.friendshipId);
    res.json({ success: true });
  } catch (error) {
    console.log("DELETE FRIEND ERROR:", error);
    res.status(500).json({ success: false });
  }
});

// Уведомить друзей о новой парковке рядом
app.post('/api/parkings/:id/notify-nearby-friends', async (req, res) => {
  try {
    const { userId } = req.body;
    const parking = await Parking.findById(req.params.id).populate('ownerId', 'name');
    if (!parking) return res.status(404).json({ success: false });
    
    // Получаем друзей
    const user = await User.findById(userId);
    const friendsWhoUsedMyCode = await User.find({ referredBy: userId });
    let myReferrer = user.referredBy ? await User.findById(user.referredBy) : null;
    
    const allFriends = [...friendsWhoUsedMyCode];
    if (myReferrer) allFriends.push(myReferrer);
    
    // Также друзья через Friendship
    const friendships = await Friendship.find({
      $or: [{ user1: userId }, { user2: userId }],
      status: 'accepted'
    });
    
    for (const f of friendships) {
      const friendId = f.user1.toString() === userId ? f.user2 : f.user1;
      const friendUser = await User.findById(friendId);
      if (friendUser && !allFriends.find(fr => fr._id.toString() === friendId.toString())) {
        allFriends.push(friendUser);
      }
    }
    
    // Отправляем пуш тем кто рядом (в радиусе 2 км)
    let notified = 0;
    for (const friend of allFriends) {
      if (!friend.lastLocation || !friend.pushToken) continue;
      
      // Считаем расстояние
      const R = 6371;
      const dLat = (friend.lastLocation.lat - parking.location.lat) * Math.PI / 180;
      const dLon = (friend.lastLocation.lng - parking.location.lng) * Math.PI / 180;
      const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(parking.location.lat * Math.PI / 180) * Math.cos(friend.lastLocation.lat * Math.PI / 180) *
                Math.sin(dLon/2) * Math.sin(dLon/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      const distance = R * c;
      
      if (distance <= 2) { // 2 км
        const lang = friend.language || 'en';
        const titles = {
          en: '🅿️ Friend parking nearby!',
          ru: '🅿️ Парковка друга рядом!',
          es: '🅿️ ¡Estacionamiento de amigo cerca!',
          uk: '🅿️ Парковка друга поруч!'
        };
        const bodies = {
          en: `${parking.ownerId?.name || 'Friend'} is leaving at ${parking.address}`,
          ru: `${parking.ownerId?.name || 'Друг'} уезжает: ${parking.address}`,
          es: `${parking.ownerId?.name || 'Amigo'} sale de ${parking.address}`,
          uk: `${parking.ownerId?.name || 'Друг'} виїжджає: ${parking.address}`
        };
        
        sendPushNotification(friend.pushToken, titles[lang] || titles.en, bodies[lang] || bodies.en, {
          type: 'friend_parking_nearby',
          parkingId: parking._id.toString()
        });
        notified++;
      }
    }
    
    res.json({ success: true, notifiedCount: notified });
  } catch (error) {
    console.log("NOTIFY NEARBY ERROR:", error);
    res.status(500).json({ success: false });
  }
});

// Получить "был в сети X мин назад"
app.get('/api/users/:id/last-seen', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('lastActivity hideOnline');
    if (!user) return res.status(404).json({ success: false });
    
    if (user.hideOnline) {
      return res.json({ lastSeen: null, hidden: true });
    }
    
    const now = new Date();
    const lastActivity = new Date(user.lastActivity);
    const diffMs = now - lastActivity;
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 5) {
      return res.json({ lastSeen: 'online', online: true });
    }
    
    res.json({ 
      lastSeen: diffMins,
      online: false
    });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// ==================== RECALCULATE RATINGS ====================
app.post('/api/admin/recalculate-ratings', async (req, res) => {
  try {
    // Получаем всех пользователей
    const users = await User.find({});
    let updated = 0;
    
    for (const user of users) {
      // Считаем реальные рейтинги из коллекции ratings
      const ratings = await Rating.find({ toUserId: user._id.toString() });
      
      if (ratings.length === 0) {
        // Нет отзывов - сбрасываем
        user.ratingCount = 0;
        user.totalRatingSum = 0;
        user.rating = 0;
      } else {
        // Пересчитываем
        const sum = ratings.reduce((acc, r) => acc + r.rating, 0);
        user.ratingCount = ratings.length;
        user.totalRatingSum = sum;
        user.rating = sum / ratings.length;
      }
      
      await user.save();
      updated++;
    }
    
    console.log(`✅ Recalculated ratings for ${updated} users`);
    res.json({ success: true, message: `Recalculated ratings for ${updated} users` });
  } catch (error) {
    console.log("RECALCULATE ERROR:", error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== DELETE ACCOUNT ====================
app.delete('/api/users/:id/account', async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Проверяем валидность ObjectId
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    // Проверяем что пользователь существует
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    // Отменяем активные парковки пользователя
    await Parking.updateMany(
      { ownerId: userId, status: { $in: ['available', 'booked'] } },
      { status: 'cancelled' }
    );
    
    // Освобождаем забронированные пользователем парковки
    await Parking.updateMany(
      { bookedBy: userId, status: 'booked' },
      { bookedBy: null, status: 'available', bookedAt: null, arrivedAt: null }
    );
    
    // Отменяем активные запросы помощи
    await HelpRequest.updateMany(
      { $or: [{ userId }, { helperId: userId }], status: 'active' },
      { status: 'cancelled' }
    );
    
    // Удаляем все связанные данные
    await Parking.deleteMany({ ownerId: userId });
    await Booking.deleteMany({ $or: [{ userId }, { ownerId: userId }] });
    await Transaction.deleteMany({ userId });
    // Удаляем только рейтинги ОТПРАВЛЕННЫЕ пользователем (полученные сохраняем)
    await Rating.deleteMany({ fromUserId: userId });
    await HelpRequest.deleteMany({ $or: [{ userId }, { helperId: userId }] });
    
    // Удаляем самого пользователя
    await User.findByIdAndDelete(userId);
    
    console.log(`🗑️ Account deleted: ${user.email}`);
    
    res.json({ success: true, message: 'Account deleted successfully' });
  } catch (error) {
    console.log("DELETE ACCOUNT ERROR:", error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: email.toLowerCase() });
    
    if (!user) {
      return res.status(401).json({ success: false, message: 'Неверный email или пароль' });
    }
    
    let isValidPassword = false;
    
    // Проверяем: bcrypt хеш или старый пароль
    if (user.password && user.password.startsWith('$2b$')) {
      // Новый хешированный пароль
      isValidPassword = await bcrypt.compare(password, user.password);
    } else if (user.password === password) {
      // Старый пароль - мигрируем на bcrypt
      isValidPassword = true;
      user.password = await bcrypt.hash(password, 12);
      await user.save();
      console.log('🔐 Пароль мигрирован:', user.email);
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
          referralCount: user.referralCount || 0,
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
});

app.post('/api/auth/google', async (req, res) => {
  try {
    const { googleId, email, name, avatar } = req.body;
    
    let user = await User.findOne({ $or: [{ googleId }, { email: email.toLowerCase() }] });
    
    if (user) {
      // Generate referral code if missing
      if (!user.referralCode) {
        user.referralCode = user.name.substring(0, 3).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
        await user.save();
      }
      // Обновляем googleId если пользователь существует
      if (!user.googleId) {
        user.googleId = googleId;
        user.authProvider = 'google';
        await user.save();
      }
    } else {
      // Создаём нового пользователя
      user = new User({
        email: email.toLowerCase(),
        name,
        avatar,
        googleId,
        authProvider: 'google',
        balance: 50,
        referralCode: generateReferralCode(),
        emailVerified: true, // Google уже верифицировал
        acceptedTerms: true,
        acceptedTermsAt: new Date()
      });
      await user.save();
      
      await new Transaction({
        userId: user._id,
        type: 'bonus',
        amount: 50,
        description: 'Бонус за регистрацию'
      }).save();
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
        emailVerified: user.emailVerified
      }
    });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    console.error('Google auth error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

app.post('/api/auth/apple', async (req, res) => {
  try {
    const { appleId, email, name } = req.body;
    
    let user = await User.findOne({ $or: [{ appleId }, { email: email?.toLowerCase() }] });
    
    if (user) {
      // Generate referral code if missing
      if (!user.referralCode) {
        user.referralCode = user.name.substring(0, 3).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
        await user.save();
      }
      if (!user.appleId) {
        user.appleId = appleId;
        user.authProvider = 'apple';
        await user.save();
      }
    } else {
      user = new User({
        email: email?.toLowerCase() || `apple_${appleId}@private.relay`,
        name: name || 'Пользователь',
        appleId,
        authProvider: 'apple',
        balance: 50,
        referralCode: generateReferralCode(),
        emailVerified: true,
        acceptedTerms: true,
        acceptedTermsAt: new Date()
      });
      await user.save();
      
      await new Transaction({
        userId: user._id,
        type: 'bonus',
        amount: 50,
        description: 'Бонус за регистрацию'
      }).save();
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
        emailVerified: user.emailVerified
      }
    });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    console.error('Apple auth error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// ==================== RATING ====================

app.post('/api/ratings', async (req, res) => {
  try {
    const { fromUserId, toUserId, bookingId, rating, problems, comment } = req.body;
    
    // Проверяем что бронирование существует и завершено
    const booking = await Booking.findById(bookingId);
    if (!booking || booking.status !== 'completed') {
      return res.status(400).json({ success: false, message: 'Бронирование не найдено или не завершено' });
    }
    
    // Проверяем что пользователь участвовал в бронировании
    console.log("RATING DEBUG:", { fromUserId, bookingOwnerId: booking.ownerId.toString(), bookingUserId: booking.userId.toString() });
    const isOwner = booking.ownerId.toString() === fromUserId;
    const isBooker = booking.userId.toString() === fromUserId;
    
    if (!isOwner && !isBooker) {
      return res.status(403).json({ success: false, message: 'Вы не участвовали в этом бронировании' });
    }
    
    // Проверяем что ещё не ставили оценку
    const existingRating = await Rating.findOne({ fromUserId, bookingId });
    if (existingRating) {
      return res.status(400).json({ success: false, message: 'Вы уже оставили оценку' });
    }
    
    // Создаём рейтинг
    const newRating = new Rating({
      fromRole: isOwner ? "owner" : "driver",
      fromUserId,
      toUserId,
      bookingId,
      rating,
      problems: problems || [],
      comment
    });
    await newRating.save();
    
    // Обновляем рейтинг пользователя
    const targetUser = await User.findById(toUserId);
    if (targetUser) {
      targetUser.totalRatingSum += rating;
      targetUser.ratingCount += 1;
      targetUser.rating = targetUser.totalRatingSum / targetUser.ratingCount;
      await targetUser.save();
    }
    
    // Обновляем статус оценки в бронировании
    if (isOwner) {
      booking.ownerRatedBooker = true;
    } else {
      booking.bookerRatedOwner = true;
    }
    await booking.save();
    
    res.json({ success: true, message: 'Оценка сохранена' });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    console.error('Rating error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

app.get('/api/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json(null);
    res.json(user);
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json(null);
  }
});


app.put("/api/users/:id", async (req, res) => {
  try {
    const { car, avatar, language } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    if (car) user.car = car;
    if (avatar) user.avatar = avatar;
    if (language) user.language = language;
    if (req.body.lastLocation) user.lastLocation = req.body.lastLocation;
    await user.save();
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.post('/api/users/:id/update-location', async (req, res) => {
  try {
    const { location } = req.body;
    await User.findByIdAndUpdate(req.params.id, { lastLocation: location, lastActivity: new Date() });
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false });
  }
});

// Save push token
app.post('/api/users/:id/push-token', async (req, res) => {
  try {
    const { pushToken } = req.body;
    await User.findByIdAndUpdate(req.params.id, { pushToken });
    console.log('Push token saved for user:', req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false });
  }
});
app.get('/api/users/:id/ratings', async (req, res) => {
  try {
    const ratings = await Rating.find({ toUserId: req.params.id })
      .populate('fromUserId', 'name avatar')
      .sort({ createdAt: -1 })
      .limit(20);
    res.json(ratings);
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.json([]);
  }
});

// ==================== USER HISTORY ====================

app.get('/api/users/:id/history', async (req, res) => {
  try {
    const userId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.json([]);
    const transactions = await Transaction.find({ userId }).sort({ createdAt: -1 }).limit(50);
    res.json(transactions);
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.json([]);
  }
});

// ==================== PARKINGS ====================


// ==================== HELP REQUESTS ====================

app.get('/api/help-requests', async (req, res) => {
  try {
    const requests = await HelpRequest.find({ status: { $in: ['active', 'accepted'] }, expiresAt: { $gt: new Date() } })
      .populate('userId', 'name car avatar rating').populate('helperId', 'name car avatar rating');
    res.json(requests);
  } catch (error) {
    res.status(500).json([]);
  }
});

app.post('/api/help-requests/create', async (req, res) => {
  try {
    const { userId, location, address, problemType, description, reward } = req.body;
    const helpRequest = new HelpRequest({
      userId, location, address, problemType, description,
      reward: reward || 10,
      expiresAt: new Date(Date.now() + 60 * 60000)
    });
    await helpRequest.save();
    res.json({ success: true, helpRequest });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

app.post('/api/help-requests/:id/accept', async (req, res) => {
  try {
    const { helperId } = req.body;
    const request = await HelpRequest.findById(req.params.id);
    if (!request || request.status !== 'active') return res.status(404).json({ success: false });
    request.status = 'accepted';
    request.helperId = helperId;
    await request.save();
    res.json({ success: true, request });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

app.post('/api/help-requests/:id/update-helper-location', async (req, res) => {
  try {
    const { location } = req.body;
    const request = await HelpRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ success: false });
    request.helperLocation = location;
    await request.save();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

app.post('/api/help-requests/:id/helper-arrived', async (req, res) => {
  try {
    const request = await HelpRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ success: false });
    request.helperArrived = true;
    await request.save();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

app.get('/api/users/:id/my-help-request', async (req, res) => {
  try {
    const userId = req.params.id;
    let request = await HelpRequest.findOne({ userId, status: { $in: ['active', 'accepted'] } })
      .populate('helperId', 'name car avatar rating');
    if (!request) {
      request = await HelpRequest.findOne({ helperId: userId, status: 'accepted' })
        .populate('userId', 'name car avatar rating').populate('helperId', 'name car avatar rating');
    }
    res.json(request);
  } catch (error) {
    res.json(null);
  }
});


app.post('/api/help-requests/:id/complete', async (req, res) => {
  try {
    const request = await HelpRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ success: false });
    
    const requester = await User.findById(request.userId);
    const helper = await User.findById(request.helperId);
    
    if (!requester || !helper) {
      return res.status(404).json({ success: false, message: 'Users not found' });
    }
    
    if (requester.balance < request.reward) {
      return res.status(400).json({ success: false, message: 'Not enough points' });
    }
    
    requester.balance -= request.reward;
    helper.balance += Math.floor(request.reward * 0.75);
    
    await requester.save();
    await helper.save();
    
    request.status = 'completed';
    await request.save();
    
    await Transaction.create({ userId: request.userId, type: 'help_payment', amount: -request.reward, description: 'Help payment' });
    await Transaction.create({ userId: request.helperId, type: 'help_reward', amount: Math.floor(request.reward * 0.75), description: 'Help reward' });
    
    res.json({ success: true });
  } catch (error) {
    console.log('HELP COMPLETE ERROR:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/help-requests/:id/cancel', async (req, res) => {
  try {
    const request = await HelpRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ success: false });
    request.status = 'cancelled';
    await request.save();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});


app.get('/api/stats', async (req, res) => {
  try {
    const { lat, lng } = req.query;
    const totalUsers = await User.countDocuments();
    
    let nearbyUsers = 0;
    if (lat && lng) {
      const fiveMinAgo = new Date(Date.now() - 5 * 60000);
      const users = await User.find({ lastLocation: { $exists: true }, lastActivity: { $gte: fiveMinAgo } });
      const userLat = parseFloat(lat);
      const userLng = parseFloat(lng);
      nearbyUsers = users.filter(u => {
        if (!u.lastLocation) return false;
        const dist = Math.sqrt(Math.pow(u.lastLocation.lat - userLat, 2) + Math.pow(u.lastLocation.lng - userLng, 2));
        return dist < 0.05;
      }).length;
    }
    
    res.json({ totalUsers, nearbyUsers });
  } catch (error) {
    res.json({ totalUsers: 0, nearbyUsers: 0 });
  }
});
app.get('/api/parkings/nearby', async (req, res) => {
  try {
    const parkings = await Parking.find({ status: 'available', $or: [{ expiresAt: { $gt: new Date() } }, { expiresAt: { $exists: false }, timeToLeave: { $gt: 0 } }] })
      .populate('ownerId', 'name car avatar rating ratingCount');
    const result = parkings.map(p => ({
      ...p.toObject(),
      timeToLeave: p.expiresAt ? Math.max(0, Math.round((new Date(p.expiresAt) - new Date()) / 60000)) : p.timeToLeave
    }));
    res.json(result);
  } catch (error) {
    console.log("GET PARKINGS ERROR:", error);
    res.status(500).json([]);
  }
});

app.post('/api/parkings/create', async (req, res) => {
  try {
    console.log("CREATE REQ BODY:", req.body);
    const { ownerId, location, address, price, timeToLeave } = req.body;
    const existing = await Parking.findOne({ ownerId, status: { $in: ['available', 'booked'] } });
    if (existing) {
      return res.status(400).json({ success: false, message: 'У вас уже есть активная парковка' });
    }
    const owner = await User.findById(ownerId);
    const newParking = new Parking({
      ownerId, location, address, price, timeToLeave, expiresAt: new Date(Date.now() + timeToLeave * 60000), status: 'available',
      ownerCar: owner?.car, ownerAvatar: owner?.avatar, ownerRating: owner?.rating,
      extensionsUsed: 0, messages: []
    });
    await newParking.save();
    res.json({ success: true, message: 'Парковка создана!', parking: newParking });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

app.post('/api/parkings/book', async (req, res) => {
  try {
    const { parkingId, userId } = req.body;
    
    // Предварительные проверки
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });
    
    const parkingCheck = await Parking.findById(parkingId);
    if (!parkingCheck) return res.status(404).json({ success: false, message: 'Парковка не найдена' });
    if (parkingCheck.ownerId.toString() === userId) return res.status(400).json({ success: false, message: 'Нельзя забронировать свою парковку' });
    if (user.balance < parkingCheck.price) return res.status(400).json({ success: false, message: 'Недостаточно баллов' });

    // ✅ АТОМАРНАЯ ОПЕРАЦИЯ: бронируем только если status === 'available'
    const parking = await Parking.findOneAndUpdate(
      { _id: parkingId, status: 'available' },  // Условие: только если available
      { 
        status: 'booked',
        bookedBy: userId,
        bookedAt: new Date(),
        bookerCar: user.car,
        bookerName: user.name,
        bookerAvatar: user.avatar,
        bookerRating: user.rating
      },
      { new: true }  // Вернуть обновлённый документ
    );

    // Если parking === null, значит кто-то уже забронировал
    if (!parking) {
      return res.status(400).json({ success: false, message: 'Парковка уже занята' });
    }

    // Теперь безопасно списываем баллы (парковка уже наша)
    user.balance -= parking.price;
    await user.save();

    const platformFee = Math.ceil(parking.price * 0.25);
    const ownerEarnings = parking.price - platformFee;

    // Начисляем владельцу атомарно
    const owner = await User.findByIdAndUpdate(
      parking.ownerId,
      { $inc: { balance: ownerEarnings } },
      { new: true }
    );
    
    console.log("=== BOOKING PAYMENT (ATOMIC) ===");
    console.log("Parking ID:", parkingId);
    console.log("User paid:", parking.price);
    console.log("Owner earned:", ownerEarnings);
    console.log("Platform fee:", platformFee);

    const booking = new Booking({
      parkingId: parking._id, userId, ownerId: parking.ownerId,
      address: parking.address, price: parking.price, ownerEarnings, platformFee, status: 'active'
    });
    await booking.save();

    await new Transaction({ userId, type: 'payment', amount: -parking.price, description: `Бронирование: ${parking.address}`, bookingId: booking._id }).save();
    await new Transaction({ userId: parking.ownerId, type: 'earning', amount: ownerEarnings, description: `Заработок: ${parking.address}`, bookingId: booking._id }).save();
    await new Transaction({ type: 'commission', amount: platformFee, description: `Комиссия: ${parking.address}`, bookingId: booking._id }).save();

    // Push notification to owner
    if (owner && owner.pushToken) {
      const lang = owner.language || 'en';
      const title = getPushText('booking', 'title', lang);
      const body = getPushText('booking', 'body', lang, { name: user.name });
      sendPushNotification(owner.pushToken, title, body, { type: 'booking', parkingId: parking._id.toString() });
    }

    res.json({
      success: true, message: `Забронировано! -${parking.price} баллов`, newBalance: user.balance,
      parking: { ...parking.toObject(),
        bookingId: booking?._id, ownerName: owner?.name, ownerCar: owner?.car, ownerAvatar: owner?.avatar, ownerRating: owner?.rating },
      bookingId: booking._id
    });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

app.get('/api/users/:id/my-parkings', async (req, res) => {
  try {
    const parkings = await Parking.find({ ownerId: req.params.id, status: { $in: ['available', 'booked'] } })
      .populate('bookedBy', 'name car avatar rating');
    res.json(parkings);
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.json([]);
  }
});

app.get('/api/users/:id/my-booking', async (req, res) => {
  try {
    const parking = await Parking.findOne({ bookedBy: req.params.id, status: 'booked' })
      .populate('ownerId', 'name car avatar rating');
    if (parking) {
      const booking = await Booking.findOne({ parkingId: parking._id, status: "active" });
      res.json({
        ...parking.toObject(),
        bookingId: booking?._id,
        ownerName: parking.ownerId?.name || 'Владелец',
        ownerCar: parking.ownerId?.car,
        ownerAvatar: parking.ownerId?.avatar,
        ownerRating: parking.ownerId?.rating
      });
    } else {
      res.json(null);
    }
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.json(null);
  }
});

app.get('/api/users/:id/completed-bookings', async (req, res) => {
  try {
    const userId = req.params.id;
    const bookings = await Booking.find({
      $or: [{ userId }, { ownerId: userId }],
      status: 'completed'
    })
      .populate('userId', 'name avatar rating')
      .populate('ownerId', 'name avatar rating')
      .sort({ completedAt: -1 })
      .limit(20);
    
    // Добавляем информацию о том, нужно ли ставить оценку
    const bookingsWithRatingInfo = bookings.map(b => {
      const isOwner = b.ownerId._id.toString() === userId;
      const needsRating = isOwner ? !b.ownerRatedBooker : !b.bookerRatedOwner;
      return {
        ...b.toObject(),
        isOwner,
        needsRating,
        otherUser: isOwner ? b.userId : b.ownerId
      };
    });
    
    res.json(bookingsWithRatingInfo);
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.json([]);
  }
});

app.post('/api/parkings/:id/extend', async (req, res) => {
  try {
    const { minutes } = req.body;
    const parking = await Parking.findById(req.params.id);
    if (!parking) return res.status(404).json({ success: false });
    if (parking.extensionsUsed >= 2) return res.status(400).json({ success: false, message: 'Лимит продлений' });
    parking.expiresAt = new Date(parking.expiresAt.getTime() + minutes * 60000);
    parking.extensionsUsed += 1;
    await parking.save();
    res.json({ success: true, parking });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json({ success: false });
  }
});

app.put('/api/parkings/:id/comment', async (req, res) => {
  try {
    await Parking.findByIdAndUpdate(req.params.id, { comment: req.body.comment });
    res.json({ success: true });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json({ success: false });
  }
});

app.delete('/api/parkings/:id', async (req, res) => {
  try {
    const parking = await Parking.findById(req.params.id);
    if (!parking) return res.status(404).json({ success: false });
    if (parking.status === 'booked') return res.status(400).json({ success: false, message: 'Нельзя отменить забронированную парковку' });
    parking.status = 'cancelled';
    await parking.save();
    res.json({ success: true });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json({ success: false });
  }
});

app.post('/api/parkings/:id/cancel-booking', async (req, res) => {
  try {
    const { userId, reason } = req.body;
    const parking = await Parking.findById(req.params.id);
    if (!parking) return res.status(404).json({ success: false });

    await new Transaction({ userId, type: 'cancellation', amount: 0, description: `Отмена брони: ${parking.address}` }).save();

    parking.status = 'available';
    parking.bookedBy = null;
    parking.bookedAt = null;
    parking.bookerCar = null;
    parking.bookerName = null;
    parking.bookerAvatar = null;
    parking.messages = [];
    await parking.save();
    res.json({ success: true });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json({ success: false });
  }
});

app.post('/api/parkings/:id/cancel-waiting', async (req, res) => {
  try {
    const { ownerId, reason } = req.body;
    const parking = await Parking.findById(req.params.id);
    if (!parking) return res.status(404).json({ success: false });
    await new Transaction({ userId: ownerId, type: 'cancellation', amount: 0, description: `Владелец отменил: ${parking.address}` }).save();
    parking.status = 'cancelled';
    await parking.save();
    res.json({ success: true });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json({ success: false });
  }
});

app.post('/api/parkings/:id/update-location', async (req, res) => {
  try {
    await Parking.findByIdAndUpdate(req.params.id, { bookerLocation: req.body.location });
    res.json({ success: true });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json({ success: false });
  }
});

app.post('/api/parkings/:id/arrived', async (req, res) => {
  try {
    const parking = await Parking.findById(req.params.id);
    if (!parking) return res.status(404).json({ success: false });
    parking.arrivedAt = new Date();
    await parking.save();
    
    // Push notification to owner - driver arrived
    const owner = await User.findById(parking.ownerId);
    const booker = await User.findById(parking.bookedBy);
    if (owner && owner.pushToken) {
      const lang = owner.language || 'en';
      const title = getPushText('arrived', 'title', lang);
      const body = getPushText('arrived', 'body', lang, { name: booker?.name || 'Driver' });
      sendPushNotification(owner.pushToken, title, body, { type: 'arrived', parkingId: parking._id.toString() });
    }
    res.json({ success: true, parking });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json({ success: false });
  }
});

app.post('/api/parkings/:id/confirm-meet', async (req, res) => {
  try {
    const parking = await Parking.findById(req.params.id);
    if (!parking) return res.status(404).json({ success: false });
    parking.confirmedAt = new Date();
    parking.status = 'completed';
    await parking.save();
    
    const booking = await Booking.findOneAndUpdate(
      { parkingId: parking._id, status: 'active' },
      { status: 'completed', completedAt: new Date() },
      { new: true }
    );

    // Push notification to booker - deal completed (no earnings, just confirmation)
    const booker = await User.findById(parking.bookedBy);
    if (booker && booker.pushToken) {
      const lang = booker.language || 'en';
      const title = getPushText('completedBooker', 'title', lang);
      const body = getPushText('completedBooker', 'body', lang);
      sendPushNotification(booker.pushToken, title, body, { type: 'completed', parkingId: parking._id.toString() });
    }
    
    // Push notification to owner - you earned points
    const owner = await User.findById(parking.ownerId);
    if (owner && owner.pushToken) {
      const lang = owner.language || 'en';
      const ownerEarnings = Math.floor(parking.price * 0.75);
      const title = getPushText('completed', 'title', lang);
      const body = getPushText('completed', 'body', lang, { amount: ownerEarnings.toString() });
      sendPushNotification(owner.pushToken, title, body, { type: 'completed', parkingId: parking._id.toString() });
    }
    
    // Обновляем статистику пользователей
    await User.findByIdAndUpdate(parking.ownerId, { $inc: { parkingsGiven: 1 } });
    await User.findByIdAndUpdate(parking.bookedBy, { $inc: { parkingsReceived: 1 } });
    
    // Обновляем exchangeCount в Friendship если они друзья
    await Friendship.updateOne(
      {
        $or: [
          { user1: parking.ownerId, user2: parking.bookedBy },
          { user1: parking.bookedBy, user2: parking.ownerId }
        ],
        status: 'accepted'
      },
      { $inc: { exchangeCount: 1 } }
    );
    
    res.json({ success: true, message: 'Сделка завершена!', bookingId: booking?._id });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json({ success: false });
  }
});

// ==================== CHAT ====================

app.get('/api/parkings/:id/messages', async (req, res) => {
  try {
    const parking = await Parking.findById(req.params.id);
    res.json(parking?.messages || []);
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.json([]);
  }
});

app.post('/api/parkings/:id/messages', async (req, res) => {
  try {
    const { userId, text, isOwner } = req.body;
    const parking = await Parking.findById(req.params.id);
    if (!parking) return res.status(404).json({ success: false });
    const user = await User.findById(userId);
    parking.messages = parking.messages || [];
    parking.messages.push({
      userId, senderName: user?.name || 'Пользователь', text, isOwner,
      time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
      createdAt: new Date()
    });
    await parking.save();
    
    // Push notification to the other user
    const recipientId = isOwner ? parking.bookedBy : parking.ownerId;
    const recipient = await User.findById(recipientId);
    if (recipient && recipient.pushToken) {
      const lang = recipient.language || 'en';
      const title = getPushText('message', 'title', lang);
      const shortText = text.length > 50 ? text.substring(0, 50) + '...' : text;
      const body = getPushText('message', 'body', lang, { name: user?.name || 'User', text: shortText });
      sendPushNotification(recipient.pushToken, title, body, { type: 'message', parkingId: parking._id.toString() });
    }
    res.json({ success: true, messages: parking.messages });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json({ success: false });
  }
});

app.post('/api/parkings/:id/wait-request', async (req, res) => {
  try {
    const { minutes, fromUserId } = req.body;
    const parking = await Parking.findById(req.params.id);
    if (!parking) return res.status(404).json({ success: false });
    parking.waitRequest = { minutes, fromUserId, createdAt: new Date() };
    await parking.save();
    
    // Push notification - wait request
    const sender = await User.findById(fromUserId);
    const recipientId = fromUserId === parking.ownerId?.toString() ? parking.bookedBy : parking.ownerId;
    const recipient = await User.findById(recipientId);
    if (recipient && recipient.pushToken) {
      const lang = recipient.language || 'en';
      const title = getPushText('waitRequest', 'title', lang);
      const body = getPushText('waitRequest', 'body', lang, { name: sender?.name || 'User', min: minutes.toString() });
      sendPushNotification(recipient.pushToken, title, body, { type: 'waitRequest', parkingId: parking._id.toString() });
    }
    res.json({ success: true });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json({ success: false });
  }
});

app.post("/api/parkings/:id/wait-response", async (req, res) => {
  try {
    const { accepted } = req.body;
    const parking = await Parking.findById(req.params.id);
    if (!parking) return res.status(404).json({ success: false });
    
    if (accepted && parking.waitRequest) {
      parking.expiresAt = new Date(parking.expiresAt.getTime() + parking.waitRequest.minutes * 60000);
    }
    
    // Save response for owner to see
    parking.waitResponse = { accepted, respondedAt: new Date() };
    parking.waitRequest = null;
    await parking.save();
    
    res.json({ success: true, accepted });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json({ success: false });
  }
});

app.post("/api/admin/clear-users", async (req, res) => {
  try {
    const result = await User.deleteMany({ email: { $ne: "admin@test.com" } });
    await Transaction.deleteMany({ userId: { $ne: null } });
    res.json({ success: true, deleted: result.deletedCount });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});


app.get("/api/admin/export-users", async (req, res) => {
  try {
    const users = await User.find({}).select("-__v").lean();
    const transactions = await Transaction.find({}).lean();
    
    const exportData = users.map(user => {
      const userTransactions = transactions.filter(t => 
        t.userId && t.userId.toString() === user._id.toString()
      );
      const totalEarned = userTransactions.filter(t => t.amount > 0).reduce((sum, t) => sum + t.amount, 0);
      const totalSpent = userTransactions.filter(t => t.amount < 0).reduce((sum, t) => sum + Math.abs(t.amount), 0);
      
      return {
        id: user._id,
        name: user.name,
        email: user.email,
        password: '[PROTECTED]',
        balance: user.balance,
        rating: user.rating || 5,
        ratingCount: user.ratingCount || 0,
        referralCode: user.referralCode,
        referredBy: user.referredBy,
        emailVerified: user.emailVerified,
        isAdmin: user.isAdmin,
        car: user.car,
        createdAt: user.createdAt,
        totalEarned,
        totalSpent,
        transactionCount: userTransactions.length,
        transactions: userTransactions.slice(0, 50)
      };
    });
    
    res.json(exportData);
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json({ error: "Export failed" });
  }
});

app.get("/api/admin/parkings", async (req, res) => {
  try {
    const parkings = await Parking.find({}).populate("ownerId", "name email").populate("bookedBy", "name email").sort({ createdAt: -1 });
    res.json(parkings);
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json([]);
  }
});


app.put('/api/admin/parkings/:id', async (req, res) => {
  try {
    const parking = await Parking.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ success: true, parking });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json({ success: false });
  }
});

app.delete('/api/admin/parkings/:id', async (req, res) => {
  try {
    await Parking.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json({ success: false });
  }
});

app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await User.find({}).sort({ createdAt: -1 });
    res.json(users);
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json([]);
  }
});

app.post("/api/admin/add-points", async (req, res) => {
  try {
    const { userId, amount } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    user.balance += amount;
    await user.save();
    await new Transaction({ userId, type: "bonus", amount, description: "Админ начисление" }).save();
    res.json({ success: true, newBalance: user.balance });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json({ success: false });
  }
});

app.get('/api/admin/commissions', async (req, res) => {
  try {
    const commissions = await Transaction.find({ type: 'commission' }).sort({ createdAt: -1 });
    const total = commissions.reduce((sum, t) => sum + t.amount, 0);
    res.json({ total, count: commissions.length, transactions: commissions });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json({ total: 0, count: 0, transactions: [] });
  }
});

app.get('/api/admin/transactions', async (req, res) => {
  try {
    const transactions = await Transaction.find({}).populate('userId', 'name email').sort({ createdAt: -1 }).limit(100);
    res.json(transactions);
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json([]);
  }
});

// ==================== DEBUG ====================

app.get('/api/debug/transactions', async (req, res) => {
  try {
    const all = await Transaction.find({}).sort({ createdAt: -1 }).limit(20);
    res.json({ count: all.length, transactions: all });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== TERMS ====================

app.get('/api/terms', (req, res) => {
  res.json({
    version: '1.0',
    lastUpdated: '2026-01-08',
    content: `
PARKBRO USER AGREEMENT

1. GENERAL PROVISIONS

1.1. ParkBro is a peer-to-peer (P2P) platform that connects a community of drivers ("Parking Brotherhood") who help each other find parking spots.

1.2. The service is NOT a commercial parking facility and does NOT engage in selling or reselling parking spaces.

1.3. Users voluntarily share information about their plans to vacate a parking spot, helping other community members.

2. COMMUNITY PRINCIPLES

2.1. The Parking Brotherhood is based on mutual assistance and voluntary participation.

2.2. Points in the system are an internal gratitude currency and have NO monetary equivalent.

2.3. Members help each other solely out of a desire to make parking easier and faster for the entire community.

3. LIABILITY

3.1. ParkBro is an information platform and is not responsible for:
- Availability of specific parking spots
- Actions or inactions of other users
- Accuracy of information provided by users

3.2. Users make their own decisions about using information from the service.

4. TERMS OF USE

4.1. It is prohibited to use the service for commercial resale of parking spaces.

4.2. Users agree to provide accurate information.

4.3. Abuse of the system may result in account suspension.

5. CONTACT

For all inquiries: c110ko30rus@gmail.com

© 2026 ParkBro. All rights reserved.
    `
  });
});

// ==================== ADMIN SETUP ====================

async function createAdminIfNeeded() {
  try {
    let admin = await User.findOne({ email: 'admin@parkbro.com' });
    if (!admin) {
      const hashedAdminPassword = await bcrypt.hash('admin123', 12);
      admin = new User({
        email: 'admin@parkbro.com',
        password: hashedAdminPassword,
        name: 'Администратор',
        balance: 1000,
        isAdmin: true,
        language: 'ru',
        referralCode: generateReferralCode(),
        emailVerified: true,
        acceptedTerms: true
      });
      await admin.save();
      console.log('👑 Админ создан: admin@parkbro.com / admin123');
    }
    console.log('✅ Сервер готов');
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    console.error('Admin setup error:', error);
  }
}

// ==================== START ====================

app.listen(PORT, () => {
  console.log(`🚗 ParkBro API running on port ${PORT}`);
});
