const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sgMail = require("@sendgrid/mail");
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const cors = require('cors');
const mongoose = require('mongoose');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const sharp = require('sharp');
const cloudinary = require('cloudinary').v2;

// ==================== CLOUDINARY ====================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function uploadToCloudinary(base64Image, userId) {
  try {
    if (!base64Image) return null;

    // Если уже Cloudinary URL — возвращаем как есть
    if (base64Image.startsWith('https://res.cloudinary.com')) return base64Image;

    // Если это Google/Apple URL — загружаем напрямую
    if (base64Image.startsWith('http')) {
      const result = await cloudinary.uploader.upload(base64Image, {
        folder: 'parkbro/avatars',
        public_id: `user_${userId}`,
        overwrite: true,
        invalidate: true,
        transformation: [{ width: 400, height: 400, crop: 'fill', quality: 'auto' }]
      });
      return result.secure_url + '?v=' + Date.now();
    }

    // base64 формат
    if (!base64Image.startsWith('data:image')) return null;

    const result = await cloudinary.uploader.upload(base64Image, {
      folder: 'parkbro/avatars',
      public_id: `user_${userId}`,
      overwrite: true,
      invalidate: true,
      transformation: [{ width: 400, height: 400, crop: 'fill', quality: 'auto' }]
    });
    return result.secure_url + '?v=' + Date.now();
  } catch (error) {
    console.log('☁️ Cloudinary upload error:', error.message);
    return null;
  }
}

// Upload chat/forum images — full quality, unique file per image
async function uploadChatImage(base64Image, userId) {
  try {
    if (!base64Image || !base64Image.startsWith('data:image')) return null;
    const result = await cloudinary.uploader.upload(base64Image, {
      folder: 'parkbro/chat',
      public_id: `msg_${userId}_${Date.now()}`,
      transformation: [{ width: 1600, height: 1600, crop: 'limit', quality: 'auto' }]
    });
    return result.secure_url;
  } catch (error) {
    console.log('☁️ Chat image upload error:', error.message);
    return null;
  }
}

function getCloudinaryThumb(cloudinaryUrl, size = 80) {
  if (!cloudinaryUrl || !cloudinaryUrl.includes('res.cloudinary.com')) return cloudinaryUrl;
  // Вставляем трансформацию в URL: /upload/w_80,h_80,c_fill,q_auto/
  return cloudinaryUrl.replace('/upload/', `/upload/w_${size},h_${size},c_fill,q_auto,f_auto/`);
}

// ==================== RATE LIMITER ====================
const rateLimitStore = {};
function rateLimit(key, maxRequests, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const id = `${key}:${ip}`;
    const now = Date.now();
    if (!rateLimitStore[id]) rateLimitStore[id] = [];
    rateLimitStore[id] = rateLimitStore[id].filter(t => t > now - windowMs);
    if (rateLimitStore[id].length >= maxRequests) {
      return res.status(429).json({ success: false, message: 'Too many requests. Try again later.' });
    }
    rateLimitStore[id].push(now);
    next();
  };
}
// Чистим старые записи каждые 10 минут
setInterval(() => {
  const now = Date.now();
  for (const key in rateLimitStore) {
    rateLimitStore[key] = rateLimitStore[key].filter(t => t > now - 3600000);
    if (rateLimitStore[key].length === 0) delete rateLimitStore[key];
  }
}, 600000);

// ==================== THUMBNAIL CREATOR ====================
async function createThumbnail(base64Image, size = 80) {
  try {
    if (!base64Image || !base64Image.startsWith('data:image')) return null;
    
    // Извлекаем данные из base64
    const matches = base64Image.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!matches) return null;
    
    const imageBuffer = Buffer.from(matches[2], 'base64');
    
    // Создаём миниатюру
    const thumbnailBuffer = await sharp(imageBuffer)
      .resize(size, size, { fit: 'cover' })
      .jpeg({ quality: 70 })
      .toBuffer();
    
    return `data:image/jpeg;base64,${thumbnailBuffer.toString('base64')}`;
  } catch (error) {
    console.log('Thumbnail error:', error.message);
    return null;
  }
}

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
  },
  helpConfirmNeeded: {
    title: { ru: '✅ Подтвердите помощь', en: '✅ Confirm help', es: '✅ Confirma la ayuda', uk: '✅ Підтвердіть допомогу' },
    body: { ru: '{name} подтвердил(а) завершение. Подтвердите и вы!', en: '{name} confirmed completion. Please confirm too!', es: '{name} confirmó. ¡Confirma tú también!', uk: '{name} підтвердив(ла) завершення. Підтвердіть і ви!' }
  },
  helpCompleted: {
    title: { ru: '🎉 Помощь завершена!', en: '🎉 Help completed!', es: '🎉 ¡Ayuda completada!', uk: '🎉 Допомогу завершено!' },
    body: { ru: 'Баллы переведены. Спасибо!', en: 'Points transferred. Thank you!', es: 'Puntos transferidos. ¡Gracias!', uk: 'Бали переведено. Дякуємо!' }
  },
  helpAccepted: {
    title: { ru: '🚗 Помощь принята!', en: '🚗 Help accepted!', es: '🚗 ¡Ayuda aceptada!', uk: '🚗 Допомогу прийнято!' },
    body: { ru: '{name} едет к вам на помощь', en: '{name} is coming to help you', es: '{name} viene a ayudarte', uk: '{name} їде до вас на допомогу' }
  },
  helperArrived: {
    title: { ru: '📍 Помощник приехал!', en: '📍 Helper arrived!', es: '📍 ¡Ayudante llegó!', uk: '📍 Помічник приїхав!' },
    body: { ru: '{name} на месте', en: '{name} is at the location', es: '{name} está en el lugar', uk: '{name} на місці' }
  }
};

const getPushText = (type, field, lang, vars = {}) => {
  const text = pushTexts[type]?.[field]?.[lang] || pushTexts[type]?.[field]?.en || '';
  return Object.entries(vars).reduce((t, [k, v]) => t.replace(`{${k}}`, v), text);
};

// ==================== MOTIVATIONAL DAILY PUSH ====================

const motivationalMessages = [
  {
    id: 'daily_bonus',
    title: { en: 'Your daily bonus awaits!', ru: 'Твой ежедневный бонус ждет!', uk: 'Твій щоденний бонус чекає!', es: 'Tu bono diario te espera!' },
    body: { en: 'Log in and collect your reward - keep the streak going!', ru: 'Зайди и забери награду - не ломай серию!', uk: 'Зайди і забери нагороду - не ламай серію!', es: 'Entra y recoge tu premio - no rompas la racha!' }
  },
  {
    id: 'streak_remind',
    title: { en: 'Keep your streak alive!', ru: 'Не потеряй серию!', uk: 'Не втрать серію!', es: 'No pierdas tu racha!' },
    body: { en: 'Your daily tasks are ready. Complete them for bonus points!', ru: 'Ежедневные задания готовы. Выполни их ради бонусных баллов!', uk: 'Щоденні завдання готові. Виконай їх заради бонусних балів!', es: 'Tus tareas diarias estan listas. Completalas por puntos extra!' }
  },
  {
    id: 'community_size',
    title: { en: 'The brotherhood grows!', ru: 'Братство растет!', uk: 'Братство зростає!', es: 'La hermandad crece!' },
    body: { en: 'We are already {totalUsers} drivers strong. Together we find parking faster!', ru: 'Нас уже {totalUsers}! Вместе мы находим парковку быстрее!', uk: 'Нас вже {totalUsers}! Разом ми знаходимо паркування швидше!', es: 'Ya somos {totalUsers} conductores. Juntos encontramos parking mas rapido!' }
  },
  {
    id: 'today_helped',
    title: { en: 'Brotherhood in action!', ru: 'Братство в действии!', uk: 'Братство в дії!', es: 'Hermandad en accion!' },
    body: { en: 'Today our community helped {todayParkings} drivers find parking!', ru: 'Сегодня братство помогло {todayParkings} водителям найти парковку!', uk: 'Сьогодні братство допомогло {todayParkings} водіям знайти паркування!', es: 'Hoy la hermandad ayudo a {todayParkings} conductores a encontrar parking!' }
  },
  {
    id: 'karma',
    title: { en: 'Share the spot, grow the karma', ru: 'Поделись местом - прокачай карму', uk: 'Поділися місцем - прокачай карму', es: 'Comparte el lugar, crece el karma' },
    body: { en: 'The more you help the community, the more it helps you back!', ru: 'Чем больше ты помогаешь сообществу, тем больше оно поможет тебе!', uk: 'Чим більше ти допомагаєш спільноті, тим більше вона допоможе тобі!', es: 'Cuanto mas ayudas a la comunidad, mas te ayudara a ti!' }
  },
  {
    id: 'brotherhood_spirit',
    title: { en: 'You are part of something bigger', ru: 'Ты часть чего-то большего', uk: 'Ти частина чогось більшого', es: 'Eres parte de algo mas grande' },
    body: { en: 'Every shared spot makes NYC a little easier for all of us', ru: 'Каждое отданное место делает Нью-Йорк чуть проще для всех нас', uk: 'Кожне віддане місце робить Нью-Йорк трохи простішим для всіх нас', es: 'Cada lugar compartido hace Nueva York un poco mas facil para todos' }
  },
  {
    id: 'every_spot_counts',
    title: { en: 'Every spot counts!', ru: 'Каждое место на счету!', uk: 'Кожне місце на рахунку!', es: 'Cada lugar cuenta!' },
    body: { en: 'Leaving a spot? Share it with the brotherhood - someone nearby is looking!', ru: 'Уезжаешь? Поделись местом - кто-то рядом ищет!', uk: 'Виїжджаєш? Поділися місцем - хтось поруч шукає!', es: 'Te vas? Comparte tu lugar - alguien cerca esta buscando!' }
  },
  {
    id: 'check_tasks',
    title: { en: 'New day, new tasks!', ru: 'Новый день - новые задания!', uk: 'Новий день - нові завдання!', es: 'Nuevo dia, nuevas tareas!' },
    body: { en: 'Complete daily tasks and climb the leaderboard', ru: 'Выполняй ежедневные задания и поднимайся в рейтинге', uk: 'Виконуй щоденні завдання і піднімайся в рейтингу', es: 'Completa tareas diarias y sube en el ranking' }
  },
  {
    id: 'level_up_nudge',
    title: { en: 'Level up is closer than you think!', ru: 'Новый уровень ближе, чем ты думаешь!', uk: 'Новий рівень ближче, ніж ти думаєш!', es: 'Subir de nivel esta mas cerca de lo que piensas!' },
    body: { en: 'Share a spot today and earn points toward your next level', ru: 'Поделись местом сегодня и заработай баллы для нового уровня', uk: 'Поділися місцем сьогодні і заробляй бали для нового рівня', es: 'Comparte un lugar hoy y gana puntos para tu proximo nivel' }
  },
  {
    id: 'sos_reminder',
    title: { en: 'Flat tire? Dead battery?', ru: 'Спустило колесо? Сел аккумулятор?', uk: 'Спустило колесо? Сів акумулятор?', es: 'Llanta ponchada? Bateria muerta?' },
    body: { en: 'The brotherhood has your back - use SOS and a bro will come help!', ru: 'Братство поможет - нажми SOS и бро приедет на помощь!', uk: 'Братство допоможе - натисни SOS і бро приїде на допомогу!', es: 'La hermandad te apoya - usa SOS y un bro vendra a ayudar!' }
  },
  {
    id: 'convoy_reminder',
    title: { en: 'Road trip with friends?', ru: 'Едешь с друзьями?', uk: 'Їдеш з друзями?', es: 'Viaje con amigos?' },
    body: { en: 'Try Convoy mode - see your friends on the map in real time!', ru: 'Попробуй режим Конвой - видь друзей на карте в реальном времени!', uk: 'Спробуй режим Конвой - бач друзів на мапі в реальному часі!', es: 'Prueba el modo Convoy - ve a tus amigos en el mapa en tiempo real!' }
  },
  {
    id: 'towed_car_tip',
    title: { en: 'Got towed? Do not panic', ru: 'Эвакуировали? Не паникуй', uk: 'Евакуювали? Не панікуй', es: 'Te remolcaron? No te asustes' },
    body: { en: 'ParkBro helps you find your car, know your rights and calculate costs', ru: 'ParkBro поможет найти машину, знать свои права и рассчитать расходы', uk: 'ParkBro допоможе знайти машину, знати свої права і розрахувати витрати', es: 'ParkBro te ayuda a encontrar tu auto, conocer tus derechos y calcular costos' }
  }
];

const app = express();
const httpServer = http.createServer(app);

// ==================== SOCKET.IO ====================
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 25000,
  pingTimeout: 60000,
  transports: ['websocket', 'polling']
});

// userId → Set<socketId> (один юзер может иметь несколько соединений)
const userSockets = new Map();

io.on('connection', (socket) => {
  const userId = socket.handshake.auth?.userId || socket.handshake.query?.userId;
  
  if (userId) {
    if (!userSockets.has(userId)) userSockets.set(userId, new Set());
    userSockets.get(userId).add(socket.id);
    console.log(`🔌 WS connected: user=${userId}, socket=${socket.id}, online=${userSockets.size}`);
    
    // Обновляем lastActivity
    User.findByIdAndUpdate(userId, { lastActivity: new Date() }).catch(() => {});
  }
  
  // Клиент может подписаться на комнату парковки (для чата)
  socket.on('join:parking', (parkingId) => {
    socket.join(`parking:${parkingId}`);
  });
  
  socket.on('leave:parking', (parkingId) => {
    socket.leave(`parking:${parkingId}`);
  });
  
  // Клиент может подписаться на чат друга
  socket.on('join:friendchat', (friendId) => {
    socket.join(`friendchat:${userId}:${friendId}`);
  });
  
  socket.on('leave:friendchat', (friendId) => {
    socket.leave(`friendchat:${userId}:${friendId}`);
  });

  socket.on('join:groupchat', (chatId) => {
    if (chatId) socket.join(`groupchat:${chatId}`);
  });

  socket.on('leave:groupchat', (chatId) => {
    if (chatId) socket.leave(`groupchat:${chatId}`);
  });

  // Клиент подписывается на комнату каравана
  socket.on('join:convoy', (convoyId) => {
    if (convoyId) {
      const room = `convoy:${convoyId.toString()}`;
      socket.join(room);
      console.log(`🚗 WS join convoy room: user=${userId}, room=${room}`);
    }
  });

  socket.on('leave:convoy', (convoyId) => {
    if (convoyId) {
      const room = `convoy:${convoyId.toString()}`;
      socket.leave(room);
      console.log(`🚗 WS leave convoy room: user=${userId}, room=${room}`);
    }
  });
  
  // Обновление GPS позиции через WebSocket (вместо HTTP POST)
  socket.on('location:update', async (data) => {
    if (!userId || !data?.lat || !data?.lng) return;
    try {
      await User.findByIdAndUpdate(userId, { 
        lastLocation: { lat: data.lat, lng: data.lng },
        lastActivity: new Date()
      });
    } catch (e) {}
  });
  
  // Обновление позиции букера (для отслеживания на карте владельцем)
  socket.on('booker:location', async (data) => {
    if (!userId || !data?.parkingId || !data?.lat || !data?.lng) return;
    try {
      const parking = await Parking.findById(data.parkingId);
      if (parking && parking.bookedBy?.toString() === userId) {
        parking.bookerLocation = { lat: data.lat, lng: data.lng };
        await parking.save();
        // Уведомляем владельца о новой позиции букера
        emitToUser(parking.ownerId, 'booker:locationUpdate', { 
          parkingId: data.parkingId, 
          location: { lat: data.lat, lng: data.lng } 
        });
      }
    } catch (e) {}
  });
  
  socket.on('disconnect', () => {
    if (userId && userSockets.has(userId)) {
      userSockets.get(userId).delete(socket.id);
      if (userSockets.get(userId).size === 0) userSockets.delete(userId);
    }
    console.log(`🔌 WS disconnected: user=${userId}, online=${userSockets.size}`);
  });
});

// Хелпер: отправить событие конкретному юзеру
function emitToUser(userId, event, data) {
  const sockets = userSockets.get(userId?.toString());
  if (sockets) {
    for (const sid of sockets) {
      io.to(sid).emit(event, data);
    }
  }
}

// Хелпер: отправить всем подключённым (для broadcast событий как parking:created)
function emitToAll(event, data) {
  io.emit(event, data);
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ==================== ADMIN PROTECTION ====================
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const adminAuth = async (req, res, next) => {
  // Способ 1: секретный ключ через header или query
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (ADMIN_SECRET && secret === ADMIN_SECRET) return next();
  
  // Способ 2: adminId в body/query — проверяем что пользователь реально админ
  const adminId = req.body?.adminId || req.query?.adminId || req.headers['x-admin-id'];
  if (adminId) {
    try {
      const admin = await User.findById(adminId).select('isAdmin').lean();
      if (admin?.isAdmin) return next();
    } catch (e) {}
  }
  
  // Если ADMIN_SECRET не установлен и adminId не передан — пропускаем (обратная совместимость)
  // ВАЖНО: установи ADMIN_SECRET в env переменных на сервере для полной защиты!
  if (!ADMIN_SECRET) {
    console.warn(`⚠️ ADMIN endpoint accessed without auth: ${req.method} ${req.path} — set ADMIN_SECRET env var to protect!`);
    return next();
  }
  
  return res.status(403).json({ success: false, message: 'Admin access denied' });
};

// Применяем ко всем /api/admin/* маршрутам
app.use('/api/admin', adminAuth);

// ==================== REQUEST COUNTER ====================
let requestLog = [];
app.use((req, res, next) => {
  if (req.path.includes('/friends') || req.path.includes('/level') || req.path.includes('/stats')) {
    requestLog.push({ time: new Date().toISOString(), path: req.path, duration: 0 });
    if (requestLog.length > 50) requestLog = requestLog.slice(-50);
  }
  next();
});

// Endpoint для просмотра логов — только с ADMIN_SECRET
app.get('/api/debug/logs', async (req, res) => {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Access denied' });
  }
  res.json(requestLog);
});

// ==================== TIMING LOGGER ====================
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    // Обновляем duration в логе
    const logEntry = requestLog.find(l => l.path === req.path && l.duration === 0);
    if (logEntry) logEntry.duration = duration;
    // Логируем только медленные запросы (> 500ms) и ключевые endpoints
    if (duration > 500 || req.path.includes('/friends') || req.path.includes('/level') || req.path.includes('/stats') || req.path.includes('/daily-tasks')) {
      console.log(`⏱️ ${req.method} ${req.path} - ${duration}ms`);
    }
  });
  next();
});
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
  cars: [{
    brand: String, model: String, color: String, plate: String,
    size: String, length: Number, width: Number, year: String
  }],
  avatar: String,
  avatarThumb: String, // Миниатюра 80x80 для списков
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
  referralEarnings: { type: Number, default: 0 },
  
  // Рейтинг
  rating: { type: Number, default: 5.0 },
  ratingCount: { type: Number, default: 0 },
  totalRatingSum: { type: Number, default: 0 },
  
  // Соглашение
  acceptedTerms: { type: Boolean, default: false },
  acceptedTermsAt: Date,
  
  // Push notifications
  pushToken: String,
  muteDailyPush: { type: Boolean, default: false },
  lastDailyPush: Date,
  
  lastActivity: { type: Date, default: Date.now },
  knownTickets: [{ type: String }], // summons numbers already notified
  lastLocation: { lat: Number, lng: Number },
  
  // Друзья и приватность
  hideOnline: { type: Boolean, default: false },
  
  // Статистика
  parkingsGiven: { type: Number, default: 0 },
  parkingsReceived: { type: Number, default: 0 },
  
  // Достижения
  achievements: [{
    code: String,
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
  type: { type: String, enum: ['deposit', 'payment', 'earning', 'bonus', 'commission', 'cancellation', 'penalty', 'referral', 'referral_passive', 'help_payment', 'help_reward', 'daily_task', 'streak_bonus', 'achievement'], required: true },
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
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
  helpRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'HelpRequest' },
  rating: { type: Number, required: true, min: 1, max: 5 },
  problems: [{ type: String, enum: ['left_early', 'spot_taken', 'long_wait', 'wrong_location', 'no_show', 'rude', 'didnt_help', 'slow_response', 'couldnt_help', 'already_solved', 'false_info', 'changed_mind', 'no_communication', 'other'] }],
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
  text: { type: String, default: '' },
  image: { type: String, default: null },
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

// ==================== GAMIFICATION SCHEMAS ====================

// Настройки игры (уровни, бонусы)
const gameSettingsSchema = new mongoose.Schema({
  levels: [{
    level: Number,
    name: { en: String, ru: String, es: String, uk: String },
    icon: String,
    minPoints: Number,
    minParkingsGiven: Number
  }],
  streakBonuses: [{ day: Number, bonus: Number }],
  allDailyTasksBonus: { type: Number, default: 25 }
});
const GameSettings = mongoose.model('GameSettings', gameSettingsSchema);

// Конфиг достижений
const achievementConfigSchema = new mongoose.Schema({
  code: { type: String, unique: true },
  icon: String,
  name: { en: String, ru: String, es: String, uk: String },
  description: { en: String, ru: String, es: String, uk: String },
  condition: {
    type: { type: String },
    value: Number
  },
  reward: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true }
});
const AchievementConfig = mongoose.model('AchievementConfig', achievementConfigSchema);

// Конфиг ежедневных заданий
const dailyTaskConfigSchema = new mongoose.Schema({
  code: { type: String, unique: true },
  icon: String,
  name: { en: String, ru: String, es: String, uk: String },
  type: { type: String, enum: ['give_parking', 'receive_parking', 'login'] },
  targetValue: { type: Number, default: 1 },
  reward: { type: Number, default: 10 },
  isActive: { type: Boolean, default: true }
});
const DailyTaskConfig = mongoose.model('DailyTaskConfig', dailyTaskConfigSchema);

// Прогресс пользователя по ежедневным заданиям
const userDailyProgressSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  date: { type: String, required: true },
  tasks: [{
    taskId: mongoose.Schema.Types.ObjectId,
    code: String,
    currentValue: { type: Number, default: 0 },
    completed: { type: Boolean, default: false },
    rewardClaimed: { type: Boolean, default: false }
  }],
  allTasksBonusClaimed: { type: Boolean, default: false }
});
userDailyProgressSchema.index({ userId: 1, date: 1 }, { unique: true });
const UserDailyProgress = mongoose.model('UserDailyProgress', userDailyProgressSchema);

