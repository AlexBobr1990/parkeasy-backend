const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Берём URL из переменной окружения или используем дефолтный
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://parkingapp:wmoU4mDhWsRb4VaQ@eazypark.xhy0jyi.mongodb.net/parkingapp?retryWrites=true&w=majority';

// Порт тоже из переменной окружения (Railway сам задаёт PORT)
const PORT = process.env.PORT || 3001;

// ==================== SCHEMAS ====================

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  balance: { type: Number, default: 50 },
  car: {
    brand: String, model: String, color: String, plate: String,
    size: String, length: Number, width: Number, year: String
  },
  avatar: String,
  language: { type: String, default: 'ru' },
  isAdmin: { type: Boolean, default: false },
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
  bookerCar: { brand: String, model: String, color: String, plate: String, size: String, length: Number, width: Number },
  bookerName: String,
  bookerAvatar: String,
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
  completedAt: Date,
  createdAt: { type: Date, default: Date.now }
});

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, enum: ['deposit', 'payment', 'earning', 'bonus', 'commission', 'cancellation', 'penalty'], required: true },
  amount: { type: Number, required: true },
  description: { type: String, required: true },
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
  metadata: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Parking = mongoose.model('Parking', parkingSchema);
const Booking = mongoose.model('Booking', bookingSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);

// ==================== CONNECT ====================

mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('✅ MongoDB подключена!');
    createDemoData();
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
  } catch (error) {}
}, 60000);

// ==================== ROUTES ====================

// Главная страница
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'ParkEasy API is running!' });
});

