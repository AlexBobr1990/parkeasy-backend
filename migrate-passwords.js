const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

mongoose.connect(process.env.MONGODB_URI || (console.error("Set MONGODB_URI"), process.exit(1)))
  .then(async () => {
    const users = await mongoose.connection.db.collection('users').find({}).toArray();
    
    for (const user of users) {
      if (user.password && !user.password.startsWith('$2b$')) {
        const hashed = await bcrypt.hash(user.password, 12);
        await mongoose.connection.db.collection('users').updateOne(
          { _id: user._id },
          { $set: { password: hashed } }
        );
        console.log('✅ Мигрирован:', user.email);
      }
    }
    
    console.log('\n🎉 Готово!');
    process.exit(0);
  });