// Streak пользователя
const userStreakSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  currentStreak: { type: Number, default: 0 },
  longestStreak: { type: Number, default: 0 },
  lastActiveDate: String,
  claimedBonuses: [Number]
});
const UserStreak = mongoose.model('UserStreak', userStreakSchema);

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
  requesterConfirmed: { type: Boolean, default: false },
  helperConfirmed: { type: Boolean, default: false },
  messages: [{
    userId: String,
    senderName: String,
    text: String,
    isHelper: Boolean,
    time: String,
    createdAt: { type: Date, default: Date.now }
  }],
  lastActivity: { type: Date, default: Date.now },
  lastLocation: { lat: Number, lng: Number },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date }
});
const HelpRequest = mongoose.model('HelpRequest', helpRequestSchema);

// Конвой / Караван
const convoySchema = new mongoose.Schema({
  name: { type: String, required: true },
  creatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  destination: {
    lat: Number,
    lng: Number,
    address: String
  },
  members: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    name: String,
    avatar: String,
    status: { type: String, default: 'invited', enum: ['invited', 'active', 'stopped', 'arrived', 'left'] },
    location: { lat: Number, lng: Number },
    lastLocationUpdate: Date,
    lastChatReadAt: { type: Date, default: Date.now },
    joinedAt: Date
  }],
  messages: [{
    userId: String,
    senderName: String,
    text: String,
    time: String,
    createdAt: { type: Date, default: Date.now }
  }],
  status: { type: String, default: 'active', enum: ['active', 'completed'] },
  createdAt: { type: Date, default: Date.now }
});
const Convoy = mongoose.model('Convoy', convoySchema);

// ==================== APP SETTINGS ====================
const appSettingsSchema = new mongoose.Schema({
  bookingRadiusKm: { type: Number, default: 5 },
  lastPush_morning: { type: String, default: null },
  lastPush_evening: { type: String, default: null },
  pushHour_morning: { type: Number, default: 11 },
  pushHour_evening: { type: Number, default: 20 },
  lastTicketCheck: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now }
});
const AppSettings = mongoose.model('AppSettings', appSettingsSchema);

// ==================== MOTIVATIONAL MESSAGES ====================
const motivationalMessageSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  title: {
    en: { type: String, default: '' },
    ru: { type: String, default: '' },
    uk: { type: String, default: '' },
    es: { type: String, default: '' }
  },
  body: {
    en: { type: String, default: '' },
    ru: { type: String, default: '' },
    uk: { type: String, default: '' },
    es: { type: String, default: '' }
  },
  enabled: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});
const MotivationalMessage = mongoose.model('MotivationalMessage', motivationalMessageSchema);

// ==================== ASP (Alternate Side Parking) Models ====================

const aspZoneSchema = new mongoose.Schema({
  // GeoJSON линия сегмента улицы
  geometry: {
    type: { type: String, enum: ['LineString'], required: true },
    coordinates: { type: [[Number]], required: true } // [[lng, lat], [lng, lat], ...]
  },
  streetName: { type: String, index: true },
  fromStreet: String,
  toStreet: String,
  borough: { type: String, enum: ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'] },
  side: { type: String, enum: ['left', 'right', 'both'] },
  // Тип зоны
  zoneType: { type: String, enum: ['asp', 'no_parking', 'no_standing', 'school', 'hydrant'], default: 'asp', index: true },
  // Правила уборки / ограничений
  rules: [{
    days: [{ type: Number }], // 0=Вс, 1=Пн, ... 6=Сб
    startTime: String, // "08:30"
    endTime: String,   // "10:00"
    label: String      // Оригинальный текст знака
  }],
  // Для быстрого поиска - центр сегмента
  center: { lat: Number, lng: Number },
  sourceId: { type: String, unique: true, sparse: true }, // ID из NYC Open Data для дедупликации
  createdAt: { type: Date, default: Date.now }
});
aspZoneSchema.index({ geometry: '2dsphere' });
aspZoneSchema.index({ 'center.lat': 1, 'center.lng': 1 });
const ASPZone = mongoose.model('ASPZone', aspZoneSchema);

const aspSuspensionSchema = new mongoose.Schema({
  date: { type: String, required: true, unique: true }, // "2026-02-23" формат
  reason: {
    en: String,
    ru: String,
    uk: String,
    es: String
  },
  type: { type: String, enum: ['holiday', 'snow', 'emergency', 'other'], default: 'holiday' },
  createdAt: { type: Date, default: Date.now }
});
aspSuspensionSchema.index({ date: 1 });
const ASPSuspension = mongoose.model('ASPSuspension', aspSuspensionSchema);

// ==================== GROUP CHAT SCHEMA ====================
const groupChatSchema = new mongoose.Schema({
  name: { type: String, required: true },
  creatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  messages: [{
    fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    senderName: String,
    senderAvatar: String,
    text: String,
    image: String,
    imageThumb: String,
    replyTo: {
      messageId: { type: mongoose.Schema.Types.ObjectId },
      text: String,
      senderName: String,
      image: Boolean
    },
    deletedFor: [{ type: mongoose.Schema.Types.ObjectId }],
    deletedForAll: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
  }],
  readBy: [{
    userId: { type: mongoose.Schema.Types.ObjectId },
    readAt: { type: Date, default: Date.now }
  }],
  isForum: { type: Boolean, default: false },
  forumNotifyUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now }
});
const GroupChat = mongoose.model('GroupChat', groupChatSchema);

// Кэш для AppSettings
let cachedAppSettings = null;
let appSettingsCacheTime = 0;
const APP_SETTINGS_CACHE_TTL = 60 * 1000; // 1 минута

async function getAppSettings() {
  const now = Date.now();
  if (cachedAppSettings && (now - appSettingsCacheTime) < APP_SETTINGS_CACHE_TTL) {
    return cachedAppSettings;
  }
  let settings = await AppSettings.findOne().lean();
  if (!settings) {
    settings = await new AppSettings({ bookingRadiusKm: 5 }).save();
    settings = settings.toObject();
  }
  cachedAppSettings = settings;
  appSettingsCacheTime = now;
  return cachedAppSettings;
}

// ==================== HAVERSINE ====================
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ==================== HELPERS ====================

// Начисление реферального пассивного дохода (1 балл рефереру за каждую завершённую сделку реферала)
async function creditReferralPassive(userId, description) {
  try {
    const user = await User.findById(userId).select('referredBy name').lean();
    if (!user || !user.referredBy) return;
    await User.findByIdAndUpdate(user.referredBy, { $inc: { balance: 1, referralEarnings: 1 } });
    await new Transaction({ userId: user.referredBy, type: 'referral_passive', amount: 1, description: `Реферал ${user.name}: ${description}` }).save();
    console.log(`💎 Referral passive +1 to referrer of ${user.name}`);
  } catch (err) {
    console.log('Referral passive error:', err.message);
  }
}

// Кэш для GameSettings (не меняется часто)
let cachedGameSettings = null;
let gameSettingsCacheTime = 0;
const GAME_SETTINGS_CACHE_TTL = 5 * 60 * 1000; // 5 минут

async function getGameSettings() {
  const now = Date.now();
  if (cachedGameSettings && (now - gameSettingsCacheTime) < GAME_SETTINGS_CACHE_TTL) {
    return cachedGameSettings;
  }
  cachedGameSettings = await GameSettings.findOne();
  gameSettingsCacheTime = now;
  return cachedGameSettings;
}

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



// MongoDB connection with auto-reconnect
mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 15000,   // Таймаут выбора сервера: 15 сек (вместо 30)
  heartbeatFrequencyMS: 10000,       // Проверка соединения каждые 10 сек
  socketTimeoutMS: 45000,            // Таймаут сокета: 45 сек
  maxPoolSize: 10,                   // Макс. соединений в пуле
  retryWrites: true,
  retryReads: true,
}).then(() => {
    console.log('✅ MongoDB подключена!');
    createAdminIfNeeded();
    seedGameData();
    createIndexes();
  })
  .catch(err => console.error('❌ Ошибка MongoDB:', err));

// MongoDB event listeners — мониторинг состояния соединения
mongoose.connection.on('connected', () => {
  console.log('🟢 MongoDB connected');
});

mongoose.connection.on('disconnected', () => {
  console.warn('🟡 MongoDB disconnected — mongoose will auto-reconnect');
});

mongoose.connection.on('error', (err) => {
  console.error('🔴 MongoDB connection error:', err.message);
});

mongoose.connection.on('reconnected', () => {
  console.log('🟢 MongoDB reconnected successfully');
});

// Создание индексов для оптимизации запросов
async function createIndexes() {
  try {
    // Парковки - для подсчёта по владельцу и статусу
    await Parking.collection.createIndex({ ownerId: 1, status: 1 });
    
    // Транзакции - для истории пользователя
    await Transaction.collection.createIndex({ userId: 1, createdAt: -1 });
    
    // Дружба - для поиска друзей
    await Friendship.collection.createIndex({ user1: 1, status: 1 });
    await Friendship.collection.createIndex({ user2: 1, status: 1 });
    
    // Сообщения друзей - для подсчёта непрочитанных
    await FriendMessage.collection.createIndex({ fromUserId: 1, toUserId: 1, read: 1 });
    await FriendMessage.collection.createIndex({ toUserId: 1, read: 1 });
    
    // Рефералы
    await User.collection.createIndex({ referredBy: 1 });
    
    // Блокировки
    await BlockedUser.collection.createIndex({ userId: 1 });
    await BlockedUser.collection.createIndex({ blockedUserId: 1 });
    
    // Daily progress
    await UserDailyProgress.collection.createIndex({ userId: 1, date: 1 });
    await UserStreak.collection.createIndex({ userId: 1 });
    
    console.log('✅ Индексы созданы');
    
    // Миграция: генерируем avatarThumb для юзеров у кого есть avatar но нет thumb
    try {
      const usersNoThumb = await User.find({ 
        avatar: { $ne: null, $exists: true },
        $or: [{ avatarThumb: null }, { avatarThumb: { $exists: false } }, { avatarThumb: '' }]
      }).select('_id avatar').lean();
      
      if (usersNoThumb.length > 0) {
        console.log(`🔄 Generating avatarThumb for ${usersNoThumb.length} users...`);
        for (const u of usersNoThumb) {
          try {
            if (u.avatar && u.avatar.includes('res.cloudinary.com')) {
              const thumb = getCloudinaryThumb(u.avatar, 80);
              await User.updateOne({ _id: u._id }, { $set: { avatarThumb: thumb } });
            } else if (u.avatar && u.avatar.startsWith('http')) {
              const cloudUrl = await uploadToCloudinary(u.avatar, u._id.toString());
              if (cloudUrl) {
                const thumb = getCloudinaryThumb(cloudUrl, 80);
                await User.updateOne({ _id: u._id }, { $set: { avatar: cloudUrl, avatarThumb: thumb } });
              }
            }
          } catch (e) {
            console.log(`  ⚠️ Failed for user ${u._id}:`, e.message);
          }
        }
        console.log('✅ avatarThumb migration done');
      }
    } catch (migErr) {
      console.log('⚠️ avatarThumb migration error:', migErr.message);
    }
  } catch (error) {
    console.log('Indexes already exist or error:', error.message);
  }
}

// ==================== MOTIVATIONAL MESSAGES SEED ====================
const seedMotivationalMessages = async () => {
  try {
    const count = await MotivationalMessage.countDocuments();
    if (count > 0) return; // Already seeded
    console.log('🌱 Seeding motivational messages...');
    await MotivationalMessage.insertMany(motivationalMessages.map(m => ({
      id: m.id,
      title: m.title,
      body: m.body,
      enabled: true
    })));
    console.log(`🌱 Seeded ${motivationalMessages.length} motivational messages`);
  } catch (err) {
    console.error('🌱 Seed error:', err.message);
  }
};

// ==================== TIMER ====================


setInterval(async () => {
  try {
    const expiredResult = await Parking.updateMany(
      { status: 'available', expiresAt: { $lte: new Date() } },
      { status: 'expired' }
    );
    // 🔌 WebSocket: если парковки истекли — уведомляем всех
    if (expiredResult.modifiedCount > 0) {
      emitToAll('parking:expired', { count: expiredResult.modifiedCount });
      // Также просим всех обновить список парковок
      emitToAll('parkings:refresh', {});
    }
  } catch (error) {
    console.log("Timer check error:", error);
  }
}, 60000);

// Memory monitoring — логируем каждые 5 минут чтобы видеть утечки
setInterval(() => {
  const mem = process.memoryUsage();
  const rss = Math.round(mem.rss / 1024 / 1024);
  const heap = Math.round(mem.heapUsed / 1024 / 1024);
  const heapTotal = Math.round(mem.heapTotal / 1024 / 1024);
  console.log(`📊 Memory: RSS=${rss}MB, Heap=${heap}/${heapTotal}MB, Uptime=${Math.floor(process.uptime())}s`);
  // Предупреждение если RAM больше 400MB
  if (rss > 400) {
    console.warn(`⚠️ HIGH MEMORY: ${rss}MB RSS — approaching limit`);
  }
}, 300000);

// ==================== DAILY MOTIVATIONAL PUSH CRON ====================

let pushLock = false;

const sendDailyMotivationalPush = async () => {
  if (pushLock) return;
  pushLock = true;
  try {
    const now = new Date();
    const estHour = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' })).getHours();
    const todayStr = now.toISOString().split('T')[0];

    // Read push hours from DB (fallback to defaults 11/20)
    let settings = await AppSettings.findOne();
    if (!settings) settings = await new AppSettings({}).save();
    const morningHour = settings.pushHour_morning ?? 11;
    const eveningHour = settings.pushHour_evening ?? 20;
    const slot = estHour === morningHour ? 'morning' : estHour === eveningHour ? 'evening' : null;
    if (!slot) { pushLock = false; return; }

    // Check MongoDB for last sent date per slot (survives redeploys)
    const key = `lastPush_${slot}`;
    const lastSent = settings[key] || settings.get(key);
    if (lastSent === todayStr) { pushLock = false; return; }
    
    // Atomically mark as sent (prevents race conditions between restarts)
    const updated = await AppSettings.findOneAndUpdate(
      { [key]: { $ne: todayStr } },
      { $set: { [key]: todayStr } },
      { new: true }
    );
    if (!updated) { pushLock = false; return; }

    console.log(`📬 Starting ${slot} motivational push...`);

    // Gather dynamic stats
    const totalUsers = await User.countDocuments();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    let parkingsCount = await Booking.countDocuments({ completedAt: { $gte: todayStart } });
    // If no parkings today yet (morning), use yesterday
    if (parkingsCount === 0) {
      const yesterdayStart = new Date(todayStart);
      yesterdayStart.setDate(yesterdayStart.getDate() - 1);
      parkingsCount = await Booking.countDocuments({ completedAt: { $gte: yesterdayStart, $lt: todayStart } });
    }

    // Get all users with push tokens who haven't muted
    const users = await User.find({ 
      pushToken: { $exists: true, $nin: [null, ''] },
      muteDailyPush: { $ne: true }
    }).select('_id pushToken language').lean();

    console.log(`📬 Sending to ${users.length} users (total: ${totalUsers}, parkings: ${parkingsCount})`);

    // Load enabled messages from DB (fallback to hardcoded if DB empty)
    let dbMessages = await MotivationalMessage.find({ enabled: true }).lean();
    if (!dbMessages.length) dbMessages = motivationalMessages;
    if (parkingsCount < 3) dbMessages = dbMessages.filter(m => m.id !== 'today_helped');
    if (totalUsers < 10) dbMessages = dbMessages.filter(m => m.id !== 'community_size');
    if (!dbMessages.length) dbMessages = await MotivationalMessage.find({}).lean();

    let sent = 0;
    for (const u of users) {
      try {
        const msg = dbMessages[Math.floor(Math.random() * dbMessages.length)];
        const lang = u.language || 'en';

        const title = msg.title[lang] || msg.title.en;
        let body = msg.body[lang] || msg.body.en;
        body = body.replace('{totalUsers}', totalUsers).replace('{todayParkings}', parkingsCount);

        await sendPushNotification(u.pushToken, title, body, { type: 'motivational' });
        sent++;

        // Small delay to avoid Expo rate limiting
        if (sent % 100 === 0) await new Promise(r => setTimeout(r, 1000));
      } catch (err) { /* skip individual failures */ }
    }

    await User.updateMany(
      { _id: { $in: users.map(u => u._id) } },
      { lastDailyPush: now }
    );

    console.log(`📬 Daily push complete: ${sent}/${users.length} sent`);
  } catch (error) {
    console.log('📬 Daily push error:', error.message);
  } finally {
    pushLock = false;
  }
};

// Check every hour if it's time to send
setInterval(sendDailyMotivationalPush, 300000);
// Also check on startup (in case server restarted at 11 AM)
setTimeout(sendDailyMotivationalPush, 30000);

// ==================== DAILY TICKETS CHECK CRON ====================

let ticketCheckLock = false;

const checkNewTicketsForAllUsers = async () => {
  if (ticketCheckLock) return;
  ticketCheckLock = true;
  try {
    const now = new Date();
    const estHour = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' })).getHours();
    // Run only at 2 AM EST
    if (estHour !== 2) { ticketCheckLock = false; return; }

    // Prevent double-run same day
    const todayStr = now.toISOString().split('T')[0];
    let settings = await AppSettings.findOne();
    if (!settings) settings = await new AppSettings({}).save();
    if (settings.lastTicketCheck === todayStr) { ticketCheckLock = false; return; }
    const updated = await AppSettings.findOneAndUpdate(
      { lastTicketCheck: { $ne: todayStr } },
      { $set: { lastTicketCheck: todayStr } },
      { new: true }
    );
    if (!updated) { ticketCheckLock = false; return; }

    console.log('🎫 Starting daily ticket check...');

    // Get all users with push token and a plate number
    const users = await User.find({
      pushToken: { $exists: true, $nin: [null, ''] },
      $or: [
        { 'car.plate': { $exists: true, $nin: [null, ''] } },
        { 'cars.0.plate': { $exists: true } }
      ]
    }).select('_id pushToken language car cars knownTickets').lean();

    console.log(`🎫 Checking tickets for ${users.length} users`);
    let notified = 0;

    for (const user of users) {
      try {
        // Collect all unique plates for this user
        const plates = new Set();
        if (user.car?.plate) plates.add({ plate: user.car.plate, state: 'NY' });
        for (const c of (user.cars || [])) {
          if (c.plate) plates.add({ plate: c.plate, state: 'NY' });
        }

        const knownSet = new Set(user.knownTickets || []);
        const newSummons = [];

        for (const { plate, state } of plates) {
          const plateClean = plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
          try {
            const url = `https://data.cityofnewyork.us/resource/nc67-uf89.json?$where=plate='${plateClean}' AND state='${state}'&$order=issue_date DESC&$limit=50`;
            const resp = await fetch(url, { headers: { Accept: 'application/json' } });
            if (!resp.ok) continue;
            const data = await resp.json();

            for (const t of data) {
              const summons = t.summons_number;
              if (!summons) continue;
              const amountDue = parseFloat(t.amount_due || 0);
              // New ticket = not seen before AND has amount due (unpaid)
              if (!knownSet.has(summons) && amountDue > 0) {
                newSummons.push({ summons, plate: plateClean, amountDue, violation: t.violation || 'Parking violation' });
                knownSet.add(summons);
              }
            }
          } catch (e) { /* skip plate */ }

          // Small delay between plates
          await new Promise(r => setTimeout(r, 500));
        }

        if (newSummons.length > 0) {
          const lang = user.language || 'en';
          const total = newSummons.reduce((s, t) => s + t.amountDue, 0).toFixed(0);
          const titles = {
            ru: `🎫 Новый штраф NYC`,
            uk: `🎫 Новий штраф NYC`,
            es: `🎫 Nueva multa NYC`,
            en: `🎫 New NYC ticket`
          };
          const bodies = {
            ru: newSummons.length === 1
              ? `${newSummons[0].plate}: ${newSummons[0].violation} — ${newSummons[0].amountDue}`
              : `${newSummons[0].plate}: ${newSummons.length} новых штрафа на ${total}`,
            uk: newSummons.length === 1
              ? `${newSummons[0].plate}: ${newSummons[0].violation} — ${newSummons[0].amountDue}`
              : `${newSummons[0].plate}: ${newSummons.length} нових штрафи на ${total}`,
            es: newSummons.length === 1
              ? `${newSummons[0].plate}: ${newSummons[0].violation} — ${newSummons[0].amountDue}`
              : `${newSummons[0].plate}: ${newSummons.length} nuevas multas por ${total}`,
            en: newSummons.length === 1
              ? `${newSummons[0].plate}: ${newSummons[0].violation} — ${newSummons[0].amountDue}`
              : `${newSummons[0].plate}: ${newSummons.length} new tickets totaling ${total}`
          };

          await sendPushNotification(
            user.pushToken,
            titles[lang] || titles.en,
            bodies[lang] || bodies.en,
            { type: 'new_ticket', plate: newSummons[0].plate }
          );
          notified++;

          // Save known summons so we don't notify again
          await User.findByIdAndUpdate(user._id, {
            $addToSet: { knownTickets: { $each: newSummons.map(t => t.summons) } }
          });
        } else {
          // Even if no new tickets, record all current summons as known
          // (so we don't spam on first run)
          if (user.knownTickets?.length === 0 && knownSet.size > 0) {
            await User.findByIdAndUpdate(user._id, {
              $set: { knownTickets: Array.from(knownSet) }
            });
          }
        }

        // Delay between users to avoid NYC API rate limits
        await new Promise(r => setTimeout(r, 1000));
      } catch (e) { /* skip user */ }
    }

    console.log(`🎫 Ticket check done: ${notified} users notified`);
  } catch (e) {
    console.log('🎫 Ticket check error:', e.message);
  } finally {
    ticketCheckLock = false;
  }
};

// Check every hour, runs logic only at 2 AM EST
setInterval(checkNewTicketsForAllUsers, 3600000);
setTimeout(checkNewTicketsForAllUsers, 60000);



// ==================== ROUTES ====================

// Health check — Railway uses this to detect if app is alive
app.get('/health', (req, res) => {
  const mongoState = mongoose.connection.readyState;
  // 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
  const stateNames = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
  
  if (mongoState === 1) {
    res.status(200).json({ 
      status: 'ok', 
      mongo: stateNames[mongoState],
      uptime: Math.floor(process.uptime()) + 's',
      memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
      wsConnections: io.engine?.clientsCount || 0,
      wsUsers: userSockets.size
    });
  } else {
    res.status(503).json({ 
      status: 'degraded', 
      mongo: stateNames[mongoState] || 'unknown',
      uptime: Math.floor(process.uptime()) + 's'
    });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'ParkBro API is running!', version: '2.0' });
});

// ==================== AUTH ====================

