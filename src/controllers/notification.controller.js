const notificationService = require("../services/notification.service");

// GET /api/notifications?unreadOnly=true&limit=50
async function listNotifications(req, res, next) {
  try {
    const notifications = await notificationService.listNotifications(req.user.sub, {
      unreadOnly: req.query.unreadOnly,
      limit: req.query.limit,
    });
    const unreadCount = await notificationService.countUnread(req.user.sub);
    res.json({ notifications, unreadCount });
  } catch (err) {
    next(err);
  }
}

// GET /api/notifications/unread-count  — for the bell badge
async function countUnread(req, res, next) {
  try {
    const unreadCount = await notificationService.countUnread(req.user.sub);
    res.json({ unreadCount });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/notifications/:id/read
async function markAsRead(req, res, next) {
  try {
    const notification = await notificationService.markAsRead(req.user.sub, req.params.id);
    res.json({ notification });
  } catch (err) {
    next(err);
  }
}

// POST /api/notifications/read-all
async function markAllAsRead(req, res, next) {
  try {
    const result = await notificationService.markAllAsRead(req.user.sub);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listNotifications,
  countUnread,
  markAsRead,
  markAllAsRead,
};