const prisma = require("../config/prisma");

const MAX_PAGE_SIZE = 100;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Newest first. Optional ?unreadOnly=true and ?limit=.
async function listNotifications(userId, { unreadOnly, limit } = {}) {
  const take = Math.min(Number(limit) || 50, MAX_PAGE_SIZE);

  return prisma.notification.findMany({
    where: {
      userId,
      ...(unreadOnly === "true" || unreadOnly === true ? { isRead: false } : {}),
    },
    orderBy: { createdAt: "desc" },
    take,
  });
}

// Drives the badge on the bell icon.
async function countUnread(userId) {
  return prisma.notification.count({ where: { userId, isRead: false } });
}

async function markAsRead(userId, notificationId) {
  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
  });

  // Same 404 whether it does not exist or belongs to someone else, so one
  // user cannot probe for another user's notification ids.
  if (!notification || notification.userId !== userId) {
    throw httpError(404, "Notification not found");
  }

  return prisma.notification.update({
    where: { id: notificationId },
    data: { isRead: true },
  });
}

async function markAllAsRead(userId) {
  const result = await prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true },
  });
  return { updated: result.count };
}

module.exports = {
  listNotifications,
  countUnread,
  markAsRead,
  markAllAsRead,
};