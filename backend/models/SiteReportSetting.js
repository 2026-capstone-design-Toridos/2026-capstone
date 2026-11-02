const mongoose = require('mongoose');

const SiteReportSettingSchema = new mongoose.Schema(
  {
    origin: { type: String, required: true, unique: true, index: true },
    weekly_email_enabled: { type: Boolean, default: false },
    weekly_email_recipients: { type: [String], default: [] },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
  },
);

module.exports = mongoose.model('SiteReportSetting', SiteReportSettingSchema);
