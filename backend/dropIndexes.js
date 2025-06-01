const mongoose = require('mongoose');
mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    const User = mongoose.model('User');
    await User.collection.dropIndexes();
    console.log('Indexes dropped');
    process.exit(0);
  })
  .catch(err => console.error(err));