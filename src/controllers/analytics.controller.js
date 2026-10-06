const analyticsService = require("../services/analytics.service");

// GET /api/admin/dashboard
async function getDashboard(req, res, next) {
  try {
    const dashboard = await analyticsService.getDashboard();
    res.json({ dashboard });
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/analytics?months=6
async function getAnalytics(req, res, next) {
  try {
    const analytics = await analyticsService.getAnalytics({ months: req.query.months });
    res.json({ analytics });
  } catch (err) {
    next(err);
  }
}

module.exports = { getDashboard, getAnalytics };