// ==================== AUTH ====================

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: email.toLowerCase(), password });
    if (user) {
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
          isAdmin: user.isAdmin || false
        } 
      });
    } else {
      res.status(401).json({ success: false, message: 'Неверный email или пароль' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, car } = req.body;
    const lowerEmail = email.toLowerCase();
    if (await User.findOne({ email: lowerEmail })) {
      return res.status(400).json({ success: false, message: 'Email уже зарегистрирован' });
    }
    const newUser = new User({ email: lowerEmail, password, name, balance: 50, car, language: 'ru' });
    await newUser.save();
    
    await new Transaction({ userId: newUser._id, type: 'bonus', amount: 50, description: 'Бонус за регистрацию' }).save();
    
    res.json({ 
      success: true, 
      message: 'Регистрация успешна! +50 баллов', 
      user: { id: newUser._id.toString(), email: newUser.email, name: newUser.name, balance: newUser.balance, car: newUser.car, language: 'ru' } 
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
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
    res.json([]);
  }
});

// ==================== PARKINGS ====================

app.get('/api/parkings/nearby', async (req, res) => {
  try {
    const parkings = await Parking.find({ status: 'available', timeToLeave: { $gt: 0 } })
      .populate('ownerId', 'name car avatar');
    res.json(parkings);
  } catch (error) {
    res.status(500).json([]);
  }
});

app.post('/api/parkings/create', async (req, res) => {
  try {
    const { ownerId, location, address, price, timeToLeave } = req.body;
    const existing = await Parking.findOne({ ownerId, status: { $in: ['available', 'booked'] } });
    if (existing) {
      return res.status(400).json({ success: false, message: 'У вас уже есть активная парковка' });
    }
    const owner = await User.findById(ownerId);
    const newParking = new Parking({
      ownerId, location, address, price, timeToLeave, status: 'available', 
      ownerCar: owner?.car, ownerAvatar: owner?.avatar, extensionsUsed: 0, messages: []
    });
    await newParking.save();
    res.json({ success: true, message: 'Парковка создана!', parking: newParking });
  } catch (error) {
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
    if (owner) {
      owner.balance += ownerEarnings;
      await owner.save();
    }

    parking.status = 'booked';
    parking.bookedBy = userId;
    parking.bookedAt = new Date();
    parking.bookerCar = user.car;
    parking.bookerName = user.name;
    parking.bookerAvatar = user.avatar;
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
      parking: { ...parking.toObject(), ownerName: owner?.name, ownerCar: owner?.car, ownerAvatar: owner?.avatar }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

app.get('/api/users/:id/my-parkings', async (req, res) => {
  try {
    const parkings = await Parking.find({ ownerId: req.params.id, status: { $in: ['available', 'booked'] } })
      .populate('bookedBy', 'name car avatar');
    res.json(parkings);
  } catch (error) {
    res.json([]);
  }
});

app.get('/api/users/:id/my-booking', async (req, res) => {
  try {
    const parking = await Parking.findOne({ bookedBy: req.params.id, status: 'booked' })
      .populate('ownerId', 'name car avatar');
    if (parking) {
      res.json({
        ...parking.toObject(),
        ownerName: parking.ownerId?.name || 'Владелец',
        ownerCar: parking.ownerId?.car,
        ownerAvatar: parking.ownerId?.avatar
      });
    } else {
      res.json(null);
    }
  } catch (error) {
    res.json(null);
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
    res.status(500).json({ success: false });
  }
});

app.put('/api/parkings/:id/comment', async (req, res) => {
  try {
    await Parking.findByIdAndUpdate(req.params.id, { comment: req.body.comment });
    res.json({ success: true });
  } catch (error) {
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
    res.status(500).json({ success: false });
  }
});

app.post('/api/parkings/:id/update-location', async (req, res) => {
  try {
    await Parking.findByIdAndUpdate(req.params.id, { bookerLocation: req.body.location });
    res.json({ success: true });
  } catch (error) {
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
    await Booking.findOneAndUpdate({ parkingId: parking._id, status: 'active' }, { status: 'completed', completedAt: new Date() });
    res.json({ success: true, message: 'Сделка завершена!' });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// ==================== CHAT ====================

app.get('/api/parkings/:id/messages', async (req, res) => {
  try {
    const parking = await Parking.findById(req.params.id);
    res.json(parking?.messages || []);
  } catch (error) {
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
    res.status(500).json({ success: false });
  }
});

app.post('/api/parkings/:id/wait-response', async (req, res) => {
  try {
    const { accepted } = req.body;
    const parking = await Parking.findById(req.params.id);
    if (!parking) return res.status(404).json({ success: false });
    if (accepted && parking.waitRequest) parking.timeToLeave += parking.waitRequest.minutes;
    parking.waitRequest = null;
    await parking.save();
    res.json({ success: true, accepted });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// ==================== USER ====================

app.get('/api/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (user) {
      res.json({ id: user._id.toString(), email: user.email, name: user.name, balance: user.balance, car: user.car, avatar: user.avatar, language: user.language || 'ru' });
    } else {
      res.status(404).json({ message: 'Не найден' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Ошибка' });
  }
});

app.put('/api/users/:id', async (req, res) => {
  try {
    const { car, avatar, language, name } = req.body;
    const updateData = {};
    if (car) updateData.car = car;
    if (avatar !== undefined) updateData.avatar = avatar;
    if (language) updateData.language = language;
    if (name) updateData.name = name;
    const user = await User.findByIdAndUpdate(req.params.id, updateData, { new: true });
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

app.post('/api/users/:id/add-balance', async (req, res) => {
  try {
    const { amount, paymentMethod } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false });
    user.balance += amount;
    await user.save();
    await new Transaction({ userId: user._id, type: 'deposit', amount, description: `Пополнение (${paymentMethod || 'карта'})` }).save();
    res.json({ success: true, newBalance: user.balance });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// ==================== ADMIN ====================

app.get('/api/admin/parkings', async (req, res) => {
  try {
    const parkings = await Parking.find({}).populate('ownerId', 'name email').populate('bookedBy', 'name email').sort({ createdAt: -1 });
    res.json(parkings);
  } catch (error) {
    res.status(500).json([]);
  }
});

app.put('/api/admin/parkings/:id', async (req, res) => {
  try {
    const parking = await Parking.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ success: true, parking });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

app.delete('/api/admin/parkings/:id', async (req, res) => {
  try {
    await Parking.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await User.find({}).sort({ createdAt: -1 });
    res.json(users);
  } catch (error) {
    res.status(500).json([]);
  }
});

app.get('/api/admin/commissions', async (req, res) => {
  try {
    const commissions = await Transaction.find({ type: 'commission' }).sort({ createdAt: -1 });
    const total = commissions.reduce((sum, t) => sum + t.amount, 0);
    res.json({ total, count: commissions.length, transactions: commissions });
  } catch (error) {
    res.status(500).json({ total: 0, count: 0, transactions: [] });
  }
});

app.get('/api/admin/transactions', async (req, res) => {
  try {
    const transactions = await Transaction.find({}).populate('userId', 'name email').sort({ createdAt: -1 }).limit(100);
    res.json(transactions);
  } catch (error) {
    res.status(500).json([]);
  }
});

// ==================== DEBUG ====================

app.get('/api/debug/transactions', async (req, res) => {
  try {
    const all = await Transaction.find({}).sort({ createdAt: -1 }).limit(20);
    res.json({ count: all.length, transactions: all });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== DEMO DATA ====================

async function createDemoData() {
  try {
    let admin = await User.findOne({ email: 'admin@test.com' });
    if (!admin) {
      admin = new User({ email: 'admin@test.com', password: 'admin123', name: 'Администратор', balance: 1000, isAdmin: true, language: 'ru' });
      await admin.save();
      await new Transaction({ userId: admin._id, type: 'bonus', amount: 1000, description: 'Начальный баланс' }).save();
    }

    let user1 = await User.findOne({ email: 'demo@test.com' });
    if (!user1) {
      user1 = new User({ email: 'demo@test.com', password: '123456', name: 'Алексей', balance: 150, car: { brand: 'Toyota', model: 'Camry', color: 'Белый', plate: 'A123BC', size: 'L' }, language: 'ru' });
      await user1.save();
      await new Transaction({ userId: user1._id, type: 'bonus', amount: 50, description: 'Бонус за регистрацию' }).save();
      await new Transaction({ userId: user1._id, type: 'deposit', amount: 100, description: 'Пополнение' }).save();
    }
    
    let user2 = await User.findOne({ email: 'test@test.com' });
    if (!user2) {
      user2 = new User({ email: 'test@test.com', password: '123456', name: 'Иван', balance: 100, car: { brand: 'BMW', model: 'X5', color: 'Чёрный', plate: 'B456CD', size: 'XL' }, language: 'ru' });
      await user2.save();
      await new Transaction({ userId: user2._id, type: 'bonus', amount: 50, description: 'Бонус за регистрацию' }).save();
    }

    console.log('✅ Demo data ready');
  } catch (error) {
    console.error('Demo error:', error);
  }
}

// ==================== START ====================

app.listen(PORT, () => {
  console.log(`🚗 ParkEasy API running on port ${PORT}`);
});
