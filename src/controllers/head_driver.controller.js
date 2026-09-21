const headDriverService = require("../services/head_driver.service");

// GET /api/head-driver/trips/pending
async function listPendingApprovals(req, res, next) {
  try {
    const trips = await headDriverService.listPendingApprovals(req.user.sub);
    res.json({ trips });
  } catch (err) {
    next(err);
  }
}

// POST /api/head-driver/trips/:id/approve
async function approveTrip(req, res, next) {
  try {
    const trip = await headDriverService.approveTrip(req.params.id, req.user.sub);
    res.json({ trip });
  } catch (err) {
    next(err);
  }
}

// POST /api/head-driver/trips/:id/reject   body: { reason }
async function rejectTrip(req, res, next) {
  try {
    const { reason } = req.body;
    const trip = await headDriverService.rejectTrip(req.params.id, req.user.sub, reason);
    res.json({ trip });
  } catch (err) {
    next(err);
  }
}

// GET /api/head-driver/trips/declined
async function listDeclinedTrips(req, res, next) {
  try {
    const trips = await headDriverService.listDeclinedTrips();
    res.json({ trips });
  } catch (err) {
    next(err);
  }
}

// GET /api/head-driver/trips/:id/replacement-drivers
async function listReplacementDrivers(req, res, next) {
  try {
    const drivers = await headDriverService.listReplacementDrivers(req.params.id);
    res.json({ drivers });
  } catch (err) {
    next(err);
  }
}

// POST /api/head-driver/trips/:id/reassign   body: { driverId }
async function reassignDriver(req, res, next) {
  try {
    const { driverId } = req.body;
    const trip = await headDriverService.reassignDriver(
      req.params.id,
      driverId,
      req.user.sub
    );
    res.json({ trip });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listPendingApprovals,
  approveTrip,
  rejectTrip,
  listDeclinedTrips,
  listReplacementDrivers,
  reassignDriver,
};