const express = require("express");
const router = express.Router();

const {
  getCloudModelSettings,
  updateCloudModelSettings,
  testCloudModelConnection,
  getCloudCaptionProgressHandler,
  rebuildCloudCaption,
} = require("../controllers/settingsController");

router.get("/cloud-model", getCloudModelSettings);
router.post("/cloud-model", updateCloudModelSettings);
router.post("/cloud-model/test", testCloudModelConnection);
router.get("/cloud-model/caption-progress", getCloudCaptionProgressHandler);
router.post("/cloud-model/rebuild-caption", rebuildCloudCaption);

module.exports = router;
