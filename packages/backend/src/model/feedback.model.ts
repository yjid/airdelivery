import mongoose from 'mongoose';

/**
 * Feedback submissions.
 *
 * `match` on the old email field was `/.+\@.+\..+/`, which accepts
 * `a@b.c` and is a mild ReDoS hazard on pathological input. Validation now
 * happens in the controller with `z.email()`, and the schema only enforces
 * shape. `type` is an enum because it was free text, so analytics grouped
 * nonsense like "asdf" as a category.
 */
const feedbackSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    type: {
      type: String,
      required: true,
      enum: ['bug', 'feature', 'performance', 'network', 'other'],
      default: 'other',
    },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    idempotencyKey: { type: String, sparse: true, index: true },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

// Retention: feedback is diagnostic data, not a mailing list.
feedbackSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });

export default mongoose.models.Feedback ?? mongoose.model('Feedback', feedbackSchema);
