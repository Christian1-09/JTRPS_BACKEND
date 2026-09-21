const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BASE_UPLOAD_DIR = path.join(__dirname, "../../uploads");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Local-disk implementation. If you move to Cloudinary/S3 later, this is the
// ONLY file that needs to change — every caller just awaits saveFile() and
// gets back a URL, with no idea where the file actually lives.
// [subfolder] groups files by purpose, e.g. "avatars", "authorization-letters", "signatures".
async function saveFile(fileBuffer, originalName, subfolder) {
  const dir = path.join(BASE_UPLOAD_DIR, subfolder);
  ensureDir(dir);

  const ext = path.extname(originalName) || ".jpg";
  const filename = `${crypto.randomUUID()}${ext}`;
  const filePath = path.join(dir, filename);

  fs.writeFileSync(filePath, fileBuffer);

  return `/uploads/${subfolder}/${filename}`;
}

// Kept for backwards compatibility with the existing avatar upload code.
async function saveAvatar(fileBuffer, originalName) {
  return saveFile(fileBuffer, originalName, "avatars");
}

module.exports = { saveFile, saveAvatar };