const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  oderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { 
    type: String, 
    enum: ['deposit', 'payment', 'earning', 'commission', 'bonus', 'cancellation', 'penalty'], 
    required: true 
  },
  amount: { type: Number, required: true },
  description: String,
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
  metadata: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Transaction', transactionSchema);
