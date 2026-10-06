const express = require("express");
const router = express.Router();
const notificationController = require("../controllers/notification.controller");
const authenticate = require("../middleware/auth");

// Every role has notifications, so only a login is required. Each user only
// ever sees their own.
router.use(authenticate);

// Fixed paths above any ":id" route.
router.get("/unread-count", notificationController.countUnread);
router.post("/read-all", notificationController.markAllAsRead);

router.get("/", notificationController.listNotifications);
router.patch("/:id/read", notificationController.markAsRead);

module.exports = router;