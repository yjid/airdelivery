import mongoose from 'mongoose';

/**
 * Daily aggregate counters. One document per calendar day, keyed by the Date at
 * local midnight.
 *
 * Note the unit in the name: BYTES. The previous schema called this
 * `totalMBTransferred` while the client was sending bytes, which is how the
 * public stats ended up reporting impossible throughput.
 */
const statSchema = new mongoose.Schema(
  {
    /** Local midnight, used as the natural key for the daily rollup. */
    date: { type: Date, required: true, unique: true, index: true },
    totalFlights: { type: Number, default: 0, min: 0 },
    totalFilesShared: { type: Number, default: 0, min: 0 },
    totalBytesTransferred: { type: Number, default: 0, min: 0 },
    totalRelayedFlights: { type: Number, default: 0, min: 0 },
  },
  { versionKey: false, minimize: false },
);

export const Stat =
  mongoose.models.Stat ?? mongoose.model('Stat', statSchema);