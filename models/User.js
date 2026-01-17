const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  balance: { type: Number, default: 50 },
  car: {
    brand: String,
    model: String,
    color: String,
    plate: String
  },
  avatar: { type: String, default: null },
  language: { type: String, enum: ['ru', 'en'], default: 'ru' },
  isAdmin: { type: Boolean, default: false },
  pushToken: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);
