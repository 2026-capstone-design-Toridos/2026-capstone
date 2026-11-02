const mongoose = require('mongoose');

const WeeklyReportSchema = new mongoose.Schema(
  {
    origin: { type: String, required: true, index: true },
    week_start: { type: String, required: true },
    week_end: { type: String, required: true },
    timezone: { type: String, default: 'Asia/Seoul' },

    status: {
      type: String,
      enum: ['pending', 'generating', 'ready', 'failed'],
      default: 'pending',
      index: true,
    },
    html_path: { type: String, default: '' },
    pdf_path: { type: String, default: '' },
    generated_at: { type: Date },
    generation_attempts: { type: Number, default: 0 },
    generation_error: { type: String, default: '' },
    next_generation_attempt_at: { type: Date },
    generation_lease_until: { type: Date },

    email_status: {
      type: String,
      enum: ['disabled', 'pending', 'sending', 'sent', 'failed'],
      default: 'pending',
      index: true,
    },
    email_recipients: { type: [String], default: [] },
    email_attempts: { type: Number, default: 0 },
    email_error: { type: String, default: '' },
    emailed_at: { type: Date },
    next_email_attempt_at: { type: Date },
    email_lease_until: { type: Date },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
  },
);

WeeklyReportSchema.index({ origin: 1, week_start: 1 }, { unique: true });
WeeklyReportSchema.index({ status: 1, next_generation_attempt_at: 1 });
WeeklyReportSchema.index({ email_status: 1, next_email_attempt_at: 1 });

module.exports = mongoose.model('WeeklyReport', WeeklyReportSchema);