app.post('/api/auth/register', rateLimit('register', 5, 3600000), async (req, res) => {
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
    
    // Начисляем бонус рефереру ПОСЛЕ верификации email (не сейчас)
    // referrer bonus будет начислен в /api/auth/verify-email
    if (referrer) {
      // Только сохраняем связь, но НЕ начисляем бонус до верификации
      console.log(`Referral saved: ${name.trim()} referred by ${referrer.name} — bonus pending email verification`);
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
        emailVerified: newUser.emailVerified,
        createdAt: newUser.createdAt
      },
      verificationRequired: true
    });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    console.error('Register error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

app.post('/api/auth/verify-email', rateLimit('verify-email', 10, 900000), async (req, res) => {
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
    
    // Начисляем реферальный бонус ПОСЛЕ верификации email
    if (user.referredBy) {
      const referrer = await User.findById(user.referredBy);
      if (referrer) {
        // Лимит: максимум 10 рефералов в день
        const todayStart = new Date(); todayStart.setHours(0,0,0,0);
        const todayReferrals = await Transaction.countDocuments({ 
          userId: referrer._id, type: 'referral', createdAt: { $gte: todayStart }
        });
        if (todayReferrals < 10) {
          referrer.balance += 20;
          referrer.referralCount += 1;
          referrer.referralEarnings = (referrer.referralEarnings || 0) + 20;
          await referrer.save();
          await new Transaction({
            userId: referrer._id, type: 'referral', amount: 20,
            description: `Реферальный бонус за ${user.name}`
          }).save();
          console.log(`✅ Referral bonus +20 to ${referrer.name} for verified user ${user.name}`);
        } else {
          console.log(`⚠️ Referral daily limit reached for ${referrer.name}`);
        }
      }
    }
    
    res.json({ success: true, message: 'Email подтверждён!' });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

app.post('/api/auth/resend-verification', rateLimit('resend-verify', 3, 3600000), async (req, res) => {
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
app.post("/api/auth/forgot-password", rateLimit('forgot-pw', 5, 3600000), async (req, res) => {
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
app.post("/api/auth/reset-password", rateLimit('reset-pw', 10, 900000), async (req, res) => {
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

// Статистика реферальной программы
app.get('/api/users/:id/referral-stats', async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await User.findById(userId).select('referralEarnings').lean();
    if (!user) return res.json({ count: 0, earnings: 0, referrals: [] });
    
    const referrals = await User.find({ referredBy: userId })
      .select('name avatarThumb parkingsGiven parkingsReceived createdAt')
      .sort({ createdAt: -1 }).limit(50).lean();
    
    res.json({
      count: referrals.length,
      earnings: user.referralEarnings || 0,
      referrals: referrals.map(r => ({
        name: r.name,
        avatar: r.avatarThumb || null,
        deals: (r.parkingsGiven || 0) + (r.parkingsReceived || 0),
        joinedAt: r.createdAt
      }))
    });
  } catch (error) {
    res.json({ count: 0, earnings: 0, referrals: [] });
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
    const user = await User.findById(userId).select('-avatar');
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
    }).select('name avatarThumb lastActivity hideOnline rating ratingCount');
    
    let myReferrer = null;
    if (user.referredBy && !blockedIds.includes(user.referredBy.toString())) {
      myReferrer = await User.findById(user.referredBy)
        .select('name avatarThumb lastActivity hideOnline rating ratingCount');
    }
    
    // 2. Друзья через Friendship - ОПТИМИЗИРОВАНО
    const friendships = await Friendship.find({
      $or: [{ user1: userId }, { user2: userId }],
      status: 'accepted'
    });
    
    // Собираем все ID друзей за один раз
    const friendshipFriendIds = friendships.map(f => 
      f.user1.toString() === userId ? f.user2 : f.user1
    ).filter(id => !blockedIds.includes(id.toString()));
    
    // Один запрос вместо N
    const friendshipUsers = await User.find({ 
      _id: { $in: friendshipFriendIds } 
    }).select('name avatarThumb lastActivity hideOnline rating ratingCount');
    
    // Создаем map для быстрого доступа
    const usersMap = {};
    friendshipUsers.forEach(u => { usersMap[u._id.toString()] = u; });
    
    const friendshipFriends = [];
    for (const f of friendships) {
      const friendId = f.user1.toString() === userId ? f.user2 : f.user1;
      if (blockedIds.includes(friendId.toString())) continue;
      
      const friendUser = usersMap[friendId.toString()];
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
        exists.isFavorite = f.isFavorite;
        exists.friendshipId = f.friendshipId;
        exists.exchangeCount = f.exchangeCount;
      }
    }
    
    // Собираем все ID друзей для подсчета сообщений за один запрос
    const allFriendIds = allFriendsRaw.map(f => f.user._id);
    
    // Один агрегатный запрос вместо N
    const unreadCounts = await FriendMessage.aggregate([
      { $match: { fromUserId: { $in: allFriendIds }, toUserId: new mongoose.Types.ObjectId(userId), read: false } },
      { $group: { _id: '$fromUserId', count: { $sum: 1 } } }
    ]);
    const unreadMap = {};
    unreadCounts.forEach(u => { unreadMap[u._id.toString()] = u.count; });
    
    // Добавляем информацию об онлайн статусе
    const now = new Date();
    const friendsWithStatus = allFriendsRaw.map(friendData => {
      const friend = friendData.user;
      const lastActivity = new Date(friend.lastActivity);
      const diffMs = now - lastActivity;
      const diffMins = Math.floor(diffMs / 60000);
      
      const isOnline = friend.hideOnline ? false : diffMins < 5;
      const unreadCount = unreadMap[friend._id.toString()] || 0;
      
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
        id: friend._id,
        _id: friend._id,
        name: friend.name,
        avatar: friend.avatarThumb || null,
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
    });
    
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

// ОПТИМИЗИРОВАННЫЙ COMBINED ENDPOINT - всё за один запрос!
app.get('/api/users/:id/friends-all', async (req, res) => {
  const t0 = Date.now();
  try {
    const userId = req.params.id;
    const user = await User.findById(userId).select('-avatar').lean();
    console.log(`  [friends-all] User.findById: ${Date.now() - t0}ms`);
    if (!user) return res.json({ friends: [], friendRequests: [], outgoingRequests: [], blockedUsers: [], stats: null });
    
    const t1 = Date.now();
    // Все запросы параллельно
    const [
      blockedUsers,
      friendships,
      pendingIncoming,
      pendingOutgoing,
      friendsWhoUsedMyCode,
      myReferrer
    ] = await Promise.all([
      BlockedUser.find({ $or: [{ userId }, { blockedUserId: userId }] }).lean(),
      Friendship.find({ $or: [{ user1: userId }, { user2: userId }], status: 'accepted' }).lean(),
      Friendship.find({ user2: userId, status: 'pending' }).populate('user1', 'name avatarThumb rating ratingCount').lean(),
      Friendship.find({ user1: userId, status: 'pending' }).populate('user2', 'name avatarThumb rating ratingCount').lean(),
      User.find({ referredBy: userId }).select('name avatarThumb lastActivity hideOnline rating ratingCount').lean(),
      user.referredBy ? User.findById(user.referredBy).select('name avatarThumb lastActivity hideOnline rating ratingCount').lean() : null
    ]);
    console.log(`  [friends-all] Promise.all 6 queries: ${Date.now() - t1}ms`);
    
    const blockedIds = blockedUsers.map(b => b.userId.toString() === userId ? b.blockedUserId.toString() : b.userId.toString());
    
    // Собираем ID друзей из Friendship
    const friendshipFriendIds = friendships
      .map(f => f.user1.toString() === userId ? f.user2 : f.user1)
      .filter(id => !blockedIds.includes(id.toString()));
    
    const t2 = Date.now();
    // Один запрос для всех друзей из Friendship
    const friendshipUsers = await User.find({ _id: { $in: friendshipFriendIds } })
      .select('name avatarThumb lastActivity hideOnline rating ratingCount')
      .lean();
    console.log(`  [friends-all] User.find friends: ${Date.now() - t2}ms`);
    
    const usersMap = {};
    friendshipUsers.forEach(u => { usersMap[u._id.toString()] = u; });
    
    // Собираем всех друзей
    const allFriendsRaw = [];
    
    if (myReferrer && !blockedIds.includes(myReferrer._id.toString())) {
      allFriendsRaw.push({ user: myReferrer, isReferral: true, isMyReferrer: true });
    }
    
    for (const f of friendsWhoUsedMyCode) {
      if (!blockedIds.includes(f._id.toString())) {
        allFriendsRaw.push({ user: f, isReferral: true, usedMyCode: true });
      }
    }
    
    for (const f of friendships) {
      const friendId = f.user1.toString() === userId ? f.user2 : f.user1;
      if (blockedIds.includes(friendId.toString())) continue;
      
      const friendUser = usersMap[friendId.toString()];
      if (friendUser) {
        const exists = allFriendsRaw.find(fr => fr.user._id.toString() === friendUser._id.toString());
        if (!exists) {
          const isFavorite = f.user1.toString() === userId ? f.favorite1 : f.favorite2;
          allFriendsRaw.push({ user: friendUser, isFavorite, friendshipId: f._id, exchangeCount: f.exchangeCount || 0 });
        } else {
          exists.isFavorite = f.user1.toString() === userId ? f.favorite1 : f.favorite2;
          exists.friendshipId = f._id;
          exists.exchangeCount = f.exchangeCount || 0;
        }
      }
    }
    
    // Непрочитанные сообщения - один агрегатный запрос
    const allFriendIds = allFriendsRaw.map(f => f.user._id);
    const unreadCounts = await FriendMessage.aggregate([
      { $match: { fromUserId: { $in: allFriendIds }, toUserId: new mongoose.Types.ObjectId(userId), read: false } },
      { $group: { _id: '$fromUserId', count: { $sum: 1 } } }
    ]);
    const unreadMap = {};
    unreadCounts.forEach(u => { unreadMap[u._id.toString()] = u.count; });
    
    // Формируем список друзей с онлайн статусом
    const now = new Date();
    const friends = allFriendsRaw.map(friendData => {
      const friend = friendData.user;
      const lastActivity = new Date(friend.lastActivity);
      const diffMins = Math.floor((now - lastActivity) / 60000);
      const isOnline = friend.hideOnline ? false : diffMins < 5;
      
      let lastSeenText = null;
      if (!friend.hideOnline && !isOnline) {
        if (diffMins < 60) lastSeenText = `${diffMins}m`;
        else if (diffMins < 1440) lastSeenText = `${Math.floor(diffMins / 60)}h`;
        else lastSeenText = `${Math.floor(diffMins / 1440)}d`;
      }
      
      return {
        id: friend._id, _id: friend._id, name: friend.name,
        avatar: friend.avatarThumb || null,
        rating: friend.rating, ratingCount: friend.ratingCount, isOnline, lastSeenText,
        unreadCount: unreadMap[friend._id.toString()] || 0,
        isFavorite: friendData.isFavorite || false, friendshipId: friendData.friendshipId || null,
        isReferral: friendData.isReferral || false, exchangeCount: friendData.exchangeCount || 0
      };
    });
    
    // Сортировка
    friends.sort((a, b) => {
      if (a.isFavorite && !b.isFavorite) return -1;
      if (!a.isFavorite && b.isFavorite) return 1;
      if (a.isOnline && !b.isOnline) return -1;
      if (!a.isOnline && b.isOnline) return 1;
      return a.name.localeCompare(b.name);
    });
    
    // Формируем запросы
    const friendRequests = pendingIncoming
      .filter(r => r.user1 && !blockedIds.includes(r.user1._id.toString()))
      .map(r => ({ 
        friendshipId: r._id, 
        user: { ...r.user1, avatar: r.user1.avatarThumb || null }, 
        createdAt: r.createdAt 
      }));
    
    const outgoingRequests = pendingOutgoing
      .filter(r => r.user2 && !blockedIds.includes(r.user2._id.toString()))
      .map(r => ({ 
        friendshipId: r._id, 
        user: { ...r.user2, avatar: r.user2.avatarThumb || null }, 
        createdAt: r.createdAt 
      }));
    
    // Статистика
    const achievements = [];
    if (user.parkingsGiven >= 1) achievements.push({ id: 'first_give', name: 'First Give', emoji: '🌱' });
    if (user.parkingsGiven >= 10) achievements.push({ id: 'helper', name: 'Helper', emoji: '🤝' });
    if (user.parkingsGiven >= 50) achievements.push({ id: 'generous', name: 'Generous', emoji: '💝' });
    if (user.parkingsGiven >= 100) achievements.push({ id: 'legend', name: 'Legend', emoji: '🏆' });
    if (user.parkingsReceived >= 1) achievements.push({ id: 'first_park', name: 'First Park', emoji: '🚗' });
    if (user.parkingsReceived >= 25) achievements.push({ id: 'regular', name: 'Regular', emoji: '⭐' });
    if (user.rating >= 4.8 && user.ratingCount >= 10) achievements.push({ id: 'trusted', name: 'Trusted', emoji: '💎' });
    if (user.referralCount >= 5) achievements.push({ id: 'networker', name: 'Networker', emoji: '🌐' });
    if (user.referralCount >= 20) achievements.push({ id: 'influencer', name: 'Influencer', emoji: '👑' });
    
    const stats = {
      parkingsGiven: user.parkingsGiven || 0,
      parkingsReceived: user.parkingsReceived || 0,
      rating: user.rating,
      ratingCount: user.ratingCount,
      referralCount: user.referralCount || 0,
      achievements
    };
    
    // Заблокированные (с данными пользователей)
    const blockedUserIds = blockedUsers.filter(b => b.userId.toString() === userId).map(b => b.blockedUserId);
    const blockedUsersData = await User.find({ _id: { $in: blockedUserIds } }).select('name');
    
    res.json({ friends, friendRequests, outgoingRequests, blockedUsers: blockedUsersData, stats });
  } catch (error) {
    console.log("GET FRIENDS-ALL ERROR:", error);
    res.json({ friends: [], friendRequests: [], outgoingRequests: [], blockedUsers: [], stats: null });
  }
});

// Отправить сообщение другу
app.post('/api/friends/message', async (req, res) => {
  try {
    const { fromUserId, toUserId, text, imageBase64 } = req.body;
    
    // Проверяем что они друзья
    const friendship = await Friendship.findOne({
      $or: [
        { user1: fromUserId, user2: toUserId },
        { user1: toUserId, user2: fromUserId }
      ],
      status: 'accepted'
    });
    if (!friendship) {
      return res.status(403).json({ success: false, message: 'Not friends' });
    }
    
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
    
    // Загружаем фото в Cloudinary если есть
    let image = null;
    if (imageBase64) {
      image = await uploadChatImage(imageBase64, fromUserId);
    }
    
    const message = new FriendMessage({ fromUserId, toUserId, text: text || '', image });
    await message.save();
    
    // 🔌 WebSocket: новое сообщение другу
    emitToUser(toUserId, 'friendMessage:new', { 
      message: message.toObject(), 
      fromUserId 
    });
    // Также в комнату чата если получатель в ней
    io.to(`friendchat:${toUserId}:${fromUserId}`).emit('friendMessage:new', { 
      message: message.toObject(), 
      fromUserId 
    });
    
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
        const msgPreview = image && !text ? '📷' : (text || '').substring(0, 50) + ((text || '').length > 50 ? '...' : '');
        const titles = {
          en: '💬 New message',
          ru: '💬 Новое сообщение',
          es: '💬 Nuevo mensaje',
          uk: '💬 Нове повідомлення'
        };
        const bodies = {
          en: `${sender?.name || 'Friend'}: ${msgPreview}`,
          ru: `${sender?.name || 'Друг'}: ${msgPreview}`,
          es: `${sender?.name || 'Amigo'}: ${msgPreview}`,
          uk: `${sender?.name || 'Друг'}: ${msgPreview}`
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
    const userId = req.params.id;
    
    // Непрочитанные сообщения
    const count = await FriendMessage.countDocuments({
      toUserId: userId,
      read: false
    });
    
    // Входящие заявки в друзья
    const friendRequests = await Friendship.countDocuments({
      toUserId: userId,
      status: 'pending'
    });
    
    // Приглашения в караван
    const convoyInvites = await Convoy.countDocuments({
      status: 'active',
      'members': { $elemMatch: { userId: userId, status: 'invited' } }
    });
    
    // Непрочитанные сообщения караванов
    let convoyMessages = 0;
    const activeConvoys = await Convoy.find({
      status: 'active',
      'members': { $elemMatch: { userId: userId, status: { $in: ['active', 'stopped', 'arrived'] } } }
    }).select('members messages').lean();
    for (const c of activeConvoys) {
      const me = c.members.find(m => m.userId?.toString() === userId);
      const readAt = me?.lastChatReadAt || me?.joinedAt || new Date(0);
      const unread = (c.messages || []).filter(m => new Date(m.createdAt) > new Date(readAt) && m.userId !== userId).length;
      convoyMessages += unread;
    }
    
    // Непрочитанные групповые чаты
    let groupMessages = 0;
    const groupChats = await GroupChat.find({ members: userId }).select('messages readBy').lean();
    for (const gc of groupChats) {
      const readEntry = gc.readBy?.find(r => r.userId?.toString() === userId);
      const readAt = readEntry?.readAt || new Date(0);
      const unread = (gc.messages || []).filter(m => 
        !m.deletedForAll && m.fromUserId?.toString() !== userId && new Date(m.createdAt) > new Date(readAt)
      ).length;
      groupMessages += unread;
    }
    
    res.json({ count, friendRequests, convoyInvites, convoyMessages, groupMessages, groupChatMessages: groupMessages });
  } catch (error) {
    res.json({ count: 0, friendRequests: 0, convoyInvites: 0, convoyMessages: 0, groupMessages: 0, groupChatMessages: 0 });
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

// Mute/unmute daily motivational push notifications
app.patch('/api/users/:id/mute-daily-push', async (req, res) => {
  try {
    const { muteDailyPush } = req.body;
    await User.findByIdAndUpdate(req.params.id, { muteDailyPush });
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
    const user = await User.findById(req.params.id)
      .select('parkingsGiven parkingsReceived rating ratingCount referralCount createdAt')
      .lean();
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
      createdAt: user.createdAt,
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
    const { password } = req.body;
    
    // Проверяем валидность ObjectId
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    // Проверяем что пользователь существует
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    // Требуем пароль для подтверждения удаления
    if (!password) {
      return res.status(400).json({ success: false, message: 'Password required' });
    }
    if (!user.password) {
      return res.status(400).json({ success: false, message: 'Cannot delete account without password' });
    }
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(403).json({ success: false, message: 'Wrong password' });
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

app.post('/api/auth/login', rateLimit('login', 10, 900000), async (req, res) => {
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
          cars: user.cars || [],
          avatar: user.avatar,
          language: user.language || 'ru',
          isAdmin: user.isAdmin || false,
          referralCode: user.referralCode,
          referralCount: user.referralCount || 0,
          rating: user.rating,
          ratingCount: user.ratingCount,
          emailVerified: user.emailVerified,
          createdAt: user.createdAt
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

app.post('/api/auth/google', rateLimit('google-auth', 10, 900000), async (req, res) => {
  try {
    const { googleId, email, name, avatar, referralCode } = req.body;
    
    if (!googleId || !email) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }
    
    // Ищем ТОЛЬКО по googleId (не по email — чтобы не захватить чужой email-аккаунт)
    let user = await User.findOne({ googleId });
    
    if (!user) {
      // Проверяем нет ли email-аккаунта с таким email
      const existingByEmail = await User.findOne({ email: email.toLowerCase() });
      if (existingByEmail && !existingByEmail.googleId) {
        // Email занят обычным аккаунтом — нельзя автоматически привязывать
        return res.status(400).json({ success: false, message: 'Account with this email already exists. Please login with email and password.' });
      }
      if (existingByEmail && existingByEmail.googleId === googleId) {
        user = existingByEmail;
      }
    }
    
    if (user) {
      if (!user.referralCode) {
        user.referralCode = user.name.substring(0, 3).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
        await user.save();
      }
    } else {
      // Создаём нового пользователя
      const newUserData = {
        email: email.toLowerCase(),
        name,
        avatar: avatar || null,
        googleId,
        authProvider: 'google',
        balance: 50,
        referralCode: generateReferralCode(),
        emailVerified: true, // Google уже верифицировал
        acceptedTerms: true,
        acceptedTermsAt: new Date()
      };
      
      // Реферальный код
      if (referralCode) {
        const referrer = await User.findOne({ referralCode: referralCode.toUpperCase() });
        if (referrer) {
          newUserData.referredBy = referrer._id;
          newUserData.balance = 50 + 70; // Бонус рефералу
        }
      }
      
      user = new User(newUserData);
      await user.save();
      
      // Начисляем реферальный бонус пригласившему (сразу, т.к. Google уже верифицирован)
      if (user.referredBy) {
        const referrer = await User.findById(user.referredBy);
        if (referrer) {
          const todayStart = new Date(); todayStart.setHours(0,0,0,0);
          const todayReferrals = await Transaction.countDocuments({ userId: referrer._id, type: 'referral', createdAt: { $gte: todayStart } });
          if (todayReferrals < 10) {
            referrer.balance += 20;
            referrer.referralCount += 1;
            referrer.referralEarnings += 20;
            await referrer.save();
            await new Transaction({ userId: referrer._id, type: 'referral', amount: 20, description: `Реферальный бонус за ${user.name}` }).save();
            console.log(`✅ Referral bonus +20 to ${referrer.name} for Google user ${user.name}`);
          }
        }
        // Транзакция бонуса новому юзеру
        await new Transaction({ userId: user._id, type: 'referral', amount: 70, description: 'Реферальный бонус за регистрацию' }).save();
      }
      
      // Загружаем Google-аватарку в Cloudinary (асинхронно после save)
      if (avatar) {
        const cloudinaryUrl = await uploadToCloudinary(avatar, user._id.toString());
        if (cloudinaryUrl) {
          user.avatar = cloudinaryUrl;
          user.avatarThumb = getCloudinaryThumb(cloudinaryUrl, 80);
          await user.save();
        }
      }
      
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
        cars: user.cars || [],
        avatar: user.avatar,
        language: user.language || 'ru',
        isAdmin: user.isAdmin || false,
        referralCode: user.referralCode,
        rating: user.rating,
        emailVerified: user.emailVerified,
        createdAt: user.createdAt
      }
    });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    console.error('Google auth error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

app.post('/api/auth/apple', rateLimit('apple-auth', 10, 900000), async (req, res) => {
  try {
    const { appleId, email, name, referralCode } = req.body;
    
    if (!appleId) {
      return res.status(400).json({ success: false, message: 'Missing appleId' });
    }
    
    // Ищем ТОЛЬКО по appleId
    let user = await User.findOne({ appleId });
    
    if (!user && email) {
      const existingByEmail = await User.findOne({ email: email.toLowerCase() });
      if (existingByEmail && !existingByEmail.appleId) {
        return res.status(400).json({ success: false, message: 'Account with this email already exists. Please login with email and password.' });
      }
      if (existingByEmail && existingByEmail.appleId === appleId) {
        user = existingByEmail;
      }
    }
    
    if (user) {
      if (!user.referralCode) {
        user.referralCode = user.name.substring(0, 3).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
        await user.save();
      }
    } else {
      const newUserData = {
        email: email?.toLowerCase() || `apple_${appleId}@private.relay`,
        name: name || 'Пользователь',
        appleId,
        authProvider: 'apple',
        balance: 50,
        referralCode: generateReferralCode(),
        emailVerified: true,
        acceptedTerms: true,
        acceptedTermsAt: new Date()
      };
      
      // Реферальный код
      if (referralCode) {
        const referrer = await User.findOne({ referralCode: referralCode.toUpperCase() });
        if (referrer) {
          newUserData.referredBy = referrer._id;
          newUserData.balance = 50 + 70;
        }
      }
      
      user = new User(newUserData);
      await user.save();
      
      // Начисляем реферальный бонус пригласившему
      if (user.referredBy) {
        const referrer = await User.findById(user.referredBy);
        if (referrer) {
          const todayStart = new Date(); todayStart.setHours(0,0,0,0);
          const todayReferrals = await Transaction.countDocuments({ userId: referrer._id, type: 'referral', createdAt: { $gte: todayStart } });
          if (todayReferrals < 10) {
            referrer.balance += 20;
            referrer.referralCount += 1;
            referrer.referralEarnings += 20;
            await referrer.save();
            await new Transaction({ userId: referrer._id, type: 'referral', amount: 20, description: `Реферальный бонус за ${user.name}` }).save();
            console.log(`✅ Referral bonus +20 to ${referrer.name} for Apple user ${user.name}`);
          }
        }
        await new Transaction({ userId: user._id, type: 'referral', amount: 70, description: 'Реферальный бонус за регистрацию' }).save();
      }
      
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
        cars: user.cars || [],
        avatar: user.avatar,
        language: user.language || 'ru',
        isAdmin: user.isAdmin || false,
        referralCode: user.referralCode,
        rating: user.rating,
        emailVerified: user.emailVerified,
        createdAt: user.createdAt
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
    
    // Проверяем что toUserId = другой участник (нельзя подставить постороннего)
    const expectedTo = isOwner ? booking.userId.toString() : booking.ownerId.toString();
    if (toUserId !== expectedTo) {
      return res.status(400).json({ success: false, message: 'Invalid rating target' });
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

// Рейтинг для помощи на дороге
app.post('/api/ratings/help', async (req, res) => {
  try {
    const { fromUserId, toUserId, helpRequestId, rating, problems, comment } = req.body;
    
    const request = await HelpRequest.findById(helpRequestId);
    if (!request || request.status !== 'completed') {
      return res.status(400).json({ success: false, message: 'Help request not found or not completed' });
    }
    
    // Проверяем что пользователь участвовал
    const isRequester = request.userId.toString() === fromUserId;
    const isHelper = request.helperId.toString() === fromUserId;
    
    if (!isRequester && !isHelper) {
      return res.status(403).json({ success: false, message: 'You were not part of this help request' });
    }
    
    // Проверяем что toUserId = другой участник
    const expectedTo = isRequester ? request.helperId.toString() : request.userId.toString();
    if (toUserId !== expectedTo) {
      return res.status(400).json({ success: false, message: 'Invalid rating target' });
    }
    
    // Проверяем что ещё не ставили оценку
    const existingRating = await Rating.findOne({ fromUserId, helpRequestId });
    if (existingRating) {
      return res.status(400).json({ success: false, message: 'Already rated' });
    }
    
    const newRating = new Rating({
      fromRole: isRequester ? 'requester' : 'helper',
      fromUserId,
      toUserId,
      helpRequestId,
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
    
    res.json({ success: true, message: 'Rating saved' });
  } catch (error) {
    console.error('Help rating error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Лёгкий endpoint для проверки баланса (без avatar!)
app.get('/api/users/:id/balance', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('balance').lean();
    if (!user) return res.status(404).json({ balance: 0 });
    res.json({ balance: user.balance });
  } catch (error) {
    res.json({ balance: 0 });
  }
});

app.get('/api/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-password -resetCode -resetCodeExpires -verificationCode -verificationExpires -pushToken -googleId -appleId -__v')
      .lean();
    if (!user) return res.status(404).json(null);
    res.json({ ...user, id: user._id.toString() });
  } catch (error) {
    console.log("GET USER ERROR:", error);
    res.status(500).json(null);
  }
});


app.put("/api/users/:id", async (req, res) => {
  try {
    const { car, cars, avatar, language } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    
    // Разрешаем менять ТОЛЬКО безопасные поля
    if (car !== undefined) user.car = car;
    if (cars !== undefined) user.cars = (cars || []).slice(0, 3); // max 3 cars
    if (avatar) {
      const cloudinaryUrl = await uploadToCloudinary(avatar, req.params.id);
      if (cloudinaryUrl) {
        user.avatar = cloudinaryUrl;
        user.avatarThumb = getCloudinaryThumb(cloudinaryUrl, 80);
      } else {
        // Fallback: сохраняем как раньше если Cloudinary недоступен
        user.avatar = avatar;
        user.avatarThumb = await createThumbnail(avatar, 80);
      }
    }
    if (language) user.language = language;
    if (req.body.lastLocation) user.lastLocation = req.body.lastLocation;
    if (req.body.muteDailyPush !== undefined) user.muteDailyPush = req.body.muteDailyPush;
    // НЕ разрешаем: balance, isAdmin, email, password, referralCode, etc.
    await user.save();
    
    // Не возвращаем sensitive данные
    const safeUser = user.toObject();
    delete safeUser.password;
    delete safeUser.pushToken;
    delete safeUser.googleId;
    delete safeUser.appleId;
    delete safeUser.verificationCode;
    delete safeUser.resetCode;
    res.json({ success: true, user: safeUser });
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
app.post('/api/users/:id/push-token', rateLimit('push-token', 5, 3600000), async (req, res) => {
  try {
    const { pushToken, callerUserId } = req.body;
    // Проверка: callerUserId должен совпадать с :id
    if (!callerUserId || callerUserId !== req.params.id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    // Remove this token from all other accounts (prevents duplicate pushes on device reuse)
    if (pushToken) {
      await User.updateMany(
        { _id: { $ne: req.params.id }, pushToken },
        { $unset: { pushToken: '' } }
      );
    }
    await User.findByIdAndUpdate(req.params.id, { pushToken });
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false });
  }
});
app.get('/api/users/:id/ratings', async (req, res) => {
  try {
    const ratings = await Rating.find({ toUserId: req.params.id })
      .populate('fromUserId', 'name')
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    res.json(ratings);
  } catch (error) {
    console.log("GET RATINGS ERROR:", error);
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
    
    // Лимит награды: максимум 50 баллов
    const safeReward = Math.min(Math.max(parseInt(reward) || 10, 1), 100);
    
    // Проверяем баланс
    const user = await User.findById(userId).select('balance').lean();
    if (!user || user.balance < safeReward) {
      return res.status(400).json({ success: false, message: 'Недостаточно баллов' });
    }
    
    const helpRequest = new HelpRequest({
      userId, location, address, problemType, description,
      reward: safeReward,
      expiresAt: new Date(Date.now() + 60 * 60000)
    });
    await helpRequest.save();
    
    // 🔌 WebSocket: новый запрос помощи
    emitToAll('help:created', { helpRequest: helpRequest.toObject() });
    
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
    // Нельзя помогать самому себе
    if (request.userId.toString() === helperId) {
      return res.status(400).json({ success: false, message: 'Cannot accept own help request' });
    }
    request.status = 'accepted';
    request.helperId = helperId;
    await request.save();
    
    // 🔌 WebSocket: запрос помощи принят
    emitToUser(request.userId, 'help:accepted', { helpRequest: request.toObject() });
    emitToAll('help:updated', { helpRequestId: request._id.toString() });
    
    // 📱 Push: уведомляем запрашивающего
    const [helperUser, requesterUser] = await Promise.all([
      User.findById(helperId).select('name').lean(),
      User.findById(request.userId).select('pushToken language').lean()
    ]);
    if (requesterUser?.pushToken) {
      const lang = requesterUser.language || 'en';
      sendPushNotification(requesterUser.pushToken,
        getPushText('helpAccepted', 'title', lang),
        getPushText('helpAccepted', 'body', lang, { name: helperUser?.name || 'Helper' }),
        { type: 'help_accepted', helpRequestId: request._id.toString() });
    }
    
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
    
    // 🔌 WebSocket: помощник приехал
    emitToUser(request.userId, 'help:helperArrived', { helpRequestId: request._id.toString() });
    
    // 📱 Push: уведомляем запрашивающего что помощник приехал
    const [helperDoc, requesterDoc] = await Promise.all([
      User.findById(request.helperId).select('name').lean(),
      User.findById(request.userId).select('pushToken language').lean()
    ]);
    if (requesterDoc?.pushToken) {
      const lang = requesterDoc.language || 'en';
      sendPushNotification(requesterDoc.pushToken,
        getPushText('helperArrived', 'title', lang),
        getPushText('helperArrived', 'body', lang, { name: helperDoc?.name || 'Helper' }),
        { type: 'helper_arrived', helpRequestId: request._id.toString() });
    }
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// Сообщения в помощи на дороге
app.get('/api/help-requests/:id/messages', async (req, res) => {
  try {
    const request = await HelpRequest.findById(req.params.id);
    res.json(request?.messages || []);
  } catch (error) {
    res.json([]);
  }
});

app.post('/api/help-requests/:id/messages', async (req, res) => {
  try {
    const { userId, text } = req.body;
    const request = await HelpRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ success: false });
    
    // Проверка: только участники
    if (userId !== request.userId?.toString() && userId !== request.helperId?.toString()) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    const isHelperSender = userId === request.helperId?.toString();
    const user = await User.findById(userId).select('name').lean();
    
    request.messages = request.messages || [];
    request.messages.push({
      userId, senderName: user?.name || 'User', text, isHelper: isHelperSender,
      time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
      createdAt: new Date()
    });
    await request.save();
    
    // 🔌 WebSocket: новое сообщение
    const lastMsg = request.messages[request.messages.length - 1];
    const recipientId = isHelperSender ? request.userId?.toString() : request.helperId?.toString();
    if (recipientId) {
      emitToUser(recipientId, 'help:message', { helpRequestId: request._id.toString(), message: lastMsg });
    }
    
    // 📱 Push
    if (recipientId) {
      const recipient = await User.findById(recipientId).select('pushToken language').lean();
      if (recipient?.pushToken) {
        const lang = recipient.language || 'en';
        const title = getPushText('message', 'title', lang);
        const shortText = text.length > 50 ? text.substring(0, 50) + '...' : text;
        const body = getPushText('message', 'body', lang, { name: user?.name || 'User', text: shortText });
        sendPushNotification(recipient.pushToken, title, body, { type: 'help_message', helpRequestId: request._id.toString() });
      }
    }
    
    res.json({ success: true, message: lastMsg });
  } catch (error) {
    console.log('HELP MESSAGE ERROR:', error);
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
    const { callerUserId } = req.body;
    const request = await HelpRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ success: false });
    
    // Проверка статуса — только accepted можно завершить
    if (request.status !== 'accepted') {
      return res.status(400).json({ success: false, message: 'Request is not in accepted status' });
    }
    
    // Проверка что вызывает участник сделки
    if (!callerUserId || (callerUserId !== request.userId.toString() && callerUserId !== request.helperId.toString())) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    const isRequester = callerUserId === request.userId.toString();
    const isHelper = callerUserId === request.helperId.toString();
    
    // ШАГ 1: Помечаем подтверждение вызывающей стороны
    if (isRequester) request.requesterConfirmed = true;
    if (isHelper) request.helperConfirmed = true;
    await request.save();
    
    // Если только одна сторона подтвердила — ждём вторую
    if (!request.requesterConfirmed || !request.helperConfirmed) {
      // 🔌 WebSocket: уведомляем другую сторону что нужно подтвердить
      const otherUserId = isRequester ? request.helperId : request.userId;
      emitToUser(otherUserId, 'help:confirmNeeded', { 
        helpRequestId: request._id.toString(),
        confirmedBy: isRequester ? 'requester' : 'helper'
      });
      // Также обновляем того кто подтвердил
      emitToUser(callerUserId, 'help:confirmUpdate', { 
        helpRequestId: request._id.toString(),
        requesterConfirmed: request.requesterConfirmed,
        helperConfirmed: request.helperConfirmed
      });
      
      // 📱 Push: уведомляем другую сторону
      const [caller, otherUserDoc] = await Promise.all([
        User.findById(callerUserId).select('name').lean(),
        User.findById(otherUserId).select('pushToken language').lean()
      ]);
      if (otherUserDoc?.pushToken) {
        const lang = otherUserDoc.language || 'en';
        const title = getPushText('helpConfirmNeeded', 'title', lang);
        const body = getPushText('helpConfirmNeeded', 'body', lang, { name: caller?.name || 'User' });
        sendPushNotification(otherUserDoc.pushToken, title, body, { type: 'help_confirm', helpRequestId: request._id.toString() });
      }
      
      return res.json({ 
        success: true, 
        status: 'waiting_confirmation',
        requesterConfirmed: request.requesterConfirmed,
        helperConfirmed: request.helperConfirmed
      });
    }
    
    // ШАГ 2: Обе стороны подтвердили — выполняем оплату
    const requester = await User.findById(request.userId);
    const helper = await User.findById(request.helperId);
    
    if (!requester || !helper) {
      return res.status(404).json({ success: false, message: 'Users not found' });
    }
    
    if (requester.balance < request.reward) {
      return res.status(400).json({ success: false, message: 'Not enough points' });
    }
    
    if (request.userId.toString() === request.helperId.toString()) {
      return res.status(400).json({ success: false, message: 'Cannot help yourself' });
    }
    
    // Получаем уровень helper'а для расчёта комиссии
    const settings = await getGameSettings();
    let helperLevel = 1;
    
    if (settings && settings.levels) {
      const parkingsGiven = await Parking.countDocuments({ ownerId: request.helperId, status: 'completed' });
      const totalPoints = helper.totalPointsEarned || helper.balance || 0;
      
      for (let i = settings.levels.length - 1; i >= 0; i--) {
        const lvl = settings.levels[i];
        if (totalPoints >= lvl.minPoints && parkingsGiven >= lvl.minParkingsGiven) {
          helperLevel = lvl.level;
          break;
        }
      }
    }
    
    // Комиссия по уровням: 1=25%, 2=20%, 3=10%, 4=0%
    const commissionMap = { 1: 0.25, 2: 0.20, 3: 0.10, 4: 0 };
    const commissionRate = commissionMap[helperLevel] || 0.25;
    const helperEarnings = Math.floor(request.reward * (1 - commissionRate));
    
    // Атомарное списание с проверкой баланса
    const deducted = await User.findOneAndUpdate(
      { _id: request.userId, balance: { $gte: request.reward } },
      { $inc: { balance: -request.reward } },
      { new: true }
    );
    if (!deducted) {
      return res.status(400).json({ success: false, message: 'Not enough points' });
    }
    
    // Атомарное начисление помощнику
    await User.findByIdAndUpdate(request.helperId, { $inc: { balance: helperEarnings } });
    
    request.status = 'completed';
    await request.save();
    
    await Transaction.create({ userId: request.userId, type: 'help_payment', amount: -request.reward, description: 'Help payment' });
    await Transaction.create({ userId: request.helperId, type: 'help_reward', amount: helperEarnings, description: 'Help reward' });
    
    // Реферальный пассивный доход
    creditReferralPassive(request.helperId, 'помощь');
    
    // 🔌 WebSocket: помощь завершена — включаем данные для рейтинга
    const requesterUser = await User.findById(request.userId).select('name balance pushToken language').lean();
    const helperUser = await User.findById(request.helperId).select('name balance pushToken language').lean();
    
    const completedData = { 
      helpRequestId: request._id.toString(),
      requesterId: request.userId.toString(),
      helperId: request.helperId.toString(),
      requesterName: requesterUser?.name || 'User',
      helperName: helperUser?.name || 'Helper'
    };
    emitToUser(request.userId, 'help:completed', completedData);
    emitToUser(request.helperId, 'help:completed', completedData);
    emitToAll('help:updated', { helpRequestId: request._id.toString() });
    
    emitToUser(request.userId, 'balance:update', { balance: requesterUser?.balance });
    emitToUser(request.helperId, 'balance:update', { balance: helperUser?.balance });
    
    // 📱 Push: уведомляем обе стороны о завершении
    if (requesterUser?.pushToken) {
      const lang = requesterUser.language || 'en';
      sendPushNotification(requesterUser.pushToken, 
        getPushText('helpCompleted', 'title', lang), 
        getPushText('helpCompleted', 'body', lang),
        { type: 'help_completed', helpRequestId: request._id.toString() });
    }
    if (helperUser?.pushToken) {
      const lang = helperUser.language || 'en';
      sendPushNotification(helperUser.pushToken,
        getPushText('helpCompleted', 'title', lang),
        getPushText('helpCompleted', 'body', lang),
        { type: 'help_completed', helpRequestId: request._id.toString() });
    }
    
    res.json({ success: true, status: 'completed' });
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
    
    // 🔌 WebSocket: запрос помощи отменён
    emitToAll('help:cancelled', { helpRequestId: request._id.toString() });
    if (request.helperId) {
      emitToUser(request.helperId, 'help:cancelled', { helpRequestId: request._id.toString() });
    }
    
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
      const users = await User.find(
        { lastLocation: { $exists: true }, lastActivity: { $gte: fiveMinAgo } },
      ).select('lastLocation').lean();
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
      .populate('ownerId', 'name car avatarThumb rating ratingCount')
      .lean();
    const result = parkings.map(p => ({
      ...p,
      ownerId: p.ownerId ? { ...p.ownerId, avatar: p.ownerId.avatarThumb } : null,
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
    
    // Валидация: цена 1-100, время 5-120 минут
    const safePrice = Math.min(Math.max(parseInt(price) || 10, 1), 100);
    const safeTime = Math.min(Math.max(parseInt(timeToLeave) || 15, 5), 120);
    
    const existing = await Parking.findOne({ ownerId, status: { $in: ['available', 'booked'] } });
    if (existing) {
      return res.status(400).json({ success: false, message: 'У вас уже есть активная парковка' });
    }
    const owner = await User.findById(ownerId).select('car avatarThumb rating').lean();
    const newParking = new Parking({
      ownerId, location, address, price: safePrice, timeToLeave: safeTime, expiresAt: new Date(Date.now() + safeTime * 60000), status: 'available',
      ownerCar: owner?.car, ownerAvatar: owner?.avatarThumb, ownerRating: owner?.rating,
      extensionsUsed: 0, messages: []
    });
    await newParking.save();
    
    // 🔌 WebSocket: уведомляем всех о новой парковке
    emitToAll('parking:created', { parking: newParking });
    
    res.json({ success: true, message: 'Парковка создана!', parking: newParking });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

app.post('/api/parkings/book', async (req, res) => {
  try {
    const { parkingId, userId, userLocation } = req.body;
    
    // Предварительные проверки - только нужные поля!
    const user = await User.findById(userId).select('name balance car avatarThumb rating lastLocation').lean();
    if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });
    
    const parkingCheck = await Parking.findById(parkingId);
    if (!parkingCheck) return res.status(404).json({ success: false, message: 'Парковка не найдена' });
    if (parkingCheck.ownerId.toString() === userId) return res.status(400).json({ success: false, message: 'Нельзя забронировать свою парковку' });
    if (user.balance < parkingCheck.price) return res.status(400).json({ success: false, message: 'Недостаточно баллов' });

    // ✅ Проверка радиуса бронирования
    const appSettings = await getAppSettings();
    const radiusKm = appSettings.bookingRadiusKm || 5;
    const loc = userLocation || user.lastLocation;
    if (loc && loc.lat && loc.lng && parkingCheck.location) {
      const dist = haversineKm(loc.lat, loc.lng, parkingCheck.location.lat, parkingCheck.location.lng);
      if (dist > radiusKm) {
        return res.status(400).json({ 
          success: false, 
          message: `Парковка слишком далеко (${dist.toFixed(1)} км). Максимальный радиус: ${radiusKm} км`,
          code: 'TOO_FAR',
          distance: Math.round(dist * 10) / 10,
          maxRadius: radiusKm
        });
      }
    }

    // ✅ АТОМАРНАЯ ОПЕРАЦИЯ: бронируем только если status === 'available'
    const parking = await Parking.findOneAndUpdate(
      { _id: parkingId, status: 'available' },  // Условие: только если available
      { 
        status: 'booked',
        bookedBy: userId,
        bookedAt: new Date(),
        bookerCar: user.car,
        bookerName: user.name,
        bookerAvatar: user.avatarThumb, // Миниатюра!
        bookerRating: user.rating
      },
      { new: true }  // Вернуть обновлённый документ
    );

    // Если parking === null, значит кто-то уже забронировал
    if (!parking) {
      return res.status(400).json({ success: false, message: 'Парковка уже занята' });
    }

    // Списываем баллы АТОМАРНО с проверкой достаточности
    const deducted = await User.findOneAndUpdate(
      { _id: userId, balance: { $gte: parking.price } },
      { $inc: { balance: -parking.price } },
      { new: true }
    );
    if (!deducted) {
      // Откатываем бронирование если баллов не хватило
      await Parking.findByIdAndUpdate(parkingId, { status: 'available', bookedBy: null, bookedAt: null, bookerCar: null, bookerName: null, bookerAvatar: null, bookerRating: null });
      return res.status(400).json({ success: false, message: 'Недостаточно баллов' });
    }

    // Получаем уровень владельца для расчёта комиссии
    const ownerData = await User.findById(parking.ownerId).select('totalPointsEarned balance').lean();
    const settings = await getGameSettings();
    let ownerLevel = 1;
    
    if (settings && settings.levels && ownerData) {
      const parkingsGiven = await Parking.countDocuments({ ownerId: parking.ownerId, status: 'completed' });
      const totalPoints = ownerData.totalPointsEarned || ownerData.balance || 0;
      
      for (let i = settings.levels.length - 1; i >= 0; i--) {
        const lvl = settings.levels[i];
        if (totalPoints >= lvl.minPoints && parkingsGiven >= lvl.minParkingsGiven) {
          ownerLevel = lvl.level;
          break;
        }
      }
    }
    
    // Комиссия по уровням: 1=25%, 2=20%, 3=10%, 4=0%
    const commissionMap = { 1: 0.25, 2: 0.20, 3: 0.10, 4: 0 };
    const commissionRate = commissionMap[ownerLevel] || 0.25;
    const platformFee = Math.ceil(parking.price * commissionRate);
    const ownerEarnings = parking.price - platformFee;

    // Начисляем владельцу атомарно и получаем только нужные поля
    const owner = await User.findByIdAndUpdate(
      parking.ownerId,
      { $inc: { balance: ownerEarnings } },
      { new: true, projection: { name: 1, car: 1, avatarThumb: 1, rating: 1, pushToken: 1, language: 1 } }
    );
    
    console.log("=== BOOKING PAYMENT (ATOMIC) ===");
    console.log("Parking ID:", parkingId);
    console.log("Owner level:", ownerLevel);
    console.log("Commission rate:", commissionRate * 100 + "%");
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

    // 🔌 WebSocket: уведомляем всех что парковка забронирована
    emitToAll('parking:booked', { parkingId: parking._id.toString() });
    // Владельцу — детали бронирования (событие booking:new)
    emitToUser(parking.ownerId, 'booking:new', { parking: parking.toObject(), bookingId: booking._id });
    // Букеру — обновление баланса
    emitToUser(userId, 'balance:update', { balance: deducted.balance });

    res.json({
      success: true, message: `Забронировано! -${parking.price} баллов`, newBalance: deducted.balance,
      parking: { ...parking.toObject(),
        bookingId: booking?._id, ownerName: owner?.name, ownerCar: owner?.car, ownerAvatar: owner?.avatarThumb, ownerRating: owner?.rating },
      bookingId: booking._id
    });
  } catch (error) {
    console.log("BOOKING ERROR:", error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

app.get('/api/users/:id/my-parkings', async (req, res) => {
  try {
    const parkings = await Parking.find({ ownerId: req.params.id, status: { $in: ['available', 'booked'] } })
      .populate('bookedBy', 'name car avatarThumb rating')
      .lean();
    // Преобразуем avatarThumb в avatar для совместимости
    const result = parkings.map(p => ({
      ...p,
      bookedBy: p.bookedBy ? { ...p.bookedBy, avatar: p.bookedBy.avatarThumb } : null
    }));
    res.json(result);
  } catch (error) {
    console.log("GET MY PARKINGS ERROR:", error);
    res.json([]);
  }
});

app.get('/api/users/:id/my-booking', async (req, res) => {
  try {
    const parking = await Parking.findOne({ bookedBy: req.params.id, status: 'booked' })
      .populate('ownerId', 'name car avatarThumb rating')
      .lean();
    if (parking) {
      const booking = await Booking.findOne({ parkingId: parking._id, status: "active" });
      res.json({
        ...parking,
        bookingId: booking?._id,
        ownerName: parking.ownerId?.name || 'Владелец',
        ownerCar: parking.ownerId?.car,
        ownerAvatar: parking.ownerId?.avatarThumb,
        ownerRating: parking.ownerId?.rating
      });
    } else {
      res.json(null);
    }
  } catch (error) {
    console.log("GET MY BOOKING ERROR:", error);
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
      .populate('userId', 'name avatarThumb rating')
      .populate('ownerId', 'name avatarThumb rating')
      .sort({ completedAt: -1 })
      .limit(20)
      .lean();
    
    // Добавляем информацию о том, нужно ли ставить оценку
    const bookingsWithRatingInfo = bookings.map(b => {
      const isOwner = b.ownerId._id.toString() === userId;
      const needsRating = isOwner ? !b.ownerRatedBooker : !b.bookerRatedOwner;
      return {
        ...b,
        isOwner,
        needsRating,
        otherUser: isOwner 
          ? { ...b.userId, avatar: b.userId?.avatarThumb }
          : { ...b.ownerId, avatar: b.ownerId?.avatarThumb }
      };
    });
    
    res.json(bookingsWithRatingInfo);
  } catch (error) {
    console.log("GET COMPLETED BOOKINGS ERROR:", error);
    res.json([]);
  }
});

app.post('/api/parkings/:id/extend', async (req, res) => {
  try {
    const { minutes, userId } = req.body;
    const parking = await Parking.findById(req.params.id);
    if (!parking) return res.status(404).json({ success: false });
    
    // Проверка владельца (если передан userId)
    if (userId && parking.ownerId.toString() !== userId) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    if (parking.extensionsUsed >= 2) return res.status(400).json({ success: false, message: 'Лимит продлений' });
    
    // Лимит: максимум 30 минут за раз
    const safeMinutes = Math.min(Math.max(parseInt(minutes) || 10, 1), 30);
    parking.expiresAt = new Date(parking.expiresAt.getTime() + safeMinutes * 60000);
    parking.extensionsUsed += 1;
    await parking.save();
    
    // 🔌 WebSocket: парковка продлена
    emitToAll('parking:extended', { 
      parkingId: parking._id.toString(),
      newExpiresAt: parking.expiresAt,
      extensionsUsed: parking.extensionsUsed 
    });
    
    res.json({ success: true, parking });
  } catch (error) {
    console.log("CREATE PARKING ERROR:", error);
    res.status(500).json({ success: false });
  }
});

app.put('/api/parkings/:id/comment', async (req, res) => {
  try {
    const { comment, userId } = req.body;
    const parking = await Parking.findById(req.params.id);
    if (!parking) return res.status(404).json({ success: false });
    
    // Проверка владельца
    if (userId && parking.ownerId.toString() !== userId) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    parking.comment = comment;
    await parking.save();
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
    
    // Проверка владельца (если передан userId)
    const userId = req.query.userId || req.body?.userId;
    if (userId && parking.ownerId.toString() !== userId) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    if (parking.status === 'booked') return res.status(400).json({ success: false, message: 'Нельзя отменить забронированную парковку' });
    parking.status = 'cancelled';
    await parking.save();
    
    // 🔌 WebSocket: парковка отменена
    emitToAll('parking:cancelled', { parkingId: parking._id.toString() });
    
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

    // Проверяем что отменяет именно тот кто забронировал или владелец
    const bookerId = parking.bookedBy?.toString();
    const ownerId = parking.ownerId?.toString();
    if (userId !== bookerId && userId !== ownerId) {
      return res.status(403).json({ success: false, message: 'Нет доступа' });
    }

    // Возврат баллов: бронирующему +price, владельцу -ownerEarnings
    const booking = await Booking.findOne({ parkingId: parking._id, status: 'active' });
    if (booking && bookerId) {
      const refundAmount = booking.price || parking.price;
      const ownerEarnings = booking.ownerEarnings || Math.floor(refundAmount * 0.75);
      
      // Возвращаем баллы бронирующему
      await User.findByIdAndUpdate(bookerId, { $inc: { balance: refundAmount } });
      await new Transaction({ userId: bookerId, type: 'cancellation', amount: refundAmount, description: `Возврат за отмену: ${parking.address}` }).save();
      
      // Списываем с владельца (атомарно, не уходим в минус)
      const ownerDeducted = await User.findOneAndUpdate(
        { _id: ownerId, balance: { $gte: ownerEarnings } },
        { $inc: { balance: -ownerEarnings } },
        { new: true }
      );
      if (!ownerDeducted) {
        // Если не хватает — списываем что есть (до нуля)
        const ownerNow = await User.findById(ownerId).select('balance').lean();
        const deductable = Math.min(ownerNow?.balance || 0, ownerEarnings);
        if (deductable > 0) {
          await User.findByIdAndUpdate(ownerId, { $inc: { balance: -deductable } });
        }
      }
      await new Transaction({ userId: ownerId, type: 'cancellation', amount: -ownerEarnings, description: `Отмена бронирования: ${parking.address}` }).save();
      
      // Помечаем бронирование как отменённое
      booking.status = 'cancelled';
      await booking.save();
      
      console.log(`💸 Refund: booker +${refundAmount}, owner -${ownerEarnings} for parking ${parking.address}`);
    }

    parking.status = 'available';
    parking.bookedBy = null;
    parking.bookedAt = null;
    parking.bookerCar = null;
    parking.bookerName = null;
    parking.bookerAvatar = null;
    parking.messages = [];
    await parking.save();
    
    // 🔌 WebSocket: бронирование отменено
    emitToAll('booking:cancelled', { parkingId: parking._id.toString() });
    emitToAll('parking:cancelledBooking', { parkingId: parking._id.toString() });
    // Обновляем баланс участникам (отправляем актуальный баланс)
    const bookerFresh = await User.findById(bookerId).select('balance').lean();
    const ownerFresh = await User.findById(ownerId).select('balance').lean();
    emitToUser(bookerId, 'balance:update', { balance: bookerFresh?.balance });
    emitToUser(ownerId, 'balance:update', { balance: ownerFresh?.balance });
    
    res.json({ success: true });
  } catch (error) {
    console.log("CANCEL BOOKING ERROR:", error);
    res.status(500).json({ success: false });
  }
});

app.post('/api/parkings/:id/cancel-waiting', async (req, res) => {
  try {
    const { ownerId, reason } = req.body;
    const parking = await Parking.findById(req.params.id);
    if (!parking) return res.status(404).json({ success: false });
    
    // Проверяем что отменяет именно владелец
    if (parking.ownerId.toString() !== ownerId) {
      return res.status(403).json({ success: false, message: 'Нет доступа' });
    }
    
    // Если парковка была забронирована — рефанд бронирующему
    if (parking.status === 'booked' && parking.bookedBy) {
      const booking = await Booking.findOne({ parkingId: parking._id, status: 'active' });
      if (booking) {
        const refundAmount = booking.price || parking.price;
        const ownerEarnings = booking.ownerEarnings || Math.floor(refundAmount * 0.75);
        
        await User.findByIdAndUpdate(parking.bookedBy, { $inc: { balance: refundAmount } });
        await new Transaction({ userId: parking.bookedBy.toString(), type: 'cancellation', amount: refundAmount, description: `Возврат (владелец отменил): ${parking.address}` }).save();
        
        // Списываем с владельца (атомарно, не уходим в минус)
        const ownerDeducted = await User.findOneAndUpdate(
          { _id: ownerId, balance: { $gte: ownerEarnings } },
          { $inc: { balance: -ownerEarnings } },
          { new: true }
        );
        if (!ownerDeducted) {
          const ownerNow = await User.findById(ownerId).select('balance').lean();
          const deductable = Math.min(ownerNow?.balance || 0, ownerEarnings);
          if (deductable > 0) {
            await User.findByIdAndUpdate(ownerId, { $inc: { balance: -deductable } });
          }
        }
        await new Transaction({ userId: ownerId, type: 'cancellation', amount: -ownerEarnings, description: `Владелец отменил: ${parking.address}` }).save();
        
        booking.status = 'cancelled';
        await booking.save();
        
        console.log(`💸 Owner cancelled booked parking: refund +${refundAmount} to booker, -${ownerEarnings} from owner`);
      }
    } else {
      await new Transaction({ userId: ownerId, type: 'cancellation', amount: 0, description: `Владелец отменил: ${parking.address}` }).save();
    }
    
    parking.status = 'cancelled';
    await parking.save();
    res.json({ success: true });
  } catch (error) {
    console.log("CANCEL WAITING ERROR:", error);
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
    const { userId } = req.body;
    const parking = await Parking.findById(req.params.id);
    if (!parking) return res.status(404).json({ success: false });
    
    // Проверка: только бронирующий может отметить приезд
    if (userId && userId !== parking.bookedBy?.toString()) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    // Проверка: парковка должна быть забронирована
    if (parking.status !== 'booked') {
      return res.status(400).json({ success: false, message: 'Parking is not booked' });
    }
    
    parking.arrivedAt = new Date();
    await parking.save();
    
    // Push notification to owner - driver arrived (только нужные поля!)
    const [owner, booker] = await Promise.all([
      User.findById(parking.ownerId).select('pushToken language').lean(),
      User.findById(parking.bookedBy).select('name').lean()
    ]);
    if (owner && owner.pushToken) {
      const lang = owner.language || 'en';
      const title = getPushText('arrived', 'title', lang);
      const body = getPushText('arrived', 'body', lang, { name: booker?.name || 'Driver' });
      sendPushNotification(owner.pushToken, title, body, { type: 'arrived', parkingId: parking._id.toString() });
    }
    
    // 🔌 WebSocket: букер приехал — уведомляем владельца
    emitToUser(parking.ownerId, 'booking:arrived', { parkingId: parking._id.toString(), arrivedAt: parking.arrivedAt });
    
    res.json({ success: true, parking });
  } catch (error) {
    console.log("ARRIVED ERROR:", error);
    res.status(500).json({ success: false });
  }
});

app.post('/api/parkings/:id/confirm-meet', async (req, res) => {
  try {
    const { userId } = req.body;
    const parking = await Parking.findById(req.params.id);
    if (!parking) return res.status(404).json({ success: false });
    
    // Проверка: только владелец или бронирующий может завершить сделку
    if (userId && userId !== parking.ownerId?.toString() && userId !== parking.bookedBy?.toString()) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    // Проверка: парковка должна быть в статусе booked
    if (parking.status !== 'booked') {
      return res.status(400).json({ success: false, message: 'Parking is not booked' });
    }
    
    parking.confirmedAt = new Date();
    parking.status = 'completed';
    await parking.save();
    
    const booking = await Booking.findOneAndUpdate(
      { parkingId: parking._id, status: 'active' },
      { status: 'completed', completedAt: new Date() },
      { new: true }
    );

    // Push notifications - параллельно, только нужные поля
    const [booker, owner] = await Promise.all([
      User.findById(parking.bookedBy).select('pushToken language').lean(),
      User.findById(parking.ownerId).select('pushToken language').lean()
    ]);
    
    if (booker && booker.pushToken) {
      const lang = booker.language || 'en';
      const title = getPushText('completedBooker', 'title', lang);
      const body = getPushText('completedBooker', 'body', lang);
      sendPushNotification(booker.pushToken, title, body, { type: 'completed', parkingId: parking._id.toString() });
    }
    
    if (owner && owner.pushToken) {
      const lang = owner.language || 'en';
      // Используем ownerEarnings из booking, так как комиссия уже была рассчитана при бронировании
      const ownerEarnings = booking?.ownerEarnings || Math.floor(parking.price * 0.75);
      const title = getPushText('completed', 'title', lang);
      const body = getPushText('completed', 'body', lang, { amount: ownerEarnings.toString() });
      sendPushNotification(owner.pushToken, title, body, { type: 'completed', parkingId: parking._id.toString() });
    }
    
    // Обновляем статистику пользователей - параллельно
    await Promise.all([
      User.findByIdAndUpdate(parking.ownerId, { $inc: { parkingsGiven: 1 } }),
      User.findByIdAndUpdate(parking.bookedBy, { $inc: { parkingsReceived: 1 } }),
      Friendship.updateOne(
        {
          $or: [
            { user1: parking.ownerId, user2: parking.bookedBy },
            { user1: parking.bookedBy, user2: parking.ownerId }
          ],
          status: 'accepted'
        },
        { $inc: { exchangeCount: 1 } }
      )
    ]);
    
    // Реферальный пассивный доход (+1 балл рефереру за сделку)
    creditReferralPassive(parking.bookedBy, 'парковка');
    creditReferralPassive(parking.ownerId, 'парковка');
    
    // 🔌 WebSocket: сделка завершена
    emitToAll('parking:completed', { parkingId: parking._id.toString() });
    emitToUser(parking.ownerId, 'booking:completed', { parkingId: parking._id.toString(), bookingId: booking?._id });
    emitToUser(parking.bookedBy, 'booking:completed', { parkingId: parking._id.toString(), bookingId: booking?._id });
    // Отправляем актуальный баланс
    const ownerBalanceAfter = await User.findById(parking.ownerId).select('balance').lean();
    const bookerBalanceAfter = await User.findById(parking.bookedBy).select('balance').lean();
    emitToUser(parking.ownerId, 'balance:update', { balance: ownerBalanceAfter?.balance });
    emitToUser(parking.bookedBy, 'balance:update', { balance: bookerBalanceAfter?.balance });
    
    // Обновляем прогресс заданий
    const today = getTodayDate();
    
    // Owner - give_parking
    const ownerProgress = await UserDailyProgress.findOne({ userId: parking.ownerId, date: today });
    if (ownerProgress) {
      const giveTask = ownerProgress.tasks.find(t => t.code === 'give_parking' || t.type === 'give_parking');
      if (giveTask && !giveTask.completed) {
        giveTask.currentValue += 1;
        if (giveTask.currentValue >= 1) giveTask.completed = true;
        ownerProgress.markModified('tasks');
        await ownerProgress.save();
      }
    }
    
    // Booker - receive_parking
    const bookerProgress = await UserDailyProgress.findOne({ userId: parking.bookedBy, date: today });
    if (bookerProgress) {
      const receiveTask = bookerProgress.tasks.find(t => t.code === 'receive_parking' || t.type === 'receive_parking');
      if (receiveTask && !receiveTask.completed) {
        receiveTask.currentValue += 1;
        if (receiveTask.currentValue >= 1) receiveTask.completed = true;
        bookerProgress.markModified('tasks');
        await bookerProgress.save();
      }
    }
    
    res.json({ success: true, message: 'Сделка завершена!', bookingId: booking?._id });
  } catch (error) {
    console.log("CONFIRM MEET ERROR:", error);
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
    
    // Проверка: только владелец или бронирующий могут писать
    if (userId !== parking.ownerId?.toString() && userId !== parking.bookedBy?.toString()) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
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
    
    // 🔌 WebSocket: новое сообщение в чате бронирования
    const recipientIdStr = (isOwner ? parking.bookedBy : parking.ownerId)?.toString();
    const lastMsg = parking.messages[parking.messages.length - 1];
    io.to(`parking:${parking._id.toString()}`).emit('message:booking', { 
      parkingId: parking._id.toString(), 
      message: lastMsg 
    });
    // На случай если получатель не в комнате — пушим напрямую
    emitToUser(recipientIdStr, 'message:booking', { 
      parkingId: parking._id.toString(), 
      message: lastMsg 
    });
    
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
    
    // Проверка: только участники
    if (fromUserId !== parking.ownerId?.toString() && fromUserId !== parking.bookedBy?.toString()) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    // Лимит: максимум 15 минут
    const safeMinutes = Math.min(Math.max(parseInt(minutes) || 5, 1), 15);
    
    parking.waitRequest = { minutes: safeMinutes, fromUserId, createdAt: new Date() };
    await parking.save();
    
    // Push notification - wait request (только нужные поля)
    const recipientId = fromUserId === parking.ownerId?.toString() ? parking.bookedBy : parking.ownerId;
    const [sender, recipient] = await Promise.all([
      User.findById(fromUserId).select('name').lean(),
      User.findById(recipientId).select('pushToken language').lean()
    ]);
    if (recipient && recipient.pushToken) {
      const lang = recipient.language || 'en';
      const title = getPushText('waitRequest', 'title', lang);
      const body = getPushText('waitRequest', 'body', lang, { name: sender?.name || 'User', min: minutes.toString() });
      sendPushNotification(recipient.pushToken, title, body, { type: 'waitRequest', parkingId: parking._id.toString() });
    }
    
    // 🔌 WebSocket: запрос подождать
    emitToUser(recipientId, 'booking:waitRequest', { 
      parkingId: parking._id.toString(), 
      minutes: safeMinutes, 
      fromUserId 
    });
    
    res.json({ success: true });
  } catch (error) {
    console.log("WAIT REQUEST ERROR:", error);
    res.status(500).json({ success: false });
  }
});

app.post("/api/parkings/:id/wait-response", async (req, res) => {
  try {
    const { accepted, userId } = req.body;
    const parking = await Parking.findById(req.params.id);
    if (!parking) return res.status(404).json({ success: false });
    
    // Запоминаем кто запросил ожидание до обнуления
    const waitRequestFromUserId = parking.waitRequest?.fromUserId?.toString();
    
    if (accepted && parking.waitRequest) {
      parking.expiresAt = new Date(parking.expiresAt.getTime() + parking.waitRequest.minutes * 60000);
    }
    
    // Save response for both to see
    parking.waitResponse = { accepted, respondedAt: new Date() };
    parking.waitRequest = null;
    await parking.save();
    
    // 🔌 WebSocket: ответ на запрос подождать — отправляем ОБОИМ
    const wsData = { 
      parkingId: parking._id.toString(), 
      accepted,
      newExpiresAt: parking.expiresAt
    };
    if (parking.ownerId) emitToUser(parking.ownerId.toString(), 'booking:waitResponse', wsData);
    if (parking.bookedBy) emitToUser(parking.bookedBy.toString(), 'booking:waitResponse', wsData);
    
    // 📱 Push: уведомляем того кто запросил ожидание
    if (waitRequestFromUserId) {
      const recipient = await User.findById(waitRequestFromUserId).select('pushToken language').lean();
      if (recipient?.pushToken) {
        const lang = recipient.language || 'en';
        const titles = { en: accepted ? '✅ Wait accepted!' : '❌ Cannot wait', ru: accepted ? '✅ Готовы подождать!' : '❌ Не могут ждать', es: accepted ? '✅ ¡Esperarán!' : '❌ No pueden esperar', uk: accepted ? '✅ Готові почекати!' : '❌ Не можуть чекати' };
        const bodies = { en: accepted ? 'The other driver agreed to wait for you' : 'The other driver cannot wait longer', ru: accepted ? 'Другой водитель согласился подождать' : 'Другой водитель не может ждать дольше', es: accepted ? 'El otro conductor aceptó esperar' : 'El otro conductor no puede esperar más', uk: accepted ? 'Інший водій погодився почекати' : 'Інший водій не може чекати довше' };
        sendPushNotification(recipient.pushToken, titles[lang] || titles.en, bodies[lang] || bodies.en, { type: 'waitResponse', parkingId: parking._id.toString() });
      }
    }
    
    res.json({ success: true, accepted });
  } catch (error) {
    console.log("WAIT RESPONSE ERROR:", error);
    res.status(500).json({ success: false });
  }
});

// ==================== GROUP CHATS ====================

// Create group chat
app.post('/api/group-chats', async (req, res) => {
  try {
    const { creatorId, name, memberIds } = req.body;
    if (!creatorId || !name || !memberIds || memberIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Name and members required' });
    }
    const allMembers = [creatorId, ...memberIds.filter(id => id !== creatorId)];
    
    const creator = await User.findById(creatorId).select('name').lean();
    const creatorName = creator?.name || 'User';
    
    // Add system welcome message so unread count picks it up
    const systemMessage = {
      fromUserId: creatorId,
      senderName: creatorName,
      text: `${creatorName} created the group`,
      createdAt: new Date()
    };
    
    const chat = new GroupChat({ name, creatorId, members: allMembers, messages: [systemMessage] });
    await chat.save();
    
    // Mark as read for creator only
    chat.readBy = [{ userId: creatorId, readAt: new Date() }];
    await chat.save();
    
    // Notify members via WS + Push
    const invitedMembers = await User.find({ 
      _id: { $in: allMembers.filter(id => id !== creatorId) } 
    }).select('pushToken language').lean();
    
    for (const member of invitedMembers) {
      emitToUser(member._id.toString(), 'groupChat:created', { chatId: chat._id.toString(), name });
      
      if (member.pushToken) {
        const lang = member.language || 'en';
        const titles = { en: 'New group chat', ru: 'Новый групповой чат', uk: 'Новий груповий чат', es: 'Nuevo chat grupal' };
        const bodies = { en: `${creatorName} added you to "${name}"`, ru: `${creatorName} добавил вас в "${name}"`, uk: `${creatorName} додав вас до "${name}"`, es: `${creatorName} te agregó a "${name}"` };
        sendPushNotification(member.pushToken, titles[lang] || titles.en, bodies[lang] || bodies.en, { type: 'group_created', chatId: chat._id.toString() });
      }
    }
    
    res.json({ success: true, chat });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get user's group chats
app.get('/api/group-chats/:userId', async (req, res) => {
  try {
    const chats = await GroupChat.find({ members: req.params.userId, isForum: { $ne: true } })
      .populate('members', 'name avatar avatarThumb')
      .sort({ 'messages.createdAt': -1, createdAt: -1 })
      .lean();
    
    const result = chats.map(chat => {
      const lastMsg = chat.messages?.filter(m => !m.deletedForAll).slice(-1)[0] || null;
      const readEntry = chat.readBy?.find(r => r.userId?.toString() === req.params.userId);
      const readAt = readEntry?.readAt || new Date(0);
      const unread = chat.messages?.filter(m => 
        !m.deletedForAll && 
        m.fromUserId?.toString() !== req.params.userId && 
        new Date(m.createdAt) > new Date(readAt)
      ).length || 0;
      return { ...chat, membersInfo: chat.members, lastMessage: lastMsg, unreadCount: unread, messages: undefined };
    });
    
    res.json(result);
  } catch (error) {
    res.json([]);
  }
});

// Get group messages
app.get('/api/group-chats/:chatId/messages/:userId', async (req, res) => {
  try {
    const chat = await GroupChat.findById(req.params.chatId).lean();
    if (!chat) return res.json([]);
    const messages = (chat.messages || []).filter(m => 
      !m.deletedForAll && !(m.deletedFor || []).some(id => id.toString() === req.params.userId)
    );
    res.json(messages);
  } catch (error) {
    res.json([]);
  }
});

// Send group message
app.post('/api/group-chats/:chatId/message', async (req, res) => {
  try {
    const { fromUserId, text, imageBase64, replyTo } = req.body;
    const chat = await GroupChat.findById(req.params.chatId);
    if (!chat) return res.status(404).json({ success: false });

    // Auto-add user to forum members
    if (chat.isForum && !chat.members.some(m => m.toString() === fromUserId)) {
      chat.members.push(fromUserId);
    }

    const sender = await User.findById(fromUserId).select('name avatar avatarThumb').lean();

    let image = null;
    let imageThumb = null;
    if (imageBase64) {
      image = await uploadChatImage(imageBase64, fromUserId);
      if (image) {
        imageThumb = getCloudinaryThumb(image, 400);
      }
    }

    const message = {
      fromUserId,
      senderName: sender?.name || 'User',
      senderAvatar: sender?.avatarThumb || sender?.avatar || null,
      text: text || '',
      image,
      imageThumb,
      replyTo: replyTo || undefined,
      createdAt: new Date()
    };

    chat.messages.push(message);
    await chat.save();

    const lastMsg = chat.messages[chat.messages.length - 1];

    // WS notify all members
    chat.members.forEach(uid => {
      if (uid.toString() !== fromUserId) {
        emitToUser(uid, 'groupMessage:new', { chatId: chat._id.toString(), fromUserId, message: lastMsg });
      }
    });

    // Push to members
    if (chat.isForum) {
      // Forum: only push to users who opted in
      if (chat.forumNotifyUsers && chat.forumNotifyUsers.length > 0) {
        const notifyIds = chat.forumNotifyUsers.filter(id => id.toString() !== fromUserId);
        if (notifyIds.length > 0) {
          const members = await User.find({ _id: { $in: notifyIds } }).select('pushToken language').lean();
          members.forEach(m => {
            if (m.pushToken) {
              sendPushNotification(m.pushToken, `${chat.name}`, `${sender?.name || 'User'}: ${text || '📷'}`, { type: 'group_message', chatId: chat._id.toString() });
            }
          });
        }
      }
    } else {
      const members = await User.find({ _id: { $in: chat.members.filter(id => id.toString() !== fromUserId) } })
        .select('pushToken language').lean();
      members.forEach(m => {
        if (m.pushToken) {
          sendPushNotification(m.pushToken,
            `${chat.name}`,
            `${sender?.name || 'User'}: ${text || '📷'}`,
            { type: 'group_message', chatId: chat._id.toString() });
        }
      });
    }
    
    res.json({ success: true, message: lastMsg });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Mark group messages read
app.post('/api/group-chats/:chatId/read', async (req, res) => {
  try {
    const { userId } = req.body;
    const chat = await GroupChat.findById(req.params.chatId);
    if (!chat) return res.status(404).json({ success: false });

    // Auto-add user to forum members
    if (chat.isForum && !chat.members.some(m => m.toString() === userId)) {
      chat.members.push(userId);
    }

    const existing = chat.readBy.find(r => r.userId?.toString() === userId);
    if (existing) {
      existing.readAt = new Date();
    } else {
      chat.readBy.push({ userId, readAt: new Date() });
    }
    await chat.save();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// Delete group message
app.delete('/api/group-chats/message/:messageId', async (req, res) => {
  try {
    const { userId, forAll } = req.body;
    const chat = await GroupChat.findOne({ 'messages._id': req.params.messageId });
    if (!chat) return res.status(404).json({ success: false });
    
    const msg = chat.messages.id(req.params.messageId);
    if (!msg) return res.status(404).json({ success: false });
    
    if (forAll && msg.fromUserId?.toString() === userId) {
      msg.deletedForAll = true;
      // WS notify all members about deletion
      chat.members.forEach(uid => {
        if (uid.toString() !== userId) {
          emitToUser(uid, 'groupMessage:deleted', { chatId: chat._id.toString(), messageId: req.params.messageId, forAll: true });
        }
      });
    } else {
      if (!msg.deletedFor) msg.deletedFor = [];
      msg.deletedFor.push(userId);
    }
    await chat.save();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// Add members to group
app.patch('/api/group-chats/:chatId/members', async (req, res) => {
  try {
    const { memberIds } = req.body;
    const chat = await GroupChat.findById(req.params.chatId);
    if (!chat) return res.status(404).json({ success: false });
    
    memberIds.forEach(id => {
      if (!chat.members.some(m => m.toString() === id)) {
        chat.members.push(id);
      }
    });
    await chat.save();
    res.json({ success: true, chat });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// Leave group chat
app.post('/api/group-chats/:chatId/leave', async (req, res) => {
  try {
    const { userId } = req.body;
    const chat = await GroupChat.findById(req.params.chatId);
    if (!chat) return res.status(404).json({ success: false });
    
    chat.members = chat.members.filter(m => m.toString() !== userId);
    
    // If no members left, delete the chat
    if (chat.members.length === 0) {
      await GroupChat.findByIdAndDelete(req.params.chatId);
    } else {
      await chat.save();
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// ==================== FORUM ====================

// Get all forum topics
app.get('/api/forum', async (req, res) => {
  try {
    const reqUserId = req.query.userId;
    const topics = await GroupChat.find({ isForum: true })
      .populate('creatorId', 'name')
      .populate('members', 'name avatar avatarThumb')
      .lean();

    const result = topics.map(t => {
      const activeMessages = (t.messages || []).filter(m => !m.deletedForAll);
      let unreadCount = 0;
      if (reqUserId) {
        const readEntry = (t.readBy || []).find(r => r.userId?.toString() === reqUserId);
        const readAt = readEntry?.readAt || new Date(0);
        unreadCount = activeMessages.filter(m =>
          m.fromUserId?.toString() !== reqUserId &&
          new Date(m.createdAt) > new Date(readAt)
        ).length;
      }
      return {
        _id: t._id,
        name: t.name,
        creatorId: t.creatorId?._id || t.creatorId,
        creatorName: t.creatorId?.name || '',
        messageCount: activeMessages.length,
        notifyEnabled: reqUserId ? (t.forumNotifyUsers || []).some(id => id.toString() === reqUserId) : false,
        unreadCount,
        members: t.members,
        membersInfo: t.members,
        isForum: true,
        createdAt: t.createdAt
      };
    }).sort((a, b) => b.messageCount - a.messageCount);

    res.json(result);
  } catch (error) {
    res.json([]);
  }
});

// Create forum topic
app.post('/api/forum', async (req, res) => {
  try {
    const { creatorId, name } = req.body;
    if (!creatorId || !name) {
      return res.status(400).json({ success: false, message: 'Name required' });
    }

    const topic = new GroupChat({ name, creatorId, members: [creatorId], isForum: true, messages: [] });
    await topic.save();
    res.json({ success: true, topic });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Toggle forum notifications for user
app.post('/api/forum/:chatId/notify', async (req, res) => {
  try {
    const { userId, enabled } = req.body;
    const chat = await GroupChat.findById(req.params.chatId);
    if (!chat || !chat.isForum) return res.status(404).json({ success: false });

    if (enabled) {
      if (!chat.forumNotifyUsers.some(id => id.toString() === userId)) {
        chat.forumNotifyUsers.push(userId);
      }
    } else {
      chat.forumNotifyUsers = chat.forumNotifyUsers.filter(id => id.toString() !== userId);
    }
    await chat.save();
    res.json({ success: true, enabled });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// ==================== CONVOY / КАРАВАН ====================

// Создать конвой
app.post('/api/convoys', async (req, res) => {
  try {
    const { creatorId, name, destination, friendIds } = req.body;
    if (!creatorId || !name) return res.status(400).json({ success: false, message: 'Name required' });
    
    const creator = await User.findById(creatorId).select('name avatarThumb').lean();
    if (!creator) return res.status(404).json({ success: false });
    
    const members = [{
      userId: creatorId,
      name: creator.name,
      avatar: creator.avatarThumb,
      status: 'active',
      joinedAt: new Date()
    }];
    
    // Добавить приглашённых друзей в массив members
    let invitedFriends = [];
    if (friendIds && friendIds.length > 0) {
      invitedFriends = await User.find({ _id: { $in: friendIds } }).select('name avatarThumb pushToken language').lean();
      for (const friend of invitedFriends) {
        members.push({
          userId: friend._id,
          name: friend.name,
          avatar: friend.avatarThumb,
          status: 'invited'
        });
      }
    }
    
    const convoy = new Convoy({ name, creatorId, destination, members });
    await convoy.save();
    
    // Push + WS invites (после save, чтобы convoyId был доступен)
    for (const friend of invitedFriends) {
      if (friend.pushToken) {
        const lang = friend.language || 'en';
        const titles = { en: '🚗 Convoy invite!', ru: '🚗 Приглашение в караван!', es: '🚗 ¡Invitación al convoy!', uk: '🚗 Запрошення в караван!' };
        const bodies = { en: `${creator.name} invites you to "${name}"`, ru: `${creator.name} приглашает вас в "${name}"`, es: `${creator.name} te invita a "${name}"`, uk: `${creator.name} запрошує вас до "${name}"` };
        sendPushNotification(friend.pushToken, titles[lang] || titles.en, bodies[lang] || bodies.en, { type: 'convoy_invite', convoyId: convoy._id.toString() });
      }
      emitToUser(friend._id.toString(), 'convoy:invited', { convoyId: convoy._id.toString(), convoyName: name, creatorName: creator.name });
    }
    
    res.json({ success: true, convoy });
  } catch (error) {
    console.log('CONVOY CREATE ERROR:', error);
    res.status(500).json({ success: false });
  }
});

// Мои конвои (активные)
app.get('/api/users/:id/convoys', async (req, res) => {
  try {
    const userId = req.params.id;
    const convoys = await Convoy.find({ 
      members: { $elemMatch: { userId: userId, status: { $ne: 'left' } } },
      status: 'active' 
    }).sort({ createdAt: -1 }).lean();
    
    // Добавляем unreadCount для каждого каравана
    const result = convoys.map(c => {
      const me = c.members.find(m => m.userId?.toString() === userId);
      const readAt = me?.lastChatReadAt || me?.joinedAt || new Date(0);
      const unreadCount = (c.messages || []).filter(m => new Date(m.createdAt) > new Date(readAt) && m.userId !== userId).length;
      return { ...c, unreadCount };
    });
    
    res.json(result);
  } catch (error) {
    res.json([]);
  }
});

// Получить конвой
app.get('/api/convoys/:id', async (req, res) => {
  try {
    const convoy = await Convoy.findById(req.params.id).lean();
    if (!convoy) return res.status(404).json({ success: false });
    res.json(convoy);
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// Принять приглашение
app.post('/api/convoys/:id/join', async (req, res) => {
  try {
    const { userId } = req.body;
    const convoy = await Convoy.findById(req.params.id);
    if (!convoy || convoy.status !== 'active') return res.status(404).json({ success: false });
    
    const member = convoy.members.find(m => m.userId?.toString() === userId);
    if (member) {
      member.status = 'active';
      member.joinedAt = new Date();
    } else {
      const user = await User.findById(userId).select('name avatarThumb').lean();
      convoy.members.push({ userId, name: user?.name, avatar: user?.avatarThumb, status: 'active', joinedAt: new Date() });
    }
    await convoy.save();
    
    // WS: уведомить всех в комнате
    const convoyRoom = `convoy:${convoy._id.toString()}`;
    io.to(convoyRoom).emit('convoy:memberJoined', { convoyId: convoy._id.toString(), userId });
    
    res.json({ success: true, convoy });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// Покинуть конвой
app.post('/api/convoys/:id/leave', async (req, res) => {
  try {
    const { userId } = req.body;
    const convoy = await Convoy.findById(req.params.id);
    if (!convoy) return res.status(404).json({ success: false });
    
    const member = convoy.members.find(m => m.userId?.toString() === userId);
    if (member) member.status = 'left';
    
    // Авто-завершение если все кроме создателя вышли
    const activeMembers = convoy.members.filter(m => 
      m.userId?.toString() !== convoy.creatorId.toString() && m.status !== 'left' && m.status !== 'invited'
    );
    if (activeMembers.length === 0) {
      convoy.status = 'completed';
    }
    
    await convoy.save();
    
    // WS
    const convoyRoom = `convoy:${convoy._id.toString()}`;
    io.to(convoyRoom).emit('convoy:memberLeft', { convoyId: convoy._id.toString(), userId, name: member?.name });
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// Завершить конвой (только создатель)
app.post('/api/convoys/:id/end', async (req, res) => {
  try {
    const { userId } = req.body;
    const convoy = await Convoy.findById(req.params.id);
    if (!convoy) return res.status(404).json({ success: false });
    if (convoy.creatorId.toString() !== userId) return res.status(403).json({ success: false, message: 'Only creator can end' });
    
    convoy.status = 'completed';
    await convoy.save();
    
    // WS
    const convoyRoom = `convoy:${convoy._id.toString()}`;
    io.to(convoyRoom).emit('convoy:ended', { convoyId: convoy._id.toString(), name: convoy.name });
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// Обновить локацию участника
app.post('/api/convoys/:id/location', async (req, res) => {
  try {
    const { userId, location } = req.body;
    const convoy = await Convoy.findById(req.params.id);
    if (!convoy || convoy.status !== 'active') return res.status(404).json({ success: false });
    
    const member = convoy.members.find(m => m.userId?.toString() === userId);
    if (member) {
      member.location = location;
      member.lastLocationUpdate = new Date();
    }
    await convoy.save();
    
    // WS: отправить всем в комнате обновление позиции
    const convoyRoom = `convoy:${convoy._id.toString()}`;
    io.to(convoyRoom).emit('convoy:locationUpdate', { 
      convoyId: convoy._id.toString(), userId, location 
    });
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// Обновить статус участника (stopped, arrived)
app.post('/api/convoys/:id/status', async (req, res) => {
  try {
    const { userId, status } = req.body;
    const convoy = await Convoy.findById(req.params.id);
    if (!convoy) return res.status(404).json({ success: false });
    
    const member = convoy.members.find(m => m.userId?.toString() === userId);
    if (member) member.status = status;
    await convoy.save();
    
    // WS broadcast в комнату
    const convoyRoom = `convoy:${convoy._id.toString()}`;
    io.to(convoyRoom).emit('convoy:statusUpdate', { 
      convoyId: convoy._id.toString(), userId, status, name: member?.name 
    });
    
    // Push уведомления
    for (const m of convoy.members) {
      if (m.userId?.toString() !== userId && m.status !== 'left' && m.status !== 'invited') {
        const recipient = await User.findById(m.userId).select('pushToken language').lean();
        if (recipient?.pushToken) {
          const lang = recipient.language || 'en';
          const memberName = member?.name || 'User';
          if (status === 'stopped') {
            const titles = { en: '🔴 Convoy stop', ru: '🔴 Остановка', es: '🔴 Parada', uk: '🔴 Зупинка' };
            const bodies = { en: `${memberName} has stopped`, ru: `${memberName} остановился`, es: `${memberName} se detuvo`, uk: `${memberName} зупинився` };
            sendPushNotification(recipient.pushToken, titles[lang] || titles.en, bodies[lang] || bodies.en, { type: 'convoy_status', convoyId: convoy._id.toString() });
          } else if (status === 'active') {
            const titles = { en: '🟢 Back on the road', ru: '🟢 Снова в пути', es: '🟢 De vuelta', uk: '🟢 Знову в дорозі' };
            const bodies = { en: `${memberName} is moving again`, ru: `${memberName} снова в пути`, es: `${memberName} está en movimiento`, uk: `${memberName} знову рухається` };
            sendPushNotification(recipient.pushToken, titles[lang] || titles.en, bodies[lang] || bodies.en, { type: 'convoy_status', convoyId: convoy._id.toString() });
          }
        }
      }
    }
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// Сообщения конвоя
app.get('/api/convoys/:id/messages', async (req, res) => {
  try {
    const convoy = await Convoy.findById(req.params.id).select('messages').lean();
    res.json(convoy?.messages || []);
  } catch (error) {
    res.json([]);
  }
});

app.post('/api/convoys/:id/messages', async (req, res) => {
  try {
    const { userId, text } = req.body;
    const convoy = await Convoy.findById(req.params.id);
    if (!convoy || convoy.status !== 'active') return res.status(404).json({ success: false });
    
    const member = convoy.members.find(m => m.userId?.toString() === userId);
    if (!member) return res.status(403).json({ success: false });
    
    const msg = {
      userId, senderName: member.name || 'User', text,
      time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
      createdAt: new Date()
    };
    convoy.messages.push(msg);
    await convoy.save();
    
    // WS broadcast в комнату каравана (для тех кто на ConvoyScreen)
    const convoyRoom = `convoy:${convoy._id.toString()}`;
    io.to(convoyRoom).emit('convoy:message', { convoyId: convoy._id.toString(), message: msg });
    
    // WS: convoy:activity для обновления бейджей на MapScreen/ProfileScreen/FriendsScreen
    for (const m of convoy.members) {
      if (m.userId?.toString() !== userId && (m.status === 'active' || m.status === 'stopped')) {
        emitToUser(m.userId.toString(), 'convoy:activity', { convoyId: convoy._id.toString() });
      }
    }
    
    // Push уведомления
    for (const m of convoy.members) {
      if (m.userId?.toString() !== userId && (m.status === 'active' || m.status === 'stopped')) {
        const recipient = await User.findById(m.userId).select('pushToken language').lean();
        if (recipient?.pushToken) {
          const lang = recipient.language || 'en';
          const shortText = text.length > 50 ? text.substring(0, 50) + '...' : text;
          sendPushNotification(recipient.pushToken, `🚗 ${convoy.name}`, `${member.name}: ${shortText}`, { type: 'convoy_message', convoyId: convoy._id.toString() });
        }
      }
    }
    
    res.json({ success: true, message: msg });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// Отметить чат каравана как прочитанный
app.post('/api/convoys/:id/read-chat', async (req, res) => {
  try {
    const { userId } = req.body;
    await Convoy.updateOne(
      { _id: req.params.id, 'members.userId': userId },
      { $set: { 'members.$.lastChatReadAt': new Date() } }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

app.post("/api/admin/clear-users", async (req, res) => {
  try {
    // Удаляем всех кроме админов
    const result = await User.deleteMany({ isAdmin: { $ne: true } });
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
        cars: user.cars || [],
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
    emitToUser(userId, 'balance:update', { balance: user.balance });
    res.json({ success: true, newBalance: user.balance });
  } catch (error) {
    console.log("ADD POINTS ERROR:", error);
    res.status(500).json({ success: false });
  }
});

// Админ: изменение баланса (из панели юзера)
app.post('/api/admin/users/balance', async (req, res) => {
  try {
    const { userId, amount, reason } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    user.balance += amount;
    if (user.balance < 0) user.balance = 0;
    await user.save();
    await new Transaction({ userId, type: amount > 0 ? 'bonus' : 'penalty', amount, description: reason || 'Admin adjustment' }).save();
    
    // Debug: check if user has active sockets
    const userIdStr = userId?.toString();
    const sockets = userSockets.get(userIdStr);
    console.log(`💰 Admin balance change: userId=${userIdStr}, amount=${amount}, newBalance=${user.balance}, activeSockets=${sockets ? sockets.size : 0}, allConnected=${Array.from(userSockets.keys()).join(',')}`);
    
    emitToUser(userIdStr, 'balance:update', { balance: user.balance });
    res.json({ success: true, newBalance: user.balance });
  } catch (error) {
    console.log("ADMIN BALANCE ERROR:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Админ: WS-уведомление об изменении баланса
app.post('/api/admin/emit-balance', async (req, res) => {
  try {
    const { userId } = req.body;
    const user = await User.findById(userId).select('balance').lean();
    if (!user) return res.status(404).json({ success: false });
    const userIdStr = userId?.toString();
    const sockets = userSockets.get(userIdStr);
    console.log(`📡 Admin emit-balance: userId=${userIdStr}, balance=${user.balance}, sockets=${sockets ? sockets.size : 0}`);
    emitToUser(userIdStr, 'balance:update', { balance: user.balance });
    res.json({ success: true, balance: user.balance, socketsNotified: sockets ? sockets.size : 0 });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// Админ: один юзер
app.get('/api/admin/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).lean();
    if (!user) return res.status(404).json({ success: false });
    res.json({ user });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// Админ: история транзакций юзера
app.get('/api/admin/users/:id/history', async (req, res) => {
  try {
    const transactions = await Transaction.find({ userId: req.params.id }).sort({ createdAt: -1 }).limit(100).lean();
    res.json(transactions);
  } catch (error) {
    res.json([]);
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

// ==================== AVATAR MIGRATION ====================
// Endpoint для создания миниатюр у существующих пользователей
app.post('/api/admin/migrate-avatars', async (req, res) => {
  try {
    // Находим пользователей с base64 аватарами (НЕ Cloudinary URL)
    const users = await User.find({ 
      avatar: { $exists: true, $ne: null, $ne: '' },
    }).select('_id avatar');
    
    // Фильтруем только base64 (не Cloudinary URL)
    const toMigrate = users.filter(u => u.avatar && !u.avatar.startsWith('https://res.cloudinary.com'));
    
    console.log(`☁️ Found ${toMigrate.length} users with base64 avatars to migrate to Cloudinary`);
    
    let migrated = 0;
    let failed = 0;
    const results = [];
    
    for (const user of toMigrate) {
      try {
        const cloudinaryUrl = await uploadToCloudinary(user.avatar, user._id.toString());
        if (cloudinaryUrl) {
          const thumbUrl = getCloudinaryThumb(cloudinaryUrl, 80);
          await User.findByIdAndUpdate(user._id, { 
            avatar: cloudinaryUrl, 
            avatarThumb: thumbUrl 
          });
          migrated++;
          results.push({ userId: user._id, status: 'ok', url: cloudinaryUrl });
          console.log(`☁️ Migrated user ${user._id} → Cloudinary`);
        } else {
          failed++;
          results.push({ userId: user._id, status: 'failed', error: 'upload returned null' });
        }
      } catch (err) {
        failed++;
        results.push({ userId: user._id, status: 'failed', error: err.message });
        console.log(`☁️ Failed user ${user._id}:`, err.message);
      }
    }
    
    res.json({ success: true, total: toMigrate.length, migrated, failed, results });
  } catch (error) {
    console.log('☁️ Migration error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Очистка base64 данных после миграции в Cloudinary (освобождает место в MongoDB)
app.post('/api/admin/cleanup-base64', async (req, res) => {
  try {
    // Находим юзеров у которых avatar — это Cloudinary URL (уже мигрированы)
    // и при этом в БД может остаться старый base64 в другом формате
    // На самом деле после миграции avatar уже = cloudinary URL, 
    // но надо убрать avatarThumb если это base64
    const users = await User.find({
      avatar: { $regex: /^https:\/\/res\.cloudinary\.com/ },
      avatarThumb: { $regex: /^data:image/ }
    }).select('_id avatar');
    
    let cleaned = 0;
    for (const user of users) {
      const thumbUrl = getCloudinaryThumb(user.avatar, 80);
      await User.findByIdAndUpdate(user._id, { avatarThumb: thumbUrl });
      cleaned++;
    }
    
    // Также чистим ownerAvatar и bookerAvatar в парковках
    const parkings = await Parking.find({
      $or: [
        { ownerAvatar: { $regex: /^data:image/ } },
        { bookerAvatar: { $regex: /^data:image/ } }
      ]
    }).select('_id ownerId bookedBy');
    
    let parkingsCleaned = 0;
    for (const p of parkings) {
      const updates = {};
      if (p.ownerId) {
        const owner = await User.findById(p.ownerId).select('avatarThumb').lean();
        if (owner?.avatarThumb) updates.ownerAvatar = owner.avatarThumb;
      }
      if (p.bookedBy) {
        const booker = await User.findById(p.bookedBy).select('avatarThumb').lean();
        if (booker?.avatarThumb) updates.bookerAvatar = booker.avatarThumb;
      }
      if (Object.keys(updates).length > 0) {
        await Parking.findByIdAndUpdate(p._id, updates);
        parkingsCleaned++;
      }
    }
    
    res.json({ success: true, usersCleaned: cleaned, parkingsCleaned });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Миграция аватаров в парковках (заменяем полные на миниатюры)
app.post('/api/admin/migrate-parking-avatars', async (req, res) => {
  try {
    // Находим парковки с большими аватарами (больше 10KB = скорее всего полный avatar)
    const parkings = await Parking.find({
      $or: [
        { ownerAvatar: { $exists: true, $regex: /^data:image.*base64,.{10000,}/ } },
        { bookerAvatar: { $exists: true, $regex: /^data:image.*base64,.{10000,}/ } }
      ]
    }).select('_id ownerAvatar bookerAvatar ownerId bookedBy');
    
    console.log(`Found ${parkings.length} parkings with large avatars to migrate`);
    
    let migrated = 0;
    let failed = 0;
    
    for (const parking of parkings) {
      try {
        const updates = {};
        
        // Если ownerAvatar большой - берём avatarThumb из User
        if (parking.ownerAvatar && parking.ownerAvatar.length > 10000) {
          const owner = await User.findById(parking.ownerId).select('avatarThumb').lean();
          if (owner?.avatarThumb) {
            updates.ownerAvatar = owner.avatarThumb;
          }
        }
        
        // Если bookerAvatar большой - берём avatarThumb из User
        if (parking.bookerAvatar && parking.bookerAvatar.length > 10000) {
          const booker = await User.findById(parking.bookedBy).select('avatarThumb').lean();
          if (booker?.avatarThumb) {
            updates.bookerAvatar = booker.avatarThumb;
          }
        }
        
        if (Object.keys(updates).length > 0) {
          await Parking.findByIdAndUpdate(parking._id, updates);
          migrated++;
          console.log(`Migrated parking ${parking._id}`);
        }
      } catch (err) {
        failed++;
        console.log(`Failed to migrate parking ${parking._id}:`, err.message);
      }
    }
    
    res.json({ success: true, total: parkings.length, migrated, failed });
  } catch (error) {
    console.log('Parking migration error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== DEBUG ====================

app.get('/api/debug/transactions', async (req, res) => {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Access denied' });
  }
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

// ==================== GAMIFICATION ====================

// Хелпер: получить сегодняшнюю дату в формате YYYY-MM-DD (America/New_York timezone)
const getTodayDate = () => {
  const now = new Date();
  // Конвертируем в NY timezone
  const nyTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const year = nyTime.getFullYear();
  const month = String(nyTime.getMonth() + 1).padStart(2, '0');
  const day = String(nyTime.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// Хелпер: получить вчерашнюю дату в формате YYYY-MM-DD (America/New_York timezone)
const getYesterdayDate = () => {
  const now = new Date();
  const nyTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  nyTime.setDate(nyTime.getDate() - 1);
  const year = nyTime.getFullYear();
  const month = String(nyTime.getMonth() + 1).padStart(2, '0');
  const day = String(nyTime.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// Получить уровень пользователя
app.get('/api/users/:id/level', async (req, res) => {
  const t0 = Date.now();
  try {
    const user = await User.findById(req.params.id).select('totalPointsEarned balance').lean();
    console.log(`  [level] User.findById: ${Date.now() - t0}ms`);
    if (!user) return res.json({ level: 1, progress: 0 });
    
    const t1 = Date.now();
    const settings = await getGameSettings();
    console.log(`  [level] getGameSettings: ${Date.now() - t1}ms`);
    if (!settings || !settings.levels) {
      return res.json({ level: 1, name: { en: 'Newbie', ru: 'Новичок' }, icon: '🚗', progress: 0 });
    }
    
    const t2 = Date.now();
    const parkingsGiven = await Parking.countDocuments({ ownerId: req.params.id, status: 'completed' });
    console.log(`  [level] Parking.countDocuments: ${Date.now() - t2}ms`);
    console.log(`  [level] TOTAL: ${Date.now() - t0}ms`);
    const totalPoints = user.totalPointsEarned || user.balance || 0;
    
    let currentLevel = settings.levels[0];
    let nextLevel = settings.levels[1];
    
    for (let i = settings.levels.length - 1; i >= 0; i--) {
      const lvl = settings.levels[i];
      if (totalPoints >= lvl.minPoints && parkingsGiven >= lvl.minParkingsGiven) {
        currentLevel = lvl;
        nextLevel = settings.levels[i + 1] || null;
        break;
      }
    }
    
    let progress = 100;
    if (nextLevel) {
      const pointsProgress = (totalPoints - currentLevel.minPoints) / (nextLevel.minPoints - currentLevel.minPoints);
      const parkingsProgress = (parkingsGiven - currentLevel.minParkingsGiven) / (nextLevel.minParkingsGiven - currentLevel.minParkingsGiven);
      progress = Math.min(Math.floor(Math.min(pointsProgress, parkingsProgress) * 100), 99);
    }
    
    res.json({
      level: currentLevel.level,
      name: currentLevel.name,
      icon: currentLevel.icon,
      progress,
      totalPoints,
      parkingsGiven,
      // Данные для следующего уровня
      nextLevel: nextLevel ? {
        level: nextLevel.level,
        name: nextLevel.name,
        icon: nextLevel.icon,
        minPoints: nextLevel.minPoints,
        minParkingsGiven: nextLevel.minParkingsGiven,
        pointsNeeded: nextLevel.minPoints - totalPoints,
        parkingsNeeded: nextLevel.minParkingsGiven - parkingsGiven
      } : null
    });
  } catch (error) {
    res.json({ level: 1, progress: 0 });
  }
});

// Получить ежедневные задания
app.get('/api/users/:id/daily-tasks', async (req, res) => {
  try {
    const userId = req.params.id;
    const today = getTodayDate();
    
    let progress = await UserDailyProgress.findOne({ userId, date: today });
    
    if (!progress) {
      const taskConfigs = await DailyTaskConfig.find({ isActive: true });
      progress = new UserDailyProgress({
        userId,
        date: today,
        tasks: taskConfigs.map(t => ({
          taskId: t._id,
          code: t.code,
          currentValue: 0,
          completed: false,
          rewardClaimed: false
        }))
      });
      await progress.save();
      
      // Обновляем streak
      let streak = await UserStreak.findOne({ userId });
      if (!streak) {
        streak = new UserStreak({ userId, currentStreak: 1, longestStreak: 1, lastActiveDate: today });
      } else {
        const yesterdayStr = getYesterdayDate();
        
        if (streak.lastActiveDate === yesterdayStr) {
          streak.currentStreak += 1;
          if (streak.currentStreak > streak.longestStreak) {
            streak.longestStreak = streak.currentStreak;
          }
        } else if (streak.lastActiveDate !== today) {
          streak.currentStreak = 1;
        }
        streak.lastActiveDate = today;
      }
      await streak.save();
      
      // Синхронизируем streak с User для achievements
      await User.findByIdAndUpdate(userId, { currentStreak: streak.currentStreak });
      
      // Отмечаем login задание
      const loginTask = progress.tasks.find(t => t.code === 'daily_login' || t.code === 'login' || t.type === 'login');
      if (loginTask) {
        loginTask.currentValue = 1;
        loginTask.completed = true;
        progress.markModified('tasks');
        await progress.save();
      }
    }
    
    const taskConfigs = await DailyTaskConfig.find({ isActive: true });
    const settings = await getGameSettings();
    
    const tasks = progress.tasks.map(t => {
      const config = taskConfigs.find(c => c.code === t.code);
      return {
        code: t.code,
        icon: config?.icon || '📋',
        name: config?.name,
        type: config?.type,
        targetValue: config?.targetValue || 1,
        currentValue: t.currentValue,
        completed: t.completed,
        rewardClaimed: t.rewardClaimed,
        reward: config?.reward || 10
      };
    });
    
    const allCompleted = tasks.every(t => t.completed);
    
    res.json({
      tasks,
      allTasksCompleted: allCompleted,
      allTasksBonusClaimed: progress.allTasksBonusClaimed,
      allTasksBonus: settings?.allDailyTasksBonus || 25
    });
  } catch (error) {
    console.log('Get daily tasks error:', error);
    res.json({ tasks: [] });
  }
});

// Забрать награду за задание
app.post('/api/users/:id/daily-tasks/:taskCode/claim', async (req, res) => {
  try {
    const { id: userId, taskCode } = req.params;
    const { callerUserId } = req.body;
    
    // Проверка: только сам пользователь может клеймить свои задания
    if (!callerUserId || callerUserId !== userId) {
      return res.status(403).json({ success: false, reason: 'access_denied' });
    }
    
    const today = getTodayDate();
    
    const progress = await UserDailyProgress.findOne({ userId, date: today });
    if (!progress) {
      console.log('ERROR: No progress found for today');
      return res.json({ success: false, reason: 'no_progress' });
    }
    
    console.log('Progress tasks:', JSON.stringify(progress.tasks));
    
    const task = progress.tasks.find(t => t.code === taskCode);
    if (!task) {
      console.log('ERROR: Task not found. Looking for:', taskCode);
      console.log('Available codes:', progress.tasks.map(t => t.code));
      return res.json({ success: false, reason: 'task_not_found' });
    }
    
    if (!task.completed) {
      console.log('ERROR: Task not completed');
      return res.json({ success: false, reason: 'not_completed' });
    }
    
    if (task.rewardClaimed) {
      console.log('ERROR: Already claimed');
      return res.json({ success: false, reason: 'already_claimed' });
    }
    
    const config = await DailyTaskConfig.findOne({ code: taskCode });
    const reward = config?.reward || 10;
    
    task.rewardClaimed = true;
    progress.markModified('tasks');
    await progress.save();
    
    const user = await User.findByIdAndUpdate(userId, { $inc: { balance: reward, totalPointsEarned: reward } }, { new: true });
    
    await new Transaction({ userId, amount: reward, type: 'daily_task', description: `Daily task: ${taskCode}` }).save();
    
    console.log('SUCCESS: Claimed', reward, 'points');
    res.json({ success: true, reward, newBalance: user.balance });
  } catch (error) {
    console.log('CLAIM ERROR:', error.message);
    res.json({ success: false, reason: 'error', message: error.message });
  }
});

// Забрать бонус за все задания
app.post('/api/users/:id/daily-tasks/claim-all-bonus', async (req, res) => {
  try {
    const userId = req.params.id;
    const { callerUserId } = req.body;
    
    // Проверка: только сам пользователь
    if (!callerUserId || callerUserId !== userId) {
      return res.status(403).json({ success: false, reason: 'access_denied' });
    }
    
    const today = getTodayDate();
    
    const progress = await UserDailyProgress.findOne({ userId, date: today });
    if (!progress || progress.allTasksBonusClaimed) return res.json({ success: false });
    
    const allCompleted = progress.tasks.every(t => t.completed);
    if (!allCompleted) return res.json({ success: false });
    
    const settings = await getGameSettings();
    const bonus = settings?.allDailyTasksBonus || 25;
    
    progress.allTasksBonusClaimed = true;
    await progress.save();
    
    const user = await User.findByIdAndUpdate(userId, { $inc: { balance: bonus, totalPointsEarned: bonus } }, { new: true });
    
    await new Transaction({ userId, amount: bonus, type: 'daily_task', description: 'All daily tasks completed' }).save();
    
    res.json({ success: true, bonus, newBalance: user.balance });
  } catch (error) {
    res.json({ success: false });
  }
});

// Получить streak
app.get('/api/users/:id/streak', async (req, res) => {
  try {
    const streak = await UserStreak.findOne({ userId: req.params.id });
    const settings = await getGameSettings();
    
    res.json({
      currentStreak: streak?.currentStreak || 0,
      longestStreak: streak?.longestStreak || 0,
      claimedBonuses: streak?.claimedBonuses || [],
      bonuses: settings?.streakBonuses || []
    });
  } catch (error) {
    res.json({ currentStreak: 0, longestStreak: 0, bonuses: [] });
  }
});

// Забрать streak бонус
app.post('/api/users/:id/streak/claim/:day', async (req, res) => {
  try {
    const { id: userId, day } = req.params;
    const { callerUserId } = req.body;
    
    // Проверка: только сам пользователь
    if (!callerUserId || callerUserId !== userId) {
      return res.status(403).json({ success: false, reason: 'access_denied' });
    }
    
    const dayNum = parseInt(day);
    
    const streak = await UserStreak.findOne({ userId });
    if (!streak || streak.currentStreak < dayNum) return res.json({ success: false });
    if (streak.claimedBonuses?.includes(dayNum)) return res.json({ success: false });
    
    const settings = await getGameSettings();
    const bonusConfig = settings?.streakBonuses?.find(b => b.day === dayNum);
    if (!bonusConfig) return res.json({ success: false });
    
    streak.claimedBonuses = streak.claimedBonuses || [];
    streak.claimedBonuses.push(dayNum);
    await streak.save();
    
    const user = await User.findByIdAndUpdate(userId, { $inc: { balance: bonusConfig.bonus, totalPointsEarned: bonusConfig.bonus } }, { new: true });
    
    await new Transaction({ userId, amount: bonusConfig.bonus, type: 'streak_bonus', description: `${dayNum}-day streak bonus` }).save();
    
    res.json({ success: true, bonus: bonusConfig.bonus, newBalance: user.balance });
  } catch (error) {
    res.json({ success: false });
  }
});

// Получить достижения
app.get('/api/users/:id/achievements', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.json([]);
    
    const configs = await AchievementConfig.find({ isActive: true });
    
    if (!user.achievements) user.achievements = [];
    
    const achievements = await Promise.all(configs.map(async (config) => {
      const userAch = user.achievements.find(a => a.code === config.code);
      
      // Определяем текущее значение прогресса по типу условия
      let currentValue = 0;
      if (config.condition?.type) {
        switch (config.condition.type) {
          case 'parkings_given':
          case 'parkings_given_night':
          case 'parkings_given_morning':
            currentValue = user.parkingsGiven || 0;
            break;
          case 'parkings_received':
            currentValue = user.parkingsReceived || 0;
            break;
          case 'streak':
            currentValue = user.currentStreak || 0;
            break;
          case 'rating':
            currentValue = user.ratingCount || 0;
            break;
          case 'helped_newbies':
            currentValue = user.helpedNewbies || 0;
            break;
          case 'referrals':
            currentValue = user.referralCount || 0;
            break;
        }
      }
      
      // Автоматическое разблокирование если условие выполнено
      let unlocked = !!userAch;
      let unlockedAt = userAch?.unlockedAt;
      
      if (!unlocked && currentValue >= config.condition?.value) {
        // Атомарно проверяем что достижение ещё не разблокировано и добавляем
        const atomicResult = await User.findOneAndUpdate(
          { _id: user._id, 'achievements.code': { $ne: config.code } },
          { 
            $push: { achievements: { code: config.code, unlockedAt: new Date() } },
            $inc: { balance: config.reward, totalPointsEarned: config.reward }
          },
          { new: true }
        );
        
        if (atomicResult) {
          unlocked = true;
          unlockedAt = new Date();
          
          new Transaction({
            userId: user._id, type: 'achievement', amount: config.reward,
            description: `Achievement: ${config.code}`
          }).save().catch(e => console.log('Transaction error:', e));
          
          console.log(`🏆 Achievement unlocked: ${config.code} for user ${user._id}, reward: ${config.reward}`);
        } else {
          // Уже разблокировано другим запросом
          unlocked = true;
        }
      }
      
      return {
        code: config.code,
        icon: config.icon,
        name: config.name,
        description: config.description,
        condition: config.condition,
        reward: config.reward,
        unlocked,
        unlockedAt,
        currentValue
      };
    }));
    
    // needsSave больше не нужен — всё сохраняется атомарно
    
    res.json(achievements);
  } catch (error) {
    console.log('Achievements error:', error);
    res.json([]);
  }
});

// Сбросить достижения пользователя (для исправления дубликатов)
app.post('/api/admin/reset-user-achievements/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.json({ success: false, message: 'User not found' });
    
    // Сбрасываем достижения
    user.achievements = [];
    await user.save();
    
    console.log(`✅ Achievements reset for user ${req.params.userId}`);
    res.json({ success: true, message: 'User achievements reset' });
  } catch (error) {
    console.log('Reset user achievements error:', error);
    res.json({ success: false });
  }
});

// Пересоздать конфиг заданий (для исправления)
app.post('/api/admin/reset-tasks', async (req, res) => {
  try {
    await DailyTaskConfig.deleteMany({});
    await UserDailyProgress.deleteMany({});
    
    await DailyTaskConfig.insertMany([
      { code: 'give_parking', icon: '🅿️', name: { en: 'Share a spot', ru: 'Отдай парковку', uk: 'Віддай парковку', es: 'Cede un lugar' }, type: 'give_parking', targetValue: 1, reward: 10 },
      { code: 'receive_parking', icon: '🚗', name: { en: 'Get a spot', ru: 'Получи парковку', uk: 'Отримай парковку', es: 'Obtén un lugar' }, type: 'receive_parking', targetValue: 1, reward: 5 },
      { code: 'daily_login', icon: '👋', name: { en: 'Daily check-in', ru: 'Ежедневный вход', uk: 'Щоденний вхід', es: 'Inicio diario' }, type: 'login', targetValue: 1, reward: 5 }
    ]);
    
    console.log('✅ Tasks reset');
    res.json({ success: true, message: 'Tasks reset' });
  } catch (error) {
    console.log('Reset tasks error:', error);
    res.json({ success: false });
  }
});

// Пересоздать конфиг достижений (для исправления)
app.post('/api/admin/reset-achievements', async (req, res) => {
  try {
    await AchievementConfig.deleteMany({});
    
    await AchievementConfig.insertMany([
      { code: 'first_share', icon: '🎉', name: { en: 'First Share', ru: 'Первая отдача', uk: 'Перша віддача', es: 'Primera cesión' }, description: { en: 'Share your first spot', ru: 'Отдай первую парковку', uk: 'Віддай першу парковку', es: 'Cede tu primer lugar' }, condition: { type: 'parkings_given', value: 1 }, reward: 20 },
      { code: 'helper_10', icon: '🤝', name: { en: 'Helper', ru: 'Помощник', uk: 'Помічник', es: 'Ayudante' }, description: { en: 'Share 10 spots', ru: 'Отдай 10 парковок', uk: 'Віддай 10 парковок', es: 'Cede 10 lugares' }, condition: { type: 'parkings_given', value: 10 }, reward: 50 },
      { code: 'streak_7', icon: '🔥', name: { en: 'On Fire', ru: 'В ударе', uk: 'У ударі', es: 'En racha' }, description: { en: '7-day streak', ru: 'Серия 7 дней', uk: 'Серія 7 днів', es: 'Racha de 7 días' }, condition: { type: 'streak', value: 7 }, reward: 50 },
      { code: 'vip', icon: '👑', name: { en: 'VIP', ru: 'VIP', uk: 'VIP', es: 'VIP' }, description: { en: '50+ spots shared', ru: '50+ парковок отдано', uk: '50+ парковок віддано', es: '50+ lugares cedidos' }, condition: { type: 'parkings_given', value: 50 }, reward: 100 }
    ]);
    
    console.log('✅ Achievements reset');
    res.json({ success: true, message: 'Achievements reset' });
  } catch (error) {
    console.log('Reset achievements error:', error);
    res.json({ success: false });
  }
});

// Seed начальных данных геймификации
const seedGameData = async () => {
  try {
    // Уровни
    const settingsCount = await GameSettings.countDocuments();
    if (settingsCount === 0) {
      await new GameSettings({
        levels: [
          { level: 1, name: { en: 'Newbie', ru: 'Новичок', uk: 'Новачок', es: 'Novato' }, icon: '🚗', minPoints: 0, minParkingsGiven: 0 },
          { level: 2, name: { en: 'Driver', ru: 'Водитель', uk: 'Водій', es: 'Conductor' }, icon: '🚙', minPoints: 100, minParkingsGiven: 5 },
          { level: 3, name: { en: 'Expert', ru: 'Эксперт', uk: 'Експерт', es: 'Experto' }, icon: '🏎️', minPoints: 500, minParkingsGiven: 25 },
          { level: 4, name: { en: 'Legend', ru: 'Легенда', uk: 'Легенда', es: 'Leyenda' }, icon: '👑', minPoints: 2000, minParkingsGiven: 100 }
        ],
        streakBonuses: [
          { day: 1, bonus: 5 },
          { day: 3, bonus: 10 },
          { day: 7, bonus: 25 },
          { day: 14, bonus: 50 },
          { day: 30, bonus: 100 }
        ],
        allDailyTasksBonus: 25
      }).save();
      console.log('✅ Game settings created');
    }
    
    // Задания
    const taskCount = await DailyTaskConfig.countDocuments();
    if (taskCount === 0) {
      await DailyTaskConfig.insertMany([
        { code: 'give_parking', icon: '🅿️', name: { en: 'Share a spot', ru: 'Отдай парковку', uk: 'Віддай парковку', es: 'Cede un lugar' }, type: 'give_parking', targetValue: 1, reward: 10 },
        { code: 'receive_parking', icon: '🚗', name: { en: 'Get a spot', ru: 'Получи парковку', uk: 'Отримай парковку', es: 'Obtén un lugar' }, type: 'receive_parking', targetValue: 1, reward: 5 },
        { code: 'daily_login', icon: '👋', name: { en: 'Daily check-in', ru: 'Ежедневный вход', uk: 'Щоденний вхід', es: 'Inicio diario' }, type: 'login', targetValue: 1, reward: 5 }
      ]);
      console.log('✅ Daily tasks created');
    }
    
    // Достижения
    const achCount = await AchievementConfig.countDocuments();
    if (achCount === 0) {
      await AchievementConfig.insertMany([
        { code: 'first_share', icon: '🎉', name: { en: 'First Share', ru: 'Первая отдача', uk: 'Перша віддача', es: 'Primera cesión' }, description: { en: 'Share your first spot', ru: 'Отдай первую парковку', uk: 'Віддай першу парковку', es: 'Cede tu primer lugar' }, condition: { type: 'parkings_given', value: 1 }, reward: 20 },
        { code: 'helper_10', icon: '🤝', name: { en: 'Helper', ru: 'Помощник', uk: 'Помічник', es: 'Ayudante' }, description: { en: 'Share 10 spots', ru: 'Отдай 10 парковок', uk: 'Віддай 10 парковок', es: 'Cede 10 lugares' }, condition: { type: 'parkings_given', value: 10 }, reward: 50 },
        { code: 'streak_7', icon: '🔥', name: { en: 'On Fire', ru: 'В ударе', uk: 'У ударі', es: 'En racha' }, description: { en: '7-day streak', ru: 'Серия 7 дней', uk: 'Серія 7 днів', es: 'Racha de 7 días' }, condition: { type: 'streak', value: 7 }, reward: 50 },
        { code: 'vip', icon: '👑', name: { en: 'VIP', ru: 'VIP', uk: 'VIP', es: 'VIP' }, description: { en: '50+ spots shared', ru: '50+ парковок отдано', uk: '50+ парковок віддано', es: '50+ lugares cedidos' }, condition: { type: 'parkings_given', value: 50 }, reward: 100 }
      ]);
      console.log('✅ Achievements created');
    }
  } catch (error) {
    console.log('Seed game data error:', error.message);
  }
};

// ==================== REFERRAL LANDING ====================

// Публичный endpoint — информация о реферере по коду (для лендинга)
app.get('/api/referral/:code', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const user = await User.findOne({ referralCode: code })
      .select('name avatarThumb rating ratingCount parkingsGiven parkingsReceived createdAt')
      .lean();
    
    if (!user) {
      return res.json({ success: false, message: 'Referral code not found' });
    }
    
    res.json({
      success: true,
      referrer: {
        name: user.name,
        avatar: user.avatarThumb || null,
        rating: user.rating || 5.0,
        ratingCount: user.ratingCount || 0,
        parkingsGiven: user.parkingsGiven || 0,
        parkingsReceived: user.parkingsReceived || 0,
        memberSince: user.createdAt,
      },
      bonuses: {
        newUser: 70,
        referrer: 20,
      },
      code,
    });
  } catch (error) {
    console.log('Referral lookup error:', error.message);
    res.json({ success: false, message: 'Server error' });
  }
});

// ==================== BOOKING RADIUS SETTINGS ====================

// Публичный endpoint — приложение получает текущий радиус
app.get('/api/settings/booking-radius', async (req, res) => {
  try {
    const settings = await getAppSettings();
    res.json({ success: true, bookingRadiusKm: settings.bookingRadiusKm || 5 });
  } catch (error) {
    res.json({ success: true, bookingRadiusKm: 5 });
  }
});

// Admin endpoint — изменить радиус (вне /api/admin/ чтобы не блокировался middleware)
app.put('/api/settings/booking-radius', async (req, res) => {
  try {
    const { bookingRadiusKm, adminId } = req.body;
    
    // Проверка админ-доступа
    if (adminId) {
      const admin = await User.findById(adminId).select('isAdmin').lean();
      if (!admin?.isAdmin) return res.status(403).json({ success: false, message: 'Admin access denied' });
    } else {
      const secret = req.headers['x-admin-secret'] || req.query.secret;
      if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
        return res.status(403).json({ success: false, message: 'Admin access denied' });
      }
    }
    
    const radius = Math.max(1, Math.min(50, Number(bookingRadiusKm) || 5));
    
    let settings = await AppSettings.findOne();
    if (!settings) {
      settings = new AppSettings({ bookingRadiusKm: radius });
    } else {
      settings.bookingRadiusKm = radius;
      settings.updatedAt = new Date();
    }
    await settings.save();
    
    // Сброс кэша
    cachedAppSettings = null;
    appSettingsCacheTime = 0;
    
    console.log(`📏 Booking radius updated to ${radius} km`);
    res.json({ success: true, bookingRadiusKm: radius });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== PUSH SCHEDULE SETTINGS ====================

app.get('/api/settings/push-schedule', async (req, res) => {
  try {
    let settings = await AppSettings.findOne().lean();
    if (!settings) settings = await new AppSettings({}).save();
    res.json({
      success: true,
      pushHour_morning: settings.pushHour_morning ?? 11,
      pushHour_evening: settings.pushHour_evening ?? 20
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/settings/push-schedule', async (req, res) => {
  try {
    const { pushHour_morning, pushHour_evening, adminId } = req.body;

    // Проверка админ-доступа
    if (adminId) {
      const admin = await User.findById(adminId).select('isAdmin').lean();
      if (!admin?.isAdmin) return res.status(403).json({ success: false, message: 'Admin access denied' });
    } else {
      const secret = req.headers['x-admin-secret'] || req.query.secret;
      if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
        return res.status(403).json({ success: false, message: 'Admin access denied' });
      }
    }

    const mh = Math.max(0, Math.min(23, Number(pushHour_morning)));
    const eh = Math.max(0, Math.min(23, Number(pushHour_evening)));
    if (mh === eh) return res.status(400).json({ success: false, message: 'Morning and evening hours must differ' });

    let settings = await AppSettings.findOne();
    if (!settings) settings = new AppSettings({});
    settings.pushHour_morning = mh;
    settings.pushHour_evening = eh;
    settings.updatedAt = new Date();
    await settings.save();

    cachedAppSettings = null;
    appSettingsCacheTime = 0;

    console.log(`⏰ Push schedule updated: morning=${mh}h, evening=${eh}h EST`);
    res.json({ success: true, pushHour_morning: mh, pushHour_evening: eh });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== NYC Tickets Check ====================

app.get('/api/tickets/check', async (req, res) => {
  try {
    const { plate, state } = req.query;
    if (!plate) return res.json({ success: false, message: 'Plate number is required' });

    const stateCode = (state || 'NY').toUpperCase();
    const plateClean = plate.toUpperCase().replace(/[^A-Z0-9]/g, '');

    // NYC Open Data SODA API - Open Parking and Camera Violations
    const url = `https://data.cityofnewyork.us/resource/nc67-uf89.json?$where=plate='${plateClean}' AND state='${stateCode}'&$order=issue_date DESC&$limit=500`;

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      return res.json({ success: false, message: `NYC API error: ${response.status}` });
    }

    const data = await response.json();

    const tickets = data.map(t => ({
      summons: t.summons_number || '',
      violation: t.violation || 'Unknown violation',
      status: parseFloat(t.amount_due || 0) > 0 ? 'open' : 'paid',
      issueDate: t.issue_date || null,
      county: t.county || '',
      fineAmount: parseFloat(t.fine_amount || 0),
      penaltyAmount: parseFloat(t.penalty_amount || 0),
      amountDue: parseFloat(t.amount_due || 0),
      paymentAmount: parseFloat(t.payment_amount || 0),
      reductionAmount: parseFloat(t.reduction_amount || 0),
    }));

    const openTickets = tickets.filter(t => t.status === 'open');
    const totalDue = openTickets.reduce((sum, t) => sum + t.amountDue, 0);

    res.json({
      success: true,
      plate: plateClean,
      state: stateCode,
      total: tickets.length,
      openCount: openTickets.length,
      totalDue: Math.round(totalDue * 100) / 100,
      tickets
    });

  } catch (e) {
    console.error('Tickets check error:', e.message);
    res.json({ success: false, message: 'Failed to check tickets. Try again later.' });
  }
});

// ==================== ASP (Alternate Side Parking) Routes ====================

// Получить статус ASP на сегодня
app.get('/api/asp/status', async (req, res) => {
  try {
    const today = new Date();
    const nyDate = new Date(today.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const dateStr = nyDate.toISOString().split('T')[0]; // "2026-02-22"
    const dayOfWeek = nyDate.getDay(); // 0=Sun, 6=Sat

    // Проверяем приостановку
    const suspension = await ASPSuspension.findOne({ date: dateStr });

    // Ищем следующую приостановку (для отображения)
    const nextSuspension = await ASPSuspension.findOne({ date: { $gt: dateStr } }).sort({ date: 1 });

    res.json({
      success: true,
      date: dateStr,
      dayOfWeek,
      suspended: !!suspension,
      reason: suspension ? suspension.reason : null,
      type: suspension ? suspension.type : null,
      nextSuspension: nextSuspension ? { date: nextSuspension.date, reason: nextSuspension.reason, type: nextSuspension.type } : null
    });
  } catch (error) {
    console.error('ASP status error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Получить ASP-зоны рядом с координатами
app.get('/api/asp/zones', async (req, res) => {
  try {
    const { lat, lng, radius, types } = req.query;
    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);
    const radiusMeters = Math.min(parseInt(radius) || 1000, 3000); // Макс 3км

    if (!latitude || !longitude) {
      return res.status(400).json({ success: false, message: 'lat and lng required' });
    }

    // Фильтр по типу зоны (опционально)
    const query = {
      geometry: {
        $nearSphere: {
          $geometry: { type: 'Point', coordinates: [longitude, latitude] },
          $maxDistance: radiusMeters
        }
      }
    };
    if (types) {
      const typeList = types.split(',').filter(t => ['asp', 'no_parking', 'no_standing', 'school', 'hydrant'].includes(t));
      if (typeList.length > 0) query.zoneType = { $in: typeList };
    }

    // Текущий день и время в NY
    const now = new Date();
    const nyNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const dateStr = nyNow.toISOString().split('T')[0];
    const dayOfWeek = nyNow.getDay();
    const currentTime = nyNow.getHours().toString().padStart(2, '0') + ':' + nyNow.getMinutes().toString().padStart(2, '0');

    // Проверяем приостановку
    const suspension = await ASPSuspension.findOne({ date: dateStr });
    const isSuspended = !!suspension;

    // Гео-запрос: зоны в радиусе
    const zones = await ASPZone.find(query).limit(2000).lean();

    // Штрафы по типу зоны
    const fines = { asp: 65, no_parking: 115, no_standing: 115, school: 115, hydrant: 115 };

    // Добавляем статус каждой зоне
    const zonesWithStatus = zones.map(zone => {
      let status = 'free'; // можно парковаться
      const zt = zone.zoneType || 'asp';

      if (zt === 'hydrant') {
        // Гидрант — запрет 24/7
        status = 'active';
      } else if (!isSuspended || zt !== 'asp') {
        // ASP зависит от suspension, остальные — нет
        const checkSuspension = zt === 'asp' && isSuspended;
        if (!checkSuspension) {
          for (const rule of zone.rules) {
            if (rule.days.includes(dayOfWeek)) {
              if (currentTime >= rule.startTime && currentTime < rule.endTime) {
                status = 'active';
              } else if (currentTime < rule.startTime) {
                const [rH, rM] = rule.startTime.split(':').map(Number);
                const [cH, cM] = currentTime.split(':').map(Number);
                const diffMin = (rH * 60 + rM) - (cH * 60 + cM);
                if (diffMin <= 60 && diffMin > 0) {
                  status = 'soon';
                }
              }
            }
          }
        }
      }

      return {
        _id: zone._id,
        geometry: zone.geometry,
        streetName: zone.streetName,
        side: zone.side,
        rules: zone.rules,
        zoneType: zt,
        fine: fines[zt] || 65,
        status: (zt === 'asp' && isSuspended) ? 'suspended' : status
      };
    });

    res.json({
      success: true,
      suspended: isSuspended,
      suspensionReason: suspension ? suspension.reason : null,
      count: zonesWithStatus.length,
      zones: zonesWithStatus
    });
  } catch (error) {
    console.error('ASP zones error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Получить правила ASP для конкретной зоны
app.get('/api/asp/zones/:id', async (req, res) => {
  try {
    const zone = await ASPZone.findById(req.params.id).lean();
    if (!zone) return res.status(404).json({ success: false, message: 'Zone not found' });
    res.json({ success: true, zone });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Админ: импорт ASP-зон (из подготовленного JSON)
app.post('/api/admin/asp/import-zones', async (req, res) => {
  try {
    const secret = req.headers['x-admin-secret'] || req.body?.secret;
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
      return res.status(403).json({ success: false, message: 'Admin access denied' });
    }

    const { zones } = req.body; // массив зон
    if (!zones || !Array.isArray(zones)) {
      return res.status(400).json({ success: false, message: 'zones array required' });
    }

    let imported = 0;
    let skipped = 0;

    for (const z of zones) {
      try {
        // Дедупликация по sourceId
        if (z.sourceId) {
          const existing = await ASPZone.findOne({ sourceId: z.sourceId });
          if (existing) { skipped++; continue; }
        }

        await ASPZone.create({
          geometry: z.geometry,
          streetName: z.streetName,
          borough: z.borough,
          side: z.side || 'both',
          zoneType: z.zoneType || 'asp',
          rules: z.rules,
          center: z.center,
          sourceId: z.sourceId
        });
        imported++;
      } catch (e) {
        skipped++;
      }
    }

    console.log(`🅿️ ASP import: ${imported} imported, ${skipped} skipped`);
    res.json({ success: true, imported, skipped });
  } catch (error) {
    console.error('ASP import error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Админ: добавить приостановки ASP
app.post('/api/admin/asp/suspensions', async (req, res) => {
  try {
    const secret = req.headers['x-admin-secret'] || req.body?.secret;
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
      return res.status(403).json({ success: false, message: 'Admin access denied' });
    }

    const { suspensions } = req.body;
    if (!suspensions || !Array.isArray(suspensions)) {
      return res.status(400).json({ success: false, message: 'suspensions array required' });
    }

    let added = 0;
    let skipped = 0;

    for (const s of suspensions) {
      try {
        await ASPSuspension.findOneAndUpdate(
          { date: s.date },
          { date: s.date, reason: s.reason, type: s.type || 'holiday' },
          { upsert: true }
        );
        added++;
      } catch (e) {
        skipped++;
      }
    }

    console.log(`📅 ASP suspensions: ${added} added, ${skipped} skipped`);
    res.json({ success: true, added, skipped });
  } catch (error) {
    console.error('ASP suspensions error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Админ: получить все приостановки
app.get('/api/admin/asp/suspensions', async (req, res) => {
  try {
    const suspensions = await ASPSuspension.find().sort({ date: 1 }).lean();
    res.json({ success: true, suspensions });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Админ: статистика ASP-зон
// Админ: очистка всех ASP-зон (для переимпорта)
app.delete('/api/admin/asp/clear-zones', async (req, res) => {
  try {
    const secret = req.headers['x-admin-secret'] || req.query?.secret;
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
      return res.status(403).json({ success: false, message: 'Admin access denied' });
    }
    const result = await ASPZone.deleteMany({});
    res.json({ success: true, message: `Deleted ${result.deletedCount} zones`, deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Админ: получить все ASP-зоны (для миграции)
app.get('/api/admin/asp/all-zones', async (req, res) => {
  try {
    const secret = req.headers['x-admin-secret'] || req.query?.secret;
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
      return res.status(403).json({ success: false, message: 'Admin access denied' });
    }
    const zones = await ASPZone.find({}).lean();
    res.json({ success: true, zones });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Админ: батч-обновление геометрий ASP-зон
app.post('/api/admin/asp/update-geometries', async (req, res) => {
  try {
    const secret = req.headers['x-admin-secret'] || req.query?.secret;
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
      return res.status(403).json({ success: false, message: 'Admin access denied' });
    }
    const { updates } = req.body;
    if (!updates || !Array.isArray(updates)) {
      return res.status(400).json({ success: false, message: 'updates array required' });
    }
    let updated = 0, errors = 0;
    for (const u of updates) {
      try {
        await ASPZone.updateOne(
          { _id: u.zoneId },
          { $set: { geometry: u.geometry, center: u.center } }
        );
        updated++;
      } catch (e) { errors++; }
    }
    res.json({ success: true, updated, errors });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Admin: batch update ASP zone rules (for fixing day parsing)
app.post('/api/admin/asp/fix-rules', async (req, res) => {
  try {
    const secret = req.headers['x-admin-secret'] || req.query?.secret;
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
      return res.status(403).json({ success: false, message: 'Admin access denied' });
    }
    const { updates } = req.body;
    if (!updates || !Array.isArray(updates)) {
      return res.status(400).json({ success: false, message: 'updates array required' });
    }
    let updated = 0, errors = 0;
    for (const u of updates) {
      try {
        await ASPZone.updateOne(
          { _id: u.zoneId },
          { $set: { rules: u.rules } }
        );
        updated++;
      } catch (e) { errors++; }
    }
    res.json({ success: true, updated, errors });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/admin/asp/stats', async (req, res) => {
  try {
    const totalZones = await ASPZone.countDocuments();
    const byBorough = await ASPZone.aggregate([
      { $group: { _id: '$borough', count: { $sum: 1 } } }
    ]);
    const byZoneType = await ASPZone.aggregate([
      { $group: { _id: '$zoneType', count: { $sum: 1 } } }
    ]);
    const totalSuspensions = await ASPSuspension.countDocuments();

    res.json({
      success: true,
      totalZones,
      byBorough: byBorough.reduce((acc, b) => { acc[b._id || 'unknown'] = b.count; return acc; }, {}),
      byZoneType: byZoneType.reduce((acc, b) => { acc[b._id || 'asp'] = b.count; return acc; }, {}),
      totalSuspensions
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== ADMIN: MOTIVATIONAL MESSAGES ====================

app.get('/api/admin/motivational-messages', async (req, res) => {
  try {
    const messages = await MotivationalMessage.find({}).sort({ createdAt: 1 }).lean();
    res.json({ success: true, messages });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/motivational-messages', async (req, res) => {
  try {
    const { id, title, body, enabled } = req.body;
    if (!id || !title?.en || !body?.en) {
      return res.status(400).json({ success: false, message: 'id, title.en and body.en are required' });
    }
    const exists = await MotivationalMessage.findOne({ id });
    if (exists) return res.status(400).json({ success: false, message: 'Message with this id already exists' });
    const msg = await MotivationalMessage.create({ id, title, body, enabled: enabled !== false });
    res.json({ success: true, message: msg });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/admin/motivational-messages/:id', async (req, res) => {
  try {
    const { title, body, enabled } = req.body;
    const msg = await MotivationalMessage.findByIdAndUpdate(
      req.params.id,
      { $set: { title, body, enabled } },
      { new: true }
    );
    if (!msg) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, message: msg });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/admin/motivational-messages/:id', async (req, res) => {
  try {
    const msg = await MotivationalMessage.findByIdAndDelete(req.params.id);
    if (!msg) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.patch('/api/admin/motivational-messages/:id/toggle', async (req, res) => {
  try {
    const msg = await MotivationalMessage.findById(req.params.id);
    if (!msg) return res.status(404).json({ success: false, message: 'Not found' });
    msg.enabled = !msg.enabled;
    await msg.save();
    res.json({ success: true, message: msg });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==================== START ====================

const server = httpServer.listen(PORT, () => {
  console.log(`🚗 ParkBro API running on port ${PORT}`);
  console.log('✅ Сервер готов (HTTP + WebSocket)');
  console.log(`🔌 Socket.IO ready`);
  seedMotivationalMessages();
});

// Graceful shutdown — корректное завершение при перезапуске Railway
const gracefulShutdown = async (signal) => {
  console.log(`\n⚠️ ${signal} received — shutting down gracefully...`);
  
  // Закрываем Socket.IO
  io.close(() => {
    console.log('🔒 Socket.IO closed');
  });
  
  // Перестаём принимать новые подключения
  server.close(() => {
    console.log('🔒 HTTP server closed');
  });
  
  // Закрываем MongoDB
  try {
    await mongoose.connection.close();
    console.log('🔒 MongoDB connection closed');
  } catch (err) {
    console.error('Error closing MongoDB:', err.message);
  }
  
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Ловим необработанные ошибки — логируем но не крашим
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ Unhandled Rejection:', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
  console.error('🔴 Uncaught Exception:', err.message, err.stack);
  // НЕ крашим сервер — логируем и продолжаем
});
