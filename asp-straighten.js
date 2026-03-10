const mongoose = require('mongoose');
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://parkingapp:wmoU4mDhWsRb4VaQ@eazypark.xhy0jyi.mongodb.net/parkingapp?retryWrites=true&w=majority';

const aspZoneSchema = new mongoose.Schema({
  geometry: { type: { type: String }, coordinates: [[Number]] },
  streetName: String, side: String, zoneType: String, rules: [mongoose.Schema.Types.Mixed],
  center: { lat: Number, lng: Number }, sourceId: String,
  fromStreet: String, toStreet: String, borough: String
});
aspZoneSchema.index({ geometry: '2dsphere' });
const ASPZone = mongoose.model('ASPZone', aspZoneSchema);

async function main() {
  await mongoose.connect(MONGODB_URI);
  const zones = await ASPZone.find({}).lean();
  console.log('Total zones:', zones.length);
  let fixed = 0;
  let skipped = 0;
  for (const z of zones) {
    const coords = z.geometry && z.geometry.coordinates;
    if (!coords || coords.length < 2) { skipped++; continue; }
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) { skipped++; continue; }
    if (coords.length === 2) { skipped++; continue; } // already straight
    await ASPZone.updateOne({ _id: z._id }, { $set: { 'geometry.coordinates': [first, last] } });
    fixed++;
    if (fixed % 5000 === 0) console.log('  Progress:', fixed);
  }
  console.log('Straightened:', fixed);
  console.log('Skipped (already OK):', skipped);
  await mongoose.disconnect();
  console.log('Done');
}
main().catch(console.error);
