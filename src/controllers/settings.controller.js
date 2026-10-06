const settingsService = require("../services/settings.service");

// GET /api/admin/settings
async function getSettings(req, res, next) {
  try {
    const settings = await settingsService.getSettings();
    res.json({ settings });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/admin/settings
// body: any of the notification toggles, approverName, approverTitle
async function updateSettings(req, res, next) {
  try {
    const settings = await settingsService.updateSettings(req.user.sub, req.body);
    res.json({ settings });
  } catch (err) {
    next(err);
  }
}

module.exports = { getSettings, updateSettings };