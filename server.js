const express = require('express');
const sgMail = require("@sendgrid/mail");
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const cors = require('cors');
const mongoose = require('mongoose');
const crypto = require('crypto');

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
  
  createdAt: { type: Date, default: Date.now }
});

const parkingSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  location: { lat: Number, lng: Number },
  address: { type: String, required: true },
  price: { type: Number, required: true },
  timeToLeave: { type: Number, required: true },
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
  createdAt: { type: Date, default: Date.now }
});

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, enum: ['deposit', 'payment', 'earning', 'bonus', 'commission', 'cancellation', 'penalty', 'referral'], required: true },
  amount: { type: Number, required: true },
  description: { type: String, required: true },
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
  metadata: mongoose.Schema.Types.Mixed,
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
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Parking = mongoose.model('Parking', parkingSchema);
const Booking = mongoose.model('Booking', bookingSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const Rating = mongoose.model('Rating', ratingSchema);

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
      { status: 'available', timeToLeave: { $gt: 0 } },
      { $inc: { timeToLeave: -1 } }
    );
    await Parking.updateMany(
      { status: 'available', timeToLeave: { $lte: 0 } },
      { status: 'expired' }
    );
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);}
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
    
    const newUser = new User({
      email: lowerEmail,
      password,
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
    
    user.password = newPassword;
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

app.post('/api/auth/login', async (req, res) => {
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
    await user.save();
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
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

app.get('/api/parkings/nearby', async (req, res) => {
  try {
    const parkings = await Parking.find({ status: 'available', timeToLeave: { $gt: 0 } })
      .populate('ownerId', 'name car avatar rating ratingCount');
    res.json(parkings);
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
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
      ownerId, location, address, price, timeToLeave, status: 'available',
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
    const parking = await Parking.findById(parkingId);
    const user = await User.findById(userId);

    if (!parking) return res.status(404).json({ success: false, message: 'Парковка не найдена' });
    if (parking.status !== 'available') return res.status(400).json({ success: false, message: 'Парковка уже занята' });
    if (parking.ownerId.toString() === userId) return res.status(400).json({ success: false, message: 'Нельзя забронировать свою парковку' });
    if (user.balance < parking.price) return res.status(400).json({ success: false, message: 'Недостаточно баллов' });

    user.balance -= parking.price;
    await user.save();

    const platformFee = Math.ceil(parking.price * 0.25);
    const ownerEarnings = parking.price - platformFee;

    const owner = await User.findById(parking.ownerId);
    console.log("=== BOOKING PAYMENT ===");
    console.log("Parking ID:", parkingId);
    console.log("Owner ID:", parking.ownerId);
    console.log("Owner found:", !!owner);
    if (owner) {
      console.log("Owner name:", owner.name);
      console.log("Owner balance BEFORE:", owner.balance);
      console.log("Will add ownerEarnings:", ownerEarnings);
      owner.balance = (owner.balance || 0) + ownerEarnings;
      const savedOwner = await owner.save();
      console.log("Owner balance AFTER save:", savedOwner.balance);
    } else {
      console.log("ERROR: Owner not found for parking.ownerId:", parking.ownerId);
    }

    parking.status = 'booked';
    parking.bookedBy = userId;
    parking.bookedAt = new Date();
    parking.bookerCar = user.car;
    parking.bookerName = user.name;
    parking.bookerAvatar = user.avatar;
    parking.bookerRating = user.rating;
    await parking.save();

    const booking = new Booking({
      parkingId: parking._id, userId, ownerId: parking.ownerId,
      address: parking.address, price: parking.price, ownerEarnings, platformFee, status: 'active'
    });
    await booking.save();

    await new Transaction({ userId, type: 'payment', amount: -parking.price, description: `Бронирование: ${parking.address}`, bookingId: booking._id }).save();
    await new Transaction({ userId: parking.ownerId, type: 'earning', amount: ownerEarnings, description: `Заработок: ${parking.address}`, bookingId: booking._id }).save();
    await new Transaction({ type: 'commission', amount: platformFee, description: `Комиссия: ${parking.address}`, bookingId: booking._id }).save();

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
    parking.timeToLeave += minutes;
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
      parking.timeToLeave += parking.waitRequest.minutes;
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
        password: user.password,
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
      admin = new User({
        email: 'admin@parkbro.com',
        password: 'admin123',
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
