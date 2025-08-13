/*
 * @Author: zhangshouchang
 * @Date: 2025-08-04 12:06:10
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-04 22:07:45
 * @Description: File description
 */
const multer = require("multer");
const path = require("path");

//源文件目录
const uploadFolder = path.join(__dirname, "..", "..", process.env.UPLOADS_DIR);

// 文件保存设置
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, `${uploadFolder}/`); // 存放目录
    // "uploadedFiles/"
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext);
    const timestamp = Date.now();
    cb(null, `${base}-${timestamp}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith("image/")) {
    cb(null, true);
  } else {
    cb(new Error("Only image files are allowed"), false);
  }
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 20 * 1024 * 1024 } }); // 限制单张最大20MB

module.exports = upload;
