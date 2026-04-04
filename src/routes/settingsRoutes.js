const express = require("express");
const router = express.Router();

const {
  getCloudModelSettings,
  updateCloudModelSettings,
  testCloudModelConnection,
  getCloudSkippedCountHandler,
  rebuildCloudCaption,
  getAmapSettings,
  updateAmapSettings,
  testAmapConnection,
} = require("../controllers/settingsController");

router.get("/cloud-model", getCloudModelSettings);
router.post("/cloud-model", updateCloudModelSettings);
router.post("/cloud-model/test", testCloudModelConnection);
router.get("/cloud-model/skipped-count", getCloudSkippedCountHandler);
router.post("/cloud-model/rebuild-caption", rebuildCloudCaption);

router.get("/amap", getAmapSettings);
router.post("/amap", updateAmapSettings);
router.post("/amap/test", testAmapConnection);

module.exports = router;
