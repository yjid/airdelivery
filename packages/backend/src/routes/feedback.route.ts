import { Router } from 'express';
import { submitFeedback } from '../controllers/feedback.controller.js';

const feedbackRoute = Router();

feedbackRoute.post('/', submitFeedback);

export default feedbackRoute;
