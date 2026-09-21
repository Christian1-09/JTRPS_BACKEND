const express = require("express");
const multer = require("multer");
const router = express.Router();
const userController = require("../controllers/user.controller");
const authenticate = require("../middleware/auth");

// Files are held in memory only long enough to hand off to storage.service —
// nothing touches disk except that one module.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed"));
    }
    cb(null, true);
  },
});

router.get("/me", authenticate, userController.getMe);
router.patch("/me/avatar", authenticate, upload.single("avatar"), userController.uploadAvatar);

module.exports = router;