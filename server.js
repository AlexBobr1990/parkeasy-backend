const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ===== ДЕМО-ДАННЫЕ =====
// Пользователи (вместо базы данных)
let users = [
  {
    id: '1',
    email: 'demo@test.com',
    password: '123456',
    name: 'Алексей',
    balance: 150,
    car: {
      brand: 'Toyota',
      model: 'Camry',
      color: 'Белый',
      plate: 'A123BC'
    }
  }
];

// Парковочные места
let parkings = [
  {
    id: '1',
    ownerId: '1',
    location: { lat: 40.7128, lng: -74.0060 },
    address: 'Манхэттен, 5th Avenue',
    price: 3,
    timeToLeave: 15,
    status: 'available',
    carSize: { length: 4.9, width: 1.84 }
  },
  {
    id: '2',
    ownerId: '1',
    location: { lat: 40.7580, lng: -73.9855 },
    address: 'Times Square, Broadway',
    price: 5,
    timeToLeave: 30,
    status: 'available',
    carSize: { length: 5.0, width: 1.9 }
  },
  {
    id: '3',
    ownerId: '1',
    location: { lat: 40.7484, lng: -73.9857 },
    address: 'Empire State Building',
    price: 4,
    timeToLeave: 10,
    status: 'available',
    carSize: { length: 4.5, width: 1.8 }
  }
];

// ===== API МАРШРУТЫ =====

// Проверка работы сервера
app.get('/', (req, res) => {
  res.json({ message: '🚗 ParkEasy API работает!' });
});

// Получить все парковки поблизости
app.get('/api/parkings/nearby', (req, res) => {
  const availableParkings = parkings.filter(p => p.status === 'available');
  res.json(availableParkings);
});

// Авторизация
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email === email && u.password === password);
  
  if (user) {
    res.json({ 
      success: true, 
      user: { 
        id: user.id, 
        email: user.email, 
        name: user.name,
        balance: user.balance,
        car: user.car
      } 
    });
  } else {
    res.status(401).json({ success: false, message: 'Неверный email или пароль' });
  }
});

// Регистрация
app.post('/api/auth/register', (req, res) => {
  const { email, password, name, car } = req.body;
  
  // Проверяем, есть ли уже такой email
  if (users.find(u => u.email === email)) {
    return res.status(400).json({ success: false, message: 'Email уже зарегистрирован' });
  }
  
  const newUser = {
    id: String(users.length + 1),
    email,
    password,
    name,
    balance: 50, // Стартовые 50 баллов!
    car
  };
  
  users.push(newUser);
  res.json({ 
    success: true, 
    message: 'Регистрация успешна! Вам начислено 50 баллов 🎉',
    user: { 
      id: newUser.id, 
      email: newUser.email, 
      name: newUser.name,
      balance: newUser.balance,
      car: newUser.car
    }
  });
});

// Создать парковку ("Я уезжаю")
app.post('/api/parkings/create', (req, res) => {
  const { ownerId, location, address, price, timeToLeave } = req.body;
  
  const newParking = {
    id: String(parkings.length + 1),
    ownerId,
    location,
    address,
    price,
    timeToLeave,
    status: 'available',
    createdAt: new Date()
  };
  
  parkings.push(newParking);
  
  const ownerEarnings = Math.floor(price * 0.75);
  res.json({ 
    success: true, 
    message: `Парковка создана! Вы получите ${ownerEarnings} баллов (75%)`,
    parking: newParking
  });
});

// Забронировать парковку
app.post('/api/parkings/book', (req, res) => {
  const { parkingId, userId } = req.body;
  
  const parking = parkings.find(p => p.id === parkingId);
  const user = users.find(u => u.id === userId);
  
  if (!parking) {
    return res.status(404).json({ success: false, message: 'Парковка не найдена' });
  }
  
  if (parking.status !== 'available') {
    return res.status(400).json({ success: false, message: 'Парковка уже занята' });
  }
  
  if (user.balance < parking.price) {
    return res.status(400).json({ success: false, message: 'Недостаточно баллов' });
  }
  
  // Списываем баллы
  user.balance -= parking.price;
  
  // Начисляем владельцу 75%
  const owner = users.find(u => u.id === parking.ownerId);
  if (owner) {
    owner.balance += Math.floor(parking.price * 0.75);
  }
  
  // Меняем статус парковки
  parking.status = 'booked';
  parking.bookedBy = userId;
  
  res.json({ 
    success: true, 
    message: `Парковка забронирована! Списано ${parking.price} баллов`,
    newBalance: user.balance,
    parking
  });
});

// Получить профиль пользователя
app.get('/api/users/:id', (req, res) => {
  const user = users.find(u => u.id === req.params.id);
  if (user) {
    res.json({ 
      id: user.id, 
      email: user.email, 
      name: user.name,
      balance: user.balance,
      car: user.car
    });
  } else {
    res.status(404).json({ message: 'Пользователь не найден' });
  }
});

// ===== ЗАПУСК СЕРВЕРА =====
const PORT = 3001;
app.listen(PORT, () => {
  console.log('');
  console.log('🚗 ================================');
  console.log('   ParkEasy API Server');
  console.log('   --------------------------------');
  console.log(`   Сервер запущен: http://localhost:${PORT}`);
  console.log('   --------------------------------');
  console.log('   Доступные маршруты:');
  console.log('   GET  /api/parkings/nearby');
  console.log('   POST /api/auth/login');
  console.log('   POST /api/auth/register');
  console.log('   POST /api/parkings/create');
  console.log('   POST /api/parkings/book');
  console.log('🚗 ================================');
  console.log('');
});
