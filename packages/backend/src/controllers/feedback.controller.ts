import type { Request, Response } from 'express';
import { z } from 'zod';
import Feedback from '../model/feedback.model.js';
import { isDbReady } from '../db/mongodb.js';

/**
 * Feedback submission.
 *
 * The old version called `feedback.save()` unconditionally. With Mongo
 * unreachable, Mongoose buffered the write for the full
 * `serverSelectionTimeoutMS` and the request hung for ten seconds before
 * failing — which reads to a user exactly like "the site is broken".
 *
 * `bufferCommands` is now disabled and the database state is checked up front,
 * so an outage returns an honest 503 in milliseconds instead.
 */

const FeedbackSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.email().max(254),
  type: z.enum(['bug', 'feature', 'performance', 'network', 'other']).default('other'),
  message: z.string().trim().min(10).max(2000),
});

export type FeedbackInput = z.infer<typeof FeedbackSchema>;

export async function submitFeedback(req: Request, res: Response): Promise<Response> {
  if (!isDbReady()) {
    return res.status(503).json({
      ok: false,
      code: 'DB_UNAVAILABLE',
      message: 'Feedback is temporarily unavailable. Please try again shortly.',
    });
  }

  const parsed = FeedbackSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      code: 'VALIDATION',
      message: 'Please check the form.',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  // Idempotency: a double-tapped submit button should not create two rows.
  const idempotencyKey = req.get('Idempotency-Key');
  if (idempotencyKey) {
    const existing = await Feedback.findOne({ idempotencyKey })
      .lean()
      .catch(() => null);
    if (existing) {
      return res.status(200).json({ ok: true, message: 'Thanks! We already have that one.' });
    }
  }

  try {
    await Feedback.create({
      ...parsed.data,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    return res.status(201).json({
      ok: true,
      message: "Thanks! We've received your feedback.",
    });
  } catch (err) {
    // Never echo a raw driver error to the client; log it instead.
    console.error('[feedback] submission failed', err);
    return res.status(500).json({
      ok: false,
      code: 'INTERNAL',
      message: 'Something went wrong. Please try again later.',
    });
  }
}
