const prisma = require("../config/prisma");
const storageService = require("../services/storage.service");

// Returns the FULL current user record from the database — not just the
// JWT payload (which only has sub/role/email), so the frontend can show
// fullName, phone, avatarUrl, etc.
async function getMe(req, res, next) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    const { password, ...safe } = user;
    res.json({ user: safe });
  } catch (err) {
    next(err);
  }
}

async function uploadAvatar(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "avatar file is required" });
    }

    const avatarUrl = await storageService.saveAvatar(req.file.buffer, req.file.originalname);

    const updated = await prisma.user.update({
      where: { id: req.user.sub },
      data: { avatarUrl },
    });

    const { password, ...safe } = updated;
    res.json({ user: safe });
  } catch (err) {
    next(err);
  }
}

module.exports = { getMe, uploadAvatar };